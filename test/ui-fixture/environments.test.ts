import assert from "node:assert/strict";
import { request } from "node:http";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Schedule, Schema } from "effect";
import { Snapshot } from "../../src/guidance-contract.js";
import { ProjectDefinitions } from "../../src/project-definitions-contract.js";
import { NoProjectControlResult, SupervisionCandidates } from "../../src/supervisor-control-contract.js";
import { fixtureEnvironments, fixtureIds, fixtureToken } from "./scenarios.js";
import { startUiFixture, type LogEntry } from "./server.js";

// the fixture-only environment switch (R18 A-R18-03 mounted control): two synthetic T3 environments with their own No
// Project chats, exclusions and project definitions, switched by POST /__fixture/environment/<a|b>; no native call is made.
// the test talks to the fixture over real loopback sockets and writes its assets to a temp directory, so it is it.live

type Reply = {status: number; json: <T = unknown>() => T};
// one request on its own loopback connection, as the browser sends it: the native http client is the adapter, since the
// cases set exact headers on a connection without an agent; interrupting the call destroys its connection
const call = (port: number, input: {method?: string; path: string; headers?: Record<string, string>; body?: string}) => Effect.callback<Reply, Error>((resume) => {
  const outgoing = request({host: "127.0.0.1", port, path: input.path, method: input.method ?? "GET", agent: false, headers: input.headers ?? {}}, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("error", (error) => resume(Effect.fail(error)));
    response.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      resume(Effect.succeed({status: response.statusCode ?? 0, json: <T = unknown>() => JSON.parse(body) as T}));
    });
  });
  outgoing.on("error", (error) => resume(Effect.fail(error)));
  outgoing.end(input.body);
  return Effect.sync(() => outgoing.destroy());
});

it.live("CT-UI-FIXTURE-02 the environment control switches the synthetic T3 environment: distinct candidates, exclusions and definitions per environment, separate state, reset to a", () => Effect.gen(function* () {
  // the temp directory is removed after the fixture's scope has closed
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({prefix: "ui-fixture-environments-"});
  yield* fs.writeFileString(join(root, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>");
  const fixture = yield* startUiFixture({assets: root});
  const port = fixture.port;
  const origin = fixture.url.slice(0, -1);
  // a reset ends every fixture session, so the cases below sign in again after theirs
  let session = "";
  let csrf = "";
  const signIn = Effect.gen(function* () {
    const login = yield* call(port, {method: "POST", path: "/auth/login", headers: {origin, "content-type": "application/json"}, body: JSON.stringify({token: fixtureToken})});
    session = login.json<{session: string}>().session;
    csrf = (yield* call(port, {path: "/api/csrf", headers: {"x-supervisor-session": session}})).json<{csrf: string}>().csrf;
  });
  yield* signIn;
  const get = (path: string) => call(port, {path, headers: {"x-supervisor-session": session}});
  const post = (path: string, payload: unknown) => call(port, {method: "POST", path, body: JSON.stringify(payload),
    headers: {origin, "content-type": "application/json", "x-supervisor-session": session, "x-csrf-token": csrf}});
  const control = (path: string, method = "POST") => call(port, {method, path, headers: {origin}});
  const view = Effect.gen(function* () {
    const snapshot = Schema.decodeUnknownSync(Snapshot)((yield* get("/api/guidance/snapshot")).json());
    const start = Schema.decodeUnknownSync(SupervisionCandidates)((yield* get("/api/guidance/supervision-candidates?query=&purpose=start")).json());
    const definitions = Schema.decodeUnknownSync(ProjectDefinitions)((yield* get(`/api/guidance/project-configuration?projectId=${fixtureIds.projectA}`)).json());
    const mode = (yield* get("/api/guidance/no-project-control")).json<{generation: number}>();
    return {environmentId: snapshot.environmentId, starts: start.candidates.map((candidate) => candidate.id), excluded: snapshot.threadPolicy.excludedThreadIds,
      workspaceRoot: definitions.workspaceRoot, summaries: definitions.projectConfig?.steps.map((step) => step.summary), revision: definitions.revision, mode: mode.generation};
  });

  const a = yield* view;
  assert.deepEqual([a.environmentId, a.starts, a.excluded, a.workspaceRoot], [fixtureEnvironments.a, [fixtureIds.threadN1, fixtureIds.threadN2], [fixtureIds.threadA3], "/fixture/project-a"]);
  const switched = yield* control("/__fixture/environment/b");
  assert.equal(switched.status, 200);
  assert.deepEqual(switched.json<{environment: unknown}>().environment, {name: "b", environmentId: fixtureEnvironments.b});
  const b = yield* view;
  assert.deepEqual([b.environmentId, b.starts, b.excluded, b.workspaceRoot, b.summaries], [fixtureEnvironments.b, [fixtureIds.threadBN1, fixtureIds.threadBN2],
    [fixtureIds.threadA1], "/fixture-b/project-a", ["Fixture B step: run the environment b tests."]]);
  assert.notEqual(b.revision, a.revision, "the same project has other definitions in b");
  assert.deepEqual((yield* control("/__fixture/state", "GET")).json<{environment: unknown}>().environment, {name: "b", environmentId: fixtureEnvironments.b});

  // a change in b stays in b
  const saved = Schema.decodeUnknownSync(NoProjectControlResult)((yield* post("/api/guidance/no-project-control", {expectedGeneration: 1, mode: "automatic"})).json());
  assert.deepEqual([saved.status, saved.control.generation], ["saved", 2]);
  assert.equal((yield* control("/__fixture/environment/a")).status, 200);
  assert.deepEqual(yield* view, a, "a is unchanged");
  assert.equal((yield* control("/__fixture/environment/b")).status, 200);
  assert.equal((yield* view).mode, 2, "b keeps its own change");
  assert.equal((yield* control("/__fixture/environment/c")).status, 404);

  const log = (yield* control("/__fixture/log", "GET")).json<{entries: LogEntry[]}>();
  const save = log.entries.find((entry) => entry.mutation && entry.path === "/api/guidance/no-project-control")!;
  assert.equal(save.environment, fixtureEnvironments.b, "the log names the environment that answered");

  assert.equal((yield* control("/__fixture/reset")).status, 200);
  assert.deepEqual((yield* control("/__fixture/state", "GET")).json<{environment: unknown}>().environment, {name: "a", environmentId: fixtureEnvironments.a});

  // sol-r22: a held mutation computes in the environment it was received in, whenever it is released
  for (const apply of [false, true]) {
    assert.equal((yield* control("/__fixture/reset")).status, 200);
    yield* signIn;
    const armed = yield* control(`/__fixture/scenario/mutation-never-answered?path=/api/guidance/no-project-control${apply ? "&apply=1" : ""}`);
    assert.equal(armed.status, 200);
    const before = {a: yield* view};
    const held = yield* Effect.forkChild(post("/api/guidance/no-project-control", {expectedGeneration: 1, mode: "automatic"}), {startImmediately: true});
    // the fixture state is read again every 10 ms until it holds the save
    yield* Effect.repeat(control("/__fixture/state", "GET"), {until: (state) => state.json<{held: unknown[]}>().held.length !== 0, schedule: Schedule.spaced("10 millis")});
    assert.equal((yield* control("/__fixture/environment/b")).status, 200);
    const bBefore = yield* view;
    assert.equal((yield* control("/__fixture/held/answer", "POST")).status, 200);
    const answered = Schema.decodeUnknownSync(NoProjectControlResult)((yield* Fiber.join(held)).json());
    assert.deepEqual([answered.status, answered.control.generation], ["saved", 2], `apply=${apply}: the held save answers from a`);
    assert.deepEqual(yield* view, bBefore, `apply=${apply}: b is unchanged by the save received in a`);
    assert.equal((yield* control("/__fixture/environment/a")).status, 200);
    assert.deepEqual(yield* view, {...before.a, mode: 2}, `apply=${apply}: a holds the save it received`);
    const entries = (yield* control("/__fixture/log", "GET")).json<{entries: LogEntry[]}>().entries;
    const heldSave = entries.filter((entry) => entry.mutation && entry.path === "/api/guidance/no-project-control").at(-1)!;
    assert.equal(heldSave.environment, fixtureEnvironments.a, `apply=${apply}: the log names the environment of the receipt`);
  }
}).pipe(Effect.provide(NodeFileSystem.layer)), {timeout: 30_000});
