import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Context, Data, Deferred, Effect, Exit, FileSystem, Layer, Scope } from "effect";
import { HttpApi } from "effect/http-api";
import type { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { GuidanceDb } from "../src/db.js";
import { ListenerUnavailable } from "../src/errors.js";
import { GuidanceRuntime } from "../src/guidance.js";
import { SupervisorApi } from "../src/guidance-contract.js";
import { guidanceTransaction } from "../src/guidance-sql.js";
import { GuidanceStore } from "../src/guidance-store.js";
import type { ProjectConfigEditorService } from "../src/project-config-editor.js";
import type { ProjectInfo } from "../src/types.js";
import { mockMethod } from "./support/node-test.js";
import { appConfig, fakeT3, probeToken, runApp, t3Client, type AppCatalog } from "./support/g11-app.js";
import { definitionsOf, grant, listeners, processStores, readCsrf, runtimeOver, signIn, startUi, uiConfig, workflowController, type StartedUi } from "./support/g11-dashboard.js";
import { blockedPort, connectRefused, exchange, exchangeJson, freePort, jsonBody, openDescriptors, openRequest, portBindable, rawRequest, within,
  type ExchangeInit, type RawResponse } from "./support/g11-http.js";
import { execute, guidanceClient, guidanceLayer, row, rows, temporaryDirectory } from "./support/g11-stores.js";

// the c3b characterizations of the dashboard, its stores and the running guidance application on the production layers:
// the stores and the runtime over temporary database files, the listeners on loopback ports and the application over a
// loopback T3 peer. it.live: every case keeps real database files and most serve real sockets; the baseline's request and
// wait deadlines stay on the live clock

const project = (id: string, workspaceRoot: string, available = true): {project: ProjectInfo; available: boolean} =>
  ({project: {id, title: id, workspaceRoot}, available});

const session = (origin: string, directory: string) => Effect.map(signIn(origin, directory), (value) => ({"x-supervisor-session": value}));

// the baseline fetch's AbortSignal.timeout(5_000) is the request's deadline on the live clock
const fetchWithin = (url: string, init: ExchangeInit = {}) => within(exchange(url, init), "5 seconds", url);

const getJson = (url: string, headers: Record<string, string>) => Effect.map(fetchWithin(url, {headers}), (response) => {
  assert.equal(response.status, 200, url);
  return JSON.parse(response.text) as Record<string, unknown>;
});

const guidanceFile = (directory: string) => join(directory, "guidance.sqlite3");

// `use` on the guidance store of `directory` and its client, opened as the run opens them and closed when `use` ends
const withStore = <A, E>(directory: string, use: (store: GuidanceStore["Service"], sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(Layer.build(guidanceLayer(directory)), (context) => use(Context.get(context, GuidanceStore), Context.get(context, GuidanceDb)))).pipe(Effect.orDie);

// `use` on a client of the file with only its pragmas: a writer or an observer beside the store, as the baseline's direct
// connection to the file was
const withClient = <A, E>(directory: string, use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(Layer.build(guidanceClient(directory)), (context) => use(Context.get(context, GuidanceDb)))).pipe(Effect.orDie);

const files = <A, E>(use: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>) =>
  Effect.flatMap(FileSystem.FileSystem, use).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer));

it.live("CT-APP-01: dashboard classification lets explicit choices win and resolves the managed root with or without a trailing slash", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c3b-classify-");
  const stores = yield* Layer.build(processStores(uiConfig(directory)));
  const store = Context.get(stores, GuidanceStore);
  yield* store.classify("explicit-project", "project", 1);
  yield* store.classify("explicit-scratch", "scratch", 2);
  const projects = [
    project("managed", "/work/scratch"),
    project("managed-slash", "/work/scratch/"),
    project("managed-dots", "/work/other/../scratch"),
    project("other", "/work/other"),
    project("explicit-project", "/work/scratch"),
    project("explicit-scratch", "/work/other"),
    project("unavailable", "/work/scratch", false),
  ];
  const classify = (managedScratchRoot?: string) => Effect.gen(function* () {
    const runtime = yield* GuidanceRuntime.make({...uiConfig(directory), ...(managedScratchRoot === undefined ? {} : {managedScratchRoot})},
      {catalog: () => Effect.succeed({projects, threads: []})}).pipe(Effect.provide(stores));
    return Object.fromEntries((yield* runtime.snapshot).projects.map(item => [item.id, item.classification]));
  });
  const managed = {
    managed: "scratch", "managed-slash": "scratch", "managed-dots": "scratch", other: "project",
    "explicit-project": "project", "explicit-scratch": "scratch", unavailable: "unclassified",
  };
  // path.resolve drops the trailing slash and dot segments on both sides of the comparison
  assert.deepEqual(yield* classify("/work/scratch/"), managed);
  assert.deepEqual(yield* classify("/work/scratch"), managed);
  // without a managed root only an explicit classification is known
  assert.deepEqual(yield* classify(), {
    managed: "unclassified", "managed-slash": "unclassified", "managed-dots": "unclassified", other: "unclassified",
    "explicit-project": "project", "explicit-scratch": "scratch", unavailable: "unclassified",
  });
}), {timeout: 10_000});

it.live("CT-APP-01: the running application's definition scratch check keeps a trailing slash that the dashboard classification drops", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c3b-app-classify-");
  yield* withStore(directory, (seeded) => Effect.andThen(seeded.classify("explicit-scratch", "scratch", 1), seeded.classify("explicit-project", "project", 2)));
  const peer = yield* fakeT3;
  const config = yield* appConfig(directory, peer.url, {managedScratchRoot: "/work/scratch/"});
  const catalog: AppCatalog = {threads: [], projects: [
    project("bare", "/work/scratch"),
    project("slashed", "/work/scratch/"),
    project("explicit-scratch", "/work/other"),
    project("explicit-project", "/work/scratch/"),
  ]};
  const app = yield* runApp(config, yield* t3Client(peer.url), () => catalog);
  yield* within(app.ready, "5 seconds", "application readiness");
  const headers = yield* session(app.origin, directory);

  const snapshot = yield* getJson(app.origin + "/api/guidance/snapshot", headers);
  assert.deepEqual(Object.fromEntries((snapshot.projects as Array<{id: string; classification: string}>).map(item => [item.id, item.classification])),
    {bare: "scratch", slashed: "scratch", "explicit-scratch": "scratch", "explicit-project": "project"});
  const globalOnly: Record<string, unknown> = {};
  for (const id of ["bare", "slashed", "explicit-scratch", "explicit-project"]) {
    const definitions = yield* getJson(app.origin + "/api/guidance/project-configuration?" + new URLSearchParams({projectId: id}), headers);
    globalOnly[id] = definitions.globalOnly;
  }
  // posix.normalize keeps the trailing slash of the managed root (guidance-application.ts:61,68), so "/work/scratch" is not scratch here
  assert.deepEqual(globalOnly, {bare: false, slashed: true, "explicit-scratch": true, "explicit-project": false});
}), {timeout: 10_000});

it.live("CT-APP-02: interrupting the application closes the UI listener, cleans up git probes once more while the store is open, and closes both databases", (t) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c3b-app-shutdown-");
  const pending = {threadId: "t3-supervisor-git-probe-" + randomUUID(), terminalId: "t3-supervisor-git-probe-" + randomUUID()};
  yield* withStore(directory, (_seeded, sql) => execute(sql, "INSERT INTO meta(key,value) VALUES('native_git_probe_sessions',?)", JSON.stringify([pending])));
  const probeFile = join(directory, "probe-token");
  yield* files((fs) => fs.writeFileString(probeFile, probeToken, {mode: 0o600}));
  const peer = yield* fakeT3;
  const config = yield* appConfig(directory, peer.url, {gitProbeTokenFile: probeFile});
  const logs: string[] = [];
  mockMethod(t, console, "log", (...values: unknown[]) => {logs.push(values.map(String).join(" "));});
  const closes: Array<{payload: Record<string, unknown>; uiRefused: boolean}> = [];
  // the startup cleanup is rejected so the session stays pending; the shutdown cleanup then closes it
  peer.onRpc = request => Effect.gen(function* () {
    if (request.tag !== "terminal.close") return {_tag: "Failure" as const, cause: {message: "unexpected"}};
    const uiRefused = yield* connectRefused(config.uiPort!);
    closes.push({payload: request.payload, uiRefused});
    return closes.length === 1 ? {_tag: "Failure" as const, cause: {message: "terminal busy"}} : {_tag: "Success" as const, value: {}};
  });
  const app = yield* runApp(config, yield* t3Client(peer.url), () => ({projects: [], threads: []}));
  yield* within(app.ready, "5 seconds", "application readiness");
  assert.equal(closes.length, 1, "the startup cleanup ran before readiness");
  assert.deepEqual(closes[0]!.payload, {...pending, deleteHistory: true});
  assert.equal(closes[0]!.uiRefused, true, "the startup cleanup runs before the UI listens");
  assert.deepEqual(logs, [JSON.stringify({event: "native_git_probe_cleanup_unavailable"})]);
  const status = yield* fetchWithin(app.origin + "/auth/status");
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.text), {authenticated: false});
  const loginFile = join(directory, "access", "login.sqlite3");
  assert.ok(openDescriptors(guidanceFile(directory)) >= 1);
  assert.ok(openDescriptors(loginFile) >= 1);

  yield* app.interrupt;
  assert.equal(closes.length, 2, "shutdown ran the cleanup exactly once more");
  assert.deepEqual(closes[1]!.payload, {...pending, deleteHistory: true});
  assert.equal(closes[1]!.uiRefused, true, "the UI listener was already closed when the shutdown cleanup ran");
  assert.equal(peer.rpcs.every(request => request.authorization === "Bearer " + probeToken), true);
  assert.equal(logs.length, 1);
  assert.equal(yield* connectRefused(config.uiPort!), true);
  assert.equal(yield* portBindable(config.uiPort!), true);
  assert.equal(openDescriptors(guidanceFile(directory)), 0);
  assert.equal(openDescriptors(guidanceFile(directory) + "-wal"), 0);
  assert.equal(openDescriptors(loginFile), 0);
  // the last connection checkpointed and removed the write-ahead log on close
  assert.equal(existsSync(guidanceFile(directory) + "-wal"), false);

  yield* withStore(directory, (_reopened, sql) => Effect.gen(function* () {
    assert.equal((yield* row(sql, "SELECT value FROM meta WHERE key='native_git_probe_sessions'"))?.value, "[]",
      "the shutdown cleanup removed the session while the store was still open");
    const wal = guidanceFile(directory) + "-wal";
    assert.equal(existsSync(wal) ? statSync(wal).size : 0, 0, "reopening replays and writes nothing");
  }));
}), {timeout: 10_000});

const activityRow = (id: string, createdAt: number) => [id, JSON.stringify({
  id, kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "recorded", reason: "c3b_seed", detail: null, createdAt,
}), createdAt] as const;

it.live("CT-APP-03: a failed descriptor read marks the dashboard disconnected with the exact text and skips pruning; the next successful cycle restores and prunes", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c3b-app-cycle-");
  const old = (yield* Clock.currentTimeMillis) - 31 * 86_400_000;
  const recent = yield* Clock.currentTimeMillis;
  yield* withStore(directory, (_seeded, sql) => Effect.andThen(execute(sql, "INSERT INTO activity VALUES(?,?,?)", ...activityRow("seed-before-start", old)),
    execute(sql, "INSERT INTO activity VALUES(?,?,?)", ...activityRow("recent", recent))));
  const peer = yield* fakeT3;
  const config = yield* appConfig(directory, peer.url);
  // closing the make scope at once only retires the idle-clock warning; the clock keeps working. The run's stores now stamp
  // and prune on the application's clock (S6d CC-CLOCK-WALL), as the baseline store did on the wall clock, so the test clock
  // starts at the wall time and only the cycle's sleeps wait for its adjustments
  const clock = yield* Effect.scoped(TestClock.make());
  yield* clock.setTime(yield* Clock.currentTimeMillis);
  const app = yield* runApp(config, yield* t3Client(peer.url), () => ({projects: [], threads: []}), clock);
  yield* within(app.ready, "5 seconds", "application readiness");
  yield* within(app.nextRootSleep(1), "5 seconds", "first monitor cycle");
  const headers = yield* session(app.origin, directory);
  const read = Effect.gen(function* () {
    const snapshot = yield* getJson(app.origin + "/api/guidance/snapshot", headers);
    return {connected: snapshot.connected, coverage: snapshot.coverage, environmentId: snapshot.environmentId, lastCycleAt: snapshot.lastCycleAt,
      activity: (snapshot.activity as Array<{id: string}>).map(item => item.id)};
  });
  const first = yield* read;
  assert.deepEqual({...first, lastCycleAt: typeof first.lastCycleAt}, {connected: true, coverage: "Native project and workflow supervision is active.",
    environmentId: "c3b-environment", lastCycleAt: "number", activity: ["recent"]});
  assert.equal(peer.descriptorRequests, 2, "startup read plus the first cycle");

  yield* withClient(directory, (writer) => execute(writer, "INSERT INTO activity VALUES(?,?,?)", ...activityRow("seed-before-failure", old)));
  peer.descriptorAvailable = false;
  yield* clock.adjust("5 seconds");
  yield* within(app.nextRootSleep(2), "5 seconds", "failed monitor cycle");
  const failed = yield* read;
  assert.deepEqual(failed, {connected: false, coverage: "T3 connection unavailable. Project editing needs a working T3 connection.",
    environmentId: "c3b-environment", lastCycleAt: first.lastCycleAt, activity: ["recent", "seed-before-failure"]});

  peer.descriptorAvailable = true;
  yield* clock.adjust("5 seconds");
  yield* within(app.nextRootSleep(3), "5 seconds", "recovered monitor cycle");
  const recovered = yield* read;
  assert.equal(recovered.connected, true);
  assert.equal(recovered.coverage, "Native project and workflow supervision is active.");
  assert.ok(typeof recovered.lastCycleAt === "number" && recovered.lastCycleAt >= (first.lastCycleAt as number));
  assert.deepEqual(recovered.activity, ["recent"]);
  assert.equal(peer.descriptorRequests, 4);
  assert.equal(app.rootSleeps(), 3, "no cycle ran without a clock adjustment");
}), {timeout: 10_000});

const seedNotices = (directory: string) => Effect.gen(function* () {
  yield* withStore(directory, () => Effect.void);
  yield* withClient(directory, (db) => Effect.gen(function* () {
    const insert = "INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,message_id,created_at,dispatch_started) VALUES(?,?,?,?,?,?,?,?,?,?)";
    yield* execute(db, insert, "not-started", "thread-a", "rule-a", "run-a", 3, "committed", "text a", null, 1_000, 0);
    yield* execute(db, insert, "started", "thread-b", "rule-b", "run-b", 4, "committed", "text b", null, 2_000, 1);
    yield* execute(db, insert, "visible", "thread-c", "rule-c", "run-c", 5, "visible", "text c", null, 3_000, 1);
  }));
});

const recoveryRows = (sql: SqlClient.SqlClient) => rows(sql,
  "SELECT json_extract(document,'$.noticeId') AS noticeId, json_extract(document,'$.state') AS state, json_extract(document,'$.episodeEpoch') AS epoch FROM activity WHERE json_extract(document,'$.reason')='process_recovery' ORDER BY noticeId",
);

it.live("CT-GDB-01: reopening with committed notices recovers each once, lists the uncertain notice first and records nothing on a second reopen", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c3b-gdb-recovery-");
  yield* seedNotices(directory);
  yield* withStore(directory, (first, sql) => Effect.gen(function* () {
    assert.deepEqual(yield* rows(sql, "SELECT id,state FROM notices ORDER BY id"),
      [{id: "not-started", state: "not_delivered_restart"}, {id: "started", state: "uncertain"}, {id: "visible", state: "visible"}]);
    assert.deepEqual(yield* recoveryRows(sql), [{noticeId: "not-started", state: "not_delivered_restart", epoch: 3}, {noticeId: "started", state: "uncertain", epoch: 4}]);
    const activities = yield* first.activities();
    assert.deepEqual(activities[0], {id: "notice:started", noticeId: "started", episodeEpoch: 4, threadId: "thread-b", ruleId: "rule-b", runId: "run-b",
      kind: "guidance", state: "uncertain", reason: "unreconciled_notice", detail: null, createdAt: 2_000});
    // the uncertain notice's own recovery row is folded into its unresolved entry
    assert.deepEqual(activities.slice(1).map(item => [item.noticeId, item.reason, item.state]), [["not-started", "process_recovery", "not_delivered_restart"]]);
  }));

  yield* withStore(directory, (second, sql) => Effect.gen(function* () {
    assert.deepEqual(yield* recoveryRows(sql), [{noticeId: "not-started", state: "not_delivered_restart", epoch: 3}, {noticeId: "started", state: "uncertain", epoch: 4}]);
    assert.equal((yield* row(sql, "SELECT COUNT(*) AS count FROM activity"))?.count, 2);
    assert.equal((yield* second.activities())[0]?.id, "notice:started");
  }));
}), {timeout: 10_000});

it.live("CT-GDB-02: opening a pre-migration database adds the episode and notice generation columns with defaults and keeps the rows", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c3b-gdb-migrate-");
  yield* files((fs) => fs.makeDirectory(directory, {recursive: true}));
  yield* withClient(directory, (legacy) => Effect.gen(function* () {
    yield* execute(legacy, `CREATE TABLE episodes(thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread_id,rule_id))`);
    yield* execute(legacy, `CREATE TABLE notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,state TEXT NOT NULL,text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,
      dispatch_started INTEGER NOT NULL DEFAULT 0)`);
    yield* execute(legacy, "INSERT INTO episodes VALUES(?,?,?,?)", "thread-a", "rule-a", 7, 1);
    yield* execute(legacy, "INSERT INTO notices VALUES(?,?,?,?,?,?,?,?,?,?)", "notice-a", "thread-a", "rule-a", "run-a", 7, "visible", "legacy text", "message-a", 5_000, 1);
  }));

  yield* withStore(directory, (_store, sql) => Effect.gen(function* () {
    const columns = (table: string) => Effect.map(rows(sql, `PRAGMA table_info(${table})`), (found) => found.map(item => [item.name, item.dflt_value, item.notnull]));
    assert.deepEqual((yield* columns("episodes")).at(-1), ["object_id", null, 0]);
    assert.deepEqual((yield* columns("notices")).slice(-2), [["rule_generation", "-1", 1], ["settings_generation", "-1", 1]]);
    assert.deepEqual(yield* row(sql, "SELECT * FROM episodes"), {thread_id: "thread-a", rule_id: "rule-a", epoch: 7, notified: 1, object_id: null});
    assert.deepEqual(yield* row(sql, "SELECT * FROM notices"), {id: "notice-a", thread_id: "thread-a", rule_id: "rule-a", run_id: "run-a", epoch: 7,
      state: "visible", text: "legacy text", message_id: "message-a", created_at: 5_000, dispatch_started: 1, rule_generation: -1, settings_generation: -1});
    assert.deepEqual(yield* recoveryRows(sql), []);
  }));
  // a second open finds the columns present and alters nothing
  yield* withStore(directory, (_again, sql) => Effect.gen(function* () {
    assert.equal((yield* rows(sql, "PRAGMA table_info(notices)")).length, 12);
    assert.equal((yield* rows(sql, "PRAGMA table_info(episodes)")).length, 5);
  }));
}), {timeout: 10_000});

// the nested block's own failure
class NestedFailure extends Data.TaggedError("NestedFailure") {}

// whether the client's connection holds an open transaction: a top-level BEGIN fails inside one; a probe that began rolls back
const inTransaction = (sql: SqlClient.SqlClient) => Effect.flatMap(Effect.exit(sql.unsafe("BEGIN")), (exit) =>
  Exit.isSuccess(exit) ? Effect.as(execute(sql, "ROLLBACK"), false) : Effect.succeed(true));

// target change (S6d contract, transactions: a method called inside a caller's withTransaction joins it as a SAVEPOINT,
// CC-NESTTX): the baseline store's transaction() refused a nested call at its BEGIN, so the nested block never ran. A nested
// guidance transaction now runs as a savepoint of the outer one; when it fails, the outer work is still rolled back, nothing
// is committed, no transaction stays open and the store stays usable. The name keeps the baseline's characterization
it.live("CT-GDB-06: a nested transaction() joins the caller's transaction as a savepoint, and its failure rolls back the outer work and leaves the store usable", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c3b-gdb-nested-");
  yield* withStore(directory, (_store, sql) => Effect.gen(function* () {
    const transaction = guidanceTransaction(sql);
    let innerRan = false;
    const failure = yield* Effect.flip(transaction(Effect.gen(function* () {
      yield* execute(sql, "INSERT INTO meta VALUES('c3b-outer','1')");
      return yield* transaction(Effect.gen(function* () {
        innerRan = true;
        yield* execute(sql, "INSERT INTO meta VALUES('c3b-inner','1')");
        return yield* new NestedFailure();
      }));
    })));
    assert.ok(failure instanceof NestedFailure, "the nested block's failure fails the outer transaction");
    assert.equal(innerRan, true);
    assert.equal(yield* inTransaction(sql), false);
    yield* withClient(directory, (observer) => Effect.gen(function* () {
      assert.equal((yield* row(observer, "SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'c3b-%'"))?.count, 0);
    }));
    // the store stays usable for the next top-level transaction
    assert.equal(yield* transaction(Effect.as(execute(sql, "INSERT INTO meta VALUES('c3b-after','1')"), "committed")), "committed");
    assert.equal((yield* row(sql, "SELECT value FROM meta WHERE key='c3b-after'"))?.value, "1");
  }));
}), {timeout: 10_000});

const securityHeaders = {"cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
  "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin"};
const pickHeaders = (response: RawResponse, names: readonly string[]) => Object.fromEntries(names.map(name => [name, response.headers[name]]));

const writeAssets = (started: StartedUi) => files((fs) => Effect.gen(function* () {
  const assets = started.config.uiAssetsDirectory!;
  yield* fs.makeDirectory(assets, {recursive: true});
  yield* fs.writeFileString(join(assets, "index.html"),
    "<!doctype html><html><head><script type=\"module\" src=\"/app.js\"></script></head><body><script>window.ready = true;</script></body></html>");
  yield* fs.writeFileString(join(assets, "app.js"), "export const ready = true;\n");
  yield* fs.writeFileString(join(assets, "data.bin"), "binary");
  yield* fs.writeFileString(join(started.directory, "secret"), "outside the assets directory");
}));

const mcpList = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list", params: {}});
const mcpPost = (port: number, headers: Record<string, string>) => rawRequest(port, {method: "POST", path: "/mcp/workflows", body: mcpList,
  headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers}});

it.live("CT-MCP-01: the workflow MCP route enforces Host, Origin and bearer before the endpoint, and the MCP-only listener serves nothing else", () => Effect.gen(function* () {
  const controller = workflowController({readTool: () => Effect.succeed({status: "ok"})});
  const started = yield* startUi({controller,
    config: {workflowMcpBindHost: "127.0.0.1", workflowMcpPort: 0, workflowMcpHosts: ["supervisor.internal:9100"]}});
  const {port, origin, directory} = started;
  const mcpPort = started.mcpPort!;
  assert.notEqual(mcpPort, port);
  const token = yield* files((fs) => Effect.map(fs.readFileString(join(directory, "access", "workflow-mcp-token")), (text) => text.trim()));
  const bearer = {Authorization: "Bearer " + token};
  const local = `127.0.0.1:${port}`;
  const outcome = (response: Effect.Effect<RawResponse>) => Effect.map(response, (value) =>
    value.status === 200 ? [200, (jsonBody(value) as {result: {tools: Array<{name: string}>}}).result.tools.length] : [value.status, jsonBody(value)]);
  const forbidden = [403, {message: "Workflow MCP request origin is not allowed."}];
  const unauthorized = [401, {message: "A workflow MCP token is required."}];

  assert.deepEqual(yield* outcome(mcpPost(port, {Host: local, ...bearer})), [200, 5]);
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: `localhost:${port}`, ...bearer})), forbidden);
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: "evil.example:9100", ...bearer})), forbidden);
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: local, Origin: "http://evil.example", ...bearer})), forbidden);
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: local, "Sec-Fetch-Site": "cross-site", ...bearer})), forbidden);
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: local, Origin: origin, ...bearer})), [200, 5]);
  // the Host check comes before the bearer check
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: "evil.example:9100"})), forbidden);
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: local})), unauthorized);
  const dashboardSession = yield* signIn(origin, directory);
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: local, Authorization: "Bearer " + dashboardSession})), unauthorized);
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: local, "x-supervisor-session": dashboardSession})), unauthorized);
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: local, Authorization: "Bearer " + "A".repeat(token.length)})), unauthorized);
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: local, Authorization: "bearer " + token})), unauthorized);
  // a configured host is accepted on both listeners, case-insensitively
  assert.deepEqual(yield* outcome(mcpPost(port, {Host: "supervisor.internal:9100", ...bearer})), [200, 5]);
  assert.deepEqual(yield* outcome(mcpPost(mcpPort, {Host: "SUPERVISOR.INTERNAL:9100", ...bearer})), [200, 5]);
  assert.deepEqual(yield* outcome(mcpPost(mcpPort, {Host: `127.0.0.1:${mcpPort}`, ...bearer})), [200, 5]);
  assert.deepEqual(yield* outcome(mcpPost(mcpPort, {Host: local, ...bearer})), forbidden, "the loopback host must name the receiving listener");

  const notFound = [404, {message: "Not found."}];
  for (const path of ["/api/guidance/snapshot", "/api/csrf", "/auth/status", "/", "/index.html"]) {
    const response = yield* rawRequest(mcpPort, {path, headers: {Host: `127.0.0.1:${mcpPort}`, "x-supervisor-session": dashboardSession}});
    assert.deepEqual([response.status, jsonBody(response)], notFound, path);
    assert.deepEqual(pickHeaders(response, Object.keys(securityHeaders)), securityHeaders);
  }
  const ui = yield* rawRequest(port, {path: "/api/guidance/snapshot", headers: {Host: local, "x-supervisor-session": dashboardSession}});
  assert.equal(ui.status, 200);
}), {timeout: 10_000});

it.live("CT-UI-01: a localhost Host or a cross-site non-navigation is refused with the loopback message, while a cross-site document navigation to / loads", () => Effect.gen(function* () {
  const started = yield* startUi();
  yield* writeAssets(started);
  const {port} = started;
  const host = {Host: `127.0.0.1:${port}`};
  const loopback = {message: "Open the supervisor through its loopback address."};
  const navigate = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-User": "?1"};
  const result = (path: string, headers: Record<string, string>) => Effect.map(rawRequest(port, {path, headers}), (response) =>
    [response.status, String(response.headers["content-type"]), response.status === 200 ? "body" : jsonBody(response)]);
  const refused = [403, "application/json", loopback];

  assert.deepEqual(yield* result("/", {Host: `localhost:${port}`}), refused);
  assert.deepEqual(yield* result("/api/csrf", {Host: `localhost:${port}`}), refused);
  assert.deepEqual(yield* result("/auth/status", {Host: `localhost:${port}`}), refused);
  assert.deepEqual(yield* result("/", {...host, Origin: `http://localhost:${port}`}), refused);
  assert.deepEqual(yield* result("/", {...host, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors"}), refused);
  assert.deepEqual(yield* result("/app.js", {...host, ...navigate}), refused, "only / and /index.html are navigation targets");
  assert.deepEqual(yield* result("/api/csrf", {...host, ...navigate}), refused);
  assert.deepEqual(yield* result("/", {...host, ...navigate, "Sec-Fetch-User": "?0"}), refused);
  assert.deepEqual(yield* result("/", {...host, ...navigate, "Sec-Fetch-Dest": "iframe"}), refused);

  const page = yield* rawRequest(port, {path: "/", headers: {...host, ...navigate}});
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.match(page.body, /^<!doctype html>/u);
  assert.equal((yield* rawRequest(port, {path: "/index.html", headers: {...host, ...navigate}})).status, 200);
  assert.deepEqual(yield* result("/app.js", {...host, "Sec-Fetch-Site": "same-origin"}), [200, "application/javascript", "body"]);
}), {timeout: 10_000});

it.live("CT-UI-02: sign-in rejects foreign origins, non-JSON, oversized, malformed and invalid requests, and a new sign-in revokes the presented session", () => Effect.gen(function* () {
  const {origin, directory} = yield* startUi();
  const login = (body: string, headers: Record<string, string> = {Origin: origin, "Content-Type": "application/json"}) =>
    within(exchangeJson(origin + "/auth/login", {method: "POST", headers, body}), "5 seconds", "sign-in");
  const page = {message: "Use the Supervisor sign-in page."};
  const token = yield* grant(directory);

  assert.deepEqual(yield* login(JSON.stringify({token}), {Origin: "http://evil.example", "Content-Type": "application/json"}),
    [403, {message: "Open the supervisor through its loopback address."}]);
  assert.deepEqual(yield* login(JSON.stringify({token}), {"Content-Type": "application/json"}), [403, page]);
  assert.deepEqual(yield* login(JSON.stringify({token}), {Origin: origin, "Content-Type": "text/plain"}), [403, page]);
  const padded = (size: number) => {
    const body = JSON.stringify({token: "x"});
    return body.slice(0, -1) + " ".repeat(size - body.length) + "}";
  };
  assert.equal(Buffer.byteLength(padded(2049)), 2049);
  assert.deepEqual(yield* login(padded(2049)), [413, {message: "The request payload is too large. Reduce its size before retrying."}]);
  assert.deepEqual(yield* login(padded(2048)), [401, {message: "The access token is invalid."}], "2048 bytes are read and parsed");
  assert.deepEqual(yield* login("{not json"), [400, {message: "Invalid sign-in request."}]);
  assert.deepEqual(yield* login(JSON.stringify({token: "not-a-grant"})), [401, {message: "The access token is invalid."}]);
  assert.deepEqual(yield* login(JSON.stringify({session: token})), [401, {message: "The access token is invalid."}]);
  const wrongMethod = yield* within(exchangeJson(origin + "/auth/login"), "5 seconds", "a sign-in read");
  assert.deepEqual(wrongMethod, [404, {message: "Not found."}]);

  // the refused requests above did not consume the grant
  const [firstStatus, first] = (yield* login(JSON.stringify({token}), {Origin: origin, "Content-Type": "application/json; charset=utf-8"})) as [number, {session: string}];
  assert.equal(firstStatus, 200);
  assert.deepEqual(yield* login(JSON.stringify({token})), [401, {message: "The access token is invalid."}], "a grant is single-use");
  const second = (yield* login(JSON.stringify({token: yield* grant(directory)}),
    {Origin: origin, "Content-Type": "application/json", "x-supervisor-session": first.session})) as [number, {authenticated: boolean; session: string}];
  assert.equal(second[0], 200);
  assert.equal(second[1].authenticated, true);
  assert.notEqual(second[1].session, first.session);
  const status = (value: string) => Effect.map(exchangeJson(origin + "/auth/status", {headers: {"x-supervisor-session": value}}),
    ([, body]) => (body as {authenticated: boolean}).authenticated);
  assert.equal(yield* status(first.session), false, "the session presented with the new sign-in is revoked");
  assert.equal(yield* status(second[1].session), true);
  assert.deepEqual(yield* exchangeJson(origin + "/api/csrf", {headers: {"x-supervisor-session": first.session}}), [401, {message: "Sign in to Supervisor."}]);
}), {timeout: 10_000});

// target change (S6d contract, the switch: the root provides the thread-policy store on its PolicyDb client for the process,
// and the dashboard's thread-policy handler saves through it): the baseline dashboard had no thread policy unless one was
// configured, so the 64000-byte save that reached the handler answered 400 "Chat settings unavailable."; the handler now
// always has the process's store, and the same save of generation 1 commits generation 2
it.live("CT-UI-03: /api answers 401 before CSRF, then 403 without a valid token and origin, 415 for non-JSON and 413 above 64000 bytes", () => Effect.gen(function* () {
  const {origin, directory} = yield* startUi();
  const call = (path: string, init: ExchangeInit = {}) => within(exchangeJson(origin + path, init), "5 seconds", path);
  const signedOut = [401, {message: "Sign in to Supervisor."}];
  assert.deepEqual(yield* call("/api/csrf"), signedOut);
  assert.deepEqual(yield* call("/api/guidance/thread-policy", {method: "POST", headers: {Origin: origin, "Content-Type": "text/plain"}, body: "{}"}), signedOut);
  assert.deepEqual(yield* call("/api/guidance/snapshot", {headers: {"x-supervisor-session": "A".repeat(43)}}), signedOut);

  const session = yield* signIn(origin, directory);
  const csrf = yield* readCsrf(origin, session);
  const refresh = [403, {message: "Refresh the local dashboard before changing settings."}];
  const post = (headers: Record<string, string>, body = "{}") => call("/api/guidance/thread-policy", {method: "POST", body,
    headers: {"x-supervisor-session": session, ...headers}});
  assert.deepEqual(yield* post({Origin: origin, "Content-Type": "application/json"}), refresh);
  assert.deepEqual(yield* post({Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf.slice(0, -1) + "x"}), refresh);
  assert.deepEqual(yield* post({"Content-Type": "application/json", "x-csrf-token": csrf}), refresh);
  // the CSRF check precedes the media type check
  assert.deepEqual(yield* post({Origin: origin, "Content-Type": "text/plain"}), refresh);
  assert.deepEqual(yield* post({Origin: origin, "Content-Type": "text/plain", "x-csrf-token": csrf}), [415, {message: "Use JSON for supervisor mutations."}]);
  assert.deepEqual(yield* post({Origin: origin, "x-csrf-token": csrf}, ""), [415, {message: "Use JSON for supervisor mutations."}]);
  const valid = {Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf};
  const padded = (size: number) => {
    const body = JSON.stringify({generation: 1, excludedThreadIds: []});
    return body.slice(0, -1) + " ".repeat(size - body.length) + "}";
  };
  assert.deepEqual(yield* post(valid, padded(64_001)), [413, {message: "The request payload is too large. Reduce its size before retrying."}]);
  // 64000 bytes reach the handler, which saves through the process's thread-policy store
  assert.deepEqual(yield* post(valid, padded(64_000)), [200, {generation: 2, excludedThreadIds: []}]);
}), {timeout: 10_000});

it.live("CT-UI-04: static files get a per-response CSP nonce on every script tag, exact MIME types, security headers, traversal 404 and POST 405", () => Effect.gen(function* () {
  const started = yield* startUi();
  yield* writeAssets(started);
  const {port} = started;
  const host = {Host: `127.0.0.1:${port}`};
  const nonceOf = (response: RawResponse) => /script-src 'nonce-([A-Za-z0-9_-]+)' 'strict-dynamic'/u.exec(String(response.headers["content-security-policy"]))?.[1];

  const page = yield* rawRequest(port, {path: "/", headers: host});
  assert.equal(page.status, 200);
  assert.deepEqual(pickHeaders(page, Object.keys(securityHeaders)), securityHeaders);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["content-security-policy"], `default-src 'none'; script-src 'nonce-${nonceOf(page)}' 'strict-dynamic'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  const nonce = nonceOf(page);
  assert.equal(nonce?.length, 27);
  const injected = [...page.body.matchAll(/<script nonce="([^"]+)"/gu)].map(match => match[1]);
  assert.deepEqual(injected, [nonce, nonce]);
  assert.equal(page.body.match(/<script\b/gu)?.length, 2);
  const again = yield* rawRequest(port, {path: "/index.html", headers: host});
  assert.notEqual(nonceOf(again), nonce, "every response has a fresh nonce");
  assert.deepEqual([...again.body.matchAll(/<script nonce="([^"]+)"/gu)].map(match => match[1]), [nonceOf(again), nonceOf(again)]);

  const script = yield* rawRequest(port, {path: "/app.js", headers: host});
  assert.deepEqual([script.status, script.headers["content-type"], script.body], [200, "application/javascript", "export const ready = true;\n"]);
  assert.ok(nonceOf(script));
  assert.equal((yield* rawRequest(port, {path: "/data.bin", headers: host})).headers["content-type"], "application/octet-stream");

  const notFound = [404, {message: "Not found."}];
  for (const path of ["/../secret", "/..%2fsecret", "/%2e%2e/secret", "/missing.js"]) {
    const response = yield* rawRequest(port, {path, headers: host});
    assert.deepEqual([response.status, jsonBody(response)], notFound, path);
  }
  const posted = yield* rawRequest(port, {method: "POST", path: "/", headers: {...host, "Content-Type": "text/html"}, body: "x"});
  assert.deepEqual([posted.status, jsonBody(posted)], [405, {message: "Method not allowed."}]);
  assert.deepEqual(pickHeaders(posted, Object.keys(securityHeaders)), securityHeaders);
}), {timeout: 10_000});

it.live("CT-UI-05: a client disconnect aborts the in-flight handler signal, and ui.close() aborts in-flight requests and resolves", () => Effect.gen(function* () {
  // each definitions read is held until its request's work is interrupted, the effect form of the baseline signal's abort
  const entries: Array<{interrupted: boolean; aborted: Deferred.Deferred<void>}> = [];
  const entered: Array<Deferred.Deferred<void>> = [];
  const definitions = definitionsOf(() => Effect.suspend(() => {
    const entry = {interrupted: false, aborted: Deferred.makeUnsafe<void>()};
    entries.push(entry);
    const ready = entered.shift();
    if (ready) Deferred.doneUnsafe(ready, Effect.void);
    return Effect.never.pipe(Effect.onInterrupt(() => Effect.andThen(Effect.sync(() => {entry.interrupted = true;}), Deferred.succeed(entry.aborted, undefined))));
  }));
  const started = yield* startUi({ui: {definitions}});
  const session = yield* signIn(started.origin, started.directory);
  const start = Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    entered.push(ready);
    const {client, settled} = yield* openRequest(started.port, {path: "/api/guidance/project-configuration?projectId=p", headers: {"x-supervisor-session": session}});
    return {client, ready: Deferred.await(ready), settled};
  });

  const first = yield* start;
  yield* within(first.ready, "5 seconds", "handler entry");
  assert.equal(entries[0]!.interrupted, false);
  first.client.destroy();
  yield* within(Deferred.await(entries[0]!.aborted), "5 seconds", "handler signal abort after the client disconnected");
  assert.equal(yield* within(first.settled, "5 seconds", "first client settlement"), "error ECONNRESET");

  const second = yield* start;
  yield* within(second.ready, "5 seconds", "second handler entry");
  assert.equal(entries[1]!.interrupted, false);
  yield* within(started.close, "5 seconds", "ui close with an in-flight request");
  assert.equal(entries[1]!.interrupted, true);
  assert.match(yield* within(second.settled, "5 seconds", "second client settlement"), /^(?:error ECONNRESET|response \d+)$/u);
  assert.equal(yield* connectRefused(started.port), true);
}), {timeout: 10_000});

it.live("CT-UI-06: a listen failure on the MCP bind host closes the UI listener and the login database before rejecting", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c3b-listen-");
  const blocker = yield* blockedPort;
  const blocked = (blocker.address() as {port: number}).port;
  const uiPort = yield* freePort;
  const runtimeConfig = uiConfig(directory);
  const services = yield* Layer.build(runtimeOver(runtimeConfig));
  const login = join(directory, "access", "login.sqlite3");
  assert.equal(openDescriptors(login), 0);

  // target change (R20, listener-specific startup codes): the start rejected with node's listen error; it now rejects with
  // the typed failure of the listener that could not listen, which carries no address, port or cause
  const failure = yield* Effect.flip(Effect.scoped(listeners(uiConfig(directory, {uiPort, workflowMcpBindHost: "127.0.0.1", workflowMcpPort: blocked}), services)));
  assert.ok(failure instanceof ListenerUnavailable && failure.reason === "workflow_mcp_listener_unavailable" && !("cause" in failure));
  assert.equal(existsSync(login), true, "the login database was created before listening");
  assert.equal(openDescriptors(login), 0, "the login database was closed");
  assert.equal(yield* connectRefused(uiPort), true);
  assert.equal(yield* portBindable(uiPort), true, "the UI port is reusable");

  // the same configuration starts once the MCP port is free, and its close releases the database again
  yield* Effect.callback<void>((resume) => {blocker.close(() => resume(Effect.void));});
  const scope = yield* Scope.make();
  yield* listeners(uiConfig(directory, {uiPort, workflowMcpBindHost: "127.0.0.1", workflowMcpPort: blocked}), services).pipe(Scope.provide(scope));
  yield* Effect.sync(() => assert.equal(openDescriptors(login), 1)).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
  assert.equal(openDescriptors(login), 0);
}), {timeout: 10_000});

it.live("CT-UI-07: session and CSRF values never reach console or process output during a full request cycle", (t) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c3b-log-");
  const started = yield* startUi({directory});
  // the process's thread-policy store the dashboard saves through
  const policy = started.policy;
  const {origin} = started;
  const captured: string[] = [];
  const capture = (...values: unknown[]) => {captured.push(values.map(value => typeof value === "string" ? value : String(value)).join(" "));return true;};
  for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) mockMethod(t, console, name, capture);
  mockMethod(t, process.stdout, "write", capture);
  mockMethod(t, process.stderr, "write", capture);
  console.log("c3b capture probe");

  const session = yield* signIn(origin, directory);
  const headers = {"x-supervisor-session": session};
  const csrf = yield* readCsrf(origin, session);
  const status = (path: string, init: ExchangeInit) => Effect.map(exchange(origin + path, init), (response) => response.status);
  const statuses = [
    yield* status("/api/guidance/snapshot", {headers}),
    yield* status("/api/guidance/thread-policy", {method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf},
      body: JSON.stringify({generation: (yield* policy.get()).generation, excludedThreadIds: ["excluded-thread"]})}),
    yield* status("/api/guidance/thread-policy", {method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf},
      body: JSON.stringify({generation: -1, excludedThreadIds: []})}),
    yield* status("/api/guidance/thread-policy", {method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf}, body: "{"}),
    yield* status("/api/guidance/thread-policy", {method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": "wrong"}, body: "{}"}),
    yield* status("/api/guidance/no-project-control", {headers: {...headers, "x-csrf-token": csrf}}),
    yield* status("/auth/logout", {method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf}, body: "{}"}),
    yield* status("/api/csrf", {headers}),
  ];
  assert.deepEqual(statuses, [200, 200, 400, 400, 403, 400, 200, 401]);
  yield* started.close;
  assert.deepEqual(captured, ["c3b capture probe"], "the request cycle wrote nothing");
  assert.equal(captured.some(line => line.includes(session) || line.includes(csrf)), false);
}), {timeout: 10_000});

const endpointGolden = [
  ["snapshot", "GET", "/api/guidance/snapshot"],
  ["dashboardOverview", "GET", "/api/guidance/dashboard-overview"],
  ["noProjectControl", "GET", "/api/guidance/no-project-control"],
  ["saveNoProjectControl", "POST", "/api/guidance/no-project-control"],
  ["supervisionCandidates", "GET", "/api/guidance/supervision-candidates"],
  ["startSupervision", "POST", "/api/guidance/supervision-start"],
  ["supervisionStartStatus", "GET", "/api/guidance/supervision-start"],
  ["supervisionControl", "GET", "/api/guidance/supervision-control"],
  ["saveSupervisionControl", "POST", "/api/guidance/supervision-control"],
  ["supervisionSetupOptions", "GET", "/api/guidance/supervision-setup"],
  ["setupSupervision", "POST", "/api/guidance/supervision-setup"],
  ["globalDefinitionsControl", "GET", "/api/guidance/global-definitions-control"],
  ["saveGlobalDefinitionsControl", "POST", "/api/guidance/global-definitions-control"],
  ["projectSupervisor", "GET", "/api/guidance/project-supervisor"],
  ["workflowProgress", "GET", "/api/guidance/workflow-progress"],
  ["saveProjectSupervisor", "POST", "/api/guidance/project-supervisor"],
  ["retryProjectSupervisor", "POST", "/api/guidance/project-supervisor/retry"],
  ["chatSupervision", "POST", "/api/guidance/project-supervisor/chat-supervision"],
  ["projectConfiguration", "GET", "/api/guidance/project-configuration"],
  ["saveProjectConfiguration", "POST", "/api/guidance/project-configuration"],
  ["threadPolicy", "POST", "/api/guidance/thread-policy"],
];

it.live("CT-UI-08: the HttpApi declares the golden endpoint list, UiError answers 400, and an unknown saveProjectConfiguration field is rejected before the handler", () => Effect.gen(function* () {
  const declared: Array<[string, string, string, number[]]> = [];
  for (const group of Object.values(SupervisorApi.groups)) for (const endpoint of Object.values(group.endpoints)) {
    const statuses = new Set<number>();
    HttpApi.reflect(SupervisorApi, {onGroup() {}, onEndpoint({endpoint: reflected, errors}) {
      if ((reflected as unknown) === endpoint) for (const status of errors.keys()) statuses.add(status);
    }});
    declared.push([endpoint.identifier, endpoint.method, endpoint.path, [...statuses]]);
  }
  assert.deepEqual(declared, endpointGolden.map(([name, method, path]) => [name, method, path, name === "snapshot" ? [] : [400]]));

  const saves: unknown[] = [];
  const editor = {save: (payload: unknown) => Effect.sync(() => {saves.push(payload);return {status: "invalid", message: "c3b handler reached", definitions: null};})} as unknown as
    ProjectConfigEditorService["Service"];
  const {origin, directory} = yield* startUi({ui: {editor}});
  const session = yield* signIn(origin, directory);
  const csrf = yield* readCsrf(origin, session);
  const headers = {"x-supervisor-session": session};
  const read = (path: string) => exchangeJson(origin + path, {headers});
  assert.deepEqual(yield* read("/api/guidance/no-project-control"), [400, {_tag: "UiError", message: "No Project mode unavailable."}]);
  assert.deepEqual(yield* read("/api/guidance/project-supervisor?projectId=p"), [400, {_tag: "UiError", message: "Project supervision is unavailable. Check the T3 connection and registered project."}]);
  assert.deepEqual(yield* read("/api/guidance/project-configuration?projectId=p"), [400, {_tag: "UiError", message: "Project definition access is unavailable."}]);

  const save = (payload: unknown) => Effect.map(exchange(origin + "/api/guidance/project-configuration", {method: "POST", body: JSON.stringify(payload),
    headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf}}), (response) =>
    [response.status, response.headers["content-type"] ?? null, response.text ? JSON.parse(response.text) as unknown : response.text]);
  const payload = {projectId: "p", threadId: null, expectedRevision: "a".repeat(64), config: {workflows: [], steps: []}};
  assert.deepEqual(yield* save(payload), [200, "application/json", {status: "invalid", message: "c3b handler reached", definitions: null}]);
  assert.equal(saves.length, 1);
  // a payload decoding failure answers 400 with an empty body and no content type on effect 4.0.1
  const rejected = [400, null, ""];
  assert.deepEqual(yield* save({...payload, legacy: true}), rejected);
  assert.deepEqual(yield* save({...payload, config: {workflows: [], steps: [], required: []}}), rejected);
  assert.deepEqual(yield* save({...payload, config: {workflows: [], steps: [{path: "steps/a.md", summary: "A", required: false, id: "a"}]}}), rejected);
  assert.equal(saves.length, 1, "no excess-field payload reached the handler");
}), {timeout: 10_000});
