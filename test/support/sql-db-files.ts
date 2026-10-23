import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { CatalogDb, catalogDbLayer, GuidanceDb, guidanceDbLayer, PolicyDb, policyDbLayer } from "../../src/db.js";

// the database files whose clients the sql semantics cases run on, each opened through its own production layer

export const dbFiles = ["catalog", "guidance", "policy"] as const;
export type DbFile = typeof dbFiles[number];

export const isDbFile = (value: string): value is DbFile => (dbFiles as ReadonlyArray<string>).includes(value);

/** Runs `use` on a fresh client of the file in `directory`, closed when `use` ends. */
export const withDbFile = <A, E, R>(file: DbFile, directory: string, use: (db: SqlClient.SqlClient) => Effect.Effect<A, E, R>) => {
  switch (file) {
    case "catalog": return Effect.flatMap(CatalogDb, use).pipe(Effect.provide(Layer.fresh(catalogDbLayer(directory))));
    case "guidance": return Effect.flatMap(GuidanceDb, use).pipe(Effect.provide(Layer.fresh(guidanceDbLayer(directory))));
    case "policy": return Effect.flatMap(PolicyDb, use).pipe(Effect.provide(Layer.fresh(policyDbLayer(directory))));
  }
};
