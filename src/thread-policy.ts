import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { SqlError } from "effect/sql";
import { SupervisorConfig as Configuration } from "./config.js";
import { PolicyDb, untracedSql } from "./db.js";
import type { SupervisorConfig } from "./types.js";

import { ThreadPolicy as ThreadPolicyDocument, type ThreadPolicySettings } from "./thread-policy-contract.js";
const validId = (id: string) => id.length > 0 && id.length <= 512 && !/[\s\x00-\x1f\x7f]/u.test(id);

// the synchronous store of today's callers; the s6d switch removes it, with the interim ThreadPolicy service, for
// ThreadPolicyStoreService
/** Persists instance-specific excluded-thread policy. */
export class ThreadPolicyStore {
  private readonly db: DatabaseSync;
  constructor(directory: string, seed: Omit<ThreadPolicySettings, "generation">) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "thread-settings.sqlite3");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL)");
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES(1,?)").run(JSON.stringify({ generation: 1, ...seed }));
  }
  close(): void { this.db.close(); }
  get(): ThreadPolicySettings {
    return Schema.decodeUnknownSync(ThreadPolicyDocument)(JSON.parse(String(this.db.prepare("SELECT document FROM settings WHERE id=1").get()?.document)) as unknown);
  }
  save(input: ThreadPolicySettings): ThreadPolicySettings {
    if (!Number.isSafeInteger(input.generation) || input.excludedThreadIds.length > 500 ||
      !input.excludedThreadIds.every(validId) || new Set(input.excludedThreadIds).size !== input.excludedThreadIds.length)
      throw new Error("Choose valid, unique chat IDs.");
    const next = { ...input, generation: input.generation + 1 };
    const updated = this.db.prepare("UPDATE settings SET document=? WHERE id=1 AND json_extract(document,'$.generation')=?").run(JSON.stringify(next), input.generation);
    if (!updated.changes) throw new Error("Chat settings changed in another tab. Reload first.");
    return next;
  }
}
export const currentThreadPolicy = (config: SupervisorConfig): ThreadPolicySettings => config.threadPolicy?.get() ?? {
  generation: 0, excludedThreadIds: config.excludedThreadIds,
};

// the process thread-policy store, opened from the configuration and closed on release; until S6d it is the existing
// synchronous store (D-01, B-02), with no SqlClient
export class ThreadPolicy extends Context.Service<ThreadPolicy, ThreadPolicyStore>()("t3-supervisor/ThreadPolicy") {
  static readonly layer: Layer.Layer<ThreadPolicy, never, Configuration> = Layer.effect(ThreadPolicy, Effect.gen(function* () {
    const config = yield* Configuration;
    return yield* Effect.acquireRelease(
      Effect.sync(() => new ThreadPolicyStore(config.dataDirectory, { excludedThreadIds: config.excludedThreadIds })),
      (store) => Effect.sync(() => store.close()),
    );
  }));
}

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

/** A save with an invalid generation or chat id list; the message is the synchronous store's. */
export class ThreadPolicyInvalid extends Schema.TaggedError<ThreadPolicyInvalid>()("ThreadPolicyInvalid", {
  message: Schema.Literal("Choose valid, unique chat IDs."),
}) {}

/** A save whose generation no longer matches the stored policy; the message is the synchronous store's. */
export class ThreadPolicyConflict extends Schema.TaggedError<ThreadPolicyConflict>()("ThreadPolicyConflict", {
  message: Schema.Literal("Chat settings changed in another tab. Reload first."),
}) {}

const decodePolicyRow = Schema.decodeUnknownEffect(Schema.Struct({ document: Schema.fromJsonString(ThreadPolicyDocument) }));
const decodeChanges = Schema.decodeUnknownEffect(Schema.Struct({ changes: Schema.Number }));
const rowInvalid = () => new ThreadPolicyStoreError({ reason: "row_invalid", sqlReason: null });

const policySql = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, SqlError.SqlError> | ThreadPolicyStoreError, R> =>
  effect.pipe(
    Effect.mapError((error): Exclude<E, SqlError.SqlError> | ThreadPolicyStoreError => SqlError.isSqlError(error)
      ? new ThreadPolicyStoreError({ reason: "sql_failed", sqlReason: error.reason._tag })
      // every other failure is a store or domain error and passes unchanged
      : error as Exclude<E, SqlError.SqlError>),
    untracedSql,
  );

/** The Effect API of the thread-policy store: the synchronous store's methods, returning Effects. */
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

  return ThreadPolicyStoreService.of({ get, save });
}).pipe(untracedSql);

/** The thread-policy store on the process's PolicyDb client, seeded from the configured excluded chat ids. */
// it takes the name ThreadPolicyStore when the s6d switch removes the synchronous class and the interim ThreadPolicy service
export class ThreadPolicyStoreService extends Context.Service<ThreadPolicyStoreService, ThreadPolicyStoreShape>()("t3-supervisor/ThreadPolicyStore") {
  static readonly layer: Layer.Layer<ThreadPolicyStoreService, ThreadPolicyStoreError, PolicyDb | Configuration> = Layer.effect(ThreadPolicyStoreService,
    Effect.flatMap(Configuration, (config) => makeThreadPolicyStore({ excludedThreadIds: config.excludedThreadIds })));
}
