import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { it } from "vitest";
import { GuidanceStore } from "../src/guidance-store.js";
import { makeStore, Store, StoreError, type StoreShape } from "../src/store.js";
import { ThreadPolicyStore } from "../src/thread-policy.js";
import type { ProjectInfo, SourceItem, ThreadInfo } from "../src/types.js";

const project = (id: string, title = `Project ${id}`): ProjectInfo => ({ id, title, workspaceRoot: `/work/${id}` });

const thread = (id: string, projectId: string | null = "project-1"): ThreadInfo => ({
  id,
  title: `Conversation ${id}`,
  projectId,
  lineage: { parentThreadId: null, relationshipToParent: null },
  archivedAt: null,
});

const snapshot = (sequence: number, projects: unknown[], threads: unknown[]): SourceItem => ({
  stream: "active",
  item: { kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: sequence, projects, threads, archivedThreads: [] } },
});

const withStore = <A, E>(directory: string, use: (store: StoreShape) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(Store.use(use), makeStore(directory))));

const withTemporaryDirectory = async <A>(run: (directory: string) => Promise<A>): Promise<A> => {
  const directory = mkdtempSync(join(tmpdir(), "t3-supervisor-catalog-characterization-"));
  try {return await run(directory);} finally {rmSync(directory, { recursive: true, force: true });}
};

const catalogPath = (directory: string): string => join(directory, "catalog.sqlite3");

// node:sqlite rows have a null prototype; strict deep equality compares plain copies
const plain = (row: unknown): Record<string, unknown> => ({ ...row as Record<string, unknown> });

// an external connection plays the other actor; closing it as the last connection checkpoints and removes the wal
const withConnection = <A>(path: string, use: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(path);
  try {return use(database);} finally {database.close();}
};

const catalogTables = ["activations", "cursors", "environment_binding", "projects", "thread_revisions", "threads"];

const dumpCatalog = (directory: string): Record<string, unknown[]> => withConnection(catalogPath(directory), database =>
  Object.fromEntries(catalogTables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all().map(plain)])));

const mode = (path: string): number => statSync(path).mode & 0o777;

it("CT-STORE-01: a snapshot ingest failing mid-way leaves projects, threads and cursor exactly as before", { timeout: 10_000 }, async () => {
  await withTemporaryDirectory(async directory => {
    await withStore(directory, store => Effect.gen(function* () {
      yield* store.activate("environment-1", 1_000);
      yield* store.ingest(snapshot(10, [project("project-1")], [thread("thread-a"), thread("thread-b")]));
    }));
    const before = dumpCatalog(directory);
    assert.equal(before.threads?.length, 2);
    assert.equal(before.cursors?.length, 1);

    // the second thread fails after the project writes and before any thread write (missing lineage), or after the first thread write (id over the limit)
    const failures = [
      { shell: { id: "thread-c", title: "Missing lineage" }, message: "thread shell is missing lineage metadata" },
      { shell: thread("x".repeat(513)), message: "thread id exceeds the T3 contract limit" },
    ];
    const observed = await withStore(directory, store => Effect.gen(function* () {
      const errors: unknown[] = [];
      for (const failure of failures) {
        errors.push(yield* Effect.flip(store.ingest(snapshot(20,
          [project("project-1", "Renamed project"), project("project-2")],
          [{ ...thread("thread-a"), title: "Changed title" }, failure.shell]))));
      }
      return { errors, catalog: yield* store.catalog(), cursor: yield* store.cursor("active") };
    }));
    assert.deepEqual(observed.errors.map(error => error instanceof StoreError ? error.message : error),
      failures.map(failure => failure.message));
    assert.equal(observed.cursor, 10);
    assert.deepEqual(observed.catalog.projects.map(entry => [entry.project.id, entry.project.title, entry.available]),
      [["project-1", "Project project-1", true]]);
    assert.deepEqual(observed.catalog.threads.map(value => [value.id, value.title]),
      [["thread-a", "Conversation thread-a"], ["thread-b", "Conversation thread-b"]]);
    assert.deepEqual(dumpCatalog(directory), before);

    // the rolled-back transaction leaves the connection usable for the next valid snapshot
    await withStore(directory, store => store.ingest(snapshot(20, [project("project-1", "Renamed project")], [thread("thread-a")])));
    const after = dumpCatalog(directory);
    assert.deepEqual(after.cursors, [{ rowid: 1, stream: "active", sequence: 20 }]);
    assert.deepEqual((after.threads as Array<Record<string, unknown>>).map(row => [row.id, row.location]),
      [["thread-a", "active"], ["thread-b", "removed"]]);
  });
});

it("CT-STORE-02: reopen whitelists legacy shells, and a malformed stored document fails open leaving the file unchanged", { timeout: 10_000 }, async () => {
  const privateValues = ["private latest visible message body", "private provider goal objective", "private last error details",
    "private background task description", "private runtime request text", "private unknown field"];
  const legacyShell = (id: string): Record<string, unknown> => ({
    ...thread(id),
    status: "running",
    creationSource: "provider",
    latestVisibleMessage: { id: "message", role: "assistant", text: privateValues[0] },
    goal: { status: "active", objective: privateValues[1] },
    lastError: privateValues[2],
    pendingBackgroundTasks: [{ kind: "monitor", status: "running", description: privateValues[3] }, "not a task"],
    pendingRuntimeRequest: { id: "request", kind: "user_input", text: privateValues[4], createdAt: "2026-10-01T00:00:00.000Z" },
    unknownField: privateValues[5],
  });
  const whitelisted = (id: string) => ({
    id,
    title: `Conversation ${id}`,
    projectId: "project-1",
    lineage: { parentThreadId: null, relationshipToParent: null },
    creationSource: "provider",
    status: "running",
    archivedAt: null,
    pendingRuntimeRequest: { id: "request", kind: "user_input", createdAt: "2026-10-01T00:00:00.000Z" },
    pendingBackgroundTasks: [{ kind: "monitor", status: "running" }, { kind: "unknown" }],
  });
  const insertLegacy = (directory: string, rows: Array<[string, string]>) => withConnection(catalogPath(directory), database => {
    const insert = database.prepare("INSERT INTO threads(id, project_id, document, location, revision) VALUES (?, 'project-1', ?, 'active', 7)");
    for (const [id, document] of rows) insert.run(id, document);
  });

  await withTemporaryDirectory(async directory => {
    await withStore(directory, store => store.stats());
    insertLegacy(directory, [["legacy-1", JSON.stringify(legacyShell("legacy-1"))], ["legacy-2", JSON.stringify(legacyShell("legacy-2"))]]);
    const reopened = await withStore(directory, store => Effect.gen(function* () {
      return [yield* store.thread("legacy-1"), yield* store.thread("legacy-2")];
    }));
    assert.deepEqual(reopened, [whitelisted("legacy-1"), whitelisted("legacy-2")]);
    const rows = dumpCatalog(directory).threads as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map(row => [row.id, row.revision, JSON.parse(String(row.document))]),
      [["legacy-1", 7, whitelisted("legacy-1")], ["legacy-2", 7, whitelisted("legacy-2")]]);
    const files = readdirSync(directory).map(name => readFileSync(join(directory, name)));
    for (const value of privateValues) assert.equal(files.some(content => content.includes(Buffer.from(value))), false);
  });

  for (const malformed of [
    { document: JSON.stringify({ id: "broken", title: "Missing lineage" }), message: "thread shell is missing lineage metadata" },
    { document: "{not json", message: "durable store operation failed" },
  ]) {
    await withTemporaryDirectory(async directory => {
      await withStore(directory, store => store.ingest({ stream: "active", item: { kind: "thread.updated", sequence: 1, thread: thread("valid") } }));
      // the legacy row precedes the malformed one, so the scrub has already rewritten it when the open fails
      insertLegacy(directory, [["legacy-1", JSON.stringify(legacyShell("legacy-1"))], ["broken", malformed.document]]);
      const listing = readdirSync(directory).sort();
      const bytes = readFileSync(catalogPath(directory));
      const dump = dumpCatalog(directory);
      assert.deepEqual(listing, ["catalog.sqlite3"]);

      const failure = await Effect.runPromise(Effect.flip(Effect.scoped(Effect.provide(Store.use(store => store.stats()), makeStore(directory)))));
      assert.ok(failure instanceof StoreError);
      assert.equal(failure.message, malformed.message);

      assert.deepEqual(readdirSync(directory).sort(), listing);
      assert.ok(readFileSync(catalogPath(directory)).equals(bytes), "the failed open leaves the main file byte-identical");
      assert.equal(mode(catalogPath(directory)), 0o600);
      assert.deepEqual(dumpCatalog(directory), dump);
      assert.ok(readFileSync(catalogPath(directory)).includes(Buffer.from(privateValues[0]!)), "the partial scrub was rolled back");
    });
  }
});

it("CT-STORE-03: the store connection carries the pragma golden and only journal_mode persists", { timeout: 10_000 }, async () => {
  await withTemporaryDirectory(async directory => {
    const pragmas = await withStore(directory, store => Effect.sync(() => {
      // the service value is the SqliteStore instance; its private connection is reachable at runtime
      const database = (store as unknown as { db: DatabaseSync }).db;
      const read = (name: string) => plain(database.prepare(`PRAGMA ${name}`).get());
      return ["journal_mode", "synchronous", "foreign_keys", "busy_timeout", "wal_autocheckpoint", "secure_delete", "max_page_count"]
        .map(name => [name, read(name)]);
    }));
    assert.deepEqual(pragmas, [
      ["journal_mode", { journal_mode: "wal" }],
      ["synchronous", { synchronous: 2 }],
      ["foreign_keys", { foreign_keys: 1 }],
      ["busy_timeout", { timeout: 5000 }],
      ["wal_autocheckpoint", { wal_autocheckpoint: 256 }],
      ["secure_delete", { secure_delete: 1 }],
      ["max_page_count", { max_page_count: 16384 }],
    ]);
    assert.deepEqual(withConnection(catalogPath(directory), database => plain(database.prepare("PRAGMA journal_mode").get())), { journal_mode: "wal" });
  });
});

it("CT-FILES-MODE-01: after first open and one write the stores keep private file modes", { timeout: 10_000 }, async () => {
  const previousMask = process.umask(0o022);
  const root = mkdtempSync(join(tmpdir(), "t3-supervisor-file-modes-"));
  // a data directory that exists before startup with the umask-default 0755 mode
  const dataDirectory = (name: string): string => {
    const path = join(root, name);
    mkdirSync(path);
    chmodSync(path, 0o755);
    assert.equal(mode(path), 0o755);
    return path;
  };
  const databaseModes = (directory: string, file: string) => {
    const paths = [file, `${file}-wal`, `${file}-shm`].map(name => join(directory, name));
    assert.deepEqual(paths.map(path => existsSync(path)), [true, true, true], `${file} and its wal and shm exist while open`);
    return paths.map(mode);
  };
  try {
    const catalogDirectory = dataDirectory("catalog");
    const catalogModes = await withStore(catalogDirectory, store => store.activate("environment-1", 1_000).pipe(
      Effect.map(() => databaseModes(catalogDirectory, "catalog.sqlite3"))));
    assert.deepEqual(catalogModes, [0o600, 0o600, 0o600]);

    const guidanceDirectory = dataDirectory("guidance");
    const guidance = new GuidanceStore(guidanceDirectory);
    try {
      guidance.bind("environment-1");
      assert.deepEqual(databaseModes(guidanceDirectory, "guidance.sqlite3"), [0o600, 0o600, 0o600]);
    } finally {guidance.close();}

    const policyDirectory = dataDirectory("policy");
    const policy = new ThreadPolicyStore(policyDirectory, { excludedThreadIds: [] });
    try {
      policy.save({ generation: 1, excludedThreadIds: ["thread-1"] });
      assert.deepEqual(databaseModes(policyDirectory, "thread-settings.sqlite3"), [0o600, 0o600, 0o600]);
    } finally {policy.close();}

    // main.ts opens the thread policy store, then the catalog store, then supervision opens the guidance store
    const startup = dataDirectory("startup");
    const startupPolicy = new ThreadPolicyStore(startup, { excludedThreadIds: [] });
    try {
      startupPolicy.save({ generation: 1, excludedThreadIds: ["thread-1"] });
      const modes = await withStore(startup, store => Effect.gen(function* () {
        yield* store.activate("environment-1", 1_000);
        const startupGuidance = new GuidanceStore(startup);
        try {
          startupGuidance.bind("environment-1");
          return {
            directory: mode(startup),
            files: ["thread-settings.sqlite3", "catalog.sqlite3", "guidance.sqlite3"].map(file => databaseModes(startup, file)),
          };
        } finally {startupGuidance.close();}
      }));
      assert.deepEqual(modes, {
        directory: 0o700,
        files: [[0o600, 0o600, 0o600], [0o600, 0o600, 0o600], [0o600, 0o600, 0o600]],
      });
    } finally {startupPolicy.close();}
  } finally {
    process.umask(previousMask);
    rmSync(root, { recursive: true, force: true });
  }
});
