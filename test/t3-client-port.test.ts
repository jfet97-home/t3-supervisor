import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { describe, it } from "@effect/vitest";
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { makeT3Client, T3Client, T3TransportError, type T3ClientOptions } from "../src/t3.js";
import { ProjectionStreamError, readProjectionSnapshot } from "../src/t3-projection-stream.js";
import type { JsonRecord, SourceItem } from "../src/types.js";
import { deferred, startMockT3 } from "./support/c3a-fake-t3.js";
import { barrier, envelopePeer, type PeerFrame } from "./support/envelope-peer.js";

// target regressions of the effect port of src/t3.ts and src/t3-projection-stream.ts: exact watch wire frames, the
// heartbeat on the effect clock, monotonic deadlines under wall-clock jumps (CT-CLOCK-01) and interruption of a read

const token = "t3-port-test-token";
const encoder = new TextEncoder();

const clientOf = (baseUrl: string, extra: Omit<T3ClientOptions, "baseUrl" | "token"> = {}) =>
  Effect.map(Layer.build(makeT3Client({ baseUrl, token, ...extra })), (context) => Context.get(context, T3Client));

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<unknown, never, R> =>
  Effect.map(Effect.exit(effect), (exit) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined);

const requestText = (id: string, tag: string, payload: unknown) => JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] });
const subscribeShell = (payload: unknown) => requestText("1", "orchestration.subscribeShell", payload);
const subscribeArchive = requestText("2", "orchestration.subscribeArchivedShell", {});
const ackText = (requestId: string) => JSON.stringify({ _tag: "Ack", requestId });
const pingText = '{"_tag":"Ping"}';
const pongText = '{"_tag":"Pong"}';
const isArchiveRequest = (frame: PeerFrame) => frame.frame._tag === "Request" && frame.frame.id === "2";
const archiveSnapshot = { kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: 4, projects: [], threads: [] } };

const projectionBody = (threadId: string, padding: number): string => JSON.stringify({
  snapshotSequence: 3,
  projection: {
    thread: { id: threadId, title: "Port", projectId: null, lineage: { parentThreadId: null, relationshipToParent: null } },
    runs: [],
    messages: [],
    visibleTurnItems: Array.from({ length: Math.max(1, Math.ceil(padding / 1024)) }, (_, index) => ({ id: `row-${index}`, text: "v".repeat(1000) })),
  },
});

const mockT3 = (onHttp: (url: string, response: ServerResponse) => void) =>
  Effect.acquireRelease(Effect.promise(() => startMockT3((request, response) => onHttp(request.url ?? "", response))),
    (server) => Effect.promise(() => server.close()));

// the live clock, except that every wall-clock reading jumps an hour forward or back; monotonic time and sleeps are live
const wallJumping = Clock.clockWith((live) => Effect.sync((): Clock.Clock => {
  let readings = 0;
  const jump = () => (++readings % 2 === 0 ? 1 : -1) * 3_600_000;
  return {
    currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe() + jump(),
    currentTimeMillis: Effect.sync(() => live.currentTimeMillisUnsafe() + jump()),
    currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe() + BigInt(jump()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => live.currentTimeNanosUnsafe() + BigInt(jump()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  };
}));

// the live clock with monotonic time shifted by a settable offset; sleeps stay live, so no Effect timeout can fire early
const shiftedMonotonic = Clock.clockWith((live) => Effect.sync(() => {
  let offsetNanos = 0n;
  const monotonic = () => live.monotonicTimeNanosUnsafe() + offsetNanos;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
    currentTimeMillis: live.currentTimeMillis,
    currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
    currentTimeNanos: live.currentTimeNanos,
    monotonicTimeNanosUnsafe: monotonic,
    monotonicTimeNanos: Effect.sync(monotonic),
    sleep: (duration) => live.sleep(duration),
  };
  return { clock, shift: (millis: number) => {offsetNanos += BigInt(millis) * 1_000_000n;} };
}));

const monotonicMillis = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos) / 1_000_000);

describe("T3 watch wire", () => {
  it.live("T3-PORT-01: writes both Requests, answers Ping in order and acknowledges each chunk only after its items were ingested", () => Effect.gen(function*() {
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request" && frame.id === "2") socket.send(JSON.stringify([
        { _tag: "Ping" },
        { _tag: "Chunk", requestId: "1", values: [{ kind: "synchronized" }, { kind: "thread.removed", sequence: 9, threadId: "thread-9" }] },
        { _tag: "Chunk", requestId: "2", values: [archiveSnapshot] },
      ]));
    });
    const client = yield* clientOf(peer.baseUrl);
    const holding = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const items: SourceItem[] = [];
    const fiber = yield* Effect.forkChild(client.watch(7, (item) => Effect.gen(function*() {
      items.push(item);
      if (item.item.kind !== "synchronized") return;
      yield* Deferred.succeed(holding, undefined);
      yield* Deferred.await(release);
    })));
    yield* Deferred.await(holding);
    // a loopback round trip: anything the client wrote before it has been read by the peer
    yield* barrier(peer.baseUrl);
    assert.deepEqual(peer.texts(), [subscribeShell({ afterSequence: 7 }), subscribeArchive, pongText]);
    assert.deepEqual(items.map((item) => item.item.kind), ["synchronized"]);
    yield* Deferred.succeed(release, undefined);
    yield* peer.frame((frame) => frame.text === ackText("2"));
    assert.deepEqual(peer.texts(), [subscribeShell({ afterSequence: 7 }), subscribeArchive, pongText, ackText("1"), ackText("2")]);
    assert.deepEqual(items.map((item) => [item.stream, item.item.kind]),
      [["active", "synchronized"], ["active", "thread.removed"], ["archive", "snapshot"]]);
    assert.deepEqual(peer.upgrades, [{ url: "/ws?orchestrationProtocol=2", authorization: `Bearer ${token}` }]);
    yield* Fiber.interrupt(fiber);
    yield* peer.closed;
    assert.equal(peer.texts().length, 5, "interruption writes no frame");
  }), { timeout: 10_000 });

  it.live("T3-PORT-02: an unsupported chunk value fails the watch without an Ack after the earlier items were ingested", () => Effect.gen(function*() {
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request" && frame.id === "2") socket.send(JSON.stringify({ _tag: "Chunk", requestId: "1",
        values: [{ kind: "synchronized" }, { kind: "project.removed", sequence: 1, projectId: " " }] }));
    });
    const client = yield* clientOf(peer.baseUrl);
    const items: unknown[] = [];
    const failure = yield* failureOf(client.watch(undefined, (item) => Effect.sync(() => {items.push(item.item.kind);})));
    assert.ok(failure instanceof T3TransportError);
    assert.equal(failure.message, "T3 subscription item has an unsupported schema or shape");
    assert.deepEqual(items, ["synchronized"]);
    yield* peer.closed;
    assert.deepEqual(peer.texts(), [subscribeShell({}), subscribeArchive]);
  }), { timeout: 10_000 });
});

describe("T3 watch heartbeat on the effect clock", () => {
  const heartbeat = { heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 2500 };

  it.effect("T3-PORT-03: the first Ping leaves one interval after open and an unanswered Ping fails the watch exactly at its timeout", () => Effect.gen(function*() {
    const peer = yield* envelopePeer();
    const client = yield* clientOf(peer.baseUrl, heartbeat);
    const fiber = yield* Effect.forkChild(failureOf(client.watch(undefined, () => Effect.void)));
    yield* peer.frame(isArchiveRequest);
    yield* TestClock.adjust("999 millis");
    yield* barrier(peer.baseUrl);
    assert.deepEqual(peer.texts(), [subscribeShell({}), subscribeArchive]);
    yield* TestClock.adjust("1 millis");
    yield* peer.frame((frame) => frame.text === pingText);
    yield* TestClock.adjust("2499 millis");
    assert.equal(fiber.pollUnsafe(), undefined);
    yield* TestClock.adjust("1 millis");
    const failure = yield* Fiber.join(fiber);
    assert.ok(failure instanceof T3TransportError);
    assert.equal(failure.message, "T3 websocket heartbeat timed out");
    yield* peer.closed;
    assert.deepEqual(peer.texts(), [subscribeShell({}), subscribeArchive, pingText]);
  }), { timeout: 10_000 });

  it.effect("T3-PORT-04: each answered Ping is followed by the next one a full interval later and the watch stays open", () => Effect.gen(function*() {
    // every Pong travels with a chunk, so its Ack proves the client handled the Pong before the clock moves again
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Ping") socket.send(JSON.stringify([{ _tag: "Pong" }, { _tag: "Chunk", requestId: "1", values: [{ kind: "synchronized" }] }]));
    });
    const client = yield* clientOf(peer.baseUrl, heartbeat);
    const fiber = yield* Effect.forkChild(client.watch(undefined, () => Effect.void));
    yield* peer.frame(isArchiveRequest);
    const acks = () => peer.texts().filter((text) => text === ackText("1")).length;
    for (let beat = 1; beat <= 3; beat++) {
      yield* TestClock.adjust("999 millis");
      yield* barrier(peer.baseUrl);
      assert.equal(peer.texts().filter((text) => text === pingText).length, beat - 1, `no Ping before interval ${beat} ends`);
      yield* TestClock.adjust("1 millis");
      yield* peer.frame((frame) => frame.text === ackText("1") && acks() === beat);
    }
    assert.equal(fiber.pollUnsafe(), undefined);
    assert.deepEqual(peer.texts(), [subscribeShell({}), subscribeArchive, pingText, ackText("1"), pingText, ackText("1"), pingText, ackText("1")]);
    yield* Fiber.interrupt(fiber);
    yield* peer.closed;
  }), { timeout: 10_000 });
});

describe("monotonic deadlines (CT-CLOCK-01)", () => {
  it.live("T3-PORT-05: wall-clock jumps neither expire nor extend a projection scan deadline", () => Effect.gen(function*() {
    const clock = yield* wallJumping;
    const body = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(projectionBody("thread-1", 300_000)));
        controller.close();
      },
    });
    const scan = (deadline: number) => readProjectionSnapshot(body(), { retainedBytes: 1 << 20, transferBytes: 4 << 20, deadline })
      .pipe(Effect.provideService(Clock.Clock, clock));
    const now = yield* monotonicMillis;
    const snapshot = yield* scan(now + 5000);
    assert.equal((snapshot.projection as JsonRecord & { thread: { id: string } }).thread.id, "thread-1");
    const expired = yield* failureOf(scan((yield* monotonicMillis) - 1));
    assert.ok(expired instanceof ProjectionStreamError && expired.code === "timed_out", "a passed monotonic deadline still trips");
  }), { timeout: 10_000 });

  it.live("T3-PORT-06: wall-clock jumps neither expire nor extend the HTTP timeout of a projection read", () => Effect.gen(function*() {
    const clock = yield* wallJumping;
    let stall = false;
    const text = projectionBody("thread-1", 10_000);
    const server = yield* mockT3((_url, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      if (stall) response.write(text.slice(0, 200));
      else response.end(text);
    });
    const client = yield* clientOf(server.baseUrl, { httpTimeoutMs: 200 });
    const read = client.projection("thread-1").pipe(Effect.provideService(Clock.Clock, clock));
    assert.equal((yield* read).projection.thread.id, "thread-1");
    stall = true;
    const started = performance.now();
    const failure = yield* failureOf(read);
    const elapsed = performance.now() - started;
    assert.ok(failure instanceof T3TransportError);
    assert.equal(failure.message, "T3 thread projection request timed out");
    assert.ok(elapsed >= 150 && elapsed < 2000, `the 200 ms timeout held on the monotonic clock (${Math.round(elapsed)} ms)`);
  }), { timeout: 10_000 });

  it.live("T3-PORT-07: the stream's own monotonic deadline maps to the request timeout while the HTTP timeout is still far away", () => Effect.gen(function*() {
    const { clock, shift } = yield* shiftedMonotonic;
    const text = projectionBody("thread-1", 200_000);
    const firstPart = deferred<void>();
    const proceed = deferred<void>();
    const server = yield* mockT3((_url, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      response.write(text.slice(0, 40_000), () => firstPart.resolve());
      void proceed.promise.then(() => response.end(text.slice(40_000)));
    });
    const client = yield* clientOf(server.baseUrl);
    const started = performance.now();
    const pending = yield* Effect.forkChild(failureOf(client.projection("thread-1").pipe(Effect.provideService(Clock.Clock, clock))));
    yield* Effect.promise(() => firstPart.promise);
    shift(60_000);
    proceed.resolve();
    const failure = yield* Fiber.join(pending);
    assert.ok(failure instanceof T3TransportError);
    assert.equal(failure.code, undefined);
    assert.equal(failure.message, "T3 thread projection request timed out");
    assert.ok(performance.now() - started < 5000, "the 20 s HTTP timeout did not fire");
  }), { timeout: 10_000 });
});

describe("read interruption (CT-T3-06, effect form)", () => {
  it.live("T3-PORT-08: interrupting a read waiting on its body cancels the reader, stops pulling and yields no value", () => Effect.gen(function*() {
    const bytes = encoder.encode(projectionBody("main", 2000));
    const waiting = yield* Deferred.make<void>();
    let pulls = 0;
    let pullsAtCancel: number | undefined;
    let releasePull: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        pulls++;
        if (pulls < 3) {
          stream.enqueue(bytes.slice((pulls - 1) * 64, pulls * 64));
          return;
        }
        // the third pull never delivers; the read waits on it until the reader is cancelled
        Deferred.doneUnsafe(waiting, Effect.void);
        return new Promise<void>((resolve) => {releasePull = resolve;});
      },
      cancel() {
        pullsAtCancel = pulls;
        releasePull?.();
      },
    });
    const fiber = yield* Effect.forkChild(readProjectionSnapshot(body, { retainedBytes: 1 << 20, transferBytes: 4 << 20, deadline: Number.POSITIVE_INFINITY }));
    yield* Deferred.await(waiting);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "the interrupted read yields no value");
    assert.equal(pullsAtCancel, pulls, "the reader cancelled the source");
    yield* Effect.callback<void>((resume) => {setImmediate(() => resume(Effect.void));});
    assert.equal(pulls, pullsAtCancel, "nothing pulls after the cancel");
  }), { timeout: 10_000 });
});
