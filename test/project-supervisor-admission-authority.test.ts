import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import type { GateGuard, SupervisionGateShape } from "../src/supervision-gate.js";
import type { ProjectSupervisorStore } from "../src/project-supervisor-store.js";
import { completeSupervisorRequest, retryInput, submitInterpretation, workflowFields } from "./support/psx-submission.js";
import { makeFixture, makeNoProjectFixture, missingDefinitions, type DefinitionsLoader, type PsxFixture, type PsxSupervisor } from "./support/psx-supervisor.js";

// target regressions (R26): a result, a root replacement or a Start preparation keeps its authority up to the step that commits
// it. Ordering is controlled through the actual shared admission section (a held permit and an entry barrier); no predicate,
// store write or result classification is replaced.
// it.live: every case opens real sqlite files. The per-call deadlines are gone; the 10s vitest timeout is the hang guard.

const sourceTask = [{id: "task", sequence: 11, text: "Review the release."}];
const earlier = [{id: "old-turn", sequence: 1, text: "An earlier request before the activation boundary."}];
const stoppedReason = "Supervision was stopped for this chat; the interpretation result was not applied.";
const failedPreparation = "Start preparation failed before activation. Use a new explicit request after inspecting this outcome.";

// the shared admission section with its entry replaceable by an ordering barrier
type BarrierGate = {admit: SupervisionGateShape["admit"]};

// definitions whose next read, once armed, waits for its release: the revalidation read of a completed workflow interpretation
const heldDefinitions = () => Effect.gen(function* () {
  const state = {armed: false};
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const loader: DefinitionsLoader = {load: (projectId, threadId) => Effect.gen(function* () {
    if (state.armed) {state.armed = false; yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release);}
    return missingDefinitions(projectId, threadId, "/work/a");
  })};
  return {state, entered, release, loader};
});

// a dispatched interpretation whose native run has completed with a workflow result
const completedInterpretation = (f: PsxFixture, supervisor: PsxSupervisor) => Effect.gen(function* () {
  yield* supervisor.cycle;
  const task = (yield* f.supervisorStore.task("main"))!;
  assert.equal(task.status, "waiting");
  assert.equal((yield* submitInterpretation({...f.stores, workflows: f.workflows, projections: f.projections}, task, workflowFields("task", "Review the release", "A finite task."))).status, "submitted");
  completeSupervisorRequest(f.projections.get(task.supervisorThreadId)!, task.messageId, "Submitted the interpretation.");
  return task;
});

// runs `caller` up to its held revalidation read, then holds the shared admission permit so that `write` and then the result's
// section queue for it in that order, and releases them; returns once every started piece of work has ended
const writeAheadOfResult = (supervisor: PsxSupervisor, held: Effect.Success<ReturnType<typeof heldDefinitions>>, caller: Effect.Effect<unknown, unknown>,
  write: Effect.Effect<unknown, unknown>) => Effect.gen(function* () {
  const gate = supervisor.admission.gate as BarrierGate;
  const admit = gate.admit;
  const releaseHolder = yield* Deferred.make<void>();
  const work: Array<Fiber.Fiber<unknown, unknown>> = [];
  yield* Effect.ensuring(Effect.gen(function* () {
    held.state.armed = true;
    work.push(yield* Effect.forkChild(caller));
    yield* Deferred.await(held.entered);
    const holding = yield* Deferred.make<void>();
    work.push(yield* Effect.forkChild(admit(() => Effect.andThen(Deferred.succeed(holding, undefined), Deferred.await(releaseHolder)))));
    yield* Deferred.await(holding);
    const queued = [yield* Deferred.make<void>(), yield* Deferred.make<void>()] as const;
    let entries = 0;
    gate.admit = <A, E, R>(body: (guard: GateGuard) => Effect.Effect<A, E, R>) => Effect.suspend(() => {
      const slot = queued[entries++];
      if (slot) Deferred.doneUnsafe(slot, Effect.void);
      return admit(body);
    });
    work.push(yield* Effect.forkChild(write));
    yield* Deferred.await(queued[0]);
    yield* Deferred.succeed(held.release, undefined);
    yield* Deferred.await(queued[1]);
    yield* Deferred.succeed(releaseHolder, undefined);
    yield* Effect.forEach(work, (fiber) => Fiber.join(fiber), {concurrency: "unbounded", discard: true});
  }), Effect.sync(() => {
    Deferred.doneUnsafe(held.release, Effect.void);
    Deferred.doneUnsafe(releaseHolder, Effect.void);
    gate.admit = admit;
  })).pipe(Effect.ensuring(Effect.forEach(work, (fiber) => Fiber.await(fiber), {concurrency: "unbounded", discard: true})));
});

// interrupts the caller from inside the preparation or activation write, after that write has committed.
// the interrupt is detached so the uninterruptible claim can finish at its interruptible point.
const interruptOn = <A>(store: ProjectSupervisorStore["Service"], method: "saveStartOperation" | "saveStart", when: (value: A) => boolean) => {
  const mutable = store as unknown as Record<typeof method, (value: A) => Effect.Effect<void>>;
  const original = mutable[method];
  let cut = false;
  mutable[method] = (value) => original(value).pipe(Effect.tap(() => Effect.gen(function* () {
    if (!when(value) || cut) return;
    cut = true;
    // the baseline aborted the run signal here, synchronously, so the pending interrupt waits out the uninterruptible claim
    const current = yield* Effect.fiber;
    current.interruptUnsafe();
  })));
  return {get cut() {return cut;}, restore: () => Effect.sync(() => {mutable[method] = original;})};
};

for (const caller of ["cycle", "retry"] as const) {
  it.live(`a Stop admitted ahead of a completed interpretation's application closes it unapplied (${caller})`, () => Effect.gen(function* () {
    const f = yield* makeFixture([{threadId: "main", projectId: "project-a", turns: sourceTask}], {threadPolicy: true});
    const held = yield* heldDefinitions();
    const supervisor = yield* f.makeSupervisor({definitions: held.loader});
    const task = yield* completedInterpretation(f, supervisor);
    const binding = (yield* f.supervisorStore.binding("project-a", "main"))!;
    const run = f.projections.get(task.supervisorThreadId)!.runs.find(item => item.userMessageId === task.messageId)!;
    yield* writeAheadOfResult(supervisor, held, Effect.gen(function* () {
      if (caller === "cycle") yield* supervisor.cycle;
      else yield* supervisor.retry(retryInput("project-a", 0, binding, "retry"));
    }),
      Effect.gen(function* () {
        const generation = (yield* f.stores.policy.get()).generation;
        yield* supervisor.supervisionControl.setChatPolicy("main", false, generation);
      }));
    assert.equal(yield* supervisor.supervisionStopped("main"), true);
    const closed = (yield* f.supervisorStore.task("main"))!;
    assert.equal(closed.id, task.id, "the original task identity is retained");
    assert.equal(closed.status, "unavailable", "a result admitted after the Stop is not applied");
    assert.equal(closed.reason, stoppedReason);
    assert.equal(closed.objective, null);
    assert.equal(closed.supervisorRunId, run.id);
    assert.equal(closed.messageId, task.messageId);
    assert.equal(f.messageDispatches().length, 1, "nothing is sent after the interpretation");
  }), {timeout: 10_000});
}

it.live("a project disable admitted ahead of a completed interpretation's application leaves it unapplied and in flight", () => Effect.gen(function* () {
  const f = yield* makeFixture([{threadId: "main", projectId: "project-a", turns: sourceTask}], {threadPolicy: true});
  const held = yield* heldDefinitions();
  const supervisor = yield* f.makeSupervisor({definitions: held.loader});
  const task = yield* completedInterpretation(f, supervisor);
  let saved: unknown;
  yield* writeAheadOfResult(supervisor, held, supervisor.cycle, Effect.gen(function* () {
    const generation = (yield* f.supervisorStore.control("project-a")).generation;
    saved = yield* supervisor.saveControl({projectId: "project-a", expectedGeneration: generation, enabled: false});
  }));
  assert.equal((saved as {status: string}).status, "saved");
  const retained = (yield* f.supervisorStore.task("main"))!;
  assert.equal(retained.id, task.id);
  assert.equal(retained.status, "waiting", "a result admitted after the disable is not applied");
  assert.equal(retained.objective, null);
  assert.equal(f.messageDispatches().length, 1);
}), {timeout: 10_000});

for (const write of ["Stop", "disable"] as const) {
  it.live(`a missing-root replacement refused by a ${write} admitted ahead of it leaves the retained root and its tasks untouched`, () => Effect.gen(function* () {
    const f = yield* makeFixture([{threadId: "main", projectId: "project-a", turns: earlier}], {threadPolicy: true});
    const supervisor = yield* f.makeSupervisor();
    const ready = yield* f.reserveReadyBinding("main");
    const missing = {...ready, state: "missing" as const};
    yield* f.supervisorStore.setBinding(missing);
    f.projections.delete(missing.threadId);
    yield* f.supervisorStore.saveTask({id: "retained-task", threadId: "main", projectId: "project-a", sourceRunId: "run-old-turn", sourceMessageId: "old-turn", sourceOrdinal: 1,
      sourceHash: "hash", status: "queued", objective: null, reason: "Waiting for the project Supervisor.", updatedAt: 1, requestText: "Retained request.",
      supervisorThreadId: missing.threadId, messageId: "supervisor-objective:retained-task", supervisorRunId: null, dispatchedAt: null, replayCount: 0});
    const taskBefore = yield* f.supervisorStore.task("main");
    const ownedBefore = [...f.supervisorStore.ownedIds];
    const gate = supervisor.admission.gate as BarrierGate;
    const admit = gate.admit;
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let entries = 0;
    let retry: Fiber.Fiber<unknown, unknown> | undefined;
    yield* Effect.ensuring(Effect.gen(function* () {
      // the retry's second section is its replacement: it waits at that section's entry until the other write has committed
      gate.admit = <A, E, R>(body: (guard: GateGuard) => Effect.Effect<A, E, R>) => {
        entries += 1;
        if (entries !== 2) return admit(body);
        return Effect.andThen(Effect.gen(function* () {yield* Deferred.succeed(reached, undefined); return yield* Deferred.await(release);}), admit(body));
      };
      retry = yield* Effect.forkChild(supervisor.retry(retryInput("project-a", 0, missing, "replace")));
      yield* Deferred.await(reached);
      if (write === "Stop") assert.equal((yield* supervisor.supervisionControl.setChatPolicy("main", false, (yield* f.stores.policy.get()).generation)).status, "saved");
      else assert.equal((yield* supervisor.saveControl({projectId: "project-a", expectedGeneration: (yield* f.supervisorStore.control("project-a")).generation, enabled: false})).status, "saved");
      yield* Deferred.succeed(release, undefined);
      const outcome = yield* Fiber.join(retry);
      const retained = (yield* f.supervisorStore.binding("project-a", "main"))!;
      assert.deepEqual({threadId: retained.threadId, generation: retained.generation, state: retained.state},
        {threadId: missing.threadId, generation: missing.generation, state: "missing"}, "the retained root identity is unchanged");
      assert.deepEqual(yield* f.supervisorStore.task("main"), taskBefore, "the retained task is unchanged");
      assert.deepEqual([...f.supervisorStore.ownedIds], ownedBefore, "no replacement identity was reserved");
      assert.equal(f.launches().length, 0);
      // the answer is true: nothing was replaced
      assert.deepEqual(outcome, {status: "unavailable", message: "Supervision was disabled before replacement; retained work was left unchanged.", snapshot: null});
    }), Effect.gen(function* () {
      yield* Deferred.succeed(release, undefined);
      gate.admit = admit;
      if (retry) yield* Fiber.await(retry);
    }));
  }), {timeout: 10_000});
}

// r29: a root changed by another writer before the replacement's section is answered as the declared conflict, before any
// team read of the stale binding, and nothing of the retained root or its tasks changes
it.live("a missing-root replacement whose retained root changed before its section answers conflict and changes nothing", () => Effect.gen(function* () {
  const f = yield* makeFixture([{threadId: "main", projectId: "project-a", turns: earlier}], {threadPolicy: true});
  const supervisor = yield* f.makeSupervisor();
  const ready = yield* f.reserveReadyBinding("main");
  const missing = {...ready, state: "missing" as const};
  yield* f.supervisorStore.setBinding(missing);
  f.projections.delete(missing.threadId);
  yield* f.supervisorStore.saveTask({id: "retained-task", threadId: "main", projectId: "project-a", sourceRunId: "run-old-turn", sourceMessageId: "old-turn", sourceOrdinal: 1,
    sourceHash: "hash", status: "queued", objective: null, reason: "Waiting for the project Supervisor.", updatedAt: 1, requestText: "Retained request.",
    supervisorThreadId: missing.threadId, messageId: "supervisor-objective:retained-task", supervisorRunId: null, dispatchedAt: null, replayCount: 0});
  const taskBefore = yield* f.supervisorStore.task("main");
  const ownedBefore = [...f.supervisorStore.ownedIds];
  const gate = supervisor.admission.gate as BarrierGate;
  const admit = gate.admit;
  const reached = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let entries = 0;
  let retry: Fiber.Fiber<unknown, unknown> | undefined;
  yield* Effect.ensuring(Effect.gen(function* () {
    gate.admit = <A, E, R>(body: (guard: GateGuard) => Effect.Effect<A, E, R>) => {
      entries += 1;
      if (entries !== 2) return admit(body);
      return Effect.andThen(Effect.gen(function* () {yield* Deferred.succeed(reached, undefined); return yield* Deferred.await(release);}), admit(body));
    };
    retry = yield* Effect.forkChild(supervisor.retry(retryInput("project-a", 0, missing, "replace")));
    yield* Deferred.await(reached);
    // another writer advances the retained root while the replacement waits at its section
    const advanced = {...missing, generation: missing.generation + 1};
    yield* f.supervisorStore.setBinding(advanced);
    yield* Deferred.succeed(release, undefined);
    const outcome = yield* Fiber.join(retry);
    assert.deepEqual(outcome, {status: "conflict", message: "The conversation state changed. Refresh and choose the intended recovery action again.", snapshot: null},
      "the changed root is the declared conflict");
    const retained = (yield* f.supervisorStore.binding("project-a", "main"))!;
    assert.deepEqual({threadId: retained.threadId, generation: retained.generation, state: retained.state},
      {threadId: advanced.threadId, generation: advanced.generation, state: "missing"}, "the other writer's root is unchanged");
    assert.deepEqual(yield* f.supervisorStore.task("main"), taskBefore, "the retained task is unchanged");
    assert.deepEqual([...f.supervisorStore.ownedIds], ownedBefore, "no replacement identity was reserved");
    assert.equal(f.launches().length, 0);
  }), Effect.gen(function* () {
    yield* Deferred.succeed(release, undefined);
    gate.admit = admit;
    if (retry) yield* Fiber.await(retry);
  }));
}), {timeout: 10_000});

for (const route of ["dashboard", "agent"] as const) {
  it.live(`an interruption arriving with the durable ${route} Start preparation finishes its receipt and a repeat answers from it`, () => Effect.gen(function* () {
    const f = yield* makeFixture([{threadId: "main", projectId: "project-a", turns: earlier}], {threadPolicy: true});
    const supervisor = yield* f.makeSupervisor();
    const control = supervisor.supervisionControl;
    const operationId = `cut-${route}-start`;
    const start = () => route === "dashboard" ? control.dashboardStart("main", operationId)
      : control.startSupervision({callerThreadId: "main", userMessageId: "old-turn", operationId}, {runId: "run-old-turn"});
    const store = f.supervisorStore;
    // the caller is interrupted exactly on the durable preparation write
    const cut = interruptOn(store, "saveStartOperation", (value: {preparing?: boolean}) => value.preparing === true);
    // the start runs on its own fiber, as runPromiseExit did, so the interruption ends that fiber and not the test
    const started = yield* Effect.forkDetach(Effect.andThen(Effect.yieldNow, start()));
    const exit = yield* Fiber.await(started);
    yield* cut.restore();
    assert.equal(cut.cut, true);
    assert.equal(Exit.isFailure(exit), true, "the interrupted caller ends without a result");
    const receipt = yield* store.startOperation("main", operationId);
    assert.notEqual(receipt?.preparing, true, "the preparation claim is finished by its owner");
    assert.deepEqual({status: receipt?.status, reason: receipt?.reason}, {status: "unavailable", reason: failedPreparation});
    assert.deepEqual(yield* start(), {status: "unavailable", reason: failedPreparation}, "a same-operation repeat answers from the receipt");
    assert.deepEqual(yield* control.startStatus("main", operationId), {threadId: "main", operationId, status: "unavailable", reason: failedPreparation});
    assert.equal(yield* store.start("main"), null, "no Start permission was reserved");
    assert.equal(f.operations.length, 0, "no native call");
  }), {timeout: 10_000});
}

it.live("an interruption arriving inside the admitted Start activation keeps the decided outcome on its receipt", () => Effect.gen(function* () {
  const f = yield* makeNoProjectFixture();
  const control = f.supervisor.supervisionControl;
  const store = f.fixture.supervisorStore;
  // the caller is interrupted on the Start record written inside the admitted section; the section completes its activation
  const cut = interruptOn(store, "saveStart", () => true);
  const started = yield* Effect.forkDetach(Effect.andThen(Effect.yieldNow, control.dashboardStart("manual", "cut-activation")));
  const exit = yield* Fiber.await(started);
  yield* cut.restore();
  assert.equal(cut.cut, true);
  assert.equal(Exit.isFailure(exit), true);
  const activated = (yield* store.start("manual"))!;
  assert.equal(activated.status, "active", "the admitted activation stands");
  const receipt = yield* store.startOperation("manual", "cut-activation");
  assert.notEqual(receipt?.preparing, true);
  assert.deepEqual({status: receipt?.status, reason: receipt?.reason}, {status: "active", reason: activated.reason}, "the receipt records the decided outcome");
  assert.deepEqual(yield* control.dashboardStart("manual", "cut-activation"), {status: "active", reason: activated.reason});
  assert.equal((yield* f.policy.get()).excludedThreadIds.includes("manual"), false);
}), {timeout: 10_000});
