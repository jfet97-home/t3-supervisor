import { NodeFileSystem } from "@effect/platform-node";
import { Context, Data, Effect, FileSystem, Layer, Predicate, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { CatalogDb, catalogDbLayer, securePrivateFiles, untracedSql } from "./db.js";
import { timestampMs } from "./domain.js";
import type { ProjectInfo, SourceItem, ThreadInfo } from "./types.js";

const maxKnownThreads = 50_000;
const maxStoredShellChars = 512_000;

// a plain string tag lets the environment mismatch keep its own tag while remaining a StoreError
export class StoreError extends Data.Error<{ readonly message: string; readonly cause?: unknown }> {
  readonly _tag: string = "StoreError";
}

export class EnvironmentMismatchError extends StoreError {
  override readonly _tag = "environment_mismatch";

  constructor() {
    super({ message: "store is already bound to a different T3 environment" });
  }
}

export interface StoreStats {
  projects: number;
  threads: number;
  databaseBytes: number;
}

export interface StoreShape {
  catalog(): Effect.Effect<{ projects: Array<{ project: ProjectInfo; available: boolean }>; threads: ThreadInfo[] }, StoreError>;
  activate(environmentId: string, now: number): Effect.Effect<number, StoreError>;
  ingest(source: SourceItem): Effect.Effect<void, StoreError>;
  cursor(stream: SourceItem["stream"]): Effect.Effect<number, StoreError>;
  thread(threadId: string): Effect.Effect<ThreadInfo | null, StoreError>;
  project(threadId: string): Effect.Effect<ProjectInfo | null, StoreError>;
  stats(): Effect.Effect<StoreStats, StoreError>;
}

const fail = (message: string): Effect.Effect<never, StoreError> => Effect.fail(new StoreError({ message }));

// sql, decoding and file failures become one store failure that keeps its cause
const storeFailure = (cause: unknown): StoreError =>
  cause instanceof StoreError ? cause : new StoreError({ message: "durable store operation failed", cause });

const readString = (value: unknown, label: string): Effect.Effect<string, StoreError> =>
  typeof value === "string" && value.length > 0 ? Effect.succeed(value) : fail(`${label} must be a non-empty string`);

const readNow = (value: number): Effect.Effect<number, StoreError> => {
  const result = timestampMs(value);
  return result === null ? fail("timestamp must be a finite millisecond value") : Effect.succeed(result);
};

const serialize = (value: unknown, limit: number, label: string): Effect.Effect<string, StoreError> =>
  Effect.try({ try: () => JSON.stringify(value), catch: storeFailure }).pipe(Effect.flatMap((json) =>
    typeof json !== "string" || json.length > limit ? fail(`${label} exceeds its storage bound`) : Effect.succeed(json)));

const readThread = (value: unknown): Effect.Effect<ThreadInfo, StoreError> => {
  if (!Predicate.isObject(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.title !== "string") {
    return fail("thread shell is missing its id or title");
  }
  if (!Predicate.isObject(value.lineage)) return fail("thread shell is missing lineage metadata");
  return Effect.succeed(value as unknown as ThreadInfo);
};

const readProject = (value: unknown): Effect.Effect<ProjectInfo, StoreError> => {
  if (
    !Predicate.isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.workspaceRoot !== "string"
  ) return fail("project shell is missing required metadata");
  return Effect.succeed(value as unknown as ProjectInfo);
};

const whitelistThreadShell = (thread: ThreadInfo): Effect.Effect<ThreadInfo, StoreError> => {
  if (thread.id.length > 512) return fail("thread id exceeds the T3 contract limit");
  const lineage: Record<string, unknown> = Predicate.isObject(thread.lineage) ? thread.lineage : {};
  const safe: Record<string, unknown> = {
    id: thread.id,
    title: thread.title,
    projectId: typeof thread.projectId === "string" ? thread.projectId : null,
    lineage: {
      parentThreadId: typeof lineage.parentThreadId === "string" ? lineage.parentThreadId : null,
      relationshipToParent: typeof lineage.relationshipToParent === "string" ? lineage.relationshipToParent : null,
      ...(typeof lineage.rootThreadId === "string" ? { rootThreadId: lineage.rootThreadId } : {}),
    },
  };
  if (thread.creationSource === "provider" || thread.creationSource === "mcp") safe.creationSource = thread.creationSource;
  for (const field of ["activeRunId", "activityRunStatus", "activeProviderThreadId", "latestRunId", "status"]) {
    const value = thread[field];
    if (typeof value === "string" || value === null) safe[field] = value;
  }
  for (const field of [
    "activityRunStartedAt",
    "latestRunRequestedAt",
    "latestRunStartedAt",
    "latestRunCompletedAt",
    "createdAt",
    "updatedAt",
    "archivedAt",
    "deletedAt",
  ]) {
    const value = thread[field];
    if (value === null || typeof value === "string" && timestampMs(value) !== null) safe[field] = value;
  }
  if (Object.hasOwn(thread, "pendingRuntimeRequest")) {
    const request = thread.pendingRuntimeRequest;
    if (request === null) {
      safe.pendingRuntimeRequest = null;
    } else if (Predicate.isObject(request)) {
      const safeRequest: Record<string, unknown> = {};
      for (const field of ["id", "kind", "createdAt"]) {
        const value = request[field];
        if (
          typeof value === "string" &&
          (field !== "createdAt" || timestampMs(value) !== null)
        ) safeRequest[field] = value;
      }
      safe.pendingRuntimeRequest = safeRequest;
    } else {
      safe.pendingRuntimeRequest = request ? {} : null;
    }
  }
  if (Array.isArray(thread.pendingBackgroundTasks)) {
    safe.pendingBackgroundTasks = thread.pendingBackgroundTasks.map((task) => {
      if (!Predicate.isObject(task)) return { kind: "unknown" };
      return {
        kind: typeof task.kind === "string" ? task.kind : "unknown",
        ...(typeof task.status === "string" ? { status: task.status } : {}),
      };
    });
  } else if (Object.hasOwn(thread, "pendingBackgroundTasks")) {
    safe.pendingBackgroundTasks = [{ kind: "unknown" }];
  }
  return Effect.succeed(safe as unknown as ThreadInfo);
};

const itemSequence = (item: Record<string, unknown>): Effect.Effect<number | null, StoreError> => {
  const snapshot = Predicate.isObject(item.snapshot) ? item.snapshot : null;
  const raw = item.sequence ?? snapshot?.snapshotSequence;
  if (raw === undefined || raw === null) return Effect.succeed(null);
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return fail("shell item sequence must be a non-negative integer");
  }
  return Effect.succeed(raw);
};

const threadLocation = (stream: SourceItem["stream"], item: Record<string, unknown>, shell: ThreadInfo): "active" | "archive" => {
  if (stream === "archive" || item.location === "archive" || shell.archivedAt) return "archive";
  return "active";
};

// stored rows and documents are decoded at the read boundary; shells and projects keep their unknown native fields
const StoredDocument = Schema.fromJsonString(Schema.Unknown);
const decodeDocument = Schema.decodeUnknownEffect(StoredDocument);
const decodeDocumentRow = Schema.decodeUnknownEffect(Schema.Struct({ document: StoredDocument }));
const decodeJoinedDocumentRow = Schema.decodeUnknownEffect(Schema.Struct({ document: Schema.NullOr(StoredDocument) }));
const decodeProjectRow = Schema.decodeUnknownEffect(Schema.Struct({ document: StoredDocument, deleted: Schema.Finite }));
const decodeStoredShellRow = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String, document: Schema.String }));
const decodeIdRow = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }));
const decodeEnvironmentRow = Schema.decodeUnknownEffect(Schema.Struct({ environment_id: Schema.String }));
const decodeActivationRow = Schema.decodeUnknownEffect(Schema.Struct({ activated_at: Schema.Finite }));
const decodeSequenceRow = Schema.decodeUnknownEffect(Schema.Struct({ sequence: Schema.Finite }));
const decodeRevisionRow = Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.Finite }));
const decodeCountRow = Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Finite }));
const decodeTotalsRow = Schema.decodeUnknownEffect(Schema.Struct({ projects: Schema.Finite, threads: Schema.Finite }));
const decodeDatabaseFile = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ file: Schema.NonEmptyString })]));

const schema = [
  `CREATE TABLE IF NOT EXISTS activations (
    environment_id TEXT PRIMARY KEY,
    activated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS environment_binding (
    id INTEGER PRIMARY KEY CHECK(id=1),
    environment_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cursors (
    stream TEXT PRIMARY KEY CHECK(stream IN ('active', 'archive')),
    sequence INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    document TEXT NOT NULL,
    location TEXT NOT NULL CHECK(location IN ('active', 'archive', 'removed')),
    revision INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS thread_revisions (
    thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id)",
];

const make = Effect.gen(function* () {
  const sql = yield* CatalogDb;
  const fs = yield* FileSystem.FileSystem;
  // the store reads its file from its own connection, so modes and sizes follow the database that is open
  const [{ file: databasePath }] = yield* sql`SELECT file FROM pragma_database_list WHERE name='main'`.pipe(
    Effect.flatMap(decodeDatabaseFile), Effect.mapError(storeFailure));

  const secureFiles = securePrivateFiles(databasePath).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(storeFailure));

  // a missing -wal or -shm counts as empty (sqlite removes them on the last close)
  const fileBytes = (path: string) => fs.stat(path).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed(0) : Effect.fail(error)));

  // every write re-secures the database files before its transaction begins: a permission failure fails the write before
  // any SQL runs, so rows, revisions and cursors stay as they were, as the baseline's rollback left them; the transaction
  // holds SQL only (plan 3.2 rule 3) and nothing follows its COMMIT, so a failed write never leaves committed state;
  // the files it re-secures exist for the client's lifetime (WAL and SHM are created and secured when it opens)
  const write = <A, E>(body: Effect.Effect<A, E>) => secureFiles.pipe(Effect.andThen(sql.withTransaction(body)));

  const count = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
    statement.pipe(Effect.flatMap(([row]) => decodeCountRow(row)), Effect.map((row) => row.count));

  const currentCursor = (stream: SourceItem["stream"]) => sql`SELECT sequence FROM cursors WHERE stream=${stream}`.pipe(
    Effect.flatMap(([row]) => row === undefined ? Effect.succeed(0) : decodeSequenceRow(row).pipe(Effect.map((value) => value.sequence))));

  const nextRevision = (threadId: string) => sql`
    INSERT INTO thread_revisions(thread_id, revision) VALUES (${threadId}, 1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=thread_revisions.revision+1
    RETURNING revision
  `.pipe(Effect.flatMap(([row]) => row === undefined ? Effect.succeed(1) : decodeRevisionRow(row).pipe(Effect.map((value) => value.revision))));

  const storeProject = Effect.fnUntraced(function* (project: ProjectInfo) {
    const document = yield* serialize(project, maxStoredShellChars, "project shell");
    yield* sql`
      INSERT INTO projects(id, document, deleted) VALUES (${project.id}, ${document}, 0)
      ON CONFLICT(id) DO UPDATE SET document=excluded.document, deleted=0
    `;
  });

  const storeThread = Effect.fnUntraced(function* (thread: ThreadInfo, location: "active" | "archive") {
    const safeThread = yield* whitelistThreadShell(thread);
    const document = yield* serialize(safeThread, maxStoredShellChars, "thread shell");
    const known = yield* count(sql`SELECT COUNT(*) AS count FROM threads`);
    const existing = yield* sql`SELECT revision FROM threads WHERE id=${safeThread.id}`;
    if (existing.length === 0 && known >= maxKnownThreads) {
      return yield* fail("known thread capacity reached; refusing to lose archive lookup metadata");
    }
    const revision = yield* nextRevision(safeThread.id);
    yield* sql`
      INSERT INTO threads(id, project_id, document, location, revision) VALUES (${safeThread.id}, ${safeThread.projectId}, ${document}, ${location}, ${revision})
      ON CONFLICT(id) DO UPDATE SET
        project_id=excluded.project_id,
        document=excluded.document,
        location=excluded.location,
        revision=excluded.revision
    `;
  });

  const removeThread = Effect.fnUntraced(function* (threadId: unknown) {
    const id = yield* readString(threadId, "thread id");
    const revision = yield* nextRevision(id);
    yield* sql`UPDATE threads SET location='removed', revision=${revision} WHERE id=${id}`;
  });

  const reconcileThreads = Effect.fnUntraced(function* (stream: SourceItem["stream"], incoming: ReadonlyArray<unknown>) {
    const incomingIds = new Set<string>();
    for (const value of incoming) incomingIds.add((yield* readThread(value)).id);
    const location = stream === "active" ? "active" : "archive";
    for (const row of yield* sql`SELECT id FROM threads WHERE location=${location}`) {
      const { id } = yield* decodeIdRow(row);
      if (!incomingIds.has(id)) yield* removeThread(id);
    }
  });

  const ingestSnapshot = Effect.fnUntraced(function* (
    stream: SourceItem["stream"],
    item: Record<string, unknown>,
    sequence: number | null,
    cursor: number,
  ) {
    if (!Predicate.isObject(item.snapshot)) return yield* fail("snapshot item is missing its snapshot payload");
    const snapshot = item.snapshot;
    const hasEnrichmentMarker = item.resolvedRepositoryIdentityRoots !== undefined;
    if (hasEnrichmentMarker && !Array.isArray(item.resolvedRepositoryIdentityRoots)) {
      return yield* fail("snapshot enrichment roots must be an array");
    }
    if (sequence !== null && sequence < cursor && !hasEnrichmentMarker) return false;
    const projects = snapshot.projects;
    const threads = snapshot.threads;
    const archivedThreads = snapshot.archivedThreads;
    if (
      !Array.isArray(projects) ||
      !Array.isArray(threads) ||
      stream === "active" && !Array.isArray(archivedThreads)
    ) {
      return yield* fail("snapshot is missing project or thread arrays");
    }
    const roots = hasEnrichmentMarker ? item.resolvedRepositoryIdentityRoots as unknown[] : null;
    if (roots !== null && roots.some((root) => typeof root !== "string")) {
      return yield* fail("snapshot enrichment roots must contain only strings");
    }
    const enrichmentRoots = roots as string[] | null;
    const selectedProjects = enrichmentRoots === null
      ? projects
      : projects.filter((value) => Predicate.isObject(value) && enrichmentRoots.includes(String(value.workspaceRoot)));
    for (const value of selectedProjects) yield* storeProject(yield* readProject(value));

    if (enrichmentRoots !== null) return false;

    const incoming: unknown[] = stream === "active"
      ? threads
      : Array.isArray(archivedThreads) && archivedThreads.length > 0 ? archivedThreads : threads;
    yield* reconcileThreads(stream, incoming);
    for (const value of incoming) {
      const shell = yield* readThread(value);
      yield* storeThread(shell, stream === "active" ? "active" : "archive");
    }
    return true;
  });

  // the open-time migration re-whitelists every stored shell in one transaction; a malformed row fails the open
  yield* write(Effect.gen(function* () {
    for (const statement of schema) yield* sql.unsafe(statement);
    for (const row of yield* sql`SELECT id, document FROM threads`) {
      const stored = yield* decodeStoredShellRow(row).pipe(
        Effect.mapError((cause) => new StoreError({ message: "stored thread metadata is malformed", cause })));
      const sanitized = yield* whitelistThreadShell(yield* readThread(yield* decodeDocument(stored.document)));
      const document = yield* serialize(sanitized, maxStoredShellChars, "thread shell");
      yield* sql`UPDATE threads SET document=${document} WHERE id=${stored.id}`;
    }
  })).pipe(Effect.mapError(storeFailure));

  const catalog = () => sql.withTransaction(Effect.gen(function* () {
    const projects = yield* Effect.forEach(yield* sql`SELECT document,deleted FROM projects ORDER BY id`, (row) =>
      decodeProjectRow(row).pipe(Effect.flatMap(({ document, deleted }) =>
        readProject(document).pipe(Effect.map((project) => ({ project, available: deleted === 0 }))))));
    const threads = yield* Effect.forEach(yield* sql`SELECT document FROM threads WHERE location='active' ORDER BY id`, (row) =>
      decodeDocumentRow(row).pipe(Effect.flatMap(({ document }) => readThread(document))));
    return { projects, threads };
  })).pipe(
    // a deferred transaction reads one snapshot without the write lock, as the baseline's synchronous reads did
    Effect.provideService(SqlClient.BeginTransaction, "BEGIN"),
    Effect.mapError(storeFailure),
    untracedSql,
  );

  const activate = (environmentId: string, now: number): Effect.Effect<number, StoreError> => Effect.gen(function* () {
    const environment = yield* readString(environmentId, "environment id");
    const activatedAt = yield* readNow(now);
    return yield* write(Effect.gen(function* () {
      const [binding] = yield* sql`SELECT environment_id FROM environment_binding WHERE id=1`;
      if (binding !== undefined && (yield* decodeEnvironmentRow(binding)).environment_id !== environment) {
        return yield* new EnvironmentMismatchError();
      }
      if (binding === undefined) {
        const priorBindings = yield* Effect.forEach(yield* sql`SELECT DISTINCT environment_id FROM activations`, (row) => decodeEnvironmentRow(row));
        if (priorBindings.some((row) => row.environment_id !== environment)) return yield* new EnvironmentMismatchError();
        if (priorBindings.length === 0 && (yield* count(sql`
          SELECT
            (SELECT COUNT(*) FROM cursors) +
            (SELECT COUNT(*) FROM projects) +
            (SELECT COUNT(*) FROM threads) AS count
        `)) > 0) return yield* new EnvironmentMismatchError();
        yield* sql`INSERT INTO environment_binding(id, environment_id) VALUES (1, ${environment})`;
      }
      yield* sql`INSERT OR IGNORE INTO activations(environment_id, activated_at) VALUES (${environment}, ${activatedAt})`;
      const [row] = yield* sql`SELECT activated_at FROM activations WHERE environment_id=${environment}`;
      return row === undefined ? 0 : (yield* decodeActivationRow(row)).activated_at;
    }));
  }).pipe(Effect.mapError(storeFailure), untracedSql);

  const ingest = (source: SourceItem): Effect.Effect<void, StoreError> => Effect.gen(function* () {
    if (source.stream !== "active" && source.stream !== "archive") return yield* fail("unknown source stream");
    if (!Predicate.isObject(source.item)) return yield* fail("source item must be an object");
    const item: Record<string, unknown> = source.item;
    const kind = item.kind;
    const sequence = yield* itemSequence(item);

    yield* write(Effect.gen(function* () {
      const cursor = yield* currentCursor(source.stream);
      const stale = sequence !== null && sequence <= cursor;
      let advanceCursor = true;
      if (kind === "snapshot") {
        advanceCursor = yield* ingestSnapshot(source.stream, item, sequence, cursor);
      } else if (stale) {
        return;
      } else if (kind === "thread.updated") {
        const shell = yield* readThread(item.thread);
        yield* storeThread(shell, threadLocation(source.stream, item, shell));
      } else if (kind === "thread.removed") {
        yield* removeThread(item.threadId);
      } else if (kind === "project.updated") {
        yield* storeProject(yield* readProject(item.project));
      } else if (kind === "project.removed") {
        const id = yield* readString(item.projectId, "project id");
        yield* sql`UPDATE projects SET deleted=1 WHERE id=${id}`;
      } else if (kind === "synchronized" && sequence === null) {
        return;
      } else if (sequence !== null) {
        return yield* fail(`unsupported sequenced shell item: ${String(kind)}`);
      }
      if (sequence !== null && advanceCursor) {
        yield* sql`
          INSERT INTO cursors(stream, sequence) VALUES (${source.stream}, ${sequence})
          ON CONFLICT(stream) DO UPDATE SET sequence=MAX(cursors.sequence, excluded.sequence)
        `;
      }
    }));
  }).pipe(Effect.mapError(storeFailure), untracedSql);

  const cursor = (stream: SourceItem["stream"]): Effect.Effect<number, StoreError> =>
    currentCursor(stream).pipe(Effect.mapError(storeFailure), untracedSql);

  const thread = (threadId: string): Effect.Effect<ThreadInfo | null, StoreError> => Effect.gen(function* () {
    const id = yield* readString(threadId, "thread id");
    const [row] = yield* sql`SELECT document FROM threads WHERE id=${id}`;
    if (row === undefined) return null;
    return yield* readThread((yield* decodeDocumentRow(row)).document);
  }).pipe(Effect.mapError(storeFailure), untracedSql);

  const project = (threadId: string): Effect.Effect<ProjectInfo | null, StoreError> => Effect.gen(function* () {
    const id = yield* readString(threadId, "thread id");
    const [row] = yield* sql`
      SELECT p.document FROM threads t
      LEFT JOIN projects p ON p.id=t.project_id
      WHERE t.id=${id}
    `;
    const document = row === undefined ? null : (yield* decodeJoinedDocumentRow(row)).document;
    return document === null ? null : yield* readProject(document);
  }).pipe(Effect.mapError(storeFailure), untracedSql);

  const stats = (): Effect.Effect<StoreStats, StoreError> => Effect.gen(function* () {
    const sizes = yield* Effect.forEach([databasePath, `${databasePath}-wal`, `${databasePath}-shm`], fileBytes);
    const databaseBytes = sizes.reduce((total, size) => total + size, 0);
    // one statement counts both tables from the same snapshot
    const [row] = yield* sql`SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM threads) AS threads`;
    const totals = yield* decodeTotalsRow(row);
    return { projects: totals.projects, threads: totals.threads, databaseBytes };
  }).pipe(Effect.mapError(storeFailure), untracedSql);

  return { catalog, activate, ingest, cursor, thread, project, stats } satisfies StoreShape;
});

// effect/sql spans carry query text and transaction exits, so the store's construction and every operation run untraced
export class Store extends Context.Service<Store, StoreShape>()("Store") {
  /** The catalog store on the process's catalog client. */
  static readonly layer: Layer.Layer<Store, StoreError, CatalogDb | FileSystem.FileSystem> = Layer.effect(Store, untracedSql(make));
}

/** The catalog store with its own catalog client for `dataDirectory`. */
export const makeStore = (dataDirectory: string): Layer.Layer<Store, StoreError> =>
  Store.layer.pipe(
    Layer.provide(catalogDbLayer(dataDirectory).pipe(
      Layer.catchTag("DatabaseOpenError", (error) => Layer.effect(CatalogDb, Effect.fail(storeFailure(error)))))),
    Layer.provide(NodeFileSystem.layer),
  );
