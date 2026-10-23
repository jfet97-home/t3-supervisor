import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Cause, Effect, type Fiber, FiberSet, Scheduler, Scope } from "effect";
import { WebSocketServer } from "ws";
import type { Projection, ThreadInfo } from "../../src/types.js";

// a loopback T3 peer: one node:http server and one ws server on /ws, sharing a port (shape of test/t3.test.ts:64-91). Each
// arrived request runs its routes as one fiber of the peer's scope, started on the arrival turn and kept on it until it
// suspends, as the baseline synchronous seams ran; the peer replies when that fiber ends, so a route's hook commits after
// the request arrived and before the reply. This is the suites' native boundary adapter: node:http and ws callbacks in,
// effects out

export type PeerHttpEntry = {
  kind: "http";
  method: string;
  path: string;
  authorization: string | null;
  protocol: string | null;
  contentType: string | null;
  body: string;
};
export type PeerRpcEntry = {
  kind: "rpc";
  tag: string;
  authorization: string | null;
  payload: Record<string, unknown>;
};
export type PeerEntry = PeerHttpEntry | PeerRpcEntry;

// a reply to an HTTP request: a JSON body with its status, or a raw write on the native response (a lost, stalled, cut or
// redirected reply)
export type HttpAnswer = {readonly status: number; readonly value: unknown} | {readonly raw: (request: IncomingMessage, response: ServerResponse) => void};
// a reply to an rpc frame: a success exit, a failure exit, or the socket terminated after the frame arrived without a reply
export type RpcAnswer = {readonly value: unknown} | {readonly fail: true} | {readonly drop: true};
// a route's reply, undefined when it does not handle the request, or an effect of either
export type RouteAnswer<A> = A | undefined | Effect.Effect<A | undefined, unknown>;

export type PeerRoutes = {
  http?: (entry: PeerHttpEntry) => RouteAnswer<HttpAnswer>;
  // a failed or throwing route answers with a failure exit
  rpc?: (entry: PeerRpcEntry) => RouteAnswer<RpcAnswer>;
};

export type IntNativePeer = {
  baseUrl: string;
  log: PeerEntry[];
  // every request no route handled; a characterization asserts it stays empty
  unexpected: PeerEntry[];
  // the Authorization header of every accepted websocket connection, in order
  connections: Array<string | null>;
};

const header = (request: IncomingMessage, name: string): string | null => {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
};

export const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, {"content-type": "application/json", "content-length": Buffer.byteLength(body)});
  response.end(body);
};

export const json = (status: number, value: unknown): HttpAnswer => ({status, value});

// the first route that answers, in order; a route is called when the request reaches it
const routed = <E, A>(handlers: ReadonlyArray<((entry: E) => RouteAnswer<A>) | undefined>, entry: E): Effect.Effect<A | undefined, unknown> =>
  Effect.gen(function* () {
    for (const handler of handlers) {
      if (!handler) continue;
      const answer = yield* Effect.suspend(() => {
        const value = handler(entry);
        return Effect.isEffect(value) ? value : Effect.succeed(value);
      });
      if (answer !== undefined) return answer;
    }
    return undefined;
  });

const failure = {_tag: "Failure", cause: {_tag: "Fail", error: {_tag: "PeerError", message: "peer_failure"}}};

export type HookRuntime = {
  // starts a hook as a fiber of the scope on the calling turn; it runs there to its end unless it suspends
  readonly run: <A, E>(hook: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  // a hook defect the native callback could not surface; the scope's close fails with the first one
  readonly fault: (cause: Cause.Cause<unknown>) => void;
};

/**
 * The runner of the hooks a native callback starts (a peer request, a fetch call), as the baseline synchronous seams ran them:
 * on the callback's own turn, without scheduler yields. Released with the scope, after the callers it is acquired before.
 */
export const hookRuntime: Effect.Effect<HookRuntime, never, Scope.Scope> = Effect.gen(function* () {
  const run = yield* Effect.provideService(FiberSet.makeRuntime<never, unknown, unknown>(), Scheduler.PreventSchedulerYield, true);
  const faults: Array<Cause.Cause<unknown>> = [];
  yield* Effect.addFinalizer(() => faults.length === 0 ? Effect.void : Effect.die(Cause.squash(faults[0]!)));
  return {run, fault: (cause) => {if (!Cause.hasInterruptsOnly(cause)) faults.push(cause);}};
});

/** The peer over its routes, closed with the scope; a failed HTTP route answers 500 and fails the scope's close. */
export const intPeer = (routes: ReadonlyArray<PeerRoutes> = []): Effect.Effect<IntNativePeer, never, Scope.Scope> => Effect.gen(function* () {
  const {run, fault} = yield* hookRuntime;
  const log: PeerEntry[] = [];
  const unexpected: PeerEntry[] = [];
  const connections: Array<string | null> = [];
  const http = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      const entry: PeerHttpEntry = {kind: "http", method: request.method ?? "", path: request.url ?? "",
        authorization: header(request, "authorization"), protocol: header(request, "x-t3-orchestration-protocol"),
        contentType: header(request, "content-type"), body: Buffer.concat(chunks).toString("utf8")};
      log.push(entry);
      run(routed(routes.map(route => route.http), entry).pipe(Effect.matchCauseEffect({
        onFailure: (cause) => Effect.sync(() => {
          fault(cause);
          sendJson(response, 500, {error: "peer_failure"});
        }),
        onSuccess: (answer) => Effect.sync(() => {
          if (answer === undefined) {
            unexpected.push(entry);
            sendJson(response, 404, {error: "unexpected_request"});
          } else if ("raw" in answer) answer.raw(request, response);
          else sendJson(response, answer.status, answer.value);
        }),
      })));
    });
  });
  const webSockets = new WebSocketServer({server: http, path: "/ws"});
  webSockets.on("connection", (socket, upgrade) => {
    const authorization = header(upgrade, "authorization");
    connections.push(authorization);
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as {_tag?: unknown; id?: unknown; tag?: unknown; payload?: unknown};
      if (frame._tag !== "Request" || typeof frame.tag !== "string") return;
      const entry: PeerRpcEntry = {kind: "rpc", tag: frame.tag, authorization,
        payload: typeof frame.payload === "object" && frame.payload !== null ? frame.payload as Record<string, unknown> : {}};
      log.push(entry);
      run(routed(routes.map(route => route.rpc), entry).pipe(
        Effect.map((answer): RpcAnswer => {
          if (answer !== undefined) return answer;
          unexpected.push(entry);
          return {fail: true};
        }),
        Effect.catchCause(() => Effect.succeed<RpcAnswer>({fail: true})),
        Effect.flatMap((answer) => Effect.sync(() => {
          if ("drop" in answer) {
            socket.terminate();
            return;
          }
          socket.send(JSON.stringify({_tag: "Exit", requestId: frame.id, exit: "value" in answer ? {_tag: "Success", value: answer.value} : failure}));
        })),
      ));
    });
  });
  yield* Effect.acquireRelease(Effect.callback<void>((resume) => {
    http.once("error", (error) => resume(Effect.die(error)));
    http.listen(0, "127.0.0.1", () => resume(Effect.void));
  }), () => Effect.callback<void>((resume) => {
    for (const socket of webSockets.clients) socket.terminate();
    webSockets.close(() => {
      http.closeAllConnections();
      http.close(() => resume(Effect.void));
    });
  }));
  const address = http.address();
  if (address === null || typeof address === "string") return yield* Effect.die(new Error("peer did not bind a TCP port"));
  return {baseUrl: `http://127.0.0.1:${address.port}`, log, unexpected, connections};
});

export const httpRequests = (peer: Pick<IntNativePeer, "log">, path: string): PeerHttpEntry[] =>
  peer.log.filter((entry): entry is PeerHttpEntry => entry.kind === "http" && entry.path === path);
export const rpcRequests = (peer: Pick<IntNativePeer, "log">, tag: string): PeerRpcEntry[] =>
  peer.log.filter((entry): entry is PeerRpcEntry => entry.kind === "rpc" && entry.tag === tag);

export type ShellThread = ThreadInfo & {latestRunId: string | null};

// the native read surface the workflow authority path uses: active shell, archived shell, thread projection and turn item
export type NativeReadState = {
  snapshotSequence: number;
  // the archived snapshot sequence served for each read; equal to the active one unless a case lags it
  archivedSequence: () => number;
  shellThreads: ShellThread[];
  projections: Map<string, Projection>;
  details: Map<string, unknown>;
  // hooks that run when the request arrived, before the peer replies
  beforeShell: Effect.Effect<void> | null;
  // synchronous, and called before the item value is produced, so a caller can edit the genuine source first
  beforeTurnItem: (() => void) | null;
  beforeProjection: ((threadId: string) => Effect.Effect<void>) | null;
};

export const nativeReadState = (): NativeReadState => ({
  snapshotSequence: 7,
  archivedSequence: () => 7,
  shellThreads: [],
  projections: new Map(),
  details: new Map(),
  beforeShell: null,
  beforeTurnItem: null,
  beforeProjection: null,
});

const projectionPrefix = "/api/orchestration/threads/";

export const nativeReadRoutes = (state: NativeReadState): PeerRoutes => ({
  http: (entry) => {
    if (entry.method === "GET" && entry.path === "/api/orchestration/shell")
      return Effect.andThen(state.beforeShell ?? Effect.void,
        Effect.sync(() => json(200, {schemaVersion: 2, snapshotSequence: state.snapshotSequence, threads: state.shellThreads, archivedThreads: []})));
    if (entry.method === "GET" && entry.path.startsWith(projectionPrefix)) {
      const threadId = decodeURIComponent(entry.path.slice(projectionPrefix.length));
      return Effect.andThen(state.beforeProjection?.(threadId) ?? Effect.void, Effect.sync(() => {
        const projection = state.projections.get(threadId);
        return projection ? json(200, {snapshotSequence: state.snapshotSequence, projection}) : json(404, {error: "thread_not_found"});
      }));
    }
    return undefined;
  },
  rpc: (entry) => {
    if (entry.tag === "orchestration.getArchivedShellSnapshot")
      return {value: {schemaVersion: 2, snapshotSequence: state.archivedSequence(), threads: []}};
    if (entry.tag === "orchestration.getTurnItem")
      return Effect.sync(() => {
        state.beforeTurnItem?.();
        return {value: {item: state.details.get(String(entry.payload.itemId)) ?? null}};
      });
    return undefined;
  },
});
