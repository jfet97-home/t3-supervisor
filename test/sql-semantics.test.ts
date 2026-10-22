import assert from "node:assert/strict";
import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, type PlatformError, Queue, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { SqlClient } from "effect/sql";
import { CatalogDb, catalogDbLayer } from "../src/db.js";
import { Store } from "../src/store.js";
import { repositoryRoot, tsxLoader } from "./support/cli-process.js";

// target-regression sql semantics of the catalog client on the real driver (plan 3.2 rules 4, 6 and 7)

const temporaryDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-sql-" });
});

const withCatalogDb = <A, E>(use: (db: SqlClient.SqlClient) => Effect.Effect<A, E>) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  return yield* Effect.gen(function* () {
    return yield* use(yield* CatalogDb);
  }).pipe(Effect.provide(Layer.fresh(catalogDbLayer(directory))));
});

const values = (db: SqlClient.SqlClient, table: string) =>
  db.unsafe<{ readonly v: string }>(`SELECT v FROM ${table} ORDER BY id`).pipe(Effect.map((rows) => rows.map((row) => row.v)));

describe("CatalogDb sql semantics", () => {
  it.live("CT-SQL-01 (catalog): an interrupted waiter returns while the holder still holds the connection, its body never runs and the holder commits unaffected", () =>
    withCatalogDb((db) => Effect.gen(function* () {
      yield* db.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(db.withTransaction(Effect.gen(function* () {
        yield* db.unsafe("INSERT INTO t (v) VALUES ('holder')");
        yield* Deferred.succeed(holding, undefined);
        yield* Deferred.await(release);
      })));
      yield* Deferred.await(holding);

      // started immediately, the waiter runs synchronously up to the connection semaphore and suspends there
      const bodyStarted = yield* Deferred.make<void>();
      const waiter = yield* Effect.forkChild(db.withTransaction(Effect.gen(function* () {
        yield* Deferred.succeed(bodyStarted, undefined);
        yield* db.unsafe("INSERT INTO t (v) VALUES ('waiter')");
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
      const committed = yield* values(db, "t");
      // the interrupted waiter left the connection usable
      yield* db.withTransaction(db.unsafe("INSERT INTO t (v) VALUES ('after')"));

      assert.ok(Exit.isFailure(waiterExit) && Cause.hasInterruptsOnly(waiterExit.cause), "the waiter ended interrupted");
      assert.equal(holderRunning, true, "the holder still held the connection when the waiter returned");
      assert.equal(bodyRan, false, "the waiter's body never ran");
      assert.ok(Exit.isSuccess(holderExit), "the holder committed");
      assert.deepEqual(committed, ["holder"]);
      assert.deepEqual(yield* values(db, "t"), ["holder", "after"]);
    })).pipe(Effect.provide(NodeServices.layer)), { timeout: 10_000 });

  it.live("CT-SQL-02 (catalog): interruption inside a transaction body rolls it back and the connection is reusable", () =>
    withCatalogDb((db) => Effect.gen(function* () {
      yield* db.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      // the body signals after its insert, so the interruption lands inside the transaction, not before it began
      const inserted = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(db.withTransaction(Effect.gen(function* () {
        yield* db.unsafe("INSERT INTO t (v) VALUES ('interrupted')");
        yield* Deferred.succeed(inserted, undefined);
        return yield* Effect.never;
      })));
      yield* Deferred.await(inserted);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      const afterInterrupt = yield* values(db, "t");
      // a following BEGIN IMMEDIATE would fail inside a transaction that was left open
      yield* db.withTransaction(db.unsafe("INSERT INTO t (v) VALUES ('next')"));

      assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.deepEqual(afterInterrupt, []);
      assert.deepEqual(yield* values(db, "t"), ["next"]);
    })).pipe(Effect.provide(NodeServices.layer)), { timeout: 10_000 });

  it.live("CT-SQL-03 (catalog): a failed COMMIT is rolled back before the connection is reused and the next transaction succeeds", () =>
    withCatalogDb((db) => Effect.gen(function* () {
      // a deferred foreign key passes the insert and fails the COMMIT, which leaves the sqlite transaction open
      yield* db.unsafe("CREATE TABLE parent (id INTEGER PRIMARY KEY, v TEXT)");
      yield* db.unsafe("CREATE TABLE child (id INTEGER PRIMARY KEY, v TEXT, parent_id INTEGER NOT NULL REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
      const failure = yield* Effect.flip(db.withTransaction(db.unsafe("INSERT INTO child (v, parent_id) VALUES ('orphan', 42)")));
      // read outside any transaction: an open one would still show the orphan
      const afterFailure = yield* values(db, "child");
      yield* db.withTransaction(Effect.gen(function* () {
        yield* db.unsafe("INSERT INTO parent (id, v) VALUES (1, 'parent')");
        yield* db.unsafe("INSERT INTO child (v, parent_id) VALUES ('child', 1)");
      }));

      assert.equal(failure._tag, "SqlError");
      assert.match(String(failure.reason.cause), /FOREIGN KEY constraint failed/);
      assert.deepEqual(afterFailure, []);
      assert.deepEqual([yield* values(db, "parent"), yield* values(db, "child")], [["parent"], ["child"]]);
    })).pipe(Effect.provide(NodeServices.layer)), { timeout: 10_000 });

  it.live("CT-SQL-04 (catalog): two clients on one file in two processes keep compare-and-set on the revision correct under BEGIN IMMEDIATE", () =>
    Effect.gen(function* () {
      const iterations = 50;
      const threadId = "thread-cas";
      const directory = yield* temporaryDirectory;
      const RevisionRow = Schema.Struct({ revision: Schema.Finite });
      const decodeRevisions = Schema.decodeUnknownEffect(Schema.Array(RevisionRow));
      const Ready = Schema.fromJsonString(Schema.Struct({ step: Schema.Literal("ready"), revision: Schema.Finite }));
      const Stale = Schema.fromJsonString(Schema.Struct({ step: Schema.Literal("stale"), updated: Schema.Finite }));
      const Started = Schema.fromJsonString(Schema.Struct({ step: Schema.Literal("started") }));
      const Done = Schema.fromJsonString(Schema.Struct({ step: Schema.Literal("done"), written: Schema.Array(Schema.Finite), misses: Schema.Finite }));

      yield* Effect.gen(function* () {
        const store = yield* Store;
        const db = yield* CatalogDb;
        // a real catalog shell, written by the store; both processes then compare-and-set its revision column
        yield* store.ingest({ stream: "active", item: { kind: "thread.updated", sequence: 1, thread: {
          id: threadId, title: "Conversation", projectId: null, lineage: { parentThreadId: null, relationshipToParent: null },
        } } });
        const revision = db`SELECT revision FROM threads WHERE id=${threadId}`.pipe(Effect.flatMap(decodeRevisions), Effect.map(([row]) => row?.revision ?? -1));
        const compareAndSet = (expected: number) =>
          db`UPDATE threads SET revision=${expected + 1} WHERE id=${threadId} AND revision=${expected} RETURNING revision`.pipe(Effect.flatMap(decodeRevisions));
        const initial = yield* revision;

        const commands = yield* Queue.unbounded<string, Cause.Done>();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(ChildProcess.make(process.execPath,
          ["--import", tsxLoader, "test/support/sql-semantics-child.ts", directory, String(iterations), threadId], {
            cwd: repositoryRoot,
            stdin: { stream: Stream.fromQueue(commands).pipe(Stream.map((line) => `${line}\n`), Stream.encodeText) },
          }));
        const lines = yield* Queue.unbounded<string, Cause.Done | PlatformError.PlatformError>();
        yield* Effect.forkChild(child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runIntoQueue(lines)));
        const stderr = yield* Effect.forkChild(child.stderr.pipe(Stream.decodeText(), Stream.mkString));
        const next = <S extends Schema.Decoder<unknown>>(schema: S) => Queue.take(lines).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.catchCause((cause) => Fiber.join(stderr).pipe(
            Effect.flatMap((output) => Effect.die(new Error(`the child process stopped: ${output}`, { cause: Cause.squash(cause) }))))));

        // the child read the revision outside a transaction; this process commits past it before the child writes
        const ready = yield* next(Ready);
        const first = yield* db.withTransaction(Effect.flatMap(revision, compareAndSet));
        yield* Queue.offer(commands, "stale");
        const stale = yield* next(Stale);

        // both processes now run read-and-write increments, each under one BEGIN IMMEDIATE; this one starts once the child runs
        yield* Queue.offer(commands, "go");
        yield* next(Started);
        const written: number[] = [];
        let misses = 0;
        for (let index = 0; index < iterations; index += 1) {
          const rows = yield* db.withTransaction(Effect.flatMap(revision, compareAndSet));
          if (rows[0] === undefined) misses += 1;
          else written.push(rows[0].revision);
        }
        const done = yield* next(Done);
        yield* Queue.end(commands);
        const exitCode = yield* child.exitCode;
        const final = yield* revision;

        const all = [...written, ...done.written].sort((left, right) => left - right);
        const expected = Array.from({ length: 2 * iterations }, (_, index) => initial + 2 + index);

        assert.equal(ready.revision, initial);
        assert.deepEqual(first.map((row) => row.revision), [initial + 1]);
        assert.equal(stale.updated, 0, "the stale compare-and-set of the other process is rejected");
        assert.deepEqual([misses, done.misses], [0, 0], "no compare-and-set under BEGIN IMMEDIATE misses");
        assert.deepEqual(all, expected, "every revision is written exactly once, none lost and none duplicated");
        assert.equal(final, initial + 1 + 2 * iterations);
        assert.equal(exitCode, 0);
      }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(Layer.fresh(catalogDbLayer(directory))))));
    }).pipe(Effect.provide(NodeServices.layer)), { timeout: 60_000 });
});
