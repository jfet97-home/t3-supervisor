import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect} from "effect";
import {it} from "vitest";
import {GuidanceRuntime} from "../src/guidance.js";
import {GuidanceStore} from "../src/guidance-store.js";
import {startGuidanceUi} from "../src/guidance-ui.js";
import {forgeDashboardToken} from "../src/service-auth.js";
import {ThreadPolicyStore} from "../src/thread-policy.js";
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

it("dashboard snapshot uses the native catalog and excludes owned roots and descendants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-snapshot-"));
  const store = new GuidanceStore(directory);
  const settings = config(directory);
  const nativeThreads = [
    thread("main", null, null),
    thread("supervisor-root:root-id", null, null),
    thread("helper", "supervisor-root:root-id", "subagent", "supervisor-root:root-id"),
    thread("child", "main", "subagent", "main"),
  ];
  const runtime = new GuidanceRuntime(settings, store, {catalog: () => Effect.succeed({
    projects: [{project: {id: "project", title: "Project", workspaceRoot: "/work/project"}, available: true}],
    threads: nativeThreads,
  })});
  try {
    const snapshot = await runtime.snapshot();
    assert.deepEqual(snapshot.threads.map(value => value.id), ["main"]);
    assert.equal("history" in snapshot, false);
    assert.deepEqual(snapshot.threadPolicy.excludedThreadIds, []);
  } finally {store.close(); await rm(directory, {recursive: true, force: true});}
});

it("dashboard sessions retain authenticated snapshot and excluded-thread settings access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-dashboard-"));
  const store = new GuidanceStore(directory);
  const policy = new ThreadPolicyStore(directory, {excludedThreadIds: []});
  const settings = config(directory);
  settings.threadPolicy = policy;
  const runtime = new GuidanceRuntime(settings, store, {catalog: () => Effect.succeed({projects: [], threads: []})});
  try {
    const ui = await startGuidanceUi(settings, runtime);
    try {
      const address = ui.server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      assert.equal((await fetch(origin + "/api/guidance/snapshot").then(released)).status, 401);
      const session = await signIn(origin, directory);
      const headers = {"x-supervisor-session": session};
      const snapshot = await fetch(origin + "/api/guidance/snapshot", {headers});
      assert.equal(snapshot.status, 200);
      await released(snapshot);
      const csrf = (await (await fetch(origin + "/api/csrf", {headers})).json() as {csrf: string}).csrf;
      const changed = await fetch(origin + "/api/guidance/thread-policy", {
        method: "POST",
        headers: {Origin: origin, ...headers, "Content-Type": "application/json", "x-csrf-token": csrf},
        body: JSON.stringify({generation: policy.get().generation, excludedThreadIds: ["excluded-thread"]}),
      });
      assert.equal(changed.status, 200);
      await released(changed);
      assert.deepEqual(policy.get().excludedThreadIds, ["excluded-thread"]);
    } finally {await ui.close();}
  } finally {
    policy.close();
    store.close();
    await rm(directory, {recursive: true, force: true});
  }
});
