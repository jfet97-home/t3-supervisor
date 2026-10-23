import { Clock, Context, Data, Effect, Layer, Ref, Schema } from "effect";
import type { SqlError } from "effect/sql";
import { GuidanceDb, untracedSql } from "./db.js";
import { decodeRow, documentRow, documentRows, type GuidanceStoreError, mapSqlError, rowFindings, rowKey, rowsOf, schemaChanges, snapshotRead, storedDocument,
  type StoredRowFinding, type StoredRowScan, tableColumns } from "./guidance-sql.js";
import { fingerprint } from "./guidance-store.js";
import { SupervisorIds } from "./ids.js";
import { SupervisorStateReset } from "./supervisor-state-reset.js";
import { defaultMonitoringSettings, type DefinitionReviewInfo, type SupervisorBinding, type SupervisorModelSelection, type SupervisorMonitoringSettings, type TaskInterpretationInfo, type WorkflowProtocolDiagnostic } from "./project-supervisor-contract.js";
import type { Projection } from "./types.js";
import { sameModel } from "./supervisor-native.js";
import type { NoProjectModeValue } from "./supervisor-control-contract.js";
import type { SupervisionControlInfo } from "./supervisor-control-contract.js";
import type { GlobalDefinitionsControlInfo } from "./supervisor-control-contract.js";
import type { ProposalContext } from "./supervisor-workflow.js";
import type { ProjectDefinitionSnapshot } from "./project-definitions-contract.js";
import type { TaskInterpretationFields } from "./interpretation-evidence.js";

// the model of a project without saved settings (D-28, Andrea 2026-10-23): GPT-6.1 Sol LOW; saved settings and existing bindings keep theirs
export const defaultSupervisorModel: SupervisorModelSelection = {instanceId: "codex", model: "gpt-6.1-sol", options: [{id: "reasoningEffort", value: "low"}]};
export const SUPERVISOR_ROOT_THREAD_PREFIX = "supervisor-root:";
export type ProjectModelSettings = {projectId: string; generation: number; modelMutationGeneration: number; modelSelection: SupervisorModelSelection; pending: boolean; monitoring: SupervisorMonitoringSettings; teamSettings?: {maxHelpersPerRoot: number}; applyAttempts?: number; applicationMessage?: string | null};
export type SupervisorStopNotice = {messageId: string; commandId: string; stoppedAt: number; enabledAt: number | null;
  state: "ready" | "uncertain" | "accepted" | "sent" | "blocked" | "unconfirmed" | "superseded";
  text: string; visibilityMisses?: number; nextObserveAt?: number;
  dispatchMode?: {type: "steer_active"; targetRunId: string} | {type: "queue_after_active"}; rejectedAttempts?: Array<{messageId: string; commandId: string}>; error?: string | null};
export type BindingRecord = SupervisorBinding & {stopNotice?: SupervisorStopNotice;mainThreadId: string; modelState?: ProjectModelSettings; quietFingerprint?: string; manualKeepActive?: boolean; quietSince?: number | null; settlement?: {commandId: string; state: "pending" | "uncertain" | "settled" | "superseded"; observedAt: number; activityVersion?: string; attempts?: number}; enableAfterSequence: number; title: string; initialModel: SupervisorModelSelection; creationAttempts?: number; creationMessage?: string; deliveredRoleVersion?: string; stopObservedAt?: number; supervisionStop?: {route: "direct" | "relay" | "chat" | "ui"; callerThreadId: string | null; userMessageId: string | null; stoppedAt: number}};
/** One immutable notice body and native identity for an explicit Stop period; the identities come from SupervisorIds. */
export const prepareStopNotice = (ids: SupervisorIds["Service"], binding: Pick<BindingRecord, "threadId">, stoppedAt: number, enabledAt: number | null): Effect.Effect<SupervisorStopNotice> =>
  Effect.map(Effect.all([ids.uuid, ids.uuid]), ([messageUuid, commandUuid]) => ({
    messageId: `supervisor-notice:stop:${messageUuid}`, commandId: `supervisor-stop-notice:${commandUuid}`, stoppedAt, enabledAt, state: "ready",
    text: `Supervision was stopped for this conversation at ${new Date(stoppedAt).toISOString()}. Stop sending updates, findings and workflow acceptances to Supervisor ${binding.threadId}. This does not change your task or the user's instructions; a later explicit Enable takes precedence. Do not reply to this notice.`,
  }));
export type SupervisionStartRecord = {
  threadId: string; projectId: string; operationId: string; requestHash: string; route: "agent" | "ui";
  status: "pending" | "active" | "rejected"; reason: string; intentAt: number; modeGeneration: number; masterGeneration: number;
  source?: {messageId: string; runId: string; ordinal: number; hash: string}; taskId: string | null; taskPrepared?: boolean;
};
export type SupervisorBaseline = {version?: 2; snapshotSequence: number; threads: Array<{id: string; latestRunId: string | null}>};
export type SupervisionFolderPresence = {status: "present" | "missing" | "unavailable"; message?: string};
/** Native positions from which workflow protocol records belong to a task source revision: the service prompt that gave the
 * Supervisor this revision (and its own native run once observed) and, after a source edit, the last main run and turn item seen with the edit. */
export type ProtocolAnchor = {supervisorThreadId: string; sourceHash: string; promptMessageId: string; promptRun?: {id: string; ordinal: number}; editedAfter?: {runOrdinal: number; itemOrdinal: number | null} | null};
export type TaskRecord = TaskInterpretationInfo & TaskInterpretationFields & {id: string; sourceHash: string; /** Earlier unresolved genuine requests in the same main that this task continues. */ contextMessageIds?: string[]; /** observedAt of the Supervisor protocol diagnostic last sent as a focused repair request. */ protocolRepairNoticeAt?: number; agreementSourceHash?: string; requestText: string; supervisorThreadId: string; messageId: string; dispatchedAt: number | null; replayCount: number; supervisorRunId: string | null; sourceOrdinal: number; definitionContext?: ProposalContext | null; definitionSnapshot?: ProjectDefinitionSnapshot | null; definitionNoticeKey?: string; definitionReadAttempts?: number; revalidationAttempts?: number; workflowProtocolDiagnostic?: WorkflowProtocolDiagnostic | null; protocolAnchor?: ProtocolAnchor; /** Version of the standing instructions the interpretation request carried; its completed run delivers them. */ roleVersion?: string};

// the permanent root and helper ownership of the process: each supervision run's store layer adds the stored ids when it is
// acquired, before that run filters the catalog, and adds a newly owned id after the commit that recorded it (cc-ownership)
export class SupervisorOwnership extends Context.Service<SupervisorOwnership, Set<string>>()("t3-supervisor/SupervisorOwnership") {
  static readonly layer: Layer.Layer<SupervisorOwnership> = Layer.sync(SupervisorOwnership, () => new Set<string>());
}
/** A Supervisor root or helper thread, or one descending from it, by the root prefix or the permanent ownership set. */
export const isSupervisorThread = (owned: ReadonlySet<string>, thread: {id: string; lineage: {parentThreadId: string | null; rootThreadId?: unknown}}): boolean => {
  const supervisorId = (id: unknown): boolean => typeof id === "string" &&
    (id.startsWith(SUPERVISOR_ROOT_THREAD_PREFIX) || owned.has(id));
  return supervisorId(thread.id) || supervisorId(thread.lineage.rootThreadId) || supervisorId(thread.lineage.parentThreadId);
};

const normalizeMonitoringSettings = (value: SupervisorMonitoringSettings | undefined): SupervisorMonitoringSettings => value
  ? {intervalMinutes: value.intervalMinutes, activityThreshold: value.activityThreshold}
  : {...defaultMonitoringSettings};

const validMonitoringSettings = (value: SupervisorMonitoringSettings): boolean =>
  Number.isInteger(value.intervalMinutes) && value.intervalMinutes >= 1 && value.intervalMinutes <= 60 &&
  Number.isInteger(value.activityThreshold) && value.activityThreshold >= 3 && value.activityThreshold <= 100;

export type ProjectSupervisorStoreReason = "no_project_control_conflict" | "global_definitions_control_conflict" | "supervision_control_conflict" |
  "supervision_control_baseline_required" | "project_settings_conflict" | "invalid_monitoring_settings" | "invalid_team_settings" |
  "supervisor_capacity" | "supervisor_not_missing" | "supervisor_task_capacity" | "supervision_store_unavailable" | "supervision_row_invalid";
export type ProjectSupervisorRow = "meta" | "binding" | "task" | "project_settings" | "owned_thread" | "chat_enable" | "definition_save" | "count" | "table_info";

// a refusal keeps the baseline store's code as its message; a database failure carries no query, value or driver text,
// and an unreadable stored row names its kind and is never read as absent
export class ProjectSupervisorStoreError extends Data.TaggedError("ProjectSupervisorStoreError")<{
  readonly reason: ProjectSupervisorStoreReason;
  readonly row?: ProjectSupervisorRow | undefined;
}> {
  override readonly message: string = this.reason;
}

export type SupervisionStartOperation = {threadId: string; operationId: string; requestHash: string; status: "pending" | "active" | "rejected" | "denied" | "unavailable"; reason: string; preparing?: boolean};
type SupervisionStop = BindingRecord["supervisionStop"];
type NoProjectControlRecord = {generation: number; mode: NoProjectModeValue; globallyEnabled: boolean; baseline?: SupervisorBaseline};
type StoreFailure = ProjectSupervisorStoreError | SqlError.SqlError;
type StoreEffect<A> = Effect.Effect<A, ProjectSupervisorStoreError>;

/** The project supervision store; each method joins the caller's transaction when it runs inside one. */
export interface ProjectSupervisorStoreShape {
  /** Whether the stored supervision scope is this version's; read once when the layer is built. */
  readonly scopeCompatible: boolean;
  /** Permanent root and helper ownership: preloaded when the layer is built, extended only after the outermost commit. */
  readonly ownedIds: ReadonlySet<string>;
  /** Records a registered helper as Supervisor-owned; it joins ownedIds only after the outermost commit (cc-owned). */
  readonly recordOwnedThread: (threadId: string) => StoreEffect<void>;
  readonly chatEnabledAt: (threadId: string) => StoreEffect<number | null>;
  readonly recordChatEnable: (threadId: string, at: number) => StoreEffect<void>;
  readonly noProjectControl: () => StoreEffect<NoProjectControlRecord>;
  readonly saveNoProjectControl: (expectedGeneration: number, mode: NoProjectModeValue, baseline: SupervisorBaseline) => StoreEffect<void>;
  readonly start: (threadId: string) => StoreEffect<SupervisionStartRecord | null>;
  /** Every recorded Start, in stored order; a record that does not decode fails the read. */
  readonly starts: () => StoreEffect<ReadonlyArray<SupervisionStartRecord>>;
  readonly startOperation: (threadId: string, operationId: string) => StoreEffect<SupervisionStartOperation | null>;
  readonly saveStartOperation: (value: SupervisionStartOperation) => StoreEffect<void>;
  readonly saveStart: (value: SupervisionStartRecord) => StoreEffect<void>;
  readonly chatStop: (threadId: string) => StoreEffect<SupervisionStop | null>;
  readonly saveUnboundStop: (threadId: string, stop: SupervisionStop | null) => StoreEffect<void>;
  readonly activation: (sequence?: number) => StoreEffect<number | null>;
  readonly baseline: (value?: SupervisorBaseline) => StoreEffect<SupervisorBaseline | null>;
  readonly baselineOrdinal: (threadId: string, projection: Projection) => StoreEffect<number | null>;
  readonly projectBoundary: (projectId: string) => StoreEffect<SupervisorBaseline | null>;
  readonly folderPresenceNeedsBoundary: (projectId: string) => StoreEffect<boolean>;
  readonly setFolderPresence: (projectId: string, presence: SupervisionFolderPresence) => Effect.Effect<void>;
  readonly clearFolderPresence: (projectId: string) => Effect.Effect<void>;
  readonly recordFolderPresence: (projectId: string, presence: SupervisionFolderPresence, baseline?: SupervisorBaseline) => StoreEffect<void>;
  readonly autoControlInitialized: (projectId: string) => StoreEffect<boolean>;
  readonly isManual: (projectId: string) => StoreEffect<boolean>;
  readonly control: (projectId: string | null) => StoreEffect<SupervisionControlInfo>;
  readonly setGlobalFolderPresence: (presence: SupervisionFolderPresence) => Effect.Effect<void>;
  readonly globalDefinitionsControl: (homePath?: string) => StoreEffect<GlobalDefinitionsControlInfo>;
  readonly useGlobalDefinitions: (projectId?: string) => StoreEffect<boolean>;
  readonly saveGlobalDefinitionsControl: (expectedGeneration: number, enabled: boolean, homePath?: string, globalFingerprint?: string | null) => StoreEffect<GlobalDefinitionsControlInfo>;
  readonly hasGlobalDefinitionsEvent: () => StoreEffect<boolean>;
  readonly globalDefinitionsChangeAuthorized: (task: TaskRecord, globalFingerprint?: string | null) => StoreEffect<boolean>;
  readonly definitionUserGlobalToggle: (definitions: ProjectDefinitionSnapshot, approved: ProjectDefinitionSnapshot, after: number, globalFingerprint: string | null) => StoreEffect<boolean>;
  readonly enabled: (projectId: string) => StoreEffect<boolean>;
  readonly saveControl: (projectId: string | null, expectedGeneration: number, enabled: boolean, baseline?: SupervisorBaseline) => StoreEffect<SupervisionControlInfo>;
  readonly settings: (projectId: string) => StoreEffect<ProjectModelSettings>;
  readonly saveSettings: (projectId: string, expected: number, selection: SupervisorModelSelection, monitoring?: SupervisorMonitoringSettings, teamSettings?: {maxHelpersPerRoot: number}) => StoreEffect<ProjectModelSettings>;
  readonly modelState: (binding: BindingRecord) => StoreEffect<ProjectModelSettings>;
  readonly observeModel: (binding: BindingRecord, selection: SupervisorModelSelection, appliedGeneration?: number, message?: string | null) => StoreEffect<void>;
  readonly modelAttempt: (binding: BindingRecord, reset?: boolean) => StoreEffect<void>;
  readonly binding: (projectId: string, mainThreadId: string) => StoreEffect<BindingRecord | null>;
  readonly bindingForSupervisor: (threadId: string) => StoreEffect<BindingRecord | null>;
  readonly tasksFor: (binding: BindingRecord) => StoreEffect<TaskRecord[]>;
  readonly bindings: () => StoreEffect<BindingRecord[]>;
  readonly reserve: (projectId: string, mainThreadId: string, title: string, selection: SupervisorModelSelection, watermark: number, now: number) => StoreEffect<BindingRecord>;
  readonly setBinding: (value: BindingRecord) => StoreEffect<void>;
  readonly setSupervisionStop: (binding: BindingRecord, stop: SupervisionStop | null) => StoreEffect<void>;
  readonly setStopNotice: (binding: BindingRecord, expectedMessageId: string | null, notice: SupervisorStopNotice) => StoreEffect<void>;
  readonly replaceMissingBinding: (binding: BindingRecord, selection: SupervisorModelSelection) => StoreEffect<BindingRecord>;
  readonly task: (threadId: string) => StoreEffect<TaskRecord | null>;
  readonly tasks: (projectId: string) => StoreEffect<TaskRecord[]>;
  readonly saveTask: (task: TaskRecord) => StoreEffect<void>;
  readonly recordDefinitionUserSave: (definitions: ProjectDefinitionSnapshot, expectedRevision: string) => StoreEffect<void>;
  readonly definitionUserSave: (definitions: ProjectDefinitionSnapshot, approved: ProjectDefinitionSnapshot, after: number) => StoreEffect<boolean>;
  readonly recordGlobalDefinitionsPresence: (presence: SupervisionFolderPresence) => Effect.Effect<void>;
  readonly prune: (now: number) => StoreEffect<string[]>;
}

// row boundaries: the columns are decoded with Schema; a stored JSON document is parsed and checked against the fields its
// readers rely on, then kept whole, because every other field is user data written back byte for byte
const isStoredObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
export const isStoredBinding = Schema.is(Schema.Struct({projectId: Schema.String, mainThreadId: Schema.String, threadId: Schema.String, generation: Schema.Finite, state: Schema.String}));
const isStoredTask = Schema.is(Schema.Struct({threadId: Schema.String, projectId: Schema.String, status: Schema.String}));
const isStoredStart = Schema.is(Schema.Struct({threadId: Schema.String, status: Schema.String}));
const isStoredSettings = Schema.is(Schema.Struct({generation: Schema.Finite}));

const rowInvalid = (row: ProjectSupervisorRow) => () => new ProjectSupervisorStoreError({reason: "supervision_row_invalid", row});
const refuse = (reason: ProjectSupervisorStoreReason): Effect.Effect<never, ProjectSupervisorStoreError> => Effect.fail(new ProjectSupervisorStoreError({reason}));
const decodeValueRow = decodeRow(Schema.Struct({value: Schema.String}), rowInvalid("meta"));
const decodeKeyValueRow = decodeRow(Schema.Struct({key: Schema.String, value: Schema.String}), rowInvalid("meta"));
const decodeIdRow = decodeRow(Schema.Struct({id: Schema.String}), rowInvalid("owned_thread"));
const decodeCountRow = decodeRow(Schema.Struct({n: Schema.Finite}), rowInvalid("count"));
const decodeEnabledAtRow = decodeRow(Schema.Struct({enabled_at: Schema.Finite}), rowInvalid("chat_enable"));
const decodeDefinitionSaveRow = decodeRow(Schema.Struct({signature: Schema.String, saved_at: Schema.Finite, expected_revision: Schema.String}), rowInvalid("definition_save"));

// the supervision schema, statement for statement as the baseline constructor wrote it (the stored DDL text is golden)
const supervisionSchema = [
  "CREATE TABLE IF NOT EXISTS supervisor_owned_threads(id TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS supervisor_project_settings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS supervisor_main_bindings(project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(project_id,main_thread_id))",
  "CREATE TABLE IF NOT EXISTS supervisor_task_interpretations(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS supervisor_definition_user_saves(project_id TEXT NOT NULL,workspace_root TEXT NOT NULL,signature TEXT NOT NULL,saved_at INTEGER NOT NULL,expected_revision TEXT NOT NULL,PRIMARY KEY(project_id,workspace_root))",
  "CREATE TABLE IF NOT EXISTS supervisor_chat_enables(thread_id TEXT PRIMARY KEY,enabled_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS supervisor_tasks_project ON supervisor_task_interpretations(project_id)",
] as const;

const interruptedStartReason = "Start intake was interrupted before permission was reserved. Submit a new explicit request.";
const activeTaskStatuses: ReadonlyArray<string> = ["queued", "dispatching", "waiting"];
const expirableTaskStatuses: ReadonlyArray<string> = ["inferred", "needs_context", "not_supervised", "unavailable", "expired"];

const makeProjectSupervisorStore = Effect.gen(function* () {
  const sql = yield* GuidanceDb;
  const ids = yield* SupervisorIds;
  const reset = yield* SupervisorStateReset;
  // the process's ownership set, which the ownership readers hold by reference
  const owned = yield* SupervisorOwnership;
  const folderPresence = yield* Ref.make<ReadonlyMap<string, SupervisionFolderPresence>>(new Map());
  const globalFolderPresence = yield* Ref.make<SupervisionFolderPresence | null>(null);

  const unavailable = new ProjectSupervisorStoreError({reason: "supervision_store_unavailable"});
  const run = mapSqlError(() => unavailable);
  // a write is one transaction (BEGIN IMMEDIATE), or a savepoint of the caller's; a read of several statements reads one snapshot
  const write = <A>(body: Effect.Effect<A, StoreFailure>): StoreEffect<A> => run(sql.withTransaction(body));
  const read = <A>(body: Effect.Effect<A, StoreFailure>): StoreEffect<A> => run(snapshotRead(sql)(body));
  // ownership joins the shared set only once the outermost transaction commits; a rolled-back reservation leaves no id
  const adoptOwned = (threadId: string) => sql.afterCommit(Effect.sync(() => {owned.add(threadId);}));

  const metaValue = Effect.fnUntraced(function* (key: string) {
    const [row] = yield* sql`SELECT value FROM meta WHERE key=${key}`;
    return row === undefined ? undefined : (yield* decodeValueRow(row)).value;
  });
  const metaDocument = Effect.fnUntraced(function* <A>(key: string, guard: (value: unknown) => boolean = isStoredObject) {
    const value = yield* metaValue(key);
    return value === undefined ? null : yield* storedDocument<A, ProjectSupervisorStoreError>(value, guard, rowInvalid("meta"));
  });
  const putMeta = (key: string, value: string) => sql`INSERT INTO meta VALUES(${key},${value}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
  const deleteMeta = (key: string) => sql`DELETE FROM meta WHERE key=${key}`;
  const metaExists = (key: string) => Effect.map(sql`SELECT 1 FROM meta WHERE key=${key}`, (rows) => rows.length > 0);
  const countOf = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
    statement.pipe(Effect.flatMap(([row]) => decodeCountRow(row)), Effect.map((row) => row.n));
  const documents = <A>(rows: ReadonlyArray<unknown>, guard: (value: unknown) => boolean, row: ProjectSupervisorRow) => documentRows<A, ProjectSupervisorStoreError>(rows, guard, rowInvalid(row));

  const controlKey = (projectId: string | null) => `supervisor_control:${JSON.stringify(projectId)}`;
  const presenceUnavailableKey = (projectId: string) => `supervisor_control_presence_unavailable:${JSON.stringify(projectId)}`;
  const autoKey = (projectId: string) => `supervisor_control_auto:${JSON.stringify(projectId)}`;
  const startKey = (threadId: string) => `supervisor_start:${threadId}`;
  const startOperationKey = (threadId: string, operationId: string) => `supervisor_start_operation:${JSON.stringify([threadId, operationId])}`;
  const unboundStopKey = (threadId: string) => `supervisor_unbound_stop:${threadId}`;

  // ---- reads and writes shared by the methods; each runs in the transaction of the method that uses it

  const bindingOf = Effect.fnUntraced(function* (projectId: string, mainThreadId: string) {
    const [row] = yield* sql`SELECT document FROM supervisor_main_bindings WHERE project_id=${projectId} AND main_thread_id=${mainThreadId}`;
    if (row === undefined) return null;
    return yield* documentRow<BindingRecord, ProjectSupervisorStoreError>(row, isStoredBinding, rowInvalid("binding"));
  });
  const bindingsOf = sql`SELECT document FROM supervisor_main_bindings ORDER BY project_id,main_thread_id`.pipe(
    Effect.flatMap((rows) => documents<BindingRecord>(rows, isStoredBinding, "binding")));
  const taskOf = Effect.fnUntraced(function* (threadId: string) {
    const [row] = yield* sql`SELECT document FROM supervisor_task_interpretations WHERE thread_id=${threadId}`;
    if (row === undefined) return null;
    return yield* documentRow<TaskRecord, ProjectSupervisorStoreError>(row, isStoredTask, rowInvalid("task"));
  });
  const tasksOf = (projectId: string) => sql`SELECT document FROM supervisor_task_interpretations WHERE project_id=${projectId} ORDER BY updated_at`.pipe(
    Effect.flatMap((rows) => documents<TaskRecord>(rows, isStoredTask, "task")));

  const settingsOf = Effect.fnUntraced(function* (projectId: string) {
    const [row] = yield* sql`SELECT document FROM supervisor_project_settings WHERE project_id=${projectId}`;
    const stored = row === undefined ? null : yield* documentRow<Omit<ProjectModelSettings, "monitoring" | "modelMutationGeneration"> & {monitoring?: SupervisorMonitoringSettings; modelMutationGeneration?: number}, ProjectSupervisorStoreError>(
      row, isStoredSettings, rowInvalid("project_settings"));
    return stored ? {...stored, modelMutationGeneration: stored.modelMutationGeneration ?? stored.generation, monitoring: normalizeMonitoringSettings(stored.monitoring), teamSettings: stored.teamSettings ?? {maxHelpersPerRoot: 5}} : {
      projectId, generation: 0, modelMutationGeneration: 0, modelSelection: defaultSupervisorModel, pending: false, monitoring: {...defaultMonitoringSettings}, teamSettings: {maxHelpersPerRoot: 5},
    } satisfies ProjectModelSettings;
  });
  const modelStateOf = (binding: BindingRecord) => binding.modelState ? Effect.succeed(binding.modelState) :
    Effect.map(settingsOf(binding.projectId), (settings): ProjectModelSettings => ({...settings, modelSelection: binding.initialModel, pending: false, applyAttempts: 0, applicationMessage: null}));

  const controlRecordOf = Effect.fnUntraced(function* (projectId: string | null) {
    const value = yield* metaDocument<{generation?: number; enabled?: boolean; manual?: boolean; baseline?: SupervisorBaseline}>(controlKey(projectId));
    if (!value) return projectId === null ? {generation: 0, enabled: true, manual: true} : {generation: 0, enabled: false, manual: false};
    return {generation: Number.isSafeInteger(value.generation) && value.generation! >= 0 ? value.generation! : 0,
      enabled: value.enabled === true, manual: projectId === null || value.manual !== false, ...(value.baseline ? {baseline: value.baseline} : {})} as {generation: number; enabled: boolean; manual: boolean; baseline?: SupervisorBaseline};
  });
  const storedBaseline = Effect.map(metaDocument<SupervisorBaseline>("supervisor_activation_baseline"), (baseline) => baseline?.version === 2 ? baseline : null);
  const activationOf = Effect.fnUntraced(function* (sequence?: number) {
    if (sequence !== undefined) yield* sql`INSERT OR IGNORE INTO meta VALUES('supervisor_activation_sequence',${String(sequence)})`;
    const value = yield* metaValue("supervisor_activation_sequence");
    return value === undefined ? null : Number(value);
  });
  const writeBaseline = (value: SupervisorBaseline) => putMeta("supervisor_activation_baseline", JSON.stringify({...value, version: 2}));
  const presenceNeedsBoundary = (projectId: string) => metaExists(presenceUnavailableKey(projectId));
  const autoRecordOf = (projectId: string) => metaDocument<{status?: unknown; enabled?: unknown}>(autoKey(projectId));

  const autoControlInitializedOf = Effect.fnUntraced(function* (projectId: string) {
    const auto = yield* autoRecordOf(projectId);
    if (!auto) return false;
    if (auto.status === "missing") return auto.enabled === false;
    if (auto.status === "present" && auto.enabled === true)
      return Boolean((yield* controlRecordOf(projectId)).baseline || (yield* storedBaseline)) && !(yield* presenceNeedsBoundary(projectId));
    return false;
  });

  const controlOf = Effect.fnUntraced(function* (projectId: string | null) {
    const value = yield* controlRecordOf(projectId);
    const globallyEnabled = (yield* controlRecordOf(null)).enabled;
    if (projectId === null) return {projectId, generation: value.generation, enabled: value.enabled, manual: true, globallyEnabled,
      effectiveEnabled: value.enabled, detectionStatus: "not_checked", detectionError: null} satisfies SupervisionControlInfo;
    const presence = (yield* Ref.get(folderPresence)).get(projectId);
    const auto = yield* autoRecordOf(projectId);
    const storedStatus = auto?.status === "present" || auto?.status === "missing" ? auto.status : null;
    const boundaryMissing = !value.manual && auto?.status === "present" && auto.enabled === true &&
      (!value.baseline && !(yield* storedBaseline) || (yield* presenceNeedsBoundary(projectId)));
    const detectionStatus = boundaryMissing ? "unavailable" as const : value.manual ? presence?.status ?? "not_checked" as const : storedStatus ?? presence?.status ?? "not_checked" as const;
    const enabled = value.manual ? value.enabled : auto?.enabled === true && !boundaryMissing;
    return {projectId, generation: value.generation, enabled, manual: value.manual, globallyEnabled,
      effectiveEnabled: enabled && globallyEnabled, detectionStatus,
      detectionError: boundaryMissing ? "The project folder is present, but a native enable boundary must be captured before auto-enabling supervision." :
        detectionStatus === "unavailable" ? presence?.message ?? "The project .t3-supervisor folder could not be checked." : null} satisfies SupervisionControlInfo;
  });

  const noProjectControlOf = Effect.gen(function* () {
    const stored = yield* metaDocument<Omit<NoProjectControlRecord, "globallyEnabled">>("supervisor_no_project");
    return {...(stored ?? {generation: 0, mode: "on_request" as const}), globallyEnabled: (yield* controlOf(null)).enabled} as NoProjectControlRecord;
  });

  const globalDefinitionsRecordOf = Effect.gen(function* () {
    const value = yield* metaDocument<{generation?: number; enabled?: boolean; manual?: boolean}>("supervisor_global_definitions_control");
    if (!value) return {generation: 0, enabled: false, manual: false};
    return {generation: Number.isSafeInteger(value.generation) && value.generation! >= 0 ? value.generation! : 0,
      enabled: value.enabled === true, manual: value.manual === true};
  });
  const globalDefinitionsEventOf = metaDocument<{generation?: number; enabled?: boolean; changedAt?: number; globalFingerprint?: string | null}>("supervisor_global_definitions_event");
  const globalDefinitionsControlOf = Effect.fnUntraced(function* (homePath: string) {
    const value = yield* globalDefinitionsRecordOf;
    const presence = yield* Ref.get(globalFolderPresence);
    const detectionStatus = presence?.status ?? "not_checked" as const;
    return {generation: value.generation, enabled: value.enabled, manual: value.manual, effectiveEnabled: value.enabled && (yield* controlOf(null)).enabled,
      homePath, detectionStatus, detectionError: detectionStatus === "unavailable" ? presence?.message ?? "The server-user .t3-supervisor folder could not be checked." : null} satisfies GlobalDefinitionsControlInfo;
  });

  const saveStartOperationOf = (value: SupervisionStartOperation) => putMeta(startOperationKey(value.threadId, value.operationId), JSON.stringify(value));
  const saveStartOf = Effect.fnUntraced(function* (value: SupervisionStartRecord) {
    yield* saveStartOperationOf({threadId: value.threadId, operationId: value.operationId, requestHash: value.requestHash, status: value.status, reason: value.reason});
    yield* putMeta(startKey(value.threadId), JSON.stringify(value));
  });
  const chatStopOf = Effect.fnUntraced(function* (threadId: string) {
    const binding = (yield* bindingsOf).find((item) => item.mainThreadId === threadId);
    if (binding) return binding.supervisionStop ?? null;
    return yield* metaDocument<NonNullable<SupervisionStop>>(unboundStopKey(threadId));
  });
  const saveUnboundStopOf = (threadId: string, stop: SupervisionStop | null) =>
    stop ? putMeta(unboundStopKey(threadId), JSON.stringify(stop)) : deleteMeta(unboundStopKey(threadId));

  // preserve exact notice objects, including null epoch fields, across stale lifecycle writes
  const setBindingOf = Effect.fnUntraced(function* (value: BindingRecord) {
    const current = yield* bindingOf(value.projectId, value.mainThreadId);
    const next = {...value};
    for (const key of ["stopNotice", "supervisionStop"] as const) {
      if (current?.[key] !== undefined) Object.assign(next, {[key]: current[key]});
      else delete next[key];
    }
    yield* sql`UPDATE supervisor_main_bindings SET document=${JSON.stringify(next)} WHERE project_id=${value.projectId} AND main_thread_id=${value.mainThreadId}`;
  });

  const saveTaskOf = Effect.fnUntraced(function* (task: TaskRecord) {
    if (!(yield* taskOf(task.threadId))) {
      // capacity counts only new rows: 10,000 in total, 100 queued, dispatching or waiting per project
      if ((yield* countOf(sql`SELECT count(*) AS n FROM supervisor_task_interpretations`)) >= 10_000 ||
        (yield* tasksOf(task.projectId)).filter((value) => activeTaskStatuses.includes(value.status)).length >= 100) return yield* refuse("supervisor_task_capacity");
    }
    yield* sql`INSERT INTO supervisor_task_interpretations VALUES(${task.threadId},${task.projectId},${JSON.stringify(task)},${task.updatedAt}) ON CONFLICT(thread_id) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at`;
  });
  const ownedCount = countOf(sql`SELECT count(*) AS n FROM supervisor_owned_threads`);

  // ---- the methods

  const chatEnabledAt = (threadId: string) => run(Effect.gen(function* () {
    const [row] = yield* sql`SELECT enabled_at FROM supervisor_chat_enables WHERE thread_id=${threadId}`;
    return row === undefined ? null : (yield* decodeEnabledAtRow(row)).enabled_at;
  }));
  const recordChatEnable = (threadId: string, at: number) =>
    run(Effect.asVoid(sql`INSERT INTO supervisor_chat_enables VALUES(${threadId},${at}) ON CONFLICT(thread_id) DO UPDATE SET enabled_at=max(enabled_at,excluded.enabled_at)`));
  const noProjectControl = () => read(noProjectControlOf);
  // every recorded Start in stored order, each decoded
  const startsOf = Effect.flatMap(sql`SELECT value FROM meta WHERE key LIKE 'supervisor_start:%'`, (rows) => Effect.forEach(rows, (row) =>
    Effect.flatMap(decodeValueRow(row), ({value}) => storedDocument<SupervisionStartRecord, ProjectSupervisorStoreError>(value, isStoredStart, rowInvalid("meta")))));
  const saveNoProjectControl = (expectedGeneration: number, mode: NoProjectModeValue, baseline: SupervisorBaseline) => write(Effect.gen(function* () {
    if ((yield* noProjectControlOf).generation !== expectedGeneration) return yield* refuse("no_project_control_conflict");
    for (const start of yield* startsOf) {
      if (start.status === "pending") yield* saveStartOf({...start, status: "rejected", reason: "Superseded by a No Project mode change."});
    }
    yield* putMeta("supervisor_no_project", JSON.stringify({generation: expectedGeneration + 1, mode, baseline}));
  }));
  const start = (threadId: string) => run(metaDocument<SupervisionStartRecord>(startKey(threadId), isStoredStart));
  const starts = () => read(startsOf);
  const startOperation = (threadId: string, operationId: string) => run(metaDocument<SupervisionStartOperation>(startOperationKey(threadId, operationId)));
  const saveStartOperation = (value: SupervisionStartOperation) => run(Effect.asVoid(saveStartOperationOf(value)));
  // the receipt and the record commit together, so no reader sees a record without its receipt (ct-pss-08)
  const saveStart = (value: SupervisionStartRecord) => write(saveStartOf(value));
  const chatStop = (threadId: string) => read(chatStopOf(threadId));
  const saveUnboundStop = (threadId: string, stop: SupervisionStop | null) => run(Effect.asVoid(saveUnboundStopOf(threadId, stop)));
  const activation = (sequence?: number) => sequence === undefined ? run(activationOf()) : write(activationOf(sequence));
  // version 2 only; the first baseline wins and records its activation sequence
  const baseline = (value?: SupervisorBaseline) => value ? write(Effect.gen(function* () {
    if (!(yield* storedBaseline)) yield* writeBaseline(value);
    yield* activationOf(value.snapshotSequence);
    return yield* storedBaseline;
  })) : run(storedBaseline);
  // fails closed (null) when a recorded anchor run is missing from the projection
  const baselineOrdinal = (threadId: string, projection: Projection) => read(Effect.gen(function* () {
    const activationBaseline = yield* storedBaseline;
    if (!activationBaseline) return null;
    const baselines = [activationBaseline, (yield* controlRecordOf(null)).baseline, (yield* controlRecordOf(projection.thread.projectId ?? "")).baseline];
    let floor = 0;
    for (const value of baselines) {
      const anchor = value?.threads.find((thread) => thread.id === threadId)?.latestRunId;
      if (!anchor) continue;
      const ordinal = projection.runs.find((run) => run.id === anchor && run.threadId === threadId)?.ordinal;
      if (ordinal === undefined) return null;
      floor = Math.max(floor, ordinal);
    }
    return floor;
  }));
  const projectBoundary = (projectId: string) => run(Effect.map(controlRecordOf(projectId), (value) => value.baseline ?? null));
  const folderPresenceNeedsBoundary = (projectId: string) => run(presenceNeedsBoundary(projectId));
  const setFolderPresence = (projectId: string, presence: SupervisionFolderPresence) =>
    Ref.update(folderPresence, (current) => new Map(current).set(projectId, presence));
  const clearFolderPresence = (projectId: string) => Ref.update(folderPresence, (current) => {
    const next = new Map(current);
    next.delete(projectId);
    return next;
  });
  // the first durable auto-detection result of a project; checks and writes are one transaction
  const recordFolderPresence = (projectId: string, presence: SupervisionFolderPresence, baseline?: SupervisorBaseline) => Effect.andThen(
    setFolderPresence(projectId, presence),
    write(Effect.gen(function* () {
      if ((yield* controlRecordOf(projectId)).manual || (yield* autoControlInitializedOf(projectId))) return;
      if (presence.status === "unavailable") {
        if (!(yield* presenceNeedsBoundary(projectId))) yield* putMeta(presenceUnavailableKey(projectId), JSON.stringify({checkedAt: yield* Clock.currentTimeMillis}));
        return;
      }
      if (presence.status === "present" && ((yield* presenceNeedsBoundary(projectId)) && !baseline ||
        !(yield* controlRecordOf(projectId)).baseline && !baseline && !(yield* storedBaseline))) return;
      if (presence.status === "present" && baseline) {
        if ((yield* storedBaseline) === null) {
          yield* writeBaseline(baseline);
          yield* activationOf(baseline.snapshotSequence);
        }
        const control = yield* controlRecordOf(projectId);
        yield* putMeta(controlKey(projectId), JSON.stringify({...control, baseline}));
      }
      yield* putMeta(autoKey(projectId), JSON.stringify({status: presence.status, enabled: presence.status === "present", checkedAt: yield* Clock.currentTimeMillis}));
      yield* deleteMeta(presenceUnavailableKey(projectId));
      yield* sql.afterCommit(clearFolderPresence(projectId));
    })));
  const autoControlInitialized = (projectId: string) => read(autoControlInitializedOf(projectId));
  const isManual = (projectId: string) => run(Effect.map(controlRecordOf(projectId), (value) => value.manual));
  const control = (projectId: string | null) => read(controlOf(projectId));
  const setGlobalFolderPresence = (presence: SupervisionFolderPresence) => Ref.set(globalFolderPresence, presence);
  const globalDefinitionsControl = (homePath = "~/.t3-supervisor") => read(globalDefinitionsControlOf(homePath));
  const useGlobalDefinitions = (_projectId?: string) => run(Effect.map(globalDefinitionsRecordOf, (value) => value.enabled));
  // the generation CAS, the event and every task it stales or refreshes commit together (ct-pss-04)
  const saveGlobalDefinitionsControl = (expectedGeneration: number, enabled: boolean, homePath = "~/.t3-supervisor", globalFingerprint: string | null = null) => write(Effect.gen(function* () {
    const current = yield* globalDefinitionsRecordOf;
    if (current.generation !== expectedGeneration) return yield* refuse("global_definitions_control_conflict");
    const generation = current.generation + 1;
    const changedAt = yield* Clock.currentTimeMillis;
    yield* putMeta("supervisor_global_definitions_control", JSON.stringify({generation, enabled, manual: true}));
    if (current.enabled !== enabled) {
      yield* putMeta("supervisor_global_definitions_event", JSON.stringify({generation, enabled, changedAt, globalFingerprint}));
      const tasks = yield* sql`SELECT document FROM supervisor_task_interpretations`.pipe(Effect.flatMap((rows) => documents<TaskRecord>(rows, isStoredTask, "task")));
      for (const task of tasks) {
        if (task.status === "queued" && task.dispatchedAt === null && task.definitionContext !== undefined) {
          const refresh: {-readonly [K in keyof TaskRecord]: TaskRecord[K]} = {...task, requestText: "", reason: "Global definition inclusion changed; definitions will be refreshed before dispatch.", updatedAt: changedAt,
            workflow: {status: "pending", message: "Global definition inclusion changed; refresh the complete definitions before sending this task.", workspaceRoot: null, revision: null, globalRevision: null,
              definitionsStatus: "unavailable", definitionsComplete: false, requirementsKnown: false, requirements: [], issues: [], plan: null}};
          delete refresh.definitionContext;delete refresh.definitionSnapshot;delete refresh.definitionReadAttempts;delete refresh.revalidationAttempts;
          yield* saveTaskOf(refresh);
          continue;
        }
        if (task.status !== "inferred" || !task.workflow?.revision) continue;
        const message = "The user changed whether global definitions are included. The old plan and agreement are retained as stale history.";
        yield* saveTaskOf({...task, workflow: {...task.workflow, status: "stale", message},
          ...(task.agreement ? {agreement: {...task.agreement, status: "stale", message}} : {}),
          definitionReview: {status: "checking", message, expectedRevision: task.workflow.revision, observedRevision: null,
            supervisorMessageId: null, userMessageIds: [], updatedAt: changedAt}, updatedAt: changedAt});
      }
    }
    return yield* globalDefinitionsControlOf(homePath);
  }));
  const hasGlobalDefinitionsEvent = () => run(metaExists("supervisor_global_definitions_event"));
  const globalDefinitionsChangeAuthorized = (task: TaskRecord, globalFingerprint?: string | null) => read(Effect.gen(function* () {
    const event = yield* globalDefinitionsEventOf;
    if (!event || !task.definitionSnapshot || task.definitionSnapshot.status !== "ready" || !task.definitionSnapshot.complete ||
      task.definitionReview?.status !== "authorized" || !task.workflow?.revision) return false;
    return event.enabled === (yield* globalDefinitionsRecordOf).enabled && Number.isFinite(event.changedAt) &&
      Boolean(event.globalFingerprint) && task.definitionReview.updatedAt >= event.changedAt! && task.workflow.revision === task.definitionSnapshot.revision &&
      task.workflow.globalRevision === (task.definitionSnapshot.globalRevision ?? null) &&
      (!event.enabled || task.definitionSnapshot.globalRevision === event.globalFingerprint &&
        (globalFingerprint === undefined || globalFingerprint === event.globalFingerprint));
  }));
  const definitionUserGlobalToggle = (definitions: ProjectDefinitionSnapshot, approved: ProjectDefinitionSnapshot, after: number, globalFingerprint: string | null) => read(Effect.gen(function* () {
    const event = yield* globalDefinitionsEventOf;
    if (!event || !("projectConfig" in definitions) || !("projectConfig" in approved) || definitions.status !== "ready" || approved.status !== "ready" || !definitions.complete || !approved.complete || definitions.projectId !== approved.projectId ||
      definitions.threadId !== approved.threadId || definitions.workspaceRoot !== approved.workspaceRoot) return false;
    if (event.enabled !== (yield* globalDefinitionsRecordOf).enabled || !Number.isFinite(event.changedAt) || event.changedAt! < after ||
      !event.globalFingerprint || event.globalFingerprint !== globalFingerprint) return false;
    if (event.enabled && definitions.globalRevision !== event.globalFingerprint) return false;
    if (!event.enabled && approved.globalRevision !== event.globalFingerprint) return false;
    const hasOrigins = (values: ReadonlyArray<{origin?: string | undefined}>) => values.every((value) => value.origin === "global" || value.origin === "project");
    const local = <A extends {origin?: string | undefined}>(values: ReadonlyArray<A>) => values.filter((value) => value.origin === "project");
    return hasOrigins(definitions.steps) && hasOrigins(approved.steps) && hasOrigins(definitions.workflows) && hasOrigins(approved.workflows) &&
      fingerprint(local(definitions.steps)) === fingerprint(local(approved.steps)) &&
      fingerprint(local(definitions.workflows)) === fingerprint(local(approved.workflows)) &&
      fingerprint(definitions.projectConfig) === fingerprint(approved.projectConfig);
  }));
  const enabled = (projectId: string) => read(Effect.map(controlOf(projectId), (value) => value.effectiveEnabled));
  // the generation CAS; enabling needs a native baseline and clears the presence-unavailable marker
  const saveControl = (projectId: string | null, expectedGeneration: number, enabledValue: boolean, baselineValue?: SupervisorBaseline) => write(Effect.gen(function* () {
    const current = yield* controlRecordOf(projectId);
    if (current.generation !== expectedGeneration) return yield* refuse("supervision_control_conflict");
    if (enabledValue && !(yield* controlOf(projectId)).enabled && (projectId === null || (yield* controlRecordOf(null)).enabled) && !baselineValue)
      return yield* refuse("supervision_control_baseline_required");
    if (baselineValue && (yield* storedBaseline) === null) {
      yield* writeBaseline(baselineValue);
      yield* activationOf(baselineValue.snapshotSequence);
    }
    const next = {...current, enabled: enabledValue, manual: true, generation: current.generation + 1,
      ...(enabledValue && !current.enabled && baselineValue ? {baseline: baselineValue} : {})};
    yield* putMeta(controlKey(projectId), JSON.stringify(next));
    if (projectId !== null) yield* deleteMeta(presenceUnavailableKey(projectId));
    return yield* controlOf(projectId);
  }));
  const settings = (projectId: string) => run(settingsOf(projectId));
  // the settings generation CAS with range checks: monitoring 1..60 minutes and 3..100 activities, helpers 0..20
  const saveSettings = (projectId: string, expected: number, selection: SupervisorModelSelection, monitoring?: SupervisorMonitoringSettings, teamSettings?: {maxHelpersPerRoot: number}) => write(Effect.gen(function* () {
    const old = yield* settingsOf(projectId);
    if (old.generation !== expected) return yield* refuse("project_settings_conflict");
    const nextMonitoring = normalizeMonitoringSettings(monitoring ?? old.monitoring);
    if (!validMonitoringSettings(nextMonitoring)) return yield* refuse("invalid_monitoring_settings");
    const nextTeamSettings = teamSettings ?? old.teamSettings ?? {maxHelpersPerRoot: 5};
    if (!Number.isSafeInteger(nextTeamSettings.maxHelpersPerRoot) || nextTeamSettings.maxHelpersPerRoot < 0 || nextTeamSettings.maxHelpersPerRoot > 20)
      return yield* refuse("invalid_team_settings");
    const modelChanged = !sameModel(old.modelSelection, selection);
    const next: ProjectModelSettings = {
      ...old,
      projectId,
      generation: expected + 1,
      modelMutationGeneration: old.modelMutationGeneration + (modelChanged ? 1 : 0),
      modelSelection: selection,
      monitoring: nextMonitoring,
      teamSettings: nextTeamSettings,
      pending: false,
      ...(modelChanged ? {applyAttempts: 0, applicationMessage: null} : {}),
    };
    yield* sql`INSERT INTO supervisor_project_settings VALUES(${projectId},${JSON.stringify(next)}) ON CONFLICT(project_id) DO UPDATE SET document=excluded.document`;
    return next;
  }));
  const modelState = (binding: BindingRecord) => run(modelStateOf(binding));
  // the binding read and its rewrite are one transaction
  const observeModel = (binding: BindingRecord, selection: SupervisorModelSelection, appliedGeneration?: number, message?: string | null) => write(Effect.gen(function* () {
    const latest = yield* bindingOf(binding.projectId, binding.mainThreadId);
    if (!latest || latest.threadId !== binding.threadId) return;
    const old = yield* modelStateOf(latest);
    if (old.pending && old.generation !== appliedGeneration) return;
    const changed = !sameModel(old.modelSelection, selection);
    yield* setBindingOf({...latest, modelState: {...old, modelSelection: selection, pending: false,
      applicationMessage: message === undefined ? old.applicationMessage ?? null : message,
      generation: old.generation + (!old.pending && changed ? 1 : 0)}});
  }));
  const modelAttempt = (binding: BindingRecord, reset = false) => write(Effect.gen(function* () {
    const latest = yield* bindingOf(binding.projectId, binding.mainThreadId);
    if (!latest || latest.threadId !== binding.threadId) return;
    const old = yield* modelStateOf(latest);
    yield* setBindingOf({...latest, modelState: {...old, applyAttempts: reset ? 0 : (old.applyAttempts ?? 0) + 1,
      applicationMessage: reset ? null : "Native model application is unresolved. Retry native access after checking T3."}});
  }));
  const binding = (projectId: string, mainThreadId: string) => run(bindingOf(projectId, mainThreadId));
  const bindingForSupervisor = (threadId: string) => run(Effect.map(bindingsOf, (values) => values.find((value) => value.threadId === threadId) ?? null));
  const tasksFor = (value: BindingRecord) => run(Effect.map(tasksOf(value.projectId), (tasks) => tasks.filter((task) => task.supervisorThreadId === value.threadId)));
  const bindings = () => run(bindingsOf);
  // idempotent per (project, main); the owned row, the binding and the unbound-stop transfer commit together
  const reserve = (projectId: string, mainThreadId: string, title: string, selection: SupervisorModelSelection, watermark: number, now: number) => write(Effect.gen(function* () {
    const old = yield* bindingOf(projectId, mainThreadId);
    if (old) {
      yield* adoptOwned(old.threadId);
      return old;
    }
    if ((yield* ownedCount) >= 1000) return yield* refuse("supervisor_capacity");
    const value: BindingRecord = {projectId, mainThreadId, threadId: `${SUPERVISOR_ROOT_THREAD_PREFIX}${yield* ids.uuid}`, modelState: {...(yield* settingsOf(projectId)), modelSelection: selection, pending: false}, title: `Supervisor · ${title.slice(0,160)}`, generation: 1, enabledAt: now,
      enableAfterSequence: watermark, initialModel: selection, creationAttempts: 0, state: "creating"};
    const stop = yield* chatStopOf(mainThreadId);
    if (stop) value.supervisionStop = stop;
    yield* saveUnboundStopOf(mainThreadId, null);
    yield* sql`INSERT INTO supervisor_owned_threads VALUES(${value.threadId})`;
    yield* sql`INSERT INTO supervisor_main_bindings VALUES(${projectId},${mainThreadId},${JSON.stringify(value)})`;
    yield* adoptOwned(value.threadId);
    return value;
  }));
  const setBinding = (value: BindingRecord) => write(setBindingOf(value));
  const setSupervisionStop = (value: BindingRecord, stop: SupervisionStop | null) => run(Effect.asVoid(stop
    ? sql`UPDATE supervisor_main_bindings SET document=json_set(json_remove(document,'$.manualKeepActive','$.stopObservedAt'),'$.supervisionStop',json(${JSON.stringify(stop)})) WHERE project_id=${value.projectId} AND main_thread_id=${value.mainThreadId}`
    : sql`UPDATE supervisor_main_bindings SET document=json_remove(document,'$.supervisionStop','$.stopObservedAt') WHERE project_id=${value.projectId} AND main_thread_id=${value.mainThreadId}`));
  // the notice CAS on the stored messageId; `IS` makes an expected null match only an absent notice
  const setStopNotice = (value: BindingRecord, expectedMessageId: string | null, notice: SupervisorStopNotice) => run(Effect.asVoid(
    sql`UPDATE supervisor_main_bindings SET document=json_set(document,'$.stopNotice',json(${JSON.stringify(notice)})) WHERE project_id=${value.projectId} AND main_thread_id=${value.mainThreadId} AND json_extract(document,'$.stopNotice.messageId') IS ${expectedMessageId}`));
  // only from missing: a new root and generation 1; its agreed tasks become stale history in the same commit
  const replaceMissingBinding = (value: BindingRecord, selection: SupervisorModelSelection) => value.state !== "missing" ? refuse("supervisor_not_missing") : write(Effect.gen(function* () {
    if ((yield* ownedCount) >= 1000) return yield* refuse("supervisor_capacity");
    const next: BindingRecord = {...value, settlementBlockedBy: null, threadId: `${SUPERVISOR_ROOT_THREAD_PREFIX}${yield* ids.uuid}`, generation: 1, initialModel: selection, modelState: {...(yield* settingsOf(value.projectId)), modelSelection: selection, pending: false}, quietSince: null,  creationAttempts: 0, state: "creating"};
    delete next.settlement;
    // the replacement conversation has seen no standing instructions and owns no settlement diagnosis yet
    delete next.deliveredRoleVersion;
    yield* sql`INSERT INTO supervisor_owned_threads VALUES(${next.threadId})`;
    yield* setBindingOf(next);
    for (const task of yield* tasksOf(value.projectId)) {
      if (task.supervisorThreadId !== value.threadId || task.agreement?.status !== "agreed") continue;
      yield* saveTaskOf({...task, agreement: {...task.agreement, status: "stale", message: "The bound Supervisor was replaced; this agreement is retained as history."}, updatedAt: yield* Clock.currentTimeMillis});
    }
    yield* adoptOwned(next.threadId);
    return next;
  }));
  const recordOwnedThread = (threadId: string) => run(Effect.andThen(sql`INSERT OR IGNORE INTO supervisor_owned_threads VALUES(${threadId})`, adoptOwned(threadId)));
  const task = (threadId: string) => run(taskOf(threadId));
  const tasks = (projectId: string) => run(tasksOf(projectId));
  // the capacity counts and the upsert are one transaction (ct-pss-02)
  const saveTask = (value: TaskRecord) => write(saveTaskOf(value));
  const recordDefinitionUserSave = (definitions: ProjectDefinitionSnapshot, expectedRevision: string) => Effect.gen(function* () {
    if (definitions.status !== "ready" || !definitions.complete || !definitions.revision || !expectedRevision || !definitions.projectConfig) return;
    const now = yield* Clock.currentTimeMillis;
    yield* write(Effect.gen(function* () {
      yield* sql`INSERT INTO supervisor_definition_user_saves VALUES(${definitions.projectId},${definitions.workspaceRoot},${fingerprint(definitions.projectConfig)},${now},${expectedRevision}) ON CONFLICT(project_id,workspace_root) DO UPDATE SET signature=excluded.signature,saved_at=excluded.saved_at,expected_revision=excluded.expected_revision`;
      for (const task of yield* tasksOf(definitions.projectId)) {
        if (task.status !== "inferred" || !task.workflow?.revision || task.workflow.workspaceRoot !== definitions.workspaceRoot) continue;
        const previousReview = task.definitionReview;
        const definitionReview: DefinitionReviewInfo = {
          status: "checking",
          message: "An explicit project configuration save is recorded. Definition edits remain subject to authorization review.",
          expectedRevision: task.workflow.revision,
          observedRevision: previousReview?.observedRevision ?? null,
          supervisorMessageId: null,
          userMessageIds: [],
          updatedAt: now,
        };
        yield* saveTaskOf({...task, workflow: {...task.workflow, status: "stale", message: "Project configuration was saved through the dashboard; the old plan needs revalidation."},
          ...(task.agreement ? {agreement: {...task.agreement, status: "stale", message: "Project configuration was explicitly saved; this agreement is retained as history."}} : {}),
          definitionReview, updatedAt: now});
      }
    }));
  });
  const definitionUserSave = (definitions: ProjectDefinitionSnapshot, approved: ProjectDefinitionSnapshot, after: number) => !("projectConfig" in definitions) || !("projectConfig" in approved)
    ? Effect.succeed(false) : read(Effect.gen(function* () {
      const [stored] = yield* sql`SELECT signature,saved_at,expected_revision FROM supervisor_definition_user_saves WHERE project_id=${definitions.projectId} AND workspace_root=${definitions.workspaceRoot}`;
      const row = stored === undefined ? undefined : yield* decodeDefinitionSaveRow(stored);
      const items: ReadonlyArray<{origin?: string | undefined}> = [...definitions.steps, ...definitions.workflows, ...approved.steps, ...approved.workflows];
      const originsKnown = items.every((item) => item.origin === "global" || item.origin === "project");
      const globalStepsUnchanged = fingerprint(definitions.steps.filter((step) => step.origin === "global")) === fingerprint(approved.steps.filter((step) => step.origin === "global"));
      const globalWorkflowsUnchanged = fingerprint(definitions.workflows.filter((workflow) => workflow.origin === "global")) === fingerprint(approved.workflows.filter((workflow) => workflow.origin === "global"));
      const expectedRevision = row?.expected_revision ?? null;
      const reviewedExpectedRevision = expectedRevision !== null && (yield* tasksOf(definitions.projectId)).some((task) =>
        task.threadId === definitions.threadId && task.workflow?.revision === approved.revision &&
        task.definitionReview?.expectedRevision === approved.revision && task.definitionReview.observedRevision === expectedRevision &&
        task.definitionReview.updatedAt >= after && task.definitionReview.updatedAt <= Number(row?.saved_at));
      return definitions.status === "ready" && approved.status === "ready" && definitions.complete && approved.complete && originsKnown &&
        globalStepsUnchanged && globalWorkflowsUnchanged && definitions.globalRevision === approved.globalRevision &&
        approved.projectId === definitions.projectId && approved.workspaceRoot === definitions.workspaceRoot &&
        fingerprint(definitions.steps) === fingerprint(approved.steps) && fingerprint(definitions.workflows) === fingerprint(approved.workflows) &&
        (expectedRevision === approved.revision || reviewedExpectedRevision) &&
        row?.signature === fingerprint(definitions.projectConfig) && Number(row.saved_at) >= after;
    }));
  const recordGlobalDefinitionsPresence = (presence: SupervisionFolderPresence) => setGlobalFolderPresence(presence);
  // 30 days; inferred tasks of ready bindings stay; payload fields are cleared, identities kept
  const prune = (now: number) => write(Effect.gen(function* () {
    const expiredIds: string[] = [];
    const stale = yield* sql`SELECT document FROM supervisor_task_interpretations WHERE updated_at<${now - 30 * 86400_000}`.pipe(
      Effect.flatMap((rows) => documents<TaskRecord>(rows, isStoredTask, "task")));
    for (const task of stale) {
      if (!expirableTaskStatuses.includes(task.status)) continue;
      if (task.status === "inferred" && (yield* bindingsOf).find((value) => value.threadId === task.supervisorThreadId)?.state === "ready") continue;
      const expired: {-readonly [K in keyof TaskRecord]: TaskRecord[K]} = {...task, status: "expired", objective: null, reason: "Interpretation evidence expired.", requestText: "", definitionContext: null, workflow: null, agreement: null, updatedAt: now};
      delete expired.workflowProposalId;
      delete expired.definitionSnapshot;
      delete expired.definitionReview;
      delete expired.definitionNoticeKey;
      yield* saveTaskOf(expired);
      expiredIds.push(task.id);
    }
    return expiredIds;
  }));

  // ---- acquisition, in the baseline constructor's order: ddl, the column addition, the scope reset, the preparing-Start
  // recovery and the ownership preload
  const scopeCompatible = yield* run(Effect.gen(function* () {
    for (const statement of supervisionSchema) yield* sql.unsafe(statement);
    if (!(yield* tableColumns(sql, "supervisor_definition_user_saves")).includes("expected_revision"))
      yield* sql.unsafe("ALTER TABLE supervisor_definition_user_saves ADD COLUMN expected_revision TEXT NOT NULL DEFAULT ''");
    // the approved one-time reset of the project-scoped prototype; an unknown stored scope disables supervision
    const compatible = yield* reset.initializeMainSupervisionState();
    // restart recovery: a Start intake that was still preparing is rejected; every other operation stays as stored
    yield* sql.withTransaction(Effect.gen(function* () {
      for (const row of yield* sql`SELECT key,value FROM meta WHERE key LIKE 'supervisor_start_operation:%'`) {
        const stored = yield* decodeKeyValueRow(row);
        const operation = yield* storedDocument<SupervisionStartOperation, ProjectSupervisorStoreError>(stored.value, isStoredObject, rowInvalid("meta"));
        if (operation.preparing) yield* sql`UPDATE meta SET value=${JSON.stringify({...operation, preparing: false, status: "rejected", reason: interruptedStartReason})} WHERE key=${stored.key}`;
      }
    }));
    for (const row of yield* sql`SELECT id FROM supervisor_owned_threads`) owned.add((yield* decodeIdRow(row)).id);
    return compatible;
  }));

  return {
    scopeCompatible, ownedIds: owned, recordOwnedThread, chatEnabledAt, recordChatEnable, noProjectControl, saveNoProjectControl, start, starts, startOperation, saveStartOperation,
    saveStart, chatStop, saveUnboundStop, activation, baseline, baselineOrdinal, projectBoundary, folderPresenceNeedsBoundary, setFolderPresence,
    clearFolderPresence, recordFolderPresence, autoControlInitialized, isManual, control, setGlobalFolderPresence, globalDefinitionsControl,
    useGlobalDefinitions, saveGlobalDefinitionsControl, hasGlobalDefinitionsEvent, globalDefinitionsChangeAuthorized, definitionUserGlobalToggle,
    enabled, saveControl, settings, saveSettings, modelState, observeModel, modelAttempt, binding, bindingForSupervisor, tasksFor, bindings, reserve,
    setBinding, setSupervisionStop, setStopNotice, replaceMissingBinding, task, tasks, saveTask, recordDefinitionUserSave, definitionUserSave,
    recordGlobalDefinitionsPresence, prune,
  } satisfies ProjectSupervisorStoreShape;
});

// effect/sql spans carry statement text, so the construction and every operation run untraced; the state reset runs on the
// guidance store's meta table, so both layers are built first
export class ProjectSupervisorStore extends Context.Service<ProjectSupervisorStore, ProjectSupervisorStoreShape>()("t3-supervisor/ProjectSupervisorStore") {
  static readonly layer: Layer.Layer<ProjectSupervisorStore, ProjectSupervisorStoreError | GuidanceStoreError, GuidanceDb | SupervisorIds | SupervisorOwnership | SupervisorStateReset> =
    Layer.effect(ProjectSupervisorStore, untracedSql(makeProjectSupervisorStore));
}

// the meta documents the project store reads, by key prefix (or exact key), with the guard its reader applies and when the run
// reads them
const metaDocumentKinds: ReadonlyArray<{readonly pattern: string; readonly kind: string; readonly guard: (value: unknown) => boolean; readonly read: StoredRowFinding["read"]}> = [
  {pattern: "supervisor_start_operation:%", kind: "start operation", guard: isStoredObject, read: "open"},
  {pattern: "supervisor_start:%", kind: "start", guard: isStoredStart, read: "cycle"},
  {pattern: "supervisor_control:%", kind: "control", guard: isStoredObject, read: "cycle"},
  {pattern: "supervisor_control_auto:%", kind: "auto control", guard: isStoredObject, read: "cycle"},
  {pattern: "supervisor_no_project", kind: "no project control", guard: isStoredObject, read: "cycle"},
  {pattern: "supervisor_global_definitions_control", kind: "global definitions control", guard: isStoredObject, read: "cycle"},
  {pattern: "supervisor_global_definitions_event", kind: "global definitions event", guard: isStoredObject, read: "cycle"},
  {pattern: "supervisor_activation_baseline", kind: "activation baseline", guard: isStoredObject, read: "cycle"},
  {pattern: "supervisor_unbound_stop:%", kind: "unbound stop", guard: isStoredObject, read: "call"},
];

/**
 * The rollout scan of the project supervision tables (read only): every stored row through the decoder its reader uses (the
 * Start operations and owned ids are read when the run opens its stores), the open's table and column additions, and the
 * Start operations the open rejects as interrupted, as the baseline open did.
 */
export const checkProjectSupervisorRows: Effect.Effect<StoredRowScan, SqlError.SqlError | GuidanceStoreError, GuidanceDb> = Effect.gen(function* () {
  const sql = yield* GuidanceDb;
  const changes = [
    ...(yield* Effect.forEach(["supervisor_owned_threads", "supervisor_project_settings", "supervisor_main_bindings", "supervisor_task_interpretations",
      "supervisor_chat_enables"], (table) => schemaChanges(sql, table))).flat(),
    ...yield* schemaChanges(sql, "supervisor_definition_user_saves", ["expected_revision"]),
  ];
  const findings: Array<StoredRowFinding> = [];
  const metaValue = (guard: (value: unknown) => boolean) => (row: Record<string, unknown>) =>
    Effect.flatMap(decodeKeyValueRow(row), ({value}) => storedDocument(value, guard, rowInvalid("meta")));
  let preparing = 0;
  for (const {pattern, kind, guard, read} of metaDocumentKinds) {
    const rows = yield* rowsOf(sql, "meta", `SELECT key,value FROM meta WHERE key ${pattern.includes("%") ? "LIKE" : "="} '${pattern}'`);
    findings.push(...yield* rowFindings(rows, {table: "meta", kind, problem: "undecodable", read}, (row) => rowKey(row, ["key"]), metaValue(guard)));
    if (kind === "start operation") for (const row of rows) {
      const operation = yield* Effect.option(metaValue(guard)(row));
      if (operation._tag === "Some" && (operation.value as {preparing?: unknown}).preparing) preparing++;
    }
  }
  const document = (guard: (value: unknown) => boolean, row: ProjectSupervisorRow) => (value: Record<string, unknown>) => documentRow(value, guard, rowInvalid(row));
  findings.push(
    ...yield* rowFindings(yield* rowsOf(sql, "supervisor_owned_threads", "SELECT id FROM supervisor_owned_threads"),
      {table: "supervisor_owned_threads", kind: "owned thread", problem: "undecodable", read: "open"}, (row) => rowKey(row, ["id"]), decodeIdRow),
    ...yield* rowFindings(yield* rowsOf(sql, "supervisor_main_bindings", "SELECT project_id,main_thread_id,document FROM supervisor_main_bindings"),
      {table: "supervisor_main_bindings", kind: "binding", problem: "undecodable", read: "cycle"}, (row) => rowKey(row, ["project_id", "main_thread_id"]),
      document(isStoredBinding, "binding")),
    ...yield* rowFindings(yield* rowsOf(sql, "supervisor_task_interpretations", "SELECT thread_id,document FROM supervisor_task_interpretations"),
      {table: "supervisor_task_interpretations", kind: "task", problem: "undecodable", read: "cycle"}, (row) => rowKey(row, ["thread_id"]), document(isStoredTask, "task")),
    ...yield* rowFindings(yield* rowsOf(sql, "supervisor_project_settings", "SELECT project_id,document FROM supervisor_project_settings"),
      {table: "supervisor_project_settings", kind: "project settings", problem: "undecodable", read: "cycle"}, (row) => rowKey(row, ["project_id"]),
      document(isStoredSettings, "project_settings")),
    ...yield* rowFindings(yield* rowsOf(sql, "supervisor_chat_enables", "SELECT thread_id,enabled_at FROM supervisor_chat_enables"),
      {table: "supervisor_chat_enables", kind: "chat enable", problem: "undecodable", read: "call"}, (row) => rowKey(row, ["thread_id"]), decodeEnabledAtRow),
    // a column the open adds reads as its default
    ...yield* rowFindings(yield* rowsOf(sql, "supervisor_definition_user_saves", "SELECT * FROM supervisor_definition_user_saves"),
      {table: "supervisor_definition_user_saves", kind: "definition save", problem: "undecodable", read: "call"}, (row) => rowKey(row, ["project_id", "workspace_root"]),
      (row) => decodeDefinitionSaveRow({expected_revision: "", ...row})),
  );
  return {findings, changes: preparing ? [...changes, {table: "meta", change: "Start operations left preparing rejected as interrupted (as the baseline open did)", rows: preparing}] : changes};
});
