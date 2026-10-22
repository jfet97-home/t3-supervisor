import {SupervisorTeamController} from "./supervisor-team-controller.js";
import { NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import { GuidanceStore } from "./guidance-store.js";
import { GuidanceRuntime } from "./guidance.js";
import { startGuidanceUi } from "./guidance-ui.js";
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
import { NativeRpc, NativeShell, record, type NativeRpcShape, type SupervisorRpc } from "./supervisor-native.js";
import { GitProbe } from "./git-probe.js";
import { WorkflowWriteController } from "./workflow-write-controller.js";
import { createWorkflowMcpEndpoint } from "./workflow-mcp.js";
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
    const runtime = new GuidanceRuntime(
      config,
      store,
      source,
    );
    runtime.descriptor = yield* t3.descriptor();
    store.bind(runtime.descriptor.environmentId);
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
    const supervision = new ProjectSupervisor(config, supervisionStore, source, t3, readRpc,
      operateToken.trim() ? rpcFacade(yield* nativeClient(operateToken.trim())) : null, signal => run(nativeShell.baseline, {signal}), definitions);
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
    const workflows = createWorkflowMcpEndpoint(workflowReader, teamController);
    // the dashboard's access client, acquired in this scope right before the listeners and released after them
    const auth = Context.get(yield* Layer.build(ServiceAuth.layer(config.dataDirectory).pipe(Layer.provide(NodeFileSystem.layer))), ServiceAuth);
    yield* Effect.acquireRelease(
      Effect.promise(() => startGuidanceUi(config, runtime, auth, run, definitions, editor, supervision, workflows, workflowReader)),
      (ui) => Effect.promise(() => ui.close()),
    );
    yield* Effect.sync(onReady);
    const interpretation = Effect.tryPromise({try: signal => supervision.runOnce(AbortSignal.any([signal, AbortSignal.timeout(120_000)])), catch: () => new Error("task_interpretation_cycle_failed")}).pipe(
      Effect.catch(() => Effect.sync(() => console.log(JSON.stringify({event: "task_interpretation_unavailable"})))),
      Effect.andThen(Effect.sleep("5 seconds")), Effect.forever,
    );
    yield* Effect.forkScoped(interpretation);
    const cycle = Effect.tryPromise({
      try: async () => {
        runtime.descriptor = await run(t3.descriptor());
        store.bind(runtime.descriptor.environmentId);
        store.prune();
        runtime.connected = true;
        runtime.lastCycleAt = Date.now();
        runtime.coverage = "Native project and workflow supervision is active.";
      },
      catch: () => new Error("monitor_cycle_failed"),
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          runtime.connected = false;
          runtime.coverage = "T3 connection unavailable. Project editing needs a working T3 connection.";
        }),
      ),
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
    );
    yield* cycle;
  });
