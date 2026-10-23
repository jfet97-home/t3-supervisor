import assert from "node:assert/strict";
import {createServer, request as httpRequest, type IncomingMessage} from "node:http";
import {fileURLToPath} from "node:url";
import { NodeHttpServer } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpRouter, HttpServer, type HttpClientResponse } from "effect/http";
import {WorkflowMcp, WorkflowMcpRoute} from "../src/workflow-mcp.js";
import type {SupervisorTeamController} from "../src/supervisor-team-controller.js";
import type {WorkflowWriteController} from "../src/workflow-write-controller.js";
import {workflowMcpLayer} from "./support/mcp-controllers.js";
import {effectTeamController, effectWorkflowController, gateTool} from "./support/g8-mcp.js";
import {nodePath, repositoryRoot} from "./support/cli-process.js";
import {startProcess, within} from "./support/g8-process.js";

// the workflow MCP route over a real loopback listener, and in one case a runner process: live (it.live), the 9 s call
// deadline included, every awaited event bounded on the live clock

// serves the endpoint's route through effect's node server on its own loopback port; each request is handled until its
// server chain, answer write included, ends. the test's scope closes the endpoint, waits for every handling and then
// releases the server
const serve = (controller: WorkflowWriteController["Service"], team?: SupervisorTeamController["Service"]) => Effect.gen(function* () {
  const handled = new Set<Deferred.Deferred<void>>();
  const track = <A, E, R>(request: Effect.Effect<A, E, R>) => Effect.suspend(() => {
    const settled = Deferred.makeUnsafe<void>();
    handled.add(settled);
    return Effect.ensuring(request, Effect.sync(() => {
      handled.delete(settled);
      Deferred.doneUnsafe(settled, Exit.void);
    }));
  });
  const context = yield* Layer.build(HttpRouter.serve(WorkflowMcpRoute, {disableLogger: true, disableListenLog: true, middleware: track}).pipe(
    Layer.provideMerge(workflowMcpLayer(controller, team)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, {port: 0, host: "127.0.0.1"})),
  ));
  const address = Context.get(context, HttpServer.HttpServer).address;
  assert.ok(address._tag === "InetAddressV4");
  const mcp = Context.get(context, WorkflowMcp);
  // every handling still in flight
  const settled = Effect.suspend(() => Effect.forEach([...handled], Deferred.await, {discard: true}));
  yield* Effect.addFinalizer(() => Effect.andThen(mcp.close, settled));
  return {url: `http://127.0.0.1:${address.port}/mcp/workflows`, port: address.port, handled, settled, endpoint: {close: mcp.close}};
});

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  return yield* client.post(url, {
    headers: {Accept: "application/json, text/event-stream", ...headers},
    body: HttpBody.text(JSON.stringify(body), "application/json"),
  });
}).pipe(Effect.orDie);

const json = (response: HttpClientResponse.HttpClientResponse) => Effect.orDie(response.json);
// a response's body read to its end
const drained = (response: HttpClientResponse.HttpClientResponse) => Effect.asVoid(Effect.orDie(response.text));
const header = (response: HttpClientResponse.HttpClientResponse, name: string): string | null => response.headers[name] ?? null;

const callText = (body: {result?: {content?: Array<{text?: string}>}}): unknown => JSON.parse(body.result?.content?.[0]?.text ?? "null");

it.live("CT-MCP-02: tools/list without initialize or session header succeeds statelessly and no response carries Mcp-Session-Id", () => Effect.gen(function* () {
  const controller = effectWorkflowController({readTool: (args: unknown) => Effect.succeed({status: "ok", received: args})});
  const {url} = yield* serve(controller);

  const listed = yield* postJson(url, {jsonrpc: "2.0", id: 1, method: "tools/list", params: {}});
  assert.equal(listed.status, 200);
  assert.equal(header(listed, "mcp-session-id"), null);
  assert.match(header(listed, "content-type") ?? "", /^application\/json/u);
  const listBody = (yield* json(listed)) as {jsonrpc?: string; id?: number; result?: {tools?: Array<{name: string}>}};
  assert.equal(listBody.jsonrpc, "2.0");
  assert.equal(listBody.id, 1);
  assert.deepEqual(listBody.result?.tools?.map(tool => tool.name), ["workflow_read", "workflow_write", "supervision_start", "supervision_stop", "supervision_interpretation_submit"]);

  // a tools/call without initialize is served the same way
  const called = yield* postJson(url, {jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "workflow_read", arguments: {probe: 1}}});
  assert.equal(called.status, 200);
  assert.equal(header(called, "mcp-session-id"), null);
  assert.deepEqual(callText((yield* json(called)) as {result?: {content?: Array<{text?: string}>}}), {status: "ok", received: {probe: 1}});

  // initialize also yields no session identity, and an unknown session header is not validated
  const initialized = yield* postJson(url, {jsonrpc: "2.0", id: 3, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "workflow-mcp-characterization", version: "1"},
  }});
  assert.equal(initialized.status, 200);
  assert.equal(header(initialized, "mcp-session-id"), null);
  yield* drained(initialized);
  const foreignSession = yield* postJson(url, {jsonrpc: "2.0", id: 4, method: "tools/list", params: {}}, {"Mcp-Session-Id": "not-issued"});
  assert.equal(foreignSession.status, 200);
  assert.equal(header(foreignSession, "mcp-session-id"), null);
  yield* drained(foreignSession);
}).pipe(Effect.provide(FetchHttpClient.layer)), {timeout: 10_000});

// one raw POST whose connection the test can drop; the scope drops it unless the test already did
const rawCall = (port: number, body: string) => Effect.acquireRelease(Effect.sync(() => {
  const client = httpRequest({host: "127.0.0.1", port, path: "/mcp/workflows", method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(body),
  }});
  return client;
}), (client) => Effect.sync(() => client.destroy()));

it.live("CT-MCP-03: a client disconnect during a slow tool call aborts the controller signal", () => Effect.gen(function* () {
  const gate = gateTool();
  const controller = effectWorkflowController({readTool: gate.tool});
  const {port, handled, settled} = yield* serve(controller);

  const body = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
  const client = yield* rawCall(port, body);
  const clientClosed = Deferred.makeUnsafe<void>();
  client.once("close", () => Deferred.doneUnsafe(clientClosed, Exit.void));
  client.on("error", () => undefined);
  client.end(body);

  const enteredAt = yield* within(gate.entered, 5_000, "tool call entry");
  assert.equal(yield* gate.aborted, false);
  assert.equal(handled.size, 1);
  client.destroy();
  const aborted = yield* within(gate.ended, 5_000, "controller signal abort");
  assert.equal(aborted.reason, "AbortError");
  assert.ok(aborted.at - enteredAt < 5_000);
  yield* within(Deferred.await(clientClosed), 5_000, "client close");
  // the request handler settles once the aborted call returns
  yield* within(settled, 5_000, "handler settlement");
  assert.equal(handled.size, 0);
}), {timeout: 10_000});

it.live("CT-MCP-03: the hard-coded 9 s call deadline aborts the controller signal and the call returns its result", () => Effect.gen(function* () {
  const gate = gateTool();
  const controller = effectWorkflowController({readTool: gate.tool});
  const {url} = yield* serve(controller);

  const response = yield* Effect.forkScoped(postJson(url, {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}}));
  const enteredAt = yield* within(gate.entered, 5_000, "tool call entry");
  const aborted = yield* within(gate.ended, 20_000, "9 s call deadline");
  assert.equal(aborted.reason, "TimeoutError");
  const elapsed = aborted.at - enteredAt;
  assert.ok(elapsed >= 8_900 && elapsed < 12_000, `deadline fired after ${Math.round(elapsed)} ms`);

  const answered = yield* within(Fiber.join(response), 5_000, "response after deadline");
  assert.equal(answered.status, 200);
  const answeredBody = (yield* json(answered)) as {result?: {isError?: boolean; content?: Array<{text?: string}>}};
  assert.equal(answeredBody.result?.isError, true);
  assert.deepEqual(callText(answeredBody), {status: "unavailable", reason: "TimeoutError"});
}).pipe(Effect.provide(FetchHttpClient.layer)), {timeout: 60_000});

it.live("CT-MCP-04: after endpoint.close() every POST is answered 503 workflow_mcp_closed without reaching the controller", () => Effect.gen(function* () {
  let calls = 0;
  const controller = effectWorkflowController({readTool: () => Effect.sync(() => {calls++;return {status: "ok"};})});
  const {url, handled, settled, endpoint} = yield* serve(controller);

  const open = yield* postJson(url, {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
  assert.equal(open.status, 200);
  yield* drained(open);
  assert.equal(calls, 1);

  yield* endpoint.close;
  const closed = yield* postJson(url, {jsonrpc: "2.0", id: 2, method: "tools/list", params: {}});
  assert.equal(closed.status, 503);
  assert.match(header(closed, "content-type") ?? "", /^application\/json/u);
  assert.equal(header(closed, "cache-control"), "no-store");
  assert.equal(header(closed, "mcp-session-id"), null);
  assert.deepEqual(yield* json(closed), {error: "workflow_mcp_closed"});
  const closedCall = yield* postJson(url, {jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
  assert.equal(closedCall.status, 503);
  assert.deepEqual(yield* json(closedCall), {error: "workflow_mcp_closed"});
  // a second close is harmless and the endpoint stays closed
  yield* endpoint.close;
  const again = yield* postJson(url, {jsonrpc: "2.0", id: 4, method: "initialize", params: {}});
  assert.equal(again.status, 503);
  assert.deepEqual(yield* json(again), {error: "workflow_mcp_closed"});
  assert.equal(calls, 1);
  yield* within(settled, 5_000, "handler settlement");
  assert.equal(handled.size, 0);
}).pipe(Effect.provide(FetchHttpClient.layer)), {timeout: 10_000});

type RunnerEvent = {event: string} & Record<string, unknown>;

// real-process case: the runner process serves the route on its own node server and must still exit by itself
it.live("CT-MCP-04 (in-flight, route): close() aborts the controller signal and the pending call gets only an empty 503 answer, never the controller's result", () => Effect.gen(function* () {
  const runnerPath = fileURLToPath(new URL("./support/g8-mcp-inflight-close.ts", import.meta.url));
  const runner = yield* startProcess(process.execPath, ["--import", "tsx", runnerPath], {cwd: repositoryRoot, env: {PATH: nodePath()}, stdin: "pipe"});
  const events = (): RunnerEvent[] => runner.stdout().split("\n").filter(line => line.length > 0).map(line => JSON.parse(line) as RunnerEvent);
  const event = (name: string, ms: number) => Effect.map(runner.waitForStdout(() => events().some(value => value.event === name), ms, `runner ${name}`),
    () => events().find(value => value.event === name)!);

  // runner startup compiles the endpoint and the sdk through tsx
  const {port} = yield* event("listening", 20_000);
  assert.ok(typeof port === "number" && port > 0);
  const body = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
  const client = yield* rawCall(port, body);
  let responded = false;
  let answer: IncomingMessage | undefined;
  let connectionEnded = false;
  client.once("response", response => {responded = true;answer = response;});
  const clientClosed = Deferred.makeUnsafe<string | undefined>();
  let code: string | undefined;
  client.on("error", (error: NodeJS.ErrnoException) => {code = error.code;});
  client.once("close", () => {
    connectionEnded = true;
    Deferred.doneUnsafe(clientClosed, Exit.succeed(code));
  });
  client.end(body);

  const entered = yield* event("entered", 5_000);
  assert.equal(entered.aborted, false);
  runner.child.stdin!.write("close-endpoint\n");
  // the abort reaches the tool, which returns its result. target change (route): the route's interrupted request
  // completes, so its handling has settled (was handleSettled: false, the node adapter's handle() stayed pending)
  assert.deepEqual(yield* event("endpoint-closed", 5_000),
    {event: "endpoint-closed", aborted: true, reason: "AbortError", toolReturned: true, handleSettled: true});

  // a bounded window: the sdk transport close discarded the pending json response, and the connection stays open
  yield* Effect.sleep("1 second");
  // target change (route): was responded false (unanswered); the client now has the platform's whole interrupted
  // answer, a 503 without content type or content, so no json-rpc content, tool result or outcome claim
  assert.equal(responded, true);
  assert.deepEqual({status: answer?.statusCode, type: answer?.headers["content-type"] ?? null, complete: answer?.complete},
    {status: 503, type: null, complete: true});
  assert.equal(connectionEnded, false);

  runner.child.stdin!.end("close-server\n");
  // target change (route): was handleSettled: false, see endpoint-closed
  assert.deepEqual(yield* event("server-closed", 5_000), {event: "server-closed", error: null, handles: 1, handleSettled: true});
  // target change (route): was ECONNRESET; dropping a connection whose request was answered ends it without an error
  assert.equal(yield* within(Deferred.await(clientClosed), 5_000, "connection end"), undefined);
  // target change (route): was responded false (never answered); the one answer stays the empty 503 and its body, read
  // to the end after the drop, never carries the controller's late result
  const answered = answer!;
  const text = yield* within(Effect.callback<string>((resume) => {
    const chunks: Buffer[] = [];
    answered.on("data", (chunk: Buffer) => chunks.push(chunk));
    answered.once("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))));
  }), 5_000, "answer body end");
  assert.equal(text, "");
  const exit = yield* runner.closed(10_000);
  assert.deepEqual({code: exit.code, signal: exit.signal, stderr: exit.stderr}, {code: 0, signal: null, stderr: ""});
}), {timeout: 60_000});

it.live("CT-MCP-05: with a team the tool list has seven tools in fixed order and an unknown tool is an isError unknown_tool result", () => Effect.gen(function* () {
  const teamCalls: unknown[] = [];
  const controller = effectWorkflowController({readTool: () => Effect.succeed({status: "ok"})});
  const team = effectTeamController({
    call: (args: unknown) => Effect.sync(() => {teamCalls.push(["call", args]);return {status: "ok", tool: "team"};}),
    guide: (args: unknown) => Effect.sync(() => {teamCalls.push(["guide", args]);return {status: "ok", tool: "guide"};}),
  });
  const {url} = yield* serve(controller, team);

  const listed = yield* postJson(url, {jsonrpc: "2.0", id: 1, method: "tools/list", params: {}});
  assert.equal(listed.status, 200);
  const listBody = (yield* json(listed)) as {result?: {tools?: Array<{name: string}>}};
  assert.deepEqual(listBody.result?.tools?.map(tool => tool.name),
    ["workflow_read", "workflow_write", "supervision_start", "supervision_stop", "supervision_interpretation_submit", "supervision_team", "supervision_guide"]);

  const unknown = yield* postJson(url, {jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "workflow_delete", arguments: {}}});
  assert.equal(unknown.status, 200);
  const unknownBody = (yield* json(unknown)) as {result?: {isError?: boolean; content?: Array<{type?: string; text?: string}>}};
  assert.deepEqual(unknownBody.result, {content: [{type: "text", text: JSON.stringify({status: "invalid", reason: "unknown_tool"})}], isError: true});

  const routed = yield* postJson(url, {jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: "supervision_guide", arguments: {x: 1}}});
  assert.deepEqual(callText((yield* json(routed)) as {result?: {content?: Array<{text?: string}>}}), {status: "ok", tool: "guide"});
  assert.deepEqual(teamCalls, [["guide", {x: 1}]]);

  // without a team the team tools are neither listed nor routed
  const {url: teamless} = yield* serve(controller);
  const teamlessCall = yield* postJson(teamless, {jsonrpc: "2.0", id: 4, method: "tools/call", params: {name: "supervision_team", arguments: {}}});
  const teamlessBody = (yield* json(teamlessCall)) as {result?: {isError?: boolean; content?: Array<{text?: string}>}};
  assert.equal(teamlessBody.result?.isError, true);
  assert.deepEqual(callText(teamlessBody), {status: "invalid", reason: "unknown_tool"});
  assert.equal(teamCalls.length, 1);
}).pipe(Effect.provide(FetchHttpClient.layer)), {timeout: 10_000});
