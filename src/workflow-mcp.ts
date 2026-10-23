import {SupervisorTeamController, supervisionTeamToolDefinition, supervisionGuideToolDefinition} from "./supervisor-team-controller.js";
import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, FiberSet, Layer, MutableRef, Option, Scope } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  WorkflowWriteController,
  type WorkflowCallCancel,
  supervisionStopToolDefinition,
  supervisionStartToolDefinition,
  workflowReadToolDefinition,
  workflowWriteToolDefinition,
} from "./workflow-write-controller.js";

// the sdk's stateless streamable http transport stays a scoped adapter inside this effect route (plan 3.7, d-03): effect's
// McpServer is sessionful, and the sdk calls promise tool callbacks, which run their effects through FiberSets (o-06); these
// FiberSet runtimes are the route's only run* allowance (the lint guard in eslint.config.js)

const maxMcpRequestBodyBytes = 1024 * 1024;
const callDeadline = "9 seconds";
// how long a caller still waits for the controller's own answer after the deadline's soft cancel
const abortGrace = "1 second";
const serverInfo = {name: "t3-supervisor-workflows", version: "0.1.0"};

// the endpoint is closed: every later request is answered 503 workflow_mcp_closed
export class McpClosed extends Data.TaggedError("McpClosed") {}
// the sdk server or transport failed before it answered: 500 workflow_mcp_unavailable
export class McpUnavailable extends Data.TaggedError("McpUnavailable") {}
// a controller call failed or died: the sdk answers this fixed json-rpc internal error, never the controller's own error
export class ToolFailed extends Data.TaggedError("ToolFailed") {
  readonly code = ErrorCode.InternalError;
  override readonly message = "Internal error";
}

const toolResult = (value: unknown): CallToolResult => {
  const result = value as {status?: unknown};
  const isError = result.status === "denied" || result.status === "invalid" || result.status === "unavailable" ||
    result.status === "incompatible" || result.status === "too_large";
  return {
    content: [{type: "text", text: JSON.stringify(value)}],
    ...(isError ? {isError: true} : {}),
  };
};

const errorResponse = (error: McpClosed | McpUnavailable): Response => new Response(
  JSON.stringify({error: error._tag === "McpClosed" ? "workflow_mcp_closed" : "workflow_mcp_unavailable"}),
  {status: error._tag === "McpClosed" ? 503 : 500, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}},
);

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

// the controller did not answer within the grace after its deadline cancel, so its outcome is unknown, never "not applied";
// the caller's operation id comes back verbatim, and a retry with it gets the controller's own receipt
const outcomeUnknown = (args: unknown) => {
  const operationId = record(args).operationId ?? record(record(args).input).operationId;
  return {status: "uncertain", reason: "tool_outcome_unknown", retryable: true, ...(typeof operationId === "string" ? {operationId} : {})};
};

// one controller call; the cancel is its soft cancel, which the call's deadline completes
type ToolCall = (cancel: WorkflowCallCancel) => Effect.Effect<unknown, unknown>;

export interface WorkflowMcpShape {
  // the /mcp/workflows handler: answers each request through a fresh stateless sdk server and transport; a closed
  // endpoint answers 503, a failed server 500, and a request interrupted by close() or by its request fiber (client
  // disconnect) ends without an mcp answer
  readonly route: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>;
  // closes admission, interrupts every admitted request (releasing its sdk server and body read) and every running
  // controller call; no controller call starts after it returns
  readonly close: Effect.Effect<void>;
}

const make = Effect.fnUntraced(function* (controller: WorkflowWriteController["Service"], team?: SupervisorTeamController["Service"]) {
  const tools = [workflowReadToolDefinition, workflowWriteToolDefinition, supervisionStartToolDefinition, supervisionStopToolDefinition, ...(team ? [supervisionTeamToolDefinition, supervisionGuideToolDefinition] : [])] as unknown as Tool[];
  // the endpoint's hold on every admitted request, and every started controller call, which outlives its request after an
  // outcome-unknown answer until it settles or close()
  const requests = yield* FiberSet.make<void, never>();
  const admit = yield* FiberSet.runtime(requests)();
  const calls = yield* FiberSet.make<unknown, ToolFailed>();
  const runCall = yield* FiberSet.runtime(calls)();
  const closed = MutableRef.make(false);
  const close = Effect.suspend(() => {
    MutableRef.set(closed, true);
    return FiberSet.clear(requests);
  }).pipe(Effect.andThen(FiberSet.clear(calls)));
  // layer release closes the endpoint before the sets themselves close
  yield* Effect.addFinalizer(() => close);

  const toolCall = (name: string, args: unknown): ToolCall | undefined => {
    if (name === "workflow_read") return cancel => controller.readTool(args, cancel);
    if (name === "workflow_write") return cancel => controller.write(args, cancel);
    if (name === "supervision_start") return cancel => controller.startSupervision(args, cancel);
    if (name === "supervision_stop") return cancel => controller.stopSupervision(args, cancel);
    if (name === "supervision_team" && team) return cancel => team.call(args, cancel);
    if (name === "supervision_guide" && team) return cancel => team.guide(args, cancel);
    return undefined;
  };

  // starts the controller call unless the endpoint is closed, then waits for its own result: the 9 s deadline completes its
  // soft cancel, and an answer still missing after the grace is an outcome-unknown result while the call stays owned by the
  // endpoint until it settles or close() interrupts it; the request's end interrupts the call it still waits for
  const answer = (start: ToolCall, args: unknown) => Effect.suspend(() => {
    if (MutableRef.get(closed)) return Effect.interrupt;
    const cancel = Deferred.makeUnsafe<void>();
    // any failure or defect of the call is the fixed internal error; an interruption stays one
    const call = runCall(Effect.suspend(() => start(cancel)).pipe(
      Effect.mapError(() => new ToolFailed()), Effect.catchDefect(() => Effect.fail(new ToolFailed()))));
    return Fiber.join(call).pipe(
      Effect.timeout(callDeadline),
      Effect.catchTag("TimeoutError", () => Effect.andThen(
        Deferred.succeed(cancel, undefined),
        Fiber.join(call).pipe(Effect.timeoutOption(abortGrace), Effect.map(Option.getOrElse(() => outcomeUnknown(args)))),
      )),
      Effect.onInterrupt(() => Fiber.interrupt(call)),
    );
  }).pipe(
    Effect.map(toolResult),
    Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.fail(new ToolFailed())),
  );

  // everything up to server.connect runs synchronously at admission, so the sdk server and transport, the callbacks and
  // the body read belong to the request before its first asynchronous step
  const handle = (incoming: Request) => Effect.gen(function* () {
    const callbacks = yield* Scope.make();
    const waits = yield* FiberSet.make<CallToolResult, ToolFailed>().pipe(Scope.provide(callbacks));
    const wait = yield* FiberSet.runtimePromise(waits)();
    // the sdk reads a wrapper of the body, so an ended request can cancel the source read the sdk would wait on
    const source = incoming.body?.getReader();
    const request = source === undefined ? incoming : new Request(incoming.url, {method: incoming.method, headers: incoming.headers, duplex: "half",
      body: new ReadableStream<Uint8Array>({
        pull: controller => source.read().then(chunk => chunk.done ? controller.close() : controller.enqueue(chunk.value)),
        cancel: reason => source.cancel(reason),
      }, {highWaterMark: 0})} as RequestInit);
    const server = new Server(serverInfo, {capabilities: {tools: {}}});
    server.setRequestHandler(ListToolsRequestSchema, () => ({tools}));
    server.setRequestHandler(CallToolRequestSchema, call => {
      const start = toolCall(call.params.name, call.params.arguments);
      if (!start) return toolResult({status: "invalid", reason: "unknown_tool"});
      return wait(answer(start, call.params.arguments));
    });
    const transport = new WebStandardStreamableHTTPServerTransport({enableJsonResponse: true, maxRequestBodySize: maxMcpRequestBodyBytes});
    let pending: Promise<Response> | undefined;
    // ending the request closes its callbacks first: none starts a call any more and the waiting ones are interrupted,
    // interrupting their calls; the sdk then settles its own json answer from those rejections and the ended body, and that
    // answer is dropped with the request before the sdk server closes
    yield* Effect.addFinalizer(exit => Effect.gen(function* () {
      yield* Scope.close(callbacks, exit);
      if (source !== undefined)
        yield* Exit.isSuccess(exit) ? Effect.sync(() => source.releaseLock()) : Effect.promise(() => source.cancel().catch(() => undefined));
      if (pending !== undefined) yield* Effect.promise(() => pending!.catch(() => undefined)).pipe(Effect.timeoutOption(abortGrace));
      yield* Effect.promise(() => server.close().catch(() => undefined));
    }));
    yield* Effect.tryPromise({try: () => server.connect(transport as unknown as Parameters<typeof server.connect>[0]), catch: () => new McpUnavailable()});
    return yield* Effect.tryPromise({try: () => pending = transport.handleRequest(request), catch: () => new McpUnavailable()});
  }).pipe(
    Effect.scoped,
    Effect.catch(error => Effect.succeed(errorResponse(error))),
    Effect.catchDefect(() => Effect.succeed(errorResponse(new McpUnavailable()))),
  );

  // admission and registration are one synchronous step against close(): the request runs in the caller's fiber, and the
  // endpoint's hold on it interrupts that caller while the request is in flight and returns only once the caller ended, so
  // close() and layer release return after every admitted request (and the route's own interrupted answer) ended
  const respond = (request: Request) => Effect.withFiber(caller => {
    if (MutableRef.get(closed)) return Effect.succeed(errorResponse(new McpClosed()));
    const finished = Deferred.makeUnsafe<void>();
    admit(Deferred.await(finished).pipe(Effect.onInterrupt(() => Deferred.isDoneUnsafe(finished) ? Effect.void : Fiber.interrupt(caller))));
    return Effect.ensuring(handle(request), Deferred.succeed(finished, undefined));
  });

  return {
    route: Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const answer = yield* HttpServerRequest.toWeb(request).pipe(
        Effect.matchEffect({onFailure: () => Effect.succeed(errorResponse(new McpUnavailable())), onSuccess: respond}));
      return HttpServerResponse.fromWeb(answer);
    }),
    close,
  } satisfies WorkflowMcpShape;
});

// the workflow mcp endpoint: one stateless mcp server and transport for each http request
export class WorkflowMcp extends Context.Service<WorkflowMcp, WorkflowMcpShape>()("t3-supervisor/WorkflowMcp") {
  // over the given write controller and, when given, the team controller's two tools
  static readonly make = make;
  // the endpoint over the supervision run's write and team controllers; releasing the layer closes it
  static readonly layer: Layer.Layer<WorkflowMcp, never, WorkflowWriteController | SupervisorTeamController> = Layer.effect(WorkflowMcp,
    Effect.gen(function* () {
      return yield* make(yield* WorkflowWriteController, yield* SupervisorTeamController);
    }));
}

// /mcp/workflows for the ui router and the mcp-only router; the host, origin and bearer checks stay in front of it
export const WorkflowMcpRoute = HttpRouter.use(router => Effect.gen(function* () {
  const mcp = yield* WorkflowMcp;
  yield* router.add("*", "/mcp/workflows", mcp.route);
}));

