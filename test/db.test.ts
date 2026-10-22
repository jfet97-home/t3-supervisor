import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { AccessDb, accessDbLayer, CatalogDb, catalogDbLayer } from "../src/db.js";

const pragmaValue = (rows: ReadonlyArray<unknown>): unknown => Object.values(rows[0] as object)[0];

describe("CatalogDb", () => {
  it.live("opens the catalog file private with the baseline pragmas and rolls an interrupted transaction back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = join(yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-db-" }), "data");
      const observed = yield* Effect.scoped(Effect.gen(function* () {
        const db = yield* CatalogDb;
        const pragmas: Record<string, unknown> = {};
        for (const name of ["journal_mode", "synchronous", "foreign_keys", "busy_timeout", "wal_autocheckpoint", "secure_delete", "max_page_count"]) {
          pragmas[name] = pragmaValue(yield* db.unsafe(`PRAGMA ${name}`));
        }
        yield* db.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        // the body signals after its insert, so the interruption lands inside the transaction, not before it began
        const inserted = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(db.withTransaction(Effect.gen(function* () {
          yield* db.unsafe("INSERT INTO t (v) VALUES ('x')");
          yield* Deferred.succeed(inserted, undefined);
          return yield* Effect.never;
        })));
        yield* Deferred.await(inserted);
        yield* Fiber.interrupt(fiber);
        const rows = pragmaValue(yield* db.unsafe("SELECT count(*) AS n FROM t"));
        // the connection is reusable after the rollback
        yield* db.withTransaction(db.unsafe("INSERT INTO t (v) VALUES ('y')"));
        const after = pragmaValue(yield* db.unsafe("SELECT count(*) AS n FROM t"));
        const modes: Record<string, string> = { "/": ((yield* fs.stat(directory)).mode & 0o777).toString(8) };
        for (const file of yield* fs.readDirectory(directory)) modes[file] = ((yield* fs.stat(join(directory, file))).mode & 0o777).toString(8);
        return { pragmas, rows, after, modes };
      }).pipe(Effect.provide(catalogDbLayer(directory))));
      assert.deepEqual(observed.pragmas, { journal_mode: "wal", synchronous: 2, foreign_keys: 1, busy_timeout: 5000,
        wal_autocheckpoint: 256, secure_delete: 1, max_page_count: 16384 });
      assert.equal(observed.rows, 0);
      assert.equal(observed.after, 1);
      assert.equal(observed.modes["/"], "700");
      for (const [path, mode] of Object.entries(observed.modes)) if (path !== "/") assert.equal(mode, "600", path);
    }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });

  it.live("opens an existing access database with the delete journal and the access pragmas, creating no sidecar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-access-db-" });
      const path = join(directory, "login.sqlite3");
      // the service creates and validates the file before any client opens it; here an empty private file stands in
      yield* Effect.scoped(fs.open(path, { flag: "a", mode: 0o600 }));
      const observed = yield* Effect.scoped(Effect.gen(function* () {
        const db = yield* AccessDb;
        const pragmas: Record<string, unknown> = {};
        for (const name of ["journal_mode", "synchronous", "busy_timeout", "max_page_count"]) pragmas[name] = pragmaValue(yield* db.unsafe(`PRAGMA ${name}`));
        yield* db.withTransaction(db.unsafe("CREATE TABLE grants (hash TEXT PRIMARY KEY) STRICT"));
        return { pragmas, files: (yield* fs.readDirectory(directory)).sort() };
      }).pipe(Effect.provide(accessDbLayer(path))));
      assert.deepEqual(observed.pragmas, { journal_mode: "delete", synchronous: 2, busy_timeout: 5000, max_page_count: 256 });
      assert.deepEqual(observed.files, ["login.sqlite3"]);
      assert.equal(((yield* fs.stat(path)).mode & 0o777).toString(8), "600");
    }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });
});

