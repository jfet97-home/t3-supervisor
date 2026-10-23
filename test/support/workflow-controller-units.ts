import { Clock, Deferred, Effect, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { supervisorTeamControllerFacade, workflowWriteControllerFacade, type RootRun } from "../../src/guidance-application.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ProjectDefinitions } from "../../src/project-definitions.js";
import type { BindingRecord, ProjectSupervisorStore } from "../../src/project-supervisor-store.js";
import { SupervisionControl } from "../../src/supervision-control.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService, type SupervisionGateShape } from "../../src/supervision-gate.js";
import { SupervisionStores } from "../../src/supervision-stores.js";
import { SupervisorConversation } from "../../src/supervisor-conversation.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { HelperTransport } from "../../src/supervisor-helper-transport.js";
import { NativeOperateRpc, SupervisorRpcError, type NativeRpcShape, type SupervisorRpc } from "../../src/supervisor-native.js";
import { SupervisorTeamController } from "../../src/supervisor-team-controller.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { T3Client } from "../../src/t3.js";
import type { Projection, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import type { WorkflowStateStore } from "../../src/workflow-state-store.js";
import {
  WorkflowNativeAccess, WorkflowWriteController, type SupervisionStartInput, type SupervisionStartResult, type SupervisionStopInput,
  type SupervisionStopResult, type SupervisorContextViewInput, type SupervisorContextViewResult,
} from "../../src/workflow-write-controller.js";
import type { WorkflowEvidenceMatch } from "../../src/workflow-write-evidence.js";
import { projectionClient } from "./team-units.js";

// the baseline WorkflowWriteController and SupervisorTeamController constructors, rebuilt over the ported services and the
// production b-03 facades (src/guidance-application.ts); each unit keeps its constructor options

// the baseline promise fakes of the native reads, each honouring the call's signal
export type WorkflowNativeFake = {
  listThreads(signal: AbortSignal): Promise<readonly ThreadInfo[]>;
  projection(threadId: string, signal: AbortSignal): Promise<Projection>;
  getTurnItem(input: {threadId: string; itemId: string}, signal: AbortSignal): Promise<{item: unknown | null}>;
};

export type WorkflowWriteControllerUnitOptions = {
  supervisors: ProjectSupervisorStore;
  helperProviderInstanceId?: string;
  team?: SupervisorTeamStore;
  workflows: WorkflowStateStore;
  native: WorkflowNativeFake;
  loadDefinitions?: (projectId: string, threadId: string, signal: AbortSignal) => Promise<ProjectDefinitionSnapshot>;
  contextViews?: {readContextView(binding: BindingRecord, input: SupervisorContextViewInput, signal: AbortSignal): Promise<SupervisorContextViewResult>};
  stops?: {stop(input: SupervisionStopInput, evidence: WorkflowEvidenceMatch, signal: AbortSignal): Promise<SupervisionStopResult>};
  isEnabled?: (projectId: string, mainThreadId?: string, purpose?: "effect" | "status" | "read") => boolean;
  starts?: {start(input: SupervisionStartInput, evidence: WorkflowEvidenceMatch, signal: AbortSignal): Promise<SupervisionStartResult>};
  isChatStopped?: (mainThreadId: string) => boolean;
  maxEvidenceWaitMs?: number;
};

export type WorkflowWriteControllerUnit = ReturnType<typeof workflowWriteControllerFacade> & {readonly options: WorkflowWriteControllerUnitOptions};
export type SupervisorTeamControllerUnit = Omit<ReturnType<typeof supervisorTeamControllerFacade>, "reconcile"> & {
  readonly workflows: WorkflowWriteControllerUnit;
  // the baseline reconcile took an explicit `now` (its default the wall clock)
  reconcile(binding: BindingRecord, signal: AbortSignal, now?: number): Promise<void>;
};

type Unit = {readonly service: WorkflowWriteController["Service"]; readonly gate: SupervisionGateShape; readonly native: WorkflowNativeAccess["Service"];
  readonly stores: SupervisionStores["Service"]};
const units = new WeakMap<object, Unit>();

// the units live for the test process, as the baseline objects did; nothing is in flight once a test awaited its calls
const build = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A => Effect.runSync(Scope.provide(Effect.runSync(Scope.make()))(effect));
const run: RootRun = (effect) => Effect.runPromise(effect);

// a promise call whose signal aborts once the call's cancel completes or the read is interrupted, as the baseline signal
// reached the fake; a rejection is the failed read it stands for, the fake's own error kept as the cause
const signalled = <A>(cancel: Deferred.Deferred<void> | undefined, call: (signal: AbortSignal) => Promise<A>): Effect.Effect<A> =>
  Effect.scoped(Effect.gen(function* () {
    const controller = new AbortController();
    if (cancel !== undefined) yield* Effect.forkScoped(Effect.andThen(Deferred.await(cancel), Effect.sync(() => controller.abort())));
    return yield* Effect.promise((signal) => {
      signal.addEventListener("abort", () => controller.abort(), {once: true});
      return call(controller.signal);
    });
  }));

// the promise fakes as the native reads
const nativeAccess = (native: WorkflowNativeFake): WorkflowNativeAccess["Service"] => ({
  listThreads: (cancel) => signalled(cancel, (signal) => native.listThreads(signal)),
  projection: (threadId, cancel) => signalled(cancel, (signal) => native.projection(threadId, signal)),
  getTurnItem: (input, cancel) => signalled(cancel, (signal) => native.getTurnItem(input, signal)),
});

// a promise loader as the definitions service; only the fresh pin read is used
const definitionsOf = (load: NonNullable<WorkflowWriteControllerUnitOptions["loadDefinitions"]>): ProjectDefinitions["Service"] =>
  ({load: (projectId: string, threadId?: string | null) => Effect.promise((signal) => load(projectId, threadId ?? "", signal))}) as unknown as ProjectDefinitions["Service"];

// a promise rpc as the operate client: initiate starts the call at once and its result awaits it; a completed cancel aborts the
// call's signal and the fake answers as the baseline call answered an abort
const operateClient = (rpc: SupervisorRpc): NativeRpcShape => {
  const settle = (call: () => Promise<unknown>) => Effect.tryPromise({try: call,
    catch: (cause) => cause instanceof SupervisorRpcError ? cause : new SupervisorRpcError("uncertain")});
  const abortOn = (cancel: Deferred.Deferred<void> | undefined, controller: AbortController) =>
    cancel === undefined ? Effect.void : Effect.asVoid(Effect.forkScoped(Effect.andThen(Deferred.await(cancel), Effect.sync(() => controller.abort()))));
  return {
    call: (tag, payload, cancel) => Effect.scoped(Effect.gen(function* () {
      const controller = new AbortController();
      yield* abortOn(cancel, controller);
      return yield* settle(() => rpc(tag, {...payload}, controller.signal));
    })),
    initiate: (tag, payload, cancel) => Effect.sync(() => {
      const controller = new AbortController();
      const reply = rpc(tag, {...payload}, controller.signal);
      reply.catch(() => undefined);
      return {
        sent: Effect.succeed(true),
        result: Effect.scoped(Effect.andThen(abortOn(cancel, controller), settle(() => reply))),
        release: Effect.sync(() => controller.abort()),
      };
    }),
  };
};

// a clock that reads `now` as wall time, for the baseline calls that took an explicit `now`
const clockAt = (now: number): Clock.Clock => {
  const live = Effect.runSync(Clock.clockWith(Effect.succeed));
  return {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.succeed(now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  };
};

// the baseline `isEnabled` (the stored control by default) and `isChatStopped` options as the scope predicates, read through the
// options when called
class UnitScope extends SupervisionScope {
  constructor(private readonly options: WorkflowWriteControllerUnitOptions) {
    super({dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0} satisfies SupervisorConfig, options.supervisors, true);
  }
  override scopeEnabled(): boolean {return true;}
  override workflowEditingEnabled(projectId: string, mainThreadId?: string, purpose?: "effect" | "status" | "read"): boolean {
    return this.options.isEnabled ? this.options.isEnabled(projectId, mainThreadId, purpose) : this.options.supervisors.enabled(projectId);
  }
  override supervisionStopped(threadId: string): boolean {return this.options.isChatStopped?.(threadId) ?? false;}
}

// the baseline promise context views as the conversation's view read; nothing else of the conversation is used
const contextViewsOf = (views: NonNullable<WorkflowWriteControllerUnitOptions["contextViews"]>): SupervisorConversation["Service"] =>
  ({readContextView: (binding: BindingRecord, input: SupervisorContextViewInput) => Effect.promise((signal) => views.readContextView(binding, input, signal))}) as
    unknown as SupervisorConversation["Service"];

// the baseline Start and Stop delegates as the Start/Stop control the controller calls, each receiving the call's cancel as its
// signal; a missing delegate answers as the baseline controller without it did
const controlOf = (options: WorkflowWriteControllerUnitOptions): SupervisionControl["Service"] => ({
  startSupervision: (input: SupervisionStartInput, evidence: {runId: string}, cancel?: Deferred.Deferred<void>) => options.starts
    ? signalled(cancel, (signal) => options.starts!.start(input, evidence as WorkflowEvidenceMatch, signal))
    : Effect.succeed<SupervisionStartResult>({status: "unavailable", reason: "supervision_start_unavailable"}),
  stopSupervision: (input: SupervisionStopInput, evidence: unknown, cancel?: Deferred.Deferred<void>) => options.stops
    ? signalled(cancel, (signal) => options.stops!.stop(input, evidence as WorkflowEvidenceMatch, signal))
    : Effect.succeed<SupervisionStopResult>({status: "unavailable", reason: "supervision_stop_unavailable"}),
}) as unknown as SupervisionControl["Service"];

// the write controller over its own admission gate, whose guard is the unit's scope predicates, and the stores of its options;
// without a team option it runs without team authority, as the baseline controller did
export const workflowWriteControllerUnit = (options: WorkflowWriteControllerUnitOptions): WorkflowWriteControllerUnit => {
  const scope = new UnitScope(options);
  const gate = Effect.runSync(makeSupervisionGate(scope));
  const native = nativeAccess(options.native);
  const stores = SupervisionStores.of({supervisors: options.supervisors, requests: new SupervisorConversationStore(options.supervisors.store),
    monitor: new ProjectSupervisorMonitorStore(options.supervisors.store), team: options.team ?? new SupervisorTeamStore(options.supervisors),
    workflows: options.workflows});
  const service = Effect.runSync(WorkflowWriteController.make({...(options.team ? {} : {withoutTeam: true}),
    ...(options.maxEvidenceWaitMs !== undefined ? {maxEvidenceWaitMs: options.maxEvidenceWaitMs} : {})}).pipe(
    (effect) => options.starts || options.stops ? Effect.provideService(effect, SupervisionControl, controlOf(options)) : effect,
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(WorkflowNativeAccess, native),
    Effect.provideService(SupervisionStores, stores),
    Effect.provideService(SupervisionScopeService, scope),
    (effect) => options.loadDefinitions ? Effect.provideService(effect, ProjectDefinitions, definitionsOf(options.loadDefinitions)) : effect,
    (effect) => options.contextViews ? Effect.provideService(effect, SupervisorConversation, contextViewsOf(options.contextViews)) : effect,
  ));
  const unit = Object.assign(workflowWriteControllerFacade(run, service), {options});
  units.set(unit, {service, gate, native, stores});
  return unit;
};

// the team controller over the write unit's gate and native reads, its helper receipts read through a receipt-only helper
// transport on the same store, and the promise rpc (or none) as the operate client
export const supervisorTeamControllerUnit = (workflows: WorkflowWriteControllerUnit, team: SupervisorTeamStore, rpc: SupervisorRpc | null,
  requests?: SupervisorConversationStore): SupervisorTeamControllerUnit => {
  const unit = units.get(workflows);
  if (!unit) throw new Error("not a workflow write controller unit");
  const store = workflows.options.supervisors;
  const transport = build(HelperTransport.make({store, baseUrl: "http://unused.invalid"}).pipe(
    Effect.provideService(SupervisionGate, unit.gate),
    Effect.provideService(T3Client, projectionClient((threadId, signal) => workflows.options.native.projection(threadId, signal))),
    Effect.provide(FetchHttpClient.layer),
  ));
  const service = build(SupervisorTeamController.make(
    workflows.options.helperProviderInstanceId ? {helperProviderInstanceId: workflows.options.helperProviderInstanceId} : {}).pipe(
    Effect.provideService(SupervisionStores, SupervisionStores.of({...unit.stores, team, ...(requests ? {requests} : {})})),
    Effect.provideService(WorkflowWriteController, unit.service),
    Effect.provideService(WorkflowNativeAccess, unit.native),
    Effect.provideService(SupervisionGate, unit.gate),
    Effect.provideService(HelperTransport, transport),
    (effect) => rpc ? Effect.provideService(effect, NativeOperateRpc, operateClient(rpc)) : effect,
  ));
  const facade = supervisorTeamControllerFacade(run, service);
  const clocked = (now: number) => supervisorTeamControllerFacade((effect) => Effect.runPromise(Effect.provideService(effect, Clock.Clock, clockAt(now))), service);
  return Object.assign(supervisorTeamControllerFacade(run, service), {
    workflows,
    reconcile: (binding: BindingRecord, signal: AbortSignal, now?: number) => (now === undefined ? facade : clocked(now)).reconcile(binding, signal),
  });
};
