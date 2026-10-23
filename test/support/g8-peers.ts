import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Deferred, Effect, Exit, type Scope } from "effect";
import { WebSocketServer } from "ws";
import type { ClientFrame } from "./c3a-fake-t3.js";

// loopback peers standing in for T3 in the t3 client characterizations, as scoped effects: each peer is a node http
// server (a native boundary) whose events complete deferreds, and the caller's scope closes it

type Http = ReturnType<typeof createServer>;

const listen = (server: Http): Effect.Effect<string> => Effect.callback<string>((resume) => {
  const failed = (error: Error) => resume(Effect.die(error));
  server.once("error", failed);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", failed);
    const address = server.address();
    resume(address === null || typeof address === "string"
      ? Effect.die(new Error("loopback peer did not bind a TCP port"))
      : Effect.succeed(`http://127.0.0.1:${address.port}`));
  });
});

const closeServer = (server: Http): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    server.close((error) => resume(error ? Effect.die(error) : Effect.void));
  });

export interface MockT3 {
  readonly baseUrl: string;
  readonly webSockets: WebSocketServer;
}

// an http server with the T3 websocket endpoint at /ws, as in the baseline t3 suite
export const mockT3 = (onHttp: (request: IncomingMessage, response: ServerResponse) => void): Effect.Effect<MockT3, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.gen(function* () {
    const http = createServer(onHttp);
    const webSockets = new WebSocketServer({ server: http, path: "/ws" });
    return { http, webSockets, baseUrl: yield* listen(http) };
  }), ({ http, webSockets }) => Effect.gen(function* () {
    for (const socket of webSockets.clients) socket.terminate();
    yield* Effect.callback<void>((resume) => webSockets.close((error) => resume(error ? Effect.die(error) : Effect.void)));
    // a connection the client opened without sending a request would otherwise hold the close until it times out
    const closed = Deferred.makeUnsafe<void>();
    http.close((error) => Deferred.doneUnsafe(closed, error ? Exit.die(error) : Exit.void));
    http.closeAllConnections();
    yield* Deferred.await(closed);
  }));

// http server sockets allow half-open connections, so a peer that went away is seen as `end` before any `close`
const peerGone = (socket: Duplex): Effect.Effect<void> => {
  const gone = Deferred.makeUnsafe<void>();
  socket.once("end", () => Deferred.doneUnsafe(gone, Exit.void));
  socket.once("close", () => Deferred.doneUnsafe(gone, Exit.void));
  return Deferred.await(gone);
};

export interface HungHandshakeT3 {
  readonly baseUrl: string;
  // the upgrade request was received; `gone` completes when the client ends or closes that connection
  readonly accepted: Effect.Effect<{ readonly gone: Effect.Effect<void> }>;
}

// accepts the upgrade request and never answers it
export const hungHandshakeT3: Effect.Effect<HungHandshakeT3, never, Scope.Scope> = Effect.acquireRelease(Effect.gen(function* () {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const accepted = Deferred.makeUnsafe<{ readonly gone: Effect.Effect<void> }>();
  server.on("upgrade", (_request, socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    Deferred.doneUnsafe(accepted, Exit.succeed({ gone: peerGone(socket) }));
  });
  return { server, sockets, baseUrl: yield* listen(server), accepted: Deferred.await(accepted) };
}), ({ server, sockets }) => Effect.suspend(() => {
  for (const socket of sockets) socket.destroy();
  return closeServer(server);
}));

export interface RawConnection {
  readonly socket: Socket;
  readonly frames: ClientFrame[];
  // the first received client frame, past or future, that matches
  frame(match: (frame: ClientFrame) => boolean): Effect.Effect<ClientFrame>;
  // completes when the client ends or closes the connection
  readonly gone: Effect.Effect<void>;
}

export interface RawWebSocketT3 {
  readonly baseUrl: string;
  readonly connection: Effect.Effect<RawConnection>;
}

// completes the websocket handshake by hand so a test controls exactly which bytes reach the client in one write
export const rawWebSocketT3: Effect.Effect<RawWebSocketT3, never, Scope.Scope> = Effect.acquireRelease(Effect.gen(function* () {
  const server = createServer();
  const sockets = new Set<Socket>();
  const connection = Deferred.makeUnsafe<RawConnection>();
  server.on("upgrade", (request, duplex) => {
    const socket = duplex as Socket;
    sockets.add(socket);
    const gone = peerGone(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const key = String(request.headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frames: ClientFrame[] = [];
    const waiters: Array<{ match: (frame: ClientFrame) => boolean; deferred: Deferred.Deferred<ClientFrame> }> = [];
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0]! & 0x0f;
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (buffer[1]! & 0x80) !== 0;
        const end = offset + (masked ? 4 : 0) + length;
        if (buffer.length < end) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
        const payload = Buffer.from(buffer.subarray(end - length, end));
        if (mask) for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!;
        buffer = buffer.subarray(end);
        const frame = { opcode, payload };
        frames.push(frame);
        for (const waiter of [...waiters]) {
          if (!waiter.match(frame)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          Deferred.doneUnsafe(waiter.deferred, Exit.succeed(frame));
        }
      }
    });
    Deferred.doneUnsafe(connection, Exit.succeed({
      socket,
      frames,
      frame: (match) => Effect.suspend(() => {
        const existing = frames.find(match);
        if (existing) return Effect.succeed(existing);
        const deferred = Deferred.makeUnsafe<ClientFrame>();
        waiters.push({ match, deferred });
        return Deferred.await(deferred);
      }),
      gone,
    }));
  });
  return { server, sockets, baseUrl: yield* listen(server), connection: Deferred.await(connection) };
}), ({ server, sockets }) => Effect.suspend(() => {
  for (const socket of sockets) socket.destroy();
  return closeServer(server);
}));
