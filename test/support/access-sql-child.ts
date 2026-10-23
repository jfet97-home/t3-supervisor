import { writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { NodeFileSystem, NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Cause, Effect, Layer, type PlatformError, Predicate, Queue, Stdio, Stream } from "effect";
import { ServiceAuth } from "../../src/service-auth.js";

// the second process of CT-SQL-04 (access): its own service auth on the same login database; stdout answers one json
// line per step and names grants by index only, never by token
// - race: races the parent for every grant from the last one; stdin carries the grant tokens one per line and then "go"
// - expiry: stdin carries one grant token, then every "login" line logs in with it and answers whether a session was
//   issued
// args: <data directory> <race|expiry>

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
// which cannot return before that holder releases; "begun" reports how the service's step ended and, when it failed,
// the sqlite error code and the busy_timeout read back from the very connection that ran it (read, never set). the probe
// proves the lock before the call only: the step may still begin after a release
const installBarrier = (path: string) => Effect.acquireRelease(Effect.sync(() => {
  const probe = new DatabaseSync(path, { timeout: 0 });
  const all = StatementSync.prototype.all;
  const prepare = DatabaseSync.prototype.prepare;
  // node:sqlite statements do not expose their connection, so each BEGIN IMMEDIATE statement is mapped to it here
  const connections = new WeakMap<StatementSync, DatabaseSync>();
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
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, ...parameters: Parameters<typeof prepare>) {
    const statement = Reflect.apply(prepare, this, parameters);
    if (statement.sourceSQL === "BEGIN IMMEDIATE") connections.set(statement, this);
    return statement;
  } as typeof prepare;
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
      const busyTimeout = connections.get(this)?.prepare("PRAGMA busy_timeout").get()?.timeout;
      send({ step: "begun", grant, ok: false, code: sqliteCode(error), busyTimeout });
      throw error;
    }
  } as typeof all;
  return {
    arm: (grant: number) => Effect.sync(() => { state.armed = grant; }),
    remove: () => {
      StatementSync.prototype.all = all;
      DatabaseSync.prototype.prepare = prepare;
      probe.close();
    },
  };
}), (barrier) => Effect.sync(barrier.remove));

type Commands = Queue.Dequeue<string, Cause.Done | PlatformError.PlatformError>;
type Barrier = Effect.Success<ReturnType<typeof installBarrier>>;

const race = (commands: Commands, barrier: Barrier) => Effect.gen(function* () {
  const auth = yield* ServiceAuth;
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
});

// the first login meets the barrier, armed while the parent holds BEGIN IMMEDIATE for the whole of that login
const expire = (commands: Commands, barrier: Barrier) => Effect.gen(function* () {
  const auth = yield* ServiceAuth;
  const token = yield* Queue.take(commands);
  yield* barrier.arm(0);
  for (;;) {
    if ((yield* Queue.take(commands)) !== "login") return yield* Effect.fail(new Error("unexpected command"));
    const session = yield* auth.login(token);
    yield* Effect.sync(() => send({ step: "login", session: session !== null }));
  }
}).pipe(Effect.catchIf(Cause.isDone, () => Effect.void));

// ready once the service auth is open and the barrier installed
const serve = (directory: string, mode: "race" | "expiry", commands: Commands) => Effect.gen(function* () {
  yield* ServiceAuth;
  const barrier = yield* installBarrier(join(directory, "access", "login.sqlite3"));
  yield* Effect.sync(() => send({ step: "ready" }));
  yield* (mode === "race" ? race : expire)(commands, barrier);
}).pipe(Effect.scoped);

NodeRuntime.runMain(Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const [directory, mode] = yield* stdio.args;
  if (directory === undefined || (mode !== "race" && mode !== "expiry")) return yield* Effect.fail(new Error("usage"));
  const commands = yield* Queue.unbounded<string, Cause.Done | PlatformError.PlatformError>();
  yield* Effect.forkChild(stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines, Stream.runIntoQueue(commands)));
  yield* serve(directory, mode, commands).pipe(Effect.provide(ServiceAuth.layer(directory)));
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeStdio.layer))));
