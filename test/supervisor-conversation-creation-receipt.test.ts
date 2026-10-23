import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { BindingRecord } from "../src/project-supervisor-store.js";
import type { ConversationRequest, WorkflowIntroduction } from "../src/supervisor-conversation-store.js";
import { workflowIntroductionText } from "../src/supervisor-conversation.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { wallClock, within, type ReadHook } from "./support/g1b-conversation.js";
import { appendMessageToRun, appendRun, baseTime, makeFixture, operativeThreadId, projectId, type Fixture, type RpcCall } from "./support/c1-conversation-fixture.js";

// target regressions of the introduction and root check-in receipts (S6b): every write a public caller makes from what it
// read earlier (a creation, a native-modes refusal, an unavailable or blocked record, a reconciled check-in) happens only
// while the stored record is still exactly that read, so a send another caller recorded meanwhile keeps its unknown receipt,
// identities, body and route, Retry never deletes or resets it, and nothing initiates it again.
// the cases are Effect tests on the production conversation, project supervisor, admission gate and stores over real files in a
// temporary directory, with the fake T3 as an effect fake; the services' test clock stands at a fixed wall time after every
// time the fixture records, as the baseline services read the real clock; the baseline Retry's 8 s abort deadline is gone with
// the signal parameter: a hang guard, which the case's 10 s bound and the 3 s live-clock bound of the retry still cover

const isIntroduction = (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === operativeThreadId;
const binding = (fixture: Fixture) => Effect.map(fixture.projectStore.binding(projectId, operativeThreadId), (current) => current as BindingRecord);
const introduction = (fixture: Fixture): Effect.Effect<WorkflowIntroduction | null, unknown> => fixture.requests.introduction(fixture.task.id);
// the attempt's identities, body and route
const attempt = (value: WorkflowIntroduction | null) => value && {state: value.state, messageId: value.messageId, commandId: value.commandId ?? null,
  text: value.text, dispatchMode: value.dispatchMode ?? null, targetRunId: value.targetRunId, definiteRejection: value.definiteRejection ?? null};

// a fixture whose services read the wall clock while the fixture records its own times
const fixtureAt = (options?: Parameters<typeof makeFixture>[1]) => Effect.andThen(TestClock.setTime(wallClock), makeFixture({now: baseTime}, options));

// holds the conversation's reads of one thread, the first `count` of them, each until its own release
const holdReads = (fixture: Fixture, threadId: string, count: number) => Effect.gen(function* () {
  const arrivals = yield* Effect.forEach(Array.from({length: count}), () => Deferred.make<void>());
  const releases = yield* Effect.forEach(Array.from({length: count}), () => Deferred.make<void>());
  let held = 0;
  const hook: ReadHook = (id, read) => Effect.gen(function* () {
    if (id === threadId && held < count) {
      const index = held++;
      yield* Deferred.succeed(arrivals[index]!, undefined);
      yield* Deferred.await(releases[index]!);
    }
    return yield* read;
  });
  fixture.fake.holdReads(hook);
  return {arrivals, releases};
});

// holds the first projection read of one thread until released
const holdFirstRead = (fixture: Fixture, threadId: string) => Effect.map(holdReads(fixture, threadId, 1), ({arrivals, releases}) => ({
  arrived: within(Deferred.await(arrivals[0]!), 3_000, "the held read"),
  release: Deferred.succeed(releases[0]!, undefined),
}));

// the reports' sequence on the public service: an older run found no introduction and is held at its operative read with a
// Supervisor snapshot whose modes cannot contact the operative; a newer run creates the introduction, posts it and records an
// unknown outcome; then the older run resumes
const staleRefusalOverUnknown = (fixture: Fixture) => Effect.gen(function* () {
  const conversation = fixture.conversation;
  const read = yield* holdFirstRead(fixture, operativeThreadId);
  fixture.intercept(call => isIntroduction(call) ? Effect.fail(new SupervisorRpcError("uncertain")) : null);
  const stale = structuredClone(fixture.supervisor);
  stale.thread.interactionMode = "plan";
  const older = yield* Effect.forkChild(conversation.run(yield* binding(fixture), stale, fixture.threadList));
  yield* read.arrived;
  yield* within(conversation.run(yield* binding(fixture), fixture.supervisor, fixture.threadList), 3_000, "the newer run");
  const unknown = yield* introduction(fixture);
  yield* read.release;
  yield* within(Fiber.join(older), 3_000, "the older run");
  fixture.intercept(null);
  return {conversation, unknown, afterStale: yield* introduction(fixture)};
});

it.effect("S6b-CONV-07: a stale native-modes refusal never overwrites the unknown introduction another public run recorded; Retry keeps it and the next run initiates nothing", () => Effect.gen(function* () {
  const fixture = yield* fixtureAt();
  const {conversation, unknown, afterStale} = yield* staleRefusalOverUnknown(fixture);
  yield* fixture.conversation.retry(projectId, (yield* binding(fixture)).threadId);
  const afterRetry = yield* introduction(fixture);
  yield* within(conversation.run(yield* binding(fixture), fixture.supervisor, fixture.threadList), 3_000, "the next run");

  assert.equal(fixture.calls.filter(isIntroduction).length, 1, "one native initiation in total");
  assert.equal(unknown?.state, "uncertain");
  assert.equal(unknown?.definiteRejection, false);
  assert.deepEqual(afterStale, unknown, "the stale refusal leaves the unknown receipt exactly as recorded");
  assert.deepEqual(afterRetry, unknown, "Retry neither deletes nor resets the unknown receipt");
  assert.deepEqual(attempt(yield* introduction(fixture)), attempt(unknown), "the next run only observes the receipt: same state, identities, body and route");
}), {timeout: 10_000});

it.effect("S6b-CONV-08: a caller paused before an operative mode change never refuses over the unknown introduction a contactable caller recorded; after restored modes, Retry and a run it is not initiated again", () => Effect.gen(function* () {
  // a plan-mode Supervisor can contact a plan-mode operative only; both public runs found no introduction and pause at their
  // first operative read
  const fixture = yield* fixtureAt({supervisorInteractionMode: "plan"});
  fixture.operative.thread.interactionMode = "plan";
  const {arrivals, releases} = yield* holdReads(fixture, operativeThreadId, 2);
  fixture.intercept(call => isIntroduction(call) ? Effect.fail(new SupervisorRpcError("uncertain")) : null);
  const conversation = fixture.conversation;
  const first = yield* Effect.forkChild(conversation.run(yield* binding(fixture), fixture.supervisor, fixture.threadList));
  yield* within(Deferred.await(arrivals[0]!), 3_000, "the first run at its operative read");
  const second = yield* Effect.forkChild(conversation.run(yield* binding(fixture), fixture.supervisor, fixture.threadList));
  yield* within(Deferred.await(arrivals[1]!), 3_000, "the second run at its operative read");
  // the first run reads the plan-mode operative, posts and records an unknown outcome
  yield* Deferred.succeed(releases[0]!, undefined);
  yield* within(Fiber.join(first), 3_000, "the first run");
  const unknown = yield* introduction(fixture);
  // the operative's current mode is default, which the plan-mode Supervisor cannot contact: the second run's refusal is stale
  fixture.operative.thread.interactionMode = "default";
  yield* Deferred.succeed(releases[1]!, undefined);
  yield* within(Fiber.join(second), 3_000, "the second run");
  const afterStale = yield* introduction(fixture);
  // contactable modes again, then Retry and another public run
  fixture.supervisor.thread.interactionMode = "default";
  fixture.intercept(null);
  yield* fixture.conversation.retry(projectId, (yield* binding(fixture)).threadId);
  const afterRetry = yield* introduction(fixture);
  yield* within(conversation.run(yield* binding(fixture), fixture.supervisor, fixture.threadList), 3_000, "the next run");

  assert.equal(fixture.calls.filter(isIntroduction).length, 1, "one native initiation in total");
  assert.equal(unknown?.state, "uncertain");
  assert.deepEqual(afterStale, unknown, "the stale refusal leaves the unknown receipt exactly as recorded");
  assert.deepEqual(afterRetry, unknown, "Retry neither deletes nor resets the unknown receipt");
  assert.deepEqual(attempt(yield* introduction(fixture)), attempt(unknown), "the next run only observes the receipt: same state, identities, body and route");
}), {timeout: 10_000});

it.effect("S6b-CONV-09: after a stale refusal, Retry through ProjectSupervisor and its supervision pass keep the unknown introduction and initiate nothing", () => Effect.gen(function* () {
  const fixture = yield* fixtureAt();
  // the project is enabled for the supervisor's own scope predicates, with no activation anchor for the operative
  yield* fixture.projectStore.saveControl(projectId, (yield* fixture.projectStore.control(projectId)).generation, true, {snapshotSequence: 1, threads: []});
  const {unknown, afterStale} = yield* staleRefusalOverUnknown(fixture);
  const service = yield* fixture.makeProjectSupervisor;
  const current = yield* binding(fixture);
  const retried = yield* within(service.supervisor.retry({projectId, mainThreadId: operativeThreadId, expectedGeneration: (yield* fixture.projectStore.settings(projectId)).generation,
    threadId: current.threadId, bindingGeneration: current.generation, action: "retry"}), 3_000, "the retry");

  assert.equal(fixture.calls.filter(isIntroduction).length, 1, "one native initiation in total");
  assert.notEqual(retried.status, "conflict");
  assert.deepEqual(afterStale, unknown, "the stale refusal leaves the unknown receipt exactly as recorded");
  assert.deepEqual(attempt(yield* introduction(fixture)), attempt(unknown), "Retry and the supervision pass keep the receipt's state, identities, body and route");
}), {timeout: 10_000});

it.effect("S6b-CONV-10: a public run reconciling a stale copy of a check-in another run already completed commits nothing again", () => Effect.gen(function* () {
  // plan-mode Supervisor modes keep the introduction unsent; the prepared introduction holds each run at its last read
  const fixture = yield* fixtureAt({supervisorInteractionMode: "plan"});
  yield* fixture.requests.saveIntroduction({taskId: fixture.task.id, projectId, threadId: operativeThreadId, supervisorThreadId: fixture.binding.threadId,
    state: "ready", text: workflowIntroductionText(fixture.task), messageId: `supervisor-notice:workflow:${fixture.task.id}`, targetRunId: null, error: null});
  const prepared = yield* fixture.requests.prepare({projectId, supervisorThreadId: fixture.binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, baseTime);
  // the check-in as its dispatch recorded it: waiting, with its notice time
  const sent: ConversationRequest = {...prepared, state: "waiting", sentAt: baseTime};
  yield* fixture.requests.saveRequest(sent);
  yield* fixture.requests.noticeSent(fixture.binding.threadId, baseTime);
  // the check-in ran to completion without its marker, so it counts as one missed review
  const run = appendRun({projection: fixture.supervisor, id: "check-in-run", ordinal: 5, status: "completed", messageId: sent.messageId, text: sent.text, now: baseTime + 1});
  appendMessageToRun(fixture.supervisor, run, {id: "check-in-answer", role: "assistant", text: "Observed; no marker.", now: baseTime + 2});
  const conversation = fixture.conversation;
  const {arrivals, releases} = yield* holdReads(fixture, fixture.binding.threadId, 2);
  const fibers = yield* Effect.forEach([0, 1], () => Effect.flatMap(binding(fixture), (current) => Effect.forkChild(conversation.run(current, fixture.supervisor, fixture.threadList))));
  yield* within(Effect.forEach(arrivals, Deferred.await), 3_000, "both runs at their last read");
  assert.deepEqual(yield* fixture.requests.pending(projectId, fixture.binding.threadId), sent, "both runs read the same waiting check-in");
  yield* Deferred.succeed(releases[0]!, undefined);
  yield* within(Effect.raceAll(fibers.map(fiber => Fiber.await(fiber))), 3_000, "the released run");
  const completed = (yield* fixture.requests.requests(projectId, fixture.binding.threadId)).find(item => item.id === sent.id);
  assert.equal(completed?.state, "completed");
  assert.equal(yield* fixture.requests.reviewMisses(fixture.binding.threadId), 1);
  yield* Deferred.succeed(releases[1]!, undefined);
  yield* within(Effect.forEach(fibers, Fiber.join), 3_000, "both runs");

  assert.equal(yield* fixture.requests.reviewMisses(fixture.binding.threadId), 1, "the miss is counted once");
  assert.deepEqual((yield* fixture.requests.requests(projectId, fixture.binding.threadId)).find(item => item.id === sent.id), completed,
    "the completed check-in is not reverted or recommitted from the stale copy");
}), {timeout: 10_000});
