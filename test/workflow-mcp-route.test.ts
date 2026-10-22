import assert from "node:assert/strict";
import {createServer, request as httpRequest, type ClientRequest} from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { TestClock } from "effect/testing";
import {WorkflowMcp, WorkflowMcpRoute} from "../src/workflow-mcp.js";
import type {WorkflowWriteController} from "../src/workflow-write-controller.js";

// target regressions of the effect MCP route (plan 3.7, CC-MCP): request fiber interruption aborts the in-flight call,
// close() interrupts in-flight calls through the endpoint's FiberSet, the 9 s deadline runs on the effect clock and a
// handler failure is a 500 answer

const headers = {"Content-Type": "application/json", Accept: "application/json, text/event-stream"};
const callBody = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}});

type Gate = {
  entered: Promise<AbortSignal>;
  aborted: Promise<unknown>;
  returned: () => boolean;
  tool: (args: unknown, signal: AbortSignal) => Promise<unknown>;
};

// a controller tool that waits until its signal aborts and then reports the abort reason name
const abortWaitingTool = (): Gate => {
  let enter!: (signal: AbortSignal) => void;
  let abort!: (reason: unknown) => void;
  let returned = false;
  const entered = new Promise<AbortSignal>(resolve => {enter = resolve;});
  const aborted = new Promise<unknown>(resolve => {abort = resolve;});
  return {
    entered,
    aborted,
    returned: () => returned,
    tool: async (_args, signal) => {
      enter(signal);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true}));
      abort(signal.reason);
      returned = true;
      return {status: "unavailable", reason: (signal.reason as {name?: string}).name};
    },
  };
};

// serves the route on a loopback port 0 next to a shared endpoint; the test scope closes both
const serveRoute = (controller: WorkflowWriteController) => Effect.gen(function* () {
  const context = yield* Layer.build(HttpRouter.serve(WorkflowMcpRoute, {disableLogger: true, disableListenLog: true}).pipe(
    Layer.provideMerge(WorkflowMcp.layer(controller)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, {port: 0, host: "127.0.0.1"})),
  ));
  const address = Context.get(context, HttpServer.HttpServer).address;
  assert.ok(address._tag === "InetAddressV4");
  return {port: address.port, mcp: Context.get(context, WorkflowMcp)};
});

// one raw tools/call whose connection the test can drop; the scope drops it unless the test already did
const rawCall = (port: number) => Effect.acquireRelease(Effect.sync(() => {
  const client: ClientRequest = httpRequest({host: "127.0.0.1", port, path: "/mcp/workflows", method: "POST",
    headers: {...headers, "Content-Length": Buffer.byteLength(callBody)}});
  const state = {responded: false};
  client.once("response", () => {state.responded = true;});
  client.on("error", () => undefined);
  client.end(callBody);
  return {client, state};
}), ({client}) => Effect.sync(() => client.destroy()));

describe("workflow MCP route", () => {
  it.live("MCP-ROUTE-01: a client disconnect interrupts the request fiber and aborts the controller signal of its call", () => Effect.gen(function* () {
    const gate = abortWaitingTool();
    const {port} = yield* serveRoute({readTool: gate.tool} as unknown as WorkflowWriteController);
    const {client} = yield* rawCall(port);
    const signal = yield* Effect.promise(() => gate.entered);
    assert.equal(signal.aborted, false);
    client.destroy();
    assert.equal(((yield* Effect.promise(() => gate.aborted)) as {name?: string}).name, "AbortError");
  }), { timeout: 10_000 });

  it.live("MCP-ROUTE-02: close() interrupts the in-flight call, leaves its request unanswered and answers later requests 503 without the controller", () => Effect.gen(function* () {
    const gate = abortWaitingTool();
    let calls = 0;
    const controller = {readTool: (args: unknown, signal: AbortSignal) => {calls++;return gate.tool(args, signal);}} as unknown as WorkflowWriteController;
    const {port, mcp} = yield* serveRoute(controller);
    const inflight = yield* rawCall(port);
    yield* Effect.promise(() => gate.entered);

    yield* mcp.close;
    assert.equal(((yield* Effect.promise(() => gate.aborted)) as {name?: string}).name, "AbortError");
    assert.equal(gate.returned(), true);
    const closed = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/mcp/workflows`, {method: "POST", headers, body: callBody}));
    assert.equal(closed.status, 503);
    assert.match(closed.headers.get("content-type") ?? "", /^application\/json/u);
    assert.equal(closed.headers.get("cache-control"), "no-store");
    assert.deepEqual(yield* Effect.promise(() => closed.json()), {error: "workflow_mcp_closed"});
    // the interrupted call's answer was discarded: its request is still unanswered after the later 503 round trip
    assert.equal(inflight.state.responded, false);
    assert.equal(calls, 1);
  }), { timeout: 10_000 });

  it.effect("MCP-ROUTE-03: the 9 s call deadline on the effect clock aborts the controller signal with a TimeoutError and the call answers the controller's result", () => Effect.gen(function* () {
    const gate = abortWaitingTool();
    const mcp = yield* WorkflowMcp.make({readTool: gate.tool} as unknown as WorkflowWriteController);
    const answer = yield* Effect.forkChild(mcp.respond(new Request("http://127.0.0.1/mcp/workflows", {method: "POST", headers, body: callBody})));
    const signal = yield* Effect.promise(() => gate.entered);
    yield* TestClock.adjust("8999 millis");
    assert.equal(signal.aborted, false);
    yield* TestClock.adjust("1 millis");
    assert.equal(((yield* Effect.promise(() => gate.aborted)) as {name?: string}).name, "TimeoutError");
    const response = yield* Fiber.join(answer);
    assert.equal(response.status, 200);
    const body = (yield* Effect.promise(() => response.json())) as {result?: {isError?: boolean; content?: Array<{text?: string}>}};
    assert.equal(body.result?.isError, true);
    assert.deepEqual(JSON.parse(body.result?.content?.[0]?.text ?? "null"), {status: "unavailable", reason: "TimeoutError"});
  }), { timeout: 10_000 });

  it.effect("MCP-ROUTE-04: a transport failure before the answer is a 500 workflow_mcp_unavailable answer", () => Effect.gen(function* () {
    const mcp = yield* WorkflowMcp.make({} as unknown as WorkflowWriteController);
    // the sdk transport reads the method first; a request that cannot report it makes the transport reject
    const broken = Object.create(new Request("http://127.0.0.1/mcp/workflows", {method: "POST", headers, body: callBody}), {
      method: {get: () => {throw new Error("unreadable request");}},
    }) as Request;
    const response = yield* mcp.respond(broken);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(yield* Effect.promise(() => response.json()), {error: "workflow_mcp_unavailable"});
  }), { timeout: 10_000 });
});
