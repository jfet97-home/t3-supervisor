import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { prepareStopNotice, defaultSupervisorModel, type BindingRecord, type SupervisionFolderPresence, type TaskRecord } from "../src/project-supervisor-store.js";
import { SupervisorIds } from "../src/ids.js";
import { SupervisorRpcError, type NativeRpcShape } from "../src/supervisor-native.js";
import type { SupervisorConfig } from "../src/types.js";
import { failsWith, metaRows, readerRows, sqlText, tableRows, withMillis, type DbSeam } from "./support/psx-sql.js";
import { openGuidance, openSupervisors, openWorkflows, pssSession, readOnlyDatabase, spyPrepare } from "./support/psx-stores.js";
import { addSupervisorRequest, completeSupervisorRequest, retryInput, submitInterpretation, workflowFields } from "./support/psx-submission.js";
import { assembleSupervisor, makeFixture, makeNoProjectFixture, supervisionStateDigest, type PsxFixture } from "./support/psx-supervisor.js";

// it.live: every case opens real sqlite files. Per-call AbortSignal deadlines are gone; each test's timeout is the hang guard.
// A cycle interrupted from the test fiber settles the way the baseline runOnce did when its signal aborted with no other failure.

const mainThreadId = "source-thread";

const sourceTask = [{threadId: mainThreadId, projectId: "project-a", turns: [{id: "source-task", sequence: 11, text: "Create a migration plan"}]}];

const interpretationDispatches = (fixture: PsxFixture, taskId: string) =>
  fixture.messageDispatches().filter(call => call.payload.commandId === `supervisor-objective:${taskId}`);

const identity = (call: {payload: Record<string, unknown>}) => ({commandId: call.payload.commandId, messageId: call.payload.messageId, text: call.payload.text,
  threadId: call.payload.threadId});

const taskRows = (fixture: PsxFixture) => Effect.map(
  fixture.db.prepare("SELECT count(*) AS n FROM supervisor_task_interpretations WHERE thread_id=?").get(mainThreadId),
  (row) => Number(row?.n));

const spin = (ready: () => boolean) => Effect.gen(function* () {while (!ready()) yield* Effect.yieldNow;});

const messageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
};

// a native interpretation dispatch that is recorded and then held until the test releases it
const holdDispatch = (fixture: PsxFixture) => Effect.gen(function* () {
  const reached = yield* Deferred.make<void>();
  const release = yield* Deferred.make<{accepted: boolean}, SupervisorRpcError>();
  fixture.setOperateHook((tag, payload) => {
    if (tag !== "orchestration.dispatchCommand" || payload.type !== "message.dispatch") return null;
    fixture.setOperateHook(null);
    return Effect.gen(function* () {
      yield* Deferred.succeed(reached, undefined);
      return yield* Deferred.await(release);
    });
  });
  return {reached, release};
});

// the dead process's cycle is detached: its later write hits the closed file and must not fail the live process
const forkCycle = (fixture: PsxFixture) => Effect.flatMap(fixture.makeSupervisor(), (supervisor) => Effect.forkDetach(supervisor.cycle));

const unresolvedStart = "An earlier Start is unresolved. Reconcile its operation ID before another request.";

const interruptedStartReason = "Start intake was interrupted before permission was reserved. Submit a new explicit request.";

const proposedWorkflow = {status: "proposed" as const, message: "Current draft", workspaceRoot: "/work/a", revision: "definitions-1", globalRevision: null,
  definitionsStatus: "ready" as const, definitionsComplete: true, requirementsKnown: true, requirements: [], issues: [], plan: null};

const inferredTask = (supervisorThreadId: string): TaskRecord => ({id: "task-inferred", threadId: "main-inferred", projectId: "project-a", sourceRunId: "run-1", sourceMessageId: "message-1",
  sourceHash: "hash-1", status: "inferred", objective: "Export CSV", reason: "Interpreted.", updatedAt: 100, requestText: "Add CSV export", supervisorThreadId,
  messageId: "notice-1", dispatchedAt: 50, replayCount: 0, supervisorRunId: "supervisor-run-1", sourceOrdinal: 1, workflow: proposedWorkflow,
  agreement: {status: "agreed", message: "Agreed.", proposalId: "proposal-1", agreedAt: 90, evidence: {kind: "supervisor_message", messageId: "supervisor-message-1"}, agentMessageId: "agent-message-1", workflow: proposedWorkflow}});

const queuedTask = (threadId: string, supervisorThreadId: string, dispatchedAt: number | null): TaskRecord => ({id: `task-${threadId}`, threadId, projectId: "project-a",
  sourceRunId: "run-2", sourceMessageId: "message-2", sourceHash: "hash-2", status: "queued", objective: null, reason: "Queued for interpretation.", updatedAt: 110,
  requestText: "Interpret this request", supervisorThreadId, messageId: `notice-${threadId}`, dispatchedAt, replayCount: 0, supervisorRunId: null, sourceOrdinal: 2,
  definitionContext: null, definitionReadAttempts: 1, revalidationAttempts: 1});

const pssBoundary = {snapshotSequence: 7, threads: [{id: "main-a", latestRunId: "run-a"}]};

// written by the baseline writers below with the clock fixed; this is the pre-migration on-disk format
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
const pssDdl = (db: DbSeam) => Effect.map(db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (name GLOB 'supervisor_*' OR name='meta') ORDER BY name='meta',name").all(),
  (rows) => rows.map((row) => [String(row.name), String(row.sql)] as [string, string]).filter(([name]) => pssDdlGolden.some(([golden]) => golden === name)));

const deadRpc = (native: string[], name: string): NativeRpcShape => ({
  call: () => Effect.sync(() => {native.push(name); throw new Error(`${name} must not be called`);}),
  initiate: () => Effect.sync(() => {native.push(name); throw new Error(`${name} must not be called`);}),
});

it.live("CT-PS-01: an aborted interpretation dispatch becomes uncertain and a crash keeps it dispatching; the next cycle replays the identical identity", () => Effect.gen(function* () {
  {
    // (a) abort: the dispatch result is interrupted after the request left, as the native adapter's aborted call was (outcome uncertain)
    const fixture = yield* makeFixture(sourceTask);
    const reached = yield* Deferred.make<void>();
    fixture.setOperateHook((tag, payload) => {
      if (tag !== "orchestration.dispatchCommand" || payload.type !== "message.dispatch") return null;
      fixture.setOperateHook(null);
      return Effect.gen(function* () {
        yield* Deferred.succeed(reached, undefined);
        return yield* Effect.never;
      });
    });
    const supervisor = yield* fixture.makeSupervisor();
    const cycle = yield* Effect.forkDetach(supervisor.cycle);
    yield* Deferred.await(reached);
    yield* Fiber.interrupt(cycle);
    const exit = yield* Fiber.await(cycle);
    assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "the interrupted cycle settles");
    const uncertain = yield* fixture.supervisorStore.task(mainThreadId);
    assert.ok(uncertain);
    assert.equal(uncertain.status, "uncertain");
    assert.equal(uncertain.messageId, `supervisor-objective:${uncertain.id}`);
    assert.equal(uncertain.replayCount, 0);
    const [first] = interpretationDispatches(fixture, uncertain.id);
    assert.ok(first);
    assert.equal(fixture.messageDispatches().length, 1);

    yield* supervisor.cycle;
    const replayed = yield* fixture.supervisorStore.task(mainThreadId);
    assert.ok(replayed);
    assert.equal(replayed.id, uncertain.id, "no new task identity");
    assert.equal(replayed.replayCount, 1);
    assert.equal(replayed.status, "waiting");
    assert.equal(fixture.messageDispatches().length, 2);
    assert.deepEqual(fixture.messageDispatches().map(identity), [identity(first), identity(first)]);
    assert.equal(yield* taskRows(fixture), 1);
  }
  {
    // (b) crash: the request is recorded and never answered; the process dies and a new supervisor opens the same guidance file
    const fixture = yield* makeFixture(sourceTask);
    const held = yield* holdDispatch(fixture);
    const crashed = yield* forkCycle(fixture);
    yield* Deferred.await(held.reached);
    yield* fixture.restart();
    const dispatching = yield* fixture.supervisorStore.task(mainThreadId);
    assert.ok(dispatching);
    assert.equal(dispatching.status, "dispatching");
    assert.equal(dispatching.messageId, `supervisor-objective:${dispatching.id}`);
    assert.equal(dispatching.replayCount, 0);
    assert.equal(typeof dispatching.dispatchedAt, "number");
    const [first] = fixture.messageDispatches();
    assert.ok(first);
    assert.equal(first.payload.commandId, `supervisor-objective:${dispatching.id}`);

    const supervisor = yield* fixture.makeSupervisor();
    yield* supervisor.cycle;
    const replayed = yield* fixture.supervisorStore.task(mainThreadId);
    assert.ok(replayed);
    assert.equal(replayed.id, dispatching.id, "no new task identity");
    assert.equal(replayed.replayCount, 1);
    assert.equal(replayed.status, "waiting");
    assert.deepEqual(fixture.messageDispatches().map(identity), [identity(first), identity(first)]);
    assert.equal(fixture.launches().length, 1, "the bound Supervisor is not launched again");
    assert.equal(yield* taskRows(fixture), 1);
    // the dead process's continuation cannot write to the closed connection; its outcome is irrelevant
    yield* Deferred.succeed(held.release, {accepted: true});
    yield* Fiber.await(crashed);
    assert.deepEqual(yield* fixture.supervisorStore.task(mainThreadId), replayed);
  }
}), {timeout: 10_000});

it.live("CT-PS-02: a task persisted as dispatching before a crash keeps its identity: a present native result is applied once, an absent one is replayed twice then uncertain", () => Effect.gen(function* () {
  const crashWhileDispatching = Effect.gen(function* () {
    const fixture = yield* makeFixture(sourceTask);
    // the request never reaches T3: the rpc is held without a native effect until after the restart
    const held = yield* holdDispatch(fixture);
    const crashed = yield* forkCycle(fixture);
    yield* Deferred.await(held.reached);
    yield* fixture.restart();
    yield* Deferred.fail(held.release, new SupervisorRpcError("rejected"));
    yield* Fiber.await(crashed);
    const dispatching = yield* fixture.supervisorStore.task(mainThreadId);
    assert.ok(dispatching);
    assert.equal(dispatching.status, "dispatching");
    assert.equal(dispatching.replayCount, 0);
    const binding = yield* fixture.supervisorStore.binding("project-a", mainThreadId);
    assert.ok(binding?.state === "ready");
    assert.equal(fixture.messageDispatches().length, 1);
    return {fixture, dispatching, binding, first: fixture.messageDispatches()[0]!};
  });
  {
    const {fixture, dispatching, binding} = yield* crashWhileDispatching;
    const root = fixture.projections.get(binding.threadId);
    assert.ok(root);
    addSupervisorRequest(root, {messageId: dispatching.messageId, text: dispatching.requestText});
    const supervisor = yield* fixture.makeSupervisor();
    // the present native result is the root's typed submission in the request run; its final chat text is not read
    assert.equal((yield* submitInterpretation({...fixture.stores, workflows: fixture.workflows, projections: fixture.projections}, dispatching,
      workflowFields(dispatching.sourceMessageId, "Create a migration plan", "The source asks for a plan."))).status, "submitted");
    completeSupervisorRequest(root, dispatching.messageId, "Submitted the interpretation.");
    yield* supervisor.cycle;
    const applied = yield* fixture.supervisorStore.task(mainThreadId);
    assert.ok(applied);
    assert.equal(applied.id, dispatching.id);
    assert.equal(applied.status, "inferred");
    assert.equal(applied.objective, "Create a migration plan");
    assert.equal(applied.supervisorRunId, root.runs[0]!.id);
    yield* supervisor.cycle;
    const again = yield* fixture.supervisorStore.task(mainThreadId);
    assert.equal(again?.id, dispatching.id);
    assert.equal(again?.status, "inferred");
    assert.equal(again?.objective, "Create a migration plan");
    assert.equal(interpretationDispatches(fixture, dispatching.id).length, 1, "the identity is never resent once its native result exists");
    assert.equal(yield* taskRows(fixture), 1);
  }
  {
    const {fixture, dispatching, first} = yield* crashWhileDispatching;
    fixture.setAcceptedDispatchesWithoutRun(10);
    const supervisor = yield* fixture.makeSupervisor();
    const states: Array<[string, number]> = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      yield* supervisor.cycle;
      const task = yield* fixture.supervisorStore.task(mainThreadId);
      assert.equal(task?.id, dispatching.id);
      states.push([task.status, task.replayCount]);
    }
    assert.deepEqual(states, [["waiting", 1], ["waiting", 2], ["uncertain", 2], ["uncertain", 2]]);
    assert.equal((yield* fixture.supervisorStore.task(mainThreadId))?.reason, "The accepted request has no matching native run. Retry native access to reconcile its retained identity.");
    assert.deepEqual(fixture.messageDispatches().map(identity), [identity(first), identity(first), identity(first)], "two replays with the original identity");
    assert.equal(yield* taskRows(fixture), 1);
  }
}), {timeout: 10_000});

it.live("CT-PS-03: concurrent runOnce and runOnce with retry for one main launch one Supervisor and dispatch one interpretation", () => Effect.gen(function* () {
  {
    const fixture = yield* makeFixture(sourceTask);
    const supervisor = yield* fixture.makeSupervisor();
    yield* Effect.all([supervisor.cycle, supervisor.cycle], {concurrency: "unbounded"});
    const task = yield* fixture.supervisorStore.task(mainThreadId);
    assert.ok(task);
    assert.equal(task.status, "waiting");
    assert.equal(fixture.launches().length, 1);
    assert.deepEqual(fixture.messageDispatches().map(call => call.payload.commandId), [`supervisor-objective:${task.id}`], "only the surviving task identity is sent");
    assert.equal(yield* taskRows(fixture), 1);
    yield* supervisor.cycle;
    assert.equal(fixture.messageDispatches().length, 1);
    assert.equal(fixture.launches().length, 1);
  }
  {
    const fixture = yield* makeFixture(sourceTask);
    const supervisor = yield* fixture.makeSupervisor();
    // the first interpretation dispatch loses its response, leaving the task uncertain for the concurrent retry
    fixture.setOperateHook((tag, payload) => {
      if (tag !== "orchestration.dispatchCommand" || payload.type !== "message.dispatch") return null;
      fixture.setOperateHook(null);
      return Effect.fail(new Error("simulated lost response"));
    });
    yield* supervisor.cycle;
    const uncertain = yield* fixture.supervisorStore.task(mainThreadId);
    const binding = yield* fixture.supervisorStore.binding("project-a", mainThreadId);
    assert.ok(uncertain && binding);
    assert.equal(uncertain.status, "uncertain");
    const [first] = fixture.messageDispatches();
    assert.ok(first);
    const [, retried] = yield* Effect.all([supervisor.cycle, supervisor.retry(retryInput("project-a", 0, binding, "retry"))], {concurrency: "unbounded"});
    assert.equal(retried.status, "saved");
    const task = yield* fixture.supervisorStore.task(mainThreadId);
    assert.equal(task?.id, uncertain.id);
    assert.equal(task?.status, "waiting");
    assert.deepEqual(fixture.messageDispatches().map(identity), [identity(first), identity(first)], "one replay with the original identity");
    assert.equal(fixture.launches().length, 1);
  }
}), {timeout: 10_000});

it.live("CT-PS-04: concurrent Starts with one operation ID share one record and a different operation ID while pending is denied", () => Effect.gen(function* () {
  const f = yield* makeNoProjectFixture();
  const args = {callerThreadId: "manual", userMessageId: "request-start", operationId: "same-start"};
  const evidence = {runId: "run-request-start"};
  const [first, second, dashboard, other] = yield* Effect.all([
    f.supervisor.startSupervision(args, evidence),
    f.supervisor.startSupervision(args, evidence),
    f.supervisor.dashboardStart("manual", "dashboard-start"),
    f.supervisor.startSupervision({...args, operationId: "other-start"}, evidence),
  ], {concurrency: "unbounded"});
  assert.equal(first.status, "pending");
  assert.deepEqual(second, first);
  assert.deepEqual(dashboard, {status: "denied", reason: unresolvedStart});
  assert.deepEqual(other, {status: "denied", reason: unresolvedStart});
  const db = f.fixture.db;
  const starts = yield* db.prepare("SELECT key,value FROM meta WHERE key LIKE 'supervisor\\_start:%' ESCAPE '\\'").all();
  assert.equal(starts.length, 1, "one start record for the thread");
  const start = yield* f.fixture.supervisorStore.start("manual");
  assert.equal(start?.operationId, "same-start");
  assert.equal(start?.status, "pending");
  assert.equal(typeof start?.taskId, "string");
  assert.deepEqual(yield* f.supervisor.startStatus("manual", "same-start"), {threadId: "manual", operationId: "same-start", status: "pending", reason: first.reason});
  for (const operationId of ["dashboard-start", "other-start"])
    assert.deepEqual(yield* f.supervisor.startStatus("manual", operationId), {threadId: "manual", operationId, status: "denied", reason: unresolvedStart});
  assert.equal((yield* db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'supervisor\\_start\\_operation:%' ESCAPE '\\'").get())?.n, 3);
  assert.deepEqual(yield* f.supervisor.startSupervision(args, evidence), first, "a later replay returns the recorded result");
  assert.equal((yield* f.fixture.supervisorStore.start("manual"))?.taskId, start?.taskId);
  assert.equal(f.fixture.operations.length, 0, "Start intake makes no native call");

  const ui = yield* makeNoProjectFixture();
  const policyGeneration = (yield* ui.policy.get()).generation;
  const [left, right] = yield* Effect.all([ui.supervisor.dashboardStart("manual", "dashboard"), ui.supervisor.dashboardStart("manual", "dashboard")], {concurrency: "unbounded"});
  assert.equal(left.status, "active");
  assert.deepEqual(right, left);
  assert.equal((yield* ui.fixture.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'supervisor\\_start:%' ESCAPE '\\'").get())?.n, 1);
  assert.equal((yield* ui.fixture.supervisorStore.start("manual"))?.operationId, "dashboard");
  assert.equal((yield* ui.fixture.supervisorStore.start("manual"))?.status, "active");
  assert.equal((yield* ui.policy.get()).generation, policyGeneration, "an Enable of a chat that is not excluded writes no policy");
  assert.equal(ui.fixture.operations.length, 0);
}), {timeout: 10_000});

it.live("CT-PS-05: concurrent control() shares one presence and boundary read; when the first caller aborts the joined caller records presence unavailable", () => Effect.gen(function* () {
  // shared success: one presence read and one activation snapshot serve both callers
  {
    const f = yield* makeFixture([{threadId: "new-main", projectId: "project-new", turns: []}]);
    f.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
    let presenceCalls = 0;
    const presenceCalled = yield* Deferred.make<void>();
    const presence = yield* Deferred.make<SupervisionFolderPresence>();
    let nowCalls = 0;
    let secondJoined = false;
    // resolveControl reads the clock immediately before it calls detectFolder, which joins the in-flight read synchronously
    const now = () => {nowCalls += 1; if (nowCalls === 2) secondJoined = true; return Date.now();};
    const supervisor = yield* f.makeSupervisor({now, definitions: {...f.missingDefinitions, presence: () => Effect.gen(function* () {
      presenceCalls += 1;
      yield* Deferred.succeed(presenceCalled, undefined);
      return yield* Deferred.await(presence);
    })}});
    nowCalls = 0;
    secondJoined = false;
    const first = yield* Effect.forkChild(supervisor.control("project-new"));
    yield* Deferred.await(presenceCalled);
    const second = yield* Effect.forkChild(supervisor.control("project-new"));
    yield* spin(() => secondJoined);
    yield* Deferred.succeed(presence, {status: "present"});
    const left = yield* Fiber.join(first);
    const right = yield* Fiber.join(second);
    assert.equal(presenceCalls, 1);
    assert.equal(f.baselineReads, 1, "one activation snapshot");
    assert.deepEqual(right, left);
    assert.equal(left.enabled, true);
    assert.equal(left.detectionStatus, "present");
    assert.equal(yield* f.supervisorStore.autoControlInitialized("project-new"), true);
  }
  // the shared read runs in the first caller: its interruption ends that call without a result and fails the joined caller,
  // which records unavailable in memory only
  {
    const f = yield* makeFixture([{threadId: "new-main", projectId: "project-new", turns: []}]);
    f.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
    let presenceCalls = 0;
    const presenceCalled = yield* Deferred.make<void>();
    let nowCalls = 0;
    let secondJoined = false;
    const now = () => {nowCalls += 1; if (nowCalls === 2) secondJoined = true; return Date.now();};
    const supervisor = yield* f.makeSupervisor({now, definitions: {...f.missingDefinitions, presence: () => Effect.gen(function* () {
      presenceCalls += 1;
      yield* Deferred.succeed(presenceCalled, undefined);
      return yield* Effect.never;
    })}});
    nowCalls = 0;
    secondJoined = false;
    const first = yield* Effect.forkDetach(supervisor.control("project-new"));
    yield* Deferred.await(presenceCalled);
    const second = yield* Effect.forkChild(supervisor.control("project-new"));
    yield* spin(() => secondJoined);
    // the joiner has read the clock; let it park on the shared check before the first caller is interrupted
    for (let step = 0; step < 8; step++) yield* Effect.yieldNow;
    yield* Fiber.interrupt(first);
    const left = yield* Fiber.await(first);
    const right = yield* Fiber.join(second);
    assert.equal(Exit.isFailure(left), true, "the interrupted first caller ends without a control read");
    assert.equal(right.detectionStatus, "unavailable");
    assert.equal(right.detectionError, "The project .t3-supervisor folder could not be checked.");
    assert.equal(right.enabled, false);
    assert.equal(presenceCalls, 1, "the second caller joined the first caller's read");
    assert.equal(f.baselineReads, 0);
    assert.equal((yield* f.supervisorStore.control("project-new")).detectionStatus, "unavailable");
    assert.equal(yield* f.supervisorStore.folderPresenceNeedsBoundary("project-new"), false, "the unavailable outcome is not persisted");
    assert.equal(yield* f.supervisorStore.autoControlInitialized("project-new"), false);
    assert.equal((yield* f.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'supervisor\\_control\\_%' ESCAPE '\\' AND key LIKE '%project-new%'").get())?.n, 0);
  }
}), {timeout: 10_000});

it.live("CT-PS-07: a failing policy save rejects the dashboard Start without an Enable; a failing guidance commit keeps only the policy change and a pending Start", () => Effect.gen(function* () {
  // clause 1: writeChatPolicy swallows the save error, activateStart returns false before any guidance write and the Start is rejected
  {
    let tick = Date.now();
    const f = yield* makeNoProjectFixture(() => ++tick);
    const stopped = yield* f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: (yield* f.policy.get()).generation, enabled: false});
    assert.equal(stopped.status, "saved");
    const stop = yield* f.fixture.supervisorStore.chatStop("manual");
    assert.ok(stop);
    const policyBefore = yield* f.policy.get();
    assert.deepEqual(policyBefore.excludedThreadIds, ["manual"]);
    f.policy.failSaves = true;
    const enabled = yield* f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: policyBefore.generation, enabled: true});
    assert.equal(enabled.status, "unavailable");
    assert.equal(enabled.message, "Start was not activated.");
    assert.equal(f.policy.failedSaves, 3, "the policy write is attempted three times");
    const start = yield* f.fixture.supervisorStore.start("manual");
    assert.equal(start?.status, "rejected");
    assert.equal(start?.reason, "Start could not be committed.");
    assert.ok(start);
    assert.deepEqual(yield* f.supervisor.startStatus("manual", start.operationId), {threadId: "manual", operationId: start.operationId, status: "rejected", reason: "Start could not be committed."});
    assert.equal(yield* f.fixture.supervisorStore.chatEnabledAt("manual"), null, "no chat Enable is recorded");
    assert.deepEqual(yield* f.fixture.supervisorStore.chatStop("manual"), stop, "the Stop record is kept");
    assert.deepEqual(yield* f.policy.get(), policyBefore, "the policy is unchanged");
    assert.equal(yield* f.supervisor.scopeEnabled("project-a", "manual"), false);
    assert.equal(enabled.snapshot?.chatSupervision?.stopped, true);
    assert.equal(enabled.snapshot?.chatSupervision?.activation, "rejected");
    assert.equal(f.fixture.operations.length, 0);
  }
  // clause 2: the policy commit precedes the guidance transaction, so a guidance failure leaves only the policy change
  {
    let tick = Date.now();
    const f = yield* makeNoProjectFixture(() => ++tick);
    yield* f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: (yield* f.policy.get()).generation, enabled: false});
    const stop = yield* f.fixture.supervisorStore.chatStop("manual");
    assert.ok(stop);
    const policyBefore = yield* f.policy.get();
    const db = f.fixture.db;
    yield* db.exec(`CREATE TEMP TRIGGER c2_fail_start_activation BEFORE UPDATE ON meta
      WHEN NEW.key = 'supervisor_start:manual' AND json_extract(NEW.value, '$.status') = 'active'
      BEGIN SELECT RAISE(ABORT, 'simulated guidance failure during Start activation'); END`);
    const result = yield* f.supervisor.dashboardStart("manual", "enable-after-stop");
    assert.deepEqual(result, {status: "unavailable", reason: "Start preparation failed before activation. Use a new explicit request after inspecting this outcome."});
    assert.equal(yield* db.inTransaction, false, "the guidance transaction rolled back");
    const policy = yield* f.policy.get();
    assert.equal(policy.generation, policyBefore.generation + 1, "the policy commit persists");
    assert.deepEqual(policy.excludedThreadIds, []);
    assert.equal(yield* f.fixture.supervisorStore.chatEnabledAt("manual"), null, "the chat Enable rolled back");
    assert.deepEqual(yield* f.fixture.supervisorStore.chatStop("manual"), stop, "the unbound Stop removal rolled back");
    const start = yield* f.fixture.supervisorStore.start("manual");
    assert.equal(start?.status, "pending", "the Start stays pending");
    assert.equal(start?.operationId, "enable-after-stop");
    assert.deepEqual(yield* f.supervisor.startStatus("manual", "enable-after-stop"), {threadId: "manual", operationId: "enable-after-stop", status: "pending",
      reason: "Waiting for the Supervisor's first source-bound Start interpretation."});
    assert.equal(yield* f.supervisor.scopeEnabled("project-a", "manual"), false, "the Start is not active");
    assert.equal(f.fixture.operations.length, 0);
  }
}), {timeout: 10_000});

it.live("CT-PS-08: snapshot, overview, candidates and scopeSnapshot with ready bindings and pending tasks make no operate call and no write", () => Effect.gen(function* () {
  const f = yield* makeFixture([
    {threadId: "main-one", projectId: "project-a", turns: [{id: "task-one", sequence: 11, text: "Build the invoice export"}]},
    {threadId: "main-two", projectId: "project-a", turns: [{id: "task-two", sequence: 12, text: "Prepare the release note"}]},
  ]);
  const supervisor = yield* f.makeSupervisor();
  yield* supervisor.cycle;
  const bindings = yield* f.supervisorStore.bindings();
  assert.equal(bindings.length, 2);
  assert.ok(bindings.every(binding => binding.state === "ready"));
  assert.deepEqual(yield* Effect.all(["main-one", "main-two"].map((id) => Effect.map(f.supervisorStore.task(id), (task) => task?.status))), ["waiting", "waiting"]);
  const before = yield* supervisionStateDigest(f.db);
  assert.ok(before.tables.includes("supervisor_main_bindings") && before.tables.includes("supervisor_task_interpretations"));
  const operations = f.operations.length;

  const snapshot = yield* supervisor.snapshot("project-a", "main-one");
  assert.equal(snapshot.binding?.state, "ready");
  assert.equal(snapshot.tasks[0]?.status, "waiting");
  yield* supervisor.snapshot("project-a");
  const overview = yield* supervisor.overview({offset: 0, limit: 100});
  assert.equal(overview.total, 2);
  yield* supervisor.candidates();
  yield* supervisor.candidates("", "exclude");
  const scope = yield* supervisor.scopeSnapshot("project-a", "main-one");
  assert.equal(scope.supervisorThreadId, (yield* f.supervisorStore.binding("project-a", "main-one"))?.threadId);

  assert.equal(f.operations.length, operations, "no operate RPC call");
  assert.deepEqual(yield* supervisionStateDigest(f.db), before, "every supervisor_* table and meta row is unchanged");
}), {timeout: 10_000});

it.live("CT-PS-09: a Stop saved while the final models() read is awaited leaves the task queued with its prior reason and sends no interpretation", () => Effect.gen(function* () {
  const fixture = yield* makeFixture(sourceTask, {threadPolicy: true});
  const policy = fixture.threadPolicy;
  assert.ok(policy);
  const supervisor = yield* fixture.makeSupervisor();
  let reasonAtStop: string | null = null;
  // the Stop lands while the last read before dispatch is awaited: discovery has no task yet, the final read sees it queued.
  // the hook's reads and the Stop run before the read answers, on the read's own fiber
  fixture.setReadHook(() => Effect.gen(function* () {
    const queued = yield* fixture.supervisorStore.task(mainThreadId);
    if (queued?.status === "queued" && reasonAtStop === null) {
      reasonAtStop = queued.reason;
      const current = yield* policy.get();
      yield* supervisor.saveThreadPolicy({...current, excludedThreadIds: [mainThreadId]});
    }
  }));
  yield* supervisor.cycle;
  assert.equal(reasonAtStop, "Waiting for the project Supervisor.", "the Stop was saved during the final models() read");
  assert.equal(yield* supervisor.supervisionStopped(mainThreadId), true);
  const task = yield* fixture.supervisorStore.task(mainThreadId);
  assert.ok(task);
  assert.equal(task.status, "queued");
  assert.equal(task.reason, reasonAtStop, "the prior reason is kept");
  assert.equal(task.dispatchedAt, null);
  assert.equal(interpretationDispatches(fixture, task.id).length, 0);
  assert.equal(fixture.messageDispatches().length, 0);
  assert.equal((yield* fixture.supervisorStore.binding("project-a", mainThreadId))?.supervisionStop?.route, "ui");
}), {timeout: 10_000});

it.live("CT-PS-10: control re-checks presence after 30 s, or 60 s once unavailable, on the constructor clock", () => Effect.gen(function* () {
  const f = yield* makeFixture([{threadId: "new-main", projectId: "project-new", turns: []}]);
  f.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
  let clock = 10_000;
  let presenceCalls = 0;
  const supervisor = yield* f.makeSupervisor({now: () => clock, definitions: {...f.missingDefinitions,
    presence: () => Effect.sync(() => {presenceCalls += 1; return {status: "unavailable" as const, message: "The folder could not be read."};})}});
  const control = () => supervisor.control("project-new");
  // never checked: the elapsed time is measured from 0, so the 30 s delay applies to the constructor clock itself
  assert.equal((yield* control()).detectionStatus, "not_checked");
  clock = 29_999;
  yield* control();
  assert.equal(presenceCalls, 0);
  clock = 30_000;
  const wallBefore = Date.now();
  const checked = yield* control();
  assert.equal(presenceCalls, 1);
  assert.equal(checked.detectionStatus, "unavailable");
  assert.equal(checked.detectionError, "The folder could not be read.");
  // the persisted unavailability is stamped by the ambient clock, not by the constructor clock
  const stamp = JSON.parse(String((yield* f.db.prepare("SELECT value FROM meta WHERE key=?").get(`supervisor_control_presence_unavailable:${JSON.stringify("project-new")}`))?.value)) as {checkedAt: number};
  assert.ok(stamp.checkedAt >= wallBefore);
  clock = 30_000 + 59_999;
  yield* control();
  assert.equal(presenceCalls, 1, "an unavailable result waits 60 s");
  clock = 30_000 + 60_000;
  yield* control();
  assert.equal(presenceCalls, 2);
}), {timeout: 10_000});

it.live("CT-PS-10: a running interpretation becomes unavailable only after more than 300 s of the supervisor clock, which also stamps dispatchedAt and updatedAt", () => Effect.gen(function* () {
  const f = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: [{id: "first-task", sequence: 11, text: "Review the release"}]}]);
  // the constructor clock stands an hour behind the wall clock, which alone would make a Date.now stamp fail the equality
  let wall = Date.now() - 3_600_000;
  const supervisor = yield* f.makeSupervisor({now: () => wall});
  yield* supervisor.cycle;
  const task = yield* f.supervisorStore.task("source-thread");
  assert.ok(task);
  assert.equal(task.status, "waiting");
  assert.equal(task.dispatchedAt, wall, "dispatchedAt is the supervisor clock");
  assert.equal(task.updatedAt, wall, "updatedAt is the supervisor clock");
  const binding = yield* f.supervisorStore.binding("project-a", "source-thread");
  assert.ok(binding);
  const run = f.projections.get(binding.threadId)?.runs.find(candidate => candidate.userMessageId === task.messageId);
  assert.ok(run);
  assert.equal(run.status, "running");
  run.startedAt = new Date(wall).toISOString();
  const started = wall;

  wall = started + 300_000;
  yield* supervisor.cycle;
  assert.equal((yield* f.supervisorStore.task("source-thread"))?.status, "waiting", "exactly 300 s is not yet a timeout");
  wall = started + 300_001;
  yield* supervisor.cycle;
  const timedOut = yield* f.supervisorStore.task("source-thread");
  assert.equal(timedOut?.status, "unavailable");
  assert.equal(timedOut?.reason, "The interpretation timed out or requires input. The service does not answer or interrupt Supervisor runs.");
  assert.equal(timedOut?.updatedAt, started + 300_001);
  assert.equal(f.operations.filter(call => call.payload.type === "message.dispatch").length, 1);
  assert.equal(f.operations.some(call => ["thread.interrupt", "runtime-request.respond", "runtime-request.interrupt"].includes(String(call.payload.type))), false);
}), {timeout: 10_000});

it.live("CT-PS-11: aborting runOnce during a hung Supervisor projection releases the scope lock for a later runOnce and retry", () => Effect.gen(function* () {
  const fixture = yield* makeFixture(sourceTask);
  const binding = yield* fixture.reserveReadyBinding();
  const supervisor = yield* fixture.makeSupervisor();
  const hung = yield* Deferred.make<void>();
  let hangs = 0;
  // the Supervisor projection hangs once a task is queued, which is the in-scope read of the batch (discovery reads it before saving the task).
  // the queued check runs inside the read, on that fiber, and the completed read still reports snapshot 20
  fixture.setProjectionHook((threadId) => {
    if (threadId !== binding.threadId) return undefined;
    const projection = fixture.projections.get(threadId)!;
    return Effect.gen(function* () {
      const task = yield* fixture.supervisorStore.task(mainThreadId);
      if (task?.status !== "queued") return {projection, snapshotSequence: 20};
      hangs += 1;
      yield* Deferred.succeed(hung, undefined);
      return yield* Effect.never;
    });
  });
  const cycle = yield* Effect.forkDetach(supervisor.cycle);
  yield* Deferred.await(hung);
  assert.equal(supervisor.queues.size, 1, "the hung read holds its scope queue");
  yield* Fiber.interrupt(cycle);
  const exit = yield* Fiber.await(cycle);
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "the aborted cycle settles");
  assert.equal(hangs, 1);
  fixture.setProjectionHook(null);
  assert.equal(supervisor.queues.size, 0, "no scope queue is held after the abort");
  const queued = yield* fixture.supervisorStore.task(mainThreadId);
  assert.equal(queued?.status, "queued");
  assert.equal(fixture.messageDispatches().length, 0);

  yield* supervisor.cycle;
  assert.equal((yield* fixture.supervisorStore.task(mainThreadId))?.status, "waiting");
  assert.equal(fixture.messageDispatches().length, 1);
  const retried = yield* supervisor.retry(retryInput("project-a", 0, binding, "retry"));
  assert.equal(retried.status, "saved");
  assert.equal(supervisor.queues.size, 0);
}), {timeout: 10_000});

it.live("CT-PSS-01: a Start operation left preparing by a crash is rejected on reopen and startStatus reports it without native work", () => Effect.gen(function* () {
  const session = yield* pssSession("psx-pss-01-");
  const first = yield* session.open();
  yield* first.store.saveStartOperation({threadId: "main-a", operationId: "op-pending", requestHash: "hash-pending", status: "pending", reason: "Waiting."});
  yield* first.store.saveStartOperation({threadId: "main-a", operationId: "op-settled", requestHash: "hash-settled", status: "denied", reason: "Denied.", preparing: false});
  yield* first.store.saveStart({threadId: "main-b", projectId: "project-b", operationId: "op-active", requestHash: "hash-active", route: "ui", status: "active",
    reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.", intentAt: 100, modeGeneration: 0, masterGeneration: 0, taskId: null});
  // the real intake path writes its preparing receipt, then the process dies while the catalog read is outstanding
  const releaseCatalog = yield* Deferred.make<void>();
  const config: SupervisorConfig = {dataDirectory: session.directory, t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0};
  const workflows = yield* openWorkflows(first.stores, first.scope);
  const crashing = yield* assembleSupervisor({
    config, stores: first.stores, workflows,
    catalog: () => Effect.gen(function* () {yield* Deferred.await(releaseCatalog); return {projects: [], threads: []};}),
    projection: () => Effect.die(new Error("unused")),
    read: {call: () => Effect.die(new Error("unused")), initiate: () => Effect.die(new Error("unused"))},
    operate: {call: () => Effect.die(new Error("unused")), initiate: () => Effect.die(new Error("unused"))},
    baseline: Effect.die(new Error("unused")),
    definitions: {load: () => Effect.die(new Error("unused"))},
  });
  const crashed = yield* Effect.forkDetach(crashing.dashboardStart("main-a", "op-crash"));
  let preparing = yield* first.store.startOperation("main-a", "op-crash");
  while (!preparing) {
    yield* Effect.yieldNow;
    preparing = yield* first.store.startOperation("main-a", "op-crash");
  }
  assert.equal(preparing.preparing, true);
  const untouched = (yield* metaRows(first.db)).filter(([key]) => key !== `supervisor_start_operation:${JSON.stringify(["main-a", "op-crash"])}`);
  yield* first.close;
  yield* Deferred.succeed(releaseCatalog, undefined);
  const crashedExit = yield* Fiber.await(crashed);
  if (!Exit.isFailure(crashedExit)) return yield* Effect.die(new Error("the crashed start succeeded"));
  assert.match(messageOf(crashedExit.cause), /guidance store sql failed/u);

  const native: string[] = [];
  const second = yield* session.open();
  const recovered = yield* second.store.startOperation("main-a", "op-crash");
  assert.deepEqual((yield* metaRows(second.db)).find(([key]) => key === 'supervisor_start_operation:["main-a","op-crash"]'), [
    'supervisor_start_operation:["main-a","op-crash"]',
    JSON.stringify({threadId: "main-a", operationId: "op-crash", requestHash: recovered!.requestHash, status: "rejected", reason: interruptedStartReason, preparing: false}),
  ]);
  assert.deepEqual((yield* metaRows(second.db)).filter(([key]) => key !== 'supervisor_start_operation:["main-a","op-crash"]'), untouched, "other Start rows are unchanged");
  const secondWorkflows = yield* openWorkflows(second.stores, second.scope);
  const supervisor = yield* assembleSupervisor({
    config, stores: second.stores, workflows: secondWorkflows,
    catalog: () => Effect.sync(() => {native.push("catalog"); throw new Error("catalog must not be called");}),
    projection: () => Effect.sync(() => {native.push("projection"); throw new Error("projection must not be called");}),
    read: deadRpc(native, "rpc"), operate: deadRpc(native, "rpc"),
    baseline: Effect.sync(() => {native.push("activationSnapshot"); throw new Error("activationSnapshot must not be called");}),
    definitions: {load: () => Effect.die(new Error("unused"))},
  });
  assert.deepEqual(yield* supervisor.startStatus("main-a", "op-crash"), {threadId: "main-a", operationId: "op-crash", status: "rejected", reason: interruptedStartReason});
  assert.deepEqual(yield* supervisor.startStatus("main-a", "op-pending"), {threadId: "main-a", operationId: "op-pending", status: "pending", reason: "Waiting."});
  assert.equal((yield* supervisor.startStatus("main-b", "op-active")).status, "active");
  assert.deepEqual(yield* supervisor.dashboardStart("main-a", "op-crash"), {status: "rejected", reason: interruptedStartReason},
    "replaying the interrupted operation returns its rejection");
  assert.equal(yield* second.store.start("main-a"), null, "no Start record was activated");
  assert.equal((yield* second.db.prepare("SELECT count(*) AS n FROM supervisor_chat_enables").get())?.n, 0);
  assert.deepEqual(native, [], "no catalog, projection, rpc or activation call");
}), {timeout: 10_000});

it.live("CT-PSS-03: a stale binding copy keeps the stored stop and notice, and the notice CAS honours the expected messageId", () => Effect.gen(function* () {
  const session = yield* pssSession("psx-pss-03-");
  const {db, store, stores} = yield* session.open();
  const binding = yield* store.reserve("project-a", "main-a", "Main", defaultSupervisorModel, 1, 100);
  const stale = (yield* store.binding("project-a", "main-a"))!;
  yield* store.setBinding({...stale, manualKeepActive: true, stopObservedAt: 150});
  const stop: NonNullable<BindingRecord["supervisionStop"]> = {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: 200};
  yield* store.setSupervisionStop(binding, stop);
  const stopped = (yield* store.binding("project-a", "main-a"))!;
  assert.deepEqual(stopped.supervisionStop, stop);
  assert.equal("manualKeepActive" in stopped || "stopObservedAt" in stopped, false, "a Stop clears keep-active and the observed stop marker");

  const notice = yield* prepareStopNotice(Context.get(stores.context, SupervisorIds), binding, 200, null);
  yield* store.setStopNotice(binding, null, notice);
  assert.deepEqual((yield* store.binding("project-a", "main-a"))!.stopNotice, notice, "expected null on an absent notice succeeds");
  assert.equal((yield* store.binding("project-a", "main-a"))!.stopNotice!.enabledAt, null);

  yield* store.setBinding({...stale, state: "ready", title: "Supervisor · Renamed"});
  const merged = (yield* store.binding("project-a", "main-a"))!;
  assert.equal(merged.state, "ready");
  assert.equal(merged.title, "Supervisor · Renamed");
  assert.deepEqual(merged.supervisionStop, stop, "the stale copy without a stop keeps the stored stop");
  assert.deepEqual(merged.stopNotice, notice, "the stale copy without a notice keeps the stored notice");
  yield* store.setBinding({...stale, supervisionStop: {...stop, stoppedAt: 1}, stopNotice: {...notice, messageId: "supervisor-notice:stop:other", state: "sent"}});
  assert.deepEqual((yield* store.binding("project-a", "main-a"))!.supervisionStop, stop, "a stale copy cannot replace the stored stop");
  assert.deepEqual((yield* store.binding("project-a", "main-a"))!.stopNotice, notice, "a stale copy cannot replace the stored notice");

  const document = () => Effect.map(db.prepare("SELECT document FROM supervisor_main_bindings WHERE main_thread_id='main-a'").get(), (row) => String(row?.document));
  const beforeWrongCas = yield* document();
  yield* store.setStopNotice(binding, "supervisor-notice:stop:wrong", {...notice, state: "sent"});
  assert.equal(yield* document(), beforeWrongCas, "a wrong expected messageId is a no-op");
  yield* store.setStopNotice(binding, null, {...notice, messageId: "supervisor-notice:stop:replacement"});
  assert.equal(yield* document(), beforeWrongCas, "expected null on a present notice is a no-op");
  yield* store.setStopNotice(binding, notice.messageId, {...notice, state: "accepted"});
  assert.deepEqual((yield* store.binding("project-a", "main-a"))!.stopNotice, {...notice, state: "accepted"}, "the matching expected messageId replaces the notice");

  yield* store.setSupervisionStop(binding, null);
  yield* store.setBinding({...stale, supervisionStop: stop});
  assert.equal("supervisionStop" in (yield* store.binding("project-a", "main-a"))!, false, "a stale copy cannot restore a cleared stop");
}), {timeout: 10_000});

it.live("CT-PSS-04: a stale global definitions generation changes nothing; a success stales inferred tasks and clears queued context in one commit", () => Effect.gen(function* () {
  const session = yield* pssSession("psx-pss-04-");
  const {db, store} = yield* session.open();
  const binding = yield* store.reserve("project-a", "main-inferred", "Main", defaultSupervisorModel, 1, 100);
  yield* store.saveTask(inferredTask(binding.threadId));
  yield* store.saveTask(queuedTask("main-queued", binding.threadId, null));
  yield* store.saveTask(queuedTask("main-dispatched", binding.threadId, 120));
  const tasksBefore = yield* tableRows(db, "supervisor_task_interpretations");
  const controlKeys = () => Effect.map(metaRows(db), (rows) => rows.filter(([key]) => key.startsWith("supervisor_global_definitions_")));

  yield* failsWith(store.saveGlobalDefinitionsControl(3, true, "~/.t3-supervisor", "global-1"), /global_definitions_control_conflict/u);
  assert.deepEqual(yield* tableRows(db, "supervisor_task_interpretations"), tasksBefore, "a stale generation leaves tasks untouched");
  assert.deepEqual(yield* controlKeys(), []);

  // a failure on the second task update rolls back the first task update and the control rows of the same commit
  // the seam worker logs each update from the trigger as it runs, outside the transaction it is part of
  yield* db.exec(`CREATE TEMP TRIGGER c2_fail_queued BEFORE UPDATE ON main.supervisor_task_interpretations BEGIN
    SELECT seam_log('c2_task_updated', NEW.thread_id);
    SELECT RAISE(ABORT, 'c2_task_update_failed') WHERE NEW.thread_id='main-queued'; END`);
  yield* failsWith(store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-1"), /supervision_store_unavailable/u);
  const updated = db.logged("c2_task_updated").map(([threadId]) => String(threadId));
  assert.deepEqual(updated, ["main-inferred", "main-queued"], "the inferred task was rewritten before the failing update");
  assert.equal(yield* db.inTransaction, false);
  assert.deepEqual(yield* tableRows(db, "supervisor_task_interpretations"), tasksBefore, "the earlier task update rolled back");
  assert.deepEqual(yield* controlKeys(), [], "the control and event rows rolled back");
  assert.equal((yield* store.globalDefinitionsControl()).generation, 0);
  yield* db.exec("DROP TRIGGER temp.c2_fail_queued");

  // a second connection observing at every task update sees none of the commit until it completes
  const reader = yield* readOnlyDatabase(session.path);
  // at every task update the seam worker reads the control row and the tasks through its own read-only connection
  const observe = `seam_observe('c2_observe', ${sqlText("SELECT value FROM meta WHERE key='supervisor_global_definitions_control'")}, ${sqlText("SELECT * FROM supervisor_task_interpretations ORDER BY rowid")})`;
  yield* db.exec(`CREATE TEMP TRIGGER c2_observe_update AFTER UPDATE ON main.supervisor_task_interpretations BEGIN SELECT ${observe}; END`);
  const changedAt = 1_790_000_000_000;
  const control = yield* withMillis(changedAt)(store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-1"));
  yield* db.exec("DROP TRIGGER temp.c2_observe_update");
  const observed = db.observed("c2_observe").map(([controlRows, tasks]) => ({control: controlRows?.[0]?.value ?? null, tasks}));
  assert.equal(control.generation, 1);
  assert.equal(control.enabled, true);
  assert.equal(observed.length, 2);
  for (const view of observed) assert.deepEqual(view, {control: null, tasks: tasksBefore}, "an outside reader sees no partial commit");
  assert.deepEqual(yield* controlKeys(), [
    ["supervisor_global_definitions_control", JSON.stringify({generation: 1, enabled: true, manual: true})],
    ["supervisor_global_definitions_event", JSON.stringify({generation: 1, enabled: true, changedAt, globalFingerprint: "global-1"})],
  ]);
  const inferred = (yield* store.task("main-inferred"))!;
  const staleMessage = "The user changed whether global definitions are included. The old plan and agreement are retained as stale history.";
  assert.deepEqual(inferred.workflow, {...inferredTask(binding.threadId).workflow!, status: "stale", message: staleMessage});
  assert.deepEqual(inferred.agreement, {...inferredTask(binding.threadId).agreement!, status: "stale", message: staleMessage});
  assert.deepEqual(inferred.definitionReview, {status: "checking", message: staleMessage, expectedRevision: "definitions-1", observedRevision: null,
    supervisorMessageId: null, userMessageIds: [], updatedAt: changedAt});
  assert.equal(inferred.updatedAt, changedAt);
  const queued = (yield* store.task("main-queued"))!;
  assert.equal(queued.status, "queued");
  assert.equal(queued.requestText, "");
  assert.equal(queued.reason, "Global definition inclusion changed; definitions will be refreshed before dispatch.");
  assert.equal(queued.workflow?.status, "pending");
  for (const key of ["definitionContext", "definitionSnapshot", "definitionReadAttempts", "revalidationAttempts"]) assert.equal(key in queued, false, `${key} is cleared`);
  assert.deepEqual(yield* store.task("main-dispatched"), queuedTask("main-dispatched", binding.threadId, 120), "a dispatched queued task keeps its context");
  assert.deepEqual(readerRows(reader, "supervisor_task_interpretations"), yield* tableRows(db, "supervisor_task_interpretations"), "the reader sees the whole commit afterwards");
}), {timeout: 10_000});

it.live("CT-PSS-05: ownership preload creates nothing for absent state, tolerates a table-less file and reads committed IDs beside a live WAL writer", () => Effect.gen(function* () {
  // target: the preload is the project store layer's own read when a run opens its stores (cc-ownership); the separate
  // read-only preload of an absent directory or under another connection's open write transaction is gone with it
  const session = yield* pssSession("psx-pss-05-");
  const bare = join(session.directory, "bare");
  mkdirSync(bare);
  const legacy = new DatabaseSync(join(bare, "guidance.sqlite3"));
  legacy.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  legacy.close();
  const bareScope = yield* Scope.make();
  const bareGuidance = yield* openGuidance(bare, bareScope);
  const bareOwned = new Set<string>();
  yield* openSupervisors(bare, bareGuidance, bareScope, bareOwned);
  assert.deepEqual(bareOwned, new Set(), "a file without supervisor_owned_threads yields no IDs");
  yield* Scope.close(bareScope, Exit.void);

  const {store} = yield* session.open();
  const first = yield* store.reserve("project-a", "main-a", "Main A", defaultSupervisorModel, 1, 100);
  const second = yield* store.reserve("project-a", "main-b", "Main B", defaultSupervisorModel, 1, 100);
  assert.equal(existsSync(`${session.path}-wal`), true, "the writer holds the WAL");
  const alongside = yield* session.open();
  assert.deepEqual(alongside.ownedIds, new Set([first.threadId, second.threadId]));
}), {timeout: 10_000});

it.live("CT-PSS-06: the supervision DDL and every meta key format are golden and read back unchanged after reopen", () => Effect.gen(function* () {
  const session = yield* pssSession("psx-pss-06-");
  const writer = yield* session.open();
  yield* withMillis(1_790_000_000_000)(Effect.gen(function* () {
    yield* writer.store.baseline(pssBoundary);
    yield* writer.store.saveControl(null, 0, true, pssBoundary);
    yield* writer.store.saveControl("project-a", 0, true, pssBoundary);
    yield* writer.store.recordFolderPresence("project-b", {status: "unavailable", message: "denied"});
    yield* writer.store.recordFolderPresence("project-c", {status: "present"}, pssBoundary);
    yield* writer.store.saveNoProjectControl(0, "automatic", pssBoundary);
    yield* writer.store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-fingerprint");
    yield* writer.store.saveStart({threadId: "main-a", projectId: "project-a", operationId: "op-1", requestHash: "hash-1", route: "ui", status: "active",
      reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.", intentAt: 1_790_000_000_000, modeGeneration: 1, masterGeneration: 1, taskId: null});
    yield* writer.store.saveUnboundStop("main-b", {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: 1_790_000_000_000});
  }));
  assert.deepEqual(yield* metaRows(writer.db), pssMetaGolden);
  assert.deepEqual(yield* pssDdl(writer.db), pssDdlGolden);
  yield* writer.close;

  const {db, store} = yield* session.open();
  assert.deepEqual(yield* metaRows(db), pssMetaGolden, "opening rewrites no meta row");
  assert.deepEqual(yield* pssDdl(db), pssDdlGolden);
  assert.equal(store.scopeCompatible, true);
  assert.deepEqual(yield* store.control(null), {projectId: null, generation: 1, enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true,
    detectionStatus: "not_checked", detectionError: null});
  assert.deepEqual(yield* store.control("project-a"), {projectId: "project-a", generation: 1, enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true,
    detectionStatus: "not_checked", detectionError: null});
  assert.deepEqual(yield* store.projectBoundary("project-a"), pssBoundary);
  assert.equal(yield* store.folderPresenceNeedsBoundary("project-b"), true);
  assert.deepEqual(yield* store.control("project-b"), {projectId: "project-b", generation: 0, enabled: false, manual: false, globallyEnabled: true, effectiveEnabled: false,
    detectionStatus: "not_checked", detectionError: null});
  assert.equal(yield* store.autoControlInitialized("project-c"), true);
  assert.deepEqual(yield* store.control("project-c"), {projectId: "project-c", generation: 0, enabled: true, manual: false, globallyEnabled: true, effectiveEnabled: true,
    detectionStatus: "present", detectionError: null});
  assert.deepEqual(yield* store.noProjectControl(), {generation: 1, mode: "automatic", baseline: pssBoundary, globallyEnabled: true});
  assert.deepEqual(yield* store.globalDefinitionsControl(), {generation: 1, enabled: true, manual: true, effectiveEnabled: true, homePath: "~/.t3-supervisor",
    detectionStatus: "not_checked", detectionError: null});
  assert.equal(yield* store.hasGlobalDefinitionsEvent(), true);
  assert.deepEqual(yield* store.baseline(), {...pssBoundary, version: 2});
  assert.equal(yield* store.activation(), 7);
  assert.deepEqual(yield* store.start("main-a"), JSON.parse(pssMetaGolden.find(([key]) => key === "supervisor_start:main-a")![1]));
  assert.deepEqual(yield* store.startOperation("main-a", "op-1"), {threadId: "main-a", operationId: "op-1", requestHash: "hash-1", status: "active",
    reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor."});
  assert.deepEqual(yield* store.chatStop("main-b"), {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: 1_790_000_000_000});
  assert.deepEqual(yield* metaRows(db), pssMetaGolden, "reads write nothing");
}), {timeout: 10_000});

it.live("CT-PSS-07: a legacy definition-save table gains expected_revision with an empty default exactly once and keeps its rows", () => Effect.gen(function* () {
  const session = yield* pssSession("psx-pss-07-");
  // the legacy file is written by the guidance store alone, before the supervision store added the column
  const legacyScope = yield* Scope.make();
  const legacy = yield* openGuidance(session.directory, legacyScope);
  yield* legacy.db.exec(`CREATE TABLE supervisor_definition_user_saves(project_id TEXT NOT NULL,workspace_root TEXT NOT NULL,signature TEXT NOT NULL,saved_at INTEGER NOT NULL,PRIMARY KEY(project_id,workspace_root));
    INSERT INTO supervisor_definition_user_saves VALUES('project-a','/work/a','signature-a',100);
    INSERT INTO meta VALUES('supervisor_scope_version','main-v1');`);
  yield* Scope.close(legacyScope, Exit.void);
  const alters = (calls: ReadonlyArray<string>) => calls.filter((sql) => sql.includes("ALTER TABLE supervisor_definition_user_saves")).length;
  const columns = (db: DbSeam) => Effect.map(db.prepare("PRAGMA table_info(supervisor_definition_user_saves)").all(), (rows) => rows.map((row) => ({...row})));
  const expectedRow = {project_id: "project-a", workspace_root: "/work/a", signature: "signature-a", saved_at: 100, expected_revision: ""};

  let firstCalls: () => ReadonlyArray<string> = () => [];
  const first = yield* session.open((guidance) => Effect.gen(function* () {firstCalls = yield* spyPrepare(guidance.db);}));
  assert.equal(alters(firstCalls()), 1);
  const migratedColumns = yield* columns(first.db);
  assert.deepEqual(migratedColumns.filter(column => column.name === "expected_revision"),
    [{cid: 4, name: "expected_revision", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0}]);
  assert.deepEqual(yield* tableRows(first.db, "supervisor_definition_user_saves"), [expectedRow]);
  const migratedSql = (yield* first.db.prepare("SELECT sql FROM sqlite_master WHERE name='supervisor_definition_user_saves'").get())?.sql;
  yield* first.close;

  let secondCalls: () => ReadonlyArray<string> = () => [];
  const second = yield* session.open((guidance) => Effect.gen(function* () {secondCalls = yield* spyPrepare(guidance.db);}));
  assert.equal(alters(secondCalls()), 0, "a migrated table is not altered again");
  assert.deepEqual(yield* columns(second.db), migratedColumns);
  assert.equal((yield* second.db.prepare("SELECT sql FROM sqlite_master WHERE name='supervisor_definition_user_saves'").get())?.sql, migratedSql);
  assert.deepEqual(yield* tableRows(second.db, "supervisor_definition_user_saves"), [expectedRow]);
}), {timeout: 10_000});

it.live("CT-PSS-08: a start record never exists without its operation receipt and reservation transfers an unbound stop atomically", () => Effect.gen(function* () {
  const session = yield* pssSession("psx-pss-08-");
  const {db, store, ownedIds} = yield* session.open();
  const reader = yield* readOnlyDatabase(session.path);
  const readMeta = (key: string) => reader.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ?? null;
  const start = {threadId: "main-a", projectId: "project-a", operationId: "op-1", requestHash: "hash-1", route: "agent" as const, status: "pending" as const,
    reason: "Waiting for the Supervisor's first source-bound Start interpretation.", intentAt: 100, modeGeneration: 0, masterGeneration: 0, taskId: "task-1"};
  const recordKey = "supervisor_start:main-a";
  const receiptKey = 'supervisor_start_operation:["main-a","op-1"]';

  // target (s6d step 1, CT-PSS-08): saveStart is one transaction, so the receipt and the record commit together. the start view
  // is the seam worker's read of both rows through its own read-only connection, from the trigger before the record insert
  const metaQuery = (key: string) => sqlText(`SELECT value FROM meta WHERE key=${sqlText(key)}`);
  const startView = `seam_observe('c2_start_view', ${metaQuery(receiptKey)}, ${metaQuery(recordKey)})`;
  const present = (rows: ReadonlyArray<Record<string, unknown>> | undefined) => (rows?.[0]?.value ?? null) !== null;
  const views = (from = 0) => db.observed("c2_start_view").slice(from).map(([receipt, record]) => ({receipt: present(receipt), record: present(record)}));
  yield* db.exec(`CREATE TEMP TRIGGER c2_fail_record BEFORE INSERT ON main.meta WHEN NEW.key GLOB 'supervisor_start:*' BEGIN
    SELECT ${startView}; SELECT RAISE(ABORT, 'c2_record_failed'); END`);
  assert.equal(yield* db.inTransaction, false);
  yield* failsWith(store.saveStart(start), /supervision_store_unavailable/u);
  assert.deepEqual(views(), [{receipt: false, record: false}], "the receipt is not durable before the record statement runs");
  assert.equal(yield* store.start("main-a"), null);
  assert.equal(yield* store.startOperation("main-a", "op-1"), null, "the failed record rolls its receipt back, never a record without its receipt");
  yield* db.exec("DROP TRIGGER temp.c2_fail_record");
  yield* db.prepare("DELETE FROM meta WHERE key=?").run(receiptKey);
  yield* db.exec(`CREATE TEMP TRIGGER c2_fail_receipt BEFORE INSERT ON main.meta WHEN NEW.key GLOB 'supervisor_start_operation:*' BEGIN
    SELECT RAISE(ABORT, 'c2_receipt_failed'); END`);
  yield* failsWith(store.saveStart(start), /supervision_store_unavailable/u);
  assert.equal(yield* store.start("main-a"), null, "a failed receipt prevents the record");
  assert.equal(yield* store.startOperation("main-a", "op-1"), null);
  yield* db.exec("DROP TRIGGER temp.c2_fail_receipt");
  yield* db.exec(`CREATE TEMP TRIGGER c2_view_record BEFORE INSERT ON main.meta WHEN NEW.key GLOB 'supervisor_start:*' BEGIN SELECT ${startView}; END`);
  const viewsFrom = views().length;
  yield* store.saveStart(start);
  assert.deepEqual(views(viewsFrom), [{receipt: false, record: false}]);
  assert.deepEqual({receipt: readMeta(receiptKey) !== null, record: readMeta(recordKey) !== null}, {receipt: true, record: true});
  yield* db.exec("DROP TRIGGER temp.c2_view_record");

  // reservation moves the unbound stop into the new binding inside one transaction
  const stop: NonNullable<BindingRecord["supervisionStop"]> = {route: "chat", callerThreadId: "main-b", userMessageId: "message-1", stoppedAt: 150};
  yield* store.saveUnboundStop("main-b", stop);
  const metaBefore = yield* metaRows(db);
  yield* db.exec(`CREATE TEMP TRIGGER c2_fail_binding BEFORE INSERT ON main.supervisor_main_bindings BEGIN SELECT RAISE(ABORT, 'c2_binding_failed'); END`);
  yield* failsWith(store.reserve("project-a", "main-b", "Main B", defaultSupervisorModel, 1, 200), /supervision_store_unavailable/u);
  assert.equal(yield* db.inTransaction, false);
  assert.deepEqual(yield* metaRows(db), metaBefore, "the unbound stop is still stored");
  assert.deepEqual(yield* store.chatStop("main-b"), stop);
  assert.deepEqual(yield* tableRows(db, "supervisor_owned_threads"), [], "no owned root is recorded");
  assert.deepEqual(yield* tableRows(db, "supervisor_main_bindings"), []);
  assert.deepEqual([...ownedIds], []);
  yield* db.exec("DROP TRIGGER temp.c2_fail_binding");

  const transferView = `seam_observe('c2_transfer_view', ${metaQuery("supervisor_unbound_stop:main-b")}, ${sqlText("SELECT count(*) AS n FROM supervisor_main_bindings")})`;
  yield* db.exec(`CREATE TEMP TRIGGER c2_view_binding AFTER INSERT ON main.supervisor_main_bindings BEGIN SELECT ${transferView}; END`);
  const binding = yield* store.reserve("project-a", "main-b", "Main B", defaultSupervisorModel, 1, 200);
  yield* db.exec("DROP TRIGGER temp.c2_view_binding");
  const transfer = db.observed("c2_transfer_view").map(([unbound, bindings]) => ({unbound: present(unbound), bindings: bindings?.[0]?.n}));
  assert.deepEqual(transfer, [{unbound: true, bindings: 0}], "an outside reader sees the stop still unbound until the commit");
  assert.equal(readMeta("supervisor_unbound_stop:main-b"), null);
  assert.deepEqual(JSON.parse(String(reader.prepare("SELECT document FROM supervisor_main_bindings WHERE main_thread_id='main-b'").get()?.document)).supervisionStop, stop);
  assert.deepEqual(binding.supervisionStop, stop);
  assert.deepEqual(yield* store.chatStop("main-b"), stop, "the stop is read from the binding after the transfer");
  assert.deepEqual([...ownedIds], [binding.threadId]);
}), {timeout: 10_000});
