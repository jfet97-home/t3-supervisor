import { initializeMainSupervisionState } from "./supervisor-state-reset.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GuidanceStore } from "./guidance-store.js";
import { fingerprint } from "./guidance-store.js";
import { defaultMonitoringSettings, type DefinitionReviewInfo, type SupervisorBinding, type SupervisorModelSelection, type SupervisorMonitoringSettings, type TaskInterpretationInfo, type WorkflowProtocolDiagnostic } from "./project-supervisor-contract.js";
import type { Projection, SupervisorConfig } from "./types.js";
import { sameModel } from "./supervisor-native.js";
import type { SupervisionControlInfo } from "./supervisor-control-contract.js";
import type { GlobalDefinitionsControlInfo } from "./supervisor-control-contract.js";
import type { ProposalContext } from "./supervisor-workflow.js";
import type { ProjectDefinitionSnapshot } from "./project-definitions-contract.js";

export const defaultSupervisorModel: SupervisorModelSelection = {instanceId: "codex", model: "gpt-6-luna", options: [{id: "reasoningEffort", value: "high"}]};
export const SUPERVISOR_ROOT_THREAD_PREFIX = "supervisor-root:";
export type ProjectModelSettings = {projectId: string; generation: number; modelMutationGeneration: number; modelSelection: SupervisorModelSelection; pending: boolean; monitoring: SupervisorMonitoringSettings; teamSettings?: {maxHelpersPerRoot: number}; applyAttempts?: number; applicationMessage?: string | null};
export type BindingRecord = SupervisorBinding & {mainThreadId: string; modelState?: ProjectModelSettings; quietFingerprint?: string; manualKeepActive?: boolean; quietSince?: number | null; settlement?: {commandId: string; state: "pending" | "uncertain" | "settled" | "superseded"; observedAt: number; activityVersion?: string; attempts?: number}; enableAfterSequence: number; title: string; initialModel: SupervisorModelSelection; creationAttempts?: number; creationMessage?: string};
export type SupervisorBaseline = {version?: 2; snapshotSequence: number; threads: Array<{id: string; latestRunId: string | null}>};
export type SupervisionFolderPresence = {status: "present" | "missing" | "unavailable"; message?: string};
/** Native positions from which workflow protocol records belong to a task source revision: the service prompt that gave the
 * Supervisor this revision (and its own native run once observed) and, after a source edit, the last main run and turn item seen with the edit. */
export type ProtocolAnchor = {supervisorThreadId: string; sourceHash: string; promptMessageId: string; promptRun?: {id: string; ordinal: number}; editedAfter?: {runOrdinal: number; itemOrdinal: number | null} | null};
export type TaskRecord = TaskInterpretationInfo & {id: string; sourceHash: string; agreementSourceHash?: string; requestText: string; supervisorThreadId: string; messageId: string; dispatchedAt: number | null; replayCount: number; supervisorRunId: string | null; sourceOrdinal: number; definitionContext?: ProposalContext | null; definitionSnapshot?: ProjectDefinitionSnapshot | null; definitionNoticeKey?: string; definitionReadAttempts?: number; revalidationAttempts?: number; workflowProtocolDiagnostic?: WorkflowProtocolDiagnostic | null; protocolAnchor?: ProtocolAnchor};

/** Loads permanent root and helper ownership before supervision starts. */
export const loadSupervisorOwnership = (directory: string): Set<string> => {
  const path = join(directory, "guidance.sqlite3");
  if (!existsSync(path)) return new Set();
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='supervisor_owned_threads'").get()) return new Set();
    return new Set(db.prepare("SELECT id FROM supervisor_owned_threads").all().map(row => String(row.id)));
  } finally {db.close();}
};
export const isSupervisorThread = (config: SupervisorConfig, thread: {id: string; lineage: {parentThreadId: string | null; rootThreadId?: unknown}}): boolean => {
  const ids = config.supervisorOwnedThreadIds;
  const supervisorId = (id: unknown): boolean => typeof id === "string" &&
    (id.startsWith(SUPERVISOR_ROOT_THREAD_PREFIX) || ids?.has(id) === true);
  return supervisorId(thread.id) || supervisorId(thread.lineage.rootThreadId) || supervisorId(thread.lineage.parentThreadId);
};

/** Stores project supervision metadata alongside the existing service state. */
export class ProjectSupervisorStore {
  readonly scopeCompatible: boolean;
  private readonly folderPresence = new Map<string, SupervisionFolderPresence>();
  private globalFolderPresence: SupervisionFolderPresence | null = null;
  constructor(readonly store: GuidanceStore, readonly ownedIds: Set<string>) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS supervisor_owned_threads(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS supervisor_project_settings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_main_bindings(project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(project_id,main_thread_id));
      CREATE TABLE IF NOT EXISTS supervisor_task_interpretations(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_definition_user_saves(project_id TEXT NOT NULL,workspace_root TEXT NOT NULL,signature TEXT NOT NULL,saved_at INTEGER NOT NULL,expected_revision TEXT NOT NULL,PRIMARY KEY(project_id,workspace_root));
      CREATE INDEX IF NOT EXISTS supervisor_tasks_project ON supervisor_task_interpretations(project_id);`);
    if (!store.db.prepare("PRAGMA table_info(supervisor_definition_user_saves)").all().some(row => row.name === "expected_revision"))
      store.db.exec("ALTER TABLE supervisor_definition_user_saves ADD COLUMN expected_revision TEXT NOT NULL DEFAULT ''");
    this.scopeCompatible = store.transaction(() => initializeMainSupervisionState(store.db));
    for (const row of store.db.prepare("SELECT id FROM supervisor_owned_threads").all()) ownedIds.add(String(row.id));
  }
  private read<T>(table: string, key: string, id: string): T | null {
    const value = this.store.db.prepare(`SELECT document FROM ${table} WHERE ${key}=?`).get(id)?.document;
    return value === undefined ? null : JSON.parse(String(value)) as T;
  }
  activation(sequence?: number): number | null {
    if (sequence !== undefined) this.store.db.prepare("INSERT OR IGNORE INTO meta VALUES('supervisor_activation_sequence',?)").run(String(sequence));
    const value = this.store.db.prepare("SELECT value FROM meta WHERE key='supervisor_activation_sequence'").get()?.value;
    return value === undefined ? null : Number(value);
  }
  baseline(value?: SupervisorBaseline): SupervisorBaseline | null {
    if (value) this.store.transaction(() => {
      const existing = this.baseline();
      if (!existing) this.store.db.prepare("INSERT INTO meta VALUES('supervisor_activation_baseline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({...value, version: 2}));
      this.activation(value.snapshotSequence);
    });
    const stored = this.store.db.prepare("SELECT value FROM meta WHERE key='supervisor_activation_baseline'").get()?.value;
    const baseline = stored === undefined ? null : JSON.parse(String(stored)) as SupervisorBaseline;
    return baseline?.version === 2 ? baseline : null;
  }
  baselineOrdinal(threadId: string, projection: Projection): number | null {
    const baseline = this.baseline();if (!baseline) return null;
    const baselines = [baseline, this.controlRecord(null).baseline, this.controlRecord(projection.thread.projectId ?? "").baseline];
    let floor = 0;
    for (const value of baselines) {
      const anchor = value?.threads.find(thread => thread.id === threadId)?.latestRunId;
      if (!anchor) continue;
      const ordinal = projection.runs.find(run => run.id === anchor && run.threadId === threadId)?.ordinal;
      if (ordinal === undefined) return null;
      floor = Math.max(floor, ordinal);
    }
    return floor;
  }
  private controlKey(projectId: string | null): string {return `supervisor_control:${JSON.stringify(projectId)}`;}
  private presenceUnavailableKey(projectId: string): string {return `supervisor_control_presence_unavailable:${JSON.stringify(projectId)}`;}
  private controlRecord(projectId: string | null): {generation: number; enabled: boolean; manual: boolean; baseline?: SupervisorBaseline} {
    const row = this.store.db.prepare("SELECT value FROM meta WHERE key=?").get(this.controlKey(projectId));
    if (!row) return projectId === null ? {generation: 0, enabled: true, manual: true} : {generation: 0, enabled: false, manual: false};
    const value = JSON.parse(String(row.value)) as {generation?: number; enabled?: boolean; manual?: boolean; baseline?: SupervisorBaseline};
    return {generation: Number.isSafeInteger(value.generation) && value.generation! >= 0 ? value.generation! : 0,
      enabled: value.enabled === true, manual: projectId === null || value.manual !== false, ...(value.baseline ? {baseline: value.baseline} : {})};
  }
  projectBoundary(projectId: string): SupervisorBaseline | null {return this.controlRecord(projectId).baseline ?? null;}
  folderPresenceNeedsBoundary(projectId: string): boolean {
    return Boolean(this.store.db.prepare("SELECT 1 FROM meta WHERE key=?").get(this.presenceUnavailableKey(projectId)));
  }
  setFolderPresence(projectId: string, presence: SupervisionFolderPresence): void {this.folderPresence.set(projectId, presence);}
  clearFolderPresence(projectId: string): void {this.folderPresence.delete(projectId);}
  recordFolderPresence(projectId: string, presence: SupervisionFolderPresence, baseline?: SupervisorBaseline): void {
    this.setFolderPresence(projectId, presence);
    if (this.isManual(projectId) || this.autoControlInitialized(projectId)) return;
    if (presence.status === "unavailable") {
      if (!this.folderPresenceNeedsBoundary(projectId)) this.store.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(this.presenceUnavailableKey(projectId), JSON.stringify({checkedAt: Date.now()}));
      return;
    }
    if (presence.status === "present" && (this.folderPresenceNeedsBoundary(projectId) && !baseline ||
      !this.projectBoundary(projectId) && !baseline && !this.baseline())) return;
    this.store.transaction(() => {
      if (presence.status === "present" && baseline) {
        if (this.baseline() === null) {
          this.store.db.prepare("INSERT INTO meta VALUES('supervisor_activation_baseline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .run(JSON.stringify({...baseline, version: 2}));
          this.activation(baseline.snapshotSequence);
        }
        const control = this.controlRecord(projectId);
        this.store.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(this.controlKey(projectId), JSON.stringify({...control, baseline}));
      }
      this.store.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(`supervisor_control_auto:${JSON.stringify(projectId)}`, JSON.stringify({status: presence.status, enabled: presence.status === "present", checkedAt: Date.now()}));
      this.store.db.prepare("DELETE FROM meta WHERE key=?").run(this.presenceUnavailableKey(projectId));
    });
    this.clearFolderPresence(projectId);
  }
  autoControlInitialized(projectId: string): boolean {
    const row = this.store.db.prepare("SELECT value FROM meta WHERE key=?").get(`supervisor_control_auto:${JSON.stringify(projectId)}`);
    if (!row) return false;
    const auto = JSON.parse(String(row.value)) as {status?: unknown; enabled?: unknown};
    if (auto.status === "missing") return auto.enabled === false;
    if (auto.status === "present" && auto.enabled === true) return Boolean(this.controlRecord(projectId).baseline || this.baseline()) && !this.folderPresenceNeedsBoundary(projectId);
    return false;
  }
  isManual(projectId: string): boolean {return this.controlRecord(projectId).manual;}
  control(projectId: string | null): SupervisionControlInfo {
    const value = this.controlRecord(projectId);const global = this.controlRecord(null);const globallyEnabled = global.enabled;
    if (projectId === null) return {projectId, generation: value.generation, enabled: value.enabled, manual: true, globallyEnabled,
      effectiveEnabled: value.enabled, detectionStatus: "not_checked", detectionError: null};
    const presence = this.folderPresence.get(projectId);
    const autoRow = this.store.db.prepare("SELECT value FROM meta WHERE key=?").get(`supervisor_control_auto:${JSON.stringify(projectId)}`);
    const auto = autoRow ? JSON.parse(String(autoRow.value)) as {status?: unknown; enabled?: unknown} : null;
    const storedStatus = auto?.status === "present" || auto?.status === "missing" ? auto.status : null;
    const boundaryMissing = !value.manual && auto?.status === "present" && auto.enabled === true && (!value.baseline && !this.baseline() || this.folderPresenceNeedsBoundary(projectId));
    const detectionStatus = boundaryMissing ? "unavailable" as const : value.manual ? presence?.status ?? "not_checked" as const : storedStatus ?? presence?.status ?? "not_checked" as const;
    const enabled = value.manual ? value.enabled : auto?.enabled === true && !boundaryMissing;
    return {projectId, generation: value.generation, enabled, manual: value.manual, globallyEnabled,
      effectiveEnabled: enabled && globallyEnabled, detectionStatus,
      detectionError: boundaryMissing ? "The project folder is present, but a native enable boundary must be captured before auto-enabling supervision." :
        detectionStatus === "unavailable" ? presence?.message ?? "The project .t3-supervisor folder could not be checked." : null};
  }
  private globalDefinitionsRecord(): {generation: number; enabled: boolean; manual: boolean} {
    const row = this.store.db.prepare("SELECT value FROM meta WHERE key='supervisor_global_definitions_control'").get();
    if (!row) return {generation: 0, enabled: false, manual: false};
    const value = JSON.parse(String(row.value)) as {generation?: number; enabled?: boolean; manual?: boolean};
    return {generation: Number.isSafeInteger(value.generation) && value.generation! >= 0 ? value.generation! : 0,
      enabled: value.enabled === true, manual: value.manual === true};
  }
  setGlobalFolderPresence(presence: SupervisionFolderPresence): void {this.globalFolderPresence = presence;}
  globalDefinitionsControl(homePath = "~/.t3-supervisor"): GlobalDefinitionsControlInfo {
    const value = this.globalDefinitionsRecord();const presence = this.globalFolderPresence;
    const detectionStatus = presence?.status ?? "not_checked" as const;
    return {generation: value.generation, enabled: value.enabled, manual: value.manual, effectiveEnabled: value.enabled && this.control(null).enabled,
      homePath, detectionStatus, detectionError: detectionStatus === "unavailable" ? presence?.message ?? "The server-user .t3-supervisor folder could not be checked." : null};
  }
  useGlobalDefinitions(_projectId?: string): boolean {return this.globalDefinitionsRecord().enabled;}
  saveGlobalDefinitionsControl(expectedGeneration: number, enabled: boolean, homePath = "~/.t3-supervisor", globalFingerprint: string | null = null,
    scratchBoundaries: ReadonlyArray<{projectId: string; baseline: SupervisorBaseline}> = []): GlobalDefinitionsControlInfo {
    return this.store.transaction(() => {
      const current = this.globalDefinitionsRecord();
      if (current.generation !== expectedGeneration) throw new Error("global_definitions_control_conflict");
      const generation = current.generation + 1;const changedAt = Date.now();
      this.store.db.prepare("INSERT INTO meta VALUES('supervisor_global_definitions_control',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({generation, enabled, manual: true}));
      if (current.enabled !== enabled) {
        this.store.db.prepare("INSERT INTO meta VALUES('supervisor_global_definitions_event',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(JSON.stringify({generation, enabled, changedAt, globalFingerprint}));
        for (const row of this.store.db.prepare("SELECT document FROM supervisor_task_interpretations").all()) {
          const task = JSON.parse(String(row.document)) as TaskRecord;
          if (task.status === "queued" && task.dispatchedAt === null && task.definitionContext !== undefined) {
            const refresh: {-readonly [K in keyof TaskRecord]: TaskRecord[K]} = {...task, requestText: "", reason: "Global definition inclusion changed; definitions will be refreshed before dispatch.", updatedAt: changedAt,
              workflow: {status: "pending", message: "Global definition inclusion changed; refresh the complete definitions before sending this task.", workspaceRoot: null, revision: null, globalRevision: null,
                definitionsStatus: "unavailable", definitionsComplete: false, requirementsKnown: false, requirements: [], issues: [], plan: null}};
            delete refresh.definitionContext;delete refresh.definitionSnapshot;delete refresh.definitionReadAttempts;delete refresh.revalidationAttempts;
            this.saveTask(refresh);continue;
          }
          if (task.status !== "inferred" || !task.workflow?.revision) continue;
          const message = "The user changed whether global definitions are included. The old plan and agreement are retained as stale history.";
          this.saveTask({...task, workflow: {...task.workflow, status: "stale", message},
            ...(task.agreement ? {agreement: {...task.agreement, status: "stale", message}} : {}),
            definitionReview: {status: "checking", message, expectedRevision: task.workflow.revision, observedRevision: null,
              supervisorMessageId: null, userMessageIds: [], updatedAt: changedAt}, updatedAt: changedAt});
        }
      }
      for (const boundary of scratchBoundaries) {
        const control = this.controlRecord(boundary.projectId);
        const next = {...control, baseline: boundary.baseline};
        this.store.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(this.controlKey(boundary.projectId), JSON.stringify(next));
      }
      return this.globalDefinitionsControl(homePath);
    });
  }
  hasGlobalDefinitionsEvent(): boolean {return Boolean(this.store.db.prepare("SELECT 1 FROM meta WHERE key='supervisor_global_definitions_event'").get());}
  globalDefinitionsChangeAuthorized(task: TaskRecord, globalFingerprint?: string | null): boolean {
    const row = this.store.db.prepare("SELECT value FROM meta WHERE key='supervisor_global_definitions_event'").get();
    if (!row || !task.definitionSnapshot || task.definitionSnapshot.status !== "ready" || !task.definitionSnapshot.complete ||
      task.definitionReview?.status !== "authorized" || !task.workflow?.revision) return false;
    const event = JSON.parse(String(row.value)) as {enabled?: boolean; changedAt?: number; globalFingerprint?: string | null};
    return event.enabled === this.useGlobalDefinitions(task.projectId) && Number.isFinite(event.changedAt) &&
      Boolean(event.globalFingerprint) && task.definitionReview.updatedAt >= event.changedAt! && task.workflow.revision === task.definitionSnapshot.revision &&
      task.workflow.globalRevision === (task.definitionSnapshot.globalRevision ?? null) &&
      (!event.enabled || task.definitionSnapshot.globalRevision === event.globalFingerprint &&
        (globalFingerprint === undefined || globalFingerprint === event.globalFingerprint));
  }
  definitionUserGlobalToggle(definitions: ProjectDefinitionSnapshot, approved: ProjectDefinitionSnapshot, after: number, globalFingerprint: string | null): boolean {
    const row = this.store.db.prepare("SELECT value FROM meta WHERE key='supervisor_global_definitions_event'").get();
    if (!row || !("projectConfig" in definitions) || !("projectConfig" in approved) || definitions.status !== "ready" || approved.status !== "ready" || !definitions.complete || !approved.complete || definitions.projectId !== approved.projectId ||
      definitions.threadId !== approved.threadId || definitions.workspaceRoot !== approved.workspaceRoot) return false;
    const event = JSON.parse(String(row.value)) as {generation?: number; enabled?: boolean; changedAt?: number; globalFingerprint?: string | null};
    if (event.enabled !== this.useGlobalDefinitions(definitions.projectId) || !Number.isFinite(event.changedAt) || event.changedAt! < after ||
      !event.globalFingerprint || event.globalFingerprint !== globalFingerprint) return false;
    if (event.enabled && definitions.globalRevision !== event.globalFingerprint) return false;
    if (!event.enabled && approved.globalRevision !== event.globalFingerprint) return false;
    const hasOrigins = (values: ReadonlyArray<{origin?: string | undefined}>) => values.every(value => value.origin === "global" || value.origin === "project");
    const local = <A extends {origin?: string | undefined}>(values: ReadonlyArray<A>) => values.filter(value => value.origin === "project");
    return hasOrigins(definitions.steps) && hasOrigins(approved.steps) && hasOrigins(definitions.workflows) && hasOrigins(approved.workflows) &&
      fingerprint(local(definitions.steps)) === fingerprint(local(approved.steps)) &&
      fingerprint(local(definitions.workflows)) === fingerprint(local(approved.workflows)) &&
      fingerprint(definitions.projectConfig) === fingerprint(approved.projectConfig);
  }
  enabled(projectId: string): boolean {return this.control(projectId).effectiveEnabled;}
  saveControl(projectId: string | null, expectedGeneration: number, enabled: boolean, baseline?: SupervisorBaseline): SupervisionControlInfo {
    return this.store.transaction(() => {
      const current = this.controlRecord(projectId);
      if (current.generation !== expectedGeneration) throw new Error("supervision_control_conflict");
      if (enabled && !this.control(projectId).enabled && (projectId === null || this.controlRecord(null).enabled) && !baseline) throw new Error("supervision_control_baseline_required");
      if (baseline && this.baseline() === null) {
        this.store.db.prepare("INSERT INTO meta VALUES('supervisor_activation_baseline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(JSON.stringify({...baseline, version: 2}));
        this.activation(baseline.snapshotSequence);
      }
      const next = {...current, enabled, manual: true, generation: current.generation + 1,
        ...(enabled && !current.enabled && baseline ? {baseline} : {})};
      this.store.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.controlKey(projectId), JSON.stringify(next));
      if (projectId !== null) this.store.db.prepare("DELETE FROM meta WHERE key=?").run(this.presenceUnavailableKey(projectId));
      return this.control(projectId);
    });
  }
  settings(projectId: string): ProjectModelSettings {
    const stored = this.read<Omit<ProjectModelSettings, "monitoring" | "modelMutationGeneration"> & {monitoring?: SupervisorMonitoringSettings; modelMutationGeneration?: number}>("supervisor_project_settings", "project_id", projectId);
    return stored ? {...stored, modelMutationGeneration: stored.modelMutationGeneration ?? stored.generation, monitoring: normalizeMonitoringSettings(stored.monitoring), teamSettings: stored.teamSettings ?? {maxHelpersPerRoot: 5}} : {
      projectId, generation: 0, modelMutationGeneration: 0, modelSelection: defaultSupervisorModel, pending: false, monitoring: {...defaultMonitoringSettings}, teamSettings: {maxHelpersPerRoot: 5},
    };
  }
  saveSettings(projectId: string, expected: number, selection: SupervisorModelSelection, monitoring?: SupervisorMonitoringSettings, teamSettings?: {maxHelpersPerRoot: number}): ProjectModelSettings {
    return this.store.transaction(() => {
      const old = this.settings(projectId);
      if (old.generation !== expected) throw new Error("project_settings_conflict");
      const nextMonitoring = normalizeMonitoringSettings(monitoring ?? old.monitoring);
      if (!validMonitoringSettings(nextMonitoring)) throw new Error("invalid_monitoring_settings");
      const nextTeamSettings = teamSettings ?? old.teamSettings ?? {maxHelpersPerRoot: 5};
      if (!Number.isSafeInteger(nextTeamSettings.maxHelpersPerRoot) || nextTeamSettings.maxHelpersPerRoot < 0 || nextTeamSettings.maxHelpersPerRoot > 20)
        throw new Error("invalid_team_settings");
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
      this.store.db.prepare("INSERT INTO supervisor_project_settings VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET document=excluded.document").run(projectId, JSON.stringify(next));
      return next;
    });
  }
  modelState(binding: BindingRecord): ProjectModelSettings {
    return binding.modelState ?? {...this.settings(binding.projectId), modelSelection: binding.initialModel, pending: false, applyAttempts: 0, applicationMessage: null};
  }
  observeModel(binding: BindingRecord, selection: SupervisorModelSelection, appliedGeneration?: number, message?: string | null): void {
    const latest = this.binding(binding.projectId, binding.mainThreadId);
    if (!latest || latest.threadId !== binding.threadId) return;
    const old = this.modelState(latest);
    if (old.pending && old.generation !== appliedGeneration) return;
    const changed = !sameModel(old.modelSelection, selection);
    this.setBinding({...latest, modelState: {...old, modelSelection: selection, pending: false,
      applicationMessage: message === undefined ? old.applicationMessage ?? null : message,
      generation: old.generation + (!old.pending && changed ? 1 : 0)}});
  }
  modelAttempt(binding: BindingRecord, reset = false): void {
    const latest = this.binding(binding.projectId, binding.mainThreadId);
    if (!latest || latest.threadId !== binding.threadId) return;
    const old = this.modelState(latest);
    this.setBinding({...latest, modelState: {...old, applyAttempts: reset ? 0 : (old.applyAttempts ?? 0) + 1,
      applicationMessage: reset ? null : "Native model application is unresolved. Retry native access after checking T3."}});
  }
  binding(projectId: string, mainThreadId: string): BindingRecord | null {
    const row = this.store.db.prepare("SELECT document FROM supervisor_main_bindings WHERE project_id=? AND main_thread_id=?").get(projectId, mainThreadId);
    return row ? JSON.parse(String(row.document)) as BindingRecord : null;
  }
  bindingForSupervisor(threadId: string): BindingRecord | null {return this.bindings().find(binding => binding.threadId === threadId) ?? null;}
  tasksFor(binding: BindingRecord): TaskRecord[] {return this.tasks(binding.projectId).filter(task => task.supervisorThreadId === binding.threadId);}
  bindings(): BindingRecord[] {return this.store.db.prepare("SELECT document FROM supervisor_main_bindings ORDER BY project_id,main_thread_id").all().map(row => JSON.parse(String(row.document)) as BindingRecord);}
  reserve(projectId: string, mainThreadId: string, title: string, selection: SupervisorModelSelection, watermark: number, now: number): BindingRecord {
    const value = this.store.transaction(() => {
      const old = this.binding(projectId, mainThreadId);if (old) return old;
      if (Number(this.store.db.prepare("SELECT count(*) AS n FROM supervisor_owned_threads").get()?.n) >= 1000) throw new Error("supervisor_capacity");
      const binding: BindingRecord = {projectId, mainThreadId, threadId: `${SUPERVISOR_ROOT_THREAD_PREFIX}${randomUUID()}`, modelState: {...this.settings(projectId), modelSelection: selection, pending: false}, title: `Supervisor · ${title.slice(0,160)}`, generation: 1, enabledAt: now,
        enableAfterSequence: watermark, initialModel: selection, creationAttempts: 0, state: "creating"};
      this.store.db.prepare("INSERT INTO supervisor_owned_threads VALUES(?)").run(binding.threadId);
      this.store.db.prepare("INSERT INTO supervisor_main_bindings VALUES(?,?,?)").run(projectId, mainThreadId, JSON.stringify(binding));
      return binding;
    });
    this.ownedIds.add(value.threadId);return value;
  }
  setBinding(value: BindingRecord): void {this.store.db.prepare("UPDATE supervisor_main_bindings SET document=? WHERE project_id=? AND main_thread_id=?").run(JSON.stringify(value), value.projectId, value.mainThreadId);}
  replaceMissingBinding(binding: BindingRecord, selection: SupervisorModelSelection): BindingRecord {
    if (binding.state !== "missing") throw new Error("supervisor_not_missing");
    const value = this.store.transaction(() => {
      if (Number(this.store.db.prepare("SELECT count(*) AS n FROM supervisor_owned_threads").get()?.n) >= 1000) throw new Error("supervisor_capacity");
      const next: BindingRecord = {...binding, threadId: `${SUPERVISOR_ROOT_THREAD_PREFIX}${randomUUID()}`, generation: 1, initialModel: selection, modelState: {...this.settings(binding.projectId), modelSelection: selection, pending: false}, quietSince: null,  creationAttempts: 0, state: "creating"};
      delete next.settlement;
      this.store.db.prepare("INSERT INTO supervisor_owned_threads VALUES(?)").run(next.threadId);this.setBinding(next);
      for (const task of this.tasks(binding.projectId)) {
        if (task.supervisorThreadId !== binding.threadId || task.agreement?.status !== "agreed") continue;
        this.saveTask({...task, agreement: {...task.agreement, status: "stale", message: "The bound Supervisor was replaced; this agreement is retained as history."}, updatedAt: Date.now()});
      }
      return next;
    });
    this.ownedIds.add(value.threadId);return value;
  }
  task(threadId: string): TaskRecord | null {return this.read("supervisor_task_interpretations", "thread_id", threadId);}
  tasks(projectId: string): TaskRecord[] {return this.store.db.prepare("SELECT document FROM supervisor_task_interpretations WHERE project_id=? ORDER BY updated_at").all(projectId).map(row => JSON.parse(String(row.document)) as TaskRecord);}
  saveTask(task: TaskRecord): void {
    if (!this.task(task.threadId) && (Number(this.store.db.prepare("SELECT count(*) AS n FROM supervisor_task_interpretations").get()?.n) >= 10_000 || this.tasks(task.projectId).filter(t => ["queued","dispatching","waiting"].includes(t.status)).length >= 100)) throw new Error("supervisor_task_capacity");
    this.store.db.prepare("INSERT INTO supervisor_task_interpretations VALUES(?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at").run(task.threadId, task.projectId, JSON.stringify(task), task.updatedAt);
  }
  recordDefinitionUserSave(definitions: ProjectDefinitionSnapshot, expectedRevision: string): void {
    if (definitions.status !== "ready" || !definitions.complete || !definitions.revision || !expectedRevision || !definitions.projectConfig) return;
    const now = Date.now();
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO supervisor_definition_user_saves VALUES(?,?,?,?,?) ON CONFLICT(project_id,workspace_root) DO UPDATE SET signature=excluded.signature,saved_at=excluded.saved_at,expected_revision=excluded.expected_revision")
        .run(definitions.projectId, definitions.workspaceRoot, fingerprint(definitions.projectConfig), now, expectedRevision);
      for (const task of this.tasks(definitions.projectId)) {
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
        this.saveTask({...task, workflow: {...task.workflow, status: "stale", message: "Project configuration was saved through the dashboard; the old plan needs revalidation."},
          ...(task.agreement ? {agreement: {...task.agreement, status: "stale", message: "Project configuration was explicitly saved; this agreement is retained as history."}} : {}),
          definitionReview, updatedAt: now});
      }
    });
  }
  definitionUserSave(definitions: ProjectDefinitionSnapshot, approved: ProjectDefinitionSnapshot, after: number): boolean {
    if (!("projectConfig" in definitions) || !("projectConfig" in approved)) return false;
    const row = this.store.db.prepare("SELECT signature,saved_at,expected_revision FROM supervisor_definition_user_saves WHERE project_id=? AND workspace_root=?")
      .get(definitions.projectId, definitions.workspaceRoot);
    const items: ReadonlyArray<{origin?: string | undefined}> = [...definitions.steps, ...definitions.workflows, ...approved.steps, ...approved.workflows];
    const originsKnown = items.every(item => item.origin === "global" || item.origin === "project");
    const globalStepsUnchanged = fingerprint(definitions.steps.filter(step => step.origin === "global")) === fingerprint(approved.steps.filter(step => step.origin === "global"));
    const globalWorkflowsUnchanged = fingerprint(definitions.workflows.filter(workflow => workflow.origin === "global")) === fingerprint(approved.workflows.filter(workflow => workflow.origin === "global"));
    const expectedRevision = typeof row?.expected_revision === "string" ? row.expected_revision : null;
    const reviewedExpectedRevision = expectedRevision !== null && this.tasks(definitions.projectId).some(task =>
      task.threadId === definitions.threadId && task.workflow?.revision === approved.revision &&
      task.definitionReview?.expectedRevision === approved.revision && task.definitionReview.observedRevision === expectedRevision &&
      task.definitionReview.updatedAt >= after && task.definitionReview.updatedAt <= Number(row?.saved_at));
    return definitions.status === "ready" && approved.status === "ready" && definitions.complete && approved.complete && originsKnown &&
      globalStepsUnchanged && globalWorkflowsUnchanged && definitions.globalRevision === approved.globalRevision &&
      approved.projectId === definitions.projectId && approved.workspaceRoot === definitions.workspaceRoot &&
      fingerprint(definitions.steps) === fingerprint(approved.steps) && fingerprint(definitions.workflows) === fingerprint(approved.workflows) &&
      (expectedRevision === approved.revision || reviewedExpectedRevision) &&
      row?.signature === fingerprint(definitions.projectConfig) && Number(row.saved_at) >= after;
  }
  recordGlobalDefinitionsPresence(presence: SupervisionFolderPresence): void {this.setGlobalFolderPresence(presence);}
  prune(now: number): string[] {
    const expiredIds: string[] = [];
    for (const row of this.store.db.prepare("SELECT document FROM supervisor_task_interpretations WHERE updated_at<?").all(now - 30 * 86400_000)) {
      const task = JSON.parse(String(row.document)) as TaskRecord;
      if (!["inferred","needs_context","unavailable","expired"].includes(task.status)) continue;
      if (task.status === "inferred" && this.bindingForSupervisor(task.supervisorThreadId)?.state === "ready") continue;
      const expired: {-readonly [K in keyof TaskRecord]: TaskRecord[K]} = {...task, status: "expired", objective: null, reason: "Interpretation evidence expired.", requestText: "", definitionContext: null, workflow: null, agreement: null, updatedAt: now};
      delete expired.workflowProposalId;
      delete expired.definitionSnapshot;
      delete expired.definitionReview;
      delete expired.definitionNoticeKey;
      this.saveTask(expired);
      expiredIds.push(task.id);
    }
    return expiredIds;
  }
}

const normalizeMonitoringSettings = (value: SupervisorMonitoringSettings | undefined): SupervisorMonitoringSettings => value
  ? {intervalMinutes: value.intervalMinutes, activityThreshold: value.activityThreshold}
  : {...defaultMonitoringSettings};

const validMonitoringSettings = (value: SupervisorMonitoringSettings): boolean =>
  Number.isInteger(value.intervalMinutes) && value.intervalMinutes >= 1 && value.intervalMinutes <= 60 &&
  Number.isInteger(value.activityThreshold) && value.activityThreshold >= 3 && value.activityThreshold <= 100;
