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

// the guidance stores of one workflow-write fixture, on a production client and its worker connection

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

export interface WwcStores {
  readonly directory: string;
  readonly context: Context.Context<WwcStoreServices>;
  readonly db: SqlClient.SqlClient;
  readonly guidance: GuidanceStore["Service"];
  readonly supervisors: ProjectSupervisorStore["Service"];
  readonly workflows: WorkflowStateStore["Service"];
  readonly team: SupervisorTeamStore["Service"];
  readonly requests: SupervisorConversationStore["Service"];
  // whether the stores' connection is inside a transaction: a plain BEGIN fails exactly then and is otherwise rolled back
  readonly inTransaction: Effect.Effect<boolean>;
  // closes this client once; a second close is a no-op
  readonly close: Effect.Effect<void>;
}

/** Opens the production stores of `directory` in a child scope the test can close and open again. */
export const openWwcStores = (directory: string): Effect.Effect<WwcStores, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => idempotentClose(scope));
    const context = yield* Layer.buildWithScope(storesLayer(directory), scope).pipe(Effect.orDie);
    const db = Context.get(context, GuidanceDb);
    return {
      directory,
      context,
      db,
      guidance: Context.get(context, GuidanceStore),
      supervisors: Context.get(context, ProjectSupervisorStore),
      workflows: Context.get(context, WorkflowStateStore),
      team: Context.get(context, SupervisorTeamStore),
      requests: Context.get(context, SupervisorConversationStore),
      inTransaction: Effect.flatMap(Effect.exit(db.unsafe("BEGIN")), (exit) =>
        Exit.isSuccess(exit) ? Effect.as(Effect.orDie(db.unsafe("ROLLBACK")), false) : Effect.succeed(true)),
      close: idempotentClose(scope),
    };
  });

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
