import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Context, Effect, Layer, Stdio, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { WorkflowMcp, WorkflowMcpRoute } from "../../src/workflow-mcp.js";
import { workflowMcpLayer } from "./mcp-controllers.js";
import { effectWorkflowController, gateTool } from "./g8-mcp.js";
import { loopTurn } from "./g8-process.js";

// isolated runner for the in-flight half of CT-MCP-04 (test/workflow-mcp.characterization.test.ts): the endpoint's route is
// served through effect's node server on this process's own node:http server, and a request is handled until its server
// chain, answer write included, ends. stdout carries one json event per line; stdin carries "close-endpoint" and
// "close-server" commands. the process ends by itself once stdin ends after them

const emit = (event: Record<string, unknown>) => Effect.sync(() => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
});

const program = Effect.gen(function* () {
  const gate = gateTool({onEnter: (aborted) => emit({event: "entered", aborted})});
  let handleSettled = false;
  let handles = 0;
  const server = createServer();
  const handle = <A, E, R>(request: Effect.Effect<A, E, R>) => Effect.suspend(() => {
    handles++;
    return Effect.ensuring(request, Effect.sync(() => {handleSettled = true;}));
  });
  // close-server closes the node server underneath the layer; the layer itself is released when the program ends
  const context = yield* Layer.build(HttpRouter.serve(WorkflowMcpRoute, {disableLogger: true, disableListenLog: true, middleware: handle}).pipe(
    Layer.provideMerge(workflowMcpLayer(effectWorkflowController({readTool: gate.tool}))),
    Layer.provideMerge(NodeHttpServer.layerServer(() => server, {port: 0, host: "127.0.0.1", disablePreemptiveShutdown: true})),
  ));
  const mcp = Context.get(context, WorkflowMcp);
  const address = server.address();
  yield* emit({event: "listening", port: typeof address === "object" && address !== null ? address.port : 0});

  const stdio = yield* Stdio.Stdio;
  yield* stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach((line) => {
    if (line === "close-endpoint") return Effect.gen(function* () {
      yield* mcp.close;
      yield* loopTurn;
      const aborted = yield* gate.aborted;
      yield* emit({
        event: "endpoint-closed",
        aborted,
        reason: aborted ? (yield* gate.ended).reason : null,
        toolReturned: gate.returned(),
        handleSettled,
      });
    });
    if (line === "close-server") return Effect.gen(function* () {
      server.closeAllConnections();
      const error = yield* Effect.callback<Error | undefined>((resume) => {
        server.close((closed) => resume(Effect.succeed(closed)));
      });
      yield* loopTurn;
      yield* emit({event: "server-closed", error: error?.message ?? null, handles, handleSettled});
    });
    return Effect.void;
  }));
}).pipe(Effect.scoped);

NodeRuntime.runMain(program.pipe(Effect.orDie, Effect.provide(NodeStdio.layer)));
