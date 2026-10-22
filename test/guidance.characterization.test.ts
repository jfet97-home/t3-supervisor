import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { HttpApi } from "effect/http-api";
import { TestClock } from "effect/testing";
import { it } from "vitest";
import { GuidanceRuntime } from "../src/guidance.js";
import { guidanceRuntimeFacade } from "../src/guidance-application.js";
import { SupervisorApi } from "../src/guidance-contract.js";
import { GuidanceStore } from "../src/guidance-store.js";
import type { ProjectConfigEditor } from "../src/project-config-editor.js";
import type { ProjectDefinitionLoader } from "../src/project-definitions.js";
import { forgeDashboardToken, startGuidanceUi } from "./support/service-auth-harness.js";
import { ThreadPolicyStore } from "../src/thread-policy.js";
import type { ProjectInfo } from "../src/types.js";
import { createWorkflowMcpEndpoint } from "../src/workflow-mcp.js";
import type { WorkflowWriteController } from "../src/workflow-write-controller.js";
import { mockMethod } from "./support/node-test.js";
import { connectRefused, defer, freePort, jsonBody, openDescriptors, portBindable, rawRequest, readCsrf, signIn, within, type RawResponse } from "./support/c3b-http.js";
import { startUi, tempDirectory, uiConfig, type StartedUi } from "./support/c3b-ui.js";
import { appConfig, buildT3Client, probeToken, runApp, startFakeT3, type AppCatalog } from "./support/c3b-app.js";

const project = (id: string, workspaceRoot: string, available = true): {project: ProjectInfo; available: boolean} =>
  ({project: {id, title: id, workspaceRoot}, available});

const session = async (origin: string, directory: string) => ({"x-supervisor-session": await signIn(origin, directory)});

const getJson = async (url: string, headers: Record<string, string>): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(5_000)});
  assert.equal(response.status, 200, url);
  return await response.json() as Record<string, unknown>;
};

const guidanceFile = (directory: string) => join(directory, "guidance.sqlite3");

it("CT-APP-01: dashboard classification lets explicit choices win and resolves the managed root with or without a trailing slash", {timeout: 10_000}, async t => {
  const directory = await tempDirectory(t, "c3b-classify-");
  const store = new GuidanceStore(directory);
  defer(t, () => store.close());
  store.classify("explicit-project", "project", 1);
  store.classify("explicit-scratch", "scratch", 2);
  const projects = [
    project("managed", "/work/scratch"),
    project("managed-slash", "/work/scratch/"),
    project("managed-dots", "/work/other/../scratch"),
    project("other", "/work/other"),
    project("explicit-project", "/work/scratch"),
    project("explicit-scratch", "/work/other"),
    project("unavailable", "/work/scratch", false),
  ];
  const classify = async (managedScratchRoot?: string) => {
    const runtime = Effect.runSync(GuidanceRuntime.make({...uiConfig(directory), ...(managedScratchRoot === undefined ? {} : {managedScratchRoot})}, store,
      {catalog: () => Effect.succeed({projects, threads: []})}));
    return Object.fromEntries((await Effect.runPromise(runtime.snapshot)).projects.map(item => [item.id, item.classification]));
  };
  const managed = {
    managed: "scratch", "managed-slash": "scratch", "managed-dots": "scratch", other: "project",
    "explicit-project": "project", "explicit-scratch": "scratch", unavailable: "unclassified",
  };
  // path.resolve drops the trailing slash and dot segments on both sides of the comparison
  assert.deepEqual(await classify("/work/scratch/"), managed);
  assert.deepEqual(await classify("/work/scratch"), managed);
  // without a managed root only an explicit classification is known
  assert.deepEqual(await classify(), {
    managed: "unclassified", "managed-slash": "unclassified", "managed-dots": "unclassified", other: "unclassified",
    "explicit-project": "project", "explicit-scratch": "scratch", unavailable: "unclassified",
  });
});

it("CT-APP-01: the running application's definition scratch check keeps a trailing slash that the dashboard classification drops", {timeout: 10_000}, async t => {
  const directory = await tempDirectory(t, "c3b-app-classify-");
  const seeded = new GuidanceStore(directory);
  seeded.classify("explicit-scratch", "scratch", 1);
  seeded.classify("explicit-project", "project", 2);
  seeded.close();
  const peer = await startFakeT3(t);
  const config = await appConfig(directory, peer.url, {managedScratchRoot: "/work/scratch/"});
  const catalog: AppCatalog = {threads: [], projects: [
    project("bare", "/work/scratch"),
    project("slashed", "/work/scratch/"),
    project("explicit-scratch", "/work/other"),
    project("explicit-project", "/work/scratch/"),
  ]};
  const app = runApp(t, config, await buildT3Client(peer.url), () => catalog);
  await within(app.ready, 5_000, "application readiness");
  const headers = await session(app.origin, directory);

  const snapshot = await getJson(app.origin + "/api/guidance/snapshot", headers);
  assert.deepEqual(Object.fromEntries((snapshot.projects as Array<{id: string; classification: string}>).map(item => [item.id, item.classification])),
    {bare: "scratch", slashed: "scratch", "explicit-scratch": "scratch", "explicit-project": "project"});
  const globalOnly: Record<string, unknown> = {};
  for (const id of ["bare", "slashed", "explicit-scratch", "explicit-project"]) {
    const definitions = await getJson(app.origin + "/api/guidance/project-configuration?" + new URLSearchParams({projectId: id}), headers);
    globalOnly[id] = definitions.globalOnly;
  }
  // posix.normalize keeps the trailing slash of the managed root (guidance-application.ts:61,68), so "/work/scratch" is not scratch here
  assert.deepEqual(globalOnly, {bare: false, slashed: true, "explicit-scratch": true, "explicit-project": false});
});

it("CT-APP-02: interrupting the application closes the UI listener, cleans up git probes once more while the store is open, and closes both databases", {timeout: 10_000}, async t => {
  const directory = await tempDirectory(t, "c3b-app-shutdown-");
  const pending = {threadId: "t3-supervisor-git-probe-" + randomUUID(), terminalId: "t3-supervisor-git-probe-" + randomUUID()};
  const seeded = new GuidanceStore(directory);
  seeded.db.prepare("INSERT INTO meta(key,value) VALUES('native_git_probe_sessions',?)").run(JSON.stringify([pending]));
  seeded.close();
  const probeFile = join(directory, "probe-token");
  await writeFile(probeFile, probeToken, {mode: 0o600});
  const peer = await startFakeT3(t);
  const config = await appConfig(directory, peer.url, {gitProbeTokenFile: probeFile});
  const logs: string[] = [];
  mockMethod(t, console, "log", (...values: unknown[]) => {logs.push(values.map(String).join(" "));});
  const closes: Array<{payload: Record<string, unknown>; uiRefused: boolean}> = [];
  // the startup cleanup is rejected so the session stays pending; the shutdown cleanup then closes it
  peer.onRpc = async request => {
    if (request.tag !== "terminal.close") return {_tag: "Failure", cause: {message: "unexpected"}};
    const uiRefused = await connectRefused(config.uiPort!);
    closes.push({payload: request.payload, uiRefused});
    return closes.length === 1 ? {_tag: "Failure", cause: {message: "terminal busy"}} : {_tag: "Success", value: {}};
  };
  const app = runApp(t, config, await buildT3Client(peer.url), () => ({projects: [], threads: []}));
  await within(app.ready, 5_000, "application readiness");
  assert.equal(closes.length, 1, "the startup cleanup ran before readiness");
  assert.deepEqual(closes[0]!.payload, {...pending, deleteHistory: true});
  assert.equal(closes[0]!.uiRefused, true, "the startup cleanup runs before the UI listens");
  assert.deepEqual(logs, [JSON.stringify({event: "native_git_probe_cleanup_unavailable"})]);
  const status = await fetch(app.origin + "/auth/status", {signal: AbortSignal.timeout(5_000)});
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {authenticated: false});
  const loginFile = join(directory, "access", "login.sqlite3");
  assert.ok(openDescriptors(guidanceFile(directory)) >= 1);
  assert.ok(openDescriptors(loginFile) >= 1);

  await app.interrupt();
  assert.equal(closes.length, 2, "shutdown ran the cleanup exactly once more");
  assert.deepEqual(closes[1]!.payload, {...pending, deleteHistory: true});
  assert.equal(closes[1]!.uiRefused, true, "the UI listener was already closed when the shutdown cleanup ran");
  assert.equal(peer.rpcs.every(request => request.authorization === "Bearer " + probeToken), true);
  assert.equal(logs.length, 1);
  assert.equal(await connectRefused(config.uiPort!), true);
  assert.equal(await portBindable(config.uiPort!), true);
  assert.equal(openDescriptors(guidanceFile(directory)), 0);
  assert.equal(openDescriptors(guidanceFile(directory) + "-wal"), 0);
  assert.equal(openDescriptors(loginFile), 0);
  // the last connection checkpointed and removed the write-ahead log on close
  assert.equal(existsSync(guidanceFile(directory) + "-wal"), false);

  const reopened = new GuidanceStore(directory);
  try {
    assert.equal(reopened.db.prepare("SELECT value FROM meta WHERE key='native_git_probe_sessions'").get()?.value, "[]",
      "the shutdown cleanup removed the session while the store was still open");
    const wal = guidanceFile(directory) + "-wal";
    assert.equal(existsSync(wal) ? statSync(wal).size : 0, 0, "reopening replays and writes nothing");
  } finally {reopened.close();}
});

const activityRow = (id: string, createdAt: number) => [id, JSON.stringify({
  id, kind: "owner_action", threadId: null, ruleId: null, runId: null, state: "recorded", reason: "c3b_seed", detail: null, createdAt,
}), createdAt] as const;

it("CT-APP-03: a failed descriptor read marks the dashboard disconnected with the exact text and skips pruning; the next successful cycle restores and prunes", {timeout: 10_000}, async t => {
  const directory = await tempDirectory(t, "c3b-app-cycle-");
  const old = Date.now() - 31 * 86_400_000;
  const seeded = new GuidanceStore(directory);
  seeded.db.prepare("INSERT INTO activity VALUES(?,?,?)").run(...activityRow("seed-before-start", old));
  seeded.db.prepare("INSERT INTO activity VALUES(?,?,?)").run(...activityRow("recent", Date.now()));
  seeded.close();
  const peer = await startFakeT3(t);
  const config = await appConfig(directory, peer.url);
  // closing the make scope at once only retires the idle-clock warning; the clock keeps working
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
  const app = runApp(t, config, await buildT3Client(peer.url), () => ({projects: [], threads: []}), clock);
  await within(app.ready, 5_000, "application readiness");
  await within(app.nextRootSleep(1), 5_000, "first monitor cycle");
  const headers = await session(app.origin, directory);
  const read = async () => {
    const snapshot = await getJson(app.origin + "/api/guidance/snapshot", headers);
    return {connected: snapshot.connected, coverage: snapshot.coverage, environmentId: snapshot.environmentId, lastCycleAt: snapshot.lastCycleAt,
      activity: (snapshot.activity as Array<{id: string}>).map(item => item.id)};
  };
  const first = await read();
  assert.deepEqual({...first, lastCycleAt: typeof first.lastCycleAt}, {connected: true, coverage: "Native project and workflow supervision is active.",
    environmentId: "c3b-environment", lastCycleAt: "number", activity: ["recent"]});
  assert.equal(peer.descriptorRequests, 2, "startup read plus the first cycle");

  const writer = new DatabaseSync(guidanceFile(directory));
  try {writer.prepare("INSERT INTO activity VALUES(?,?,?)").run(...activityRow("seed-before-failure", old));}
  finally {writer.close();}
  peer.descriptorAvailable = false;
  await Effect.runPromise(clock.adjust("5 seconds"));
  await within(app.nextRootSleep(2), 5_000, "failed monitor cycle");
  const failed = await read();
  assert.deepEqual(failed, {connected: false, coverage: "T3 connection unavailable. Project editing needs a working T3 connection.",
    environmentId: "c3b-environment", lastCycleAt: first.lastCycleAt, activity: ["recent", "seed-before-failure"]});

  peer.descriptorAvailable = true;
  await Effect.runPromise(clock.adjust("5 seconds"));
  await within(app.nextRootSleep(3), 5_000, "recovered monitor cycle");
  const recovered = await read();
  assert.equal(recovered.connected, true);
  assert.equal(recovered.coverage, "Native project and workflow supervision is active.");
  assert.ok(typeof recovered.lastCycleAt === "number" && recovered.lastCycleAt >= (first.lastCycleAt as number));
  assert.deepEqual(recovered.activity, ["recent"]);
  assert.equal(peer.descriptorRequests, 4);
  assert.equal(app.rootSleeps(), 3, "no cycle ran without a clock adjustment");
});

const seedNotices = (directory: string) => {
  const created = new GuidanceStore(directory);
  created.close();
  const db = new DatabaseSync(guidanceFile(directory));
  try {
    const insert = db.prepare("INSERT INTO notices(id,thread_id,rule_id,run_id,epoch,state,text,message_id,created_at,dispatch_started) VALUES(?,?,?,?,?,?,?,?,?,?)");
    insert.run("not-started", "thread-a", "rule-a", "run-a", 3, "committed", "text a", null, 1_000, 0);
    insert.run("started", "thread-b", "rule-b", "run-b", 4, "committed", "text b", null, 2_000, 1);
    insert.run("visible", "thread-c", "rule-c", "run-c", 5, "visible", "text c", null, 3_000, 1);
  } finally {db.close();}
};

const recoveryRows = (store: GuidanceStore) => store.db.prepare(
  "SELECT json_extract(document,'$.noticeId') AS noticeId, json_extract(document,'$.state') AS state, json_extract(document,'$.episodeEpoch') AS epoch FROM activity WHERE json_extract(document,'$.reason')='process_recovery' ORDER BY noticeId",
).all().map(row => ({...row}));

it("CT-GDB-01: reopening with committed notices recovers each once, lists the uncertain notice first and records nothing on a second reopen", {timeout: 10_000}, async t => {
  const directory = await tempDirectory(t, "c3b-gdb-recovery-");
  seedNotices(directory);
  const first = new GuidanceStore(directory);
  try {
    assert.deepEqual(first.db.prepare("SELECT id,state FROM notices ORDER BY id").all().map(row => ({...row})),
      [{id: "not-started", state: "not_delivered_restart"}, {id: "started", state: "uncertain"}, {id: "visible", state: "visible"}]);
    assert.deepEqual(recoveryRows(first), [{noticeId: "not-started", state: "not_delivered_restart", epoch: 3}, {noticeId: "started", state: "uncertain", epoch: 4}]);
    const activities = first.activities();
    assert.deepEqual(activities[0], {id: "notice:started", noticeId: "started", episodeEpoch: 4, threadId: "thread-b", ruleId: "rule-b", runId: "run-b",
      kind: "guidance", state: "uncertain", reason: "unreconciled_notice", detail: null, createdAt: 2_000});
    // the uncertain notice's own recovery row is folded into its unresolved entry
    assert.deepEqual(activities.slice(1).map(item => [item.noticeId, item.reason, item.state]), [["not-started", "process_recovery", "not_delivered_restart"]]);
  } finally {first.close();}

  const second = new GuidanceStore(directory);
  try {
    assert.deepEqual(recoveryRows(second), [{noticeId: "not-started", state: "not_delivered_restart", epoch: 3}, {noticeId: "started", state: "uncertain", epoch: 4}]);
    assert.equal(second.db.prepare("SELECT COUNT(*) AS count FROM activity").get()?.count, 2);
    assert.equal(second.activities()[0]?.id, "notice:started");
  } finally {second.close();}
});

it("CT-GDB-02: opening a pre-migration database adds the episode and notice generation columns with defaults and keeps the rows", {timeout: 10_000}, async t => {
  const directory = await tempDirectory(t, "c3b-gdb-migrate-");
  await mkdir(directory, {recursive: true});
  const legacy = new DatabaseSync(guidanceFile(directory));
  try {
    legacy.exec(`CREATE TABLE episodes(thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread_id,rule_id));
      CREATE TABLE notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,state TEXT NOT NULL,text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,
      dispatch_started INTEGER NOT NULL DEFAULT 0);`);
    legacy.prepare("INSERT INTO episodes VALUES(?,?,?,?)").run("thread-a", "rule-a", 7, 1);
    legacy.prepare("INSERT INTO notices VALUES(?,?,?,?,?,?,?,?,?,?)").run("notice-a", "thread-a", "rule-a", "run-a", 7, "visible", "legacy text", "message-a", 5_000, 1);
  } finally {legacy.close();}

  const store = new GuidanceStore(directory);
  try {
    const columns = (table: string) => store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, row.dflt_value, row.notnull]);
    assert.deepEqual(columns("episodes").at(-1), ["object_id", null, 0]);
    assert.deepEqual(columns("notices").slice(-2), [["rule_generation", "-1", 1], ["settings_generation", "-1", 1]]);
    assert.deepEqual({...store.db.prepare("SELECT * FROM episodes").get()}, {thread_id: "thread-a", rule_id: "rule-a", epoch: 7, notified: 1, object_id: null});
    assert.deepEqual({...store.db.prepare("SELECT * FROM notices").get()}, {id: "notice-a", thread_id: "thread-a", rule_id: "rule-a", run_id: "run-a", epoch: 7,
      state: "visible", text: "legacy text", message_id: "message-a", created_at: 5_000, dispatch_started: 1, rule_generation: -1, settings_generation: -1});
    assert.deepEqual(recoveryRows(store), []);
  } finally {store.close();}
  // a second open finds the columns present and alters nothing
  const again = new GuidanceStore(directory);
  try {
    assert.equal(again.db.prepare("PRAGMA table_info(notices)").all().length, 12);
    assert.equal(again.db.prepare("PRAGMA table_info(episodes)").all().length, 5);
  } finally {again.close();}
});

it("CT-GDB-06: a nested transaction() fails at its BEGIN and rolls back the outer work", {timeout: 10_000}, async t => {
  const directory = await tempDirectory(t, "c3b-gdb-nested-");
  const store = new GuidanceStore(directory);
  defer(t, () => store.close());
  let innerRan = false;
  assert.throws(() => store.transaction(() => {
    store.db.prepare("INSERT INTO meta VALUES('c3b-outer','1')").run();
    return store.transaction(() => {innerRan = true;store.db.prepare("INSERT INTO meta VALUES('c3b-inner','1')").run();});
  }), /cannot start a transaction within a transaction/u);
  assert.equal(innerRan, false);
  assert.equal(store.db.isTransaction, false);
  const observer = new DatabaseSync(guidanceFile(directory));
  try {
    assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'c3b-%'").get()?.count, 0);
  } finally {observer.close();}
  // the store stays usable for the next top-level transaction
  assert.equal(store.transaction(() => {store.db.prepare("INSERT INTO meta VALUES('c3b-after','1')").run();return "committed";}), "committed");
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='c3b-after'").get()?.value, "1");
});

const securityHeaders = {"cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
  "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin"};
const pickHeaders = (response: RawResponse, names: readonly string[]) => Object.fromEntries(names.map(name => [name, response.headers[name]]));

const writeAssets = async (started: StartedUi) => {
  const assets = started.config.uiAssetsDirectory!;
  await mkdir(assets, {recursive: true});
  await writeFile(join(assets, "index.html"),
    "<!doctype html><html><head><script type=\"module\" src=\"/app.js\"></script></head><body><script>window.ready = true;</script></body></html>");
  await writeFile(join(assets, "app.js"), "export const ready = true;\n");
  await writeFile(join(assets, "data.bin"), "binary");
  await writeFile(join(started.directory, "secret"), "outside the assets directory");
};

const mcpList = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list", params: {}});
const mcpPost = (port: number, headers: Record<string, string>) => rawRequest(port, {method: "POST", path: "/mcp/workflows", body: mcpList,
  headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers}});

it("CT-MCP-01: the workflow MCP route enforces Host, Origin and bearer before the endpoint, and the MCP-only listener serves nothing else", {timeout: 10_000}, async t => {
  const controller = {readTool: async () => ({status: "ok"})} as unknown as WorkflowWriteController;
  const started = await startUi(t, {workflows: createWorkflowMcpEndpoint(controller),
    config: {workflowMcpBindHost: "127.0.0.1", workflowMcpPort: 0, workflowMcpHosts: ["supervisor.internal:9100"]}});
  const {port, origin, directory} = started;
  const mcpPort = started.mcpPort!;
  assert.notEqual(mcpPort, port);
  const token = (await readFile(join(directory, "access", "workflow-mcp-token"), "utf8")).trim();
  const bearer = {Authorization: "Bearer " + token};
  const local = `127.0.0.1:${port}`;
  const outcome = async (response: Promise<RawResponse>) => {
    const value = await response;
    return value.status === 200 ? [200, (jsonBody(value) as {result: {tools: Array<{name: string}>}}).result.tools.length] : [value.status, jsonBody(value)];
  };
  const forbidden = [403, {message: "Workflow MCP request origin is not allowed."}];
  const unauthorized = [401, {message: "A workflow MCP token is required."}];

  assert.deepEqual(await outcome(mcpPost(port, {Host: local, ...bearer})), [200, 4]);
  assert.deepEqual(await outcome(mcpPost(port, {Host: `localhost:${port}`, ...bearer})), forbidden);
  assert.deepEqual(await outcome(mcpPost(port, {Host: "evil.example:9100", ...bearer})), forbidden);
  assert.deepEqual(await outcome(mcpPost(port, {Host: local, Origin: "http://evil.example", ...bearer})), forbidden);
  assert.deepEqual(await outcome(mcpPost(port, {Host: local, "Sec-Fetch-Site": "cross-site", ...bearer})), forbidden);
  assert.deepEqual(await outcome(mcpPost(port, {Host: local, Origin: origin, ...bearer})), [200, 4]);
  // the Host check comes before the bearer check
  assert.deepEqual(await outcome(mcpPost(port, {Host: "evil.example:9100"})), forbidden);
  assert.deepEqual(await outcome(mcpPost(port, {Host: local})), unauthorized);
  const dashboardSession = await signIn(origin, directory);
  assert.deepEqual(await outcome(mcpPost(port, {Host: local, Authorization: "Bearer " + dashboardSession})), unauthorized);
  assert.deepEqual(await outcome(mcpPost(port, {Host: local, "x-supervisor-session": dashboardSession})), unauthorized);
  assert.deepEqual(await outcome(mcpPost(port, {Host: local, Authorization: "Bearer " + "A".repeat(token.length)})), unauthorized);
  assert.deepEqual(await outcome(mcpPost(port, {Host: local, Authorization: "bearer " + token})), unauthorized);
  // a configured host is accepted on both listeners, case-insensitively
  assert.deepEqual(await outcome(mcpPost(port, {Host: "supervisor.internal:9100", ...bearer})), [200, 4]);
  assert.deepEqual(await outcome(mcpPost(mcpPort, {Host: "SUPERVISOR.INTERNAL:9100", ...bearer})), [200, 4]);
  assert.deepEqual(await outcome(mcpPost(mcpPort, {Host: `127.0.0.1:${mcpPort}`, ...bearer})), [200, 4]);
  assert.deepEqual(await outcome(mcpPost(mcpPort, {Host: local, ...bearer})), forbidden, "the loopback host must name the receiving listener");

  const notFound = [404, {message: "Not found."}];
  for (const path of ["/api/guidance/snapshot", "/api/csrf", "/auth/status", "/", "/index.html"]) {
    const response = await rawRequest(mcpPort, {path, headers: {Host: `127.0.0.1:${mcpPort}`, "x-supervisor-session": dashboardSession}});
    assert.deepEqual([response.status, jsonBody(response)], notFound, path);
    assert.deepEqual(pickHeaders(response, Object.keys(securityHeaders)), securityHeaders);
  }
  const ui = await rawRequest(port, {path: "/api/guidance/snapshot", headers: {Host: local, "x-supervisor-session": dashboardSession}});
  assert.equal(ui.status, 200);
});

it("CT-UI-01: a localhost Host or a cross-site non-navigation is refused with the loopback message, while a cross-site document navigation to / loads", {timeout: 10_000}, async t => {
  const started = await startUi(t);
  await writeAssets(started);
  const {port} = started;
  const host = {Host: `127.0.0.1:${port}`};
  const loopback = {message: "Open the supervisor through its loopback address."};
  const navigate = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-User": "?1"};
  const result = async (path: string, headers: Record<string, string>) => {
    const response = await rawRequest(port, {path, headers});
    return [response.status, String(response.headers["content-type"]), response.status === 200 ? "body" : jsonBody(response)];
  };
  const refused = [403, "application/json", loopback];

  assert.deepEqual(await result("/", {Host: `localhost:${port}`}), refused);
  assert.deepEqual(await result("/api/csrf", {Host: `localhost:${port}`}), refused);
  assert.deepEqual(await result("/auth/status", {Host: `localhost:${port}`}), refused);
  assert.deepEqual(await result("/", {...host, Origin: `http://localhost:${port}`}), refused);
  assert.deepEqual(await result("/", {...host, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors"}), refused);
  assert.deepEqual(await result("/app.js", {...host, ...navigate}), refused, "only / and /index.html are navigation targets");
  assert.deepEqual(await result("/api/csrf", {...host, ...navigate}), refused);
  assert.deepEqual(await result("/", {...host, ...navigate, "Sec-Fetch-User": "?0"}), refused);
  assert.deepEqual(await result("/", {...host, ...navigate, "Sec-Fetch-Dest": "iframe"}), refused);

  const page = await rawRequest(port, {path: "/", headers: {...host, ...navigate}});
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.match(page.body, /^<!doctype html>/u);
  assert.equal((await rawRequest(port, {path: "/index.html", headers: {...host, ...navigate}})).status, 200);
  assert.deepEqual(await result("/app.js", {...host, "Sec-Fetch-Site": "same-origin"}), [200, "application/javascript", "body"]);
});

it("CT-UI-02: sign-in rejects foreign origins, non-JSON, oversized, malformed and invalid requests, and a new sign-in revokes the presented session", {timeout: 10_000}, async t => {
  const {origin, directory} = await startUi(t);
  const login = async (body: string, headers: Record<string, string> = {Origin: origin, "Content-Type": "application/json"}) => {
    const response = await fetch(origin + "/auth/login", {method: "POST", headers, body, signal: AbortSignal.timeout(5_000)});
    return [response.status, await response.json()];
  };
  const page = {message: "Use the Supervisor sign-in page."};
  const grant = (await forgeDashboardToken(directory)).token;

  assert.deepEqual(await login(JSON.stringify({token: grant}), {Origin: "http://evil.example", "Content-Type": "application/json"}),
    [403, {message: "Open the supervisor through its loopback address."}]);
  assert.deepEqual(await login(JSON.stringify({token: grant}), {"Content-Type": "application/json"}), [403, page]);
  assert.deepEqual(await login(JSON.stringify({token: grant}), {Origin: origin, "Content-Type": "text/plain"}), [403, page]);
  const padded = (size: number) => {
    const body = JSON.stringify({token: "x"});
    return body.slice(0, -1) + " ".repeat(size - body.length) + "}";
  };
  assert.equal(Buffer.byteLength(padded(2049)), 2049);
  assert.deepEqual(await login(padded(2049)), [413, {message: "The request payload is too large. Reduce its size before retrying."}]);
  assert.deepEqual(await login(padded(2048)), [401, {message: "The access token is invalid."}], "2048 bytes are read and parsed");
  assert.deepEqual(await login("{not json"), [400, {message: "Invalid sign-in request."}]);
  assert.deepEqual(await login(JSON.stringify({token: "not-a-grant"})), [401, {message: "The access token is invalid."}]);
  assert.deepEqual(await login(JSON.stringify({session: grant})), [401, {message: "The access token is invalid."}]);
  const wrongMethod = await fetch(origin + "/auth/login", {signal: AbortSignal.timeout(5_000)});
  assert.deepEqual([wrongMethod.status, await wrongMethod.json()], [404, {message: "Not found."}]);

  // the refused requests above did not consume the grant
  const [firstStatus, first] = await login(JSON.stringify({token: grant}), {Origin: origin, "Content-Type": "application/json; charset=utf-8"}) as [number, {session: string}];
  assert.equal(firstStatus, 200);
  assert.deepEqual(await login(JSON.stringify({token: grant})), [401, {message: "The access token is invalid."}], "a grant is single-use");
  const second = await login(JSON.stringify({token: (await forgeDashboardToken(directory)).token}),
    {Origin: origin, "Content-Type": "application/json", "x-supervisor-session": first.session}) as [number, {authenticated: boolean; session: string}];
  assert.equal(second[0], 200);
  assert.equal(second[1].authenticated, true);
  assert.notEqual(second[1].session, first.session);
  const status = async (value: string) => (await (await fetch(origin + "/auth/status", {headers: {"x-supervisor-session": value}})).json() as {authenticated: boolean}).authenticated;
  assert.equal(await status(first.session), false, "the session presented with the new sign-in is revoked");
  assert.equal(await status(second[1].session), true);
  const csrf = await fetch(origin + "/api/csrf", {headers: {"x-supervisor-session": first.session}});
  assert.deepEqual([csrf.status, await csrf.json()], [401, {message: "Sign in to Supervisor."}]);
});

it("CT-UI-03: /api answers 401 before CSRF, then 403 without a valid token and origin, 415 for non-JSON and 413 above 64000 bytes", {timeout: 10_000}, async t => {
  const {origin, directory} = await startUi(t);
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(origin + path, {...init, signal: AbortSignal.timeout(5_000)});
    return [response.status, await response.json()];
  };
  const signedOut = [401, {message: "Sign in to Supervisor."}];
  assert.deepEqual(await call("/api/csrf"), signedOut);
  assert.deepEqual(await call("/api/guidance/thread-policy", {method: "POST", headers: {Origin: origin, "Content-Type": "text/plain"}, body: "{}"}), signedOut);
  assert.deepEqual(await call("/api/guidance/snapshot", {headers: {"x-supervisor-session": "A".repeat(43)}}), signedOut);

  const session = await signIn(origin, directory);
  const csrf = await readCsrf(origin, session);
  const refresh = [403, {message: "Refresh the local dashboard before changing settings."}];
  const post = (headers: Record<string, string>, body = "{}") => call("/api/guidance/thread-policy", {method: "POST", body,
    headers: {"x-supervisor-session": session, ...headers}});
  assert.deepEqual(await post({Origin: origin, "Content-Type": "application/json"}), refresh);
  assert.deepEqual(await post({Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf.slice(0, -1) + "x"}), refresh);
  assert.deepEqual(await post({"Content-Type": "application/json", "x-csrf-token": csrf}), refresh);
  // the CSRF check precedes the media type check
  assert.deepEqual(await post({Origin: origin, "Content-Type": "text/plain"}), refresh);
  assert.deepEqual(await post({Origin: origin, "Content-Type": "text/plain", "x-csrf-token": csrf}), [415, {message: "Use JSON for supervisor mutations."}]);
  assert.deepEqual(await post({Origin: origin, "x-csrf-token": csrf}, ""), [415, {message: "Use JSON for supervisor mutations."}]);
  const valid = {Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf};
  const padded = (size: number) => {
    const body = JSON.stringify({generation: 1, excludedThreadIds: []});
    return body.slice(0, -1) + " ".repeat(size - body.length) + "}";
  };
  assert.deepEqual(await post(valid, padded(64_001)), [413, {message: "The request payload is too large. Reduce its size before retrying."}]);
  // 64000 bytes reach the handler, which has no thread policy configured here
  assert.deepEqual(await post(valid, padded(64_000)), [400, {_tag: "UiError", message: "Chat settings unavailable."}]);
});

it("CT-UI-04: static files get a per-response CSP nonce on every script tag, exact MIME types, security headers, traversal 404 and POST 405", {timeout: 10_000}, async t => {
  const started = await startUi(t);
  await writeAssets(started);
  const {port} = started;
  const host = {Host: `127.0.0.1:${port}`};
  const nonceOf = (response: RawResponse) => /script-src 'nonce-([A-Za-z0-9_-]+)' 'strict-dynamic'/u.exec(String(response.headers["content-security-policy"]))?.[1];

  const page = await rawRequest(port, {path: "/", headers: host});
  assert.equal(page.status, 200);
  assert.deepEqual(pickHeaders(page, Object.keys(securityHeaders)), securityHeaders);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["content-security-policy"], `default-src 'none'; script-src 'nonce-${nonceOf(page)}' 'strict-dynamic'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  const nonce = nonceOf(page);
  assert.equal(nonce?.length, 27);
  const injected = [...page.body.matchAll(/<script nonce="([^"]+)"/gu)].map(match => match[1]);
  assert.deepEqual(injected, [nonce, nonce]);
  assert.equal(page.body.match(/<script\b/gu)?.length, 2);
  const again = await rawRequest(port, {path: "/index.html", headers: host});
  assert.notEqual(nonceOf(again), nonce, "every response has a fresh nonce");
  assert.deepEqual([...again.body.matchAll(/<script nonce="([^"]+)"/gu)].map(match => match[1]), [nonceOf(again), nonceOf(again)]);

  const script = await rawRequest(port, {path: "/app.js", headers: host});
  assert.deepEqual([script.status, script.headers["content-type"], script.body], [200, "application/javascript", "export const ready = true;\n"]);
  assert.ok(nonceOf(script));
  assert.equal((await rawRequest(port, {path: "/data.bin", headers: host})).headers["content-type"], "application/octet-stream");

  const notFound = [404, {message: "Not found."}];
  for (const path of ["/../secret", "/..%2fsecret", "/%2e%2e/secret", "/missing.js"]) {
    const response = await rawRequest(port, {path, headers: host});
    assert.deepEqual([response.status, jsonBody(response)], notFound, path);
  }
  const posted = await rawRequest(port, {method: "POST", path: "/", headers: {...host, "Content-Type": "text/html"}, body: "x"});
  assert.deepEqual([posted.status, jsonBody(posted)], [405, {message: "Method not allowed."}]);
  assert.deepEqual(pickHeaders(posted, Object.keys(securityHeaders)), securityHeaders);
});

it("CT-UI-05: a client disconnect aborts the in-flight handler signal, and ui.close() aborts in-flight requests and resolves", {timeout: 10_000}, async t => {
  const entries: Array<{signal: AbortSignal; aborted: Promise<void>}> = [];
  const entered: Array<() => void> = [];
  const definitions = {load: (_projectId: string, _threadId: string | null, signal: AbortSignal) => {
    const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true}));
    entries.push({signal, aborted});
    entered.shift()?.();
    return new Promise((_resolve, reject) => {void aborted.then(() => reject(new Error("aborted by the request")));});
  }} as unknown as ProjectDefinitionLoader;
  const started = await startUi(t, {definitions});
  const session = await signIn(started.origin, started.directory);
  const start = () => {
    const ready = new Promise<void>(resolve => entered.push(resolve));
    const client = httpRequest({host: "127.0.0.1", port: started.port, path: "/api/guidance/project-configuration?projectId=p", agent: false,
      headers: {"x-supervisor-session": session}});
    const settled = new Promise<string>(resolve => {
      client.once("response", response => {response.resume();response.once("end", () => resolve(`response ${response.statusCode}`));});
      client.once("error", error => resolve(`error ${(error as NodeJS.ErrnoException).code}`));
    });
    client.end();
    return {client, ready, settled};
  };

  const first = start();
  await within(first.ready, 5_000, "handler entry");
  assert.equal(entries[0]!.signal.aborted, false);
  first.client.destroy();
  await within(entries[0]!.aborted, 5_000, "handler signal abort after the client disconnected");
  assert.equal(await within(first.settled, 5_000, "first client settlement"), "error ECONNRESET");

  const second = start();
  await within(second.ready, 5_000, "second handler entry");
  assert.equal(entries[1]!.signal.aborted, false);
  await within(started.close(), 5_000, "ui close with an in-flight request");
  assert.equal(entries[1]!.signal.aborted, true);
  assert.match(await within(second.settled, 5_000, "second client settlement"), /^(?:error ECONNRESET|response \d+)$/u);
  assert.equal(await connectRefused(started.port), true);
});

it("CT-UI-06: a listen failure on the MCP bind host closes the UI listener and the login database before rejecting", {timeout: 10_000}, async t => {
  const directory = await tempDirectory(t, "c3b-listen-");
  const blocker = createNetServer();
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", () => resolve()));
  defer(t, () => new Promise<void>(resolve => blocker.close(() => resolve())));
  const blocked = (blocker.address() as {port: number}).port;
  const uiPort = await freePort();
  const store = new GuidanceStore(directory);
  defer(t, () => store.close());
  const runtimeConfig = uiConfig(directory);
  const runtime = guidanceRuntimeFacade(Effect.runPromise,
    Effect.runSync(GuidanceRuntime.make(runtimeConfig, store, {catalog: () => Effect.succeed({projects: [], threads: []})})), runtimeConfig);
  const login = join(directory, "access", "login.sqlite3");
  assert.equal(openDescriptors(login), 0);

  await assert.rejects(startGuidanceUi(uiConfig(directory, {uiPort, workflowMcpBindHost: "127.0.0.1", workflowMcpPort: blocked}), runtime),
    (error: NodeJS.ErrnoException & {port?: number}) => error.code === "EADDRINUSE" && error.port === blocked);
  assert.equal(existsSync(login), true, "the login database was created before listening");
  assert.equal(openDescriptors(login), 0, "the login database was closed");
  assert.equal(await connectRefused(uiPort), true);
  assert.equal(await portBindable(uiPort), true, "the UI port is reusable");

  // the same configuration starts once the MCP port is free, and its close releases the database again
  await new Promise<void>(resolve => blocker.close(() => resolve()));
  const ui = await startGuidanceUi(uiConfig(directory, {uiPort, workflowMcpBindHost: "127.0.0.1", workflowMcpPort: blocked}), runtime);
  try {assert.equal(openDescriptors(login), 1);}
  finally {await ui.close();}
  assert.equal(openDescriptors(login), 0);
});

it("CT-UI-07: session and CSRF values never reach console or process output during a full request cycle", {timeout: 10_000}, async t => {
  const directory = await tempDirectory(t, "c3b-log-");
  const policy = new ThreadPolicyStore(directory, {excludedThreadIds: []});
  defer(t, () => policy.close());
  const started = await startUi(t, {directory, config: {threadPolicy: policy}});
  const {origin} = started;
  const captured: string[] = [];
  const capture = (...values: unknown[]) => {captured.push(values.map(value => typeof value === "string" ? value : String(value)).join(" "));return true;};
  for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) mockMethod(t, console, name, capture);
  mockMethod(t, process.stdout, "write", capture);
  mockMethod(t, process.stderr, "write", capture);
  console.log("c3b capture probe");

  const session = await signIn(origin, directory);
  const headers = {"x-supervisor-session": session};
  const csrf = await readCsrf(origin, session);
  const exchange = async (path: string, init: RequestInit) => {const response = await fetch(origin + path, init);await response.arrayBuffer();return response.status;};
  const statuses = [
    await exchange("/api/guidance/snapshot", {headers}),
    await exchange("/api/guidance/thread-policy", {method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf},
      body: JSON.stringify({generation: policy.get().generation, excludedThreadIds: ["excluded-thread"]})}),
    await exchange("/api/guidance/thread-policy", {method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf},
      body: JSON.stringify({generation: -1, excludedThreadIds: []})}),
    await exchange("/api/guidance/thread-policy", {method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf}, body: "{"}),
    await exchange("/api/guidance/thread-policy", {method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": "wrong"}, body: "{}"}),
    await exchange("/api/guidance/no-project-control", {headers: {...headers, "x-csrf-token": csrf}}),
    await exchange("/auth/logout", {method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf}, body: "{}"}),
    await exchange("/api/csrf", {headers}),
  ];
  assert.deepEqual(statuses, [200, 200, 400, 400, 403, 400, 200, 401]);
  await started.close();
  assert.deepEqual(captured, ["c3b capture probe"], "the request cycle wrote nothing");
  assert.equal(captured.some(line => line.includes(session) || line.includes(csrf)), false);
});

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

it("CT-UI-08: the HttpApi declares the golden endpoint list, UiError answers 400, and an unknown saveProjectConfiguration field is rejected before the handler", {timeout: 10_000}, async t => {
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
  const editor = {save: async (payload: unknown) => {saves.push(payload);return {status: "invalid", message: "c3b handler reached", definitions: null};}} as unknown as ProjectConfigEditor;
  const {origin, directory} = await startUi(t, {editor});
  const session = await signIn(origin, directory);
  const csrf = await readCsrf(origin, session);
  const headers = {"x-supervisor-session": session};
  const read = async (path: string) => {const response = await fetch(origin + path, {headers});return [response.status, await response.json()];};
  assert.deepEqual(await read("/api/guidance/no-project-control"), [400, {_tag: "UiError", message: "No Project mode unavailable."}]);
  assert.deepEqual(await read("/api/guidance/project-supervisor?projectId=p"), [400, {_tag: "UiError", message: "Project supervision is unavailable. Check the T3 connection and registered project."}]);
  assert.deepEqual(await read("/api/guidance/project-configuration?projectId=p"), [400, {_tag: "UiError", message: "Project definition access is unavailable."}]);

  const save = async (payload: unknown) => {
    const response = await fetch(origin + "/api/guidance/project-configuration", {method: "POST", body: JSON.stringify(payload),
      headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf}});
    const text = await response.text();
    return [response.status, response.headers.get("content-type"), text ? JSON.parse(text) as unknown : text];
  };
  const payload = {projectId: "p", threadId: null, expectedRevision: "a".repeat(64), config: {workflows: [], steps: []}};
  assert.deepEqual(await save(payload), [200, "application/json", {status: "invalid", message: "c3b handler reached", definitions: null}]);
  assert.equal(saves.length, 1);
  // a payload decoding failure answers 400 with an empty body and no content type on effect 4.0.1
  const rejected = [400, null, ""];
  assert.deepEqual(await save({...payload, legacy: true}), rejected);
  assert.deepEqual(await save({...payload, config: {workflows: [], steps: [], required: []}}), rejected);
  assert.deepEqual(await save({...payload, config: {workflows: [], steps: [{path: "steps/a.md", summary: "A", required: false, id: "a"}]}}), rejected);
  assert.equal(saves.length, 1, "no excess-field payload reached the handler");
});
