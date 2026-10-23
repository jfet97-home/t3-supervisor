import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { openServiceAuth, temporaryDirectory } from "./support/g8-auth.js";
import { leakedSecrets, nodePath, repositoryRoot, tokenLineShape, tsxLoader, type ProcessResult } from "./support/cli-process.js";
import { runProcess } from "./support/g8-process.js";
import { privately } from "./support/private-assert.js";
import { forgeHelp, relativeDataDirectory, rootHelp, startHelp, usageError } from "./support/cli-help.js";

// the cli on its tsx source path in a real child process: exact help bytes, exit codes and forge output. live (it.live)
// for the child processes and the service auth state on real files

const command = join(repositoryRoot, "src", "cli.ts");
const forgeFailure = "Could not issue a sign-in token. Run as the account that runs T3 Supervisor, after the service has initialized. " +
  "If it uses a custom state directory, pass --data-dir <absolute-path> or the same DATA_DIRECTORY. Pending tokens expire after five minutes.\n";
const tokenLine = { lines: 1, endsWithNewline: true, tokenLength: 43, canonical: true };

// a private home removed with the test's scope
const home = temporaryDirectory("cli-characterization-");

const invoke = (cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): Effect.Effect<ProcessResult> =>
  runProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", tsxLoader, command, ...args],
    { cwd, env: { PATH: nodePath(), HOME: cwd, TMPDIR: cwd, ...env }, timeoutMs: 30_000 });

it.live("CT-CLI-01: --help and -h write the exact two-line usage to stdout with empty stderr and exit 0", () => Effect.gen(function* () {
  const cwd = yield* home;
  // BC-CLI-01: the help effect/cli renders replaces the hand-written usage
  for (const flag of ["--help", "-h"]) {
    const result = yield* invoke(cwd, [flag]);
    privately(flag, [], () => assert.deepEqual(result, { code: 0, signal: null, stdout: rootHelp, stderr: "" }));
  }
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

it.live("CT-CLI-02: malformed --data-dir forms, extra arguments and a missing value exit 2 with the exact usage on stderr only", () => Effect.gen(function* () {
  const cwd = yield* home;
  // BC-CLI-02: a usage error prints the command's help on stdout and the parse error on stderr, still exit 2;
  // BC-CLI-03: the equals form is accepted, so on an uninitialized absolute directory it is a forge failure
  const cases: ReadonlyArray<readonly [ReadonlyArray<string>, Omit<ProcessResult, "signal">]> = [
    [["auth", "forge", "--data-dir", "relative"], { code: 2, stdout: forgeHelp, stderr: relativeDataDirectory("relative") }],
    [["auth", "forge", `--data-dir=${join(cwd, "absolute")}`], { code: 1, stdout: "", stderr: forgeFailure }],
    [["auth", "forge", "extra"], { code: 2, stdout: forgeHelp, stderr: usageError("Unexpected positional argument: \"extra\"") }],
    [["start", "--data-dir"], { code: 2, stdout: startHelp, stderr: usageError("Missing value for flag --data-dir. Expected: absolute-path") }],
  ];
  for (const [args, expected] of cases) {
    const result = yield* invoke(cwd, args);
    privately(args.join(" "), [], () => assert.deepEqual(result, { ...expected, signal: null }));
  }
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

it.live("CT-CLI-03: forge succeeds with an invalid helper instance id and a missing T3 token file because it loads no service configuration",
  () => Effect.gen(function* () {
    const cwd = yield* home;
    const state = join(cwd, "state");
    const auth = yield* openServiceAuth(state);
    const issued = yield* invoke(cwd, ["auth", "forge"], {
      DATA_DIRECTORY: state,
      SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID: "invalid helper id",
      T3_TOKEN_FILE: join(cwd, "missing-t3-token"),
    });
    privately("forge output", [issued.stdout.trim()], () =>
      assert.deepEqual({ code: issued.code, signal: issued.signal, stderr: issued.stderr, stdout: tokenLineShape(issued.stdout) },
        { code: 0, signal: null, stderr: "", stdout: tokenLine }));
    const session = yield* auth.login(issued.stdout.trim());
    privately("the forged token signs in", [issued.stdout.trim()], () => assert.equal(typeof session, "string"));
  }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

it.live("CT-CLI-04: forge failure prints exactly the fixed sentence without path, stack or token; a successful token never reaches stderr",
  () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* home;
    const state = join(cwd, "state");
    yield* openServiceAuth(state);
    const workflowToken = yield* fs.readFileString(join(state, "access", "workflow-mcp-token"));
    const success = yield* invoke(cwd, ["auth", "forge", "--data-dir", state]);
    const token = success.stdout.trim();
    privately("forge output", [token, workflowToken], () =>
      assert.deepEqual({ code: success.code, signal: success.signal, stderr: success.stderr, stdout: tokenLineShape(success.stdout) },
        { code: 0, signal: null, stderr: "", stdout: tokenLine }));

    // missing service state, then the same instance after its login database lost a table
    const missing = yield* invoke(cwd, ["auth", "forge", "--data-dir", join(cwd, "uninitialized")]);
    const database = new DatabaseSync(join(state, "access", "login.sqlite3"));
    try {
      database.exec("DROP TABLE dashboard_login_sessions");
    } finally {
      database.close();
    }
    const damaged = yield* invoke(cwd, ["auth", "forge", "--data-dir", state]);
    for (const [label, failure] of [["missing state", missing], ["damaged database", damaged]] as const) {
      privately(label, [token, workflowToken], () => assert.deepEqual(failure, { code: 1, signal: null, stdout: "", stderr: forgeFailure }));
      assert.equal(failure.stderr.includes(cwd), false, `${label} names no path`);
      assert.equal(/^\s+at /mu.test(failure.stderr), false, `${label} prints no stack`);
      assert.deepEqual(leakedSecrets(failure.stdout + failure.stderr, [token, workflowToken]), [], label);
    }
    assert.deepEqual(leakedSecrets(success.stderr, [token, workflowToken]), []);
  }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });
