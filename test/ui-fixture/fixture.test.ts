import { describe, it } from "@effect/vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Effect, Exit, Fiber, FileSystem, Schema, Scope } from "effect";
import { DashboardOverview } from "../../src/dashboard-overview.js";
import { Snapshot } from "../../src/guidance-contract.js";
import { ProjectConfigSaveResult, ProjectDefinitions, type ProjectConfigurationInfo } from "../../src/project-definitions-contract.js";
import { ProjectSupervisorSaveResult, ProjectSupervisorSnapshot } from "../../src/project-supervisor-contract.js";
import {
  GlobalDefinitionsControl, GlobalDefinitionsControlResult, NoProjectControl, NoProjectControlResult, SupervisionCandidates, SupervisionControl,
  SupervisionControlResult, SupervisionSetupOptions, SupervisionSetupResult, SupervisionStartStatus,
} from "../../src/supervisor-control-contract.js";
import { ThreadPolicy } from "../../src/thread-policy-contract.js";
import { WorkflowProgressSnapshotSchema } from "../../src/workflow-progress.js";
import { fixtureIds, fixtureToken } from "./scenarios.js";
import { startUiFixture, type LogEntry, type UiFixture } from "./server.js";

type Reply = {status: number; headers: IncomingHttpHeaders; body: Buffer; json: <T = unknown>() => T};
type Call = {method?: string; path: string; headers?: Record<string, string>; body?: string};

const A = fixtureIds.projectA;
const B = fixtureIds.projectB;
const paths = {
  snapshot: "/api/guidance/snapshot",
  noProject: "/api/guidance/no-project-control",
  configuration: "/api/guidance/project-configuration",
  setup: "/api/guidance/supervision-setup",
  threadPolicy: "/api/guidance/thread-policy",
};
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

// the suite talks to the fixture over real loopback sockets and writes its assets to temp directories, so its tests are
// it.live; the native http client and net sockets are its adapters, since the cases set exact headers on connections
// without an agent, probe raw connects, and one case traps fetch and every socket connect

// one request on its own loopback connection; interrupting the call destroys its connection
const call = (port: number, input: Call) => Effect.callback<Reply, Error>((resume) => {
  const outgoing = request({host: "127.0.0.1", port, path: input.path, method: input.method ?? "GET", agent: false, headers: input.headers ?? {}}, response => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("error", error => resume(Effect.fail(error)));
    response.on("end", () => {
      const body = Buffer.concat(chunks);
      resume(Effect.succeed({status: response.statusCode ?? 0, headers: response.headers, body, json: <T = unknown>() => JSON.parse(body.toString("utf8")) as T}));
    });
  });
  outgoing.on("error", error => resume(Effect.fail(error)));
  outgoing.end(input.body);
  return Effect.sync(() => outgoing.destroy());
});

const connects = (host: string, port: number) => Effect.callback<boolean>(resume => {
  const socket = net.connect({host, port});
  socket.once("connect", () => {socket.destroy();resume(Effect.succeed(true));});
  socket.once("error", () => resume(Effect.succeed(false)));
  return Effect.sync(() => socket.destroy());
});

// a fixture in its own scope, which the test closes as its own step; the test's scope closes it otherwise
const open = (assets: string) => Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const fixture = yield* startUiFixture({assets}).pipe(Scope.provide(scope));
  return {fixture, close: Scope.close(scope, Exit.void)};
});

const withFixture = <E>(assets: string, use: (fixture: UiFixture) => Effect.Effect<void, E>) =>
  Effect.scoped(Effect.flatMap(startUiFixture({assets}), use));

// the elapsed milliseconds since a monotonic start
const elapsedSince = (started: bigint) => Effect.map(Clock.monotonicTimeNanos, now => Number(now - started) / 1_000_000);

// the asset directories of a test, removed when its scope closes
const makeAssets = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({prefix: "ui-fixture-test-"});
  const dir = join(root, "assets-dir");
  yield* fs.makeDirectory(join(dir, "assets", "nested"), {recursive: true});
  const files: Record<string, Buffer> = {
    "index.html": Buffer.from("<!doctype html><html><head><script type=\"module\" crossorigin src=\"/assets/app.js\"></script><link rel=\"stylesheet\" href=\"/assets/app.css\"></head><body><div id=\"root\"></div></body></html>"),
    "assets/app.js": Buffer.from("console.log(\"fixture asset\");\n"),
    "assets/app.css": Buffer.from("body{color:#202944}\n"),
    "assets/nested/mark.svg": Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
    "icon.png": Buffer.from(Array.from({length: 256}, (_, index) => index)),
    "data.bin": Buffer.from([0, 255, 13, 10]),
  };
  for (const [path, bytes] of Object.entries(files)) yield* fs.writeFile(join(dir, path), bytes);
  yield* fs.writeFileString(join(root, "secret.txt"), "outside the asset directory");
  return {dir, files};
});

const client = (fixture: UiFixture) => {
  const origin = fixture.url.slice(0, -1);
  let session = "";
  let csrf = "";
  return {
    origin,
    get session() {return session;},
    get csrf() {return csrf;},
    raw: (input: Call) => call(fixture.port, input),
    control: (path: string, method = "POST") => call(fixture.port, {method, path}),
    signIn: Effect.gen(function* () {
      const login = yield* call(fixture.port, {method: "POST", path: "/auth/login", headers: {origin, "content-type": "application/json"}, body: JSON.stringify({token: fixtureToken})});
      assert.equal(login.status, 200);
      session = login.json<{session: string}>().session;
      const access = yield* call(fixture.port, {path: "/api/csrf", headers: {"x-supervisor-session": session}});
      assert.equal(access.status, 200);
      csrf = access.json<{csrf: string}>().csrf;
    }),
    get: (path: string) => call(fixture.port, {path, headers: {"x-supervisor-session": session}}),
    post: (path: string, payload: unknown) => call(fixture.port, {method: "POST", path, body: JSON.stringify(payload),
      headers: {origin, "content-type": "application/json", "x-supervisor-session": session, "x-csrf-token": csrf}}),
  };
};
type Client = ReturnType<typeof client>;

const scenario = (c: Client, name: string, query = "") => Effect.map(c.control(`/__fixture/scenario/${name}${query}`), reply => {
  assert.equal(reply.status, 200, `scenario ${name}`);
});
const definitionsOf = (c: Client, projectId = A) => Effect.map(c.get(`${paths.configuration}?projectId=${projectId}`), reply => Schema.decodeUnknownSync(ProjectDefinitions)(reply.json()));
const noProjectOf = (c: Client) => Effect.map(c.get(paths.noProject), reply => Schema.decodeUnknownSync(NoProjectControl)(reply.json()));
const editedConfig = (config: ProjectConfigurationInfo, summary: string): ProjectConfigurationInfo =>
  ({...config, steps: config.steps.map((entry, index) => index === 0 ? {...entry, summary} : entry)});
const outcomeOf = (reply: Effect.Effect<Reply, Error>) => Effect.match(reply, {onSuccess: reply => `answered-${reply.status}`, onFailure: () => "connection-closed"});

// a scripted pass over every scenario; it returns only stable outcomes so two passes can be compared
const scenarioScript = (fixture: UiFixture) => Effect.gen(function* () {
  const c = client(fixture);
  const outcomes: string[] = [];
  const note = (label: string, detail: string | number | boolean) => outcomes.push(`${label}:${detail}`);
  yield* c.signIn;

  for (const status of [401, 403, 409, 413]) {
    yield* scenario(c, `save-${status}`);
    const reply = yield* c.post(paths.noProject, {expectedGeneration: 1, mode: "automatic"});
    note(`save-${status}`, `${reply.status}:${reply.json<{message: string}>().message}`);
    if (status === 401) {
      note("save-401-revoked", (yield* c.get(paths.snapshot)).status);
      yield* c.signIn;
    }
  }
  note("status-scenarios-not-applied", (yield* noProjectOf(c)).generation);

  const before = yield* definitionsOf(c);
  const save = (revision: string, summary: string) => c.post(paths.configuration, {projectId: A, threadId: null, expectedRevision: revision, config: editedConfig(before.projectConfig!, summary)});
  yield* scenario(c, "editor-conflict");
  note("editor-conflict", Schema.decodeUnknownSync(ProjectConfigSaveResult)((yield* save(before.revision!, "Fixture step: conflict draft.")).json()).status);
  yield* scenario(c, "editor-uncertain");
  note("editor-uncertain", Schema.decodeUnknownSync(ProjectConfigSaveResult)((yield* save(before.revision!, "Fixture step: uncertain draft.")).json()).status);
  note("editor-uncertain-applied", (yield* definitionsOf(c)).revision !== before.revision);
  yield* scenario(c, "editor-uncertain", "?apply=1");
  note("editor-uncertain-apply", Schema.decodeUnknownSync(ProjectConfigSaveResult)((yield* save(before.revision!, "Fixture step: applied draft.")).json()).status);
  note("editor-uncertain-apply-applied", (yield* definitionsOf(c)).revision !== before.revision);

  yield* scenario(c, "session-expiry-next-call");
  note("expiry-first", (yield* c.get(paths.snapshot)).status);
  note("expiry-second", (yield* c.get(paths.snapshot)).status);
  yield* c.signIn;
  note("expiry-after-sign-in", (yield* c.get(paths.snapshot)).status);

  const other = client(fixture);
  yield* other.signIn;
  yield* scenario(c, "signout-other-tab");
  note("signout-this-tab", (yield* c.get(paths.snapshot)).status);
  note("signout-other-tab", (yield* other.get(paths.snapshot)).status);
  yield* c.signIn;

  yield* scenario(c, "slow-reads", "?ms=300");
  let started = yield* Clock.monotonicTimeNanos;
  note("slow-read", `${(yield* c.get(paths.snapshot)).status}:${(yield* elapsedSince(started)) >= 290}`);
  note("slow-read-again", `${(yield* c.get(paths.snapshot)).status}:${(yield* elapsedSince(started)) >= 580}`);
  yield* scenario(c, "baseline");
  started = yield* Clock.monotonicTimeNanos;
  note("baseline-read", `${(yield* c.get(paths.snapshot)).status}:${(yield* elapsedSince(started)) < 250}`);

  const options = Schema.decodeUnknownSync(SupervisionSetupOptions)((yield* c.get(`${paths.setup}?projectId=${B}`)).json());
  const checkout = options.checkouts[0]!;
  yield* scenario(c, "setup-race", "?ms=400");
  started = yield* Clock.monotonicTimeNanos;
  const setup = yield* Effect.forkChild(c.post(paths.setup, {projectId: B, expectedGeneration: options.generation, origin: "project", threadId: checkout.threadId,
    expectedWorkspaceRoot: checkout.workspaceRoot, expectedBranch: checkout.branch, action: "create"}), {startImmediately: true});
  yield* Effect.sleep("100 millis");
  note("setup-read-during-race", Schema.decodeUnknownSync(SupervisionSetupOptions)((yield* c.get(`${paths.setup}?projectId=${B}`)).json()).checkouts[0]!.folderStatus);
  const setupReply = yield* Fiber.join(setup);
  note("setup-race", `${Schema.decodeUnknownSync(SupervisionSetupResult)(setupReply.json()).status}:${(yield* elapsedSince(started)) >= 390}`);

  const generation = (yield* noProjectOf(c)).generation;
  yield* scenario(c, "mutation-dropped", `?path=${paths.noProject}`);
  note("dropped", yield* outcomeOf(c.post(paths.noProject, {expectedGeneration: generation, mode: "automatic"})));
  note("dropped-generation-delta", (yield* noProjectOf(c)).generation - generation);
  yield* scenario(c, "mutation-dropped", `?path=${paths.noProject}&apply=1`);
  note("dropped-after-apply", yield* outcomeOf(c.post(paths.noProject, {expectedGeneration: generation, mode: "automatic"})));
  note("dropped-after-apply-generation-delta", (yield* noProjectOf(c)).generation - generation);

  yield* scenario(c, "mutation-never-answered", `?path=${paths.noProject}`);
  let settled = false;
  const held = yield* Effect.forkChild(c.post(paths.noProject, {expectedGeneration: generation + 1, mode: "off"}).pipe(Effect.ensuring(Effect.sync(() => {settled = true;}))),
    {startImmediately: true});
  yield* Effect.sleep("300 millis");
  note("held-still-pending", !settled);
  note("held-count", (yield* c.control("/__fixture/state", "GET")).json<{held: unknown[]}>().held.length);
  note("held-release", (yield* c.control("/__fixture/held/answer")).status);
  note("held-answer", Schema.decodeUnknownSync(NoProjectControlResult)((yield* Fiber.join(held)).json()).status);
  return outcomes;
});

describe("CT-UI-FIXTURE-01 ui baseline fixture", () => {
  it.live("binds only 127.0.0.1 on an ephemeral port and serves the asset directory byte-identical", () => Effect.gen(function* () {
    const assets = yield* makeAssets;
    yield* withFixture(assets.dir, fixture => Effect.gen(function* () {
      yield* withFixture(assets.dir, second => Effect.gen(function* () {
        assert.notEqual(fixture.port, second.port);
        assert.ok(fixture.port > 0 && second.port > 0);
      }));
      assert.equal(fixture.url, `http://127.0.0.1:${fixture.port}/`);
      assert.equal(yield* connects("127.0.0.1", fixture.port), true);
      assert.equal(yield* connects("::1", fixture.port), false);
      for (const address of Object.values(networkInterfaces()).flat())
        if (address && !address.internal && address.family === "IPv4") assert.equal(yield* connects(address.address, fixture.port), false, address.address);

      assert.deepEqual(fixture.assets.map(asset => [asset.path, asset.bytes, asset.sha256]),
        Object.entries(assets.files).map(([path, bytes]) => [path, bytes.length, sha256(bytes)]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
      const types: Record<string, string> = {html: "text/html; charset=utf-8", js: "application/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", bin: "application/octet-stream"};
      for (const [path, bytes] of Object.entries(assets.files)) {
        const reply = yield* call(fixture.port, {path: `/${path}`});
        assert.equal(reply.status, 200, path);
        assert.ok(reply.body.equals(bytes), path);
        assert.equal(reply.headers["content-type"], types[path.split(".").at(-1)!]);
        assert.equal(reply.headers["cache-control"], "no-store");
      }
      const index = yield* call(fixture.port, {path: "/"});
      assert.ok(index.body.equals(assets.files["index.html"]!));
      assert.doesNotMatch(index.body.toString("utf8"), /nonce/u);
      assert.match(String(index.headers["content-security-policy"]), /script-src 'self'/u);
      for (const path of ["/missing.js", "/assets", "/..%2fsecret.txt", "/projects/fixture-project-a/definitions"])
        assert.equal((yield* call(fixture.port, {path})).status, 404, path);
      assert.equal((yield* call(fixture.port, {method: "POST", path: "/"})).status, 405);
      assert.equal((yield* call(fixture.port, {path: "/api/unknown"})).status, 401);
    }));
  }).pipe(Effect.provide(NodeFileSystem.layer)), 20_000);

  it.live("answers the API only from fixture data decoded through the SupervisorApi schemas and mirrors the baseline auth checks", () => Effect.gen(function* () {
    const assets = yield* makeAssets;
    yield* withFixture(assets.dir, fixture => Effect.gen(function* () {
      const c = client(fixture);
      assert.equal((yield* c.get(paths.snapshot)).status, 401);
      assert.equal((yield* c.raw({path: "/", headers: {host: `localhost:${fixture.port}`}})).status, 403);
      assert.equal((yield* c.raw({path: "/", headers: {origin: "http://evil.example"}})).status, 403);
      assert.equal((yield* c.raw({path: "/", headers: {"sec-fetch-site": "cross-site"}})).status, 403);
      const login = (headers: Record<string, string>, token: string) => c.raw({method: "POST", path: "/auth/login", headers, body: JSON.stringify({token})});
      assert.equal((yield* login({origin: c.origin, "content-type": "application/json"}, "wrong-token")).status, 401);
      assert.equal((yield* login({"content-type": "application/json"}, fixtureToken)).status, 403);
      assert.equal((yield* login({origin: c.origin, "content-type": "text/plain"}, fixtureToken)).status, 403);
      assert.equal((yield* c.raw({method: "GET", path: "/auth/login"})).status, 404);
      yield* c.signIn;
      assert.match(c.session, /^[A-Za-z0-9_-]{43}$/u);
      assert.deepEqual((yield* c.raw({path: "/auth/status", headers: {"x-supervisor-session": c.session}})).json(), {authenticated: true});

      const snapshot = Schema.decodeUnknownSync(Snapshot)((yield* c.get(paths.snapshot)).json());
      assert.ok(snapshot.projects.some(project => project.title === "Fixture project A"));
      assert.ok([...snapshot.projects, ...snapshot.threads].every(item => item.title.startsWith("Fixture")));
      yield* c.control("/__fixture/scenario/large-interface");
      const search = Schema.decodeUnknownSync(DashboardOverview)((yield* c.get("/api/guidance/dashboard-overview?q=Fixture%20146&limit=25&offset=0")).json());
      assert.equal(search.total, 1); assert.equal(search.availableTotal, 149); assert.equal(search.work[0]?.mainThreadId, "fixture-long-146");
      assert.equal(search.projects.length, 2, "project coverage remains independent of query results");
      yield* c.control("/__fixture/reset");
      yield* c.signIn;
      const reads: Array<[string, Schema.Top]> = [
        ["/api/guidance/dashboard-overview", DashboardOverview],
        [paths.noProject, NoProjectControl],
        ["/api/guidance/supervision-candidates?purpose=start", SupervisionCandidates],
        [`/api/guidance/supervision-start?threadId=${fixtureIds.threadN1}&operationId=unknown`, SupervisionStartStatus],
        ["/api/guidance/supervision-control", SupervisionControl],
        [`/api/guidance/supervision-control?projectId=${A}`, SupervisionControl],
        [`${paths.setup}?projectId=${B}`, SupervisionSetupOptions],
        ["/api/guidance/global-definitions-control", GlobalDefinitionsControl],
        [`/api/guidance/project-supervisor?projectId=${A}&mainThreadId=${fixtureIds.threadA1}`, ProjectSupervisorSnapshot],
        [`/api/guidance/project-supervisor?projectId=${A}`, ProjectSupervisorSnapshot],
        [`/api/guidance/workflow-progress?projectId=${A}&mainThreadId=${fixtureIds.threadA1}`, WorkflowProgressSnapshotSchema],
        [`${paths.configuration}?projectId=${A}`, ProjectDefinitions],
        [`${paths.configuration}?projectId=${A}&threadId=${fixtureIds.threadA1}`, ProjectDefinitions],
      ];
      for (const [path, schema] of reads) {
        const reply = yield* c.get(path);
        assert.equal(reply.status, 200, path);
        Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>)(reply.json());
      }
      assert.equal((yield* c.get("/api/guidance/project-supervisor?projectId=unknown")).status, 400);

      assert.equal((yield* c.raw({method: "POST", path: paths.noProject, body: "{}", headers: {origin: c.origin, "content-type": "application/json", "x-supervisor-session": c.session}})).status, 403);
      assert.equal((yield* c.raw({method: "POST", path: paths.noProject, body: "{}", headers: {origin: c.origin, "content-type": "text/plain", "x-supervisor-session": c.session, "x-csrf-token": c.csrf}})).status, 415);
      assert.equal((yield* c.post(paths.threadPolicy, {generation: 1, excludedThreadIds: ["x".repeat(65_000)]})).status, 413);

      const decodeSaved = (schema: Schema.Codec<{readonly status: string}, unknown>, reply: Reply) => {
        assert.equal(reply.status, 200);
        return Schema.decodeUnknownSync(schema)(reply.json()).status;
      };
      assert.equal(decodeSaved(NoProjectControlResult, yield* c.post(paths.noProject, {expectedGeneration: 1, mode: "automatic"})), "saved");
      const start = {threadId: fixtureIds.threadN1, operationId: "fixture-operation-1"};
      assert.equal(decodeSaved(SupervisionStartStatus, yield* c.post("/api/guidance/supervision-start", start)), "active");
      assert.equal(Schema.decodeUnknownSync(SupervisionStartStatus)((yield* c.get(`/api/guidance/supervision-start?threadId=${start.threadId}&operationId=${start.operationId}`)).json()).status, "active");
      assert.equal(decodeSaved(SupervisionControlResult, yield* c.post("/api/guidance/supervision-control", {projectId: B, expectedGeneration: 1, enabled: true})), "setup_required");
      const options = Schema.decodeUnknownSync(SupervisionSetupOptions)((yield* c.get(`${paths.setup}?projectId=${B}`)).json());
      assert.equal(decodeSaved(SupervisionSetupResult, yield* c.post(paths.setup, {projectId: B, expectedGeneration: options.generation, origin: "project", threadId: null,
        expectedWorkspaceRoot: "/fixture/project-b", expectedBranch: "main", action: "create"})), "saved");
      assert.equal(Schema.decodeUnknownSync(SupervisionControl)((yield* c.get(`/api/guidance/supervision-control?projectId=${B}`)).json()).effectiveEnabled, true);
      assert.equal(decodeSaved(GlobalDefinitionsControlResult, yield* c.post("/api/guidance/global-definitions-control", {expectedGeneration: 1, enabled: true})), "saved");
      assert.equal(decodeSaved(ProjectSupervisorSaveResult, yield* c.post("/api/guidance/project-supervisor", {projectId: A, mainThreadId: fixtureIds.threadA1, expectedGeneration: 1,
        modelSelection: {instanceId: "fixture-provider", model: "fixture-model-quick", options: [{id: "reasoningEffort", value: "high"}]},
        monitoring: {intervalMinutes: 2, activityThreshold: 12}, teamSettings: {maxHelpersPerRoot: 3}})), "saved");
      assert.equal(decodeSaved(ProjectSupervisorSaveResult, yield* c.post("/api/guidance/project-supervisor/retry", {projectId: A, mainThreadId: fixtureIds.threadA2,
        expectedGeneration: 2, threadId: "fixture-supervisor-a2", bindingGeneration: 1, action: "retry"})), "saved");
      const chat = Schema.decodeUnknownSync(ProjectSupervisorSnapshot)((yield* c.get(`/api/guidance/project-supervisor?projectId=${A}&mainThreadId=${fixtureIds.threadA1}`)).json());
      const stopped = yield* c.post("/api/guidance/project-supervisor/chat-supervision", {projectId: A, mainThreadId: fixtureIds.threadA1, enabled: false,
        policyGeneration: chat.chatSupervision!.policyGeneration});
      assert.equal(Schema.decodeUnknownSync(ProjectSupervisorSaveResult)(stopped.json()).snapshot?.chatSupervision?.stopped, true);
      const definitions = yield* definitionsOf(c);
      const saved = Schema.decodeUnknownSync(ProjectConfigSaveResult)((yield* c.post(paths.configuration, {projectId: A, threadId: null, expectedRevision: definitions.revision,
        config: {...definitions.projectConfig!, steps: [...definitions.projectConfig!.steps, {path: "steps/fixture-unindexed.md", summary: "Fixture step: indexed by the test.", required: false}]}})).json());
      assert.equal(saved.status, "saved");
      assert.notEqual(saved.definitions?.revision, definitions.revision);
      const policy = Schema.decodeUnknownSync(ThreadPolicy)((yield* c.post(paths.threadPolicy, {...snapshot.threadPolicy, generation: Schema.decodeUnknownSync(Snapshot)((yield* c.get(paths.snapshot)).json()).threadPolicy.generation, excludedThreadIds: []})).json());
      assert.deepEqual(policy.excludedThreadIds, []);

      assert.deepEqual((yield* c.raw({method: "POST", path: "/auth/logout", body: "{}", headers: {origin: c.origin, "content-type": "application/json", "x-supervisor-session": c.session}})).json(), {authenticated: false});
      assert.equal((yield* c.get(paths.snapshot)).status, 401);
    }));
  }).pipe(Effect.provide(NodeFileSystem.layer)), 20_000);

  it.live("never opens a connection to a non-loopback host", () => Effect.gen(function* () {
    const assets = yield* makeAssets;
    const prototype = net.Socket.prototype as unknown as {connect: (...args: unknown[]) => unknown};
    const targets: string[] = [];
    const fetches: string[] = [];
    // every socket connect and fetch is trapped while the fixture runs and put back before the targets are checked
    yield* Effect.scoped(Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.sync(() => {
        const connect = prototype.connect;
        const originalFetch = globalThis.fetch;
        prototype.connect = function (this: unknown, ...args: unknown[]) {
          const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
          targets.push(typeof first === "object" && first !== null ? String((first as {host?: unknown; path?: unknown}).host ?? (first as {path?: unknown}).path ?? "localhost")
            : typeof first === "number" ? String(args[1] ?? "localhost") : String(first));
          return connect.apply(this, args);
        };
        globalThis.fetch = (input => {fetches.push(String(input));return Promise.reject(new Error("fetch is trapped in this test"));}) as typeof fetch;
        return {connect, originalFetch};
      }), ({connect, originalFetch}) => Effect.sync(() => {
        prototype.connect = connect;
        globalThis.fetch = originalFetch;
      }));
      yield* withFixture(assets.dir, fixture => Effect.gen(function* () {
        const c = client(fixture);
        yield* c.signIn;
        for (const path of [paths.snapshot, "/api/guidance/dashboard-overview", `/api/guidance/project-supervisor?projectId=${A}&mainThreadId=${fixtureIds.threadA1}`, `${paths.configuration}?projectId=${A}`])
          assert.equal((yield* c.get(path)).status, 200);
        assert.equal((yield* c.post(paths.noProject, {expectedGeneration: 1, mode: "off"})).status, 200);
        yield* scenario(c, "mutation-dropped");
        assert.equal(yield* outcomeOf(c.post(paths.noProject, {expectedGeneration: 2, mode: "automatic"})), "connection-closed");
        assert.equal((yield* c.raw({path: "/"})).status, 200);
      }));
    }));
    assert.ok(targets.length > 0);
    assert.deepEqual([...new Set(targets)], ["127.0.0.1"]);
    assert.deepEqual(fetches, []);
  }).pipe(Effect.provide(NodeFileSystem.layer)), 20_000);

  it.live("labels every response with the active scenario", () => Effect.gen(function* () {
    const assets = yield* makeAssets;
    yield* withFixture(assets.dir, fixture => Effect.gen(function* () {
      const c = client(fixture);
      const replies: Reply[] = [
        yield* c.raw({path: "/"}), yield* c.raw({path: "/missing"}), yield* c.raw({method: "POST", path: "/"}), yield* c.get(paths.snapshot),
        yield* c.raw({path: "/", headers: {host: "localhost"}}), yield* c.raw({path: "/auth/status"}), yield* c.raw({path: "/auth/unknown"}),
        yield* c.control("/__fixture/scenario/unknown"), yield* c.control("/__fixture/scenario/baseline?ms=x"), yield* c.control("/__fixture/state", "GET"),
      ];
      yield* c.signIn;
      replies.push(yield* c.get(paths.snapshot), yield* c.post(paths.noProject, {expectedGeneration: 99, mode: "off"}), yield* c.get("/api/guidance/project-supervisor?projectId=unknown"));
      assert.deepEqual(new Set(replies.map(reply => reply.status)), new Set([200, 400, 401, 403, 404, 405]));
      for (const reply of replies) assert.equal(reply.headers["x-supervisor-fixture"], "baseline");
      yield* scenario(c, "reload");
      for (const reply of [yield* c.raw({path: "/"}), yield* c.get(paths.snapshot), yield* c.raw({path: "/auth/status"})]) assert.equal(reply.headers["x-supervisor-fixture"], "reload");
      yield* c.control("/__fixture/reset");
      assert.equal((yield* c.raw({path: "/"})).headers["x-supervisor-fixture"], "baseline");
    }));
  }).pipe(Effect.provide(NodeFileSystem.layer)), 20_000);

  it.live("applies every scenario deterministically and reset restores the initial fixture state", () => Effect.gen(function* () {
    const assets = yield* makeAssets;
    yield* withFixture(assets.dir, fixture => Effect.gen(function* () {
      const c = client(fixture);
      yield* c.signIn;
      const initial = yield* definitionsOf(c);
      const first = yield* scenarioScript(fixture);
      assert.equal((yield* c.control("/__fixture/reset")).status, 200);
      const second = yield* scenarioScript(fixture);
      assert.deepEqual(second, first);
      assert.deepEqual(first, [
        "save-401:401:Sign in to Supervisor.", "save-401-revoked:401",
        "save-403:403:Refresh the local dashboard before changing settings.",
        "save-409:409:Fixture: synthetic http 409; the baseline server never sends this status.",
        "save-413:413:The request payload is too large. Reduce its size before retrying.",
        "status-scenarios-not-applied:1",
        "editor-conflict:conflict", "editor-uncertain:uncertain", "editor-uncertain-applied:false",
        "editor-uncertain-apply:uncertain", "editor-uncertain-apply-applied:true",
        "expiry-first:401", "expiry-second:401", "expiry-after-sign-in:200",
        "signout-this-tab:401", "signout-other-tab:401",
        "slow-read:200:true", "slow-read-again:200:true", "baseline-read:200:true",
        "setup-read-during-race:present", "setup-race:saved:true",
        "dropped:connection-closed", "dropped-generation-delta:0", "dropped-after-apply:connection-closed", "dropped-after-apply-generation-delta:1",
        "held-still-pending:true", "held-count:1", "held-release:200", "held-answer:saved",
      ]);
      const reset = yield* c.control("/__fixture/reset");
      assert.deepEqual(reset.json(), {reset: true, scenario: "baseline", armed: [], sessions: 0, held: []});
      assert.equal((yield* c.get(paths.snapshot)).status, 401);
      yield* c.signIn;
      assert.equal((yield* definitionsOf(c)).revision, initial.revision);
      assert.equal((yield* noProjectOf(c)).generation, 1);
      assert.equal(Schema.decodeUnknownSync(SupervisionSetupOptions)((yield* c.get(`${paths.setup}?projectId=${B}`)).json()).checkouts[0]!.folderStatus, "missing");
      const log = (yield* c.control("/__fixture/log", "GET")).json<{entries: LogEntry[]}>();
      assert.equal(log.entries[0]!.path, "/__fixture/reset");
    }));
  }).pipe(Effect.provide(NodeFileSystem.layer)), 30_000);

  it.live("logs each mutation post once with its body hash and never the raw body or secrets", () => Effect.gen(function* () {
    const assets = yield* makeAssets;
    yield* withFixture(assets.dir, fixture => Effect.gen(function* () {
      const c = client(fixture);
      yield* c.signIn;
      const sent: Array<{path: string; body: string}> = [{path: "/auth/login", body: JSON.stringify({token: fixtureToken})}];
      const post = (path: string, payload: unknown) => {sent.push({path, body: JSON.stringify(payload)});return c.post(path, payload);};
      for (let poll = 0; poll < 3; poll++) assert.equal((yield* c.get(paths.snapshot)).status, 200);
      const marker = "Fixture raw body marker 7f3c";
      const definitions = yield* definitionsOf(c);
      assert.equal((yield* post(paths.configuration, {projectId: A, threadId: null, expectedRevision: definitions.revision, config: editedConfig(definitions.projectConfig!, marker)})).status, 200);
      yield* scenario(c, "save-403");
      assert.equal((yield* post(paths.threadPolicy, {generation: 1, excludedThreadIds: []})).status, 403);
      yield* scenario(c, "mutation-dropped", `?path=${paths.noProject}`);
      assert.equal(yield* outcomeOf(post(paths.noProject, {expectedGeneration: 1, mode: "off"})), "connection-closed");
      yield* scenario(c, "mutation-never-answered", `?path=${paths.noProject}`);
      const held = yield* Effect.forkChild(post(paths.noProject, {expectedGeneration: 1, mode: "automatic"}), {startImmediately: true});
      let entries: LogEntry[] = [];
      for (let attempt = 0; attempt < 50 && !entries.some(entry => entry.result === "held"); attempt++) {
        yield* Effect.sleep("20 millis");
        entries = (yield* c.control("/__fixture/log", "GET")).json<{entries: LogEntry[]}>().entries;
      }
      const heldEntry = entries.find(entry => entry.result === "held")!;
      assert.equal(heldEntry.completedAt, null);
      assert.equal(heldEntry.status, null);
      assert.equal((yield* c.control(`/__fixture/held/answer?seq=${heldEntry.seq}`)).status, 200);
      assert.equal((yield* Fiber.join(held)).status, 200);

      const logReply = yield* c.control("/__fixture/log", "GET");
      const log = logReply.json<{entries: LogEntry[]; mutations: Array<{path: string; bodySha256: string; count: number}>; polls: Array<{path: string; count: number; intervalsMs: number[]}>}>();
      const mutations = log.entries.filter(entry => entry.mutation);
      assert.deepEqual(mutations.map(entry => [entry.path, entry.bodySha256]), sent.map(item => [item.path, sha256(item.body)]));
      assert.ok(log.mutations.every(group => group.count === 1));
      assert.deepEqual(mutations.map(entry => [entry.result, entry.effect, entry.status]), [
        ["answered", null, 200], ["answered", null, 200], ["answered", "status-403", 403], ["dropped", "dropped", null], ["answered", "held-then-answered", 200],
      ]);
      assert.ok(mutations.every(entry => entry.bodyBytes !== null && entry.at >= 0 && entry.completedAt !== null && entry.completedAt >= entry.at));
      const snapshotPolls = log.polls.find(group => group.path === paths.snapshot)!;
      assert.equal(snapshotPolls.count, 3);
      assert.equal(snapshotPolls.intervalsMs.length, 2);
      const text = logReply.body.toString("utf8");
      for (const secret of [fixtureToken, c.session, c.csrf, marker]) assert.equal(text.includes(secret), false);
    }));
  }).pipe(Effect.provide(NodeFileSystem.layer)), 20_000);

  it.live("releases the server, held requests and the log when its scope closes", () => Effect.gen(function* () {
    const assets = yield* makeAssets;
    const {fixture, close} = yield* open(assets.dir);
    const c = client(fixture);
    yield* c.signIn;
    yield* scenario(c, "mutation-never-answered");
    const held = yield* Effect.forkChild(outcomeOf(c.post(paths.noProject, {expectedGeneration: 1, mode: "off"})), {startImmediately: true});
    for (let attempt = 0; attempt < 50 && fixture.controller.held.size === 0; attempt++) yield* Effect.sleep("20 millis");
    assert.equal(fixture.controller.held.size, 1);
    // an idle keep-open connection, destroyed by the test's own step or else when its scope closes
    const idle = yield* Effect.acquireRelease(Effect.sync(() => net.connect({host: "127.0.0.1", port: fixture.port})), socket => Effect.sync(() => socket.destroy()));
    yield* Effect.callback<void>(resume => {idle.once("connect", () => resume(Effect.void));});
    assert.ok(fixture.controller.log.size > 0);
    const started = yield* Clock.monotonicTimeNanos;
    yield* close;
    assert.ok((yield* elapsedSince(started)) < 5_000);
    assert.equal(yield* Fiber.join(held), "connection-closed");
    idle.destroy();
    assert.equal(yield* connects("127.0.0.1", fixture.port), false);
    assert.equal(fixture.controller.closed, true);
    assert.equal(fixture.controller.log.size, 0);
    assert.equal(fixture.controller.held.size, 0);
    assert.equal(fixture.controller.sessionCount, 0);
  }).pipe(Effect.provide(NodeFileSystem.layer)), 20_000);
});
