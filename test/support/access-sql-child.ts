import { writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { NodeFileSystem, NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Cause, Effect, Layer, type PlatformError, Predicate, Queue, Stdio, Stream } from "effect";
import { ServiceAuth } from "../../src/service-auth.js";

// the second process of CT-SQL-04 (access): its own service auth on the same login database, racing the parent for
// every grant from the last one; stdin carries the grant tokens one per line and then "go"; stdout answers one json line
// per step and names grants by index only, never by token
// args: <data directory>

// every message is one synchronous write: the barrier writes from inside a native call that then blocks this thread, so
// all lines take the same unbuffered path and reach the parent in order
const send = (message: object): void => {
  writeSync(1, `${JSON.stringify(message)}\n`);
};

const SQLITE_BUSY = 5;
const sqliteCode = (error: unknown): unknown => Predicate.hasProperty(error, "errcode") ? error.errcode : undefined;

// the barrier at the real client/transaction boundary. the service client opens every transaction with one native
// BEGIN IMMEDIATE step on its own connection and offers no callback inside it, so this test-only adapter wraps that
// native call. once armed, the next such step first tries BEGIN IMMEDIATE on a separate connection that never waits
// (busy: another process holds the write lock right now), reports "waiting" and only then enters the service's own step,
// which cannot return before that holder releases; "begun" reports how the service's step ended
const installBarrier = (path: string) => Effect.acquireRelease(Effect.sync(() => {
  const probe = new DatabaseSync(path, { timeout: 0 });
  const all = StatementSync.prototype.all;
  const state: { armed: number | undefined } = { armed: undefined };
  const probeWriteLock = (): "busy" | "free" | "failed" => {
    try {
      probe.exec("BEGIN IMMEDIATE");
    } catch (error) {
      return sqliteCode(error) === SQLITE_BUSY ? "busy" : "failed";
    }
    probe.exec("ROLLBACK");
    return "free";
  };
  StatementSync.prototype.all = function (this: StatementSync, ...parameters: Parameters<typeof all>) {
    const grant = state.armed;
    if (grant === undefined || this.sourceSQL !== "BEGIN IMMEDIATE") return Reflect.apply(all, this, parameters);
    state.armed = undefined;
    send({ step: "waiting", grant, probe: probeWriteLock() });
    try {
      const rows = Reflect.apply(all, this, parameters);
      send({ step: "begun", grant, ok: true });
      return rows;
    } catch (error) {
      send({ step: "begun", grant, ok: false });
      throw error;
    }
  } as typeof all;
  return {
    arm: (grant: number) => Effect.sync(() => { state.armed = grant; }),
    remove: () => {
      StatementSync.prototype.all = all;
      probe.close();
    },
  };
}), (barrier) => Effect.sync(barrier.remove));

const race = (directory: string, commands: Queue.Dequeue<string, Cause.Done | PlatformError.PlatformError>) => Effect.gen(function* () {
  const auth = yield* ServiceAuth;
  const barrier = yield* installBarrier(join(directory, "access", "login.sqlite3"));
  yield* Effect.sync(() => send({ step: "ready" }));
  const tokens: string[] = [];
  for (let line = yield* Queue.take(commands); line !== "go"; line = yield* Queue.take(commands)) tokens.push(line);
  // the first login after "go" meets the barrier: the parent holds BEGIN IMMEDIATE until this process reports waiting
  const won: number[] = [];
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (index === tokens.length - 1) yield* barrier.arm(index);
    if ((yield* auth.login(tokens[index]!)) !== null) won.push(index);
  }
  yield* Effect.sync(() => send({ step: "done", won }));
  // stays until the parent closes stdin
  yield* Queue.take(commands).pipe(Effect.flatMap(() => Effect.fail(new Error("unexpected command"))), Effect.catchIf(Cause.isDone, () => Effect.void));
}).pipe(Effect.scoped);

NodeRuntime.runMain(Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const [directory] = yield* stdio.args;
  if (directory === undefined) return yield* Effect.fail(new Error("usage"));
  const commands = yield* Queue.unbounded<string, Cause.Done | PlatformError.PlatformError>();
  yield* Effect.forkChild(stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines, Stream.runIntoQueue(commands)));
  yield* race(directory, commands).pipe(Effect.provide(ServiceAuth.layer(directory)));
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeStdio.layer))));
