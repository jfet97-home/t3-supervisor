import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Clock, Effect, Exit, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { DatabaseWorkerEntry } from "../../src/db.js";

// the store characterizations' seam on a guidance file: statements through the store's own client, so on the one worker
// connection the stores use, and the declarative hooks of the seam worker (test/support/db-seam-worker.ts), read back from its
// log. a hook observes from inside a statement; nothing on this thread runs while the worker executes it

/** The seam worker logging to `log`: the production database worker with the declarative test hooks. */
export const seamWorker = (log: string): DatabaseWorkerEntry => ({
  url: new URL("./db-seam-worker.ts", import.meta.url),
  execArgv: ["--import", import.meta.resolve("tsx")],
  workerData: {log},
});

const SeamEntry = Schema.Union([
  Schema.Struct({kind: Schema.Literal("prepare"), db: Schema.String, sql: Schema.String}),
  Schema.Struct({kind: Schema.Literal("log"), db: Schema.String, label: Schema.String, values: Schema.Array(Schema.Unknown)}),
  Schema.Struct({kind: Schema.Literal("observe"), db: Schema.String, label: Schema.String,
    results: Schema.Array(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))}),
]);
export type SeamEntry = typeof SeamEntry.Type;
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(SeamEntry));

/** The hook entries the seam worker logged for one database file so far, in order. */
export const seamEntries = (log: string, path: string): ReadonlyArray<SeamEntry> => {
  if (!existsSync(log)) return [];
  const file = resolve(path);
  return readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0).map((line) => decodeEntry(line)).filter((entry) => resolve(entry.db) === file);
};

/** A SQL string literal of `text`, for a hook's arguments in a trigger body. */
export const sqlText = (text: string): string => `'${text.replaceAll("'", "''")}'`;

export interface PreparedSeam {
  run(...params: ReadonlyArray<unknown>): Effect.Effect<void>;
  get(...params: ReadonlyArray<unknown>): Effect.Effect<Record<string, unknown> | undefined>;
  all(...params: ReadonlyArray<unknown>): Effect.Effect<Array<Record<string, unknown>>>;
}

/** The seam of one guidance file: statements on the stores' client and the hooks its seam worker logged. */
export interface DbSeam {
  readonly sql: SqlClient.SqlClient;
  /** Whether the connection is inside a transaction: a plain BEGIN fails exactly then and is otherwise rolled back. */
  readonly inTransaction: Effect.Effect<boolean>;
  exec(script: string): Effect.Effect<void>;
  prepare(statement: string): PreparedSeam;
  /** The calls of `seam_log(label, ...)` so far, their values in call order. */
  logged(label: string): ReadonlyArray<ReadonlyArray<unknown>>;
  /** The results of `seam_observe(label, ...)` so far: per call, the rows of each of its queries. */
  observed(label: string): ReadonlyArray<ReadonlyArray<ReadonlyArray<Record<string, unknown>>>>;
  /** The statement texts the connection prepared after the `from`th entry of its log. */
  prepared(from?: number): ReadonlyArray<string>;
  /** How many entries the seam worker logged for this file so far. */
  readonly logLength: number;
}

/** The seam of the guidance file at `path`, its statements on `sql` and its hooks logged to `log`. */
export const dbSeam = (sql: SqlClient.SqlClient, log: string, path: string): DbSeam => {
  const rows = (row: object): Record<string, unknown> => ({...(row as Record<string, unknown>)});
  const statement = (text: string, params: ReadonlyArray<unknown>) =>
    sql.unsafe<Record<string, unknown>>(text, params).pipe(Effect.map((result) => result.map(rows)), Effect.orDie);
  const entries = () => seamEntries(log, path);
  return {
    sql,
    inTransaction: Effect.flatMap(Effect.exit(sql.unsafe("BEGIN")), (exit) =>
      Exit.isSuccess(exit) ? Effect.as(Effect.orDie(sql.unsafe("ROLLBACK")), false) : Effect.succeed(true)),
    exec: (script) => Effect.forEach(statementsOf(script), (text) => statement(text, []), {discard: true}),
    prepare: (text) => ({
      run: (...params) => Effect.asVoid(statement(text, params)),
      get: (...params) => Effect.map(statement(text, params), (result) => result[0]),
      all: (...params) => statement(text, params),
    }),
    logged: (label) => entries().flatMap((entry) => entry.kind === "log" && entry.label === label ? [entry.values] : []),
    observed: (label) => entries().flatMap((entry) => entry.kind === "observe" && entry.label === label ? [entry.results] : []),
    prepared: (from = 0) => entries().slice(from).flatMap((entry) => entry.kind === "prepare" ? [entry.sql] : []),
    get logLength() {return entries().length;},
  };
};

// the statements of an exec script; a trigger body's own semicolons stay inside its statement
export const statementsOf = (script: string): string[] => {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  for (const token of script.split(/(;|\bBEGIN\b|\bEND\b)/iu)) {
    if (/^BEGIN$/iu.test(token) && /\bTRIGGER\b/iu.test(current)) depth++;
    else if (/^END$/iu.test(token) && depth > 0) depth--;
    if (token === ";" && depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else current += token;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
};

/** Meta rows in key order, as the characterization golden compares them. */
export const metaRows = (db: DbSeam): Effect.Effect<Array<[string, string]>> =>
  Effect.map(db.prepare("SELECT key,value FROM meta ORDER BY key").all(), (rows) => rows.map((row) => [String(row.key), String(row.value)]));

/** Every column of `table` in row order. */
export const tableRows = (db: DbSeam, table: string): Effect.Effect<Array<Record<string, unknown>>> =>
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

/** An outside reader's rows. The connection is the caller's own. */
export const readerRows = (db: DatabaseSync, table: string): Array<Record<string, unknown>> =>
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({...(row as Record<string, unknown>)}));

/** The message of a failed effect, for the baseline `assert.rejects` pattern. */
export const failsWith = <A, E>(effect: Effect.Effect<A, E>, pattern: RegExp): Effect.Effect<E> =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect).pipe(Effect.orDie);
    const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
    if (!pattern.test(message)) return yield* Effect.die(new Error(`expected ${pattern}, received ${message}`));
    return error;
  });

/** A clock whose wall time is `now()`; sleeps and the monotonic clock stay `ambient`. */
export const clockFrom = (now: () => number, ambient: Clock.Clock): Clock.Clock => ({
  currentTimeMillisUnsafe: now,
  currentTimeMillis: Effect.sync(now),
  currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => ambient.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: ambient.monotonicTimeNanos,
  sleep: (duration) => ambient.sleep(duration),
});

/** Runs `effect` on a clock fixed at `millis`, leaving sleeps on the ambient clock. */
export const withMillis = (millis: number) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.clockWith((ambient) => Effect.provideService(effect, Clock.Clock, clockFrom(() => millis, ambient)));
