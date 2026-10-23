import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, type Layer } from "effect";
import type { TestContext } from "vitest";
import { GuidanceRuntime } from "../../src/guidance.js";
import { SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { openGuidance, openPolicy, policyService } from "./store-units.js";
import { startGuidanceUi } from "./service-auth-harness.js";
import type { ProjectConfigEditor, ProjectDefinitionLoader } from "./root-facades.js";
import type { GuidanceUiOptions } from "../../src/guidance-ui.js";
import type { SupervisorConfig } from "../../src/types.js";
import type { WorkflowMcp } from "../../src/workflow-mcp.js";
import { defer } from "./c3b-http.js";

// the dashboard server of guidance-ui.ts on a temp data directory, closed and removed when the test finishes

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

export const tempDirectory = async (t: TestContext, prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  defer(t, () => rm(directory, { recursive: true, force: true }));
  return directory;
};

export type StartedUi = {
  ui: Awaited<ReturnType<typeof startGuidanceUi>>;
  config: SupervisorConfig;
  directory: string;
  port: number;
  origin: string;
  mcpPort: number | null;
  close(): Promise<void>;
};

export const startUi = async (t: TestContext, options: {
  directory?: string;
  config?: Partial<SupervisorConfig>;
  definitions?: ProjectDefinitionLoader;
  editor?: ProjectConfigEditor;
  supervision?: GuidanceUiOptions["supervision"];
  workflows?: Layer.Layer<WorkflowMcp>;
} = {}): Promise<StartedUi> => {
  const directory = options.directory ?? await tempDirectory(t, "c3b-ui-");
  const config = uiConfig(directory, options.config);
  // the guidance store and the process's policy store and ownership set the runtime reads
  const store = await openGuidance(directory);
  const policy = await openPolicy(directory, { excludedThreadIds: config.excludedThreadIds });
  const closeStores = async () => { try { await store.close(); } finally { await policy.close(); } };
  let ui: StartedUi["ui"];
  try {
    const runtime = Effect.runSync(GuidanceRuntime.make(config, { catalog: () => Effect.succeed({ projects: [], threads: [] }) }).pipe(
      Effect.provide(Context.merge(store.context, policy.context)), Effect.provideService(SupervisorOwnership, new Set())));
    ui = await startGuidanceUi(config, runtime, options.definitions, options.editor, options.supervision, options.workflows, undefined, policyService(policy));
  } catch (error) {
    await closeStores();
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await ui.close(); } finally { await closeStores(); }
  };
  defer(t, close);
  const address = ui.server.address();
  assert.ok(address && typeof address === "object");
  const mcpAddress = ui.mcpServer?.address();
  return {
    ui, config, directory, port: address.port, origin: `http://127.0.0.1:${address.port}`,
    mcpPort: mcpAddress && typeof mcpAddress === "object" ? mcpAddress.port : null, close,
  };
};
