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
      assert.match(String(failure.reason.cause), /FOREIGN KEY constraint failed/);
      assert.deepEqual(afterFailure, []);
      assert.deepEqual(yield* grantHashes(db), [hash(2)]);
    })).pipe(Effect.provide(NodeServices.layer)), { timeout: 10_000 });

  it.live("CT-SQL-04 (access): two service auth clients in two processes consume every grant exactly once under BEGIN IMMEDIATE", () =>
    Effect.gen(function* () {
      const grants = 30;
      const { directory, path } = yield* loginDatabase;
      // forged one after another, each over its own short-lived client, before this process opens its service client
      const tokens: string[] = [];
      for (let index = 0; index < grants; index += 1) tokens.push(Redacted.value((yield* forgeDashboardToken(directory)).token));
      const Ready = Schema.fromJsonString(Schema.Struct({ step: Schema.Literal("ready") }));
      const Started = Schema.fromJsonString(Schema.Struct({ step: Schema.Literal("started") }));
      const Done = Schema.fromJsonString(Schema.Struct({ step: Schema.Literal("done"), won: Schema.Array(Schema.Finite) }));

      const observed = yield* Effect.gen(function* () {
        const auth = yield* ServiceAuth;
        const commands = yield* Queue.unbounded<string, Cause.Done>();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(ChildProcess.make(process.execPath,
          ["--disable-warning=ExperimentalWarning", "--import", tsxLoader, "test/support/access-sql-child.ts", directory], {
            cwd: repositoryRoot,
            stdin: { stream: Stream.fromQueue(commands).pipe(Stream.map((line) => `${line}\n`), Stream.encodeText) },
          }));
        const lines = yield* Queue.unbounded<string, Cause.Done | PlatformError.PlatformError>();
        yield* Effect.forkChild(child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runIntoQueue(lines)));
        const stderr = yield* Effect.forkChild(child.stderr.pipe(Stream.decodeText(), Stream.mkString));
        // a stopped child is reported by its stderr size only
        const next = <S extends Schema.Decoder<unknown>>(schema: S) => Queue.take(lines).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.catchCause(() => Fiber.join(stderr).pipe(
            Effect.flatMap((output) => Effect.die(new Error(`the child process stopped (stderr ${output.length} bytes)`))))));

        yield* next(Ready);
        for (const token of tokens) yield* Queue.offer(commands, token);
        // the first grant is consumed here before the child starts, so the child's walk always ends on a replay of a grant
        // another process consumed; from the go line the child walks the grants from the last one while this process walks
        // the rest from the first, each login under one BEGIN IMMEDIATE
        const won: number[] = [];
        if ((yield* auth.login(tokens[0]!)) !== null) won.push(0);
        yield* Queue.offer(commands, "go");
        for (const [index, token] of tokens.entries()) if (index > 0 && (yield* auth.login(token)) !== null) won.push(index);
        yield* next(Started);
        const done = yield* next(Done);
        yield* Queue.end(commands);
        const exitCode = yield* child.exitCode;
        return { won, childWon: done.won, exitCode };
      }).pipe(Effect.provide(ServiceAuth.layer(directory)));

      const db = yield* Effect.gen(function* () {
        const client = yield* AccessDb;
        return {
          sessions: (yield* client.unsafe<{ readonly count: number }>("SELECT COUNT(*) AS count FROM dashboard_login_sessions"))[0]?.count,
          grants: yield* grantHashes(client),
          journal: (yield* client.unsafe<{ readonly journal_mode: string }>("PRAGMA journal_mode"))[0]?.journal_mode,
          integrity: (yield* client.unsafe<{ readonly integrity_check: string }>("PRAGMA integrity_check"))[0]?.integrity_check,
        };
      }).pipe(Effect.provide(Layer.fresh(accessDbLayer(path))));

      const all = [...observed.won, ...observed.childWon].sort((left, right) => left - right);
      assert.equal(observed.won[0], 0, "the grant consumed before the race is rejected in the other process");
      assert.deepEqual(all, Array.from({ length: grants }, (_, index) => index), "every grant is consumed exactly once, none lost and none twice");
      assert.equal(observed.exitCode, 0);
      assert.deepEqual(db, { sessions: grants, grants: [], journal: "delete", integrity: "ok" });
    }).pipe(Effect.provide(NodeServices.layer)), { timeout: 60_000 });
});
