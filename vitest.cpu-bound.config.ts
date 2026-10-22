import { defineConfig } from "vitest/config";

// suites whose unchanged cpu-bound deadline tests cannot run under vitest's global per-promise async leak hook
// (measured: projection-stream parser tests 0.6 s without it, 10-50 s with it; the t3 25 ms timeout and 32 MiB
// default-budget reads). they run in this separate invocation with the native resource gate of
// test/support/handle-gate.ts instead; every assertion and explicit deadline is unchanged. the code they exercise
// owns no effect fibers (src/t3-projection-stream.ts, src/t3.ts start none); pending promises are not gated here.
export const cpuBound = ["test/t3.test.ts", "test/t3-projection-stream.test.ts"];

export default defineConfig({
  test: {
    include: cpuBound,
    environment: "node",
    pool: "forks",
    isolate: true,
    // 10 s per test as in the main phase; their slow baseline tests carry an explicit per-test { timeout: 60_000 }
    testTimeout: 10_000,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    setupFiles: ["test/support/handle-gate.ts"],
    reporters: ["default"],
  },
});
