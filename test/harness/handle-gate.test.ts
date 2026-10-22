import { describe, expect, it } from "vitest";
import { readTestResults, runFixture } from "./fixture-run.js";

const config = "test/harness/fixtures/vitest.handle-fixture.config.ts";

// the native resource gate of the suites that run without vitest's async leak detector
describe("handle gate", () => {
  it("fails a file that leaves an interval running", async () => {
    const { run } = await runFixture("handle-timer", 30_000, config);
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/handle-gate: the file left active resources: Timeout x1/);
  });

  it("fails a file that leaves a server listening", async () => {
    const { run } = await runFixture("handle-server-open", 30_000, config);
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/handle-gate: the file left active resources: TCPServerWrap x1/);
  });

  it("passes a file whose server was closed before it ended", async () => {
    const { run, report } = await runFixture("handle-server-closed", 30_000, config);
    expect(run.code).toBe(0);
    expect((await readTestResults(report)).get("closes its server")?.status).toBe("passed");
  });

  it("fails closed when resource inspection is unavailable", async () => {
    const { run } = await runFixture("handle-server-closed", 30_000, "test/harness/fixtures/vitest.handle-missing.config.ts");
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/handle-gate: process\.getActiveResourcesInfo is unavailable; failing closed/);
  });
});
