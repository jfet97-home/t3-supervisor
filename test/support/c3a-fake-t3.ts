import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

// loopback peers standing in for T3 in the c3a characterization suites

export const deferred = <A = void>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

// an explicit deadline for an awaited loopback event
export const within = <A>(promise: Promise<A>, milliseconds = 2500, label = "loopback event"): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const listen = async (server: ReturnType<typeof createServer>): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback peer did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

export interface MockT3 {
  baseUrl: string;
  webSockets: WebSocketServer;
  close(): Promise<void>;
}

// an http server with the T3 websocket endpoint at /ws, as in the baseline t3 suite
export const startMockT3 = async (onHttp: (request: IncomingMessage, response: ServerResponse) => void): Promise<MockT3> => {
  const http = createServer(onHttp);
  const webSockets = new WebSocketServer({ server: http, path: "/ws" });
  const baseUrl = await listen(http);
  return {
    baseUrl,
    webSockets,
    close: async () => {
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => webSockets.close((error) => error ? reject(error) : resolve()));
      // a connection the client opened without sending a request would otherwise hold the close until it times out
      const closed = closeServer(http);
      http.closeAllConnections();
      await closed;
    },
  };
};

// http server sockets allow half-open connections, so a peer that went away is seen as `end` before any `close`
const peerGone = (socket: Duplex): Promise<void> => new Promise<void>((resolve) => {
  socket.once("end", () => resolve());
  socket.once("close", () => resolve());
});

export interface HungHandshakeT3 {
  baseUrl: string;
  // the upgrade request was received; `gone` settles when the client ends or closes that connection
  accepted: Promise<{ gone: Promise<void> }>;
  close(): Promise<void>;
}

// accepts the upgrade request and never answers it
export const startHungHandshakeT3 = async (): Promise<HungHandshakeT3> => {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const accepted = deferred<{ gone: Promise<void> }>();
  server.on("upgrade", (_request, socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    accepted.resolve({ gone: peerGone(socket) });
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    accepted: accepted.promise,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
};

export interface ClientFrame {
  opcode: number;
  payload: Buffer;
}

// an unmasked server-to-client frame with the given payload length
export const frameHeader = (length: number, opcode = 0x1): Buffer => {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
};

export const textFrame = (text: string): Buffer => {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([frameHeader(payload.length), payload]);
};

export interface RawConnection {
  socket: Socket;
  frames: ClientFrame[];
  // resolves with the first received client frame, past or future, that matches
  frame(match: (frame: ClientFrame) => boolean): Promise<ClientFrame>;
  // settles when the client ends or closes the connection
  gone: Promise<void>;
}

export interface RawWebSocketT3 {
  baseUrl: string;
  connection: Promise<RawConnection>;
  close(): Promise<void>;
}

// completes the websocket handshake by hand so a test controls exactly which bytes reach the client in one write
export const startRawWebSocketT3 = async (): Promise<RawWebSocketT3> => {
  const server = createServer();
  const sockets = new Set<Socket>();
  const connection = deferred<RawConnection>();
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
    const waiters: Array<{ match: (frame: ClientFrame) => boolean; resolve: (frame: ClientFrame) => void }> = [];
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
          waiter.resolve(frame);
        }
      }
    });
    connection.resolve({
      socket,
      frames,
      frame: (match) => {
        const existing = frames.find(match);
        if (existing) return Promise.resolve(existing);
        return new Promise<ClientFrame>((resolve) => waiters.push({ match, resolve }));
      },
      gone,
    });
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    connection: connection.promise,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
};
