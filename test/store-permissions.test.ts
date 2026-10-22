import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, PlatformError } from "effect";
import { CatalogDb, catalogDbLayer } from "../src/db.js";
import { Store } from "../src/store.js";

// A-R12-CAT-01: a write whose permission restoration fails reports the failure and leaves no committed state (the
// baseline restored the modes inside the transaction and rolled back); the fault is injected into the Effect FileSystem
// only after the layers were acquired, as the reviewer's probe did

const event = (id: string, sequence: number) => ({
  stream: "active" as const,
  item: { kind: "thread.updated", sequence, thread: { id, title: "private title", projectId: null, lineage: { parentThreadId: null, relationshipToParent: null } } },
});

it.live("a failed permission restoration fails ingest and activation without advancing rows, revisions or cursors", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = join(yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-store-permissions-" }), "data");
  let armed = false;
  const chmodCalls: string[] = [];
  const faulty = FileSystem.FileSystem.of({
    ...fs,
    chmod: (path, mode) => {
      chmodCalls.push(path);
      return armed
        ? Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "chmod", pathOrDescriptor: path }))
        : fs.chmod(path, mode);
    },
  });
  const observed = yield* Effect.gen(function* () {
    const store = yield* Store;
    const db = yield* CatalogDb;
    const state = Effect.gen(function* () {
      return {
        cursor: yield* store.cursor("active"),
        threads: (yield* db`SELECT id FROM threads`).length,
        revisions: (yield* db`SELECT thread_id FROM thread_revisions`).length,
        activations: (yield* db`SELECT activated_at FROM activations`).length,
        bindings: (yield* db`SELECT environment_id FROM environment_binding`).length,
      };
    });
    const before = yield* state;

    armed = true;
    chmodCalls.length = 0;
    const activate = yield* Effect.exit(store.activate("fixture-environment", 100));
    const ingest = yield* Effect.exit(store.ingest(event("private-thread", 1)));
    const failedAttempts = chmodCalls.length;
    armed = false;
    const afterFailure = yield* state;

    // the same writes succeed once the permissions can be restored, so the failures above were the permission fault
    yield* store.activate("fixture-environment", 100);
    yield* store.ingest(event("private-thread", 1));
    const afterSuccess = yield* state;
    return { before, ingestFailed: Exit.isFailure(ingest), activateFailed: Exit.isFailure(activate), failedAttempts, afterFailure, afterSuccess };
  }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(catalogDbLayer(directory)))), Effect.provideService(FileSystem.FileSystem, faulty));

  assert.deepEqual(observed.before, { cursor: 0, threads: 0, revisions: 0, activations: 0, bindings: 0 });
  assert.equal(observed.ingestFailed, true);
  assert.equal(observed.activateFailed, true);
  assert.ok(observed.failedAttempts > 0, "the fault was reached");
  assert.deepEqual(observed.afterFailure, observed.before);
  assert.deepEqual(observed.afterSuccess, { cursor: 1, threads: 1, revisions: 1, activations: 1, bindings: 1 });
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });
