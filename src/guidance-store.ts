import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
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

/** Owns guidance state; never mutates the existing Telegram ledgers. */
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
