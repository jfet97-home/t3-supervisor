import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { WebSocketServer, type WebSocket } from "ws";
import { GitProbe, GitProbeError } from "../src/git-probe.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { NativeEnvelope } from "../src/native-envelope.js";
import { ProjectCommitter, ProjectFileError, ProjectFiles, ProjectWriter } from "../src/project-files.js";
import { startFakeTerminalT3, type ProbeStatus } from "./support/c3a-fake-terminal-t3.js";

// target regressions of the ported native file clients and git probe: native values pass through unchanged, deadlines run on
// the Effect clock, cancel triggers end calls with their baseline outcome, an interrupted probe still closes its terminal, and
// the envelope's 2 MiB maxPayload gives the outcome the probe's own frame-size check never reached

type Frame = {_tag?: string; id?: string; tag?: string; payload?: Record<string, unknown>};

// a loopback T3 endpoint that answers each request frame as the test chooses, for the test's scope
const peer = (answer: (socket: WebSocket, frame: Frame) => void = () => undefined) => Effect.acquireRelease(Effect.promise(async () => {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0});
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  const requests: Frame[] = [];
  const connections: string[] = [];
  const waiters: Array<{count: number; resolve: () => void}> = [];
  server.on("connection", (socket, upgrade) => {
    connections.push(String(upgrade.url));
    socket.on("message", data => {
      const frame = JSON.parse(data.toString()) as Frame;
      if (frame._tag !== "Request") return;
      requests.push(frame);
      for (const waiter of waiters.splice(0)) if (requests.length >= waiter.count) waiter.resolve();else waiters.push(waiter);
      answer(socket, frame);
    });
  });
  // settles once the peer has received this many request frames
  const received = (count: number) => new Promise<void>(resolve => {if (requests.length >= count) resolve();else waiters.push({count, resolve});});
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {server, url: `http://127.0.0.1:${address.port}`, requests, connections, received, requested: received(1)};
}), ({server}) => Effect.promise(() => {
  for (const client of server.clients) client.terminate();
  return new Promise<void>(resolve => server.close(() => resolve()));
}));
const success = (socket: WebSocket, frame: Frame, value: unknown) => socket.send(JSON.stringify({_tag: "Exit", requestId: frame.id, exit: {_tag: "Success", value}}));
const native = NativeEnvelope.layer;
const probeClients = Layer.merge(NativeEnvelope.layer, NodeCrypto.layer);
const guidanceStore = Effect.acquireRelease(Effect.sync(() => {
  const directory = mkdtempSync(join(tmpdir(), "t3-native-files-service-"));
  return {directory, store: new GuidanceStore(directory)};
}), ({directory, store}) => Effect.sync(() => {store.close();rmSync(directory, {recursive: true, force: true});}));
const pendingSessions = (store: GuidanceStore): unknown =>
  JSON.parse(String(store.db.prepare("SELECT value FROM meta WHERE key='native_git_probe_sessions'").get()?.value));
const root = "/workspace";
const status: ProbeStatus = {workspaceRoot: root, branch: "main", isRepo: true, changedPaths: [], operationState: {status: "safe"}};

it.live("TR-FILES-01: a listing and a read return the native value itself, extra fields and key order included, so a revision hashes what T3 returned", () => Effect.gen(function* () {
  const listing = {entries: [{kind: "file", path: ".t3-supervisor/project.yaml", size: 24}], truncated: false, cursor: null};
  const file = {relativePath: ".t3-supervisor/project.yaml", truncated: false, byteLength: 10, contents: "steps: []\n", encoding: "utf8"};
  const t3 = yield* peer((socket, frame) => success(socket, frame, frame.tag === "projects.listEntries" ? listing : file));
  const files = yield* Effect.provide(ProjectFiles.make({baseUrl: t3.url, token: "read-token"}), native);
  const listed = yield* files.list(root, ".t3-supervisor");
  const read = yield* files.read(root, ".t3-supervisor/project.yaml");
  assert.equal(JSON.stringify(listed), JSON.stringify(listing));
  assert.equal(JSON.stringify(read), JSON.stringify(file));
}), {timeout: 10_000});

it.effect("TR-FILES-02: the 10 s file deadline and the 30 s commit deadline run on the Effect clock against a silent peer", () => Effect.gen(function* () {
  const reads = yield* peer();
  const files = yield* Effect.provide(ProjectFiles.make({baseUrl: reads.url, token: "read-token"}), native);
  const reading = yield* Effect.forkChild(Effect.flip(files.read(root, ".t3-supervisor/project.yaml")));
  yield* Effect.promise(() => reads.requested);
  yield* TestClock.adjust("9999 millis");
  assert.equal(reading.pollUnsafe(), undefined, "the read is still waiting before 10 s");
  yield* TestClock.adjust("1 millis");
  const error = yield* Fiber.join(reading);
  assert.ok(error instanceof ProjectFileError);
  assert.deepEqual([error.code, error.message], ["unavailable", "T3 project file access is unavailable."]);

  const commits = yield* peer();
  const committer = yield* Effect.provide(ProjectCommitter.make({baseUrl: commits.url, token: "commit-token"}), native);
  const committing = yield* Effect.forkChild(committer.commitFiles(root, [".t3-supervisor/project.yaml"], "message", "action-1"));
  yield* Effect.promise(() => commits.requested);
  yield* TestClock.adjust("29999 millis");
  assert.equal(committing.pollUnsafe(), undefined, "the commit is still waiting before 30 s");
  yield* TestClock.adjust("1 millis");
  assert.deepEqual(yield* Fiber.join(committing), {status: "uncertain"});
}), {timeout: 10_000});

it.live("TR-FILES-03: a cancel trigger ends an in-flight read and write as unavailable, and an already completed one never connects", () => Effect.gen(function* () {
  const t3 = yield* peer();
  const files = yield* Effect.provide(ProjectFiles.make({baseUrl: t3.url, token: "read-token"}), native);
  const writer = yield* Effect.provide(ProjectWriter.make({baseUrl: t3.url, token: "write-token"}), native);
  for (const call of [(cancel: Deferred.Deferred<void>) => files.read(root, ".t3-supervisor/project.yaml", cancel),
    (cancel: Deferred.Deferred<void>) => writer.writeProjectConfig(root, "workflows: []\nsteps: []\n", cancel)]) {
    const cancel = yield* Deferred.make<void>();
    const arrived = t3.received(t3.requests.length + 1);
    const pending = yield* Effect.forkChild(Effect.flip(call(cancel)));
    yield* Effect.promise(() => arrived);
    yield* Deferred.succeed(cancel, undefined);
    const error = yield* Fiber.join(pending);
    assert.ok(error instanceof ProjectFileError && error.code === "unavailable");
  }
  const connections = t3.connections.length;
  const completed = yield* Deferred.make<void>();
  yield* Deferred.succeed(completed, undefined);
  const refused = yield* Effect.flip(files.read(root, ".t3-supervisor/project.yaml", completed));
  assert.ok(refused instanceof ProjectFileError && refused.code === "unavailable");
  assert.equal(t3.connections.length, connections, "no connection was opened");
}), {timeout: 10_000});

it.live("TR-PROBE-01: interrupting a probe fiber mid-stream still closes the terminal with deleteHistory, drops the pending entry and stays interrupted", () => Effect.gen(function* () {
  const t3 = yield* Effect.acquireRelease(Effect.promise(() => startFakeTerminalT3(status, () => true)), fake => Effect.promise(() => fake.close()));
  const {store} = yield* guidanceStore;
  const probe = yield* Effect.provide(GitProbe.make({baseUrl: t3.url, token: "terminal-operate-test-token"}, store), probeClients);
  const probing = yield* Effect.forkChild(probe.probe(root));
  const session = yield* Effect.promise(() => t3.helperWritten);
  assert.ok(session);
  assert.deepEqual(pendingSessions(store), [session]);
  yield* Fiber.interrupt(probing);
  assert.ok(Exit.hasInterrupts(yield* Fiber.await(probing)));
  yield* Effect.promise(() => t3.attachGone(session.threadId));
  assert.deepEqual(t3.requests.filter(request => request.tag === "terminal.close").map(request => request.payload), [{...session, deleteHistory: true}]);
  assert.deepEqual(pendingSessions(store), []);
}), {timeout: 10_000});

it.effect("TR-PROBE-02: the 15 s probe deadline runs on the Effect clock; a withheld result ends the probe with the stream's message and the terminal is closed", () => Effect.gen(function* () {
  const t3 = yield* Effect.acquireRelease(Effect.promise(() => startFakeTerminalT3(status, () => true)), fake => Effect.promise(() => fake.close()));
  const {store} = yield* guidanceStore;
  const probe = yield* Effect.provide(GitProbe.make({baseUrl: t3.url, token: "terminal-operate-test-token"}, store), probeClients);
  const probing = yield* Effect.forkChild(Effect.flip(probe.probe(root)));
  const session = yield* Effect.promise(() => t3.helperWritten);
  assert.ok(session);
  yield* TestClock.adjust("14999 millis");
  assert.equal(probing.pollUnsafe(), undefined, "the probe is still waiting before 15 s");
  yield* TestClock.adjust("1 millis");
  const error = yield* Fiber.join(probing);
  assert.ok(error instanceof GitProbeError);
  assert.equal(error.message, "The terminal Git probe was canceled or disconnected.");
  assert.deepEqual(t3.requests.filter(request => request.tag === "terminal.close").map(request => request.payload), [{...session, deleteHistory: true}]);
  assert.deepEqual(pendingSessions(store), []);
}), {timeout: 10_000});

it.live("TR-PROBE-03: a terminal frame one byte above 2 MiB closes the socket and fails the request with the canceled-or-timed-out message", () => Effect.gen(function* () {
  // the frame is the Exit for terminal.open, padded past the probe's 2 MiB maxPayload; the close that follows is answered normally
  const t3 = yield* peer((socket, frame) => {
    if (frame.tag !== "terminal.open") return success(socket, frame, null);
    const exit = JSON.stringify({_tag: "Exit", requestId: frame.id, exit: {_tag: "Success", value: {padding: ""}}});
    socket.send(exit.replace('"padding":""', `"padding":"${"x".repeat(2 * 1024 * 1024 + 1 - exit.length)}"`));
  });
  const {store} = yield* guidanceStore;
  const probe = yield* Effect.provide(GitProbe.make({baseUrl: t3.url, token: "terminal-operate-test-token"}, store), probeClients);
  const error = yield* Effect.flip(probe.probe(root));
  assert.ok(error instanceof GitProbeError);
  assert.equal(error.message, "The Git probe RPC was canceled or timed out.");
  assert.deepEqual(t3.requests.map(request => request.tag), ["terminal.open", "terminal.close"]);
  assert.deepEqual(pendingSessions(store), []);
}), {timeout: 10_000});
