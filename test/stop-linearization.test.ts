import assert from "node:assert/strict";
import { it, type TestContext } from "vitest";
import { after } from "./support/node-test.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import type { ConversationRequest } from "../src/supervisor-conversation-store.js";
import { helperDeliveryBody } from "../src/supervisor-helper-transport.js";
import { SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import { addDispatchedMessage, addTurn, baseTime, dashboard, helperBatch, helperReceipt, installToolCall, mainThreadId, nativeWrites, once, projectId,
  publishedWrapper, rpcRequests, seedIntroduction, seedTeam, sendJson, startLinFixture, teamEventRows, within, type Entry, type LinFixture, type LinOptions } from "./support/lin-fixture.js";

// stop/enable publication and send admission on the unchanged baseline: production controllers and stores on temp files, loopback T3 peer

const fixture = async (t: TestContext, options?: LinOptions): Promise<LinFixture> => {
  const f = await startLinFixture(options);
  after(t, f.close);
  return f;
};

const oldTurn = {id: "old-turn", text: "Earlier request before the boundary."};
const newTurn = {id: "new-turn", text: "Create a migration plan."};
const newRequest = {mainTurns: [oldTurn, newTurn]};
const newSource = {messageId: newTurn.id, runId: `run-${newTurn.id}`, ordinal: 2, text: newTurn.text};

const runOnce = (f: LinFixture) => within(f.core.supervision.runOnce(AbortSignal.timeout(8_000)), 9_000, "runOnce");
const deadline = () => AbortSignal.timeout(8_000);

const task = (f: LinFixture): TaskRecord => f.core.store.task(mainThreadId)!;
const requests = (f: LinFixture, supervisorThreadId: string): ConversationRequest[] =>
  f.core.supervision.conversation.requests.requests(projectId, supervisorThreadId);
const label = (entry: Entry): string => entry.kind === "rpc" ? `${entry.tag}${typeof entry.payload.type === "string" ? `:${entry.payload.type}` : ""}`
  : `${entry.method} ${entry.path}`;
const writes = (f: LinFixture): string[] => nativeWrites(f.peer).map(label);
const dispatches = (f: LinFixture) => rpcRequests(f.peer, "orchestration.dispatchCommand").map(entry => entry.payload);
const dispatched = (payload: Record<string, unknown>) => ({type: payload.type, commandId: payload.commandId, messageId: payload.messageId,
  threadId: payload.threadId, text: payload.text});

// commits a Stop when the first native command frame arrives, before the peer replies; records whether the commit was visible
const stopOnArrival = (f: LinFixture, tag = "orchestration.dispatchCommand") => {
  const seen = {stoppedAtArrival: null as boolean | null};
  const commit = (entry: Entry) => {
    if (entry.kind !== "rpc" || entry.tag !== tag || seen.stoppedAtArrival !== null) return false;
    f.stop();
    seen.stoppedAtArrival = f.stopped();
    return true;
  };
  return {seen, commit};
};

it("CT-LIN-01: helper: a Stop committed during the channel upsert fails the final guard; the send is busy, unposted and leaves no receipt", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const binding = f.bindSupervisor();
  seedTeam(f);
  let stoppedDuringUpsert = false;
  // the upsert is the transport's last await before the guard (supervisor-helper-transport.ts:244, :389)
  f.peer.onUpsert = () => {f.stop();stoppedDuringUpsert = f.stopped();};
  const result = await within(f.core.supervision.helperTransport.send(binding, {threadId: "helper", commandId: "supervisor-review:lin-helper",
    messageId: "supervisor-review:lin-helper", text: "Check in on the assigned branch."}, deadline()), 9_000, "helper send");
  assert.equal(stoppedDuringUpsert, true);
  assert.equal(result, "busy");
  assert.equal(helperReceipt(f), null);
  assert.deepEqual(writes(f), ["scheduledTasks.upsert"], "only the channel upsert that carried the Stop; no webhook POST");
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-01: Stop notice: an Enable committed during the Supervisor read fails the final guard; the ready notice is superseded unsent", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const binding = f.bindSupervisor();
  // an earlier Supervisor message in the main makes the notice due (supervisor-conversation.ts:1728-1730)
  f.main.messages.push({id: "supervisor-contact", threadId: mainThreadId, runId: null, nodeId: null, role: "user", text: "Supervisor update.",
    streaming: false, createdAt: baseTime, updatedAt: baseTime, senderThreadId: binding.threadId});
  f.stop();
  const notice = f.binding().stopNotice!;
  assert.equal(notice.state, "ready");
  let stateAtEnable: string | undefined;
  // the cycle reads the main (:1709), then the Supervisor last before the guard (:1735-1738)
  f.peer.onProjection = once((threadId: string) => threadId === binding.threadId, () => {
    stateAtEnable = f.binding().stopNotice?.state;
    f.enable();
  });
  await runOnce(f);
  assert.equal(stateAtEnable, "ready");
  assert.equal(f.stopped(), false);
  assert.deepEqual(f.binding().stopNotice, {...notice, state: "superseded"});
  assert.equal(f.binding().supervisionStop, undefined);
  assert.equal(typeof f.core.store.chatEnabledAt(mainThreadId), "number");
  assert.deepEqual(dispatches(f).filter(payload => payload.commandId === notice.commandId), []);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-01: introduction: a Stop committed during the Supervisor read fails the final guard; the introduction stays ready and unsent", {timeout: 10_000}, async t => {
  const f = await fixture(t, newRequest);
  const binding = f.bindSupervisor();
  const {introduction} = seedIntroduction(f, newSource);
  let definitionsRead = false;
  const definitions = f.definitions.current;
  f.definitions.current = threadId => {definitionsRead = true;return definitions(threadId);};
  // the Supervisor read after the definition read is the last await before the guard (supervisor-conversation.ts:1950-1979)
  f.peer.onProjection = once((threadId: string) => threadId === binding.threadId && definitionsRead, () => f.stop());
  await runOnce(f);
  assert.equal(f.stopped(), true);
  assert.deepEqual(f.core.supervision.conversation.requests.introduction(introduction.taskId), introduction);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-01: guide: a Stop committed during the ancestor read is denied by the assignment recheck with no receipt and no request", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const binding = f.bindSupervisor();
  // the target's parent is an operational child, so the walk rechecks the assignment after the parent read (supervisor-team-controller.ts:397, :407)
  const {helper, member, assignment} = seedTeam(f, {branchParent: "middle"});
  const payload = {supervisorThreadId: helper.thread.id, bindingGeneration: binding.generation, memberEpoch: member.epoch, assignmentRootThreadId: "branch",
    assignmentEpoch: assignment.epoch, operationId: "lin-guide-stop", targetThreadId: "branch", text: "Continue with the plan."};
  installToolCall(f, helper, workflowToolNames.guide.direct[0], payload);
  const events = f.core.supervision.team.snapshot(binding).events;
  let targetRead = false;
  const stopOnParentRead = once((threadId: string) => threadId === "middle" && targetRead, () => f.stop());
  f.peer.onProjection = threadId => {
    if (threadId === "branch") targetRead = true;
    stopOnParentRead(threadId);
  };
  const result = await within(f.endpoint.teamController.guide(payload, deadline()), 9_000, "guide");
  assert.equal(f.stopped(), true);
  assert.deepEqual(f.peer.log.filter(entry => entry.kind === "http").map(label).slice(-2),
    ["GET /api/orchestration/threads/branch", "GET /api/orchestration/threads/middle"], "the Stop landed during the parent read");
  assert.deepEqual(result, {status: "denied", reason: "guidance_assignment_changed"});
  assert.deepEqual(f.core.guidance.db.prepare("SELECT * FROM supervisor_team_tool_receipts").all(), []);
  assert.deepEqual(f.core.supervision.team.unresolvedRequests(binding), []);
  assert.deepEqual(f.core.supervision.team.snapshot(binding).events, events);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
});

// recorded target change (S6b): the escalation of a walk without a route runs in an admission section that rechecks the scope, so
// a Stop committed during the walk leaves no durable write
it("CT-LIN-01: guide: a Stop committed during the ancestor read of a guide whose target is directly under the main writes no escalation and the guide is denied guidance_assignment_changed", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const binding = f.bindSupervisor();
  // the target's parent is the main, so the main read is the walk's last await and the walk then ends without a route (supervisor-team-controller.ts:407, :414)
  const {helper, member, assignment} = seedTeam(f);
  const payload = {supervisorThreadId: helper.thread.id, bindingGeneration: binding.generation, memberEpoch: member.epoch, assignmentRootThreadId: "branch",
    assignmentEpoch: assignment.epoch, operationId: "lin-guide-direct-stop", targetThreadId: "branch", text: "Continue with the plan."};
  installToolCall(f, helper, workflowToolNames.guide.direct[0], payload);
  const before = teamEventRows(f);
  const assessmentBefore = f.core.supervision.team.snapshot(binding).members.find(value => value.threadId === "helper")?.lastAssessment;
  const order: Array<{step: string; stopped: boolean}> = [];
  let targetRead = false;
  const stopOnParentRead = once((threadId: string) => threadId === mainThreadId && targetRead, () => {
    f.stop();
    order.push({step: "stop", stopped: f.stopped()});
  });
  f.peer.onProjection = threadId => {
    if (threadId === "branch") targetRead = true;
    stopOnParentRead(threadId);
  };
  // records any escalation write, which runs in the escalation's admission section (supervisor-team-controller.ts:700-707)
  const team = f.core.supervision.team;
  const escalate = team.escalate.bind(team);
  team.escalate = (...args) => {
    order.push({step: "escalation", stopped: f.stopped()});
    return escalate(...args);
  };
  const result = await within(f.endpoint.teamController.guide(payload, deadline()), 9_000, "guide");
  assert.equal(f.stopped(), true);
  assert.deepEqual(f.peer.log.filter(entry => entry.kind === "http").map(label).slice(-2),
    ["GET /api/orchestration/threads/branch", "GET /api/orchestration/threads/main"], "the Stop landed during the main read");
  assert.deepEqual(result, {status: "denied", reason: "guidance_assignment_changed"});
  assert.deepEqual(order, [{step: "stop", stopped: true}], "the Stop commits first and no escalation write starts after it");
  assert.deepEqual(teamEventRows(f), before, "no team event row is written after the Stop");
  assert.equal(f.core.supervision.team.snapshot(binding).members.find(value => value.threadId === "helper")?.lastAssessment, assessmentBefore,
    "the helper's last assessment is unchanged");
  assert.equal(f.binding().supervisionStop!.route, "ui");
  assert.deepEqual(f.core.guidance.db.prepare("SELECT * FROM supervisor_team_tool_receipts").all(), []);
  assert.deepEqual(f.core.supervision.team.unresolvedRequests(binding), []);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-01: creation: a Stop committed during the fresh main read throws main_conversation_unavailable and launches nothing", {timeout: 10_000}, async t => {
  const f = await fixture(t, newRequest);
  let supervisorRead = false;
  const stopOnMainRead = once((threadId: string) => threadId === mainThreadId && supervisorRead, () => f.stop());
  // the reserved Supervisor reads 404, then readMain is the last await before the guard (project-supervisor.ts:1092, :1106-1107)
  f.peer.onProjection = threadId => {
    if (threadId.startsWith("supervisor-root:")) supervisorRead = true;
    stopOnMainRead(threadId);
  };
  // ensureBinding is private and its callers swallow its error (project-supervisor.ts:787, :1069, :1190)
  const supervision = f.core.supervision as unknown as {ensureBinding(projectId: string, mainThreadId: string, title: string, signal: AbortSignal): Promise<unknown>};
  await assert.rejects(within(supervision.ensureBinding(projectId, mainThreadId, "main", deadline()), 9_000, "ensureBinding"), {message: "main_conversation_unavailable"});
  assert.equal(f.stopped(), true);
  assert.equal(f.binding().state, "creating");
  assert.equal(f.binding().creationAttempts, 0);
  assert.deepEqual(writes(f), []);
  await runOnce(f);
  assert.equal(f.binding().creationAttempts, 0);
  assert.deepEqual(writes(f), [], "a later cycle of the stopped chat launches nothing");
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-01: stopped settlement: an Enable committed during the fresh Supervisor read leaves the settlement unsent", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const binding = f.bindSupervisor();
  f.stop();
  let supervisorReads = 0;
  // check() reads the Supervisor (supervisor-lifecycle.ts:271); settleStopped re-reads it last before the guard (:390, :395)
  f.peer.onProjection = threadId => {if (threadId === binding.threadId && ++supervisorReads === 2) f.enable();};
  await within(f.core.supervision.lifecycle.check(f.binding(), f.threads, deadline()), 9_000, "check");
  assert.equal(supervisorReads, 2);
  assert.equal(f.stopped(), false);
  assert.equal(f.binding().settlement, undefined);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
});

type PolicyProbe = {stopped: boolean; stop: unknown; notice: string | null; enabledAt: number | null; start: string | null};

const observe = (f: LinFixture): PolicyProbe => ({stopped: f.core.policy.get().excludedThreadIds.includes(mainThreadId),
  stop: f.core.store.chatStop(mainThreadId) ?? null, notice: f.core.store.binding(projectId, mainThreadId)?.stopNotice?.state ?? null,
  enabledAt: f.core.store.chatEnabledAt(mainThreadId), start: f.core.store.start(mainThreadId)?.status ?? null});

// every policy commit queues a probe that runs as soon as the committing turn yields (thread-policy.ts:25-33)
const probePolicyCommits = (f: LinFixture): PolicyProbe[] => {
  const seen: PolicyProbe[] = [];
  const save = f.core.policy.save.bind(f.core.policy);
  f.core.policy.save = input => {
    const saved = save(input);
    queueMicrotask(() => seen.push(observe(f)));
    return saved;
  };
  return seen;
};

it("CT-LIN-02: each MCP, Settings and dashboard Stop or Enable commit is observed only together with its guidance bookkeeping", {timeout: 10_000}, async t => {
  const f = await fixture(t, {mainTurns: [oldTurn, {id: "stop-turn", text: "Please stop supervising this chat."}]});
  const binding = f.bindSupervisor();
  const seen = probePolicyCommits(f);
  const policyGeneration = () => f.core.policy.get().generation;

  // the MCP supervision_stop (project-supervisor.ts:980-985)
  const stopped = await f.core.supervision.stopSupervision({callerThreadId: binding.threadId, targetThreadId: mainThreadId, userMessageId: "stop-turn",
    operationId: "lin-stop"}, {}, deadline());
  assert.deepEqual(stopped, {status: "stopped", targetThreadId: mainThreadId, route: "relay", alreadyStopped: false});
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {stopped: true, stop: {route: "relay", callerThreadId: binding.threadId, userMessageId: "stop-turn", stoppedAt: Date.parse(baseTime)},
    notice: "ready", enabledAt: null, start: null});

  // the Settings excluded-chat editor's Enable and Stop (:997-1001)
  f.enable();
  await Promise.resolve();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], {...observe(f), stopped: false, stop: null, notice: "superseded"});
  assert.equal(typeof seen[1]!.enabledAt, "number");
  f.stop();
  await Promise.resolve();
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[2], {...observe(f), stopped: true, notice: "ready", enabledAt: seen[1]!.enabledAt});
  assert.equal((seen[2]!.stop as {route: string}).route, "ui");

  // the dashboard Enable and Stop (:1014-1020)
  const enabled = await f.core.supervision.setChatSupervision({projectId, mainThreadId, enabled: true, policyGeneration: policyGeneration()}, deadline());
  assert.equal(enabled.status, "saved");
  assert.equal(seen.length, 4);
  assert.deepEqual(seen[3], {...observe(f), stopped: false, stop: null, notice: "superseded"});
  assert.ok(seen[3]!.enabledAt! >= seen[1]!.enabledAt!);
  const stoppedAgain = await f.core.supervision.setChatSupervision({projectId, mainThreadId, enabled: false, policyGeneration: policyGeneration()}, deadline());
  assert.equal(stoppedAgain.status, "saved");
  assert.equal(seen.length, 5);
  assert.deepEqual(seen[4], {...observe(f), stopped: true, notice: "ready", enabledAt: seen[3]!.enabledAt});
  assert.equal((seen[4]!.stop as {route: string}).route, "ui");
});

it("CT-LIN-02: a dashboard Start activation's policy commit is observed only together with the Enable record and the active Start", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  // the project is the managed scratch root, so the chat is a No Project chat activated by Start (project-supervisor.ts:369-372)
  f.core.config.managedScratchRoot = "/work/p";
  const policy = f.core.policy.get();
  f.core.policy.save({...policy, excludedThreadIds: [mainThreadId]});
  f.core.store.saveUnboundStop(mainThreadId, {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: Date.now() - 60_000});
  const seen = probePolicyCommits(f);
  const result = await f.core.supervision.setChatSupervision({projectId, mainThreadId, enabled: true, policyGeneration: f.core.policy.get().generation}, deadline());
  assert.equal(result.status, "saved");
  const start = f.core.store.start(mainThreadId)!;
  assert.equal(start.status, "active");
  // the policy write (:673) and the bookkeeping (:675-677) share one guidance transaction
  assert.deepEqual(seen, [{stopped: false, stop: null, notice: null, enabledAt: start.intentAt, start: "active"}]);
});

it("CT-LIN-03: a dashboard Stop whose notice bookkeeping fails keeps the policy stop; sends stay fenced, a retry conflicts, settlement dates from observation and an MCP replay records the stop", {timeout: 10_000}, async t => {
  const f = await fixture(t, {mainTurns: [oldTurn, {id: "stop-turn", text: "Please stop supervising this chat."}]});
  const binding = f.bindSupervisor();
  const checkIn = f.core.supervision.conversation.requests.prepare({projectId, supervisorThreadId: binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, Date.now());
  const setStopNotice = f.core.store.setStopNotice.bind(f.core.store);
  let noticeWrites = 0;
  f.core.store.setStopNotice = (...args) => {
    if (noticeWrites++ === 0) throw new Error("injected_stop_notice_failure");
    setStopNotice(...args);
  };
  const ui = await dashboard(f);
  const path = "/api/guidance/project-supervisor/chat-supervision";
  const generation = f.core.policy.get().generation;
  const first = await ui.post(path, {projectId, mainThreadId, enabled: false, policyGeneration: generation});
  assert.equal(first.status, 400);
  assert.deepEqual(first.body, {_tag: "UiError", message: "The chat supervision change could not be confirmed. Refresh to inspect the saved state."});
  assert.equal(f.stopped(), true);
  assert.equal(f.core.policy.get().generation, generation + 1);
  assert.equal(f.binding().supervisionStop, undefined, "the per-binding transaction rolled back (project-supervisor.ts:909-917)");
  assert.equal(f.binding().stopNotice, undefined);

  const retry = await ui.post(path, {projectId, mainThreadId, enabled: false, policyGeneration: generation});
  assert.equal(retry.status, 200);
  assert.equal((retry.body as {status: string}).status, "conflict");
  assert.equal((retry.body as {message: string}).message, "Chat settings changed in another tab or by the Supervisor. The saved state is shown.");
  assert.equal(noticeWrites, 1, "the retry does not rerun the bookkeeping");
  assert.equal(f.binding().supervisionStop, undefined);

  await runOnce(f);
  const fenced = requests(f, binding.threadId).find(request => request.id === checkIn.id)!;
  assert.equal(fenced.state, "failed");
  assert.equal(fenced.error, "Supervision was stopped for this chat before this check-in was sent; it was not sent.");
  assert.equal(f.core.store.task(mainThreadId), null, "the new human request is not interpreted");
  const settled = f.binding();
  assert.equal(typeof settled.stopObservedAt, "number", "without a stop record the settlement dates from its observation (supervisor-lifecycle.ts:376-379)");
  assert.equal(settled.settlement?.state, "settled");
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId})),
    [{type: "thread.settle", commandId: settled.settlement!.commandId}], "no message is sent; only the Supervisor is settled");

  // an MCP stop replay finds no recorded stop and reruns the bookkeeping (:983-985)
  const replay = await f.core.supervision.stopSupervision({callerThreadId: binding.threadId, targetThreadId: mainThreadId, userMessageId: "stop-turn",
    operationId: "lin-replay"}, {}, deadline());
  assert.deepEqual(replay, {status: "stopped", targetThreadId: mainThreadId, route: "relay", alreadyStopped: true});
  assert.equal(f.core.policy.get().generation, generation + 1, "the replay writes no policy");
  const recorded = f.binding();
  assert.deepEqual(recorded.supervisionStop, {route: "relay", callerThreadId: binding.threadId, userMessageId: "stop-turn", stoppedAt: Date.parse(baseTime)});
  assert.equal(recorded.stopNotice?.state, "ready");
  assert.equal(recorded.stopObservedAt, undefined);
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-03: a dashboard Enable whose bookkeeping fails keeps a stale enable time, so a request written while stopped is interpreted", {timeout: 10_000}, async t => {
  const prepare = async (failEnable: boolean) => {
    const f = await fixture(t);
    f.bindSupervisor();
    f.stop();
    const stoppedAt = f.binding().supervisionStop!.stoppedAt;
    addTurn(f.main, {id: "stopped-turn", text: "Request written while supervision was stopped.", createdAt: new Date(stoppedAt).toISOString()});
    const recordChatEnable = f.core.store.recordChatEnable.bind(f.core.store);
    f.core.store.recordChatEnable = (...args) => {
      if (failEnable) throw new Error("injected_enable_failure");
      recordChatEnable(...args);
    };
    const ui = await dashboard(f);
    const reply = await ui.post("/api/guidance/project-supervisor/chat-supervision", {projectId, mainThreadId, enabled: true,
      policyGeneration: f.core.policy.get().generation});
    return {f, reply, stoppedAt};
  };

  const failed = await prepare(true);
  assert.equal(failed.reply.status, 400);
  assert.deepEqual(failed.reply.body, {_tag: "UiError", message: "The chat supervision change could not be confirmed. Refresh to inspect the saved state."});
  assert.equal(failed.f.stopped(), false);
  assert.equal(failed.f.core.store.chatEnabledAt(mainThreadId), null);
  assert.equal(failed.f.binding().supervisionStop?.stoppedAt, failed.stoppedAt, "the stop record was not cleared");
  assert.equal(failed.f.binding().stopNotice?.state, "ready", "the notice was not superseded");
  await runOnce(failed.f);
  const interpreted = task(failed.f);
  assert.equal(interpreted.sourceMessageId, "stopped-turn");
  assert.equal(interpreted.status, "waiting");
  assert.deepEqual(dispatches(failed.f).map(payload => payload.commandId), [`supervisor-objective:${interpreted.id}`]);

  // control: a complete Enable records its time, and the same request is not interpreted (project-supervisor.ts:1179)
  const enabled = await prepare(false);
  assert.equal(enabled.reply.status, 200);
  assert.ok(enabled.f.core.store.chatEnabledAt(mainThreadId)! >= enabled.stoppedAt);
  await runOnce(enabled.f);
  assert.equal(enabled.f.core.store.task(mainThreadId), null);
  assert.deepEqual(dispatches(enabled.f), []);
});

it("CT-LIN-04: interpretation: a Stop committed right after the dispatching receipt is fenced by the guard; the task returns to queued unsent", {timeout: 10_000}, async t => {
  const f = await fixture(t, newRequest);
  f.bindSupervisor();
  const saveTask = f.core.store.saveTask.bind(f.core.store);
  let receipt: TaskRecord | null = null;
  // the receipt write returns, then the Stop is saved before the guard runs (project-supervisor.ts:1350, :1355-1358)
  f.core.store.saveTask = (value: TaskRecord) => {
    saveTask(value);
    if (value.status === "dispatching" && receipt === null) {
      receipt = value;
      f.stop();
    }
  };
  await runOnce(f);
  assert.ok(receipt);
  assert.equal(typeof (receipt as TaskRecord).dispatchedAt, "number");
  const fenced = task(f);
  assert.equal(fenced.id, (receipt as TaskRecord).id);
  assert.equal(fenced.status, "queued");
  assert.equal(fenced.dispatchedAt, null);
  assert.equal(fenced.reason, "Supervision was stopped for this chat before dispatch; this task identity remains unsent.");
  assert.deepEqual(dispatches(f), []);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-06: interpretation: a Stop committed when the frame arrives keeps the accepted identity, later cycles only observe it", {timeout: 10_000}, async t => {
  const f = await fixture(t, newRequest);
  const binding = f.bindSupervisor();
  const {seen, commit} = stopOnArrival(f);
  let runId = "";
  // the peer records the accepted message and starts its run, as T3 does
  f.peer.onRpc = entry => {if (commit(entry)) runId = addDispatchedMessage(f.supervisor(), entry.payload);return undefined;};
  await runOnce(f);
  assert.equal(seen.stoppedAtArrival, true);
  const sent = task(f);
  assert.equal(sent.status, "waiting");
  assert.equal(sent.reason, "T3 accepted the interpretation request; waiting for its result.");
  assert.deepEqual(dispatches(f).map(dispatched), [{type: "message.dispatch", commandId: `supervisor-objective:${sent.id}`, messageId: sent.messageId,
    threadId: binding.threadId, text: sent.requestText}]);

  f.peer.onRpc = null;
  await runOnce(f);
  assert.deepEqual(task(f), sent, "a running native outcome is only observed");
  const run = f.supervisor().runs.find(value => value.id === runId)!;
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  await runOnce(f);
  const closed = task(f);
  assert.equal(closed.id, sent.id);
  assert.equal(closed.supervisorRunId, runId);
  assert.equal(closed.status, "unavailable");
  assert.equal(closed.reason, "Supervision was stopped for this chat; the interpretation result was not applied.");
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId})), [
    {type: "message.dispatch", commandId: `supervisor-objective:${sent.id}`},
    {type: "thread.settle", commandId: f.binding().settlement!.commandId},
  ], "no replay and no new identity; the stopped Supervisor settles once the outcome is known");
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-06: interpretation: a Stop committed when the frame arrives and a lost reply leave the identity uncertain, never resent", {timeout: 10_000}, async t => {
  const f = await fixture(t, newRequest);
  f.bindSupervisor();
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => commit(entry) ? {drop: true} : undefined;
  await runOnce(f);
  assert.equal(seen.stoppedAtArrival, true);
  const sent = task(f);
  assert.equal(sent.status, "uncertain");
  assert.equal(sent.reason, "Interpretation dispatch is uncertain; retry native access to reconcile the original request identity.");
  assert.deepEqual(dispatches(f).map(payload => payload.commandId), [`supervisor-objective:${sent.id}`]);
  f.peer.onRpc = null;
  await runOnce(f);
  assert.deepEqual(task(f), sent);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch"]);
  assert.equal(f.binding().settlementBlockedBy, "stopped_interpretation_unresolved");
});

it("CT-LIN-06: root check-in: a Stop committed when the frame arrives keeps the accepted identity; later cycles match its run without resending", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const binding = f.bindSupervisor();
  const prepared = f.core.supervision.conversation.requests.prepare({projectId, supervisorThreadId: binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, Date.now());
  const {seen, commit} = stopOnArrival(f);
  let runId = "";
  f.peer.onRpc = entry => {if (commit(entry)) runId = addDispatchedMessage(f.supervisor(), entry.payload);return undefined;};
  await runOnce(f);
  assert.equal(seen.stoppedAtArrival, true);
  const sent = requests(f, binding.threadId).find(request => request.id === prepared.id)!;
  assert.equal(sent.state, "waiting");
  assert.equal(typeof sent.sentAt, "number");
  assert.deepEqual(dispatches(f).map(dispatched), [{type: "message.dispatch", commandId: `supervisor-review:${prepared.id}`, messageId: prepared.messageId,
    threadId: binding.threadId, text: prepared.text}]);
  f.peer.onRpc = null;
  await runOnce(f);
  assert.deepEqual(requests(f, binding.threadId), [{...sent, runId}]);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch"]);
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-06: root check-in: a Stop committed when the frame arrives and a lost reply leave the identity uncertain, never resent", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const binding = f.bindSupervisor();
  const prepared = f.core.supervision.conversation.requests.prepare({projectId, supervisorThreadId: binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, Date.now());
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => commit(entry) ? {drop: true} : undefined;
  await runOnce(f);
  assert.equal(seen.stoppedAtArrival, true);
  const sent = requests(f, binding.threadId).find(request => request.id === prepared.id)!;
  assert.equal(sent.state, "uncertain");
  assert.equal(sent.error, "Supervisor request delivery is uncertain; its original identity is retained and only observed, never resent.");
  f.peer.onRpc = null;
  await runOnce(f);
  assert.deepEqual(requests(f, binding.threadId), [sent]);
  assert.deepEqual(dispatches(f).map(payload => payload.commandId), [`supervisor-review:${prepared.id}`]);
});

it("CT-LIN-06: introduction: a Stop committed when the frame arrives keeps the accepted introduction; later cycles never resend it", {timeout: 10_000}, async t => {
  const f = await fixture(t, newRequest);
  f.bindSupervisor();
  const {introduction} = seedIntroduction(f, newSource);
  const {seen, commit} = stopOnArrival(f);
  // the peer queues the introduction after the active run, as T3 does; it completes before the next cycle
  f.peer.onRpc = entry => {if (commit(entry)) addDispatchedMessage(f.main, entry.payload, "completed");return undefined;};
  await runOnce(f);
  assert.equal(seen.stoppedAtArrival, true);
  const accepted = f.core.supervision.conversation.requests.introduction(introduction.taskId)!;
  assert.equal(accepted.state, "accepted");
  assert.equal(typeof accepted.acceptedAt, "number");
  assert.deepEqual(accepted.dispatchMode, {type: "queue_after_active"});
  assert.deepEqual(dispatches(f).map(dispatched), [{type: "message.dispatch", commandId: `supervisor-workflow:${introduction.taskId}`,
    messageId: introduction.messageId, threadId: mainThreadId, text: introduction.text}]);
  f.peer.onRpc = null;
  await runOnce(f);
  await runOnce(f);
  assert.deepEqual(f.core.supervision.conversation.requests.introduction(introduction.taskId), accepted);
  // the Stop then produces exactly one operative notice, after the introduction became visible, and the Supervisor settles
  const notice = f.binding().stopNotice!;
  assert.equal(notice.state, "accepted");
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId, threadId: payload.threadId})), [
    {type: "message.dispatch", commandId: `supervisor-workflow:${introduction.taskId}`, threadId: mainThreadId},
    {type: "message.dispatch", commandId: notice.commandId, threadId: mainThreadId},
    {type: "thread.settle", commandId: f.binding().settlement!.commandId, threadId: f.binding().threadId},
  ]);
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-06: guide: a Stop committed when the steer frame arrives keeps the accepted guide record and sends no other route", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const binding = f.bindSupervisor();
  const {helper, member, assignment} = seedTeam(f);
  const payload = {supervisorThreadId: helper.thread.id, bindingGeneration: binding.generation, memberEpoch: member.epoch, assignmentRootThreadId: "branch",
    assignmentEpoch: assignment.epoch, operationId: "lin-guide-sent", targetThreadId: "branch", text: "Continue with the plan."};
  installToolCall(f, helper, workflowToolNames.guide.direct[0], payload);
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => {commit(entry);return undefined;};
  const result = await within(f.endpoint.teamController.guide(payload, deadline()), 9_000, "guide") as {status: string; requestId: string; commandId: string;
    messageId: string};
  assert.equal(seen.stoppedAtArrival, true);
  assert.equal(result.status, "accepted");
  assert.equal(result.commandId, `${result.requestId}:command:0`);
  assert.deepEqual(dispatches(f).map(value => ({...dispatched(value), dispatchMode: value.dispatchMode})), [{type: "message.dispatch",
    commandId: result.commandId, messageId: result.messageId, threadId: "branch", text: payload.text, dispatchMode: {type: "steer_active", targetRunId: "branch-run"}}]);
  const receipts = () => f.core.guidance.db.prepare("SELECT document FROM supervisor_team_tool_receipts").all().map(row => JSON.parse(String(row.document)) as unknown);
  assert.deepEqual(receipts(), [result]);
  assert.deepEqual(f.core.supervision.team.unresolvedRequests(binding).map(request => ({requestId: request.requestId, state: request.state})),
    [{requestId: result.requestId, state: "pending"}]);
  f.peer.onRpc = null;
  await runOnce(f);
  assert.deepEqual(receipts(), [result]);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch"]);
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-06: settlement: a Stop committed when the settle frame arrives keeps the settled identity; later cycles send no other settlement", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const binding = f.bindSupervisor();
  // a closed not-needed task leaves nothing to supervise, so the quiet Supervisor settles (supervisor-lifecycle.ts:124-137)
  f.core.store.saveTask({id: "task-done", threadId: mainThreadId, projectId, sourceRunId: `run-${oldTurn.id}`, sourceMessageId: oldTurn.id, sourceOrdinal: 1,
    sourceHash: "not-needed", status: "not_supervised", objective: null, reason: "Supervision is not needed.", updatedAt: Date.now(), requestText: "",
    supervisorThreadId: binding.threadId, messageId: "supervisor-objective:task-done", supervisorRunId: null, dispatchedAt: null, replayCount: 0});
  const now = Date.now();
  await within(f.core.supervision.lifecycle.check(f.binding(), f.threads, deadline(), now), 9_000, "check");
  assert.equal(f.binding().settlementBlockedBy, "quiet_window");
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => {commit(entry);return undefined;};
  await within(f.core.supervision.lifecycle.check(f.binding(), f.threads, deadline(), now + SUPERVISOR_SETTLE_QUIET_MS), 9_000, "check");
  assert.equal(seen.stoppedAtArrival, true);
  const settlement = f.binding().settlement!;
  assert.equal(settlement.state, "settled");
  assert.equal(settlement.attempts, 1);
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId, threadId: payload.threadId})),
    [{type: "thread.settle", commandId: settlement.commandId, threadId: binding.threadId}]);
  f.peer.onRpc = null;
  await runOnce(f);
  assert.deepEqual(f.binding().settlement, settlement);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:thread.settle"]);
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-LIN-06: helper: a Stop committed when the webhook POST arrives keeps the posted delivery; later cycles post nothing", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const binding = f.bindSupervisor();
  const {helper} = seedTeam(f);
  const threads = [helper.thread, ...f.threads];
  const runtime = f.core.supervision.conversation.teamRuntime!;
  const batches = runtime.partition(binding, threads, helperBatch("branch")).helperBatches;
  let stoppedAtArrival: boolean | null = null;
  f.peer.webhook = (_entry, _request, response, deliveryId) => {
    f.stop();
    stoppedAtArrival = f.stopped();
    sendJson(response, 202, {deliveryId});
  };
  runtime.startCycle(f.binding());
  await within(runtime.runHelperBatch(f.binding(), threads, batches, deadline()), 9_000, "helper batch");
  assert.equal(stoppedAtArrival, true);
  const request = requests(f, "helper").find(value => value.id.startsWith("team-review:"))!;
  assert.equal(request.state, "waiting");
  const receipt = helperReceipt(f)!;
  assert.equal(receipt.state, "posted");
  assert.equal(receipt.nativeDeliveryId, "native-delivery-1");
  assert.equal(receipt.messageId, request.messageId);
  const posts = f.peer.log.filter((entry): entry is Extract<Entry, {kind: "http"}> => entry.kind === "http" && entry.method === "POST");
  assert.deepEqual(posts.map(entry => entry.body), [helperDeliveryBody(request.messageId, request.text)]);
  await runOnce(f);
  const observed = helperReceipt(f)!;
  assert.deepEqual({...observed, renderedText: undefined}, {...receipt, renderedText: undefined}, "the stopped cycle binds the rendering only");
  assert.equal(observed.renderedText, publishedWrapper(request.text));
  assert.equal(requests(f, "helper").find(value => value.id === request.id)?.messageId, request.messageId);
  assert.deepEqual(writes(f), ["scheduledTasks.upsert", "POST /api/hooks/fixture/fixture-only-token"]);
  assert.deepEqual(f.peer.unexpected, []);
});
