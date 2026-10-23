import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect";
import { FetchHttpClient, HttpClient, type HttpClientResponse } from "effect/http";
import { defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { makeSupervisionGate, SupervisionGate, type GateGuard, type SupervisionGateShape } from "../src/supervision-gate.js";
import { helperDeliveryBody, HelperTransport, invalidReceipt, type SupervisorHelperMessage } from "../src/supervisor-helper-transport.js";
import { NativeOperateRpc, SupervisorRpcError, type NativeRpcShape } from "../src/supervisor-native.js";
import { T3Client, type T3ClientShape } from "../src/t3.js";
import { workflowRequestHash } from "../src/workflow-write-evidence.js";
import type { MessageInfo, Projection } from "../src/types.js";
import { execute, row as firstRow, supervisionStores, temporaryDirectory } from "./support/g11-stores.js";

// CT-LIN-05 on the real helper transport (plan 3.11): the webhook POST is the admitted send. Its final guard, its
// 'posting' receipt and the start of the POST happen in one admission section; the reply is awaited outside it. The
// peer is a loopback HTTP server that holds each reply until the case releases it; fetch is the platform fetch, wrapped
// only to log the synchronous start of each POST and the aborts of its signal. The transport is the production layer over
// the store services of a temporary guidance file; the scheduler and the projection reads are effect fakes. it.live: the
// webhook POSTs go to the loopback peer over real sockets

const webhookPath = "/api/hooks/fixture/admission-only-token";
const input: SupervisorHelperMessage = { threadId: "helper", commandId: "admission-command", messageId: "admission-message", text: "Check the assigned branch." };

type Peer = {
  readonly baseUrl: string;
  readonly posts: string[];
  readonly arrived: Deferred.Deferred<void>;
  readonly reply: Deferred.Deferred<void>;
  // a POST's request ended on the peer: its exchange closed, finished or not
  readonly ended: Deferred.Deferred<void>;
  // replies whose connection closed before the peer finished writing them
  readonly cut: number[];
};

// "held": a complete 202 with a delivery id once `reply` completes; a status: that status's headers and the first byte of
// a declared body at once, the rest never sent, so the request stays open until the client ends it

const peer = (mode: "held" | number) => Effect.acquireRelease(Effect.gen(function* () {
  const arrived = yield* Deferred.make<void>();
  const ended = yield* Deferred.make<void>();
  const cut: number[] = [];
  const reply = yield* Deferred.make<void>();
  const posts: string[] = [];
  const waiting = new Set<ServerResponse>();
  const answer = (response: ServerResponse) => {
    if (!waiting.delete(response) || response.destroyed) return;
    response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ deliveryId: `native-delivery-${posts.length}` }));
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      posts.push(Buffer.concat(chunks).toString("utf8"));
      const index = posts.length;
      response.once("close", () => {
        if (!response.writableFinished) cut.push(index);
        Deferred.doneUnsafe(ended, Effect.void);
      });
      Deferred.doneUnsafe(arrived, Effect.void);
      if (mode !== "held") {
        response.writeHead(mode, { "content-type": "application/json", "content-length": "64" });
        response.write("{");
        return;
      }
      waiting.add(response);
      if (Deferred.isDoneUnsafe(reply)) answer(response);
    });
  });
  yield* Effect.callback<void>((resume) => {server.listen(0, "127.0.0.1", () => resume(Effect.void));});
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  yield* Effect.forkScoped(Deferred.await(reply).pipe(Effect.andThen(Effect.sync(() => {for (const response of [...waiting]) answer(response);}))));
  return { server, peer: { baseUrl: `http://127.0.0.1:${address.port}`, posts, arrived, reply, ended, cut } satisfies Peer };
}), ({ server }) => Effect.callback<void>((resume) => {
  server.close(() => resume(Effect.void));
  server.closeAllConnections();
})).pipe(Effect.map(({ peer }) => peer));

// the operate client over the fake scheduler: a completed cancel ends a call as the aborted call it replaces, and an
// unexpected call is one that may have acted
const scheduler = (handle: (tag: string, payload: Record<string, unknown>) => Effect.Effect<unknown, SupervisorRpcError>): NativeRpcShape => {
  const call = (tag: string, payload: Readonly<Record<string, unknown>>) => Effect.suspend(() => handle(tag, {...payload}));
  return {
    call: (tag, payload, cancel) => cancel === undefined ? call(tag, payload)
      : Effect.raceFirst(call(tag, payload), Effect.andThen(Deferred.await(cancel), Effect.fail(new SupervisorRpcError("uncertain")))),
    initiate: (tag, payload) => Effect.map(Effect.exit(call(tag, payload)), (exit) => ({sent: Effect.succeed(true), result: exit, release: Effect.void})),
  };
};

const fixtureWith = (mode: "held" | number) => Effect.gen(function* () {
  // a request from outside the send, as the baseline's own root fiber: forked into the test scope over the test's services,
  // so it carries none of the transaction the guard that requests it runs in
  const testScope = yield* Effect.scope;
  const outside = yield* Effect.context<Scope.Scope>();
  const detached = <A, E>(effect: Effect.Effect<A, E>) => Effect.forkIn(Effect.updateContext(effect, (_: Context.Context<never>) => outside), testScope);
  const directory = yield* temporaryDirectory("helper-admission-");
  const stores = yield* supervisionStores(directory);
  const { sql, supervisors: store } = stores;
  yield* execute(sql, "INSERT INTO meta VALUES(?,?)", 'supervisor_control:"p"', JSON.stringify({ enabled: true, manual: true, generation: 1 }));
  const binding = { ...(yield* store.reserve("p", "main", "main", defaultSupervisorModel, 1, 1)), state: "ready" as const };yield* store.setBinding(binding);
  yield* stores.team.registerMember(binding, { threadId: "helper", taskId: "bootstrap", bootstrapRunId: "boot" });
  const helper: Projection = { thread: { id: "helper", projectId: "p", title: "helper", modelSelection: defaultSupervisorModel,
    runtimeMode: "full-access", interactionMode: "default", lineage: { parentThreadId: binding.threadId, relationshipToParent: "subagent" } },
  runs: [], messages: [], runtimeRequests: [] };
  const http = yield* peer(mode);
  const log: string[] = [];
  const rpcs: string[] = [];
  const tasks: Record<string, unknown>[] = [];
  const rpc = scheduler((tag, payload) => Effect.suspend((): Effect.Effect<unknown, SupervisorRpcError> => {
    rpcs.push(tag);
    if (tag === "scheduledTasks.list") return Effect.succeed({ tasks });
    if (tag === "scheduledTasks.upsert") {
      const task = { ...payload, createdAt: "2026-10-16T10:00:00Z", webhook: { path: webhookPath, url: null } };
      tasks.splice(0, tasks.length, task);return Effect.succeed({ task });
    }
    if (tag === "scheduledTasks.listWebhookDeliveries") return Effect.succeed({ deliveries: [] });
    return Effect.fail(new SupervisorRpcError("uncertain"));
  }));
  // the policy the guard reads; a Stop is a section that commits it and then its bookkeeping
  // stopped: the per-chat stop the scope predicate includes; revoked: the caller's own authority (a quarantine)
  const policy = { stopped: false, revoked: false };
  let guardReads = 0;
  let onGuard: ((read: number) => Effect.Effect<void>) | null = null;
  const guard: GateGuard = {
    scopeEnabled: () => Effect.suspend(() => {
      log.push("guard");
      const read = ++guardReads;
      return Effect.andThen(onGuard?.(read) ?? Effect.void, Effect.sync(() => !policy.stopped));
    }),
    supervisionStopped: () => Effect.sync(() => policy.stopped),
    workflowEditingEnabled: () => Effect.succeed(true),
  };
  const inner = yield* makeSupervisionGate(guard).pipe(Effect.provide(stores.context));
  // each section logs the end of its body while it still holds the permit
  let sections = 0;
  const gate: SupervisionGateShape = {
    admit: (body) => inner.admit((current) => Effect.ensuring(body(current), Effect.sync(() => {sections += 1;log.push("end");}))),
  };
  const stop = (change: (current: typeof policy) => void, barrier?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }) =>
    gate.admit(() => Effect.gen(function* () {
      if (barrier) yield* Deferred.succeed(barrier.entered, undefined);
      change(policy);
      log.push("policy-commit");
      if (barrier) yield* Deferred.await(barrier.release);
      log.push("bookkeeping");
    }));
  let aborts = 0;
  const fetch: typeof globalThis.fetch = (url, init) => {
    log.push("initiate");
    init?.signal?.addEventListener("abort", () => {aborts += 1;}, { once: true });
    return globalThis.fetch(url, init);
  };
  let projectionGate: Deferred.Deferred<void> | null = null;
  let projectionReads = 0;
  const projections: T3ClientShape = {
    descriptor: () => Effect.die(new Error("unused T3 descriptor")),
    watch: () => Effect.die(new Error("unused T3 watch")),
    projection: () => Effect.gen(function* () {
      projectionReads += 1;
      if (projectionGate) yield* Deferred.await(projectionGate);
      return { snapshotSequence: 0, projection: helper };
    }),
  };
  // a transport in its own scope, as the supervision run builds it; `wrap` stands between it and the fetch client
  const transport = (scope: Scope.Scope, wrap: (client: HttpClient.HttpClient) => HttpClient.HttpClient = (client) => client) => {
    const client = Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, wrap)).pipe(
      Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));
    return Layer.buildWithScope(HelperTransport.layer({ baseUrl: http.baseUrl }).pipe(Layer.provide(Layer.mergeAll(
      client, Layer.succeed(NativeOperateRpc, rpc), Layer.succeed(SupervisionGate, gate), Layer.succeed(T3Client, projections),
      Layer.succeedContext(stores.context)))), scope).pipe(Effect.orDie, Effect.map((context) => Context.get(context, HelperTransport)));
  };
  // the stored rows as bytes, and a row replaced by bytes this transport did not write
  const row = (table: "deliveries" | "channels") => Effect.map(table === "deliveries"
    ? firstRow(sql, "SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?",
      binding.threadId, binding.generation, input.messageId)
    : firstRow(sql, "SELECT document FROM supervisor_helper_channels WHERE owner_thread_id=? AND owner_generation=? AND helper_thread_id=?",
      binding.threadId, binding.generation, input.threadId), (found) => found ? String(found.document) : null);
  const receipt = Effect.map(row("deliveries"), (document) => document === null ? null : JSON.parse(document) as Record<string, unknown>);
  const overwrite = (table: "deliveries" | "channels") => (document: string) => table === "deliveries"
    ? execute(sql, "INSERT INTO supervisor_helper_deliveries VALUES(?,?,?,?) ON CONFLICT(owner_thread_id,owner_generation,message_id) DO UPDATE SET document=excluded.document",
      binding.threadId, binding.generation, input.messageId, document)
    : execute(sql, "UPDATE supervisor_helper_channels SET document=? WHERE owner_thread_id=? AND owner_generation=? AND helper_thread_id=?",
      document, binding.threadId, binding.generation, input.threadId);
  const until = (condition: () => boolean) => Effect.gen(function* () {while (!condition()) yield* Effect.yieldNow;});
  return { binding, http, log, rpcs, policy, gate, stop, transport, receipt, until, detached,
    rawReceipt: row("deliveries"), writeReceipt: overwrite("deliveries"), rawChannel: row("channels"), writeChannel: overwrite("channels"),
    aborts: () => aborts, sections: () => sections, projectionReads: () => projectionReads,
    onGuard: (action: (read: number) => Effect.Effect<void>) => {onGuard = action;},
    holdProjection: (gateOn: Deferred.Deferred<void>) => {projectionGate = gateOn;} };
});

const fixture = fixtureWith("held");

describe("CT-LIN-05 on the helper webhook transport", () => {
  it.live("a: a send admitted before a Stop starts its POST before the Stop's policy commit, and the Stop completes while the POST awaits its reply", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const transport = yield* f.transport(yield* Effect.scope);
      // the Stop is requested at the send's final guard, before its receipt commit, while the send holds the section;
      // it waits for the permit, so the POST must already have started when the Stop commits
      let stopFiber: Fiber.Fiber<void> | undefined;
      f.onGuard((read) => read === 2
        ? Effect.map(f.detached(f.stop((policy) => {policy.stopped = true;})), (fiber) => {stopFiber = fiber;})
        : Effect.void);
      const send = yield* Effect.forkChild(transport.send(f.binding, input, { authorized: (guard) => Effect.map(guard.supervisionStopped("main"), (stopped) => !stopped) }));
      yield* Deferred.await(f.http.arrived);
      yield* f.until(() => stopFiber !== undefined);
      yield* Fiber.join(stopFiber!);
      assert.equal(Deferred.isDoneUnsafe(f.http.reply), false, "the Stop completed while the reply was still held");
      // the POST started inside the send's admission section, before the queued Stop committed
      assert.deepEqual(f.log, ["guard", "end", "guard", "initiate", "end", "policy-commit", "bookkeeping", "end"]);
      assert.equal((yield* f.receipt)?.state, "posting");
      yield* Deferred.succeed(f.http.reply, undefined);
      assert.equal(yield* Fiber.join(send), "waiting");
      assert.equal((yield* f.receipt)?.state, "posted");
      assert.equal((yield* f.receipt)?.nativeDeliveryId, "native-delivery-1");
      assert.deepEqual(f.http.posts, [helperDeliveryBody(input.messageId, input.text)]);
      assert.deepEqual(f.http.cut, [], "the peer finished its reply; the Stop cut nothing");
    }), { timeout: 10_000 });

  for (const [change, label, outcome] of [
    [(policy: { stopped: boolean; revoked: boolean }) => {policy.stopped = true;}, "a per-chat Stop", "busy"],
    [(policy: { stopped: boolean; revoked: boolean }) => {policy.revoked = true;}, "a revocation of the caller's authority", "revoked"],
  ] as const) {
    it.live(`b: a send queued behind ${label} is answered ${outcome} with no receipt and no POST`, () => Effect.gen(function* () {
      const f = yield* fixture;
      const transport = yield* f.transport(yield* Effect.scope);
      const projected = yield* Deferred.make<void>();
      f.holdProjection(projected);
      const send = yield* Effect.forkChild(transport.send(f.binding, input, {
        authorized: (guard) => Effect.map(guard.supervisionStopped("main"), (stopped) => !stopped && !f.policy.revoked) }));
      // the send passed its entry guard and is in its helper read when the Stop takes the section
      yield* f.until(() => f.projectionReads() === 1);
      const barrier = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      const stopping = yield* Effect.forkChild(f.stop(change, barrier));
      yield* Deferred.await(barrier.entered);
      yield* Deferred.succeed(projected, undefined);
      // the send's channel reads finish while the Stop holds the section; its admission waits for the permit
      yield* f.until(() => f.rpcs.includes("scheduledTasks.upsert"));
      yield* Deferred.succeed(barrier.release, undefined);
      yield* Fiber.join(stopping);
      assert.equal(yield* Fiber.join(send), outcome);
      assert.deepEqual(f.log, ["guard", "end", "policy-commit", "bookkeeping", "end", "guard", "end"]);
      assert.equal(yield* f.receipt, null);
      assert.deepEqual(f.http.posts, []);
    }), { timeout: 10_000 });
  }

  it.live("c: closing the transport scope with a POST in flight releases the request once and keeps the receipt; a later send reconciles without a second POST", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const transportScope = yield* Scope.make();
      const transport = yield* f.transport(transportScope);
      const send = yield* Effect.forkChild(transport.send(f.binding, input));
      yield* Deferred.await(f.http.arrived);
      const posting = yield* f.receipt;
      assert.equal(posting?.state, "posting");
      yield* Scope.close(transportScope, Exit.void);
      // the owner's operation was interrupted: its receipt decides, and without native evidence it stays uncertain
      assert.equal(yield* Fiber.join(send), "uncertain");
      assert.equal(f.aborts(), 1, "the in-flight request was released once");
      assert.deepEqual(yield* f.receipt, posting);
      const restarted = yield* f.transport(yield* Effect.scope);
      assert.equal(yield* restarted.send(f.binding, input), "uncertain");
      assert.equal(yield* restarted.reconcileDelivery(f.binding, input), "uncertain");
      assert.equal(f.http.posts.length, 1);
      assert.equal(f.aborts(), 1);
      assert.deepEqual(yield* f.receipt, posting);
    }), { timeout: 10_000 });

  it.live("d: a duplicate send of a live identity joins the original, never posts and reads no receipt", () => Effect.gen(function* () {
    const f = yield* fixture;
    const transport = yield* f.transport(yield* Effect.scope);
    const projected = yield* Deferred.make<void>();
    f.holdProjection(projected);
    const original = yield* Effect.forkChild(transport.send(f.binding, input));
    const duplicate = yield* Effect.forkChild(transport.send(f.binding, input));
    // both sends passed their entry guard and read no receipt before either reaches its admission
    yield* f.until(() => f.projectionReads() === 2);
    yield* Deferred.succeed(projected, undefined);
    yield* Deferred.await(f.http.arrived);
    // each send ran its entry section and its admission section; the duplicate's found the live POST
    yield* f.until(() => f.sections() === 4);
    yield* Deferred.succeed(f.http.reply, undefined);
    assert.equal(yield* Fiber.join(original), "waiting");
    assert.equal(yield* Fiber.join(duplicate), "waiting");
    assert.deepEqual(f.http.posts, [helperDeliveryBody(input.messageId, input.text)]);
    assert.equal(f.log.filter((entry) => entry === "initiate").length, 1);
    assert.equal(f.rpcs.includes("scheduledTasks.listWebhookDeliveries"), false, "the duplicate joined instead of reconciling a receipt");
    assert.equal((yield* f.receipt)?.state, "posted");
  }), { timeout: 10_000 });

  // a-r19-send-01: the live POST belongs to one exact request; a different request under the same identity that finds
  // it in flight is answered by the durable receipt, as the same send arriving after the POST is, never by its outcome
  for (const [label, conflicting] of [
    ["its text", { ...input, text: "Check the other branch." }],
    ["its command id", { ...input, commandId: "other-command" }],
  ] as const) {
    it.live(`e: a send that differs in ${label} under a live identity is not given that POST's outcome, and nothing is posted again`, () => Effect.gen(function* () {
      const f = yield* fixture;
      const transport = yield* f.transport(yield* Effect.scope);
      const projected = yield* Deferred.make<void>();
      f.holdProjection(projected);
      const requests = [input, conflicting] as const;
      const first = yield* Effect.forkChild(transport.send(f.binding, requests[0]));
      const second = yield* Effect.forkChild(transport.send(f.binding, requests[1]));
      // both sends passed their entry guard and read no receipt before either reaches its admission
      yield* f.until(() => f.projectionReads() === 2);
      yield* Deferred.succeed(projected, undefined);
      yield* Deferred.await(f.http.arrived);
      // each send ran its entry and admission sections while the POST was in flight: the later one found it live
      yield* f.until(() => f.sections() === 4);
      yield* Deferred.succeed(f.http.reply, undefined);
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
      // the posted request is the one whose receipt was stored, whichever the scheduler admitted first
      const winner = (yield* f.receipt)?.hash === workflowRequestHash(requests[0]) ? 0 : 1;
      const loser = requests[1 - winner]!;
      assert.equal((yield* f.receipt)?.hash, workflowRequestHash(requests[winner]!));
      assert.equal(results[winner], "waiting");
      assert.equal(results[1 - winner], "uncertain", "the other request is not given the posted request's outcome");
      assert.equal(yield* transport.hasDelivery(f.binding, loser), false, "the other request has no delivery");
      assert.equal(yield* transport.send(f.binding, loser), "uncertain", "and a later send of it stays uncertain");
      assert.deepEqual(f.http.posts, [helperDeliveryBody(requests[winner]!.messageId, requests[winner]!.text)]);
      assert.equal(f.log.filter((entry) => entry === "initiate").length, 1);
      assert.equal((yield* f.receipt)?.state, "posted");
    }), { timeout: 10_000 });
  }
});

// the webhook POST's response belongs to the admitted operation: whatever ends it (the caller giving up, the transport
// closing, a settled reply whose body is never read) ends an open request, as NRPC-08 does for the shell read
describe("webhook POST release", () => {
  for (const [label, ending] of [["the caller gives up", "cancel"], ["the transport scope closes", "close"]] as const) {
    it.live(`HTX-REL-01: a 2xx response held at the handoff to its body read is ended when ${label}`, () => Effect.gen(function* () {
      const f = yield* fixtureWith(202);
      // the reviewers' fault: the response is taken and held between its headers and its body read
      const headers = yield* Deferred.make<void>();
      let held: HttpClientResponse.HttpClientResponse | undefined;
      const atHandoff = (client: HttpClient.HttpClient) => HttpClient.transformResponse(client, (effect) => effect.pipe(Effect.tap((response) => {
        held = response;
        return Deferred.succeed(headers, undefined).pipe(Effect.andThen(Effect.never));
      })));
      const transportScope = yield* Scope.make();
      const transport = yield* f.transport(transportScope, atHandoff);
      const cancel = yield* Deferred.make<void>();
      const send = yield* Effect.forkChild(transport.send(f.binding, input, { cancel }));
      yield* Deferred.await(headers);
      if (ending === "cancel") yield* Deferred.succeed(cancel, undefined);
      else yield* Scope.close(transportScope, Exit.void);
      assert.equal(yield* Fiber.join(send), "uncertain");
      assert.ok(held !== undefined, "the response was taken");
      // bounded only so that a request left open fails here by name; the peer closes it at teardown
      const closed = yield* Deferred.await(f.http.ended).pipe(Effect.timeoutOption("2 seconds"));
      assert.ok(Option.isSome(closed), "the POST's request ended with its operation");
      assert.deepEqual(f.http.cut, [1]);
      assert.equal((yield* f.receipt)?.state, "posting");
      assert.deepEqual(f.http.posts, [helperDeliveryBody(input.messageId, input.text)]);
    }), { timeout: 10_000 });
  }

  it.live("HTX-REL-02: an unread 4xx reply's request is ended when its send settles rejected, and a later send only reconciles", () => Effect.gen(function* () {
    const f = yield* fixtureWith(400);
    const transport = yield* f.transport(yield* Effect.scope);
    assert.equal(yield* transport.send(f.binding, input), "rejected");
    // bounded only so that a request left open fails here by name; the peer closes it at teardown
    const closed = yield* Deferred.await(f.http.ended).pipe(Effect.timeoutOption("2 seconds"));
    assert.ok(Option.isSome(closed), "the unread 4xx request ended with its operation");
    assert.deepEqual(f.http.cut, [1]);
    assert.equal((yield* f.receipt)?.state, "rejected");
    assert.equal(yield* transport.send(f.binding, input), "rejected");
    assert.deepEqual(f.http.posts, [helperDeliveryBody(input.messageId, input.text)]);
  }), { timeout: 10_000 });
});

// sol-r19-01: a stored row this transport did not write (unparsable, or a document of the wrong shape) is proof that
// something was recorded, with unreadable content: every operation on the identity stays unresolved, posts nothing,
// never reads it as absent or retired, and leaves the row's bytes as they are
describe("an invalid stored receipt or channel", () => {
  const corruptions = [
    ["an unparsable", (_valid: string) => "{\"threadId\":"],
    ["a wrong-shape", (valid: string) => JSON.stringify({ ...JSON.parse(valid) as object, state: "delivered" })],
  ] as const;

  for (const [label, corrupt] of corruptions) {
    it.live(`${label} receipt after an accepted POST: send and reconciliation stay uncertain, the reads report an attempt, nothing is posted or rewritten`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const transport = yield* f.transport(yield* Effect.scope);
        yield* Deferred.succeed(f.http.reply, undefined);
        assert.equal(yield* transport.send(f.binding, input), "waiting");
        yield* f.writeReceipt(corrupt((yield* f.rawReceipt)!));
        const invalid = yield* f.rawReceipt;
        const reads = f.rpcs.length;

        assert.equal(yield* transport.send(f.binding, input), "uncertain");
        assert.equal(yield* transport.reconcileDelivery(f.binding, input), "uncertain", "never absent");
        assert.equal(yield* transport.hasDelivery(f.binding, input), true, "an attempt exists");
        assert.equal(yield* transport.receiptText(f.binding, input.messageId), invalidReceipt, "no text, and not absent");
        assert.equal(yield* transport.receiptDocument(f.binding, input.messageId), invalidReceipt);
        const message: MessageInfo = { id: "m", runId: null, nodeId: null, role: "user", text: input.text, streaming: false,
          createdAt: "2026-10-16T10:00:01Z", updatedAt: "2026-10-16T10:00:01Z", threadId: input.threadId };
        assert.equal(yield* transport.matchesMessage(f.binding, input.messageId, input.text, message, [message]), false, "never attributes");
        assert.equal(f.http.posts.length, 1, "nothing is posted again");
        assert.equal(f.rpcs.length, reads, "no native read acts on the invalid receipt");
        assert.equal(yield* f.rawReceipt, invalid, "the row keeps its bytes");
      }), { timeout: 10_000 });

    it.live(`${label} receipt with no POST of this transport: the send posts nothing and stays uncertain`, () => Effect.gen(function* () {
      const f = yield* fixture;
      const transport = yield* f.transport(yield* Effect.scope);
      const valid = JSON.stringify({ ...input, hash: workflowRequestHash(input), taskId: "task", state: "posting" });
      yield* f.writeReceipt(corrupt(valid));
      const invalid = yield* f.rawReceipt;
      assert.equal(yield* transport.send(f.binding, input), "uncertain");
      assert.equal(yield* transport.reconcileDelivery(f.binding, input), "uncertain");
      assert.deepEqual(f.http.posts, []);
      assert.equal(f.log.includes("initiate"), false);
      assert.equal(yield* f.rawReceipt, invalid);
    }), { timeout: 10_000 });

    it.live(`${label} channel is never reported retired and keeps its bytes`, () => Effect.gen(function* () {
      const f = yield* fixture;
      const transport = yield* f.transport(yield* Effect.scope);
      yield* Deferred.succeed(f.http.reply, undefined);
      assert.equal(yield* transport.send(f.binding, input), "waiting");
      yield* f.writeChannel(corrupt((yield* f.rawChannel)!));
      const invalid = yield* f.rawChannel;
      const calls = f.rpcs.length;
      assert.equal(yield* transport.retire(f.binding, input.threadId), false);
      assert.equal(f.rpcs.length, calls, "no native task is listed or deleted");
      assert.equal(yield* f.rawChannel, invalid);
    }), { timeout: 10_000 });
  }
});
