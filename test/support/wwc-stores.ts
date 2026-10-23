import { DatabaseSync } from "node:sqlite";
import { resolve, join } from "node:path";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import type { SqlClient } from "effect/sql";
import { GuidanceDb, guidanceDbLayer } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { SupervisorStateReset } from "../../src/supervisor-state-reset.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";

// the guidance stores of one workflow-write fixture, on a production client. the raw connection is recorded while it opens
// so a rolled-back apply can read isTransaction, which the public client does not expose

export type WwcStoreServices = GuidanceDb | SupervisorIds | SupervisorOwnership | GuidanceStore | SupervisorStateReset |
  ProjectSupervisorStore | SupervisorConversationStore | SupervisorTeamStore | WorkflowStateStore;

const ids = SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));

const storesLayer = (directory: string): Layer.Layer<WwcStoreServices> => {
  const base = Layer.mergeAll(
    guidanceDbLayer(directory).pipe(Layer.provide(NodeFileSystem.layer)),
    ids,
    Layer.sync(SupervisorOwnership, () => new Set<string>()),
  );
  return Layer.fresh(WorkflowStateStore.layer.pipe(
    Layer.provideMerge(SupervisorTeamStore.layer),
    Layer.provideMerge(SupervisorConversationStore.layer),
    Layer.provideMerge(ProjectSupervisorStore.layer),
    Layer.provideMerge(SupervisorStateReset.layer),
    Layer.provideMerge(GuidanceStore.layer),
    Layer.provideMerge(base),
  )).pipe(Layer.orDie);
};

const connections = new Map<string, DatabaseSync>();
const nativeExec = DatabaseSync.prototype.exec;

// patch exec only while this open runs, then restore it. a later open of the same file replaces the recorded connection
const recording = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      DatabaseSync.prototype.exec = function (this: DatabaseSync, statements: string) {
        const location = this.location();
        if (location) connections.set(resolve(location), this);
        return nativeExec.call(this, statements);
      };
    }),
    () => effect,
    () => Effect.sync(() => {
      DatabaseSync.prototype.exec = nativeExec;
    }),
  );

export interface WwcStores {
  readonly directory: string;
  readonly context: Context.Context<WwcStoreServices>;
  readonly db: SqlClient.SqlClient;
  readonly guidance: GuidanceStore["Service"];
  readonly supervisors: ProjectSupervisorStore["Service"];
  readonly workflows: WorkflowStateStore["Service"];
  readonly team: SupervisorTeamStore["Service"];
  readonly requests: SupervisorConversationStore["Service"];
  // true while the recorded connection is inside a transaction
  readonly inTransaction: boolean;
  // closes this client once; a second close is a no-op
  readonly close: Effect.Effect<void>;
}

/** Opens the production stores of `directory` in a child scope the test can close and open again. */
export const openWwcStores = (directory: string): Effect.Effect<WwcStores, never, Scope.Scope> =>
  recording(Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => idempotentClose(scope));
    const context = yield* Layer.buildWithScope(storesLayer(directory), scope).pipe(Effect.orDie);
    const path = resolve(join(directory, "guidance.sqlite3"));
    return {
      directory,
      context,
      db: Context.get(context, GuidanceDb),
      guidance: Context.get(context, GuidanceStore),
      supervisors: Context.get(context, ProjectSupervisorStore),
      workflows: Context.get(context, WorkflowStateStore),
      team: Context.get(context, SupervisorTeamStore),
      requests: Context.get(context, SupervisorConversationStore),
      get inTransaction() {
        const connection = connections.get(path);
        if (!connection) throw new Error("the guidance connection was not recorded");
        return connection.isTransaction;
      },
      close: idempotentClose(scope),
    };
  }));

/** The first row of a statement, or undefined when it returns nothing. */
export const sqlGet = (sql: SqlClient.SqlClient, statement: string, ...params: ReadonlyArray<unknown>): Effect.Effect<Record<string, unknown> | undefined> =>
  sql.unsafe<Record<string, unknown>>(statement, params).pipe(Effect.map((rows) => rows[0]), Effect.orDie);

/** Every row of a statement, copied so a caller can read its values in column order. */
export const sqlAll = (sql: SqlClient.SqlClient, statement: string, ...params: ReadonlyArray<unknown>): Effect.Effect<Array<Record<string, unknown>>> =>
  sql.unsafe<Record<string, unknown>>(statement, params).pipe(Effect.map((rows) => rows.map((row) => ({...row}))), Effect.orDie);

/** Runs one statement. */
export const sqlRun = (sql: SqlClient.SqlClient, statement: string, ...params: ReadonlyArray<unknown>): Effect.Effect<void> =>
  sql.unsafe(statement, params).pipe(Effect.asVoid, Effect.orDie);

type CloseableScope = Parameters<typeof Scope.close>[0];
const closed = new WeakSet<CloseableScope>();
const idempotentClose = (scope: CloseableScope): Effect.Effect<void> => Effect.suspend(() => {
  if (closed.has(scope)) return Effect.void;
  closed.add(scope);
  return Scope.close(scope, Exit.void);
});
