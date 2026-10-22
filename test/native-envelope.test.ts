import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  cancelOnAbort, NativeEnvelope, NativeEnvelopeError, NativeFraming, nativeMaxPayload, NativeStep,
  type NativeCall, type NativeExit, type NativeOpenOptions, type NativeServerFrame,
} from "../src/native-envelope.js";
import { freePort } from "./support/c1-loopback.js";
import { frameHeader, textFrame } from "./support/c3a-fake-t3.js";
import { barrier, envelopePeer, hungPeer, rawPeer, type PeerFrame } from "./support/envelope-peer.js";

// the shared native envelope (D-08) against real ws loopback peers

const token = "native-envelope-test-token";
const requestText = '{"_tag":"Request","id":"supervisor","tag":"server.getConfig","payload":{"probe":1},"headers":[]}';
const pongText = '{"_tag":"Pong"}';
const ackText = '{"_tag":"Ack","requestId":"supervisor"}';
const pingText = '{"_tag":"Ping"}';

const exitText = (requestId: string, exit: unknown) => JSON.stringify({ _tag: "Exit", requestId, exit });
const success = (value: unknown) => ({ _tag: "Success", value });
const chunkText = (requestId: string, values: unknown[]) => JSON.stringify({ _tag: "Chunk", requestId, values });
const tagOf = (frame: PeerFrame) => frame.frame._tag;
const isRequest = (frame: PeerFrame) => tagOf(frame) === "Request";

// a single request as supervisor-native sends it; the call ends with the decoded Exit
const unary = (baseUrl: string, extra: Partial<NativeCall<NativeExit>> = {}): NativeCall<NativeExit> => ({
  endpoint: { baseUrl, token },
  request: { id: "supervisor", tag: "server.getConfig", payload: { probe: 1 } },
  maxPayload: nativeMaxPayload.native,
  handshakeTimeout: "5 seconds",
  onExit: (exit) => Effect.succeed(NativeStep.done(exit)),
  ...extra,
});

const call = <A, E>(spec: NativeCall<A, E>) => NativeEnvelope.use((envelope) => envelope.call(spec));
const failure = <A>(effect: Effect.Effect<A, NativeEnvelopeError, NativeEnvelope>) =>
  Effect.flip(effect).pipe(Effect.map((error) => {
    assert.ok(error instanceof NativeEnvelopeError);
    return [error.reason, error.outcome];
  }));
const provided = Effect.provide(NativeEnvelope.layer);

// process-level errors seen while the scope is open: a handshake abort must never surface an unhandled ws error
const uncaught = Effect.acquireRelease(Effect.sync(() => {
  const seen: unknown[] = [];
  const record = (error: unknown) => {seen.push(error);};
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  return { seen, record };
}), ({ record }) => Effect.sync(() => {
  process.off("uncaughtException", record);
  process.off("unhandledRejection", record);
}));

const afterImmediate = Effect.callback<void>((resume) => {setImmediate(() => resume(Effect.void));});

describe("NativeEnvelope call", () => {
  it.live("ENV-01: writes the exact Request frame with the bearer header on /ws, answers Ping with Pong and decodes Exit Success unchanged", () => Effect.gen(function*() {
    const value = { createdAt: "2026-10-22T10:15:30.123456789Z", sequence: 7, nested: [{ updatedAt: "2026-10-22T10:15:30Z" }] };
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request") socket.send(pingText);
      else if (frame._tag === "Pong") socket.send(exitText("supervisor", success(value)));
    });
    assert.deepEqual(yield* call(unary(peer.baseUrl)), { _tag: "Success", value });
    assert.deepEqual(peer.texts(), [requestText, pongText]);
    assert.deepEqual(peer.frames.map((frame) => frame.binary), [false, false]);
    assert.equal(peer.upgrades.length, 1);
    assert.equal(peer.upgrades[0]?.url, "/ws?orchestrationProtocol=2");
    assert.ok(peer.upgrades[0]?.authorization === `Bearer ${token}`, "the upgrade carries the bearer token");
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-02: decodes Exit Failure, other exit tags and malformed exits and keeps the raw native exit", () => Effect.gen(function*() {
    const cause = { _tag: "Fail", failure: { name: "OrchestratorCommandPreviouslyRejectedError", at: "2026-10-22T10:15:30Z" } };
    const exits: Record<string, unknown> = {
      failure: { _tag: "Failure", cause },
      interrupted: { _tag: "Interrupted", fiber: 3 },
      untagged: { value: 1 },
      emptySuccess: { _tag: "Success" },
      number: 5,
      list: [success(1)],
      missing: undefined,
    };
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag !== "Request") return;
      const name = String((frame.payload as Record<string, unknown>).name);
      socket.send(name === "missing" ? JSON.stringify({ _tag: "Exit", requestId: "supervisor" }) : exitText("supervisor", exits[name]));
    });
    const decoded: Record<string, NativeExit> = {};
    for (const name of Object.keys(exits)) {
      decoded[name] = yield* call(unary(peer.baseUrl, { request: { id: "supervisor", tag: "server.getConfig", payload: { name } } }));
    }
    assert.deepEqual(decoded, {
      failure: { _tag: "Failure", exit: { _tag: "Failure", cause } },
      interrupted: { _tag: "Unknown", exit: { _tag: "Interrupted", fiber: 3 } },
      untagged: { _tag: "Unknown", exit: { value: 1 } },
      emptySuccess: { _tag: "Success", value: undefined },
      number: { _tag: "Malformed" },
      list: { _tag: "Malformed" },
      missing: { _tag: "Malformed" },
    });
    assert.equal(peer.upgrades.length, Object.keys(exits).length);
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-03: ignores Exits for other request ids, unconsumed Chunks, Defects and unknown frames and settles on its own Exit", () => Effect.gen(function*() {
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request") {
        socket.send(exitText("other", success("wrong")));
        socket.send(exitText("other", { _tag: "Failure", cause: { _tag: "Fail", failure: { name: "OrchestratorCommandPreviouslyRejectedError" } } }));
        socket.send(chunkText("supervisor", [{ kind: "ignored" }]));
        socket.send(JSON.stringify({ _tag: "Defect", defect: "boom" }));
        socket.send(JSON.stringify({ _tag: "Unknown" }));
        socket.send(pingText);
      } else if (frame._tag === "Pong") {
        // the client answered the ping after every foreign frame, so none of them settled it
        socket.send(exitText("supervisor", success("right")));
      }
    });
    assert.deepEqual(yield* call(unary(peer.baseUrl)), { _tag: "Success", value: "right" });
    assert.deepEqual(peer.texts(), [requestText, pongText]);
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-04: flattens batched arrays four levels deep in order and fails closed on deeper nesting", () => Effect.gen(function*() {
    const own = { _tag: "Exit", requestId: "supervisor", exit: success({ batched: true }) };
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request") socket.send(JSON.stringify([[{ _tag: "Ping" }]]));
      else if (frame._tag === "Pong") socket.send(JSON.stringify([[[[{ _tag: "Exit", requestId: "other", exit: success("wrong") }]]], [[[[own]]]]]));
    });
    assert.deepEqual(yield* call(unary(peer.baseUrl)), { _tag: "Success", value: { batched: true } });
    assert.deepEqual(peer.texts(), [requestText, pongText]);

    const deep = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request") socket.send(JSON.stringify([[[[[[own]]]]]]));
    });
    assert.deepEqual(yield* failure(call(unary(deep.baseUrl))), ["invalid_frame", "uncertain"]);
    assert.deepEqual(deep.texts(), [requestText]);
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-05: an invalid envelope fails where it is reached when flat and before any envelope when checked or walked", () => Effect.gen(function*() {
    const own = { _tag: "Exit", requestId: "supervisor", exit: success("own") };
    const foreign = { _tag: "Exit", requestId: "other", exit: success("foreign") };
    const pongs = (count: number) => Array.from({ length: count }, () => ({ _tag: "Pong" }));
    const deep = (depth: number, value: unknown): string => "[".repeat(depth) + JSON.stringify(value) + "]".repeat(depth);
    const outcome = (framing: NativeFraming, ...texts: string[]) => Effect.gen(function*() {
      const peer = yield* envelopePeer((socket, frame) => {if (frame._tag === "Request") for (const text of texts) socket.send(text);});
      return yield* call(unary(peer.baseUrl, { framing })).pipe(
        Effect.map((exit) => exit._tag),
        Effect.catch((error) => Effect.succeed(`${error.reason}/${error.outcome}`)));
    });
    const flat = NativeFraming.flat(4);
    const checked = NativeFraming.flatChecked(4, 256);
    const walked = NativeFraming.walk(8192);
    assert.deepEqual([
      yield* outcome(flat, JSON.stringify([own, 7])),
      yield* outcome(flat, JSON.stringify([7, own])),
      yield* outcome(flat, JSON.stringify([]), JSON.stringify([own])),
      yield* outcome(checked, JSON.stringify([own, 7])),
      yield* outcome(checked, JSON.stringify([...Array.from({ length: 255 }, () => foreign), own])),
      yield* outcome(checked, JSON.stringify([...Array.from({ length: 256 }, () => foreign), own])),
      yield* outcome(walked, JSON.stringify([own, 7])),
      yield* outcome(walked, JSON.stringify([])),
      yield* outcome(walked, JSON.stringify([...pongs(8190), own])),
      yield* outcome(walked, JSON.stringify([...pongs(8191), own])),
      yield* outcome(walked, deep(8191, own)),
      yield* outcome(walked, JSON.stringify([[], [[own]]])),
    ], [
      "Success", "invalid_frame/uncertain", "Success",
      "invalid_frame/uncertain", "Success", "invalid_frame/uncertain",
      "invalid_frame/uncertain", "invalid_frame/uncertain", "Success", "invalid_frame/uncertain", "Success", "Success",
    ]);
  }).pipe(provided), { timeout: 10_000 });
});

describe("NativeEnvelope frames and consumers", () => {
  it.live("ENV-06: a binary frame after the Request is uncertain even when it carries a valid Exit, as is malformed JSON", () => Effect.gen(function*() {
    const binary = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request") socket.send(Buffer.from(exitText("supervisor", success(true))), { binary: true });
    });
    assert.deepEqual(yield* failure(call(unary(binary.baseUrl))), ["binary_frame", "uncertain"]);
    const text = yield* envelopePeer((socket, frame) => {if (frame._tag === "Request") socket.send("not protocol json");});
    assert.deepEqual(yield* failure(call(unary(text.baseUrl))), ["malformed_json", "uncertain"]);
    assert.deepEqual([binary.texts(), text.texts()], [[requestText], [requestText]]);
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-07: Acks a Chunk only after its consumer finished and handles no later Chunk before that Ack was written", () => Effect.gen(function*() {
    let acks = 0;
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request") {
        socket.send(chunkText("supervisor", ["a"]));
        socket.send(chunkText("supervisor", ["b"]));
      } else if (frame._tag === "Ack" && ++acks === 2) socket.send(exitText("supervisor", success("done")));
    });
    const log: string[] = [];
    const started = { a: yield* Deferred.make<void>(), b: yield* Deferred.make<void>() };
    const release = { a: yield* Deferred.make<void>(), b: yield* Deferred.make<void>() };
    const fiber = yield* Effect.forkChild(call(unary(peer.baseUrl, {
      onChunk: (values) => Effect.gen(function*() {
        const name = values[0] === "a" ? "a" : "b";
        log.push(`start:${name}`);
        yield* Deferred.succeed(started[name], undefined);
        yield* Deferred.await(release[name]);
        log.push(`done:${name}`);
        return NativeStep.ack(Effect.sync(() => {log.push(`acked:${name}`);}));
      }),
    })));
    yield* Deferred.await(started.a);
    // a full loopback round trip while the consumer holds the first chunk gives an early ack every chance to arrive
    assert.equal(yield* barrier(peer.baseUrl), 204);
    assert.deepEqual(log, ["start:a"]);
    assert.deepEqual(peer.texts(), [requestText]);

    yield* Deferred.succeed(release.a, undefined);
    yield* Deferred.await(started.b);
    assert.equal(yield* barrier(peer.baseUrl), 204);
    assert.deepEqual(log, ["start:a", "done:a", "acked:a", "start:b"]);
    assert.deepEqual(peer.texts(), [requestText, ackText]);

    yield* Deferred.succeed(release.b, undefined);
    assert.deepEqual(yield* Fiber.join(fiber), { _tag: "Success", value: "done" });
    assert.deepEqual(log, ["start:a", "done:a", "acked:a", "start:b", "done:b", "acked:b"]);
    assert.deepEqual(peer.texts(), [requestText, ackText, ackText]);
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-08: a consumer may continue or finish the call without an Ack, as the project-files snapshot does", () => Effect.gen(function*() {
    const local = { isRepo: true, workingTree: { files: [{ path: "README.md" }] } };
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag !== "Request") return;
      socket.send(chunkText("supervisor", [{ _tag: "remoteUpdated" }]));
      socket.send(chunkText("supervisor", [{ _tag: "snapshot", local }]));
    });
    const result = yield* call<unknown, never>({
      ...unary(peer.baseUrl),
      onChunk: (values) => {
        const event = values.find((value) => typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === "snapshot");
        return Effect.succeed(event === undefined ? NativeStep.continue : NativeStep.done((event as { local: unknown }).local));
      },
    });
    assert.deepEqual(result, local);
    assert.equal(yield* barrier(peer.baseUrl), 204);
    assert.deepEqual(peer.texts(), [requestText]);
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-09: an interruption writes no Ack and no Interrupt frame and terminates the socket; the Request already left, so it is uncertain", () => Effect.gen(function*() {
    const envelope = yield* NativeEnvelope;
    const consuming = yield* envelopePeer((socket, frame) => {if (frame._tag === "Request") socket.send(chunkText("supervisor", ["held"]));});
    const started = yield* Deferred.make<void>();
    const flight = yield* envelope.initiate(unary(consuming.baseUrl, { onChunk: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) }));
    assert.equal(yield* flight.sent, false);
    const fiber = yield* Effect.forkChild(flight.result);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    yield* flight.release;
    assert.equal(yield* flight.sent, true);
    yield* consuming.closed;
    assert.equal(yield* barrier(consuming.baseUrl), 204);
    assert.deepEqual(consuming.texts(), [requestText]);

    // waiting for the Exit instead: the interrupted call releases its socket by itself
    const waiting = yield* envelopePeer();
    const pending = yield* Effect.forkChild(call(unary(waiting.baseUrl)));
    yield* waiting.frame(isRequest);
    yield* Fiber.interrupt(pending);
    yield* waiting.closed;
    assert.equal(yield* barrier(waiting.baseUrl), 204);
    assert.deepEqual(waiting.texts(), [requestText]);
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-10: initiate binds the Request to a new socket that writes it on open even before result runs", () => Effect.gen(function*() {
    const envelope = yield* NativeEnvelope;
    const peer = yield* envelopePeer();
    const flight = yield* envelope.initiate(unary(peer.baseUrl));
    assert.equal(yield* flight.sent, false);
    yield* peer.frame(isRequest);
    assert.equal(yield* flight.sent, true);
    yield* flight.release;
    yield* flight.release;
    yield* peer.closed;
    assert.deepEqual(peer.texts(), [requestText]);

    const cancel = yield* Deferred.make<void>();
    yield* Deferred.succeed(cancel, undefined);
    const untouched = yield* envelopePeer();
    const cancelled = yield* envelope.initiate(unary(untouched.baseUrl, { cancel }));
    assert.equal(yield* cancelled.sent, false);
    assert.deepEqual(yield* failure(cancelled.result), ["cancelled", "rejected"]);
    yield* cancelled.release;
    assert.equal(untouched.tcpConnections(), 0);
  }).pipe(provided), { timeout: 10_000 });
});

describe("NativeEnvelope sent boundary and limits", () => {
  it.live("ENV-11: failures before the Request left are rejected, failures after it are uncertain, and nothing is retried", () => Effect.gen(function*() {
    const port = yield* Effect.promise(() => freePort());
    assert.deepEqual(yield* failure(call(unary(`http://127.0.0.1:${port}`))), ["connect_failed", "rejected"]);

    const refusing = yield* envelopePeer(() => undefined, { verifyClient: () => false });
    assert.deepEqual(yield* failure(call(unary(refusing.baseUrl))), ["connect_failed", "rejected"]);
    assert.equal(refusing.upgrades.length, 0);

    const cancel = yield* Deferred.make<void>();
    yield* Deferred.succeed(cancel, undefined);
    const untouched = yield* envelopePeer();
    assert.deepEqual(yield* failure(call(unary(untouched.baseUrl, { cancel }))), ["cancelled", "rejected"]);
    assert.equal(untouched.tcpConnections(), 0);

    const abandoned = yield* envelopePeer();
    const later = yield* Deferred.make<void>();
    const pending = yield* Effect.forkChild(failure(call(unary(abandoned.baseUrl, { cancel: later }))));
    yield* abandoned.frame(isRequest);
    yield* Deferred.succeed(later, undefined);
    assert.deepEqual(yield* Fiber.join(pending), ["cancelled", "uncertain"]);
    yield* abandoned.closed;
    assert.deepEqual(abandoned.texts(), [requestText]);

    const dropping = yield* envelopePeer((socket, frame) => {if (frame._tag === "Request") socket.terminate();});
    assert.deepEqual(yield* failure(call(unary(dropping.baseUrl))), ["socket_closed", "uncertain"]);
    assert.equal(yield* barrier(dropping.baseUrl), 204);
    assert.deepEqual([dropping.upgrades.length, dropping.texts()], [1, [requestText]]);
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-12: each client's maxPayload applies per call: a frame at the limit is read, one byte more closes with 1009 as socket_failed", () => Effect.gen(function*() {
    assert.deepEqual(nativeMaxPayload, { t3: 32 * 1024 * 1024, native: 8 * 1024 * 1024, files: 2 * 1024 * 1024, probe: 2 * 1024 * 1024 });
    const limitCall = (baseUrl: string, maxPayload: number) => call(unary(baseUrl, { maxPayload, request: { id: "limit", tag: "server.getConfig", payload: {} } }));
    for (const [client, limit] of Object.entries(nativeMaxPayload)) {
      const empty = exitText("limit", success("")).length;
      const atLimit = yield* rawPeer;
      const read = yield* Effect.forkChild(limitCall(atLimit.baseUrl, limit));
      const accepted = yield* atLimit.connection;
      yield* Effect.promise(() => accepted.frame((frame) => frame.opcode === 0x1));
      const body = exitText("limit", success("x".repeat(limit - empty)));
      assert.equal(Buffer.byteLength(body), limit, client);
      accepted.socket.write(textFrame(body));
      const exit = yield* Fiber.join(read);
      assert.ok(exit._tag === "Success" && typeof exit.value === "string" && exit.value.length === limit - empty, client);

      const over = yield* rawPeer;
      const rejected = yield* Effect.forkChild(failure(limitCall(over.baseUrl, limit)));
      const connection = yield* over.connection;
      yield* Effect.promise(() => connection.frame((frame) => frame.opcode === 0x1));
      connection.socket.write(Buffer.concat([frameHeader(limit + 1), Buffer.alloc(64 * 1024, 0x20)]));
      assert.deepEqual(yield* Fiber.join(rejected), ["socket_failed", "uncertain"], client);
      const close = yield* Effect.promise(() => connection.frame((frame) => frame.opcode === 0x8));
      assert.equal(close.payload.readUInt16BE(0), 1009, client);
      yield* Effect.promise(() => connection.gone);
    }
  }).pipe(provided), { timeout: 10_000 });

  it.effect("ENV-13: the 5 s handshake timeout rejects before open on the test clock, writes nothing, terminates the socket and leaves no unhandled ws error", () => Effect.gen(function*() {
    const errors = yield* uncaught;
    const peer = yield* hungPeer;
    const fiber = yield* Effect.forkChild(failure(call(unary(peer.baseUrl))));
    yield* peer.accepted;
    yield* TestClock.adjust("4999 millis");
    assert.equal(fiber.pollUnsafe(), undefined);
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(yield* Fiber.join(fiber), ["handshake_timed_out", "rejected"]);
    yield* peer.gone;
    // ws reports the aborted handshake on a later tick; the permanent listener absorbs it
    yield* afterImmediate;
    yield* afterImmediate;
    assert.equal(peer.received(), "");
    assert.deepEqual(errors.seen, []);
  }).pipe(provided), { timeout: 10_000 });

  it.effect("ENV-14: the call deadline on the test clock settles uncertain at exactly its duration once the Request left, rejected before open", () => Effect.gen(function*() {
    const silent = yield* envelopePeer();
    const fiber = yield* Effect.forkChild(failure(call(unary(silent.baseUrl, { timeout: "20 seconds" }))));
    yield* silent.frame(isRequest);
    yield* TestClock.adjust("19999 millis");
    assert.equal(fiber.pollUnsafe(), undefined);
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(yield* Fiber.join(fiber), ["timed_out", "uncertain"]);
    yield* silent.closed;
    assert.deepEqual(silent.texts(), [requestText]);

    const hung = yield* hungPeer;
    const early = yield* Effect.forkChild(failure(call(unary(hung.baseUrl, { timeout: "1 second" }))));
    yield* hung.accepted;
    yield* TestClock.adjust("1 second");
    assert.deepEqual(yield* Fiber.join(early), ["timed_out", "rejected"]);
    yield* hung.gone;
    assert.equal(hung.received(), "");
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-15: cancelOnAbort completes on abort, at once for an aborted signal, and removes its listener with its scope", () => Effect.gen(function*() {
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(yield* Effect.scoped(cancelOnAbort(aborted.signal).pipe(Effect.flatMap(Deferred.isDone))), true);

    const controller = new AbortController();
    yield* Effect.scoped(Effect.gen(function*() {
      const cancel = yield* cancelOnAbort(controller.signal);
      assert.equal(yield* Deferred.isDone(cancel), false);
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
      controller.abort();
      yield* Deferred.await(cancel);
    }));
    const idle = new AbortController();
    yield* Effect.scoped(cancelOnAbort(idle.signal));
    assert.equal(getEventListeners(idle.signal, "abort").length, 0);
  }), { timeout: 10_000 });
});

describe("NativeEnvelope connection", () => {
  const subscriptions = [
    { id: "1", tag: "orchestration.subscribeShell", payload: { afterSequence: 7 } },
    { id: "2", tag: "orchestration.subscribeArchivedShell", payload: {} },
  ];
  const t3Options = (baseUrl: string): NativeOpenOptions => ({
    endpoint: { baseUrl, token },
    requests: subscriptions,
    maxPayload: nativeMaxPayload.t3,
    handshakeTimeout: "10 seconds",
    framing: NativeFraming.walk(8192),
    maxBufferedFrames: 8,
    maxBufferedBytes: 32 * 1024 * 1024,
  });

  it.live("ENV-16: open writes every bound Request in order; receive answers Pings in order and hands every other envelope over; send waits for ws", () => Effect.gen(function*() {
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request" && frame.id === "2") socket.send(JSON.stringify([
        { _tag: "Ping" }, { _tag: "Chunk", requestId: "1", values: [{ kind: "synchronized" }] }, [{ _tag: "Pong" }, { _tag: "Ping" }],
        { _tag: "Exit", requestId: "1", exit: success(null) }, { _tag: "Defect" }, { _tag: "Chunk", requestId: 1, values: [] },
      ]));
    });
    const envelope = yield* NativeEnvelope;
    const received: NativeServerFrame[] = [];
    yield* Effect.scoped(Effect.gen(function*() {
      const connection = yield* envelope.open(t3Options(peer.baseUrl));
      assert.equal(yield* connection.sent, true);
      yield* connection.receive((frame) => Effect.sync(() => {received.push(frame);}));
      yield* connection.send({ _tag: "Ack", requestId: "1" });
      yield* connection.send({ _tag: "Ping" });
    }));
    assert.deepEqual(received, [
      { _tag: "Chunk", requestId: "1", values: [{ kind: "synchronized" }] }, { _tag: "Pong" },
      { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } }, { _tag: "Defect" },
      { _tag: "Other", frame: { _tag: "Chunk", requestId: 1, values: [] } },
    ]);
    yield* peer.closed;
    assert.deepEqual(peer.texts(), [
      '{"_tag":"Request","id":"1","tag":"orchestration.subscribeShell","payload":{"afterSequence":7},"headers":[]}',
      '{"_tag":"Request","id":"2","tag":"orchestration.subscribeArchivedShell","payload":{},"headers":[]}',
      pongText, pongText, '{"_tag":"Ack","requestId":"1"}', pingText,
    ]);
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-17: nine messages in one tcp write trip an 8-message buffer, terminating the socket; that failure comes before any buffered message", () => Effect.gen(function*() {
    const peer = yield* rawPeer;
    const envelope = yield* NativeEnvelope;
    const nine = Buffer.concat(Array.from({ length: 9 }, (_, index) => textFrame(chunkText("1", [index + 1]))));
    const outcome = yield* Effect.scoped(Effect.gen(function*() {
      const connection = yield* envelope.open(t3Options(peer.baseUrl));
      const raw = yield* peer.connection;
      yield* Effect.promise(() => raw.frame((frame) => frame.payload.toString("utf8").includes("subscribeArchivedShell")));
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const handled: unknown[] = [];
      const first = yield* Effect.forkChild(connection.receive((frame) => Effect.gen(function*() {
        handled.push(frame._tag === "Chunk" ? frame.values[0] : frame._tag);
        yield* Deferred.succeed(holding, undefined);
        yield* Deferred.await(release);
      })));
      raw.socket.write(nine);
      yield* Deferred.await(holding);
      yield* Effect.promise(() => raw.gone);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      const next = yield* Effect.flip(connection.receive(() => Effect.void));
      const ack = yield* Effect.flip(connection.send({ _tag: "Ack", requestId: "1" }));
      return { handled, next: [next.reason, next.outcome], ack: [ack.reason, ack.outcome], frames: raw.frames.length };
    }));
    assert.deepEqual(outcome, { handled: [1], next: ["buffer_overflow", "uncertain"], ack: ["not_open", "uncertain"], frames: 2 });
  }).pipe(provided), { timeout: 10_000 });

  it.live("ENV-18: a binary message fails receive and a connection that never opened is rejected", () => Effect.gen(function*() {
    const envelope = yield* NativeEnvelope;
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request" && frame.id === "2") socket.send(Buffer.from(chunkText("1", [1])), { binary: true });
    });
    const binary = yield* Effect.scoped(envelope.open(t3Options(peer.baseUrl)).pipe(
      Effect.flatMap((connection) => Effect.flip(connection.receive(() => Effect.void)))));
    assert.deepEqual([binary.reason, binary.outcome], ["binary_frame", "uncertain"]);
    const port = yield* Effect.promise(() => freePort());
    const refused = yield* Effect.flip(Effect.scoped(envelope.open(t3Options(`http://127.0.0.1:${port}`))));
    assert.deepEqual([refused.reason, refused.outcome], ["connect_failed", "rejected"]);
  }).pipe(provided), { timeout: 10_000 });
});
