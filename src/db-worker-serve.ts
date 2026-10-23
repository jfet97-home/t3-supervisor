import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { isSqlError, SqlError, UnknownError } from "effect/sql/SqlError";
import { WorkerRunnerPlatform } from "effect/workers/WorkerRunner";
import { malformedRequestId, type WorkerReply, WorkerRequest, workerFailure } from "./db-worker-protocol.js";

// the worker side of one database client (src/db.ts): it opens the file with the same sqlite client the main thread used
// to open in-process, leases that client's single connection for the worker's lifetime and runs the main thread's
// statements on it one at a time. synchronous sqlite work and busy waits block only this thread. a reply never carries sql
// text, values or native messages, and no handler fails, so the runner never logs a cause

type SqliteConnection = Connection & {readonly isTransaction: () => boolean};

const unexpected = (message: string): SqlError =>
  new SqlError({reason: new UnknownError({cause: "worker_defect", message, operation: "worker"})});

const decodeRequest = Schema.decodeUnknownExit(WorkerRequest);

/** Serves one connection until the main thread closes the worker; the connection closes with it. */
export const serveDatabase: Effect.Effect<void, unknown, WorkerRunnerPlatform> = Effect.scoped(Effect.gen(function* () {
  const runner = yield* (yield* WorkerRunnerPlatform).start<WorkerReply, unknown>();
  const scope = yield* Effect.scope;
  // one request at a time, in arrival order, so no statement interleaves with another
  const serial = yield* Semaphore.make(1);
  let connection: SqliteConnection | undefined;
  const inTransaction = () => connection?.isTransaction() ?? false;

  const run = (request: WorkerRequest): Effect.Effect<unknown, SqlError> => {
    if (request.op === "open") {
      if (connection) return Effect.fail(unexpected("The database worker is already open"));
      return Effect.gen(function* () {
        const client = yield* SqliteClient.make({filename: request.config.filename, readonly: request.config.readonly,
          disableWAL: request.config.disableWAL, busyTimeout: Duration.millis(request.config.busyTimeoutMs)});
        connection = (yield* client.reserve) as SqliteConnection;
      }).pipe(Effect.provide(Reactivity.layer), Scope.provide(scope));
    }
    const current = connection;
    if (!current) return Effect.fail(unexpected("The database worker is not open"));
    const statement = ((): Effect.Effect<unknown, SqlError> => {
      switch (request.op) {
        case "execute": return current.execute(request.sql, request.params, undefined);
        case "executeRaw": return current.executeRaw(request.sql, request.params);
        case "executeValues": return current.executeValues(request.sql, request.params);
        case "executeValuesUnprepared": return current.executeValuesUnprepared(request.sql, request.params);
        case "executeUnprepared": return current.executeUnprepared(request.sql, request.params, undefined);
      }
    })();
    return Effect.provideService(statement, SqlClient.SafeIntegers, request.safeIntegers);
  };

  const reply = (id: number, exit: Exit.Exit<unknown, SqlError>): WorkerReply => Exit.isSuccess(exit)
    ? {id, inTransaction: inTransaction(), ok: true, value: exit.value}
    : {id, inTransaction: inTransaction(), ok: false, failure: workerFailure(
      ((error) => isSqlError(error) ? error : unexpected("The database worker failed unexpectedly"))(Cause.squash(exit.cause)))};

  const handle = (message: unknown) => serial.withPermit(Effect.suspend(() => {
    const decoded = decodeRequest(message);
    // a request that does not decode has no id to answer; the main thread treats this reply as a protocol fault
    if (Exit.isFailure(decoded)) return runner.send(0, reply(malformedRequestId, Exit.fail(unexpected("The database worker received a malformed request"))));
    return Effect.exit(run(decoded.value)).pipe(Effect.flatMap((exit) => runner.send(0, reply(decoded.value.id, exit))));
  }));

  yield* runner.run((_port, message) => handle(message));
}).pipe(Effect.withTracerEnabled(false)));
