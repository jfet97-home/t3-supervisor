import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Clock, Context, Data, Effect, Layer, Schema } from "effect";
import { type SqlClient, SqlError } from "effect/sql";
import { GuidanceDb, untracedSql } from "./db.js";
import { SupervisorIds } from "./ids.js";
import {
  Activity,
  Rule,
  Settings,
  type GuidanceActivity,
  type GuidanceRule,
  type GuidanceRuleInput,
  type GuidanceSettings,
} from "./guidance-contract.js";

export class GuidanceConflict extends Error {}
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
const parseRule = (value: unknown) =>
  Schema.decodeUnknownSync(Rule)(JSON.parse(String(value)) as unknown);
const parseActivity = (value: unknown) =>
  Schema.decodeUnknownSync(Activity)(JSON.parse(String(value)) as unknown);
const meaningful = (value: string, max: number) =>
  value.trim().length > 0 && value.length <= max;
export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// the synchronous store of today's callers; the s6d switch removes it, with GuidanceConflict, for GuidanceStoreService
/** Owns the retained dashboard activity and settings state. */
export class GuidanceStore {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "guidance.sqlite3");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      PRAGMA secure_delete=ON; PRAGMA max_page_count=16384;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mutes(rule_id TEXT NOT NULL,scope_id TEXT NOT NULL,PRIMARY KEY(rule_id,scope_id));
      CREATE TABLE IF NOT EXISTS classifications(project_id TEXT PRIMARY KEY,classification TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(thread_id TEXT PRIMARY KEY,hash TEXT NOT NULL,observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS episodes(thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread_id,rule_id));
      CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,state TEXT NOT NULL,text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,
        dispatch_started INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,document TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY,tokens INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_notice ON activity(json_extract(document,'$.noticeId'),created_at);`);
    this.db
      .prepare("INSERT OR IGNORE INTO meta VALUES('settings',?)")
      .run(JSON.stringify(defaults));
    if (
      !this.db
        .prepare("PRAGMA table_info(episodes)")
        .all()
        .some((row) => row.name === "object_id")
    )
      this.db.exec("ALTER TABLE episodes ADD COLUMN object_id TEXT");
    const noticeColumns = this.db.prepare("PRAGMA table_info(notices)").all();
    for (const column of ["rule_generation", "settings_generation"])
      if (!noticeColumns.some((row) => row.name === column))
        this.db.exec(`ALTER TABLE notices ADD COLUMN ${column} INTEGER NOT NULL DEFAULT -1`);
    const recovering = this.db.prepare("SELECT * FROM notices WHERE state='committed'").all();
    this.db
      .prepare(
        "UPDATE notices SET state=CASE WHEN dispatch_started=0 THEN 'not_delivered_restart' ELSE 'uncertain' END WHERE state='committed'",
      )
      .run();
    for (const row of recovering)
      this.record({kind:"guidance",threadId:String(row.thread_id),ruleId:String(row.rule_id),runId:String(row.run_id),
        noticeId:String(row.id),episodeEpoch:Number(row.epoch),state:row.dispatch_started===1?"uncertain":"not_delivered_restart",
        reason:"process_recovery",detail:null});
  }
  close() {
    this.db.close();
  }
  transaction<A>(f: () => A): A {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = f();
      this.db.exec("COMMIT");
      return value;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }
  settings(): GuidanceSettings {
    return Schema.decodeUnknownSync(Settings)(
      JSON.parse(
        String(
          this.db.prepare("SELECT value FROM meta WHERE key='settings'").get()
            ?.value,
        ),
      ) as unknown,
    );
  }
  bind(environmentId: string): void {
    const previous = this.db
      .prepare("SELECT value FROM meta WHERE key='environment'")
      .get()?.value;
    if (previous !== undefined && previous !== environmentId)
      throw new GuidanceConflict("Guidance belongs to another T3 environment.");
    this.db
      .prepare("INSERT OR IGNORE INTO meta VALUES('environment',?)")
      .run(environmentId);
  }
  rules(): GuidanceRule[] {
    return this.db
      .prepare("SELECT document FROM rules ORDER BY id")
      .all()
      .map((row) => parseRule(row.document));
  }
  rule(id: string): GuidanceRule | undefined {
    const row = this.db
      .prepare("SELECT document FROM rules WHERE id=?")
      .get(id);
    return row ? parseRule(row.document) : undefined;
  }
  saveRule(input: GuidanceRuleInput, now = Date.now()): GuidanceRule {
    if (
      !meaningful(input.name, 100) ||
      !meaningful(input.condition, 8000) ||
      !meaningful(input.message, 8000)
    )
      throw new GuidanceConflict(
        "Complete the name, condition and message within their length limits.",
      );
    if ((input.scope === "project") !== (input.projectId !== null))
      throw new GuidanceConflict("Choose a project for a project rule only.");
    return this.transaction(() => {
      const previous = input.id === null ? undefined : this.rule(input.id);
      if (input.id !== null && !previous)
        throw new GuidanceConflict("Rule no longer exists.");
      if ((previous?.generation ?? 0) !== input.expectedGeneration)
        throw new GuidanceConflict(
          "This rule changed in another tab. Reload it before saving.",
        );
      if (!previous && this.rules().length >= 200)
        throw new GuidanceConflict("Rule capacity reached.");
      const changed =
        !previous ||
        ["name", "condition", "message", "scope", "projectId"].some((key) => {
          const a: Record<string, unknown> = { ...previous };
          const b: Record<string, unknown> = { ...input };
          return a[key] !== b[key];
        });
      const mode = changed && input.mode === "send" ? "observe" : input.mode;
      const noop = previous && !changed && previous.mode === mode;
      const rule: GuidanceRule = {
        ...input,
        id: previous?.id ?? randomUUID(),
        mode,
        revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
        generation: (previous?.generation ?? 0) + (noop ? 0 : 1),
        liveSince:
          !previous || changed || previous.mode !== mode
            ? now
            : previous.liveSince,
        updatedAt: noop ? previous.updatedAt : now,
      };
      this.db
        .prepare(
          "INSERT INTO rules VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
        )
        .run(rule.id, JSON.stringify(rule));
      return rule;
    });
  }
  saveSettings(input: GuidanceSettings): GuidanceSettings {
    if (
      input.model !== "gpt-6-luna" ||
      !Number.isSafeInteger(input.dailyTokenBudget) ||
      input.dailyTokenBudget < 1000 ||
      input.dailyTokenBudget > 1_000_000 ||
      ![24, 168].includes(input.evidenceHours) ||
      !Number.isSafeInteger(input.maxAnchorAgeSeconds) ||
      input.maxAnchorAgeSeconds < 10 ||
      input.maxAnchorAgeSeconds > 600
    )
      throw new GuidanceConflict("Choose supported monitoring settings.");
    return this.transaction(() => {
      const old = this.settings();
      if (old.generation !== input.generation)
        throw new GuidanceConflict(
          "Settings changed in another tab. Reload first.",
        );
      const next = { ...input, generation: old.generation + 1 };
      this.db
        .prepare("UPDATE meta SET value=? WHERE key='settings'")
        .run(JSON.stringify(next));
      if (
        (old.guidancePaused && !next.guidancePaused) ||
        (old.monitoringPaused && !next.monitoringPaused) ||
        (!old.allowFollowupRace && next.allowFollowupRace) ||
        old.verifiedServerVersion !== next.verifiedServerVersion
      ) {
        const now = Date.now();
        for (const rule of this.rules())
          this.db
            .prepare("UPDATE rules SET document=? WHERE id=?")
            .run(JSON.stringify({ ...rule, liveSince: now }), rule.id);
      }
      return next;
    });
  }
  mutes(): Array<{ ruleId: string; scopeId: string }> {
    return this.db
      .prepare("SELECT rule_id,scope_id FROM mutes")
      .all()
      .map((row) => ({
        ruleId: String(row.rule_id),
        scopeId: String(row.scope_id),
      }));
  }
  mute(
    ruleId: string,
    scopeId: string,
    muted: boolean,
    generation: number,
  ): void {
    this.transaction(() => {
      const rule = this.rule(ruleId);
      if (!rule || rule.scope !== "global" || rule.generation !== generation)
        throw new GuidanceConflict("The global rule changed. Reload first.");
      if (muted)
        this.db
          .prepare("INSERT OR IGNORE INTO mutes VALUES(?,?)")
          .run(ruleId, scopeId);
      else
        this.db
          .prepare("DELETE FROM mutes WHERE rule_id=? AND scope_id=?")
          .run(ruleId, scopeId);
      this.db
        .prepare("UPDATE rules SET document=? WHERE id=?")
        .run(
          JSON.stringify({
            ...rule,
            generation: rule.generation + 1,
            liveSince: Date.now(),
          }),
          ruleId,
        );
    });
  }
  classification(id: string): "project" | "scratch" | "unclassified" {
    const value = this.db
      .prepare("SELECT classification FROM classifications WHERE project_id=?")
      .get(id)?.classification;
    return value === "project" || value === "scratch" ? value : "unclassified";
  }
  classify(
    id: string,
    classification: "project" | "scratch",
    generation: number,
  ): void {
    this.transaction(() => {
      const settings = this.settings();
      if (settings.generation !== generation)
        throw new GuidanceConflict("Settings changed. Reload first.");
      this.db
        .prepare(
          "INSERT INTO classifications VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET classification=excluded.classification",
        )
        .run(id, classification);
      this.db
        .prepare("UPDATE meta SET value=? WHERE key='settings'")
        .run(JSON.stringify({ ...settings, generation: generation + 1 }));
    });
  }
  observe(threadId: string, hash: string, now: number): boolean {
    const previous = this.db
      .prepare("SELECT hash FROM observations WHERE thread_id=?")
      .get(threadId);
    this.db
      .prepare(
        "INSERT INTO observations VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET hash=excluded.hash,observed_at=excluded.observed_at",
      )
      .run(threadId, hash, now);
    return previous !== undefined && previous.hash !== hash;
  }
  previousHash(threadId: string): string | null {
    const value = this.db
      .prepare("SELECT hash FROM observations WHERE thread_id=?")
      .get(threadId)?.hash;
    return typeof value === "string" ? value : null;
  }
  used(now = Date.now()): number {
    return Number(
      this.db
        .prepare("SELECT tokens FROM budget WHERE day=?")
        .get(new Date(now).toISOString().slice(0, 10))?.tokens ?? 0,
    );
  }
  reserveTokens(tokens: number): boolean {
    if (this.used() + tokens > this.settings().dailyTokenBudget) return false;
    this.db
      .prepare(
        "INSERT INTO budget VALUES(?,?) ON CONFLICT(day) DO UPDATE SET tokens=tokens+excluded.tokens",
      )
      .run(new Date().toISOString().slice(0, 10), tokens);
    return true;
  }
  record(
    value: Omit<GuidanceActivity, "id" | "createdAt"> & ({kind:"guidance";episodeEpoch:number;noticeId:string|null}|{kind:"owner_action"}),
    now = Date.now(),
  ): GuidanceActivity {
    const activity = { ...value, id: randomUUID(), createdAt: now };
    this.db
      .prepare("INSERT INTO activity VALUES(?,?,?)")
      .run(activity.id, JSON.stringify(activity), now);
    return activity;
  }
  activities(): GuidanceActivity[] {
    const unresolved=this.db.prepare("SELECT id,thread_id,rule_id,run_id,epoch,created_at FROM notices WHERE state='uncertain' ORDER BY created_at DESC").all().map(row=>{
      const evidence=this.db.prepare("SELECT document FROM activity WHERE json_extract(document,'$.noticeId')=? AND json_extract(document,'$.detail') IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(String(row.id));
      return {
      id:`notice:${String(row.id)}`,noticeId:String(row.id),episodeEpoch:Number(row.epoch),threadId:String(row.thread_id),ruleId:String(row.rule_id),runId:String(row.run_id),
      kind:"guidance",state:"uncertain",reason:"unreconciled_notice",detail:evidence?parseActivity(evidence.document).detail:null,createdAt:Number(row.created_at),
    };});
    const recent=this.db
      .prepare(
        "SELECT document FROM activity ORDER BY created_at DESC LIMIT 200",
      )
      .all()
      .map((row) => parseActivity(row.document));
    return [...unresolved,...recent.filter(row=>!unresolved.some(notice=>notice.noticeId===row.noticeId))];
  }
  prune(now = Date.now()): void {
    const evidenceCutoff = now - this.settings().evidenceHours * 3600_000;
    this.db.prepare("UPDATE notices SET text='' WHERE created_at<? AND state IN ('visible','accepted','rejected','not_delivered_restart')").run(evidenceCutoff);
    for (const row of this.db
      .prepare("SELECT id,document FROM activity WHERE created_at<?")
      .all(evidenceCutoff)) {
      const activity = parseActivity(row.document);
      if (activity.detail !== null)
        this.db
          .prepare("UPDATE activity SET document=? WHERE id=?")
          .run(JSON.stringify({ ...activity, detail: null }), String(row.id));
    }
    this.db
      .prepare("DELETE FROM activity WHERE created_at<?")
      .run(now - 30 * 86400_000);
    this.db
      .prepare("DELETE FROM budget WHERE day<?")
      .run(new Date(now - 7 * 86400_000).toISOString().slice(0, 10));
  }
  episode(threadId:string,ruleId:string):{epoch:number;objectId:string|null} {
    const row=this.db.prepare("SELECT epoch,object_id FROM episodes WHERE thread_id=? AND rule_id=?").get(threadId,ruleId);
    return {epoch:Number(row?.epoch??0),objectId:typeof row?.object_id==="string"?row.object_id:null};
  }
  reset(threadId: string, ruleId: string, acceptUncertainty = false, expectedEpoch=this.episode(threadId,ruleId).epoch, noticeId:string|null=null): void {
    this.transaction(() => {
      if(this.episode(threadId,ruleId).epoch!==expectedEpoch)throw new GuidanceConflict("The episode changed. Reload first.");
      const uncertain = this.db
        .prepare(
          "SELECT id FROM notices WHERE thread_id=? AND rule_id=? AND state IN ('committed','uncertain')",
        )
        .get(threadId, ruleId);
      if (uncertain && !acceptUncertainty)
        throw new GuidanceConflict(
          "Reconcile or explicitly accept the delivery uncertainty first.",
        );
      if (acceptUncertainty) {
        if(!noticeId || uncertain?.id!==noticeId)throw new GuidanceConflict("The uncertain notice changed. Reload first.");
        this.db
          .prepare(
            "UPDATE notices SET state='uncertainty_accepted' WHERE id=? AND epoch=? AND state='uncertain'",
          )
          .run(noticeId,expectedEpoch);
      }
      if (
        this.db
          .prepare(
            "SELECT id FROM notices WHERE thread_id=? AND rule_id=? AND state='committed'",
          )
          .get(threadId, ruleId)
      )
        throw new GuidanceConflict("A dispatch is still in flight.");
      this.db
        .prepare(
          "INSERT INTO episodes(thread_id,rule_id,epoch,notified) VALUES(?,?,1,0) ON CONFLICT(thread_id,rule_id) DO UPDATE SET epoch=epoch+1,notified=0,object_id=NULL",
        )
        .run(threadId, ruleId);
    });
  }
  commit(
    rule: GuidanceRule,
    settingsGeneration: number,
    threadId: string,
    runId: string,
    now: number,
    objectId: string | null = null,
    newSituation = false,
    expectedEpoch = this.episode(threadId,rule.id).epoch,
  ): { id: string; text: string; epoch:number } | null {
    return this.transaction(() => {
      const current = this.rule(rule.id);
      const settings = this.settings();
      if (
        !current ||
        current.generation !== rule.generation ||
        current.mode !== "send" ||
        settings.generation !== settingsGeneration ||
        settings.guidancePaused ||
        settings.monitoringPaused
        || this.episode(threadId,rule.id).epoch!==expectedEpoch
      )
        return null;
      if (
        this.db
          .prepare(
            "SELECT id FROM notices WHERE thread_id=? AND rule_id=? AND state IN ('committed','uncertain')",
          )
          .get(threadId, rule.id)
      )
        return null;
      this.db
        .prepare(
          "INSERT OR IGNORE INTO episodes(thread_id,rule_id,epoch,notified) VALUES(?,?,0,0)",
        )
        .run(threadId, rule.id);
      let episode = this.db
        .prepare(
          "SELECT epoch,notified,object_id FROM episodes WHERE thread_id=? AND rule_id=?",
        )
        .get(threadId, rule.id)!;
      if (episode.notified === 1) {
        if (
          !newSituation ||
          typeof episode.object_id !== "string" ||
          objectId === null ||
          episode.object_id === objectId
        )
          return null;
        this.db
          .prepare(
            "UPDATE episodes SET epoch=epoch+1,notified=0,object_id=? WHERE thread_id=? AND rule_id=?",
          )
          .run(objectId, threadId, rule.id);
        episode = this.db
          .prepare(
            "SELECT epoch,notified,object_id FROM episodes WHERE thread_id=? AND rule_id=?",
          )
          .get(threadId, rule.id)!;
      } else if (objectId !== null)
        this.db
          .prepare(
            "UPDATE episodes SET object_id=? WHERE thread_id=? AND rule_id=?",
          )
          .run(objectId, threadId, rule.id);
      const recent = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM notices WHERE thread_id=? AND created_at>? AND state NOT IN ('rejected','not_delivered_restart')",
        )
        .get(threadId, now - 3600_000);
      if (Number(recent?.n) >= 3) return null;
      const id = randomUUID();
      const text = `[Supervisor guidance · ${rule.name} · notice ${id}]\n\n${rule.message}`;
      this.db
        .prepare(
          "INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,created_at,rule_generation,settings_generation) VALUES(?,?,?,?,?,'committed',?,?,?,?)",
        )
        .run(id, threadId, rule.id, runId, Number(episode.epoch), text, now,rule.generation,settingsGeneration);
      return { id, text, epoch:Number(episode.epoch) };
    });
  }
  start(id: string): boolean {
    return this.transaction(()=>{
      const notice=this.db.prepare("SELECT * FROM notices WHERE id=? AND state='committed' AND dispatch_started=0").get(id);
      if(!notice)return false;
      const rule=this.rule(String(notice.rule_id));const settings=this.settings();
      if(!rule || rule.mode!=="send" || rule.generation!==notice.rule_generation || settings.generation!==notice.settings_generation || settings.guidancePaused || settings.monitoringPaused || this.episode(String(notice.thread_id),rule.id).epoch!==notice.epoch)return false;
      return (
      Number(
        this.db
          .prepare(
            "UPDATE notices SET dispatch_started=1 WHERE id=? AND state='committed' AND dispatch_started=0",
          )
          .run(id).changes,
      ) === 1
      );
    });
  }
  finish(
    id: string,
    state: "accepted" | "visible" | "rejected" | "uncertain",
    messageId: string | null,
  ): void {
    this.transaction(() => {
      const changed=this.db
        .prepare(
          "UPDATE notices SET state=?,message_id=? WHERE id=? AND state='committed'",
        )
        .run(state, messageId, id);
      if (changed.changes && (state === "accepted" || state === "visible"))
        this.db
          .prepare(
            "UPDATE episodes SET notified=1 WHERE (thread_id,rule_id,epoch)=(SELECT thread_id,rule_id,epoch FROM notices WHERE id=?)",
          )
          .run(id);
    });
  }
  notices(afterId="",limit=100): Array<{
    id: string;
    threadId: string;
    ruleId: string;
    runId: string;
    state: string;
    text: string;
    messageId: string | null;
    epoch:number;
  }> {
    return this.db
      .prepare(
        "SELECT * FROM notices WHERE state IN ('accepted','uncertain','uncertainty_accepted') AND text!='' AND id>? ORDER BY id LIMIT ?",
      )
      .all(afterId,limit)
      .map((row) => ({
        id: String(row.id),
        threadId: String(row.thread_id),
        ruleId: String(row.rule_id),
        runId: String(row.run_id),
        state: String(row.state),
        text: String(row.text),
        messageId: typeof row.message_id === "string" ? row.message_id : null,
        epoch:Number(row.epoch),
      }));
  }
  reconcile(id: string): void {
    this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT thread_id,rule_id,epoch FROM notices WHERE id=? AND state IN ('accepted','uncertain','uncertainty_accepted')",
        )
        .get(id);
      if (!row) return;
      this.db.prepare("UPDATE notices SET state='visible' WHERE id=?").run(id);
      this.db
        .prepare(
          "UPDATE episodes SET notified=1 WHERE thread_id=? AND rule_id=? AND epoch=?",
        )
        .run(String(row.thread_id), String(row.rule_id),Number(row.epoch));
    });
  }
  resolveEpisode(threadId: string, ruleId: string, expectedEpoch=this.episode(threadId,ruleId).epoch,ruleGeneration=this.rule(ruleId)?.generation,settingsGeneration=this.settings().generation): void {
    if(this.episode(threadId,ruleId).epoch!==expectedEpoch || this.rule(ruleId)?.generation!==ruleGeneration || this.settings().generation!==settingsGeneration)return;
    if (
      this.db
        .prepare(
          "SELECT id FROM notices WHERE thread_id=? AND rule_id=? AND state IN ('committed','uncertain')",
        )
        .get(threadId, ruleId)
    )
      return;
    this.db
      .prepare(
        "UPDATE episodes SET epoch=epoch+1,notified=0,object_id=NULL WHERE thread_id=? AND rule_id=?",
      )
      .run(threadId, ruleId);
  }
}

// a guidance.sqlite3 failure: a statement failed (sqlReason is the driver's classification) or a stored row of the named
// kind did not decode; it carries no statement text, row content or cause, and a row that does not decode is never
// read as absent
export class GuidanceStoreError extends Data.TaggedError("GuidanceStoreError")<{
  readonly reason: "sql_failed" | "row_invalid";
  readonly row: string | null;
  readonly sqlReason: string | null;
}> {
  override get message(): string {
    return this.reason === "row_invalid" ? `guidance store row invalid: ${this.row}` : `guidance store sql failed: ${this.sqlReason}`;
  }
}

/** A user-facing guidance conflict; the message is the one the synchronous store throws. */
export class GuidanceConflictError extends Schema.TaggedError<GuidanceConflictError>()("GuidanceConflict", {
  message: Schema.String,
}) {}

/** Fails with the typed error naming the row kind when a stored row does not decode. */
export const decodeGuidanceRow = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, row: string) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: unknown): Effect.Effect<S["Type"], GuidanceStoreError> =>
    decode(value).pipe(Effect.mapError(() => new GuidanceStoreError({ reason: "row_invalid", row, sqlReason: null })));
};

/** Maps the driver's SqlError to the store error and runs the work untraced (statement spans carry query text). */
export const guidanceSql = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, SqlError.SqlError> | GuidanceStoreError, R> =>
  effect.pipe(
    Effect.mapError((error): Exclude<E, SqlError.SqlError> | GuidanceStoreError => SqlError.isSqlError(error)
      ? new GuidanceStoreError({ reason: "sql_failed", row: null, sqlReason: error.reason._tag })
      // every other failure is a store or domain error and passes unchanged
      : error as Exclude<E, SqlError.SqlError>),
    untracedSql,
  );

const ChangesRow = Schema.Struct({ changes: Schema.Number });
/** The number of rows a write statement changed, read from the driver's run result. */
export const changedRows = (statement: Effect.Effect<unknown, SqlError.SqlError>): Effect.Effect<number, SqlError.SqlError | GuidanceStoreError> =>
  statement.pipe(Effect.flatMap(decodeGuidanceRow(ChangesRow, "statement_result")), Effect.map((result) => result.changes));

const ColumnName = Schema.Struct({ name: Schema.String });
/** The column names of a table, for the idempotent column additions at open. */
export const tableColumns = Effect.fnUntraced(function* (db: SqlClient.SqlClient, table: string) {
  const rows = yield* db.unsafe(`PRAGMA table_info(${table})`);
  const columns: string[] = [];
  for (const row of rows) columns.push((yield* decodeGuidanceRow(ColumnName, "table_info")(row)).name);
  return columns;
});

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
const decodeIdRow = decodeGuidanceRow(Schema.Struct({ id: Schema.String }), "notice");
const decodeCountRow = decodeGuidanceRow(Schema.Struct({ n: Schema.Number }), "notice_count");
const decodeEpisodeRow = decodeGuidanceRow(Schema.Struct({ epoch: Schema.Number, object_id: Schema.NullOr(Schema.String) }), "episode");
const decodeEpisodeStateRow = decodeGuidanceRow(Schema.Struct({ epoch: Schema.Number, notified: Schema.Number, object_id: Schema.NullOr(Schema.String) }), "episode");
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
type NoticeView = { id: string; threadId: string; ruleId: string; runId: string; state: string; text: string; messageId: string | null; epoch: number };

/** The Effect API of the guidance store: the synchronous store's methods, returning Effects. */
export interface GuidanceStoreShape {
  readonly settings: () => Effect.Effect<GuidanceSettings, GuidanceStoreError>;
  readonly bind: (environmentId: string) => Effect.Effect<void, GuidanceFailure>;
  readonly rules: () => Effect.Effect<GuidanceRule[], GuidanceStoreError>;
  readonly rule: (id: string) => Effect.Effect<GuidanceRule | undefined, GuidanceStoreError>;
  readonly saveRule: (input: GuidanceRuleInput, now?: number) => Effect.Effect<GuidanceRule, GuidanceFailure>;
  readonly saveSettings: (input: GuidanceSettings) => Effect.Effect<GuidanceSettings, GuidanceFailure>;
  readonly mutes: () => Effect.Effect<Array<{ ruleId: string; scopeId: string }>, GuidanceStoreError>;
  readonly mute: (ruleId: string, scopeId: string, muted: boolean, generation: number) => Effect.Effect<void, GuidanceFailure>;
  readonly classification: (id: string) => Effect.Effect<"project" | "scratch" | "unclassified", GuidanceStoreError>;
  readonly classify: (id: string, classification: "project" | "scratch", generation: number) => Effect.Effect<void, GuidanceFailure>;
  readonly observe: (threadId: string, hash: string, now: number) => Effect.Effect<boolean, GuidanceStoreError>;
  readonly previousHash: (threadId: string) => Effect.Effect<string | null, GuidanceStoreError>;
  readonly used: (now?: number) => Effect.Effect<number, GuidanceStoreError>;
  readonly reserveTokens: (tokens: number) => Effect.Effect<boolean, GuidanceStoreError>;
  readonly record: (value: RecordInput, now?: number) => Effect.Effect<GuidanceActivity, GuidanceStoreError>;
  readonly activities: () => Effect.Effect<GuidanceActivity[], GuidanceStoreError>;
  readonly prune: (now?: number) => Effect.Effect<void, GuidanceStoreError>;
  readonly episode: (threadId: string, ruleId: string) => Effect.Effect<{ epoch: number; objectId: string | null }, GuidanceStoreError>;
  readonly reset: (threadId: string, ruleId: string, acceptUncertainty?: boolean, expectedEpoch?: number, noticeId?: string | null) =>
    Effect.Effect<void, GuidanceFailure>;
  readonly commit: (rule: GuidanceRule, settingsGeneration: number, threadId: string, runId: string, now: number, objectId?: string | null,
    newSituation?: boolean, expectedEpoch?: number) => Effect.Effect<{ id: string; text: string; epoch: number } | null, GuidanceStoreError>;
  readonly start: (id: string) => Effect.Effect<boolean, GuidanceStoreError>;
  readonly finish: (id: string, state: "accepted" | "visible" | "rejected" | "uncertain", messageId: string | null) => Effect.Effect<void, GuidanceStoreError>;
  readonly notices: (afterId?: string, limit?: number) => Effect.Effect<NoticeView[], GuidanceStoreError>;
  readonly reconcile: (id: string) => Effect.Effect<void, GuidanceStoreError>;
  readonly resolveEpisode: (threadId: string, ruleId: string, expectedEpoch?: number, ruleGeneration?: number, settingsGeneration?: number) =>
    Effect.Effect<void, GuidanceStoreError>;
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
  const openNotice = (threadId: string, ruleId: string) =>
    db`SELECT id FROM notices WHERE thread_id=${threadId} AND rule_id=${ruleId} AND state IN ('committed','uncertain')`.pipe(
      Effect.flatMap(([row]) => row === undefined ? Effect.succeed(undefined) : Effect.map(decodeIdRow(row), (notice) => notice.id)));
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

  const saveRule = (input: GuidanceRuleInput, now?: number) => guidanceSql(Effect.gen(function* () {
    if (!meaningful(input.name, 100) || !meaningful(input.condition, 8000) || !meaningful(input.message, 8000))
      return yield* conflict("Complete the name, condition and message within their length limits.");
    if ((input.scope === "project") !== (input.projectId !== null)) return yield* conflict("Choose a project for a project rule only.");
    const at = yield* nowOr(now);
    return yield* db.withTransaction(Effect.gen(function* () {
      const previous = input.id === null ? undefined : yield* readRule(input.id);
      if (input.id !== null && !previous) return yield* conflict("Rule no longer exists.");
      if ((previous?.generation ?? 0) !== input.expectedGeneration) return yield* conflict("This rule changed in another tab. Reload it before saving.");
      if (!previous && (yield* readRules).length >= 200) return yield* conflict("Rule capacity reached.");
      const changed = !previous || ["name", "condition", "message", "scope", "projectId"].some((key) => {
        const a: Record<string, unknown> = { ...previous };
        const b: Record<string, unknown> = { ...input };
        return a[key] !== b[key];
      });
      const mode = changed && input.mode === "send" ? "observe" : input.mode;
      const noop = previous && !changed && previous.mode === mode;
      const saved: GuidanceRule = {
        ...input,
        id: previous?.id ?? (yield* ids.uuid),
        mode,
        revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
        generation: (previous?.generation ?? 0) + (noop ? 0 : 1),
        liveSince: !previous || changed || previous.mode !== mode ? at : previous.liveSince,
        updatedAt: noop ? previous.updatedAt : at,
      };
      yield* db`INSERT INTO rules VALUES(${saved.id},${JSON.stringify(saved)}) ON CONFLICT(id) DO UPDATE SET document=excluded.document`;
      return saved;
    }));
  }));

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

  const mute = (ruleId: string, scopeId: string, muted: boolean, generation: number) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const current = yield* readRule(ruleId);
    if (!current || current.scope !== "global" || current.generation !== generation) return yield* conflict("The global rule changed. Reload first.");
    if (muted) yield* db`INSERT OR IGNORE INTO mutes VALUES(${ruleId},${scopeId})`;
    else yield* db`DELETE FROM mutes WHERE rule_id=${ruleId} AND scope_id=${scopeId}`;
    const liveSince = yield* Clock.currentTimeMillis;
    yield* db`UPDATE rules SET document=${JSON.stringify({ ...current, generation: current.generation + 1, liveSince })} WHERE id=${ruleId}`;
  })));

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

  // CC-GDB-IMPLICIT: the budget check and the reservation commit together, on one day
  const reserveTokens = (tokens: number) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if ((yield* readUsed(now)) + tokens > (yield* readSettings).dailyTokenBudget) return false;
    yield* db`INSERT INTO budget VALUES(${budgetDay(now)},${tokens}) ON CONFLICT(day) DO UPDATE SET tokens=tokens+excluded.tokens`;
    return true;
  })));

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

  const reset = (threadId: string, ruleId: string, acceptUncertainty = false, expectedEpoch?: number, noticeId: string | null = null) =>
    guidanceSql(db.withTransaction(Effect.gen(function* () {
      const current = (yield* readEpisode(threadId, ruleId)).epoch;
      const expected = expectedEpoch === undefined ? current : expectedEpoch;
      if (current !== expected) return yield* conflict("The episode changed. Reload first.");
      const uncertain = yield* openNotice(threadId, ruleId);
      if (uncertain !== undefined && !acceptUncertainty) return yield* conflict("Reconcile or explicitly accept the delivery uncertainty first.");
      if (acceptUncertainty) {
        if (!noticeId || uncertain !== noticeId) return yield* conflict("The uncertain notice changed. Reload first.");
        yield* db`UPDATE notices SET state='uncertainty_accepted' WHERE id=${noticeId} AND epoch=${expected} AND state='uncertain'`;
      }
      if ((yield* db`SELECT id FROM notices WHERE thread_id=${threadId} AND rule_id=${ruleId} AND state='committed'`).length > 0)
        return yield* conflict("A dispatch is still in flight.");
      yield* db`INSERT INTO episodes(thread_id,rule_id,epoch,notified) VALUES(${threadId},${ruleId},1,0) ON CONFLICT(thread_id,rule_id) DO UPDATE SET epoch=epoch+1,notified=0,object_id=NULL`;
    })));

  const readEpisodeState = (threadId: string, ruleId: string) =>
    db`SELECT epoch,notified,object_id FROM episodes WHERE thread_id=${threadId} AND rule_id=${ruleId}`.pipe(
      Effect.flatMap(([row]) => decodeEpisodeStateRow(row)));

  const commit = (input: GuidanceRule, settingsGeneration: number, threadId: string, runId: string, now: number, objectId: string | null = null,
    newSituation = false, expectedEpoch?: number) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const epoch = (yield* readEpisode(threadId, input.id)).epoch;
    const expected = expectedEpoch === undefined ? epoch : expectedEpoch;
    const current = yield* readRule(input.id);
    const currentSettings = yield* readSettings;
    if (!current || current.generation !== input.generation || current.mode !== "send" || currentSettings.generation !== settingsGeneration ||
      currentSettings.guidancePaused || currentSettings.monitoringPaused || epoch !== expected)
      return null;
    if ((yield* openNotice(threadId, input.id)) !== undefined) return null;
    yield* db`INSERT OR IGNORE INTO episodes(thread_id,rule_id,epoch,notified) VALUES(${threadId},${input.id},0,0)`;
    let state = yield* readEpisodeState(threadId, input.id);
    if (state.notified === 1) {
      if (!newSituation || state.object_id === null || objectId === null || state.object_id === objectId) return null;
      yield* db`UPDATE episodes SET epoch=epoch+1,notified=0,object_id=${objectId} WHERE thread_id=${threadId} AND rule_id=${input.id}`;
      state = yield* readEpisodeState(threadId, input.id);
    } else if (objectId !== null)
      yield* db`UPDATE episodes SET object_id=${objectId} WHERE thread_id=${threadId} AND rule_id=${input.id}`;
    const [recent] = yield* db`SELECT COUNT(*) AS n FROM notices WHERE thread_id=${threadId} AND created_at>${now - 3600_000} AND state NOT IN ('rejected','not_delivered_restart')`;
    if ((yield* decodeCountRow(recent)).n >= 3) return null;
    const id = yield* ids.uuid;
    const text = `[Supervisor guidance · ${input.name} · notice ${id}]\n\n${input.message}`;
    yield* db`INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,created_at,rule_generation,settings_generation) VALUES(${id},${threadId},${input.id},${runId},${state.epoch},'committed',${text},${now},${input.generation},${settingsGeneration})`;
    return { id, text, epoch: state.epoch };
  })));

  const start = (id: string) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const [raw] = yield* db`SELECT * FROM notices WHERE id=${id} AND state='committed' AND dispatch_started=0`;
    if (raw === undefined) return false;
    const notice = yield* decodeNoticeRow(raw);
    const current = yield* readRule(notice.rule_id);
    const currentSettings = yield* readSettings;
    if (!current || current.mode !== "send" || current.generation !== notice.rule_generation || currentSettings.generation !== notice.settings_generation ||
      currentSettings.guidancePaused || currentSettings.monitoringPaused || (yield* readEpisode(notice.thread_id, current.id)).epoch !== notice.epoch)
      return false;
    return (yield* changedRows(db`UPDATE notices SET dispatch_started=1 WHERE id=${id} AND state='committed' AND dispatch_started=0`.raw)) === 1;
  })));

  const finish = (id: string, state: "accepted" | "visible" | "rejected" | "uncertain", messageId: string | null) =>
    guidanceSql(db.withTransaction(Effect.gen(function* () {
      const changed = yield* changedRows(db`UPDATE notices SET state=${state},message_id=${messageId} WHERE id=${id} AND state='committed'`.raw);
      if (changed && (state === "accepted" || state === "visible"))
        yield* db`UPDATE episodes SET notified=1 WHERE (thread_id,rule_id,epoch)=(SELECT thread_id,rule_id,epoch FROM notices WHERE id=${id})`;
    })));

  const notices = (afterId = "", limit = 100) => guidanceSql(
    db`SELECT * FROM notices WHERE state IN ('accepted','uncertain','uncertainty_accepted') AND text!='' AND id>${afterId} ORDER BY id LIMIT ${limit}`.pipe(
      Effect.flatMap(Effect.forEach((row) => decodeNoticeRow(row))),
      Effect.map((rows) => rows.map((row): NoticeView => ({
        id: row.id, threadId: row.thread_id, ruleId: row.rule_id, runId: row.run_id, state: row.state, text: row.text, messageId: row.message_id, epoch: row.epoch,
      })))));

  const reconcile = (id: string) => guidanceSql(db.withTransaction(Effect.gen(function* () {
    const [raw] = yield* db`SELECT thread_id,rule_id,epoch FROM notices WHERE id=${id} AND state IN ('accepted','uncertain','uncertainty_accepted')`;
    if (raw === undefined) return;
    const row = yield* decodeNoticeKeyRow(raw);
    yield* db`UPDATE notices SET state='visible' WHERE id=${id}`;
    yield* db`UPDATE episodes SET notified=1 WHERE thread_id=${row.thread_id} AND rule_id=${row.rule_id} AND epoch=${row.epoch}`;
  })));

  // CC-GDB-IMPLICIT: the defaults, the checks and the epoch advance read one snapshot and commit together
  const resolveEpisode = (threadId: string, ruleId: string, expectedEpoch?: number, ruleGeneration?: number, settingsGeneration?: number) =>
    guidanceSql(db.withTransaction(Effect.gen(function* () {
      const epoch = (yield* readEpisode(threadId, ruleId)).epoch;
      const generation = (yield* readRule(ruleId))?.generation;
      const currentSettings = (yield* readSettings).generation;
      if (epoch !== (expectedEpoch === undefined ? epoch : expectedEpoch) || generation !== (ruleGeneration === undefined ? generation : ruleGeneration) ||
        currentSettings !== (settingsGeneration === undefined ? currentSettings : settingsGeneration)) return;
      if ((yield* openNotice(threadId, ruleId)) !== undefined) return;
      yield* db`UPDATE episodes SET epoch=epoch+1,notified=0,object_id=NULL WHERE thread_id=${threadId} AND rule_id=${ruleId}`;
    })));

  return GuidanceStoreService.of({
    settings, bind, rules, rule, saveRule, saveSettings, mutes, mute, classification, classify, observe, previousHash, used, reserveTokens,
    record, activities, prune, episode, reset, commit, start, finish, notices, reconcile, resolveEpisode,
  });
});

/**
 * The guidance store on the run's GuidanceDb client. Its layer creates the schema, the default settings, the column
 * additions and the restart recovery once. Every multi-statement method runs in one transaction and joins the caller's
 * transaction when there is one (a savepoint); time comes from Clock and identities from SupervisorIds.
 */
// it takes the name GuidanceStore when the s6d switch removes the synchronous class
export class GuidanceStoreService extends Context.Service<GuidanceStoreService, GuidanceStoreShape>()("t3-supervisor/GuidanceStore") {
  static readonly layer: Layer.Layer<GuidanceStoreService, GuidanceStoreError, GuidanceDb | SupervisorIds> =
    Layer.effect(GuidanceStoreService, untracedSql(makeGuidanceStore));
}
