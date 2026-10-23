import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { GuidanceDb, guidanceDbLayer, PolicyDb, policyDbLayer } from "../../src/db.js";
import type { SupervisionStoreError } from "../../src/guidance-sql.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { SupervisionStoresLive } from "../../src/supervision-live.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { SupervisorStateReset } from "../../src/supervisor-state-reset.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { makeThreadPolicyStore, ThreadPolicyStore } from "../../src/thread-policy.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";

// the store services of one supervision run on a data directory, built through their production layers in the production
// order (src/supervision-live.ts) for the suites written against the baseline store objects, and each service's effects as
// promises: a call runs its effect on its own fiber, resolves with its success and rejects with its typed failure (test
// harness only)

/** The promise of one store call; the marker only types it. */
export type StorePromise<A> = Promise<A> & {readonly "~storeCall"?: true};
/** A service whose effectful methods return promises of their success; its other members are the service's own. */
export type Promised<S> = {
  readonly [K in keyof S]: S[K] extends (...args: infer P) => Effect.Effect<infer A, infer _E, never> ? (...args: P) => StorePromise<A> : S[K]
};

/** The services of one data directory: the guidance client and its stores, and the thread-policy client and store. */
export type StoreServices = GuidanceDb | SupervisorIds | SupervisorOwnership | GuidanceStore | SupervisorStateReset | ProjectSupervisorStore |
  SupervisorConversationStore | ProjectSupervisorMonitorStore | SupervisorTeamStore | PolicyDb | ThreadPolicyStore;

export interface StoreUnit {
  readonly directory: string;
  readonly context: Context.Context<StoreServices>;
  /** The run's ownership set, shared by every store of the unit. */
  readonly owned: Set<string>;
  readonly sql: GuidanceDb["Service"];
  readonly guidance: Promised<GuidanceStore["Service"]>;
  readonly supervisors: Promised<ProjectSupervisorStore["Service"]>;
  readonly requests: Promised<SupervisorConversationStore["Service"]>;
  readonly monitor: Promised<ProjectSupervisorMonitorStore["Service"]>;
  readonly team: Promised<SupervisorTeamStore["Service"]>;
  readonly policy: Promised<ThreadPolicyStore["Service"]>;
  /** Runs an effect over the unit's services. */
  run<A, E>(effect: Effect.Effect<A, E, StoreServices>): Promise<A>;
  /** Closes both clients once, as the baseline close of each store did; a later call does nothing. */
  close(): Promise<void>;
}

export type StoreUnitOptions = {
  readonly owned?: Set<string>;
  /** The directory of thread-settings.sqlite3, the data directory unless given. */
  readonly policyDirectory?: string;
  /** The seed of a new policy file. */
  readonly excludedThreadIds?: readonly string[];
  /** The identity source; NodeCrypto's v4 uuids unless a test pins them. */
  readonly ids?: Layer.Layer<SupervisorIds>;
};

type Owner = {readonly unit: StoreUnit; readonly service: object; readonly context: Context.Context<never>};
const owners = new WeakMap<object, Owner>();
const scopes = new WeakMap<StoreUnit, Scope.Closeable>();

const promised = <S extends object>(service: S, context: Context.Context<never>): Promised<S> => new Proxy(service, {
  get: (target, key) => {
    const value: unknown = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      const result: unknown = Reflect.apply(value, target, args);
      return Effect.isEffect(result) ? Effect.runPromise(Effect.provide(result as Effect.Effect<unknown, unknown>, context)) : result;
    };
  },
}) as unknown as Promised<S>;

const facadeOf = <S extends object>(unit: StoreUnit, service: S, context: Context.Context<never> = unit.context as Context.Context<never>): Promised<S> => {
  const facade = promised(service, context);
  owners.set(facade, {unit, service, context});
  return facade;
};

const ownerOf = (facade: object): Owner => {
  const owner = owners.get(facade);
  if (!owner) throw new Error("not a store facade of a store unit");
  return owner;
};

/** The store unit a facade belongs to. */
export const storeUnitOf = (facade: object): StoreUnit => ownerOf(facade).unit;
/** The service behind a facade. */
export const serviceOf = <S>(facade: Promised<S>): S => ownerOf(facade as object).service as S;

/** Opens the stores of `directory` in their own scope, as one supervision run's layer graph acquires them. */
export const openStores = async (directory: string, options: StoreUnitOptions = {}): Promise<StoreUnit> => {
  const scope = Effect.runSync(Scope.make());
  const owned = options.owned ?? new Set<string>();
  const ids = options.ids ?? SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));
  const guidance = SupervisionStoresLive.pipe(
    Layer.provideMerge(GuidanceStore.layer),
    Layer.provideMerge(guidanceDbLayer(directory)),
    Layer.provideMerge(Layer.mergeAll(ids, Layer.succeed(SupervisorOwnership, owned))),
  );
  const policy = Layer.effect(ThreadPolicyStore, makeThreadPolicyStore({excludedThreadIds: [...(options.excludedThreadIds ?? [])]})).pipe(
    Layer.provideMerge(policyDbLayer(options.policyDirectory ?? directory)));
  const exit = await Effect.runPromiseExit(Layer.buildWithScope(Layer.mergeAll(guidance, policy).pipe(Layer.provide(NodeFileSystem.layer)), scope));
  if (Exit.isFailure(exit)) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    return Effect.runPromise(Effect.failCause(exit.cause));
  }
  const context = exit.value as Context.Context<StoreServices>;
  let closed: Promise<void> | null = null;
  const unit: StoreUnit = {
    directory, context, owned, sql: Context.get(context, GuidanceDb),
    run: (effect) => Effect.runPromise(Effect.provide(effect, context)),
    close: () => closed ??= Effect.runPromise(Scope.close(scope, Exit.void)),
  } as StoreUnit;
  scopes.set(unit, scope);
  return Object.assign(unit, {
    guidance: facadeOf(unit, Context.get(context, GuidanceStore)),
    supervisors: facadeOf(unit, Context.get(context, ProjectSupervisorStore)),
    requests: facadeOf(unit, Context.get(context, SupervisorConversationStore)),
    monitor: facadeOf(unit, Context.get(context, ProjectSupervisorMonitorStore)),
    team: facadeOf(unit, Context.get(context, SupervisorTeamStore)),
    policy: facadeOf(unit, Context.get(context, ThreadPolicyStore)),
  });
};

/** The baseline workflow-editing predicate: a plain answer, a promised one or the effectful predicate itself. */
export type WorkflowEditingAnswer = (projectId: string, mainThreadId?: string) => boolean | Promise<boolean> | Effect.Effect<boolean, SupervisionStoreError>;

const answerOf = (answer: ReturnType<WorkflowEditingAnswer>): Effect.Effect<boolean, SupervisionStoreError> =>
  Effect.isEffect(answer) ? answer : typeof answer === "boolean" ? Effect.succeed(answer) : Effect.promise(() => answer);

/**
 * The workflow state store over a unit's binding store with `isEnabled` as its workflow-editing predicate, read when the
 * store asks; it is acquired in the unit's scope after the unit's other stores and closed with them.
 */
export const openWorkflows = async (stores: StoreUnit | Promised<ProjectSupervisorStore["Service"]>, isEnabled: WorkflowEditingAnswer = () => true):
  Promise<Promised<WorkflowStateStore["Service"]>> => {
  const unit = "context" in stores && "close" in stores ? stores as StoreUnit : storeUnitOf(stores);
  const layer = WorkflowStateStore.layerWith((projectId, mainThreadId) => Effect.suspend(() => answerOf(isEnabled(projectId, mainThreadId))));
  const built = await unit.run(Layer.buildWithScope(layer, scopes.get(unit)!));
  const service = Context.get(built, WorkflowStateStore);
  return facadeOf(unit, service, Context.add(unit.context, WorkflowStateStore, service) as Context.Context<never>);
};

/** The unit's services, with the workflow state store of `workflows` when given. */
export const storeContext = (stores: StoreUnit | object, workflows?: Promised<WorkflowStateStore["Service"]> | null):
  Context.Context<StoreServices | WorkflowStateStore> => {
  const unit = "context" in stores && "close" in stores ? stores as StoreUnit : storeUnitOf(stores);
  return workflows ? Context.add(unit.context, WorkflowStateStore, serviceOf(workflows)) : unit.context as Context.Context<StoreServices | WorkflowStateStore>;
};
