import { NodeCrypto } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { supervisorTeamServices } from "../../src/guidance-application.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { NativeEnvelope } from "../../src/native-envelope.js";
import { GuidanceRuntime } from "../../src/guidance.js";
import { startGuidanceUi } from "./service-auth-harness.js";
import { ProjectSupervisorStore, loadSupervisorOwnership } from "../../src/project-supervisor-store.js";
import { ProjectSupervisor } from "../../src/project-supervisor.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import type { StoreShape } from "../../src/store.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope } from "../../src/supervision-gate.js";
import { ProjectDefinitions } from "../../src/project-definitions.js";
import { definitionsService } from "./team-units.js";
import { NativeOperateRpc, NativeRpc, record, type SupervisorRpc } from "../../src/supervisor-native.js";
import { makeSupervisorRpc, readSupervisorBaseline, readSupervisorThreads } from "./supervisor-native-client.js";
import { SupervisorTeamController } from "../../src/supervisor-team-controller.js";
import { makeT3Client, T3Client, type T3ClientShape } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { ProjectInfo, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import { WorkflowMcp } from "../../src/workflow-mcp.js";
import { WorkflowWriteController } from "../../src/workflow-write-controller.js";

// the production object graph of src/main.ts and src/guidance-application.ts, built over a loopback peer and temp files

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
  supervision: ProjectSupervisor;
  // closes both database files, as a process exit would
  close(): void;
};

const buildT3Client = (baseUrl: string, token: string): Promise<T3ClientShape> =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const context = yield* Layer.build(makeT3Client({baseUrl, token}));
    return Context.get(context, T3Client);
  })));

// opens the supervision services on existing files, as one process start (src/main.ts:12-17, guidance-application.ts:29-30,53-54,75-77)
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
  // the helper transport, team runtime, conversation and lifecycle as guidance-application.ts builds them: the operate client,
  // the T3 client, the definitions and global fetch in the supervision scope, with the admission gate guarding through the
  // supervisor's scope predicates
  const scope = Effect.runSync(Scope.make());
  const supervisorScope = new SupervisionScope(config, store, true);
  const team = await Effect.runPromise(supervisorTeamServices((effect, options) => Effect.runPromise(effect, options), store, config.t3Url, supervisorScope).pipe(
    Effect.provideServiceEffect(NativeOperateRpc, NativeRpc.make({baseUrl: config.t3Url, token: operateToken}).pipe(Effect.provide(NativeEnvelope.layer))),
    Effect.provideServiceEffect(SupervisionGate, makeSupervisionGate(supervisorScope)),
    (effect) => input.definitions ? Effect.provideService(effect, ProjectDefinitions, definitionsService(input.definitions)) : effect,
    Effect.provideService(T3Client, t3),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer)))),
    // a test may observe the synchronous start of each request; the request itself is the platform fetch's
    (effect) => input.fetch ? Effect.provideService(effect, FetchHttpClient.Fetch, input.fetch) : effect,
    Scope.provide(scope),
  ));
  const supervision = new ProjectSupervisor(config, store, source, t3, readRpc, operateRpc, readSupervisorBaseline(config.t3Url, readToken),
    team, input.definitions);
  return {directory: input.directory, config, policy, guidance, store, source, t3, readRpc, operateRpc, supervision,
    // a process exit also ends the supervision scope, which aborts any webhook POST still in flight
    close: () => {Effect.runFork(Scope.close(scope, Exit.void));guidance.close();policy.close();}};
};

export type IntEndpoint = {
  controller: WorkflowWriteController;
  teamController: SupervisorTeamController;
  port: number;
  token: string;
  close(): Promise<void>;
};

// wires the workflow controller, team controller, MCP endpoint and UI server exactly as guidance-application.ts:78-104
export const startIntEndpoint = async (core: IntSupervision, definitions: IntDefinitions): Promise<IntEndpoint> => {
  const {config, supervision, t3, readRpc} = core;
  const workflowReader = new WorkflowWriteController({
    supervisors: core.store,
    team: supervision.team,
    workflows: supervision.workflowStates,
    isEnabled: (projectId, mainThreadId, purpose) => supervision.workflowEditingEnabled(projectId, mainThreadId, purpose),
    isChatStopped: threadId => supervision.supervisionStopped(threadId),
    loadDefinitions: (projectId, threadId, signal) => definitions.load(projectId, threadId, signal),
    contextViews: supervision.conversation,
    starts: {start: (input, evidence, signal) => supervision.startSupervision(input, evidence, signal)},
    stops: {stop: (input, evidence, signal) => supervision.stopSupervision(input, evidence, signal)},
    // verbatim copy of the inline production adapter (guidance-application.ts:89-97), which is not exported
    native: {
      listThreads: readSupervisorThreads(config.t3Url, readToken.trim(), readRpc),
      projection: async (threadId, signal) => (await Effect.runPromise(t3.projection(threadId), {signal})).projection,
      getTurnItem: async (input, signal) => {
        const result = await readRpc("orchestration.getTurnItem", input, signal);
        if (!record(result) || !("item" in result)) throw new Error("workflow_native_item_unavailable");
        return {item: result.item};
      },
    },
  });
  const teamController = new SupervisorTeamController(workflowReader, supervision.team, supervision.operateRpc, supervision.conversation.requests);
  supervision.teamEffects = teamController;
  const ui = await startGuidanceUi(config, Effect.runSync(GuidanceRuntime.make(config, core.guidance, core.source)),
    undefined, undefined, supervision, WorkflowMcp.layer(workflowReader, teamController), workflowReader);
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
