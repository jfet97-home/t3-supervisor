import { Effect } from "effect";
import { GuidanceStore } from "./guidance-store.js";
import { GuidanceRuntime, makeGuidanceModel } from "./guidance.js";
import { startGuidanceUi } from "./guidance-ui.js";
import type { StoreShape } from "./store.js";
import type { T3ClientShape } from "./t3.js";
import type { SupervisorConfig } from "./types.js";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { makeProjectCommitter, makeProjectFiles, makeProjectWriter } from "./project-files.js";
import { ProjectDefinitionLoader } from "./project-definitions.js";
import { ProjectConfigEditor } from "./project-config-editor.js";
import { existsSync } from "node:fs";
import { ProjectSupervisorStore, loadSupervisorOwnership } from "./project-supervisor-store.js";
import { ProjectSupervisor } from "./project-supervisor.js";
import { makeSupervisorRpc, readSupervisorBaseline, readSupervisorThreads, record } from "./supervisor-native.js";
import { makeGitProbe } from "./git-probe.js";
import { WorkflowWriteController } from "./workflow-write-controller.js";
import { createWorkflowMcpEndpoint } from "./workflow-mcp.js";

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
    const runtime = new GuidanceRuntime(
      config,
      store,
      source,
      t3,
      makeGuidanceModel(config, store),
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
    const gitProbe = probeToken.trim() ? makeGitProbe(config.t3Url, probeToken.trim(), store) : undefined;
    const cleanupGitProbe = gitProbe ? Effect.tryPromise(() => gitProbe.cleanup()).pipe(
      Effect.catch(() => Effect.sync(() => console.log(JSON.stringify({event: "native_git_probe_cleanup_unavailable"})))),
    ) : Effect.void;
    yield* Effect.acquireRelease(Effect.succeed(gitProbe), () => cleanupGitProbe);
    yield* cleanupGitProbe;
    const owned = config.supervisorOwnedThreadIds ??= loadSupervisorOwnership(config.dataDirectory);
    const supervisionStore = new ProjectSupervisorStore(store, owned);
    const projectWriter = writeToken.trim() ? makeProjectWriter(config.t3Url, writeToken.trim()) : undefined;
    const commitWriter = commitToken.trim() ? makeProjectCommitter(config.t3Url, commitToken.trim()) : undefined;
    const setupWriter = projectWriter?.writeFile ? {
      writeFile: projectWriter.writeFile,
      ...(commitWriter ? {commitFiles: commitWriter.commitFiles} : {}),
    } : undefined;
    const managedScratchRoot = config.managedScratchRoot && posix.isAbsolute(config.managedScratchRoot) ? posix.normalize(config.managedScratchRoot) : null;
    const definitions = new ProjectDefinitionLoader(source, t3, makeProjectFiles(config.t3Url, readToken.trim()), {
      globalRoot: "~",
      useGlobalDefinitions: () => supervisionStore.useGlobalDefinitions(),
      isScratchProject: (projectId, workspaceRoot) => {
        const classification = store.classification(projectId);
        if (classification !== "unclassified") return classification === "scratch";
        return managedScratchRoot !== null && posix.normalize(workspaceRoot) === managedScratchRoot;
      },
      ...(setupWriter ? {setupWriter} : {}),
      ...(gitProbe ? {gitProbe: gitProbe.probe} : {}),
    });
    const editor = projectWriter ? new ProjectConfigEditor(definitions, projectWriter, (snapshot, expectedRevision) => supervisionStore.recordDefinitionUserSave(snapshot, expectedRevision)) : undefined;
    const operateToken = config.guidanceTokenFile && existsSync(config.guidanceTokenFile) ? yield* Effect.tryPromise(() => readFile(config.guidanceTokenFile!, "utf8")) : "";
    const readRpc = makeSupervisorRpc(config.t3Url, readToken.trim());
    const supervision = new ProjectSupervisor(config, supervisionStore, source, t3, readRpc,
      operateToken.trim() ? makeSupervisorRpc(config.t3Url, operateToken.trim()) : null, readSupervisorBaseline(config.t3Url, readToken.trim()), definitions);
    const workflows = createWorkflowMcpEndpoint(new WorkflowWriteController({
      supervisors: supervisionStore,
      workflows: supervision.workflowStates,
      isEnabled: projectId => supervision.workflowEditingEnabled(projectId),
      loadDefinitions: (projectId, threadId, signal) => definitions.load(projectId, threadId, signal),
      native: {
        listThreads: readSupervisorThreads(config.t3Url, readToken.trim(), readRpc),
        projection: async (threadId, signal) => (await Effect.runPromise(t3.projection(threadId), {signal})).projection,
        getTurnItem: async (input, signal) => {
          const result = await readRpc("orchestration.getTurnItem", input, signal);
          if (!record(result) || !("item" in result)) throw new Error("workflow_native_item_unavailable");
          return {item: result.item};
        },
      },
    }));
    runtime.retired = true;
    yield* Effect.acquireRelease(
      Effect.promise(() => startGuidanceUi(config, runtime, definitions, editor, supervision, workflows)),
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
        runtime.descriptor = await Effect.runPromise(t3.descriptor());
        store.bind(runtime.descriptor.environmentId);
        store.prune();
        runtime.connected = true;
        runtime.lastCycleAt = Date.now();
        runtime.coverage = runtime.sendingReason();
      },
      catch: () => new Error("monitor_cycle_failed"),
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          runtime.connected = false;
          runtime.coverage =
            "T3 connection unavailable. Project editing needs a working T3 connection.";
        }),
      ),
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
    );
    yield* cycle;
  });
