import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { it, vi, type TestContext } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { makeSupervisorRpc, SupervisorRpcError } from "../src/supervisor-native.js";
import { after } from "./support/node-test.js";
import { turn, withDeadline } from "./support/c1-loopback.js";

type Frame = { readonly data: string; readonly binary: boolean };

// a loopback T3 peer that records every client frame and connection
const startPeer = async (t: TestContext, onFrame: (socket: WebSocket, frame: Record<string, unknown>) => void) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const frames: Frame[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const firstRequest = Promise.withResolvers<void>();
  const clientClosed = Promise.withResolvers<void>();
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (data, binary) => {
      const text = String(data);
      frames.push({ data: text, binary });
      const frame = JSON.parse(text) as Record<string, unknown>;
      if (frame._tag === "Request") {
        requests.push(frame);
        firstRequest.resolve();
      }
      onFrame(socket, frame);
    });
    socket.once("close", () => clientClosed.resolve());
  });
  after(t, async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    firstRequest.resolve();
    clientClosed.resolve();
  });
  return {
    url: `http://127.0.0.1:${address.port}`,
    frames,
    requests,
    connections: () => connections,
    firstRequest: firstRequest.promise,
    clientClosed: clientClosed.promise,
  };
};

const settledState = <A>(promise: Promise<A>) => {
  const state: { settled: boolean } = { settled: false };
  const outcome = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  void outcome.then(() => { state.settled = true; });
  return { state, outcome };
};

const rpcError = (outcome: { value?: unknown; error?: unknown }): SupervisorRpcError => {
  assert.ok("error" in outcome, "the call must reject");
  assert.ok(outcome.error instanceof SupervisorRpcError);
  return outcome.error;
};

const exit = (requestId: string, value: unknown) => ({ _tag: "Exit", requestId, exit: { _tag: "Success", value } });

it("CT-NATIVE-01: a received request frame left unanswered settles uncertain at exactly 20000 ms", { timeout: 10_000 }, async (t) => {
  const peer = await startPeer(t, () => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const call = settledState(makeSupervisorRpc(peer.url, "timeout-token")("orchestration.dispatchCommand", { commandId: "command-a" }, new AbortController().signal));
    await withDeadline(peer.firstRequest, 3_000, "request frame");
    vi.advanceTimersByTime(19_999);
    await turn();
    assert.equal(call.state.settled, false);
    vi.advanceTimersByTime(1);
    const error = rpcError(await withDeadline(call.outcome, 3_000, "timeout outcome"));
    assert.equal(error.outcome, "uncertain");
    assert.equal(error.definiteRejection, false);
    assert.equal(error.dispatchCommandFailure, false);
    assert.equal(error.message.includes("timeout-token"), false);
  } finally {
    vi.useRealTimers();
  }
  await withDeadline(peer.clientClosed, 3_000, "client close");
  assert.equal(peer.requests.length, 1);
  assert.equal(peer.frames.length, 1);
  assert.equal(peer.connections(), 1);
});

it("CT-NATIVE-01: a hung handshake is rejected before open by the 5 s handshake timeout and no frame is sent", { timeout: 60_000 }, async (t) => {
  const held: Duplex[] = [];
  let bytes = "";
  const server: Server = createServer(() => undefined);
  server.on("upgrade", (_request, socket: Duplex) => {
    held.push(socket);
    socket.on("data", (data: Buffer) => { bytes += data.toString("latin1"); });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  after(t, async () => {
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const started = performance.now();
  const call = settledState(makeSupervisorRpc(`http://127.0.0.1:${address.port}`, "hung-token")("orchestration.dispatchCommand", { commandId: "command-a" }, new AbortController().signal));
  const error = rpcError(await withDeadline(call.outcome, 15_000, "handshake timeout"));
  const elapsed = performance.now() - started;
  assert.equal(error.outcome, "rejected");
  assert.equal(error.definiteRejection, false);
  assert.ok(elapsed >= 4_990 && elapsed < 20_000, `rejected after ${Math.round(elapsed)} ms`);
  assert.equal(held.length, 1);
  assert.equal(bytes, "");
});

it("CT-NATIVE-02: aborting after the peer received the request frame is uncertain, not definite, with no second frame", { timeout: 10_000 }, async (t) => {
  const peer = await startPeer(t, () => {});
  const controller = new AbortController();
  const call = settledState(makeSupervisorRpc(peer.url, "abort-token")("orchestration.dispatchCommand", { commandId: "command-a" }, controller.signal));
  await withDeadline(peer.firstRequest, 3_000, "request frame");
  assert.equal(call.state.settled, false);
  controller.abort();
  const error = rpcError(await withDeadline(call.outcome, 3_000, "abort outcome"));
  assert.equal(error.outcome, "uncertain");
  assert.equal(error.definiteRejection, false);
  assert.equal(error.providerDisabled, false);
  assert.equal(error.dispatchCommandFailure, false);
  await withDeadline(peer.clientClosed, 3_000, "client close");
  assert.deepEqual(peer.requests, [{ _tag: "Request", id: "supervisor", tag: "orchestration.dispatchCommand", payload: { commandId: "command-a" }, headers: [] }]);
  assert.equal(peer.frames.length, 1);
  assert.equal(peer.connections(), 1);
});

it("CT-NATIVE-03: a binary frame after send is uncertain even when it carries a valid Exit", { timeout: 10_000 }, async (t) => {
  const peer = await startPeer(t, (socket, frame) => {
    if (frame._tag === "Request") socket.send(Buffer.from(JSON.stringify(exit("supervisor", { ok: true }))), { binary: true });
  });
  const call = settledState(makeSupervisorRpc(peer.url, "binary-token")("server.getConfig", {}, new AbortController().signal));
  const error = rpcError(await withDeadline(call.outcome, 3_000, "binary outcome"));
  assert.equal(error.outcome, "uncertain");
  assert.equal(error.definiteRejection, false);
  assert.equal(peer.requests.length, 1);
});

it("CT-NATIVE-03: an Exit for another requestId is ignored and the matching Exit settles the call", { timeout: 10_000 }, async (t) => {
  const peer = await startPeer(t, (socket, frame) => {
    if (frame._tag === "Request") {
      socket.send(JSON.stringify(exit("other", "wrong")));
      socket.send(JSON.stringify({ _tag: "Exit", requestId: "other", exit: { _tag: "Failure", cause: { _tag: "Fail", failure: { name: "OrchestratorCommandPreviouslyRejectedError" } } } }));
      socket.send(JSON.stringify({ _tag: "Ping" }));
    } else if (frame._tag === "Pong") {
      // the client answered the ping after both foreign exits, so neither settled it
      socket.send(JSON.stringify(exit("supervisor", "right")));
    }
  });
  const call = settledState(makeSupervisorRpc(peer.url, "foreign-token")("server.getConfig", {}, new AbortController().signal));
  const outcome = await withDeadline(call.outcome, 3_000, "matching exit");
  assert.deepEqual(outcome, { value: "right" });
  assert.deepEqual(peer.frames.map((frame) => (JSON.parse(frame.data) as { _tag: string })._tag), ["Request", "Pong"]);
});

it("CT-NATIVE-03: batched array frames are flattened up to four levels and deeper nesting fails closed", { timeout: 10_000 }, async (t) => {
  const success = exit("supervisor", { batched: true });
  const peer = await startPeer(t, (socket, frame) => {
    if (frame._tag === "Request") socket.send(JSON.stringify([[{ _tag: "Ping" }]]));
    else if (frame._tag === "Pong") socket.send(JSON.stringify([[[[exit("other", "wrong")]]], [[[[success]]]]]));
  });
  const call = settledState(makeSupervisorRpc(peer.url, "batch-token")("server.getConfig", {}, new AbortController().signal));
  assert.deepEqual(await withDeadline(call.outcome, 3_000, "batched exit"), { value: { batched: true } });
  assert.deepEqual(peer.frames.map((frame) => (JSON.parse(frame.data) as { _tag: string })._tag), ["Request", "Pong"]);

  const deep = await startPeer(t, (socket, frame) => {
    if (frame._tag === "Request") socket.send(JSON.stringify([[[[[[success]]]]]]));
  });
  const deepCall = settledState(makeSupervisorRpc(deep.url, "deep-token")("server.getConfig", {}, new AbortController().signal));
  const error = rpcError(await withDeadline(deepCall.outcome, 3_000, "deep batch"));
  assert.equal(error.outcome, "uncertain");
  assert.equal(error.definiteRejection, false);
});
