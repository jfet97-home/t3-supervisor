import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "vitest";
import { createServiceAuth } from "../src/service-auth.js";
import { leakedSecrets, nodePath, repositoryRoot, runProcess, tokenLineShape, tsxLoader, type ProcessResult } from "./support/cli-process.js";
import { after } from "./support/node-test.js";

// the cli on its tsx source path in a real child process: exact usage bytes, exit codes and forge output

const command = join(repositoryRoot, "src", "cli.ts");
const usage = "Usage: t3-supervisor start [--data-dir <absolute-path>]\n       t3-supervisor auth forge [--data-dir <absolute-path>]\n";
const forgeFailure = "Could not issue a sign-in token. Run as the account that runs T3 Supervisor, after the service has initialized. " +
  "If it uses a custom state directory, pass --data-dir <absolute-path> or the same DATA_DIRECTORY. Pending tokens expire after five minutes.\n";
const tokenLine = { lines: 1, endsWithNewline: true, tokenLength: 43, canonical: true };

const home = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "cli-characterization-"));
  after(t, () => rm(directory, { recursive: true, force: true }));
  return directory;
};

const invoke = (cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): Promise<ProcessResult> =>
  runProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", tsxLoader, command, ...args],
    { cwd, env: { PATH: nodePath(), HOME: cwd, TMPDIR: cwd, ...env }, timeoutMs: 30_000 });

it("CT-CLI-01: --help and -h write the exact two-line usage to stdout with empty stderr and exit 0", { timeout: 60_000 }, async (t) => {
  const cwd = await home(t);
  for (const flag of ["--help", "-h"]) assert.deepEqual(await invoke(cwd, [flag]), { code: 0, signal: null, stdout: usage, stderr: "" }, flag);
});

it("CT-CLI-02: malformed --data-dir forms, extra arguments and a missing value exit 2 with the exact usage on stderr only", { timeout: 60_000 }, async (t) => {
  const cwd = await home(t);
  const cases = [
    ["auth", "forge", "--data-dir", "relative"],
    ["auth", "forge", `--data-dir=${join(cwd, "absolute")}`],
    ["auth", "forge", "extra"],
    ["start", "--data-dir"],
  ];
  for (const args of cases) assert.deepEqual(await invoke(cwd, args), { code: 2, signal: null, stdout: "", stderr: usage }, args.join(" "));
});

it("CT-CLI-03: forge succeeds with an invalid helper instance id and a missing T3 token file because it loads no service configuration",
  { timeout: 60_000 }, async (t) => {
    const cwd = await home(t);
    const state = join(cwd, "state");
    const auth = await createServiceAuth(state);
    after(t, () => auth.close());
    const issued = await invoke(cwd, ["auth", "forge"], {
      DATA_DIRECTORY: state,
      SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID: "invalid helper id",
      T3_TOKEN_FILE: join(cwd, "missing-t3-token"),
    });
    assert.deepEqual({ code: issued.code, signal: issued.signal, stderr: issued.stderr, stdout: tokenLineShape(issued.stdout) },
      { code: 0, signal: null, stderr: "", stdout: tokenLine });
    assert.equal(typeof auth.login(issued.stdout.trim()), "string", "the forged token signs in");
  });

it("CT-CLI-04: forge failure prints exactly the fixed sentence without path, stack or token; a successful token never reaches stderr",
  { timeout: 60_000 }, async (t) => {
    const cwd = await home(t);
    const state = join(cwd, "state");
    const auth = await createServiceAuth(state);
    after(t, () => auth.close());
    const workflowToken = await readFile(join(state, "access", "workflow-mcp-token"), "utf8");
    const success = await invoke(cwd, ["auth", "forge", "--data-dir", state]);
    assert.deepEqual({ code: success.code, signal: success.signal, stderr: success.stderr, stdout: tokenLineShape(success.stdout) },
      { code: 0, signal: null, stderr: "", stdout: tokenLine });
    const token = success.stdout.trim();

    // missing service state, then the same instance after its login database lost a table
    const missing = await invoke(cwd, ["auth", "forge", "--data-dir", join(cwd, "uninitialized")]);
    const database = new DatabaseSync(join(state, "access", "login.sqlite3"));
    try {
      database.exec("DROP TABLE dashboard_login_sessions");
    } finally {
      database.close();
    }
    const damaged = await invoke(cwd, ["auth", "forge", "--data-dir", state]);
    for (const [label, failure] of [["missing state", missing], ["damaged database", damaged]] as const) {
      assert.deepEqual(failure, { code: 1, signal: null, stdout: "", stderr: forgeFailure }, label);
      assert.equal(failure.stderr.includes(cwd), false, `${label} names no path`);
      assert.doesNotMatch(failure.stderr, /^\s+at /mu, `${label} prints no stack`);
      assert.deepEqual(leakedSecrets(failure.stdout + failure.stderr, [token, workflowToken]), [], label);
    }
    assert.deepEqual(leakedSecrets(success.stderr, [token, workflowToken]), []);
  });
