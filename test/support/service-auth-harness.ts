import { DashboardUpdates } from "../../src/dashboard-updates.js";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import { policyDbLayer } from "../../src/db.js";
import { GuidanceRuntime } from "../../src/guidance.js";
import { GuidanceUi, type GuidanceUiOptions } from "../../src/guidance-ui.js";
import { ServiceAuth as ServiceAuthService } from "../../src/service-auth.js";
import { makeThreadPolicyStore, ThreadPolicyStore } from "../../src/thread-policy.js";
import type { SupervisorConfig } from "../../src/types.js";
import type { WorkflowMcp } from "../../src/workflow-mcp.js";
import type { WorkflowWriteController } from "../../src/workflow-write-controller.js";
import { workflowMcpLayer } from "./mcp-controllers.js";

// the dashboard server over its own service auth, the given runtime and services and a workflow MCP endpoint, with the node file
// system and crypto the supervisor root provides, for the caller's scope. Without a workflow MCP layer the endpoint has no
// controller tools, which these suites never call
export const guidanceUi = (config: SupervisorConfig, runtime: GuidanceRuntime["Service"], options: GuidanceUiOptions = {},
  workflows?: Layer.Layer<WorkflowMcp>, policy?: ThreadPolicyStore["Service"]) => {
  // the process's thread-policy store: the given one, else the data directory's own, as the root opens it
  const policyStore = policy ? Layer.succeed(ThreadPolicyStore, policy)
    : Layer.effect(ThreadPolicyStore, makeThreadPolicyStore({excludedThreadIds: config.excludedThreadIds})).pipe(Layer.provide(policyDbLayer(config.dataDirectory)));
  const services = Layer.mergeAll(ServiceAuthService.layer(config.dataDirectory), Layer.succeed(GuidanceRuntime, runtime),
    workflows ?? workflowMcpLayer({} as WorkflowWriteController["Service"]), policyStore).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, DashboardUpdates.layer)));
  return Effect.map(Layer.build(GuidanceUi.layer(config, options).pipe(Layer.provide(services))), context => Context.get(context, GuidanceUi));
};
