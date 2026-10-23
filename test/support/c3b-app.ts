import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Context, Effect, Fiber, Layer } from "effect";
import type { TestContext } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { SupervisorConfig as Configuration } from "../../src/config.js";
import { policyDbLayer } from "../../src/db.js";
import { runGuidanceApplication } from "../../src/guidance-application.js";
import { SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import { NativeTransportLive } from "../../src/supervisor.js";
import type { StoreShape } from "../../src/store.js";
import { makeT3Client, T3Client, type T3ClientShape } from "../../src/t3.js";
import type { ProjectInfo, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import { deferred, defer, freePort, within } from "./c3b-http.js";

// a loopback T3 peer and the unchanged runGuidanceApplication (src/guidance-application.ts) over it

export const environmentId = "c3b-environment";
export const readToken = "c3b-read-token";
export const probeToken = "c3b-probe-token";

export type RpcRequest = { tag: string; payload: Record<string, unknown>; authorization: string | undefined };
export type RpcReply = { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: unknown };

export type FakeT3 = {
  url: string;
  descriptorRequests: number;
  descriptorAvailable: boolean;
  rpcs: RpcRequest[];
  // answers each websocket Request frame; the default rejects it
  onRpc: (request: RpcRequest) => RpcReply | Promise<RpcReply>;
};

export const startFakeT3 = async (t: TestContext): Promise<FakeT3> => {
  const peer: FakeT3 = {
    url: "", descriptorRequests: 0, descriptorAvailable: true, rpcs: [],
    onRpc: () => ({ _tag: "Failure", cause: { message: "not served by the c3b peer" } }),
  };
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
      const frame = JSON.parse(data.toString()) as { _tag?: string; id?: string; tag?: string; payload?: Record<string, unknown> };
      if (frame._tag !== "Request") return;
      const request: RpcRequest = { tag: String(frame.tag), payload: frame.payload ?? {}, authorization: upgrade.headers.authorization };
      peer.rpcs.push(request);
      void Promise.resolve(peer.onRpc(request)).then((exit) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit }));
      });
    });
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", () => resolve()); });
  const address = http.address();
  assert.ok(address && typeof address === "object");
  peer.url = `http://127.0.0.1:${address.port}`;
  defer(t, async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  });
  return peer;
};

// the real T3 client of src/t3.ts over the peer, built as src/main.ts does
export const buildT3Client = (baseUrl: string): Promise<T3ClientShape> =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const context = yield* Layer.build(makeT3Client({ baseUrl, token: readToken }));
    return Context.get(context, T3Client);
  })));

export type AppCatalog = { projects: Array<{ project: ProjectInfo; available: boolean }>; threads: ThreadInfo[] };

export type RunningApp = {
  config: SupervisorConfig;
  port: number;
  origin: string;
  fiber: Fiber.Fiber<unknown, unknown>;
  ready: Promise<void>;
  // resolves with the count each time the root fiber (the monitor cycle) starts a sleep; requires a clock wrapper
  rootSleeps: () => number;
  nextRootSleep: (count: number) => Promise<void>;
  interrupt(): Promise<void>;
};

export const appConfig = async (directory: string, peerUrl: string, overrides: Partial<SupervisorConfig> = {}): Promise<SupervisorConfig> => {
  const tokenFile = join(directory, "read-token");
  await writeFile(tokenFile, readToken + "\n", { mode: 0o600 });
  return {
    dataDirectory: directory, t3Url: peerUrl, t3TokenFile: tokenFile, excludedThreadIds: [], healthPort: 0,
    uiPort: await freePort(), uiHost: "127.0.0.1", uiAssetsDirectory: join(directory, "assets"), ...overrides,
  };
};

// runs the application fiber; a clock, when given, replaces Clock for the application (for example a TestClock)
export const runApp = (t: TestContext, config: SupervisorConfig, t3: T3ClientShape, catalog: () => AppCatalog,
  clock?: Clock.Clock): RunningApp => {
  const ready = deferred();
  const source = { catalog: () => Effect.succeed(catalog()) } as unknown as StoreShape;
  const root = {id: -1};
  let sleeps = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const observed: Clock.Clock | undefined = clock && {
    ...clock,
    sleep: (duration) => Effect.withFiber((current) => {
      if (current.id === root.id) {
        sleeps++;
        for (const waiter of waiters.filter((item) => item.count <= sleeps)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
      return clock.sleep(duration);
    }),
  };
  // the process's services the run reads, as the root provides them (src/supervisor.ts): the configuration, the thread-policy
  // store on its own client and the ownership set
  const process = Layer.mergeAll(Layer.succeed(Configuration, config), SupervisorOwnership.layer,
    ThreadPolicyStore.layer.pipe(Layer.provide(policyDbLayer(config.dataDirectory)), Layer.provide(Layer.succeed(Configuration, config))));
  const application = Effect.scoped(runGuidanceApplication(config, source, t3, () => ready.resolve())).pipe(
    Effect.provide(Layer.mergeAll(NativeTransportLive, process).pipe(Layer.provideMerge(NodeFileSystem.layer))));
  const fiber = Effect.runFork(observed ? Effect.provideService(application, Clock.Clock, observed) : application);
  root.id = fiber.id;
  fiber.addObserver((exit) => { if (exit._tag === "Failure") ready.reject(new Error("the application stopped before it was ready")); });
  let interrupted = false;
  const interrupt = async () => {
    if (interrupted) return;
    interrupted = true;
    await within(Effect.runPromise(Fiber.interrupt(fiber)), 10_000, "application interruption");
  };
  defer(t, interrupt);
  return {
    config, port: config.uiPort!, origin: `http://127.0.0.1:${config.uiPort}`, fiber, ready: ready.promise,
    rootSleeps: () => sleeps,
    nextRootSleep: (count) => count <= sleeps ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve })),
    interrupt,
  };
};
