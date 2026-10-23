import { Context, Effect, Exit, Layer, Scope } from "effect";
import { GuidanceDb, type PolicyDb } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { SupervisionStoresLive } from "../../src/supervision-live.js";
import { SupervisorConversation } from "../../src/supervisor-conversation.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { SupervisorLifecycle } from "../../src/supervisor-lifecycle.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { NativeOperateRpc, type NativeRpcShape, type SupervisorRpcError } from "../../src/supervisor-native.js";
import { SupervisorStateReset } from "../../src/supervisor-state-reset.js";
import { T3Client, type T3ClientShape, type T3TransportError } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { Projection } from "../../src/types.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";
import { admissionLayer, guidanceClient, policyClient, runConfig, supervisorIds } from "./g12-stores.js";

// one process of the scope-lifecycle suites: the production lifecycle beside the production conversation, admission gate,
// scope predicates, thread policy and supervision stores of a temporary data directory, each built from its production layer
// (src/supervision-live.ts order); the native side is two small effect fakes, the T3 projection reads and the operate rpc

/** The wall clock a suite's test clock starts at: a fixed instant after the times its fixtures record, as the real clock was. */
export const wallClock = Date.parse("2026-10-23T10:00:00.000Z");

/** A T3 projection read of the fake; a failed read is the transport error the client reports. */
export type ProjectionRead = (threadId: string) => Effect.Effect<Projection, T3TransportError>;

/**
 * One operate call of the fake: the function runs when the request is committed (it records the call and changes the native
 * state as T3 would on accepting it) and returns the reply the call's result awaits.
 */
export type OperateCall = (tag: string, payload: Record<string, unknown>) => Effect.Effect<unknown, SupervisorRpcError>;

export interface LifecycleNatives {
  readonly read: ProjectionRead;
  readonly rpc: OperateCall;
}

/** The T3 client over the fake: projections come from `read`, unchanged and by reference; nothing else is used. */
export const t3Projections = (read: ProjectionRead): T3ClientShape => ({
  descriptor: () => Effect.die(new Error("unused T3 descriptor")),
  watch: () => Effect.die(new Error("unused T3 watch")),
  projection: (threadId) => Effect.map(Effect.suspend(() => read(threadId)), (projection) => ({ snapshotSequence: 0, projection })),
});

/** The operate client over the fake: a call is the fake's reply; an initiation calls the fake as the request is committed. */
export const operateRpc = (call: OperateCall): NativeRpcShape => ({
  call: (tag, payload) => Effect.suspend(() => call(tag, { ...payload })),
  initiate: (tag, payload) => Effect.sync(() => ({ sent: Effect.succeed(true), result: call(tag, { ...payload }), release: Effect.void })),
});

// the stores in the production order over the run's clients, the workflow state store whose owner check admits every scope (as
// the baseline suites constructed it), the scope predicates over the thread policy with their admission gate, then the
// conversation and the lifecycle with the operate credential and no helper team
const processLayer = (directory: string, natives: LifecycleNatives) => SupervisorLifecycle.layer.pipe(
  Layer.provideMerge(SupervisorConversation.layer),
  Layer.provideMerge(admissionLayer(true)),
  Layer.provideMerge(WorkflowStateStore.layerWith(() => Effect.succeed(true))),
  Layer.provideMerge(SupervisionStoresLive),
  Layer.provideMerge(GuidanceStore.layer),
  Layer.provideMerge(Layer.mergeAll(supervisorIds, Layer.sync(SupervisorOwnership, () => new Set<string>()), runConfig(directory),
    Layer.succeed(T3Client, t3Projections(natives.read)), Layer.succeed(NativeOperateRpc, operateRpc(natives.rpc)))),
);

const services = (directory: string, natives: LifecycleNatives, clients: Context.Context<GuidanceDb | PolicyDb>) =>
  processLayer(directory, natives).pipe(Layer.provideMerge(Layer.succeedContext(clients)));

type ProcessServices = Layer.Success<ReturnType<typeof services>>;

export interface LifecycleProcess {
  readonly sql: GuidanceDb["Service"];
  readonly ids: SupervisorIds["Service"];
  readonly store: ProjectSupervisorStore["Service"];
  readonly requests: SupervisorConversationStore["Service"];
  readonly monitor: ProjectSupervisorMonitorStore["Service"];
  readonly workflows: WorkflowStateStore["Service"];
  readonly policy: ThreadPolicyStore["Service"];
  readonly conversation: SupervisorConversation["Service"];
  readonly lifecycle: SupervisorLifecycle["Service"];
  readonly context: Context.Context<ProcessServices>;
  // closes the process's database clients under its services, as a crash ends the process's connections; the services close
  // with the test scope
  readonly crash: Effect.Effect<void>;
}

/** Opens one process on the files of `directory`, closed with the current scope (its services before its clients). */
export const openLifecycleProcess = (directory: string, natives: LifecycleNatives): Effect.Effect<LifecycleProcess, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const clientScope = yield* Scope.fork(scope, "sequential");
    const clients = yield* Layer.buildWithScope(Layer.mergeAll(guidanceClient(directory), policyClient(directory)), clientScope);
    const context = yield* Layer.buildWithScope(services(directory, natives, clients), yield* Scope.fork(scope, "sequential")).pipe(Effect.orDie);
    return {
      context, crash: Scope.close(clientScope, Exit.void),
      sql: Context.get(context, GuidanceDb), ids: Context.get(context, SupervisorIds), store: Context.get(context, ProjectSupervisorStore),
      requests: Context.get(context, SupervisorConversationStore), monitor: Context.get(context, ProjectSupervisorMonitorStore),
      workflows: Context.get(context, WorkflowStateStore), policy: Context.get(context, ThreadPolicyStore),
      conversation: Context.get(context, SupervisorConversation), lifecycle: Context.get(context, SupervisorLifecycle),
    };
  });

/**
 * Another lifecycle of the process over its conversation, gate and stores, with its own native reads and operate client and,
 * as the baseline constructor without a workflow store argument, no workflow state store.
 */
export const lifecycleOver = (process: LifecycleProcess, natives: LifecycleNatives): Effect.Effect<SupervisorLifecycle["Service"], never, Scope.Scope> =>
  Effect.map(Layer.build(SupervisorLifecycle.layer.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeedContext(Context.omit(WorkflowStateStore, T3Client, NativeOperateRpc, SupervisorLifecycle)(process.context)),
    Layer.succeed(T3Client, t3Projections(natives.read)), Layer.succeed(NativeOperateRpc, operateRpc(natives.rpc)))))),
  (context) => Context.get(context, SupervisorLifecycle));

/**
 * The project supervision store's layer built again on the process's client with a fresh ownership set, as a second
 * constructor on the same database ran the schema, the one-time reset, the Start recovery and the ownership preload.
 */
export const constructSupervisorStore = (process: LifecycleProcess) =>
  Effect.map(Layer.build(ProjectSupervisorStore.layer.pipe(
    Layer.provide(SupervisorStateReset.layer),
    Layer.provide(Layer.mergeAll(Layer.succeedContext(Context.pick(GuidanceDb, GuidanceStore, SupervisorIds)(process.context)),
      Layer.sync(SupervisorOwnership, () => new Set<string>()))),
  )), (context) => Context.get(context, ProjectSupervisorStore));

/** Another process's guidance client and store on the files of `directory`, closed with the current scope. */
export const openGuidanceClient = (directory: string): Effect.Effect<GuidanceDb["Service"], never, Scope.Scope> =>
  Effect.map(Layer.build(GuidanceStore.layer.pipe(Layer.provideMerge(guidanceClient(directory)), Layer.provide(supervisorIds))).pipe(Effect.orDie),
    (context) => Context.get(context, GuidanceDb));

/** Stops supervision of a chat through the instance thread policy, as the dashboard control and supervision_stop do. */
export const stopChat = (process: LifecycleProcess, threadId: string): Effect.Effect<void> => Effect.gen(function* () {
  const policy = yield* process.policy.get();
  yield* process.policy.save({ ...policy, excludedThreadIds: [...policy.excludedThreadIds, threadId] });
}).pipe(Effect.orDie);

/** Replaces one method of a service object, which its callers read when they call it, until the current scope closes. */
export const replaceMethod = <S extends object, K extends keyof S>(service: S, key: K, replacement: S[K]): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(() => {
    const original = service[key];
    (service as Record<K, S[K]>)[key] = replacement;
    return original;
  }), (original) => Effect.sync(() => {(service as Record<K, S[K]>)[key] = original;})).pipe(Effect.asVoid);
