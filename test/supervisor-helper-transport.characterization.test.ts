import assert from "node:assert/strict";
import {it, type TestContext} from "vitest";
import {after} from "./support/node-test.js";
import {readFile, readdir, mkdtemp, rm} from "node:fs/promises";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GuidanceStore} from "../src/guidance-store.js";
import {ProjectSupervisorStore, defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {SupervisorTeamStore} from "../src/supervisor-team-store.js";
import {helperDeliveryBody} from "../src/supervisor-helper-transport.js";
import {helperTransportUnit} from "./support/team-units.js";
import type {Projection} from "../src/types.js";
import {withDeadline} from "./support/c1-loopback.js";

const webhookPath = "/api/hooks/fixture/fixture-only-token";

// the baseline suite's transport fixture: a registered helper, a fake native scheduler and a reopenable database
const fixture = async (t: TestContext, baseUrl = "http://127.0.0.1:3773") => {
  const directory = await mkdtemp(join(tmpdir(), "c1-helper-transport-"));
  const opened: GuidanceStore[] = [];
  const db = new GuidanceStore(directory);opened.push(db);
  const store = new ProjectSupervisorStore(db, new Set());
  db.db.prepare("INSERT INTO meta VALUES(?,?)").run('supervisor_control:"p"', JSON.stringify({enabled: true, manual: true, generation: 1}));
  const binding = {...store.reserve("p", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const};store.setBinding(binding);
  const team = new SupervisorTeamStore(store);
  team.registerMember(binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "boot"});
  const helper: Projection = {thread: {id: "helper", projectId: "p", title: "helper", modelSelection: defaultSupervisorModel,
    runtimeMode: "full-access", interactionMode: "default", lineage: {parentThreadId: binding.threadId, relationshipToParent: "subagent"}},
  runs: [], messages: [], runtimeRequests: []};
  const tasks: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const rpc = async (tag: string, input: Record<string, unknown>) => {
    calls.push(tag);
    if (tag === "scheduledTasks.list") return {tasks};
    if (tag === "scheduledTasks.upsert") {
      const task = {...input, createdAt: "2026-10-16T10:00:00Z", webhook: {path: webhookPath, url: `${baseUrl}${webhookPath}`}};
      tasks.splice(0, tasks.length, task);return {task};
    }
    if (tag === "scheduledTasks.listWebhookDeliveries") return {deliveries: []};
    throw new Error("unexpected_rpc");
  };
  const options = {store, rpc, baseUrl, projection: async () => helper};
  after(t, async () => {
    for (const guidance of opened) try {guidance.close();} catch { /* already closed */ }
    await rm(directory, {recursive: true, force: true});
  });
  const receipt = (guidance: GuidanceStore, messageId: string) => {
    const row = guidance.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
      .get(binding.threadId, binding.generation, messageId);
    return row ? JSON.parse(String(row.document)) as Record<string, unknown> : null;
  };
  return {directory, db, store, binding, helper, tasks, calls, options, receipt,
    reopen: () => {
      const reopened = new GuidanceStore(directory);opened.push(reopened);
      const reopenedStore = new ProjectSupervisorStore(reopened, new Set());
      new SupervisorTeamStore(reopenedStore);
      return {guidance: reopened, store: reopenedStore};
    }};
};

const message = (name: string) => ({threadId: "helper", commandId: `${name}-command`, messageId: `${name}-message`, text: `Durable check-in text for ${name}`});

it("CT-HTX-01: aborting the POST leaves the receipt 'posting' with its exact text; reconcile and send stay 'uncertain' without a second POST, also after reopen", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const posts: string[] = [];
  const reached = Promise.withResolvers<void>();
  after(t, () => reached.resolve());
  const abortingFetch: typeof fetch = async (_url, init) => {
    posts.push(String(init?.body));
    reached.resolve();
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {reject(signal.reason);return;}
      signal?.addEventListener("abort", () => reject(signal.reason), {once: true});
    });
  };
  const input = message("aborted");
  const transport = helperTransportUnit({...f.options, fetch: abortingFetch});
  const controller = new AbortController();
  const sending = transport.send(f.binding, input, controller.signal);
  await withDeadline(reached.promise, 3_000, "POST");
  const posting = f.receipt(f.db, input.messageId);
  assert.equal(posting?.state, "posting");
  controller.abort();
  assert.equal(await withDeadline(sending, 3_000, "aborted send"), "uncertain");
  assert.deepEqual(f.receipt(f.db, input.messageId), posting);
  assert.equal(posting?.text, input.text);
  assert.deepEqual(posts, [helperDeliveryBody(input.messageId, input.text)]);

  const signal = AbortSignal.timeout(3_000);
  assert.equal(await transport.reconcileDelivery(f.binding, input, signal), "uncertain");
  assert.equal(await transport.send(f.binding, input, signal), "uncertain");
  const reopened = f.reopen();
  const restarted = helperTransportUnit({...f.options, store: reopened.store, fetch: abortingFetch});
  assert.equal(await restarted.reconcileDelivery(f.binding, input, signal), "uncertain");
  assert.equal(await restarted.send(f.binding, input, signal), "uncertain");
  assert.equal(posts.length, 1);
  assert.deepEqual(f.receipt(reopened.guidance, input.messageId), posting);
});

type Seen = {method: string; path: string; body: string; origin: string};

const loopback = async (t: TestContext, seen: Seen[], handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({method: request.method ?? "", path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8"), origin: `http://127.0.0.1:${port}`});
      handler(request, response);
    });
  });
  await new Promise<void>((resolve, reject) => {server.once("error", reject);server.listen(0, "127.0.0.1", resolve);});
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  after(t, async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${port}`;
};

const accepted = (response: ServerResponse) => response.writeHead(202, {"content-type": "application/json"}).end(JSON.stringify({deliveryId: "delivery-1"}));

it("CT-HTX-03: global fetch issues one POST for 2xx, 4xx and 5xx replies, with no client retry", {timeout: 10_000}, async t => {
  for (const [status, outcome, state] of [[202, "waiting", "posted"], [400, "rejected", "rejected"], [503, "uncertain", "posting"]] as const) {
    const seen: Seen[] = [];
    const baseUrl = await loopback(t, seen, (_request, response) => status === 202 ? accepted(response) : response.writeHead(status).end());
    const f = await fixture(t, baseUrl);
    const input = message(`status-${status}`);
    // the real global fetch, with each response kept so a body the transport leaves unread is released afterwards
    const responses: Response[] = [];
    const transport = helperTransportUnit({...f.options, fetch: async (url, init) => {
      const response = await fetch(url, init);
      responses.push(response);
      return response;
    }});
    assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(3_000)), outcome, String(status));
    assert.deepEqual(responses.map(response => [response.status, response.bodyUsed]), [[status, status === 202]], String(status));
    // the transport now ends an unread reply's request itself, which errors its body with an AbortError; only that is tolerated
    for (const response of responses) if (!response.bodyUsed) await response.body?.cancel().catch((error: unknown) => {if (!(error instanceof Error && error.name === "AbortError")) throw error;});
    assert.equal(f.receipt(f.db, input.messageId)?.state, state, String(status));
    // a later send of the same identity only reconciles it
    await transport.send(f.binding, input, AbortSignal.timeout(3_000));
    assert.deepEqual(seen.map(request => [request.method, request.path, request.body]), [["POST", webhookPath, helperDeliveryBody(input.messageId, input.text)]], String(status));
  }
});

it("CT-HTX-03: a 2xx whose body read fails is still recorded as posted after one POST", {timeout: 10_000}, async t => {
  const seen: Seen[] = [];
  const baseUrl = await loopback(t, seen, (_request, response) => {
    // the status line, headers and part of the declared body reach the client before the connection ends
    response.writeHead(202, {"content-type": "application/json", "content-length": "64"});
    response.write("{\"deliveryId\":", () => response.socket?.destroy());
  });
  const f = await fixture(t, baseUrl);
  const input = message("cut-body");
  assert.equal(await helperTransportUnit(f.options).send(f.binding, input, AbortSignal.timeout(3_000)), "uncertain");
  const receipt = f.receipt(f.db, input.messageId);
  assert.equal(receipt?.state, "posted");
  assert.equal(receipt?.nativeDeliveryId, undefined);
  assert.equal(seen.length, 1);
});

it("CT-HTX-03: fetch follows redirects: 307 re-POSTs the body to Location, also on another origin, and 303 turns into a GET", {timeout: 10_000}, async t => {
  const otherSeen: Seen[] = [];
  const other = await loopback(t, otherSeen, (_request, response) => accepted(response));
  for (const [status, location, expected] of [
    [307, "/redirected", "same"],
    [307, `${other}/elsewhere`, "other"],
    [303, "/redirected", "get"],
  ] as const) {
    otherSeen.length = 0;
    const seen: Seen[] = [];
    const baseUrl = await loopback(t, seen, (request, response) => request.url === webhookPath
      ? response.writeHead(status, {location}).end()
      : accepted(response));
    const f = await fixture(t, baseUrl);
    const input = message(`redirect-${status}-${expected}`);
    const body = helperDeliveryBody(input.messageId, input.text);
    assert.equal(await helperTransportUnit(f.options).send(f.binding, input, AbortSignal.timeout(3_000)), "waiting", expected);
    const followed = [...seen, ...otherSeen].map(request => [request.origin === baseUrl ? "base" : "other", request.method, request.path, request.body]);
    if (expected === "same") assert.deepEqual(followed, [["base", "POST", webhookPath, body], ["base", "POST", "/redirected", body]]);
    if (expected === "other") assert.deepEqual(followed, [["base", "POST", webhookPath, body], ["other", "POST", "/elsewhere", body]]);
    if (expected === "get") assert.deepEqual(followed, [["base", "POST", webhookPath, body], ["base", "GET", "/redirected", ""]]);
    assert.equal(f.receipt(f.db, input.messageId)?.state, "posted");
  }
});

it("CT-HTX-04: the webhook path and token never reach the channel or delivery documents nor the database files", {timeout: 10_000}, async t => {
  const seen: Seen[] = [];
  const baseUrl = await loopback(t, seen, (_request, response) => accepted(response));
  const f = await fixture(t, baseUrl);
  const transport = helperTransportUnit(f.options);
  for (const name of ["first", "second"]) assert.equal(await transport.send(f.binding, message(name), AbortSignal.timeout(3_000)), "waiting");
  assert.equal(await transport.reconcileDelivery(f.binding, message("first"), AbortSignal.timeout(3_000)), "uncertain");
  assert.equal(seen.length, 2);
  const documents = [
    ...f.db.db.prepare("SELECT document FROM supervisor_helper_channels").all(),
    ...f.db.db.prepare("SELECT document FROM supervisor_helper_deliveries").all(),
  ].map(row => String(row.document));
  assert.equal(documents.length, 3);
  for (const document of documents) {
    assert.equal(document.includes("fixture-only-token"), false, document);
    assert.equal(document.includes("/api/hooks"), false, document);
  }
  f.db.close();
  for (const name of await readdir(f.directory)) {
    const bytes = await readFile(join(f.directory, name));
    assert.equal(bytes.includes("fixture-only-token"), false, name);
  }
});
