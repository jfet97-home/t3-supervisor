import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import { it } from "vitest";
import {Effect, Schema} from "effect";
import {DashboardOverview, overviewPage, workAttention, readOverviewPages, type DashboardOverviewInfo} from "../src/dashboard-overview.js";
import {GuidanceStore} from "../src/guidance-store.js";
import {ProjectSupervisorStore, defaultSupervisorModel, type TaskRecord} from "../src/project-supervisor-store.js";
import {projectSupervisorUnit} from "./support/team-units.js";
import type {ThreadInfo, SupervisorConfig} from "../src/types.js";

// the range cases call the Effect range reader with the promise page reads they were written for
const readOverviewRange = (read: (offset: number) => Promise<DashboardOverviewInfo>, count: number) =>
  Effect.runPromise(readOverviewPages((offset) => Effect.promise(() => read(offset)), count));

const nativeThread = (id: string): ThreadInfo => ({id, title: `Work ${id}`, projectId: "project", activeRunId: id === "active" ? "run" : null,
  lineage: {parentThreadId: null, relationshipToParent: null}});

it("the overview reads retained supervision state without native calls, writes, or invented completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-overview-"));
  const guidance = new GuidanceStore(directory);
  const store = new ProjectSupervisorStore(guidance, new Set());
  const threads = [nativeThread("active"), nativeThread("blocked"), nativeThread("stopped"), nativeThread("quiet")];
  const config: SupervisorConfig = {dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: ["stopped"], healthPort: 0};
  const forbidden = () => {assert.fail("a read-only overview must not call native tools");};
  const supervisor = projectSupervisorUnit(config, store, {catalog: () => Effect.succeed({projects: [{project: {id: "project", title: "Project", workspaceRoot: "/work/project"}, available: true}], threads})},
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

it("overview pagination rejects malformed and excessive pages", () => {
  assert.deepEqual(overviewPage({}), {offset: 0, limit: 100});
  assert.deepEqual(overviewPage({offset: "100", limit: "200"}), {offset: 100, limit: 200});
  for (const query of [{offset: "-1"}, {offset: "1.2"}, {offset: "100001"}, {limit: "0"}, {limit: "201"}, {limit: "Infinity"}])
    assert.throws(() => overviewPage(query), /invalid_overview_page/u);
});


it("current attention explanations retain protocol repair and exclude intentionally stopped work", () => {
  const task = {threadId: "main", projectId: "project", sourceRunId: "run", sourceMessageId: "message", status: "waiting" as const,
    objective: "Update tracking", reason: "Awaiting a response.", updatedAt: 1,
    workflowProtocolDiagnostic: {role: "operative" as const, proposalId: null, messageId: "bad-record", code: "invalid_proposal", observedAt: 1}};
  assert.equal(workAttention({enabled: true, bindingState: "ready", task}).length, 1);
  assert.deepEqual(workAttention({enabled: false, bindingState: "ready", task}), []);
  assert.deepEqual(workAttention({enabled: true, bindingState: "ready", task: {...task, workflowProtocolDiagnostic: null}}), []);
});


it("overview refresh preserves the loaded range and restarts a reordered prefix", async () => {
  const row = (id: string) => ({projectId: "p", mainThreadId: id, title: id, supervisorThreadId: "s", nativeState: "quiet" as const,
    supervision: "enabled" as const, objective: null, reason: "", taskStatus: null, planStatus: null, assessment: null, attention: [], updatedAt: null});
  const all = Array.from({length: 230}, (_, i) => row(`work-${i}`));
  const response = (offset: number, revision: string, rows = all): DashboardOverviewInfo => ({revision, observedAt: 1, available: true, globallyEnabled: true,
    offset, limit: 100, total: rows.length, attentionTotal: 0, hasMore: offset + 100 < rows.length, projects: [], work: rows.slice(offset, offset + 100)});
  const calls: number[] = [];
  const retained = await readOverviewRange(async offset => {calls.push(offset); return response(offset, "one");}, 200);
  assert.equal(retained.work.length, 200);
  assert.equal(retained.work[150]?.mainThreadId, "work-150");
  assert.deepEqual(calls, [0, 100]);
  let count = 0;
  const promoted = [all[220]!, ...all.filter(row => row.mainThreadId !== "work-220")];
  const reordered = await readOverviewRange(async offset => response(offset, ++count === 1 ? "one" : "two", count === 1 ? all : promoted), 200);
  assert.equal(count, 4, "a changed second page restarts the full prefix");
  assert.equal(reordered.work[0]?.mainThreadId, "work-220");
  assert.equal(new Set(reordered.work.map(row => row.mainThreadId)).size, 200);
  await assert.rejects(readOverviewRange(async offset => response(offset, String(++count)), 200), /overview_changed_during_read/u);
});
