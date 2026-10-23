import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { cancelOnAbort } from "../../src/native-envelope.js";
import type { ProjectConfigEditorService } from "../../src/project-config-editor.js";
import type { ProjectConfigSave, ProjectConfigSaveOutcome, ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import {
  ProjectDefinitions, type DefinitionCheckoutTarget, type DefinitionCheckoutUnavailable, type DefinitionPresence, type DefinitionSourceFailure,
  type GlobalDefinitionPresence, type ProjectDefinitionGlobalSetupOutcome, type ProjectDefinitionSetupInput, type ProjectDefinitionSetupOutcome,
} from "../../src/project-definitions.js";
import type { SupervisorMonitoringStatus } from "../../src/project-supervisor-contract.js";
import type { BindingRecord, ProjectSupervisorStore } from "../../src/project-supervisor-store.js";
import type { SupervisionScope } from "../../src/supervision-gate.js";
import { SupervisionControllersLive, SupervisionTeamLive } from "../../src/supervision-live.js";
import type { SupervisionStores } from "../../src/supervision-stores.js";
import type { SupervisorConversation } from "../../src/supervisor-conversation.js";
import type { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import type { HelperTransport, InvalidReceipt, SupervisorHelperMessage, SupervisorHelperSendResult } from "../../src/supervisor-helper-transport.js";
import type { SupervisorLifecycle } from "../../src/supervisor-lifecycle.js";
import type { SupervisorMonitorBatch } from "../../src/supervisor-monitor.js";
import type { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import type { SupervisorTeamController } from "../../src/supervisor-team-controller.js";
import type { SupervisorTeamHelperBatch, SupervisorTeamPartition, SupervisorTeamRuntime } from "../../src/supervisor-team-runtime.js";
import type { MessageInfo, Projection, ThreadInfo } from "../../src/types.js";
import type {
  SupervisionStartResult, SupervisionStopResult, SupervisorContextViewInput, SupervisorContextViewResult, WorkflowReadResult, WorkflowWriteController,
  WorkflowWriteResult,
} from "../../src/workflow-write-controller.js";

// the baseline promise call shapes and the b-03 facades over the ported services (plan 3.9), which src built in its composition
// root for its unported callers until s6c; the suites written against those shapes still call the services through them here
// (test harness only: a facade runs its effect on its own fiber)

// the promise runner a facade calls; an aborted signal interrupts the run
export type RootRun = <A, E>(effect: Effect.Effect<A, E>, options?: {readonly signal?: AbortSignal}) => Promise<A>;

// the baseline promise shape of the definitions
export interface ProjectDefinitionLoader {
  globalHomePath(): string;
  globalDefinitionsPath(): string;
  currentWorkspace(projectId: string, threadId: string | null, signal: AbortSignal): Promise<string | null>;
  presenceGlobal(signal: AbortSignal): Promise<GlobalDefinitionPresence>;
  presence(projectId: string, signal: AbortSignal): Promise<DefinitionPresence>;
  presenceForCheckout(projectId: string, threadId: string | null, signal: AbortSignal): Promise<DefinitionPresence>;
  globalFingerprint(signal: AbortSignal): Promise<string | null>;
  checkoutTargets(projectId: string, signal: AbortSignal): Promise<DefinitionCheckoutTarget[]>;
  initializeGlobal(signal: AbortSignal): Promise<ProjectDefinitionGlobalSetupOutcome>;
  initialize(projectId: string, threadId: string | null, input: ProjectDefinitionSetupInput, signal: AbortSignal): Promise<ProjectDefinitionSetupOutcome>;
  load(projectId: string, threadId?: string | null, parentSignal?: AbortSignal): Promise<ProjectDefinitionSnapshot>;
}
// the baseline promise shape of the config editor
export interface ProjectConfigEditor {
  save(input: ProjectConfigSave, parentSignal?: AbortSignal): Promise<ProjectConfigSaveOutcome>;
}
// the baseline promise shapes of the helper transport; its receipt reads stay synchronous
export interface SupervisorHelperDeliveryTransport {
  send(binding: BindingRecord, input: SupervisorHelperMessage, signal: AbortSignal, authorized?: () => boolean): Promise<SupervisorHelperSendResult>;
  hasDelivery(binding: BindingRecord, input: SupervisorHelperMessage): boolean;
  reconcileDelivery(binding: BindingRecord, input: SupervisorHelperMessage, signal: AbortSignal): Promise<"absent" | SupervisorHelperSendResult>;
  receiptText(binding: BindingRecord, logicalMessageId: string): string | null | InvalidReceipt;
  matchesMessage(binding: BindingRecord, logicalMessageId: string, text: string, message: MessageInfo, messages: readonly MessageInfo[]): boolean;
  retire(binding: BindingRecord, helperThreadId: string, signal: AbortSignal): Promise<boolean>;
}
// the baseline promise shapes of the team runtime: the synchronous reads and in-memory cycle start stay synchronous, the
// reconciliations take the caller's AbortSignal
export interface SupervisorTeamRuntimeFacade {
  startCycle(binding: BindingRecord): void;
  rootOwnedBatch(binding: BindingRecord, batch: SupervisorMonitorBatch, threads: readonly ThreadInfo[]): SupervisorMonitorBatch | null;
  partition(binding: BindingRecord, threads: readonly ThreadInfo[], batch: SupervisorMonitorBatch | null): SupervisorTeamPartition;
  hasMembers(binding: BindingRecord): boolean;
  coordinatorPolicy(binding: BindingRecord): {maxHelpersPerRoot: number; readyHelpers: number; registeringHelpers: number};
  acknowledgeRootEvents(binding: BindingRecord, eventIds: readonly string[]): void;
  hasInflightEffects(binding: BindingRecord): boolean;
  hasBlockingWork(binding: BindingRecord): boolean;
  reconcileStopped(binding: BindingRecord, threads: readonly ThreadInfo[], signal: AbortSignal): Promise<void>;
  reconcile(binding: BindingRecord, threads: readonly ThreadInfo[], signal: AbortSignal): Promise<void>;
  runHelperBatch(binding: BindingRecord, threads: readonly ThreadInfo[], batches: readonly SupervisorTeamHelperBatch[], signal: AbortSignal): Promise<void>;
}
// the baseline promise shapes of the conversation: an aborted call interrupts its work; `now` stamps that call's wall clock as
// the baseline parameter did
export interface SupervisorConversationFacade {
  readonly requests: SupervisorConversationStore;
  readonly monitor: ProjectSupervisorMonitorStore;
  readonly teamRuntime: SupervisorTeamRuntimeFacade | null;
  run(binding: BindingRecord, supervisor: Projection, threads: readonly ThreadInfo[], signal: AbortSignal): Promise<void>;
  observe(threads: readonly ThreadInfo[], signal: AbortSignal, now?: number): Promise<void>;
  reconcileStopNotice(owner: BindingRecord, signal: AbortSignal): Promise<void>;
  reconcileStopped(binding: BindingRecord, threads: readonly ThreadInfo[], signal: AbortSignal, supervisor?: Projection): Promise<void>;
  readContextView(binding: BindingRecord, input: SupervisorContextViewInput, signal: AbortSignal): Promise<SupervisorContextViewResult>;
  status(projectId: string, supervisorThreadId: string | null): SupervisorMonitoringStatus;
  hasInflight(projectId: string, supervisorThreadId: string): boolean;
  interpretationRole(binding: BindingRecord): {text: string; roleVersion: string} | null;
  roleDelivered(supervisorThreadId: string, roleVersion: string): void;
  retry(projectId: string, supervisorThreadId: string): void;
  fenceStoppedSupervision(binding: BindingRecord): void;
}
// the baseline promise shapes of the lifecycle: an aborted call interrupts its work; `now` stamps that call's wall clock
export interface SupervisorLifecycleFacade {
  readMain(binding: BindingRecord, signal: AbortSignal): Promise<Projection | null>;
  check(input: BindingRecord, threads: readonly ThreadInfo[], signal: AbortSignal, now?: number): Promise<void>;
  parkInactive(input: BindingRecord, signal: AbortSignal, stillInactive: () => boolean): Promise<void>;
}
// the baseline promise call shapes of the write controller; a call's signal is its cancel, else the tool's own 10 s applies
export interface WorkflowWriteControllerPromises {
  read(input: unknown, signal?: AbortSignal): Promise<WorkflowReadResult>;
  readTool(input: unknown, signal?: AbortSignal): Promise<WorkflowReadResult | SupervisorContextViewResult>;
  write(input: unknown, signal?: AbortSignal): Promise<WorkflowWriteResult>;
  startSupervision(input: unknown, signal?: AbortSignal): Promise<SupervisionStartResult>;
  stopSupervision(input: unknown, signal?: AbortSignal): Promise<SupervisionStopResult>;
}
// the baseline promise call shapes of the team controller
export interface SupervisorTeamControllerPromises {
  call(input: unknown, signal: AbortSignal): Promise<unknown>;
  guide(input: unknown, signal: AbortSignal): Promise<unknown>;
  reconcile(binding: BindingRecord, signal: AbortSignal): Promise<void>;
  reconcileStopped(binding: BindingRecord, signal: AbortSignal): Promise<void>;
}

// a failed definitions call rejects with its baseline value: the native, catalog or projection error itself, or the fixed checkout reason
const definitionsRejection = (failure: DefinitionSourceFailure | DefinitionCheckoutUnavailable): unknown =>
  failure._tag === "DefinitionSourceFailure" ? failure.error : new Error(failure.reason);
// the baseline promise call shapes over the definitions service; a call's signal is the service's own cancel signal, so a
// cancelled call settles with its baseline outcome
export const projectDefinitionsFacade = (run: RootRun, definitions: ProjectDefinitions["Service"]): ProjectDefinitionLoader => {
  const settle = <A>(effect: Effect.Effect<A, DefinitionSourceFailure | DefinitionCheckoutUnavailable>) => run(Effect.mapError(effect, definitionsRejection));
  return {
    globalHomePath: () => definitions.globalHomePath,
    globalDefinitionsPath: () => definitions.globalDefinitionsPath,
    currentWorkspace: (projectId, threadId, signal) => settle(definitions.currentWorkspace(projectId, threadId, signal)),
    presenceGlobal: signal => run(definitions.presenceGlobal(signal)),
    presence: (projectId, signal) => run(definitions.presence(projectId, signal)),
    presenceForCheckout: (projectId, threadId, signal) => run(definitions.presenceForCheckout(projectId, threadId, signal)),
    globalFingerprint: signal => run(definitions.globalFingerprint(signal)),
    checkoutTargets: (projectId, signal) => settle(definitions.checkoutTargets(projectId, signal)),
    initializeGlobal: signal => settle(definitions.initializeGlobal(signal)),
    initialize: (projectId, threadId, input, signal) => settle(definitions.initialize(projectId, threadId, input, signal)),
    load: (projectId, threadId = null, signal) => run(definitions.load(projectId, threadId, signal)),
  };
};
// the baseline promise call shape over the config editor service
export const projectConfigEditorFacade = (run: RootRun, editor: ProjectConfigEditorService["Service"]): ProjectConfigEditor => ({
  save: (input, signal) => run(Effect.mapError(editor.save(input, signal), definitionsRejection)),
});

// a definitions loader as the definitions service, read through the loader when called: the read's signal aborts when its
// caller is interrupted, a rejected read is a defect, as the baseline rejection it replaces, and a loader without a global
// fingerprint reads none; no other definitions operation is used
export type DefinitionsLoader = Pick<ProjectDefinitionLoader, "load"> & Partial<Pick<ProjectDefinitionLoader, "globalFingerprint">>;
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
// a promise editor's save as the editor service, on the same terms
export const promiseEditorService = (editor: ProjectConfigEditor): ProjectConfigEditorService["Service"] => ({
  save: (input) => Effect.promise((signal) => editor.save(input, signal)),
});

// a call's AbortSignal is the service's cancel trigger for the lifetime of that call, as for the native rpc facade
const cancelled = <A>(run: RootRun, signal: AbortSignal, call: (cancel: Deferred.Deferred<void>) => Effect.Effect<A>): Promise<A> =>
  run(Effect.scoped(Effect.flatMap(cancelOnAbort(signal), call)));
// the baseline promise shapes of the helper transport; its receipt reads stay synchronous b-02 reads
export const helperTransportFacade = (run: RootRun, transport: HelperTransport["Service"]): SupervisorHelperDeliveryTransport => ({
  send: (binding, input, signal, authorized) =>
    cancelled(run, signal, (cancel) => transport.send(binding, input, {cancel, ...(authorized ? {authorized: () => authorized()} : {})})),
  hasDelivery: (binding, input) => Effect.runSync(transport.hasDelivery(binding, input)),
  reconcileDelivery: (binding, input, signal) => cancelled(run, signal, (cancel) => transport.reconcileDelivery(binding, input, cancel)),
  receiptText: (binding, logicalMessageId) => Effect.runSync(transport.receiptText(binding, logicalMessageId)),
  matchesMessage: (binding, logicalMessageId, text, message, messages) => Effect.runSync(transport.matchesMessage(binding, logicalMessageId, text, message, messages)),
  retire: (binding, helperThreadId, signal) => cancelled(run, signal, (cancel) => transport.retire(binding, helperThreadId, cancel)),
});
// the baseline promise shapes of the team runtime; its cycle start and b-02 reads stay synchronous
export const teamRuntimeFacade = (run: RootRun, runtime: SupervisorTeamRuntime["Service"]): SupervisorTeamRuntimeFacade => ({
  startCycle: (binding) => Effect.runSync(runtime.startCycle(binding)),
  rootOwnedBatch: (binding, batch, threads) => Effect.runSync(runtime.rootOwnedBatch(binding, batch, threads)),
  partition: (binding, threads, batch) => Effect.runSync(runtime.partition(binding, threads, batch)),
  hasMembers: (binding) => Effect.runSync(runtime.hasMembers(binding)),
  coordinatorPolicy: (binding) => Effect.runSync(runtime.coordinatorPolicy(binding)),
  acknowledgeRootEvents: (binding, eventIds) => Effect.runSync(runtime.acknowledgeRootEvents(binding, eventIds)),
  hasInflightEffects: (binding) => Effect.runSync(runtime.hasInflightEffects(binding)),
  hasBlockingWork: (binding) => Effect.runSync(runtime.hasBlockingWork(binding)),
  reconcileStopped: (binding, threads, signal) => cancelled(run, signal, (cancel) => runtime.reconcileStopped(binding, threads, cancel)),
  reconcile: (binding, threads, signal) => cancelled(run, signal, (cancel) => runtime.reconcile(binding, threads, cancel)),
  runHelperBatch: (binding, threads, batches, signal) => cancelled(run, signal, (cancel) => runtime.runHelperBatch(binding, threads, batches, cancel)),
});
// a call's work runs on its own fiber that an abort of the call's signal interrupts; the exit is taken once the work has ended
const interruptOnAbort = <A, E>(signal: AbortSignal, work: Effect.Effect<A, E>): Effect.Effect<Exit.Exit<A, E>> => Effect.scoped(Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(work);
  const cancel = yield* cancelOnAbort(signal);
  yield* Effect.forkScoped(Effect.andThen(Deferred.await(cancel), Fiber.interrupt(fiber)));
  return yield* Fiber.await(fiber);
}));
// an aborted call without a result settles as the baseline aborted call did, once its work has ended
const settleCall = (run: RootRun, signal: AbortSignal, work: Effect.Effect<void, unknown>): Promise<void> =>
  run(Effect.flatMap(interruptOnAbort(signal, work), (exit) =>
    Exit.isSuccess(exit) || signal.aborted && Cause.hasInterruptsOnly(exit.cause) ? Effect.void : Effect.failCause(exit.cause)));
// a call with a result rejects when aborted
const resultCall = <A>(run: RootRun, signal: AbortSignal, work: Effect.Effect<A, unknown>): Promise<A> =>
  run(Effect.flatMap(interruptOnAbort(signal, work), (exit) => Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)));
// the baseline `now` parameter: the call's wall clock reads that time; elapsed time and sleeps stay on the current clock
const atWallClock = (now: number | undefined) => <A, E>(work: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  now === undefined ? work : Effect.clockWith((clock) => Effect.provideService(work, Clock.Clock, {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.succeed(now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) => clock.sleep(duration),
  }));
// the baseline promise shapes of the conversation; its status, retry, role and fence calls stay synchronous
export const supervisorConversationFacade = (run: RootRun, conversation: SupervisorConversation["Service"], stores: SupervisionStores["Service"],
  teamRuntime: SupervisorTeamRuntimeFacade | null): SupervisorConversationFacade => ({
  requests: stores.requests,
  monitor: stores.monitor,
  teamRuntime,
  run: (binding, supervisor, threads, signal) => settleCall(run, signal, conversation.run(binding, supervisor, threads)),
  observe: (threads, signal, now) => settleCall(run, signal, atWallClock(now)(conversation.observe(threads))),
  reconcileStopNotice: (owner, signal) => settleCall(run, signal, conversation.reconcileStopNotice(owner)),
  reconcileStopped: (binding, threads, signal, supervisor) => settleCall(run, signal, conversation.reconcileStopped(binding, threads, supervisor)),
  readContextView: (binding, input, signal) => resultCall(run, signal, conversation.readContextView(binding, input)),
  status: conversation.status,
  hasInflight: conversation.hasInflight,
  interpretationRole: conversation.interpretationRole,
  roleDelivered: conversation.roleDelivered,
  retry: conversation.retry,
  fenceStoppedSupervision: conversation.fenceStoppedSupervision,
});
// the baseline promise shapes of the lifecycle
export const supervisorLifecycleFacade = (run: RootRun, lifecycle: SupervisorLifecycle["Service"]): SupervisorLifecycleFacade => ({
  readMain: (binding, signal) => resultCall(run, signal, lifecycle.readMain(binding)),
  check: (input, threads, signal, now) => settleCall(run, signal, atWallClock(now)(lifecycle.check(input, threads))),
  parkInactive: (input, signal, stillInactive) => settleCall(run, signal, lifecycle.parkInactive(input, stillInactive)),
});
// the baseline promise shapes of the write controller; a call's signal is its cancel, as the baseline signal stood for its
// deadline, and without one the tool's own 10 s applies
export const workflowWriteControllerFacade = (run: RootRun, controller: WorkflowWriteController["Service"]): WorkflowWriteControllerPromises => {
  const call = <A>(start: (cancel?: Deferred.Deferred<void>) => Effect.Effect<A>, signal: AbortSignal | undefined): Promise<A> =>
    signal ? cancelled(run, signal, start) : run(start());
  return {
    read: (input, signal) => call((cancel) => controller.read(input, cancel), signal),
    readTool: (input, signal) => call((cancel) => controller.readTool(input, cancel), signal),
    write: (input, signal) => call((cancel) => controller.write(input, cancel), signal),
    startSupervision: (input, signal) => call((cancel) => controller.startSupervision(input, cancel), signal),
    stopSupervision: (input, signal) => call((cancel) => controller.stopSupervision(input, cancel), signal),
  };
};
// the baseline promise shapes of the team controller
export const supervisorTeamControllerFacade = (run: RootRun, controller: SupervisorTeamController["Service"]): SupervisorTeamControllerPromises => ({
  call: (input, signal) => cancelled(run, signal, (cancel) => controller.call(input, cancel)),
  // a refusal that escaped the guide rejects the call with its baseline message
  guide: (input, signal) => run(Effect.scoped(Effect.flatMap(cancelOnAbort(signal), (cancel) => controller.guide(input, cancel)))),
  reconcile: (binding, signal) => cancelled(run, signal, (cancel) => controller.reconcile(binding, false, cancel)),
  reconcileStopped: (binding, signal) => cancelled(run, signal, (cancel) => controller.reconcileStopped(binding, cancel)),
});

// the team services of one supervision run as the production graph builds them (src/supervision-live.ts): the interim stores
// over one binding store, the scope predicates and their admission gate, the helper transport, the team runtime, the
// conversation and the lifecycle
export const supervisorTeamServices = (store: ProjectSupervisorStore, baseUrl: string, scope: SupervisionScope) =>
  Layer.build(SupervisionTeamLive({store, scope, baseUrl}));
// the Start/Stop control, the workflow proof reads and the workflow write and team controllers over those services, as the
// production graph builds them
export const supervisorWorkflowControllers = (helperProviderInstanceId: string | undefined) =>
  Layer.build(SupervisionControllersLive({helperProviderInstanceId}));
