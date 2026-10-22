import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { TestContext } from "vitest";
import { GuidanceRuntime } from "../../src/guidance.js";
import { guidanceRuntimeFacade } from "../../src/guidance-application.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import type { WorkflowMcpEndpoint } from "../../src/guidance-ui.js";
import { startGuidanceUi } from "./service-auth-harness.js";
import type { ProjectConfigEditor } from "../../src/project-config-editor.js";
import type { ProjectDefinitionLoader } from "../../src/project-definitions.js";
import type { ProjectSupervisor } from "../../src/project-supervisor.js";
import type { SupervisorConfig } from "../../src/types.js";
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
  supervisorOwnedThreadIds: new Set(),
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
  supervision?: ProjectSupervisor;
  workflows?: WorkflowMcpEndpoint;
} = {}): Promise<StartedUi> => {
  const directory = options.directory ?? await tempDirectory(t, "c3b-ui-");
  const config = uiConfig(directory, options.config);
  const store = new GuidanceStore(directory);
  const runtime = guidanceRuntimeFacade(Effect.runPromise, Effect.runSync(GuidanceRuntime.make(config, store, { catalog: () => Effect.succeed({ projects: [], threads: [] }) })), config);
  let ui: StartedUi["ui"];
  try {
    ui = await startGuidanceUi(config, runtime, options.definitions, options.editor, options.supervision, options.workflows);
  } catch (error) {
    store.close();
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await ui.close(); } finally { store.close(); }
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
