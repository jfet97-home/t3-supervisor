import assert from "node:assert/strict";
import {createServer, request as httpRequest, type ClientRequest} from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";
import {WorkflowMcp, type WorkflowMcpShape} from "../src/workflow-mcp.js";
import type {WorkflowWriteController} from "../src/workflow-write-controller.js";

// target regressions of the effect MCP route (plan 3.7, CC-MCP): request fiber interruption aborts the in-flight call,
// close() interrupts and completes in-flight requests, the 9 s deadline runs on the effect clock and a handler failure is
// a 500 answer

const headers = {"Content-Type": "application/json", Accept: "application/json, text/event-stream"};
const callBody = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}});

// one request through the endpoint's /mcp/workflows route handler in the caller's fiber; its answer body is read there
// and returned as a web response
const respond = (mcp: WorkflowMcpShape, request: Request) => mcp.route.pipe(
  Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
  Effect.flatMap(response => HttpServerResponse.toClientResponse(response).text.pipe(Effect.orDie,
    Effect.map(text => new Response(text, {status: response.status, headers: new Headers(response.headers)})))));

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

// serves the endpoint's route on a loopback port 0; each request fiber's start and exit are recorded around mcp.route
const serveRoute = (controller: WorkflowWriteController) => Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const ended = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
  const route = HttpRouter.use(router => Effect.gen(function* () {
    const mcp = yield* WorkflowMcp;
    yield* router.add("*", "/mcp/workflows", Deferred.succeed(started, undefined).pipe(
      Effect.andThen(mcp.route), Effect.onExit(exit => Deferred.succeed(ended, exit))));
  }));
  const context = yield* Layer.build(HttpRouter.serve(route, {disableLogger: true, disableListenLog: true}).pipe(
    Layer.provideMerge(WorkflowMcp.layer(controller)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, {port: 0, host: "127.0.0.1"})),
  ));
  const address = Context.get(context, HttpServer.HttpServer).address;
  assert.ok(address._tag === "InetAddressV4");
  return {port: address.port, mcp: Context.get(context, WorkflowMcp), started: Deferred.await(started), ended: Deferred.await(ended),
    endedNow: Deferred.isDone(ended)};
});

type RawAnswer = {status: number; body: string} | {closed: true};

// one raw POST whose connection the test can drop; the scope drops it unless the test already did
const rawPost = (port: number, body: string, contentLength = Buffer.byteLength(body)) => Effect.acquireRelease(Effect.sync(() => {
  let settle!: (answer: RawAnswer) => void;
  const answer = new Promise<RawAnswer>(resolve => {settle = resolve;});
  const client: ClientRequest = httpRequest({host: "127.0.0.1", port, path: "/mcp/workflows", method: "POST",
    headers: {...headers, "Content-Length": contentLength}}, response => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.once("end", () => settle({status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8")}));
    response.once("error", () => settle({closed: true}));
  });
  client.on("error", () => settle({closed: true}));
  client.once("close", () => settle({closed: true}));
  client.write(body);
  if (Buffer.byteLength(body) === contentLength) client.end();
  return {client, answer};
}), ({client}) => Effect.sync(() => client.destroy()));

describe("workflow MCP route", () => {
  it.live("MCP-ROUTE-01: a client disconnect interrupts the request fiber and aborts the controller signal of its call", () => Effect.gen(function* () {
    const gate = abortWaitingTool();
    const {port, ended} = yield* serveRoute({readTool: gate.tool} as unknown as WorkflowWriteController);
    const {client} = yield* rawPost(port, callBody);
    const signal = yield* Effect.promise(() => gate.entered);
    assert.equal(signal.aborted, false);
    client.destroy();
    assert.equal(((yield* Effect.promise(() => gate.aborted)) as {name?: string}).name, "AbortError");
    // the request fiber itself completes, interrupted
    assert.equal(Exit.hasInterrupts(yield* ended), true);
  }), { timeout: 10_000 });

  it.live("MCP-ROUTE-02: close() interrupts the in-flight call and completes its request without an MCP answer, and later requests get 503 without the controller", () => Effect.gen(function* () {
    const gate = abortWaitingTool();
    let calls = 0;
    const controller = {readTool: (args: unknown, signal: AbortSignal) => {calls++;return gate.tool(args, signal);}} as unknown as WorkflowWriteController;
    const {port, mcp, ended, endedNow} = yield* serveRoute(controller);
    const inflight = yield* rawPost(port, callBody);
    yield* Effect.promise(() => gate.entered);

    yield* mcp.close;
    // close() returns after the request fiber ended, interrupted; its client gets the platform's empty interrupted
    // answer, never a result
    assert.equal(yield* endedNow, true);
    assert.equal(Exit.hasInterrupts(yield* ended), true);
    assert.equal(((yield* Effect.promise(() => gate.aborted)) as {name?: string}).name, "AbortError");
    assert.equal(gate.returned(), true);
    const answer = yield* Effect.promise(() => inflight.answer).pipe(Effect.timeout("2 seconds"));
    assert.deepEqual(answer, {status: 503, body: ""});
    const closed = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/mcp/workflows`, {method: "POST", headers, body: callBody}));
    assert.equal(closed.status, 503);
    assert.match(closed.headers.get("content-type") ?? "", /^application\/json/u);
    assert.equal(closed.headers.get("cache-control"), "no-store");
    assert.deepEqual(yield* Effect.promise(() => closed.json()), {error: "workflow_mcp_closed"});
    assert.equal(calls, 1);
  }), { timeout: 10_000 });

  it.effect("MCP-ROUTE-03: the 9 s call deadline on the effect clock aborts the controller signal with a TimeoutError and the call answers the controller's result", () => Effect.gen(function* () {
    const gate = abortWaitingTool();
    const mcp = yield* WorkflowMcp.make({readTool: gate.tool} as unknown as WorkflowWriteController);
    const answer = yield* Effect.forkChild(respond(mcp, new Request("http://127.0.0.1/mcp/workflows", {method: "POST", headers, body: callBody})));
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
    // the sdk transport reads the method first; a request that cannot report it makes the transport reject. the route's
    // request conversion reads only its url
    const broken = Object.create(new Request("http://127.0.0.1/mcp/workflows", {method: "POST", headers, body: callBody}), {
      method: {get: () => {throw new Error("unreadable request");}},
      url: {value: "http://127.0.0.1/mcp/workflows"},
    }) as Request;
    const response = yield* respond(mcp, broken);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(yield* Effect.promise(() => response.json()), {error: "workflow_mcp_unavailable"});
  }), { timeout: 10_000 });

  it.live("MCP-ROUTE-05: a client disconnect while the body is still arriving completes the request fiber without a controller call", () => Effect.gen(function* () {
    let calls = 0;
    const {port, started, ended} = yield* serveRoute({readTool: async () => {calls++;return {status: "ok"};}} as unknown as WorkflowWriteController);
    // the declared length is never reached, so the sdk is still reading the body when the client goes away
    const {client} = yield* rawPost(port, callBody.slice(0, 20), Buffer.byteLength(callBody));
    yield* started;
    client.destroy();
    assert.equal(Exit.hasInterrupts(yield* ended.pipe(Effect.timeout("2 seconds"))), true);
    assert.equal(calls, 0);
  }), { timeout: 10_000 });
});
