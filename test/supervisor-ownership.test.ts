import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SupervisorConfig as Configuration } from "../src/config.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { defaultSupervisorModel, isSupervisorThread, ProjectSupervisorStore, SUPERVISOR_ROOT_THREAD_PREFIX, SupervisorOwnership } from "../src/project-supervisor-store.js";
import type { SupervisorConfig } from "../src/types.js";

const settings = (directory: string): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://unused",
  t3TokenFile: "unused",
  excludedThreadIds: [],
  healthPort: 0,
});

// the SupervisorOwnership root service of a process start over the given data directory
const ownership = (directory: string) =>
  SupervisorOwnership.useSync((ids) => ids).pipe(Effect.provide(SupervisorOwnership.layer.pipe(Layer.provide(Layer.succeed(Configuration, settings(directory))))));

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "supervisor-ownership-"))),
  (directory) => Effect.promise(() => rm(directory, {recursive: true, force: true})),
);

it.live("new root reservations are identifiable and existing owned IDs remain unchanged", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  let guidance = new GuidanceStore(directory);
  yield* Effect.addFinalizer(() => Effect.sync(() => guidance.close()));
  let ownedIds = new Set<string>();
  let supervisors = new ProjectSupervisorStore(guidance, ownedIds);
  const reservation = supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 10, 11);
  assert.match(reservation.threadId, new RegExp(`^${SUPERVISOR_ROOT_THREAD_PREFIX}`));

  const legacyBinding = {...reservation, threadId: "legacy-supervisor-root"};
  guidance.db.prepare("UPDATE supervisor_main_bindings SET document=? WHERE project_id=? AND main_thread_id=?")
    .run(JSON.stringify(legacyBinding), "project", "main");
  guidance.db.prepare("DELETE FROM supervisor_owned_threads WHERE id=?").run(reservation.threadId);
  guidance.db.prepare("INSERT INTO supervisor_owned_threads VALUES(?)").run("legacy-supervisor-root");
  guidance.db.prepare("INSERT INTO supervisor_owned_threads VALUES(?)").run("legacy-supervisor-helper");
  guidance.close();

  guidance = new GuidanceStore(directory);
  ownedIds = yield* ownership(directory);
  supervisors = new ProjectSupervisorStore(guidance, ownedIds);
  const existing = supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 10, 12);
  assert.deepEqual(existing, legacyBinding);
  assert.deepEqual([...ownedIds].sort(), ["legacy-supervisor-helper", "legacy-supervisor-root"]);
}));

it.live("prefix and native lineage identify new roots and descendants before helper registration", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  // the configuration as the supervision run hands it over, with the root ownership of a fresh data directory
  const config: SupervisorConfig = {...settings(directory), supervisorOwnedThreadIds: yield* ownership(directory)};
  const rootId = `${SUPERVISOR_ROOT_THREAD_PREFIX}00000000-0000-4000-8000-000000000001`;
  assert.equal(isSupervisorThread(config, {id: rootId, lineage: {parentThreadId: null, rootThreadId: rootId}}), true);
  assert.equal(isSupervisorThread(config, {id: "helper", lineage: {parentThreadId: rootId, rootThreadId: rootId}}), true);
  assert.equal(isSupervisorThread(config, {id: "ordinary", lineage: {parentThreadId: null, rootThreadId: "ordinary"}}), false);
}));
