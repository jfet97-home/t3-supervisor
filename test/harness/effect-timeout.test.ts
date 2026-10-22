import { describe, expect, it } from "vitest";
import { readMarker, readTestResults, runFixture } from "./fixture-run.js";

describe("effect test bounds in a nested run", () => {
  it("interrupts an effect at its per-test timeout and runs its finalizer; an in-effect deadline fails typed", async () => {
    const { run, report, markers } = await runFixture("effect-timeout", 30_000);
    const results = await readTestResults(report);
    expect(run.code).toBe(1);
    expect(results.get("never-ending effect with a finalizer")?.status).toBe("failed");
    expect(results.get("never-ending effect with a finalizer")?.failureMessages[0]).toMatch(/^Error: Test timed out in 200ms\./);
    expect(await readMarker(markers, "effect-finalized.json")).toEqual({ finalized: 1 });
    expect(results.get("live effect bounded by an in-effect deadline")?.status).toBe("passed");
  });
});
