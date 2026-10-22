import { configDefaults, defineConfig } from "vitest/config";
import { cpuBound } from "./vitest.cpu-bound.config.js";
import { leakGate } from "./test/support/leak-gate.js";
import { slowFiles } from "./test/support/slow-tests.js";

// finite bounds (plan 5.3 rule 2): 10 s per test, 60 s for the slow-integration class listed by file and title,
// 30 s for hooks and teardown; explicit per-test options of the s1 characterizations take precedence
export default defineConfig({
  plugins: [leakGate()],
  test: {
    environment: "node",
    pool: "forks",
    isolate: true,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    detectAsyncLeaks: true,
    execArgv: ["--expose-gc"],
    setupFiles: ["test/support/leak-collect.ts"],
    reporters: ["default"],
    projects: [
      {
        extends: true,
        test: {
          name: "default",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "dist/**", "test/harness/**", ...cpuBound, ...slowFiles],
          testTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: "slow-integration",
          include: slowFiles.filter((file) => !cpuBound.includes(file)),
          testTimeout: 60_000,
          setupFiles: ["test/support/slow-class.ts"],
        },
      },
    ],
  },
});
