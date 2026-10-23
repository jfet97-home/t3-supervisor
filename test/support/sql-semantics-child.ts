import { NodeFileSystem, NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Cause, Console, Effect, Layer, type PlatformError, Queue, Schema, Stdio, Stream } from "effect";
import type { SqlClient } from "effect/sql";
import { isDbFile, withDbFile } from "./sql-db-files.js";

// the second process of CT-SQL-04: its own client of the same database file, driven by stdin lines and answering one json
// line per step; it compare-and-sets the revision column of one row of the table
// args: <data directory> <iterations> <row id> <database file> <table>

const RevisionRow = Schema.Struct({ revision: Schema.Finite });
const decodeRevisions = Schema.decodeUnknownEffect(Schema.Array(RevisionRow));

const run = (db: SqlClient.SqlClient, iterations: number, rowId: string, table: string, commands: Queue.Dequeue<string, Cause.Done | PlatformError.PlatformError>) =>
  Effect.gen(function* () {
    const send = (message: object) => Console.log(JSON.stringify(message));
    const expect = (command: string) => Queue.take(commands).pipe(Effect.flatMap((line) =>
      line === command ? Effect.void : Effect.fail(new Error(`expected ${command}`))));
    const revision = db`SELECT revision FROM ${db(table)} WHERE id=${rowId}`.pipe(Effect.flatMap(decodeRevisions), Effect.map(([row]) => row?.revision ?? -1));
    const compareAndSet = (expected: number) =>
      db`UPDATE ${db(table)} SET revision=${expected + 1} WHERE id=${rowId} AND revision=${expected} RETURNING revision`.pipe(Effect.flatMap(decodeRevisions));

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
  });

NodeRuntime.runMain(Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const [directory, iterations, rowId, file, table] = yield* stdio.args;
  if (directory === undefined || iterations === undefined || rowId === undefined || file === undefined || !isDbFile(file) || table === undefined)
    return yield* Effect.fail(new Error("usage"));
  const commands = yield* Queue.unbounded<string, Cause.Done | PlatformError.PlatformError>();
  yield* Effect.forkChild(stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines, Stream.runIntoQueue(commands)));
  yield* withDbFile(file, directory, (db) => run(db, Number(iterations), rowId, table, commands));
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeStdio.layer))));
