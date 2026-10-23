import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Context, Data, Effect, FileSystem, Layer, type PlatformError as Platform, type Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import type { SqlClient } from "effect/sql";

type PlatformError = Platform.PlatformError;

// one client per database file, each behind its own named service, so a generic SqlClient never shadows another
// file's client; only this module opens SQLite clients (lint rule)

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
    const client = yield* SqliteClient.make({
      filename: path,
      disableWAL: options.journal === "delete",
      busyTimeout: "5 seconds",
    }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(failed));
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
    const client = yield* SqliteClient.make({ filename: path, disableWAL: true, busyTimeout: "5 seconds" }).pipe(
      Effect.provide(Reactivity.layer), Effect.mapError(failed));
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
  return SqliteClient.make({ filename, readonly: true }).pipe(Effect.provide(Reactivity.layer),
    Effect.mapError((cause) => new DatabaseOpenError({ file, cause })), untracedSql);
};
