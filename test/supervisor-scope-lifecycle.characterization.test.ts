import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it, type TestContext } from "vitest";
import { after } from "./support/node-test.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { GuidanceStore } from "../src/guidance-store.js";
import { ProjectSupervisorStore, defaultSupervisorModel, prepareStopNotice } from "../src/project-supervisor-store.js";
import { SupervisorConversation } from "../src/supervisor-conversation.js";
import { SupervisorLifecycle, SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import { withDeadline } from "./support/c1-loopback.js";

const thread = (id: string): ThreadInfo => ({id, title: id, projectId: "p", lineage: {parentThreadId: null, relationshipToParent: null, rootThreadId: id}});

type Settle = {payload: Record<string, unknown>; signal: AbortSignal};

// the baseline suite's lifecycle fixture with held settle sends and main reads, and a second process on the same files
const fixture = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "c1-lifecycle-"));
  const guidance = new GuidanceStore(directory);const store = new ProjectSupervisorStore(guidance, new Set());
  store.baseline({snapshotSequence: 10, threads: []});
  const binding = {...store.reserve("p", "main", "Main", defaultSupervisorModel, 10, 1), state: "ready" as const};store.setBinding(binding);
  const main: Projection = {thread: thread("main"), runs: [{id: "run", ordinal: 1, status: "completed", requestedAt: "2026-10-14T10:00:00Z", startedAt: "2026-10-14T10:00:00Z", completedAt: "2026-10-14T10:01:00Z", rootNodeId: "root"}], messages: [], runtimeRequests: [], subagents: []};
  const supervisor: Projection = {thread: thread(binding.threadId), runs: [], messages: [], runtimeRequests: [], subagents: []};
  const projections = new Map([["main", main], [binding.threadId, supervisor]]);
  const threads = [main.thread, supervisor.thread];
  const calls: Settle[] = [];
  let holdSettle: ((call: Settle) => Promise<unknown> | null) | null = null;
  let holdMainRead: (() => Promise<void> | null) | null = null;
  let stopped = false;
  const project = async (id: string) => {
    if (id === "main") {const held = holdMainRead?.() ?? null;if (held) await held;}
    const p = projections.get(id);if (!p) throw new Error("unreadable");return p;
  };
  const rpc = async (_tag: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    const call = {payload, signal};calls.push(call);
    const held = holdSettle?.(call) ?? null;
    if (held) return held;
    supervisor.thread.settledAt = "2026-10-14T10:02:00Z";supervisor.thread.settledOverride = "settled";return {sequence: 11};
  };
  const opened = [guidance];
  const controllers = (projectStore: ProjectSupervisorStore) => {
    const workflows = new WorkflowStateStore(projectStore, () => true);
    const conversation = new SupervisorConversation(projectStore, rpc, project, undefined, () => true, () => true, workflows);
    conversation.supervisionStopped = threadId => stopped && threadId === "main";
    return {conversation, lifecycle: new SupervisorLifecycle(projectStore, conversation, project, rpc, workflows)};
  };
  store.saveTask({id: "task", projectId: "p", threadId: "main", sourceRunId: "run", sourceMessageId: "source", sourceHash: "hash", sourceOrdinal: 1, supervisorThreadId: binding.threadId,
    messageId: "interpretation", status: "inferred", objective: "Implement", reason: "Requested", updatedAt: 1, requestText: "", dispatchedAt: null, supervisorRunId: null, replayCount: 0});
  const {conversation, lifecycle} = controllers(store);
  const pending: Array<PromiseWithResolvers<unknown>> = [];
  after(t, async () => {
    for (const held of pending) held.reject(new Error("abandoned settle"));
    for (const db of opened) try {db.close();} catch { /* closed by a simulated crash */ }
    await rm(directory, {recursive: true, force: true});
  });
  return {guidance, store, binding, conversation, lifecycle, main, supervisor, threads, calls,
    settles: () => calls.filter(call => call.payload.type === "thread.settle"),
    stop: () => {stopped = true;},
    holdSettle: (mode: "abort" | "crash") => {
      const reached = Promise.withResolvers<Settle>();
      holdSettle = call => {
        reached.resolve(call);
        if (mode === "abort") return new Promise((_resolve, reject) => call.signal.addEventListener("abort", () => reject(new SupervisorRpcError("uncertain")), {once: true}));
        const never = Promise.withResolvers<unknown>();pending.push(never);return never.promise;
      };
      return withDeadline(reached.promise, 3_000, "held settle");
    },
    release: () => {holdSettle = null;},
    holdMainRead: (gate: Promise<void>) => {
      const reached = Promise.withResolvers<void>();
      holdMainRead = () => {holdMainRead = null;reached.resolve();return gate;};
      return withDeadline(reached.promise, 3_000, "held main read");
    },
    check: (now: number, signal: AbortSignal = AbortSignal.timeout(3_000), target = lifecycle, targetStore = store) =>
      target.check(targetStore.binding("p", "main")!, threads, signal, now),
    reopen: () => {
      const reopened = new GuidanceStore(directory);opened.push(reopened);
      const reopenedStore = new ProjectSupervisorStore(reopened, new Set());
      return {store: reopenedStore, ...controllers(reopenedStore)};
    },
  };
};

it("CT-LIFE-01: aborting the settle dispatch saves it 'uncertain' with attempts=1 and the next eligible check reuses its commandId", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  await f.check(10);
  const controller = new AbortController();
  const reached = f.holdSettle("abort");
  const checking = f.check(10 + SUPERVISOR_SETTLE_QUIET_MS, controller.signal);
  const call = await reached;
  const pending = f.store.binding("p", "main")?.settlement;
  assert.ok(pending);
  assert.deepEqual({state: pending.state, attempts: pending.attempts, observedAt: pending.observedAt}, {state: "pending", attempts: 1, observedAt: 10 + SUPERVISOR_SETTLE_QUIET_MS});
  assert.equal(call.payload.commandId, pending.commandId);
  controller.abort();
  await withDeadline(checking, 3_000, "aborted check");
  assert.deepEqual(f.store.binding("p", "main")?.settlement, {...pending, state: "uncertain"});

  f.release();
  await f.check(10 + 2 * SUPERVISOR_SETTLE_QUIET_MS);
  assert.deepEqual(f.settles().map(settle => settle.payload.commandId), [pending.commandId, pending.commandId]);
  assert.equal(f.store.binding("p", "main")?.settlement?.attempts, 2);
  assert.equal(f.store.binding("p", "main")?.settlement?.state, "settled");
});

it("CT-LIFE-01: a crash during the settle dispatch keeps it 'pending' with attempts=1; a new process reuses its commandId", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  await f.check(10);
  const reached = f.holdSettle("crash");
  const abandoned = f.check(10 + SUPERVISOR_SETTLE_QUIET_MS).then(() => "settled", () => "failed");
  after(t, () => withDeadline(abandoned, 3_000, "abandoned check"));
  const call = await reached;
  const pending = f.store.binding("p", "main")?.settlement;
  assert.ok(pending?.state === "pending" && pending.attempts === 1);
  f.guidance.close();

  f.release();
  const restarted = f.reopen();
  assert.deepEqual(restarted.store.binding("p", "main")?.settlement, pending);
  await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS + 1, undefined, restarted.lifecycle, restarted.store);
  assert.deepEqual(f.settles().map(settle => settle.payload.commandId), [call.payload.commandId, call.payload.commandId]);
  assert.deepEqual(restarted.store.binding("p", "main")?.settlement, {...pending, attempts: 2, observedAt: 10 + SUPERVISOR_SETTLE_QUIET_MS + 1, state: "settled"});
});

it("CT-LIFE-02: a stop committed while check() awaits its main read survives the stale binding write, and the next check takes the stopped path", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const gate = Promise.withResolvers<void>();
  after(t, () => gate.resolve());
  const reached = f.holdMainRead(gate.promise);
  const checking = f.check(10);
  await reached;
  const current = f.store.binding("p", "main")!;
  const stop = {route: "ui" as const, callerThreadId: null, userMessageId: null, stoppedAt: 5};
  f.store.setSupervisionStop(current, stop);
  f.store.setStopNotice(current, null, prepareStopNotice(current, 5, null));
  const committed = f.store.binding("p", "main")!;
  f.stop();
  gate.resolve();
  await withDeadline(checking, 3_000, "check");
  const merged = f.store.binding("p", "main")!;
  assert.equal(merged.quietSince, 10, "the stale lifecycle write landed");
  assert.deepEqual(merged.supervisionStop, stop);
  assert.deepEqual(merged.stopNotice, committed.stopNotice);
  assert.deepEqual(f.settles(), []);

  await f.check(20);
  assert.deepEqual(f.settles().map(settle => settle.payload.threadId), [f.binding.threadId]);
  assert.equal(f.store.binding("p", "main")?.settlement?.state, "settled");
  assert.deepEqual(f.store.binding("p", "main")?.supervisionStop, stop);
});

it("CT-LIFE-03: settlement starts exactly at quietSince+60000 and an uncertain one retries exactly at observedAt+60000, never a fourth time", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  // T3 accepts every settle without the Supervisor ever showing as settled
  const lifecycle = new SupervisorLifecycle(f.store, f.conversation, async id => id === "main" ? f.main : f.supervisor,
    async (_tag, payload, signal) => {f.calls.push({payload, signal});return {sequence: 20};});
  const check = (now: number) => lifecycle.check(f.store.binding("p", "main")!, f.threads, AbortSignal.timeout(3_000), now);
  const quietSince = 10;
  await check(quietSince);
  assert.equal(f.store.binding("p", "main")?.quietSince, quietSince);
  await check(quietSince + SUPERVISOR_SETTLE_QUIET_MS - 1);
  assert.equal(f.settles().length, 0);
  await check(quietSince + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.settles().length, 1);
  let observedAt = quietSince + SUPERVISOR_SETTLE_QUIET_MS;
  assert.deepEqual([f.store.binding("p", "main")?.settlement?.state, f.store.binding("p", "main")?.settlement?.attempts], ["uncertain", 1]);
  for (const attempt of [2, 3]) {
    await check(observedAt + SUPERVISOR_SETTLE_QUIET_MS - 1);
    assert.equal(f.settles().length, attempt - 1);
    await check(observedAt + SUPERVISOR_SETTLE_QUIET_MS);
    assert.equal(f.settles().length, attempt);
    observedAt += SUPERVISOR_SETTLE_QUIET_MS;
    assert.deepEqual([f.store.binding("p", "main")?.settlement?.attempts, f.store.binding("p", "main")?.settlement?.observedAt], [attempt, observedAt]);
  }
  await check(observedAt + SUPERVISOR_SETTLE_QUIET_MS);
  await check(observedAt + 10 * SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.settles().length, 3);
  assert.equal(new Set(f.settles().map(settle => settle.payload.commandId)).size, 1);
  assert.equal(f.store.binding("p", "main")?.settlement?.state, "uncertain");
});

const tableDigest = (db: DatabaseSync): string => {
  const hash = createHash("sha256");
  for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{name: string}>)
    hash.update(`${name}\0${JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())}\0`);
  return hash.digest("hex");
};

it("CT-RESET-01: a reset that fails at its version insert leaves every table untouched and the version absent, also after reopen", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  f.conversation.requests.prepare({projectId: "p", supervisorThreadId: f.binding.threadId, kind: "review", taskId: null, text: "Review", batch: null, completionMarker: "done"}, 1);
  f.conversation.requests.noticeSent(f.binding.threadId, 1);
  // a pre-upgrade prototype database has no scope version
  f.guidance.db.exec("DELETE FROM meta WHERE key='supervisor_scope_version'");
  const populated = ["supervisor_main_bindings", "supervisor_task_interpretations", "supervisor_conversation_requests", "supervisor_monitor_binding_clock"]
    .map(table => Number(f.guidance.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n));
  assert.ok(populated.every(count => count > 0), "the disposable tables hold state before the reset");
  const before = tableDigest(f.guidance.db);
  f.guidance.db.exec(`CREATE TEMP TRIGGER c1_fail_version BEFORE INSERT ON meta WHEN NEW.key='supervisor_scope_version'
    BEGIN SELECT RAISE(ABORT, 'c1 injected version failure'); END`);
  assert.throws(() => new ProjectSupervisorStore(f.guidance, new Set()), /c1 injected version failure/u);
  assert.equal(tableDigest(f.guidance.db), before);
  const reopened = new GuidanceStore(join(f.guidance.db.location()!, ".."));
  after(t, () => reopened.close());
  assert.equal(tableDigest(reopened.db), before);
  assert.equal(reopened.db.prepare("SELECT value FROM meta WHERE key='supervisor_scope_version'").get(), undefined);

  // without the failure the same construction resets those tables
  f.guidance.db.exec("DROP TRIGGER c1_fail_version");
  new ProjectSupervisorStore(f.guidance, new Set());
  assert.notEqual(tableDigest(f.guidance.db), before);
  assert.equal(Number(f.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_main_bindings").get()?.n), 0);
});
