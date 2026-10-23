import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, type PlatformError, Queue, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { SqlClient } from "effect/sql";
import { AccessDb, accessDbLayer } from "../src/db.js";
import { forgeDashboardToken, ServiceAuth } from "../src/service-auth.js";
import { repositoryRoot, tsxLoader } from "./support/cli-process.js";
import { privately } from "./support/private-assert.js";

// target-regression sql semantics of the access client on a real login database (plan 3.2 rules 4, 6 and 7; CT-SQL-01..04
// for access/login.sqlite3)

// a login database initialized by the service itself, its service scope already closed
const loginDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-access-sql-" });
  yield* Effect.scoped(Layer.build(ServiceAuth.layer(directory)));
  return { directory, path: join(directory, "access", "login.sqlite3") };
});

const withAccessDb = <A, E>(use: (db: SqlClient.SqlClient) => Effect.Effect<A, E>) => Effect.gen(function* () {
  const { path } = yield* loginDatabase;
  return yield* Effect.gen(function* () {
    return yield* use(yield* AccessDb);
  }).pipe(Effect.provide(Layer.fresh(accessDbLayer(path))));
});

const hash = (index: number): string => index.toString(16).padStart(64, "0");

const grantHashes = (db: SqlClient.SqlClient) =>
  db.unsafe<{ readonly token_hash: string }>("SELECT token_hash FROM dashboard_login_grants ORDER BY token_hash").pipe(
    Effect.map((rows) => rows.map((row) => row.token_hash)));

const insertGrant = (db: SqlClient.SqlClient, index: number) =>
  db.unsafe("INSERT INTO dashboard_login_grants(token_hash,issued_at,expires_at) VALUES(?,?,?)", [hash(index), 1_000, 2_000]);

// CT-SQL-04 (access), two service auth clients in two processes on one login database, holding the write lock through a
// separate connection of this process (the holder) that takes BEGIN IMMEDIATE and keeps it until released. what each
// case proves:
// - race runs, a pre-call lock proof only: when the child's first login reaches its BEGIN IMMEDIATE step, the holder is
//   still inside its transaction over the same grants and a no-wait BEGIN IMMEDIATE from the child's process is refused
//   busy. they do not prove that this step waited, since it may begin after the release. then both clients claim that
//   grant and race over the rest: every grant is consumed exactly once and the child's replay of a grant this process
//   consumed fails
// - lock expiry, the wait itself: the holder stays inside its transaction for the whole of the child's login, whose
//   production BEGIN IMMEDIATE ends SQLITE_BUSY on a connection reading back busy_timeout 5000. a step begun outside any
//   transaction returns that only once its busy handler gives up, so the login failed by its own busy timeout under the
//   native lock of another process; no clock is read. the failed login leaves every grant and session row as it was, at
//   the session cap where a committed login evicts one. after the release the same login consumes the grant once,
//   evicting exactly the oldest session, and its replay fails and changes nothing
const contendedGrants = 30;
const contendedRuns = 10;
const maxSessions = 32;
const sqliteBusy = 5;
// the busy_timeout pragma of the access client (src/db.ts), in milliseconds
const accessBusyTimeout = 5_000;
const Ready = Schema.fromJsonString(Schema.Struct({ step: Schema.Literal("ready") }));
const Waiting = Schema.fromJsonString(Schema.Struct({
  step: Schema.Literal("waiting"), grant: Schema.Finite, probe: Schema.Literals(["busy", "free", "failed"]) }));
const Begun = Schema.fromJsonString(Schema.Struct({
  step: Schema.Literal("begun"), grant: Schema.Finite, ok: Schema.Boolean,
  code: Schema.optionalKey(Schema.Finite), busyTimeout: Schema.optionalKey(Schema.Finite) }));
const Done = Schema.fromJsonString(Schema.Struct({ step: Schema.Literal("done"), won: Schema.Array(Schema.Finite) }));
const Login = Schema.fromJsonString(Schema.Struct({ step: Schema.Literal("login"), session: Schema.Boolean }));

// the child process (test/support/access-sql-child.ts) with its own service auth on the data directory, once ready;
// a stopped child is reported by its stderr size only
const accessChild = (directory: string, mode: "race" | "expiry") => Effect.gen(function* () {
  const commands = yield* Queue.unbounded<string, Cause.Done>();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", tsxLoader, "test/support/access-sql-child.ts", directory, mode], {
      cwd: repositoryRoot,
      stdin: { stream: Stream.fromQueue(commands).pipe(Stream.map((line) => `${line}\n`), Stream.encodeText) },
    }));
  const lines = yield* Queue.unbounded<string, Cause.Done | PlatformError.PlatformError>();
  yield* Effect.forkChild(child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runIntoQueue(lines)));
  const stderr = yield* Effect.forkChild(child.stderr.pipe(Stream.decodeText(), Stream.mkString));
  const next = <S extends Schema.Decoder<unknown>>(schema: S) => Queue.take(lines).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.catchCause(() => Fiber.join(stderr).pipe(
      Effect.flatMap((output) => Effect.die(new Error(`the child process stopped (stderr ${output.length} bytes)`))))));
  yield* next(Ready);
  return {
    send: (line: string) => Queue.offer(commands, line),
    next,
    queued: Queue.size(lines),
    // closing stdin ends the child
    exit: Queue.end(commands).pipe(Effect.andThen(child.exitCode)),
  };
});

// the holder, once inside its transaction; it reports the grants pending there
const holdWriteLock = (path: string) => Effect.gen(function* () {
  const holding = yield* Deferred.make<number>();
  const release = yield* Deferred.make<void>();
  const holder = yield* Effect.forkChild(Effect.gen(function* () {
    const db = yield* AccessDb;
    yield* db.withTransaction(Effect.gen(function* () {
      yield* Deferred.succeed(holding, (yield* grantHashes(db)).length);
      yield* Deferred.await(release);
    }));
  }).pipe(Effect.provide(Layer.fresh(accessDbLayer(path)))));
  const pending = yield* Deferred.await(holding);
  return {
    pending,
    // nothing has completed the release, so the transaction is still open
    held: Effect.sync(() => holder.pollUnsafe() === undefined),
    // whether its transaction then committed
    release: Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.await(holder)), Effect.map(Exit.isSuccess)),
  };
});

// the committed grant hashes and the session hashes in the login's eviction order (issued_at, then rowid)
const authRows = (path: string) => Effect.gen(function* () {
  const db = yield* AccessDb;
  const sessions = yield* db.unsafe<{ readonly token_hash: string }>("SELECT token_hash FROM dashboard_login_sessions ORDER BY issued_at ASC, rowid ASC");
  return { grants: yield* grantHashes(db), sessions: sessions.map((row) => row.token_hash) };
}).pipe(Effect.provide(Layer.fresh(accessDbLayer(path))));

// one race run on a fresh grant set; the holder is released once the child's barrier reports from the BEGIN IMMEDIATE
// step of its first login, the last grant, which this process then claims as well
const contendedRun = Effect.gen(function* () {
  const { directory, path } = yield* loginDatabase;
  const contested = contendedGrants - 1;
  // forged four at a time, each over its own short-lived client, before this process opens its service client
  const tokens = yield* Effect.forEach(Array.from({ length: contendedGrants }), () =>
    Effect.map(forgeDashboardToken(directory), (forged) => Redacted.value(forged.token)), { concurrency: 4 });

  const observed = yield* Effect.gen(function* () {
    const auth = yield* ServiceAuth;
    const child = yield* accessChild(directory, "race");
    for (const token of tokens) yield* child.send(token);
    // the first grant is consumed here before the child starts, so the child's walk always ends on a replay of a grant
    // another process consumed
    const won: number[] = [];
    if ((yield* auth.login(tokens[0]!)) !== null) won.push(0);

    const holder = yield* holdWriteLock(path);
    // the child's barrier line arrives while the holder holds; the child's step behind it cannot return before the release
    yield* child.send("go");
    const waiting = yield* child.next(Waiting);
    const barrier = { ...waiting, pendingWhileHeld: holder.pending, holderHeld: yield* holder.held, linesBeforeRelease: yield* child.queued };

    const holderCommitted = yield* holder.release;
    // the grant the child's first login is for, claimed here as soon as the holder is gone
    if ((yield* auth.login(tokens[contested]!)) !== null) won.push(contested);
    const begun = yield* child.next(Begun);
    // then the rest: this process walks up from the second grant while the child walks down to the first
    for (let index = 1; index < contested; index += 1) if ((yield* auth.login(tokens[index]!)) !== null) won.push(index);
    const done = yield* child.next(Done);
    const exitCode = yield* child.exit;
    return { barrier, holderCommitted, begun, won, childWon: done.won, exitCode };
  }).pipe(Effect.provide(ServiceAuth.layer(directory)));

  const fs = yield* FileSystem.FileSystem;
  const db = yield* Effect.gen(function* () {
    const client = yield* AccessDb;
    return {
      sessions: (yield* client.unsafe<{ readonly count: number }>("SELECT COUNT(*) AS count FROM dashboard_login_sessions"))[0]?.count,
      grants: yield* grantHashes(client),
      journal: (yield* client.unsafe<{ readonly journal_mode: string }>("PRAGMA journal_mode"))[0]?.journal_mode,
      integrity: (yield* client.unsafe<{ readonly integrity_check: string }>("PRAGMA integrity_check"))[0]?.integrity_check,
      mode: (yield* fs.stat(path)).mode & 0o777,
    };
  }).pipe(Effect.provide(Layer.fresh(accessDbLayer(path))));
  return { tokens, observed, db };
});

// the lock expiry run: the session table filled to its cap through this process's service auth, one grant pending,
// then the child's login of that grant under the holder, then its retry and replay after the release
const expiryRun = Effect.gen(function* () {
  const { directory, path } = yield* loginDatabase;
  // forged four at a time, each over its own short-lived client as concurrent cli runs would be, so that the start of
  // each client's database worker does not add up across the whole seeding
  const seeded = yield* Effect.forEach(Array.from({ length: maxSessions }), () =>
    Effect.map(forgeDashboardToken(directory), (forged) => Redacted.value(forged.token)), { concurrency: 4 });
  yield* Effect.gen(function* () {
    const auth = yield* ServiceAuth;
    for (const token of seeded) if ((yield* auth.login(token)) === null) return yield* Effect.die(new Error("a seeding login failed"));
  }).pipe(Effect.provide(ServiceAuth.layer(directory)));
  const token = Redacted.value((yield* forgeDashboardToken(directory)).token);

  const child = yield* accessChild(directory, "expiry");
  yield* child.send(token);
  const holder = yield* holdWriteLock(path);
  const before = yield* authRows(path);
  yield* child.send("login");
  const waiting = yield* child.next(Waiting);
  const begun = yield* child.next(Begun);
  const expired = yield* child.next(Login);
  // read after the child's login answered: the holder was inside its transaction for all of it
  const heldThroughout = yield* holder.held;
  const afterFailure = yield* authRows(path);

  const holderCommitted = yield* holder.release;
  yield* child.send("login");
  const retried = yield* child.next(Login);
  const afterRetry = yield* authRows(path);
  yield* child.send("login");
  const replayed = yield* child.next(Login);
  const afterReplay = yield* authRows(path);
  const exitCode = yield* child.exit;
  return {
    secrets: [...seeded, token], pending: holder.pending, before, waiting, begun, expired: expired.session, heldThroughout, afterFailure,
    holderCommitted, retried: retried.session, afterRetry, replayed: replayed.session, afterReplay, exitCode,
  };
});

describe("AccessDb sql semantics", () => {
  it.live("CT-SQL-01 (access): an interrupted waiter returns while the holder still holds the connection, its body never runs and the holder commits unaffected", () =>
    withAccessDb((db) => Effect.gen(function* () {
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(db.withTransaction(Effect.gen(function* () {
        yield* insertGrant(db, 1);
        yield* Deferred.succeed(holding, undefined);
        yield* Deferred.await(release);
      })));
      yield* Deferred.await(holding);

      // started immediately, the waiter runs synchronously up to the connection semaphore and suspends there
      const bodyStarted = yield* Deferred.make<void>();
      const waiter = yield* Effect.forkChild(db.withTransaction(Effect.gen(function* () {
        yield* Deferred.succeed(bodyStarted, undefined);
        yield* insertGrant(db, 2);
      })), { startImmediately: true });
      assert.equal(waiter.pollUnsafe(), undefined, "the waiter is queued behind the holder");

      // a deadline only: the interruption must not wait for the holder's release
      yield* Fiber.interrupt(waiter).pipe(Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.die(new Error("the interrupted waiter did not return while the holder held the connection")),
      }));
      const waiterExit = yield* Fiber.await(waiter);
      const holderRunning = holder.pollUnsafe() === undefined;
      const bodyRan = yield* Deferred.isDone(bodyStarted);

      yield* Deferred.succeed(release, undefined);
      const holderExit = yield* Fiber.await(holder);
      const committed = yield* grantHashes(db);
      // the interrupted waiter left the connection usable
      yield* db.withTransaction(insertGrant(db, 3));

      assert.ok(Exit.isFailure(waiterExit) && Cause.hasInterruptsOnly(waiterExit.cause), "the waiter ended interrupted");
      assert.equal(holderRunning, true, "the holder still held the connection when the waiter returned");
      assert.equal(bodyRan, false, "the waiter's body never ran");
      assert.ok(Exit.isSuccess(holderExit), "the holder committed");
      assert.deepEqual(committed, [hash(1)]);
      assert.deepEqual(yield* grantHashes(db), [hash(1), hash(3)]);
    })).pipe(Effect.provide(NodeServices.layer)), { timeout: 10_000 });

  it.live("CT-SQL-02 (access): interruption inside a transaction body rolls it back and the connection is reusable", () =>
    withAccessDb((db) => Effect.gen(function* () {
      // the body signals after its insert, so the interruption lands inside the transaction, not before it began
      const inserted = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(db.withTransaction(Effect.gen(function* () {
        yield* insertGrant(db, 1);
        yield* Deferred.succeed(inserted, undefined);
        return yield* Effect.never;
      })));
      yield* Deferred.await(inserted);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      const afterInterrupt = yield* grantHashes(db);
      // a following BEGIN IMMEDIATE would fail inside a transaction that was left open
      yield* db.withTransaction(insertGrant(db, 2));

      assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.deepEqual(afterInterrupt, []);
      assert.deepEqual(yield* grantHashes(db), [hash(2)]);
    })).pipe(Effect.provide(NodeServices.layer)), { timeout: 10_000 });

  it.live("CT-SQL-03 (access): a failed COMMIT is rolled back before the connection is reused and the next transaction succeeds", () =>
    withAccessDb((db) => Effect.gen(function* () {
      // a deferred foreign key passes the insert and fails the COMMIT, which leaves the sqlite transaction open; these
      // fixture tables exist only in this temporary file
      yield* db.unsafe("PRAGMA foreign_keys=ON");
      yield* db.unsafe("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
      yield* db.unsafe("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
      const failure = yield* Effect.flip(db.withTransaction(Effect.gen(function* () {
        yield* insertGrant(db, 1);
        yield* db.unsafe("INSERT INTO child (parent_id) VALUES (42)");
      })));
      // read outside any transaction: an open one would still show the grant
      const afterFailure = yield* grantHashes(db);
      yield* db.withTransaction(insertGrant(db, 2));

      assert.equal(failure._tag, "SqlError");
      // the cause crosses the worker boundary as the sqlite result code only: SQLITE_CONSTRAINT_FOREIGNKEY
      assert.equal(failure.reason._tag, "ConstraintError");
      assert.deepEqual(failure.reason.cause, { code: "constraint failed", errcode: 787 });
      assert.deepEqual(afterFailure, []);
      assert.deepEqual(yield* grantHashes(db), [hash(2)]);
    })).pipe(Effect.provide(NodeServices.layer)), { timeout: 10_000 });


  for (let run = 1; run <= contendedRuns; run += 1) {
    it.live(`CT-SQL-04 (access) race run ${run}/${contendedRuns}: the write lock is held in the other process when the child's login reaches BEGIN IMMEDIATE (pre-call lock proof only), then two service auth clients consume every grant exactly once`, () =>
      Effect.gen(function* () {
        const { tokens, observed, db } = yield* contendedRun;
        const contested = contendedGrants - 1;
        privately(`CT-SQL-04 run ${run}`, tokens, () => {
          // the pre-call lock proof: as the child entered its login's BEGIN IMMEDIATE step, a no-wait BEGIN IMMEDIATE from
          // its process was refused busy and this process's holder was still inside its transaction over the same grants
          assert.deepEqual(observed.barrier, {
            step: "waiting", grant: contested, probe: "busy", pendingWhileHeld: contendedGrants - 1, holderHeld: true, linesBeforeRelease: 0,
          });
          assert.equal(observed.holderCommitted, true);
          // the child's step succeeded; it may have begun after the release, so this proves no wait (the expiry case does)
          assert.deepEqual(observed.begun, { step: "begun", grant: contested, ok: true });
          // the child's login consumes the contested grant unless this process did first, never both
          assert.notEqual(observed.won.includes(contested), observed.childWon.includes(contested), "the contested grant went to exactly one client");

          const all = [...observed.won, ...observed.childWon].sort((left, right) => left - right);
          assert.equal(observed.won[0], 0, "the grant consumed before the race is rejected in the other process");
          assert.deepEqual(all, Array.from({ length: contendedGrants }, (_, index) => index), "every grant is consumed exactly once, none lost and none twice");
          assert.equal(observed.exitCode, 0);
          assert.deepEqual(db, { sessions: contendedGrants, grants: [], journal: "delete", integrity: "ok", mode: 0o600 });
        });
      }).pipe(Effect.provide(NodeServices.layer)), { timeout: 30_000 });
  }

  // bounded by the child's 5 s busy_timeout plus seeding, the child's start and margin
  it.live("CT-SQL-04 (access) lock expiry: a login under BEGIN IMMEDIATE held by another process for the whole wait fails by its own busy_timeout and changes nothing; after the release the grant is consumed once and its replay fails", () =>
    Effect.gen(function* () {
      const observed = yield* expiryRun;
      privately("CT-SQL-04 lock expiry", observed.secrets, () => {
        assert.deepEqual(observed.waiting, { step: "waiting", grant: 0, probe: "busy" });
        // the production client's own BEGIN IMMEDIATE step gave up busy on a connection whose busy handler is the
        // 5000 ms busy_timeout, while the holder stayed inside its transaction; the login failed closed
        assert.deepEqual(observed.begun, { step: "begun", grant: 0, ok: false, code: sqliteBusy, busyTimeout: accessBusyTimeout });
        assert.deepEqual({ expired: observed.expired, heldThroughout: observed.heldThroughout }, { expired: false, heldThroughout: true });
        // nothing changed: the grant still pending, no session added and none evicted from the full table
        assert.equal(observed.pending, 1);
        assert.deepEqual([observed.before.grants.length, observed.before.sessions.length], [1, maxSessions]);
        assert.deepEqual(observed.afterFailure, observed.before);

        // released, the same login consumes the grant once and evicts exactly the oldest session; its replay fails
        assert.equal(observed.holderCommitted, true);
        assert.deepEqual([observed.retried, observed.replayed], [true, false]);
        assert.deepEqual(observed.afterRetry.grants, []);
        assert.equal(observed.afterRetry.sessions.length, maxSessions);
        assert.deepEqual(observed.afterRetry.sessions.slice(0, -1), observed.before.sessions.slice(1));
        assert.equal(observed.before.sessions.includes(observed.afterRetry.sessions.at(-1)!), false, "the retry added one new session");
        assert.deepEqual(observed.afterReplay, observed.afterRetry);
        assert.equal(observed.exitCode, 0);
      });
    }).pipe(Effect.provide(NodeServices.layer)), { timeout: 15_000 });
});
