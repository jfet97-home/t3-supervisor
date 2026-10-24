import assert from "node:assert/strict";
import { beforeAll, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { makeBrowser, abortOf, json, liveSleep, until } from "./support/g7-browser.js";
import { scopedRegistry } from "./support/g7-page.js";

const browser = makeBrowser();
let atoms: typeof import("../ui/src/atoms.js");
let ps: typeof import("../ui/src/project-supervisor.js");
let access: typeof import("../ui/src/access.js");
beforeAll(() => Effect.gen(function* () {
  yield* browser.install;
  browser.local.set("supervisor-session", "session-1");
  atoms = yield* Effect.promise(() => import("../ui/src/atoms.js"));
  ps = yield* Effect.promise(() => import("../ui/src/project-supervisor.js"));
  access = yield* Effect.promise(() => import("../ui/src/access.js"));
}));
const scope = {environmentId: "environment", projectId: "project", mainThreadId: "main", bindingThreadId: null, bindingGeneration: null, epoch: 0};
const progress = (workflowOffset: number, lineageOffset: number) => ({status: "ok", message: null, projectId: "project", mainThreadId: "main", observedAt: 1,
  scope: null, incompatibleWorkflows: [], workflows: [], workflowOffset, workflowHasMore: true, lineageOffset, lineageHasMore: false});

it.live("one stream coalesces matching progress hints, retains loaded offsets, drafts and an admitted operation, and reconnects with reset", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1"); browser.sent.length = 0;
  browser.state.reply = request => json(progress(Number(request.search.get("workflowOffset")), Number(request.search.get("lineageOffset"))));
  const registry = yield* scopedRegistry();
  const read = ps.workflowProgressRead(scope);
  const stop = registry.mount(ps.workflowProgressLive(scope));
  let secondaryReads = 0;
  const secondary = atoms.uiRuntime.atom(Effect.sync(() => ++secondaryReads)).pipe(atoms.refreshOnDashboardChange("snapshot"));
  const stopSecondary = registry.mount(secondary);
  yield* until(registry, read, result => AsyncResult.isSuccess(result) && !result.waiting, "first progress");
  const first = yield* browser.request(request => request.path === "/api/events", "one stream");
  registry.update(ps.workflowProgressMore(scope), value => ({seq: value.seq + 1, page: {workflowOffset: 20, lineageOffset: 30}}));
  yield* until(registry, read, result => AsyncResult.isSuccess(result) && !result.waiting && result.value.pages.length === 2, "second progress page");
  const draft = atoms.draftFamily(() => "saved")("main"); registry.set(draft, "unsaved draft");
  const release = yield* Deferred.make<void>(); let calls = 0;
  const operation = atoms.admittedMutation(() => Effect.andThen(Effect.sync(() => {calls++;}), Deferred.await(release)))({scope: "main", operationId: "retained-operation"});
  const stopOperation = registry.mount(operation); registry.set(operation, undefined);
  const unmounted = ps.workflowProgressLive({...scope, mainThreadId: "unmounted"});
  assert.ok(unmounted);
  assert.equal(browser.sent.filter(request => request.path === "/api/events").length, 1, "mounted readers share the registry stream");
  browser.sent.length = 0;
  browser.hint(["progress:project:other"]);
  yield* liveSleep("80 millis"); assert.equal(browser.sent.length, 0, "another main's hint reads nothing");
  const start = Date.now();
  browser.hint(["progress:project:main"]); browser.hint(["progress:project:main"]);
  yield* browser.request(() => browser.sent.length === 2, "one refresh of both loaded offsets");
  yield* until(registry, read, result => AsyncResult.isSuccess(result) && !result.waiting, "refresh settled");
  console.log(JSON.stringify({sseHintToRefetchMs: Date.now() - start}));
  assert.deepEqual(browser.sent.map(request => [request.search.get("workflowOffset"), request.search.get("lineageOffset")]), [["0", "0"], ["20", "30"]]);
  assert.equal(registry.get(draft), "unsaved draft"); assert.equal(calls, 1);
  assert.equal(browser.sent.some(request => request.search.get("mainThreadId") === "unmounted"), false);
  browser.disconnect();
  const reconnected = yield* browser.request(request => request.path === "/api/events", "network reconnect");
  assert.notEqual(reconnected, first);
  browser.hint(null);
  yield* browser.request(() => browser.sent.filter(request => request.path !== "/api/events").length === 4, "reset refreshes loaded pages once");
  registry.set(operation, undefined); assert.equal(calls, 1, "the admitted operation is joined, never replayed");
  assert.equal(registry.get(draft), "unsaved draft");
  yield* Deferred.succeed(release, undefined);
  yield* until(registry, operation, result => AsyncResult.isSuccess(result) && !result.waiting, "operation settled");
  stop(); stopOperation(); stopSecondary();
  yield* abortOf(reconnected.signal);
  registry.dispose();
}), {timeout: 10_000});

it.live("401 clears the current session and ends the stream; no session or hidden tab opens none", () => Effect.gen(function* () {
  browser.sent.length = 0; browser.visibility("hidden");
  const registry = yield* scopedRegistry();
  const stop = registry.mount(atoms.dashboardHints);
  yield* liveSleep("50 millis"); assert.equal(browser.sent.length, 0);
  browser.local.delete("supervisor-session"); browser.visibility("visible");
  yield* liveSleep("50 millis"); assert.equal(browser.sent.length, 0);
  browser.state.events = () => json({message: "Sign in"}, 401);
  const signIn = atoms.uiRuntime.fn(() => Effect.flatMap(access.SessionAccess, service => Effect.orDie(service.signIn("session-2"))));
  registry.set(signIn, undefined);
  yield* browser.request(request => request.path === "/api/events", "authenticated stream");
  yield* until(registry, atoms.authEpochAtom, result => AsyncResult.isSuccess(result) && result.value >= 2, "401 removes session");
  assert.equal(browser.local.has("supervisor-session"), false);
  const count = browser.sent.length; yield* liveSleep("600 millis"); assert.equal(browser.sent.length, count);
  stop(); registry.dispose(); browser.state.events = undefined;
}), {timeout: 10_000});

it.live("two dashboard registries own one stream each and both release their stream when hidden", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1"); browser.sent.length = 0;
  const first = yield* scopedRegistry(); const second = yield* scopedRegistry();
  first.mount(atoms.dashboardHints); second.mount(atoms.dashboardHints);
  yield* browser.request(() => browser.sent.length === 2, "two registry streams");
  assert.ok(browser.sent.every(request => request.path === "/api/events" && request.session === "session-1" && request.search.toString() === ""));
  const streams = [...browser.sent]; browser.visibility("hidden");
  yield* Effect.all(streams.map(request => abortOf(request.signal)));
  first.dispose(); second.dispose(); browser.visibility("visible");
}), {timeout: 5_000});
