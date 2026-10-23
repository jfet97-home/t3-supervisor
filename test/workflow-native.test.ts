import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { NativeRpc, NativeShell, SupervisorRpcError } from "../src/supervisor-native.js";
import type { ThreadInfo } from "../src/types.js";

const thread = (id: string, parentThreadId: string | null = null): ThreadInfo => ({
  id, title: id, projectId: "project-a", latestRunId: null,
  lineage: {parentThreadId, relationshipToParent: parentThreadId ? "subagent" : null},
});

const serve = (handler: (request: IncomingMessage, response: ServerResponse) => void) => Effect.acquireRelease(Effect.gen(function* () {
  const server = createServer(handler);
  yield* Effect.callback<void>(resume => {server.listen(0, "127.0.0.1", () => resume(Effect.void));});
  return server;
}), server => Effect.callback<void>(resume => {server.close(() => resume(Effect.void)); server.closeAllConnections();}));

// the archived snapshot rpc a test answers itself
// the archived shell read answered synchronously in the caller's fiber; a throw is a defect, as the read's failure
const archive = (answer: (tag: string) => unknown) => Layer.succeed(NativeRpc, NativeRpc.of({
  call: tag => Effect.sync(() => answer(tag)),
  initiate: () => Effect.die("the shell reads only call"),
}));

const readThreads = (baseUrl: string, archived: Layer.Layer<NativeRpc>) => NativeShell.use(shell => shell.threads).pipe(
  Effect.provide(NativeShell.layer({baseUrl, token: "fixture-token"}).pipe(Layer.provide([archived, FetchHttpClient.layer]))));

// assert.rejects(promise, SupervisorRpcError) for an effect
const rejectsRpc = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.match(effect, {
  onSuccess: () => assert.fail("the effect succeeded"),
  onFailure: cause => assert.ok(cause instanceof SupervisorRpcError),
});

it.live("workflow native inventory retries inconsistent views and retains archived ancestry", () => Effect.gen(function* () {
  let activeReads = 0;
  let archiveReads = 0;
  const active = thread("main-a");
  const archived = {...thread("child-a", active.id), archivedAt: "2026-10-14T20:00:00.000Z"};
  const server = yield* serve((request, response) => {
    assert.equal(request.url, "/api/orchestration/shell");
    assert.equal(request.headers["x-t3-orchestration-protocol"], "2");
    activeReads++;
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({schemaVersion: 2, snapshotSequence: activeReads, threads: [active], archivedThreads: []}));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const read = readThreads(`http://127.0.0.1:${address.port}`, archive(tag => {
    assert.equal(tag, "orchestration.getArchivedShellSnapshot");
    archiveReads++;
    return {schemaVersion: 2, snapshotSequence: archiveReads === 1 ? 0 : 2, threads: [archived]};
  }));
  assert.deepEqual(yield* read.pipe(Effect.timeout("5 seconds")), [active, archived]);
  assert.equal(activeReads, 2);
  assert.equal(archiveReads, 2);
}));

it.live("workflow native inventory rejects malformed lineage and never merges overlapping views", () => Effect.gen(function* () {
  const active = thread("main-a");
  const server = yield* serve((_request, response) => {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({schemaVersion: 2, snapshotSequence: 5, threads: [active], archivedThreads: []}));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let reads = 0;
  const overlap = readThreads(baseUrl, archive(() => {
    reads++;
    return {schemaVersion: 2, snapshotSequence: 5, threads: [active]};
  }));
  yield* rejectsRpc(overlap.pipe(Effect.timeout("5 seconds")));
  assert.equal(reads, 3);
  const malformed = readThreads(baseUrl, archive(() => ({
    schemaVersion: 2, snapshotSequence: 5, threads: [{...thread("child-a"), lineage: {parentThreadId: 1, relationshipToParent: "subagent"}}],
  })));
  yield* rejectsRpc(malformed.pipe(Effect.timeout("5 seconds")));
}));
