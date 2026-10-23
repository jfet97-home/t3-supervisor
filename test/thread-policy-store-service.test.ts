import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Scheduler } from "effect";
import { SupervisorConfig } from "../src/config.js";
import { PolicyDb } from "../src/db.js";
import {
  makeThreadPolicyStore,
  ThreadPolicyConflict,
  ThreadPolicyInvalid,
  ThreadPolicyStoreError,
  ThreadPolicyStoreService,
  type ThreadPolicyStoreShape,
} from "../src/thread-policy.js";
import { policyDb, rows, temporaryDirectory } from "./support/guidance-store-services.js";

// the ThreadPolicyStore effect service on a temporary thread-settings.sqlite3 through the production PolicyDb layer: the
// baseline suite's case (test/thread-policy.test.ts) with the same name and assertions, then CT-POLICY-01/02 at service
// level, the authoritative read on every call and typed row failures

const invalidIds = "Choose valid, unique chat IDs.";
const conflict = "Chat settings changed in another tab. Reload first.";

// every use opens the client and the store afresh and closes them again, as a process restart would
const withPolicy = <A, E>(directory: string, seed: ReadonlyArray<string>, use: (store: ThreadPolicyStoreShape, db: PolicyDb["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* makeThreadPolicyStore({ excludedThreadIds: seed }), yield* PolicyDb);
  }).pipe(Effect.provide(policyDb(directory)));

const message = (error: unknown): string => error instanceof ThreadPolicyInvalid || error instanceof ThreadPolicyConflict ? error.message : `unexpected ${String(error)}`;

describe("ThreadPolicyStoreService", () => {
  it.live("excluded-thread policy persists and uses compare-and-swap generations", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const saved = yield* withPolicy(directory, ["excluded"], (store) => Effect.gen(function* () {
      const previous = yield* store.get();
      const saved = yield* store.save({...previous, excludedThreadIds: []});
      assert.match(message(yield* Effect.flip(store.save(previous))), /another tab/u);
      assert.match(message(yield* Effect.flip(store.save({...saved, excludedThreadIds: ["invalid id"]}))), /valid/u);
      assert.match(message(yield* Effect.flip(store.save({...saved, excludedThreadIds: ["excluded", "excluded"]}))), /unique/u);
      return saved;
    }));
    assert.deepEqual(yield* withPolicy(directory, ["new-default"], (store) => store.get()), saved);
  }), { timeout: 10_000 });

  it.live("CT-POLICY-01: concurrent saves of the same generation commit exactly one, and the loser saves after reloading", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* withPolicy(directory, ["seed"], (store) => Effect.gen(function* () {
      const base = yield* store.get();
      // a yield every eight operations interleaves the two fibers wherever the save is not a single statement
      const results = yield* Effect.all([
        Effect.result(store.save({ ...base, excludedThreadIds: ["from-first"] })),
        Effect.result(store.save({ ...base, excludedThreadIds: ["from-second"] })),
      ], { concurrency: "unbounded" }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8));
      const fulfilled = results.flatMap((result) => result._tag === "Success" ? [result.success] : []);
      const rejected = results.flatMap((result) => result._tag === "Failure" ? [result.failure] : []);
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(message(rejected[0]), conflict);
      const winner = fulfilled[0]!;
      assert.equal(winner.generation, base.generation + 1);
      assert.deepEqual(yield* store.get(), winner);
      const loser = winner.excludedThreadIds[0] === "from-first" ? "from-second" : "from-first";
      // the losing writer succeeds only after reloading the committed generation
      assert.deepEqual(yield* store.save({ ...(yield* store.get()), excludedThreadIds: [loser] }), { generation: base.generation + 2, excludedThreadIds: [loser] });
      assert.deepEqual(yield* store.get(), { generation: base.generation + 2, excludedThreadIds: [loser] });
    }));
  }), { timeout: 10_000 });

  it.live("CT-POLICY-02: 501 ids, a 513-character id and an id with a tab are rejected with the exact message and write nothing", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* withPolicy(directory, [], (store) => Effect.gen(function* () {
      const base = yield* store.get();
      const many = (count: number) => Array.from({ length: count }, (_, index) => `chat-${index}`);
      for (const excludedThreadIds of [many(501), ["x".repeat(513)], ["tab\tid"], [""], ["same", "same"]]) {
        const refused = yield* Effect.flip(store.save({ ...base, excludedThreadIds }));
        assert.ok(refused instanceof ThreadPolicyInvalid);
        assert.equal(refused.message, invalidIds);
      }
      assert.ok((yield* Effect.flip(store.save({ ...base, generation: 1.5 }))) instanceof ThreadPolicyInvalid);
      assert.deepEqual(yield* store.get(), base);
      // the limits themselves are accepted
      const limits = yield* store.save({ ...base, excludedThreadIds: [...many(499), "x".repeat(512)] });
      assert.equal(limits.generation, base.generation + 1);
      assert.equal((yield* store.get()).excludedThreadIds.length, 500);
    }));
  }), { timeout: 10_000 });

  it.live("every get is an authoritative read of the stored row, and the layer seeds from the configured excluded chat ids once", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const configured = (excluded: string) => ThreadPolicyStoreService.layer.pipe(
      Layer.provideMerge(policyDb(directory)),
      Layer.provide(SupervisorConfig.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(
        { DATA_DIRECTORY: directory, EXCLUDED_THREAD_IDS: excluded }, { preserveEmptyStrings: true }))))),
      Layer.orDie);
    const observed = yield* Effect.gen(function* () {
      const store = yield* ThreadPolicyStoreService;
      const db = yield* PolicyDb;
      const seeded = yield* store.get();
      // a write the store did not make is seen by the next read: nothing is cached
      yield* db`UPDATE settings SET document=${JSON.stringify({ generation: 7, excludedThreadIds: ["written-elsewhere"] })} WHERE id=1`;
      return { seeded, reread: yield* store.get() };
    }).pipe(Effect.provide(configured(" a , b ,")));
    assert.deepEqual(observed, { seeded: { generation: 1, excludedThreadIds: ["a", "b"] }, reread: { generation: 7, excludedThreadIds: ["written-elsewhere"] } });
    assert.deepEqual(yield* Effect.flatMap(ThreadPolicyStoreService, (store) => store.get()).pipe(Effect.provide(configured("ignored"))),
      { generation: 7, excludedThreadIds: ["written-elsewhere"] });
  }), { timeout: 10_000 });

  it.live("a stored policy row that is missing or does not decode is a typed failure, never a default", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const failures = yield* withPolicy(directory, [], (store, db) => Effect.gen(function* () {
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
  }), { timeout: 10_000 });
});
