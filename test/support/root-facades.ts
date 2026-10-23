import { Deferred, Effect } from "effect";
import { cancelOnAbort } from "../../src/native-envelope.js";
import type { ProjectConfigEditorService } from "../../src/project-config-editor.js";
import type { ProjectConfigSave, ProjectConfigSaveOutcome, ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import {
  ProjectDefinitions, type DefinitionCheckoutTarget, type DefinitionCheckoutUnavailable, type DefinitionPresence, type DefinitionSourceFailure,
  type GlobalDefinitionPresence, type ProjectDefinitionGlobalSetupOutcome, type ProjectDefinitionSetupInput, type ProjectDefinitionSetupOutcome,
} from "../../src/project-definitions.js";
import type { BindingRecord } from "../../src/project-supervisor-store.js";
import type { SupervisorTeamController } from "../../src/supervisor-team-controller.js";
import type {
  SupervisionStartResult, SupervisionStopResult, SupervisorContextViewResult, WorkflowReadResult, WorkflowWriteController,
  WorkflowWriteResult,
} from "../../src/workflow-write-controller.js";

// the baseline promise call shapes and the b-03 facades over the definitions, the config editor and the workflow controllers
// (plan 3.9), which src built in its composition root for its unported callers until s6c; the suites written against those
// shapes still call the services through them here (test harness only: a facade runs its effect on its own fiber)

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
