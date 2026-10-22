import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "vitest";
import { ThreadPolicyStore } from "../src/thread-policy.js";
import { after } from "./support/node-test.js";

const invalidIds = { message: "Choose valid, unique chat IDs." };
const conflict = { message: "Chat settings changed in another tab. Reload first." };

const temporaryDirectory = async (t: TestContext): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "c1-policy-"));
  after(t, () => rm(directory, { recursive: true, force: true }));
  return directory;
};

it("CT-POLICY-01: two stores on one file saving the same generation concurrently commit exactly one", { timeout: 10_000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const first = new ThreadPolicyStore(directory, { excludedThreadIds: ["seed"] });
  const second = new ThreadPolicyStore(directory, { excludedThreadIds: ["ignored-seed"] });
  after(t, () => {
    first.close();
    second.close();
  });
  const base = first.get();
  assert.deepEqual(second.get(), base);
  const results = await Promise.allSettled([
    Promise.resolve().then(() => first.save({ ...base, excludedThreadIds: ["from-first"] })),
    Promise.resolve().then(() => second.save({ ...base, excludedThreadIds: ["from-second"] })),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reason instanceof Error ? rejected[0].reason.message : rejected[0]?.reason, conflict.message);
  const winner = fulfilled[0]?.value;
  assert.deepEqual(winner, { generation: base.generation + 1, excludedThreadIds: ["from-first"] });
  assert.deepEqual(first.get(), winner);
  assert.deepEqual(second.get(), winner);
  // the losing store succeeds only after reloading the committed generation
  assert.deepEqual(second.save({ ...second.get(), excludedThreadIds: ["from-second"] }), { generation: base.generation + 2, excludedThreadIds: ["from-second"] });
  assert.deepEqual(first.get(), { generation: base.generation + 2, excludedThreadIds: ["from-second"] });
});

it("CT-POLICY-02: 501 ids, a 513-character id and an id with a tab are rejected with the exact message and write nothing", { timeout: 10_000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new ThreadPolicyStore(directory, { excludedThreadIds: [] });
  after(t, () => store.close());
  const base = store.get();
  const many = (count: number) => Array.from({ length: count }, (_, index) => `chat-${index}`);
  assert.throws(() => store.save({ ...base, excludedThreadIds: many(501) }), invalidIds);
  assert.throws(() => store.save({ ...base, excludedThreadIds: ["x".repeat(513)] }), invalidIds);
  assert.throws(() => store.save({ ...base, excludedThreadIds: ["tab\tid"] }), invalidIds);
  assert.throws(() => store.save({ ...base, excludedThreadIds: [""] }), invalidIds);
  assert.throws(() => store.save({ ...base, excludedThreadIds: ["same", "same"] }), invalidIds);
  assert.deepEqual(store.get(), base);
  // the limits themselves are accepted
  const limits = store.save({ ...base, excludedThreadIds: [...many(499), "x".repeat(512)] });
  assert.equal(limits.generation, base.generation + 1);
  assert.equal(store.get().excludedThreadIds.length, 500);
});
