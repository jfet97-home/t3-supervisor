import { SupervisorTeamController } from "./supervisor-team-controller.js";
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { GuidanceStore } from "./guidance-store.js";
import { GuidanceRuntime } from "./guidance.js";
import { GuidanceUi } from "./guidance-ui.js";
import type { T3ClientShape } from "./t3.js";
import type { SupervisorConfig } from "./types.js";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { cancelOnAbort } from "./native-envelope.js";
import type { NativeTransport } from "./supervisor.js";
import { ProjectCommitter, ProjectFiles, ProjectWriter } from "./project-files.js";
import { ProjectDefinitions } from "./project-definitions.js";
import { ProjectConfigEditorService } from "./project-config-editor.js";
import { existsSync } from "node:fs";
import { ProjectSupervisorStore, loadSupervisorOwnership } from "./project-supervisor-store.js";
import { ProjectSupervisor } from "./project-supervisor.js";
import { NativeOperateRpc, NativeRpc, NativeShell } from "./supervisor-native.js";
import { HelperTransport, type SupervisorHelperDeliveryTransport } from "./supervisor-helper-transport.js";
import { SupervisorTeamRuntime, type SupervisorTeamRuntimeFacade } from "./supervisor-team-runtime.js";
import { SupervisorTeamStore } from "./supervisor-team-store.js";
import { SupervisorConversationStore } from "./supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "./supervisor-monitor-store.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService } from "./supervision-gate.js";
import { SupervisionControl } from "./supervision-control.js";
import { ScopeLocks } from "./scope-locks.js";
import { Store, type StoreShape } from "./store.js";
import { SupervisionStores } from "./supervision-stores.js";
import { SupervisorConversation, type SupervisorConversationFacade } from "./supervisor-conversation.js";
import { SupervisorLifecycle, type SupervisorLifecycleFacade } from "./supervisor-lifecycle.js";
import { WorkflowStateStore } from "./workflow-state-store.js";
import { SupervisorIds } from "./ids.js";
import { T3Client } from "./t3.js";
import { GitProbe } from "./git-probe.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "./workflow-write-controller.js";
import { WorkflowMcp } from "./workflow-mcp.js";
import { ServiceAuth } from "./service-auth.js";

// the promise runner the remaining b-03 facades of the test seams take; an aborted signal interrupts the run
export type RootRun = <A, E>(effect: Effect.Effect<A, E>, options?: {readonly signal?: AbortSignal}) => Promise<A>;
// a call's AbortSignal is the service's cancel trigger for the lifetime of that call, as for the native rpc facade
const cancelled = <A>(run: RootRun, signal: AbortSignal, call: (cancel: Deferred.Deferred<void>) => Effect.Effect<A>): Promise<A> =>
  run(Effect.scoped(Effect.flatMap(cancelOnAbort(signal), call)));
// b-03 (plan 3.9): the baseline promise shapes of the helper transport; its receipt reads stay synchronous b-02 reads
export const helperTransportFacade = (run: RootRun, transport: HelperTransport["Service"]): SupervisorHelperDeliveryTransport => ({
  send: (binding, input, signal, authorized) =>
    cancelled(run, signal, (cancel) => transport.send(binding, input, {cancel, ...(authorized ? {authorized: () => authorized()} : {})})),
  hasDelivery: (binding, input) => Effect.runSync(transport.hasDelivery(binding, input)),
  reconcileDelivery: (binding, input, signal) => cancelled(run, signal, (cancel) => transport.reconcileDelivery(binding, input, cancel)),
  receiptText: (binding, logicalMessageId) => Effect.runSync(transport.receiptText(binding, logicalMessageId)),
  matchesMessage: (binding, logicalMessageId, text, message, messages) => Effect.runSync(transport.matchesMessage(binding, logicalMessageId, text, message, messages)),
  retire: (binding, helperThreadId, signal) => cancelled(run, signal, (cancel) => transport.retire(binding, helperThreadId, cancel)),
});
// b-03 (plan 3.9): the baseline promise shapes of the team runtime; t-04 keeps its cycle start and b-02 reads synchronous
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
// b-03 (plan 3.9): the baseline promise shapes of the conversation for ProjectSupervisor, SupervisionControl and the workflow
// controller; t-03 keeps its status, retry, role and fence calls synchronous
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
// b-03 (plan 3.9): the baseline promise shapes of the lifecycle for ProjectSupervisor
export const supervisorLifecycleFacade = (run: RootRun, lifecycle: SupervisorLifecycle["Service"]): SupervisorLifecycleFacade => ({
  readMain: (binding, signal) => resultCall(run, signal, lifecycle.readMain(binding)),
  check: (input, threads, signal, now) => settleCall(run, signal, atWallClock(now)(lifecycle.check(input, threads))),
  parkInactive: (input, signal, stillInactive) => settleCall(run, signal, lifecycle.parkInactive(input, stillInactive)),
});
// i-01/i-02 (plan 3.9): the helper transport, the team runtime, the conversation and the lifecycle of one supervision run, built
// once over one record of the interim stores and the supervisor's scope predicates, with the run's admission gate, as the
// context of the services above them
export const supervisorTeamServices = (store: ProjectSupervisorStore, baseUrl: string, scope: SupervisionScope) => Effect.gen(function* () {
  const transport = yield* HelperTransport.make({store, baseUrl});
  const workflowStates = new WorkflowStateStore(store, (projectId, mainThreadId) => scope.workflowEditingEnabled(projectId, mainThreadId));
  const stores = SupervisionStores.of({supervisors: store, requests: new SupervisorConversationStore(store.store), monitor: new ProjectSupervisorMonitorStore(store.store),
    team: new SupervisorTeamStore(store), workflows: workflowStates});
  const runtime = yield* SupervisorTeamRuntime.make({store, teamStore: stores.team, requests: stores.requests, monitor: stores.monitor})
    .pipe(Effect.provideService(HelperTransport, transport));
  const conversation = yield* SupervisorConversation.make.pipe(Effect.provideService(SupervisionStores, stores),
    Effect.provideService(SupervisionScopeService, scope), Effect.provideService(SupervisorTeamRuntime, runtime));
  const lifecycle = yield* SupervisorLifecycle.make.pipe(Effect.provideService(SupervisionStores, stores),
    Effect.provideService(SupervisorConversation, conversation), Effect.provideService(SupervisorTeamRuntime, runtime));
  return Context.make(SupervisionStores, stores).pipe(Context.add(SupervisionScopeService, scope), Context.add(SupervisionGate, yield* SupervisionGate),
    Context.add(HelperTransport, transport), Context.add(SupervisorTeamRuntime, runtime), Context.add(SupervisorConversation, conversation),
    Context.add(SupervisorLifecycle, lifecycle));
});

// the Start/Stop control and the workflow write and team controllers of the supervision run, built once over its services
export const supervisorWorkflowControllers = (helperProviderInstanceId: string | undefined) => Effect.gen(function* () {
  const control = yield* SupervisionControl.make;
  const writes = yield* WorkflowWriteController.make().pipe(Effect.provideService(SupervisionControl, control));
  const team = yield* SupervisorTeamController.make(helperProviderInstanceId ? {helperProviderInstanceId} : {}).pipe(
    Effect.provideService(WorkflowWriteController, writes));
  return Context.make(SupervisionControl, control).pipe(Context.add(WorkflowWriteController, writes), Context.add(SupervisorTeamController, team));
});

export const runGuidanceApplication = (
  config: SupervisorConfig,
  source: StoreShape,
  t3: T3ClientShape,
  onReady: () => void = () => {},
) =>
  Effect.gen(function* () {
    const store = yield* Effect.acquireRelease(
      Effect.sync(() => new GuidanceStore(config.dataDirectory)),
      (store) => Effect.sync(() => store.close()),
    );
    const guidanceRuntime = yield* GuidanceRuntime.make(config, store, source);
    const descriptor = yield* t3.descriptor();
    yield* guidanceRuntime.recordDescriptor(descriptor);
    store.bind(descriptor.environmentId);
    const readToken = yield* Effect.tryPromise(() => readFile(config.t3TokenFile, "utf8"));
    const writePath = config.projectWriteTokenFile;
    const writeToken = writePath && existsSync(writePath) ? yield* Effect.tryPromise(() => readFile(writePath, "utf8")) : "";
    const commitPath = config.projectCommitTokenFile;
    const commitToken = commitPath && existsSync(commitPath) ? yield* Effect.tryPromise(() => readFile(commitPath, "utf8")) : "";
    const probePath = config.gitProbeTokenFile;
    const probeToken = probePath && existsSync(probePath) ? yield* Effect.tryPromise(() => readFile(probePath, "utf8")) : "";
    // the native file, writer, commit, probe and rpc clients run on the root native transport (one envelope, crypto and fetch
    // client per process, d-08); the probe draws its ids from the platform crypto
    const nativeClients = yield* Effect.context<NativeTransport>();
    const endpoint = (token: string) => ({baseUrl: config.t3Url, token});
    const gitProbe = probeToken.trim() ? yield* Effect.provide(GitProbe.make(endpoint(probeToken.trim()), store), nativeClients) : undefined;
    const cleanupGitProbe = gitProbe ? gitProbe.cleanup.pipe(
      Effect.catch(() => Effect.sync(() => console.log(JSON.stringify({event: "native_git_probe_cleanup_unavailable"})))),
    ) : Effect.void;
    yield* Effect.acquireRelease(Effect.succeed(gitProbe), () => cleanupGitProbe);
    yield* cleanupGitProbe;
    const owned = config.supervisorOwnedThreadIds ??= loadSupervisorOwnership(config.dataDirectory);
    const supervisionStore = new ProjectSupervisorStore(store, owned);
    const projectWriter = writeToken.trim() ? yield* Effect.provide(ProjectWriter.make(endpoint(writeToken.trim())), nativeClients) : undefined;
    const commitWriter = commitToken.trim() ? yield* Effect.provide(ProjectCommitter.make(endpoint(commitToken.trim())), nativeClients) : undefined;
    const setupWriter = projectWriter ? {
      writeFile: projectWriter.writeFile,
      ...(commitWriter ? {commitFiles: commitWriter.commitFiles} : {}),
    } : undefined;
    const managedScratchRoot = config.managedScratchRoot && posix.isAbsolute(config.managedScratchRoot) ? posix.normalize(config.managedScratchRoot) : null;
    // the definitions and the config editor are built once in the supervision run scope
    const definitionsService = yield* ProjectDefinitions.make({source, t3, files: yield* Effect.provide(ProjectFiles.make(endpoint(readToken.trim())), nativeClients), options: {
      globalRoot: "~",
      useGlobalDefinitions: () => supervisionStore.useGlobalDefinitions(),
      isScratchProject: (projectId, workspaceRoot) => {
        const classification = store.classification(projectId);
        if (classification !== "unclassified") return classification === "scratch";
        return managedScratchRoot !== null && posix.normalize(workspaceRoot) === managedScratchRoot;
      },
      ...(setupWriter ? {setupWriter} : {}),
      ...(gitProbe ? {gitProbe: gitProbe.probe} : {}),
    }});
    const editor = projectWriter ? yield* ProjectConfigEditorService.make({definitions: definitionsService, writer: projectWriter,
      onSaved: (snapshot, expectedRevision) => supervisionStore.recordDefinitionUserSave(snapshot, expectedRevision)}) : undefined;
    const operateToken = config.guidanceTokenFile && existsSync(config.guidanceTokenFile) ? yield* Effect.tryPromise(() => readFile(config.guidanceTokenFile!, "utf8")) : "";
    // one native client per credential and the shell reads on the read client
    const nativeClient = (token: string) => NativeRpc.make(endpoint(token)).pipe(Effect.provide(nativeClients));
    const nativeRead = yield* nativeClient(readToken.trim());
    const nativeShell = yield* NativeShell.make({baseUrl: config.t3Url, token: readToken.trim()}).pipe(
      Effect.provideService(NativeRpc, nativeRead), Effect.provide(nativeClients));
    const nativeOperate = operateToken.trim() ? yield* nativeClient(operateToken.trim()) : null;
    // the supervisor's scope predicates, which the admission gate guards with
    const supervisionScope = new SupervisionScope(config, supervisionStore, Boolean(nativeOperate));
    // the services of the supervision run, built once in this scope over the native clients, the catalog, the definitions, the
    // per-scope locks and the ids: the team services with the admission gate, the Start/Stop control and the workflow
    // controllers, then the project supervisor
    const locksAndIds = yield* Layer.build(Layer.mergeAll(ScopeLocks.layer, SupervisorIds.layer)).pipe(Effect.provide(nativeClients));
    const clients = Context.merge(nativeClients, locksAndIds).pipe(Context.add(NativeRpc, nativeRead), Context.add(NativeShell, nativeShell),
      Context.add(Store, source), Context.add(T3Client, t3), Context.add(ProjectDefinitions, definitionsService));
    const runClients = nativeOperate ? Context.add(clients, NativeOperateRpc, nativeOperate) : clients;
    const teamServices = yield* supervisorTeamServices(supervisionStore, config.t3Url, supervisionScope).pipe(
      Effect.provideServiceEffect(SupervisionGate, makeSupervisionGate(supervisionScope)), Effect.provide(runClients));
    const runServices = Context.merge(runClients, teamServices);
    // the write and team controllers read workflow proof and scope on the read credential
    const controllers = yield* supervisorWorkflowControllers(config.helperProviderInstanceId).pipe(
      Effect.provideServiceEffect(WorkflowNativeAccess, WorkflowNativeAccess.make), Effect.provide(runServices));
    const supervision = yield* ProjectSupervisor.make().pipe(Effect.provide(Context.merge(runServices, controllers)));
    // the dashboard's access client, runtime and workflow MCP endpoint over the run's controllers, provided once in this scope;
    // the listeners are acquired after them and released before them, and the api handlers yield the run's services
    yield* Layer.build(GuidanceUi.layer(config, {definitions: definitionsService, editor, supervision: {supervisor: supervision,
      control: Context.get(controllers, SupervisionControl)}, workflowReader: Context.get(controllers, WorkflowWriteController)}).pipe(
      Layer.provide(Layer.mergeAll(ServiceAuth.layer(config.dataDirectory), Layer.succeed(GuidanceRuntime, guidanceRuntime), WorkflowMcp.layer)),
      Layer.provide(Layer.succeedContext(controllers))));
    yield* Effect.sync(onReady);
    // one supervision cycle at a time, each bounded to 120 s and followed by a 5 s pause; any failure but an interruption is
    // reported by its event alone
    const interpretation = supervision.cycle.pipe(
      Effect.timeout("120 seconds"),
      Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.sync(() => console.log(JSON.stringify({event: "task_interpretation_unavailable"})))),
      Effect.andThen(Effect.sleep("5 seconds")), Effect.forever,
    );
    yield* Effect.forkScoped(interpretation);
    // each cycle publishes the descriptor before binding and pruning; any failure but an interruption marks the runtime unavailable
    const cycle = t3.descriptor().pipe(
      Effect.tap(guidanceRuntime.recordDescriptor),
      Effect.tap(next => Effect.sync(() => {
        store.bind(next.environmentId);
        store.prune();
      })),
      Effect.andThen(guidanceRuntime.markActive),
      Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : guidanceRuntime.markUnavailable),
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
    );
    yield* cycle;
  });
