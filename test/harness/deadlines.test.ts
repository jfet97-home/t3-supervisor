import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readMarker, readTestResults, runFixture } from "./fixture-run.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

// the resolved test options of a phase config, loaded in a separate process so its imports stay out of this worker
const testOptions = (config: string): { testTimeout?: number; projects?: unknown } => {
  const loaded = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `const { default: config } = await import(${JSON.stringify(`./${config}`)}); `
    + "console.log(JSON.stringify({ testTimeout: config.test?.testTimeout, projects: config.test?.projects }));"],
  { cwd: root, encoding: "utf8", timeout: 20_000 });
  if (loaded.status !== 0) throw new Error(`loading ${config} failed with status ${loaded.status}`);
  return JSON.parse(loaded.stdout) as { testTimeout?: number; projects?: unknown };
};

// plan 5.3 rule 2: every test is bounded by vitest's own 10 s timeout unless it carries an explicit per-test bound

describe("per-test deadlines", () => {
  it("both phases give every test vitest's own 10 s timeout and define no slower class", { timeout: 60_000 }, () => {
    for (const config of ["vitest.config.ts", "vitest.cpu-bound.config.ts"]) expect(testOptions(config)).toEqual({ testTimeout: 10_000 });
  });

  it("an unlisted test times out at the default bound, interrupting its effect; an explicit slow bound is kept", async () => {
    const { run, report, markers } = await runFixture("default-deadline", 30_000, "test/harness/fixtures/vitest.default-deadline.config.ts");
    const results = await readTestResults(report);
    expect(run.code).toBe(1);
    expect(results.get("unlisted never-ending effect")?.failureMessages[0]).toMatch(/^Error: Test timed out in 300ms\./);
    expect(await readMarker(markers, "default-deadline-finalized.json")).toEqual({ finalized: 1 });
    expect(results.get("unlisted never-resolving promise")?.failureMessages[0]).toMatch(/^Error: Test timed out in 300ms\./);
    expect(results.get("listed slow test with its explicit bound")?.status).toBe("passed");
  });
});
