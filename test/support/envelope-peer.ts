import { createServer, request, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { Deferred, Effect, type Scope } from "effect";
import { WebSocketServer, type WebSocket } from "ws";
import { rawWebSocketT3, type RawWebSocketT3 } from "./g8-peers.js";

// loopback T3 peers for the native envelope tests, as scoped resources whose events are Deferreds

export interface PeerFrame {
  readonly text: string;
  readonly binary: boolean;
  readonly frame: Readonly<Record<string, unknown>>;
}

export interface EnvelopePeer {
  readonly baseUrl: string;
  // every client frame in arrival order
  readonly frames: ReadonlyArray<PeerFrame>;
  readonly texts: () => ReadonlyArray<string>;
  // the url and authorization header of each websocket connection
  readonly upgrades: ReadonlyArray<{ readonly url: string | undefined; readonly authorization: string | undefined }>;
  // tcp connections, websocket upgrades included
  readonly tcpConnections: () => number;
  // the first client frame matching, past or future
  readonly frame: (match: (frame: PeerFrame) => boolean) => Effect.Effect<PeerFrame>;
  // the first websocket connection ended
  readonly closed: Effect.Effect<void>;
}

const listen = (server: Server): Effect.Effect<string> => Effect.callback<string>((resume) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resume(address !== null && typeof address === "object" ? Effect.succeed(`http://127.0.0.1:${address.port}`) : Effect.die("no tcp port"));
  });
});

const closeServer = (server: Server): Effect.Effect<void> => Effect.callback<void>((resume) => {
  server.close(() => resume(Effect.void));
  server.closeAllConnections();
});

const parse = (text: string): Readonly<Record<string, unknown>> => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

// a websocket peer at /ws that records every client frame; onFrame answers through the server-side socket
export const envelopePeer = (
  onFrame: (socket: WebSocket, frame: Readonly<Record<string, unknown>>) => void = () => undefined,
  options: { readonly verifyClient?: () => boolean } = {},
): Effect.Effect<EnvelopePeer, never, Scope.Scope> => Effect.gen(function*() {
  const frames: PeerFrame[] = [];
  const upgrades: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  const waiters: Array<{ readonly match: (frame: PeerFrame) => boolean; readonly found: Deferred.Deferred<PeerFrame> }> = [];
  const closed = Deferred.makeUnsafe<void>();
  let tcp = 0;
  const http = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  http.on("connection", () => {tcp += 1;});
  const sockets = new WebSocketServer({ server: http, path: "/ws", ...(options.verifyClient ? { verifyClient: options.verifyClient } : {}) });
  sockets.on("connection", (socket, upgrade) => {
    upgrades.push({ url: upgrade.url, authorization: upgrade.headers.authorization });
    socket.on("message", (data, binary) => {
      const text = String(data);
      const received = { text, binary, frame: parse(text) };
      frames.push(received);
      for (const waiter of [...waiters]) {
        if (!waiter.match(received)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        Deferred.doneUnsafe(waiter.found, Effect.succeed(received));
      }
      onFrame(socket, received.frame);
    });
    socket.once("close", () => {Deferred.doneUnsafe(closed, Effect.void);});
  });
  const baseUrl = yield* Effect.acquireRelease(listen(http), () => Effect.gen(function*() {
    for (const client of sockets.clients) client.terminate();
    yield* Effect.callback<void>((resume) => {sockets.close(() => resume(Effect.void));});
    yield* closeServer(http);
  }));
  return {
    baseUrl,
    frames,
    texts: () => frames.map((frame) => frame.text),
    upgrades,
    tcpConnections: () => tcp,
    frame: (match) => Effect.suspend(() => {
      const existing = frames.find(match);
      if (existing !== undefined) return Effect.succeed(existing);
      const found = Deferred.makeUnsafe<PeerFrame>();
      waiters.push({ match, found });
      return Deferred.await(found);
    }),
    closed: Deferred.await(closed),
  };
});

export interface HungPeer {
  readonly baseUrl: string;
  // the upgrade request arrived and is never answered
  readonly accepted: Effect.Effect<void>;
  // the client ended or closed that connection
  readonly gone: Effect.Effect<void>;
  // bytes the client wrote after its upgrade request
  readonly received: () => string;
}

export const hungPeer: Effect.Effect<HungPeer, never, Scope.Scope> = Effect.gen(function*() {
  const accepted = Deferred.makeUnsafe<void>();
  const gone = Deferred.makeUnsafe<void>();
  const held = new Set<Duplex>();
  let received = "";
  const http = createServer();
  http.on("upgrade", (_request, socket: Duplex) => {
    held.add(socket);
    socket.on("data", (data: Buffer) => {received += data.toString("latin1");});
    socket.on("error", () => undefined);
    socket.once("end", () => {Deferred.doneUnsafe(gone, Effect.void);});
    socket.once("close", () => {
      held.delete(socket);
      Deferred.doneUnsafe(gone, Effect.void);
    });
    Deferred.doneUnsafe(accepted, Effect.void);
  });
  const baseUrl = yield* Effect.acquireRelease(listen(http), () => Effect.suspend(() => {
    for (const socket of held) socket.destroy();
    return closeServer(http);
  }));
  return { baseUrl, accepted: Deferred.await(accepted), gone: Deferred.await(gone), received: () => received };
});

// completes the handshake by hand so a test chooses every byte the client reads
export const rawPeer: Effect.Effect<RawWebSocketT3, never, Scope.Scope> = rawWebSocketT3;

// one plain http round trip to the peer on its own connection: what the client wrote before it has been read by then
export const barrier = (baseUrl: string): Effect.Effect<number> => Effect.callback<number>((resume) => {
  const outgoing = request(`${baseUrl}/barrier`, { agent: false }, (response) => {
    response.resume();
    response.once("end", () => resume(Effect.succeed(response.statusCode ?? 0)));
  });
  outgoing.once("error", (cause) => resume(Effect.die(cause)));
  outgoing.end();
});
