import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Effect, Fiber, FiberSet } from "effect";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import type { ConversationRequest } from "../src/supervisor-conversation-store.js";
import { helperDeliveryBody } from "../src/supervisor-helper-transport.js";
import { SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import { interpose, rows } from "./support/glinint-wiring.js";
import { json } from "./support/int-native-peer.js";
import { addDispatchedMessage, addTurn, atWallClock, baseTime, dashboard, helperBatch, helperReceipt, installToolCall, mainThreadId, nativeWrites, once, projectId,
  publishedWrapper, rpcRequests, seedIntroduction, seedTeam, startLinFixture, teamEventRows, type Entry, type LinFixture } from "./support/lin-fixture.js";

// stop/enable publication and send admission on the production run: production controllers and stores on temp files, loopback T3
// peer. it.live: every case drives the run over the peer's real HTTP and websocket sockets and the real sqlite files; no case
// waits on time it controls (the settlement's quiet window is a wall-clock stamp of the one call)

const oldTurn = {id: "old-turn", text: "Earlier request before the boundary."};
const newTurn = {id: "new-turn", text: "Create a migration plan."};
const newRequest = {mainTurns: [oldTurn, newTurn]};
const newSource = {messageId: newTurn.id, runId: `run-${newTurn.id}`, ordinal: 2, text: newTurn.text};

const task = (f: LinFixture): Effect.Effect<TaskRecord> => Effect.map(f.core.store.task(mainThreadId), (value) => value!).pipe(Effect.orDie);
const requests = (f: LinFixture, supervisorThreadId: string): Effect.Effect<ConversationRequest[]> =>
  f.core.requests.requests(projectId, supervisorThreadId).pipe(Effect.orDie);
const label = (entry: Entry): string => entry.kind === "rpc" ? `${entry.tag}${typeof entry.payload.type === "string" ? `:${entry.payload.type}` : ""}`
  : `${entry.method} ${entry.path}`;
const writes = (f: LinFixture): string[] => nativeWrites(f.peer).map(label);
const dispatches = (f: LinFixture) => rpcRequests(f.peer, "orchestration.dispatchCommand").map(entry => entry.payload);
const dispatched = (payload: Record<string, unknown>) => ({type: payload.type, commandId: payload.commandId, messageId: payload.messageId,
  threadId: payload.threadId, text: payload.text});

// commits a Stop when the first native command frame arrives, before the peer replies; records whether the commit was visible
const stopOnArrival = (f: LinFixture, tag = "orchestration.dispatchCommand") => {
  const seen = {stoppedAtArrival: null as boolean | null};
  let arrived = false;
  const commit = (entry: Entry): Effect.Effect<boolean> => Effect.suspend(() => {
    if (entry.kind !== "rpc" || entry.tag !== tag || arrived) return Effect.succeed(false);
    arrived = true;
    return Effect.gen(function* () {
      yield* f.stop();
      seen.stoppedAtArrival = yield* f.stopped();
      return true;
    });
  });
  return {seen, commit};
};

it.live("CT-LIN-01: helper: a Stop committed during the channel upsert fails the final guard; the send is busy, unposted and leaves no receipt", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  const binding = yield* f.bindSupervisor;
  yield* seedTeam(f);
  let stoppedDuringUpsert = false;
  // the upsert is the transport's last await before the guard (supervisor-helper-transport.ts:244, :389)
  f.peer.onUpsert = Effect.gen(function* () {
    yield* f.stop();
    stoppedDuringUpsert = yield* f.stopped();
  });
  const result = yield* f.core.helperTransport.send(binding, {threadId: "helper", commandId: "supervisor-review:lin-helper",
    messageId: "supervisor-review:lin-helper", text: "Check in on the assigned branch."});
  assert.equal(stoppedDuringUpsert, true);
  assert.equal(result, "busy");
  assert.equal(yield* helperReceipt(f), null);
  assert.deepEqual(writes(f), ["scheduledTasks.upsert"], "only the channel upsert that carried the Stop; no webhook POST");
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-01: Stop notice: an Enable committed during the Supervisor read fails the final guard; the ready notice is superseded unsent", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  const binding = yield* f.bindSupervisor;
  // an earlier Supervisor message in the main makes the notice due (supervisor-conversation.ts:1728-1730)
  f.main.messages.push({id: "supervisor-contact", threadId: mainThreadId, runId: null, nodeId: null, role: "user", text: "Supervisor update.",
    streaming: false, createdAt: baseTime, updatedAt: baseTime, senderThreadId: binding.threadId});
  yield* f.stop();
  const notice = (yield* f.binding).stopNotice!;
  assert.equal(notice.state, "ready");
  let stateAtEnable: string | undefined;
  // the cycle reads the main (:1709), then the Supervisor last before the guard (:1735-1738)
  f.peer.onProjection = once((threadId: string) => threadId === binding.threadId, Effect.gen(function* () {
    stateAtEnable = (yield* f.binding).stopNotice?.state;
    yield* f.enable();
  }));
  yield* f.runOnce;
  assert.equal(stateAtEnable, "ready");
  assert.equal(yield* f.stopped(), false);
  assert.deepEqual((yield* f.binding).stopNotice, {...notice, state: "superseded"});
  assert.equal((yield* f.binding).supervisionStop, undefined);
  assert.equal(typeof (yield* f.core.store.chatEnabledAt(mainThreadId)), "number");
  assert.deepEqual(dispatches(f).filter(payload => payload.commandId === notice.commandId), []);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-01: introduction: a Stop committed during the Supervisor read fails the final guard; the introduction stays ready and unsent", () => Effect.gen(function* () {
  const f = yield* startLinFixture(newRequest);
  const binding = yield* f.bindSupervisor;
  const {introduction} = yield* seedIntroduction(f, newSource);
  let definitionsRead = false;
  const definitions = f.definitions.current;
  f.definitions.current = threadId => {definitionsRead = true;return definitions(threadId);};
  // the Supervisor read after the definition read is the last await before the guard (supervisor-conversation.ts:1950-1979)
  f.peer.onProjection = once((threadId: string) => threadId === binding.threadId && definitionsRead, f.stop());
  yield* f.runOnce;
  assert.equal(yield* f.stopped(), true);
  assert.deepEqual(yield* f.core.requests.introduction(introduction.taskId), introduction);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-01: guide: a Stop committed during the ancestor read is denied by the assignment recheck with no receipt and no request", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  const binding = yield* f.bindSupervisor;
  // the target's parent is an operational child, so the walk rechecks the assignment after the parent read (supervisor-team-controller.ts:397, :407)
  const {helper, member, assignment} = yield* seedTeam(f, {branchParent: "middle"});
  const payload = {supervisorThreadId: helper.thread.id, bindingGeneration: binding.generation, memberEpoch: member.epoch, assignmentRootThreadId: "branch",
    assignmentEpoch: assignment.epoch, operationId: "lin-guide-stop", targetThreadId: "branch", text: "Continue with the plan."};
  installToolCall(f, helper, workflowToolNames.guide.direct[0], payload);
  const events = (yield* f.core.team.snapshot(binding)).events;
  let targetRead = false;
  const stopOnParentRead = once((threadId: string) => threadId === "middle" && targetRead, f.stop());
  f.peer.onProjection = threadId => {
    if (threadId === "branch") targetRead = true;
    return stopOnParentRead(threadId);
  };
  const result = yield* f.core.teamController.guide(payload);
  assert.equal(yield* f.stopped(), true);
  assert.deepEqual(f.peer.log.filter(entry => entry.kind === "http").map(label).slice(-2),
    ["GET /api/orchestration/threads/branch", "GET /api/orchestration/threads/middle"], "the Stop landed during the parent read");
  assert.deepEqual(result, {status: "denied", reason: "guidance_assignment_changed"});
  assert.deepEqual(yield* rows(f.core.sql, "SELECT * FROM supervisor_team_tool_receipts"), []);
  assert.deepEqual(yield* f.core.team.unresolvedRequests(binding), []);
  assert.deepEqual((yield* f.core.team.snapshot(binding)).events, events);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

// recorded target change (S6b): the escalation of a walk without a route runs in an admission section that rechecks the scope, so
// a Stop committed during the walk leaves no durable write
it.live("CT-LIN-01: guide: a Stop committed during the ancestor read of a guide whose target is directly under the main writes no escalation and the guide is denied guidance_assignment_changed", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  const binding = yield* f.bindSupervisor;
  // the target's parent is the main, so the main read is the walk's last await and the walk then ends without a route (supervisor-team-controller.ts:407, :414)
  const {helper, member, assignment} = yield* seedTeam(f);
  const payload = {supervisorThreadId: helper.thread.id, bindingGeneration: binding.generation, memberEpoch: member.epoch, assignmentRootThreadId: "branch",
    assignmentEpoch: assignment.epoch, operationId: "lin-guide-direct-stop", targetThreadId: "branch", text: "Continue with the plan."};
  installToolCall(f, helper, workflowToolNames.guide.direct[0], payload);
  const before = yield* teamEventRows(f);
  const assessmentBefore = (yield* f.core.team.snapshot(binding)).members.find(value => value.threadId === "helper")?.lastAssessment;
  const order: Array<{step: string; stopped: boolean}> = [];
  let targetRead = false;
  const stopOnParentRead = once((threadId: string) => threadId === mainThreadId && targetRead, Effect.gen(function* () {
    yield* f.stop();
    order.push({step: "stop", stopped: yield* f.stopped()});
  }));
  f.peer.onProjection = threadId => {
    if (threadId === "branch") targetRead = true;
    return stopOnParentRead(threadId);
  };
  // records any escalation write, which runs in the escalation's admission section (supervisor-team-controller.ts:700-707)
  yield* interpose(f.core.team, "escalate", (escalate) => (...args) => Effect.flatMap(f.stopped(), (stopped) => {
    order.push({step: "escalation", stopped});
    return escalate(...args);
  }));
  const result = yield* f.core.teamController.guide(payload);
  assert.equal(yield* f.stopped(), true);
  assert.deepEqual(f.peer.log.filter(entry => entry.kind === "http").map(label).slice(-2),
    ["GET /api/orchestration/threads/branch", "GET /api/orchestration/threads/main"], "the Stop landed during the main read");
  assert.deepEqual(result, {status: "denied", reason: "guidance_assignment_changed"});
  assert.deepEqual(order, [{step: "stop", stopped: true}], "the Stop commits first and no escalation write starts after it");
  assert.deepEqual(yield* teamEventRows(f), before, "no team event row is written after the Stop");
  assert.equal((yield* f.core.team.snapshot(binding)).members.find(value => value.threadId === "helper")?.lastAssessment, assessmentBefore,
    "the helper's last assessment is unchanged");
  assert.equal((yield* f.binding).supervisionStop!.route, "ui");
  assert.deepEqual(yield* rows(f.core.sql, "SELECT * FROM supervisor_team_tool_receipts"), []);
  assert.deepEqual(yield* f.core.team.unresolvedRequests(binding), []);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-01: creation: a Stop committed during the fresh main read throws main_conversation_unavailable and launches nothing", () => Effect.gen(function* () {
  const f = yield* startLinFixture(newRequest);
  let supervisorRead = false;
  const stopOnMainRead = once((threadId: string) => threadId === mainThreadId && supervisorRead, f.stop());
  // the reserved Supervisor reads 404, then readMain is the last await before the guard (project-supervisor.ts:1092, :1106-1107)
  f.peer.onProjection = threadId => {
    if (threadId.startsWith("supervisor-root:")) supervisorRead = true;
    return stopOnMainRead(threadId);
  };
  // ensureBinding is internal and its callers swallow its error (project-supervisor.ts:787, :1069, :1190)
  const failure = yield* Effect.flip(f.core.seams.ensureBinding(projectId, mainThreadId, "main"));
  assert.equal(failure.message, "main_conversation_unavailable");
  assert.equal(yield* f.stopped(), true);
  assert.equal((yield* f.binding).state, "creating");
  assert.equal((yield* f.binding).creationAttempts, 0);
  assert.deepEqual(writes(f), []);
  yield* f.runOnce;
  assert.equal((yield* f.binding).creationAttempts, 0);
  assert.deepEqual(writes(f), [], "a later cycle of the stopped chat launches nothing");
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-01: stopped settlement: an Enable committed during the fresh Supervisor read leaves the settlement unsent", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  const binding = yield* f.bindSupervisor;
  yield* f.stop();
  let supervisorReads = 0;
  // check() reads the Supervisor (supervisor-lifecycle.ts:271); settleStopped re-reads it last before the guard (:390, :395)
  f.peer.onProjection = threadId => threadId === binding.threadId && ++supervisorReads === 2 ? f.enable() : Effect.void;
  yield* f.core.lifecycle.check(yield* f.binding, f.threads);
  assert.equal(supervisorReads, 2);
  assert.equal(yield* f.stopped(), false);
  assert.equal((yield* f.binding).settlement, undefined);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

type PolicyProbe = {stopped: boolean; stop: unknown; notice: string | null; enabledAt: number | null; start: string | null};

const observe = (f: LinFixture): Effect.Effect<PolicyProbe> => Effect.gen(function* () {
  return {stopped: (yield* f.core.policy.get()).excludedThreadIds.includes(mainThreadId),
    stop: (yield* f.core.store.chatStop(mainThreadId)) ?? null, notice: (yield* f.core.store.binding(projectId, mainThreadId))?.stopNotice?.state ?? null,
    enabledAt: yield* f.core.store.chatEnabledAt(mainThreadId), start: (yield* f.core.store.start(mainThreadId))?.status ?? null};
}).pipe(Effect.orDie);

// every policy commit starts a probe on a fiber of its own that yields first, so it observes once the committing fiber yields
// (thread-policy.ts:25-33); its guidance reads queue behind any open guidance transaction, so it observes what a reader can see
// once the commit's turn yields
const probePolicyCommits = (f: LinFixture) => Effect.gen(function* () {
  const seen: Array<Fiber.Fiber<PolicyProbe>> = [];
  const run = yield* FiberSet.makeRuntime<never, PolicyProbe>();
  yield* interpose(f.core.policy, "save", (save) => (input) =>
    Effect.tap(save(input), () => Effect.sync(() => seen.push(run(Effect.andThen(Effect.yieldNow, observe(f)))))));
  return seen;
});

it.live("CT-LIN-02: each MCP, Settings and dashboard Stop or Enable commit is observed only together with its guidance bookkeeping", () => Effect.gen(function* () {
  const f = yield* startLinFixture({mainTurns: [oldTurn, {id: "stop-turn", text: "Please stop supervising this chat."}]});
  const binding = yield* f.bindSupervisor;
  const seen = yield* probePolicyCommits(f);
  const policyGeneration = Effect.map(f.core.policy.get(), (policy) => policy.generation);

  // the MCP supervision_stop (project-supervisor.ts:980-985)
  const stopped = yield* f.core.control.stopSupervision({callerThreadId: binding.threadId, targetThreadId: mainThreadId, userMessageId: "stop-turn",
    operationId: "lin-stop"}, {});
  assert.deepEqual(stopped, {status: "stopped", targetThreadId: mainThreadId, route: "relay", alreadyStopped: false});
  assert.equal(seen.length, 1);
  assert.deepEqual(yield* Fiber.join(seen[0]!), {stopped: true, stop: {route: "relay", callerThreadId: binding.threadId, userMessageId: "stop-turn", stoppedAt: Date.parse(baseTime)},
    notice: "ready", enabledAt: null, start: null});

  // the Settings excluded-chat editor's Enable and Stop (:997-1001)
  yield* f.enable();
  assert.equal(seen.length, 2);
  assert.deepEqual(yield* Fiber.join(seen[1]!), {...yield* observe(f), stopped: false, stop: null, notice: "superseded"});
  assert.equal(typeof (yield* Fiber.join(seen[1]!)).enabledAt, "number");
  yield* f.stop();
  assert.equal(seen.length, 3);
  assert.deepEqual(yield* Fiber.join(seen[2]!), {...yield* observe(f), stopped: true, notice: "ready", enabledAt: (yield* Fiber.join(seen[1]!)).enabledAt});
  assert.equal(((yield* Fiber.join(seen[2]!)).stop as {route: string}).route, "ui");

  // the dashboard Enable and Stop (:1014-1020)
  const enabled = yield* f.core.supervisor.setChatSupervision({projectId, mainThreadId, enabled: true, policyGeneration: yield* policyGeneration});
  assert.equal(enabled.status, "saved");
  assert.equal(seen.length, 4);
  assert.deepEqual(yield* Fiber.join(seen[3]!), {...yield* observe(f), stopped: false, stop: null, notice: "superseded"});
  assert.ok((yield* Fiber.join(seen[3]!)).enabledAt! >= (yield* Fiber.join(seen[1]!)).enabledAt!);
  const stoppedAgain = yield* f.core.supervisor.setChatSupervision({projectId, mainThreadId, enabled: false, policyGeneration: yield* policyGeneration});
  assert.equal(stoppedAgain.status, "saved");
  assert.equal(seen.length, 5);
  assert.deepEqual(yield* Fiber.join(seen[4]!), {...yield* observe(f), stopped: true, notice: "ready", enabledAt: (yield* Fiber.join(seen[3]!)).enabledAt});
  assert.equal(((yield* Fiber.join(seen[4]!)).stop as {route: string}).route, "ui");
}), {timeout: 10_000});

it.live("CT-LIN-02: a dashboard Start activation's policy commit is observed only together with the Enable record and the active Start", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  // the project is the managed scratch root, so the chat is a No Project chat activated by Start (project-supervisor.ts:369-372)
  f.core.config.managedScratchRoot = "/work/p";
  const policy = yield* f.core.policy.get();
  yield* f.core.policy.save({...policy, excludedThreadIds: [mainThreadId]});
  yield* f.core.store.saveUnboundStop(mainThreadId, {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: (yield* Clock.currentTimeMillis) - 60_000});
  const seen = yield* probePolicyCommits(f);
  const result = yield* f.core.supervisor.setChatSupervision({projectId, mainThreadId, enabled: true, policyGeneration: (yield* f.core.policy.get()).generation});
  assert.equal(result.status, "saved");
  const start = (yield* f.core.store.start(mainThreadId))!;
  assert.equal(start.status, "active");
  // the policy write (:673) and the bookkeeping (:675-677) share one guidance transaction
  assert.deepEqual(yield* Fiber.joinAll(seen), [{stopped: false, stop: null, notice: null, enabledAt: start.intentAt, start: "active"}]);
}), {timeout: 10_000});

it.live("CT-LIN-03: a dashboard Stop whose notice bookkeeping fails keeps the policy stop; sends stay fenced, a retry conflicts, settlement dates from observation and an MCP replay records the stop", () => Effect.gen(function* () {
  const f = yield* startLinFixture({mainTurns: [oldTurn, {id: "stop-turn", text: "Please stop supervising this chat."}]});
  const binding = yield* f.bindSupervisor;
  const checkIn = yield* f.core.requests.prepare({projectId, supervisorThreadId: binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, yield* Clock.currentTimeMillis);
  let noticeWrites = 0;
  yield* interpose(f.core.store, "setStopNotice", (setStopNotice) => (...args) =>
    Effect.suspend(() => noticeWrites++ === 0 ? Effect.die(new Error("injected_stop_notice_failure")) : setStopNotice(...args)));
  const ui = yield* dashboard(f);
  const path = "/api/guidance/project-supervisor/chat-supervision";
  const generation = (yield* f.core.policy.get()).generation;
  const first = yield* ui.post(path, {projectId, mainThreadId, enabled: false, policyGeneration: generation});
  assert.equal(first.status, 400);
  assert.deepEqual(first.body, {_tag: "UiError", message: "The chat supervision change could not be confirmed. Refresh to inspect the saved state."});
  assert.equal(yield* f.stopped(), true);
  assert.equal((yield* f.core.policy.get()).generation, generation + 1);
  assert.equal((yield* f.binding).supervisionStop, undefined, "the per-binding transaction rolled back (project-supervisor.ts:909-917)");
  assert.equal((yield* f.binding).stopNotice, undefined);

  const retry = yield* ui.post(path, {projectId, mainThreadId, enabled: false, policyGeneration: generation});
  assert.equal(retry.status, 200);
  assert.equal((retry.body as {status: string}).status, "conflict");
  assert.equal((retry.body as {message: string}).message, "Chat settings changed in another tab or by the Supervisor. The saved state is shown.");
  assert.equal(noticeWrites, 1, "the retry does not rerun the bookkeeping");
  assert.equal((yield* f.binding).supervisionStop, undefined);

  yield* f.runOnce;
  const fenced = (yield* requests(f, binding.threadId)).find(request => request.id === checkIn.id)!;
  assert.equal(fenced.state, "failed");
  assert.equal(fenced.error, "Supervision was stopped for this chat before this check-in was sent; it was not sent.");
  assert.equal(yield* f.core.store.task(mainThreadId), null, "the new human request is not interpreted");
  const settled = yield* f.binding;
  assert.equal(typeof settled.stopObservedAt, "number", "without a stop record the settlement dates from its observation (supervisor-lifecycle.ts:376-379)");
  assert.equal(settled.settlement?.state, "settled");
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId})),
    [{type: "thread.settle", commandId: settled.settlement!.commandId}], "no message is sent; only the Supervisor is settled");

  // an MCP stop replay finds no recorded stop and reruns the bookkeeping (:983-985)
  const replay = yield* f.core.control.stopSupervision({callerThreadId: binding.threadId, targetThreadId: mainThreadId, userMessageId: "stop-turn",
    operationId: "lin-replay"}, {});
  assert.deepEqual(replay, {status: "stopped", targetThreadId: mainThreadId, route: "relay", alreadyStopped: true});
  assert.equal((yield* f.core.policy.get()).generation, generation + 1, "the replay writes no policy");
  const recorded = yield* f.binding;
  assert.deepEqual(recorded.supervisionStop, {route: "relay", callerThreadId: binding.threadId, userMessageId: "stop-turn", stoppedAt: Date.parse(baseTime)});
  assert.equal(recorded.stopNotice?.state, "ready");
  assert.equal(recorded.stopObservedAt, undefined);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

const prepareDashboardEnable = (failEnable: boolean) => Effect.gen(function* () {
  const f = yield* startLinFixture();
  yield* f.bindSupervisor;
  yield* f.stop();
  const stoppedAt = (yield* f.binding).supervisionStop!.stoppedAt;
  addTurn(f.main, {id: "stopped-turn", text: "Request written while supervision was stopped.", createdAt: new Date(stoppedAt).toISOString()});
  yield* interpose(f.core.store, "recordChatEnable", (recordChatEnable) => (...args) =>
    failEnable ? Effect.die(new Error("injected_enable_failure")) : recordChatEnable(...args));
  const ui = yield* dashboard(f);
  const reply = yield* ui.post("/api/guidance/project-supervisor/chat-supervision", {projectId, mainThreadId, enabled: true,
    policyGeneration: (yield* f.core.policy.get()).generation});
  return {f, reply, stoppedAt};
});

it.live("CT-LIN-03: a dashboard Enable whose bookkeeping fails keeps a stale enable time, so a request written while stopped is interpreted", () => Effect.gen(function* () {
  const failed = yield* prepareDashboardEnable(true);
  assert.equal(failed.reply.status, 400);
  assert.deepEqual(failed.reply.body, {_tag: "UiError", message: "The chat supervision change could not be confirmed. Refresh to inspect the saved state."});
  assert.equal(yield* failed.f.stopped(), false);
  assert.equal(yield* failed.f.core.store.chatEnabledAt(mainThreadId), null);
  assert.equal((yield* failed.f.binding).supervisionStop?.stoppedAt, failed.stoppedAt, "the stop record was not cleared");
  assert.equal((yield* failed.f.binding).stopNotice?.state, "ready", "the notice was not superseded");
  yield* failed.f.runOnce;
  const interpreted = yield* task(failed.f);
  assert.equal(interpreted.sourceMessageId, "stopped-turn");
  assert.equal(interpreted.status, "waiting");
  assert.deepEqual(dispatches(failed.f).map(payload => payload.commandId), [`supervisor-objective:${interpreted.id}`]);
}), {timeout: 10_000});

// the independent control owns a separate test scope, so the failed case releases its workers before this setup
it.live("CT-LIN-03: a complete dashboard Enable records its time, so a request written while stopped is not interpreted", () => Effect.gen(function* () {
  const enabled = yield* prepareDashboardEnable(false);
  assert.equal(enabled.reply.status, 200);
  assert.ok((yield* enabled.f.core.store.chatEnabledAt(mainThreadId))! >= enabled.stoppedAt);
  yield* enabled.f.runOnce;
  assert.equal(yield* enabled.f.core.store.task(mainThreadId), null);
  assert.deepEqual(dispatches(enabled.f), []);
}), {timeout: 10_000});

it.live("CT-LIN-04: interpretation: a Stop committed right after the dispatching receipt is fenced by the guard; the task returns to queued unsent", () => Effect.gen(function* () {
  const f = yield* startLinFixture(newRequest);
  yield* f.bindSupervisor;
  let receipt: TaskRecord | null = null;
  let stopSaved = false;
  // the receipt write returns, then the Stop is saved before the guard runs: the receipt commits in its own admission section,
  // so the Stop is its own section entered right after it, ahead of the dispatch section (project-supervisor.ts dispatching receipt)
  yield* interpose(f.core.store, "saveTask", (saveTask) => (value) => Effect.tap(saveTask(value), () => Effect.sync(() => {
    if (value.status === "dispatching" && receipt === null) receipt = value;
  })));
  yield* interpose(f.core.gate, "admit", (admit) => (body) => receipt !== null && !stopSaved
    ? Effect.andThen(Effect.suspend(() => {stopSaved = true;return f.stop();}), admit(body)) : admit(body));
  yield* f.runOnce;
  assert.ok(receipt);
  assert.equal(typeof (receipt as TaskRecord).dispatchedAt, "number");
  const fenced = yield* task(f);
  assert.equal(fenced.id, (receipt as TaskRecord).id);
  assert.equal(fenced.status, "queued");
  assert.equal(fenced.dispatchedAt, null);
  assert.equal(fenced.reason, "Supervision was stopped for this chat before dispatch; this task identity remains unsent.");
  assert.deepEqual(dispatches(f), []);
  assert.deepEqual(writes(f), []);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06: interpretation: a Stop committed when the frame arrives keeps the accepted identity, later cycles only observe it", () => Effect.gen(function* () {
  const f = yield* startLinFixture(newRequest);
  const binding = yield* f.bindSupervisor;
  const {seen, commit} = stopOnArrival(f);
  let runId = "";
  // the peer records the accepted message and starts its run, as T3 does
  f.peer.onRpc = entry => Effect.gen(function* () {
    if (yield* commit(entry)) runId = addDispatchedMessage(yield* f.supervisor, entry.payload);
    return undefined;
  });
  yield* f.runOnce;
  assert.equal(seen.stoppedAtArrival, true);
  const sent = yield* task(f);
  assert.equal(sent.status, "waiting");
  assert.equal(sent.reason, "T3 accepted the interpretation request; waiting for its result.");
  assert.deepEqual(dispatches(f).map(dispatched), [{type: "message.dispatch", commandId: `supervisor-objective:${sent.id}`, messageId: sent.messageId,
    threadId: binding.threadId, text: sent.requestText}]);

  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual(yield* task(f), sent, "a running native outcome is only observed");
  const run = (yield* f.supervisor).runs.find(value => value.id === runId)!;
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  yield* f.runOnce;
  const closed = yield* task(f);
  assert.equal(closed.id, sent.id);
  assert.equal(closed.supervisorRunId, runId);
  assert.equal(closed.status, "unavailable");
  assert.equal(closed.reason, "Supervision was stopped for this chat; the interpretation result was not applied.");
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId})), [
    {type: "message.dispatch", commandId: `supervisor-objective:${sent.id}`},
    {type: "thread.settle", commandId: (yield* f.binding).settlement!.commandId},
  ], "no replay and no new identity; the stopped Supervisor settles once the outcome is known");
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06: interpretation: a Stop committed when the frame arrives and a lost reply leave the identity uncertain, never resent", () => Effect.gen(function* () {
  const f = yield* startLinFixture(newRequest);
  yield* f.bindSupervisor;
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => Effect.map(commit(entry), (committed) => committed ? {drop: true} as const : undefined);
  yield* f.runOnce;
  assert.equal(seen.stoppedAtArrival, true);
  const sent = yield* task(f);
  assert.equal(sent.status, "uncertain");
  assert.equal(sent.reason, "Interpretation dispatch is uncertain; retry native access to reconcile the original request identity.");
  assert.deepEqual(dispatches(f).map(payload => payload.commandId), [`supervisor-objective:${sent.id}`]);
  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual(yield* task(f), sent);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch"]);
  assert.equal((yield* f.binding).settlementBlockedBy, "stopped_interpretation_unresolved");
}), {timeout: 10_000});

it.live("CT-LIN-06: root check-in: a Stop committed when the frame arrives keeps the accepted identity; later cycles match its run without resending", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  const binding = yield* f.bindSupervisor;
  const prepared = yield* f.core.requests.prepare({projectId, supervisorThreadId: binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, yield* Clock.currentTimeMillis);
  const {seen, commit} = stopOnArrival(f);
  let runId = "";
  f.peer.onRpc = entry => Effect.gen(function* () {
    if (yield* commit(entry)) runId = addDispatchedMessage(yield* f.supervisor, entry.payload);
    return undefined;
  });
  yield* f.runOnce;
  assert.equal(seen.stoppedAtArrival, true);
  const sent = (yield* requests(f, binding.threadId)).find(request => request.id === prepared.id)!;
  assert.equal(sent.state, "waiting");
  assert.equal(typeof sent.sentAt, "number");
  assert.deepEqual(dispatches(f).map(dispatched), [{type: "message.dispatch", commandId: `supervisor-review:${prepared.id}`, messageId: prepared.messageId,
    threadId: binding.threadId, text: prepared.text}]);
  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual(yield* requests(f, binding.threadId), [{...sent, runId}]);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch"]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06: root check-in: a Stop committed when the frame arrives and a lost reply leave the identity uncertain, never resent", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  const binding = yield* f.bindSupervisor;
  const prepared = yield* f.core.requests.prepare({projectId, supervisorThreadId: binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, yield* Clock.currentTimeMillis);
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => Effect.map(commit(entry), (committed) => committed ? {drop: true} as const : undefined);
  yield* f.runOnce;
  assert.equal(seen.stoppedAtArrival, true);
  const sent = (yield* requests(f, binding.threadId)).find(request => request.id === prepared.id)!;
  assert.equal(sent.state, "uncertain");
  assert.equal(sent.error, "Supervisor request delivery is uncertain; its original identity is retained and only observed, never resent.");
  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual(yield* requests(f, binding.threadId), [sent]);
  assert.deepEqual(dispatches(f).map(payload => payload.commandId), [`supervisor-review:${prepared.id}`]);
}), {timeout: 10_000});

it.live("CT-LIN-06: introduction: a Stop committed when the frame arrives keeps the accepted introduction; later cycles never resend it", () => Effect.gen(function* () {
  const f = yield* startLinFixture(newRequest);
  yield* f.bindSupervisor;
  const {introduction} = yield* seedIntroduction(f, newSource);
  const {seen, commit} = stopOnArrival(f);
  // the peer queues the introduction after the active run, as T3 does; it completes before the next cycle
  f.peer.onRpc = entry => Effect.map(commit(entry), (committed) => {
    if (committed) addDispatchedMessage(f.main, entry.payload, "completed");
    return undefined;
  });
  yield* f.runOnce;
  assert.equal(seen.stoppedAtArrival, true);
  const accepted = (yield* f.core.requests.introduction(introduction.taskId))!;
  assert.equal(accepted.state, "accepted");
  assert.equal(typeof accepted.acceptedAt, "number");
  assert.deepEqual(accepted.dispatchMode, {type: "queue_after_active"});
  assert.deepEqual(dispatches(f).map(dispatched), [{type: "message.dispatch", commandId: `supervisor-workflow:${introduction.taskId}`,
    messageId: introduction.messageId, threadId: mainThreadId, text: introduction.text}]);
  f.peer.onRpc = null;
  yield* f.runOnce;
  yield* f.runOnce;
  assert.deepEqual(yield* f.core.requests.introduction(introduction.taskId), accepted);
  // the Stop then produces exactly one operative notice, after the introduction became visible, and the Supervisor settles
  const notice = (yield* f.binding).stopNotice!;
  assert.equal(notice.state, "accepted");
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId, threadId: payload.threadId})), [
    {type: "message.dispatch", commandId: `supervisor-workflow:${introduction.taskId}`, threadId: mainThreadId},
    {type: "message.dispatch", commandId: notice.commandId, threadId: mainThreadId},
    {type: "thread.settle", commandId: (yield* f.binding).settlement!.commandId, threadId: (yield* f.binding).threadId},
  ]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06: guide: a Stop committed when the steer frame arrives keeps the accepted guide record and sends no other route", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  const binding = yield* f.bindSupervisor;
  const {helper, member, assignment} = yield* seedTeam(f);
  const payload = {supervisorThreadId: helper.thread.id, bindingGeneration: binding.generation, memberEpoch: member.epoch, assignmentRootThreadId: "branch",
    assignmentEpoch: assignment.epoch, operationId: "lin-guide-sent", targetThreadId: "branch", text: "Continue with the plan."};
  installToolCall(f, helper, workflowToolNames.guide.direct[0], payload);
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => Effect.as(commit(entry), undefined);
  const result = (yield* f.core.teamController.guide(payload)) as {status: string; requestId: string; commandId: string; messageId: string};
  assert.equal(seen.stoppedAtArrival, true);
  assert.equal(result.status, "accepted");
  assert.equal(result.commandId, `${result.requestId}:command:0`);
  assert.deepEqual(dispatches(f).map(value => ({...dispatched(value), dispatchMode: value.dispatchMode})), [{type: "message.dispatch",
    commandId: result.commandId, messageId: result.messageId, threadId: "branch", text: payload.text, dispatchMode: {type: "steer_active", targetRunId: "branch-run"}}]);
  const receipts = Effect.map(rows(f.core.sql, "SELECT document FROM supervisor_team_tool_receipts"), (found) => found.map(value => JSON.parse(String(value.document)) as unknown));
  assert.deepEqual(yield* receipts, [result]);
  assert.deepEqual((yield* f.core.team.unresolvedRequests(binding)).map(request => ({requestId: request.requestId, state: request.state})),
    [{requestId: result.requestId, state: "pending"}]);
  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual(yield* receipts, [result]);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:message.dispatch"]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06: settlement: a Stop committed when the settle frame arrives keeps the settled identity; later cycles send no other settlement", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  const binding = yield* f.bindSupervisor;
  // a closed not-needed task leaves nothing to supervise, so the quiet Supervisor settles (supervisor-lifecycle.ts:124-137)
  yield* f.core.store.saveTask({id: "task-done", threadId: mainThreadId, projectId, sourceRunId: `run-${oldTurn.id}`, sourceMessageId: oldTurn.id, sourceOrdinal: 1,
    sourceHash: "not-needed", status: "not_supervised", objective: null, reason: "Supervision is not needed.", updatedAt: yield* Clock.currentTimeMillis, requestText: "",
    supervisorThreadId: binding.threadId, messageId: "supervisor-objective:task-done", supervisorRunId: null, dispatchedAt: null, replayCount: 0});
  const now = yield* Clock.currentTimeMillis;
  yield* atWallClock(now)(f.core.lifecycle.check(yield* f.binding, f.threads));
  assert.equal((yield* f.binding).settlementBlockedBy, "quiet_window");
  const {seen, commit} = stopOnArrival(f);
  f.peer.onRpc = entry => Effect.as(commit(entry), undefined);
  yield* atWallClock(now + SUPERVISOR_SETTLE_QUIET_MS)(f.core.lifecycle.check(yield* f.binding, f.threads));
  assert.equal(seen.stoppedAtArrival, true);
  const settlement = (yield* f.binding).settlement!;
  assert.equal(settlement.state, "settled");
  assert.equal(settlement.attempts, 1);
  assert.deepEqual(dispatches(f).map(payload => ({type: payload.type, commandId: payload.commandId, threadId: payload.threadId})),
    [{type: "thread.settle", commandId: settlement.commandId, threadId: binding.threadId}]);
  f.peer.onRpc = null;
  yield* f.runOnce;
  assert.deepEqual((yield* f.binding).settlement, settlement);
  assert.deepEqual(writes(f), ["orchestration.dispatchCommand:thread.settle"]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});

it.live("CT-LIN-06: helper: a Stop committed when the webhook POST arrives keeps the posted delivery; later cycles post nothing", () => Effect.gen(function* () {
  const f = yield* startLinFixture();
  const binding = yield* f.bindSupervisor;
  const {helper} = yield* seedTeam(f);
  const threads = [helper.thread, ...f.threads];
  const runtime = f.core.teamRuntime;
  const batches = (yield* runtime.partition(binding, threads, helperBatch("branch"))).helperBatches;
  let stoppedAtArrival: boolean | null = null;
  f.peer.webhook = (_entry, deliveryId) => Effect.gen(function* () {
    yield* f.stop();
    stoppedAtArrival = yield* f.stopped();
    return json(202, {deliveryId});
  });
  yield* runtime.startCycle(yield* f.binding);
  yield* runtime.runHelperBatch(yield* f.binding, threads, batches);
  assert.equal(stoppedAtArrival, true);
  const request = (yield* requests(f, "helper")).find(value => value.id.startsWith("team-review:"))!;
  assert.equal(request.state, "waiting");
  const receipt = (yield* helperReceipt(f))!;
  assert.equal(receipt.state, "posted");
  assert.equal(receipt.nativeDeliveryId, "native-delivery-1");
  assert.equal(receipt.messageId, request.messageId);
  const posts = f.peer.log.filter((entry): entry is Extract<Entry, {kind: "http"}> => entry.kind === "http" && entry.method === "POST");
  assert.deepEqual(posts.map(entry => entry.body), [helperDeliveryBody(request.messageId, request.text)]);
  yield* f.runOnce;
  const observed = (yield* helperReceipt(f))!;
  assert.deepEqual({...observed, renderedText: undefined}, {...receipt, renderedText: undefined}, "the stopped cycle binds the rendering only");
  assert.equal(observed.renderedText, publishedWrapper(request.text));
  assert.equal((yield* requests(f, "helper")).find(value => value.id === request.id)?.messageId, request.messageId);
  assert.deepEqual(writes(f), ["scheduledTasks.upsert", "POST /api/hooks/fixture/fixture-only-token"]);
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 10_000});
