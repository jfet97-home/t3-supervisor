import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { Projection, ThreadInfo } from "../../src/types.js";

// a loopback T3 peer: one node:http server and one ws server on /ws, sharing a port (shape of test/t3.test.ts:64-91)

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

export type PeerRoutes = {
  // returns true when it answered the request
  http?: (entry: PeerHttpEntry, request: IncomingMessage, response: ServerResponse) => boolean;
  // returns {value} for a success exit; a thrown error becomes a failure exit; undefined means not handled
  rpc?: (entry: PeerRpcEntry) => {value: unknown} | undefined;
};

export type IntNativePeer = {
  baseUrl: string;
  log: PeerEntry[];
  // every request no route handled; a characterization asserts it stays empty
  unexpected: PeerEntry[];
  // the Authorization header of every accepted websocket connection, in order
  connections: Array<string | null>;
  close(): Promise<void>;
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

export const startIntPeer = async (routes: PeerRoutes[] = []): Promise<IntNativePeer> => {
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
      for (const route of routes) if (route.http?.(entry, request, response)) return;
      unexpected.push(entry);
      sendJson(response, 404, {error: "unexpected_request"});
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
      let exit: unknown;
      try {
        let handled: {value: unknown} | undefined;
        for (const route of routes) {
          handled = route.rpc?.(entry);
          if (handled) break;
        }
        if (!handled) {
          unexpected.push(entry);
          throw new Error("unexpected_rpc");
        }
        exit = {_tag: "Success", value: handled.value};
      } catch {
        exit = {_tag: "Failure", cause: {_tag: "Fail", error: {_tag: "PeerError", message: "peer_failure"}}};
      }
      socket.send(JSON.stringify({_tag: "Exit", requestId: frame.id, exit}));
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {http.off("error", reject);resolve();});
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("peer did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    log,
    unexpected,
    connections,
    close: async () => {
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => webSockets.close(error => error ? reject(error) : resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    },
  };
};

export const httpRequests = (peer: IntNativePeer, path: string): PeerHttpEntry[] =>
  peer.log.filter((entry): entry is PeerHttpEntry => entry.kind === "http" && entry.path === path);
export const rpcRequests = (peer: IntNativePeer, tag: string): PeerRpcEntry[] =>
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
  // synchronous seams that run before the peer replies
  beforeShell: (() => void) | null;
  beforeTurnItem: (() => void) | null;
  beforeProjection: ((threadId: string) => void) | null;
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
  http: (entry, _request, response) => {
    if (entry.method === "GET" && entry.path === "/api/orchestration/shell") {
      state.beforeShell?.();
      sendJson(response, 200, {schemaVersion: 2, snapshotSequence: state.snapshotSequence, threads: state.shellThreads, archivedThreads: []});
      return true;
    }
    if (entry.method === "GET" && entry.path.startsWith(projectionPrefix)) {
      const threadId = decodeURIComponent(entry.path.slice(projectionPrefix.length));
      state.beforeProjection?.(threadId);
      const projection = state.projections.get(threadId);
      if (!projection) sendJson(response, 404, {error: "thread_not_found"});
      else sendJson(response, 200, {snapshotSequence: state.snapshotSequence, projection});
      return true;
    }
    return false;
  },
  rpc: (entry) => {
    if (entry.tag === "orchestration.getArchivedShellSnapshot")
      return {value: {schemaVersion: 2, snapshotSequence: state.archivedSequence(), threads: []}};
    if (entry.tag === "orchestration.getTurnItem") {
      state.beforeTurnItem?.();
      return {value: {item: state.details.get(String(entry.payload.itemId)) ?? null}};
    }
    return undefined;
  },
});
