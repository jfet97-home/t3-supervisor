import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Scheduler } from "effect";
import { ThreadPolicyConflict, ThreadPolicyInvalid } from "../src/thread-policy.js";
import { dataDirectory, withThreadPolicy } from "./support/g9-stores.js";

// the ThreadPolicyStore service over a temporary thread-settings.sqlite3 (its production client and layer); two stores
// on one file are two clients of it, as two writers of the baseline were, and one store's concurrent saves race on its client

const invalidIds = { message: "Choose valid, unique chat IDs." };
const conflict = { message: "Chat settings changed in another tab. Reload first." };

// the failure of `effect`, validated as `assert.throws` validates a thrown error
const rejects = <A, E>(effect: Effect.Effect<A, E>, expected: { readonly message: string }) =>
  Effect.map(Effect.flip(effect), (error) => {
    assert.throws(() => { throw error; }, expected);
    return error;
  });

it.effect("CT-POLICY-01: two stores on one file saving the same generation concurrently commit exactly one", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("c1-policy-");
  yield* withThreadPolicy(directory, ["seed"], (first) => withThreadPolicy(directory, ["ignored-seed"], (second) => Effect.gen(function* () {
    const base = yield* first.get();
    assert.deepEqual(yield* second.get(), base);
    const results = yield* Effect.all([
      first.save({ ...base, excludedThreadIds: ["from-first"] }),
      second.save({ ...base, excludedThreadIds: ["from-second"] }),
    ], { concurrency: "unbounded", mode: "result" });
    const fulfilled = results.flatMap((result) => result._tag === "Success" ? [result.success] : []);
    const rejected = results.flatMap((result) => result._tag === "Failure" ? [result.failure] : []);
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0] instanceof Error ? rejected[0].message : rejected[0], conflict.message);
    const winner = fulfilled[0];
    assert.deepEqual(winner, { generation: base.generation + 1, excludedThreadIds: ["from-first"] });
    assert.deepEqual(yield* first.get(), winner);
    assert.deepEqual(yield* second.get(), winner);
    // the losing store succeeds only after reloading the committed generation
    assert.deepEqual(yield* second.save({ ...(yield* second.get()), excludedThreadIds: ["from-second"] }), { generation: base.generation + 2, excludedThreadIds: ["from-second"] });
    assert.deepEqual(yield* first.get(), { generation: base.generation + 2, excludedThreadIds: ["from-second"] });
  })));
}), { timeout: 10_000 });

it.effect("CT-POLICY-01: concurrent saves of the same generation commit exactly one, and the loser saves after reloading", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("c1-policy-");
  yield* withThreadPolicy(directory, ["seed"], (store) => Effect.gen(function* () {
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
    assert.ok(rejected[0] instanceof ThreadPolicyConflict);
    assert.equal(rejected[0].message, conflict.message);
    const winner = fulfilled[0]!;
    assert.equal(winner.generation, base.generation + 1);
    assert.deepEqual(yield* store.get(), winner);
    const loser = winner.excludedThreadIds[0] === "from-first" ? "from-second" : "from-first";
    // the losing writer succeeds only after reloading the committed generation
    assert.deepEqual(yield* store.save({ ...(yield* store.get()), excludedThreadIds: [loser] }), { generation: base.generation + 2, excludedThreadIds: [loser] });
    assert.deepEqual(yield* store.get(), { generation: base.generation + 2, excludedThreadIds: [loser] });
  }));
}), { timeout: 10_000 });

it.effect("CT-POLICY-02: 501 ids, a 513-character id and an id with a tab are rejected with the exact message and write nothing", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("c1-policy-");
  yield* withThreadPolicy(directory, [], (store) => Effect.gen(function* () {
    const base = yield* store.get();
    const many = (count: number) => Array.from({ length: count }, (_, index) => `chat-${index}`);
    assert.ok((yield* rejects(store.save({ ...base, excludedThreadIds: many(501) }), invalidIds)) instanceof ThreadPolicyInvalid);
    assert.ok((yield* rejects(store.save({ ...base, excludedThreadIds: ["x".repeat(513)] }), invalidIds)) instanceof ThreadPolicyInvalid);
    assert.ok((yield* rejects(store.save({ ...base, excludedThreadIds: ["tab\tid"] }), invalidIds)) instanceof ThreadPolicyInvalid);
    assert.ok((yield* rejects(store.save({ ...base, excludedThreadIds: [""] }), invalidIds)) instanceof ThreadPolicyInvalid);
    assert.ok((yield* rejects(store.save({ ...base, excludedThreadIds: ["same", "same"] }), invalidIds)) instanceof ThreadPolicyInvalid);
    assert.ok((yield* Effect.flip(store.save({ ...base, generation: 1.5 }))) instanceof ThreadPolicyInvalid);
    assert.deepEqual(yield* store.get(), base);
    // the limits themselves are accepted
    const limits = yield* store.save({ ...base, excludedThreadIds: [...many(499), "x".repeat(512)] });
    assert.equal(limits.generation, base.generation + 1);
    assert.equal((yield* store.get()).excludedThreadIds.length, 500);
  }));
}), { timeout: 10_000 });
