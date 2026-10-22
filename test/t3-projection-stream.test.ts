import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Clock, Effect, Exit, Fiber } from "effect";
import { ProjectionStreamError, readProjectionSnapshot, UNREAD_PROJECTION_KEYS } from "../src/t3-projection-stream.js";

const encoder = new TextEncoder();

const streamOf = (bytes: Uint8Array, cuts: readonly number[] = []): ReadableStream<Uint8Array> => {
  const points = [...new Set([0, ...cuts.filter(cut => cut > 0 && cut < bytes.length), bytes.length])].sort((a, b) => a - b);
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= points.length - 1) {controller.close();return;}
      controller.enqueue(bytes.slice(points[index]!, points[index + 1]!));
      index++;
    },
  });
};

const budget = {retainedBytes: 1 << 20, transferBytes: 4 << 20, deadline: Number.POSITIVE_INFINITY};

// the read fails and its failure satisfies the predicate, as assert.rejects checked it
const rejects = <A, E>(effect: Effect.Effect<A, E>, predicate: (error: unknown) => boolean, message?: string): Effect.Effect<void> =>
  Effect.map(Effect.exit(effect), (exit) => {
    assert.ok(Exit.isFailure(exit), message ?? "the read failed");
    assert.ok(predicate(Cause.squash(exit.cause)), message);
  });

// the baseline's 5 s abort signal of every parser test, as a bound on the live clock
const bounded = <A, E>(effect: Effect.Effect<A, E>) => Effect.timeout(effect, "5 seconds");

// a monotonic clock that advances `stepMillis` on every reading, as the counting `now` of the baseline did
const steppingClock = (stepMillis: number): Clock.Clock => {
  let nanos = 0n;
  const monotonicTimeNanosUnsafe = (): bigint => {
    nanos += BigInt(stepMillis) * 1_000_000n;
    return nanos;
  };
  return {
    currentTimeMillisUnsafe: () => Number(monotonicTimeNanosUnsafe() / 1_000_000n),
    currentTimeMillis: Effect.sync(() => Number(monotonicTimeNanosUnsafe() / 1_000_000n)),
    currentTimeNanosUnsafe: monotonicTimeNanosUnsafe,
    currentTimeNanos: Effect.sync(monotonicTimeNanosUnsafe),
    monotonicTimeNanosUnsafe,
    monotonicTimeNanos: Effect.sync(monotonicTimeNanosUnsafe),
    sleep: () => Effect.die("the stepping clock does not sleep"),
  };
};
const withClock = (clock: Clock.Clock) => <A, E>(effect: Effect.Effect<A, E>) => Effect.provideService(effect, Clock.Clock, clock);

const snapshotBody = () => ({
  snapshotSequence: 17,
  projection: {
    thread: {id: "main", title: "Main é中😀", projectId: "p", lineage: {parentThreadId: null, relationshipToParent: null}},
    runs: [{id: "run-1", ordinal: 1, status: "completed", requestedAt: "2026-10-20T10:00:00Z", startedAt: null, completedAt: null, rootNodeId: "n1",
      userMessageId: "m1"}],
    messages: [
      {id: "m1", threadId: "main", runId: "run-1", nodeId: "n1", role: "user", text: "Task with \"quotes\", \\slashes\\, \n newline, é and 😀",
        streaming: false, createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-20T10:00:00Z"},
      {id: "m2", threadId: "main", runId: "run-1", nodeId: "n2", role: "assistant", text: "Reply }] with brackets [{ inside",
        streaming: false, createdAt: "2026-10-20T10:00:01Z", updatedAt: "2026-10-20T10:00:01Z"},
    ],
    plans: [{id: "plan", markdown: "x".repeat(2000)}],
    turnItems: [
      {id: "i1", threadId: "main", runId: "run-1", type: "user_message", messageId: "m1",
        text: "Task with \"quotes\", \\slashes\\, \n newline, é and 😀", ordinal: 1},
      {id: "i2", threadId: "main", runId: "run-1", type: "assistant_message", messageId: "m2", text: "a different text", ordinal: 2},
      {id: "i3", threadId: "main", runId: "run-1", type: "dynamic_tool", toolName: "workflow_write", input: {nested: [1, 2.5e3, -0.25, true, false, null]}, ordinal: 3},
    ],
    checkpoints: [{id: "checkpoint", files: Array.from({length: 50}, (_, index) => `file-${index}`)}],
    visibleTurnItems: [{position: 0, visibility: "local", sourceThreadId: "main", sourceItemId: "i1", item: {id: "i1", text: "y".repeat(3000)}}],
    nodes: [], subagents: [], runtimeRequests: [], updatedAt: "2026-10-20T10:00:02Z",
  },
});

const expectedView = (body: ReturnType<typeof snapshotBody>) => {
  const projection = Object.fromEntries(Object.entries(body.projection).filter(([key]) => !UNREAD_PROJECTION_KEYS.has(key)));
  return {...body, projection};
};

it.live("a streamed snapshot equals JSON.parse of the whole body minus unread arrays, for every chunk split", () => Effect.gen(function*() {
  const body = snapshotBody();
  const bytes = encoder.encode(JSON.stringify(body));
  const expected = expectedView(JSON.parse(JSON.stringify(body)) as ReturnType<typeof snapshotBody>);
  for (let cut = 1; cut < bytes.length; cut++) {
    const result = yield* readProjectionSnapshot(streamOf(bytes, [cut, cut + 1, cut + 7]), budget).pipe(bounded);
    assert.deepEqual(result, expected, `split at ${cut}`);
  }
  // pretty-printed JSON with whitespace everywhere parses identically
  const pretty = encoder.encode(JSON.stringify(body, null, 2));
  assert.deepEqual(yield* readProjectionSnapshot(streamOf(pretty, [1, 2, 3]), budget).pipe(bounded), expected);
}), { timeout: 60_000 });

it.live("a user or assistant turn item shares its message text only when the value is identical", () => Effect.gen(function*() {
  const result = yield* readProjectionSnapshot(streamOf(encoder.encode(JSON.stringify(snapshotBody()))), budget).pipe(bounded);
  const projection = result.projection as {messages: Array<{text: string}>; turnItems: Array<{text?: string}>};
  assert.equal(projection.turnItems[0]!.text, projection.messages[0]!.text);
  assert.equal(projection.turnItems[1]!.text, "a different text", "a differing turn item text is kept as sent");
}));

it.live("unread arrays do not count toward the retained budget, but retained records do", () => Effect.gen(function*() {
  const body = snapshotBody();
  // many small unread rows: their total far exceeds the retained budget, while each stays within the per-record bound
  body.projection.plans = [{id: "plan", markdown: "x".repeat(200)}];
  body.projection.visibleTurnItems = Array.from({length: 4000}, (_, index) => ({position: index, visibility: "local",
    sourceThreadId: "main", sourceItemId: `v${index}`, item: {id: `v${index}`, text: "z".repeat(200)}}));
  const bytes = encoder.encode(JSON.stringify(body));
  assert.ok(bytes.length > 800_000);
  const retainedOnly = encoder.encode(JSON.stringify(expectedView(body))).length;
  const result = yield* readProjectionSnapshot(streamOf(bytes, [4096, 65_536]), {retainedBytes: retainedOnly + 64, transferBytes: bytes.length, deadline: Number.POSITIVE_INFINITY}).pipe(bounded);
  assert.deepEqual(result, expectedView(JSON.parse(JSON.stringify(body)) as ReturnType<typeof snapshotBody>));
  yield* rejects(readProjectionSnapshot(streamOf(bytes), {retainedBytes: 500, transferBytes: bytes.length, deadline: Number.POSITIVE_INFINITY}).pipe(bounded),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "retained_too_large");
  yield* rejects(readProjectionSnapshot(streamOf(bytes, [4096]), {retainedBytes: bytes.length, transferBytes: bytes.length - 1, deadline: Number.POSITIVE_INFINITY}).pipe(bounded), (error: unknown) => error instanceof ProjectionStreamError && error.code === "transfer_too_large");
}), { timeout: 60_000 });

it.live("only keys directly under the projection are unread; the same names inside retained records survive", () => Effect.gen(function*() {
  const body = snapshotBody();
  (body.projection.thread as Record<string, unknown>).visibleTurnItems = ["kept inside the thread row"];
  (body.projection.turnItems[2]!.input as Record<string, unknown>).plans = {checkpoints: [1]};
  body.projection.messages[1]!.text = 'escaped "visibleTurnItems":[ and \\"plans\\": inside text';
  const bytes = encoder.encode(JSON.stringify(body));
  const expected = expectedView(JSON.parse(JSON.stringify(body)) as ReturnType<typeof snapshotBody>);
  const at = JSON.stringify(body).indexOf("escaped");
  for (const cut of [at + 9, at + 10, at + 25, at + 30]) {
    assert.deepEqual(yield* readProjectionSnapshot(streamOf(bytes, [cut]), budget).pipe(bounded), expected, `split at ${cut}`);
  }
}));

it.live("truncated, trailing, duplicated or malformed bodies fail as invalid", () => Effect.gen(function*() {
  const text = JSON.stringify(snapshotBody());
  const invalid = (value: string, label: string) => rejects(
    readProjectionSnapshot(streamOf(encoder.encode(value), [3, 50]), budget).pipe(bounded),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "invalid", label);
  const insideUnread = text.indexOf('"visibleTurnItems"') + 40;
  for (const end of [1, 40, Math.floor(text.length / 2), insideUnread, text.length - 1]) yield* invalid(text.slice(0, end), `truncated at ${end}`);
  yield* invalid(text.replace('"messages":[', '"messages":[],"messages":['), "a duplicated messages key");
  yield* invalid(`${text} x`, "trailing data");
  yield* invalid(`${text}{}`, "a second document");
  yield* invalid(text.replace('"snapshotSequence":17', '"snapshotSequence":17,"snapshotSequence":18'), "a duplicated top-level key");
  yield* invalid(text.replace('"runs":[', '"runs":[],"runs":['), "a duplicated projection key");
  yield* invalid(text.replace('"ordinal":1,', '"ordinal":01,'), "a malformed number");
  yield* invalid(text.replace('"plans":[{"id":"plan"', '"plans":[{"id":'), "a malformed unread value");
  yield* invalid(text.replace('"checkpoints":[{', '"checkpoints":[{"files":[1,],'), "a trailing comma inside an unread value");
  yield* invalid("[]", "a non-object document");
  // invalid UTF-8 inside a retained string
  const bytes = encoder.encode(text);
  const index = text.indexOf("Main") + 1;
  const broken = new Uint8Array(bytes);
  broken[index] = 0xff;
  yield* rejects(readProjectionSnapshot(streamOf(broken), budget).pipe(bounded),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "invalid");
}));

it.live("a __proto__ key in the envelope or projection is an own field, exactly as JSON.parse makes it", () => Effect.gen(function*() {
  const projection = snapshotBody().projection;
  const text = `{"snapshotSequence":3,"__proto__":{"polluted":true},"projection":{"__proto__":{"thread":{"id":"hidden"}},${JSON.stringify(projection).slice(1)}}`;
  const result = yield* readProjectionSnapshot(streamOf(encoder.encode(text), [7, 40]), budget).pipe(bounded);
  const expected = JSON.parse(text) as Record<string, Record<string, unknown>>;
  for (const key of UNREAD_PROJECTION_KEYS) delete expected.projection![key];
  assert.deepEqual(result, expected);
  assert.ok(Object.hasOwn(result, "__proto__") && Object.hasOwn(result.projection as object, "__proto__"));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.projection), Object.prototype);
  // a body whose only projection content sits under __proto__ has no own thread, runs or messages
  const hidden = yield* readProjectionSnapshot(streamOf(encoder.encode(`{"snapshotSequence":1,"projection":{"__proto__":${
    JSON.stringify({thread: projection.thread, runs: [], messages: []})}}}`)), budget).pipe(bounded);
  assert.equal(Object.hasOwn(hidden.projection as object, "thread"), false);
  assert.equal((hidden.projection as Record<string, unknown>).thread, undefined);
}));

it.live("a byte order mark before a retained or unread value is rejected as JSON.parse would", () => Effect.gen(function*() {
  const text = JSON.stringify(snapshotBody());
  for (const [label, value] of [["unread", text.replace('"plans":[', '"plans":[﻿0,')], ["retained", text.replace('"snapshotSequence":17', '"snapshotSequence":﻿17')]] as const) {
    assert.throws(() => JSON.parse(value), SyntaxError);
    yield* rejects(readProjectionSnapshot(streamOf(encoder.encode(value)), budget).pipe(bounded),
      (error: unknown) => error instanceof ProjectionStreamError && error.code === "invalid", label);
  }
}));

it.live("chunks that arrive back to back still meet the deadline and let timers run", () => Effect.gen(function*() {
  const tiny = encoder.encode(`{"snapshotSequence":1,"projection":{"thread":{"id":"t"},"runs":[],"messages":[],"plans":[${Array(200_000).fill("null").join(",")}]}}`);
  const immediate = () => {
    let offset = 0;
    return new ReadableStream<Uint8Array>({pull(controller) {
      if (offset >= tiny.length) {controller.close();return;}
      controller.enqueue(tiny.slice(offset, offset + 4096));
      offset += 4096;
    }});
  };
  yield* rejects(readProjectionSnapshot(immediate(), {...budget, deadline: 50}).pipe(withClock(steppingClock(1)), bounded),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "timed_out");
  // a timer scheduled before a long read fires while the read is still in progress
  let timerFired = false;
  let readFinished = false;
  setTimeout(() => {timerFired = true;}, 0);
  let observedDuringRead = false;
  const probe = setInterval(() => {if (!readFinished && timerFired) observedDuringRead = true;}, 0);
  yield* readProjectionSnapshot(immediate(), budget).pipe(withClock(steppingClock(5)), bounded);
  readFinished = true;
  clearInterval(probe);
  assert.equal(timerFired, true);
  assert.equal(observedDuringRead, true, "the read yields to the event loop between chunks");
}), { timeout: 60_000 });

it.live("sharing an identical text charges it once, which a budget between both sizes proves", () => Effect.gen(function*() {
  const text = "s".repeat(20_000);
  const body = (itemText: string) => encoder.encode(JSON.stringify({snapshotSequence: 1, projection: {thread: {id: "t"}, runs: [],
    messages: [{id: "m", threadId: "t", text}], turnItems: [{id: "i", threadId: "t", type: "user_message", messageId: "m", text: itemText}]}}));
  // the shared form needs about one copy of the text, the unshared form about two
  const limits = {...budget, retainedBytes: 30_000};
  const shared = yield* readProjectionSnapshot(streamOf(body(text)), limits).pipe(bounded);
  const projection = shared.projection as {messages: Array<{text: string}>; turnItems: Array<{text: string}>};
  assert.equal(projection.turnItems[0]!.text, projection.messages[0]!.text);
  yield* rejects(readProjectionSnapshot(streamOf(body(`${text.slice(1)}x`)), limits).pipe(bounded),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "retained_too_large", "a differing text is charged twice");
}));

it.live("retained keys are charged, an oversized key is invalid, and a failing body is unreadable", () => Effect.gen(function*() {
  const keys = Object.fromEntries(Array.from({length: 2000}, (_, index) => [`k${"x".repeat(100)}${index}`, 0]));
  const many = encoder.encode(JSON.stringify({snapshotSequence: 1, projection: {thread: {id: "t"}, runs: [], messages: [], ...keys}}));
  yield* rejects(readProjectionSnapshot(streamOf(many), {...budget, retainedBytes: 100_000}).pipe(bounded),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "retained_too_large", "keys count toward the budget");
  const longKey = encoder.encode(`{"${"k".repeat(5000)}":1,"snapshotSequence":1}`);
  yield* rejects(readProjectionSnapshot(streamOf(longKey), budget).pipe(bounded),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "invalid");
  const bytes = encoder.encode(JSON.stringify(snapshotBody()));
  let pulls = 0;
  const broken = new ReadableStream<Uint8Array>({pull(controller) {
    pulls++;
    if (pulls === 3) {controller.error(new Error("socket closed"));return;}
    controller.enqueue(bytes.slice((pulls - 1) * 64, pulls * 64));
  }});
  yield* rejects(readProjectionSnapshot(broken, budget).pipe(bounded),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "unreadable");
}));

it.live("one huge chunk of tiny values is still scanned in slices that meet the deadline and let timers run", () => Effect.gen(function*() {
  const tiny = encoder.encode(`{"snapshotSequence":1,"projection":{"thread":{"id":"t"},"runs":[],"messages":[],"plans":[${Array(400_000).fill("null").join(",")}]}}`);
  const single = () => new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(tiny);controller.close();}});
  yield* rejects(readProjectionSnapshot(single(), {...budget, deadline: 10}).pipe(withClock(steppingClock(1)), bounded),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "timed_out", "the deadline trips inside one chunk");
  let timerFired = false;
  let firedDuringRead = false;
  let reading = true;
  setTimeout(() => {timerFired = true;if (reading) firedDuringRead = true;}, 0);
  yield* readProjectionSnapshot(single(), budget).pipe(withClock(steppingClock(5)), bounded);
  reading = false;
  assert.equal(timerFired, true);
  assert.equal(firedDuringRead, true, "the read yields to the event loop inside one chunk");
}), { timeout: 60_000 });

it.effect("an abort that lands as the body ends is never published", () => Effect.gen(function*() {
  const bytes = encoder.encode(JSON.stringify(snapshotBody()));
  let sent = false;
  const reading: { fiber?: Fiber.Fiber<unknown, unknown> } = {};
  // a zero high-water mark pulls only on demand, so the interruption coincides with the read that reports the end
  const body = new ReadableStream<Uint8Array>({pull(stream) {
    if (!sent) {sent = true;stream.enqueue(bytes);return;}
    reading.fiber?.interruptUnsafe();
    stream.close();
  }}, new CountQueuingStrategy({highWaterMark: 0}));
  reading.fiber = yield* Effect.forkChild(readProjectionSnapshot(body, budget));
  const exit = yield* Fiber.await(reading.fiber);
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "the interrupted read publishes nothing");
}));

it.effect("an aborted read stops with interrupted and keeps no partial result", () => Effect.gen(function*() {
  let pulls = 0;
  const reading: { fiber?: Fiber.Fiber<unknown, unknown> } = {};
  const bytes = encoder.encode(JSON.stringify(snapshotBody()));
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      pulls++;
      if (pulls === 2) reading.fiber?.interruptUnsafe();
      stream.enqueue(bytes.slice((pulls - 1) * 64, pulls * 64));
      if (pulls * 64 >= bytes.length) stream.close();
    },
  });
  reading.fiber = yield* Effect.forkChild(readProjectionSnapshot(body, budget));
  const exit = yield* Fiber.await(reading.fiber);
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "the interrupted read keeps no partial result");
  assert.ok(pulls * 64 < bytes.length, "the body was interrupted before its end");
}));
