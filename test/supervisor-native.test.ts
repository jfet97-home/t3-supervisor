import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  makeSupervisorRpc,
  modelSelection,
  readSupervisorBaseline,
  SupervisorRpcError,
  supervisorModels,
  validModelSelection,
} from "../src/supervisor-native.js";

const startServer = async (): Promise<{ server: WebSocketServer; url: string }> => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: "http://127.0.0.1:" + address.port };
};

const closeServer = async (server: WebSocketServer): Promise<void> => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
};

const startHttpServer = async (handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; url: string }> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: "http://127.0.0.1:" + address.port };
};

const closeHttpServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
};

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

test("native RPC authenticates and uses the orchestration request and response frames", async (t) => {
  const { server, url } = await startServer();
  t.after(() => closeServer(server));
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

  const result = await makeSupervisorRpc(url, "test-native-token")("server.getConfig", {}, AbortSignal.timeout(2000));
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
});

test("malformed native RPC responses fail closed with a credential-free error", async (t) => {
  const { server, url } = await startServer();
  t.after(() => closeServer(server));
  server.on("connection", (socket) => socket.once("message", () => {
    socket.send(JSON.stringify({ _tag: "Exit", requestId: "supervisor", exit: "success" }));
  }));

  await assert.rejects(
    makeSupervisorRpc(url, "private-test-token")("server.getConfig", {}, AbortSignal.timeout(1500)),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "uncertain" && !cause.message.includes("private-test-token"),
  );
});

test("native RPC preserves durable rejection identity through nested command failures", async (t) => {
  const { server, url } = await startServer();
  t.after(() => closeServer(server));
  server.on("connection", (socket) => socket.once("message", () => {
    socket.send(JSON.stringify({
      _tag: "Exit",
      requestId: "supervisor",
      exit: { _tag: "Failure", cause: { _tag: "Fail", failure: { name: "OrchestratorCommandPreviouslyRejectedError" } } },
    }));
  }));

  await assert.rejects(
    makeSupervisorRpc(url, "durable-rejection-token")("orchestration.launchThread", { commandId: "stable-command" }, AbortSignal.timeout(1500)),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected" && cause.definiteRejection && !cause.providerDisabled && !cause.message.includes("durable-rejection-token"),
  );
});

test("native RPC identifies a provider-disabled rejection before receipt lookup", async (t) => {
  const { server, url } = await startServer();
  t.after(() => closeServer(server));
  server.on("connection", (socket) => socket.once("message", () => {
    socket.send(JSON.stringify({
      _tag: "Exit",
      requestId: "supervisor",
      exit: { _tag: "Failure", cause: { _tag: "Fail", failure: { name: "ThreadManagementProviderInstanceDisabledError" } } },
    }));
  }));

  await assert.rejects(
    makeSupervisorRpc(url, "provider-disabled-token")("orchestration.dispatchCommand", { type: "message.dispatch" }, AbortSignal.timeout(1500)),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected" && cause.definiteRejection && cause.providerDisabled && !cause.message.includes("provider-disabled-token"),
  );
});

test("shell activation baseline includes more than 128 active threads and archived run anchors", async (t) => {
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
  const { server, url } = await startHttpServer((request, response) => {
    method = request.method;
    path = request.url;
    authorization = request.headers.authorization;
    protocol = request.headers["x-t3-orchestration-protocol"] as string | undefined;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ schemaVersion: 2, snapshotSequence: 161, threads: activeThreads, archivedThreads: [] }));
  });
  t.after(() => closeHttpServer(server));

  const archiveRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    rpcCalls.push({ tag, payload });
    return { schemaVersion: 2, snapshotSequence: 161, threads: archivedThreads };
  };
  const baseline = await readSupervisorBaseline(url, "baseline-test-token", archiveRpc)(AbortSignal.timeout(1500));
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
});

test("shell baseline rejects malformed or ambiguous thread anchors", async (t) => {
  const { server, url } = await startHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 2,
      snapshotSequence: 161,
      threads: [{ id: "same-thread", latestRunId: null }],
      archivedThreads: [{ id: "same-thread", latestRunId: "archived-run" }],
    }));
  });
  t.after(() => closeHttpServer(server));

  let archiveCalls = 0;
  await assert.rejects(
    readSupervisorBaseline(url, "malformed-baseline-token", async () => { archiveCalls += 1; return {}; })(AbortSignal.timeout(1500)),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected" && !cause.message.includes("malformed-baseline-token"),
  );
  assert.equal(archiveCalls, 1, "the active and archived snapshot requests start concurrently");
});

test("active and archived shell snapshots must share a revision within three bounded reads", async (t) => {
  let httpCalls = 0;
  const { server, url } = await startHttpServer((_request, response) => {
    httpCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ schemaVersion: 2, snapshotSequence: 161, threads: [], archivedThreads: [] }));
  });
  t.after(() => closeHttpServer(server));
  let archiveCalls = 0;
  const archiveRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    archiveCalls += 1;
    assert.equal(tag, "orchestration.getArchivedShellSnapshot");
    assert.deepEqual(payload, {});
    return { schemaVersion: 2, snapshotSequence: 160, threads: [{ id: "archived-thread", latestRunId: "archived-run" }] };
  };

  await assert.rejects(
    readSupervisorBaseline(url, "revision-test-token", archiveRpc)(AbortSignal.timeout(2500)),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected",
  );
  assert.equal(httpCalls, 3);
  assert.equal(archiveCalls, 3);
});

test("active and archived baseline reads start concurrently for each revision pair", async (t) => {
  let noteHttpStarted!: () => void;
  let noteRpcStarted!: () => void;
  const httpStarted = new Promise<void>((resolve) => { noteHttpStarted = resolve; });
  const rpcStarted = new Promise<void>((resolve) => { noteRpcStarted = resolve; });
  const { server, url } = await startHttpServer((_request, response) => {
    noteHttpStarted();
    void rpcStarted.then(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 2, snapshotSequence: 161, threads: [], archivedThreads: [] }));
    });
  });
  t.after(() => closeHttpServer(server));
  const archiveRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    noteRpcStarted();
    await httpStarted;
    assert.equal(tag, "orchestration.getArchivedShellSnapshot");
    assert.deepEqual(payload, {});
    return { schemaVersion: 2, snapshotSequence: 161, threads: [] };
  };

  const baseline = await readSupervisorBaseline(url, "concurrent-baseline-token", archiveRpc)(AbortSignal.timeout(1500));
  assert.equal(baseline.snapshotSequence, 161);
  assert.deepEqual(baseline.threads, []);
});

test("overlapping active and archived thread identities fail closed after three pairs", async (t) => {
  let httpCalls = 0;
  const { server, url } = await startHttpServer((_request, response) => {
    httpCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 2,
      snapshotSequence: 161,
      threads: [{ id: "overlapping-thread", latestRunId: "active-run" }],
      archivedThreads: [],
    }));
  });
  t.after(() => closeHttpServer(server));
  let archiveCalls = 0;
  const archiveRpc = async (): Promise<unknown> => {
    archiveCalls += 1;
    return { schemaVersion: 2, snapshotSequence: 161, threads: [{ id: "overlapping-thread", latestRunId: "archived-run" }] };
  };

  await assert.rejects(
    readSupervisorBaseline(url, "overlap-baseline-token", archiveRpc)(AbortSignal.timeout(2500)),
    (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected" && !cause.message.includes("overlap-baseline-token"),
  );
  assert.equal(httpCalls, 3);
  assert.equal(archiveCalls, 3);
});

test("native configuration rejects malformed or excessive input and enforces advertised model choices", () => {
  const models = supervisorModels(validConfig);
  const valid = { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "high" }] };
  assert.equal(validModelSelection(valid, models), true);
  assert.equal(validModelSelection({ ...valid, options: [{ id: "reasoningEffort", value: "unsupported" }] }, models), false);
  assert.equal(modelSelection({ instanceId: "codex", model: "gpt-6-luna", options: { bad: true } }), null);
  assert.throws(() => supervisorModels({ providers: new Array(201).fill({}) }), (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected");
  assert.throws(() => supervisorModels({ providers: "not-an-array" }), (cause: unknown) => cause instanceof SupervisorRpcError && cause.outcome === "rejected");
});

