import { Effect } from "effect";
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SupervisorConfig } from "./types.js";

export const loadConfig = (): SupervisorConfig => ({
  dataDirectory: process.env.DATA_DIRECTORY ?? "/data",
  t3Url: process.env.T3_URL ?? "http://host.docker.internal:3773",
  t3TokenFile: process.env.T3_TOKEN_FILE ?? "/run/secrets/t3-read-token",
  mcpxUrl: process.env.MCPX_URL ?? "http://mcpx:9000/mcp/lazy",
  cxCommand: process.env.CX_COMMAND ?? "cx",
  cxHome: process.env.CX_HOME ?? "/data/runtime-auth",
  cxSeedFile: process.env.CX_SEED_FILE ?? "/run/secrets/codex-auth.json",
  excludedThreadIds: (process.env.EXCLUDED_THREAD_IDS ?? "af0e5160-07d2-46c9-b60b-a329d6951d83,9fbd0b1f-5f41-4708-85db-a3cf736789a7").split(",").map((id) => id.trim()).filter(Boolean),
  inputInteractiveThreadId: process.env.INPUT_INTERACTIVE_THREAD_ID ?? "af0e5160-07d2-46c9-b60b-a329d6951d83",
  healthPort: Number(process.env.HEALTH_PORT ?? "9007"),
  modelTimeoutMs: Number(process.env.MODEL_TIMEOUT_MS ?? "360000"),
  inputEnabled: process.env.INPUT_ENABLED === "true",
  inputTokenFile: process.env.T3_INPUT_TOKEN_FILE ?? "/run/secrets/t3-input-token",
  inputPollMs: Number(process.env.INPUT_POLL_MS ?? "1000"),
  uiPort: Number(process.env.UI_PORT ?? "9008"),
  uiHost: process.env.UI_HOST ?? "127.0.0.1",
  uiAssetsDirectory: process.env.UI_ASSETS_DIRECTORY ?? "/app/ui-dist",
  guidanceTokenFile: process.env.T3_GUIDANCE_TOKEN_FILE ?? "/run/secrets/t3-guidance-token",
  ...(process.env.T3_MANAGED_SCRATCH_ROOT ? { managedScratchRoot: process.env.T3_MANAGED_SCRATCH_ROOT } : {}),
});

export const initializeRuntimeAuth = (config: SupervisorConfig) => Effect.tryPromise(async () => {
  process.umask(0o077);
  await mkdir(config.cxHome, { recursive: true, mode: 0o700 });
  await chmod(config.cxHome, 0o700);
  const destination = join(config.cxHome, "auth.json");
  try {
    await stat(destination);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    await copyFile(config.cxSeedFile, destination);
  }
  await chmod(destination, 0o600);
});
