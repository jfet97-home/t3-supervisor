import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker as WorkerThread } from "node:worker_threads";
import { NodeWorker } from "@effect/platform-node";
import { Context, Data, Deferred, Effect, Exit, FileSystem, Layer, type PlatformError as Platform, Schema, type Scope, Semaphore, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, Statement } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";
import * as Worker from "effect/workers/Worker";
import { connectionLost, sqlErrorOf, type StatementOperation, type WorkerDatabaseConfig, WorkerReply, type WorkerRequest } from "./db-worker-protocol.js";

type PlatformError = Platform.PlatformError;

// one client per database file, each behind its own named service, so a generic SqlClient never shadows another
// file's client; only this module opens SQLite clients (lint rule), and each client's connection runs in its own worker
// thread (src/db-worker-serve.ts), so synchronous statements and busy waits never block the main event loop

/** catalog.sqlite3, process lifetime (S3). */
export class CatalogDb extends Context.Service<CatalogDb, SqlClient.SqlClient>()("t3-supervisor/CatalogDb") {}
/** guidance.sqlite3, one client per supervision run; activated with the S6d engine switch only. */
export class GuidanceDb extends Context.Service<GuidanceDb, SqlClient.SqlClient>()("t3-supervisor/GuidanceDb") {}
/** thread-settings.sqlite3, process lifetime; activated with the S6d engine switch only. */
export class PolicyDb extends Context.Service<PolicyDb, SqlClient.SqlClient>()("t3-supervisor/PolicyDb") {}
/** access/login.sqlite3, dashboard server lifetime or one forge operation; activated in S6c only. */
export class AccessDb extends Context.Service<AccessDb, SqlClient.SqlClient>()("t3-supervisor/AccessDb") {}

export class DatabaseOpenError extends Data.TaggedError("DatabaseOpenError")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

const maxCatalogPages = 16_384;

interface DatabaseFile {
  readonly directory: string;
  readonly file: string;
  readonly journal: "wal" | "delete";
  /** applied in order right after the client opened (busy_timeout and the journal mode are set by the client) */
  readonly pragmas: ReadonlyArray<string>;
}

const sidecars = (path: string): ReadonlyArray<string> => [path, `${path}-wal`, `${path}-shm`];

// a sidecar may disappear between the check and the change (sqlite removes -wal/-shm on the last close)
const ignoreMissing = <R>(effect: Effect.Effect<void, PlatformError, R>): Effect.Effect<void, PlatformError, R> =>
  Effect.catch(effect, (error) => error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error));

/** Restores 0600 on a database file and its -wal/-shm sidecars (after commits and on close, as the baseline store does). */
export const securePrivateFiles = (path: string): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const file of sidecars(path)) if (yield* fs.exists(file)) yield* fs.chmod(file, 0o600).pipe(ignoreMissing);
  });

// the client switches to WAL inside make, so the directory and the file are private before it opens them
const preparePrivateFile = (directory: string, path: string): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(directory, 0o700);
    // created empty with 0600 and closed again; an existing file is not opened, so its bytes and times stay as they are
    if (!(yield* fs.exists(path))) yield* Effect.scoped(fs.open(path, { flag: "a", mode: 0o600 }));
    yield* fs.chmod(path, 0o600);
  });

/**
 * Runs database work with tracing disabled. effect/sql opens a span per statement and per transaction carrying the
 * query text and the transaction exit, neither of which is a sanitized telemetry field (plan 3.10, CT-REDACT-01);
 * every service built on these clients wraps its operations with it.
 */
export const untracedSql: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = Effect.withTracerEnabled(false);

/** The script a database worker thread runs, with the node options and data it starts with. */
export interface DatabaseWorkerEntry {
  readonly url: URL;
  readonly execArgv: Array<string> | undefined;
  readonly workerData?: unknown;
}

/**
 * The worker entry every database client starts: the one beside this module, the built file in dist or the source file
 * through tsx when running from source (the loader is resolved from this module, since a bare specifier in execArgv
 * resolves from the working directory). Only tests provide another entry, one that serves through `serveDatabase`.
 */
export const DatabaseWorker = Context.Reference<DatabaseWorkerEntry>("t3-supervisor/DatabaseWorker", {
  defaultValue: () => import.meta.url.endsWith(".ts")
    ? {url: new URL("./db-worker.ts", import.meta.url), execArgv: ["--import", import.meta.resolve("tsx")]}
    : {url: new URL("./db-worker.js", import.meta.url), execArgv: undefined},
});

const decodeReply = Schema.decodeUnknownExit(WorkerReply);

type WorkerConnection = Connection & {readonly isTransaction: () => boolean};

/**
 * One SQLite client whose single connection lives in a dedicated worker thread. The client itself is the stock one that
 * `@effect/sql-sqlite-node` builds in-process (one leased connection behind a semaphore, BEGIN IMMEDIATE, savepoints and
 * the failed-COMMIT cleanup), so transactions, savepoints and cross-service atomicity stay with the caller's fibers and only
 * the statements cross the thread boundary.
 *
 * A statement, once sent, is awaited uninterruptibly: the caller's lease is held until the worker answers, because the
 * synchronous statement cannot be stopped and may still take effect. The worker is never replaced: if it exits, errors,
 * breaks the protocol or cannot be reached, the client is poisoned for good, every waiting statement fails with an unknown
 * outcome and every later one fails without being sent, so nothing is replayed and no transaction continues on another
 * connection. The worker is stopped at once, which closes its connection: SQLite rolls back what it left uncommitted and
 * the file's lock is released without waiting for the client to close. From then on the client has no transaction, so the
 * stock rollback after the failure sends nothing and the caller sees the unknown outcome as a typed `SqlError`. A new
 * client (a rebuilt layer) opens a new worker.
 */
const workerClient = (config: WorkerDatabaseConfig): Effect.Effect<SqlClient.SqlClient, SqlError, Scope.Scope> => Effect.gen(function* () {
  const entry = yield* DatabaseWorker;
  let thread: WorkerThread | undefined;
  const spawn = () => thread = new WorkerThread(entry.url, {...(entry.execArgv ? {execArgv: entry.execArgv} : {}), ...(entry.workerData === undefined ? {} : {workerData: entry.workerData})});
  const worker = yield* Effect.flatMap(Worker.WorkerPlatform, (platform) => platform.spawn<unknown, WorkerRequest>(0)).pipe(
    Effect.provideService(Worker.Spawner, spawn), Effect.provide(NodeWorker.layerPlatform), Effect.orDie);
  const pending = new Map<number, Deferred.Deferred<unknown, SqlError>>();
  let fault: SqlError | undefined;
  let inTransaction = false;
  let sequence = 0;
  const poison = (error: SqlError) => {
    fault ??= error;
    for (const done of pending.values()) Deferred.doneUnsafe(done, Exit.fail(fault));
    pending.clear();
  };
  // a fault: poisoned, and the worker stopped so that its connection closes now
  const abandon = (error: SqlError) => Effect.andThen(Effect.sync(() => poison(error)),
    Effect.promise(() => thread?.terminate() ?? Promise.resolve(0)));
  const settle = (message: unknown) => Effect.suspend(() => {
    const decoded = decodeReply(message);
    if (Exit.isFailure(decoded)) return abandon(connectionLost("The database worker sent a malformed reply"));
    const reply = decoded.value;
    const done = pending.get(reply.id);
    if (done === undefined) return abandon(connectionLost("The database worker answered a request it was not sent"));
    pending.delete(reply.id);
    inTransaction = reply.inTransaction;
    Deferred.doneUnsafe(done, reply.ok ? Exit.succeed(reply.value) : Exit.fail(sqlErrorOf(reply.failure)));
    return Effect.void;
  });
  yield* worker.run(settle).pipe(
    Effect.catchCause(() => abandon(connectionLost("The database worker stopped; a statement in flight has an unknown outcome"))),
    Effect.forkScoped);
  // runs before the worker is closed: nothing is sent once teardown begins, and a waiting statement fails as unknown
  yield* Effect.addFinalizer(() => Effect.sync(() => poison(connectionLost("The database client is closed"))));

  const call = (request: WorkerRequest): Effect.Effect<unknown, SqlError> => Effect.uninterruptible(Effect.suspend(() => {
    if (fault) return Effect.fail(fault);
    const done = Deferred.makeUnsafe<unknown, SqlError>();
    pending.set(request.id, done);
    return worker.send(request).pipe(
      Effect.catchCause(() => abandon(connectionLost("The database worker could not be reached"))),
      Effect.andThen(Deferred.await(done)));
  }));
  const statement = (op: StatementOperation, sql: string, params: ReadonlyArray<unknown>) =>
    Effect.flatMap(SqlClient.SafeIntegers, (safeIntegers) => call({id: ++sequence, op, sql, params, safeIntegers}));
  // rows are the driver's opaque values, carried by structured cloning
  const rows = (op: StatementOperation, sql: string, params: ReadonlyArray<unknown>) =>
    Effect.map(statement(op, sql, params), (value) => value as ReadonlyArray<object>);
  const connection: WorkerConnection = {
    isTransaction: () => fault === undefined && inTransaction,
    execute: (sql, params, transformRows) => Effect.map(rows("execute", sql, params), (all) => transformRows ? transformRows(all) : all),
    executeRaw: (sql, params) => statement("executeRaw", sql, params),
    executeValues: (sql, params) => Effect.map(rows("executeValues", sql, params), (all) => all as ReadonlyArray<ReadonlyArray<unknown>>),
    executeValuesUnprepared: (sql, params) => Effect.map(rows("executeValuesUnprepared", sql, params), (all) => all as ReadonlyArray<ReadonlyArray<unknown>>),
    executeUnprepared: (sql, params, transformRows) => Effect.map(rows("executeUnprepared", sql, params), (all) => transformRows ? transformRows(all) : all),
    executeStream: () => Stream.die("executeStream not implemented"),
  };
  yield* call({id: ++sequence, op: "open", config});

  const { acquirer, borrower, isTransaction, onCommitFailure, transactionAcquirer } = SqlClient.makeSqliteAcquirers({
    connection: Effect.succeed(connection),
    semaphore: yield* Semaphore.make(1),
    isTransaction: (conn) => conn.isTransaction(),
  });
  return yield* SqlClient.make({
    driver: "sqlite-node-worker",
    acquirer,
    borrower,
    compiler: Statement.makeCompilerSqlite(),
    transactionAcquirer,
    onCommitFailure,
    isTransaction,
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
    beginTransaction: config.readonly ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [["db.system.name", "sqlite"]],
  }).pipe(Effect.provide(Reactivity.layer));
});

const openDatabase = (options: DatabaseFile): Effect.Effect<SqlClient.SqlClient, DatabaseOpenError, Scope.Scope | FileSystem.FileSystem> => {
  const directory = resolve(options.directory);
  const path = join(directory, options.file);
  const failed = (cause: unknown) => new DatabaseOpenError({ file: options.file, cause });
  return Effect.gen(function* () {
    yield* preparePrivateFile(directory, path).pipe(Effect.mapError(failed));
    // sidecar modes are restored when the client closes, as the baseline close does; registered before the client,
    // so it runs after the client's own finalizer has closed the connection
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.addFinalizer(() => securePrivateFiles(path).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie));
    const client = yield* workerClient({filename: path, readonly: false, disableWAL: options.journal === "delete", busyTimeoutMs: 5_000}).pipe(
      Effect.mapError(failed));
    for (const pragma of options.pragmas) yield* client.unsafe(`PRAGMA ${pragma}`).pipe(Effect.mapError(failed));
    yield* securePrivateFiles(path).pipe(Effect.mapError(failed));
    return client;
  }).pipe(untracedSql);
};

/** The catalog file with the baseline pragmas of `store.ts`; the store owns its schema. */
export const catalogDbLayer = (dataDirectory: string): Layer.Layer<CatalogDb, DatabaseOpenError, FileSystem.FileSystem> =>
  Layer.effect(CatalogDb, openDatabase({
    directory: dataDirectory,
    file: "catalog.sqlite3",
    journal: "wal",
    pragmas: ["synchronous=FULL", "foreign_keys=ON", "wal_autocheckpoint=256", "secure_delete=ON", `max_page_count=${maxCatalogPages}`],
  }));

/** guidance.sqlite3 with the baseline pragmas of `guidance-store.ts`; the store owns its schema and recovery (S6d). */
export const guidanceDbLayer = (dataDirectory: string): Layer.Layer<GuidanceDb, DatabaseOpenError, FileSystem.FileSystem> =>
  Layer.effect(GuidanceDb, openDatabase({
    directory: dataDirectory,
    file: "guidance.sqlite3",
    journal: "wal",
    pragmas: ["synchronous=FULL", "secure_delete=ON", "max_page_count=16384"],
  }));

/** thread-settings.sqlite3 with the baseline pragmas of `thread-policy.ts`; the store owns its schema (S6d). */
export const policyDbLayer = (dataDirectory: string): Layer.Layer<PolicyDb, DatabaseOpenError, FileSystem.FileSystem> =>
  Layer.effect(PolicyDb, openDatabase({
    directory: dataDirectory,
    file: "thread-settings.sqlite3",
    journal: "wal",
    pragmas: ["synchronous=FULL"],
  }));

/**
 * The access database (access/login.sqlite3) on a file the caller already validated: DELETE journal, synchronous=FULL,
 * busy_timeout 5000 and max_page_count=256 (plan 3.2). It neither creates, secures nor bootstraps the file: only the
 * service initializes a missing database through its own temp-file-and-link procedure, the forge never does, and
 * service-auth keeps the identity checks before and after the open and the schema validation (a file replaced in
 * between fails that validation, as at baseline). Provide it once per dashboard server lifetime or per forge operation;
 * never two clients in one process.
 */
export const accessDbLayer = (path: string): Layer.Layer<AccessDb, DatabaseOpenError> =>
  Layer.effect(AccessDb, Effect.gen(function* () {
    const failed = (cause: unknown) => new DatabaseOpenError({ file: "login.sqlite3", cause });
    const client = yield* workerClient({filename: path, readonly: false, disableWAL: true, busyTimeoutMs: 5_000}).pipe(Effect.mapError(failed));
    for (const pragma of ["synchronous=FULL", "max_page_count=256"]) yield* client.unsafe(`PRAGMA ${pragma}`).pipe(Effect.mapError(failed));
    return client;
  }).pipe(untracedSql));

/**
 * A read-only client on an existing store file, for the rollout scan: no statement, pragma or file creation writes. With a
 * write-ahead log beside the file the client reads through it (a live server keeps it); without one every committed row is
 * in the file itself, which is then opened immutable, so the client creates no log or shared-memory file of its own.
 */
export const readOnlyDatabase = (directory: string, file: string): Effect.Effect<SqlClient.SqlClient, DatabaseOpenError, Scope.Scope> => {
  const path = join(resolve(directory), file);
  const filename = existsSync(`${path}-wal`) ? path : `${pathToFileURL(path).href}?immutable=1`;
  return workerClient({filename, readonly: true, disableWAL: false, busyTimeoutMs: 5_000}).pipe(
    Effect.mapError((cause) => new DatabaseOpenError({ file, cause })), untracedSql);
};
