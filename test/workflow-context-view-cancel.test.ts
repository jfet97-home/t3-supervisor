import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { SupervisionGate, SupervisionScope, SupervisionScopeService } from "../src/supervision-gate.js";
import { SupervisorConversation } from "../src/supervisor-conversation.js";
import type { SupervisorConfig } from "../src/types.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "../src/workflow-write-controller.js";
import { abortOf, wallClock, within } from "./support/g1b-conversation.js";
import { baseTime, compactDraft, makeFixture, workflowRecord, type Fixture } from "./support/c1-conversation-fixture.js";

// target regressions of the workflow_read view "check" (S6b): the call's soft cancel, the caller's own or the 10 s tool
// deadline, reaches the definitions read of the production conversation as its abort signal, and the read's own outcome
// decides, as the baseline signal-bound read did: a read the abort fails is unavailable, a valid value it still completes with
// after the abort is used.
// the cases are Effect tests on the production write controller over the production conversation, admission gate and stores of
// a temporary directory; the tool deadline runs on the test clock, which stands at a fixed wall time after the fixture's times,
// as the baseline services read the real clock; the definitions read is held at the definitions service's native boundary, its
// abort signal

// the read scope of a verified Supervisor binding
class ReadScope extends SupervisionScope {
  override workflowEditingEnabled() {return Effect.succeed(true);}
  override supervisionStopped() {return Effect.succeed(false);}
}

const config: SupervisorConfig = {dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0};
const unusedNative = WorkflowNativeAccess.of({
  listThreads: () => Effect.die(new Error("no native read is expected")),
  projection: () => Effect.die(new Error("no native read is expected")),
  getTurnItem: () => Effect.die(new Error("no native read is expected")),
});

// the production write controller over the fixture's production conversation service, its stores and its admission gate
const controllerOf = (fixture: Fixture) => WorkflowWriteController.make({withoutTeam: true}).pipe(
  Effect.provideService(SupervisorConversation, fixture.conversation),
  Effect.provideService(SupervisionGate, fixture.process.gate),
  Effect.provideService(SupervisionScopeService, new ReadScope(config, {guidance: fixture.process.guidance, supervisors: fixture.projectStore, policy: fixture.threadPolicy}, true)),
  Effect.provideService(WorkflowNativeAccess, unusedNative),
  Effect.provide(fixture.process.context),
);

const fixtureScoped = Effect.andThen(TestClock.setTime(wallClock), makeFixture({now: baseTime}));

// the check of a valid compact draft of the fixture task
const checkInput = (fixture: Fixture) => Effect.map(fixture.projectStore.task(fixture.task.threadId), (stored) => {
  const task = stored!;
  return {supervisorThreadId: fixture.binding.threadId, bindingGeneration: fixture.binding.generation, view: "check",
    record: compactDraft(task, workflowRecord(task, "checked-proposal"))};
});

// the definitions read held at the boundary until its abort signal fires: then it fails, or still completes with the valid
// snapshot the fixture serves
const holdDefinitions = (fixture: Fixture, onAbort: "fail" | "complete") => Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const aborted = yield* Deferred.make<void>();
  fixture.fake.replaceDefinitions((projectId, threadId, signal) => Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined);
    yield* abortOf(signal);
    yield* Deferred.succeed(aborted, undefined);
    return onAbort === "fail" ? yield* Effect.die(new Error("definitions read aborted")) : fixture.fake.definitionsSnapshot(projectId, threadId);
  }));
  return {
    entered: within(Deferred.await(entered), 3_000, "the definitions read"),
    aborted: within(Deferred.await(aborted), 3_000, "the definitions read observing the call's cancel"),
    restore: Effect.sync(() => fixture.fake.replaceDefinitions(null)),
  };
});

it.effect("S6b-WWC-CTX-01: the caller's cancel fails an abort-observing definitions read of view check, which answers definitions_unavailable", () => Effect.gen(function* () {
  const fixture = yield* fixtureScoped;
  const read = yield* holdDefinitions(fixture, "fail");
  yield* Effect.addFinalizer(() => read.restore);
  const controller = yield* controllerOf(fixture);
  const cancel = yield* Deferred.make<void>();
  const call = yield* Effect.forkChild(controller.readTool(yield* checkInput(fixture), cancel));
  yield* read.entered;
  yield* Deferred.succeed(cancel, undefined);
  yield* read.aborted;
  assert.deepEqual(yield* Fiber.join(call), {status: "unavailable", view: "check", reason: "definitions_unavailable"});
}), {timeout: 10_000});

it.effect("S6b-WWC-CTX-02: the 10 s tool deadline fails an abort-observing definitions read of view check exactly at the deadline", () => Effect.gen(function* () {
  const fixture = yield* fixtureScoped;
  const read = yield* holdDefinitions(fixture, "fail");
  yield* Effect.addFinalizer(() => read.restore);
  const controller = yield* controllerOf(fixture);
  const call = yield* Effect.forkChild(controller.readTool(yield* checkInput(fixture)));
  yield* read.entered;
  yield* TestClock.adjust("9999 millis");
  assert.equal(call.pollUnsafe(), undefined, "the call is still reading before its deadline");
  yield* TestClock.adjust("1 millis");
  yield* read.aborted;
  assert.deepEqual(yield* Fiber.join(call), {status: "unavailable", view: "check", reason: "definitions_unavailable"});
}), {timeout: 10_000});

it.effect("S6b-WWC-CTX-03: a valid definitions read that still completes after the caller's cancel is used by view check", () => Effect.gen(function* () {
  const fixture = yield* fixtureScoped;
  const read = yield* holdDefinitions(fixture, "complete");
  yield* Effect.addFinalizer(() => read.restore);
  const controller = yield* controllerOf(fixture);
  const cancel = yield* Deferred.make<void>();
  const call = yield* Effect.forkChild(controller.readTool(yield* checkInput(fixture), cancel));
  yield* read.entered;
  yield* Deferred.succeed(cancel, undefined);
  yield* read.aborted;
  const result = yield* Fiber.join(call);
  assert.equal(result.status, "ok", "the late valid read is used");
  assert.equal((result as {proposalId?: string}).proposalId, "checked-proposal");
  assert.match(String((result as {digest?: string}).digest), /^[0-9a-f]{64}$/u);
}), {timeout: 10_000});
