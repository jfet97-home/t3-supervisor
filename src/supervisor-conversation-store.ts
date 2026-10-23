import { Context, Data, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/sql";
import { GuidanceDb, untracedSql } from "./db.js";
import { decodeGuidanceRow, documentRow, GuidanceStoreError, guidanceSql, rowFindings, rowKey, rowsOf, schemaChanges, type StoredRowScan, tableColumns } from "./guidance-sql.js";
import { SupervisorIds } from "./ids.js";
import type { SupervisorMonitorBatch } from "./supervisor-monitor.js";
import { WorkflowProposal, type WorkflowProposalInfo } from "./project-supervisor-contract.js";
import { InterpretationEvidence } from "./interpretation-evidence.js";

export type ConversationRequest = {
  id: string;
  projectId: string;
  supervisorThreadId: string;
  kind: "context" | "review";
  taskId: string | null;
  text: string;
  messageId: string;
  state: "prepared" | "sending" | "waiting" | "uncertain" | "completed" | "failed";
  batch: SupervisorMonitorBatch | null;
  createdAt: number;
  sentAt: number | null;
  runId: string | null;
  error: string | null;
  completionMarker: string;
  failureAcknowledged?: boolean;
  teamNotificationIds?: string[];
  teamEventIds?: string[];
  teamMemberEpoch?: number;
  /** Version of the full standing instructions this request carried; confirmed completion records their delivery. */
  roleVersion?: string;
};
export type WorkflowIntroduction = {
  taskId: string;
  projectId: string;
  threadId: string;
  supervisorThreadId: string;
  state: "context" | "ready" | "sending" | "accepted" | "sent" | "uncertain" | "blocked";
  text: string;
  messageId: string;
  targetRunId: string | null;
  dispatchMode?: {type: "steer_active"; targetRunId: string} | {type: "queue_after_active"};
  acceptedAt?: number;
  visibilityMisses?: number;
  commandId?: string;
  definiteRejection?: boolean;
  rejectedAttempts?: Array<{messageId: string; commandId: string; dispatchMode: WorkflowIntroduction["dispatchMode"]}>;
  error: string | null;
};
export type WorkflowAgreementCandidate = {
  taskId: string;
  projectId: string;
  proposalId: string;
  planHash: string;
  workflow: WorkflowProposalInfo;
  /** What the proposal rests on: the interpretation attempt's recorded tool submission, or the Supervisor message publishing it. */
  evidence: InterpretationEvidence;
  proposedAt: number;
  agentMessageId?: string;
  agentTextHash?: string;
  /** True when the Supervisor published the compact protocol; planHash is then the compact digest over the task revision. */
  compact?: boolean;
  /**
   * The service-prepared interpretation proposal: its evidence is the attempt's tool submission or, converted once by the cut-over,
   * the final answer message it was derived from, which stays current by its unchanged hash alone.
   */
  interpretation?: boolean;
  /** Objective the Supervisor restated from the cited genuine user messages when it published this proposal. */
  objective?: {text: string; sourceMessageIds: string[]} | null;
};

/** Keeps native request identities and unacknowledged activity through restarts. */
// the native message identity of a conversation request, also the batchId of its helper webhook delivery
export const conversationRequestMessageId = (requestId: string): string => `supervisor-review:${requestId}`;
/** An attempted introduction whose native outcome is unknown; a never-attempted draft or a definitely rejected one is known unsent. */
export const introductionOutcomeUnknown = (introduction: WorkflowIntroduction): boolean => introduction.state !== "sent" &&
  (["sending", "accepted", "uncertain"].includes(introduction.state) || introduction.acceptedAt !== undefined || introduction.definiteRejection === false);

/** prepare() beside a pending request of the same Supervisor, with the baseline store's message. */
export class RequestInflight extends Data.TaggedError("RequestInflight") {
  override readonly message = "supervisor_request_inflight";
}

// stored document schemas: every field the writers set, optional fields optional, unknown keys tolerated; a row is
// checked against its schema and the parsed document is kept whole, so a document written back keeps its bytes
const MonitorPriority = Schema.Literals(["user_instruction", "run_finished", "run_failed", "waiting_input"]);
const MonitorTrigger = Schema.Literals(["priority", "activity_threshold", "activity_age", "saturated"]);
const MonitorActivity = Schema.Struct({
  id: Schema.String, readItemId: Schema.NullOr(Schema.String), type: Schema.String, status: Schema.String, ordinal: Schema.Number,
  detectedAt: Schema.Number, version: Schema.String, priority: Schema.NullOr(MonitorPriority),
});
const MonitorThreadBatch = Schema.Struct({
  threadId: Schema.String,
  teamCoverageState: Schema.optionalKey(Schema.Literals(["root", "transferring", "unavailable"])),
  trigger: MonitorTrigger,
  finalizedActivityCount: Schema.Number,
  pendingItemCount: Schema.Number,
  oldestAt: Schema.NullOr(Schema.Number),
  priority: Schema.Boolean,
  priorityKinds: Schema.mutable(Schema.Array(MonitorPriority)),
  saturated: Schema.Boolean,
  untrackedCount: Schema.Number,
  items: Schema.mutable(Schema.Array(MonitorActivity)),
  previewItems: Schema.mutable(Schema.Array(MonitorActivity)),
});
const MonitorBatch = Schema.Struct({
  projectId: Schema.String, createdAt: Schema.Number, trigger: MonitorTrigger, finalizedActivityCount: Schema.Number,
  pendingItemCount: Schema.Number, truncated: Schema.Boolean, threads: Schema.mutable(Schema.Array(MonitorThreadBatch)),
});
const StringList = Schema.mutable(Schema.Array(Schema.String));
const ConversationRequestDocument = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  supervisorThreadId: Schema.String,
  kind: Schema.Literals(["context", "review"]),
  taskId: Schema.NullOr(Schema.String),
  text: Schema.String,
  messageId: Schema.String,
  state: Schema.Literals(["prepared", "sending", "waiting", "uncertain", "completed", "failed"]),
  batch: Schema.NullOr(MonitorBatch),
  createdAt: Schema.Number,
  sentAt: Schema.NullOr(Schema.Number),
  runId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  completionMarker: Schema.String,
  failureAcknowledged: Schema.optionalKey(Schema.Boolean),
  teamNotificationIds: Schema.optionalKey(StringList),
  teamEventIds: Schema.optionalKey(StringList),
  teamMemberEpoch: Schema.optionalKey(Schema.Number),
  roleVersion: Schema.optionalKey(Schema.String),
});
const DispatchMode = Schema.Union([
  Schema.Struct({ type: Schema.Literal("steer_active"), targetRunId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("queue_after_active") }),
]);
type RejectedAttempt = NonNullable<WorkflowIntroduction["rejectedAttempts"]>[number];
const StoredRejectedAttempt = Schema.Struct({ messageId: Schema.String, commandId: Schema.String, dispatchMode: Schema.optionalKey(DispatchMode) });
const isStoredRejectedAttempt = Schema.is(StoredRejectedAttempt);
// an attempt written with an undefined dispatch mode is stored without the key (json omits undefined) and reads back
// as the same value
const RejectedAttemptDocument = Schema.declare((value: unknown): value is RejectedAttempt => isStoredRejectedAttempt(value));
const WorkflowIntroductionDocument = Schema.Struct({
  taskId: Schema.String,
  projectId: Schema.String,
  threadId: Schema.String,
  supervisorThreadId: Schema.String,
  state: Schema.Literals(["context", "ready", "sending", "accepted", "sent", "uncertain", "blocked"]),
  text: Schema.String,
  messageId: Schema.String,
  targetRunId: Schema.NullOr(Schema.String),
  dispatchMode: Schema.optionalKey(DispatchMode),
  acceptedAt: Schema.optionalKey(Schema.Number),
  visibilityMisses: Schema.optionalKey(Schema.Number),
  commandId: Schema.optionalKey(Schema.String),
  definiteRejection: Schema.optionalKey(Schema.Boolean),
  rejectedAttempts: Schema.optionalKey(Schema.mutable(Schema.Array(RejectedAttemptDocument))),
  error: Schema.NullOr(Schema.String),
});
const WorkflowAgreementCandidateDocument = Schema.Struct({
  taskId: Schema.String,
  projectId: Schema.String,
  proposalId: Schema.String,
  planHash: Schema.String,
  workflow: WorkflowProposal,
  evidence: InterpretationEvidence,
  proposedAt: Schema.Number,
  agentMessageId: Schema.optionalKey(Schema.String),
  agentTextHash: Schema.optionalKey(Schema.String),
  compact: Schema.optionalKey(Schema.Boolean),
  interpretation: Schema.optionalKey(Schema.Boolean),
  objective: Schema.optionalKey(Schema.NullOr(Schema.Struct({ text: Schema.String, sourceMessageIds: StringList }))),
});
const isConversationRequest: (value: unknown) => value is ConversationRequest = Schema.is(ConversationRequestDocument);
const isWorkflowIntroduction: (value: unknown) => value is WorkflowIntroduction = Schema.is(WorkflowIntroductionDocument);
const isWorkflowAgreementCandidate: (value: unknown) => value is WorkflowAgreementCandidate = Schema.is(WorkflowAgreementCandidateDocument);

const storedDocument = <T>(is: (value: unknown) => value is T, row: string) => (value: unknown): Effect.Effect<T, GuidanceStoreError> =>
  documentRow<T, GuidanceStoreError>(value, is, () => new GuidanceStoreError({ reason: "row_invalid", row, sqlReason: null }));
const decodeRequestRow = storedDocument(isConversationRequest, "conversation_request");
const decodeIntroductionRow = storedDocument(isWorkflowIntroduction, "workflow_introduction");
const decodeCandidateRow = storedDocument(isWorkflowAgreementCandidate, "agreement_candidate");
const decodeStoredRequestRow = decodeGuidanceRow(Schema.Struct({ id: Schema.String }), "conversation_request");
const decodeCountRow = decodeGuidanceRow(Schema.Struct({ n: Schema.Number }), "agreement_candidate_count");
const decodeNoticeClockRow = decodeGuidanceRow(Schema.Struct({ last_notice_at: Schema.Number }), "notice_clock");
const decodeReviewMissesRow = decodeGuidanceRow(Schema.Struct({ review_misses: Schema.Number }), "notice_clock");

type PrepareInput = Pick<ConversationRequest, "projectId" | "supervisorThreadId" | "kind" | "taskId" | "text" | "batch" | "completionMarker"> &
  Partial<Pick<ConversationRequest, "id" | "teamNotificationIds" | "teamEventIds" | "teamMemberEpoch" | "roleVersion">>;

/** The conversation store: the durable Supervisor requests, workflow introductions, agreement candidates and notice clocks. */
export interface SupervisorConversationStoreShape {
  readonly requests: (projectId: string, supervisorThreadId?: string) => Effect.Effect<ConversationRequest[], GuidanceStoreError>;
  readonly pending: (projectId: string, supervisorThreadId: string) => Effect.Effect<ConversationRequest | null, GuidanceStoreError>;
  readonly saveRequest: (request: ConversationRequest) => Effect.Effect<void, GuidanceStoreError>;
  readonly prepare: (input: PrepareInput, now: number) => Effect.Effect<ConversationRequest, RequestInflight | GuidanceStoreError>;
  readonly introduction: (taskId: string) => Effect.Effect<WorkflowIntroduction | null, GuidanceStoreError>;
  readonly introductions: (projectId: string) => Effect.Effect<WorkflowIntroduction[], GuidanceStoreError>;
  readonly saveIntroduction: (introduction: WorkflowIntroduction) => Effect.Effect<void, GuidanceStoreError>;
  readonly removeUnsentIntroduction: (taskId: string) => Effect.Effect<void, GuidanceStoreError>;
  /** Deletes an introduction unconditionally; the caller has checked that it carries no recorded send. */
  readonly deleteIntroduction: (taskId: string) => Effect.Effect<void, GuidanceStoreError>;
  readonly agreementCandidates: (taskId: string) => Effect.Effect<WorkflowAgreementCandidate[], GuidanceStoreError>;
  readonly agreementCandidate: (taskId: string, proposalId: string) => Effect.Effect<WorkflowAgreementCandidate | null, GuidanceStoreError>;
  readonly saveAgreementCandidate: (candidate: WorkflowAgreementCandidate) => Effect.Effect<"saved" | "same" | "conflict" | "full", GuidanceStoreError>;
  readonly saveAgreementEvidence: (taskId: string, proposalId: string, agentMessageId: string, agentTextHash: string) => Effect.Effect<void, GuidanceStoreError>;
  readonly clearAgreementCandidates: (taskId: string) => Effect.Effect<void, GuidanceStoreError>;
  readonly pruneAgreementCandidates: (taskIds: readonly string[]) => Effect.Effect<void, GuidanceStoreError>;
  readonly lastNotice: (supervisorThreadId: string) => Effect.Effect<number | null, GuidanceStoreError>;
  readonly noticeSent: (supervisorThreadId: string, now: number) => Effect.Effect<void, GuidanceStoreError>;
  readonly reviewMisses: (supervisorThreadId: string, reset?: boolean) => Effect.Effect<number, GuidanceStoreError>;
  readonly missedReview: (supervisorThreadId: string) => Effect.Effect<number, GuidanceStoreError>;
  readonly prune: (now: number) => Effect.Effect<void, GuidanceStoreError>;
}

const schema = [
  "CREATE TABLE IF NOT EXISTS supervisor_conversation_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS supervisor_conversation_project ON supervisor_conversation_requests(project_id)",
  "CREATE TABLE IF NOT EXISTS supervisor_workflow_introductions(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS supervisor_workflow_agreement_candidates(task_id TEXT NOT NULL,proposal_id TEXT NOT NULL,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(task_id,proposal_id))",
  "CREATE INDEX IF NOT EXISTS supervisor_workflow_agreement_project ON supervisor_workflow_agreement_candidates(project_id)",
  "CREATE TABLE IF NOT EXISTS supervisor_monitor_binding_clock(supervisor_thread_id TEXT PRIMARY KEY,last_notice_at INTEGER NOT NULL,review_misses INTEGER NOT NULL DEFAULT 0)",
];

const pendingStates: ReadonlyArray<ConversationRequest["state"]> = ["prepared", "sending", "waiting", "uncertain"];
const prunable = (request: ConversationRequest): boolean =>
  request.state === "completed" || request.state === "failed" && (request.kind !== "review" || request.failureAcknowledged === true);

const makeConversationStore = Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const ids = yield* SupervisorIds;

  // the tables and the review_misses column addition, once, in the baseline constructor's order
  yield* guidanceSql(db.withTransaction(Effect.gen(function* () {
    for (const statement of schema) yield* db.unsafe(statement);
    if (!(yield* tableColumns(db, "supervisor_monitor_binding_clock")).includes("review_misses"))
      yield* db.unsafe("ALTER TABLE supervisor_monitor_binding_clock ADD COLUMN review_misses INTEGER NOT NULL DEFAULT 0");
  })));

  const readRequests = (projectId: string, supervisorThreadId?: string) =>
    db`SELECT document FROM supervisor_conversation_requests WHERE project_id=${projectId} ORDER BY created_at`.pipe(
      Effect.flatMap(Effect.forEach((row) => decodeRequestRow(row))),
      Effect.map((requests) => requests.filter((request) => !supervisorThreadId || request.supervisorThreadId === supervisorThreadId)));
  const readPending = (projectId: string, supervisorThreadId: string) => Effect.map(readRequests(projectId, supervisorThreadId),
    (requests) => requests.find((request) => pendingStates.includes(request.state)) ?? null);
  const writeRequest = (request: ConversationRequest) =>
    db`INSERT INTO supervisor_conversation_requests VALUES(${request.id},${request.projectId},${JSON.stringify(request)},${request.createdAt}) ON CONFLICT(id) DO UPDATE SET document=excluded.document`;
  const readIntroduction = (taskId: string) => db`SELECT document FROM supervisor_workflow_introductions WHERE task_id=${taskId}`.pipe(
    Effect.flatMap(([row]) => row === undefined ? Effect.succeed(null) : decodeIntroductionRow(row)));
  const readCandidate = (taskId: string, proposalId: string) =>
    db`SELECT document FROM supervisor_workflow_agreement_candidates WHERE task_id=${taskId} AND proposal_id=${proposalId}`.pipe(
      Effect.flatMap(([row]) => row === undefined ? Effect.succeed(null) : decodeCandidateRow(row)));
  const count = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) => statement.pipe(
    Effect.flatMap(([row]) => row === undefined ? Effect.succeed(0) : Effect.map(decodeCountRow(row), (value) => value.n)));
  const readReviewMisses = (supervisorThreadId: string) =>
    db`SELECT review_misses FROM supervisor_monitor_binding_clock WHERE supervisor_thread_id=${supervisorThreadId}`.pipe(
      Effect.flatMap(([row]) => row === undefined ? Effect.succeed(0) : Effect.map(decodeReviewMissesRow(row), (value) => value.review_misses)));

  // CC-GDB-IMPLICIT: every pruning delete commits together
  const prunePass = (now: number) => Effect.gen(function* () {
    for (const raw of yield* db`SELECT id,document FROM supervisor_conversation_requests WHERE created_at<${now - 30 * 86400_000}`) {
      const value = yield* decodeRequestRow(raw);
      if (prunable(value)) yield* db`DELETE FROM supervisor_conversation_requests WHERE id=${(yield* decodeStoredRequestRow(raw)).id}`;
    }
    const terminalCount = new Map<string, number>();
    for (const raw of yield* db`SELECT id,document FROM supervisor_conversation_requests ORDER BY created_at DESC,rowid DESC`) {
      const request = yield* decodeRequestRow(raw);
      if (!prunable(request)) continue;
      const n = (terminalCount.get(request.supervisorThreadId) ?? 0) + 1;
      terminalCount.set(request.supervisorThreadId, n);
      if (n > 100) yield* db`DELETE FROM supervisor_conversation_requests WHERE id=${(yield* decodeStoredRequestRow(raw)).id}`;
    }
  });

  const requests = (projectId: string, supervisorThreadId?: string) => guidanceSql(readRequests(projectId, supervisorThreadId));
  const pending = (projectId: string, supervisorThreadId: string) => guidanceSql(readPending(projectId, supervisorThreadId));
  const saveRequest = (request: ConversationRequest) => guidanceSql(Effect.asVoid(writeRequest(request)));

  // CC-GDB-IMPLICIT: the pending check, the pruning and the insert commit together
  const prepare = (input: PrepareInput, now: number) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    if (yield* readPending(input.projectId, input.supervisorThreadId)) return yield* new RequestInflight();
    yield* prunePass(now);
    const id = input.id ?? (yield* ids.uuid);
    const request: ConversationRequest = {...input, id, messageId: conversationRequestMessageId(id), state: "prepared", createdAt: now, sentAt: null, runId: null, error: null};
    yield* writeRequest(request);
    return request;
  })));

  const introduction = (taskId: string) => guidanceSql(readIntroduction(taskId));
  const introductions = (projectId: string) => guidanceSql(db`SELECT document FROM supervisor_workflow_introductions WHERE project_id=${projectId}`.pipe(
    Effect.flatMap(Effect.forEach((row) => decodeIntroductionRow(row)))));
  const saveIntroduction = (value: WorkflowIntroduction) => guidanceSql(Effect.asVoid(
    db`INSERT INTO supervisor_workflow_introductions VALUES(${value.taskId},${value.projectId},${JSON.stringify(value)}) ON CONFLICT(task_id) DO UPDATE SET document=excluded.document`));

  // CC-GDB-IMPLICIT: the unsent check and the delete commit together
  const removeUnsentIntroduction = (taskId: string) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const current = yield* readIntroduction(taskId);
    if (current && ["context", "ready", "blocked"].includes(current.state) && !current.dispatchMode && !current.acceptedAt && !current.rejectedAttempts?.length)
      yield* db`DELETE FROM supervisor_workflow_introductions WHERE task_id=${taskId}`;
  })));

  const deleteIntroduction = (taskId: string) => guidanceSql(Effect.asVoid(db`DELETE FROM supervisor_workflow_introductions WHERE task_id=${taskId}`));

  const agreementCandidates = (taskId: string) => guidanceSql(
    db`SELECT document FROM supervisor_workflow_agreement_candidates WHERE task_id=${taskId} ORDER BY created_at,rowid`.pipe(
      Effect.flatMap(Effect.forEach((row) => decodeCandidateRow(row)))));
  const agreementCandidate = (taskId: string, proposalId: string) => guidanceSql(readCandidate(taskId, proposalId));

  // CC-GDB-IMPLICIT: the immutability check, both capacity counts and the insert commit together
  const saveAgreementCandidate = (candidate: WorkflowAgreementCandidate) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const existing = yield* readCandidate(candidate.taskId, candidate.proposalId);
    if (existing) return existing.planHash === candidate.planHash ? "same" as const : "conflict" as const;
    const taskCount = yield* count(db`SELECT count(*) AS n FROM supervisor_workflow_agreement_candidates WHERE task_id=${candidate.taskId}`);
    const projectCount = yield* count(db`SELECT count(*) AS n FROM supervisor_workflow_agreement_candidates WHERE project_id=${candidate.projectId}`);
    if (taskCount >= 50 || projectCount >= 5000) return "full" as const;
    yield* db`INSERT INTO supervisor_workflow_agreement_candidates VALUES(${candidate.taskId},${candidate.proposalId},${candidate.projectId},${JSON.stringify(candidate)},${candidate.proposedAt})`;
    return "saved" as const;
  })));

  // CC-GDB-IMPLICIT: the write-once check and the update commit together
  const saveAgreementEvidence = (taskId: string, proposalId: string, agentMessageId: string, agentTextHash: string) =>
    guidanceSql(db.withTransaction(Effect.gen(function* () {
      const candidate = yield* readCandidate(taskId, proposalId);
      if (!candidate || candidate.agentMessageId && (candidate.agentMessageId !== agentMessageId || candidate.agentTextHash !== agentTextHash)) return;
      yield* db`UPDATE supervisor_workflow_agreement_candidates SET document=${JSON.stringify({...candidate, agentMessageId, agentTextHash})} WHERE task_id=${taskId} AND proposal_id=${proposalId}`;
    })));

  const clearAgreementCandidates = (taskId: string) => guidanceSql(Effect.asVoid(db`DELETE FROM supervisor_workflow_agreement_candidates WHERE task_id=${taskId}`));
  const pruneAgreementCandidates = (taskIds: readonly string[]) => taskIds.length === 0 ? Effect.void :
    guidanceSql(Effect.asVoid(db`DELETE FROM supervisor_workflow_agreement_candidates WHERE task_id IN ${db.in(taskIds)}`));

  const lastNotice = (supervisorThreadId: string) => guidanceSql(
    db`SELECT last_notice_at FROM supervisor_monitor_binding_clock WHERE supervisor_thread_id=${supervisorThreadId}`.pipe(
      Effect.flatMap(([row]) => row === undefined ? Effect.succeed(null) : Effect.map(decodeNoticeClockRow(row), (value) => value.last_notice_at))));
  const noticeSent = (supervisorThreadId: string, now: number) => guidanceSql(Effect.asVoid(
    db`INSERT INTO supervisor_monitor_binding_clock(supervisor_thread_id,last_notice_at) VALUES(${supervisorThreadId},${now}) ON CONFLICT(supervisor_thread_id) DO UPDATE SET last_notice_at=excluded.last_notice_at`));

  // CC-GDB-IMPLICIT: the reset and the read commit together
  const reviewMisses = (supervisorThreadId: string, reset = false) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    if (reset) yield* db`UPDATE supervisor_monitor_binding_clock SET review_misses=0 WHERE supervisor_thread_id=${supervisorThreadId}`;
    return yield* readReviewMisses(supervisorThreadId);
  })));
  // CC-GDB-IMPLICIT: the increment and the read commit together
  const missedReview = (supervisorThreadId: string) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    yield* db`UPDATE supervisor_monitor_binding_clock SET review_misses=review_misses+1 WHERE supervisor_thread_id=${supervisorThreadId}`;
    return yield* readReviewMisses(supervisorThreadId);
  })));

  const prune = (now: number) => guidanceSql(db.withTransaction(prunePass(now)));

  return SupervisorConversationStore.of({
    requests, pending, saveRequest, prepare, introduction, introductions, saveIntroduction, removeUnsentIntroduction, deleteIntroduction, agreementCandidates,
    agreementCandidate, saveAgreementCandidate, saveAgreementEvidence, clearAgreementCandidates, pruneAgreementCandidates, lastNotice,
    noticeSent, reviewMisses, missedReview, prune,
  });
});

/**
 * The conversation store on the run's GuidanceDb client. Its layer creates the tables and the column addition once;
 * every multi-statement method runs in one transaction and joins the caller's transaction when there is one (a
 * savepoint); request identities come from SupervisorIds.
 */
export class SupervisorConversationStore extends Context.Service<SupervisorConversationStore, SupervisorConversationStoreShape>()(
  "t3-supervisor/SupervisorConversationStore") {
  static readonly layer: Layer.Layer<SupervisorConversationStore, GuidanceStoreError, GuidanceDb | SupervisorIds> =
    Layer.effect(SupervisorConversationStore, untracedSql(makeConversationStore));
}

/**
 * The rollout scan of the conversation tables (read only): every stored request, introduction, agreement candidate and notice
 * clock row through the decoder its reader uses, and the open's table and column additions. The conversation reads them in its
 * supervision cycles.
 */
export const checkConversationRows: Effect.Effect<StoredRowScan, SqlError.SqlError | GuidanceStoreError, GuidanceDb> = Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const changes = [
    ...(yield* Effect.forEach(["supervisor_conversation_requests", "supervisor_workflow_introductions", "supervisor_workflow_agreement_candidates"],
      (table) => schemaChanges(db, table))).flat(),
    ...yield* schemaChanges(db, "supervisor_monitor_binding_clock", ["review_misses"]),
  ];
  const cycle = { problem: "undecodable", read: "cycle" } as const;
  const findings = [
    ...yield* rowFindings(yield* rowsOf(db, "supervisor_conversation_requests", "SELECT id,document FROM supervisor_conversation_requests"),
      { ...cycle, table: "supervisor_conversation_requests", kind: "request" }, (row) => rowKey(row, ["id"]), decodeRequestRow),
    ...yield* rowFindings(yield* rowsOf(db, "supervisor_workflow_introductions", "SELECT task_id,document FROM supervisor_workflow_introductions"),
      { ...cycle, table: "supervisor_workflow_introductions", kind: "introduction" }, (row) => rowKey(row, ["task_id"]), decodeIntroductionRow),
    ...yield* rowFindings(yield* rowsOf(db, "supervisor_workflow_agreement_candidates", "SELECT task_id,proposal_id,document FROM supervisor_workflow_agreement_candidates"),
      { ...cycle, table: "supervisor_workflow_agreement_candidates", kind: "agreement candidate" }, (row) => rowKey(row, ["task_id", "proposal_id"]), decodeCandidateRow),
    // a column the open adds reads as its default
    ...yield* rowFindings(yield* rowsOf(db, "supervisor_monitor_binding_clock", "SELECT * FROM supervisor_monitor_binding_clock"),
      { ...cycle, table: "supervisor_monitor_binding_clock", kind: "notice clock" }, (row) => rowKey(row, ["supervisor_thread_id"]),
      (row) => Effect.andThen(decodeNoticeClockRow(row), decodeReviewMissesRow({ review_misses: 0, ...row }))),
  ];
  return { findings, changes };
});
