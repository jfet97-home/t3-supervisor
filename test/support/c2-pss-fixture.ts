import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "vitest";
import { after } from "./node-test.js";
import { openGuidance, openSupervisors, type DbFacade, type GuidanceHandle, type SupervisorsFacade } from "./store-units.js";

export type StoreHandle = {guidance: GuidanceHandle; store: SupervisorsFacade; ownedIds: Set<string>};

// one temp guidance directory per test; every connection opened through it closes before the directory is removed
export const pssFixture = async (t: TestContext, prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  // the suites' own raw connections (outside readers) close synchronously, the store handles as promises
  const connections: Array<{close(): unknown}> = [];
  after(t, async () => {
    // a handle closes once; one the test already closed stays closed
    for (const connection of connections.reverse()) await connection.close();
    await rm(directory, {recursive: true, force: true});
  });
  const track = <A extends {close(): unknown}>(connection: A): A => {connections.push(connection);return connection;};
  // opens the guidance file the way the service does (guidance store first, then the project supervision store)
  const open = async /*s6d*/ (beforeStore?: (guidance: GuidanceHandle) => Promise<void> | void): Promise<StoreHandle> => {
    const guidance = track(await openGuidance(directory));
    await beforeStore?.(guidance);
    const ownedIds = new Set<string>();
    return {guidance, store: await openSupervisors(guidance, ownedIds), ownedIds};
  };
  return {directory, path: join(directory, "guidance.sqlite3"), open, track};
};

export const metaRows = async /*s6d*/ (db: DbFacade): Promise<Array<[string, string]>> =>
  (await db.prepare("SELECT key,value FROM meta ORDER BY key").all()).map(row => [String(row.key), String(row.value)]);

export const tableRows = async /*s6d*/ (db: DbFacade, table: string): Promise<unknown[]> =>
  (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).map(row => ({...row}));
