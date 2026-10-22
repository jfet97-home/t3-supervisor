import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { CatalogDb, catalogDbLayer } from "../src/db.js";

const pragmaValue = (rows: ReadonlyArray<unknown>): unknown => Object.values(rows[0] as object)[0];

describe("CatalogDb", () => {
  it.live("opens the catalog file private with the baseline pragmas and rolls an interrupted transaction back", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "t3-supervisor-db-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })));
      const directory = join(root, "data");
      const observed = yield* Effect.scoped(Effect.gen(function* () {
        const db = yield* CatalogDb;
        const pragmas: Record<string, unknown> = {};
        for (const name of ["journal_mode", "synchronous", "foreign_keys", "busy_timeout", "wal_autocheckpoint", "secure_delete", "max_page_count"]) {
          pragmas[name] = pragmaValue(yield* db.unsafe(`PRAGMA ${name}`));
        }
        yield* db.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        const fiber = yield* Effect.forkChild(db.withTransaction(Effect.gen(function* () {
          yield* db.unsafe("INSERT INTO t (v) VALUES ('x')");
          yield* Effect.never;
        })));
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(fiber);
        const rows = pragmaValue(yield* db.unsafe("SELECT count(*) AS n FROM t"));
        const modes = Object.fromEntries(yield* Effect.promise(async () => Promise.all(
          [directory, ...(await readdir(directory)).map((file) => join(directory, file))]
            .map(async (path) => [path.slice(directory.length) || "/", ((await stat(path)).mode & 0o777).toString(8)] as const))));
        return { pragmas, rows, modes };
      }).pipe(Effect.provide(catalogDbLayer(directory))));
      assert.deepEqual(observed.pragmas, { journal_mode: "wal", synchronous: 2, foreign_keys: 1, busy_timeout: 5000,
        wal_autocheckpoint: 256, secure_delete: 1, max_page_count: 16384 });
      assert.equal(observed.rows, 0);
      assert.equal(observed.modes["/"], "700");
      for (const [path, mode] of Object.entries(observed.modes)) if (path !== "/") assert.equal(mode, "600", path);
    }), { timeout: 10_000 });
});
