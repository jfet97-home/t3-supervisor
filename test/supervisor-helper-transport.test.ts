import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GuidanceStore} from "../src/guidance-store.js";
import {ProjectSupervisorStore, defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {SupervisorTeamStore} from "../src/supervisor-team-store.js";
import {SupervisorHelperTransport} from "../src/supervisor-helper-transport.js";
import {SupervisorTeamRuntime} from "../src/supervisor-team-runtime.js";
import {SupervisorConversationStore} from "../src/supervisor-conversation-store.js";
import {ProjectSupervisorMonitorStore} from "../src/supervisor-monitor-store.js";
import {SUPERVISOR_MONITOR_COOLDOWN_MS, type SupervisorMonitorBatch, type SupervisorMonitorThreadBatch} from "../src/supervisor-monitor.js";
import type {Projection, ThreadInfo} from "../src/types.js";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "helper-transport-"));
  const db = new GuidanceStore(directory);
  const store = new ProjectSupervisorStore(db, new Set());
  db.db.prepare("INSERT INTO meta VALUES(?,?)").run('supervisor_control:"p"', JSON.stringify({enabled: true, manual: true, generation: 1}));
  const binding = {...store.reserve("p", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const};store.setBinding(binding);
  const team = new SupervisorTeamStore(store);
  team.registerMember(binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "boot"});
  const helper: Projection = {thread: {id: "helper", projectId: "p", title: "helper", modelSelection: defaultSupervisorModel,
    runtimeMode: "full-access", interactionMode: "default", lineage: {parentThreadId: binding.threadId, relationshipToParent: "subagent"}},
  runs: [], messages: [], runtimeRequests: []};
  const tasks: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const state = {posts: 0, loseReply: false, emitMessage: true, omitDeliveryId: false, disableChannel: false,
    nativeOutcome: null as string | null, webhookDeliveryLookups: 0, webhookDetailLookups: 0,
    webhookDeliveries: [] as Array<Record<string, unknown>>, webhookDeliveryDetails: new Map<string, Record<string, unknown>>(),
    lastPostedBody: null as string | null};
  const rpc = async (tag: string, input: Record<string, unknown>) => {
    calls.push(tag);
    if (tag === "scheduledTasks.list") return {tasks};
    if (tag === "scheduledTasks.upsert") {
      const task = {...input, ...(state.disableChannel ? {enabled: false} : {}), createdAt: "2026-10-16T10:00:00Z",
        webhook: {path: "/api/hooks/fixture/fixture-only-token", url: null}};
      tasks.splice(0, tasks.length, task);return {task};
    }
    if (tag === "scheduledTasks.listWebhookDeliveries") {
      state.webhookDeliveryLookups++;
      if (state.webhookDeliveries.length) return {deliveries: state.webhookDeliveries};
      return {deliveries: state.nativeOutcome ? [{id: "native-delivery", taskId: String(input.id), receivedAt: "2026-10-16T10:00:00Z",
        method: "POST", contentType: "application/json", bodyBytes: 0, outcome: state.nativeOutcome}] : []};
    }
    if (tag === "scheduledTasks.getWebhookDelivery") {
      state.webhookDetailLookups++;
      const detail = state.webhookDeliveryDetails.get(String(input.deliveryId));
      if (!detail) throw new Error("delivery_detail_not_found");
      return detail;
    }
    if (tag === "scheduledTasks.delete") {assert.equal(input.id, tasks[0]!.id);tasks.splice(0);return {id: input.id};}
    throw new Error("unexpected_rpc");
  };
  const mockFetch: typeof fetch = async (_url, options) => {
    state.posts++;
    state.lastPostedBody = String(options?.body);
    const body = JSON.parse(state.lastPostedBody) as {text: string};
    if (state.emitMessage) helper.messages.push({id: "native-scheduler-message", threadId: "helper", scheduledTaskId: tasks[0]!.id,
      runId: "scheduler-run", nodeId: "root", role: "user", text: body.text, creationSource: "server", createdBy: "system",
      streaming: false, createdAt: "2026-10-16T10:00:00Z", updatedAt: "2026-10-16T10:00:00Z"});
    if (state.loseReply) throw new Error("post_reply_lost");
    return Response.json(state.omitDeliveryId ? {} : {deliveryId: "native-delivery"}, {status: 202});
  };
  const options = {store, rpc, baseUrl: "http://127.0.0.1:3773", projection: async () => helper, fetch: mockFetch};
  return {directory, db, store, binding, team, helper, tasks, calls, state, options,
    cleanup: async () => {db.close();await rm(directory, {recursive: true, force: true});}};
};

const addNativeWebhookDelivery = (f: Awaited<ReturnType<typeof fixture>>, input: {
  id: string;
  body: string;
  renderedPrompt: string | null;
  outcome: string;
  bodyTruncated?: boolean;
}): void => {
  const summary = {id: input.id, taskId: String(f.tasks[0]!.id), receivedAt: "2026-10-16T10:00:01Z", method: "POST",
    contentType: "application/json", bodyBytes: new TextEncoder().encode(input.body).length, outcome: input.outcome,
    signatureVerified: false, missingFields: [], error: null};
  f.state.webhookDeliveries.push(summary);
  f.state.webhookDeliveryDetails.set(input.id, {delivery: {...summary, query: "", headers: {"content-type": "application/json"},
    body: input.body, bodyTruncated: input.bodyTruncated ?? false, renderedPrompt: input.renderedPrompt}});
};

const helperBatch = (threadId: string): SupervisorMonitorBatch => {
  const detectedAt = Date.now();
  const item = {id: `run:${threadId}`, readItemId: null, type: "run_finished", status: "completed", ordinal: 1,
    detectedAt, version: `${threadId}-v1`, priority: "run_finished" as const};
  const thread: SupervisorMonitorThreadBatch = {threadId, trigger: "priority", finalizedActivityCount: 1, pendingItemCount: 1, oldestAt: detectedAt,
    priority: true, priorityKinds: ["run_finished"], saturated: false, untrackedCount: 0, items: [item], previewItems: [item]};
  return {projectId: "p", createdAt: detectedAt, trigger: "priority", finalizedActivityCount: 1, pendingItemCount: 1, truncated: false, threads: [thread]};
};

const teamRuntime = (f: Awaited<ReturnType<typeof fixture>>, transport: SupervisorHelperTransport, now?: () => number) => {
  const main = f.binding.mainThreadId;
  const helper = f.team.snapshot(f.binding).members.find(member => member.threadId === "helper")!;
  const ready = helper.state === "ready" ? helper : f.team.markReady(f.binding, helper.threadId, helper.epoch);
  const operational: ThreadInfo = {id: "branch", title: "branch", projectId: "p",
    lineage: {parentThreadId: main, relationshipToParent: "subagent", rootThreadId: main}};
  const parents = new Map<string, string | null>([[main, null], [operational.id, main], [ready.threadId, main]]);
  const assignment = f.team.assign(f.binding, operational.id, ready.threadId, parents);
  for (const notice of f.team.snapshot(f.binding).notifications.filter(value => value.assignmentEpoch === assignment.epoch)) {
    f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notice.id, "sending");
    f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notice.id, "delivered");
    f.team.acknowledgeNotification(f.binding, notice.recipientThreadId, notice.id, notice.memberEpoch);
  }
  f.team.completeTransfer(f.binding, operational.id, assignment.epoch);
  const threads = [f.helper.thread, operational, {id: main, title: main, projectId: "p",
    lineage: {parentThreadId: null, relationshipToParent: null, rootThreadId: main}} as ThreadInfo];
  const requests = new SupervisorConversationStore(f.db);
  const monitor = new ProjectSupervisorMonitorStore(f.db);
  const runtime = new SupervisorTeamRuntime({store: f.store, teamStore: f.team, requests, monitor, rpc: f.options.rpc,
    helperTransport: transport, projection: f.options.projection, ...(now ? {now} : {})});
  const batch = helperBatch(operational.id);
  const partition = runtime.partition(f.binding, threads, batch);
  assert.equal(partition.helperBatches.length, 1);
  return {runtime, requests, monitor, threads, batch: partition.helperBatches};
};

test("native webhook check-ins have real schedule identity and no root follow-up dispatch", async () => {
  const f = await fixture();
  try {
    const transport = new SupervisorHelperTransport(f.options);
    const input = {threadId: "helper", commandId: "check-in", messageId: "logical-message", text: "Bounded check-in marker-1"};
    assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "waiting");
    assert.deepEqual(f.tasks[0]!.schedule, {type: "webhook"});
    assert.equal(f.tasks[0]!.threadId, "helper");
    assert.equal(f.tasks[0]!.prompt, "{{body.text}}");
    assert(!f.calls.includes("orchestration.dispatchCommand"));
    assert.equal(f.state.posts, 1);
    assert(transport.matchesMessage(f.binding, input.messageId, input.text, f.helper.messages[0]!));
    assert(!transport.matchesMessage(f.binding, input.messageId, input.text, {...f.helper.messages[0]!, scheduledTaskId: "foreign"}));
    assert(!transport.matchesMessage(f.binding, input.messageId, input.text, {...f.helper.messages[0]!, text: "Changed body"}));
    assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "waiting");
    assert.equal(f.state.posts, 1);
    assert(await transport.retire(f.binding, "helper", AbortSignal.timeout(1000)));
    assert.equal(f.tasks.length, 0);
  } finally {await f.cleanup();}
});

test("uncertain webhook POST never repeats across restart, and native evidence can reconcile it", async () => {
  const f = await fixture();
  try {
    f.state.loseReply = true;f.state.emitMessage = false;
    const input = {threadId: "helper", commandId: "lost", messageId: "lost-message", text: "Unique durable marker-2"};
    assert.equal(await new SupervisorHelperTransport(f.options).send(f.binding, input, AbortSignal.timeout(1000)), "uncertain");
    const restarted = new SupervisorHelperTransport(f.options);
    assert.equal(await restarted.send(f.binding, input, AbortSignal.timeout(1000)), "uncertain");
    assert.equal(f.state.posts, 1);
    assert.equal(await restarted.send(f.binding, {...input, text: "changed"}, AbortSignal.timeout(1000)), "uncertain",
      "changed content is refused without claiming the earlier unknown POST was not delivered");
    f.helper.messages.push({id: "recovered-native-message", threadId: "helper", scheduledTaskId: f.tasks[0]!.id,
      runId: "run", nodeId: "root", role: "user", text: input.text, creationSource: "server", streaming: false,
      createdAt: "2026-10-16T10:00:00Z", updatedAt: "2026-10-16T10:00:00Z"});
    assert.equal(await restarted.send(f.binding, input, AbortSignal.timeout(1000)), "waiting");
    assert.equal(f.state.posts, 1);
  } finally {await f.cleanup();}
});

test("a refusal after an unknown POST never reports the original identity as rejected", async () => {
  for (const refusal of ["helper_archived", "binding_replaced"] as const) {
    const f = await fixture();
    try {
      f.state.loseReply = true;f.state.emitMessage = false;
      const input = {threadId: "helper", commandId: "unknown", messageId: "unknown-message", text: "Unknown outcome marker"};
      const transport = new SupervisorHelperTransport(f.options);
      assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "uncertain");
      if (refusal === "helper_archived") f.helper.thread.archivedAt = "2026-10-16T11:00:00Z";
      else f.store.setBinding({...f.binding, state: "missing"});
      assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "uncertain", refusal);
      assert.equal(f.state.posts, 1);
      const fresh = {...input, commandId: "never-posted", messageId: "never-posted-message"};
      assert.equal(await transport.send(f.binding, fresh, AbortSignal.timeout(1000)), "rejected", "nothing was posted for this identity");
      assert.equal(f.state.posts, 1);
    } finally {await f.cleanup();}
  }
});

test("accepted webhook without a native delivery identity remains uncertain without reposting", async () => {
  const f = await fixture();
  try {
    f.state.emitMessage = false;f.state.omitDeliveryId = true;
    const input = {threadId: "helper", commandId: "missing-receipt", messageId: "missing-receipt-message", text: "Retain this uncertain check-in"};
    const transport = new SupervisorHelperTransport(f.options);
    assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "uncertain");
    assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "uncertain");
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.webhookDeliveryLookups, 1);
  } finally {await f.cleanup();}
});

test("team runtime reconciles an accepted webhook receipt and surfaces native dispatch failure", async () => {
  const f = await fixture();
  try {
    f.state.emitMessage = false;
    const transport = new SupervisorHelperTransport(f.options);
    const team = teamRuntime(f, transport);
    team.runtime.startCycle(f.binding);
    await team.runtime.runHelperBatch(f.binding, team.threads, team.batch, AbortSignal.timeout(1000));
    const request = team.requests.pending("p", "helper");
    assert.ok(request);
    assert.equal(request?.state, "waiting");
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.webhookDeliveryLookups, 0);

    f.state.nativeOutcome = "dispatch_failed";
    team.requests.noticeSent("helper", 0);
    team.runtime.startCycle(f.binding);
    await team.runtime.reconcile(f.binding, team.threads, AbortSignal.timeout(1000));

    const failed = team.requests.requests("p", "helper").find(item => item.id === request?.id);
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.failureAcknowledged, undefined);
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.webhookDeliveryLookups, 1);
    assert.equal(f.team.unresolvedRequests(f.binding).find(item => item.requestId === request?.id), undefined);
    const partition = team.runtime.partition(f.binding, team.threads, team.batch[0]!.batch);
    assert.equal(partition.rootBatch, null);
    assert.ok(partition.rootEvents.some(event => event.kind === "service_attention" && event.memberThreadId === "helper"));
    await team.runtime.runHelperBatch(f.binding, team.threads, partition.helperBatches, AbortSignal.timeout(1000));
    assert.equal(f.state.posts, 1);
    assert.equal(team.requests.requests("p", "helper").length, 1);
  } finally {await f.cleanup();}
});

test("team runtime recovers an exact accepted delivery receipt after the POST reply is lost", async () => {
  const f = await fixture();
  try {
    f.state.emitMessage = false;f.state.loseReply = true;
    const transport = new SupervisorHelperTransport(f.options);
    const team = teamRuntime(f, transport);
    team.runtime.startCycle(f.binding);
    await team.runtime.runHelperBatch(f.binding, team.threads, team.batch, AbortSignal.timeout(1000));
    const original = team.requests.pending("p", "helper");
    assert.ok(original);
    assert.equal(original?.state, "uncertain");
    assert.equal(f.state.posts, 1);
    const body = f.state.lastPostedBody;
    assert.ok(body);
    const posted = JSON.parse(body!) as {batchId: string; text: string};
    addNativeWebhookDelivery(f, {id: "recovered-accepted-delivery", body: body!, renderedPrompt: posted.text, outcome: "accepted"});

    team.runtime.startCycle(f.binding);
    await team.runtime.reconcile(f.binding, team.threads, AbortSignal.timeout(1000));

    const current = team.requests.pending("p", "helper");
    assert.equal(current?.id, original?.id);
    assert.equal(current?.state, "waiting");
    const row = f.db.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
      .get(f.binding.threadId, f.binding.generation, original!.messageId);
    const delivery = JSON.parse(String(row?.document)) as {state: string; nativeDeliveryId?: string};
    assert.equal(delivery.state, "posted");
    assert.equal(delivery.nativeDeliveryId, "recovered-accepted-delivery");
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.webhookDeliveryLookups, 1);
    assert.equal(f.state.webhookDetailLookups, 1);
    assert.equal(f.team.unresolvedRequests(f.binding).find(item => item.requestId === original?.id)?.state, "uncertain");
  } finally {await f.cleanup();}
});

test("team runtime fails a lost-reply check-in only after exact native dispatch failure is recovered", async () => {
  const f = await fixture();
  try {
    f.state.emitMessage = false;f.state.loseReply = true;
    const transport = new SupervisorHelperTransport(f.options);
    const team = teamRuntime(f, transport);
    team.runtime.startCycle(f.binding);
    await team.runtime.runHelperBatch(f.binding, team.threads, team.batch, AbortSignal.timeout(1000));
    const original = team.requests.pending("p", "helper");
    assert.ok(original);
    assert.equal(original?.state, "uncertain");
    const body = f.state.lastPostedBody;
    assert.ok(body);
    const posted = JSON.parse(body!) as {batchId: string; text: string};
    addNativeWebhookDelivery(f, {id: "recovered-failed-delivery", body: body!, renderedPrompt: posted.text, outcome: "dispatch_failed"});

    team.runtime.startCycle(f.binding);
    await team.runtime.reconcile(f.binding, team.threads, AbortSignal.timeout(1000));

    const failed = team.requests.requests("p", "helper").find(item => item.id === original?.id);
    assert.equal(failed?.state, "failed");
    const row = f.db.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
      .get(f.binding.threadId, f.binding.generation, original!.messageId);
    const delivery = JSON.parse(String(row?.document)) as {state: string; nativeDeliveryId?: string};
    assert.equal(delivery.state, "rejected");
    assert.equal(delivery.nativeDeliveryId, "recovered-failed-delivery");
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.webhookDeliveryLookups, 1);
    assert.equal(f.state.webhookDetailLookups, 1);
    assert.equal(f.team.unresolvedRequests(f.binding).find(item => item.requestId === original?.id), undefined);
    assert.ok(team.runtime.partition(f.binding, team.threads, team.batch[0]!.batch).rootEvents.some(event =>
      event.kind === "service_attention" && event.memberThreadId === "helper"));
  } finally {await f.cleanup();}
});

test("a released waiting check-in reconciles its native failure without reposting before handover completes", async () => {
  const f = await fixture();
  try {
    f.state.emitMessage = false;
    const transport = new SupervisorHelperTransport(f.options);
    const team = teamRuntime(f, transport);
    team.runtime.startCycle(f.binding);
    await team.runtime.runHelperBatch(f.binding, team.threads, team.batch, AbortSignal.timeout(1000));
    const original = team.requests.pending("p", "helper");
    assert.ok(original);
    assert.equal(original?.state, "waiting");
    assert.equal(f.state.posts, 1);

    const parents = new Map<string, string | null>([["main", null], ["branch", "main"], ["helper", "main"]]);
    const transfer = f.team.assign(f.binding, "branch", null, parents);
    f.state.emitMessage = true;
    team.runtime.startCycle(f.binding);
    await team.runtime.reconcile(f.binding, team.threads, AbortSignal.timeout(1000));
    assert.equal(f.state.posts, 2, "only the release notice adds a POST");
    const releaseNotice = f.team.snapshot(f.binding).notifications.find(item =>
      item.kind === "handover_release" && item.assignmentRootThreadId === "branch" && item.assignmentEpoch === transfer.epoch);
    assert.equal(releaseNotice?.state, "delivered");
    assert.equal(team.requests.pending("p", "helper")?.id, original?.id);

    f.state.nativeOutcome = "dispatch_failed";
    team.runtime.startCycle(f.binding);
    await team.runtime.reconcile(f.binding, team.threads, AbortSignal.timeout(1000));
    const failed = team.requests.requests("p", "helper").find(item => item.id === original?.id);
    assert.equal(failed?.state, "failed");
    assert.equal(f.state.posts, 2);
    assert.equal(f.state.webhookDeliveryLookups, 2);
    assert.equal(f.team.unresolvedRequests(f.binding).find(item => item.requestId === original?.id), undefined);
    assert.ok(team.runtime.partition(f.binding, team.threads, team.batch[0]!.batch).rootEvents.some(event =>
      event.kind === "service_attention" && event.memberThreadId === "helper"));
    assert.equal(f.team.snapshot(f.binding).assignments.find(item => item.subtreeRootThreadId === "branch")?.state, "transferring");

    const userMessage = f.helper.messages.find(item => item.text === (JSON.parse(f.state.lastPostedBody ?? "null") as {text?: string} | null)?.text);
    assert.ok(userMessage);
    if (!userMessage || !releaseNotice) throw new Error("release_notice_message_missing");
    userMessage.runId = "release-notice-run";
    f.helper.runs.push({id: "release-notice-run", threadId: "helper", ordinal: 1, status: "completed",
      requestedAt: "2026-10-16T10:00:01Z", startedAt: "2026-10-16T10:00:01Z", completedAt: "2026-10-16T10:00:02Z",
      rootNodeId: null, userMessageId: userMessage.id});
    f.helper.messages.push({id: "release-notice-final", threadId: "helper", runId: "release-notice-run", nodeId: null, role: "assistant",
      text: "Release handover reviewed. Supervisor team notification " + releaseNotice.id + " attempt 0 completed",
      streaming: false, createdAt: "2026-10-16T10:00:02Z", updatedAt: "2026-10-16T10:00:02Z", ordinal: 1});

    team.runtime.startCycle(f.binding);
    await team.runtime.reconcile(f.binding, team.threads, AbortSignal.timeout(1000));
    assert.equal(f.team.snapshot(f.binding).notifications.find(item => item.id === releaseNotice.id)?.state, "acknowledged");
    assert.equal(f.team.coverage(f.binding, "branch", parents).state, "root");
    assert.equal(f.state.posts, 2);
  } finally {await f.cleanup();}
});

test("a pre-render native rejection is recoverable from its exact body receipt", async () => {
  const f = await fixture();
  try {
    f.state.emitMessage = false;f.state.loseReply = true;
    const transport = new SupervisorHelperTransport(f.options);
    const input = {threadId: "helper", commandId: "lost-disabled", messageId: "lost-disabled-message", text: "Exact disabled delivery body"};
    assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "uncertain");
    const body = f.state.lastPostedBody;
    assert.ok(body);
    addNativeWebhookDelivery(f, {id: "recovered-disabled-delivery", body: body!, renderedPrompt: null, outcome: "disabled"});

    assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "rejected");
    const row = f.db.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
      .get(f.binding.threadId, f.binding.generation, input.messageId);
    const delivery = JSON.parse(String(row?.document)) as {state: string; nativeDeliveryId?: string};
    assert.equal(delivery.state, "rejected");
    assert.equal(delivery.nativeDeliveryId, "recovered-disabled-delivery");
    assert.equal(f.state.posts, 1);
  } finally {await f.cleanup();}
});

test("wrong or ambiguous webhook bodies do not recover an unknown delivery identity", async () => {
  for (const mode of ["wrong_body", "wrong_rendered_prompt", "ambiguous_body"] as const) {
    const f = await fixture();
    try {
      f.state.emitMessage = false;f.state.loseReply = true;
      const transport = new SupervisorHelperTransport(f.options);
      const input = {threadId: "helper", commandId: "unknown-" + mode, messageId: "unknown-" + mode + "-message", text: "Check-in " + mode};
      assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "uncertain");
      const body = f.state.lastPostedBody;
      assert.ok(body);
      const posted = JSON.parse(body!) as {batchId: string; text: string};
      if (mode === "wrong_body") {
        const wrongBatchId = posted.batchId.slice(0, -1) + (posted.batchId.endsWith("x") ? "y" : "x");
        const wrongBody = JSON.stringify({...posted, batchId: wrongBatchId});
        addNativeWebhookDelivery(f, {id: "wrong-body-delivery", body: wrongBody, renderedPrompt: posted.text, outcome: "dispatch_failed"});
      } else if (mode === "wrong_rendered_prompt") {
        addNativeWebhookDelivery(f, {id: "wrong-rendered-prompt-delivery", body: body!, renderedPrompt: "different text", outcome: "dispatch_failed"});
      } else {
        addNativeWebhookDelivery(f, {id: "ambiguous-delivery-one", body: body!, renderedPrompt: posted.text, outcome: "accepted"});
        addNativeWebhookDelivery(f, {id: "ambiguous-delivery-two", body: body!, renderedPrompt: posted.text, outcome: "dispatch_failed"});
      }

      assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "uncertain");
      const row = f.db.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
        .get(f.binding.threadId, f.binding.generation, input.messageId);
      const delivery = JSON.parse(String(row?.document)) as {state: string; nativeDeliveryId?: string};
      assert.equal(delivery.state, "posting");
      assert.equal(delivery.nativeDeliveryId, undefined);
      assert.equal(f.state.posts, 1);
      assert.equal(f.state.webhookDeliveryLookups, 1);
      assert.equal(f.state.webhookDetailLookups, mode === "ambiguous_body" ? 2 : 1);
    } finally {await f.cleanup();}
  }
});

test("team runtime retains a lost webhook reply as uncertain and raises bounded root attention without reposting", async () => {
  const f = await fixture();
  try {
    f.state.emitMessage = false;f.state.loseReply = true;
    let now = Date.now();
    const transport = new SupervisorHelperTransport(f.options);
    const team = teamRuntime(f, transport, () => now);
    team.runtime.startCycle(f.binding);
    await team.runtime.runHelperBatch(f.binding, team.threads, team.batch, AbortSignal.timeout(1000));
    const original = team.requests.pending("p", "helper");
    assert.ok(original);
    assert.equal(original?.state, "uncertain");
    assert.equal(f.state.posts, 1);
    const originalMessageId = original!.messageId;
    const originalTeamRequest = f.team.unresolvedRequests(f.binding).find(item => item.requestId === original!.id);
    assert.equal(originalTeamRequest?.state, "uncertain");

    now = original!.sentAt! + SUPERVISOR_MONITOR_COOLDOWN_MS - 1;
    for (let cycle = 0; cycle < 15; cycle++) {
      team.requests.noticeSent("helper", 0);
      team.runtime.startCycle(f.binding);
      await team.runtime.reconcile(f.binding, team.threads, AbortSignal.timeout(1000));
    }
    assert.equal(f.team.snapshot(f.binding).events.some(event => event.kind === "service_attention" && event.summary.includes("no visible terminal native run")), false);

    now = original!.sentAt! + SUPERVISOR_MONITOR_COOLDOWN_MS + 1;
    for (let cycle = 0; cycle < 15; cycle++) {
      team.requests.noticeSent("helper", 0);
      team.runtime.startCycle(f.binding);
      await team.runtime.reconcile(f.binding, team.threads, AbortSignal.timeout(1000));
    }

    const current = team.requests.pending("p", "helper");
    assert.equal(current?.id, original?.id);
    assert.equal(current?.messageId, originalMessageId);
    assert.equal(current?.state, "uncertain");
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.webhookDeliveryLookups, 30);
    assert.equal(f.team.unresolvedRequests(f.binding).find(item => item.requestId === original?.id)?.state, "uncertain");
    const partition = team.runtime.partition(f.binding, team.threads, team.batch[0]!.batch);
    assert.equal(partition.rootBatch, null);
    assert.equal(partition.rootEvents.filter(event => event.kind === "service_attention" && event.summary.includes("no visible terminal native run")).length, 1);
    assert.equal(team.runtime.hasBlockingWork(f.binding), true);
  } finally {await f.cleanup();}
});

test("a disabled channel before first POST stays retry-blocked with bounded root attention", async () => {
  const f = await fixture();
  try {
    f.state.emitMessage = false;f.state.disableChannel = true;
    let now = Date.now();
    const transport = new SupervisorHelperTransport(f.options);
    const team = teamRuntime(f, transport, () => now);
    team.runtime.startCycle(f.binding);
    await team.runtime.runHelperBatch(f.binding, team.threads, team.batch, AbortSignal.timeout(1000));
    const original = team.requests.pending("p", "helper");
    assert.ok(original);
    assert.equal(original?.state, "prepared");
    assert.equal(original?.sentAt, null);
    assert.equal(f.state.posts, 0);

    now = original!.createdAt + SUPERVISOR_MONITOR_COOLDOWN_MS + 1;
    team.runtime.startCycle(f.binding);
    await team.runtime.reconcile(f.binding, team.threads, AbortSignal.timeout(1000));
    const current = team.requests.pending("p", "helper");
    assert.equal(current?.id, original?.id);
    assert.equal(current?.state, "prepared");
    assert.equal(f.state.posts, 0);
    assert.equal(f.team.snapshot(f.binding).events.filter(event => event.kind === "service_attention" &&
      event.summary.includes("no visible terminal native run")).length, 1);
    assert.equal(team.runtime.hasBlockingWork(f.binding), true);
  } finally {await f.cleanup();}
});

test("a missing channel after an accepted POST cannot prove non-delivery or unlock retry", async () => {
  const f = await fixture();
  try {
    f.state.emitMessage = false;
    let now = Date.now();
    const transport = new SupervisorHelperTransport(f.options);
    const team = teamRuntime(f, transport, () => now);
    team.runtime.startCycle(f.binding);
    await team.runtime.runHelperBatch(f.binding, team.threads, team.batch, AbortSignal.timeout(1000));
    const original = team.requests.pending("p", "helper");
    assert.ok(original);
    assert.equal(original?.state, "waiting");
    assert.equal(f.state.posts, 1);
    f.tasks.splice(0);

    now = original!.sentAt! + SUPERVISOR_MONITOR_COOLDOWN_MS + 1;
    team.runtime.startCycle(f.binding);
    await team.runtime.reconcile(f.binding, team.threads, AbortSignal.timeout(1000));
    const current = team.requests.pending("p", "helper");
    assert.equal(current?.id, original?.id);
    assert.equal(current?.messageId, original?.messageId);
    assert.equal(current?.state, "waiting");
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.webhookDeliveryLookups, 1);
    assert.equal(team.requests.requests("p", "helper").find(item => item.id === original?.id)?.failureAcknowledged, undefined);
    assert.equal(f.team.unresolvedRequests(f.binding).find(item => item.requestId === original?.id)?.state, "pending");
    assert.equal(f.team.snapshot(f.binding).events.filter(event => event.kind === "service_attention" &&
      event.summary.includes("no visible terminal native run")).length, 1);
    assert.equal(team.runtime.hasBlockingWork(f.binding), true);
  } finally {await f.cleanup();}
});

test("a manually changed native channel cannot redirect helper work or be silently overwritten", async () => {
  const f = await fixture();
  try {
    const transport = new SupervisorHelperTransport(f.options);
    const input = {threadId: "helper", commandId: "first", messageId: "first-message", text: "First check-in"};
    await transport.send(f.binding, input, AbortSignal.timeout(1000));
    f.tasks[0]!.threadId = "foreign-thread";
    assert.equal(await transport.send(f.binding, {...input, commandId: "second", messageId: "second-message", text: "Second check-in"}, AbortSignal.timeout(1000)), "busy");
    assert.equal(f.state.posts, 1);
    assert.equal(await transport.retire(f.binding, "helper", AbortSignal.timeout(1000)), false);
    assert.equal(f.tasks.length, 1);
  } finally {await f.cleanup();}
});
