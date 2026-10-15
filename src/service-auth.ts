import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

const TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ACCESS_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GRANT_TTL_MS = 5 * 60 * 1_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_PENDING_GRANTS = 32;
const MAX_SESSIONS = 32;
const MAX_DATABASE_BYTES = 1_048_576;
const DATABASE_PAGE_LIMIT = 256;
const GRANT_TABLE = "dashboard_login_grants";
const DATABASE_NAME = "login.sqlite3";

export interface ServiceAuthOptions {
  now?: () => number;
}

export interface ServiceAuth {
  login(token: string): string | null;
  authenticated(session: string | undefined): boolean;
  logout(session: string | undefined): void;
  mcpAuthorized(authorization: string | undefined): boolean;
  close(): void;
}

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

const fileIdentityMatches = (
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean => left.dev === right.dev && left.ino === right.ino;

const authError = (name: string): Error => new Error(`invalid service auth ${name}`);

const openAccessDirectory = async (dataDirectory: string, create: boolean): Promise<FileHandle> => {
  const path = join(dataDirectory, "access");
  if (create) await mkdir(path, { recursive: true, mode: ACCESS_DIRECTORY_MODE });
  let namedStat;
  try {
    namedStat = await lstat(path);
  } catch {
    throw authError("access directory");
  }
  if (!namedStat.isDirectory()) throw authError("access directory");

  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw authError("access directory");
  }
  try {
    const openedStat = await handle.stat();
    const currentStat = await lstat(path);
    if (
      !openedStat.isDirectory() ||
      !currentStat.isDirectory() ||
      !fileIdentityMatches(openedStat, namedStat) ||
      !fileIdentityMatches(openedStat, currentStat)
    ) throw authError("access directory");
    await handle.chmod(ACCESS_DIRECTORY_MODE);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const readSeed = async (path: string, name: string): Promise<string> => {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw authError(`${name} file`);
    await handle.chmod(PRIVATE_FILE_MODE);
    if (before.size !== TOKEN_LENGTH) throw authError(`${name} file`);

    const bytes = Buffer.alloc(TOKEN_LENGTH + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== TOKEN_LENGTH || after.size !== TOKEN_LENGTH) throw authError(`${name} file`);

    const token = bytes.subarray(0, bytesRead).toString("utf8");
    if (!isCanonicalToken(token)) throw authError(`${name} file`);
    return token;
  } finally {
    await handle.close();
  }
};

const unlinkIfSameFile = async (
  path: string,
  expected: { dev: number; ino: number } | undefined,
): Promise<void> => {
  if (expected === undefined) return;
  try {
    const current = await lstat(path);
    if (current.isFile() && fileIdentityMatches(current, expected)) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const createSeed = async (
  directory: string,
  directoryHandle: FileHandle,
  name: string,
): Promise<string> => {
  const path = join(directory, name);
  const temporaryPath = join(directory, `.${name}.${randomBytes(16).toString("hex")}.tmp`);
  const token = randomToken();
  let temporaryHandle: FileHandle | undefined;
  let temporaryIdentity: { dev: number; ino: number } | undefined;

  try {
    temporaryHandle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      PRIVATE_FILE_MODE,
    );
    const initialStat = await temporaryHandle.stat();
    if (!initialStat.isFile()) throw authError(`${name} file`);
    temporaryIdentity = { dev: initialStat.dev, ino: initialStat.ino };
    await temporaryHandle.writeFile(token, { encoding: "ascii" });
    await temporaryHandle.chmod(PRIVATE_FILE_MODE);
    await temporaryHandle.sync();
    const stat = await temporaryHandle.stat();
    if (!stat.isFile() || stat.size !== TOKEN_LENGTH) throw authError(`${name} file`);
    temporaryIdentity = { dev: stat.dev, ino: stat.ino };

    const temporaryPathStat = await lstat(temporaryPath);
    if (!temporaryPathStat.isFile() || !fileIdentityMatches(temporaryPathStat, temporaryIdentity)) {
      throw authError(`${name} file`);
    }
    await temporaryHandle.close();
    temporaryHandle = undefined;

    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await unlinkIfSameFile(temporaryPath, temporaryIdentity);
      temporaryIdentity = undefined;
      return await readSeed(path, name);
    }

    const finalPathStat = await lstat(path);
    if (!finalPathStat.isFile() || !fileIdentityMatches(finalPathStat, temporaryIdentity)) {
      throw authError(`${name} file`);
    }
    await directoryHandle.sync();
    return token;
  } finally {
    if (temporaryHandle !== undefined) await temporaryHandle.close();
    await unlinkIfSameFile(temporaryPath, temporaryIdentity);
  }
};

const loadOrCreateSeed = async (
  directory: string,
  directoryHandle: FileHandle,
  name: string,
): Promise<string> => {
  const path = join(directory, name);
  try {
    return await readSeed(path, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return createSeed(directory, directoryHandle, name);
};

const newDatabaseConnection = (path: string): DatabaseSync => new DatabaseSync(path);

const configureDatabase = (database: DatabaseSync): void => {
  database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
};

const validateDatabase = (database: DatabaseSync): void => {
  const integrity = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  if (integrity?.quick_check !== "ok") throw authError("login database");
  const journal = database.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined;
  if (typeof journal?.journal_mode !== "string" || journal.journal_mode.toLowerCase() !== "delete") {
    throw authError("login database");
  }

  const objects = database.prepare(
    "SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
  ).all() as Array<Record<string, unknown>>;
  if (objects.length !== 1 || objects[0]?.type !== "table" || objects[0]?.name !== GRANT_TABLE) {
    throw authError("login database");
  }
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(GRANT_TABLE) as Record<string, unknown> | undefined;
  if (typeof table?.sql !== "string" || !/\bSTRICT\s*$/iu.test(table.sql)) throw authError("login database");

  const columns = database.prepare(`PRAGMA table_info(${GRANT_TABLE})`).all() as Array<Record<string, unknown>>;
  const expected = [
    {name: "token_hash", type: "TEXT", notnull: 1, pk: 1},
    {name: "issued_at", type: "INTEGER", notnull: 1, pk: 0},
    {name: "expires_at", type: "INTEGER", notnull: 1, pk: 0},
  ];
  if (columns.length !== expected.length || columns.some((column, index) => {
    const wanted = expected[index];
    return wanted === undefined || column.name !== wanted.name || column.type !== wanted.type ||
      column.notnull !== wanted.notnull || column.pk !== wanted.pk;
  })) throw authError("login database");

  const countRow = database.prepare(`SELECT COUNT(*) AS count FROM ${GRANT_TABLE}`).get() as Record<string, unknown> | undefined;
  const count = countRow?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count > MAX_PENDING_GRANTS) {
    throw authError("login database");
  }
  const grants = database.prepare(`SELECT token_hash, issued_at, expires_at FROM ${GRANT_TABLE}`).all() as Array<Record<string, unknown>>;
  if (grants.some(grant =>
    typeof grant.token_hash !== "string" || !HASH_PATTERN.test(grant.token_hash) ||
    typeof grant.issued_at !== "number" || !Number.isSafeInteger(grant.issued_at) ||
    typeof grant.expires_at !== "number" || !Number.isSafeInteger(grant.expires_at) ||
    grant.expires_at <= grant.issued_at
  )) throw authError("login database");
};

const closeDatabaseQuietly = (database: DatabaseSync | undefined): void => {
  try { database?.close(); } catch { /* already closed */ }
};

const openLoginDatabase = async (path: string): Promise<DatabaseSync> => {
  let namedStat;
  try {
    namedStat = await lstat(path);
  } catch {
    throw authError("login database");
  }
  if (!namedStat.isFile() || namedStat.size === 0 || namedStat.size > MAX_DATABASE_BYTES) {
    throw authError("login database");
  }

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw authError("login database");
  }
  let identity: {dev: number; ino: number};
  try {
    const openedStat = await handle.stat();
    const currentStat = await lstat(path);
    if (
      !openedStat.isFile() ||
      openedStat.size === 0 ||
      openedStat.size > MAX_DATABASE_BYTES ||
      !currentStat.isFile() ||
      !fileIdentityMatches(openedStat, namedStat) ||
      !fileIdentityMatches(openedStat, currentStat)
    ) throw authError("login database");
    await handle.chmod(PRIVATE_FILE_MODE);
    identity = {dev: openedStat.dev, ino: openedStat.ino};
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();

  let database: DatabaseSync | undefined;
  try {
    database = newDatabaseConnection(path);
    const currentStat = await lstat(path);
    if (!currentStat.isFile() || !fileIdentityMatches(currentStat, identity)) throw authError("login database");
    configureDatabase(database);
    validateDatabase(database);
    return database;
  } catch {
    closeDatabaseQuietly(database);
    throw authError("login database");
  }
};

const initializeDatabaseFile = async (
  directory: string,
  directoryHandle: FileHandle,
): Promise<DatabaseSync> => {
  const path = join(directory, DATABASE_NAME);
  const temporaryPath = join(directory, `.${DATABASE_NAME}.${randomBytes(16).toString("hex")}.tmp`);
  let temporaryHandle: FileHandle | undefined;
  let identity: {dev: number; ino: number} | undefined;
  let database: DatabaseSync | undefined;
  try {
    temporaryHandle = await open(
      temporaryPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      PRIVATE_FILE_MODE,
    );
    const initialStat = await temporaryHandle.stat();
    if (!initialStat.isFile()) throw authError("login database");
    identity = {dev: initialStat.dev, ino: initialStat.ino};
    await temporaryHandle.chmod(PRIVATE_FILE_MODE);
    await temporaryHandle.close();
    temporaryHandle = undefined;

    database = newDatabaseConnection(temporaryPath);
    database.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=${DATABASE_PAGE_LIMIT};
      CREATE TABLE ${GRANT_TABLE} (
        token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at > issued_at)
      ) STRICT;`);
    validateDatabase(database);
    database.close();
    database = undefined;

    temporaryHandle = await open(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const completedStat = await temporaryHandle.stat();
    if (!completedStat.isFile() || completedStat.size === 0 || completedStat.size > MAX_DATABASE_BYTES) {
      throw authError("login database");
    }
    identity = {dev: completedStat.dev, ino: completedStat.ino};
    const namedTemporaryStat = await lstat(temporaryPath);
    if (!namedTemporaryStat.isFile() || !fileIdentityMatches(namedTemporaryStat, identity)) {
      throw authError("login database");
    }
    await temporaryHandle.chmod(PRIVATE_FILE_MODE);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await unlinkIfSameFile(temporaryPath, identity);
      identity = undefined;
      return await openLoginDatabase(path);
    }
    const finalStat = await lstat(path);
    if (!finalStat.isFile() || !fileIdentityMatches(finalStat, identity)) throw authError("login database");
    await directoryHandle.sync();
    return await openLoginDatabase(path);
  } finally {
    closeDatabaseQuietly(database);
    if (temporaryHandle !== undefined) await temporaryHandle.close();
    await unlinkIfSameFile(temporaryPath, identity);
  }
};

const loadOrCreateDatabase = async (
  directory: string,
  directoryHandle: FileHandle,
): Promise<DatabaseSync> => {
  const path = join(directory, DATABASE_NAME);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw authError("login database");
    return await openLoginDatabase(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return initializeDatabaseFile(directory, directoryHandle);
};

const readNow = (now: () => number): number => {
  const value = now();
  if (!Number.isSafeInteger(value)) throw new Error("service auth clock must return a safe integer");
  return value;
};

const sessionHash = (session: string): string => tokenHash(session);

export const createServiceAuth = async (
  dataDirectory: string,
  options: ServiceAuthOptions = {},
): Promise<ServiceAuth> => {
  const accessDirectory = join(dataDirectory, "access");
  const directoryHandle = await openAccessDirectory(dataDirectory, true);
  let workflowMcpToken: string;
  let database: DatabaseSync;
  try {
    workflowMcpToken = await loadOrCreateSeed(accessDirectory, directoryHandle, "workflow-mcp-token");
    database = await loadOrCreateDatabase(accessDirectory, directoryHandle);
  } finally {
    await directoryHandle.close();
  }

  const now = options.now ?? Date.now;
  const sessions = new Map<string, number>();
  let closed = false;
  const pruneExpired = (currentTime: number): void => {
    for (const [hash, expiresAt] of sessions) {
      if (expiresAt <= currentTime) sessions.delete(hash);
    }
  };
  const consumeGrant = database.prepare(
    `DELETE FROM ${GRANT_TABLE} WHERE token_hash=? AND expires_at>? RETURNING token_hash`,
  );

  return {
    login(token) {
      if (closed) return null;
      const currentTime = readNow(now);
      pruneExpired(currentTime);
      if (!isCanonicalToken(token) || sameToken(token, workflowMcpToken)) return null;
      const consumed = consumeGrant.get(tokenHash(token), currentTime);
      if (consumed === undefined) return null;

      let session = randomToken();
      let hash = sessionHash(session);
      while (sessions.has(hash)) {
        session = randomToken();
        hash = sessionHash(session);
      }
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      sessions.set(hash, currentTime + SESSION_TTL_MS);
      return session;
    },
    authenticated(session) {
      if (closed) return false;
      const currentTime = readNow(now);
      pruneExpired(currentTime);
      if (!isCanonicalToken(session)) return false;
      return sessions.has(sessionHash(session));
    },
    logout(session) {
      if (closed || !isCanonicalToken(session)) return;
      sessions.delete(sessionHash(session));
    },
    mcpAuthorized(authorization) {
      if (closed) return false;
      if (typeof authorization !== "string" || authorization.length !== 7 + TOKEN_LENGTH) return false;
      if (!authorization.startsWith("Bearer ")) return false;
      return sameToken(authorization.slice(7), workflowMcpToken);
    },
    close() {
      if (closed) return;
      database.close();
      closed = true;
      sessions.clear();
    },
  };
};

export const forgeDashboardToken = async (
  dataDirectory: string,
  options: ServiceAuthOptions = {},
): Promise<{token: string; expiresAt: number}> => {
  const directoryHandle = await openAccessDirectory(dataDirectory, false);
  let database: DatabaseSync | undefined;
  try {
    database = await openLoginDatabase(join(dataDirectory, "access", DATABASE_NAME));
    const now = readNow(options.now ?? Date.now);
    const expiresAt = now + GRANT_TTL_MS;
    if (!Number.isSafeInteger(expiresAt)) throw new Error("service auth grant expiry is invalid");
    const token = randomToken();
    const hash = tokenHash(token);

    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`DELETE FROM ${GRANT_TABLE} WHERE expires_at<=?`).run(now);
      const countRow = database.prepare(`SELECT COUNT(*) AS count FROM ${GRANT_TABLE}`).get() as Record<string, unknown> | undefined;
      const count = countRow?.count;
      if (typeof count !== "number" || !Number.isSafeInteger(count)) throw authError("login database");
      if (count >= MAX_PENDING_GRANTS) throw new Error("dashboard login grant capacity reached");
      database.prepare(`INSERT INTO ${GRANT_TABLE}(token_hash,issued_at,expires_at) VALUES(?,?,?)`).run(hash, now, expiresAt);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
    return {token, expiresAt};
  } catch (error) {
    if (error instanceof Error && error.message === "dashboard login grant capacity reached") throw error;
    throw authError("login grant state");
  } finally {
    closeDatabaseQuietly(database);
    await directoryHandle.close();
  }
};
