import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { dataDirectory, withThreadPolicy } from "./support/g9-stores.js";

// the ThreadPolicyStore service over a temporary thread-settings.sqlite3 (its production client and layer); two stores
// on one file are two clients of it, as two writers of the baseline were

const invalidIds = { message: "Choose valid, unique chat IDs." };
const conflict = { message: "Chat settings changed in another tab. Reload first." };

// the failure of `effect`, validated as `assert.throws` validates a thrown error
const rejects = <A, E>(effect: Effect.Effect<A, E>, expected: { readonly message: string }) =>
  Effect.map(Effect.flip(effect), (error) => assert.throws(() => { throw error; }, expected));

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

it.effect("CT-POLICY-02: 501 ids, a 513-character id and an id with a tab are rejected with the exact message and write nothing", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("c1-policy-");
  yield* withThreadPolicy(directory, [], (store) => Effect.gen(function* () {
    const base = yield* store.get();
    const many = (count: number) => Array.from({ length: count }, (_, index) => `chat-${index}`);
    yield* rejects(store.save({ ...base, excludedThreadIds: many(501) }), invalidIds);
    yield* rejects(store.save({ ...base, excludedThreadIds: ["x".repeat(513)] }), invalidIds);
    yield* rejects(store.save({ ...base, excludedThreadIds: ["tab\tid"] }), invalidIds);
    yield* rejects(store.save({ ...base, excludedThreadIds: [""] }), invalidIds);
    yield* rejects(store.save({ ...base, excludedThreadIds: ["same", "same"] }), invalidIds);
    assert.deepEqual(yield* store.get(), base);
    // the limits themselves are accepted
    const limits = yield* store.save({ ...base, excludedThreadIds: [...many(499), "x".repeat(512)] });
    assert.equal(limits.generation, base.generation + 1);
    assert.equal((yield* store.get()).excludedThreadIds.length, 500);
  }));
}), { timeout: 10_000 });
