import { describe, expect, it } from "vitest";
import { readTestResults, runFixture } from "./fixture-run.js";

describe("bounded tests in a nested run", () => {
  it("fails a never-resolving promise and a never-resolving effect at their per-test timeout", async () => {
    const { run, report } = await runFixture("timeouts", 30_000);
    const results = await readTestResults(report);
    expect(run.code).toBe(1);
    for (const title of ["never-resolving promise", "never-resolving effect"]) {
      expect(results.get(title)?.status).toBe("failed");
      expect(results.get(title)?.failureMessages[0]).toMatch(/^Error: Test timed out in 200ms\./);
    }
  });

  it("reports hanging and throwing finalizers at the hook timeout instead of passing them", async () => {
    const { run, report } = await runFixture("finalizers", 30_000);
    const results = await readTestResults(report);
    expect(run.code).toBe(1);
    expect(results.get("hanging finalizer")?.status).toBe("failed");
    expect(results.get("hanging finalizer")?.failureMessages[0]).toMatch(/^Error: Hook timed out in 250ms\./);
    expect(results.get("throwing finalizer")?.status).toBe("failed");
    expect(results.get("throwing finalizer")?.failureMessages[0]).toMatch(/^Error: finalizer failed/);
    expect(run.output).toMatch(/FAIL {2}test\/harness\/fixtures\/finalizers\.fixture\.ts > hanging suite finalizer\nError: Hook timed out in 250ms\./);
  });
});
