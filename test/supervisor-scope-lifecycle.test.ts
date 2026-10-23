import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { guidanceTransaction } from "../src/guidance-sql.js";
import { defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { resolveSteerableRun } from "../src/supervisor-conversation.js";
import { SUPERVISOR_SETTLE_QUIET_MS, type SupervisorLifecycle } from "../src/supervisor-lifecycle.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { mainConversation, resolveSupervisorScope } from "../src/supervisor-scope.js";
import { childOrigin, delegatedLifecycle, directParentChildLifecycle, normalizeLifecycle, observeScopeThread } from "../src/supervisor-observation.js";
import { T3TransportError } from "../src/t3.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { constructSupervisorStore, lifecycleOver, openLifecycleProcess, replaceMethod, stopChat, wallClock, type OperateCall, type ProjectionRead } from "./support/g12-lifecycle.js";
import { execute, query, temporaryDirectory } from "./support/g12-stores.js";

// the scope resolution cases are plain tests of pure functions; the lifecycle cases are Effect tests on the production lifecycle,
// conversation, admission gate, scope predicates and stores over real files in a temporary directory (src/supervision-live.ts),
// with the native reads and the operate rpc as effect fakes. A check's `now` is the test clock's wall time, set before the check;
// the baseline per-call 1 s abort deadlines are gone with the signal parameter, the suite's per-test bound covers a hang

const thread = (id: string, parent: string | null = null, relationship: string | null = null, rootThreadId = parent === "main" || id === "main" ? "main" : parent ?? id): ThreadInfo => ({id, title: id, projectId: "p", lineage: {parentThreadId: parent, relationshipToParent: relationship, rootThreadId}});

it("subagent ancestry shares the main scope while forks and separate launches keep their own", () => {
  const main = thread("main");const child = thread("child", "main", "subagent");const nested = thread("nested", "child", "subagent");
  const fork = thread("fork", "child", "fork");const independent = thread("new");
  const threads = [main, child, nested, fork, independent];
  assert.equal(mainConversation(nested, threads)?.id, "main");
  assert.equal(mainConversation(fork, threads)?.id, "fork");
  assert.equal(mainConversation(independent, threads)?.id, "new");
  assert.equal(mainConversation(child, [child]), null);
  assert.equal(mainConversation(thread("loop", "loop", "subagent"), [thread("loop", "loop", "subagent")]), null);
});

it("verified descendants with native published metadata attach across project mirrors and use their direct parent's lifecycle", () => {
  const mainThread = thread("main");
  const native = {...thread("native", "main", "subagent", "main"), projectId: null,
    creationSource: "provider", forkedFrom: {type: "node", nodeId: "node:provider:codex:native-item"}, latestRunId: null, activeRunId: null};
  const delegated = {...thread("delegated", "main", "subagent", "main"), projectId: "other-project",
    creationSource: "mcp", forkedFrom: {type: "node", nodeId: "node:delegated-task:command%3Achild"}, latestRunId: "delegated-run"};
  const scope = resolveSupervisorScope([mainThread, native, delegated], "p", "main");
  const parentProjection: Projection = {thread: mainThread, runs: [], messages: [], subagents: [{childThreadId: native.id, status: "running"}],
    turnItems: [{id: "native-item", type: "subagent", childThreadId: native.id, status: "running"}]};
  const delegatedProjection: Projection = {thread: delegated, runs: [{id: "delegated-run", threadId: delegated.id, ordinal: 1,
    status: "completed", requestedAt: "2026-10-14T10:00:00Z", startedAt: "2026-10-14T10:00:00Z", completedAt: "2026-10-14T10:01:00Z", rootNodeId: null}], messages: []};
  assert.equal(scope.complete, true);
  assert.deepEqual(scope.descendants.map(item => item.id), [delegated.id, native.id]);
  assert.equal(scope.allowedIds.has(native.id), true);assert.equal(scope.allowedIds.has(delegated.id), true);
  assert.equal(childOrigin(native, parentProjection), "native_child");
  assert.equal(directParentChildLifecycle(parentProjection, native.id)?.status, "running");
  assert.equal(childOrigin(delegated, parentProjection), "delegated_child");
  assert.equal(delegatedLifecycle(delegated, delegatedProjection).lifecycle, "completed");
  assert.equal(normalizeLifecycle("idle").lifecycle, "unknown");
  assert.equal(normalizeLifecycle("failed").lifecycle, "interrupted");
  const staleLineage = observeScopeThread({thread: native, mainThreadId: mainThread.id, depth: 1, projection: null,
    parentProjection, lineageVerified: false, activityRefs: [{sourceThreadId: native.id, sourceRunId: null, sourceMessageId: null,
      sourceItemId: "stale-item", kind: "command", observedAt: 1, label: "old activity"}]});
  assert.equal(staleLineage.origin, "unknown_child");assert.equal(staleLineage.lifecycle, "unknown");assert.deepEqual(staleLineage.activityRefs, []);
});

it("steerable run resolution falls back only to one exact own run when activeRunId is omitted", () => {
  const makeRun = (id: string, overrides: Record<string, unknown> = {}): Projection["runs"][number] => ({
    id, threadId: "child", ordinal: 1, status: "running", requestedAt: "2026-10-17T10:00:00Z",
    startedAt: null, completedAt: null, rootNodeId: `${id}-root`, activeAttemptId: `${id}-attempt`, ...overrides,
  });
  const makeProjection = (runs: Projection["runs"], options: {
    pointer?: {present: boolean; value?: unknown};
    providerTurns?: unknown[];
  } = {}): Projection => {
    const child = thread("child", "main", "subagent", "main");
    if (options.pointer?.present) Object.assign(child, {activeRunId: options.pointer.value});
    const providerTurns = options.providerTurns ?? runs.map(run => ({id: `${run.id}-turn`, nodeId: run.rootNodeId,
      runAttemptId: run.activeAttemptId, status: "running"}));
    return {thread: child, runs, messages: [], providerTurns};
  };
  const run = makeRun("active");
  const absent = makeProjection([run]);
  assert.equal(Object.prototype.hasOwnProperty.call(absent.thread, "activeRunId"), false);
  assert.equal(resolveSteerableRun(absent)?.id, "active");

  const activePointer = makeProjection([run], {pointer: {present: true, value: "active"}});
  assert.equal(resolveSteerableRun(activePointer)?.id, "active", "a valid explicit pointer keeps its existing path");

  const cases: Array<{name: string; projection: Projection}> = [
    {name: "ambiguous own running runs", projection: makeProjection([makeRun("one"), makeRun("two")])},
    {name: "explicit null", projection: makeProjection([run], {pointer: {present: true, value: null}})},
    {name: "malformed explicit pointer", projection: makeProjection([run], {pointer: {present: true, value: 17}})},
    {name: "stale explicit pointer", projection: makeProjection([run], {pointer: {present: true, value: "stale"}})},
    {name: "foreign run", projection: makeProjection([makeRun("foreign", {threadId: "other"})])},
    {name: "missing run thread id", projection: makeProjection([makeRun("unbound", {threadId: undefined})])},
    {name: "non-running run", projection: makeProjection([makeRun("finished", {status: "completed"})])},
    {name: "missing active attempt", projection: makeProjection([makeRun("no-attempt", {activeAttemptId: undefined})])},
    {name: "missing root node", projection: makeProjection([makeRun("no-root", {rootNodeId: null})])},
    {name: "missing provider turn", projection: makeProjection([run], {providerTurns: []})},
    {name: "non-running provider turn", projection: makeProjection([run], {providerTurns: [{id: "completed-turn",
      nodeId: run.rootNodeId, runAttemptId: run.activeAttemptId, status: "completed"}]})},
    {name: "mismatched provider attempt", projection: makeProjection([run], {providerTurns: [{id: "wrong-attempt-turn",
      nodeId: run.rootNodeId, runAttemptId: "other-attempt", status: "running"}]})},
    {name: "mismatched provider node", projection: makeProjection([run], {providerTurns: [{id: "wrong-node-turn",
      nodeId: "other-root", runAttemptId: run.activeAttemptId, status: "running"}]})},
  ];
  for (const item of cases) assert.equal(resolveSteerableRun(item.projection), null, item.name);
});

it("an incomplete unrelated lineage retains verified sibling scope for read-only observation", () => {
  const mainThread = thread("main");
  const sibling = thread("sibling", "main", "subagent", "main");
  const missingParent = thread("unknown-child", "missing-parent", "subagent", "main");
  const scope = resolveSupervisorScope([mainThread, sibling, missingParent], "p", "main");
  assert.equal(scope.complete, false);
  assert.equal(scope.allowedIds.has("main"), true);
  assert.equal(scope.allowedIds.has("sibling"), true);
  assert.equal(scope.allowedIds.has("unknown-child"), false);
});

const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(wallClock);
  const directory = yield* temporaryDirectory("supervisor-scopes-");
  const projections = new Map<string, Projection>();
  const calls: Array<Record<string, unknown>> = [];const failures = new Map<string, T3TransportError>();
  let projectionReads = 0;
  let uncertain = false;
  let settledTarget: Projection | null = null;
  // an unknown thread reads as the transport failure the T3 client reports
  const project: ProjectionRead = (id) => Effect.suspend(() => {projectionReads++;const failure = failures.get(id);if (failure) return Effect.fail(failure);const p = projections.get(id);
    return p ? Effect.succeed(p) : Effect.fail(new T3TransportError("T3 thread projection is unavailable"));});
  // T3 accepts the settle and shows the Supervisor settled; with an uncertain receipt the accepted call's reply is lost
  const rpc: OperateCall = (_tag, payload) => {calls.push(payload);if (uncertain) return Effect.fail(new SupervisorRpcError("uncertain"));settledTarget!.thread.settledAt = "2026-10-14T10:02:00Z";settledTarget!.thread.settledOverride = "settled";return Effect.succeed({sequence: 11});};
  const process = yield* openLifecycleProcess(directory, {read: project, rpc});
  const {store, requests, monitor, workflows, conversation, lifecycle, sql} = process;
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
  return {process, sql, store, requests, monitor, binding, conversation, lifecycle, workflows, main, supervisor, projections, threads, calls, projectionReads: () => projectionReads,
    setUncertain: () => {uncertain = true;}, setFailure: (id: string, error: T3TransportError | null) => {if (error) failures.set(id, error);else failures.delete(id);},
    stopChat: (threadId: string) => stopChat(process, threadId),
    check: (now: number) => at(now, Effect.flatMap(store.binding("p", "main"), (current) => lifecycle.check(current!, threads)))};
});

// an effect run at the wall time `now` of the test clock
const at = <A, E, R>(now: number, effect: Effect.Effect<A, E, R>) => Effect.andThen(TestClock.setTime(now), effect);
const checkAt = (lifecycle: SupervisorLifecycle["Service"], f: Effect.Success<typeof fixture>, now: number) => at(now, lifecycle.check(f.binding, f.threads));

it.effect("requests, cooldowns, retry misses and model readback are isolated for two mains", () => Effect.gen(function* () {
  const f = yield* fixture;
  const second = yield* f.store.reserve("p", "other", "Other", defaultSupervisorModel, 10, 2);
  const request = (id: string) => ({projectId: "p", supervisorThreadId: id, kind: "review" as const, taskId: null, text: "Review", batch: null, completionMarker: "done"});
  const a = yield* f.requests.prepare(request(f.binding.threadId), 3);
  const b = yield* f.requests.prepare(request(second.threadId), 4);
  yield* f.requests.saveRequest({...a, state: "uncertain"});
  yield* f.requests.noticeSent(f.binding.threadId, 100);yield* f.requests.missedReview(f.binding.threadId);
  yield* f.conversation.retry("p", second.threadId);
  assert.equal((yield* f.requests.pending("p", f.binding.threadId))?.state, "uncertain");
  assert.equal((yield* f.requests.pending("p", second.threadId))?.id, b.id);
  assert.equal(yield* f.requests.lastNotice(second.threadId), null);
  assert.equal(yield* f.requests.reviewMisses(second.threadId), 0);
  assert.equal(yield* f.requests.reviewMisses(f.binding.threadId), 1);
  yield* f.store.observeModel(f.binding, {...defaultSupervisorModel, model: "another"});
  assert.equal((yield* f.store.modelState(second)).modelSelection.model, defaultSupervisorModel.model);
  assert.equal((yield* f.store.settings("p")).modelSelection.model, defaultSupervisorModel.model);
}));

it.effect("completion parks an owned Supervisor after the quiet window and retains identity", () => Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS - 1);assert.equal(f.calls.length, 0);
  yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);assert.equal(f.calls[0]?.type, "thread.settle");assert.equal((yield* f.store.binding("p", "main"))?.threadId, f.binding.threadId);
  assert.equal((yield* f.store.task("main"))?.status, "inferred");
  delete f.supervisor.thread.settledAt;f.supervisor.thread.settledOverride = null;
  f.main.runs[0]!.status = "running";
  yield* f.check(200_000);assert.equal((yield* f.store.binding("p", "main"))?.quietSince, null);
  assert.equal((yield* f.store.binding("p", "main"))?.threadId, f.binding.threadId);
}));

const executedRunHistory = (latestExecuted: {status: string; startedAt: string | null}) => [
  {id: "run-1", ordinal: 1, status: "failed", requestedAt: "2026-10-14T10:00:00Z", startedAt: null, completedAt: "2026-10-14T10:00:03Z", rootNodeId: null},
  {id: "run-2", ordinal: 2, status: "interrupted", requestedAt: "2026-10-14T10:01:00Z", startedAt: "2026-10-14T10:01:00Z", completedAt: "2026-10-14T10:01:05Z", rootNodeId: null},
  {id: "run-3", ordinal: 3, status: "failed", requestedAt: "2026-10-14T10:02:00Z", startedAt: "2026-10-14T10:02:00Z", completedAt: "2026-10-14T10:40:00Z", rootNodeId: null},
  {id: "run-4", ordinal: 4, status: "cancelled", requestedAt: "2026-10-14T10:03:00Z", startedAt: null, completedAt: "2026-10-14T10:03:10Z", rootNodeId: null},
  {id: "run-5", ordinal: 5, status: latestExecuted.status, requestedAt: "2026-10-14T10:41:00Z", startedAt: latestExecuted.startedAt,
    completedAt: "2026-10-14T10:55:00Z", rootNodeId: "root"},
  {id: "run-6", ordinal: 6, status: "cancelled", requestedAt: "2026-10-14T10:42:00Z", startedAt: null, completedAt: "2026-10-14T10:45:00Z", rootNodeId: null},
  {id: "run-7", ordinal: 7, status: "cancelled", requestedAt: "2026-10-14T10:44:00Z", startedAt: null, completedAt: "2026-10-14T10:44:03Z", rootNodeId: null},
  {id: "run-8", ordinal: 8, status: "cancelled", requestedAt: "2026-10-14T10:44:10Z", startedAt: null, completedAt: "2026-10-14T10:44:13Z", rootNodeId: null},
];

it.effect("queued requests cancelled before starting do not hide the completed executed main run from settlement", () => Effect.gen(function* () {
  const f = yield* fixture;
  f.main.runs = executedRunHistory({status: "completed", startedAt: "2026-10-14T10:41:00Z"});
  yield* f.check(10);
  assert.equal((yield* f.store.binding("p", "main"))?.settlementBlockedBy, "quiet_window");
  yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.deepEqual(f.calls.map(call => [call.type, call.threadId]), [["thread.settle", f.binding.threadId]], "only the service-owned root is settled");
  assert.equal((yield* f.store.binding("p", "main"))?.settlementBlockedBy, null);
}));

it.effect("a failed, cancelled-after-start or interrupted executed main run, or a later queued request, still blocks settlement behind unstarted cancellations", () => Effect.gen(function* () {
  for (const latestExecuted of [{status: "failed", startedAt: "2026-10-14T10:41:00Z"}, {status: "cancelled", startedAt: "2026-10-14T10:41:00Z"},
    {status: "interrupted", startedAt: "2026-10-14T10:41:00Z"}]) {
    const f = yield* fixture;
    f.main.runs = executedRunHistory(latestExecuted);
    yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
    assert.equal(f.calls.length, 0, latestExecuted.status);
    assert.equal((yield* f.store.binding("p", "main"))?.settlementBlockedBy, "main_run_not_completed", latestExecuted.status);
  }
  const f = yield* fixture;
  f.main.runs = [...executedRunHistory({status: "completed", startedAt: "2026-10-14T10:41:00Z"}),
    {id: "run-9", ordinal: 9, status: "queued", requestedAt: "2026-10-14T10:56:00Z", startedAt: null, completedAt: null, rootNodeId: null}];
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0, "a queued request is pending work, not an unstarted cancellation");
}), { timeout: 60_000 });

it.effect("a busy main short-circuits child projection reads even with a large known descendant set", () => Effect.gen(function* () {
  const f = yield* fixture;
  f.main.runs[0]!.status = "running";
  for (let index = 0; index < 100; index++) {
    const child = {...thread(`busy-child-${index}`, "main", "subagent", "main"), projectId: null, creationSource: "provider"};
    f.threads.push(child);
    f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  }
  const before = f.projectionReads();
  yield* f.check(10);
  assert.equal(f.projectionReads() - before, 2, "only the Supervisor and main projections are read before the main-busy blocker returns");
  assert.equal(f.calls.length, 0);
}));

it.effect("pending child monitor activity blocks standby before any descendant projection reads", () => Effect.gen(function* () {
  const f = yield* fixture;
  const child = {...thread("pending-child", "main", "subagent", "main"), projectId: null, creationSource: "provider"};
  f.threads.push(child);
  const projection: Projection = {thread: child, runs: [], messages: [], subagents: [], turnItems: [{id: "pending-child-command", threadId: child.id,
    runId: null, type: "command_execution", status: "completed", ordinal: 1, completedAt: "2026-10-14T10:02:00Z", updatedAt: "2026-10-14T10:02:00Z"}]};
  f.projections.set(child.id, projection);
  yield* f.monitor.observe({projectId: "p", threadId: child.id, sourceOrdinal: 1, projection, includeDetachedChildItems: true, now: 1});
  const before = f.projectionReads();
  yield* f.check(10);
  assert.equal((yield* f.monitor.pending("p", child.id)).length, 1);
  assert.equal(f.projectionReads() - before, 2);
  assert.equal(f.calls.length, 0);
}));

it.effect("a not-needed request's Supervisor settles over retained unreviewed scope activity, which a supervised task still waits for", () => Effect.gen(function* () {
  for (const status of ["not_supervised", "needs_context", "inferred"] as const) {
    const f = yield* fixture;
    yield* f.store.saveTask({...(yield* f.store.task("main"))!, status});
    // activity in the main's scope left unreviewed by an earlier supervised request
    const child = {...thread("leftover-child", "main", "subagent", "main"), projectId: null, creationSource: "provider"};
    f.threads.push(child);
    const projection: Projection = {thread: child, runs: [], messages: [], subagents: [], turnItems: [{id: "leftover-command", threadId: child.id,
      runId: null, type: "command_execution", status: "completed", ordinal: 1, completedAt: "2026-10-14T10:00:30Z", updatedAt: "2026-10-14T10:00:30Z"}]};
    f.projections.set(child.id, projection);
    yield* f.monitor.observe({projectId: "p", threadId: child.id, sourceOrdinal: 1, projection, includeDetachedChildItems: true, now: 1});
    assert.equal((yield* f.conversation.status("p", f.binding.threadId)).pendingItems, 0, `${status}: the dashboard counts no pending items`);
    yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
    if (status === "inferred") {
      assert.equal(f.calls.length, 0, "a supervised task waits for its activity to be reviewed");
      assert.equal((yield* f.store.binding("p", "main"))?.settlementBlockedBy, "pending_activity");
    } else {
      assert.deepEqual(f.calls.map(call => call.type), ["thread.settle"], status);
    }
    assert.equal((yield* f.monitor.pending("p", child.id)).length, 1, `${status}: the retained activity is not acknowledged or erased`);
  }
}), { timeout: 60_000 });

it.effect("a not-needed request's Supervisor ignores a replaced task's known-unsent draft but not an unknown or current introduction, and an incomplete scan stays closed", () => Effect.gen(function* () {
  const introduction = (taskId: string, extra: Record<string, unknown>) => ({taskId, projectId: "p", threadId: "main", text: "Earlier proposal.",
    messageId: `supervisor-notice:workflow:${taskId}`, targetRunId: null, error: null, dispatchMode: {type: "queue_after_active" as const}, ...extra});
  const cases = [
    {name: "replaced blocked draft", intro: introduction("old-task", {state: "blocked"}), blockedBy: null},
    {name: "replaced rejected fallback", intro: introduction("old-task", {state: "ready",
      rejectedAttempts: [{messageId: "steer", commandId: "steer", dispatchMode: {type: "steer_active", targetRunId: "run"}}]}), blockedBy: null},
    {name: "replaced uncertain delivery", intro: introduction("old-task", {state: "uncertain", definiteRejection: false}), blockedBy: "introduction_unsent"},
    {name: "replaced accepted but unseen", intro: introduction("old-task", {state: "blocked", acceptedAt: 1}), blockedBy: "introduction_unsent"},
    {name: "current task draft", intro: introduction("task", {state: "blocked"}), blockedBy: "introduction_unsent"},
  ];
  for (const item of cases) {
    const f = yield* fixture;
    yield* f.store.saveTask({...(yield* f.store.task("main"))!, status: "not_supervised"});
    yield* f.requests.saveIntroduction({...item.intro, supervisorThreadId: f.binding.threadId} as never);
    yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
    assert.equal(f.calls.length, item.blockedBy ? 0 : 1, item.name);
    if (item.blockedBy) assert.equal((yield* f.store.binding("p", "main"))?.settlementBlockedBy, item.blockedBy, item.name);
    assert.ok(yield* f.requests.introduction(item.intro.taskId), `${item.name}: the introduction record is kept`);
  }
  const f = yield* fixture;
  yield* f.store.saveTask({...(yield* f.store.task("main"))!, status: "not_supervised"});
  yield* replaceMethod(f.monitor, "hasPendingReviewableActivity", () => Effect.succeed({status: "incomplete" as const}));
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0, "an incomplete activity scan never permits settlement");
  assert.equal((yield* f.store.binding("p", "main"))?.settlementBlockedBy, "pending_activity");
}), { timeout: 60_000 });

it.effect("archived mains absent from the active catalog set aside the same Supervisor and retain unfinished semantic records", () => Effect.gen(function* () {
  const f = yield* fixture;
  f.main.thread.archivedAt = "2026-10-14T10:02:00Z";f.main.thread.updatedAt = "2026-10-14T10:02:00Z";
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  yield* f.store.saveTask({...(yield* f.store.task("main"))!, status: "queued", objective: null, workflow: null, agreement: null});
  const prepared = {id: "prepared-id", projectId: "p", supervisorThreadId: f.binding.threadId, kind: "review" as const, taskId: "task", text: "Prepared request", messageId: "prepared-message",
    state: "prepared" as const, batch: null, createdAt: 1, sentAt: null, runId: null, error: null, completionMarker: "prepared done"};
  const uncertain = {...prepared, id: "unknown-id", messageId: "unknown-message", state: "uncertain" as const, text: "Unknown request"};
  yield* f.requests.saveRequest(prepared);yield* f.requests.saveRequest(uncertain);
  yield* f.requests.saveIntroduction({taskId: "task", projectId: "p", threadId: "main", supervisorThreadId: f.binding.threadId, state: "ready", text: "Unsent introduction", messageId: "intro", targetRunId: null, error: null});
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);assert.equal((yield* f.store.binding("p", "main"))?.threadId, f.binding.threadId);
  assert.deepEqual((yield* f.requests.requests("p", f.binding.threadId)).map(request => [request.id, request.state]), [["prepared-id", "prepared"], ["unknown-id", "uncertain"]]);
  assert.equal((yield* f.requests.introduction("task"))?.state, "ready");assert.equal((yield* f.store.task("main"))?.status, "queued");
}));

it.effect("a confirmed missing main closes a runless native child whose parent projection is gone", () => Effect.gen(function* () {
  const f = yield* fixture;f.setFailure("main", new T3TransportError("deleted", 404));
  const child = thread("child", "main", "subagent", "main");f.threads.push(child);
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  assert.equal(yield* f.lifecycle.readMain(f.binding), null);
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);assert.equal((yield* f.store.binding("p", "main"))?.threadId, f.binding.threadId);
}));

it.effect("readMain rejects projections whose thread or project identity does not match the binding", () => Effect.gen(function* () {
  const f = yield* fixture;
  f.main.thread.id = "other";assert.match(String(yield* Effect.flip(f.lifecycle.readMain(f.binding))), /main_scope_mismatch/);
  f.main.thread.id = "main";f.main.thread.projectId = "other-project";
  assert.match(String(yield* Effect.flip(f.lifecycle.readMain(f.binding))), /main_scope_mismatch/);
}));

it.effect("transient main reads clear the quiet epoch and fail closed", () => Effect.gen(function* () {
  const f = yield* fixture;f.setFailure("main", new T3TransportError("unavailable", 503));
  const error = yield* Effect.flip(f.lifecycle.readMain(f.binding));assert.ok(error instanceof T3TransportError && error.httpStatus === 503);
  yield* f.check(10);assert.equal(f.calls.length, 0);assert.equal((yield* f.store.binding("p", "main"))?.quietSince, null);
  f.setFailure("main", null);yield* f.check(100_000);assert.equal(f.calls.length, 0);
  yield* f.check(100_000 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
}));

it.effect("archived mains stay active while a cataloged direct or nested descendant is busy", () => Effect.gen(function* () {
  for (const kind of ["running", "background"] as const) {
    const f = yield* fixture;
    f.main.thread.archivedAt = "2026-10-14T10:02:00Z";f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
    const child = thread(kind === "running" ? "child" : "nested", kind === "running" ? "main" : "parent", "subagent", "main");
    f.threads.push(child);
    if (kind === "background") {
      const parent = thread("parent", "main", "subagent", "main");
      f.threads.push(parent);f.projections.set(parent.id, {thread: parent, runs: [{...f.main.runs[0]!, id: "parent-run"}], messages: [], subagents: []});
    }
    const childProjection: Projection = {thread: child, runs: [{...f.main.runs[0]!, id: `${kind}-run`, status: kind === "running" ? "running" : "completed"}], messages: [], subagents: []};
    if (kind === "background") childProjection.thread.pendingBackgroundTasks = [{kind: "task", id: "background"}];
    f.projections.set(child.id, childProjection);
    yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0, kind);
  }
}));

it.effect("more than one hundred quiet descendants become cache-validated instead of permanently blocking parking", () => Effect.gen(function* () {
  const f = yield* fixture;
  f.main.subagents = [];
  for (let index = 0; index < 101; index++) {
    const child = {...thread(`quiet-child-${String(index).padStart(3, "0")}`, "main", "subagent", "main"), projectId: null, creationSource: "provider"};
    f.threads.push(child);
    f.main.subagents.push({childThreadId: child.id, status: "completed"});
    f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  }
  yield* f.check(10);assert.equal(f.calls.length, 0, "the first bounded pass leaves one child for the next rotation");
  yield* f.check(20);assert.equal(f.calls.length, 0);
  yield* f.check(20 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);
}));

it.effect("a live delegated child beyond the first lifecycle scan page still blocks parking when rotation reaches it", () => Effect.gen(function* () {
  const f = yield* fixture;
  f.main.subagents = [];
  for (let index = 0; index < 100; index++) {
    const child = {...thread(`quiet-child-${String(index).padStart(3, "0")}`, "main", "subagent", "main"), projectId: null, creationSource: "provider"};
    f.threads.push(child);
    f.main.subagents.push({childThreadId: child.id, status: "completed"});
    f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  }
  const activeChild = {...thread("z-delegated-active", "main", "subagent", "main"), projectId: "other-project", creationSource: "mcp",
    activeRunId: "delegated-active-run"};
  f.threads.push(activeChild);
  f.main.subagents.push({childThreadId: activeChild.id, status: "completed"});
  f.projections.set(activeChild.id, {thread: activeChild, runs: [{...f.main.runs[0]!, id: "delegated-active-run", threadId: activeChild.id, ordinal: 1, status: "running"}],
    messages: [], subagents: []});

  yield* f.check(10);assert.equal(f.calls.length, 0);
  yield* f.check(20);assert.equal(f.calls.length, 0);
  assert.equal((yield* f.store.binding("p", "main"))?.quietSince, null);
}));

it.effect("nested descendants inherit historical roots but remain children of the bound main", () => Effect.gen(function* () {
  const f = yield* fixture;
  f.main.thread.lineage.rootThreadId = "historical-root";f.main.thread.archivedAt = "2026-10-14T10:02:00Z";
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  const child = thread("child", "main", "subagent", "historical-root");
  const grandchild = thread("grandchild", "child", "subagent", "historical-root");
  f.threads.push(child, grandchild);
  f.projections.set(child.id, {thread: child, runs: [{...f.main.runs[0]!, id: "child-run"}], messages: [], subagents: [{childThreadId: grandchild.id, status: "completed"}]});
  f.projections.set(grandchild.id, {thread: grandchild, runs: [{...f.main.runs[0]!, id: "grandchild-run", status: "running"}], messages: [], subagents: []});
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0);
}));

it.effect("an active nested grandchild under an independent fork is outside the bound main scope", () => Effect.gen(function* () {
  const f = yield* fixture;f.main.thread.lineage.rootThreadId = "historical-root";
  const forkMain = thread("fork-main", "main", "fork", "historical-root");
  const forkChild = thread("fork-child", "fork-main", "subagent", "historical-root");
  const forkGrandchild = thread("fork-grandchild", "fork-child", "subagent", "historical-root");
  f.threads.push(forkMain, forkChild, forkGrandchild);
  f.projections.set(forkMain.id, {thread: forkMain, runs: [{...f.main.runs[0]!, id: "fork-main-run"}], messages: [], subagents: []});
  f.projections.set(forkChild.id, {thread: forkChild, runs: [{...f.main.runs[0]!, id: "fork-child-run"}], messages: [], subagents: [{childThreadId: forkGrandchild.id, status: "running"}]});
  f.projections.set(forkGrandchild.id, {thread: forkGrandchild, runs: [{...f.main.runs[0]!, id: "fork-grandchild-run", status: "running"}], messages: [], subagents: []});
  assert.equal(mainConversation(forkGrandchild, f.threads)?.id, forkMain.id);
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
}));

it.effect("normal main settlement honors the active catalog shell's background work", () => Effect.gen(function* () {
  const f = yield* fixture;
  const sourceShell = {...f.main.thread, pendingBackgroundTasks: [{kind: "task", id: "background"}]};
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1, sourceShell);
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0);
}));

it.effect("T3 deletion closes a still-running child scope after the main returns confirmed 404", () => Effect.gen(function* () {
  const f = yield* fixture;f.setFailure("main", new T3TransportError("deleted", 404));
  const child = thread("child", "main", "subagent", "main");f.threads.push(child);
  f.projections.set(child.id, {thread: child, runs: [{...f.main.runs[0]!, id: "child-run", status: "running"}], messages: [], subagents: []});
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
}));

it.effect("an archived but natively busy main cannot be set aside", () => Effect.gen(function* () {
  const f = yield* fixture;f.main.thread.archivedAt = "2026-10-14T10:02:00Z";f.main.runs[0]!.status = "running";
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0);
}));

it.effect("an active native child blocks settlement through its direct parent despite an idle child mirror", () => Effect.gen(function* () {
  const f = yield* fixture;
  const child = {...thread("native-child", "main", "subagent", "main"), projectId: null,
    creationSource: "provider", latestRunId: null, activeRunId: null};
  f.threads.push(child);
  f.main.subagents = [{childThreadId: child.id, status: "running"}];
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0);
  f.main.subagents[0]!.status = "completed";
  yield* f.check(10 + 2 * SUPERVISOR_SETTLE_QUIET_MS);
  yield* f.check(10 + 3 * SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);
}));

for (const requestStatus of ["resolved", "expired", "cancelled"] as const) {
  it.effect(`a matched ${requestStatus} child request clears stale detached waiting state`, () => Effect.gen(function* () {
    const f = yield* fixture;
    const child = {...thread(`native-request-${requestStatus}`, "main", "subagent", "main"), projectId: null,
      creationSource: "provider", latestRunId: null, activeRunId: null,
      pendingRuntimeRequest: {id: `request-${requestStatus}`, nodeId: `node-${requestStatus}`, kind: "user_input"}};
    f.threads.push(child);
    f.main.subagents = [{childThreadId: child.id, status: "completed"}];
    f.projections.set(child.id, {thread: child, runs: [], messages: [],
      nodes: [{id: `node-${requestStatus}`, threadId: child.id, runId: null, kind: "tool_call"}],
      turnItems: [{id: `item-${requestStatus}`, threadId: child.id, runId: null, type: "user_input_request", status: "waiting",
        requestId: `request-${requestStatus}`, nodeId: `node-${requestStatus}`}],
      runtimeRequests: [{id: `request-${requestStatus}`, nodeId: `node-${requestStatus}`, kind: "user_input", status: requestStatus}]});

    yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
    assert.equal(f.calls.length, 1, "terminal native request evidence supersedes stale waiting mirrors");
  }));
}

it.effect("a fresh pending child request still blocks settlement", () => Effect.gen(function* () {
  const f = yield* fixture;
  const child = {...thread("native-request-pending", "main", "subagent", "main"), projectId: null,
    creationSource: "provider", latestRunId: null, activeRunId: null,
    pendingRuntimeRequest: {id: "request-pending", nodeId: "node-pending", kind: "user_input"}};
  f.threads.push(child);
  f.main.subagents = [{childThreadId: child.id, status: "completed"}];
  f.projections.set(child.id, {thread: child, runs: [], messages: [],
    nodes: [{id: "node-pending", threadId: child.id, runId: null, kind: "tool_call"}],
    turnItems: [{id: "item-pending", threadId: child.id, runId: null, type: "user_input_request", status: "waiting",
      requestId: "request-pending", nodeId: "node-pending"}],
    runtimeRequests: [{id: "request-pending", nodeId: "node-pending", kind: "user_input", status: "pending"}]});

  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0);
}));

it.effect("quiet children with unknown lifecycle do not prevent standby while ongoing T3 effects still do", () => Effect.gen(function* () {
  const f = yield* fixture;
  const child = {...thread("old-child", "main", "subagent", "main"), projectId: null,
    creationSource: "provider", latestRunId: null, activeRunId: null};
  f.threads.push(child);
  f.main.subagents = [{childThreadId: child.id, status: "unknown"}];
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  yield* f.check(1);yield* f.check(1 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);

  const busyFixture = yield* fixture;
  busyFixture.main.subagents = [{childThreadId: "unresolved", status: "unknown", completionDelivery: {state: "pending"}}];
  yield* busyFixture.check(1);yield* busyFixture.check(1 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(busyFixture.calls.length, 0);
}));

it.effect("known workflow needs-attention status blocks standby even when all T3 chats are quiet", () => Effect.gen(function* () {
  const f = yield* fixture;
  const owner = {projectId: "p", mainThreadId: "main", supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation};
  const created = yield* guidanceTransaction(f.sql)(f.workflows.ensureMain(owner, "workflow-attention-main", "Known issue", 1));
  assert.equal(created.status, "created");
  const document = yield* f.workflows.get("p", "main");assert.ok(document);
  yield* execute(f.sql, "UPDATE supervisor_workflow_state SET document=?,updated_at=? WHERE workflow_id=?",
    JSON.stringify({...document, status: "needs_attention"}), 2, document.workflowId);
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0);
}));

it.effect("unknown intermediate child ancestry blocks closed-main settlement", () => Effect.gen(function* () {
  const f = yield* fixture;f.main.thread.archivedAt = "2026-10-14T10:02:00Z";
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  f.threads.push(thread("nested", "missing-parent", "subagent", "main"));
  yield* f.check(10);assert.equal(f.calls.length, 0);assert.equal((yield* f.store.binding("p", "main"))?.quietSince, null);
}));

it.effect("a confirmed missing ancestor terminates an unrelated orphan subagent chain", () => Effect.gen(function* () {
  const f = yield* fixture;f.setFailure("deleted-parent", new T3TransportError("deleted", 404));
  f.threads.push(thread("orphan", "deleted-parent", "subagent", "historical-root"));
  yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
}));

it.effect("reopening the same main cancels its closed-source quiet epoch and retains binding identity", () => Effect.gen(function* () {
  const f = yield* fixture;f.main.thread.archivedAt = "2026-10-14T10:02:00Z";f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  yield* f.check(10);assert.equal((yield* f.store.binding("p", "main"))?.quietSince, 10);
  delete f.main.thread.archivedAt;f.main.thread.updatedAt = "2026-10-14T10:03:00Z";f.threads.push(f.main.thread);
  yield* f.check(20);assert.equal(f.calls.length, 0);assert.equal((yield* f.store.binding("p", "main"))?.quietSince, 20);
  assert.equal((yield* f.store.binding("p", "main"))?.threadId, f.binding.threadId);
  yield* f.check(20 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);assert.equal((yield* f.store.binding("p", "main"))?.threadId, f.binding.threadId);
}));

it.effect("a fresh main read that observes reopening cancels closed-source settlement", () => Effect.gen(function* () {
  const f = yield* fixture;
  const archived: Projection = {...f.main, thread: {...f.main.thread, archivedAt: "2026-10-14T10:02:00Z"}};
  const reopened: Projection = {...f.main, thread: {...f.main.thread, archivedAt: null, updatedAt: "2026-10-14T10:03:00Z"}};
  let mainReads = 0;
  const projection: ProjectionRead = id => Effect.sync(() => id === "main" ? (++mainReads <= 2 ? archived : reopened) : f.projections.get(id)!);
  const lifecycle = yield* lifecycleOver(f.process, {read: projection, rpc: (_tag, payload) => {f.calls.push(payload);return Effect.succeed({sequence: 20});}});
  yield* checkAt(lifecycle, f, 10);
  yield* checkAt(lifecycle, f, 10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(mainReads, 3);assert.equal(f.calls.length, 0);assert.equal((yield* f.store.binding("p", "main"))?.quietSince, null);
}));

for (const blocker of ["input", "main_running", "supervisor_queued", "child", "uncertain_request", "pin", "keep_active", "pending_review", "main_failed"] as const) {
  it.effect(`automatic settlement preserves ${blocker}`, () => Effect.gen(function* () {
    const f = yield* fixture;yield* f.check(10);
    if (blocker === "input") f.supervisor.runtimeRequests = [{status: "pending", kind: "user_input"}];
    if (blocker === "main_running") f.main.runs[0]!.status = "running";
    if (blocker === "main_failed") f.main.runs[0]!.status = "failed";
    if (blocker === "supervisor_queued") f.supervisor.runs = [{...f.main.runs[0]!, status: "queued"}];
    if (blocker === "child") {const child = thread("child", "main", "subagent");f.threads.push(child);f.projections.set("child", {thread: child, runs: [{...f.main.runs[0]!, status: "running"}], messages: []});}
    if (blocker === "uncertain_request") {const r = yield* f.requests.prepare({projectId: "p", supervisorThreadId: f.binding.threadId, kind: "review", taskId: null, text: "Review", batch: null, completionMarker: "done"}, 1);yield* f.requests.saveRequest({...r, state: "uncertain"});}
    if (blocker === "pin") f.supervisor.thread.pinnedAt = "2026-10-14T10:00:00Z";
    if (blocker === "keep_active") f.supervisor.thread.settledOverride = "active";
    if (blocker === "pending_review") yield* execute(f.sql, "UPDATE supervisor_monitor_threads SET saturated=1");
    if (blocker === "pending_review") {const r = yield* f.requests.prepare({projectId: "p", supervisorThreadId: f.binding.threadId, kind: "review", taskId: null, text: "Review", batch: null, completionMarker: "done"}, 1);yield* f.requests.saveRequest({...r, state: "failed", error: "Unconfirmed"});}
    yield* f.check(100_000);assert.equal(f.calls.length, 0);
  }));
}

it.effect("unknown settlement reconciles visibility without deletion or repeated commands", () => Effect.gen(function* () {
  const f = yield* fixture;f.setUncertain();yield* f.check(1);yield* f.check(100_000);
  assert.equal((yield* f.store.binding("p", "main"))?.settlement?.state, "uncertain");
  const id = (yield* f.store.binding("p", "main"))?.settlement?.commandId;
  yield* f.check(200_000);assert.equal(f.calls.length, 2);assert.equal(f.calls[1]?.commandId, id);
  f.supervisor.thread.settledAt = "2026-10-14T10:00:00Z";yield* f.check(300_000);
  assert.equal((yield* f.store.binding("p", "main"))?.settlement?.state, "settled");assert.equal((yield* f.store.binding("p", "main"))?.settlement?.commandId, id);
}));

it.effect("the one-time disposable reset clears discovery together and preserves unrelated state", () => Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.store.saveSettings("p", 0, {...defaultSupervisorModel, model: "chosen-default"});
  const oldOwned = f.binding.threadId;
  for (const statement of ["CREATE TABLE unrelated_delivery(id TEXT)", "INSERT INTO unrelated_delivery VALUES('retained')",
    "CREATE TABLE supervisor_project_bindings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL)", "INSERT INTO supervisor_project_bindings VALUES('p','{}')",
    "DELETE FROM meta WHERE key='supervisor_scope_version'"]) yield* execute(f.sql, statement);
  yield* constructSupervisorStore(f.process);
  assert.equal((yield* f.store.bindings()).length, 0);assert.equal(yield* f.store.task("main"), null);assert.equal(yield* f.store.baseline(), null);assert.equal(yield* f.store.activation(), null);
  assert.equal((yield* f.store.settings("p")).modelSelection.model, "chosen-default");assert.ok((yield* query(f.sql, "SELECT id FROM supervisor_owned_threads WHERE id=?", oldOwned))[0]);
  assert.equal((yield* query(f.sql, "SELECT id FROM unrelated_delivery"))[0]?.id, "retained");
  yield* f.store.baseline({snapshotSequence: 50, threads: [{id: "main", latestRunId: "old-run"}]});
  yield* constructSupervisorStore(f.process);assert.equal((yield* f.store.baseline())?.snapshotSequence, 50, "normal restarts do not reset the new scope");
}));


it.effect("background provider work, completion delivery, goals and PR watches all prevent parking", () => Effect.gen(function* () {
  for (const kind of ["roster", "delivery", "goal", "watch"]) {
    const f = yield* fixture;yield* f.check(1);
    if (kind === "roster") f.main.providerThreads = [{id: "provider", pendingBackgroundTasks: [{kind: "task", id: "background"}]}];
    if (kind === "delivery") f.main.subagents = [{status: "completed", completionDelivery: {state: "pending"}}];
    if (kind === "goal") f.main.providerThreads = [{id: "provider", goal: {status: "active"}}];
    if (kind === "watch") f.main.thread.pullRequests = [{watch: {state: "watching"}}];
    yield* f.check(100_000);assert.equal(f.calls.length, 0, kind);
  }
}), { timeout: 60_000 });

it.effect("new activity supersedes an unresolved parking epoch without replacing the Supervisor", () => Effect.gen(function* () {
  const f = yield* fixture;f.setUncertain();yield* f.check(1);yield* f.check(100_000);
  f.supervisor.thread.updatedAt = "2026-10-14T11:00:00Z";
  yield* f.check(200_000);assert.equal((yield* f.store.binding("p", "main"))?.settlement?.state, "superseded");
  assert.equal((yield* f.store.binding("p", "main"))?.threadId, f.binding.threadId);
}));

it.effect("an accepted settlement without a visible native settlement retains its uncertain identity", () => Effect.gen(function* () {
  const f = yield* fixture;
  const lifecycle = yield* lifecycleOver(f.process, {read: id => Effect.sync(() => f.projections.get(id)!), rpc: () => Effect.succeed({sequence: 20})});
  yield* checkAt(lifecycle, f, 1);
  yield* checkAt(lifecycle, f, 100_000);
  assert.equal((yield* f.store.binding("p", "main"))?.settlement?.state, "uncertain");
}));

it.effect("an unknown scope version disables supervision without resetting the private database", () => Effect.gen(function* () {
  const f = yield* fixture;
  yield* execute(f.sql, "UPDATE meta SET value='future' WHERE key='supervisor_scope_version'");
  const incompatible = yield* constructSupervisorStore(f.process);
  assert.equal(incompatible.scopeCompatible, false);assert.equal((yield* f.store.binding("p", "main"))?.threadId, f.binding.threadId);assert.equal((yield* f.store.baseline())?.snapshotSequence, 10);
}));

it.effect("idle runless nested workers use their actual parent's native lifecycle records", () => Effect.gen(function* () {
  const f = yield* fixture;
  const child = thread("z-child", "main", "subagent");const nested = thread("a-nested", "z-child", "subagent", "main");
  f.threads.push(nested, child);
  f.main.subagents = [{childThreadId: child.id, status: "idle"}];
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: [{childThreadId: nested.id, status: "completed"}]});
  f.projections.set(nested.id, {thread: nested, runs: [], messages: [], subagents: []});
  yield* f.check(1);yield* f.check(100_000);assert.equal(f.calls.length, 1);
}));


it.effect("an unsent introduction blocks ordinary settlement while monitoring is idle", () => Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.requests.saveIntroduction({taskId: "task", projectId: "p", threadId: "main", supervisorThreadId: f.binding.threadId, state: "ready", text: "Intro", messageId: "intro", targetRunId: null, error: null});
  yield* f.check(1);yield* f.check(100_000);assert.equal(f.calls.length, 0, "the unsent introduction remains a blocker");
  assert.equal((yield* f.requests.introduction("task"))?.state, "ready");
}));

it.effect("a stopped chat settles only its owned Supervisor once idle, whatever the main or its supervision state is doing", () => Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.stopChat("main");
  f.main.runs[0]!.status = "running";
  f.main.thread.activeRunId = "run";
  const task = (yield* f.store.task("main"))!;
  yield* f.store.saveTask({...task, definitionReview: {status: "checking", message: "Definitions changed.", expectedRevision: "a", observedRevision: "b",
    supervisorMessageId: null, userMessageIds: [], updatedAt: 1}});
  yield* f.check(10);
  assert.equal((yield* f.store.binding("p", "main"))?.settlement?.state, "settled");
  yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.deepEqual(f.calls.map(call => [call.type, call.threadId]), [["thread.settle", f.binding.threadId]],
    "the stopped main keeps running untouched; only the service-owned Supervisor is settled");
  assert.equal((yield* f.store.binding("p", "main"))?.threadId, f.binding.threadId, "the same Supervisor identity is retained for a later explicit enable");
}));

it.effect("a stopped chat's Supervisor waits while it is busy, while any accepted delivery is unresolved, and while a later user choice keeps it active", () => Effect.gen(function* () {
  const busy = yield* fixture;
  yield* busy.stopChat("main");
  busy.supervisor.runs.push({id: "root-run", ordinal: 1, status: "running", requestedAt: "2026-10-14T10:00:00Z", startedAt: "2026-10-14T10:00:00Z", completedAt: null, rootNodeId: "root"});
  busy.supervisor.thread.activeRunId = "root-run";
  yield* busy.check(10);yield* busy.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(busy.calls.length, 0, "a running Supervisor turn is never settled");

  for (const state of ["sending", "waiting", "uncertain"] as const) {
    const unresolved = yield* fixture;
    yield* unresolved.stopChat("main");
    const request = yield* unresolved.requests.prepare({projectId: "p", supervisorThreadId: unresolved.binding.threadId, kind: "review", taskId: null,
      text: "check-in", batch: null, completionMarker: "check-in completed"}, 5);
    yield* unresolved.requests.saveRequest({...request, state, sentAt: 5});
    for (const now of [10, 10 + SUPERVISOR_SETTLE_QUIET_MS, 10 + 10 * SUPERVISOR_SETTLE_QUIET_MS]) yield* unresolved.check(now);
    assert.equal(unresolved.calls.length, 0, `an idle Supervisor with a ${state} delivery is never settled, however old the delivery is`);
    assert.equal((yield* unresolved.store.binding("p", "main"))?.settlementBlockedBy, "stopped_request_unresolved");
    assert.equal((yield* unresolved.requests.requests("p", unresolved.binding.threadId)).find(item => item.id === request.id)?.state, state,
      "waiting never rewrites the unknown delivery identity");
    yield* unresolved.requests.saveRequest({...request, state: "completed", sentAt: 5});
    yield* unresolved.check(20 * SUPERVISOR_SETTLE_QUIET_MS);yield* unresolved.check(21 * SUPERVISOR_SETTLE_QUIET_MS);
    assert.deepEqual(unresolved.calls.map(call => call.threadId), [unresolved.binding.threadId], "a confirmed outcome releases the owned Supervisor");
  }

  const stoppedAt = Date.parse("2026-10-14T11:00:00Z");
  const kept = yield* fixture;
  yield* kept.stopChat("main");
  yield* kept.store.setSupervisionStop(kept.binding, {route: "direct", callerThreadId: kept.binding.threadId, userMessageId: "stop", stoppedAt});
  kept.supervisor.thread.pinnedAt = "2026-10-14T11:00:05Z";
  yield* kept.check(10);yield* kept.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(kept.calls.length, 0, "a pin made after the stop is a newer human decision");
  assert.equal((yield* kept.store.binding("p", "main"))?.settlementBlockedBy, "keep_active");

  const reopened = yield* fixture;
  yield* reopened.stopChat("main");
  yield* reopened.store.setSupervisionStop(reopened.binding, {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt});
  Object.assign(reopened.supervisor.thread, {settledOverride: "active", unsettledAt: "2026-10-14T11:30:00Z"});
  yield* reopened.check(10);yield* reopened.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(reopened.calls.length, 0, "a human who reactivates the settled Supervisor after the stop is never overridden");
}), { timeout: 60_000 });

it.effect("a later human stop supersedes every earlier keep-active choice for the owned Supervisor, and the main stays untouched", () => Effect.gen(function* () {
  const stoppedAt = Date.parse("2026-10-14T11:00:00Z");
  for (const earlier of [{pinnedAt: "2026-10-14T10:00:00Z"}, {autoSettleDisabledAt: "2026-10-14T10:00:00Z"},
    {settledOverride: "active", unsettledAt: "2026-10-14T10:00:00Z"}, {settledOverride: "active", unsettledAt: null}]) {
    const f = yield* fixture;
    yield* f.stopChat("main");
    Object.assign(f.supervisor.thread, earlier);
    yield* f.store.setBinding({...(yield* f.store.binding("p", "main"))!, manualKeepActive: true});
    yield* f.store.setSupervisionStop(f.binding, {route: "chat", callerThreadId: "other-chat", userMessageId: "stop", stoppedAt});
    yield* f.check(10);yield* f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
    assert.deepEqual(f.calls.map(call => [call.type, call.threadId]), [["thread.settle", f.binding.threadId]], `${JSON.stringify(earlier)} predates the stop`);
  }

  const observed = yield* fixture;
  yield* observed.stopChat("main");
  observed.supervisor.thread.pinnedAt = "2026-10-14T10:00:00Z";
  const firstSeen = Date.parse("2026-10-14T12:00:00Z");
  yield* observed.check(firstSeen);
  assert.equal((yield* observed.store.binding("p", "main"))?.stopObservedAt, firstSeen, "a stop without a recorded time dates from its first observation");
  yield* observed.check(firstSeen + SUPERVISOR_SETTLE_QUIET_MS);
  assert.deepEqual(observed.calls.map(call => [call.type, call.threadId]), [["thread.settle", observed.binding.threadId]]);
}), { timeout: 60_000 });
