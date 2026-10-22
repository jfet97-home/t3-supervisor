import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it, type TestContext } from "vitest";
import { after, mockMethod } from "./support/node-test.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { GuidanceStore } from "../src/guidance-store.js";
import { ProjectSupervisorMonitorStore } from "../src/supervisor-monitor-store.js";
import type { SupervisorMonitorBatch, SupervisorMonitorThreadBatch } from "../src/supervisor-monitor.js";
import { SupervisorConversationStore } from "../src/supervisor-conversation-store.js";
import { defaultSupervisorModel, ProjectSupervisorStore, type BindingRecord } from "../src/project-supervisor-store.js";
import { SupervisorTeamStore, type TeamBinding, type TeamMember, type TeamNotification } from "../src/supervisor-team-store.js";
import { SupervisorTeamRuntime } from "../src/supervisor-team-runtime.js";
import { SupervisorHelperTransport, type SupervisorHelperDeliveryTransport } from "../src/supervisor-helper-transport.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { withDeadline } from "./support/c1-loopback.js";

const time = Date.parse("2026-10-16T10:00:00.000Z");
const iso = (value: number) => new Date(value).toISOString();
const uncertainError = "Helper delivery is uncertain; its original native identity is retained.";

// real SupervisorHelperTransport over a fake native scheduler, copied from the baseline transport suite; fetch is held per test
const transportTeam = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "c1-team-transport-"));
  const opened: GuidanceStore[] = [];
  const db = new GuidanceStore(directory);opened.push(db);
  const store = new ProjectSupervisorStore(db, new Set());
  db.db.prepare("INSERT INTO meta VALUES(?,?)").run('supervisor_control:"p"', JSON.stringify({enabled: true, manual: true, generation: 1}));
  const binding = {...store.reserve("p", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const};store.setBinding(binding);
  const team = new SupervisorTeamStore(store);
  team.registerMember(binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "boot"});
  const helper: Projection = {thread: {id: "helper", projectId: "p", title: "helper", modelSelection: defaultSupervisorModel,
    runtimeMode: "full-access", interactionMode: "default", lineage: {parentThreadId: binding.threadId, relationshipToParent: "subagent"}},
  runs: [], messages: [], runtimeRequests: []};
  const tasks: Record<string, unknown>[] = [];
  let holdList: (() => Promise<void> | null) | null = null;
  const rpc = async (tag: string, input: Record<string, unknown>) => {
    if (tag === "scheduledTasks.list") {const held = holdList?.() ?? null;if (held) await held;return {tasks};}
    if (tag === "scheduledTasks.upsert") {
      const task = {...input, createdAt: "2026-10-16T10:00:00Z", webhook: {path: "/api/hooks/fixture/fixture-only-token", url: null}};
      tasks.splice(0, tasks.length, task);return {task};
    }
    if (tag === "scheduledTasks.listWebhookDeliveries") return {deliveries: []};
    throw new Error("unexpected_rpc");
  };
  const posts: string[] = [];
  const pending: Array<PromiseWithResolvers<Response>> = [];
  let mode: "abort" | "crash" | "accept" = "accept";
  const reached = Promise.withResolvers<void>();
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    posts.push(String(init?.body));
    reached.resolve();
    if (mode === "accept") return Response.json({deliveryId: `delivery-${posts.length}`}, {status: 202});
    if (mode === "crash") {const never = Promise.withResolvers<Response>();pending.push(never);return never.promise;}
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), {once: true}));
  };
  after(t, async () => {
    reached.resolve();
    for (const never of pending) never.reject(new Error("abandoned POST"));
    for (const guidance of opened) try {guidance.close();} catch { /* closed by a simulated crash */ }
    await rm(directory, {recursive: true, force: true});
  });
  // the baseline transport suite's team composition: a ready helper assigned the operational branch
  const main = binding.mainThreadId;
  const member = team.snapshot(binding).members.find(value => value.threadId === "helper")!;
  const ready = team.markReady(binding, member.threadId, member.epoch);
  const operational: ThreadInfo = {id: "branch", title: "branch", projectId: "p", lineage: {parentThreadId: main, relationshipToParent: "subagent", rootThreadId: main}};
  const parents = new Map<string, string | null>([[main, null], [operational.id, main], [ready.threadId, main]]);
  const assignment = team.assign(binding, operational.id, ready.threadId, parents);
  for (const notice of team.snapshot(binding).notifications.filter(value => value.assignmentEpoch === assignment.epoch)) {
    team.updateNotificationDelivery(binding, binding.threadId, notice.id, "sending");
    team.updateNotificationDelivery(binding, binding.threadId, notice.id, "delivered");
    team.acknowledgeNotification(binding, notice.recipientThreadId, notice.id, notice.memberEpoch);
  }
  team.completeTransfer(binding, operational.id, assignment.epoch);
  const threads = [helper.thread, operational, {id: main, title: main, projectId: "p", lineage: {parentThreadId: null, relationshipToParent: null, rootThreadId: main}} as ThreadInfo];
  const compose = (guidance: GuidanceStore, projectStore: ProjectSupervisorStore, teamStore: SupervisorTeamStore,
    transportProjection: (threadId: string, signal: AbortSignal) => Promise<Projection> = async () => helper, supervisionStopped?: () => boolean) => {
    const requests = new SupervisorConversationStore(guidance);
    const monitor = new ProjectSupervisorMonitorStore(guidance);
    const transport = new SupervisorHelperTransport({store: projectStore, rpc, baseUrl: "http://127.0.0.1:3773", projection: transportProjection, fetch});
    const runtime = new SupervisorTeamRuntime({store: projectStore, teamStore, requests, monitor, rpc, helperTransport: transport, projection: async () => helper,
      ...(supervisionStopped ? {supervisionStopped} : {})});
    return {requests, monitor, transport, runtime};
  };
  const detectedAt = Date.now();
  const item = {id: "run:branch", readItemId: null, type: "run_finished", status: "completed", ordinal: 1, detectedAt, version: "branch-v1", priority: "run_finished" as const};
  const thread: SupervisorMonitorThreadBatch = {threadId: "branch", trigger: "priority", finalizedActivityCount: 1, pendingItemCount: 1, oldestAt: detectedAt,
    priority: true, priorityKinds: ["run_finished"], saturated: false, untrackedCount: 0, items: [item], previewItems: [item]};
  const batch: SupervisorMonitorBatch = {projectId: "p", createdAt: detectedAt, trigger: "priority", finalizedActivityCount: 1, pendingItemCount: 1, truncated: false, threads: [thread]};
  const first = compose(db, store, team);
  const helperBatches = first.runtime.partition(binding, threads, batch).helperBatches;
  assert.equal(helperBatches.length, 1);
  const receipts = (guidance: GuidanceStore) => guidance.db.prepare("SELECT document FROM supervisor_helper_deliveries").all()
    .map(row => JSON.parse(String(row.document)) as Record<string, unknown>);
  return {db, store, team, binding, helper, threads, helperBatches, posts, reached: reached.promise, compose, receipts, ...first,
    setMode: (next: typeof mode) => {mode = next;},
    holdList: (gate: Promise<void>) => {
      const listed = Promise.withResolvers<void>();
      holdList = () => {holdList = null;listed.resolve();return gate;};
      return withDeadline(listed.promise, 3_000, "held channel read");
    },
    reopen: () => {
      const guidance = new GuidanceStore(directory);opened.push(guidance);
      const projectStore = new ProjectSupervisorStore(guidance, new Set());
      const teamStore = new SupervisorTeamStore(projectStore);
      return {guidance, store: projectStore, team: teamStore, ...compose(guidance, projectStore, teamStore)};
    }};
};

it("CT-TRUN-01: aborting the helper POST after the 'sending' commit makes the request 'uncertain', keeps the receipt 'posting' and never posts again", {timeout: 10_000}, async t => {
  const f = await transportTeam(t);
  f.setMode("abort");
  const controller = new AbortController();
  f.runtime.startCycle(f.binding);
  const running = f.runtime.runHelperBatch(f.binding, f.threads, f.helperBatches, controller.signal);
  await withDeadline(f.reached, 3_000, "POST");
  const sending = f.requests.pending("p", "helper");
  assert.ok(sending);
  assert.equal(sending.state, "sending");
  assert.deepEqual(f.receipts(f.db).map(receipt => [receipt.messageId, receipt.state, receipt.text]), [[sending.messageId, "posting", sending.text]]);
  controller.abort();
  await withDeadline(running, 3_000, "aborted batch");
  assert.deepEqual(f.requests.pending("p", "helper"), {...sending, state: "uncertain", error: uncertainError});
  assert.equal(f.team.unresolvedRequests(f.binding).find(request => request.requestId === sending.id)?.state, "uncertain");
  assert.equal(f.receipts(f.db)[0]?.state, "posting");

  f.setMode("accept");
  f.runtime.startCycle(f.binding);
  await f.runtime.reconcile(f.binding, f.threads, AbortSignal.timeout(3_000));
  const restarted = f.reopen();
  restarted.runtime.startCycle(f.binding);
  await restarted.runtime.reconcile(f.binding, f.threads, AbortSignal.timeout(3_000));
  assert.equal(restarted.requests.pending("p", "helper")?.state, "uncertain");
  assert.equal(f.receipts(restarted.guidance)[0]?.state, "posting");
  assert.equal(f.posts.length, 1);
});

it("CT-TRUN-01: a crash during the helper POST keeps the request 'sending'; a new process marks it 'uncertain' and never posts again", {timeout: 10_000}, async t => {
  const f = await transportTeam(t);
  f.setMode("crash");
  f.runtime.startCycle(f.binding);
  const abandoned = f.runtime.runHelperBatch(f.binding, f.threads, f.helperBatches, AbortSignal.timeout(5_000)).then(() => "settled", () => "failed");
  after(t, () => withDeadline(abandoned, 3_000, "abandoned batch"));
  await withDeadline(f.reached, 3_000, "POST");
  const sending = f.requests.pending("p", "helper");
  assert.ok(sending?.state === "sending");
  f.db.close();

  f.setMode("accept");
  const restarted = f.reopen();
  assert.deepEqual(restarted.requests.pending("p", "helper"), sending, "reopening performs no recovery");
  restarted.runtime.startCycle(f.binding);
  await restarted.runtime.reconcile(f.binding, f.threads, AbortSignal.timeout(3_000));
  assert.deepEqual(restarted.requests.pending("p", "helper"), {...sending, state: "uncertain",
    error: "The helper request may have been accepted; its original native identity is retained."});
  restarted.runtime.startCycle(f.binding);
  await restarted.runtime.reconcile(f.binding, f.threads, AbortSignal.timeout(3_000));
  assert.equal(restarted.requests.pending("p", "helper")?.state, "uncertain");
  assert.deepEqual(f.receipts(restarted.guidance).map(receipt => receipt.state), ["posting"]);
  assert.equal(f.posts.length, 1);
});

it("CT-TRUN-02: a quarantine committed during the transport's helper read leaves no receipt and no POST and fails only its own request", {timeout: 10_000}, async t => {
  const f = await transportTeam(t);
  const gate = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  after(t, () => {gate.resolve();held.resolve();});
  const composed = f.compose(f.db, f.store, f.team, async () => {held.resolve();await gate.promise;return f.helper;});
  composed.runtime.startCycle(f.binding);
  const running = composed.runtime.runHelperBatch(f.binding, f.threads, f.helperBatches, AbortSignal.timeout(5_000));
  await withDeadline(held.promise, 3_000, "transport helper read");
  const request = composed.requests.pending("p", "helper");
  assert.ok(request?.state === "sending");
  f.team.quarantineMember(f.binding, "helper");
  gate.resolve();
  await withDeadline(running, 3_000, "batch");
  assert.deepEqual(f.receipts(f.db), []);
  assert.equal(f.posts.length, 0);
  const failed = composed.requests.requests("p", "helper").find(value => value.id === request.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.error, "The helper lost its authority before this check-in was posted; nothing was posted and pending activity is retained.");
  assert.equal(f.team.unresolvedRequests(f.binding).some(value => value.requestId === request.id), false);
});

it("CT-TRUN-02: a stop committed during the transport's channel read leaves no receipt and no POST", {timeout: 10_000}, async t => {
  const f = await transportTeam(t);
  let stopped = false;
  const gate = Promise.withResolvers<void>();
  after(t, () => gate.resolve());
  const composed = f.compose(f.db, f.store, f.team, undefined, () => stopped);
  const listed = f.holdList(gate.promise);
  composed.runtime.startCycle(f.binding);
  const running = composed.runtime.runHelperBatch(f.binding, f.threads, f.helperBatches, AbortSignal.timeout(5_000));
  await listed;
  const request = composed.requests.pending("p", "helper");
  assert.ok(request?.state === "sending");
  stopped = true;
  gate.resolve();
  await withDeadline(running, 3_000, "batch");
  assert.deepEqual(f.receipts(f.db), []);
  assert.equal(f.posts.length, 0);
  assert.equal(composed.requests.requests("p", "helper").find(value => value.id === request.id)?.state, "failed");
  assert.equal(f.team.unresolvedRequests(f.binding).some(value => value.requestId === request.id), false);
});

// the baseline team-runtime suite's fixture and fake webhook transport
const projectId = "project-team";
const parents = new Map<string, string | null>([["main", null], ["branch", "main"], ["leaf", "branch"], ["other", "main"]]);
const makeThread = (id: string, parentThreadId: string | null = null, relationshipToParent: string | null = null): ThreadInfo => ({
  id, title: id, projectId, lineage: {parentThreadId, relationshipToParent, rootThreadId: parentThreadId ? "main" : id},
});
const emptyProjection = (thread: ThreadInfo): Projection => ({thread, runs: [], messages: [], nodes: [], turnItems: [], providerTurns: [], runtimeRequests: []});

const webhookTransport = () => {
  const sent = new Map<string, {threadId: string; commandId: string; text: string; taskId: string}>();
  const calls: string[] = [];
  const transport: SupervisorHelperDeliveryTransport = {
    send: async (_binding, message) => {
      calls.push(`send:${message.messageId}`);
      sent.set(message.messageId, {threadId: message.threadId, commandId: message.commandId, text: message.text, taskId: `scheduled-${message.threadId}`});
      return "waiting";
    },
    hasDelivery: (_binding, message) => {
      calls.push(`hasDelivery:${message.messageId}`);
      const delivery = sent.get(message.messageId);
      return Boolean(delivery && delivery.threadId === message.threadId && delivery.commandId === message.commandId && delivery.text === message.text);
    },
    reconcileDelivery: async (_binding, message) => {calls.push(`reconcile:${message.messageId}`);return sent.has(message.messageId) ? "uncertain" : "absent";},
    receiptText: (_binding, messageId) => {calls.push(`receiptText:${messageId}`);return sent.get(messageId)?.text ?? null;},
    matchesMessage: (_binding, logicalId, text, native) => {
      const delivery = sent.get(logicalId);
      return Boolean(delivery && delivery.text === text && native.threadId === delivery.threadId && native.text === text &&
        native.scheduledTaskId === delivery.taskId && native.creationSource === "server");
    },
    retire: async (_binding, threadId) => {calls.push(`retire:${threadId}`);return true;},
  };
  return {transport, sent, calls};
};

const teamFixture = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "c1-team-runtime-"));
  const opened: GuidanceStore[] = [];
  const guidance = new GuidanceStore(directory);opened.push(guidance);
  const store = new ProjectSupervisorStore(guidance, new Set());
  store.reserve(projectId, "main", "main", defaultSupervisorModel, 0, 1);
  const binding = store.binding(projectId, "main")!;
  const teamStore = new SupervisorTeamStore(store);
  const requests = new SupervisorConversationStore(guidance);
  const monitor = new ProjectSupervisorMonitorStore(guidance);
  const threadList = [makeThread("main"), makeThread("branch", "main", "subagent"), makeThread("leaf", "branch", "subagent"), makeThread("other", "main", "subagent")];
  const projections = new Map<string, Projection>(threadList.map(thread => [thread.id, emptyProjection(thread)]));
  const reads: string[] = [];
  const runtime = (helperTransport?: SupervisorHelperDeliveryTransport, now?: () => number, stores = {store, teamStore, requests, monitor}) =>
    new SupervisorTeamRuntime({...stores, rpc: null, projection: async threadId => {reads.push(threadId);return projections.get(threadId) ?? emptyProjection(makeThread(threadId));},
      ...(helperTransport ? {helperTransport} : {}), ...(now ? {now} : {})});
  after(t, async () => {
    for (const db of opened) try {db.close();} catch { /* already closed */ }
    await rm(directory, {recursive: true, force: true});
  });
  return {guidance, store, binding, teamStore, requests, monitor, threadList, projections, runtime, reads,
    reopen: () => {
      const reopened = new GuidanceStore(directory);opened.push(reopened);
      const reopenedStore = new ProjectSupervisorStore(reopened, new Set());
      return {guidance: reopened, store: reopenedStore, teamStore: new SupervisorTeamStore(reopenedStore),
        requests: new SupervisorConversationStore(reopened), monitor: new ProjectSupervisorMonitorStore(reopened)};
    }};
};

const readyMember = (team: SupervisorTeamStore, binding: TeamBinding, threadId: string, now = time): TeamMember => {
  const registered = team.registerMember(binding, {threadId, taskId: `task-${threadId}`, bootstrapRunId: `bootstrap-${threadId}`, now});
  return team.markReady(binding, threadId, registered.epoch, now + 1);
};

const activate = (team: SupervisorTeamStore, binding: TeamBinding, member: TeamMember, subtreeRoot: string, now = time): void => {
  const assignment = team.assign(binding, subtreeRoot, member.threadId, parents, now);
  for (const notice of team.snapshot(binding).notifications.filter(item => item.assignmentRootThreadId === subtreeRoot && item.assignmentEpoch === assignment.epoch)) {
    team.updateNotificationDelivery(binding, binding.threadId, notice.id, "sending", now + 1);
    team.updateNotificationDelivery(binding, binding.threadId, notice.id, "delivered", now + 2);
    team.acknowledgeNotification(binding, notice.recipientThreadId, notice.id, notice.memberEpoch, now + 3);
  }
  team.completeTransfer(binding, subtreeRoot, assignment.epoch, now + 4);
};

const deliverNote = (teamStore: SupervisorTeamStore, binding: TeamBinding, member: TeamMember, id: string, message: string, at: number): TeamNotification => {
  const note = teamStore.note(binding, {eventId: `${id}-event`, notificationId: id, memberThreadId: member.threadId, memberEpoch: member.epoch, message, now: at});
  teamStore.updateNotificationDelivery(binding, binding.threadId, note.id, "sending", at + 1);
  return teamStore.updateNotificationDelivery(binding, binding.threadId, note.id, "delivered", at + 2);
};

const helperProjection = (member: TeamMember, rootThreadId: string): Projection => emptyProjection({
  ...makeThread(member.threadId, rootThreadId, "subagent"), lineage: {parentThreadId: rootThreadId, relationshipToParent: "subagent", rootThreadId},
});

// one completed command in the operational branch, observed into the real monitor tables and selected as a batch
const observedBranchBatch = (f: Awaited<ReturnType<typeof teamFixture>>): SupervisorMonitorBatch => {
  const op = emptyProjection(makeThread("branch", "main", "subagent"));
  op.runs.push({id: "operational-run", threadId: "branch", ordinal: 1, status: "completed", requestedAt: iso(time), startedAt: iso(time),
    completedAt: iso(time + 1), rootNodeId: "root-node", providerThreadId: "provider-branch"});
  op.nodes = [
    {id: "root-node", kind: "root_turn", status: "completed", threadId: "branch", runId: "operational-run", rootNodeId: "root-node", providerThreadId: "provider-branch"},
    {id: "tool-node", kind: "tool_call", status: "completed", threadId: "branch", runId: "operational-run", rootNodeId: "root-node", providerThreadId: "provider-branch", parentNodeId: "root-node"},
  ];
  op.turnItems = [{id: "turn-item:command", threadId: "branch", runId: "operational-run", nodeId: "tool-node", type: "command_execution", status: "completed",
    ordinal: 1, completedAt: iso(time + 1), updatedAt: iso(time + 1)}];
  f.monitor.observe({projectId, threadId: "branch", sourceOrdinal: 0, projection: op, now: time + 2, includeDetachedChildItems: true});
  const selected = f.monitor.select(projectId, {intervalMinutes: 5, activityThreshold: 1}, time + 3, null, {eligibleThreadIds: new Set(["branch"])});
  assert.ok(selected);
  return selected;
};

const teamState = (db: DatabaseSync, requestId: string, noteId: string) => ({
  request: (JSON.parse(String(db.prepare("SELECT document FROM supervisor_conversation_requests WHERE id=?").get(requestId)?.document)) as {state: string}).state,
  teamRequest: String(db.prepare("SELECT state FROM supervisor_team_requests WHERE request_id=?").get(requestId)?.state),
  note: (JSON.parse(String(db.prepare("SELECT document FROM supervisor_team_notifications WHERE id=?").get(noteId)?.document)) as {state: string}).state,
  acknowledged: db.prepare("SELECT item_id FROM supervisor_monitor_items WHERE project_id=? AND thread_id='branch' AND reviewed_version=version").all(projectId).length,
});

it("CT-TRUN-03: a failure inside the completion transaction rolls back request completion, monitor and note acknowledgements, retryable after reopen", {timeout: 10_000}, async t => {
  const f = await teamFixture(t);
  mockMethod(t, Date, "now", () => time + 10);
  const member = readyMember(f.teamStore, f.binding, "helper-rollback");
  activate(f.teamStore, f.binding, member, "branch");
  const note = deliverNote(f.teamStore, f.binding, member, "rollback-note", "Keep the parent informed.", time + 5);
  const batch = observedBranchBatch(f);
  const projection = helperProjection(member, f.binding.threadId);
  f.projections.set(member.threadId, projection);
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport);
  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, runtime.partition(f.binding, f.threadList, batch).helperBatches, AbortSignal.timeout(5_000));
  const request = f.requests.pending(projectId, member.threadId);
  assert.ok(request?.state === "waiting" && request.batch && request.teamNotificationIds?.includes(note.id));
  // the helper's native run delivers the exact check-in and ends with its marker
  projection.runs.push({id: "checkin-run", threadId: member.threadId, ordinal: 1, status: "completed", userMessageId: request.messageId,
    requestedAt: iso(time), startedAt: iso(time), completedAt: iso(time + 1), rootNodeId: null});
  projection.messages.push({id: request.messageId, threadId: member.threadId, runId: "checkin-run", nodeId: null, role: "user", text: request.text,
    streaming: false, scheduledTaskId: `scheduled-${member.threadId}`, creationSource: "server", createdAt: iso(time), updatedAt: iso(time)});
  projection.messages.push({id: "checkin-final", threadId: member.threadId, runId: "checkin-run", nodeId: null, role: "assistant", text: request.completionMarker,
    ordinal: 1, streaming: false, createdAt: iso(time), updatedAt: iso(time)});
  const before = {request: "waiting", teamRequest: "pending", note: "delivered", acknowledged: 0};
  assert.deepEqual(teamState(f.guidance.db, request.id, note.id), before);
  f.guidance.db.exec(`CREATE TEMP TRIGGER c1_fail_settle BEFORE UPDATE ON supervisor_team_requests WHEN NEW.state='settled'
    BEGIN SELECT RAISE(ABORT, 'c1 injected settle failure'); END`);
  runtime.startCycle(f.binding);
  await assert.rejects(runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5_000)), /c1 injected settle failure/u);
  assert.deepEqual(teamState(f.guidance.db, request.id, note.id), before);
  const reopened = f.reopen();
  assert.deepEqual(teamState(reopened.guidance.db, request.id, note.id), before);

  // the same completion succeeds from the reopened files once the failure is gone
  const retried = f.runtime(transport.transport, undefined, reopened);
  retried.startCycle(f.binding);
  await retried.reconcile(f.binding, f.threadList, AbortSignal.timeout(5_000));
  assert.deepEqual(teamState(reopened.guidance.db, request.id, note.id),
    {request: "completed", teamRequest: "settled", note: "acknowledged", acknowledged: batch.threads[0]!.items.length});
});

it("CT-TRUN-04: a helper check-in is withheld at lastNotice+59999 ms and prepared at +60000 ms", {timeout: 10_000}, async t => {
  const f = await teamFixture(t);
  const clock = {now: time};
  mockMethod(t, Date, "now", () => clock.now);
  const member = readyMember(f.teamStore, f.binding, "helper-cooldown");
  activate(f.teamStore, f.binding, member, "branch");
  f.projections.set(member.threadId, helperProjection(member, f.binding.threadId));
  const lastNotice = time + 1_000;
  f.requests.noticeSent(member.threadId, lastNotice);
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport);
  const batch = {projectId, createdAt: time, trigger: "priority" as const, finalizedActivityCount: 1, pendingItemCount: 1, truncated: false,
    threads: [{threadId: "branch", trigger: "priority" as const, finalizedActivityCount: 1, pendingItemCount: 1, oldestAt: time, priority: true,
      priorityKinds: ["run_finished" as const], saturated: false, untrackedCount: 0,
      items: [{id: "run:branch", readItemId: null, type: "run_finished", status: "completed", ordinal: 1, detectedAt: time, version: "v1", priority: "run_finished" as const}],
      previewItems: [{id: "run:branch", readItemId: null, type: "run_finished", status: "completed", ordinal: 1, detectedAt: time, version: "v1", priority: "run_finished" as const}]}]};
  const helperBatches = runtime.partition(f.binding, f.threadList, batch).helperBatches;
  clock.now = lastNotice + 59_999;
  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, helperBatches, AbortSignal.timeout(5_000));
  assert.equal(f.requests.pending(projectId, member.threadId), null);
  assert.deepEqual(transport.calls.filter(call => call.startsWith("send:")), []);
  clock.now = lastNotice + 60_000;
  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, helperBatches, AbortSignal.timeout(5_000));
  assert.equal(f.requests.pending(projectId, member.threadId)?.state, "waiting");
  assert.equal(transport.calls.filter(call => call.startsWith("send:")).length, 1);
});

it("CT-TRUN-04: a registering helper's readiness check-in starts exactly at lastNotice+60000 ms", {timeout: 10_000}, async t => {
  const f = await teamFixture(t);
  const clock = {now: time};
  mockMethod(t, Date, "now", () => clock.now);
  const registered = f.teamStore.registerMember(f.binding, {threadId: "helper-ready", taskId: "task-helper-ready", bootstrapRunId: "bootstrap-helper-ready", now: time});
  f.projections.set(registered.threadId, helperProjection(registered, f.binding.threadId));
  const lastNotice = time + 1_000;
  f.requests.noticeSent(registered.threadId, lastNotice);
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport);
  clock.now = lastNotice + 59_999;
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5_000));
  assert.equal(f.requests.pending(projectId, registered.threadId), null);
  clock.now = lastNotice + 60_000;
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5_000));
  assert.ok(f.requests.pending(projectId, registered.threadId)?.id.startsWith("team-ready:"));
});

it("CT-TRUN-04: an unresolved helper delivery raises root attention exactly 60000 ms after it was sent, not before", {timeout: 10_000}, async t => {
  const f = await teamFixture(t);
  const clock = {now: time};
  mockMethod(t, Date, "now", () => clock.now);
  const member = readyMember(f.teamStore, f.binding, "helper-unresolved");
  activate(f.teamStore, f.binding, member, "branch");
  f.projections.set(member.threadId, helperProjection(member, f.binding.threadId));
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport, () => clock.now);
  const batch = observedBranchBatch(f);
  clock.now = time + 100_000;
  runtime.startCycle(f.binding);
  await runtime.runHelperBatch(f.binding, f.threadList, runtime.partition(f.binding, f.threadList, batch).helperBatches, AbortSignal.timeout(5_000));
  const request = f.requests.pending(projectId, member.threadId);
  assert.ok(request?.state === "waiting" && request.sentAt === time + 100_000);
  const attention = () => f.teamStore.snapshot(f.binding).events.filter(event => event.id.startsWith("helper-checkin-unresolved:")).length;
  clock.now = request.sentAt + 59_999;
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5_000));
  assert.equal(attention(), 0);
  clock.now = request.sentAt + 60_000;
  runtime.startCycle(f.binding);
  await runtime.reconcile(f.binding, f.threadList, AbortSignal.timeout(5_000));
  assert.equal(attention(), 1);
  assert.equal(transport.calls.filter(call => call.startsWith("send:")).length, 3, "each cycle only re-observes the same identity");
  assert.equal(new Set(transport.calls.filter(call => call.startsWith("send:"))).size, 1);
});

const tableDigest = (db: DatabaseSync): string => {
  const hash = createHash("sha256");
  for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{name: string}>)
    hash.update(`${name}\0${JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())}\0`);
  return hash.digest("hex");
};
const totalChanges = (db: DatabaseSync): number => Number(db.prepare("SELECT total_changes() AS n").get()?.n);

it("CT-TRUN-05: a root without members, notices or transfers makes no projection read, no transport call and no write", {timeout: 10_000}, async t => {
  const f = await teamFixture(t);
  const transport = webhookTransport();
  const runtime = f.runtime(transport.transport);
  const binding = f.binding as BindingRecord;
  const batch = observedBranchBatch(f);
  const digest = tableDigest(f.guidance.db);
  const changes = totalChanges(f.guidance.db);
  for (let cycle = 0; cycle < 3; cycle++) {
    runtime.startCycle(binding);
    await runtime.reconcile(binding, f.threadList, AbortSignal.timeout(5_000));
    const partition = runtime.partition(binding, f.threadList, batch);
    assert.deepEqual(partition.helperBatches, []);
    await runtime.runHelperBatch(binding, f.threadList, partition.helperBatches, AbortSignal.timeout(5_000));
  }
  assert.deepEqual(f.reads, []);
  assert.deepEqual(transport.calls, []);
  assert.equal(totalChanges(f.guidance.db), changes);
  assert.equal(tableDigest(f.guidance.db), digest);
});
