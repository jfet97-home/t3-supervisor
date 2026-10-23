import { writeSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { workerData } from "node:worker_threads";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { serveDatabase } from "../../src/db-worker-serve.js";

// the database worker of the CT-SQL-04 (access) child (test/support/access-sql-child.ts): the production worker with the
// child's BEGIN IMMEDIATE barrier installed in this thread, where the service client's statements now run. the child arms
// it by storing a grant index in the shared cell; the next BEGIN IMMEDIATE step of this worker takes it (-1: disarmed).
// workerData: { path: the login database, armed: Int32Array over a SharedArrayBuffer }

const BarrierData = Schema.Struct({ path: Schema.String, armed: Schema.instanceOf(Int32Array) });
const { path, armed } = Schema.decodeUnknownSync(BarrierData)(workerData);

// one synchronous write per line straight to the process's stdout, as the child writes its own lines, so all of them
// reach the parent in order
const send = (message: object): void => {
  writeSync(1, `${JSON.stringify(message)}\n`);
};

const SQLITE_BUSY = 5;
const sqliteCode = (error: unknown): unknown => Predicate.hasProperty(error, "errcode") ? error.errcode : undefined;

// the barrier at the real client/transaction boundary. the service client opens every transaction with one native
// BEGIN IMMEDIATE step on its own connection and offers no callback inside it, so this test-only worker wraps that
// native call. once armed, the next such step first tries BEGIN IMMEDIATE on a separate connection that never waits
// (busy: another process holds the write lock right now), reports "waiting" and only then enters the service's own step,
// which cannot return before that holder releases; "begun" reports how the service's step ended and, when it failed,
// the sqlite error code and the busy_timeout read back from the very connection that ran it (read, never set). the probe
// proves the lock before the call only: the step may still begin after a release
let probe: DatabaseSync | undefined;
const probeWriteLock = (): "busy" | "free" | "failed" => {
  probe ??= new DatabaseSync(path, { timeout: 0 });
  try {
    probe.exec("BEGIN IMMEDIATE");
  } catch (error) {
    return sqliteCode(error) === SQLITE_BUSY ? "busy" : "failed";
  }
  probe.exec("ROLLBACK");
  return "free";
};
const all = StatementSync.prototype.all;
const prepare = DatabaseSync.prototype.prepare;
// node:sqlite statements do not expose their connection, so each BEGIN IMMEDIATE statement is mapped to it here
const connections = new WeakMap<StatementSync, DatabaseSync>();
DatabaseSync.prototype.prepare = function (this: DatabaseSync, ...parameters: Parameters<typeof prepare>) {
  const statement = Reflect.apply(prepare, this, parameters);
  if (statement.sourceSQL === "BEGIN IMMEDIATE") connections.set(statement, this);
  return statement;
} as typeof prepare;
StatementSync.prototype.all = function (this: StatementSync, ...parameters: Parameters<typeof all>) {
  if (this.sourceSQL !== "BEGIN IMMEDIATE") return Reflect.apply(all, this, parameters);
  const grant = Atomics.exchange(armed, 0, -1);
  if (grant === -1) return Reflect.apply(all, this, parameters);
  send({ step: "waiting", grant, probe: probeWriteLock() });
  try {
    const rows = Reflect.apply(all, this, parameters);
    send({ step: "begun", grant, ok: true });
    return rows;
  } catch (error) {
    const busyTimeout = connections.get(this)?.prepare("PRAGMA busy_timeout").get()?.timeout;
    send({ step: "begun", grant, ok: false, code: sqliteCode(error), busyTimeout });
    throw error;
  }
} as typeof all;

NodeRuntime.runMain(serveDatabase.pipe(Effect.provide(NodeWorkerRunner.layer)), { disableErrorReporting: true });
