import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect } from "effect";
import { it } from "vitest";
import { projectSupervisorUnit } from "./support/team-units.js";
import { defaultSupervisorModel, prepareStopNotice, type BindingRecord, type SupervisionFolderPresence, type TaskRecord } from "../src/project-supervisor-store.js";
import { SupervisorIds } from "../src/ids.js";
import { SupervisorRpcError, type SupervisorRpc } from "../src/supervisor-native.js";
import type { SupervisorConfig } from "../src/types.js";
import { makeFixture as makeControlFixture, makeNoProjectFixture, supervisionStateDigest } from "./support/c2-ps-b-fixture.js";
import { addSupervisorRequest, completeSupervisorRequest, deferred, makeFixture, reserveReadyBinding, retryInput, within, workflowResult, type Fixture } from "./support/c2-ps-fixture.js";
import { metaRows, pssFixture, tableRows } from "./support/c2-pss-fixture.js";
import { after, mockMethod } from "./support/node-test.js";
import { openGuidance, openSupervisors, serviceOf, storeUnitOf, type DbFacade } from "./support/store-units.js";

const mainThreadId = "source-thread";

const sourceTask = [{threadId: mainThreadId, projectId: "project-a", turns: [{id: "source-task", sequence: 11, text: "Create a migration plan"}]}];

const interpretationDispatches = (fixture: Fixture, taskId: string) =>
  fixture.messageDispatches().filter(call => call.payload.commandId === `supervisor-objective:${taskId}`);

const identity = (call: {payload: Record<string, unknown>}) => ({commandId: call.payload.commandId, messageId: call.payload.messageId, text: call.payload.text,
  threadId: call.payload.threadId});

const taskRows = async (fixture: Fixture) => Number((await fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_task_interpretations WHERE thread_id=?").get(mainThreadId))?.n);

// a native interpretation dispatch that is recorded and then held until the test releases it, ignoring the cycle signal
const holdDispatch = (fixture: Fixture) => {
  const reached = deferred();
  const release = deferred<unknown>();
  fixture.setOperateHook((tag, payload) => {
    if (tag !== "orchestration.dispatchCommand" || payload.type !== "message.dispatch") return undefined;
    fixture.setOperateHook(null);
    reached.resolve();
    return release.promise;
  });
  return {reached: reached.promise, release};
};

const unresolvedStart = "An earlier Start is unresolved. Reconcile its operation ID before another request.";

const interruptedStartReason = "Start intake was interrupted before permission was reserved. Submit a new explicit request.";

const proposedWorkflow = {status: "proposed" as const, message: "Current draft", workspaceRoot: "/work/a", revision: "definitions-1", globalRevision: null,
  definitionsStatus: "ready" as const, definitionsComplete: true, requirementsKnown: true, requirements: [], issues: [], plan: null};

const inferredTask = (supervisorThreadId: string): TaskRecord => ({id: "task-inferred", threadId: "main-inferred", projectId: "project-a", sourceRunId: "run-1", sourceMessageId: "message-1",
  sourceHash: "hash-1", status: "inferred", objective: "Export CSV", reason: "Interpreted.", updatedAt: 100, requestText: "Add CSV export", supervisorThreadId,
  messageId: "notice-1", dispatchedAt: 50, replayCount: 0, supervisorRunId: "supervisor-run-1", sourceOrdinal: 1, workflow: proposedWorkflow,
  agreement: {status: "agreed", message: "Agreed.", proposalId: "proposal-1", agreedAt: 90, supervisorMessageId: "supervisor-message-1", agentMessageId: "agent-message-1", workflow: proposedWorkflow}});

const queuedTask = (threadId: string, supervisorThreadId: string, dispatchedAt: number | null): TaskRecord => ({id: `task-${threadId}`, threadId, projectId: "project-a",
  sourceRunId: "run-2", sourceMessageId: "message-2", sourceHash: "hash-2", status: "queued", objective: null, reason: "Queued for interpretation.", updatedAt: 110,
  requestText: "Interpret this request", supervisorThreadId, messageId: `notice-${threadId}`, dispatchedAt, replayCount: 0, supervisorRunId: null, sourceOrdinal: 2,
  definitionContext: null, definitionReadAttempts: 1, revalidationAttempts: 1});

const pssBoundary = {snapshotSequence: 7, threads: [{id: "main-a", latestRunId: "run-a"}]};

// written by the baseline writers below with Date.now fixed; this is the pre-migration on-disk format
const pssMetaGolden: Array<[string, string]> = [
  ["settings", "{\"generation\":1,\"guidancePaused\":false,\"monitoringPaused\":false,\"allowFollowupRace\":false,\"verifiedServerVersion\":null,\"model\":\"gpt-6-luna\",\"reasoning\":\"high\",\"dailyTokenBudget\":100000,\"evidenceHours\":24,\"maxAnchorAgeSeconds\":60}"],
  ["supervisor_activation_baseline", "{\"snapshotSequence\":7,\"threads\":[{\"id\":\"main-a\",\"latestRunId\":\"run-a\"}],\"version\":2}"],
  ["supervisor_activation_sequence", "7"],
  ["supervisor_control:\"project-a\"", "{\"generation\":1,\"enabled\":true,\"manual\":true,\"baseline\":{\"snapshotSequence\":7,\"threads\":[{\"id\":\"main-a\",\"latestRunId\":\"run-a\"}]}}"],
  ["supervisor_control:\"project-c\"", "{\"generation\":0,\"enabled\":false,\"manual\":false,\"baseline\":{\"snapshotSequence\":7,\"threads\":[{\"id\":\"main-a\",\"latestRunId\":\"run-a\"}]}}"],
  ["supervisor_control:null", "{\"generation\":1,\"enabled\":true,\"manual\":true}"],
  ["supervisor_control_auto:\"project-c\"", "{\"status\":\"present\",\"enabled\":true,\"checkedAt\":1790000000000}"],
  ["supervisor_control_presence_unavailable:\"project-b\"", "{\"checkedAt\":1790000000000}"],
  ["supervisor_global_definitions_control", "{\"generation\":1,\"enabled\":true,\"manual\":true}"],
  ["supervisor_global_definitions_event", "{\"generation\":1,\"enabled\":true,\"changedAt\":1790000000000,\"globalFingerprint\":\"global-fingerprint\"}"],
  ["supervisor_no_project", "{\"generation\":1,\"mode\":\"automatic\",\"baseline\":{\"snapshotSequence\":7,\"threads\":[{\"id\":\"main-a\",\"latestRunId\":\"run-a\"}]}}"],
  ["supervisor_scope_version", "main-v1"],
  ["supervisor_start:main-a", "{\"threadId\":\"main-a\",\"projectId\":\"project-a\",\"operationId\":\"op-1\",\"requestHash\":\"hash-1\",\"route\":\"ui\",\"status\":\"active\",\"reason\":\"Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.\",\"intentAt\":1790000000000,\"modeGeneration\":1,\"masterGeneration\":1,\"taskId\":null}"],
  ["supervisor_start_operation:[\"main-a\",\"op-1\"]", "{\"threadId\":\"main-a\",\"operationId\":\"op-1\",\"requestHash\":\"hash-1\",\"status\":\"active\",\"reason\":\"Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.\"}"],
  ["supervisor_unbound_stop:main-b", "{\"route\":\"ui\",\"callerThreadId\":null,\"userMessageId\":null,\"stoppedAt\":1790000000000}"],
];

const pssDdlGolden = [
  ["supervisor_chat_enables", "CREATE TABLE supervisor_chat_enables(thread_id TEXT PRIMARY KEY,enabled_at INTEGER NOT NULL)"],
  ["supervisor_definition_user_saves", "CREATE TABLE supervisor_definition_user_saves(project_id TEXT NOT NULL,workspace_root TEXT NOT NULL,signature TEXT NOT NULL,saved_at INTEGER NOT NULL,expected_revision TEXT NOT NULL,PRIMARY KEY(project_id,workspace_root))"],
  ["supervisor_main_bindings", "CREATE TABLE supervisor_main_bindings(project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(project_id,main_thread_id))"],
  ["supervisor_owned_threads", "CREATE TABLE supervisor_owned_threads(id TEXT PRIMARY KEY)"],
  ["supervisor_project_settings", "CREATE TABLE supervisor_project_settings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL)"],
  ["supervisor_task_interpretations", "CREATE TABLE supervisor_task_interpretations(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,updated_at INTEGER NOT NULL)"],
  ["supervisor_tasks_project", "CREATE INDEX supervisor_tasks_project ON supervisor_task_interpretations(project_id)"],
  ["meta", "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)"],
];

// the project store's own DDL; the run's other stores open their tables beside it
const pssDdl = async (db: DbFacade) => (await db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (name GLOB 'supervisor_*' OR name='meta') ORDER BY name='meta',name").all())
  .map(row => [String(row.name), String(row.sql)]).filter(([name]) => pssDdlGolden.some(([golden]) => golden === name));
// an outside reader's rows of a table, on its own synchronous connection
const readerRows = (db: DatabaseSync, table: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({...row}));

it("CT-PS-01: an aborted interpretation dispatch becomes uncertain and a crash keeps it dispatching; the next cycle replays the identical identity", {timeout: 10_000}, async t => {
  {
    // (a) abort: the operate rpc honours the cycle signal after the request left, as the native adapter does (outcome uncertain)
    const fixture = await makeFixture(sourceTask);
    after(t, fixture.cleanup);
    const controller = new AbortController();
    fixture.setOperateHook((tag, payload, signal) => {
      if (tag !== "orchestration.dispatchCommand" || payload.type !== "message.dispatch") return undefined;
      fixture.setOperateHook(null);
      queueMicrotask(() => controller.abort());
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new SupervisorRpcError("uncertain")), {once: true}));
    });
    const supervisor = fixture.makeSupervisor();
    await within(supervisor.runOnce(controller.signal), 5_000, "aborted runOnce");
    const uncertain = await fixture.supervisorStore.task(mainThreadId);
    assert.ok(uncertain);
    assert.equal(uncertain.status, "uncertain");
    assert.equal(uncertain.messageId, `supervisor-objective:${uncertain.id}`);
    assert.equal(uncertain.replayCount, 0);
    const [first] = interpretationDispatches(fixture, uncertain.id);
    assert.ok(first);
    assert.equal(fixture.messageDispatches().length, 1);

    await within(supervisor.runOnce(AbortSignal.timeout(5_000)), 5_000, "next runOnce");
    const replayed = await fixture.supervisorStore.task(mainThreadId);
    assert.ok(replayed);
    assert.equal(replayed.id, uncertain.id, "no new task identity");
    assert.equal(replayed.replayCount, 1);
    assert.equal(replayed.status, "waiting");
    assert.equal(fixture.messageDispatches().length, 2);
    assert.deepEqual(fixture.messageDispatches().map(identity), [identity(first), identity(first)]);
    assert.equal(await taskRows(fixture), 1);
  }
  {
    // (b) crash: the request is recorded and never answered; the process dies and a new supervisor opens the same guidance file
    const fixture = await makeFixture(sourceTask);
    after(t, fixture.cleanup);
    const held = holdDispatch(fixture);
    const crashed = fixture.makeSupervisor().runOnce(AbortSignal.timeout(5_000)).then(() => "resolved", () => "rejected");
    await within(held.reached, 5_000, "held dispatch");
    await fixture.restart();
    const dispatching = await fixture.supervisorStore.task(mainThreadId);
    assert.ok(dispatching);
    assert.equal(dispatching.status, "dispatching");
    assert.equal(dispatching.messageId, `supervisor-objective:${dispatching.id}`);
    assert.equal(dispatching.replayCount, 0);
    assert.equal(typeof dispatching.dispatchedAt, "number");
    const [first] = fixture.messageDispatches();
    assert.ok(first);
    assert.equal(first.payload.commandId, `supervisor-objective:${dispatching.id}`);

    await within(fixture.makeSupervisor().runOnce(AbortSignal.timeout(5_000)), 5_000, "runOnce after restart");
    const replayed = await fixture.supervisorStore.task(mainThreadId);
    assert.ok(replayed);
    assert.equal(replayed.id, dispatching.id, "no new task identity");
    assert.equal(replayed.replayCount, 1);
    assert.equal(replayed.status, "waiting");
    assert.deepEqual(fixture.messageDispatches().map(identity), [identity(first), identity(first)]);
    assert.equal(fixture.launches().length, 1, "the bound Supervisor is not launched again");
    assert.equal(await taskRows(fixture), 1);
    // the dead process's continuation cannot write to the closed connection; its outcome is irrelevant
    held.release.resolve({accepted: true});
    await within(crashed, 5_000, "crashed runOnce");
    assert.deepEqual(await fixture.supervisorStore.task(mainThreadId), replayed);
  }
});

it("CT-PS-02: a task persisted as dispatching before a crash keeps its identity: a present native result is applied once, an absent one is replayed twice then uncertain", {timeout: 10_000}, async t => {
  const crashWhileDispatching = async () => {
    const fixture = await makeFixture(sourceTask);
    after(t, fixture.cleanup);
    // the request never reaches T3: the rpc is held without a native effect until after the restart
    const held = holdDispatch(fixture);
    const crashed = fixture.makeSupervisor().runOnce(AbortSignal.timeout(5_000)).then(() => "resolved", () => "rejected");
    await within(held.reached, 5_000, "held dispatch");
    await fixture.restart();
    held.release.reject(new SupervisorRpcError("rejected"));
    await within(crashed, 5_000, "crashed runOnce");
    const dispatching = await fixture.supervisorStore.task(mainThreadId);
    assert.ok(dispatching);
    assert.equal(dispatching.status, "dispatching");
    assert.equal(dispatching.replayCount, 0);
    const binding = await fixture.supervisorStore.binding("project-a", mainThreadId);
    assert.ok(binding?.state === "ready");
    assert.equal(fixture.messageDispatches().length, 1);
    return {fixture, dispatching, binding, first: fixture.messageDispatches()[0]!};
  };
  {
    const {fixture, dispatching, binding} = await crashWhileDispatching();
    const root = fixture.projections.get(binding.threadId);
    assert.ok(root);
    addSupervisorRequest(root, {messageId: dispatching.messageId, text: dispatching.requestText});
    completeSupervisorRequest(root, dispatching.messageId, workflowResult(dispatching.sourceMessageId, "Create a migration plan", "The source asks for a plan."));
    const supervisor = fixture.makeSupervisor();
    await within(supervisor.runOnce(AbortSignal.timeout(5_000)), 5_000, "runOnce after restart");
    const applied = await fixture.supervisorStore.task(mainThreadId);
    assert.ok(applied);
    assert.equal(applied.id, dispatching.id);
    assert.equal(applied.status, "inferred");
    assert.equal(applied.objective, "Create a migration plan");
    assert.equal(applied.supervisorRunId, root.runs[0]!.id);
    await within(supervisor.runOnce(AbortSignal.timeout(5_000)), 5_000, "second runOnce");
    const again = await fixture.supervisorStore.task(mainThreadId);
    assert.equal(again?.id, dispatching.id);
    assert.equal(again?.status, "inferred");
    assert.equal(again?.objective, "Create a migration plan");
    assert.equal(interpretationDispatches(fixture, dispatching.id).length, 1, "the identity is never resent once its native result exists");
    assert.equal(await taskRows(fixture), 1);
  }
  {
    const {fixture, dispatching, first} = await crashWhileDispatching();
    fixture.setAcceptedDispatchesWithoutRun(10);
    const supervisor = fixture.makeSupervisor();
    const states: Array<[string, number]> = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      await within(supervisor.runOnce(AbortSignal.timeout(5_000)), 5_000, `runOnce ${cycle}`);
      const task = await fixture.supervisorStore.task(mainThreadId);
      assert.equal(task?.id, dispatching.id);
      states.push([task.status, task.replayCount]);
    }
    assert.deepEqual(states, [["waiting", 1], ["waiting", 2], ["uncertain", 2], ["uncertain", 2]]);
    assert.equal((await fixture.supervisorStore.task(mainThreadId))?.reason, "The accepted request has no matching native run. Retry native access to reconcile its retained identity.");
    assert.deepEqual(fixture.messageDispatches().map(identity), [identity(first), identity(first), identity(first)], "two replays with the original identity");
    assert.equal(await taskRows(fixture), 1);
  }
});

it("CT-PS-03: concurrent runOnce and runOnce with retry for one main launch one Supervisor and dispatch one interpretation", {timeout: 10_000}, async t => {
  {
    const fixture = await makeFixture(sourceTask);
    after(t, fixture.cleanup);
    const supervisor = fixture.makeSupervisor();
    await within(Promise.all([supervisor.runOnce(AbortSignal.timeout(5_000)), supervisor.runOnce(AbortSignal.timeout(5_000))]), 5_000, "concurrent runOnce");
    const task = await fixture.supervisorStore.task(mainThreadId);
    assert.ok(task);
    assert.equal(task.status, "waiting");
    assert.equal(fixture.launches().length, 1);
    assert.deepEqual(fixture.messageDispatches().map(call => call.payload.commandId), [`supervisor-objective:${task.id}`], "only the surviving task identity is sent");
    assert.equal(await taskRows(fixture), 1);
    await within(supervisor.runOnce(AbortSignal.timeout(5_000)), 5_000, "later runOnce");
    assert.equal(fixture.messageDispatches().length, 1);
    assert.equal(fixture.launches().length, 1);
  }
  {
    const fixture = await makeFixture(sourceTask);
    after(t, fixture.cleanup);
    const supervisor = fixture.makeSupervisor();
    // the first interpretation dispatch loses its response, leaving the task uncertain for the concurrent retry
    fixture.setOperateHook((tag, payload) => {
      if (tag !== "orchestration.dispatchCommand" || payload.type !== "message.dispatch") return undefined;
      fixture.setOperateHook(null);
      return Promise.reject(new Error("simulated lost response"));
    });
    await within(supervisor.runOnce(AbortSignal.timeout(5_000)), 5_000, "first runOnce");
    const uncertain = await fixture.supervisorStore.task(mainThreadId);
    const binding = await fixture.supervisorStore.binding("project-a", mainThreadId);
    assert.ok(uncertain && binding);
    assert.equal(uncertain.status, "uncertain");
    const [first] = fixture.messageDispatches();
    assert.ok(first);
    const [, retried] = await within(Promise.all([supervisor.runOnce(AbortSignal.timeout(5_000)),
      supervisor.retry(retryInput("project-a", 0, binding, "retry"), AbortSignal.timeout(5_000))]), 5_000, "runOnce with retry");
    assert.equal(retried.status, "saved");
    const task = await fixture.supervisorStore.task(mainThreadId);
    assert.equal(task?.id, uncertain.id);
    assert.equal(task?.status, "waiting");
    assert.deepEqual(fixture.messageDispatches().map(identity), [identity(first), identity(first)], "one replay with the original identity");
    assert.equal(fixture.launches().length, 1);
  }
});

it("CT-PS-04: concurrent Starts with one operation ID share one record and a different operation ID while pending is denied", {timeout: 10_000}, async t => {
  const f = await makeNoProjectFixture();
  after(t, f.cleanup);
  const args = {callerThreadId: "manual", userMessageId: "request-start", operationId: "same-start"};
  const evidence = {runId: "run-request-start"};
  const signal = AbortSignal.timeout(5_000);
  const [first, second, dashboard, other] = await Promise.all([
    f.supervisor.startSupervision(args, evidence, signal),
    f.supervisor.startSupervision(args, evidence, signal),
    f.supervisor.dashboardStart("manual", "dashboard-start", signal),
    f.supervisor.startSupervision({...args, operationId: "other-start"}, evidence, signal),
  ]);
  assert.equal(first.status, "pending");
  assert.deepEqual(second, first);
  assert.deepEqual(dashboard, {status: "denied", reason: unresolvedStart});
  assert.deepEqual(other, {status: "denied", reason: unresolvedStart});
  const db = f.fixture.guidance.db;
  const starts = await db.prepare("SELECT key,value FROM meta WHERE key LIKE 'supervisor\\_start:%' ESCAPE '\\'").all();
  assert.equal(starts.length, 1, "one start record for the thread");
  const start = await f.fixture.supervisorStore.start("manual");
  assert.equal(start?.operationId, "same-start");
  assert.equal(start?.status, "pending");
  assert.equal(typeof start?.taskId, "string");
  assert.deepEqual(await Effect.runPromise(f.supervisor.startStatus("manual", "same-start")), {threadId: "manual", operationId: "same-start", status: "pending", reason: first.reason});
  for (const operationId of ["dashboard-start", "other-start"])
    assert.deepEqual(await Effect.runPromise(f.supervisor.startStatus("manual", operationId)), {threadId: "manual", operationId, status: "denied", reason: unresolvedStart});
  assert.equal((await db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'supervisor\\_start\\_operation:%' ESCAPE '\\'").get())?.n, 3);
  assert.deepEqual(await f.supervisor.startSupervision(args, evidence, signal), first, "a later replay returns the recorded result");
  assert.equal((await f.fixture.supervisorStore.start("manual"))?.taskId, start?.taskId);
  assert.equal(f.fixture.operations.length, 0, "Start intake makes no native call");

  const ui = await makeNoProjectFixture();
  after(t, ui.cleanup);
  const policyGeneration = (await ui.policy.get()).generation;
  const [left, right] = await Promise.all([ui.supervisor.dashboardStart("manual", "dashboard", signal), ui.supervisor.dashboardStart("manual", "dashboard", signal)]);
  assert.equal(left.status, "active");
  assert.deepEqual(right, left);
  assert.equal((await ui.fixture.guidance.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'supervisor\\_start:%' ESCAPE '\\'").get())?.n, 1);
  assert.equal((await ui.fixture.supervisorStore.start("manual"))?.operationId, "dashboard");
  assert.equal((await ui.fixture.supervisorStore.start("manual"))?.status, "active");
  assert.equal((await ui.policy.get()).generation, policyGeneration, "an Enable of a chat that is not excluded writes no policy");
  assert.equal(ui.fixture.operations.length, 0);
});

it("CT-PS-05: concurrent control() shares one presence and boundary read; when the first caller aborts the joined caller records presence unavailable", {timeout: 10_000}, async t => {
  // shared success: one presence read and one activation snapshot serve both callers
  {
    const f = await makeControlFixture([{threadId: "new-main", projectId: "project-new", turns: []}]);
    after(t, f.cleanup);
    f.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
    let presenceCalls = 0;
    const presenceCalled = deferred();
    const presence = deferred<SupervisionFolderPresence>();
    let nowCalls = 0;
    const secondJoined = deferred();
    // resolveControl reads the clock immediately before it calls detectFolder, which joins the in-flight read synchronously
    const now = () => {nowCalls += 1;if (nowCalls === 2) secondJoined.resolve();return Date.now();};
    const supervisor = f.makeSupervisor({now, definitions: {...f.missingDefinitions, presence: () => {presenceCalls += 1;presenceCalled.resolve();return presence.promise;}}});
    const first = supervisor.control("project-new", AbortSignal.timeout(5_000));
    await presenceCalled.promise;
    const second = supervisor.control("project-new", AbortSignal.timeout(5_000));
    await secondJoined.promise;
    presence.resolve({status: "present"});
    const [left, right] = await Promise.all([first, second]);
    assert.equal(presenceCalls, 1);
    assert.equal(f.baselineReads, 1, "one activation snapshot");
    assert.deepEqual(right, left);
    assert.equal(left.enabled, true);
    assert.equal(left.detectionStatus, "present");
    assert.equal(await f.supervisorStore.autoControlInitialized("project-new"), true);
  }
  // the shared read runs in the first caller: its interruption ends that call without a result and fails the joined caller,
  // which records unavailable in memory only
  {
    const f = await makeControlFixture([{threadId: "new-main", projectId: "project-new", turns: []}]);
    after(t, f.cleanup);
    f.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
    let presenceCalls = 0;
    const presenceCalled = deferred();
    let nowCalls = 0;
    const secondJoined = deferred();
    const now = () => {nowCalls += 1;if (nowCalls === 2) secondJoined.resolve();return Date.now();};
    const supervisor = f.makeSupervisor({now, definitions: {...f.missingDefinitions, presence: (_projectId: string, signal: AbortSignal) => {
      presenceCalls += 1;
      presenceCalled.resolve();
      return new Promise<SupervisionFolderPresence>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
    }}});
    const firstCaller = new AbortController();
    const first = supervisor.control("project-new", firstCaller.signal);
    await presenceCalled.promise;
    const second = supervisor.control("project-new", AbortSignal.timeout(5_000));
    await secondJoined.promise;
    firstCaller.abort();
    const [left, right] = await Promise.allSettled([first, second]);
    assert.equal(left.status, "rejected", "the interrupted first caller ends without a control read");
    assert.equal(right.status, "fulfilled");
    assert.equal(right.value.detectionStatus, "unavailable");
    assert.equal(right.value.detectionError, "The project .t3-supervisor folder could not be checked.");
    assert.equal(right.value.enabled, false);
    assert.equal(presenceCalls, 1, "the second caller joined the first caller's read");
    assert.equal(f.baselineReads, 0);
    assert.equal((await f.supervisorStore.control("project-new")).detectionStatus, "unavailable");
    assert.equal(await f.supervisorStore.folderPresenceNeedsBoundary("project-new"), false, "the unavailable outcome is not persisted");
    assert.equal(await f.supervisorStore.autoControlInitialized("project-new"), false);
    assert.equal((await f.guidance.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'supervisor\\_control\\_%' ESCAPE '\\' AND key LIKE '%project-new%'").get())?.n, 0);
  }
});

it("CT-PS-07: a failing policy save rejects the dashboard Start without an Enable; a failing guidance commit keeps only the policy change and a pending Start", {timeout: 10_000}, async t => {
  const signal = AbortSignal.timeout(5_000);
  // clause 1: writeChatPolicy swallows the save error, activateStart returns false before any guidance write and the Start is rejected
  {
    let tick = Date.now();
    const f = await makeNoProjectFixture(() => ++tick);
    after(t, f.cleanup);
    const stopped = await f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: (await f.policy.get()).generation, enabled: false}, signal);
    assert.equal(stopped.status, "saved");
    const stop = await f.fixture.supervisorStore.chatStop("manual");
    assert.ok(stop);
    const policyBefore = await f.policy.get();
    assert.deepEqual(policyBefore.excludedThreadIds, ["manual"]);
    f.policy.failSaves = true;
    const enabled = await f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: policyBefore.generation, enabled: true}, signal);
    assert.equal(enabled.status, "unavailable");
    assert.equal(enabled.message, "Start was not activated.");
    assert.equal(f.policy.failedSaves, 3, "the policy write is attempted three times");
    const start = await f.fixture.supervisorStore.start("manual");
    assert.equal(start?.status, "rejected");
    assert.equal(start?.reason, "Start could not be committed.");
    assert.ok(start);
    assert.deepEqual(await Effect.runPromise(f.supervisor.startStatus("manual", start.operationId)), {threadId: "manual", operationId: start.operationId, status: "rejected", reason: "Start could not be committed."});
    assert.equal(await f.fixture.supervisorStore.chatEnabledAt("manual"), null, "no chat Enable is recorded");
    assert.deepEqual(await f.fixture.supervisorStore.chatStop("manual"), stop, "the Stop record is kept");
    assert.deepEqual(await f.policy.get(), policyBefore, "the policy is unchanged");
    assert.equal(await f.supervisor.scopeEnabled("project-a", "manual"), false);
    assert.equal(enabled.snapshot?.chatSupervision?.stopped, true);
    assert.equal(enabled.snapshot?.chatSupervision?.activation, "rejected");
    assert.equal(f.fixture.operations.length, 0);
  }
  // clause 2: the policy commit precedes the guidance transaction, so a guidance failure leaves only the policy change
  {
    let tick = Date.now();
    const f = await makeNoProjectFixture(() => ++tick);
    after(t, f.cleanup);
    await f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: (await f.policy.get()).generation, enabled: false}, signal);
    const stop = await f.fixture.supervisorStore.chatStop("manual");
    assert.ok(stop);
    const policyBefore = await f.policy.get();
    const db = f.fixture.guidance.db;
    await db.exec(`CREATE TEMP TRIGGER c2_fail_start_activation BEFORE UPDATE ON meta
      WHEN NEW.key = 'supervisor_start:manual' AND json_extract(NEW.value, '$.status') = 'active'
      BEGIN SELECT RAISE(ABORT, 'simulated guidance failure during Start activation'); END`);
    const result = await f.supervisor.dashboardStart("manual", "enable-after-stop", signal);
    assert.deepEqual(result, {status: "unavailable", reason: "Start preparation failed before activation. Use a new explicit request after inspecting this outcome."});
    assert.equal(db.isTransaction, false, "the guidance transaction rolled back");
    const policy = await f.policy.get();
    assert.equal(policy.generation, policyBefore.generation + 1, "the policy commit persists");
    assert.deepEqual(policy.excludedThreadIds, []);
    assert.equal(await f.fixture.supervisorStore.chatEnabledAt("manual"), null, "the chat Enable rolled back");
    assert.deepEqual(await f.fixture.supervisorStore.chatStop("manual"), stop, "the unbound Stop removal rolled back");
    const start = await f.fixture.supervisorStore.start("manual");
    assert.equal(start?.status, "pending", "the Start stays pending");
    assert.equal(start?.operationId, "enable-after-stop");
    assert.deepEqual(await Effect.runPromise(f.supervisor.startStatus("manual", "enable-after-stop")), {threadId: "manual", operationId: "enable-after-stop", status: "pending",
      reason: "Waiting for the Supervisor's first source-bound Start interpretation."});
    assert.equal(await f.supervisor.scopeEnabled("project-a", "manual"), false, "the Start is not active");
    assert.equal(f.fixture.operations.length, 0);
  }
});

it("CT-PS-08: snapshot, overview, candidates and scopeSnapshot with ready bindings and pending tasks make no operate call and no write", {timeout: 10_000}, async t => {
  const f = await makeControlFixture([
    {threadId: "main-one", projectId: "project-a", turns: [{id: "task-one", sequence: 11, text: "Build the invoice export"}]},
    {threadId: "main-two", projectId: "project-a", turns: [{id: "task-two", sequence: 12, text: "Prepare the release note"}]},
  ]);
  after(t, f.cleanup);
  const supervisor = f.makeSupervisor();
  await supervisor.runOnce(AbortSignal.timeout(5_000));
  const bindings = await f.supervisorStore.bindings();
  assert.equal(bindings.length, 2);
  assert.ok(bindings.every(binding => binding.state === "ready"));
  assert.deepEqual(await Promise.all(["main-one", "main-two"].map(async id => (await f.supervisorStore.task(id))?.status)), ["waiting", "waiting"]);
  const before = await supervisionStateDigest(f.guidance.db);
  assert.ok(before.tables.includes("supervisor_main_bindings") && before.tables.includes("supervisor_task_interpretations"));
  const operations = f.operations.length;
  const signal = AbortSignal.timeout(5_000);

  const snapshot = await supervisor.snapshot("project-a", signal, "main-one");
  assert.equal(snapshot.binding?.state, "ready");
  assert.equal(snapshot.tasks[0]?.status, "waiting");
  await supervisor.snapshot("project-a", signal);
  const overview = await supervisor.overview({offset: 0, limit: 100});
  assert.equal(overview.total, 2);
  await supervisor.candidates();
  await supervisor.candidates("", "exclude");
  const scope = await supervisor.scopeSnapshot("project-a", "main-one", signal);
  assert.equal(scope.supervisorThreadId, (await f.supervisorStore.binding("project-a", "main-one"))?.threadId);

  assert.equal(f.operations.length, operations, "no operate RPC call");
  assert.deepEqual(await supervisionStateDigest(f.guidance.db), before, "every supervisor_* table and meta row is unchanged");
});

it("CT-PS-09: a Stop saved while the final models() read is awaited leaves the task queued with its prior reason and sends no interpretation", {timeout: 10_000}, async t => {
  const fixture = await makeFixture(sourceTask, {threadPolicy: true});
  after(t, fixture.cleanup);
  const policy = fixture.threadPolicy;
  assert.ok(policy);
  const supervisor = fixture.makeSupervisor();
  let reasonAtStop: string | null = null;
  // the Stop lands while the last read before dispatch is awaited: discovery has no task yet, the final read sees it queued
  // the hook's reads and the Stop run synchronously, before the read answers, as the baseline hook's did
  fixture.setReadHook(() => {
    const queued = Effect.runSync(serviceOf(fixture.supervisorStore).task(mainThreadId));
    if (queued?.status === "queued" && reasonAtStop === null) {
      reasonAtStop = queued.reason;
      Effect.runSync(Effect.flatMap(serviceOf(policy).get(), (current) => supervisor.saveThreadPolicy({...current, excludedThreadIds: [mainThreadId]})));
    }
  });
  await within(supervisor.runOnce(AbortSignal.timeout(5_000)), 5_000, "runOnce");
  assert.equal(reasonAtStop, "Waiting for the project Supervisor.", "the Stop was saved during the final models() read");
  assert.equal(await supervisor.supervisionStopped(mainThreadId), true);
  const task = await fixture.supervisorStore.task(mainThreadId);
  assert.ok(task);
  assert.equal(task.status, "queued");
  assert.equal(task.reason, reasonAtStop, "the prior reason is kept");
  assert.equal(task.dispatchedAt, null);
  assert.equal(interpretationDispatches(fixture, task.id).length, 0);
  assert.equal(fixture.messageDispatches().length, 0);
  assert.equal((await fixture.supervisorStore.binding("project-a", mainThreadId))?.supervisionStop?.route, "ui");
});

it("CT-PS-10: control re-checks presence after 30 s, or 60 s once unavailable, on the constructor clock", {timeout: 10_000}, async t => {
  const f = await makeControlFixture([{threadId: "new-main", projectId: "project-new", turns: []}]);
  after(t, f.cleanup);
  f.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
  let clock = 10_000;
  let presenceCalls = 0;
  const supervisor = f.makeSupervisor({now: () => clock, definitions: {...f.missingDefinitions,
    presence: async () => {presenceCalls += 1;return {status: "unavailable" as const, message: "The folder could not be read."};}}});
  const control = () => supervisor.control("project-new", AbortSignal.timeout(5_000));
  // never checked: the elapsed time is measured from 0, so the 30 s delay applies to the constructor clock itself
  assert.equal((await control()).detectionStatus, "not_checked");
  clock = 29_999;
  await control();
  assert.equal(presenceCalls, 0);
  clock = 30_000;
  const wallBefore = Date.now();
  const checked = await control();
  assert.equal(presenceCalls, 1);
  assert.equal(checked.detectionStatus, "unavailable");
  assert.equal(checked.detectionError, "The folder could not be read.");
  // the persisted unavailability is stamped by Date.now, not by the constructor clock
  const stamp = JSON.parse(String((await f.guidance.db.prepare("SELECT value FROM meta WHERE key=?").get(`supervisor_control_presence_unavailable:${JSON.stringify("project-new")}`))?.value)) as {checkedAt: number};
  assert.ok(stamp.checkedAt >= wallBefore);
  clock = 30_000 + 59_999;
  await control();
  assert.equal(presenceCalls, 1, "an unavailable result waits 60 s");
  clock = 30_000 + 60_000;
  await control();
  assert.equal(presenceCalls, 2);
});

it("CT-PS-10: a running interpretation becomes unavailable only after more than 300 s of the supervisor clock, which also stamps dispatchedAt and updatedAt", {timeout: 10_000}, async t => {
  const f = await makeControlFixture([{threadId: "source-thread", projectId: "project-a", turns: [{id: "first-task", sequence: 11, text: "Review the release"}]}]);
  after(t, f.cleanup);
  let wall = Date.now();
  // the wall clock stands an hour ahead of the supervisor clock, which alone stamps and times the interpretation
  mockMethod(t, Date, "now", () => wall + 3_600_000);
  const supervisor = f.makeSupervisor({now: () => wall});
  await supervisor.runOnce(AbortSignal.timeout(5_000));
  const task = await f.supervisorStore.task("source-thread");
  assert.ok(task);
  assert.equal(task.status, "waiting");
  assert.equal(task.dispatchedAt, wall, "dispatchedAt is the supervisor clock");
  assert.equal(task.updatedAt, wall, "updatedAt is the supervisor clock");
  const binding = await f.supervisorStore.binding("project-a", "source-thread");
  assert.ok(binding);
  const run = f.projections.get(binding.threadId)?.runs.find(candidate => candidate.userMessageId === task.messageId);
  assert.ok(run);
  assert.equal(run.status, "running");
  run.startedAt = new Date(wall).toISOString();
  const started = wall;

  wall = started + 300_000;
  await supervisor.runOnce(AbortSignal.timeout(5_000));
  assert.equal((await f.supervisorStore.task("source-thread"))?.status, "waiting", "exactly 300 s is not yet a timeout");
  wall = started + 300_001;
  await supervisor.runOnce(AbortSignal.timeout(5_000));
  const timedOut = await f.supervisorStore.task("source-thread");
  assert.equal(timedOut?.status, "unavailable");
  assert.equal(timedOut?.reason, "The interpretation timed out or requires input. The service does not answer or interrupt Supervisor runs.");
  assert.equal(timedOut?.updatedAt, started + 300_001);
  assert.equal(f.operations.filter(call => call.payload.type === "message.dispatch").length, 1);
  assert.equal(f.operations.some(call => ["thread.interrupt", "runtime-request.respond", "runtime-request.interrupt"].includes(String(call.payload.type))), false);
});

it("CT-PS-11: aborting runOnce during a hung Supervisor projection releases the scope lock for a later runOnce and retry", {timeout: 10_000}, async t => {
  const fixture = await makeFixture(sourceTask);
  after(t, fixture.cleanup);
  const binding = await reserveReadyBinding(fixture);
  const supervisor = fixture.makeSupervisor();
  const hung = deferred();
  let hangs = 0;
  // the Supervisor projection hangs once a task is queued, which is the in-scope read of the batch (discovery reads it before saving the task)
  // the store read is synchronous, on the projection read's turn, as the baseline hook's was
  fixture.setProjectionHook(threadId => {
    if (threadId !== binding.threadId || Effect.runSync(serviceOf(fixture.supervisorStore).task(mainThreadId))?.status !== "queued") return undefined;
    hangs += 1;
    hung.resolve();
    return Effect.never;
  });
  const controller = new AbortController();
  const aborted = supervisor.runOnce(controller.signal).then(() => "resolved", () => "rejected");
  await within(hung.promise, 5_000, "hung projection");
  const queues = (supervisor as unknown as {queues: Map<string, Promise<unknown>>}).queues;
  assert.equal(queues.size, 1, "the hung read holds its scope queue");
  controller.abort();
  assert.equal(await within(aborted, 5_000, "aborted runOnce"), "resolved");
  assert.equal(hangs, 1);
  fixture.setProjectionHook(null);
  assert.equal(queues.size, 0, "no scope queue is held after the abort");
  const queued = await fixture.supervisorStore.task(mainThreadId);
  assert.equal(queued?.status, "queued");
  assert.equal(fixture.messageDispatches().length, 0);

  await within(supervisor.runOnce(AbortSignal.timeout(5_000)), 5_000, "later runOnce");
  assert.equal((await fixture.supervisorStore.task(mainThreadId))?.status, "waiting");
  assert.equal(fixture.messageDispatches().length, 1);
  const retried = await within(supervisor.retry(retryInput("project-a", 0, binding, "retry"), AbortSignal.timeout(5_000)), 5_000, "later retry");
  assert.equal(retried.status, "saved");
  assert.equal(queues.size, 0);
});

it("CT-PSS-01: a Start operation left preparing by a crash is rejected on reopen and startStatus reports it without native work", { timeout: 10_000 }, async (t) => {
  const fixture = await pssFixture(t, "c2-pss-01-");
  const first = await fixture.open();
  await first.store.saveStartOperation({threadId: "main-a", operationId: "op-pending", requestHash: "hash-pending", status: "pending", reason: "Waiting."});
  await first.store.saveStartOperation({threadId: "main-a", operationId: "op-settled", requestHash: "hash-settled", status: "denied", reason: "Denied.", preparing: false});
  await first.store.saveStart({threadId: "main-b", projectId: "project-b", operationId: "op-active", requestHash: "hash-active", route: "ui", status: "active",
    reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.", intentAt: 100, modeGeneration: 0, masterGeneration: 0, taskId: null});
  // the real intake path writes its preparing receipt, then the process dies while the catalog read is outstanding
  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>(resolve => {releaseCatalog = resolve;});
  const config: SupervisorConfig = {dataDirectory: fixture.directory, t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0};
  const crashing = projectSupervisorUnit(config, first.store,
    {catalog: () => Effect.promise(() => catalogGate.then(() => ({projects: [], threads: []})))},
    {projection: () => {throw new Error("unused");}}, {} as SupervisorRpc, {} as SupervisorRpc, async () => {throw new Error("unused");});
  const crashed = crashing.dashboardStart("main-a", "op-crash", new AbortController().signal);
  const deadline = Date.now() + 5_000;
  while (!await first.store.startOperation("main-a", "op-crash")) {
    if (Date.now() > deadline) assert.fail("the intake receipt was not written");
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal((await first.store.startOperation("main-a", "op-crash"))?.preparing, true);
  const untouched = (await metaRows(first.guidance.db)).filter(([key]) => key !== `supervisor_start_operation:${JSON.stringify(["main-a", "op-crash"])}`);
  await first.guidance.close();
  releaseCatalog();
  await assert.rejects(crashed, /guidance store sql failed/u);

  const native: string[] = [];
  const counted = (name: string) => () => {native.push(name);throw new Error(`${name} must not be called`);};
  const second = await fixture.open();
  assert.deepEqual((await metaRows(second.guidance.db)).find(([key]) => key === 'supervisor_start_operation:["main-a","op-crash"]'), [
    'supervisor_start_operation:["main-a","op-crash"]',
    JSON.stringify({threadId: "main-a", operationId: "op-crash", requestHash: (await second.store.startOperation("main-a", "op-crash"))!.requestHash,
      status: "rejected", reason: interruptedStartReason, preparing: false}),
  ]);
  assert.deepEqual((await metaRows(second.guidance.db)).filter(([key]) => key !== 'supervisor_start_operation:["main-a","op-crash"]'), untouched, "other Start rows are unchanged");
  const rpc = new Proxy({}, {get: (_target, key) => counted(`rpc.${String(key)}`)}) as SupervisorRpc;
  const supervisor = projectSupervisorUnit(config, second.store, {catalog: counted("catalog") as never}, {projection: counted("projection") as never},
    rpc, rpc, async () => counted("activationSnapshot")());
  assert.deepEqual(await Effect.runPromise(supervisor.startStatus("main-a", "op-crash")), {threadId: "main-a", operationId: "op-crash", status: "rejected", reason: interruptedStartReason});
  assert.deepEqual(await Effect.runPromise(supervisor.startStatus("main-a", "op-pending")), {threadId: "main-a", operationId: "op-pending", status: "pending", reason: "Waiting."});
  assert.equal((await Effect.runPromise(supervisor.startStatus("main-b", "op-active"))).status, "active");
  assert.deepEqual(await supervisor.dashboardStart("main-a", "op-crash", new AbortController().signal), {status: "rejected", reason: interruptedStartReason},
    "replaying the interrupted operation returns its rejection");
  assert.equal(await second.store.start("main-a"), null, "no Start record was activated");
  assert.equal((await second.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_chat_enables").get())?.n, 0);
  assert.deepEqual(native, [], "no catalog, projection, rpc or activation call");
});

it("CT-PSS-03: a stale binding copy keeps the stored stop and notice, and the notice CAS honours the expected messageId", { timeout: 10_000 }, async (t) => {
  const fixture = await pssFixture(t, "c2-pss-03-");
  const {guidance, store} = await fixture.open();
  const binding = await store.reserve("project-a", "main-a", "Main", defaultSupervisorModel, 1, 100);
  const stale = (await store.binding("project-a", "main-a"))!;
  await store.setBinding({...stale, manualKeepActive: true, stopObservedAt: 150});
  const stop: NonNullable<BindingRecord["supervisionStop"]> = {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: 200};
  await store.setSupervisionStop(binding, stop);
  const stopped = (await store.binding("project-a", "main-a"))!;
  assert.deepEqual(stopped.supervisionStop, stop);
  assert.equal("manualKeepActive" in stopped || "stopObservedAt" in stopped, false, "a Stop clears keep-active and the observed stop marker");

  const notice = await Effect.runPromise(prepareStopNotice(Context.get(storeUnitOf(store).context, SupervisorIds), binding, 200, null));
  await store.setStopNotice(binding, null, notice);
  assert.deepEqual((await store.binding("project-a", "main-a"))!.stopNotice, notice, "expected null on an absent notice succeeds");
  assert.equal((await store.binding("project-a", "main-a"))!.stopNotice!.enabledAt, null);

  await store.setBinding({...stale, state: "ready", title: "Supervisor · Renamed"});
  const merged = (await store.binding("project-a", "main-a"))!;
  assert.equal(merged.state, "ready");
  assert.equal(merged.title, "Supervisor · Renamed");
  assert.deepEqual(merged.supervisionStop, stop, "the stale copy without a stop keeps the stored stop");
  assert.deepEqual(merged.stopNotice, notice, "the stale copy without a notice keeps the stored notice");
  await store.setBinding({...stale, supervisionStop: {...stop, stoppedAt: 1}, stopNotice: {...notice, messageId: "supervisor-notice:stop:other", state: "sent"}});
  assert.deepEqual((await store.binding("project-a", "main-a"))!.supervisionStop, stop, "a stale copy cannot replace the stored stop");
  assert.deepEqual((await store.binding("project-a", "main-a"))!.stopNotice, notice, "a stale copy cannot replace the stored notice");

  const document = async () => String((await guidance.db.prepare("SELECT document FROM supervisor_main_bindings WHERE main_thread_id='main-a'").get())?.document);
  const beforeWrongCas = await document();
  await store.setStopNotice(binding, "supervisor-notice:stop:wrong", {...notice, state: "sent"});
  assert.equal(await document(), beforeWrongCas, "a wrong expected messageId is a no-op");
  await store.setStopNotice(binding, null, {...notice, messageId: "supervisor-notice:stop:replacement"});
  assert.equal(await document(), beforeWrongCas, "expected null on a present notice is a no-op");
  await store.setStopNotice(binding, notice.messageId, {...notice, state: "accepted"});
  assert.deepEqual((await store.binding("project-a", "main-a"))!.stopNotice, {...notice, state: "accepted"}, "the matching expected messageId replaces the notice");

  await store.setSupervisionStop(binding, null);
  await store.setBinding({...stale, supervisionStop: stop});
  assert.equal("supervisionStop" in (await store.binding("project-a", "main-a"))!, false, "a stale copy cannot restore a cleared stop");
});

it("CT-PSS-04: a stale global definitions generation changes nothing; a success stales inferred tasks and clears queued context in one commit", { timeout: 10_000 }, async (t) => {
  const fixture = await pssFixture(t, "c2-pss-04-");
  const {guidance, store} = await fixture.open();
  const binding = await store.reserve("project-a", "main-inferred", "Main", defaultSupervisorModel, 1, 100);
  await store.saveTask(inferredTask(binding.threadId));
  await store.saveTask(queuedTask("main-queued", binding.threadId, null));
  await store.saveTask(queuedTask("main-dispatched", binding.threadId, 120));
  const tasksBefore = await tableRows(guidance.db, "supervisor_task_interpretations");
  const controlKeys = async () => (await metaRows(guidance.db)).filter(([key]) => key.startsWith("supervisor_global_definitions_"));

  await assert.rejects(async () => await store.saveGlobalDefinitionsControl(3, true, "~/.t3-supervisor", "global-1"), /global_definitions_control_conflict/u);
  assert.deepEqual(await tableRows(guidance.db, "supervisor_task_interpretations"), tasksBefore, "a stale generation leaves tasks untouched");
  assert.deepEqual(await controlKeys(), []);

  // a failure on the second task update rolls back the first task update and the control rows of the same commit
  const updated: string[] = [];
  guidance.db.function("c2_task_updated", (threadId: unknown) => {updated.push(String(threadId));return null;});
  await guidance.db.exec(`CREATE TEMP TRIGGER c2_fail_queued BEFORE UPDATE ON main.supervisor_task_interpretations BEGIN
    SELECT c2_task_updated(NEW.thread_id);
    SELECT RAISE(ABORT, 'c2_task_update_failed') WHERE NEW.thread_id='main-queued'; END`);
  await assert.rejects(async () => await store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-1"), /supervision_store_unavailable/u);
  assert.deepEqual(updated, ["main-inferred", "main-queued"], "the inferred task was rewritten before the failing update");
  assert.equal(guidance.db.isTransaction, false);
  assert.deepEqual(await tableRows(guidance.db, "supervisor_task_interpretations"), tasksBefore, "the earlier task update rolled back");
  assert.deepEqual(await controlKeys(), [], "the control and event rows rolled back");
  assert.equal((await store.globalDefinitionsControl()).generation, 0);
  await guidance.db.exec("DROP TRIGGER temp.c2_fail_queued");

  // a second connection observing at every task update sees none of the commit until it completes
  const reader = fixture.track(new DatabaseSync(fixture.path, {readOnly: true}));
  const observed: unknown[] = [];
  guidance.db.function("c2_observe", () => {
    observed.push({control: reader.prepare("SELECT value FROM meta WHERE key='supervisor_global_definitions_control'").get()?.value ?? null,
      tasks: readerRows(reader, "supervisor_task_interpretations")});
    return null;
  });
  await guidance.db.exec(`CREATE TEMP TRIGGER c2_observe_update AFTER UPDATE ON main.supervisor_task_interpretations BEGIN SELECT c2_observe(); END`);
  const changedAt = 1_790_000_000_000;
  mockMethod(t, Date, "now", () => changedAt);
  const control = await store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-1");
  await guidance.db.exec("DROP TRIGGER temp.c2_observe_update");
  assert.equal(control.generation, 1);
  assert.equal(control.enabled, true);
  assert.equal(observed.length, 2);
  for (const view of observed) assert.deepEqual(view, {control: null, tasks: tasksBefore}, "an outside reader sees no partial commit");
  assert.deepEqual(await controlKeys(), [
    ["supervisor_global_definitions_control", JSON.stringify({generation: 1, enabled: true, manual: true})],
    ["supervisor_global_definitions_event", JSON.stringify({generation: 1, enabled: true, changedAt, globalFingerprint: "global-1"})],
  ]);
  const inferred = (await store.task("main-inferred"))!;
  const staleMessage = "The user changed whether global definitions are included. The old plan and agreement are retained as stale history.";
  assert.deepEqual(inferred.workflow, {...inferredTask(binding.threadId).workflow!, status: "stale", message: staleMessage});
  assert.deepEqual(inferred.agreement, {...inferredTask(binding.threadId).agreement!, status: "stale", message: staleMessage});
  assert.deepEqual(inferred.definitionReview, {status: "checking", message: staleMessage, expectedRevision: "definitions-1", observedRevision: null,
    supervisorMessageId: null, userMessageIds: [], updatedAt: changedAt});
  assert.equal(inferred.updatedAt, changedAt);
  const queued = (await store.task("main-queued"))!;
  assert.equal(queued.status, "queued");
  assert.equal(queued.requestText, "");
  assert.equal(queued.reason, "Global definition inclusion changed; definitions will be refreshed before dispatch.");
  assert.equal(queued.workflow?.status, "pending");
  for (const key of ["definitionContext", "definitionSnapshot", "definitionReadAttempts", "revalidationAttempts"]) assert.equal(key in queued, false, `${key} is cleared`);
  assert.deepEqual(await store.task("main-dispatched"), queuedTask("main-dispatched", binding.threadId, 120), "a dispatched queued task keeps its context");
  assert.deepEqual(readerRows(reader, "supervisor_task_interpretations"), await tableRows(guidance.db, "supervisor_task_interpretations"), "the reader sees the whole commit afterwards");
});

it("CT-PSS-05: ownership preload creates nothing for absent state, tolerates a table-less file and reads committed IDs beside a live WAL writer", { timeout: 10_000 }, async (t) => {
  // target: the preload is the project store layer's own read when a run opens its stores (cc-ownership); the separate
  // read-only preload of an absent directory or under another connection's open write transaction is gone with it
  const fixture = await pssFixture(t, "c2-pss-05-");
  const bare = join(fixture.directory, "bare");
  mkdirSync(bare);
  const legacy = new DatabaseSync(join(bare, "guidance.sqlite3"));
  legacy.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  legacy.close();
  const bareOwned = new Set<string>();
  await openSupervisors(fixture.track(await openGuidance(bare)), bareOwned);
  assert.deepEqual(bareOwned, new Set(), "a file without supervisor_owned_threads yields no IDs");

  const {store} = await fixture.open();
  const first = await store.reserve("project-a", "main-a", "Main A", defaultSupervisorModel, 1, 100);
  const second = await store.reserve("project-a", "main-b", "Main B", defaultSupervisorModel, 1, 100);
  assert.equal(existsSync(`${fixture.path}-wal`), true, "the writer holds the WAL");
  const owned = new Set<string>();
  await openSupervisors(fixture.track(await openGuidance(fixture.directory)), owned);
  assert.deepEqual(owned, new Set([first.threadId, second.threadId]));
});

it("CT-PSS-06: the supervision DDL and every meta key format are golden and read back unchanged after reopen", { timeout: 10_000 }, async (t) => {
  const fixture = await pssFixture(t, "c2-pss-06-");
  const writer = await fixture.open();
  const fixed = mockMethod(t, Date, "now", () => 1_790_000_000_000);
  await writer.store.baseline(pssBoundary);
  await writer.store.saveControl(null, 0, true, pssBoundary);
  await writer.store.saveControl("project-a", 0, true, pssBoundary);
  await writer.store.recordFolderPresence("project-b", {status: "unavailable", message: "denied"});
  await writer.store.recordFolderPresence("project-c", {status: "present"}, pssBoundary);
  await writer.store.saveNoProjectControl(0, "automatic", pssBoundary);
  await writer.store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-fingerprint");
  await writer.store.saveStart({threadId: "main-a", projectId: "project-a", operationId: "op-1", requestHash: "hash-1", route: "ui", status: "active",
    reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.", intentAt: 1_790_000_000_000, modeGeneration: 1, masterGeneration: 1, taskId: null});
  await writer.store.saveUnboundStop("main-b", {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: 1_790_000_000_000});
  fixed.mockRestore();
  assert.deepEqual(await metaRows(writer.guidance.db), pssMetaGolden);
  assert.deepEqual(await pssDdl(writer.guidance.db), pssDdlGolden);
  await writer.guidance.close();

  const {guidance, store} = await fixture.open();
  assert.deepEqual(await metaRows(guidance.db), pssMetaGolden, "opening rewrites no meta row");
  assert.deepEqual(await pssDdl(guidance.db), pssDdlGolden);
  assert.equal(store.scopeCompatible, true);
  assert.deepEqual(await store.control(null), {projectId: null, generation: 1, enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true,
    detectionStatus: "not_checked", detectionError: null});
  assert.deepEqual(await store.control("project-a"), {projectId: "project-a", generation: 1, enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true,
    detectionStatus: "not_checked", detectionError: null});
  assert.deepEqual(await store.projectBoundary("project-a"), pssBoundary);
  assert.equal(await store.folderPresenceNeedsBoundary("project-b"), true);
  assert.deepEqual(await store.control("project-b"), {projectId: "project-b", generation: 0, enabled: false, manual: false, globallyEnabled: true, effectiveEnabled: false,
    detectionStatus: "not_checked", detectionError: null});
  assert.equal(await store.autoControlInitialized("project-c"), true);
  assert.deepEqual(await store.control("project-c"), {projectId: "project-c", generation: 0, enabled: true, manual: false, globallyEnabled: true, effectiveEnabled: true,
    detectionStatus: "present", detectionError: null});
  assert.deepEqual(await store.noProjectControl(), {generation: 1, mode: "automatic", baseline: pssBoundary, globallyEnabled: true});
  assert.deepEqual(await store.globalDefinitionsControl(), {generation: 1, enabled: true, manual: true, effectiveEnabled: true, homePath: "~/.t3-supervisor",
    detectionStatus: "not_checked", detectionError: null});
  assert.equal(await store.hasGlobalDefinitionsEvent(), true);
  assert.deepEqual(await store.baseline(), {...pssBoundary, version: 2});
  assert.equal(await store.activation(), 7);
  assert.deepEqual(await store.start("main-a"), JSON.parse(pssMetaGolden.find(([key]) => key === "supervisor_start:main-a")![1]));
  assert.deepEqual(await store.startOperation("main-a", "op-1"), {threadId: "main-a", operationId: "op-1", requestHash: "hash-1", status: "active",
    reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor."});
  assert.deepEqual(await store.chatStop("main-b"), {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: 1_790_000_000_000});
  assert.deepEqual(await metaRows(guidance.db), pssMetaGolden, "reads write nothing");
});

it("CT-PSS-07: a legacy definition-save table gains expected_revision with an empty default exactly once and keeps its rows", { timeout: 10_000 }, async (t) => {
  const fixture = await pssFixture(t, "c2-pss-07-");
  // the legacy file is written by the guidance store alone, before the supervision store added the column
  const legacy = fixture.track(await openGuidance(fixture.directory));
  await legacy.db.exec(`CREATE TABLE supervisor_definition_user_saves(project_id TEXT NOT NULL,workspace_root TEXT NOT NULL,signature TEXT NOT NULL,saved_at INTEGER NOT NULL,PRIMARY KEY(project_id,workspace_root));
    INSERT INTO supervisor_definition_user_saves VALUES('project-a','/work/a','signature-a',100);
    INSERT INTO meta VALUES('supervisor_scope_version','main-v1');`);
  await legacy.close();
  const alters = (spy: {mock: {calls: unknown[][]}}) => spy.mock.calls.filter(([sql]) => String(sql).includes("ALTER TABLE supervisor_definition_user_saves")).length;
  const columns = async (db: DbFacade) => (await db.prepare("PRAGMA table_info(supervisor_definition_user_saves)").all()).map(row => ({...row}));
  const expectedRow = {project_id: "project-a", workspace_root: "/work/a", signature: "signature-a", saved_at: 100, expected_revision: ""};

  let firstSpy!: {mock: {calls: unknown[][]}};
  const first = await fixture.open(guidance => {firstSpy = mockMethod(t, guidance.db.connection, "prepare");});
  assert.equal(alters(firstSpy), 1);
  const migratedColumns = await columns(first.guidance.db);
  assert.deepEqual(migratedColumns.filter(column => column.name === "expected_revision"),
    [{cid: 4, name: "expected_revision", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0}]);
  assert.deepEqual(await tableRows(first.guidance.db, "supervisor_definition_user_saves"), [expectedRow]);
  const migratedSql = (await first.guidance.db.prepare("SELECT sql FROM sqlite_master WHERE name='supervisor_definition_user_saves'").get())?.sql;
  await first.guidance.close();

  let secondSpy!: {mock: {calls: unknown[][]}};
  const second = await fixture.open(guidance => {secondSpy = mockMethod(t, guidance.db.connection, "prepare");});
  assert.equal(alters(secondSpy), 0, "a migrated table is not altered again");
  assert.deepEqual(await columns(second.guidance.db), migratedColumns);
  assert.equal((await second.guidance.db.prepare("SELECT sql FROM sqlite_master WHERE name='supervisor_definition_user_saves'").get())?.sql, migratedSql);
  assert.deepEqual(await tableRows(second.guidance.db, "supervisor_definition_user_saves"), [expectedRow]);
});

it("CT-PSS-08: a start record never exists without its operation receipt and reservation transfers an unbound stop atomically", { timeout: 10_000 }, async (t) => {
  const fixture = await pssFixture(t, "c2-pss-08-");
  const {guidance, store, ownedIds} = await fixture.open();
  const reader = fixture.track(new DatabaseSync(fixture.path, {readOnly: true}));
  const readMeta = (key: string) => reader.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ?? null;
  const start = {threadId: "main-a", projectId: "project-a", operationId: "op-1", requestHash: "hash-1", route: "agent" as const, status: "pending" as const,
    reason: "Waiting for the Supervisor's first source-bound Start interpretation.", intentAt: 100, modeGeneration: 0, masterGeneration: 0, taskId: "task-1"};
  const recordKey = "supervisor_start:main-a";
  const receiptKey = 'supervisor_start_operation:["main-a","op-1"]';

  // target (s6d step 1, CT-PSS-08): saveStart is one transaction, so the receipt and the record commit together
  const views: unknown[] = [];
  guidance.db.function("c2_start_view", () => {views.push({receipt: readMeta(receiptKey) !== null, record: readMeta(recordKey) !== null});return null;});
  await guidance.db.exec(`CREATE TEMP TRIGGER c2_fail_record BEFORE INSERT ON main.meta WHEN NEW.key GLOB 'supervisor_start:*' BEGIN
    SELECT c2_start_view(); SELECT RAISE(ABORT, 'c2_record_failed'); END`);
  assert.equal(guidance.db.isTransaction, false);
  await assert.rejects(async () => await store.saveStart(start), /supervision_store_unavailable/u);
  assert.deepEqual(views, [{receipt: false, record: false}], "the receipt is not durable before the record statement runs");
  assert.equal(await store.start("main-a"), null);
  assert.equal(await store.startOperation("main-a", "op-1"), null, "the failed record rolls its receipt back, never a record without its receipt");
  await guidance.db.exec("DROP TRIGGER temp.c2_fail_record");
  await guidance.db.prepare("DELETE FROM meta WHERE key=?").run(receiptKey);
  await guidance.db.exec(`CREATE TEMP TRIGGER c2_fail_receipt BEFORE INSERT ON main.meta WHEN NEW.key GLOB 'supervisor_start_operation:*' BEGIN
    SELECT RAISE(ABORT, 'c2_receipt_failed'); END`);
  await assert.rejects(async () => await store.saveStart(start), /supervision_store_unavailable/u);
  assert.equal(await store.start("main-a"), null, "a failed receipt prevents the record");
  assert.equal(await store.startOperation("main-a", "op-1"), null);
  await guidance.db.exec("DROP TRIGGER temp.c2_fail_receipt");
  await guidance.db.exec(`CREATE TEMP TRIGGER c2_view_record BEFORE INSERT ON main.meta WHEN NEW.key GLOB 'supervisor_start:*' BEGIN SELECT c2_start_view(); END`);
  views.length = 0;
  await store.saveStart(start);
  assert.deepEqual(views, [{receipt: false, record: false}]);
  assert.deepEqual({receipt: readMeta(receiptKey) !== null, record: readMeta(recordKey) !== null}, {receipt: true, record: true});
  await guidance.db.exec("DROP TRIGGER temp.c2_view_record");

  // reservation moves the unbound stop into the new binding inside one transaction
  const stop: NonNullable<BindingRecord["supervisionStop"]> = {route: "chat", callerThreadId: "main-b", userMessageId: "message-1", stoppedAt: 150};
  await store.saveUnboundStop("main-b", stop);
  const metaBefore = await metaRows(guidance.db);
  await guidance.db.exec(`CREATE TEMP TRIGGER c2_fail_binding BEFORE INSERT ON main.supervisor_main_bindings BEGIN SELECT RAISE(ABORT, 'c2_binding_failed'); END`);
  await assert.rejects(async () => await store.reserve("project-a", "main-b", "Main B", defaultSupervisorModel, 1, 200), /supervision_store_unavailable/u);
  assert.equal(guidance.db.isTransaction, false);
  assert.deepEqual(await metaRows(guidance.db), metaBefore, "the unbound stop is still stored");
  assert.deepEqual(await store.chatStop("main-b"), stop);
  assert.deepEqual(await tableRows(guidance.db, "supervisor_owned_threads"), [], "no owned root is recorded");
  assert.deepEqual(await tableRows(guidance.db, "supervisor_main_bindings"), []);
  assert.deepEqual([...ownedIds], []);
  await guidance.db.exec("DROP TRIGGER temp.c2_fail_binding");

  const transfer: unknown[] = [];
  guidance.db.function("c2_transfer_view", () => {
    transfer.push({unbound: readMeta("supervisor_unbound_stop:main-b") !== null,
      bindings: reader.prepare("SELECT count(*) AS n FROM supervisor_main_bindings").get()?.n});
    return null;
  });
  await guidance.db.exec(`CREATE TEMP TRIGGER c2_view_binding AFTER INSERT ON main.supervisor_main_bindings BEGIN SELECT c2_transfer_view(); END`);
  const binding = await store.reserve("project-a", "main-b", "Main B", defaultSupervisorModel, 1, 200);
  await guidance.db.exec("DROP TRIGGER temp.c2_view_binding");
  assert.deepEqual(transfer, [{unbound: true, bindings: 0}], "an outside reader sees the stop still unbound until the commit");
  assert.equal(readMeta("supervisor_unbound_stop:main-b"), null);
  assert.deepEqual(JSON.parse(String(reader.prepare("SELECT document FROM supervisor_main_bindings WHERE main_thread_id='main-b'").get()?.document)).supervisionStop, stop);
  assert.deepEqual(binding.supervisionStop, stop);
  assert.deepEqual(await store.chatStop("main-b"), stop, "the stop is read from the binding after the transfer");
  assert.deepEqual([...ownedIds], [binding.threadId]);
});
