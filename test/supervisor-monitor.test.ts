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

test("run completion and failure are immediate priorities while rolled-back roots are ignored", () => {
  const completed = collect([], "completed");
  const failed = collect([], "failed");
  assert.deepEqual(completed.map((item) => [item.type, item.priority]), [["run_finished", "run_finished"]]);
  assert.deepEqual(failed.map((item) => [item.type, item.priority]), [["run_failed", "run_failed"]]);

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
  (projection.thread as unknown as Record<string, unknown>).pendingRuntimeRequest = { kind: "user_input" };
  assert.equal(collectSupervisorActivity(projection, 1, now).some((item) => item.priority === "waiting_input"), false);
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
