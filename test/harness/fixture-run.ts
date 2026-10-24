import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { onTestFinished } from "vitest";

// nested fixture runs through the real watchdog entry point, as `pnpm test` starts it

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
  // resolves once the watchdog's plain output so far contains the text
  readonly printed: (text: string, timeoutMs: number) => Promise<void>;
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

// a watchdog still running when its test failed is described before it is signalled, in the failure and a file it names
const reportFile = "watchdog-report.json";
const reportWaitMs = 3_000;
const evidenceLimit = 32_768;
const messageLimit = 6_144;

// the outer worker's VITEST* variables would make the nested cli believe it runs inside a worker
// every nested node process answers SIGUSR2 with a report into the marker directory, without environment or network interfaces
const nestedEnvironment = (markers: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST"))),
    HARNESS_MARKERS: markers,
    ...overrides,
  };
  const report = ["--report-on-signal", "--report-signal=SIGUSR2", "--report-exclude-env", "--report-exclude-network",
    `--report-directory=${JSON.stringify(markers)}`, `--report-filename=${reportFile}`];
  return { ...environment, NODE_OPTIONS: [environment.NODE_OPTIONS ?? "", ...report].join(" ").trim() };
};

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;

const readProcFile = (path: string): Promise<string> =>
  readFile(path, "utf8").then((text) => text.trim(), (error: NodeJS.ErrnoException) => `<${error.code ?? "unreadable"}>`);

// tid, name, state, wchan and syscall of every thread; yama's ptrace_scope 1 still lets the parent read syscall
const describeThreads = async (pid: number): Promise<string> => {
  const tids = await readdir(`/proc/${pid}/task`).catch((error: NodeJS.ErrnoException) => error.code ?? "unreadable");
  if (typeof tids === "string") return `/proc/${pid}/task: <${tids}>`;
  const lines = await Promise.all(tids.map(async (tid) => {
    const task = `/proc/${pid}/task/${tid}`;
    const stat = await readProcFile(`${task}/stat`);
    // the name is parenthesised and may itself contain spaces; the state is the first field after it
    const [, name = "?", state = stat] = /^\d+ \((.*)\) (\S)/s.exec(stat) ?? [];
    return `${tid} ${name} state=${state} wchan=${await readProcFile(`${task}/wchan`)} syscall=${await readProcFile(`${task}/syscall`)}`;
  }));
  return lines.join("\n");
};

interface NodeReport {
  readonly javascriptStack?: { readonly message?: string; readonly stack?: ReadonlyArray<string> };
  readonly nativeStack?: ReadonlyArray<{ readonly symbol?: string }>;
  readonly uvthreadResourceUsage?: unknown;
  readonly libuv?: ReadonlyArray<Record<string, unknown>>;
}

// only the javascript stack, the main thread's native stack and resource use, and the libuv handles of the report
const reportSections = (report: NodeReport): string => [
  `javascript stack: ${report.javascriptStack?.message ?? ""}`, ...(report.javascriptStack?.stack ?? []).map((frame) => `  ${frame}`),
  "native stack:", ...(report.nativeStack ?? []).map((frame) => `  ${frame.symbol ?? "?"}`),
  `thread resource usage: ${JSON.stringify(report.uvthreadResourceUsage)}`,
  "libuv handles:", ...(report.libuv ?? []).map((handle) => `  ${JSON.stringify(Object.fromEntries(Object.entries(handle).filter(([key]) => key !== "address")))}`),
].join("\n");

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
export const startWatchdog = async (args: (markers: string) => ReadonlyArray<string>, environment: NodeJS.ProcessEnv = {}): Promise<StartedWatchdog> => {
  const markers = await mkdtemp(join(tmpdir(), "t3-supervisor-harness-"));
  const started = performance.now();
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-tests.ts", ...args(markers)], {
    cwd: root, env: nestedEnvironment(markers, environment), stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const waiters = new Set<() => void>();
  const append = (chunk: string) => { output += chunk; for (const check of waiters) check(); };
  child.stdout.setEncoding("utf8").on("data", append);
  child.stderr.setEncoding("utf8").on("data", append);
  const printed = (text: string, timeoutMs: number) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`watchdog did not print ${JSON.stringify(text)} within ${timeoutMs} ms`)); }, timeoutMs);
    const check = () => {
      if (!stripVTControlCharacters(output).includes(text)) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    check();
  });
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
  // the report is written by the child's SIGUSR2 listener, which runs only when its main thread returns to the event loop
  const requestReport = async (pid: number): Promise<string> => {
    try {
      process.kill(pid, "SIGUSR2");
      await printed("Node.js report completed", reportWaitMs);
      const path = join(markers, reportFile);
      const report = JSON.parse(await readFile(path, "utf8")) as NodeReport;
      await rm(path, { force: true });
      return reportSections(report);
    } catch (error) {
      return `no node report: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  // registered after the cleanup, so vitest runs it first (onTestFinished hooks run in reverse); it only adds an error to a failed test
  onTestFinished(async ({ task }) => {
    if (task.result?.state !== "fail" || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const { pid } = child;
    const evidence = truncate([
      `watchdog pid ${pid} still running ${Math.round(performance.now() - started)} ms after it started`,
      "threads (tid name state wchan syscall):", await describeThreads(pid), await requestReport(pid),
    ].join("\n"), evidenceLimit);
    const file = join(tmpdir(), `t3-supervisor-harness-evidence-${pid}-${Date.now()}.txt`);
    await writeFile(file, `${evidence}\n`);
    throw new Error(`watchdog pid ${pid} was still running when its test failed; diagnostics in ${file}\n${truncate(evidence, messageLimit)}`);
  });
  if (child.pid === undefined) throw new Error("the watchdog did not start");
  return { pid: child.pid, markers, result, printed };
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
