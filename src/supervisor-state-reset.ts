import type { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { GuidanceDb, untracedSql } from "./db.js";
import { decodeGuidanceRow, type GuidanceStoreError, guidanceSql } from "./guidance-store.js";

const disposableTables = [
  "supervisor_project_bindings", "supervisor_main_bindings", "supervisor_task_interpretations",
  "supervisor_conversation_requests", "supervisor_workflow_introductions", "supervisor_workflow_agreement_candidates",
  "supervisor_monitor_project_clock", "supervisor_monitor_binding_clock", "supervisor_monitor_items", "supervisor_monitor_threads",
] as const;

// the synchronous reset and initialization of today's caller (ProjectSupervisorStore); the s6d switch removes them for
// SupervisorStateReset
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

const decodeVersionRow = decodeGuidanceRow(Schema.Struct({ value: Schema.String }), "meta");

/** The Effect API of the one-time supervision state reset; both join the caller's transaction. */
export interface SupervisorStateResetShape {
  /** Resets the explicitly disposable prototype state, preserving defaults and permanent ownership. */
  readonly resetSupervisorTestState: () => Effect.Effect<void, GuidanceStoreError>;
  /** Applies the approved one-time reset when upgrading the project-scoped prototype; false disables supervision. */
  readonly initializeMainSupervisionState: () => Effect.Effect<boolean, GuidanceStoreError>;
}

const makeSupervisorStateReset = Effect.gen(function* () {
  const db = yield* GuidanceDb;

  const reset = Effect.gen(function* () {
    for (const table of disposableTables) {
      if ((yield* db`SELECT 1 FROM sqlite_master WHERE type='table' AND name=${table}`).length > 0) yield* db`DELETE FROM ${db(table)}`;
    }
    yield* db`DELETE FROM meta WHERE key IN ('supervisor_activation_baseline','supervisor_activation_sequence')`;
  });

  const resetSupervisorTestState = () => guidanceSql(db.withTransaction(reset));

  // the version read, the reset and the version insert commit together, or none does (CT-RESET-01)
  const initializeMainSupervisionState = () => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const [row] = yield* db`SELECT value FROM meta WHERE key='supervisor_scope_version'`;
    const version = row === undefined ? undefined : (yield* decodeVersionRow(row)).value;
    if (version === "main-v1") return true;
    if (version !== undefined) return false;
    yield* reset;
    yield* db`INSERT INTO meta VALUES('supervisor_scope_version','main-v1')`;
    return true;
  })));

  return SupervisorStateReset.of({ resetSupervisorTestState, initializeMainSupervisionState });
});

/**
 * The one-time reset on the run's GuidanceDb client, run by the project-supervisor store's layer before any other
 * store use; it needs the guidance store's meta table (GuidanceStoreService.layer runs first, as the synchronous
 * constructors do today).
 */
export class SupervisorStateReset extends Context.Service<SupervisorStateReset, SupervisorStateResetShape>()("t3-supervisor/SupervisorStateReset") {
  static readonly layer: Layer.Layer<SupervisorStateReset, never, GuidanceDb> = Layer.effect(SupervisorStateReset, untracedSql(makeSupervisorStateReset));
}
