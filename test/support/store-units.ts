import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { GuidanceDb, guidanceDbLayer, PolicyDb, policyDbLayer } from "../../src/db.js";
import type { SupervisionStoreError } from "../../src/guidance-sql.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { SupervisionStoresLive } from "../../src/supervision-live.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { makeProjectSupervisorMonitorStore, ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { SupervisorStateReset } from "../../src/supervisor-state-reset.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { makeThreadPolicyStore, ThreadPolicyStore } from "../../src/thread-policy.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";

// the store services of a data directory for the suites written against the baseline store objects, each opened where the
// suite constructed its baseline object and through its production layer: the guidance client with its store, then the
// supervision stores of one run (the state reset, the project store with its open-time recovery and ownership reload, the
// conversation, monitor and team stores, src/supervision-live.ts), and the thread-policy client with its store. Each
// service's effects answer as promises: a call runs its effect on its own fiber, resolves with its success and rejects
// with its typed failure (test harness only)

/** The promise of one store call; the marker only types it. */
export type StorePromise<A> = Promise<A> & {readonly "~storeCall"?: true};
/** A service whose effectful methods return promises of their success; its other members are the service's own. */
export type Promised<S> = {
  readonly [K in keyof S]: S[K] extends (...args: infer P) => Effect.Effect<infer A, unknown, never> ? (...args: P) => StorePromise<A> : S[K]
} & {readonly "~service"?: S};

type GuidanceServices = GuidanceDb | SupervisorIds | GuidanceStore;

/**
 * The baseline node:sqlite calls of a suite on the run's guidance client, each answering as a promise; `function` registers a
 * SQL function on the client's own connection and `isTransaction` reads whether that connection is inside a transaction, as
 * the baseline seams on the store's connection did.
 */
export type DbFacade = {
  readonly isTransaction: boolean;
  /** The client's own connection, for a seam that spies on the statements it prepares. */
  readonly connection: DatabaseSync;
  function(name: string, implementation: (...args: Array<never>) => unknown): void;
  exec(statements: string): StorePromise<void>;
  prepare(statement: string): {
    run(...params: ReadonlyArray<unknown>): StorePromise<{changes: number; lastInsertRowid: number}>;
    get(...params: ReadonlyArray<unknown>): StorePromise<Record<string, unknown> | undefined>;
    all(...params: ReadonlyArray<unknown>): StorePromise<Array<Record<string, unknown>>>;
  };
};

// the statements of an exec script; a trigger body's own semicolons stay inside its statement
const statementsOf = (script: string): string[] => {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  for (const token of script.split(/(;|\bBEGIN\b|\bEND\b)/iu)) {
    if (/^BEGIN$/iu.test(token) && /\bTRIGGER\b/iu.test(current)) depth++;
    else if (/^END$/iu.test(token) && depth > 0) depth--;
    if (token === ";" && depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else current += token;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
};

// the raw connection of each guidance file, recorded while a handle opens it (the client keeps its connection private)
const connections = new Map<string, DatabaseSync>();
let recording = 0;
const nativeExec = DatabaseSync.prototype.exec;
const recordConnections = async <A>(open: () => Promise<A>): Promise<A> => {
  if (recording++ === 0) DatabaseSync.prototype.exec = function (this: DatabaseSync, statements: string) {
    const location = this.location();
    if (location) connections.set(resolve(location), this);
    return nativeExec.call(this, statements);
  };
  try {return await open();}
  finally {if (--recording === 0) DatabaseSync.prototype.exec = nativeExec;}
};

const dbFacade = (sql: GuidanceDb["Service"], path: string): DbFacade => {
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
  const connection = () => {
    const raw = connections.get(path);
    if (!raw) throw new Error("the guidance connection was not recorded");
    return raw;
  };
  return {
    get isTransaction() {return connection().isTransaction;},
    get connection() {return connection();},
    function: (name, implementation) => connection().function(name, implementation as never),
    exec: (statements) => run(Effect.forEach(statementsOf(statements), (statement) => sql.unsafe(statement), {discard: true})),
    prepare: (statement) => ({
      run: (...params) => run(Effect.map(sql.unsafe(statement, params).raw, (result) => result as {changes: number; lastInsertRowid: number})),
      get: (...params) => run(Effect.map(sql.unsafe<Record<string, unknown>>(statement, params), (rows) => rows[0])),
      all: (...params) => run(Effect.map(sql.unsafe<Record<string, unknown>>(statement, params), (rows) => [...rows])),
    }),
  };
};
/** The services of one supervision run's stores. */
export type StoreServices = GuidanceServices | SupervisorOwnership | SupervisorStateReset | ProjectSupervisorStore | SupervisorConversationStore |
  ProjectSupervisorMonitorStore | SupervisorTeamStore | ThreadPolicyStore;

/** guidance.sqlite3 with its store, as the baseline GuidanceStore object: the store's calls, the client and a close. */
export type GuidanceHandle = Promised<GuidanceStore["Service"]> & {
  readonly directory: string;
  readonly context: Context.Context<GuidanceServices>;
  readonly sql: GuidanceDb["Service"];
  /** The baseline raw connection calls, on the run's client. */
  readonly db: DbFacade;
  run<A, E>(effect: Effect.Effect<A, E, GuidanceServices>): Promise<A>;
  /** Closes the client and every store opened over it, once; a later call does nothing. */
  close(): StorePromise<void>;
};

/** thread-settings.sqlite3 with its store, as the baseline ThreadPolicyStore object. */
export type PolicyHandle = Promised<ThreadPolicyStore["Service"]> & {
  readonly context: Context.Context<PolicyDb | ThreadPolicyStore>;
  close(): StorePromise<void>;
};

/** The supervision stores of one run over a guidance handle. */
export interface StoreUnit {
  readonly directory: string;
  readonly guidance: GuidanceHandle;
  readonly context: Context.Context<StoreServices>;
  /** The run's ownership set, shared by its stores. */
  readonly owned: Set<string>;
  readonly sql: GuidanceDb["Service"];
  readonly supervisors: SupervisorsFacade;
  readonly requests: Promised<SupervisorConversationStore["Service"]>;
  readonly monitor: Promised<ProjectSupervisorMonitorStore["Service"]>;
  readonly team: Promised<SupervisorTeamStore["Service"]>;
  readonly policy: Promised<ThreadPolicyStore["Service"]>;
  run<A, E>(effect: Effect.Effect<A, E, StoreServices>): Promise<A>;
  /** Closes the guidance handle the unit was opened over. */
  close(): StorePromise<void>;
}

/** The project store's facade; `store` is the guidance handle it opened over, as the baseline `supervisors.store`. */
export type SupervisorsFacade = Promised<ProjectSupervisorStore["Service"]> & {readonly store: GuidanceHandle};

export type StoreUnitOptions = {
  readonly owned?: Set<string>;
  /** The directory of thread-settings.sqlite3, the data directory unless given. */
  readonly policyDirectory?: string;
  /** The seed of a new policy file. */
  readonly excludedThreadIds?: readonly string[];
  /** The identity source; NodeCrypto's v4 uuids unless a test pins them. */
  readonly ids?: Layer.Layer<SupervisorIds>;
};

type Owner = {readonly unit: StoreUnit | null; readonly service: object};
const owners = new WeakMap<object, Owner>();
const handles = new WeakMap<object, {readonly scope: Scope.Closeable; readonly policy: () => Promise<PolicyHandle>}>();
const units = new WeakSet<object>();

// a promise view of `service`, its effects provided with `context`; `extras` are members of the view itself
const promised = <S extends object, X extends object>(service: S, context: Context.Context<never>, extras: X): Promised<S> & X =>
  new Proxy(service, {
    get: (target, key) => {
      if (key in extras) return Reflect.get(extras, key);
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        return Effect.isEffect(result) ? Effect.runPromise(Effect.provide(result as Effect.Effect<unknown, unknown>, context)) : result;
      };
    },
    has: (target, key) => key in extras || key in target,
  }) as unknown as Promised<S> & X;

/** A promise facade of `service` over `context` that belongs to `unit`. */
export const storeFacade = <S extends object, X extends object = Record<never, never>>(unit: StoreUnit | null, service: S, context: Context.Context<never>, extras?: X): Promised<S> & X => {
  const facade = promised(service, context, extras ?? {} as X);
  owners.set(facade, {unit, service});
  return facade;
};

const ownerOf = (facade: object): Owner => {
  const owner = owners.get(facade);
  if (!owner) throw new Error("not a store facade");
  return owner;
};
const isUnit = (value: object): value is StoreUnit => units.has(value);
/** The service behind a facade. */
export const serviceOf = <S>(facade: {readonly "~service"?: S}): S => ownerOf(facade).service as S;
/**
 * Replaces one method of a service object, which its callers read when they call it (a test seam over the service the
 * production code holds); the replacement receives the original, bound to the service.
 */
export const replaceMethod = <S extends object, K extends keyof S>(service: S, key: K, replace: (original: S[K]) => S[K]): (() => void) => {
  const own = service[key];
  const original = (own as (...args: Array<unknown>) => unknown).bind(service) as S[K];
  (service as Record<K, S[K]>)[key] = replace(original);
  // restores the original method
  return () => {(service as Record<K, S[K]>)[key] = own;};
};

/** The policy service of a policy handle. */
export const policyService = (policy: PolicyHandle): ThreadPolicyStore["Service"] => Context.get(policy.context, ThreadPolicyStore);
/** The supervision stores a facade belongs to. */
export const storeUnitOf = (facade: object): StoreUnit => {
  if (isUnit(facade)) return facade;
  const unit = ownerOf(facade).unit;
  if (!unit) throw new Error("the facade belongs to no supervision stores");
  return unit;
};

const build = <S>(layer: Layer.Layer<S, unknown, never>, scope: Scope.Scope): Promise<Context.Context<S>> => Effect.runPromise(Layer.buildWithScope(layer, scope));

/** Opens guidance.sqlite3 of `directory` and its store, as the baseline `new GuidanceStore(directory)`. */
export const openGuidance = (directory: string, options: Pick<StoreUnitOptions, "ids" | "policyDirectory" | "excludedThreadIds"> = {}): StorePromise<GuidanceHandle> =>
  guidanceHandle(directory, options);
const guidanceHandle = async (directory: string, options: Pick<StoreUnitOptions, "ids" | "policyDirectory" | "excludedThreadIds">): Promise<GuidanceHandle> => {
  const scope = Effect.runSync(Scope.make());
  const ids = options.ids ?? SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));
  const exit = await recordConnections(() => Effect.runPromiseExit(Layer.buildWithScope(GuidanceStore.layer.pipe(Layer.provideMerge(guidanceDbLayer(directory)),
    Layer.provideMerge(ids), Layer.provide(NodeFileSystem.layer)), scope)));
  if (Exit.isFailure(exit)) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    return Effect.runPromise(Effect.failCause(exit.cause));
  }
  const context = exit.value;
  let closed: Promise<void> | null = null;
  let policy: Promise<PolicyHandle> | null = null;
  const handle = promised(Context.get(context, GuidanceStore), context as Context.Context<never>, {
    directory, context, sql: Context.get(context, GuidanceDb), db: dbFacade(Context.get(context, GuidanceDb), resolve(directory, "guidance.sqlite3")),
    run: <A, E>(effect: Effect.Effect<A, E, GuidanceServices>) => Effect.runPromise(Effect.provide(effect, context)),
    close: () => closed ??= Effect.runPromise(Scope.close(scope, Exit.void)),
  }) as unknown as GuidanceHandle;
  owners.set(handle, {unit: null, service: Context.get(context, GuidanceStore)});
  // the run's own policy file, opened in the handle's scope on first use
  handles.set(handle, {scope, policy: () => policy ??= openPolicyIn(options.policyDirectory ?? directory, options.excludedThreadIds ?? [], scope)});
  return handle;
};

const policyContext = (directory: string, excludedThreadIds: readonly string[], scope: Scope.Scope) =>
  build(Layer.effect(ThreadPolicyStore, makeThreadPolicyStore({excludedThreadIds: [...excludedThreadIds]})).pipe(
    Layer.provideMerge(policyDbLayer(directory)), Layer.provide(NodeFileSystem.layer)), scope);

const openPolicyIn = async (directory: string, excludedThreadIds: readonly string[], scope: Scope.Scope): Promise<PolicyHandle> => {
  const context = await policyContext(directory, excludedThreadIds, scope);
  const policy = promised(Context.get(context, ThreadPolicyStore), context as Context.Context<never>, {context, close: () => Promise.resolve()}) as unknown as PolicyHandle;
  owners.set(policy, {unit: null, service: Context.get(context, ThreadPolicyStore)});
  return policy;
};

/** Opens thread-settings.sqlite3 of `directory` and its store, as the baseline `new ThreadPolicyStore(directory, seed)`. */
export const openPolicy = (directory: string, seed: {readonly excludedThreadIds: readonly string[]} = {excludedThreadIds: []}): StorePromise<PolicyHandle> =>
  policyHandle(directory, seed);
const policyHandle = async (directory: string, seed: {readonly excludedThreadIds: readonly string[]}): Promise<PolicyHandle> => {
  const scope = Effect.runSync(Scope.make());
  const context = await policyContext(directory, seed.excludedThreadIds, scope).catch(async (error: unknown) => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  });
  let closed: Promise<void> | null = null;
  const policy = promised(Context.get(context, ThreadPolicyStore), context as Context.Context<never>, {
    context, close: () => closed ??= Effect.runPromise(Scope.close(scope, Exit.void)),
  }) as unknown as PolicyHandle;
  owners.set(policy, {unit: null, service: Context.get(context, ThreadPolicyStore)});
  return policy;
};

const handleOf = (value: object): GuidanceHandle => handles.has(value) ? value as GuidanceHandle : storeUnitOf(value).guidance;
const unitOrNull = (value: object): StoreUnit | null => isUnit(value) ? value : owners.get(value)?.unit ?? null;

const openUnit = async (guidance: GuidanceHandle, owned: Set<string>, options: {readonly policy?: PolicyHandle}): Promise<StoreUnit> => {
  const {scope, policy: ownPolicy} = handles.get(guidance)!;
  const policy = options.policy ?? await ownPolicy();
  const supervision = await build(SupervisionStoresLive.pipe(Layer.provide(Layer.mergeAll(Layer.succeedContext(guidance.context),
    Layer.succeed(SupervisorOwnership, owned)))), scope);
  const context = Context.merge(guidance.context, supervision).pipe(Context.add(SupervisorOwnership, owned),
    Context.add(ThreadPolicyStore, Context.get(policy.context, ThreadPolicyStore))) as Context.Context<StoreServices>;
  const unit = {
    directory: guidance.directory, guidance, context, owned, sql: guidance.sql,
    run: <A, E>(effect: Effect.Effect<A, E, StoreServices>) => Effect.runPromise(Effect.provide(effect, context)),
    close: () => guidance.close(),
  } as StoreUnit;
  units.add(unit);
  const facade = <S extends object>(service: S) => storeFacade(unit, service, context as Context.Context<never>);
  return Object.assign(unit, {
    supervisors: storeFacade(unit, Context.get(context, ProjectSupervisorStore), context as Context.Context<never>, {store: guidance}),
    requests: facade(Context.get(context, SupervisorConversationStore)),
    monitor: facade(Context.get(context, ProjectSupervisorMonitorStore)),
    team: facade(Context.get(context, SupervisorTeamStore)),
    policy: storeFacade(unit, Context.get(policy.context, ThreadPolicyStore), policy.context as Context.Context<never>),
  });
};

/**
 * Opens the supervision stores of one run over `guidance`, as the baseline `new ProjectSupervisorStore(guidance, owned)`: the
 * state reset, the project store's open-time recovery and the ownership reload into `owned` run now; the conversation, monitor
 * and team stores of the run open with it. `policy` is the run's policy store, the guidance directory's own unless given.
 */
export const openSupervisors = (guidance: GuidanceHandle, owned: Set<string> = new Set(), options: {readonly policy?: PolicyHandle} = {}):
  StorePromise<SupervisorsFacade> => openUnit(guidance, owned, options).then((unit) => unit.supervisors);

/** Opens the guidance handle of `directory` and one run's supervision stores over it. */
export const openStores = (directory: string, options: StoreUnitOptions = {}): StorePromise<StoreUnit> => storeUnit(directory, options);
const storeUnit = async (directory: string, options: StoreUnitOptions): Promise<StoreUnit> => {
  const guidance = await guidanceHandle(directory, options);
  return openUnit(guidance, options.owned ?? new Set(), {}).catch(async (error: unknown) => {
    await guidance.close();
    throw error;
  });
};

/** The run's team store of a project store, as the baseline `new SupervisorTeamStore(supervisors)`. */
export const teamOf = (supervisors: object): Promised<SupervisorTeamStore["Service"]> => storeUnitOf(supervisors).team;
/** The guidance handle a store opened over, as the baseline `supervisors.store`. */
export const guidanceOf = (store: object): GuidanceHandle => handleOf(store);

/** A conversation store over the guidance handle of `store`, as the baseline `new SupervisorConversationStore(guidance)`. */
export const openRequests = (store: object): StorePromise<Promised<SupervisorConversationStore["Service"]>> => requestsOf(store);
const requestsOf = async (store: object): Promise<Promised<SupervisorConversationStore["Service"]>> => {
  const guidance = handleOf(store);
  const context = await build(SupervisorConversationStore.layer.pipe(Layer.provide(Layer.succeedContext(guidance.context))), handles.get(guidance)!.scope);
  return storeFacade(unitOrNull(store), Context.get(context, SupervisorConversationStore), guidance.context as Context.Context<never>);
};

/** A monitor store over the guidance handle of `store`, as the baseline `new ProjectSupervisorMonitorStore(guidance, capacity)`. */
export const openMonitor = (store: object, capacity?: number): StorePromise<Promised<ProjectSupervisorMonitorStore["Service"]>> => monitorOf(store, capacity);
const monitorOf = async (store: object, capacity: number | undefined): Promise<Promised<ProjectSupervisorMonitorStore["Service"]>> => {
  const guidance = handleOf(store);
  const context = await build(Layer.effect(ProjectSupervisorMonitorStore, makeProjectSupervisorMonitorStore(capacity)).pipe(
    Layer.provide(Layer.succeedContext(guidance.context))), handles.get(guidance)!.scope);
  return storeFacade(unitOrNull(store), Context.get(context, ProjectSupervisorMonitorStore), guidance.context as Context.Context<never>);
};

/** The baseline workflow-editing predicate: a plain answer, a promised one or the effectful predicate itself. */
export type WorkflowEditingAnswer = (projectId: string, mainThreadId?: string) => boolean | Promise<boolean> | Effect.Effect<boolean, SupervisionStoreError>;

const answerOf = (answer: ReturnType<WorkflowEditingAnswer>): Effect.Effect<boolean, SupervisionStoreError> =>
  Effect.isEffect(answer) ? answer : typeof answer === "boolean" ? Effect.succeed(answer) : Effect.promise(() => answer);

/**
 * The workflow state store over a run's project store with `isEnabled` as its workflow-editing predicate, read when the store
 * asks, as the baseline `new WorkflowStateStore(supervisors, isEnabled)`; it closes with the run's guidance handle.
 */
export const openWorkflows = (stores: object, isEnabled: WorkflowEditingAnswer = () => true): StorePromise<Promised<WorkflowStateStore["Service"]>> =>
  workflowsOf(stores, isEnabled);
const workflowsOf = async (stores: object, isEnabled: WorkflowEditingAnswer): Promise<Promised<WorkflowStateStore["Service"]>> => {
  const context = storeContext(stores);
  const unit = storeUnitOf(stores);
  const layer = WorkflowStateStore.layerWith((projectId, mainThreadId) => Effect.suspend(() => answerOf(isEnabled(projectId, mainThreadId))));
  const built = await build(layer.pipe(Layer.provide(Layer.succeedContext(context))), handles.get(unit.guidance)!.scope);
  const service = Context.get(built, WorkflowStateStore);
  return storeFacade(unit, service, Context.add(context, WorkflowStateStore, service) as Context.Context<never>);
};

/** The run's services of a facade or unit (its own project store), with the workflow state store of `workflows` when given. */
export const storeContext = (stores: object, workflows?: Promised<WorkflowStateStore["Service"]> | null):
  Context.Context<StoreServices | WorkflowStateStore> => {
  const unit = storeUnitOf(stores);
  const own = !isUnit(stores) && ownerOf(stores).service;
  const context = own && Context.get(unit.context, ProjectSupervisorStore) !== own && "reserve" in own
    ? Context.add(unit.context, ProjectSupervisorStore, own as ProjectSupervisorStore["Service"]) : unit.context;
  return workflows ? Context.add(context, WorkflowStateStore, serviceOf(workflows)) : context as Context.Context<StoreServices | WorkflowStateStore>;
};
