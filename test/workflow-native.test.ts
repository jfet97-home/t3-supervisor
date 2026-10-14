import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { readSupervisorThreads, SupervisorRpcError } from "../src/supervisor-native.js";
import type { ThreadInfo } from "../src/types.js";

const thread = (id: string, parentThreadId: string | null = null): ThreadInfo => ({
  id, title: id, projectId: "project-a", latestRunId: null,
  lineage: {parentThreadId, relationshipToParent: parentThreadId ? "subagent" : null},
});

test("workflow native inventory retries inconsistent views and retains archived ancestry", async t => {
  let activeReads = 0;
  let archiveReads = 0;
  const active = thread("main-a");
  const archived = {...thread("child-a", active.id), archivedAt: "2026-10-14T20:00:00.000Z"};
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/orchestration/shell");
    assert.equal(request.headers["x-t3-orchestration-protocol"], "2");
    activeReads++;
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({schemaVersion: 2, snapshotSequence: activeReads, threads: [active], archivedThreads: []}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => {server.close(() => resolve()); server.closeAllConnections();}));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const read = readSupervisorThreads(`http://127.0.0.1:${address.port}`, "fixture-token", async tag => {
    assert.equal(tag, "orchestration.getArchivedShellSnapshot");
    archiveReads++;
    return {schemaVersion: 2, snapshotSequence: archiveReads === 1 ? 0 : 2, threads: [archived]};
  });
  assert.deepEqual(await read(AbortSignal.timeout(5000)), [active, archived]);
  assert.equal(activeReads, 2);
  assert.equal(archiveReads, 2);
});

test("workflow native inventory rejects malformed lineage and never merges overlapping views", async t => {
  const active = thread("main-a");
  const server = createServer((_request, response) => {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({schemaVersion: 2, snapshotSequence: 5, threads: [active], archivedThreads: []}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => {server.close(() => resolve()); server.closeAllConnections();}));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let reads = 0;
  const overlap = readSupervisorThreads(baseUrl, "fixture-token", async () => {
    reads++;
    return {schemaVersion: 2, snapshotSequence: 5, threads: [active]};
  });
  await assert.rejects(overlap(AbortSignal.timeout(5000)), SupervisorRpcError);
  assert.equal(reads, 3);
  const malformed = readSupervisorThreads(baseUrl, "fixture-token", async () => ({
    schemaVersion: 2, snapshotSequence: 5, threads: [{...thread("child-a"), lineage: {parentThreadId: 1, relationshipToParent: "subagent"}}],
  }));
  await assert.rejects(malformed(AbortSignal.timeout(5000)), SupervisorRpcError);
});
