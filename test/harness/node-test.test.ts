import { describe, expect, it } from "vitest";
import { readTestResults, runFixture } from "./fixture-run.js";

// the converted suites rely on node:test cleanup semantics through test/support/node-test.ts
describe("node:test semantics shim", () => {
  it("runs after hooks in registration order, stops at the first failure and restores mocks after the hooks", async () => {
    const { run, report } = await runFixture("node-test", 30_000);
    const results = await readTestResults(report);
    expect(run.code).toBe(1);
    expect(results.get("ordered")?.status).toBe("passed");
    expect(results.get("failing")?.status).toBe("failed");
    expect(results.get("failing")?.failureMessages[0]).toMatch(/first cleanup fails/);
    expect(results.get("next-test")?.status).toBe("passed");
    const events = run.output.split("\n").filter(line => line.startsWith("event:"));
    expect(events).toEqual([
      "event:ordered after-1", "event:ordered after-2", "event:ordered mock-active-in-hook",
      "event:failing after-1",
      "event:next-test mock-restored",
    ]);
  });
});
