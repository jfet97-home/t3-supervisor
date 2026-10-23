import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Scope, Tracer } from "effect";
import { HttpMiddleware } from "effect/http";
import { GuidanceRuntime } from "../src/guidance.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { GuidanceUi } from "../src/guidance-ui.js";
import type { ProjectDefinitionLoader } from "../src/project-definitions.js";
import { ServiceAuth } from "../src/service-auth.js";
import type { SupervisorConfig } from "../src/types.js";
import { WorkflowMcp } from "../src/workflow-mcp.js";
import type { WorkflowWriteController } from "../src/workflow-write-controller.js";
import { connectRefused, jsonBody, rawRequest, readCsrf, signIn } from "./support/c3b-http.js";
import { privately } from "./support/private-assert.js";
import { uiConfig } from "./support/c3b-ui.js";

// target regressions of the dashboard listeners on effect (plan 3.7, CC-WEBSEC, CC-MCP, CC-REDACT, CC-SHUTDOWN): the
// checks stay in front of the workflow MCP route on both routers, the host checks read the Host header as sent, session
// and csrf header values are redacted in rendered request headers, startup validation precedes any effect, and closing
// the scope drops in-flight requests without a graceful wait

const mcpHeaders = {"Content-Type": "application/json", Accept: "application/json, text/event-stream"};
const toolCall = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_read", arguments: {}}});

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "guidance-ui-"))),
  (directory) => Effect.promise(() => rm(directory, {recursive: true, force: true})),
);

// the dashboard listeners over the root's node file system and crypto, in the given scope
const buildUi = (config: SupervisorConfig, controller: WorkflowWriteController, options: {definitions?: ProjectDefinitionLoader} = {}) =>
  Effect.gen(function* () {
    const store = yield* Effect.acquireRelease(Effect.sync(() => new GuidanceStore(config.dataDirectory)), (store) => Effect.sync(() => store.close()));
    const runtime = yield* GuidanceRuntime.make(config, store, {catalog: () => Effect.succeed({projects: [], threads: []})});
    const context = yield* Layer.build(GuidanceUi.layer(config, options).pipe(
      Layer.provide(Layer.mergeAll(ServiceAuth.layer(config.dataDirectory), Layer.succeed(GuidanceRuntime, runtime), WorkflowMcp.layer(controller))),
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer)),
    ));
    const ui = Context.get(context, GuidanceUi);
    const token = (yield* Effect.promise(() => readFile(join(config.dataDirectory, "access", "workflow-mcp-token"), "utf8"))).trim();
    return {...ui, origin: `http://127.0.0.1:${ui.port}`, token};
  });

// a counting controller whose workflow_read answers at once
const countingController = () => {
  const calls = {count: 0};
  const controller = {readTool: async () => {calls.count++;return {status: "ok"};}} as unknown as WorkflowWriteController;
  return {calls, controller};
};

describe("guidance ui listeners", () => {
  it.live("GUI-01: a tools/call failing the Host, Origin or bearer check, or on a path the router would fold onto /mcp/workflows, never reaches the controller on either listener", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const {calls, controller} = countingController();
    const ui = yield* buildUi(uiConfig(directory, {workflowMcpBindHost: "127.0.0.1", workflowMcpPort: 0}), controller);
    const mcpPort = ui.mcpPort!;
    const call = (port: number, path: string, headers: Record<string, string>) => Effect.promise(async () => {
      const response = await rawRequest(port, {method: "POST", path, body: toolCall, headers: {...mcpHeaders, ...headers}});
      return [response.status, response.status === 200 ? "answered" : jsonBody(response)];
    });
    const bearer = {Authorization: "Bearer " + ui.token};
    for (const port of [ui.port, mcpPort]) {
      const local = {Host: `127.0.0.1:${port}`};
      assert.deepEqual(yield* call(port, "/mcp/workflows", {Host: `localhost:${port}`, ...bearer}), [403, {message: "Workflow MCP request origin is not allowed."}]);
      assert.deepEqual(yield* call(port, "/mcp/workflows", {...local, Origin: "http://evil.example", ...bearer}), [403, {message: "Workflow MCP request origin is not allowed."}]);
      assert.deepEqual(yield* call(port, "/mcp/workflows", {...local, "Sec-Fetch-Site": "cross-site", ...bearer}), [403, {message: "Workflow MCP request origin is not allowed."}]);
      assert.deepEqual(yield* call(port, "/mcp/workflows", local), [401, {message: "A workflow MCP token is required."}]);
      // effect's router decodes, splits at ';', folds case and trailing slashes; these stay dashboard paths here
      for (const path of ["/mcp/workflows;x", "/%6Dcp/workflows", "/MCP/workflows", "/mcp/workflows/", "//mcp/workflows"]) {
        const refused = port === mcpPort ? [404, {message: "Not found."}] : [405, {message: "Method not allowed."}];
        assert.deepEqual(yield* call(port, path, {...local, ...bearer}), refused, path);
      }
    }
    assert.equal(calls.count, 0);
    assert.deepEqual(yield* call(ui.port, "/mcp/workflows", {Host: `127.0.0.1:${ui.port}`, ...bearer}), [200, "answered"]);
    assert.deepEqual(yield* call(mcpPort, "/mcp/workflows", {Host: `127.0.0.1:${mcpPort}`, ...bearer}), [200, "answered"]);
    assert.equal(calls.count, 2);
  }), {timeout: 10_000});

  it.live("GUI-02: the loopback and workflow MCP host checks read the Host header as sent, not the authority of an absolute-form request target", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const {calls, controller} = countingController();
    const ui = yield* buildUi(uiConfig(directory), controller);
    const self = `http://127.0.0.1:${ui.port}`;
    const ask = (path: string, headers: Record<string, string>, method = "GET") => Effect.promise(async () => {
      const response = await rawRequest(ui.port, {method, path, headers, ...(method === "POST" ? {body: toolCall} : {})});
      return [response.status, jsonBody(response)];
    });
    const loopback = [403, {message: "Open the supervisor through its loopback address."}];
    assert.deepEqual(yield* ask(self + "/api/csrf", {Host: `localhost:${ui.port}`}), loopback);
    assert.deepEqual(yield* ask(self + "/auth/status", {Host: "evil.example:9100"}), loopback);
    assert.deepEqual(yield* ask("http://evil.example:9100/api/csrf", {Host: `127.0.0.1:${ui.port}`}), [401, {message: "Sign in to Supervisor."}]);
    assert.deepEqual(yield* ask(self + "/mcp/workflows", {...mcpHeaders, Host: "evil.example:9100", Authorization: "Bearer " + ui.token}, "POST"),
      [403, {message: "Workflow MCP request origin is not allowed."}]);
    assert.equal(calls.count, 0);
  }), {timeout: 10_000});

  it.live("GUI-03: session and csrf header values are rendered redacted in request header capture while other headers stay visible", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({span(options) {const span = new Tracer.NativeSpan(options);spans.push(span);return span;}});
    const ui = yield* buildUi(uiConfig(directory), countingController().controller).pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(HttpMiddleware.TracerHeaderFilter, (_name, phase) => phase === "request"),
    );
    const session = yield* Effect.promise(() => signIn(ui.origin, directory));
    const csrf = yield* Effect.promise(() => readCsrf(ui.origin, session));
    const response = yield* Effect.promise(() => rawRequest(ui.port, {method: "POST", path: "/api/guidance/thread-policy", body: "{}",
      headers: {Host: `127.0.0.1:${ui.port}`, Origin: ui.origin, "Content-Type": "application/json", "x-supervisor-session": session, "x-csrf-token": csrf, "x-probe": "visible"}}));
    assert.equal(response.status, 400);
    const captured = spans.find((span) => span.attributes.get("http.request.header.x-probe") === "visible");
    assert.ok(captured, "the request headers were captured");
    privately("captured session and csrf headers", [session, csrf], () => {
      assert.equal(captured.attributes.get("http.request.header.x-supervisor-session"), "<redacted>");
      assert.equal(captured.attributes.get("http.request.header.x-csrf-token"), "<redacted>");
    });
    const rendered = spans.flatMap((span) => [...span.attributes.values()].map(String));
    assert.equal(rendered.some((value) => value.includes(session) || value.includes(csrf)), false);
  }), {timeout: 10_000});

  it.live("GUI-04: an inexact WORKFLOW_MCP_HOSTS entry fails startup with the fixed message before the legacy login code is removed", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const legacy = join(directory, "ui-login-code");
    yield* Effect.promise(() => writeFile(legacy, "legacy"));
    const failed = yield* Effect.exit(Effect.scoped(buildUi(uiConfig(directory, {workflowMcpHosts: ["supervisor.internal"]}), countingController().controller)));
    assert.ok(Exit.isFailure(failed));
    assert.equal(failed.cause.reasons.some((reason) => reason._tag === "Fail" && (reason.error as {message?: unknown}).message === "Workflow MCP hosts must be exact host:port values."), true);
    assert.equal(existsSync(legacy), true);
    yield* Effect.scoped(buildUi(uiConfig(directory, {workflowMcpHosts: ["supervisor.internal:9100"]}), countingController().controller));
    assert.equal(existsSync(legacy), false);
  }), {timeout: 10_000});

  it.live("GUI-05: closing the scope with an in-flight api request and an in-flight workflow MCP call drops both promptly and aborts their signals", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const entered: Array<AbortSignal> = [];
    let bothEntered!: () => void;
    const handlersEntered = new Promise<void>((resolve) => {bothEntered = resolve;});
    const waitForAbort = (signal: AbortSignal) => {
      if (entered.push(signal) === 2) bothEntered();
      return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), {once: true}));
    };
    const controller = {readTool: (_args: unknown, signal: AbortSignal) => waitForAbort(signal)} as unknown as WorkflowWriteController;
    const definitions = {load: (_projectId: string, _threadId: string | null, signal: AbortSignal) => waitForAbort(signal)} as unknown as ProjectDefinitionLoader;
    const scope = yield* Scope.make();
    const ui = yield* buildUi(uiConfig(directory, {workflowMcpBindHost: "127.0.0.1", workflowMcpPort: 0}), controller, {definitions}).pipe(Scope.provide(scope));
    const session = yield* Effect.promise(() => signIn(ui.origin, directory));
    const open = (port: number, path: string, method: string, headers: Record<string, string>, body?: string) => {
      const client = httpRequest({host: "127.0.0.1", port, path, method, agent: false, headers});
      const settled = new Promise<string>((resolve) => {
        client.once("response", (response) => {response.resume();response.once("end", () => resolve(`response ${response.statusCode}`));});
        client.once("error", (error) => resolve(`error ${(error as NodeJS.ErrnoException).code}`));
      });
      client.end(body);
      return settled;
    };
    const api = open(ui.port, "/api/guidance/project-configuration?projectId=p", "GET", {"x-supervisor-session": session});
    const mcp = open(ui.mcpPort!, "/mcp/workflows", "POST", {...mcpHeaders, Authorization: "Bearer " + ui.token, "Content-Length": String(Buffer.byteLength(toolCall))}, toolCall);
    yield* Effect.promise(() => handlersEntered);
    assert.deepEqual(entered.map((signal) => signal.aborted), [false, false]);
    const started = performance.now();
    yield* Scope.close(scope, Exit.void);
    assert.ok(performance.now() - started < 2_000, "no graceful wait");
    assert.deepEqual(entered.map((signal) => signal.aborted), [true, true]);
    for (const settled of yield* Effect.promise(() => Promise.all([api, mcp]))) assert.match(settled, /^(?:error ECONNRESET|response \d+)$/u);
    assert.equal(yield* Effect.promise(() => connectRefused(ui.port)), true);
    assert.equal(yield* Effect.promise(() => connectRefused(ui.mcpPort!)), true);
  }), {timeout: 10_000});
});
