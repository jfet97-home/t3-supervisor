import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { tsxLoader } from "./support/cli-process.js";
import { forge, openServiceAuth, seedGrants, temporaryDirectory } from "./support/g8-auth.js";
import { startProcess } from "./support/g8-process.js";

// the Effect service auth on real files: cases that set the service clock run under TestClock (it.effect); cases with a
// child process or worker threads, and those that only read and write the auth files, run live (it.live). the auth
// database is observed and edited through node:sqlite, independent of the service's own client

const temporary = temporaryDirectory("t3-service-auth-test-");

const accessPath = (directory: string): string => join(directory, "access");
const tokenPath = (directory: string): string => join(accessPath(directory), "workflow-mcp-token");
const databasePath = (directory: string): string => join(accessPath(directory), "login.sqlite3");
const isToken = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/u.test(value);

const pendingGrants = (directory: string): Array<Record<string, unknown>> => {
  const database = new DatabaseSync(databasePath(directory));
  try {
    return database.prepare("SELECT token_hash, issued_at, expires_at FROM dashboard_login_grants ORDER BY issued_at").all();
  } finally {
    database.close();
  }
};

const sessionRows = (directory: string): Array<Record<string, unknown>> => {
  const database = new DatabaseSync(databasePath(directory));
  try {
    return database.prepare("SELECT rowid, token_hash, issued_at, expires_at FROM dashboard_login_sessions ORDER BY rowid").all();
  } finally {
    database.close();
  }
};

const authDatabaseTables = (directory: string): Array<Record<string, unknown>> => {
  const database = new DatabaseSync(databasePath(directory));
  try {
    return database.prepare("SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name").all();
  } finally {
    database.close();
  }
};

// the failure of a path that must not exist
const missing = (path: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return (yield* Effect.flip(fs.lstat(path))).reason._tag;
});

const authChild = fileURLToPath(new URL("./support/g8-auth-child.ts", import.meta.url));

// one login or session check by a service auth in its own process, which exits right after its answer
const runAuthChild = (directory: string, action: "login" | "authenticated", token: string) => Effect.scoped(Effect.gen(function* () {
  const child = yield* startProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", tsxLoader, authChild],
    { env: process.env, cwd: tmpdir(), stdin: "pipe" });
  child.child.stdin!.end(JSON.stringify({ directory, action, token }));
  const result = yield* child.closed();
  if (result.code !== 0) return yield* Effect.die(new Error(`service auth child failed: ${result.stderr}`));
  return result.stdout;
}));

// a service auth instance on its own worker thread that consumes the grant once the shared barrier opens; the scope
// terminates the thread
const consumerWorker = (directory: string, token: string, barrier: SharedArrayBuffer) => Effect.acquireRelease(Effect.sync(() => {
  const worker = new Worker(new URL("./support/g8-auth-worker.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    workerData: { directory, token, barrier },
  });
  const ready = Deferred.makeUnsafe<void, Error>();
  const result = Deferred.makeUnsafe<boolean, Error>();
  const exited = Deferred.makeUnsafe<void>();
  const fail = (error: Error) => {
    Deferred.doneUnsafe(ready, Exit.fail(error));
    Deferred.doneUnsafe(result, Exit.fail(error));
  };
  worker.on("message", (message: { kind: string; accepted?: boolean }) => {
    if (message.kind === "ready") Deferred.doneUnsafe(ready, Exit.void);
    else if (message.kind === "result") Deferred.doneUnsafe(result, Exit.succeed(message.accepted === true));
    else fail(new Error("service auth consumer worker failed"));
  });
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (code !== 0) fail(new Error("service auth consumer worker exited unexpectedly"));
    Deferred.doneUnsafe(exited, Exit.void);
  });
  return { worker, ready: Deferred.await(ready), result: Deferred.await(result), exited: Deferred.await(exited) };
}), ({ worker }) => Effect.promise(() => worker.terminate()));

it.effect("service auth persists a private workflow token and stores only hashed one-time dashboard grants", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporary;
  const now = 12_345;
  yield* TestClock.setTime(now);
  const auth = yield* openServiceAuth(directory);
  yield* Effect.gen(function* () {
    const access = accessPath(directory);
    const workflowToken = yield* fs.readFileString(tokenPath(directory));
    assert.equal(isToken(workflowToken), true);
    assert.equal((yield* fs.lstat(access)).mode & 0o777, 0o700);
    assert.equal((yield* fs.lstat(tokenPath(directory))).mode & 0o777, 0o600);
    assert.equal((yield* fs.lstat(databasePath(directory))).mode & 0o777, 0o600);
    assert.deepEqual((yield* fs.readDirectory(access)).sort(), ["login.sqlite3", "workflow-mcp-token"]);
    assert.deepEqual(authDatabaseTables(directory).map(object => [object.type, object.name]), [
      ["table", "dashboard_login_grants"],
      ["table", "dashboard_login_sessions"],
    ]);
    assert.equal(yield* missing(join(access, "dashboard-token")), "NotFound");

    const grant = yield* forge(directory);
    assert.equal(isToken(grant.token), true);
    assert.equal(grant.expiresAt, now + 5 * 60 * 1_000);
    assert.equal(grant.token === workflowToken, false);
    const stored = pendingGrants(directory);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.token_hash === createHash("sha256").update(grant.token).digest("hex"), true);
    assert.equal(stored[0]?.token_hash === grant.token, false);
    assert.equal(stored[0]?.issued_at, now);
    assert.equal(stored[0]?.expires_at, grant.expiresAt);

    const session = yield* auth.login(grant.token);
    assert.equal(typeof session, "string");
    if (session === null) throw new Error("valid dashboard grant was rejected");
    assert.equal(yield* auth.authenticated(session), true);
    assert.equal((yield* auth.login(grant.token)) === null, true);
    assert.equal((yield* auth.login(workflowToken)) === null, true);
    assert.equal((yield* auth.login(Buffer.alloc(32, 7).toString("base64url"))) === null, true);
    assert.equal((yield* auth.login("x".repeat(100_000))) === null, true);
    assert.equal(auth.mcpAuthorized(`Bearer ${workflowToken}`), true);
    assert.equal(auth.mcpAuthorized(`Bearer ${grant.token}`), false);
    assert.equal(auth.mcpAuthorized(`Bearer ${session}`), false);
    assert.equal(yield* auth.authenticated(grant.token), false);
    assert.equal(yield* auth.authenticated(workflowToken), false);
    assert.equal(auth.mcpAuthorized(`bearer ${workflowToken}`), false);
    assert.equal(auth.mcpAuthorized(`Bearer ${workflowToken} `), false);
    assert.equal(auth.mcpAuthorized("Bearer " + "x".repeat(100_000)), false);
    assert.equal(pendingGrants(directory).length, 0);
    const storedSession = sessionRows(directory)[0];
    assert.equal(storedSession?.token_hash === createHash("sha256").update(session).digest("hex"), true);
    assert.equal(storedSession?.token_hash === session, false);
    assert.equal(storedSession?.issued_at, now);
    assert.equal(storedSession?.expires_at, now + 30 * 24 * 60 * 60 * 1_000);
    yield* auth.close;
    assert.equal(yield* auth.authenticated(session), false);
    assert.equal(auth.mcpAuthorized(`Bearer ${workflowToken}`), false);
  }).pipe(Effect.ensuring(Effect.andThen(auth.close, auth.close)));
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.effect("grants and sessions persist across reopen without renewing their original deadlines", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporary;
  let currentTime = 1_000;
  const at = (time: number) => {
    currentTime = time;
    return TestClock.setTime(time);
  };
  yield* at(currentTime);
  let auth = yield* openServiceAuth(directory);
  const workflowToken = yield* fs.readFileString(tokenPath(directory));
  const retained = yield* forge(directory);
  yield* auth.close;
  auth = yield* openServiceAuth(directory);
  const session = yield* auth.login(retained.token);
  assert.equal(typeof session, "string");
  if (session === null) throw new Error("unused grant did not survive restart");
  assert.equal(yield* auth.authenticated(session), true);

  yield* auth.close;
  auth = yield* openServiceAuth(directory);
  assert.equal(auth.mcpAuthorized(`Bearer ${workflowToken}`), true);
  assert.equal((yield* auth.login(retained.token)) === null, true);
  assert.equal(yield* auth.authenticated(session), true);

  yield* at(1_000 - 60_001);
  assert.equal(yield* auth.authenticated(session), false);
  yield* at(1_000 - 60_000);
  assert.equal(yield* auth.authenticated(session), true);
  yield* at(1_000 + 30 * 24 * 60 * 60 * 1_000 - 1);
  assert.equal(yield* auth.authenticated(session), true);
  yield* at(currentTime + 1);
  assert.equal(yield* auth.authenticated(session), false);

  const expired = yield* forge(directory);
  yield* at(expired.expiresAt);
  assert.equal((yield* auth.login(expired.token)) === null, true);
  const fresh = yield* forge(directory);
  assert.equal(fresh.expiresAt, currentTime + 5 * 60 * 1_000);
  assert.equal(pendingGrants(directory).length, 1);
  assert.equal((yield* auth.login(fresh.token)) !== null, true);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("a committed session survives an abrupt child-process exit and a grant cannot replay", () => Effect.gen(function* () {
  const directory = yield* temporary;
  const auth = yield* openServiceAuth(directory);
  const grant = yield* forge(directory);
  yield* auth.close;

  const session = yield* runAuthChild(directory, "login", grant.token);
  assert.equal(isToken(session), true);
  assert.equal(yield* runAuthChild(directory, "authenticated", session), "true");
  assert.equal(yield* runAuthChild(directory, "login", grant.token), "rejected");
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.effect("retained shorter sessions keep their original deadline after the login lifetime changes", () => Effect.gen(function* () {
  const directory = yield* temporary;
  let currentTime = 1_000;
  yield* TestClock.setTime(currentTime);
  let auth = yield* openServiceAuth(directory);
  const grant = yield* forge(directory);
  const session = yield* auth.login(grant.token);
  assert.ok(session);
  yield* auth.close;
  const database = new DatabaseSync(databasePath(directory));
  database.prepare("UPDATE dashboard_login_sessions SET expires_at=?").run(currentTime + 8 * 60 * 60 * 1_000);
  database.close();
  const before = sessionRows(directory);
  auth = yield* openServiceAuth(directory);
  assert.equal(yield* auth.authenticated(session), true);
  assert.deepEqual(sessionRows(directory), before);
  currentTime += 8 * 60 * 60 * 1_000;
  yield* TestClock.setTime(currentTime);
  assert.equal(yield* auth.authenticated(session), false);
}).pipe(Effect.provide(NodeFileSystem.layer)));

// live for the child process that holds the uncommitted insert; the service clock is a TestClock of this case
it.live("SQLite recovers a hot session journal after SIGKILL without losing committed sessions", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporary;
  let currentTime = 3_000;
  yield* TestClock.setTime(currentTime);
  const auth = yield* openServiceAuth(directory);
  const grant = yield* forge(directory);
  const session = yield* auth.login(grant.token);
  assert.ok(session);
  yield* auth.close;

  const databasePathForChild = databasePath(directory);
  const uncommittedHash = createHash("sha256").update("crash-recovery-fixture").digest("hex");
  const source = `
    import { DatabaseSync } from "node:sqlite";
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const payload = JSON.parse(input);
    const database = new DatabaseSync(payload.path);
    database.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
    database.prepare("INSERT INTO dashboard_login_sessions(token_hash,issued_at,expires_at) VALUES(?,?,?)").run(
      payload.hash,
      payload.issuedAt,
      payload.issuedAt + 30 * 24 * 60 * 60 * 1_000,
    );
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1_000);
  `;
  // the scope kills the child if it is still alive
  const child = yield* startProcess(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", source],
    { env: process.env, cwd: tmpdir(), stdin: "pipe" });
  child.child.stdin!.end(JSON.stringify({ path: databasePathForChild, hash: uncommittedHash, issuedAt: currentTime }));
  const started = Exit.isSuccess(yield* Effect.exit(child.waitForStdout((stdout) => stdout.includes("ready\n"), undefined, "ready")))
    ? "ready" : "closed";
  assert.equal(started, "ready", `crash probe failed before writing: ${child.stderr()}`);
  assert.equal((yield* fs.lstat(databasePathForChild + "-journal")).type === "File", true);
  assert.equal(child.child.kill("SIGKILL"), true);
  const { code: exitCode, signal } = yield* child.closed();
  assert.equal(exitCode, null);
  assert.equal(signal, "SIGKILL");

  currentTime += 1;
  yield* TestClock.setTime(currentTime);
  const reopened = yield* openServiceAuth(directory);
  assert.equal(yield* reopened.authenticated(session), true);
  assert.equal(sessionRows(directory).length, 1);
  assert.equal(sessionRows(directory).some(row => row.token_hash === uncommittedHash), false);
}).pipe(Effect.provide(TestClock.layer()), Effect.provide(NodeFileSystem.layer)));

it.live("grant and session tables share one database", () => Effect.gen(function* () {
  const directory = yield* temporary;
  const auth = yield* openServiceAuth(directory);
  const firstGrant = yield* forge(directory);
  const firstSession = yield* auth.login(firstGrant.token);
  assert.ok(firstSession);
  const firstRows = sessionRows(directory);
  assert.deepEqual(authDatabaseTables(directory).map(object => [object.type, object.name]), [
    ["table", "dashboard_login_grants"],
    ["table", "dashboard_login_sessions"],
  ]);

  const secondGrant = yield* forge(directory);
  assert.deepEqual(sessionRows(directory), firstRows, "grant forging leaves session deadlines unchanged");
  assert.equal(yield* auth.authenticated(firstSession), true);
  const secondSession = yield* auth.login(secondGrant.token);
  assert.ok(secondSession);
  assert.equal(yield* auth.authenticated(firstSession), true);
  assert.equal(yield* auth.authenticated(secondSession), true);
  assert.equal(pendingGrants(directory).length, 0);
  yield* auth.logout(firstSession);
  assert.equal(yield* auth.authenticated(firstSession), false);
  assert.equal(yield* auth.authenticated(secondSession), true);
  assert.deepEqual(sessionRows(directory).map(row => row.token_hash), [
    createHash("sha256").update(secondSession).digest("hex"),
  ]);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.effect("failed login rolls back grant consumption, expiry pruning and session eviction", () => Effect.gen(function* () {
  const directory = yield* temporary;
  const sessionTtl = 30 * 24 * 60 * 60 * 1_000;
  const currentTime = 50_000_000;
  yield* TestClock.setTime(currentTime);
  const auth = yield* openServiceAuth(directory);
  const expiredHash = createHash("sha256").update("expired-session-fixture").digest("hex");
  const oldestLiveHash = createHash("sha256").update("live-session-0").digest("hex");
  const database = new DatabaseSync(databasePath(directory));
  try {
    const insertSession = database.prepare(
      "INSERT INTO dashboard_login_sessions(token_hash,issued_at,expires_at) VALUES(?,?,?)",
    );
    insertSession.run(expiredHash, currentTime - sessionTtl - 1_000, currentTime - 1_000);
    for (let index = 0; index < 31; index += 1) {
      const hash = createHash("sha256").update("live-session-" + index).digest("hex");
      const issuedAt = currentTime - sessionTtl + 1_000 + index;
      insertSession.run(hash, issuedAt, issuedAt + sessionTtl);
    }
  } finally {
    database.close();
  }

  const pruneGrant = yield* forge(directory);
  const beforePruneFailure = sessionRows(directory);
  const insertFailure = new DatabaseSync(databasePath(directory));
  insertFailure.exec(
    "CREATE TRIGGER reject_session_insert BEFORE INSERT ON dashboard_login_sessions " +
    "BEGIN SELECT RAISE(ABORT, 'fixture'); END",
  );
  insertFailure.close();
  assert.equal(yield* auth.login(pruneGrant.token), null);
  assert.deepEqual(sessionRows(directory), beforePruneFailure);
  assert.equal(pendingGrants(directory)[0]?.token_hash, createHash("sha256").update(pruneGrant.token).digest("hex"));

  const allowPrune = new DatabaseSync(databasePath(directory));
  allowPrune.exec("DROP TRIGGER reject_session_insert");
  allowPrune.close();
  const firstSession = yield* auth.login(pruneGrant.token);
  assert.ok(firstSession);
  assert.equal(sessionRows(directory).length, 32);
  assert.equal(sessionRows(directory).some(row => row.token_hash === expiredHash), false);

  const evictionGrant = yield* forge(directory);
  const beforeEvictionFailure = sessionRows(directory);
  const rejectEviction = new DatabaseSync(databasePath(directory));
  rejectEviction.exec(
    "CREATE TRIGGER reject_session_insert BEFORE INSERT ON dashboard_login_sessions " +
    "BEGIN SELECT RAISE(ABORT, 'fixture'); END",
  );
  rejectEviction.close();
  assert.equal(yield* auth.login(evictionGrant.token), null);
  assert.deepEqual(sessionRows(directory), beforeEvictionFailure);
  assert.equal(pendingGrants(directory)[0]?.token_hash, createHash("sha256").update(evictionGrant.token).digest("hex"));

  const allowEviction = new DatabaseSync(databasePath(directory));
  allowEviction.exec("DROP TRIGGER reject_session_insert");
  allowEviction.close();
  const secondSession = yield* auth.login(evictionGrant.token);
  assert.ok(secondSession);
  assert.equal(yield* auth.authenticated(firstSession), true);
  assert.equal(yield* auth.authenticated(secondSession), true);
  assert.equal(sessionRows(directory).length, 32);
  assert.equal(sessionRows(directory).some(row => row.token_hash === expiredHash), false);
  assert.equal(sessionRows(directory).some(row => row.token_hash === oldestLiveHash), false);
  assert.equal(pendingGrants(directory).length, 0);
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

it.effect("logout revokes across open instances and durable sessions keep a global stable cap", () => Effect.gen(function* () {
  const directory = yield* temporary;
  let currentTime = 2_000;
  yield* TestClock.setTime(currentTime);
  const auth = yield* openServiceAuth(directory);
  const concurrent = yield* openServiceAuth(directory);
  const [expiresGrant, revokedGrant] = yield* seedGrants(directory, 2);
  const expires = yield* auth.login(expiresGrant!);
  const revoked = yield* auth.login(revokedGrant!);
  assert.equal(typeof expires, "string");
  assert.equal(typeof revoked, "string");
  if (expires === null || revoked === null) throw new Error("valid dashboard grant was rejected");

  currentTime += 30 * 24 * 60 * 60 * 1_000 - 1;
  yield* TestClock.setTime(currentTime);
  assert.equal(yield* auth.authenticated(expires), true);
  currentTime += 1;
  yield* TestClock.setTime(currentTime);
  assert.equal(yield* auth.authenticated(expires), false);
  assert.equal(yield* concurrent.authenticated(revoked), false);
  yield* concurrent.logout(revoked);
  assert.equal(yield* auth.authenticated(revoked), false);
  yield* auth.logout(undefined);

  currentTime += 1;
  yield* TestClock.setTime(currentTime);
  const sessions: string[] = [];
  const grants = yield* seedGrants(directory, 32);
  for (let index = 0; index < 32; index += 1) {
    const session = yield* (index % 2 === 0 ? auth : concurrent).login(grants[index]!);
    if (session === null) throw new Error("valid dashboard grant was rejected");
    sessions.push(session);
  }
  yield* concurrent.logout(sessions[16]);
  yield* concurrent.logout(sessions[31]);
  const later = yield* seedGrants(directory, 3);
  for (let index = 0; index < 3; index += 1) {
    const session = yield* (index % 2 === 0 ? concurrent : auth).login(later[index]!);
    if (session === null) throw new Error("valid dashboard grant was rejected");
    sessions.push(session);
  }
  assert.equal(yield* auth.authenticated(sessions[0]), false);
  assert.equal(yield* auth.authenticated(sessions[1]), true);
  assert.equal(yield* auth.authenticated(sessions[16]), false);
  assert.equal(yield* auth.authenticated(sessions[31]), false);
  assert.equal(yield* auth.authenticated(sessions[32]), true);
  assert.equal(yield* auth.authenticated(sessions[33]), true);
  assert.equal(yield* auth.authenticated(sessions[34]), true);
  assert.equal(sessionRows(directory).length, 32);
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

it.live("logout by another service instance remains revoked after reopen", () => Effect.gen(function* () {
  const directory = yield* temporary;
  const first = yield* openServiceAuth(directory);
  const second = yield* openServiceAuth(directory);
  const grant = yield* forge(directory);
  const session = yield* first.login(grant.token);
  assert.ok(session);
  yield* Effect.gen(function* () {
    assert.equal(yield* second.authenticated(session), true);
    yield* second.logout(session);
    assert.equal(yield* first.authenticated(session), false);
  }).pipe(Effect.ensuring(Effect.andThen(first.close, second.close)));
  const reopened = yield* openServiceAuth(directory);
  assert.equal(yield* reopened.authenticated(session), false);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("pending dashboard grants are isolated between service state directories", () => Effect.gen(function* () {
  const firstDirectory = yield* temporary;
  const secondDirectory = yield* temporary;
  const first = yield* openServiceAuth(firstDirectory);
  const second = yield* openServiceAuth(secondDirectory);
  const firstGrant = yield* forge(firstDirectory);
  const secondGrant = yield* forge(secondDirectory);
  assert.equal((yield* second.login(firstGrant.token)) === null, true);
  assert.equal((yield* first.login(secondGrant.token)) === null, true);
  const firstSession = yield* first.login(firstGrant.token);
  const secondSession = yield* second.login(secondGrant.token);
  assert.equal(firstSession !== null, true);
  assert.equal(secondSession !== null, true);
  assert.equal(yield* first.authenticated(secondSession ?? undefined), false);
  assert.equal(yield* second.authenticated(firstSession ?? undefined), false);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.effect("grant issuance prunes expired rows and fails closed at the pending-grant limit", () => Effect.gen(function* () {
  const directory = yield* temporary;
  let currentTime = 10_000;
  yield* TestClock.setTime(currentTime);
  const auth = yield* openServiceAuth(directory);
  const expired = yield* forge(directory);
  currentTime = expired.expiresAt;
  yield* TestClock.setTime(currentTime);
  const firstLive = yield* forge(directory);
  assert.equal(pendingGrants(directory).length, 1);
  assert.equal((yield* auth.login(expired.token)) === null, true);

  const grants = [firstLive];
  for (let index = 1; index < 32; index += 1) {
    grants.push(yield* forge(directory));
  }
  assert.equal(pendingGrants(directory).length, 32);
  assert.match(String(yield* Effect.flip(forge(directory))), /capacity reached/u);
  assert.equal(pendingGrants(directory).length, 32);
  assert.equal((yield* auth.login(grants[0]!.token)) !== null, true);
  assert.equal(pendingGrants(directory).length, 31);
  assert.equal((yield* auth.login(grants[1]!.token)) !== null, true);
  assert.equal((yield* forge(directory)).expiresAt, currentTime + 5 * 60 * 1_000);
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

it.live("concurrent service initialization preserves one workflow token and one two-table database", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporary;
  const [first, second] = yield* Effect.all([openServiceAuth(directory), openServiceAuth(directory)], { concurrency: "unbounded" });
  const workflowToken = yield* fs.readFileString(tokenPath(directory));
  assert.equal(isToken(workflowToken), true);
  assert.equal(first.mcpAuthorized(`Bearer ${workflowToken}`), true);
  assert.equal(second.mcpAuthorized(`Bearer ${workflowToken}`), true);
  assert.equal(yield* missing(join(accessPath(directory), "dashboard-token")), "NotFound");
  assert.deepEqual((yield* fs.readDirectory(accessPath(directory))).sort(), ["login.sqlite3", "workflow-mcp-token"]);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("grant forging requires an initialized database and does not bootstrap missing state", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporary;
  yield* Effect.flip(forge(directory));
  assert.equal(yield* missing(accessPath(directory)), "NotFound");

  yield* fs.makeDirectory(accessPath(directory), { mode: 0o700 });
  yield* Effect.flip(forge(directory));
  assert.deepEqual(yield* fs.readDirectory(accessPath(directory)), []);
}).pipe(Effect.provide(NodeFileSystem.layer)));

it.live("valid existing auth files are tightened to private modes", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporary;
  const first = yield* openServiceAuth(directory);
  yield* first.close;
  yield* fs.chmod(databasePath(directory), 0o644);
  yield* fs.chmod(tokenPath(directory), 0o644);
  yield* openServiceAuth(directory);
  assert.equal((yield* fs.lstat(accessPath(directory))).mode & 0o777, 0o700);
  assert.equal((yield* fs.lstat(databasePath(directory))).mode & 0o777, 0o600);
  assert.equal((yield* fs.lstat(tokenPath(directory))).mode & 0o777, 0o600);
}).pipe(Effect.provide(NodeFileSystem.layer)));

describe("malformed, oversized, symlink and non-regular workflow token files fail closed", () => {
  it.live("malformed content", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporary;
    yield* fs.makeDirectory(accessPath(directory), { mode: 0o700 });
    const corrupt = "!".repeat(43);
    yield* fs.writeFileString(tokenPath(directory), corrupt, { mode: 0o600 });
    yield* Effect.flip(openServiceAuth(directory));
    assert.ok(Buffer.from(yield* fs.readFile(tokenPath(directory))).equals(Buffer.from(corrupt)));
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.live("oversized content", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporary;
    yield* fs.makeDirectory(accessPath(directory), { mode: 0o700 });
    const oversized = "A".repeat(44);
    yield* fs.writeFileString(tokenPath(directory), oversized, { mode: 0o600 });
    yield* Effect.flip(openServiceAuth(directory));
    assert.ok(Buffer.from(yield* fs.readFile(tokenPath(directory))).equals(Buffer.from(oversized)));
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.live("symlink", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporary;
    yield* fs.makeDirectory(accessPath(directory), { mode: 0o700 });
    const target = join(directory, "outside-token");
    yield* fs.writeFileString(target, "A".repeat(43), { mode: 0o600 });
    yield* fs.symlink(target, tokenPath(directory));
    yield* Effect.flip(openServiceAuth(directory));
    assert.equal((yield* fs.lstat(tokenPath(directory))).type === "SymbolicLink", true);
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.live("directory in place of token file", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporary;
    yield* fs.makeDirectory(tokenPath(directory), { recursive: true, mode: 0o700 });
    yield* Effect.flip(openServiceAuth(directory));
    assert.equal((yield* fs.lstat(tokenPath(directory))).type === "Directory", true);
  }).pipe(Effect.provide(NodeFileSystem.layer)));
});

describe("malformed, oversized, symlink and non-regular auth databases fail closed", () => {
  it.live("corrupt database remains untouched", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporary;
    yield* fs.makeDirectory(accessPath(directory), { mode: 0o700 });
    const corrupt = Buffer.from("not a sqlite database");
    yield* fs.writeFile(databasePath(directory), corrupt, { mode: 0o600 });
    yield* Effect.flip(openServiceAuth(directory));
    assert.ok(Buffer.from(yield* fs.readFile(databasePath(directory))).equals(corrupt));
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.live("oversized database", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporary;
    yield* fs.makeDirectory(accessPath(directory), { mode: 0o700 });
    const oversized = Buffer.alloc(1_048_577, 0x41);
    yield* fs.writeFile(databasePath(directory), oversized, { mode: 0o600 });
    yield* Effect.flip(openServiceAuth(directory));
    assert.equal(Number((yield* fs.lstat(databasePath(directory))).size), oversized.length);
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.live("symlink", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporary;
    const targetDirectory = join(directory, "target");
    yield* fs.makeDirectory(targetDirectory);
    const targetAuth = yield* openServiceAuth(targetDirectory);
    yield* targetAuth.close;
    const linkDirectory = join(directory, "linked");
    yield* fs.makeDirectory(accessPath(linkDirectory), { recursive: true, mode: 0o700 });
    yield* fs.symlink(databasePath(targetDirectory), databasePath(linkDirectory));
    yield* Effect.flip(openServiceAuth(linkDirectory));
    assert.equal((yield* fs.lstat(databasePath(linkDirectory))).type === "SymbolicLink", true);
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.live("directory in place of database file", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporary;
    yield* fs.makeDirectory(databasePath(directory), { recursive: true, mode: 0o700 });
    yield* Effect.flip(openServiceAuth(directory));
    assert.equal((yield* fs.lstat(databasePath(directory))).type === "Directory", true);
  }).pipe(Effect.provide(NodeFileSystem.layer)));
});

describe("unexpected session table schemas and row caps fail closed", () => {
  it.live("missing current table is not added to an existing database", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporary;
    const auth = yield* openServiceAuth(directory);
    yield* auth.close;
    const database = new DatabaseSync(databasePath(directory));
    database.exec("DROP TABLE dashboard_login_sessions");
    database.close();
    const before = Buffer.from(yield* fs.readFile(databasePath(directory)));
    assert.deepEqual(authDatabaseTables(directory).map(object => object.name), ["dashboard_login_grants"]);
    yield* Effect.flip(openServiceAuth(directory));
    yield* Effect.flip(forge(directory));
    assert.ok(Buffer.from(yield* fs.readFile(databasePath(directory))).equals(before));
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.live("unexpected schema remains untouched", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* temporary;
    const auth = yield* openServiceAuth(directory);
    yield* auth.close;
    const database = new DatabaseSync(databasePath(directory));
    database.exec("ALTER TABLE dashboard_login_sessions ADD COLUMN unexpected TEXT");
    database.close();
    const before = Buffer.from(yield* fs.readFile(databasePath(directory)));
    yield* Effect.flip(openServiceAuth(directory));
    assert.ok(Buffer.from(yield* fs.readFile(databasePath(directory))).equals(before));
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.live("more than 32 persisted sessions fail closed", () => Effect.gen(function* () {
    const directory = yield* temporary;
    const auth = yield* openServiceAuth(directory);
    yield* auth.close;
    const database = new DatabaseSync(databasePath(directory));
    const insert = database.prepare("INSERT INTO dashboard_login_sessions(token_hash,issued_at,expires_at) VALUES(?,?,?)");
    for (let index = 0; index < 33; index += 1) {
      const hash = createHash("sha256").update(`fixture-${index}`).digest("hex");
      insert.run(hash, 1_000 + index, 1_000 + index + 30 * 24 * 60 * 60 * 1_000);
    }
    database.close();
    yield* Effect.flip(openServiceAuth(directory));
    assert.equal(sessionRows(directory).length, 33);
  }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

  it.live("SQLite rejects nonpositive sessions and lifetimes beyond 30 days", () => Effect.gen(function* () {
    const directory = yield* temporary;
    const auth = yield* openServiceAuth(directory);
    yield* auth.close;
    const database = new DatabaseSync(databasePath(directory));
    const hash = createHash("sha256").update("short-lived-session").digest("hex");
    assert.throws(() => database.prepare(
      "INSERT INTO dashboard_login_sessions(token_hash,issued_at,expires_at) VALUES(?,?,?)",
    ).run(hash, 1_000, 1_000 + 30 * 24 * 60 * 60 * 1_000 + 1));
    assert.throws(() => database.prepare(
      "INSERT INTO dashboard_login_sessions(token_hash,issued_at,expires_at) VALUES(?,?,?)",
    ).run(hash, 1_000, 1_000));
    database.close();
    assert.equal(sessionRows(directory).length, 0);
  }).pipe(Effect.provide(NodeFileSystem.layer)));

});

it.live("two concurrent service instances can consume one grant only once", () => Effect.gen(function* () {
  const directory = yield* temporary;
  const owner = yield* openServiceAuth(directory);
  const grant = yield* forge(directory);
  yield* owner.close;

  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const consumers = [
    yield* consumerWorker(directory, grant.token, barrier),
    yield* consumerWorker(directory, grant.token, barrier),
  ];
  let released = false;
  const release = Effect.sync(() => {
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0, 2);
    released = true;
  });
  // runs before the workers are terminated, so a blocked worker is never left waiting on the barrier
  yield* Effect.addFinalizer(() => Effect.suspend(() => released ? Effect.void : release));
  yield* Effect.all(consumers.map(consumer => consumer.ready));
  yield* release;
  const results = yield* Effect.all(consumers.map(consumer => consumer.result));
  assert.equal(results.filter(Boolean).length, 1);
  yield* Effect.all(consumers.map(consumer => consumer.exited));
}).pipe(Effect.provide(NodeFileSystem.layer)));
