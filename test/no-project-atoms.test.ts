import assert from "node:assert/strict";
import { beforeAll, it } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";
import { TestClock } from "effect/testing";
import { clockedRegistry, scopedRegistry, subscribed } from "./support/g7-page.js";
import { json, makeBrowser, until } from "./support/g7-browser.js";

// target regressions of the No Project panels over atoms (CT-UI-NOPROJ-01, CT-UI-START-01): the mode save and its
// uncertainty, the Start fence in sessionStorage, and the candidate search. the waits for an atom value or a request are
// bounded on the live clock; the search test steps its 200 ms delay on the page runtime's test clock

const browser = makeBrowser();
type NoProject = typeof import("../ui/src/no-project.js");
let ui: NoProject;
let atoms: typeof import("../ui/src/atoms.js");

beforeAll(() => Effect.gen(function* () {
  yield* browser.install;
  browser.local.set("supervisor-session", "session-1");
  atoms = yield* Effect.promise(() => import("../ui/src/atoms.js"));
  ui = yield* Effect.promise(() => import("../ui/src/no-project.js"));
}));

const control = (generation: number, mode: string) => ({ generation, mode, globallyEnabled: true });
// a registry of the running test: the subscriptions made through it are stopped and the registry is disposed when the test
// ends, also after a failed assertion, so the leak gate reports only real leaks; stopping or disposing earlier is the test's
// own step and is not repeated
const pageRegistry = (registry: Effect.Effect<AtomRegistry.AtomRegistry, never, Scope.Scope> = scopedRegistry()) => Effect.map(registry, (registry) => ({
  registry,
  subscribe: (atom: Atom.Atom<unknown>) => subscribed(registry, atom),
}));
// completes once an action written to the registry has finished
const settled = (registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>) =>
  until(registry, atom, (result) => AsyncResult.isNotInitial(result) && !result.waiting, "the action settled");

it.effect("CT-UI-NOPROJ-01 No Project save sends expectedGeneration, an unconfirmed result keeps the panel uncertain until Reload, and the draft mode survives a reload failure", () => Effect.gen(function* () {
  const { registry, subscribe } = yield* pageRegistry();
  const stop = yield* subscribe(ui.noProjectState);
  browser.sent.length = 0;
  let read: () => Response = () => json(control(7, "on_request"));
  let save: () => Response = () => json({ message: "Unexpected." }, 500);
  browser.state.reply = (request) => request.method === "GET" ? read() : save();

  registry.set(ui.reloadNoProject, undefined);
  yield* settled(registry, ui.reloadNoProject);
  assert.deepEqual(registry.get(ui.noProjectState), { control: control(7, "on_request"), mode: "on_request", busy: false, uncertain: false, message: "" });

  registry.set(ui.noProjectState, { ...registry.get(ui.noProjectState), mode: "automatic" });
  registry.set(ui.saveNoProject, undefined);
  yield* settled(registry, ui.saveNoProject);
  const post = browser.sent.filter((request) => request.method === "POST");
  assert.deepEqual(post.map((request) => [request.path, JSON.parse(request.body)]), [["/api/guidance/no-project-control", { expectedGeneration: 7, mode: "automatic" }]]);
  assert.deepEqual(registry.get(ui.noProjectState), { control: control(7, "on_request"), mode: "automatic", busy: false, uncertain: true,
    message: "The mode change is unconfirmed. Reload its saved status before trying again." });

  // an uncertain panel sends no further save
  registry.set(ui.saveNoProject, undefined);
  yield* settled(registry, ui.saveNoProject);
  assert.equal(browser.sent.filter((request) => request.method === "POST").length, 1);

  read = () => json({ message: "Unavailable." }, 500);
  registry.set(ui.reloadNoProject, undefined);
  yield* until(registry, ui.noProjectState, (state) => !state.busy && state.message === "Mode unavailable. Reload before changing it.", "the failed reload");
  assert.equal(registry.get(ui.noProjectState).mode, "automatic", "the draft mode survives a failed reload");
  assert.equal(registry.get(ui.noProjectState).uncertain, true);

  read = () => json(control(8, "off"));
  registry.set(ui.reloadNoProject, undefined);
  yield* until(registry, ui.noProjectState, (state) => !state.busy && state.control?.generation === 8, "the verified reload");
  assert.deepEqual(registry.get(ui.noProjectState), { control: control(8, "off"), mode: "off", busy: false, uncertain: false, message: "" });

  save = () => json({ status: "conflict", message: "Changed in another tab.", control: control(9, "automatic") });
  registry.set(ui.noProjectState, { ...registry.get(ui.noProjectState), mode: "on_request" });
  registry.set(ui.saveNoProject, undefined);
  yield* until(registry, ui.noProjectState, (state) => !state.busy && state.control?.generation === 9, "the conflict");
  assert.deepEqual(registry.get(ui.noProjectState), { control: control(9, "automatic"), mode: "automatic", busy: false, uncertain: true, message: "Changed in another tab." });
  assert.deepEqual(JSON.parse(browser.sent.filter((request) => request.method === "POST").at(-1)!.body), { expectedGeneration: 8, mode: "on_request" });
  stop();
  registry.dispose();
}), { timeout: 10_000 });

const fenceKey = "supervisor-pending-start";
const status = (intent: { threadId: string; operationId: string }, value: string, reason: string) => json({ ...intent, status: value, reason });

it.effect("CT-UI-START-01 a retained Start intent blocks any new Start, survives reload, keeps its fence through an unknown POST and a denied read, and a terminal status clears it exactly once", () => Effect.gen(function* () {
  browser.session.clear();
  browser.sent.length = 0;
  const { registry: first, subscribe: subscribeFirst } = yield* pageRegistry();
  const stopFirst = yield* subscribeFirst(ui.startState);
  assert.deepEqual(first.get(ui.startState), { intent: null, busy: false, message: "" });
  browser.state.reply = () => json({ message: "Unexpected." }, 500);

  first.set(ui.startSupervision, "thread-1");
  yield* settled(first, ui.startSupervision);
  const stored = browser.session.get(fenceKey);
  assert.ok(stored, "the fence is persisted");
  const intent = JSON.parse(stored) as { threadId: string; operationId: string };
  assert.deepEqual(Object.keys(intent), ["threadId", "operationId"]);
  assert.equal(intent.threadId, "thread-1");
  const posts = () => browser.sent.filter((request) => request.method === "POST" && request.path === "/api/guidance/supervision-start");
  assert.deepEqual(posts().map((request) => request.body), [stored], "the request carries the persisted intent");
  assert.deepEqual(first.get(ui.startState), { intent, busy: false, message: "Start outcome is unknown. Check the original operation status; no new Start will be sent." });

  // the retained intent blocks every new Start
  first.set(ui.startSupervision, "thread-2");
  yield* settled(first, ui.startSupervision);
  assert.equal(posts().length, 1);
  assert.equal(browser.session.get(fenceKey), stored);
  stopFirst();
  first.dispose();

  // a reload of the page keeps the fence
  const { registry: second, subscribe: subscribeSecond } = yield* pageRegistry();
  const stopSecond = yield* subscribeSecond(ui.startState);
  assert.deepEqual(second.get(ui.startState), { intent, busy: false, message: "" });

  const revision = () => second.get(ui.candidatesRevision("start"));
  const before = revision();
  browser.state.reply = () => status(intent, "denied", "No matching Start operation is recorded. Nothing was replayed.");
  second.set(ui.checkStartStatus, undefined);
  yield* settled(second, ui.checkStartStatus);
  const read = browser.sent.filter((request) => request.method === "GET" && request.path === "/api/guidance/supervision-start").at(-1)!;
  assert.deepEqual(Object.fromEntries(read.search), intent, "the status read names the exact operation");
  assert.deepEqual(second.get(ui.startState), { intent, busy: false, message: "No matching Start operation is recorded. Nothing was replayed." });
  assert.equal(browser.session.get(fenceKey), stored, "a denied read never clears the fence");

  browser.state.reply = () => status({ ...intent, operationId: "another" }, "active", "Started.");
  second.set(ui.checkStartStatus, undefined);
  yield* settled(second, ui.checkStartStatus);
  assert.deepEqual(second.get(ui.startState), { intent, busy: false, message: "Start status unavailable. The original operation remains held." });

  browser.state.reply = () => status(intent, "active", "Supervision started.");
  second.set(ui.checkStartStatus, undefined);
  yield* settled(second, ui.checkStartStatus);
  assert.deepEqual(second.get(ui.startState), { intent: null, busy: false, message: "Supervision started." });
  assert.equal(browser.session.has(fenceKey), false);
  assert.equal(revision(), before + 1, "the candidate list reloads once");
  const reads = browser.sent.length;
  second.set(ui.checkStartStatus, undefined);
  yield* settled(second, ui.checkStartStatus);
  assert.equal(browser.sent.length, reads, "nothing is left to check");
  assert.equal(revision(), before + 1);
  assert.equal(posts().length, 1, "no Start was ever replayed");
  stopSecond();
  second.dispose();
}), { timeout: 10_000 });

it.effect("no Start is sent without a persisted fence, a POST answer clears only a terminal status, and a pending answer keeps the fence", () => Effect.gen(function* () {
  browser.session.clear();
  browser.sent.length = 0;
  const { registry, subscribe } = yield* pageRegistry();
  const stop = yield* subscribe(ui.startState);
  browser.state.sessionBlocked = true;
  registry.set(ui.startSupervision, "thread-1");
  yield* settled(registry, ui.startSupervision);
  browser.state.sessionBlocked = false;
  assert.equal(browser.sent.length, 0, "blocked storage sends nothing");
  assert.deepEqual(registry.get(ui.startState), { intent: null, busy: false, message: "" });

  browser.state.reply = (request) => status(JSON.parse(request.body) as { threadId: string; operationId: string }, "pending", "Waiting for T3.");
  registry.set(ui.startSupervision, "thread-1");
  yield* settled(registry, ui.startSupervision);
  const intent = registry.get(ui.startState).intent;
  assert.ok(intent);
  assert.equal(registry.get(ui.startState).message, "Waiting for T3.");
  assert.equal(browser.session.get(fenceKey), JSON.stringify(intent));

  browser.state.reply = () => status(intent, "denied", "Start is not allowed for this chat.");
  registry.set(ui.checkStartStatus, undefined);
  yield* settled(registry, ui.checkStartStatus);
  assert.equal(browser.session.get(fenceKey), JSON.stringify(intent), "a denied read keeps the fence");

  browser.session.clear();
  registry.set(ui.startState, { intent: null, busy: false, message: "" });
  browser.state.reply = (request) => status(JSON.parse(request.body) as { threadId: string; operationId: string }, "denied", "Start is not allowed for this chat.");
  registry.set(ui.startSupervision, "thread-3");
  yield* settled(registry, ui.startSupervision);
  assert.deepEqual(registry.get(ui.startState), { intent: null, busy: false, message: "Start is not allowed for this chat." }, "a denied POST answer is terminal");
  assert.equal(browser.session.has(fenceKey), false);
  stop();
  registry.dispose();
}), { timeout: 10_000 });

it.effect("a candidate search waits 200 ms for a typed query, a newer query interrupts it, and a 401 refreshes access", () => Effect.gen(function* () {
  browser.sent.length = 0;
  const { registry, subscribe } = yield* pageRegistry(clockedRegistry(atoms.uiRuntime));
  const candidates = { exceptions: [], candidates: [{ id: "thread-1", projectId: "", title: "Chat", updatedAt: null, active: false, excluded: false }], message: "1 recent chat." };
  browser.state.reply = (request) => request.path === "/api/csrf" ? json({ csrf: "token" }) : json(candidates);
  const superseded = yield* subscribe(ui.chatCandidates("start")("cha")(0));
  superseded();
  const atom = ui.chatCandidates("start")("chat")(0);
  const stop = yield* subscribe(atom);
  // the typed query's 200 ms delay passes on the page runtime's clock
  yield* TestClock.adjust("200 millis");
  const result = yield* until(registry, atom, AsyncResult.isSuccess, "the search answered");
  assert.deepEqual(AsyncResult.isSuccess(result) ? result.value : undefined, candidates);
  assert.deepEqual(browser.sent.map((request) => [request.path, Object.fromEntries(request.search)]), [["/api/guidance/supervision-candidates", { query: "chat", purpose: "start" }]],
    "only the latest query is requested");
  stop();

  browser.sent.length = 0;
  browser.state.reply = (request) => request.path === "/api/csrf" ? json({ csrf: "token" }) : json({ message: "Sign in to Supervisor." }, 401);
  const recent = ui.chatCandidates("exclude")("")(0);
  const stopRecent = yield* subscribe(recent);
  yield* until(registry, recent, AsyncResult.isFailure, "the search failed");
  yield* browser.request((request) => request.path === "/api/csrf", "the access refresh");
  assert.deepEqual(browser.sent.map((request) => request.path), ["/api/guidance/supervision-candidates", "/api/csrf"]);
  stopRecent();
  registry.dispose();
}), { timeout: 10_000 });
