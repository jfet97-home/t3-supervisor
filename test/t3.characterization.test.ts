import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { WebSocket } from "ws";
import { makeT3Client, T3Client, T3TransportError, type T3ClientOptions } from "../src/t3.js";
import type { JsonRecord, SourceItem } from "../src/types.js";
import { frameHeader, textFrame } from "./support/g8-peers.js";
import { hungHandshakeT3, mockT3, rawWebSocketT3 } from "./support/g8-peers.js";
import { loopTurn, within } from "./support/g8-process.js";

// the T3 client against loopback peers over real sockets: live (it.live), every awaited loopback event bounded on the
// live clock

const token = "read-scope-test-token";

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// the client of a layer built and released at once, as src/main.ts reads it
const getClient = (baseUrl: string, extra: Omit<T3ClientOptions, "baseUrl" | "token"> = {}) =>
  Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(makeT3Client({ baseUrl, token, ...extra }));
    return Context.get(context, T3Client);
  }));

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

// one loopback request whose answer is read to its end; its status
const barrier = (url: string) => Effect.gen(function* () {
  const response = yield* (yield* HttpClient.HttpClient).get(url);
  yield* response.text;
  return response.status;
}).pipe(Effect.orDie, Effect.provide(FetchHttpClient.layer));

it.live("CT-T3-01: a second chunk is neither processed nor acknowledged before the first chunk's ACK", () => Effect.gen(function* () {
  const acknowledgements: string[] = [];
  const acknowledged = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
  const framesSent = Deferred.makeUnsafe<void, Error>();
  const server = yield* mockT3((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    let requests = 0;
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!isRecord(frame)) return;
      if (frame._tag === "Ack" && typeof frame.requestId === "string") {
        acknowledgements.push(frame.requestId);
        const next = acknowledged[acknowledgements.length - 1];
        if (next) Deferred.doneUnsafe(next, Exit.void);
      }
      if (frame._tag !== "Request" || ++requests !== 2) return;
      // two separate frames: the active chunk, then the archive chunk
      socket.send(JSON.stringify(chunk("1", 1)), (first) => {
        if (first) return Deferred.doneUnsafe(framesSent, Exit.fail(first));
        socket.send(JSON.stringify(chunk("2", 2)), (second) => Deferred.doneUnsafe(framesSent, second ? Exit.fail(second) : Exit.void));
      });
    });
  });
  const processed: string[] = [];
  const started = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
  const releases: Array<() => void> = [];
  const client = yield* getClient(server.baseUrl);
  // interrupted with the test's scope, before the peer closes
  yield* Effect.forkScoped(client.watch(undefined, (item: SourceItem) => Effect.callback<void>((resume) => {
    processed.push(item.stream);
    releases.push(() => resume(Effect.void));
    const next = started[processed.length - 1];
    if (next) Deferred.doneUnsafe(next, Exit.void);
  })));
  yield* within(Deferred.await(started[0]!), 2500, "first onItem");
  yield* within(Deferred.await(framesSent), 2500, "both chunks sent");
  // a full loopback round trip after the second chunk was written gives an unpaused reader every chance to take it
  assert.equal(yield* barrier(`${server.baseUrl}/barrier`), 404);
  assert.deepEqual(processed, ["active"]);
  assert.deepEqual(acknowledgements, []);

  releases[0]!();
  yield* within(Deferred.await(acknowledged[0]!), 2500, "first ACK");
  yield* within(Deferred.await(started[1]!), 2500, "second onItem");
  // the second chunk's ingestion is still held, so its ACK has not been sent
  assert.deepEqual(acknowledgements, ["1"]);
  assert.deepEqual(processed, ["active", "archive"]);

  releases[1]!();
  yield* within(Deferred.await(acknowledged[1]!), 2500, "second ACK");
  assert.deepEqual(acknowledgements, ["1", "2"]);
}), { timeout: 10_000 });

it.live("CT-T3-02: nine frames in one TCP write trip the buffered-frame limit and an oversized frame hits maxPayload", () => Effect.gen(function* () {
  const nineFrames = Buffer.concat(Array.from({ length: 9 }, (_, index) => textFrame(JSON.stringify(chunk("1", index + 1)))));

  // onItem blocks on the first frame: the ninth buffered frame terminates the connection without any ACK
  yield* Effect.scoped(Effect.gen(function* () {
    const peer = yield* rawWebSocketT3;
    const client = yield* getClient(peer.baseUrl);
    const sequences: unknown[] = [];
    const releases: Array<() => void> = [];
    const fiber = yield* Effect.forkScoped(client.watch(undefined, (item) => Effect.callback<void>((resume) => {
      sequences.push(item.item.sequence);
      releases.push(() => resume(Effect.void));
    })));
    const connection = yield* within(peer.connection, 2500, "websocket upgrade");
    yield* within(connection.frame((frame) => subscribed(frame.payload)), 2500, "subscriptions");
    connection.socket.write(nineFrames);
    yield* within(connection.gone, 2500, "client terminating the connection");
    assert.deepEqual(sequences, [1]);
    assert.deepEqual(connection.frames.map((frame) => JSON.parse(frame.payload.toString("utf8")) as JsonRecord)
      .map((frame) => [frame._tag, frame.id]), [["Request", "1"], ["Request", "2"]]);
    // a bounded absence window: while onItem is blocked the watch reports nothing
    yield* Effect.sleep("250 millis");
    assert.equal(fiber.pollUnsafe(), undefined);

    // once onItem returns, the ACK finds the terminated socket and the watch fails with that send error
    releases[0]!();
    const failure = failureOf(yield* within(Fiber.await(fiber), 2500, "watch failure"));
    assert.ok(failure instanceof T3TransportError);
    assert.equal(failure.message, "T3 websocket is not open");
    assert.deepEqual(sequences, [1]);
    assert.equal(connection.frames.length, 2);
  }));

  // onItem completes at once: the watch fails with the byte-limit error after acknowledging only the first frame
  yield* Effect.scoped(Effect.gen(function* () {
    const peer = yield* rawWebSocketT3;
    const client = yield* getClient(peer.baseUrl);
    const sequences: unknown[] = [];
    const fiber = yield* Effect.forkScoped(client.watch(undefined, (item) => Effect.sync(() => {
      sequences.push(item.item.sequence);
    })));
    const connection = yield* within(peer.connection, 2500, "websocket upgrade");
    yield* within(connection.frame((frame) => subscribed(frame.payload)), 2500, "subscriptions");
    connection.socket.write(nineFrames);
    const failure = failureOf(yield* within(Fiber.await(fiber), 2500, "watch failure"));
    assert.ok(failure instanceof T3TransportError);
    assert.equal(failure.message, "T3 websocket message exceeded the byte limit");
    assert.deepEqual(sequences, [1]);
    yield* within(connection.gone, 2500, "client terminating the connection");
    assert.deepEqual(connection.frames.slice(2).map((frame) => frame.payload.toString("utf8")), ['{"_tag":"Ack","requestId":"1"}']);
  }));

  // a frame declaring one byte over 32 MiB is rejected by ws maxPayload: close code 1009 and the websocket failure
  yield* Effect.scoped(Effect.gen(function* () {
    const peer = yield* rawWebSocketT3;
    const client = yield* getClient(peer.baseUrl);
    let items = 0;
    const fiber = yield* Effect.forkScoped(client.watch(undefined, () => Effect.sync(() => {items++;})));
    const connection = yield* within(peer.connection, 2500, "websocket upgrade");
    yield* within(connection.frame((frame) => subscribed(frame.payload)), 2500, "subscriptions");
    connection.socket.write(Buffer.concat([frameHeader(32 * 1024 * 1024 + 1), Buffer.alloc(64 * 1024, 0x20)]));
    const failure = failureOf(yield* within(Fiber.await(fiber), 2500, "watch failure"));
    assert.ok(failure instanceof T3TransportError);
    assert.equal(failure.message, "T3 websocket failed");
    assert.equal(items, 0);
    const close = yield* within(connection.frame((frame) => frame.opcode === 0x8), 2500, "client close frame");
    assert.equal(close.payload.readUInt16BE(0), 1009);
    yield* within(connection.gone, 2500, "client closing the connection");
  }));
}), { timeout: 10_000 });

it.live("CT-T3-03: interrupting watch during a pending handshake terminates the socket without an uncaught error", () => Effect.gen(function* () {
  const uncaught: unknown[] = [];
  const record = (error: unknown) => {uncaught.push(error);};
  // the process listeners stay registered until the test's scope closes the peer
  yield* Effect.acquireRelease(Effect.sync(() => {
    process.on("uncaughtException", record);
    process.on("unhandledRejection", record);
  }), () => Effect.sync(() => {
    process.off("uncaughtException", record);
    process.off("unhandledRejection", record);
  }));
  const server = yield* hungHandshakeT3;
  // the default 10 s handshake bound stays far away, so only the interruption can end the attempt
  const client = yield* getClient(server.baseUrl);
  const fiber = yield* Effect.forkScoped(client.watch(undefined, () => Effect.void));
  const accepted = yield* within(server.accepted, 2500, "upgrade request");
  yield* Fiber.interrupt(fiber);
  const exit = yield* Fiber.await(fiber);
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
  // ws emits the aborted handshake's error on a later tick; the peer only sees the socket end after that
  yield* within(accepted.gone, 2500, "client terminating the handshake socket");
  yield* loopTurn;
  assert.deepEqual(uncaught, []);
}), { timeout: 10_000 });

it.live("CT-T3-04: binary and non-JSON frames fail with fixed messages and nested arrays flatten in order up to the visit bound", () => Effect.gen(function* () {
  const failingWatch = (send: (socket: WebSocket) => void) => Effect.scoped(Effect.gen(function* () {
    const server = yield* mockT3((_request, response) => sendJson(response, 404, {}));
    server.webSockets.on("connection", (socket) => {
      let requests = 0;
      socket.on("message", () => {if (++requests === 2) send(socket);});
    });
    const client = yield* getClient(server.baseUrl);
    return failureOf(yield* within(Effect.exit(client.watch(undefined, () => Effect.void)), 2500, "watch failure"));
  }));
  const binary = yield* failingWatch((socket) => socket.send(Buffer.from(JSON.stringify(chunk("1", 1))), { binary: true }));
  assert.ok(binary instanceof T3TransportError);
  assert.equal(binary.message, "T3 websocket sent a binary message");
  const text = yield* failingWatch((socket) => socket.send("not protocol json"));
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
  const server = yield* mockT3((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    let requests = 0;
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (isRecord(frame) && frame._tag === "Ack" && typeof frame.requestId === "string") acknowledgements.push(frame.requestId);
      if (isRecord(frame) && frame._tag === "Request" && ++requests === 2) for (const value of frames) socket.send(value);
    });
  });
  const client = yield* getClient(server.baseUrl);
  const items: Array<[string, unknown]> = [];
  const failure = failureOf(yield* within(Effect.exit(client.watch(undefined, (item) => Effect.sync(() => {
    items.push([item.stream, item.item.sequence]);
  }))), 2500, "watch failure"));
  assert.ok(failure instanceof T3TransportError);
  assert.equal(failure.message, "T3 websocket message was not valid protocol JSON");
  assert.deepEqual(items, [["active", 1], ["active", 2], ["archive", 3], ["active", 4], ["active", 5], ["archive", 6]]);
  assert.deepEqual(acknowledgements, ["1", "1", "2", "1", "1", "2"]);
}), { timeout: 10_000 });

it.live("CT-T3-05: the oversized projection memo evicts the oldest thread after 512 distinct threads", () => Effect.gen(function* () {
  const reads = new Map<string, number>();
  const server = yield* mockT3((request, response) => {
    const threadId = decodeURIComponent(request.url?.split("/").pop() ?? "");
    reads.set(threadId, (reads.get(threadId) ?? 0) + 1);
    // the announced length exceeds the transfer budget, so the client rejects before reading the body
    response.writeHead(200, { "content-type": "application/json", "content-length": "2048" });
    response.end("x".repeat(2048));
  });
  const client = yield* getClient(server.baseUrl, { maxResponseBytes: 1024, maxProjectionTransferBytes: 1024 });
  const tooLarge = (threadId: string) => Effect.gen(function* () {
    const failure = failureOf(yield* Effect.exit(client.projection(threadId)));
    assert.ok(failure instanceof T3TransportError && failure.code === "response_too_large");
    assert.equal(failure.message, "T3 thread projection response exceeded the byte limit");
  });
  const total = () => [...reads.values()].reduce((sum, count) => sum + count, 0);
  for (let index = 0; index < 512; index++) yield* tooLarge(`thread-${index}`);
  assert.equal(total(), 512);
  yield* tooLarge("thread-0");
  yield* tooLarge("thread-511");
  assert.equal(total(), 512, "all 512 oversized threads are memoized");

  yield* tooLarge("thread-512");
  assert.equal(total(), 513);
  yield* tooLarge("thread-1");
  yield* tooLarge("thread-512");
  assert.equal(total(), 513, "the second-oldest and the newest stay memoized");
  yield* tooLarge("thread-0");
  assert.equal(reads.get("thread-0"), 2, "the oldest thread was evicted and is read again");
  assert.equal(total(), 514);
}), { timeout: 10_000 });
