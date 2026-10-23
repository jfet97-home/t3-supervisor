import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, FileSystem, Layer, Scope } from "effect";
import { GuidanceDb } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { SupervisionStoresLive } from "../../src/supervision-live.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { SupervisorConfig } from "../../src/types.js";
import { WorkflowStateStore, type WorkflowEditingEnabled } from "../../src/workflow-state-store.js";
import { guidanceLayer, ids, policyLayer, type SupervisionStoreServices } from "./g11-stores.js";
import { dbSeam, recordConnections, type DbSeam } from "./psx-sql.js";

export interface GuidanceOpen {
  readonly context: Context.Context<SupervisionStoreServices>;
  readonly sql: GuidanceDb["Service"];
  readonly guidance: GuidanceStore["Service"];
  readonly db: DbSeam;
}

/** Guidance store of `directory` in `scope`. The raw connection is recorded while the client opens. */
export const openGuidance = (directory: string, scope: Scope.Scope): Effect.Effect<GuidanceOpen> =>
  recordConnections(Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(guidanceLayer(directory).pipe(Layer.provideMerge(ids)), scope).pipe(Effect.orDie);
    return {context: context as Context.Context<SupervisionStoreServices>, sql: Context.get(context, GuidanceDb), guidance: Context.get(context, GuidanceStore),
      db: dbSeam(resolve(directory, "guidance.sqlite3"))};
  }));

export interface StoreOpen extends GuidanceOpen {
  readonly owned: Set<string>;
  readonly supervisors: ProjectSupervisorStore["Service"];
  readonly requests: SupervisorConversationStore["Service"];
  readonly monitor: ProjectSupervisorMonitorStore["Service"];
  readonly team: SupervisorTeamStore["Service"];
  readonly policy: ThreadPolicyStore["Service"];
  readonly context: Context.Context<SupervisionStoreServices | ThreadPolicyStore>;
}

const settingsOf = (directory: string, excludedThreadIds: readonly string[] = []): SupervisorConfig =>
  ({dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: [...excludedThreadIds], healthPort: 0});

/** The supervision stores and the thread-policy store over an open guidance client, in `scope`. */
export const openSupervisors = (directory: string, guidance: GuidanceOpen, scope: Scope.Scope, owned = new Set<string>(),
  excludedThreadIds: readonly string[] = []): Effect.Effect<StoreOpen> =>
  recordConnections(Effect.gen(function* () {
    const built = yield* Layer.buildWithScope(SupervisionStoresLive.pipe(
      Layer.provide(Layer.succeedContext(guidance.context)), Layer.provide(Layer.succeed(SupervisorOwnership, owned))), scope).pipe(Effect.orDie);
    const policyContext = yield* Layer.buildWithScope(policyLayer(settingsOf(directory, excludedThreadIds)), scope).pipe(Effect.orDie);
    const policy = Context.get(policyContext, ThreadPolicyStore);
    const context = Context.merge(guidance.context, built).pipe(Context.add(SupervisorOwnership, owned), Context.add(ThreadPolicyStore, policy));
    return {
      ...guidance, owned, policy, context, sql: guidance.sql, db: guidance.db, guidance: guidance.guidance,
      supervisors: Context.get(context, ProjectSupervisorStore), requests: Context.get(context, SupervisorConversationStore),
      monitor: Context.get(context, ProjectSupervisorMonitorStore), team: Context.get(context, SupervisorTeamStore),
    };
  }));

/** The workflow state store over `stores`, closed with `scope`. */
export const openWorkflows = (stores: StoreOpen, scope: Scope.Scope,
  enabled: WorkflowEditingEnabled = () => Effect.succeed(true)) =>
  Effect.map(Layer.buildWithScope(WorkflowStateStore.layerWith((projectId, mainThreadId) => enabled(projectId, mainThreadId)).pipe(
    Layer.provide(Layer.succeedContext(stores.context))), scope).pipe(Effect.orDie), (context) => Context.get(context, WorkflowStateStore));

export interface RunFiles {
  readonly directory: string;
  readonly path: string;
  readonly stores: StoreOpen;
  readonly workflows: WorkflowStateStore["Service"] | null;
  readonly close: Effect.Effect<void>;
}

/** One process's guidance, supervision stores, policy and optional workflow store, in their own scope. */
export const openRun = (directory: string, options: {readonly workflows?: boolean; readonly excludedThreadIds?: readonly string[]} = {}): Effect.Effect<RunFiles> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const close = Scope.close(scope, Exit.void);
    const opened = yield* Effect.gen(function* () {
      const guidance = yield* openGuidance(directory, scope);
      const stores = yield* openSupervisors(directory, guidance, scope, new Set(), options.excludedThreadIds ?? []);
      const workflows = options.workflows ? yield* openWorkflows(stores, scope) : null;
      return {directory, path: join(directory, "guidance.sqlite3"), stores, workflows, close};
    }).pipe(Effect.onError(() => close));
    return opened;
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie);

/** A temporary data directory removed with the current scope. */
export const temporaryDirectory = (prefix: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({prefix});
}).pipe(Effect.provide(NodeFileSystem.layer));

export interface PssHandle {
  readonly guidance: GuidanceOpen;
  readonly stores: StoreOpen;
  readonly store: StoreOpen["supervisors"];
  readonly ownedIds: Set<string>;
  readonly db: DbSeam;
  readonly scope: Scope.Scope;
  readonly close: Effect.Effect<void>;
}

/** One temp guidance directory. Each `open` is its own scope, closed again by the test or when this scope ends. */
export const pssSession = (prefix: string) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory(prefix);
  const path = join(directory, "guidance.sqlite3");
  const handles: Array<{readonly close: Effect.Effect<void>}> = [];
  const open = (before?: (guidance: GuidanceOpen) => Effect.Effect<void, never, Scope.Scope>): Effect.Effect<PssHandle, never, Scope.Scope> => Effect.gen(function* () {
    const scope = yield* Scope.make();
    let closed = false;
    const close = Effect.gen(function* () {
      if (closed) return;
      closed = true;
      yield* Scope.close(scope, Exit.void);
    });
    handles.push({close});
    const guidance = yield* openGuidance(directory, scope).pipe(Effect.onError(() => close));
    if (before) yield* before(guidance).pipe(Effect.onError(() => close));
    const ownedIds = new Set<string>();
    const stores = yield* openSupervisors(directory, guidance, scope, ownedIds).pipe(Effect.onError(() => close));
    return {guidance, stores, store: stores.supervisors, ownedIds, db: stores.db, scope, close};
  });
  yield* Effect.addFinalizer(() => Effect.forEach(handles, (handle) => handle.close, {discard: true}).pipe(Effect.orDie));
  return {directory, path, open};
});

/** A read-only connection closed with the current scope. */
export const readOnlyDatabase = (path: string): Effect.Effect<DatabaseSync, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(() => new DatabaseSync(path, {readOnly: true})), (db) => Effect.sync(() => db.close()));

/** Spies on `prepare` until the current scope closes. The calls are the statement texts. */
export const spyPrepare = (connection: DatabaseSync): Effect.Effect<Array<string>, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(() => {
    const calls: Array<string> = [];
    const own = Object.prototype.hasOwnProperty.call(connection, "prepare");
    const original = connection.prepare;
    connection.prepare = ((sql: string) => {
      calls.push(String(sql));
      return original.call(connection, sql);
    }) as DatabaseSync["prepare"];
    return {calls, own, original};
  }), ({own, original}) => Effect.sync(() => {
    if (own) connection.prepare = original;
    else delete (connection as {prepare?: DatabaseSync["prepare"]}).prepare;
  })).pipe(Effect.map(({calls}) => calls));

