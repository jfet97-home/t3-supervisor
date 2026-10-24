import { DashboardUpdates } from "../../src/dashboard-updates.js";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Queue, type Scope, Stream } from "effect";
import { WebSocketServer, type WebSocket } from "ws";
import { SupervisorConfig as Configuration } from "../../src/config.js";
import { policyDbLayer } from "../../src/db.js";
import { runGuidanceApplication } from "../../src/guidance-application.js";
import { SupervisorOwnership } from "../../src/project-supervisor-store.js";
import type { StoreShape } from "../../src/store.js";
import { NativeTransportLive } from "../../src/supervisor.js";
import { makeT3Client, T3Client, type T3ClientShape } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { ProjectInfo, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import { freePort, within } from "./g11-http.js";

// the running guidance application of src/guidance-application.ts over a loopback T3 peer, in the caller's scope, with the
// process's services the root provides (the configuration, the thread-policy store on its own client and the ownership
// set); the peer serves the environment descriptor and answers each websocket Request frame through the case's effect

export const environmentId = "c3b-environment";
export const readToken = "c3b-read-token";
export const probeToken = "c3b-probe-token";

export type RpcRequest = { tag: string; payload: Record<string, unknown>; authorization: string | undefined };
export type RpcReply = { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: unknown };

export interface FakeT3 {
  readonly url: string;
  descriptorRequests: number;
  descriptorAvailable: boolean;
  readonly rpcs: RpcRequest[];
  // answers each websocket Request frame; the default rejects it
  onRpc: (request: RpcRequest) => Effect.Effect<RpcReply>;
}

type Frame = { readonly socket: WebSocket; readonly id: unknown; readonly request: RpcRequest };

/** The loopback T3 peer, closed with the scope; its Request frames are answered, each in its own fiber, by `onRpc`. */
export const fakeT3 = Effect.gen(function* () {
  const frames = yield* Queue.unbounded<Frame>();
  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/.well-known/t3/environment") {
      peer.descriptorRequests++;
      if (!peer.descriptorAvailable) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ environmentId, orchestrationProtocolVersion: 2, serverVersion: "c3b-server" }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end("{}");
  });
  const sockets = new WebSocketServer({ server: http, path: "/ws" });
  sockets.on("connection", (socket: WebSocket, upgrade: IncomingMessage) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { _tag?: string; id?: string; tag?: string; payload?: Record<string, unknown> };
      if (frame._tag !== "Request") return;
      const request: RpcRequest = { tag: String(frame.tag), payload: frame.payload ?? {}, authorization: upgrade.headers.authorization };
      peer.rpcs.push(request);
      Queue.offerUnsafe(frames, { socket, id: frame.id, request });
    });
  });
  const url = yield* Effect.acquireRelease(Effect.callback<string, Error>((resume) => {
    http.once("error", (error) => resume(Effect.fail(error)));
    http.listen(0, "127.0.0.1", () => {
      const address = http.address();
      assert.ok(address && typeof address === "object");
      resume(Effect.succeed(`http://127.0.0.1:${address.port}`));
    });
  }).pipe(Effect.orDie), () => Effect.gen(function* () {
    for (const client of sockets.clients) client.terminate();
    yield* Effect.callback<void>((resume) => {sockets.close(() => resume(Effect.void));});
    http.closeAllConnections();
    yield* Effect.callback<void>((resume) => {http.close(() => resume(Effect.void));});
  }));
  const peer: FakeT3 = {
    url, descriptorRequests: 0, descriptorAvailable: true, rpcs: [],
    onRpc: () => Effect.succeed({ _tag: "Failure", cause: { message: "not served by the c3b peer" } }),
  };
  yield* Effect.forkScoped(Stream.fromQueue(frames).pipe(Stream.runForEach((frame) => Effect.forkScoped(Effect.map(peer.onRpc(frame.request), (exit) => {
    if (frame.socket.readyState === frame.socket.OPEN) frame.socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit }));
  })))));
  return peer;
});

/** The real T3 client of src/t3.ts over the peer, built as src/main.ts does, for the scope. */
export const t3Client = (baseUrl: string): Effect.Effect<T3ClientShape, never, Scope.Scope> =>
  Effect.map(Layer.build(makeT3Client({ baseUrl, token: readToken })), (context) => Context.get(context, T3Client));

/** The application's configuration over the peer: its read token file and a free dashboard port. */
export const appConfig = (directory: string, peerUrl: string, overrides: Partial<SupervisorConfig> = {}) => Effect.gen(function* () {
  const tokenFile = join(directory, "read-token");
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(tokenFile, readToken + "\n", { mode: 0o600 });
  const config: SupervisorConfig = {
    dataDirectory: directory, t3Url: peerUrl, t3TokenFile: tokenFile, excludedThreadIds: [], healthPort: 0,
    uiPort: yield* freePort, uiHost: "127.0.0.1", uiAssetsDirectory: join(directory, "assets"), ...overrides,
  };
  return config;
}).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer));

export type AppCatalog = { projects: Array<{ project: ProjectInfo; available: boolean }>; threads: ThreadInfo[] };

export interface RunningApp {
  readonly config: SupervisorConfig;
  readonly port: number;
  readonly origin: string;
  // the application called its readiness callback; it fails if the application stopped before that
  readonly ready: Effect.Effect<void, Error>;
  // the number of sleeps the root fiber (the monitor cycle) has started; requires a clock
  readonly rootSleeps: () => number;
  // the root fiber started its count-th sleep
  readonly nextRootSleep: (count: number) => Effect.Effect<void>;
  readonly interrupt: Effect.Effect<void>;
}

/** Runs the application in a fiber of the scope; a clock, when given, replaces Clock for the application (a TestClock). */
export const runApp = (config: SupervisorConfig, t3: T3ClientShape, catalog: () => AppCatalog, clock?: Clock.Clock) => Effect.gen(function* () {
  const ready = yield* Deferred.make<void, Error>();
  const source = { catalog: () => Effect.succeed(catalog()) } as unknown as StoreShape;
  const root = { id: -1 };
  let sleeps = 0;
  const waiters: Array<{ count: number; reached: Deferred.Deferred<void> }> = [];
  const observed: Clock.Clock | undefined = clock && {
    ...clock,
    sleep: (duration) => Effect.withFiber((current) => {
      if (current.id === root.id) {
        sleeps++;
        for (const waiter of waiters.filter((item) => item.count <= sleeps)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          Deferred.doneUnsafe(waiter.reached, Effect.void);
        }
      }
      return clock.sleep(duration);
    }),
  };
  // the process's services the run reads, as the root provides them (src/supervisor.ts): the configuration, the thread-policy
  // store on its own client and the ownership set
  const process = Layer.mergeAll(Layer.succeed(Configuration, config), SupervisorOwnership.layer,
    ThreadPolicyStore.layer.pipe(Layer.provide(policyDbLayer(config.dataDirectory)), Layer.provide(Layer.succeed(Configuration, config))));
  const application = Effect.scoped(runGuidanceApplication(config, source, t3, () => Deferred.doneUnsafe(ready, Effect.void))).pipe(Effect.provide(DashboardUpdates.layer)).pipe(
    Effect.provide(Layer.mergeAll(NativeTransportLive, process).pipe(Layer.provideMerge(NodeFileSystem.layer))),
    Effect.onExit((exit) => Exit.isFailure(exit) ? Deferred.fail(ready, new Error("the application stopped before it was ready")) : Effect.void));
  const fiber = yield* Effect.forkDetach(observed ? Effect.provideService(application, Clock.Clock, observed) : application);
  root.id = fiber.id;
  let interrupted = false;
  const interrupt = Effect.suspend(() => {
    if (interrupted) return Effect.void;
    interrupted = true;
    return within(Fiber.interrupt(fiber), "10 seconds", "application interruption");
  });
  yield* Effect.addFinalizer(() => interrupt);
  return {
    config, port: config.uiPort!, origin: `http://127.0.0.1:${config.uiPort}`, ready: Deferred.await(ready),
    rootSleeps: () => sleeps,
    nextRootSleep: (count) => Effect.suspend(() => {
      if (count <= sleeps) return Effect.void;
      const reached = Deferred.makeUnsafe<void>();
      waiters.push({ count, reached });
      return Deferred.await(reached);
    }),
    interrupt,
  } satisfies RunningApp;
});
