import { NodeCrypto } from "@effect/platform-node";
import { Clock, Deferred, Effect, Layer, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { helperTransportFacade, supervisorTeamServices, teamRuntimeFacade, type RootRun } from "../../src/guidance-application.js";
import { SupervisorIds } from "../../src/ids.js";
import type { ProjectSupervisorStore, SupervisorBaseline } from "../../src/project-supervisor-store.js";
import { ProjectSupervisor } from "../../src/project-supervisor.js";
import type { StoreShape } from "../../src/store.js";
import { makeSupervisionGate, SupervisionGate, type GateGuard, type SupervisionGateShape } from "../../src/supervision-gate.js";
import { SupervisorConversation } from "../../src/supervisor-conversation.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { HelperTransport, type HelperTransportShape, type SupervisorHelperDeliveryTransport } from "../../src/supervisor-helper-transport.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { NativeOperateRpc, SupervisorRpcError, type NativeRpcShape, type SupervisorRpc } from "../../src/supervisor-native.js";
import { SupervisorTeamRuntime, type SupervisorTeamRuntimeFacade } from "../../src/supervisor-team-runtime.js";
import type { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { T3Client, T3TransportError, type T3ClientShape } from "../../src/t3.js";
import type { Projection, SupervisorConfig } from "../../src/types.js";

// the baseline constructors of the helper transport, the team runtime and their two owners, rebuilt over the ported
// services and the production b-03 facades (src/guidance-application.ts); each unit keeps its constructor options

type Unit = { readonly service: HelperTransportShape; readonly gate: SupervisionGateShape; readonly guard: GateGuard };
const transports = new WeakMap<object, Unit>();

// the units live for the test process, as the baseline objects did; nothing is in flight once a test awaited its calls
const build = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A => Effect.runSync(Scope.provide(Effect.runSync(Scope.make()))(effect));
const ids = SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));
const run: RootRun = (effect) => Effect.runPromise(effect);

// a promise rpc as the operate client; a completed cancel ends a call as the aborted call it replaces
export const operateClient = (rpc: SupervisorRpc): NativeRpcShape => ({
  call: (tag, payload, cancel) => {
    const call = Effect.tryPromise({
      try: (signal) => rpc(tag, { ...payload }, signal),
      catch: (cause) => cause instanceof SupervisorRpcError ? cause : new SupervisorRpcError("uncertain"),
    });
    return cancel === undefined ? call : Effect.raceFirst(call, Effect.andThen(Deferred.await(cancel), Effect.fail(new SupervisorRpcError("uncertain"))));
  },
  initiate: () => Effect.die(new Error("the helper transport only calls the operate client")),
});

// a promise projection reader as the T3 client; a T3TransportError keeps its status
export const projectionClient = (projection: (threadId: string, signal: AbortSignal) => Promise<Projection>): T3ClientShape => ({
  descriptor: () => Effect.die(new Error("unused")),
  watch: () => Effect.die(new Error("unused")),
  projection: (threadId) => Effect.tryPromise({
    try: (signal) => projection(threadId, signal),
    catch: (cause) => cause instanceof T3TransportError ? cause : new T3TransportError("T3 thread projection is unavailable"),
  }).pipe(Effect.map((value) => ({ snapshotSequence: 0, projection: value }))),
});

const withOperate = (rpc: SupervisorRpc | null | undefined) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  rpc ? Effect.provideService(effect, NativeOperateRpc, operateClient(rpc)) : effect;

export type HelperTransportUnitOptions = {
  store: ProjectSupervisorStore;
  rpc: SupervisorRpc | null;
  baseUrl: string;
  projection(threadId: string, signal: AbortSignal): Promise<Projection>;
  enabled?: (projectId: string, mainThreadId: string) => boolean;
  fetch?: typeof fetch;
};

// the helper transport over its own admission gate: the project or global scope is `enabled`, else the stored control;
// the webhook POST goes through the fetch HTTP client over `fetch`
export const helperTransportUnit = (options: HelperTransportUnitOptions): SupervisorHelperDeliveryTransport & { options: HelperTransportUnitOptions } => {
  const guard: GateGuard = {
    scopeEnabled: (projectId, mainThreadId) => options.enabled ? options.enabled(projectId, mainThreadId ?? "") : options.store.enabled(projectId),
    supervisionStopped: () => false,
    workflowEditingEnabled: () => true,
  };
  const gate = Effect.runSync(makeSupervisionGate(guard));
  const service = build(HelperTransport.make({ store: options.store, baseUrl: options.baseUrl }).pipe(
    withOperate(options.rpc),
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(T3Client, projectionClient(options.projection)),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, options.fetch ?? globalThis.fetch),
  ));
  const unit = Object.assign(helperTransportFacade(run, service), { options });
  transports.set(unit, { service, gate, guard });
  return unit;
};

// a promise transport (a test fake) as the service; its authority closure is evaluated when the fake calls it
const promiseTransport = (transport: SupervisorHelperDeliveryTransport, guard: GateGuard): HelperTransportShape => ({
  send: (binding, input, options) => Effect.promise((signal) => transport.send(binding, input, signal,
    ...(options?.authorized ? [() => options.authorized!(guard)] : []))),
  hasDelivery: (binding, input) => Effect.sync(() => transport.hasDelivery(binding, input)),
  reconcileDelivery: (binding, input) => Effect.promise((signal) => transport.reconcileDelivery(binding, input, signal)),
  receiptText: (binding, logicalMessageId) => Effect.sync(() => transport.receiptText(binding, logicalMessageId)),
  matchesMessage: (binding, logicalMessageId, text, message, messages) => Effect.sync(() => transport.matchesMessage(binding, logicalMessageId, text, message, messages)),
  receiptDocument: () => Effect.die(new Error("a fake transport keeps no receipt documents")),
  retire: (binding, helperThreadId) => Effect.promise((signal) => transport.retire(binding, helperThreadId, signal)),
});

// a clock that reads `now`, for units whose baseline took a `now` function
const clockOf = (now: () => number): Clock.Clock => {
  const live = Effect.runSync(Clock.clockWith(Effect.succeed));
  return {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  };
};

const openGuard: GateGuard = { scopeEnabled: () => true, supervisionStopped: () => false, workflowEditingEnabled: () => true };

export type TeamRuntimeUnitOptions = {
  store: ProjectSupervisorStore;
  teamStore: SupervisorTeamStore;
  requests: SupervisorConversationStore;
  monitor: ProjectSupervisorMonitorStore;
  rpc?: SupervisorRpc | null;
  helperTransport?: SupervisorHelperDeliveryTransport;
  now?: () => number;
  projection: (threadId: string, signal: AbortSignal) => Promise<Projection>;
  supervisionStopped?: (mainThreadId: string) => boolean;
};

// the team runtime over the transport unit's gate (or its own), the fake transport as a service, and `now` as its clock
export const teamRuntimeUnit = (options: TeamRuntimeUnitOptions): SupervisorTeamRuntimeFacade & { options: TeamRuntimeUnitOptions } => {
  const unit = options.helperTransport ? transports.get(options.helperTransport) : undefined;
  const guard = unit?.guard ?? openGuard;
  const gate = unit?.gate ?? Effect.runSync(makeSupervisionGate(guard));
  const transport = unit?.service ?? (options.helperTransport ? promiseTransport(options.helperTransport, guard) : undefined);
  const runtime = Effect.runSync(SupervisorTeamRuntime.make({ store: options.store, teamStore: options.teamStore, requests: options.requests,
    monitor: options.monitor, stopped: (_guard, mainThreadId) => options.supervisionStopped?.(mainThreadId) === true }).pipe(
    (effect) => transport ? Effect.provideService(effect, HelperTransport, transport) : effect,
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(T3Client, projectionClient(options.projection)),
    Effect.provide(ids),
  ));
  const now = options.now;
  const clocked: RootRun = now ? (effect) => Effect.runPromise(Effect.provideService(effect, Clock.Clock, clockOf(now))) : run;
  return Object.assign(teamRuntimeFacade(clocked, runtime), { options });
};

// the baseline SupervisorConversation constructor: a team store builds the team runtime, which reads this conversation's
// stop and scope predicates as the baseline runtime did
export const supervisorConversationUnit = (...[store, rpc, projection, definitions, eligible, enabled, workflows, descendantContactable, teamStore,
  helperTransport, helperProviderInstanceId]: [
  store: ProjectSupervisorStore, rpc: SupervisorRpc | null, projection: (threadId: string, signal: AbortSignal) => Promise<Projection>,
  definitions: ConstructorParameters<typeof SupervisorConversation>[3], eligible: ConstructorParameters<typeof SupervisorConversation>[4],
  enabled?: ConstructorParameters<typeof SupervisorConversation>[5], workflows?: ConstructorParameters<typeof SupervisorConversation>[6],
  descendantContactable?: ConstructorParameters<typeof SupervisorConversation>[7], teamStore?: SupervisorTeamStore,
  helperTransport?: SupervisorHelperDeliveryTransport, helperProviderInstanceId?: string,
]): SupervisorConversation => {
  const teamRuntime = teamStore ? teamRuntimeUnit({ store, teamStore, requests: new SupervisorConversationStore(store.store),
    monitor: new ProjectSupervisorMonitorStore(store.store), rpc, projection, ...(helperTransport ? { helperTransport } : {}),
    supervisionStopped: (mainThreadId): boolean => conversation.supervisionStopped(mainThreadId) ||
      !conversation.enabled(store.bindings().find((item) => item.mainThreadId === mainThreadId)?.projectId ?? "", mainThreadId) }) : null;
  const conversation: SupervisorConversation = new SupervisorConversation(store, rpc, projection, definitions, eligible, enabled, workflows, descendantContactable, teamRuntime,
    helperProviderInstanceId);
  return conversation;
};

// the baseline ProjectSupervisor constructor: the team services are built as the root builds them, over the operate
// rpc, the T3 client and global fetch, with an admission gate that guards with the supervisor's own scope predicates
export const projectSupervisorUnit = (config: SupervisorConfig, store: ProjectSupervisorStore, source: Pick<StoreShape, "catalog">,
  t3: Pick<T3ClientShape, "projection">, readRpc: SupervisorRpc, operateRpc: SupervisorRpc | null,
  activationSnapshot: (signal: AbortSignal) => Promise<SupervisorBaseline>, definitions?: ConstructorParameters<typeof ProjectSupervisor>[8],
  now?: () => number): ProjectSupervisor => {
  const guard: GateGuard = {
    scopeEnabled: (projectId, mainThreadId, purpose) => supervisor.gate.scopeEnabled(projectId, mainThreadId, purpose),
    supervisionStopped: (threadId) => supervisor.gate.supervisionStopped(threadId),
    workflowEditingEnabled: (projectId, mainThreadId, purpose) => supervisor.gate.workflowEditingEnabled(projectId, mainThreadId, purpose),
  };
  const services = build(supervisorTeamServices(run, store, config.t3Url).pipe(
    withOperate(operateRpc),
    Effect.provideServiceEffect(SupervisionGate, makeSupervisionGate(guard)),
    Effect.provideService(T3Client, { descriptor: () => Effect.die(new Error("unused")), watch: () => Effect.die(new Error("unused")), ...t3 }),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, ids)),
  ));
  const supervisor: ProjectSupervisor = new ProjectSupervisor(config, store, source, t3, readRpc, operateRpc, activationSnapshot, services, definitions, now);
  return supervisor;
};
