import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuidanceStore } from "../src/guidance-store.js";
import { ProjectSupervisorMonitorStore } from "../src/supervisor-monitor-store.js";
import { SUPERVISOR_MONITOR_COOLDOWN_MS, type SupervisorMonitorBatch, type SupervisorMonitorThreadBatch } from "../src/supervisor-monitor.js";
import { SupervisorConversationStore } from "../src/supervisor-conversation-store.js";
import { SupervisorConversation } from "../src/supervisor-conversation.js";
import { defaultSupervisorModel, ProjectSupervisorStore, type BindingRecord, type TaskRecord } from "../src/project-supervisor-store.js";
import { SupervisorTeamStore, type TeamBinding, type TeamMember, type TeamNotification } from "../src/supervisor-team-store.js";
import { SupervisorTeamRuntime, teamNotificationText } from "../src/supervisor-team-runtime.js";
import { supervisorTeamView } from "../src/supervisor-team-view.js";
import { supervisionGuideToolDefinition, supervisionTeamToolDefinition } from "../src/supervisor-team-controller.js";
import { workflowReadToolDefinition, workflowWriteToolDefinition } from "../src/workflow-write-controller.js";
import { directParentChildLifecycle } from "../src/supervisor-observation.js";
import { T3TransportError } from "../src/t3.js";
import type { SupervisorHelperDeliveryTransport } from "../src/supervisor-helper-transport.js";
import type { Projection, ThreadInfo } from "../src/types.js";

const projectId = "project-team";
const parents = new Map<string, string | null>([["main", null], ["branch", "main"], ["leaf", "branch"], ["other", "main"]]);
const time = Date.parse("2026-10-16T10:00:00.000Z");
const iso = (value: number) => new Date(value).toISOString();

const makeThread = (id: string, parentThreadId: string | null = null, relationshipToParent: string | null = null): ThreadInfo => ({
  id, title: id, projectId, lineage: {parentThreadId, relationshipToParent, rootThreadId: parentThreadId ? "main" : id},
});

const emptyProjection = (thread: ThreadInfo): Projection => ({thread, runs: [], messages: [], nodes: [], turnItems: [], providerTurns: [], runtimeRequests: []});

const nodesOf = (projection: Projection): Array<Record<string, unknown>> => {
  if (!Array.isArray(projection.nodes)) projection.nodes = [];
  return projection.nodes as Array<Record<string, unknown>>;
};

const webhookTransport = (result: "waiting" | "busy" | "uncertain" | "rejected" = "waiting"):
  {transport: SupervisorHelperDeliveryTransport; sent: Map<string, {threadId: string; commandId: string; text: string; taskId: string}>; attempts: string[]; retired: string[]} => {
  const sent = new Map<string, {threadId: string; commandId: string; text: string; taskId: string}>();
  const attempts: string[] = [];
  const retired: string[] = [];
  const transport: SupervisorHelperDeliveryTransport = {
    send: async (_binding, message) => {attempts.push(message.messageId);sent.set(message.messageId,
      {threadId: message.threadId, commandId: message.commandId, text: message.text, taskId: `scheduled-${message.threadId}`});return result;},
    hasDelivery: (_binding, message) => {
      const delivery = sent.get(message.messageId);
      return Boolean(delivery && delivery.threadId === message.threadId && delivery.commandId === message.commandId && delivery.text === message.text);
    },
    matchesMessage: (_binding, logicalId, text, native) => {
      const delivery = sent.get(logicalId);
      return Boolean(delivery && delivery.text === text && native.threadId === delivery.threadId && native.text === text &&
        native.scheduledTaskId === delivery.taskId && native.creationSource === "server");
    },
    retire: async (_binding, threadId) => {retired.push(threadId);return true;},
  };
  return {transport, sent, attempts, retired};
};

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-team-runtime-"));
  const guidance = new GuidanceStore(directory);
  const store = new ProjectSupervisorStore(guidance, new Set());
  const root = store.reserve(projectId, "main", "main", defaultSupervisorModel, 0, 1);
  const binding = store.binding(projectId, "main")!;
  const teamStore = new SupervisorTeamStore(store);
  const requests = new SupervisorConversationStore(guidance);
  const monitor = new ProjectSupervisorMonitorStore(guidance);
  const threadList = [makeThread("main"), makeThread("branch", "main", "subagent"), makeThread("leaf", "branch", "subagent"), makeThread("other", "main", "subagent")];
  const projections = new Map<string, Projection>(threadList.map(thread => [thread.id, emptyProjection(thread)]));
  const runtime = (helperTransport?: SupervisorHelperDeliveryTransport,
    projection: (threadId: string) => Promise<Projection> = async threadId => projections.get(threadId) ?? emptyProjection(makeThread(threadId))) =>
    new SupervisorTeamRuntime({store, teamStore, requests, monitor, rpc: null, projection: async threadId => projection(threadId),
      ...(helperTransport ? {helperTransport} : {})});
  return {directory, guidance, store, binding, root, teamStore, requests, monitor, threadList, projections, runtime,
    cleanup: async () => {guidance.close();await rm(directory, {recursive: true, force: true});}};
};

const readyMember = (team: SupervisorTeamStore, binding: TeamBinding, threadId: string, now = time): TeamMember => {
  const registered = team.registerMember(binding, {threadId, taskId: `task-${threadId}`, bootstrapRunId: `bootstrap-${threadId}`, now});
  return team.markReady(binding, threadId, registered.epoch, now + 1);
};

const activate = (team: SupervisorTeamStore, binding: TeamBinding, member: TeamMember, subtreeRoot: string, now = time,
  parentById: Map<string, string | null> = parents): void => {
  const assignment = team.assign(binding, subtreeRoot, member.threadId, parentById, now);
  for (const notice of team.snapshot(binding).notifications.filter(item => item.assignmentRootThreadId === subtreeRoot && item.assignmentEpoch === assignment.epoch)) {
    team.updateNotificationDelivery(binding, binding.threadId, notice.id, "sending", now + 1);
    team.updateNotificationDelivery(binding, binding.threadId, notice.id, "delivered", now + 2);
    team.acknowledgeNotification(binding, notice.recipientThreadId, notice.id, notice.memberEpoch, now + 3);
  }
  team.completeTransfer(binding, subtreeRoot, assignment.epoch, now + 4);
};

const batchThread = (threadId: string): SupervisorMonitorThreadBatch => {
  const item = {id: `run:${threadId}`, readItemId: null, type: "run_finished", status: "completed", ordinal: 1, detectedAt: time, version: `${threadId}-v1`, priority: "run_finished" as const};
  return {threadId, trigger: "priority", finalizedActivityCount: 1, pendingItemCount: 1, oldestAt: time, priority: true,
    priorityKinds: ["run_finished"], saturated: false, untrackedCount: 0, items: [item], previewItems: [item]};
};

const batchOf = (threadIds: readonly string[]): SupervisorMonitorBatch => ({projectId, createdAt: time, trigger: "priority",
  finalizedActivityCount: threadIds.length, pendingItemCount: threadIds.length, truncated: false, threads: threadIds.map(batchThread)});

const parseEnvelope = (text: string, start: string, end: string): Record<string, unknown> => {
  const opening = `${start}\n`;
  const startAt = text.indexOf(opening);
  assert.notEqual(startAt, -1, `missing ${start} fence`);
  const contentStart = startAt + opening.length;
  const endAt = text.indexOf(`\n${end}`, contentStart);
  assert.notEqual(endAt, -1, `missing ${end} fence`);
  return JSON.parse(text.slice(contentStart, endAt)) as Record<string, unknown>;
};

const assertAdvertisedInput = (definition: {inputSchema: unknown}, input: Record<string, unknown>, complete = true): void => {
  const schema = definition.inputSchema as {
    additionalProperties?: boolean;
    properties: Record<string, unknown>;
    required?: string[];
    oneOf?: Array<{properties?: {action?: {const?: unknown}}; required?: string[]}>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(input).filter(key => !Object.prototype.hasOwnProperty.call(schema.properties, key)), []);
  if (!complete) return;
  for (const key of schema.required ?? []) assert.ok(Object.prototype.hasOwnProperty.call(input, key), `missing schema-required field ${key}`);
  if (schema.oneOf) {
    const branch = schema.oneOf.find(item => item.properties?.action?.const === input.action);
    assert.ok(branch, `no advertised action branch for ${String(input.action)}`);
    for (const key of branch?.required ?? []) assert.ok(Object.prototype.hasOwnProperty.call(input, key), `missing action-required field ${key}`);
  }
};

const helperProjection = (member: TeamMember, rootThreadId: string): Projection => emptyProjection({
  ...makeThread(member.threadId, rootThreadId, "subagent"), lineage: {parentThreadId: rootThreadId, relationshipToParent: "subagent", rootThreadId},
});

test("no helper leaves the existing root batch intact", async t => {
  const f = await fixture();t.after(f.cleanup);
  const runtime = f.runtime();
  const batch = batchOf(["main", "branch", "other"]);
  const partition = runtime.partition(f.binding, f.threadList, batch);
  assert.deepEqual(partition.rootBatch?.threads.map(item => item.threadId), ["main", "branch", "other"]);
  assert.equal(partition.helperBatches.length, 0);
  assert.deepEqual(partition.rootEvents, []);
  assert.equal(runtime.hasBlockingWork(f.binding), false);
});

test("helper observations run while a root-native check-in remains unresolved", async t => {
  const f = await fixture();t.after(f.cleanup);
  const member = readyMember(f.teamStore, f.binding, "helper-before-root-gate");
  activate(f.teamStore, f.binding, member, "branch");
  f.projections.set(member.threadId, helperProjection(member, f.binding.threadId));
  const branch = f.projections.get("branch")!;
  const runId = "branch-completed-run";
  branch.runs.push({id: runId, threadId: "branch", ordinal: 1, status: "completed", requestedAt: iso(time),
    startedAt: iso(time), completedAt: iso(time + 1), rootNodeId: "branch-root", providerThreadId: "branch-provider"});
  nodesOf(branch).push({id: "branch-root", kind: "root_turn", status: "completed", threadId: "branch", runId,
    rootNodeId: "branch-root", providerThreadId: "branch-provider"});
  f.monitor.observe({projectId, threadId: "branch", sourceOrdinal: 0, projection: branch, now: time + 2});

  const transport = webhookTransport();
  const rootProjection = emptyProjection(makeThread(f.binding.threadId, "main", "subagent"));
  const conversation = new SupervisorConversation(f.store, null, async threadId =>
    threadId === f.binding.threadId ? rootProjection : f.projections.get(threadId) ?? emptyProjection(makeThread(threadId)),
  undefined, thread => thread.id === "main", () => true, undefined, undefined, f.teamStore, transport.transport);
  const task = {id: "root-task", threadId: "main", projectId, sourceRunId: "source-run", sourceMessageId: "source-message",
    sourceHash: "source-hash", sourceOrdinal: 0, status: "inferred", objective: "Monitor the operational tree", reason: "Test",
    updatedAt: time, requestText: "", supervisorThreadId: f.binding.threadId, messageId: "source-message", dispatchedAt: null,
    replayCount: 0, supervisorRunId: null,
    workflow: {status: "proposed", message: "Draft", workspaceRoot: "/workspace", revision: "revision", globalRevision: null, steps: [], workflows: []},
  } as unknown as TaskRecord;
  f.store.saveTask(task);
  const pendingRoot = conversation.requests.prepare({projectId, supervisorThreadId: f.binding.threadId, kind: "review", taskId: null,
    text: "Existing root check-in.", batch: null, completionMarker: "root check-in complete"}, time + 3);
  conversation.requests.saveRequest({...pendingRoot, state: "waiting", sentAt: time + 3});

  await conversation.run(f.binding as BindingRecord, rootProjection, f.threadList, AbortSignal.timeout(5000));

  assert.equal(conversation.requests.pending(projectId, f.binding.threadId)?.id, pendingRoot.id);
  assert.equal(conversation.requests.pending(projectId, member.threadId)?.id.startsWith("team-review:"), true);
  assert.equal(transport.attempts.length, 1);
});

test("root observes fenced coverage explicitly and does not acknowledge its activity", async t => {
  const f = await fixture();t.after(f.cleanup);
  const member = readyMember(f.teamStore, f.binding, "helper-observe-only");
  activate(f.teamStore, f.binding, member, "branch");
  const assignment = f.teamStore.coverage(f.binding, "branch", parents);
  f.teamStore.recordRequest(f.binding, {requestId: "guide:observe-only-unknown", memberThreadId: member.threadId, memberEpoch: member.epoch,
    targets: [{targetThreadId: "branch", assignmentRootThreadId: assignment.assignmentRootThreadId!, assignmentEpoch: assignment.assignmentEpoch!}],
    parentById: parents, now: time + 2});
  f.teamStore.setRequestState(f.binding, member.threadId, "guide:observe-only-unknown", member.epoch, "uncertain", time + 3);
  f.teamStore.quarantineMember(f.binding, member.threadId, time + 4);
  const branch = f.projections.get("branch")!;
  branch.thread.runtimeMode = "full-access";
  branch.thread.interactionMode = "default";
  const runId = "observe-only-branch-run";
  branch.runs.push({id: runId, threadId: "branch", ordinal: 1, status: "completed", requestedAt: iso(time),
    startedAt: iso(time), completedAt: iso(time + 1), rootNodeId: "observe-only-root", providerThreadId: "observe-only-provider"});
  nodesOf(branch).push({id: "observe-only-root", kind: "root_turn", status: "completed", threadId: "branch", runId,
    rootNodeId: "observe-only-root", providerThreadId: "observe-only-provider"});
  f.monitor.observe({projectId, threadId: "branch", sourceOrdinal: 0, projection: branch, now: time + 5});

  const rootProjection = emptyProjection({...makeThread(f.binding.threadId, "main", "subagent"), runtimeMode: "full-access", interactionMode: "default"});
  const mainProjection = f.projections.get("main")!;
  mainProjection.thread.runtimeMode = "full-access";
  mainProjection.thread.interactionMode = "default";
  const transport = webhookTransport();
  const calls: Array<{payload: Record<string, unknown>}> = [];
  const rpc = async (_tag: string, payload: Record<string, unknown>) => {calls.push({payload});return {sequence: calls.length};};
  const conversation = new SupervisorConversation(f.store, rpc, async threadId =>
    threadId === f.binding.threadId ? rootProjection : f.projections.get(threadId) ?? emptyProjection(makeThread(threadId)),
  undefined, thread => thread.id === "main", () => true, undefined, undefined, f.teamStore, transport.transport);
  const task = {id: "observe-only-task", threadId: "main", projectId, sourceRunId: "source-run", sourceMessageId: "source-message",
    sourceHash: "source-hash", sourceOrdinal: 0, status: "inferred", objective: "Monitor the operational tree", reason: "Test",
    updatedAt: time, requestText: "", supervisorThreadId: f.binding.threadId, messageId: "source-message", dispatchedAt: null,
    replayCount: 0, supervisorRunId: null,
    workflow: {status: "proposed", message: "Draft", workspaceRoot: "/workspace", revision: "revision", globalRevision: null, steps: [], workflows: []},
  } as unknown as TaskRecord;
  f.store.saveTask(task);
  conversation.requests.saveIntroduction({taskId: task.id, projectId, threadId: task.threadId, supervisorThreadId: f.binding.threadId,
    state: "sent", text: "", messageId: "intro-sent", targetRunId: null, error: null});

  await conversation.run(f.binding as BindingRecord, rootProjection, f.threadList, AbortSignal.timeout(5000));

  const request = conversation.requests.pending(projectId, f.binding.threadId);
  assert.ok(request?.batch);
  assert.ok(request?.text.includes("Rows marked teamCoverageState=transferring or unavailable are observe-only"));
  const envelopeText = request?.text.match(/UNTRUSTED_MONITOR_ENVELOPE\n([\s\S]*?)\nEND_UNTRUSTED_MONITOR_ENVELOPE/u)?.[1];
  const envelope = JSON.parse(envelopeText ?? "null") as {threads?: Array<{threadId: string; teamCoverageState?: string}>};
  assert.equal(envelope.threads?.find(item => item.threadId === "branch")?.teamCoverageState, "unavailable");
  assert.equal(f.monitor.pending(projectId, "branch").length, 1);

  const run = {id: "root-observe-run", threadId: f.binding.threadId, ordinal: 1, status: "completed", requestedAt: iso(time + 10),
    startedAt: iso(time + 10), completedAt: iso(time + 11), rootNodeId: "root-observe-node", providerThreadId: "root-observe-provider",
    userMessageId: request!.messageId};
  rootProjection.runs.push(run);
  nodesOf(rootProjection).push({id: "root-observe-node", kind: "root_turn", status: "completed", threadId: f.binding.threadId, runId: run.id,
    rootNodeId: run.rootNodeId, providerThreadId: run.providerThreadId});
  const assistantNodeId = "root-observe-assistant";
  nodesOf(rootProjection).push({id: assistantNodeId, kind: "assistant_message", status: "completed", threadId: f.binding.threadId, runId: run.id,
    rootNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, parentNodeId: run.rootNodeId});
  rootProjection.messages.push({id: request!.messageId, threadId: f.binding.threadId, runId: run.id, nodeId: run.rootNodeId, role: "user",
    text: request!.text, streaming: false, createdAt: iso(time + 10), updatedAt: iso(time + 10)});
  rootProjection.messages.push({id: "root-observe-final", threadId: f.binding.threadId, runId: run.id, nodeId: assistantNodeId, role: "assistant",
    text: "I observed the fenced activity. " + request!.completionMarker, streaming: false,
    createdAt: iso(time + 11), updatedAt: iso(time + 11), ordinal: 1});
  await conversation.run(f.binding as BindingRecord, rootProjection, f.threadList, AbortSignal.timeout(5000));

  assert.equal(conversation.requests.requests(projectId, f.binding.threadId).find(item => item.id === request!.id)?.state, "completed");
  assert.equal(f.monitor.pending(projectId, "branch").length, 1);
  assert.equal(f.teamStore.unresolvedRequests(f.binding).find(item => item.requestId === "guide:observe-only-unknown")?.state, "uncertain");

  for (let cycle = 0; cycle < 3; cycle++) {
    conversation.requests.noticeSent(f.binding.threadId, Date.now() - SUPERVISOR_MONITOR_COOLDOWN_MS - 1);
    await conversation.run(f.binding as BindingRecord, rootProjection, f.threadList, AbortSignal.timeout(5000));
    assert.equal(conversation.requests.pending(projectId, f.binding.threadId), null);
    assert.equal(calls.length, 1);
  }

  f.teamStore.serviceAttention(f.binding, {eventId: "observe-only-followup", memberThreadId: member.threadId,
    targetThreadId: "branch", summary: "A new root event accompanies the still-fenced branch activity."});
  const eventPartition = conversation.teamRuntime!.partition(f.binding, f.threadList, batchOf(["branch"]));
  assert.equal(eventPartition.rootBatch?.threads[0]?.teamCoverageState, "unavailable");
  assert.ok(eventPartition.rootEvents.some(event => event.id === "observe-only-followup"));
  conversation.requests.noticeSent(f.binding.threadId, Date.now() - SUPERVISOR_MONITOR_COOLDOWN_MS - 1);
  await conversation.run(f.binding as BindingRecord, rootProjection, f.threadList, AbortSignal.timeout(5000));
  const eventRequest = conversation.requests.pending(projectId, f.binding.threadId);
  assert.ok(eventRequest, "the new attention event should wake the root");
  const followupEnvelopeText = eventRequest.text.match(/UNTRUSTED_MONITOR_ENVELOPE\n([\s\S]*?)\nEND_UNTRUSTED_MONITOR_ENVELOPE/u)?.[1];
  const followupEnvelope = JSON.parse(followupEnvelopeText ?? "null") as {threads?: Array<{threadId: string; teamCoverageState?: string}>};
  assert.equal(followupEnvelope.threads?.find(item => item.threadId === "branch")?.teamCoverageState, "unavailable");
  assert.ok(eventRequest?.text.includes("A new root event accompanies the still-fenced branch activity."));

  f.teamStore.settleRequest(f.binding, "guide:observe-only-unknown");
  const successor = readyMember(f.teamStore, f.binding, "helper-observe-successor", time + 20);
  activate(f.teamStore, f.binding, successor, "branch");
  const reassigned = conversation.teamRuntime!.partition(f.binding, f.threadList, batchOf(["branch"]));
  assert.equal(reassigned.rootBatch, null);
  assert.equal(reassigned.helperBatches[0]?.actorThreadId, successor.threadId);
  assert.equal(f.monitor.pending(projectId, "branch").length, 1);
});

test("one helper receives its assigned subtree while transfer activity stays pending", async t => {
  const f = await fixture();t.after(f.cleanup);
  const first = readyMember(f.teamStore, f.binding, "helper-one");
  const second = readyMember(f.teamStore, f.binding, "helper-two", time + 10);
  activate(f.teamStore, f.binding, first, "branch");
  const runtime = f.runtime();
  const batch = batchOf(["main", "branch", "leaf", "other"]);
  const partition = runtime.partition(f.binding, f.threadList, batch);
  assert.deepEqual(partition.rootBatch?.threads.map(item => item.threadId), ["main", "other"]);
  assert.equal(partition.helperBatches.length, 1);
  assert.equal(partition.helperBatches[0]?.actorThreadId, first.threadId);
  assert.deepEqual(partition.helperBatches[0]?.batch.threads.map(item => item.threadId), ["branch", "leaf"]);
  assert.deepEqual(partition.helperBatches[0]?.targets.map(item => item.assignmentRootThreadId), ["branch", "branch"]);

  f.teamStore.assign(f.binding, "branch", second.threadId, parents, time + 20);
  const transferring = runtime.partition(f.binding, f.threadList, batch);
  assert.deepEqual(transferring.rootBatch?.threads.map(item => item.threadId), ["main", "branch", "leaf", "other"]);
  assert.equal(transferring.rootBatch?.threads.find(item => item.threadId === "branch")?.teamCoverageState, "transferring");
  assert.equal(transferring.rootBatch?.threads.find(item => item.threadId === "leaf")?.teamCoverageState, "transferring");
  assert.deepEqual(runtime.rootOwnedBatch(f.binding, transferring.rootBatch!, f.threadList)?.threads.map(item => item.threadId), ["main", "other"]);
  assert.equal(transferring.helperBatches.length, 0);
  assert.equal(f.teamStore.coverage(f.binding, "leaf", parents).state, "transferring");
  assert.equal(runtime.hasBlockingWork(f.binding), true);
});

test("a quarantined helper retires its channel, preserves unknown effects, and exposes only observe-only root coverage", async t => {
  const f = await fixture();t.after(f.cleanup);
  const member = readyMember(f.teamStore, f.binding, "helper-quarantined");
  activate(f.teamStore, f.binding, member, "branch");
  const assignment = f.teamStore.coverage(f.binding, "branch", parents);
  f.teamStore.recordRequest(f.binding, {requestId: "guide:quarantined-unknown", memberThreadId: member.threadId, memberEpoch: member.epoch,
    targets: [{targetThreadId: "branch", assignmentRootThreadId: assignment.assignmentRootThreadId!, assignmentEpoch: assignment.assignmentEpoch!}],
    parentById: parents, now: time + 10});
  f.teamStore.setRequestState(f.binding, member.threadId, "guide:quarantined-unknown", member.epoch, "uncertain", time + 11);
  const quarantined = f.teamStore.quarantineMember(f.binding, member.threadId, time + 12);
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport);

  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  const partition = runtime.partition(f.binding, f.threadList, batchOf(["branch", "leaf"]));
  assert.equal(quarantined.state, "quarantined");
  assert.equal(f.teamStore.snapshot(f.binding).members.find(item => item.threadId === member.threadId)?.epoch, member.epoch + 1);
  assert.equal(f.teamStore.unresolvedRequests(f.binding).find(item => item.requestId === "guide:quarantined-unknown")?.state, "uncertain");
  assert.deepEqual(transport.retired, [member.threadId]);
  assert.deepEqual(partition.helperBatches, []);
  assert.deepEqual(partition.rootBatch?.threads.map(item => [item.threadId, item.teamCoverageState]), [
    ["branch", "unavailable"], ["leaf", "unavailable"],
  ]);
  assert.equal(runtime.rootOwnedBatch(f.binding, partition.rootBatch!, f.threadList), null);
  assert.equal(runtime.hasBlockingWork(f.binding), true);

  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  assert.equal(f.teamStore.snapshot(f.binding).members.find(item => item.threadId === member.threadId)?.epoch, member.epoch + 1);
  assert.deepEqual(transport.retired, [member.threadId]);
});

test("an unresolved helper review stays fenced and observe-only rows do not create a root wake alone", async t => {
  const f = await fixture();t.after(f.cleanup);
  const first = readyMember(f.teamStore, f.binding, "helper-review-handover");
  const second = readyMember(f.teamStore, f.binding, "helper-review-successor", time + 10);
  activate(f.teamStore, f.binding, first, "branch");
  const coverage = f.teamStore.coverage(f.binding, "branch", parents);
  const requestId = "team-review:handover-pending";
  const request = f.requests.prepare({id: requestId, projectId, supervisorThreadId: first.threadId, kind: "review", taskId: null,
    text: "Assess branch activity.", batch: batchOf(["branch"]), completionMarker: "review complete"}, time + 20);
  f.requests.saveRequest({...request, state: "waiting", sentAt: time + 20});
  f.teamStore.recordRequest(f.binding, {requestId, memberThreadId: first.threadId, memberEpoch: first.epoch,
    targets: [{targetThreadId: "branch", assignmentRootThreadId: coverage.assignmentRootThreadId!, assignmentEpoch: coverage.assignmentEpoch!}],
    parentById: parents, now: time + 20});
  f.teamStore.assign(f.binding, "branch", second.threadId, parents, time + 21);
  for (const event of f.teamStore.snapshot(f.binding).events.filter(value => value.acknowledgedAt === null &&
    (value.severity === "attention" || value.severity === "result")))
    f.teamStore.acknowledgeEvent(f.binding, f.binding.threadId, event.id);

  const partition = f.runtime().partition(f.binding, f.threadList, batchOf(["branch", "leaf"]));
  assert.equal(partition.rootBatch, null);
  assert.deepEqual(partition.helperBatches, []);
  assert.equal(f.teamStore.coverage(f.binding, "branch", parents).state, "transferring");
});

test("runtime completes a transfer only after both helpers finish their exact handover check-ins", async t => {
  const f = await fixture();t.after(f.cleanup);
  const first = readyMember(f.teamStore, f.binding, "helper-transfer-from");
  const second = readyMember(f.teamStore, f.binding, "helper-transfer-to", time + 10);
  activate(f.teamStore, f.binding, first, "branch");
  f.projections.set(first.threadId, helperProjection(first, f.binding.threadId));
  f.projections.set(second.threadId, helperProjection(second, f.binding.threadId));
  const transfer = f.teamStore.assign(f.binding, "branch", second.threadId, parents, time + 20);
  const handovers = f.teamStore.snapshot(f.binding).notifications.filter(item => item.assignmentRootThreadId === "branch" && item.assignmentEpoch === transfer.epoch);
  assert.equal(handovers.length, 2);
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport);
  const completed = new Set<string>();

  for (let cycle = 0; cycle < 6; cycle++) {
    runtime.startCycle(f.binding);
    await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
    if (cycle === 0) {
      const notificationDelivery = [...transport.sent.entries()].find(([logicalId]) => logicalId.startsWith("supervisor-team-notice:"));
      assert.ok(notificationDelivery);
      if (!notificationDelivery) throw new Error("handover_notification_delivery_missing");
      const [logicalId, delivery] = notificationDelivery;
      const envelope = parseEnvelope(delivery.text, "UNTRUSTED_TEAM_NOTIFICATION", "END_UNTRUSTED_TEAM_NOTIFICATION");
      const member = f.teamStore.snapshot(f.binding).members.find(item => item.threadId === delivery.threadId);
      const notice = f.teamStore.snapshot(f.binding).notifications.find(item => item.id ===
        (envelope.notification as Record<string, unknown> | undefined)?.id);
      assert.ok(member);
      assert.ok(notice);
      assert.equal(envelope.supervisorThreadId, delivery.threadId);
      assert.equal(envelope.helperThreadId, delivery.threadId);
      assert.equal(envelope.bindingGeneration, f.binding.generation);
      assert.equal(envelope.memberEpoch, member?.epoch);
      assert.ok(logicalId.startsWith("supervisor-team-notice:"));
      const toolInputs = envelope.toolInputs as Record<string, {input: Record<string, unknown>}>;
      assert.deepEqual(Object.keys(toolInputs), ["workflow_read"]);
      const readCall = toolInputs.workflow_read;
      assert.ok(readCall);
      const readAuthority = {supervisorThreadId: delivery.threadId, bindingGeneration: f.binding.generation, memberEpoch: member?.epoch,
        ...(notice?.assignmentRootThreadId ? {assignmentRootThreadId: notice.assignmentRootThreadId} : {}),
        ...(notice?.assignmentEpoch ? {assignmentEpoch: notice.assignmentEpoch} : {})};
      assert.deepEqual(readCall.input, readAuthority);
      assert.equal(Object.hasOwn(readCall.input, "targetThreadId"), false);
      assertAdvertisedInput(workflowReadToolDefinition, readCall.input);
      assert.equal(envelope.locatorBases, undefined, "handover notifications do not carry stale write locators");
    }
    for (const [logicalId, delivery] of transport.sent) {
      if (!logicalId.startsWith("supervisor-team-notice:") || completed.has(logicalId)) continue;
      const projection = f.projections.get(delivery.threadId)!;
      const nativeMessageId = `native-${logicalId}`;
      const runId = `run-${logicalId}`;
      projection.runs.push({id: runId, threadId: delivery.threadId, ordinal: projection.runs.length + 1, status: "completed",
        requestedAt: iso(time + cycle + 1), startedAt: iso(time + cycle + 1), completedAt: iso(time + cycle + 2),
        rootNodeId: null, userMessageId: nativeMessageId});
      projection.messages.push({id: nativeMessageId, threadId: delivery.threadId, runId, nodeId: null, role: "user", text: delivery.text,
        streaming: false, createdAt: iso(time + cycle + 1), updatedAt: iso(time + cycle + 1), scheduledTaskId: delivery.taskId, creationSource: "server"});
      const identity = logicalId.slice("supervisor-team-notice:".length);
      const [notificationId, attemptText] = identity.split(":attempt:");
      const attempt = Number(attemptText);
      projection.messages.push({id: `final-${logicalId}`, threadId: delivery.threadId, runId, nodeId: null, role: "assistant",
        text: `Handover considered. Supervisor team notification ${notificationId} attempt ${attempt} completed`, streaming: false,
        createdAt: iso(time + cycle + 2), updatedAt: iso(time + cycle + 2), ordinal: 1});
      completed.add(logicalId);
    }
  }

  assert.deepEqual(f.teamStore.snapshot(f.binding).notifications.filter(item => item.assignmentRootThreadId === "branch" && item.assignmentEpoch === transfer.epoch)
    .map(item => item.state), ["acknowledged", "acknowledged"]);
  assert.equal(f.teamStore.coverage(f.binding, "branch", parents).state, "assigned");
  assert.equal(f.teamStore.coverage(f.binding, "branch", parents).actorThreadId, second.threadId);
  assert.ok(f.teamStore.snapshot(f.binding).events.some(item => item.kind === "assignment_handover_completed" && item.targetThreadId === "branch"));
});

test("only explicit retry creates a fresh rejected notification attempt and stale markers cannot acknowledge it", async t => {
  const f = await fixture();t.after(f.cleanup);
  const member = readyMember(f.teamStore, f.binding, "helper-notice-retry");
  activate(f.teamStore, f.binding, member, "branch");
  const transfer = f.teamStore.assign(f.binding, "branch", null, parents, time + 10);
  const notification = f.teamStore.snapshot(f.binding).notifications.find(item =>
    item.assignmentRootThreadId === "branch" && item.assignmentEpoch === transfer.epoch && item.kind === "handover_release");
  assert.ok(notification);
  if (!notification) throw new Error("release_notification_missing");
  f.projections.set(member.threadId, helperProjection(member, f.binding.threadId));
  const transport = webhookTransport("rejected");
  const runtime = f.runtime(transport.transport);

  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  const failed = f.teamStore.snapshot(f.binding).notifications.find(item => item.id === notification.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.deliveryAttempt, 0);
  assert.equal(transport.attempts.length, 1);
  assert.ok(f.teamStore.snapshot(f.binding).events.some(item => item.id === `notification-failed:${notification.id}:0`));
  assert.ok(f.runtime(transport.transport).partition(f.binding, f.threadList, null).rootEvents.some(item =>
    item.id === `notification-failed:${notification.id}:0`));

  assert.equal(f.teamStore.retryFailedNotifications(f.binding, member.threadId, time + 20), 1);
  const retried = f.teamStore.snapshot(f.binding).notifications.find(item => item.id === notification.id);
  assert.equal(retried?.state, "pending");
  assert.equal(retried?.deliveryAttempt, 1);
  const projection = f.projections.get(member.threadId)!;
  const oldLogicalId = `supervisor-team-notice:${notification.id}:attempt:0`;
  const oldText = transport.sent.get(oldLogicalId)?.text;
  assert.ok(oldText);
  const oldRunId = "old-notification-run";
  const oldMessageId = "native-old-notification";
  projection.runs.push({id: oldRunId, threadId: member.threadId, ordinal: 1, status: "completed", requestedAt: iso(time + 15),
    startedAt: iso(time + 15), completedAt: iso(time + 16), rootNodeId: null, userMessageId: oldMessageId});
  projection.messages.push({id: oldMessageId, threadId: member.threadId, runId: oldRunId, nodeId: null, role: "user", text: oldText!,
    streaming: false, createdAt: iso(time + 15), updatedAt: iso(time + 15), scheduledTaskId: `scheduled-${member.threadId}`, creationSource: "server"});
  projection.messages.push({id: "old-notification-final", threadId: member.threadId, runId: oldRunId, nodeId: null, role: "assistant",
    text: `Old notice completed. Supervisor team notification ${notification.id} attempt 0 completed`, streaming: false,
    createdAt: iso(time + 16), updatedAt: iso(time + 16), ordinal: 1});

  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  const failedRetry = f.teamStore.snapshot(f.binding).notifications.find(item => item.id === notification.id);
  assert.equal(failedRetry?.state, "failed");
  assert.equal(failedRetry?.deliveryAttempt, 1);
  assert.equal(transport.attempts.length, 2);
  assert.ok(transport.attempts[0]?.endsWith(":attempt:0"));
  assert.ok(transport.attempts[1]?.endsWith(":attempt:1"));
  assert.equal(f.teamStore.coverage(f.binding, "branch", parents).state, "transferring");
});

test("registration readiness uses a finite native check-in and exact member epoch", async t => {
  const f = await fixture();t.after(f.cleanup);
  const member = f.teamStore.registerMember(f.binding, {threadId: "helper-ready", taskId: "bootstrap-task", bootstrapRunId: "bootstrap-run", now: time});
  f.projections.set(member.threadId, helperProjection(member, f.binding.threadId));
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport);
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  const request = f.requests.pending(projectId, member.threadId);
  assert.ok(request);
  if (!request) throw new Error("readiness_request_missing");
  assert.ok(request.id.startsWith("team-ready:"));
  assert.ok(request.text.includes("t3-supervisor-workflows__supervision_team"));
  assert.ok(request.text.includes(`bindingGeneration=${f.binding.generation}`));
  assert.ok(request.text.includes(`memberEpoch=${member.epoch}`));
  const operation = JSON.parse(request.text.match(/operationId=("[^"]+")/u)?.[1] ?? "null") as string;
  assert.ok(operation.length <= 128);
  assert.equal(transport.sent.get(request.messageId)?.threadId, member.threadId);
  assert.equal(runtime.hasBlockingWork(f.binding), true);

  f.teamStore.markReady(f.binding, member.threadId, member.epoch, time + 5);
  const projection = f.projections.get(member.threadId)!;
  const runId = "ready-run";
  const nativeMessageId = "native-ready-message";
  projection.runs.push({id: runId, threadId: member.threadId, ordinal: 1, status: "completed", requestedAt: iso(time + 2),
    startedAt: iso(time + 2), completedAt: iso(time + 3), rootNodeId: null, userMessageId: nativeMessageId});
  projection.messages.push({id: nativeMessageId, threadId: member.threadId, runId, nodeId: null, role: "user", text: request.text,
    streaming: false, createdAt: iso(time + 2), updatedAt: iso(time + 2), scheduledTaskId: `scheduled-${member.threadId}`, creationSource: "server"});
  projection.messages.push({id: "ready-final", threadId: member.threadId, runId, nodeId: null, role: "assistant",
    text: `Ready. ${request.completionMarker}`, streaming: false, createdAt: iso(time + 3), updatedAt: iso(time + 3), ordinal: 1});
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  assert.equal(f.requests.requests(projectId, member.threadId).find(item => item.id === request.id)?.state, "completed");
  assert.equal(f.teamStore.resolveActor(f.binding, member.threadId, member.epoch), null);
  assert.equal(f.teamStore.snapshot(f.binding).members.find(item => item.threadId === member.threadId)?.state, "ready");
});

test("failed readiness waits for the root retry acknowledgment before another attempt", async t => {
  const f = await fixture();t.after(f.cleanup);
  const member = f.teamStore.registerMember(f.binding, {threadId: "helper-ready-failed", taskId: "bootstrap-task", bootstrapRunId: "bootstrap-run", now: time});
  f.projections.set(member.threadId, helperProjection(member, f.binding.threadId));
  const transport = webhookTransport("rejected");
  const runtime = f.runtime(transport.transport);
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  const failed = f.requests.requests(projectId, member.threadId).find(item => item.id.startsWith("team-ready:") && item.state === "failed");
  assert.ok(failed);
  assert.equal(transport.attempts.length, 1);
  assert.ok(f.teamStore.snapshot(f.binding).events.some(item => item.kind === "service_attention" && item.memberThreadId === member.threadId));

  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  assert.equal(transport.attempts.length, 1);

  f.requests.saveRequest({...failed!, failureAcknowledged: true});
  f.requests.noticeSent(member.threadId, 0);
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  assert.equal(transport.attempts.length, 2);
  assert.equal(f.requests.requests(projectId, member.threadId).filter(item => item.id.startsWith("team-ready:")).length, 2);
});

test("failed helper review blocks automatic replacement until the root acknowledges it", async t => {
  const f = await fixture();t.after(f.cleanup);
  const member = readyMember(f.teamStore, f.binding, "helper-review-failed");
  activate(f.teamStore, f.binding, member, "branch");
  f.projections.set(member.threadId, helperProjection(member, f.binding.threadId));
  const coverage = f.teamStore.coverage(f.binding, "branch", parents);
  const batch = {actorThreadId: member.threadId, memberEpoch: member.epoch,
    targets: [{targetThreadId: "branch", assignmentRootThreadId: coverage.assignmentRootThreadId!, assignmentEpoch: coverage.assignmentEpoch!}],
    batch: batchOf(["branch"])};
  const transport = webhookTransport("rejected");
  const runtime = f.runtime(transport.transport);

  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, [batch], AbortSignal.timeout(5000));
  const failed = f.requests.requests(projectId, member.threadId).find(item => item.id.startsWith("team-review:") && item.state === "failed");
  assert.ok(failed);
  assert.equal(f.teamStore.unresolvedRequests(f.binding).some(item => item.requestId === failed!.id), false);
  assert.ok(f.teamStore.snapshot(f.binding).events.some(item => item.kind === "service_attention" && item.memberThreadId === member.threadId));

  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, [batch], AbortSignal.timeout(5000));
  assert.equal(transport.attempts.length, 1);

  f.requests.saveRequest({...failed!, failureAcknowledged: true});
  f.requests.noticeSent(member.threadId, 0);
  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, [batch], AbortSignal.timeout(5000));
  assert.equal(transport.attempts.length, 2);
});

for (const lossMode of ["404", "archived", "deleted"] as const) {
  test(`${lossMode === "archived" ? "an archived" : `a ${lossMode}`} helper fails only its own pending check-ins and retires once`, async t => {
    const f = await fixture();t.after(f.cleanup);
    const member = readyMember(f.teamStore, f.binding, `helper-lost-${lossMode}`);
    activate(f.teamStore, f.binding, member, "branch");
    const coverage = f.teamStore.coverage(f.binding, "branch", parents);
    const target = {targetThreadId: "branch", assignmentRootThreadId: coverage.assignmentRootThreadId!, assignmentEpoch: coverage.assignmentEpoch!};
    const reviewId = "team-review:lost-helper";
    const review = f.requests.prepare({id: reviewId, projectId, supervisorThreadId: member.threadId, kind: "review", taskId: null,
      text: "Review this assigned activity.", batch: batchOf(["branch"]), completionMarker: "review complete"}, time);
    f.requests.saveRequest({...review, state: "waiting", sentAt: time});
    f.teamStore.recordRequest(f.binding, {requestId: reviewId, memberThreadId: member.threadId, memberEpoch: member.epoch,
      targets: [target], parentById: parents, now: time});
    const unsettledCrashId = "team-review:failed-before-settle";
    f.requests.saveRequest({...review, id: unsettledCrashId, messageId: `supervisor-review:${unsettledCrashId}`, state: "failed",
      error: "The prior runtime stopped between recording failure and settling its team request."});
    f.teamStore.recordRequest(f.binding, {requestId: unsettledCrashId, memberThreadId: member.threadId, memberEpoch: member.epoch,
      targets: [target], parentById: parents, now: time + 1});
    f.teamStore.recordRequest(f.binding, {requestId: "guide:unknown", memberThreadId: member.threadId, memberEpoch: member.epoch,
      targets: [target], parentById: parents, now: time + 2});
    f.teamStore.setRequestState(f.binding, member.threadId, "guide:unknown", member.epoch, "uncertain", time + 3);
    const transport = webhookTransport();
    const projection = async (threadId: string): Promise<Projection> => {
      if (threadId === member.threadId && lossMode === "404") throw new T3TransportError("helper deleted", 404);
      const value = f.projections.get(threadId) ?? emptyProjection(makeThread(threadId));
      if (threadId === member.threadId && lossMode === "archived") value.thread.archivedAt = iso(time + 10);
      if (threadId === member.threadId && lossMode === "deleted") value.thread.deletedAt = iso(time + 10);
      return value;
    };
    const runtime = f.runtime(transport.transport, projection);

    runtime.startCycle(f.binding);
    await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
    const lost = f.teamStore.snapshot(f.binding).members.find(item => item.threadId === member.threadId);
    assert.equal(lost?.state, "missing");
    assert.equal(lost?.epoch, member.epoch + 1);
    assert.equal(f.requests.requests(projectId, member.threadId).find(item => item.id === reviewId)?.state, "failed");
    assert.equal(f.teamStore.unresolvedRequests(f.binding).find(item => item.requestId === reviewId), undefined);
    assert.equal(f.teamStore.unresolvedRequests(f.binding).find(item => item.requestId === unsettledCrashId), undefined);
    assert.equal(f.teamStore.unresolvedRequests(f.binding).find(item => item.requestId === "guide:unknown")?.state, "uncertain");
    assert.equal(f.teamStore.coverage(f.binding, "branch", parents).state, "unavailable");
    assert.deepEqual(transport.retired, [member.threadId]);

    runtime.startCycle(f.binding);
    await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
    assert.equal(f.teamStore.snapshot(f.binding).members.find(item => item.threadId === member.threadId)?.epoch, member.epoch + 1);
    assert.equal(f.teamStore.snapshot(f.binding).events.filter(item => item.kind === "member_missing" && item.memberThreadId === member.threadId).length, 1);
    assert.deepEqual(transport.retired, [member.threadId]);

    f.teamStore.settleRequest(f.binding, "guide:unknown");
    assert.equal(f.teamStore.coverage(f.binding, "branch", parents).state, "root");
  });
}

test("a lost registering helper fails and settles its own readiness request", async t => {
  const f = await fixture();t.after(f.cleanup);
  const member = f.teamStore.registerMember(f.binding, {threadId: "helper-readiness-lost", taskId: "bootstrap-task", bootstrapRunId: "bootstrap-run", now: time});
  const request = f.requests.prepare({id: "team-ready:lost-registration", projectId, supervisorThreadId: member.threadId, kind: "review", taskId: null,
    text: "Confirm readiness.", batch: null, completionMarker: "ready complete", teamMemberEpoch: member.epoch}, time + 1);
  f.requests.saveRequest({...request, state: "waiting", sentAt: time + 1});
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport, async threadId => {
    if (threadId === member.threadId) throw new T3TransportError("helper deleted", 404);
    return f.projections.get(threadId) ?? emptyProjection(makeThread(threadId));
  });

  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  assert.equal(f.requests.requests(projectId, member.threadId).find(item => item.id === request.id)?.state, "failed");
  assert.equal(f.teamStore.snapshot(f.binding).members.find(item => item.threadId === member.threadId)?.state, "missing");
  assert.deepEqual(transport.retired, [member.threadId]);
});

test("a stale completed helper check-in settles its request without acknowledging reassigned activity", async t => {
  const f = await fixture();t.after(f.cleanup);
  const first = readyMember(f.teamStore, f.binding, "helper-stale");
  const second = readyMember(f.teamStore, f.binding, "helper-successor", time + 10);
  activate(f.teamStore, f.binding, first, "branch");
  const opThread = makeThread("branch", "main", "subagent");
  const op = emptyProjection(opThread);
  const runId = "operational-run";
  const providerThreadId = "provider-branch";
  op.runs.push({id: runId, threadId: opThread.id, ordinal: 1, status: "completed", requestedAt: iso(time), startedAt: iso(time),
    completedAt: iso(time + 1), rootNodeId: "root-node", providerThreadId});
  op.nodes = [
    {id: "root-node", kind: "root_turn", status: "completed", threadId: opThread.id, runId, rootNodeId: "root-node", providerThreadId},
    {id: "tool-node", kind: "tool_call", status: "completed", threadId: opThread.id, runId, rootNodeId: "root-node", providerThreadId, parentNodeId: "root-node"},
    {id: "assistant-node", kind: "assistant_message", status: "completed", threadId: opThread.id, runId, rootNodeId: "root-node",
      providerThreadId, parentNodeId: "root-node"},
  ];
  const exactItemId = "turn-item:command%253Aopaque%3A1";
  const exactMessageId = "assistant%253Amessage%3A2";
  const oversizedItemId = "x".repeat(201);
  op.turnItems = [
    {id: exactItemId, threadId: opThread.id, runId: null, type: "command_execution", status: "completed",
      ordinal: 1, completedAt: iso(time + 1), updatedAt: iso(time + 1)},
    {id: oversizedItemId, threadId: opThread.id, runId: null, type: "command_execution", status: "completed",
      ordinal: 2, completedAt: iso(time + 2), updatedAt: iso(time + 2)},
  ];
  op.messages.push({id: exactMessageId, threadId: opThread.id, runId, nodeId: "assistant-node", role: "assistant",
    text: "The result was inspected.", streaming: false, createdAt: iso(time + 1), updatedAt: iso(time + 1)});
  op.runtimeRequests = [{id: "request%253Aopaque", nodeId: "tool-node", kind: "user_input", status: "pending",
    createdAt: iso(time + 1), resolvedAt: null}];
  f.monitor.observe({projectId, threadId: opThread.id, sourceOrdinal: 0, projection: op, now: time + 2, includeDetachedChildItems: true});
  const selected = f.monitor.select(projectId, {intervalMinutes: 5, activityThreshold: 1}, time + 3, null, {eligibleThreadIds: new Set([opThread.id])});
  assert.ok(selected);
  const archivedTarget = f.threadList.find(thread => thread.id === "leaf")!;
  archivedTarget.archivedAt = iso(time + 2);
  const helper = helperProjection(first, f.binding.threadId);
  f.projections.set(first.threadId, helper);
  f.projections.set(second.threadId, helperProjection(second, f.binding.threadId));
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport);
  const selectedWithArchived = {...selected!, finalizedActivityCount: selected!.finalizedActivityCount + 1,
    pendingItemCount: selected!.pendingItemCount + 1, threads: [...selected!.threads, batchThread(archivedTarget.id)]};
  const partition = runtime.partition(f.binding, f.threadList, selectedWithArchived);
  assert.equal(partition.helperBatches.length, 1);
  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, partition.helperBatches, AbortSignal.timeout(5000));
  const request = f.requests.pending(projectId, first.threadId);
  assert.ok(request);
  if (!request?.batch) throw new Error("helper_review_request_missing");
  const monitorEnvelope = parseEnvelope(request.text, "UNTRUSTED_TEAM_MONITOR_ENVELOPE", "END_UNTRUSTED_TEAM_MONITOR_ENVELOPE");
  assert.equal(monitorEnvelope.rootThreadId, f.binding.threadId);
  assert.equal(monitorEnvelope.supervisorThreadId, first.threadId);
  assert.equal(monitorEnvelope.helperThreadId, first.threadId);
  assert.equal(monitorEnvelope.bindingGeneration, f.binding.generation);
  assert.equal(monitorEnvelope.memberEpoch, first.epoch);
  const envelopeTargets = monitorEnvelope.targets as Array<Record<string, unknown>>;
  assert.equal(envelopeTargets.length, 2);
  const targetEnvelope = envelopeTargets.find(item => item.targetThreadId === "branch")!;
  const archivedEnvelope = envelopeTargets.find(item => item.targetThreadId === archivedTarget.id)!;
  const activityRefs = targetEnvelope.activityRefs as Array<Record<string, string>>;
  assert.deepEqual(activityRefs.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))), [
    {sourceThreadId: "branch", sourceItemId: exactItemId},
    {sourceThreadId: "branch", sourceMessageId: exactMessageId},
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  assert.deepEqual(archivedEnvelope.activityRefs, [], "run-only synthetic activity has no ready reference");
  assert.ok(activityRefs.every(reference => !Object.hasOwn(reference, "sourceRunId")));
  assert.equal(request.text.includes("Omit sourceRunId"), true);
  assert.equal(request.text.includes("Never decode, re-encode, normalize or reconstruct opaque IDs"), true);
  assert.match(request.text, /mark them underway or completed in a separate later apply with status_changed evidence/u);
  assert.match(request.text, /On rejection, read the reason, code, and path/u);
  assert.deepEqual({targetThreadId: targetEnvelope.targetThreadId, assignmentRootThreadId: targetEnvelope.assignmentRootThreadId,
    assignmentEpoch: targetEnvelope.assignmentEpoch}, {targetThreadId: "branch", assignmentRootThreadId: "branch",
    assignmentEpoch: f.teamStore.coverage(f.binding, "branch", parents).assignmentEpoch});
  const authority = {supervisorThreadId: first.threadId, bindingGeneration: f.binding.generation, memberEpoch: first.epoch,
    assignmentRootThreadId: "branch", assignmentEpoch: f.teamStore.coverage(f.binding, "branch", parents).assignmentEpoch!};
  const toolInputs = targetEnvelope.toolInputs as Record<string, {input: Record<string, unknown>}>;
  assert.ok(toolInputs.workflow_read);
  const readInput = toolInputs.workflow_read.input;
  assert.deepEqual(readInput, authority);
  assert.equal(Object.hasOwn(readInput, "targetThreadId"), false, "workflow_read has no targetThreadId field");
  assertAdvertisedInput(workflowReadToolDefinition, readInput);
  assert.ok(toolInputs.workflow_write_link_child);
  const linkInput = toolInputs.workflow_write_link_child.input;
  const {operationId: linkOperationId, note: linkNote, ...linkLocators} = linkInput;
  assert.deepEqual(linkLocators, {...authority, action: "link_child", childThreadId: "branch"});
  assert.equal(typeof linkOperationId, "string");
  assert.equal(typeof linkNote, "string");
  assert.equal(linkInput.targetThreadId, undefined, "link_child uses childThreadId rather than targetThreadId");
  assertAdvertisedInput(workflowWriteToolDefinition, linkInput);
  const locatorBases = targetEnvelope.locatorBases as Record<string, Record<string, unknown>>;
  assert.deepEqual(locatorBases.workflow_write_apply, authority);
  assert.deepEqual(locatorBases.supervision_guide, {...authority, targetThreadId: "branch"});
  assert.deepEqual(locatorBases.supervision_team_report, {...authority, targetThreadId: "branch", action: "report"});
  assertAdvertisedInput(workflowWriteToolDefinition, locatorBases.workflow_write_apply, false);
  assertAdvertisedInput(supervisionGuideToolDefinition, locatorBases.supervision_guide, false);
  assertAdvertisedInput(supervisionTeamToolDefinition, locatorBases.supervision_team_report, false);
  const archivedToolInputs = archivedEnvelope.toolInputs as Record<string, {input: Record<string, unknown>}>;
  assert.deepEqual(Object.keys(archivedToolInputs), ["workflow_read"]);
  assert.equal(archivedEnvelope.workflowWriteEligibility, "target_archived_or_deleted");
  assert.ok(archivedToolInputs.workflow_read);
  assert.equal(Object.hasOwn(archivedToolInputs.workflow_read.input, "targetThreadId"), false);
  assertAdvertisedInput(workflowReadToolDefinition, archivedToolInputs.workflow_read.input);
  assert.equal(archivedEnvelope.locatorBases, undefined);
  const targetRequest = f.teamStore.unresolvedRequests(f.binding).find(item => item.requestId === request.id);
  assert.ok(targetRequest);
  const helperRunId = "helper-review-run";
  const nativeMessageId = "native-helper-review-message";
  helper.runs.push({id: helperRunId, threadId: first.threadId, ordinal: 1, status: "completed", requestedAt: iso(time + 10),
    startedAt: iso(time + 10), completedAt: iso(time + 11), rootNodeId: null, userMessageId: nativeMessageId});
  helper.messages.push({id: nativeMessageId, threadId: first.threadId, runId: helperRunId, nodeId: null, role: "user", text: request.text,
    streaming: false, createdAt: iso(time + 10), updatedAt: iso(time + 10), scheduledTaskId: `scheduled-${first.threadId}`, creationSource: "server"});
  helper.messages.push({id: "helper-review-final", threadId: first.threadId, runId: helperRunId, nodeId: null, role: "assistant",
    text: `Current assignment reviewed. ${request.completionMarker}`, streaming: false, createdAt: iso(time + 11), updatedAt: iso(time + 11), ordinal: 1});
  f.teamStore.assign(f.binding, "branch", second.threadId, parents, time + 12);
  const pendingBefore = f.monitor.pending(projectId, opThread.id).map(item => item.id);
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  assert.deepEqual(f.monitor.pending(projectId, opThread.id).map(item => item.id), pendingBefore);
  assert.equal(f.requests.requests(projectId, first.threadId).find(item => item.id === request.id)?.state, "completed");
  assert.equal(f.teamStore.unresolvedRequests(f.binding).some(item => item.requestId === request.id), false);
  assert.equal(f.teamStore.coverage(f.binding, opThread.id, parents).state, "transferring");
  assert.equal(f.teamStore.snapshot(f.binding).events.some(item => item.kind === "service_attention" && item.memberThreadId === first.threadId &&
    item.summary.includes("check-in failed")), false);
});

test("an oversized helper batch is split without acknowledging activity reserved for its next check-in", async t => {
  let now = time + 100;
  t.mock.method(Date, "now", () => now);
  const f = await fixture();t.after(f.cleanup);
  const helperThreadId = "thread:delegated-task:command%3Amcp%3A7ad44b46-41f3-4133-8db5-6199fb9b109b%3Adelegate-task%3A508b27d1-3107-47bf-97cd-f1b522adb9ba-helper-bootstrap-64b376ad-ebc6-47f7-b37f-345d6f45583f";
  const assignmentRootId = "thread:delegated-task:command%3Amcp%3Afd38e33d-d163-4deb-8fd2-490fdb5e01e3%3Adelegate-task%3Ainvoice-delivery-receipt-parent-508b27d1-3107-47bf-97cd-f1b522adb9ba";
  const targetThreadIds = Array.from({length: 25}, (_, index) =>
    `thread:delegated-task:command%3Amcp%3Afd38e33d-d163-4deb-8fd2-490fdb5e01e3%3Adelegate-task%3Ainvoice-delivery-receipt-target-${String(index).padStart(2, "0")}-508b27d1-3107-47bf-97cd-f1b522adb9ba`);
  assert.ok([helperThreadId, assignmentRootId, ...targetThreadIds].every(id => id.length <= 512));
  const operationalRoot = makeThread(assignmentRootId, "main", "subagent");
  const operationalThreads = targetThreadIds.map(id => makeThread(id, assignmentRootId, "subagent"));
  const allThreads = [operationalRoot, ...operationalThreads];
  f.threadList.push(...allThreads);
  const parentById = new Map(parents);
  parentById.set(assignmentRootId, "main");
  for (const id of targetThreadIds) parentById.set(id, assignmentRootId);
  const member = readyMember(f.teamStore, f.binding, helperThreadId);
  activate(f.teamStore, f.binding, member, assignmentRootId, time, parentById);
  f.projections.set(member.threadId, helperProjection(member, f.binding.threadId));

  const exactItemIds = new Map<string, string>();
  for (const [targetIndex, operationalThread] of operationalThreads.entries()) {
    const projection = emptyProjection(operationalThread);
    assert.ok(Array.isArray(projection.nodes));
    for (let runIndex = 0; runIndex < 3; runIndex++) {
      const taskSuffix = `invoice-delivery-receipt-target-${String(targetIndex).padStart(2, "0")}-run-${runIndex}`;
      const runId = `run:command%3Amcp%3Afd38e33d-d163-4deb-8fd2-490fdb5e01e3%3Adelegate-task%3A${taskSuffix}-508b27d1-3107-47bf-97cd-f1b522adb9ba`;
      const rootNodeId = `root:${taskSuffix}`;
      const completedAt = iso(time + runIndex + 1);
      projection.runs.push({id: runId, threadId: operationalThread.id, ordinal: runIndex + 1, status: "completed",
        requestedAt: iso(time + runIndex), startedAt: iso(time + runIndex), completedAt, rootNodeId,
        providerThreadId: `provider:${taskSuffix}`});
      projection.nodes.push({id: rootNodeId, kind: "root_turn", status: "completed", threadId: operationalThread.id,
        runId, rootNodeId, providerThreadId: `provider:${taskSuffix}`});
      if (runIndex === 0) {
        const toolNodeId = `tool:${taskSuffix}`;
        const itemIdPrefix = `turn-item:command%253A${taskSuffix}`;
        const itemId = itemIdPrefix.padEnd(200, "x");
        assert.equal(itemId.length, 200);
        exactItemIds.set(operationalThread.id, itemId);
        projection.nodes.push({id: toolNodeId, kind: "tool_call", status: "completed", threadId: operationalThread.id,
          runId, rootNodeId, providerThreadId: `provider:${taskSuffix}`, parentNodeId: rootNodeId});
        projection.turnItems = [...(projection.turnItems ?? []), {id: itemId, threadId: operationalThread.id, runId, nodeId: toolNodeId,
          type: "command_execution", status: "completed", ordinal: runIndex + 1, completedAt, updatedAt: completedAt}];
      }
    }
    f.projections.set(operationalThread.id, projection);
    f.monitor.observe({projectId, threadId: operationalThread.id, sourceOrdinal: 0, projection, now: time + 10});
  }

  const settings = {intervalMinutes: 5, activityThreshold: 1};
  const allTargetSet = new Set(targetThreadIds);
  const completeBatch = f.monitor.select(projectId, settings, time + 11, null, {eligibleThreadIds: allTargetSet});
  assert.ok(completeBatch);
  if (!completeBatch) throw new Error("oversized_helper_monitor_batch_missing");
  assert.equal(completeBatch.threads.length, targetThreadIds.length);
  assert.equal(completeBatch.pendingItemCount, targetThreadIds.length * 4);
  const pendingBefore = new Map(targetThreadIds.map(id => [id, f.monitor.pending(projectId, id).map(item => item.id)]));
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport);
  const partition = runtime.partition(f.binding, f.threadList, completeBatch);
  assert.equal(partition.helperBatches.length, 1);
  assert.equal(partition.helperBatches[0]?.targets.length, targetThreadIds.length);

  const deliverNextCheckin = async () => {
    runtime.startCycle(f.binding);
    await runtime.runHelperBatch(f.binding, f.threadList, partition.helperBatches, AbortSignal.timeout(5000));
  };
  await deliverNextCheckin();
  const firstRequest = f.requests.pending(projectId, member.threadId);
  assert.ok(firstRequest?.batch);
  if (!firstRequest?.batch) throw new Error("first_bounded_helper_checkin_missing");
  assert.ok(firstRequest.text.length <= 120_000, "the delivered protocol payload stays within the native check-in bound");
  assert.equal(f.teamStore.snapshot(f.binding).events.some(item => item.kind === "service_attention"), false,
    "a fitting tail deferred by the protocol bound is normal pagination, not a root attention event");
  const firstEnvelope = parseEnvelope(firstRequest.text, "UNTRUSTED_TEAM_MONITOR_ENVELOPE", "END_UNTRUSTED_TEAM_MONITOR_ENVELOPE");
  const firstTargets = firstEnvelope.targets as Array<Record<string, unknown>>;
  const firstTargetIds = firstTargets.map(target => String(target.targetThreadId));
  const completeTargetIds = completeBatch.threads.map(thread => thread.threadId);
  assert.ok(firstTargetIds.length > 0 && firstTargetIds.length < completeTargetIds.length,
    "the realistic full helper batch is larger than one supported delivery");
  assert.deepEqual(firstTargetIds, completeTargetIds.slice(0, firstTargetIds.length));
  const firstExpectedThreads = completeBatch.threads.slice(0, firstTargetIds.length);
  assert.deepEqual(firstRequest.batch.threads, firstExpectedThreads);
  const firstExpectedPending = firstExpectedThreads.reduce((count, thread) => count + thread.pendingItemCount, 0);
  const firstExpectedFinalized = firstExpectedThreads.reduce((count, thread) => count + thread.finalizedActivityCount, 0);
  assert.equal(firstRequest.batch.pendingItemCount, firstExpectedPending);
  assert.equal(firstRequest.batch.finalizedActivityCount, firstExpectedFinalized);
  const firstEnvelopeBatch = firstEnvelope.batch as SupervisorMonitorBatch;
  assert.deepEqual(firstEnvelopeBatch.threads.map(thread => thread.threadId), firstTargetIds);
  assert.equal(firstEnvelopeBatch.pendingItemCount, firstExpectedPending);
  assert.equal(firstEnvelopeBatch.finalizedActivityCount, firstExpectedFinalized);
  for (const target of firstTargets) {
    const threadId = String(target.targetThreadId);
    const sourceItemId = exactItemIds.get(threadId)!;
    assert.deepEqual(target.activityRefs, [{sourceThreadId: threadId, sourceItemId}]);
    const batchThread = firstRequest.batch.threads.find(thread => thread.threadId === threadId)!;
    assert.ok(batchThread.previewItems.some(item => item.readItemId === sourceItemId), "references come only from the transmitted preview");
  }
  const remainingTargetIds = completeTargetIds.slice(firstTargetIds.length);
  assert.ok(remainingTargetIds.length > 0);

  const completeHelperTurn = (request: NonNullable<typeof firstRequest>, runLabel: string, completedAt: number): void => {
    const helper = f.projections.get(member.threadId)!;
    const runId = `${runLabel}-run`;
    helper.runs.push({id: runId, threadId: member.threadId, ordinal: helper.runs.length + 1, status: "completed",
      requestedAt: iso(completedAt - 1), startedAt: iso(completedAt - 1), completedAt: iso(completedAt),
      rootNodeId: null, userMessageId: request.messageId});
    helper.messages.push({id: request.messageId, threadId: member.threadId, runId, nodeId: null, role: "user", text: request.text,
      streaming: false, createdAt: iso(completedAt - 1), updatedAt: iso(completedAt - 1),
      scheduledTaskId: `scheduled-${member.threadId}`, creationSource: "server"});
    helper.messages.push({id: `${runLabel}-final`, threadId: member.threadId, runId, nodeId: null, role: "assistant",
      text: `Reviewed the selected monitor scope. ${request.completionMarker}`, streaming: false,
      createdAt: iso(completedAt), updatedAt: iso(completedAt), ordinal: 1});
  };
  completeHelperTurn(firstRequest, "bounded-helper-first", now + 1);
  now += 2;
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  assert.equal(f.requests.requests(projectId, member.threadId).find(item => item.id === firstRequest.id)?.state, "completed");
  for (const id of firstTargetIds) assert.deepEqual(f.monitor.pending(projectId, id), [], `selected target ${id} is acknowledged`);
  for (const id of remainingTargetIds)
    assert.deepEqual(f.monitor.pending(projectId, id).map(item => item.id), pendingBefore.get(id), `unselected target ${id} remains pending`);

  const remainingBatch = f.monitor.select(projectId, settings, time + 12, null, {eligibleThreadIds: allTargetSet});
  assert.ok(remainingBatch);
  if (!remainingBatch) throw new Error("remaining_helper_monitor_batch_missing");
  assert.deepEqual(remainingBatch.threads.map(thread => thread.threadId), remainingTargetIds);
  const remainingPartition = runtime.partition(f.binding, f.threadList, remainingBatch);
  assert.equal(remainingPartition.helperBatches.length, 1);
  assert.deepEqual(remainingPartition.helperBatches[0]?.targets.map(target => target.targetThreadId), remainingTargetIds);
  now += SUPERVISOR_MONITOR_COOLDOWN_MS + 1;
  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, remainingPartition.helperBatches, AbortSignal.timeout(5000));
  const secondRequest = f.requests.pending(projectId, member.threadId);
  assert.ok(secondRequest?.batch);
  if (!secondRequest?.batch) throw new Error("remaining_bounded_helper_checkin_missing");
  assert.ok(secondRequest.text.length <= 120_000);
  const secondEnvelope = parseEnvelope(secondRequest.text, "UNTRUSTED_TEAM_MONITOR_ENVELOPE", "END_UNTRUSTED_TEAM_MONITOR_ENVELOPE");
  const secondTargets = secondEnvelope.targets as Array<Record<string, unknown>>;
  assert.deepEqual(secondTargets.map(target => target.targetThreadId), remainingTargetIds);
  for (const target of secondTargets) {
    const threadId = String(target.targetThreadId);
    assert.deepEqual(target.activityRefs, [{sourceThreadId: threadId, sourceItemId: exactItemIds.get(threadId)!}]);
  }
  assert.deepEqual(secondRequest.batch.threads.map(thread => thread.threadId), remainingTargetIds);
  assert.equal(secondRequest.batch.pendingItemCount, remainingBatch.pendingItemCount);
  assert.equal(secondRequest.batch.finalizedActivityCount, remainingBatch.finalizedActivityCount);
  assert.equal(firstTargetIds.some(id => remainingTargetIds.includes(id)), false, "the next check-in does not duplicate acknowledged targets");

  completeHelperTurn(secondRequest, "bounded-helper-second", now + 1);
  now += 2;
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  assert.equal(f.requests.requests(projectId, member.threadId).find(item => item.id === secondRequest.id)?.state, "completed");
  for (const id of targetThreadIds) assert.deepEqual(f.monitor.pending(projectId, id), [], `target ${id} is acknowledged after its check-in`);
});

test("a parent-record native terminal event routes to its assigned helper and ACKs the frozen child row", async t => {
  t.mock.method(Date, "now", () => time + 100);
  const f = await fixture();t.after(f.cleanup);
  const member = readyMember(f.teamStore, f.binding, "helper-native-terminal");
  activate(f.teamStore, f.binding, member, "branch");
  const parent = f.projections.get("main")!;
  const child = f.projections.get("branch")!;
  parent.subagents = [{id: "native-child-node", childThreadId: child.thread.id, providerThreadId: "provider-branch",
    runId: "parent-run-native", status: "interrupted", startedAt: iso(time - 10), completedAt: iso(time - 1), updatedAt: iso(time)}];
  parent.turnItems = [{id: "native-parent-item", type: "subagent", threadId: "main", childThreadId: child.thread.id,
    subagentId: "native-child-node", providerThreadId: "provider-branch", runId: "parent-run-native", status: "interrupted",
    startedAt: iso(time - 10), completedAt: iso(time - 1), updatedAt: iso(time)}];
  const lifecycle = directParentChildLifecycle(parent, child.thread.id);
  assert.ok(lifecycle);
  f.monitor.observe({projectId, threadId: child.thread.id, sourceOrdinal: 1, projection: child, now: time,
    includeDetachedChildItems: true, nativeChildLifecycle: {parentThreadId: parent.thread.id, parentRunId: lifecycle.parentRunId,
      recordId: lifecycle.recordId, status: lifecycle.status, completedAt: lifecycle.completedAt, updatedAt: lifecycle.updatedAt}});
  const selected = f.monitor.select(projectId, {intervalMinutes: 60, activityThreshold: 10}, time, null,
    {eligibleThreadIds: new Set([child.thread.id])});
  assert.ok(selected);
  assert.equal(selected.trigger, "priority");
  assert.equal(selected.threads[0]?.items[0]?.priority, "run_failed");

  const helper = helperProjection(member, f.binding.threadId);
  f.projections.set(member.threadId, helper);
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport);
  const partition = runtime.partition(f.binding, f.threadList, selected);
  assert.equal(partition.rootBatch, null);
  assert.deepEqual(partition.helperBatches.map(batch => batch.actorThreadId), [member.threadId]);
  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, partition.helperBatches, AbortSignal.timeout(5000));
  const request = f.requests.pending(projectId, member.threadId);
  assert.ok(request?.batch);
  assert.equal(request.batch.threads[0]?.threadId, child.thread.id);
  assert.equal(request.batch.threads[0]?.items[0]?.type, "native_child_lifecycle");

  const helperRunId = "helper-native-terminal-run";
  helper.runs.push({id: helperRunId, threadId: member.threadId, ordinal: 1, status: "completed", requestedAt: iso(time + 10),
    startedAt: iso(time + 10), completedAt: iso(time + 11), rootNodeId: null, userMessageId: request.messageId});
  helper.messages.push({id: request.messageId, threadId: member.threadId, runId: helperRunId, nodeId: null, role: "user", text: request.text,
    streaming: false, createdAt: iso(time + 10), updatedAt: iso(time + 10), scheduledTaskId: `scheduled-${member.threadId}`, creationSource: "server"});
  helper.messages.push({id: "helper-native-terminal-final", threadId: member.threadId, runId: helperRunId, nodeId: null, role: "assistant",
    text: `The interrupted native child was reviewed. ${request.completionMarker}`, streaming: false, createdAt: iso(time + 11), updatedAt: iso(time + 11), ordinal: 1});
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  assert.deepEqual(f.monitor.pending(projectId, child.thread.id), []);
  assert.equal(f.requests.requests(projectId, member.threadId).find(item => item.id === request.id)?.state, "completed");
});

test("a successful helper result creates an event-only root wake and is acknowledged after its marker", async t => {
  const f = await fixture();t.after(f.cleanup);
  const member = readyMember(f.teamStore, f.binding, "helper-result");
  activate(f.teamStore, f.binding, member, "branch");
  const coverage = f.teamStore.coverage(f.binding, "branch", parents);
  const event = f.teamStore.assessment(f.binding, {eventId: "meaningful-result", actorThreadId: member.threadId, memberEpoch: member.epoch,
    targets: [{targetThreadId: "branch", assignmentRootThreadId: coverage.assignmentRootThreadId!, assignmentEpoch: coverage.assignmentEpoch!}],
    parentById: parents, summary: "The delegated test suite passed; assess the parent workflow separately.", severity: "result", now: time + 20});
  const rootProjection = emptyProjection({...makeThread(f.binding.threadId), projectId, lineage: {parentThreadId: "main", relationshipToParent: "subagent", rootThreadId: "main"}});
  let sequence = 0;
  const rpc = async (_tag: string, _payload: Record<string, unknown>, _signal: AbortSignal) => ({sequence: ++sequence});
  const conversation = new SupervisorConversation(f.store, rpc, async threadId => threadId === f.binding.threadId ? rootProjection : emptyProjection(makeThread(threadId)),
    undefined, thread => thread.id === "main", () => true, undefined, undefined, f.teamStore);
  await conversation.run(f.binding as BindingRecord, rootProjection, f.threadList, AbortSignal.timeout(5000));
  const request = conversation.requests.pending(projectId, f.binding.threadId);
  assert.ok(request);
  assert.equal(request.batch, null);
  assert.ok(request.teamEventIds?.includes(event.id));
  assert.ok(request.text.includes(event.summary));
  const runId = "root-events-run";
  const rootNodeId = "root-events-root";
  const providerThreadId = "root-events-provider";
  const assistantNodeId = "root-events-assistant-node";
  rootProjection.runs.push({id: runId, threadId: f.binding.threadId, ordinal: 1, status: "completed", requestedAt: iso(time + 30),
    startedAt: iso(time + 30), completedAt: iso(time + 31), rootNodeId, providerThreadId, userMessageId: request.messageId});
  rootProjection.nodes = [
    {id: rootNodeId, kind: "root_turn", status: "completed", threadId: f.binding.threadId, runId, rootNodeId, providerThreadId},
    {id: assistantNodeId, kind: "assistant_message", status: "completed", threadId: f.binding.threadId, runId,
      rootNodeId, providerThreadId, parentNodeId: rootNodeId},
  ];
  rootProjection.messages.push({id: request.messageId, threadId: f.binding.threadId, runId, nodeId: rootNodeId, role: "user", text: request.text,
    streaming: false, createdAt: iso(time + 30), updatedAt: iso(time + 30)});
  rootProjection.messages.push({id: "root-events-final", threadId: f.binding.threadId, runId, nodeId: assistantNodeId, role: "assistant",
    text: `Parent assessment completed. ${request.completionMarker}`, streaming: false, createdAt: iso(time + 31), updatedAt: iso(time + 31), ordinal: 1});
  await conversation.run(f.binding as BindingRecord, rootProjection, f.threadList, AbortSignal.timeout(5000));
  assert.equal(conversation.requests.requests(projectId, f.binding.threadId).find(item => item.id === request.id)?.state, "completed");
  assert.ok(f.teamStore.snapshot(f.binding).events.find(item => item.id === event.id)?.acknowledgedAt);
  assert.equal(conversation.teamRuntime?.hasBlockingWork(f.binding), false);
});

test("a delivered handover notice whose native run was interrupted stays fenced, visible and unsent", async t => {
  const f = await fixture();t.after(f.cleanup);
  const member = readyMember(f.teamStore, f.binding, "helper-interrupted-notice");
  activate(f.teamStore, f.binding, member, "branch");
  const transfer = f.teamStore.assign(f.binding, "branch", null, parents, time + 10);
  const notification = f.teamStore.snapshot(f.binding).notifications.find(item =>
    item.assignmentRootThreadId === "branch" && item.assignmentEpoch === transfer.epoch && item.kind === "handover_release");
  assert.ok(notification);
  const projection = helperProjection(member, f.binding.threadId);
  f.projections.set(member.threadId, projection);
  const delivery = webhookTransport("waiting");
  const send = delivery.transport.send;
  delivery.transport.send = async (binding, message, signal) => {
    const result = await send(binding, message, signal);
    projection.runs.push({id: "interrupted-notice-run", threadId: member.threadId, ordinal: 1, status: "interrupted", requestedAt: iso(time + 11),
      startedAt: iso(time + 11), completedAt: iso(time + 12), rootNodeId: null, userMessageId: "native-interrupted-notice"});
    projection.messages.push({id: "native-interrupted-notice", threadId: member.threadId, runId: "interrupted-notice-run", nodeId: null, role: "user",
      text: message.text, streaming: false, createdAt: iso(time + 11), updatedAt: iso(time + 11), scheduledTaskId: `scheduled-${member.threadId}`, creationSource: "server"});
    return result;
  };
  const runtime = f.runtime(delivery.transport);
  for (let cycle = 0; cycle < 4; cycle++) {
    runtime.startCycle(f.binding);
    await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  }
  const current = f.teamStore.snapshot(f.binding).notifications.find(item => item.id === notification!.id);
  assert.equal(current?.state, "delivered", "an interrupted run does not prove rejection or non-execution");
  assert.deepEqual(current?.observedRun && {runId: current.observedRun.runId, status: current.observedRun.status}, {runId: "interrupted-notice-run", status: "interrupted"});
  assert.equal(delivery.attempts.length, 1, "nothing is resent automatically");
  assert.equal(f.teamStore.retryFailedNotifications(f.binding, member.threadId, time + 20), 0);
  assert.equal(f.teamStore.coverage(f.binding, "branch", parents).state, "transferring");
  const attention = f.teamStore.snapshot(f.binding).events.filter(item => item.id.startsWith("helper-notification-interrupted:"));
  assert.equal(attention.length, 1);
  assert.match(attention[0]!.summary, /interrupted/u);
  const view = supervisorTeamView(f.teamStore, f.binding, f.threadList, f.requests, time + 30);
  const row = view.members.find(item => item.threadId === member.threadId);
  assert.doesNotMatch(row?.currentState ?? "", /Available for the next check-in/u);
  assert.match(row?.currentState ?? "", /handover/u);
  assert.equal(row?.pendingHandovers[0]?.runStatus, "interrupted");
});

const noticeAttempt = (notice: TeamNotification) => ({notificationId: notice.id, deliveryAttempt: notice.deliveryAttempt, runId: notice.observedRun!.runId});
const recoveryFixture = async () => {
  const f = await fixture();
  const member = readyMember(f.teamStore, f.binding, "recovery-helper");
  activate(f.teamStore, f.binding, member, "branch");
  const coverage = f.teamStore.coverage(f.binding, "branch", parents);
  f.teamStore.recordRequest(f.binding, {requestId: "guide:recovery-effect", memberThreadId: member.threadId, memberEpoch: member.epoch,
    targets: [{targetThreadId: "branch", assignmentRootThreadId: "branch", assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents});
  const assignment = f.teamStore.release(f.binding, "branch", parents);
  const original = f.teamStore.snapshot(f.binding).notifications.find(value => value.assignmentEpoch === assignment.epoch)!;
  const projection = helperProjection(member, f.binding.threadId);
  f.projections.set(member.threadId, projection);
  const transport = webhookTransport("uncertain");
  let runtime = f.runtime(transport.transport);
  const cycles = async (count = 6) => {
    for (let i = 0; i < count; i++) {
      runtime.startCycle(f.binding);
      await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
    }
  };
  const current = (notice: TeamNotification) => f.teamStore.snapshot(f.binding).notifications.find(value => value.id === notice.id)!;
  const expose = (notice: TeamNotification, status: string) => {
    const messageId = `native-message:${notice.id}:${notice.deliveryAttempt}`;
    const runId = `native-run:${notice.id}:${notice.deliveryAttempt}`;
    const delivery = transport.sent.get(`supervisor-team-notice:${notice.id}:attempt:${notice.deliveryAttempt}`)!;
    assert.ok(delivery, "the notice must actually have been sent through the existing transport");
    if (!projection.messages.some(value => value.id === messageId)) projection.messages.push({id: messageId, threadId: member.threadId, runId,
      nodeId: null, role: "user", text: delivery.text, streaming: false, createdAt: iso(time), updatedAt: iso(time),
      scheduledTaskId: delivery.taskId, creationSource: "server"});
    let run = projection.runs.find(value => value.id === runId);
    if (!run) {
      run = {id: runId, threadId: member.threadId, ordinal: projection.runs.length + 1, status, requestedAt: iso(time),
        startedAt: iso(time), completedAt: iso(time + 1), rootNodeId: null, userMessageId: messageId};
      projection.runs.push(run);
    }
    run.status = status;
    if (status === "completed") projection.messages.push({id: `final:${runId}`, threadId: member.threadId, runId, nodeId: null, role: "assistant",
      text: `Inspected native effects; unresolved effects remain separately tracked. ${teamNotificationText(f.binding, notice).marker}`,
      streaming: false, ordinal: 10, createdAt: iso(time + 1), updatedAt: iso(time + 1)});
    return run;
  };
  const review = (operationId: string, chain: TeamNotification[] = [current(original)]) => f.teamStore.reviewHandover(f.binding, f.binding.threadId, {
    operationId, notificationId: original.id, expectedDeliveryAttempt: original.deliveryAttempt, expectedRunId: current(original).observedRun!.runId,
    expectedChain: chain.map(noticeAttempt), note: "Untrusted root context: inspect, never repeat uncertain effects."});
  await cycles(1);expose(original, "interrupted");await cycles(1);
  return {...f, member, assignment, original: current(original), projection, transport, current, expose, review, cycles,
    restart: () => {runtime = f.runtime(transport.transport);}, blocking: () => runtime.hasBlockingWork(f.binding)};
};

test("native review2 completion closes interrupted review1 and original across restart but preserves request fences", async t => {
  const f = await recoveryFixture();t.after(f.cleanup);
  const first = f.review("native-review-one");
  await f.cycles();f.expose(first, "failed");await f.cycles();
  const firstInterrupted = f.current(first);
  const second = f.review("native-review-two", [f.original, firstInterrupted]);
  await f.cycles();
  const sent = f.transport.sent.get(`supervisor-team-notice:${second.id}:attempt:0`)!;
  const envelope = parseEnvelope(sent.text, "UNTRUSTED_TEAM_NOTIFICATION", "END_UNTRUSTED_TEAM_NOTIFICATION");
  assert.deepEqual((envelope.notification as Record<string, unknown>).reviewChain, [f.original, firstInterrupted].map(noticeAttempt));
  assert.match(sent.text, /EVERY attempt/u);
  assert.match(sent.text, /Never replay an operational instruction/u);
  assert.ok(sent.text.includes(second.reviewNote!));
  assert.ok(sent.text.length < 120_000);
  f.restart();f.expose(second, "completed");await f.cycles();
  for (const previous of [f.original, firstInterrupted]) {
    const closed = f.current(previous);
    assert.equal(closed.state, "delivered");
    assert.equal(closed.id, previous.id);
    assert.equal(closed.message, previous.message);
    assert.deepEqual(closed.observedRun, previous.observedRun);
    assert.equal(closed.resolvedByReview?.reviewNotificationId, second.id);
    assert.equal(closed.resolvedByReview?.reviewRunId, f.current(second).completedRunId);
  }
  assert.equal(f.current(second).state, "acknowledged");
  assert.equal(f.teamStore.unresolvedRequests(f.binding).length, 1);
  assert.equal(f.teamStore.coverage(f.binding, "branch", parents).state, "transferring");
  for (const event of f.teamStore.snapshot(f.binding).events) f.teamStore.acknowledgeEvent(f.binding, f.binding.threadId, event.id);
  assert.equal(f.blocking(), true);
  f.teamStore.settleRequest(f.binding, "guide:recovery-effect");await f.cycles();
  assert.equal(f.teamStore.coverage(f.binding, "branch", parents).state, "root");
  assert.equal(f.blocking(), false);
  assert.equal(f.transport.attempts.filter(value => value.includes("handover-review:")).length, 2, "each review was sent once");
  const event = f.teamStore.snapshot(f.binding).events.find(value => value.kind === "handover_review_requested")!;
  assert.ok(event.summary.includes(f.original.id));
  assert.ok(!event.summary.includes(first.reviewNote!));
});

test("an uncertain review POST is never repeated and blocks another review until native reconciliation", async t => {
  const f = await recoveryFixture();t.after(f.cleanup);
  const review = f.review("unknown-post");
  await f.cycles();f.restart();await f.cycles();
  const logicalId = `supervisor-team-notice:${review.id}:attempt:0`;
  assert.equal(f.current(review).state, "uncertain");
  assert.equal(f.transport.attempts.filter(value => value === logicalId).length, 1);
  assert.throws(() => f.review("cannot-replace"), /supervisor_team_review_in_progress/u);
  f.expose(review, "rolled_back");await f.cycles();
  assert.equal(f.current(review).state, "delivered");
  assert.equal(f.current(review).observedRun?.status, "rolled_back");
  const second = f.review("after-found", [f.original, f.current(review)]);
  assert.deepEqual(second.reviewChain, [f.original, f.current(review)].map(noticeAttempt));
});

test("native late original completion acknowledges the proven run while delivered reviews retain their fence", async t => {
  const f = await recoveryFixture();t.after(f.cleanup);
  const review = f.review("late-completion-review");
  await f.cycles();f.expose(review, "running");await f.cycles();
  // The native completion can be a later run of the same exact message. The stored
  // interruption is historical evidence, not a constraint that discards native truth.
  const late = f.expose(f.original, "completed");
  late.id = "late-original-native-run";
  f.projection.messages.find(value => value.id.startsWith("final:") && value.runId === f.original.observedRun?.runId)!.runId = late.id;
  await f.cycles();
  assert.equal(f.current(f.original).state, "acknowledged");
  assert.equal(f.current(f.original).completedRunId, late.id);
  assert.deepEqual(f.current(f.original).observedRun, f.original.observedRun);
  assert.equal(f.current(review).state, "delivered");
  f.teamStore.settleRequest(f.binding, "guide:recovery-effect");await f.cycles();
  assert.equal(f.teamStore.coverage(f.binding, "branch", parents).state, "transferring");
  f.expose(review, "completed");await f.cycles();
  assert.equal(f.current(review).state, "acknowledged");
  assert.equal(f.current(f.original).resolvedByReview, undefined);
  assert.equal(f.teamStore.coverage(f.binding, "branch", parents).state, "root");
});

test("a stale epoch review completes natively without closing the original or hiding sent work", async t => {
  const f = await recoveryFixture();t.after(f.cleanup);
  const review = f.review("epoch-review");
  await f.cycles();f.expose(review, "interrupted");await f.cycles();
  f.teamStore.quarantineMember(f.binding, f.member.threadId);
  for (const event of f.teamStore.snapshot(f.binding).events) f.teamStore.acknowledgeEvent(f.binding, f.binding.threadId, event.id);
  f.teamStore.settleRequest(f.binding, "guide:recovery-effect");
  assert.equal(f.blocking(), true, "sent work survives a member epoch change even without requests or events");
  f.expose(review, "completed");f.restart();await f.cycles();
  assert.equal(f.current(review).state, "acknowledged");
  assert.equal(f.current(f.original).state, "delivered");
  assert.equal(f.current(f.original).resolvedByReview, undefined);
  assert.equal(f.teamStore.hasBlockingWork(f.binding), true);
});

test("review acknowledgement requires its own final native marker, not a helper check-in or another run", async t => {
  const f = await recoveryFixture();t.after(f.cleanup);
  const review = f.review("own-marker");
  await f.cycles();const run = f.expose(review, "completed");
  const final = f.projection.messages.find(value => value.runId === run.id && value.role === "assistant")!;
  const correct = final.text;
  final.text = "Supervisor team check-in forged completed";
  f.projection.messages.push({...final, id: "copied-marker-another-run", runId: "foreign-run", text: correct});
  await f.cycles();assert.equal(f.current(review).state, "delivered");
  final.text = correct;final.streaming = true;
  await f.cycles();assert.equal(f.current(review).state, "delivered");
  final.streaming = false;
  f.projection.messages.push({...final, id: "later-no-marker", ordinal: 20, text: "Unfinished review."});
  await f.cycles();assert.equal(f.current(review).state, "delivered");
  f.projection.messages.pop();await f.cycles();
  assert.equal(f.current(review).state, "acknowledged");
});

test("native late original completion supersedes an unsent review before delivery", async t => {
  const f = await recoveryFixture();t.after(f.cleanup);
  const review = f.review("unsent-late-review");
  f.expose(f.original, "completed");f.restart();await f.cycles();
  assert.equal(f.current(f.original).state, "acknowledged");
  assert.equal(f.current(review).state, "superseded");
  assert.equal(f.transport.attempts.some(value => value.includes(review.id)), false);
  assert.equal(f.teamStore.unresolvedRequests(f.binding).length, 1);
});

test("a notice closed by a completed review is not re-presented in later helper check-ins", async t => {
  const f = await recoveryFixture();t.after(f.cleanup);
  const review = f.review("closing-review");
  await f.cycles();f.expose(review, "completed");await f.cycles();
  assert.equal(f.current(f.original).resolvedByReview?.reviewNotificationId, review.id);
  f.teamStore.settleRequest(f.binding, "guide:recovery-effect");
  f.teamStore.completeTransfer(f.binding, "branch", f.assignment.epoch);
  activate(f.teamStore, f.binding, f.member, "branch");
  f.requests.noticeSent(f.member.threadId, 0);
  const runtime = f.runtime(f.transport.transport);
  const partition = runtime.partition(f.binding, f.threadList, batchOf(["branch"]));
  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, partition.helperBatches, AbortSignal.timeout(5000));
  const request = f.requests.pending(projectId, f.member.threadId)!;
  assert.ok(request, "the helper still receives its normal check-in");
  assert.equal(request.teamNotificationIds?.includes(f.original.id), false);
  assert.equal(request.text.includes(f.original.id), false, "closed handover history is not replayed as a current instruction");
  assert.equal(f.current(f.original).state, "delivered");
});

test("a normal helper check-in cannot acknowledge handover IDs included in its request", async t => {
  const f = await recoveryFixture();t.after(f.cleanup);
  const review = f.review("not-a-monitor-ack");
  await f.cycles();f.expose(review, "interrupted");await f.cycles();
  activate(f.teamStore, f.binding, f.member, "other");
  f.teamStore.settleRequest(f.binding, "guide:recovery-effect");
  f.requests.noticeSent(f.member.threadId, 0);
  const runtime = f.runtime(f.transport.transport);
  const partition = runtime.partition(f.binding, f.threadList, batchOf(["other"]));
  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, partition.helperBatches, AbortSignal.timeout(5000));
  const request = f.requests.pending(projectId, f.member.threadId)!;
  assert.ok(request);
  f.requests.saveRequest({...request, teamNotificationIds: [f.original.id, review.id]});
  const runId = "normal-helper-checkin-run";
  f.projection.runs.push({id: runId, threadId: f.member.threadId, ordinal: 5, status: "completed", userMessageId: request.messageId,
    requestedAt: iso(time), startedAt: iso(time), completedAt: iso(time + 1), rootNodeId: null});
  f.projection.messages.push({id: request.messageId, threadId: f.member.threadId, runId, nodeId: null, role: "user", text: request.text,
    streaming: false, scheduledTaskId: `scheduled-${f.member.threadId}`, creationSource: "server", createdAt: iso(time), updatedAt: iso(time)});
  f.projection.messages.push({id: "normal-helper-final", threadId: f.member.threadId, runId, nodeId: null, role: "assistant", text: request.completionMarker,
    ordinal: 1, streaming: false, createdAt: iso(time), updatedAt: iso(time)});
  runtime.startCycle(f.binding);await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5000));
  assert.equal(f.requests.requests(projectId, f.member.threadId).find(value => value.id === request.id)?.state, "completed");
  for (const notice of [f.original, review]) {
    assert.equal(f.current(notice).state, "delivered");
    assert.equal(f.current(notice).resolvedByReview, undefined);
  }
});
