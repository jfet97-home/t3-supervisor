import {createServer} from "node:http";
import {createInterface} from "node:readline";
import {createWorkflowMcpEndpoint} from "../../src/workflow-mcp.js";
import type {WorkflowWriteController} from "../../src/workflow-write-controller.js";

// isolated runner for the in-flight half of CT-MCP-04: the unsettled handle() promise ends with this process.
// stdout carries one json event per line; stdin carries "close-endpoint" and "close-server" commands.

const emit = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

let toolSignal: AbortSignal | undefined;
let toolReturned = false;
const controller = {
  readTool: async (_args: unknown, signal: AbortSignal) => {
    toolSignal = signal;
    emit({event: "entered", aborted: signal.aborted});
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true}));
    toolReturned = true;
    return {status: "unavailable", reason: (signal.reason as {name?: string}).name};
  },
} as unknown as WorkflowWriteController;

const endpoint = createWorkflowMcpEndpoint(controller);
let handleSettled = false;
let handles = 0;
const server = createServer((request, response) => {
  handles++;
  void endpoint.handle(request, response).finally(() => {handleSettled = true;});
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  emit({event: "listening", port: typeof address === "object" && address !== null ? address.port : 0});
});

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
