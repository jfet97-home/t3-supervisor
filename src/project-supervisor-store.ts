import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GuidanceStore } from "./guidance-store.js";
import { fingerprint } from "./guidance-store.js";
import { defaultMonitoringSettings, type SupervisorBinding, type SupervisorModelSelection, type SupervisorMonitoringSettings, type TaskInterpretationInfo } from "./project-supervisor-contract.js";
import type { Projection, SupervisorConfig } from "./types.js";
import { sameModel } from "./supervisor-native.js";
import type { ProposalContext } from "./supervisor-workflow.js";
import type { ProjectDefinitionSnapshot } from "./project-definitions-contract.js";

export const defaultSupervisorModel: SupervisorModelSelection = {instanceId: "codex", model: "gpt-6-luna", options: [{id: "reasoningEffort", value: "high"}]};
export type ProjectModelSettings = {projectId: string; generation: number; modelMutationGeneration: number; modelSelection: SupervisorModelSelection; pending: boolean; monitoring: SupervisorMonitoringSettings; applyAttempts?: number; applicationMessage?: string | null};
export type BindingRecord = SupervisorBinding & {enableAfterSequence: number; title: string; initialModel: SupervisorModelSelection; creationAttempts?: number; creationMessage?: string};
export type SupervisorBaseline = {version?: 2; snapshotSequence: number; threads: Array<{id: string; latestRunId: string | null}>};
export type TaskRecord = TaskInterpretationInfo & {id: string; sourceHash: string; requestText: string; supervisorThreadId: string; messageId: string; dispatchedAt: number | null; replayCount: number; supervisorRunId: string | null; sourceOrdinal: number; definitionContext?: ProposalContext | null; definitionSnapshot?: ProjectDefinitionSnapshot | null; definitionNoticeKey?: string; definitionReadAttempts?: number; revalidationAttempts?: number};

/** Loads permanent ownership before any notification or input worker starts. */
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
  return Boolean(ids?.has(thread.id) || typeof thread.lineage.rootThreadId === "string" && ids?.has(thread.lineage.rootThreadId) ||
    typeof thread.lineage.parentThreadId === "string" && ids?.has(thread.lineage.parentThreadId));
};

/** Adds supervision metadata to the existing private database without touching delivery ledgers. */
export class ProjectSupervisorStore {
  constructor(readonly store: GuidanceStore, readonly ownedIds: Set<string>) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS supervisor_owned_threads(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS supervisor_project_settings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_project_bindings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_task_interpretations(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_definition_user_saves(project_id TEXT NOT NULL,workspace_root TEXT NOT NULL,signature TEXT NOT NULL,saved_at INTEGER NOT NULL,expected_revision TEXT NOT NULL,PRIMARY KEY(project_id,workspace_root));
      CREATE INDEX IF NOT EXISTS supervisor_tasks_project ON supervisor_task_interpretations(project_id);`);
    if (!store.db.prepare("PRAGMA table_info(supervisor_definition_user_saves)").all().some(row => row.name === "expected_revision"))
      store.db.exec("ALTER TABLE supervisor_definition_user_saves ADD COLUMN expected_revision TEXT NOT NULL DEFAULT ''");
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
    const anchor = baseline.threads.find(thread => thread.id === threadId)?.latestRunId;
    if (!anchor) return 0;
    return projection.runs.find(run => run.id === anchor && run.threadId === threadId)?.ordinal ?? null;
  }
  settings(projectId: string): ProjectModelSettings {
    const stored = this.read<Omit<ProjectModelSettings, "monitoring" | "modelMutationGeneration"> & {monitoring?: SupervisorMonitoringSettings; modelMutationGeneration?: number}>("supervisor_project_settings", "project_id", projectId);
    return stored ? {...stored, modelMutationGeneration: stored.modelMutationGeneration ?? stored.generation, monitoring: normalizeMonitoringSettings(stored.monitoring)} : {
      projectId, generation: 0, modelMutationGeneration: 0, modelSelection: defaultSupervisorModel, pending: false, monitoring: {...defaultMonitoringSettings},
    };
  }
  saveSettings(projectId: string, expected: number, selection: SupervisorModelSelection, monitoring?: SupervisorMonitoringSettings): ProjectModelSettings {
    return this.store.transaction(() => {
      const old = this.settings(projectId);
      if (old.generation !== expected) throw new Error("project_settings_conflict");
      const nextMonitoring = normalizeMonitoringSettings(monitoring ?? old.monitoring);
      if (!validMonitoringSettings(nextMonitoring)) throw new Error("invalid_monitoring_settings");
      const modelChanged = !sameModel(old.modelSelection, selection);
      const next: ProjectModelSettings = {
        ...old,
        projectId,
        generation: expected + 1,
        modelMutationGeneration: old.modelMutationGeneration + (modelChanged ? 1 : 0),
        modelSelection: selection,
        monitoring: nextMonitoring,
        pending: modelChanged ? true : old.pending,
        ...(modelChanged ? {applyAttempts: 0, applicationMessage: null} : {}),
      };
      this.store.db.prepare("INSERT INTO supervisor_project_settings VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET document=excluded.document").run(projectId, JSON.stringify(next));
      return next;
    });
  }
  observeModel(projectId: string, selection: SupervisorModelSelection, appliedGeneration?: number, message?: string | null): void {
    const old = this.settings(projectId);
    if (old.pending && old.generation !== appliedGeneration) return;
    const modelChanged = !sameModel(old.modelSelection, selection);
    const next = {...old, modelSelection: selection, pending: false, applicationMessage: message === undefined ? old.applicationMessage ?? null : message,
      modelMutationGeneration: old.modelMutationGeneration + (modelChanged ? 1 : 0),
      generation: old.generation + (!old.pending && modelChanged ? 1 : 0)};
    this.store.db.prepare("INSERT INTO supervisor_project_settings VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET document=excluded.document").run(projectId, JSON.stringify(next));
  }
  modelAttempt(projectId: string, reset = false): void {
    const old = this.settings(projectId);
    const next = {...old, applyAttempts: reset ? 0 : (old.applyAttempts ?? 0) + 1,
      applicationMessage: reset ? null : "Native model application is unresolved. Retry native access after checking T3."};
    this.store.db.prepare("UPDATE supervisor_project_settings SET document=? WHERE project_id=?").run(JSON.stringify(next), projectId);
  }
  binding(projectId: string): BindingRecord | null {return this.read("supervisor_project_bindings", "project_id", projectId);}
  bindings(): BindingRecord[] {return this.store.db.prepare("SELECT document FROM supervisor_project_bindings").all().map(row => JSON.parse(String(row.document)) as BindingRecord);}
  reserve(projectId: string, title: string, selection: SupervisorModelSelection, watermark: number, now: number): BindingRecord {
    const value = this.store.transaction(() => {
      const old = this.binding(projectId);if (old) return old;
      if (Number(this.store.db.prepare("SELECT count(*) AS n FROM supervisor_owned_threads").get()?.n) >= 1000) throw new Error("supervisor_capacity");
      const binding: BindingRecord = {projectId, threadId: randomUUID(), title: `Supervisor · ${title.slice(0,160)}`, generation: 1, enabledAt: now,
        enableAfterSequence: watermark, initialModel: selection, creationAttempts: 0, state: "creating"};
      this.store.db.prepare("INSERT INTO supervisor_owned_threads VALUES(?)").run(binding.threadId);
      this.store.db.prepare("INSERT INTO supervisor_project_bindings VALUES(?,?)").run(projectId, JSON.stringify(binding));
      return binding;
    });
    this.ownedIds.add(value.threadId);return value;
  }
  setBinding(value: BindingRecord): void {this.store.db.prepare("UPDATE supervisor_project_bindings SET document=? WHERE project_id=?").run(JSON.stringify(value), value.projectId);}
  replaceMissingBinding(binding: BindingRecord, selection: SupervisorModelSelection): BindingRecord {
    if (binding.state !== "missing") throw new Error("supervisor_not_missing");
    const value = this.store.transaction(() => {
      if (Number(this.store.db.prepare("SELECT count(*) AS n FROM supervisor_owned_threads").get()?.n) >= 1000) throw new Error("supervisor_capacity");
      const next: BindingRecord = {...binding, threadId: randomUUID(), generation: 1, initialModel: selection, creationAttempts: 0, state: "creating"};
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
    if (definitions.status !== "ready" || !definitions.revision || !expectedRevision) return;
    const now = Date.now();
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO supervisor_definition_user_saves VALUES(?,?,?,?,?) ON CONFLICT(project_id,workspace_root) DO UPDATE SET signature=excluded.signature,saved_at=excluded.saved_at,expected_revision=excluded.expected_revision")
        .run(definitions.projectId, definitions.workspaceRoot, fingerprint(definitions.rules), now, expectedRevision);
      for (const task of this.tasks(definitions.projectId)) {
        if (task.status !== "inferred" || !task.workflow?.revision || task.workflow.workspaceRoot !== definitions.workspaceRoot) continue;
        this.saveTask({...task, workflow: {...task.workflow, status: "stale", message: "Project rules were saved through the dashboard; the old plan needs revalidation."},
          ...(task.agreement ? {agreement: {...task.agreement, status: "stale", message: "Rules were explicitly saved; this agreement is retained as history."}} : {}),
          definitionReview: {status: "checking", message: "An explicit rule save is recorded. Independent block edits remain subject to authorization review.",
            expectedRevision: task.workflow.revision, observedRevision: task.threadId === definitions.threadId ? definitions.revision : null,
            supervisorMessageId: null, userMessageIds: [], updatedAt: now}, updatedAt: now});
      }
    });
  }
  definitionUserSave(definitions: ProjectDefinitionSnapshot, approved: ProjectDefinitionSnapshot, after: number): boolean {
    const row = this.store.db.prepare("SELECT signature,saved_at,expected_revision FROM supervisor_definition_user_saves WHERE project_id=? AND workspace_root=?")
      .get(definitions.projectId, definitions.workspaceRoot);
    return definitions.status === "ready" && approved.status === "ready" && approved.projectId === definitions.projectId &&
      approved.workspaceRoot === definitions.workspaceRoot && fingerprint(definitions.blocks) === fingerprint(approved.blocks) &&
      Boolean(row?.expected_revision) && row?.signature === fingerprint(definitions.rules) && Number(row.saved_at) >= after;
  }
  prune(now: number): string[] {
    const expiredIds: string[] = [];
    for (const row of this.store.db.prepare("SELECT document FROM supervisor_task_interpretations WHERE updated_at<?").all(now - 30 * 86400_000)) {
      const task = JSON.parse(String(row.document)) as TaskRecord;
      if (!["inferred","needs_context","unavailable","expired"].includes(task.status)) continue;
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
  ? {enabled: value.enabled, intervalMinutes: value.intervalMinutes, activityThreshold: value.activityThreshold}
  : {...defaultMonitoringSettings};

const validMonitoringSettings = (value: SupervisorMonitoringSettings): boolean =>
  typeof value.enabled === "boolean" && Number.isInteger(value.intervalMinutes) && value.intervalMinutes >= 1 && value.intervalMinutes <= 60 &&
  Number.isInteger(value.activityThreshold) && value.activityThreshold >= 3 && value.activityThreshold <= 100;
