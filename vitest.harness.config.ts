import { defineConfig } from "vitest/config";
import { leakGate } from "./test/support/leak-gate.js";

// runner self-tests; each nested run carries its own explicit deadline
export default defineConfig({
  plugins: [leakGate()],
  test: {
    include: ["test/harness/*.test.ts"],
    environment: "node",
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 10_000,
    detectAsyncLeaks: true,
    reporters: ["default"],
  },
});
