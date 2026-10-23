import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { SupervisorMonitorBatch, SupervisorMonitorThreadBatch } from "../src/supervisor-monitor.js";
import { defaultSupervisorModel, type BindingRecord } from "../src/project-supervisor-store.js";
import type { HelperTransportShape } from "../src/supervisor-helper-transport.js";
import type { SupervisorTeamStoreShape, TeamBinding, TeamMember } from "../src/supervisor-team-store.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { failsWith, rows } from "./support/guidance-store-services.js";
import {
  execute, helperTransportUnit, reopenTeamStores, rpcUncertain, teamRuntimeUnit, teamStoresFixture, wallClock, type ProjectionRead, type RpcHandler,
  type TeamStores,
} from "./support/g3-team.js";

// the team-runtime characterizations on the production SupervisorTeamRuntime and HelperTransport layers over the store
// services of a temporary guidance database, under the test clock: the native side is a fake scheduler, a stubbed fetch
// and the T3 projection reads, and a crash or restart closes the file's client and opens the stores again

const time = Date.parse("2026-10-16T10:00:00.000Z");
const iso = (value: number) => new Date(value).toISOString();
const uncertainError = "Helper delivery is uncertain; its original native identity is retained.";

// real SupervisorHelperTransport over a fake native scheduler, copied from the baseline transport suite; fetch is held per test
const transportTeam = Effect.gen(function* () {
  yield* TestClock.setTime(wallClock);
  const db = yield* teamStoresFixture("c1-team-transport-");
  const store = db.store;
  yield* execute(db, "INSERT INTO meta VALUES(?,?)", 'supervisor_control:"p"', JSON.stringify({enabled: true, manual: true, generation: 1}));
  const binding = {...yield* store.reserve("p", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const};yield* store.setBinding(binding);
  const team = db.teamStore;
  yield* team.registerMember(binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "boot"});
  const helper: Projection = {thread: {id: "helper", projectId: "p", title: "helper", modelSelection: defaultSupervisorModel,
    runtimeMode: "full-access", interactionMode: "default", lineage: {parentThreadId: binding.threadId, relationshipToParent: "subagent"}},
  runs: [], messages: [], runtimeRequests: []};
  const tasks: Record<string, unknown>[] = [];
  let holdList: (() => Effect.Effect<void> | null) | null = null;
  const rpc: RpcHandler = (tag, input) => {
    if (tag === "scheduledTasks.list") return Effect.gen(function* () {const held = holdList?.() ?? null;if (held) yield* held;return {tasks};});
    if (tag === "scheduledTasks.upsert") {
      const task = {...input, createdAt: "2026-10-16T10:00:00Z", webhook: {path: "/api/hooks/fixture/fixture-only-token", url: null}};
      tasks.splice(0, tasks.length, task);return Effect.succeed({task});
    }
    if (tag === "scheduledTasks.listWebhookDeliveries") return Effect.succeed({deliveries: []});
    return Effect.fail(rpcUncertain());
  };
  const posts: string[] = [];
  const pending: Array<PromiseWithResolvers<Response>> = [];
  let mode: "abort" | "crash" | "accept" = "accept";
  const reached = yield* Deferred.make<void>();
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    posts.push(String(init?.body));
    Deferred.doneUnsafe(reached, Effect.void);
    if (mode === "accept") return Response.json({deliveryId: `delivery-${posts.length}`}, {status: 202});
    if (mode === "crash") {const never = Promise.withResolvers<Response>();pending.push(never);return never.promise;}
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), {once: true}));
  };
  // an abandoned POST ends with the test
  const endPosts = Effect.sync(() => {for (const never of pending) never.reject(new Error("abandoned POST"));});
  yield* Effect.addFinalizer(() => endPosts);
  // the baseline transport suite's team composition: a ready helper assigned the operational branch
  const main = binding.mainThreadId;
  const member = (yield* team.snapshot(binding)).members.find(value => value.threadId === "helper")!;
  const ready = yield* team.markReady(binding, member.threadId, member.epoch);
  const operational: ThreadInfo = {id: "branch", title: "branch", projectId: "p", lineage: {parentThreadId: main, relationshipToParent: "subagent", rootThreadId: main}};
  const parents = new Map<string, string | null>([[main, null], [operational.id, main], [ready.threadId, main]]);
  const assignment = yield* team.assign(binding, operational.id, ready.threadId, parents);
  for (const notice of (yield* team.snapshot(binding)).notifications.filter(value => value.assignmentEpoch === assignment.epoch)) {
    yield* team.updateNotificationDelivery(binding, binding.threadId, notice.id, "sending");
    yield* team.updateNotificationDelivery(binding, binding.threadId, notice.id, "delivered");
    yield* team.acknowledgeNotification(binding, notice.recipientThreadId, notice.id, notice.memberEpoch);
  }
  yield* team.completeTransfer(binding, operational.id, assignment.epoch);
  const threads = [helper.thread, operational, {id: main, title: main, projectId: "p", lineage: {parentThreadId: null, relationshipToParent: null, rootThreadId: main}} as ThreadInfo];
  const compose = (guidance: TeamStores, transportProjection: ProjectionRead = () => Effect.succeed(helper), supervisionStopped?: () => boolean) => Effect.gen(function* () {
    const transport = yield* helperTransportUnit({stores: guidance, rpc, baseUrl: "http://127.0.0.1:3773", projection: transportProjection, fetch});
    const runtime = yield* teamRuntimeUnit({stores: guidance, transport, projection: () => Effect.succeed(helper),
      ...(supervisionStopped ? {supervisionStopped} : {})});
    return {requests: guidance.requests, monitor: guidance.monitor, transport, runtime};
  });
  const detectedAt = yield* Clock.currentTimeMillis;
  const item = {id: "run:branch", readItemId: null, type: "run_finished", status: "completed", ordinal: 1, detectedAt, version: "branch-v1", priority: "run_finished" as const};
  const thread: SupervisorMonitorThreadBatch = {threadId: "branch", trigger: "priority", finalizedActivityCount: 1, pendingItemCount: 1, oldestAt: detectedAt,
    priority: true, priorityKinds: ["run_finished"], saturated: false, untrackedCount: 0, items: [item], previewItems: [item]};
  const batch: SupervisorMonitorBatch = {projectId: "p", createdAt: detectedAt, trigger: "priority", finalizedActivityCount: 1, pendingItemCount: 1, truncated: false, threads: [thread]};
  const first = yield* compose(db);
  const helperBatches = (yield* first.runtime.partition(binding, threads, batch)).helperBatches;
  assert.equal(helperBatches.length, 1);
  const receipts = (guidance: TeamStores) => Effect.map(rows(guidance.sql, "SELECT document FROM supervisor_helper_deliveries"),
    (documents) => documents.map(row => JSON.parse(String(row.document)) as Record<string, unknown>));
  return {db, store, team, binding, helper, threads, helperBatches, posts, reached, compose, receipts, endPosts, ...first,
    setMode: (next: typeof mode) => {mode = next;},
    holdList: (gate: Deferred.Deferred<void>) => Effect.gen(function* () {
      const listed = yield* Deferred.make<void>();
      holdList = () => {holdList = null;Deferred.doneUnsafe(listed, Effect.void);return Deferred.await(gate);};
      return Deferred.await(listed);
    }),
    reopen: Effect.gen(function* () {
      const guidance = yield* reopenTeamStores(db.directory);
      return {guidance, store: guidance.store, team: guidance.teamStore, ...yield* compose(guidance)};
    })};
});

it.effect("CT-TRUN-01: aborting the helper POST after the 'sending' commit makes the request 'uncertain', keeps the receipt 'posting' and never posts again", () => Effect.gen(function* () {
  const f = yield* transportTeam;
  f.setMode("abort");
  const controller = yield* Deferred.make<void>();
  yield* f.runtime.startCycle(f.binding);
  const running = yield* Effect.forkChild(f.runtime.runHelperBatch(f.binding, f.threads, f.helperBatches, controller));
  yield* Deferred.await(f.reached);
  const sending = yield* f.requests.pending("p", "helper");
  assert.ok(sending);
  assert.equal(sending.state, "sending");
  assert.deepEqual((yield* f.receipts(f.db)).map(receipt => [receipt.messageId, receipt.state, receipt.text]), [[sending.messageId, "posting", sending.text]]);
  yield* Deferred.succeed(controller, undefined);
  yield* Fiber.join(running);
  assert.deepEqual(yield* f.requests.pending("p", "helper"), {...sending, state: "uncertain", error: uncertainError});
  assert.equal((yield* f.team.unresolvedRequests(f.binding)).find(request => request.requestId === sending.id)?.state, "uncertain");
  assert.equal((yield* f.receipts(f.db))[0]?.state, "posting");

  f.setMode("accept");
  yield* f.runtime.startCycle(f.binding);
  yield* f.runtime.reconcile(f.binding, f.threads);
  const restarted = yield* f.reopen;
  yield* restarted.runtime.startCycle(f.binding);
  yield* restarted.runtime.reconcile(f.binding, f.threads);
  assert.equal((yield* restarted.requests.pending("p", "helper"))?.state, "uncertain");
  assert.equal((yield* f.receipts(restarted.guidance))[0]?.state, "posting");
  assert.equal(f.posts.length, 1);
}), {timeout: 10_000});

it.effect("CT-TRUN-01: a crash during the helper POST keeps the request 'sending'; a new process marks it 'uncertain' and never posts again", () => Effect.gen(function* () {
  const f = yield* transportTeam;
  f.setMode("crash");
  yield* f.runtime.startCycle(f.binding);
  const abandoned = yield* Effect.forkChild(f.runtime.runHelperBatch(f.binding, f.threads, f.helperBatches).pipe(Effect.as("settled"), Effect.orElseSucceed(() => "failed")));
  // the abandoned run settles once the test ends its POST
  yield* Effect.addFinalizer(() => f.endPosts.pipe(Effect.andThen(Fiber.await(abandoned)), Effect.asVoid));
  yield* Deferred.await(f.reached);
  const sending = yield* f.requests.pending("p", "helper");
  assert.ok(sending?.state === "sending");
  yield* f.db.close;

  f.setMode("accept");
  const restarted = yield* f.reopen;
  assert.deepEqual(yield* restarted.requests.pending("p", "helper"), sending, "reopening performs no recovery");
  yield* restarted.runtime.startCycle(f.binding);
  yield* restarted.runtime.reconcile(f.binding, f.threads);
  assert.deepEqual(yield* restarted.requests.pending("p", "helper"), {...sending, state: "uncertain",
    error: "The helper request may have been accepted; its original native identity is retained."});
  yield* restarted.runtime.startCycle(f.binding);
  yield* restarted.runtime.reconcile(f.binding, f.threads);
  assert.equal((yield* restarted.requests.pending("p", "helper"))?.state, "uncertain");
  assert.deepEqual((yield* f.receipts(restarted.guidance)).map(receipt => receipt.state), ["posting"]);
  assert.equal(f.posts.length, 1);
}), {timeout: 10_000});

it.effect("CT-TRUN-02: a quarantine committed during the transport's helper read leaves no receipt and no POST and fails only its own request", () => Effect.gen(function* () {
  const f = yield* transportTeam;
  const gate = yield* Deferred.make<void>();
  const held = yield* Deferred.make<void>();
  const composed = yield* f.compose(f.db, () => Effect.gen(function* () {yield* Deferred.succeed(held, undefined);yield* Deferred.await(gate);return f.helper;}));
  yield* composed.runtime.startCycle(f.binding);
  const running = yield* Effect.forkChild(composed.runtime.runHelperBatch(f.binding, f.threads, f.helperBatches));
  yield* Deferred.await(held);
  const request = yield* composed.requests.pending("p", "helper");
  assert.ok(request?.state === "sending");
  yield* f.team.quarantineMember(f.binding, "helper");
  yield* Deferred.succeed(gate, undefined);
  yield* Fiber.join(running);
  assert.deepEqual(yield* f.receipts(f.db), []);
  assert.equal(f.posts.length, 0);
  const failed = (yield* composed.requests.requests("p", "helper")).find(value => value.id === request.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.error, "The helper lost its authority before this check-in was posted; nothing was posted and pending activity is retained.");
  assert.equal((yield* f.team.unresolvedRequests(f.binding)).some(value => value.requestId === request.id), false);
}), {timeout: 10_000});

it.effect("CT-TRUN-02: a stop committed during the transport's channel read leaves no receipt and no POST", () => Effect.gen(function* () {
  const f = yield* transportTeam;
  let stopped = false;
  const gate = yield* Deferred.make<void>();
  const composed = yield* f.compose(f.db, undefined, () => stopped);
  const listed = yield* f.holdList(gate);
  yield* composed.runtime.startCycle(f.binding);
  const running = yield* Effect.forkChild(composed.runtime.runHelperBatch(f.binding, f.threads, f.helperBatches));
  yield* listed;
  const request = yield* composed.requests.pending("p", "helper");
  assert.ok(request?.state === "sending");
  stopped = true;
  yield* Deferred.succeed(gate, undefined);
  yield* Fiber.join(running);
  assert.deepEqual(yield* f.receipts(f.db), []);
  assert.equal(f.posts.length, 0);
  assert.equal((yield* composed.requests.requests("p", "helper")).find(value => value.id === request.id)?.state, "failed");
  assert.equal((yield* f.team.unresolvedRequests(f.binding)).some(value => value.requestId === request.id), false);
}), {timeout: 10_000});

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
  const transport: HelperTransportShape = {
    send: (_binding, message) => Effect.sync(() => {
      calls.push(`send:${message.messageId}`);
      sent.set(message.messageId, {threadId: message.threadId, commandId: message.commandId, text: message.text, taskId: `scheduled-${message.threadId}`});
      return "waiting" as const;
    }),
    hasDelivery: (_binding, message) => Effect.sync(() => {
      calls.push(`hasDelivery:${message.messageId}`);
      const delivery = sent.get(message.messageId);
      return Boolean(delivery && delivery.threadId === message.threadId && delivery.commandId === message.commandId && delivery.text === message.text);
    }),
    reconcileDelivery: (_binding, message) => Effect.sync(() => {calls.push(`reconcile:${message.messageId}`);return sent.has(message.messageId) ? "uncertain" as const : "absent" as const;}),
    receiptText: (_binding, messageId) => Effect.sync(() => {calls.push(`receiptText:${messageId}`);return sent.get(messageId)?.text ?? null;}),
    matchesMessage: (_binding, logicalId, text, native) => Effect.sync(() => {
      const delivery = sent.get(logicalId);
      return Boolean(delivery && delivery.text === text && native.threadId === delivery.threadId && native.text === text &&
        native.scheduledTaskId === delivery.taskId && native.creationSource === "server");
    }),
    receiptDocument: () => Effect.die(new Error("a fake transport keeps no receipt documents")),
    retire: (_binding, threadId) => Effect.sync(() => {calls.push(`retire:${threadId}`);return true;}),
  };
  return {transport, sent, calls};
};

const teamFixture = Effect.gen(function* () {
  yield* TestClock.setTime(wallClock);
  const guidance = yield* teamStoresFixture("c1-team-runtime-");
  const store = guidance.store;
  yield* store.reserve(projectId, "main", "main", defaultSupervisorModel, 0, 1);
  const binding = (yield* store.binding(projectId, "main"))!;
  const teamStore = guidance.teamStore;
  const requests = guidance.requests;
  const monitor = guidance.monitor;
  const threadList = [makeThread("main"), makeThread("branch", "main", "subagent"), makeThread("leaf", "branch", "subagent"), makeThread("other", "main", "subagent")];
  const projections = new Map<string, Projection>(threadList.map(thread => [thread.id, emptyProjection(thread)]));
  const reads: string[] = [];
  const runtime = (helperTransport?: HelperTransportShape, stores: TeamStores = guidance) =>
    teamRuntimeUnit({stores, projection: (threadId) => Effect.sync(() => {reads.push(threadId);return projections.get(threadId) ?? emptyProjection(makeThread(threadId));}),
      ...(helperTransport ? {transport: helperTransport} : {})});
  return {guidance, store, binding, teamStore, requests, monitor, threadList, projections, runtime, reads,
    reopen: reopenTeamStores(guidance.directory)};
});

const readyMember = (team: SupervisorTeamStoreShape, binding: TeamBinding, threadId: string, now = time) => Effect.gen(function* () {
  const registered = yield* team.registerMember(binding, {threadId, taskId: `task-${threadId}`, bootstrapRunId: `bootstrap-${threadId}`, now});
  return yield* team.markReady(binding, threadId, registered.epoch, now + 1);
});

const activate = (team: SupervisorTeamStoreShape, binding: TeamBinding, member: TeamMember, subtreeRoot: string, now = time) => Effect.gen(function* () {
  const assignment = yield* team.assign(binding, subtreeRoot, member.threadId, parents, now);
  for (const notice of (yield* team.snapshot(binding)).notifications.filter(item => item.assignmentRootThreadId === subtreeRoot && item.assignmentEpoch === assignment.epoch)) {
    yield* team.updateNotificationDelivery(binding, binding.threadId, notice.id, "sending", now + 1);
    yield* team.updateNotificationDelivery(binding, binding.threadId, notice.id, "delivered", now + 2);
    yield* team.acknowledgeNotification(binding, notice.recipientThreadId, notice.id, notice.memberEpoch, now + 3);
  }
  yield* team.completeTransfer(binding, subtreeRoot, assignment.epoch, now + 4);
});

const deliverNote = (teamStore: SupervisorTeamStoreShape, binding: TeamBinding, member: TeamMember, id: string, message: string, at: number) => Effect.gen(function* () {
  const note = yield* teamStore.note(binding, {eventId: `${id}-event`, notificationId: id, memberThreadId: member.threadId, memberEpoch: member.epoch, message, now: at});
  yield* teamStore.updateNotificationDelivery(binding, binding.threadId, note.id, "sending", at + 1);
  return yield* teamStore.updateNotificationDelivery(binding, binding.threadId, note.id, "delivered", at + 2);
});

const helperProjection = (member: TeamMember, rootThreadId: string): Projection => emptyProjection({
  ...makeThread(member.threadId, rootThreadId, "subagent"), lineage: {parentThreadId: rootThreadId, relationshipToParent: "subagent", rootThreadId},
});

// one completed command in the operational branch, observed into the real monitor tables and selected as a batch
const observedBranchBatch = (f: Effect.Success<typeof teamFixture>) => Effect.gen(function* () {
  const op = emptyProjection(makeThread("branch", "main", "subagent"));
  op.runs.push({id: "operational-run", threadId: "branch", ordinal: 1, status: "completed", requestedAt: iso(time), startedAt: iso(time),
    completedAt: iso(time + 1), rootNodeId: "root-node", providerThreadId: "provider-branch"});
  op.nodes = [
    {id: "root-node", kind: "root_turn", status: "completed", threadId: "branch", runId: "operational-run", rootNodeId: "root-node", providerThreadId: "provider-branch"},
    {id: "tool-node", kind: "tool_call", status: "completed", threadId: "branch", runId: "operational-run", rootNodeId: "root-node", providerThreadId: "provider-branch", parentNodeId: "root-node"},
  ];
  op.turnItems = [{id: "turn-item:command", threadId: "branch", runId: "operational-run", nodeId: "tool-node", type: "command_execution", status: "completed",
    ordinal: 1, completedAt: iso(time + 1), updatedAt: iso(time + 1)}];
  yield* f.monitor.observe({projectId, threadId: "branch", sourceOrdinal: 0, projection: op, now: time + 2, includeDetachedChildItems: true});
  const selected = yield* f.monitor.select(projectId, {intervalMinutes: 5, activityThreshold: 1}, time + 3, null, {eligibleThreadIds: new Set(["branch"])});
  assert.ok(selected);
  return selected;
});

const teamState = (db: TeamStores, requestId: string, noteId: string) => Effect.gen(function* () {
  const [request] = yield* rows(db.sql, "SELECT document FROM supervisor_conversation_requests WHERE id=?", requestId);
  const [teamRequest] = yield* rows(db.sql, "SELECT state FROM supervisor_team_requests WHERE request_id=?", requestId);
  const [note] = yield* rows(db.sql, "SELECT document FROM supervisor_team_notifications WHERE id=?", noteId);
  return {
    request: (JSON.parse(String(request?.document)) as {state: string}).state,
    teamRequest: String(teamRequest?.state),
    note: (JSON.parse(String(note?.document)) as {state: string}).state,
    acknowledged: (yield* rows(db.sql, "SELECT item_id FROM supervisor_monitor_items WHERE project_id=? AND thread_id='branch' AND reviewed_version=version", projectId)).length,
  };
});

it.effect("CT-TRUN-03: a failure inside the completion transaction rolls back request completion, monitor and note acknowledgements, retryable after reopen", () => Effect.gen(function* () {
  const f = yield* teamFixture;
  yield* TestClock.setTime(time + 10);
  const member = yield* readyMember(f.teamStore, f.binding, "helper-rollback");
  yield* activate(f.teamStore, f.binding, member, "branch");
  const note = yield* deliverNote(f.teamStore, f.binding, member, "rollback-note", "Keep the parent informed.", time + 5);
  const batch = yield* observedBranchBatch(f);
  const projection = helperProjection(member, f.binding.threadId);
  f.projections.set(member.threadId, projection);
  const transport = webhookTransport();
  const runtime = yield* f.runtime(transport.transport);
  yield* runtime.startCycle(f.binding);
  yield* runtime.runHelperBatch(f.binding, f.threadList, (yield* runtime.partition(f.binding, f.threadList, batch)).helperBatches);
  const request = yield* f.requests.pending(projectId, member.threadId);
  assert.ok(request?.state === "waiting" && request.batch && request.teamNotificationIds?.includes(note.id));
  // the helper's native run delivers the exact check-in and ends with its marker
  projection.runs.push({id: "checkin-run", threadId: member.threadId, ordinal: 1, status: "completed", userMessageId: request.messageId,
    requestedAt: iso(time), startedAt: iso(time), completedAt: iso(time + 1), rootNodeId: null});
  projection.messages.push({id: request.messageId, threadId: member.threadId, runId: "checkin-run", nodeId: null, role: "user", text: request.text,
    streaming: false, scheduledTaskId: `scheduled-${member.threadId}`, creationSource: "server", createdAt: iso(time), updatedAt: iso(time)});
  projection.messages.push({id: "checkin-final", threadId: member.threadId, runId: "checkin-run", nodeId: null, role: "assistant", text: request.completionMarker,
    ordinal: 1, streaming: false, createdAt: iso(time), updatedAt: iso(time)});
  const before = {request: "waiting", teamRequest: "pending", note: "delivered", acknowledged: 0};
  assert.deepEqual(yield* teamState(f.guidance, request.id, note.id), before);
  yield* execute(f.guidance, `CREATE TEMP TRIGGER c1_fail_settle BEFORE UPDATE ON supervisor_team_requests WHEN NEW.state='settled'
    BEGIN SELECT RAISE(ABORT, 'c1 injected settle failure'); END`);
  yield* runtime.startCycle(f.binding);
  // the team store reports the injected driver failure as its typed store error, without the driver's text (s6d step 1)
  yield* failsWith(runtime.reconcile(f.binding, f.threadList), /supervisor_team_store_unavailable/u);
  assert.deepEqual(yield* teamState(f.guidance, request.id, note.id), before);
  const reopened = yield* f.reopen;
  assert.deepEqual(yield* teamState(reopened, request.id, note.id), before);

  // the same completion succeeds from the reopened files once the failure is gone
  const retried = yield* f.runtime(transport.transport, reopened);
  yield* retried.startCycle(f.binding);
  yield* retried.reconcile(f.binding, f.threadList);
  assert.deepEqual(yield* teamState(reopened, request.id, note.id),
    {request: "completed", teamRequest: "settled", note: "acknowledged", acknowledged: batch.threads[0]!.items.length});
}), {timeout: 10_000});

it.effect("CT-TRUN-04: a helper check-in is withheld at lastNotice+59999 ms and prepared at +60000 ms", () => Effect.gen(function* () {
  const f = yield* teamFixture;
  yield* TestClock.setTime(time);
  const member = yield* readyMember(f.teamStore, f.binding, "helper-cooldown");
  yield* activate(f.teamStore, f.binding, member, "branch");
  f.projections.set(member.threadId, helperProjection(member, f.binding.threadId));
  const lastNotice = time + 1_000;
  yield* f.requests.noticeSent(member.threadId, lastNotice);
  const transport = webhookTransport();
  const runtime = yield* f.runtime(transport.transport);
  const batch = {projectId, createdAt: time, trigger: "priority" as const, finalizedActivityCount: 1, pendingItemCount: 1, truncated: false,
    threads: [{threadId: "branch", trigger: "priority" as const, finalizedActivityCount: 1, pendingItemCount: 1, oldestAt: time, priority: true,
      priorityKinds: ["run_finished" as const], saturated: false, untrackedCount: 0,
      items: [{id: "run:branch", readItemId: null, type: "run_finished", status: "completed", ordinal: 1, detectedAt: time, version: "v1", priority: "run_finished" as const}],
      previewItems: [{id: "run:branch", readItemId: null, type: "run_finished", status: "completed", ordinal: 1, detectedAt: time, version: "v1", priority: "run_finished" as const}]}]};
  const helperBatches = (yield* runtime.partition(f.binding, f.threadList, batch)).helperBatches;
  yield* TestClock.setTime(lastNotice + 59_999);
  yield* runtime.startCycle(f.binding);
  yield* runtime.runHelperBatch(f.binding, f.threadList, helperBatches);
  assert.equal(yield* f.requests.pending(projectId, member.threadId), null);
  assert.deepEqual(transport.calls.filter(call => call.startsWith("send:")), []);
  yield* TestClock.setTime(lastNotice + 60_000);
  yield* runtime.startCycle(f.binding);
  yield* runtime.runHelperBatch(f.binding, f.threadList, helperBatches);
  assert.equal((yield* f.requests.pending(projectId, member.threadId))?.state, "waiting");
  assert.equal(transport.calls.filter(call => call.startsWith("send:")).length, 1);
}), {timeout: 10_000});

it.effect("CT-TRUN-04: a registering helper's readiness check-in starts exactly at lastNotice+60000 ms", () => Effect.gen(function* () {
  const f = yield* teamFixture;
  yield* TestClock.setTime(time);
  const registered = yield* f.teamStore.registerMember(f.binding, {threadId: "helper-ready", taskId: "task-helper-ready", bootstrapRunId: "bootstrap-helper-ready", now: time});
  f.projections.set(registered.threadId, helperProjection(registered, f.binding.threadId));
  const lastNotice = time + 1_000;
  yield* f.requests.noticeSent(registered.threadId, lastNotice);
  const transport = webhookTransport();
  const runtime = yield* f.runtime(transport.transport);
  yield* TestClock.setTime(lastNotice + 59_999);
  yield* runtime.startCycle(f.binding);
  yield* runtime.reconcile(f.binding, f.threadList);
  assert.equal(yield* f.requests.pending(projectId, registered.threadId), null);
  yield* TestClock.setTime(lastNotice + 60_000);
  yield* runtime.startCycle(f.binding);
  yield* runtime.reconcile(f.binding, f.threadList);
  assert.ok((yield* f.requests.pending(projectId, registered.threadId))?.id.startsWith("team-ready:"));
}), {timeout: 10_000});

it.effect("CT-TRUN-04: an unresolved helper delivery raises root attention exactly 60000 ms after it was sent, not before", () => Effect.gen(function* () {
  const f = yield* teamFixture;
  yield* TestClock.setTime(time);
  const member = yield* readyMember(f.teamStore, f.binding, "helper-unresolved");
  yield* activate(f.teamStore, f.binding, member, "branch");
  f.projections.set(member.threadId, helperProjection(member, f.binding.threadId));
  const transport = webhookTransport();
  const runtime = yield* f.runtime(transport.transport);
  const batch = yield* observedBranchBatch(f);
  yield* TestClock.setTime(time + 100_000);
  yield* runtime.startCycle(f.binding);
  yield* runtime.runHelperBatch(f.binding, f.threadList, (yield* runtime.partition(f.binding, f.threadList, batch)).helperBatches);
  const request = yield* f.requests.pending(projectId, member.threadId);
  assert.ok(request?.state === "waiting" && request.sentAt === time + 100_000);
  const attention = Effect.map(f.teamStore.snapshot(f.binding), (snapshot) => snapshot.events.filter(event => event.id.startsWith("helper-checkin-unresolved:")).length);
  yield* TestClock.setTime(request.sentAt + 59_999);
  yield* runtime.startCycle(f.binding);
  yield* runtime.reconcile(f.binding, f.threadList);
  assert.equal(yield* attention, 0);
  yield* TestClock.setTime(request.sentAt + 60_000);
  yield* runtime.startCycle(f.binding);
  yield* runtime.reconcile(f.binding, f.threadList);
  assert.equal(yield* attention, 1);
  assert.equal(transport.calls.filter(call => call.startsWith("send:")).length, 3, "each cycle only re-observes the same identity");
  assert.equal(new Set(transport.calls.filter(call => call.startsWith("send:"))).size, 1);
}), {timeout: 10_000});

const tableDigest = (db: TeamStores) => Effect.gen(function* () {
  const hash = createHash("sha256");
  for (const {name} of (yield* rows(db.sql, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")) as Array<{name: string}>)
    hash.update(`${name}\0${JSON.stringify(yield* rows(db.sql, `SELECT * FROM "${name}" ORDER BY rowid`))}\0`);
  return hash.digest("hex");
});
const totalChanges = (db: TeamStores) => Effect.map(rows(db.sql, "SELECT total_changes() AS n"), ([row]) => Number(row?.n));

it.effect("CT-TRUN-05: a root without members, notices or transfers makes no projection read, no transport call and no write", () => Effect.gen(function* () {
  const f = yield* teamFixture;
  const transport = webhookTransport();
  const runtime = yield* f.runtime(transport.transport);
  const binding = f.binding as BindingRecord;
  const batch = yield* observedBranchBatch(f);
  const digest = yield* tableDigest(f.guidance);
  const changes = yield* totalChanges(f.guidance);
  for (let cycle = 0; cycle < 3; cycle++) {
    yield* runtime.startCycle(binding);
    yield* runtime.reconcile(binding, f.threadList);
    const partition = yield* runtime.partition(binding, f.threadList, batch);
    assert.deepEqual(partition.helperBatches, []);
    yield* runtime.runHelperBatch(binding, f.threadList, partition.helperBatches);
  }
  assert.deepEqual(f.reads, []);
  assert.deepEqual(transport.calls, []);
  assert.equal(yield* totalChanges(f.guidance), changes);
  assert.equal(yield* tableDigest(f.guidance), digest);
}), {timeout: 10_000});
