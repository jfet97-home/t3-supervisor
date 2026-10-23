import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { tsxLoader, type ProcessResult } from "./support/cli-process.js";
import { openServiceAuth, temporaryDirectory } from "./support/g8-auth.js";
import { runProcess } from "./support/g8-process.js";
import { privately } from "./support/private-assert.js";

// the auth CLI in real child processes against service auth state on real files: live (it.live)

const command = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// the CLI run to its exit within 5 s and 4096 characters per stream: its output on exit 0, otherwise a failure carrying
// the exit code and output
const execute = (env: NodeJS.ProcessEnv, args: ReadonlyArray<string>) => Effect.flatMap(runProcess(process.execPath,
  ["--disable-warning=ExperimentalWarning", "--import", tsxLoader, command, ...args], {env, cwd: tmpdir(), timeoutMs: 5_000, maxBuffer: 4096}),
  (result): Effect.Effect<ProcessResult, ProcessResult> => result.code === 0 ? Effect.succeed(result) : Effect.fail(result));
const invoke = (directory: string, args = ["auth", "forge"]) => execute({...process.env, DATA_DIRECTORY: directory}, args);
const sessionRows = (directory: string): Array<Record<string, unknown>> => {
  const database = new DatabaseSync(join(directory, "access", "login.sqlite3"));
  try {
    return database.prepare("SELECT rowid, token_hash, issued_at, expires_at FROM dashboard_login_sessions ORDER BY rowid").all();
  } finally {
    database.close();
  }
};

it.live("the local CLI mints a new single-use token into the running service's auth state", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporaryDirectory("supervisor-auth-cli-");
  const auth = yield* openServiceAuth(directory);
  const schema = new DatabaseSync(join(directory, "access", "login.sqlite3"));
  try {
    assert.deepEqual(
      schema.prepare("SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name").all()
        .map(object => [object.type, object.name]),
      [["table", "dashboard_login_grants"], ["table", "dashboard_login_sessions"]],
    );
  } finally {
    schema.close();
  }

  const issued = yield* invoke(directory);
  assert.match(issued.stdout, /^[A-Za-z0-9_-]{43}\n$/u);
  assert.equal(issued.stderr, "");
  const token = issued.stdout.trim();
  const workflowToken = yield* fs.readFileString(join(directory, "access/workflow-mcp-token"));
  assert.equal(token === workflowToken, false);
  const session = yield* auth.login(token);
  assert.equal(typeof session, "string");
  assert.equal(yield* auth.login(token), null);
  assert.equal(yield* auth.authenticated(session ?? undefined), true);
  const sessionsBeforeForge = sessionRows(directory);
  const next = (yield* invoke(directory)).stdout.trim();
  assert.equal(next === token, false);
  assert.deepEqual(sessionRows(directory), sessionsBeforeForge, "CLI grants do not alter or renew session rows");
  assert.equal(typeof (yield* auth.login(next)), "string");
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("the local CLI rejects an existing database without both current auth tables", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporaryDirectory("supervisor-auth-cli-schema-");
  const auth = yield* openServiceAuth(directory);
  yield* auth.close;
  const database = new DatabaseSync(join(directory, "access", "login.sqlite3"));
  database.exec("DROP TABLE dashboard_login_sessions");
  database.close();
  const before = Buffer.from(yield* fs.readFile(join(directory, "access", "login.sqlite3")));
  const failure = yield* Effect.flip(invoke(directory));
  assert.equal(failure.code, 1);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /after the service has initialized/u);
  assert.ok(Buffer.from(yield* fs.readFile(join(directory, "access", "login.sqlite3"))).equals(before));
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("the local CLI does not bootstrap missing service state or accept unknown commands", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporaryDirectory("supervisor-auth-cli-missing-");
  const missing = yield* Effect.flip(invoke(directory));
  assert.equal(missing.code, 1);assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /account that runs T3 Supervisor/u);
  assert.deepEqual(yield* fs.readDirectory(directory), []);
  const failure = yield* Effect.flip(invoke(directory, ["unknown"]));
  // BC-CLI-02: the help goes to stdout and the parse error to stderr, still exit 2
  assert.equal(failure.code, 2);
  privately("unknown command output", [], () => {assert.match(failure.stdout, /USAGE/u);assert.match(failure.stderr, /Unknown subcommand "unknown"/u);});
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("direct installations find the user state from any directory and support an explicit instance", () => Effect.gen(function* () {
  const home = yield* temporaryDirectory("supervisor-auth-cli-home-");
  const directory = join(home, ".local", "state", "t3-supervisor");
  const auth = yield* openServiceAuth(directory);
  const env: NodeJS.ProcessEnv = {...process.env, HOME: home};
  delete env.DATA_DIRECTORY;
  delete env.XDG_STATE_HOME;
  const issued = yield* execute(env, ["auth", "forge"]);
  assert.equal(typeof (yield* auth.login(issued.stdout.trim())), "string");
  const explicit = yield* invoke(join(home, "unused"), ["auth", "forge", "--data-dir", directory]);
  assert.equal(typeof (yield* auth.login(explicit.stdout.trim())), "string");
  yield* Effect.flip(invoke(directory, ["auth", "forge", "--data-dir", "relative-path"]));
  const help = yield* invoke(directory, ["--help"]);
  assert.match(help.stdout, /t3-supervisor auth forge/u);
  assert.equal(help.stderr, "");
}).pipe(Effect.provide(NodeFileSystem.layer)));
