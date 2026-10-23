import { NodeCrypto } from "@effect/platform-node";
import { Clock, Context, Deferred, Effect, Layer, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { helperTransportFacade, supervisorConversationFacade, supervisorLifecycleFacade, supervisorTeamServices, teamRuntimeFacade, type RootRun } from "../../src/guidance-application.js";
import { SupervisorIds } from "../../src/ids.js";
import { ProjectDefinitions, type ProjectDefinitionLoader } from "../../src/project-definitions.js";
import type { BindingRecord, ProjectSupervisorStore, SupervisorBaseline, TaskRecord } from "../../src/project-supervisor-store.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ProjectSupervisor } from "../../src/project-supervisor.js";
import type { StoreShape } from "../../src/store.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService, type GateGuard, type SupervisionGateShape } from "../../src/supervision-gate.js";
import { SupervisionStores } from "../../src/supervision-stores.js";
import { SupervisorConversation, type SupervisorConversationFacade } from "../../src/supervisor-conversation.js";
import { SupervisorConversationStore, type WorkflowIntroduction } from "../../src/supervisor-conversation-store.js";
import { HelperTransport, type HelperTransportShape, type SupervisorHelperDeliveryTransport } from "../../src/supervisor-helper-transport.js";
import { SupervisorLifecycle, type SupervisorLifecycleFacade } from "../../src/supervisor-lifecycle.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { NativeOperateRpc, SupervisorRpcError, type NativeRpcShape, type SupervisorRpc } from "../../src/supervisor-native.js";
import { SupervisorTeamRuntime, type SupervisorTeamRuntimeFacade } from "../../src/supervisor-team-runtime.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { T3Client, T3TransportError, type T3ClientShape } from "../../src/t3.js";
import type { Projection, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import type { WorkflowStateStore } from "../../src/workflow-state-store.js";

// the baseline constructors of the helper transport, the team runtime and their two owners, rebuilt over the ported
// services and the production b-03 facades (src/guidance-application.ts); each unit keeps its constructor options

type Unit = { readonly service: HelperTransportShape; readonly gate: SupervisionGateShape; readonly guard: GateGuard };
const transports = new WeakMap<object, Unit>();

// the units live for the test process, as the baseline objects did; nothing is in flight once a test awaited its calls
const build = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A => Effect.runSync(Scope.provide(Effect.runSync(Scope.make()))(effect));
const ids = SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));
const run: RootRun = (effect, options) => Effect.runPromise(effect, options);

// a promise rpc as the operate client; a completed cancel ends a call as the aborted call it replaces. An initiation invokes
// the rpc synchronously, as the request frame is committed, and its release aborts that call
export const operateClient = (rpc: SupervisorRpc): NativeRpcShape => ({
  call: (tag, payload, cancel) => {
    const call = Effect.tryPromise({
      try: (signal) => rpc(tag, { ...payload }, signal),
      catch: (cause) => cause instanceof SupervisorRpcError ? cause : new SupervisorRpcError("uncertain"),
    });
    return cancel === undefined ? call : Effect.raceFirst(call, Effect.andThen(Deferred.await(cancel), Effect.fail(new SupervisorRpcError("uncertain"))));
  },
  initiate: (tag, payload) => Effect.sync(() => {
    const controller = new AbortController();
    let pending: Promise<unknown>;
    try {pending = rpc(tag, { ...payload }, controller.signal);} catch (cause) {pending = Promise.reject(cause);}
    const settled = pending.then((value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, error: cause instanceof SupervisorRpcError ? cause : new SupervisorRpcError("uncertain") }));
    return {
      sent: Effect.succeed(true),
      result: Effect.flatMap(Effect.promise(() => settled), (outcome) => outcome.ok ? Effect.succeed(outcome.value) : Effect.fail(outcome.error)),
      release: Effect.sync(() => controller.abort()),
    };
  }),
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

// the team runtime service over the transport unit's gate (or its own), the fake transport as a service
const teamRuntimeService = (options: TeamRuntimeUnitOptions): SupervisorTeamRuntime["Service"] => {
  const unit = options.helperTransport ? transports.get(options.helperTransport) : undefined;
  const guard = unit?.guard ?? openGuard;
  const gate = unit?.gate ?? Effect.runSync(makeSupervisionGate(guard));
  const transport = unit?.service ?? (options.helperTransport ? promiseTransport(options.helperTransport, guard) : undefined);
  return Effect.runSync(SupervisorTeamRuntime.make({ store: options.store, teamStore: options.teamStore, requests: options.requests,
    monitor: options.monitor, stopped: (_guard, mainThreadId) => options.supervisionStopped?.(mainThreadId) === true }).pipe(
    (effect) => transport ? Effect.provideService(effect, HelperTransport, transport) : effect,
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(T3Client, projectionClient(options.projection)),
    Effect.provide(ids),
  ));
};

// the team runtime with `now` as its clock, in the facade shape
const teamRuntimeFacadeUnit = (options: TeamRuntimeUnitOptions, runtime: SupervisorTeamRuntime["Service"]): SupervisorTeamRuntimeFacade & { options: TeamRuntimeUnitOptions } => {
  const now = options.now;
  const clocked: RootRun = now ? (effect, runOptions) => Effect.runPromise(Effect.provideService(effect, Clock.Clock, clockOf(now)), runOptions) : run;
  return Object.assign(teamRuntimeFacade(clocked, runtime), { options });
};

// the team runtime over the transport unit's gate (or its own), the fake transport as a service, and `now` as its clock
export const teamRuntimeUnit = (options: TeamRuntimeUnitOptions): SupervisorTeamRuntimeFacade & { options: TeamRuntimeUnitOptions } =>
  teamRuntimeFacadeUnit(options, teamRuntimeService(options));

// a definitions loader as the definitions service, read through the loader when called; a loader without a global
// fingerprint reads none. A rejected load is a defect, as the baseline rejection it replaces
type DefinitionsLoader = Pick<ProjectDefinitionLoader, "load"> & Partial<Pick<ProjectDefinitionLoader, "globalFingerprint">>;
export const definitionsService = (loader: DefinitionsLoader): ProjectDefinitions["Service"] => {
  const unused = () => Effect.die(new Error("unused definitions operation"));
  return ProjectDefinitions.of({
    globalHomePath: "~",
    globalDefinitionsPath: "~/.t3-supervisor",
    load: (projectId, threadId = null) => Effect.promise((signal) => loader.load(projectId, threadId, signal)),
    globalFingerprint: () => loader.globalFingerprint ? Effect.promise((signal) => loader.globalFingerprint!(signal)) : Effect.succeed(null),
    presence: unused, presenceGlobal: unused, presenceForCheckout: unused, checkoutTargets: unused, currentWorkspace: unused,
    initialize: unused, initializeGlobal: unused, readProjectConfig: unused,
  });
};

type ConversationCallbacks = {
  projection: (threadId: string, signal: AbortSignal) => Promise<Projection>;
  eligible: (thread: ThreadInfo, threads: readonly ThreadInfo[]) => boolean;
  enabled: (projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile") => boolean;
  supervisionStopped: (mainThreadId: string) => boolean;
};

// the baseline constructor callbacks as the scope predicates, read through the unit when called, so a suite may replace them
class UnitScope extends SupervisionScope {
  constructor(config: SupervisorConfig, store: ProjectSupervisorStore, private readonly unit: ConversationCallbacks) {super(config, store, true);}
  override scopeEnabled(projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile"): boolean {return this.unit.enabled(projectId, mainThreadId, purpose);}
  override supervisionStopped(threadId: string): boolean {return this.unit.supervisionStopped(threadId);}
  override eligible(thread: ThreadInfo, threads: readonly ThreadInfo[]): boolean {return this.unit.eligible(thread, threads);}
}

type ConversationContext = SupervisionStores | SupervisionGate | SupervisorConversation | SupervisorIds;
type Seams = Effect.Success<typeof SupervisorConversation.makeUnit>["seams"];
export type SupervisorConversationUnit = SupervisorConversationFacade & ConversationCallbacks & {
  readonly store: ProjectSupervisorStore;
  readonly definitions: DefinitionsLoader | undefined;
  readonly teamRuntime: (SupervisorTeamRuntimeFacade & { options: TeamRuntimeUnitOptions }) | null;
  // internal steps on their own (the service's test seams), in their baseline shapes
  sendIntroduction(task: TaskRecord, introduction: WorkflowIntroduction, threads: readonly ThreadInfo[], signal: AbortSignal): Promise<void>;
  roleFor(binding: BindingRecord): string;
  cachedProvisionalDefinitions(task: TaskRecord): ProjectDefinitionSnapshot | null;
  dialogueDefinitions(task: TaskRecord, signal: AbortSignal): Promise<ProjectDefinitionSnapshot | null>;
  compactRecordProblem(...args: Parameters<Seams["compactRecordProblem"]>): ReturnType<Seams["compactRecordProblem"]>;
  humanMessageSince(mainThreadId: string, since: number, signal: AbortSignal): Promise<boolean>;
  // the services the conversation was built over, for a lifecycle unit of the same process
  readonly context: Context.Context<ConversationContext>;
  readonly runtime: SupervisorTeamRuntime["Service"] | null;
};

// the baseline SupervisorConversation constructor over the ported service: the callbacks are the scope predicates and the T3
// projection, a team store builds the team runtime, which reads this conversation's stop and scope predicates as the baseline
// runtime did. Descendant contactability comes from the scope configuration
export const supervisorConversationUnit = (...[store, rpc, projection, definitions, eligible, enabled, workflows, descendantContactable, teamStore,
  helperTransport, helperProviderInstanceId]: [
  store: ProjectSupervisorStore, rpc: SupervisorRpc | null, projection: (threadId: string, signal: AbortSignal) => Promise<Projection>,
  definitions: DefinitionsLoader | undefined, eligible: ConversationCallbacks["eligible"],
  enabled?: ConversationCallbacks["enabled"], workflows?: WorkflowStateStore,
  descendantContactable?: (thread: ThreadInfo, threads: readonly ThreadInfo[]) => boolean, teamStore?: SupervisorTeamStore,
  helperTransport?: SupervisorHelperDeliveryTransport, helperProviderInstanceId?: string,
]): SupervisorConversationUnit => {
  if (descendantContactable) throw new Error("a conversation unit derives descendant contactability from its scope");
  const callbacks: ConversationCallbacks = { projection, eligible, enabled: enabled ?? (() => true), supervisionStopped: () => false };
  const unit = callbacks as SupervisorConversationUnit;
  const config: SupervisorConfig = { dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0,
    ...(helperProviderInstanceId ? { helperProviderInstanceId } : {}) };
  const scope = new UnitScope(config, store, unit);
  const gate = Effect.runSync(makeSupervisionGate(scope));
  const stores = SupervisionStores.of({ supervisors: store, requests: new SupervisorConversationStore(store.store), monitor: new ProjectSupervisorMonitorStore(store.store),
    team: teamStore ?? new SupervisorTeamStore(store), workflows: workflows ?? null });
  const teamOptions: TeamRuntimeUnitOptions | null = teamStore ? { store, teamStore, requests: stores.requests, monitor: stores.monitor, rpc, projection: (threadId, signal) => unit.projection(threadId, signal),
    ...(helperTransport ? { helperTransport } : {}),
    supervisionStopped: (mainThreadId): boolean => unit.supervisionStopped(mainThreadId) ||
      !unit.enabled(store.bindings().find((item) => item.mainThreadId === mainThreadId)?.projectId ?? "", mainThreadId) } : null;
  const runtime = teamOptions ? teamRuntimeService(teamOptions) : null;
  const built = build(Effect.gen(function* () {
    const parts = yield* SupervisorConversation.makeUnit;
    const context = Context.make(SupervisorConversation, parts.service).pipe(Context.add(SupervisionStores, stores), Context.add(SupervisionGate, gate),
      Context.add(SupervisorIds, yield* SupervisorIds));
    return { ...parts, context };
  }).pipe(
    Effect.provideService(SupervisionStores, stores),
    Effect.provideService(SupervisionScopeService, scope),
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(T3Client, projectionClient((threadId, signal) => unit.projection(threadId, signal))),
    withOperate(rpc),
    (effect) => definitions ? Effect.provideService(effect, ProjectDefinitions, definitionsService(definitions)) : effect,
    (effect) => runtime ? Effect.provideService(effect, SupervisorTeamRuntime, runtime) : effect,
    Effect.provide(ids),
  ));
  const teamRuntime = teamOptions && runtime ? teamRuntimeFacadeUnit(teamOptions, runtime) : null;
  const seams = built.seams;
  return Object.assign(unit, supervisorConversationFacade(run, built.service, stores, teamRuntime), {
    store, definitions, teamRuntime, context: built.context, runtime,
    sendIntroduction: (task: TaskRecord, introduction: WorkflowIntroduction, threads: readonly ThreadInfo[], signal: AbortSignal) =>
      run(seams.sendIntroduction(task, introduction, threads), { signal }),
    roleFor: (binding: BindingRecord) => Effect.runSync(seams.roleFor(binding)),
    cachedProvisionalDefinitions: seams.cachedProvisionalDefinitions,
    dialogueDefinitions: (task: TaskRecord, signal: AbortSignal) => run(seams.dialogueDefinitions(task), { signal }),
    compactRecordProblem: seams.compactRecordProblem,
    humanMessageSince: (mainThreadId: string, since: number, signal: AbortSignal) => run(seams.humanMessageSince(mainThreadId, since), { signal }),
  });
};

// the baseline SupervisorLifecycle constructor over the ported service, beside the conversation unit it observes: its own T3
// projection, operate rpc and workflow state; its requests, monitor, scope and admission gate are the conversation's
export const supervisorLifecycleUnit = (store: ProjectSupervisorStore, conversation: SupervisorConversationUnit,
  projection: (threadId: string, signal: AbortSignal) => Promise<Projection>, rpc: SupervisorRpc | null, workflows?: WorkflowStateStore): SupervisorLifecycleFacade => {
  const stores = Context.get(conversation.context, SupervisionStores);
  const lifecycle = build(SupervisorLifecycle.make.pipe(
    Effect.provideService(SupervisionStores, SupervisionStores.of({ ...stores, supervisors: store, workflows: workflows ?? null })),
    Effect.provideService(T3Client, projectionClient(projection)),
    withOperate(rpc),
    (effect) => conversation.runtime ? Effect.provideService(effect, SupervisorTeamRuntime, conversation.runtime) : effect,
    Effect.provide(conversation.context),
  ));
  return supervisorLifecycleFacade(run, lifecycle);
};

// the baseline ProjectSupervisor constructor: the scope predicates and the team, conversation and lifecycle services are built
// as the root builds them, over the operate rpc, the T3 client (read through `t3` when called), the definitions and global
// fetch, with an admission gate that guards with those scope predicates
export const projectSupervisorUnit = (config: SupervisorConfig, store: ProjectSupervisorStore, source: Pick<StoreShape, "catalog">,
  t3: Pick<T3ClientShape, "projection">, readRpc: SupervisorRpc, operateRpc: SupervisorRpc | null,
  activationSnapshot: (signal: AbortSignal) => Promise<SupervisorBaseline>, definitions?: ConstructorParameters<typeof ProjectSupervisor>[8],
  now?: () => number): ProjectSupervisor => {
  const scope = new SupervisionScope(config, store, Boolean(operateRpc));
  const services = build(supervisorTeamServices(run, store, config.t3Url, scope).pipe(
    withOperate(operateRpc),
    Effect.provideServiceEffect(SupervisionGate, makeSupervisionGate(scope)),
    (effect) => definitions ? Effect.provideService(effect, ProjectDefinitions, definitionsService(definitions)) : effect,
    Effect.provideService(T3Client, { descriptor: () => Effect.die(new Error("unused")), watch: () => Effect.die(new Error("unused")),
      projection: (threadId) => Effect.suspend(() => t3.projection(threadId)) }),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, ids)),
  ));
  return new ProjectSupervisor(config, store, source, t3, readRpc, operateRpc, activationSnapshot, services, definitions, now);
};
