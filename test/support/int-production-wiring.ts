import { Context, Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { supervisorTeamControllerFacade, supervisorTeamServices, supervisorWorkflowControllers, workflowWriteControllerFacade } from "./root-facades.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { NativeEnvelope } from "../../src/native-envelope.js";
import { GuidanceRuntime } from "../../src/guidance.js";
import { startGuidanceUi } from "./service-auth-harness.js";
import { ProjectSupervisorStore, loadSupervisorOwnership } from "../../src/project-supervisor-store.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import type { StoreShape } from "../../src/store.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope } from "../../src/supervision-gate.js";
import { ProjectDefinitions } from "../../src/project-definitions.js";
import { buildProjectSupervisor, definitionsService, projectSupervisorFacade, type ProjectSupervisorUnit } from "./team-units.js";
import { NativeOperateRpc, NativeRpc, NativeShell, type NativeRpcShape, type SupervisorRpc } from "../../src/supervisor-native.js";
import { makeSupervisorRpc } from "./supervisor-native-client.js";
import { SupervisorTeamController } from "../../src/supervisor-team-controller.js";
import { makeT3Client, T3Client, type T3ClientShape } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { ProjectInfo, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import { WorkflowMcp } from "../../src/workflow-mcp.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "../../src/workflow-write-controller.js";
import { SupervisorIds } from "../../src/ids.js";
import { NodeCrypto } from "@effect/platform-node";

// the production object graph of src/main.ts, src/guidance-application.ts and src/supervision-live.ts, built over a loopback
// peer and temp files

export const readToken = "int-read-token";
export const operateToken = "int-operate-token";

export type IntCatalog = {projects: Array<{project: ProjectInfo; available: boolean}>; threads: ThreadInfo[]};
export type IntDefinitions = {load(projectId: string, threadId: string, signal: AbortSignal): Promise<ProjectDefinitionSnapshot>};

export type IntSupervision = {
  directory: string;
  config: SupervisorConfig;
  policy: ThreadPolicyStore;
  guidance: GuidanceStore;
  store: ProjectSupervisorStore;
  source: Pick<StoreShape, "catalog">;
  t3: T3ClientShape;
  readRpc: SupervisorRpc;
  operateRpc: SupervisorRpc;
  supervision: ProjectSupervisorUnit;
  // the operate client and the services of the supervision run, which the controllers share with it
  operate: NativeRpcShape;
  services: ProjectSupervisorUnit["services"];
  // the workflow write and team controllers of the run
  writes: WorkflowWriteController["Service"];
  team: SupervisorTeamController["Service"];
  // closes both database files, as a process exit would
  close(): void;
};

const buildT3Client = (baseUrl: string, token: string): Promise<T3ClientShape> =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const context = yield* Layer.build(makeT3Client({baseUrl, token}));
    return Context.get(context, T3Client);
  })));

// opens the supervision services on existing files, as one process start (src/main.ts, src/guidance-application.ts): the team
// services, the Start/Stop control, the workflow write and team controllers and the project supervisor of one supervision run
export const openIntSupervision = async (input: {directory: string; peerUrl: string; catalog: () => IntCatalog;
  definitions?: IntDefinitions; fetch?: typeof globalThis.fetch}): Promise<IntSupervision> => {
  const config: SupervisorConfig = {dataDirectory: input.directory, t3Url: input.peerUrl, t3TokenFile: "unused", excludedThreadIds: [],
    healthPort: 0, uiPort: 0, uiHost: "127.0.0.1", uiAssetsDirectory: input.directory};
  config.supervisorOwnedThreadIds = loadSupervisorOwnership(config.dataDirectory);
  const policy = new ThreadPolicyStore(config.dataDirectory, {excludedThreadIds: config.excludedThreadIds});
  config.threadPolicy = policy;
  const guidance = new GuidanceStore(config.dataDirectory);
  const owned = config.supervisorOwnedThreadIds ??= loadSupervisorOwnership(config.dataDirectory);
  const store = new ProjectSupervisorStore(guidance, owned);
  const source: Pick<StoreShape, "catalog"> = {catalog: () => Effect.succeed(input.catalog())};
  const t3 = await buildT3Client(config.t3Url, readToken);
  const readRpc = makeSupervisorRpc(config.t3Url, readToken);
  const operateRpc = makeSupervisorRpc(config.t3Url, operateToken);
  // the helper transport, team runtime, conversation and lifecycle as supervision-live.ts builds them: the operate client,
  // the T3 client, the definitions and global fetch in the supervision scope, with the admission gate guarding through the
  // supervisor's scope predicates
  const scope = Effect.runSync(Scope.make());
  const supervisorScope = new SupervisionScope(config, store, true);
  const operate = Effect.runSync(NativeRpc.make({baseUrl: config.t3Url, token: operateToken}).pipe(Effect.provide(NativeEnvelope.layer)));
  const withDefinitions = <A, E, R>(effect: Effect.Effect<A, E, R>) => input.definitions ? Effect.provideService(effect, ProjectDefinitions, definitionsService(input.definitions)) : effect;
  const services = await Effect.runPromise(supervisorTeamServices(store, config.t3Url, supervisorScope).pipe(
    Effect.provideService(NativeOperateRpc, operate),
    Effect.provideServiceEffect(SupervisionGate, makeSupervisionGate(supervisorScope)),
    withDefinitions,
    Effect.provideService(T3Client, t3),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer)))),
    // a test may observe the synchronous start of each request; the request itself is the platform fetch's
    (effect) => input.fetch ? Effect.provideService(effect, FetchHttpClient.Fetch, input.fetch) : effect,
    Scope.provide(scope),
  ));
  // the read credential's native reads, the shell boundary and the workflow controllers' proof and scope
  const nativeRead = Effect.runSync(NativeRpc.make({baseUrl: config.t3Url, token: readToken}).pipe(Effect.provide(NativeEnvelope.layer)));
  const nativeShell = Effect.runSync(NativeShell.make({baseUrl: config.t3Url, token: readToken}).pipe(
    Effect.provideService(NativeRpc, nativeRead), Effect.provide(FetchHttpClient.layer)));
  const built = buildProjectSupervisor({services, source, t3, read: nativeRead, shell: nativeShell, operate, definitions: input.definitions,
    controllers: (context) => supervisorWorkflowControllers(config.helperProviderInstanceId).pipe(
      Effect.provideServiceEffect(WorkflowNativeAccess, WorkflowNativeAccess.make), withDefinitions, Effect.provide(context)), scope});
  const supervision = projectSupervisorFacade({config, store, t3, definitions: input.definitions, scope: supervisorScope, services, ...built});
  const controllers = built.controllers as Context.Context<WorkflowWriteController | SupervisorTeamController>;
  return {directory: input.directory, config, policy, guidance, store, source, t3, readRpc, operateRpc, supervision, operate, services,
    writes: Context.get(controllers, WorkflowWriteController), team: Context.get(controllers, SupervisorTeamController),
    // a process exit also ends the supervision scope, which aborts any webhook POST still in flight
    close: () => {Effect.runFork(Scope.close(scope, Exit.void));guidance.close();policy.close();}};
};

export type IntEndpoint = {
  controller: ReturnType<typeof workflowWriteControllerFacade>;
  teamController: ReturnType<typeof supervisorTeamControllerFacade>;
  port: number;
  token: string;
  close(): Promise<void>;
};

// wires the MCP endpoint and UI server exactly as guidance-application.ts does: the api handlers yield the supervision services
// and the MCP endpoint consumes the write and team controllers; the suites call the controllers through their promise facades
export const startIntEndpoint = async (core: IntSupervision): Promise<IntEndpoint> => {
  const {config} = core;
  const workflowReader = workflowWriteControllerFacade((effect, options) => Effect.runPromise(effect, options), core.writes);
  const teamController = supervisorTeamControllerFacade((effect, options) => Effect.runPromise(effect, options), core.team);
  const ui = await startGuidanceUi(config, Effect.runSync(GuidanceRuntime.make(config, core.guidance, core.source)),
    undefined, undefined, {supervisor: core.supervision.service, control: core.supervision.supervisionControl},
    WorkflowMcp.layer.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(WorkflowWriteController, core.writes), Layer.succeed(SupervisorTeamController, core.team)))),
    core.writes);
  const address = ui.server.address();
  if (address === null || typeof address === "string") throw new Error("ui did not bind a TCP port");
  const token = await readFile(join(config.dataDirectory, "access", "workflow-mcp-token"), "utf8");
  return {controller: workflowReader, teamController, port: address.port, token, close: () => ui.close()};
};

export type McpReply = {httpStatus: number; isError: boolean; value: unknown};

let rpcId = 0;
// explicit per-call deadline, above the endpoint's own 9 s tool deadline
const callDeadlineMs = 30_000;
// one stateless JSON-RPC tools/call through Node's global fetch, without initialize
export const callTool = async (endpoint: IntEndpoint, name: string, args: unknown): Promise<McpReply> => {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/mcp/workflows`, {method: "POST", signal: AbortSignal.timeout(callDeadlineMs),
    headers: {Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream"},
    body: JSON.stringify({jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: {name, arguments: args}})});
  const body = await response.json() as {result?: {isError?: boolean; content?: Array<{text?: string}>}};
  return {httpStatus: response.status, isError: body.result?.isError === true, value: JSON.parse(body.result?.content?.[0]?.text ?? "null")};
};

// a raw POST to the MCP route with explicit headers; Host needs node:http because fetch forbids it
export const rawMcpPost = (port: number, headers: Record<string, string>): Promise<{status: number; body: unknown}> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify({jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: {name: "workflow_read", arguments: {}}});
    const request = httpRequest({host: "127.0.0.1", port, path: "/mcp/workflows", method: "POST", signal: AbortSignal.timeout(callDeadlineMs),
      headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(payload), ...headers}},
    (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8"))}));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(payload);
  });
