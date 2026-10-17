import { Effect } from "effect";
import { resolve } from "node:path";
import { currentThreadPolicy } from "./thread-policy.js";
import type { GuidanceSnapshot } from "./guidance-contract.js";
import type { GuidanceStore } from "./guidance-store.js";
import { isSupervisorThread } from "./project-supervisor-store.js";
import type { StoreShape } from "./store.js";
import type { T3EnvironmentDescriptor } from "./t3.js";
import type { SupervisorConfig } from "./types.js";

/** Provides the dashboard snapshot for native project and workflow supervision. */
export class GuidanceRuntime {
  descriptor: T3EnvironmentDescriptor | null = null;
  lastCycleAt: number | null = null;
  connected = false;
  coverage = "Starting";
  readonly startedAt = Date.now();
  private readonly classifications = new Map<string, "project" | "scratch" | "unclassified">();

  constructor(
    readonly config: SupervisorConfig,
    readonly store: GuidanceStore,
    readonly source: Pick<StoreShape, "catalog">,
  ) {}

  private classifyCatalog(
    projects: Array<{project: {id: string; workspaceRoot: string}; available: boolean}>,
  ): void {
    this.classifications.clear();
    for (const {project, available} of projects) {
      if (!available) continue;
      const explicit = this.store.classification(project.id);
      this.classifications.set(
        project.id,
        explicit !== "unclassified"
          ? explicit
          : this.config.managedScratchRoot
            ? resolve(project.workspaceRoot) === resolve(this.config.managedScratchRoot)
              ? "scratch"
              : "project"
            : "unclassified",
      );
    }
  }

  async snapshot(): Promise<GuidanceSnapshot> {
    const catalog = await Effect.runPromise(this.source.catalog());
    this.classifyCatalog(catalog.projects);
    return {
      environmentId: this.descriptor?.environmentId ?? null,
      serverVersion: this.descriptor?.serverVersion ?? null,
      connected: this.connected,
      lastCycleAt: this.lastCycleAt,
      sendingReady: false,
      sendingReason: "Native project and workflow supervision uses T3 conversations.",
      settings: this.store.settings(),
      threadPolicy: currentThreadPolicy(this.config),
      threads: catalog.threads
        .filter(thread => thread.lineage?.relationshipToParent !== "subagent" && !isSupervisorThread(this.config, thread))
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
        classification: this.classifications.get(project.id) ?? "unclassified",
      })),
      rules: this.store.rules(),
      mutes: this.store.mutes(),
      activity: this.store.activities(),
      coverage: this.coverage,
      tokensUsed: this.store.used(),
    };
  }
}
