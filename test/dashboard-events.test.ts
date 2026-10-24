import { SupervisorIds } from "../src/ids.js";
import { NodeCrypto } from "@effect/platform-node";
import { ProjectSupervisorStore } from "../src/project-supervisor-store.js";
import { SupervisionStoresLive } from "../src/supervision-live.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import { openServiceAuth } from "./support/g8-auth.js";
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { NodeHttpClient } from "@effect/platform-node";
import { Clock, Context, Deferred, Effect, Fiber, FileSystem, Layer, PlatformError, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientResponse } from "effect/http";
import { DashboardHint } from "../src/dashboard-events.js";
import { DashboardUpdates } from "../src/dashboard-updates.js";
import { GuidanceDb } from "../src/db.js";
import { GuidanceRuntime } from "../src/guidance.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { guidanceTransaction } from "../src/guidance-sql.js";
import { makeStore, Store } from "../src/store.js";
import { listeners, readCsrf, runtimeOver, signIn, uiConfig, grant, type ListenerOptions } from "./support/g11-dashboard.js";
import { temporaryDirectory } from "./support/g11-stores.js";

const nativeSnapshot = {projects: [{id: "project", title: "Fixture project", workspaceRoot: "/fixture"}], threads: [{id: "main", title: "Fixture main", projectId: "project", archivedAt: null, lineage: {parentThreadId: null, relationshipToParent: null}}], archivedThreads: []};
const fixtureWith = (options: ListenerOptions = {}) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("dashboard-events-");
  const config = uiConfig(directory);
  const updates = yield* DashboardUpdates.make;
  const layer = Layer.succeed(DashboardUpdates, updates);
  const catalog = yield* Layer.build(makeStore(directory).pipe(Layer.provide(layer)));
  const source = Context.get(catalog, Store);
  const services = yield* Layer.build(runtimeOver(config, source).pipe(Layer.provideMerge(layer)));
  const supervision = yield* Layer.build(SupervisionStoresLive.pipe(Layer.provide(Layer.succeedContext(services)), Layer.provide(SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer)))));
  const tasks = Context.get(supervision, ProjectSupervisorStore);
  const runtime = Context.get(services, GuidanceRuntime);
  yield* runtime.markActive;
  yield* source.ingest({stream: "active", item: {kind: "snapshot", snapshotSequence: 0, snapshot: nativeSnapshot}});
  const ui = yield* listeners(config, services, {...options, updates});
  const session = yield* signIn(ui.origin, directory);
  const csrf = yield* readCsrf(ui.origin, session);
  return {...ui, directory, runtime, tasks, updates, source, session, csrf, services, store: Context.get(services, GuidanceStore), db: Context.get(services, GuidanceDb)};
});

const fixture = fixtureWith();
const open = (f: Effect.Success<typeof fixture>, headers: Record<string, string> = {"x-supervisor-session": f.session}, path = "/api/events") => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(f.origin + path, {headers});
});
const decode = (response: HttpClientResponse.HttpClientResponse) => response.stream.pipe(Stream.decodeText, Stream.pipeThroughChannel(Sse.decodeDataSchema(DashboardHint, {maxEventSize: 70_000})));

it.live("real listener sends committed hints, stays idle across collection cycles and closes on revocation", () => Effect.gen(function* () {
  const f = yield* fixture;
  const response = yield* open(f);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"]!, /text\/event-stream/u);
  const pull = yield* Stream.toPull(decode(response));
  assert.equal((yield* pull)[0]?.event, "reset");
  const settings = yield* f.store.settings();
  const started = yield* Clock.currentTimeMillis;
  yield* f.store.saveSettings({...settings, guidancePaused: !settings.guidancePaused});
  assert.equal((yield* pull)[0]?.event, "reset", "a global settings commit invalidates mounted readers");
  const commitToHintMs = (yield* Clock.currentTimeMillis) - started;
  console.log(JSON.stringify({sseCommitToHintMs: commitToHintMs}));
  assert.ok(commitToHintMs < 2_000, `commit-to-hint ${commitToHintMs}ms`);

  const task: TaskRecord = {id: "task", threadId: "main", projectId: "project", sourceRunId: "run", sourceMessageId: "message", sourceHash: "hash",
    status: "needs_context", objective: null, reason: "Discussing", updatedAt: 1, requestText: "Task", supervisorThreadId: "supervisor", messageId: "notice", dispatchedAt: null, replayCount: 0, supervisorRunId: null, sourceOrdinal: 1};
  const transaction = guidanceTransaction(f.db);
  yield* transaction(Effect.gen(function* () {
    yield* f.tasks.saveTask(task);
    yield* f.tasks.saveTask({...task, reason: "Following"});
  }));
  const committed = (yield* pull)[0]!;
  assert.equal(committed.event, "invalidate");
  assert.deepEqual(committed.data.keys, ["snapshot", "overview", "project:project", "progress:project:main"]);
  const idle = yield* Effect.forkChild(pull);
  yield* f.tasks.saveTask({...task, reason: "Following", updatedAt: 2});

  yield* Effect.exit(transaction(Effect.andThen(f.store.saveSettings({...settings, generation: settings.generation + 1}), Effect.fail("rollback"))));
  for (let cycle = 0; cycle < 3; cycle++) {
    yield* f.source.ingest({stream: "active", item: {kind: "snapshot", snapshotSequence: cycle + 1, snapshot: nativeSnapshot}});
    const client = yield* HttpClient.HttpClient;
    yield* (yield* client.get(f.origin + "/api/guidance/snapshot", {headers: {"x-supervisor-session": f.session}})).json;
    yield* f.runtime.markActive;
    yield* f.store.settings();
    yield* transaction(f.store.settings());
    if (cycle < 2) yield* Effect.sleep("5 seconds");
    assert.ok(idle.pollUnsafe() === undefined, "rollback, reads and identical native collection send no hint");
  }
  yield* f.updates.publish(["overview"]);
  assert.deepEqual((yield* Fiber.join(idle))[0]?.data.keys, ["overview"]);
  const ended = yield* Effect.forkChild(Effect.exit(pull));
  const client = yield* HttpClient.HttpClient;
  const logout = yield* client.post(f.origin + "/auth/logout", {headers: {origin: f.origin, "x-supervisor-session": f.session, "x-csrf-token": f.csrf, "content-type": "application/json"}});
  assert.equal(logout.status, 200);
  yield* Fiber.join(ended).pipe(Effect.timeout("2 seconds"));
  const revoked = yield* open(f);
  assert.equal(revoked.status, 401);
}).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layerFetch)), {timeout: 25_000});

it.live("events reject missing credentials and URL tokens; reconnect begins with reset", () => Effect.gen(function* () {
  const f = yield* fixture;
  assert.equal((yield* open(f, {})).status, 401);
  assert.equal((yield* open(f, {"x-supervisor-session": "invalid"})).status, 401);
  assert.equal((yield* open(f, {}, "/api/events?session=not-a-session")).status, 401);
  assert.equal((yield* open(f, {"x-supervisor-session": f.session}, "/api/events?session=not-a-session")).status, 401);
  for (let connection = 0; connection < 2; connection++) yield* Effect.scoped(Effect.gen(function* () {
    const response = yield* open(f, {"x-supervisor-session": f.session, "last-event-id": "old-cursor"});
    const pull = yield* Stream.toPull(decode(response));
    assert.equal((yield* pull)[0]?.event, "reset");
  }));
}).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layerFetch)));

it.live("an already-open stream closes on another access client's revocation and on session expiry", () => Effect.gen(function* () {
  const f = yield* fixture;
  const other = yield* openServiceAuth(f.directory).pipe(Effect.provide(NodeFileSystem.layer));
  yield* Effect.scoped(Effect.gen(function* () {
    const pull = yield* Stream.toPull(decode(yield* open(f)));
    assert.equal((yield* pull)[0]?.event, "reset");
    const ended = yield* Effect.forkChild(Effect.exit(pull));
    yield* other.logout(f.session);
    yield* Fiber.join(ended).pipe(Effect.timeout("2 seconds"));
    assert.equal((yield* open(f)).status, 401);
  }));
  const session = yield* signIn(f.origin, f.directory);
  // the disposable session gets a short, valid deadline before admission; the service reads its real persisted expiry
  yield* Effect.sync(() => {
    const db = new DatabaseSync(join(f.directory, "access", "login.sqlite3"));
    try {db.prepare("UPDATE dashboard_login_sessions SET expires_at=?").run(Date.now() + 300);} finally {db.close();}
  });
  const pull = yield* Stream.toPull(decode(yield* open(f, {"x-supervisor-session": session})));
  assert.equal((yield* pull)[0]?.event, "reset");
  yield* Effect.exit(pull).pipe(Effect.timeout("2 seconds"));
  assert.equal((yield* open(f, {"x-supervisor-session": session})).status, 401);
}).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layerFetch)), {timeout: 10_000});

it.live("a failing revocation watch closes event streams while valid dashboard and MCP authentication remain available", () => Effect.gen(function* () {
  const failWatch = yield* Deferred.make<void>();
  let auth: import("../src/service-auth.js").ServiceAuth["Service"] | undefined;
  const f = yield* fixtureWith({auth: real => {auth = real; return real;}, files: real => ({...real, watch: () => Stream.fromEffect(Deferred.await(failWatch)).pipe(
    Stream.flatMap(() => Stream.fail(PlatformError.badArgument({module: "FileSystem", method: "watch", description: "fixture watch failure"}))))})});
  const pull = yield* Stream.toPull(decode(yield* open(f)));
  assert.equal((yield* pull)[0]?.event, "reset");
  const ended = yield* Effect.forkChild(Effect.exit(pull));
  yield* Deferred.succeed(failWatch, undefined);
  yield* Fiber.join(ended).pipe(Effect.timeout("2 seconds"));
  assert.ok(auth);
  assert.equal(yield* auth.authenticated(f.session), true);
  const fs = yield* FileSystem.FileSystem;
  const token = (yield* fs.readFileString(join(f.directory, "access", "workflow-mcp-token"))).trim();
  assert.equal(auth.mcpAuthorized(`Bearer ${token}`), true, "MCP remains authenticated");
  const second = yield* auth.login(yield* grant(f.directory));
  assert.ok(second, "login remains available");
  const response = yield* open(f, {"x-supervisor-session": f.session}, "/auth/status");
  assert.equal(response.status, 200); assert.deepEqual(yield* response.json, {authenticated: true});
  // retry gets a short successful stream, never a 401 that would clear the browser's valid session
  const retry = yield* open(f); assert.equal(retry.status, 200);
  yield* Stream.runDrain(retry.stream).pipe(Effect.timeout("2 seconds"));
}).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layerFetch), Effect.provide(NodeFileSystem.layer)), {timeout: 8_000});
