import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import {WorkflowMcp, type WorkflowMcpShape} from "../src/workflow-mcp.js";
import {promiseWorkflowController} from "./support/mcp-controllers.js";

// request and call ownership at the sdk boundary (plan 3.7, CC-MCP): every admitted request, its sdk server and its body
// read end with close() or layer release, no controller call starts afterwards, a controller that ignores its deadline
// abort gets an outcome-unknown answer while its call stays owned, and controller failures never reach the answer

const headers = {"Content-Type": "application/json", Accept: "application/json, text/event-stream"};
const url = "http://127.0.0.1/mcp/workflows";
const message = (method: string, params: unknown = {}) => JSON.stringify({jsonrpc: "2.0", id: 1, method, params});
const writeCall = (args: unknown) => message("tools/call", {name: "workflow_write", arguments: args});
const initialize = message("initialize", {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "lifecycle", version: "1"}});
const post = (body: string) => new Request(url, {method: "POST", headers, body});

// one request through the endpoint's /mcp/workflows route handler in the caller's fiber; its answer body is read there
// and returned as a web response
const respond = (mcp: WorkflowMcpShape, request: Request) => mcp.route.pipe(
  Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
  Effect.flatMap(response => HttpServerResponse.toClientResponse(response).text.pipe(Effect.orDie,
    Effect.map(text => new Response(text, {status: response.status, headers: new Headers(response.headers)})))));

// a request body the test releases: `reading` settles once the sdk pulls it, `cancelled` once the endpoint cancels it
const heldBody = () => {
  let pulled!: () => void;
  let channel!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const reading = new Promise<void>(resolve => {pulled = resolve;});
  const stream = new ReadableStream<Uint8Array>({start: controller => {channel = controller;}, pull: () => pulled(), cancel: () => {cancelled = true;}},
    {highWaterMark: 0});
  return {
    request: new Request(url, {method: "POST", headers, body: stream, duplex: "half"} as RequestInit),
    reading,
    cancelled: () => cancelled,
    // supplying the body after the endpoint cancelled it reaches nobody; finishing also settles an unpulled `reading`
    finish: (text: string) => {
      pulled();
      if (cancelled) return;
      channel.enqueue(new TextEncoder().encode(text));
      channel.close();
    },
  };
};

type CallBody = {result?: {isError?: boolean; content?: Array<{text?: string}>}; error?: {code?: number; message?: string}};
const callResult = (body: CallBody): unknown => JSON.parse(body.result?.content?.[0]?.text ?? "null");

// a write controller that ignores its signal until the test settles it, and replays its receipt for a repeated operation id
const noncooperative = () => {
  const receipts = new Map<string, unknown>();
  const invocations: Array<{signal: AbortSignal; settle: (value: unknown) => void}> = [];
  let entered!: () => void;
  const entry = new Promise<void>(resolve => {entered = resolve;});
  const write = (args: unknown, signal: AbortSignal) => {
    const operationId = String((args as {input?: {operationId?: unknown}}).input?.operationId);
    const receipt = receipts.get(operationId);
    if (receipt !== undefined) return Promise.resolve(receipt);
    return new Promise<unknown>(resolve => {
      invocations.push({signal, settle: value => {receipts.set(operationId, value);resolve(value);}});
      entered();
    });
  };
  return {controller: promiseWorkflowController({write}), invocations, entry};
};

describe("workflow MCP request and call ownership", () => {
  it.live("MCP-LIFE-01: a tools/call body held across close() starts no controller call, and the request ends with its body read cancelled", () => Effect.gen(function* () {
    let calls = 0;
    const mcp = yield* WorkflowMcp.make(promiseWorkflowController({write: async () => {calls++;return {status: "created"};}}));
    const body = heldBody();
    const request = yield* Effect.forkChild(respond(mcp, body.request));
    yield* Effect.promise(() => body.reading);

    yield* mcp.close;
    assert.notEqual(request.pollUnsafe(), undefined, "close() returns after the admitted request ended");
    assert.equal(Exit.hasInterrupts(yield* Fiber.await(request)), true, "the admitted request ends without an answer");
    assert.equal(body.cancelled(), true);
    body.finish(writeCall({input: {operationId: "op-held"}}));
    const later = yield* respond(mcp, post(writeCall({input: {operationId: "op-later"}})));
    assert.equal(later.status, 503);
    assert.deepEqual(yield* Effect.promise(() => later.json()), {error: "workflow_mcp_closed"});
    assert.equal(calls, 0);
  }), { timeout: 10_000 });

  it.live("MCP-LIFE-02: close() ends tools/list, initialize and slow-body requests that have no call yet, cancelling their body reads", () => Effect.gen(function* () {
    const mcp = yield* WorkflowMcp.make(promiseWorkflowController({}));
    const bodies = [heldBody(), heldBody(), heldBody()];
    const requests = yield* Effect.forEach(bodies, body => Effect.forkChild(respond(mcp, body.request)));
    yield* Effect.forEach(bodies, body => Effect.promise(() => body.reading));

    yield* mcp.close;
    assert.deepEqual(requests.map(request => request.pollUnsafe() !== undefined), [true, true, true]);
    for (const request of requests) assert.equal(Exit.hasInterrupts(yield* Fiber.await(request)), true);
    assert.deepEqual(bodies.map(body => body.cancelled()), [true, true, true]);
    bodies[0]!.finish(message("tools/list"));
    bodies[1]!.finish(initialize);
    // a repeated close() is harmless and the endpoint stays closed
    yield* mcp.close;
    assert.equal((yield* respond(mcp, post(message("tools/list")))).status, 503);
  }), { timeout: 10_000 });

  it.live("MCP-LIFE-03: layer release ends a pending tools/list request and its body read, and later requests get 503", () => Effect.gen(function* () {
    const scope = yield* Scope.make();
    const mcp = yield* WorkflowMcp.make(promiseWorkflowController({})).pipe(Scope.provide(scope));
    const body = heldBody();
    const request = yield* Effect.forkChild(respond(mcp, body.request));
    yield* Effect.promise(() => body.reading);

    yield* Scope.close(scope, Exit.void);
    assert.notEqual(request.pollUnsafe(), undefined, "release returns after the admitted request ended");
    assert.equal(Exit.hasInterrupts(yield* Fiber.await(request)), true);
    assert.equal(body.cancelled(), true);
    body.finish(message("tools/list"));
    const later = yield* respond(mcp, post(message("tools/list")));
    assert.equal(later.status, 503);
    assert.deepEqual(yield* Effect.promise(() => later.json()), {error: "workflow_mcp_closed"});
  }), { timeout: 10_000 });

  it.live("MCP-LIFE-04: a request arriving after close() is answered 503 without its body being read or a controller call", () => Effect.gen(function* () {
    let calls = 0;
    const mcp = yield* WorkflowMcp.make(promiseWorkflowController({write: async () => {calls++;return {status: "created"};}}));
    yield* mcp.close;
    const body = heldBody();
    const response = yield* respond(mcp, body.request);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(yield* Effect.promise(() => response.json()), {error: "workflow_mcp_closed"});
    assert.equal(body.request.bodyUsed, false);
    assert.equal(body.request.body?.locked, false);
    assert.equal(calls, 0);
    body.finish(writeCall({input: {operationId: "op-closed"}}));
  }), { timeout: 10_000 });

  it.live("MCP-LIFE-05: interrupting the caller (a client disconnect) ends a request whose body is still arriving and cancels its body read", () => Effect.gen(function* () {
    let calls = 0;
    const mcp = yield* WorkflowMcp.make(promiseWorkflowController({write: async () => {calls++;return {status: "created"};}}));
    const body = heldBody();
    const request = yield* Effect.forkChild(respond(mcp, body.request));
    yield* Effect.promise(() => body.reading);

    yield* Fiber.interrupt(request);
    assert.equal(body.cancelled(), true);
    body.finish(writeCall({input: {operationId: "op-gone"}}));
    // the endpoint stays open for others
    assert.equal((yield* respond(mcp, post(message("tools/list")))).status, 200);
    assert.equal(calls, 0);
  }), { timeout: 10_000 });

  it.effect("MCP-LIFE-06: a controller that ignores its deadline abort gets an outcome-unknown answer with its operation id, and its later receipt answers the retry", () => Effect.gen(function* () {
    const tool = noncooperative();
    const mcp = yield* WorkflowMcp.make(tool.controller);
    const args = {supervisorThreadId: "sx", bindingGeneration: 1, input: {operationId: "op-write-1"}};
    const answer = yield* Effect.forkChild(respond(mcp, post(writeCall(args))));
    yield* Effect.promise(() => tool.entry);
    const [first] = tool.invocations;
    yield* TestClock.adjust("9 seconds");
    assert.equal((first!.signal.reason as {name?: string}).name, "TimeoutError");
    yield* TestClock.adjust("999 millis");
    assert.equal(answer.pollUnsafe(), undefined, "the caller waits the grace for the controller's own answer");
    yield* TestClock.adjust("1 millis");
    const response = yield* Fiber.join(answer);
    assert.equal(response.status, 200);
    const body = (yield* Effect.promise(() => response.json())) as CallBody;
    assert.equal(body.result?.isError, undefined);
    assert.deepEqual(callResult(body), {status: "uncertain", reason: "tool_outcome_unknown", retryable: true, operationId: "op-write-1"});

    // the call is still owned: its late result is its receipt, which the caller's own retry gets unchanged
    const receipt = {status: "created", operationId: "op-write-1", revision: 4};
    first!.settle(receipt);
    const retry = yield* respond(mcp, post(writeCall(args)));
    assert.deepEqual(callResult((yield* Effect.promise(() => retry.json())) as CallBody), receipt);
    assert.equal(tool.invocations.length, 1, "nothing replays the call");
  }), { timeout: 10_000 });

  it.effect("MCP-LIFE-07: close() ends the request of a controller that ignores its abort, stops owning the call and answers nothing", () => Effect.gen(function* () {
    const tool = noncooperative();
    const mcp = yield* WorkflowMcp.make(tool.controller);
    const answer = yield* Effect.forkChild(respond(mcp, post(writeCall({input: {operationId: "op-write-2"}}))));
    yield* Effect.promise(() => tool.entry);
    const [first] = tool.invocations;

    yield* mcp.close;
    assert.notEqual(answer.pollUnsafe(), undefined);
    assert.equal(Exit.hasInterrupts(yield* Fiber.await(answer)), true);
    assert.equal((first!.signal.reason as {name?: string}).name, "AbortError");
    first!.settle({status: "created", operationId: "op-write-2"});
    assert.equal(tool.invocations.length, 1);
  }), { timeout: 10_000 });

  it.live("MCP-LIFE-08: a controller throw or rejection answers a fixed internal error without its message, logs nothing of it and runs once, while typed results pass unchanged", () => Effect.gen(function* () {
    const marker = "synthetic-private-marker-mcp-life-08";
    const invocations = {throws: 0, rejects: 0, pending: 0};
    const pending = {status: "pending", operationId: "op-pending", reason: "native_evidence_wait_interrupted", retryable: true};
    const controller = promiseWorkflowController({
      write: () => {invocations.throws++;throw new Error(`${marker} token=secret-${marker}`);},
      readTool: () => {invocations.rejects++;return Promise.reject(new Error(`${marker} SQLITE_BUSY ${marker}`));},
      stopSupervision: async () => {invocations.pending++;return pending;},
    });
    const mcp = yield* WorkflowMcp.make(controller);
    const output: string[] = [];
    const capture = (...values: unknown[]) => {output.push(values.map(String).join(" "));return true;};
    const spies = [
      ...(["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method).mockImplementation(capture)),
      vi.spyOn(process.stdout, "write").mockImplementation(capture),
      vi.spyOn(process.stderr, "write").mockImplementation(capture),
    ];
    const texts = yield* Effect.forEach(["workflow_write", "workflow_read", "supervision_stop"], name =>
      Effect.flatMap(respond(mcp, post(message("tools/call", {name, arguments: {operationId: "op"}}))), response => Effect.promise(() => response.text())),
    ).pipe(Effect.ensuring(Effect.sync(() => spies.forEach(spy => spy.mockRestore()))));

    const [thrown, rejected, typed] = texts.map(text => JSON.parse(text) as CallBody);
    assert.deepEqual(thrown?.error, {code: -32603, message: "Internal error"});
    assert.deepEqual(rejected?.error, {code: -32603, message: "Internal error"});
    assert.deepEqual(callResult(typed!), pending);
    assert.equal(texts.some(text => text.includes(marker)), false, "no answer carries the controller's error");
    assert.equal(output.some(line => line.includes(marker)), false, "no output carries the controller's error");
    assert.deepEqual(invocations, {throws: 1, rejects: 1, pending: 1});
  }), { timeout: 10_000 });
});
