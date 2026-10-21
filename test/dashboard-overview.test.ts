import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {Effect, Schema} from "effect";
import {DashboardOverview, overviewPage, workAttention} from "../src/dashboard-overview.js";
import {GuidanceStore} from "../src/guidance-store.js";
import {ProjectSupervisorStore, defaultSupervisorModel, type TaskRecord} from "../src/project-supervisor-store.js";
import {ProjectSupervisor} from "../src/project-supervisor.js";
import type {ThreadInfo, SupervisorConfig} from "../src/types.js";

const nativeThread = (id: string): ThreadInfo => ({id, title: `Work ${id}`, projectId: "project", activeRunId: id === "active" ? "run" : null,
  lineage: {parentThreadId: null, relationshipToParent: null}});

test("the overview reads retained supervision state without native calls, writes, or invented completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-overview-"));
  const guidance = new GuidanceStore(directory);
  const store = new ProjectSupervisorStore(guidance, new Set());
  const threads = [nativeThread("active"), nativeThread("blocked"), nativeThread("stopped"), nativeThread("quiet")];
  const config: SupervisorConfig = {dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: ["stopped"], healthPort: 0};
  const forbidden = () => {assert.fail("a read-only overview must not call native tools");};
  const supervisor = new ProjectSupervisor(config, store, {catalog: () => Effect.succeed({projects: [{project: {id: "project", title: "Project", workspaceRoot: "/work/project"}, available: true}], threads})},
    {projection: forbidden}, forbidden, forbidden, async () => {throw new Error("must not initialize a boundary");});
  store.saveControl(null, 0, true, {snapshotSequence: 1, threads: []});
  store.saveControl("project", store.control("project").generation, true, {snapshotSequence: 1, threads: []});
  for (const thread of threads) {
    const binding = store.reserve("project", thread.id, thread.title, defaultSupervisorModel, 1, 100);
    store.setBinding({...binding, state: thread.id === "blocked" || thread.id === "stopped" ? "rejected" : "ready"});
    const task: TaskRecord = {id: thread.id, threadId: thread.id, projectId: "project", sourceRunId: "run", sourceMessageId: "message", sourceHash: "hash",
      status: thread.id === "blocked" || thread.id === "stopped" ? "needs_context" : "waiting", objective: `Objective ${thread.id}`, reason: "Inspect the current requirements.",
      updatedAt: 200, requestText: "Task", supervisorThreadId: binding.threadId, messageId: "notice", dispatchedAt: null, replayCount: 0, supervisorRunId: null, sourceOrdinal: 1};
    store.saveTask(task);
  }
  try {
    const before = guidance.db.prepare("SELECT document FROM supervisor_main_bindings ORDER BY main_thread_id").all();
    const taskBefore = guidance.db.prepare("SELECT document FROM supervisor_task_interpretations ORDER BY thread_id").all();
    const result = Schema.decodeUnknownSync(DashboardOverview)(await supervisor.overview({offset: 0, limit: 2}));
    assert.equal(result.total, 4);
    assert.equal(result.attentionTotal, 1, "stopped supervision and routine waiting are not alerts");
    assert.equal(result.work[0]?.mainThreadId, "blocked");
    assert.equal(result.work[1]?.nativeState, "active");
    assert.equal(result.work[1]?.planStatus, null, "native activity does not imply an agreed plan or completed work");
    assert.equal(result.hasMore, true);
    const second = await supervisor.overview({offset: 2, limit: 2});
    assert.equal(second.hasMore, false);
    assert.deepEqual(new Set([...result.work, ...second.work].map(item => item.mainThreadId)), new Set(threads.map(thread => thread.id)));
    assert.deepEqual(guidance.db.prepare("SELECT document FROM supervisor_main_bindings ORDER BY main_thread_id").all(), before);
    assert.deepEqual(guidance.db.prepare("SELECT document FROM supervisor_task_interpretations ORDER BY thread_id").all(), taskBefore);
    assert.equal(second.work.find(item => item.mainThreadId === "stopped")?.supervision, "stopped");
    threads[0]!.archivedAt = "2026-10-21T00:00:00Z";
    assert.equal((await supervisor.overview({offset: 0, limit: 100})).total, 3, "archived work is not presented as current work");
  } finally {guidance.close(); await rm(directory, {recursive: true, force: true});}
});

test("overview pagination rejects malformed and excessive pages", () => {
  assert.deepEqual(overviewPage({}), {offset: 0, limit: 100});
  assert.deepEqual(overviewPage({offset: "100", limit: "200"}), {offset: 100, limit: 200});
  for (const query of [{offset: "-1"}, {offset: "1.2"}, {offset: "100001"}, {limit: "0"}, {limit: "201"}, {limit: "Infinity"}])
    assert.throws(() => overviewPage(query), /invalid_overview_page/u);
});


test("current attention explanations retain protocol repair and exclude intentionally stopped work", () => {
  const task = {threadId: "main", projectId: "project", sourceRunId: "run", sourceMessageId: "message", status: "waiting" as const,
    objective: "Update tracking", reason: "Awaiting a response.", updatedAt: 1,
    workflowProtocolDiagnostic: {role: "operative" as const, proposalId: null, messageId: "bad-record", code: "invalid_proposal", observedAt: 1}};
  assert.equal(workAttention({enabled: true, bindingState: "ready", task}).length, 1);
  assert.deepEqual(workAttention({enabled: false, bindingState: "ready", task}), []);
  assert.deepEqual(workAttention({enabled: true, bindingState: "ready", task: {...task, workflowProtocolDiagnostic: null}}), []);
});
