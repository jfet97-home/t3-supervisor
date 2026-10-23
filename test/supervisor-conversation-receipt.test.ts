import assert from "node:assert/strict";
import { Context, Effect, Fiber } from "effect";
import { it, type TestContext } from "vitest";
import { after, mockMethod } from "./support/node-test.js";
import { withDeadline } from "./support/c1-loopback.js";
import type { BindingRecord } from "../src/project-supervisor-store.js";
import type { WorkflowIntroduction } from "../src/supervisor-conversation-store.js";
import { SupervisorConversation, workflowIntroductionText } from "../src/supervisor-conversation.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { baseTime, makeFixture, operativeThreadId, proceed, projectId, type Fixture, type RpcCall } from "./support/c1-conversation-fixture.js";

// target regressions of the ported introduction and root check-in admission (S6b): inside the admission section the durable
// receipt decides, so a public caller holding a stale prepared copy answers from a send another caller already recorded and
// initiates nothing; a caller arriving while that send is still in flight only joins it

const isIntroduction = (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === operativeThreadId;
const isCheckIn = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === fixture.binding.threadId;

// the prepared unsent introduction of the fixture task, as an earlier cycle reserved it
const readyIntroduction = async /*s6d*/ (fixture: Fixture): Promise<WorkflowIntroduction> => {
  const introduction: WorkflowIntroduction = {taskId: fixture.task.id, projectId, threadId: operativeThreadId, supervisorThreadId: fixture.binding.threadId,
    state: "ready", text: workflowIntroductionText(fixture.task), messageId: `supervisor-notice:workflow:${fixture.task.id}`, targetRunId: null, error: null};
  await fixture.conversation.requests.saveIntroduction(introduction);
  return introduction;
};

// holds the first two reads of the Supervisor projection, each public run's last read before its introduction send, until released
const holdFinalReads = (t: TestContext, fixture: Fixture) => {
  const arrivals = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  after(t, () => {for (const release of releases) release.resolve();});
  const read = fixture.conversation.projection;
  let held = 0;
  mockMethod(t, fixture.conversation, "projection", async (threadId: string, signal: AbortSignal) => {
    if (threadId === fixture.binding.threadId && held < 2) {
      const index = held++;
      arrivals[index]!.resolve();
      await releases[index]!.promise;
    }
    return read(threadId, signal);
  });
  return {
    arrived: (index: number) => withDeadline(arrivals[index]!.promise, 3_000, `run ${index + 1} at its last read`),
    release: (index: number) => releases[index]!.resolve(),
  };
};

// two public runs of the same binding on the production conversation service, each on its own fiber
const twoRuns = async /*s6d*/ (fixture: Fixture) => {
  const conversation = Context.get(fixture.conversation.context, SupervisorConversation);
  const binding: BindingRecord = (await fixture.projectStore.binding(projectId, operativeThreadId))!;
  const fibers = [0, 1].map(() => Effect.runFork(conversation.run(binding, fixture.supervisor, fixture.threadList)));
  return {
    // the run released first ends while the other is still held
    firstEnded: () => withDeadline(Promise.race(fibers.map(fiber => Effect.runPromise(Fiber.await(fiber)))), 3_000, "the released run"),
    bothEnded: () => withDeadline(Promise.all(fibers.map(fiber => Effect.runPromise(Fiber.join(fiber)))), 3_000, "both runs"),
  };
};

it("S6b-CONV-04: two concurrent public runs holding the same prepared introduction initiate it once; the later one answers from the unknown receipt", {timeout: 10_000}, async t => {
  const fixture = await makeFixture({now: baseTime});
  after(t, fixture.cleanup);
  const held = await readyIntroduction(fixture);
  const reads = holdFinalReads(t, fixture);
  // the reply is lost, so the first send records an unknown outcome
  fixture.intercept(call => isIntroduction(call) ? Promise.reject(new SupervisorRpcError("uncertain")) : null);
  const runs = await twoRuns(fixture);
  await reads.arrived(0);
  await reads.arrived(1);
  assert.deepEqual(await fixture.conversation.requests.introduction(fixture.task.id), held, "both runs hold the same prepared copy");

  reads.release(0);
  await runs.firstEnded();
  const unknown = await fixture.conversation.requests.introduction(fixture.task.id);
  assert.deepEqual(unknown, {...held, state: "uncertain", dispatchMode: unknown?.dispatchMode, targetRunId: unknown?.targetRunId, definiteRejection: false,
    error: "Proposal delivery is uncertain. Its exact message identity is retained."});
  assert.equal(fixture.calls.filter(isIntroduction).length, 1);

  reads.release(1);
  await runs.bothEnded();
  assert.equal(fixture.calls.filter(isIntroduction).length, 1, "the later run initiates nothing from its stale copy");
  assert.deepEqual(await fixture.conversation.requests.introduction(fixture.task.id), unknown, "the unknown receipt keeps its identity and state");
});

it("S6b-CONV-05: a public run holding a stale prepared check-in answers from the unknown receipt another run recorded and sends nothing", {timeout: 10_000}, async t => {
  // plan-mode Supervisor modes keep the introduction unsent, so only the root check-in is posted
  const fixture = await makeFixture({now: baseTime}, {supervisorInteractionMode: "plan"});
  after(t, fixture.cleanup);
  await readyIntroduction(fixture);
  const prepared = await fixture.conversation.requests.prepare({projectId, supervisorThreadId: fixture.binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, baseTime);
  const reads = holdFinalReads(t, fixture);
  fixture.intercept(call => isCheckIn(fixture)(call) ? Promise.reject(new SupervisorRpcError("uncertain")) : null);
  const runs = await twoRuns(fixture);
  await reads.arrived(0);
  await reads.arrived(1);
  assert.deepEqual(await fixture.conversation.requests.pending(projectId, fixture.binding.threadId), prepared, "both runs read the same unsent check-in");

  reads.release(0);
  await runs.firstEnded();
  const unknown = await fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.deepEqual(unknown, {...prepared, state: "uncertain", sentAt: unknown?.sentAt,
    error: "Supervisor request delivery is uncertain; its original identity is retained and only observed, never resent."});
  assert.equal(fixture.calls.filter(isCheckIn(fixture)).length, 1);

  reads.release(1);
  await runs.bothEnded();
  assert.equal(fixture.calls.filter(isCheckIn(fixture)).length, 1, "the later run sends nothing from its stale copy");
  assert.deepEqual(await fixture.conversation.requests.pending(projectId, fixture.binding.threadId), unknown, "the unknown receipt keeps its identity and state");
  assert.deepEqual(fixture.calls.filter(isIntroduction), [], "the introduction stays unsent");
});

it("S6b-CONV-06: a public run released while the same introduction send is in flight initiates nothing, and both runs settle on the one send", {timeout: 10_000}, async t => {
  const fixture = await makeFixture({now: baseTime});
  after(t, fixture.cleanup);
  const held = await readyIntroduction(fixture);
  const reads = holdFinalReads(t, fixture);
  const reached = Promise.withResolvers<RpcCall>();
  const reply = Promise.withResolvers<unknown>();
  after(t, () => reply.resolve(proceed));
  fixture.intercept(call => {
    if (!isIntroduction(call)) return null;
    reached.resolve(call);
    return reply.promise;
  });
  const runs = await twoRuns(fixture);
  await reads.arrived(0);
  await reads.arrived(1);
  reads.release(0);
  const call = await withDeadline(reached.promise, 3_000, "the introduction POST");
  assert.equal((await fixture.conversation.requests.introduction(fixture.task.id))?.state, "sending");
  // the second run reaches the send while the first one's reply is still pending
  reads.release(1);
  reply.resolve(proceed);
  await runs.bothEnded();
  assert.deepEqual(fixture.calls.filter(isIntroduction), [call], "one initiation for both runs");
  const accepted = await fixture.conversation.requests.introduction(fixture.task.id);
  assert.equal(accepted?.state, "accepted");
  assert.equal(accepted?.messageId, held.messageId);
});
