import { Cause, Context, Effect, Layer } from "effect";
import { GuidanceStore } from "./guidance-store.js";
import { GuidanceRuntime } from "./guidance.js";
import { GuidanceUi } from "./guidance-ui.js";
import type { T3ClientShape } from "./t3.js";
import type { SupervisorConfig } from "./types.js";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import type { NativeTransport } from "./supervisor.js";
import { ProjectCommitter, ProjectFiles, ProjectWriter } from "./project-files.js";
import { ProjectDefinitions } from "./project-definitions.js";
import { ProjectConfigEditorService } from "./project-config-editor.js";
import { existsSync } from "node:fs";
import { ProjectSupervisorStore, loadSupervisorOwnership } from "./project-supervisor-store.js";
import { ProjectSupervisor } from "./project-supervisor.js";
import { NativeOperateRpc, NativeRpc, NativeShell } from "./supervisor-native.js";
import { SupervisionScope } from "./supervision-gate.js";
import { SupervisionControl } from "./supervision-control.js";
import { SupervisionLive } from "./supervision-live.js";
import { Store, type StoreShape } from "./store.js";
import { T3Client } from "./t3.js";
import { GitProbe } from "./git-probe.js";
import { WorkflowWriteController } from "./workflow-write-controller.js";
import { WorkflowMcp } from "./workflow-mcp.js";
import { ServiceAuth } from "./service-auth.js";

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
    const definitions = yield* ProjectDefinitions.make({source, t3, files: yield* Effect.provide(ProjectFiles.make(endpoint(readToken.trim())), nativeClients), options: {
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
    const editor = projectWriter ? yield* ProjectConfigEditorService.make({definitions, writer: projectWriter,
      onSaved: (snapshot, expectedRevision) => supervisionStore.recordDefinitionUserSave(snapshot, expectedRevision)}) : undefined;
    const operateToken = config.guidanceTokenFile && existsSync(config.guidanceTokenFile) ? yield* Effect.tryPromise(() => readFile(config.guidanceTokenFile!, "utf8")) : "";
    // the root's native clients of the run: one native client per credential with the shell reads on the read client, the
    // catalog, the T3 client and the definitions
    const clients = Layer.mergeAll(
      NativeShell.layer(endpoint(readToken.trim())).pipe(Layer.provideMerge(NativeRpc.layer(endpoint(readToken.trim())))),
      operateToken.trim() ? NativeOperateRpc.layer(endpoint(operateToken.trim())) : Layer.empty,
      Layer.succeed(Store, source), Layer.succeed(T3Client, t3), Layer.succeed(ProjectDefinitions, definitions),
    );
    // the services of the supervision run, one layer graph built once in this scope over those clients: the supervisor's scope
    // predicates with the admission gate that guards with them, the team services, the Start/Stop control, the workflow
    // controllers and the project supervisor
    const services = yield* Layer.build(SupervisionLive({store: supervisionStore, scope: new SupervisionScope(config, supervisionStore, Boolean(operateToken.trim())),
      baseUrl: config.t3Url, helperProviderInstanceId: config.helperProviderInstanceId}).pipe(Layer.provideMerge(clients)));
    const supervision = Context.get(services, ProjectSupervisor);
    // the dashboard's access client, runtime and workflow MCP endpoint over the run's controllers, provided once in this scope;
    // the listeners are acquired after them and released before them, and the api handlers yield the run's services
    yield* Layer.build(GuidanceUi.layer(config, {definitions, editor, supervision: {supervisor: supervision, control: Context.get(services, SupervisionControl)},
      workflowReader: Context.get(services, WorkflowWriteController)}).pipe(
      Layer.provide(Layer.mergeAll(ServiceAuth.layer(config.dataDirectory), Layer.succeed(GuidanceRuntime, guidanceRuntime), WorkflowMcp.layer)),
      Layer.provide(Layer.succeedContext(services))));
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
