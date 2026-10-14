import type { DatabaseSync } from "node:sqlite";

const disposableTables = [
  "supervisor_project_bindings", "supervisor_main_bindings", "supervisor_task_interpretations",
  "supervisor_conversation_requests", "supervisor_workflow_introductions", "supervisor_workflow_agreement_candidates",
  "supervisor_monitor_project_clock", "supervisor_monitor_binding_clock", "supervisor_monitor_items", "supervisor_monitor_threads",
] as const;

/** Resets the explicitly disposable prototype state, preserving defaults and permanent ownership. */
export const resetSupervisorTestState = (db: DatabaseSync): void => {
  for (const table of disposableTables) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.exec(`DELETE FROM ${table}`);
  }
  db.prepare("DELETE FROM meta WHERE key IN ('supervisor_activation_baseline','supervisor_activation_sequence')").run();
};

/** Applies the approved one-time reset when upgrading the project-scoped prototype. */
export const initializeMainSupervisionState = (db: DatabaseSync): boolean => {
  const version = db.prepare("SELECT value FROM meta WHERE key='supervisor_scope_version'").get()?.value;
  if (version === "main-v1") return true;
  if (version !== undefined) return false;
  resetSupervisorTestState(db);
  db.prepare("INSERT INTO meta VALUES('supervisor_scope_version','main-v1')").run();
  return true;
};
