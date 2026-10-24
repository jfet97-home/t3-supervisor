import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { it, layer } from "@effect/vitest";
import { Clock, Effect, FileSystem, Layer } from "effect";
import { openServiceAuth, temporaryDirectory } from "./support/g8-auth.js";
import { groupAlive, leakedSecrets, nodePath, repositoryRoot, tokenLineShape, tsxLoader,
  type ProcessResult } from "./support/cli-process.js";
import { runProcess, startProcess, type RunningProcess } from "./support/g8-process.js";
import { privately } from "./support/private-assert.js";
import { privatelyEffect } from "./support/g8-private.js";
import { dataFiles, InstalledBin, installedBinLayer, listenerStates, quickChecks, supervisorHarness, waitUntilDescriptorRetry,
  waitUntilReady, type SupervisorHarness } from "./support/g8-cli.js";
import { forgeHelp, relativeDataDirectory, rootHelp, usageError } from "./support/cli-help.js";

// process-level characterization of the supervisor entries: tsx source (main.ts, cli.ts) and the built/installed bin.
// every case runs on the live clock: it.live, and inside the installed bin layer it.effect without the test services,
// for the child processes, loopback listeners and the real busy wait timing

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

const forgeFailure = "Could not issue a sign-in token. Run as the account that runs T3 Supervisor, after the service has initialized. " +
  "If it uses a custom state directory, pass --data-dir <absolute-path> or the same DATA_DIRECTORY. Pending tokens expire after five minutes.\n";
const tokenLine = { lines: 1, endsWithNewline: true, tokenLength: 43, canonical: true };

const events = (stdout: string): unknown[] => stdout.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { event?: unknown }).event);

// json lines without their timestamp
const classified = (stdout: string): unknown[] => stdout.split("\n").filter(Boolean).map((line) => {
  const { time, ...fields } = JSON.parse(line) as Record<string, unknown>;
  assert.equal(typeof time, "string");
  return fields;
});

const signalAndWait = (child: RunningProcess, signal: NodeJS.Signals): Effect.Effect<ProcessResult> => Effect.suspend(() => {
  process.kill(child.pid, signal);
  return child.closed(exitTimeoutMs);
});

// after exit: listeners refused, no process left in the group, no wal/shm/journal sidecar, every database reopens with quick_check ok
const assertReleased = (harness: SupervisorHarness, pid: number, files: ReadonlyArray<string>, databases: ReadonlyArray<string>) => Effect.gen(function* () {
  assert.deepEqual(yield* listenerStates(harness), { health: "refused", ui: "refused", mcp: "refused" });
  assert.equal(groupAlive(pid), false, "no process of the supervisor group outlives it");
  assert.deepEqual(yield* dataFiles(harness), files);
  assert.deepEqual(quickChecks(harness, databases), Object.fromEntries(databases.map((name) => [name, "ok"])));
  assert.deepEqual(yield* dataFiles(harness), files, "reopening leaves no sidecar behind");
});

it.live("CT-MAIN-01: SIGTERM after readiness exits 130, closes the health, UI and MCP listeners and every database", () => Effect.gen(function* () {
  const harness = yield* supervisorHarness({ activeThreads: 1, archiveThreads: 1 });
  const child = yield* harness.start(process.execPath, ["--import", tsxLoader, mainSource]);
  yield* waitUntilReady(harness, child);
  assert.deepEqual(yield* listenerStates(harness), { health: "open", ui: "open", mcp: "open" });
  const result = yield* signalAndWait(child, "SIGTERM");
  assert.deepEqual({ code: result.code, signal: result.signal }, interruptExit);
  privately("SIGTERM output", [harness.token], () => {
    assert.equal(result.stderr, "");
    assert.deepEqual(events(result.stdout), ["supervisor_started"]);
  });
  yield* assertReleased(harness, child.pid, readyFiles, readyDatabases);
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

it.live("CT-MAIN-03: startup failures exit 1 with one classified line and no stack, token bytes or token path: missing token file and invalid helper id",
  () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const harness = yield* supervisorHarness();
    const canaries = ["guidance", "project-write", "project-commit", "git-probe"].map((name) => `${name}-canary-${harness.token.slice(0, 16)}`);
    const canaryFiles = yield* Effect.forEach(canaries, (canary, index) => Effect.gen(function* () {
      const path = join(harness.home, `canary-${index}`);
      yield* fs.writeFileString(path, canary, { mode: 0o600 });
      return path;
    }), { concurrency: "unbounded" });
    const missingTokenFile = join(harness.home, "missing-t3-read-token");
    const entries = [["main.ts", [mainSource]], ["cli start", [cliSource, "start"]]] as const;
    for (const [label, entry] of entries) {
      const dataDirectory = yield* fs.makeTempDirectory({ directory: harness.home, prefix: "data-" });
      const missing = yield* runProcess(process.execPath, ["--import", tsxLoader, ...entry], {
        cwd: harness.home, timeoutMs: exitTimeoutMs,
        env: { ...harness.env, DATA_DIRECTORY: dataDirectory, T3_TOKEN_FILE: missingTokenFile,
          T3_GUIDANCE_TOKEN_FILE: canaryFiles[0], T3_PROJECT_WRITE_TOKEN_FILE: canaryFiles[1],
          T3_PROJECT_COMMIT_TOKEN_FILE: canaryFiles[2], T3_GIT_PROBE_TOKEN_FILE: canaryFiles[3] },
      });
      assert.deepEqual({ code: missing.code, signal: missing.signal }, { code: 1, signal: null }, label);
      assert.deepEqual(leakedSecrets(missing.stdout + missing.stderr, [harness.token, ...canaries]), [], label);
      // target rendering (BC-CLI-04): one classified line on stdout naming the reason, without stack, cause or token path
      privately(label, [harness.token, ...canaries], () => {
        assert.equal(missing.stderr, "");
        assert.deepEqual(classified(missing.stdout), [{ event: "supervisor_failed", reason: "t3_token_unavailable" }]);
        assert.equal(missing.stdout.includes(missingTokenFile), false);
        assert.doesNotMatch(missing.stdout, /^\s+at /mu);
      });

      const invalidDataDirectory = join(harness.home, `invalid-${label.replace(/\W/gu, "-")}`);
      const invalid = yield* runProcess(process.execPath, ["--import", tsxLoader, ...entry], {
        cwd: harness.home, timeoutMs: exitTimeoutMs,
        env: { ...harness.env, DATA_DIRECTORY: invalidDataDirectory, SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID: "a b" },
      });
      assert.deepEqual({ code: invalid.code, signal: invalid.signal }, { code: 1, signal: null }, label);
      assert.deepEqual(leakedSecrets(invalid.stdout + invalid.stderr, [harness.token]), [], label);
      // target rendering (BC-CLI-04): the configuration failure is one classified line naming its reason, without a stack
      privately(label, [harness.token], () => {
        assert.equal(invalid.stderr, "");
        assert.deepEqual(classified(invalid.stdout), [{ event: "supervisor_failed", reason: "invalid_helper_provider_instance_id" }]);
        assert.doesNotMatch(invalid.stdout, /^\s+at /mu);
      });
      assert.equal((yield* Effect.flip(fs.stat(invalidDataDirectory))).reason._tag, "NotFound", "configuration fails before any store opens");
    }
  }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

// build + pack + offline install of the packed package, shared by the block and removed after it; its hooks are bounded
// separately because the build runs tsc and pnpm. without the test services every case runs on the live clock
layer(installedBinLayer.pipe(Layer.provideMerge(NodeFileSystem.layer)), { timeout: "120 seconds", excludeTestServices: true })("built and installed bin", (it) => {
  const entry = (bin: InstalledBin["Service"], variant: "built dist/cli.js" | "installed bin"): [string, string[]] =>
    variant === "installed bin" ? [bin.installedBin, []] : [process.execPath, [bin.builtCli]];

  // a private home with an initialized instance whose auth state stays open in this process
  const forgeState = (prefix: string) => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* temporaryDirectory(prefix);
    const state = join(home, "state");
    const auth = yield* openServiceAuth(state);
    const workflowToken = yield* fs.readFileString(join(state, "access", "workflow-mcp-token"));
    return { home, state, auth, workflowToken, env: { PATH: nodePath(), HOME: home, TMPDIR: home } };
  });

  it.effect.each(["built dist/cli.js", "installed bin"] as const)("CT-CLI-BIN-01: %s representative argv keeps usage, exit codes and token-only forge output",
    (variant) => Effect.gen(function* () {
      const { home, state, auth, workflowToken, env } = yield* forgeState("cli-bin-argv-");
      const [command, prefix] = entry(yield* InstalledBin, variant);
      // recorded from today's build; the target differs only by BC-CLI-01..04: effect/cli renders the help (01) and a
      // usage error prints it on stdout with the parse error, if any, on stderr, still exit 2 (02)
      const table: ReadonlyArray<{ argv: string[]; expected: Omit<ProcessResult, "signal"> }> = [
        { argv: ["--help"], expected: { code: 0, stdout: rootHelp, stderr: "" } },
        { argv: ["-h"], expected: { code: 0, stdout: rootHelp, stderr: "" } },
        { argv: [], expected: { code: 2, stdout: rootHelp, stderr: "" } },
        { argv: ["unknown"], expected: { code: 2, stdout: rootHelp, stderr: usageError("Unknown subcommand \"unknown\" for \"t3-supervisor\"") } },
        { argv: ["auth", "forge", "--data-dir", "relative-state"], expected: { code: 2, stdout: forgeHelp, stderr: relativeDataDirectory("relative-state") } },
        { argv: ["auth", "forge", "--data-dir", state, "extra"], expected: { code: 2, stdout: forgeHelp, stderr: usageError("Unexpected positional argument: \"extra\"") } },
        { argv: ["auth", "forge", "--data-dir", join(home, "uninitialized")], expected: { code: 1, stdout: "", stderr: forgeFailure } },
      ];
      const outputs: string[] = [];
      for (const row of table) {
        const result = yield* runProcess(command, [...prefix, ...row.argv], { env, cwd: home, timeoutMs: exitTimeoutMs });
        outputs.push(result.stdout, result.stderr);
        privately(`${variant} ${row.argv.join(" ")}`, [workflowToken], () => assert.deepEqual(result, { ...row.expected, signal: null }));
      }
      const issued: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const success = yield* runProcess(command, [...prefix, "auth", "forge", "--data-dir", state], { env, cwd: home, timeoutMs: exitTimeoutMs });
        outputs.push(success.stderr);
        // exactly one 43-character token line, empty stderr (so no ExperimentalWarning), compared by shape only
        privately(variant, [workflowToken, success.stdout.trim(), ...issued], () =>
          assert.deepEqual({ code: success.code, signal: success.signal, stderr: success.stderr, stdout: tokenLineShape(success.stdout) },
            { code: 0, signal: null, stderr: "", stdout: tokenLine }));
        issued.push(success.stdout.trim());
      }
      // compared as a boolean, so a repeated token never appears in the failure
      assert.equal(issued[0] === issued[1], false, "every forge issues a new token");
      for (const token of issued) {
        yield* privatelyEffect(`${variant} token signs in`, issued, Effect.map(auth.login(token), (session) => assert.equal(typeof session, "string")));
      }
      assert.deepEqual(leakedSecrets(outputs.join("\n"), [workflowToken, ...issued]), [], "no output other than the forge stdout carries a token");
    }), { timeout: 60_000 });

  it.effect.each(["SIGINT", "SIGTERM"] as const)("CT-CLI-BIN-02: %s after readiness exits 130 and releases listeners and databases",
    (signal) => Effect.gen(function* () {
      const harness = yield* supervisorHarness({ activeThreads: 1, archiveThreads: 1 });
      const child = yield* harness.start((yield* InstalledBin).installedBin, ["start"]);
      yield* waitUntilReady(harness, child);
      assert.deepEqual(yield* listenerStates(harness), { health: "open", ui: "open", mcp: "open" });
      const result = yield* signalAndWait(child, signal);
      assert.deepEqual({ code: result.code, signal: result.signal }, interruptExit);
      privately(`${signal} output`, [harness.token], () => {
        assert.equal(result.stderr, "");
        assert.deepEqual(events(result.stdout), ["supervisor_started"]);
      });
      yield* assertReleased(harness, child.pid, readyFiles, readyDatabases);
    }), { timeout: 60_000 });

  it.effect.each(["SIGINT", "SIGTERM"] as const)("CT-CLI-BIN-02: %s during partial acquisition (store open, descriptor retry pending) exits 130 and releases what was acquired",
    (signal) => Effect.gen(function* () {
      const harness = yield* supervisorHarness({ descriptor: "unavailable" });
      const child = yield* harness.start((yield* InstalledBin).installedBin, ["start"]);
      yield* waitUntilDescriptorRetry(harness, child);
      // supervision starts only after the descriptor, so the UI and MCP listeners were never acquired
      assert.deepEqual(yield* listenerStates(harness), { health: "open", ui: "refused", mcp: "refused" });
      const result = yield* signalAndWait(child, signal);
      assert.deepEqual({ code: result.code, signal: result.signal }, interruptExit);
      privately(`${signal} output`, [harness.token], () => {
        assert.equal(result.stderr, "");
        assert.deepEqual(events(result.stdout), ["supervisor_started"]);
      });
      assert.deepEqual(harness.fake.traffic.requests, [], "no subscription before a descriptor");
      yield* assertReleased(harness, child.pid, ["catalog.sqlite3", "thread-settings.sqlite3"], ["catalog.sqlite3", "thread-settings.sqlite3"]);
    }), { timeout: 60_000 });

  it.effect("CT-CLI-BIN-03: SIGINT during a forge waiting on the login lock writes no grant, prints no token and leaves the lock holder unaffected",
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, state, workflowToken, env } = yield* forgeState("cli-bin-lock-");
      const database = join(state, "access", "login.sqlite3");
      const holderHash = createHash("sha256").update(randomBytes(32)).digest("hex");
      // a second process holds BEGIN IMMEDIATE until told to insert its own grant and commit
      const holder = yield* startProcess(process.execPath, ["-e", [
        "const {DatabaseSync} = require('node:sqlite');",
        "const database = new DatabaseSync(process.argv[1]);",
        "database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');",
        "process.stdout.write('locked\\n');",
        "process.stdin.setEncoding('utf8').once('data', () => {",
        "  database.prepare('INSERT INTO dashboard_login_grants(token_hash, issued_at, expires_at) VALUES(?,?,?)').run(process.argv[2], Date.now(), Date.now() + 60000);",
        "  database.exec('COMMIT'); database.close(); process.stdout.write('committed\\n'); process.stdin.destroy();",
        "});",
      ].join("\n"), database, holderHash], { env, cwd: home, stdin: "pipe" });
      yield* holder.waitForStdout((stdout) => stdout === "locked\n", 15_000, "the held lock");

      // forge chmods the database to 0600 right before its busy wait on BEGIN IMMEDIATE; a looser mode makes that step observable
      yield* fs.chmod(database, 0o640);
      const forge = yield* startProcess((yield* InstalledBin).installedBin, ["auth", "forge", "--data-dir", state], { env, cwd: home });
      const deadline = (yield* Clock.currentTimeMillis) + 15_000;
      while (((yield* fs.stat(database)).mode & 0o777) !== 0o600) {
        if ((yield* Clock.currentTimeMillis) > deadline || forge.child.exitCode !== null) return yield* Effect.die(new Error("forge did not reach the login database"));
        yield* Effect.sleep("2 millis");
      }
      const signalledAt = yield* Clock.currentTimeMillis;
      process.kill(forge.pid, "SIGINT");
      const interrupted = yield* forge.closed(exitTimeoutMs);
      const exitMs = (yield* Clock.currentTimeMillis) - signalledAt;
      // target: runMain interrupts the forge, which prints nothing and exits 130; a signal that lands in the synchronous busy
      // wait takes effect only when the wait ends, so the exit is bounded by busy_timeout (5000 ms) plus the release
      privately("interrupted forge", [], () => assert.deepEqual(interrupted, { code: 130, signal: null, stdout: "", stderr: "" }));
      assert.ok(exitMs < 5_000 + 2_000, `exit took ${Math.round(exitMs)} ms`);

      holder.child.stdin?.write("commit\n");
      yield* holder.waitForStdout((stdout) => stdout === "locked\ncommitted\n", 15_000, "the holder commit");
      const held = yield* holder.closed(exitTimeoutMs);
      privately("holder output", [workflowToken], () => assert.deepEqual(held, { code: 0, signal: null, stdout: "locked\ncommitted\n", stderr: "" }));

      assert.deepEqual((yield* fs.readDirectory(join(state, "access"))).sort(), ["login.sqlite3", "workflow-mcp-token"], "no hot journal is left");
      const check = new DatabaseSync(database);
      try {
        assert.deepEqual({ ...check.prepare("PRAGMA quick_check").get() }, { quick_check: "ok" });
        assert.deepEqual(check.prepare("SELECT token_hash FROM dashboard_login_grants").all().map((row) => ({ ...row })), [{ token_hash: holderHash }]);
      } finally {
        check.close();
      }
      assert.deepEqual(leakedSecrets(interrupted.stdout + interrupted.stderr, [workflowToken]), []);
    }), { timeout: 60_000 });

  it.effect("a forge interrupted half a second into its wait for the login lock exits 130 when the wait ends, prints nothing and writes no grant",
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, state, workflowToken, env } = yield* forgeState("cli-bin-lock-wait-");
      const database = join(state, "access", "login.sqlite3");
      const holderHash = createHash("sha256").update(randomBytes(32)).digest("hex");
      // a second process holds BEGIN IMMEDIATE until told to insert its own grant and commit
      const holder = yield* startProcess(process.execPath, ["-e", [
        "const {DatabaseSync} = require('node:sqlite');",
        "const database = new DatabaseSync(process.argv[1]);",
        "database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');",
        "process.stdout.write('locked\\n');",
        "process.stdin.setEncoding('utf8').once('data', () => {",
        "  database.prepare('INSERT INTO dashboard_login_grants(token_hash, issued_at, expires_at) VALUES(?,?,?)').run(process.argv[2], Date.now(), Date.now() + 60000);",
        "  database.exec('COMMIT'); database.close(); process.stdout.write('committed\\n'); process.stdin.destroy();",
        "});",
      ].join("\n"), database, holderHash], { env, cwd: home, stdin: "pipe" });
      yield* holder.waitForStdout((stdout) => stdout === "locked\n", 15_000, "the held lock");
      yield* fs.chmod(database, 0o640);
      const forge = yield* startProcess((yield* InstalledBin).installedBin, ["auth", "forge", "--data-dir", state], { env, cwd: home });
      const deadline = (yield* Clock.currentTimeMillis) + 15_000;
      while (((yield* fs.stat(database)).mode & 0o777) !== 0o600) {
        if ((yield* Clock.currentTimeMillis) > deadline || forge.child.exitCode !== null) return yield* Effect.die(new Error("forge did not reach the login database"));
        yield* Effect.sleep("2 millis");
      }
      // half a second later the forge is inside its synchronous wait for the lock, well within the 5 s busy_timeout
      yield* Effect.sleep("500 millis");
      assert.equal(forge.child.exitCode, null, "the forge is still waiting for the lock");
      const signalledAt = yield* Clock.currentTimeMillis;
      process.kill(forge.pid, "SIGINT");
      const interrupted = yield* forge.closed(exitTimeoutMs);
      const exitMs = (yield* Clock.currentTimeMillis) - signalledAt;
      // the signal lands inside the synchronous busy wait: it takes effect when the wait ends, before any failure is reported
      privately("forge interrupted in its lock wait", [], () => assert.deepEqual(interrupted, { code: 130, signal: null, stdout: "", stderr: "" }));
      assert.ok(exitMs < 5_000 + 2_000, `exit took ${Math.round(exitMs)} ms after the signal`);

      holder.child.stdin?.write("commit\n");
      yield* holder.waitForStdout((stdout) => stdout === "locked\ncommitted\n", 15_000, "the holder commit");
      const check = new DatabaseSync(database);
      try {
        assert.deepEqual(check.prepare("SELECT token_hash FROM dashboard_login_grants").all().map((row) => ({ ...row })), [{ token_hash: holderHash }]);
      } finally {
        check.close();
      }
      assert.deepEqual(leakedSecrets(interrupted.stdout + interrupted.stderr, [workflowToken]), []);
    }), { timeout: 60_000 });
});
