import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { SupervisorConfig } from "../src/config.js";
import { PolicyDb } from "../src/db.js";
import { ThreadPolicyConflict, ThreadPolicyInvalid, ThreadPolicyStore, ThreadPolicyStoreError } from "../src/thread-policy.js";
import { failsWith, policyDb, rows } from "./support/guidance-store-services.js";
import { dataDirectory, withThreadPolicy } from "./support/g9-stores.js";

// the ThreadPolicyStore service over a temporary thread-settings.sqlite3 (its production client and layer): the baseline
// case, then the authoritative read on every call, the configured seed and typed row failures

it.effect("excluded-thread policy persists and uses compare-and-swap generations", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-policy-");
  const saved = yield* withThreadPolicy(directory, ["excluded"], (store) => Effect.gen(function* () {
    const previous = yield* store.get();
    const saved = yield* store.save({...previous, excludedThreadIds: []});
    assert.ok((yield* failsWith(store.save(previous), /another tab/u)) instanceof ThreadPolicyConflict);
    assert.ok((yield* failsWith(store.save({...saved, excludedThreadIds: ["invalid id"]}), /valid/u)) instanceof ThreadPolicyInvalid);
    assert.ok((yield* failsWith(store.save({...saved, excludedThreadIds: ["excluded", "excluded"]}), /unique/u)) instanceof ThreadPolicyInvalid);
    return saved;
  }));
  // the first client closed; the store reopens on the same file with a different configured seed
  yield* withThreadPolicy(directory, ["new-default"], (store) => Effect.gen(function* () {
    assert.deepEqual(yield* store.get(), saved);
  }));
}));

it.effect("every get is an authoritative read of the stored row, and the layer seeds from the configured excluded chat ids once", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-policy-");
  const configured = (excluded: string) => ThreadPolicyStore.layer.pipe(
    Layer.provideMerge(policyDb(directory)),
    Layer.provide(SupervisorConfig.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(
      { DATA_DIRECTORY: directory, EXCLUDED_THREAD_IDS: excluded }, { preserveEmptyStrings: true }))))),
    Layer.orDie);
  const observed = yield* Effect.gen(function* () {
    const store = yield* ThreadPolicyStore;
    const db = yield* PolicyDb;
    const seeded = yield* store.get();
    // a write the store did not make is seen by the next read: nothing is cached
    yield* db`UPDATE settings SET document=${JSON.stringify({ generation: 7, excludedThreadIds: ["written-elsewhere"] })} WHERE id=1`;
    return { seeded, reread: yield* store.get() };
  }).pipe(Effect.provide(configured(" a , b ,")));
  assert.deepEqual(observed, { seeded: { generation: 1, excludedThreadIds: ["a", "b"] }, reread: { generation: 7, excludedThreadIds: ["written-elsewhere"] } });
  assert.deepEqual(yield* Effect.flatMap(ThreadPolicyStore, (store) => store.get()).pipe(Effect.provide(configured("ignored"))),
    { generation: 7, excludedThreadIds: ["written-elsewhere"] });
}));

it.effect("a stored policy row that is missing or does not decode is a typed failure, never a default", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-policy-");
  const failures = yield* withThreadPolicy(directory, [], (store, db) => Effect.gen(function* () {
    yield* db`UPDATE settings SET document='{"generation":"one"}' WHERE id=1`;
    const invalid = yield* Effect.flip(store.get());
    yield* db`DELETE FROM settings`;
    const missing = yield* Effect.flip(store.get());
    const save = yield* Effect.flip(store.save({ generation: 1, excludedThreadIds: [] }));
    return { invalid, missing, save, rows: yield* rows(db, "SELECT * FROM settings") };
  }));
  for (const failure of [failures.invalid, failures.missing]) {
    assert.ok(failure instanceof ThreadPolicyStoreError);
    assert.equal(failure.reason, "row_invalid");
  }
  assert.ok(failures.save instanceof ThreadPolicyConflict, "a save against a missing row changes nothing and conflicts");
  assert.deepEqual(failures.rows, []);
}));
