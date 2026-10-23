import { StatementSync } from "node:sqlite";
import { workerData } from "node:worker_threads";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { WorkerRunnerPlatform } from "effect/workers/WorkerRunner";
import { serveDatabase } from "../../src/db-worker-serve.js";

// a database worker for test/db-worker.test.ts: the production worker with one fault at the statement whose text is `sql`
// - started: before the statement runs, the shared cell turns 1 and its waiters are woken; the statement then runs as
//   usual (a busy wait or a long query is in progress once the cell is 1)
// - exit: once the statement ran, this thread exits before its reply is sent
// - corrupt: once the statement ran, this and every later reply is replaced by a message that is not a reply
// workerData: { sql, fault, cell: Int32Array over a SharedArrayBuffer }

const FaultData = Schema.Struct({
  sql: Schema.String,
  fault: Schema.Literals(["started", "exit", "corrupt"]),
  cell: Schema.instanceOf(Int32Array),
});
const { sql, fault, cell } = Schema.decodeUnknownSync(FaultData)(workerData);

let corrupt = false;
const around = <F extends (this: StatementSync, ...parameters: never[]) => unknown>(method: F): F => function (this: StatementSync, ...parameters: Parameters<F>) {
  if (this.sourceSQL !== sql) return Reflect.apply(method, this, parameters);
  if (fault === "started") {
    Atomics.store(cell, 0, 1);
    Atomics.notify(cell, 0);
  }
  const result = Reflect.apply(method, this, parameters);
  if (fault === "exit") process.exit(1);
  if (fault === "corrupt") corrupt = true;
  return result;
} as F;
StatementSync.prototype.all = around(StatementSync.prototype.all);
StatementSync.prototype.run = around(StatementSync.prototype.run);

// replies pass through unchanged until the fault statement ran
const corrupting = Layer.effect(WorkerRunnerPlatform, Effect.map(WorkerRunnerPlatform, (platform) => WorkerRunnerPlatform.of({
  start: <O, I>() => Effect.map(platform.start<O, I>(), (runner) => ({
    ...runner,
    send: (portId: number, message: O, transfers?: ReadonlyArray<unknown>) =>
      runner.send(portId, corrupt ? { not: "a reply" } as O : message, transfers),
  })),
}))).pipe(Layer.provide(NodeWorkerRunner.layer));

NodeRuntime.runMain(serveDatabase.pipe(Effect.provide(corrupting)), { disableErrorReporting: true });
