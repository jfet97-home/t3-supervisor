import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import test from "node:test";
import { makeStore, Store, StoreError, type StoreShape } from "../src/store.js";
import type { ProjectInfo, SourceItem, ThreadInfo } from "../src/types.js";

const project = (id = "project-1", title = "Project one", workspaceRoot = "/work/project-one"): ProjectInfo => ({
  id,
  title,
  workspaceRoot,
});

const thread = (id = "thread-1", projectId: string | null = "project-1"): ThreadInfo => ({
  id,
  title: `Conversation ${id}`,
  projectId,
  lineage: {parentThreadId: null, relationshipToParent: null},
  archivedAt: null,
});

const sourceItem = (stream: SourceItem["stream"], item: Record<string, unknown>): SourceItem => ({stream, item});

const withStore = <A>(directory: string, use: (store: StoreShape) => Effect.Effect<A, StoreError>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(Store.use(use), makeStore(directory))));

const withTemporaryDirectory = async <A>(run: (directory: string) => Promise<A>): Promise<A> => {
  const directory = mkdtempSync(join(tmpdir(), "t3-supervisor-catalog-"));
  try {return await run(directory);} finally {rmSync(directory, {recursive: true, force: true});}
};

test("activation, catalog shells and source cursors persist in a private catalog store", async () => {
  await withTemporaryDirectory(async directory => {
    assert.equal(await withStore(directory, store => store.activate("environment-1", 1_000)), 1_000);
    assert.equal(await withStore(directory, store => store.activate("environment-1", 2_000)), 1_000);
    await assert.rejects(withStore(directory, store => store.activate("environment-2", 3_000)),
      (error: unknown) => error instanceof StoreError && error._tag === "environment_mismatch");
    await withStore(directory, store => Effect.gen(function* () {
      yield* store.ingest(sourceItem("active", {kind: "project.updated", sequence: 3, project: project()}));
      yield* store.ingest(sourceItem("active", {kind: "thread.updated", sequence: 4, location: "active", thread: thread()}));
    }));

    const state = await withStore(directory, store => Effect.gen(function* () {
      return {cursor: yield* store.cursor("active"), catalog: yield* store.catalog(), project: yield* store.project("thread-1")};
    }));
    assert.equal(state.cursor, 4);
    assert.equal(state.catalog.projects[0]?.project.title, "Project one");
    assert.equal(state.catalog.threads[0]?.id, "thread-1");
    assert.equal(state.project?.title, "Project one");
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, "catalog.sqlite3")).mode & 0o777, 0o600);
  });
});

test("catalog store creates only the generic T3 and activation tables", async () => {
  await withTemporaryDirectory(async directory => {
    await withStore(directory, store => store.stats());
    const database = new DatabaseSync(join(directory, "catalog.sqlite3"));
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all().map(row => String(row.name));
      assert.deepEqual(tables, ["activations", "cursors", "environment_binding", "projects", "thread_revisions", "threads"]);
    } finally {database.close();}
  });
});

test("metadata enrichment updates projects without replacing inventory or rewinding the cursor", async () => {
  await withTemporaryDirectory(async directory => {
    await withStore(directory, store => Effect.gen(function* () {
      yield* store.ingest(sourceItem("active", {kind: "snapshot", snapshot: {
        schemaVersion: 2, snapshotSequence: 10, projects: [project()], threads: [thread()], archivedThreads: [],
      }}));
      yield* store.ingest(sourceItem("active", {kind: "snapshot", resolvedRepositoryIdentityRoots: ["/work/project-one"], snapshot: {
        schemaVersion: 2, snapshotSequence: 100, projects: [project("project-1", "Enriched title")], threads: [], archivedThreads: [],
      }}));
      yield* store.ingest(sourceItem("active", {kind: "thread.updated", sequence: 11, thread: thread("thread-2")}));
    }));

    const state = await withStore(directory, store => Effect.gen(function* () {
      return {cursor: yield* store.cursor("active"), catalog: yield* store.catalog(), firstProject: yield* store.project("thread-1")};
    }));
    assert.equal(state.cursor, 11);
    assert.deepEqual(state.catalog.threads.map(value => value.id), ["thread-1", "thread-2"]);
    assert.equal(state.firstProject?.title, "Enriched title");
  });
});

test("archive removal keeps the known shell and advances the archived cursor", async () => {
  await withTemporaryDirectory(async directory => {
    await withStore(directory, store => Effect.gen(function* () {
      yield* store.ingest(sourceItem("archive", {kind: "snapshot", snapshot: {
        schemaVersion: 2, snapshotSequence: 5, projects: [project()],
        threads: [{...thread("archived-1"), archivedAt: "2025-01-01T00:00:00.000Z"}],
      }}));
      yield* store.ingest(sourceItem("archive", {kind: "thread.removed", sequence: 6, threadId: "archived-1"}));
    }));
    const state = await withStore(directory, store => Effect.gen(function* () {
      return {cursor: yield* store.cursor("archive"), shell: yield* store.thread("archived-1"), catalog: yield* store.catalog()};
    }));
    assert.equal(state.cursor, 6);
    assert.equal(state.shell?.id, "archived-1");
    assert.equal(state.catalog.threads.some(value => value.id === "archived-1"), false);
  });
});

test("failed shell ingestion leaves its cursor unacknowledged", async () => {
  await withTemporaryDirectory(async directory => {
    await assert.rejects(withStore(directory, store => store.ingest(sourceItem("active", {
      kind: "thread.updated", sequence: 1, thread: {id: "malformed", title: "Missing lineage"},
    }))));
    assert.equal(await withStore(directory, store => store.cursor("active")), 0);
  });
});

test("stored shells omit conversation and goal text while retaining policy fields", async () => {
  await withTemporaryDirectory(async directory => {
    const privateValues = ["private latest visible message body", "private provider goal objective", "private last error details",
      "private background task description", "private runtime request text"];
    const shell = {
      ...thread(),
      status: "running",
      latestVisibleMessage: {id: "message", role: "assistant", text: privateValues[0]},
      goal: {status: "active", objective: privateValues[1]},
      lastError: privateValues[2],
      pendingBackgroundTasks: [{kind: "monitor", status: "running", description: privateValues[3]}],
      pendingRuntimeRequest: {id: "request", kind: "user_input", text: privateValues[4]},
    };
    const persisted = await withStore(directory, store => Effect.gen(function* () {
      yield* store.ingest(sourceItem("active", {kind: "thread.updated", sequence: 1, thread: shell}));
      return yield* store.thread("thread-1");
    }));
    assert.equal(persisted?.status, "running");
    assert.deepEqual(persisted?.pendingBackgroundTasks, [{kind: "monitor", status: "running"}]);
    assert.deepEqual(persisted?.pendingRuntimeRequest, {id: "request", kind: "user_input"});
    const files = readdirSync(directory).map(name => readFileSync(join(directory, name)));
    for (const privateValue of privateValues) {
      assert.equal(files.some(content => content.includes(Buffer.from(privateValue))), false);
      assert.equal(JSON.stringify(persisted).includes(privateValue), false);
    }
  });
});
