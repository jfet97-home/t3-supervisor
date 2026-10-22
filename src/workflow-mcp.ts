import {SupervisorTeamController, supervisionTeamToolDefinition, supervisionGuideToolDefinition} from "./supervisor-team-controller.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  WorkflowWriteController,
  supervisionStopToolDefinition,
  supervisionStartToolDefinition,
  workflowReadToolDefinition,
  workflowWriteToolDefinition,
} from "./workflow-write-controller.js";

const maxMcpRequestBodyBytes = 1024 * 1024;
const callTimeoutMs = 9_000;
const serverInfo = {name: "t3-supervisor-workflows", version: "0.1.0"};


const toolResult = (value: unknown): CallToolResult => {
  const result = value as {status?: unknown};
  const isError = result.status === "denied" || result.status === "invalid" || result.status === "unavailable" ||
    result.status === "incompatible" || result.status === "too_large";
  return {
    content: [{type: "text", text: JSON.stringify(value)}],
    ...(isError ? {isError: true} : {}),
  };
};

const writeHttpError = (response: ServerResponse, status: number): void => {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, {"Content-Type": "application/json", "Cache-Control": "no-store"});
  response.end(JSON.stringify({error: status === 503 ? "workflow_mcp_closed" : "workflow_mcp_unavailable"}));
};

export type WorkflowMcpEndpoint = {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
};

/** Creates one stateless MCP server and transport for each HTTP request. */
export const createWorkflowMcpEndpoint = (controller: WorkflowWriteController, team?: SupervisorTeamController): WorkflowMcpEndpoint => {
  const tools = [workflowReadToolDefinition, workflowWriteToolDefinition, supervisionStartToolDefinition, supervisionStopToolDefinition, ...(team ? [supervisionTeamToolDefinition, supervisionGuideToolDefinition] : [])] as unknown as Tool[];
  let closed = false;
  const active = new Map<Server, AbortController>();
  return {
    async handle(request, response) {
      if (closed) {
        writeHttpError(response, 503);
        return;
      }
      const server = new Server(serverInfo, {capabilities: {tools: {}}});
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        maxRequestBodySize: maxMcpRequestBodyBytes,
      });
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      const abortOnResponseClose = () => {
        if (!response.writableEnded) abortRequest();
      };
      request.once("aborted", abortRequest);
      response.once("close", abortOnResponseClose);
      server.setRequestHandler(ListToolsRequestSchema, () => ({tools}));
      server.setRequestHandler(CallToolRequestSchema, async requestValue => {
        const {name, arguments: args} = requestValue.params;
        const signal = AbortSignal.any([requestController.signal, AbortSignal.timeout(callTimeoutMs)]);
        if (name === "workflow_read") return toolResult(await controller.readTool(args, signal));
        if (name === "workflow_write") return toolResult(await controller.write(args, signal));
        if (name === "supervision_start") return toolResult(await controller.startSupervision(args, signal));
        if (name === "supervision_stop") return toolResult(await controller.stopSupervision(args, signal));
        if (name === "supervision_team" && team) return toolResult(await team.call(args, signal));
        if (name === "supervision_guide" && team) return toolResult(await team.guide(args, signal));
        return toolResult({status: "invalid", reason: "unknown_tool"});
      });
      active.set(server, requestController);
      try {
        await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
        await transport.handleRequest(request, response);
      } catch {
        writeHttpError(response, 500);
      } finally {
        active.delete(server);
        request.removeListener("aborted", abortRequest);
        response.removeListener("close", abortOnResponseClose);
        await server.close().catch(() => undefined);
      }
    },
    async close() {
      closed = true;
      for (const abort of active.values()) abort.abort();
      await Promise.all([...active.keys()].map(server => server.close().catch(() => undefined)));
    },
  };
};
