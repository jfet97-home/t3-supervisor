import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {GuidanceRuntime} from "../src/guidance.js";
import {ThreadPolicyStore} from "../src/thread-policy.js";
import type {SupervisorConfig, ThreadInfo} from "../src/types.js";
import {catalogRuntime, dashboard, processStores, signIn} from "./support/g11-dashboard.js";
import {exchange} from "./support/g11-http.js";
import {temporaryDirectory} from "./support/g11-stores.js";

// the dashboard snapshot and its authenticated http flow over the production stores, runtime and listeners. it.live: the
// stores are real database files and the dashboard listens on a loopback port

const config = (directory: string): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://127.0.0.1:3773",
  t3TokenFile: "unused",
  excludedThreadIds: [],
  healthPort: 0,
  uiPort: 0,
  uiHost: "127.0.0.1",
  uiAssetsDirectory: directory,
});

const thread = (id: string, parentThreadId: string | null, relationshipToParent: string | null, rootThreadId = id): ThreadInfo => ({
  id,
  title: id,
  projectId: "project",
  lineage: {parentThreadId, relationshipToParent, rootThreadId},
});

it.live("dashboard snapshot uses the native catalog and excludes owned roots and descendants", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("supervisor-snapshot-");
  const settings = config(directory);
  const nativeThreads = [
    thread("main", null, null),
    thread("supervisor-root:root-id", null, null),
    thread("helper", "supervisor-root:root-id", "subagent", "supervisor-root:root-id"),
    thread("child", "main", "subagent", "main"),
  ];
  const stores = yield* Layer.build(processStores(settings));
  const runtime = yield* GuidanceRuntime.make(settings, {catalog: () => Effect.succeed({
    projects: [{project: {id: "project", title: "Project", workspaceRoot: "/work/project"}, available: true}],
    threads: nativeThreads,
  })}).pipe(Effect.provide(stores));
  const snapshot = yield* runtime.snapshot;
  assert.deepEqual(snapshot.threads.map(value => value.id), ["main"]);
  assert.equal("history" in snapshot, false);
  assert.deepEqual(snapshot.threadPolicy.excludedThreadIds, []);
}));

it.live("dashboard sessions retain authenticated snapshot and excluded-thread settings access", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("supervisor-dashboard-");
  const settings = config(directory);
  // the runtime over the data directory's catalog, the process's thread-policy store and ownership set
  const ui = yield* dashboard(settings, {runtime: catalogRuntime(settings)});
  const policy: ThreadPolicyStore["Service"] = ui.policy;
  const origin = ui.origin;
  assert.equal((yield* exchange(origin + "/api/guidance/snapshot")).status, 401);
  const session = yield* signIn(origin, directory);
  const headers = {"x-supervisor-session": session};
  const snapshot = yield* exchange(origin + "/api/guidance/snapshot", {headers});
  assert.equal(snapshot.status, 200);
  const csrf = (JSON.parse((yield* exchange(origin + "/api/csrf", {headers})).text) as {csrf: string}).csrf;
  const changed = yield* exchange(origin + "/api/guidance/thread-policy", {
    method: "POST",
    headers: {Origin: origin, ...headers, "Content-Type": "application/json", "x-csrf-token": csrf},
    body: JSON.stringify({generation: (yield* policy.get()).generation, excludedThreadIds: ["excluded-thread"]}),
  });
  assert.equal(changed.status, 200);
  assert.deepEqual((yield* policy.get()).excludedThreadIds, ["excluded-thread"]);
}));
