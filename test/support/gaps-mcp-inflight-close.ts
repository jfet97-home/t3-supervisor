import {createServer} from "node:http";
import {createInterface} from "node:readline";
import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Layer, Scope } from "effect";
import { HttpRouter } from "effect/http";
import {WorkflowMcp, WorkflowMcpRoute} from "../../src/workflow-mcp.js";
import {promiseWorkflowController, workflowMcpLayer} from "./mcp-controllers.js";

// isolated runner for the in-flight half of CT-MCP-04: the endpoint's route is served through effect's node server on
// this process's own node:http server, and a request is handled until its server chain, answer write included, ends.
// stdout carries one json event per line; stdin carries "close-endpoint" and "close-server" commands.

const emit = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

let toolSignal: AbortSignal | undefined;
let toolReturned = false;
const controller = promiseWorkflowController({
  readTool: async (_args: unknown, signal: AbortSignal) => {
    toolSignal = signal;
    emit({event: "entered", aborted: signal.aborted});
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true}));
    toolReturned = true;
    return {status: "unavailable", reason: (signal.reason as {name?: string}).name};
  },
});

let handleSettled = false;
let handles = 0;
const server = createServer();
const handle = <A, E, R>(request: Effect.Effect<A, E, R>) => Effect.suspend(() => {
  handles++;
  return Effect.ensuring(request, Effect.sync(() => {handleSettled = true;}));
});
// the layer scope lives as long as this process; close-server closes the node server underneath it
const context = await Effect.runPromise(Layer.buildWithScope(HttpRouter.serve(WorkflowMcpRoute, {disableLogger: true, disableListenLog: true, middleware: handle}).pipe(
  Layer.provideMerge(workflowMcpLayer(controller)),
  Layer.provideMerge(NodeHttpServer.layerServer(() => server, {port: 0, host: "127.0.0.1", disablePreemptiveShutdown: true})),
), Scope.makeUnsafe()));
const mcp = Context.get(context, WorkflowMcp);
const endpoint = {close: () => Effect.runPromise(mcp.close)};
const address = server.address();
emit({event: "listening", port: typeof address === "object" && address !== null ? address.port : 0});

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

const lines = createInterface({input: process.stdin});
lines.on("line", line => {
  if (line === "close-endpoint") {
    void endpoint.close().then(async () => {
      await nextTurn();
      emit({
        event: "endpoint-closed",
        aborted: toolSignal?.aborted ?? false,
        reason: (toolSignal?.reason as {name?: string} | undefined)?.name ?? null,
        toolReturned,
        handleSettled,
      });
    });
  } else if (line === "close-server") {
    server.closeAllConnections();
    server.close(error => {
      void nextTurn().then(() => {
        emit({event: "server-closed", error: error?.message ?? null, handles, handleSettled});
        lines.close();
      });
    });
  }
});
