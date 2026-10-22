import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";
import type { GuidanceRuntime } from "../src/guidance.js";
import { startGuidanceUi } from "../src/guidance-ui.js";
import { createServiceAuth, forgeDashboardToken } from "../src/service-auth.js";
import type { SupervisorConfig } from "../src/types.js";

const withTemporaryDirectory = async <A>(run: (directory: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "t3-service-auth-characterization-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

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

const execute = promisify(execFile);
const command = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));

// the real `auth forge` CLI in its own process; the token is only ever compared, never printed
const forgeInChild = async (directory: string): Promise<string> => {
  const { stdout, stderr } = await execute(process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", loader, command, "auth", "forge"],
    { env: { ...process.env, DATA_DIRECTORY: directory }, cwd: tmpdir(), timeout: 30_000, maxBuffer: 4096 });
  assert.equal(tokenLine.test(stdout), true, `auth forge printed one token line (${stdout.length} bytes)`);
  assert.equal(stderr, "");
  return stdout.trim();
};

// sqlite header bytes 18 and 19 are 1 for rollback-journal databases and 2 for wal
const journalVersions = (bytes: Buffer): [number, number] => [bytes[18]!, bytes[19]!];

it("CT-AUTH-01: opening a valid auth database leaves it byte-identical and creates no wal or journal", { timeout: 60_000 }, async () => {
  await withTemporaryDirectory(async (directory) => {
    (await createServiceAuth(directory)).close();
    const grant = await forgeInChild(directory);
    const listing = (await readdir(accessPath(directory))).sort();
    const bytes = await readFile(databasePath(directory));
    assert.deepEqual(listing, ["login.sqlite3", "workflow-mcp-token"]);
    assert.deepEqual(journalVersions(bytes), [1, 1]);

    const auth = await createServiceAuth(directory);
    try {
      assert.ok((await readFile(databasePath(directory))).equals(bytes), "open does not write");
      assert.deepEqual((await readdir(accessPath(directory))).sort(), listing);
      // reads on the open connection do not write either
      assert.equal(auth.authenticated(randomBytes(32).toString("base64url")), false);
      assert.equal(auth.mcpAuthorized(`Bearer ${randomBytes(32).toString("base64url")}`), false);
      assert.ok((await readFile(databasePath(directory))).equals(bytes), "reads do not write");
      assert.deepEqual((await readdir(accessPath(directory))).sort(), listing);
    } finally {
      auth.close();
    }
    assert.ok((await readFile(databasePath(directory))).equals(bytes), "close does not write");
    assert.deepEqual((await readdir(accessPath(directory))).sort(), listing);
    assert.deepEqual(rows(directory, "PRAGMA journal_mode"), [{ journal_mode: "delete" }]);

    // the untouched file still serves the grant the child process forged
    const reopened = await createServiceAuth(directory);
    try {
      assert.equal(typeof reopened.login(grant), "string");
    } finally {
      reopened.close();
    }
  });
});

it("CT-AUTH-02: an access path that is a symlink to a directory fails closed for service open and forge", { timeout: 10_000 }, async () => {
  await withTemporaryDirectory(async (root) => {
    const target = join(root, "target");
    (await createServiceAuth(target)).close();
    await forgeDashboardToken(target);
    await chmod(accessPath(target), 0o750);
    const targetListing = (await readdir(accessPath(target))).sort();
    const targetBytes = await readFile(databasePath(target));

    const empty = join(root, "empty");
    await mkdir(empty, { mode: 0o755 });
    for (const [name, destination] of [["linked", accessPath(target)], ["linked-empty", empty]] as const) {
      const linked = join(root, name);
      await mkdir(linked);
      await symlink(destination, accessPath(linked), "dir");
      await assert.rejects(createServiceAuth(linked), (error: unknown) => error instanceof Error && error.message === "invalid service auth access directory");
      await assert.rejects(forgeDashboardToken(linked), (error: unknown) => error instanceof Error && error.message === "invalid service auth access directory");
      assert.equal((await lstat(accessPath(linked))).isSymbolicLink(), true);
    }
    // nothing was created, chmodded or written through either link
    assert.deepEqual(await readdir(empty), []);
    assert.equal((await lstat(empty)).mode & 0o777, 0o755);
    assert.equal((await lstat(accessPath(target))).mode & 0o777, 0o750);
    assert.deepEqual((await readdir(accessPath(target))).sort(), targetListing);
    assert.ok((await readFile(databasePath(target))).equals(targetBytes));
  });
});

it("CT-AUTH-03: sessions tolerate a 60 s clock rollback and a grant is rejected exactly at its expiry", { timeout: 10_000 }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const issuedAt = 1_000_000;
    let currentTime = issuedAt;
    const auth = await createServiceAuth(directory, { now: () => currentTime });
    try {
      const grant = await forgeDashboardToken(directory, { now: () => currentTime });
      const session = auth.login(grant.token);
      assert.ok(session);
      for (const [offset, accepted] of [[0, true], [-60_000, true], [-60_001, false], [-59_999, true]] as const) {
        currentTime = issuedAt + offset;
        assert.equal(auth.authenticated(session), accepted, `session at issued_at${offset}`);
      }

      currentTime = issuedAt;
      const expiring = await forgeDashboardToken(directory, { now: () => currentTime });
      const lastMoment = await forgeDashboardToken(directory, { now: () => currentTime });
      assert.equal(expiring.expiresAt, issuedAt + 5 * 60 * 1_000);
      currentTime = expiring.expiresAt;
      assert.equal(auth.login(expiring.token), null);
      // the rejected grant is not consumed; it stays until a later forge prunes it
      assert.deepEqual(rows(directory, "SELECT token_hash FROM dashboard_login_grants ORDER BY token_hash"),
        [sha256(expiring.token), sha256(lastMoment.token)].sort().map((token_hash) => ({ token_hash })));
      currentTime = lastMoment.expiresAt - 1;
      assert.equal(typeof auth.login(lastMoment.token), "string");
    } finally {
      auth.close();
    }
  });
});

it("CT-AUTH-04: service open and forge failures never carry token, session or hash values", { timeout: 10_000 }, async () => {
  await withTemporaryDirectory(async (root) => {
    const secrets: string[] = [];
    const remember = (...values: string[]) => {for (const value of values) secrets.push(value, sha256(value), sha256(value).toUpperCase());};
    const failures: Array<[string, unknown]> = [];
    const failure = async (label: string, attempt: () => Promise<unknown>) => {
      try {
        await attempt();
      } catch (error) {
        failures.push([label, error]);
        return;
      }
      assert.fail(`${label} succeeded`);
    };
    // a valid installation whose secrets are then placed into each failing state
    const seeded = async (name: string) => {
      const directory = join(root, name);
      const auth = await createServiceAuth(directory);
      const grant = await forgeDashboardToken(directory);
      const session = auth.login(grant.token);
      assert.ok(session);
      auth.close();
      const pending = await forgeDashboardToken(directory);
      const workflowToken = await readFile(tokenPath(directory), "utf8");
      remember(workflowToken, grant.token, session, pending.token);
      return { directory, workflowToken, session };
    };
    const edit = (directory: string, sql: string, ...values: Array<string | number>) => {
      const database = new DatabaseSync(databasePath(directory));
      try {database.prepare(sql).run(...values);} finally {database.close();}
    };

    const oversized = await seeded("oversized-token");
    await writeFile(tokenPath(oversized.directory), oversized.workflowToken + "A");
    await failure("token file with the token and one more byte", () => createServiceAuth(oversized.directory));

    const altered = await seeded("altered-token");
    await writeFile(tokenPath(altered.directory), "!" + altered.workflowToken.slice(1));
    await failure("non-canonical token file", () => createServiceAuth(altered.directory));

    const uppercase = await seeded("uppercase-hash");
    edit(uppercase.directory, "UPDATE dashboard_login_sessions SET token_hash=?", sha256(uppercase.session).toUpperCase());
    await failure("session row with an uppercase hash", () => createServiceAuth(uppercase.directory));
    await failure("forge over a session row with an uppercase hash", () => forgeDashboardToken(uppercase.directory));

    // one forged grant plus 31 fixture grants of known tokens fill the 32 pending slots
    const crowded = await seeded("crowded");
    const fixtureTokens = Array.from({ length: 31 }, () => randomBytes(32).toString("base64url"));
    remember(...fixtureTokens);
    const database = new DatabaseSync(databasePath(crowded.directory));
    try {
      database.exec("BEGIN IMMEDIATE");
      const insert = database.prepare("INSERT INTO dashboard_login_grants(token_hash,issued_at,expires_at) VALUES(?,?,?)");
      for (const token of fixtureTokens) insert.run(sha256(token), Date.now(), Date.now() + 5 * 60 * 1_000);
      database.exec("COMMIT");
    } finally {database.close();}
    await failure("forge at grant capacity", () => forgeDashboardToken(crowded.directory));

    const wal = await seeded("wal");
    edit(wal.directory, "PRAGMA journal_mode=WAL");
    await failure("database in wal mode", () => createServiceAuth(wal.directory));
    await failure("forge on a database in wal mode", () => forgeDashboardToken(wal.directory));

    const clock = await seeded("clock");
    await failure("forge with an invalid clock", () => forgeDashboardToken(clock.directory, { now: () => Number.NaN }));
    await failure("forge without an access directory", () => forgeDashboardToken(join(root, "missing")));

    assert.deepEqual(failures.map(([label, error]) => [label, error instanceof Error ? error.message : String(error)]), [
      ["token file with the token and one more byte", "invalid service auth workflow-mcp-token file"],
      ["non-canonical token file", "invalid service auth workflow-mcp-token file"],
      ["session row with an uppercase hash", "invalid service auth database"],
      ["forge over a session row with an uppercase hash", "invalid service auth login grant state"],
      ["forge at grant capacity", "dashboard login grant capacity reached"],
      ["database in wal mode", "invalid service auth database"],
      ["forge on a database in wal mode", "invalid service auth login grant state"],
      ["forge with an invalid clock", "invalid service auth login grant state"],
      ["forge without an access directory", "invalid service auth access directory"],
    ]);
    for (const [label, error] of failures) {
      const rendered = error instanceof Error ? [error.message, String(error), error.stack ?? "", JSON.stringify(error)] : [String(error)];
      const leaked = secrets.filter((secret) => rendered.some((text) => text.includes(secret)));
      assert.equal(leaked.length, 0, `${label} carried ${leaked.length} secret value(s)`);
    }
  });
});

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

it("CT-AUTH-05: concurrent HTTP logins and child-process forges keep one session per grant and the delete-mode schema", { timeout: 60_000 }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const ui = await startGuidanceUi(uiConfig(directory), {} as GuidanceRuntime);
    try {
      const address = ui.server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      const login = async (token: string): Promise<{ status: number; session?: string }> => {
        const response = await fetch(`${origin}/auth/login`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const payload = await response.json() as { session?: unknown };
        return typeof payload.session === "string" ? { status: response.status, session: payload.session } : { status: response.status };
      };
      const schema = () => rows(directory, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
      const schemaBefore = schema();

      // eight concurrent logins on the server's shared connection race for one single-use grant
      const grant = await forgeDashboardToken(directory);
      const raced = await Promise.all(Array.from({ length: 8 }, () => login(grant.token)));
      assert.deepEqual(raced.map((result) => result.status).sort(), [200, 401, 401, 401, 401, 401, 401, 401]);
      const sessions = raced.flatMap((result) => result.session === undefined ? [] : [result.session]);
      assert.equal(sessions.length, 1);

      // four real CLI forges run while the server keeps taking the login write lock with unknown tokens
      let forging = true;
      const contention: number[] = [];
      const contend = Promise.all(Array.from({ length: 3 }, async () => {
        while (forging) contention.push((await login(randomBytes(32).toString("base64url"))).status);
      }));
      const perGrant: Array<Array<{ status: number; session?: string }>> = [];
      const forges = Array.from({ length: 4 }, () => forgeInChild(directory).then(async (token) => {
        // each forged grant is raced twice as soon as its process exits, while the other forges may still run
        const pair = await Promise.all([login(token), login(token)]);
        perGrant.push(pair);
        return token;
      }));
      let tokens: string[];
      try {
        tokens = await Promise.all(forges);
      } finally {
        forging = false;
        await contend;
      }
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
      assert.deepEqual(journalVersions(await readFile(databasePath(directory))), [1, 1]);
      assert.deepEqual((await readdir(accessPath(directory))).sort(), ["login.sqlite3", "workflow-mcp-token"]);
    } finally {
      await ui.close();
    }
  });
});
