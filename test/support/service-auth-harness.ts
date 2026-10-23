import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { policyDbLayer } from "../../src/db.js";
import { GuidanceRuntime } from "../../src/guidance.js";
import { GuidanceUi, type GuidanceUiOptions } from "../../src/guidance-ui.js";
import { ServiceAuth as ServiceAuthService } from "../../src/service-auth.js";
import { makeThreadPolicyStore, ThreadPolicyStore } from "../../src/thread-policy.js";
import type { SupervisorConfig } from "../../src/types.js";
import type { WorkflowMcp } from "../../src/workflow-mcp.js";
import type { WorkflowWriteController } from "../../src/workflow-write-controller.js";
import { workflowMcpLayer } from "./mcp-controllers.js";
import { definitionsService, promiseEditorService, type DefinitionsLoader, type ProjectConfigEditor } from "./root-facades.js";

// the dashboard server over its own service auth, the given runtime and services and a workflow MCP endpoint, with the node file
// system and crypto the supervisor root provides, for the caller's scope. Without a workflow MCP layer the endpoint has no
// controller tools, which these suites never call
export const guidanceUi = (config: SupervisorConfig, runtime: GuidanceRuntime["Service"], options: GuidanceUiOptions = {},
  workflows?: Layer.Layer<WorkflowMcp>, policy?: ThreadPolicyStore["Service"]) => {
  // the process's thread-policy store: the given one, else the data directory's own, as the root opens it
  const policyStore = policy ? Layer.succeed(ThreadPolicyStore, policy)
    : Layer.effect(ThreadPolicyStore, makeThreadPolicyStore({excludedThreadIds: config.excludedThreadIds})).pipe(Layer.provide(policyDbLayer(config.dataDirectory)));
  const services = Layer.mergeAll(ServiceAuthService.layer(config.dataDirectory), Layer.succeed(GuidanceRuntime, runtime),
    workflows ?? workflowMcpLayer({} as WorkflowWriteController["Service"]), policyStore).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer)));
  return Effect.map(Layer.build(GuidanceUi.layer(config, options).pipe(Layer.provide(services))), context => Context.get(context, GuidanceUi));
};

// the same dashboard server in its own scope; a failed start releases it and rejects with its typed failure. The definitions and
// the editor are the suites' baseline promise shapes, which the api handlers yield as services
export const startGuidanceUi = async (config: SupervisorConfig, runtime: GuidanceRuntime["Service"],
  definitions?: DefinitionsLoader, editor?: ProjectConfigEditor, supervision?: GuidanceUiOptions["supervision"],
  workflows?: Layer.Layer<WorkflowMcp>, workflowReader?: GuidanceUiOptions["workflowReader"], policy?: ThreadPolicyStore["Service"]) => {
  const scope = Effect.runSync(Scope.make());
  const ui = await Effect.runPromise(Scope.provide(scope)(guidanceUi(config, runtime, {definitions: definitions && definitionsService(definitions),
    editor: editor && promiseEditorService(editor), supervision, workflowReader}, workflows, policy))).catch(async (error: unknown) => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  });
  return {
    ...ui,
    // the bound ports in the node listener call shape the suites read
    server: {address: () => ({port: ui.port})},
    mcpServer: ui.mcpPort === null ? undefined : {address: () => ({port: ui.mcpPort})},
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};
