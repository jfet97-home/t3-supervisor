import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { GuidanceDb, guidanceDbLayer, PolicyDb, policyDbLayer } from "../../src/db.js";
import { SupervisorIds } from "../../src/ids.js";

// the s6d store services on a temporary data directory, each opened through the production database layer

export const temporaryDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-s6d-" });
}).pipe(Effect.provide(NodeFileSystem.layer));

/** Ids in the persisted v4 format, numbered from 1 in draw order for each built layer. */
export const sequentialIds = (prefix = "00000000-0000-4000-8000"): Layer.Layer<SupervisorIds> => Layer.effect(SupervisorIds, Effect.sync(() => {
  let drawn = 0;
  return SupervisorIds.of({ uuid: Effect.sync(() => `${prefix}-${String(++drawn).padStart(12, "0")}`) });
}));

/** A fresh guidance.sqlite3 client for `directory`, closed when the effect using it ends. */
export const guidanceDb = (directory: string): Layer.Layer<GuidanceDb, never> =>
  Layer.fresh(guidanceDbLayer(directory)).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie);

/** A fresh thread-settings.sqlite3 client for `directory`, closed when the effect using it ends. */
export const policyDb = (directory: string): Layer.Layer<PolicyDb, never> =>
  Layer.fresh(policyDbLayer(directory)).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie);

/** Rows of a query as plain objects, for comparing table contents. */
export const rows = (db: SqlClient.SqlClient, query: string, ...params: ReadonlyArray<unknown>) =>
  db.unsafe<Record<string, unknown>>(query, params).pipe(Effect.map((result) => result.map((row) => ({ ...row }))), Effect.orDie);
