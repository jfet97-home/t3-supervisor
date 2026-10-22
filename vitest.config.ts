import { configDefaults, defineConfig } from "vitest/config";
import { cpuBound } from "./vitest.cpu-bound.config.js";
import { leakGate } from "./test/support/leak-gate.js";

// finite bounds (plan 5.3 rule 2): 10 s per test as vitest's own timeout, 30 s for hooks and teardown; the 55 slow
// baseline tests and the slow s1 characterizations carry an explicit per-test { timeout: 60_000 }
export default defineConfig({
  plugins: [leakGate()],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "dist/**", "test/harness/**", ...cpuBound],
    environment: "node",
    pool: "forks",
    isolate: true,
    testTimeout: 10_000,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    detectAsyncLeaks: true,
    execArgv: ["--expose-gc"],
    setupFiles: ["test/support/leak-collect.ts"],
    reporters: ["default"],
  },
});
