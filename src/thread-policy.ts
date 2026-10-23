import { Context, Data, Effect, Layer, Schema } from "effect";
import { SupervisorConfig as Configuration } from "./config.js";
import { PolicyDb, untracedSql } from "./db.js";
import { mapSqlError } from "./guidance-sql.js";

import { ThreadPolicy as ThreadPolicyDocument, type ThreadPolicySettings } from "./thread-policy-contract.js";
const validId = (id: string) => id.length > 0 && id.length <= 512 && !/[\s\x00-\x1f\x7f]/u.test(id);

// a thread-settings.sqlite3 failure: a statement failed (sqlReason is the driver's classification) or the stored policy
// row did not decode; it carries no statement text, row content or cause, and a missing or invalid row is never read as
// absent
export class ThreadPolicyStoreError extends Data.TaggedError("ThreadPolicyStoreError")<{
  readonly reason: "sql_failed" | "row_invalid";
  readonly sqlReason: string | null;
}> {
  override get message(): string {
    return this.reason === "row_invalid" ? "thread policy row invalid" : `thread policy sql failed: ${this.sqlReason}`;
  }
}

/** A save with an invalid generation or chat id list, with the baseline store's message. */
export class ThreadPolicyInvalid extends Schema.TaggedError<ThreadPolicyInvalid>()("ThreadPolicyInvalid", {
  message: Schema.Literal("Choose valid, unique chat IDs."),
}) {}

/** A save whose generation no longer matches the stored policy, with the baseline store's message. */
export class ThreadPolicyConflict extends Schema.TaggedError<ThreadPolicyConflict>()("ThreadPolicyConflict", {
  message: Schema.Literal("Chat settings changed in another tab. Reload first."),
}) {}

const decodePolicyRow = Schema.decodeUnknownEffect(Schema.Struct({ document: Schema.fromJsonString(ThreadPolicyDocument) }));
const decodeChanges = Schema.decodeUnknownEffect(Schema.Struct({ changes: Schema.Number }));
const rowInvalid = () => new ThreadPolicyStoreError({ reason: "row_invalid", sqlReason: null });

const policySql = mapSqlError((error) => new ThreadPolicyStoreError({ reason: "sql_failed", sqlReason: error.reason._tag }));

/** The excluded-chat policy of the instance (thread-settings.sqlite3). */
export interface ThreadPolicyStoreShape {
  /** An authoritative read of the stored policy on every call; nothing is cached. */
  readonly get: () => Effect.Effect<ThreadPolicySettings, ThreadPolicyStoreError>;
  /** Saves by compare-and-set on the stored generation and returns the saved policy with the next generation. */
  readonly save: (input: ThreadPolicySettings) => Effect.Effect<ThreadPolicySettings, ThreadPolicyStoreError | ThreadPolicyInvalid | ThreadPolicyConflict>;
}

/** Builds the thread-policy store on the process's PolicyDb client; the seed is written only into a new file. */
export const makeThreadPolicyStore = (seed: Omit<ThreadPolicySettings, "generation">) => Effect.gen(function* () {
  const db = yield* PolicyDb;
  yield* policySql(db.withTransaction(Effect.gen(function* () {
    yield* db.unsafe("CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL)");
    yield* db`INSERT OR IGNORE INTO settings VALUES(1,${JSON.stringify({ generation: 1, ...seed })})`;
  })));

  const get = () => policySql(db`SELECT document FROM settings WHERE id=1`.pipe(
    Effect.flatMap(([row]) => decodePolicyRow(row).pipe(Effect.mapError(rowInvalid))),
    Effect.map((row) => row.document)));

  // the compare-and-set is one statement: exactly one changed row commits the next generation
  const save = (input: ThreadPolicySettings) => policySql(Effect.gen(function* () {
    if (!Number.isSafeInteger(input.generation) || input.excludedThreadIds.length > 500 ||
      !input.excludedThreadIds.every(validId) || new Set(input.excludedThreadIds).size !== input.excludedThreadIds.length)
      return yield* new ThreadPolicyInvalid({ message: "Choose valid, unique chat IDs." });
    const next = { ...input, generation: input.generation + 1 };
    const updated = yield* db`UPDATE settings SET document=${JSON.stringify(next)} WHERE id=1 AND json_extract(document,'$.generation')=${input.generation}`.raw.pipe(
      Effect.flatMap((result) => decodeChanges(result).pipe(Effect.mapError(rowInvalid))));
    if (!updated.changes) return yield* new ThreadPolicyConflict({ message: "Chat settings changed in another tab. Reload first." });
    return next;
  }));

  return ThreadPolicyStore.of({ get, save });
}).pipe(untracedSql);

/** The thread-policy store on the process's PolicyDb client, seeded from the configured excluded chat ids. */
export class ThreadPolicyStore extends Context.Service<ThreadPolicyStore, ThreadPolicyStoreShape>()("t3-supervisor/ThreadPolicyStore") {
  static readonly layer: Layer.Layer<ThreadPolicyStore, ThreadPolicyStoreError, PolicyDb | Configuration> = Layer.effect(ThreadPolicyStore,
    Effect.flatMap(Configuration, (config) => makeThreadPolicyStore({ excludedThreadIds: config.excludedThreadIds })));
}
