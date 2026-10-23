import { Data, Effect, Schema } from "effect";
import { type SqlClient, SqlClient as Sql, SqlError } from "effect/sql";
import { untracedSql } from "./db.js";
import type { GuidanceDb } from "./db.js";
import type { ProjectSupervisorStoreError } from "./project-supervisor-store.js";
import type { TeamStoreError } from "./supervisor-team-store.js";
import type { ThreadPolicyStoreError } from "./thread-policy.js";
import type { WorkflowStateStoreError } from "./workflow-state-store.js";

// the sql helpers shared by the stores on guidance.sqlite3 (and the thread-policy store): statement and transaction
// runners that drop the driver's cause, row and stored-document decoding with typed errors, and the schema reads at open

// a guidance.sqlite3 failure: a statement failed (sqlReason is the driver's classification) or a stored row of the named
// kind did not decode; it carries no statement text, row content or cause, and a row that does not decode is never
// read as absent
export class GuidanceStoreError extends Data.TaggedError("GuidanceStoreError")<{
  readonly reason: "sql_failed" | "row_invalid";
  readonly row: string | null;
  readonly sqlReason: string | null;
}> {
  override get message(): string {
    return this.reason === "row_invalid" ? `guidance store row invalid: ${this.row}` : `guidance store sql failed: ${this.sqlReason}`;
  }
}

/** Any failure of the guidance and thread-policy stores: what a store call inside a supervision service may fail with. */
export type SupervisionStoreError = GuidanceStoreError | ProjectSupervisorStoreError | TeamStoreError | WorkflowStateStoreError | ThreadPolicyStoreError;

/**
 * Maps the driver's SqlError with `toError` and runs the work untraced (statement spans carry query text); the sql cause is
 * dropped, since it may hold statement text or stored values and no caller may log it. Every other failure passes unchanged.
 */
export const mapSqlError = <F>(toError: (error: SqlError.SqlError) => F) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, SqlError.SqlError> | F, R> =>
  effect.pipe(
    Effect.mapError((error): Exclude<E, SqlError.SqlError> | F => SqlError.isSqlError(error) ? toError(error) : error as Exclude<E, SqlError.SqlError>),
    untracedSql,
  );

/** Maps the driver's SqlError to the guidance store error with its classification. */
export const guidanceSql: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, Exclude<E, SqlError.SqlError> | GuidanceStoreError, R> =
  mapSqlError((error) => new GuidanceStoreError({ reason: "sql_failed", row: null, sqlReason: error.reason._tag }));

/**
 * One transaction on the client (BEGIN IMMEDIATE), or a savepoint of the caller's: a caller's critical section over the
 * store services. It contains SQL only (no admission, native call or sleep) and its begin/commit failure is a store error.
 */
export const guidanceTransaction = (db: GuidanceDb["Service"]) => <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, SqlError.SqlError> | GuidanceStoreError, R> =>
  guidanceSql(db.withTransaction(body));

/** A read of several statements as one snapshot (a deferred BEGIN), or a savepoint of the caller's transaction. */
export const snapshotRead = (db: SqlClient.SqlClient) => <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError.SqlError, R> =>
  db.withTransaction(body).pipe(Effect.provideService(Sql.BeginTransaction, "BEGIN"));

/** Fails with `invalid()` when a stored row does not decode. */
export const decodeRow = <S extends Schema.Top & { readonly DecodingServices: never }, F>(schema: S, invalid: () => F) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: unknown): Effect.Effect<S["Type"], F> => decode(value).pipe(Effect.mapError(invalid));
};

/** Fails with the guidance store error naming the row kind when a stored row does not decode. */
export const decodeGuidanceRow = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, row: string) =>
  decodeRow(schema, () => new GuidanceStoreError({ reason: "row_invalid", row, sqlReason: null }));

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const DocumentColumn = Schema.Struct({ document: Schema.String });
const decodeDocumentColumn = Schema.decodeUnknownEffect(DocumentColumn);

/**
 * Parses a stored JSON document, checks the fields its readers rely on and returns it whole: every other field is user
 * data written back byte for byte. An unreadable or unexpected document fails with `invalid()`.
 */
export const storedDocument = <A, F>(text: string, guard: (value: unknown) => boolean, invalid: () => F): Effect.Effect<A, F> =>
  decodeJson(text).pipe(Effect.mapError(invalid), Effect.flatMap((value) => guard(value) ? Effect.succeed(value as A) : Effect.fail(invalid())));

/** The stored document of a row's `document` column, checked as `storedDocument` does. */
export const documentRow = <A, F>(row: unknown, guard: (value: unknown) => boolean, invalid: () => F): Effect.Effect<A, F> =>
  decodeDocumentColumn(row).pipe(Effect.mapError(invalid), Effect.flatMap(({ document }) => storedDocument<A, F>(document, guard, invalid)));

/** The stored documents of rows with a `document` column, in order. */
export const documentRows = <A, F>(rows: ReadonlyArray<unknown>, guard: (value: unknown) => boolean, invalid: () => F): Effect.Effect<Array<A>, F> =>
  Effect.forEach(rows, (row) => documentRow<A, F>(row, guard, invalid));

const ChangesRow = Schema.Struct({ changes: Schema.Number });
/** The number of rows a write statement changed, read from the driver's run result. */
export const changedRows = (statement: Effect.Effect<unknown, SqlError.SqlError>): Effect.Effect<number, SqlError.SqlError | GuidanceStoreError> =>
  statement.pipe(Effect.flatMap(decodeGuidanceRow(ChangesRow, "statement_result")), Effect.map((result) => result.changes));

const ColumnName = Schema.Struct({ name: Schema.String });
/** The column names of a table, for the idempotent column additions at open. */
export const tableColumns = Effect.fnUntraced(function* (db: SqlClient.SqlClient, table: string) {
  const rows = yield* db.unsafe(`PRAGMA table_info(${table})`);
  const columns: string[] = [];
  for (const row of rows) columns.push((yield* decodeGuidanceRow(ColumnName, "table_info")(row)).name);
  return columns;
});

// ---- the read-only rollout scan: each store checks its existing rows with its own decoders (scripts/rollout-scan.ts)

/**
 * A stored row a store would not read: it does not decode, or it decodes and the store treats it as incompatible. It names
 * the table, the row kind and the row's key, never its content; `read` says when the run reads it: when it opens its stores (a
 * finding there fails the run's start), in every supervision cycle (a finding there fails each cycle that reaches it), or only
 * when a call reads that row.
 */
export interface StoredRowFinding {
  readonly table: string;
  readonly kind: string;
  readonly key: string;
  readonly problem: "undecodable" | "incompatible";
  readonly read: "open" | "cycle" | "call";
}
/** What opening a store does to an existing file beside reading its rows: a table or column added, rows recovered or reset. */
export interface OpenChange {
  readonly table: string;
  readonly change: string;
  readonly rows: number;
}
export interface StoredRowScan {
  readonly findings: ReadonlyArray<StoredRowFinding>;
  readonly changes: ReadonlyArray<OpenChange>;
}

/** Whether the file has the table; the open creates a missing one. */
export const tableExists = (db: SqlClient.SqlClient, table: string) =>
  Effect.map(db`SELECT 1 FROM sqlite_master WHERE type='table' AND name=${table}`, (rows) => rows.length > 0);

// the rows of a table whose columns are not the ones its reader selects (a prototype table the conditional create kept)
type MismatchedRows = ReadonlyArray<Record<string, unknown>> & {readonly shapeMismatch?: true};

/** The rows `select` reads from `table`, none when the file has no such table, or a mismatch when the select fails on it. */
export const rowsOf = (db: SqlClient.SqlClient, table: string, select: string): Effect.Effect<MismatchedRows, SqlError.SqlError> =>
  Effect.flatMap(tableExists(db, table), (exists) => exists
    ? db.unsafe<Record<string, unknown>>(select).pipe(Effect.catchIf(SqlError.isSqlError, () => Effect.succeed(Object.assign([], {shapeMismatch: true as const}))))
    : Effect.succeed([]));

/** The key a finding names: the row's own key columns, never its content. */
export const rowKey = (row: Record<string, unknown>, columns: ReadonlyArray<string>): string =>
  columns.map((column) => String(row[column] ?? "")).join(" ");

/**
 * Runs each row through `decode`, the store's own decoding; a row it fails or rejects is a finding of its key. A table whose
 * columns its reader cannot select is one incompatible finding naming the table.
 */
export const rowFindings = <R>(rows: ReadonlyArray<R>, finding: Omit<StoredRowFinding, "key">, key: (row: R) => string,
  decode: (row: R) => Effect.Effect<unknown, unknown>): Effect.Effect<Array<StoredRowFinding>> =>
  (rows as {readonly shapeMismatch?: true}).shapeMismatch
    ? Effect.succeed([{...finding, kind: `${finding.kind} table`, key: finding.table, problem: "incompatible"}])
    : Effect.map(Effect.forEach(rows, (row) => Effect.map(Effect.exit(Effect.suspend(() => decode(row))), (exit) => exit._tag === "Failure" ? [{...finding, key: key(row)}] : [])),
      (found) => found.flat());

/** The open's table creation and column additions for a table, as changes. */
export const schemaChanges = Effect.fnUntraced(function* (db: SqlClient.SqlClient, table: string, columns: ReadonlyArray<string> = []) {
  if (!(yield* tableExists(db, table))) return [{table, change: "table created", rows: 0}] satisfies Array<OpenChange>;
  const present = yield* tableColumns(db, table);
  return columns.filter((column) => !present.includes(column)).map((column): OpenChange => ({table, change: `column ${column} added with its default`, rows: 0}));
});
