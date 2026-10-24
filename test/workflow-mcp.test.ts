import assert from "node:assert/strict";
import {createServer} from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import {WorkflowMcpRoute} from "../src/workflow-mcp.js";
import { buildInfo } from "../src/version.js";
import type {WorkflowWriteController, WorkflowWriteResult, WorkflowReadResult} from "../src/workflow-write-controller.js";
import {promiseWorkflowController, workflowMcpLayer} from "./support/mcp-controllers.js";
import {applyArgs, ensureArgs, installEvidence, locator, makeFixture, planEntities, sequencePlan} from "./support/wwc-fixture.js";

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

// serves the mcp route through a node server on a loopback port 0 with the controller stub as the endpoint's layer;
// the test scope closes the endpoint and the server
const serveMcp = (controller: WorkflowWriteController["Service"]) => Effect.gen(function* () {
  const context = yield* Layer.build(HttpRouter.serve(WorkflowMcpRoute, {disableLogger: true, disableListenLog: true}).pipe(
    Layer.provide(workflowMcpLayer(controller)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, {port: 0, host: "127.0.0.1"})),
  ));
  const address = Context.get(context, HttpServer.HttpServer).address;
  assert.ok(address._tag === "InetAddressV4");
  return {port: address.port};
});

it.live("workflow MCP exposes read, write and the scoped stop tool and serves stateless JSON calls", () => Effect.gen(function* () {
  const invalidWrite = {status: "invalid", reason: "pinned_definition_context_mismatch", diagnostic: {
    code: "local_step_definition_id_required", path: "/input/plan/nodes/0/definitionId", expected: "definitionId: null",
  }};
  const controller = promiseWorkflowController({
    readTool: async (args: unknown) => ({status: "ok", received: args}),
    write: async () => invalidWrite,
    stopSupervision: async (args: unknown) => ({status: "denied", reason: "user_message_not_genuine", received: args}),
  });
  const address = yield* serveMcp(controller);
  const url = `http://127.0.0.1:${address.port}/mcp/workflows`;
  const initialized = yield* Effect.promise(() => postJson(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {name: "workflow-mcp-test", version: "1"},
    },
  }));
  assert.equal(initialized.status, 200);
  const initialization = (yield* Effect.promise(() => initialized.json())) as {result?: {serverInfo?: {name: string; version: string}}};
  assert.deepEqual(initialization.result?.serverInfo, {name: "t3-supervisor-workflows", version: buildInfo.version});
  const tools = yield* Effect.promise(() => postJson(url, {jsonrpc: "2.0", id: 2, method: "tools/list", params: {}}));
  assert.equal(tools.status, 200);
  const listBody = (yield* Effect.promise(() => tools.json())) as {result?: {tools?: Array<{name: string; inputSchema?: {
    $defs?: Record<string, unknown>;
    properties?: Record<string, WorkflowJsonSchema>;
  }}>}};
  assert.deepEqual(listBody.result?.tools?.map(tool => tool.name), ["workflow_read", "workflow_write", "supervision_start", "supervision_stop", "supervision_interpretation_submit"]);
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
  const called = yield* Effect.promise(() => postJson(url, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {name: "workflow_read", arguments: args},
  }));
  assert.equal(called.status, 200);
  const callBody = (yield* Effect.promise(() => called.json())) as {result?: {content?: Array<{text?: string}>}};
  assert.deepEqual(JSON.parse(callBody.result?.content?.[0]?.text ?? "null"), {status: "ok", received: args});

  const invalid = yield* Effect.promise(() => postJson(url, {
    jsonrpc: "2.0", id: 4, method: "tools/call", params: {name: "workflow_write", arguments: args},
  }));
  assert.equal(invalid.status, 200);
  const invalidBody = (yield* Effect.promise(() => invalid.json())) as {result?: {isError?: boolean; content?: Array<{text?: string}>}};
  assert.equal(invalidBody.result?.isError, true);
  assert.deepEqual(JSON.parse(invalidBody.result?.content?.[0]?.text ?? "null"), invalidWrite);
}));

it.live("separate skills reach the real write controller through HTTP MCP and malformed objects make no native contact", () => Effect.gen(function* () {
  const f = yield* makeFixture();
  yield* Effect.addFinalizer(() => f.close);
  const {port} = yield* serveMcp(f.controller);
  let requestId = 0;
  const call = <T = WorkflowWriteResult>(name: string, args: unknown) => Effect.gen(function* () {
    const response = yield* Effect.promise(() => postJson(`http://127.0.0.1:${port}/mcp/workflows`, {
      jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: {name, arguments: args},
    }));
    assert.equal(response.status, 200);
    const body = (yield* Effect.promise(() => response.json())) as {result?: {content?: Array<{text?: string}>}};
    return JSON.parse(body.result?.content?.[0]?.text ?? "null") as T;
  });
  const ensure = ensureArgs(f, "http-skills-create", "Prepare a source-bound draft.");
  installEvidence(f, ensure);
  const created = yield* call("workflow_write", ensure);
  assert(created.status === "created");
  const skills = [".claude/skills/testing/SKILL.md", "plugin:testing"];
  const args = yield* applyArgs(f, {operationId: "http-skills-apply", workflowId: created.workflowId, expectedRevision: created.revision,
    plan: sequencePlan([{kind: "step", definitionId: null, localId: "verify", name: "Verify", description: "Check the task.",
      references: ["docs/testing.md"], skills, reason: "The task needs verification."}]), note: "Record supporting guidance."});
  installEvidence(f, args);
  assert.equal((yield* call("workflow_write", args)).status, "applied");
  const read = yield* call<WorkflowReadResult>("workflow_read", {...locator(f), limit: 10});
  assert.equal(read.status, "ok");
  assert(read.status === "ok");
  const saved = planEntities(read.workflows[0]!.document.plan)[0]!;
  assert.deepEqual(saved.references, ["docs/testing.md"]);
  assert.deepEqual(saved.skills, skills);
  const before = {...f.calls, projection: [...f.calls.projection], detail: [...f.calls.detail]};
  const invalid = structuredClone(args);
  Object.assign(invalid.input.plan?.nodes[0] ?? {}, {skills: [{skill: {scope: "global", name: "plugin:testing"}}]});
  const result = yield* call("workflow_write", invalid);
  assert.equal(result.status, "invalid");
  assert.deepEqual(f.calls, before);
}));

it.live("workflow MCP rejects requests above its HTTP body bound", () => Effect.gen(function* () {
  const controller = promiseWorkflowController({write: async () => ({status: "created"})});
  const address = yield* serveMcp(controller);
  const response = yield* Effect.promise(() => postJson(`http://127.0.0.1:${address.port}/mcp/workflows`, {
    jsonrpc: "2.0", id: 4, method: "tools/list", params: {}, padding: "x".repeat(1024 * 1024),
  }));
  assert.ok(response.status === 413 || response.status === 400);
  yield* Effect.promise(async () => response.body?.cancel());
}), { timeout: 60_000 });
