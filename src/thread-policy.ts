import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { SupervisorConfig as Configuration } from "./config.js";
import type { SupervisorConfig } from "./types.js";

import { ThreadPolicy as ThreadPolicyDocument, type ThreadPolicySettings } from "./thread-policy-contract.js";
const validId = (id: string) => id.length > 0 && id.length <= 512 && !/[\s\x00-\x1f\x7f]/u.test(id);

/** Persists instance-specific excluded-thread policy. */
export class ThreadPolicyStore {
  private readonly db: DatabaseSync;
  constructor(directory: string, seed: Omit<ThreadPolicySettings, "generation">) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "thread-settings.sqlite3");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL)");
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES(1,?)").run(JSON.stringify({ generation: 1, ...seed }));
  }
  close(): void { this.db.close(); }
  get(): ThreadPolicySettings {
    return Schema.decodeUnknownSync(ThreadPolicyDocument)(JSON.parse(String(this.db.prepare("SELECT document FROM settings WHERE id=1").get()?.document)) as unknown);
  }
  save(input: ThreadPolicySettings): ThreadPolicySettings {
    if (!Number.isSafeInteger(input.generation) || input.excludedThreadIds.length > 500 ||
      !input.excludedThreadIds.every(validId) || new Set(input.excludedThreadIds).size !== input.excludedThreadIds.length)
      throw new Error("Choose valid, unique chat IDs.");
    const next = { ...input, generation: input.generation + 1 };
    const updated = this.db.prepare("UPDATE settings SET document=? WHERE id=1 AND json_extract(document,'$.generation')=?").run(JSON.stringify(next), input.generation);
    if (!updated.changes) throw new Error("Chat settings changed in another tab. Reload first.");
    return next;
  }
}
export const currentThreadPolicy = (config: SupervisorConfig): ThreadPolicySettings => config.threadPolicy?.get() ?? {
  generation: 0, excludedThreadIds: config.excludedThreadIds,
};

// the process thread-policy store, opened from the configuration and closed on release; until S6d it is the existing
// synchronous store (D-01, B-02), with no SqlClient
export class ThreadPolicy extends Context.Service<ThreadPolicy, ThreadPolicyStore>()("t3-supervisor/ThreadPolicy") {
  static readonly layer: Layer.Layer<ThreadPolicy, never, Configuration> = Layer.effect(ThreadPolicy, Effect.gen(function* () {
    const config = yield* Configuration;
    return yield* Effect.acquireRelease(
      Effect.sync(() => new ThreadPolicyStore(config.dataDirectory, { excludedThreadIds: config.excludedThreadIds })),
      (store) => Effect.sync(() => store.close()),
    );
  }));
}
