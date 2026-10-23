import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { SupervisorConfig } from "../../src/config.js";
import { type DatabaseOpenError, GuidanceDb, PolicyDb } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { SupervisionStoresLive } from "../../src/supervision-live.js";
import { makeProjectSupervisorMonitorStore, ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { ThreadPolicyStore, type ThreadPolicyStoreError } from "../../src/thread-policy.js";
import type { SupervisorSettings } from "../../src/types.js";
import { withDbFile } from "./sql-db-files.js";

// the store services of the g9 suites on a real database file: each open is one client through the file's production layer
// (test/support/sql-db-files.ts) with the production store layers over it, closed when the work ends, so a second open of
// the same directory is a restart

/** A fresh temporary data directory, removed with the test scope. */
export const dataDirectory = (prefix: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
}).pipe(Effect.provide(NodeFileSystem.layer));

const ids = SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));


/** `use` on the guidance client of `directory`, which also serves as the run's GuidanceDb. */
export const withGuidanceDb = <A, E, R>(directory: string, use: (db: SqlClient.SqlClient) => Effect.Effect<A, E, R>) => {
  const open: Effect.Effect<A, E | DatabaseOpenError, Exclude<R, GuidanceDb> | FileSystem.FileSystem> =
    withDbFile("guidance", directory, (db) => use(db).pipe(Effect.provideService(GuidanceDb, db)));
  return Effect.provide(open, NodeFileSystem.layer);
};

// the guidance store and the monitor store, as a guidance store and its monitor were opened on the file
const monitorStores = (capacity: number | undefined) => (capacity === undefined ? ProjectSupervisorMonitorStore.layer :
  Layer.effect(ProjectSupervisorMonitorStore, makeProjectSupervisorMonitorStore(capacity))).pipe(
  Layer.provideMerge(GuidanceStore.layer), Layer.provide(ids));

/** `use` on the monitor store of `directory` (the default capacity unless one is given) and its client. */
export const withMonitor = <A, E, R>(directory: string, use: (monitor: ProjectSupervisorMonitorStore["Service"], db: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
  capacity?: number) =>
  withGuidanceDb(directory, (db) => Effect.flatMap(Effect.service(ProjectSupervisorMonitorStore), (monitor) => use(monitor, db)).pipe(
    Effect.provide(Layer.fresh(monitorStores(capacity)))));

/** The supervision stores of one run on its client, with the process's ownership set. */
export interface SupervisionStores {
  readonly db: SqlClient.SqlClient;
  readonly guidance: GuidanceStore["Service"];
  readonly supervisors: ProjectSupervisorStore["Service"];
  readonly team: SupervisorTeamStore["Service"];
  readonly owned: Set<string>;
}

// the production store graph of a supervision run over the guidance store, the identities and the ownership set
const supervisionStores = (owned: Set<string>) => SupervisionStoresLive.pipe(
  Layer.provideMerge(GuidanceStore.layer),
  Layer.provideMerge(Layer.mergeAll(Layer.succeed(SupervisorOwnership, owned), ids)));

/** `use` on the supervision stores of `directory`; the ownership set is the process's, a fresh one unless given. */
export const withSupervisionStores = <A, E, R>(directory: string, use: (stores: SupervisionStores) => Effect.Effect<A, E, R>, owned: Set<string> = new Set()) =>
  withGuidanceDb(directory, (db) => Effect.gen(function* () {
    return yield* use({ db, guidance: yield* GuidanceStore, supervisors: yield* ProjectSupervisorStore, team: yield* SupervisorTeamStore, owned });
  }).pipe(Effect.provide(Layer.fresh(supervisionStores(owned)))));

/** The configuration of a process over `directory` with the given configured excluded chats. */
export const settings = (directory: string, excludedThreadIds: ReadonlyArray<string> = []): SupervisorSettings => ({
  dataDirectory: directory,
  t3Url: "http://unused",
  t3TokenFile: "unused",
  excludedThreadIds: [...excludedThreadIds],
  healthPort: 0,
});

/** `use` on the thread-policy store of `directory`, seeded with the configured excluded chats, and its client. */
export const withThreadPolicy = <A, E, R>(directory: string, excludedThreadIds: ReadonlyArray<string>,
  use: (policy: ThreadPolicyStore["Service"], db: SqlClient.SqlClient) => Effect.Effect<A, E, R>) => {
  const store = Layer.fresh(ThreadPolicyStore.layer.pipe(Layer.provide(Layer.succeed(SupervisorConfig, settings(directory, excludedThreadIds)))));
  const open: Effect.Effect<A, E | ThreadPolicyStoreError | DatabaseOpenError, Exclude<Exclude<R, ThreadPolicyStore>, PolicyDb> | FileSystem.FileSystem> =
    withDbFile("policy", directory, (db) => Effect.flatMap(Effect.service(ThreadPolicyStore), (policy) => use(policy, db)).pipe(
      Effect.provide(store), Effect.provideService(PolicyDb, db)));
  return Effect.provide(open, NodeFileSystem.layer);
};
