import { Effect, Exit, Schema } from "effect";
import type { GuidanceDb } from "./db.js";
import { timestampMs } from "./domain.js";
import { GuidanceStoreError, guidanceSql, type SupervisionStoreError } from "./guidance-sql.js";
import { fingerprint } from "./guidance-store.js";
import { interpretationPlanDigest, type InterpretationSubmissionEvidence } from "./interpretation-evidence.js";
import {
  InterpretationAttemptId,
  InterpretationAttemptKey,
  interpretationAttemptGate,
  InterpretationPayload,
  interpretationSourcePin,
  InterpretationProofReference,
  type InterpretationAttempt,
  type InterpretationEnvelope,
  type InterpretationSubmitResult,
} from "./interpretation-submission.js";
import { interpretationLimits } from "./supervisor-workflow.js";
import { isSupervisorThread, type BindingRecord, type ProjectSupervisorStore, type SupervisionStartRecord, type TaskRecord } from "./project-supervisor-store.js";
import type { GateGuard, SupervisionScope } from "./supervision-gate.js";
import { projectRequesterPolicy, taskRequester, type TaskRequesterPolicy } from "./task-requester.js";
import type { Projection, ThreadInfo } from "./types.js";
import { canonicalJson, isRecord, workflowRequestHash, workflowToolInputMaxBytes } from "./workflow-write-evidence.js";
import type { WorkflowOwner } from "./workflow-state-contract.js";

// the typed interpretation intake and its finalization inputs (plan 3.12 items 5 and 7): the receipt an attempt's first verified
// submission records in the workflow write receipt table (cc-wfreceipt), the source, boundary and Start checks the intake commit
// and the finalization share, and the evidence an applied submission leaves on its task

// the workflow write receipts (cc-wfreceipt): the write controller's table, keyed by owner, generation, namespace and operation
export const workflowWriteReceiptsTable = `CREATE TABLE IF NOT EXISTS supervisor_workflow_write_receipts (
        operation_id TEXT NOT NULL,
        operation_namespace TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        main_thread_id TEXT NOT NULL,
        supervisor_thread_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,main_thread_id,supervisor_thread_id,binding_generation,operation_namespace,operation_id)
      )`;
// the namespace of an interpretation receipt; its operation id is the attempt id and its request hash the raw-argument hash
export const interpretationReceiptNamespace = "interpretation";

// one recorded submission, immutable once committed: the attempt and its key, whether its arguments carried the pending-Start
// verdict, the complete raw arguments in canonical form with their hash, the decoded payload and the native proof reference
export const InterpretationReceipt = Schema.Struct({
  kind: Schema.Literal("interpretation_submission"),
  attemptId: InterpretationAttemptId,
  attempt: InterpretationAttemptKey,
  startVerdict: Schema.Boolean,
  argumentsCanonical: Schema.String,
  argumentsHash: Schema.String,
  payload: InterpretationPayload,
  proof: InterpretationProofReference,
  recordedAt: Schema.Number,
});
export type InterpretationReceipt = typeof InterpretationReceipt.Type;

const ReceiptRow = Schema.Struct({request_hash: Schema.String, result: Schema.String});
const decodeReceiptRow = Schema.decodeUnknownExit(ReceiptRow);
const decodeReceipt = Schema.decodeUnknownExit(Schema.fromJsonString(InterpretationReceipt));
const receiptInvalid = () => new GuidanceStoreError({reason: "row_invalid", row: "interpretation receipt", sqlReason: null});

// the owner of an attempt's receipt: the bound root and binding generation of its scope
export const interpretationReceiptOwner = (binding: Pick<BindingRecord, "projectId" | "mainThreadId" | "threadId" | "generation">): WorkflowOwner =>
  ({projectId: binding.projectId, mainThreadId: binding.mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation});
// the receipt owner of a task's attempt, from the task and the attempt key
export const taskReceiptOwner = (task: TaskRecord, attempt: InterpretationAttempt): WorkflowOwner =>
  ({projectId: task.projectId, mainThreadId: task.threadId, supervisorThreadId: task.supervisorThreadId, bindingGeneration: attempt.key.bindingGeneration});

// the recorded submission of an attempt, or null; a row that does not decode is a typed row error, never an absent receipt
export const readInterpretationReceipt = (sql: GuidanceDb["Service"], owner: WorkflowOwner, attemptId: string):
  Effect.Effect<{readonly requestHash: string; readonly receipt: InterpretationReceipt} | null, GuidanceStoreError> => guidanceSql(Effect.gen(function* () {
  const [row] = yield* sql`SELECT request_hash,result FROM supervisor_workflow_write_receipts WHERE project_id=${owner.projectId} AND main_thread_id=${owner.mainThreadId} AND supervisor_thread_id=${owner.supervisorThreadId} AND binding_generation=${owner.bindingGeneration} AND operation_namespace=${interpretationReceiptNamespace} AND operation_id=${attemptId}`;
  if (row === undefined) return null;
  const decodedRow = decodeReceiptRow(row);
  if (Exit.isFailure(decodedRow)) return yield* receiptInvalid();
  const decoded = decodeReceipt(decodedRow.value.result);
  if (Exit.isFailure(decoded) || decoded.value.attemptId !== attemptId || decoded.value.argumentsHash !== decodedRow.value.request_hash) return yield* receiptInvalid();
  return {requestHash: decodedRow.value.request_hash, receipt: decoded.value};
}));

// inside the intake's transaction: the write-once receipt of the attempt's first verified submission
const recordInterpretationReceipt = (sql: GuidanceDb["Service"], owner: WorkflowOwner, receipt: InterpretationReceipt, now: number) =>
  guidanceSql(Effect.asVoid(sql`INSERT INTO supervisor_workflow_write_receipts(operation_id,operation_namespace,request_hash,project_id,main_thread_id,supervisor_thread_id,binding_generation,result,created_at) VALUES(${receipt.attemptId},${interpretationReceiptNamespace},${receipt.argumentsHash},${owner.projectId},${owner.mainThreadId},${owner.supervisorThreadId},${owner.bindingGeneration},${JSON.stringify(receipt)},${now})`));

// the complete raw arguments' canonical form and hash within the tool input bounds, for a submission decided by its raw form alone
export type RawArguments =
  | {readonly ok: true; readonly raw: Readonly<Record<string, unknown>>; readonly canonical: string; readonly hash: string}
  | {readonly ok: false; readonly code: "arguments_not_object" | "arguments_not_json" | "arguments_too_deep" | "arguments_too_large"};
export const rawInterpretationArguments = (raw: unknown, withDefinitions: boolean): RawArguments => {
  if (!isRecord(raw)) return {ok: false, code: "arguments_not_object"};
  let canonical: string;
  try {canonical = canonicalJson(raw);} catch (cause) {
    return {ok: false, code: cause instanceof Error && cause.message === "json_depth" ? "arguments_too_deep" : "arguments_not_json"};
  }
  if (canonical.length > (withDefinitions ? interpretationLimits.maxWorkflowInterpretationReplyLength : interpretationLimits.maxInterpretationReplyLength) || Buffer.byteLength(canonical, "utf8") > workflowToolInputMaxBytes)
    return {ok: false, code: "arguments_too_large"};
  return {ok: true, raw, canonical, hash: workflowRequestHash(raw)};
};

// the evidence every applied submission leaves on its task (TaskRecord.interpretationEvidence), pinned to what the task then holds:
// its attempt, its source revision and the digest of the workflow it applied (null without one)
export const interpretationSubmissionEvidence = (task: TaskRecord & {readonly attempt: InterpretationAttempt}, receipt: InterpretationReceipt): InterpretationSubmissionEvidence => ({
  kind: "interpretation_submission", taskId: task.id, attemptId: task.attempt.attemptId, itemId: receipt.proof.itemId, runId: receipt.proof.runId,
  argumentsHash: receipt.argumentsHash, sourcePin: interpretationSourcePin(task), planDigest: interpretationPlanDigest(task.workflow ?? null),
});

// whether a Start is the task's own pending one: its task ID and pinned source revision
export const taskPendingStart = (task: TaskRecord, start: SupervisionStartRecord | null): start is SupervisionStartRecord =>
  start?.status === "pending" && start.taskId === task.id && start.source?.messageId === task.sourceMessageId &&
  start.source.runId === task.sourceRunId && start.source.hash === task.sourceHash;

const unavailableThread = (thread: ThreadInfo) => Boolean(thread.archivedAt || thread.deletedAt);

// the source, boundary and Start checks of an interpretation over the supervision store and the scope predicates: the dispatch,
// the intake commit and the finalization read them inside their admission sections (moved from the project supervisor)
export const interpretationChecks = (store: ProjectSupervisorStore["Service"], scope: SupervisionScope) => {
  // the requesters whose messages may source a task of the project: its human, and with the project setting a launching agent
  const requesterPolicy = (projectId: string): Effect.Effect<TaskRequesterPolicy, SupervisionStoreError> => projectRequesterPolicy(store, projectId);
  // the activation floor of a main: its activation boundary, raised in No Project mode to its mode boundary anchor
  const sourceFloor = (threadId: string, main: Projection): Effect.Effect<number | null, SupervisionStoreError> => Effect.gen(function* () {
    const base = yield* store.baselineOrdinal(threadId, main);
    if (base === null || !(yield* scope.isNoProject(main.thread.projectId ?? ""))) return base;
    const anchor = (yield* store.noProjectControl()).baseline?.threads.find(item => item.id === threadId)?.latestRunId;
    if (!anchor) return base;
    const ordinal = main.runs.find(item => item.id === anchor)?.ordinal;
    return ordinal === undefined ? null : Math.max(base, ordinal);
  });
  // the Start this task answers: active since its intent or still a valid pending one, pinned to the task's source
  const pinnedStart = (job: TaskRecord): Effect.Effect<SupervisionStartRecord | null, SupervisionStoreError> => Effect.gen(function* () {
    const start = yield* store.start(job.threadId);
    return start && (start.status === "active" && !(yield* scope.supervisionStopped(job.threadId)) && (yield* store.chatEnabledAt(job.threadId)) === start.intentAt &&
      start.modeGeneration === (yield* store.noProjectControl()).generation && start.masterGeneration === (yield* store.control(null)).generation || (yield* scope.validPendingStart(start))) &&
      start.taskId === job.id && start.source?.messageId === job.sourceMessageId && start.source.runId === job.sourceRunId && start.source.hash === job.sourceHash ? start : null;
  });
  /** Whether the request is at or before the project/global activation boundary (unknown counts as before) or the chat's latest Enable. */
  const beforeBoundary = (job: TaskRecord, main: Projection): Effect.Effect<boolean, SupervisionStoreError> => Effect.gen(function* () {
    if (yield* pinnedStart(job)) return false;
    const floor = yield* sourceFloor(job.threadId, main), enabledAt = yield* store.chatEnabledAt(job.threadId);
    return floor === null || job.sourceOrdinal <= floor ||
      enabledAt !== null && !((timestampMs(main.messages.find(item => item.id === job.sourceMessageId)?.createdAt) ?? 0) > enabledAt);
  });
  // the task's pinned source is still a genuine visible request of a permitted requester in its main, and the main is still bound
  // to its root; turning the agent-created setting off makes an agent-sourced task no longer current
  const currentSource = (job: TaskRecord, main: Projection): Effect.Effect<boolean, SupervisionStoreError> => Effect.gen(function* () {
    const run = main.runs.find(item => item.id === job.sourceRunId && item.ordinal === job.sourceOrdinal);
    const message = main.messages.find(item => item.id === job.sourceMessageId && item.runId === job.sourceRunId);
    return main.thread.id === job.threadId && main.thread.projectId === job.projectId && !unavailableThread(main.thread) &&
      !isSupervisorThread(scope.owned, main.thread) && (!(yield* scope.supervisionStopped(job.threadId)) || (yield* scope.validPendingStartFor(job.threadId))) &&
      Boolean(message && run && taskRequester(main, run, message, yield* requesterPolicy(job.projectId)) && fingerprint(message.text) === job.sourceHash) &&
      (yield* store.binding(job.projectId, job.threadId))?.threadId === job.supervisorThreadId;
  });
  return {requesterPolicy, sourceFloor, pinnedStart, beforeBoundary, currentSource};
};
export type InterpretationChecks = ReturnType<typeof interpretationChecks>;

// one verified submission ready for its commit: the attempt it answers, its raw form, the decoded envelope and payload (absent for a
// submission decided by its raw form against an existing receipt), the native proof and the main read after the proof
export type InterpretationIntake = {
  readonly owner: WorkflowOwner;
  readonly attempt: InterpretationAttempt;
  readonly argumentsCanonical: string;
  readonly argumentsHash: string;
  readonly decoded: {readonly envelope: InterpretationEnvelope; readonly payload: InterpretationPayload} | null;
  readonly startVerdict: boolean;
  readonly proof: InterpretationProofReference;
  readonly main: Projection;
};

/**
 * The intake commit inside its admission section and one guidance transaction (item 5): the attempt's receipt first, so an
 * identical replay answers its original receipt even after finalization and changed content conflicts; only without a receipt
 * the attempt state gate, the binding, Stop and control, the pinned source, the activation floor and a pending Start's narrow
 * permission, then the write-once receipt. Recording never activates a Start and sends nothing.
 */
export const commitInterpretationSubmission = (input: {
  readonly sql: GuidanceDb["Service"];
  readonly store: ProjectSupervisorStore["Service"];
  readonly scope: SupervisionScope;
  readonly checks: InterpretationChecks;
  readonly guard: GateGuard;
  readonly now: number;
  readonly intake: InterpretationIntake;
}): Effect.Effect<InterpretationSubmitResult, SupervisionStoreError> => Effect.gen(function* () {
  const {sql, store, scope, checks, guard, intake} = input;
  const {owner, attempt} = intake;
  const prior = yield* readInterpretationReceipt(sql, owner, attempt.attemptId);
  if (prior) return prior.requestHash === intake.argumentsHash ? {status: "duplicate", attemptId: prior.receipt.attemptId} : {status: "conflict", code: "attempt_already_recorded"};
  const decoded = intake.decoded;
  if (!decoded) return {status: "unavailable", code: "interpretation_submission_unavailable"};
  const task = yield* store.task(owner.mainThreadId);
  if (!task || task.supervisorThreadId !== owner.supervisorThreadId) return {status: "stale", code: "attempt_not_current"};
  const gate = interpretationAttemptGate(decoded.envelope, {id: task.id, status: task.status, attempt: task.attempt ?? null});
  if (gate.status === "stale") return {status: "stale", code: gate.code};
  if (gate.status === "invalid") return {status: "invalid", code: gate.code, issues: gate.issues};
  const binding = yield* store.binding(owner.projectId, owner.mainThreadId);
  if (!binding || binding.state !== "ready") return {status: "denied", code: "binding_not_ready"};
  if (binding.threadId !== owner.supervisorThreadId || binding.generation !== owner.bindingGeneration) return {status: "denied", code: "binding_generation_mismatch"};
  if ((yield* guard.supervisionStopped(owner.mainThreadId)) && !(yield* scope.validPendingStartFor(owner.mainThreadId))) return {status: "denied", code: "supervision_stopped"};
  if (!(yield* guard.scopeEnabled(owner.projectId, owner.mainThreadId, "interpretation"))) return {status: "denied", code: "supervision_disabled"};
  // the pinned source revision is still the genuine human request, and no Enable or boundary since makes it expire
  if (!(yield* checks.currentSource(task, intake.main)) || (yield* checks.beforeBoundary(task, intake.main))) return {status: "stale", code: "attempt_not_current"};
  if (intake.startVerdict) {
    // the narrow interpretation-submission permission: the exact pinned Start, its mode and master generations, no later Stop or Enable
    const start = yield* store.start(owner.mainThreadId);
    if (!taskPendingStart(task, start) || !(yield* scope.validPendingStart(start))) return {status: "denied", code: "start_permission_missing"};
  }
  yield* recordInterpretationReceipt(sql, owner, {kind: "interpretation_submission", attemptId: attempt.attemptId, attempt: attempt.key,
    startVerdict: intake.startVerdict, argumentsCanonical: intake.argumentsCanonical, argumentsHash: intake.argumentsHash, payload: decoded.payload,
    proof: intake.proof, recordedAt: input.now}, input.now);
  return {status: "submitted", attemptId: attempt.attemptId};
});
