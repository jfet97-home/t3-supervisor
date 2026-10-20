/**
 * Streams the complete native thread snapshot and keeps exactly the projection the Supervisor reads. Arrays it never
 * reads are skipped while streaming, and a user or assistant turn item whose text equals its message's text shares
 * that one string. Retained bytes, total bytes read and cancellation are bounded separately, so a response larger than
 * the retained budget can still yield the same complete projection a full read would, and any exceeded budget fails.
 */

/** Projection arrays no Supervisor code reads; they are validated while streaming and never retained. */
export const UNREAD_PROJECTION_KEYS: ReadonlySet<string> = new Set(["visibleTurnItems", "plans", "checkpointScopes",
  "checkpoints", "contextHandoffs", "contextTransfers", "providerSessions"]);

export type ProjectionStreamFailure = "retained_too_large" | "transfer_too_large" | "invalid" | "interrupted";

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
  /** bytes read from the response body, retained or skipped */
  transferBytes: number;
}

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
  private transferred = 0;
  private captured: Uint8Array[] | null = null;
  private capturedBytes = 0;
  private captureLimit = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>, private readonly transferLimit: number,
    private readonly signal: AbortSignal) {}

  private async fill(): Promise<boolean> {
    if (this.signal.aborted) throw new ProjectionStreamError("interrupted");
    let result: ReadableStreamReadResult<Uint8Array>;
    try {result = await this.reader.read();}
    catch {throw new ProjectionStreamError(this.signal.aborted ? "interrupted" : "invalid");}
    if (result.done) return false;
    this.transferred += result.value.byteLength;
    if (this.transferred > this.transferLimit) throw new ProjectionStreamError("transfer_too_large");
    this.chunk = result.value;
    this.position = 0;
    return true;
  }

  private keep(end: number, start: number): void {
    if (this.captured === null || end <= start) return;
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

  /** consumes `byte` if it is next, after whitespace */
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

  /** scans one JSON value; returns its exact bytes when `limit` is given, otherwise skips it */
  async value(limit?: number): Promise<Uint8Array | null> {
    await this.skipWhitespace();
    const first = await this.peek();
    this.captured = limit === undefined ? null : [];
    this.capturedBytes = 0;
    this.captureLimit = limit ?? 0;
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

  private finish(start: number): Uint8Array | null {
    this.keep(this.position, start);
    const parts = this.captured;
    this.captured = null;
    if (parts === null) return null;
    const bytes = new Uint8Array(this.capturedBytes);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }
}

const decoder = new TextDecoder("utf-8", {fatal: true});

const parseBytes = (bytes: Uint8Array | null): unknown => {
  if (bytes === null) throw new ProjectionStreamError("invalid");
  try {return JSON.parse(decoder.decode(bytes)) as unknown;}
  catch {throw new ProjectionStreamError("invalid");}
};

const readKey = async (cursor: ByteCursor): Promise<string> => {
  await cursor.skipWhitespace();
  if (await cursor.peek() !== QUOTE) throw new ProjectionStreamError("invalid");
  const key = parseBytes(await cursor.value(4096));
  if (typeof key !== "string") throw new ProjectionStreamError("invalid");
  await cursor.expect(COLON);
  return key;
};

/** reads `{...}` key by key; a repeated key is rejected rather than silently replaced */
const readObject = async (cursor: ByteCursor, onKey: (key: string) => Promise<void>): Promise<void> => {
  await cursor.expect(OPEN_OBJECT);
  if (await cursor.accept(CLOSE_OBJECT)) return;
  const seen = new Set<string>();
  for (;;) {
    const key = await readKey(cursor);
    if (seen.has(key)) throw new ProjectionStreamError("invalid");
    seen.add(key);
    await onKey(key);
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
  const cursor = new ByteCursor(reader, budget.transferBytes, signal);
  let retained = 0;
  const remaining = (): number => budget.retainedBytes - retained;
  const retain = (bytes: Uint8Array | null): unknown => {
    retained += bytes?.byteLength ?? 0;
    if (retained > budget.retainedBytes) throw new ProjectionStreamError("retained_too_large");
    return parseBytes(bytes);
  };
  const snapshot: Record<string, unknown> = {};
  try {
    await readObject(cursor, async (key) => {
      if (key !== "projection") {
        snapshot[key] = retain(await cursor.value(remaining()));
        return;
      }
      const projection: Record<string, unknown> = {};
      const messageText = new Map<string, string>();
      await readObject(cursor, async (field) => {
        // an unread array is still parsed element by element, so a body JSON.parse would reject is rejected; nothing is retained
        const unread = UNREAD_PROJECTION_KEYS.has(field);
        await cursor.skipWhitespace();
        if (await cursor.peek() !== OPEN_ARRAY) {
          if (unread) parseBytes(await cursor.value(budget.retainedBytes));
          else projection[field] = retain(await cursor.value(remaining()));
          return;
        }
        await cursor.expect(OPEN_ARRAY);
        const values: unknown[] = [];
        if (!unread) projection[field] = values;
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
          let charged = raw?.byteLength ?? 0;
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
      snapshot.projection = projection;
    });
    if (!await cursor.atEnd()) throw new ProjectionStreamError("invalid");
    // a deadline that expired during the last synchronous parse still publishes nothing
    if (signal.aborted) throw new ProjectionStreamError("interrupted");
    return snapshot;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
};
