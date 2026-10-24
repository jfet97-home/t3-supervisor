import { Clock, Context, Effect, Layer, SubscriptionRef } from "effect";
import { DashboardUpdates } from "./dashboard-updates.js";
import { resolve } from "node:path";
import { SupervisorConfig as Configuration } from "./config.js";
import { GuidanceDb } from "./db.js";
import type { GuidanceSnapshot } from "./guidance-contract.js";
import { type GuidanceStoreError, guidanceTransaction } from "./guidance-sql.js";
import { GuidanceStore } from "./guidance-store.js";
import { isSupervisorThread, SupervisorOwnership } from "./project-supervisor-store.js";
import { Store, type StoreError, type StoreShape } from "./store.js";
import type { T3EnvironmentDescriptor } from "./t3.js";
import { ThreadPolicyStore, type ThreadPolicyStoreError } from "./thread-policy.js";
import type { SupervisorSettings } from "./types.js";

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
const classifyCatalog = (config: SupervisorSettings, store: GuidanceStore["Service"],
  projects: ReadonlyArray<{project: {id: string; workspaceRoot: string}; available: boolean}>) => Effect.gen(function* () {
  const classifications = new Map<string, Classification>();
  for (const {project, available} of projects) {
    if (!available) continue;
    const explicit = yield* store.classification(project.id);
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
});

// ownership and the thread policy are read at snapshot time
const makeGuidanceRuntime = (config: SupervisorSettings, source: Pick<StoreShape, "catalog">) => Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const store = yield* GuidanceStore;
  const policy = yield* ThreadPolicyStore;
  const owned = yield* SupervisorOwnership;
  const state = yield* SubscriptionRef.make<RuntimeState>({
    descriptor: null, lastCycleAt: null, connected: false, coverage: "Starting", startedAt: yield* Clock.currentTimeMillis,
  });
  const observer = yield* Effect.serviceOption(DashboardUpdates);
  const update = (change: Partial<RuntimeState>) => Effect.gen(function* () {
    const previous = yield* SubscriptionRef.get(state);
    const next = {...previous, ...change};
    yield* SubscriptionRef.set(state, next);
    if (observer._tag === "Some" && (previous.connected !== next.connected || previous.coverage !== next.coverage ||
      JSON.stringify(previous.descriptor) !== JSON.stringify(next.descriptor))) yield* observer.value.publish(["snapshot"]);
  });
  const snapshot = Effect.gen(function* () {
    const catalog = yield* source.catalog();
    const current = yield* SubscriptionRef.get(state);
    // the guidance and thread-policy reads in their baseline order, the guidance reads as one snapshot
    return yield* guidanceTransaction(db)(Effect.gen(function* (): Effect.fn.Return<GuidanceSnapshot, GuidanceStoreError | ThreadPolicyStoreError> {
      const classifications = yield* classifyCatalog(config, store, catalog.projects);
      const settings = yield* store.settings();
      const threadPolicy = yield* policy.get();
      return {
        environmentId: current.descriptor?.environmentId ?? null,
        serverVersion: current.descriptor?.serverVersion ?? null,
        connected: current.connected,
        lastCycleAt: current.lastCycleAt,
        sendingReady: false,
        sendingReason: "Native project and workflow supervision uses T3 conversations.",
        settings,
        threadPolicy,
        threads: catalog.threads
          .filter(thread => thread.lineage?.relationshipToParent !== "subagent" && !isSupervisorThread(owned, thread))
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
        rules: yield* store.rules(),
        mutes: yield* store.mutes(),
        activity: yield* store.activities(),
        coverage: current.coverage,
        tokensUsed: yield* store.used(),
      };
    }));
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
  readonly snapshot: Effect.Effect<GuidanceSnapshot, StoreError | GuidanceStoreError | ThreadPolicyStoreError>;
  readonly recordDescriptor: (descriptor: T3EnvironmentDescriptor) => Effect.Effect<void>;
  // a completed cycle: connected, its time on the Effect clock and the active coverage text
  readonly markActive: Effect.Effect<void>;
  // a failed cycle keeps the last descriptor and cycle time
  readonly markUnavailable: Effect.Effect<void>;
}>()("t3-supervisor/GuidanceRuntime") {
  static readonly make: (config: SupervisorSettings, source: Pick<StoreShape, "catalog">) =>
    Effect.Effect<GuidanceRuntime["Service"], never, GuidanceDb | GuidanceStore | ThreadPolicyStore | SupervisorOwnership> = makeGuidanceRuntime;
  // the runtime over the root services and the run's guidance store
  static readonly layer: Layer.Layer<GuidanceRuntime, never, Store | Configuration | GuidanceDb | GuidanceStore | ThreadPolicyStore | SupervisorOwnership> =
    Layer.effect(GuidanceRuntime, Effect.gen(function* () {
      return yield* makeGuidanceRuntime(yield* Configuration, yield* Store);
    }));
}
