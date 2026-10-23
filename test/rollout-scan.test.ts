import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { renderRolloutScan, rolloutScan, type RolloutScan } from "../src/rollout-scan.js";
import { openStores, openWorkflows } from "./support/store-units.js";

// the read-only rollout scan on fixture files: one stored row of each kind that a switched store would not read as stored is
// reported by file, table, row kind, problem, read point and key, the report never carries row content, the open's changes to
// a pre-migration file are listed, and the scan writes no file

const marker = "SECRET-CONTENT";

// the controllers' own tables, as their services create them
const controllerTables = `
  CREATE TABLE supervisor_helper_channels(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,helper_thread_id TEXT NOT NULL,document TEXT NOT NULL,
    PRIMARY KEY(owner_thread_id,owner_generation,helper_thread_id));
  CREATE TABLE supervisor_helper_deliveries(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,message_id TEXT NOT NULL,document TEXT NOT NULL,
    PRIMARY KEY(owner_thread_id,owner_generation,message_id));
  CREATE TABLE supervisor_team_tool_receipts(owner_thread_id TEXT NOT NULL,actor_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,actor_epoch INTEGER NOT NULL,
    operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,evidence_item_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,actor_thread_id,binding_generation,actor_epoch,operation_id));
  CREATE TABLE supervisor_workflow_write_receipts(operation_id TEXT NOT NULL,operation_namespace TEXT NOT NULL,request_hash TEXT NOT NULL,project_id TEXT NOT NULL,
    main_thread_id TEXT NOT NULL,supervisor_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,
    PRIMARY KEY(project_id,main_thread_id,supervisor_thread_id,binding_generation,operation_namespace,operation_id));
  CREATE TABLE supervisor_workflow_write_evidence(supervisor_thread_id TEXT NOT NULL,item_id TEXT NOT NULL,operation_id TEXT NOT NULL,operation_namespace TEXT NOT NULL,
    request_hash TEXT NOT NULL,project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,native_evidence TEXT NOT NULL,result TEXT NOT NULL,
    successful INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(supervisor_thread_id,item_id));`;

// one row of each failing kind, written with the raw driver after a run created the tables
const failingRows = `
  UPDATE meta SET value='{"${marker}":1}' WHERE key='settings';
  UPDATE meta SET value='main-v0' WHERE key='supervisor_scope_version';
  INSERT INTO rules VALUES('rule-bad','{"${marker}":1}');
  INSERT INTO activity VALUES('activity-bad','{"${marker}":1}',1);
  INSERT INTO budget VALUES('2026-10-23','${marker}');
  INSERT INTO episodes VALUES('thread-e','rule-e','${marker}',0,NULL);
  INSERT INTO notices VALUES('notice-open','t','r','run',0,'committed','x',NULL,'${marker}',0,-1,-1);
  INSERT INTO notices VALUES('notice-call','t','r','run',0,'visible','x',NULL,'${marker}',0,-1,-1);
  INSERT INTO meta VALUES('supervisor_start_operation:["main-a","op-bad"]','not json ${marker}');
  INSERT INTO meta VALUES('supervisor_start:main-bad','{"${marker}":1}');
  INSERT INTO meta VALUES('supervisor_control:"project-bad"','not json');
  INSERT INTO meta VALUES('supervisor_control_auto:"project-bad"','not json');
  INSERT INTO meta VALUES('supervisor_no_project','not json');
  INSERT INTO meta VALUES('supervisor_global_definitions_control','not json');
  INSERT INTO meta VALUES('supervisor_global_definitions_event','not json');
  INSERT INTO meta VALUES('supervisor_activation_baseline','not json');
  INSERT INTO meta VALUES('supervisor_unbound_stop:main-bad','not json');
  INSERT INTO meta VALUES('native_git_probe_sessions','[{"threadId":"${marker}"}]');
  INSERT INTO supervisor_owned_threads VALUES(NULL);
  INSERT INTO supervisor_main_bindings VALUES('project-bad','main-bad','{"${marker}":1}');
  INSERT INTO supervisor_task_interpretations VALUES('thread-bad','project-bad','not json',1);
  INSERT INTO supervisor_project_settings VALUES('project-bad','{"${marker}":1}');
  INSERT INTO supervisor_chat_enables VALUES('thread-bad','${marker}');
  INSERT INTO supervisor_definition_user_saves VALUES('project-bad','/root','signature','${marker}','');
  INSERT INTO supervisor_conversation_requests VALUES('request-bad','project-bad','not json',1);
  INSERT INTO supervisor_workflow_introductions VALUES('task-bad','project-bad','{"${marker}":1}');
  INSERT INTO supervisor_workflow_agreement_candidates VALUES('task-bad','proposal-bad','project-bad','{}',1);
  INSERT INTO supervisor_monitor_binding_clock VALUES('supervisor-bad','${marker}',0);
  INSERT INTO supervisor_monitor_threads VALUES('project-bad','thread-bad','${marker}',1,0,NULL,NULL,0);
  INSERT INTO supervisor_monitor_items VALUES('project-bad','thread-bad','item-bad',NULL,'type','status','${marker}',1,'version',NULL,1,1,NULL,1);
  INSERT INTO supervisor_team_members VALUES('owner-bad',1,'member-bad','ready',1,'{}');
  INSERT INTO supervisor_team_assignments VALUES('owner-bad',1,'root-bad','{}');
  INSERT INTO supervisor_team_notifications VALUES('owner-bad',1,'notification-bad','recipient','state',1,'{}');
  INSERT INTO supervisor_team_events VALUES('owner-bad',1,'event-bad',1,NULL,'{}');
  INSERT INTO supervisor_team_requests VALUES('owner-bad',1,'request-bad','state',1,1,'{}');
  INSERT INTO supervisor_workflow_state VALUES('workflow-bad','p','m','t',NULL,NULL,'${marker}','{}',1,1);
  INSERT INTO supervisor_workflow_state VALUES('workflow-old','p2','m2','t2',NULL,NULL,1,'{"formatVersion":1}',1,1);
  INSERT INTO supervisor_workflow_operations VALUES('p','m','actor',1,'ns','op-blob',x'00','{}','w',1);
  INSERT INTO supervisor_workflow_operations VALUES('p','m','actor',1,'ns','op-old','hash','{"formatVersion":1}','w',1);
  INSERT INTO supervisor_helper_channels VALUES('owner-bad',1,'helper-bad','{}');
  INSERT INTO supervisor_helper_deliveries VALUES('owner-bad',1,'message-bad','not json');
  INSERT INTO supervisor_team_tool_receipts VALUES('owner-bad','actor-bad',1,0,'op-bad','hash','item','not json');
  INSERT INTO supervisor_workflow_write_receipts VALUES('op-bad','ns','hash','p','m','s',1,'not json',1);
  INSERT INTO supervisor_workflow_write_evidence VALUES('s','item-bad','op','ns','hash','p','m',1,'{}','not json',1,1);`;

const expected = [
  "guidance.sqlite3 | activity | activity | undecodable | call | activity-bad",
  "guidance.sqlite3 | budget | budget | undecodable | call | 2026-10-23",
  "guidance.sqlite3 | episodes | episode | undecodable | call | thread-e rule-e",
  "guidance.sqlite3 | meta | activation baseline | undecodable | cycle | supervisor_activation_baseline",
  "guidance.sqlite3 | meta | auto control | undecodable | cycle | supervisor_control_auto:\"project-bad\"",
  "guidance.sqlite3 | meta | control | undecodable | cycle | supervisor_control:\"project-bad\"",
  "guidance.sqlite3 | meta | global definitions control | undecodable | cycle | supervisor_global_definitions_control",
  "guidance.sqlite3 | meta | global definitions event | undecodable | cycle | supervisor_global_definitions_event",
  "guidance.sqlite3 | meta | no project control | undecodable | cycle | supervisor_no_project",
  "guidance.sqlite3 | meta | pending git probe sessions | undecodable | call | native_git_probe_sessions",
  "guidance.sqlite3 | meta | scope version | incompatible | open | supervisor_scope_version",
  "guidance.sqlite3 | meta | settings | undecodable | call | settings",
  "guidance.sqlite3 | meta | start | undecodable | cycle | supervisor_start:main-bad",
  "guidance.sqlite3 | meta | start operation | undecodable | open | supervisor_start_operation:[\"main-a\",\"op-bad\"]",
  "guidance.sqlite3 | meta | unbound stop | undecodable | call | supervisor_unbound_stop:main-bad",
  "guidance.sqlite3 | notices | committed notice | undecodable | open | notice-open",
  "guidance.sqlite3 | notices | notice | undecodable | call | notice-call",
  "guidance.sqlite3 | rules | rule | undecodable | call | rule-bad",
  "guidance.sqlite3 | supervisor_chat_enables | chat enable | undecodable | call | thread-bad",
  "guidance.sqlite3 | supervisor_conversation_requests | request | undecodable | cycle | request-bad",
  "guidance.sqlite3 | supervisor_definition_user_saves | definition save | undecodable | call | project-bad /root",
  "guidance.sqlite3 | supervisor_helper_channels | channel | incompatible | cycle | owner-bad 1 helper-bad",
  "guidance.sqlite3 | supervisor_helper_deliveries | delivery receipt | incompatible | cycle | owner-bad 1 message-bad",
  "guidance.sqlite3 | supervisor_main_bindings | binding | undecodable | cycle | project-bad main-bad",
  "guidance.sqlite3 | supervisor_monitor_binding_clock | notice clock | undecodable | cycle | supervisor-bad",
  "guidance.sqlite3 | supervisor_monitor_items | monitor item | undecodable | cycle | project-bad thread-bad item-bad",
  "guidance.sqlite3 | supervisor_monitor_threads | monitor thread | undecodable | cycle | project-bad thread-bad",
  "guidance.sqlite3 | supervisor_owned_threads | owned thread | undecodable | open | ",
  "guidance.sqlite3 | supervisor_project_settings | project settings | undecodable | cycle | project-bad",
  "guidance.sqlite3 | supervisor_task_interpretations | task | undecodable | cycle | thread-bad",
  "guidance.sqlite3 | supervisor_team_assignments | assignment | undecodable | cycle | owner-bad 1 root-bad",
  "guidance.sqlite3 | supervisor_team_events | event | undecodable | cycle | owner-bad 1 event-bad",
  "guidance.sqlite3 | supervisor_team_members | member | undecodable | cycle | owner-bad 1 member-bad",
  "guidance.sqlite3 | supervisor_team_notifications | notification | undecodable | cycle | owner-bad 1 notification-bad",
  "guidance.sqlite3 | supervisor_team_requests | request | undecodable | cycle | owner-bad 1 request-bad",
  "guidance.sqlite3 | supervisor_team_tool_receipts | tool receipt | undecodable | call | owner-bad actor-bad 1 0 op-bad",
  "guidance.sqlite3 | supervisor_workflow_agreement_candidates | agreement candidate | undecodable | cycle | task-bad proposal-bad",
  "guidance.sqlite3 | supervisor_workflow_introductions | introduction | undecodable | cycle | task-bad",
  "guidance.sqlite3 | supervisor_workflow_operations | operation | undecodable | call | p m ns op-blob",
  "guidance.sqlite3 | supervisor_workflow_operations | operation receipt | incompatible | call | p m ns op-old",
  "guidance.sqlite3 | supervisor_workflow_state | workflow state | incompatible | call | workflow-old",
  "guidance.sqlite3 | supervisor_workflow_state | workflow state | undecodable | call | workflow-bad",
  "guidance.sqlite3 | supervisor_workflow_write_evidence | write evidence | undecodable | call | s item-bad",
  "guidance.sqlite3 | supervisor_workflow_write_receipts | write receipt | incompatible | call | p m s 1 ns op-bad",
  "thread-settings.sqlite3 | settings | thread policy | undecodable | cycle | 1",
];

const flattened = (scan: RolloutScan) => scan.files.flatMap((file) => file.findings.flatMap((group) =>
  group.keys.map((key) => [file.file, group.table, group.kind, group.problem, group.read, key].join(" | ")))).sort();

// every file of the directory with its bytes and modification time
const snapshot = (directory: string) => readdirSync(directory).sort().map((name) => {
  const path = join(directory, name);
  return [name, createHash("sha256").update(readFileSync(path)).digest("hex"), statSync(path).mtimeMs];
});

const temporary = Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "rollout-scan-"))),
  (directory) => Effect.promise(() => rm(directory, {recursive: true, force: true})));

it.live("the rollout scan reports one stored row of each failing kind by file, table, kind, problem, read point and key, and writes nothing", () => Effect.gen(function* () {
  const directory = yield* temporary;
  // the tables of a run that opened its stores, closed again
  yield* Effect.promise(async () => {
    const stores = await openStores(directory);
    await openWorkflows(stores);
    await stores.close();
  });
  const guidance = new DatabaseSync(join(directory, "guidance.sqlite3"));
  guidance.exec(controllerTables);
  guidance.exec(failingRows);
  guidance.close();
  const policy = new DatabaseSync(join(directory, "thread-settings.sqlite3"));
  policy.exec(`UPDATE settings SET document='not json ${marker}' WHERE id=1`);
  policy.close();

  const before = snapshot(directory);
  const scan = yield* rolloutScan(directory);
  assert.deepEqual(snapshot(directory), before, "no file was written, created or touched");
  assert.deepEqual(flattened(scan), [...expected].sort());
  assert.equal(scan.blocking, expected.filter((line) => !line.includes(" | call | ")).length);
  const report = renderRolloutScan(directory, scan);
  assert.equal(report.includes(marker), false, "the report carries keys only, never row content");
  assert.ok(report.includes(`verdict: ${scan.blocking} row(s) read at open or in every cycle would fail the run`), report);
}), {timeout: 30_000});

it.live("the rollout scan lists what the open changes in a pre-migration file: added columns, created tables, recovered notices and the one-time reset", () => Effect.gen(function* () {
  const directory = yield* temporary;
  const legacy = new DatabaseSync(join(directory, "guidance.sqlite3"));
  legacy.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,
      text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,dispatch_started INTEGER NOT NULL DEFAULT 0);
    INSERT INTO notices VALUES('notice-committed','t','r','run',0,'committed','x',NULL,1,1);
    CREATE TABLE supervisor_main_bindings(id TEXT PRIMARY KEY);
    INSERT INTO supervisor_main_bindings VALUES('legacy-binding');
    INSERT INTO meta VALUES('supervisor_activation_sequence','4');`);
  legacy.close();
  const before = snapshot(directory);
  const scan = yield* rolloutScan(directory);
  assert.deepEqual(snapshot(directory), before, "no file was written");
  const [guidance, policy] = scan.files;
  assert.equal(policy?.present, false, "a missing policy file is reported, not created");
  const changes = guidance!.changes.map((change) => `${change.table}: ${change.change} (${change.rows})`);
  for (const expectedChange of [
    "notices: column rule_generation added with its default (0)",
    "notices: column settings_generation added with its default (0)",
    "notices: committed notices recovered as not delivered or uncertain (as the baseline open did) (1)",
    "rules: table created (0)",
    "supervisor_main_bindings: cleared by the one-time reset (no stored scope version) (1)",
    "meta: activation rows cleared by the one-time reset (1)",
    "supervisor_definition_user_saves: table created (0)",
  ]) assert.ok(changes.includes(expectedChange), `${expectedChange} in ${changes.join("; ")}`);
  // the open keeps a prototype table of another shape (its create is conditional), so its readers fail on it
  assert.deepEqual(flattened(scan), ["guidance.sqlite3 | supervisor_main_bindings | binding table | incompatible | cycle | supervisor_main_bindings"]);
  assert.equal(scan.blocking, 1);
}), {timeout: 30_000});

it.live("the rollout scan reads a live writer's committed rows through its write-ahead log", () => Effect.gen(function* () {
  const directory = yield* temporary;
  yield* Effect.promise(async () => {
    const stores = await openStores(directory);
    await stores.close();
  });
  const writer = new DatabaseSync(join(directory, "guidance.sqlite3"));
  yield* Effect.addFinalizer(() => Effect.sync(() => writer.close()));
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  writer.exec(`INSERT INTO rules VALUES('rule-live','{"${marker}":1}')`);
  const scan = yield* rolloutScan(directory);
  assert.deepEqual(flattened(scan), ["guidance.sqlite3 | rules | rule | undecodable | call | rule-live"]);
}), {timeout: 30_000});
