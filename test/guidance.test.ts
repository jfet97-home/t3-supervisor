import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {SupervisorConfig as Configuration} from "../src/config.js";
import {GuidanceRuntime} from "../src/guidance.js";
import {GuidanceStore} from "../src/guidance-store.js";
import {forgeDashboardToken, startGuidanceUi} from "./support/service-auth-harness.js";
import {SupervisorOwnership} from "../src/project-supervisor-store.js";
import {makeStore} from "../src/store.js";
import {ThreadPolicy} from "../src/thread-policy.js";
import {released} from "./support/http.js";
import type {SupervisorConfig, ThreadInfo} from "../src/types.js";

const config = (directory: string): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://127.0.0.1:3773",
  t3TokenFile: "unused",
  excludedThreadIds: [],
  healthPort: 0,
  uiPort: 0,
  uiHost: "127.0.0.1",
  uiAssetsDirectory: directory,
  supervisorOwnedThreadIds: new Set(),
});

const thread = (id: string, parentThreadId: string | null, relationshipToParent: string | null, rootThreadId = id): ThreadInfo => ({
  id,
  title: id,
  projectId: "project",
  lineage: {parentThreadId, relationshipToParent, rootThreadId},
});

const signIn = async (origin: string, directory: string): Promise<string> => {
  const token = (await forgeDashboardToken(directory)).token;
  const response = await fetch(origin + "/auth/login", {
    method: "POST",
    headers: {Origin: origin, "Content-Type": "application/json"},
    body: JSON.stringify({token}),
  });
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || !("session" in payload) || typeof payload.session !== "string")
    throw new Error("Dashboard session response is invalid.");
  return payload.session;
};

// a temporary data directory, removed when the test scope closes
const temporaryDirectory = (prefix: string) => Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
  directory => Effect.promise(() => rm(directory, {recursive: true, force: true})),
);

// the interim guidance store (b-02), closed before its directory is removed
const guidanceStore = (directory: string) => Effect.acquireRelease(
  Effect.sync(() => new GuidanceStore(directory)),
  store => Effect.sync(() => store.close()),
);

// the runtime over the catalog, thread policy and ownership layers of the data directory
const runtimeLayer = (settings: SupervisorConfig, store: GuidanceStore) => GuidanceRuntime.layer(store).pipe(
  Layer.provideMerge(Layer.mergeAll(makeStore(settings.dataDirectory), ThreadPolicy.layer, SupervisorOwnership.layer)),
  Layer.provide(Layer.succeed(Configuration, settings)),
);

it.live("dashboard snapshot uses the native catalog and excludes owned roots and descendants", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("supervisor-snapshot-");
  const store = yield* guidanceStore(directory);
  const settings = config(directory);
  const nativeThreads = [
    thread("main", null, null),
    thread("supervisor-root:root-id", null, null),
    thread("helper", "supervisor-root:root-id", "subagent", "supervisor-root:root-id"),
    thread("child", "main", "subagent", "main"),
  ];
  const runtime = yield* GuidanceRuntime.make(settings, store, {catalog: () => Effect.succeed({
    projects: [{project: {id: "project", title: "Project", workspaceRoot: "/work/project"}, available: true}],
    threads: nativeThreads,
  })});
  const snapshot = yield* runtime.snapshot;
  assert.deepEqual(snapshot.threads.map(value => value.id), ["main"]);
  assert.equal("history" in snapshot, false);
  assert.deepEqual(snapshot.threadPolicy.excludedThreadIds, []);
}));

it.live("dashboard sessions retain authenticated snapshot and excluded-thread settings access", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("supervisor-dashboard-");
  const store = yield* guidanceStore(directory);
  const settings = config(directory);
  yield* Effect.gen(function* () {
    const policy = yield* ThreadPolicy;
    // the unported dashboard handlers read the thread policy from the configuration they receive (b-02)
    const readers = {...settings, threadPolicy: policy};
    const runtime = yield* GuidanceRuntime;
    const ui = yield* Effect.acquireRelease(Effect.promise(() => startGuidanceUi(readers, runtime)), ui => Effect.promise(() => ui.close()));
    const address = ui.server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    assert.equal((yield* Effect.promise(() => fetch(origin + "/api/guidance/snapshot").then(released))).status, 401);
    const session = yield* Effect.promise(() => signIn(origin, directory));
    const headers = {"x-supervisor-session": session};
    const snapshot = yield* Effect.promise(() => fetch(origin + "/api/guidance/snapshot", {headers}));
    assert.equal(snapshot.status, 200);
    yield* Effect.promise(() => released(snapshot));
    const csrf = (yield* Effect.promise(async () => await (await fetch(origin + "/api/csrf", {headers})).json() as {csrf: string})).csrf;
    const changed = yield* Effect.promise(() => fetch(origin + "/api/guidance/thread-policy", {
      method: "POST",
      headers: {Origin: origin, ...headers, "Content-Type": "application/json", "x-csrf-token": csrf},
      body: JSON.stringify({generation: policy.get().generation, excludedThreadIds: ["excluded-thread"]}),
    }));
    assert.equal(changed.status, 200);
    yield* Effect.promise(() => released(changed));
    assert.deepEqual(policy.get().excludedThreadIds, ["excluded-thread"]);
  }).pipe(Effect.scoped, Effect.provide(runtimeLayer(settings, store)));
}));
