import assert from "node:assert/strict";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, FileSystem, Layer, Ref, Scope } from "effect";
import type { SqlClient } from "effect/sql";
import { GuidanceDb, guidanceDbLayer, PolicyDb, policyDbLayer } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { SupervisorStateReset } from "../../src/supervisor-state-reset.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { WorkflowStateStore, type WorkflowEditingEnabled } from "../../src/workflow-state-store.js";

// the store services on a temporary guidance database, each built through its production layer over the production
// GuidanceDb client; nothing else opens the file while they are built

export type GuidanceStoreServices = GuidanceDb | ProjectSupervisorStore | SupervisorTeamStore | WorkflowStateStore;

/** Runs before every templated statement whose text it answers for, inside that statement's transaction (a test seam). */
export type StatementInterposer = (statement: string) => Effect.Effect<void> | undefined;

export type GuidanceStoreOptions = {
  /** The root's shared ownership set. */
  readonly owned?: Set<string>;
  readonly isEnabled?: WorkflowEditingEnabled;
  readonly interpose?: StatementInterposer;
  /** The identity source; NodeCrypto's v4 uuids unless a test pins them. */
  readonly ids?: Layer.Layer<SupervisorIds>;
};

// the production client, or the same client whose templated statements first run the interposer's effect
const interposed = (client: SqlClient.SqlClient, interpose: StatementInterposer): SqlClient.SqlClient => new Proxy(client, {
  apply: (target, thisArg, args: unknown[]) => {
    const statement = Reflect.apply(target, thisArg, args) as Effect.Effect<unknown>;
    const strings = args[0];
    const before = Array.isArray(strings) ? interpose(strings.join("?")) : undefined;
    return before ? Effect.andThen(before, statement) : statement;
  },
});

/** The client and the three store services of `directory`. */
export const guidanceStoreServices = (directory: string, options: GuidanceStoreOptions = {}) => {
  const production = guidanceDbLayer(directory).pipe(Layer.provide(NodeFileSystem.layer));
  const interpose = options.interpose;
  const client = interpose ? Layer.effect(GuidanceDb, Effect.map(Effect.service(GuidanceDb), (sql) => interposed(sql, interpose))).pipe(Layer.provide(production)) : production;
  const ids = options.ids ?? SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));
  const base = Layer.mergeAll(client, Layer.succeed(SupervisorOwnership, options.owned ?? new Set()), ids);
  const supervisors = ProjectSupervisorStore.layer.pipe(Layer.provide(SupervisorStateReset.layer), Layer.provide(GuidanceStore.layer));
  const workflows = options.isEnabled ? WorkflowStateStore.layerWith(options.isEnabled) : WorkflowStateStore.layer;
  return Layer.fresh(Layer.mergeAll(SupervisorTeamStore.layer, workflows).pipe(Layer.provideMerge(supervisors), Layer.provideMerge(base)));
};

/** Opens the services of `directory` in their own scope, so a test can close the database and open it again. */
export const openGuidanceStores = Effect.fnUntraced(function* (directory: string, options: GuidanceStoreOptions = {}) {
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(guidanceStoreServices(directory, options), scope).pipe(
    Effect.onError(() => Scope.close(scope, Exit.void)));
  return {
    owned: Context.get(context, SupervisorOwnership),
    ids: Context.get(context, SupervisorIds),
    sql: Context.get(context, GuidanceDb),
    supervisors: Context.get(context, ProjectSupervisorStore),
    team: Context.get(context, SupervisorTeamStore),
    workflows: Context.get(context, WorkflowStateStore),
    close: Scope.close(scope, Exit.void),
  };
});

/** A temporary data directory, removed with the test scope. */
export const temporaryDataDirectory = (prefix: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
});

/** The services of a fresh temporary directory, closed with the test scope (before the directory is removed). */
export const guidanceStoresFixture = Effect.fnUntraced(function* (prefix: string, options: GuidanceStoreOptions = {}) {
  const directory = yield* temporaryDataDirectory(prefix);
  const stores = yield* Effect.acquireRelease(openGuidanceStores(directory, options), (opened) => opened.close);
  return { directory, ...stores };
});

/** Fails the test unless `effect` fails with an error whose message matches `pattern`; returns that error. */
export const failsWith = <A, E>(effect: Effect.Effect<A, E>, pattern: RegExp) => Effect.flip(effect).pipe(Effect.map((error) => {
  assert.ok(error instanceof Error, "the failure is an error");
  assert.match(error.message, pattern);
  return error;
}));

/** Opens the services of an existing `directory` again, closed with the test scope unless the test closes them first. */
export const reopenGuidanceStores = (directory: string, options: GuidanceStoreOptions = {}) =>
  Effect.acquireRelease(openGuidanceStores(directory, options), (opened) => opened.close);

/** An identity source that draws v4-shaped uuids from a counter, so a test can pin every identity a store allocates. */
export const countingIds = Layer.effect(SupervisorIds, Effect.gen(function* () {
  const counter = yield* Ref.make(0);
  return SupervisorIds.of({uuid: Effect.map(Ref.updateAndGet(counter, (value) => value + 1), (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`)});
}));

// the store services of WP-S6d-A on a temporary data directory, each opened through the production database layer

export const temporaryDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-s6d-" });
}).pipe(Effect.provide(NodeFileSystem.layer));

/** Ids in the persisted v4 format, numbered from 1 in draw order for each built layer. */
export const sequentialIds = (prefix = "00000000-0000-4000-8000"): Layer.Layer<SupervisorIds> => Layer.effect(SupervisorIds, Effect.sync(() => {
  let drawn = 0;
  return SupervisorIds.of({ uuid: Effect.sync(() => `${prefix}-${String(++drawn).padStart(12, "0")}`) });
}));

/** A fresh guidance.sqlite3 client for `directory`, closed when the effect using it ends. */
export const guidanceDb = (directory: string): Layer.Layer<GuidanceDb, never> =>
  Layer.fresh(guidanceDbLayer(directory)).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie);

/** A fresh thread-settings.sqlite3 client for `directory`, closed when the effect using it ends. */
export const policyDb = (directory: string): Layer.Layer<PolicyDb, never> =>
  Layer.fresh(policyDbLayer(directory)).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie);

/** Rows of a query as plain objects, for comparing table contents. */
export const rows = (db: SqlClient.SqlClient, query: string, ...params: ReadonlyArray<unknown>) =>
  db.unsafe<Record<string, unknown>>(query, params).pipe(Effect.map((result) => result.map((row) => ({ ...row }))), Effect.orDie);
