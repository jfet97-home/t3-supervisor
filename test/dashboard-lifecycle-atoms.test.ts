/// <reference types="vite/client" />
// the shell imports its stylesheet, which the vite client types declare for the root type check
import assert from "node:assert/strict";
import { Context, Effect, Fiber } from "effect";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { afterAll, beforeAll, it, vi } from "vitest";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { held, json, makeBrowser, until, type SentRequest } from "./support/ui-browser.js";

// target regressions of the dashboard lifecycle (R18 SOL-R18-01/02, A-R18-01..03) over a stubbed browser and the real page
// runtime: disposing the page runtime aborts the actions' requests and ends their waits, every access, sign-in and
// sign-out response is released on every return, and reads, drafts and outcomes stay with the T3 environment they belong to

// importing the shell mounts its root; only the React root renderer is replaced, nothing it renders is under test here
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => undefined }) }));

const browser = makeBrowser();
let atoms: typeof import("../ui/src/atoms.js");
let access: typeof import("../ui/src/access.js");
let shell: typeof import("../ui/src/main.js");
let noProject: typeof import("../ui/src/no-project.js");
let definitions: typeof import("../ui/src/project-definitions.js");
let definitionsApi: typeof import("../ui/src/project-definitions-api.js");

beforeAll(async () => {
  browser.install();
  browser.state.root = {};
  atoms = await import("../ui/src/atoms.js");
  access = await import("../ui/src/access.js");
  shell = await import("../ui/src/main.js");
  noProject = await import("../ui/src/no-project.js");
  definitions = await import("../ui/src/project-definitions.js");
  definitionsApi = await import("../ui/src/project-definitions-api.js");
});
afterAll(() => browser.restore());

const fenceKey = "supervisor-pending-start";
const snapshot = (environmentId: string) => ({
  environmentId, serverVersion: "build", connected: true, lastCycleAt: 1, sendingReady: true, sendingReason: "",
  settings: { generation: 1, guidancePaused: false, monitoringPaused: false, allowFollowupRace: false, verifiedServerVersion: null, model: "model",
    reasoning: "low", dailyTokenBudget: 1, evidenceHours: 1, maxAnchorAgeSeconds: 1 },
  threadPolicy: { generation: 1, excludedThreadIds: [] }, threads: [], projects: [], rules: [], mutes: [], activity: [], coverage: "", tokensUsed: 0,
});
const candidates = (environment: string) => ({ exceptions: [], message: environment,
  candidates: [{ id: `${environment}-thread`, projectId: "", title: environment, updatedAt: null, active: false, excluded: false }] });
const loadedDefinitions = (revision: string): ProjectDefinitionSnapshot => ({
  projectId: "project", threadId: null, workspaceRoot: "/workspace", globalOnly: false, globalRevision: null, revision, editingAvailable: true,
  status: "ready", steps: [], workflows: [], config: { workflows: [], steps: [] }, projectConfig: { workflows: [], steps: [] }, definitionFiles: [],
  complete: true, sources: [], issues: [],
});
const sentTo = (method: string, path: string) => browser.sent.filter((request) => request.method === method && request.path === path);

// a wait for an event, bounded so that one that never comes fails by name instead of holding the run
const within = <A>(event: Promise<A>, ms: number, missing: A) => new Promise<A>((resolve) => {
  const timer = setTimeout(() => resolve(missing), ms);
  void event.then((value) => { clearTimeout(timer); resolve(value); });
});
const aborted = (request: SentRequest) => within(new Promise<string>((resolve) => {
  if (request.signal.aborted) resolve("aborted");
  else request.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
}), 2_000, "still pending");
// the fibers of the concurrent actions and admitted requests running in a registry (the fiber sets their atoms hold)
const runningFibers = (registry: AtomRegistry.AtomRegistry) => [...registry.getNodes().values()].flatMap((node) => {
  const value = node.valueOption();
  return value._tag === "Some" && value.value instanceof Set ? [...value.value as Set<unknown>].filter(Fiber.isFiber) : [];
});
const ended = (fibers: ReadonlyArray<Fiber.Fiber<unknown, unknown>>) =>
  within(Promise.all(fibers.map((fiber) => new Promise<void>((resolve) => { fiber.addObserver(() => resolve()); }))).then(() => "ended"), 2_000, "still waiting");
const services = (registry: AtomRegistry.AtomRegistry) => {
  registry.mount(atoms.uiRuntime);
  const runtime = registry.get(atoms.uiRuntime);
  assert.ok(AsyncResult.isSuccess(runtime));
  return runtime.value;
};
// a body that is delivered after the headers only when the test says so; it records when it is read and cancelled
const heldBody = () => {
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const body = { cancelled: false, reading, controller: null as ReadableStreamDefaultController<Uint8Array> | null };
  const stream = new ReadableStream<Uint8Array>({ start(controller) { body.controller = controller; }, pull() { started(); }, cancel() { body.cancelled = true; } });
  return { body, stream };
};

const lifecycle: Array<{ name: string; prepare: (registry: AtomRegistry.AtomRegistry) => void; start: (registry: AtomRegistry.AtomRegistry) => void; method: string; path: string }> = [
  { name: "a No Project mode read", method: "GET", path: "/api/guidance/no-project-control",
    prepare: () => undefined, start: (registry) => registry.set(noProject.reloadNoProject, undefined) },
  { name: "a No Project mode save waiting on its admitted request", method: "POST", path: "/api/guidance/no-project-control",
    prepare: (registry) => registry.set(noProject.noProjectState, { control: { generation: 7, mode: "on_request", globallyEnabled: true }, mode: "automatic", busy: false, uncertain: false, message: "" }),
    start: (registry) => registry.set(noProject.saveNoProject, undefined) },
  { name: "a chat settings save waiting on its admitted request", method: "POST", path: "/api/guidance/thread-policy",
    prepare: () => undefined, start: (registry) => registry.set(shell.saveChatSettings, { generation: 1, excludedThreadIds: [] }) },
  { name: "a sign-in waiting on its admitted login", method: "POST", path: "/auth/login",
    prepare: () => browser.local.clear(), start: (registry) => registry.set(shell.signInAction, "single-use-token") },
  { name: "a sign-out waiting on its admitted logout", method: "POST", path: "/auth/logout",
    prepare: () => undefined, start: (registry) => registry.set(shell.signOutAction, undefined) },
];

for (const action of lifecycle) it(`SOL-R18-01 disposing the page runtime aborts ${action.name}, ends the action and every waiter, and sends nothing again`, { timeout: 10_000 }, async () => {
  {
    browser.local.set("supervisor-session", "session-1");
    browser.sent.length = 0;
    browser.state.reply = (request) => request.method === action.method && request.path === action.path ? held(request) : json({ csrf: "csrf-1" });
    const registry = AtomRegistry.make();
    action.prepare(registry);
    action.start(registry);
    const request = await browser.request((sent) => sent.method === action.method && sent.path === action.path, action.name);
    const fibers = runningFibers(registry);
    assert.ok(fibers.length >= 1, `${action.name}: its fibers run`);
    registry.dispose();
    assert.equal(await aborted(request), "aborted", `${action.name}: the request is aborted`);
    assert.equal(await ended(fibers), "ended", `${action.name}: the action and every waiter end`);
    assert.equal(sentTo(action.method, action.path).length, 1, `${action.name}: nothing is sent again`);
  }
});

it("SOL-R18-01 a pending Start status read is aborted on disposal; the persisted fence keeps its original operation and the next page never sends the Start again", { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.session.clear();
  browser.sent.length = 0;
  const intent = { threadId: "thread-1", operationId: "operation-1" };
  browser.session.set(fenceKey, JSON.stringify(intent));
  browser.state.reply = (request) => request.path === "/api/guidance/supervision-start" ? held(request) : json({ csrf: "csrf-1" });
  const first = AtomRegistry.make();
  first.mount(noProject.startState);
  assert.deepEqual(first.get(noProject.startState).intent, intent);
  first.set(noProject.checkStartStatus, undefined);
  const read = await browser.request((request) => request.method === "GET" && request.path === "/api/guidance/supervision-start", "the status read");
  const fibers = runningFibers(first);
  first.dispose();
  assert.equal(await aborted(read), "aborted", "the status read is aborted");
  assert.equal(await ended(fibers), "ended", "the check ends");
  assert.equal(browser.session.get(fenceKey), JSON.stringify(intent), "the fence is kept");
  const next = AtomRegistry.make();
  next.mount(noProject.startState);
  assert.deepEqual(next.get(noProject.startState).intent, intent, "the next page retains the original operation");
  assert.equal(sentTo("POST", "/api/guidance/supervision-start").length, 0, "no Start is sent");
  next.dispose();
});

it("SOL-R18-01 a Start waiting on its admitted request is aborted on disposal; owner and joiner end and the next page checks the original operation without sending it again", { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.session.clear();
  browser.sent.length = 0;
  browser.state.reply = (request) => request.method === "POST" && request.path === "/api/guidance/supervision-start" ? held(request) : json({ csrf: "csrf-1" });
  const first = AtomRegistry.make();
  first.mount(noProject.startState);
  first.set(noProject.startSupervision, "thread-1");
  const post = await browser.request((request) => request.method === "POST" && request.path === "/api/guidance/supervision-start", "the Start");
  const stored = browser.session.get(fenceKey);
  assert.equal(stored, post.body, "the fence was persisted before the request, which carries it");
  const fibers = runningFibers(first);
  assert.ok(fibers.length >= 2, "the action and its admitted request run");
  first.dispose();
  assert.equal(await aborted(post), "aborted", "the Start request is aborted");
  assert.equal(await ended(fibers), "ended", "owner and joiner end");
  assert.equal(browser.session.get(fenceKey), stored, "the fence keeps the original operation");

  const intent = JSON.parse(stored!) as { threadId: string; operationId: string };
  browser.state.reply = () => json({ ...intent, status: "denied", reason: "No matching Start operation is recorded. Nothing was replayed." });
  const next = AtomRegistry.make();
  next.mount(noProject.startState);
  next.set(noProject.checkStartStatus, undefined);
  await until(next, noProject.checkStartStatus, (result) => AsyncResult.isNotInitial(result) && !result.waiting, "the status check");
  const check = sentTo("GET", "/api/guidance/supervision-start").at(-1)!;
  assert.deepEqual(Object.fromEntries(check.search), intent, "the check names the original operation");
  assert.equal(browser.session.get(fenceKey), stored, "a denied read keeps the fence");
  assert.equal(sentTo("POST", "/api/guidance/supervision-start").length, 1, "the Start is never sent again");
  next.dispose();
});

for (const owner of ["interruption", "registry disposal"] as const) it(`SOL-R18-02 an access check ended by ${owner} while its body is held after the headers aborts the fetch and cancels the reader, and publishes no CSRF token`, { timeout: 10_000 }, async () => {
  {
    browser.local.set("supervisor-session", "session-1");
    browser.sent.length = 0;
    const { body, stream } = heldBody();
    browser.state.reply = (request) => request.path === "/api/csrf" ? new Response(stream, { status: 200, headers: { "content-type": "application/json" } }) : json({});
    const registry = AtomRegistry.make();
    const context = services(registry);
    const fiber = owner === "interruption"
      ? Effect.runFork(Effect.flatMap(access.SessionAccess, (service) => service.check).pipe(Effect.provide(context)))
      : null;
    if (owner === "registry disposal") registry.mount(shell.accessAtom);
    const request = await browser.request((sent) => sent.path === "/api/csrf", `${owner}: the access check`);
    await within(body.reading, 2_000, undefined);
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
    else registry.dispose();
    assert.equal(await aborted(request), "aborted", `${owner}: the fetch is aborted`);
    assert.equal(body.cancelled, true, `${owner}: the body reader is cancelled`);
    if (fiber) {
      assert.equal(Effect.runSync(Effect.map(Context.get(context, access.SessionAccess).headers, (headers) => headers["x-csrf-token"])), "", `${owner}: no CSRF token`);
      registry.dispose();
    }
  }
});

const check = () => Effect.flatMap(access.SessionAccess, (service) => service.check);
const csrfOf = (context: Context.Context<import("../ui/src/access.js").SessionAccess>) =>
  Effect.runSync(Effect.map(Context.get(context, access.SessionAccess).headers, (headers) => headers["x-csrf-token"]));

it("SOL-R18-02 a refused access answer is released without being read", { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  const { body, stream } = heldBody();
  browser.state.reply = (request) => request.path === "/api/csrf" ? new Response(stream, { status: 403 }) : json({});
  const registry = AtomRegistry.make();
  const context = services(registry);
  assert.equal(await Effect.runPromise(check().pipe(Effect.provide(context))), false);
  assert.equal(await aborted(sentTo("GET", "/api/csrf").at(-1)!), "aborted", "the refused answer's request is released");
  assert.equal(body.cancelled, true, "the refused answer's body is cancelled");
  registry.dispose();
});

it("SOL-R18-02 an access answer for a session that changed in flight is released and publishes no CSRF token", { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  const { body, stream } = heldBody();
  let answer!: (response: Response) => void;
  browser.state.reply = (request) => request.path === "/api/csrf" ? new Promise<Response>((resolve) => { answer = resolve; }) : json({});
  const registry = AtomRegistry.make();
  const context = services(registry);
  const stale = Effect.runPromise(check().pipe(Effect.provide(context)));
  const request = await browser.request((sent) => sent.path === "/api/csrf", "the stale check");
  browser.local.set("supervisor-session", "session-2");
  answer(new Response(stream, { status: 200 }));
  assert.equal(await stale, false, "the stale answer is ignored");
  assert.equal(await aborted(request), "aborted", "the stale answer's request is released");
  assert.equal(body.cancelled, true, "the stale answer's body is cancelled");
  assert.equal(csrfOf(context), "", "no late CSRF token");
  registry.dispose();
});

for (const [path, label] of [["/auth/login", "a rejected sign-in"], ["/auth/logout", "a failed sign-out"]] as const) it(`SOL-R18-02 ${label} releases its unread response once its outcome is known`, { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", path === "/auth/login" ? "" : "session-1");
  browser.sent.length = 0;
  const { stream } = heldBody();
  browser.state.reply = (sent) => sent.path === path ? new Response(stream, { status: path === "/auth/login" ? 401 : 500 }) : json({ csrf: "csrf-1" });
  const registry = AtomRegistry.make();
  registry.mount(shell.accessAtom);
  const action = path === "/auth/login" ? shell.signInAction : shell.signOutAction;
  if (path === "/auth/login") registry.set(shell.signInAction, "single-use-token");
  else registry.set(shell.signOutAction, undefined);
  const outcome = await until(registry, action as Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>, (result) => AsyncResult.isNotInitial(result) && !result.waiting, label);
  assert.deepEqual(AsyncResult.isSuccess(outcome) ? outcome.value : null, path === "/auth/login" ? false : "failed", `${label}: its outcome`);
  if (path === "/auth/login") assert.equal(registry.get(shell.signInState).error, "The sign-in token is invalid, expired or already used.");
  assert.equal(await aborted(sentTo("POST", path).at(-1)!), "aborted", `${label}: its response is released`);
  registry.dispose();
});

for (const purpose of ["start", "exclude"] as const) it(`A-R18-03 ${purpose} candidates belong to the environment they were read for: another environment shows none of them while its own search is unread or failed`, { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  let environment = "environment-a";
  let failSearch = false;
  browser.state.reply = (request) => request.path === "/api/guidance/snapshot" ? json(snapshot(environment))
    : request.path === "/api/guidance/supervision-candidates" ? (failSearch ? json({ message: "Unavailable." }, 500) : json(candidates(environment)))
    : json({ csrf: "csrf-1" });
  const registry = AtomRegistry.make();
  registry.mount(atoms.snapshotAtom);
  await until(registry, atoms.environmentAtom, (value) => value === "environment-a", "environment a");
  {
    const search = noProject.chatCandidates(purpose)("")(0);
    const stop = registry.mount(search);
    const first = await until(registry, search, (result) => AsyncResult.isSuccess(result) && !result.waiting, `${purpose}: the search of a`);
    assert.equal(AsyncResult.isSuccess(first) && first.value.candidates[0]?.id, "environment-a-thread");

    environment = "environment-b";
    failSearch = true;
    registry.refresh(atoms.snapshotAtom);
    await until(registry, atoms.environmentAtom, (value) => value === "environment-b", `${purpose}: environment b`);
    assert.equal(AsyncResult.value(registry.get(search))._tag, "None", `${purpose}: no row of a while the search of b runs`);
    const failed = await until(registry, search, (result) => AsyncResult.isFailure(result) && !result.waiting, `${purpose}: the failed search of b`);
    assert.equal(AsyncResult.value(failed)._tag, "None", `${purpose}: no row of a once the search of b failed`);
    // the panel's reload is the next search revision
    failSearch = false;
    const reloaded = noProject.chatCandidates(purpose)("")(1);
    const stopReloaded = registry.mount(reloaded);
    const answered = await until(registry, reloaded, (result) => AsyncResult.isSuccess(result) && !result.waiting, `${purpose}: the search of b`);
    assert.equal(AsyncResult.isSuccess(answered) && answered.value.candidates[0]?.id, "environment-b-thread");

    environment = "environment-a";
    registry.refresh(atoms.snapshotAtom);
    await until(registry, atoms.environmentAtom, (value) => value === "environment-a", `${purpose}: environment a again`);
    stopReloaded();
    stop();
  }
  registry.dispose();
});

it("A-R18-03 the chat settings draft, status and save belong to their environment: another environment has its own, and a late outcome of a never reaches b", { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  let environment = "environment-a";
  const releases: Array<(response: Response) => void> = [];
  browser.state.reply = (request) => request.path === "/api/guidance/snapshot" ? json(snapshot(environment))
    : request.path === "/api/guidance/thread-policy" ? new Promise<Response>((resolve) => { releases.push(resolve); })
    : json({ csrf: "csrf-1" });
  const registry = AtomRegistry.make();
  const stops = [atoms.snapshotAtom, shell.chatSettingsDraft, shell.chatSettingsStatus].map((atom) => registry.mount(atom as Atom.Atom<unknown>));
  const switchTo = async (next: string) => {
    environment = next;
    registry.refresh(atoms.snapshotAtom);
    await until(registry, atoms.environmentAtom, (value) => value === next, next);
  };
  await until(registry, atoms.environmentAtom, (value) => value === "environment-a", "environment a");
  const draftA = { generation: 1, excludedThreadIds: ["environment-a-thread"] };
  registry.set(shell.chatSettingsDraft, draftA);
  registry.set(shell.saveChatSettings, draftA);
  await browser.request((request) => request.path === "/api/guidance/thread-policy", "the save of a");
  assert.equal(registry.get(shell.chatSettingsStatus).saving, true);

  await switchTo("environment-b");
  assert.equal(registry.get(shell.chatSettingsDraft), null, "b has no draft of a");
  assert.deepEqual(registry.get(shell.chatSettingsStatus), { saving: false, uncertain: false, message: "" }, "b does not show a's save");
  const draftB = { generation: 1, excludedThreadIds: ["environment-b-thread"] };
  registry.set(shell.chatSettingsDraft, draftB);
  releases[0]!(json({ generation: 2, excludedThreadIds: ["environment-a-thread"] }));
  // the late outcome of a is recorded for a; absence in b can only be observed over time
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(registry.get(shell.chatSettingsDraft), draftB, "b keeps its draft");
  assert.deepEqual(registry.get(shell.chatSettingsStatus), { saving: false, uncertain: false, message: "" }, "b shows no outcome of a");

  await switchTo("environment-a");
  assert.deepEqual(registry.get(shell.chatSettingsStatus), { saving: false, uncertain: false, message: "Chat settings saved and applied." }, "a records its outcome");
  assert.equal(registry.get(shell.chatSettingsDraft), null, "a's verified save cleared a's draft");
  await switchTo("environment-b");
  assert.deepEqual(registry.get(shell.chatSettingsDraft), draftB, "b's draft is kept separately");
  assert.equal(browser.sent.filter((request) => request.path === "/api/guidance/thread-policy").length, 1);
  for (const stop of stops) stop();
  registry.dispose();
});

it("A-R18-03 a definitions read records its environment, a draft never holds another environment's view, and the editor's reports count only in their environment", { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.state.reply = (request) => request.path === "/api/csrf" ? json({ csrf: "csrf-1" }) : json(loadedDefinitions("a".repeat(64)));
  const registry = AtomRegistry.make();
  const read = definitionsApi.projectDefinitionsAtom(definitionsApi.definitionsReadKey("environment-a", "project", null, 0));
  const stop = registry.mount(read);
  const loaded = await until(registry, read, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the read of a");
  assert.equal(AsyncResult.isSuccess(loaded) && loaded.value.environmentId, "environment-a", "the read records its environment");
  stop();
  registry.dispose();

  const viewOf = (environmentId: string, revision = 0) => ({ key: JSON.stringify([environmentId, "project", "", revision, true]),
    read: definitionsApi.definitionsReadKey(environmentId, "project", null, 0), environmentId });
  const heldA = viewOf("environment-a");
  assert.equal(definitions.heldView(heldA, viewOf("environment-a", 1), true), heldA, "a draft holds its own environment's view");
  assert.deepEqual(definitions.heldView(heldA, viewOf("environment-b"), true), viewOf("environment-b"), "a draft of a never holds the view of b");
  const report = { environmentId: "environment-a", dirty: true, saving: true };
  const reported = definitions.recordReport(definitions.noCompletion, "environment-a", { dirty: true, saving: true });
  assert.deepEqual(definitions.reportOf(reported, "environment-a"), report);
  assert.deepEqual(definitions.reportOf(reported, "environment-b"), { environmentId: "environment-b", dirty: false, saving: false },
    "a's dirty or saving editor neither holds nor blocks b");
});
