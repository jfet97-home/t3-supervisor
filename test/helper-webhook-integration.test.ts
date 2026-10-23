import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Deferred, Duration, Effect } from "effect";
import { helperDeliveryBody } from "../src/supervisor-helper-transport.js";
import { workflowRequestHash } from "../src/workflow-write-evidence.js";
import { execute, operateToken, readToken, row } from "./support/glinint-wiring.js";
import { json, rpcRequests } from "./support/int-native-peer.js";
import { hookPath, publishedWrapper, redirectedHookPath, startHelperFixture, type HelperFixture } from "./support/int-helper-fixture.js";

// production team runtime -> production helper transport -> platform fetch -> loopback socket; operate RPC over a real websocket;
// restart reopens the files. it.live: the webhook POSTs, the websocket RPC and the projection reads cross real loopback sockets,
// and H2's stalled body ends at the caller's own 3 s deadline on the live clock

// `deadline`: the caller's own deadline, a cancel completed after it on the live clock, as the baseline AbortSignal.timeout aborted
const runBatch = (f: HelperFixture, deadline?: Duration.Input) => Effect.gen(function* () {
  const binding = (yield* f.core.store.binding("p", "main"))!;
  yield* f.runtime.startCycle(binding);
  const cancel = deadline === undefined ? undefined : yield* Deferred.make<void>();
  if (cancel) yield* Effect.forkScoped(Effect.andThen(Effect.sleep(deadline!), Deferred.succeed(cancel, undefined)));
  return yield* f.runtime.runHelperBatch(binding, f.threads, f.batches, cancel);
});

const once = (work: Effect.Effect<void>): Effect.Effect<void> => {
  let done = false;
  return Effect.suspend(() => {
    if (done) return Effect.void;
    done = true;
    return work;
  });
};

// the exact identities the runtime hands to the transport (supervisor-team-runtime.ts:885)
const sentInput = (f: HelperFixture) => Effect.map(f.request, (request) =>
  ({threadId: "helper", commandId: `supervisor-review:${request.id}`, messageId: request.messageId, text: request.text}));

const assertCredentials = (f: HelperFixture): void => {
  for (const entry of f.peer.log) {
    if (entry.kind === "rpc") assert.equal(entry.authorization, `Bearer ${operateToken}`, `${entry.tag} uses the operate token`);
    else if (entry.method === "GET") assert.equal(entry.authorization, `Bearer ${readToken}`, `${entry.path} uses the read token`);
  }
  assert.deepEqual(f.peer.unexpected, []);
};

const channelState = (f: HelperFixture): Effect.Effect<string | null> => Effect.map(row(f.core.sql, "SELECT document FROM supervisor_helper_channels"),
  (found) => found ? (JSON.parse(String(found.document)) as {state: string}).state : null);

it.live("CT-INT-03: H1 an accepted POST whose reply is lost stays uncertain, is never re-posted and binds by exact body after restart", () => Effect.gen(function* () {
  const f = yield* startHelperFixture;
  f.state.reply = () => Effect.succeed({raw: (request) => {request.socket.destroy();}});
  yield* runBatch(f);

  const posts = f.posts();
  assert.equal(posts.length, 1, "no retry of a non-idempotent POST");
  const input = yield* sentInput(f);
  assert.equal(posts[0]!.path, hookPath);
  assert.equal(posts[0]!.body, helperDeliveryBody(input.messageId, input.text));
  assert.equal(posts[0]!.body, JSON.stringify({batchId: input.messageId, text: input.text}));
  assert.equal(posts[0]!.contentType, "application/json");
  const receipt = (yield* f.receipt)!;
  assert.equal(receipt.state, "posting");
  assert.equal(receipt.messageId, input.messageId);
  assert.equal(receipt.commandId, input.commandId);
  assert.equal(receipt.text, input.text);
  assert.equal(receipt.hash, workflowRequestHash(input));
  assert.equal(receipt.taskId, f.state.tasks[0]!.id);
  assert.match(String(receipt.taskId), /^supervisor-helper:[0-9a-f]{64}$/u);
  assert.equal("nativeDeliveryId" in receipt, false);
  const request = yield* f.request;
  assert.equal(request.state, "uncertain");
  assert.equal((yield* f.teamRequest).state, "uncertain");

  yield* f.restart;
  const binding = (yield* f.core.store.binding("p", "main"))!;
  yield* f.runtime.startCycle(binding);
  yield* f.runtime.reconcile(binding, f.threads);
  assert.equal(f.posts().length, 1, "reconciliation after restart posts nothing");
  const reconciled = (yield* f.receipt)!;
  assert.equal(reconciled.state, "posted");
  assert.equal(reconciled.nativeDeliveryId, "native-delivery-1");
  assert.equal(reconciled.renderedText, publishedWrapper(input.text));
  assert.equal(reconciled.messageId, input.messageId);
  assert.equal(reconciled.hash, receipt.hash);
  const reconciledRequest = yield* f.request;
  assert.equal(reconciledRequest.id, request.id);
  assert.equal(reconciledRequest.messageId, request.messageId);
  assert.equal(reconciledRequest.state, "waiting");
  assert.ok(rpcRequests(f.peer, "scheduledTasks.getWebhookDelivery").length >= 1);
  assertCredentials(f);
}), {timeout: 60_000});

it.live("CT-INT-03: H2 a stalled 2xx body is read until the caller's deadline, then stays uncertain as recorded acceptance", () => Effect.gen(function* () {
  const f = yield* startHelperFixture;
  f.state.reply = () => Effect.succeed({raw: (_request, response) => {
    response.writeHead(202, {"content-type": "application/json"});
    response.write("{\"deliveryId\":");
  }});
  const deadlineMs = 3_000;
  const started = yield* Clock.monotonicTimeNanos;
  yield* runBatch(f, Duration.millis(deadlineMs));
  const elapsed = Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000;
  assert.ok(elapsed >= deadlineMs, `the body read waits for the caller's signal (${Math.round(elapsed)} ms)`);
  assert.ok(elapsed < deadlineMs + 10_000, `the stalled body ends with the caller's signal (${Math.round(elapsed)} ms)`);
  assert.equal(f.posts().length, 1);
  const receipt = (yield* f.receipt)!;
  assert.equal(receipt.state, "posted");
  assert.equal("nativeDeliveryId" in receipt, false);
  assert.equal((yield* f.request).state, "uncertain");
  assert.equal((yield* f.teamRequest).state, "uncertain");
  assertCredentials(f);
}), {timeout: 60_000});

it.live("CT-INT-03: H3 an unreadable 2xx body cut by socket loss stays uncertain as recorded acceptance", () => Effect.gen(function* () {
  const f = yield* startHelperFixture;
  f.state.reply = () => Effect.succeed({raw: (request, response) => {
    response.writeHead(202, {"content-type": "application/json"});
    response.write("{\"deliveryId\":", () => request.socket.destroy());
  }});
  yield* runBatch(f);
  assert.equal(f.posts().length, 1);
  const receipt = (yield* f.receipt)!;
  assert.equal(receipt.state, "posted");
  assert.equal("nativeDeliveryId" in receipt, false);
  assert.equal((yield* f.request).state, "uncertain");
  assert.equal((yield* f.teamRequest).state, "uncertain");
  assertCredentials(f);
}), {timeout: 60_000});

it.live("CT-INT-03: H4a a Stop committed during the channel upsert fences the POST and returns the request to prepared", () => Effect.gen(function* () {
  const f = yield* startHelperFixture;
  f.state.beforeUpsert = once(f.stopMain);
  yield* runBatch(f);
  assert.equal(f.posts().length, 0);
  assert.equal(yield* f.receipt, null);
  assert.equal(yield* channelState(f), "ready");
  const request = yield* f.request;
  assert.equal(request.state, "prepared");
  assert.equal(request.sentAt, null);
  assert.deepEqual((yield* f.core.policy.get()).excludedThreadIds, ["main"]);
  assertCredentials(f);
}), {timeout: 60_000});

it.live("CT-INT-03: H4b a quarantine committed during the channel upsert revokes the send and settles its fence", () => Effect.gen(function* () {
  const f = yield* startHelperFixture;
  // the quarantine committed on the peer's hook, before the upsert reply
  f.state.beforeUpsert = once(Effect.flatMap(f.core.store.binding("p", "main"), (binding) => f.core.team.quarantineMember(binding!, "helper")).pipe(Effect.asVoid, Effect.orDie));
  yield* runBatch(f);
  assert.equal(f.posts().length, 0);
  assert.equal(yield* f.receipt, null);
  assert.equal((yield* f.request).state, "failed");
  assert.equal((yield* f.teamRequest).state, "settled");
  const events = (yield* f.core.team.snapshot((yield* f.core.store.binding("p", "main"))!)).events;
  assert.equal(events.some(event => event.kind === "service_attention" && event.id.startsWith("helper-checkin-failed:")), true);
  assertCredentials(f);
}), {timeout: 60_000});

it.live("CT-INT-03: H4c a Stop committed during the transport's helper read still lists and upserts the channel, then fences the POST", () => Effect.gen(function* () {
  const f = yield* startHelperFixture;
  // the first helper read is the runtime's own (a Stop there prepares nothing); the second is the transport's (:370)
  let stopIndex = -1;
  let stateAtStop: string | null = null;
  f.state.beforeHelperProjection = read => read !== 2 ? Effect.void : Effect.gen(function* () {
    stateAtStop = (yield* f.request).state;
    yield* f.stopMain;
    stopIndex = f.peer.log.length - 1;
  });
  yield* runBatch(f);
  assert.ok(stopIndex >= 0, "the transport read its helper projection");
  assert.equal(stateAtStop, "sending", "the Stop lands after the runtime admitted the request to the transport");
  const afterStop = f.peer.log.slice(stopIndex + 1).map(entry => entry.kind === "rpc" ? entry.tag : `${entry.method} ${entry.path}`);
  assert.deepEqual(afterStop, ["scheduledTasks.list", "scheduledTasks.upsert"]);
  assert.equal(f.posts().length, 0);
  assert.equal(yield* f.receipt, null);
  const request = yield* f.request;
  assert.equal(request.state, "prepared");
  assert.equal(request.sentAt, null);
  assertCredentials(f);
}), {timeout: 60_000});

it.live("CT-INT-03: H5 a Stop committed after admission does not cancel the POST and later cycles post nothing", () => Effect.gen(function* () {
  const f = yield* startHelperFixture;
  f.state.reply = () => Effect.as(f.stopMain, json(202, {deliveryId: "native-delivery"}));
  yield* runBatch(f);
  assert.equal(f.posts().length, 1);
  const receipt = (yield* f.receipt)!;
  assert.equal(receipt.state, "posted");
  assert.equal(receipt.nativeDeliveryId, "native-delivery");
  assert.equal((yield* f.request).state, "waiting");

  const traffic = f.peer.log.length;
  yield* runBatch(f);
  assert.equal(f.peer.log.length, traffic, "a stopped cycle returns at once");
  assert.equal(f.posts().length, 1);
  assert.deepEqual(yield* f.receipt, receipt, "the delivery identity is unchanged");
  assertCredentials(f);
}), {timeout: 60_000});

it.live("CT-INT-03: H6 a 307 reply makes Node fetch re-POST the same body to the redirect target", () => Effect.gen(function* () {
  const f = yield* startHelperFixture;
  f.state.reply = (entry, deliveryId) => Effect.succeed(entry.path === hookPath ? {raw: (_request, response) => {
    response.writeHead(307, {location: redirectedHookPath, "content-length": 0});
    response.end();
  }} : json(202, {deliveryId}));
  yield* runBatch(f);
  const posts = f.posts();
  assert.deepEqual(posts.map(entry => entry.path), [hookPath, redirectedHookPath]);
  assert.equal(posts[1]!.body, posts[0]!.body);
  assert.equal(posts[1]!.contentType, "application/json");
  const receipt = (yield* f.receipt)!;
  assert.equal(receipt.state, "posted");
  assert.equal(receipt.nativeDeliveryId, "native-delivery-2");
  assert.equal((yield* f.request).state, "waiting");
  assertCredentials(f);
}), {timeout: 60_000});

// sol-r19-01 on the real caller: the receipt of an accepted check-in replaced by bytes the transport did not write. The
// team runtime's reconciliation reaches the send, which stays uncertain on the unreadable receipt; the request keeps
// its identity, its fence stays unresolved, nothing is posted again and the row keeps its bytes, active or stopped
const rawReceipt = (f: HelperFixture): Effect.Effect<string> => Effect.map(row(f.core.sql, "SELECT document FROM supervisor_helper_deliveries"),
  (found) => String(found!.document));
for (const [label, corrupt] of [
  ["an unparsable", (_valid: string) => "{\"threadId\":"],
  ["a wrong-shape", (valid: string) => JSON.stringify({...JSON.parse(valid) as object, state: "delivered"})],
] as const) {
  it.live(`SOL-R19-01: ${label} receipt of an accepted check-in stays unresolved through active and stopped reconciliation and is never posted again`, () => Effect.gen(function* () {
    const f = yield* startHelperFixture;
    yield* runBatch(f);
    assert.equal(f.posts().length, 1);
    const request = yield* f.request;
    const fence = yield* f.teamRequest;
    assert.equal(request.state, "waiting");
    yield* execute(f.core.sql, "UPDATE supervisor_helper_deliveries SET document=?", corrupt(yield* rawReceipt(f)));
    const invalid = yield* rawReceipt(f);

    const binding = (yield* f.core.store.binding("p", "main"))!;
    yield* f.runtime.startCycle(binding);
    yield* f.runtime.reconcile(binding, f.threads);
    const reconciled = yield* f.request;
    assert.deepEqual([reconciled.id, reconciled.messageId, reconciled.text, reconciled.state], [request.id, request.messageId, request.text, "uncertain"]);
    assert.deepEqual([(yield* f.teamRequest).requestId, (yield* f.teamRequest).state], [fence.requestId, "uncertain"], "its fence stays unresolved");
    assert.equal(f.posts().length, 1, "nothing is posted again");
    assert.equal(yield* rawReceipt(f), invalid, "the receipt keeps its bytes");

    yield* f.stopMain;
    yield* f.runtime.startCycle(binding);
    yield* f.runtime.reconcileStopped(binding, f.threads);
    assert.deepEqual([(yield* f.request).id, (yield* f.request).state], [request.id, "uncertain"], "the stopped reconciliation neither fails nor releases it");
    assert.deepEqual([(yield* f.teamRequest).requestId, (yield* f.teamRequest).state], [fence.requestId, "uncertain"]);
    assert.equal(f.posts().length, 1);
    assert.equal(yield* rawReceipt(f), invalid);
    assertCredentials(f);
  }), {timeout: 60_000});
}
