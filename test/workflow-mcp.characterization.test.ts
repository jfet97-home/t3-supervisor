import assert from "node:assert/strict";
import {createServer, request as httpRequest, type IncomingMessage, type ServerResponse} from "node:http";
import {fileURLToPath} from "node:url";
import {it, type TestContext} from "vitest";
import {createWorkflowMcpEndpoint, type WorkflowMcpEndpoint} from "../src/workflow-mcp.js";
import type {SupervisorTeamController} from "../src/supervisor-team-controller.js";
import type {WorkflowWriteController} from "../src/workflow-write-controller.js";
import {nodePath, repositoryRoot, startProcess} from "./support/cli-process.js";
import {after} from "./support/node-test.js";

type Served = {url: string; port: number; handled: Set<Promise<void>>};

// serves the endpoint on its own loopback server; cleanup closes the endpoint, waits for every handle() and closes the server
const serve = async (t: TestContext, endpoint: WorkflowMcpEndpoint): Promise<Served> => {
  const handled = new Set<Promise<void>>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pending = endpoint.handle(request, response);
    handled.add(pending);
    void pending.finally(() => handled.delete(pending));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  after(t, async () => {
    await endpoint.close();
    await Promise.all([...handled]);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return {url: `http://127.0.0.1:${address.port}/mcp/workflows`, port: address.port, handled};
};

const postJson = async (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => fetch(url, {
  method: "POST",
  headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers},
  body: JSON.stringify(body),
});

// races an awaited event against a finite deadline; the expiry promise always settles so nothing stays pending
const deadline = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  let settle!: (expired: boolean) => void;
  const expiry = new Promise<boolean>(resolve => {
    settle = resolve;
    timer = setTimeout(() => resolve(true), ms);
  });
  try {
    const winner = await Promise.race([promise.then(value => ({value})), expiry.then(expired => expired ? null : undefined)]);
    if (!winner) throw new Error(`${label} did not happen within ${ms} ms`);
    return winner.value;
  } finally {
    clearTimeout(timer);
    settle(false);
  }
};

const callText = (body: {result?: {content?: Array<{text?: string}>}}): unknown => JSON.parse(body.result?.content?.[0]?.text ?? "null");

type Gate = {entered: Promise<AbortSignal>; aborted: Promise<{reason: unknown; at: number}>; enteredAt: () => number};

// a controller tool that waits until its signal aborts and then reports the abort reason name
const abortWaitingTool = (): Gate & {tool: (args: unknown, signal: AbortSignal) => Promise<unknown>} => {
  let enter!: (signal: AbortSignal) => void;
  let abort!: (value: {reason: unknown; at: number}) => void;
  const entered = new Promise<AbortSignal>(resolve => {enter = resolve;});
  const aborted = new Promise<{reason: unknown; at: number}>(resolve => {abort = resolve;});
  let enteredAt = 0;
  return {
    entered,
    aborted,
    enteredAt: () => enteredAt,
    tool: async (_args, signal) => {
      enteredAt = performance.now();
      assert.equal(signal.aborted, false);
      enter(signal);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true}));
      abort({reason: signal.reason, at: performance.now()});
      return {status: "unavailable", reason: (signal.reason as {name?: string}).name};
    },
  };
};

it("CT-MCP-02: tools/list without initialize or session header succeeds statelessly and no response carries Mcp-Session-Id", {timeout: 10_000}, async t => {
  const controller = {readTool: async (args: unknown) => ({status: "ok", received: args})} as unknown as WorkflowWriteController;
  const {url} = await serve(t, createWorkflowMcpEndpoint(controller));

  const listed = await postJson(url, {jsonrpc: "2.0", id: 1, method: "tools/list", params: {}});
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("mcp-session-id"), null);
  assert.match(listed.headers.get("content-type") ?? "", /^application\/json/u);
  const listBody = await listed.json() as {jsonrpc?: string; id?: number; result?: {tools?: Array<{name: string}>}};
  assert.equal(listBody.jsonrpc, "2.0");
  assert.equal(listBody.id, 1);
  assert.deepEqual(listBody.result?.tools?.map(tool => tool.name), ["workflow_read", "workflow_write", "supervision_start", "supervision_stop"]);

  // a tools/call without initialize is served the same way
  const called = await postJson(url, {jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "workflow_read", arguments: {probe: 1}}});
  assert.equal(called.status, 200);
  assert.equal(called.headers.get("mcp-session-id"), null);
  assert.deepEqual(callText(await called.json() as {result?: {content?: Array<{text?: string}>}}), {status: "ok", received: {probe: 1}});

  // initialize also yields no session identity, and an unknown session header is not validated
  const initialized = await postJson(url, {jsonrpc: "2.0", id: 3, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "workflow-mcp-characterization", version: "1"},
  }});
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers.get("mcp-session-id"), null);
  await initialized.body?.cancel();
  const foreignSession = await postJson(url, {jsonrpc: "2.0", id: 4, method: "tools/list", params: {}}, {"Mcp-Session-Id": "not-issued"});
  assert.equal(foreignSession.status, 200);
  assert.equal(foreignSession.headers.get("mcp-session-id"), null);
  await foreignSession.body?.cancel();
});

it("CT-MCP-03: a client disconnect during a slow tool call aborts the controller signal", {timeout: 10_000}, async t => {
  const gate = abortWaitingTool();
  const controller = {readTool: gate.tool} as unknown as WorkflowWriteController;
  const {port, handled} = await serve(t, createWorkflowMcpEndpoint(controller));

  const body = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
  const client = httpRequest({host: "127.0.0.1", port, path: "/mcp/workflows", method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(body),
  }});
  const clientClosed = new Promise<void>(resolve => client.once("close", () => resolve()));
  client.on("error", () => undefined);
  client.end(body);

  const signal = await deadline(gate.entered, 5_000, "tool call entry");
  assert.equal(signal.aborted, false);
  assert.equal(handled.size, 1);
  client.destroy();
  const aborted = await deadline(gate.aborted, 5_000, "controller signal abort");
  assert.equal((aborted.reason as {name?: string}).name, "AbortError");
  assert.ok(aborted.at - gate.enteredAt() < 5_000);
  await deadline(clientClosed, 5_000, "client close");
  // the request handler settles once the aborted call returns
  await deadline(Promise.all([...handled]), 5_000, "handler settlement");
  assert.equal(handled.size, 0);
});

it("CT-MCP-03: the hard-coded 9 s call deadline aborts the controller signal and the call returns its result", {timeout: 60_000}, async t => {
  const gate = abortWaitingTool();
  const controller = {readTool: gate.tool} as unknown as WorkflowWriteController;
  const {url} = await serve(t, createWorkflowMcpEndpoint(controller));

  const response = postJson(url, {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
  await deadline(gate.entered, 5_000, "tool call entry");
  const aborted = await deadline(gate.aborted, 20_000, "9 s call deadline");
  assert.equal((aborted.reason as {name?: string}).name, "TimeoutError");
  const elapsed = aborted.at - gate.enteredAt();
  assert.ok(elapsed >= 8_900 && elapsed < 12_000, `deadline fired after ${Math.round(elapsed)} ms`);

  const answered = await deadline(response, 5_000, "response after deadline");
  assert.equal(answered.status, 200);
  const answeredBody = await answered.json() as {result?: {isError?: boolean; content?: Array<{text?: string}>}};
  assert.equal(answeredBody.result?.isError, true);
  assert.deepEqual(callText(answeredBody), {status: "unavailable", reason: "TimeoutError"});
});

it("CT-MCP-04: after endpoint.close() every POST is answered 503 workflow_mcp_closed without reaching the controller", {timeout: 10_000}, async t => {
  let calls = 0;
  const controller = {readTool: async () => {calls++;return {status: "ok"};}} as unknown as WorkflowWriteController;
  const endpoint = createWorkflowMcpEndpoint(controller);
  const {url, handled} = await serve(t, endpoint);

  const open = await postJson(url, {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
  assert.equal(open.status, 200);
  await open.body?.cancel();
  assert.equal(calls, 1);

  await endpoint.close();
  const closed = await postJson(url, {jsonrpc: "2.0", id: 2, method: "tools/list", params: {}});
  assert.equal(closed.status, 503);
  assert.match(closed.headers.get("content-type") ?? "", /^application\/json/u);
  assert.equal(closed.headers.get("cache-control"), "no-store");
  assert.equal(closed.headers.get("mcp-session-id"), null);
  assert.deepEqual(await closed.json(), {error: "workflow_mcp_closed"});
  const closedCall = await postJson(url, {jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
  assert.equal(closedCall.status, 503);
  assert.deepEqual(await closedCall.json(), {error: "workflow_mcp_closed"});
  // a second close is harmless and the endpoint stays closed
  await endpoint.close();
  const again = await postJson(url, {jsonrpc: "2.0", id: 4, method: "initialize", params: {}});
  assert.equal(again.status, 503);
  assert.deepEqual(await again.json(), {error: "workflow_mcp_closed"});
  assert.equal(calls, 1);
  await deadline(Promise.all([...handled]), 5_000, "handler settlement");
  assert.equal(handled.size, 0);
});

type RunnerEvent = {event: string} & Record<string, unknown>;

// real-process case: the never-settling handle() is confined to the runner process, which must still exit by itself
it("CT-MCP-04 (in-flight, baseline): close() aborts the controller signal but the pending call gets no response until the server drops the connection", {timeout: 60_000}, async t => {
  const runnerPath = fileURLToPath(new URL("./support/gaps-mcp-inflight-close.ts", import.meta.url));
  const runner = startProcess(process.execPath, ["--import", "tsx", runnerPath], {cwd: repositoryRoot, env: {PATH: nodePath()}, stdin: "pipe"});
  after(t, () => runner.dispose());
  const events = (): RunnerEvent[] => runner.stdout().split("\n").filter(line => line.length > 0).map(line => JSON.parse(line) as RunnerEvent);
  const event = async (name: string, ms: number): Promise<RunnerEvent> => {
    await runner.waitForStdout(() => events().some(value => value.event === name), ms, `runner ${name}`);
    return events().find(value => value.event === name)!;
  };

  // runner startup compiles the endpoint and the sdk through tsx
  const {port} = await event("listening", 20_000);
  assert.ok(typeof port === "number" && port > 0);
  const body = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
  const client = httpRequest({host: "127.0.0.1", port, path: "/mcp/workflows", method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(body),
  }});
  after(t, () => client.destroy());
  let responded = false;
  let connectionEnded = false;
  client.once("response", () => {responded = true;});
  const clientClosed = new Promise<string | undefined>(resolve => {
    let code: string | undefined;
    client.on("error", (error: NodeJS.ErrnoException) => {code = error.code;});
    client.once("close", () => {
      connectionEnded = true;
      resolve(code);
    });
  });
  client.end(body);

  const entered = await event("entered", 5_000);
  assert.equal(entered.aborted, false);
  runner.child.stdin!.write("close-endpoint\n");
  // the abort reaches the tool, which returns its result, yet handle() stays pending
  assert.deepEqual(await event("endpoint-closed", 5_000),
    {event: "endpoint-closed", aborted: true, reason: "AbortError", toolReturned: true, handleSettled: false});

  // a bounded absence window: the sdk transport close discarded the pending json response
  await new Promise<void>(resolve => setTimeout(resolve, 1_000));
  assert.equal(responded, false);
  assert.equal(connectionEnded, false);

  runner.child.stdin!.end("close-server\n");
  assert.deepEqual(await event("server-closed", 5_000), {event: "server-closed", error: null, handles: 1, handleSettled: false});
  assert.equal(await deadline(clientClosed, 5_000, "connection end"), "ECONNRESET");
  assert.equal(responded, false);
  const exit = await runner.closed(10_000);
  assert.deepEqual({code: exit.code, signal: exit.signal, stderr: exit.stderr}, {code: 0, signal: null, stderr: ""});
});

it("CT-MCP-05: with a team the tool list has six tools in fixed order and an unknown tool is an isError unknown_tool result", {timeout: 10_000}, async t => {
  const teamCalls: unknown[] = [];
  const controller = {readTool: async () => ({status: "ok"})} as unknown as WorkflowWriteController;
  const team = {
    call: async (args: unknown) => {teamCalls.push(["call", args]);return {status: "ok", tool: "team"};},
    guide: async (args: unknown) => {teamCalls.push(["guide", args]);return {status: "ok", tool: "guide"};},
  } as unknown as SupervisorTeamController;
  const {url} = await serve(t, createWorkflowMcpEndpoint(controller, team));

  const listed = await postJson(url, {jsonrpc: "2.0", id: 1, method: "tools/list", params: {}});
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as {result?: {tools?: Array<{name: string}>}};
  assert.deepEqual(listBody.result?.tools?.map(tool => tool.name),
    ["workflow_read", "workflow_write", "supervision_start", "supervision_stop", "supervision_team", "supervision_guide"]);

  const unknown = await postJson(url, {jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "workflow_delete", arguments: {}}});
  assert.equal(unknown.status, 200);
  const unknownBody = await unknown.json() as {result?: {isError?: boolean; content?: Array<{type?: string; text?: string}>}};
  assert.deepEqual(unknownBody.result, {content: [{type: "text", text: JSON.stringify({status: "invalid", reason: "unknown_tool"})}], isError: true});

  const routed = await postJson(url, {jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: "supervision_guide", arguments: {x: 1}}});
  assert.deepEqual(callText(await routed.json() as {result?: {content?: Array<{text?: string}>}}), {status: "ok", tool: "guide"});
  assert.deepEqual(teamCalls, [["guide", {x: 1}]]);

  // without a team the team tools are neither listed nor routed
  const {url: teamless} = await serve(t, createWorkflowMcpEndpoint(controller));
  const teamlessCall = await postJson(teamless, {jsonrpc: "2.0", id: 4, method: "tools/call", params: {name: "supervision_team", arguments: {}}});
  const teamlessBody = await teamlessCall.json() as {result?: {isError?: boolean; content?: Array<{text?: string}>}};
  assert.equal(teamlessBody.result?.isError, true);
  assert.deepEqual(callText(teamlessBody), {status: "invalid", reason: "unknown_tool"});
  assert.equal(teamCalls.length, 1);
});
