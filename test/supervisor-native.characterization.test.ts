import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { it, vi, type TestContext } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { makeSupervisorRpc } from "./support/supervisor-native-client.js";
import { makeT3Client, T3Client, T3TransportError } from "../src/t3.js";
import { ProjectFileError } from "../src/project-files.js";
import { GitProbeError } from "../src/git-probe.js";
import { makeGitProbe, makeProjectCommitter, makeProjectFiles } from "./support/native-files-promise.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { fakeT3 } from "./support/c1-git-probe-peer.js";
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

// the shared envelope goldens: exact client frame text, compared byte for byte
const pongFrame = '{"_tag":"Pong"}';
const exitFrame = (requestId: string, exit: unknown) => JSON.stringify({ _tag: "Exit", requestId, exit });
const failureExit = (failure: unknown) => ({ _tag: "Failure", cause: { _tag: "Fail", failure } });
const raw = (peer: { frames: Frame[] }) => peer.frames.map((frame) => frame.data);

it("CT-WSFRAME-01: supervisor-native sends the exact Request frame, answers Ping with Pong and decodes Exit Success and Failure", { timeout: 10_000 }, async (t) => {
  for (const outcome of ["Success", "Failure"] as const) {
    const peer = await startPeer(t, (socket, frame) => {
      if (frame._tag === "Request") socket.send(JSON.stringify({ _tag: "Ping" }));
      else if (frame._tag === "Pong") socket.send(exitFrame("supervisor", outcome === "Success" ? { _tag: "Success", value: { ok: true } } : failureExit({ name: "UnrelatedServerError" })));
    });
    const call = settledState(makeSupervisorRpc(peer.url, "frame-token")("server.getConfig", { probe: 1 }, new AbortController().signal));
    const result = await withDeadline(call.outcome, 3_000, `native ${outcome}`);
    if (outcome === "Success") assert.deepEqual(result, { value: { ok: true } });
    else assert.deepEqual([rpcError(result).outcome, rpcError(result).definiteRejection], ["uncertain", false]);
    assert.deepEqual(raw(peer), ['{"_tag":"Request","id":"supervisor","tag":"server.getConfig","payload":{"probe":1},"headers":[]}', pongFrame]);
  }
});

it("CT-WSFRAME-01: project-files sends exact Request frames, answers Ping, Acks commit Chunks, not snapshot Chunks, and decodes Exits", { timeout: 10_000 }, async (t) => {
  const signal = () => AbortSignal.timeout(3_000);
  for (const outcome of ["Success", "Failure"] as const) {
    const peer = await startPeer(t, (socket, frame) => {
      if (frame._tag === "Request") socket.send(JSON.stringify({ _tag: "Ping" }));
      else if (frame._tag === "Pong") socket.send(exitFrame("definitions", outcome === "Success"
        ? { _tag: "Success", value: { contents: "steps: []\n", byteLength: 10, truncated: false } } : failureExit({ code: "ENOENT" })));
    });
    const read = makeProjectFiles(peer.url, "frame-token").read("/work", ".t3-supervisor/project.yaml", signal());
    if (outcome === "Success") assert.deepEqual(await read, { contents: "steps: []\n", byteLength: 10, truncated: false });
    else await assert.rejects(read, (error: unknown) => error instanceof ProjectFileError && error.code === "missing");
    assert.deepEqual(raw(peer), ['{"_tag":"Request","id":"definitions","tag":"projects.readFile","payload":{"cwd":"/work","relativePath":".t3-supervisor/project.yaml"},"headers":[]}', pongFrame]);
  }

  const commit = await startPeer(t, (socket, frame) => {
    if (frame._tag === "Request") socket.send(JSON.stringify({ _tag: "Ping" }));
    else if (frame._tag === "Pong") socket.send(JSON.stringify({ _tag: "Chunk", requestId: "definition-setup-commit",
      values: [{ actionId: "action-1", kind: "action_finished", result: { commit: { status: "created", commitSha: "abc123" } } }] }));
    else if (frame._tag === "Ack") socket.send(exitFrame("definition-setup-commit", { _tag: "Success", value: null }));
  });
  assert.deepEqual(await makeProjectCommitter(commit.url, "frame-token").commitFiles("/work", [".t3-supervisor/project.yaml"], "Add definitions", "action-1", signal()),
    { status: "committed", commitSha: "abc123" });
  assert.deepEqual(raw(commit), [
    '{"_tag":"Request","id":"definition-setup-commit","tag":"git.runStackedAction","payload":{"actionId":"action-1","cwd":"/work","action":"commit","commitMessage":"Add definitions","filePaths":[".t3-supervisor/project.yaml"]},"headers":[]}',
    pongFrame,
    '{"_tag":"Ack","requestId":"definition-setup-commit"}',
  ]);

  const vcs = await startPeer(t, (socket, frame) => {
    if (frame._tag === "Request" && frame.tag === "vcs.listRefs") socket.send(exitFrame("definitions", { _tag: "Success", value: { isRepo: true, refs: [{ current: true, name: "main" }] } }));
    else if (frame._tag === "Request" && frame.tag === "subscribeVcsStatus") socket.send(JSON.stringify({ _tag: "Chunk", requestId: "definition-vcs-snapshot",
      values: [{ _tag: "snapshot", local: { isRepo: true, workingTree: { files: [{ path: "README.md" }] } } }] }));
  });
  const files = makeProjectFiles(vcs.url, "frame-token");
  assert.ok(files.vcsInfo);
  assert.deepEqual(await files.vcsInfo("/work", signal()), { isRepo: true, branch: "main", changedPaths: ["README.md"] });
  assert.deepEqual(raw(vcs), [
    '{"_tag":"Request","id":"definitions","tag":"vcs.listRefs","payload":{"cwd":"/work","refKind":"local","limit":200},"headers":[]}',
    '{"_tag":"Request","id":"definition-vcs-snapshot","tag":"subscribeVcsStatus","payload":{"cwd":"/work","includeRemote":false},"headers":[]}',
  ]);
});

it("CT-WSFRAME-01: t3.ts subscriptions send exact Request frames, answer Ping with Pong, Ack each Chunk and end on any Exit", { timeout: 10_000 }, async (t) => {
  for (const outcome of ["Success", "Failure"] as const) {
    const peer = await startPeer(t, (socket, frame) => {
      if (frame._tag === "Request" && frame.id === "2") socket.send(JSON.stringify({ _tag: "Ping" }));
      else if (frame._tag === "Pong") socket.send(JSON.stringify({ _tag: "Chunk", requestId: "1", values: [{ kind: "synchronized" }] }));
      else if (frame._tag === "Ack") socket.send(exitFrame("1", outcome === "Success" ? { _tag: "Success", value: null } : failureExit({ message: "ended" })));
    });
    const items: unknown[] = [];
    const watch = T3Client.use((client) => client.watch(7, (item) => Effect.sync(() => { items.push(item); })))
      .pipe(Effect.flip, Effect.provide(makeT3Client({ baseUrl: peer.url, token: "frame-token" })));
    const error = await withDeadline(Effect.runPromise(watch), 5_000, `t3 ${outcome}`);
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
});

it("CT-WSFRAME-01: git-probe sends exact Request frames, answers Ping with Pong, Acks every attach Chunk and decodes Exit Success and Failure", { timeout: 10_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "c1-git-probe-frames-"));
  const store = new GuidanceStore(directory);
  const peers: Array<{ close(): Promise<void> }> = [];
  after(t, async () => {
    for (const peer of peers) await peer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const root = "/work/repository";
  const t3 = await fakeT3(() => ({ workspaceRoot: root, branch: "main", isRepo: true, changedPaths: [], operationState: { status: "safe" } }), 0, { pingBeforeOpenExit: true });
  peers.push(t3);
  assert.deepEqual(await makeGitProbe(t3.url, "frame-token", store).probe(root, AbortSignal.timeout(5_000)),
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

  const refusing = await fakeT3(() => ({ workspaceRoot: root, branch: null, isRepo: false, changedPaths: [], operationState: { status: "safe" } }), 0, { failOpen: true });
  peers.push(refusing);
  await assert.rejects(makeGitProbe(refusing.url, "frame-token", store).probe(root, AbortSignal.timeout(5_000)),
    (error: unknown) => error instanceof GitProbeError && error.message === "T3 rejected a terminal Git probe request.");
  // the refused open is still followed by a history-deleting close of the same session
  assert.deepEqual(refusing.requests.map((request) => request.tag), ["terminal.open", "terminal.close"]);
  assert.deepEqual(refusing.closes.map((payload) => payload.deleteHistory), [true]);
});
