import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuidanceStore } from "../src/guidance-store.js";
import { ProjectSupervisorStore, defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { SupervisorConversation } from "../src/supervisor-conversation.js";
import { SupervisorLifecycle, SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import { mainConversation } from "../src/supervisor-scope.js";
import type { Projection, ThreadInfo } from "../src/types.js";

const thread = (id: string, parent: string | null = null, relationship: string | null = null): ThreadInfo => ({id, title: id, projectId: "p", lineage: {parentThreadId: parent, relationshipToParent: relationship, rootThreadId: "historical-root"}});

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

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-scopes-"));
  const guidance = new GuidanceStore(directory);const store = new ProjectSupervisorStore(guidance, new Set());
  store.baseline({snapshotSequence: 10, threads: []});
  const binding = {...store.reserve("p", "main", "Main", defaultSupervisorModel, 10, 1), state: "ready" as const};store.setBinding(binding);
  const main: Projection = {thread: thread("main"), runs: [{id: "run", ordinal: 1, status: "completed", requestedAt: "2026-10-14T10:00:00Z", startedAt: "2026-10-14T10:00:00Z", completedAt: "2026-10-14T10:01:00Z", rootNodeId: "root"}], messages: [], runtimeRequests: [], subagents: []};
  const supervisor: Projection = {thread: thread(binding.threadId), runs: [], messages: [], runtimeRequests: [], subagents: []};
  const projections = new Map([["main", main], [binding.threadId, supervisor]]);
  const threads = [main.thread, supervisor.thread];const calls: Array<Record<string, unknown>> = [];
  let uncertain = false;
  const project = async (id: string) => {const p = projections.get(id);if (!p) throw new Error("unreadable");return p;};
  const rpc = async (_tag: string, payload: Record<string, unknown>) => {calls.push(payload);if (uncertain) throw new Error("lost receipt");supervisor.thread.settledAt = "2026-10-14T10:02:00Z";supervisor.thread.settledOverride = "settled";return {sequence: 11};};
  const conversation = new SupervisorConversation(store, rpc, project, undefined, () => true);
  store.saveTask({id: "task", projectId: "p", threadId: "main", sourceRunId: "run", sourceMessageId: "source", sourceHash: "hash", sourceOrdinal: 1, supervisorThreadId: binding.threadId,
    messageId: "interpretation", status: "inferred", objective: "Implement", reason: "Requested", updatedAt: 1, requestText: "", dispatchedAt: null, supervisorRunId: null, replayCount: 0});
  const lifecycle = new SupervisorLifecycle(store, conversation, project, rpc);
  return {guidance, store, binding, conversation, lifecycle, main, supervisor, projections, threads, calls, setUncertain: () => {uncertain = true;},
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
  const child = thread("z-child", "main", "subagent");const nested = thread("a-nested", "z-child", "subagent");
  f.threads.push(nested, child);
  f.main.subagents = [{childThreadId: child.id, status: "idle"}];
  f.projections.set(child.id, {thread: child, runs: [], messages: [], subagents: [{childThreadId: nested.id, status: "completed"}]});
  f.projections.set(nested.id, {thread: nested, runs: [], messages: [], subagents: []});
  await f.check(1);await f.check(100_000);assert.equal(f.calls.length, 1);
});


test("paused monitoring permits parking only after all introductions and requests finish", async t => {
  const f = await fixture();t.after(f.cleanup);f.store.saveSettings("p", 0, defaultSupervisorModel, {enabled: false, intervalMinutes: 5, activityThreshold: 10});
  await f.check(1);await f.check(100_000);assert.equal(f.calls.length, 1);
  delete f.supervisor.thread.settledAt;f.supervisor.thread.settledOverride = null;
  f.conversation.requests.saveIntroduction({taskId: "task", projectId: "p", threadId: "main", supervisorThreadId: f.binding.threadId, state: "ready", text: "Intro", messageId: "intro", targetRunId: null, error: null});
  await f.check(200_000);await f.check(300_000);assert.equal(f.calls.length, 1, "paused does not discard an unsent introduction");
});
