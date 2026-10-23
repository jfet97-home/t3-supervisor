import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { defaultSupervisorModel, isSupervisorThread, SUPERVISOR_ROOT_THREAD_PREFIX, SupervisorOwnership } from "../src/project-supervisor-store.js";
import { dataDirectory, withSupervisionStores } from "./support/g9-stores.js";

// the SupervisorOwnership root service of a process start: the permanent ownership set that each supervision run's
// stores reload from guidance.sqlite3 when they are acquired
const ownership = SupervisorOwnership.useSync((ids) => ids).pipe(Effect.provide(SupervisorOwnership.layer));

it.effect("new root reservations are identifiable and existing owned IDs remain unchanged", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-ownership-");
  const legacyBinding = yield* withSupervisionStores(directory, ({ db, supervisors }) => Effect.gen(function* () {
    const reservation = yield* supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 10, 11);
    assert.match(reservation.threadId, new RegExp(`^${SUPERVISOR_ROOT_THREAD_PREFIX}`));

    const legacyBinding = {...reservation, threadId: "legacy-supervisor-root"};
    yield* db`UPDATE supervisor_main_bindings SET document=${JSON.stringify(legacyBinding)} WHERE project_id=${"project"} AND main_thread_id=${"main"}`;
    yield* db`DELETE FROM supervisor_owned_threads WHERE id=${reservation.threadId}`;
    yield* db`INSERT INTO supervisor_owned_threads VALUES(${"legacy-supervisor-root"})`;
    yield* db`INSERT INTO supervisor_owned_threads VALUES(${"legacy-supervisor-helper"})`;
    return legacyBinding;
  }));

  // the first client closed; a process start reopens the stores over its ownership set
  const ownedIds = yield* ownership;
  yield* withSupervisionStores(directory, ({ supervisors }) => Effect.gen(function* () {
    const existing = yield* supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 10, 12);
    assert.deepEqual(existing, legacyBinding);
  }), ownedIds);
  assert.deepEqual([...ownedIds].sort(), ["legacy-supervisor-helper", "legacy-supervisor-root"]);
}));

it.effect("prefix and native lineage identify new roots and descendants before helper registration", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-ownership-");
  // the ownership set as the supervision run hands it over, after its stores loaded a fresh data directory
  const owned = yield* ownership;
  yield* withSupervisionStores(directory, () => Effect.void, owned);
  const rootId = `${SUPERVISOR_ROOT_THREAD_PREFIX}00000000-0000-4000-8000-000000000001`;
  assert.equal(isSupervisorThread(owned, {id: rootId, lineage: {parentThreadId: null, rootThreadId: rootId}}), true);
  assert.equal(isSupervisorThread(owned, {id: "helper", lineage: {parentThreadId: rootId, rootThreadId: rootId}}), true);
  assert.equal(isSupervisorThread(owned, {id: "ordinary", lineage: {parentThreadId: null, rootThreadId: "ordinary"}}), false);
}));
