import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "vitest";
import { connectRefused, within } from "./support/c3b-http.js";
import { appConfig, buildT3Client, runApp, startFakeT3 } from "./support/c3b-app.js";
import { tempDirectory } from "./support/c3b-ui.js";

// target regression of the composition root (plan 3.9, s6c): runGuidanceApplication builds the supervision run's services as
// one layer graph, and its workflow MCP endpoint serves that graph's write and team controllers; interrupting the run
// releases the listeners

type McpBody = {result?: {isError?: boolean; content?: Array<{text?: string}>; tools?: Array<{name: string}>}};

it("SUP-LIVE-01: the running application's workflow MCP endpoint lists six tools and answers through the run's own write and team controllers", {timeout: 10_000}, async t => {
  const directory = await tempDirectory(t, "supervision-live-");
  const peer = await startFakeT3(t);
  const config = await appConfig(directory, peer.url);
  const app = runApp(t, config, await buildT3Client(peer.url), () => ({projects: [], threads: []}));
  await within(app.ready, 5_000, "application readiness");
  const token = (await readFile(join(directory, "access", "workflow-mcp-token"), "utf8")).trim();
  const post = async (method: string, params: unknown): Promise<McpBody> => {
    const response = await fetch(`${app.origin}/mcp/workflows`, {method: "POST",
      headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})});
    assert.equal(response.status, 200);
    return await response.json() as McpBody;
  };
  const result = (body: McpBody): unknown => JSON.parse(body.result?.content?.[0]?.text ?? "null");

  const listed = await post("tools/list", {});
  assert.deepEqual(listed.result?.tools?.map(tool => tool.name),
    ["workflow_read", "workflow_write", "supervision_start", "supervision_stop", "supervision_team", "supervision_guide"]);
  // each answer is the controller's own typed refusal of the empty arguments, never the route's internal error
  const read = await post("tools/call", {name: "workflow_read", arguments: {}});
  assert.equal(read.result?.isError, true);
  assert.deepEqual(result(read), {status: "invalid", reason: "invalid_read_arguments"});
  const team = await post("tools/call", {name: "supervision_team", arguments: {}});
  assert.equal(team.result?.isError, true);
  assert.deepEqual(result(team), {status: "invalid", reason: "invalid_team_arguments"});

  await app.interrupt();
  assert.equal(await connectRefused(app.port), true);
});
