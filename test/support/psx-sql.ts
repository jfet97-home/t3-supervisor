import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Clock, Effect } from "effect";

// the raw connection of each guidance file, recorded while a handle opens it (the client keeps its connection private).
// a depth count keeps a nested open on the same patch and restores the previous exec only when the outermost open ends.
const connections = new Map<string, DatabaseSync>();
let depth = 0;
const nativeExec = DatabaseSync.prototype.exec;
const patchedExec = function (this: DatabaseSync, statements: string) {
  const location = this.location();
  if (location) connections.set(resolve(location), this);
  return nativeExec.call(this, statements);
};

/** Runs `effect` while guidance clients record the connection they open. */
export const recordConnections = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    if (depth++ === 0) DatabaseSync.prototype.exec = patchedExec;
    return effect.pipe(Effect.ensuring(Effect.sync(() => {
      if (--depth === 0) DatabaseSync.prototype.exec = nativeExec;
    })));
  });

/** The connection recorded for `path`, for a seam that the effect client keeps private. */
export const connectionOf = (path: string): DatabaseSync => {
  const connection = connections.get(resolve(path));
  if (!connection) throw new Error("the guidance connection was not recorded");
  return connection;
};

// the statements of an exec script; a trigger body's own semicolons stay inside its statement
export const statementsOf = (script: string): string[] => {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  for (const token of script.split(/(;|\bBEGIN\b|\bEND\b)/iu)) {
    if (/^BEGIN$/iu.test(token) && /\bTRIGGER\b/iu.test(current)) depth++;
    else if (/^END$/iu.test(token) && depth > 0) depth--;
    if (token === ";" && depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else current += token;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
};

export interface PreparedSeam {
  run(...params: ReadonlyArray<unknown>): Effect.Effect<{changes: number; lastInsertRowid: number | bigint}>;
  get(...params: ReadonlyArray<unknown>): Effect.Effect<Record<string, unknown> | undefined>;
  all(...params: ReadonlyArray<unknown>): Effect.Effect<Array<Record<string, unknown>>>;
}

/** The baseline node:sqlite seam on the run's own guidance connection. */
export interface DbSeam {
  readonly isTransaction: boolean;
  readonly connection: DatabaseSync;
  function(name: string, implementation: (...args: Array<unknown>) => unknown): void;
  exec(script: string): Effect.Effect<void>;
  prepare(statement: string): PreparedSeam;
}

/** The seam of the guidance file at `path`. Statements run on the recorded connection, which the effect client also uses. */
export const dbSeam = (path: string): DbSeam => {
  const connection = () => connectionOf(path);
  const rows = (row: unknown): Record<string, unknown> => ({...(row as Record<string, unknown>)});
  return {
    get isTransaction() {return connection().isTransaction;},
    get connection() {return connection();},
    function: (name, implementation) => {connection().function(name, implementation as never);},
    exec: (script) => Effect.sync(() => {connection().exec(statementsOf(script).join(";\n"));}),
    prepare: (statement) => {
      const values = (params: ReadonlyArray<unknown>) => params as SQLInputValue[];
      return {
        run: (...params) => Effect.sync(() => connection().prepare(statement).run(...values(params)) as {changes: number; lastInsertRowid: number | bigint}),
        get: (...params) => Effect.sync(() => {
          const row = connection().prepare(statement).get(...values(params));
          return row === undefined ? undefined : rows(row);
        }),
        all: (...params) => Effect.sync(() => connection().prepare(statement).all(...values(params)).map(rows)),
      };
    },
  };
};

/** Meta rows in key order, as the characterization golden compares them. */
export const metaRows = (db: DbSeam): Effect.Effect<Array<[string, string]>> =>
  Effect.map(db.prepare("SELECT key,value FROM meta ORDER BY key").all(), (rows) => rows.map((row) => [String(row.key), String(row.value)]));

/** Every column of `table` in row order. */
export const tableRows = (db: DbSeam, table: string): Effect.Effect<Array<Record<string, unknown>>> =>
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

/** An outside reader's rows. The connection is the caller's own. */
export const readerRows = (db: DatabaseSync, table: string): Array<Record<string, unknown>> =>
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({...(row as Record<string, unknown>)}));

/** The message of a failed effect, for the baseline `assert.rejects` pattern. */
export const failsWith = <A, E>(effect: Effect.Effect<A, E>, pattern: RegExp): Effect.Effect<E> =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect).pipe(Effect.orDie);
    const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
    if (!pattern.test(message)) return yield* Effect.die(new Error(`expected ${pattern}, received ${message}`));
    return error;
  });

/** A clock whose wall time is `now()`; sleeps and the monotonic clock stay `ambient`. */
export const clockFrom = (now: () => number, ambient: Clock.Clock): Clock.Clock => ({
  currentTimeMillisUnsafe: now,
  currentTimeMillis: Effect.sync(now),
  currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => ambient.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: ambient.monotonicTimeNanos,
  sleep: (duration) => ambient.sleep(duration),
});

/** Runs `effect` on a clock fixed at `millis`, leaving sleeps on the ambient clock. */
export const withMillis = (millis: number) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.clockWith((ambient) => Effect.provideService(effect, Clock.Clock, clockFrom(() => millis, ambient)));
