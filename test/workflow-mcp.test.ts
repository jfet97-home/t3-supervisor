import assert from "node:assert/strict";
import {createServer} from "node:http";
import {test} from "node:test";
import {createWorkflowMcpEndpoint} from "../src/workflow-mcp.js";
import type {WorkflowWriteController} from "../src/workflow-write-controller.js";

type WorkflowJsonSchema = {
  $ref?: string;
  type?: string;
  anyOf?: WorkflowJsonSchema[];
  required?: string[];
  properties?: Record<string, WorkflowJsonSchema>;
  items?: WorkflowJsonSchema;
};

const postJson = async (url: string, body: unknown): Promise<Response> => fetch(url, {
  method: "POST",
  headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream"},
  body: JSON.stringify(body),
});

test("workflow MCP exposes only read/write tools and serves stateless JSON calls", async () => {
  const invalidWrite = {status: "invalid", reason: "pinned_definition_context_mismatch", diagnostic: {
    code: "local_step_definition_id_required", path: "/input/plan/nodes/0/definitionId", expected: "definitionId: null",
  }};
  const controller = {
    read: async (args: unknown) => ({status: "ok", received: args}),
    write: async () => invalidWrite,
  } as unknown as WorkflowWriteController;
  const endpoint = createWorkflowMcpEndpoint(controller);
  const server = createServer((request, response) => {void endpoint.handle(request, response);});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp/workflows`;
  try {
    const initialized = await postJson(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {name: "workflow-mcp-test", version: "1"},
      },
    });
    assert.equal(initialized.status, 200);
    const tools = await postJson(url, {jsonrpc: "2.0", id: 2, method: "tools/list", params: {}});
    assert.equal(tools.status, 200);
    const listBody = await tools.json() as {result?: {tools?: Array<{name: string; inputSchema?: {
      $defs?: Record<string, unknown>;
      properties?: Record<string, WorkflowJsonSchema>;
    }}>}};
    assert.deepEqual(listBody.result?.tools?.map(tool => tool.name), ["workflow_read", "workflow_write"]);
    const writeSchema = listBody.result?.tools?.find(tool => tool.name === "workflow_write")?.inputSchema;
    assert.deepEqual(writeSchema?.properties?.input?.required, ["operationId", "workflowId", "expectedRevision", "note"]);
    assert.ok(writeSchema?.$defs?.group, "recursive plan definitions are attached to the write schema root");
    assert.ok(writeSchema?.properties?.input?.properties?.plan?.anyOf?.some(item => item.$ref === "#/$defs/group"));
    const sourceBindingSchema = writeSchema?.properties?.input?.properties?.sourceBinding;
    assert.ok(sourceBindingSchema?.required?.includes("sourceHash"));
    assert.equal(sourceBindingSchema?.properties?.sourceHash?.type, "string");
    const activityEvidenceSchema = writeSchema?.properties?.input?.properties?.evidence?.items?.properties;
    for (const key of ["sourceThreadId", "sourceRunId", "sourceMessageId", "sourceItemId"]) {
      assert.ok(activityEvidenceSchema?.[key]?.anyOf?.some(item => item.type === "string"));
      assert.ok(activityEvidenceSchema?.[key]?.anyOf?.some(item => item.type === "null"));
    }

    const args = {supervisorThreadId: "sx-current", bindingGeneration: 7};
    const called = await postJson(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {name: "workflow_read", arguments: args},
    });
    assert.equal(called.status, 200);
    const callBody = await called.json() as {result?: {content?: Array<{text?: string}>}};
    assert.deepEqual(JSON.parse(callBody.result?.content?.[0]?.text ?? "null"), {status: "ok", received: args});

    const invalid = await postJson(url, {
      jsonrpc: "2.0", id: 4, method: "tools/call", params: {name: "workflow_write", arguments: args},
    });
    assert.equal(invalid.status, 200);
    const invalidBody = await invalid.json() as {result?: {isError?: boolean; content?: Array<{text?: string}>}};
    assert.equal(invalidBody.result?.isError, true);
    assert.deepEqual(JSON.parse(invalidBody.result?.content?.[0]?.text ?? "null"), invalidWrite);
  } finally {
    await endpoint.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("workflow MCP rejects requests above its HTTP body bound", async () => {
  const controller = {read: async () => ({status: "ok"}), write: async () => ({status: "created"})} as unknown as WorkflowWriteController;
  const endpoint = createWorkflowMcpEndpoint(controller);
  const server = createServer((request, response) => {void endpoint.handle(request, response);});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await postJson(`http://127.0.0.1:${address.port}/mcp/workflows`, {
      jsonrpc: "2.0", id: 4, method: "tools/list", params: {}, padding: "x".repeat(1024 * 1024),
    });
    assert.ok(response.status === 413 || response.status === 400);
  } finally {
    await endpoint.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
