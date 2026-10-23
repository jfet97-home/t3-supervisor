import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { GuidanceDb, PolicyDb, readOnlyDatabase } from "./db.js";
import { checkGitProbeRows } from "./git-probe.js";
import type { OpenChange, StoredRowFinding, StoredRowScan } from "./guidance-sql.js";
import { checkGuidanceRows } from "./guidance-store.js";
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

// the read-only rollout scan of a data directory before the store switch is deployed on it: guidance.sqlite3 and
// thread-settings.sqlite3 are opened read only (no file is created, no pragma or statement writes), every stored row goes
// through the decoder its switched reader uses, and what the stores' open would change is listed; nothing contacts T3

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

/** Scans the two store files of `directory` read only. */
export const rolloutScan = (directory: string): Effect.Effect<RolloutScan, unknown> => Effect.gen(function* () {
  const files = [
    yield* scanFile(directory, "guidance.sqlite3", (sql) => Layer.succeed(GuidanceDb, sql), guidanceChecks),
    yield* scanFile(directory, "thread-settings.sqlite3", (sql) => Layer.succeed(PolicyDb, sql), [checkThreadPolicyRows]),
  ];
  const blocking = files.flatMap((file) => file.findings).filter((group) => group.read !== "call").reduce((total, group) => total + group.count, 0);
  return {files, blocking};
});

/** The scan as text: per file, each finding group with its keys, then what the open would change. */
export const renderRolloutScan = (directory: string, scan: RolloutScan): string => {
  const lines = [`rollout scan of ${directory} (read only; no file was written and T3 was not contacted)`];
  for (const file of scan.files) {
    lines.push(`${file.file}: ${file.present ? "present" : "absent (the open creates it)"}`);
    if (!file.present) continue;
    lines.push(file.findings.length ? `  rows the switched stores would not read as stored (${file.findings.reduce((total, group) => total + group.count, 0)}):` : "  every stored row decodes");
    for (const group of file.findings)
      lines.push(`    ${group.table} / ${group.kind}: ${group.count} ${group.problem}, read at ${group.read}; keys: ${group.keys.join(", ")}`);
    lines.push(file.changes.length ? "  what the open changes:" : "  the open changes nothing");
    for (const change of file.changes) lines.push(`    ${change.table}: ${change.change}${change.rows ? ` (${change.rows} rows)` : ""}`);
  }
  lines.push(scan.blocking ? `verdict: ${scan.blocking} row(s) read at open or in every cycle would fail the run`
    : "verdict: no stored row blocks the run's start or its cycles");
  return lines.join("\n");
};
