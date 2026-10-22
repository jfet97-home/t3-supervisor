import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// nested runs of the handle gate exactly as vitest.cpu-bound.config.ts applies it
export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  test: {
    include: ["test/harness/fixtures/*.fixture.ts"],
    environment: "node",
    pool: "forks",
    isolate: true,
    testTimeout: 0,
    hookTimeout: 0,
    setupFiles: ["test/support/handle-gate.ts"],
    reporters: ["default"],
  },
});
