import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Context, Data, Effect, Layer, type Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import type { SqlClient } from "effect/sql";

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

// the client switches to WAL inside make, so the directory and the file are private before it opens them
const preparePrivateFile = (directory: string, path: string): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
};

const securePrivateFiles = (path: string): void => {
  for (const file of sidecars(path)) if (existsSync(file)) chmodSync(file, 0o600);
};

const openDatabase = (options: DatabaseFile): Effect.Effect<SqlClient.SqlClient, DatabaseOpenError, Scope.Scope> => {
  const directory = resolve(options.directory);
  const path = join(directory, options.file);
  const failed = (cause: unknown) => new DatabaseOpenError({ file: options.file, cause });
  return Effect.gen(function* () {
    yield* Effect.try({ try: () => preparePrivateFile(directory, path), catch: failed });
    // sidecar modes are restored when the client closes, as the baseline close does
    yield* Effect.addFinalizer(() => Effect.sync(() => securePrivateFiles(path)));
    const client = yield* SqliteClient.make({
      filename: path,
      disableWAL: options.journal === "delete",
      busyTimeout: "5 seconds",
    }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(failed));
    for (const pragma of options.pragmas) yield* client.unsafe(`PRAGMA ${pragma}`).pipe(Effect.mapError(failed));
    yield* Effect.try({ try: () => securePrivateFiles(path), catch: failed });
    return client;
  });
};

/** The catalog file with the baseline pragmas of `store.ts`; the store owns its schema. */
export const catalogDbLayer = (dataDirectory: string): Layer.Layer<CatalogDb, DatabaseOpenError> =>
  Layer.effect(CatalogDb, openDatabase({
    directory: dataDirectory,
    file: "catalog.sqlite3",
    journal: "wal",
    pragmas: ["synchronous=FULL", "foreign_keys=ON", "wal_autocheckpoint=256", "secure_delete=ON", `max_page_count=${maxCatalogPages}`],
  }));
