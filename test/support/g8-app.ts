import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, type Scope } from "effect";
import { WebSocketServer, type WebSocket } from "ws";
import { runGuidanceApplication } from "../../src/guidance-application.js";
import { NativeTransportLive } from "../../src/supervisor.js";
import type { StoreShape } from "../../src/store.js";
import { makeT3Client, T3Client, type T3ClientShape } from "../../src/t3.js";
import type { ProjectInfo, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import { freePort, within } from "./g8-process.js";

// a loopback T3 peer and the unchanged runGuidanceApplication (src/guidance-application.ts) over it, as scoped effects
// (test harness only): the peer is a node http and websocket server (the native boundary) closed with the caller's scope

export const environmentId = "c3b-environment";
export const readToken = "c3b-read-token";

export interface FakeT3 {
  readonly url: string;
}

// answers the environment descriptor and rejects every websocket request
export const fakeT3: Effect.Effect<FakeT3, never, Scope.Scope> = Effect.map(Effect.acquireRelease(Effect.gen(function* () {
  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/.well-known/t3/environment") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ environmentId, orchestrationProtocolVersion: 2, serverVersion: "c3b-server" }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end("{}");
  });
  const sockets = new WebSocketServer({ server: http, path: "/ws" });
  sockets.on("connection", (socket: WebSocket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { _tag?: string; id?: string };
      if (frame._tag !== "Request") return;
      const exit = { _tag: "Failure", cause: { message: "not served by the c3b peer" } };
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit }));
    });
  });
  yield* Effect.callback<void>((resume) => {
    http.once("error", (error) => resume(Effect.die(error)));
    http.listen(0, "127.0.0.1", () => resume(Effect.void));
  });
  const address = http.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, http, sockets };
}), ({ http, sockets }) => Effect.gen(function* () {
  for (const client of sockets.clients) client.terminate();
  yield* Effect.callback<void>((resume) => sockets.close(() => resume(Effect.void)));
  http.closeAllConnections();
  yield* Effect.callback<void>((resume) => {
    http.close((error) => resume(error ? Effect.die(error) : Effect.void));
  });
})), ({ url }) => ({ url }));

// the real T3 client of src/t3.ts over the peer, built as src/main.ts does
export const buildT3Client = (baseUrl: string): Effect.Effect<T3ClientShape> => Effect.scoped(Effect.gen(function* () {
  const context = yield* Layer.build(makeT3Client({ baseUrl, token: readToken }));
  return Context.get(context, T3Client);
}));

export type AppCatalog = { projects: Array<{ project: ProjectInfo; available: boolean }>; threads: ThreadInfo[] };

export const appConfig = (directory: string, peerUrl: string, overrides: Partial<SupervisorConfig> = {}) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tokenFile = join(directory, "read-token");
  yield* fs.writeFileString(tokenFile, readToken + "\n", { mode: 0o600 });
  const config: SupervisorConfig = {
    dataDirectory: directory, t3Url: peerUrl, t3TokenFile: tokenFile, excludedThreadIds: [], healthPort: 0,
    uiPort: yield* freePort, uiHost: "127.0.0.1", uiAssetsDirectory: join(directory, "assets"), ...overrides,
  };
  return config;
});

export interface RunningApp {
  readonly config: SupervisorConfig;
  readonly port: number;
  readonly origin: string;
  readonly fiber: Fiber.Fiber<unknown, unknown>;
  // completes once the application is ready; a failure of the application before that dies
  readonly ready: Effect.Effect<void>;
  // interrupts the application within 10 s; the caller's scope does it otherwise
  readonly interrupt: Effect.Effect<void>;
}

// runs the application fiber for the caller's scope
export const runApp = (config: SupervisorConfig, t3: T3ClientShape, catalog: () => AppCatalog) => Effect.gen(function* () {
  const ready = yield* Deferred.make<void>();
  const source = { catalog: () => Effect.succeed(catalog()) } as unknown as StoreShape;
  const application = Effect.scoped(runGuidanceApplication(config, source, t3, () => Deferred.doneUnsafe(ready, Exit.void)))
    .pipe(Effect.provide(Layer.merge(NativeTransportLive, NodeFileSystem.layer)));
  const fiber = yield* Effect.forkScoped(application);
  const interrupt = within(Fiber.interrupt(fiber), 10_000, "application interruption");
  // the bounded interruption runs before the scope's own
  yield* Effect.addFinalizer(() => interrupt);
  const app: RunningApp = {
    config, port: config.uiPort!, origin: `http://127.0.0.1:${config.uiPort}`, fiber,
    ready: Effect.raceFirst(Deferred.await(ready), Effect.flatMap(Fiber.await(fiber), (exit) => Exit.isFailure(exit)
      ? Effect.die(new Error("the application stopped before it was ready")) : Effect.never)),
    interrupt,
  };
  return app;
});
