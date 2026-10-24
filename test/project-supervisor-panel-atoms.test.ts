import assert from "node:assert/strict";
import { beforeAll, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Result } from "effect";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { TestClock } from "effect/testing";
import type { ProjectSupervisorInfo, ProjectSupervisorSaveInput } from "../src/project-supervisor-contract.js";
import type { WorkflowProgressSnapshot } from "../src/workflow-progress.js";
import { supervisorSnapshot } from "./support/c3b-project-supervisor.js";
import { heldResponse, installGlobal, scopedRegistry } from "./support/g7-page.js";
import { abortOf, until } from "./support/g7-browser.js";

// target regressions of the project supervisor panel atoms (WP-S7-PS) over a stubbed browser: drafts and reads, admitted
// settings and chat changes, the chat supervision poll and live progress pages. the tests wait only for requests and atom
// values (bounded on the live clock), so they are it.effect; the confirming read's 10 s deadline is stepped on the test
// clock of the fiber that runs it

interface Sent {readonly method: string; readonly path: string; readonly query: URLSearchParams; readonly body: unknown; readonly signal: AbortSignal | null;
  readonly session: string | null; readonly csrf: string | null}
const sent: Sent[] = [];
let reply: (request: Sent) => Promise<Response> = async () => new Response("{}", {status: 500});
const storage = new Map<string, string>();

type Core = typeof import("../ui/src/atoms.js");
type Panel = typeof import("../ui/src/project-supervisor.js");
type Access = typeof import("../ui/src/access.js");
let core: Core;
let ps: Panel;
let access: Access;

// the stubbed browser, installed before the ui modules load and put back when the suite's scope closes
beforeAll(() => Effect.gen(function* () {
  yield* installGlobal("location", {origin: "http://supervisor.test", pathname: "/"});
  yield* installGlobal("window", new EventTarget());
  yield* installGlobal("document", {visibilityState: "visible", hidden: false, addEventListener: () => {}, removeEventListener: () => {}});
  yield* installGlobal("localStorage", {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => {storage.set(key, value);},
    removeItem: (key: string) => {storage.delete(key);}});
  yield* installGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://supervisor.test");
    const body = init?.body instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(init.body)) as unknown : undefined;
    const request = {method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body, signal: init?.signal ?? null,
      session: new Headers(init?.headers).get("x-supervisor-session"), csrf: new Headers(init?.headers).get("x-csrf-token")};
    sent.push(request);
    return reply(request);
  });
  storage.set("supervisor-session", "session-1");
  core = yield* Effect.promise(() => import("../ui/src/atoms.js"));
  ps = yield* Effect.promise(() => import("../ui/src/project-supervisor.js"));
  access = yield* Effect.promise(() => import("../ui/src/access.js"));
}));

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
const isPost = (path: string) => (request: Sent) => request.method === "POST" && request.path === path;
const isRead = (request: Sent) => request.method === "GET" && request.path === "/api/guidance/project-supervisor";

const snapshot: ProjectSupervisorInfo = supervisorSnapshot;
const scopeA = () => core.scopeKey("project", "task-thread");
const projectKey = () => ps.projectSupervisorKey(null, "project");
const saveInput = (expectedGeneration: number): ProjectSupervisorSaveInput => ({projectId: "project", mainThreadId: "task-thread", expectedGeneration,
  modelSelection: snapshot.settings.modelSelection, monitoring: {intervalMinutes: 2, activityThreshold: 10}, teamSettings: {maxHelpersPerRoot: 3}});
// a panel showing the snapshot for chat A with a dirty monitoring draft
const showSnapshot = (registry: AtomRegistry.AtomRegistry) => {
  const shown = ps.settleRead({view: registry.get(ps.projectSupervisorView(projectKey())), draft: null}, "project", scopeA(), {snapshot, readAt: 1}, false);
  registry.set(ps.projectSupervisorView(projectKey()), {...shown.view, scope: scopeA()});
  assert.ok(shown.draft);
  registry.set(ps.projectSupervisorDraft(projectKey()), {...shown.draft, monitoringValue: {intervalMinutes: "12", activityThreshold: "10"}});
};

it("a read keeps every dirty draft field, moves only clean fields and the expected generation, and only an explicit refresh reads over a dirty shown draft", {timeout: 10_000}, () => {
  const first = ps.mergeLoadedDraft(null, "project", snapshot);
  assert.equal(first.keptDirty, false);
  assert.equal(first.draft.expectedGeneration, 7);
  const edited = {...first.draft, monitoringValue: {intervalMinutes: "12", activityThreshold: "10"}};
  const newer = {...snapshot, settings: {...snapshot.settings, generation: 8, modelSelection: {instanceId: "provider-one", model: "steady-model", options: []},
    monitoring: {intervalMinutes: 2, activityThreshold: 20}}};
  const merged = ps.mergeLoadedDraft(edited, "project", newer);
  assert.deepEqual(merged.draft.monitoringValue, {intervalMinutes: "12", activityThreshold: "10"}, "the dirty field keeps the user's value");
  assert.deepEqual(merged.draft.monitoringBaseline, {intervalMinutes: "2", activityThreshold: "20"});
  assert.deepEqual(merged.draft.modelValue, newer.settings.modelSelection, "a clean field takes the new saved value");
  assert.equal(merged.draft.expectedGeneration, 8);
  assert.equal(merged.keptDirty, true);

  const view = {scope: "s", snapshot: null, readAt: null, message: null, blocked: true, operation: null, chat: null, chatMessage: null};
  const refreshed = ps.settleRead({view, draft: edited}, "project", "s", {snapshot: newer, readAt: 5}, true);
  assert.equal(refreshed.view.blocked, false, "a verified read lifts the block after an unconfirmed outcome");
  assert.deepEqual(refreshed.view.message, {scope: "s", alert: false, text: "Supervisor status refreshed. Your unsaved draft was kept against the latest saved generation."});
  assert.equal(ps.settleRead({view, draft: first.draft}, "project", "s", {snapshot: newer, readAt: 5}, true).view.message?.text, "Supervisor status refreshed from T3.");
  assert.equal(ps.settleRead({view, draft: edited}, "project", "s", {snapshot: newer, readAt: 5}, false).view.message, null, "an automatic read reports nothing");

  const panel = {projectId: "project", connected: true, saving: false, forceRefresh: false, dirty: true, shown: true, completedKey: null, requestKey: "k1"};
  assert.equal(ps.snapshotReadNeeded(panel), false, "no automatic read over a dirty draft of the shown snapshot");
  assert.equal(ps.snapshotReadNeeded({...panel, forceRefresh: true}), true, "an explicit refresh reads over it");
  assert.equal(ps.snapshotReadNeeded({...panel, forceRefresh: true, saving: true}), false, "nothing reads while saving");
  assert.equal(ps.snapshotReadNeeded({...panel, shown: false}), true, "another chat's snapshot is read and merged");
  assert.equal(ps.snapshotReadNeeded({...panel, dirty: false, completedKey: "k1"}), false, "each scope revision is read once");
  assert.equal(ps.snapshotReadNeeded({...panel, dirty: false, connected: false}), false);
});

it.effect("a save is admitted once against the draft's expected generation and applies its verified outcome with no panel mounted", () => Effect.gen(function* () {
  const registry = yield* scopedRegistry();
  sent.length = 0;
  showSnapshot(registry);
  const post = yield* heldResponse;
  reply = async request => {
    if (!isPost("/api/guidance/project-supervisor")(request)) return json({}, 500);
    post.arrive();
    return post.response;
  };
  ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
  ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
  yield* post.reached;
  const operation = registry.get(ps.projectSupervisorView(projectKey())).operation;
  assert.equal(operation?.kind, "save", "the panel is saving");
  const saved = {...snapshot, settings: {...snapshot.settings, generation: 8, monitoring: {intervalMinutes: 2, activityThreshold: 10}}};
  post.release(json({status: "saved", message: "Supervisor settings saved.", snapshot: saved}));
  const view = yield* until(registry, ps.projectSupervisorView(projectKey()), value => value.operation === null, "saved");
  const posts = sent.filter(isPost("/api/guidance/project-supervisor"));
  assert.equal(posts.length, 1, "a second click while saving sends nothing");
  assert.equal((posts[0]!.body as ProjectSupervisorSaveInput).expectedGeneration, 7, "the save carries the generation the draft was edited against");
  assert.deepEqual(view.message, {scope: scopeA(), text: "Supervisor settings saved.", alert: false});
  assert.equal(view.blocked, false);
  assert.equal(view.snapshot?.settings.generation, 8);
  const draft = registry.get(ps.projectSupervisorDraft(projectKey()));
  assert.equal(draft?.expectedGeneration, 8);
  assert.deepEqual(draft?.monitoringValue, draft?.monitoringBaseline, "a verified save clears the draft");
  // writing the finished operation again replays nothing and applies nothing
  const key = {scope: scopeA(), operationId: operation!.operationId};
  registry.set(ps.saveSupervisorSettings(core.scopeKey(key.scope, key.operationId)), {projectKey: projectKey(), key, input: saveInput(7)});
  assert.equal(sent.filter(isPost("/api/guidance/project-supervisor")).length, 1);
  registry.dispose();
}), {timeout: 10_000});

it.effect("an unconfirmed save keeps the draft and blocks until a read, a refused save keeps it editable, and conflicts keep edits against the latest generation", () => Effect.gen(function* () {
  for (const [label, status, csrf, blocked, text] of [
    ["500", 500, 200, true, "The operation outcome could not be confirmed. Refresh Supervisor settings before trying again."],
    ["403 refreshed", 403, 200, false, "Session refreshed. Your Supervisor change was not performed; review the state and try again."],
    // target change (story03): a 401 for the sent session does not exclude a first attempt the browser resent after it applied
    ["401 refresh failed", 401, 401, true, "The operation outcome could not be confirmed. Refresh Supervisor settings before trying again."],
  ] as const) {
    storage.set("supervisor-session", "session-1");
    const registry = yield* scopedRegistry();
    sent.length = 0;
    showSnapshot(registry);
    const before = registry.get(ps.projectSupervisorDraft(projectKey()));
    reply = async request => request.path === "/api/csrf" ? json({csrf: "fresh"}, csrf) : json({message: "no"}, status);
    ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
    const view = yield* until(registry, ps.projectSupervisorView(projectKey()), value => value.operation === null, label);
    assert.equal(view.blocked, blocked, label);
    assert.deepEqual(view.message, {scope: scopeA(), text, alert: blocked}, label);
    assert.deepEqual(registry.get(ps.projectSupervisorDraft(projectKey())), before, `${label}: the draft is kept`);
    assert.equal(sent.filter(isPost("/api/guidance/project-supervisor")).length, 1, `${label}: never replayed`);
    registry.dispose();
  }
  storage.set("supervisor-session", "session-1");

  const draft = {...ps.mergeLoadedDraft(null, "project", snapshot).draft, monitoringValue: {intervalMinutes: "12", activityThreshold: "10"}};
  const view = {scope: "s", snapshot, readAt: 1, message: null, blocked: false, operation: null, chat: null, chatMessage: null};
  const newer = {...snapshot, settings: {...snapshot.settings, generation: 9}};
  const conflict = ps.settleSave({view, draft}, "s", saveInput(7), Result.succeed({status: "conflict", message: "Settings changed elsewhere.", snapshot: newer}));
  assert.deepEqual(conflict.draft?.monitoringValue, draft.monitoringValue, "a conflict keeps the edits");
  assert.equal(conflict.draft?.expectedGeneration, 9, "and moves them to the latest generation");
  assert.deepEqual([conflict.view.blocked, conflict.view.message?.text], [false, "Settings changed elsewhere."]);
  const blind = ps.settleSave({view, draft}, "s", saveInput(7), Result.succeed({status: "conflict", message: "Settings changed elsewhere.", snapshot: null}));
  assert.deepEqual([blind.view.blocked, blind.view.message?.text], [true, "Settings changed elsewhere. Refresh Supervisor status before trying again."]);
  const unread = ps.settleSave({view, draft}, "s", saveInput(7), Result.succeed({status: "saved", message: "Saved.", snapshot: null}));
  assert.deepEqual([unread.view.blocked, unread.view.message?.text], [true, "Saved. Refresh Supervisor status before making another change."]);
  const uncertain = ps.settleSave({view, draft}, "s", saveInput(7), Result.succeed({status: "uncertain", message: "Outcome unknown.", snapshot: null}));
  assert.deepEqual([uncertain.view.blocked, uncertain.view.message?.alert, uncertain.draft], [true, true, draft]);
  assert.equal(ps.settleRead(uncertain, "project", "s", {snapshot: newer, readAt: 2}, true).view.blocked, false, "only a read lifts the block");
}), {timeout: 10_000});

// story03 of the UI replay: the server holds a save while the session ends, the connection then drops and the browser
// resends the request with its original headers, so the page sees only the resend's pre-body 401. the first attempt may
// have been applied, so the outcome stays unconfirmed and Save stays blocked until a verified read under a new session
const endSession: Record<string, (registry: AtomRegistry.AtomRegistry) => Effect.Effect<void>> = {
  // another tab signs out everywhere: it removes the shared session and this tab receives the storage event
  "another tab signs out": () => Effect.sync(() => {
    storage.delete("supervisor-session");
    const event = new Event("storage");
    Object.defineProperties(event, {key: {value: "supervisor-session"}, storageArea: {value: globalThis.localStorage}});
    globalThis.window.dispatchEvent(event);
  }),
  // this tab's own access check finds the session expired and forgets it
  "this tab sees the session expire": registry => Effect.gen(function* () {
    const check = core.uiRuntime.fn(() => Effect.flatMap(access.SessionAccess, session => session.check));
    const stop = registry.subscribe(check, () => undefined, {immediate: true});
    registry.set(check, undefined);
    yield* until(registry, check, value => AsyncResult.isSuccess(value), "the expiry check");
    stop();
  }),
};

for (const [route, end] of Object.entries(endSession)) for (const applied of [false, true]) {
  it.effect(`a save held while ${route}, then refused 401 on the browser's resend after its connection dropped, stays unconfirmed and blocked until a verified read (first attempt ${applied ? "applied" : "not applied"})`, () => Effect.gen(function* () {
    storage.set("supervisor-session", "session-1");
    const registry = yield* scopedRegistry();
    sent.length = 0;
    showSnapshot(registry);
    const before = registry.get(ps.projectSupervisorDraft(projectKey()));
    const saved = {...snapshot, settings: {...snapshot.settings, generation: 8, monitoring: {intervalMinutes: 2, activityThreshold: 10}}};
    let server: ProjectSupervisorInfo = snapshot;
    const post = yield* heldResponse;
    reply = async request => {
      if (isPost("/api/guidance/project-supervisor")(request)) {post.arrive();return post.response;}
      const signedIn = request.session === "session-2";
      if (request.path === "/api/csrf") return signedIn ? json({csrf: "fresh"}) : json({message: "Sign in again."}, 401);
      if (isRead(request)) return signedIn ? json(server) : json({message: "Sign in again."}, 401);
      return json({}, 500);
    };
    ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
    yield* post.reached;
    assert.equal(sent.find(isPost("/api/guidance/project-supervisor"))?.session, "session-1", "the save went out with the valid session");
    if (applied) server = saved;
    yield* end(registry);
    assert.equal(storage.has("supervisor-session"), false, "the session ended while the save was out");
    // the held connection drops; the browser's resend carries the original headers and is refused before its body is read
    post.release(json({message: "Sign in again."}, 401));
    const view = yield* until(registry, ps.projectSupervisorView(projectKey()), value => value.operation === null, "settled");
    assert.deepEqual(view.message, {scope: scopeA(), alert: true,
      text: "The operation outcome could not be confirmed. Refresh Supervisor settings before trying again."}, "the refusal of the resend is not reported as not performed");
    assert.equal(view.blocked, true, "Save stays blocked");
    assert.deepEqual(registry.get(ps.projectSupervisorDraft(projectKey())), before, "the draft is kept");
    assert.equal(sent.filter(isPost("/api/guidance/project-supervisor")).length, 1, "the page sent the save once and replays nothing");

    // a new sign-in and a verified read show what the first attempt did and lift the block
    storage.set("supervisor-session", "session-2");
    const readAtom = ps.projectSupervisorRead({environmentId: null, projectId: "project", mainThreadId: "task-thread", revision: 1, epoch: 1});
    const stop = registry.subscribe(readAtom, () => undefined, {immediate: true});
    const read = yield* until(registry, readAtom, value => AsyncResult.isSuccess(value) && !value.waiting, "verified read");
    stop();
    assert.ok(AsyncResult.isSuccess(read));
    const refreshed = ps.settleRead({view, draft: registry.get(ps.projectSupervisorDraft(projectKey()))}, "project", scopeA(), read.value, true);
    assert.equal(refreshed.view.blocked, false, "only the verified read lifts the block");
    assert.equal(refreshed.view.snapshot?.settings.generation, applied ? 8 : 7, "the read shows what the first attempt did");
    assert.equal(refreshed.draft?.expectedGeneration, applied ? 8 : 7);
    registry.dispose();
    storage.set("supervisor-session", "session-1");
  }), {timeout: 10_000});
}

// story03, server side: the session or the server process ends while the save is held and before the tab sees any
// change (no storage event, no poll); the connection drops and the browser's resend, with the original headers, is
// refused. Neither refusal excludes a first attempt that applied, so the outcome stays unknown and Save stays blocked
// until a verified read
const serverEnds: Record<string, {status: 401 | 403; end: (server: {sessions: Set<string>; csrf: string}) => void}> = {
  "the server expires the session": {status: 401, end: server => {server.sessions.delete("session-1");}},
  // the CSRF token is per server process: a restart issues a new one, and the session survives in the access database
  "the server restarts": {status: 403, end: server => {server.csrf = "csrf-after-restart";}},
};

for (const [route, {status, end}] of Object.entries(serverEnds)) for (const applied of [false, true]) {
  it.effect(`a save held while ${route}, then refused ${status} on the browser's resend before the tab saw a change, stays unknown and blocked until a verified read (first attempt ${applied ? "applied" : "not applied"})`, () => Effect.gen(function* () {
    storage.set("supervisor-session", "session-1");
    const registry = yield* scopedRegistry();
    sent.length = 0;
    const server = {sessions: new Set(["session-1"]), csrf: "csrf-before-restart", snapshot: snapshot as ProjectSupervisorInfo};
    const post = yield* heldResponse;
    reply = async request => {
      if (isPost("/api/guidance/project-supervisor")(request)) {post.arrive();return post.response;}
      const valid = request.session !== null && server.sessions.has(request.session);
      if (request.path === "/api/csrf") return valid ? json({csrf: server.csrf}) : json({message: "Sign in to Supervisor."}, 401);
      if (isRead(request)) return valid ? json(server.snapshot) : json({message: "Sign in to Supervisor."}, 401);
      return json({}, 500);
    };
    // the page holds the CSRF token of the running process, as after its first access check
    const check = core.uiRuntime.fn(() => Effect.flatMap(access.SessionAccess, session => session.check));
    const stopCheck = registry.subscribe(check, () => undefined, {immediate: true});
    registry.set(check, undefined);
    yield* until(registry, check, value => AsyncResult.isSuccess(value) && value.value, "the token is loaded");
    stopCheck();
    showSnapshot(registry);
    const before = registry.get(ps.projectSupervisorDraft(projectKey()));
    ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
    yield* post.reached;
    const sentSave = sent.find(isPost("/api/guidance/project-supervisor"))!;
    assert.deepEqual([sentSave.session, sentSave.csrf], ["session-1", "csrf-before-restart"], "the save went out with a valid session and token");
    if (applied) server.snapshot = {...snapshot, settings: {...snapshot.settings, generation: 8, monitoring: {intervalMinutes: 2, activityThreshold: 10}}};
    end(server);
    assert.equal(storage.get("supervisor-session"), "session-1", "the tab saw no change before the refusal");
    post.release(json({message: "refused"}, status));
    const view = yield* until(registry, ps.projectSupervisorView(projectKey()), value => value.operation === null, "settled");
    assert.deepEqual(view.message, {scope: scopeA(), alert: true,
      text: "The operation outcome could not be confirmed. Refresh Supervisor settings before trying again."}, "the resend's refusal is not reported as not performed");
    assert.equal(view.blocked, true, "Save stays blocked");
    assert.deepEqual(registry.get(ps.projectSupervisorDraft(projectKey())), before, "the draft is kept");
    assert.equal(sent.filter(isPost("/api/guidance/project-supervisor")).length, 1, "the page sent the save once and replays nothing");

    // a valid session (the same one after a restart, a new sign-in after the expiry) and a verified read lift the block
    if (!server.sessions.has("session-1")) {server.sessions.add("session-2");storage.set("supervisor-session", "session-2");}
    const readAtom = ps.projectSupervisorRead({environmentId: null, projectId: "project", mainThreadId: "task-thread", revision: 2, epoch: 2});
    const stop = registry.subscribe(readAtom, () => undefined, {immediate: true});
    const read = yield* until(registry, readAtom, value => AsyncResult.isSuccess(value) && !value.waiting, "verified read");
    stop();
    assert.ok(AsyncResult.isSuccess(read));
    const refreshed = ps.settleRead({view, draft: registry.get(ps.projectSupervisorDraft(projectKey()))}, "project", scopeA(), read.value, true);
    assert.equal(refreshed.view.blocked, false, "only the verified read lifts the block");
    assert.equal(refreshed.view.snapshot?.settings.generation, applied ? 8 : 7, "the read shows what the first attempt did");
    registry.dispose();
    storage.set("supervisor-session", "session-1");
  }), {timeout: 10_000});
}

// the refusals that do exclude the first attempt stay definite: the check refuses the same headers on every attempt
it.effect("a change sent without a CSRF token, or with the token the same process still issues, is refused as not performed and stays editable", () => Effect.gen(function* () {
  for (const [label, token] of [["without a token", null], ["with the token the process still issues", "csrf-current"]] as const) {
    storage.set("supervisor-session", "session-1");
    const registry = yield* scopedRegistry();
    sent.length = 0;
    reply = async request => {
      if (request.path === "/api/csrf") return json({csrf: "csrf-current"});
      return json({message: "Refresh the local dashboard before changing settings."}, 403);
    };
    if (token !== null) {
      const check = core.uiRuntime.fn(() => Effect.flatMap(access.SessionAccess, session => session.check));
      const stopCheck = registry.subscribe(check, () => undefined, {immediate: true});
      registry.set(check, undefined);
      yield* until(registry, check, value => AsyncResult.isSuccess(value) && value.value, "the token is loaded");
      stopCheck();
      sent.length = 0;
    }
    showSnapshot(registry);
    ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
    const view = yield* until(registry, ps.projectSupervisorView(projectKey()), value => value.operation === null, label);
    assert.equal(sent.find(isPost("/api/guidance/project-supervisor"))?.csrf ?? null, token === null ? "" : token, `${label}: the token sent`);
    assert.deepEqual([view.blocked, view.message?.text], [false, "Session refreshed. Your Supervisor change was not performed; review the state and try again."], label);
    registry.dispose();
  }
}), {timeout: 10_000});

it.effect("a settings outcome that arrives after another chat was selected is dropped", () => Effect.gen(function* () {
  const registry = yield* scopedRegistry();
  sent.length = 0;
  showSnapshot(registry);
  const before = registry.get(ps.projectSupervisorDraft(projectKey()));
  const post = yield* heldResponse;
  reply = async () => {post.arrive();return post.response;};
  ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
  yield* post.reached;
  registry.update(ps.projectSupervisorView(projectKey()), view => ({...view, scope: core.scopeKey("project", "other-thread")}));
  post.release(json({status: "saved", message: "Saved.", snapshot: {...snapshot, settings: {...snapshot.settings, generation: 8}}}));
  const view = yield* until(registry, ps.projectSupervisorView(projectKey()), value => value.operation === null, "dropped");
  assert.equal(view.message, null);
  assert.equal(view.snapshot?.settings.generation, 7);
  assert.deepEqual(registry.get(ps.projectSupervisorDraft(projectKey())), before);
  registry.dispose();
}), {timeout: 10_000});

it.effect("a chat Stop is admitted once, confirmed by a follow-up read for its own project and chat, and dropped for a chat selected afterwards", () => Effect.gen(function* () {
  const registry = yield* scopedRegistry();
  sent.length = 0;
  showSnapshot(registry);
  const stopped = {...snapshot, chatSupervision: {...snapshot.chatSupervision!, stopped: true, policyGeneration: 5, stoppedBy: "ui" as const, stoppedAt: 2}};
  reply = async request => isRead(request) ? json(stopped) : json({status: "saved", message: "Supervision is stopped for this chat.", snapshot: null});
  const input = {projectId: "project", mainThreadId: "task-thread", enabled: false, policyGeneration: 4};
  ps.startChatSupervisionChange(registry, projectKey(), scopeA(), input);
  ps.startChatSupervisionChange(registry, projectKey(), scopeA(), input);
  const view = yield* until(registry, ps.projectSupervisorView(projectKey()), value => value.chat === null, "confirmed");
  assert.deepEqual(sent.map(request => [request.method, request.path]), [["POST", "/api/guidance/project-supervisor/chat-supervision"], ["GET", "/api/guidance/project-supervisor"]]);
  assert.deepEqual(sent[0]!.body, input);
  assert.deepEqual([sent[1]!.query.get("projectId"), sent[1]!.query.get("mainThreadId")], ["project", "task-thread"], "the confirming read is for the same chat");
  assert.equal(view.snapshot?.chatSupervision?.stopped, true);
  assert.deepEqual(view.chatMessage, {scope: scopeA(), text: "Supervision is stopped for this chat."});

  sent.length = 0;
  const post = yield* heldResponse;
  reply = async request => {
    if (isRead(request)) return json(snapshot);
    post.arrive();
    return post.response;
  };
  ps.startChatSupervisionChange(registry, projectKey(), scopeA(), {...input, enabled: true, policyGeneration: 5});
  yield* post.reached;
  registry.update(ps.projectSupervisorView(projectKey()), current => ({...current, scope: core.scopeKey("project", "other-thread")}));
  post.release(json({status: "saved", message: "Supervision is enabled for this chat.", snapshot: null}));
  const late = yield* until(registry, ps.projectSupervisorView(projectKey()), value => value.chat === null, "dropped");
  assert.equal(late.chatMessage, null, "a late outcome never replaces another chat's view");
  assert.deepEqual(sent.map(request => request.method), ["POST"], "no confirming read for a chat that is no longer selected");
  registry.dispose();
}), {timeout: 10_000});

it.effect("the read that confirms a chat change gives up after 10 s and aborts its request", () => Effect.gen(function* () {
  sent.length = 0;
  const request = yield* heldResponse;
  reply = async sentRequest => {
    request.arrive();
    return new Promise<Response>((_resolve, reject) => sentRequest.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  const registry = yield* scopedRegistry();
  const fiber = yield* Effect.forkChild(Effect.exit(ps.chatSupervisionConfirmRead("project", "task-thread").pipe(Effect.provide(registry.get(core.uiRuntime.layer)))));
  yield* request.reached;
  yield* TestClock.adjust("9999 millis");
  assert.equal(fiber.pollUnsafe(), undefined, "still waiting before 10 s");
  yield* TestClock.adjust("1 millis");
  const exit = yield* Fiber.join(fiber);
  assert.ok(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof Cause.TimeoutError);
  assert.equal(sent[0]?.signal?.aborted, true);
  request.release(json({}));
  registry.dispose();
}), {timeout: 10_000});

it.effect("the chat refresh reads nothing when mounted, re-reads on each refresh and updates live task records without moving configured form baselines; it is not mounted while a change is in flight", () => Effect.gen(function* () {
  const idle = {scope: scopeA(), snapshot, readAt: 1, message: null, blocked: false, operation: null, chat: null, chatMessage: null};
  const panel = {projectId: "project", threadId: "task-thread", connected: true, epoch: 0};
  assert.deepEqual(ps.chatRefreshScope(idle, panel), {projectId: "project", mainThreadId: "task-thread", epoch: 0});
  assert.equal(ps.chatRefreshScope({...idle, operation: {kind: "save", scope: scopeA(), operationId: "save-1"}}, panel), null, "no automatic refresh while saving");
  assert.equal(ps.chatRefreshScope({...idle, chat: {scope: scopeA(), operationId: "chat-1"}}, panel), null, "no automatic refresh while changing chat supervision");
  assert.equal(ps.chatRefreshScope(idle, {...panel, connected: false}), null);
  assert.equal(ps.chatRefreshScope(idle, {...panel, threadId: undefined}), null);

  const registry = yield* scopedRegistry();
  sent.length = 0;
  const stopped: ProjectSupervisorInfo = {...snapshot, message: "a newer message", settings: {...snapshot.settings, generation: snapshot.settings.generation + 1},
    tasks: snapshot.tasks.map(task => ({...task, reason: "A newly authorized scope", engagement: {mode: "engaged", availability: "current", consideredAt: 2}})), chatSupervision: {...snapshot.chatSupervision!, stopped: true, stoppedBy: "relay" as const, stoppedAt: 3}};
  reply = async () => json(stopped);
  const scope = {environmentId: null, projectId: "project", mainThreadId: "task-thread", epoch: 0};
  const stop = registry.subscribe(ps.chatSupervisionLive(scope), () => undefined, {immediate: true});
  yield* until(registry, ps.chatSupervisionRead(scope), value => AsyncResult.isSuccess(value) && !value.waiting, "mounted");
  assert.equal(sent.filter(request => request.path !== "/api/events").length, 0, "mounting reads no typed query");
  registry.refresh(ps.chatSupervisionRead(scope));
  const polled = yield* until(registry, ps.chatSupervisionRead(scope), value => AsyncResult.isSuccess(value) && !value.waiting && value.value._tag === "Some", "polled");
  assert.equal(sent.filter(request => request.path !== "/api/events").length, 1);
  const read = AsyncResult.isSuccess(polled) && polled.value._tag === "Some" ? polled.value.value : snapshot;
  const next = ps.settleChatRefresh(idle, scopeA(), read);
  assert.equal(next.snapshot?.chatSupervision?.stopped, true);
  assert.equal(next.snapshot?.message, stopped.message);
  assert.equal(next.snapshot?.tasks[0]?.engagement?.mode, "engaged", "the newly authorized task replaces quiet Following metadata");
  assert.equal(next.snapshot?.tasks[0]?.reason, "A newly authorized scope");
  assert.equal(next.snapshot?.settings.generation, snapshot.settings.generation, "form baselines remain pinned until explicit refresh");
  assert.equal(ps.settleChatRefresh({...idle, blocked: true}, scopeA(), read).blocked, true, "a background read does not clear an unknown mutation fence");
  assert.equal(ps.settleChatRefresh({...idle, operation: {kind: "save", scope: scopeA(), operationId: "save-2"}}, scopeA(), read).snapshot, snapshot);
  stop();
  registry.dispose();
}), {timeout: 10_000});

const page = (workflowOffset: number, lineageOffset: number, status: WorkflowProgressSnapshot["status"] = "ok"): WorkflowProgressSnapshot => ({
  status, message: status === "ok" ? null : "Workflow data is not available for this page.", projectId: "project", mainThreadId: "task-thread", observedAt: 1,
  scope: null, incompatibleWorkflows: [], workflows: [], workflowOffset, workflowHasMore: true, lineageOffset, lineageHasMore: false,
});

it.effect("live progress appends Load more pages, re-reads the loaded pages in order and keeps the shown pages when a refresh fails or comes back incomplete", () => Effect.gen(function* () {
  const registry = yield* scopedRegistry();
  sent.length = 0;
  let mode: "ok" | "fail" | "incomplete" = "ok";
  reply = async request => {
    const workflowOffset = Number(request.query.get("workflowOffset"));
    const lineageOffset = Number(request.query.get("lineageOffset"));
    if (mode === "fail") return json({message: "unavailable"}, 500);
    return json(page(workflowOffset, lineageOffset, mode === "incomplete" ? "unavailable" : "ok"));
  };
  const scope = {environmentId: null, projectId: "project", mainThreadId: "task-thread", bindingThreadId: null, bindingGeneration: null, epoch: 0};
  const read = ps.workflowProgressRead(scope);
  const settled = (predicate: (state: {pages: readonly WorkflowProgressSnapshot[]; error: string | null}) => boolean, label: string) =>
    until(registry, read, value => AsyncResult.isSuccess(value) && !value.waiting && predicate(value.value), label)
      .pipe(Effect.map(value => AsyncResult.isSuccess(value) ? value.value : assert.fail(label)));
  const stop = registry.subscribe(read, () => undefined, {immediate: true});
  const offsets = () => sent.map(request => request.query.get("workflowOffset"));
  const first = yield* settled(state => state.pages.length === 1, "first page");
  assert.deepEqual(offsets(), ["0"]);
  assert.equal(first.error, null);

  sent.length = 0;
  registry.update(ps.workflowProgressMore(scope), current => ({seq: current.seq + 1, page: {workflowOffset: 20, lineageOffset: 0}}));
  const two = yield* settled(state => state.pages.length === 2, "load more");
  assert.deepEqual(offsets(), ["20"], "load more reads only the next page");

  sent.length = 0;
  mode = "fail";
  registry.refresh(read);
  const failed = yield* settled(state => state.error !== null, "failed refresh");
  assert.equal(failed.error, "Progress could not be refreshed. The last successful snapshot is retained.");
  assert.deepEqual(failed.pages, two.pages, "a failed refresh keeps the shown pages");

  sent.length = 0;
  mode = "incomplete";
  registry.refresh(read);
  const incomplete = yield* settled(state => state.error === "Workflow data is not available for this page.", "incomplete refresh");
  assert.deepEqual(incomplete.pages, two.pages, "an incomplete refresh keeps the shown pages");
  assert.deepEqual(offsets(), ["0"], "the refresh stops after the first page that is not ok");

  sent.length = 0;
  mode = "ok";
  registry.refresh(read);
  const refreshed = yield* settled(state => state.error === null, "refresh");
  assert.deepEqual(offsets(), ["0", "20"], "a refresh re-reads the loaded pages in order");
  assert.equal(refreshed.pages.length, 2);

  mode = "fail";
  registry.update(ps.workflowProgressMore(scope), current => ({seq: current.seq + 1, page: {workflowOffset: 40, lineageOffset: 0}}));
  const more = yield* settled(state => state.error !== null, "failed load more");
  assert.equal(more.error, "The next progress page could not be loaded. The last successful snapshot is retained.");
  assert.deepEqual(more.pages, refreshed.pages);
  stop();

  const other = ps.workflowProgressRead({...scope, mainThreadId: "other-thread"});
  const stopOther = registry.subscribe(other, () => undefined, {immediate: true});
  const unread = yield* until(registry, other, value => AsyncResult.isSuccess(value) && !value.waiting, "first read failure");
  assert.deepEqual(AsyncResult.isSuccess(unread) ? [unread.value.pages, unread.value.error] : [], [[], "Progress could not be loaded for this main conversation."]);
  stopOther();
  registry.dispose();
}), {timeout: 10_000});

it.effect("a new scope revision interrupts the snapshot read of the previous one and aborts its request", () => Effect.gen(function* () {
  const registry = yield* scopedRegistry();
  sent.length = 0;
  const first = yield* heldResponse;
  let signal!: AbortSignal;
  reply = async request => {
    if (sent.length > 1) return json(snapshot);
    signal = request.signal!;
    first.arrive();
    return first.response;
  };
  const previous = ps.projectSupervisorRead({environmentId: null, projectId: "project", mainThreadId: "task-thread", revision: 0, epoch: 0});
  const stopPrevious = registry.subscribe(previous, () => undefined, {immediate: true});
  yield* first.reached;
  stopPrevious();
  const next = ps.projectSupervisorRead({environmentId: null, projectId: "project", mainThreadId: "task-thread", revision: 1, epoch: 0});
  const stopNext = registry.subscribe(next, () => undefined, {immediate: true});
  const read = yield* until(registry, next, value => AsyncResult.isSuccess(value) && !value.waiting, "next revision");
  assert.equal(AsyncResult.isSuccess(read) ? read.value.snapshot.projectId : null, "project");
  yield* abortOf(signal);
  assert.equal(sent[0]?.signal?.aborted, true, "the previous read was interrupted");
  assert.ok(AsyncResult.isInitial(registry.get(previous)) || !AsyncResult.isSuccess(registry.get(previous)), "the previous read never settles as a success");
  first.release(json(snapshot));
  stopNext();
  registry.dispose();
}), {timeout: 10_000});
