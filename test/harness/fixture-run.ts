import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { onTestFinished } from "vitest";

// nested fixture runs through the real watchdog entry point, as `npm test` starts it

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixtureConfig = "test/harness/fixtures/vitest.fixture.config.ts";

export interface WatchdogRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly elapsedMs: number;
  // every process group the watchdog announced, in order (file listings and phases)
  readonly groups: ReadonlyArray<number>;
}

export interface FixtureRun extends WatchdogRun {
  readonly group: number | undefined;
}

export interface StartedWatchdog {
  readonly pid: number;
  readonly markers: string;
  readonly result: Promise<WatchdogRun>;
}

export interface StartedFixtureRun {
  readonly pid: number;
  readonly markers: string;
  readonly report: string;
  readonly result: Promise<FixtureRun>;
}

export interface TestResult {
  readonly status: string;
  readonly failureMessages: ReadonlyArray<string>;
}

// the outer worker's VITEST* variables would make the nested cli believe it runs inside a worker
const nestedEnvironment = (markers: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST"))),
  HARNESS_MARKERS: markers,
});

// pid 0 or a negative group 0 would address the caller's own group
export const processExists = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || Math.abs(pid) <= 1) throw new Error(`refusing to probe pid ${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

export const groupExists = (group: number): boolean => processExists(-group);

// the watchdog with the given arguments; a failed assertion must not leave it or any of its groups behind
export const startWatchdog = async (args: (markers: string) => ReadonlyArray<string>): Promise<StartedWatchdog> => {
  const markers = await mkdtemp(join(tmpdir(), "t3-supervisor-harness-"));
  const started = performance.now();
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-tests.ts", ...args(markers)], {
    cwd: root, env: nestedEnvironment(markers), stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  const result = new Promise<WatchdogRun>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      // reporters colour their output when the environment asks for it (FORCE_COLOR on ci); assertions read plain text
      const plain = stripVTControlCharacters(output);
      const groups = [...plain.matchAll(/leads process group (\d+)/g)].map((match) => Number(match[1]));
      resolve({ code, signal, output: plain, elapsedMs: performance.now() - started, groups });
    });
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const { groups } = await result;
    for (const group of groups) if (groupExists(group)) process.kill(-group, "SIGKILL");
    await rm(markers, { recursive: true, force: true });
  });
  if (child.pid === undefined) throw new Error("the watchdog did not start");
  return { pid: child.pid, markers, result };
};

export const startFixtureRun = async (fixture: string, deadlineMs: number, config = fixtureConfig): Promise<StartedFixtureRun> => {
  let report = "";
  const started = await startWatchdog((markers) => {
    report = join(markers, "report.json");
    return [
      `--watchdog-deadline-ms=${deadlineMs}`, "--config", config, `test/harness/fixtures/${fixture}.fixture.ts`,
      "--reporter=default", "--reporter=json", `--outputFile=${report}`,
    ];
  });
  return { ...started, report, result: started.result.then((run) => ({ ...run, group: run.groups[0] })) };
};

export const runFixture = async (fixture: string, deadlineMs: number, config = fixtureConfig) => {
  const started = await startFixtureRun(fixture, deadlineMs, config);
  return { ...started, run: await started.result };
};

export const readTestResults = async (report: string): Promise<ReadonlyMap<string, TestResult>> => {
  const parsed = JSON.parse(await readFile(report, "utf8")) as {
    readonly testResults: ReadonlyArray<{ readonly assertionResults: ReadonlyArray<TestResult & { readonly fullName: string }> }>;
  };
  return new Map(parsed.testResults.flatMap((file) => file.assertionResults.map((test) => [test.fullName, test] as const)));
};

export const waitForFile = async (path: string, timeoutMs: number): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      if (performance.now() > deadline) throw new Error(`${path} did not appear within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
};

export const readMarker = async (markers: string, name: string): Promise<Record<string, number>> =>
  JSON.parse(await readFile(join(markers, name), "utf8")) as Record<string, number>;
