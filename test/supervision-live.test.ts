import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";
import { appConfig, buildT3Client, fakeT3, runApp } from "./support/g8-app.js";
import { temporaryDirectory } from "./support/g8-auth.js";
import { connectRefused, within } from "./support/g8-process.js";

// target regression of the composition root (plan 3.9, s6c): runGuidanceApplication builds the supervision run's services as
// one layer graph, and its workflow MCP endpoint serves that graph's write and team controllers; interrupting the run
// releases the listeners. live (it.live): the application's real listeners and a loopback T3 peer

type McpBody = {result?: {isError?: boolean; content?: Array<{text?: string}>; tools?: Array<{name: string}>}};

it.live("SUP-LIVE-01: the running application's workflow MCP endpoint lists six tools and answers through the run's own write and team controllers", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporaryDirectory("supervision-live-");
  const peer = yield* fakeT3;
  const config = yield* appConfig(directory, peer.url);
  const app = yield* runApp(config, yield* buildT3Client(peer.url), () => ({projects: [], threads: []}));
  yield* within(app.ready, 5_000, "application readiness");
  const token = (yield* fs.readFileString(join(directory, "access", "workflow-mcp-token"))).trim();
  const client = yield* HttpClient.HttpClient;
  const post = (method: string, params: unknown) => Effect.gen(function* () {
    const response = yield* client.post(`${app.origin}/mcp/workflows`, {
      headers: {Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream"},
      body: HttpBody.text(JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), "application/json")});
    assert.equal(response.status, 200);
    return (yield* response.json) as McpBody;
  }).pipe(Effect.orDie);
  const result = (body: McpBody): unknown => JSON.parse(body.result?.content?.[0]?.text ?? "null");

  const listed = yield* post("tools/list", {});
  assert.deepEqual(listed.result?.tools?.map(tool => tool.name),
    ["workflow_read", "workflow_write", "supervision_start", "supervision_stop", "supervision_team", "supervision_guide"]);
  // each answer is the controller's own typed refusal of the empty arguments, never the route's internal error
  const read = yield* post("tools/call", {name: "workflow_read", arguments: {}});
  assert.equal(read.result?.isError, true);
  assert.deepEqual(result(read), {status: "invalid", reason: "invalid_read_arguments"});
  const team = yield* post("tools/call", {name: "supervision_team", arguments: {}});
  assert.equal(team.result?.isError, true);
  assert.deepEqual(result(team), {status: "invalid", reason: "invalid_team_arguments"});

  yield* app.interrupt;
  assert.equal(yield* connectRefused(app.port), true);
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer))), {timeout: 10_000});
