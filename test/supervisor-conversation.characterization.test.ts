import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { Console, Deferred, Effect, Fiber } from "effect";
import type { SqlClient } from "effect/sql";
import type { ConversationRequest, WorkflowAgreementCandidate } from "../src/supervisor-conversation-store.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { workflowIntroductionText } from "../src/supervisor-conversation.js";
import { abortCall, atWallTime, execute, openConversationStore, query, rejectionOf, temporaryDirectory, within } from "./support/g1b-conversation.js";
import {
  abortHonouringSend, addCommandActivity, appendMessageToRun, proceed, appendNoticeToOperative, appendOperativeAcceptance, appendSupervisorProposal, baseTime, completeRun,
  makeFixture, observeAgreement, operativeThreadId, projectId, setNow, workflowRecord, type Fixture, type FixtureClock, type RpcCall,
} from "./support/c1-conversation-fixture.js";

// the cases are Effect tests on the production conversation, admission gate and stores over real files in a temporary
// directory, with the fake T3 as an effect fake; the suite clock moves the services' test clock as the baseline mocked Date.now
// did, and a call's baseline `now` is its wall time; the baseline per-call abort deadlines (the observations' 5 s, the Stop
// notice cases' 10 s and the fixture run's shared 10 s) are gone with the signal parameter: they were hang guards, which each
// case's 10 s bound and the 3 s live-clock bounds of its awaited events still cover

const isCheckIn = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === fixture.binding.threadId;

// a fixture with a sent introduction and three due command activities, observed into the monitor
const dueCheckIn = (clock: FixtureClock) => Effect.gen(function* () {
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock, {settings: {intervalMinutes: 5, activityThreshold: 3}});
  yield* appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now));
  return fixture;
});

// holds the matching send at the fake peer: abort-honouring, or never settling until the test ends
const holdSend = (fixture: Fixture, matches: (call: RpcCall) => boolean, mode: "abort" | "crash") => Effect.gen(function* () {
  const reached = yield* Deferred.make<RpcCall>();
  fixture.intercept((call, flight) => {
    if (!matches(call)) return null;
    return Effect.andThen(Deferred.succeed(reached, call), mode === "abort" ? abortHonouringSend(flight) : Effect.never);
  });
  return within(Deferred.await(reached), 3_000, "held send");
});

// a run left parked at its held send when the process crashes; it ends with the test, interrupted within the bound
const abandon = (fixture: Fixture) => Effect.gen(function* () {
  const abandoned = yield* Effect.forkScoped(fixture.run);
  yield* Effect.addFinalizer(() => within(Fiber.interrupt(abandoned), 3_000, "abandoned run"));
});

it.effect("CT-CONV-01: aborting run() after the 'sending' commit saves the check-in 'uncertain' with its identity and one dispatch", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const fixture = yield* dueCheckIn(clock);
  const reached = yield* holdSend(fixture, isCheckIn(fixture), "abort");
  const running = yield* Effect.forkChild(fixture.run);
  const call = yield* reached;
  const sending = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(sending?.kind === "review");
  assert.equal(sending.state, "sending");
  assert.equal(sending.sentAt, clock.now);
  assert.equal(yield* fixture.requests.lastNotice(fixture.binding.threadId), clock.now);
  assert.equal(call.payload.messageId, sending.messageId);
  assert.equal(call.payload.commandId, `supervisor-review:${sending.id}`);

  yield* within(abortCall(running), 3_000, "aborted run");
  const uncertain = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "Supervisor request delivery is uncertain; its original identity is retained and only observed, never resent."});

  fixture.intercept(null);
  yield* setNow(clock, clock.now + 120_000);
  yield* fixture.run;
  yield* fixture.run;
  assert.deepEqual(yield* fixture.requests.pending(projectId, fixture.binding.threadId), uncertain);
  assert.equal(fixture.calls.filter(isCheckIn(fixture)).length, 1);
}), {timeout: 10_000});

it.effect("CT-CONV-01: a crash after the 'sending' commit keeps the row 'sending' until a new controller marks it 'uncertain', with one dispatch", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const fixture = yield* dueCheckIn(clock);
  const reached = yield* holdSend(fixture, isCheckIn(fixture), "crash");
  yield* abandon(fixture);
  const call = yield* reached;
  const sending = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(sending?.state === "sending");
  yield* fixture.crash;

  fixture.intercept(null);
  const restarted = yield* fixture.reopen;
  assert.deepEqual(yield* restarted.requests.pending(projectId, fixture.binding.threadId), sending, "reopening performs no recovery");
  yield* setNow(clock, clock.now + 1_000);
  yield* restarted.run;
  const uncertain = yield* restarted.requests.pending(projectId, fixture.binding.threadId);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "The native request has no confirmed matching run yet. Its identity and pending activity are retained."});
  yield* setNow(clock, clock.now + 120_000);
  yield* restarted.run;
  assert.deepEqual(yield* restarted.requests.pending(projectId, fixture.binding.threadId), uncertain);
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [call]);
  assert.equal(call.payload.commandId, `supervisor-review:${sending.id}`);
  assert.equal(fixture.calls.length, 1);
}), {timeout: 10_000});

const isIntroduction = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === operativeThreadId &&
  String(call.payload.messageId).startsWith(`supervisor-notice:workflow:${fixture.task.id}`);

it.effect("CT-CONV-02: aborting the introduction POST saves it 'uncertain'; Retry, later cycles and a restart never dispatch it again", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  const reached = yield* holdSend(fixture, isIntroduction(fixture), "abort");
  const running = yield* Effect.forkChild(fixture.run);
  const call = yield* reached;
  const sending = yield* fixture.requests.introduction(fixture.task.id);
  assert.ok(sending);
  assert.equal(sending.state, "sending");
  assert.deepEqual(sending.dispatchMode, {type: "steer_active", targetRunId: "operative-active-run"});
  assert.equal(call.payload.messageId, sending.messageId);
  assert.equal(call.payload.commandId, `supervisor-workflow:${fixture.task.id}`);

  yield* within(abortCall(running), 3_000, "aborted run");
  const uncertain = yield* fixture.requests.introduction(fixture.task.id);
  assert.deepEqual(uncertain, {...sending, state: "uncertain", definiteRejection: false, error: "Proposal delivery is uncertain. Its exact message identity is retained."});

  fixture.intercept(null);
  yield* setNow(clock, clock.now + 61_000);
  yield* fixture.run;
  const observed = yield* fixture.requests.introduction(fixture.task.id);
  assert.deepEqual(observed, {...uncertain, error: "Proposal delivery is uncertain; its message identity is retained. Retry native access rather than sending another proposal."});
  yield* fixture.conversation.retry(projectId, fixture.binding.threadId);
  yield* fixture.run;
  const restarted = yield* fixture.reopen;
  yield* restarted.conversation.retry(projectId, fixture.binding.threadId);
  yield* restarted.run;
  yield* restarted.run;
  assert.deepEqual(yield* restarted.requests.introduction(fixture.task.id), observed);
  assert.deepEqual(fixture.calls.filter(isIntroduction(fixture)), [call]);
  assert.deepEqual(fixture.calls, [call]);
}), {timeout: 10_000});

it.effect("CT-CONV-02: a crash during the introduction POST keeps it 'sending'; the next cycle marks it 'uncertain' and Retry never resends", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  const reached = yield* holdSend(fixture, isIntroduction(fixture), "crash");
  yield* abandon(fixture);
  const call = yield* reached;
  const sending = yield* fixture.requests.introduction(fixture.task.id);
  assert.ok(sending?.state === "sending");
  yield* fixture.crash;

  fixture.intercept(null);
  const restarted = yield* fixture.reopen;
  assert.deepEqual(yield* restarted.requests.introduction(fixture.task.id), sending, "reopening performs no recovery");
  yield* setNow(clock, clock.now + 1_000);
  yield* restarted.run;
  const uncertain = yield* restarted.requests.introduction(fixture.task.id);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "Proposal delivery is uncertain; its message identity is retained. Retry native access rather than sending another proposal."});
  yield* restarted.conversation.retry(projectId, fixture.binding.threadId);
  yield* setNow(clock, clock.now + 61_000);
  yield* restarted.run;
  const again = yield* fixture.reopen;
  yield* again.run;
  assert.deepEqual(yield* again.requests.introduction(fixture.task.id), uncertain);
  assert.deepEqual(fixture.calls, [call]);
}), {timeout: 10_000});

it.effect("CT-CONV-03: aborting the Stop-notice POST keeps the notice 'uncertain' with its identity; later observation never sends a second notice", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  yield* appendNoticeToOperative(fixture);
  const {supervisor: service} = yield* fixture.makeProjectSupervisor;
  yield* service.setChatSupervision({projectId, mainThreadId: operativeThreadId, enabled: false, policyGeneration: (yield* fixture.threadPolicy.get()).generation});
  const prepared = (yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice;
  assert.ok(prepared);
  const isNotice = (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.messageId === prepared.messageId;
  const reached = yield* holdSend(fixture, isNotice, "abort");
  const running = yield* Effect.forkChild(fixture.conversation.reconcileStopNotice(fixture.binding));
  const call = yield* reached;
  const uncertain = (yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice;
  assert.ok(uncertain);
  assert.equal(uncertain.state, "uncertain");
  assert.deepEqual(uncertain.dispatchMode, {type: "steer_active", targetRunId: "operative-active-run"});
  assert.equal(call.payload.commandId, prepared.commandId);
  assert.equal(call.payload.threadId, operativeThreadId);

  yield* within(abortCall(running), 3_000, "aborted notice");
  assert.deepEqual((yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice, uncertain, "a non-definite failure saves nothing over the reservation");

  fixture.intercept(null);
  for (let index = 0; index < 4; index++) {
    yield* setNow(clock, clock.now + 61_000);
    yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  }
  yield* fixture.conversation.retry(projectId, fixture.binding.threadId);
  yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  const observed = (yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice;
  assert.equal(observed?.messageId, prepared.messageId);
  assert.equal(observed?.commandId, prepared.commandId);
  assert.equal(observed?.text, prepared.text);
  // three invisible observations made it unconfirmed; Retry only re-armed one more observation of the same identity
  assert.equal(observed?.state, "uncertain");
  assert.equal(observed?.visibilityMisses, 1);
  assert.deepEqual(fixture.calls.filter(item => item.payload.threadId === operativeThreadId), [call]);
}), {timeout: 10_000});

const reviewState = (sql: SqlClient.SqlClient, supervisorThreadId: string, requestId: string) => Effect.gen(function* () {
  const [request] = yield* query(sql, "SELECT document FROM supervisor_conversation_requests WHERE id=?", requestId);
  const [binding] = yield* query(sql, "SELECT document FROM supervisor_main_bindings WHERE main_thread_id=?", operativeThreadId);
  const [clock] = yield* query(sql, "SELECT review_misses FROM supervisor_monitor_binding_clock WHERE supervisor_thread_id=?", supervisorThreadId);
  const acknowledged = yield* query(sql, "SELECT item_id FROM supervisor_monitor_items WHERE project_id=? AND thread_id=? AND reviewed_version=version ORDER BY item_id", projectId, operativeThreadId);
  const document = JSON.parse(String(request?.document)) as {state: string; error: string | null; runId: string | null};
  return {state: document.state, error: document.error, runId: document.runId,
    deliveredRoleVersion: (JSON.parse(String(binding?.document)) as {deliveredRoleVersion?: string}).deliveredRoleVersion ?? null,
    reviewMisses: Number(clock?.review_misses), acknowledged: acknowledged.map(row => String(row.item_id))};
});

const waitingReview = (clock: FixtureClock) => Effect.gen(function* () {
  const fixture = yield* dueCheckIn(clock);
  yield* fixture.run;
  const request = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(request?.kind === "review" && request.state === "waiting" && request.batch && request.roleVersion);
  const run = fixture.supervisor.runs.find(item => item.userMessageId === request.messageId);
  assert.ok(run);
  return {fixture, request, run};
});

it.effect("CT-CONV-04: a failure at the monitor acknowledgement rolls back completion, deliveredRoleVersion and the miss reset, also after reopen", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const {fixture, request, run} = yield* waitingReview(clock);
  yield* fixture.requests.missedReview(fixture.binding.threadId);
  completeRun(fixture.supervisor, run, `No intervention is needed. ${request.completionMarker}`, clock.now + 1);
  yield* setNow(clock, clock.now + 1);
  const before = {state: "waiting", error: null, runId: run.id, deliveredRoleVersion: null, reviewMisses: 1, acknowledged: []};
  const pendingBefore = (yield* fixture.monitor.pending(projectId, operativeThreadId)).map(item => item.id);
  assert.ok(["command-1", "command-2", "command-3"].every(id => pendingBefore.includes(id)));
  yield* execute(fixture.sql, "CREATE TEMP TRIGGER c1_fail_acknowledgement BEFORE UPDATE OF reviewed_version ON supervisor_monitor_items BEGIN SELECT RAISE(ABORT, 'c1 injected acknowledgement failure'); END");
  assert.match(String(yield* rejectionOf(fixture.run)), /guidance store sql failed: ConstraintError/u);
  assert.deepEqual(yield* reviewState(fixture.sql, fixture.binding.threadId, request.id), before);
  const reopened = yield* fixture.reopen;
  assert.deepEqual(yield* reviewState(reopened.sql, fixture.binding.threadId, request.id), before);
  assert.deepEqual((yield* reopened.monitor.pending(projectId, operativeThreadId)).map(item => item.id), pendingBefore);

  // the same reconcile succeeds once the failure is gone
  yield* execute(fixture.sql, "DROP TRIGGER c1_fail_acknowledgement");
  yield* fixture.run;
  const completed = yield* reviewState(fixture.sql, fixture.binding.threadId, request.id);
  assert.deepEqual(completed, {state: "completed", error: null, runId: run.id, deliveredRoleVersion: request.roleVersion, reviewMisses: 0,
    acknowledged: [...pendingBefore].sort()});
  assert.deepEqual(yield* fixture.monitor.pending(projectId, operativeThreadId), []);
}), {timeout: 10_000});

it.effect("CT-CONV-04: a failure after the miss increment rolls back the counter and the request state, also after reopen", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const {fixture, request, run} = yield* waitingReview(clock);
  completeRun(fixture.supervisor, run, "The completed review omitted its required marker.", clock.now + 1);
  yield* setNow(clock, clock.now + 1);
  const before = {state: "waiting", error: null, runId: run.id, deliveredRoleVersion: null, reviewMisses: 0, acknowledged: []};
  yield* execute(fixture.sql, `CREATE TEMP TRIGGER c1_fail_close BEFORE UPDATE ON supervisor_conversation_requests
    WHEN json_extract(NEW.document,'$.state') IN ('completed','failed') BEGIN SELECT RAISE(ABORT, 'c1 injected close failure'); END`);
  assert.match(String(yield* rejectionOf(fixture.run)), /guidance store sql failed: ConstraintError/u);
  assert.deepEqual(yield* reviewState(fixture.sql, fixture.binding.threadId, request.id), before);
  const reopened = yield* fixture.reopen;
  assert.deepEqual(yield* reviewState(reopened.sql, fixture.binding.threadId, request.id), before);

  yield* execute(fixture.sql, "DROP TRIGGER c1_fail_close");
  yield* fixture.run;
  assert.deepEqual(yield* reviewState(fixture.sql, fixture.binding.threadId, request.id), {state: "completed",
    error: "The check-in output was not confirmed; pending activity will be checked again after the cooldown.", runId: run.id,
    deliveredRoleVersion: null, reviewMisses: 1, acknowledged: []});
}), {timeout: 10_000});

// the lines a call logs, one per Console.log call, on the current console with a recording log
const loggedLines = <A, E, R>(effect: Effect.Effect<A, E, R>) => Console.consoleWith((console) => {
  const lines: unknown[][] = [];
  return Effect.as(Effect.provideService(effect, Console.Console, {...console, log: (...values: unknown[]) => {lines.push(values);}}), lines);
});

it.effect("CT-CONV-09: a non-applied workflow agreement import logs one event with its status only", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  // an incompatible stored workflow-state document makes the import report 'incompatible'
  yield* execute(fixture.sql, `INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,
    revision,document,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,1,?,?,?)`, "legacy-workflow", projectId, operativeThreadId, operativeThreadId,
    JSON.stringify({formatVersion: 1}), clock.now, clock.now);
  yield* appendNoticeToOperative(fixture);
  yield* appendSupervisorProposal(fixture, fixture.task.id, undefined, clock.now);
  yield* appendOperativeAcceptance(fixture, workflowRecord(fixture.task, fixture.task.id), clock.now + 1);
  const lines = yield* loggedLines(observeAgreement(fixture, clock.now + 30_000));
  assert.equal((yield* fixture.projectStore.task(operativeThreadId))?.agreement?.status, "agreed");
  assert.deepEqual(lines, [[JSON.stringify({event: "workflow_agreement_import_unavailable", status: "incompatible"})]]);
}), {timeout: 10_000});

// a sent introduction for a task of another binding, visible in its main
const introduceBound = (fixture: Fixture, bound: Effect.Success<ReturnType<Fixture["addBoundOperative"]>>) => Effect.gen(function* () {
  const introduction = {taskId: bound.task.id, projectId, threadId: bound.task.threadId, supervisorThreadId: bound.binding.threadId, state: "sent" as const,
    text: workflowIntroductionText(bound.task), messageId: `supervisor-notice:workflow:${bound.task.id}`, targetRunId: String(bound.projection.thread.activeRunId), error: null};
  yield* fixture.requests.saveIntroduction(introduction);
  const run = bound.projection.runs.find(item => item.id === introduction.targetRunId);
  assert.ok(run);
  appendMessageToRun(bound.projection, run, {id: introduction.messageId, role: "user", text: introduction.text, createdBy: "user", creationSource: "server"});
});

it.effect("CT-CONV-06: interleaved cycles of two bindings keep request identities and cooldown clocks apart and never acknowledge across bindings", () => Effect.gen(function* () {
  const start = baseTime;
  const clock = {now: start};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock, {settings: {intervalMinutes: 5, activityThreshold: 3}});
  const second = yield* fixture.addBoundOperative("operative-b", "proposal-b");
  yield* appendNoticeToOperative(fixture);
  yield* introduceBound(fixture, second);
  for (let index = 1; index <= 3; index++) {
    addCommandActivity(fixture.operative, `a-command-${index}`, `A_BODY_${index}`, clock.now - index * 1_000);
    addCommandActivity(second.projection, `b-command-${index}`, `B_BODY_${index}`, clock.now - index * 1_000);
  }
  yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now));
  const supervisors = new Set([fixture.binding.threadId, second.binding.threadId]);
  const held = new Map<string, Deferred.Deferred<unknown>>();
  const reached = new Map<string, Deferred.Deferred<void>>();
  for (const id of supervisors) reached.set(id, yield* Deferred.make<void>());
  fixture.intercept(call => {
    const target = String(call.payload.threadId);
    if (call.payload.type !== "message.dispatch" || !supervisors.has(target)) return null;
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<unknown>();
      held.set(target, gate);
      yield* Deferred.succeed(reached.get(target)!, undefined);
      return yield* Deferred.await(gate);
    });
  });
  // the first cycle is parked at its POST while the second binding's cycle and an observation run
  const firstCycle = yield* Effect.forkChild(fixture.run);
  yield* within(Deferred.await(reached.get(fixture.binding.threadId)!), 3_000, "first check-in");
  yield* setNow(clock, start + 10_000);
  const observing = yield* Effect.forkChild(fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now)));
  const secondCycle = yield* Effect.forkChild(second.run);
  yield* within(Deferred.await(reached.get(second.binding.threadId)!), 3_000, "second check-in");
  const first = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  const other = yield* fixture.requests.pending(projectId, second.binding.threadId);
  assert.ok(first && other);
  assert.notEqual(first.id, other.id);
  assert.deepEqual([first.state, first.sentAt, other.state, other.sentAt], ["sending", start, "sending", start + 10_000]);
  assert.deepEqual(first.batch?.threads.map(thread => thread.threadId), [operativeThreadId]);
  assert.deepEqual(other.batch?.threads.map(thread => thread.threadId), ["operative-b"]);
  assert.equal(yield* fixture.requests.lastNotice(fixture.binding.threadId), start);
  assert.equal(yield* fixture.requests.lastNotice(second.binding.threadId), start + 10_000);
  // released in reverse order
  yield* Deferred.succeed(held.get(second.binding.threadId)!, proceed);
  yield* within(Fiber.join(secondCycle), 3_000, "second cycle");
  assert.equal((yield* fixture.requests.pending(projectId, fixture.binding.threadId))?.state, "sending");
  yield* Deferred.succeed(held.get(fixture.binding.threadId)!, proceed);
  yield* within(Effect.all([Fiber.join(firstCycle), Fiber.join(observing)]), 3_000, "first cycle");
  assert.equal((yield* fixture.requests.pending(projectId, fixture.binding.threadId))?.state, "waiting");
  assert.equal((yield* fixture.requests.pending(projectId, second.binding.threadId))?.state, "waiting");

  // completing only the first review acknowledges only its own frozen batch
  const firstRun = fixture.supervisor.runs.find(run => run.userMessageId === first.messageId);
  assert.ok(firstRun);
  completeRun(fixture.supervisor, firstRun, `No intervention is needed. ${first.completionMarker}`, start + 20_000);
  yield* setNow(clock, start + 20_000);
  yield* fixture.run;
  yield* second.run;
  assert.equal((yield* fixture.requests.requests(projectId)).find(item => item.id === first.id)?.state, "completed");
  assert.equal((yield* fixture.requests.pending(projectId, second.binding.threadId))?.id, other.id);
  assert.deepEqual(yield* fixture.monitor.pending(projectId, operativeThreadId), []);
  assert.ok((yield* Effect.forEach(["b-command-1", "b-command-2", "b-command-3"], id => Effect.map(fixture.monitor.pending(projectId, "operative-b"), items => items.some(item => item.id === id)))).every(Boolean));
  const otherRun = second.supervisor.runs.find(run => run.userMessageId === other.messageId);
  assert.ok(otherRun);
  completeRun(second.supervisor, otherRun, `No intervention is needed. ${other.completionMarker}`, start + 20_001);
  yield* setNow(clock, start + 20_001);
  yield* second.run;
  assert.deepEqual(yield* fixture.monitor.pending(projectId, "operative-b"), []);

  // each binding's cooldown runs from its own last notice
  for (let index = 4; index <= 6; index++) {
    addCommandActivity(fixture.operative, `a-command-${index}`, `A_BODY_${index}`, start + 25_000 + index);
    addCommandActivity(second.projection, `b-command-${index}`, `B_BODY_${index}`, start + 25_000 + index);
  }
  yield* setNow(clock, start + 30_000);
  yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now));
  fixture.intercept(null);
  const checkIns = (supervisorThreadId: string) => fixture.calls.filter(call => call.payload.threadId === supervisorThreadId).length;
  yield* setNow(clock, start + 60_000);
  yield* fixture.run;
  yield* second.run;
  assert.deepEqual([checkIns(fixture.binding.threadId), checkIns(second.binding.threadId)], [2, 1]);
  yield* setNow(clock, start + 70_000);
  yield* second.run;
  assert.deepEqual([checkIns(fixture.binding.threadId), checkIns(second.binding.threadId)], [2, 2]);
}), {timeout: 10_000});

const tableDigest = (sql: SqlClient.SqlClient) => Effect.gen(function* () {
  const hash = createHash("sha256");
  for (const {name} of yield* query(sql, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
    hash.update(`${String(name)}\0${JSON.stringify(yield* query(sql, `SELECT * FROM "${String(name)}" ORDER BY rowid`))}\0`);
  return hash.digest("hex");
});
const totalChanges = (sql: SqlClient.SqlClient) => Effect.map(query(sql, "SELECT total_changes() AS n"), ([row]) => Number(row?.n));

it.effect("CT-CONV-07: an enabled binding without an inferred task or activity makes no native call and no write in run() and observe()", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock, {task: false});
  const digest = yield* tableDigest(fixture.sql);
  const changes = yield* totalChanges(fixture.sql);
  const reads = fixture.projectionReads.length;
  for (let cycle = 0; cycle < 3; cycle++) {
    yield* fixture.run;
    yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now));
    yield* setNow(clock, clock.now + 61_000);
  }
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.projectionReads.length, reads);
  assert.equal(yield* totalChanges(fixture.sql), changes);
  assert.equal(yield* tableDigest(fixture.sql), digest);
}), {timeout: 10_000});

it.effect("CT-CONV-08: a check-in is withheld at lastNotice+59999 ms and dispatched at lastNotice+60000 ms", () => Effect.gen(function* () {
  const start = baseTime;
  const clock = {now: start};
  const fixture = yield* dueCheckIn(clock);
  yield* fixture.run;
  const first = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(first);
  assert.equal(yield* fixture.requests.lastNotice(fixture.binding.threadId), start);
  const run = fixture.supervisor.runs.find(item => item.userMessageId === first.messageId);
  assert.ok(run);
  completeRun(fixture.supervisor, run, `No intervention is needed. ${first.completionMarker}`, start + 1);
  yield* setNow(clock, start + 1);
  yield* fixture.run;
  assert.equal(yield* fixture.requests.pending(projectId, fixture.binding.threadId), null);
  for (let index = 4; index <= 6; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, start + 2);
  yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(start + 5_001));
  const checkIns = () => fixture.calls.filter(isCheckIn(fixture)).length;
  yield* setNow(clock, start + 59_999);
  yield* fixture.run;
  assert.equal(checkIns(), 1);
  assert.equal(yield* fixture.requests.pending(projectId, fixture.binding.threadId), null);
  yield* setNow(clock, start + 60_000);
  yield* fixture.run;
  assert.equal(checkIns(), 2);
  assert.equal((yield* fixture.requests.pending(projectId, fixture.binding.threadId))?.sentAt, start + 60_000);
}), {timeout: 10_000});

it.effect("CT-CONV-08: an unseen uncertain Stop notice is next observed exactly 60000 ms after its deferral", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  yield* appendNoticeToOperative(fixture);
  const {supervisor: service} = yield* fixture.makeProjectSupervisor;
  yield* service.setChatSupervision({projectId, mainThreadId: operativeThreadId, enabled: false, policyGeneration: (yield* fixture.threadPolicy.get()).generation});
  fixture.intercept(call => call.payload.threadId === operativeThreadId ? Effect.fail(new SupervisorRpcError("uncertain")) : null);
  yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  assert.equal((yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice?.state, "uncertain");
  fixture.intercept(null);
  const deferredAt = clock.now;
  yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  const deferred = (yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice;
  assert.equal(deferred?.nextObserveAt, deferredAt + 60_000);
  assert.equal(deferred?.visibilityMisses, 1);
  const reads = () => fixture.projectionReads.filter(id => id === operativeThreadId).length;
  const before = reads();
  yield* setNow(clock, deferredAt + 59_999);
  yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  assert.equal(reads(), before);
  yield* setNow(clock, deferredAt + 60_000);
  yield* fixture.conversation.reconcileStopNotice(fixture.binding);
  assert.equal(reads(), before + 1);
  assert.equal((yield* fixture.projectStore.binding(projectId, operativeThreadId))?.stopNotice?.nextObserveAt, deferredAt + 120_000);
  assert.equal(fixture.calls.filter(call => call.payload.threadId === operativeThreadId).length, 1);
}), {timeout: 10_000});

it.effect("CT-CONV-08: an accepted but invisible introduction blocks only after strictly more than 60000 ms and three misses", () => Effect.gen(function* () {
  const start = baseTime;
  const clock = {now: start};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  // T3 accepts the introduction, but it never becomes visible unchanged
  fixture.intercept(call => isIntroduction(fixture)(call) ? Effect.succeed({sequence: 1}) : null);
  yield* fixture.run;
  const accepted = yield* fixture.requests.introduction(fixture.task.id);
  assert.equal(accepted?.state, "accepted");
  assert.equal(accepted?.acceptedAt, start);
  const observeAt = (time: number) => Effect.gen(function* () {
    yield* setNow(clock, time);
    yield* fixture.run;
    const current = yield* fixture.requests.introduction(fixture.task.id);
    return [current?.state, current?.visibilityMisses];
  });
  assert.deepEqual(yield* observeAt(start + 1), ["accepted", 1]);
  assert.deepEqual(yield* observeAt(start + 2), ["accepted", 2]);
  assert.deepEqual(yield* observeAt(start + 60_000), ["accepted", 3]);
  assert.deepEqual(yield* observeAt(start + 60_001), ["blocked", 4]);
  assert.equal(fixture.calls.filter(isIntroduction(fixture)).length, 1);
}), {timeout: 10_000});

// the conversation store of a temporary data directory, each open a client of its own with its stores
const conversationStore = Effect.map(temporaryDirectory("c1-conversation-store-"), (directory) => ({open: openConversationStore(directory)}));
const requestCount = (sql: SqlClient.SqlClient) => Effect.map(query(sql, "SELECT count(*) AS n FROM supervisor_conversation_requests"), ([row]) => Number(row?.n));
const reviewInput = (supervisorThreadId: string) => ({projectId, supervisorThreadId, kind: "review" as const, taskId: null, text: "Review.", batch: null, completionMarker: "done"});

it.effect("CT-CSTORE-01: prepare() beside a pending request throws supervisor_request_inflight before pruning or inserting", () => Effect.gen(function* () {
  const {open} = yield* conversationStore;
  const {sql, store} = yield* open;
  const now = baseTime;
  const row = (id: string, supervisorThreadId: string, state: ConversationRequest["state"], createdAt: number): ConversationRequest =>
    ({...reviewInput(supervisorThreadId), id, messageId: `supervisor-review:${id}`, state, createdAt, sentAt: null, runId: null, error: null});
  // an old completed request that a successful prepare prunes
  yield* store.saveRequest(row("old-completed", "other-supervisor", "completed", now - 31 * 86_400_000));
  for (const state of ["prepared", "sending", "waiting", "uncertain"] as const) {
    yield* store.saveRequest(row(`pending-${state}`, "supervisor-a", state, now));
    const count = yield* requestCount(sql);
    assert.equal((yield* Effect.flip(store.prepare(reviewInput("supervisor-a"), now + 1))).message, "supervisor_request_inflight");
    assert.equal(yield* requestCount(sql), count, state);
    assert.equal((yield* store.requests(projectId, "other-supervisor")).length, 1, `${state}: nothing was pruned`);
    yield* store.saveRequest(row(`pending-${state}`, "supervisor-a", "completed", now));
  }
  assert.equal(yield* requestCount(sql), 5);
  const next = yield* store.prepare(reviewInput("supervisor-a"), now + 2);
  assert.equal(next.state, "prepared");
  assert.equal(yield* requestCount(sql), 5, "the successful prepare pruned the old completed request and inserted one");
  assert.equal((yield* store.requests(projectId, "other-supervisor")).length, 0);
}), {timeout: 10_000});

it.effect("CT-CSTORE-03: a request saved 'sending' survives reopen unchanged and only the controller marks it 'uncertain'", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock);
  const prepared = yield* fixture.requests.prepare(reviewInput(fixture.binding.threadId), clock.now);
  const sending: ConversationRequest = {...prepared, state: "sending", sentAt: clock.now};
  yield* fixture.requests.saveRequest(sending);
  yield* fixture.crash;
  const reopened = yield* fixture.reopen;
  assert.deepEqual(yield* reopened.requests.pending(projectId, fixture.binding.threadId), sending);
  const again = yield* fixture.reopen;
  assert.deepEqual(yield* again.requests.requests(projectId), [sending]);
  yield* setNow(clock, clock.now + 1_000);
  yield* again.run;
  assert.deepEqual(yield* again.requests.pending(projectId, fixture.binding.threadId), {...sending, state: "uncertain",
    error: "The native request has no confirmed matching run yet. Its identity and pending activity are retained."});
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), []);
}), {timeout: 10_000});

const candidate = (taskId: string, proposalId: string, at: number): WorkflowAgreementCandidate => ({taskId, projectId, proposalId, planHash: `hash-${proposalId}`,
  workflow: {status: "proposed", message: "Draft.", workspaceRoot: "/work", revision: "r1", globalRevision: null, definitionsStatus: "ready",
    definitionsComplete: true, requirementsKnown: true, requirements: [], issues: [], plan: null},
  evidence: {kind: "supervisor_message", messageId: `message-${proposalId}`, runId: "run", runOrdinal: 1, textHash: "text"}, proposedAt: at});

it.effect("CT-CSTORE-04: agreement evidence is write-once and candidates are full at 50 per task and 5000 per project", () => Effect.gen(function* () {
  const {open} = yield* conversationStore;
  const {sql, store} = yield* open;
  assert.equal(yield* store.saveAgreementCandidate(candidate("task-0", "p-0", 1)), "saved");
  yield* store.saveAgreementEvidence("task-0", "p-0", "agent-1", "hash-1");
  yield* store.saveAgreementEvidence("task-0", "p-0", "agent-2", "hash-2");
  yield* store.saveAgreementEvidence("task-0", "p-0", "agent-1", "hash-other");
  yield* store.saveAgreementEvidence("task-0", "p-0", "agent-1", "hash-1");
  assert.deepEqual([(yield* store.agreementCandidate("task-0", "p-0"))?.agentMessageId, (yield* store.agreementCandidate("task-0", "p-0"))?.agentTextHash], ["agent-1", "hash-1"]);
  yield* store.saveAgreementEvidence("task-0", "missing", "agent-1", "hash-1");
  assert.equal(yield* store.agreementCandidate("task-0", "missing"), null);

  for (let index = 1; index < 50; index++) assert.equal(yield* store.saveAgreementCandidate(candidate("task-0", `p-${index}`, index)), "saved");
  assert.equal(yield* store.saveAgreementCandidate(candidate("task-0", "p-50", 50)), "full");
  assert.equal(yield* store.saveAgreementCandidate(candidate("task-0", "p-1", 1)), "same");
  assert.equal(yield* store.saveAgreementCandidate({...candidate("task-0", "p-1", 1), planHash: "changed"}), "conflict");
  // one transaction keeps the 4950 store writes from paying a synchronous commit each
  yield* sql.withTransaction(Effect.gen(function* () {
    for (let task = 1; task < 100; task++)
      for (let index = 0; index < 50; index++) assert.equal(yield* store.saveAgreementCandidate(candidate(`task-${task}`, `p-${index}`, index)), "saved");
  }));
  assert.equal((yield* store.agreementCandidates("task-99")).length, 50);
  assert.equal(yield* store.saveAgreementCandidate(candidate("task-100", "p-0", 0)), "full");
  assert.equal((yield* store.agreementCandidates("task-100")).length, 0);
}), {timeout: 10_000});

it.effect("CT-CSTORE-04: prune never deletes uncertain or unacknowledged failed review requests", () => Effect.gen(function* () {
  const {open} = yield* conversationStore;
  const {sql, store} = yield* open;
  const now = baseTime;
  const old = now - 31 * 86_400_000;
  const save = (id: string, state: ConversationRequest["state"], kind: ConversationRequest["kind"], extra: Partial<ConversationRequest> = {}) =>
    store.saveRequest({...reviewInput(`supervisor-${id}`), kind, id, messageId: `supervisor-review:${id}`, state, createdAt: old, sentAt: null, runId: null, error: null, ...extra});
  yield* save("completed", "completed", "review");
  yield* save("failed-context", "failed", "context");
  yield* save("failed-review-acknowledged", "failed", "review", {failureAcknowledged: true});
  yield* save("failed-review", "failed", "review");
  yield* save("uncertain", "uncertain", "review");
  yield* save("waiting", "waiting", "review");
  // more than 100 terminal requests of one Supervisor keep only the newest 100 terminal ones
  for (let index = 0; index < 101; index++)
    yield* store.saveRequest({...reviewInput("supervisor-many"), id: `many-${String(index).padStart(3, "0")}`, messageId: `m-${index}`, state: "completed",
      createdAt: now - 1_000 + index, sentAt: null, runId: null, error: null});
  yield* store.saveRequest({...reviewInput("supervisor-many"), id: "many-uncertain", messageId: "m-uncertain", state: "uncertain", createdAt: now - 2_000, sentAt: null, runId: null, error: null});
  yield* store.saveRequest({...reviewInput("supervisor-many"), id: "many-failed", messageId: "m-failed", state: "failed", createdAt: now - 2_000, sentAt: null, runId: null, error: null});
  yield* store.prune(now);
  const remaining = new Set((yield* query(sql, "SELECT id FROM supervisor_conversation_requests")).map(row => String(row.id)));
  for (const id of ["failed-review", "uncertain", "waiting", "many-uncertain", "many-failed"]) assert.ok(remaining.has(id), id);
  for (const id of ["completed", "failed-context", "failed-review-acknowledged", "many-000"]) assert.equal(remaining.has(id), false, id);
  assert.equal([...remaining].filter(id => id.startsWith("many-") && /\d$/u.test(id)).length, 100);
}), {timeout: 10_000});
