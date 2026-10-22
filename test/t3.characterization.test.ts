import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { Cause, Context, Effect, Exit, Fiber, Layer } from "effect";
import { it } from "vitest";
import type { WebSocket } from "ws";
import { makeT3Client, T3Client, T3TransportError, type T3ClientOptions } from "../src/t3.js";
import type { JsonRecord, SourceItem } from "../src/types.js";
import { released } from "./support/http.js";
import { deferred, frameHeader, startHungHandshakeT3, startMockT3, startRawWebSocketT3, textFrame, within } from "./support/c3a-fake-t3.js";

const token = "read-scope-test-token";

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getClient = async (baseUrl: string, extra: Omit<T3ClientOptions, "baseUrl" | "token"> = {}) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(makeT3Client({ baseUrl, token, ...extra }));
    return Context.get(context, T3Client);
  })));

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
};

const update = (sequence: number): JsonRecord => ({ kind: "thread.updated", sequence, thread: { id: `thread-${sequence}` } });
const chunk = (requestId: "1" | "2", ...sequences: number[]): JsonRecord => ({ _tag: "Chunk", requestId, values: sequences.map(update) });

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  assert.ok(Exit.isFailure(exit), "the watch failed");
  return Cause.squash(exit.cause);
};

const subscribed = (payload: Buffer): boolean => payload.toString("utf8").includes("orchestration.subscribeArchivedShell");

it("CT-T3-01: a second chunk is neither processed nor acknowledged before the first chunk's ACK", { timeout: 10_000 }, async () => {
  const acknowledgements: string[] = [];
  const acknowledged = [deferred<void>(), deferred<void>()];
  const framesSent = deferred<void>();
  const server = await startMockT3((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    let requests = 0;
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!isRecord(frame)) return;
      if (frame._tag === "Ack" && typeof frame.requestId === "string") {
        acknowledgements.push(frame.requestId);
        acknowledged[acknowledgements.length - 1]?.resolve();
      }
      if (frame._tag !== "Request" || ++requests !== 2) return;
      // two separate frames: the active chunk, then the archive chunk
      socket.send(JSON.stringify(chunk("1", 1)), (first) => {
        if (first) return framesSent.reject(first);
        socket.send(JSON.stringify(chunk("2", 2)), (second) => second ? framesSent.reject(second) : framesSent.resolve());
      });
    });
  });
  const processed: string[] = [];
  const started = [deferred<void>(), deferred<void>()];
  const releases: Array<() => void> = [];
  try {
    const client = await getClient(server.baseUrl);
    const fiber = Effect.runFork(client.watch(undefined, (item: SourceItem) => Effect.callback<void>((resume) => {
      processed.push(item.stream);
      releases.push(() => resume(Effect.void));
      started[processed.length - 1]?.resolve();
    })));
    try {
      await within(started[0]!.promise, 2500, "first onItem");
      await within(framesSent.promise, 2500, "both chunks sent");
      // a full loopback round trip after the second chunk was written gives an unpaused reader every chance to take it
      assert.equal((await fetch(`${server.baseUrl}/barrier`).then(released)).status, 404);
      assert.deepEqual(processed, ["active"]);
      assert.deepEqual(acknowledgements, []);

      releases[0]!();
      await within(acknowledged[0]!.promise, 2500, "first ACK");
      await within(started[1]!.promise, 2500, "second onItem");
      // the second chunk's ingestion is still held, so its ACK has not been sent
      assert.deepEqual(acknowledgements, ["1"]);
      assert.deepEqual(processed, ["active", "archive"]);

      releases[1]!();
      await within(acknowledged[1]!.promise, 2500, "second ACK");
      assert.deepEqual(acknowledgements, ["1", "2"]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  } finally {
    await server.close();
  }
});

it("CT-T3-02: nine frames in one TCP write trip the buffered-frame limit and an oversized frame hits maxPayload", { timeout: 10_000 }, async () => {
  const nineFrames = Buffer.concat(Array.from({ length: 9 }, (_, index) => textFrame(JSON.stringify(chunk("1", index + 1)))));

  // onItem blocks on the first frame: the ninth buffered frame terminates the connection without any ACK
  {
    const peer = await startRawWebSocketT3();
    try {
      const client = await getClient(peer.baseUrl);
      const sequences: unknown[] = [];
      const releases: Array<() => void> = [];
      const fiber = Effect.runFork(client.watch(undefined, (item) => Effect.callback<void>((resume) => {
        sequences.push(item.item.sequence);
        releases.push(() => resume(Effect.void));
      })));
      try {
        const connection = await within(peer.connection, 2500, "websocket upgrade");
        await within(connection.frame((frame) => subscribed(frame.payload)), 2500, "subscriptions");
        connection.socket.write(nineFrames);
        await within(connection.gone, 2500, "client terminating the connection");
        assert.deepEqual(sequences, [1]);
        assert.deepEqual(connection.frames.map((frame) => JSON.parse(frame.payload.toString("utf8")) as JsonRecord)
          .map((frame) => [frame._tag, frame.id]), [["Request", "1"], ["Request", "2"]]);
        // a bounded absence window: while onItem is blocked the watch reports nothing
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        assert.equal(fiber.pollUnsafe(), undefined);

        // once onItem returns, the ACK finds the terminated socket and the watch fails with that send error
        releases[0]!();
        const failure = failureOf(await within(Effect.runPromise(Fiber.await(fiber)), 2500, "watch failure"));
        assert.ok(failure instanceof T3TransportError);
        assert.equal(failure.message, "T3 websocket is not open");
        assert.deepEqual(sequences, [1]);
        assert.equal(connection.frames.length, 2);
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
    } finally {
      await peer.close();
    }
  }

  // onItem completes at once: the watch fails with the byte-limit error after acknowledging only the first frame
  {
    const peer = await startRawWebSocketT3();
    try {
      const client = await getClient(peer.baseUrl);
      const sequences: unknown[] = [];
      const fiber = Effect.runFork(client.watch(undefined, (item) => Effect.sync(() => {
        sequences.push(item.item.sequence);
      })));
      const connection = await within(peer.connection, 2500, "websocket upgrade");
      await within(connection.frame((frame) => subscribed(frame.payload)), 2500, "subscriptions");
      connection.socket.write(nineFrames);
      const failure = failureOf(await within(Effect.runPromise(Fiber.await(fiber)), 2500, "watch failure"));
      assert.ok(failure instanceof T3TransportError);
      assert.equal(failure.message, "T3 websocket message exceeded the byte limit");
      assert.deepEqual(sequences, [1]);
      await within(connection.gone, 2500, "client terminating the connection");
      assert.deepEqual(connection.frames.slice(2).map((frame) => frame.payload.toString("utf8")), ['{"_tag":"Ack","requestId":"1"}']);
    } finally {
      await peer.close();
    }
  }

  // a frame declaring one byte over 32 MiB is rejected by ws maxPayload: close code 1009 and the websocket failure
  {
    const peer = await startRawWebSocketT3();
    try {
      const client = await getClient(peer.baseUrl);
      let items = 0;
      const fiber = Effect.runFork(client.watch(undefined, () => Effect.sync(() => {items++;})));
      const connection = await within(peer.connection, 2500, "websocket upgrade");
      await within(connection.frame((frame) => subscribed(frame.payload)), 2500, "subscriptions");
      connection.socket.write(Buffer.concat([frameHeader(32 * 1024 * 1024 + 1), Buffer.alloc(64 * 1024, 0x20)]));
      const failure = failureOf(await within(Effect.runPromise(Fiber.await(fiber)), 2500, "watch failure"));
      assert.ok(failure instanceof T3TransportError);
      assert.equal(failure.message, "T3 websocket failed");
      assert.equal(items, 0);
      const close = await within(connection.frame((frame) => frame.opcode === 0x8), 2500, "client close frame");
      assert.equal(close.payload.readUInt16BE(0), 1009);
      await within(connection.gone, 2500, "client closing the connection");
    } finally {
      await peer.close();
    }
  }
});

it("CT-T3-03: interrupting watch during a pending handshake terminates the socket without an uncaught error", { timeout: 10_000 }, async () => {
  const uncaught: unknown[] = [];
  const record = (error: unknown) => {uncaught.push(error);};
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  const server = await startHungHandshakeT3();
  try {
    // the default 10 s handshake bound stays far away, so only the interruption can end the attempt
    const client = await getClient(server.baseUrl);
    const fiber = Effect.runFork(client.watch(undefined, () => Effect.void));
    const accepted = await within(server.accepted, 2500, "upgrade request");
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    // ws emits the aborted handshake's error on a later tick; the peer only sees the socket end after that
    await within(accepted.gone, 2500, "client terminating the handshake socket");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", record);
    process.off("unhandledRejection", record);
    await server.close();
  }
});

it("CT-T3-04: binary and non-JSON frames fail with fixed messages and nested arrays flatten in order up to the visit bound", { timeout: 10_000 }, async () => {
  const failingWatch = async (send: (socket: WebSocket) => void) => {
    const server = await startMockT3((_request, response) => sendJson(response, 404, {}));
    server.webSockets.on("connection", (socket) => {
      let requests = 0;
      socket.on("message", () => {if (++requests === 2) send(socket);});
    });
    try {
      const client = await getClient(server.baseUrl);
      return failureOf(await within(Effect.runPromiseExit(client.watch(undefined, () => Effect.void)), 2500, "watch failure"));
    } finally {
      await server.close();
    }
  };
  const binary = await failingWatch((socket) => socket.send(Buffer.from(JSON.stringify(chunk("1", 1))), { binary: true }));
  assert.ok(binary instanceof T3TransportError);
  assert.equal(binary.message, "T3 websocket sent a binary message");
  const text = await failingWatch((socket) => socket.send("not protocol json"));
  assert.ok(text instanceof T3TransportError);
  assert.equal(text.message, "T3 websocket message was not valid protocol JSON");

  // flattening visits every array and record; 8 * 1024 visits are accepted and one more rejects the frame
  const pongs = (count: number) => Array.from({ length: count }, () => ({ _tag: "Pong" }));
  const deep = (depth: number, value: unknown): string => "[".repeat(depth) + JSON.stringify(value) + "]".repeat(depth);
  const frames = [
    JSON.stringify([[chunk("1", 1), [chunk("1", 2)]], [[[chunk("2", 3)]]], chunk("1", 4)]),
    JSON.stringify([...pongs(8190), chunk("1", 5)]),
    deep(8191, chunk("2", 6)),
    JSON.stringify([...pongs(8191), chunk("1", 7)]),
  ];
  const acknowledgements: string[] = [];
  const server = await startMockT3((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    let requests = 0;
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (isRecord(frame) && frame._tag === "Ack" && typeof frame.requestId === "string") acknowledgements.push(frame.requestId);
      if (isRecord(frame) && frame._tag === "Request" && ++requests === 2) for (const value of frames) socket.send(value);
    });
  });
  try {
    const client = await getClient(server.baseUrl);
    const items: Array<[string, unknown]> = [];
    const failure = failureOf(await within(Effect.runPromiseExit(client.watch(undefined, (item) => Effect.sync(() => {
      items.push([item.stream, item.item.sequence]);
    }))), 2500, "watch failure"));
    assert.ok(failure instanceof T3TransportError);
    assert.equal(failure.message, "T3 websocket message was not valid protocol JSON");
    assert.deepEqual(items, [["active", 1], ["active", 2], ["archive", 3], ["active", 4], ["active", 5], ["archive", 6]]);
    assert.deepEqual(acknowledgements, ["1", "1", "2", "1", "1", "2"]);
  } finally {
    await server.close();
  }
});

it("CT-T3-05: the oversized projection memo evicts the oldest thread after 512 distinct threads", { timeout: 10_000 }, async () => {
  const reads = new Map<string, number>();
  const server = await startMockT3((request, response) => {
    const threadId = decodeURIComponent(request.url?.split("/").pop() ?? "");
    reads.set(threadId, (reads.get(threadId) ?? 0) + 1);
    // the announced length exceeds the transfer budget, so the client rejects before reading the body
    response.writeHead(200, { "content-type": "application/json", "content-length": "2048" });
    response.end("x".repeat(2048));
  });
  try {
    const client = await getClient(server.baseUrl, { maxResponseBytes: 1024, maxProjectionTransferBytes: 1024 });
    const tooLarge = async (threadId: string) => {
      const failure = failureOf(await Effect.runPromiseExit(client.projection(threadId)));
      assert.ok(failure instanceof T3TransportError && failure.code === "response_too_large");
      assert.equal(failure.message, "T3 thread projection response exceeded the byte limit");
    };
    const total = () => [...reads.values()].reduce((sum, count) => sum + count, 0);
    for (let index = 0; index < 512; index++) await tooLarge(`thread-${index}`);
    assert.equal(total(), 512);
    await tooLarge("thread-0");
    await tooLarge("thread-511");
    assert.equal(total(), 512, "all 512 oversized threads are memoized");

    await tooLarge("thread-512");
    assert.equal(total(), 513);
    await tooLarge("thread-1");
    await tooLarge("thread-512");
    assert.equal(total(), 513, "the second-oldest and the newest stay memoized");
    await tooLarge("thread-0");
    assert.equal(reads.get("thread-0"), 2, "the oldest thread was evicted and is read again");
    assert.equal(total(), 514);
  } finally {
    await server.close();
  }
});
