import { NodeCrypto } from "@effect/platform-node";
import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  definitionsService, helperTransportFacade, supervisorConversationFacade, supervisorLifecycleFacade, supervisorTeamServices, teamRuntimeFacade,
  type DefinitionsLoader, type ProjectDefinitionLoader, type RootRun, type SupervisorConversationFacade, type SupervisorHelperDeliveryTransport,
  type SupervisorLifecycleFacade, type SupervisorTeamRuntimeFacade,
} from "./root-facades.js";
import { SupervisorIds } from "../../src/ids.js";
import { DefinitionSourceFailure, ProjectDefinitions, type ProjectDefinitionSetupInput } from "../../src/project-definitions.js";
import { ProjectSupervisorStore, type BindingRecord, type SupervisionFolderPresence, type SupervisorBaseline, type TaskRecord } from "../../src/project-supervisor-store.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import type { ProjectSupervisorChatSupervisionInput, ProjectSupervisorInfo, ProjectSupervisorTeamInfo, ProjectSupervisorRetryInput, ProjectSupervisorSaveInput, ProjectSupervisorSaveOutcome } from "../../src/project-supervisor-contract.js";
import { ProjectSupervisor, type ProjectSupervisorScopeSnapshotOptions, type ProjectSupervisorSeams, type SupervisorDefinitionsAccess } from "../../src/project-supervisor.js";
import { ScopeLocks, type ScopeLocksShape } from "../../src/scope-locks.js";
import { Store, type StoreShape } from "../../src/store.js";
import { SupervisionControl } from "../../src/supervision-control.js";
import { SupervisorTeamController } from "../../src/supervisor-team-controller.js";
import type { WorkflowWriteController } from "../../src/workflow-write-controller.js";
import type { GlobalDefinitionsControlInput, NoProjectControlInput, SupervisionControlInput, SupervisionSetupInput } from "../../src/supervisor-control-contract.js";
import type { ThreadPolicySettings } from "../../src/thread-policy-contract.js";
import type { SupervisionStartInput, SupervisionStartResult, SupervisionStopInput, SupervisionStopResult } from "../../src/workflow-write-controller.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService, type GateGuard, type SupervisionGateShape, type SupervisionScopeStores } from "../../src/supervision-gate.js";
import { SupervisorConversation } from "../../src/supervisor-conversation.js";
import { SupervisorConversationStore, type WorkflowIntroduction } from "../../src/supervisor-conversation-store.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import type { SupervisionStoreError } from "../../src/guidance-sql.js";
import { ThreadPolicyStore, type ThreadPolicyStoreError } from "../../src/thread-policy.js";
import { serviceOf, storeContext, storeFacade, storeUnitOf, type Promised, type StorePromise, type StoreServices } from "./store-units.js";
import { HelperTransport, type HelperTransportShape } from "../../src/supervisor-helper-transport.js";
import { SupervisorLifecycle } from "../../src/supervisor-lifecycle.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { NativeOperateRpc, NativeRpc, NativeShell, SupervisorRpcError, type NativeRpcShape, type SupervisorRpc } from "../../src/supervisor-native.js";
import { SupervisorTeamRuntime } from "../../src/supervisor-team-runtime.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { readTeamViewData, supervisorTeamView as presentTeamView } from "../../src/supervisor-team-view.js";
import { T3Client, T3TransportError, type T3ClientShape } from "../../src/t3.js";
import type { Projection, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";

// the baseline constructors of the helper transport, the team runtime and their two owners, rebuilt over the ported
// services and the baseline promise facades (./root-facades.ts); each unit keeps its constructor options

export { definitionsService };

type Unit = { readonly service: HelperTransportShape; readonly gate: SupervisionGateShape; readonly guard: GateGuard };
const transports = new WeakMap<object, Unit>();

// the units live for the test process, as the baseline objects did; nothing is in flight once a test awaited its calls
const build = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A => Effect.runSync(Scope.provide(Effect.runSync(Scope.make()))(effect));
const buildUnit = build;
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

/** A baseline predicate's answer: plain, promised, or the effectful read itself (a store read inside the guard's transaction). */
export type Answer<E = SupervisionStoreError> = boolean | Promise<boolean> | Effect.Effect<boolean, E>;
const answer = <E>(value: Answer<E>): Effect.Effect<boolean, E> =>
  Effect.isEffect(value) ? value : typeof value === "boolean" ? Effect.succeed(value) : Effect.promise(() => value);
// a baseline predicate as an effect, called when the effect runs
export const predicate = <E>(read: () => Answer<E>): Effect.Effect<boolean, E> => Effect.suspend(() => answer(read()));

// the scope predicates' stores of a unit's binding store
export const scopeStores = (store: Promised<ProjectSupervisorStore["Service"]>, policy?: ThreadPolicyStore["Service"]): SupervisionScopeStores => {
  const unit = storeUnitOf(store);
  return {guidance: Context.get(unit.context, GuidanceStore), supervisors: serviceOf(store), policy: policy ?? Context.get(unit.context, ThreadPolicyStore)};
};

export type HelperTransportUnitOptions = {
  store: Promised<ProjectSupervisorStore["Service"]>;
  rpc: SupervisorRpc | null;
  baseUrl: string;
  projection(threadId: string, signal: AbortSignal): Promise<Projection>;
  enabled?: (projectId: string, mainThreadId: string) => Answer;
  fetch?: typeof fetch;
};

// the helper transport over its own admission gate: the project or global scope is `enabled`, else the stored control;
// the webhook POST goes through the fetch HTTP client over `fetch`
export const helperTransportUnit = (options: HelperTransportUnitOptions): SupervisorHelperDeliveryTransport & { options: HelperTransportUnitOptions } => {
  const stores = storeUnitOf(options.store);
  const supervisors = serviceOf(options.store);
  const guard: GateGuard = {
    scopeEnabled: (projectId, mainThreadId) => options.enabled ? predicate(() => options.enabled!(projectId, mainThreadId ?? "")) : supervisors.enabled(projectId),
    supervisionStopped: () => Effect.succeed(false),
    workflowEditingEnabled: () => Effect.succeed(true),
  };
  const gate = Effect.runSync(makeSupervisionGate(guard).pipe(Effect.provide(stores.context)));
  const service = build(HelperTransport.make({ baseUrl: options.baseUrl }).pipe(
    withOperate(options.rpc),
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(T3Client, projectionClient(options.projection)),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, options.fetch ?? globalThis.fetch),
    Effect.provide(stores.context),
  ));
  const unit = Object.assign(helperTransportFacade(run, service), { options });
  transports.set(unit, { service, gate, guard });
  return unit;
};

// a promise transport (a test fake) as the service; its authority closure is evaluated when the fake calls it
const promiseTransport = (transport: SupervisorHelperDeliveryTransport, guard: GateGuard): HelperTransportShape => ({
  send: (binding, input, options) => Effect.promise((signal) => transport.send(binding, input, signal,
    ...(options?.authorized ? [() => Effect.runSync(options.authorized!(guard))] : []))),
  hasDelivery: (binding, input) => Effect.promise(async () => transport.hasDelivery(binding, input)),
  reconcileDelivery: (binding, input) => Effect.promise((signal) => transport.reconcileDelivery(binding, input, signal)),
  receiptText: (binding, logicalMessageId) => Effect.promise(async () => transport.receiptText(binding, logicalMessageId)),
  matchesMessage: (binding, logicalMessageId, text, message, messages) => Effect.promise(async () => transport.matchesMessage(binding, logicalMessageId, text, message, messages)),
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

const openGuard: GateGuard = { scopeEnabled: () => Effect.succeed(true), supervisionStopped: () => Effect.succeed(false), workflowEditingEnabled: () => Effect.succeed(true) };

export type TeamRuntimeUnitOptions = {
  store: Promised<ProjectSupervisorStore["Service"]>;
  teamStore: Promised<SupervisorTeamStore["Service"]>;
  requests: Promised<SupervisorConversationStore["Service"]>;
  monitor: Promised<ProjectSupervisorMonitorStore["Service"]>;
  rpc?: SupervisorRpc | null;
  helperTransport?: SupervisorHelperDeliveryTransport;
  now?: () => number;
  projection: (threadId: string, signal: AbortSignal) => Promise<Projection>;
  supervisionStopped?: (mainThreadId: string) => Answer;
};

// the unit's services with the given binding, team, request and monitor stores
const runtimeContext = (options: Pick<TeamRuntimeUnitOptions, "store" | "teamStore" | "requests" | "monitor">) => storeContext(options.store).pipe(
  Context.add(ProjectSupervisorStore, serviceOf(options.store)), Context.add(SupervisorTeamStore, serviceOf(options.teamStore)),
  Context.add(SupervisorConversationStore, serviceOf(options.requests)), Context.add(ProjectSupervisorMonitorStore, serviceOf(options.monitor)));

// the team runtime service over the transport unit's gate (or its own), the fake transport as a service
const teamRuntimeService = (options: TeamRuntimeUnitOptions): SupervisorTeamRuntime["Service"] => {
  const unit = options.helperTransport ? transports.get(options.helperTransport) : undefined;
  const context = runtimeContext(options);
  const guard = unit?.guard ?? openGuard;
  const gate = unit?.gate ?? Effect.runSync(makeSupervisionGate(guard).pipe(Effect.provide(context)));
  const transport = unit?.service ?? (options.helperTransport ? promiseTransport(options.helperTransport, guard) : undefined);
  const stopped = options.supervisionStopped;
  return Effect.runSync(SupervisorTeamRuntime.make({ stopped: (_guard, mainThreadId) => stopped ? predicate(() => stopped(mainThreadId)) : Effect.succeed(false) }).pipe(
    (effect) => transport ? Effect.provideService(effect, HelperTransport, transport) : effect,
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(T3Client, projectionClient(options.projection)),
    Effect.provide(context),
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

type ConversationCallbacks = {
  projection: (threadId: string, signal: AbortSignal) => Promise<Projection>;
  eligible: (thread: ThreadInfo, threads: readonly ThreadInfo[]) => Answer;
  enabled: (projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile") => Answer;
  supervisionStopped: (mainThreadId: string) => Answer<ThreadPolicyStoreError>;
};

// the baseline constructor callbacks as the scope predicates, read through the unit when called, so a suite may replace them
class UnitScope extends SupervisionScope {
  constructor(config: SupervisorConfig, stores: SupervisionScopeStores, private readonly unit: ConversationCallbacks) {super(config, stores, true);}
  override scopeEnabled(projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile") {return predicate(() => this.unit.enabled(projectId, mainThreadId, purpose));}
  override supervisionStopped(threadId: string) {return predicate(() => this.unit.supervisionStopped(threadId));}
  override eligible(thread: ThreadInfo, threads: readonly ThreadInfo[]) {return predicate(() => this.unit.eligible(thread, threads));}
}

type ConversationContext = StoreServices | WorkflowStateStore | SupervisionScopeService | SupervisionGate | SupervisorConversation;
type Seams = Effect.Success<typeof SupervisorConversation.makeUnit>["seams"];
export type SupervisorConversationUnit = SupervisorConversationFacade & ConversationCallbacks & {
  readonly store: Promised<ProjectSupervisorStore["Service"]>;
  readonly definitions: DefinitionsLoader | undefined;
  readonly teamRuntime: (SupervisorTeamRuntimeFacade & { options: TeamRuntimeUnitOptions }) | null;
  // internal steps on their own (the service's test seams), in their baseline shapes
  sendIntroduction(task: TaskRecord, introduction: WorkflowIntroduction, threads: readonly ThreadInfo[], signal: AbortSignal): Promise<void>;
  roleFor(binding: BindingRecord): StorePromise<string>;
  cachedProvisionalDefinitions(task: TaskRecord): ProjectDefinitionSnapshot | null;
  dialogueDefinitions(task: TaskRecord, signal: AbortSignal): Promise<ProjectDefinitionSnapshot | null>;
  compactRecordProblem(...args: Parameters<Seams["compactRecordProblem"]>): StorePromise<Effect.Success<ReturnType<Seams["compactRecordProblem"]>>>;
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
  store: Promised<ProjectSupervisorStore["Service"]>, rpc: SupervisorRpc | null, projection: (threadId: string, signal: AbortSignal) => Promise<Projection>,
  definitions: DefinitionsLoader | undefined, eligible: ConversationCallbacks["eligible"],
  enabled?: ConversationCallbacks["enabled"], workflows?: Promised<WorkflowStateStore["Service"]>,
  descendantContactable?: (thread: ThreadInfo, threads: readonly ThreadInfo[]) => boolean, teamStore?: Promised<SupervisorTeamStore["Service"]>,
  helperTransport?: SupervisorHelperDeliveryTransport, helperProviderInstanceId?: string,
]): SupervisorConversationUnit => {
  if (descendantContactable) throw new Error("a conversation unit derives descendant contactability from its scope");
  const callbacks: ConversationCallbacks = { projection, eligible, enabled: enabled ?? (() => true), supervisionStopped: () => false };
  const unit = callbacks as SupervisorConversationUnit;
  const config: SupervisorConfig = { dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0,
    ...(helperProviderInstanceId ? { helperProviderInstanceId } : {}) };
  const stores = storeUnitOf(store);
  const scope = new UnitScope(config, scopeStores(store), unit);
  const storeServices = storeContext(store, workflows ?? null).pipe((context) => teamStore ? Context.add(context, SupervisorTeamStore, serviceOf(teamStore)) : context);
  const gate = Effect.runSync(makeSupervisionGate(scope).pipe(Effect.provide(storeServices)));
  const supervisors = serviceOf(store);
  const teamOptions: TeamRuntimeUnitOptions | null = teamStore ? { store, teamStore, requests: stores.requests, monitor: stores.monitor, rpc, projection: (threadId, signal) => unit.projection(threadId, signal),
    ...(helperTransport ? { helperTransport } : {}),
    supervisionStopped: (mainThreadId) => Effect.gen(function* () {
      if (yield* predicate(() => unit.supervisionStopped(mainThreadId))) return true;
      const projectId = (yield* supervisors.bindings()).find((item) => item.mainThreadId === mainThreadId)?.projectId ?? "";
      return !(yield* predicate(() => unit.enabled(projectId, mainThreadId)));
    }) } : null;
  const runtime = teamOptions ? teamRuntimeService(teamOptions) : null;
  const built = build(Effect.gen(function* () {
    const parts = yield* SupervisorConversation.makeUnit;
    const context = Context.make(SupervisorConversation, parts.service).pipe(Context.add(SupervisionGate, gate), Context.add(SupervisionScopeService, scope),
      Context.merge(storeServices));
    return { ...parts, context };
  }).pipe(
    Effect.provideService(SupervisionScopeService, scope),
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(T3Client, projectionClient((threadId, signal) => unit.projection(threadId, signal))),
    withOperate(rpc),
    (effect) => definitions ? Effect.provideService(effect, ProjectDefinitions, definitionsService(definitions)) : effect,
    (effect) => runtime ? Effect.provideService(effect, SupervisorTeamRuntime, runtime) : effect,
    Effect.provide(storeServices),
  ));
  const teamRuntime = teamOptions && runtime ? teamRuntimeFacadeUnit(teamOptions, runtime) : null;
  const seams = built.seams;
  return Object.assign(unit, supervisorConversationFacade(run, built.service, stores, teamRuntime), {
    store, definitions, teamRuntime, context: built.context, runtime,
    sendIntroduction: (task: TaskRecord, introduction: WorkflowIntroduction, threads: readonly ThreadInfo[], signal: AbortSignal) =>
      run(seams.sendIntroduction(task, introduction, threads), { signal }),
    roleFor: (binding: BindingRecord) => run(seams.roleFor(binding)),
    cachedProvisionalDefinitions: seams.cachedProvisionalDefinitions,
    dialogueDefinitions: (task: TaskRecord, signal: AbortSignal) => run(seams.dialogueDefinitions(task), { signal }),
    compactRecordProblem: (...args: Parameters<Seams["compactRecordProblem"]>) => run(seams.compactRecordProblem(...args)),
    humanMessageSince: (mainThreadId: string, since: number, signal: AbortSignal) => run(seams.humanMessageSince(mainThreadId, since), { signal }),
  });
};

// the baseline SupervisorLifecycle constructor over the ported service, beside the conversation unit it observes: its own T3
// projection, operate rpc and workflow state; its requests, monitor, scope and admission gate are the conversation's
export const supervisorLifecycleUnit = (store: Promised<ProjectSupervisorStore["Service"]>, conversation: SupervisorConversationUnit,
  projection: (threadId: string, signal: AbortSignal) => Promise<Projection>, rpc: SupervisorRpc | null,
  workflows?: Promised<WorkflowStateStore["Service"]>): SupervisorLifecycleFacade => {
  const context = Context.add(Context.omit(WorkflowStateStore)(conversation.context), ProjectSupervisorStore, serviceOf(store)).pipe(
    (merged) => workflows ? Context.add(merged, WorkflowStateStore, serviceOf(workflows)) : merged);
  const lifecycle = build(SupervisorLifecycle.make.pipe(
    Effect.provideService(T3Client, projectionClient(projection)),
    withOperate(rpc),
    (effect) => conversation.runtime ? Effect.provideService(effect, SupervisorTeamRuntime, conversation.runtime) : effect,
    Effect.provide(context),
  ));
  return supervisorLifecycleFacade(run, lifecycle);
};

// the baseline ProjectSupervisor definitions loader, its optional operations included
export type ProjectSupervisorUnitDefinitions = Pick<ProjectDefinitionLoader, "load"> & {
  presence?: (projectId: string, signal: AbortSignal) => Promise<SupervisionFolderPresence>;
  presenceGlobal?: (signal: AbortSignal) => Promise<SupervisionFolderPresence>;
  globalDefinitionsPath?: () => string;
  globalFingerprint?: (signal: AbortSignal) => Promise<string | null>;
  initializeGlobal?: (signal: AbortSignal) => Promise<{status: "created" | "unchanged" | "conflict" | "permission_required" | "unavailable" | "uncertain"; workspaceRoot: string; branch: null; message: string}>;
  checkoutTargets?: (projectId: string, signal: AbortSignal) => Promise<Array<{origin: "project"; threadId: string | null; workspaceRoot: string; branch: string | null; isGitRepository: boolean}>>;
  presenceForCheckout?: (projectId: string, threadId: string | null, signal: AbortSignal) => Promise<SupervisionFolderPresence>;
  initialize?: (projectId: string, threadId: string | null, input: {origin: "project"; action: "create" | "create_and_commit"; expectedWorkspaceRoot: string; expectedBranch: string | null},
    signal: AbortSignal) => Promise<{status: "created" | "committed" | "unchanged" | "stale" | "conflict" | "permission_required" | "unavailable" | "uncertain"; workspaceRoot: string | null; branch: string | null; message: string}>;
};

// the loader's operations as the supervisor's definitions, read through the loader when called; a rejection is the failed read
const definitionsAccessOf = (loader: ProjectSupervisorUnitDefinitions): SupervisorDefinitionsAccess => {
  const settle = <A>(call: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({try: call, catch: (error) => new DefinitionSourceFailure({error})});
  return {
    load: (projectId, threadId) => settle((signal) => loader.load(projectId, threadId, signal)),
    ...(loader.presence ? {presence: (projectId: string) => settle((signal) => loader.presence!(projectId, signal))} : {}),
    ...(loader.presenceGlobal ? {presenceGlobal: () => settle((signal) => loader.presenceGlobal!(signal))} : {}),
    ...(loader.globalDefinitionsPath ? {globalDefinitionsPath: () => loader.globalDefinitionsPath!()} : {}),
    ...(loader.globalFingerprint ? {globalFingerprint: () => settle((signal) => loader.globalFingerprint!(signal))} : {}),
    ...(loader.initializeGlobal ? {initializeGlobal: () => settle((signal) => loader.initializeGlobal!(signal))} : {}),
    ...(loader.checkoutTargets ? {checkoutTargets: (projectId: string) => settle((signal) => loader.checkoutTargets!(projectId, signal))} : {}),
    ...(loader.presenceForCheckout ? {presenceForCheckout: (projectId: string, threadId: string | null) => settle((signal) => loader.presenceForCheckout!(projectId, threadId, signal))} : {}),
    ...(loader.initialize ? {initialize: (projectId: string, threadId: string | null, input: ProjectDefinitionSetupInput) => settle((signal) => loader.initialize!(projectId, threadId, input, signal))} : {}),
  };
};

// an aborted call without a result settles as the baseline aborted call did, once its work has ended
const settledCall = (work: Effect.Effect<void, unknown>, signal?: AbortSignal): Promise<void> =>
  Effect.runPromiseExit(work, signal ? {signal} : undefined).then((exit) => {
    if (Exit.isSuccess(exit) || signal?.aborted && Cause.hasInterruptsOnly(exit.cause)) return;
    throw Cause.squash(exit.cause);
  });
// a call with a result rejects with its failure, and when aborted
const resultCall = <A>(work: Effect.Effect<A, unknown>, signal?: AbortSignal): Promise<A> =>
  Effect.runPromiseExit(work, signal ? {signal} : undefined).then((exit) => Exit.isSuccess(exit) ? exit.value : Promise.reject(Cause.squash(exit.cause)));

// the services one supervision unit runs over: its stores and scope predicates, the workflow state store and the team services
type TeamServices = Effect.Success<ReturnType<typeof supervisorTeamServices>> extends Context.Context<infer S> ? S : never;
type SupervisionUnitContext = Context.Context<StoreServices | WorkflowStateStore | SupervisionScopeService | TeamServices>;

/** The baseline ProjectSupervisor promise shapes over the ported services, for the suites written against them. */
export type ProjectSupervisorUnit = {
  readonly config: SupervisorConfig;
  readonly store: Promised<ProjectSupervisorStore["Service"]>;
  readonly t3: Pick<T3ClientShape, "projection">;
  readonly definitions: ProjectSupervisorUnitDefinitions | undefined;
  readonly gate: SupervisionScope;
  readonly team: Promised<SupervisorTeamStore["Service"]>;
  readonly workflowStates: Promised<WorkflowStateStore["Service"]>;
  readonly helperTransport: SupervisorHelperDeliveryTransport;
  readonly conversation: SupervisorConversationFacade;
  readonly lifecycle: SupervisorLifecycleFacade;
  // the per-scope locks of the supervisor's own operations that a running or waiting operation holds (the baseline queues)
  readonly queues: {readonly size: number};
  // the services of the unit, for controllers built beside it
  readonly services: SupervisionUnitContext;
  // the admission section the unit's services share
  readonly admission: {readonly gate: SupervisionGateShape};
  readonly supervisionControl: SupervisionControl["Service"];
  readonly service: ProjectSupervisor["Service"];
  runOnce(signal?: AbortSignal): Promise<void>;
  scopeEnabled(projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile"): StorePromise<boolean>;
  workflowEditingEnabled(projectId: string, mainThreadId?: string, purpose?: "effect" | "status" | "read"): StorePromise<boolean>;
  supervisionStopped(threadId: string): StorePromise<boolean>;
  noProjectControl(): ReturnType<ProjectSupervisor["Service"]["noProjectControl"]>;
  workflowLocator(projectId: string, mainThreadId: string): ReturnType<ProjectSupervisor["Service"]["workflowLocator"]>;
  startStatus(threadId: string, operationId: string): ReturnType<SupervisionControl["Service"]["startStatus"]>;
  saveThreadPolicy(input: ThreadPolicySettings): ReturnType<SupervisionControl["Service"]["saveThreadPolicy"]>;
  startSupervision(input: SupervisionStartInput, evidence: {runId: string}, signal: AbortSignal): Promise<SupervisionStartResult>;
  dashboardStart(threadId: string, operationId: string, signal: AbortSignal): Promise<SupervisionStartResult>;
  stopSupervision(input: SupervisionStopInput, evidence: unknown, signal: AbortSignal): Promise<SupervisionStopResult>;
  scopeSnapshot(projectId: string, mainThreadId: string, signal: AbortSignal, options?: ProjectSupervisorScopeSnapshotOptions): Promise<Effect.Success<ReturnType<ProjectSupervisor["Service"]["scopeSnapshot"]>>>;
  control(projectId: string | null, signal: AbortSignal): Promise<Effect.Success<ReturnType<ProjectSupervisor["Service"]["control"]>>>;
  globalDefinitionsControl(signal: AbortSignal): Promise<Effect.Success<ProjectSupervisor["Service"]["globalDefinitionsControl"]>>;
  saveGlobalDefinitionsControl(input: GlobalDefinitionsControlInput, signal: AbortSignal): Promise<Effect.Success<ReturnType<ProjectSupervisor["Service"]["saveGlobalDefinitionsControl"]>>>;
  setupOptions(projectId: string, signal: AbortSignal): Promise<Effect.Success<ReturnType<ProjectSupervisor["Service"]["setupOptions"]>>>;
  setup(input: SupervisionSetupInput, signal: AbortSignal): Promise<Effect.Success<ReturnType<ProjectSupervisor["Service"]["setup"]>>>;
  saveControl(input: SupervisionControlInput, signal: AbortSignal): Promise<Effect.Success<ReturnType<ProjectSupervisor["Service"]["saveControl"]>>>;
  saveNoProjectControl(input: NoProjectControlInput, signal: AbortSignal): Promise<Effect.Success<ReturnType<ProjectSupervisor["Service"]["saveNoProjectControl"]>>>;
  candidates(query?: string, purpose?: "start" | "exclude"): Promise<Effect.Success<ReturnType<ProjectSupervisor["Service"]["candidates"]>>>;
  overview(page: {offset: number; limit: number}): Promise<Effect.Success<ReturnType<ProjectSupervisor["Service"]["overview"]>>>;
  snapshot(projectId: string, signal: AbortSignal, mainThreadId?: string | null): Promise<ProjectSupervisorInfo>;
  save(input: ProjectSupervisorSaveInput, signal: AbortSignal): Promise<ProjectSupervisorSaveOutcome>;
  setChatSupervision(input: ProjectSupervisorChatSupervisionInput, signal: AbortSignal): Promise<ProjectSupervisorSaveOutcome>;
  retry(input: ProjectSupervisorRetryInput, signal: AbortSignal): Promise<ProjectSupervisorSaveOutcome>;
  ensureBinding(projectId: string, mainThreadId: string, title: string, signal: AbortSignal): Promise<BindingRecord>;
  // one interpretation dispatch with its final stop and scope checks; the scope check of the supervisor's own work as a delegate
  dispatch(task: TaskRecord, signal: AbortSignal): Promise<void>;
  projectEnabled(projectId: string, mainThreadId?: string): StorePromise<boolean>;
};

// the promise shapes of one built supervision unit
export const projectSupervisorFacade = (parts: {config: SupervisorConfig; store: Promised<ProjectSupervisorStore["Service"]>; t3: Pick<T3ClientShape, "projection">;
  definitions: ProjectSupervisorUnitDefinitions | undefined; scope: SupervisionScope; services: SupervisionUnitContext; control: SupervisionControl["Service"];
  supervisor: ProjectSupervisor["Service"]; seams: ProjectSupervisorSeams; locks: ScopeLocks["Service"]}): ProjectSupervisorUnit => {
  const {services, control, supervisor, seams, scope, locks} = parts;
  const stores = storeUnitOf(parts.store);
  const runtime = Context.get(services, SupervisorTeamRuntime);
  const teamRuntime = teamRuntimeFacade(run, runtime);
  return {
    config: parts.config, store: parts.store, t3: parts.t3, definitions: parts.definitions, gate: scope, team: stores.team,
    workflowStates: storeFacade(stores, Context.get(services, WorkflowStateStore), services as Context.Context<never>),
    helperTransport: helperTransportFacade(run, Context.get(services, HelperTransport)),
    conversation: supervisorConversationFacade(run, Context.get(services, SupervisorConversation), stores, teamRuntime),
    lifecycle: supervisorLifecycleFacade(run, Context.get(services, SupervisorLifecycle)),
    queues: {get size() {return Effect.runSync(locks.leased).filter((key) => !key.startsWith("start:")).length;}},
    services, admission: {gate: Context.get(services, SupervisionGate)}, supervisionControl: control, service: supervisor,
    // the baseline default deadline of a cycle is 120 s
    runOnce: (signal) => settledCall(signal ? supervisor.cycle : Effect.asVoid(Effect.timeoutOption(supervisor.cycle, "120 seconds")), signal),
    scopeEnabled: (projectId, mainThreadId, purpose) => run(scope.scopeEnabled(projectId, mainThreadId, purpose)),
    workflowEditingEnabled: (projectId, mainThreadId, purpose) => run(scope.workflowEditingEnabled(projectId, mainThreadId, purpose)),
    supervisionStopped: (threadId) => run(scope.supervisionStopped(threadId)),
    noProjectControl: () => supervisor.noProjectControl(),
    workflowLocator: (projectId, mainThreadId) => supervisor.workflowLocator(projectId, mainThreadId),
    startStatus: (threadId, operationId) => control.startStatus(threadId, operationId),
    saveThreadPolicy: (input) => control.saveThreadPolicy(input),
    startSupervision: (input, evidence, signal) => resultCall(control.startSupervision(input, evidence), signal),
    dashboardStart: (threadId, operationId, signal) => resultCall(control.dashboardStart(threadId, operationId), signal),
    stopSupervision: (input, evidence, signal) => resultCall(control.stopSupervision(input, evidence), signal),
    scopeSnapshot: (projectId, mainThreadId, signal, options) => resultCall(supervisor.scopeSnapshot(projectId, mainThreadId, options), signal),
    control: (projectId, signal) => resultCall(supervisor.control(projectId), signal),
    globalDefinitionsControl: (signal) => resultCall(supervisor.globalDefinitionsControl, signal),
    saveGlobalDefinitionsControl: (input, signal) => resultCall(supervisor.saveGlobalDefinitionsControl(input), signal),
    setupOptions: (projectId, signal) => resultCall(supervisor.setupOptions(projectId), signal),
    setup: (input, signal) => resultCall(supervisor.setup(input), signal),
    saveControl: (input, signal) => resultCall(supervisor.saveControl(input), signal),
    saveNoProjectControl: (input, signal) => resultCall(supervisor.saveNoProjectControl(input), signal),
    candidates: (query, purpose) => resultCall(supervisor.candidates(query, purpose)),
    overview: (page) => resultCall(supervisor.overview(page)),
    snapshot: (projectId, signal, mainThreadId = null) => resultCall(supervisor.snapshot(projectId, mainThreadId), signal),
    save: (input, signal) => resultCall(supervisor.save(input), signal),
    setChatSupervision: (input, signal) => resultCall(supervisor.setChatSupervision(input), signal),
    retry: (input, signal) => resultCall(supervisor.retry(input), signal),
    ensureBinding: (projectId, mainThreadId, title, signal) => resultCall(seams.ensureBinding(projectId, mainThreadId, title), signal),
    dispatch: (task, signal) => resultCall(seams.dispatch(task), signal),
    projectEnabled: (projectId, mainThreadId) => run(scope.projectEnabled(projectId, mainThreadId)),
  };
};

// the native shell of a unit: the activation boundary through the promise read; the lineage read is not used
const activationShell = (activationSnapshot: (signal: AbortSignal) => Promise<SupervisorBaseline>): NativeShell["Service"] => ({
  baseline: Effect.tryPromise({try: (signal) => activationSnapshot(signal), catch: (cause) => cause instanceof SupervisorRpcError ? cause : new SupervisorRpcError("uncertain")}),
  threads: Effect.die(new Error("unused")),
});

type UnitControllers = SupervisionControl | WorkflowWriteController | SupervisorTeamController;
type ServicesOf<C> = C extends Context.Context<infer S> ? S : never;
type UnitServices = ServicesOf<SupervisionUnitContext> | ScopeLocks | SupervisorIds | Store | T3Client | NativeRpc | NativeShell;

// builds the Start/Stop control (or the workflow controllers, when the unit has an endpoint) and the project supervisor over the
// unit's services, the catalog, the native clients, the locks and the ids; `now`, when given, is the clock the two services
// stamp their synchronous blocks with, as the baseline constructor clock was, while every other service keeps the wall clock
export const buildProjectSupervisor = (input: {services: SupervisionUnitContext; source: Pick<StoreShape, "catalog">; t3: Pick<T3ClientShape, "projection">;
  read: NativeRpcShape; shell: NativeShell["Service"]; operate: NativeRpcShape | null; definitions: ProjectSupervisorUnitDefinitions | undefined;
  now?: (() => number) | undefined;
  controllers?: ((context: Context.Context<UnitServices>) => Effect.Effect<Context.Context<UnitControllers>, unknown, Scope.Scope>) | undefined;
  // the scope the services live in, else the test process
  scope?: Scope.Scope | undefined;
  // the per-scope locks the two services see, for a suite that observes them
  locks?: ((locks: ScopeLocksShape) => ScopeLocksShape) | undefined}) => {
  const build = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A => input.scope ? Effect.runSync(Scope.provide(input.scope)(effect)) : buildUnit(effect);
  const clocked = <A, E, R>(effect: Effect.Effect<A, E, R>) => input.now ? Effect.provideService(effect, Clock.Clock, clockOf(input.now)) : effect;
  const built = build(Layer.build(ScopeLocks.layer));
  const shared = input.locks ? Context.add(built, ScopeLocks, input.locks(Context.get(built, ScopeLocks))) : built;
  const clients = Context.merge(input.services, shared).pipe(Context.add(Store, input.source as StoreShape),
    Context.add(T3Client, {descriptor: () => Effect.die(new Error("unused")), watch: () => Effect.die(new Error("unused")),
      projection: (threadId) => Effect.suspend(() => input.t3.projection(threadId))}),
    Context.add(NativeRpc, input.read), Context.add(NativeShell, input.shell));
  // the operate client is optional to every service
  const context: Context.Context<UnitServices> = input.operate ? Context.add(clients, NativeOperateRpc, input.operate) : clients;
  // a unit without an endpoint has the Start/Stop control alone, as the baseline unit had no team effects
  const controlled = (input.controllers ? build(input.controllers(context))
    : Context.make(SupervisionControl, build(clocked(SupervisionControl.make).pipe(Effect.provide(context))))) as Context.Context<SupervisionControl>;
  const unit = build(clocked(ProjectSupervisor.makeUnit(input.definitions ? {definitions: definitionsAccessOf(input.definitions)} : {})).pipe(
    Effect.provide(Context.merge(context, controlled))));
  return {control: Context.get(controlled, SupervisionControl), locks: Context.get(shared, ScopeLocks), supervisor: unit.service, seams: unit.seams,
    controllers: controlled as Context.Context<Partial<UnitControllers> | SupervisionControl>};
};

// the scope predicates and the services of one supervision run over a run's stores, as src/supervision-live.ts builds them: the
// workflow state store over the scope's workflow-editing predicate, the admission gate, the helper transport, the team runtime,
// the conversation and the lifecycle, over the operate client, the T3 client, the definitions and the fetch client; `policy`,
// when given, is the run's policy store in place of the stores' own, and `scope` the scope they live in (else the test process)
export const supervisionServices = (input: {config: SupervisorConfig; store: Promised<ProjectSupervisorStore["Service"]>; operate: NativeRpcShape | null;
  t3: T3ClientShape; definitions?: ProjectDefinitions["Service"] | undefined; fetch?: typeof globalThis.fetch | undefined;
  policy?: ThreadPolicyStore["Service"] | undefined; scope?: Scope.Scope | undefined}) => {
  const built = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A => input.scope ? Effect.runSync(Scope.provide(input.scope)(effect)) : build(effect);
  const {policy, definitions} = input;
  const scope = new SupervisionScope(input.config, scopeStores(input.store, policy), input.operate !== null);
  const workflows = built(Layer.build(WorkflowStateStore.layerWith((projectId, mainThreadId) => scope.workflowEditingEnabled(projectId, mainThreadId))).pipe(
    Effect.provide(storeContext(input.store))));
  const stores = Context.merge(storeContext(input.store), workflows).pipe(Context.add(SupervisionScopeService, scope),
    (context) => policy ? Context.add(context, ThreadPolicyStore, policy) : context);
  const team = built(supervisorTeamServices(input.config.t3Url).pipe(
    (effect) => input.operate ? Effect.provideService(effect, NativeOperateRpc, input.operate) : effect,
    (effect) => definitions ? Effect.provideService(effect, ProjectDefinitions, definitions) : effect,
    Effect.provideService(T3Client, input.t3),
    Effect.provide(FetchHttpClient.layer),
    // a test may observe the synchronous start of each request; the request itself is the platform fetch's
    (effect) => input.fetch ? Effect.provideService(effect, FetchHttpClient.Fetch, input.fetch) : effect,
    Effect.provide(stores),
  ));
  const services: SupervisionUnitContext = Context.merge(stores, team);
  return {scope, services};
};

// the baseline ProjectSupervisor constructor: the scope predicates and the team, conversation and lifecycle services are built
// as the root builds them, over the operate rpc, the T3 client (read through `t3` when called), the definitions and global
// fetch, with an admission gate that guards with those scope predicates; no workflow controllers are wired, as the baseline
// unit had no team effects. `policy` stands for the baseline config.threadPolicy
export const projectSupervisorUnit = (config: SupervisorConfig, store: Promised<ProjectSupervisorStore["Service"]>, source: Pick<StoreShape, "catalog">,
  t3: Pick<T3ClientShape, "projection">, readRpc: SupervisorRpc, operateRpc: SupervisorRpc | null,
  activationSnapshot: (signal: AbortSignal) => Promise<SupervisorBaseline>, definitions?: ProjectSupervisorUnitDefinitions,
  now?: () => number, options: {locks?: (locks: ScopeLocksShape) => ScopeLocksShape; policy?: ThreadPolicyStore["Service"]} = {}): ProjectSupervisorUnit => {
  const operate = operateRpc ? operateClient(operateRpc) : null;
  const {scope, services} = supervisionServices({config, store, operate, policy: options.policy,
    definitions: definitions && definitionsService(definitions),
    t3: {descriptor: () => Effect.die(new Error("unused")), watch: () => Effect.die(new Error("unused")), projection: (threadId) => Effect.suspend(() => t3.projection(threadId))}});
  const built = buildProjectSupervisor({services, source, t3, read: operateClient(readRpc), shell: activationShell(activationSnapshot), definitions,
    operate, now, locks: options.locks});
  return projectSupervisorFacade({config, store, t3, definitions, scope, services, ...built});
};

// the team view of retained records in the baseline call shape: the read step over the given stores, then the presentation;
// the read, synchronous at baseline, answers as a promise
export const supervisorTeamView = (team: Promised<SupervisorTeamStore["Service"]>, binding: BindingRecord, threads: readonly ThreadInfo[],
  requests: Promised<SupervisorConversationStore["Service"]>, now = Date.now()): StorePromise<ProjectSupervisorTeamInfo> =>
  storeUnitOf(team).run(readTeamViewData(binding).pipe(Effect.provideService(SupervisorTeamStore, serviceOf(team)),
    Effect.provideService(SupervisorConversationStore, serviceOf(requests)))).then((data) => presentTeamView(data, binding, threads, now));
