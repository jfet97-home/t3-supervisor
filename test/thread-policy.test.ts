import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { failsWith } from "./support/guidance-store-services.js";
import { dataDirectory, withThreadPolicy } from "./support/g9-stores.js";

// the ThreadPolicyStore service over a temporary thread-settings.sqlite3 (its production client and layer)

it.effect("excluded-thread policy persists and uses compare-and-swap generations", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-policy-");
  const saved = yield* withThreadPolicy(directory, ["excluded"], (store) => Effect.gen(function* () {
    const previous = yield* store.get();
    const saved = yield* store.save({...previous, excludedThreadIds: []});
    yield* failsWith(store.save(previous), /another tab/u);
    yield* failsWith(store.save({...saved, excludedThreadIds: ["invalid id"]}), /valid/u);
    yield* failsWith(store.save({...saved, excludedThreadIds: ["excluded", "excluded"]}), /unique/u);
    return saved;
  }));
  // the first client closed; the store reopens on the same file with a different configured seed
  yield* withThreadPolicy(directory, ["new-default"], (store) => Effect.gen(function* () {
    assert.deepEqual(yield* store.get(), saved);
  }));
}));
