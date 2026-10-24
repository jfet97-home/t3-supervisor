import { DashboardUpdates } from "../../src/dashboard-updates.js";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, type Scope } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import { SupervisorConfig as Configuration } from "../../src/config.js";
import { GuidanceDb, guidanceDbLayer, policyDbLayer } from "../../src/db.js";
import { GuidanceRuntime } from "../../src/guidance.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { GuidanceUi } from "../../src/guidance-ui.js";
import { SupervisorIds } from "../../src/ids.js";
import { InterpretationWake } from "../../src/interpretation-wake.js";
import { NativeEnvelope } from "../../src/native-envelope.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ProjectDefinitions } from "../../src/project-definitions.js";
import { ProjectSupervisorStore, SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { ProjectSupervisor, type ProjectSupervisorSeams } from "../../src/project-supervisor.js";
import { ScopeLocks } from "../../src/scope-locks.js";
import { ServiceAuth } from "../../src/service-auth.js";
import { Store, type StoreShape } from "../../src/store.js";
import { SupervisionControl } from "../../src/supervision-control.js";
import { SupervisionGate, SupervisionScopeService } from "../../src/supervision-gate.js";
import { SupervisionControllersLive, SupervisionScopeLive, SupervisionStoresLive, SupervisionTeamLive } from "../../src/supervision-live.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { HelperTransport } from "../../src/supervisor-helper-transport.js";
import { SupervisorLifecycle } from "../../src/supervisor-lifecycle.js";
import { NativeOperateRpc, NativeRpc, NativeShell } from "../../src/supervisor-native.js";
import { SupervisorTeamController } from "../../src/supervisor-team-controller.js";
import { SupervisorTeamRuntime } from "../../src/supervisor-team-runtime.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { makeT3Client } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { ProjectInfo, SupervisorSettings, ThreadInfo } from "../../src/types.js";
import { WorkflowMcp } from "../../src/workflow-mcp.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";
import { WorkflowWriteController } from "../../src/workflow-write-controller.js";

// the production object graph of one supervision run (src/guidance-application.ts with src/supervision-live.ts) built as layers
// in the caller's scope over a loopback T3 peer and temp files: the guidance client with its store and the supervision stores,
// the process's thread-policy store, the root's native clients on the read and operate credentials, the catalog, the definitions
// when given, and the run's services. The project supervisor is built with its unit seams (ProjectSupervisor.makeUnit) in
// place of ProjectSupervisor.layer, so a case can drive its binding creation; the rest is SupervisionLive's composition

export const readToken = "int-read-token";
export const operateToken = "int-operate-token";

export type IntCatalog = {projects: Array<{project: ProjectInfo; available: boolean}>; threads: ThreadInfo[]};
// the definitions snapshot of a main's checkout, read when the run asks
export type IntDefinitions = (projectId: string, threadId: string | null) => Effect.Effect<ProjectDefinitionSnapshot>;

export type IntRunInput = {
  directory: string;
  peerUrl: string;
  catalog: () => IntCatalog;
  definitions?: IntDefinitions | undefined;
  // the platform fetch of the helper webhook POSTs, which a case may observe
  fetch?: typeof globalThis.fetch | undefined;
};

/** The services of one run, as the suites drive them. */
export interface IntRun {
  readonly directory: string;
  // the run's configuration; a case may change a field the services read when they need it
  readonly config: SupervisorSettings;
  readonly source: Pick<StoreShape, "catalog">;
  readonly context: Context.Context<IntRunServices>;
  readonly sql: GuidanceDb["Service"];
  readonly store: ProjectSupervisorStore["Service"];
  readonly policy: ThreadPolicyStore["Service"];
  readonly requests: SupervisorConversationStore["Service"];
  readonly team: SupervisorTeamStore["Service"];
  readonly workflowStates: WorkflowStateStore["Service"];
  // the supervisor's scope predicates and the admission section that guards with them
  readonly scope: SupervisionScopeService["Service"];
  readonly gate: SupervisionGate["Service"];
  readonly helperTransport: HelperTransport["Service"];
  readonly teamRuntime: SupervisorTeamRuntime["Service"];
  readonly lifecycle: SupervisorLifecycle["Service"];
  readonly supervisor: ProjectSupervisor["Service"];
  readonly seams: ProjectSupervisorSeams;
  readonly control: SupervisionControl["Service"];
  readonly writes: WorkflowWriteController["Service"];
  readonly teamController: SupervisorTeamController["Service"];
}

// the supervisor's unit seams beside the service
class IntSupervisorSeams extends Context.Service<IntSupervisorSeams, ProjectSupervisorSeams>()("test/IntSupervisorSeams") {}

const settings = (input: IntRunInput): SupervisorSettings => ({dataDirectory: input.directory, t3Url: input.peerUrl, t3TokenFile: "unused",
  excludedThreadIds: [], healthPort: 0, uiPort: 0, uiHost: "127.0.0.1", uiAssetsDirectory: input.directory});

// the definitions service over the snapshot read; no other definitions operation is used and the global fingerprint is none
const definitionsService = (definitions: IntDefinitions): ProjectDefinitions["Service"] => {
  const unused = () => Effect.die(new Error("unused definitions operation"));
  return ProjectDefinitions.of({
    globalHomePath: "~", globalDefinitionsPath: "~/.t3-supervisor",
    load: (projectId, threadId = null) => definitions(projectId, threadId),
    globalFingerprint: () => Effect.succeed(null),
    presence: unused, presenceGlobal: unused, presenceForCheckout: unused, checkoutTargets: unused, currentWorkspace: unused,
    initialize: unused, initializeGlobal: unused, readProjectConfig: unused,
  });
};

// the catalog of the run's native source; nothing else of the source is used
const sourceOf = (input: IntRunInput): Pick<StoreShape, "catalog"> => ({catalog: () => Effect.sync(input.catalog)});

const intRunLayer = (input: IntRunInput, config: SupervisorSettings) => {
  const read = {baseUrl: config.t3Url, token: readToken};
  const ids = SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));
  // the run's guidance client and store, the supervision stores over them and the process's ownership set
  const stores = SupervisionStoresLive.pipe(
    Layer.provideMerge(GuidanceStore.layer.pipe(Layer.provideMerge(guidanceDbLayer(config.dataDirectory)))),
    Layer.provideMerge(Layer.mergeAll(ids, Layer.sync(SupervisorOwnership, () => new Set<string>()))));
  const policy = ThreadPolicyStore.layer.pipe(Layer.provide(policyDbLayer(config.dataDirectory)));
  // the root's native clients: the read client with its shell reads, the operate client, the T3 client, the catalog and the
  // definitions
  const natives = Layer.mergeAll(
    NativeShell.layer(read).pipe(Layer.provideMerge(NativeRpc.layer(read)), Layer.provide(FetchHttpClient.layer)),
    NativeOperateRpc.layer({baseUrl: config.t3Url, token: operateToken}),
    makeT3Client(read),
    Layer.succeed(Store, sourceOf(input) as StoreShape),
    input.definitions ? Layer.succeed(ProjectDefinitions, definitionsService(input.definitions)) : Layer.empty,
  ).pipe(Layer.provide(NativeEnvelope.layer));
  // the webhook POSTs go through the platform fetch, or the case's observed fetch; a fresh client, since the shell's and the T3
  // client's own instance of the shared layer is built over the platform fetch
  const fetch = Layer.fresh(FetchHttpClient.layer).pipe(Layer.provide(input.fetch ? Layer.succeed(FetchHttpClient.Fetch, input.fetch) : Layer.sync(FetchHttpClient.Fetch, () => globalThis.fetch)));
  const definitions = input.definitions;
  const supervisor = Layer.effectContext(Effect.map(ProjectSupervisor.makeUnit(definitions ? {definitions: {load: (projectId, threadId) => definitions(projectId, threadId)}} : {}),
    (unit) => Context.make(ProjectSupervisor, unit.service).pipe(Context.add(IntSupervisorSeams, unit.seams))));
  // SupervisionLive({operateRpcAvailable: true, baseUrl}) with the supervisor's seams
  return supervisor.pipe(
    Layer.provideMerge(SupervisionControllersLive({})),
    Layer.provideMerge(SupervisionTeamLive({baseUrl: config.t3Url})),
    Layer.provideMerge(SupervisionScopeLive(true)),
    Layer.provideMerge(Layer.mergeAll(ScopeLocks.layer, SupervisorIds.layer, InterpretationWake.layer)),
    Layer.provideMerge(Layer.mergeAll(natives, stores, policy, fetch)),
    Layer.provideMerge(Layer.succeed(Configuration, config)),
    Layer.provide(Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer)),
  );
};

export type IntRunServices = Layer.Success<ReturnType<typeof intRunLayer>>;

/** One supervision run over the files of `directory`, released with the scope, as a process exit ends it. */
export const intRun = (input: IntRunInput): Effect.Effect<IntRun, never, Scope.Scope> => Effect.gen(function* () {
  const config = settings(input);
  const context = yield* Layer.build(intRunLayer(input, config)).pipe(Effect.orDie);
  return {
    directory: input.directory, config, source: sourceOf(input), context,
    sql: Context.get(context, GuidanceDb), store: Context.get(context, ProjectSupervisorStore), policy: Context.get(context, ThreadPolicyStore),
    requests: Context.get(context, SupervisorConversationStore), team: Context.get(context, SupervisorTeamStore),
    workflowStates: Context.get(context, WorkflowStateStore), scope: Context.get(context, SupervisionScopeService), gate: Context.get(context, SupervisionGate),
    helperTransport: Context.get(context, HelperTransport), teamRuntime: Context.get(context, SupervisorTeamRuntime),
    lifecycle: Context.get(context, SupervisorLifecycle), supervisor: Context.get(context, ProjectSupervisor), seams: Context.get(context, IntSupervisorSeams),
    control: Context.get(context, SupervisionControl), writes: Context.get(context, WorkflowWriteController),
    teamController: Context.get(context, SupervisorTeamController),
  };
});

export type IntEndpoint = {port: number; token: string};

/**
 * The dashboard and the workflow MCP endpoint of a run, as guidance-application.ts builds them: the api handlers yield the run's
 * services and the MCP endpoint consumes its write and team controllers; released with the scope, before the run.
 */
export const intEndpoint = (run: IntRun): Effect.Effect<IntEndpoint, never, Scope.Scope> => Effect.gen(function* () {
  const runtime = yield* GuidanceRuntime.make(run.config, run.source).pipe(Effect.provide(run.context));
  const ui = yield* Layer.build(GuidanceUi.layer(run.config, {supervision: {supervisor: run.supervisor, control: run.control}, workflowReader: run.writes}).pipe(
    Layer.provide(Layer.mergeAll(ServiceAuth.layer(run.directory), Layer.succeed(GuidanceRuntime, runtime), WorkflowMcp.layer)),
    Layer.provide(Layer.succeedContext(run.context)),
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, DashboardUpdates.layer)))).pipe(Effect.orDie);
  const token = yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(join(run.directory, "access", "workflow-mcp-token"))).pipe(
    Effect.provide(NodeFileSystem.layer), Effect.orDie);
  return {port: Context.get(ui, GuidanceUi).port, token};
});

// the platform fetch, as the suites' own client
const fetchClient = FetchHttpClient.layer.pipe(Layer.provide(Layer.sync(FetchHttpClient.Fetch, () => globalThis.fetch)));

export type HttpReply = {status: number; body: unknown};

/** One request through effect's fetch client, its body parsed as JSON. */
export const httpJson = (url: string, init: {method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown} = {}): Effect.Effect<HttpReply> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = (init.method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url)).pipe(HttpClientRequest.setHeaders(init.headers ?? {}),
      (value) => init.body === undefined ? value : HttpClientRequest.setBody(value, HttpBody.text(JSON.stringify(init.body), "application/json")));
    const response = yield* client.execute(request);
    return {status: response.status, body: yield* response.json};
  }).pipe(Effect.orDie, Effect.provide(fetchClient));

export type McpReply = {httpStatus: number; isError: boolean; value: unknown};

let rpcId = 0;
/** One stateless JSON-RPC tools/call to the workflow MCP route, without initialize. */
export const mcpCall = (endpoint: IntEndpoint, name: string, args: unknown): Effect.Effect<McpReply> =>
  Effect.map(httpJson(`http://127.0.0.1:${endpoint.port}/mcp/workflows`, {method: "POST",
    headers: {Authorization: `Bearer ${endpoint.token}`, Accept: "application/json, text/event-stream"},
    body: {jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: {name, arguments: args}}}), (reply) => {
    const body = reply.body as {result?: {isError?: boolean; content?: Array<{text?: string}>}};
    return {httpStatus: reply.status, isError: body.result?.isError === true, value: JSON.parse(body.result?.content?.[0]?.text ?? "null")};
  });

/** A raw POST of a workflow_read call to the MCP route with explicit headers; Host needs node:http because fetch forbids it. */
export const mcpRawPost = (port: number, headers: Record<string, string>): Effect.Effect<HttpReply> => Effect.callback<HttpReply>((resume) => {
  const payload = JSON.stringify({jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
  const request = httpRequest({host: "127.0.0.1", port, path: "/mcp/workflows", method: "POST",
    headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(payload), ...headers}},
  (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.once("end", () => resume(Effect.sync(() => ({status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown}))));
    response.once("error", (error) => resume(Effect.die(error)));
  });
  request.once("error", (error) => resume(Effect.die(error)));
  request.end(payload);
  // an interrupted post ends its request
  return Effect.sync(() => request.destroy());
});

/** A temporary data directory, removed with the scope. */
export const temporaryDirectory = (prefix: string): Effect.Effect<string, never, Scope.Scope> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({prefix})).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie);

/** Runs one statement on the run's guidance client, as a suite's direct write to the file. */
export const execute = (sql: GuidanceDb["Service"], statement: string, ...params: ReadonlyArray<unknown>): Effect.Effect<void> =>
  sql.unsafe(statement, params).pipe(Effect.asVoid, Effect.orDie);

/** The rows of a query on the run's guidance client. */
export const rows = (sql: GuidanceDb["Service"], query: string, ...params: ReadonlyArray<unknown>): Effect.Effect<Array<Record<string, unknown>>> =>
  sql.unsafe<Record<string, unknown>>(query, params).pipe(Effect.map((found) => [...found]), Effect.orDie);

/** The first row of a query, or undefined. */
export const row = (sql: GuidanceDb["Service"], query: string, ...params: ReadonlyArray<unknown>): Effect.Effect<Record<string, unknown> | undefined> =>
  Effect.map(rows(sql, query, ...params), (found) => found[0]);

/** Replaces one method of a service the run's callers hold for the rest of the scope; the replacement receives the original. */
export const interpose = <S extends object, K extends keyof S>(service: S, key: K, replace: (original: S[K]) => S[K]): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(() => {
    const own = service[key];
    (service as Record<K, S[K]>)[key] = replace((own as (...args: Array<unknown>) => unknown).bind(service) as S[K]);
    return own;
  }), (own) => Effect.sync(() => {(service as Record<K, S[K]>)[key] = own;})).pipe(Effect.asVoid);

/** Runs `work` once, on the first call that satisfies `when`. */
export const once = <A extends unknown[]>(when: (...args: A) => boolean, work: Effect.Effect<void>): ((...args: A) => Effect.Effect<void>) => {
  let done = false;
  return (...args: A) => Effect.suspend(() => {
    if (done || !when(...args)) return Effect.void;
    done = true;
    return work;
  });
};
