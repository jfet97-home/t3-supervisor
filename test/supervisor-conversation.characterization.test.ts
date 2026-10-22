import assert from "node:assert/strict";
import { it, type TestContext } from "vitest";
import { after, mockMethod } from "./support/node-test.js";
import { withDeadline } from "./support/c1-loopback.js";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { GuidanceStore } from "../src/guidance-store.js";
import { SupervisorConversationStore, type ConversationRequest, type WorkflowAgreementCandidate } from "../src/supervisor-conversation-store.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { workflowIntroductionText } from "../src/supervisor-conversation.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortHonouringSend, addCommandActivity, appendMessageToRun, proceed, appendNoticeToOperative, appendOperativeAcceptance, appendSupervisorProposal, baseTime, completeRun,
  makeFixture, observeAgreement, operativeThreadId, projectId, workflowRecord, type Fixture, type RpcCall,
} from "./support/c1-conversation-fixture.js";

const isCheckIn = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === fixture.binding.threadId;

// a fixture with a sent introduction and three due command activities, observed into the monitor
const dueCheckIn = async (t: TestContext, clock: {now: number}) => {
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, {settings: {intervalMinutes: 5, activityThreshold: 3}});
  after(t, fixture.cleanup);
  appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  return fixture;
};

// holds the matching send at the fake peer: abort-honouring, or never settling until the test ends
const holdSend = (t: TestContext, fixture: Fixture, matches: (call: RpcCall) => boolean, mode: "abort" | "crash") => {
  const reached = Promise.withResolvers<RpcCall>();
  const pending: Array<PromiseWithResolvers<unknown>> = [];
  fixture.intercept((call, signal) => {
    if (!matches(call)) return null;
    reached.resolve(call);
    if (mode === "abort") return abortHonouringSend(signal);
    const never = Promise.withResolvers<unknown>();
    pending.push(never);
    return never.promise;
  });
  after(t, () => {
    reached.reject(new Error("the send was never reached"));
    for (const never of pending) never.reject(new Error("abandoned send"));
  });
  return withDeadline(reached.promise, 3_000, "held send");
};

it("CT-CONV-01: aborting run() after the 'sending' commit saves the check-in 'uncertain' with its identity and one dispatch", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  const fixture = await dueCheckIn(t, clock);
  const controller = new AbortController();
  const reached = holdSend(t, fixture, isCheckIn(fixture), "abort");
  const running = fixture.run(controller.signal);
  const call = await reached;
  const sending = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(sending?.kind === "review");
  assert.equal(sending.state, "sending");
  assert.equal(sending.sentAt, clock.now);
  assert.equal(fixture.conversation.requests.lastNotice(fixture.binding.threadId), clock.now);
  assert.equal(call.payload.messageId, sending.messageId);
  assert.equal(call.payload.commandId, `supervisor-review:${sending.id}`);

  controller.abort();
  await withDeadline(running, 3_000, "aborted run");
  const uncertain = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "Supervisor request delivery is uncertain; its original identity is retained and only observed, never resent."});

  fixture.intercept(null);
  clock.now += 120_000;
  await fixture.run();
  await fixture.run();
  assert.deepEqual(fixture.conversation.requests.pending(projectId, fixture.binding.threadId), uncertain);
  assert.equal(fixture.calls.filter(isCheckIn(fixture)).length, 1);
});

it("CT-CONV-01: a crash after the 'sending' commit keeps the row 'sending' until a new controller marks it 'uncertain', with one dispatch", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  const fixture = await dueCheckIn(t, clock);
  const reached = holdSend(t, fixture, isCheckIn(fixture), "crash");
  const abandoned = fixture.run().then(() => "settled", () => "failed");
  after(t, () => withDeadline(abandoned, 3_000, "abandoned run"));
  const call = await reached;
  const sending = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(sending?.state === "sending");
  fixture.crash();

  fixture.intercept(null);
  const restarted = fixture.reopen();
  assert.deepEqual(restarted.conversation.requests.pending(projectId, fixture.binding.threadId), sending, "reopening performs no recovery");
  clock.now += 1_000;
  await restarted.run();
  const uncertain = restarted.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "The native request has no confirmed matching run yet. Its identity and pending activity are retained."});
  clock.now += 120_000;
  await restarted.run();
  assert.deepEqual(restarted.conversation.requests.pending(projectId, fixture.binding.threadId), uncertain);
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [call]);
  assert.equal(call.payload.commandId, `supervisor-review:${sending.id}`);
  assert.equal(fixture.calls.length, 1);
});

const isIntroduction = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === operativeThreadId &&
  String(call.payload.messageId).startsWith(`supervisor-notice:workflow:${fixture.task.id}`);

it("CT-CONV-02: aborting the introduction POST saves it 'uncertain'; Retry, later cycles and a restart never dispatch it again", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  after(t, fixture.cleanup);
  const controller = new AbortController();
  const reached = holdSend(t, fixture, isIntroduction(fixture), "abort");
  const running = fixture.run(controller.signal);
  const call = await reached;
  const sending = fixture.conversation.requests.introduction(fixture.task.id);
  assert.ok(sending);
  assert.equal(sending.state, "sending");
  assert.deepEqual(sending.dispatchMode, {type: "steer_active", targetRunId: "operative-active-run"});
  assert.equal(call.payload.messageId, sending.messageId);
  assert.equal(call.payload.commandId, `supervisor-workflow:${fixture.task.id}`);

  controller.abort();
  await withDeadline(running, 3_000, "aborted run");
  const uncertain = fixture.conversation.requests.introduction(fixture.task.id);
  assert.deepEqual(uncertain, {...sending, state: "uncertain", definiteRejection: false, error: "Proposal delivery is uncertain. Its exact message identity is retained."});

  fixture.intercept(null);
  clock.now += 61_000;
  await fixture.run();
  const observed = fixture.conversation.requests.introduction(fixture.task.id);
  assert.deepEqual(observed, {...uncertain, error: "Proposal delivery is uncertain; its message identity is retained. Retry native access rather than sending another proposal."});
  fixture.conversation.retry(projectId, fixture.binding.threadId);
  await fixture.run();
  const restarted = fixture.reopen();
  restarted.conversation.retry(projectId, fixture.binding.threadId);
  await restarted.run();
  await restarted.run();
  assert.deepEqual(restarted.conversation.requests.introduction(fixture.task.id), observed);
  assert.deepEqual(fixture.calls.filter(isIntroduction(fixture)), [call]);
  assert.deepEqual(fixture.calls, [call]);
});

it("CT-CONV-02: a crash during the introduction POST keeps it 'sending'; the next cycle marks it 'uncertain' and Retry never resends", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  after(t, fixture.cleanup);
  const reached = holdSend(t, fixture, isIntroduction(fixture), "crash");
  const abandoned = fixture.run().then(() => "settled", () => "failed");
  after(t, () => withDeadline(abandoned, 3_000, "abandoned run"));
  const call = await reached;
  const sending = fixture.conversation.requests.introduction(fixture.task.id);
  assert.ok(sending?.state === "sending");
  fixture.crash();

  fixture.intercept(null);
  const restarted = fixture.reopen();
  assert.deepEqual(restarted.conversation.requests.introduction(fixture.task.id), sending, "reopening performs no recovery");
  clock.now += 1_000;
  await restarted.run();
  const uncertain = restarted.conversation.requests.introduction(fixture.task.id);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "Proposal delivery is uncertain; its message identity is retained. Retry native access rather than sending another proposal."});
  restarted.conversation.retry(projectId, fixture.binding.threadId);
  clock.now += 61_000;
  await restarted.run();
  const again = fixture.reopen();
  await again.run();
  assert.deepEqual(again.conversation.requests.introduction(fixture.task.id), uncertain);
  assert.deepEqual(fixture.calls, [call]);
});

it("CT-CONV-03: aborting the Stop-notice POST keeps the notice 'uncertain' with its identity; later observation never sends a second notice", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  after(t, fixture.cleanup);
  appendNoticeToOperative(fixture);
  const signal = AbortSignal.timeout(10_000);
  const service = fixture.makeProjectSupervisor();
  await service.setChatSupervision({projectId, mainThreadId: operativeThreadId, enabled: false, policyGeneration: fixture.threadPolicy.get().generation}, signal);
  const prepared = fixture.projectStore.binding(projectId, operativeThreadId)?.stopNotice;
  assert.ok(prepared);
  const isNotice = (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.messageId === prepared.messageId;
  const controller = new AbortController();
  const reached = holdSend(t, fixture, isNotice, "abort");
  const running = fixture.conversation.reconcileStopNotice(fixture.binding, controller.signal);
  const call = await reached;
  const uncertain = fixture.projectStore.binding(projectId, operativeThreadId)?.stopNotice;
  assert.ok(uncertain);
  assert.equal(uncertain.state, "uncertain");
  assert.deepEqual(uncertain.dispatchMode, {type: "steer_active", targetRunId: "operative-active-run"});
  assert.equal(call.payload.commandId, prepared.commandId);
  assert.equal(call.payload.threadId, operativeThreadId);

  controller.abort();
  await withDeadline(running, 3_000, "aborted notice");
  assert.deepEqual(fixture.projectStore.binding(projectId, operativeThreadId)?.stopNotice, uncertain, "a non-definite failure saves nothing over the reservation");

  fixture.intercept(null);
  for (let index = 0; index < 4; index++) {
    clock.now += 61_000;
    await fixture.conversation.reconcileStopNotice(fixture.binding, signal);
  }
  fixture.conversation.retry(projectId, fixture.binding.threadId);
  await fixture.conversation.reconcileStopNotice(fixture.binding, signal);
  const observed = fixture.projectStore.binding(projectId, operativeThreadId)?.stopNotice;
  assert.equal(observed?.messageId, prepared.messageId);
  assert.equal(observed?.commandId, prepared.commandId);
  assert.equal(observed?.text, prepared.text);
  // three invisible observations made it unconfirmed; Retry only re-armed one more observation of the same identity
  assert.equal(observed?.state, "uncertain");
  assert.equal(observed?.visibilityMisses, 1);
  assert.deepEqual(fixture.calls.filter(item => item.payload.threadId === operativeThreadId), [call]);
});

const reviewState = (db: DatabaseSync, supervisorThreadId: string, requestId: string) => {
  const request = db.prepare("SELECT document FROM supervisor_conversation_requests WHERE id=?").get(requestId);
  const binding = db.prepare("SELECT document FROM supervisor_main_bindings WHERE main_thread_id=?").get(operativeThreadId);
  const clock = db.prepare("SELECT review_misses FROM supervisor_monitor_binding_clock WHERE supervisor_thread_id=?").get(supervisorThreadId);
  const acknowledged = db.prepare("SELECT item_id FROM supervisor_monitor_items WHERE project_id=? AND thread_id=? AND reviewed_version=version ORDER BY item_id").all(projectId, operativeThreadId);
  const document = JSON.parse(String(request?.document)) as {state: string; error: string | null; runId: string | null};
  return {state: document.state, error: document.error, runId: document.runId,
    deliveredRoleVersion: (JSON.parse(String(binding?.document)) as {deliveredRoleVersion?: string}).deliveredRoleVersion ?? null,
    reviewMisses: Number(clock?.review_misses), acknowledged: acknowledged.map(row => String(row.item_id))};
};

const waitingReview = async (t: TestContext, clock: {now: number}) => {
  const fixture = await dueCheckIn(t, clock);
  await fixture.run();
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(request?.kind === "review" && request.state === "waiting" && request.batch && request.roleVersion);
  const run = fixture.supervisor.runs.find(item => item.userMessageId === request.messageId);
  assert.ok(run);
  return {fixture, request, run};
};

it("CT-CONV-04: a failure at the monitor acknowledgement rolls back completion, deliveredRoleVersion and the miss reset, also after reopen", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  const {fixture, request, run} = await waitingReview(t, clock);
  fixture.conversation.requests.missedReview(fixture.binding.threadId);
  completeRun(fixture.supervisor, run, `No intervention is needed. ${request.completionMarker}`, clock.now + 1);
  clock.now += 1;
  const before = {state: "waiting", error: null, runId: run.id, deliveredRoleVersion: null, reviewMisses: 1, acknowledged: []};
  const pendingBefore = fixture.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id);
  assert.ok(["command-1", "command-2", "command-3"].every(id => pendingBefore.includes(id)));
  fixture.guidance.db.exec("CREATE TEMP TRIGGER c1_fail_acknowledgement BEFORE UPDATE OF reviewed_version ON supervisor_monitor_items BEGIN SELECT RAISE(ABORT, 'c1 injected acknowledgement failure'); END");
  await assert.rejects(fixture.run(), /c1 injected acknowledgement failure/u);
  assert.deepEqual(reviewState(fixture.guidance.db, fixture.binding.threadId, request.id), before);
  const reopened = fixture.reopen();
  assert.deepEqual(reviewState(reopened.guidance.db, fixture.binding.threadId, request.id), before);
  assert.deepEqual(reopened.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id), pendingBefore);

  // the same reconcile succeeds once the failure is gone
  fixture.guidance.db.exec("DROP TRIGGER c1_fail_acknowledgement");
  await fixture.run();
  const completed = reviewState(fixture.guidance.db, fixture.binding.threadId, request.id);
  assert.deepEqual(completed, {state: "completed", error: null, runId: run.id, deliveredRoleVersion: request.roleVersion, reviewMisses: 0,
    acknowledged: [...pendingBefore].sort()});
  assert.deepEqual(fixture.conversation.monitor.pending(projectId, operativeThreadId), []);
});

it("CT-CONV-04: a failure after the miss increment rolls back the counter and the request state, also after reopen", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  const {fixture, request, run} = await waitingReview(t, clock);
  completeRun(fixture.supervisor, run, "The completed review omitted its required marker.", clock.now + 1);
  clock.now += 1;
  const before = {state: "waiting", error: null, runId: run.id, deliveredRoleVersion: null, reviewMisses: 0, acknowledged: []};
  fixture.guidance.db.exec(`CREATE TEMP TRIGGER c1_fail_close BEFORE UPDATE ON supervisor_conversation_requests
    WHEN json_extract(NEW.document,'$.state') IN ('completed','failed') BEGIN SELECT RAISE(ABORT, 'c1 injected close failure'); END`);
  await assert.rejects(fixture.run(), /c1 injected close failure/u);
  assert.deepEqual(reviewState(fixture.guidance.db, fixture.binding.threadId, request.id), before);
  const reopened = fixture.reopen();
  assert.deepEqual(reviewState(reopened.guidance.db, fixture.binding.threadId, request.id), before);

  fixture.guidance.db.exec("DROP TRIGGER c1_fail_close");
  await fixture.run();
  assert.deepEqual(reviewState(fixture.guidance.db, fixture.binding.threadId, request.id), {state: "completed",
    error: "The check-in output was not confirmed; pending activity will be checked again after the cooldown.", runId: run.id,
    deliveredRoleVersion: null, reviewMisses: 1, acknowledged: []});
});

it("CT-CONV-09: a non-applied workflow agreement import logs one event with its status only", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  after(t, fixture.cleanup);
  // an incompatible stored workflow-state document makes the import report 'incompatible'
  fixture.guidance.db.prepare(`INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,
    revision,document,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,1,?,?,?)`).run("legacy-workflow", projectId, operativeThreadId, operativeThreadId,
    JSON.stringify({formatVersion: 1}), clock.now, clock.now);
  appendNoticeToOperative(fixture);
  appendSupervisorProposal(fixture, fixture.task.id, undefined, clock.now);
  appendOperativeAcceptance(fixture, workflowRecord(fixture.task, fixture.task.id), clock.now + 1);
  const lines: unknown[][] = [];
  mockMethod(t, console, "log", (...values: unknown[]) => {lines.push(values);});
  await observeAgreement(fixture, clock.now + 30_000);
  assert.equal(fixture.projectStore.task(operativeThreadId)?.agreement?.status, "agreed");
  assert.deepEqual(lines, [[JSON.stringify({event: "workflow_agreement_import_unavailable", status: "incompatible"})]]);
});

// a sent introduction for a task of another binding, visible in its main
const introduceBound = (fixture: Fixture, bound: ReturnType<Fixture["addBoundOperative"]>) => {
  const introduction = {taskId: bound.task.id, projectId, threadId: bound.task.threadId, supervisorThreadId: bound.binding.threadId, state: "sent" as const,
    text: workflowIntroductionText(bound.task), messageId: `supervisor-notice:workflow:${bound.task.id}`, targetRunId: String(bound.projection.thread.activeRunId), error: null};
  fixture.conversation.requests.saveIntroduction(introduction);
  const run = bound.projection.runs.find(item => item.id === introduction.targetRunId);
  assert.ok(run);
  appendMessageToRun(bound.projection, run, {id: introduction.messageId, role: "user", text: introduction.text, createdBy: "user", creationSource: "server"});
};

it("CT-CONV-06: interleaved cycles of two bindings keep request identities and cooldown clocks apart and never acknowledge across bindings", {timeout: 10_000}, async t => {
  const start = baseTime;
  const clock = {now: start};
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, {settings: {intervalMinutes: 5, activityThreshold: 3}});
  after(t, fixture.cleanup);
  const second = fixture.addBoundOperative("operative-b", "proposal-b");
  appendNoticeToOperative(fixture);
  introduceBound(fixture, second);
  for (let index = 1; index <= 3; index++) {
    addCommandActivity(fixture.operative, `a-command-${index}`, `A_BODY_${index}`, clock.now - index * 1_000);
    addCommandActivity(second.projection, `b-command-${index}`, `B_BODY_${index}`, clock.now - index * 1_000);
  }
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  const supervisors = new Set([fixture.binding.threadId, second.binding.threadId]);
  const held = new Map<string, PromiseWithResolvers<unknown>>();
  const reached = new Map<string, PromiseWithResolvers<void>>([...supervisors].map(id => [id, Promise.withResolvers<void>()]));
  fixture.intercept(call => {
    const target = String(call.payload.threadId);
    if (call.payload.type !== "message.dispatch" || !supervisors.has(target)) return null;
    const gate = Promise.withResolvers<unknown>();
    held.set(target, gate);
    reached.get(target)?.resolve();
    return gate.promise;
  });
  after(t, () => {
    for (const gate of held.values()) gate.resolve(proceed);
    for (const gate of reached.values()) gate.resolve();
  });
  // the first cycle is parked at its POST while the second binding's cycle and an observation run
  const firstCycle = fixture.run();
  await withDeadline(reached.get(fixture.binding.threadId)!.promise, 3_000, "first check-in");
  clock.now = start + 10_000;
  const observing = fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  const secondCycle = second.run();
  await withDeadline(reached.get(second.binding.threadId)!.promise, 3_000, "second check-in");
  const first = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  const other = fixture.conversation.requests.pending(projectId, second.binding.threadId);
  assert.ok(first && other);
  assert.notEqual(first.id, other.id);
  assert.deepEqual([first.state, first.sentAt, other.state, other.sentAt], ["sending", start, "sending", start + 10_000]);
  assert.deepEqual(first.batch?.threads.map(thread => thread.threadId), [operativeThreadId]);
  assert.deepEqual(other.batch?.threads.map(thread => thread.threadId), ["operative-b"]);
  assert.equal(fixture.conversation.requests.lastNotice(fixture.binding.threadId), start);
  assert.equal(fixture.conversation.requests.lastNotice(second.binding.threadId), start + 10_000);
  // released in reverse order
  held.get(second.binding.threadId)!.resolve(proceed);
  await withDeadline(secondCycle, 3_000, "second cycle");
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId)?.state, "sending");
  held.get(fixture.binding.threadId)!.resolve(proceed);
  await withDeadline(Promise.all([firstCycle, observing]), 3_000, "first cycle");
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId)?.state, "waiting");
  assert.equal(fixture.conversation.requests.pending(projectId, second.binding.threadId)?.state, "waiting");

  // completing only the first review acknowledges only its own frozen batch
  const firstRun = fixture.supervisor.runs.find(run => run.userMessageId === first.messageId);
  assert.ok(firstRun);
  completeRun(fixture.supervisor, firstRun, `No intervention is needed. ${first.completionMarker}`, start + 20_000);
  clock.now = start + 20_000;
  await fixture.run();
  await second.run();
  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === first.id)?.state, "completed");
  assert.equal(fixture.conversation.requests.pending(projectId, second.binding.threadId)?.id, other.id);
  assert.deepEqual(fixture.conversation.monitor.pending(projectId, operativeThreadId), []);
  assert.ok(["b-command-1", "b-command-2", "b-command-3"].every(id => fixture.conversation.monitor.pending(projectId, "operative-b").some(item => item.id === id)));
  const otherRun = second.supervisor.runs.find(run => run.userMessageId === other.messageId);
  assert.ok(otherRun);
  completeRun(second.supervisor, otherRun, `No intervention is needed. ${other.completionMarker}`, start + 20_001);
  clock.now = start + 20_001;
  await second.run();
  assert.deepEqual(fixture.conversation.monitor.pending(projectId, "operative-b"), []);

  // each binding's cooldown runs from its own last notice
  for (let index = 4; index <= 6; index++) {
    addCommandActivity(fixture.operative, `a-command-${index}`, `A_BODY_${index}`, start + 25_000 + index);
    addCommandActivity(second.projection, `b-command-${index}`, `B_BODY_${index}`, start + 25_000 + index);
  }
  clock.now = start + 30_000;
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  fixture.intercept(null);
  const checkIns = (supervisorThreadId: string) => fixture.calls.filter(call => call.payload.threadId === supervisorThreadId).length;
  clock.now = start + 60_000;
  await fixture.run();
  await second.run();
  assert.deepEqual([checkIns(fixture.binding.threadId), checkIns(second.binding.threadId)], [2, 1]);
  clock.now = start + 70_000;
  await second.run();
  assert.deepEqual([checkIns(fixture.binding.threadId), checkIns(second.binding.threadId)], [2, 2]);
});

const tableDigest = (db: DatabaseSync): string => {
  const hash = createHash("sha256");
  for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{name: string}>)
    hash.update(`${name}\0${JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())}\0`);
  return hash.digest("hex");
};
const totalChanges = (db: DatabaseSync): number => Number(db.prepare("SELECT total_changes() AS n").get()?.n);

it("CT-CONV-07: an enabled binding without an inferred task or activity makes no native call and no write in run() and observe()", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, {task: false});
  after(t, fixture.cleanup);
  const digest = tableDigest(fixture.guidance.db);
  const changes = totalChanges(fixture.guidance.db);
  const reads = fixture.projectionReads.length;
  for (let cycle = 0; cycle < 3; cycle++) {
    await fixture.run();
    await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
    clock.now += 61_000;
  }
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.projectionReads.length, reads);
  assert.equal(totalChanges(fixture.guidance.db), changes);
  assert.equal(tableDigest(fixture.guidance.db), digest);
});

it("CT-CONV-08: a check-in is withheld at lastNotice+59999 ms and dispatched at lastNotice+60000 ms", {timeout: 10_000}, async t => {
  const start = baseTime;
  const clock = {now: start};
  const fixture = await dueCheckIn(t, clock);
  await fixture.run();
  const first = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(first);
  assert.equal(fixture.conversation.requests.lastNotice(fixture.binding.threadId), start);
  const run = fixture.supervisor.runs.find(item => item.userMessageId === first.messageId);
  assert.ok(run);
  completeRun(fixture.supervisor, run, `No intervention is needed. ${first.completionMarker}`, start + 1);
  clock.now = start + 1;
  await fixture.run();
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId), null);
  for (let index = 4; index <= 6; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, start + 2);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), start + 5_001);
  const checkIns = () => fixture.calls.filter(isCheckIn(fixture)).length;
  clock.now = start + 59_999;
  await fixture.run();
  assert.equal(checkIns(), 1);
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId), null);
  clock.now = start + 60_000;
  await fixture.run();
  assert.equal(checkIns(), 2);
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId)?.sentAt, start + 60_000);
});

it("CT-CONV-08: an unseen uncertain Stop notice is next observed exactly 60000 ms after its deferral", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  after(t, fixture.cleanup);
  appendNoticeToOperative(fixture);
  const signal = AbortSignal.timeout(10_000);
  await fixture.makeProjectSupervisor().setChatSupervision({projectId, mainThreadId: operativeThreadId, enabled: false, policyGeneration: fixture.threadPolicy.get().generation}, signal);
  fixture.intercept(call => call.payload.threadId === operativeThreadId ? Promise.reject(new SupervisorRpcError("uncertain")) : null);
  await fixture.conversation.reconcileStopNotice(fixture.binding, signal);
  assert.equal(fixture.projectStore.binding(projectId, operativeThreadId)?.stopNotice?.state, "uncertain");
  fixture.intercept(null);
  const deferredAt = clock.now;
  await fixture.conversation.reconcileStopNotice(fixture.binding, signal);
  const deferred = fixture.projectStore.binding(projectId, operativeThreadId)?.stopNotice;
  assert.equal(deferred?.nextObserveAt, deferredAt + 60_000);
  assert.equal(deferred?.visibilityMisses, 1);
  const reads = () => fixture.projectionReads.filter(id => id === operativeThreadId).length;
  const before = reads();
  clock.now = deferredAt + 59_999;
  await fixture.conversation.reconcileStopNotice(fixture.binding, signal);
  assert.equal(reads(), before);
  clock.now = deferredAt + 60_000;
  await fixture.conversation.reconcileStopNotice(fixture.binding, signal);
  assert.equal(reads(), before + 1);
  assert.equal(fixture.projectStore.binding(projectId, operativeThreadId)?.stopNotice?.nextObserveAt, deferredAt + 120_000);
  assert.equal(fixture.calls.filter(call => call.payload.threadId === operativeThreadId).length, 1);
});

it("CT-CONV-08: an accepted but invisible introduction blocks only after strictly more than 60000 ms and three misses", {timeout: 10_000}, async t => {
  const start = baseTime;
  const clock = {now: start};
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  after(t, fixture.cleanup);
  // T3 accepts the introduction, but it never becomes visible unchanged
  fixture.intercept(call => isIntroduction(fixture)(call) ? Promise.resolve({sequence: 1}) : null);
  await fixture.run();
  const accepted = fixture.conversation.requests.introduction(fixture.task.id);
  assert.equal(accepted?.state, "accepted");
  assert.equal(accepted?.acceptedAt, start);
  const observeAt = async (time: number) => {
    clock.now = time;
    await fixture.run();
    const current = fixture.conversation.requests.introduction(fixture.task.id);
    return [current?.state, current?.visibilityMisses];
  };
  assert.deepEqual(await observeAt(start + 1), ["accepted", 1]);
  assert.deepEqual(await observeAt(start + 2), ["accepted", 2]);
  assert.deepEqual(await observeAt(start + 60_000), ["accepted", 3]);
  assert.deepEqual(await observeAt(start + 60_001), ["blocked", 4]);
  assert.equal(fixture.calls.filter(isIntroduction(fixture)).length, 1);
});

const conversationStore = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "c1-conversation-store-"));
  const opened: GuidanceStore[] = [];
  const open = () => {
    const guidance = new GuidanceStore(directory);
    opened.push(guidance);
    return {guidance, store: new SupervisorConversationStore(guidance)};
  };
  after(t, async () => {
    for (const guidance of opened) try {guidance.close();} catch { /* closed by the test */ }
    await rm(directory, {recursive: true, force: true});
  });
  return {open};
};
const requestCount = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM supervisor_conversation_requests").get()?.n);
const reviewInput = (supervisorThreadId: string) => ({projectId, supervisorThreadId, kind: "review" as const, taskId: null, text: "Review.", batch: null, completionMarker: "done"});

it("CT-CSTORE-01: prepare() beside a pending request throws supervisor_request_inflight before pruning or inserting", {timeout: 10_000}, async t => {
  const {open} = await conversationStore(t);
  const {guidance, store} = open();
  const now = baseTime;
  const row = (id: string, supervisorThreadId: string, state: ConversationRequest["state"], createdAt: number): ConversationRequest =>
    ({...reviewInput(supervisorThreadId), id, messageId: `supervisor-review:${id}`, state, createdAt, sentAt: null, runId: null, error: null});
  // an old completed request that a successful prepare prunes
  store.saveRequest(row("old-completed", "other-supervisor", "completed", now - 31 * 86_400_000));
  for (const state of ["prepared", "sending", "waiting", "uncertain"] as const) {
    store.saveRequest(row(`pending-${state}`, "supervisor-a", state, now));
    const count = requestCount(guidance.db);
    assert.throws(() => store.prepare(reviewInput("supervisor-a"), now + 1), {message: "supervisor_request_inflight"});
    assert.equal(requestCount(guidance.db), count, state);
    assert.equal(store.requests(projectId, "other-supervisor").length, 1, `${state}: nothing was pruned`);
    store.saveRequest(row(`pending-${state}`, "supervisor-a", "completed", now));
  }
  assert.equal(requestCount(guidance.db), 5);
  const next = store.prepare(reviewInput("supervisor-a"), now + 2);
  assert.equal(next.state, "prepared");
  assert.equal(requestCount(guidance.db), 5, "the successful prepare pruned the old completed request and inserted one");
  assert.equal(store.requests(projectId, "other-supervisor").length, 0);
});

it("CT-CSTORE-03: a request saved 'sending' survives reopen unchanged and only the controller marks it 'uncertain'", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  after(t, fixture.cleanup);
  const prepared = fixture.conversation.requests.prepare(reviewInput(fixture.binding.threadId), clock.now);
  const sending: ConversationRequest = {...prepared, state: "sending", sentAt: clock.now};
  fixture.conversation.requests.saveRequest(sending);
  fixture.crash();
  const reopened = fixture.reopen();
  assert.deepEqual(reopened.conversation.requests.pending(projectId, fixture.binding.threadId), sending);
  const again = fixture.reopen();
  assert.deepEqual(again.conversation.requests.requests(projectId), [sending]);
  clock.now += 1_000;
  await again.run();
  assert.deepEqual(again.conversation.requests.pending(projectId, fixture.binding.threadId), {...sending, state: "uncertain",
    error: "The native request has no confirmed matching run yet. Its identity and pending activity are retained."});
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), []);
});

const candidate = (taskId: string, proposalId: string, at: number): WorkflowAgreementCandidate => ({taskId, projectId, proposalId, planHash: `hash-${proposalId}`,
  workflow: {status: "proposed", message: "Draft.", workspaceRoot: "/work", revision: "r1", globalRevision: null, definitionsStatus: "ready",
    definitionsComplete: true, requirementsKnown: true, requirements: [], issues: [], plan: null},
  supervisorMessageId: `message-${proposalId}`, supervisorRunId: "run", supervisorRunOrdinal: 1, supervisorTextHash: "text", proposedAt: at});

it("CT-CSTORE-04: agreement evidence is write-once and candidates are full at 50 per task and 5000 per project", {timeout: 10_000}, async t => {
  const {open} = await conversationStore(t);
  const {guidance, store} = open();
  assert.equal(store.saveAgreementCandidate(candidate("task-0", "p-0", 1)), "saved");
  store.saveAgreementEvidence("task-0", "p-0", "agent-1", "hash-1");
  store.saveAgreementEvidence("task-0", "p-0", "agent-2", "hash-2");
  store.saveAgreementEvidence("task-0", "p-0", "agent-1", "hash-other");
  store.saveAgreementEvidence("task-0", "p-0", "agent-1", "hash-1");
  assert.deepEqual([store.agreementCandidate("task-0", "p-0")?.agentMessageId, store.agreementCandidate("task-0", "p-0")?.agentTextHash], ["agent-1", "hash-1"]);
  store.saveAgreementEvidence("task-0", "missing", "agent-1", "hash-1");
  assert.equal(store.agreementCandidate("task-0", "missing"), null);

  for (let index = 1; index < 50; index++) assert.equal(store.saveAgreementCandidate(candidate("task-0", `p-${index}`, index)), "saved");
  assert.equal(store.saveAgreementCandidate(candidate("task-0", "p-50", 50)), "full");
  assert.equal(store.saveAgreementCandidate(candidate("task-0", "p-1", 1)), "same");
  assert.equal(store.saveAgreementCandidate({...candidate("task-0", "p-1", 1), planHash: "changed"}), "conflict");
  // one transaction keeps the 4950 store writes from paying a synchronous commit each
  guidance.transaction(() => {
    for (let task = 1; task < 100; task++)
      for (let index = 0; index < 50; index++) assert.equal(store.saveAgreementCandidate(candidate(`task-${task}`, `p-${index}`, index)), "saved");
  });
  assert.equal(store.agreementCandidates("task-99").length, 50);
  assert.equal(store.saveAgreementCandidate(candidate("task-100", "p-0", 0)), "full");
  assert.equal(store.agreementCandidates("task-100").length, 0);
});

it("CT-CSTORE-04: prune never deletes uncertain or unacknowledged failed review requests", {timeout: 10_000}, async t => {
  const {open} = await conversationStore(t);
  const {guidance, store} = open();
  const now = baseTime;
  const old = now - 31 * 86_400_000;
  const save = (id: string, state: ConversationRequest["state"], kind: ConversationRequest["kind"], extra: Partial<ConversationRequest> = {}) =>
    store.saveRequest({...reviewInput(`supervisor-${id}`), kind, id, messageId: `supervisor-review:${id}`, state, createdAt: old, sentAt: null, runId: null, error: null, ...extra});
  save("completed", "completed", "review");
  save("failed-context", "failed", "context");
  save("failed-review-acknowledged", "failed", "review", {failureAcknowledged: true});
  save("failed-review", "failed", "review");
  save("uncertain", "uncertain", "review");
  save("waiting", "waiting", "review");
  // more than 100 terminal requests of one Supervisor keep only the newest 100 terminal ones
  for (let index = 0; index < 101; index++)
    store.saveRequest({...reviewInput("supervisor-many"), id: `many-${String(index).padStart(3, "0")}`, messageId: `m-${index}`, state: "completed",
      createdAt: now - 1_000 + index, sentAt: null, runId: null, error: null});
  store.saveRequest({...reviewInput("supervisor-many"), id: "many-uncertain", messageId: "m-uncertain", state: "uncertain", createdAt: now - 2_000, sentAt: null, runId: null, error: null});
  store.saveRequest({...reviewInput("supervisor-many"), id: "many-failed", messageId: "m-failed", state: "failed", createdAt: now - 2_000, sentAt: null, runId: null, error: null});
  store.prune(now);
  const remaining = new Set((guidance.db.prepare("SELECT id FROM supervisor_conversation_requests").all() as Array<{id: string}>).map(row => row.id));
  for (const id of ["failed-review", "uncertain", "waiting", "many-uncertain", "many-failed"]) assert.ok(remaining.has(id), id);
  for (const id of ["completed", "failed-context", "failed-review-acknowledged", "many-000"]) assert.equal(remaining.has(id), false, id);
  assert.equal([...remaining].filter(id => id.startsWith("many-") && /\d$/u.test(id)).length, 100);
});
