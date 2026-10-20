/**
 * Streams the complete native thread snapshot and keeps exactly the projection the Supervisor reads. Arrays it never
 * reads are skipped while streaming, and a user or assistant turn item whose text equals its message's text shares
 * that one string. Retained bytes, total bytes read and cancellation are bounded separately, so a response larger than
 * the retained budget can still yield the same complete projection a full read would, and any exceeded budget fails.
 */

/** Projection arrays no Supervisor code reads; they are validated while streaming and never retained. */
export const UNREAD_PROJECTION_KEYS: ReadonlySet<string> = new Set(["visibleTurnItems", "plans", "checkpointScopes",
  "checkpoints", "contextHandoffs", "contextTransfers", "providerSessions"]);

export type ProjectionStreamFailure = "retained_too_large" | "transfer_too_large" | "invalid" | "unreadable" | "interrupted" |
  "timed_out";

export class ProjectionStreamError extends Error {
  readonly _tag = "ProjectionStreamError";
  constructor(readonly code: ProjectionStreamFailure) {
    super(`T3 thread projection stream failed: ${code}`);
    this.name = "ProjectionStreamError";
  }
}

export interface ProjectionStreamBudget {
  /** UTF-8 bytes of retained records, a string shared by a turn item and its message counted once */
  retainedBytes: number;
  /** Bytes read from the response body after any content decoding, retained or skipped */
  transferBytes: number;
  /** Monotonic time, in `now()` milliseconds, after which the read fails as timed out */
  deadline: number;
  now?: () => number;
}

// immediately available chunks never return to the event loop on their own, so timers and aborts would starve
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

// structural JSON bytes are ASCII and UTF-8 continuation bytes are >= 0x80, so scanning bytes never splits a value
class ByteCursor {
  private chunk: Uint8Array = new Uint8Array(0);
  private position = 0;
  private pending: Uint8Array = new Uint8Array(0);
  private pendingOffset = 0;
  private transferred = 0;
  private captured: Uint8Array[] = [];
  private capturedBytes = 0;
  private captureLimit = 0;

  private yieldedAt: number;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>, private readonly transferLimit: number,
    private readonly signal: AbortSignal, private readonly deadline: number, private readonly now: () => number) {
    this.yieldedAt = now();
  }

  /** Fails once cancelled or past the deadline; called between slices and before publishing */
  check(): void {
    if (this.signal.aborted) throw new ProjectionStreamError("interrupted");
    if (this.now() > this.deadline) throw new ProjectionStreamError("timed_out");
  }

  private async fill(): Promise<boolean> {
    this.check();
    if (this.now() - this.yieldedAt >= YIELD_INTERVAL_MS) {
      await new Promise<void>(resolve => setImmediate(resolve));
      this.yieldedAt = this.now();
      this.check();
    }
    if (this.pendingOffset >= this.pending.byteLength) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {result = await this.reader.read();}
      // a body the connection stopped delivering is unreadable, not malformed
      catch {throw new ProjectionStreamError(this.signal.aborted ? "interrupted" : "unreadable");}
      if (result.done) return false;
      this.transferred += result.value.byteLength;
      if (this.transferred > this.transferLimit) throw new ProjectionStreamError("transfer_too_large");
      this.pending = result.value;
      this.pendingOffset = 0;
    }
    this.chunk = this.pending.subarray(this.pendingOffset, this.pendingOffset + SCAN_SLICE_BYTES);
    this.pendingOffset += this.chunk.byteLength;
    this.position = 0;
    return true;
  }

  private keep(end: number, start: number): void {
    if (end <= start) return;
    this.capturedBytes += end - start;
    if (this.capturedBytes > this.captureLimit) throw new ProjectionStreamError("retained_too_large");
    this.captured.push(this.chunk.slice(start, end));
  }

  async peek(): Promise<number> {
    while (this.position >= this.chunk.length) if (!await this.fill()) throw new ProjectionStreamError("invalid");
    return this.chunk[this.position]!;
  }

  async skipWhitespace(): Promise<void> {
    for (;;) {
      while (this.position < this.chunk.length) {
        if (!isWhitespace(this.chunk[this.position]!)) return;
        this.position++;
      }
      if (!await this.fill()) return;
    }
  }

  async expect(byte: number): Promise<void> {
    await this.skipWhitespace();
    if (await this.peek() !== byte) throw new ProjectionStreamError("invalid");
    this.position++;
  }

  /** Consumes `byte` if it is next, after whitespace */
  async accept(byte: number): Promise<boolean> {
    await this.skipWhitespace();
    if (await this.peek() !== byte) return false;
    this.position++;
    return true;
  }

  async atEnd(): Promise<boolean> {
    await this.skipWhitespace();
    return this.position >= this.chunk.length && !await this.fill();
  }

  /** Scans one JSON value and returns its exact bytes, failing once they exceed `limit` */
  async value(limit: number): Promise<Uint8Array> {
    await this.skipWhitespace();
    const first = await this.peek();
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
      if (!await this.fill()) throw new ProjectionStreamError("invalid");
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
  catch {throw new ProjectionStreamError("invalid");}
};

const MAX_KEY_BYTES = 4096;

const readKey = async (cursor: ByteCursor): Promise<{key: string; bytes: number}> => {
  await cursor.skipWhitespace();
  if (await cursor.peek() !== QUOTE) throw new ProjectionStreamError("invalid");
  let raw: Uint8Array;
  // a key no native snapshot uses is malformed input, not a byte budget overflow worth memoizing
  try {raw = await cursor.value(MAX_KEY_BYTES);}
  catch (error) {
    if (error instanceof ProjectionStreamError && error.code === "retained_too_large") throw new ProjectionStreamError("invalid");
    throw error;
  }
  const key = parseBytes(raw);
  if (typeof key !== "string") throw new ProjectionStreamError("invalid");
  await cursor.expect(COLON);
  return {key, bytes: raw.byteLength};
};

// an own data property, as JSON.parse creates, even for a key such as __proto__
const defineOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {value, writable: true, enumerable: true, configurable: true});
};

/** Reads `{...}` key by key; a repeated key is rejected rather than silently replaced */
const readObject = async (cursor: ByteCursor, onKey: (key: string, keyBytes: number) => Promise<void>): Promise<void> => {
  await cursor.expect(OPEN_OBJECT);
  if (await cursor.accept(CLOSE_OBJECT)) return;
  const seen = new Set<string>();
  for (;;) {
    const {key, bytes} = await readKey(cursor);
    if (seen.has(key)) throw new ProjectionStreamError("invalid");
    seen.add(key);
    await onKey(key, bytes);
    if (await cursor.accept(COMMA)) continue;
    await cursor.expect(CLOSE_OBJECT);
    return;
  }
};

/**
 * Reads a complete thread snapshot body. Every retained value is parsed by JSON.parse from its exact bytes, so the
 * result equals what parsing the whole body would give, minus the skipped unread arrays.
 */
export const readProjectionSnapshot = async (body: ReadableStream<Uint8Array>, budget: ProjectionStreamBudget,
  signal: AbortSignal): Promise<Record<string, unknown>> => {
  const reader = body.getReader();
  const cursor = new ByteCursor(reader, budget.transferBytes, signal, budget.deadline, budget.now ?? (() => performance.now()));
  let retained = 0;
  const remaining = (): number => budget.retainedBytes - retained;
  const charge = (bytes: number): void => {
    retained += bytes;
    if (retained > budget.retainedBytes) throw new ProjectionStreamError("retained_too_large");
  };
  const retain = (bytes: Uint8Array): unknown => {
    retained += bytes.byteLength;
    if (retained > budget.retainedBytes) throw new ProjectionStreamError("retained_too_large");
    return parseBytes(bytes);
  };
  const snapshot: Record<string, unknown> = {};
  try {
    await readObject(cursor, async (key, keyBytes) => {
      charge(keyBytes);
      if (key !== "projection") {
        defineOwn(snapshot, key, retain(await cursor.value(remaining())));
        return;
      }
      const projection: Record<string, unknown> = {};
      const messageText = new Map<string, string>();
      await readObject(cursor, async (field, fieldBytes) => {
        // an unread array is still parsed element by element, so a body JSON.parse would reject is rejected; nothing is retained
        const unread = UNREAD_PROJECTION_KEYS.has(field);
        if (!unread) charge(fieldBytes);
        await cursor.skipWhitespace();
        if (await cursor.peek() !== OPEN_ARRAY) {
          if (unread) parseBytes(await cursor.value(budget.retainedBytes));
          else defineOwn(projection, field, retain(await cursor.value(remaining())));
          return;
        }
        await cursor.expect(OPEN_ARRAY);
        const values: unknown[] = [];
        if (!unread) defineOwn(projection, field, values);
        if (await cursor.accept(CLOSE_ARRAY)) return;
        for (;;) {
          if (unread) {
            parseBytes(await cursor.value(budget.retainedBytes));
            if (await cursor.accept(COMMA)) continue;
            await cursor.expect(CLOSE_ARRAY);
            return;
          }
          // one record may transiently exceed what remains, because a shared text is not retained twice
          const raw = await cursor.value(budget.retainedBytes);
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
          if (retained > budget.retainedBytes) throw new ProjectionStreamError("retained_too_large");
          values.push(element);
          if (await cursor.accept(COMMA)) continue;
          await cursor.expect(CLOSE_ARRAY);
          return;
        }
      });
      defineOwn(snapshot, "projection", projection);
    });
    if (!await cursor.atEnd()) throw new ProjectionStreamError("invalid");
    // the read that reported the end already checked; publishing stays explicitly gated all the same
    cursor.check();
    return snapshot;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
};
