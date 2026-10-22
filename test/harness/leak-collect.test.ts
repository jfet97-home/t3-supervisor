import { describe, expect, it } from "vitest";
import { readTestResults, runFixture } from "./fixture-run.js";

// garbage collection before vitest's scan: unreachable fiber contexts are not leaks, reachable ones still are
describe("leak collection before the scan", () => {
  it("does not report an interrupted fiber", async () => {
    const { run } = await runFixture("fiber-interrupted", 30_000);
    expect(run.code).toBe(0);
    expect(run.output).toMatch(/leak-gate: 0 leak\(s\), 0 allowlisted, 0 unexpected/);
  });

  it("reports a suspended fiber that is still referenced", async () => {
    const { run } = await runFixture("fiber-retained", 30_000);
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/leak-gate: unexpected effect\/Fiber from test\/harness\/fixtures\/fiber-retained\.fixture\.ts:\d+:\d+/);
  });

  it("fails closed when the workers cannot collect garbage", async () => {
    const { run, report } = await runFixture("fiber-interrupted", 30_000, "test/harness/fixtures/vitest.fixture-nogc.config.ts");
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/leak-gate: test workers must run with --expose-gc/);
    expect((await readTestResults(report)).get("interrupted fiber")?.status).toBe("passed");
  });
});
