/**
 * Streams the complete native thread snapshot and keeps exactly the projection the Supervisor reads. Arrays it never
 * reads are skipped while streaming, and a user or assistant turn item whose text equals its message's text shares
 * that one string. Retained bytes, total bytes read and cancellation are bounded separately, so a response larger than
 * the retained budget can still yield the same complete projection a full read would, and any exceeded budget fails.
 */
import { Clock, Effect, Pull, Schema, Stream } from "effect";

/** Projection arrays no Supervisor code reads; they are validated while streaming and never retained. */
export const UNREAD_PROJECTION_KEYS: ReadonlySet<string> = new Set(["visibleTurnItems", "plans", "checkpointScopes",
  "checkpoints", "contextHandoffs", "contextTransfers", "providerSessions"]);

export const ProjectionStreamFailure = Schema.Literals(["retained_too_large", "transfer_too_large", "invalid", "unreadable",
  "timed_out"]);
export type ProjectionStreamFailure = typeof ProjectionStreamFailure.Type;

export class ProjectionStreamError extends Schema.TaggedError<ProjectionStreamError>()("ProjectionStreamError", {
  code: ProjectionStreamFailure,
}) {
  override readonly message: string = `T3 thread projection stream failed: ${this.code}`;
}

export interface ProjectionStreamBudget {
  /** UTF-8 bytes of retained records, a string shared by a turn item and its message counted once */
  readonly retainedBytes: number;
  /** Bytes read from the response body after any content decoding, retained or skipped */
  readonly transferBytes: number;
  /** Monotonic time of the Effect clock, in milliseconds, after which the read fails as timed out */
  readonly deadline: number;
}

// immediately available chunks never return to the event loop on their own, so timers and interruption would starve
const YIELD_INTERVAL_MS = 20;
// an incoming chunk is scanned in slices of at most this size, so the deadline and yields never depend on its size
const SCAN_SLICE_BYTES = 64 * 1024;

const SPACE = 0x20, TAB = 0x09, LF = 0x0a, CR = 0x0d;
const QUOTE = 0x22, BACKSLASH = 0x5c, COMMA = 0x2c, COLON = 0x3a;
const OPEN_OBJECT = 0x7b, CLOSE_OBJECT = 0x7d, OPEN_ARRAY = 0x5b, CLOSE_ARRAY = 0x5d;

const isWhitespace = (byte: number): boolean => byte === SPACE || byte === TAB || byte === LF || byte === CR;
const isDelimiter = (byte: number): boolean => byte === COMMA || byte === CLOSE_OBJECT || byte === CLOSE_ARRAY || isWhitespace(byte);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const failure = (code: ProjectionStreamFailure): ProjectionStreamError => new ProjectionStreamError({code});

// the scan is a plain generator, so parsing stays a pure calculation: it yields whenever it needs the next slice and
// receives it, or undefined once the body ended; the effect driver below reads, bounds and times every slice
type Scan<A> = Generator<undefined, A, Uint8Array | undefined>;

// structural JSON bytes are ASCII and UTF-8 continuation bytes are >= 0x80, so scanning bytes never splits a value
class ByteCursor {
  private chunk: Uint8Array = new Uint8Array(0);
  private position = 0;
  private captured: Uint8Array[] = [];
  private capturedBytes = 0;
  private captureLimit = 0;

  private *fill(): Scan<boolean> {
    const slice = yield;
    if (slice === undefined) return false;
    this.chunk = slice;
    this.position = 0;
    return true;
  }

  private keep(end: number, start: number): void {
    if (end <= start) return;
    this.capturedBytes += end - start;
    if (this.capturedBytes > this.captureLimit) throw failure("retained_too_large");
    this.captured.push(this.chunk.slice(start, end));
  }

  *peek(): Scan<number> {
    while (this.position >= this.chunk.length) if (!(yield* this.fill())) throw failure("invalid");
    return this.chunk[this.position]!;
  }

  *skipWhitespace(): Scan<void> {
    for (;;) {
      while (this.position < this.chunk.length) {
        if (!isWhitespace(this.chunk[this.position]!)) return;
        this.position++;
      }
      if (!(yield* this.fill())) return;
    }
  }

  *expect(byte: number): Scan<void> {
    yield* this.skipWhitespace();
    if ((yield* this.peek()) !== byte) throw failure("invalid");
    this.position++;
  }

  /** Consumes `byte` if it is next, after whitespace */
  *accept(byte: number): Scan<boolean> {
    yield* this.skipWhitespace();
    if ((yield* this.peek()) !== byte) return false;
    this.position++;
    return true;
  }

  *atEnd(): Scan<boolean> {
    yield* this.skipWhitespace();
    return this.position >= this.chunk.length && !(yield* this.fill());
  }

  /** Scans one JSON value and returns its exact bytes, failing once they exceed `limit` */
  *value(limit: number): Scan<Uint8Array> {
    yield* this.skipWhitespace();
    const first = yield* this.peek();
    this.captured = [];
    this.capturedBytes = 0;
    this.captureLimit = limit;
    let depth = 0;
    let inString = false;
    let escaped = false;
    const nested = first === OPEN_OBJECT || first === OPEN_ARRAY;
    const string = first === QUOTE;
    let started = false;
    let start = this.position;
    for (;;) {
      while (this.position < this.chunk.length) {
        const byte = this.chunk[this.position]!;
        if (!started) {
          started = true;
          this.position++;
          if (nested) depth = 1;
          else if (string) inString = true;
          continue;
        }
        if (inString) {
          this.position++;
          if (escaped) escaped = false;
          else if (byte === BACKSLASH) escaped = true;
          else if (byte === QUOTE) {
            inString = false;
            if (string) return this.finish(start);
          }
          continue;
        }
        if (!nested && !string) {
          if (isDelimiter(byte)) return this.finish(start);
          this.position++;
          continue;
        }
        this.position++;
        if (byte === QUOTE) inString = true;
        else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) depth++;
        else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
          depth--;
          if (depth === 0) return this.finish(start);
        }
      }
      this.keep(this.position, start);
      // every value sits inside the top-level object, so a body ending inside one is truncated
      if (!(yield* this.fill())) throw failure("invalid");
      start = 0;
    }
  }

  private finish(start: number): Uint8Array {
    this.keep(this.position, start);
    const parts = this.captured;
    this.captured = [];
    const bytes = new Uint8Array(this.capturedBytes);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }
}

// a byte order mark is kept, so JSON.parse rejects it inside a value exactly as it would inside the whole body
const decoder = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});

const parseBytes = (bytes: Uint8Array): unknown => {
  try {return JSON.parse(decoder.decode(bytes)) as unknown;}
  catch {throw failure("invalid");}
};

const MAX_KEY_BYTES = 4096;

function* readKey(cursor: ByteCursor): Scan<{key: string; bytes: number}> {
  yield* cursor.skipWhitespace();
  if ((yield* cursor.peek()) !== QUOTE) throw failure("invalid");
  let raw: Uint8Array;
  // a key no native snapshot uses is malformed input, not a byte budget overflow worth memoizing
  try {raw = yield* cursor.value(MAX_KEY_BYTES);}
  catch (error) {
    if (error instanceof ProjectionStreamError && error.code === "retained_too_large") throw failure("invalid");
    throw error;
  }
  const key = parseBytes(raw);
  if (typeof key !== "string") throw failure("invalid");
  yield* cursor.expect(COLON);
  return {key, bytes: raw.byteLength};
}

// an own data property, as JSON.parse creates, even for a key such as __proto__
const defineOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {value, writable: true, enumerable: true, configurable: true});
};

/** Reads `{...}` key by key; a repeated key is rejected rather than silently replaced */
function* readObject(cursor: ByteCursor, onKey: (key: string, keyBytes: number) => Scan<void>): Scan<void> {
  yield* cursor.expect(OPEN_OBJECT);
  if (yield* cursor.accept(CLOSE_OBJECT)) return;
  const seen = new Set<string>();
  for (;;) {
    const {key, bytes} = yield* readKey(cursor);
    if (seen.has(key)) throw failure("invalid");
    seen.add(key);
    yield* onKey(key, bytes);
    if (yield* cursor.accept(COMMA)) continue;
    yield* cursor.expect(CLOSE_OBJECT);
    return;
  }
}

// every retained value is parsed by JSON.parse from its exact bytes, so the result equals what parsing the whole body
// would give, minus the skipped unread arrays
function* scanSnapshot(cursor: ByteCursor, retainedBytes: number): Scan<Record<string, unknown>> {
  let retained = 0;
  const remaining = (): number => retainedBytes - retained;
  const charge = (bytes: number): void => {
    retained += bytes;
    if (retained > retainedBytes) throw failure("retained_too_large");
  };
  const retain = (bytes: Uint8Array): unknown => {
    retained += bytes.byteLength;
    if (retained > retainedBytes) throw failure("retained_too_large");
    return parseBytes(bytes);
  };
  const snapshot: Record<string, unknown> = {};
  yield* readObject(cursor, function*(key, keyBytes) {
    charge(keyBytes);
    if (key !== "projection") {
      defineOwn(snapshot, key, retain(yield* cursor.value(remaining())));
      return;
    }
    const projection: Record<string, unknown> = {};
    const messageText = new Map<string, string>();
    yield* readObject(cursor, function*(field, fieldBytes) {
      // an unread array is still parsed element by element, so a body JSON.parse would reject is rejected; nothing is retained
      const unread = UNREAD_PROJECTION_KEYS.has(field);
      if (!unread) charge(fieldBytes);
      yield* cursor.skipWhitespace();
      if ((yield* cursor.peek()) !== OPEN_ARRAY) {
        if (unread) parseBytes(yield* cursor.value(retainedBytes));
        else defineOwn(projection, field, retain(yield* cursor.value(remaining())));
        return;
      }
      yield* cursor.expect(OPEN_ARRAY);
      const values: unknown[] = [];
      if (!unread) defineOwn(projection, field, values);
      if (yield* cursor.accept(CLOSE_ARRAY)) return;
      for (;;) {
        if (unread) {
          parseBytes(yield* cursor.value(retainedBytes));
          if (yield* cursor.accept(COMMA)) continue;
          yield* cursor.expect(CLOSE_ARRAY);
          return;
        }
        // one record may transiently exceed what remains, because a shared text is not retained twice
        const raw = yield* cursor.value(retainedBytes);
        const element = parseBytes(raw);
        let charged = raw.byteLength;
        if (field === "messages" && record(element) && typeof element.id === "string" && typeof element.text === "string")
          messageText.set(element.id, element.text);
        if (field === "turnItems" && record(element) && (element.type === "user_message" || element.type === "assistant_message") &&
          typeof element.messageId === "string" && typeof element.text === "string") {
          const shared = messageText.get(element.messageId);
          if (shared !== undefined && shared === element.text) {
            element.text = shared;
            charged -= Buffer.byteLength(shared, "utf8");
          }
        }
        retained += charged;
        if (retained > retainedBytes) throw failure("retained_too_large");
        values.push(element);
        if (yield* cursor.accept(COMMA)) continue;
        yield* cursor.expect(CLOSE_ARRAY);
        return;
      }
    });
    defineOwn(snapshot, "projection", projection);
  });
  if (!(yield* cursor.atEnd())) throw failure("invalid");
  return snapshot;
}

// reads a complete thread snapshot body: a web stream, or an effect byte stream whose own failures pass through unchanged;
// interrupting the read cancels the body and publishes nothing
export const readProjectionSnapshot = <E = never>(body: ReadableStream<Uint8Array> | Stream.Stream<Uint8Array, E>,
  budget: ProjectionStreamBudget): Effect.Effect<Record<string, unknown>, ProjectionStreamError | E> =>
  Effect.scoped(Effect.gen(function*() {
    const bytes: Stream.Stream<Uint8Array, ProjectionStreamError | E> = Stream.isStream(body) ? body : Stream.fromReadableStream({
      evaluate: () => body,
      // a body the connection stopped delivering is unreadable, not malformed
      onError: () => failure("unreadable"),
    });
    const pull = yield* Stream.toPull(bytes);
    const now = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos) / 1_000_000);
    // fails once past the deadline; checked between slices and before publishing
    const check = Effect.gen(function*() {
      if ((yield* now) > budget.deadline) return yield* Effect.fail(failure("timed_out"));
    });
    let yieldedAt = yield* now;
    let chunks: ReadonlyArray<Uint8Array> = [];
    let pending: Uint8Array = new Uint8Array(0);
    let pendingOffset = 0;
    let transferred = 0;
    let ended = false;
    const nextSlice = Effect.gen(function*() {
      yield* check;
      if ((yield* now) - yieldedAt >= YIELD_INTERVAL_MS) {
        yield* Effect.yieldNow;
        yieldedAt = yield* now;
        yield* check;
      }
      if (pendingOffset >= pending.byteLength) {
        if (chunks.length === 0) {
          if (ended) return undefined;
          const next = yield* Pull.catchDone(pull, () => Effect.succeed(undefined));
          if (next === undefined) {
            ended = true;
            return undefined;
          }
          chunks = next;
        }
        pending = chunks[0]!;
        chunks = chunks.slice(1);
        pendingOffset = 0;
        transferred += pending.byteLength;
        if (transferred > budget.transferBytes) return yield* Effect.fail(failure("transfer_too_large"));
      }
      const slice = pending.subarray(pendingOffset, pendingOffset + SCAN_SLICE_BYTES);
      pendingOffset += slice.byteLength;
      return slice;
    });
    const scan = scanSnapshot(new ByteCursor(), budget.retainedBytes);
    const advance = (slice: Uint8Array | undefined) => Effect.suspend(() => {
      try {return Effect.succeed(scan.next(slice));}
      catch (error) {return error instanceof ProjectionStreamError ? Effect.fail(error) : Effect.die(error);}
    });
    let step = yield* advance(undefined);
    while (step.done !== true) step = yield* advance(yield* nextSlice);
    // the read that reported the end already checked; publishing stays explicitly gated all the same
    yield* check;
    return step.value;
  }));
