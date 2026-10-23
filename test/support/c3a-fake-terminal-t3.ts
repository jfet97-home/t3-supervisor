import { WebSocketServer, type WebSocket } from "ws";

// a loopback T3 serving the terminal RPCs of the native Git probe, adapted from the fake in test/git-probe.test.ts

// a promise with its settle functions, completed from the peer's node callbacks
const deferred = <A = void>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

export interface ProbeStatus {
  workspaceRoot: string;
  branch: string | null;
  isRepo: boolean;
  changedPaths: string[];
  operationState: { status: "safe" };
}

export interface TerminalRequest {
  tag: string;
  threadId: string;
  terminalId: string;
  payload: Record<string, unknown>;
}

type Session = { terminalId: string; cwd: string; attach?: { requestId: string; socket: WebSocket; onAck: (() => void) | undefined } };

export interface FakeTerminalT3 {
  url: string;
  // every terminal request in arrival order
  requests: TerminalRequest[];
  // settles once the helper write of a held probe was answered and the client closed that RPC connection,
  // or with undefined when the fake closes without holding a probe
  helperWritten: Promise<{ threadId: string; terminalId: string } | undefined>;
  // settles when the client ends the attach stream of the given terminal session
  attachGone(threadId: string): Promise<void>;
  releaseResult(): void;
  close(): Promise<void>;
}

// `holdResult(index)` withholds the result packet of the probe with that index until `releaseResult()`
export const startFakeTerminalT3 = async (status: ProbeStatus, holdResult: (index: number) => boolean = () => false): Promise<FakeTerminalT3> => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake terminal T3 did not bind a TCP port");
  const requests: TerminalRequest[] = [];
  const sessions = new Map<string, Session>();
  const attachClosed = new Map<string, ReturnType<typeof deferred<void>>>();
  const helperWritten = deferred<{ threadId: string; terminalId: string } | undefined>();
  let release: (() => void) | undefined;
  let probes = 0;
  const attachGone = (threadId: string) => {
    const existing = attachClosed.get(threadId);
    if (existing) return existing;
    const created = deferred<void>();
    attachClosed.set(threadId, created);
    return created;
  };
  const chunk = (session: Session, values: unknown[], onAck?: () => void) => {
    if (!session.attach) return;
    session.attach.onAck = onAck;
    session.attach.socket.send(JSON.stringify({ _tag: "Chunk", requestId: session.attach.requestId, values }));
  };
  server.on("connection", (socket) => socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as { _tag?: string; requestId?: string; id?: string; tag?: string; payload?: Record<string, unknown> };
    if (frame._tag === "Ack") {
      const attach = [...sessions.values()].map((session) => session.attach).find((stream) => stream?.requestId === frame.requestId);
      if (!attach) return;
      const next = attach.onAck;
      attach.onAck = undefined;
      next?.();
      return;
    }
    if (frame._tag !== "Request" || typeof frame.id !== "string" || typeof frame.tag !== "string") return;
    const id = frame.id;
    const payload = frame.payload ?? {};
    const threadId = String(payload.threadId);
    const terminalId = String(payload.terminalId);
    requests.push({ tag: frame.tag, threadId, terminalId, payload });
    const exit = (value?: unknown) => socket.send(JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", ...(value === undefined ? {} : { value }) } }));
    const running = (cwd: string) => ({ threadId, terminalId, cwd, worktreePath: null, status: "running", pid: 100, history: "", exitCode: null,
      exitSignal: null, label: "shell", updatedAt: "now" });
    if (frame.tag === "terminal.open") {
      const cwd = String(payload.cwd);
      sessions.set(threadId, { terminalId, cwd });
      exit(running(cwd));
    } else if (frame.tag === "terminal.attach") {
      const session = sessions.get(threadId);
      if (!session) return;
      session.attach = { requestId: id, socket, onAck: undefined };
      const gone = attachGone(threadId);
      socket.once("close", () => gone.resolve());
      chunk(session, [{ type: "snapshot", snapshot: running(session.cwd) }]);
    } else if (frame.tag === "terminal.write") {
      const session = sessions.get(threadId);
      const command = String(payload.data);
      if (!session) return;
      const nonce = /T3_SUPERVISOR_GIT_READY:([0-9a-f]{32})/.exec(command)?.[1];
      if (nonce !== undefined) {
        // the bootstrap echo, then the standalone readiness marker after its ACK
        chunk(session, [{ type: "output", threadId, terminalId, sequence: 1, data: command + "\r\n" }], () =>
          chunk(session, [{ type: "output", threadId, terminalId, sequence: 2, data: "\r\nT3_SUPERVISOR_GIT_READY:" + nonce + "\r\n" }]));
        exit();
        return;
      }
      const helperNonce = /nonce = "([0-9a-f]{32})"/.exec(command)?.[1] ?? "";
      const packet = Buffer.from(JSON.stringify({ ok: true, ...status }), "utf8").toString("base64");
      const sendResult = () => chunk(session, [{ type: "output", threadId, terminalId, sequence: 3,
        data: "\r\nT3_SUPERVISOR_GIT_PROBE:" + helperNonce + ":" + packet + "\r\n" }], () =>
        chunk(session, [{ type: "exited", threadId, terminalId, sequence: 4, exitCode: 0, exitSignal: null }]));
      if (holdResult(probes++)) {
        release = sendResult;
        socket.once("close", () => helperWritten.resolve({ threadId, terminalId }));
      } else {
        sendResult();
      }
      exit();
    } else if (frame.tag === "terminal.close") {
      sessions.delete(threadId);
      exit();
    } else {
      socket.send(JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Failure", cause: { message: "unexpected request" } } }));
    }
  }));
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    helperWritten: helperWritten.promise,
    attachGone: (threadId) => attachGone(threadId).promise,
    releaseResult: () => {
      if (!release) throw new Error("no probe result is held");
      const send = release;
      release = undefined;
      send();
    },
    close: async () => {
      helperWritten.resolve(undefined);
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
