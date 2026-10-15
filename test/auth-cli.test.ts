import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createServiceAuth } from "../src/service-auth.js";

const execute = promisify(execFile);
const command = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
const invoke = (directory: string, args = ["auth", "forge"]) => execute(process.execPath,
  ["--disable-warning=ExperimentalWarning", "--import", loader, command, ...args],
  {env: {...process.env, DATA_DIRECTORY: directory}, cwd: tmpdir(), timeout: 5_000, maxBuffer: 4096});

test("the local CLI mints a new single-use token into the running service's auth state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-auth-cli-"));
  const auth = await createServiceAuth(directory);
  try {
    const issued = await invoke(directory);
    assert.match(issued.stdout, /^[A-Za-z0-9_-]{43}\n$/u);
    assert.equal(issued.stderr, "");
    const token = issued.stdout.trim();
    const workflowToken = await readFile(join(directory, "access/workflow-mcp-token"), "utf8");
    assert.equal(token === workflowToken, false);
    const session = auth.login(token);
    assert.equal(typeof session, "string");
    assert.equal(auth.login(token), null);
    assert.equal(auth.authenticated(session ?? undefined), true);
    const next = (await invoke(directory)).stdout.trim();
    assert.equal(next === token, false);
    assert.equal(typeof auth.login(next), "string");
  } finally {auth.close();await rm(directory, {recursive: true, force: true});}
});

test("the local CLI does not bootstrap missing service state or accept unknown commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-auth-cli-missing-"));
  try {
    await assert.rejects(invoke(directory), (error: unknown) => {
      const failure = error as {code: number; stdout: string; stderr: string};
      assert.equal(failure.code, 1);assert.equal(failure.stdout, "");
      assert.match(failure.stderr, /account that runs T3 Supervisor/u);
      return true;
    });
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(invoke(directory, ["unknown"]), (error: unknown) => {
      const failure = error as {code: number; stdout: string; stderr: string};
      assert.equal(failure.code, 2);assert.equal(failure.stdout, "");
      assert.match(failure.stderr, /Usage:/u);return true;
    });
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("direct installations find the user state from any directory and support an explicit instance", async () => {
  const home = await mkdtemp(join(tmpdir(), "supervisor-auth-cli-home-"));
  const directory = join(home, ".local", "state", "t3-supervisor");
  const auth = await createServiceAuth(directory);
  try {
    const env: NodeJS.ProcessEnv = {...process.env, HOME: home};
    delete env.DATA_DIRECTORY;
    delete env.XDG_STATE_HOME;
    const issued = await execute(process.execPath,
      ["--disable-warning=ExperimentalWarning", "--import", loader, command, "auth", "forge"],
      {env, cwd: tmpdir(), timeout: 5_000, maxBuffer: 4096});
    assert.equal(typeof auth.login(issued.stdout.trim()), "string");
    const explicit = await invoke(join(home, "unused"), ["auth", "forge", "--data-dir", directory]);
    assert.equal(typeof auth.login(explicit.stdout.trim()), "string");
    await assert.rejects(invoke(directory, ["auth", "forge", "--data-dir", "relative-path"]));
    const help = await invoke(directory, ["--help"]);
    assert.match(help.stdout, /t3-supervisor auth forge/u);
    assert.equal(help.stderr, "");
  } finally {auth.close();await rm(home, {recursive: true, force: true});}
});
