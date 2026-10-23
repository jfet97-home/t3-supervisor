import { Clock, Context, Effect, Layer, SubscriptionRef } from "effect";
import { resolve } from "node:path";
import { SupervisorConfig as Configuration } from "./config.js";
import { currentThreadPolicy, ThreadPolicy } from "./thread-policy.js";
import type { GuidanceSnapshot } from "./guidance-contract.js";
import type { GuidanceStore } from "./guidance-store.js";
import { isSupervisorThread, SupervisorOwnership } from "./project-supervisor-store.js";
import { Store, type StoreError, type StoreShape } from "./store.js";
import type { T3EnvironmentDescriptor } from "./t3.js";
import type { SupervisorConfig } from "./types.js";

// the connection state the supervision cycle publishes and every snapshot reads
export interface RuntimeState {
  readonly descriptor: T3EnvironmentDescriptor | null;
  readonly lastCycleAt: number | null;
  readonly connected: boolean;
  readonly coverage: string;
  readonly startedAt: number;
}

type Classification = "project" | "scratch" | "unclassified";

// an explicit store value wins; otherwise scratch at the resolved managed scratch root, else project, and unclassified without one
const classifyCatalog = (config: SupervisorConfig, store: GuidanceStore,
  projects: ReadonlyArray<{project: {id: string; workspaceRoot: string}; available: boolean}>): Map<string, Classification> => {
  const classifications = new Map<string, Classification>();
  for (const {project, available} of projects) {
    if (!available) continue;
    const explicit = store.classification(project.id);
    classifications.set(
      project.id,
      explicit !== "unclassified"
        ? explicit
        : config.managedScratchRoot
          ? resolve(project.workspaceRoot) === resolve(config.managedScratchRoot)
            ? "scratch"
            : "project"
          : "unclassified",
    );
  }
  return classifications;
};

// the configuration is read at snapshot time, so ownership and thread policy follow the values it carries (b-02)
const makeGuidanceRuntime = (config: SupervisorConfig, store: GuidanceStore, source: Pick<StoreShape, "catalog">) => Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<RuntimeState>({
    descriptor: null, lastCycleAt: null, connected: false, coverage: "Starting", startedAt: yield* Clock.currentTimeMillis,
  });
  const update = (change: Partial<RuntimeState>) => SubscriptionRef.update(state, (current) => ({ ...current, ...change }));
  const snapshot = Effect.gen(function* () {
    const catalog = yield* source.catalog();
    const current = yield* SubscriptionRef.get(state);
    // the guidance store and the thread policy are synchronous reads (b-02), taken in one block in their baseline order
    return yield* Effect.sync((): GuidanceSnapshot => {
      const classifications = classifyCatalog(config, store, catalog.projects);
      return {
        environmentId: current.descriptor?.environmentId ?? null,
        serverVersion: current.descriptor?.serverVersion ?? null,
        connected: current.connected,
        lastCycleAt: current.lastCycleAt,
        sendingReady: false,
        sendingReason: "Native project and workflow supervision uses T3 conversations.",
        settings: store.settings(),
        threadPolicy: currentThreadPolicy(config),
        threads: catalog.threads
          .filter(thread => thread.lineage?.relationshipToParent !== "subagent" && !isSupervisorThread(config, thread))
          .map(thread => ({
            id: thread.id,
            title: thread.title,
            projectId: thread.projectId,
            available: !thread.deletedAt && !thread.archivedAt,
          })),
        projects: catalog.projects.map(({project, available}) => ({
          id: project.id,
          title: project.title,
          available,
          classification: classifications.get(project.id) ?? "unclassified",
        })),
        rules: store.rules(),
        mutes: store.mutes(),
        activity: store.activities(),
        coverage: current.coverage,
        tokensUsed: store.used(),
      };
    });
  });
  return {
    state,
    snapshot,
    recordDescriptor: (descriptor: T3EnvironmentDescriptor) => update({ descriptor }),
    markActive: Effect.flatMap(Clock.currentTimeMillis, (lastCycleAt) =>
      update({ connected: true, lastCycleAt, coverage: "Native project and workflow supervision is active." })),
    markUnavailable: update({ connected: false, coverage: "T3 connection unavailable. Project editing needs a working T3 connection." }),
  };
});

/** Provides the dashboard snapshot for native project and workflow supervision. */
export class GuidanceRuntime extends Context.Service<GuidanceRuntime, {
  // written only by the operations below; readers may follow its changes
  readonly state: SubscriptionRef.SubscriptionRef<RuntimeState>;
  readonly snapshot: Effect.Effect<GuidanceSnapshot, StoreError>;
  readonly recordDescriptor: (descriptor: T3EnvironmentDescriptor) => Effect.Effect<void>;
  // a completed cycle: connected, its time on the Effect clock and the active coverage text
  readonly markActive: Effect.Effect<void>;
  // a failed cycle keeps the last descriptor and cycle time
  readonly markUnavailable: Effect.Effect<void>;
}>()("t3-supervisor/GuidanceRuntime") {
  static readonly make: (config: SupervisorConfig, store: GuidanceStore, source: Pick<StoreShape, "catalog">) => Effect.Effect<GuidanceRuntime["Service"]> =
    makeGuidanceRuntime;
  // the runtime over the root services and the interim guidance store (b-02, a service from s6d)
  static readonly layer = (store: GuidanceStore): Layer.Layer<GuidanceRuntime, never, Store | Configuration | ThreadPolicy | SupervisorOwnership> =>
    Layer.effect(GuidanceRuntime, Effect.gen(function* () {
      const config = { ...yield* Configuration, threadPolicy: yield* ThreadPolicy, supervisorOwnedThreadIds: yield* SupervisorOwnership };
      return yield* makeGuidanceRuntime(config, store, yield* Store);
    }));
}
