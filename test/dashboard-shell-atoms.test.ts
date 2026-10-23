/// <reference types="vite/client" />
// the shell imports its stylesheet, which the vite client types declare for the root type check
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Effect } from "effect";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { afterAll, beforeAll, it, vi } from "vitest";
import { json, makeBrowser, until } from "./support/ui-browser.js";

// target regressions of the dashboard shell over atoms (CT-UI-SHELL-01): the 5 s snapshot refresh, the retained last
// snapshot and its alert, the access refreshes, sign-in and sign-out, and drafts surviving expiry and re-sign-in

// importing the shell mounts its root; only the React root renderer is replaced, nothing it renders is under test here
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => undefined }) }));

const browser = makeBrowser();
type Shell = typeof import("../ui/src/main.js");
type Access = typeof import("../ui/src/access.js");
type Atoms = typeof import("../ui/src/atoms.js");
let shell: Shell;
let access: Access;
let atoms: Atoms;

beforeAll(async () => {
  browser.install();
  browser.state.root = {};
  access = await import("../ui/src/access.js");
  atoms = await import("../ui/src/atoms.js");
  shell = await import("../ui/src/main.js");
});
afterAll(() => browser.restore());

// the session stored for the SessionAccess of a registry's page runtime
const storedSession = (registry: AtomRegistry.AtomRegistry) => {
  const runtime = registry.get(atoms.uiRuntime);
  assert.ok(AsyncResult.isSuccess(runtime));
  return Effect.runSync(Effect.flatMap(access.SessionAccess, (service) => service.session).pipe(Effect.provide(runtime.value)));
};

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

it("the snapshot refreshes every 5 s while mounted, also while the page is hidden, and stops when unmounted", { timeout: 10_000 }, async () => {
  assert.equal(shell.snapshotRefreshMillis, 5_000);
  assert.equal(shell.dashboardSnapshot, shell.snapshotPoll(5_000));
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  browser.state.reply = () => json(snapshot(true));
  const registry = AtomRegistry.make();
  const stop = registry.subscribe(shell.snapshotPoll(20), () => undefined, { immediate: true });
  await browser.request(() => snapshots().length >= 3, "two refreshes after the first read");
  browser.state.visibility = "hidden";
  const hidden = snapshots().length;
  await browser.request(() => snapshots().length >= hidden + 2, "refreshes while hidden");
  browser.state.visibility = "visible";
  stop();
  await until(registry, shell.snapshotPoll(20), (result) => !result.waiting, "the last refresh");
  registry.dispose();
  const after = snapshots().length;
  // absence of a refresh can only be observed over time: six intervals pass after unmounting
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(snapshots().length, after, "no refresh after unmount");
});

it("a failed snapshot keeps the latest successful read with the drafts-kept alert, and access refreshes when reads start failing and when T3 reconnects", { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  let answer = () => json(snapshot(true, 1));
  browser.state.reply = (request) => request.path === "/api/csrf" ? json({ csrf: "csrf-1" }) : answer();
  const registry = AtomRegistry.make();
  assert.deepEqual(shell.snapshotView(AsyncResult.initial()), { data: null, connected: false, alert: "" });
  const stopRefresh = registry.subscribe(shell.accessRefresh, () => undefined, { immediate: true });
  const stop = registry.subscribe(shell.dashboardSnapshot, () => undefined, { immediate: true });
  await until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the first snapshot");
  // the shell starts disconnected while the first snapshot loads, so its first connected snapshot is a reconnect
  await browser.request(() => csrfReads().length === 1, "the access refresh on the first connected snapshot");
  answer = () => json(snapshot(true, 2));
  registry.refresh(shell.dashboardSnapshot);
  await until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result) && !result.waiting && result.value.tokensUsed === 2, "the second snapshot");
  assert.equal(csrfReads().length, 1, "a further connected snapshot refreshes nothing");

  answer = () => json({ message: "Unavailable." }, 500);
  registry.refresh(shell.dashboardSnapshot);
  const failed = await until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isFailure(result) && !result.waiting, "the failed snapshot");
  const view = shell.snapshotView(failed);
  assert.equal(view.data?.tokensUsed, 2, "the latest successful snapshot is kept");
  assert.equal(view.data?.connected, false);
  assert.equal(view.connected, false);
  assert.equal(view.alert, "Supervisor connection unavailable. Your drafts are kept.");
  await browser.request(() => csrfReads().length === 2, "the access refresh on failure");
  registry.refresh(shell.dashboardSnapshot);
  const again = await until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isFailure(result) && !result.waiting, "a second failure");
  assert.equal(shell.snapshotView(again).data?.tokensUsed, 2, "repeated failures keep the latest success");
  assert.equal(csrfReads().length, 2, "access refreshes once when reads start failing");

  answer = () => json(snapshot(true, 3));
  registry.refresh(shell.dashboardSnapshot);
  await until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the reconnect");
  await browser.request(() => csrfReads().length === 3, "the access refresh on reconnect");
  assert.deepEqual(shell.snapshotView(registry.get(shell.dashboardSnapshot)).alert, "");
  stop();
  stopRefresh();
  registry.dispose();
});

it("Sign out is disabled while a draft or pending change exists", { timeout: 10_000 }, () => {
  const blocked = renderToStaticMarkup(createElement(shell.SignOutButton, { blocked: true, onSignOut: () => undefined }));
  assert.match(blocked, /disabled=""/u);
  assert.match(blocked, /aria-describedby="pending-changes"/u);
  assert.match(blocked, /title="Save drafts and resolve pending changes before signing out."/u);
  const open = renderToStaticMarkup(createElement(shell.SignOutButton, { blocked: false, onSignOut: () => undefined }));
  assert.equal(open, '<button class="quiet-button">Sign out</button>');
});

it("CT-UI-SHELL-01 an expired session keeps the open dashboard and its drafts, asks to sign in again, and a re-sign-in stores the session once and restores them", { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  let csrf = () => json({ csrf: "csrf-1" });
  let answer = () => json(snapshot(true));
  browser.state.reply = (request) => request.path === "/api/csrf" ? csrf() : request.path === "/auth/login" ? json({ authenticated: true, session }) : answer();
  const registry = AtomRegistry.make();
  const stops = [shell.accessAtom, shell.dashboardOpened, shell.accessRefresh, shell.dashboardSnapshot, shell.signInState]
    .map((atom) => registry.subscribe(atom as Atom.Atom<unknown>, () => undefined, { immediate: true }));
  await until(registry, shell.dashboardOpened, (state) => state.opened, "the dashboard opened");
  await until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result), "the snapshot");
  const draft = { generation: 1, excludedThreadIds: ["thread-1"] };
  registry.set(shell.chatSettingsDraft, draft);

  // the server ends the session: the next snapshot fails and the access refresh finds it expired
  csrf = () => json({ message: "Sign in to Supervisor." }, 401);
  answer = () => json({ message: "Sign in to Supervisor." }, 401);
  registry.refresh(shell.dashboardSnapshot);
  await until(registry, shell.accessAtom, (result) => AsyncResult.isSuccess(result) && !result.waiting && result.value.state === "signedOut", "the expiry");
  assert.equal(browser.local.has("supervisor-session"), false, "the expired session is forgotten");
  assert.equal(registry.get(shell.dashboardOpened).opened, true, "the dashboard stays open behind Sign in again");
  assert.deepEqual(registry.get(shell.chatSettingsDraft), draft);
  assert.equal(shell.snapshotView(registry.get(shell.dashboardSnapshot)).alert, "Supervisor connection unavailable. Your drafts are kept.");
  // the expiry is a new auth epoch: the snapshot is read once more without a session and still fails
  await until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isFailure(result) && !result.waiting, "the re-read after the expiry");

  csrf = () => json({ csrf: "csrf-2" });
  answer = () => json(snapshot(true));
  browser.sent.length = 0;
  registry.set(shell.signInAction, "single-use-token");
  const signedIn = await settled(registry, shell.signInAction);
  assert.ok(AsyncResult.isSuccess(signedIn) && signedIn.value === true, "the form forgets the token");
  assert.deepEqual(registry.get(shell.signInState), { busy: false, error: "" });
  const login = browser.sent.find((request) => request.path === "/auth/login")!;
  assert.deepEqual([login.method, login.body, login.contentType, login.session], ["POST", JSON.stringify({ token: "single-use-token" }), "application/json", ""]);
  assert.equal(browser.local.get("supervisor-session"), session);
  assert.ok(![...browser.local.values(), ...browser.session.values()].some((value) => value.includes("single-use-token")), "the token is never stored");
  // the sign-in is a new auth epoch: the snapshot is read once more, and its first connected answer refreshes access as a
  // reconnect does
  await until(registry, shell.dashboardSnapshot, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the re-read after the sign-in");
  await browser.request(() => csrfReads().length === 2, "the access refresh on reconnect");
  assert.deepEqual(browser.sent.map((request) => [request.path, request.session]).sort(),
    [["/api/csrf", session], ["/api/csrf", session], ["/api/guidance/snapshot", session], ["/auth/login", ""]],
    "one sign-in, one access check of the stored session, one snapshot re-read and the reconnect refresh");
  const check = registry.get(shell.accessAtom);
  assert.ok(AsyncResult.isSuccess(check) && check.value.state === "signedIn");
  assert.equal(registry.get(shell.dashboardOpened).opened, true);
  assert.deepEqual(registry.get(shell.chatSettingsDraft), draft, "the draft survives expiry and re-sign-in");
  for (const stop of stops) stop();
  registry.dispose();
});

it("sign-in reports each refusal with its exact text and stores nothing it cannot verify", { timeout: 10_000 }, async () => {
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
    const registry = AtomRegistry.make();
    const stop = registry.subscribe(shell.accessAtom, () => undefined, { immediate: true });
    await until(registry, shell.accessAtom, (result) => AsyncResult.isSuccess(result) && !result.waiting, `${label}: the first check`);
    browser.state.localBlocked = blocked;
    registry.set(shell.signInAction, "token");
    await settled(registry, shell.signInAction);
    browser.state.localBlocked = false;
    assert.deepEqual(registry.get(shell.signInState), { busy: false, error: message }, label);
    assert.equal(browser.local.get("supervisor-session") ?? null, label === "unconfirmed" ? session : null, label);
    stop();
    registry.dispose();
  }
});

it("an unreachable server is told apart from a signed-out session", { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.state.reply = () => Promise.reject(new TypeError("Failed to fetch"));
  const registry = AtomRegistry.make();
  const stop = registry.subscribe(shell.accessAtom, () => undefined, { immediate: true });
  const result = await until(registry, shell.accessAtom, (value) => AsyncResult.isSuccess(value) && !value.waiting, "the check");
  assert.ok(AsyncResult.isSuccess(result) && result.value.state === "unreachable");
  stop();
  registry.dispose();
});

it("sign-out sends one request however often it is asked, forgets only its own session and closes the dashboard", { timeout: 10_000 }, async () => {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  let logout = () => json({ message: "Unavailable." }, 500);
  browser.state.reply = (request) => request.path === "/auth/logout" ? logout() : json({ csrf: "csrf-1" });
  const registry = AtomRegistry.make();
  const stops = [shell.accessAtom, shell.dashboardOpened].map((atom) => registry.subscribe(atom as Atom.Atom<unknown>, () => undefined, { immediate: true }));
  await until(registry, shell.dashboardOpened, (state) => state.opened, "the dashboard opened");
  registry.set(shell.signOutAction, undefined);
  const failed = await settled(registry, shell.signOutAction);
  assert.ok(AsyncResult.isSuccess(failed) && failed.value === "failed");
  assert.equal(browser.local.get("supervisor-session"), "session-1");
  assert.equal(registry.get(shell.dashboardOpened).opened, true);

  logout = () => json({ authenticated: false });
  browser.sent.length = 0;
  registry.set(shell.signOutAction, undefined);
  registry.set(shell.signOutAction, undefined);
  const done = await settled(registry, shell.signOutAction);
  assert.ok(AsyncResult.isSuccess(done) && done.value === "signedOut");
  const posts = browser.sent.filter((request) => request.path === "/auth/logout");
  assert.deepEqual(posts.map((request) => [request.method, request.body, request.session]), [["POST", "{}", "session-1"]]);
  assert.equal(browser.local.has("supervisor-session"), false);
  assert.equal(registry.get(shell.dashboardOpened).opened, false);
  assert.equal(storedSession(registry), "");
  for (const stop of stops) stop();
  registry.dispose();
});
