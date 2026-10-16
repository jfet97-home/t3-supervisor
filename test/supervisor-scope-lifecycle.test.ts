import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuidanceStore } from "../src/guidance-store.js";
import { ProjectSupervisorStore, defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { SupervisorConversation } from "../src/supervisor-conversation.js";
import { SupervisorLifecycle, SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import { mainConversation, resolveSupervisorScope } from "../src/supervisor-scope.js";
import { childOrigin, delegatedLifecycle, directParentChildLifecycle, normalizeLifecycle, observeScopeThread } from "../src/supervisor-observation.js";
import { T3TransportError } from "../src/t3.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";

const thread = (id: string, parent: string | null = null, relationship: string | null = null, rootThreadId = parent === "main" || id === "main" ? "main" : parent ?? id): ThreadInfo => ({id, title: id, projectId: "p", lineage: {parentThreadId: parent, relationshipToParent: relationship, rootThreadId}});

test("subagent ancestry shares the main scope while forks and separate launches keep their own", () => {
  const main = thread("main");const child = thread("child", "main", "subagent");const nested = thread("nested", "child", "subagent");
  const fork = thread("fork", "child", "fork");const independent = thread("new");
  const threads = [main, child, nested, fork, independent];
  assert.equal(mainConversation(nested, threads)?.id, "main");
  assert.equal(mainConversation(fork, threads)?.id, "fork");
  assert.equal(mainConversation(independent, threads)?.id, "new");
  assert.equal(mainConversation(child, [child]), null);
  assert.equal(mainConversation(thread("loop", "loop", "subagent"), [thread("loop", "loop", "subagent")]), null);
});

test("verified descendants with native published metadata attach across project mirrors and use their direct parent's lifecycle", () => {
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

test("an incomplete unrelated lineage retains verified sibling scope for read-only observation", () => {
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

test("requests, cooldowns, retry misses and model readback are isolated for two mains", async t => {
  const f = await fixture();t.after(f.cleanup);
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

test("completion parks an owned Supervisor after the quiet window and retains identity", async t => {
  const f = await fixture();t.after(f.cleanup);
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS - 1);assert.equal(f.calls.length, 0);
  await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);assert.equal(f.calls[0]?.type, "thread.settle");assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
  assert.equal(f.store.task("main")?.status, "inferred");
  delete f.supervisor.thread.settledAt;f.supervisor.thread.settledOverride = null;
  f.main.runs[0]!.status = "running";
  await f.check(200_000);assert.equal(f.store.binding("p", "main")?.quietSince, null);
  assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
});

test("a busy main short-circuits child projection reads even with a large known descendant set", async t => {
  const f = await fixture();t.after(f.cleanup);
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

test("pending child monitor activity blocks standby before any descendant projection reads", async t => {
  const f = await fixture();t.after(f.cleanup);
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

test("archived mains absent from the active catalog set aside the same Supervisor and retain unfinished semantic records", async t => {
  const f = await fixture();t.after(f.cleanup);
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

test("a confirmed missing main closes a runless native child whose parent projection is gone", async t => {
  const f = await fixture();t.after(f.cleanup);f.setFailure("main", new T3TransportError("deleted", 404));
  const child = thread("child", "main", "subagent", "main");f.threads.push(child);
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  assert.equal(await f.lifecycle.readMain(f.binding, AbortSignal.timeout(1000)), null);
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
});

test("readMain rejects projections whose thread or project identity does not match the binding", async t => {
  const f = await fixture();t.after(f.cleanup);
  f.main.thread.id = "other";await assert.rejects(f.lifecycle.readMain(f.binding, AbortSignal.timeout(1000)), /main_scope_mismatch/);
  f.main.thread.id = "main";f.main.thread.projectId = "other-project";
  await assert.rejects(f.lifecycle.readMain(f.binding, AbortSignal.timeout(1000)), /main_scope_mismatch/);
});

test("transient main reads clear the quiet epoch and fail closed", async t => {
  const f = await fixture();t.after(f.cleanup);f.setFailure("main", new T3TransportError("unavailable", 503));
  await assert.rejects(f.lifecycle.readMain(f.binding, AbortSignal.timeout(1000)), error => error instanceof T3TransportError && error.httpStatus === 503);
  await f.check(10);assert.equal(f.calls.length, 0);assert.equal(f.store.binding("p", "main")?.quietSince, null);
  f.setFailure("main", null);await f.check(100_000);assert.equal(f.calls.length, 0);
  await f.check(100_000 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
});

test("archived mains stay active while a cataloged direct or nested descendant is busy", async t => {
  for (const kind of ["running", "background"] as const) {
    const f = await fixture();t.after(f.cleanup);
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

test("more than one hundred quiet descendants become cache-validated instead of permanently blocking parking", async t => {
  const f = await fixture();t.after(f.cleanup);
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

test("a live delegated child beyond the first lifecycle scan page still blocks parking when rotation reaches it", async t => {
  const f = await fixture();t.after(f.cleanup);
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

test("nested descendants inherit historical roots but remain children of the bound main", async t => {
  const f = await fixture();t.after(f.cleanup);
  f.main.thread.lineage.rootThreadId = "historical-root";f.main.thread.archivedAt = "2026-10-14T10:02:00Z";
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  const child = thread("child", "main", "subagent", "historical-root");
  const grandchild = thread("grandchild", "child", "subagent", "historical-root");
  f.threads.push(child, grandchild);
  f.projections.set(child.id, {thread: child, runs: [{...f.main.runs[0]!, id: "child-run"}], messages: [], subagents: [{childThreadId: grandchild.id, status: "completed"}]});
  f.projections.set(grandchild.id, {thread: grandchild, runs: [{...f.main.runs[0]!, id: "grandchild-run", status: "running"}], messages: [], subagents: []});
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0);
});

test("an active nested grandchild under an independent fork is outside the bound main scope", async t => {
  const f = await fixture();t.after(f.cleanup);f.main.thread.lineage.rootThreadId = "historical-root";
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

test("normal main settlement honors the active catalog shell's background work", async t => {
  const f = await fixture();t.after(f.cleanup);
  const sourceShell = {...f.main.thread, pendingBackgroundTasks: [{kind: "task", id: "background"}]};
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1, sourceShell);
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0);
});

test("T3 deletion closes a still-running child scope after the main returns confirmed 404", async t => {
  const f = await fixture();t.after(f.cleanup);f.setFailure("main", new T3TransportError("deleted", 404));
  const child = thread("child", "main", "subagent", "main");f.threads.push(child);
  f.projections.set(child.id, {thread: child, runs: [{...f.main.runs[0]!, id: "child-run", status: "running"}], messages: [], subagents: []});
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
});

test("an archived but natively busy main cannot be set aside", async t => {
  const f = await fixture();t.after(f.cleanup);f.main.thread.archivedAt = "2026-10-14T10:02:00Z";f.main.runs[0]!.status = "running";
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 0);
});

test("an active native child blocks settlement through its direct parent despite an idle child mirror", async t => {
  const f = await fixture();t.after(f.cleanup);
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
  test(`a matched ${requestStatus} child request clears stale detached waiting state`, async t => {
    const f = await fixture();t.after(f.cleanup);
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

test("a fresh pending child request still blocks settlement", async t => {
  const f = await fixture();t.after(f.cleanup);
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

test("quiet children with unknown lifecycle do not prevent standby while ongoing T3 effects still do", async t => {
  const f = await fixture();t.after(f.cleanup);
  const child = {...thread("old-child", "main", "subagent", "main"), projectId: null,
    creationSource: "provider", latestRunId: null, activeRunId: null};
  f.threads.push(child);
  f.main.subagents = [{childThreadId: child.id, status: "unknown"}];
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: []});
  await f.check(1);await f.check(1 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 1);

  const busyFixture = await fixture();t.after(busyFixture.cleanup);
  busyFixture.main.subagents = [{childThreadId: "unresolved", status: "unknown", completionDelivery: {state: "pending"}}];
  await busyFixture.check(1);await busyFixture.check(1 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(busyFixture.calls.length, 0);
});

test("known workflow needs-attention status blocks standby even when all T3 chats are quiet", async t => {
  const f = await fixture();t.after(f.cleanup);
  const owner = {projectId: "p", mainThreadId: "main", supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation};
  const created = f.store.store.transaction(() => f.workflows.ensureMainInTransaction(owner, "workflow-attention-main", "Known issue", 1));
  assert.equal(created.status, "created");
  const document = f.workflows.get("p", "main");assert.ok(document);
  f.guidance.db.prepare("UPDATE supervisor_workflow_state SET document=?,updated_at=? WHERE workflow_id=?")
    .run(JSON.stringify({...document, status: "needs_attention"}), 2, document.workflowId);
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);
  assert.equal(f.calls.length, 0);
});

test("unknown intermediate child ancestry blocks closed-main settlement", async t => {
  const f = await fixture();t.after(f.cleanup);f.main.thread.archivedAt = "2026-10-14T10:02:00Z";
  f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  f.threads.push(thread("nested", "missing-parent", "subagent", "main"));
  await f.check(10);assert.equal(f.calls.length, 0);assert.equal(f.store.binding("p", "main")?.quietSince, null);
});

test("a confirmed missing ancestor terminates an unrelated orphan subagent chain", async t => {
  const f = await fixture();t.after(f.cleanup);f.setFailure("deleted-parent", new T3TransportError("deleted", 404));
  f.threads.push(thread("orphan", "deleted-parent", "subagent", "historical-root"));
  await f.check(10);await f.check(10 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);
});

test("reopening the same main cancels its closed-source quiet epoch and retains binding identity", async t => {
  const f = await fixture();t.after(f.cleanup);f.main.thread.archivedAt = "2026-10-14T10:02:00Z";f.threads.splice(f.threads.findIndex(item => item.id === "main"), 1);
  await f.check(10);assert.equal(f.store.binding("p", "main")?.quietSince, 10);
  delete f.main.thread.archivedAt;f.main.thread.updatedAt = "2026-10-14T10:03:00Z";f.threads.push(f.main.thread);
  await f.check(20);assert.equal(f.calls.length, 0);assert.equal(f.store.binding("p", "main")?.quietSince, 20);
  assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
  await f.check(20 + SUPERVISOR_SETTLE_QUIET_MS);assert.equal(f.calls.length, 1);assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
});

test("a fresh main read that observes reopening cancels closed-source settlement", async t => {
  const f = await fixture();t.after(f.cleanup);
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
  test(`automatic settlement preserves ${blocker}`, async t => {
    const f = await fixture();t.after(f.cleanup);await f.check(10);
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

test("unknown settlement reconciles visibility without deletion or repeated commands", async t => {
  const f = await fixture();t.after(f.cleanup);f.setUncertain();await f.check(1);await f.check(100_000);
  assert.equal(f.store.binding("p", "main")?.settlement?.state, "uncertain");
  const id = f.store.binding("p", "main")?.settlement?.commandId;
  await f.check(200_000);assert.equal(f.calls.length, 2);assert.equal(f.calls[1]?.commandId, id);
  f.supervisor.thread.settledAt = "2026-10-14T10:00:00Z";await f.check(300_000);
  assert.equal(f.store.binding("p", "main")?.settlement?.state, "settled");assert.equal(f.store.binding("p", "main")?.settlement?.commandId, id);
});

test("the one-time disposable reset clears discovery together and preserves unrelated state", async t => {
  const f = await fixture();t.after(f.cleanup);
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


test("background provider work, completion delivery, goals and PR watches all prevent parking", async t => {
  for (const kind of ["roster", "delivery", "goal", "watch"]) {
    const f = await fixture();t.after(f.cleanup);await f.check(1);
    if (kind === "roster") f.main.providerThreads = [{id: "provider", pendingBackgroundTasks: [{kind: "task", id: "background"}]}];
    if (kind === "delivery") f.main.subagents = [{status: "completed", completionDelivery: {state: "pending"}}];
    if (kind === "goal") f.main.providerThreads = [{id: "provider", goal: {status: "active"}}];
    if (kind === "watch") f.main.thread.pullRequests = [{watch: {state: "watching"}}];
    await f.check(100_000);assert.equal(f.calls.length, 0, kind);
  }
});

test("new activity supersedes an unresolved parking epoch without replacing the Supervisor", async t => {
  const f = await fixture();t.after(f.cleanup);f.setUncertain();await f.check(1);await f.check(100_000);
  f.supervisor.thread.updatedAt = "2026-10-14T11:00:00Z";
  await f.check(200_000);assert.equal(f.store.binding("p", "main")?.settlement?.state, "superseded");
  assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);
});

test("an accepted settlement followed by immediate reactivation is a superseded success", async t => {
  const f = await fixture();t.after(f.cleanup);
  const lifecycle = new SupervisorLifecycle(f.store, f.conversation, async id => f.projections.get(id)!, async () => ({sequence: 20}));
  await lifecycle.check(f.binding, f.threads, AbortSignal.timeout(1000), 1);
  await lifecycle.check(f.binding, f.threads, AbortSignal.timeout(1000), 100_000);
  assert.equal(f.store.binding("p", "main")?.settlement?.state, "superseded");
});

test("an unknown scope version disables supervision without resetting the private database", async t => {
  const f = await fixture();t.after(f.cleanup);
  f.guidance.db.prepare("UPDATE meta SET value='future' WHERE key='supervisor_scope_version'").run();
  const incompatible = new ProjectSupervisorStore(f.guidance, new Set());
  assert.equal(incompatible.scopeCompatible, false);assert.equal(f.store.binding("p", "main")?.threadId, f.binding.threadId);assert.equal(f.store.baseline()?.snapshotSequence, 10);
});

test("idle runless nested workers use their actual parent's native lifecycle records", async t => {
  const f = await fixture();t.after(f.cleanup);
  const child = thread("z-child", "main", "subagent");const nested = thread("a-nested", "z-child", "subagent", "main");
  f.threads.push(nested, child);
  f.main.subagents = [{childThreadId: child.id, status: "idle"}];
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: [{childThreadId: nested.id, status: "completed"}]});
  f.projections.set(nested.id, {thread: nested, runs: [], messages: [], subagents: []});
  await f.check(1);await f.check(100_000);assert.equal(f.calls.length, 1);
});


test("an unsent introduction blocks ordinary settlement while monitoring is idle", async t => {
  const f = await fixture();t.after(f.cleanup);
  f.conversation.requests.saveIntroduction({taskId: "task", projectId: "p", threadId: "main", supervisorThreadId: f.binding.threadId, state: "ready", text: "Intro", messageId: "intro", targetRunId: null, error: null});
  await f.check(1);await f.check(100_000);assert.equal(f.calls.length, 0, "the unsent introduction remains a blocker");
  assert.equal(f.conversation.requests.introduction("task")?.state, "ready");
});
