import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, it, type TestContext } from "vitest";
import { createServiceAuth } from "../src/service-auth.js";
import { prepareInstalledBin, type InstalledBin } from "./support/cli-bin.js";
import { groupAlive, leakedSecrets, nodePath, repositoryRoot, runProcess, startProcess, tokenLineShape, tsxLoader,
  type ProcessResult } from "./support/cli-process.js";
import { dataFiles, listenerStates, quickChecks, supervisorHarness, waitUntilDescriptorRetry, waitUntilReady,
  type SupervisorHarness } from "./support/cli-supervisor.js";
import { after } from "./support/node-test.js";

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

const usage = "Usage: t3-supervisor start [--data-dir <absolute-path>]\n       t3-supervisor auth forge [--data-dir <absolute-path>]\n";
const forgeFailure = "Could not issue a sign-in token. Run as the account that runs T3 Supervisor, after the service has initialized. " +
  "If it uses a custom state directory, pass --data-dir <absolute-path> or the same DATA_DIRECTORY. Pending tokens expire after five minutes.\n";
const tokenLine = { lines: 1, endsWithNewline: true, tokenLength: 43, canonical: true };

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

  const entry = (variant: "built dist/cli.js" | "installed bin"): [string, string[]] =>
    variant === "installed bin" ? [bin().installedBin, []] : [process.execPath, [bin().builtCli]];

  // a private home with an initialized instance whose auth state stays open in this process
  const forgeState = async (t: TestContext, prefix: string) => {
    const home = await mkdtemp(join(tmpdir(), prefix));
    const state = join(home, "state");
    const auth = await createServiceAuth(state);
    after(t, async () => {
      auth.close();
      await rm(home, { recursive: true, force: true });
    });
    const workflowToken = await readFile(join(state, "access", "workflow-mcp-token"), "utf8");
    return { home, state, auth, workflowToken, env: { PATH: nodePath(), HOME: home, TMPDIR: home } };
  };

  it.for(["built dist/cli.js", "installed bin"] as const)("CT-CLI-BIN-01: %s representative argv keeps usage, exit codes and token-only forge output",
    { timeout: 60_000 }, async (variant, t) => {
      const { home, state, auth, workflowToken, env } = await forgeState(t, "cli-bin-argv-");
      const [command, prefix] = entry(variant);
      // recorded from today's build; the target differs only by BC-CLI-01..04
      const table: ReadonlyArray<{ argv: string[]; expected: Omit<ProcessResult, "signal"> }> = [
        { argv: ["--help"], expected: { code: 0, stdout: usage, stderr: "" } },
        { argv: ["-h"], expected: { code: 0, stdout: usage, stderr: "" } },
        { argv: [], expected: { code: 2, stdout: "", stderr: usage } },
        { argv: ["unknown"], expected: { code: 2, stdout: "", stderr: usage } },
        { argv: ["auth", "forge", "--data-dir", "relative-state"], expected: { code: 2, stdout: "", stderr: usage } },
        { argv: ["auth", "forge", "--data-dir", state, "extra"], expected: { code: 2, stdout: "", stderr: usage } },
        { argv: ["auth", "forge", "--data-dir", join(home, "uninitialized")], expected: { code: 1, stdout: "", stderr: forgeFailure } },
      ];
      const outputs: string[] = [];
      for (const row of table) {
        const result = await runProcess(command, [...prefix, ...row.argv], { env, cwd: home, timeoutMs: exitTimeoutMs });
        outputs.push(result.stdout, result.stderr);
        assert.deepEqual(result, { ...row.expected, signal: null }, `${variant} ${row.argv.join(" ")}`);
      }
      const issued: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const success = await runProcess(command, [...prefix, "auth", "forge", "--data-dir", state], { env, cwd: home, timeoutMs: exitTimeoutMs });
        outputs.push(success.stderr);
        // exactly one 43-character token line, empty stderr (so no ExperimentalWarning), compared by shape only
        assert.deepEqual({ code: success.code, signal: success.signal, stderr: success.stderr, stdout: tokenLineShape(success.stdout) },
          { code: 0, signal: null, stderr: "", stdout: tokenLine }, variant);
        issued.push(success.stdout.trim());
      }
      assert.notEqual(issued[0], issued[1], "every forge issues a new token");
      for (const token of issued) assert.equal(typeof auth.login(token), "string", `${variant} token signs in`);
      assert.deepEqual(leakedSecrets(outputs.join("\n"), [workflowToken, ...issued]), [], "no output other than the forge stdout carries a token");
    });

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

  it("CT-CLI-BIN-03: SIGINT during a forge waiting on the login lock writes no grant, prints no token and leaves the lock holder unaffected",
    { timeout: 60_000 }, async (t) => {
      const { home, state, workflowToken, env } = await forgeState(t, "cli-bin-lock-");
      const database = join(state, "access", "login.sqlite3");
      const holderHash = createHash("sha256").update(randomBytes(32)).digest("hex");
      // a second process holds BEGIN IMMEDIATE until told to insert its own grant and commit
      const holder = startProcess(process.execPath, ["-e", [
        "const {DatabaseSync} = require('node:sqlite');",
        "const database = new DatabaseSync(process.argv[1]);",
        "database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');",
        "process.stdout.write('locked\\n');",
        "process.stdin.setEncoding('utf8').once('data', () => {",
        "  database.prepare('INSERT INTO dashboard_login_grants(token_hash, issued_at, expires_at) VALUES(?,?,?)').run(process.argv[2], Date.now(), Date.now() + 60000);",
        "  database.exec('COMMIT'); database.close(); process.stdout.write('committed\\n'); process.stdin.destroy();",
        "});",
      ].join("\n"), database, holderHash], { env, cwd: home, stdin: "pipe" });
      after(t, () => holder.dispose());
      await holder.waitForStdout((stdout) => stdout === "locked\n", 15_000, "the held lock");

      // forge chmods the database to 0600 right before its busy wait on BEGIN IMMEDIATE; a looser mode makes that step observable
      await chmod(database, 0o640);
      const forge = startProcess(bin().installedBin, ["auth", "forge", "--data-dir", state], { env, cwd: home });
      after(t, () => forge.dispose());
      const deadline = performance.now() + 15_000;
      while (((await stat(database)).mode & 0o777) !== 0o600) {
        if (performance.now() > deadline || forge.child.exitCode !== null) throw new Error("forge did not reach the login database");
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const signalledAt = performance.now();
      process.kill(forge.pid, "SIGINT");
      const interrupted = await forge.closed(exitTimeoutMs);
      const exitMs = performance.now() - signalledAt;
      // baseline: forge installs no signal handler, so the default disposition ends it at once, well inside busy_timeout (5000 ms)
      assert.deepEqual(interrupted, { code: null, signal: "SIGINT", stdout: "", stderr: "" });
      assert.ok(exitMs < 5_000, `exit took ${Math.round(exitMs)} ms`);

      holder.child.stdin?.write("commit\n");
      await holder.waitForStdout((stdout) => stdout === "locked\ncommitted\n", 15_000, "the holder commit");
      assert.deepEqual(await holder.closed(exitTimeoutMs), { code: 0, signal: null, stdout: "locked\ncommitted\n", stderr: "" });

      assert.deepEqual((await readdir(join(state, "access"))).sort(), ["login.sqlite3", "workflow-mcp-token"], "no hot journal is left");
      const check = new DatabaseSync(database);
      try {
        assert.deepEqual({ ...check.prepare("PRAGMA quick_check").get() }, { quick_check: "ok" });
        assert.deepEqual(check.prepare("SELECT token_hash FROM dashboard_login_grants").all().map((row) => ({ ...row })), [{ token_hash: holderHash }]);
      } finally {
        check.close();
      }
      assert.deepEqual(leakedSecrets(interrupted.stdout + interrupted.stderr, [workflowToken]), []);
    });
});
