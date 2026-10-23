import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { SupervisorTeamController, TeamDenied } from "../src/supervisor-team-controller.js";
import { WorkflowMcp, type WorkflowMcpShape } from "../src/workflow-mcp.js";
import { WorkflowWriteController, type WorkflowCallCancel } from "../src/workflow-write-controller.js";

// target regressions of the workflow MCP route over the controller services (plan 3.7, s6c): the 9 s deadline reaches an
// effect call as its soft cancel, a call that ignores it answers outcome-unknown after the 1 s grace and stays owned by the
// endpoint until close() interrupts it, the request's end interrupts the call it waits for, typed failures and defects answer
// the fixed internal error, and the endpoint layer serves the supervision run's write and team controllers

const headers = {"Content-Type": "application/json", Accept: "application/json, text/event-stream"};
const url = "http://127.0.0.1/mcp/workflows";
const message = (method: string, params: unknown = {}) => JSON.stringify({jsonrpc: "2.0", id: 1, method, params});
const toolCall = (name: string, args: unknown) => message("tools/call", {name, arguments: args});
const post = (body: string) => new Request(url, {method: "POST", headers, body});

// one request through the endpoint's route handler in the caller's fiber; its answer body is read there
const respond = (mcp: WorkflowMcpShape, request: Request) => mcp.route.pipe(
  Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
  Effect.flatMap(response => HttpServerResponse.toClientResponse(response).text.pipe(Effect.orDie,
    Effect.map(text => ({status: response.status, body: JSON.parse(text) as CallBody})))));

type CallBody = {result?: {isError?: boolean; content?: Array<{text?: string}>; tools?: Array<{name: string}>}; error?: {code?: number; message?: string}};
const callResult = (body: CallBody): unknown => JSON.parse(body.result?.content?.[0]?.text ?? "null");

// a controller call that records its soft cancel and its interruption and waits for the test's answer
const heldCall = Effect.gen(function* () {
  const entered = yield* Deferred.make<WorkflowCallCancel>();
  const answer = yield* Deferred.make<unknown>();
  const interrupted = yield* Deferred.make<void>();
  const tool = (_args: unknown, cancel?: WorkflowCallCancel) => Effect.andThen(Deferred.succeed(entered, cancel!), Deferred.await(answer)).pipe(
    Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)));
  return {entered, answer, interrupted, tool};
});

// the write controller's given tools; the route calls no other member
const writeController = (tools: Record<string, (args: unknown, cancel?: WorkflowCallCancel) => Effect.Effect<unknown, unknown>>) =>
  tools as unknown as WorkflowWriteController["Service"];

describe("workflow MCP route over the controller services", () => {
  it.effect("MCP-SVC-01: the 9 s deadline completes the call's soft cancel and the controller's own answer within the grace is the result", () => Effect.gen(function* () {
    const entered = yield* Deferred.make<WorkflowCallCancel>();
    const pending = {status: "pending", operationId: "op-svc-1", reason: "native_evidence_wait_interrupted", retryable: true};
    const write = (_args: unknown, cancel?: WorkflowCallCancel) => Effect.andThen(Deferred.succeed(entered, cancel!),
      Effect.as(Deferred.await(cancel!), pending));
    const mcp = yield* WorkflowMcp.make(writeController({write}));
    const answer = yield* Effect.forkChild(respond(mcp, post(toolCall("workflow_write", {input: {operationId: "op-svc-1"}}))));
    const cancel = yield* Deferred.await(entered);
    yield* TestClock.adjust("8999 millis");
    assert.equal(yield* Deferred.isDone(cancel), false);
    yield* TestClock.adjust("1 millis");
    assert.equal(yield* Deferred.isDone(cancel), true);
    const response = yield* Fiber.join(answer);
    assert.equal(response.status, 200);
    assert.equal(response.body.result?.isError, undefined);
    assert.deepEqual(callResult(response.body), pending);
  }), {timeout: 10_000});

  it.effect("MCP-SVC-02: a call that ignores its soft cancel answers outcome-unknown with its operation id after the grace, stays running, and close() interrupts it", () => Effect.gen(function* () {
    const held = yield* heldCall;
    const mcp = yield* WorkflowMcp.make(writeController({write: held.tool}));
    const answer = yield* Effect.forkChild(respond(mcp, post(toolCall("workflow_write", {supervisorThreadId: "sx", input: {operationId: "op-svc-2"}}))));
    const cancel = yield* Deferred.await(held.entered);
    yield* TestClock.adjust("9 seconds");
    assert.equal(yield* Deferred.isDone(cancel), true);
    yield* TestClock.adjust("999 millis");
    assert.equal(answer.pollUnsafe(), undefined, "the caller waits the grace for the controller's own answer");
    yield* TestClock.adjust("1 millis");
    const response = yield* Fiber.join(answer);
    assert.deepEqual(callResult(response.body), {status: "uncertain", reason: "tool_outcome_unknown", retryable: true, operationId: "op-svc-2"});
    assert.equal(yield* Deferred.isDone(held.interrupted), false, "the answered request leaves its call running");
    yield* mcp.close;
    assert.equal(yield* Deferred.isDone(held.interrupted), true, "close() interrupts the owned call");
  }), {timeout: 10_000});

  it.live("MCP-SVC-03: the request's end interrupts the call it waits for without its soft cancel, and the endpoint stays open", () => Effect.gen(function* () {
    const held = yield* heldCall;
    const mcp = yield* WorkflowMcp.make(writeController({readTool: held.tool}));
    const answer = yield* Effect.forkChild(respond(mcp, post(toolCall("workflow_read", {}))));
    const cancel = yield* Deferred.await(held.entered);
    yield* Fiber.interrupt(answer);
    yield* Deferred.await(held.interrupted).pipe(Effect.timeout("2 seconds"));
    assert.equal(yield* Deferred.isDone(cancel), false);
    assert.equal(Exit.hasInterrupts(yield* Fiber.await(answer)), true);
    assert.equal((yield* respond(mcp, post(message("tools/list")))).status, 200);
  }), {timeout: 10_000});

  it.live("MCP-SVC-04: a typed failure or a defect of a call answers the fixed internal error once, while a team result passes unchanged", () => Effect.gen(function* () {
    const marker = "synthetic-private-marker-mcp-svc-04";
    const calls = {write: 0, guide: 0, call: 0};
    const controller = writeController({write: () => Effect.suspend(() => {calls.write++;return Effect.die(new Error(`${marker} token=secret`));})});
    const team = {
      guide: () => Effect.suspend(() => {calls.guide++;return Effect.fail(new TeamDenied({reason: marker}));}),
      call: () => Effect.sync(() => {calls.call++;return {status: "ok", operationId: "op-team"};}),
    } as unknown as SupervisorTeamController["Service"];
    const mcp = yield* WorkflowMcp.make(controller, team);
    const died = yield* respond(mcp, post(toolCall("workflow_write", {})));
    const refused = yield* respond(mcp, post(toolCall("supervision_guide", {})));
    const passed = yield* respond(mcp, post(toolCall("supervision_team", {})));
    assert.deepEqual(died.body.error, {code: -32603, message: "Internal error"});
    assert.deepEqual(refused.body.error, {code: -32603, message: "Internal error"});
    assert.deepEqual(callResult(passed.body), {status: "ok", operationId: "op-team"});
    assert.equal(JSON.stringify([died.body, refused.body]).includes(marker), false);
    assert.deepEqual(calls, {write: 1, guide: 1, call: 1});
  }), {timeout: 10_000});

  it.live("MCP-SVC-05: the endpoint layer serves the run's write and team controllers with six tools, and its release closes the endpoint", () => Effect.gen(function* () {
    const readTool = () => Effect.succeed({status: "ok", tool: "read"});
    const team = {call: () => Effect.succeed({status: "ok", tool: "team"}), guide: () => Effect.succeed({status: "ok", tool: "guide"})} as unknown as
      SupervisorTeamController["Service"];
    const scope = yield* Scope.make();
    const mcp = yield* Layer.build(WorkflowMcp.layer.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(WorkflowWriteController, writeController({readTool})),
      Layer.succeed(SupervisorTeamController, team))))).pipe(Effect.map(context => Context.get(context, WorkflowMcp)), Scope.provide(scope));
    const listed = yield* respond(mcp, post(message("tools/list")));
    assert.deepEqual(listed.body.result?.tools?.map(tool => tool.name),
      ["workflow_read", "workflow_write", "supervision_start", "supervision_stop", "supervision_team", "supervision_guide"]);
    assert.deepEqual(callResult((yield* respond(mcp, post(toolCall("supervision_guide", {})))).body), {status: "ok", tool: "guide"});
    assert.deepEqual(callResult((yield* respond(mcp, post(toolCall("workflow_read", {})))).body), {status: "ok", tool: "read"});
    yield* Scope.close(scope, Exit.void);
    assert.equal((yield* respond(mcp, post(message("tools/list")))).status, 503);
  }), {timeout: 10_000});
});
