import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { NodeServices } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, type Scope } from "effect";
import { SqlClient } from "effect/sql";
import { SqlError } from "effect/sql/SqlError";
import { CatalogDb, catalogDbLayer, DatabaseWorker, type DatabaseWorkerEntry } from "../src/db.js";
import { httpGet, loopTurn } from "./support/g8-process.js";

// the database worker boundary (src/db.ts, src/db-worker-serve.ts) on real worker threads and a real catalog file: the
// main thread keeps serving while a statement waits or runs in the worker; transactions, savepoints and other services
// stay on the caller's fibers; a cancelled statement holds the connection until the worker answers; a worker that exits
// or breaks the protocol poisons its client without replaying anything. faults come from test/support/db-worker-fault.ts

type Fault = "started" | "exit" | "corrupt";

// the production worker with one fault at the statement `sql`; `started` completes once that statement began in the worker
const faultWorker = (sql: string, fault: Fault) => {
  const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const entry: DatabaseWorkerEntry = {
    url: new URL("./support/db-worker-fault.ts", import.meta.url),
    execArgv: ["--import", import.meta.resolve("tsx")],
    workerData: { sql, fault, cell },
  };
  const started = Effect.promise(() => {
    const wait = Atomics.waitAsync(cell, 0, 0);
    return wait.async ? wait.value : Promise.resolve(wait.value);
  });
  return { entry, started };
};

// a catalog client of its own on the directory, for the caller's scope, through the given worker entry
const catalog = (directory: string, entry?: DatabaseWorkerEntry): Effect.Effect<SqlClient.SqlClient, unknown, Scope.Scope | FileSystem.FileSystem> => {
  const build = Effect.map(Layer.build(Layer.fresh(catalogDbLayer(directory))), (context) => Context.get(context, CatalogDb));
  return entry ? Effect.provideService(build, DatabaseWorker, entry) : build;
};

const temporaryDirectory = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-db-worker-" }));

const createTable = (db: SqlClient.SqlClient) => db.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE, b BLOB, n INTEGER)");
const insert = (db: SqlClient.SqlClient, v: string) => db.unsafe(`INSERT INTO t (v) VALUES ('${v}')`);
const values = (db: SqlClient.SqlClient) =>
  db.unsafe<{ readonly v: string }>("SELECT v FROM t ORDER BY id").pipe(Effect.map((rows) => rows.map((row) => row.v)));
// the committed rows as a new client of the file reads them, and that this client can still take the write lock
const committed = (directory: string) => Effect.scoped(Effect.gen(function* () {
  const db = yield* catalog(directory);
  const rows = yield* values(db);
  yield* db.withTransaction(db.unsafe("DELETE FROM t WHERE v = 'probe'"));
  return rows;
}));

// a connection of this thread holding the write lock of the file until released; holding it never blocks this thread
const holdWriteLock = (path: string) => Effect.acquireRelease(Effect.sync(() => {
  const holder = new DatabaseSync(path);
  holder.exec("BEGIN IMMEDIATE");
  return holder;
}), (holder) => Effect.sync(() => {
  if (holder.isTransaction) holder.exec("ROLLBACK");
  holder.close();
})).pipe(Effect.map((holder) => ({ release: Effect.sync(() => holder.exec("ROLLBACK")) })));

// a loopback http server of this thread answering every request at once
const httpServer = Effect.acquireRelease(Effect.callback<ReturnType<typeof createServer>>((resume) => {
  const server = createServer((_request, response) => response.end("ok"));
  server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
}), (server) => Effect.callback<void>((resume) => {
  server.closeAllConnections();
  server.close(() => resume(Effect.void));
})).pipe(Effect.map((server) => {
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/`;
}));

const elapsed = <A, E>(effect: Effect.Effect<A, E>) => Effect.gen(function* () {
  const start = yield* Clock.currentTimeMillis;
  yield* effect;
  return (yield* Clock.currentTimeMillis) - start;
});

// five requests one after another, each with its round-trip time
const probes = (url: string) => Effect.forEach([1, 2, 3, 4, 5], () => elapsed(httpGet(url, 2_000)));

const lost = "The database worker stopped; a statement in flight has an unknown outcome";

const isConnectionLoss = (error: unknown, message: string) =>
  error instanceof SqlError && error.reason._tag === "ConnectionError" && error.reason.message === message;

describe("database worker boundary", () => {
  it.live("a busy wait in the worker leaves this thread serving http; the same wait on a connection of this thread blocks it", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const path = join(directory, "catalog.sqlite3");
      const begin = faultWorker("BEGIN IMMEDIATE", "started");
      const db = yield* catalog(directory, begin.entry);
      yield* createTable(db);
      const url = yield* httpServer;

      const holder = yield* holdWriteLock(path);
      const write = yield* Effect.forkChild(db.withTransaction(insert(db, "waited")));
      // the worker is inside BEGIN IMMEDIATE now, waiting on the holder's lock with its 5000 ms busy timeout
      yield* begin.started;
      const during = yield* probes(url);
      const waitingAfterProbes = write.pollUnsafe() === undefined;
      yield* holder.release;
      yield* Fiber.join(write);

      // the control: the same wait on a connection of this thread, 1000 ms, with one request in flight
      yield* holdWriteLock(path);
      const local = new DatabaseSync(path, { timeout: 1_000 });
      yield* Effect.addFinalizer(() => Effect.sync(() => local.close()));
      const blockedProbe = yield* Effect.forkChild(elapsed(httpGet(url, 5_000)));
      yield* loopTurn;
      const localWait = yield* Effect.sync(() => {
        try {
          local.exec("BEGIN IMMEDIATE");
          return "began";
        } catch {
          return "busy";
        }
      });
      const blocked = yield* Fiber.join(blockedProbe);

      assert.equal(waitingAfterProbes, true, "the write was still waiting for the lock after every probe answered");
      assert.ok(Math.max(...during) < 1_000, `probes during the worker's wait took ${during.join(", ")} ms`);
      assert.deepEqual(yield* values(db), ["waited"]);
      assert.equal(localWait, "busy");
      assert.ok(blocked >= 1_000, `the probe during the wait on this thread took ${blocked} ms`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("a long query in the worker leaves this thread serving http and returns its result", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const query = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000000) SELECT count(*) AS n FROM c";
      const long = faultWorker(query, "started");
      const db = yield* catalog(directory, long.entry);
      const url = yield* httpServer;

      const running = yield* Effect.forkChild(db.unsafe<{ readonly n: number }>(query));
      yield* long.started;
      const during = yield* probes(url);
      const runningAfterProbes = running.pollUnsafe() === undefined;
      const rows = yield* Fiber.join(running);

      assert.equal(runningAfterProbes, true, "the query was still running after every probe answered");
      assert.ok(Math.max(...during) < 1_000, `probes during the query took ${during.join(", ")} ms`);
      assert.deepEqual(rows, [{ n: 10_000_000 }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("savepoints and another service over the same client share the caller's transaction, committing and rolling back with it", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const db = yield* catalog(directory);
      yield* createTable(db);
      // a second service built on the same client, as the stores are
      class Audit extends Context.Service<Audit, { readonly record: (v: string) => Effect.Effect<void, SqlError> }>()("test/Audit") {}
      const audit = Audit.of({ record: (v) => db.withTransaction(insert(db, v)).pipe(Effect.asVoid) });
      const withAudit = <A, E>(effect: Effect.Effect<A, E, Audit>) => Effect.provideService(effect, Audit, audit);

      yield* db.withTransaction(Effect.gen(function* () {
        yield* insert(db, "outer");
        yield* Effect.exit(db.withTransaction(Effect.andThen(insert(db, "savepoint-undone"), Effect.fail("undo"))));
        yield* db.withTransaction(insert(db, "savepoint-kept"));
        yield* Effect.flatMap(Audit, (service) => service.record("audit-kept"));
      })).pipe(withAudit);
      const failed = yield* Effect.exit(db.withTransaction(Effect.gen(function* () {
        yield* insert(db, "outer-undone");
        yield* db.withTransaction(insert(db, "savepoint-undone-with-outer"));
        yield* Effect.flatMap(Audit, (service) => service.record("audit-undone"));
        return yield* Effect.fail("undo");
      })).pipe(withAudit));

      assert.ok(Exit.isFailure(failed));
      assert.deepEqual(yield* values(db), ["outer", "savepoint-kept", "audit-kept"]);
      assert.deepEqual(yield* committed(directory), ["outer", "savepoint-kept", "audit-kept"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("a statement of another fiber never runs inside a transaction: it waits for the commit and then sees all of it", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const db = yield* catalog(directory);
      yield* createTable(db);
      const inside = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const transaction = yield* Effect.forkChild(db.withTransaction(Effect.gen(function* () {
        yield* insert(db, "first");
        yield* Deferred.succeed(inside, undefined);
        yield* Deferred.await(finish);
        yield* insert(db, "second");
      })));
      yield* Deferred.await(inside);
      const reader = yield* Effect.forkChild(values(db));
      yield* loopTurn;
      yield* loopTurn;
      const readerWaited = reader.pollUnsafe() === undefined;
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(transaction);

      assert.equal(readerWaited, true, "the reader waited while the transaction was open");
      assert.deepEqual(yield* Fiber.join(reader), ["first", "second"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("a cancelled statement keeps its connection until the worker answers: the interruption returns once the busy write committed, and a competing write runs after it", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const path = join(directory, "catalog.sqlite3");
      const write = "INSERT INTO t (v) VALUES ('cancelled')";
      const busy = faultWorker(write, "started");
      const db = yield* catalog(directory, busy.entry);
      yield* createTable(db);

      const holder = yield* holdWriteLock(path);
      const cancelled = yield* Effect.forkChild(db.unsafe(write));
      // the autocommit write is in the worker now, waiting on the holder's lock; it cannot be stopped there
      yield* busy.started;
      const interruption = yield* Effect.forkChild(Fiber.interrupt(cancelled));
      const competing = yield* Effect.forkChild(insert(db, "competing"));
      yield* loopTurn;
      yield* loopTurn;
      const heldBeforeAnswer = [cancelled, interruption, competing].map((fiber) => fiber.pollUnsafe() === undefined);
      yield* holder.release;
      yield* Fiber.join(interruption);
      // read through a connection of this thread as soon as the interruption returned
      const atInterruption = yield* Effect.sync(() => {
        const reader = new DatabaseSync(path, { readOnly: true });
        try {
          return reader.prepare("SELECT v FROM t ORDER BY id").all().map((row) => row.v);
        } finally {
          reader.close();
        }
      });
      const cancelledExit = yield* Fiber.await(cancelled);
      yield* Fiber.join(competing);

      assert.deepEqual(heldBeforeAnswer, [true, true, true], "nothing returned while the write waited in the worker");
      assert.deepEqual(atInterruption, ["cancelled"], "the interruption returned only once the write it cancelled had committed");
      assert.ok(Exit.isFailure(cancelledExit) && Cause.hasInterruptsOnly(cancelledExit.cause));
      assert.deepEqual(yield* values(db), ["cancelled", "competing"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("a worker exiting inside a transaction fails the statement as unknown, poisons the client and leaves nothing committed or locked", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* Effect.scoped(Effect.flatMap(catalog(directory), createTable));
      const doomed = "INSERT INTO t (v) VALUES ('doomed')";
      const crash = faultWorker(doomed, "exit");
      const db = yield* catalog(directory, crash.entry);

      const failure = yield* Effect.flip(db.withTransaction(db.unsafe(doomed)));
      const later = yield* Effect.flip(insert(db, "never-sent"));

      assert.ok(isConnectionLoss(failure, lost), `the statement failed as ${inspect(failure)}`);
      assert.ok(isConnectionLoss(later, lost), "a later statement fails with the same fault, unsent");
      assert.deepEqual(yield* committed(directory), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("a worker exiting after COMMIT before it answers leaves the outcome unknown to the caller and the row committed once, never replayed", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* Effect.scoped(Effect.flatMap(catalog(directory), createTable));
      const crash = faultWorker("COMMIT", "exit");
      const db = yield* catalog(directory, crash.entry);

      const failure = yield* Effect.flip(db.withTransaction(insert(db, "committed")));
      const later = yield* Effect.flip(insert(db, "never-sent"));

      assert.ok(isConnectionLoss(failure, lost), `the commit failed as ${inspect(failure)}`);
      assert.ok(isConnectionLoss(later, lost));
      assert.deepEqual(yield* committed(directory), ["committed"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("a malformed reply poisons the client with a fixed error and no later statement reaches the worker", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* Effect.scoped(Effect.flatMap(catalog(directory), createTable));
      const first = "INSERT INTO t (v) VALUES ('first')";
      const corrupt = faultWorker(first, "corrupt");
      const db = yield* catalog(directory, corrupt.entry);

      const failure = yield* Effect.flip(db.unsafe(first));
      const later = yield* Effect.flip(insert(db, "never-sent"));

      const malformed = "The database worker sent a malformed reply";
      assert.ok(isConnectionLoss(failure, malformed), `the statement failed as ${inspect(failure)}`);
      assert.ok(isConnectionLoss(later, malformed));
      // the statement itself ran; the one after the fault was never sent
      assert.deepEqual(yield* committed(directory), ["first"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("closing the client inside an open transaction rolls it back and releases the file", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* Effect.scoped(Effect.gen(function* () {
        const db = yield* catalog(directory);
        yield* createTable(db);
        const inside = yield* Deferred.make<void>();
        yield* Effect.forkScoped(db.withTransaction(Effect.gen(function* () {
          yield* insert(db, "open");
          yield* Deferred.succeed(inside, undefined);
          return yield* Effect.never;
        })));
        yield* Deferred.await(inside);
      }));

      assert.deepEqual(yield* committed(directory), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

  it.live("values cross the boundary unchanged and a failure crosses as its reason and sqlite code only", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const db = yield* catalog(directory);
      yield* createTable(db);
      const bytes = new Uint8Array([0, 1, 127, 128, 255]);
      const big = 9_223_372_036_854_775_807n;
      yield* db`INSERT INTO t (v, b, n) VALUES (${"values"}, ${bytes}, ${big})`;
      const [exact] = yield* db<{ readonly b: Uint8Array; readonly n: bigint }>`SELECT b, n FROM t WHERE v = ${"values"}`.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true));
      const [small] = yield* db<{ readonly n: number }>`SELECT 42 AS n`;

      const secret = "secret-7f3a9c";
      yield* db`INSERT INTO t (v) VALUES (${secret})`;
      const duplicate = yield* Effect.flip(db`INSERT INTO t (v) VALUES (${secret})`);
      const renderings = [String(duplicate), JSON.stringify(duplicate), inspect(duplicate, { depth: Infinity })];

      assert.ok(exact?.b instanceof Uint8Array);
      assert.deepEqual(Array.from(exact.b), Array.from(bytes));
      assert.equal(exact.n, big);
      assert.equal(small?.n, 42);
      assert.equal(duplicate.reason._tag, "UniqueViolation");
      // SQLITE_CONSTRAINT_UNIQUE
      assert.deepEqual(duplicate.reason.cause, { code: "constraint failed", errcode: 2067 });
      for (const rendering of renderings) {
        assert.ok(!rendering.includes(secret), "no rendering carries the value");
        assert.ok(!rendering.includes("INSERT"), "no rendering carries the statement");
        assert.ok(!rendering.includes("UNIQUE constraint failed"), "no rendering carries the native message");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});
