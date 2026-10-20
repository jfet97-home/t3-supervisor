import assert from "node:assert/strict";
import { test } from "node:test";
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

const budget = {retainedBytes: 1 << 20, transferBytes: 4 << 20};

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

test("a streamed snapshot equals JSON.parse of the whole body minus unread arrays, for every chunk split", async () => {
  const body = snapshotBody();
  const bytes = encoder.encode(JSON.stringify(body));
  const expected = expectedView(JSON.parse(JSON.stringify(body)) as ReturnType<typeof snapshotBody>);
  for (let cut = 1; cut < bytes.length; cut++) {
    const result = await readProjectionSnapshot(streamOf(bytes, [cut, cut + 1, cut + 7]), budget, AbortSignal.timeout(5000));
    assert.deepEqual(result, expected, `split at ${cut}`);
  }
  // pretty-printed JSON with whitespace everywhere parses identically
  const pretty = encoder.encode(JSON.stringify(body, null, 2));
  assert.deepEqual(await readProjectionSnapshot(streamOf(pretty, [1, 2, 3]), budget, AbortSignal.timeout(5000)), expected);
});

test("a user or assistant turn item shares its message text only when the value is identical", async () => {
  const result = await readProjectionSnapshot(streamOf(encoder.encode(JSON.stringify(snapshotBody()))), budget, AbortSignal.timeout(5000));
  const projection = result.projection as {messages: Array<{text: string}>; turnItems: Array<{text?: string}>};
  assert.equal(projection.turnItems[0]!.text, projection.messages[0]!.text);
  assert.equal(projection.turnItems[1]!.text, "a different text", "a differing turn item text is kept as sent");
});

test("unread arrays do not count toward the retained budget, but retained records do", async () => {
  const body = snapshotBody();
  // many small unread rows: their total far exceeds the retained budget, while each stays within the per-record bound
  body.projection.plans = [{id: "plan", markdown: "x".repeat(200)}];
  body.projection.visibleTurnItems = Array.from({length: 4000}, (_, index) => ({position: index, visibility: "local",
    sourceThreadId: "main", sourceItemId: `v${index}`, item: {id: `v${index}`, text: "z".repeat(200)}}));
  const bytes = encoder.encode(JSON.stringify(body));
  assert.ok(bytes.length > 800_000);
  const retainedOnly = encoder.encode(JSON.stringify(expectedView(body))).length;
  const result = await readProjectionSnapshot(streamOf(bytes, [4096, 65_536]), {retainedBytes: retainedOnly + 64, transferBytes: bytes.length},
    AbortSignal.timeout(5000));
  assert.deepEqual(result, expectedView(JSON.parse(JSON.stringify(body)) as ReturnType<typeof snapshotBody>));
  await assert.rejects(readProjectionSnapshot(streamOf(bytes), {retainedBytes: 500, transferBytes: bytes.length}, AbortSignal.timeout(5000)),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "retained_too_large");
  await assert.rejects(readProjectionSnapshot(streamOf(bytes, [4096]), {retainedBytes: bytes.length, transferBytes: bytes.length - 1},
    AbortSignal.timeout(5000)), (error: unknown) => error instanceof ProjectionStreamError && error.code === "transfer_too_large");
});

test("only keys directly under the projection are unread; the same names inside retained records survive", async () => {
  const body = snapshotBody();
  (body.projection.thread as Record<string, unknown>).visibleTurnItems = ["kept inside the thread row"];
  (body.projection.turnItems[2]!.input as Record<string, unknown>).plans = {checkpoints: [1]};
  body.projection.messages[1]!.text = 'escaped "visibleTurnItems":[ and \\"plans\\": inside text';
  const bytes = encoder.encode(JSON.stringify(body));
  const expected = expectedView(JSON.parse(JSON.stringify(body)) as ReturnType<typeof snapshotBody>);
  const at = JSON.stringify(body).indexOf("escaped");
  for (const cut of [at + 9, at + 10, at + 25, at + 30]) {
    assert.deepEqual(await readProjectionSnapshot(streamOf(bytes, [cut]), budget, AbortSignal.timeout(5000)), expected, `split at ${cut}`);
  }
});

test("truncated, trailing, duplicated or malformed bodies fail as invalid", async () => {
  const text = JSON.stringify(snapshotBody());
  const invalid = async (value: string, label: string) => assert.rejects(
    readProjectionSnapshot(streamOf(encoder.encode(value), [3, 50]), budget, AbortSignal.timeout(5000)),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "invalid", label);
  const insideUnread = text.indexOf('"visibleTurnItems"') + 40;
  for (const end of [1, 40, Math.floor(text.length / 2), insideUnread, text.length - 1]) await invalid(text.slice(0, end), `truncated at ${end}`);
  await invalid(text.replace('"messages":[', '"messages":[],"messages":['), "a duplicated messages key");
  await invalid(`${text} x`, "trailing data");
  await invalid(`${text}{}`, "a second document");
  await invalid(text.replace('"snapshotSequence":17', '"snapshotSequence":17,"snapshotSequence":18'), "a duplicated top-level key");
  await invalid(text.replace('"runs":[', '"runs":[],"runs":['), "a duplicated projection key");
  await invalid(text.replace('"ordinal":1,', '"ordinal":01,'), "a malformed number");
  await invalid(text.replace('"plans":[{"id":"plan"', '"plans":[{"id":'), "a malformed unread value");
  await invalid(text.replace('"checkpoints":[{', '"checkpoints":[{"files":[1,],'), "a trailing comma inside an unread value");
  await invalid("[]", "a non-object document");
  // invalid UTF-8 inside a retained string
  const bytes = encoder.encode(text);
  const index = text.indexOf("Main") + 1;
  const broken = new Uint8Array(bytes);
  broken[index] = 0xff;
  await assert.rejects(readProjectionSnapshot(streamOf(broken), budget, AbortSignal.timeout(5000)),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "invalid");
});

test("an aborted read stops with interrupted and keeps no partial result", async () => {
  const controller = new AbortController();
  let pulls = 0;
  const bytes = encoder.encode(JSON.stringify(snapshotBody()));
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      pulls++;
      if (pulls === 2) controller.abort();
      stream.enqueue(bytes.slice((pulls - 1) * 64, pulls * 64));
      if (pulls * 64 >= bytes.length) stream.close();
    },
  });
  await assert.rejects(readProjectionSnapshot(body, budget, controller.signal),
    (error: unknown) => error instanceof ProjectionStreamError && error.code === "interrupted");
});
