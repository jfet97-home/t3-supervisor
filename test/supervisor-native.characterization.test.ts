import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { WebSocketServer, type WebSocket } from "ws";
import { NativeEnvelope } from "../src/native-envelope.js";
import { NativeRpc, SupervisorRpcError } from "../src/supervisor-native.js";
import { makeT3Client, T3Client, T3TransportError } from "../src/t3.js";
import { ProjectCommitter, ProjectFileError, ProjectFiles } from "../src/project-files.js";
import { GitProbeError } from "../src/git-probe.js";
import { fakeT3 } from "./support/c1-git-probe-peer.js";
import { probeGuidance } from "./support/g10-probe-guidance.js";

// every client here talks to a real loopback T3 peer (ws or http sockets), so the tests are it.live; the two CT-NATIVE-01
// deadline tests are it.effect over the same real peers because they step the client's own deadlines on the TestClock

type Frame = { readonly data: string; readonly binary: boolean };

// a loopback T3 peer that records every client frame and connection, for the test's scope
const startPeer = (onFrame: (socket: WebSocket, frame: Record<string, unknown>) => void) => Effect.acquireRelease(Effect.promise(async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const frames: Frame[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const firstRequest = Deferred.makeUnsafe<void>();
  const clientClosed = Deferred.makeUnsafe<void>();
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (data, binary) => {
      const text = String(data);
      frames.push({ data: text, binary });
      const frame = JSON.parse(text) as Record<string, unknown>;
      if (frame._tag === "Request") {
        requests.push(frame);
        Deferred.doneUnsafe(firstRequest, Effect.void);
      }
      onFrame(socket, frame);
    });
    socket.once("close", () => Deferred.doneUnsafe(clientClosed, Effect.void));
  });
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    frames,
    requests,
    connections: () => connections,
    firstRequest: Deferred.await(firstRequest),
    clientClosed: Deferred.await(clientClosed),
  };
}), ({ server }) => Effect.promise(() => {
  for (const client of server.clients) client.terminate();
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}));

// a loopback http server that holds every websocket upgrade unanswered and records the bytes sent after it, for the test's scope
const startHungServer = Effect.acquireRelease(Effect.promise(async () => {
  const held: Duplex[] = [];
  let bytes = "";
  const upgraded = Deferred.makeUnsafe<void>();
  const server: Server = createServer(() => undefined);
  server.on("upgrade", (_request, socket: Duplex) => {
    held.push(socket);
    socket.on("data", (data: Buffer) => { bytes += data.toString("latin1"); });
    socket.on("error", () => undefined);
    Deferred.doneUnsafe(upgraded, Effect.void);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, held, url: `http://127.0.0.1:${address.port}`, bytes: () => bytes, upgraded: Deferred.await(upgraded) };
}), ({ server, held }) => Effect.promise(() => {
  for (const socket of held) socket.destroy();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}));

// the c1 git probe peer for the test's scope
const gitProbePeer = (...args: Parameters<typeof fakeT3>) => Effect.acquireRelease(Effect.promise(() => fakeT3(...args)), (peer) => Effect.promise(() => peer.close()));

// the production native clients on the shared envelope
const nativeRpc = (baseUrl: string, token: string) => NativeRpc.make({ baseUrl, token }).pipe(Effect.provide(NativeEnvelope.layer));
const projectFiles = (baseUrl: string, token: string) => ProjectFiles.make({ baseUrl, token }).pipe(Effect.provide(NativeEnvelope.layer));
const projectCommitter = (baseUrl: string, token: string) => ProjectCommitter.make({ baseUrl, token }).pipe(Effect.provide(NativeEnvelope.layer));

// a call's outcome as a value, and whether a forked call has settled
const outcomeOf = <A, E>(call: Effect.Effect<A, E>) => Effect.match(call, { onSuccess: (value) => ({ value }), onFailure: (error) => ({ error }) });
const settled = (call: Fiber.Fiber<unknown, unknown>): boolean => call.pollUnsafe() !== undefined;

const rpcError = (outcome: { value?: unknown; error?: unknown }): SupervisorRpcError => {
  assert.ok("error" in outcome, "the call must reject");
  assert.ok(outcome.error instanceof SupervisorRpcError);
  return outcome.error;
};

const exit = (requestId: string, value: unknown) => ({ _tag: "Exit", requestId, exit: { _tag: "Success", value } });

it.effect("CT-NATIVE-01: a received request frame left unanswered settles uncertain at exactly 20000 ms", () => Effect.gen(function* () {
  const peer = yield* startPeer(() => {});
  const rpc = yield* nativeRpc(peer.url, "timeout-token");
  const call = yield* Effect.forkChild(outcomeOf(rpc.call("orchestration.dispatchCommand", { commandId: "command-a" })));
  yield* peer.firstRequest;
  yield* TestClock.adjust("19999 millis");
  assert.equal(settled(call), false);
  yield* TestClock.adjust("1 millis");
  const error = rpcError(yield* Fiber.join(call));
  assert.equal(error.outcome, "uncertain");
  assert.equal(error.definiteRejection, false);
  assert.equal(error.dispatchCommandFailure, false);
  assert.equal(error.message.includes("timeout-token"), false);
  yield* peer.clientClosed;
  assert.equal(peer.requests.length, 1);
  assert.equal(peer.frames.length, 1);
  assert.equal(peer.connections(), 1);
}), { timeout: 10_000 });

it.effect("CT-NATIVE-01: a hung handshake is rejected before open by the 5 s handshake timeout and no frame is sent", () => Effect.gen(function* () {
  const hung = yield* startHungServer;
  const rpc = yield* nativeRpc(hung.url, "hung-token");
  const started = yield* Clock.currentTimeMillis;
  // the call's outcome with the clock reading at which it settled
  const call = yield* Effect.forkChild(Effect.zip(outcomeOf(rpc.call("orchestration.dispatchCommand", { commandId: "command-a" })), Clock.currentTimeMillis));
  // the server holds the upgrade before the clock moves, so the handshake is hung rather than never started
  yield* hung.upgraded;
  yield* TestClock.adjust("20 seconds");
  const [outcome, settledAt] = yield* Fiber.join(call);
  const error = rpcError(outcome);
  const elapsed = settledAt - started;
  assert.equal(error.outcome, "rejected");
  assert.equal(error.definiteRejection, false);
  assert.ok(elapsed >= 4_990 && elapsed < 20_000, `rejected after ${Math.round(elapsed)} ms`);
  assert.equal(hung.held.length, 1);
  assert.equal(hung.bytes(), "");
}), { timeout: 60_000 });

it.live("CT-NATIVE-02: aborting after the peer received the request frame is uncertain, not definite, with no second frame", () => Effect.gen(function* () {
  const peer = yield* startPeer(() => {});
  const rpc = yield* nativeRpc(peer.url, "abort-token");
  const cancel = yield* Deferred.make<void>();
  const call = yield* Effect.forkChild(outcomeOf(rpc.call("orchestration.dispatchCommand", { commandId: "command-a" }, cancel)));
  yield* peer.firstRequest;
  assert.equal(settled(call), false);
  yield* Deferred.succeed(cancel, undefined);
  const error = rpcError(yield* Fiber.join(call));
  assert.equal(error.outcome, "uncertain");
  assert.equal(error.definiteRejection, false);
  assert.equal(error.providerDisabled, false);
  assert.equal(error.dispatchCommandFailure, false);
  yield* peer.clientClosed;
  assert.deepEqual(peer.requests, [{ _tag: "Request", id: "supervisor", tag: "orchestration.dispatchCommand", payload: { commandId: "command-a" }, headers: [] }]);
  assert.equal(peer.frames.length, 1);
  assert.equal(peer.connections(), 1);
}), { timeout: 10_000 });

it.live("CT-NATIVE-03: a binary frame after send is uncertain even when it carries a valid Exit", () => Effect.gen(function* () {
  const peer = yield* startPeer((socket, frame) => {
    if (frame._tag === "Request") socket.send(Buffer.from(JSON.stringify(exit("supervisor", { ok: true }))), { binary: true });
  });
  const rpc = yield* nativeRpc(peer.url, "binary-token");
  const error = rpcError(yield* outcomeOf(rpc.call("server.getConfig", {})));
  assert.equal(error.outcome, "uncertain");
  assert.equal(error.definiteRejection, false);
  assert.equal(peer.requests.length, 1);
}), { timeout: 10_000 });

it.live("CT-NATIVE-03: an Exit for another requestId is ignored and the matching Exit settles the call", () => Effect.gen(function* () {
  const peer = yield* startPeer((socket, frame) => {
    if (frame._tag === "Request") {
      socket.send(JSON.stringify(exit("other", "wrong")));
      socket.send(JSON.stringify({ _tag: "Exit", requestId: "other", exit: { _tag: "Failure", cause: { _tag: "Fail", failure: { name: "OrchestratorCommandPreviouslyRejectedError" } } } }));
      socket.send(JSON.stringify({ _tag: "Ping" }));
    } else if (frame._tag === "Pong") {
      // the client answered the ping after both foreign exits, so neither settled it
      socket.send(JSON.stringify(exit("supervisor", "right")));
    }
  });
  const rpc = yield* nativeRpc(peer.url, "foreign-token");
  const outcome = yield* outcomeOf(rpc.call("server.getConfig", {}));
  assert.deepEqual(outcome, { value: "right" });
  assert.deepEqual(peer.frames.map((frame) => (JSON.parse(frame.data) as { _tag: string })._tag), ["Request", "Pong"]);
}), { timeout: 10_000 });

it.live("CT-NATIVE-03: batched array frames are flattened up to four levels and deeper nesting fails closed", () => Effect.gen(function* () {
  const success = exit("supervisor", { batched: true });
  const peer = yield* startPeer((socket, frame) => {
    if (frame._tag === "Request") socket.send(JSON.stringify([[{ _tag: "Ping" }]]));
    else if (frame._tag === "Pong") socket.send(JSON.stringify([[[[exit("other", "wrong")]]], [[[[success]]]]]));
  });
  const rpc = yield* nativeRpc(peer.url, "batch-token");
  assert.deepEqual(yield* outcomeOf(rpc.call("server.getConfig", {})), { value: { batched: true } });
  assert.deepEqual(peer.frames.map((frame) => (JSON.parse(frame.data) as { _tag: string })._tag), ["Request", "Pong"]);

  const deep = yield* startPeer((socket, frame) => {
    if (frame._tag === "Request") socket.send(JSON.stringify([[[[[[success]]]]]]));
  });
  const deepRpc = yield* nativeRpc(deep.url, "deep-token");
  const error = rpcError(yield* outcomeOf(deepRpc.call("server.getConfig", {})));
  assert.equal(error.outcome, "uncertain");
  assert.equal(error.definiteRejection, false);
}), { timeout: 10_000 });

// the shared envelope goldens: exact client frame text, compared byte for byte
const pongFrame = '{"_tag":"Pong"}';
const exitFrame = (requestId: string, exit: unknown) => JSON.stringify({ _tag: "Exit", requestId, exit });
const failureExit = (failure: unknown) => ({ _tag: "Failure", cause: { _tag: "Fail", failure } });
const raw = (peer: { frames: Frame[] }) => peer.frames.map((frame) => frame.data);

it.live("CT-WSFRAME-01: supervisor-native sends the exact Request frame, answers Ping with Pong and decodes Exit Success and Failure", () => Effect.gen(function* () {
  for (const outcome of ["Success", "Failure"] as const) {
    const peer = yield* startPeer((socket, frame) => {
      if (frame._tag === "Request") socket.send(JSON.stringify({ _tag: "Ping" }));
      else if (frame._tag === "Pong") socket.send(exitFrame("supervisor", outcome === "Success" ? { _tag: "Success", value: { ok: true } } : failureExit({ name: "UnrelatedServerError" })));
    });
    const rpc = yield* nativeRpc(peer.url, "frame-token");
    const result = yield* outcomeOf(rpc.call("server.getConfig", { probe: 1 }));
    if (outcome === "Success") assert.deepEqual(result, { value: { ok: true } });
    else assert.deepEqual([rpcError(result).outcome, rpcError(result).definiteRejection], ["uncertain", false]);
    assert.deepEqual(raw(peer), ['{"_tag":"Request","id":"supervisor","tag":"server.getConfig","payload":{"probe":1},"headers":[]}', pongFrame]);
  }
}), { timeout: 10_000 });

it.live("CT-WSFRAME-01: project-files sends exact Request frames, answers Ping, Acks commit Chunks, not snapshot Chunks, and decodes Exits", () => Effect.gen(function* () {
  for (const outcome of ["Success", "Failure"] as const) {
    const peer = yield* startPeer((socket, frame) => {
      if (frame._tag === "Request") socket.send(JSON.stringify({ _tag: "Ping" }));
      else if (frame._tag === "Pong") socket.send(exitFrame("definitions", outcome === "Success"
        ? { _tag: "Success", value: { contents: "steps: []\n", byteLength: 10, truncated: false } } : failureExit({ code: "ENOENT" })));
    });
    const read = (yield* projectFiles(peer.url, "frame-token")).read("/work", ".t3-supervisor/project.yaml");
    if (outcome === "Success") assert.deepEqual(yield* read, { contents: "steps: []\n", byteLength: 10, truncated: false });
    else {
      const error = yield* Effect.flip(read);
      assert.ok(error instanceof ProjectFileError && error.code === "missing");
    }
    assert.deepEqual(raw(peer), ['{"_tag":"Request","id":"definitions","tag":"projects.readFile","payload":{"cwd":"/work","relativePath":".t3-supervisor/project.yaml"},"headers":[]}', pongFrame]);
  }

  const commit = yield* startPeer((socket, frame) => {
    if (frame._tag === "Request") socket.send(JSON.stringify({ _tag: "Ping" }));
    else if (frame._tag === "Pong") socket.send(JSON.stringify({ _tag: "Chunk", requestId: "definition-setup-commit",
      values: [{ actionId: "action-1", kind: "action_finished", result: { commit: { status: "created", commitSha: "abc123" } } }] }));
    else if (frame._tag === "Ack") socket.send(exitFrame("definition-setup-commit", { _tag: "Success", value: null }));
  });
  assert.deepEqual(yield* (yield* projectCommitter(commit.url, "frame-token")).commitFiles("/work", [".t3-supervisor/project.yaml"], "Add definitions", "action-1"),
    { status: "committed", commitSha: "abc123" });
  assert.deepEqual(raw(commit), [
    '{"_tag":"Request","id":"definition-setup-commit","tag":"git.runStackedAction","payload":{"actionId":"action-1","cwd":"/work","action":"commit","commitMessage":"Add definitions","filePaths":[".t3-supervisor/project.yaml"]},"headers":[]}',
    pongFrame,
    '{"_tag":"Ack","requestId":"definition-setup-commit"}',
  ]);

  const vcs = yield* startPeer((socket, frame) => {
    if (frame._tag === "Request" && frame.tag === "vcs.listRefs") socket.send(exitFrame("definitions", { _tag: "Success", value: { isRepo: true, refs: [{ current: true, name: "main", isDefault: true, worktreePath: "/work" }] } }));
    else if (frame._tag === "Request" && frame.tag === "subscribeVcsStatus") socket.send(JSON.stringify({ _tag: "Chunk", requestId: "definition-vcs-snapshot",
      values: [{ _tag: "snapshot", local: { isRepo: true, workingTree: { files: [{ path: "README.md" }] } } }] }));
  });
  const files = yield* projectFiles(vcs.url, "frame-token");
  assert.ok(files.vcsInfo);
  assert.deepEqual(yield* files.vcsInfo("/work"), { isRepo: true, branch: "main", refs: [{ current: true, name: "main", isDefault: true, worktreePath: "/work" }], changedPaths: ["README.md"] });
  assert.deepEqual(raw(vcs), [
    '{"_tag":"Request","id":"definitions","tag":"vcs.listRefs","payload":{"cwd":"/work","refKind":"all","limit":200},"headers":[]}',
    '{"_tag":"Request","id":"definition-vcs-snapshot","tag":"subscribeVcsStatus","payload":{"cwd":"/work","includeRemote":false},"headers":[]}',
  ]);
}), { timeout: 10_000 });

it.live("CT-WSFRAME-01: t3.ts subscriptions send exact Request frames, answer Ping with Pong, Ack each Chunk and end on any Exit", () => Effect.gen(function* () {
  for (const outcome of ["Success", "Failure"] as const) {
    const peer = yield* startPeer((socket, frame) => {
      if (frame._tag === "Request" && frame.id === "2") socket.send(JSON.stringify({ _tag: "Ping" }));
      else if (frame._tag === "Pong") socket.send(JSON.stringify({ _tag: "Chunk", requestId: "1", values: [{ kind: "synchronized" }] }));
      else if (frame._tag === "Ack") socket.send(exitFrame("1", outcome === "Success" ? { _tag: "Success", value: null } : failureExit({ message: "ended" })));
    });
    const items: unknown[] = [];
    const watch = T3Client.use((client) => client.watch(7, (item) => Effect.sync(() => { items.push(item); })))
      .pipe(Effect.flip, Effect.provide(makeT3Client({ baseUrl: peer.url, token: "frame-token" })));
    const error = yield* watch;
    assert.ok(error instanceof T3TransportError);
    assert.equal(error.message, "T3 subscription ended");
    assert.deepEqual(items, [{ stream: "active", item: { kind: "synchronized" } }]);
    assert.deepEqual(raw(peer), [
      '{"_tag":"Request","id":"1","tag":"orchestration.subscribeShell","payload":{"afterSequence":7},"headers":[]}',
      '{"_tag":"Request","id":"2","tag":"orchestration.subscribeArchivedShell","payload":{},"headers":[]}',
      pongFrame,
      '{"_tag":"Ack","requestId":"1"}',
    ]);
  }
}), { timeout: 10_000 });

it.live("CT-WSFRAME-01: git-probe sends exact Request frames, answers Ping with Pong, Acks every attach Chunk and decodes Exit Success and Failure", () => Effect.gen(function* () {
  // the peers close first, then the guidance client, then its directory is removed
  const state = yield* probeGuidance("c1-git-probe-frames-");
  const root = "/work/repository";
  const t3 = yield* gitProbePeer(() => ({ workspaceRoot: root, branch: "main", isRepo: true, changedPaths: [], operationState: { status: "safe" } }), 0, { pingBeforeOpenExit: true });
  assert.deepEqual(yield* (yield* state.gitProbe(t3.url, "frame-token")).probe(root),
    { workspaceRoot: root, branch: "main", isRepo: true, changedPaths: [], operationState: { status: "safe" } });
  const frames = t3.frames.map((text) => ({ text, frame: JSON.parse(text) as { _tag: string; id?: string; tag?: string; payload?: unknown; requestId?: string } }));
  const requests = frames.filter(({ frame }) => frame._tag === "Request");
  assert.deepEqual(requests.map(({ frame }) => frame.tag), ["terminal.open", "terminal.attach", "terminal.write", "terminal.write", "terminal.close"]);
  for (const { text, frame } of requests) {
    assert.match(String(frame.id), frame.tag === "terminal.attach" ? /^git-probe-stream-[0-9a-f-]{36}$/u : /^git-probe-[0-9a-f-]{36}$/u);
    assert.equal(text, JSON.stringify({ _tag: "Request", id: frame.id, tag: frame.tag, payload: frame.payload, headers: [] }));
  }
  assert.deepEqual(frames.filter(({ frame }) => frame._tag === "Pong").map(({ text }) => text), [pongFrame]);
  const streamId = requests.find(({ frame }) => frame.tag === "terminal.attach")?.frame.id;
  const acks = frames.filter(({ frame }) => frame._tag === "Ack").map(({ text }) => text);
  assert.deepEqual(acks, Array.from({ length: 5 }, () => `{"_tag":"Ack","requestId":"${streamId}"}`));
  assert.equal(frames.length, requests.length + 1 + acks.length);

  const refusing = yield* gitProbePeer(() => ({ workspaceRoot: root, branch: null, isRepo: false, changedPaths: [], operationState: { status: "safe" } }), 0, { failOpen: true });
  const refused = yield* Effect.flip((yield* state.gitProbe(refusing.url, "frame-token")).probe(root));
  assert.ok(refused instanceof GitProbeError && refused.message === "T3 rejected a terminal Git probe request.");
  // the refused open is still followed by a history-deleting close of the same session
  assert.deepEqual(refusing.requests.map((request) => request.tag), ["terminal.open", "terminal.close"]);
  assert.deepEqual(refusing.closes.map((payload) => payload.deleteHistory), [true]);
}), { timeout: 10_000 });
