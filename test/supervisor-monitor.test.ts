import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuidanceStore } from "../src/guidance-store.js";
import {
  collectSupervisorActivity,
  evaluateSupervisorMonitoring,
  SUPERVISOR_MONITOR_AGE_MS,
  SUPERVISOR_MONITOR_COOLDOWN_MS,
  type SupervisorMonitorActivity,
  type SupervisorNativeChildLifecycleEvidence,
} from "../src/supervisor-monitor.js";
import { ProjectSupervisorMonitorStore } from "../src/supervisor-monitor-store.js";
import { defaultMonitoringSettings } from "../src/project-supervisor-contract.js";
import type { Projection } from "../src/types.js";

const now = Date.parse("2026-10-13T10:00:00.000Z");
const projectId = "project-a";
const threadId = "operative-a";

interface EventInput {
  id: string;
  type: string;
  status?: string;
  runOrdinal?: number;
  updatedAt?: number;
  streaming?: boolean;
  inputIntent?: string;
  text?: string;
  nodeKind?: string;
  createdBy?: string;
  creationSource?: string;
  requestId?: string;
  toolName?: string;
}

interface ProjectionOptions {
  threadId?: string;
  runStatus?: string;
  events?: EventInput[];
  runtimeRequests?: Record<string, unknown>[];
}

const nodeKind = (type: string): string => {
  if (type === "user_message") return "user_message";
  if (type === "assistant_message") return "assistant_message";
  if (type === "proposed_plan") return "plan";
  if (type === "todo_list") return "todo_list";
  if (type === "user_input_request") return "user_input_request";
  if (type === "approval_request") return "approval_request";
  if (type === "reasoning") return "reasoning";
  return "tool_call";
};

const makeProjection = (options: ProjectionOptions = {}): Projection => {
  const thread = options.threadId ?? threadId;
  const events = options.events ?? [];
  const ordinals = [...new Set(events.map((event) => event.runOrdinal ?? 1))];
  if (ordinals.length === 0) ordinals.push(1);
  const runs = ordinals.map((ordinal) => {
    const runId = `run-${ordinal}`;
    const completed = options.runStatus === "completed" || options.runStatus === "failed";
    return {
      id: runId,
      threadId: thread,
      ordinal,
      status: options.runStatus ?? "running",
      requestedAt: new Date(now - 60_000).toISOString(),
      startedAt: new Date(now - 55_000).toISOString(),
      completedAt: completed ? new Date(now - 10_000).toISOString() : null,
      rootNodeId: `root-${ordinal}`,
      userMessageId: `task-${ordinal}`,
      providerThreadId: `provider-${ordinal}`,
    };
  });
  const nodes: Record<string, unknown>[] = [];
  const turnItems: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  for (const ordinal of ordinals) {
    const runId = `run-${ordinal}`;
    const rootId = `root-${ordinal}`;
    nodes.push({
      id: rootId,
      threadId: thread,
      runId,
      parentNodeId: null,
      rootNodeId: rootId,
      kind: "root_turn",
      status: "completed",
      providerThreadId: `provider-${ordinal}`,
    });
    let itemOrdinal = 0;
    for (const event of events.filter((candidate) => (candidate.runOrdinal ?? 1) === ordinal)) {
      const itemId = `turn-item-${event.id}`;
      const messageId = `message-${event.id}`;
      const nodeId = `node-${event.id}`;
      const kind = event.nodeKind ?? nodeKind(event.type);
      const parentNodeId = kind === "subagent" ? `subagent-${ordinal}` : rootId;
      if (kind === "subagent") {
        if (!nodes.some((node) => node.id === parentNodeId))
          nodes.push({
            id: parentNodeId,
            threadId: thread,
            runId,
            parentNodeId: rootId,
            rootNodeId: rootId,
            kind: "subagent",
            status: "completed",
            providerThreadId: `provider-${ordinal}`,
          });
      }
      nodes.push({
        id: nodeId,
        threadId: thread,
        runId,
        parentNodeId,
        rootNodeId: rootId,
        kind,
        status: event.status ?? "completed",
        providerThreadId: `provider-${ordinal}`,
      });
      const updatedAt = new Date(event.updatedAt ?? now - 30_000).toISOString();
      const base = {
        id: itemId,
        threadId: thread,
        runId,
        nodeId,
        providerThreadId: `provider-${ordinal}`,
        providerTurnId: `turn-${ordinal}`,
        ordinal: ++itemOrdinal,
        status: event.status ?? "completed",
        startedAt: updatedAt,
        completedAt: ["completed", "failed", "cancelled", "interrupted"].includes(event.status ?? "completed") ? updatedAt : null,
        updatedAt,
        type: event.type,
      };
      if (event.type === "user_input_request" || event.type === "approval_request" || event.type === "secret_request") {
        turnItems.push({
          ...base,
          requestId: event.requestId ?? event.id,
          questions: [],
        });
      } else if (event.type === "user_message" || event.type === "assistant_message") {
        const role = event.type === "user_message" ? "user" : "assistant";
        const createdBy = event.createdBy ?? (role === "user" ? "user" : "agent");
        const creationSource = event.creationSource ?? (role === "user" ? "web" : "provider");
        const text = event.text ?? `${event.id} fixture`;
        turnItems.push({
          ...base,
          messageId,
          text,
          streaming: event.streaming ?? false,
          createdBy,
          creationSource,
          inputIntent: event.inputIntent ?? (role === "user" ? "queued_turn" : undefined),
          attachments: [],
        });
        messages.push({
          id: messageId,
          threadId: thread,
          runId,
          nodeId,
          role,
          text,
          streaming: event.streaming ?? false,
          createdAt: updatedAt,
          updatedAt,
          createdBy,
          creationSource,
        });
      } else {
        turnItems.push({ ...base, input: event.text ?? "fixture command", toolName: event.toolName ?? null });
      }
    }
  }
  return {
    thread: {
      id: thread,
      title: thread,
      projectId,
      lineage: { parentThreadId: null, relationshipToParent: null },
    },
    runs,
    messages: messages as Projection["messages"],
    turnItems,
    runtimeRequests: options.runtimeRequests ?? [],
    nodes,
  };
};

const event = (id: string, updatedAt = now - 30_000): EventInput => ({
  id,
  type: "assistant_message",
  status: "completed",
  updatedAt,
});

const withStore = async <A>(work: (monitor: ProjectSupervisorMonitorStore, store: GuidanceStore, directory: string) => Promise<A> | A): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-monitor-test-"));
  const store = new GuidanceStore(directory);
  try {
    return await work(new ProjectSupervisorMonitorStore(store), store, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const collect = (
  events: EventInput[],
  runStatus = "running",
  at = now,
  ordinal = 1,
  runtimeRequests: Record<string, unknown>[] = [],
): SupervisorMonitorActivity[] =>
  collectSupervisorActivity(makeProjection({ events, runStatus, runtimeRequests }), ordinal, at);

test("monitor extraction deduplicates messages, excludes old/reasoning/child activity, and records streaming versions", () => {
  const projection = makeProjection({
    events: [
      { ...event("old"), runOrdinal: 0 },
      event("assistant"),
      { id: "reasoning", type: "reasoning", status: "completed" },
      { id: "child", type: "dynamic_tool", status: "completed", nodeKind: "subagent" },
      { id: "partial", type: "assistant_message", status: "running", streaming: true, text: "" },
    ],
  });
  const values = collectSupervisorActivity(projection, 1, now);
  assert.deepEqual(values.map((item) => item.id).sort(), ["message:message-assistant", "message:message-partial"]);
  const partial = values.find((item) => item.id === "message:message-partial");
  assert.equal(partial?.status, "streaming");
  assert.equal(values.find((item) => item.id === "message:message-assistant")?.type, "assistant_message");
  assert.equal(values.find((item) => item.id === "message:message-assistant")?.readItemId, "turn-item-assistant");

  const first = makeProjection({ events: [event("paired", now - 30_000)] });
  const beforePairTimestamp = collectSupervisorActivity(first, 1, now)[0]!;
  const pairedItem = (first.turnItems as Record<string, unknown>[])[0]!;
  pairedItem.updatedAt = new Date(now - 10_000).toISOString();
  const afterPairTimestamp = collectSupervisorActivity(first, 1, now)[0]!;
  assert.equal(afterPairTimestamp.version, beforePairTimestamp.version);
  assert.equal(afterPairTimestamp.detectedAt, now - 30_000);

  const sourceInput = makeProjection({
    events: [{ id: "source-task", type: "user_message", status: "completed", inputIntent: "turn_start" }],
  });
  delete (sourceInput.turnItems as Record<string, unknown>[])[0]!.inputIntent;
  assert.equal(collectSupervisorActivity(sourceInput, 1, now)[0]?.priority, null);
});

test("ten finalized activities or one priority event wakes a chat, while cooldown and unchanged acknowledgements stay quiet", async () => {
  await withStore((monitor) => {
    const ten = makeProjection({ events: Array.from({ length: 10 }, (_, index) => event(`count-${index}`)) });
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: ten, now });
    const batch = monitor.select(projectId, defaultMonitoringSettings, now, null);
    assert.ok(batch);
    assert.equal(batch.trigger, "activity_threshold");
    assert.equal(batch.finalizedActivityCount, 10);
    assert.equal(monitor.select(projectId, defaultMonitoringSettings, now, now - 30_000), null);
    assert.ok(monitor.select(projectId, defaultMonitoringSettings, now, now - SUPERVISOR_MONITOR_COOLDOWN_MS));

    monitor.acknowledge(batch, now);
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: ten, now: now + 10_000 });
    assert.equal(monitor.select(projectId, defaultMonitoringSettings, now + 10_000, null), null);

    const priorityProjection = makeProjection({
      events: [{ id: "instruction", type: "user_message", status: "completed", inputIntent: "queued_turn" }],
    });
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: priorityProjection, now: now + 20_000 });
    const priority = monitor.select(projectId, defaultMonitoringSettings, now + 20_000, null);
    assert.ok(priority);
    assert.equal(priority.trigger, "priority");
    assert.deepEqual(priority.threads[0]?.priorityKinds, ["user_instruction"]);
  });
});

test("a sparse finalized activity becomes due after five minutes, and waiting input coalesces as priority", () => {
  const sparse = collect([event("sparse", now - SUPERVISOR_MONITOR_AGE_MS - 1)]);
  const age = evaluateSupervisorMonitoring(sparse, { ...defaultMonitoringSettings, activityThreshold: 10 }, now, null);
  assert.equal(age.due, true);
  assert.equal(age.trigger, "activity_age");
  assert.equal(
    evaluateSupervisorMonitoring(
      sparse,
      { ...defaultMonitoringSettings, intervalMinutes: 10, activityThreshold: 10 },
      now,
      null,
    ).due,
    false,
  );

  const coalesced = collect([
    event("ordinary"),
    { id: "question", type: "user_input_request", status: "waiting", nodeKind: "user_input_request" },
    { id: "instruction", type: "user_message", status: "completed", inputIntent: "queued_turn" },
  ], "running", now, 1, [{
    id: "question",
    nodeId: "node-question",
    kind: "user_input",
    status: "pending",
    createdAt: new Date(now - 1000).toISOString(),
  }]);
  const decision = evaluateSupervisorMonitoring(coalesced, defaultMonitoringSettings, now, null);
  assert.equal(decision.trigger, "priority");
  assert.deepEqual(decision.priorityKinds.sort(), ["user_instruction", "waiting_input"]);
});

test("completed, failed, interrupted and cancelled runs are immediate priorities while rolled-back roots are ignored", () => {
  const completed = collect([], "completed");
  const failed = collect([], "failed");
  const interrupted = collect([], "interrupted");
  const cancelled = collect([], "cancelled");
  assert.deepEqual(completed.map((item) => [item.type, item.priority]), [["run_finished", "run_finished"]]);
  assert.deepEqual(failed.map((item) => [item.type, item.priority]), [["run_failed", "run_failed"]]);
  assert.deepEqual(interrupted.map((item) => [item.type, item.priority]), [["run_failed", "run_failed"]]);
  assert.deepEqual(cancelled.map((item) => [item.type, item.priority]), [["run_failed", "run_failed"]]);

  const rolledBack = makeProjection({ runStatus: "rolled_back" });
  rolledBack.nodes = (rolledBack.nodes as Record<string, unknown>[]).map((node) =>
    node.id === "root-1" ? { ...node, status: "rolled_back" } : node,
  );
  assert.deepEqual(collectSupervisorActivity(rolledBack, 1, now), []);
});

test("pending native runtime requests need an eligible main-graph node and ignore the thread summary", () => {
  const projection = makeProjection({
    events: [{ id: "question", type: "user_input_request", requestId: "request-1", status: "waiting" }],
    runtimeRequests: [{
      id: "request-1",
      nodeId: "node-question",
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: new Date(now - 1000).toISOString(),
      resolvedAt: null,
    }],
  });
  const request = collectSupervisorActivity(projection, 1, now).find((item) => item.id === "request:request-1");
  assert.equal(request?.priority, "waiting_input");
  assert.equal(request?.readItemId, "turn-item-question");

  projection.runtimeRequests = [{
    id: "internal-tool",
    nodeId: "node-question",
    kind: "dynamic_tool_call",
    status: "pending",
    createdAt: new Date(now - 1000).toISOString(),
  }];
  (projection.turnItems as Record<string, unknown>[])[0]!.status = "completed";
  (projection.thread as unknown as Record<string, unknown>).pendingRuntimeRequest = { kind: "user_input" };
  assert.equal(collectSupervisorActivity(projection, 1, now).some((item) => item.priority === "waiting_input"), false);
});

for (const terminalStatus of ["resolved", "expired", "cancelled"] as const) {
  test(`a matched ${terminalStatus} native request clears stale turn-item waiting priority and remains acknowledgeable`, async () => {
    await withStore((monitor) => {
      const projection = makeProjection({
        events: [{id: "question", type: "user_input_request", requestId: "request-1", status: "waiting", nodeKind: "tool_call"}],
        runtimeRequests: [{id: "request-1", nodeId: "node-question", kind: "user_input", status: "pending", createdAt: new Date(now - 1_000).toISOString()}],
      });
      monitor.observe({projectId, threadId, sourceOrdinal: 1, projection, now});
      assert.ok(monitor.pending(projectId, threadId).some(item => item.priority === "waiting_input"));

      const requests = projection.runtimeRequests as Record<string, unknown>[];
      requests[0]!.status = terminalStatus;
      requests[0]!.resolvedAt = new Date(now + 1_000).toISOString();
      monitor.observe({projectId, threadId, sourceOrdinal: 1, projection, now: now + 1_000});
      const terminal = monitor.pending(projectId, threadId).filter(item => item.id === "request:request-1");
      assert.equal(terminal.length, 1, "the turn-item mirror and runtime request share one request identity");
      assert.ok(terminal.every(item => item.status === terminalStatus && item.priority === null));
      assert.equal(monitor.select(projectId, {...defaultMonitoringSettings, activityThreshold: 10}, now + 1_000, null), null,
        "terminal requests follow age/count policy rather than waking as pending input");
      const due = monitor.select(projectId, {...defaultMonitoringSettings, activityThreshold: 1}, now + 1_000, null);
      assert.equal(due?.trigger, "activity_threshold");
      assert.equal(monitor.acknowledge(due!, now + 1_001).acknowledged, 1);
      assert.deepEqual(monitor.pending(projectId, threadId), []);
      assert.deepEqual(monitor.hasPendingReviewableActivity(projectId, [threadId]), {status: "complete", pending: false});
    });
  });
}

test("a terminal run does not clear an exactly matched pending native request", () => {
  const projection = makeProjection({
    runStatus: "completed",
    events: [{id: "question", type: "user_input_request", requestId: "request-1", status: "waiting", nodeKind: "tool_call"}],
    runtimeRequests: [{id: "request-1", nodeId: "node-question", kind: "user_input", status: "pending", createdAt: new Date(now - 1_000).toISOString()}],
  });
  const request = collectSupervisorActivity(projection, 1, now).find(item => item.id === "request:request-1");
  assert.equal(request?.status, "waiting");
  assert.equal(request?.priority, "waiting_input");
});

test("a terminal request with mismatched node identity cannot clear a waiting turn item", () => {
  const projection = makeProjection({
    events: [{id: "question", type: "user_input_request", requestId: "request-1", status: "waiting", nodeKind: "tool_call"}],
    runtimeRequests: [{id: "request-1", nodeId: "different-node", kind: "user_input", status: "expired", createdAt: new Date(now - 1_000).toISOString()}],
  });
  const request = collectSupervisorActivity(projection, 1, now).find(item => item.id === "request:request-1");
  assert.equal(request?.status, "waiting");
  assert.equal(request?.priority, "waiting_input");
});

test("native child terminal evidence is deterministic, priority-ranked and versioned from its direct parent", () => {
  const child = makeProjection({threadId: "native-child"});
  child.runs = [];
  child.thread.lineage = {parentThreadId: "operative-parent", relationshipToParent: "subagent", rootThreadId: "operative-parent"};
  const evidence: SupervisorNativeChildLifecycleEvidence = {parentThreadId: "operative-parent", parentRunId: "parent-run-1",
    recordId: "native-item-1", status: "completed", completedAt: new Date(now - 1_000).toISOString(), updatedAt: new Date(now - 900).toISOString()};
  const first = collectSupervisorActivity(child, 4, now, new Set(), new Set(), true, evidence).find(item => item.type === "native_child_lifecycle");
  const repeated = collectSupervisorActivity(child, 4, now + 10_000, new Set(), new Set(), true,
    {...evidence, updatedAt: new Date(now + 5_000).toISOString()}).find(item => item.type === "native_child_lifecycle");
  assert.ok(first && repeated);
  assert.equal(first.id, "native-child-lifecycle:operative-parent:native-child:native-item-1");
  assert.equal(first.ordinal, 4);
  assert.equal(first.priority, "run_finished");
  assert.equal(first.version, repeated.version);
  assert.equal(first.detectedAt, now - 1_000);
  const decision = evaluateSupervisorMonitoring([first], {...defaultMonitoringSettings, intervalMinutes: 30, activityThreshold: 100}, now, null);
  assert.equal(decision.due, true);
  assert.equal(decision.trigger, "priority");

  const changed = collectSupervisorActivity(child, 4, now + 2_000, new Set(), new Set(), true,
    {...evidence, status: "interrupted", completedAt: new Date(now + 1_000).toISOString(), updatedAt: new Date(now + 1_100).toISOString()})
    .find(item => item.type === "native_child_lifecycle");
  assert.ok(changed);
  assert.equal(changed.id, first.id);
  assert.notEqual(changed.version, first.version);
  assert.equal(changed.priority, "run_failed");
  assert.equal(collectSupervisorActivity(child, 4, now, new Set(), new Set(), false, evidence).some(item => item.type === "native_child_lifecycle"), false);
  const fallback = collectSupervisorActivity(child, 4, now, new Set(), new Set(), true,
    {...evidence, completedAt: null, updatedAt: new Date(now - 500).toISOString()}).find(item => item.type === "native_child_lifecycle");
  assert.equal(fallback?.detectedAt, now - 500);
  assert.equal(collectSupervisorActivity(child, 4, now, new Set(), new Set(), true,
    {...evidence, completedAt: null, updatedAt: null}).some(item => item.type === "native_child_lifecycle"), false);
});

test("native child terminal monitor checkpoints survive restart and ACK only their frozen version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-native-terminal-test-"));
  let store = new GuidanceStore(directory);
  try {
    let monitor = new ProjectSupervisorMonitorStore(store);
    const childId = "native-child-restart";
    const child = makeProjection({threadId: childId});
    child.runs = [];
    child.thread.lineage = {parentThreadId: "operative-parent", relationshipToParent: "subagent", rootThreadId: "operative-parent"};
    const evidence: SupervisorNativeChildLifecycleEvidence = {parentThreadId: "operative-parent", parentRunId: "parent-run-1",
      recordId: "native-item-1", status: "completed", completedAt: new Date(now - 1_000).toISOString(), updatedAt: new Date(now - 900).toISOString()};
    const settings = {...defaultMonitoringSettings, intervalMinutes: 30, activityThreshold: 100};
    const observe = (lifecycle: SupervisorNativeChildLifecycleEvidence, at: number): void => {
      monitor.observe({projectId, threadId: childId, sourceOrdinal: 2, projection: child, now: at,
        includeDetachedChildItems: true, nativeChildLifecycle: lifecycle});
    };
    observe(evidence, now);
    const first = monitor.select(projectId, settings, now, null, {eligibleThreadIds: new Set([childId])});
    assert.ok(first);
    const firstItem = first.threads[0]?.items[0];
    assert.ok(firstItem);

    store.close();
    store = new GuidanceStore(directory);
    monitor = new ProjectSupervisorMonitorStore(store);
    const metadataOnly: SupervisorNativeChildLifecycleEvidence = {...evidence, updatedAt: new Date(now + 1_000).toISOString()};
    observe(metadataOnly, now + 1);
    const resumed = monitor.select(projectId, settings, now + 1, null, {eligibleThreadIds: new Set([childId])});
    assert.ok(resumed);
    assert.equal(resumed.threads[0]?.items[0]?.id, firstItem.id);
    assert.equal(resumed.threads[0]?.items[0]?.version, firstItem.version);
    assert.equal(monitor.acknowledge(first, now + 2).acknowledged, 1,
      "metadata-only updates do not invalidate the frozen completion version");
    observe(metadataOnly, now + 3);
    assert.equal(monitor.select(projectId, settings, now + 3, null, {eligibleThreadIds: new Set([childId])}), null);

    const interrupted: SupervisorNativeChildLifecycleEvidence = {...evidence, status: "interrupted",
      completedAt: new Date(now + 4).toISOString(), updatedAt: new Date(now + 5).toISOString()};
    observe(interrupted, now + 5);
    const revised = monitor.select(projectId, settings, now + 5, null, {eligibleThreadIds: new Set([childId])});
    assert.ok(revised);
    assert.notEqual(revised.threads[0]?.items[0]?.version, firstItem.version);
    assert.equal(monitor.acknowledge(first, now + 6).stale, 1);
    assert.equal(monitor.pending(projectId, childId)[0]?.priority, "run_failed");
    assert.equal(monitor.acknowledge(revised, now + 7).acknowledged, 1);
    observe(interrupted, now + 8);
    assert.equal(monitor.select(projectId, settings, now + 8, null, {eligibleThreadIds: new Set([childId])}), null);
  } finally {
    store.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test("native child ACKs stay out of detached source-floor advancement across repeats, resume and a new completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-native-floor-test-"));
  let store = new GuidanceStore(directory);
  try {
    let monitor = new ProjectSupervisorMonitorStore(store);
    const childId = "native-child-floor";
    const child = makeProjection({threadId: childId});
    child.runs = [];
    child.thread.lineage = {parentThreadId: "operative-parent", relationshipToParent: "subagent", rootThreadId: "operative-parent"};
    const settings = {...defaultMonitoringSettings, intervalMinutes: 30, activityThreshold: 1};
    const eligibleThreadIds = new Set([childId]);
    const evidence: SupervisorNativeChildLifecycleEvidence = {parentThreadId: "operative-parent", parentRunId: "parent-run-1",
      recordId: "native-item-floor", status: "completed", completedAt: new Date(now - 1_000).toISOString(), updatedAt: new Date(now - 900).toISOString()};
    const observe = (lifecycle: SupervisorNativeChildLifecycleEvidence | undefined, at: number): void => {
      monitor.observe({projectId, threadId: childId, sourceOrdinal: 1, projection: child, now: at,
        includeDetachedChildItems: true, ...(lifecycle ? {nativeChildLifecycle: lifecycle} : {})});
    };
    const takeSingle = (at: number, type: string): SupervisorMonitorActivity => {
      const batch = monitor.select(projectId, settings, at, null, {eligibleThreadIds});
      assert.ok(batch);
      const items = batch.threads.flatMap(thread => thread.items);
      assert.equal(items.length, 1);
      assert.equal(items[0]?.type, type);
      assert.equal(monitor.acknowledge(batch, at + 1).acknowledged, 1);
      return items[0]!;
    };

    let nativeWakes = 0;
    for (let cycle = 0; cycle < 6; cycle++) {
      const at = now + cycle * 1_000;
      observe(evidence, at);
      const batch = monitor.select(projectId, settings, at, null, {eligibleThreadIds});
      if (batch) {
        nativeWakes++;
        assert.deepEqual(batch.threads.flatMap(thread => thread.items.map(item => item.type)), ["native_child_lifecycle"]);
        assert.equal(monitor.acknowledge(batch, at + 1).acknowledged, 1);
      }
      assert.equal(monitor.state(projectId, childId).sourceOrdinal, 1);
    }
    assert.equal(nativeWakes, 1, "six identical observations create one terminal wake");

    store.close();
    store = new GuidanceStore(directory);
    monitor = new ProjectSupervisorMonitorStore(store);
    observe(evidence, now + 6_000);
    assert.equal(monitor.select(projectId, settings, now + 6_000, null, {eligibleThreadIds}), null,
      "a restart retains the acknowledged terminal version");
    assert.equal(monitor.state(projectId, childId).sourceOrdinal, 1);

    const interrupted: SupervisorNativeChildLifecycleEvidence = {...evidence, status: "interrupted",
      completedAt: new Date(now + 7_000).toISOString(), updatedAt: new Date(now + 7_100).toISOString()};
    observe(interrupted, now + 7_000);
    takeSingle(now + 7_000, "native_child_lifecycle");
    nativeWakes++;
    observe(interrupted, now + 8_000);
    assert.equal(monitor.select(projectId, settings, now + 8_000, null, {eligibleThreadIds}), null,
      "a changed terminal status produces one new version");
    assert.equal(monitor.state(projectId, childId).sourceOrdinal, 1);

    const priorDetachedItem = {id: "turn-item-prior-native-work", threadId: childId, runId: null, ordinal: 2,
      nodeId: "node-prior-native-work", type: "command_execution", status: "completed",
      startedAt: new Date(now + 8_500).toISOString(), completedAt: new Date(now + 8_500).toISOString(),
      updatedAt: new Date(now + 8_500).toISOString()};
    child.turnItems = [priorDetachedItem];
    observe(interrupted, now + 8_500);
    takeSingle(now + 8_500, "command_execution");
    observe(interrupted, now + 8_600);
    assert.equal(monitor.state(projectId, childId).sourceOrdinal, 3,
      "only the real detached item advances the source floor");
    observe(interrupted, now + 8_700);
    assert.equal(monitor.select(projectId, settings, now + 8_700, null, {eligibleThreadIds}), null,
      "changing the synthetic item's ordinal does not invalidate its ACK");

    const resumedItem = {...priorDetachedItem, id: "turn-item-resumed-native-work", ordinal: 3,
      nodeId: "node-resumed-native-work", startedAt: new Date(now + 9_000).toISOString(),
      completedAt: new Date(now + 9_000).toISOString(), updatedAt: new Date(now + 9_000).toISOString()};
    child.turnItems = [priorDetachedItem, resumedItem];
    observe(undefined, now + 9_000);
    assert.deepEqual(monitor.pending(projectId, childId).map(item => item.id), [resumedItem.id],
      "resumption removes the synthetic terminal row and leaves the next real ordinal reviewable");
    takeSingle(now + 9_000, "command_execution");
    observe(undefined, now + 9_100);
    assert.equal(monitor.state(projectId, childId).sourceOrdinal, 4);
    assert.deepEqual(monitor.pending(projectId, childId), []);

    const laterCompletion: SupervisorNativeChildLifecycleEvidence = {...evidence, completedAt: new Date(now + 10_000).toISOString(),
      updatedAt: new Date(now + 10_100).toISOString()};
    observe(laterCompletion, now + 10_000);
    takeSingle(now + 10_000, "native_child_lifecycle");
    nativeWakes++;
    observe(laterCompletion, now + 11_000);
    assert.equal(monitor.select(projectId, settings, now + 11_000, null, {eligibleThreadIds}), null,
      "a later completion timestamp creates one new wake, then remains acknowledged");
    assert.equal(monitor.state(projectId, childId).sourceOrdinal, 4);
    assert.equal(nativeWakes, 3);
  } finally {
    store.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test("direct peer tool sends are excluded from the activity count", () => {
  const activity = collect([
    { id: "peer-send", type: "dynamic_tool", status: "completed", toolName: "mcp__t3__thread_send" },
    { id: "normal-tool", type: "dynamic_tool", status: "completed", toolName: "exec_command" },
  ]);
  assert.deepEqual(activity.map((item) => item.id), ["turn-item-normal-tool"]);
});

test("a tracked item that completes in place is emitted as a new revision", async () => {
  await withStore((monitor) => {
    const running = makeProjection({
      events: [{ id: "operation", type: "dynamic_tool", status: "running", updatedAt: now - 20_000 }],
    });
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: running, now });
    assert.equal(monitor.pending(projectId, threadId).length, 0);

    const completed = makeProjection({
      events: [{ id: "operation", type: "dynamic_tool", status: "completed", updatedAt: now }],
    });
    const observation = monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: completed, now: now + 1 });
    assert.equal(observation.updated, 1);
    assert.equal(monitor.pending(projectId, threadId)[0]?.status, "completed");
  });
});

test("items rolled out of the current main graph stop triggering and restore without acknowledgement", async () => {
  await withStore((monitor) => {
    const current = makeProjection({ events: [event("rollback-candidate")] });
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: current, now });
    assert.equal(monitor.pending(projectId, threadId).length, 1);

    const rolledBack = makeProjection({ events: [event("rollback-candidate")] });
    rolledBack.runs[0]!.status = "rolled_back";
    rolledBack.nodes = (rolledBack.nodes as Record<string, unknown>[]).map((node) =>
      node.id === "root-1" ? { ...node, status: "rolled_back" } : node,
    );
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: rolledBack, now: now + 1 });
    assert.equal(monitor.pending(projectId, threadId).length, 0);
    assert.equal(monitor.select(projectId, { ...defaultMonitoringSettings, activityThreshold: 1 }, now + 1, null), null);
    assert.equal(monitor.state(projectId, threadId).activities.length, 0);

    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: current, now: now + 2 });
    assert.equal(monitor.pending(projectId, threadId).length, 1);
  });
});

test("a frozen batch acknowledges only matching revisions and keeps arrivals during review", async () => {
  await withStore((monitor) => {
    const initial = makeProjection({ events: Array.from({ length: 10 }, (_, index) => event(`work-${index}`)) });
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: initial, now });
    const frozen = monitor.select(projectId, defaultMonitoringSettings, now, null)!;
    const changedEvents = [
      ...Array.from({ length: 10 }, (_, index) => event(`work-${index}`, index === 0 ? now : now - 30_000)),
      event("arrived-while-busy"),
    ];
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: makeProjection({ events: changedEvents }), now: now + 1 });
    const result = monitor.store.transaction(() => monitor.acknowledgeInTransaction(frozen, now + 2));
    assert.equal(result.acknowledged, 9);
    assert.equal(result.stale, 1);
    const pending = monitor.pending(projectId, threadId);
    assert.ok(pending.some((item) => item.id === "message:message-arrived-while-busy"));
    assert.ok(pending.some((item) => item.id === "message:message-work-0"));
    assert.equal(pending.length, 2);
  });
});

test("completed message and command revisions changed during review remain pending", async () => {
  await withStore((monitor) => {
    const initial = makeProjection({
      events: [
        { ...event("editable-message"), text: "initial assistant reply" },
        { id: "command", type: "command_execution", status: "completed", updatedAt: now - 30_000, text: "printf initial" },
      ],
    });
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: initial, now });
    const frozen = monitor.select(projectId, { ...defaultMonitoringSettings, activityThreshold: 1 }, now, null)!;
    assert.equal(frozen.threads[0]?.items.length, 2);

    const changed = makeProjection({
      events: [
        { ...event("editable-message", now + 1), text: "updated assistant reply" },
        { id: "command", type: "command_execution", status: "completed", updatedAt: now + 1, text: "printf updated" },
      ],
    });
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: changed, now: now + 1 });
    const result = monitor.acknowledge(frozen, now + 2);
    assert.equal(result.acknowledged, 0);
    assert.equal(result.stale, 2);
    assert.equal(monitor.pending(projectId, threadId).length, 2);
  });
});

test("monitor metadata survives a store restart without persisting activity bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-monitor-restart-"));
  let store = new GuidanceStore(directory);
  try {
    let monitor = new ProjectSupervisorMonitorStore(store);
    monitor.observe({
      projectId,
      threadId,
      sourceOrdinal: 1,
      projection: makeProjection({ events: [event("durable", now - 30_000), { id: "secret", type: "command_execution", status: "completed", text: "token=super-secret" }] }),
      now,
    });
    store.close();
    store = new GuidanceStore(directory);
    monitor = new ProjectSupervisorMonitorStore(store);
    const pending = monitor.pending(projectId, threadId);
    assert.equal(pending.length, 2);
    const rows = store.db
      .prepare("SELECT item_id,type,status,version FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
      .all(projectId, threadId);
    assert.equal(JSON.stringify(rows).includes("super-secret"), false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch selection interleaves due chats under a global cap and reports explicit saturation", async () => {
  await withStore((monitor) => {
    const settings = { ...defaultMonitoringSettings, activityThreshold: 1 };
    for (const id of ["chat-a", "chat-b"])
      monitor.observe({
        projectId,
        threadId: id,
        sourceOrdinal: 1,
        projection: makeProjection({
          threadId: id,
          events: [event(`${id}-one`), event(`${id}-two`)],
        }),
        now,
      });
    const fair = monitor.select(projectId, settings, now, null, { maxItems: 2, maxItemsPerThread: 1 });
    assert.ok(fair);
    assert.deepEqual(fair.threads.map((thread) => thread.threadId), ["chat-a", "chat-b"]);
    assert.equal(fair.truncated, true);
    assert.equal(fair.threads[0]?.items.length, 2);

    const frozenLimit = monitor.select(projectId, settings, now, null, {
      maxItems: 2,
      maxItemsPerThread: 1,
      maxFrozenItems: 2,
    });
    assert.ok(frozenLimit);
    assert.deepEqual(frozenLimit.threads.map((thread) => thread.threadId), ["chat-a"]);
    assert.equal(frozenLimit.threads[0]?.items.length, 2);
    monitor.acknowledge(frozenLimit, now + 1);
    const remaining = monitor.select(projectId, settings, now + 2, null, {
      maxItems: 2,
      maxItemsPerThread: 1,
      maxFrozenItems: 2,
    });
    assert.ok(remaining);
    assert.deepEqual(remaining.threads.map((thread) => thread.threadId), ["chat-b"]);

    const limited = new ProjectSupervisorMonitorStore(monitor.store, 1);
    const saturated = limited.observe({
      projectId,
      threadId: "chat-c",
      sourceOrdinal: 1,
      projection: makeProjection({
        threadId: "chat-c",
        events: [event("capacity-one"), event("capacity-two")],
      }),
      now,
    });
    assert.equal(saturated.saturated, true);
    assert.equal(saturated.untrackedCount, 1);
    assert.equal(limited.state(projectId, "chat-c").activities.length, 1);
  });
});

test("acknowledged closed runs advance the source floor and release per-thread history capacity", async () => {
  await withStore((monitor, store) => {
    const bounded = new ProjectSupervisorMonitorStore(store, 4);
    let events: EventInput[] = [];
    for (let ordinal = 1; ordinal <= 12; ordinal++) {
      events = [...events, { ...event(`run-${ordinal}-reply`), runOrdinal: ordinal }];
      const projection = makeProjection({ events });
      for (const run of projection.runs) {
        run.status = "completed";
        run.completedAt = new Date(now + run.ordinal).toISOString();
      }
      const observedAt = now + ordinal * 1000;
      const observation = bounded.observe({ projectId, threadId, sourceOrdinal: 1, projection, now: observedAt });
      assert.equal(observation.saturated, false);
      const batch = bounded.select(projectId, defaultMonitoringSettings, observedAt, null);
      assert.ok(batch);
      assert.equal(batch.threads[0]?.items.length, 2);
      bounded.acknowledge(batch, observedAt + 1);
      const stored = Number(store.db
        .prepare("SELECT COUNT(*) AS count FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
        .get(projectId, threadId)?.count ?? 0);
      assert.ok(stored <= 4);
    }
    const latest = makeProjection({ events });
    for (const run of latest.runs) {
      run.status = "completed";
      run.completedAt = new Date(now + run.ordinal).toISOString();
    }
    bounded.observe({ projectId, threadId, sourceOrdinal: 1, projection: latest, now: now + 13_000 });
    assert.equal(bounded.state(projectId, threadId).sourceOrdinal, 13);
    assert.equal(bounded.state(projectId, threadId).saturated, false);
    assert.equal(Number(store.db
      .prepare("SELECT COUNT(*) AS count FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
      .get(projectId, threadId)?.count ?? 0), 0);
  });
});

test("a rollback before review releases obsolete metadata and does not pin later closed runs", async () => {
  await withStore((monitor, store) => {
    const bounded = new ProjectSupervisorMonitorStore(store, 100);
    const thread = "rollback-lifetime";
    const rolledBackEvents = Array.from({ length: 49 }, (_, index) =>
      event(`rolled-back-${index}`, now - 60_000 + index),
    );
    const beforeRollback = makeProjection({ threadId: thread, events: rolledBackEvents });
    beforeRollback.runs[0]!.status = "completed";
    beforeRollback.runs[0]!.completedAt = new Date(now).toISOString();
    bounded.observe({ projectId, threadId: thread, sourceOrdinal: 1, projection: beforeRollback, now });
    assert.equal(Number(store.db
      .prepare("SELECT COUNT(*) AS count FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
      .get(projectId, thread)?.count ?? 0), 50);

    const rolledBack = makeProjection({ threadId: thread, events: rolledBackEvents });
    rolledBack.runs[0]!.status = "rolled_back";
    rolledBack.nodes = (rolledBack.nodes as Array<Record<string, unknown>>).map((node) =>
      node.id === "root-1" ? { ...node, status: "rolled_back" } : node,
    );
    const rollbackObservation = bounded.observe({
      projectId,
      threadId: thread,
      sourceOrdinal: 1,
      projection: rolledBack,
      now: now + 1,
    });
    assert.equal(rollbackObservation.sourceOrdinal, 2);
    assert.equal(rollbackObservation.saturated, false);
    assert.equal(Number(store.db
      .prepare("SELECT COUNT(*) AS count FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
      .get(projectId, thread)?.count ?? 0), 0);

    let events = rolledBackEvents.map((item) => ({ ...item, runOrdinal: 1 }));
    for (let ordinal = 2; ordinal <= 7; ordinal++) {
      events = [...events, { ...event(`later-${ordinal}`), runOrdinal: ordinal }];
      const projection = makeProjection({ threadId: thread, events });
      for (const run of projection.runs) {
        run.status = run.ordinal === 1 ? "rolled_back" : "completed";
        run.completedAt = run.ordinal === 1 ? null : new Date(now + run.ordinal).toISOString();
      }
      projection.nodes = (projection.nodes as Array<Record<string, unknown>>).map((node) =>
        node.runId === "run-1" ? { ...node, status: "rolled_back" } : node,
      );
      const observedAt = now + ordinal * 1000;
      const observation = bounded.observe({
        projectId,
        threadId: thread,
        sourceOrdinal: 1,
        projection,
        now: observedAt,
      });
      assert.equal(observation.saturated, false);
      const batch = bounded.select(
        projectId,
        { ...defaultMonitoringSettings, activityThreshold: 1 },
        observedAt,
        null,
      );
      assert.ok(batch);
      bounded.acknowledge(batch, observedAt + 1);
    }

    const latest = makeProjection({ threadId: thread, events });
    for (const run of latest.runs) {
      run.status = run.ordinal === 1 ? "rolled_back" : "completed";
      run.completedAt = run.ordinal === 1 ? null : new Date(now + run.ordinal).toISOString();
    }
    latest.nodes = (latest.nodes as Array<Record<string, unknown>>).map((node) =>
      node.runId === "run-1" ? { ...node, status: "rolled_back" } : node,
    );
    bounded.observe({
      projectId,
      threadId: thread,
      sourceOrdinal: 1,
      projection: latest,
      now: now + 8_000,
    });
    const state = bounded.state(projectId, thread);
    assert.equal(state.sourceOrdinal, 8);
    assert.equal(state.saturated, false);
    assert.equal(state.untrackedCount, 0);
    assert.equal(Number(store.db
      .prepare("SELECT COUNT(*) AS count FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
      .get(projectId, thread)?.count ?? 0), 0);
  });
});

test("a later unfinished run blocks floor advancement until its same item completes", async () => {
  await withStore((monitor) => {
    const first = makeProjection({ events: [{ ...event("first-reply"), runOrdinal: 1 }] });
    first.runs[0]!.status = "completed";
    first.runs[0]!.completedAt = new Date(now).toISOString();
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: first, now });
    const firstBatch = monitor.select(projectId, defaultMonitoringSettings, now, null)!;
    monitor.acknowledge(firstBatch, now + 1);

    const running = makeProjection({ events: [
      { ...event("first-reply"), runOrdinal: 1 },
      { id: "later-operation", type: "dynamic_tool", status: "running", runOrdinal: 2 },
    ] });
    running.runs[0]!.status = "completed";
    running.runs[0]!.completedAt = new Date(now).toISOString();
    running.runs[1]!.status = "running";
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: running, now: now + 2 });
    assert.equal(monitor.state(projectId, threadId).sourceOrdinal, 2);
    assert.equal(monitor.pending(projectId, threadId).length, 0);

    const completed = makeProjection({ events: [
      { ...event("first-reply"), runOrdinal: 1 },
      { id: "later-operation", type: "dynamic_tool", status: "completed", runOrdinal: 2, updatedAt: now + 3 },
    ] });
    completed.runs[0]!.status = "completed";
    completed.runs[0]!.completedAt = new Date(now).toISOString();
    completed.runs[1]!.status = "completed";
    completed.runs[1]!.completedAt = new Date(now + 3).toISOString();
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: completed, now: now + 3 });
    assert.ok(monitor.pending(projectId, threadId).some((item) => item.id === "turn-item-later-operation" && item.status === "completed"));
  });
});

test("pending and changed revisions of a closed run hold the source floor until acknowledged", async () => {
  await withStore((monitor) => {
    const projection = makeProjection({ events: [event("closed-editable-reply")] });
    projection.runs[0]!.status = "completed";
    projection.runs[0]!.completedAt = new Date(now).toISOString();
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection, now });
    assert.equal(monitor.state(projectId, threadId).sourceOrdinal, 1);
    const firstBatch = monitor.select(
      projectId,
      { ...defaultMonitoringSettings, activityThreshold: 1 },
      now,
      null,
    )!;
    monitor.acknowledge(firstBatch, now + 1);

    projection.messages[0]!.text = "revised after the first review";
    projection.messages[0]!.updatedAt = new Date(now + 2).toISOString();
    projection.turnItems![0]!.text = "revised after the first review";
    projection.turnItems![0]!.updatedAt = new Date(now + 2).toISOString();
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection, now: now + 2 });
    assert.equal(monitor.state(projectId, threadId).sourceOrdinal, 1);
    assert.ok(monitor.pending(projectId, threadId).some((item) => item.id === "message:message-closed-editable-reply"));

    const revisedBatch = monitor.select(
      projectId,
      { ...defaultMonitoringSettings, activityThreshold: 1 },
      now + 2,
      null,
    )!;
    monitor.acknowledge(revisedBatch, now + 3);
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection, now: now + 4 });
    assert.equal(monitor.state(projectId, threadId).sourceOrdinal, 2);
    assert.equal(monitor.pending(projectId, threadId).length, 0);
  });
});

test("a live current-graph restart of a pruned run rewinds only to its activation floor", async () => {
  await withStore((monitor) => {
    const completed = makeProjection({ events: [event("before-restart")] });
    completed.runs[0]!.status = "completed";
    completed.runs[0]!.completedAt = new Date(now).toISOString();
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: completed, now });
    const completedBatch = monitor.select(projectId, defaultMonitoringSettings, now, null)!;
    monitor.acknowledge(completedBatch, now + 1);
    const pruned = monitor.observe({
      projectId,
      threadId,
      sourceOrdinal: 1,
      projection: completed,
      now: now + 2,
    });
    assert.equal(pruned.sourceOrdinal, 2);
    assert.equal(monitor.state(projectId, threadId).activities.length, 0);

    const restarted = makeProjection({ events: [event("after-restart", now + 3)] });
    restarted.runs[0]!.status = "running";
    restarted.runs[0]!.activeAttemptId = "attempt-restarted";
    (restarted.nodes as Array<Record<string, unknown>>)[0]!.status = "running";
    const resumed = monitor.observe({
      projectId,
      threadId,
      sourceOrdinal: 1,
      projection: restarted,
      now: now + 3,
    });
    assert.equal(resumed.sourceOrdinal, 1);
    assert.ok(monitor.pending(projectId, threadId).some((item) => item.id === "message:message-after-restart"));

    const olderActive = makeProjection({ threadId: "late-activation", events: [
      { ...event("older-run-work"), runOrdinal: 1 },
      { ...event("activation-run-work"), runOrdinal: 2 },
    ] });
    olderActive.runs[0]!.status = "running";
    olderActive.runs[0]!.activeAttemptId = "older-attempt";
    olderActive.runs[1]!.status = "completed";
    olderActive.runs[1]!.completedAt = new Date(now).toISOString();
    (olderActive.nodes as Array<Record<string, unknown>>)[0]!.status = "running";
    monitor.observe({
      projectId,
      threadId: "late-activation",
      sourceOrdinal: 2,
      projection: olderActive,
      now: now + 4,
    });
    const baselineGuard = monitor.state(projectId, "late-activation");
    assert.equal(baselineGuard.sourceOrdinal, 2);
    assert.ok(baselineGuard.activities.every((item) => item.ordinal >= 2));
  });
});

test("an old frozen batch cannot acknowledge a restored item under a changed root", async () => {
  await withStore((monitor) => {
    const events = [event("same-root-item")];
    const completed = makeProjection({ events });
    completed.runs[0]!.status = "completed";
    completed.runs[0]!.completedAt = new Date(now).toISOString();
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: completed, now });
    const oldBatch = monitor.select(projectId, defaultMonitoringSettings, now, null)!;
    const oldItem = oldBatch.threads[0]!.items.find((item) => item.id === "message:message-same-root-item")!;
    monitor.acknowledge(oldBatch, now + 1);
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: completed, now: now + 2 });
    assert.equal(monitor.state(projectId, threadId).sourceOrdinal, 2);

    const restarted = makeProjection({ events });
    restarted.runs[0]!.status = "running";
    restarted.runs[0]!.activeAttemptId = "replacement-attempt";
    restarted.runs[0]!.rootNodeId = "root-restarted";
    const nodes = restarted.nodes as Array<Record<string, unknown>>;
    for (const node of nodes) {
      if (node.id === "root-1") {
        node.id = "root-restarted";
        node.rootNodeId = "root-restarted";
        node.status = "running";
      } else if (node.runId === "run-1") {
        node.rootNodeId = "root-restarted";
        if (node.parentNodeId === "root-1") node.parentNodeId = "root-restarted";
      }
    }
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: restarted, now: now + 3 });
    const restored = monitor.pending(projectId, threadId).find((item) => item.id === oldItem.id);
    assert.ok(restored);
    assert.notEqual(restored.version, oldItem.version);

    const result = monitor.acknowledge(oldBatch, now + 4);
    assert.equal(result.acknowledged, 0);
    assert.equal(result.stale, oldBatch.threads[0]!.items.length);
    assert.ok(monitor.pending(projectId, threadId).some((item) => item.id === oldItem.id));
  });
});

test("a hundred-command burst freezes all revisions and previews only a bounded sample", async () => {
  await withStore((monitor, store) => {
    const initialEvents = Array.from({ length: 100 }, (_, index) => ({
      id: `command-${index}`,
      type: "command_execution",
      status: "completed",
      updatedAt: now - 30_000,
      text: `run command ${index}`,
    }));
    const initial = makeProjection({ events: initialEvents });
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: initial, now });
    const frozen = monitor.select(projectId, defaultMonitoringSettings, now, null)!;
    assert.equal(frozen.pendingItemCount, 100);
    assert.equal(frozen.threads[0]?.pendingItemCount, 100);
    assert.equal(frozen.threads[0]?.items.length, 100);
    assert.equal(frozen.threads[0]?.previewItems.length, 20);
    assert.equal(frozen.truncated, true);

    const whileBusy = makeProjection({ events: [
      ...initialEvents.map((item, index) => ({
        ...item,
        updatedAt: index === 0 ? now + 1 : item.updatedAt,
        text: index === 0 ? "updated command" : item.text,
      })),
      { id: "arrived-during-review", type: "command_execution", status: "completed", updatedAt: now + 1, text: "new command" },
    ] });
    monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: whileBusy, now: now + 1 });
    const result = store.transaction(() => monitor.acknowledgeInTransaction(frozen, now + 2));
    assert.equal(result.acknowledged, 99);
    assert.equal(result.stale, 1);
    const pending = monitor.pending(projectId, threadId);
    assert.deepEqual(pending.map((item) => item.id).sort(), ["turn-item-arrived-during-review", "turn-item-command-0"]);
  });
});

test("rollback cleanup restores complete current coverage and clears saturation", async () => {
  await withStore((monitor, store) => {
    const bounded = new ProjectSupervisorMonitorStore(store, 2);
    const initialEvents = [
      { ...event("tracked-a", now - 30_000), type: "command_execution" },
      { ...event("rolled-out-b", now - 20_000), type: "command_execution" },
      { ...event("untracked-c", now - 10_000), type: "command_execution" },
    ];
    const initial = makeProjection({ events: initialEvents });
    const saturated = bounded.observe({ projectId, threadId, sourceOrdinal: 1, projection: initial, now });
    assert.equal(saturated.saturated, true);
    assert.equal(saturated.untrackedCount, 1);
    assert.deepEqual(bounded.pending(projectId, threadId).map((item) => item.id).sort(), [
      "turn-item-rolled-out-b",
      "turn-item-tracked-a",
    ]);

    const afterRollback = makeProjection({
      events: [initialEvents[0]!, initialEvents[2]!],
    });
    const restored = bounded.observe({
      projectId,
      threadId,
      sourceOrdinal: 1,
      projection: afterRollback,
      now: now + 1,
    });
    assert.equal(restored.saturated, false);
    assert.equal(restored.untrackedCount, 0);
    assert.deepEqual(bounded.pending(projectId, threadId).map((item) => item.id).sort(), [
      "turn-item-tracked-a",
      "turn-item-untracked-c",
    ]);
    const state = bounded.state(projectId, threadId);
    assert.equal(state.saturated, false);
    assert.equal(state.saturationAt, null);
    assert.equal(state.untrackedCount, 0);
    assert.equal(Number(store.db
      .prepare("SELECT COUNT(*) AS count FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
      .get(projectId, threadId)?.count ?? 0), 2);
  });
});

test("an over-cap active run reports saturation and blocks its closed-run floor", async () => {
  await withStore((monitor, store) => {
    const bounded = new ProjectSupervisorMonitorStore(store, 1);
    const projection = makeProjection({ events: [
      event("tracked-before-cap"),
      event("untracked-after-cap"),
    ] });
    const first = bounded.observe({ projectId, threadId, sourceOrdinal: 1, projection, now });
    assert.equal(first.saturated, true);
    assert.equal(first.untrackedCount, 1);
    const firstBatch = bounded.select(
      projectId,
      { ...defaultMonitoringSettings, activityThreshold: 1 },
      now,
      null,
    )!;
    bounded.acknowledge(firstBatch, now + 1);

    projection.runs[0]!.status = "completed";
    projection.runs[0]!.completedAt = new Date(now + 2).toISOString();
    const closed = bounded.observe({
      projectId,
      threadId,
      sourceOrdinal: 1,
      projection,
      now: now + 2,
    });
    assert.equal(closed.sourceOrdinal, 1);
    assert.equal(closed.saturated, true);
    assert.equal(closed.untrackedCount, 2);
    assert.equal(bounded.state(projectId, threadId).activities.length, 0);
    assert.equal(Number(store.db
      .prepare("SELECT COUNT(*) AS count FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
      .get(projectId, threadId)?.count ?? 0), 1);
  });
});
