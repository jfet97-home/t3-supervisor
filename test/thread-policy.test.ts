import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ThreadPolicyStore } from "../src/thread-policy.js";

test("excluded-thread policy persists and uses compare-and-swap generations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-policy-"));
  let store = new ThreadPolicyStore(directory, {excludedThreadIds: ["excluded"]});
  try {
    const previous = store.get();
    const saved = store.save({...previous, excludedThreadIds: []});
    assert.throws(() => store.save(previous), /another tab/u);
    assert.throws(() => store.save({...saved, excludedThreadIds: ["invalid id"]}), /valid/u);
    assert.throws(() => store.save({...saved, excludedThreadIds: ["excluded", "excluded"]}), /unique/u);
    store.close();
    store = new ThreadPolicyStore(directory, {excludedThreadIds: ["new-default"]});
    assert.deepEqual(store.get(), saved);
  } finally {store.close(); await rm(directory, {recursive: true, force: true});}
});
