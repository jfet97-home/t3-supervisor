import {SupervisorTeamController, supervisionTeamToolDefinition, supervisionGuideToolDefinition} from "./supervisor-team-controller.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Context, Data, Effect, Exit, Fiber, FiberSet, Layer, Ref, Scope } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  WorkflowWriteController,
  supervisionStopToolDefinition,
  supervisionStartToolDefinition,
  workflowReadToolDefinition,
  workflowWriteToolDefinition,
} from "./workflow-write-controller.js";

// the sdk's stateless streamable http transport stays a scoped adapter inside this effect route (plan 3.7, d-03): effect's
// McpServer is sessionful, and the sdk calls promise tool callbacks, which run their effects through a FiberSet (o-06)

const maxMcpRequestBodyBytes = 1024 * 1024;
const callDeadline = "9 seconds";
const serverInfo = {name: "t3-supervisor-workflows", version: "0.1.0"};

// the endpoint is closed: every later request is answered 503 workflow_mcp_closed
export class McpClosed extends Data.TaggedError("McpClosed") {}
// the sdk server or transport failed before it answered: 500 workflow_mcp_unavailable
export class McpUnavailable extends Data.TaggedError("McpUnavailable") {}

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

type ToolCall = (signal: AbortSignal) => Promise<unknown>;

// the controller answers with its own settled result: the 9 s deadline aborts its signal with a TimeoutError and the web
// request's own abort aborts it too, while interrupting the call aborts the signal and drops the result
const settle = (call: ToolCall, requestSignal: AbortSignal) => Effect.gen(function* () {
  const deadline = new AbortController();
  const pending = yield* Effect.forkChild(Effect.promise(signal => call(AbortSignal.any([signal, deadline.signal, requestSignal]))));
  return yield* Fiber.join(pending).pipe(
    Effect.timeout(callDeadline),
    Effect.catchTag("TimeoutError", () => Effect.andThen(
      Effect.sync(() => deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"))),
      Fiber.join(pending),
    )),
  );
});

export interface WorkflowMcpShape {
  // answers one web request through a fresh stateless sdk server and transport; failures become 503 or 500 answers
  readonly respond: (request: Request) => Effect.Effect<Response>;
  // the /mcp/workflows handler: interrupting its request fiber (client disconnect) interrupts the request's calls
  readonly route: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>;
  // answers every later request 503 and interrupts the in-flight calls, whose requests stay unanswered
  readonly close: Effect.Effect<void>;
}

const make = Effect.fnUntraced(function* (controller: WorkflowWriteController, team?: SupervisorTeamController) {
  const tools = [workflowReadToolDefinition, workflowWriteToolDefinition, supervisionStartToolDefinition, supervisionStopToolDefinition, ...(team ? [supervisionTeamToolDefinition, supervisionGuideToolDefinition] : [])] as unknown as Tool[];
  const calls = yield* FiberSet.make<CallToolResult, never>();
  const closed = yield* Ref.make(false);
  const toolCall = (name: string, args: unknown): ToolCall | undefined => {
    if (name === "workflow_read") return signal => controller.readTool(args, signal);
    if (name === "workflow_write") return signal => controller.write(args, signal);
    if (name === "supervision_start") return signal => controller.startSupervision(args, signal);
    if (name === "supervision_stop") return signal => controller.stopSupervision(args, signal);
    if (name === "supervision_team" && team) return signal => team.call(args, signal);
    if (name === "supervision_guide" && team) return signal => team.guide(args, signal);
    return undefined;
  };
  const serve = (request: Request) => Effect.gen(function* () {
    if (yield* Ref.get(closed)) return yield* new McpClosed();
    // the sdk's promise callbacks fork their calls into the set with the request fiber's context
    const run = yield* FiberSet.runtimePromise(calls)();
    const closeServer = (server: Server) => Effect.promise(() => server.close().catch(() => undefined));
    const server = yield* Effect.acquireRelease(Effect.sync(() => new Server(serverInfo, {capabilities: {tools: {}}})), closeServer);
    server.setRequestHandler(ListToolsRequestSchema, () => ({tools}));
    // closing the sdk server (request scope release) aborts extra.signal and so interrupts the call; an interrupted call
    // closes the sdk server, which then discards the call's answer
    server.setRequestHandler(CallToolRequestSchema, (call, extra) => {
      const start = toolCall(call.params.name, call.params.arguments);
      if (!start) return toolResult({status: "invalid", reason: "unknown_tool"});
      return run(settle(start, request.signal).pipe(Effect.map(toolResult), Effect.onInterrupt(() => closeServer(server))), {signal: extra.signal});
    });
    const transport = new WebStandardStreamableHTTPServerTransport({enableJsonResponse: true, maxRequestBodySize: maxMcpRequestBodyBytes});
    yield* Effect.tryPromise({try: () => server.connect(transport as unknown as Parameters<typeof server.connect>[0]), catch: () => new McpUnavailable()});
    return yield* Effect.tryPromise({try: () => transport.handleRequest(request), catch: () => new McpUnavailable()});
  }).pipe(Effect.scoped, Effect.catch(error => Effect.succeed(errorResponse(error))));
  return {
    respond: serve,
    route: Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const answer = yield* HttpServerRequest.toWeb(request).pipe(
        Effect.matchEffect({onFailure: () => Effect.succeed(errorResponse(new McpUnavailable())), onSuccess: serve}));
      return HttpServerResponse.fromWeb(answer);
    }),
    close: Effect.andThen(Ref.set(closed, true), FiberSet.clear(calls)),
  } satisfies WorkflowMcpShape;
});

// the workflow mcp endpoint: one stateless mcp server and transport for each http request
export class WorkflowMcp extends Context.Service<WorkflowMcp, WorkflowMcpShape>()("t3-supervisor/WorkflowMcp") {
  static readonly make = make;
  // releasing the layer interrupts the in-flight calls
  static readonly layer = (controller: WorkflowWriteController, team?: SupervisorTeamController): Layer.Layer<WorkflowMcp> =>
    Layer.effect(WorkflowMcp, make(controller, team));
}

// /mcp/workflows for the ui router and the mcp-only router; the host, origin and bearer checks stay in front of it
export const WorkflowMcpRoute = HttpRouter.use(router => Effect.gen(function* () {
  const mcp = yield* WorkflowMcp;
  yield* router.add("*", "/mcp/workflows", mcp.route);
}));

export type WorkflowMcpEndpoint = {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
};

// reads the node body up to one byte past the bound, so the sdk itself answers an oversized body 413; a declared oversized
// length is left unread for the sdk to refuse, and the rest of an oversized body is drained
const webRequest = async (request: IncomingMessage, signal: AbortSignal): Promise<Request> => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers))
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
  const method = request.method ?? "GET";
  const init: RequestInit = {method, headers, signal};
  if (method !== "GET" && method !== "HEAD" && !(Number(request.headers["content-length"]) > maxMcpRequestBodyBytes)) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request.iterator({destroyOnReturn: false})) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(part);
      size += part.length;
      if (size > maxMcpRequestBodyBytes) {request.resume();break;}
    }
    init.body = Buffer.concat(chunks);
  }
  return new Request(new URL(request.url ?? "/", "http://127.0.0.1"), init);
};

const writeAnswer = async (response: ServerResponse, answer: Response): Promise<void> => {
  const body = Buffer.from(await answer.arrayBuffer());
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  response.end(body);
};

// temporary node adapter (plan 3.9) for the unported ui server and its suites until the routers mount WorkflowMcpRoute;
// a client disconnect aborts the request's web signal, so an aborted call still answers and handle() settles as at baseline
export const createWorkflowMcpEndpoint = (controller: WorkflowWriteController, team?: SupervisorTeamController): WorkflowMcpEndpoint => {
  const scope = Scope.makeUnsafe();
  const mcp = Effect.runSync(Scope.provide(make(controller, team), scope));
  return {
    async handle(request, response) {
      const disconnected = new AbortController();
      const disconnect = () => {
        if (!response.writableEnded) disconnected.abort();
      };
      response.once("close", disconnect);
      try {
        await writeAnswer(response, await Effect.runPromise(mcp.respond(await webRequest(request, disconnected.signal))));
      } catch {
        await writeAnswer(response, errorResponse(new McpUnavailable()));
      } finally {
        response.removeListener("close", disconnect);
      }
    },
    close: () => Effect.runPromise(Effect.andThen(mcp.close, Scope.close(scope, Exit.void))),
  };
};
