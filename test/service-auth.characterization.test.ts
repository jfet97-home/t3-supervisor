import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Fiber, FileSystem, Layer } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import type { GuidanceRuntime } from "../src/guidance.js";
import { tsxLoader } from "./support/cli-process.js";
import { forge, openServiceAuth, temporaryDirectory } from "./support/g8-auth.js";
import { runProcess } from "./support/g8-process.js";
import { guidanceUi } from "./support/service-auth-harness.js";
import { childFailure, privately } from "./support/private-assert.js";
import type { SupervisorConfig } from "../src/types.js";

// the Effect service auth on real files: CT-AUTH-03 sets the service clock and runs under TestClock (it.effect); the
// others run live (it.live) for the real auth files, the `auth forge` child processes and the dashboard's loopback HTTP
// server. the auth database is observed and edited through node:sqlite, independent of the service's own client

const temporary = temporaryDirectory("t3-service-auth-characterization-");

const accessPath = (directory: string): string => join(directory, "access");
const tokenPath = (directory: string): string => join(accessPath(directory), "workflow-mcp-token");
const databasePath = (directory: string): string => join(accessPath(directory), "login.sqlite3");
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const tokenLine = /^[A-Za-z0-9_-]{43}\n$/u;

// node:sqlite rows have a null prototype; strict deep equality compares plain copies
const rows = (directory: string, query: string): Array<Record<string, unknown>> => {
  const database = new DatabaseSync(databasePath(directory));
  try {
    return database.prepare(query).all().map((row) => ({ ...row }));
  } finally {
    database.close();
  }
};

const command = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// the real `auth forge` CLI in its own process; the token is only ever compared, never printed
const forgeInChild = (directory: string) => Effect.gen(function* () {
  const result = yield* runProcess(process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", tsxLoader, command, "auth", "forge"],
    { env: { ...process.env, DATA_DIRECTORY: directory }, cwd: tmpdir(), timeoutMs: 30_000 });
  if (result.code !== 0) return yield* Effect.die(childFailure("auth forge child", result));
  const { stdout, stderr } = result;
  assert.equal(tokenLine.test(stdout), true, `auth forge printed one token line (${stdout.length} bytes)`);
  privately("auth forge stderr", [stdout.trim()], () => assert.equal(stderr, ""));
  return stdout.trim();
});

// sqlite header bytes 18 and 19 are 1 for rollback-journal databases and 2 for wal
const journalVersions = (bytes: Uint8Array): [number, number] => [bytes[18]!, bytes[19]!];

it.live("CT-AUTH-01: opening a valid auth database leaves it byte-identical and creates no wal or journal", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporary;
  yield* (yield* openServiceAuth(directory)).close;
  const grant = yield* forgeInChild(directory);
  const listing = (yield* fs.readDirectory(accessPath(directory))).sort();
  const bytes = Buffer.from(yield* fs.readFile(databasePath(directory)));
  assert.deepEqual(listing, ["login.sqlite3", "workflow-mcp-token"]);
  assert.deepEqual(journalVersions(bytes), [1, 1]);

  const auth = yield* openServiceAuth(directory);
  yield* Effect.gen(function* () {
    assert.ok(Buffer.from(yield* fs.readFile(databasePath(directory))).equals(bytes), "open does not write");
    assert.deepEqual((yield* fs.readDirectory(accessPath(directory))).sort(), listing);
    // reads on the open connection do not write either
    assert.equal(yield* auth.authenticated(randomBytes(32).toString("base64url")), false);
    assert.equal(auth.mcpAuthorized(`Bearer ${randomBytes(32).toString("base64url")}`), false);
    assert.ok(Buffer.from(yield* fs.readFile(databasePath(directory))).equals(bytes), "reads do not write");
    assert.deepEqual((yield* fs.readDirectory(accessPath(directory))).sort(), listing);
  }).pipe(Effect.ensuring(auth.close));
  assert.ok(Buffer.from(yield* fs.readFile(databasePath(directory))).equals(bytes), "close does not write");
  assert.deepEqual((yield* fs.readDirectory(accessPath(directory))).sort(), listing);
  assert.deepEqual(rows(directory, "PRAGMA journal_mode"), [{ journal_mode: "delete" }]);

  // the untouched file still serves the grant the child process forged
  const reopened = yield* openServiceAuth(directory);
  assert.equal(typeof (yield* reopened.login(grant)), "string");
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

it.live("CT-AUTH-02: an access path that is a symlink to a directory fails closed for service open and forge", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* temporary;
  const target = join(root, "target");
  yield* (yield* openServiceAuth(target)).close;
  yield* forge(target);
  yield* fs.chmod(accessPath(target), 0o750);
  const targetListing = (yield* fs.readDirectory(accessPath(target))).sort();
  const targetBytes = Buffer.from(yield* fs.readFile(databasePath(target)));

  const empty = join(root, "empty");
  yield* fs.makeDirectory(empty, { mode: 0o755 });
  for (const [name, destination] of [["linked", accessPath(target)], ["linked-empty", empty]] as const) {
    const linked = join(root, name);
    yield* fs.makeDirectory(linked);
    yield* fs.symlink(destination, accessPath(linked));
    const opened = yield* Effect.flip(openServiceAuth(linked));
    assert.ok(opened instanceof Error && opened.message === "invalid service auth access directory");
    const forged = yield* Effect.flip(forge(linked));
    assert.ok(forged instanceof Error && forged.message === "invalid service auth access directory");
    assert.equal((yield* fs.lstat(accessPath(linked))).type === "SymbolicLink", true);
  }
  // nothing was created, chmodded or written through either link
  assert.deepEqual(yield* fs.readDirectory(empty), []);
  assert.equal((yield* fs.lstat(empty)).mode & 0o777, 0o755);
  assert.equal((yield* fs.lstat(accessPath(target))).mode & 0o777, 0o750);
  assert.deepEqual((yield* fs.readDirectory(accessPath(target))).sort(), targetListing);
  assert.ok(Buffer.from(yield* fs.readFile(databasePath(target))).equals(targetBytes));
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });

it.effect("CT-AUTH-03: sessions tolerate a 60 s clock rollback and a grant is rejected exactly at its expiry", () => Effect.gen(function* () {
  const directory = yield* temporary;
  const issuedAt = 1_000_000;
  yield* TestClock.setTime(issuedAt);
  const auth = yield* openServiceAuth(directory);
  const grant = yield* forge(directory);
  const session = yield* auth.login(grant.token);
  assert.ok(session);
  for (const [offset, accepted] of [[0, true], [-60_000, true], [-60_001, false], [-59_999, true]] as const) {
    yield* TestClock.setTime(issuedAt + offset);
    assert.equal(yield* auth.authenticated(session), accepted, `session at issued_at${offset}`);
  }

  yield* TestClock.setTime(issuedAt);
  const expiring = yield* forge(directory);
  const lastMoment = yield* forge(directory);
  assert.equal(expiring.expiresAt, issuedAt + 5 * 60 * 1_000);
  yield* TestClock.setTime(expiring.expiresAt);
  assert.equal(yield* auth.login(expiring.token), null);
  // the rejected grant is not consumed; it stays until a later forge prunes it
  assert.deepEqual(rows(directory, "SELECT token_hash FROM dashboard_login_grants ORDER BY token_hash"),
    [sha256(expiring.token), sha256(lastMoment.token)].sort().map((token_hash) => ({ token_hash })));
  yield* TestClock.setTime(lastMoment.expiresAt - 1);
  assert.equal(typeof (yield* auth.login(lastMoment.token)), "string");
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });

it.live("CT-AUTH-04: service open and forge failures never carry token, session or hash values", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* temporary;
  const secrets: string[] = [];
  const remember = (...values: string[]) => {for (const value of values) secrets.push(value, sha256(value), sha256(value).toUpperCase());};
  const failures: Array<[string, unknown]> = [];
  const failure = <R>(label: string, attempt: Effect.Effect<unknown, unknown, R>) => Effect.match(attempt, {
    onFailure: (error) => {failures.push([label, error]);},
    onSuccess: () => assert.fail(`${label} succeeded`),
  });
  // a valid installation whose secrets are then placed into each failing state
  const seeded = (name: string) => Effect.gen(function* () {
    const directory = join(root, name);
    const auth = yield* openServiceAuth(directory);
    const grant = yield* forge(directory);
    const session = yield* auth.login(grant.token);
    assert.ok(session);
    yield* auth.close;
    const pending = yield* forge(directory);
    const workflowToken = yield* fs.readFileString(tokenPath(directory));
    remember(workflowToken, grant.token, session, pending.token);
    return { directory, workflowToken, session };
  });
  const edit = (directory: string, sql: string, ...values: Array<string | number>) => {
    const database = new DatabaseSync(databasePath(directory));
    try {database.prepare(sql).run(...values);} finally {database.close();}
  };

  const oversized = yield* seeded("oversized-token");
  yield* fs.writeFileString(tokenPath(oversized.directory), oversized.workflowToken + "A");
  yield* failure("token file with the token and one more byte", openServiceAuth(oversized.directory));

  const altered = yield* seeded("altered-token");
  yield* fs.writeFileString(tokenPath(altered.directory), "!" + altered.workflowToken.slice(1));
  yield* failure("non-canonical token file", openServiceAuth(altered.directory));

  const uppercase = yield* seeded("uppercase-hash");
  edit(uppercase.directory, "UPDATE dashboard_login_sessions SET token_hash=?", sha256(uppercase.session).toUpperCase());
  yield* failure("session row with an uppercase hash", openServiceAuth(uppercase.directory));
  yield* failure("forge over a session row with an uppercase hash", forge(uppercase.directory));

  // one forged grant plus 31 fixture grants of known tokens fill the 32 pending slots
  const crowded = yield* seeded("crowded");
  const fixtureTokens = Array.from({ length: 31 }, () => randomBytes(32).toString("base64url"));
  remember(...fixtureTokens);
  const now = yield* Clock.currentTimeMillis;
  const database = new DatabaseSync(databasePath(crowded.directory));
  try {
    database.exec("BEGIN IMMEDIATE");
    const insert = database.prepare("INSERT INTO dashboard_login_grants(token_hash,issued_at,expires_at) VALUES(?,?,?)");
    for (const token of fixtureTokens) insert.run(sha256(token), now, now + 5 * 60 * 1_000);
    database.exec("COMMIT");
  } finally {database.close();}
  yield* failure("forge at grant capacity", forge(crowded.directory));

  const wal = yield* seeded("wal");
  edit(wal.directory, "PRAGMA journal_mode=WAL");
  yield* failure("database in wal mode", openServiceAuth(wal.directory));
  yield* failure("forge on a database in wal mode", forge(wal.directory));

  const clock = yield* seeded("clock");
  // a wall clock that reads NaN, from a TestClock of this attempt only
  yield* failure("forge with an invalid clock", TestClock.setTime(Number.NaN).pipe(Effect.andThen(forge(clock.directory)),
    Effect.provide(TestClock.layer())));
  yield* failure("forge without an access directory", forge(join(root, "missing")));

  privately("failure messages", secrets, () => assert.deepEqual(failures.map(([label, error]) => [label, error instanceof Error ? error.message : String(error)]), [
    ["token file with the token and one more byte", "invalid service auth workflow-mcp-token file"],
    ["non-canonical token file", "invalid service auth workflow-mcp-token file"],
    ["session row with an uppercase hash", "invalid service auth database"],
    ["forge over a session row with an uppercase hash", "invalid service auth login grant state"],
    ["forge at grant capacity", "dashboard login grant capacity reached"],
    ["database in wal mode", "invalid service auth database"],
    ["forge on a database in wal mode", "invalid service auth login grant state"],
    ["forge with an invalid clock", "invalid service auth login grant state"],
    ["forge without an access directory", "invalid service auth access directory"],
  ]));
  for (const [label, error] of failures) {
    const rendered = error instanceof Error ? [error.message, String(error), error.stack ?? "", JSON.stringify(error)] : [String(error)];
    const leaked = secrets.filter((secret) => rendered.some((text) => text.includes(secret)));
    assert.equal(leaked.length, 0, `${label} carried ${leaked.length} secret value(s)`);
  }
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });

const uiConfig = (directory: string): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://127.0.0.1:3773",
  t3TokenFile: "unused",
  excludedThreadIds: [],
  healthPort: 0,
  uiPort: 0,
  uiHost: "127.0.0.1",
  uiAssetsDirectory: directory,
  supervisorOwnedThreadIds: new Set(),
});

it.live("CT-AUTH-05: concurrent HTTP logins and child-process forges keep one session per grant and the delete-mode schema", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* temporary;
  // the dashboard server closes with the test's scope
  const ui = yield* guidanceUi(uiConfig(directory), {} as GuidanceRuntime["Service"]);
  const origin = `http://127.0.0.1:${ui.port}`;
  const client = yield* HttpClient.HttpClient;
  const login = (token: string) => Effect.gen(function* () {
    const response = yield* client.post(`${origin}/auth/login`, {
      headers: { Origin: origin },
      body: HttpBody.text(JSON.stringify({ token }), "application/json"),
    });
    const payload = (yield* response.json) as { session?: unknown };
    return typeof payload.session === "string" ? { status: response.status, session: payload.session } : { status: response.status };
  }).pipe(Effect.orDie);
  const schema = () => rows(directory, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
  const schemaBefore = schema();

  // eight concurrent logins on the server's shared connection race for one single-use grant
  const grant = yield* forge(directory);
  const raced = yield* Effect.all(Array.from({ length: 8 }, () => login(grant.token)), { concurrency: "unbounded" });
  assert.deepEqual(raced.map((result) => result.status).sort(), [200, 401, 401, 401, 401, 401, 401, 401]);
  const sessions = raced.flatMap((result) => result.session === undefined ? [] : [result.session]);
  assert.equal(sessions.length, 1);

  // four real CLI forges run while the server keeps taking the login write lock with unknown tokens
  let forging = true;
  const contention: number[] = [];
  const contendOnce: Effect.Effect<void> = Effect.suspend(() => forging
    ? Effect.flatMap(login(randomBytes(32).toString("base64url")), (result) => {
      contention.push(result.status);
      return contendOnce;
    })
    : Effect.void);
  const contend = yield* Effect.forkChild(Effect.all(Array.from({ length: 3 }, () => contendOnce), { concurrency: "unbounded" }));
  const perGrant: Array<Array<{ status: number; session?: string }>> = [];
  const forges = Array.from({ length: 4 }, () => forgeInChild(directory).pipe(Effect.tap((token) =>
    // each forged grant is raced twice as soon as its process exits, while the other forges may still run
    Effect.map(Effect.all([login(token), login(token)], { concurrency: "unbounded" }), (pair) => {perGrant.push(pair);}))));
  const tokens = yield* Effect.all(forges, { concurrency: "unbounded" }).pipe(Effect.ensuring(Effect.suspend(() => {
    forging = false;
    return Fiber.join(contend);
  })));
  assert.equal(new Set(tokens).size, 4);
  assert.ok(contention.length > 0);
  assert.deepEqual([...new Set(contention)], [401], "contending logins are rejected, never failed");
  for (const pair of perGrant) {
    assert.deepEqual(pair.map((result) => result.status).sort(), [200, 401]);
    sessions.push(...pair.flatMap((result) => result.session === undefined ? [] : [result.session]));
  }
  assert.equal(new Set(sessions).size, 5);

  const stored = rows(directory, "SELECT token_hash FROM dashboard_login_sessions ORDER BY token_hash");
  assert.deepEqual(stored, sessions.map(sha256).sort().map((token_hash) => ({ token_hash })));
  assert.deepEqual(rows(directory, "SELECT COUNT(*) AS count FROM dashboard_login_grants"), [{ count: 0 }]);
  assert.deepEqual(rows(directory, "PRAGMA journal_mode"), [{ journal_mode: "delete" }]);
  assert.deepEqual(rows(directory, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
  assert.deepEqual(schema(), schemaBefore);
  assert.deepEqual(schemaBefore.map((object) => [object.type, object.name]), [
    ["index", "sqlite_autoindex_dashboard_login_grants_1"],
    ["index", "sqlite_autoindex_dashboard_login_sessions_1"],
    ["table", "dashboard_login_grants"],
    ["table", "dashboard_login_sessions"],
  ]);
  assert.deepEqual(journalVersions(yield* fs.readFile(databasePath(directory))), [1, 1]);
  assert.deepEqual((yield* fs.readDirectory(accessPath(directory))).sort(), ["login.sqlite3", "workflow-mcp-token"]);
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer))), { timeout: 60_000 });
