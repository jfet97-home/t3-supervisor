import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node";
import { ByteSize, Cause, Context, Crypto, Data, Effect, FileSystem, Layer, Option, Redacted, Schema, type Types } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Headers, HttpEffect, HttpIncomingMessage, HttpRouter, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { LoginRequest, SupervisorApi, UiError } from "./guidance-contract.js";
import { GuidanceRuntime } from "./guidance.js";
import type { SupervisorConfig } from "./types.js";
import type { ProjectDefinitionLoader } from "./project-definitions.js";
import type { ProjectConfigEditor } from "./project-config-editor.js";
import type { ProjectSupervisor } from "./project-supervisor.js";
import type { WorkflowWriteController } from "./workflow-write-controller.js";
import { parseWorkflowProgressPageQuery, readWorkflowProgressPage } from "./workflow-progress.js";
import { ServiceAuth } from "./service-auth.js";
import { WorkflowMcp, WorkflowMcpRoute } from "./workflow-mcp.js";
import { overviewPage } from "./dashboard-overview.js";

// the unported supervision objects the api handlers call through their promise shapes (b-03)
export interface GuidanceUiOptions {
  readonly definitions?: ProjectDefinitionLoader | undefined;
  readonly editor?: ProjectConfigEditor | undefined;
  readonly supervision?: ProjectSupervisor | undefined;
  readonly workflowReader?: WorkflowWriteController | undefined;
}

export class InvalidWorkflowMcpHosts extends Data.TaggedError("InvalidWorkflowMcpHosts") {
  override readonly message = "Workflow MCP hosts must be exact host:port values.";
}
class BodyTooLarge extends Data.TaggedError("BodyTooLarge") {}

const securityHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  vary: "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Sec-Fetch-User",
};
// the session and csrf headers join effect's default redactions wherever request headers are rendered
const redactedHeaders = [...Headers.CurrentRedactedNames.defaultValue(), "x-supervisor-session", "x-csrf-token"];
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const contentSecurityPolicy = (nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const pathOf = (request: HttpServerRequest.HttpServerRequest) => new URL(request.url, "http://127.0.0.1").pathname;
const sessionOf = (request: HttpServerRequest.HttpServerRequest) => {
  const value: unknown = request.headers["x-supervisor-session"];
  return typeof value === "string" ? value : undefined;
};

// a gated json answer carries the security headers
const answer = (status: number, body: unknown) =>
  HttpServerResponse.text(JSON.stringify(body), { status, contentType: "application/json", headers: securityHeaders });
const reject = (status: number, message: string) => answer(status, { message });
// a request that failed outside the api routes answers 413 for an oversized body, else 500, with only no-store
const failed = (status: 413 | 500) => HttpServerResponse.text(
  JSON.stringify({ message: status === 413 ? "The request payload is too large. Reduce its size before retrying." : "Supervisor operation unavailable." }),
  { status, contentType: "application/json", headers: { "cache-control": "no-store" } },
);
// an interruption stays an interruption: its client is gone or the listener is closing
const failedAnswer = <E>(cause: Cause.Cause<E>) => Cause.hasInterrupts(cause) ? Effect.failCause(cause)
  : Effect.succeed(failed(cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error instanceof BodyTooLarge) ? 413 : 500));
const answerFailures = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => Effect.catchCause(effect, failedAnswer);
// the api and mcp routes answer with their own headers over the security headers, failures included
const secured: HttpEffect.PreResponseHandler = (_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, { ...securityHeaders, ...response.headers }));

// the request body up to limit bytes; a larger body fails BodyTooLarge and the rest of it is drained
const readBody = (request: HttpServerRequest.HttpServerRequest, limit: number) => request.arrayBuffer.pipe(
  Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(limit)),
  Effect.mapError((error) => error.reason._tag === "RequestParseError" && error.reason.reason === "BodyTooLarge" ? new BodyTooLarge() : error),
);

// stops accepting and drops every open connection, so in-flight requests end without a graceful wait
const closeNow = (server: Server) => Effect.callback<void>((resume) => {
  server.close(() => resume(Effect.void));
  server.closeAllConnections();
});

const make = Effect.fnUntraced(function* (config: SupervisorConfig, options: GuidanceUiOptions) {
  const mcpHosts = config.workflowMcpHosts ?? [];
  if (mcpHosts.some(host => !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):[0-9]{1,5}$/u.test(host))) return yield* new InvalidWorkflowMcpHosts();
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const auth = yield* ServiceAuth;
  const runtime = yield* GuidanceRuntime;
  const mcp = yield* WorkflowMcp;
  yield* fs.remove(join(config.dataDirectory, "ui-login-code"), { force: true });
  const { definitions, editor, supervision, workflowReader } = options;
  const handlers = HttpApiBuilder.group(SupervisorApi, "guidance", (h) =>
    h.handleAll({
      snapshot: () => Effect.orDie(runtime.snapshot),
      dashboardOverview: ({query}) => Effect.tryPromise({
        try: () => {if (!supervision) throw new Error("supervision_unavailable");return supervision.overview(overviewPage(query));},
        catch: () => new UiError({message: "The work overview is unavailable. Refresh to try again."}),
      }),
      noProjectControl: () => Effect.try({try: () => {if (!supervision) throw new Error("unavailable");return supervision.noProjectControl();}, catch: () => new UiError({message: "No Project mode unavailable."})}),
      saveNoProjectControl: ({payload}) => Effect.tryPromise({try: signal => {if (!supervision) throw new Error("unavailable");return supervision.saveNoProjectControl(payload, signal);}, catch: () => new UiError({message: "Reload the No Project mode before retrying."})}),
      supervisionCandidates: ({query}) => Effect.tryPromise({try: () => {if (!supervision) throw new Error("unavailable");return supervision.candidates(query.query, query.purpose);}, catch: () => new UiError({message: "Chat search unavailable."})}),
      startSupervision: ({payload}) => Effect.tryPromise({try: async signal => {if (!supervision) throw new Error("unavailable");const result = await supervision.dashboardStart(payload.threadId, payload.operationId, signal);return {...payload, status: result.status === "invalid" ? "denied" as const : result.status, reason: result.reason};}, catch: () => new UiError({message: "Start outcome is unknown. Check its original operation ID; do not replay."})}),
      supervisionStartStatus: ({query}) => Effect.try({try: () => {if (!supervision) throw new Error("unavailable");return supervision.startStatus(query.threadId, query.operationId);}, catch: () => new UiError({message: "Start status unavailable."})}),
      supervisionControl: ({query}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.control(query.projectId ?? null, signal);},
        catch: () => new UiError({message: "Supervision control is unavailable."}),
      }),
      saveSupervisionControl: ({payload}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.saveControl(payload, signal);},
        catch: () => new UiError({message: "The enable/disable outcome could not be confirmed. Reload before trying again."}),
      }),
      supervisionSetupOptions: ({query}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.setupOptions(query.projectId, signal);},
        catch: () => new UiError({message: "Registered checkout options could not be loaded."}),
      }),
      setupSupervision: ({payload}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.setup(payload, signal);},
        catch: () => new UiError({message: "The setup outcome could not be confirmed. Inspect the selected checkout before retrying."}),
      }),
      globalDefinitionsControl: () => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.globalDefinitionsControl(signal);},
        catch: () => new UiError({message: "Global rules control is unavailable."}),
      }),
      saveGlobalDefinitionsControl: ({payload}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.saveGlobalDefinitionsControl(payload, signal);},
        catch: () => new UiError({message: "The global rules setup outcome could not be confirmed. Inspect ~/.t3-supervisor before retrying."}),
      }),
      projectSupervisor: ({query}) => Effect.tryPromise({
        try: signal => {
          if (!supervision) throw new Error("supervision_unavailable");return supervision.snapshot(query.projectId, signal, query.mainThreadId ?? null);
        }, catch: () => new UiError({message: "Project supervision is unavailable. Check the T3 connection and registered project."}),
      }),
      workflowProgress: ({query}) => Effect.tryPromise({
        try: signal => {
          if (!supervision || !workflowReader) throw new Error("workflow_progress_unavailable");
          const parsed = parseWorkflowProgressPageQuery(query);
          if (!parsed) throw new Error("workflow_progress_invalid_query");
          return readWorkflowProgressPage(supervision, workflowReader, parsed, signal);
        },
        catch: () => new UiError({message: "Live workflow progress is unavailable. Refresh and check the T3 connection."}),
      }),
      saveProjectSupervisor: ({payload}) => Effect.tryPromise({
        try: signal => {
          if (!supervision) throw new Error("supervision_unavailable");return supervision.save(payload, signal);
        }, catch: () => new UiError({message: "Supervisor settings could not be confirmed. Refresh and inspect the current selection before saving again."}),
      }),
      retryProjectSupervisor: ({payload}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.retry(payload, signal);},
        catch: () => new UiError({message: "Native access retry could not be confirmed. Refresh to inspect the retained state."}),
      }),
      chatSupervision: ({payload}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.setChatSupervision(payload, signal);},
        catch: () => new UiError({message: "The chat supervision change could not be confirmed. Refresh to inspect the saved state."}),
      }),
      projectConfiguration: ({query}) => Effect.tryPromise({
        try: (signal) => {
          if (!definitions) throw new Error("Project definition access is not configured.");
          return definitions.load(query.projectId, query.threadId ?? null, signal).then(result => ({...result, editingAvailable: Boolean(editor)}));
        },
        catch: () => new UiError({message: "Project definition access is unavailable."}),
      }),
      saveProjectConfiguration: ({payload}) => Effect.tryPromise({
        try: signal => editor ? editor.save(payload, signal) : Promise.resolve({status: "permission_required" as const, message: "Project editing needs a dedicated filesystem:read/filesystem:write credential through deployment setup.", definitions: null}),
        catch: () => new UiError({message: "The save outcome could not be confirmed. Refresh and inspect project.yaml before retrying."}),
      }),
      threadPolicy: ({ payload }) => {
        const invalid = (cause: unknown) => new UiError({ message: cause instanceof Error ? cause.message : "Chat settings invalid. Reload first." });
        const policy = config.threadPolicy;
        if (!policy) return Effect.fail(invalid(new Error("Chat settings unavailable.")));
        // each chat this editor adds or removes is a human Stop or Enable for that chat's supervision, saved as one admission
        // section (t-02)
        return supervision ? Effect.mapError(supervision.saveThreadPolicy(payload), invalid) : Effect.try({ try: () => policy.save(payload), catch: invalid });
      },
    }),
  );
  const csrf = base64url(yield* crypto.randomBytes(32));
  const assets = resolve(config.uiAssetsDirectory ?? "ui-dist");

  // GET /auth/status, POST /auth/login and /auth/logout from the supervisor's own origin; a started sign-in or sign-out
  // completes even when its client goes away
  const authRequest = (request: HttpServerRequest.HttpServerRequest, origin: string) => Effect.gen(function* () {
    const path = pathOf(request);
    const session = sessionOf(request);
    if (path === "/auth/status" && request.method === "GET") return answer(200, {authenticated: yield* auth.authenticated(session)});
    if (request.method !== "POST" || !["/auth/login", "/auth/logout"].includes(path)) return reject(404, "Not found.");
    if (request.headers.origin !== origin || request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json")
      return reject(403, "Use the Supervisor sign-in page.");
    if (path === "/auth/login") {
      // an unreadable body is an invalid sign-in like malformed json; only an oversized one fails the request
      const body = yield* readBody(request, 2048).pipe(
        Effect.map(bytes => Option.some(Buffer.from(bytes).toString("utf8"))),
        Effect.catchTag("HttpServerError", () => Effect.succeedNone),
      );
      const payload = Option.flatMap(body, text => Option.liftThrowable((): unknown => JSON.parse(text))());
      if (Option.isNone(payload)) return reject(400, "Invalid sign-in request.");
      const token = Option.match(Schema.decodeUnknownOption(LoginRequest)(payload.value), {onNone: () => "", onSome: login => login.token});
      const authenticated = yield* auth.login(token);
      if (!authenticated) return reject(401, "The access token is invalid.");
      yield* auth.logout(session);
      return answer(200, {authenticated: true, session: Redacted.value(authenticated)});
    }
    yield* auth.logout(session);
    return answer(200, {authenticated: false});
  });

  // the dashboard files with a fresh csp nonce on every script tag of an html page
  const staticFile = (request: HttpServerRequest.HttpServerRequest) => Effect.gen(function* () {
    if (request.method !== "GET") return reject(405, "Method not allowed.");
    const pathname = pathOf(request);
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).slice(1);
    const path = resolve(assets, relative);
    if (!path.startsWith(assets + sep)) return reject(404, "Not found.");
    const file = yield* Effect.option(fs.readFile(path));
    if (Option.isNone(file)) return reject(404, "Not found.");
    const nonce = base64url(yield* crypto.randomBytes(20));
    const html = extname(path) === ".html";
    const bytes = html ? Buffer.from(Buffer.from(file.value).toString("utf8").replace(/<script\b/gu, `<script nonce="${nonce}"`)) : file.value;
    return HttpServerResponse.uint8Array(bytes, {
      contentType: contentTypes[extname(path)] ?? "application/octet-stream",
      headers: {...securityHeaders, "content-security-policy": contentSecurityPolicy(nonce)},
    });
  });

  // the checks in front of every request of one listener, in the baseline order; the origin is always the dashboard's
  // loopback address, and the workflow MCP host must name the receiving listener or a configured host
  const gate = (mcpOnly: boolean, uiPort: number | undefined) => HttpRouter.middleware(Effect.gen(function* () {
    const listener = (yield* HttpServer.HttpServer).address;
    const listenerPort = listener._tag === "UnixPathAddress" ? 0 : listener.port;
    const origin = `http://127.0.0.1:${uiPort ?? listenerPort}`;
    return (httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, origin);
      const headers = request.headers;
      // the Host header as sent: an absolute-form request target does not stand in for it
      const host = NodeHttpServerRequest.toIncomingMessage(request).headers.host;
      const navigation =
        request.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/index.html") &&
        headers["sec-fetch-mode"] === "navigate" &&
        headers["sec-fetch-dest"] === "document" &&
        headers["sec-fetch-user"] === "?1";
      if (mcpOnly && url.pathname !== "/mcp/workflows") return reject(404, "Not found.");
      const browserRejected = (headers.origin && headers.origin !== origin) || (headers["sec-fetch-site"] === "cross-site" && !navigation);
      // every handler sees the normalized path these checks classified
      const routed = request.modify({url: url.pathname + url.search});
      if (url.pathname === "/mcp/workflows") {
        if (![`127.0.0.1:${listenerPort}`, ...mcpHosts].includes(host?.toLowerCase() ?? "") || browserRejected)
          return reject(403, "Workflow MCP request origin is not allowed.");
        if (!auth.mcpAuthorized(headers.authorization)) return reject(401, "A workflow MCP token is required.");
        return yield* HttpEffect.withPreResponseHandler(Effect.provideService(httpEffect, HttpServerRequest.HttpServerRequest, routed), secured);
      }
      if (host !== `127.0.0.1:${uiPort ?? listenerPort}` || browserRejected)
        return reject(403, "Open the supervisor through its loopback address.");
      // effect's router decodes, splits and folds paths, so the auth and file answers stay on the path classified here
      if (url.pathname.startsWith("/auth/")) return yield* answerFailures(authRequest(routed, origin));
      if (!url.pathname.startsWith("/api/")) return yield* answerFailures(staticFile(routed));
      if (!(yield* auth.authenticated(sessionOf(request)))) return reject(401, "Sign in to Supervisor.");
      const csrfHeader: unknown = headers["x-csrf-token"];
      if (request.method !== "GET" && (headers.origin !== origin || typeof csrfHeader !== "string" || !equal(csrfHeader, csrf)))
        return reject(403, "Refresh the local dashboard before changing settings.");
      if (request.method !== "GET" && !headers["content-type"]?.startsWith("application/json"))
        return reject(415, "Use JSON for supervisor mutations.");
      // the api routes receive the baseline forwarded request: the normalized path, only a json content type and the
      // body read up to 64000 bytes before any handler runs
      const api = request.modify({url: url.pathname + url.search, headers: Headers.fromInput({"content-type": "application/json"})});
      const routedApi = HttpEffect.withPreResponseHandler(Effect.provideService(httpEffect, HttpServerRequest.HttpServerRequest, api), secured);
      if (request.method === "GET") return yield* routedApi;
      return yield* Effect.matchCauseEffect(readBody(api, 64_000), {onFailure: failedAnswer, onSuccess: () => routedApi});
    });
  }), {global: true});

  // the per-process csrf token for a signed-in dashboard; any other path below /api/csrf is an unmatched api route
  const csrfRoute = HttpRouter.add("GET", "/api/csrf", (request) => request.method === "GET" && pathOf(request) === "/api/csrf"
    ? Effect.succeed(answer(200, {csrf}))
    : Effect.fail(new HttpServerError.HttpServerError({reason: new HttpServerError.RouteNotFound({request})})));
  const apiRoutes = HttpApiBuilder.layer(SupervisorApi).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices));

  // one node listener serving the router in this scope; the scope drops its connections before releasing it
  const listen = <E, R>(routes: Layer.Layer<never, E, R>, port: number, host: string) => Effect.gen(function* () {
    const server = createServer();
    const context = yield* Layer.build(HttpRouter.serve(routes, {disableLogger: true, disableListenLog: true}).pipe(
      Layer.provideMerge(NodeHttpServer.layerServer(() => server, {port, host, disablePreemptiveShutdown: true})),
      Layer.provide(Layer.succeed(Headers.CurrentRedactedNames, redactedHeaders)),
    ));
    yield* Effect.addFinalizer(() => closeNow(server));
    const address = Context.get(context, HttpServer.HttpServer).address;
    return {server, port: address._tag === "UnixPathAddress" ? 0 : address.port};
  });

  const ui = yield* listen(Layer.mergeAll(apiRoutes, csrfRoute, WorkflowMcpRoute, gate(false, undefined)),
    config.uiPort ?? 9008, config.uiHost ?? "127.0.0.1");
  const mcpOnly = config.workflowMcpBindHost
    ? yield* listen(Layer.mergeAll(WorkflowMcpRoute, gate(true, ui.port)), config.workflowMcpPort ?? ui.port, config.workflowMcpBindHost)
    : undefined;
  // closing answers later workflow MCP requests 503 and interrupts its calls, then drops every connection of both listeners
  yield* Effect.addFinalizer(() => mcp.close.pipe(
    Effect.andThen(closeNow(ui.server)),
    Effect.andThen(mcpOnly ? closeNow(mcpOnly.server) : Effect.void),
  ));
  return {port: ui.port, mcpPort: mcpOnly?.port ?? null};
});

/** The dashboard and workflow MCP listeners over the supervision run's services. */
export class GuidanceUi extends Context.Service<GuidanceUi, {
  // the bound dashboard port and, with a workflow MCP bind host, the bound MCP-only port
  readonly port: number;
  readonly mcpPort: number | null;
}>()("t3-supervisor/GuidanceUi") {
  // the listeners are acquired after the services they use and released before them
  static readonly layer = (config: SupervisorConfig, options: GuidanceUiOptions = {}) => Layer.effect(GuidanceUi, make(config, options));
}
