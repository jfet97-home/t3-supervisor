import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Scheduler } from "effect";
import { TestClock } from "effect/testing";
import { GuidanceDb } from "../src/db.js";
import type { GuidanceRule, GuidanceRuleInput, GuidanceSettings } from "../src/guidance-contract.js";
import { GuidanceConflictError, GuidanceStoreError, GuidanceStoreService, type GuidanceStoreShape } from "../src/guidance-store.js";
import { guidanceDb, rows, sequentialIds, temporaryDirectory } from "./support/guidance-store-services.js";

// target regressions of the GuidanceStore effect service on a temporary guidance.sqlite3 through the production layers:
// open-time schema, migrations and recovery (CT-GDB-01, CT-GDB-02), transactions that join the caller's (CT-GDB-06's
// target), the CC-GDB-IMPLICIT sequences in one transaction, typed row and sql failures and the synchronous store's
// method results

const layer = (directory: string) => GuidanceStoreService.layer.pipe(Layer.provideMerge(guidanceDb(directory)), Layer.provide(sequentialIds()));

// every use opens the client and the store afresh and closes them again, as a process restart would
const withGuidance = <A, E>(directory: string, use: (store: GuidanceStoreShape, db: GuidanceDb["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* GuidanceStoreService, yield* GuidanceDb);
  }).pipe(Effect.provide(layer(directory)));

const defaults: GuidanceSettings = {
  generation: 1, guidancePaused: false, monitoringPaused: false, allowFollowupRace: false, verifiedServerVersion: null,
  model: "gpt-6-luna", reasoning: "high", dailyTokenBudget: 100_000, evidenceHours: 24, maxAnchorAgeSeconds: 60,
};

const ruleInput = (patch: Partial<GuidanceRuleInput> = {}): GuidanceRuleInput => ({
  id: null, expectedGeneration: 0, name: "Rule", condition: "When it applies.", message: "Do the right thing.", scope: "global",
  projectId: null, mode: "observe", ...patch,
});

const conflictMessage = (error: unknown): string => {
  assert.ok(error instanceof GuidanceConflictError, `expected a GuidanceConflict, got ${String(error)}`);
  return error.message;
};

const guidanceFile = (directory: string) => join(directory, "guidance.sqlite3");

describe("GuidanceStoreService", () => {
  it.effect("the layer creates the schema and the default settings once and keeps saved settings on reopen", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const first = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      const tables = (yield* rows(db, "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((row) => row.name);
      const settings = yield* store.settings();
      const saved = yield* store.saveSettings({ ...settings, dailyTokenBudget: 5_000 });
      return { tables, settings, saved };
    }));
    assert.deepEqual(first.tables, ["activity", "activity_notice", "budget", "classifications", "episodes", "meta", "mutes", "notices", "observations", "rules"]);
    assert.deepEqual(first.settings, defaults);
    assert.deepEqual(first.saved, { ...defaults, dailyTokenBudget: 5_000, generation: 2 });
    assert.deepEqual(yield* withGuidance(directory, (store) => store.settings()), first.saved);
  }), { timeout: 10_000 });

  it.effect("CT-GDB-01: reopening with committed notices recovers each once, lists the uncertain notice first and records nothing on a second reopen", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* withGuidance(directory, (_store, db) => Effect.gen(function* () {
      const insert = (values: ReadonlyArray<unknown>) =>
        db.unsafe("INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,message_id,created_at,dispatch_started) VALUES(?,?,?,?,?,?,?,?,?,?)", values);
      yield* insert(["not-started", "thread-a", "rule-a", "run-a", 3, "committed", "text a", null, 1_000, 0]);
      yield* insert(["started", "thread-b", "rule-b", "run-b", 4, "committed", "text b", null, 2_000, 1]);
      yield* insert(["visible", "thread-c", "rule-c", "run-c", 5, "visible", "text c", null, 3_000, 1]);
    }).pipe(Effect.orDie));
    const recoveryRows = (db: GuidanceDb["Service"]) => rows(db,
      "SELECT json_extract(document,'$.noticeId') AS noticeId, json_extract(document,'$.state') AS state, json_extract(document,'$.episodeEpoch') AS epoch FROM activity WHERE json_extract(document,'$.reason')='process_recovery' ORDER BY noticeId");
    yield* TestClock.setTime(50_000);
    const first = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      return {
        notices: yield* rows(db, "SELECT id,state FROM notices ORDER BY id"),
        recovery: yield* recoveryRows(db),
        stamps: yield* rows(db, "SELECT id,created_at FROM activity ORDER BY id"),
        activities: yield* store.activities(),
      };
    }));
    assert.deepEqual(first.notices, [{ id: "not-started", state: "not_delivered_restart" }, { id: "started", state: "uncertain" }, { id: "visible", state: "visible" }]);
    assert.deepEqual(first.recovery, [{ noticeId: "not-started", state: "not_delivered_restart", epoch: 3 }, { noticeId: "started", state: "uncertain", epoch: 4 }]);
    // identities come from SupervisorIds in recovery order and the time from Clock
    assert.deepEqual(first.stamps, [
      { id: "00000000-0000-4000-8000-000000000001", created_at: 50_000 },
      { id: "00000000-0000-4000-8000-000000000002", created_at: 50_000 },
    ]);
    assert.deepEqual(first.activities[0], { id: "notice:started", noticeId: "started", episodeEpoch: 4, threadId: "thread-b", ruleId: "rule-b", runId: "run-b",
      kind: "guidance", state: "uncertain", reason: "unreconciled_notice", detail: null, createdAt: 2_000 });
    // the uncertain notice's own recovery row is folded into its unresolved entry
    assert.deepEqual(first.activities.slice(1).map((item) => [item.noticeId, item.reason, item.state]), [["not-started", "process_recovery", "not_delivered_restart"]]);

    const second = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      return { recovery: yield* recoveryRows(db), count: yield* rows(db, "SELECT COUNT(*) AS count FROM activity"), first: (yield* store.activities())[0]?.id };
    }));
    assert.deepEqual(second.recovery, first.recovery);
    assert.deepEqual(second.count, [{ count: 2 }]);
    assert.equal(second.first, "notice:started");
  }), { timeout: 10_000 });

  it.live("CT-GDB-02: opening a pre-migration database adds the episode and notice generation columns with defaults and keeps the rows", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    mkdirSync(directory, { recursive: true });
    const legacy = new DatabaseSync(guidanceFile(directory));
    try {
      legacy.exec(`CREATE TABLE episodes(thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread_id,rule_id));
        CREATE TABLE notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,state TEXT NOT NULL,text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,
        dispatch_started INTEGER NOT NULL DEFAULT 0);`);
      legacy.prepare("INSERT INTO episodes VALUES(?,?,?,?)").run("thread-a", "rule-a", 7, 1);
      legacy.prepare("INSERT INTO notices VALUES(?,?,?,?,?,?,?,?,?,?)").run("notice-a", "thread-a", "rule-a", "run-a", 7, "visible", "legacy text", "message-a", 5_000, 1);
    } finally {
      legacy.close();
    }
    const opened = yield* withGuidance(directory, (_store, db) => Effect.gen(function* () {
      const columns = (table: string) => Effect.map(rows(db, `PRAGMA table_info(${table})`), (result) => result.map((row) => [row.name, row.dflt_value, row.notnull]));
      return {
        episodeColumns: yield* columns("episodes"),
        noticeColumns: yield* columns("notices"),
        episodes: yield* rows(db, "SELECT * FROM episodes"),
        notices: yield* rows(db, "SELECT * FROM notices"),
        recovery: yield* rows(db, "SELECT id FROM activity WHERE json_extract(document,'$.reason')='process_recovery'"),
      };
    }));
    assert.deepEqual(opened.episodeColumns.at(-1), ["object_id", null, 0]);
    assert.deepEqual(opened.noticeColumns.slice(-2), [["rule_generation", "-1", 1], ["settings_generation", "-1", 1]]);
    assert.deepEqual(opened.episodes, [{ thread_id: "thread-a", rule_id: "rule-a", epoch: 7, notified: 1, object_id: null }]);
    assert.deepEqual(opened.notices, [{ id: "notice-a", thread_id: "thread-a", rule_id: "rule-a", run_id: "run-a", epoch: 7,
      state: "visible", text: "legacy text", message_id: "message-a", created_at: 5_000, dispatch_started: 1, rule_generation: -1, settings_generation: -1 }]);
    assert.deepEqual(opened.recovery, []);
    // a second open finds the columns present and alters nothing
    const again = yield* withGuidance(directory, (_store, db) => Effect.all([rows(db, "PRAGMA table_info(notices)"), rows(db, "PRAGMA table_info(episodes)")]));
    assert.deepEqual(again.map((columns) => columns.length), [12, 5]);
  }), { timeout: 10_000 });

  it.live("CT-GDB-06 target: a store transaction inside the caller's transaction joins it, committing and rolling back with the caller", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      const settings = yield* store.settings();
      // the caller fails after the joined save: the save's writes roll back with the caller's own
      const failed = yield* Effect.flip(db.withTransaction(Effect.gen(function* () {
        yield* db`INSERT INTO meta VALUES('s6d-outer','1')`;
        yield* store.saveSettings({ ...settings, dailyTokenBudget: 2_000 });
        return yield* Effect.fail("caller failed" as const);
      })));
      const afterFailure = { settings: yield* store.settings(), outer: yield* rows(db, "SELECT key FROM meta WHERE key LIKE 's6d-%'") };
      // the caller commits: the joined save commits with it
      const saved = yield* db.withTransaction(Effect.gen(function* () {
        yield* db`INSERT INTO meta VALUES('s6d-committed','1')`;
        return yield* store.saveSettings({ ...settings, dailyTokenBudget: 3_000 });
      }));
      // a joined conflict fails the caller without leaving the connection inside a transaction
      const conflict = yield* Effect.flip(db.withTransaction(store.saveSettings(settings)));
      const next = yield* store.saveSettings({ ...saved, dailyTokenBudget: 4_000 });
      return { failed, afterFailure, saved, conflict: conflictMessage(conflict), next,
        outer: yield* rows(db, "SELECT key FROM meta WHERE key LIKE 's6d-%' ORDER BY key") };
    }));
    assert.equal(observed.failed, "caller failed");
    assert.deepEqual(observed.afterFailure, { settings: defaults, outer: [] });
    assert.deepEqual(observed.saved, { ...defaults, dailyTokenBudget: 3_000, generation: 2 });
    assert.equal(observed.conflict, "Settings changed in another tab. Reload first.");
    assert.deepEqual(observed.next, { ...defaults, dailyTokenBudget: 4_000, generation: 3 });
    assert.deepEqual(observed.outer, [{ key: "s6d-committed" }]);
  }), { timeout: 10_000 });

  it.effect("bind keeps the first environment and refuses another with the synchronous store's message", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      yield* store.bind("environment-a");
      yield* store.bind("environment-a");
      const refused = conflictMessage(yield* Effect.flip(store.bind("environment-b")));
      return { refused, environment: yield* rows(db, "SELECT value FROM meta WHERE key='environment'") };
    }));
    assert.deepEqual(observed, { refused: "Guidance belongs to another T3 environment.", environment: [{ value: "environment-a" }] });
  }), { timeout: 10_000 });

  it.effect("rules keep their generation compare-and-set, demote a changed send rule to observe and stamp liveSince from Clock", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* TestClock.setTime(1_000);
    const observed = yield* withGuidance(directory, (store) => Effect.gen(function* () {
      const created = yield* store.saveRule(ruleInput({ mode: "send" }));
      const sent = yield* store.saveRule(ruleInput({ ...created, expectedGeneration: created.generation, mode: "send" }), 2_000);
      yield* TestClock.setTime(3_000);
      const unchanged = yield* store.saveRule(ruleInput({ ...sent, expectedGeneration: sent.generation, mode: "send" }));
      const edited = yield* store.saveRule(ruleInput({ ...sent, expectedGeneration: sent.generation, message: "Do it differently.", mode: "send" }), 4_000);
      const stale = conflictMessage(yield* Effect.flip(store.saveRule(ruleInput({ ...edited, expectedGeneration: sent.generation }))));
      const missing = conflictMessage(yield* Effect.flip(store.saveRule(ruleInput({ id: "missing", expectedGeneration: 1 }))));
      const invalid = conflictMessage(yield* Effect.flip(store.saveRule(ruleInput({ name: " " }))));
      const scope = conflictMessage(yield* Effect.flip(store.saveRule(ruleInput({ scope: "project" }))));
      return { created, sent, unchanged, edited, stale, missing, invalid, scope, rules: yield* store.rules(), rule: yield* store.rule(created.id) };
    }));
    const base = { name: "Rule", condition: "When it applies.", scope: "global", projectId: null } as const;
    // a new rule asked to send starts observing
    assert.deepEqual(observed.created, { ...base, id: "00000000-0000-4000-8000-000000000001", expectedGeneration: 0, message: "Do the right thing.",
      mode: "observe", revision: 1, generation: 1, liveSince: 1_000, updatedAt: 1_000 } satisfies GuidanceRule);
    assert.deepEqual(observed.sent, { ...observed.created, expectedGeneration: 1, mode: "send", generation: 2, liveSince: 2_000, updatedAt: 2_000 });
    // the same content and mode is a no-op that keeps generation and updatedAt
    assert.deepEqual(observed.unchanged, { ...observed.sent, expectedGeneration: 2 });
    assert.deepEqual(observed.edited, { ...observed.sent, expectedGeneration: 2, message: "Do it differently.", mode: "observe", revision: 2, generation: 3,
      liveSince: 4_000, updatedAt: 4_000 });
    assert.equal(observed.stale, "This rule changed in another tab. Reload it before saving.");
    assert.equal(observed.missing, "Rule no longer exists.");
    assert.equal(observed.invalid, "Complete the name, condition and message within their length limits.");
    assert.equal(observed.scope, "Choose a project for a project rule only.");
    assert.deepEqual(observed.rules, [observed.edited]);
    assert.deepEqual(observed.rule, observed.edited);
  }), { timeout: 10_000 });

  it.live("the rule capacity is 200 rules", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const refused = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      yield* db.withTransaction(Effect.forEach(Array.from({ length: 200 }, (_, index) => index), (index) => store.saveRule(ruleInput({ name: `Rule ${index}` }), 1)));
      return conflictMessage(yield* Effect.flip(store.saveRule(ruleInput({ name: "One too many" }), 1)));
    }));
    assert.equal(refused, "Rule capacity reached.");
  }), { timeout: 10_000 });

  it.effect("settings validation and compare-and-set, and a resume refreshes every rule's liveSince from Clock", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* TestClock.setTime(10_000);
    const observed = yield* withGuidance(directory, (store) => Effect.gen(function* () {
      const rule = yield* store.saveRule(ruleInput(), 1_000);
      const invalid = yield* Effect.forEach([{ dailyTokenBudget: 999 }, { evidenceHours: 48 }, { maxAnchorAgeSeconds: 601 }, { model: "other" }],
        (patch) => Effect.map(Effect.flip(store.saveSettings({ ...defaults, ...patch })), conflictMessage));
      const paused = yield* store.saveSettings({ ...defaults, guidancePaused: true });
      const pausedRule = yield* store.rule(rule.id);
      yield* TestClock.setTime(20_000);
      const resumed = yield* store.saveSettings({ ...paused, guidancePaused: false });
      const stale = conflictMessage(yield* Effect.flip(store.saveSettings(paused)));
      return { invalid, paused, pausedRule, resumed, resumedRule: yield* store.rule(rule.id), stale };
    }));
    assert.deepEqual(observed.invalid, Array(4).fill("Choose supported monitoring settings."));
    assert.deepEqual(observed.paused, { ...defaults, guidancePaused: true, generation: 2 });
    assert.equal(observed.pausedRule?.liveSince, 1_000, "pausing refreshes nothing");
    assert.deepEqual(observed.resumed, { ...defaults, generation: 3 });
    assert.equal(observed.resumedRule?.liveSince, 20_000);
    assert.equal(observed.stale, "Settings changed in another tab. Reload first.");
  }), { timeout: 10_000 });

  it.effect("mutes and classifications move their rule and settings generations", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* TestClock.setTime(5_000);
    const observed = yield* withGuidance(directory, (store) => Effect.gen(function* () {
      const global = yield* store.saveRule(ruleInput(), 1_000);
      const project = yield* store.saveRule(ruleInput({ name: "Project rule", scope: "project", projectId: "project-a" }), 1_000);
      yield* store.mute(global.id, "project-a", true, global.generation);
      const muted = { mutes: yield* store.mutes(), rule: yield* store.rule(global.id) };
      const staleMute = conflictMessage(yield* Effect.flip(store.mute(global.id, "project-a", false, global.generation)));
      const projectMute = conflictMessage(yield* Effect.flip(store.mute(project.id, "project-a", true, project.generation)));
      yield* store.mute(global.id, "project-a", false, global.generation + 1);
      const unmuted = yield* store.mutes();
      const before = yield* store.classification("project-a");
      yield* store.classify("project-a", "scratch", 1);
      const staleClassify = conflictMessage(yield* Effect.flip(store.classify("project-a", "project", 1)));
      return { muted, staleMute, projectMute, unmuted, before, after: yield* store.classification("project-a"), staleClassify, settings: yield* store.settings() };
    }));
    assert.deepEqual(observed.muted.mutes, [{ ruleId: "00000000-0000-4000-8000-000000000001", scopeId: "project-a" }]);
    assert.deepEqual([observed.muted.rule?.generation, observed.muted.rule?.liveSince], [2, 5_000]);
    assert.equal(observed.staleMute, "The global rule changed. Reload first.");
    assert.equal(observed.projectMute, "The global rule changed. Reload first.");
    assert.deepEqual(observed.unmuted, []);
    assert.deepEqual([observed.before, observed.after], ["unclassified", "scratch"]);
    assert.equal(observed.staleClassify, "Settings changed. Reload first.");
    assert.equal(observed.settings.generation, 2);
  }), { timeout: 10_000 });

  it.effect("observations report a changed hash and the token budget reserves within the Clock's day", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const day = Date.parse("2026-10-23T08:00:00.000Z");
    yield* TestClock.setTime(day);
    const observed = yield* withGuidance(directory, (store) => Effect.gen(function* () {
      const first = yield* store.observe("thread-a", "hash-1", 1);
      const same = yield* store.observe("thread-a", "hash-1", 2);
      const changed = yield* store.observe("thread-a", "hash-2", 3);
      const previous = [yield* store.previousHash("thread-a"), yield* store.previousHash("thread-b")];
      yield* store.saveSettings({ ...defaults, dailyTokenBudget: 1_000 });
      const reservations = [yield* store.reserveTokens(600), yield* store.reserveTokens(400), yield* store.reserveTokens(1)];
      const used = [yield* store.used(), yield* store.used(day - 86_400_000)];
      yield* TestClock.setTime(day + 86_400_000);
      return { first, same, changed, previous, reservations, used, nextDay: [yield* store.reserveTokens(1_000), yield* store.used()] };
    }));
    assert.deepEqual([observed.first, observed.same, observed.changed], [false, false, true]);
    assert.deepEqual(observed.previous, ["hash-2", null]);
    assert.deepEqual(observed.reservations, [true, true, false]);
    assert.deepEqual(observed.used, [1_000, 0]);
    assert.deepEqual(observed.nextDay, [true, 1_000]);
  }), { timeout: 10_000 });

  it.live("concurrent reservations under forced fiber yields never exceed the daily budget", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withGuidance(directory, (store) => Effect.gen(function* () {
      yield* store.saveSettings({ ...defaults, dailyTokenBudget: 1_000 });
      // a yield every eight operations interleaves the fibers between any two statements that are not one transaction
      const granted = yield* Effect.all(Array.from({ length: 20 }, () => store.reserveTokens(100)), { concurrency: "unbounded" }).pipe(
        Effect.provideService(Scheduler.MaxOpsBeforeYield, 8));
      return { granted: granted.filter(Boolean).length, used: yield* store.used() };
    }));
    assert.deepEqual(observed, { granted: 10, used: 1_000 });
  }), { timeout: 10_000 });

  it.live("concurrent observations of one changed hash under forced fiber yields report the change exactly once", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const changed = yield* withGuidance(directory, (store) => Effect.gen(function* () {
      yield* store.observe("thread-a", "hash-1", 1);
      // a yield every eight operations interleaves the fibers between any two statements that are not one transaction
      return yield* Effect.all(Array.from({ length: 10 }, (_, index) => store.observe("thread-a", "hash-2", 2 + index)), { concurrency: "unbounded" }).pipe(
        Effect.provideService(Scheduler.MaxOpsBeforeYield, 8));
    }));
    assert.equal(changed.filter(Boolean).length, 1);
  }), { timeout: 10_000 });

  it.effect("records and activities: unresolved uncertain notices first with their latest detail evidence, then the 200 most recent", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* TestClock.setTime(9_000);
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      yield* db`INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,created_at) VALUES('uncertain-a','thread-a','rule-a','run-a',2,'uncertain','text',${100})`;
      const evidence = yield* store.record({ kind: "guidance", threadId: "thread-a", ruleId: "rule-a", runId: "run-a", noticeId: "uncertain-a", episodeEpoch: 2,
        state: "uncertain", reason: "dispatch_unknown", detail: "evidence" }, 200);
      yield* store.record({ kind: "guidance", threadId: "thread-a", ruleId: "rule-a", runId: "run-a", noticeId: "uncertain-a", episodeEpoch: 2,
        state: "uncertain", reason: "later", detail: null }, 300);
      const stamped = yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: "owner", detail: null });
      for (let index = 0; index < 205; index++)
        yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: `bulk-${index}`, detail: null }, 1_000 + index);
      return { evidence, stamped, activities: yield* store.activities() };
    }));
    assert.deepEqual(observed.evidence, { kind: "guidance", threadId: "thread-a", ruleId: "rule-a", runId: "run-a", noticeId: "uncertain-a", episodeEpoch: 2,
      state: "uncertain", reason: "dispatch_unknown", detail: "evidence", id: "00000000-0000-4000-8000-000000000001", createdAt: 200 });
    assert.equal(observed.stamped.createdAt, 9_000);
    assert.deepEqual(observed.activities[0], { id: "notice:uncertain-a", noticeId: "uncertain-a", episodeEpoch: 2, threadId: "thread-a", ruleId: "rule-a",
      runId: "run-a", kind: "guidance", state: "uncertain", reason: "unreconciled_notice", detail: "evidence", createdAt: 100 });
    assert.equal(observed.activities.length, 201);
    assert.deepEqual(observed.activities.slice(1, 3).map((item) => item.reason), ["owner", "bulk-204"]);
    assert.equal(observed.activities.some((item) => item.noticeId === "uncertain-a" && item.reason !== "unreconciled_notice"), false);
  }), { timeout: 10_000 });

  it.effect("prune blanks old notice text and activity detail, deletes month-old activity and week-old budget days", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    yield* TestClock.setTime(now);
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      const old = now - 25 * 3_600_000;
      yield* db`INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,created_at) VALUES('old-visible','t','r','run',0,'visible','old text',${old}),('old-uncertain','t','r','run',0,'uncertain','kept text',${old}),('new-visible','t','r','run',0,'visible','new text',${now})`;
      yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: "old", detail: "old detail" }, old);
      yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: "new", detail: "new detail" }, now);
      yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: "ancient", detail: null }, now - 31 * 86_400_000);
      yield* db`INSERT INTO budget VALUES('2026-10-15',1),('2026-10-16',2),('2026-10-23',3)`;
      yield* store.prune();
      return {
        notices: yield* rows(db, "SELECT id,text FROM notices ORDER BY id"),
        activity: yield* rows(db, "SELECT json_extract(document,'$.reason') AS reason, json_extract(document,'$.detail') AS detail FROM activity ORDER BY created_at"),
        budget: yield* rows(db, "SELECT day FROM budget ORDER BY day"),
      };
    }));
    assert.deepEqual(observed.notices, [{ id: "new-visible", text: "new text" }, { id: "old-uncertain", text: "kept text" }, { id: "old-visible", text: "" }]);
    assert.deepEqual(observed.activity, [{ reason: "old", detail: null }, { reason: "new", detail: "new detail" }]);
    assert.deepEqual(observed.budget, [{ day: "2026-10-16" }, { day: "2026-10-23" }]);
  }), { timeout: 10_000 });

  it.live("CC-GDB-IMPLICIT: a prune that meets an activity row it cannot decode fails typed and leaves every row as it was", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      const old = now - 25 * 3_600_000;
      yield* db`INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,created_at) VALUES('old-visible','t','r','run',0,'visible','old text',${old})`;
      yield* store.record({ kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "done", reason: "old", detail: "old detail" }, old);
      yield* db`INSERT INTO activity VALUES('corrupt','{"kind":"owner_action"}',${old + 1})`;
      const before = [yield* rows(db, "SELECT * FROM notices"), yield* rows(db, "SELECT * FROM activity ORDER BY id")];
      const failure = yield* Effect.flip(store.prune(now));
      return { failure, before, after: [yield* rows(db, "SELECT * FROM notices"), yield* rows(db, "SELECT * FROM activity ORDER BY id")] };
    }));
    assert.ok(observed.failure instanceof GuidanceStoreError);
    assert.deepEqual({ reason: observed.failure.reason, row: observed.failure.row }, { reason: "row_invalid", row: "activity" });
    assert.deepEqual(observed.after, observed.before, "the notice text blanked before the failing row is rolled back");
  }), { timeout: 10_000 });

  it.live("R19: a stored rule or settings row that does not decode is a typed failure naming the row kind, never absent", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      yield* db`INSERT INTO rules VALUES('broken','{"id":"broken"}')`;
      const rule = yield* Effect.flip(store.rule("broken"));
      const ruleList = yield* Effect.flip(store.rules());
      yield* db`UPDATE meta SET value='not json' WHERE key='settings'`;
      const settings = yield* Effect.flip(store.settings());
      yield* db`DELETE FROM meta WHERE key='settings'`;
      const missing = yield* Effect.flip(store.settings());
      return [rule, ruleList, settings, missing];
    }));
    assert.deepEqual(observed.map((error) => error instanceof GuidanceStoreError ? [error.reason, error.row] : String(error)),
      [["row_invalid", "rule"], ["row_invalid", "rule"], ["row_invalid", "settings"], ["row_invalid", "settings"]]);
    // the typed failure carries neither the row content nor a cause
    assert.equal(JSON.stringify(observed).includes("broken"), false);
  }), { timeout: 10_000 });

  it.live("a failed statement is a typed sql failure with the driver's classification and no statement or cause", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const failure = yield* withGuidance(directory, (store, db) => Effect.gen(function* () {
      yield* db.unsafe("CREATE TEMP TRIGGER s6d_fail_observe BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT, 's6d injected secret failure'); END");
      return yield* Effect.flip(store.observe("thread-a", "hash", 1));
    }));
    assert.ok(failure instanceof GuidanceStoreError);
    assert.deepEqual({ reason: failure.reason, row: failure.row, sqlReason: failure.sqlReason }, { reason: "sql_failed", row: null, sqlReason: "ConstraintError" });
    assert.equal(`${failure.message} ${JSON.stringify(failure)}`.includes("secret"), false);
    assert.equal("cause" in failure, false);
  }), { timeout: 10_000 });

  it.live("the notice lifecycle commits, starts, finishes and reconciles under its generation and epoch checks", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const now = 1_000_000;
    const observed = yield* withGuidance(directory, (store) => Effect.gen(function* () {
      const observing = yield* store.saveRule(ruleInput(), 1);
      const rule = yield* store.saveRule(ruleInput({ ...observing, expectedGeneration: observing.generation, mode: "send" }), 2);
      const settings = yield* store.settings();
      const notObserving = yield* store.commit(observing, settings.generation, "thread-a", "run-1", now);
      const committed = yield* store.commit(rule, settings.generation, "thread-a", "run-1", now, "object-1");
      const blocked = yield* store.commit(rule, settings.generation, "thread-a", "run-2", now);
      const reset = conflictMessage(yield* Effect.flip(store.reset("thread-a", rule.id)));
      const inFlight = conflictMessage(yield* Effect.flip(store.reset("thread-a", rule.id, true, 0, committed?.id ?? null)));
      const started = [yield* store.start(committed!.id), yield* store.start(committed!.id)];
      yield* store.finish(committed!.id, "accepted", "message-1");
      const episodeAfterAccept = yield* store.episode("thread-a", rule.id);
      const listed = yield* store.notices();
      const sameSituation = yield* store.commit(rule, settings.generation, "thread-a", "run-3", now + 1, "object-1", true);
      const newSituation = yield* store.commit(rule, settings.generation, "thread-a", "run-3", now + 1, "object-2", true);
      yield* store.reconcile(committed!.id);
      return { notObserving, committed, blocked, reset, inFlight, started, episodeAfterAccept, listed, sameSituation, newSituation,
        afterReconcile: yield* store.notices(), episode: yield* store.episode("thread-a", rule.id) };
    }));
    assert.equal(observed.notObserving, null);
    assert.deepEqual(observed.committed, { id: "00000000-0000-4000-8000-000000000002",
      text: "[Supervisor guidance · Rule · notice 00000000-0000-4000-8000-000000000002]\n\nDo the right thing.", epoch: 0 });
    assert.equal(observed.blocked, null, "an open committed notice blocks a second commit");
    assert.equal(observed.reset, "Reconcile or explicitly accept the delivery uncertainty first.");
    assert.equal(observed.inFlight, "A dispatch is still in flight.", "accepting the uncertainty of a committed notice still waits for its dispatch");
    assert.deepEqual(observed.started, [true, false]);
    assert.deepEqual(observed.episodeAfterAccept, { epoch: 0, objectId: "object-1" });
    assert.deepEqual(observed.listed, [{ id: observed.committed!.id, threadId: "thread-a", ruleId: observed.listed[0]!.ruleId, runId: "run-1", state: "accepted",
      text: observed.committed!.text, messageId: "message-1", epoch: 0 }]);
    assert.equal(observed.sameSituation, null, "a notified episode stays quiet for the same object");
    assert.equal(observed.newSituation?.epoch, 1, "a new object opens the next epoch");
    assert.deepEqual(observed.afterReconcile, [], "a reconciled notice is visible and leaves the delivery list");
    assert.deepEqual(observed.episode, { epoch: 1, objectId: "object-2" });
  }), { timeout: 10_000 });

  it.live("an uncertain notice blocks reset until its exact notice and epoch are accepted, and resolveEpisode advances only unchanged episodes", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withGuidance(directory, (store) => Effect.gen(function* () {
      const observing = yield* store.saveRule(ruleInput(), 1);
      const rule = yield* store.saveRule(ruleInput({ ...observing, expectedGeneration: observing.generation, mode: "send" }), 2);
      const settings = yield* store.settings();
      const notice = (yield* store.commit(rule, settings.generation, "thread-a", "run-1", 10))!;
      yield* store.start(notice.id);
      yield* store.finish(notice.id, "uncertain", null);
      yield* store.resolveEpisode("thread-a", rule.id);
      const unresolved = yield* store.episode("thread-a", rule.id);
      const wrongNotice = conflictMessage(yield* Effect.flip(store.reset("thread-a", rule.id, true, 0, "other")));
      const wrongEpoch = conflictMessage(yield* Effect.flip(store.reset("thread-a", rule.id, true, 5, notice.id)));
      yield* store.reset("thread-a", rule.id, true, 0, notice.id);
      const afterReset = yield* store.episode("thread-a", rule.id);
      yield* store.resolveEpisode("thread-a", rule.id, 0);
      const staleExpectation = yield* store.episode("thread-a", rule.id);
      yield* store.resolveEpisode("thread-a", rule.id, 1, rule.generation, settings.generation);
      return { unresolved, wrongNotice, wrongEpoch, afterReset, staleExpectation, resolved: yield* store.episode("thread-a", rule.id),
        notices: yield* store.notices() };
    }));
    assert.deepEqual(observed.unresolved, { epoch: 0, objectId: null }, "an uncertain notice holds the episode");
    assert.equal(observed.wrongNotice, "The uncertain notice changed. Reload first.");
    assert.equal(observed.wrongEpoch, "The episode changed. Reload first.");
    assert.deepEqual(observed.afterReset, { epoch: 1, objectId: null });
    assert.deepEqual(observed.staleExpectation, { epoch: 1, objectId: null });
    assert.deepEqual(observed.resolved, { epoch: 2, objectId: null });
    assert.deepEqual(observed.notices.map((notice) => notice.state), ["uncertainty_accepted"]);
  }), { timeout: 10_000 });

  it.live("start refuses a committed notice after its rule or settings generation changed, and commits stop at three per thread per hour", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withGuidance(directory, (store) => Effect.gen(function* () {
      const observing = yield* store.saveRule(ruleInput(), 1);
      const rule = yield* store.saveRule(ruleInput({ ...observing, expectedGeneration: observing.generation, mode: "send" }), 2);
      const settings = yield* store.settings();
      const first = (yield* store.commit(rule, settings.generation, "thread-a", "run-1", 1_000))!;
      const moved = yield* store.saveSettings(settings);
      const refused = yield* store.start(first.id);
      yield* store.finish(first.id, "rejected", null);
      const hourly: Array<boolean> = [];
      for (const [index, ruleName] of ["a", "b", "c", "d"].entries()) {
        const other = yield* store.saveRule(ruleInput({ name: `Rule ${ruleName}` }), 3);
        const sending = yield* store.saveRule(ruleInput({ ...other, expectedGeneration: other.generation, mode: "send" }), 3);
        const notice = yield* store.commit(sending, moved.generation, "thread-b", `run-${index}`, 10_000 + index);
        hourly.push(notice !== null);
      }
      return { refused, hourly };
    }));
    assert.equal(observed.refused, false);
    assert.deepEqual(observed.hourly, [true, true, true, false]);
  }), { timeout: 10_000 });
});
