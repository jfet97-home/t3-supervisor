import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { leakGate } from "../../support/leak-gate.js";

// nested runs of the harness self-tests: s0 test bounds with a short finite hook timeout
export default defineConfig({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  plugins: [leakGate()],
  test: {
    include: ["test/harness/fixtures/*.fixture.ts"],
    environment: "node",
    pool: "forks",
    isolate: true,
    testTimeout: 0,
    hookTimeout: 250,
    detectAsyncLeaks: true,
    execArgv: ["--expose-gc"],
    setupFiles: ["test/support/leak-collect.ts"],
    reporters: ["default"],
  },
});
