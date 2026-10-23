import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { GuidanceDb, guidanceDbLayer } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService, type GateGuard, type SupervisionGateShape } from "../../src/supervision-gate.js";
import { SupervisorConversation, type SupervisorConversationShape } from "../../src/supervisor-conversation.js";
import { SupervisorConversationStore, type SupervisorConversationStoreShape } from "../../src/supervisor-conversation-store.js";
import { HelperTransport, type HelperTransportShape } from "../../src/supervisor-helper-transport.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { NativeOperateRpc, SupervisorRpcError, type NativeRpcShape } from "../../src/supervisor-native.js";
import { SupervisorStateReset } from "../../src/supervisor-state-reset.js";
import { SupervisorTeamRuntime, type SupervisorTeamRuntimeShape } from "../../src/supervisor-team-runtime.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { T3Client, type T3ClientShape, type T3TransportError } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { Projection, SupervisorSettings, ThreadInfo } from "../../src/types.js";
import { temporaryDataDirectory } from "./guidance-store-services.js";

// the team runtime, the helper transport and the conversation of the g3 suites, each built from its production layer over the
// supervision stores of a temporary guidance database; the native side is a set of small effect fakes: the T3 projection
// reads, the operate rpc of a fake scheduler and, for the webhook POST, a stubbed fetch under the production fetch client

/** The wall clock a suite's test clock starts at: a fixed instant after the times its fixtures record, as the real clock was. */
export const wallClock = Date.parse("2026-10-23T10:00:00.000Z");

export type TeamStoreServices = GuidanceDb | SupervisorIds | SupervisorOwnership | GuidanceStore | SupervisorStateReset |
  ProjectSupervisorStore | SupervisorConversationStore | ProjectSupervisorMonitorStore | SupervisorTeamStore;

// the guidance client, the ids and the ownership set, then the stores in the production order (src/supervision-live.ts): the
// guidance store, the one-time state reset, the project supervision store, the conversation, monitor and team stores
const teamStoresLayer = (directory: string, ids: Layer.Layer<SupervisorIds>) => {
  const base = Layer.mergeAll(guidanceDbLayer(directory).pipe(Layer.provide(NodeFileSystem.layer)), ids,
    Layer.sync(SupervisorOwnership, () => new Set<string>()));
  return Layer.fresh(SupervisorTeamStore.layer.pipe(
    Layer.provideMerge(ProjectSupervisorMonitorStore.layer),
    Layer.provideMerge(SupervisorConversationStore.layer),
    Layer.provideMerge(ProjectSupervisorStore.layer),
    Layer.provideMerge(SupervisorStateReset.layer),
    Layer.provideMerge(GuidanceStore.layer),
    Layer.provideMerge(base)));
};

export interface TeamStores {
  readonly directory: string;
  readonly sql: GuidanceDb["Service"];
  readonly guidance: GuidanceStore["Service"];
  readonly store: ProjectSupervisorStore["Service"];
  readonly teamStore: SupervisorTeamStore["Service"];
  readonly requests: SupervisorConversationStore["Service"];
  readonly monitor: ProjectSupervisorMonitorStore["Service"];
  readonly context: Context.Context<TeamStoreServices>;
  // closes this client of the file, as a crash or a restart closes the process's client
  readonly close: Effect.Effect<void>;
}

/** Opens the stores of `directory` in their own scope, so a suite can close the file and open it again. */
export const openTeamStores = (directory: string, ids: Layer.Layer<SupervisorIds> = SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer))) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(teamStoresLayer(directory, ids), scope).pipe(Effect.orDie, Effect.onError(() => Scope.close(scope, Exit.void)));
    return {
      directory, context, close: Scope.close(scope, Exit.void),
      sql: Context.get(context, GuidanceDb), guidance: Context.get(context, GuidanceStore), store: Context.get(context, ProjectSupervisorStore),
      teamStore: Context.get(context, SupervisorTeamStore), requests: Context.get(context, SupervisorConversationStore),
      monitor: Context.get(context, ProjectSupervisorMonitorStore),
    } satisfies TeamStores;
  });

/** Runs one statement on the stores' client, as a suite's direct write to the file. */
export const execute = (stores: TeamStores, statement: string, ...params: ReadonlyArray<unknown>): Effect.Effect<void> =>
  stores.sql.unsafe(statement, params).pipe(Effect.asVoid, Effect.orDie);

/** The stores of `directory` again, closed with the test scope unless the test closes them first. */
export const reopenTeamStores = (directory: string) => Effect.acquireRelease(openTeamStores(directory), (stores) => stores.close);

/** The stores of a fresh temporary directory, closed with the test scope before the directory is removed. */
export const teamStoresFixture = (prefix: string) => Effect.gen(function* () {
  const directory = yield* temporaryDataDirectory(prefix);
  return yield* reopenTeamStores(directory);
}).pipe(Effect.provide(NodeFileSystem.layer));

/** A native T3 projection read of the fake; a failed read is the transport error the client reports. */
export type ProjectionRead = (threadId: string) => Effect.Effect<Projection, T3TransportError>;

/** The T3 client of a suite: projections come from `read`, unchanged and by reference; nothing else is used. */
export const t3Projections = (read: ProjectionRead): T3ClientShape => ({
  descriptor: () => Effect.die(new Error("unused T3 descriptor")),
  watch: () => Effect.die(new Error("unused T3 watch")),
  projection: (threadId) => Effect.map(Effect.suspend(() => read(threadId)), (projection) => ({snapshotSequence: 0, projection})),
});

/** One call to the fake native scheduler; the operate client calls it when its effect runs. */
export type RpcHandler = (tag: string, input: Record<string, unknown>) => Effect.Effect<unknown, SupervisorRpcError>;

/** A native call that may have acted: what the operate client reports for an unexpected or failed call. */
export const rpcUncertain = (): SupervisorRpcError => new SupervisorRpcError("uncertain");

/** The operate client over the fake scheduler: a call is the handler's effect; an initiation runs it when the request is committed. */
export const operateRpc = (handle: RpcHandler): NativeRpcShape => ({
  call: (tag, payload) => Effect.suspend(() => handle(tag, {...payload})),
  initiate: (tag, payload) => Effect.map(Effect.exit(Effect.suspend(() => handle(tag, {...payload}))), (exit) => ({
    sent: Effect.succeed(true), result: exit, release: Effect.void,
  })),
});

/** An admission gate and the guard its sections read. */
export interface Admission {
  readonly gate: SupervisionGateShape;
  readonly guard: GateGuard;
}

/** The guard of a unit without a policy: every scope enabled, nothing stopped. */
export const openGuard: GateGuard = {
  scopeEnabled: () => Effect.succeed(true),
  supervisionStopped: () => Effect.succeed(false),
  workflowEditingEnabled: () => Effect.succeed(true),
};

/** A fresh production gate over `guard`, on the stores' guidance client. */
export const admission = (stores: TeamStores, guard: GateGuard): Effect.Effect<Admission> =>
  Effect.map(makeSupervisionGate(guard).pipe(Effect.provide(stores.context)), (gate) => ({gate, guard}));

// a suite may replace a field before it builds the next unit, as the baseline options object allowed
export interface HelperTransportUnitOptions {
  stores: TeamStores;
  rpc: RpcHandler | null;
  baseUrl: string;
  projection: ProjectionRead;
  // the project or global scope, read when a section evaluates it; by default the stored control of the project
  enabled?: ((projectId: string, mainThreadId: string) => boolean) | undefined;
  // the native POST; the production fetch client runs over it
  fetch?: typeof globalThis.fetch | undefined;
}

/** The production helper transport over its own admission gate, with the unit's options for a later restart. */
export type HelperTransportUnit = HelperTransportShape & Admission & {
  readonly transport: HelperTransportShape;
  readonly options: HelperTransportUnitOptions;
};

/** Builds the transport's layer in the current scope (a restart builds another over the same file). */
export const helperTransportUnit = (options: HelperTransportUnitOptions): Effect.Effect<HelperTransportUnit, never, Scope.Scope> => Effect.gen(function* () {
  const store = options.stores.store;
  const enabled = options.enabled;
  const parts = yield* admission(options.stores, {
    scopeEnabled: (projectId, mainThreadId) => enabled ? Effect.sync(() => enabled(projectId, mainThreadId ?? "")) : store.enabled(projectId),
    supervisionStopped: () => Effect.succeed(false),
    workflowEditingEnabled: () => Effect.succeed(true),
  });
  const http = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options.fetch ?? globalThis.fetch)));
  const native = options.rpc ? Layer.succeed(NativeOperateRpc, operateRpc(options.rpc)) : Layer.empty;
  const context = yield* Layer.build(HelperTransport.layer({baseUrl: options.baseUrl}).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeedContext(options.stores.context), Layer.succeed(SupervisionGate, parts.gate), Layer.succeed(T3Client, t3Projections(options.projection)),
    http, native)))).pipe(Effect.orDie);
  const transport = Context.get(context, HelperTransport);
  return {...transport, ...parts, transport, options};
});

/** Builds the team store's layer again on the same client: its acquisition runs the restart recovery, as a new process's constructor did. */
export const recoverTeamStore = (stores: TeamStores): Effect.Effect<SupervisorTeamStore["Service"], never, Scope.Scope> =>
  Effect.map(Layer.build(SupervisorTeamStore.layer.pipe(Layer.provide(Layer.succeedContext(stores.context)))).pipe(Effect.orDie),
    (context) => Context.get(context, SupervisorTeamStore));

export interface TeamRuntimeUnitOptions {
  readonly stores: TeamStores;
  // a built transport unit (its gate is the runtime's) or a fake transport over a gate of its own
  readonly transport?: HelperTransportUnit | HelperTransportShape | undefined;
  readonly projection: ProjectionRead;
  // the per-chat stop of the owning main, read right before every fresh helper delivery; never stopped by default
  readonly supervisionStopped?: ((mainThreadId: string) => boolean) | undefined;
  // the conversation store the runtime writes through, for a suite that injects a fault into it
  readonly requests?: SupervisorConversationStoreShape | undefined;
}

const isUnit = (transport: HelperTransportUnit | HelperTransportShape): transport is HelperTransportUnit => "gate" in transport;

/** The production team runtime of one process: its layer built in the current scope over the stores and the transport. */
export const teamRuntimeUnit = (options: TeamRuntimeUnitOptions): Effect.Effect<SupervisorTeamRuntimeShape, never, Scope.Scope> => Effect.gen(function* () {
  const unit = options.transport && isUnit(options.transport) ? options.transport : undefined;
  const transport = unit ? unit.transport : options.transport as HelperTransportShape | undefined;
  const parts = unit ?? (yield* admission(options.stores, openGuard));
  const stopped = options.supervisionStopped;
  const context = yield* Layer.build(SupervisorTeamRuntime.layer({stopped: (_guard, mainThreadId) => Effect.sync(() => stopped?.(mainThreadId) === true)}).pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeedContext(options.stores.context), Layer.succeed(SupervisionGate, parts.gate), Layer.succeed(T3Client, t3Projections(options.projection)),
      transport ? Layer.succeed(HelperTransport, transport) : Layer.empty,
      options.requests ? Layer.succeed(SupervisorConversationStore, options.requests) : Layer.empty))));
  return Context.get(context, SupervisorTeamRuntime);
});

/** The conversation callbacks of the baseline constructor, read through this object when called, so a suite may replace them. */
export interface ConversationCallbacks {
  eligible: (thread: ThreadInfo, threads: readonly ThreadInfo[]) => boolean;
  enabled: (projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile") => boolean;
  supervisionStopped: (mainThreadId: string) => boolean;
}

// the callbacks as the scope predicates of the conversation and of its admission gate
class CallbackScope extends SupervisionScope {
  constructor(config: SupervisorSettings, stores: ConstructorParameters<typeof SupervisionScope>[1], private readonly callbacks: ConversationCallbacks) {super(config, stores, true);}
  override scopeEnabled(projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile") {return Effect.sync(() => this.callbacks.enabled(projectId, mainThreadId, purpose));}
  override supervisionStopped(threadId: string) {return Effect.sync(() => this.callbacks.supervisionStopped(threadId));}
  override eligible(thread: ThreadInfo, threads: readonly ThreadInfo[]) {return Effect.sync(() => this.callbacks.eligible(thread, threads));}
}

// the callback scope reads no thread policy
const unusedPolicy = ThreadPolicyStore.of({get: () => Effect.die(new Error("unused thread policy")), save: () => Effect.die(new Error("unused thread policy"))});

export interface SupervisorConversationUnitOptions {
  readonly stores: TeamStores;
  readonly rpc: RpcHandler | null;
  readonly projection: ProjectionRead;
  readonly eligible: ConversationCallbacks["eligible"];
  readonly enabled?: ConversationCallbacks["enabled"] | undefined;
  readonly helperTransport?: HelperTransportShape | undefined;
}

/**
 * The production conversation over the callback scope and its gate, with its team runtime: the runtime is built over its own
 * open gate and the fake transport, and reads the conversation's stop and scope callbacks as its per-chat stop.
 */
export const supervisorConversationUnit = (options: SupervisorConversationUnitOptions) => Effect.gen(function* () {
  const {stores} = options;
  const callbacks: ConversationCallbacks = {eligible: options.eligible, enabled: options.enabled ?? (() => true), supervisionStopped: () => false};
  const config: SupervisorSettings = {dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0};
  const scope = new CallbackScope(config, {guidance: stores.guidance, supervisors: stores.store, policy: unusedPolicy}, callbacks);
  const gate = yield* makeSupervisionGate(scope).pipe(Effect.provide(stores.context));
  const projectOf = (mainThreadId: string) => Effect.map(stores.store.bindings(), (bindings) => bindings.find((item) => item.mainThreadId === mainThreadId)?.projectId ?? "");
  const runtimeParts = yield* admission(stores, openGuard);
  const team = yield* Layer.build(SupervisorTeamRuntime.layer({stopped: (_guard, mainThreadId) => Effect.gen(function* () {
    return callbacks.supervisionStopped(mainThreadId) || !callbacks.enabled(yield* projectOf(mainThreadId), mainThreadId);
  })}).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeedContext(stores.context), Layer.succeed(SupervisionGate, runtimeParts.gate), Layer.succeed(T3Client, t3Projections(options.projection)),
    options.helperTransport ? Layer.succeed(HelperTransport, options.helperTransport) : Layer.empty))));
  const teamRuntime = Context.get(team, SupervisorTeamRuntime);
  const built = yield* Layer.build(SupervisorConversation.layer.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeedContext(stores.context), Layer.succeed(SupervisionScopeService, scope), Layer.succeed(SupervisionGate, gate),
    Layer.succeed(T3Client, t3Projections(options.projection)), Layer.succeed(SupervisorTeamRuntime, teamRuntime),
    options.rpc ? Layer.succeed(NativeOperateRpc, operateRpc(options.rpc)) : Layer.empty))));
  const conversation: SupervisorConversationShape = Context.get(built, SupervisorConversation);
  return {...conversation, conversation, teamRuntime, callbacks, requests: stores.requests, monitor: stores.monitor};
});
