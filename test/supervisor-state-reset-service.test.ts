import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { GuidanceDb } from "../src/db.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { SupervisorConversationStore } from "../src/supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "../src/supervisor-monitor-store.js";
import { SupervisorStateReset, type SupervisorStateResetShape } from "../src/supervisor-state-reset.js";
import { guidanceDb, rows, sequentialIds, temporaryDirectory } from "./support/guidance-store-services.js";

// the SupervisorStateReset effect service on a temporary guidance.sqlite3 opened through the production layers, in the
// synchronous constructors' order (guidance schema first): the scope-lifecycle reset cases at service level (CT-RESET-01 lives
// in the scope-lifecycle characterization) and the reset inside the caller's transaction

const layer = (directory: string) => Layer.mergeAll(SupervisorStateReset.layer, SupervisorConversationStore.layer,
  ProjectSupervisorMonitorStore.layer).pipe(Layer.provideMerge(GuidanceStore.layer), Layer.provideMerge(guidanceDb(directory)), Layer.provide(sequentialIds()));

const withReset = <A, E>(directory: string, use: (reset: SupervisorStateResetShape, db: GuidanceDb["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* SupervisorStateReset, yield* GuidanceDb);
  }).pipe(Effect.provide(layer(directory)));

const tableDigest = (db: GuidanceDb["Service"]) => Effect.gen(function* () {
  const hash = createHash("sha256");
  for (const { name } of yield* rows(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
    hash.update(`${String(name)}\0${JSON.stringify(yield* rows(db, `SELECT * FROM "${String(name)}" ORDER BY rowid`))}\0`);
  return hash.digest("hex");
});

const count = (db: GuidanceDb["Service"], table: string) => Effect.map(rows(db, `SELECT count(*) AS n FROM ${table}`), ([row]) => Number(row?.n));

// disposable prototype state in every table the reset clears, beside permanent ownership, defaults and unrelated state
const populate = (db: GuidanceDb["Service"]) => Effect.gen(function* () {
  yield* db.unsafe("CREATE TABLE IF NOT EXISTS supervisor_owned_threads(id TEXT PRIMARY KEY)");
  yield* db.unsafe("INSERT INTO supervisor_owned_threads VALUES('owned-supervisor')");
  yield* db.unsafe("CREATE TABLE unrelated_delivery(id TEXT)");
  yield* db.unsafe("INSERT INTO unrelated_delivery VALUES('retained')");
  yield* db.unsafe("CREATE TABLE supervisor_project_bindings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL)");
  yield* db.unsafe("INSERT INTO supervisor_project_bindings VALUES('p','{}')");
  yield* db.unsafe("CREATE TABLE supervisor_main_bindings(id TEXT PRIMARY KEY)");
  yield* db.unsafe("INSERT INTO supervisor_main_bindings VALUES('main')");
  yield* db.unsafe("INSERT INTO supervisor_conversation_requests VALUES('request','p','{}',1)");
  yield* db.unsafe("INSERT INTO supervisor_monitor_binding_clock(supervisor_thread_id,last_notice_at) VALUES('owned-supervisor',1)");
  yield* db.unsafe("INSERT INTO supervisor_monitor_threads(project_id,thread_id,source_ordinal,activation_ordinal) VALUES('p','main',1,1)");
  yield* db.unsafe("INSERT INTO meta VALUES('supervisor_activation_baseline','{}'),('supervisor_activation_sequence','4'),('supervisor_model:p','chosen-default')");
}).pipe(Effect.orDie);

describe("SupervisorStateReset", () => {
  it.live("the one-time disposable reset clears discovery together and preserves unrelated state", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withReset(directory, (reset, db) => Effect.gen(function* () {
      yield* populate(db);
      const compatible = yield* reset.initializeMainSupervisionState();
      const cleared = yield* Effect.forEach(["supervisor_project_bindings", "supervisor_main_bindings", "supervisor_conversation_requests",
        "supervisor_monitor_binding_clock", "supervisor_monitor_threads"], (table) => count(db, table));
      const kept = {
        owned: yield* rows(db, "SELECT id FROM supervisor_owned_threads"),
        unrelated: yield* count(db, "unrelated_delivery"),
        meta: yield* rows(db, "SELECT key,value FROM meta WHERE key<>'settings' ORDER BY key"),
      };
      // normal restarts do not reset the new scope
      yield* db.unsafe("INSERT INTO supervisor_main_bindings VALUES('after-upgrade')");
      return { compatible, cleared, kept, again: yield* reset.initializeMainSupervisionState(), retained: yield* count(db, "supervisor_main_bindings") };
    }));
    assert.equal(observed.compatible, true);
    assert.deepEqual(observed.cleared, [0, 0, 0, 0, 0]);
    assert.deepEqual(observed.kept, { owned: [{ id: "owned-supervisor" }], unrelated: 1,
      meta: [{ key: "supervisor_model:p", value: "chosen-default" }, { key: "supervisor_scope_version", value: "main-v1" }] });
    assert.deepEqual([observed.again, observed.retained], [true, 1]);
  }), { timeout: 10_000 });

  it.live("an unknown scope version disables supervision without resetting the private database", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withReset(directory, (reset, db) => Effect.gen(function* () {
      yield* populate(db);
      yield* db.unsafe("INSERT INTO meta VALUES('supervisor_scope_version','future')");
      const before = yield* tableDigest(db);
      return { compatible: yield* reset.initializeMainSupervisionState(), unchanged: before === (yield* tableDigest(db)) };
    }));
    assert.deepEqual(observed, { compatible: false, unchanged: true });
  }), { timeout: 10_000 });

  it.live("the reset joins the caller's transaction and rolls back with it", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withReset(directory, (reset, db) => Effect.gen(function* () {
      yield* populate(db);
      const before = yield* tableDigest(db);
      const failed = yield* Effect.flip(db.withTransaction(Effect.gen(function* () {
        assert.equal(yield* reset.initializeMainSupervisionState(), true);
        yield* reset.resetSupervisorTestState();
        return yield* Effect.fail("caller failed" as const);
      })));
      return { failed, unchanged: before === (yield* tableDigest(db)) };
    }));
    assert.deepEqual(observed, { failed: "caller failed", unchanged: true });
  }), { timeout: 10_000 });
});
