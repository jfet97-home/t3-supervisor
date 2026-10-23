import assert from "node:assert/strict";
import { Effect, Exit } from "effect";
import { it } from "vitest";
import type { GateGuard, SupervisionGateShape } from "../src/supervision-gate.js";
import { after } from "./support/node-test.js";
import { makeNoProjectFixture } from "./support/c2-ps-b-fixture.js";
import { completeSupervisorRequest, deferred, makeFixture, missingDefinitions, reserveReadyBinding, retryInput, within, workflowResult, type Fixture } from "./support/c2-ps-fixture.js";
import type { ProjectSupervisorUnit } from "./support/team-units.js";

// target regressions (R26): a result, a root replacement or a Start preparation keeps its authority up to the step that commits
// it. Ordering is controlled through the actual shared admission section (a held permit and an entry barrier); no predicate,
// store write or result classification is replaced

const sourceTask = [{id: "task", sequence: 11, text: "Review the release."}];
const earlier = [{id: "old-turn", sequence: 1, text: "An earlier request before the activation boundary."}];
const stoppedReason = "Supervision was stopped for this chat; the interpretation result was not applied.";
const failedPreparation = "Start preparation failed before activation. Use a new explicit request after inspecting this outcome.";

// the shared admission section with its entry replaceable by an ordering barrier
type BarrierGate = {admit: SupervisionGateShape["admit"]};

// definitions whose next read, once armed, waits for its release: the revalidation read of a completed workflow interpretation
const heldDefinitions = () => {
  const state = {armed: false};
  const entered = deferred();
  const release = deferred();
  return {state, entered, release, loader: {load: async (projectId: string, threadId: string | null) => {
    if (state.armed) {state.armed = false;entered.resolve();await release.promise;}
    return missingDefinitions(projectId, threadId, "/work/a");
  }}};
};

// a dispatched interpretation whose native run has completed with a workflow result
const completedInterpretation = async (f: Fixture, supervisor: ProjectSupervisorUnit) => {
  await within(supervisor.runOnce(AbortSignal.timeout(5_000)), 5_000, "dispatching cycle");
  const task = f.supervisorStore.task("main")!;
  assert.equal(task.status, "waiting");
  completeSupervisorRequest(f.projections.get(task.supervisorThreadId)!, task.messageId, workflowResult("task", "Review the release", "A finite task."));
  return task;
};

// runs `caller` up to its held revalidation read, then holds the shared admission permit so that `write` and then the result's
// section queue for it in that order, and releases them; returns once every started piece of work has ended
const writeAheadOfResult = async (supervisor: ProjectSupervisorUnit, held: ReturnType<typeof heldDefinitions>, caller: () => Promise<unknown>,
  write: () => Promise<unknown>) => {
  const gate = supervisor.admission.gate as BarrierGate;
  const admit = gate.admit;
  const releaseHolder = deferred();
  const work: Promise<unknown>[] = [];
  try {
    held.state.armed = true;
    work.push(caller());
    await within(held.entered.promise, 5_000, "the revalidation read");
    const holding = deferred();
    work.push(Effect.runPromise(admit(() => Effect.andThen(Effect.sync(() => holding.resolve()), Effect.promise(() => releaseHolder.promise)))));
    await within(holding.promise, 5_000, "the held admission permit");
    const queued = [deferred(), deferred()];
    let entries = 0;
    gate.admit = <A, E, R>(body: (guard: GateGuard) => Effect.Effect<A, E, R>) => Effect.suspend(() => {queued[entries++]?.resolve();return admit(body);});
    work.push(write());
    await within(queued[0]!.promise, 5_000, "the write queued");
    held.release.resolve();
    await within(queued[1]!.promise, 5_000, "the result queued behind the write");
    releaseHolder.resolve();
    await within(Promise.all(work), 5_000, "every started call");
  } finally {
    held.release.resolve();
    releaseHolder.resolve();
    gate.admit = admit;
    await Promise.allSettled(work);
  }
};

for (const caller of ["cycle", "retry"] as const) {
  it(`a Stop admitted ahead of a completed interpretation's application closes it unapplied (${caller})`, {timeout: 10_000}, async t => {
    const f = await makeFixture([{threadId: "main", projectId: "project-a", turns: sourceTask}], {threadPolicy: true});
    after(t, f.cleanup);
    const held = heldDefinitions();
    const supervisor = f.makeSupervisor({definitions: held.loader});
    const task = await completedInterpretation(f, supervisor);
    const binding = f.supervisorStore.binding("project-a", "main")!;
    const run = f.projections.get(task.supervisorThreadId)!.runs.find(item => item.userMessageId === task.messageId)!;
    await writeAheadOfResult(supervisor, held,
      () => caller === "cycle" ? supervisor.runOnce(AbortSignal.timeout(8_000)) : supervisor.retry(retryInput("project-a", 0, binding, "retry"), AbortSignal.timeout(8_000)),
      () => Effect.runPromise(supervisor.supervisionControl.setChatPolicy("main", false, f.threadPolicy!.get().generation)));
    assert.equal(supervisor.supervisionStopped("main"), true);
    const closed = f.supervisorStore.task("main")!;
    assert.equal(closed.id, task.id, "the original task identity is retained");
    assert.equal(closed.status, "unavailable", "a result admitted after the Stop is not applied");
    assert.equal(closed.reason, stoppedReason);
    assert.equal(closed.objective, null);
    assert.equal(closed.supervisorRunId, run.id);
    assert.equal(closed.messageId, task.messageId);
    assert.equal(f.messageDispatches().length, 1, "nothing is sent after the interpretation");
  });
}

it("a project disable admitted ahead of a completed interpretation's application leaves it unapplied and in flight", {timeout: 10_000}, async t => {
  const f = await makeFixture([{threadId: "main", projectId: "project-a", turns: sourceTask}], {threadPolicy: true});
  after(t, f.cleanup);
  const held = heldDefinitions();
  const supervisor = f.makeSupervisor({definitions: held.loader});
  const task = await completedInterpretation(f, supervisor);
  let saved: unknown;
  await writeAheadOfResult(supervisor, held, () => supervisor.runOnce(AbortSignal.timeout(8_000)),
    async () => {saved = await supervisor.saveControl({projectId: "project-a", expectedGeneration: f.supervisorStore.control("project-a").generation, enabled: false}, AbortSignal.timeout(5_000));});
  assert.equal((saved as {status: string}).status, "saved");
  const retained = f.supervisorStore.task("main")!;
  assert.equal(retained.id, task.id);
  assert.equal(retained.status, "waiting", "a result admitted after the disable is not applied");
  assert.equal(retained.objective, null);
  assert.equal(f.messageDispatches().length, 1);
});

for (const write of ["Stop", "disable"] as const) {
  it(`a missing-root replacement refused by a ${write} admitted ahead of it leaves the retained root and its tasks untouched`, {timeout: 10_000}, async t => {
    const f = await makeFixture([{threadId: "main", projectId: "project-a", turns: earlier}], {threadPolicy: true});
    after(t, f.cleanup);
    const supervisor = f.makeSupervisor();
    const ready = reserveReadyBinding(f, "main");
    const missing = {...ready, state: "missing" as const};
    f.supervisorStore.setBinding(missing);
    f.projections.delete(missing.threadId);
    f.supervisorStore.saveTask({id: "retained-task", threadId: "main", projectId: "project-a", sourceRunId: "run-old-turn", sourceMessageId: "old-turn", sourceOrdinal: 1,
      sourceHash: "hash", status: "queued", objective: null, reason: "Waiting for the project Supervisor.", updatedAt: 1, requestText: "Retained request.",
      supervisorThreadId: missing.threadId, messageId: "supervisor-objective:retained-task", supervisorRunId: null, dispatchedAt: null, replayCount: 0});
    const taskBefore = f.supervisorStore.task("main");
    const ownedBefore = [...f.supervisorStore.ownedIds];
    const gate = supervisor.admission.gate as BarrierGate;
    const admit = gate.admit;
    const reached = deferred();
    const release = deferred();
    let entries = 0;
    let retry: Promise<unknown> | undefined;
    try {
      // the retry's second section is its replacement: it waits at that section's entry until the other write has committed
      gate.admit = <A, E, R>(body: (guard: GateGuard) => Effect.Effect<A, E, R>) => {
        entries += 1;
        if (entries !== 2) return admit(body);
        return Effect.andThen(Effect.promise(() => {reached.resolve();return release.promise;}), admit(body));
      };
      retry = supervisor.retry(retryInput("project-a", 0, missing, "replace"), AbortSignal.timeout(8_000));
      await within(reached.promise, 5_000, "the replacement section");
      if (write === "Stop") assert.equal((await Effect.runPromise(supervisor.supervisionControl.setChatPolicy("main", false, f.threadPolicy!.get().generation))).status, "saved");
      else assert.equal((await supervisor.saveControl({projectId: "project-a", expectedGeneration: f.supervisorStore.control("project-a").generation, enabled: false},
        AbortSignal.timeout(5_000))).status, "saved");
      release.resolve();
      const outcome = await within(retry, 5_000, "the refused replacement");
      const retained = f.supervisorStore.binding("project-a", "main")!;
      assert.deepEqual({threadId: retained.threadId, generation: retained.generation, state: retained.state},
        {threadId: missing.threadId, generation: missing.generation, state: "missing"}, "the retained root identity is unchanged");
      assert.deepEqual(f.supervisorStore.task("main"), taskBefore, "the retained task is unchanged");
      assert.deepEqual([...f.supervisorStore.ownedIds], ownedBefore, "no replacement identity was reserved");
      assert.equal(f.launches().length, 0);
      // the answer is true: nothing was replaced
      assert.deepEqual(outcome, {status: "unavailable", message: "Supervision was disabled before replacement; retained work was left unchanged.", snapshot: null});
    } finally {
      release.resolve();
      gate.admit = admit;
      if (retry) await Promise.allSettled([retry]);
    }
  });
}

for (const route of ["dashboard", "agent"] as const) {
  it(`an interruption arriving with the durable ${route} Start preparation finishes its receipt and a repeat answers from it`, {timeout: 10_000}, async t => {
    const f = await makeFixture([{threadId: "main", projectId: "project-a", turns: earlier}], {threadPolicy: true});
    after(t, f.cleanup);
    const supervisor = f.makeSupervisor();
    const control = supervisor.supervisionControl;
    const operationId = `cut-${route}-start`;
    const start = () => route === "dashboard" ? control.dashboardStart("main", operationId)
      : control.startSupervision({callerThreadId: "main", userMessageId: "old-turn", operationId}, {runId: "run-old-turn"});
    const store = f.supervisorStore;
    const save = store.saveStartOperation.bind(store);
    const cancel = new AbortController();
    let cut = false;
    // the caller is interrupted exactly on the durable preparation write
    store.saveStartOperation = (value) => {save(value);if (value.preparing && !cut) {cut = true;cancel.abort();}};
    const exit = await within(Effect.runPromiseExit(Effect.andThen(Effect.yieldNow, start()), {signal: cancel.signal}), 5_000, "the interrupted Start");
    store.saveStartOperation = save;
    assert.equal(cut, true);
    assert.equal(Exit.isFailure(exit), true, "the interrupted caller ends without a result");
    const receipt = store.startOperation("main", operationId);
    assert.notEqual(receipt?.preparing, true, "the preparation claim is finished by its owner");
    assert.deepEqual({status: receipt?.status, reason: receipt?.reason}, {status: "unavailable", reason: failedPreparation});
    assert.deepEqual(await Effect.runPromise(start()), {status: "unavailable", reason: failedPreparation}, "a same-operation repeat answers from the receipt");
    assert.deepEqual(control.startStatus("main", operationId), {threadId: "main", operationId, status: "unavailable", reason: failedPreparation});
    assert.equal(store.start("main"), null, "no Start permission was reserved");
    assert.equal(f.operations.length, 0, "no native call");
  });
}

it("an interruption arriving inside the admitted Start activation keeps the decided outcome on its receipt", {timeout: 10_000}, async t => {
  const f = await makeNoProjectFixture();
  after(t, f.cleanup);
  const control = f.supervisor.supervisionControl;
  const store = f.fixture.supervisorStore;
  const saveStart = store.saveStart.bind(store);
  const cancel = new AbortController();
  let cut = false;
  // the caller is interrupted on the Start record written inside the admitted section; the section completes its activation
  store.saveStart = (value) => {saveStart(value);if (!cut) {cut = true;cancel.abort();}};
  const exit = await within(Effect.runPromiseExit(Effect.andThen(Effect.yieldNow, control.dashboardStart("manual", "cut-activation")), {signal: cancel.signal}),
    5_000, "the interrupted activation");
  store.saveStart = saveStart;
  assert.equal(cut, true);
  assert.equal(Exit.isFailure(exit), true);
  const activated = store.start("manual")!;
  assert.equal(activated.status, "active", "the admitted activation stands");
  const receipt = store.startOperation("manual", "cut-activation");
  assert.notEqual(receipt?.preparing, true);
  assert.deepEqual({status: receipt?.status, reason: receipt?.reason}, {status: "active", reason: activated.reason}, "the receipt records the decided outcome");
  assert.deepEqual(await Effect.runPromise(control.dashboardStart("manual", "cut-activation")), {status: "active", reason: activated.reason});
  assert.equal(f.policy.get().excludedThreadIds.includes("manual"), false);
});
