import { NodeCrypto } from "@effect/platform-node";
import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { helperTransportFacade, supervisorConversationFacade, supervisorLifecycleFacade, supervisorTeamServices, teamRuntimeFacade, type RootRun } from "../../src/guidance-application.js";
import { definitionsService, type DefinitionsLoader, type ProjectDefinitionLoader } from "./root-facades.js";
import { SupervisorIds } from "../../src/ids.js";
import { DefinitionSourceFailure, ProjectDefinitions, type ProjectDefinitionSetupInput } from "../../src/project-definitions.js";
import type { BindingRecord, ProjectSupervisorStore, SupervisionFolderPresence, SupervisorBaseline, TaskRecord } from "../../src/project-supervisor-store.js";
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
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService, type GateGuard, type SupervisionGateShape } from "../../src/supervision-gate.js";
import { SupervisionStores } from "../../src/supervision-stores.js";
import { SupervisorConversation, type SupervisorConversationFacade } from "../../src/supervisor-conversation.js";
import { SupervisorConversationStore, type WorkflowIntroduction } from "../../src/supervisor-conversation-store.js";
import { HelperTransport, type HelperTransportShape, type SupervisorHelperDeliveryTransport } from "../../src/supervisor-helper-transport.js";
import { SupervisorLifecycle, type SupervisorLifecycleFacade } from "../../src/supervisor-lifecycle.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { NativeOperateRpc, NativeRpc, NativeShell, SupervisorRpcError, type NativeRpcShape, type SupervisorRpc } from "../../src/supervisor-native.js";
import { SupervisorTeamRuntime, type SupervisorTeamRuntimeFacade } from "../../src/supervisor-team-runtime.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { readTeamViewData, supervisorTeamView as presentTeamView } from "../../src/supervisor-team-view.js";
import { T3Client, T3TransportError, type T3ClientShape } from "../../src/t3.js";
import type { Projection, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import type { WorkflowStateStore } from "../../src/workflow-state-store.js";

// the baseline constructors of the helper transport, the team runtime and their two owners, rebuilt over the ported
// services and the production b-03 facades (src/guidance-application.ts); each unit keeps its constructor options

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

// the services one supervision unit runs over: the team services, the Start/Stop control and the project supervisor
type SupervisionUnitContext = Effect.Success<ReturnType<typeof supervisorTeamServices>>;

/** The baseline ProjectSupervisor promise shapes over the ported services, for the suites written against them. */
export type ProjectSupervisorUnit = {
  readonly config: SupervisorConfig;
  readonly store: ProjectSupervisorStore;
  readonly t3: Pick<T3ClientShape, "projection">;
  readonly definitions: ProjectSupervisorUnitDefinitions | undefined;
  readonly gate: SupervisionScope;
  readonly team: SupervisorTeamStore;
  readonly workflowStates: WorkflowStateStore;
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
  scopeEnabled(projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile"): boolean;
  workflowEditingEnabled(projectId: string, mainThreadId?: string, purpose?: "effect" | "status" | "read"): boolean;
  supervisionStopped(threadId: string): boolean;
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
  projectEnabled(projectId: string, mainThreadId?: string): boolean;
};

// the promise shapes of one built supervision unit
export const projectSupervisorFacade = (parts: {config: SupervisorConfig; store: ProjectSupervisorStore; t3: Pick<T3ClientShape, "projection">;
  definitions: ProjectSupervisorUnitDefinitions | undefined; scope: SupervisionScope; services: SupervisionUnitContext; control: SupervisionControl["Service"];
  supervisor: ProjectSupervisor["Service"]; seams: ProjectSupervisorSeams; locks: ScopeLocks["Service"]}): ProjectSupervisorUnit => {
  const {services, control, supervisor, seams, scope, locks} = parts;
  const stores = Context.get(services, SupervisionStores);
  const runtime = Context.get(services, SupervisorTeamRuntime);
  const teamRuntime = teamRuntimeFacade(run, runtime);
  return {
    config: parts.config, store: parts.store, t3: parts.t3, definitions: parts.definitions, gate: scope, team: stores.team, workflowStates: stores.workflows!,
    helperTransport: helperTransportFacade(run, Context.get(services, HelperTransport)),
    conversation: supervisorConversationFacade(run, Context.get(services, SupervisorConversation), stores, teamRuntime),
    lifecycle: supervisorLifecycleFacade(run, Context.get(services, SupervisorLifecycle)),
    queues: {get size() {return Effect.runSync(locks.leased).filter((key) => !key.startsWith("start:")).length;}},
    services, admission: {gate: Context.get(services, SupervisionGate)}, supervisionControl: control, service: supervisor,
    // the baseline default deadline of a cycle is 120 s
    runOnce: (signal) => settledCall(signal ? supervisor.cycle : Effect.asVoid(Effect.timeoutOption(supervisor.cycle, "120 seconds")), signal),
    scopeEnabled: (projectId, mainThreadId, purpose) => scope.scopeEnabled(projectId, mainThreadId, purpose),
    workflowEditingEnabled: (projectId, mainThreadId, purpose) => scope.workflowEditingEnabled(projectId, mainThreadId, purpose),
    supervisionStopped: (threadId) => scope.supervisionStopped(threadId),
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
    projectEnabled: (projectId, mainThreadId) => scope.projectEnabled(projectId, mainThreadId),
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
  controllers?: ((context: Context.Context<UnitServices>) => Effect.Effect<Context.Context<UnitControllers>, never, Scope.Scope>) | undefined;
  // the scope the services live in, else the test process
  scope?: Scope.Scope | undefined;
  // the per-scope locks the two services see, for a suite that observes them
  locks?: ((locks: ScopeLocksShape) => ScopeLocksShape) | undefined}) => {
  const build = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A => input.scope ? Effect.runSync(Scope.provide(input.scope)(effect)) : buildUnit(effect);
  const clocked = <A, E, R>(effect: Effect.Effect<A, E, R>) => input.now ? Effect.provideService(effect, Clock.Clock, clockOf(input.now)) : effect;
  const built = build(Layer.build(Layer.mergeAll(ScopeLocks.layer, ids)));
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

// the baseline ProjectSupervisor constructor: the scope predicates and the team, conversation and lifecycle services are built
// as the root builds them, over the operate rpc, the T3 client (read through `t3` when called), the definitions and global
// fetch, with an admission gate that guards with those scope predicates; no workflow controllers are wired, as the baseline
// unit had no team effects
export const projectSupervisorUnit = (config: SupervisorConfig, store: ProjectSupervisorStore, source: Pick<StoreShape, "catalog">,
  t3: Pick<T3ClientShape, "projection">, readRpc: SupervisorRpc, operateRpc: SupervisorRpc | null,
  activationSnapshot: (signal: AbortSignal) => Promise<SupervisorBaseline>, definitions?: ProjectSupervisorUnitDefinitions,
  now?: () => number, options: {locks?: (locks: ScopeLocksShape) => ScopeLocksShape} = {}): ProjectSupervisorUnit => {
  const scope = new SupervisionScope(config, store, Boolean(operateRpc));
  const services = build(supervisorTeamServices(store, config.t3Url, scope).pipe(
    withOperate(operateRpc),
    Effect.provideServiceEffect(SupervisionGate, makeSupervisionGate(scope)),
    (effect) => definitions ? Effect.provideService(effect, ProjectDefinitions, definitionsService(definitions)) : effect,
    Effect.provideService(T3Client, { descriptor: () => Effect.die(new Error("unused")), watch: () => Effect.die(new Error("unused")),
      projection: (threadId) => Effect.suspend(() => t3.projection(threadId)) }),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, ids)),
  ));
  const built = buildProjectSupervisor({services, source, t3, read: operateClient(readRpc), shell: activationShell(activationSnapshot), definitions,
    operate: operateRpc ? operateClient(operateRpc) : null, now, locks: options.locks});
  return projectSupervisorFacade({config, store, t3, definitions, scope, services, ...built});
};

// the team view of retained records in the baseline call shape: the read step over the given stores, then the presentation
export const supervisorTeamView = (team: SupervisorTeamStore, binding: BindingRecord, threads: readonly ThreadInfo[], requests: SupervisorConversationStore,
  now = Date.now()): ProjectSupervisorTeamInfo =>
  presentTeamView(Effect.runSync(readTeamViewData(binding).pipe(Effect.provideService(SupervisionStores, {team, requests} as SupervisionStores["Service"]))),
    binding, threads, now);
