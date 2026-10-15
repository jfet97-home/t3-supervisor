import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createServiceAuth, forgeDashboardToken, type ServiceAuth } from "../src/service-auth.js";

const withTemporaryDirectory = async <A>(run: (directory: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "t3-service-auth-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

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

const makeConsumerWorker = (directory: string, token: string, barrier: SharedArrayBuffer) => {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      let auth;
      try {
        const { createServiceAuth } = await import(workerData.moduleUrl);
        auth = await createServiceAuth(workerData.directory);
        parentPort.postMessage({ kind: "ready" });
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
        const session = auth.login(workerData.token);
        auth.close();
        parentPort.postMessage({ kind: "result", accepted: session !== null });
      } catch {
        try { auth?.close(); } catch {}
        parentPort.postMessage({ kind: "failure" });
      }
    })();
  `;
  const worker = new Worker(source, {
    eval: true,
    execArgv: ["--import", "tsx"],
    workerData: {
      moduleUrl: new URL("../src/service-auth.ts", import.meta.url).href,
      directory,
      token,
      barrier,
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (accepted: boolean) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<boolean>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()));
  worker.on("message", (message: {kind: string; accepted?: boolean}) => {
    if (message.kind === "ready") resolveReady();
    else if (message.kind === "result") resolveResult(message.accepted === true);
    else {
      const error = new Error("service auth consumer worker failed");
      rejectReady(error);
      rejectResult(error);
    }
  });
  worker.on("error", error => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.on("exit", code => {
    if (code !== 0) {
      const error = new Error("service auth consumer worker exited unexpectedly");
      rejectReady(error);
      rejectResult(error);
    }
  });
  return {worker, ready, result, exited};
};

test("service auth persists a private workflow token and stores only hashed one-time dashboard grants", async () => {
  await withTemporaryDirectory(async (directory) => {
    const now = 12_345;
    const auth = await createServiceAuth(directory, {now: () => now});
    try {
      const access = accessPath(directory);
      const workflowToken = await readFile(tokenPath(directory), "utf8");
      assert.equal(isToken(workflowToken), true);
      assert.equal((await lstat(access)).mode & 0o777, 0o700);
      assert.equal((await lstat(tokenPath(directory))).mode & 0o777, 0o600);
      assert.equal((await lstat(databasePath(directory))).mode & 0o777, 0o600);
      await assert.rejects(lstat(join(access, "dashboard-token")), {code: "ENOENT"});

      const grant = await forgeDashboardToken(directory, {now: () => now});
      assert.equal(isToken(grant.token), true);
      assert.equal(grant.expiresAt, now + 5 * 60 * 1_000);
      assert.equal(grant.token === workflowToken, false);
      const stored = pendingGrants(directory);
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.token_hash === createHash("sha256").update(grant.token).digest("hex"), true);
      assert.equal(stored[0]?.token_hash === grant.token, false);
      assert.equal(stored[0]?.issued_at, now);
      assert.equal(stored[0]?.expires_at, grant.expiresAt);

      const session = auth.login(grant.token);
      assert.equal(typeof session, "string");
      if (session === null) throw new Error("valid dashboard grant was rejected");
      assert.equal(auth.authenticated(session), true);
      assert.equal(auth.login(grant.token) === null, true);
      assert.equal(auth.login(workflowToken) === null, true);
      assert.equal(auth.login(Buffer.alloc(32, 7).toString("base64url")) === null, true);
      assert.equal(auth.login("x".repeat(100_000)) === null, true);
      assert.equal(auth.mcpAuthorized(`Bearer ${workflowToken}`), true);
      assert.equal(auth.mcpAuthorized(`Bearer ${grant.token}`), false);
      assert.equal(auth.mcpAuthorized(`Bearer ${session}`), false);
      assert.equal(auth.authenticated(grant.token), false);
      assert.equal(auth.authenticated(workflowToken), false);
      assert.equal(auth.mcpAuthorized(`bearer ${workflowToken}`), false);
      assert.equal(auth.mcpAuthorized(`Bearer ${workflowToken} `), false);
      assert.equal(auth.mcpAuthorized("Bearer " + "x".repeat(100_000)), false);
      assert.equal(pendingGrants(directory).length, 0);
      auth.close();
      assert.equal(auth.authenticated(session), false);
      assert.equal(auth.mcpAuthorized(`Bearer ${workflowToken}`), false);
    } finally {
      auth.close();
      auth.close();
    }
  });
});

test("unused grants survive restart, consumed grants and sessions do not, and expired grants are pruned", async () => {
  await withTemporaryDirectory(async (directory) => {
    let currentTime = 1_000;
    let auth: ServiceAuth | undefined = await createServiceAuth(directory, {now: () => currentTime});
    try {
      const retained = await forgeDashboardToken(directory, {now: () => currentTime});
      auth.close();
      auth = await createServiceAuth(directory, {now: () => currentTime});
      const session = auth.login(retained.token);
      assert.equal(typeof session, "string");
      if (session === null) throw new Error("unused grant did not survive restart");
      assert.equal(auth.authenticated(session), true);

      auth.close();
      auth = await createServiceAuth(directory, {now: () => currentTime});
      assert.equal(auth.login(retained.token) === null, true);
      assert.equal(auth.authenticated(session), false);

      const expired = await forgeDashboardToken(directory, {now: () => currentTime});
      currentTime = expired.expiresAt;
      assert.equal(auth.login(expired.token) === null, true);
      const fresh = await forgeDashboardToken(directory, {now: () => currentTime});
      assert.equal(fresh.expiresAt, currentTime + 5 * 60 * 1_000);
      assert.equal(pendingGrants(directory).length, 1);
      assert.equal(auth.login(fresh.token) !== null, true);
    } finally {
      auth.close();
    }
  });
});

test("dashboard sessions expire after eight hours, logout revokes, and oldest sessions are evicted", async () => {
  await withTemporaryDirectory(async (directory) => {
    let currentTime = 2_000;
    const auth = await createServiceAuth(directory, {now: () => currentTime});
    try {
      const expiresGrant = await forgeDashboardToken(directory, {now: () => currentTime});
      const revokedGrant = await forgeDashboardToken(directory, {now: () => currentTime});
      const expires = auth.login(expiresGrant.token);
      const revoked = auth.login(revokedGrant.token);
      assert.equal(typeof expires, "string");
      assert.equal(typeof revoked, "string");
      if (expires === null || revoked === null) throw new Error("valid dashboard grant was rejected");

      currentTime += 8 * 60 * 60 * 1_000 - 1;
      assert.equal(auth.authenticated(expires), true);
      currentTime += 1;
      assert.equal(auth.authenticated(expires), false);
      auth.logout(revoked);
      assert.equal(auth.authenticated(revoked), false);
      auth.logout(undefined);

      currentTime += 1;
      const sessions: string[] = [];
      for (let index = 0; index < 33; index += 1) {
        const grant = await forgeDashboardToken(directory, {now: () => currentTime});
        const session = auth.login(grant.token);
        if (session === null) throw new Error("valid dashboard grant was rejected");
        sessions.push(session);
      }
      assert.equal(auth.authenticated(sessions[0]), false);
      assert.equal(auth.authenticated(sessions[1]), true);
      assert.equal(auth.authenticated(sessions[32]), true);
    } finally {
      auth.close();
    }
  });
});

test("pending dashboard grants are isolated between service state directories", async () => {
  await withTemporaryDirectory(async (firstDirectory) => {
    await withTemporaryDirectory(async (secondDirectory) => {
      const first = await createServiceAuth(firstDirectory);
      const second = await createServiceAuth(secondDirectory);
      try {
        const firstGrant = await forgeDashboardToken(firstDirectory);
        const secondGrant = await forgeDashboardToken(secondDirectory);
        assert.equal(second.login(firstGrant.token) === null, true);
        assert.equal(first.login(secondGrant.token) === null, true);
        assert.equal(first.login(firstGrant.token) !== null, true);
        assert.equal(second.login(secondGrant.token) !== null, true);
      } finally {
        first.close();
        second.close();
      }
    });
  });
});

test("legacy static dashboard-token files are not accepted as login grants", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(accessPath(directory), {mode: 0o700});
    const legacyToken = "A".repeat(43);
    await writeFile(join(accessPath(directory), "dashboard-token"), legacyToken, {mode: 0o600});
    const auth = await createServiceAuth(directory);
    try {
      assert.equal(auth.login(legacyToken) === null, true);
      const grant = await forgeDashboardToken(directory);
      assert.equal(auth.login(grant.token) !== null, true);
    } finally {
      auth.close();
    }
  });
});

test("grant issuance prunes expired rows and fails closed at the pending-grant limit", async () => {
  await withTemporaryDirectory(async (directory) => {
    let currentTime = 10_000;
    const auth = await createServiceAuth(directory, {now: () => currentTime});
    try {
      const expired = await forgeDashboardToken(directory, {now: () => currentTime});
      currentTime = expired.expiresAt;
      const firstLive = await forgeDashboardToken(directory, {now: () => currentTime});
      assert.equal(pendingGrants(directory).length, 1);
      assert.equal(auth.login(expired.token) === null, true);

      const grants = [firstLive];
      for (let index = 1; index < 32; index += 1) {
        grants.push(await forgeDashboardToken(directory, {now: () => currentTime}));
      }
      assert.equal(pendingGrants(directory).length, 32);
      await assert.rejects(forgeDashboardToken(directory, {now: () => currentTime}), /capacity reached/u);
      assert.equal(pendingGrants(directory).length, 32);
      assert.equal(auth.login(grants[0]!.token) !== null, true);
      assert.equal(pendingGrants(directory).length, 31);
      assert.equal(auth.login(grants[1]!.token) !== null, true);
      assert.equal((await forgeDashboardToken(directory, {now: () => currentTime})).expiresAt, currentTime + 5 * 60 * 1_000);
    } finally {
      auth.close();
    }
  });
});

test("concurrent service initialization preserves one workflow token and one initialized grant database", async () => {
  await withTemporaryDirectory(async (directory) => {
    const [first, second] = await Promise.all([
      createServiceAuth(directory),
      createServiceAuth(directory),
    ]);
    try {
      const workflowToken = await readFile(tokenPath(directory), "utf8");
      assert.equal(isToken(workflowToken), true);
      assert.equal(first.mcpAuthorized(`Bearer ${workflowToken}`), true);
      assert.equal(second.mcpAuthorized(`Bearer ${workflowToken}`), true);
      await assert.rejects(lstat(join(accessPath(directory), "dashboard-token")), {code: "ENOENT"});
      assert.deepEqual((await readdir(accessPath(directory))).sort(), ["login.sqlite3", "workflow-mcp-token"]);
    } finally {
      first.close();
      second.close();
    }
  });
});

test("grant forging requires an initialized database and does not bootstrap missing state", async () => {
  await withTemporaryDirectory(async (directory) => {
    await assert.rejects(forgeDashboardToken(directory));
    await assert.rejects(lstat(accessPath(directory)), {code: "ENOENT"});

    await mkdir(accessPath(directory), {mode: 0o700});
    await assert.rejects(forgeDashboardToken(directory));
    assert.deepEqual(await readdir(accessPath(directory)), []);
  });
});

test("valid existing auth files are tightened to private modes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = await createServiceAuth(directory);
    first.close();
    await chmod(databasePath(directory), 0o644);
    await chmod(tokenPath(directory), 0o644);
    const second = await createServiceAuth(directory);
    try {
      assert.equal((await lstat(accessPath(directory))).mode & 0o777, 0o700);
      assert.equal((await lstat(databasePath(directory))).mode & 0o777, 0o600);
      assert.equal((await lstat(tokenPath(directory))).mode & 0o777, 0o600);
    } finally {
      second.close();
    }
  });
});

test("malformed, oversized, symlink and non-regular workflow token files fail closed", async (t) => {
  await t.test("malformed content", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(accessPath(directory), {mode: 0o700});
      const corrupt = "!".repeat(43);
      await writeFile(tokenPath(directory), corrupt, {mode: 0o600});
      await assert.rejects(createServiceAuth(directory));
      assert.ok((await readFile(tokenPath(directory))).equals(Buffer.from(corrupt)));
    });
  });

  await t.test("oversized content", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(accessPath(directory), {mode: 0o700});
      const oversized = "A".repeat(44);
      await writeFile(tokenPath(directory), oversized, {mode: 0o600});
      await assert.rejects(createServiceAuth(directory));
      assert.ok((await readFile(tokenPath(directory))).equals(Buffer.from(oversized)));
    });
  });

  await t.test("symlink", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(accessPath(directory), {mode: 0o700});
      const target = join(directory, "outside-token");
      await writeFile(target, "A".repeat(43), {mode: 0o600});
      await symlink(target, tokenPath(directory));
      await assert.rejects(createServiceAuth(directory));
      assert.equal((await lstat(tokenPath(directory))).isSymbolicLink(), true);
    });
  });

  await t.test("directory in place of token file", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(tokenPath(directory), {recursive: true, mode: 0o700});
      await assert.rejects(createServiceAuth(directory));
      assert.equal((await lstat(tokenPath(directory))).isDirectory(), true);
    });
  });
});

test("malformed, oversized, symlink and non-regular login databases fail closed", async (t) => {
  await t.test("corrupt database remains untouched", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(accessPath(directory), {mode: 0o700});
      const corrupt = Buffer.from("not a sqlite database");
      await writeFile(databasePath(directory), corrupt, {mode: 0o600});
      await assert.rejects(createServiceAuth(directory));
      assert.ok((await readFile(databasePath(directory))).equals(corrupt));
    });
  });

  await t.test("oversized database", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(accessPath(directory), {mode: 0o700});
      const oversized = Buffer.alloc(1_048_577, 0x41);
      await writeFile(databasePath(directory), oversized, {mode: 0o600});
      await assert.rejects(createServiceAuth(directory));
      assert.equal((await lstat(databasePath(directory))).size, oversized.length);
    });
  });

  await t.test("symlink", async () => {
    await withTemporaryDirectory(async (directory) => {
      const targetDirectory = join(directory, "target");
      await mkdir(targetDirectory);
      const targetAuth = await createServiceAuth(targetDirectory);
      targetAuth.close();
      const linkDirectory = join(directory, "linked");
      await mkdir(accessPath(linkDirectory), {recursive: true, mode: 0o700});
      await symlink(databasePath(targetDirectory), databasePath(linkDirectory));
      await assert.rejects(createServiceAuth(linkDirectory));
      assert.equal((await lstat(databasePath(linkDirectory))).isSymbolicLink(), true);
    });
  });

  await t.test("directory in place of database file", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(databasePath(directory), {recursive: true, mode: 0o700});
      await assert.rejects(createServiceAuth(directory));
      assert.equal((await lstat(databasePath(directory))).isDirectory(), true);
    });
  });
});

test("two concurrent service instances can consume one grant only once", async () => {
  await withTemporaryDirectory(async (directory) => {
    const owner = await createServiceAuth(directory);
    const grant = await forgeDashboardToken(directory);
    owner.close();

    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const consumers = [
      makeConsumerWorker(directory, grant.token, barrier),
      makeConsumerWorker(directory, grant.token, barrier),
    ];
    let released = false;
    try {
      await Promise.all(consumers.map(consumer => consumer.ready));
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      released = true;
      const results = await Promise.all(consumers.map(consumer => consumer.result));
      assert.equal(results.filter(Boolean).length, 1);
      await Promise.all(consumers.map(consumer => consumer.exited));
    } finally {
      if (!released) {
        Atomics.store(new Int32Array(barrier), 0, 1);
        Atomics.notify(new Int32Array(barrier), 0, 2);
      }
      await Promise.all(consumers.map(consumer => consumer.worker.terminate()));
    }
  });
});
