import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { T3Client, makeT3Client } from "/app/dist/t3.js";
import { telegramRouteUpdateId, formatReplyParts } from "/app/dist/domain.js";
import { Store, makeStore } from "/app/dist/store.js";

const snapshot = await Effect.runPromise(Effect.gen(function* () {
  const client = yield* T3Client;
  return yield* client.projection("0a6bd46b-9003-45f9-8eff-52adcbf0814b");
}).pipe(Effect.provide(makeT3Client({
  baseUrl: "http://host.docker.internal:3773",
  token: readFileSync("/run/secrets/t3-read-token", "utf8").trim(),
})), Effect.scoped));
const run = snapshot.projection.runs.find((candidate) => candidate.ordinal === 9);
assert.ok(run);
assert.equal(telegramRouteUpdateId(snapshot.projection, run), 135456335);
const earlier = snapshot.projection.runs.find((candidate) => candidate.ordinal === 8);
assert.equal(telegramRouteUpdateId(snapshot.projection, earlier), null);
const parts = formatReplyParts(snapshot.projection, run, { id: "scanner", title: "scanner", workspaceRoot: "/workspace" });
assert.equal(parts.length, 1);
assert.ok(parts[0].endsWith("So we still have no production evidence that the new validation cleanup has run."));
const directory = await mkdtemp(join(tmpdir(), "forwarded-reply-probe-"));
try {
  await Effect.runPromise(Store.use((store) => Effect.gen(function* () {
    const id = yield* store.enqueueReply("fixture", snapshot.projection.thread.id, run.id, parts, 1_000);
    assert.ok(id);
    const jobs = yield* store.dueJobs(2_000);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].text, parts[0]);
    assert.equal(jobs[0].state, "ready");
    assert.equal(jobs[0].context, null);
    assert.equal(jobs[0].deliveryKey, `${id}-answer-1`);
  })).pipe(Effect.provide(makeStore(directory)), Effect.scoped));
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ probe: "actual_scanner_forwarded_answer", updateId: 135456335, fullAnswerPreserved: true, lunaCalls: 0, parts: parts.length, notificationsSent: 0 }));
