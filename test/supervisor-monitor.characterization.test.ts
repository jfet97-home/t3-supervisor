import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { GuidanceStoreError } from "../src/guidance-sql.js";
import type { Projection } from "../src/types.js";
import { rows as query } from "./support/guidance-store-services.js";
import { dataDirectory, withMonitor } from "./support/g9-stores.js";

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

const rows = (db: SqlClient.SqlClient) => Effect.all({
  thread: Effect.map(query(db, "SELECT * FROM supervisor_monitor_threads WHERE project_id=? AND thread_id=?", projectId, threadId), ([row]) => row),
  items: query(db, "SELECT * FROM supervisor_monitor_items WHERE project_id=? AND thread_id=? ORDER BY item_id", projectId, threadId),
});

it.effect("CT-MSTORE-01: an observe that fails at its item insert rolls back floor, active flags and saturation, also after reopen", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("c1-monitor-");
  // the guidance and monitor stores of capacity two on their own client; a second open is a second connection to the file
  const open = <A, E, R>(use: Parameters<typeof withMonitor<A, E, R>>[1]) => withMonitor(directory, use, 2);
  yield* open((monitor, db) => Effect.gen(function* () {
    const first = yield* monitor.observe({projectId, threadId, sourceOrdinal: 1, now,
      projection: projection([{id: "one", run: 1}, {id: "two", run: 1}, {id: "three", run: 1}])});
    assert.deepEqual([first.saturated, first.untrackedCount, first.sourceOrdinal], [true, 1, 1]);
    const before = yield* rows(db);
    assert.equal(before.items.length, 2);

    // the next observation raises the floor, retires the tracked run-1 items and inserts a run-2 item
    const next = {projectId, threadId, sourceOrdinal: 2, now: now + 1_000, projection: projection([{id: "one", run: 1}, {id: "four", run: 2}], [1])};
    yield* db.unsafe("CREATE TEMP TRIGGER c1_fail_item_insert BEFORE INSERT ON supervisor_monitor_items BEGIN SELECT RAISE(ABORT, 'c1 injected item failure'); END");
    // target change (S6d contract, errors): the failed statement surfaces as the typed store error with the driver's
    // classification and without the driver text
    const failure = yield* Effect.flip(monitor.observe(next));
    assert.ok(failure instanceof GuidanceStoreError);
    assert.match(failure.message, /^guidance store sql failed: ConstraintError$/u);
    assert.deepEqual(yield* rows(db), before);
    assert.deepEqual(yield* open((_monitor, other) => rows(other)), before);

    yield* db.unsafe("DROP TRIGGER c1_fail_item_insert");
    const applied = yield* monitor.observe(next);
    const after2 = yield* rows(db);
    assert.deepEqual([applied.saturated, applied.sourceOrdinal, applied.inserted], [false, 2, 1]);
    assert.notDeepEqual(after2, before, "the same observation changes the floor, items and saturation once it can commit");
    assert.deepEqual(before.items.map(item => item.item_id), ["message:message-one", "message:message-three"]);
    assert.deepEqual(after2.items.map(item => item.item_id), ["message:message-four", "message:message-one"]);
  }));
}), {timeout: 10_000});
