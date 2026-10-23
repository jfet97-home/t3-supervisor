import { createHash } from "node:crypto";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { GuidanceDb, untracedSql } from "./db.js";
import { decodeGuidanceRow, type GuidanceStoreError, guidanceSql, tableColumns } from "./guidance-sql.js";
import { SupervisorIds } from "./ids.js";
import {
  Activity,
  Rule,
  Settings,
  type GuidanceActivity,
  type GuidanceRule,
  type GuidanceSettings,
} from "./guidance-contract.js";

const defaults: GuidanceSettings = {
  generation: 1,
  guidancePaused: false,
  monitoringPaused: false,
  allowFollowupRace: false,
  verifiedServerVersion: null,
  model: "gpt-6-luna",
  reasoning: "high",
  dailyTokenBudget: 100_000,
  evidenceHours: 24,
  maxAnchorAgeSeconds: 60,
};
export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A user-facing guidance conflict, with the baseline store's message. */
export class GuidanceConflictError extends Schema.TaggedError<GuidanceConflictError>()("GuidanceConflict", {
  message: Schema.String,
}) {}

const MetaValue = Schema.Struct({ value: Schema.String });
const DocumentColumn = Schema.Struct({ document: Schema.String });
const decodeSettingsRow = decodeGuidanceRow(Schema.Struct({ value: Schema.fromJsonString(Settings) }), "settings");
const decodeRuleRow = decodeGuidanceRow(Schema.Struct({ document: Schema.fromJsonString(Rule) }), "rule");
const decodeActivityDocument = decodeGuidanceRow(Schema.fromJsonString(Activity), "activity");
const decodeActivityRow = decodeGuidanceRow(Schema.Struct({ id: Schema.String, document: Schema.String }), "activity");
const decodeDocumentColumn = decodeGuidanceRow(DocumentColumn, "activity");
const decodeMetaValue = decodeGuidanceRow(MetaValue, "meta");
const decodeMuteRow = decodeGuidanceRow(Schema.Struct({ rule_id: Schema.String, scope_id: Schema.String }), "mute");
const decodeClassificationRow = decodeGuidanceRow(Schema.Struct({ classification: Schema.String }), "classification");
const decodeHashRow = decodeGuidanceRow(Schema.Struct({ hash: Schema.Unknown }), "observation");
const decodeTokensRow = decodeGuidanceRow(Schema.Struct({ tokens: Schema.Number }), "budget");
const decodeEpisodeRow = decodeGuidanceRow(Schema.Struct({ epoch: Schema.Number, object_id: Schema.NullOr(Schema.String) }), "episode");
const NoticeColumns = Schema.Struct({
  id: Schema.String, thread_id: Schema.String, rule_id: Schema.String, run_id: Schema.String, epoch: Schema.Number, state: Schema.String,
  text: Schema.String, message_id: Schema.NullOr(Schema.String), created_at: Schema.Number, dispatch_started: Schema.Number,
  rule_generation: Schema.Number, settings_generation: Schema.Number,
});
const decodeNoticeRow = decodeGuidanceRow(NoticeColumns, "notice");
const decodeUnresolvedRow = decodeGuidanceRow(NoticeColumns.mapFields((fields) => ({
  id: fields.id, thread_id: fields.thread_id, rule_id: fields.rule_id, run_id: fields.run_id, epoch: fields.epoch, created_at: fields.created_at,
})), "notice");
const decodeNoticeKeyRow = decodeGuidanceRow(Schema.Struct({ thread_id: Schema.String, rule_id: Schema.String, epoch: Schema.Number }), "notice");

type GuidanceFailure = GuidanceStoreError | GuidanceConflictError;
type RecordInput = Omit<GuidanceActivity, "id" | "createdAt"> & ({kind:"guidance";episodeEpoch:number;noticeId:string|null}|{kind:"owner_action"});

/** The guidance store: dashboard settings, rules, classifications, observations, budget, activity and notice reconciliation. */
export interface GuidanceStoreShape {
  readonly settings: () => Effect.Effect<GuidanceSettings, GuidanceStoreError>;
  readonly bind: (environmentId: string) => Effect.Effect<void, GuidanceFailure>;
  readonly rules: () => Effect.Effect<GuidanceRule[], GuidanceStoreError>;
  readonly rule: (id: string) => Effect.Effect<GuidanceRule | undefined, GuidanceStoreError>;
  readonly saveSettings: (input: GuidanceSettings) => Effect.Effect<GuidanceSettings, GuidanceFailure>;
  readonly mutes: () => Effect.Effect<Array<{ ruleId: string; scopeId: string }>, GuidanceStoreError>;
  readonly classification: (id: string) => Effect.Effect<"project" | "scratch" | "unclassified", GuidanceStoreError>;
  readonly classify: (id: string, classification: "project" | "scratch", generation: number) => Effect.Effect<void, GuidanceFailure>;
  readonly observe: (threadId: string, hash: string, now: number) => Effect.Effect<boolean, GuidanceStoreError>;
  readonly previousHash: (threadId: string) => Effect.Effect<string | null, GuidanceStoreError>;
  readonly used: (now?: number) => Effect.Effect<number, GuidanceStoreError>;
  readonly record: (value: RecordInput, now?: number) => Effect.Effect<GuidanceActivity, GuidanceStoreError>;
  readonly activities: () => Effect.Effect<GuidanceActivity[], GuidanceStoreError>;
  readonly prune: (now?: number) => Effect.Effect<void, GuidanceStoreError>;
  readonly episode: (threadId: string, ruleId: string) => Effect.Effect<{ epoch: number; objectId: string | null }, GuidanceStoreError>;
  readonly reconcile: (id: string) => Effect.Effect<void, GuidanceStoreError>;
}

const schema = [
  "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY,document TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mutes(rule_id TEXT NOT NULL,scope_id TEXT NOT NULL,PRIMARY KEY(rule_id,scope_id))",
  "CREATE TABLE IF NOT EXISTS classifications(project_id TEXT PRIMARY KEY,classification TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS observations(thread_id TEXT PRIMARY KEY,hash TEXT NOT NULL,observed_at INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS episodes(thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread_id,rule_id))`,
  `CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,state TEXT NOT NULL,text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,
        dispatch_started INTEGER NOT NULL DEFAULT 0)`,
  "CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,document TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY,tokens INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS activity_notice ON activity(json_extract(document,'$.noticeId'),created_at)",
];

const budgetDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

const makeGuidanceStore = Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const ids = yield* SupervisorIds;
  const conflict = (message: string) => Effect.fail(new GuidanceConflictError({ message }));

  const readSettings = db`SELECT value FROM meta WHERE key='settings'`.pipe(
    Effect.flatMap(([row]) => decodeSettingsRow(row)), Effect.map((row) => row.value));
  const readRules = db`SELECT document FROM rules ORDER BY id`.pipe(
    Effect.flatMap(Effect.forEach((row) => decodeRuleRow(row))), Effect.map((rows) => rows.map((row) => row.document)));
  const readRule = (id: string) => db`SELECT document FROM rules WHERE id=${id}`.pipe(
    Effect.flatMap(([row]) => row === undefined ? Effect.succeed(undefined) : Effect.map(decodeRuleRow(row), (decoded) => decoded.document)));
  const readEpisode = (threadId: string, ruleId: string) => db`SELECT epoch,object_id FROM episodes WHERE thread_id=${threadId} AND rule_id=${ruleId}`.pipe(
    Effect.flatMap(([row]) => row === undefined ? Effect.succeed({ epoch: 0, objectId: null }) :
      Effect.map(decodeEpisodeRow(row), (episode) => ({ epoch: episode.epoch, objectId: episode.object_id }))));
  const readUsed = (now: number) => db`SELECT tokens FROM budget WHERE day=${budgetDay(now)}`.pipe(
    Effect.flatMap(([row]) => row === undefined ? Effect.succeed(0) : Effect.map(decodeTokensRow(row), (budget) => budget.tokens)));
  const nowOr = (now: number | undefined) => now === undefined ? Clock.currentTimeMillis : Effect.succeed(now);
  const writeActivity = Effect.fnUntraced(function* (value: RecordInput, now: number) {
    const activity = { ...value, id: yield* ids.uuid, createdAt: now };
    yield* db`INSERT INTO activity VALUES(${activity.id},${JSON.stringify(activity)},${now})`;
    return activity;
  });

  // schema, the default settings row, the column additions and the restart recovery of committed notices, in the
  // synchronous constructor's order and in one transaction
  yield* guidanceSql(db.withTransaction(Effect.gen(function* () {
    for (const statement of schema) yield* db.unsafe(statement);
    yield* db`INSERT OR IGNORE INTO meta VALUES('settings',${JSON.stringify(defaults)})`;
    if (!(yield* tableColumns(db, "episodes")).includes("object_id")) yield* db.unsafe("ALTER TABLE episodes ADD COLUMN object_id TEXT");
    const noticeColumns = yield* tableColumns(db, "notices");
    for (const column of ["rule_generation", "settings_generation"])
      if (!noticeColumns.includes(column)) yield* db.unsafe(`ALTER TABLE notices ADD COLUMN ${column} INTEGER NOT NULL DEFAULT -1`);
    const recovering = yield* Effect.forEach(yield* db`SELECT * FROM notices WHERE state='committed'`, (row) => decodeNoticeRow(row));
    yield* db`UPDATE notices SET state=CASE WHEN dispatch_started=0 THEN 'not_delivered_restart' ELSE 'uncertain' END WHERE state='committed'`;
    const now = yield* Clock.currentTimeMillis;
    for (const row of recovering)
      yield* writeActivity({kind:"guidance",threadId:row.thread_id,ruleId:row.rule_id,runId:row.run_id,
        noticeId:row.id,episodeEpoch:row.epoch,state:row.dispatch_started===1?"uncertain":"not_delivered_restart",
        reason:"process_recovery",detail:null}, now);
  })));

  const settings = () => guidanceSql(readSettings);

  // read-check-write: joins the caller's transaction
  const bind = (environmentId: string) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const [row] = yield* db`SELECT value FROM meta WHERE key='environment'`;
    const previous = row === undefined ? undefined : (yield* decodeMetaValue(row)).value;
    if (previous !== undefined && previous !== environmentId) return yield* conflict("Guidance belongs to another T3 environment.");
    yield* db`INSERT OR IGNORE INTO meta VALUES('environment',${environmentId})`;
  })));

  const rules = () => guidanceSql(readRules);
  const rule = (id: string) => guidanceSql(readRule(id));

  const saveSettings = (input: GuidanceSettings) => guidanceSql(Effect.gen(function* () {
    if (input.model !== "gpt-6-luna" || !Number.isSafeInteger(input.dailyTokenBudget) || input.dailyTokenBudget < 1000 ||
      input.dailyTokenBudget > 1_000_000 || ![24, 168].includes(input.evidenceHours) || !Number.isSafeInteger(input.maxAnchorAgeSeconds) ||
      input.maxAnchorAgeSeconds < 10 || input.maxAnchorAgeSeconds > 600)
      return yield* conflict("Choose supported monitoring settings.");
    return yield* db.withTransaction(Effect.gen(function* () {
      const old = yield* readSettings;
      if (old.generation !== input.generation) return yield* conflict("Settings changed in another tab. Reload first.");
      const next = { ...input, generation: old.generation + 1 };
      yield* db`UPDATE meta SET value=${JSON.stringify(next)} WHERE key='settings'`;
      if ((old.guidancePaused && !next.guidancePaused) || (old.monitoringPaused && !next.monitoringPaused) ||
        (!old.allowFollowupRace && next.allowFollowupRace) || old.verifiedServerVersion !== next.verifiedServerVersion) {
        const now = yield* Clock.currentTimeMillis;
        for (const current of yield* readRules) yield* db`UPDATE rules SET document=${JSON.stringify({ ...current, liveSince: now })} WHERE id=${current.id}`;
      }
      return next;
    }));
  }));

  const mutes = () => guidanceSql(db`SELECT rule_id,scope_id FROM mutes`.pipe(
    Effect.flatMap(Effect.forEach((row) => decodeMuteRow(row))), Effect.map((rows) => rows.map((row) => ({ ruleId: row.rule_id, scopeId: row.scope_id })))));

  const classification = (id: string) => guidanceSql(db`SELECT classification FROM classifications WHERE project_id=${id}`.pipe(
    Effect.flatMap(([row]) => row === undefined ? Effect.succeed(undefined) : Effect.map(decodeClassificationRow(row), (value) => value.classification)),
    Effect.map((value) => value === "project" || value === "scratch" ? value : "unclassified" as const)));

  const classify = (id: string, value: "project" | "scratch", generation: number) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const current = yield* readSettings;
    if (current.generation !== generation) return yield* conflict("Settings changed. Reload first.");
    yield* db`INSERT INTO classifications VALUES(${id},${value}) ON CONFLICT(project_id) DO UPDATE SET classification=excluded.classification`;
    yield* db`UPDATE meta SET value=${JSON.stringify({ ...current, generation: generation + 1 })} WHERE key='settings'`;
  })));

  // CC-GDB-IMPLICIT: the read and the upsert commit together
  const observe = (threadId: string, hash: string, now: number) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const [row] = yield* db`SELECT hash FROM observations WHERE thread_id=${threadId}`;
    const previous = row === undefined ? undefined : yield* decodeHashRow(row);
    yield* db`INSERT INTO observations VALUES(${threadId},${hash},${now}) ON CONFLICT(thread_id) DO UPDATE SET hash=excluded.hash,observed_at=excluded.observed_at`;
    return previous !== undefined && previous.hash !== hash;
  })));

  const previousHash = (threadId: string) => guidanceSql(db`SELECT hash FROM observations WHERE thread_id=${threadId}`.pipe(
    Effect.flatMap(([row]) => row === undefined ? Effect.succeed(null) : Effect.map(decodeHashRow(row), (value) => typeof value.hash === "string" ? value.hash : null))));

  const used = (now?: number) => guidanceSql(Effect.flatMap(nowOr(now), readUsed));

  const record = (value: RecordInput, now?: number) => guidanceSql(Effect.flatMap(nowOr(now), (at) => writeActivity(value, at)));

  // two reads of one snapshot
  const activities = () => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const unresolved: GuidanceActivity[] = [];
    for (const raw of yield* db`SELECT id,thread_id,rule_id,run_id,epoch,created_at FROM notices WHERE state='uncertain' ORDER BY created_at DESC`) {
      const row = yield* decodeUnresolvedRow(raw);
      const [evidence] = yield* db`SELECT document FROM activity WHERE json_extract(document,'$.noticeId')=${row.id} AND json_extract(document,'$.detail') IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
      const detail = evidence === undefined ? null : (yield* decodeActivityDocument((yield* decodeDocumentColumn(evidence)).document)).detail;
      unresolved.push({
        id:`notice:${row.id}`,noticeId:row.id,episodeEpoch:row.epoch,threadId:row.thread_id,ruleId:row.rule_id,runId:row.run_id,
        kind:"guidance",state:"uncertain",reason:"unreconciled_notice",detail,createdAt:row.created_at,
      });
    }
    const recent: GuidanceActivity[] = [];
    for (const row of yield* db`SELECT document FROM activity ORDER BY created_at DESC LIMIT 200`)
      recent.push(yield* decodeActivityDocument((yield* decodeDocumentColumn(row)).document));
    return [...unresolved,...recent.filter(row=>!unresolved.some(notice=>notice.noticeId===row.noticeId))];
  })));

  // CC-GDB-IMPLICIT: every pruning statement commits together, or none does
  const prune = (now?: number) => guidanceSql(Effect.flatMap(nowOr(now), (at) => db.withTransaction(Effect.gen(function* () {
    const evidenceCutoff = at - (yield* readSettings).evidenceHours * 3600_000;
    yield* db`UPDATE notices SET text='' WHERE created_at<${evidenceCutoff} AND state IN ('visible','accepted','rejected','not_delivered_restart')`;
    for (const raw of yield* db`SELECT id,document FROM activity WHERE created_at<${evidenceCutoff}`) {
      const row = yield* decodeActivityRow(raw);
      const activity = yield* decodeActivityDocument(row.document);
      if (activity.detail !== null) yield* db`UPDATE activity SET document=${JSON.stringify({ ...activity, detail: null })} WHERE id=${row.id}`;
    }
    yield* db`DELETE FROM activity WHERE created_at<${at - 30 * 86400_000}`;
    yield* db`DELETE FROM budget WHERE day<${budgetDay(at - 7 * 86400_000)}`;
  }))));

  const episode = (threadId: string, ruleId: string) => guidanceSql(readEpisode(threadId, ruleId));

  const reconcile = (id: string) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const [raw] = yield* db`SELECT thread_id,rule_id,epoch FROM notices WHERE id=${id} AND state IN ('accepted','uncertain','uncertainty_accepted')`;
    if (raw === undefined) return;
    const row = yield* decodeNoticeKeyRow(raw);
    yield* db`UPDATE notices SET state='visible' WHERE id=${id}`;
    yield* db`UPDATE episodes SET notified=1 WHERE thread_id=${row.thread_id} AND rule_id=${row.rule_id} AND epoch=${row.epoch}`;
  })));

  return GuidanceStore.of({
    settings, bind, rules, rule, saveSettings, mutes, classification, classify, observe, previousHash, used, record, activities, prune, episode,
    reconcile,
  });
});

/**
 * The guidance store on the run's GuidanceDb client. Its layer creates the schema, the default settings, the column
 * additions and the restart recovery once. Every multi-statement method runs in one transaction and joins the caller's
 * transaction when there is one (a savepoint); time comes from Clock and identities from SupervisorIds.
 */
export class GuidanceStore extends Context.Service<GuidanceStore, GuidanceStoreShape>()("t3-supervisor/GuidanceStore") {
  static readonly layer: Layer.Layer<GuidanceStore, GuidanceStoreError, GuidanceDb | SupervisorIds> =
    Layer.effect(GuidanceStore, untracedSql(makeGuidanceStore));
}
