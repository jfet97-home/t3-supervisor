import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Clock, Context, Data, Effect, FileSystem, Layer, Option, type PlatformError, Predicate, Redacted, Schema, Scope } from "effect";
import type { SqlClient } from "effect/sql";
import { AccessDb, accessDbLayer, untracedSql } from "./db.js";

const TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ACCESS_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GRANT_TTL_MS = 5 * 60 * 1_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const CLOCK_ROLLBACK_TOLERANCE_MS = 60_000;
const MAX_PENDING_GRANTS = 32;
const MAX_SESSIONS = 32;
const MAX_DATABASE_BYTES = 1_048_576n;
const GRANT_TABLE = "dashboard_login_grants";
const SESSION_TABLE = "dashboard_login_sessions";
const DATABASE_NAME = "login.sqlite3";
const SEED_NAME = "workflow-mcp-token";

const GRANT_TABLE_SCHEMA =
  "CREATE TABLE dashboard_login_grants (\n" +
  "        token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),\n" +
  "        issued_at INTEGER NOT NULL,\n" +
  "        expires_at INTEGER NOT NULL CHECK(expires_at > issued_at)\n" +
  "      ) STRICT";
const SESSION_TABLE_SCHEMA =
  "CREATE TABLE dashboard_login_sessions (\n" +
  "        token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),\n" +
  "        issued_at INTEGER NOT NULL,\n" +
  "        expires_at INTEGER NOT NULL CHECK(expires_at > issued_at AND expires_at - issued_at <= " + SESSION_TTL_MS + ")\n" +
  "      ) STRICT";

type ServiceAuthPart =
  | "access directory"
  | `${typeof SEED_NAME} file`
  | "database"
  | `${typeof GRANT_TABLE | typeof SESSION_TABLE} ${"table" | "rows"}`;

// a part of the service auth state failed closed; it carries the part name only, never a token, path or cause
export class ServiceAuthUnavailable extends Data.TaggedError("ServiceAuthUnavailable")<{ readonly part: ServiceAuthPart }> {
  // renders as the baseline `Error: invalid service auth <part>` line
  override readonly name = "Error";
  override readonly message: string = `invalid service auth ${this.part}`;
}

const forgeMessages = {
  access_directory: "invalid service auth access directory",
  login_grant_state: "invalid service auth login grant state",
  capacity_reached: "dashboard login grant capacity reached",
} as const;

// a grant could not be issued; the fixed reason only, never the token, path or cause
export class ForgeFailed extends Data.TaggedError("ForgeFailed")<{ readonly reason: keyof typeof forgeMessages }> {
  override readonly name = "Error";
  override readonly message: string = forgeMessages[this.reason];
}

// local outcomes that never leave this module: a non-integer wall clock and a grant that is absent or expired
class InvalidClock extends Data.TaggedError("InvalidClock") {}
class GrantUnavailable extends Data.TaggedError("GrantUnavailable") {}

export class ServiceAuth extends Context.Service<ServiceAuth, {
  // a canonical single-use grant yields a new session; anything else, including the workflow MCP token, yields null
  readonly login: (token: string) => Effect.Effect<Redacted.Redacted<string> | null>;
  readonly authenticated: (session: string | undefined) => Effect.Effect<boolean>;
  // durable revocation, visible to every instance on the same state
  readonly logout: (session: string | undefined) => Effect.Effect<void>;
  // exact `Bearer <token>` against the in-memory workflow MCP token, constant time, no database
  readonly mcpAuthorized: (authorization: string | undefined) => boolean;
}>()("t3-supervisor/ServiceAuth") {
  // one access client for the scope (the dashboard server lifetime), acquired after the private-file checks; after the
  // scope closes every check fails closed
  static readonly layer = (dataDirectory: string): Layer.Layer<ServiceAuth, ServiceAuthUnavailable, FileSystem.FileSystem> =>
    Layer.effect(ServiceAuth, makeServiceAuth(dataDirectory));
}

// node:crypto stays: the frozen layer and forge types require only FileSystem, and these are synchronous computations
const isCanonicalToken = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length !== TOKEN_LENGTH || !TOKEN_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === TOKEN_BYTES && decoded.toString("base64url") === value;
};

const randomToken = (): string => randomBytes(TOKEN_BYTES).toString("base64url");

const tokenHash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

const sameToken = (candidate: string, expected: string): boolean => {
  if (!isCanonicalToken(candidate)) return false;
  return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(expected, "utf8"));
};

// the wall clock as a safe integer; any other reading fails closed
const wallClock = Effect.flatMap(Clock.currentTimeMillis, (now) => Number.isSafeInteger(now) ? Effect.succeed(now) : Effect.fail(new InvalidClock()));

// a failure or defect becomes the closed answer; an interruption stays an interruption
const failClosed = <B>(closed: B) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
  Effect.catchCause(effect, (cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(closed));

// private files: node handles for the identity-checked opens, because the effect FileSystem has no O_NOFOLLOW or
// O_DIRECTORY open flag and no fchmod or fsync on a directory handle; path-level calls go through FileSystem

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

// the errno code of a failed handle call, without its message or path
class FileFailure extends Data.TaggedError("FileFailure")<{ readonly code: string | undefined }> {}

const handleCall = <A>(call: () => Promise<A>): Effect.Effect<A, FileFailure> => Effect.tryPromise({
  try: call,
  catch: (cause) => new FileFailure({ code: Predicate.hasProperty(cause, "code") && typeof cause.code === "string" ? cause.code : undefined }),
});

const openHandle = (path: string, flags: number, mode?: number): Effect.Effect<FileHandle, FileFailure, Scope.Scope> =>
  Effect.acquireRelease(handleCall(() => open(path, flags, mode)), (handle) => Effect.ignore(handleCall(() => handle.close())));

const handleStat = (handle: FileHandle): Effect.Effect<BigIntStats, FileFailure> => handleCall(() => handle.stat({ bigint: true }));

const statIdentity = (stat: BigIntStats): Identity => ({ dev: stat.dev, ino: stat.ino });

const infoIdentity = (info: FileSystem.File.Info): Identity | undefined =>
  Option.match(info.ino, { onNone: () => undefined, onSome: (ino) => ({ dev: info.dev, ino }) });

const sameIdentity = (left: Identity | undefined, right: Identity | undefined): boolean =>
  left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;

const isNotFound = (error: PlatformError.PlatformError): boolean => error.reason._tag === "NotFound";

// the named entry without following a link, or none when it does not exist
const lstatOption = (fs: FileSystem.FileSystem, path: string): Effect.Effect<Option.Option<FileSystem.File.Info>, PlatformError.PlatformError> =>
  fs.lstat(path).pipe(Effect.map(Option.some), Effect.catchIf(isNotFound, () => Effect.succeedNone));

const unlinkIfSameFile = (fs: FileSystem.FileSystem, path: string, expected: Identity | undefined): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    if (expected === undefined) return;
    const current = yield* lstatOption(fs, path);
    if (Option.isSome(current) && current.value.type === "File" && sameIdentity(infoIdentity(current.value), expected)) {
      yield* fs.remove(path).pipe(Effect.catchIf(isNotFound, () => Effect.void));
    }
  });

// links the finished temporary file under its final name; false when another creator linked first
const linkOnce = (fs: FileSystem.FileSystem, from: string, to: string): Effect.Effect<boolean, PlatformError.PlatformError> =>
  fs.link(from, to).pipe(Effect.as(true), Effect.catchIf((error) => error.reason._tag === "AlreadyExists", () => Effect.succeed(false)));

const openAccessDirectory = (fs: FileSystem.FileSystem, dataDirectory: string, create: boolean): Effect.Effect<FileHandle, ServiceAuthUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    const path = join(dataDirectory, "access");
    const invalid = new ServiceAuthUnavailable({ part: "access directory" });
    if (create) yield* fs.makeDirectory(path, { recursive: true, mode: ACCESS_DIRECTORY_MODE });
    const named = yield* fs.lstat(path);
    if (named.type !== "Directory") return yield* invalid;
    const handle = yield* openHandle(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = yield* handleStat(handle);
    const current = yield* fs.lstat(path);
    if (
      !opened.isDirectory() ||
      current.type !== "Directory" ||
      !sameIdentity(statIdentity(opened), infoIdentity(named)) ||
      !sameIdentity(statIdentity(opened), infoIdentity(current))
    ) return yield* invalid;
    yield* handleCall(() => handle.chmod(ACCESS_DIRECTORY_MODE));
    return handle;
  }).pipe(Effect.mapError(() => new ServiceAuthUnavailable({ part: "access directory" })));

const seedFailure = new ServiceAuthUnavailable({ part: `${SEED_NAME} file` });

// the existing seed, failing with the open's errno when the file cannot be opened (ENOENT: not created yet)
const readSeed = (path: string): Effect.Effect<string, ServiceAuthUnavailable | FileFailure> =>
  Effect.scoped(Effect.gen(function* () {
    const handle = yield* openHandle(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return yield* Effect.gen(function* () {
      const before = yield* handleStat(handle);
      if (!before.isFile()) return yield* seedFailure;
      yield* handleCall(() => handle.chmod(PRIVATE_FILE_MODE));
      if (before.size !== BigInt(TOKEN_LENGTH)) return yield* seedFailure;

      const bytes = Buffer.alloc(TOKEN_LENGTH + 1);
      const { bytesRead } = yield* handleCall(() => handle.read(bytes, 0, bytes.length, 0));
      const after = yield* handleStat(handle);
      if (bytesRead !== TOKEN_LENGTH || after.size !== BigInt(TOKEN_LENGTH)) return yield* seedFailure;

      const token = bytes.subarray(0, bytesRead).toString("utf8");
      if (!isCanonicalToken(token)) return yield* seedFailure;
      return token;
    }).pipe(Effect.mapError(() => seedFailure));
  }));

const createSeed = (fs: FileSystem.FileSystem, directory: string, directoryHandle: FileHandle): Effect.Effect<string, ServiceAuthUnavailable> => {
  const path = join(directory, SEED_NAME);
  const temporaryPath = join(directory, `.${SEED_NAME}.${randomBytes(16).toString("hex")}.tmp`);
  const token = randomToken();
  const temporary: { identity: Identity | undefined } = { identity: undefined };
  return Effect.gen(function* () {
    yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* openHandle(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        PRIVATE_FILE_MODE,
      );
      const initialStat = yield* handleStat(handle);
      if (!initialStat.isFile()) return yield* seedFailure;
      temporary.identity = statIdentity(initialStat);
      yield* handleCall(() => handle.writeFile(token, { encoding: "ascii" }));
      yield* handleCall(() => handle.chmod(PRIVATE_FILE_MODE));
      yield* handleCall(() => handle.sync());
      const stat = yield* handleStat(handle);
      if (!stat.isFile() || stat.size !== BigInt(TOKEN_LENGTH)) return yield* seedFailure;
      temporary.identity = statIdentity(stat);

      const temporaryPathStat = yield* fs.lstat(temporaryPath);
      if (temporaryPathStat.type !== "File" || !sameIdentity(infoIdentity(temporaryPathStat), temporary.identity)) return yield* seedFailure;
    }));

    if (!(yield* linkOnce(fs, temporaryPath, path))) {
      yield* unlinkIfSameFile(fs, temporaryPath, temporary.identity);
      temporary.identity = undefined;
      return yield* readSeed(path);
    }

    const finalPathStat = yield* fs.lstat(path);
    if (finalPathStat.type !== "File" || !sameIdentity(infoIdentity(finalPathStat), temporary.identity)) return yield* seedFailure;
    yield* handleCall(() => directoryHandle.sync());
    return token;
  }).pipe(
    Effect.ensuring(Effect.ignore(Effect.suspend(() => unlinkIfSameFile(fs, temporaryPath, temporary.identity)))),
    Effect.mapError(() => seedFailure),
  );
};

const loadOrCreateSeed = (fs: FileSystem.FileSystem, directory: string, directoryHandle: FileHandle): Effect.Effect<string, ServiceAuthUnavailable> =>
  readSeed(join(directory, SEED_NAME)).pipe(Effect.catchTag("FileFailure", (failure) =>
    failure.code === "ENOENT" ? createSeed(fs, directory, directoryHandle) : Effect.fail(seedFailure)));

// stored rows and catalog reads, decoded; a mismatch fails closed with the part being validated

const SafeInteger = Schema.Int;
const AuthRow = Schema.Struct({
  token_hash: Schema.String.check(Schema.isPattern(HASH_PATTERN)),
  issued_at: SafeInteger,
  expires_at: SafeInteger,
});
const CountRow = Schema.Struct({ count: SafeInteger });
const QuickCheck = Schema.Struct({ quick_check: Schema.String });
const JournalMode = Schema.Struct({ journal_mode: Schema.String });
const CatalogObject = Schema.Struct({ type: Schema.String, name: Schema.String });
const TableSql = Schema.Struct({ sql: Schema.String });
const ColumnInfo = Schema.Struct({ name: Schema.Unknown, type: Schema.Unknown, notnull: Schema.Unknown, pk: Schema.Unknown });

const decodeRows = <S extends Schema.Decoder<unknown>>(schema: S) => Schema.decodeUnknownEffect(Schema.Array(schema));

const normalizeSchemaSql = (sql: string): string => sql.replace(/\s+/gu, "").replace(/;$/u, "").toLowerCase();

const rowCount = (db: SqlClient.SqlClient, tableName: string) =>
  db.unsafe("SELECT COUNT(*) AS count FROM " + tableName).pipe(Effect.flatMap(decodeRows(CountRow)), Effect.map((rows) => rows[0]?.count));

const validateTableSchema = (db: SqlClient.SqlClient, tableName: typeof GRANT_TABLE | typeof SESSION_TABLE, schema: string) =>
  Effect.gen(function* () {
    const invalid = new ServiceAuthUnavailable({ part: `${tableName} table` });
    const [table] = yield* db.unsafe("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [tableName]).pipe(Effect.flatMap(decodeRows(TableSql)));
    if (table === undefined || normalizeSchemaSql(table.sql) !== normalizeSchemaSql(schema)) return yield* invalid;

    const columns = yield* db.unsafe("PRAGMA table_info(" + tableName + ")").pipe(Effect.flatMap(decodeRows(ColumnInfo)));
    const expected = [
      { name: "token_hash", type: "TEXT", notnull: 1, pk: 1 },
      { name: "issued_at", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "expires_at", type: "INTEGER", notnull: 1, pk: 0 },
    ];
    if (columns.length !== expected.length || columns.some((column, index) => {
      const wanted = expected[index];
      return wanted === undefined || column.name !== wanted.name || column.type !== wanted.type ||
        column.notnull !== wanted.notnull || column.pk !== wanted.pk;
    })) return yield* invalid;
  }).pipe(Effect.mapError(() => new ServiceAuthUnavailable({ part: `${tableName} table` })));

const validateRows = (db: SqlClient.SqlClient, tableName: typeof GRANT_TABLE | typeof SESSION_TABLE, maxRows: number, maxTtl?: number) =>
  Effect.gen(function* () {
    const invalid = new ServiceAuthUnavailable({ part: `${tableName} rows` });
    const count = yield* rowCount(db, tableName);
    if (count === undefined || count > maxRows) return yield* invalid;
    const rows = yield* db.unsafe("SELECT token_hash, issued_at, expires_at FROM " + tableName).pipe(Effect.flatMap(decodeRows(AuthRow)));
    if (rows.some((row) => row.expires_at <= row.issued_at || (maxTtl !== undefined && row.expires_at - row.issued_at > maxTtl))) {
      return yield* invalid;
    }
  }).pipe(Effect.mapError(() => new ServiceAuthUnavailable({ part: `${tableName} rows` })));

const validateDatabase = (db: SqlClient.SqlClient): Effect.Effect<void, ServiceAuthUnavailable> =>
  Effect.gen(function* () {
    const invalid = new ServiceAuthUnavailable({ part: "database" });
    const [integrity] = yield* db.unsafe("PRAGMA quick_check").pipe(Effect.flatMap(decodeRows(QuickCheck)), Effect.mapError(() => invalid));
    if (integrity?.quick_check !== "ok") return yield* invalid;
    const [journal] = yield* db.unsafe("PRAGMA journal_mode").pipe(Effect.flatMap(decodeRows(JournalMode)), Effect.mapError(() => invalid));
    if (journal === undefined || journal.journal_mode.toLowerCase() !== "delete") return yield* invalid;

    const objects = yield* db.unsafe("SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name").pipe(
      Effect.flatMap(decodeRows(CatalogObject)), Effect.mapError(() => invalid));
    if (
      objects.length !== 2 ||
      objects[0]?.type !== "table" || objects[0]?.name !== GRANT_TABLE ||
      objects[1]?.type !== "table" || objects[1]?.name !== SESSION_TABLE
    ) return yield* invalid;
    yield* validateTableSchema(db, GRANT_TABLE, GRANT_TABLE_SCHEMA);
    yield* validateTableSchema(db, SESSION_TABLE, SESSION_TABLE_SCHEMA);
    yield* validateRows(db, GRANT_TABLE, MAX_PENDING_GRANTS);
    yield* validateRows(db, SESSION_TABLE, MAX_SESSIONS, SESSION_TTL_MS);
  });

// the access client on a file, in the caller's scope (the only AccessDb client while that scope is open)
const accessClient = (path: string): Effect.Effect<SqlClient.SqlClient, ServiceAuthUnavailable, Scope.Scope> =>
  Layer.build(accessDbLayer(path)).pipe(Effect.map(Context.get(AccessDb)), Effect.mapError(() => new ServiceAuthUnavailable({ part: "database" })));

// identity before the open (O_NOFOLLOW handle, size bounds, fchmod 0600) and lstat re-check after it, then validation
const openPrivateDatabase = (fs: FileSystem.FileSystem, path: string): Effect.Effect<SqlClient.SqlClient, ServiceAuthUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    const invalid = new ServiceAuthUnavailable({ part: "database" });
    const named = yield* fs.lstat(path);
    if (named.type !== "File" || named.size === 0n || named.size > MAX_DATABASE_BYTES) return yield* invalid;

    const identity = yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* openHandle(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const openedStat = yield* handleStat(handle);
      const currentStat = yield* fs.lstat(path);
      if (
        !openedStat.isFile() ||
        openedStat.size === 0n ||
        openedStat.size > MAX_DATABASE_BYTES ||
        currentStat.type !== "File" ||
        !sameIdentity(statIdentity(openedStat), infoIdentity(named)) ||
        !sameIdentity(statIdentity(openedStat), infoIdentity(currentStat))
      ) return yield* invalid;
      yield* handleCall(() => handle.chmod(PRIVATE_FILE_MODE));
      return statIdentity(openedStat);
    }));

    const db = yield* accessClient(path);
    const currentStat = yield* fs.lstat(path);
    if (currentStat.type !== "File" || !sameIdentity(infoIdentity(currentStat), identity)) return yield* invalid;
    yield* validateDatabase(db);
    return db;
  }).pipe(Effect.mapError(() => new ServiceAuthUnavailable({ part: "database" })));

// only the service bootstraps: a private temporary file gets the schema through its own short-lived client, is
// validated, linked under the final name and the directory synced; a concurrent creator's file wins
const initializeDatabaseFile = (fs: FileSystem.FileSystem, directory: string, directoryHandle: FileHandle): Effect.Effect<SqlClient.SqlClient, ServiceAuthUnavailable, Scope.Scope> => {
  const path = join(directory, DATABASE_NAME);
  const temporaryPath = join(directory, "." + DATABASE_NAME + "." + randomBytes(16).toString("hex") + ".tmp");
  const temporary: { identity: Identity | undefined } = { identity: undefined };
  const invalid = new ServiceAuthUnavailable({ part: "database" });
  return Effect.gen(function* () {
    yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* openHandle(
        temporaryPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        PRIVATE_FILE_MODE,
      );
      const initialStat = yield* handleStat(handle);
      if (!initialStat.isFile()) return yield* invalid;
      temporary.identity = statIdentity(initialStat);
      yield* handleCall(() => handle.chmod(PRIVATE_FILE_MODE));
    }));

    yield* Effect.scoped(Effect.gen(function* () {
      const db = yield* accessClient(temporaryPath);
      yield* db.unsafe("PRAGMA journal_mode=DELETE");
      yield* db.unsafe(GRANT_TABLE_SCHEMA);
      yield* db.unsafe(SESSION_TABLE_SCHEMA);
      yield* validateDatabase(db);
    }));

    yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* openHandle(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const completedStat = yield* handleStat(handle);
      if (!completedStat.isFile() || completedStat.size === 0n || completedStat.size > MAX_DATABASE_BYTES) return yield* invalid;
      temporary.identity = statIdentity(completedStat);
      const namedTemporaryStat = yield* fs.lstat(temporaryPath);
      if (namedTemporaryStat.type !== "File" || !sameIdentity(infoIdentity(namedTemporaryStat), temporary.identity)) return yield* invalid;
      yield* handleCall(() => handle.chmod(PRIVATE_FILE_MODE));
      yield* handleCall(() => handle.sync());
    }));

    if (!(yield* linkOnce(fs, temporaryPath, path))) {
      yield* unlinkIfSameFile(fs, temporaryPath, temporary.identity);
      temporary.identity = undefined;
      return yield* openPrivateDatabase(fs, path);
    }
    const finalStat = yield* fs.lstat(path);
    if (finalStat.type !== "File" || !sameIdentity(infoIdentity(finalStat), temporary.identity)) return yield* invalid;
    yield* handleCall(() => directoryHandle.sync());
    return yield* openPrivateDatabase(fs, path);
  }).pipe(
    Effect.ensuring(Effect.ignore(Effect.suspend(() => unlinkIfSameFile(fs, temporaryPath, temporary.identity)))),
    Effect.mapError((error) => error instanceof ServiceAuthUnavailable ? error : invalid),
  );
};

const loadOrCreateDatabase = (fs: FileSystem.FileSystem, directory: string, directoryHandle: FileHandle): Effect.Effect<SqlClient.SqlClient, ServiceAuthUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    const path = join(directory, DATABASE_NAME);
    const existing = yield* lstatOption(fs, path).pipe(Effect.mapError(() => new ServiceAuthUnavailable({ part: "database" })));
    if (Option.isNone(existing)) return yield* initializeDatabaseFile(fs, directory, directoryHandle);
    if (existing.value.type !== "File") return yield* new ServiceAuthUnavailable({ part: "database" });
    return yield* openPrivateDatabase(fs, path);
  });

const makeServiceAuth = (dataDirectory: string): Effect.Effect<ServiceAuth["Service"], ServiceAuthUnavailable, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scope = yield* Effect.scope;
    const accessDirectory = join(dataDirectory, "access");
    // the directory handle stays open while the seed and the database are prepared; the client lives in the layer scope
    const { workflowMcpToken, db } = yield* Effect.scoped(Effect.gen(function* () {
      const directoryHandle = yield* openAccessDirectory(fs, dataDirectory, true);
      const workflowMcpToken = yield* loadOrCreateSeed(fs, accessDirectory, directoryHandle);
      const db = yield* loadOrCreateDatabase(fs, accessDirectory, directoryHandle).pipe(Scope.provide(scope));
      return { workflowMcpToken, db };
    }));

    // registered after the client, so every check fails closed before the client itself closes
    let closed = false;
    yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true; }));

    const sessionCount = rowCount(db, SESSION_TABLE);

    const login = (token: string): Effect.Effect<Redacted.Redacted<string> | null> => Effect.gen(function* () {
      if (closed) return null;
      const currentTime = yield* wallClock;
      if (!isCanonicalToken(token) || sameToken(token, workflowMcpToken)) return null;
      const expiresAt = currentTime + SESSION_TTL_MS;
      if (!Number.isSafeInteger(expiresAt)) return null;

      // grant consumption, expiry pruning, eviction at the cap and the insert commit together or not at all
      const session = yield* db.withTransaction(Effect.gen(function* () {
        const consumed = yield* db.unsafe(`DELETE FROM ${GRANT_TABLE} WHERE token_hash=? AND expires_at>? RETURNING token_hash`, [tokenHash(token), currentTime]);
        if (consumed.length === 0) return yield* new GrantUnavailable();
        yield* db.unsafe(`DELETE FROM ${SESSION_TABLE} WHERE expires_at<=?`, [currentTime]);
        const count = yield* sessionCount;
        if (count === undefined || count > MAX_SESSIONS) return yield* new ServiceAuthUnavailable({ part: `${SESSION_TABLE} rows` });
        if (count === MAX_SESSIONS) {
          yield* db.unsafe(`DELETE FROM ${SESSION_TABLE} WHERE rowid=(SELECT rowid FROM ${SESSION_TABLE} ORDER BY issued_at ASC, rowid ASC LIMIT 1)`);
        }

        let session = randomToken();
        while ((yield* db.unsafe(`SELECT 1 FROM ${SESSION_TABLE} WHERE token_hash=?`, [tokenHash(session)])).length > 0) session = randomToken();
        yield* db.unsafe(`INSERT INTO ${SESSION_TABLE}(token_hash,issued_at,expires_at) VALUES(?,?,?)`, [tokenHash(session), currentTime, expiresAt]);
        return session;
      }));
      return Redacted.make(session);
    }).pipe(failClosed(null), untracedSql);

    const authenticated = (session: string | undefined): Effect.Effect<boolean> => Effect.gen(function* () {
      if (closed) return false;
      const currentTime = yield* wallClock;
      if (!isCanonicalToken(session)) return false;
      const latestIssuedAt = currentTime + CLOCK_ROLLBACK_TOLERANCE_MS;
      if (!Number.isSafeInteger(latestIssuedAt)) return false;
      const live = yield* db.unsafe(`SELECT 1 FROM ${SESSION_TABLE} WHERE token_hash=? AND issued_at<=? AND expires_at>?`,
        [tokenHash(session), latestIssuedAt, currentTime]);
      return live.length > 0;
    }).pipe(failClosed(false), untracedSql);

    // a failed revocation is a defect, so the request that asked for it fails as before
    const logout = (session: string | undefined): Effect.Effect<void> => Effect.gen(function* () {
      if (closed || !isCanonicalToken(session)) return;
      yield* db.unsafe(`DELETE FROM ${SESSION_TABLE} WHERE token_hash=?`, [tokenHash(session)]);
    }).pipe(Effect.orDie, untracedSql);

    const mcpAuthorized = (authorization: string | undefined): boolean => {
      if (closed) return false;
      if (typeof authorization !== "string" || authorization.length !== 7 + TOKEN_LENGTH) return false;
      if (!authorization.startsWith("Bearer ")) return false;
      return sameToken(authorization.slice(7), workflowMcpToken);
    };

    return ServiceAuth.of({ login, authenticated, logout, mcpAuthorized });
  }).pipe(untracedSql);

// a single-use dashboard grant on an initialized instance, over its own short-lived access client; it never creates
// the access directory or the database
export const forgeDashboardToken = (
  dataDirectory: string,
): Effect.Effect<{ readonly token: Redacted.Redacted<string>; readonly expiresAt: number }, ForgeFailed, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* openAccessDirectory(fs, dataDirectory, false).pipe(Effect.mapError(() => new ForgeFailed({ reason: "access_directory" })));
    return yield* Effect.gen(function* () {
      const db = yield* openPrivateDatabase(fs, join(dataDirectory, "access", DATABASE_NAME));
      const now = yield* wallClock;
      const expiresAt = now + GRANT_TTL_MS;
      if (!Number.isSafeInteger(expiresAt)) return yield* new InvalidClock();
      const token = randomToken();

      yield* db.withTransaction(Effect.gen(function* () {
        yield* db.unsafe(`DELETE FROM ${GRANT_TABLE} WHERE expires_at<=?`, [now]);
        const count = yield* rowCount(db, GRANT_TABLE);
        if (count === undefined) return yield* new ServiceAuthUnavailable({ part: `${GRANT_TABLE} rows` });
        if (count >= MAX_PENDING_GRANTS) return yield* new ForgeFailed({ reason: "capacity_reached" });
        yield* db.unsafe(`INSERT INTO ${GRANT_TABLE}(token_hash,issued_at,expires_at) VALUES(?,?,?)`, [tokenHash(token), now, expiresAt]);
      }));
      return { token: Redacted.make(token), expiresAt };
    }).pipe(Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const failure = Cause.squash(cause);
      return Effect.fail(failure instanceof ForgeFailed ? failure : new ForgeFailed({ reason: "login_grant_state" }));
    }));
  }).pipe(Effect.scoped, untracedSql);
