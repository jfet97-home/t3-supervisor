import { DashboardUpdates } from "../../src/dashboard-updates.js";
import assert from "node:assert/strict";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";
import { GuidanceRuntime } from "../../src/guidance.js";
import { guidanceDbLayer, policyDbLayer } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { makeThreadPolicyStore, ThreadPolicyStore } from "../../src/thread-policy.js";
import { GuidanceUi, type GuidanceUiOptions } from "../../src/guidance-ui.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ProjectDefinitions } from "../../src/project-definitions.js";
import { forgeDashboardToken, ServiceAuth } from "../../src/service-auth.js";
import type { WorkflowWriteController } from "../../src/workflow-write-controller.js";
import { uiConfig } from "./g11-dashboard.js";
import { workflowMcpLayer } from "./mcp-controllers.js";

// the dashboard server of guidance-ui.ts on a temp data directory in the caller's scope (the interim guidance store and runtime,
// its own service auth, a workflow MCP endpoint without controller tools, the node file system and crypto), and sign-in over
// loopback; requests go through the current globalThis.fetch

// the listeners close before the store, and the directory is removed last
export const dashboard = (options: GuidanceUiOptions = {}) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({prefix: "c3b-ui-"});
  const config = uiConfig(directory);
  // the guidance store, and the process's policy store and ownership set, in the caller's scope
  const stores = yield* Layer.build(Layer.mergeAll(GuidanceStore.layer.pipe(Layer.provideMerge(guidanceDbLayer(directory)), Layer.provide(SupervisorIds.layer)),
    Layer.effect(ThreadPolicyStore, makeThreadPolicyStore({excludedThreadIds: config.excludedThreadIds})).pipe(Layer.provide(policyDbLayer(directory))),
    SupervisorOwnership.layer).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, DashboardUpdates.layer))));
  const runtime = yield* GuidanceRuntime.make(config, {catalog: () => Effect.succeed({projects: [], threads: []})}).pipe(Effect.provide(stores));
  const context = yield* Layer.build(GuidanceUi.layer(config, options).pipe(
    Layer.provide(Layer.mergeAll(ServiceAuth.layer(directory), Layer.succeed(GuidanceRuntime, runtime), workflowMcpLayer({} as WorkflowWriteController["Service"]),
      Layer.succeedContext(stores))),
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, DashboardUpdates.layer)),
  ));
  const {port} = Context.get(context, GuidanceUi);
  return {directory, port, origin: `http://127.0.0.1:${port}`};
}).pipe(Effect.provide(NodeFileSystem.layer));

// the definitions service of a dashboard whose definitions the test answers: a read is `load`, no global fingerprint is
// read, and no other definitions operation is used
export const answeredDefinitions = (load: (projectId: string, threadId: string | null) => Effect.Effect<ProjectDefinitionSnapshot>) => {
  const unused = () => Effect.die(new Error("unused definitions operation"));
  return ProjectDefinitions.of({
    globalHomePath: "~",
    globalDefinitionsPath: "~/.t3-supervisor",
    load: (projectId, threadId = null) => load(projectId, threadId),
    globalFingerprint: () => Effect.succeed(null),
    presence: unused, presenceGlobal: unused, presenceForCheckout: unused, checkoutInventory: (projectId: string) => Effect.succeed({projectId, available: true, complete: true, reason: null, defaultBranch: null, issues: [], targets: []}),
    checkoutTargets: unused, currentWorkspace: unused,
    initialize: unused, initializeGlobal: unused, readProjectConfig: unused,
  });
};

// the dashboard session of a forged grant, signed in from the supervisor's own origin
export const signIn = (origin: string, directory: string) => Effect.gen(function* () {
  const {token} = yield* forgeDashboardToken(directory);
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.post(origin + "/auth/login", {headers: {Origin: origin}, body: HttpBody.text(JSON.stringify({token: Redacted.value(token)}), "application/json")});
  assert.equal(response.status, 200);
  const payload = (yield* response.json) as {session?: unknown};
  assert.equal(typeof payload.session, "string");
  return payload.session as string;
}).pipe(Effect.orDie, Effect.provide(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer)));

// the CSRF token the dashboard issues to the session
export const readCsrf = (origin: string, session: string) => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(origin + "/api/csrf", {headers: {"x-supervisor-session": session}});
  assert.equal(response.status, 200);
  return ((yield* response.json) as {csrf: string}).csrf;
}).pipe(Effect.orDie, Effect.provide(FetchHttpClient.layer));
