import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import {Context, Effect, Layer, Schema} from "effect";
import {DashboardOverview, overviewPage, workAttention, overviewWorkPage, type DashboardWorkInfo} from "../src/dashboard-overview.js";
import {GuidanceDb} from "../src/db.js";
import {ProjectSupervisor} from "../src/project-supervisor.js";
import {ProjectSupervisorStore, defaultSupervisorModel, type TaskRecord} from "../src/project-supervisor-store.js";
import type {ThreadInfo, SupervisorConfig} from "../src/types.js";
import {rows, temporaryDirectory} from "./support/g11-stores.js";
import {forbiddenNatives, supervisionRun} from "./support/g11-supervision.js";

// the overview over one supervision run of the production layers on a temporary guidance file, with every native client a
// fake that dies when used, and the pure page, attention and range helpers. it.effect: no case waits on time

// the range cases call the Effect range reader with the page reads they were written for


const nativeThread = (id: string): ThreadInfo => ({id, title: `Work ${id}`, projectId: "project", activeRunId: id === "active" ? "run" : null,
  lineage: {parentThreadId: null, relationshipToParent: null}});

it.effect("the overview reads retained supervision state without native calls, writes, or invented completion", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("supervisor-overview-");
  const threads = [nativeThread("active"), nativeThread("blocked"), nativeThread("stopped"), nativeThread("quiet")];
  const config: SupervisorConfig = {dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: ["stopped"], healthPort: 0};
  const run = yield* Layer.build(supervisionRun(config, forbiddenNatives({catalog: () => Effect.succeed({projects: [{project: {id: "project", title: "Project", workspaceRoot: "/work/project"}, available: true}], threads})})));
  const store = Context.get(run, ProjectSupervisorStore);
  const sql = Context.get(run, GuidanceDb);
  const supervisor = Context.get(run, ProjectSupervisor);
  yield* store.saveControl(null, 0, true, {snapshotSequence: 1, threads: []});
  yield* store.saveControl("project", (yield* store.control("project")).generation, true, {snapshotSequence: 1, threads: []});
  for (const thread of threads) {
    const binding = yield* store.reserve("project", thread.id, thread.title, defaultSupervisorModel, 1, 100);
    yield* store.setBinding({...binding, state: thread.id === "blocked" || thread.id === "stopped" ? "rejected" : "ready"});
    const task: TaskRecord = {id: thread.id, threadId: thread.id, projectId: "project", sourceRunId: "run", sourceMessageId: "message", sourceHash: "hash",
      status: thread.id === "blocked" || thread.id === "stopped" ? "needs_context" : "waiting", objective: `Objective ${thread.id}`, reason: "Inspect the current requirements.",
      updatedAt: 200, requestText: "Task", supervisorThreadId: binding.threadId, messageId: "notice", dispatchedAt: null, replayCount: 0, supervisorRunId: null, sourceOrdinal: 1};
    yield* store.saveTask(task);
  }
  const before = yield* rows(sql, "SELECT document FROM supervisor_main_bindings ORDER BY main_thread_id");
  const taskBefore = yield* rows(sql, "SELECT document FROM supervisor_task_interpretations ORDER BY thread_id");
  const result = yield* Schema.decodeUnknownEffect(DashboardOverview)(yield* supervisor.overview({offset: 0, limit: 2}));
  assert.equal(result.total, 4);
  assert.equal(result.attentionTotal, 1, "stopped supervision and routine waiting are not alerts");
  assert.equal(result.work[0]?.mainThreadId, "blocked");
  assert.equal(result.work[1]?.nativeState, "active");
  assert.equal(result.work[1]?.planStatus, null, "native activity does not imply an agreed plan or completed work");
  assert.equal(result.hasMore, true);
  const search = yield* supervisor.overview({offset: 0, limit: 25, q: "Objective quiet"});
  assert.equal(search.total, 1); assert.equal(search.work[0]?.mainThreadId, "quiet"); assert.equal(search.attentionTotal, 1); assert.equal(search.projects.length, 1);
  const second = yield* supervisor.overview({offset: 2, limit: 2});
  assert.equal(second.hasMore, false);
  assert.deepEqual(new Set([...result.work, ...second.work].map(item => item.mainThreadId)), new Set(threads.map(thread => thread.id)));
  assert.deepEqual(yield* rows(sql, "SELECT document FROM supervisor_main_bindings ORDER BY main_thread_id"), before);
  assert.deepEqual(yield* rows(sql, "SELECT document FROM supervisor_task_interpretations ORDER BY thread_id"), taskBefore);
  assert.equal(second.work.find(item => item.mainThreadId === "stopped")?.supervision, "stopped");
  threads[0]!.archivedAt = "2026-10-21T00:00:00Z";
  assert.equal((yield* supervisor.overview({offset: 0, limit: 100})).total, 3, "archived work is not presented as current work");
}));

it.effect("overview pagination rejects malformed and excessive pages", () => Effect.sync(() => {
  assert.deepEqual(overviewPage({}), {offset: 0, limit: 25, q: "", projectId: "", filter: "all"});
  assert.deepEqual(overviewPage({offset: "100", limit: "200"}), {offset: 100, limit: 200, q: "", projectId: "", filter: "all"});
  for (const query of [{offset: "-1"}, {offset: "1.2"}, {offset: "100001"}, {limit: "0"}, {limit: "201"}, {limit: "Infinity"}])
    assert.throws(() => overviewPage(query), /invalid_overview_page/u);
}));


it.effect("current attention explanations retain protocol repair and exclude intentionally stopped work", () => Effect.sync(() => {
  const task = {threadId: "main", projectId: "project", sourceRunId: "run", sourceMessageId: "message", status: "waiting" as const,
    objective: "Update tracking", reason: "Awaiting a response.", updatedAt: 1,
    workflowProtocolDiagnostic: {role: "operative" as const, proposalId: null, messageId: "bad-record", code: "invalid_proposal", observedAt: 1}};
  assert.equal(workAttention({enabled: true, bindingState: "ready", task}).length, 1);
  assert.deepEqual(workAttention({enabled: false, bindingState: "ready", task}), []);
  assert.deepEqual(workAttention({enabled: true, bindingState: "ready", task: {...task, workflowProtocolDiagnostic: null}}), []);
}));


it("server search and filters cover rows beyond the old prefix, with stable pages and independent attention", () => {
  const rows: DashboardWorkInfo[] = Array.from({length: 230}, (_, i) => ({projectId: i % 2 ? "p" : "q", mainThreadId: `work-${String(i).padStart(3, "0")}`, title: `Title ${i}`, supervisorThreadId: "s", nativeState: "quiet", supervision: "enabled", objective: null, reason: "", taskStatus: null, planStatus: null, assessment: null, attention: i === 229 ? ["needs review"] : [], updatedAt: null}));
  const found = overviewWorkPage(rows, {offset: 0, limit: 25, q: "Title 229"});
  assert.equal(found.total, 1); assert.equal(found.availableTotal, 230); assert.equal(found.work[0]!.mainThreadId, "work-229");
  const filtered = overviewWorkPage(rows, {offset: 0, limit: 25, q: "Title 0", projectId: "q"});
  assert.equal(filtered.total, 1); assert.equal(filtered.attentionTotal, 1); assert.equal(filtered.attention[0]!.mainThreadId, "work-229");
  const before = overviewWorkPage(rows, {offset: 25, limit: 25});
  const after = overviewWorkPage(rows.map(row => ({...row, updatedAt: 999, nativeState: "active"})), {offset: 25, limit: 25});
  assert.deepEqual(after.work.map(row => row.mainThreadId), before.work.map(row => row.mainThreadId), "paging preserves the server-provided order");
});
