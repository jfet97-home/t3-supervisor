import assert from "node:assert/strict";
import {test} from "node:test";
import {WebSocketServer} from "ws";
import {makeProjectCommitter, ProjectFileError} from "../src/project-files.js";

type Scenario = "success" | "failed" | "foreign_identity";

async function fakeGitServer(scenario: Scenario) {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0});
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const eventOrder: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  let protocolViolation = false;

  server.on("connection", socket => {
    let requestId: string | undefined;
    let nextAck: (() => void) | undefined;
    const sendChunkAndWait = async (values: unknown[]) => {
      assert.ok(requestId);
      const before = eventOrder.filter(event => event.startsWith("ack:")).length;
      const acked = new Promise<void>(resolve => {nextAck = resolve;});
      socket.send(JSON.stringify({_tag: "Chunk", requestId, values}));
      await acked;
      const after = eventOrder.filter(event => event.startsWith("ack:")).length;
      if (after !== before + 1) protocolViolation = true;
    };

    socket.on("message", data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame._tag === "Ack") {
        if (frame.requestId !== requestId || !nextAck) {protocolViolation = true;return;}
        const count = eventOrder.filter(event => event.startsWith("ack:")).length + 1;
        eventOrder.push("ack:" + count);
        const resume = nextAck;
        nextAck = undefined;
        resume();
        return;
      }
      if (frame._tag !== "Request") return;
      const request = frame as Record<string, unknown> & {id?: string; tag?: string; payload?: Record<string, unknown>};
      requestId = request.id;
      requests.push(request);
      assert.equal(request.tag, "git.runStackedAction");
      assert.equal(request.payload?.action, "commit");
      const payloadActionId = request.payload?.actionId;
      assert.equal(typeof payloadActionId, "string");
      void (async () => {
        await sendChunkAndWait([{actionId: payloadActionId, kind: "action_started"}]);
        eventOrder.push("action_started_acknowledged");
        if (scenario === "success") {
          await sendChunkAndWait([{actionId: payloadActionId, kind: "action_finished", result: {commit: {status: "created", commitSha: "abc123"}}}]);
        } else if (scenario === "failed") {
          await sendChunkAndWait([{actionId: payloadActionId, kind: "action_failed", error: {message: "commit failed"}}]);
        } else {
          await sendChunkAndWait([{actionId: "different-action", kind: "action_finished", result: {commit: {status: "created", commitSha: "foreign"}}}]);
        }
        socket.send(JSON.stringify({_tag: "Exit", requestId, exit: scenario === "success"
          ? {_tag: "Success", value: {}}
          : {_tag: "Failure", cause: {message: "native action did not complete"}}}));
      })();
    });
  });

  return {
    url: "http://127.0.0.1:" + address.port,
    eventOrder,
    requests,
    get protocolViolation() {return protocolViolation;},
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

const commit = (server: Awaited<ReturnType<typeof fakeGitServer>>) =>
  makeProjectCommitter(server.url, "commit-test-token").commitFiles(
    "/workspace", [".t3-supervisor/rules.yaml"], "Create Supervisor definitions", "action-1", AbortSignal.timeout(5000),
  );

test("native commit ACKs each action chunk before accepting the next and reports the finished commit", async () => {
  const server = await fakeGitServer("success");
  try {
    const result = await commit(server);
    assert.deepEqual(result, {status: "committed", commitSha: "abc123"});
    assert.deepEqual(server.eventOrder, ["ack:1", "action_started_acknowledged", "ack:2"]);
    assert.equal(server.protocolViolation, false);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("matching action_failed events retain the uncertain result", async () => {
  const server = await fakeGitServer("failed");
  try {
    assert.deepEqual(await commit(server), {status: "uncertain"});
    assert.deepEqual(server.eventOrder, ["ack:1", "action_started_acknowledged", "ack:2"]);
    assert.equal(server.protocolViolation, false);
  } finally {
    await server.close();
  }
});

test("events from another action identity do not make a failed commit uncertain", async () => {
  const server = await fakeGitServer("foreign_identity");
  try {
    await assert.rejects(commit(server), (error: unknown) => error instanceof ProjectFileError && error.code === "unavailable");
    assert.deepEqual(server.eventOrder, ["ack:1", "action_started_acknowledged", "ack:2"]);
    assert.equal(server.protocolViolation, false);
  } finally {
    await server.close();
  }
});
