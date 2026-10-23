import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  AuthenticationError, AuthorizationError, ConnectionError, ConstraintError, DeadlockError, LockTimeoutError, SerializationError,
  SqlError, type SqlErrorReason, SqlSyntaxError, StatementTimeoutError, UniqueViolation, UnknownError,
} from "effect/sql/SqlError";

// the messages between a database client on the main thread and its connection in a worker thread (src/db.ts,
// src/db-worker-serve.ts). requests run one at a time in arrival order; every reply names its request and carries whether
// the connection is inside a transaction afterwards, which is how the main thread answers the synchronous isTransaction check.
// both sides decode what they receive; statement parameters and results stay opaque values that structured cloning carries
// unchanged (strings, numbers, bigints, Uint8Array, null). the worker loads this module too, so it imports single modules

/** How the worker opens its one connection: the options the in-process client used. */
export const WorkerDatabaseConfig = Schema.Struct({
  filename: Schema.String,
  readonly: Schema.Boolean,
  disableWAL: Schema.Boolean,
  busyTimeoutMs: Schema.Number,
});
export type WorkerDatabaseConfig = typeof WorkerDatabaseConfig.Type;

export const StatementOperation = Schema.Literals(["execute", "executeRaw", "executeValues", "executeValuesUnprepared", "executeUnprepared"]);
export type StatementOperation = typeof StatementOperation.Type;

export const WorkerRequest = Schema.Union([
  Schema.Struct({id: Schema.Number, op: Schema.Literal("open"), config: WorkerDatabaseConfig}),
  Schema.Struct({id: Schema.Number, op: StatementOperation, sql: Schema.String, params: Schema.Array(Schema.Unknown), safeIntegers: Schema.Boolean}),
]);
export type WorkerRequest = typeof WorkerRequest.Type;

const ReasonTag = Schema.Literals(["ConnectionError", "AuthenticationError", "AuthorizationError", "SqlSyntaxError", "UniqueViolation",
  "ConstraintError", "DeadlockError", "SerializationError", "LockTimeoutError", "StatementTimeoutError", "UnknownError"]);

/** A failed statement as it crosses the thread boundary: the classified reason only, never SQL text, values or native messages. */
export const WorkerFailure = Schema.Struct({
  tag: ReasonTag,
  message: Schema.UndefinedOr(Schema.String),
  operation: Schema.UndefinedOr(Schema.String),
  code: Schema.UndefinedOr(Schema.String),
  errcode: Schema.UndefinedOr(Schema.Number),
  constraint: Schema.UndefinedOr(Schema.String),
});
export type WorkerFailure = typeof WorkerFailure.Type;

export const WorkerReply = Schema.Union([
  Schema.Struct({id: Schema.Number, inTransaction: Schema.Boolean, ok: Schema.Literal(true), value: Schema.Unknown}),
  Schema.Struct({id: Schema.Number, inTransaction: Schema.Boolean, ok: Schema.Literal(false), failure: WorkerFailure}),
]);
export type WorkerReply = typeof WorkerReply.Type;

/** The id a worker uses to report a request it could not decode; no request ever has it. */
export const malformedRequestId = -1;

// the sqlite result code of a native error (its generic text and its extended number), the only part of its cause that
// crosses the boundary
const codeOf = (cause: unknown): string | undefined => {
  if (!Predicate.isObject(cause)) return undefined;
  if (Predicate.hasProperty(cause, "errstr") && Predicate.isString(cause.errstr)) return cause.errstr;
  return Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : undefined;
};
const errcodeOf = (cause: unknown): number | undefined =>
  Predicate.hasProperty(cause, "errcode") && Predicate.isNumber(cause.errcode) ? cause.errcode : undefined;

/** The reason of a failed statement, reduced to what may leave the worker. */
export const workerFailure = (error: SqlError): WorkerFailure => ({
  tag: error.reason._tag,
  message: error.reason.message,
  operation: error.reason.operation,
  code: codeOf(error.reason.cause),
  errcode: errcodeOf(error.reason.cause),
  constraint: error.reason._tag === "UniqueViolation" ? error.reason.constraint : undefined,
});

/** A failed statement's cause on the main thread: the sqlite result code alone, never its message. */
export interface SqliteFailureCode {
  readonly code: string;
  readonly errcode: number | undefined;
}

/** The same reason class on the main thread; its cause is the sqlite code alone. */
export const sqlErrorOf = (failure: WorkerFailure): SqlError => {
  const cause: SqliteFailureCode = {code: failure.code ?? failure.tag, errcode: failure.errcode};
  const fields = {cause, message: failure.message, operation: failure.operation};
  const reason = ((): SqlErrorReason => {
    switch (failure.tag) {
      case "ConnectionError": return new ConnectionError(fields);
      case "AuthenticationError": return new AuthenticationError(fields);
      case "AuthorizationError": return new AuthorizationError(fields);
      case "SqlSyntaxError": return new SqlSyntaxError(fields);
      case "UniqueViolation": return new UniqueViolation({...fields, constraint: failure.constraint ?? ""});
      case "ConstraintError": return new ConstraintError(fields);
      case "DeadlockError": return new DeadlockError(fields);
      case "SerializationError": return new SerializationError(fields);
      case "LockTimeoutError": return new LockTimeoutError(fields);
      case "StatementTimeoutError": return new StatementTimeoutError(fields);
      case "UnknownError": return new UnknownError(fields);
    }
  })();
  return new SqlError({reason});
};

/** The connection is gone or broke its protocol: an in-flight statement may or may not have taken effect, and nothing is sent again. */
export const connectionLost = (message: string): SqlError =>
  new SqlError({reason: new ConnectionError({cause: "worker_unavailable", message, operation: "worker"})});
