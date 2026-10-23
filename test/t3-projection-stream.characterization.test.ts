import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { makeT3Client, T3Client } from "../src/t3.js";
import { readProjectionSnapshot } from "../src/t3-projection-stream.js";
import { mockT3 } from "./support/g8-peers.js";
import { loopTurn, within } from "./support/g8-process.js";

// the projection reader over a counting web stream, then t3.projection against a loopback peer over a real socket:
// live (it.live), every awaited loopback event bounded on the live clock

const encoder = new TextEncoder();

const snapshotBody = (threadId: string, rows: number) => ({
  snapshotSequence: 17,
  projection: {
    thread: { id: threadId, title: "Main", projectId: "p", lineage: { parentThreadId: null, relationshipToParent: null } },
    runs: [],
    messages: Array.from({ length: rows }, (_, index) => ({ id: `m${index}`, runId: null, nodeId: null, role: "user",
      text: "t".repeat(200), streaming: false, createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-20T10:00:00Z" })),
  },
});

const budget = { retainedBytes: 1 << 20, transferBytes: 4 << 20, deadline: Number.POSITIVE_INFINITY };

it.live("CT-T3-06: interrupting an in-flight read cancels the body reader, stops pulling and yields no partial value", () => Effect.gen(function* () {
  // fiber interruption seam: a counting stream whose third pull interrupts the reading fiber; the reader cancels it
  const bytes = encoder.encode(JSON.stringify(snapshotBody("main", 20)));
  let pulls = 0;
  let pullsAtCancel: number | undefined;
  const reading: { fiber?: Fiber.Fiber<unknown, unknown> } = {};
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      pulls++;
      if (pulls === 3) reading.fiber?.interruptUnsafe();
      stream.enqueue(bytes.slice((pulls - 1) * 64, pulls * 64));
      if (pulls * 64 >= bytes.length) stream.close();
    },
    cancel() {
      pullsAtCancel = pulls;
    },
  });
  reading.fiber = yield* Effect.forkChild(readProjectionSnapshot(body, budget));
  const read = yield* Fiber.await(reading.fiber);
  assert.ok(Exit.isFailure(read) && Cause.hasInterruptsOnly(read.cause), "the interrupted read yields no partial value");
  assert.ok(pulls * 64 < bytes.length, "the body was interrupted before its end");
  assert.equal(pullsAtCancel, pulls, "the reader cancelled the source");
  // a cancelled stream is closed, so no later turn can pull again
  yield* loopTurn;
  assert.equal(pulls, pullsAtCancel);

  // fiber interruption of t3.projection against a slow real http body
  const text = JSON.stringify(snapshotBody("thread-1", 200));
  const firstPartWritten = Deferred.makeUnsafe<void>();
  const responseClosed = Deferred.makeUnsafe<boolean>();
  const server = yield* mockT3((request, response) => {
    if (request.url === "/barrier") {
      response.writeHead(404).end();
      return;
    }
    // the body stops after its first part and only ends if the client keeps reading
    response.once("close", () => Deferred.doneUnsafe(responseClosed, Exit.succeed(response.writableEnded)));
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.write(text.slice(0, 4096), () => Deferred.doneUnsafe(firstPartWritten, Exit.void));
  });
  const client = yield* Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(makeT3Client({ baseUrl: server.baseUrl, token: "read-scope-test-token" }));
    return Context.get(context, T3Client);
  }));
  const fiber = yield* Effect.forkScoped(client.projection("thread-1"));
  yield* within(Deferred.await(firstPartWritten), 2500, "first body part");
  // a loopback round trip after the first part lets the client take the headers and the part and wait for more
  const barrier = yield* (yield* HttpClient.HttpClient).get(`${server.baseUrl}/barrier`).pipe(Effect.orDie);
  yield* Effect.orDie(barrier.text);
  assert.equal(barrier.status, 404);
  yield* Fiber.interrupt(fiber);
  const exit = yield* Fiber.await(fiber);
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "the interrupted read yields no value");
  assert.equal(yield* within(Deferred.await(responseClosed), 2500, "client cancelling the body"), false, "the body never completed");
}).pipe(Effect.provide(FetchHttpClient.layer)), { timeout: 10_000 });
