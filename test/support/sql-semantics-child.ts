import { NodeFileSystem, NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Cause, Console, Effect, Layer, type PlatformError, Queue, Schema, Stdio, Stream } from "effect";
import { CatalogDb, catalogDbLayer } from "../../src/db.js";

// the second process of CT-SQL-04: its own catalog client on the same file, driven by stdin lines and answering one json line per step
// args: <data directory> <iterations> <thread id>

const RevisionRow = Schema.Struct({ revision: Schema.Finite });
const decodeRevisions = Schema.decodeUnknownEffect(Schema.Array(RevisionRow));

const run = (directory: string, iterations: number, threadId: string, commands: Queue.Dequeue<string, Cause.Done | PlatformError.PlatformError>) =>
  Effect.gen(function* () {
    const db = yield* CatalogDb;
    const send = (message: object) => Console.log(JSON.stringify(message));
    const expect = (command: string) => Queue.take(commands).pipe(Effect.flatMap((line) =>
      line === command ? Effect.void : Effect.fail(new Error(`expected ${command}`))));
    const revision = db`SELECT revision FROM threads WHERE id=${threadId}`.pipe(Effect.flatMap(decodeRevisions), Effect.map(([row]) => row?.revision ?? -1));
    const compareAndSet = (expected: number) =>
      db`UPDATE threads SET revision=${expected + 1} WHERE id=${threadId} AND revision=${expected} RETURNING revision`.pipe(Effect.flatMap(decodeRevisions));

    // read outside any transaction, so the parent can commit past it before this process writes
    const stale = yield* revision;
    yield* send({ step: "ready", revision: stale });
    yield* expect("stale");
    const rejected = yield* db.withTransaction(compareAndSet(stale));
    yield* send({ step: "stale", updated: rejected.length });

    yield* expect("go");
    yield* send({ step: "started" });
    const written: number[] = [];
    let misses = 0;
    for (let index = 0; index < iterations; index += 1) {
      // read and write under one BEGIN IMMEDIATE, so no other writer can commit in between
      const rows = yield* db.withTransaction(Effect.flatMap(revision, compareAndSet));
      if (rows[0] === undefined) misses += 1;
      else written.push(rows[0].revision);
    }
    yield* send({ step: "done", written, misses });
    // stays until the parent closes stdin
    yield* Queue.take(commands).pipe(Effect.flatMap(() => Effect.fail(new Error("unexpected command"))), Effect.catchIf(Cause.isDone, () => Effect.void));
  }).pipe(Effect.provide(catalogDbLayer(directory)));

NodeRuntime.runMain(Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const [directory, iterations, threadId] = yield* stdio.args;
  if (directory === undefined || iterations === undefined || threadId === undefined) return yield* Effect.fail(new Error("usage"));
  const commands = yield* Queue.unbounded<string, Cause.Done | PlatformError.PlatformError>();
  yield* Effect.forkChild(stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines, Stream.runIntoQueue(commands)));
  yield* run(directory, Number(iterations), threadId, commands);
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeStdio.layer))));
