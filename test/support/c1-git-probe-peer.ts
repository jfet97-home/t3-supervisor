import assert from "node:assert/strict";
import {WebSocketServer} from "ws";

// copied from test/git-probe.test.ts (frozen baseline suite); records every raw client frame and can ping before
// the terminal.open reply or refuse terminal.open
type Request = {id: string; tag: string; payload: Record<string, unknown>};
type ProbeStatus = {workspaceRoot: string; branch: string | null; isRepo: boolean; changedPaths: string[]; operationState: {status: "safe" | "in_progress"; marker?: string}};
type AttachStream = {requestId: string; send(data: string): void; ackedChunks: number; readyMarkerSent?: boolean; readyAfterAck?: () => void; exitAfterAck?: () => void};
type FakeOptions = {holdReadyMarker?: boolean; exitSignal?: number | null; pingBeforeOpenExit?: boolean; failOpen?: boolean};

export async function fakeT3(statusForCall: (index: number) => ProbeStatus, exitCode = 0, options: FakeOptions = {}) {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0});
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const requests: Request[] = [];
  const closes: Array<Record<string, unknown>> = [];
  const streamAckCounts: number[] = [];
  const sessions = new Map<string, {terminalId: string; cwd: string; attach?: AttachStream}>();
  let resolveEchoAcked!: () => void;
  const echoAcked = new Promise<void>(resolve => {resolveEchoAcked = resolve;});
  let releaseReadyMarker: (() => void) | undefined;
  let prematureHelperWrites = 0;
  let callIndex = 0;
  const frames: string[] = [];
  const pendingOpenExits = new Map<object, () => void>();
  server.on("connection", socket => socket.on("message", data => {
    frames.push(data.toString());
    const frame = JSON.parse(data.toString()) as { _tag?: string; requestId?: string; id?: string; tag?: string; payload?: Record<string, unknown> };
    if (frame._tag === "Pong") {
      const exit = pendingOpenExits.get(socket);
      pendingOpenExits.delete(socket);
      exit?.();
      return;
    }
    if (frame._tag === "Ack") {
      const attach = [...sessions.values()].map(session => session.attach).find(stream => stream?.requestId === frame.requestId);
      assert.ok(attach, "the client ACKs only a current streamed request");
      attach.ackedChunks++;
      attach.readyAfterAck?.();
      attach.exitAfterAck?.();
      return;
    }
    if (frame._tag !== "Request") return;
    const request = frame as Request;
    requests.push(request);
    const sendExit = (value?: unknown) => socket.send(JSON.stringify({_tag: "Exit", requestId: request.id, exit: {_tag: "Success", ...(value === undefined ? {} : {value})}}));
    if (request.tag === "terminal.open") {
      const {threadId, terminalId, cwd} = request.payload as {threadId: string; terminalId: string; cwd: string};
      if (options.failOpen) {
        socket.send(JSON.stringify({_tag: "Exit", requestId: request.id, exit: {_tag: "Failure", cause: {_tag: "Fail", failure: {message: "terminal unavailable"}}}}));
        return;
      }
      const session = {terminalId, cwd};
      sessions.set(threadId, session);
      const exit = () => sendExit({threadId, terminalId, cwd, worktreePath: null, status: "running", pid: 100, history: "", exitCode: null, exitSignal: null, label: "shell", updatedAt: "now"});
      // the client must answer a ping before the reply arrives
      if (options.pingBeforeOpenExit) {pendingOpenExits.set(socket, exit);socket.send(JSON.stringify({_tag: "Ping"}));}
      else exit();
    } else if (request.tag === "terminal.attach") {
      const {threadId, terminalId} = request.payload as {threadId: string; terminalId: string};
      const session = sessions.get(threadId);
      assert.ok(session);
      assert.equal(session.terminalId, terminalId);
      session.attach = {requestId: request.id, send: data => socket.send(data), ackedChunks: 0};
      socket.send(JSON.stringify({_tag: "Chunk", requestId: request.id, values: [{
        type: "snapshot",
        snapshot: {threadId, terminalId, cwd: session.cwd, worktreePath: null, status: "running", pid: 100, history: "", exitCode: null, exitSignal: null, label: "shell", updatedAt: "now"},
      }]}));
    } else if (request.tag === "terminal.write") {
      const {threadId, terminalId, data: command} = request.payload as {threadId: string; terminalId: string; data: string};
      const session = sessions.get(threadId);
      assert.ok(session?.attach);
      assert.equal(session.terminalId, terminalId);
      if (command.includes("T3_SUPERVISOR_GIT_READY:")) {
        assert.equal(session.attach.ackedChunks, 1, "the snapshot must be ACKed before the bootstrap is written");
        assert.ok(command.startsWith("stty -echo; printf "));
        assert.ok(command.includes("; exec /usr/bin/env python3 -c "));
        assert.ok(command.includes("sys.stdin.read()"), "the fixed Python command consumes source non-interactively");
        assert.ok(command.endsWith("\n"));
        assert.ok(command.length < 256, "only the short bootstrap passes through interactive shell input");
        const nonce = /T3_SUPERVISOR_GIT_READY:([0-9a-f]{32})/.exec(command)?.[1];
        assert.ok(nonce);
        const sendReadyMarker = () => {
          if (!session.attach || session.attach.readyMarkerSent) return;
          session.attach.readyMarkerSent = true;
          session.attach.send(JSON.stringify({_tag: "Chunk", requestId: session.attach.requestId, values: [
            {type: "output", threadId, terminalId, sequence: 2, data: "\r\nT3_SUPERVISOR_GIT_READY:" + nonce + "\r\n"},
          ]}));
        };
        session.attach.readyAfterAck = () => {
          if (session.attach?.ackedChunks !== 2 || !session.attach.readyAfterAck) return;
          delete session.attach.readyAfterAck;
          resolveEchoAcked();
          if (options.holdReadyMarker) releaseReadyMarker = sendReadyMarker;
          else sendReadyMarker();
        };
        session.attach.send(JSON.stringify({_tag: "Chunk", requestId: session.attach.requestId, values: [
          {type: "output", threadId, terminalId, sequence: 1, data: command + "\r\n"},
        ]}));
      } else {
        if (!session.attach.readyMarkerSent) {
          prematureHelperWrites++;
          socket.send(JSON.stringify({_tag: "Exit", requestId: request.id, exit: {_tag: "Failure", cause: {message: "helper arrived before readiness"}}}));
          return;
        }
        assert.equal(session.attach.ackedChunks, 3, "the helper is sent only after the standalone readiness ACK");
        assert.ok(command.endsWith("\n\x04"), "canonical input is terminated with Ctrl-D");
        const source = command.slice(0, -2);
        assert.ok(source.startsWith("import base64, json, os, subprocess, sys\n"));
        const rootExpression = /root_arg = os\.fsdecode\(base64\.b64decode\(\n([\s\S]*?)\n\)\)/.exec(source)?.[1];
        assert.ok(rootExpression);
        const encodedRoot = [...rootExpression.matchAll(/"([A-Za-z0-9+/=]*)"/g)].map(match => match[1]).join("");
        assert.equal(Buffer.from(encodedRoot, "base64").toString("utf8"), session.cwd, "checkout text is passed as data, not shell syntax");
        assert.ok(!source.includes(session.cwd));
        assert.ok(source.split("\n").every(line => Buffer.byteLength(line, "utf8") < 900), "Python input lines stay below terminal canonical limits");
        const nonce = /nonce = "([0-9a-f]{32})"/.exec(source)?.[1];
        assert.ok(nonce);
        const status = statusForCall(callIndex++);
        const packet = Buffer.from(JSON.stringify({ok: true, ...status}), "utf8").toString("base64");
        session.attach.send(JSON.stringify({_tag: "Chunk", requestId: session.attach.requestId, values: [
          {type: "output", threadId, terminalId, sequence: 3, data: "\r\nT3_SUPERVISOR_GIT_PROBE:" + nonce + ":" + packet + "\r\n"},
        ]}));
        session.attach.exitAfterAck = () => {
          if (session.attach?.ackedChunks !== 4 || !session.attach.exitAfterAck) return;
          delete session.attach.exitAfterAck;
          session.attach.send(JSON.stringify({_tag: "Chunk", requestId: session.attach.requestId, values: [
            {type: "exited", threadId, terminalId, sequence: 4, exitCode, exitSignal: options.exitSignal ?? null},
          ]}));
        };
      }
      sendExit();
    } else if (request.tag === "terminal.close") {
      closes.push(request.payload);
      const {threadId} = request.payload as {threadId: string};
      const session = sessions.get(threadId);
      if (session?.attach) streamAckCounts.push(session.attach.ackedChunks);
      sessions.delete(threadId);
      sendExit();
    } else {
      socket.send(JSON.stringify({_tag: "Exit", requestId: request.id, exit: {_tag: "Failure", cause: {message: "unexpected request"}}}));
    }
  }));
  return {
    url: "http://127.0.0.1:" + address.port,
    frames,
    requests,
    closes,
    streamAckCounts,
    echoAcked,
    releaseReadyMarker() {
      assert.ok(releaseReadyMarker, "the fake has withheld the standalone readiness marker");
      releaseReadyMarker();
    },
    get prematureHelperWrites() {return prematureHelperWrites;},
    async close() {
      // tests that never exercise the echo handshake settle its promise here
      resolveEchoAcked();
      for (const client of server.clients) client.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
