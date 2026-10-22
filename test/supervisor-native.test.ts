import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { WebSocketServer } from "ws";
import { NativeEnvelope } from "../src/native-envelope.js";
import {
  modelSelection,
  NativeRpc,
  NativeShell,
  SupervisorRpcError,
  supervisorModels,
  validModelSelection,
} from "../src/supervisor-native.js";

const startServer = Effect.acquireRelease(Effect.gen(function* () {
  const server = new WebSocketServer({ port: 0 });
  yield* Effect.callback<void>((resume) => {server.once("listening", () => resume(Effect.void));});
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: "http://127.0.0.1:" + address.port };
}), ({ server }) => Effect.callback<void>((resume) => {server.close((error) => resume(error ? Effect.die(error) : Effect.void));}));

const startHttpServer = (handler: (request: IncomingMessage, response: ServerResponse) => void) => Effect.acquireRelease(Effect.gen(function* () {
  const server: Server = createServer(handler);
  yield* Effect.callback<void>((resume) => {
    server.once("error", (error) => resume(Effect.die(error)));
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: "http://127.0.0.1:" + address.port };
}), ({ server }) => Effect.callback<void>((resume) => {server.close((error) => resume(error ? Effect.die(error) : Effect.void));}));

// one native call over the real envelope, as the read or operate client of that credential
const rpc = (url: string, token: string, tag: string, payload: Record<string, unknown>, cancel?: Deferred.Deferred<void>) =>
  NativeRpc.use((client) => client.call(tag, payload, cancel)).pipe(Effect.provide(NativeRpc.layer({ baseUrl: url, token })), Effect.provide(NativeEnvelope.layer));

// the archived snapshot rpc a test answers itself
const archive = (call: (tag: string, payload: Record<string, unknown>) => Promise<unknown>) => Layer.succeed(NativeRpc, NativeRpc.of({
  call: (tag, payload) => Effect.promise(() => call(tag, { ...payload })),
  initiate: () => Effect.die("the shell reads only call"),
}));

const readBaseline = (url: string, token: string, archived: Layer.Layer<NativeRpc>) =>
  NativeShell.use((shell) => shell.baseline).pipe(Effect.provide(NativeShell.layer({ baseUrl: url, token }).pipe(Layer.provide([archived, FetchHttpClient.layer]))));

// assert.rejects for an effect
const rejects = <A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (cause: unknown) => boolean) => Effect.match(effect, {
  onSuccess: () => assert.fail("the effect succeeded"),
  onFailure: (cause) => assert.ok(predicate(cause)),
});

const validConfig = {
  providers: [{
    enabled: true,
    instanceId: "codex",
    displayName: "Codex",
    installed: true,
    status: "ready",
    models: [{
      slug: "gpt-6-luna",
      name: "Luna",
      capabilities: { optionDescriptors: [{
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        currentValue: "high",
        options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }, { id: "max", label: "Max" }],
      }] },
    }],
  }],
};

it.live("native RPC authenticates and uses the orchestration request and response frames", () => Effect.gen(function* () {
  const { server, url } = yield* startServer;
  let authorization: string | undefined;
  let request: unknown;
  let pongSeen = false;
  server.on("connection", (socket, incoming) => {
    authorization = incoming.headers.authorization;
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (typeof frame !== "object" || frame === null) return;
      const value = frame as Record<string, unknown>;
      if (value._tag === "Request") {
        request = value;
        socket.send(JSON.stringify({ _tag: "Ping" }));
      } else if (value._tag === "Pong") {
        pongSeen = true;
        socket.send(JSON.stringify({ _tag: "Exit", requestId: "supervisor", exit: { _tag: "Success", value: { ok: true } } }));
      }
    });
  });

  const result = yield* rpc(url, "test-native-token", "server.getConfig", {}).pipe(Effect.timeout("2 seconds"));
  assert.deepEqual(result, { ok: true });
  assert.equal(authorization, "Bearer test-native-token");
  assert.deepEqual(request, {
    _tag: "Request",
    id: "supervisor",
    tag: "server.getConfig",
    payload: {},
    headers: [],
  });
  assert.equal(pongSeen, true);
}));

it.live("malformed native RPC responses fail closed with a credential-free error", () => Effect.gen(function* () {
  const { server, url } = yield* startServer;
  server.on("connection", (socket) => socket.once("message", () => {
    socket.send(JSON.stringify({ _tag: "Exit", requestId: "supervisor", exit: "success" }));
  }));

  yield* rejects(
    rpc(url, "private-test-token", "server.getConfig", {}).pipe(Effect.timeout("1500 millis")),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "uncertain" && !cause.message.includes("private-test-token"),
  );
}));

it.live("native RPC marks a socket closed before open rejected without claiming a definite T3 rejection", () => Effect.gen(function* () {
  const {server, url} = yield* startHttpServer(() => undefined);
  let requestFrameObserved = false;
  server.on("upgrade", (_request, socket) => {
    socket.on("data", data => {if (data.toString().includes('"_tag":"Request"')) requestFrameObserved = true;});
    socket.destroy();
  });

  yield* rejects(
    rpc(url, "pre-send-close-token", "orchestration.dispatchCommand", {type: "message.dispatch"}).pipe(Effect.timeout("1500 millis")),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected" && !cause.definiteRejection && !cause.dispatchCommandFailure,
  );
  assert.equal(requestFrameObserved, false, "the socket never opened and no native request frame was sent");
}));

it.live("native RPC rejects an already-aborted call without opening a socket or claiming a T3 rejection", () => Effect.gen(function* () {
  const {server, url} = yield* startServer;
  let connections = 0;
  server.on("connection", () => {connections += 1;});
  const cancel = yield* Deferred.make<void>();
  yield* Deferred.succeed(cancel, undefined);

  yield* rejects(
    rpc(url, "pre-aborted-token", "orchestration.dispatchCommand", {type: "message.dispatch"}, cancel),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected" && !cause.definiteRejection,
  );
  assert.equal(connections, 0);
}));

it.live("native RPC classifies a connection drop after sending as uncertain", () => Effect.gen(function* () {
  const {server, url} = yield* startServer;
  let requestReceived = false;
  server.on("connection", socket => socket.once("message", () => {
    requestReceived = true;
    socket.terminate();
  }));

  yield* rejects(
    rpc(url, "post-send-drop-token", "orchestration.dispatchCommand", {type: "message.dispatch"}).pipe(Effect.timeout("1500 millis")),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "uncertain" && !cause.definiteRejection,
  );
  assert.equal(requestReceived, true);
}));

it.live("native RPC preserves durable rejection identity through nested command failures", () => Effect.gen(function* () {
  const { server, url } = yield* startServer;
  server.on("connection", (socket) => socket.once("message", () => {
    socket.send(JSON.stringify({
      _tag: "Exit",
      requestId: "supervisor",
      exit: { _tag: "Failure", cause: { _tag: "Fail", failure: { name: "OrchestratorCommandPreviouslyRejectedError" } } },
    }));
  }));

  yield* rejects(
    rpc(url, "durable-rejection-token", "orchestration.launchThread", { commandId: "stable-command" }).pipe(Effect.timeout("1500 millis")),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected" && cause.definiteRejection && !cause.providerDisabled &&
      !cause.dispatchCommandFailure && !cause.message.includes("durable-rejection-token"),
  );
}));

it.live("native RPC marks only the received dispatch-command failure for same-ID reconciliation", () => Effect.gen(function* () {
  const { server, url } = yield* startServer;
  server.on("connection", (socket) => socket.once("message", (data) => {
    const request: unknown = JSON.parse(data.toString());
    assert.ok(typeof request === "object" && request !== null);
    const tag = (request as Record<string, unknown>).tag;
    socket.send(JSON.stringify({
      _tag: "Exit",
      requestId: "supervisor",
      exit: { _tag: "Failure", cause: { _tag: "Fail", failure: { _tag: tag === "orchestration.dispatchCommand"
        ? "OrchestrationV2DispatchCommandError" : "UnrelatedServerError" } } },
    }));
  }));

  yield* rejects(
    rpc(url, "dispatch-failure-token", "orchestration.dispatchCommand", {commandId: "same-command"}).pipe(Effect.timeout("1500 millis")),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "uncertain" && !cause.definiteRejection && cause.dispatchCommandFailure,
  );
  yield* rejects(
    rpc(url, "generic-failure-token", "server.getConfig", {}).pipe(Effect.timeout("1500 millis")),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "uncertain" && !cause.dispatchCommandFailure,
  );
}));

it.live("native RPC identifies a provider-disabled rejection before receipt lookup", () => Effect.gen(function* () {
  const { server, url } = yield* startServer;
  server.on("connection", (socket) => socket.once("message", () => {
    socket.send(JSON.stringify({
      _tag: "Exit",
      requestId: "supervisor",
      exit: { _tag: "Failure", cause: { _tag: "Fail", failure: { name: "ThreadManagementProviderInstanceDisabledError" } } },
    }));
  }));

  yield* rejects(
    rpc(url, "provider-disabled-token", "orchestration.dispatchCommand", { type: "message.dispatch" }).pipe(Effect.timeout("1500 millis")),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected" && cause.definiteRejection && cause.providerDisabled && !cause.message.includes("provider-disabled-token"),
  );
}));

it.live("shell activation baseline includes more than 128 active threads and archived run anchors", () => Effect.gen(function* () {
  const activeThreads = Array.from({ length: 129 }, (_, index) => ({
    id: "active-thread-" + index,
    latestRunId: index === 0 ? null : "active-run-" + index,
  }));
  const archivedThreads = [
    { id: "archived-thread", latestRunId: "archived-run" },
    { id: "archived-empty-thread", latestRunId: null },
  ];
  let method: string | undefined;
  let path: string | undefined;
  let authorization: string | undefined;
  let protocol: string | undefined;
  const rpcCalls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const { url } = yield* startHttpServer((request, response) => {
    method = request.method;
    path = request.url;
    authorization = request.headers.authorization;
    protocol = request.headers["x-t3-orchestration-protocol"] as string | undefined;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ schemaVersion: 2, snapshotSequence: 161, threads: activeThreads, archivedThreads: [] }));
  });

  const archiveRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    rpcCalls.push({ tag, payload });
    return { schemaVersion: 2, snapshotSequence: 161, threads: archivedThreads };
  };
  const baseline = yield* readBaseline(url, "baseline-test-token", archive(archiveRpc)).pipe(Effect.timeout("1500 millis"));
  assert.equal(method, "GET");
  assert.equal(path, "/api/orchestration/shell");
  assert.equal(authorization, "Bearer baseline-test-token");
  assert.equal(protocol, "2");
  assert.equal(baseline.snapshotSequence, 161);
  assert.equal(baseline.threads.length, 131);
  assert.deepEqual(baseline.threads.at(-2), archivedThreads[0]);
  assert.deepEqual(baseline.threads.at(-1), archivedThreads[1]);
  assert.deepEqual(baseline.threads[0], activeThreads[0]);
  assert.deepEqual(rpcCalls, [{ tag: "orchestration.getArchivedShellSnapshot", payload: {} }]);
}));

it.live("shell baseline rejects malformed or ambiguous thread anchors", () => Effect.gen(function* () {
  const { url } = yield* startHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 2,
      snapshotSequence: 161,
      threads: [{ id: "same-thread", latestRunId: null }],
      archivedThreads: [{ id: "same-thread", latestRunId: "archived-run" }],
    }));
  });

  let archiveCalls = 0;
  yield* rejects(
    readBaseline(url, "malformed-baseline-token", archive(async () => { archiveCalls += 1; return {}; })).pipe(Effect.timeout("1500 millis")),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected" && !cause.message.includes("malformed-baseline-token"),
  );
  assert.equal(archiveCalls, 1, "the active and archived snapshot requests start concurrently");
}));

it.live("active and archived shell snapshots must share a revision within three bounded reads", () => Effect.gen(function* () {
  let httpCalls = 0;
  const { url } = yield* startHttpServer((_request, response) => {
    httpCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ schemaVersion: 2, snapshotSequence: 161, threads: [], archivedThreads: [] }));
  });
  let archiveCalls = 0;
  const archiveRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    archiveCalls += 1;
    assert.equal(tag, "orchestration.getArchivedShellSnapshot");
    assert.deepEqual(payload, {});
    return { schemaVersion: 2, snapshotSequence: 160, threads: [{ id: "archived-thread", latestRunId: "archived-run" }] };
  };

  yield* rejects(
    readBaseline(url, "revision-test-token", archive(archiveRpc)).pipe(Effect.timeout("2500 millis")),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected",
  );
  assert.equal(httpCalls, 3);
  assert.equal(archiveCalls, 3);
}));

it.live("active and archived baseline reads start concurrently for each revision pair", () => Effect.gen(function* () {
  let noteHttpStarted!: () => void;
  let noteRpcStarted!: () => void;
  const httpStarted = new Promise<void>((resolve) => { noteHttpStarted = resolve; });
  const rpcStarted = new Promise<void>((resolve) => { noteRpcStarted = resolve; });
  const { url } = yield* startHttpServer((_request, response) => {
    noteHttpStarted();
    void rpcStarted.then(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 2, snapshotSequence: 161, threads: [], archivedThreads: [] }));
    });
  });
  const archiveRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    noteRpcStarted();
    await httpStarted;
    assert.equal(tag, "orchestration.getArchivedShellSnapshot");
    assert.deepEqual(payload, {});
    return { schemaVersion: 2, snapshotSequence: 161, threads: [] };
  };

  const baseline = yield* readBaseline(url, "concurrent-baseline-token", archive(archiveRpc)).pipe(Effect.timeout("1500 millis"));
  assert.equal(baseline.snapshotSequence, 161);
  assert.deepEqual(baseline.threads, []);
}));

it.live("overlapping active and archived thread identities fail closed after three pairs", () => Effect.gen(function* () {
  let httpCalls = 0;
  const { url } = yield* startHttpServer((_request, response) => {
    httpCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 2,
      snapshotSequence: 161,
      threads: [{ id: "overlapping-thread", latestRunId: "active-run" }],
      archivedThreads: [],
    }));
  });
  let archiveCalls = 0;
  const archiveRpc = async (): Promise<unknown> => {
    archiveCalls += 1;
    return { schemaVersion: 2, snapshotSequence: 161, threads: [{ id: "overlapping-thread", latestRunId: "archived-run" }] };
  };

  yield* rejects(
    readBaseline(url, "overlap-baseline-token", archive(archiveRpc)).pipe(Effect.timeout("2500 millis")),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected" && !cause.message.includes("overlap-baseline-token"),
  );
  assert.equal(httpCalls, 3);
  assert.equal(archiveCalls, 3);
}));

it("native configuration rejects malformed or excessive input and enforces advertised model choices", () => {
  const models = supervisorModels(validConfig);
  const valid = { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "high" }] };
  assert.equal(validModelSelection(valid, models), true);
  assert.equal(validModelSelection({ ...valid, options: [{ id: "reasoningEffort", value: "unsupported" }] }, models), false);
  assert.equal(modelSelection({ instanceId: "codex", model: "gpt-6-luna", options: { bad: true } }), null);
  assert.throws(() => supervisorModels({ providers: new Array(201).fill({}) }), (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected");
  assert.throws(() => supervisorModels({ providers: "not-an-array" }), (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected");
});
