import { Effect } from "effect";
import { GuidanceStore } from "./guidance-store.js";
import { GuidanceRuntime, makeGuidanceModel } from "./guidance.js";
import { startGuidanceUi } from "./guidance-ui.js";
import type { StoreShape } from "./store.js";
import type { T3ClientShape } from "./t3.js";
import type { SupervisorConfig } from "./types.js";
import { readFile } from "node:fs/promises";
import { makeProjectFiles, makeProjectWriter } from "./project-files.js";
import { ProjectDefinitionLoader } from "./project-definitions.js";
import { ProjectRuleEditor } from "./project-rule-editor.js";
import { existsSync } from "node:fs";
import { ProjectSupervisorStore, loadSupervisorOwnership } from "./project-supervisor-store.js";
import { ProjectSupervisor } from "./project-supervisor.js";
import { makeSupervisorRpc, readSupervisorBaseline } from "./supervisor-native.js";

export const runGuidanceApplication = (
  config: SupervisorConfig,
  source: StoreShape,
  t3: T3ClientShape,
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
    const definitions = new ProjectDefinitionLoader(source, t3, makeProjectFiles(config.t3Url, readToken.trim()));
    const writePath = config.projectWriteTokenFile;
    const writeToken = writePath && existsSync(writePath) ? yield* Effect.tryPromise(() => readFile(writePath, "utf8")) : "";
    const editor = writeToken.trim() ? new ProjectRuleEditor(definitions, makeProjectWriter(config.t3Url, writeToken.trim())) : undefined;
    const owned = config.supervisorOwnedThreadIds ??= loadSupervisorOwnership(config.dataDirectory);
    const supervisionStore = new ProjectSupervisorStore(store, owned);
    const operateToken = config.guidanceTokenFile && existsSync(config.guidanceTokenFile) ? yield* Effect.tryPromise(() => readFile(config.guidanceTokenFile!, "utf8")) : "";
    const supervision = new ProjectSupervisor(config, supervisionStore, source, t3, makeSupervisorRpc(config.t3Url, readToken.trim()),
      operateToken.trim() ? makeSupervisorRpc(config.t3Url, operateToken.trim()) : null, readSupervisorBaseline(config.t3Url, readToken.trim()), definitions);
    runtime.retired = true;
    yield* Effect.acquireRelease(
      Effect.promise(() => startGuidanceUi(config, runtime, definitions, editor, supervision)),
      (ui) => Effect.promise(() => ui.close()),
    );
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
