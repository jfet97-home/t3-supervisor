import assert from "node:assert/strict";
import { it } from "vitest";
import { after, mockMethod } from "./support/node-test.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuidanceStore } from "../src/guidance-store.js";
import { ProjectSupervisorStore, defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { resolveSteerableRun, SupervisorConversation } from "../src/supervisor-conversation.js";
import { SupervisorLifecycle, SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import { mainConversation, resolveSupervisorScope } from "../src/supervisor-scope.js";
import { childOrigin, delegatedLifecycle, directParentChildLifecycle, normalizeLifecycle, observeScopeThread } from "../src/supervisor-observation.js";
import { T3TransportError } from "../src/t3.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";

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

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-scopes-"));
  const guidance = new GuidanceStore(directory);const store = new ProjectSupervisorStore(guidance, new Set());
  store.baseline({snapshotSequence: 10, threads: []});
  const binding = {...store.reserve("p", "main", "Main", defaultSupervisorModel, 10, 1), state: "ready" as const};store.setBinding(binding);
  const main: Projection = {thread: thread("main"), runs: [{id: "run", ordinal: 1, status: "completed", requestedAt: "2026-10-14T10:00:00Z", startedAt: "2026-10-14T10:00:00Z", completedAt: "2026-10-14T10:01:00Z", rootNodeId: "root"}], messages: [], runtimeRequests: [], subagents: []};
  const supervisor: Projection = {thread: thread(binding.threadId), runs: [], messages: [], runtimeRequests: [], subagents: []};
  const projections = new Map([["main", main], [binding.threadId, supervisor]]);
  const threads = [main.thread, supervisor.thread];const calls: Array<Record<string, unknown>> = [];const failures = new Map<string, unknown>();
  let projectionReads = 0;
  const workflows = new WorkflowStateStore(store, () => true);
  let uncertain = false;
  const project = async (id: string) => {projectionReads++;const failure = failures.get(id);if (failure) throw failure;const p = projections.get(id);if (!p) throw new Error("unreadable");return p;};
  const rpc = async (_tag: string, payload: Record<string, unknown>) => {calls.push(payload);if (uncertain) throw new Error("lost receipt");supervisor.thread.settledAt = "2026-10-14T10:02:00Z";supervisor.thread.settledOverride = "settled";return {sequence: 11};};
  const conversation = new SupervisorConversation(store, rpc, project, undefined, () => true, () => true, workflows);
  store.saveTask({id: "task", projectId: "p", threadId: "main", sourceRunId: "run", sourceMessageId: "source", sourceHash: "hash", sourceOrdinal: 1, supervisorThreadId: binding.threadId,
    messageId: "interpretation", status: "inferred", objective: "Implement", reason: "Requested", updatedAt: 1, requestText: "", dispatchedAt: null, supervisorRunId: null, replayCount: 0});
  const lifecycle = new SupervisorLifecycle(store, conversation, project, rpc, workflows);
  return {guidance, store, binding, conversation, lifecycle, workflows, main, supervisor, projections, threads, calls, projectionReads: () => projectionReads,
    setUncertain: () => {uncertain = true;}, setFailure: (id: string, error: unknown | null) => {if (error) failures.set(id, error);else failures.delete(id);},
    check: (now: number) => lifecycle.check(store.binding("p", "main")!, threads, AbortSignal.timeout(1000), now),
    cleanup: async () => {guidance.close();await rm(directory, {recursive: true, force: true});}};
};

it("requests, cooldowns, retry misses and model readback are isolated for two mains", async t => {
  const f = await fixture();after(t, f.cleanup);
  const second = f.store.reserve("p", "other", "Other", defaultSupervisorModel, 10, 2);
  const request = (id: string) => ({projectId: "p", supervisorThreadId: id, kind: "review" as const, taskId: null, text: "Review", batch: null, completionMarker: "done"});
  const a = f.conversation.requests.prepare(request(f.binding.threadId), 3);
  const b = f.conversation.requests.prepare(request(second.threadId), 4);
  f.conversation.requests.saveRequest({...a, state: "uncertain"});
  f.conversation.requests.noticeSent(f.binding.threadId, 100);f.conversation.requests.missedReview(f.binding.threadId);
  f.conversation.retry("p", second.threadId);
  assert.equal(f.conversation.requests.pending("p", f.binding.threadId)?.state, "uncertain");
  assert.equal(f.conversation.requests.pending("p", second.threadId)?.id, b.id);
  assert.equal(f.conversation.requests.lastNotice(second.threadId), null);
  assert.equal(f.conversation.requests.reviewMisses(second.threadId), 0);
  assert.equal(f.conversation.requests.reviewMisses(f.binding.threadId), 1);
  f.store.observeModel(f.binding, {...defaultSupervisorModel, model: "another"});
  assert.equal(f.store.modelState(second).modelSelection.model, defaultSupervisorModel.model);
  assert.equal(f.store.settings("p").modelSelection.model, defaultSupervisorModel.model);
});

it("completion parks an owned Supervisor after the quiet window and retains identity", async t => {
  const f = await fixture();after(t, f.cleanup);
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS - 1);assert.equal(f.calls.length, 0);
  await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);assert.equal(f.calls[0]?.type, "thread.settle");assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
  assert.equal(f.store.task("main")?.status, "inferred");
  delete f.supervisor.thread.settledAt;f.supervisor.thread.settledOverride = null;
  f.main.runs[0]!.status = "running";
  await f.check(200_000);assert.equal(f.store.binding("p", "main")?.quietSince, null);
  assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
});

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

it("queued requests cancelled before starting do not hide the completed executed main run from settlement", async t => {
  const f = await fixture();after(t, f.cleanup);
  f.main.runs = executedRunHistory({status: "completed", startedAt: "2026-10-14T10:41:00Z"});
  await f.check(10);
  assert.equal(f.store.binding("p", "main")?.settlementBlockedBy, "quiet_window");
  await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.deepEqual(f.calls.map(call => [call.type, call.threadId]), [["thread.settle", f.binding.threadId]], "only the service-owned root is settled");
  assert.equal(f.store.binding("p", "main")?.settlementBlockedBy, null);
});

it("a failed, cancelled-after-start or interrupted executed main run, or a later queued request, still blocks settlement behind unstarted cancellations", async t => {
  for (const latestExecuted of [{status: "failed", startedAt: "2026-10-14T10:41:00Z"}, {status: "cancelled", startedAt: "2026-10-14T10:41:00Z"},
    {status: "interrupted", startedAt: "2026-10-14T10:41:00Z"}]) {
    const f = await fixture();after(t, f.cleanup);
    f.main.runs = executedRunHistory(latestExecuted);
    await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
    assert.equal(f.calls.length, 0, latestExecuted.status);
    assert.equal(f.store.binding("p", "main")?.settlementBlockedBy, "main_run_not_completed", latestExecuted.status);
  }
  const f = await fixture();after(t, f.cleanup);
  f.main.runs = [...executedRunHistory({status: "completed", startedAt: "2026-10-14T10:41:00Z"}),
    {id: "run-9", ordinal: 9, status: "queued", requestedAt: "2026-10-14T10:56:00Z", startedAt: null, completedAt: null, rootNodeId: null}];
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0, "a queued request is pending work, not an unstarted cancellation");
});

it("a busy main short-circuits child projection reads even with a large known descendant set", async t => {
  const f = await fixture();after(t, f.cleanup);
  f.main.runs[0]!.status = "running";
  for (let index = 0; index < 100; index++) {
    const child = {...thread(`busy-child-${index}`, "main", "subagent", "main"), projectId: null, creationSource: "provider"};
    f.threads.push(child);
    f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  }
  const before = f.projectionReads();
  await f.check(10);
  assert.equal(f.projectionReads() - before, 2, "only the Supervisor and main projections are read before the main-busy blocker returns");
  assert.equal(f.calls.length, 0);
});

it("pending child monitor activity blocks standby before any descendant projection reads", async t => {
  const f = await fixture();after(t, f.cleanup);
  const child = {...thread("pending-child", "main", "subagent", "main"), projectId: null, creationSource: "provider"};
  f.threads.push(child);
  const projection: Projection = {thread: child, runs: [], messages: [], subagents: [], turnItems: [{id: "pending-child-command", threadId: child.id,
    runId: null, type: "command_execution", status: "completed", ordinal: 1, completedAt: "2026-10-14T10:02:00Z", updatedAt: "2026-10-14T10:02:00Z"}]};
  f.projections.set(child.id, projection);
  f.conversation.monitor.observe({projectId: "p", threadId: child.id, sourceOrdinal: 1, projection, includeDetachedChildItems: true, now: 1});
  const before = f.projectionReads();
  await f.check(10);
  assert.equal(f.conversation.monitor.pending("p", child.id).length, 1);
  assert.equal(f.projectionReads() - before, 2);
  assert.equal(f.calls.length, 0);
});

it("a not-needed request's Supervisor settles over retained unreviewed scope activity, which a supervised task still waits for", async t => {
  for (const status of ["not_supervised", "needs_context", "inferred"] as const) {
    const f = await fixture();after(t, f.cleanup);
    f.store.saveTask({...f.store.task("main")!, status});
    // activity in the main's scope left unreviewed by an earlier supervised request
    const child = {...thread("leftover-child", "main", "subagent", "main"), projectId: null, creationSource: "provider"};
    f.threads.push(child);
    const projection: Projection = {thread: child, runs: [], messages: [], subagents: [], turnItems: [{id: "leftover-command", threadId: child.id,
      runId: null, type: "command_execution", status: "completed", ordinal: 1, completedAt: "2026-10-14T10:00:30Z", updatedAt: "2026-10-14T10:00:30Z"}]};
    f.projections.set(child.id, projection);
    f.conversation.monitor.observe({projectId: "p", threadId: child.id, sourceOrdinal: 1, projection, includeDetachedChildItems: true, now: 1});
    assert.equal(f.conversation.status("p", f.binding.threadId).pendingItems, 0, `${status}: the dashboard counts no pending items`);
    await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
    if (status === "inferred") {
      assert.equal(f.calls.length, 0, "a supervised task waits for its activity to be reviewed");
      assert.equal(f.store.binding("p", "main")?.settlementBlockedBy, "pending_activity");
    } else {
      assert.deepEqual(f.calls.map(call => call.type), ["thread.settle"], status);
    }
    assert.equal(f.conversation.monitor.pending("p", child.id).length, 1, `${status}: the retained activity is not acknowledged or erased`);
  }
});

it("a not-needed request's Supervisor ignores a replaced task's known-unsent draft but not an unknown or current introduction, and an incomplete scan stays closed", async t => {
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
    const f = await fixture();after(t, f.cleanup);
    f.store.saveTask({...f.store.task("main")!, status: "not_supervised"});
    f.conversation.requests.saveIntroduction({...item.intro, supervisorThreadId: f.binding.threadId} as never);
    await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
    assert.equal(f.calls.length, item.blockedBy ? 0 : 1, item.name);
    if (item.blockedBy) assert.equal(f.store.binding("p", "main")?.settlementBlockedBy, item.blockedBy, item.name);
    assert.ok(f.conversation.requests.introduction(item.intro.taskId), `${item.name}: the introduction record is kept`);
  }
  const f = await fixture();after(t, f.cleanup);
  f.store.saveTask({...f.store.task("main")!, status: "not_supervised"});
  mockMethod(t, f.conversation.monitor, "hasPendingReviewableActivity", () => ({status: "incomplete"}));
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0, "an incomplete activity scan never permits settlement");
  assert.equal(f.store.binding("p", "main")?.settlementBlockedBy, "pending_activity");
});

it("archived mains absent from the active catalog set aside the same Supervisor and retain unfinished semantic records", async t => {
  const f = await fixture();after(t, f.cleanup);
  f.main.thread.archivedAt = "2026-10-14T10:02:00Z";f.main.thread.updatedAt = "2026-10-14T10:02:00Z";
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  f.store.saveTask({...f.store.task("main")!, status: "queued", objective: null, workflow: null, agreement: null});
  const prepared = {id: "prepared-id", projectId: "p", supervisorThreadId: f.binding.threadId, kind: "review" as const, taskId: "task", text: "Prepared request", messageId: "prepared-message",
    state: "prepared" as const, batch: null, createdAt: 1, sentAt: null, runId: null, error: null, completionMarker: "prepared done"};
  const uncertain = {...prepared, id: "unknown-id", messageId: "unknown-message", state: "uncertain" as const, text: "Unknown request"};
  f.conversation.requests.saveRequest(prepared);f.conversation.requests.saveRequest(uncertain);
  f.conversation.requests.saveIntroduction({taskId: "task", projectId: "p", threadId: "main", supervisorThreadId: f.binding.threadId, state: "ready", text: "Unsent introduction", messageId: "intro", targetRunId: null, error: null});
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
  assert.deepEqual(f.conversation.requests.requests("p", f.binding.threadId).map(request => [request.id, request.state]), [["prepared-id", "prepared"], ["unknown-id", "uncertain"]]);
  assert.equal(f.conversation.requests.introduction("task")?.state, "ready");assert.equal(f.store.task("main")?.status, "queued");
});

it("a confirmed missing main closes a runless native child whose parent projection is gone", async t => {
  const f = await fixture();after(t, f.cleanup);f.setFailure("main", new T3TransportError("deleted", 404));
  const child = thread("child", "main", "subagent", "main");f.threads.push(child);
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  assert.equal(await f.lifecycle.readMain(f.binding, AbortSignal.timeout(1000)), null);
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
});

it("readMain rejects projections whose thread or project identity does not match the binding", async t => {
  const f = await fixture();after(t, f.cleanup);
  f.main.thread.id = "other";await assert.rejects(f.lifecycle.readMain(f.binding, AbortSignal.timeout(1000)), /main_scope_mismatch/);
  f.main.thread.id = "main";f.main.thread.projectId = "other-project";
  await assert.rejects(f.lifecycle.readMain(f.binding, AbortSignal.timeout(1000)), /main_scope_mismatch/);
});

it("transient main reads clear the quiet epoch and fail closed", async t => {
  const f = await fixture();after(t, f.cleanup);f.setFailure("main", new T3TransportError("unavailable", 503));
  await assert.rejects(f.lifecycle.readMain(f.binding, AbortSignal.timeout(1000)), error => error instanceof T3TransportError && error.httpStatus === 503);
  await f.check(10);assert.equal(f.calls.length, 0);assert.equal(f.store.binding("p", "main")?.quietSince, null);
  f.setFailure("main", null);await f.check(100_000);assert.equal(f.calls.length, 0);
  await f.check(100_000 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
});

it("archived mains stay active while a cataloged direct or nested descendant is busy", async t => {
  for (const kind of ["running", "background"] as const) {
    const f = await fixture();after(t, f.cleanup);
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
    await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0, kind);
  }
});

it("more than one hundred quiet descendants become cache-validated instead of permanently blocking parking", async t => {
  const f = await fixture();after(t, f.cleanup);
  f.main.subagents = [];
  for (let index = 0; index < 101; index++) {
    const child = {...thread(`quiet-child-${String(index).padStart(3, "0")}`, "main", "subagent", "main"), projectId: null, creationSource: "provider"};
    f.threads.push(child);
    f.main.subagents.push({childThreadId: child.id, status: "completed"});
    f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  }
  await f.check(10);assert.equal(f.calls.length, 0, "the first bounded pass leaves one child for the next rotation");
  await f.check(20);assert.equal(f.calls.length, 0);
  await f.check(20 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);
});

it("a live delegated child beyond the first lifecycle scan page still blocks parking when rotation reaches it", async t => {
  const f = await fixture();after(t, f.cleanup);
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

  await f.check(10);assert.equal(f.calls.length, 0);
  await f.check(20);assert.equal(f.calls.length, 0);
  assert.equal(f.store.binding("p", "main")?.quietSince, null);
});

it("nested descendants inherit historical roots but remain children of the bound main", async t => {
  const f = await fixture();after(t, f.cleanup);
  f.main.thread.lineage.rootThreadId = "historical-root";f.main.thread.archivedAt = "2026-10-14T10:02:00Z";
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  const child = thread("child", "main", "subagent", "historical-root");
  const grandchild = thread("grandchild", "child", "subagent", "historical-root");
  f.threads.push(child, grandchild);
  f.projections.set(child.id, {thread: child, runs: [{...f.main.runs[0]!, id: "child-run"}], messages: [], subagents: [{childThreadId: grandchild.id, status: "completed"}]});
  f.projections.set(grandchild.id, {thread: grandchild, runs: [{...f.main.runs[0]!, id: "grandchild-run", status: "running"}], messages: [], subagents: []});
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0);
});

it("an active nested grandchild under an independent fork is outside the bound main scope", async t => {
  const f = await fixture();after(t, f.cleanup);f.main.thread.lineage.rootThreadId = "historical-root";
  const forkMain = thread("fork-main", "main", "fork", "historical-root");
  const forkChild = thread("fork-child", "fork-main", "subagent", "historical-root");
  const forkGrandchild = thread("fork-grandchild", "fork-child", "subagent", "historical-root");
  f.threads.push(forkMain, forkChild, forkGrandchild);
  f.projections.set(forkMain.id, {thread: forkMain, runs: [{...f.main.runs[0]!, id: "fork-main-run"}], messages: [], subagents: []});
  f.projections.set(forkChild.id, {thread: forkChild, runs: [{...f.main.runs[0]!, id: "fork-child-run"}], messages: [], subagents: [{childThreadId: forkGrandchild.id, status: "running"}]});
  f.projections.set(forkGrandchild.id, {thread: forkGrandchild, runs: [{...f.main.runs[0]!, id: "fork-grandchild-run", status: "running"}], messages: [], subagents: []});
  assert.equal(mainConversation(forkGrandchild, f.threads)?.id, forkMain.id);
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
});

it("normal main settlement honors the active catalog shell's background work", async t => {
  const f = await fixture();after(t, f.cleanup);
  const sourceShell = {...f.main.thread, pendingBackgroundTasks: [{kind: "task", id: "background"}]};
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1, sourceShell);
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0);
});

it("T3 deletion closes a still-running child scope after the main returns confirmed 404", async t => {
  const f = await fixture();after(t, f.cleanup);f.setFailure("main", new T3TransportError("deleted", 404));
  const child = thread("child", "main", "subagent", "main");f.threads.push(child);
  f.projections.set(child.id, {thread: child, runs: [{...f.main.runs[0]!, id: "child-run", status: "running"}], messages: [], subagents: []});
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
});

it("an archived but natively busy main cannot be set aside", async t => {
  const f = await fixture();after(t, f.cleanup);f.main.thread.archivedAt = "2026-10-14T10:02:00Z";f.main.runs[0]!.status = "running";
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0);
});

it("an active native child blocks settlement through its direct parent despite an idle child mirror", async t => {
  const f = await fixture();after(t, f.cleanup);
  const child = {...thread("native-child", "main", "subagent", "main"), projectId: null,
    creationSource: "provider", latestRunId: null, activeRunId: null};
  f.threads.push(child);
  f.main.subagents = [{childThreadId: child.id, status: "running"}];
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0);
  f.main.subagents[0]!.status = "completed";
  await f.check(10 + 2 * SUPERVISOR_SETTLE_QUIET_MS);
  await f.check(10 + 3 * SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);
});

for (const requestStatus of ["resolved", "expired", "cancelled"] as const) {
  it(`a matched ${requestStatus} child request clears stale detached waiting state`, async t => {
    const f = await fixture();after(t, f.cleanup);
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

    await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
    assert.equal(f.calls.length, 1, "terminal native request evidence supersedes stale waiting mirrors");
  });
}

it("a fresh pending child request still blocks settlement", async t => {
  const f = await fixture();after(t, f.cleanup);
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

  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0);
});

it("quiet children with unknown lifecycle do not prevent standby while ongoing T3 effects still do", async t => {
  const f = await fixture();after(t, f.cleanup);
  const child = {...thread("old-child", "main", "subagent", "main"), projectId: null,
    creationSource: "provider", latestRunId: null, activeRunId: null};
  f.threads.push(child);
  f.main.subagents = [{childThreadId: child.id, status: "unknown"}];
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  await f.check(1);await f.check(1 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);

  const busyFixture = await fixture();after(t, busyFixture.cleanup);
  busyFixture.main.subagents = [{childThreadId: "unresolved", status: "unknown", completionDelivery: {state: "pending"}}];
  await busyFixture.check(1);await busyFixture.check(1 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(busyFixture.calls.length, 0);
});

it("known workflow needs-attention status blocks standby even when all T3 chats are quiet", async t => {
  const f = await fixture();after(t, f.cleanup);
  const owner = {projectId: "p", mainThreadId: "main", supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation};
  const created = f.store.store.transaction(() => f.workflows.ensureMainInTransaction(owner, "workflow-attention-main", "Known issue", 1));
  assert.equal(created.status, "created");
  const document = f.workflows.get("p", "main");assert.ok(document);
  f.guidance.db.prepare("UPDATE supervisor_workflow_state SET document=?,updated_at=? WHERE workflow_id=?")
    .run(JSON.stringify({...document, status: "needs_attention"}), 2, document.workflowId);
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0);
});

it("unknown intermediate child ancestry blocks closed-main settlement", async t => {
  const f = await fixture();after(t, f.cleanup);f.main.thread.archivedAt = "2026-10-14T10:02:00Z";
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  f.threads.push(thread("nested", "missing-parent", "subagent", "main"));
  await f.check(10);assert.equal(f.calls.length, 0);assert.equal(f.store.binding("p", "main")?.quietSince, null);
});

it("a confirmed missing ancestor terminates an unrelated orphan subagent chain", async t => {
  const f = await fixture();after(t, f.cleanup);f.setFailure("deleted-parent", new T3TransportError("deleted", 404));
  f.threads.push(thread("orphan", "deleted-parent", "subagent", "historical-root"));
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
});

it("reopening the same main cancels its closed-source quiet epoch and retains binding identity", async t => {
  const f = await fixture();after(t, f.cleanup);f.main.thread.archivedAt = "2026-10-14T10:02:00Z";f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  await f.check(10);assert.equal(f.store.binding("p", "main")?.quietSince, 10);
  delete f.main.thread.archivedAt;f.main.thread.updatedAt = "2026-10-14T10:03:00Z";f.threads.push(f.main.thread);
  await f.check(20);assert.equal(f.calls.length, 0);assert.equal(f.store.binding("p", "main")?.quietSince, 20);
  assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
  await f.check(20 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
});

it("a fresh main read that observes reopening cancels closed-source settlement", async t => {
  const f = await fixture();after(t, f.cleanup);
  const archived: Projection = {...f.main, thread: {...f.main.thread, archivedAt: "2026-10-14T10:02:00Z"}};
  const reopened: Projection = {...f.main, thread: {...f.main.thread, archivedAt: null, updatedAt: "2026-10-14T10:03:00Z"}};
  let mainReads = 0;
  const projection = async (id: string) => id === "main" ? (++mainReads <= 2 ? archived : reopened) : f.projections.get(id)!;
  const lifecycle = new SupervisorLifecycle(f.store, f.conversation, projection, async (_tag, payload) => {f.calls.push(payload);return {sequence: 20};});
  await lifecycle.check(f.binding, f.threads, AbortSignal.timeout(1000), 10);
  await lifecycle.check(f.binding, f.threads, AbortSignal.timeout(1000), 10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(mainReads, 3);assert.equal(f.calls.length, 0);assert.equal(f.store.binding("p", "main")?.quietSince, null);
});

for (const blocker of ["input", "main_running", "supervisor_queued", "child", "uncertain_request", "pin", "keep_active", "pending_review", "main_failed"] as const) {
  it(`automatic settlement preserves ${blocker}`, async t => {
    const f = await fixture();after(t, f.cleanup);await f.check(10);
    if (blocker === "input") f.supervisor.runtimeRequests = [{status: "pending", kind: "user_input"}];
    if (blocker === "main_running") f.main.runs[0]!.status = "running";
    if (blocker === "main_failed") f.main.runs[0]!.status = "failed";
    if (blocker === "supervisor_queued") f.supervisor.runs = [{...f.main.runs[0]!, status: "queued"}];
    if (blocker === "child") {const child = thread("child", "main", "subagent");f.threads.push(child);f.projections.set("child", {thread: child, runs: [{...f.main.runs[0]!, status: "running"}], messages: []});}
    if (blocker === "uncertain_request") {const r = f.conversation.requests.prepare({projectId: "p", supervisorThreadId: f.binding.threadId, kind: "review", taskId: null, text: "Review", batch: null, completionMarker: "done"}, 1);f.conversation.requests.saveRequest({...r, state: "uncertain"});}
    if (blocker === "pin") f.supervisor.thread.pinnedAt = "2026-10-14T10:00:00Z";
    if (blocker === "keep_active") f.supervisor.thread.settledOverride = "active";
    if (blocker === "pending_review") f.conversation.monitor.store.db.exec("UPDATE supervisor_monitor_threads SET saturated=1");
    if (blocker === "pending_review") {const r = f.conversation.requests.prepare({projectId: "p", supervisorThreadId: f.binding.threadId, kind: "review", taskId: null, text: "Review", batch: null, completionMarker: "done"}, 1);f.conversation.requests.saveRequest({...r, state: "failed", error: "Unconfirmed"});}
    await f.check(100_000);assert.equal(f.calls.length, 0);
  });
}

it("unknown settlement reconciles visibility without deletion or repeated commands", async t => {
  const f = await fixture();after(t, f.cleanup);f.setUncertain();await f.check(1);await f.check(100_000);
  assert.equal(f.store.binding("p", "main")?.settlement?.state, "uncertain");
  const id = f.store.binding("p", "main")?.settlement?.commandId;
  await f.check(200_000);assert.equal(f.calls.length, 2);assert.equal(f.calls[1]?.commandId, id);
  f.supervisor.thread.settledAt = "2026-10-14T10:00:00Z";await f.check(300_000);
  assert.equal(f.store.binding("p", "main")?.settlement?.state, "settled");assert.equal(f.store.binding("p", "main")?.settlement?.commandId, id);
});

it("the one-time disposable reset clears discovery together and preserves unrelated state", async t => {
  const f = await fixture();after(t, f.cleanup);
  f.store.saveSettings("p", 0, {...defaultSupervisorModel, model: "chosen-default"});
  const oldOwned = f.binding.threadId;
  f.guidance.db.exec("CREATE TABLE unrelated_delivery(id TEXT); INSERT INTO unrelated_delivery VALUES('retained'); CREATE TABLE supervisor_project_bindings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL); INSERT INTO supervisor_project_bindings VALUES('p','{}'); DELETE FROM meta WHERE key='supervisor_scope_version'");
  new ProjectSupervisorStore(f.guidance, new Set());
  assert.equal(f.store.bindings().length, 0);assert.equal(f.store.task("main"), null);assert.equal(f.store.baseline(), null);assert.equal(f.store.activation(), null);
  assert.equal(f.store.settings("p").modelSelection.model, "chosen-default");assert.ok(f.guidance.db.prepare("SELECT id FROM supervisor_owned_threads WHERE id=?").get(oldOwned));
  assert.equal(f.guidance.db.prepare("SELECT id FROM unrelated_delivery").get()?.id, "retained");
  f.store.baseline({snapshotSequence: 50, threads: [{id: "main", latestRunId: "old-run"}]});
  new ProjectSupervisorStore(f.guidance, new Set());assert.equal(f.store.baseline()?.snapshotSequence, 50, "normal restarts do not reset the new scope");
});


it("background provider work, completion delivery, goals and PR watches all prevent parking", async t => {
  for (const kind of ["roster", "delivery", "goal", "watch"]) {
    const f = await fixture();after(t, f.cleanup);await f.check(1);
    if (kind === "roster") f.main.providerThreads = [{id: "provider", pendingBackgroundTasks: [{kind: "task", id: "background"}]}];
    if (kind === "delivery") f.main.subagents = [{status: "completed", completionDelivery: {state: "pending"}}];
    if (kind === "goal") f.main.providerThreads = [{id: "provider", goal: {status: "active"}}];
    if (kind === "watch") f.main.thread.pullRequests = [{watch: {state: "watching"}}];
    await f.check(100_000);assert.equal(f.calls.length, 0, kind);
  }
});

it("new activity supersedes an unresolved parking epoch without replacing the Supervisor", async t => {
  const f = await fixture();after(t, f.cleanup);f.setUncertain();await f.check(1);await f.check(100_000);
  f.supervisor.thread.updatedAt = "2026-10-14T11:00:00Z";
  await f.check(200_000);assert.equal(f.store.binding("p", "main")?.settlement?.state, "superseded");
  assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
});

it("an accepted settlement without a visible native settlement retains its uncertain identity", async t => {
  const f = await fixture();after(t, f.cleanup);
  const lifecycle = new SupervisorLifecycle(f.store, f.conversation, async id => f.projections.get(id)!, async () => ({sequence: 20}));
  await lifecycle.check(f.binding, f.threads, AbortSignal.timeout(1000), 1);
  await lifecycle.check(f.binding, f.threads, AbortSignal.timeout(1000), 100_000);
  assert.equal(f.store.binding("p", "main")?.settlement?.state, "uncertain");
});

it("an unknown scope version disables supervision without resetting the private database", async t => {
  const f = await fixture();after(t, f.cleanup);
  f.guidance.db.prepare("UPDATE meta SET value='future' WHERE key='supervisor_scope_version'").run();
  const incompatible = new ProjectSupervisorStore(f.guidance, new Set());
  assert.equal(incompatible.scopeCompatible, false);assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);assert.equal(f.store.baseline()?.snapshotSequence, 10);
});

it("idle runless nested workers use their actual parent's native lifecycle records", async t => {
  const f = await fixture();after(t, f.cleanup);
  const child = thread("z-child", "main", "subagent");const nested = thread("a-nested", "z-child", "subagent", "main");
  f.threads.push(nested, child);
  f.main.subagents = [{childThreadId: child.id, status: "idle"}];
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: [{childThreadId: nested.id, status: "completed"}]});
  f.projections.set(nested.id, {thread: nested, runs: [], messages: [], subagents: []});
  await f.check(1);await f.check(100_000);assert.equal(f.calls.length, 1);
});


it("an unsent introduction blocks ordinary settlement while monitoring is idle", async t => {
  const f = await fixture();after(t, f.cleanup);
  f.conversation.requests.saveIntroduction({taskId: "task", projectId: "p", threadId: "main", supervisorThreadId: f.binding.threadId, state: "ready", text: "Intro", messageId: "intro", targetRunId: null, error: null});
  await f.check(1);await f.check(100_000);assert.equal(f.calls.length, 0, "the unsent introduction remains a blocker");
  assert.equal(f.conversation.requests.introduction("task")?.state, "ready");
});

it("a stopped chat settles only its owned Supervisor once idle, whatever the main or its supervision state is doing", async t => {
  const f = await fixture();after(t, f.cleanup);
  f.conversation.supervisionStopped = threadId => threadId === "main";
  f.main.runs[0]!.status = "running";
  f.main.thread.activeRunId = "run";
  const task = f.store.task("main")!;
  f.store.saveTask({...task, definitionReview: {status: "checking", message: "Definitions changed.", expectedRevision: "a", observedRevision: "b",
    supervisorMessageId: null, userMessageIds: [], updatedAt: 1}});
  await f.check(10);
  assert.equal(f.store.binding("p", "main")?.settlement?.state, "settled");
  await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.deepEqual(f.calls.map(call => [call.type, call.threadId]), [["thread.settle", f.binding.threadId]],
    "the stopped main keeps running untouched; only the service-owned Supervisor is settled");
  assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId, "the same Supervisor identity is retained for a later explicit enable");
});

it("a stopped chat's Supervisor waits while it is busy, while any accepted delivery is unresolved, and while a later user choice keeps it active", async t => {
  const busy = await fixture();after(t, busy.cleanup);
  busy.conversation.supervisionStopped = threadId => threadId === "main";
  busy.supervisor.runs.push({id: "root-run", ordinal: 1, status: "running", requestedAt: "2026-10-14T10:00:00Z", startedAt: "2026-10-14T10:00:00Z", completedAt: null, rootNodeId: "root"});
  busy.supervisor.thread.activeRunId = "root-run";
  await busy.check(10);await busy.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(busy.calls.length, 0, "a running Supervisor turn is never settled");

  for (const state of ["sending", "waiting", "uncertain"] as const) {
    const unresolved = await fixture();after(t, unresolved.cleanup);
    unresolved.conversation.supervisionStopped = threadId => threadId === "main";
    const request = unresolved.conversation.requests.prepare({projectId: "p", supervisorThreadId: unresolved.binding.threadId, kind: "review", taskId: null,
      text: "check-in", batch: null, completionMarker: "check-in completed"}, 5);
    unresolved.conversation.requests.saveRequest({...request, state, sentAt: 5});
    for (const now of [10, 10 + SUPERVISOR_SETTLE_QUIET_MS, 10 + 10 * SUPERVISOR_SETTLE_QUIET_MS]) await unresolved.check(now);
    assert.equal(unresolved.calls.length, 0, `an idle Supervisor with a ${state} delivery is never settled, however old the delivery is`);
    assert.equal(unresolved.store.binding("p", "main")?.settlementBlockedBy, "stopped_request_unresolved");
    assert.equal(unresolved.conversation.requests.requests("p", unresolved.binding.threadId).find(item => item.id === request.id)?.state, state,
      "waiting never rewrites the unknown delivery identity");
    unresolved.conversation.requests.saveRequest({...request, state: "completed", sentAt: 5});
    await unresolved.check(20 * SUPERVISOR_SETTLE_QUIET_MS);await unresolved.check(21 * SUPERVISOR_SETTLE_QUIET_MS);
    assert.deepEqual(unresolved.calls.map(call => call.threadId), [unresolved.binding.threadId], "a confirmed outcome releases the owned Supervisor");
  }

  const stoppedAt = Date.parse("2026-10-14T11:00:00Z");
  const kept = await fixture();after(t, kept.cleanup);
  kept.conversation.supervisionStopped = threadId => threadId === "main";
  kept.store.setSupervisionStop(kept.binding, {route: "direct", callerThreadId: kept.binding.threadId, userMessageId: "stop", stoppedAt});
  kept.supervisor.thread.pinnedAt = "2026-10-14T11:00:05Z";
  await kept.check(10);await kept.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(kept.calls.length, 0, "a pin made after the stop is a newer human decision");
  assert.equal(kept.store.binding("p", "main")?.settlementBlockedBy, "keep_active");

  const reopened = await fixture();after(t, reopened.cleanup);
  reopened.conversation.supervisionStopped = threadId => threadId === "main";
  reopened.store.setSupervisionStop(reopened.binding, {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt});
  Object.assign(reopened.supervisor.thread, {settledOverride: "active", unsettledAt: "2026-10-14T11:30:00Z"});
  await reopened.check(10);await reopened.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(reopened.calls.length, 0, "a human who reactivates the settled Supervisor after the stop is never overridden");
});

it("a later human stop supersedes every earlier keep-active choice for the owned Supervisor, and the main stays untouched", async t => {
  const stoppedAt = Date.parse("2026-10-14T11:00:00Z");
  for (const earlier of [{pinnedAt: "2026-10-14T10:00:00Z"}, {autoSettleDisabledAt: "2026-10-14T10:00:00Z"},
    {settledOverride: "active", unsettledAt: "2026-10-14T10:00:00Z"}, {settledOverride: "active", unsettledAt: null}]) {
    const f = await fixture();after(t, f.cleanup);
    f.conversation.supervisionStopped = threadId => threadId === "main";
    Object.assign(f.supervisor.thread, earlier);
    f.store.setBinding({...f.store.binding("p", "main")!, manualKeepActive: true});
    f.store.setSupervisionStop(f.binding, {route: "chat", callerThreadId: "other-chat", userMessageId: "stop", stoppedAt});
    await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
    assert.deepEqual(f.calls.map(call => [call.type, call.threadId]), [["thread.settle", f.binding.threadId]], `${JSON.stringify(earlier)} predates the stop`);
  }

  const observed = await fixture();after(t, observed.cleanup);
  observed.conversation.supervisionStopped = threadId => threadId === "main";
  observed.supervisor.thread.pinnedAt = "2026-10-14T10:00:00Z";
  const firstSeen = Date.parse("2026-10-14T12:00:00Z");
  await observed.check(firstSeen);
  assert.equal(observed.store.binding("p", "main")?.stopObservedAt, firstSeen, "a stop without a recorded time dates from its first observation");
  await observed.check(firstSeen + SUPERVISOR_SETTLE_QUIET_MS);
  assert.deepEqual(observed.calls.map(call => [call.type, call.threadId]), [["thread.settle", observed.binding.threadId]]);
});
