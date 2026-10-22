import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TestContext } from "vitest";
import { GuidanceStore } from "../../src/guidance-store.js";
import { ProjectSupervisorStore } from "../../src/project-supervisor-store.js";
import { after } from "./node-test.js";

export type StoreHandle = {guidance: GuidanceStore; store: ProjectSupervisorStore; ownedIds: Set<string>};

// one temp guidance directory per test; every connection opened through it closes before the directory is removed
export const pssFixture = async (t: TestContext, prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const connections: Array<{close(): void; readonly isOpen: boolean}> = [];
  after(t, async () => {
    for (const connection of connections.reverse()) if (connection.isOpen) connection.close();
    await rm(directory, {recursive: true, force: true});
  });
  const track = <A extends {close(): void; readonly isOpen: boolean}>(connection: A): A => {connections.push(connection);return connection;};
  // opens the guidance file the way the service does (guidance store first, then the project supervision store)
  const open = (beforeStore?: (guidance: GuidanceStore) => void): StoreHandle => {
    const guidance = new GuidanceStore(directory);
    track(guidance.db);
    beforeStore?.(guidance);
    const ownedIds = new Set<string>();
    return {guidance, store: new ProjectSupervisorStore(guidance, ownedIds), ownedIds};
  };
  return {directory, path: join(directory, "guidance.sqlite3"), open, track};
};

export const metaRows = (db: DatabaseSync): Array<[string, string]> =>
  db.prepare("SELECT key,value FROM meta ORDER BY key").all().map(row => [String(row.key), String(row.value)]);

export const tableRows = (db: DatabaseSync, table: string): unknown[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({...row}));
