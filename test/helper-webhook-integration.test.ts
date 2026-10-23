import assert from "node:assert/strict";
import { it, type TestContext } from "vitest";
import { after } from "./support/node-test.js";
import { helperDeliveryBody } from "../src/supervisor-helper-transport.js";
import { workflowRequestHash } from "../src/workflow-write-evidence.js";
import { rpcRequests, sendJson } from "./support/int-native-peer.js";
import { hookPath, publishedWrapper, redirectedHookPath, startHelperFixture, type HelperFixture } from "./support/int-helper-fixture.js";
import { operateToken, readToken } from "./support/int-production-wiring.js";

// production team runtime -> production helper transport -> Node global fetch -> loopback socket; operate RPC over a real websocket; restart reopens the files

const fixture = async (t: TestContext): Promise<HelperFixture> => {
  const f = await startHelperFixture();
  after(t, f.close);
  return f;
};

const runBatch = (f: HelperFixture, deadlineMs = 20_000) => {
  const binding = f.core.store.binding("p", "main")!;
  f.runtime.startCycle(binding);
  return f.runtime.runHelperBatch(binding, f.threads, f.batches, AbortSignal.timeout(deadlineMs));
};

const once = (work: () => void): (() => void) => {
  let done = false;
  return () => {if (!done) {done = true;work();}};
};

// the exact identities the runtime hands to the transport (supervisor-team-runtime.ts:885)
const sentInput = (f: HelperFixture) => {
  const request = f.request();
  return {threadId: "helper", commandId: `supervisor-review:${request.id}`, messageId: request.messageId, text: request.text};
};

const assertCredentials = (f: HelperFixture): void => {
  for (const entry of f.peer.log) {
    if (entry.kind === "rpc") assert.equal(entry.authorization, `Bearer ${operateToken}`, `${entry.tag} uses the operate token`);
    else if (entry.method === "GET") assert.equal(entry.authorization, `Bearer ${readToken}`, `${entry.path} uses the read token`);
  }
  assert.deepEqual(f.peer.unexpected, []);
};

const channelState = (f: HelperFixture): string | null => {
  const row = f.core.guidance.db.prepare("SELECT document FROM supervisor_helper_channels").get();
  return row ? (JSON.parse(String(row.document)) as {state: string}).state : null;
};

it("CT-INT-03: H1 an accepted POST whose reply is lost stays uncertain, is never re-posted and binds by exact body after restart", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  f.state.reply = (_entry, request) => {request.socket.destroy();};
  await runBatch(f);

  const posts = f.posts();
  assert.equal(posts.length, 1, "no retry of a non-idempotent POST");
  const input = sentInput(f);
  assert.equal(posts[0]!.path, hookPath);
  assert.equal(posts[0]!.body, helperDeliveryBody(input.messageId, input.text));
  assert.equal(posts[0]!.body, JSON.stringify({batchId: input.messageId, text: input.text}));
  assert.equal(posts[0]!.contentType, "application/json");
  const receipt = f.receipt()!;
  assert.equal(receipt.state, "posting");
  assert.equal(receipt.messageId, input.messageId);
  assert.equal(receipt.commandId, input.commandId);
  assert.equal(receipt.text, input.text);
  assert.equal(receipt.hash, workflowRequestHash(input));
  assert.equal(receipt.taskId, f.state.tasks[0]!.id);
  assert.match(String(receipt.taskId), /^supervisor-helper:[0-9a-f]{64}$/u);
  assert.equal("nativeDeliveryId" in receipt, false);
  const request = f.request();
  assert.equal(request.state, "uncertain");
  assert.equal(f.teamRequest().state, "uncertain");

  await f.restart();
  const binding = f.core.store.binding("p", "main")!;
  f.runtime.startCycle(binding);
  await f.runtime.reconcile(binding, f.threads, AbortSignal.timeout(20_000));
  assert.equal(f.posts().length, 1, "reconciliation after restart posts nothing");
  const reconciled = f.receipt()!;
  assert.equal(reconciled.state, "posted");
  assert.equal(reconciled.nativeDeliveryId, "native-delivery-1");
  assert.equal(reconciled.renderedText, publishedWrapper(input.text));
  assert.equal(reconciled.messageId, input.messageId);
  assert.equal(reconciled.hash, receipt.hash);
  const reconciledRequest = f.request();
  assert.equal(reconciledRequest.id, request.id);
  assert.equal(reconciledRequest.messageId, request.messageId);
  assert.equal(reconciledRequest.state, "waiting");
  assert.ok(rpcRequests(f.peer, "scheduledTasks.getWebhookDelivery").length >= 1);
  assertCredentials(f);
});

it("CT-INT-03: H2 a stalled 2xx body is read until the caller's deadline, then stays uncertain as recorded acceptance", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  f.state.reply = (_entry, _request, response) => {
    response.writeHead(202, {"content-type": "application/json"});
    response.write("{\"deliveryId\":");
  };
  const deadlineMs = 3_000;
  const started = performance.now();
  await runBatch(f, deadlineMs);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= deadlineMs, `the body read waits for the caller's signal (${Math.round(elapsed)} ms)`);
  assert.ok(elapsed < deadlineMs + 10_000, `the stalled body ends with the caller's signal (${Math.round(elapsed)} ms)`);
  assert.equal(f.posts().length, 1);
  const receipt = f.receipt()!;
  assert.equal(receipt.state, "posted");
  assert.equal("nativeDeliveryId" in receipt, false);
  assert.equal(f.request().state, "uncertain");
  assert.equal(f.teamRequest().state, "uncertain");
  assertCredentials(f);
});

it("CT-INT-03: H3 an unreadable 2xx body cut by socket loss stays uncertain as recorded acceptance", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  f.state.reply = (_entry, request, response) => {
    response.writeHead(202, {"content-type": "application/json"});
    response.write("{\"deliveryId\":", () => request.socket.destroy());
  };
  await runBatch(f);
  assert.equal(f.posts().length, 1);
  const receipt = f.receipt()!;
  assert.equal(receipt.state, "posted");
  assert.equal("nativeDeliveryId" in receipt, false);
  assert.equal(f.request().state, "uncertain");
  assert.equal(f.teamRequest().state, "uncertain");
  assertCredentials(f);
});

it("CT-INT-03: H4a a Stop committed during the channel upsert fences the POST and returns the request to prepared", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  f.state.beforeUpsert = once(() => f.stopMain());
  await runBatch(f);
  assert.equal(f.posts().length, 0);
  assert.equal(f.receipt(), null);
  assert.equal(channelState(f), "ready");
  const request = f.request();
  assert.equal(request.state, "prepared");
  assert.equal(request.sentAt, null);
  assert.deepEqual(f.core.policy.get().excludedThreadIds, ["main"]);
  assertCredentials(f);
});

it("CT-INT-03: H4b a quarantine committed during the channel upsert revokes the send and settles its fence", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  f.state.beforeUpsert = once(() => {f.core.supervision.team.quarantineMember(f.core.store.binding("p", "main")!, "helper");});
  await runBatch(f);
  assert.equal(f.posts().length, 0);
  assert.equal(f.receipt(), null);
  assert.equal(f.request().state, "failed");
  assert.equal(f.teamRequest().state, "settled");
  const events = f.core.supervision.team.snapshot(f.core.store.binding("p", "main")!).events;
  assert.equal(events.some(event => event.kind === "service_attention" && event.id.startsWith("helper-checkin-failed:")), true);
  assertCredentials(f);
});

it("CT-INT-03: H4c a Stop committed during the transport's helper read still lists and upserts the channel, then fences the POST", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  // the first helper read is the runtime's own (a Stop there prepares nothing); the second is the transport's (:370)
  let stopIndex = -1;
  let stateAtStop: string | null = null;
  f.state.beforeHelperProjection = read => {
    if (read !== 2) return;
    stateAtStop = f.request().state;
    f.stopMain();
    stopIndex = f.peer.log.length - 1;
  };
  await runBatch(f);
  assert.ok(stopIndex >= 0, "the transport read its helper projection");
  assert.equal(stateAtStop, "sending", "the Stop lands after the runtime admitted the request to the transport");
  const afterStop = f.peer.log.slice(stopIndex + 1).map(entry => entry.kind === "rpc" ? entry.tag : `${entry.method} ${entry.path}`);
  assert.deepEqual(afterStop, ["scheduledTasks.list", "scheduledTasks.upsert"]);
  assert.equal(f.posts().length, 0);
  assert.equal(f.receipt(), null);
  const request = f.request();
  assert.equal(request.state, "prepared");
  assert.equal(request.sentAt, null);
  assertCredentials(f);
});

it("CT-INT-03: H5 a Stop committed after admission does not cancel the POST and later cycles post nothing", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  f.state.reply = (_entry, _request, response) => {
    f.stopMain();
    sendJson(response, 202, {deliveryId: "native-delivery"});
  };
  await runBatch(f);
  assert.equal(f.posts().length, 1);
  const receipt = f.receipt()!;
  assert.equal(receipt.state, "posted");
  assert.equal(receipt.nativeDeliveryId, "native-delivery");
  assert.equal(f.request().state, "waiting");

  const traffic = f.peer.log.length;
  await runBatch(f);
  assert.equal(f.peer.log.length, traffic, "a stopped cycle returns at once");
  assert.equal(f.posts().length, 1);
  assert.deepEqual(f.receipt(), receipt, "the delivery identity is unchanged");
  assertCredentials(f);
});

it("CT-INT-03: H6 a 307 reply makes Node fetch re-POST the same body to the redirect target", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  f.state.reply = (entry, _request, response, deliveryId) => {
    if (entry.path === hookPath) {
      response.writeHead(307, {location: redirectedHookPath, "content-length": 0});
      response.end();
      return;
    }
    sendJson(response, 202, {deliveryId});
  };
  await runBatch(f);
  const posts = f.posts();
  assert.deepEqual(posts.map(entry => entry.path), [hookPath, redirectedHookPath]);
  assert.equal(posts[1]!.body, posts[0]!.body);
  assert.equal(posts[1]!.contentType, "application/json");
  const receipt = f.receipt()!;
  assert.equal(receipt.state, "posted");
  assert.equal(receipt.nativeDeliveryId, "native-delivery-2");
  assert.equal(f.request().state, "waiting");
  assertCredentials(f);
});

// sol-r19-01 on the real caller: the receipt of an accepted check-in replaced by bytes the transport did not write. The
// team runtime's reconciliation reaches the send, which stays uncertain on the unreadable receipt; the request keeps
// its identity, its fence stays unresolved, nothing is posted again and the row keeps its bytes, active or stopped
const rawReceipt = (f: HelperFixture): string => String(f.core.guidance.db.prepare("SELECT document FROM supervisor_helper_deliveries").get()!.document);
for (const [label, corrupt] of [
  ["an unparsable", (_valid: string) => "{\"threadId\":"],
  ["a wrong-shape", (valid: string) => JSON.stringify({...JSON.parse(valid) as object, state: "delivered"})],
] as const) {
  it(`SOL-R19-01: ${label} receipt of an accepted check-in stays unresolved through active and stopped reconciliation and is never posted again`, {timeout: 60_000}, async (t) => {
    const f = await fixture(t);
    await runBatch(f);
    assert.equal(f.posts().length, 1);
    const request = f.request();
    const fence = f.teamRequest();
    assert.equal(request.state, "waiting");
    f.core.guidance.db.prepare("UPDATE supervisor_helper_deliveries SET document=?").run(corrupt(rawReceipt(f)));
    const invalid = rawReceipt(f);

    const binding = f.core.store.binding("p", "main")!;
    f.runtime.startCycle(binding);
    await f.runtime.reconcile(binding, f.threads, AbortSignal.timeout(20_000));
    const reconciled = f.request();
    assert.deepEqual([reconciled.id, reconciled.messageId, reconciled.text, reconciled.state], [request.id, request.messageId, request.text, "uncertain"]);
    assert.deepEqual([f.teamRequest().requestId, f.teamRequest().state], [fence.requestId, "uncertain"], "its fence stays unresolved");
    assert.equal(f.posts().length, 1, "nothing is posted again");
    assert.equal(rawReceipt(f), invalid, "the receipt keeps its bytes");

    f.stopMain();
    f.runtime.startCycle(binding);
    await f.runtime.reconcileStopped(binding, f.threads, AbortSignal.timeout(20_000));
    assert.deepEqual([f.request().id, f.request().state], [request.id, "uncertain"], "the stopped reconciliation neither fails nor releases it");
    assert.deepEqual([f.teamRequest().requestId, f.teamRequest().state], [fence.requestId, "uncertain"]);
    assert.equal(f.posts().length, 1);
    assert.equal(rawReceipt(f), invalid);
    assertCredentials(f);
  });
}
