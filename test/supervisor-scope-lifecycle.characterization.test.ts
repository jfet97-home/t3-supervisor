import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { GuidanceDb } from "../src/db.js";
import { GuidanceStoreError } from "../src/guidance-sql.js";
import { defaultSupervisorModel, prepareStopNotice } from "../src/project-supervisor-store.js";
import { SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import type { SupervisorRpcError } from "../src/supervisor-native.js";
import { T3TransportError } from "../src/t3.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import {
  constructSupervisorStore, lifecycleOver, openGuidanceClient, openLifecycleProcess, stopChat, wallClock, type LifecycleProcess, type OperateCall,
  type ProjectionRead,
} from "./support/g12-lifecycle.js";
import { execute, query, temporaryDirectory } from "./support/g12-stores.js";

// Effect tests on the production lifecycle, conversation, admission gate, scope predicates and stores over real files in a
// temporary directory, under the test clock: a check's `now` is the clock's wall time, set before the check. A check that the
// baseline aborted through its signal is interrupted; the baseline per-call 3 s deadlines are gone with the signal parameter and
// the promises they bounded, the tests' own 10 s bound covers a hang

const thread = (id: string): ThreadInfo => ({id, title: id, projectId: "p", lineage: {parentThreadId: null, relationshipToParent: null, rootThreadId: id}});

type Settle = {payload: Record<string, unknown>};

// an effect run at the wall time `now` of the test clock
const at = <A, E, R>(now: number, effect: Effect.Effect<A, E, R>) => Effect.andThen(TestClock.setTime(now), effect);

// the baseline suite's lifecycle fixture with held settle sends and main reads, and a second process on the same files
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(wallClock);
  const directory = yield* temporaryDirectory("c1-lifecycle-");
  const projections = new Map<string, Projection>();
  const calls: Settle[] = [];
  let holdSettle: ((call: Settle) => Effect.Effect<unknown, SupervisorRpcError> | null) | null = null;
  let holdMainRead: (() => Effect.Effect<void> | null) | null = null;
  let settledTarget: Projection | null = null;
  const project: ProjectionRead = (id) => Effect.gen(function* () {
    if (id === "main") {const held = holdMainRead?.() ?? null;if (held) yield* held;}
    const p = projections.get(id);if (!p) return yield* new T3TransportError("T3 thread projection is unavailable");return p;
  });
  const rpc: OperateCall = (_tag, payload) => {
    const call = {payload};calls.push(call);
    const held = holdSettle?.(call) ?? null;
    if (held) return held;
    settledTarget!.thread.settledAt = "2026-10-14T10:02:00Z";settledTarget!.thread.settledOverride = "settled";return Effect.succeed({sequence: 11});
  };
  // the same native side for every process the test opens on these files; the per-chat stop is the thread policy in the same
  // directory, so a second process reads it too
  const natives = {read: project, rpc};
  const process = yield* openLifecycleProcess(directory, natives);
  const {store} = process;
  yield* store.baseline({snapshotSequence: 10, threads: []});
  const binding = {...(yield* store.reserve("p", "main", "Main", defaultSupervisorModel, 10, 1)), state: "ready" as const};yield* store.setBinding(binding);
  // the project's supervision is enabled with the run's baseline, so its scope predicates admit it
  yield* store.saveControl("p", 0, true, (yield* store.baseline())!);
  const main: Projection = {thread: thread("main"), runs: [{id: "run", ordinal: 1, status: "completed", requestedAt: "2026-10-14T10:00:00Z", startedAt: "2026-10-14T10:00:00Z", completedAt: "2026-10-14T10:01:00Z", rootNodeId: "root"}], messages: [], runtimeRequests: [], subagents: []};
  const supervisor: Projection = {thread: thread(binding.threadId), runs: [], messages: [], runtimeRequests: [], subagents: []};settledTarget = supervisor;
  projections.set("main", main);projections.set(binding.threadId, supervisor);
  const threads = [main.thread, supervisor.thread];
  yield* store.saveTask({id: "task", projectId: "p", threadId: "main", sourceRunId: "run", sourceMessageId: "source", sourceHash: "hash", sourceOrdinal: 1, supervisorThreadId: binding.threadId,
    messageId: "interpretation", status: "inferred", objective: "Implement", reason: "Requested", updatedAt: 1, requestText: "", dispatchedAt: null, supervisorRunId: null, replayCount: 0});
  return {directory, process, sql: process.sql, store, binding, main, supervisor, threads, calls,
    settles: () => calls.filter(call => call.payload.type === "thread.settle"),
    stop: stopChat(process, "main"),
    // the next settle's reply never arrives: an aborted check interrupts it, a crash leaves it in flight; completes once it is sent
    holdSettle: Effect.gen(function* () {
      const reached = yield* Deferred.make<Settle>();
      holdSettle = call => Effect.andThen(Deferred.succeed(reached, call), Effect.never);
      return reached;
    }),
    release: () => {holdSettle = null;},
    holdMainRead: (gate: Deferred.Deferred<void>) => Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      holdMainRead = () => {holdMainRead = null;return Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(gate));};
      return reached;
    }),
    check: (now: number, target: LifecycleProcess = process) => at(now, Effect.flatMap(target.store.binding("p", "main"), (current) => target.lifecycle.check(current!, threads))),
    reopen: openLifecycleProcess(directory, natives),
  };
});

it.effect("CT-LIFE-01: aborting the settle dispatch saves it 'uncertain' with attempts=1 and the next eligible check reuses its commandId", () => Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.check(10);
  const reached = yield* f.holdSettle;
  const checking = yield* Effect.forkScoped(f.check(10 + SUPERVISOR_SETTLE_QUIET_MS));
  const call = yield* Deferred.await(reached);
  const pending = (yield* f.store.binding("p", "main"))?.settlement;
  assert.ok(pending);
  assert.deepEqual({state: pending.state, attempts: pending.attempts, observedAt: pending.observedAt}, {state: "pending", attempts: 1, observedAt: 10 + SUPERVISOR_SETTLE_QUIET_MS});
  assert.equal(call.payload.commandId, pending.commandId);
  yield* Fiber.interrupt(checking);
  assert.deepEqual((yield* f.store.binding("p", "main"))?.settlement, {...pending, state: "uncertain"});

  f.release();
  yield* f.check(10 + 2 * SUPERVISOR_SETTLE_QUIET_MS);
  assert.deepEqual(f.settles().map(settle => settle.payload.commandId), [pending.commandId, pending.commandId]);
  assert.equal((yield* f.store.binding("p", "main"))?.settlement?.attempts, 2);
  assert.equal((yield* f.store.binding("p", "main"))?.settlement?.state, "settled");
}), {timeout: 10_000});

it.effect("CT-LIFE-01: a crash during the settle dispatch keeps it 'pending' with attempts=1; a new process reuses its commandId", () => Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.check(10);
  const reached = yield* f.holdSettle;
  // the abandoned check is interrupted with the test scope, before the crashed process's services close
  yield* Effect.forkScoped(f.check(10 + SUPERVISOR_SETTLE_QUIET_MS));
  const call = yield* Deferred.await(reached);
  const pending = (yield* f.store.binding("p", "main"))?.settlement;
  assert.ok(pending?.state === "pending" && pending.attempts === 1);
  yield* f.process.crash;

  f.release();
  const restarted = yield* f.reopen;
  assert.deepEqual((yield* restarted.store.binding("p", "main"))?.settlement, pending);
  yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS + 1, restarted);
  assert.deepEqual(f.settles().map(settle => settle.payload.commandId), [call.payload.commandId, call.payload.commandId]);
  assert.deepEqual((yield* restarted.store.binding("p", "main"))?.settlement, {...pending, attempts: 2, observedAt: 10 + SUPERVISOR_SETTLE_QUIET_MS + 1, state: "settled"});
}), {timeout: 10_000});

it.effect("CT-LIFE-02: a stop committed while check() awaits its main read survives the stale binding write, and the next check takes the stopped path", () => Effect.gen(function* () {
  const f = yield* fixture;
  const gate = yield* Deferred.make<void>();
  yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
  const reached = yield* f.holdMainRead(gate);
  const checking = yield* Effect.forkScoped(f.check(10));
  yield* Deferred.await(reached);
  const current = (yield* f.store.binding("p", "main"))!;
  const stop = {route: "ui" as const, callerThreadId: null, userMessageId: null, stoppedAt: 5};
  yield* f.store.setSupervisionStop(current, stop);
  yield* f.store.setStopNotice(current, null, yield* prepareStopNotice(f.process.ids, current, 5, null));
  const committed = (yield* f.store.binding("p", "main"))!;
  yield* f.stop;
  yield* Deferred.succeed(gate, undefined);
  yield* Fiber.join(checking);
  const merged = (yield* f.store.binding("p", "main"))!;
  assert.equal(merged.quietSince, 10, "the stale lifecycle write landed");
  assert.deepEqual(merged.supervisionStop, stop);
  assert.deepEqual(merged.stopNotice, committed.stopNotice);
  assert.deepEqual(f.settles(), []);

  yield* f.check(20);
  assert.deepEqual(f.settles().map(settle => settle.payload.threadId), [f.binding.threadId]);
  assert.equal((yield* f.store.binding("p", "main"))?.settlement?.state, "settled");
  assert.deepEqual((yield* f.store.binding("p", "main"))?.supervisionStop, stop);
}), {timeout: 10_000});

it.effect("CT-LIFE-03: settlement starts exactly at quietSince+60000 and an uncertain one retries exactly at observedAt+60000, never a fourth time", () => Effect.gen(function* () {
  const f = yield* fixture;
  // T3 accepts every settle without the Supervisor ever showing as settled
  const lifecycle = yield* lifecycleOver(f.process, {read: id => Effect.succeed(id === "main" ? f.main : f.supervisor),
    rpc: (_tag, payload) => {f.calls.push({payload});return Effect.succeed({sequence: 20});}});
  const check = (now: number) => at(now, Effect.flatMap(f.store.binding("p", "main"), (current) => lifecycle.check(current!, f.threads)));
  const quietSince = 10;
  yield* check(quietSince);
  assert.equal((yield* f.store.binding("p", "main"))?.quietSince, quietSince);
  yield* check(quietSince + SUPERVISOR_SETTLE_QUIET_MS - 1);
  assert.equal(f.settles().length, 0);
  yield* check(quietSince + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.settles().length, 1);
  let observedAt = quietSince + SUPERVISOR_SETTLE_QUIET_MS;
  assert.deepEqual([(yield* f.store.binding("p", "main"))?.settlement?.state, (yield* f.store.binding("p", "main"))?.settlement?.attempts], ["uncertain", 1]);
  for (const attempt of [2, 3]) {
    yield* check(observedAt + SUPERVISOR_SETTLE_QUIET_MS - 1);
    assert.equal(f.settles().length, attempt - 1);
    yield* check(observedAt + SUPERVISOR_SETTLE_QUIET_MS);
    assert.equal(f.settles().length, attempt);
    observedAt += SUPERVISOR_SETTLE_QUIET_MS;
    assert.deepEqual([(yield* f.store.binding("p", "main"))?.settlement?.attempts, (yield* f.store.binding("p", "main"))?.settlement?.observedAt], [attempt, observedAt]);
  }
  yield* check(observedAt + SUPERVISOR_SETTLE_QUIET_MS);
  yield* check(observedAt + 10 * SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.settles().length, 3);
  assert.equal(new Set(f.settles().map(settle => settle.payload.commandId)).size, 1);
  assert.equal((yield* f.store.binding("p", "main"))?.settlement?.state, "uncertain");
}), {timeout: 10_000});

const tableDigest = (sql: GuidanceDb["Service"]) => Effect.gen(function* () {
  const hash = createHash("sha256");
  for (const {name} of yield* query(sql, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
    hash.update(`${String(name)}\0${JSON.stringify(yield* query(sql, `SELECT * FROM "${String(name)}" ORDER BY rowid`))}\0`);
  return hash.digest("hex");
});

it.effect("CT-RESET-01: a reset that fails at its version insert leaves every table untouched and the version absent, also after reopen", () => Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.process.requests.prepare({projectId: "p", supervisorThreadId: f.binding.threadId, kind: "review", taskId: null, text: "Review", batch: null, completionMarker: "done"}, 1);
  yield* f.process.requests.noticeSent(f.binding.threadId, 1);
  // a pre-upgrade prototype database has no scope version
  yield* execute(f.sql, "DELETE FROM meta WHERE key='supervisor_scope_version'");
  const populated = yield* Effect.forEach(["supervisor_main_bindings", "supervisor_task_interpretations", "supervisor_conversation_requests", "supervisor_monitor_binding_clock"],
    table => Effect.map(query(f.sql, `SELECT count(*) AS n FROM ${table}`), ([row]) => Number(row?.n)));
  assert.ok(populated.every(count => count > 0), "the disposable tables hold state before the reset");
  const before = yield* tableDigest(f.sql);
  yield* execute(f.sql, `CREATE TEMP TRIGGER c1_fail_version BEFORE INSERT ON meta WHEN NEW.key='supervisor_scope_version'
    BEGIN SELECT RAISE(ABORT, 'c1 injected version failure'); END`);
  // the driver's text stays out of the typed store error (s6d contract: SqlError is mapped, never leaked raw)
  const failure = yield* Effect.flip(constructSupervisorStore(f.process));
  assert.ok(failure instanceof GuidanceStoreError);
  assert.deepEqual([failure.reason, failure.sqlReason], ["sql_failed", "ConstraintError"]);
  assert.equal(yield* tableDigest(f.sql), before);
  const reopened = yield* openGuidanceClient(f.directory);
  assert.equal(yield* tableDigest(reopened), before);
  assert.equal((yield* query(reopened, "SELECT value FROM meta WHERE key='supervisor_scope_version'"))[0], undefined);

  // without the failure the same construction resets those tables and answers compatible
  yield* execute(f.sql, "DROP TRIGGER c1_fail_version");
  const store = yield* constructSupervisorStore(f.process);
  assert.equal(store.scopeCompatible, true, "the initialization after the failed attempt records the version and is compatible");
  assert.notEqual(yield* tableDigest(f.sql), before);
  assert.equal(Number((yield* query(f.sql, "SELECT count(*) AS n FROM supervisor_main_bindings"))[0]?.n), 0);
}), {timeout: 10_000});
