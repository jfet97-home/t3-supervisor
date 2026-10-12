import { Effect } from "effect";
import { GuidanceStore } from "./guidance-store.js";
import { GuidanceRuntime, makeGuidanceModel } from "./guidance.js";
import { startGuidanceUi } from "./guidance-ui.js";
import type { StoreShape } from "./store.js";
import type { T3ClientShape } from "./t3.js";
import type { SupervisorConfig } from "./types.js";

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
    yield* Effect.acquireRelease(
      Effect.promise(() => startGuidanceUi(config, runtime)),
      (ui) => Effect.promise(() => ui.close()),
    );
    const cycle = Effect.tryPromise({
      try: (signal) => runtime.runOnce(signal),
      catch: () => new Error("monitor_cycle_failed"),
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          runtime.connected = false;
          runtime.coverage =
            "Guidance monitoring unavailable or budget exhausted. T3 observation continues.";
        }),
      ),
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
    );
    yield* cycle;
  });
