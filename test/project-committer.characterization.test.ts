import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { WebSocketServer, type WebSocket } from "ws";
import { NativeEnvelope } from "../src/native-envelope.js";
import { ProjectCommitter, ProjectFileError, ProjectFiles, ProjectWriter } from "../src/project-files.js";
import { cancelAfter, within } from "./support/g5a-bounds.js";

type Frame = {_tag?: string; id?: string; tag?: string; payload?: Record<string, unknown>};

// a loopback T3 websocket endpoint whose behaviour per request frame is chosen by the test; it closes with the test's scope
const nativePeer = (options: {
  onRequest?: (socket: WebSocket, frame: Frame) => void;
  verifyClient?: (info: {req: IncomingMessage}) => boolean;
} = {}) => Effect.gen(function* () {
  const connections: string[] = [];
  const requests: Frame[] = [];
  const server = yield* Effect.acquireRelease(Effect.promise(async () => {
    const listening = new WebSocketServer({host: "127.0.0.1", port: 0, ...(options.verifyClient ? {verifyClient: options.verifyClient} : {})});
    await new Promise<void>(resolve => listening.once("listening", () => resolve()));
    return listening;
  }), listening => Effect.promise(async () => {
    for (const client of listening.clients) client.terminate();
    await new Promise<void>(resolve => listening.close(() => resolve()));
  }));
  server.on("connection", (socket, upgrade) => {
    connections.push(String(upgrade.url));
    socket.on("message", data => {
      const frame = JSON.parse(data.toString()) as Frame;
      if (frame._tag !== "Request") return;
      requests.push(frame);
      options.onRequest?.(socket, frame);
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {url: `http://127.0.0.1:${address.port}`, connections, requests};
});

const failWith = (cause: unknown) => (socket: WebSocket, frame: Frame) =>
  socket.send(JSON.stringify({_tag: "Exit", requestId: frame.id, exit: {_tag: "Failure", cause}}));

// one native call whose cancel trigger completes after 5 s
const timed = <A, E>(call: (cancel: Deferred.Deferred<void>) => Effect.Effect<A, E>) => Effect.scoped(Effect.flatMap(cancelAfter("5 seconds"), call));
const commitArgs = [["/workspace", [".t3-supervisor/project.yaml"], "Initialize T3 Supervisor definitions", "supervisor-setup-c3b"]] as const;
const commit = (url: string, cancel: Deferred.Deferred<void>) => ProjectCommitter.make({baseUrl: url, token: "commit-token"}).pipe(
  Effect.provide(NativeEnvelope.layer), Effect.flatMap(committer => committer.commitFiles(...commitArgs[0], cancel)));

it.live("CT-FILES-01: a commit whose connection drops after the request frame is uncertain; any close, even before open, is uncertain; a pre-aborted signal never connects", () => Effect.gen(function* () {
  const received = yield* Deferred.make<Frame>();
  const dropping = yield* nativePeer({onRequest: (socket, frame) => {Deferred.doneUnsafe(received, Effect.succeed(frame));socket.terminate();}});
  assert.deepEqual(yield* within(timed(cancel => commit(dropping.url, cancel)), 5_000, "dropped commit"), {status: "uncertain"});
  const frame = yield* Deferred.await(received);
  assert.equal(frame.tag, "git.runStackedAction");
  assert.deepEqual(frame.payload, {actionId: "supervisor-setup-c3b", cwd: "/workspace", action: "commit",
    commitMessage: "Initialize T3 Supervisor definitions", filePaths: [".t3-supervisor/project.yaml"]});
  assert.equal(dropping.requests.length, 1);

  // a refused upgrade closes before open and is still reported as uncertain, never as unsent
  const refusing = yield* nativePeer({verifyClient: () => false});
  assert.deepEqual(yield* within(timed(cancel => commit(refusing.url, cancel)), 5_000, "refused commit"), {status: "uncertain"});
  assert.deepEqual(refusing.connections, []);

  // a cancel trigger completed while the request is in flight is uncertain as well
  const holding = yield* Deferred.make<void>();
  const silent = yield* nativePeer({onRequest: () => {Deferred.doneUnsafe(holding, Effect.void);}});
  const cancel = yield* Deferred.make<void>();
  const pending = yield* Effect.forkChild(commit(silent.url, cancel));
  yield* within(Deferred.await(holding), 5_000, "commit request frame");
  yield* Deferred.succeed(cancel, undefined);
  assert.deepEqual(yield* within(Fiber.join(pending), 5_000, "aborted commit"), {status: "uncertain"});

  // a cancel trigger completed before the call never connects
  const untouched = yield* nativePeer();
  const aborted = yield* Deferred.make<void>();
  yield* Deferred.succeed(aborted, undefined);
  const error = yield* Effect.flip(commit(untouched.url, aborted));
  assert.ok(error instanceof ProjectFileError && error.code === "unavailable" && error.message === "T3 project file access is unavailable.");
  assert.deepEqual(untouched.connections, [], "no connection was opened");
  assert.deepEqual(untouched.requests, []);
}), {timeout: 10_000});

const authorization = {failures: [{_tag: "Fail", error: {_tag: "RpcClientError", cause: {_tag: "EnvironmentAuthorizationError", message: "denied"}}}]};

it.live("CT-FILES-02: native failure classification maps nested authorization, ENOENT, access and file failures to the golden codes and messages", () => Effect.gen(function* () {
  const causes: Record<string, unknown> = {
    authorization,
    enoentMessage: {failures: [{_tag: "Fail", error: {message: "ENOENT: no such file or directory, open '/workspace/.t3-supervisor/project.yaml'"}}]},
    enoentCode: {error: {code: "ENOENT"}},
    eacces: {error: {code: "EACCES"}},
    epermMessage: {error: {message: "EPERM: operation not permitted"}},
    binary: {error: {failure: "binary_file"}},
    directory: {error: {failure: "path_not_file"}},
    authorizationBeatsEnoent: {first: {code: "ENOENT"}, second: [{_tag: "EnvironmentAuthorizationError"}]},
    accessBeatsEnoent: {first: {code: "ENOENT"}, second: {code: "EACCES"}},
    unknown: {failures: [{_tag: "Die", defect: "boom"}]},
    tooDeep: [[[[[[[[[[[[[{_tag: "EnvironmentAuthorizationError"}]]]]]]]]]]]]],
  };
  const peer = yield* nativePeer({onRequest: (socket, frame) => failWith(causes[String(frame.payload?.relativePath ?? frame.payload?.actionId).split("/").at(-1)!])(socket, frame)});
  const files = yield* ProjectFiles.make({baseUrl: peer.url, token: "read-token"}).pipe(Effect.provide(NativeEnvelope.layer));
  const writer = yield* ProjectWriter.make({baseUrl: peer.url, token: "write-token"}).pipe(Effect.provide(NativeEnvelope.layer));
  // an operation's outcome: resolved, or its native file failure's code and message
  const outcome = (operation: Effect.Effect<unknown, ProjectFileError>) => Effect.match(operation, {
    onSuccess: (): unknown => "resolved",
    onFailure: (error): unknown => error instanceof ProjectFileError ? [error.code, error.message] : String(error),
  });
  const read = (name: string) => timed(cancel => outcome(files.read("/workspace", `.t3-supervisor/${name}`, cancel)));
  const readMessages = {
    permission_required: "Enable filesystem:read on the Supervisor read credential through deployment setup.",
    missing: "The requested project path does not exist.",
    invalid_file: "Definitions must be readable UTF-8 text files, not binary files or directories.",
    unavailable: "T3 project file access is unavailable.",
  };
  const golden: Record<string, keyof typeof readMessages> = {
    authorization: "permission_required", enoentMessage: "missing", enoentCode: "missing", eacces: "invalid_file", epermMessage: "invalid_file",
    binary: "invalid_file", directory: "invalid_file", authorizationBeatsEnoent: "permission_required", accessBeatsEnoent: "invalid_file",
    unknown: "unavailable", tooDeep: "unavailable",
  };
  for (const [name, code] of Object.entries(golden)) assert.deepEqual(yield* read(name), [code, readMessages[code]], name);

  // the write scope names the write credential; the committer only distinguishes permission from an unconfirmed failure
  assert.deepEqual(yield* timed(cancel => outcome(writer.writeFile("/workspace", ".t3-supervisor/authorization", "x", cancel))),
    ["permission_required", "Enable filesystem:write on the Supervisor write credential through deployment setup."]);
  assert.deepEqual(yield* timed(cancel => outcome(writer.writeFile("/workspace", ".t3-supervisor/enoentMessage", "x", cancel))),
    ["missing", "The requested project path does not exist."]);
  const committer = yield* ProjectCommitter.make({baseUrl: peer.url, token: "commit-token"}).pipe(Effect.provide(NativeEnvelope.layer));
  const commitWith = (actionId: string) => timed(cancel => outcome(committer.commitFiles("/workspace", [".t3-supervisor/project.yaml"], "message", actionId, cancel)));
  assert.deepEqual(yield* commitWith("authorization"), ["permission_required", "Enable filesystem:write on the Supervisor write credential through deployment setup."]);
  assert.deepEqual(yield* commitWith("enoentMessage"), ["unavailable", "T3 project file access is unavailable."]);
  assert.deepEqual(yield* commitWith("unknown"), ["unavailable", "T3 project file access is unavailable."]);
  assert.equal(peer.requests.length, Object.keys(golden).length + 5);
}), {timeout: 10_000});
