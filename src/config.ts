import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupervisorConfig } from "./types.js";

export const loadDataDirectory = (): string => process.env.DATA_DIRECTORY ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "t3-supervisor");

const loadHelperProviderInstanceId = (): string | undefined => {
  const value = process.env.SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID?.trim();
  if (!value) return undefined;
  if (value.length > 256 || /\s/u.test(value)) throw new Error("invalid_helper_provider_instance_id");
  return value;
};

export const loadConfig = (): SupervisorConfig => {
  const helperProviderInstanceId = loadHelperProviderInstanceId();
  return {
  dataDirectory: loadDataDirectory(),
  t3Url: process.env.T3_URL ?? "http://127.0.0.1:3773",
  t3TokenFile: process.env.T3_TOKEN_FILE ?? "/run/secrets/t3-read-token",
  excludedThreadIds: (process.env.EXCLUDED_THREAD_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  healthPort: Number(process.env.HEALTH_PORT ?? "9007"),
  ...(helperProviderInstanceId ? {helperProviderInstanceId} : {}),
  uiPort: Number(process.env.UI_PORT ?? "9008"),
  uiHost: process.env.UI_HOST ?? "127.0.0.1",
  workflowMcpHosts: (process.env.WORKFLOW_MCP_HOSTS ?? "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean),
  ...(process.env.WORKFLOW_MCP_BIND_HOST ? { workflowMcpBindHost: process.env.WORKFLOW_MCP_BIND_HOST } : {}),
  ...(process.env.WORKFLOW_MCP_PORT ? { workflowMcpPort: Number(process.env.WORKFLOW_MCP_PORT) } : {}),
  uiAssetsDirectory: process.env.UI_ASSETS_DIRECTORY ?? fileURLToPath(new URL("../ui-dist", import.meta.url)),
  guidanceTokenFile: process.env.T3_GUIDANCE_TOKEN_FILE ?? "/run/secrets/t3-guidance-token",
  projectWriteTokenFile: process.env.T3_PROJECT_WRITE_TOKEN_FILE ?? "/run/secrets/t3-project-write-token",
  projectCommitTokenFile: process.env.T3_PROJECT_COMMIT_TOKEN_FILE ?? "/run/secrets/t3-project-commit-token",
  gitProbeTokenFile: process.env.T3_GIT_PROBE_TOKEN_FILE ?? "/run/secrets/t3-git-probe-token",
  ...(process.env.T3_MANAGED_SCRATCH_ROOT ? { managedScratchRoot: process.env.T3_MANAGED_SCRATCH_ROOT } : {}),
  };
};
