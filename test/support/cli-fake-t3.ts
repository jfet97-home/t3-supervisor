import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Clock, Duration, Effect } from "effect";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

// loopback stand-in for the T3 server: descriptor, shell snapshots and native rpc frames, recording every request
export interface FakeT3Options {
  readonly token: string;
  readonly environmentId?: string;
  // "unavailable" answers the descriptor with 503 so the supervisor stays in its descriptor retry; "failing" with 500 and `failure`
  readonly descriptor?: "ok" | "unavailable" | "failing";
  // a native error body: the 500 descriptor body, and the Exit failure of every non-shell request (and of the shell subscriptions
  // when `failSubscriptions` is set)
  readonly failure?: Record<string, unknown>;
  readonly failSubscriptions?: boolean;
  readonly activeThreads?: number;
  readonly archiveThreads?: number;
  readonly sendActiveSnapshot?: boolean;
  readonly sendArchiveSnapshot?: boolean;
}

export interface FakeT3Traffic {
  // "GET /path" for every http request, including rejected ones
  readonly http: string[];
  // websocket request tags in arrival order
  readonly requests: string[];
  // request ids of every Ack frame
  readonly acks: string[];
  // _tag of every websocket frame
  readonly frames: string[];
  readonly unauthorized: number;
  readonly upgrades: number;
}

export interface FakeT3 {
  readonly baseUrl: string;
  readonly traffic: FakeT3Traffic;
  until(predicate: (traffic: FakeT3Traffic) => boolean, timeoutMs: number, label: string): Promise<void>;
  // calls the listener after every recorded request; the returned function removes it
  subscribe(listener: () => void): () => void;
  // calls the listener once when the fake closes (at once when it already has); the returned function removes it
  whenClosed(listener: () => void): () => void;
  // the traffic listeners attached now: every pending wait holds exactly one
  waits(): number;
  // closing ends every pending wait, promise or effect: its timer is cleared, its listener removed and it fails as closed;
  // a second close does nothing
  close(): Promise<void>;
}

const thread = (id: string) => ({
  id, title: `Fixture ${id}`, projectId: null,
  lineage: { parentThreadId: null, relationshipToParent: null },
});

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
};

const text = (data: RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
};

export const startFakeT3 = async (options: FakeT3Options): Promise<FakeT3> => {
  const traffic = { http: [] as string[], requests: [] as string[], acks: [] as string[], frames: [] as string[], unauthorized: 0, upgrades: 0 };
  const events = new EventEmitter();
  const pending = new Set<() => void>();
  const closeListeners = new Set<() => void>();
  let closing: Promise<void> | undefined;
  const record = () => events.emit("traffic");
  const authorized = (request: IncomingMessage) => request.headers.authorization === `Bearer ${options.token}`;
  const activeThreads = Array.from({ length: options.activeThreads ?? 0 }, (_, index) => thread(`active-${index + 1}`));
  const archiveThreads = Array.from({ length: options.archiveThreads ?? 0 }, (_, index) => thread(`archive-${index + 1}`));
  const http = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    traffic.http.push(`${request.method ?? "GET"} ${path}`);
    record();
    if (!authorized(request)) {
      traffic.unauthorized += 1;
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && path === "/.well-known/t3/environment") {
      if (options.descriptor === "unavailable") sendJson(response, 503, { error: "unavailable" });
      else if (options.descriptor === "failing") sendJson(response, 500, options.failure ?? { error: "failing" });
      else sendJson(response, 200, { environmentId: options.environmentId ?? "fake-environment", orchestrationProtocolVersion: 2, serverVersion: "fake" });
      return;
    }
    if (request.method === "GET" && path === "/api/orchestration/shell") {
      sendJson(response, 200, { schemaVersion: 2, snapshotSequence: 1, projects: [], threads: activeThreads, archivedThreads: [] });
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });
  const webSockets = new WebSocketServer({
    server: http,
    path: "/ws",
    verifyClient: (info, accept) => {
      traffic.upgrades += 1;
      record();
      if (authorized(info.req)) {
        accept(true);
        return;
      }
      traffic.unauthorized += 1;
      accept(false, 401, "Unauthorized");
    },
  });
  const reply = (socket: WebSocket, frame: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };
  webSockets.on("connection", (socket) => {
    socket.on("error", () => undefined);
    socket.on("message", (data) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(text(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const tag = String(frame._tag);
      traffic.frames.push(tag);
      if (tag === "Ack") traffic.acks.push(String(frame.requestId));
      if (tag === "Request") traffic.requests.push(String(frame.tag));
      record();
      if (tag === "Ping") return reply(socket, { _tag: "Pong" });
      if (tag !== "Request") return;
      const id = String(frame.id);
      const failure = { _tag: "Exit", requestId: id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: options.failure ?? { _tag: "FakeT3UnsupportedRequest" } }] } };
      const subscription = frame.tag === "orchestration.subscribeShell" || frame.tag === "orchestration.subscribeArchivedShell";
      if (subscription && options.failSubscriptions === true) return reply(socket, failure);
      if (frame.tag === "orchestration.subscribeShell") {
        if (options.sendActiveSnapshot === false) return;
        return reply(socket, { _tag: "Chunk", requestId: id, values: [{ kind: "snapshot", snapshot: {
          schemaVersion: 2, snapshotSequence: 1, projects: [], threads: activeThreads, archivedThreads: [] } }] });
      }
      if (frame.tag === "orchestration.subscribeArchivedShell") {
        if (options.sendArchiveSnapshot === false) return;
        return reply(socket, { _tag: "Chunk", requestId: id, values: [{ kind: "snapshot", snapshot: {
          schemaVersion: 2, snapshotSequence: 1, projects: [], threads: archiveThreads } }] });
      }
      if (frame.tag === "orchestration.getArchivedShellSnapshot" && options.failure === undefined) {
        return reply(socket, { _tag: "Exit", requestId: id, exit: { _tag: "Success", value: { schemaVersion: 2, snapshotSequence: 1, threads: archiveThreads } } });
      }
      reply(socket, failure);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("fake T3 did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    traffic,
    until: (predicate, timeoutMs, label) => new Promise<void>((resolve, reject) => {
      const end = (outcome: () => void) => {
        clearTimeout(timer);
        events.off("traffic", check);
        pending.delete(cancel);
        outcome();
      };
      const check = () => {
        if (predicate(traffic)) end(resolve);
      };
      const cancel = () => end(() => reject(new Error(`fake T3 closed before it observed ${label}`)));
      const timer = setTimeout(() => end(() => reject(new Error(`fake T3 did not observe ${label} within ${timeoutMs} ms`))), timeoutMs);
      pending.add(cancel);
      events.on("traffic", check);
      check();
    }),
    subscribe: (listener) => {
      events.on("traffic", listener);
      return () => {
        events.off("traffic", listener);
      };
    },
    whenClosed: (listener) => {
      if (closing) {
        listener();
        return () => {};
      }
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    waits: () => events.listenerCount("traffic"),
    close: () => closing ??= (async () => {
      for (const cancel of [...pending]) cancel();
      for (const listener of [...closeListeners]) listener();
      closeListeners.clear();
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => webSockets.close((error) => error ? reject(error) : resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    })(),
  };
};

// a wait for the fake's traffic as an effect: the predicate, the fake's close, an interruption or the bound ends it and
// removes its listeners; a close fails it as closed; the bound runs on the live clock, also inside a TestClock suite, and its
// timer ends with the wait
export const untilTraffic = (fake: FakeT3, predicate: (traffic: FakeT3Traffic) => boolean, timeoutMs: number, label: string): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    let ended = false;
    let unsubscribe = () => {};
    let unclosed = () => {};
    const end = (outcome: Effect.Effect<void>) => {
      if (ended) return;
      ended = true;
      unsubscribe();
      unclosed();
      resume(outcome);
    };
    const check = () => {
      if (predicate(fake.traffic)) end(Effect.void);
    };
    unsubscribe = fake.subscribe(check);
    // a fake that already closed ends the wait at once
    unclosed = fake.whenClosed(() => end(Effect.die(new Error(`fake T3 closed before it observed ${label}`))));
    if (ended) unclosed();
    check();
    return Effect.sync(() => {
      ended = true;
      unsubscribe();
      unclosed();
    });
  }).pipe(
    Effect.timeoutOrElse({duration: Duration.millis(timeoutMs),
      orElse: () => Effect.die(new Error(`fake T3 did not observe ${label} within ${timeoutMs} ms`))}),
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
  );
