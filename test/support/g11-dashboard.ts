import { DashboardUpdates } from "../../src/dashboard-updates.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, FileSystem, Layer, Redacted, Scope } from "effect";
import { SupervisorConfig as Configuration } from "../../src/config.js";
import { GuidanceRuntime } from "../../src/guidance.js";
import { GuidanceUi, type GuidanceUiOptions } from "../../src/guidance-ui.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ProjectDefinitions } from "../../src/project-definitions.js";
import { SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { forgeDashboardToken, ServiceAuth } from "../../src/service-auth.js";
import { makeStore, type StoreShape } from "../../src/store.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { SupervisorConfig } from "../../src/types.js";
import { WorkflowMcp } from "../../src/workflow-mcp.js";
import type { WorkflowCallCancel, WorkflowWriteController } from "../../src/workflow-write-controller.js";
import { exchange } from "./g11-http.js";
import { guidanceLayer, policyLayer, temporaryDirectory } from "./g11-stores.js";

// the dashboard and workflow MCP listeners of src/guidance-ui.ts over their production layers, in the caller's scope: the
// run's guidance client and store, the process's thread-policy store and ownership set, the guidance runtime over a catalog,
// the listeners' own service auth and the workflow MCP endpoint over a controller whose tools are effect fakes, on the node
// file system and crypto the root provides. The listeners close before the stores, and the directory is removed last

/** The dashboard configuration of a data directory: loopback listeners on free ports and an assets directory inside it. */
export const uiConfig = (directory: string, overrides: Partial<SupervisorConfig> = {}): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://127.0.0.1:9",
  t3TokenFile: "unused",
  excludedThreadIds: [],
  healthPort: 0,
  uiPort: 0,
  uiHost: "127.0.0.1",
  uiAssetsDirectory: join(directory, "assets"),
  ...overrides,
});

/** A catalog with no projects and no chats. */
export const emptyCatalog: Pick<StoreShape, "catalog"> = { catalog: () => Effect.succeed({ projects: [], threads: [] }) };

/** One workflow MCP tool of a fake controller: its arguments and the call's cancel. */
export type ToolFake = (args: unknown, cancel?: WorkflowCallCancel) => Effect.Effect<unknown>;

/** A write controller whose tools are the given effect fakes; a tool without a fake dies when called. */
export const workflowController = (fakes: { readTool?: ToolFake; write?: ToolFake; startSupervision?: ToolFake; stopSupervision?: ToolFake } = {}) => {
  const tool = (fake: ToolFake | undefined): ToolFake => (args, cancel) => fake ? fake(args, cancel) : Effect.die(new Error("no such fake tool"));
  return {
    readTool: tool(fakes.readTool), write: tool(fakes.write), startSupervision: tool(fakes.startSupervision), stopSupervision: tool(fakes.stopSupervision),
  } as unknown as WorkflowWriteController["Service"];
};

/** The definitions service of a dashboard whose definitions reads the case answers; no other definitions operation is used. */
export const definitionsOf = (load: (projectId: string, threadId: string | null) => Effect.Effect<ProjectDefinitionSnapshot>) => {
  const unused = () => Effect.die(new Error("unused definitions operation"));
  return ProjectDefinitions.of({
    globalHomePath: "~", globalDefinitionsPath: "~/.t3-supervisor",
    load: (projectId, threadId = null) => load(projectId, threadId),
    globalFingerprint: () => Effect.succeed(null),
    presence: unused, presenceGlobal: unused, presenceForCheckout: unused, checkoutTargets: unused, currentWorkspace: unused,
    initialize: unused, initializeGlobal: unused, readProjectConfig: unused,
  });
};

/** The guidance client and store of the run, the process's thread-policy store and its ownership set. */
export const processStores = (config: SupervisorConfig) =>
  Layer.mergeAll(guidanceLayer(config.dataDirectory), policyLayer(config), SupervisorOwnership.layer);

/** The guidance runtime over a catalog and the stores of `processStores`. */
export const runtimeOver = (config: SupervisorConfig, catalog: Pick<StoreShape, "catalog"> = emptyCatalog) =>
  Layer.effect(GuidanceRuntime, GuidanceRuntime.make(config, catalog)).pipe(Layer.provideMerge(processStores(config)));

/** The runtime layer of the composition root: over the data directory's catalog store and the configuration. */
export const catalogRuntime = (config: SupervisorConfig) => GuidanceRuntime.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(makeStore(config.dataDirectory), processStores(config))),
  Layer.provideMerge(Layer.succeed(Configuration, config)));

export type ListenerOptions = {
  readonly updates?: DashboardUpdates["Service"] | undefined;
  readonly controller?: WorkflowWriteController["Service"] | undefined;
  readonly ui?: GuidanceUiOptions | undefined;
  // stand between the listeners and the real access service and file system
  readonly auth?: ((real: ServiceAuth["Service"]) => ServiceAuth["Service"]) | undefined;
  readonly files?: ((real: FileSystem.FileSystem) => FileSystem.FileSystem) | undefined;
};

/** The listeners over the runtime and the thread-policy store their caller provides. */
export const listenersLayer = (config: SupervisorConfig, options: ListenerOptions = {}) => {
  const auth = options.auth
    ? Layer.effect(ServiceAuth, Effect.map(ServiceAuth, options.auth)).pipe(Layer.provide(ServiceAuth.layer(config.dataDirectory)))
    : ServiceAuth.layer(config.dataDirectory);
  const files = options.files
    ? Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, options.files)).pipe(Layer.provide(NodeFileSystem.layer))
    : NodeFileSystem.layer;
  const mcp = Layer.effect(WorkflowMcp, WorkflowMcp.make(options.controller ?? workflowController()));
  return GuidanceUi.layer(config, options.ui ?? {}).pipe(
    Layer.provide(Layer.mergeAll(auth, mcp, options.updates ? Layer.succeed(DashboardUpdates, options.updates) : DashboardUpdates.layer)),
    Layer.provide(Layer.mergeAll(files, NodeCrypto.layer)));
};

export interface Dashboard {
  readonly port: number;
  readonly mcpPort: number | null;
  readonly origin: string;
  // the workflow MCP bearer token the listeners accept
  readonly token: string;
  readonly runtime: GuidanceRuntime["Service"];
  readonly policy: ThreadPolicyStore["Service"];
}

/** Starts the listeners over the given runtime and thread-policy store in the caller's scope. */
export const listeners = (config: SupervisorConfig, services: Context.Context<GuidanceRuntime | ThreadPolicyStore>, options: ListenerOptions = {}) =>
  Effect.map(Layer.build(listenersLayer(config, options).pipe(Layer.provide(Layer.succeedContext(services)))), (context) => {
    const ui = Context.get(context, GuidanceUi);
    return {port: ui.port, mcpPort: ui.mcpPort, origin: `http://127.0.0.1:${ui.port}`};
  });

/** Starts the listeners over `runtime` (a runtime over the empty catalog by default) in the caller's scope. */
export const dashboard = (config: SupervisorConfig, options: ListenerOptions & {
  readonly runtime?: Layer.Layer<GuidanceRuntime | ThreadPolicyStore, unknown> | undefined;
} = {}) => Effect.gen(function* () {
  const services = yield* Layer.build(options.runtime ?? runtimeOver(config));
  const ui = yield* listeners(config, services, options);
  const fs = yield* FileSystem.FileSystem;
  const token = (yield* fs.readFileString(join(config.dataDirectory, "access", "workflow-mcp-token"))).trim();
  return {
    ...ui, token, runtime: Context.get(services, GuidanceRuntime), policy: Context.get(services, ThreadPolicyStore),
  } satisfies Dashboard;
}).pipe(Effect.provide(NodeFileSystem.layer));

export interface StartedUi extends Dashboard {
  readonly config: SupervisorConfig;
  readonly directory: string;
  // closes the listeners and then the stores; the test scope closes them too
  readonly close: Effect.Effect<void>;
}

/** The dashboard of a data directory (a fresh one by default) in its own scope, closed with the test scope or by `close`. */
export const startUi = (options: ListenerOptions & {readonly directory?: string | undefined; readonly config?: Partial<SupervisorConfig> | undefined} = {}) =>
  Effect.gen(function* () {
    const directory = options.directory ?? (yield* temporaryDirectory("c3b-ui-"));
    const config = uiConfig(directory, options.config);
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const ui = yield* dashboard(config, options).pipe(Scope.provide(scope));
    return {...ui, config, directory, close: Scope.close(scope, Exit.void)} satisfies StartedUi;
  });

/** A single-use dashboard grant of the data directory, as the CLI forges it. */
export const grant = (directory: string) =>
  Effect.map(forgeDashboardToken(directory), (issued) => Redacted.value(issued.token)).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer));

/** The dashboard session of a forged grant, signed in from the supervisor's own origin. */
export const signIn = (origin: string, directory: string) => Effect.gen(function* () {
  const token = yield* grant(directory);
  const response = yield* exchange(origin + "/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.text) as { session?: unknown };
  assert.equal(typeof payload.session, "string");
  return payload.session as string;
});

/** The CSRF token the dashboard issues to the session. */
export const readCsrf = (origin: string, session: string) => Effect.gen(function* () {
  const response = yield* exchange(origin + "/api/csrf", { headers: { "x-supervisor-session": session } });
  assert.equal(response.status, 200);
  return (JSON.parse(response.text) as { csrf: string }).csrf;
});
