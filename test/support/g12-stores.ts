import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, FileSystem, Layer, Scope } from "effect";
import type { SqlClient } from "effect/sql";
import { GuidanceDb, guidanceDbLayer } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { SupervisorStateReset } from "../../src/supervisor-state-reset.js";
import { WorkflowStateStore, type WorkflowEditingEnabled } from "../../src/workflow-state-store.js";

// the g12 suites' guidance stores on a temporary data directory, each built through its production layer over the production
// GuidanceDb client; a suite may close the client and open the same file again, as a restart or a crash of the process does

/** A temporary data directory, removed with the test scope. */
export const temporaryDirectory = (prefix: string): Effect.Effect<string, never, Scope.Scope> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
}).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer));

/**
 * Answers for one templated statement before it runs: a recorder that receives the statement's parameters and rows once it
 * ran, or undefined for a statement the test does not observe.
 */
export type StatementObserver = (statement: string) => ((params: ReadonlyArray<unknown>, rows: unknown) => void) | undefined;

// the production client whose observed templated statements report once they ran, outside any transaction they run in (a test
// seam, as a trigger calling an application function was); every other statement and use of the client is unchanged
const observed = (client: SqlClient.SqlClient, observe: StatementObserver): SqlClient.SqlClient => new Proxy(client, {
  apply: (target, thisArg, args: unknown[]) => {
    const statement: unknown = Reflect.apply(target, thisArg, args);
    const [strings, ...params] = args;
    const record = Array.isArray(strings) ? observe(strings.join("?")) : undefined;
    return record ? Effect.tap(statement as Effect.Effect<unknown>, (rows) => Effect.sync(() => record(params, rows))) : statement;
  },
});

/** The production guidance.sqlite3 client of `directory`, optionally observed. */
export const guidanceClient = (directory: string, observe?: StatementObserver): Layer.Layer<GuidanceDb> => {
  const production = guidanceDbLayer(directory).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie);
  return observe ? Layer.effect(GuidanceDb, Effect.map(Effect.service(GuidanceDb), (sql) => observed(sql, observe))).pipe(Layer.provide(production)) : production;
};

/** The production identity source over the platform crypto. */
export const supervisorIds: Layer.Layer<SupervisorIds> = SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));

export type WorkflowStoreServices = GuidanceDb | SupervisorIds | SupervisorOwnership | GuidanceStore | SupervisorStateReset | ProjectSupervisorStore |
  WorkflowStateStore;

export interface WorkflowStoreOptions {
  // the workflow store's owner predicate; by default the project's effective enable state (WorkflowStateStore.layer)
  readonly isEnabled?: WorkflowEditingEnabled | undefined;
  readonly observe?: StatementObserver | undefined;
}

// the client, the ids and a fresh ownership set, then the guidance store, the one-time state reset, the project supervision
// store and the workflow state store, in the production order
const workflowStoresLayer = (directory: string, options: WorkflowStoreOptions): Layer.Layer<WorkflowStoreServices> => {
  const base = Layer.mergeAll(guidanceClient(directory, options.observe), supervisorIds, Layer.sync(SupervisorOwnership, () => new Set<string>()));
  const workflows = options.isEnabled ? WorkflowStateStore.layerWith(options.isEnabled) : WorkflowStateStore.layer;
  return Layer.fresh(workflows.pipe(
    Layer.provideMerge(ProjectSupervisorStore.layer),
    Layer.provideMerge(SupervisorStateReset.layer),
    Layer.provideMerge(GuidanceStore.layer),
    Layer.provideMerge(base),
  )).pipe(Layer.orDie);
};

export interface WorkflowStores {
  readonly directory: string;
  readonly sql: GuidanceDb["Service"];
  readonly supervisors: ProjectSupervisorStore["Service"];
  readonly workflows: WorkflowStateStore["Service"];
  readonly context: Context.Context<WorkflowStoreServices>;
  // closes this client of the file and the stores over it, as a restart closes the process's client
  readonly close: Effect.Effect<void>;
}

/** Opens the stores of `directory` in their own scope, closed with the test scope unless the test closes them first. */
export const openWorkflowStores = (directory: string, options: WorkflowStoreOptions = {}): Effect.Effect<WorkflowStores, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope, "sequential");
    const context = yield* Layer.buildWithScope(workflowStoresLayer(directory, options), scope);
    return {
      directory, context, close: Scope.close(scope, Exit.void),
      sql: Context.get(context, GuidanceDb), supervisors: Context.get(context, ProjectSupervisorStore), workflows: Context.get(context, WorkflowStateStore),
    };
  });

/** Runs one statement on a client, as a suite's direct write to the file. */
export const execute = (sql: SqlClient.SqlClient, statement: string, ...params: ReadonlyArray<unknown>): Effect.Effect<void> =>
  sql.unsafe(statement, params).pipe(Effect.asVoid, Effect.orDie);

/** The rows of a query as plain objects. */
export const query = (sql: SqlClient.SqlClient, statement: string, ...params: ReadonlyArray<unknown>): Effect.Effect<Array<Record<string, unknown>>> =>
  sql.unsafe<Record<string, unknown>>(statement, params).pipe(Effect.map((rows) => rows.map((row) => ({ ...row }))), Effect.orDie);
