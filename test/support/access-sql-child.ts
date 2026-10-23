import { writeSync } from "node:fs";
import { join } from "node:path";
import { NodeFileSystem, NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Cause, Effect, Layer, type PlatformError, Queue, Stdio, Stream } from "effect";
import { DatabaseWorker, type DatabaseWorkerEntry } from "../../src/db.js";
import { ServiceAuth } from "../../src/service-auth.js";

// the second process of CT-SQL-04 (access): its own service auth on the same login database; stdout answers one json
// line per step and names grants by index only, never by token
// - race: races the parent for every grant from the last one; stdin carries the grant tokens one per line and then "go"
// - expiry: stdin carries one grant token, then every "login" line logs in with it and answers whether a session was
//   issued
// args: <data directory> <race|expiry>

// every message is one synchronous write: the barrier writes from the database worker thread while that thread blocks in a
// native call, so all lines take the same unbuffered path and reach the parent in order
const send = (message: object): void => {
  writeSync(1, `${JSON.stringify(message)}\n`);
};

// the BEGIN IMMEDIATE barrier lives in the database worker (test/support/access-sql-worker.ts), where the service
// client's statements run; this process arms it through a cell of shared memory, -1 while disarmed
const barrierWorker = (path: string) => {
  const armed = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)).fill(-1);
  const entry: DatabaseWorkerEntry = {
    url: new URL("./access-sql-worker.ts", import.meta.url),
    execArgv: ["--import", import.meta.resolve("tsx")],
    workerData: { path, armed },
  };
  return { entry, barrier: { arm: (grant: number) => Effect.sync(() => { Atomics.store(armed, 0, grant); }) } };
};

type Commands = Queue.Dequeue<string, Cause.Done | PlatformError.PlatformError>;
type Barrier = ReturnType<typeof barrierWorker>["barrier"];

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

// ready once the service auth is open over the barrier worker
const serve = (mode: "race" | "expiry", commands: Commands, barrier: Barrier) => Effect.gen(function* () {
  yield* ServiceAuth;
  yield* Effect.sync(() => send({ step: "ready" }));
  yield* (mode === "race" ? race : expire)(commands, barrier);
});

NodeRuntime.runMain(Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const [directory, mode] = yield* stdio.args;
  if (directory === undefined || (mode !== "race" && mode !== "expiry")) return yield* Effect.fail(new Error("usage"));
  const commands = yield* Queue.unbounded<string, Cause.Done | PlatformError.PlatformError>();
  yield* Effect.forkChild(stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines, Stream.runIntoQueue(commands)));
  const { entry, barrier } = barrierWorker(join(directory, "access", "login.sqlite3"));
  yield* serve(mode, commands, barrier).pipe(Effect.provide(ServiceAuth.layer(directory)), Effect.provideService(DatabaseWorker, entry));
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeStdio.layer))));
