import { Clock, Effect, Option, Schema } from "effect";
import type { SqlError } from "effect/sql";
import { GuidanceDb } from "./db.js";
import { mainRunNodeReader } from "./domain.js";
import { InterpretationCutoverRefused } from "./errors.js";
import { changedRows, guidanceSql, guidanceTransaction, type GuidanceStoreError, rowsOf, snapshotRead } from "./guidance-sql.js";
import { fingerprint } from "./guidance-store.js";
import { InterpretationEvidence, interpretationPlanDigest, SupervisorMessageEvidence } from "./interpretation-evidence.js";
import { interpretationSourcePin } from "./interpretation-submission.js";
import { logEvent } from "./logging.js";
import { WorkflowProposal, type WorkflowProposalInfo } from "./project-supervisor-contract.js";
import { ProjectSupervisorStore, type ProjectSupervisorStoreError, type SupervisionStartRecord, type TaskRecord } from "./project-supervisor-store.js";
import { interpretationFromFields, interpretationLimits, seededNodeIds, workflowInterpretationOutcome } from "./supervisor-workflow.js";
import type { T3ClientShape } from "./t3.js";
import { timestampMs } from "./timestamp.js";
import type { Projection } from "./types.js";

// the one-off cut-over to the typed interpretation submission (plan 3.12 item 11), one logged startup step that reads stored
// rows and native projections and never sends. a pure plan computes everything it would do; the startup step applies exactly
// that plan in one transaction, or refuses with a fixed reason and changes nothing; the rollout scan prints the same plan.
// the plan, its legacy decoders, the apply and the scan section are deleted together with this module after the s6e deployment

export const interpretationCutoverReason = "Interpretation protocol changed; a new genuine request is interpreted under the typed protocol.";
const queuedRefreshReason = "Interpretation protocol changed; this unsent request is prepared again under the typed protocol.";

// ---- the pre-s6e formats, read only here

// the pre-s6e agreement candidate: its proposal evidence is the supervisor message named by four flat fields
const LegacyCandidate = Schema.Struct({
  taskId: Schema.String,
  projectId: Schema.String,
  proposalId: Schema.String,
  planHash: Schema.String,
  workflow: WorkflowProposal,
  supervisorMessageId: Schema.String,
  supervisorRunId: Schema.String,
  supervisorRunOrdinal: Schema.Number,
  supervisorTextHash: Schema.String,
  proposedAt: Schema.Number,
  agentMessageId: Schema.optionalKey(Schema.String),
  agentTextHash: Schema.optionalKey(Schema.String),
  compact: Schema.optionalKey(Schema.Boolean),
  interpretation: Schema.optionalKey(Schema.Boolean),
  objective: Schema.optionalKey(Schema.NullOr(Schema.Struct({text: Schema.String, sourceMessageIds: Schema.Array(Schema.String)}))),
});
type LegacyCandidate = typeof LegacyCandidate.Type;
const isLegacyCandidate = Schema.is(LegacyCandidate);
// a candidate the cut-over already converted: the evidence union and none of the flat fields
const isConvertedCandidate = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value) &&
  !("supervisorMessageId" in value) && Schema.is(Schema.Struct({taskId: Schema.String, proposalId: Schema.String, evidence: InterpretationEvidence}))(value);

// the store's own row guards: a document is checked for the fields its readers rely on and kept whole
const isStoredTask = Schema.is(Schema.Struct({threadId: Schema.String, projectId: Schema.String, status: Schema.String}));
const isStoredStart = Schema.is(Schema.Struct({threadId: Schema.String, status: Schema.String}));
const isStoredIntroduction = Schema.is(Schema.Struct({taskId: Schema.String, state: Schema.String}));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const parsedDocument = <A>(text: unknown, guard: (value: unknown) => boolean): A | null => {
  if (typeof text !== "string") return null;
  const value = Option.getOrUndefined(decodeJson(text));
  return value !== undefined && guard(value) ? value as A : null;
};

// the pre-s6e final-chat interpretation answer: the fenced or bare json object the old prompt asked for, decoded exactly as
// the final-chat parser did, then the shared semantic rules
const unfenced = (text: string): string => /^```(?:json)?\s*\n([\s\S]*)\n```$/u.exec(text.trim())?.[1] ?? text;
const exactKeys = {onExcessProperty: "error"} as const;
const decodeLegacyAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  objective: Schema.Unknown,
  reason: Schema.Unknown,
  sourceMessageIds: Schema.Unknown,
  supervision: Schema.optionalKey(Schema.Literals(["needed", "not_needed"])),
  workflow: Schema.Unknown,
})));
const decodeLegacyFields = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  objective: Schema.NullOr(Schema.String.check(Schema.isMaxLength(interpretationLimits.maxObjectiveLength))),
  reason: Schema.String.check(Schema.isMaxLength(interpretationLimits.maxReasonLength)),
  sourceMessageIds: Schema.Array(Schema.String).check(Schema.isMaxLength(interpretationLimits.maxSourceMessageIds)),
})));

// today's rule: the supervisor's own answer yields exactly this plan; node ids are minted on each read and never compared
const legacyAnswerMatches = (task: TaskRecord, text: string, expected: WorkflowProposalInfo | null | undefined): boolean => {
  const context = task.definitionContext;
  if (!context || !expected || text.length > interpretationLimits.maxWorkflowInterpretationReplyLength) return false;
  const answer = Option.getOrUndefined(decodeLegacyAnswer(unfenced(text), exactKeys));
  if (!answer) return false;
  const fieldsText = JSON.stringify({objective: answer.objective, reason: answer.reason, sourceMessageIds: answer.sourceMessageIds});
  const fields = fieldsText.length > interpretationLimits.maxInterpretationReplyLength ? undefined : Option.getOrUndefined(decodeLegacyFields(fieldsText, exactKeys));
  if (!fields) return false;
  const interpretation = interpretationFromFields(fields, task.sourceMessageId);
  if (!interpretation.ok) return false;
  const outcome = workflowInterpretationOutcome(interpretation.value, answer.supervision, answer.workflow, context, seededNodeIds("t3-supervisor:cutover"));
  return outcome.ok && outcome.value.supervision !== "not_needed" && outcome.value.objective !== null &&
    interpretationPlanDigest(outcome.value.workflow) === interpretationPlanDigest(expected);
};

// ---- the stored rows the plan reads

export interface CutoverRows {
  readonly tasks: ReadonlyArray<{readonly document: string; readonly task: TaskRecord}>;
  readonly starts: ReadonlyArray<{readonly key: string; readonly document: string; readonly start: SupervisionStartRecord}>;
  /** null: already converted */
  readonly candidates: ReadonlyArray<{readonly taskId: string; readonly proposalId: string; readonly document: string; readonly legacy: LegacyCandidate | null}>;
  readonly introductions: ReadonlyArray<{readonly taskId: string; readonly state: string}>;
  /** rows no reader can decode, by table and key */
  readonly unreadable: ReadonlyArray<{readonly table: string; readonly key: string}>;
}

const stringColumn = (row: Record<string, unknown>, column: string): string => typeof row[column] === "string" ? row[column] : "";

/** Every task, Start, agreement candidate and introduction row, read as one snapshot; a missing table has no rows. */
export const readCutoverRows: Effect.Effect<CutoverRows, SqlError.SqlError, GuidanceDb> = Effect.gen(function* () {
  const db = yield* GuidanceDb;
  return yield* snapshotRead(db)(Effect.gen(function* () {
    const unreadable: Array<{table: string; key: string}> = [];
    const table = Effect.fnUntraced(function* (name: string, select: string) {
      const rows = yield* rowsOf(db, name, select);
      if ((rows as {readonly shapeMismatch?: true}).shapeMismatch) unreadable.push({table: name, key: name});
      return rows;
    });
    const tasks: Array<CutoverRows["tasks"][number]> = [];
    for (const row of yield* table("supervisor_task_interpretations", "SELECT thread_id,document FROM supervisor_task_interpretations ORDER BY thread_id")) {
      const task = parsedDocument<TaskRecord>(row.document, isStoredTask);
      if (task) tasks.push({document: row.document as string, task});
      else unreadable.push({table: "supervisor_task_interpretations", key: stringColumn(row, "thread_id")});
    }
    const starts: Array<CutoverRows["starts"][number]> = [];
    for (const row of yield* table("meta", "SELECT key,value FROM meta WHERE key LIKE 'supervisor_start:%' ORDER BY key")) {
      const start = parsedDocument<SupervisionStartRecord>(row.value, isStoredStart);
      if (start) starts.push({key: row.key as string, document: row.value as string, start});
      else unreadable.push({table: "meta", key: stringColumn(row, "key")});
    }
    const candidates: Array<CutoverRows["candidates"][number]> = [];
    for (const row of yield* table("supervisor_workflow_agreement_candidates",
      "SELECT task_id,proposal_id,document FROM supervisor_workflow_agreement_candidates ORDER BY task_id,proposal_id")) {
      const taskId = stringColumn(row, "task_id"), proposalId = stringColumn(row, "proposal_id");
      const legacy = parsedDocument<LegacyCandidate>(row.document, isLegacyCandidate);
      if (legacy || parsedDocument(row.document, isConvertedCandidate)) candidates.push({taskId, proposalId, document: row.document as string, legacy});
      else unreadable.push({table: "supervisor_workflow_agreement_candidates", key: `${taskId} ${proposalId}`});
    }
    const introductions: Array<CutoverRows["introductions"][number]> = [];
    for (const row of yield* table("supervisor_workflow_introductions", "SELECT task_id,document FROM supervisor_workflow_introductions ORDER BY task_id")) {
      const introduction = parsedDocument<{taskId: string; state: string}>(row.document, isStoredIntroduction);
      if (introduction) introductions.push({taskId: introduction.taskId, state: introduction.state});
      else unreadable.push({table: "supervisor_workflow_introductions", key: stringColumn(row, "task_id")});
    }
    return {tasks, starts, candidates, introductions, unreadable};
  }));
});

// ---- the native reads the plan uses: one projection per supervisor root, read only

export type CutoverNativeRead =
  | {readonly status: "read"; readonly projection: Projection}
  | {readonly status: "missing"}
  | {readonly status: "unavailable"}
  | {readonly status: "not_read"};
export type CutoverNatives = ReadonlyMap<string, CutoverNativeRead>;

const inflightStatuses: ReadonlyArray<string> = ["dispatching", "waiting", "uncertain"];
const terminalRunStatuses: ReadonlyArray<string> = ["completed", "failed", "interrupted", "cancelled", "rolled_back"];
const failedRunStatuses: ReadonlyArray<string> = ["failed", "interrupted", "cancelled", "rolled_back"];

// a pre-s6e task: no attempt was minted for its request and no typed evidence recorded
const legacyTask = (task: TaskRecord): boolean => task.attempt === undefined && task.interpretationEvidence === undefined;
const oldInflight = (task: TaskRecord): boolean => legacyTask(task) && inflightStatuses.includes(task.status);
const candidateKey = (taskId: string, proposalId: string): string => JSON.stringify([taskId, proposalId]);
// an inferred interpretation the conversation may introduce, with no candidate for its current proposal
const introducedWorkflowStatuses: ReadonlyArray<string> = ["proposed", "provisional", "stale"];
const candidateFree = (task: TaskRecord, candidates: ReadonlySet<string>): boolean => legacyTask(task) && task.status === "inferred" &&
  introducedWorkflowStatuses.includes(task.workflow?.status ?? "") && !candidates.has(candidateKey(task.id, task.workflowProposalId ?? task.id));

/** The supervisor roots whose projections the plan reads, in a stable order. */
export const cutoverNativeThreads = (rows: CutoverRows): ReadonlyArray<string> => {
  const candidates = new Set(rows.candidates.map((row) => candidateKey(row.taskId, row.proposalId)));
  const byId = new Map(rows.tasks.map(({task}) => [task.id, task]));
  const threads = new Set<string>();
  for (const {task} of rows.tasks) if (oldInflight(task) || candidateFree(task, candidates)) threads.add(task.supervisorThreadId);
  for (const row of rows.candidates) {
    const task = row.legacy?.interpretation ? byId.get(row.taskId) : undefined;
    if (task) threads.add(task.supervisorThreadId);
  }
  return [...threads].filter((thread) => typeof thread === "string" && thread.length > 0).sort();
};

/** Reads each root's projection once; a 404 is a missing root, any other failure an unavailable read. Nothing is sent. */
export const readCutoverNatives = (t3: Pick<T3ClientShape, "projection">, threads: ReadonlyArray<string>): Effect.Effect<CutoverNatives> =>
  Effect.map(Effect.forEach(threads, (thread) => t3.projection(thread).pipe(
    Effect.map((snapshot): CutoverNativeRead => ({status: "read", projection: snapshot.projection})),
    Effect.catch((error) => Effect.succeed<CutoverNativeRead>(error.httpStatus === 404 ? {status: "missing"} : {status: "unavailable"})),
    Effect.map((read) => [thread, read] as const)), {concurrency: 4}), (reads) => new Map(reads));

type Answer = {messageId: string; runId: string; text: string; createdAt: number | null; ordinal: number};
// the completed assistant messages of the root's main graph, as the conversation reads them as evidence
const completedAnswers = (projection: Projection, threadId: string): Array<Answer> => {
  const result: Array<Answer> = [];
  for (const run of projection.runs) {
    if (run.threadId !== threadId || failedRunStatuses.includes(run.status)) continue;
    const nodeFor = mainRunNodeReader(projection, run);
    for (const message of projection.messages) {
      const node = message.nodeId ? nodeFor(message.nodeId) : undefined;
      if (message.threadId !== threadId || message.runId !== run.id || message.role !== "assistant" || message.streaming ||
        node?.kind !== "assistant_message" || node.status !== "completed") continue;
      result.push({messageId: message.id, runId: run.id, text: message.text, createdAt: timestampMs(message.createdAt), ordinal: run.ordinal});
    }
  }
  return result.sort((a, b) => a.ordinal - b.ordinal || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.messageId.localeCompare(b.messageId));
};

// ---- the plan

export type CutoverBlockerCode = "run_not_terminal" | "native_read_unavailable" | "native_not_read" | "row_unreadable" | "evidence_unrepresentable";
export interface CutoverBlocker {
  readonly code: CutoverBlockerCode;
  /** the identities of the blocking row: task, chat, root and run, or table and key */
  readonly ids: Readonly<Record<string, string | null>>;
}
export type CutoverWrite =
  | {readonly kind: "task"; readonly task: TaskRecord}
  | {readonly kind: "start"; readonly start: SupervisionStartRecord}
  | {readonly kind: "candidate"; readonly taskId: string; readonly proposalId: string; readonly expected: string; readonly document: string};

/** What the cut-over reads and would do, by identities, outcomes and reason codes only. */
export interface CutoverReport {
  readonly inflight: ReadonlyArray<{readonly taskId: string; readonly threadId: string; readonly supervisorThreadId: string; readonly messageId: string;
    readonly status: string; readonly runId: string | null; readonly runStatus: string | null; readonly outcome: "close" | "blocking"}>;
  readonly starts: ReadonlyArray<{readonly threadId: string; readonly operationId: string; readonly taskId: string; readonly outcome: "reject" | "held"}>;
  readonly candidates: ReadonlyArray<{readonly taskId: string; readonly proposalId: string; readonly kind: "interpretation" | "proposal"; readonly agreed: boolean;
    readonly outcome: "convert" | "stale" | "unknown"; readonly reason: string}>;
  readonly candidateFree: ReadonlyArray<{readonly taskId: string; readonly threadId: string; readonly workflowStatus: string; readonly introductionState: string | null;
    readonly outcome: "record" | "stale" | "unknown"; readonly reason: string}>;
  readonly queued: ReadonlyArray<{readonly taskId: string; readonly threadId: string}>;
  readonly blockers: ReadonlyArray<CutoverBlocker>;
}
export interface CutoverPlan extends CutoverReport {
  /** the exact rows the apply writes, in order; empty when nothing is needed */
  readonly writes: ReadonlyArray<CutoverWrite>;
}

const nativeUnknown = (read: CutoverNativeRead | undefined): "native_read_unavailable" | "native_not_read" | null =>
  read === undefined || read.status === "not_read" ? "native_not_read" : read.status === "unavailable" ? "native_read_unavailable" : null;
const isMessageEvidence = Schema.is(SupervisorMessageEvidence);
// the converted candidate document: the flat provenance fields leave, the evidence union joins with the same values; every
// other key and value stays as stored
const convertedCandidate = (document: string, evidence: SupervisorMessageEvidence): string => {
  const value = JSON.parse(document) as Record<string, unknown>;
  for (const key of ["supervisorMessageId", "supervisorRunId", "supervisorRunOrdinal", "supervisorTextHash"]) delete value[key];
  return JSON.stringify({...value, evidence});
};

/**
 * The cut-over of the stored rows against the given native reads at `now`, as data: what it closes, rejects, converts, marks
 * stale, records and refreshes, the exact writes, and whatever blocks applying now. Pure: it reads nothing and writes nothing.
 */
export const interpretationCutoverPlan = (rows: CutoverRows, natives: CutoverNatives, now: number): CutoverPlan => {
  const writes: Array<CutoverWrite> = [];
  const blockers: Array<CutoverBlocker> = rows.unreadable.map((row) => ({code: "row_unreadable", ids: {table: row.table, key: row.key}}));
  const candidateKeys = new Set(rows.candidates.map((row) => candidateKey(row.taskId, row.proposalId)));
  const tasksById = new Map(rows.tasks.map(({task}) => [task.id, task]));
  const introductions = new Map(rows.introductions.map((row) => [row.taskId, row.state]));

  // in-flight old-prompt requests: observed read only; a terminal run closes the attempt unapplied, anything else blocks
  const inflight: Array<CutoverReport["inflight"][number]> = [];
  const closing = new Set<string>();
  for (const {task} of rows.tasks) {
    if (!oldInflight(task)) continue;
    const read = natives.get(task.supervisorThreadId);
    const unknown = nativeUnknown(read);
    const projection = read?.status === "read" ? read.projection : null;
    const message = projection?.messages.find((item) => item.id === task.messageId && item.threadId === task.supervisorThreadId);
    const run = message ? projection?.runs.find((item) => item.id === message.runId && item.userMessageId === task.messageId && item.threadId === task.supervisorThreadId) : undefined;
    // a deleted root runs nothing more: its attempt closes like one whose run ended
    const terminal = read?.status === "missing" || Boolean(run && terminalRunStatuses.includes(run.status));
    const entry = {taskId: task.id, threadId: task.threadId, supervisorThreadId: task.supervisorThreadId, messageId: task.messageId, status: task.status,
      runId: run?.id ?? null, runStatus: run?.status ?? null, outcome: terminal ? "close" as const : "blocking" as const};
    inflight.push(entry);
    if (!terminal) {
      blockers.push({code: unknown ?? "run_not_terminal", ids: {taskId: task.id, threadId: task.threadId, supervisorThreadId: task.supervisorThreadId, runId: entry.runId}});
      continue;
    }
    closing.add(task.id);
    const workflow = task.workflow?.status === "pending" ? {...task.workflow, status: "unavailable" as const, message: interpretationCutoverReason} : task.workflow;
    // the request text, its message and command ids stay as they were sent; only the result closes
    writes.push({kind: "task", task: {...task, status: "unavailable", objective: null, reason: interpretationCutoverReason, workflow: workflow ?? null,
      supervisorRunId: run?.id ?? task.supervisorRunId, updatedAt: now}});
  }

  // a pending Start waiting on such an attempt is rejected with the same reason; the human can request again
  const starts: Array<CutoverReport["starts"][number]> = [];
  const inflightIds = new Set(inflight.map((entry) => entry.taskId));
  for (const {start} of rows.starts) {
    if (start.status !== "pending" || start.taskId === null || !inflightIds.has(start.taskId)) continue;
    const reject = closing.has(start.taskId);
    starts.push({threadId: start.threadId, operationId: start.operationId, taskId: start.taskId, outcome: reject ? "reject" : "held"});
    if (reject) writes.push({kind: "start", start: {...start, status: "rejected", reason: interpretationCutoverReason}});
  }

  // retained candidates: an initial interpretation candidate is checked once against its still-present native answer and
  // converted, or converted stale; a later proposal keeps its record protocol and only changes format
  const candidates: Array<CutoverReport["candidates"][number]> = [];
  for (const row of rows.candidates) {
    const legacy = row.legacy;
    if (!legacy) continue;
    const task = tasksById.get(legacy.taskId);
    const agreed = task?.agreement?.status === "agreed" && task.agreement.proposalId === legacy.proposalId;
    const kind = legacy.interpretation ? "interpretation" as const : "proposal" as const;
    let outcome: "convert" | "stale" | "unknown" = "convert";
    let reason = "proposal_record";
    if (kind === "interpretation") {
      const read = task ? natives.get(task.supervisorThreadId) : undefined;
      const unknown = task ? nativeUnknown(read) : null;
      if (!task) {outcome = "stale";reason = "task_missing";}
      else if (unknown) {outcome = "unknown";reason = unknown;}
      else if (read?.status !== "read") {outcome = "stale";reason = "supervisor_missing";}
      else {
        const answer = completedAnswers(read.projection, task.supervisorThreadId).find((item) => item.messageId === legacy.supervisorMessageId && item.runId === legacy.supervisorRunId);
        if (!answer) {outcome = "stale";reason = "message_missing";}
        else if (fingerprint(answer.text) !== legacy.supervisorTextHash) {outcome = "stale";reason = "text_changed";}
        else if (!legacyAnswerMatches(task, answer.text, legacy.workflow)) {outcome = "stale";reason = "plan_changed";}
        else reason = "message_matches";
      }
    }
    candidates.push({taskId: row.taskId, proposalId: row.proposalId, kind, agreed, outcome, reason});
    if (outcome === "unknown") {
      blockers.push({code: reason as CutoverBlockerCode, ids: {taskId: row.taskId, proposalId: row.proposalId, supervisorThreadId: task?.supervisorThreadId ?? null}});
      continue;
    }
    const evidence: SupervisorMessageEvidence = {kind: "supervisor_message", messageId: legacy.supervisorMessageId, runId: legacy.supervisorRunId,
      runOrdinal: legacy.supervisorRunOrdinal, textHash: legacy.supervisorTextHash, ...(outcome === "stale" ? {stale: true} : {})};
    if (!isMessageEvidence(evidence)) {blockers.push({code: "evidence_unrepresentable", ids: {taskId: row.taskId, proposalId: row.proposalId}});continue;}
    writes.push({kind: "candidate", taskId: row.taskId, proposalId: row.proposalId, expected: row.document, document: convertedCandidate(row.document, evidence)});
  }

  // candidate-free inferred or provisional interpretations: their legacy answer is validated once and recorded as evidence
  const candidateFreeEntries: Array<CutoverReport["candidateFree"][number]> = [];
  for (const {task} of rows.tasks) {
    if (!candidateFree(task, candidateKeys)) continue;
    const read = natives.get(task.supervisorThreadId);
    const unknown = nativeUnknown(read);
    const entry = {taskId: task.id, threadId: task.threadId, workflowStatus: task.workflow!.status, introductionState: introductions.get(task.id) ?? null};
    if (unknown) {
      candidateFreeEntries.push({...entry, outcome: "unknown", reason: unknown});
      blockers.push({code: unknown, ids: {taskId: task.id, threadId: task.threadId, supervisorThreadId: task.supervisorThreadId}});
      continue;
    }
    const answers = read?.status === "read" ? completedAnswers(read.projection, task.supervisorThreadId).filter((item) => item.runId === task.supervisorRunId) : [];
    const answer = answers.find((item) => legacyAnswerMatches(task, item.text, task.workflow));
    // without a matching answer the evidence is stale: it names the run's last answer, or the request when none remains
    const named = answer ?? answers.at(-1);
    const run = read?.status === "read" ? read.projection.runs.find((item) => item.id === task.supervisorRunId) : undefined;
    const evidence: SupervisorMessageEvidence = {kind: "supervisor_message", messageId: named?.messageId ?? task.messageId,
      runId: named?.runId ?? task.supervisorRunId ?? task.messageId, runOrdinal: named?.ordinal ?? run?.ordinal ?? 0,
      textHash: fingerprint(named?.text ?? ""), planDigest: interpretationPlanDigest(task.workflow), sourcePin: interpretationSourcePin(task),
      ...(answer ? {} : {stale: true})};
    candidateFreeEntries.push({...entry, outcome: answer ? "record" : "stale", reason: answer ? "answer_matches" : read?.status === "read" ? "answer_missing" : "supervisor_missing"});
    if (!isMessageEvidence(evidence)) {blockers.push({code: "evidence_unrepresentable", ids: {taskId: task.id, threadId: task.threadId}});continue;}
    writes.push({kind: "task", task: {...task, interpretationEvidence: evidence}});
  }

  // an unsent request prepared under the old prompt is prepared again, so it is sent only under the typed protocol
  const queued: Array<CutoverReport["queued"][number]> = [];
  for (const {task} of rows.tasks) {
    if (!legacyTask(task) || task.status !== "queued" || task.dispatchedAt !== null || task.definitionContext == null) continue;
    queued.push({taskId: task.id, threadId: task.threadId});
    const refreshed: {-readonly [K in keyof TaskRecord]: TaskRecord[K]} = {...task, requestText: "", reason: queuedRefreshReason, updatedAt: now};
    delete refreshed.definitionContext;delete refreshed.definitionSnapshot;delete refreshed.definitionReadAttempts;delete refreshed.revalidationAttempts;
    writes.push({kind: "task", task: refreshed});
  }

  return {inflight, starts, candidates, candidateFree: candidateFreeEntries, queued, blockers, writes: blockers.length ? [] : writes};
};

/** The plan without its writes: identities, outcomes and codes only, as the scan prints it. */
export const cutoverReport = (plan: CutoverPlan): CutoverReport & {readonly writes: number} => ({
  inflight: plan.inflight, starts: plan.starts, candidates: plan.candidates, candidateFree: plan.candidateFree, queued: plan.queued, blockers: plan.blockers,
  writes: plan.writes.length,
});

const blockerLine = (blocker: CutoverBlocker): string =>
  `${blocker.code} ${Object.entries(blocker.ids).map(([key, value]) => `${key}=${value ?? "-"}`).join(" ")}`;

/** The plan as report lines: counts first, then each entry by identities and codes. */
export const renderCutoverPlan = (report: CutoverReport): Array<string> => {
  const lines = ["interpretation cut-over (s6e startup step; read only here):"];
  const count = <A>(items: ReadonlyArray<A>, outcome: (item: A) => string) => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(outcome(item), (counts.get(outcome(item)) ?? 0) + 1);
    return [...counts].map(([key, value]) => `${value} ${key}`).join(", ") || "none";
  };
  lines.push(`  in-flight old-prompt attempts: ${count(report.inflight, (item) => item.outcome)}`);
  for (const item of report.inflight)
    lines.push(`    ${item.outcome}: task ${item.taskId} chat ${item.threadId} root ${item.supervisorThreadId} request ${item.messageId} (${item.status}); run ${item.runId ?? "-"} ${item.runStatus ?? "not visible"}`);
  lines.push(`  pending Starts on them: ${count(report.starts, (item) => item.outcome)}`);
  for (const item of report.starts) lines.push(`    ${item.outcome}: chat ${item.threadId} operation ${item.operationId} task ${item.taskId}`);
  lines.push(`  retained candidates: ${count(report.candidates, (item) => `${item.kind} ${item.outcome}`)}`);
  for (const item of report.candidates)
    lines.push(`    ${item.kind} ${item.outcome}${item.agreed ? " (accepted agreement)" : ""}: task ${item.taskId} proposal ${item.proposalId}; ${item.reason}`);
  lines.push(`  candidate-free interpretations: ${count(report.candidateFree, (item) => item.outcome)}`);
  for (const item of report.candidateFree)
    lines.push(`    ${item.outcome}: task ${item.taskId} chat ${item.threadId} workflow ${item.workflowStatus}, introduction ${item.introductionState ?? "none"}; ${item.reason}`);
  lines.push(`  unsent old-prompt requests prepared again: ${report.queued.length}`);
  for (const item of report.queued) lines.push(`    task ${item.taskId} chat ${item.threadId}`);
  if (report.blockers.length) {
    lines.push(`  blocks applying now (${report.blockers.length}):`);
    for (const blocker of report.blockers) lines.push(`    ${blockerLine(blocker)}`);
  }
  return lines;
};

// ---- the startup step

// the identities of a refusal, bounded; ids only, never a document
const refusalIdentities = (blockers: ReadonlyArray<CutoverBlocker>): string => {
  const shown = blockers.slice(0, 20).map(blockerLine);
  return blockers.length > shown.length ? `${shown.join("; ")}; and ${blockers.length - shown.length} more` : shown.join("; ");
};
const rowsIdentity = (rows: CutoverRows): string => JSON.stringify([rows.tasks.map((row) => row.document), rows.starts.map((row) => [row.key, row.document]),
  rows.candidates.map((row) => [row.taskId, row.proposalId, row.document]), rows.unreadable]);

/**
 * The one logged cut-over step at startup, before the run serves or cycles. It reads the rows and the roots' projections (no
 * send), plans, and then applies exactly the plan's writes in one transaction after rereading the rows unchanged; nothing to
 * apply starts the run as it is. A blocking plan, or rows that changed before the commit, refuse with a fixed reason, logged
 * once, and every row stays as it was.
 */
export const interpretationCutover = (t3: Pick<T3ClientShape, "projection">): Effect.Effect<void,
  InterpretationCutoverRefused | GuidanceStoreError | ProjectSupervisorStoreError, GuidanceDb | ProjectSupervisorStore> => Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const store = yield* ProjectSupervisorStore;
  const rows = yield* guidanceSql(readCutoverRows);
  const plan = interpretationCutoverPlan(rows, yield* readCutoverNatives(t3, cutoverNativeThreads(rows)), yield* Clock.currentTimeMillis);
  const refuse = (reason: InterpretationCutoverRefused["reason"], blockers: ReadonlyArray<CutoverBlocker>) =>
    Effect.andThen(logEvent("interpretation_cutover_refused", {reason, blockers: blockers.length, identities: refusalIdentities(blockers)}),
      Effect.fail(new InterpretationCutoverRefused({reason})));
  if (plan.blockers.length) return yield* refuse("interpretation_cutover_blocked", plan.blockers);
  // nothing to apply starts the run as it is, silently: a fresh or already converted directory logs nothing new
  if (!plan.writes.length) return;
  yield* guidanceTransaction(db)(Effect.gen(function* () {
    if (rowsIdentity(yield* readCutoverRows) !== rowsIdentity(rows)) return yield* new InterpretationCutoverRefused({reason: "interpretation_cutover_conflict"});
    for (const write of plan.writes) {
      if (write.kind === "task") yield* store.saveTask(write.task);
      else if (write.kind === "start") yield* store.saveStart(write.start);
      // the candidate's own row, compared with the document the plan converted; its key, project and creation time stay
      else if ((yield* changedRows(db`UPDATE supervisor_workflow_agreement_candidates SET document=${write.document} WHERE task_id=${write.taskId} AND proposal_id=${write.proposalId} AND document=${write.expected}`.raw)) !== 1)
        return yield* new InterpretationCutoverRefused({reason: "interpretation_cutover_conflict"});
    }
  })).pipe(Effect.catchTag("InterpretationCutoverRefused", (refused) => refuse(refused.reason, [])));
  yield* logEvent("interpretation_cutover_applied", {
    closed: plan.inflight.length, startsRejected: plan.starts.length,
    candidatesConverted: plan.candidates.filter((item) => item.outcome === "convert").length,
    candidatesStale: plan.candidates.filter((item) => item.outcome === "stale").length,
    evidenceRecorded: plan.candidateFree.filter((item) => item.outcome === "record").length,
    evidenceStale: plan.candidateFree.filter((item) => item.outcome === "stale").length,
    requestsPreparedAgain: plan.queued.length, rows: plan.writes.length,
  });
});
