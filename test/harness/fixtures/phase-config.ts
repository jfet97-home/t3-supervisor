import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { leakGate } from "../../support/leak-gate.js";

// two disjoint phases for the runner self-tests, shaped like the main (leak detector) and cpu-bound (no detector) phases
const root = fileURLToPath(new URL("../../..", import.meta.url));
const base = { environment: "node", pool: "forks", isolate: true, testTimeout: 0, hookTimeout: 250 } as const;

export const detectorPhase = (include: ReadonlyArray<string>) => defineConfig({
  root,
  plugins: [leakGate()],
  test: { ...base, reporters: ["default"], include: [...include], detectAsyncLeaks: true, execArgv: ["--expose-gc"], setupFiles: ["test/support/leak-collect.ts"] },
});

export const plainPhase = (include: ReadonlyArray<string>) => defineConfig({ root, test: { ...base, reporters: ["default"], include: [...include] } });
