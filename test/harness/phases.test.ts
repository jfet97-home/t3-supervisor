import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupExists, processExists, readMarker, startWatchdog, waitForFile, type WatchdogRun } from "./fixture-run.js";

// the whole-run contract of scripts/run-tests.ts over two disjoint phases, with small fixture partitions
// (a: leak detector like main, b: plain like cpu-bound)

const killGraceMs = 10_000;
const phases = [
  "--watchdog-phase=a:test/harness/fixtures/vitest.phase-a.config.ts",
  "--watchdog-phase=b:test/harness/fixtures/vitest.phase-b.config.ts",
];

interface PhaseRecord {
  readonly phase: string;
  readonly status: string;
  readonly exitCode?: number;
  readonly report?: string;
}

interface CombinedReport {
  readonly success: boolean;
  readonly numTotalTests: number;
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly testResults: ReadonlyArray<{ readonly name: string; readonly assertionResults: ReadonlyArray<{ readonly fullName: string; readonly status: string }> }>;
  readonly phases: ReadonlyArray<PhaseRecord>;
}

const run = async (args: (markers: string) => ReadonlyArray<string>) => {
  const started = await startWatchdog(args);
  return { markers: started.markers, run: await started.result };
};

const readJson = <A>(path: string): A => JSON.parse(readFileSync(path, "utf8")) as A;

// the line the watchdog prints when it starts a phase's test run (file listings print "phase <name> files:")
const phaseRun = (output: string, phase: string): string | undefined =>
  output.split("\n").find((line) => line.startsWith(`watchdog: phase ${phase}: vitest pid`));

const noGroupLeft = (result: WatchdogRun) => {
  expect(result.groups.length).toBeGreaterThan(0);
  for (const group of result.groups) expect(groupExists(group)).toBe(false);
};

const tests = (report: CombinedReport) => report.testResults.flatMap((file) => file.assertionResults.map((test) => test.fullName));

describe("watchdog phases", () => {
  it("npm test is one watchdog over the main and cpu-bound phases", () => {
    const manifest = readJson<{ readonly scripts: Record<string, string> }>("package.json");
    expect(manifest.scripts.test).toBe(
      "node --import tsx scripts/run-tests.ts --watchdog-phase=main:vitest.config.ts --watchdog-phase=cpu-bound:vitest.cpu-bound.config.ts",
    );
  });

  it("runs a filter that only phase a selects in phase a alone", async () => {
    const { markers, run: result } = await run(() => [...phases, "phase-a.fixture"]);
    expect(result.code).toBe(0);
    expect(phaseRun(result.output, "a")).toContain("vitest run --config test/harness/fixtures/vitest.phase-a.config.ts phase-a.fixture");
    expect(phaseRun(result.output, "b")).toBeUndefined();
    expect(existsSync(join(markers, "phase-a.json"))).toBe(true);
    expect(existsSync(join(markers, "phase-b.json"))).toBe(false);
    noGroupLeft(result);
  });

  it("routes a location filter to the phase that owns its file, with that phase's report unchanged", async () => {
    const { markers, run: result } = await run((dir) => [
      ...phases, "test/harness/fixtures/phase-b.fixture.ts:9", "--reporter=json", `--outputFile=${join(dir, "report.json")}`,
    ]);
    expect(result.code).toBe(0);
    expect(phaseRun(result.output, "a")).toBeUndefined();
    expect(phaseRun(result.output, "b")).toContain(`--outputFile=${join(markers, "report.json")} test/harness/fixtures/phase-b.fixture.ts:9`);
    const report = readJson<CombinedReport>(join(markers, "report.json"));
    expect(report.testResults.flatMap((file) => file.assertionResults.map((test) => [test.fullName, test.status]))).toEqual([["b one", "skipped"], ["b two", "passed"]]);
    expect(existsSync(join(markers, "phase-b-two.json"))).toBe(true);
    noGroupLeft(result);
  });

  it("fails a filter that no phase selects as vitest does", async () => {
    const { run: result } = await run(() => [...phases, "no-such-fixture"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("No test files found");
    noGroupLeft(result);
  });

  it("runs an explicit configuration once with the caller's arguments", async () => {
    const { markers, run: result } = await run(() => [...phases, "--config", "test/harness/fixtures/vitest.phase-b.config.ts", "phase-b.fixture"]);
    expect(result.code).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.output).toContain("vitest run --config test/harness/fixtures/vitest.phase-b.config.ts phase-b.fixture");
    expect(result.output).not.toContain("Expected a single value");
    expect(existsSync(join(markers, "phase-a.json"))).toBe(false);
    expect(existsSync(join(markers, "phase-b.json"))).toBe(true);
    noGroupLeft(result);
  });

  it("keeps each phase's json report and combines both without duplicates", async () => {
    const { markers, run: result } = await run((dir) => [
      ...phases, "phase-a.fixture", "phase-b.fixture", "--reporter=default", "--reporter=json", `--outputFile=${join(dir, "report.json")}`,
    ]);
    expect(result.code).toBe(0);
    expect(phaseRun(result.output, "a")).toContain(`--outputFile=${join(markers, "report.a.json")}`);
    expect(phaseRun(result.output, "b")).toContain(`--outputFile=${join(markers, "report.b.json")}`);
    const a = readJson<CombinedReport>(join(markers, "report.a.json"));
    const b = readJson<CombinedReport>(join(markers, "report.b.json"));
    const combined = readJson<CombinedReport>(join(markers, "report.json"));
    expect(tests(a)).toEqual(["a one", "a two"]);
    expect(tests(b)).toEqual(["b one", "b two"]);
    expect(tests(combined)).toEqual(["a one", "a two", "b one", "b two"]);
    expect([combined.numTotalTests, combined.numPassedTests, combined.numFailedTests, combined.success]).toEqual([4, 4, 0, true]);
    expect(combined.phases.map((phase) => [phase.phase, phase.status, phase.exitCode])).toEqual([["a", "passed", 0], ["b", "passed", 0]]);
    noGroupLeft(result);
  });

  it("rejects json to stdout over several phases and a project selection without a configuration", async () => {
    const json = await run(() => [...phases, "phase-a.fixture", "phase-b.fixture", "--reporter=json"]);
    expect(json.run.code).toBe(2);
    expect(json.run.output).toContain("watchdog: --reporter=json over several phases needs --outputFile=<path>");
    expect(phaseRun(json.run.output, "a")).toBeUndefined();
    const project = await run(() => [...phases, "--project", "x"]);
    expect(project.run.code).toBe(2);
    expect(project.run.output).toContain("watchdog: --project selects within one configuration; add --config <file>");
    expect(project.run.groups).toEqual([]);
  });

  it("stops at a failure in the first phase and records the second as not run", async () => {
    const { markers, run: result } = await run((dir) => [
      ...phases, "phase-a-fail", "phase-b.fixture", "--reporter=json", `--outputFile=${join(dir, "report.json")}`,
    ]);
    expect(result.code).toBe(1);
    expect(phaseRun(result.output, "b")).toBeUndefined();
    expect(existsSync(join(markers, "phase-b.json"))).toBe(false);
    const combined = readJson<CombinedReport>(join(markers, "report.json"));
    expect(combined.success).toBe(false);
    expect(combined.phases.map((phase) => [phase.phase, phase.status, phase.exitCode])).toEqual([["a", "failed", 1], ["b", "not run", undefined]]);
    noGroupLeft(result);
  });

  it("reports a failure in the second phase after the first passed", async () => {
    const { markers, run: result } = await run((dir) => [
      ...phases, "phase-a.fixture", "phase-b-fail", "--reporter=json", `--outputFile=${join(dir, "report.json")}`,
    ]);
    expect(result.code).toBe(1);
    expect(existsSync(join(markers, "phase-a.json"))).toBe(true);
    expect(existsSync(join(markers, "phase-b-fail.json"))).toBe(true);
    const combined = readJson<CombinedReport>(join(markers, "report.json"));
    expect([combined.numPassedTests, combined.numFailedTests, combined.success]).toEqual([2, 1, false]);
    expect(combined.phases.map((phase) => [phase.phase, phase.status, phase.exitCode])).toEqual([["a", "passed", 0], ["b", "failed", 1]]);
    noGroupLeft(result);
  });

  it("gives the second phase only the remainder of one whole-run deadline", async () => {
    // each phase alone (3 s, 6 s) fits the 8 s deadline; together they do not
    const deadlineMs = 8_000;
    const { markers, run: result } = await run((dir) => [
      `--watchdog-deadline-ms=${deadlineMs}`, ...phases, "phase-a-slow", "phase-b-slow", "--reporter=json", `--outputFile=${join(dir, "report.json")}`,
    ]);
    expect(result.code).toBe(124);
    expect(result.output).toContain(`watchdog: test run exceeded ${deadlineMs} ms; terminating process group`);
    const remaining = Number(/(\d+) of 8000 ms remain/.exec(phaseRun(result.output, "b") ?? "")?.[1]);
    expect(remaining).toBeLessThanOrEqual(deadlineMs - 3_000);
    const { worker: a = 0 } = await readMarker(markers, "phase-a-slow.json");
    const { worker: b = 0 } = await readMarker(markers, "phase-b-slow.json");
    expect(processExists(a)).toBe(false);
    expect(processExists(b)).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(deadlineMs);
    expect(result.elapsedMs).toBeLessThan(deadlineMs + killGraceMs);
    const combined = readJson<CombinedReport>(join(markers, "report.json"));
    expect(combined.phases.map((phase) => [phase.phase, phase.status])).toEqual([["a", "passed"], ["b", "expired"]]);
    noGroupLeft(result);
  });

  it("starts no later phase once the deadline expired in an earlier one", async () => {
    const deadlineMs = 2_500;
    const { markers, run: result } = await run((dir) => [
      `--watchdog-deadline-ms=${deadlineMs}`, ...phases, "phase-a-slow", "phase-b.fixture", "--reporter=json", `--outputFile=${join(dir, "report.json")}`,
    ]);
    expect(result.code).toBe(124);
    expect(result.output).toContain(`watchdog: test run exceeded ${deadlineMs} ms`);
    expect(phaseRun(result.output, "b")).toBeUndefined();
    expect(existsSync(join(markers, "phase-b.json"))).toBe(false);
    const combined = readJson<CombinedReport>(join(markers, "report.json"));
    expect(combined.phases.map((phase) => [phase.phase, phase.status])).toEqual([["a", "expired"], ["b", "not run"]]);
    noGroupLeft(result);
  });

  it("forwards SIGTERM to the second phase's group and starts nothing after it", async () => {
    const started = await startWatchdog(() => [...phases, "phase-a.fixture", "phase-b-hang"]);
    await waitForFile(join(started.markers, "phase-b-hang.json"), 30_000);
    const { worker = 0 } = await readMarker(started.markers, "phase-b-hang.json");
    const signalled = performance.now();
    process.kill(started.pid, "SIGTERM");
    const result = await started.result;
    expect(result.code).toBe(143);
    expect(performance.now() - signalled).toBeLessThan(killGraceMs);
    expect(result.output).not.toContain("exceeded");
    expect(processExists(worker)).toBe(false);
    noGroupLeft(result);
  });
});
