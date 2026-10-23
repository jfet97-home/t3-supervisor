import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, FileSystem, Layer, Scope } from "effect";
import type { SqlClient } from "effect/sql";
import { SupervisorConfig as Configuration } from "../../src/config.js";
import { GuidanceDb, guidanceDbLayer, policyDbLayer } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { SupervisionStoresLive } from "../../src/supervision-live.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { SupervisorStateReset } from "../../src/supervisor-state-reset.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { SupervisorSettings } from "../../src/types.js";

// the stores of the g11 suites on a temporary data directory, each built through its production layer: the run's guidance
// client and store (src/db.ts, src/guidance-store.ts), the supervision stores over them in the run's order
// (SupervisionStoresLive of src/supervision-live.ts) and the process's thread-policy store on its own client

/** A fresh temporary data directory, removed with the test scope. */
export const temporaryDirectory = (prefix: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
}).pipe(Effect.provide(NodeFileSystem.layer));

/** The platform's v4 identities, as the root provides them. */
export const ids = SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));

/** The guidance client of `directory` and the guidance store over it, as the supervision run builds them. */
export const guidanceLayer = (directory: string) =>
  Layer.fresh(GuidanceStore.layer.pipe(Layer.provideMerge(guidanceDbLayer(directory)), Layer.provide(ids), Layer.provide(NodeFileSystem.layer)));

/** The guidance client of `directory` alone: the file's pragmas and nothing of the store's schema. */
export const guidanceClient = (directory: string) => Layer.fresh(guidanceDbLayer(directory)).pipe(Layer.provide(NodeFileSystem.layer));

export type SupervisionStoreServices = GuidanceDb | GuidanceStore | SupervisorIds | SupervisorOwnership | SupervisorStateReset |
  ProjectSupervisorStore | SupervisorConversationStore | ProjectSupervisorMonitorStore | SupervisorTeamStore;

/** The guidance client and store, the ids, the process's ownership set and the supervision stores over them. */
export const supervisionStoresLayer = (directory: string, owned: Set<string> = new Set()): Layer.Layer<SupervisionStoreServices, unknown> =>
  SupervisionStoresLive.pipe(
    Layer.provideMerge(guidanceLayer(directory)),
    Layer.provideMerge(Layer.mergeAll(ids, Layer.succeed(SupervisorOwnership, owned))));

export interface SupervisionStores {
  readonly directory: string;
  readonly sql: SqlClient.SqlClient;
  readonly guidance: GuidanceStore["Service"];
  readonly supervisors: ProjectSupervisorStore["Service"];
  readonly team: SupervisorTeamStore["Service"];
  readonly requests: SupervisorConversationStore["Service"];
  readonly context: Context.Context<SupervisionStoreServices>;
  // closes this client of the file, as a crash or the end of the process closes it
  readonly close: Effect.Effect<void>;
}

/** Opens the stores of `directory` in their own scope, so a suite can close the file and open it again. */
export const openSupervisionStores = (directory: string, owned: Set<string> = new Set()) => Effect.gen(function* () {
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(supervisionStoresLayer(directory, owned), scope).pipe(
    Effect.onError(() => Scope.close(scope, Exit.void)), Effect.orDie);
  return {
    directory, context, close: Scope.close(scope, Exit.void),
    sql: Context.get(context, GuidanceDb), guidance: Context.get(context, GuidanceStore), supervisors: Context.get(context, ProjectSupervisorStore),
    team: Context.get(context, SupervisorTeamStore), requests: Context.get(context, SupervisorConversationStore),
  } satisfies SupervisionStores;
});

/** The stores of `directory`, closed with the test scope unless the test closes them first. */
export const supervisionStores = (directory: string, owned: Set<string> = new Set()) =>
  Effect.acquireRelease(openSupervisionStores(directory, owned), (stores) => stores.close);

/** The process's thread-policy store of `settings` on its own client of thread-settings.sqlite3. */
export const policyLayer = (settings: SupervisorSettings) => Layer.fresh(ThreadPolicyStore.layer.pipe(
  Layer.provide(policyDbLayer(settings.dataDirectory)), Layer.provide(Layer.succeed(Configuration, settings)), Layer.provide(NodeFileSystem.layer)));

/** Runs one statement on a client, as a suite's direct write to the file. */
export const execute = (sql: SqlClient.SqlClient, statement: string, ...params: ReadonlyArray<unknown>): Effect.Effect<void> =>
  sql.unsafe(statement, params).pipe(Effect.asVoid, Effect.orDie);

/** The rows of a query as plain objects, for comparing table contents. */
export const rows = (sql: SqlClient.SqlClient, query: string, ...params: ReadonlyArray<unknown>): Effect.Effect<Array<Record<string, unknown>>> =>
  sql.unsafe<Record<string, unknown>>(query, params).pipe(Effect.map((result) => result.map((row) => ({ ...row }))), Effect.orDie);

/** The first row of a query, or undefined. */
export const row = (sql: SqlClient.SqlClient, query: string, ...params: ReadonlyArray<unknown>): Effect.Effect<Record<string, unknown> | undefined> =>
  Effect.map(rows(sql, query, ...params), (found) => found[0]);
