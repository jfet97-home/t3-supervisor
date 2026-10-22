import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import type { Duplex } from "node:stream";
import { it } from "vitest";
import { Context, Effect, Fiber, Layer } from "effect";
import { WebSocketServer } from "ws";
import { makeT3Client, T3Client, T3TransportError, type T3ClientOptions } from "../src/t3.js";
import type { JsonRecord, SourceItem } from "../src/types.js";

const token = "read-scope-test-token";

interface MockServer {
  baseUrl: string;
  http: ReturnType<typeof createServer>;
  webSockets: WebSocketServer;
  close(): Promise<void>;
}

interface HungHandshakeServer {
  baseUrl: string;
  accepted: Promise<void>;
  close(): Promise<void>;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const makeProjection = (threadId: string): JsonRecord => ({
  thread: {
    id: threadId,
    title: "Supervisor test",
    projectId: "project-1",
    lineage: { parentThreadId: null, relationshipToParent: null }
  },
  runs: [
    {
      id: "run-cancelled",
      ordinal: 1,
      status: "cancelled",
      requestedAt: "2026-10-07T10:00:00.000Z",
      startedAt: null,
      completedAt: "2026-10-07T10:00:01.000Z",
      rootNodeId: null
    },
    {
      id: "run-completed",
      ordinal: 2,
      status: "completed",
      requestedAt: "2026-10-07T10:01:00.000Z",
      startedAt: "2026-10-07T10:01:01.000Z",
      completedAt: "2026-10-07T10:02:00.000Z",
      rootNodeId: "node-root"
    }
  ],
  messages: []
});


const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
};

const startMockServer = async (
  onHttp: (request: IncomingMessage, response: ServerResponse) => void
): Promise<MockServer> => {
  const http = createServer(onHttp);
  const webSockets = new WebSocketServer({ server: http, path: "/ws" });
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

const startHungHandshakeServer = async (): Promise<HungHandshakeServer> => {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const connectionAccepted = deferred<void>();
  server.on("upgrade", (_request, socket) => {
    sockets.add(socket);
    connectionAccepted.resolve();
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock server did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    accepted: connectionAccepted.promise,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
};

const getClient = async (
  baseUrl: string,
  extra: Omit<T3ClientOptions, "baseUrl" | "token"> = {}
) => {
  const layer = makeT3Client({ baseUrl, token, ...extra });
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(layer);
    return Context.get(context, T3Client);
  })));
};

const deferred = <A = void>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const within = <A>(promise: Promise<A>, milliseconds = 2500): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for mock T3 event")), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

it("descriptor and full projection use read-only authenticated protocol 2 requests", async () => {
  const requests: Array<{ path: string; authorization: string | undefined; protocol: string | undefined }> = [];
  const threadId = "thread/with space";
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
        serverVersion: "nightly-test",
        additionalField: true
      });
      return;
    }
    sendJson(response, 200, {
      snapshotSequence: 19,
      projection: makeProjection(threadId),
      additionalField: "preserved"
    });
  });

  try {
    const client = await getClient(server.baseUrl);
    const descriptor = await Effect.runPromise(client.descriptor());
    const snapshot = await Effect.runPromise(client.projection(threadId));
    assert.equal(descriptor.environmentId, "environment-1");
    assert.equal(descriptor.orchestrationProtocolVersion, 2);
    assert.equal(descriptor.additionalField, true);
    assert.equal(snapshot.snapshotSequence, 19);
    assert.equal(snapshot.projection.thread.id, threadId);
    assert.equal(snapshot.projection.runs[0]?.rootNodeId, null);
    assert.equal(snapshot.projection.runs[1]?.rootNodeId, "node-root");
    assert.equal(snapshot.additionalField, "preserved");
    assert.deepEqual(requests, [
      {
        path: "/.well-known/t3/environment",
        authorization: `Bearer ${token}`,
        protocol: undefined
      },
      {
        path: `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
        authorization: `Bearer ${token}`,
        protocol: "2"
      }
    ]);
  } finally {
    await server.close();
  }
});


it("full projection reader continues rejecting bounded history windows", async () => {
  const threadId = "thread-1";
  let responseBody: JsonRecord = {
    snapshotSequence: 19,
    projection: makeProjection(threadId),
    hasMoreHistory: true
  };
  const server = await startMockServer((_request, response) => sendJson(response, 200, responseBody));

  try {
    const client = await getClient(server.baseUrl);
    await assert.rejects(Effect.runPromise(client.projection(threadId)), T3TransportError);
    responseBody = {
      snapshotSequence: 19,
      projection: makeProjection(threadId),
      historyCursor: "history-cursor-1"
    };
    await assert.rejects(Effect.runPromise(client.projection(threadId)), T3TransportError);
  } finally {
    await server.close();
  }
});

it("descriptor rejects an unknown orchestration protocol", async () => {
  const server = await startMockServer((_request, response) => {
    sendJson(response, 200, {
      environmentId: "environment-1",
      orchestrationProtocolVersion: 3,
      serverVersion: "future-server"
    });
  });

  try {
    const client = await getClient(server.baseUrl);
    await assert.rejects(Effect.runPromise(client.descriptor()), T3TransportError);
  } finally {
    await server.close();
  }
});

it("HTTP response budget and failures do not disclose bearer credentials or response bodies", async () => {
  const server = await startMockServer((request, response) => {
    if (request.url === "/.well-known/t3/environment") {
      sendJson(response, 401, { message: `invalid ${token}` });
      return;
    }
    sendJson(response, 200, { payload: "x".repeat(512) });
  });

  try {
    const client = await getClient(server.baseUrl, { maxResponseBytes: 64 });
    let authFailure: unknown;
    try {
      await Effect.runPromise(client.descriptor());
    } catch (error) {
      authFailure = error;
    }
    assert.ok(authFailure instanceof T3TransportError);
    assert.match(authFailure.message, /HTTP 401/);
    assert.equal(authFailure.message.includes(token), false);

    let budgetFailure: unknown;
    try {
      await Effect.runPromise(client.projection("thread-1"));
    } catch (error) {
      budgetFailure = error;
    }
    assert.ok(budgetFailure instanceof T3TransportError);
    assert.match(budgetFailure.message, /byte limit/);
    assert.equal(budgetFailure.code, "response_too_large");
    assert.equal(budgetFailure.message.includes(token), false);
  } finally {
    await server.close();
  }
});

it("HTTP streamed response limit has a typed response_too_large code", async () => {
  const server = await startMockServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"payload":"');
    response.end(`${"x".repeat(512)}"}`);
  });

  try {
    const client = await getClient(server.baseUrl, { maxResponseBytes: 64 });
    await assert.rejects(
      Effect.runPromise(client.projection("thread-1")),
      (error: unknown) => error instanceof T3TransportError && error.code === "response_too_large"
    );
  } finally {
    await server.close();
  }
});


const unreadKeys = ["visibleTurnItems", "plans", "checkpointScopes", "checkpoints", "contextHandoffs", "contextTransfers", "providerSessions"];

// a full snapshot whose unread arrays carry `padding` bytes; what the Supervisor keeps stays small
const paddedSnapshot = (threadId: string, padding: number): JsonRecord => {
  const projection = makeProjection(threadId);
  projection.messages = [{id: "message-1", threadId, runId: "run-completed", nodeId: "node-root", role: "user", text: "Old anchor",
    streaming: false, createdAt: "2026-10-07T10:01:00.000Z", updatedAt: "2026-10-07T10:01:00.000Z"}];
  projection.turnItems = [{id: "item-1", threadId, runId: "run-completed", type: "user_message", messageId: "message-1", text: "Old anchor"}];
  projection.futureArray = [{kept: true}];
  const rows = Math.max(1, Math.ceil(padding / 1024));
  projection.visibleTurnItems = Array.from({length: rows}, (_, index) => ({position: index, visibility: "local", sourceThreadId: threadId,
    sourceItemId: `row-${index}`, item: {id: `row-${index}`, text: "v".repeat(1000)}}));
  projection.checkpoints = [{id: "checkpoint-1", files: ["a", "b"]}];
  projection.plans = [];
  return {snapshotSequence: 33, projection, additionalField: "preserved"};
};

const withoutUnread = (body: JsonRecord): JsonRecord => {
  const projection = Object.fromEntries(Object.entries(body.projection as JsonRecord).filter(([key]) => !unreadKeys.includes(key)));
  return {...body, projection};
};

it("a full snapshot over the retained budget is read exactly once its unread arrays are dropped", async () => {
  const threadId = "thread-1";
  const body = paddedSnapshot(threadId, 300_000);
  const encoded = Buffer.byteLength(JSON.stringify(body));
  const server = await startMockServer((_request, response) => sendJson(response, 200, body));
  try {
    // the wire body exceeds what the buffered reader would accept, the kept part does not
    const client = await getClient(server.baseUrl, {maxResponseBytes: 64 * 1024});
    assert.ok(encoded > 4 * 64 * 1024);
    const snapshot = await Effect.runPromise(client.projection(threadId));
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), withoutUnread(JSON.parse(JSON.stringify(body)) as JsonRecord));
    assert.equal(snapshot.additionalField, "preserved");
    assert.deepEqual((snapshot.projection as JsonRecord).futureArray, [{kept: true}], "an unknown array is kept");
    assert.equal((snapshot.projection as JsonRecord).visibleTurnItems, undefined);
  } finally {
    await server.close();
  }
});

it("a snapshot over a byte budget is typed, memoized for its thread and read again after expiry", async () => {
  let now = 1_000_000;
  let reads = 0;
  let body = paddedSnapshot("thread-1", 300_000);
  const server = await startMockServer((request, response) => {
    reads++;
    if (request.url?.endsWith("/thread-2")) {sendJson(response, 200, paddedSnapshot("thread-2", 1000));return;}
    sendJson(response, 200, body);
  });
  try {
    const client = await getClient(server.baseUrl, {maxResponseBytes: 64 * 1024, maxProjectionTransferBytes: 128 * 1024, now: () => now});
    const tooLarge = (error: unknown) => error instanceof T3TransportError && error.code === "response_too_large";
    await assert.rejects(Effect.runPromise(client.projection("thread-1")), tooLarge);
    assert.equal(reads, 1);
    await assert.rejects(Effect.runPromise(client.projection("thread-1")), tooLarge);
    assert.equal(reads, 1, "a memoized oversized thread is not fetched again");
    await Effect.runPromise(client.projection("thread-2"));
    assert.equal(reads, 2, "the memo is per thread");
    body = paddedSnapshot("thread-1", 10_000);
    now += 10 * 60_000 + 1;
    assert.equal((await Effect.runPromise(client.projection("thread-1"))).projection.thread.id, "thread-1");
    assert.equal(reads, 3, "the thread is read again after the memo expires");
    // the retained budget, not only the transfer budget, fails typed
    const retained = paddedSnapshot("thread-1", 1000);
    (retained.projection as JsonRecord).messages = [{id: "huge", threadId: "thread-1", runId: null, nodeId: null, role: "user",
      text: "m".repeat(70 * 1024), streaming: false, createdAt: "x", updatedAt: "x"}];
    body = retained;
    now += 10 * 60_000 + 1;
    await assert.rejects(Effect.runPromise(client.projection("thread-1")), tooLarge);
  } finally {
    await server.close();
  }
});

it("a projection body whose content hides under __proto__ fails validation through the client", async () => {
  const projection = makeProjection("thread-1");
  const server = await startMockServer((_request, response) => {
    const body = `{"snapshotSequence":1,"projection":{"__proto__":${JSON.stringify(projection)}}}`;
    response.writeHead(200, {"content-type": "application/json", "content-length": Buffer.byteLength(body)});
    response.end(body);
  });
  try {
    const client = await getClient(server.baseUrl);
    await assert.rejects(Effect.runPromise(client.projection("thread-1")),
      (error: unknown) => error instanceof T3TransportError && /unsupported schema or shape/.test(error.message));
  } finally {
    await server.close();
  }
});

it("a snapshot read that stalls mid-body times out without being memoized", async () => {
  let reads = 0;
  const text = JSON.stringify(paddedSnapshot("thread-1", 1000));
  const server = await startMockServer((_request, response) => {
    reads++;
    response.writeHead(200, {"content-type": "application/json", "content-length": Buffer.byteLength(text)});
    if (reads === 1) response.write(text.slice(0, 200));
    else response.end(text);
  });
  try {
    const client = await getClient(server.baseUrl, {httpTimeoutMs: 100});
    await assert.rejects(Effect.runPromise(client.projection("thread-1")),
      (error: unknown) => error instanceof T3TransportError && error.code === undefined && /timed out/.test(error.message));
    assert.equal((await Effect.runPromise(client.projection("thread-1"))).projection.thread.id, "thread-1");
    assert.equal(reads, 2, "a timeout is not remembered as an oversized snapshot");
  } finally {
    await server.close();
  }
});

it("the stream deadline and a broken body map to retryable timeout and unreadable failures through the client", async () => {
  const text = JSON.stringify(paddedSnapshot("thread-1", 100_000));
  const firstPart = deferred<void>();
  const proceed = deferred<void>();
  let mode: "deadline" | "broken" | "whole" = "deadline";
  let reads = 0;
  const server = await startMockServer((_request, response) => {
    reads++;
    response.writeHead(200, {"content-type": "application/json", "content-length": Buffer.byteLength(text)});
    if (mode === "whole") {response.end(text);return;}
    response.write(text.slice(0, 40_000), () => firstPart.resolve());
    if (mode === "broken") {setTimeout(() => response.socket?.destroy(), 20);return;}
    void proceed.promise.then(() => response.end(text.slice(40_000)));
  });
  const realNow = performance.now.bind(performance);
  try {
    const client = await getClient(server.baseUrl);
    // the stream's own deadline trips first: the clock jumps past it while the body is still arriving
    const pending = Effect.runPromise(client.projection("thread-1"));
    await within(firstPart.promise);
    performance.now = () => realNow() + 60_000;
    proceed.resolve();
    await assert.rejects(pending, (error: unknown) => error instanceof T3TransportError && error.code === undefined &&
      /request timed out/.test(error.message));
    performance.now = realNow;
    mode = "broken";
    await assert.rejects(Effect.runPromise(client.projection("thread-1")), (error: unknown) => error instanceof T3TransportError &&
      error.code === undefined && /could not be read/.test(error.message));
    mode = "whole";
    assert.equal((await Effect.runPromise(client.projection("thread-1"))).projection.thread.id, "thread-1");
    assert.equal(reads, 3, "neither failure is remembered as an oversized snapshot");
  } finally {
    performance.now = realNow;
    await server.close();
  }
});

it("a timed-out snapshot read is not memoized as oversized", async () => {
  let reads = 0;
  let slow = true;
  const server = await startMockServer((_request, response) => {
    reads++;
    if (slow) setTimeout(() => {if (!response.destroyed) sendJson(response, 200, paddedSnapshot("thread-1", 1000));}, 150);
    else sendJson(response, 200, paddedSnapshot("thread-1", 1000));
  });
  try {
    const client = await getClient(server.baseUrl, {httpTimeoutMs: 25});
    await assert.rejects(Effect.runPromise(client.projection("thread-1")),
      (error: unknown) => error instanceof T3TransportError && error.code === undefined && /timed out/.test(error.message));
    slow = false;
    await Effect.runPromise(client.projection("thread-1"));
    assert.equal(reads, 2);
  } finally {
    await server.close();
  }
});

it("a gzip snapshot counts decompressed bytes toward the transfer budget, and a large content-length fails early", async () => {
  const body = JSON.stringify(paddedSnapshot("thread-1", 200_000));
  const compressed = gzipSync(body);
  let declared: number | null = null;
  const server = await startMockServer((_request, response) => {
    response.writeHead(200, {"content-type": "application/json", "content-encoding": "gzip",
      "content-length": declared ?? compressed.length});
    if (declared === null) response.end(compressed);
    else response.end();
  });
  try {
    assert.ok(compressed.length < 64 * 1024 && Buffer.byteLength(body) > 128 * 1024);
    const roomy = await getClient(server.baseUrl, {maxResponseBytes: 64 * 1024});
    assert.equal((await Effect.runPromise(roomy.projection("thread-1"))).projection.thread.id, "thread-1");
    const tight = await getClient(server.baseUrl, {maxResponseBytes: 64 * 1024, maxProjectionTransferBytes: 128 * 1024});
    await assert.rejects(Effect.runPromise(tight.projection("thread-1")),
      (error: unknown) => error instanceof T3TransportError && error.code === "response_too_large");
    // a fresh client, so the earlier failure's memo cannot answer for the header precheck
    declared = 10 * 1024 * 1024;
    let requests = 0;
    server.http.on("request", () => {requests++;});
    const fresh = await getClient(server.baseUrl, {maxResponseBytes: 64 * 1024, maxProjectionTransferBytes: 128 * 1024});
    await assert.rejects(Effect.runPromise(fresh.projection("thread-1")),
      (error: unknown) => error instanceof T3TransportError && error.code === "response_too_large");
    assert.equal(requests, 1, "the declared length was checked on a real request");
  } finally {
    await server.close();
  }
});

it("a full snapshot over 32 MiB on the wire is read with the default budgets when what is kept fits", async () => {
  const threadId = "large-thread";
  const body = paddedSnapshot(threadId, 36 * 1024 * 1024);
  const text = JSON.stringify(body);
  assert.ok(Buffer.byteLength(text) > 32 * 1024 * 1024);
  const server = await startMockServer((_request, response) => {
    response.writeHead(200, {"content-type": "application/json", "content-length": Buffer.byteLength(text)});
    response.end(text);
  });
  try {
    const client = await getClient(server.baseUrl);
    const snapshot = await Effect.runPromise(client.projection(threadId));
    assert.equal(snapshot.projection.messages[0]?.text, "Old anchor");
    assert.equal(snapshot.projection.runs.length, 2);
    assert.equal((snapshot.projection as JsonRecord).visibleTurnItems, undefined);
  } finally {
    await server.close();
  }
});

it("HTTP 404 exposes only a safe status hint", async () => {
  const server = await startMockServer((_request, response) => {
    sendJson(response, 404, { message: `missing resource for ${token}` });
  });

  try {
    const client = await getClient(server.baseUrl);
    let failure: unknown;
    try {
      await Effect.runPromise(client.projection("missing-thread"));
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof T3TransportError);
    assert.equal(failure.httpStatus, 404);
    assert.equal(failure.message.includes(token), false);
    assert.equal(failure.message.includes("missing resource"), false);
  } finally {
    await server.close();
  }
});

it("HTTP requests time out and abort their underlying fetch", async () => {
  const aborted = deferred<void>();
  const server = await startMockServer((request, response) => {
    request.on("close", () => aborted.resolve());
    setTimeout(() => {
      if (!response.destroyed) sendJson(response, 200, {
        environmentId: "environment-1",
        orchestrationProtocolVersion: 2,
        serverVersion: "nightly-test"
      });
    }, 150);
  });

  try {
    const client = await getClient(server.baseUrl, { httpTimeoutMs: 25 });
    let failure: unknown;
    try {
      await Effect.runPromise(client.descriptor());
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof T3TransportError);
    assert.match(failure.message, /timed out/);
    await within(aborted.promise);
  } finally {
    await server.close();
  }
});

it("watch handles RPC envelopes and waits for durable ingestion before acknowledging chunks", async () => {
  const subscriptions: JsonRecord[] = [];
  const acknowledgements: string[] = [];
  const requestsSeen = deferred<void>();
  const acknowledgementsSeen = deferred<void>();
  const pongSeen = deferred<void>();
  const callbackStarted = deferred<void>();
  const remoteClosed = deferred<void>();
  const items: SourceItem[] = [];
  let releaseIngest: (() => void) | undefined;

  const server = await startMockServer((_request, response) => {
    sendJson(response, 404, {});
  });
  server.webSockets.on("connection", (socket, request) => {
    assert.equal(request.url, "/ws?orchestrationProtocol=2");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    socket.once("close", () => remoteClosed.resolve());
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!isRecord(frame)) return;
      if (frame._tag === "Request") {
        subscriptions.push(frame);
        if (subscriptions.length === 2) {
          requestsSeen.resolve();
          const activeSnapshot = {
            kind: "snapshot",
            snapshot: { schemaVersion: 2, snapshotSequence: 11, projects: [], threads: [], archivedThreads: [] },
            resolvedRepositoryIdentityRoots: ["/workspace/repo"]
          };
          const activeUpdate = { kind: "thread.updated", sequence: 12, thread: { id: "thread-1" } };
          const archiveSnapshot = { kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: 4, projects: [], threads: [] } };
          socket.send(JSON.stringify([
            { _tag: "Ping" },
            { _tag: "Chunk", requestId: "1", values: [activeSnapshot, activeUpdate] },
            { _tag: "Chunk", requestId: "2", values: [archiveSnapshot] }
          ]));
        }
        return;
      }
      if (frame._tag === "Pong") pongSeen.resolve();
      if (frame._tag === "Ack" && typeof frame.requestId === "string") {
        acknowledgements.push(frame.requestId);
        if (acknowledgements.length === 2) acknowledgementsSeen.resolve();
      }
    });
  });

  try {
    const client = await getClient(server.baseUrl);
    const watch = client.watch(7, (item) => Effect.callback<void>((resume) => {
      items.push(item);
      if (item.stream === "active" && item.item.kind === "snapshot") {
        callbackStarted.resolve();
        releaseIngest = () => resume(Effect.void);
        return;
      }
      resume(Effect.void);
    }));
    const fiber = Effect.runFork(watch);
    await within(requestsSeen.promise);
    await within(pongSeen.promise);
    await within(callbackStarted.promise);
    assert.deepEqual(acknowledgements, []);
    assert.equal(items.length, 1);
    assert.deepEqual(subscriptions, [
      {
        _tag: "Request",
        id: "1",
        tag: "orchestration.subscribeShell",
        payload: { afterSequence: 7 },
        headers: []
      },
      {
        _tag: "Request",
        id: "2",
        tag: "orchestration.subscribeArchivedShell",
        payload: {},
        headers: []
      }
    ]);

    releaseIngest?.();
    await within(acknowledgementsSeen.promise);
    assert.deepEqual(acknowledgements, ["1", "2"]);
    assert.deepEqual(items.map((item) => item.stream), ["active", "active", "archive"]);
    assert.deepEqual(items[0]?.item.resolvedRepositoryIdentityRoots, ["/workspace/repo"]);

    await Effect.runPromise(Fiber.interrupt(fiber));
    await within(remoteClosed.promise);
  } finally {
    await server.close();
  }
});

it("watch bounds a websocket peer that completes the handshake but never answers native Ping", async () => {
  const pingSeen = deferred<void>();
  const remoteClosed = deferred<void>();
  const server = await startMockServer((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    socket.once("close", () => remoteClosed.resolve());
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (isRecord(frame) && frame._tag === "Ping") pingSeen.resolve();
    });
  });

  try {
    const client = await getClient(server.baseUrl, {
      webSocketHandshakeTimeoutMs: 100,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 25
    });
    let failure: unknown;
    try {
      await Effect.runPromise(client.watch(undefined, () => Effect.void));
    } catch (error) {
      failure = error;
    }
    await within(pingSeen.promise);
    assert.ok(failure instanceof T3TransportError);
    assert.match(failure.message, /heartbeat timed out/);
    await within(remoteClosed.promise);
  } finally {
    await server.close();
  }
});

it("watch keeps a quiet websocket alive when the peer answers native Ping", async () => {
  let pingCount = 0;
  const twoPingsAnswered = deferred<void>();
  const remoteClosed = deferred<void>();
  const server = await startMockServer((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    socket.once("close", () => remoteClosed.resolve());
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!isRecord(frame) || frame._tag !== "Ping") return;
      pingCount += 1;
      socket.send(JSON.stringify({ _tag: "Pong" }));
      if (pingCount === 2) twoPingsAnswered.resolve();
    });
  });

  try {
    const client = await getClient(server.baseUrl, {
      webSocketHandshakeTimeoutMs: 100,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 40
    });
    const fiber = Effect.runFork(client.watch(undefined, () => Effect.void));
    await within(twoPingsAnswered.promise);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await within(remoteClosed.promise);
  } finally {
    await server.close();
  }
});

it("watch bounds a websocket handshake that never completes", async () => {
  const server = await startHungHandshakeServer();

  try {
    const client = await getClient(server.baseUrl, { webSocketHandshakeTimeoutMs: 100 });
    let failure: unknown;
    try {
      await Effect.runPromise(client.watch(undefined, () => Effect.void));
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof T3TransportError);
    assert.match(failure.message, /handshake timed out/);
    await within(server.accepted);
  } finally {
    await server.close();
  }
});

it("watch fails closed on subscription Exit and Defect frames so the caller can reconnect", async () => {
  for (const terminal of [
    { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } },
    { _tag: "Defect", requestId: "2", defect: { message: "private server detail" } }
  ]) {
    const sent = deferred<void>();
    const server = await startMockServer((_request, response) => sendJson(response, 404, {}));
    server.webSockets.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify(terminal));
        sent.resolve();
      });
    });

    try {
      const client = await getClient(server.baseUrl);
      let failure: unknown;
      try {
        await Effect.runPromise(client.watch(undefined, () => Effect.void));
      } catch (error) {
        failure = error;
      }
      await within(sent.promise);
      assert.ok(failure instanceof T3TransportError);
      assert.equal(failure.message.includes("private server detail"), false);
    } finally {
      await server.close();
    }
  }
});

it("watch rejects shell snapshots with an unsupported schema version", async () => {
  const sent = deferred<void>();
  const acknowledgements: string[] = [];
  const server = await startMockServer((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!isRecord(frame)) return;
      if (frame._tag === "Request" && frame.id === "1") {
        socket.send(JSON.stringify({
          _tag: "Chunk",
          requestId: "1",
          values: [{
            kind: "snapshot",
            snapshot: { schemaVersion: 3, snapshotSequence: 2, projects: [], threads: [], archivedThreads: [] }
          }]
        }));
        sent.resolve();
      } else if (frame._tag === "Ack" && typeof frame.requestId === "string") {
        acknowledgements.push(frame.requestId);
      }
    });
  });

  try {
    const client = await getClient(server.baseUrl);
    let failure: unknown;
    try {
      await Effect.runPromise(client.watch(undefined, () => Effect.void));
    } catch (error) {
      failure = error;
    }
    await within(sent.promise);
    assert.ok(failure instanceof T3TransportError);
    assert.deepEqual(acknowledgements, []);
  } finally {
    await server.close();
  }
});

it("watch propagates ingestion failures without acknowledging their chunk", async () => {
  const sent = deferred<void>();
  const acknowledgements: string[] = [];
  const server = await startMockServer((_request, response) => sendJson(response, 404, {}));
  server.webSockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!isRecord(frame)) return;
      if (frame._tag === "Request" && frame.id === "1") {
        socket.send(JSON.stringify({
          _tag: "Chunk",
          requestId: "1",
          values: [{ kind: "thread.removed", sequence: 2, threadId: "thread-1" }]
        }));
        sent.resolve();
      } else if (frame._tag === "Ack" && typeof frame.requestId === "string") {
        acknowledgements.push(frame.requestId);
      }
    });
  });

  try {
    const client = await getClient(server.baseUrl);
    await assert.rejects(
      Effect.runPromise(client.watch(undefined, () => Effect.fail(new Error("durable store unavailable")))),
      /durable store unavailable/
    );
    await within(sent.promise);
    assert.deepEqual(acknowledgements, []);
  } finally {
    await server.close();
  }
});
