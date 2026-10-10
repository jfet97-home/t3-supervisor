import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { makeInputT3Client, type InputT3ClientOptions } from "../src/input-t3.js";
import type { JsonRecord } from "../src/types.js";

const readToken = "input-read-token";
const responseToken = "input-response-token";
const threadId = "thread/input test";

interface MockServer {
  baseUrl: string;
  http: ReturnType<typeof createServer>;
  webSockets: WebSocketServer;
  close(): Promise<void>;
}

type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void;
type WebSocketHandler = (request: IncomingMessage, socket: import("ws").WebSocket) => void;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
};

const makeShellSnapshot = (): JsonRecord => ({
  schemaVersion: 2,
  snapshotSequence: 7,
  projects: [],
  threads: [
    {
      id: threadId,
      projectId: "project-1",
      title: "Input test",
      providerInstanceId: "codex",
      lineage: { parentThreadId: null, relationshipToParent: null }
    }
  ]
});

const makeThreadSnapshot = (): JsonRecord => {
  const request = (id: string, nodeId: string, status: string, responseCapability: JsonRecord): JsonRecord => ({
    id,
    nodeId,
    providerTurnId: `provider-turn-${id}`,
    nativeRequestRef: null,
    kind: "user_input",
    status,
    responseCapability,
    createdAt: "2026-10-08T10:00:00.000Z",
    resolvedAt: status === "pending" ? null : "2026-10-08T10:01:00.000Z"
  });
  const question = (id: string, extra: JsonRecord = {}): JsonRecord => ({
    id,
    header: `Header ${id}`,
    question: `Question ${id}?`,
    options: [
      { label: "First", description: "First option", value: "first" },
      { label: "Second", description: "Second option" }
    ],
    ...extra
  });
  const turnItem = (requestId: string, nodeId: string, questions: JsonRecord[], responseMode?: string): JsonRecord => ({
    id: `item-${requestId}`,
    threadId,
    runId: "run-1",
    nodeId,
    type: "user_input_request",
    requestId,
    questions,
    ...(responseMode === undefined ? {} : { responseMode })
  });
  return {
    schemaVersion: 2,
    snapshotSequence: 23,
    projection: {
      thread: {
        id: threadId,
        title: "Input test",
        projectId: "project-1",
        lineage: { parentThreadId: null, relationshipToParent: null }
      },
      runs: [{ id: "run-1", providerInstanceId: "codex" }],
      nodes: [
        { id: "node-pending", runId: "run-1", kind: "user_input_request", providerThreadId: "provider-thread-1" },
        { id: "node-live", runId: "run-1", kind: "user_input_request", providerThreadId: "provider-thread-1" },
        { id: "node-blocked", runId: "run-1", kind: "user_input_request", providerThreadId: null },
        { id: "node-resolved", runId: "run-1", kind: "user_input_request", providerThreadId: "provider-thread-1" }
      ],
      runtimeRequests: [
        request("request-pending", "node-pending", "pending", { type: "message" }),
        request("request-live", "node-live", "pending", { type: "live", providerSessionId: "provider-session-1" }),
        request("request-blocked", "node-blocked", "pending", { type: "not_resumable", reason: "Provider session ended" }),
        request("request-resolved", "node-resolved", "resolved", { type: "message" }),
        { ...request("approval-request", "node-pending", "pending", { type: "message" }), kind: "permission" }
      ],
      turnItems: [
        turnItem("request-pending", "node-pending", [question("single"), question("multi", {
          multiSelect: true,
          allowCustomAnswer: false,
          required: false
        })]),
        turnItem("request-live", "node-live", [question("live-answer")], "message"),
        turnItem("request-blocked", "node-blocked", [question("blocked-answer")]),
        turnItem("request-resolved", "node-resolved", [question("resolved-answer")])
      ]
    }
  };
};

const startMockServer = async (
  onHttp: HttpHandler,
  onWebSocket?: WebSocketHandler,
  rejectWebSocket = false
): Promise<MockServer> => {
  const http = createServer(onHttp);
  const webSockets = new WebSocketServer({
    server: http,
    path: "/ws",
    ...(rejectWebSocket
      ? { verifyClient: (_info, done) => done(false, 401, "Unauthorized") }
      : {})
  });
  webSockets.on("connection", (socket, request) => onWebSocket?.(request, socket));
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("mock server did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    http,
    webSockets,
    close: async () => {
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        webSockets.close((error) => error ? reject(error) : resolve());
      });
      await new Promise<void>((resolve, reject) => {
        http.close((error) => error ? reject(error) : resolve());
      });
    }
  };
};

const clientOptions = (baseUrl: string, extra: Partial<InputT3ClientOptions> = {}): InputT3ClientOptions => ({
  baseUrl,
  readToken,
  responseToken,
  ...extra
});

const respondWith = (socket: import("ws").WebSocket, requestId: string, exit: JsonRecord): void => {
  socket.send(JSON.stringify({ _tag: "Exit", requestId, exit }));
};

test("descriptor and active shell use authenticated protocol 2 HTTP snapshots", async () => {
  const requests: Array<{ path: string; authorization: string | undefined; protocol: string | undefined }> = [];
  const server = await startMockServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      protocol: request.headers["x-t3-orchestration-protocol"] as string | undefined
    });
    if (request.url === "/.well-known/t3/environment") {
      sendJson(response, 200, {
        environmentId: "environment-1",
        orchestrationProtocolVersion: 2,
        serverVersion: "nightly-test"
      });
      return;
    }
    if (request.url === "/api/orchestration/shell") {
      sendJson(response, 200, makeShellSnapshot());
      return;
    }
    sendJson(response, 404, { message: "unmatched request" });
  });

  try {
    const client = makeInputT3Client(clientOptions(server.baseUrl));
    const descriptor = await client.descriptor();
    const threads = await client.listThreads();
    assert.equal(descriptor.environmentId, "environment-1");
    assert.equal(descriptor.orchestrationProtocolVersion, 2);
    assert.deepEqual(threads.map((thread) => thread.id), [threadId]);
    assert.deepEqual(requests, [
      { path: "/.well-known/t3/environment", authorization: `Bearer ${readToken}`, protocol: undefined },
      { path: "/api/orchestration/shell", authorization: `Bearer ${readToken}`, protocol: "2" }
    ]);
  } finally {
    await server.close();
  }
});

test("thread request mapping preserves native identity, defaults, capability, and terminal status", async () => {
  const requests: Array<{ path: string; authorization: string | undefined; protocol: string | undefined }> = [];
  const server = await startMockServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      protocol: request.headers["x-t3-orchestration-protocol"] as string | undefined
    });
    if (request.url === "/.well-known/t3/environment") {
      sendJson(response, 200, {
        environmentId: "environment-1",
        orchestrationProtocolVersion: 2,
        serverVersion: "nightly-test"
      });
      return;
    }
    if (request.url === `/api/orchestration/threads/${encodeURIComponent(threadId)}`) {
      sendJson(response, 200, makeThreadSnapshot());
      return;
    }
    sendJson(response, 404, { message: "unmatched request" });
  });

  try {
    const client = makeInputT3Client(clientOptions(server.baseUrl));
    const requestsList = await client.listRequests(threadId);
    const pending = requestsList.find((request) => request.requestId === "request-pending");
    const blocked = requestsList.find((request) => request.requestId === "request-blocked");
    const resolved = requestsList.find((request) => request.requestId === "request-resolved");
    assert.equal(requestsList.some((request) => request.requestId === "approval-request"), false);
    assert.equal(pending?.environmentId, "environment-1");
    assert.equal(pending?.owner.runId, "run-1");
    assert.equal(pending?.owner.nodeId, "node-pending");
    assert.equal(pending?.providerTurnId, "provider-turn-request-pending");
    assert.equal(pending?.status, "pending");
    assert.equal(pending?.terminal, false);
    assert.equal(pending?.canRespond, true);
    assert.deepEqual(pending?.responseCapability, { type: "message" });
    assert.equal(pending?.responseMode, "message");
    assert.equal(pending?.questions[0]?.multiSelect, false);
    assert.equal(pending?.questions[0]?.allowCustomAnswer, true);
    assert.equal(pending?.questions[0]?.required, true);
    assert.equal(pending?.questions[1]?.multiSelect, true);
    assert.equal(pending?.questions[1]?.allowCustomAnswer, false);
    assert.equal(pending?.questions[1]?.required, false);
    assert.equal(pending?.questions[1]?.native.required, false);
    assert.equal(pending?.revisionHash.length, 64);
    assert.deepEqual(blocked?.responseCapability, { type: "not_resumable", reason: "Provider session ended" });
    assert.equal(blocked?.canRespond, false);
    assert.equal(resolved?.terminal, true);
    assert.equal(resolved?.status, "resolved");
    assert.equal(resolved?.canRespond, false);

    const reread = await client.readRequest(threadId, "request-pending");
    assert.equal(reread?.revisionHash, pending?.revisionHash);
    assert.equal(await client.readRequest(threadId, "missing-request"), undefined);
    assert.equal(requests.every((request) => request.authorization === `Bearer ${readToken}`), true);
    assert.equal(requests.every((request) => request.protocol === "2" || request.path === "/.well-known/t3/environment"), true);
  } finally {
    await server.close();
  }
});

test("response uses one native runtime-request.respond command and reports dispatch acceptance only", async () => {
  let frame: JsonRecord | undefined;
  let authorization: string | undefined;
  let websocketUrl: string | undefined;
  const server = await startMockServer((request, response) => {
    sendJson(response, 404, { message: "unmatched request" });
  }, (request, socket) => {
    authorization = request.headers.authorization;
    websocketUrl = request.url;
    socket.on("message", (data) => {
      const decoded: unknown = JSON.parse(data.toString("utf8"));
      assert.ok(isRecord(decoded));
      frame = decoded;
      respondWith(socket, String(decoded.id), { _tag: "Success", value: { sequence: 31 } });
    });
  });

  try {
    const client = makeInputT3Client(clientOptions(server.baseUrl));
    const answers = { color: "blue", channels: ["email", "sms"] };
    const result = await client.respond(threadId, "request-1", answers);
    assert.deepEqual(result, { outcome: "accepted", commandId: (frame?.payload as JsonRecord).commandId, sequence: 31 });
    assert.match(String((frame?.payload as JsonRecord).commandId), /^[0-9a-f-]{36}$/i);
    assert.equal(frame?._tag, "Request");
    assert.equal(frame?.id, "1");
    assert.equal(frame?.tag, "orchestration.dispatchCommand");
    assert.deepEqual(frame?.headers, []);
    assert.deepEqual(frame?.payload, {
      type: "runtime-request.respond",
      commandId: (frame?.payload as JsonRecord).commandId,
      threadId,
      requestId: "request-1",
      answers
    });
    assert.equal(authorization, `Bearer ${responseToken}`);
    assert.equal(websocketUrl, "/ws?orchestrationProtocol=2");
  } finally {
    await server.close();
  }
});

test("native dispatch failure is rejected and a lost response is unknown without replay", async () => {
  let failureFrame: JsonRecord | undefined;
  const rejectedServer = await startMockServer((_request, response) => {
    sendJson(response, 404, { message: "unmatched request" });
  }, (_request, socket) => {
    socket.on("message", (data) => {
      const decoded: unknown = JSON.parse(data.toString("utf8"));
      assert.ok(isRecord(decoded));
      failureFrame = decoded;
      respondWith(socket, String(decoded.id), {
        _tag: "Failure",
        cause: { _tag: "Fail", failure: { _tag: "OrchestrationV2DispatchCommandError" } }
      });
    });
  });

  try {
    const rejected = await makeInputT3Client(clientOptions(rejectedServer.baseUrl))
      .respond(threadId, "request-rejected", { q1: "answer" });
    assert.equal(rejected.outcome, "rejected");
    assert.equal(rejected.commandId, ((failureFrame?.payload as JsonRecord).commandId));
  } finally {
    await rejectedServer.close();
  }

  let submitted = 0;
  const unknownServer = await startMockServer((_request, response) => {
    sendJson(response, 404, { message: "unmatched request" });
  }, (_request, socket) => {
    socket.on("message", () => {
      submitted += 1;
    });
  });

  try {
    const unknown = await makeInputT3Client(clientOptions(unknownServer.baseUrl, { responseTimeoutMs: 30 }))
      .respond(threadId, "request-timeout", { q1: "answer" });
    assert.equal(unknown.outcome, "unknown");
    assert.match(unknown.reason, /did not confirm/);
    assert.equal(submitted, 1);
  } finally {
    await unknownServer.close();
  }
});

test("a websocket authorization rejection happens before send and is a known rejection", async () => {
  let submitted = false;
  const server = await startMockServer((_request, response) => {
    sendJson(response, 404, { message: "unmatched request" });
  }, (_request, socket) => {
    socket.on("message", () => {
      submitted = true;
    });
  }, true);

  try {
    const result = await makeInputT3Client(clientOptions(server.baseUrl))
      .respond(threadId, "request-auth", { q1: "answer" });
    assert.equal(result.outcome, "rejected");
    assert.equal(result.httpStatus, 401);
    assert.equal(submitted, false);
  } finally {
    await server.close();
  }
});

test("malformed snapshots fail closed and HTTP errors do not expose response bodies", async () => {
  const server = await startMockServer((_request, response) => {
    sendJson(response, 401, { message: `invalid token ${readToken}` });
  });

  try {
    const client = makeInputT3Client(clientOptions(server.baseUrl));
    await assert.rejects(client.descriptor(), (error: unknown) => {
      assert.match(String(error), /HTTP 401/);
      assert.equal(String(error).includes(readToken), false);
      return true;
    });
  } finally {
    await server.close();
  }
});
