import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { prepareInstalledBin, type InstalledBin } from "./support/cli-bin.js";
import { groupAlive, leakedSecrets, repositoryRoot, runProcess, tsxLoader, type ProcessResult } from "./support/cli-process.js";
import { dataFiles, listenerStates, quickChecks, supervisorHarness, waitUntilDescriptorRetry, waitUntilReady,
  type SupervisorHarness } from "./support/cli-supervisor.js";

// process-level characterization of the supervisor entries: tsx source (main.ts, cli.ts) and the built/installed bin

const mainSource = join(repositoryRoot, "src", "main.ts");
const cliSource = join(repositoryRoot, "src", "cli.ts");
const exitTimeoutMs = 30_000;

// runMain interrupts on SIGINT/SIGTERM; an interrupt-only exit is 130
const interruptExit = { code: 130, signal: null };

const readyFiles = [
  "access", "access/login.sqlite3", "access/workflow-mcp-token",
  "catalog.sqlite3", "guidance.sqlite3", "thread-settings.sqlite3",
];
const readyDatabases = ["access/login.sqlite3", "catalog.sqlite3", "guidance.sqlite3", "thread-settings.sqlite3"];

const events = (stdout: string): unknown[] => stdout.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { event?: unknown }).event);

const signalAndWait = async (child: ReturnType<SupervisorHarness["start"]>, signal: NodeJS.Signals): Promise<ProcessResult> => {
  process.kill(child.pid, signal);
  return child.closed(exitTimeoutMs);
};

// after exit: listeners refused, no process left in the group, no wal/shm/journal sidecar, every database reopens with quick_check ok
const assertReleased = async (harness: SupervisorHarness, pid: number, files: ReadonlyArray<string>, databases: ReadonlyArray<string>) => {
  assert.deepEqual(await listenerStates(harness), { health: "refused", ui: "refused", mcp: "refused" });
  assert.equal(groupAlive(pid), false, "no process of the supervisor group outlives it");
  assert.deepEqual(await dataFiles(harness), files);
  assert.deepEqual(quickChecks(harness, databases), Object.fromEntries(databases.map((name) => [name, "ok"])));
  assert.deepEqual(await dataFiles(harness), files, "reopening leaves no sidecar behind");
};

it("CT-MAIN-01: SIGTERM after readiness exits 130, closes the health, UI and MCP listeners and every database", { timeout: 60_000 }, async (t) => {
  const harness = await supervisorHarness(t, { activeThreads: 1, archiveThreads: 1 });
  const child = harness.start(process.execPath, ["--import", tsxLoader, mainSource]);
  await waitUntilReady(harness, child);
  assert.deepEqual(await listenerStates(harness), { health: "open", ui: "open", mcp: "open" });
  const result = await signalAndWait(child, "SIGTERM");
  assert.deepEqual({ code: result.code, signal: result.signal }, interruptExit);
  assert.equal(result.stderr, "");
  assert.deepEqual(events(result.stdout), ["supervisor_started"]);
  await assertReleased(harness, child.pid, readyFiles, readyDatabases);
});

it("CT-MAIN-03: startup failures exit 1 without token bytes: missing token file (path shown via runMain's nested cause) and invalid helper id",
  { timeout: 60_000 }, async (t) => {
    const harness = await supervisorHarness(t);
    const canaries = ["guidance", "project-write", "project-commit", "git-probe"].map((name) => `${name}-canary-${harness.token.slice(0, 16)}`);
    const canaryFiles = await Promise.all(canaries.map(async (canary, index) => {
      const path = join(harness.home, `canary-${index}`);
      await writeFile(path, canary, { mode: 0o600 });
      return path;
    }));
    const missingTokenFile = join(harness.home, "missing-t3-read-token");
    const entries = [["main.ts", [mainSource]], ["cli start", [cliSource, "start"]]] as const;
    for (const [label, entry] of entries) {
      const dataDirectory = await mkdtemp(join(harness.home, "data-"));
      const missing = await runProcess(process.execPath, ["--import", tsxLoader, ...entry], {
        cwd: harness.home, timeoutMs: exitTimeoutMs,
        env: { ...harness.env, DATA_DIRECTORY: dataDirectory, T3_TOKEN_FILE: missingTokenFile,
          T3_GUIDANCE_TOKEN_FILE: canaryFiles[0], T3_PROJECT_WRITE_TOKEN_FILE: canaryFiles[1],
          T3_PROJECT_COMMIT_TOKEN_FILE: canaryFiles[2], T3_GIT_PROBE_TOKEN_FILE: canaryFiles[3] },
      });
      assert.deepEqual({ code: missing.code, signal: missing.signal }, { code: 1, signal: null }, label);
      assert.deepEqual(leakedSecrets(missing.stdout + missing.stderr, [harness.token, ...canaries]), [], label);
      // baseline rendering: runMain's default logger reports the UnknownError on stdout, not stderr, with its ENOENT cause
      // naming the configured path (configuration, not a secret; BC-CLI-04 replaces it with a fixed message)
      assert.equal(missing.stderr, "", label);
      assert.match(missing.stdout, /^\[[\d:.]+\] ERROR \(#\d+\): UnknownError: An error occurred in Effect\.tryPromise$/mu, label);
      assert.ok(missing.stdout.includes(`[cause]: Error: ENOENT: no such file or directory, open '${missingTokenFile}'`), label);

      const invalidDataDirectory = join(harness.home, `invalid-${label.replace(/\W/gu, "-")}`);
      const invalid = await runProcess(process.execPath, ["--import", tsxLoader, ...entry], {
        cwd: harness.home, timeoutMs: exitTimeoutMs,
        env: { ...harness.env, DATA_DIRECTORY: invalidDataDirectory, SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID: "a b" },
      });
      assert.deepEqual({ code: invalid.code, signal: invalid.signal }, { code: 1, signal: null }, label);
      assert.equal(invalid.stdout, "", label);
      assert.deepEqual(leakedSecrets(invalid.stderr, [harness.token]), [], label);
      // baseline: loadConfig throws at module top level, so node prints the uncaught error with its stack
      assert.match(invalid.stderr, /^Error: invalid_helper_provider_instance_id$/mu, label);
      assert.match(invalid.stderr, /^\s+at loadHelperProviderInstanceId \(/mu, label);
      await assert.rejects(stat(invalidDataDirectory), { code: "ENOENT" }, "configuration fails before any store opens");
    }
  });

describe("built and installed bin", () => {
  let prepared: InstalledBin | undefined;
  // build + pack + offline install of the packed package; bounded separately because it runs tsc and npm
  beforeAll(async () => { prepared = await prepareInstalledBin(); }, 120_000);
  afterAll(async () => { if (prepared) await rm(prepared.root, { recursive: true, force: true }); });
  const bin = (): InstalledBin => {
    if (prepared === undefined) throw new Error("the installed bin was not prepared");
    return prepared;
  };

  it.for(["SIGINT", "SIGTERM"] as const)("CT-CLI-BIN-02: %s after readiness exits 130 and releases listeners and databases", { timeout: 60_000 },
    async (signal, t) => {
      const harness = await supervisorHarness(t, { activeThreads: 1, archiveThreads: 1 });
      const child = harness.start(bin().installedBin, ["start"]);
      await waitUntilReady(harness, child);
      assert.deepEqual(await listenerStates(harness), { health: "open", ui: "open", mcp: "open" });
      const result = await signalAndWait(child, signal);
      assert.deepEqual({ code: result.code, signal: result.signal }, interruptExit);
      assert.equal(result.stderr, "");
      assert.deepEqual(events(result.stdout), ["supervisor_started"]);
      await assertReleased(harness, child.pid, readyFiles, readyDatabases);
    });

  it.for(["SIGINT", "SIGTERM"] as const)("CT-CLI-BIN-02: %s during partial acquisition (store open, descriptor retry pending) exits 130 and releases what was acquired",
    { timeout: 60_000 }, async (signal, t) => {
      const harness = await supervisorHarness(t, { descriptor: "unavailable" });
      const child = harness.start(bin().installedBin, ["start"]);
      await waitUntilDescriptorRetry(harness, child);
      // supervision starts only after the descriptor, so the UI and MCP listeners were never acquired
      assert.deepEqual(await listenerStates(harness), { health: "open", ui: "refused", mcp: "refused" });
      const result = await signalAndWait(child, signal);
      assert.deepEqual({ code: result.code, signal: result.signal }, interruptExit);
      assert.equal(result.stderr, "");
      assert.deepEqual(events(result.stdout), ["supervisor_started"]);
      assert.deepEqual(harness.fake.traffic.requests, [], "no subscription before a descriptor");
      await assertReleased(harness, child.pid, ["catalog.sqlite3", "thread-settings.sqlite3"], ["catalog.sqlite3", "thread-settings.sqlite3"]);
    });
});
