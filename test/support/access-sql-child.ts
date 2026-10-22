import { NodeFileSystem, NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Cause, Console, Effect, Layer, type PlatformError, Queue, Stdio, Stream } from "effect";
import { ServiceAuth } from "../../src/service-auth.js";

// the second process of CT-SQL-04 (access): its own service auth on the same login database, racing the parent for
// every grant from the last one; stdin carries the grant tokens one per line and then "go"; stdout answers one json line per step and
// names grants by index only, never by token
// args: <data directory>

const race = (commands: Queue.Dequeue<string, Cause.Done | PlatformError.PlatformError>) => Effect.gen(function* () {
  const auth = yield* ServiceAuth;
  const send = (message: object) => Console.log(JSON.stringify(message));
  yield* send({ step: "ready" });
  const tokens: string[] = [];
  for (let line = yield* Queue.take(commands); line !== "go"; line = yield* Queue.take(commands)) tokens.push(line);
  yield* send({ step: "started" });
  const won: number[] = [];
  for (let index = tokens.length - 1; index >= 0; index -= 1) if ((yield* auth.login(tokens[index]!)) !== null) won.push(index);
  yield* send({ step: "done", won });
  // stays until the parent closes stdin
  yield* Queue.take(commands).pipe(Effect.flatMap(() => Effect.fail(new Error("unexpected command"))), Effect.catchIf(Cause.isDone, () => Effect.void));
});

NodeRuntime.runMain(Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const [directory] = yield* stdio.args;
  if (directory === undefined) return yield* Effect.fail(new Error("usage"));
  const commands = yield* Queue.unbounded<string, Cause.Done | PlatformError.PlatformError>();
  yield* Effect.forkChild(stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines, Stream.runIntoQueue(commands)));
  yield* race(commands).pipe(Effect.provide(ServiceAuth.layer(directory)));
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeStdio.layer))));
