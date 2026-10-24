import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { BindingRecord } from "../src/project-supervisor-store.js";
import type { WorkflowIntroduction } from "../src/supervisor-conversation-store.js";
import { workflowIntroductionText } from "../src/supervisor-conversation.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { wallClock, within } from "./support/g1b-conversation.js";
import { baseTime, makeFixture, operativeThreadId, proceed, projectId, type Fixture, type RpcCall } from "./support/c1-conversation-fixture.js";

// target regressions of the ported introduction and root check-in admission (S6b): inside the admission section the durable
// receipt decides, so a public caller holding a stale prepared copy answers from a send another caller already recorded and
// initiates nothing; a caller arriving while that send is still in flight only joins it.
// the cases are Effect tests on the production conversation, admission gate and stores over real files in a temporary
// directory, with the fake T3 as an effect fake; the services' test clock stands at a fixed wall time after every time the
// fixture records, as the baseline services read the real clock

const isIntroduction = (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === operativeThreadId;
const isCheckIn = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === fixture.binding.threadId;

// a fixture whose services read the wall clock while the fixture records its own times
const fixtureAt = (options?: Parameters<typeof makeFixture>[1]) => Effect.andThen(TestClock.setTime(wallClock), makeFixture({now: baseTime}, options));

// the prepared unsent introduction of the fixture task, as an earlier cycle reserved it
const readyIntroduction = (fixture: Fixture) => Effect.gen(function* () {
  const introduction: WorkflowIntroduction = {taskId: fixture.task.id, projectId, threadId: operativeThreadId, supervisorThreadId: fixture.binding.threadId,
    state: "ready", text: workflowIntroductionText(fixture.task), messageId: `supervisor-notice:workflow:${fixture.task.id}`, targetRunId: null, error: null};
  yield* fixture.requests.saveIntroduction(introduction);
  return introduction;
});

// holds the first two reads of the Supervisor projection, each public run's last read before its introduction send, until released
const holdFinalReads = (fixture: Fixture) => Effect.gen(function* () {
  const arrivals = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
  const releases = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
  let held = 0;
  fixture.fake.holdReads((threadId, read) => Effect.gen(function* () {
    if (threadId === fixture.binding.threadId && held < 2) {
      const index = held++;
      yield* Deferred.succeed(arrivals[index]!, undefined);
      yield* Deferred.await(releases[index]!);
    }
    return yield* read;
  }));
  return {
    arrived: (index: number) => within(Deferred.await(arrivals[index]!), 3_000, `run ${index + 1} at its last read`),
    release: (index: number) => Deferred.succeed(releases[index]!, undefined),
  };
});

// two public runs of the same binding on the production conversation service, each on its own fiber
const twoRuns = (fixture: Fixture) => Effect.gen(function* () {
  const conversation = fixture.conversation;
  const binding = (yield* fixture.projectStore.binding(projectId, operativeThreadId)) as BindingRecord;
  const fibers = yield* Effect.forEach([0, 1], () => Effect.forkChild(conversation.run(binding, fixture.supervisor, fixture.threadList)));
  return {
    // the run released first ends while the other is still held
    firstEnded: within(Effect.raceAll(fibers.map(fiber => Fiber.await(fiber))), 3_000, "the released run"),
    bothEnded: within(Effect.forEach(fibers, Fiber.join), 3_000, "both runs"),
  };
});

it.effect("S6b-CONV-04: two concurrent public runs holding the same prepared introduction initiate it once; the later one answers from the unknown receipt", () => Effect.gen(function* () {
  const fixture = yield* fixtureAt();
  const held = yield* readyIntroduction(fixture);
  const reads = yield* holdFinalReads(fixture);
  // the reply is lost, so the first send records an unknown outcome
  fixture.intercept(call => isIntroduction(call) ? Effect.fail(new SupervisorRpcError("uncertain")) : null);
  const runs = yield* twoRuns(fixture);
  yield* reads.arrived(0);
  yield* reads.arrived(1);
  assert.deepEqual(yield* fixture.requests.introduction(fixture.task.id), held, "both runs hold the same prepared copy");

  yield* reads.release(0);
  yield* runs.firstEnded;
  const unknown = yield* fixture.requests.introduction(fixture.task.id);
  assert.deepEqual(unknown, {...held, commandId: `supervisor-workflow:${held.messageId}`, state: "uncertain", dispatchMode: unknown?.dispatchMode, targetRunId: unknown?.targetRunId, definiteRejection: false,
    error: "Proposal delivery is uncertain. Its exact message identity is retained."});
  assert.equal(fixture.calls.filter(isIntroduction).length, 1);

  yield* reads.release(1);
  yield* runs.bothEnded;
  assert.equal(fixture.calls.filter(isIntroduction).length, 1, "the later run initiates nothing from its stale copy");
  assert.deepEqual(yield* fixture.requests.introduction(fixture.task.id), unknown, "the unknown receipt keeps its identity and state");
}), {timeout: 10_000});

it.effect("S6b-CONV-05: a public run holding a stale prepared check-in answers from the unknown receipt another run recorded and sends nothing", () => Effect.gen(function* () {
  // plan-mode Supervisor modes keep the introduction unsent, so only the root check-in is posted
  const fixture = yield* fixtureAt({supervisorInteractionMode: "plan"});
  yield* readyIntroduction(fixture);
  const prepared = yield* fixture.requests.prepare({projectId, supervisorThreadId: fixture.binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, baseTime);
  const reads = yield* holdFinalReads(fixture);
  fixture.intercept(call => isCheckIn(fixture)(call) ? Effect.fail(new SupervisorRpcError("uncertain")) : null);
  const runs = yield* twoRuns(fixture);
  yield* reads.arrived(0);
  yield* reads.arrived(1);
  assert.deepEqual(yield* fixture.requests.pending(projectId, fixture.binding.threadId), prepared, "both runs read the same unsent check-in");

  yield* reads.release(0);
  yield* runs.firstEnded;
  const unknown = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.deepEqual(unknown, {...prepared, state: "uncertain", sentAt: unknown?.sentAt,
    error: "Supervisor request delivery is uncertain; its original identity is retained and only observed, never resent."});
  assert.equal(fixture.calls.filter(isCheckIn(fixture)).length, 1);

  yield* reads.release(1);
  yield* runs.bothEnded;
  assert.equal(fixture.calls.filter(isCheckIn(fixture)).length, 1, "the later run sends nothing from its stale copy");
  assert.deepEqual(yield* fixture.requests.pending(projectId, fixture.binding.threadId), unknown, "the unknown receipt keeps its identity and state");
  assert.deepEqual(fixture.calls.filter(isIntroduction), [], "the introduction stays unsent");
}), {timeout: 10_000});

it.effect("S6b-CONV-06: a public run released while the same introduction send is in flight initiates nothing, and both runs settle on the one send", () => Effect.gen(function* () {
  const fixture = yield* fixtureAt();
  const held = yield* readyIntroduction(fixture);
  const reads = yield* holdFinalReads(fixture);
  const reached = yield* Deferred.make<RpcCall>();
  const reply = yield* Deferred.make<unknown>();
  fixture.intercept(call => {
    if (!isIntroduction(call)) return null;
    return Effect.andThen(Deferred.succeed(reached, call), Deferred.await(reply));
  });
  const runs = yield* twoRuns(fixture);
  yield* reads.arrived(0);
  yield* reads.arrived(1);
  yield* reads.release(0);
  const call = yield* within(Deferred.await(reached), 3_000, "the introduction POST");
  assert.equal((yield* fixture.requests.introduction(fixture.task.id))?.state, "sending");
  // the second run reaches the send while the first one's reply is still pending
  yield* reads.release(1);
  yield* Deferred.succeed(reply, proceed);
  yield* runs.bothEnded;
  assert.deepEqual(fixture.calls.filter(isIntroduction), [call], "one initiation for both runs");
  const accepted = yield* fixture.requests.introduction(fixture.task.id);
  assert.equal(accepted?.state, "accepted");
  assert.equal(accepted?.messageId, held.messageId);
}), {timeout: 10_000});
