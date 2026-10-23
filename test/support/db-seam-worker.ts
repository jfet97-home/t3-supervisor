import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { serveDatabase } from "../../src/db-worker-serve.js";

// a database worker for the store characterizations (test/support/psx-sql.ts): the production worker whose connections
// carry declarative test hooks, observable from the test thread through an append-only json-lines log
// - every statement a connection prepares is logged as {kind: "prepare", db, sql}
// - SQL function seam_log(label, ...values) logs {kind: "log", db, label, values}, from a trigger say
// - SQL function seam_observe(label, ...queries) runs each query on a separate read-only connection of the same file, an
//   outside reader that sees committed state only, and logs {kind: "observe", db, label, results}
// the log is written synchronously, so an entry outlives a rollback of the statement that wrote it.
// workerData: { log: the log file }

const { log } = Schema.decodeUnknownSync(Schema.Struct({ log: Schema.String }))(workerData);
const append = (entry: object): void => appendFileSync(log, `${JSON.stringify(entry)}\n`);

const prepare = DatabaseSync.prototype.prepare;
const exec = DatabaseSync.prototype.exec;
const hooked = new WeakSet<DatabaseSync>();
const readers = new Map<string, DatabaseSync>();

// the functions are registered on the first exec of a connection: the client's own pragmas at open
const install = (connection: DatabaseSync): void => {
  if (hooked.has(connection)) return;
  hooked.add(connection);
  const db = connection.location() ?? ":memory:";
  connection.function("seam_log", { varargs: true }, (label, ...values) => {
    append({ kind: "log", db, label, values });
    return null;
  });
  connection.function("seam_observe", { varargs: true }, (label, ...queries) => {
    let reader = readers.get(db);
    if (!reader) {
      reader = new DatabaseSync(db, { readOnly: true });
      readers.set(db, reader);
    }
    const outside = reader;
    append({ kind: "observe", db, label, results: queries.map((query) => outside.prepare(String(query)).all()) });
    return null;
  });
};

DatabaseSync.prototype.exec = function (this: DatabaseSync, ...parameters: Parameters<typeof exec>) {
  install(this);
  return Reflect.apply(exec, this, parameters);
} as typeof exec;
DatabaseSync.prototype.prepare = function (this: DatabaseSync, ...parameters: Parameters<typeof prepare>) {
  if (hooked.has(this)) append({ kind: "prepare", db: this.location() ?? ":memory:", sql: String(parameters[0]) });
  return Reflect.apply(prepare, this, parameters);
} as typeof prepare;

NodeRuntime.runMain(serveDatabase.pipe(Effect.provide(NodeWorkerRunner.layer)), { disableErrorReporting: true });
