import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ThreadPolicyStore } from "../src/thread-policy.js";

test("chat policy persists and legacy deployment values never override a saved choice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-policy-"));
  let store = new ThreadPolicyStore(directory, { excludedThreadIds: ["teams"], interactiveThreadId: "router" });
  try {
    const previous = store.get();
    const saved = store.save({ ...previous, excludedThreadIds: [], interactiveThreadId: null });
    assert.throws(() => store.save(previous), /another tab/);
    assert.throws(() => store.save({ ...saved, excludedThreadIds: ["invalid id"] }), /valid/);
    assert.throws(() => store.save({ ...saved, excludedThreadIds: ["teams", "teams"] }), /unique/);
    store.close();
    store = new ThreadPolicyStore(directory, { excludedThreadIds: ["legacy"], interactiveThreadId: "legacy-router" });
    assert.deepEqual(store.get(), saved);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
