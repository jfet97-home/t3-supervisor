/// <reference types="vite/client" />
// the shell imports its stylesheet, which the vite client types declare for the root type check
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, it } from "@effect/vitest";
import { Effect } from "effect";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import { clockedRegistry, scopedRegistry } from "./support/g7-page.js";
import { json, makeBrowser, nextTurn, until } from "./support/g7-browser.js";
import { countedRegistry, elapse } from "./support/s8ui-clock.js";

// target regressions of the dashboard shell over atoms (CT-UI-SHELL-01): the 5 s snapshot refresh, the retained last
// snapshot and its alert, the access refreshes, sign-in and sign-out, and drafts surviving expiry and re-sign-in. the
// waits for a request or an atom value are bounded on the live clock. the snapshot refresh runs on the page runtime, so
// the refresh tests step its intervals with TestClock on the runtime's clock

// importing the shell mounts its root; only the React root renderer is replaced, nothing it renders is under test here
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => undefined }) }));

const browser = makeBrowser();
type Shell = typeof import("../ui/src/main.js");
type Access = typeof import("../ui/src/access.js");
type Atoms = typeof import("../ui/src/atoms.js");
let shell: Shell;
let access: Access;
let atoms: Atoms;

beforeAll(() => Effect.gen(function* () {
  yield* browser.install;
  browser.state.root = {};
  access = yield* Effect.promise(() => import("../ui/src/access.js"));
  atoms = yield* Effect.promise(() => import("../ui/src/atoms.js"));
  shell = yield* Effect.promise(() => import("../ui/src/main.js"));
}));

// the session stored for the SessionAccess of a registry's page runtime
const storedSession = (registry: AtomRegistry.AtomRegistry) => Effect.suspend(() => {
  const runtime = registry.get(atoms.uiRuntime);
  assert.ok(AsyncResult.isSuccess(runtime));
  return Effect.flatMap(access.SessionAccess, (service) => service.session).pipe(Effect.provide(runtime.value));
});

const snapshot = (connected: boolean, tokensUsed = 0) => ({
  environmentId: "environment", serverVersion: "build", connected, lastCycleAt: 1, sendingReady: true, sendingReason: "",
  settings: { generation: 1, guidancePaused: false, monitoringPaused: false, allowFollowupRace: false, verifiedServerVersion: null, model: "model",
    reasoning: "low", dailyTokenBudget: 1, evidenceHours: 1, maxAnchorAgeSeconds: 1 },
  threadPolicy: { generation: 1, excludedThreadIds: [] }, threads: [], projects: [], rules: [], mutes: [], activity: [], coverage: "", tokensUsed,
});
const snapshots = () => browser.sent.filter((request) => request.path === "/api/guidance/snapshot");
const csrfReads = () => browser.sent.filter((request) => request.path === "/api/csrf");
const settled = (registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>) =>
  until(registry, atom, (result) => AsyncResult.isNotInitial(result) && !result.waiting, "the action settled");
const session = "A".repeat(43);

it.effect("the snapshot refreshes every 5 s while mounted, also while the page is hidden, and stops when unmounted", () => Effect.gen(function* () {
  assert.equal(shell.snapshotRefreshMillis, 5_000);
  assert.equal(shell.dashboardSnapshot, shell.snapshotPoll(5_000));
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  browser.state.reply = () => json(snapshot(true));
  const registry = yield* clockedRegistry(atoms.uiRuntime);
  // the dashboard's own 5 s interval: it passes only on the page runtime's clock, never within the live bounds
  const stop = registry.subscribe(shell.dashboardSnapshot, () => undefined, { immediate: true });
  // two intervals pass on the page runtime's clock
  yield* TestClock.adjust("10 seconds");
  yield* browser.request(() => snapshots().length >= 3, "two refreshes after the first read");
  browser.state.visibility = "hidden";
  const hidden = snapshots().length;
  // two more intervals pass while hidden
  yield* TestClock.adjust("10 seconds");
  yield* browser.request(() => snapshots().length >= hidden + 2, "refreshes while hidden");
  browser.state.visibility = "visible";
  stop();
  yield* until(registry, shell.dashboardSnapshot, (result) => !result.waiting, "the last refresh");
  registry.dispose();
  const after = snapshots().length;
  // six intervals pass on the page runtime's clock after unmounting
  yield* elapse("30 seconds");
  assert.equal(snapshots().length, after, "no refresh after unmount");
}), { timeout: 10_000 });

it.effect("a failed snapshot keeps the latest successful read with the drafts-kept alert, and access refreshes when reads start failing and when T3 reconnects", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  let answer = () => json(snapshot(true, 1));
  browser.state.reply = (request) => request.path === "/api/csrf" ? json({ csrf: "csrf-1" }) : answer();
  const registry = yield* scopedRegistry();
  assert.deepEqual(shell.snapshotView(AsyncResult.initial()), { data: null, connected: false, alert: "" });
  const stopRefresh = registry.subscribe(shell.accessRefresh, () => undefined, { immediate: true });
  const stop = registry.subscribe(shell.dashboardSnapshot, () => undefined, { immediate: true });
  yield* until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the first snapshot");
  // the shell starts disconnected while the first snapshot loads, so its first connected snapshot is a reconnect
  yield* browser.request(() => csrfReads().length === 1, "the access refresh on the first connected snapshot");
  answer = () => json(snapshot(true, 2));
  registry.refresh(shell.dashboardSnapshot);
  yield* until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result) && !result.waiting && result.value.tokensUsed === 2, "the second snapshot");
  assert.equal(csrfReads().length, 1, "a further connected snapshot refreshes nothing");

  answer = () => json({ message: "Unavailable." }, 500);
  registry.refresh(shell.dashboardSnapshot);
  const failed = yield* until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isFailure(result) && !result.waiting, "the failed snapshot");
  const view = shell.snapshotView(failed);
  assert.equal(view.data?.tokensUsed, 2, "the latest successful snapshot is kept");
  assert.equal(view.data?.connected, false);
  assert.equal(view.connected, false);
  assert.equal(view.alert, "Supervisor connection unavailable. Your drafts are kept.");
  yield* browser.request(() => csrfReads().length === 2, "the access refresh on failure");
  registry.refresh(shell.dashboardSnapshot);
  const again = yield* until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isFailure(result) && !result.waiting, "a second failure");
  assert.equal(shell.snapshotView(again).data?.tokensUsed, 2, "repeated failures keep the latest success");
  assert.equal(csrfReads().length, 2, "access refreshes once when reads start failing");

  answer = () => json(snapshot(true, 3));
  registry.refresh(shell.dashboardSnapshot);
  yield* until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the reconnect");
  yield* browser.request(() => csrfReads().length === 3, "the access refresh on reconnect");
  assert.deepEqual(shell.snapshotView(registry.get(shell.dashboardSnapshot)).alert, "");
  stop();
  stopRefresh();
  registry.dispose();
}), { timeout: 10_000 });

it("Sign out is disabled while a draft or pending change exists", { timeout: 10_000 }, () => {
  const blocked = renderToStaticMarkup(createElement(shell.SignOutButton, { blocked: true, onSignOut: () => undefined }));
  assert.match(blocked, /disabled=""/u);
  assert.match(blocked, /aria-describedby="pending-changes"/u);
  assert.match(blocked, /title="Save drafts and resolve pending changes before signing out."/u);
  const open = renderToStaticMarkup(createElement(shell.SignOutButton, { blocked: false, onSignOut: () => undefined }));
  assert.equal(open, '<button class="quiet-button">Sign out</button>');
});

it.effect("CT-UI-SHELL-01 an expired session keeps the open dashboard and its drafts, asks to sign in again, and a re-sign-in stores the session once and restores them", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  let csrf = () => json({ csrf: "csrf-1" });
  let answer = () => json(snapshot(true));
  browser.state.reply = (request) => request.path === "/api/csrf" ? csrf() : request.path === "/auth/login" ? json({ authenticated: true, session }) : answer();
  const registry = yield* scopedRegistry();
  const stops = [shell.accessAtom, shell.dashboardOpened, shell.accessRefresh, shell.dashboardSnapshot, shell.signInState]
    .map((atom) => registry.subscribe(atom as Atom.Atom<unknown>, () => undefined, { immediate: true }));
  yield* until(registry, shell.dashboardOpened, (state) => state.opened, "the dashboard opened");
  yield* until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result), "the snapshot");
  const draft = { generation: 1, excludedThreadIds: ["thread-1"] };
  registry.set(shell.chatSettingsDraft, draft);

  // the server ends the session: the next snapshot fails and the access refresh finds it expired
  csrf = () => json({ message: "Sign in to Supervisor." }, 401);
  answer = () => json({ message: "Sign in to Supervisor." }, 401);
  registry.refresh(shell.dashboardSnapshot);
  yield* until(registry, shell.accessAtom, (result) => AsyncResult.isSuccess(result) && !result.waiting && result.value.state === "signedOut", "the expiry");
  assert.equal(browser.local.has("supervisor-session"), false, "the expired session is forgotten");
  assert.equal(registry.get(shell.dashboardOpened).opened, true, "the dashboard stays open behind Sign in again");
  assert.deepEqual(registry.get(shell.chatSettingsDraft), draft);
  assert.equal(shell.snapshotView(registry.get(shell.dashboardSnapshot)).alert, "Supervisor connection unavailable. Your drafts are kept.");
  // the expiry is a new auth epoch: the snapshot is read once more without a session and still fails
  yield* until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isFailure(result) && !result.waiting, "the re-read after the expiry");

  csrf = () => json({ csrf: "csrf-2" });
  answer = () => json(snapshot(true));
  browser.sent.length = 0;
  registry.set(shell.signInAction, "single-use-token");
  const signedIn = yield* settled(registry, shell.signInAction);
  assert.ok(AsyncResult.isSuccess(signedIn) && signedIn.value === true, "the form forgets the token");
  assert.deepEqual(registry.get(shell.signInState), { busy: false, error: "" });
  const login = browser.sent.find((request) => request.path === "/auth/login")!;
  assert.deepEqual([login.method, login.body, login.contentType, login.session], ["POST", JSON.stringify({ token: "single-use-token" }), "application/json", ""]);
  assert.equal(browser.local.get("supervisor-session"), session);
  assert.ok(![...browser.local.values(), ...browser.session.values()].some((value) => value.includes("single-use-token")), "the token is never stored");
  // the sign-in is a new auth epoch: the snapshot is read once more, and its first connected answer refreshes access as a
  // reconnect does
  yield* until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the re-read after the sign-in");
  yield* browser.request(() => csrfReads().length === 2, "the access refresh on reconnect");
  assert.deepEqual(browser.sent.map((request) => [request.path, request.session]).sort(),
    [["/api/csrf", session], ["/api/csrf", session], ["/api/guidance/snapshot", session], ["/auth/login", ""]],
    "one sign-in, one access check of the stored session, one snapshot re-read and the reconnect refresh");
  const check = registry.get(shell.accessAtom);
  assert.ok(AsyncResult.isSuccess(check) && check.value.state === "signedIn");
  assert.equal(registry.get(shell.dashboardOpened).opened, true);
  assert.deepEqual(registry.get(shell.chatSettingsDraft), draft, "the draft survives expiry and re-sign-in");
  for (const stop of stops) stop();
  registry.dispose();
}), { timeout: 10_000 });

it.effect("sign-in reports each refusal with its exact text and stores nothing it cannot verify", () => Effect.gen(function* () {
  const cases: Array<[string, () => Response, () => Response, boolean, string]> = [
    ["invalid token", () => json({ message: "The access token is invalid." }, 401), () => json({ csrf: "x" }), false, "The sign-in token is invalid, expired or already used."],
    ["server error", () => json({ message: "Unavailable." }, 500), () => json({ csrf: "x" }), false, "Could not sign in. Try again."],
    ["malformed session", () => json({ authenticated: true, session: "short" }), () => json({ csrf: "x" }), false, "Could not reach Supervisor. Try again."],
    ["blocked storage", () => json({ authenticated: true, session }), () => json({ csrf: "x" }), true, "Your browser blocked saved sign-in. Allow site storage for Supervisor and try again."],
    ["unconfirmed", () => json({ authenticated: true, session }), () => json({ message: "Refresh." }, 403), false, "Sign-in could not be confirmed. Try again."],
  ];
  for (const [label, login, csrf, blocked, message] of cases) {
    browser.local.clear();
    browser.state.reply = (request) => request.path === "/auth/login" ? login() : csrf();
    const registry = yield* scopedRegistry();
    const stop = registry.subscribe(shell.accessAtom, () => undefined, { immediate: true });
    yield* until(registry, shell.accessAtom, (result) => AsyncResult.isSuccess(result) && !result.waiting, `${label}: the first check`);
    browser.state.localBlocked = blocked;
    registry.set(shell.signInAction, "token");
    yield* settled(registry, shell.signInAction);
    browser.state.localBlocked = false;
    assert.deepEqual(registry.get(shell.signInState), { busy: false, error: message }, label);
    assert.equal(browser.local.get("supervisor-session") ?? null, label === "unconfirmed" ? session : null, label);
    stop();
    registry.dispose();
  }
}), { timeout: 10_000 });

it.effect("an unreachable server is told apart from a signed-out session", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  browser.state.reply = () => Promise.reject(new TypeError("Failed to fetch"));
  const registry = yield* scopedRegistry();
  const stop = registry.subscribe(shell.accessAtom, () => undefined, { immediate: true });
  const result = yield* until(registry, shell.accessAtom, (value) => AsyncResult.isSuccess(value) && !value.waiting, "the check");
  assert.ok(AsyncResult.isSuccess(result) && result.value.state === "unreachable");
  stop();
  registry.dispose();
}), { timeout: 10_000 });

it.effect("sign-out sends one request however often it is asked, forgets only its own session and closes the dashboard", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  let logout = () => json({ message: "Unavailable." }, 500);
  browser.state.reply = (request) => request.path === "/auth/logout" ? logout() : json({ csrf: "csrf-1" });
  const registry = yield* scopedRegistry();
  const stops = [shell.accessAtom, shell.dashboardOpened].map((atom) => registry.subscribe(atom as Atom.Atom<unknown>, () => undefined, { immediate: true }));
  yield* until(registry, shell.dashboardOpened, (state) => state.opened, "the dashboard opened");
  registry.set(shell.signOutAction, undefined);
  const failed = yield* settled(registry, shell.signOutAction);
  assert.ok(AsyncResult.isSuccess(failed) && failed.value === "failed");
  assert.equal(browser.local.get("supervisor-session"), "session-1");
  assert.equal(registry.get(shell.dashboardOpened).opened, true);

  logout = () => json({ authenticated: false });
  browser.sent.length = 0;
  registry.set(shell.signOutAction, undefined);
  registry.set(shell.signOutAction, undefined);
  const done = yield* settled(registry, shell.signOutAction);
  assert.ok(AsyncResult.isSuccess(done) && done.value === "signedOut");
  const posts = browser.sent.filter((request) => request.path === "/auth/logout");
  assert.deepEqual(posts.map((request) => [request.method, request.body, request.session]), [["POST", "{}", "session-1"]]);
  assert.equal(browser.local.has("supervisor-session"), false);
  assert.equal(registry.get(shell.dashboardOpened).opened, false);
  assert.equal(yield* storedSession(registry), "");
  for (const stop of stops) stop();
  registry.dispose();
}), { timeout: 10_000 });

it.effect("unmounting the dashboard snapshot stops its 5 s refresh timer on the page runtime's clock", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  browser.state.reply = () => json(snapshot(true));
  const {registry, sleeps} = yield* countedRegistry(atoms.uiRuntime);
  const stop = registry.subscribe(shell.dashboardSnapshot, () => undefined, { immediate: true });
  yield* until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the first snapshot");
  assert.equal(sleeps(), 1, "the refresh interval is the one timer on the page runtime's clock");
  // one 5 s interval passes on the page runtime's clock
  yield* TestClock.adjust("5 seconds");
  yield* browser.request(() => snapshots().length >= 2, "the refresh");
  assert.equal(snapshots().length, 2, "one refresh for the interval");
  assert.equal(sleeps(), 1, "the next interval is pending");
  stop();
  // the registry removes the unmounted snapshot on its next task, and the refresh signal only it used on the task after
  yield* nextTurn;
  yield* nextTurn;
  assert.equal(sleeps(), 0, "no timer after unmounting");
  yield* elapse("30 seconds");
  assert.equal(snapshots().length, 2, "no refresh after unmounting");
}), { timeout: 10_000 });
