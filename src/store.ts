import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer } from "effect";
import { timestampMs } from "./domain.js";
import type { ProjectInfo, SourceItem, ThreadInfo } from "./types.js";

const maxDatabasePages = 16_384;
const maxKnownThreads = 50_000;
const maxStoredShellChars = 512_000;

export class StoreError extends Error {
  readonly _tag: string = "StoreError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class EnvironmentMismatchError extends StoreError {
  override readonly _tag = "environment_mismatch";

  constructor() {
    super("store is already bound to a different T3 environment");
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

export class Store extends Context.Service<Store, StoreShape>()("Store") {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`${label} must be a non-empty string`);
  return value;
};

const readNow = (value: number): number => {
  const result = timestampMs(value);
  if (result === null) throw new StoreError("timestamp must be a finite millisecond value");
  return result;
};

const serialize = (value: unknown, limit: number, label: string): string => {
  const json = JSON.stringify(value);
  if (typeof json !== "string" || json.length > limit) throw new StoreError(`${label} exceeds its storage bound`);
  return json;
};

const normalizeFailure = (cause: unknown): StoreError =>
  cause instanceof StoreError ? cause : new StoreError("durable store operation failed", { cause });

const runStoreOperation = <A>(operation: () => A): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({
    try: () => Promise.resolve().then(operation),
    catch: normalizeFailure,
  });

const rowNumber = (row: Record<string, unknown> | undefined, key: string, fallback = 0): number => {
  const value = row?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return fallback;
};

const rowString = (row: Record<string, unknown> | undefined, key: string): string | null => {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
};

const readThread = (value: unknown): ThreadInfo => {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.title !== "string") {
    throw new StoreError("thread shell is missing its id or title");
  }
  if (!isRecord(value.lineage)) throw new StoreError("thread shell is missing lineage metadata");
  return value as unknown as ThreadInfo;
};

const readProject = (value: unknown): ProjectInfo => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.workspaceRoot !== "string"
  ) throw new StoreError("project shell is missing required metadata");
  return value as unknown as ProjectInfo;
};

const whitelistThreadShell = (thread: ThreadInfo): ThreadInfo => {
  if (thread.id.length > 512) throw new StoreError("thread id exceeds the T3 contract limit");
  const lineage: Record<string, unknown> = isRecord(thread.lineage) ? thread.lineage : {};
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
    } else if (isRecord(request)) {
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
      if (!isRecord(task)) return { kind: "unknown" };
      return {
        kind: typeof task.kind === "string" ? task.kind : "unknown",
        ...(typeof task.status === "string" ? { status: task.status } : {}),
      };
    });
  } else if (Object.hasOwn(thread, "pendingBackgroundTasks")) {
    safe.pendingBackgroundTasks = [{ kind: "unknown" }];
  }
  return safe as unknown as ThreadInfo;
};

const getRow = (db: DatabaseSync, query: string, ...params: Array<string | number | null>): Record<string, unknown> | undefined =>
  db.prepare(query).get(...params) as Record<string, unknown> | undefined;

const count = (db: DatabaseSync, query: string, ...params: Array<string | number | null>): number =>
  rowNumber(getRow(db, query, ...params), "count");

const secureFiles = (databasePath: string): void => {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
};

const schema = `
  CREATE TABLE IF NOT EXISTS activations (
    environment_id TEXT PRIMARY KEY,
    activated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS environment_binding (
    id INTEGER PRIMARY KEY CHECK(id=1),
    environment_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cursors (
    stream TEXT PRIMARY KEY CHECK(stream IN ('active', 'archive')),
    sequence INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    document TEXT NOT NULL,
    location TEXT NOT NULL CHECK(location IN ('active', 'archive', 'removed')),
    revision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS thread_revisions (
    thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id);
`;

class SqliteStore implements StoreShape {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;

  constructor(dataDirectory: string) {
    const directory = resolve(dataDirectory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.databasePath = join(directory, "catalog.sqlite3");
    this.db = new DatabaseSync(this.databasePath);
    try {
      chmodSync(this.databasePath, 0o600);
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec("PRAGMA synchronous=FULL");
      this.db.exec("PRAGMA foreign_keys=ON");
      this.db.exec("PRAGMA busy_timeout=5000");
      this.db.exec("PRAGMA wal_autocheckpoint=256");
      this.db.exec("PRAGMA secure_delete=ON");
      this.db.exec(`PRAGMA max_page_count=${maxDatabasePages}`);
      this.db.exec(schema);
      this.scrubStoredThreadShells();
      secureFiles(this.databasePath);
    } catch (cause) {
      this.db.close();
      throw cause;
    }
  }

  close = (): void => {
    secureFiles(this.databasePath);
    this.db.close();
  };

  catalog = () => runStoreOperation(() => ({
    projects: this.db.prepare("SELECT document,deleted FROM projects ORDER BY id").all().map(row => ({
      project: readProject(JSON.parse(String(row.document)) as unknown), available: row.deleted === 0,
    })),
    threads: this.db.prepare("SELECT document FROM threads WHERE location='active' ORDER BY id").all().map(row => readThread(JSON.parse(String(row.document)) as unknown)),
  }));

  activate = (environmentId: string, now: number): Effect.Effect<number, StoreError> => runStoreOperation(() => {
    const environment = readString(environmentId, "environment id");
    const activatedAt = readNow(now);
    return this.transaction(() => {
      const binding = getRow(this.db, "SELECT environment_id FROM environment_binding WHERE id=1");
      if (binding !== undefined && rowString(binding, "environment_id") !== environment) {
        throw new EnvironmentMismatchError();
      }
      if (binding === undefined) {
        const priorBindings = this.db.prepare("SELECT DISTINCT environment_id FROM activations")
          .all() as Array<Record<string, unknown>>;
        if (priorBindings.some((row) => rowString(row, "environment_id") !== environment)) {
          throw new EnvironmentMismatchError();
        }
        if (priorBindings.length === 0 && count(this.db, `
          SELECT
            (SELECT COUNT(*) FROM cursors) +
            (SELECT COUNT(*) FROM projects) +
            (SELECT COUNT(*) FROM threads) AS count
        `) > 0) throw new EnvironmentMismatchError();
        this.db.prepare("INSERT INTO environment_binding(id, environment_id) VALUES (1, ?)").run(environment);
      }
      this.db.prepare("INSERT OR IGNORE INTO activations(environment_id, activated_at) VALUES (?, ?)")
        .run(environment, activatedAt);
      const row = getRow(this.db, "SELECT activated_at FROM activations WHERE environment_id=?", environment);
      return rowNumber(row, "activated_at");
    });
  });

  ingest = (source: SourceItem): Effect.Effect<void, StoreError> => runStoreOperation(() => {
    if (source.stream !== "active" && source.stream !== "archive") throw new StoreError("unknown source stream");
    if (!isRecord(source.item)) throw new StoreError("source item must be an object");
    const kind = source.item.kind;
    const sequence = this.itemSequence(source.item);

    this.transaction(() => {
      const currentCursor = rowNumber(getRow(this.db, "SELECT sequence FROM cursors WHERE stream=?", source.stream), "sequence");
      const stale = sequence !== null && sequence <= currentCursor;
      let advanceCursor = true;
      if (kind === "snapshot") {
        advanceCursor = this.ingestSnapshot(source.stream, source.item, sequence);
      } else if (stale) {
        return;
      } else if (kind === "thread.updated") {
        const shell = readThread(source.item.thread);
        this.storeThread(shell, this.threadLocation(source.stream, source.item, shell));
      } else if (kind === "thread.removed") {
        this.removeThread(readString(source.item.threadId, "thread id"));
      } else if (kind === "project.updated") {
        this.storeProject(readProject(source.item.project));
      } else if (kind === "project.removed") {
        const id = readString(source.item.projectId, "project id");
        this.db.prepare("UPDATE projects SET deleted=1 WHERE id=?").run(id);
      } else if (kind === "synchronized" && sequence === null) {
        return;
      } else if (sequence !== null) {
        throw new StoreError(`unsupported sequenced shell item: ${String(kind)}`);
      }
      if (sequence !== null && advanceCursor) {
        this.db.prepare(`
          INSERT INTO cursors(stream, sequence) VALUES (?, ?)
          ON CONFLICT(stream) DO UPDATE SET sequence=MAX(cursors.sequence, excluded.sequence)
        `).run(source.stream, sequence);
      }
    });
  });

  cursor = (stream: SourceItem["stream"]): Effect.Effect<number, StoreError> => runStoreOperation(() => {
    const row = getRow(this.db, "SELECT sequence FROM cursors WHERE stream=?", stream);
    return rowNumber(row, "sequence");
  });

  thread = (threadId: string): Effect.Effect<ThreadInfo | null, StoreError> => runStoreOperation(() => {
    const row = getRow(this.db, "SELECT document FROM threads WHERE id=?", readString(threadId, "thread id"));
    const document = rowString(row, "document");
    return document === null ? null : readThread(JSON.parse(document) as unknown);
  });

  project = (threadId: string): Effect.Effect<ProjectInfo | null, StoreError> => runStoreOperation(() => {
    const row = getRow(this.db, `
      SELECT p.document FROM threads t
      LEFT JOIN projects p ON p.id=t.project_id
      WHERE t.id=?
    `, readString(threadId, "thread id"));
    const document = rowString(row, "document");
    return document === null ? null : readProject(JSON.parse(document) as unknown);
  });

  stats = (): Effect.Effect<StoreStats, StoreError> => runStoreOperation(() => {
    const databaseBytes = [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]
      .filter(existsSync)
      .reduce((total, path) => total + statSync(path).size, 0);
    return {
      projects: count(this.db, "SELECT COUNT(*) AS count FROM projects"),
      threads: count(this.db, "SELECT COUNT(*) AS count FROM threads"),
      databaseBytes,
    };
  });

  private transaction<A>(operation: () => A): A {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      secureFiles(this.databasePath);
      this.db.exec("COMMIT");
      return result;
    } catch (cause) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // preserve the original failure if SQLite already closed the transaction
      }
      throw cause;
    }
  }

  private itemSequence(item: Record<string, unknown>): number | null {
    const snapshot = isRecord(item.snapshot) ? item.snapshot : null;
    const raw = item.sequence ?? snapshot?.snapshotSequence;
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      throw new StoreError("shell item sequence must be a non-negative integer");
    }
    return raw;
  }

  private scrubStoredThreadShells(): void {
    const rows = this.db.prepare("SELECT id, document FROM threads").all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare("UPDATE threads SET document=? WHERE id=?");
      for (const row of rows) {
        const id = rowString(row, "id");
        const document = rowString(row, "document");
        if (id === null || document === null) throw new StoreError("stored thread metadata is malformed");
        const sanitized = whitelistThreadShell(readThread(JSON.parse(document) as unknown));
        update.run(serialize(sanitized, maxStoredShellChars, "thread shell"), id);
      }
      secureFiles(this.databasePath);
      this.db.exec("COMMIT");
    } catch (cause) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // preserve the original failure if SQLite already closed the transaction
      }
      throw cause;
    }
  }

  private ingestSnapshot(
    stream: SourceItem["stream"],
    item: Record<string, unknown>,
    sequence: number | null,
  ): boolean {
    if (!isRecord(item.snapshot)) throw new StoreError("snapshot item is missing its snapshot payload");
    const snapshot = item.snapshot;
    const currentCursor = rowNumber(getRow(this.db, "SELECT sequence FROM cursors WHERE stream=?", stream), "sequence");
    const hasEnrichmentMarker = item.resolvedRepositoryIdentityRoots !== undefined;
    if (hasEnrichmentMarker && !Array.isArray(item.resolvedRepositoryIdentityRoots)) {
      throw new StoreError("snapshot enrichment roots must be an array");
    }
    if (sequence !== null && sequence < currentCursor && !hasEnrichmentMarker) return false;
    const projects = snapshot.projects;
    const threads = snapshot.threads;
    const archivedThreads = snapshot.archivedThreads;
    if (
      !Array.isArray(projects) ||
      !Array.isArray(threads) ||
      stream === "active" && !Array.isArray(archivedThreads)
    ) {
      throw new StoreError("snapshot is missing project or thread arrays");
    }
    const roots = hasEnrichmentMarker ? item.resolvedRepositoryIdentityRoots as unknown[] : null;
    if (roots !== null && roots.some((root) => typeof root !== "string")) {
      throw new StoreError("snapshot enrichment roots must contain only strings");
    }
    const enrichmentRoots = roots as string[] | null;
    const selectedProjects = enrichmentRoots === null
      ? projects
      : projects.filter((value) => isRecord(value) && enrichmentRoots.includes(String(value.workspaceRoot)));
    for (const value of selectedProjects) this.storeProject(readProject(value));

    if (enrichmentRoots !== null) return false;

    const incoming = stream === "active"
      ? threads
      : Array.isArray(archivedThreads) && archivedThreads.length > 0 ? archivedThreads : threads;
    this.reconcileThreads(stream, incoming);
    for (const value of incoming) {
      const shell = readThread(value);
      this.storeThread(shell, stream === "active" ? "active" : "archive");
    }
    return true;
  }

  private reconcileThreads(stream: SourceItem["stream"], incoming: unknown[]): void {
    const incomingIds = new Set(incoming.map((value) => readThread(value).id));
    const location = stream === "active" ? "active" : "archive";
    const rows = this.db.prepare("SELECT id FROM threads WHERE location=?")
      .all(location) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.id);
      if (!incomingIds.has(id)) this.removeThread(id);
    }
  }

  private storeProject(project: ProjectInfo): void {
    const document = serialize(project, maxStoredShellChars, "project shell");
    this.db.prepare(`
      INSERT INTO projects(id, document, deleted) VALUES (?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET document=excluded.document, deleted=0
    `).run(project.id, document);
  }

  private storeThread(thread: ThreadInfo, location: "active" | "archive"): void {
    const safeThread = whitelistThreadShell(thread);
    const document = serialize(safeThread, maxStoredShellChars, "thread shell");
    const known = count(this.db, "SELECT COUNT(*) AS count FROM threads");
    const existing = getRow(this.db, "SELECT revision FROM threads WHERE id=?", safeThread.id);
    if (existing === undefined && known >= maxKnownThreads) throw new StoreError("known thread capacity reached; refusing to lose archive lookup metadata");
    const revision = this.nextRevision(safeThread.id);
    this.db.prepare(`
      INSERT INTO threads(id, project_id, document, location, revision) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id=excluded.project_id,
        document=excluded.document,
        location=excluded.location,
        revision=excluded.revision
    `).run(safeThread.id, safeThread.projectId, document, location, revision);
  }

  private removeThread(threadId: string): void {
    const id = readString(threadId, "thread id");
    const revision = this.nextRevision(id);
    this.db.prepare("UPDATE threads SET location='removed', revision=? WHERE id=?").run(revision, id);
  }

  private nextRevision(threadId: string): number {
    const row = getRow(this.db, `
      INSERT INTO thread_revisions(thread_id, revision) VALUES (?, 1)
      ON CONFLICT(thread_id) DO UPDATE SET revision=thread_revisions.revision+1
      RETURNING revision
    `, threadId);
    return rowNumber(row, "revision", 1);
  }

  private threadLocation(
    stream: SourceItem["stream"],
    item: Record<string, unknown>,
    shell: ThreadInfo,
  ): "active" | "archive" {
    if (stream === "archive" || item.location === "archive" || shell.archivedAt) return "archive";
    return "active";
  }

}

const acquireStore = (dataDirectory: string): Effect.Effect<SqliteStore, StoreError> =>
  Effect.tryPromise({
    try: () => Promise.resolve().then(() => new SqliteStore(dataDirectory)),
    catch: normalizeFailure,
  });

export const makeStore = (dataDirectory: string): Layer.Layer<Store, StoreError> =>
  Layer.effect(
    Store,
    Effect.acquireRelease(acquireStore(dataDirectory), (store) => Effect.sync(() => store.close())),
  );
