import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Clock, Context, Effect, Exit, Layer, Redacted, Scope } from "effect";
import { GuidanceRuntime } from "../../src/guidance.js";
import { GuidanceUi, type GuidanceUiOptions } from "../../src/guidance-ui.js";
import { forgeDashboardToken as forge, ServiceAuth as ServiceAuthService } from "../../src/service-auth.js";
import type { SupervisorConfig } from "../../src/types.js";
import type { WorkflowMcp } from "../../src/workflow-mcp.js";
import type { WorkflowWriteController } from "../../src/workflow-write-controller.js";
import { workflowMcpLayer } from "./mcp-controllers.js";
import { definitionsService, promiseEditorService, type DefinitionsLoader, type ProjectConfigEditor } from "./root-facades.js";

// the baseline call shapes of the auth suites over the Effect API (test harness only): a service instance is the
// layer built in its own scope, its checks run to completion on the calling thread, and close releases the scope

export interface ServiceAuthOptions {
  now?: () => number;
}

export interface ServiceAuth {
  login(token: string): string | null;
  authenticated(session: string | undefined): boolean;
  logout(session: string | undefined): void;
  mcpAuthorized(authorization: string | undefined): boolean;
  close(): void;
  readonly service: ServiceAuthService["Service"];
}

// the wall clock read through `now`; nanoseconds and sleeps stay on the live clock
const clockFrom = (now: () => number): Clock.Clock => {
  const live = Clock.Clock.defaultValue();
  return {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
    currentTimeNanos: live.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  };
};

const withClock = (options: ServiceAuthOptions) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  options.now === undefined ? effect : Effect.provideService(effect, Clock.Clock, clockFrom(options.now));

export const createServiceAuth = async (dataDirectory: string, options: ServiceAuthOptions = {}): Promise<ServiceAuth> => {
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(ServiceAuthService.layer(dataDirectory).pipe(Layer.provide(NodeFileSystem.layer)), scope))
    .catch(async (error: unknown) => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    });
  const service = Context.get(context, ServiceAuthService);
  const run = <A>(effect: Effect.Effect<A>): A => Effect.runSync(withClock(options)(effect));
  return {
    service,
    login: (token) => {
      const session = run(service.login(token));
      return session === null ? null : Redacted.value(session);
    },
    authenticated: (session) => run(service.authenticated(session)),
    logout: (session) => run(service.logout(session)),
    mcpAuthorized: (authorization) => service.mcpAuthorized(authorization),
    close: () => Effect.runSync(Scope.close(scope, Exit.void)),
  };
};

export const forgeDashboardToken = (dataDirectory: string, options: ServiceAuthOptions = {}): Promise<{ token: string; expiresAt: number }> =>
  Effect.runPromise(forge(dataDirectory).pipe(
    withClock(options),
    Effect.map((issued) => ({ token: Redacted.value(issued.token), expiresAt: issued.expiresAt })),
    Effect.provide(NodeFileSystem.layer),
  ));

// the dashboard server over its own service auth, the given runtime and services and a workflow MCP endpoint, with the node file
// system and crypto the supervisor root provides, for the caller's scope. Without a workflow MCP layer the endpoint has no
// controller tools, which these suites never call
export const guidanceUi = (config: SupervisorConfig, runtime: GuidanceRuntime["Service"], options: GuidanceUiOptions = {},
  workflows?: Layer.Layer<WorkflowMcp>) => {
  const services = Layer.mergeAll(ServiceAuthService.layer(config.dataDirectory), Layer.succeed(GuidanceRuntime, runtime),
    workflows ?? workflowMcpLayer({} as WorkflowWriteController["Service"])).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer)));
  return Effect.map(Layer.build(GuidanceUi.layer(config, options).pipe(Layer.provide(services))), context => Context.get(context, GuidanceUi));
};

// the same dashboard server in its own scope; a failed start releases it and rejects with its typed failure. The definitions and
// the editor are the suites' baseline promise shapes, which the api handlers yield as services
export const startGuidanceUi = async (config: SupervisorConfig, runtime: GuidanceRuntime["Service"],
  definitions?: DefinitionsLoader, editor?: ProjectConfigEditor, supervision?: GuidanceUiOptions["supervision"],
  workflows?: Layer.Layer<WorkflowMcp>, workflowReader?: GuidanceUiOptions["workflowReader"]) => {
  const scope = Effect.runSync(Scope.make());
  const ui = await Effect.runPromise(Scope.provide(scope)(guidanceUi(config, runtime, {definitions: definitions && definitionsService(definitions),
    editor: editor && promiseEditorService(editor), supervision, workflowReader}, workflows))).catch(async (error: unknown) => {
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
