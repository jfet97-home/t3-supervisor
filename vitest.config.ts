import { configDefaults, defineConfig } from "vitest/config";
import { leakGate } from "./test/support/leak-gate.js";

// s0 bounds (plan 5.3 rule 1): no per-test or hook timeout until s1c; the watchdog bounds the whole run
export default defineConfig({
  plugins: [leakGate()],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "dist/**", "test/harness/**"],
    environment: "node",
    pool: "forks",
    isolate: true,
    testTimeout: 0,
    hookTimeout: 0,
    detectAsyncLeaks: true,
    execArgv: ["--expose-gc"],
    setupFiles: ["test/support/leak-collect.ts"],
    reporters: ["default"],
  },
});
