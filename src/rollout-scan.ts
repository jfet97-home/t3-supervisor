import { existsSync } from "node:fs";
import { join } from "node:path";
import { Clock, Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { GuidanceDb, PolicyDb, readOnlyDatabase } from "./db.js";
import { checkGitProbeRows } from "./git-probe.js";
import type { OpenChange, StoredRowFinding, StoredRowScan } from "./guidance-sql.js";
import { checkGuidanceRows } from "./guidance-store.js";
import { cutoverNativeThreads, cutoverReport, type CutoverReport, interpretationCutoverPlan, readCutoverNatives, readCutoverRows,
  renderCutoverPlan } from "./interpretation-cutover.js";
import { checkProjectSupervisorRows } from "./project-supervisor-store.js";
import { checkConversationRows } from "./supervisor-conversation-store.js";
import { checkHelperRows } from "./supervisor-helper-transport.js";
import { checkMonitorRows } from "./supervisor-monitor-store.js";
import { checkScopeVersion } from "./supervisor-state-reset.js";
import { checkTeamToolReceipts } from "./supervisor-team-controller.js";
import { checkTeamRows } from "./supervisor-team-store.js";
import { checkThreadPolicyRows } from "./thread-policy.js";
import { checkWorkflowStateRows } from "./workflow-state-store.js";
import { checkWorkflowWriteRows } from "./workflow-write-controller.js";
import type { T3ClientShape } from "./t3.js";

// the read-only rollout scan of a data directory before the store switch is deployed on it: guidance.sqlite3 and
// thread-settings.sqlite3 are opened read only (no file is created, no pragma or statement writes), every stored row goes
// through the decoder its switched reader uses, and what the stores' open would change is listed. the interpretation
// cut-over section (deleted with src/interpretation-cutover.ts) prints the plan of the s6e startup step; only with a read
// client does it read the supervisor roots' projections, and nothing is ever sent

/** The findings of one row kind, with the keys of its rows (never their content). */
export interface FindingGroup {
  readonly table: string;
  readonly kind: string;
  readonly problem: StoredRowFinding["problem"];
  readonly read: StoredRowFinding["read"];
  readonly count: number;
  readonly keys: ReadonlyArray<string>;
}
export interface FileScan {
  readonly file: string;
  readonly present: boolean;
  readonly findings: ReadonlyArray<FindingGroup>;
  readonly changes: ReadonlyArray<OpenChange>;
}
export interface RolloutScan {
  readonly files: ReadonlyArray<FileScan>;
  /** findings the run reads when it opens its stores or in every supervision cycle: they fail its start or its cycles */
  readonly blocking: number;
  /** the interpretation cut-over the s6e startup step would apply now; null without a guidance file */
  readonly cutover: (CutoverReport & {readonly writes: number; readonly nativeReads: boolean}) | null;
}

// the stores of guidance.sqlite3 in the order the run opens them
const guidanceChecks = [checkGuidanceRows, checkScopeVersion, checkProjectSupervisorRows, checkConversationRows, checkMonitorRows, checkTeamRows,
  checkWorkflowStateRows, checkHelperRows, checkTeamToolReceipts, checkWorkflowWriteRows, checkGitProbeRows];

const grouped = (findings: ReadonlyArray<StoredRowFinding>): Array<FindingGroup> => {
  const groups = new Map<string, {group: Omit<FindingGroup, "count" | "keys">; keys: Array<string>}>();
  for (const finding of findings) {
    const id = JSON.stringify([finding.table, finding.kind, finding.problem, finding.read]);
    const current = groups.get(id) ?? {group: {table: finding.table, kind: finding.kind, problem: finding.problem, read: finding.read}, keys: []};
    current.keys.push(finding.key);
    groups.set(id, current);
  }
  return [...groups.values()].map(({group, keys}) => ({...group, count: keys.length, keys}));
};

// one file read only through its own read-only client (src/db.ts), or absent; a missing file is reported, never created
const scanFile = <S>(directory: string, file: string, client: (sql: SqlClient.SqlClient) => Layer.Layer<S>,
  checks: ReadonlyArray<Effect.Effect<StoredRowScan, unknown, S>>) => Effect.scoped(Effect.gen(function* () {
  if (!existsSync(join(directory, file))) return {file, present: false, findings: [], changes: []} satisfies FileScan;
  const sql = yield* readOnlyDatabase(directory, file);
  const scans = yield* Effect.forEach(checks, (check) => Effect.provide(check, client(sql)));
  return {file, present: true, findings: grouped(scans.flatMap((scan) => scan.findings)), changes: scans.flatMap((scan) => scan.changes)} satisfies FileScan;
}));

// the cut-over plan over the guidance file read only, with the roots' projections when a read client is given
const scanCutover = (directory: string, native: Pick<T3ClientShape, "projection"> | undefined) => Effect.scoped(Effect.gen(function* () {
  if (!existsSync(join(directory, "guidance.sqlite3"))) return null;
  const rows = yield* Effect.provideService(readCutoverRows, GuidanceDb, yield* readOnlyDatabase(directory, "guidance.sqlite3"));
  const natives = native ? yield* readCutoverNatives(native, cutoverNativeThreads(rows)) : new Map();
  return {...cutoverReport(interpretationCutoverPlan(rows, natives, yield* Clock.currentTimeMillis)), nativeReads: native !== undefined};
}));

/** Scans the two store files of `directory` read only; with `native`, the cut-over section also reads the roots' projections. */
export const rolloutScan = (directory: string, native?: Pick<T3ClientShape, "projection">): Effect.Effect<RolloutScan, unknown> => Effect.gen(function* () {
  const files = [
    yield* scanFile(directory, "guidance.sqlite3", (sql) => Layer.succeed(GuidanceDb, sql), guidanceChecks),
    yield* scanFile(directory, "thread-settings.sqlite3", (sql) => Layer.succeed(PolicyDb, sql), [checkThreadPolicyRows]),
  ];
  const blocking = files.flatMap((file) => file.findings).filter((group) => group.read !== "call").reduce((total, group) => total + group.count, 0);
  return {files, blocking, cutover: yield* scanCutover(directory, native)};
});

/** The scan as text: per file, each finding group with its keys, then what the open would change. */
export const renderRolloutScan = (directory: string, scan: RolloutScan): string => {
  const lines = [`rollout scan of ${directory} (read only; no file was written and ${scan.cutover?.nativeReads ? "T3 was only read" : "T3 was not contacted"})`];
  for (const file of scan.files) {
    lines.push(`${file.file}: ${file.present ? "present" : "absent (the open creates it)"}`);
    if (!file.present) continue;
    lines.push(file.findings.length ? `  rows the switched stores would not read as stored (${file.findings.reduce((total, group) => total + group.count, 0)}):` : "  every stored row decodes");
    for (const group of file.findings)
      lines.push(`    ${group.table} / ${group.kind}: ${group.count} ${group.problem}, read at ${group.read}; keys: ${group.keys.join(", ")}`);
    lines.push(file.changes.length ? "  what the open changes:" : "  the open changes nothing");
    for (const change of file.changes) lines.push(`    ${change.table}: ${change.change}${change.rows ? ` (${change.rows} rows)` : ""}`);
  }
  lines.push(scan.blocking ? `verdict: ${scan.blocking} row(s) read at open or in every cycle would fail the run; a one-off cut-over is needed before deployment`
    : "verdict: no stored row blocks the run's start or its cycles");
  if (scan.cutover) {
    lines.push(...renderCutoverPlan(scan.cutover));
    if (!scan.cutover.nativeReads) lines.push("  native reads not performed: give the T3 URL and read token to classify in-flight attempts and native evidence");
    lines.push(scan.cutover.blockers.length ? `cut-over verdict: ${scan.cutover.blockers.length} blocker(s); the s6e startup step would refuse now and change nothing`
      : scan.cutover.writes ? `cut-over verdict: the s6e startup step would apply ${scan.cutover.writes} row write(s) in one transaction`
      : "cut-over verdict: nothing to apply");
  }
  return lines.join("\n");
};
