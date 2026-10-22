import assert from "node:assert/strict";
import { it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuidanceStore } from "../src/guidance-store.js";
import { defaultMonitoringSettings } from "../src/project-supervisor-contract.js";
import { directParentChildLifecycle, monitorActivityReference, observeScopeThread } from "../src/supervisor-observation.js";
import { ProjectSupervisorMonitorStore } from "../src/supervisor-monitor-store.js";
import { collectSupervisorActivity } from "../src/supervisor-monitor.js";
import { resolveSupervisorScope } from "../src/supervisor-scope.js";
import type { Projection, ThreadInfo } from "../src/types.js";

const projectId = "project-3145";
const now = Date.parse("2026-10-15T09:00:00.000Z");

const makeThread = (
  id: string,
  parentThreadId: string | null = null,
  relationshipToParent: string | null = null,
  project: string | null = projectId,
  extra: Record<string, unknown> = {},
): ThreadInfo => ({
  id,
  title: id,
  projectId: project,
  lineage: {parentThreadId, relationshipToParent, rootThreadId: parentThreadId ? "main" : id},
  ...extra,
});

const mainThread = makeThread("main");
const nativeChild = makeThread("native-child", "main", "subagent", null, {
  creationSource: "provider",
  forkedFrom: {type: "node", nodeId: "node:provider:codex:native-item"},
});
const delegatedChild = makeThread("delegated-child", "main", "subagent", "other-project", {
  creationSource: "mcp",
  forkedFrom: {type: "node", nodeId: "node:delegated-task:command%3Achild"},
});

interface DetachedEvent {
  id: string;
  type?: "command_execution" | "assistant_message";
  status?: string;
  messageId?: string;
  text?: string;
}

const makeDetachedChildProjection = (thread: ThreadInfo, events: readonly DetachedEvent[]): Projection => {
  const updatedAt = new Date(now - 30_000).toISOString();
  const messages = events.flatMap(event => event.type === "assistant_message" ? [{
    id: event.messageId ?? event.id,
    threadId: thread.id,
    runId: null,
    nodeId: `node-${event.id}`,
    role: "assistant",
    text: event.text ?? `Finished ${event.id}`,
    streaming: false,
    createdAt: updatedAt,
    updatedAt,
  }] : []);
  const turnItems = events.map((event, index) => ({
    id: `turn-item-${event.id}`,
    threadId: thread.id,
    runId: null,
    providerThreadId: `provider-${thread.id}`,
    providerTurnId: `turn-${thread.id}`,
    ordinal: index + 1,
    nodeId: `node-${event.id}`,
    type: event.type ?? "command_execution",
    status: event.status ?? "completed",
    messageId: event.messageId ?? (event.type === "assistant_message" ? event.id : undefined),
    toolName: event.type === "assistant_message" ? undefined : "exec",
    input: event.type === "assistant_message" ? undefined : `printf ${event.id}`,
    output: event.type === "assistant_message" ? undefined : `completed ${event.id}`,
    text: event.type === "assistant_message" ? event.text ?? `Finished ${event.id}` : undefined,
    streaming: false,
    updatedAt,
    completedAt: updatedAt,
  }));
  return {thread, runs: [], messages, turnItems};
};

const makeRunChildProjection = (thread: ThreadInfo, eventIds: readonly string[]): Projection => {
  const runId = `run-${thread.id}`;
  const rootNodeId = `root-${thread.id}`;
  const providerThreadId = `provider-${thread.id}`;
  const updatedAt = new Date(now - 30_000).toISOString();
  const nodes: Record<string, unknown>[] = [{
    id: rootNodeId,
    threadId: thread.id,
    runId,
    rootNodeId,
    parentNodeId: null,
    providerThreadId,
    kind: "root_turn",
    status: "completed",
  }];
  const turnItems = eventIds.map((eventId, index) => {
    const nodeId = `node-${thread.id}-${eventId}`;
    nodes.push({
      id: nodeId,
      threadId: thread.id,
      runId,
      rootNodeId,
      parentNodeId: rootNodeId,
      providerThreadId,
      kind: "tool_call",
      status: "completed",
    });
    return {
      id: `turn-item-${thread.id}-${eventId}`,
      threadId: thread.id,
      runId,
      nodeId,
      type: "command_execution",
      toolName: "exec",
      input: `printf ${eventId}`,
      output: `completed ${eventId}`,
      ordinal: index + 1,
      status: "completed",
      updatedAt,
      completedAt: updatedAt,
    };
  });
  return {
    thread,
    runs: [{id: runId, threadId: thread.id, ordinal: 1, status: "completed", requestedAt: updatedAt,
      startedAt: updatedAt, completedAt: updatedAt, rootNodeId, providerThreadId}],
    nodes,
    messages: [],
    turnItems,
  };
};

const parentProjection: Projection = {
  thread: mainThread,
  runs: [],
  messages: [],
  subagents: [{childThreadId: nativeChild.id, providerThreadId: "provider-native", status: "completed"}],
  turnItems: [{id: "parent-native-item", threadId: mainThread.id, type: "subagent", childThreadId: nativeChild.id,
    providerThreadId: "provider-native", status: "completed"}],
};

const withMonitor = async <A>(
  work: (monitor: ProjectSupervisorMonitorStore, store: GuidanceStore, directory: string) => Promise<A> | A,
  capacity = 1000,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-child-observation-"));
  const store = new GuidanceStore(directory);
  try {
    return await work(new ProjectSupervisorMonitorStore(store, capacity), store, directory);
  } finally {
    store.close();
    await rm(directory, {recursive: true, force: true});
  }
};

it("Mac3145 native child activity stays detached, child-scoped, and traceable under the main scope", async () => {
  const childProjection = makeDetachedChildProjection(nativeChild, [
    {id: "native-command", type: "command_execution"},
    {id: "native-answer", type: "assistant_message", messageId: "native-answer-message"},
    {id: "peer-reply", type: "assistant_message", messageId: "supervisor-peer:reply"},
  ]);
  assert.equal(nativeChild.creationSource, "provider");
  assert.equal(Object.hasOwn(nativeChild, "kind"), false);
  assert.equal(Object.hasOwn(nativeChild, "delegated"), false);
  assert.equal(childProjection.runs.length, 0);
  assert.ok(childProjection.turnItems?.every(item => item.runId === null));

  const scope = resolveSupervisorScope([mainThread, nativeChild], projectId, mainThread.id);
  assert.equal(scope.complete, true);
  assert.equal(scope.allowedIds.has(nativeChild.id), true);
  assert.equal(directParentChildLifecycle(parentProjection, nativeChild.id)?.status, "completed");

  const ordinary = collectSupervisorActivity(childProjection, 1, now);
  assert.deepEqual(ordinary, []);
  assert.deepEqual(collectSupervisorActivity(parentProjection, 1, now), []);
  const detached = collectSupervisorActivity(childProjection, 1, now, new Set(), new Set(), true);
  assert.deepEqual(detached.map(item => item.id), ["turn-item-native-command", "message:native-answer-message"]);

  const refs = detached.map(item => monitorActivityReference(nativeChild.id, childProjection, item));
  assert.deepEqual(refs.map(ref => [ref.sourceThreadId, ref.sourceRunId, ref.sourceMessageId, ref.sourceItemId]), [
    [nativeChild.id, null, null, "turn-item-native-command"],
    [nativeChild.id, null, "native-answer-message", "turn-item-native-answer"],
  ]);
  const observed = observeScopeThread({thread: nativeChild, mainThreadId: mainThread.id, depth: 1,
    projection: childProjection, parentProjection, activityRefs: refs});
  assert.equal(observed.origin, "native_child");
  assert.equal(observed.lifecycle, "completed");
  assert.equal(observed.activityRefs.length, 2);

  await withMonitor(monitor => {
    monitor.observe({projectId, threadId: nativeChild.id, sourceOrdinal: 1, projection: childProjection, now});
    assert.equal(monitor.pending(projectId, nativeChild.id).length, 0);
    monitor.observe({projectId, threadId: nativeChild.id, sourceOrdinal: 1, projection: childProjection, now, includeDetachedChildItems: true});
    assert.equal(monitor.pending(projectId, nativeChild.id).length, 2);
    const batch = monitor.select(projectId, {...defaultMonitoringSettings, activityThreshold: 1}, now, null,
      {eligibleThreadIds: scope.allowedIds});
    assert.deepEqual(batch?.threads.map(item => item.threadId), [nativeChild.id]);
    assert.equal(batch?.threads[0]?.items.some(item => item.id.includes("supervisor-peer:")), false);
  });
});

it("a 3190-style duplicated parent lifecycle record resolves to one exact deterministic record", () => {
  const childThreadId = "native-child-3190-shape";
  const nativeRecordId = "node:provider:codex:native-item:call_fixture:child";
  const parentRunId = "parent-run-ordinal-10";
  const startedAt = new Date(now - 4_000).toISOString();
  const completedAt = new Date(now - 1_000).toISOString();
  const subagentUpdatedAt = new Date(now + 5_000).toISOString();
  const turnItemUpdatedAt = new Date(now - 900).toISOString();
  const parent: Projection = {
    ...parentProjection,
    subagents: [{id: nativeRecordId, childThreadId, runId: parentRunId, status: "completed", startedAt, completedAt, updatedAt: subagentUpdatedAt}],
    turnItems: [{id: "turn-item:provider:codex:native-item:fixture", nodeId: nativeRecordId, type: "subagent",
      threadId: mainThread.id, childThreadId, runId: parentRunId, status: "completed", startedAt, completedAt, updatedAt: turnItemUpdatedAt}],
  };

  const lifecycle = directParentChildLifecycle(parent, childThreadId);
  assert.deepEqual(lifecycle, {
    status: "completed",
    source: "parent_turn_item",
    parentRunId,
    recordId: nativeRecordId,
    startedAt,
    completedAt,
    updatedAt: turnItemUpdatedAt,
  });
  const child = makeThread(childThreadId, mainThread.id, "subagent", null, {creationSource: "provider"});
  const childProjection = makeDetachedChildProjection(child, []);
  const lifecycleActivity = collectSupervisorActivity(childProjection, 1, now, new Set(), new Set(), true, {
    parentThreadId: mainThread.id,
    parentRunId: lifecycle!.parentRunId,
    recordId: lifecycle!.recordId,
    status: lifecycle!.status,
    completedAt: lifecycle!.completedAt,
    updatedAt: lifecycle!.updatedAt,
  }).filter(item => item.type === "native_child_lifecycle");
  assert.equal(lifecycleActivity.length, 1);
  const metadataBumped: Projection = {...parent, subagents: parent.subagents!.map(record => ({...record,
    updatedAt: new Date(now + 10_000).toISOString()}))};
  assert.deepEqual(directParentChildLifecycle(metadataBumped, childThreadId), lifecycle,
    "metadata timestamp changes cannot switch the canonical duplicate source");
  const ambiguous = {...parent, turnItems: parent.turnItems!.map(item => ({...item, status: "running"}))};
  assert.equal(directParentChildLifecycle(ambiguous, childThreadId), null);
});

it("native and delegated child activity joins one main-scoped batch", async () => {
  await withMonitor(monitor => {
    const threads = [mainThread, nativeChild, delegatedChild];
    const scope = resolveSupervisorScope(threads, projectId, mainThread.id);
    assert.equal(scope.complete, true);
    assert.equal(scope.allowedIds.has(nativeChild.id), true);
    assert.equal(scope.allowedIds.has(delegatedChild.id), true);
    assert.equal(delegatedChild.creationSource, "mcp");
    assert.equal(Object.hasOwn(delegatedChild, "kind"), false);
    assert.equal(Object.hasOwn(delegatedChild, "delegated"), false);

    monitor.observe({projectId, threadId: nativeChild.id, sourceOrdinal: 1,
      projection: makeDetachedChildProjection(nativeChild, [{id: "native-command"}]), now, includeDetachedChildItems: true});
    monitor.observe({projectId, threadId: delegatedChild.id, sourceOrdinal: 1,
      projection: makeRunChildProjection(delegatedChild, ["delegated-command"]), now});
    const batch = monitor.select(projectId, {...defaultMonitoringSettings, activityThreshold: 1}, now, null,
      {eligibleThreadIds: scope.allowedIds});
    assert.deepEqual(batch?.threads.map(item => item.threadId).sort(), [delegatedChild.id, nativeChild.id].sort());
    assert.equal(batch?.pendingItemCount, 3);
  });
});

it("a saturated child is skipped by the frozen batch bound so a sibling remains visible", async () => {
  await withMonitor(async monitor => {
    const noisy = makeThread("noisy-child", mainThread.id, "subagent", null, {creationSource: "provider"});
    const sibling = makeThread("sibling-child", mainThread.id, "subagent", null, {creationSource: "provider"});
    const scope = resolveSupervisorScope([mainThread, noisy, sibling], projectId, mainThread.id);
    const noisyProjection = makeDetachedChildProjection(noisy, [
      {id: "noise-1"}, {id: "noise-2"}, {id: "noise-3"}, {id: "noise-4"},
    ]);
    monitor.observe({projectId, threadId: noisy.id, sourceOrdinal: 1, projection: noisyProjection, now, includeDetachedChildItems: true});
    monitor.observe({projectId, threadId: sibling.id, sourceOrdinal: 1,
      projection: makeDetachedChildProjection(sibling, [{id: "sibling-work"}]), now, includeDetachedChildItems: true});
    assert.equal(monitor.state(projectId, noisy.id).saturated, true);
    assert.ok(monitor.state(projectId, noisy.id).untrackedCount > 0);

    const batch = monitor.select(projectId, {...defaultMonitoringSettings, activityThreshold: 1}, now, null,
      {eligibleThreadIds: scope.allowedIds, maxFrozenItems: 1});
    assert.deepEqual(batch?.threads.map(item => item.threadId), [sibling.id]);
    assert.equal(batch?.truncated, true);
  }, 2);
});

it("acknowledged detached child history survives restart without waking or duplicating", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-child-observation-restart-"));
  let store = new GuidanceStore(directory);
  try {
    let monitor = new ProjectSupervisorMonitorStore(store);
    const projection = makeDetachedChildProjection(nativeChild, [{id: "durable-native-command"}]);
    monitor.observe({projectId, threadId: nativeChild.id, sourceOrdinal: 1, projection, now, includeDetachedChildItems: true});
    const batch = monitor.select(projectId, {...defaultMonitoringSettings, activityThreshold: 1}, now, null,
      {eligibleThreadIds: new Set([mainThread.id, nativeChild.id])});
    assert.deepEqual(batch?.threads.map(item => item.threadId), [nativeChild.id]);
    assert.equal(monitor.acknowledge(batch!, now + 1).acknowledged, 1);
    store.close();

    store = new GuidanceStore(directory);
    monitor = new ProjectSupervisorMonitorStore(store);
    assert.equal(monitor.state(projectId, nativeChild.id).sourceOrdinal, 1);
    monitor.observe({projectId, threadId: nativeChild.id, sourceOrdinal: monitor.state(projectId, nativeChild.id).sourceOrdinal,
      projection, now: now + 2, includeDetachedChildItems: true});
    assert.equal(monitor.state(projectId, nativeChild.id).sourceOrdinal, 2);
    assert.deepEqual(monitor.pending(projectId, nativeChild.id), []);
    monitor.observe({projectId, threadId: nativeChild.id, sourceOrdinal: monitor.state(projectId, nativeChild.id).sourceOrdinal,
      projection, now: now + 3, includeDetachedChildItems: true});
    assert.deepEqual(monitor.pending(projectId, nativeChild.id), []);
    assert.equal(monitor.select(projectId, {...defaultMonitoringSettings, activityThreshold: 1}, now + 3, null,
      {eligibleThreadIds: new Set([mainThread.id, nativeChild.id])}), null);
    const rows = store.db.prepare("SELECT item_id FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
      .all(projectId, nativeChild.id);
    assert.deepEqual(rows, []);
  } finally {
    store.close();
    await rm(directory, {recursive: true, force: true});
  }
});
