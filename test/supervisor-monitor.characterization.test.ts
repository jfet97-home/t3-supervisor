import assert from "node:assert/strict";
import { it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { GuidanceStore } from "../src/guidance-store.js";
import { ProjectSupervisorMonitorStore } from "../src/supervisor-monitor-store.js";
import type { Projection } from "../src/types.js";
import { after } from "./support/node-test.js";

const now = Date.parse("2026-10-13T10:00:00.000Z");
const projectId = "project-a";
const threadId = "operative-a";

// completed assistant replies, one turn item per reply, in the given run ordinal; listed runs have completed
const projection = (replies: ReadonlyArray<{id: string; run: number}>, completedRuns: ReadonlyArray<number> = []): Projection => {
  const ordinals = [...new Set(replies.map(reply => reply.run))];
  const at = new Date(now - 30_000).toISOString();
  return {
    thread: {id: threadId, title: threadId, projectId, lineage: {parentThreadId: null, relationshipToParent: null}},
    runs: ordinals.map(ordinal => ({id: `run-${ordinal}`, threadId, ordinal, status: completedRuns.includes(ordinal) ? "completed" : "running",
      requestedAt: at, startedAt: at, completedAt: completedRuns.includes(ordinal) ? at : null,
      rootNodeId: `root-${ordinal}`, userMessageId: `task-${ordinal}`, providerThreadId: `provider-${ordinal}`})),
    nodes: [
      ...ordinals.map(ordinal => ({id: `root-${ordinal}`, threadId, runId: `run-${ordinal}`, parentNodeId: null, rootNodeId: `root-${ordinal}`, kind: "root_turn",
        status: "completed", providerThreadId: `provider-${ordinal}`})),
      ...replies.map(reply => ({id: `node-${reply.id}`, threadId, runId: `run-${reply.run}`, parentNodeId: `root-${reply.run}`, rootNodeId: `root-${reply.run}`,
        kind: "assistant_message", status: "completed", providerThreadId: `provider-${reply.run}`})),
    ],
    turnItems: replies.map((reply, index) => ({id: `turn-item-${reply.id}`, threadId, runId: `run-${reply.run}`, nodeId: `node-${reply.id}`,
      providerThreadId: `provider-${reply.run}`, providerTurnId: `turn-${reply.run}`, ordinal: index + 1, status: "completed", startedAt: at, completedAt: at,
      updatedAt: at, type: "assistant_message", messageId: `message-${reply.id}`, text: `${reply.id} reply`, streaming: false, createdBy: "agent",
      creationSource: "provider", attachments: []})),
    messages: replies.map(reply => ({id: `message-${reply.id}`, threadId, runId: `run-${reply.run}`, nodeId: `node-${reply.id}`, role: "assistant",
      text: `${reply.id} reply`, streaming: false, createdAt: at, updatedAt: at, createdBy: "agent", creationSource: "provider"})),
    runtimeRequests: [],
  };
};

const rows = (db: DatabaseSync) => ({
  thread: db.prepare("SELECT * FROM supervisor_monitor_threads WHERE project_id=? AND thread_id=?").get(projectId, threadId),
  items: db.prepare("SELECT * FROM supervisor_monitor_items WHERE project_id=? AND thread_id=? ORDER BY item_id").all(projectId, threadId),
});

it("CT-MSTORE-01: an observe that fails at its item insert rolls back floor, active flags and saturation, also after reopen", {timeout: 10_000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "c1-monitor-"));
  const opened: GuidanceStore[] = [];
  const open = () => {
    const guidance = new GuidanceStore(directory);
    opened.push(guidance);
    return {guidance, monitor: new ProjectSupervisorMonitorStore(guidance, 2)};
  };
  after(t, async () => {
    for (const guidance of opened) guidance.close();
    await rm(directory, {recursive: true, force: true});
  });
  const {guidance, monitor} = open();
  const first = monitor.observe({projectId, threadId, sourceOrdinal: 1, now,
    projection: projection([{id: "one", run: 1}, {id: "two", run: 1}, {id: "three", run: 1}])});
  assert.deepEqual([first.saturated, first.untrackedCount, first.sourceOrdinal], [true, 1, 1]);
  const before = rows(guidance.db);
  assert.equal(before.items.length, 2);

  // the next observation raises the floor, retires the tracked run-1 items and inserts a run-2 item
  const next = {projectId, threadId, sourceOrdinal: 2, now: now + 1_000, projection: projection([{id: "one", run: 1}, {id: "four", run: 2}], [1])};
  guidance.db.exec("CREATE TEMP TRIGGER c1_fail_item_insert BEFORE INSERT ON supervisor_monitor_items BEGIN SELECT RAISE(ABORT, 'c1 injected item failure'); END");
  assert.throws(() => monitor.observe(next), /c1 injected item failure/u);
  assert.deepEqual(rows(guidance.db), before);
  assert.deepEqual(rows(open().guidance.db), before);

  guidance.db.exec("DROP TRIGGER c1_fail_item_insert");
  const applied = monitor.observe(next);
  const after2 = rows(guidance.db);
  assert.deepEqual([applied.saturated, applied.sourceOrdinal, applied.inserted], [false, 2, 1]);
  assert.notDeepEqual(after2, before, "the same observation changes the floor, items and saturation once it can commit");
  assert.deepEqual(before.items.map(item => item.item_id), ["message:message-one", "message:message-three"]);
  assert.deepEqual(after2.items.map(item => item.item_id), ["message:message-four", "message:message-one"]);
});
