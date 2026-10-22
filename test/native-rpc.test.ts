import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { NativeEnvelope } from "../src/native-envelope.js";
import { NativeOperateRpc, NativeRpc, NativeShell, SupervisorRpcError } from "../src/supervisor-native.js";
import { envelopePeer, hungPeer, type PeerFrame } from "./support/envelope-peer.js";

// target regressions of the ported native services (WP-S4-NATIVE): the sent boundary, interruption and the effect-clock deadlines

const token = "native-rpc-test-token";
const requestText = '{"_tag":"Request","id":"supervisor","tag":"orchestration.dispatchCommand","payload":{"commandId":"command-a"},"headers":[]}';
const isRequest = (frame: PeerFrame) => frame.frame._tag === "Request";
const provided = Effect.provide(NativeEnvelope.layer);
const client = (baseUrl: string) => NativeRpc.make({ baseUrl, token });
const dispatch = (baseUrl: string, cancel?: Deferred.Deferred<void>) =>
  Effect.flatMap(client(baseUrl), (rpc) => rpc.call("orchestration.dispatchCommand", { commandId: "command-a" }, cancel));
const classification = (error: SupervisorRpcError) => [error.outcome, error.definiteRejection, error.providerDisabled, error.dispatchCommandFailure];

const serve = (handler: (request: IncomingMessage, response: ServerResponse) => void) => Effect.acquireRelease(Effect.gen(function* () {
  const server = createServer(handler);
  yield* Effect.callback<void>((resume) => {server.listen(0, "127.0.0.1", () => resume(Effect.void));});
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}), ({ server }) => Effect.callback<void>((resume) => {
  server.close(() => resume(Effect.void));
  server.closeAllConnections();
}));

// an archived view at the same revision with no threads
const emptyArchive = Layer.succeed(NativeRpc, NativeRpc.of({
  call: () => Effect.succeed({ schemaVersion: 2, snapshotSequence: 1, threads: [] }),
  initiate: () => Effect.die("the shell reads only call"),
}));
const baseline = (baseUrl: string) => NativeShell.use((shell) => shell.baseline).pipe(
  Effect.provide(NativeShell.layer({ baseUrl, token }).pipe(Layer.provide([emptyArchive, FetchHttpClient.layer]))));
const activeBody = (bytes: number) => {
  const empty = JSON.stringify({ schemaVersion: 2, snapshotSequence: 1, threads: [], archivedThreads: [], pad: "" });
  return JSON.stringify({ schemaVersion: 2, snapshotSequence: 1, threads: [], archivedThreads: [], pad: "x".repeat(bytes - empty.length) });
};

describe("NativeRpc", () => {
  it.live("NRPC-01: initiate commits the request at once, reports the sent boundary and release ends the socket without another frame", () => Effect.gen(function* () {
    const peer = yield* envelopePeer();
    const flight = yield* Effect.flatMap(client(peer.baseUrl), (rpc) => rpc.initiate("orchestration.dispatchCommand", { commandId: "command-a" }));
    assert.equal(yield* flight.sent, false);
    yield* peer.frame(isRequest);
    assert.equal(yield* flight.sent, true);
    yield* flight.release;
    yield* peer.closed;
    assert.deepEqual(peer.texts(), [requestText]);
    assert.equal(peer.upgrades[0]?.url, "/ws?orchestrationProtocol=2");

    const answering = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request") socket.send(JSON.stringify({ _tag: "Exit", requestId: "supervisor", exit: { _tag: "Success", value: { accepted: true } } }));
    });
    const settled = yield* Effect.flatMap(client(answering.baseUrl), (rpc) => rpc.initiate("orchestration.dispatchCommand", { commandId: "command-a" }));
    assert.deepEqual(yield* settled.result, { accepted: true });
    assert.equal(yield* settled.sent, true);
    yield* settled.release;
  }).pipe(provided), { timeout: 10_000 });

  it.live("NRPC-02: interrupting a sent call terminates its socket without a second frame; a cancel after send is uncertain", () => Effect.gen(function* () {
    const peer = yield* envelopePeer();
    const fiber = yield* Effect.forkChild(dispatch(peer.baseUrl));
    yield* peer.frame(isRequest);
    yield* Fiber.interrupt(fiber);
    yield* peer.closed;
    assert.deepEqual(peer.texts(), [requestText]);
    assert.equal(peer.upgrades.length, 1);

    const cancelled = yield* envelopePeer();
    const cancel = yield* Deferred.make<void>();
    const call = yield* Effect.forkChild(Effect.flip(dispatch(cancelled.baseUrl, cancel)));
    yield* cancelled.frame(isRequest);
    yield* Deferred.succeed(cancel, undefined);
    assert.deepEqual(classification(yield* Fiber.join(call)), ["uncertain", false, false, false]);
    yield* cancelled.closed;
    assert.deepEqual(cancelled.texts(), [requestText]);
  }).pipe(provided), { timeout: 10_000 });

  it.effect("NRPC-03: on the effect clock an unanswered sent call is uncertain at exactly 20 s and a hung handshake rejected at exactly 5 s", () => Effect.gen(function* () {
    const silent = yield* envelopePeer();
    const late = yield* Effect.forkChild(Effect.flip(dispatch(silent.baseUrl)));
    yield* silent.frame(isRequest);
    yield* TestClock.adjust("19999 millis");
    assert.equal(late.pollUnsafe(), undefined);
    yield* TestClock.adjust("1 millis");
    const timedOut = yield* Fiber.join(late);
    assert.deepEqual(classification(timedOut), ["uncertain", false, false, false]);
    assert.equal(timedOut.message, "T3 Supervisor access is unavailable.");
    yield* silent.closed;
    assert.deepEqual(silent.texts(), [requestText]);

    const hung = yield* hungPeer;
    const early = yield* Effect.forkChild(Effect.flip(dispatch(hung.baseUrl)));
    yield* hung.accepted;
    yield* TestClock.adjust("4999 millis");
    assert.equal(early.pollUnsafe(), undefined);
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(classification(yield* Fiber.join(early)), ["rejected", false, false, false]);
    yield* hung.gone;
    assert.equal(hung.received(), "");
  }).pipe(provided), { timeout: 10_000 });

  it.live("NRPC-04: the operate client is a separate service over the same envelope and its own credential", () => Effect.gen(function* () {
    const peer = yield* envelopePeer((socket, frame) => {
      if (frame._tag === "Request") socket.send(JSON.stringify({ _tag: "Exit", requestId: "supervisor", exit: { _tag: "Success", value: frame.tag } }));
    });
    const tags = yield* Effect.all([
      NativeRpc.use((rpc) => rpc.call("server.getConfig", {})),
      NativeOperateRpc.use((rpc) => rpc.call("orchestration.dispatchCommand", {})),
    ]).pipe(Effect.provide(Layer.mergeAll(NativeRpc.layer({ baseUrl: peer.baseUrl, token: "read-token" }),
      NativeOperateRpc.layer({ baseUrl: peer.baseUrl, token: "operate-token" }))));
    assert.deepEqual(tags, ["server.getConfig", "orchestration.dispatchCommand"]);
    assert.deepEqual(peer.upgrades.map((upgrade) => upgrade.authorization), ["Bearer read-token", "Bearer operate-token"]);
  }).pipe(provided), { timeout: 10_000 });

  it.effect("NRPC-05: SupervisorRpcError keeps its positional constructor, fields and fixed message and fails an effect by its tag", () => Effect.gen(function* () {
    const error = new SupervisorRpcError("rejected", true, true);
    assert.deepEqual(classification(error), ["rejected", true, true, false]);
    assert.ok(error instanceof Error);
    assert.equal(error.message, "T3 Supervisor access is unavailable.");
    const caught = yield* Effect.fail(new SupervisorRpcError("uncertain", false, false, true)).pipe(
      Effect.catchTag("SupervisorRpcError", (failure) => Effect.succeed(classification(failure))));
    assert.deepEqual(caught, ["uncertain", false, false, true]);
  }), { timeout: 10_000 });
});

describe("NativeShell", () => {
  it.live("NRPC-06: the active read sends only the bearer and protocol headers, takes exactly 8 MiB and fails closed above it or on a non-2xx status", () => Effect.gen(function* () {
    const limit = 8 * 1024 * 1024;
    const headers: IncomingHttpHeaders[] = [];
    let body = activeBody(limit);
    let status = 200;
    const { baseUrl } = yield* serve((request, response) => {
      headers.push(request.headers);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
    assert.equal(Buffer.byteLength(body), limit);
    assert.deepEqual(yield* baseline(baseUrl), { snapshotSequence: 1, threads: [] });
    assert.equal(headers[0]?.authorization, `Bearer ${token}`);
    assert.equal(headers[0]?.["x-t3-orchestration-protocol"], "2");
    assert.deepEqual([headers[0]?.traceparent, headers[0]?.b3], [undefined, undefined]);

    body = activeBody(limit + 1);
    const over = yield* Effect.flip(baseline(baseUrl));
    assert.deepEqual(classification(over), ["rejected", false, false, false]);
    body = activeBody(1024);
    status = 503;
    assert.deepEqual(classification(yield* Effect.flip(baseline(baseUrl))), ["rejected", false, false, false]);
    assert.equal(headers.length, 3, "a failed read is not retried");
  }), { timeout: 10_000 });

  it.effect("NRPC-07: an unanswered active read fails closed at exactly 10 s on the effect clock", () => Effect.gen(function* () {
    const arrived = yield* Deferred.make<void>();
    const { baseUrl } = yield* serve(() => {Deferred.doneUnsafe(arrived, Effect.void);});
    const fiber = yield* Effect.forkChild(Effect.flip(baseline(baseUrl)));
    yield* Deferred.await(arrived);
    yield* TestClock.adjust("9999 millis");
    assert.equal(fiber.pollUnsafe(), undefined);
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(classification(yield* Fiber.join(fiber)), ["rejected", false, false, false]);
  }), { timeout: 10_000 });
});
