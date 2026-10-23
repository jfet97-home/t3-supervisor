import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { extname, resolve, sep } from "node:path";
import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node";
import { ByteSize, Cause, Context, Crypto, Data, Effect, FileSystem, Layer, Option, Redacted, Schema, type Types } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Headers, HttpEffect, HttpIncomingMessage, HttpRouter, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ListenerUnavailable } from "./errors.js";
import { LoginRequest, SupervisorApi, UiError } from "./guidance-contract.js";
import { GuidanceRuntime } from "./guidance.js";
import type { SupervisorConfig } from "./types.js";
import type { ProjectDefinitions } from "./project-definitions.js";
import type { ProjectConfigEditorService } from "./project-config-editor.js";
import { ProjectSupervisor } from "./project-supervisor.js";
import type { SupervisionControl } from "./supervision-control.js";
import { WorkflowWriteController } from "./workflow-write-controller.js";
import { parseWorkflowProgressPageQuery } from "./workflow-progress.js";
import { readWorkflowProgressPage } from "./workflow-progress-reader.js";
import { ServiceAuth } from "./service-auth.js";
import { WorkflowMcp, WorkflowMcpRoute } from "./workflow-mcp.js";
import { overviewPage } from "./dashboard-overview.js";
import { ThreadPolicyStore } from "./thread-policy.js";

// the supervision services the api handlers yield
export interface GuidanceSupervision {
  readonly supervisor: ProjectSupervisor["Service"];
  readonly control: SupervisionControl["Service"];
}

// the services the api handlers yield; without definitions, an editor or supervision their handlers answer unavailable
export interface GuidanceUiOptions {
  readonly definitions?: ProjectDefinitions["Service"] | undefined;
  readonly editor?: ProjectConfigEditorService["Service"] | undefined;
  readonly supervision?: GuidanceSupervision | undefined;
  readonly workflowReader?: WorkflowWriteController["Service"] | undefined;
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
  const policy = yield* ThreadPolicyStore;
  const { definitions, editor, supervision, workflowReader } = options;
  // a service call answers its fixed UiError for any failure or defect; an interruption stays one
  const failingWith = <A, E, R>(message: string, call: Effect.Effect<A, E, R>): Effect.Effect<A, UiError, R> => Effect.catchCause(call,
    (cause) => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.fail(new UiError({message})));
  // a supervision call answers its fixed UiError for any failure or defect, and for absent supervision
  const supervised = <A, E, R>(message: string, call: (services: GuidanceSupervision) => Effect.Effect<A, E, R>): Effect.Effect<A, UiError, R> =>
    !supervision ? Effect.fail(new UiError({message})) : failingWith(message, Effect.suspend(() => call(supervision)));
  const handlers = HttpApiBuilder.group(SupervisorApi, "guidance", (h) =>
    h.handleAll({
      snapshot: () => Effect.orDie(runtime.snapshot),
      dashboardOverview: ({query}) => supervised("The work overview is unavailable. Refresh to try again.",
        ({supervisor}) => Effect.suspend(() => supervisor.overview(overviewPage(query)))),
      noProjectControl: () => supervised("No Project mode unavailable.", ({supervisor}) => supervisor.noProjectControl()),
      saveNoProjectControl: ({payload}) => supervised("Reload the No Project mode before retrying.", ({supervisor}) => supervisor.saveNoProjectControl(payload)),
      supervisionCandidates: ({query}) => supervised("Chat search unavailable.", ({supervisor}) => supervisor.candidates(query.query, query.purpose)),
      startSupervision: ({payload}) => supervised("Start outcome is unknown. Check its original operation ID; do not replay.", ({control}) =>
        Effect.map(control.dashboardStart(payload.threadId, payload.operationId), (result) => ({...payload, status: result.status === "invalid" ? "denied" as const : result.status, reason: result.reason}))),
      supervisionStartStatus: ({query}) => supervised("Start status unavailable.", ({control}) => control.startStatus(query.threadId, query.operationId)),
      supervisionControl: ({query}) => supervised("Supervision control is unavailable.", ({supervisor}) => supervisor.control(query.projectId ?? null)),
      saveSupervisionControl: ({payload}) => supervised("The enable/disable outcome could not be confirmed. Reload before trying again.", ({supervisor}) => supervisor.saveControl(payload)),
      supervisionSetupOptions: ({query}) => supervised("Registered checkout options could not be loaded.", ({supervisor}) => supervisor.setupOptions(query.projectId)),
      setupSupervision: ({payload}) => supervised("The setup outcome could not be confirmed. Inspect the selected checkout before retrying.", ({supervisor}) => supervisor.setup(payload)),
      globalDefinitionsControl: () => supervised("Global rules control is unavailable.", ({supervisor}) => supervisor.globalDefinitionsControl),
      saveGlobalDefinitionsControl: ({payload}) => supervised("The global rules setup outcome could not be confirmed. Inspect ~/.t3-supervisor before retrying.",
        ({supervisor}) => supervisor.saveGlobalDefinitionsControl(payload)),
      projectSupervisor: ({query}) => supervised("Project supervision is unavailable. Check the T3 connection and registered project.",
        ({supervisor}) => supervisor.snapshot(query.projectId, query.mainThreadId ?? null)),
      workflowProgress: ({query}) => supervised("Live workflow progress is unavailable. Refresh and check the T3 connection.", ({supervisor}) => {
        const parsed = parseWorkflowProgressPageQuery(query);
        if (!workflowReader || !parsed) return Effect.fail<unknown>(new UiError({message: "Live workflow progress is unavailable. Refresh and check the T3 connection."}));
        return readWorkflowProgressPage(parsed).pipe(Effect.provideService(ProjectSupervisor, supervisor), Effect.provideService(WorkflowWriteController, workflowReader));
      }),
      saveProjectSupervisor: ({payload}) => supervised("Supervisor settings could not be confirmed. Refresh and inspect the current selection before saving again.",
        ({supervisor}) => supervisor.save(payload)),
      retryProjectSupervisor: ({payload}) => supervised("Native access retry could not be confirmed. Refresh to inspect the retained state.", ({supervisor}) => supervisor.retry(payload)),
      chatSupervision: ({payload}) => supervised("The chat supervision change could not be confirmed. Refresh to inspect the saved state.",
        ({supervisor}) => supervisor.setChatSupervision(payload)),
      projectConfiguration: ({query}) => !definitions ? Effect.fail(new UiError({message: "Project definition access is unavailable."}))
        : failingWith("Project definition access is unavailable.", Effect.map(Effect.suspend(() => definitions.load(query.projectId, query.threadId ?? null)),
          (result) => ({...result, editingAvailable: Boolean(editor)}))),
      saveProjectConfiguration: ({payload}) => !editor
        ? Effect.succeed({status: "permission_required" as const, message: "Project editing needs a dedicated filesystem:read/filesystem:write credential through deployment setup.", definitions: null})
        : failingWith("The save outcome could not be confirmed. Refresh and inspect project.yaml before retrying.", Effect.suspend(() => editor.save(payload))),
      threadPolicy: ({ payload }) => {
        const invalid = (cause: unknown) => new UiError({ message: cause instanceof Error ? cause.message : "Chat settings invalid. Reload first." });
        // each chat this editor adds or removes is a human Stop or Enable for that chat's supervision, saved as one admission
        // section; without supervision the policy alone is saved
        return supervision ? Effect.mapError(supervision.control.saveThreadPolicy(payload), invalid)
          : Effect.mapError(policy.save(payload), invalid);
      },
    }),
  );
  const csrf = base64url(yield* crypto.randomBytes(32));
  const assets = resolve(config.uiAssetsDirectory ?? "ui-dist");

  // GET /auth/status, POST /auth/login and /auth/logout from the supervisor's own origin; a started sign-in or sign-out
  // completes even when its client goes away, while the status read and the sign-in body read end with their request
  const authRequest = (request: HttpServerRequest.HttpServerRequest, origin: string) => Effect.gen(function* () {
    const path = pathOf(request);
    const session = sessionOf(request);
    if (path === "/auth/status" && request.method === "GET") return answer(200, {authenticated: yield* Effect.interruptible(auth.authenticated(session))});
    if (request.method !== "POST" || !["/auth/login", "/auth/logout"].includes(path)) return reject(404, "Not found.");
    if (request.headers.origin !== origin || request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json")
      return reject(403, "Use the Supervisor sign-in page.");
    if (path === "/auth/login") {
      // an unreadable body is an invalid sign-in like malformed json; only an oversized one fails the request
      const body = yield* Effect.interruptible(readBody(request, 2048)).pipe(
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
  // loopback address, and the workflow MCP host must name the receiving listener or a configured host. effect's server
  // runs a request uninterruptibly until its route matches, so the reads made here (the access check, a dashboard file,
  // a body) are interruptible themselves and end when the client goes away or the listener scope closes
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
      if (!url.pathname.startsWith("/api/")) return yield* answerFailures(Effect.interruptible(staticFile(routed)));
      if (!(yield* Effect.interruptible(auth.authenticated(sessionOf(request))))) return reject(401, "Sign in to Supervisor.");
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
      return yield* Effect.matchCauseEffect(Effect.interruptible(readBody(api, 64_000)), {onFailure: failedAnswer, onSuccess: () => routedApi});
    });
  }), {global: true});

  // the per-process csrf token for a signed-in dashboard; any other path below /api/csrf is an unmatched api route
  const csrfRoute = HttpRouter.add("GET", "/api/csrf", (request) => request.method === "GET" && pathOf(request) === "/api/csrf"
    ? Effect.succeed(answer(200, {csrf}))
    : Effect.fail(new HttpServerError.HttpServerError({reason: new HttpServerError.RouteNotFound({request})})));
  const apiRoutes = HttpApiBuilder.layer(SupervisorApi).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices));

  // one node listener serving the router in this scope; the scope drops its connections before releasing it. A listener
  // that cannot listen fails with its own reason
  const listen = <E, R>(routes: Layer.Layer<never, E, R>, port: number, host: string, unavailable: ListenerUnavailable["reason"]) => Effect.gen(function* () {
    const server = createServer();
    const context = yield* Layer.build(HttpRouter.serve(routes, {disableLogger: true, disableListenLog: true}).pipe(
      Layer.provideMerge(NodeHttpServer.layerServer(() => server, {port, host, disablePreemptiveShutdown: true})),
      Layer.provide(Layer.succeed(Headers.CurrentRedactedNames, redactedHeaders)),
    )).pipe(Effect.catchTag("ServeError", () => Effect.fail(new ListenerUnavailable({reason: unavailable}))));
    yield* Effect.addFinalizer(() => closeNow(server));
    const address = Context.get(context, HttpServer.HttpServer).address;
    return {server, port: address._tag === "UnixPathAddress" ? 0 : address.port};
  });

  const ui = yield* listen(Layer.mergeAll(apiRoutes, csrfRoute, WorkflowMcpRoute, gate(false, undefined)),
    config.uiPort ?? 9008, config.uiHost ?? "127.0.0.1", "dashboard_listener_unavailable");
  const mcpOnly = config.workflowMcpBindHost
    ? yield* listen(Layer.mergeAll(WorkflowMcpRoute, gate(true, ui.port)), config.workflowMcpPort ?? ui.port, config.workflowMcpBindHost,
      "workflow_mcp_listener_unavailable")
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
