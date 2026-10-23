import assert from "node:assert/strict";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {it} from "@effect/vitest";
import {Deferred, Effect, Fiber, FileSystem} from "effect";
import {defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {helperDeliveryBody} from "../src/supervisor-helper-transport.js";
import type {Projection} from "../src/types.js";
import {rows} from "./support/guidance-store-services.js";
import {execute, helperTransportUnit, reopenTeamStores, rpcUncertain, teamStoresFixture, type RpcHandler, type TeamStores} from "./support/g3-team.js";

// the transport characterizations on the production HelperTransport layer over the store services of a temporary guidance
// database. CT-HTX-01 runs under the test clock over a stubbed fetch; CT-HTX-03 and CT-HTX-04 are live, because their peer is a
// real loopback HTTP server reached through the platform fetch

const webhookPath = "/api/hooks/fixture/fixture-only-token";

// the baseline suite's transport fixture: a registered helper, a fake native scheduler and a reopenable database
const fixture = (baseUrl = "http://127.0.0.1:3773") => Effect.gen(function* () {
  const stores = yield* teamStoresFixture("c1-helper-transport-");
  yield* execute(stores, "INSERT INTO meta VALUES(?,?)", 'supervisor_control:"p"', JSON.stringify({enabled: true, manual: true, generation: 1}));
  const binding = {...yield* stores.store.reserve("p", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const};yield* stores.store.setBinding(binding);
  yield* stores.teamStore.registerMember(binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "boot"});
  const helper: Projection = {thread: {id: "helper", projectId: "p", title: "helper", modelSelection: defaultSupervisorModel,
    runtimeMode: "full-access", interactionMode: "default", lineage: {parentThreadId: binding.threadId, relationshipToParent: "subagent"}},
  runs: [], messages: [], runtimeRequests: []};
  const tasks: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const rpc: RpcHandler = (tag, input) => {
    calls.push(tag);
    if (tag === "scheduledTasks.list") return Effect.succeed({tasks});
    if (tag === "scheduledTasks.upsert") {
      const task = {...input, createdAt: "2026-10-16T10:00:00Z", webhook: {path: webhookPath, url: `${baseUrl}${webhookPath}`}};
      tasks.splice(0, tasks.length, task);return Effect.succeed({task});
    }
    if (tag === "scheduledTasks.listWebhookDeliveries") return Effect.succeed({deliveries: []});
    return Effect.fail(rpcUncertain());
  };
  const options = {stores, rpc, baseUrl, projection: () => Effect.succeed(helper)};
  const receipt = (guidance: TeamStores, messageId: string) => Effect.map(
    rows(guidance.sql, "SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?",
      binding.threadId, binding.generation, messageId),
    ([row]) => row ? JSON.parse(String(row.document)) as Record<string, unknown> : null);
  return {directory: stores.directory, db: stores, store: stores.store, binding, helper, tasks, calls, options, receipt,
    // the team store's layer runs its restart recovery on the reopened file
    reopen: reopenTeamStores(stores.directory)};
});

const message = (name: string) => ({threadId: "helper", commandId: `${name}-command`, messageId: `${name}-message`, text: `Durable check-in text for ${name}`});

it.effect("CT-HTX-01: aborting the POST leaves the receipt 'posting' with its exact text; reconcile and send stay 'uncertain' without a second POST, also after reopen", () => Effect.gen(function* () {
  const f = yield* fixture();
  const posts: string[] = [];
  const reached = yield* Deferred.make<void>();
  const abortingFetch: typeof fetch = async (_url, init) => {
    posts.push(String(init?.body));
    Deferred.doneUnsafe(reached, Effect.void);
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {reject(signal.reason);return;}
      signal?.addEventListener("abort", () => reject(signal.reason), {once: true});
    });
  };
  const input = message("aborted");
  const {transport} = yield* helperTransportUnit({...f.options, fetch: abortingFetch});
  const cancel = yield* Deferred.make<void>();
  const sending = yield* Effect.forkChild(transport.send(f.binding, input, {cancel}));
  yield* Deferred.await(reached);
  const posting = yield* f.receipt(f.db, input.messageId);
  assert.equal(posting?.state, "posting");
  yield* Deferred.succeed(cancel, undefined);
  assert.equal(yield* Fiber.join(sending), "uncertain");
  assert.deepEqual(yield* f.receipt(f.db, input.messageId), posting);
  assert.equal(posting?.text, input.text);
  assert.deepEqual(posts, [helperDeliveryBody(input.messageId, input.text)]);

  assert.equal(yield* transport.reconcileDelivery(f.binding, input), "uncertain");
  assert.equal(yield* transport.send(f.binding, input), "uncertain");
  const reopened = yield* f.reopen;
  const {transport: restarted} = yield* helperTransportUnit({...f.options, stores: reopened, fetch: abortingFetch});
  assert.equal(yield* restarted.reconcileDelivery(f.binding, input), "uncertain");
  assert.equal(yield* restarted.send(f.binding, input), "uncertain");
  assert.equal(posts.length, 1);
  assert.deepEqual(yield* f.receipt(reopened, input.messageId), posting);
}), {timeout: 10_000});

type Seen = {method: string; path: string; body: string; origin: string};

// a loopback HTTP peer, closed with the test scope
const loopback = (seen: Seen[], handler: (request: IncomingMessage, response: ServerResponse) => void) => Effect.acquireRelease(Effect.callback<{server: ReturnType<typeof createServer>; url: string}>((resume) => {
  let port = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({method: request.method ?? "", path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8"), origin: `http://127.0.0.1:${port}`});
      handler(request, response);
    });
  });
  server.once("error", (error) => resume(Effect.die(error)));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    port = address.port;
    resume(Effect.succeed({server, url: `http://127.0.0.1:${port}`}));
  });
}), ({server}) => Effect.callback<void>((resume) => {
  server.closeAllConnections();
  server.close(() => resume(Effect.void));
})).pipe(Effect.map(({url}) => url));

const accepted = (response: ServerResponse) => response.writeHead(202, {"content-type": "application/json"}).end(JSON.stringify({deliveryId: "delivery-1"}));

it.live("CT-HTX-03: global fetch issues one POST for 2xx, 4xx and 5xx replies, with no client retry", () => Effect.gen(function* () {
  for (const [status, outcome, state] of [[202, "waiting", "posted"], [400, "rejected", "rejected"], [503, "uncertain", "posting"]] as const) {
    const seen: Seen[] = [];
    const baseUrl = yield* loopback(seen, (_request, response) => status === 202 ? accepted(response) : response.writeHead(status).end());
    const f = yield* fixture(baseUrl);
    const input = message(`status-${status}`);
    // the real global fetch, with each response kept so a body the transport leaves unread is released afterwards
    const responses: Response[] = [];
    const {transport} = yield* helperTransportUnit({...f.options, fetch: async (url, init) => {
      const response = await fetch(url, init);
      responses.push(response);
      return response;
    }});
    assert.equal(yield* transport.send(f.binding, input), outcome, String(status));
    assert.deepEqual(responses.map(response => [response.status, response.bodyUsed]), [[status, status === 202]], String(status));
    // the transport now ends an unread reply's request itself, which errors its body with an AbortError; only that is tolerated
    for (const response of responses) if (!response.bodyUsed) yield* Effect.promise(async () => response.body?.cancel().catch((error: unknown) => {if (!(error instanceof Error && error.name === "AbortError")) throw error;}));
    assert.equal((yield* f.receipt(f.db, input.messageId))?.state, state, String(status));
    // a later send of the same identity only reconciles it
    yield* transport.send(f.binding, input);
    assert.deepEqual(seen.map(request => [request.method, request.path, request.body]), [["POST", webhookPath, helperDeliveryBody(input.messageId, input.text)]], String(status));
  }
}), {timeout: 10_000});

it.live("CT-HTX-03: a 2xx whose body read fails is still recorded as posted after one POST", () => Effect.gen(function* () {
  const seen: Seen[] = [];
  const baseUrl = yield* loopback(seen, (_request, response) => {
    // the status line, headers and part of the declared body reach the client before the connection ends
    response.writeHead(202, {"content-type": "application/json", "content-length": "64"});
    response.write("{\"deliveryId\":", () => response.socket?.destroy());
  });
  const f = yield* fixture(baseUrl);
  const input = message("cut-body");
  assert.equal(yield* (yield* helperTransportUnit(f.options)).transport.send(f.binding, input), "uncertain");
  const receipt = yield* f.receipt(f.db, input.messageId);
  assert.equal(receipt?.state, "posted");
  assert.equal(receipt?.nativeDeliveryId, undefined);
  assert.equal(seen.length, 1);
}), {timeout: 10_000});

it.live("CT-HTX-03: fetch follows redirects: 307 re-POSTs the body to Location, also on another origin, and 303 turns into a GET", () => Effect.gen(function* () {
  const otherSeen: Seen[] = [];
  const other = yield* loopback(otherSeen, (_request, response) => accepted(response));
  for (const [status, location, expected] of [
    [307, "/redirected", "same"],
    [307, `${other}/elsewhere`, "other"],
    [303, "/redirected", "get"],
  ] as const) {
    otherSeen.length = 0;
    const seen: Seen[] = [];
    const baseUrl = yield* loopback(seen, (request, response) => request.url === webhookPath
      ? response.writeHead(status, {location}).end()
      : accepted(response));
    const f = yield* fixture(baseUrl);
    const input = message(`redirect-${status}-${expected}`);
    const body = helperDeliveryBody(input.messageId, input.text);
    assert.equal(yield* (yield* helperTransportUnit(f.options)).transport.send(f.binding, input), "waiting", expected);
    const followed = [...seen, ...otherSeen].map(request => [request.origin === baseUrl ? "base" : "other", request.method, request.path, request.body]);
    if (expected === "same") assert.deepEqual(followed, [["base", "POST", webhookPath, body], ["base", "POST", "/redirected", body]]);
    if (expected === "other") assert.deepEqual(followed, [["base", "POST", webhookPath, body], ["other", "POST", "/elsewhere", body]]);
    if (expected === "get") assert.deepEqual(followed, [["base", "POST", webhookPath, body], ["base", "GET", "/redirected", ""]]);
    assert.equal((yield* f.receipt(f.db, input.messageId))?.state, "posted");
  }
}), {timeout: 10_000});

it.live("CT-HTX-04: the webhook path and token never reach the channel or delivery documents nor the database files", () => Effect.gen(function* () {
  const seen: Seen[] = [];
  const baseUrl = yield* loopback(seen, (_request, response) => accepted(response));
  const f = yield* fixture(baseUrl);
  const {transport} = yield* helperTransportUnit(f.options);
  for (const name of ["first", "second"]) assert.equal(yield* transport.send(f.binding, message(name)), "waiting");
  assert.equal(yield* transport.reconcileDelivery(f.binding, message("first")), "uncertain");
  assert.equal(seen.length, 2);
  const documents = [
    ...yield* rows(f.db.sql, "SELECT document FROM supervisor_helper_channels"),
    ...yield* rows(f.db.sql, "SELECT document FROM supervisor_helper_deliveries"),
  ].map(row => String(row.document));
  assert.equal(documents.length, 3);
  for (const document of documents) {
    assert.equal(document.includes("fixture-only-token"), false, document);
    assert.equal(document.includes("/api/hooks"), false, document);
  }
  yield* f.db.close;
  const fs = yield* FileSystem.FileSystem;
  for (const name of yield* fs.readDirectory(f.directory)) {
    const bytes = Buffer.from(yield* fs.readFile(join(f.directory, name)));
    assert.equal(bytes.includes("fixture-only-token"), false, name);
  }
}).pipe(Effect.provide(NodeFileSystem.layer)), {timeout: 10_000});
