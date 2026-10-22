import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupExists, processExists, readMarker, runFixture, startFixtureRun, waitForFile } from "./fixture-run.js";

const killGraceMs = 10_000;

describe("watchdog", () => {
  it("kills a synchronously blocked run and its whole process group at the deadline", async () => {
    const deadlineMs = 6_000;
    const { run, markers } = await runFixture("blocked", deadlineMs);
    const { worker = 0, grandchild = 0 } = await readMarker(markers, "blocked.json");
    expect(run.code).toBe(124);
    expect(run.output).toContain(`watchdog: test run exceeded ${deadlineMs} ms`);
    expect(run.group).toBeTypeOf("number");
    expect(groupExists(run.group ?? 0)).toBe(false);
    expect(processExists(worker)).toBe(false);
    expect(processExists(grandchild)).toBe(false);
    // the grandchild ignores SIGTERM, so it can only be gone after the SIGKILL escalation
    expect(run.elapsedMs).toBeGreaterThanOrEqual(deadlineMs + killGraceMs);
    expect(run.elapsedMs).toBeLessThan(deadlineMs + killGraceMs + 15_000);
  });

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    it(`forwards ${signal} to the process group and exits ${code}`, async () => {
      const started = await startFixtureRun("hang", 60_000);
      await waitForFile(join(started.markers, "hang.json"), 30_000);
      const { worker = 0 } = await readMarker(started.markers, "hang.json");
      const signalled = performance.now();
      process.kill(started.pid, signal);
      const run = await started.result;
      expect(run.code).toBe(code);
      expect(performance.now() - signalled).toBeLessThan(killGraceMs);
      expect(run.output).not.toContain("exceeded");
      expect(run.group).toBeTypeOf("number");
      expect(groupExists(run.group ?? 0)).toBe(false);
      expect(processExists(worker)).toBe(false);
    });
  }

  it("rejects an invalid deadline option with a usage error", async () => {
    const { run } = await runFixture("clean", 0);
    expect(run.code).toBe(2);
    expect(run.output).toContain("watchdog: --watchdog-deadline-ms=0 must be a positive integer");
    expect(run.group).toBeUndefined();
  });
});
