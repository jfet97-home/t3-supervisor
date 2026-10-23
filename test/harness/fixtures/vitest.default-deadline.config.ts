import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { leakGate } from "../../support/leak-gate.js";

// the main phase's per-test bound scaled down: 10 s becomes 300 ms, an explicit slow bound stays explicit
export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  plugins: [leakGate()],
  test: {
    include: ["test/harness/fixtures/*.fixture.ts"],
    environment: "node",
    pool: "forks",
    isolate: true,
    testTimeout: 300,
    hookTimeout: 250,
    detectAsyncLeaks: true,
    execArgv: ["--expose-gc"],
    setupFiles: ["test/support/leak-collect.ts"],
    reporters: ["default"],
  },
});
