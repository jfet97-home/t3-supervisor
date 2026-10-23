import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Scheduler } from "effect";
import { GuidanceDb } from "../src/db.js";
import { GuidanceStoreError } from "../src/guidance-sql.js";
import { defaultMonitoringSettings } from "../src/project-supervisor-contract.js";
import {
  SUPERVISOR_MONITOR_COOLDOWN_MS,
  type SupervisorNativeChildLifecycleEvidence,
} from "../src/supervisor-monitor.js";
import {
  InvalidMonitorCapacity,
  InvalidMonitorObservation,
  makeProjectSupervisorMonitorStore,
  ProjectSupervisorMonitorStore,
  type ProjectSupervisorMonitorStoreShape,
} from "../src/supervisor-monitor-store.js";
import type { SupervisorMonitorObservation } from "../src/supervisor-monitor-store.js";
import type { Projection } from "../src/types.js";
import { guidanceDb, rows, temporaryDirectory } from "./support/guidance-store-services.js";

// the store-backed cases of test/supervisor-monitor.test.ts on the ProjectSupervisorMonitorStore effect service (same
// names and assertions; the pure extraction cases stay there), then CT-MSTORE-01 and CT-MSTORE-02 at service level and
// the frozen-batch acknowledgement inside the caller's transaction (CC-MONITOR-ACK)

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

const layer = (directory: string) => ProjectSupervisorMonitorStore.layer.pipe(Layer.provideMerge(guidanceDb(directory)));

type Monitor = ProjectSupervisorMonitorStoreShape;
type Db = GuidanceDb["Service"];

// one open of the client and the store on `directory`; a second call is a store restart
const withMonitorAt = <A, E>(directory: string, work: (monitor: Monitor, db: Db) => Effect.Effect<A, E, GuidanceDb>) =>
  Effect.gen(function* () {
    return yield* work(yield* ProjectSupervisorMonitorStore, yield* GuidanceDb);
  }).pipe(Effect.provide(layer(directory)));

const withStore = <A, E>(work: (monitor: Monitor, db: Db) => Effect.Effect<A, E, GuidanceDb>) =>
  Effect.flatMap(temporaryDirectory, (directory) => withMonitorAt(directory, work));

const storedCount = (db: Db, thread: string) => Effect.map(
  rows(db, "SELECT COUNT(*) AS count FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?", projectId, thread),
  ([row]) => Number(row?.count ?? 0));

describe("ProjectSupervisorMonitorStore", () => {
  it.live("ten finalized activities or one priority event wakes a chat, while cooldown and unchanged acknowledgements stay quiet", () =>
    withStore((monitor) => Effect.gen(function* () {
      const ten = makeProjection({ events: Array.from({ length: 10 }, (_, index) => event(`count-${index}`)) });
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: ten, now });
      const batch = yield* monitor.select(projectId, defaultMonitoringSettings, now, null);
      assert.ok(batch);
      assert.equal(batch.trigger, "activity_threshold");
      assert.equal(batch.finalizedActivityCount, 10);
      assert.equal(yield* monitor.select(projectId, defaultMonitoringSettings, now, now - 30_000), null);
      assert.ok(yield* monitor.select(projectId, defaultMonitoringSettings, now, now - SUPERVISOR_MONITOR_COOLDOWN_MS));

      yield* monitor.acknowledge(batch, now);
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: ten, now: now + 10_000 });
      assert.equal(yield* monitor.select(projectId, defaultMonitoringSettings, now + 10_000, null), null);

      const priorityProjection = makeProjection({
        events: [{ id: "instruction", type: "user_message", status: "completed", inputIntent: "queued_turn" }],
      });
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: priorityProjection, now: now + 20_000 });
      const priority = yield* monitor.select(projectId, defaultMonitoringSettings, now + 20_000, null);
      assert.ok(priority);
      assert.equal(priority.trigger, "priority");
      assert.deepEqual(priority.threads[0]?.priorityKinds, ["user_instruction"]);
    })), { timeout: 10_000 });

  for (const terminalStatus of ["resolved", "expired", "cancelled"] as const) {
    it.live(`a matched ${terminalStatus} native request clears stale turn-item waiting priority and remains acknowledgeable`, () =>
      withStore((monitor) => Effect.gen(function* () {
        const projection = makeProjection({
          events: [{id: "question", type: "user_input_request", requestId: "request-1", status: "waiting", nodeKind: "tool_call"}],
          runtimeRequests: [{id: "request-1", nodeId: "node-question", kind: "user_input", status: "pending", createdAt: new Date(now - 1_000).toISOString()}],
        });
        yield* monitor.observe({projectId, threadId, sourceOrdinal: 1, projection, now});
        assert.ok((yield* monitor.pending(projectId, threadId)).some(item => item.priority === "waiting_input"));

        const requests = projection.runtimeRequests as Record<string, unknown>[];
        requests[0]!.status = terminalStatus;
        requests[0]!.resolvedAt = new Date(now + 1_000).toISOString();
        yield* monitor.observe({projectId, threadId, sourceOrdinal: 1, projection, now: now + 1_000});
        const terminal = (yield* monitor.pending(projectId, threadId)).filter(item => item.id === "request:request-1");
        assert.equal(terminal.length, 1, "the turn-item mirror and runtime request share one request identity");
        assert.ok(terminal.every(item => item.status === terminalStatus && item.priority === null));
        assert.equal(yield* monitor.select(projectId, {...defaultMonitoringSettings, activityThreshold: 10}, now + 1_000, null), null,
          "terminal requests follow age/count policy rather than waking as pending input");
        const due = yield* monitor.select(projectId, {...defaultMonitoringSettings, activityThreshold: 1}, now + 1_000, null);
        assert.equal(due?.trigger, "activity_threshold");
        assert.equal((yield* monitor.acknowledge(due!, now + 1_001)).acknowledged, 1);
        assert.deepEqual(yield* monitor.pending(projectId, threadId), []);
        assert.deepEqual(yield* monitor.hasPendingReviewableActivity(projectId, [threadId]), {status: "complete", pending: false});
      })), { timeout: 10_000 });
  }

  it.live("native child terminal monitor checkpoints survive restart and ACK only their frozen version", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const childId = "native-child-restart";
    const child = makeProjection({threadId: childId});
    child.runs = [];
    child.thread.lineage = {parentThreadId: "operative-parent", relationshipToParent: "subagent", rootThreadId: "operative-parent"};
    const evidence: SupervisorNativeChildLifecycleEvidence = {parentThreadId: "operative-parent", parentRunId: "parent-run-1",
      recordId: "native-item-1", status: "completed", completedAt: new Date(now - 1_000).toISOString(), updatedAt: new Date(now - 900).toISOString()};
    const settings = {...defaultMonitoringSettings, intervalMinutes: 30, activityThreshold: 100};
    const observe = (monitor: Monitor, lifecycle: SupervisorNativeChildLifecycleEvidence, at: number) =>
      Effect.asVoid(monitor.observe({projectId, threadId: childId, sourceOrdinal: 2, projection: child, now: at,
        includeDetachedChildItems: true, nativeChildLifecycle: lifecycle}));
    const { first, firstItem } = yield* withMonitorAt(directory, (monitor) => Effect.gen(function* () {
      yield* observe(monitor, evidence, now);
      const first = yield* monitor.select(projectId, settings, now, null, {eligibleThreadIds: new Set([childId])});
      assert.ok(first);
      const firstItem = first.threads[0]?.items[0];
      assert.ok(firstItem);
      return { first, firstItem };
    }));

    yield* withMonitorAt(directory, (monitor) => Effect.gen(function* () {
      const metadataOnly: SupervisorNativeChildLifecycleEvidence = {...evidence, updatedAt: new Date(now + 1_000).toISOString()};
      yield* observe(monitor, metadataOnly, now + 1);
      const resumed = yield* monitor.select(projectId, settings, now + 1, null, {eligibleThreadIds: new Set([childId])});
      assert.ok(resumed);
      assert.equal(resumed.threads[0]?.items[0]?.id, firstItem.id);
      assert.equal(resumed.threads[0]?.items[0]?.version, firstItem.version);
      assert.equal((yield* monitor.acknowledge(first, now + 2)).acknowledged, 1,
        "metadata-only updates do not invalidate the frozen completion version");
      yield* observe(monitor, metadataOnly, now + 3);
      assert.equal(yield* monitor.select(projectId, settings, now + 3, null, {eligibleThreadIds: new Set([childId])}), null);

      const interrupted: SupervisorNativeChildLifecycleEvidence = {...evidence, status: "interrupted",
        completedAt: new Date(now + 4).toISOString(), updatedAt: new Date(now + 5).toISOString()};
      yield* observe(monitor, interrupted, now + 5);
      const revised = yield* monitor.select(projectId, settings, now + 5, null, {eligibleThreadIds: new Set([childId])});
      assert.ok(revised);
      assert.notEqual(revised.threads[0]?.items[0]?.version, firstItem.version);
      assert.equal((yield* monitor.acknowledge(first, now + 6)).stale, 1);
      assert.equal((yield* monitor.pending(projectId, childId))[0]?.priority, "run_failed");
      assert.equal((yield* monitor.acknowledge(revised, now + 7)).acknowledged, 1);
      yield* observe(monitor, interrupted, now + 8);
      assert.equal(yield* monitor.select(projectId, settings, now + 8, null, {eligibleThreadIds: new Set([childId])}), null);
    }));
  }), { timeout: 10_000 });

  it.live("native child ACKs stay out of detached source-floor advancement across repeats, resume and a new completion", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const childId = "native-child-floor";
    const child = makeProjection({threadId: childId});
    child.runs = [];
    child.thread.lineage = {parentThreadId: "operative-parent", relationshipToParent: "subagent", rootThreadId: "operative-parent"};
    const settings = {...defaultMonitoringSettings, intervalMinutes: 30, activityThreshold: 1};
    const eligibleThreadIds = new Set([childId]);
    const evidence: SupervisorNativeChildLifecycleEvidence = {parentThreadId: "operative-parent", parentRunId: "parent-run-1",
      recordId: "native-item-floor", status: "completed", completedAt: new Date(now - 1_000).toISOString(), updatedAt: new Date(now - 900).toISOString()};
    const observe = (monitor: Monitor, lifecycle: SupervisorNativeChildLifecycleEvidence | undefined, at: number) =>
      Effect.asVoid(monitor.observe({projectId, threadId: childId, sourceOrdinal: 1, projection: child, now: at,
        includeDetachedChildItems: true, ...(lifecycle ? {nativeChildLifecycle: lifecycle} : {})}));
    const takeSingle = (monitor: Monitor, at: number, type: string) => Effect.gen(function* () {
      const batch = yield* monitor.select(projectId, settings, at, null, {eligibleThreadIds});
      assert.ok(batch);
      const items = batch.threads.flatMap(thread => thread.items);
      assert.equal(items.length, 1);
      assert.equal(items[0]?.type, type);
      assert.equal((yield* monitor.acknowledge(batch, at + 1)).acknowledged, 1);
      return items[0]!;
    });

    let nativeWakes = 0;
    yield* withMonitorAt(directory, (monitor) => Effect.gen(function* () {
      for (let cycle = 0; cycle < 6; cycle++) {
        const at = now + cycle * 1_000;
        yield* observe(monitor, evidence, at);
        const batch = yield* monitor.select(projectId, settings, at, null, {eligibleThreadIds});
        if (batch) {
          nativeWakes++;
          assert.deepEqual(batch.threads.flatMap(thread => thread.items.map(item => item.type)), ["native_child_lifecycle"]);
          assert.equal((yield* monitor.acknowledge(batch, at + 1)).acknowledged, 1);
        }
        assert.equal((yield* monitor.state(projectId, childId)).sourceOrdinal, 1);
      }
      assert.equal(nativeWakes, 1, "six identical observations create one terminal wake");
    }));

    yield* withMonitorAt(directory, (monitor) => Effect.gen(function* () {
      yield* observe(monitor, evidence, now + 6_000);
      assert.equal(yield* monitor.select(projectId, settings, now + 6_000, null, {eligibleThreadIds}), null,
        "a restart retains the acknowledged terminal version");
      assert.equal((yield* monitor.state(projectId, childId)).sourceOrdinal, 1);

      const interrupted: SupervisorNativeChildLifecycleEvidence = {...evidence, status: "interrupted",
        completedAt: new Date(now + 7_000).toISOString(), updatedAt: new Date(now + 7_100).toISOString()};
      yield* observe(monitor, interrupted, now + 7_000);
      yield* takeSingle(monitor, now + 7_000, "native_child_lifecycle");
      nativeWakes++;
      yield* observe(monitor, interrupted, now + 8_000);
      assert.equal(yield* monitor.select(projectId, settings, now + 8_000, null, {eligibleThreadIds}), null,
        "a changed terminal status produces one new version");
      assert.equal((yield* monitor.state(projectId, childId)).sourceOrdinal, 1);

      const priorDetachedItem = {id: "turn-item-prior-native-work", threadId: childId, runId: null, ordinal: 2,
        nodeId: "node-prior-native-work", type: "command_execution", status: "completed",
        startedAt: new Date(now + 8_500).toISOString(), completedAt: new Date(now + 8_500).toISOString(),
        updatedAt: new Date(now + 8_500).toISOString()};
      child.turnItems = [priorDetachedItem];
      yield* observe(monitor, interrupted, now + 8_500);
      yield* takeSingle(monitor, now + 8_500, "command_execution");
      yield* observe(monitor, interrupted, now + 8_600);
      assert.equal((yield* monitor.state(projectId, childId)).sourceOrdinal, 3,
        "only the real detached item advances the source floor");
      yield* observe(monitor, interrupted, now + 8_700);
      assert.equal(yield* monitor.select(projectId, settings, now + 8_700, null, {eligibleThreadIds}), null,
        "changing the synthetic item's ordinal does not invalidate its ACK");

      const resumedItem = {...priorDetachedItem, id: "turn-item-resumed-native-work", ordinal: 3,
        nodeId: "node-resumed-native-work", startedAt: new Date(now + 9_000).toISOString(),
        completedAt: new Date(now + 9_000).toISOString(), updatedAt: new Date(now + 9_000).toISOString()};
      child.turnItems = [priorDetachedItem, resumedItem];
      yield* observe(monitor, undefined, now + 9_000);
      assert.deepEqual((yield* monitor.pending(projectId, childId)).map(item => item.id), [resumedItem.id],
        "resumption removes the synthetic terminal row and leaves the next real ordinal reviewable");
      yield* takeSingle(monitor, now + 9_000, "command_execution");
      yield* observe(monitor, undefined, now + 9_100);
      assert.equal((yield* monitor.state(projectId, childId)).sourceOrdinal, 4);
      assert.deepEqual(yield* monitor.pending(projectId, childId), []);

      const laterCompletion: SupervisorNativeChildLifecycleEvidence = {...evidence, completedAt: new Date(now + 10_000).toISOString(),
        updatedAt: new Date(now + 10_100).toISOString()};
      yield* observe(monitor, laterCompletion, now + 10_000);
      yield* takeSingle(monitor, now + 10_000, "native_child_lifecycle");
      nativeWakes++;
      yield* observe(monitor, laterCompletion, now + 11_000);
      assert.equal(yield* monitor.select(projectId, settings, now + 11_000, null, {eligibleThreadIds}), null,
        "a later completion timestamp creates one new wake, then remains acknowledged");
      assert.equal((yield* monitor.state(projectId, childId)).sourceOrdinal, 4);
      assert.equal(nativeWakes, 3);
    }));
  }), { timeout: 10_000 });

  it.live("a tracked item that completes in place is emitted as a new revision", () =>
    withStore((monitor) => Effect.gen(function* () {
      const running = makeProjection({
        events: [{ id: "operation", type: "dynamic_tool", status: "running", updatedAt: now - 20_000 }],
      });
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: running, now });
      assert.equal((yield* monitor.pending(projectId, threadId)).length, 0);

      const completed = makeProjection({
        events: [{ id: "operation", type: "dynamic_tool", status: "completed", updatedAt: now }],
      });
      const observation = yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: completed, now: now + 1 });
      assert.equal(observation.updated, 1);
      assert.equal((yield* monitor.pending(projectId, threadId))[0]?.status, "completed");
    })), { timeout: 10_000 });

  it.live("items rolled out of the current main graph stop triggering and restore without acknowledgement", () =>
    withStore((monitor) => Effect.gen(function* () {
      const current = makeProjection({ events: [event("rollback-candidate")] });
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: current, now });
      assert.equal((yield* monitor.pending(projectId, threadId)).length, 1);

      const rolledBack = makeProjection({ events: [event("rollback-candidate")] });
      rolledBack.runs[0]!.status = "rolled_back";
      rolledBack.nodes = (rolledBack.nodes as Record<string, unknown>[]).map((node) =>
        node.id === "root-1" ? { ...node, status: "rolled_back" } : node,
      );
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: rolledBack, now: now + 1 });
      assert.equal((yield* monitor.pending(projectId, threadId)).length, 0);
      assert.equal(yield* monitor.select(projectId, { ...defaultMonitoringSettings, activityThreshold: 1 }, now + 1, null), null);
      assert.equal((yield* monitor.state(projectId, threadId)).activities.length, 0);

      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: current, now: now + 2 });
      assert.equal((yield* monitor.pending(projectId, threadId)).length, 1);
    })), { timeout: 10_000 });

  it.live("a frozen batch acknowledges only matching revisions and keeps arrivals during review", () =>
    withStore((monitor, db) => Effect.gen(function* () {
      const initial = makeProjection({ events: Array.from({ length: 10 }, (_, index) => event(`work-${index}`)) });
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: initial, now });
      const frozen = (yield* monitor.select(projectId, defaultMonitoringSettings, now, null))!;
      const changedEvents = [
        ...Array.from({ length: 10 }, (_, index) => event(`work-${index}`, index === 0 ? now : now - 30_000)),
        event("arrived-while-busy"),
      ];
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: makeProjection({ events: changedEvents }), now: now + 1 });
      const result = yield* db.withTransaction(monitor.acknowledge(frozen, now + 2));
      assert.equal(result.acknowledged, 9);
      assert.equal(result.stale, 1);
      const pending = yield* monitor.pending(projectId, threadId);
      assert.ok(pending.some((item) => item.id === "message:message-arrived-while-busy"));
      assert.ok(pending.some((item) => item.id === "message:message-work-0"));
      assert.equal(pending.length, 2);
    })), { timeout: 10_000 });

  it.live("completed message and command revisions changed during review remain pending", () =>
    withStore((monitor) => Effect.gen(function* () {
      const initial = makeProjection({
        events: [
          { ...event("editable-message"), text: "initial assistant reply" },
          { id: "command", type: "command_execution", status: "completed", updatedAt: now - 30_000, text: "printf initial" },
        ],
      });
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: initial, now });
      const frozen = (yield* monitor.select(projectId, { ...defaultMonitoringSettings, activityThreshold: 1 }, now, null))!;
      assert.equal(frozen.threads[0]?.items.length, 2);

      const changed = makeProjection({
        events: [
          { ...event("editable-message", now + 1), text: "updated assistant reply" },
          { id: "command", type: "command_execution", status: "completed", updatedAt: now + 1, text: "printf updated" },
        ],
      });
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: changed, now: now + 1 });
      const result = yield* monitor.acknowledge(frozen, now + 2);
      assert.equal(result.acknowledged, 0);
      assert.equal(result.stale, 2);
      assert.equal((yield* monitor.pending(projectId, threadId)).length, 2);
    })), { timeout: 10_000 });

  it.live("monitor metadata survives a store restart without persisting activity bodies", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* withMonitorAt(directory, (monitor) => monitor.observe({
      projectId,
      threadId,
      sourceOrdinal: 1,
      projection: makeProjection({ events: [event("durable", now - 30_000), { id: "secret", type: "command_execution", status: "completed", text: "token=super-secret" }] }),
      now,
    }));
    yield* withMonitorAt(directory, (monitor, db) => Effect.gen(function* () {
      const pending = yield* monitor.pending(projectId, threadId);
      assert.equal(pending.length, 2);
      const stored = yield* rows(db, "SELECT item_id,type,status,version FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?", projectId, threadId);
      assert.equal(JSON.stringify(stored).includes("super-secret"), false);
    }));
  }), { timeout: 10_000 });

  it.live("batch selection interleaves due chats under a global cap and reports explicit saturation", () =>
    withStore((monitor) => Effect.gen(function* () {
      const settings = { ...defaultMonitoringSettings, activityThreshold: 1 };
      for (const id of ["chat-a", "chat-b"])
        yield* monitor.observe({
          projectId,
          threadId: id,
          sourceOrdinal: 1,
          projection: makeProjection({
            threadId: id,
            events: [event(`${id}-one`), event(`${id}-two`)],
          }),
          now,
        });
      const fair = yield* monitor.select(projectId, settings, now, null, { maxItems: 2, maxItemsPerThread: 1 });
      assert.ok(fair);
      assert.deepEqual(fair.threads.map((thread) => thread.threadId), ["chat-a", "chat-b"]);
      assert.equal(fair.truncated, true);
      assert.equal(fair.threads[0]?.items.length, 2);

      const frozenLimit = yield* monitor.select(projectId, settings, now, null, {
        maxItems: 2,
        maxItemsPerThread: 1,
        maxFrozenItems: 2,
      });
      assert.ok(frozenLimit);
      assert.deepEqual(frozenLimit.threads.map((thread) => thread.threadId), ["chat-a"]);
      assert.equal(frozenLimit.threads[0]?.items.length, 2);
      yield* monitor.acknowledge(frozenLimit, now + 1);
      const remaining = yield* monitor.select(projectId, settings, now + 2, null, {
        maxItems: 2,
        maxItemsPerThread: 1,
        maxFrozenItems: 2,
      });
      assert.ok(remaining);
      assert.deepEqual(remaining.threads.map((thread) => thread.threadId), ["chat-b"]);

      const limited = yield* makeProjectSupervisorMonitorStore(1);
      const saturated = yield* limited.observe({
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
      assert.equal((yield* limited.state(projectId, "chat-c")).activities.length, 1);
    })), { timeout: 10_000 });

  it.live("acknowledged closed runs advance the source floor and release per-thread history capacity", () =>
    withStore((_monitor, db) => Effect.gen(function* () {
      const bounded = yield* makeProjectSupervisorMonitorStore(4);
      let events: EventInput[] = [];
      for (let ordinal = 1; ordinal <= 12; ordinal++) {
        events = [...events, { ...event(`run-${ordinal}-reply`), runOrdinal: ordinal }];
        const projection = makeProjection({ events });
        for (const run of projection.runs) {
          run.status = "completed";
          run.completedAt = new Date(now + run.ordinal).toISOString();
        }
        const observedAt = now + ordinal * 1000;
        const observation = yield* bounded.observe({ projectId, threadId, sourceOrdinal: 1, projection, now: observedAt });
        assert.equal(observation.saturated, false);
        const batch = yield* bounded.select(projectId, defaultMonitoringSettings, observedAt, null);
        assert.ok(batch);
        assert.equal(batch.threads[0]?.items.length, 2);
        yield* bounded.acknowledge(batch, observedAt + 1);
        const stored = yield* storedCount(db, threadId);
        assert.ok(stored <= 4);
      }
      const latest = makeProjection({ events });
      for (const run of latest.runs) {
        run.status = "completed";
        run.completedAt = new Date(now + run.ordinal).toISOString();
      }
      yield* bounded.observe({ projectId, threadId, sourceOrdinal: 1, projection: latest, now: now + 13_000 });
      assert.equal((yield* bounded.state(projectId, threadId)).sourceOrdinal, 13);
      assert.equal((yield* bounded.state(projectId, threadId)).saturated, false);
      assert.equal(yield* storedCount(db, threadId), 0);
    })), { timeout: 10_000 });

  it.live("a rollback before review releases obsolete metadata and does not pin later closed runs", () =>
    withStore((_monitor, db) => Effect.gen(function* () {
      const bounded = yield* makeProjectSupervisorMonitorStore(100);
      const thread = "rollback-lifetime";
      const rolledBackEvents = Array.from({ length: 49 }, (_, index) =>
        event(`rolled-back-${index}`, now - 60_000 + index),
      );
      const beforeRollback = makeProjection({ threadId: thread, events: rolledBackEvents });
      beforeRollback.runs[0]!.status = "completed";
      beforeRollback.runs[0]!.completedAt = new Date(now).toISOString();
      yield* bounded.observe({ projectId, threadId: thread, sourceOrdinal: 1, projection: beforeRollback, now });
      assert.equal(yield* storedCount(db, thread), 50);

      const rolledBack = makeProjection({ threadId: thread, events: rolledBackEvents });
      rolledBack.runs[0]!.status = "rolled_back";
      rolledBack.nodes = (rolledBack.nodes as Array<Record<string, unknown>>).map((node) =>
        node.id === "root-1" ? { ...node, status: "rolled_back" } : node,
      );
      const rollbackObservation = yield* bounded.observe({
        projectId,
        threadId: thread,
        sourceOrdinal: 1,
        projection: rolledBack,
        now: now + 1,
      });
      assert.equal(rollbackObservation.sourceOrdinal, 2);
      assert.equal(rollbackObservation.saturated, false);
      assert.equal(yield* storedCount(db, thread), 0);

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
        const observation = yield* bounded.observe({
          projectId,
          threadId: thread,
          sourceOrdinal: 1,
          projection,
          now: observedAt,
        });
        assert.equal(observation.saturated, false);
        const batch = yield* bounded.select(
          projectId,
          { ...defaultMonitoringSettings, activityThreshold: 1 },
          observedAt,
          null,
        );
        assert.ok(batch);
        yield* bounded.acknowledge(batch, observedAt + 1);
      }

      const latest = makeProjection({ threadId: thread, events });
      for (const run of latest.runs) {
        run.status = run.ordinal === 1 ? "rolled_back" : "completed";
        run.completedAt = run.ordinal === 1 ? null : new Date(now + run.ordinal).toISOString();
      }
      latest.nodes = (latest.nodes as Array<Record<string, unknown>>).map((node) =>
        node.runId === "run-1" ? { ...node, status: "rolled_back" } : node,
      );
      yield* bounded.observe({
        projectId,
        threadId: thread,
        sourceOrdinal: 1,
        projection: latest,
        now: now + 8_000,
      });
      const state = yield* bounded.state(projectId, thread);
      assert.equal(state.sourceOrdinal, 8);
      assert.equal(state.saturated, false);
      assert.equal(state.untrackedCount, 0);
      assert.equal(yield* storedCount(db, thread), 0);
    })), { timeout: 10_000 });

  it.live("a later unfinished run blocks floor advancement until its same item completes", () =>
    withStore((monitor) => Effect.gen(function* () {
      const first = makeProjection({ events: [{ ...event("first-reply"), runOrdinal: 1 }] });
      first.runs[0]!.status = "completed";
      first.runs[0]!.completedAt = new Date(now).toISOString();
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: first, now });
      const firstBatch = (yield* monitor.select(projectId, defaultMonitoringSettings, now, null))!;
      yield* monitor.acknowledge(firstBatch, now + 1);

      const running = makeProjection({ events: [
        { ...event("first-reply"), runOrdinal: 1 },
        { id: "later-operation", type: "dynamic_tool", status: "running", runOrdinal: 2 },
      ] });
      running.runs[0]!.status = "completed";
      running.runs[0]!.completedAt = new Date(now).toISOString();
      running.runs[1]!.status = "running";
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: running, now: now + 2 });
      assert.equal((yield* monitor.state(projectId, threadId)).sourceOrdinal, 2);
      assert.equal((yield* monitor.pending(projectId, threadId)).length, 0);

      const completed = makeProjection({ events: [
        { ...event("first-reply"), runOrdinal: 1 },
        { id: "later-operation", type: "dynamic_tool", status: "completed", runOrdinal: 2, updatedAt: now + 3 },
      ] });
      completed.runs[0]!.status = "completed";
      completed.runs[0]!.completedAt = new Date(now).toISOString();
      completed.runs[1]!.status = "completed";
      completed.runs[1]!.completedAt = new Date(now + 3).toISOString();
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: completed, now: now + 3 });
      assert.ok((yield* monitor.pending(projectId, threadId)).some((item) => item.id === "turn-item-later-operation" && item.status === "completed"));
    })), { timeout: 10_000 });

  it.live("pending and changed revisions of a closed run hold the source floor until acknowledged", () =>
    withStore((monitor) => Effect.gen(function* () {
      const projection = makeProjection({ events: [event("closed-editable-reply")] });
      projection.runs[0]!.status = "completed";
      projection.runs[0]!.completedAt = new Date(now).toISOString();
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection, now });
      assert.equal((yield* monitor.state(projectId, threadId)).sourceOrdinal, 1);
      const firstBatch = (yield* monitor.select(
        projectId,
        { ...defaultMonitoringSettings, activityThreshold: 1 },
        now,
        null,
      ))!;
      yield* monitor.acknowledge(firstBatch, now + 1);

      projection.messages[0]!.text = "revised after the first review";
      projection.messages[0]!.updatedAt = new Date(now + 2).toISOString();
      projection.turnItems![0]!.text = "revised after the first review";
      projection.turnItems![0]!.updatedAt = new Date(now + 2).toISOString();
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection, now: now + 2 });
      assert.equal((yield* monitor.state(projectId, threadId)).sourceOrdinal, 1);
      assert.ok((yield* monitor.pending(projectId, threadId)).some((item) => item.id === "message:message-closed-editable-reply"));

      const revisedBatch = (yield* monitor.select(
        projectId,
        { ...defaultMonitoringSettings, activityThreshold: 1 },
        now + 2,
        null,
      ))!;
      yield* monitor.acknowledge(revisedBatch, now + 3);
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection, now: now + 4 });
      assert.equal((yield* monitor.state(projectId, threadId)).sourceOrdinal, 2);
      assert.equal((yield* monitor.pending(projectId, threadId)).length, 0);
    })), { timeout: 10_000 });

  it.live("a live current-graph restart of a pruned run rewinds only to its activation floor", () =>
    withStore((monitor) => Effect.gen(function* () {
      const completed = makeProjection({ events: [event("before-restart")] });
      completed.runs[0]!.status = "completed";
      completed.runs[0]!.completedAt = new Date(now).toISOString();
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: completed, now });
      const completedBatch = (yield* monitor.select(projectId, defaultMonitoringSettings, now, null))!;
      yield* monitor.acknowledge(completedBatch, now + 1);
      const pruned = yield* monitor.observe({
        projectId,
        threadId,
        sourceOrdinal: 1,
        projection: completed,
        now: now + 2,
      });
      assert.equal(pruned.sourceOrdinal, 2);
      assert.equal((yield* monitor.state(projectId, threadId)).activities.length, 0);

      const restarted = makeProjection({ events: [event("after-restart", now + 3)] });
      restarted.runs[0]!.status = "running";
      restarted.runs[0]!.activeAttemptId = "attempt-restarted";
      (restarted.nodes as Array<Record<string, unknown>>)[0]!.status = "running";
      const resumed = yield* monitor.observe({
        projectId,
        threadId,
        sourceOrdinal: 1,
        projection: restarted,
        now: now + 3,
      });
      assert.equal(resumed.sourceOrdinal, 1);
      assert.ok((yield* monitor.pending(projectId, threadId)).some((item) => item.id === "message:message-after-restart"));

      const olderActive = makeProjection({ threadId: "late-activation", events: [
        { ...event("older-run-work"), runOrdinal: 1 },
        { ...event("activation-run-work"), runOrdinal: 2 },
      ] });
      olderActive.runs[0]!.status = "running";
      olderActive.runs[0]!.activeAttemptId = "older-attempt";
      olderActive.runs[1]!.status = "completed";
      olderActive.runs[1]!.completedAt = new Date(now).toISOString();
      (olderActive.nodes as Array<Record<string, unknown>>)[0]!.status = "running";
      yield* monitor.observe({
        projectId,
        threadId: "late-activation",
        sourceOrdinal: 2,
        projection: olderActive,
        now: now + 4,
      });
      const baselineGuard = yield* monitor.state(projectId, "late-activation");
      assert.equal(baselineGuard.sourceOrdinal, 2);
      assert.ok(baselineGuard.activities.every((item) => item.ordinal >= 2));
    })), { timeout: 10_000 });

  it.live("an old frozen batch cannot acknowledge a restored item under a changed root", () =>
    withStore((monitor) => Effect.gen(function* () {
      const events = [event("same-root-item")];
      const completed = makeProjection({ events });
      completed.runs[0]!.status = "completed";
      completed.runs[0]!.completedAt = new Date(now).toISOString();
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: completed, now });
      const oldBatch = (yield* monitor.select(projectId, defaultMonitoringSettings, now, null))!;
      const oldItem = oldBatch.threads[0]!.items.find((item) => item.id === "message:message-same-root-item")!;
      yield* monitor.acknowledge(oldBatch, now + 1);
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: completed, now: now + 2 });
      assert.equal((yield* monitor.state(projectId, threadId)).sourceOrdinal, 2);

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
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: restarted, now: now + 3 });
      const restored = (yield* monitor.pending(projectId, threadId)).find((item) => item.id === oldItem.id);
      assert.ok(restored);
      assert.notEqual(restored.version, oldItem.version);

      const result = yield* monitor.acknowledge(oldBatch, now + 4);
      assert.equal(result.acknowledged, 0);
      assert.equal(result.stale, oldBatch.threads[0]!.items.length);
      assert.ok((yield* monitor.pending(projectId, threadId)).some((item) => item.id === oldItem.id));
    })), { timeout: 10_000 });

  it.live("a hundred-command burst freezes all revisions and previews only a bounded sample", () =>
    withStore((monitor, db) => Effect.gen(function* () {
      const initialEvents = Array.from({ length: 100 }, (_, index) => ({
        id: `command-${index}`,
        type: "command_execution",
        status: "completed",
        updatedAt: now - 30_000,
        text: `run command ${index}`,
      }));
      const initial = makeProjection({ events: initialEvents });
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: initial, now });
      const frozen = (yield* monitor.select(projectId, defaultMonitoringSettings, now, null))!;
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
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: whileBusy, now: now + 1 });
      const result = yield* db.withTransaction(monitor.acknowledge(frozen, now + 2));
      assert.equal(result.acknowledged, 99);
      assert.equal(result.stale, 1);
      const pending = yield* monitor.pending(projectId, threadId);
      assert.deepEqual(pending.map((item) => item.id).sort(), ["turn-item-arrived-during-review", "turn-item-command-0"]);
    })), { timeout: 10_000 });

  it.live("rollback cleanup restores complete current coverage and clears saturation", () =>
    withStore((_monitor, db) => Effect.gen(function* () {
      const bounded = yield* makeProjectSupervisorMonitorStore(2);
      const initialEvents = [
        { ...event("tracked-a", now - 30_000), type: "command_execution" },
        { ...event("rolled-out-b", now - 20_000), type: "command_execution" },
        { ...event("untracked-c", now - 10_000), type: "command_execution" },
      ];
      const initial = makeProjection({ events: initialEvents });
      const saturated = yield* bounded.observe({ projectId, threadId, sourceOrdinal: 1, projection: initial, now });
      assert.equal(saturated.saturated, true);
      assert.equal(saturated.untrackedCount, 1);
      assert.deepEqual((yield* bounded.pending(projectId, threadId)).map((item) => item.id).sort(), [
        "turn-item-rolled-out-b",
        "turn-item-tracked-a",
      ]);

      const afterRollback = makeProjection({
        events: [initialEvents[0]!, initialEvents[2]!],
      });
      const restored = yield* bounded.observe({
        projectId,
        threadId,
        sourceOrdinal: 1,
        projection: afterRollback,
        now: now + 1,
      });
      assert.equal(restored.saturated, false);
      assert.equal(restored.untrackedCount, 0);
      assert.deepEqual((yield* bounded.pending(projectId, threadId)).map((item) => item.id).sort(), [
        "turn-item-tracked-a",
        "turn-item-untracked-c",
      ]);
      const state = yield* bounded.state(projectId, threadId);
      assert.equal(state.saturated, false);
      assert.equal(state.saturationAt, null);
      assert.equal(state.untrackedCount, 0);
      assert.equal(yield* storedCount(db, threadId), 2);
    })), { timeout: 10_000 });

  it.live("an over-cap active run reports saturation and blocks its closed-run floor", () =>
    withStore((_monitor, db) => Effect.gen(function* () {
      const bounded = yield* makeProjectSupervisorMonitorStore(1);
      const projection = makeProjection({ events: [
        event("tracked-before-cap"),
        event("untracked-after-cap"),
      ] });
      const first = yield* bounded.observe({ projectId, threadId, sourceOrdinal: 1, projection, now });
      assert.equal(first.saturated, true);
      assert.equal(first.untrackedCount, 1);
      const firstBatch = (yield* bounded.select(
        projectId,
        { ...defaultMonitoringSettings, activityThreshold: 1 },
        now,
        null,
      ))!;
      yield* bounded.acknowledge(firstBatch, now + 1);

      projection.runs[0]!.status = "completed";
      projection.runs[0]!.completedAt = new Date(now + 2).toISOString();
      const closed = yield* bounded.observe({
        projectId,
        threadId,
        sourceOrdinal: 1,
        projection,
        now: now + 2,
      });
      assert.equal(closed.sourceOrdinal, 1);
      assert.equal(closed.saturated, true);
      assert.equal(closed.untrackedCount, 2);
      assert.equal((yield* bounded.state(projectId, threadId)).activities.length, 0);
      assert.equal(yield* storedCount(db, threadId), 1);
    })), { timeout: 10_000 });

  // target regressions

  // completed assistant replies, one turn item per reply, in the given run ordinal; listed runs have completed
  const replies = (values: ReadonlyArray<{id: string; run: number}>, completedRuns: ReadonlyArray<number> = []): Projection => {
    const events = values.map(reply => ({ ...event(reply.id), runOrdinal: reply.run }));
    const projection = makeProjection({ events });
    for (const run of projection.runs) if (completedRuns.includes(run.ordinal)) {
      run.status = "completed";
      run.completedAt = new Date(now - 30_000).toISOString();
    }
    return projection;
  };
  const tableRows = (db: Db) => Effect.all({
    thread: rows(db, "SELECT * FROM supervisor_monitor_threads WHERE project_id=? AND thread_id=?", projectId, threadId),
    items: rows(db, "SELECT * FROM supervisor_monitor_items WHERE project_id=? AND thread_id=? ORDER BY item_id", projectId, threadId),
  });

  it.live("CT-MSTORE-01: an observe that fails at its item insert rolls back floor, active flags and saturation, also after reopen", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const { before, failure } = yield* withMonitorAt(directory, (_monitor, db) => Effect.gen(function* () {
      const monitor = yield* makeProjectSupervisorMonitorStore(2);
      const first = yield* monitor.observe({projectId, threadId, sourceOrdinal: 1, now,
        projection: replies([{id: "one", run: 1}, {id: "two", run: 1}, {id: "three", run: 1}])});
      assert.deepEqual([first.saturated, first.untrackedCount, first.sourceOrdinal], [true, 1, 1]);
      const before = yield* tableRows(db);
      assert.equal(before.items.length, 2);
      // the next observation raises the floor, retires the tracked run-1 items and inserts a run-2 item
      yield* db.unsafe("CREATE TEMP TRIGGER s6d_fail_item_insert BEFORE INSERT ON supervisor_monitor_items BEGIN SELECT RAISE(ABORT, 's6d injected item failure'); END");
      const failure = yield* Effect.flip(monitor.observe({projectId, threadId, sourceOrdinal: 2, now: now + 1_000,
        projection: replies([{id: "one", run: 1}, {id: "four", run: 2}], [1])}));
      assert.deepEqual(yield* tableRows(db), before);
      return { before, failure };
    }));
    assert.ok(failure instanceof GuidanceStoreError);
    assert.deepEqual([failure.reason, failure.sqlReason], ["sql_failed", "ConstraintError"]);
    const applied = yield* withMonitorAt(directory, (_monitor, db) => Effect.gen(function* () {
      assert.deepEqual(yield* tableRows(db), before, "the failed observation left nothing behind after reopen");
      const monitor = yield* makeProjectSupervisorMonitorStore(2);
      const applied = yield* monitor.observe({projectId, threadId, sourceOrdinal: 2, now: now + 1_000,
        projection: replies([{id: "one", run: 1}, {id: "four", run: 2}], [1])});
      return { applied, after: yield* tableRows(db) };
    }));
    assert.deepEqual([applied.applied.saturated, applied.applied.sourceOrdinal, applied.applied.inserted], [false, 2, 1]);
    assert.notDeepEqual(applied.after, before, "the same observation changes the floor, items and saturation once it can commit");
    assert.deepEqual(before.items.map(item => item.item_id), ["message:message-one", "message:message-three"]);
    assert.deepEqual(applied.after.items.map(item => item.item_id), ["message:message-four", "message:message-one"]);
  }), { timeout: 10_000 });

  it.live("CT-MSTORE-02: an observe concurrent with the acknowledgement of a frozen batch ends in one of the two serial orders", () =>
    withStore((monitor) => Effect.gen(function* () {
      const settings = { ...defaultMonitoringSettings, activityThreshold: 1 };
      const initial = (thread: string) => makeProjection({ threadId: thread, events: Array.from({ length: 10 }, (_, index) => event(`work-${index}`)) });
      // the concurrent observation revises work-0 and adds an arrival
      const revised = (thread: string) => makeProjection({ threadId: thread,
        events: [...Array.from({ length: 10 }, (_, index) => event(`work-${index}`, index === 0 ? now : now - 30_000)), event("arrival")] });
      // one thread per run; the outcome leaves the thread out, so runs compare across threads
      type Failure = InvalidMonitorObservation | GuidanceStoreError;
      type Acknowledgement = { acknowledged: number; stale: number };
      const outcome = (thread: string, run: (observe: Effect.Effect<SupervisorMonitorObservation, Failure>, acknowledge: Effect.Effect<Acknowledgement, Failure>) =>
        Effect.Effect<readonly [SupervisorMonitorObservation, Acknowledgement], Failure>) => Effect.gen(function* () {
        yield* monitor.observe({ projectId, threadId: thread, sourceOrdinal: 1, projection: initial(thread), now });
        const frozen = (yield* monitor.select(projectId, settings, now, null, { eligibleThreadIds: new Set([thread]) }))!;
        const [observed, acknowledged] = yield* run(
          monitor.observe({ projectId, threadId: thread, sourceOrdinal: 1, projection: revised(thread), now: now + 1 }),
          monitor.acknowledge(frozen, now + 2));
        return {
          observed: { sourceOrdinal: observed.sourceOrdinal, inserted: observed.inserted, updated: observed.updated, pendingItemCount: observed.pendingItemCount },
          acknowledged,
          pending: (yield* monitor.pending(projectId, thread)).map((item) => `${item.id.replace(thread, "")}@${item.version}`).sort(),
          lastAcknowledgedAt: (yield* monitor.state(projectId, thread)).lastAcknowledgedAt,
        };
      });
      const yields = (count: number) => Effect.forEach(Array.from({ length: count }), () => Effect.yieldNow, { discard: true });
      const serial = [
        yield* outcome("serial-observe-first", (observe, acknowledge) => Effect.all([observe, acknowledge])),
        yield* outcome("serial-acknowledge-first", (observe, acknowledge) => Effect.map(Effect.all([acknowledge, observe]), ([ack, obs]) => [obs, ack] as const)),
      ];
      assert.notDeepEqual(serial[0], serial[1], "the two serial orders are distinguishable");
      // the acknowledgement starts after a growing number of fiber yields, so it lands at every point of the observation;
      // a yield every eight operations interleaves the fibers between any two statements that are not one transaction
      for (let delay = 0; delay <= 120; delay += 4) {
        const concurrent = yield* outcome(`concurrent-${delay}`, (observe, acknowledge) => Effect.all([
          observe,
          Effect.andThen(yields(delay), acknowledge),
        ], { concurrency: "unbounded" }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8)));
        assert.ok(serial.some((expected) => JSON.stringify(expected) === JSON.stringify(concurrent)), `delay ${delay}: ${JSON.stringify(concurrent)}`);
      }
    })), { timeout: 10_000 });

  it.live("CC-MONITOR-ACK: an acknowledgement inside the caller's transaction commits and rolls back with it", () =>
    withStore((monitor, db) => Effect.gen(function* () {
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: makeProjection({ events: [event("reviewed")] }), now });
      const frozen = (yield* monitor.select(projectId, { ...defaultMonitoringSettings, activityThreshold: 1 }, now, null))!;
      const failed = yield* Effect.flip(db.withTransaction(Effect.gen(function* () {
        assert.deepEqual(yield* monitor.acknowledge(frozen, now + 1), { acknowledged: 1, stale: 0 });
        return yield* Effect.fail("caller failed" as const);
      })));
      assert.equal(failed, "caller failed");
      assert.equal((yield* monitor.pending(projectId, threadId)).length, 1, "the rolled-back acknowledgement left the item pending");
      assert.equal((yield* monitor.state(projectId, threadId)).lastAcknowledgedAt, null);
      assert.deepEqual(yield* db.withTransaction(monitor.acknowledge(frozen, now + 2)), { acknowledged: 1, stale: 0 });
      assert.deepEqual(yield* monitor.pending(projectId, threadId), []);
      assert.equal((yield* monitor.state(projectId, threadId)).lastAcknowledgedAt, now + 2);
      // a second acknowledgement of the same frozen batch finds the version already reviewed and changes nothing
      assert.deepEqual(yield* monitor.acknowledge(frozen, now + 3), { acknowledged: 1, stale: 0 });
    })), { timeout: 10_000 });

  it.live("CC-MONITOR-ACK: an acknowledgement whose thread clock update fails acknowledges no item", () =>
    withStore((monitor, db) => Effect.gen(function* () {
      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection: makeProjection({ events: [event("one"), event("two")] }), now });
      const frozen = (yield* monitor.select(projectId, { ...defaultMonitoringSettings, activityThreshold: 1 }, now, null))!;
      yield* db.unsafe("CREATE TEMP TRIGGER s6d_fail_clock BEFORE UPDATE OF last_acknowledged_at ON supervisor_monitor_threads BEGIN SELECT RAISE(ABORT, 's6d injected clock failure'); END");
      const failure = yield* Effect.flip(monitor.acknowledge(frozen, now + 1));
      assert.ok(failure instanceof GuidanceStoreError);
      assert.deepEqual(yield* rows(db, "SELECT item_id FROM supervisor_monitor_items WHERE reviewed_version IS NOT NULL"), []);
      assert.equal((yield* monitor.pending(projectId, threadId)).length, 2);
      yield* db.unsafe("DROP TRIGGER s6d_fail_clock");
      assert.deepEqual(yield* monitor.acknowledge(frozen, now + 2), { acknowledged: 2, stale: 0 });
      assert.deepEqual(yield* monitor.pending(projectId, threadId), []);
    })), { timeout: 10_000 });

  it.live("invalid input fails typed, and the pending scan is incomplete on invalid input or a failed read", () =>
    withStore((monitor, db) => Effect.gen(function* () {
      const projection = makeProjection({ events: [event("one")] });
      const invalid = [
        yield* Effect.flip(monitor.observe({ projectId: " ", threadId, sourceOrdinal: 1, projection, now })),
        yield* Effect.flip(monitor.observe({ projectId, threadId: "other", sourceOrdinal: 1, projection, now })),
        yield* Effect.flip(monitor.observe({ projectId, threadId, sourceOrdinal: -1, projection, now })),
        yield* Effect.flip(monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection, now: Number.NaN })),
        yield* Effect.flip(monitor.acknowledge({ projectId, createdAt: now, trigger: "priority", finalizedActivityCount: 0, pendingItemCount: 0,
          truncated: false, threads: [] }, Number.POSITIVE_INFINITY)),
      ];
      assert.ok(invalid.every((error) => error instanceof InvalidMonitorObservation));
      assert.deepEqual(invalid.map((error) => error.message), ["invalid_monitor_observation", "invalid_monitor_observation", "invalid_monitor_observation",
        "invalid_monitor_time", "invalid_monitor_review_time"]);
      const capacity = yield* Effect.flip(makeProjectSupervisorMonitorStore(1_001));
      assert.ok(capacity instanceof InvalidMonitorCapacity);
      assert.equal(capacity.message, "invalid_monitor_capacity");
      assert.equal(yield* monitor.select(projectId, defaultMonitoringSettings, Number.NaN, null), null);

      yield* monitor.observe({ projectId, threadId, sourceOrdinal: 1, projection, now });
      assert.deepEqual(yield* monitor.hasPendingReviewableActivity(projectId, [threadId]), { status: "complete", pending: true });
      for (const threadIds of [[], [threadId, threadId], [" "], Array.from({ length: 10_001 }, (_, index) => `t-${index}`)])
        assert.deepEqual(yield* monitor.hasPendingReviewableActivity(projectId, threadIds), { status: "incomplete" });
      assert.deepEqual(yield* monitor.hasPendingReviewableActivity(" ", [threadId]), { status: "incomplete" });
      // a temporary table shadows the items table on this connection, so the scan's read fails
      yield* db.unsafe("CREATE TEMP TABLE supervisor_monitor_items(unrelated TEXT)");
      assert.deepEqual(yield* monitor.hasPendingReviewableActivity(projectId, [threadId]), { status: "incomplete" });
      yield* db.unsafe("DROP TABLE temp.supervisor_monitor_items");
      assert.deepEqual(yield* monitor.hasPendingReviewableActivity(projectId, Array.from({ length: 900 }, (_, index) => index === 899 ? threadId : `t-${index}`)),
        { status: "complete", pending: true }, "a match in the third chunk of 400 ids is found");
    })), { timeout: 10_000 });

  it.live("the layer adds the activation, capacity, read-item and active columns to an older monitor schema", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* Effect.gen(function* () {
      const db = yield* GuidanceDb;
      yield* db.unsafe("CREATE TABLE supervisor_monitor_threads(project_id TEXT NOT NULL,thread_id TEXT NOT NULL,source_ordinal INTEGER NOT NULL,saturated INTEGER NOT NULL DEFAULT 0,saturation_at INTEGER,last_acknowledged_at INTEGER,PRIMARY KEY(project_id, thread_id))");
      yield* db.unsafe("CREATE TABLE supervisor_monitor_items(project_id TEXT NOT NULL,thread_id TEXT NOT NULL,item_id TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,ordinal INTEGER NOT NULL,detected_at INTEGER NOT NULL,version TEXT NOT NULL,priority TEXT,eligible INTEGER NOT NULL,reviewed_version TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(project_id, thread_id, item_id))");
      yield* db`INSERT INTO supervisor_monitor_threads(project_id,thread_id,source_ordinal) VALUES(${projectId},${threadId},3)`;
    }).pipe(Effect.provide(guidanceDb(directory)), Effect.orDie);
    const observed = yield* withMonitorAt(directory, (monitor, db) => Effect.gen(function* () {
      return {
        thread: yield* rows(db, "SELECT activation_ordinal,untracked_count FROM supervisor_monitor_threads"),
        itemColumns: (yield* rows(db, "PRAGMA table_info(supervisor_monitor_items)")).map((row) => row.name).slice(-2),
        state: yield* monitor.state(projectId, threadId),
      };
    }));
    assert.deepEqual(observed.thread, [{ activation_ordinal: 3, untracked_count: 0 }]);
    assert.deepEqual(observed.itemColumns, ["read_item_id", "active"]);
    assert.equal(observed.state.sourceOrdinal, 3);
  }), { timeout: 10_000 });
});
