import assert from "node:assert/strict";
import { Cause, Context, Effect, Exit, Fiber, Layer } from "effect";
import { it } from "vitest";
import { makeT3Client, T3Client } from "../src/t3.js";
import { ProjectionStreamError, readProjectionSnapshot } from "../src/t3-projection-stream.js";
import { released } from "./support/http.js";
import { deferred, startMockT3, within } from "./support/c3a-fake-t3.js";

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

it("CT-T3-06: interrupting an in-flight read cancels the body reader, stops pulling and yields no partial value", { timeout: 10_000 }, async () => {
  // abort signal seam: a counting stream that the reader cancels once the read is interrupted
  const controller = new AbortController();
  const bytes = encoder.encode(JSON.stringify(snapshotBody("main", 20)));
  let pulls = 0;
  let pullsAtCancel: number | undefined;
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      pulls++;
      if (pulls === 3) controller.abort();
      stream.enqueue(bytes.slice((pulls - 1) * 64, pulls * 64));
      if (pulls * 64 >= bytes.length) stream.close();
    },
    cancel() {
      pullsAtCancel = pulls;
    },
  });
  let value: unknown;
  let failure: unknown;
  await Effect.runPromise(readProjectionSnapshot(body, budget, controller.signal)).then((result) => {value = result;}, (error: unknown) => {failure = error;});
  assert.equal(value, undefined);
  assert.ok(failure instanceof ProjectionStreamError);
  assert.equal(failure.code, "interrupted");
  assert.ok(pulls * 64 < bytes.length, "the body was interrupted before its end");
  assert.equal(pullsAtCancel, pulls, "the reader cancelled the source");
  // a cancelled stream is closed, so no later turn can pull again
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pulls, pullsAtCancel);

  // fiber interruption of t3.projection against a slow real http body
  const text = JSON.stringify(snapshotBody("thread-1", 200));
  const firstPartWritten = deferred<void>();
  const responseClosed = deferred<boolean>();
  const server = await startMockT3((request, response) => {
    if (request.url === "/barrier") {
      response.writeHead(404).end();
      return;
    }
    // the body stops after its first part and only ends if the client keeps reading
    response.once("close", () => responseClosed.resolve(response.writableEnded));
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.write(text.slice(0, 4096), () => firstPartWritten.resolve());
  });
  try {
    const client = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const context = yield* Layer.build(makeT3Client({ baseUrl: server.baseUrl, token: "read-scope-test-token" }));
      return Context.get(context, T3Client);
    })));
    const fiber = Effect.runFork(client.projection("thread-1"));
    await within(firstPartWritten.promise, 2500, "first body part");
    // a loopback round trip after the first part lets the client take the headers and the part and wait for more
    assert.equal((await fetch(`${server.baseUrl}/barrier`).then(released)).status, 404);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "the interrupted read yields no value");
    assert.equal(await within(responseClosed.promise, 2500, "client cancelling the body"), false, "the body never completed");
  } finally {
    await server.close();
  }
});
