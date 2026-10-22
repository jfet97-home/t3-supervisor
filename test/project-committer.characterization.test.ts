import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { it, type TestContext } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ProjectFileError } from "../src/project-files.js";
import { makeProjectCommitter, makeProjectFiles, makeProjectWriter } from "./support/native-files-promise.js";
import { defer, deferred, within } from "./support/c3b-http.js";

type Frame = {_tag?: string; id?: string; tag?: string; payload?: Record<string, unknown>};

// a loopback T3 websocket endpoint whose behaviour per request frame is chosen by the test
const nativePeer = async (t: TestContext, options: {
  onRequest?: (socket: WebSocket, frame: Frame) => void;
  verifyClient?: (info: {req: IncomingMessage}) => boolean;
} = {}) => {
  const connections: string[] = [];
  const requests: Frame[] = [];
  const server = new WebSocketServer({host: "127.0.0.1", port: 0, ...(options.verifyClient ? {verifyClient: options.verifyClient} : {})});
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  server.on("connection", (socket, upgrade) => {
    connections.push(String(upgrade.url));
    socket.on("message", data => {
      const frame = JSON.parse(data.toString()) as Frame;
      if (frame._tag !== "Request") return;
      requests.push(frame);
      options.onRequest?.(socket, frame);
    });
  });
  defer(t, async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {url: `http://127.0.0.1:${address.port}`, connections, requests};
};

const failWith = (cause: unknown) => (socket: WebSocket, frame: Frame) =>
  socket.send(JSON.stringify({_tag: "Exit", requestId: frame.id, exit: {_tag: "Failure", cause}}));

const commitArgs = [["/workspace", [".t3-supervisor/project.yaml"], "Initialize T3 Supervisor definitions", "supervisor-setup-c3b"]] as const;
const commit = (url: string, signal: AbortSignal) => makeProjectCommitter(url, "commit-token").commitFiles(...commitArgs[0], signal);

it("CT-FILES-01: a commit whose connection drops after the request frame is uncertain; any close, even before open, is uncertain; a pre-aborted signal never connects", {timeout: 10_000}, async t => {
  const received = deferred<Frame>();
  const dropping = await nativePeer(t, {onRequest: (socket, frame) => {received.resolve(frame);socket.terminate();}});
  assert.deepEqual(await within(commit(dropping.url, AbortSignal.timeout(5_000)), 5_000, "dropped commit"), {status: "uncertain"});
  const frame = await received.promise;
  assert.equal(frame.tag, "git.runStackedAction");
  assert.deepEqual(frame.payload, {actionId: "supervisor-setup-c3b", cwd: "/workspace", action: "commit",
    commitMessage: "Initialize T3 Supervisor definitions", filePaths: [".t3-supervisor/project.yaml"]});
  assert.equal(dropping.requests.length, 1);

  // a refused upgrade closes before open and is still reported as uncertain, never as unsent
  const refusing = await nativePeer(t, {verifyClient: () => false});
  assert.deepEqual(await within(commit(refusing.url, AbortSignal.timeout(5_000)), 5_000, "refused commit"), {status: "uncertain"});
  assert.deepEqual(refusing.connections, []);

  // a signal aborted while the request is in flight is uncertain as well
  const holding = deferred();
  const silent = await nativePeer(t, {onRequest: () => holding.resolve()});
  const cancel = new AbortController();
  const pending = commit(silent.url, cancel.signal);
  await within(holding.promise, 5_000, "commit request frame");
  cancel.abort();
  assert.deepEqual(await within(pending, 5_000, "aborted commit"), {status: "uncertain"});

  const untouched = await nativePeer(t);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(commit(untouched.url, aborted.signal), (error: unknown) =>
    error instanceof ProjectFileError && error.code === "unavailable" && error.message === "T3 project file access is unavailable.");
  assert.deepEqual(untouched.connections, [], "no connection was opened");
  assert.deepEqual(untouched.requests, []);
});

const authorization = {failures: [{_tag: "Fail", error: {_tag: "RpcClientError", cause: {_tag: "EnvironmentAuthorizationError", message: "denied"}}}]};

it("CT-FILES-02: native failure classification maps nested authorization, ENOENT, access and file failures to the golden codes and messages", {timeout: 10_000}, async t => {
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
  const peer = await nativePeer(t, {onRequest: (socket, frame) => failWith(causes[String(frame.payload?.relativePath ?? frame.payload?.actionId).split("/").at(-1)!])(socket, frame)});
  const files = makeProjectFiles(peer.url, "read-token");
  const writer = makeProjectWriter(peer.url, "write-token");
  const outcome = async (operation: Promise<unknown>) => {
    try {await operation;return "resolved";}
    catch (error) {return error instanceof ProjectFileError ? [error.code, error.message] : String(error);}
  };
  const read = (name: string) => outcome(files.read("/workspace", `.t3-supervisor/${name}`, AbortSignal.timeout(5_000)));
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
  for (const [name, code] of Object.entries(golden)) assert.deepEqual(await read(name), [code, readMessages[code]], name);

  // the write scope names the write credential; the committer only distinguishes permission from an unconfirmed failure
  assert.deepEqual(await outcome(writer.writeFile!("/workspace", ".t3-supervisor/authorization", "x", AbortSignal.timeout(5_000))),
    ["permission_required", "Enable filesystem:write on the Supervisor write credential through deployment setup."]);
  assert.deepEqual(await outcome(writer.writeFile!("/workspace", ".t3-supervisor/enoentMessage", "x", AbortSignal.timeout(5_000))),
    ["missing", "The requested project path does not exist."]);
  const committer = makeProjectCommitter(peer.url, "commit-token");
  const commitWith = (actionId: string) => outcome(committer.commitFiles("/workspace", [".t3-supervisor/project.yaml"], "message", actionId, AbortSignal.timeout(5_000)));
  assert.deepEqual(await commitWith("authorization"), ["permission_required", "Enable filesystem:write on the Supervisor write credential through deployment setup."]);
  assert.deepEqual(await commitWith("enoentMessage"), ["unavailable", "T3 project file access is unavailable."]);
  assert.deepEqual(await commitWith("unknown"), ["unavailable", "T3 project file access is unavailable."]);
  assert.equal(peer.requests.length, Object.keys(golden).length + 5);
});
