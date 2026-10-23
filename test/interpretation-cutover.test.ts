import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Clock, Console, Context, Effect, Exit, FileSystem, Layer, Schema, SubscriptionRef } from "effect";
import { GuidanceDb, guidanceDbLayer } from "../src/db.js";
import { failureReason, InterpretationCutoverRefused } from "../src/errors.js";
import { fingerprint, GuidanceStore } from "../src/guidance-store.js";
import { SupervisorIds } from "../src/ids.js";
import { cutoverNativeThreads, cutoverReport, type CutoverNatives, type CutoverPlan, interpretationCutover, interpretationCutoverPlan,
  interpretationCutoverReason, readCutoverRows, renderCutoverPlan } from "../src/interpretation-cutover.js";
import { InterpretationEvidence, interpretationPlanDigest } from "../src/interpretation-evidence.js";
import { interpretationSourcePin } from "../src/interpretation-submission.js";
import type { WorkflowProposalInfo } from "../src/project-supervisor-contract.js";
import { SupervisorOwnership, type SupervisionStartRecord, type TaskRecord } from "../src/project-supervisor-store.js";
import { SupervisionStoresLive } from "../src/supervision-live.js";
import { createStatus, reportFailure, supervise } from "../src/supervisor.js";
import { prepareWorkflowRequest, workflowInterpretationOutcome } from "../src/supervisor-workflow.js";
import { makeT3Client, T3Client, type T3ClientShape } from "../src/t3.js";
import type { Projection, SupervisorSettings } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import { appendMessageToRun, appendRun, baseTime, definitions, requiredRawPlan, sourceText } from "./support/c1-conversation-fixture.js";
import { dataDirectory } from "./support/g9-stores.js";
import { eventConsole, pinnableClock, rootServices } from "./support/g9-supervisor.js";
import { freePort } from "./support/g8-process.js";

// the one-off interpretation cut-over (plan 3.12 item 11, CT-ISUB-17 and the readiness boundary's frozen-review cases): pre-s6e
// rows written with the raw driver after the production store layers created their tables, the supervisor root served by a
// loopback T3 peer through the real T3 client, and the startup step run over the production store layers; the plan is
// computed by the same pure function the step and the scan use. Deleted with src/interpretation-cutover.ts

const projectId = "project-cutover";
const root = "supervisor-root:cutover";
// text that may never reach a report, log line or scan: prompt and answer bodies, introduction bodies
const promptBody = "OLD JSON-ONLY INTERPRETATION PROMPT PRIVATE-PROMPT-BODY";
const introductionBody = "PRIVATE-INTRODUCTION-BODY of the operative introduction";
const objective = "Implement the export workflow";
const reason = "The user asked for the export workflow.";

// ---- pre-s6e rows

const task = (name: string, overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: `task-${name}`, threadId: `main-${name}`, projectId, sourceRunId: `source-run-${name}`, sourceMessageId: `source-${name}`, sourceOrdinal: 3,
  sourceHash: fingerprint(sourceText), status: "inferred", objective, reason, updatedAt: baseTime, requestText: "", supervisorThreadId: root,
  messageId: `supervisor-objective:task-${name}`, dispatchedAt: baseTime - 10_000, replayCount: 0, supervisorRunId: `interpretation-run-${name}`, ...overrides,
});

// the old final-chat answer of a task in a definition context and the interpretation its old parser produced from it
const interpreted = (base: TaskRecord, snapshot = definitions(), rawWorkflow: unknown = requiredRawPlan()) => {
  const context = prepareWorkflowRequest(base.threadId, base.sourceMessageId, sourceText, {...snapshot, threadId: base.threadId}).context;
  assert.ok(context);
  const answer = JSON.stringify({objective, reason, sourceMessageIds: [base.sourceMessageId], supervision: "needed", workflow: rawWorkflow});
  const outcome = workflowInterpretationOutcome({objective, reason}, "needed", rawWorkflow, context);
  assert.ok(outcome.ok);
  return {answer, task: {...base, definitionContext: context, workflow: outcome.value.workflow, workflowProposalId: base.id}};
};
// the provisional fixture of supervisor-conversation.test.ts:2482: an invalid definition source and an unknown requirement
const provisionalSnapshot = () => ({...definitions(), status: "invalid" as const, revision: "invalid-observation-revision", projectConfig: null,
  issues: [{path: ".t3-supervisor/project.yaml", code: "project_configuration_invalid", message: "Repair the local configuration."}]});
const provisionalRaw = {requirements: [{kind: "step", id: "test-plan", applies: "unknown", reason: "The effective project configuration is incomplete."}],
  plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "bounded-review", name: "Review available context",
    description: "State unknown obligations.", reason: "Continue with finite planning."}]}};

const introduction = (base: TaskRecord, state: string, extra: Record<string, unknown> = {}) => ({taskId: base.id, projectId, threadId: base.threadId,
  supervisorThreadId: root, state, text: introductionBody, messageId: `supervisor-introduction:${base.id}`, targetRunId: null, error: null, ...extra});
const legacyCandidate = (base: TaskRecord, proposalId: string, workflow: WorkflowProposalInfo, message: {id: string; runId: string; ordinal: number; text: string},
  extra: Record<string, unknown> = {}) => ({taskId: base.id, projectId, proposalId, compact: true, ...extra, planHash: `digest-${proposalId}`,
  workflow: {...workflow, status: "proposed"}, supervisorMessageId: message.id, supervisorRunId: message.runId, supervisorRunOrdinal: message.ordinal,
  supervisorTextHash: fingerprint(message.text), proposedAt: baseTime + 100});

type Scenario = {
  readonly tasks: ReadonlyArray<TaskRecord>;
  readonly starts: ReadonlyArray<SupervisionStartRecord>;
  readonly candidates: ReadonlyArray<Record<string, unknown>>;
  readonly introductions: ReadonlyArray<Record<string, unknown>>;
  readonly projection: Projection;
};

const rootProjection = (): Projection => ({thread: {id: root, title: "Supervisor", projectId, lineage: {parentThreadId: null, relationshipToParent: null}},
  runs: [], messages: [], nodes: [], providerTurns: [], turnItems: []});
// the old-prompt request's native run on the root, with its completed answer when it has one
const interpretationRun = (projection: Projection, base: TaskRecord, ordinal: number, status: string, answer?: string) => {
  const run = appendRun({projection, id: base.supervisorRunId ?? `run-${base.id}`, ordinal, status, messageId: base.messageId, text: promptBody,
    createdBy: "system", creationSource: "server", now: baseTime + ordinal * 1_000});
  const message = answer === undefined ? null : appendMessageToRun(projection, run, {id: `answer-${base.id}`, role: "assistant", text: answer, now: baseTime + ordinal * 1_000 + 1});
  return {run, message};
};

/**
 * Every pre-s6e state the cut-over handles, on one root: an in-flight old-prompt attempt (`inflightRun`) with a pending Start,
 * a formal interpretation with its candidate, a later proposal and an accepted agreement, a formal one whose answer changed
 * since, the candidate-free provisional fixture with a ready, sent, accepted and unknown introduction and one whose answer
 * changed, an unsent prepared old-prompt request, and an unrelated settled task.
 */
const scenario = (inflightRun: "running" | "completed" | "absent"): Scenario => {
  const projection = rootProjection();
  const inflight = task("inflight", {status: "waiting", objective: null, reason: "T3 accepted the interpretation request; waiting for its result.",
    requestText: promptBody, supervisorRunId: null, workflow: {...interpreted(task("inflight")).task.workflow, status: "pending"}});
  if (inflightRun !== "absent") interpretationRun(projection, {...inflight, supervisorRunId: "interpretation-run-inflight"}, 1, inflightRun,
    inflightRun === "completed" ? JSON.stringify({objective, reason, sourceMessageIds: [inflight.sourceMessageId], startRequested: true}) : undefined);
  const formal = interpreted(task("formal"));
  const formalAnswer = interpretationRun(projection, formal.task, 2, "completed", formal.answer).message!;
  const formalTask: TaskRecord = {...formal.task, agreement: {status: "agreed", message: "Agreed.", proposalId: formal.task.id, agreedAt: baseTime + 500,
    supervisorMessageId: formalAnswer.id, agentMessageId: "operative-acceptance-formal", workflow: {...formal.task.workflow!, status: "proposed"}}};
  const later = appendMessageToRun(projection, projection.runs.find((run) => run.id === formal.task.supervisorRunId)!,
    {id: "later-proposal-formal", role: "assistant", text: "```workflow-proposal\n{}\n```", now: baseTime + 2_500});
  const changed = interpreted(task("changed"));
  const changedAnswer = interpretationRun(projection, changed.task, 3, "completed", changed.answer.replace(objective, "Implement another workflow")).message!;
  const changedTask: TaskRecord = {...changed.task, agreement: {status: "agreed", message: "Agreed.", proposalId: changed.task.id, agreedAt: baseTime + 500,
    supervisorMessageId: changedAnswer.id, agentMessageId: "operative-acceptance-changed", workflow: {...changed.task.workflow!, status: "proposed"}}};
  const states = [["ready", "ready", {}], ["sent", "sent", {commandId: "command-sent", dispatchMode: {type: "queue_after_active"}, acceptedAt: baseTime + 700}],
    ["accepted", "accepted", {commandId: "command-accepted", dispatchMode: {type: "queue_after_active"}, acceptedAt: baseTime + 700}],
    ["unknown", "uncertain", {commandId: "command-unknown", dispatchMode: {type: "queue_after_active"}}]] as const;
  const provisional = states.map(([name, state, extra], index) => {
    const value = interpreted(task(`provisional-${name}`), provisionalSnapshot(), provisionalRaw);
    assert.equal(value.task.workflow?.status, "provisional");
    interpretationRun(projection, value.task, 4 + index, "completed", value.answer);
    return {task: {...value.task, protocolAnchor: {supervisorThreadId: root, sourceHash: value.task.sourceHash, promptMessageId: value.task.messageId}},
      introduction: introduction(value.task, state, extra)};
  });
  const stale = interpreted(task("provisional-stale"), provisionalSnapshot(), provisionalRaw);
  interpretationRun(projection, stale.task, 8, "completed", stale.answer.replace("Review available context", "Review something else"));
  const queued = task("queued", {status: "queued", objective: null, reason: "Waiting for the project Supervisor.", requestText: promptBody, dispatchedAt: null,
    supervisorRunId: null, definitionContext: interpreted(task("queued")).task.definitionContext, definitionReadAttempts: 1});
  const settled = task("settled", {status: "not_supervised", reason: "Supervision is not needed.", supervisorRunId: "interpretation-run-settled"});
  return {
    tasks: [inflight, formalTask, changedTask, ...provisional.map((item) => item.task), stale.task, queued, settled],
    starts: [{threadId: inflight.threadId, projectId, operationId: "start-operation-inflight", requestHash: "start-hash", route: "agent", status: "pending",
      reason: "Waiting for the interpretation.", intentAt: baseTime, modeGeneration: 1, masterGeneration: 1, taskId: inflight.id,
      source: {messageId: inflight.sourceMessageId, runId: inflight.sourceRunId, ordinal: inflight.sourceOrdinal, hash: inflight.sourceHash}},
    {threadId: settled.threadId, projectId, operationId: "start-operation-settled", requestHash: "start-hash", route: "ui", status: "active",
      reason: "Supervision started.", intentAt: baseTime, modeGeneration: 1, masterGeneration: 1, taskId: settled.id}],
    candidates: [
      legacyCandidate(formal.task, formal.task.id, formal.task.workflow!, {id: formalAnswer.id, runId: formalAnswer.runId!, ordinal: 2, text: formal.answer},
        {interpretation: true, agentMessageId: "operative-acceptance-formal", agentTextHash: "acceptance-hash"}),
      legacyCandidate(formal.task, "proposal-later", formal.task.workflow!, {id: later.id, runId: later.runId!, ordinal: 2, text: later.text}),
      legacyCandidate(changed.task, changed.task.id, changed.task.workflow!, {id: changedAnswer.id, runId: changedAnswer.runId!, ordinal: 3, text: changed.answer},
        {interpretation: true, agentMessageId: "operative-acceptance-changed", agentTextHash: "acceptance-hash"}),
    ],
    introductions: [...provisional.map((item) => item.introduction), introduction(stale.task, "ready"), introduction(formal.task, "sent", {commandId: "command-formal"})],
    projection,
  };
};

// ---- the data directory

// the tables of a run that opened its stores (the production layers, closed again), then the pre-s6e rows through the raw driver
const stores = (directory: string) => WorkflowStateStore.layer.pipe(
  Layer.provideMerge(SupervisionStoresLive), Layer.provideMerge(GuidanceStore.layer), Layer.provideMerge(guidanceDbLayer(directory)),
  Layer.provide(Layer.mergeAll(SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer)), SupervisorOwnership.layer, NodeFileSystem.layer)));
const seeded = (prefix: string, value: Scenario) => Effect.gen(function* () {
  const directory = yield* dataDirectory(prefix);
  yield* Effect.scoped(Layer.build(stores(directory)));
  const db = new DatabaseSync(join(directory, "guidance.sqlite3"));
  try {
    const insert = (statement: string, ...values: Array<string | number>) => db.prepare(statement).run(...values);
    // the environment the deployment runs against is already bound
    insert("INSERT INTO meta VALUES(?,?)", "environment", "cutover-environment");
    insert("INSERT INTO supervisor_owned_threads VALUES(?)", root);
    insert("INSERT INTO supervisor_main_bindings VALUES(?,?,?)", projectId, "main-formal", JSON.stringify({projectId, mainThreadId: "main-formal", threadId: root,
      generation: 1, state: "ready", title: "Formal", enableAfterSequence: 0, initialModel: {instanceId: "codex", model: "gpt-6-luna", options: []}}));
    for (const value_ of value.tasks) insert("INSERT INTO supervisor_task_interpretations VALUES(?,?,?,?)", value_.threadId, projectId, JSON.stringify(value_), value_.updatedAt);
    for (const start of value.starts) {
      insert("INSERT INTO meta VALUES(?,?)", `supervisor_start:${start.threadId}`, JSON.stringify(start));
      insert("INSERT INTO meta VALUES(?,?)", `supervisor_start_operation:${JSON.stringify([start.threadId, start.operationId])}`,
        JSON.stringify({threadId: start.threadId, operationId: start.operationId, requestHash: start.requestHash, status: start.status, reason: start.reason}));
    }
    for (const candidate of value.candidates) insert("INSERT INTO supervisor_workflow_agreement_candidates VALUES(?,?,?,?,?)", candidate.taskId as string,
      candidate.proposalId as string, projectId, JSON.stringify(candidate), candidate.proposedAt as number);
    for (const item of value.introductions) insert("INSERT INTO supervisor_workflow_introductions VALUES(?,?,?)", item.taskId as string, projectId, JSON.stringify(item));
    insert("INSERT INTO supervisor_conversation_requests VALUES(?,?,?,?)", "request-kept", projectId, JSON.stringify({id: "request-kept", projectId,
      supervisorThreadId: root, kind: "review", taskId: null, text: "PRIVATE-REVIEW-BODY", messageId: "supervisor-review:request-kept", state: "uncertain",
      batch: null, createdAt: baseTime, sentAt: baseTime, runId: null, error: null, completionMarker: "marker"}), baseTime);
    // a workflow receipt whose native outcome is unknown
    insert("INSERT INTO supervisor_workflow_operations VALUES(?,?,?,?,?,?,?,?,?,?)", projectId, "main-formal", root, 1, "workflow", "operation-unknown",
      "request-hash", JSON.stringify({status: "uncertain", workflowId: "workflow-formal"}), "workflow-formal", baseTime);
  } finally {db.close();}
  return directory;
});

// every row of every table, by table, in rowid order
const rows = (directory: string): Record<string, Array<Record<string, unknown>>> => {
  const db = new DatabaseSync(join(directory, "guidance.sqlite3"), {readOnly: true});
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => String(row.name));
    return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT rowid AS _rowid, * FROM "${table}" ORDER BY rowid`).all().map((row) => ({...row}))]));
  } finally {db.close();}
};
const documentOf = (dump: ReturnType<typeof rows>, table: string, column: string, key: Record<string, string>) => {
  const row = dump[table]!.find((item) => Object.entries(key).every(([name, value]) => item[name] === value));
  return row === undefined ? undefined : row[column] as string;
};

// ---- the native peer: the supervisor root's projection over real HTTP; every request is recorded

type Peer = {readonly url: string; readonly requests: Array<string>; readonly serve: (projection: Projection) => void; readonly onRead: (hook: () => void) => void};
const nativePeer = (initial: Projection) => Effect.acquireRelease(Effect.gen(function* () {
  let projection = initial;
  let hook: (() => void) | undefined;
  const requests: Array<string> = [];
  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(`${request.method} ${request.url}`);
    const send = (status: number, value: unknown) => {response.writeHead(status, {"content-type": "application/json"});response.end(JSON.stringify(value));};
    if (request.method === "GET" && request.url === "/.well-known/t3/environment") return send(200, {environmentId: "cutover-environment", orchestrationProtocolVersion: 2, serverVersion: "cutover"});
    if (request.method === "GET" && request.url === `/api/orchestration/threads/${encodeURIComponent(root)}`) {
      hook?.();
      return send(200, {snapshotSequence: 1, projection});
    }
    send(404, {});
  });
  http.on("upgrade", (request: IncomingMessage, socket) => {requests.push(`UPGRADE ${request.url}`);socket.destroy();});
  yield* Effect.callback<void>((resume) => {http.listen(0, "127.0.0.1", () => resume(Effect.void));});
  const address = http.address();
  assert.ok(address && typeof address === "object");
  return {http, peer: {url: `http://127.0.0.1:${address.port}`, requests, serve: (next: Projection) => {projection = next;}, onRead: (next: () => void) => {hook = next;}} satisfies Peer};
}), ({http}) => Effect.callback<void>((resume) => {http.closeAllConnections();http.close(() => resume(Effect.void));})).pipe(Effect.map(({peer}) => peer));
const readToken = "cutover-read-token";
const client = (peer: Peer) => Effect.map(Layer.build(makeT3Client({baseUrl: peer.url, token: readToken})), (context) => Context.get(context, T3Client));
const nativeReadsOnly = (peer: Peer) => assert.deepEqual([...new Set(peer.requests)], [`GET /api/orchestration/threads/${encodeURIComponent(root)}`],
  "only read-only projection reads of the root reached T3; nothing was sent");

// the plan of the directory's rows against the peer's current projection, at `now`
const storedRows = (directory: string) => Effect.scoped(Effect.gen(function* () {
  const db = Context.get(yield* Layer.build(guidanceDbLayer(directory).pipe(Layer.provide(NodeFileSystem.layer))), GuidanceDb);
  return yield* Effect.provideService(readCutoverRows, GuidanceDb, db);
}));
const planOf = (directory: string, projection: Projection, now: number) => Effect.gen(function* () {
  const stored = yield* storedRows(directory);
  const natives: CutoverNatives = new Map(cutoverNativeThreads(stored).map((thread) => [thread, thread === root ? {status: "read" as const, projection} : {status: "missing" as const}]));
  return interpretationCutoverPlan(stored, natives, now);
});

// the startup step over the production store layers of the directory (a restart), with the real T3 client and a fixed wall clock
const cutoverStep = (directory: string, t3: T3ClientShape, now: number) => Effect.gen(function* () {
  const {console, events} = yield* eventConsole();
  const {clock: fixed, pin} = yield* pinnableClock;
  yield* pin(now);
  const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
    const context = yield* Layer.build(stores(directory));
    return yield* interpretationCutover(t3).pipe(Effect.provide(context));
  })).pipe(Effect.provideService(Console.Console, console), Effect.provideService(Clock.Clock, fixed)));
  return {exit, events: events.filter((event) => String(event.event).startsWith("interpretation_cutover"))};
});

const deepFreeze = <A>(value: A): A => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
};
const at = baseTime + 60_000;

// ---- the cases

it.live("the plan is pure: identical inputs give an identical plan, frozen inputs are never mutated, and it lists every state with its outcome", () => Effect.gen(function* () {
  const value = scenario("completed");
  const directory = yield* seeded("cutover-plan-", value);
  const plan = yield* planOf(directory, value.projection, at);
  const stored = deepFreeze(yield* storedRows(directory));
  const natives = deepFreeze(new Map([[root, {status: "read" as const, projection: deepFreeze(structuredClone(value.projection))}]]));
  assert.deepEqual(interpretationCutoverPlan(stored, natives, at), interpretationCutoverPlan(stored, natives, at));
  assert.deepEqual(interpretationCutoverPlan(stored, natives, at), plan);
  assert.deepEqual(cutoverReport(plan), {
    inflight: [{taskId: "task-inflight", threadId: "main-inflight", supervisorThreadId: root, messageId: "supervisor-objective:task-inflight", status: "waiting",
      runId: "interpretation-run-inflight", runStatus: "completed", outcome: "close"}],
    starts: [{threadId: "main-inflight", operationId: "start-operation-inflight", taskId: "task-inflight", outcome: "reject"}],
    candidates: [
      {taskId: "task-changed", proposalId: "task-changed", kind: "interpretation", agreed: true, outcome: "stale", reason: "text_changed"},
      {taskId: "task-formal", proposalId: "proposal-later", kind: "proposal", agreed: false, outcome: "convert", reason: "proposal_record"},
      {taskId: "task-formal", proposalId: "task-formal", kind: "interpretation", agreed: true, outcome: "convert", reason: "message_matches"},
    ],
    candidateFree: [
      {taskId: "task-provisional-accepted", threadId: "main-provisional-accepted", workflowStatus: "provisional", introductionState: "accepted", outcome: "record", reason: "answer_matches"},
      {taskId: "task-provisional-ready", threadId: "main-provisional-ready", workflowStatus: "provisional", introductionState: "ready", outcome: "record", reason: "answer_matches"},
      {taskId: "task-provisional-sent", threadId: "main-provisional-sent", workflowStatus: "provisional", introductionState: "sent", outcome: "record", reason: "answer_matches"},
      {taskId: "task-provisional-stale", threadId: "main-provisional-stale", workflowStatus: "provisional", introductionState: "ready", outcome: "stale", reason: "answer_missing"},
      {taskId: "task-provisional-unknown", threadId: "main-provisional-unknown", workflowStatus: "provisional", introductionState: "uncertain", outcome: "record", reason: "answer_matches"},
    ],
    queued: [{taskId: "task-queued", threadId: "main-queued"}],
    blockers: [],
    writes: 11,
  });
  const report = renderCutoverPlan(cutoverReport(plan)).join("\n");
  for (const secret of [promptBody, introductionBody, objective, "PRIVATE"]) assert.equal(report.includes(secret), false, "identities, counts and reasons only");
}), {timeout: 30_000});

it.live("blocker: an old-prompt attempt whose run is not terminal blocks; the step refuses with the fixed reason, logged once with identities, every row stays byte-identical and nothing is sent", () => Effect.gen(function* () {
  for (const inflightRun of ["running", "absent"] as const) {
    const value = scenario(inflightRun);
    const directory = yield* seeded(`cutover-blocker-${inflightRun}-`, value);
    const before = rows(directory);
    const plan = yield* planOf(directory, value.projection, at);
    assert.deepEqual(plan.blockers, [{code: "run_not_terminal", ids: {taskId: "task-inflight", threadId: "main-inflight", supervisorThreadId: root,
      runId: inflightRun === "running" ? "interpretation-run-inflight" : null}}]);
    assert.deepEqual(plan.starts, [{threadId: "main-inflight", operationId: "start-operation-inflight", taskId: "task-inflight", outcome: "held"}]);
    assert.deepEqual(plan.writes, [], "a blocking plan applies nothing");
    const peer = yield* nativePeer(value.projection);
    const {exit, events} = yield* cutoverStep(directory, yield* client(peer), at);
    assert.ok(Exit.isFailure(exit));
    const refused = Cause.squash(exit.cause);
    assert.ok(refused instanceof InterpretationCutoverRefused);
    assert.equal(refused.reason, "interpretation_cutover_blocked");
    assert.deepEqual(rows(directory), before, "task, request, receipt, candidate, introduction and Start rows are byte-identical");
    nativeReadsOnly(peer);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, "interpretation_cutover_refused");
    assert.equal(events[0]!.reason, "interpretation_cutover_blocked");
    assert.equal(events[0]!.identities, `run_not_terminal taskId=task-inflight threadId=main-inflight supervisorThreadId=${root} runId=${inflightRun === "running" ? "interpretation-run-inflight" : "-"}`);
    assert.equal(JSON.stringify(events).includes("PRIVATE"), false);
  }
}), {timeout: 60_000});

it.live("refusal: the supervisor run logs the refusal once and ends with its fixed classified reason, with no partial apply and no restart of supervision", () => Effect.gen(function* () {
  const value = scenario("running");
  const directory = yield* seeded("cutover-refusal-", value);
  const before = rows(directory);
  const peer = yield* nativePeer(value.projection);
  const tokenFile = join(directory, "read-token");
  yield* FileSystem.FileSystem.use((fs) => fs.writeFileString(tokenFile, `${readToken}\n`)).pipe(Effect.provide(NodeFileSystem.layer));
  const settings: SupervisorSettings = {dataDirectory: directory, t3Url: peer.url, t3TokenFile: tokenFile, excludedThreadIds: [], healthPort: 0,
    uiPort: yield* freePort, uiHost: "127.0.0.1"};
  const status = yield* SubscriptionRef.make(createStatus(settings, yield* Clock.currentTimeMillis));
  const {console, events} = yield* eventConsole();
  const started = yield* Clock.currentTimeMillis;
  // the program as src/main.ts runs it: the run over its root services, its failure reported by one classified line
  const exit = yield* Effect.exit(supervise(rootServices(settings, status, yield* client(peer))).pipe(Effect.tapCause(reportFailure),
    Effect.provideService(Console.Console, console), Effect.timeout("20 seconds")));
  const elapsed = (yield* Clock.currentTimeMillis) - started;
  assert.ok(Exit.isFailure(exit));
  assert.equal(failureReason(exit.cause), "interpretation_cutover_blocked");
  assert.ok(elapsed < 10_000, `the run ended at once (${elapsed} ms), before the 10 s supervision restart`);
  const names = events.map((event) => event.event);
  assert.equal(names.filter((name) => name === "interpretation_cutover_refused").length, 1, "the refusal is logged once");
  assert.equal(names.includes("supervision_unavailable"), false, "supervision is not restarted");
  assert.deepEqual(events.filter((event) => event.event === "supervisor_failed").map((event) => event.reason), ["interpretation_cutover_blocked"]);
  assert.deepEqual(rows(directory), before, "no partial apply");
  assert.equal(peer.requests.some((request) => !request.startsWith("GET ") && !request.startsWith("UPGRADE ")), false, "nothing was sent");
}), {timeout: 60_000});

it.live("CT-ISUB-17: after its run ends the in-flight request closes unapplied without a re-send and its pending Start is rejected; the apply writes exactly the plan, preserves every other row, and a restart finds nothing to apply", () => Effect.gen(function* () {
  const running = scenario("running");
  const directory = yield* seeded("cutover-apply-", running);
  const peer = yield* nativePeer(running.projection);
  const t3 = yield* client(peer);
  // while the old-prompt run is active the step refuses and changes nothing
  const original = rows(directory);
  assert.ok(Exit.isFailure((yield* cutoverStep(directory, t3, at)).exit));
  assert.deepEqual(rows(directory), original);
  // its run ends: the same rows now plan the closure
  const ended = scenario("completed").projection;
  peer.serve(ended);
  const plan: CutoverPlan = yield* planOf(directory, ended, at);
  assert.deepEqual(plan.blockers, []);
  const {exit, events} = yield* cutoverStep(directory, t3, at);
  assert.ok(Exit.isSuccess(exit));
  const after = rows(directory);
  nativeReadsOnly(peer);

  // plan == apply: each planned row holds exactly the planned document, and nothing else changed
  const planned = new Set<string>();
  for (const write of plan.writes) {
    if (write.kind === "task") {
      planned.add(`task ${write.task.threadId}`);
      assert.equal(documentOf(after, "supervisor_task_interpretations", "document", {thread_id: write.task.threadId}), JSON.stringify(write.task));
    } else if (write.kind === "start") {
      planned.add(`start ${write.start.threadId}`);
      assert.equal(documentOf(after, "meta", "value", {key: `supervisor_start:${write.start.threadId}`}), JSON.stringify(write.start));
    } else {
      planned.add(`candidate ${write.taskId} ${write.proposalId}`);
      assert.equal(documentOf(after, "supervisor_workflow_agreement_candidates", "document", {task_id: write.taskId, proposal_id: write.proposalId}), write.document);
    }
  }
  const unplanned = (dump: ReturnType<typeof rows>) => Object.fromEntries(Object.entries(dump).map(([table, items]) => [table, items.filter((row) =>
    !(table === "supervisor_task_interpretations" && planned.has(`task ${String(row.thread_id)}`)) &&
    !(table === "meta" && (planned.has(`start ${String(row.key).replace("supervisor_start:", "")}`) || String(row.key).startsWith("supervisor_start_operation:[\"main-inflight\"")) ) &&
    !(table === "supervisor_workflow_agreement_candidates" && planned.has(`candidate ${String(row.task_id)} ${String(row.proposal_id)}`)))]));
  assert.deepEqual(unplanned(after), unplanned(original), "histories, bindings, introductions, requests, receipts and settled tasks are unchanged");
  for (const table of ["supervisor_workflow_introductions", "supervisor_conversation_requests", "supervisor_workflow_operations", "supervisor_main_bindings", "supervisor_owned_threads"])
    assert.deepEqual(after[table], original[table], `${table} kept byte for byte`);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {...events[0], event: "interpretation_cutover_applied", closed: 1, startsRejected: 1, candidatesConverted: 2, candidatesStale: 1,
    evidenceRecorded: 4, evidenceStale: 1, requestsPreparedAgain: 1, rows: 11});

  const taskOf = (threadId: string) => JSON.parse(documentOf(after, "supervisor_task_interpretations", "document", {thread_id: threadId})!) as TaskRecord;
  const before = (threadId: string) => running.tasks.find((item) => item.threadId === threadId)!;
  // the in-flight request closes unapplied under its original identities; its request text is kept as sent
  const closed = taskOf("main-inflight");
  assert.deepEqual(closed, {...before("main-inflight"), status: "unavailable", objective: null, reason: interpretationCutoverReason, supervisorRunId: "interpretation-run-inflight",
    workflow: {...before("main-inflight").workflow!, status: "unavailable", message: interpretationCutoverReason}, updatedAt: at});
  assert.equal(closed.messageId, "supervisor-objective:task-inflight");
  assert.equal(closed.requestText, promptBody);
  const rejected = JSON.parse(documentOf(after, "meta", "value", {key: "supervisor_start:main-inflight"})!) as SupervisionStartRecord;
  assert.deepEqual(rejected, {...running.starts[0], status: "rejected", reason: interpretationCutoverReason});
  assert.deepEqual(JSON.parse(documentOf(after, "meta", "value", {key: `supervisor_start_operation:${JSON.stringify(["main-inflight", "start-operation-inflight"])}`})!),
    {threadId: "main-inflight", operationId: "start-operation-inflight", requestHash: "start-hash", status: "rejected", reason: interpretationCutoverReason});

  // retained candidates: the matching initial candidate and its accepted agreement stay valid by hash with their existing ids,
  // the mismatching one is marked stale and kept, and the later proposal only changes format
  const candidate = (taskId: string, proposalId: string) => JSON.parse(documentOf(after, "supervisor_workflow_agreement_candidates", "document", {task_id: taskId, proposal_id: proposalId})!) as Record<string, unknown>;
  const legacy = (taskId: string, proposalId: string) => running.candidates.find((item) => item.taskId === taskId && item.proposalId === proposalId)!;
  for (const [taskId, proposalId, stale] of [["task-formal", "task-formal", false], ["task-formal", "proposal-later", false], ["task-changed", "task-changed", true]] as const) {
    const {supervisorMessageId, supervisorRunId, supervisorRunOrdinal, supervisorTextHash, ...kept} = legacy(taskId, proposalId);
    assert.deepEqual(candidate(taskId, proposalId), {...kept, evidence: {kind: "supervisor_message", messageId: supervisorMessageId, runId: supervisorRunId,
      runOrdinal: supervisorRunOrdinal, textHash: supervisorTextHash, ...(stale ? {stale: true} : {})}});
    assert.ok(Schema.is(InterpretationEvidence)(candidate(taskId, proposalId).evidence));
  }
  assert.deepEqual(taskOf("main-formal").agreement, before("main-formal").agreement, "the accepted agreement is kept");
  assert.deepEqual(taskOf("main-changed"), before("main-changed"), "a mismatching agreement is marked stale by the normal path, as the baseline did, never deleted here");

  // candidate-free provisional interpretations keep provisional status and gain current (or stale) evidence; their
  // introductions keep their exact ids, body and route
  for (const name of ["ready", "sent", "accepted", "unknown", "stale"]) {
    const threadId = `main-provisional-${name}`;
    const prior = before(threadId);
    const answer = running.projection.messages.find((message) => message.id === `answer-${prior.id}`)!;
    const recorded = taskOf(threadId);
    assert.deepEqual(recorded, {...prior, interpretationEvidence: {kind: "supervisor_message", messageId: answer.id, runId: prior.supervisorRunId,
      runOrdinal: running.projection.runs.find((run) => run.id === prior.supervisorRunId)!.ordinal, textHash: fingerprint(answer.text),
      planDigest: interpretationPlanDigest(prior.workflow), sourcePin: interpretationSourcePin(prior), ...(name === "stale" ? {stale: true} : {})}});
    assert.equal(recorded.workflow?.status, "provisional");
    assert.equal(recorded.attempt, undefined, "no typed receipt, attempt or candidate is invented");
    assert.equal(documentOf(after, "supervisor_workflow_agreement_candidates", "document", {task_id: prior.id}), undefined);
  }
  // the unsent old-prompt request is prepared again under the typed protocol
  const refreshed = taskOf("main-queued");
  assert.equal(refreshed.status, "queued");
  assert.equal(refreshed.requestText, "");
  assert.equal(refreshed.definitionContext, undefined);
  assert.equal(refreshed.messageId, before("main-queued").messageId);

  // a restart finds nothing to apply and changes nothing
  const second = yield* cutoverStep(directory, t3, at + 1_000);
  assert.ok(Exit.isSuccess(second.exit));
  assert.deepEqual(second.events, [], "nothing to apply starts the run silently");
  assert.deepEqual(rows(directory), after);
  const replanned = yield* planOf(directory, ended, at + 1_000);
  assert.deepEqual({...cutoverReport(replanned)}, {inflight: [], starts: [], candidates: [], candidateFree: [], queued: [], blockers: [], writes: 0});
  nativeReadsOnly(peer);
}), {timeout: 60_000});

it.live("conflict: rows that change between the plan and the commit refuse with the fixed conflict reason and the transaction applies nothing", () => Effect.gen(function* () {
  const value = scenario("completed");
  const directory = yield* seeded("cutover-conflict-", value);
  const peer = yield* nativePeer(value.projection);
  // another writer changes a task while the step reads the native evidence
  peer.onRead(() => {
    const db = new DatabaseSync(join(directory, "guidance.sqlite3"));
    try {db.prepare("UPDATE supervisor_task_interpretations SET document=json_set(document,'$.reason','Changed meanwhile.') WHERE thread_id='main-settled'").run();} finally {db.close();}
  });
  const {exit, events} = yield* cutoverStep(directory, yield* client(peer), at);
  peer.onRead(() => {});
  assert.ok(Exit.isFailure(exit));
  const refused = Cause.squash(exit.cause);
  assert.ok(refused instanceof InterpretationCutoverRefused);
  assert.equal(refused.reason, "interpretation_cutover_conflict");
  assert.deepEqual(events.map((event) => [event.event, event.reason]), [["interpretation_cutover_refused", "interpretation_cutover_conflict"]]);
  const after = rows(directory);
  for (const item of value.tasks) assert.equal(documentOf(after, "supervisor_task_interpretations", "document", {thread_id: item.threadId}),
    JSON.stringify(item.threadId === "main-settled" ? {...item, reason: "Changed meanwhile."} : item), "only the other writer's change is stored");
  for (const item of value.candidates) assert.equal(documentOf(after, "supervisor_workflow_agreement_candidates", "document",
    {task_id: item.taskId as string, proposal_id: item.proposalId as string}), JSON.stringify(item));
}), {timeout: 60_000});
