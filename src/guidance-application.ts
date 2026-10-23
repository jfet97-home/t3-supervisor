import {SupervisorTeamController} from "./supervisor-team-controller.js";
import { Cause, type Deferred, Effect, Layer } from "effect";
import { GuidanceStore } from "./guidance-store.js";
import { GuidanceRuntime } from "./guidance.js";
import { GuidanceUi } from "./guidance-ui.js";
import type { StoreShape } from "./store.js";
import type { T3ClientShape } from "./t3.js";
import type { SupervisorConfig } from "./types.js";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { cancelOnAbort } from "./native-envelope.js";
import type { NativeTransport } from "./supervisor.js";
import { ProjectCommitter, ProjectFiles, ProjectWriter } from "./project-files.js";
import { ProjectDefinitions, type DefinitionCheckoutUnavailable, type DefinitionSourceFailure, type ProjectDefinitionLoader } from "./project-definitions.js";
import { ProjectConfigEditorService, type ProjectConfigEditor } from "./project-config-editor.js";
import { existsSync } from "node:fs";
import { ProjectSupervisorStore, loadSupervisorOwnership } from "./project-supervisor-store.js";
import { ProjectSupervisor } from "./project-supervisor.js";
import { NativeOperateRpc, NativeRpc, NativeShell, record, type NativeRpcShape, type SupervisorRpc } from "./supervisor-native.js";
import { HelperTransport, type SupervisorHelperDeliveryTransport } from "./supervisor-helper-transport.js";
import { SupervisorTeamRuntime, type SupervisorTeamRuntimeFacade } from "./supervisor-team-runtime.js";
import { SupervisorTeamStore } from "./supervisor-team-store.js";
import { SupervisorConversationStore } from "./supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "./supervisor-monitor-store.js";
import { legacyAdmission, makeSupervisionGate, SupervisionGate, type SupervisionScope } from "./supervision-gate.js";
import { SupervisorIds } from "./ids.js";
import { T3Client } from "./t3.js";
import { GitProbe } from "./git-probe.js";
import { WorkflowWriteController } from "./workflow-write-controller.js";
import { WorkflowMcp } from "./workflow-mcp.js";
import { ServiceAuth } from "./service-auth.js";

// the root context's promise runner (b-01) that the b-03 facades call
export type RootRun = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
// a failed definitions call rejects with its baseline value: the native, catalog or projection error itself, or the fixed checkout reason
const definitionsRejection = (failure: DefinitionSourceFailure | DefinitionCheckoutUnavailable): unknown =>
  failure._tag === "DefinitionSourceFailure" ? failure.error : new Error(failure.reason);
// b-03 (plan 3.9): the baseline promise call shapes over the definitions service; a call's signal is the service's own cancel signal, so a cancelled call settles with its baseline outcome
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
// b-03 (plan 3.9): the baseline promise call shape over the config editor service
export const projectConfigEditorFacade = (run: RootRun, editor: ProjectConfigEditorService["Service"]): ProjectConfigEditor => ({
  save: (input, signal) => run(Effect.mapError(editor.save(input, signal), definitionsRejection)),
});

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
// i-01/i-02 (plan 3.9): the helper transport and the team runtime, built once in the supervision run from its context and
// handed to ProjectSupervisor in the promise shapes of their unported callers, with the legacy admission over the same gate
// (t-07)
export const supervisorTeamServices = (run: RootRun, store: ProjectSupervisorStore, baseUrl: string) => Effect.gen(function* () {
  const transport = yield* HelperTransport.make({store, baseUrl});
  const runtime = yield* SupervisorTeamRuntime.make({store, teamStore: new SupervisorTeamStore(store), requests: new SupervisorConversationStore(store.store),
    monitor: new ProjectSupervisorMonitorStore(store.store)}).pipe(Effect.provideService(HelperTransport, transport));
  return {helperTransport: helperTransportFacade(run, transport), teamRuntime: teamRuntimeFacade(run, runtime),
    admission: legacyAdmission(yield* SupervisionGate, run)};
});

export const runGuidanceApplication = (
  config: SupervisorConfig,
  source: StoreShape,
  t3: T3ClientShape,
  onReady: () => void = () => {},
) =>
  Effect.gen(function* () {
    // the root context, captured once per supervision run, runs root effects for the unported promise callers (B-01)
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
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
    // the definitions and the config editor are built once in the supervision run scope; unported callers receive their b-03 facades
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
    const definitions = projectDefinitionsFacade(run, definitionsService);
    const editor = projectWriter ? projectConfigEditorFacade(run, yield* ProjectConfigEditorService.make({definitions: definitionsService, writer: projectWriter,
      onSaved: (snapshot, expectedRevision) => supervisionStore.recordDefinitionUserSave(snapshot, expectedRevision)})) : undefined;
    const operateToken = config.guidanceTokenFile && existsSync(config.guidanceTokenFile) ? yield* Effect.tryPromise(() => readFile(config.guidanceTokenFile!, "utf8")) : "";
    // b-03: one native client per credential and the shell reads on the read client, handed over in their baseline promise shapes
    const nativeClient = (token: string) => NativeRpc.make(endpoint(token)).pipe(Effect.provide(nativeClients));
    const rpcFacade = (rpc: NativeRpcShape): SupervisorRpc => (tag, payload, signal) =>
      run(Effect.scoped(Effect.flatMap(cancelOnAbort(signal), cancel => rpc.call(tag, payload, cancel))));
    const nativeRead = yield* nativeClient(readToken.trim());
    const nativeShell = yield* NativeShell.make({baseUrl: config.t3Url, token: readToken.trim()}).pipe(
      Effect.provideService(NativeRpc, nativeRead), Effect.provide(nativeClients));
    const readRpc = rpcFacade(nativeRead);
    const nativeOperate = operateToken.trim() ? yield* nativeClient(operateToken.trim()) : null;
    // stand-in until the root builds SupervisionGate and the ids in the supervision scope: the gate guards with the
    // supervisor's own scope predicates once it exists, and refuses before
    let supervisorScope: SupervisionScope | null = null;
    const teamServices = yield* supervisorTeamServices(run, supervisionStore, config.t3Url).pipe(
      (services) => nativeOperate ? Effect.provideService(services, NativeOperateRpc, nativeOperate) : services,
      Effect.provideServiceEffect(SupervisionGate, makeSupervisionGate({
        scopeEnabled: (projectId, mainThreadId, purpose) => supervisorScope?.scopeEnabled(projectId, mainThreadId, purpose) ?? false,
        supervisionStopped: (threadId) => supervisorScope?.supervisionStopped(threadId) ?? true,
        workflowEditingEnabled: (projectId, mainThreadId, purpose) => supervisorScope?.workflowEditingEnabled(projectId, mainThreadId, purpose) ?? false,
      })),
      Effect.provideService(T3Client, t3),
      Effect.provide(SupervisorIds.layer),
      Effect.provide(nativeClients),
    );
    const supervision = new ProjectSupervisor(config, supervisionStore, source, t3, readRpc,
      nativeOperate ? rpcFacade(nativeOperate) : null, signal => run(nativeShell.baseline, {signal}), teamServices, definitions);
    supervisorScope = supervision.gate;
    const workflowReader = new WorkflowWriteController({
      supervisors: supervisionStore,
      ...(config.helperProviderInstanceId ? {helperProviderInstanceId: config.helperProviderInstanceId} : {}),
      team: supervision.team,
      workflows: supervision.workflowStates,
      isEnabled: (projectId, mainThreadId, purpose) => supervision.gate.workflowEditingEnabled(projectId, mainThreadId, purpose),
      isChatStopped: threadId => supervision.gate.supervisionStopped(threadId),
      loadDefinitions: (projectId, threadId, signal) => definitions.load(projectId, threadId, signal),
      contextViews: supervision.conversation,
      starts: {start: (input, evidence, signal) => supervision.supervisionControl.startSupervision(input, evidence, signal)},
      stops: {stop: (input, evidence, signal) => supervision.supervisionControl.stopSupervision(input, evidence, signal)},
      native: {
        listThreads: signal => run(nativeShell.threads, {signal}),
        projection: async (threadId, signal) => (await run(t3.projection(threadId), {signal})).projection,
        getTurnItem: async (input, signal) => {
          const result = await readRpc("orchestration.getTurnItem", input, signal);
          if (!record(result) || !("item" in result)) throw new Error("workflow_native_item_unavailable");
          return {item: result.item};
        },
      },
    });
    const teamController = new SupervisorTeamController(workflowReader, supervision.team, supervision.operateRpc, supervision.conversation.requests);
    supervision.teamEffects = teamController;
    // the dashboard's access client, runtime and workflow MCP endpoint, provided once in this scope; the listeners are
    // acquired after them and released before them
    yield* Layer.build(GuidanceUi.layer(config, {definitions, editor, supervision, workflowReader}).pipe(Layer.provide(Layer.mergeAll(
      ServiceAuth.layer(config.dataDirectory), Layer.succeed(GuidanceRuntime, guidanceRuntime), WorkflowMcp.layer(workflowReader, teamController)))));
    yield* Effect.sync(onReady);
    const interpretation = Effect.tryPromise({try: signal => supervision.runOnce(AbortSignal.any([signal, AbortSignal.timeout(120_000)])), catch: () => new Error("task_interpretation_cycle_failed")}).pipe(
      Effect.catch(() => Effect.sync(() => console.log(JSON.stringify({event: "task_interpretation_unavailable"})))),
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
