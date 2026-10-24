import {journeyCases, type JourneyCase} from "./journey.js";
import { ByteSize, Cause, Context, Deferred, Effect, Layer, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { SupervisorApi, UiError } from "../../src/guidance-contract.js";
import {
  FixtureFailure, FixtureModel, fixtureEnvironmentNames, fixtureToken, isFixtureEnvironmentName, isScenarioName, parseScenarioParams, scenarioCatalog, scenarioNames,
  type Arm, type FixtureEnvironmentName, type ForcedOutcome, type ScenarioName, type ScenarioParams,
} from "./scenarios.js";

export type AssetInfo = {path: string; bytes: number; sha256: string};
export type LogEntry = {
  seq: number;
  at: number;
  method: string;
  path: string;
  kind: "api" | "auth" | "fixture" | "static";
  mutation: boolean;
  scenario: ScenarioName;
  // the T3 environment the fixture answered for when the request arrived
  environment: string;
  bodySha256: string | null;
  bodyBytes: number | null;
  effect: string | null;
  result: "pending" | "answered" | "held" | "dropped" | "interrupted";
  status: number | null;
  completedAt: number | null;
};
export type UiFixtureOptions = {assets: string; port?: number; scenario?: ScenarioName; params?: ScenarioParams; now?: () => number};
export type UiFixture = {url: string; port: number; assetsDirectory: string; assets: readonly AssetInfo[]; token: string; controller: FixtureController};

const loopback = "127.0.0.1";
const apiBodyLimit = 64_000;
const loginBodyLimit = 2048;
const tooLarge = "The request payload is too large. Reduce its size before retrying.";
const securityHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "vary": "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Sec-Fetch-User",
};
// the baseline injects a script nonce into index.html; the fixture serves bytes unchanged, so scripts are allowed from 'self' instead
const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sameSecret = (candidate: string, expected: string) => {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, {status});
const message = (status: number, text: string) => json(status, {message: text});
const header = (request: HttpServerRequest.HttpServerRequest, name: string): string | undefined => {
  const value: unknown = request.headers[name];
  return typeof value === "string" ? value : undefined;
};

export const listAssets = async (directory: string): Promise<AssetInfo[]> => {
  const found: AssetInfo[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, {withFileTypes: true})) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        found.push({path: relative(directory, path).split(sep).join("/"), bytes: bytes.length, sha256: sha256(bytes)});
      }
    }
  };
  await walk(directory);
  return found.sort((left, right) => left.path.localeCompare(right.path));
};

class RequestLog {
  private entries: LogEntry[] = [];
  private sequence = 0;
  private evicted = 0;
  constructor(private readonly started: number, private readonly limit = 2000) {}
  private clock() {return Math.round((performance.now() - this.started) * 10) / 10;}
  begin(input: Pick<LogEntry, "method" | "path" | "kind" | "mutation" | "scenario" | "environment">): LogEntry {
    const entry: LogEntry = {...input, seq: ++this.sequence, at: this.clock(), bodySha256: null, bodyBytes: null, effect: null, result: "pending", status: null, completedAt: null};
    this.entries.push(entry);
    if (this.entries.length > this.limit) {this.entries.shift();this.evicted++;}
    return entry;
  }
  settle(entry: LogEntry | null, result: LogEntry["result"], status: number | null = null) {
    if (!entry || result === "interrupted" && entry.completedAt !== null) return;
    if (result === "held") entry.result = "held";
    else Object.assign(entry, {result, status, completedAt: this.clock()});
  }
  get size() {return this.entries.length;}
  clear(keep: LogEntry | null = null) {
    this.entries = keep ? [keep] : [];
    this.evicted = 0;
  }
  view(since = 0) {
    const entries = this.entries.filter(entry => entry.seq > since);
    const mutations = new Map<string, {method: string; path: string; bodySha256: string | null; count: number; seqs: number[]}>();
    const polls = new Map<string, {path: string; count: number; at: number[]}>();
    for (const entry of this.entries) {
      const path = entry.path.split("?", 1)[0]!;
      if (entry.mutation) {
        const key = JSON.stringify([entry.method, path, entry.bodySha256]);
        const group = mutations.get(key) ?? {method: entry.method, path, bodySha256: entry.bodySha256, count: 0, seqs: []};
        group.count++;group.seqs.push(entry.seq);mutations.set(key, group);
      } else if (entry.kind === "api" && entry.method === "GET") {
        const group = polls.get(path) ?? {path, count: 0, at: []};
        group.count++;group.at.push(entry.at);polls.set(path, group);
      }
    }
    return {
      total: this.sequence, retained: this.entries.length, evicted: this.evicted, entries,
      mutations: [...mutations.values()],
      polls: [...polls.values()].map(group => ({path: group.path, count: group.count,
        intervalsMs: group.at.slice(1).map((value, index) => Math.round(value - group.at[index]!)).slice(-10)})),
    };
  }
}

type Held = {seq: number; path: string; deferred: Deferred.Deferred<"answer" | "drop">};

export class FixtureController {
  readonly model: FixtureModel;
  readonly log = new RequestLog(performance.now());
  readonly csrf = randomBytes(32).toString("base64url");
  readonly held = new Map<number, Held>();
  scenario: ScenarioName = "baseline";
  arms: Arm[] = [];
  port = 0;
  closed = false;
  private sessions: string[] = [];
  private grants = new Set<string>();
  constructor(readonly now: () => number) {this.model = new FixtureModel(now);}

  get origin() {return `http://${loopback}:${this.port}`;}
  get sessionCount() {return this.sessions.length;}
  authenticated(session: string | undefined) {return session !== undefined && this.sessions.includes(session);}
  login(token: string): string | null {
    if (token !== fixtureToken && !this.grants.delete(token)) return null;
    const session = randomBytes(32).toString("base64url");
    this.sessions = [...this.sessions, session].slice(-32);
    return session;
  }
  logout(session: string | undefined) {this.sessions = this.sessions.filter(item => item !== session);}
  grant() {
    const token = `fixture-grant-${randomBytes(12).toString("base64url")}`;
    this.grants.add(token);
    return token;
  }
  apply(name: ScenarioName, params: ScenarioParams = {path: null, apply: false, ms: null}) {
    const plan = scenarioCatalog[name].plan(params);
    this.scenario = name;
    if (name === "large-interface") this.model.setLargeInterface();
    else if (name === "baseline") this.model.setJourney(null);
    else if (name.startsWith("journey-") && journeyCases.includes(name.slice(8) as JourneyCase)) this.model.setJourney(name.slice(8) as JourneyCase);
    this.arms = plan.arms;
    if (plan.revokeSessions) this.sessions = [];
  }
  // one-shot arms are consumed when they fire; slow reads stay until the scenario changes
  take(matches: (arm: Arm) => boolean): Arm | undefined {
    const index = this.arms.findIndex(matches);
    if (index < 0) return undefined;
    const arm = this.arms[index]!;
    if (arm.kind !== "slow-reads") this.arms = this.arms.filter((_, position) => position !== index);
    return arm;
  }
  release(decision: "answer" | "drop", seq: number | null = null) {
    const targets = [...this.held.values()].filter(item => seq === null || item.seq === seq);
    for (const item of targets) this.held.delete(item.seq);
    return Effect.as(Effect.forEach(targets, item => Deferred.succeed(item.deferred, decision), {discard: true}), targets.map(item => item.seq));
  }
  reset(keep: LogEntry | null) {
    return Effect.tap(this.release("drop"), () => Effect.sync(() => {
      this.model.reset();
      this.scenario = "baseline";
      this.arms = [];
      this.sessions = [];
      this.grants.clear();
      this.log.clear(keep);
    }));
  }
  state(catalog = false) {
    return {
      scenario: this.scenario, armed: this.arms, sessions: this.sessions.length,
      held: [...this.held.values()].map(item => ({seq: item.seq, path: item.path})),
      ...(catalog ? {environment: this.model.environment, environments: fixtureEnvironmentNames,
        scenarios: scenarioNames.map(name => ({name, description: scenarioCatalog[name].description}))} : {}),
    };
  }
  close() {
    this.closed = true;
    this.sessions = [];
    this.grants.clear();
    this.arms = [];
    this.held.clear();
    this.log.clear();
  }
}

const Forced = Context.Reference<ForcedOutcome | null>("ui-fixture/ForcedOutcome", {defaultValue: () => null});
const CurrentEntry = Context.Reference<LogEntry | null>("ui-fixture/CurrentEntry", {defaultValue: () => null});
// the environment the fixture answered for when the request arrived; a held or delayed request still computes in it
const ReceiptEnvironment = Context.Reference<FixtureEnvironmentName | null>("ui-fixture/ReceiptEnvironment", {defaultValue: () => null});

// reads the cached request body once, bounded like the baseline server, and records only its sha256 and size
const readBody = (request: HttpServerRequest.HttpServerRequest, limit: number) => Effect.gen(function*() {
  const entry = yield* CurrentEntry;
  const declared = Number(header(request, "content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    NodeHttpServerRequest.toIncomingMessage(request).resume();
    if (entry) entry.bodyBytes = declared;
    return null;
  }
  const buffer = yield* request.arrayBuffer.pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(limit)), Effect.option);
  if (buffer._tag === "None") return null;
  const bytes = new Uint8Array(buffer.value);
  if (entry) Object.assign(entry, {bodySha256: sha256(bytes), bodyBytes: bytes.length});
  return bytes;
});

const failure = (cause: unknown) => new UiError({message: cause instanceof FixtureFailure ? cause.message : "Fixture: the operation failed."});

const apiHandlers = (controller: FixtureController) => {
  const model = controller.model;
  // every model call runs against the environment of its request's receipt
  const read = <A>(evaluate: () => A) => Effect.flatMap(ReceiptEnvironment, environment =>
    Effect.try({try: () => environment === null ? evaluate() : model.inEnvironment(environment, evaluate), catch: failure}));
  const mutate = <A>(evaluate: (forced: ForcedOutcome | null) => A) => Effect.flatMap(Forced, forced => read(() => evaluate(forced)));
  return HttpApiBuilder.group(SupervisorApi, "guidance", handlers => handlers.handleAll({
    snapshot: () => Effect.orDie(read(() => model.guidanceSnapshot(controller.now()))),
    dashboardOverview: ({query}) => read(() => model.dashboardOverview(query, controller.now())),
    noProjectControl: () => read(() => model.noProjectControl()),
    saveNoProjectControl: ({payload}) => mutate(forced => model.saveNoProjectControl(payload, forced)),
    supervisionCandidates: ({query}) => read(() => model.candidates(query.query, query.purpose)),
    startSupervision: ({payload}) => mutate(forced => model.startSupervision(payload, forced)),
    supervisionStartStatus: ({query}) => read(() => model.startStatus(query.threadId, query.operationId)),
    supervisionControl: ({query}) => read(() => model.supervisionControl(query.projectId ?? null)),
    saveSupervisionControl: ({payload}) => mutate(forced => model.saveSupervisionControl(payload, forced)),
    supervisionSetupOptions: ({query}) => read(() => model.setupOptions(query.projectId)),
    setupSupervision: ({payload}) => mutate(forced => model.setupSupervision(payload, forced)),
    globalDefinitionsControl: () => read(() => model.globalDefinitionsControl()),
    saveGlobalDefinitionsControl: ({payload}) => mutate(forced => model.saveGlobalDefinitionsControl(payload, forced)),
    projectSupervisor: ({query}) => read(() => model.projectSupervisor(query.projectId, query.mainThreadId ?? null)),
    workflowProgress: ({query}) => read(() => model.workflowProgress(query, controller.now())),
    saveProjectSupervisor: ({payload}) => mutate(forced => model.saveProjectSupervisor(payload, forced)),
    retryProjectSupervisor: ({payload}) => mutate(forced => model.retryProjectSupervisor(payload, forced)),
    chatSupervision: ({payload}) => mutate(forced => model.chatSupervision(payload, forced)),
    projectCheckouts: ({query}) => read(() => model.checkoutInventory(query.projectId)),
    projectConfiguration: ({query}) => read(() => model.projectDefinitions(query.projectId, query.threadId ?? null)),
    saveProjectConfiguration: ({payload}) => mutate(forced => model.saveProjectConfiguration(payload, forced)),
    threadPolicy: ({payload}) => mutate(forced => model.saveThreadPolicy(payload, forced)),
  }));
};

// mirrors the baseline /auth/* handling with in-memory fixture sessions
const authRoute = (controller: FixtureController) => (request: HttpServerRequest.HttpServerRequest) => Effect.gen(function*() {
  const path = new URL(request.url, controller.origin).pathname;
  const session = header(request, "x-supervisor-session");
  if (path === "/auth/status" && request.method === "GET") return json(200, {authenticated: controller.authenticated(session)});
  if (request.method !== "POST" || !["/auth/login", "/auth/logout"].includes(path)) return message(404, "Not found.");
  if (header(request, "origin") !== controller.origin || header(request, "content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    return message(403, "Use the Supervisor sign-in page.");
  if (path === "/auth/logout") {
    controller.logout(session);
    return json(200, {authenticated: false});
  }
  const body = yield* readBody(request, loginBodyLimit);
  if (!body) return message(413, tooLarge);
  let payload: unknown;
  try {payload = JSON.parse(Buffer.from(body).toString("utf8"));} catch {return message(400, "Invalid sign-in request.");}
  const token = typeof payload === "object" && payload !== null && "token" in payload && typeof payload.token === "string" ? payload.token : "";
  const created = controller.login(token);
  if (!created) return message(401, "The access token is invalid.");
  controller.logout(session);
  return json(200, {authenticated: true, session: created});
});

const fixtureRoutes = (controller: FixtureController) => {
  const releaseRoute = (decision: "answer" | "drop") => (request: HttpServerRequest.HttpServerRequest) => {
    const seq = new URL(request.url, controller.origin).searchParams.get("seq");
    if (seq !== null && !/^\d+$/u.test(seq)) return Effect.succeed(message(400, "seq must be a request sequence number."));
    return Effect.map(controller.release(decision, seq === null ? null : Number(seq)), released => json(200, {decision, released}));
  };
  return Layer.mergeAll(
    HttpRouter.add("POST", "/__fixture/reset", Effect.gen(function*() {
      yield* controller.reset(yield* CurrentEntry);
      return json(200, {reset: true, ...controller.state()});
    })),
    HttpRouter.add("POST", "/__fixture/scenario/:name", request => Effect.gen(function*() {
      const name = (yield* HttpRouter.params).name ?? "";
      if (!isScenarioName(name)) return json(404, {message: "Unknown fixture scenario.", scenarios: scenarioNames});
      const params = parseScenarioParams(new URL(request.url, controller.origin).searchParams);
      if (typeof params === "string") return message(400, params);
      controller.apply(name, params);
      return json(200, controller.state());
    })),
    HttpRouter.add("POST", "/__fixture/environment/:name", Effect.gen(function*() {
      const name = (yield* HttpRouter.params).name ?? "";
      if (!isFixtureEnvironmentName(name)) return json(404, {message: "Unknown fixture environment.", environments: fixtureEnvironmentNames});
      controller.model.switchEnvironment(name);
      return json(200, {environment: controller.model.environment, ...controller.state()});
    })),
    HttpRouter.add("GET", "/__fixture/state", Effect.sync(() => json(200, controller.state(true)))),
    HttpRouter.add("GET", "/__fixture/log", request => Effect.sync(() => {
      const since = new URL(request.url, controller.origin).searchParams.get("since");
      return json(200, controller.log.view(since !== null && /^\d+$/u.test(since) ? Number(since) : 0));
    })),
    HttpRouter.add("POST", "/__fixture/held/answer", releaseRoute("answer")),
    HttpRouter.add("POST", "/__fixture/held/drop", releaseRoute("drop")),
    HttpRouter.add("POST", "/__fixture/grant", Effect.sync(() => json(200, {token: controller.grant(), singleUse: true}))),
  );
};

// mirrors the baseline static handling: "/" is index.html, no other fallback, bytes are served unchanged
const staticRoute = (controller: FixtureController, assets: string) => (request: HttpServerRequest.HttpServerRequest) => Effect.gen(function*() {
  const pathname = new URL(request.url, controller.origin).pathname;
  if (pathname.startsWith("/api/") || pathname.startsWith("/__fixture/")) return message(404, "Not found.");
  if (request.method !== "GET") return message(405, "Method not allowed.");
  let relativePath: string;
  try {relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).slice(1);}
  catch {return message(500, "Supervisor operation unavailable.");}
  const path = resolve(assets, relativePath);
  if (!path.startsWith(assets + sep)) return message(404, "Not found.");
  const bytes = yield* Effect.option(Effect.tryPromise(() => readFile(path)));
  if (bytes._tag === "None") return message(404, "Not found.");
  return HttpServerResponse.uint8Array(bytes.value, {status: 200, contentType: contentTypes[extname(path)] ?? "application/octet-stream",
    headers: {"content-security-policy": contentSecurityPolicy}});
});

const appLayer = (controller: FixtureController, assets: string) => Layer.mergeAll(
  HttpApiBuilder.layer(SupervisorApi).pipe(Layer.provide(apiHandlers(controller))),
  HttpRouter.add("GET", "/api/csrf", Effect.sync(() => json(200, {csrf: controller.csrf}))),
  HttpRouter.add("*", "/auth/*", authRoute(controller)),
  fixtureRoutes(controller),
  HttpRouter.add("*", "/", staticRoute(controller, assets)),
  HttpRouter.add("*", "/*", staticRoute(controller, assets)),
).pipe(Layer.provide(NodeHttpServer.layerHttpServices));

const mutationArm = (path: string) => (arm: Arm) =>
  (arm.kind === "status" || arm.kind === "hold" || arm.kind === "drop" || arm.kind === "outcome" || arm.kind === "delayed-answer") &&
  (arm.path === null || arm.path === path);

type Receipt = {request: HttpServerRequest.HttpServerRequest; path: string; kind: LogEntry["kind"]; scenario: ScenarioName; entry: LogEntry | null;
  environment: FixtureEnvironmentName};

// records the receipt before any check, so every request except log and state reads appears once in the log
const gate = <E, R>(controller: FixtureController, app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, controller.origin);
  const path = url.pathname;
  const scenario = controller.scenario;
  const kind = path.startsWith("/api/") ? "api" as const : path.startsWith("/auth/") ? "auth" as const : path.startsWith("/__fixture/") ? "fixture" as const : "static" as const;
  const quiet = request.method === "GET" && (path === "/__fixture/log" || path === "/__fixture/state");
  const environment = controller.model.environment;
  const entry = quiet ? null : controller.log.begin({method: request.method, path: path + url.search, kind, scenario, environment: environment.environmentId,
    mutation: request.method !== "GET" && request.method !== "HEAD" && (kind === "api" || kind === "auth")});
  return yield* screen(controller, app, {request, path, kind, scenario, entry, environment: environment.name}).pipe(Effect.onInterrupt(() => Effect.sync(() => controller.log.settle(entry, "interrupted"))));
}).pipe(Effect.interruptible);

// cross-cutting checks in the baseline order (host/origin, session, csrf, content type, body bound), then scenario effects and labels
const screen = <E, R>(controller: FixtureController, app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>, receipt: Receipt) => Effect.gen(function*() {
  const {request, path, kind, scenario, entry, environment} = receipt;
  const origin = controller.origin;
  const mark = (effect: string) => {if (entry) entry.effect = effect;};
  const finish = (response: HttpServerResponse.HttpServerResponse) => {
    controller.log.settle(entry, "answered", response.status);
    return HttpServerResponse.setHeaders(response, {...securityHeaders, ...response.headers, "x-supervisor-fixture": scenario});
  };
  const compute = app.pipe(
    Effect.provideService(CurrentEntry, entry),
    Effect.provideService(ReceiptEnvironment, environment),
    Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed(message(500, "Supervisor operation unavailable."))),
  );
  const drop = Effect.andThen(Effect.sync(() => {
    controller.log.settle(entry, "dropped");
    NodeHttpServerRequest.toIncomingMessage(request).socket.destroy();
  }), Effect.never);
  const host = header(request, "host");
  const requestOrigin = header(request, "origin");
  const navigation = request.method === "GET" && (path === "/" || path === "/index.html") && header(request, "sec-fetch-mode") === "navigate" &&
    header(request, "sec-fetch-dest") === "document" && header(request, "sec-fetch-user") === "?1";
  const browserRejected = Boolean(requestOrigin) && requestOrigin !== origin || header(request, "sec-fetch-site") === "cross-site" && !navigation;
  if (host !== `${loopback}:${controller.port}` || browserRejected) return finish(message(403, "Open the supervisor through its loopback address."));
  if (kind !== "api") return finish(yield* compute);

  const session = header(request, "x-supervisor-session");
  if (!controller.authenticated(session)) return finish(message(401, "Sign in to Supervisor."));
  if (controller.take(arm => arm.kind === "session-expiry")) {
    controller.logout(session);
    mark("session-expired");
    return finish(message(401, "Sign in to Supervisor."));
  }
  if (request.method === "GET" && path === "/api/events") {
    const bytes = new TextEncoder().encode('event: reset\nid: 0\ndata: {"keys":[]}\n\n');
    return finish(HttpServerResponse.stream(Stream.concat(Stream.make(bytes), Stream.never), {headers: {"content-type": "text/event-stream", "cache-control": "no-store"}}));
  }
  if (request.method !== "GET") {
    const csrf = header(request, "x-csrf-token");
    if (requestOrigin !== origin || csrf === undefined || !sameSecret(csrf, controller.csrf))
      return finish(message(403, "Refresh the local dashboard before changing settings."));
    if (!header(request, "content-type")?.startsWith("application/json")) return finish(message(415, "Use JSON for supervisor mutations."));
    const body = yield* readBody(request, apiBodyLimit).pipe(Effect.provideService(CurrentEntry, entry));
    if (!body) return finish(message(413, tooLarge));
  }
  if (request.method === "GET" && path.startsWith("/api/guidance/")) {
    const slow = controller.take(arm => arm.kind === "slow-reads");
    if (slow?.kind === "slow-reads") {
      mark(`delayed-${slow.ms}ms`);
      yield* Effect.sleep(slow.ms);
    }
    return finish(yield* compute);
  }
  const arm = request.method === "POST" && path.startsWith("/api/guidance/") ? controller.take(mutationArm(path)) : undefined;
  if (!arm) return finish(yield* compute);
  switch (arm.kind) {
    case "status": {
      mark(`status-${arm.status}`);
      if (arm.status === 401) controller.logout(session);
      return finish(arm.status === 401 ? message(401, "Sign in to Supervisor.")
        : arm.status === 403 ? message(403, "Refresh the local dashboard before changing settings.")
          : arm.status === 413 ? message(413, tooLarge)
            : message(409, "Fixture: synthetic http 409; the baseline server never sends this status."));
    }
    case "outcome": {
      mark(`outcome-${arm.outcome}${arm.apply ? "-applied" : ""}`);
      return finish(yield* compute.pipe(Effect.provideService(Forced, {outcome: arm.outcome, apply: arm.apply})));
    }
    case "delayed-answer": {
      const response = yield* compute;
      mark(`applied-then-delayed-${arm.ms}ms`);
      yield* Effect.sleep(arm.ms);
      return finish(response);
    }
    case "drop": {
      if (arm.apply) yield* compute;
      mark(arm.apply ? "dropped-after-apply" : "dropped");
      return yield* drop;
    }
    case "hold": {
      const applied = arm.apply ? yield* compute : null;
      mark(arm.apply ? "held-after-apply" : "held");
      const deferred = yield* Deferred.make<"answer" | "drop">();
      const seq = entry?.seq ?? 0;
      controller.held.set(seq, {seq, path, deferred});
      controller.log.settle(entry, "held");
      const decision = yield* Deferred.await(deferred).pipe(Effect.ensuring(Effect.sync(() => controller.held.delete(seq))));
      if (decision === "drop") return yield* drop;
      mark(arm.apply ? "held-after-apply-then-answered" : "held-then-answered");
      return finish(applied ?? (yield* compute));
    }
    case "session-expiry":
    case "slow-reads":
      return finish(yield* compute);
  }
});

// starts the fixture in the current scope; closing the scope closes every connection, stops the server and releases the log
export const startUiFixture = (options: UiFixtureOptions) => Effect.gen(function*() {
  const assetsDirectory = resolve(options.assets);
  const assets = yield* Effect.tryPromise({try: () => listAssets(assetsDirectory), catch: () => new Error(`ui fixture assets are not readable: ${assetsDirectory}`)});
  if (!assets.some(asset => asset.path === "index.html")) return yield* Effect.fail(new Error(`ui fixture assets have no index.html: ${assetsDirectory}`));
  const controller = new FixtureController(options.now ?? Date.now);
  if (options.scenario) controller.apply(options.scenario, options.params);
  yield* Effect.addFinalizer(() => Effect.sync(() => controller.close()));
  const app = yield* HttpRouter.toHttpEffect(appLayer(controller, assetsDirectory));
  const server = createServer();
  const http = yield* NodeHttpServer.make(() => server, {host: loopback, port: options.port ?? 0});
  const address = server.address();
  if (typeof address !== "object" || address === null || address.address !== loopback) return yield* Effect.fail(new Error("ui fixture is not bound to 127.0.0.1"));
  controller.port = address.port;
  yield* http.serve(gate(controller, app));
  yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()));
  return {url: `${controller.origin}/`, port: address.port, assetsDirectory, assets, token: fixtureToken, controller} satisfies UiFixture;
});
