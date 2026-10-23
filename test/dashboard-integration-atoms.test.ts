/// <reference types="vite/client" />
// the shell imports its stylesheet, which the vite client types declare for the root type check
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { beforeAll, it } from "@effect/vitest";
import { Effect, Exit, FileSystem } from "effect";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vitest";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { scopedRegistry } from "./support/g7-page.js";
import { json, makeBrowser, until, type SentRequest } from "./support/g7-browser.js";

// target regressions of the dashboard integration (WP-S7-INT) over a stubbed browser and the real page runtime: the
// shared admit helper, the per-registry claim, the auth epoch as session generation, stale reads, the transitional
// removals, the guarded discard of Supervisor drafts, the consumed sign-in token and the T3 environment in scope keys. the
// waits for a request or an atom value are bounded on the live clock. the tests that observe the absence of a request
// over real event-loop time, and the poll test that counts reads of the snapshot refresh (a plain atom on the default
// clock) against the page runtime's poll signal, are it.live

// importing the shell mounts its root; only the React root renderer is replaced, nothing it renders is under test here
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => undefined }) }));

const browser = makeBrowser();
let atoms: typeof import("../ui/src/atoms.js");
let access: typeof import("../ui/src/access.js");
let api: typeof import("../ui/src/api.js");
let shell: typeof import("../ui/src/main.js");
let noProject: typeof import("../ui/src/no-project.js");
let overview: typeof import("../ui/src/overview.js");
let ps: typeof import("../ui/src/project-supervisor.js");
let controls: typeof import("../ui/src/supervisor-control.js");
let definitions: typeof import("../ui/src/project-definitions.js");
let definitionsApi: typeof import("../ui/src/project-definitions-api.js");
let editor: typeof import("../ui/src/project-configuration-editor.js");

beforeAll(() => Effect.gen(function* () {
  yield* browser.install;
  browser.state.root = {};
  atoms = yield* Effect.promise(() => import("../ui/src/atoms.js"));
  access = yield* Effect.promise(() => import("../ui/src/access.js"));
  api = yield* Effect.promise(() => import("../ui/src/api.js"));
  shell = yield* Effect.promise(() => import("../ui/src/main.js"));
  noProject = yield* Effect.promise(() => import("../ui/src/no-project.js"));
  overview = yield* Effect.promise(() => import("../ui/src/overview.js"));
  ps = yield* Effect.promise(() => import("../ui/src/project-supervisor.js"));
  controls = yield* Effect.promise(() => import("../ui/src/supervisor-control.js"));
  definitions = yield* Effect.promise(() => import("../ui/src/project-definitions.js"));
  definitionsApi = yield* Effect.promise(() => import("../ui/src/project-definitions-api.js"));
  editor = yield* Effect.promise(() => import("../ui/src/project-configuration-editor.js"));
}));

const session = "A".repeat(43);
const snapshot = (environmentId = "environment", connected = true) => ({
  environmentId, serverVersion: "build", connected, lastCycleAt: 1, sendingReady: true, sendingReason: "",
  settings: { generation: 1, guidancePaused: false, monitoringPaused: false, allowFollowupRace: false, verifiedServerVersion: null, model: "model",
    reasoning: "low", dailyTokenBudget: 1, evidenceHours: 1, maxAnchorAgeSeconds: 1 },
  threadPolicy: { generation: 1, excludedThreadIds: [] }, threads: [], projects: [], rules: [], mutes: [], activity: [], coverage: "", tokensUsed: 0,
});
const overviewPage = { revision: "one", observedAt: 1, available: true, globallyEnabled: true, offset: 0, limit: 100, total: 0, attentionTotal: 0,
  hasMore: false, projects: [], work: [] };
const candidates = { exceptions: [], candidates: [], message: "No recent chats." };
const loadedDefinitions = (revision: string): ProjectDefinitionSnapshot => ({
  projectId: "project", threadId: null, workspaceRoot: "/workspace", globalOnly: false, globalRevision: null, revision, editingAvailable: true,
  status: "ready", steps: [], workflows: [], config: { workflows: [], steps: [] }, projectConfig: { workflows: [], steps: [] }, definitionFiles: [],
  complete: true, sources: [], issues: [],
});
const policy = { generation: 1, excludedThreadIds: [] as string[] };
const sentTo = (path: string, requests: ReadonlyArray<SentRequest> = browser.sent) => requests.filter((request) => request.path === path);
const settled = <A, E>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>, label: string) =>
  until(registry, atom, (result) => AsyncResult.isNotInitial(result) && !result.waiting, label);
const epochOf = (registry: AtomRegistry.AtomRegistry) => {
  const epoch = registry.get(atoms.authEpochAtom);
  return AsyncResult.isSuccess(epoch) ? epoch.value : -1;
};
// the ui sources, read through the platform file system
const sources = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = fileURLToPath(new URL("../ui/src/", import.meta.url));
  const names = (yield* fs.readDirectory(directory)).filter((name) => /\.tsx?$/u.test(name));
  return yield* Effect.forEach(names, (name) => Effect.map(fs.readFileString(`${directory}${name}`), (text) => ({ name, text })));
}).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer));

it.effect("D1 an action written again while its admitted save runs still records the save's outcome through the registry, and every panel uses the one admit helper", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  const releases: Array<(response: Response) => void> = [];
  browser.state.reply = (request) => request.path === "/api/guidance/thread-policy"
    ? new Promise<Response>((resolve) => { releases.push(resolve); })
    : json(snapshot());
  const registry = yield* scopedRegistry();
  const stop = registry.subscribe(shell.chatSettingsStatus, () => undefined, { immediate: true });
  registry.set(shell.saveChatSettings, policy);
  yield* browser.request((request) => request.path === "/api/guidance/thread-policy", "the save");
  // the second write is refused while the save runs, but it replaces the first invocation's own context
  registry.set(shell.saveChatSettings, policy);
  releases[0]!(json(policy));
  const status = yield* until(registry, shell.chatSettingsStatus, (value) => !value.saving, "the recorded outcome");
  assert.deepEqual(status, { saving: false, uncertain: false, message: "Chat settings saved and applied." });
  assert.equal(sentTo("/api/guidance/thread-policy").length, 1);
  stop();
  registry.dispose();

  const files = yield* sources;
  assert.deepEqual(files.filter((file) => /export const admit\b/u.test(file.text)).map((file) => file.name), ["atoms.ts"], "one admit helper");
  assert.deepEqual(files.filter((file) => /\.setResult\(/u.test(file.text)).map((file) => file.name), [], "no action awaits a mutation through its own context");
}), { timeout: 10_000 });

// sol-r22: an unconfirmed chat settings save fences Save until a verified read of the settings in its environment; a
// definite refusal does not
for (const [label, refusal] of [["a 500", 500], ["a 401 for the sent session", 401]] as const) {
  it.live(`R22 a chat settings save answered ${label} is unknown: nothing is saved again until a verified read, which clears an applied draft and keeps another`, () => Effect.gen(function* () {
    for (const applied of [true, false]) {
      browser.local.set("supervisor-session", "session-1");
      browser.sent.length = 0;
      const draft = { generation: 1, excludedThreadIds: ["chat-1"] };
      let saved = { generation: 1, excludedThreadIds: [] as string[] };
      let readFails = false;
      browser.state.reply = (request) => {
        if (request.path === "/api/csrf") return json({ csrf: "token" });
        if (request.path === "/api/guidance/thread-policy") {
          if (applied) saved = { generation: 2, excludedThreadIds: ["chat-1"] };
          return json({ message: "unavailable" }, refusal);
        }
        if (request.path === "/api/guidance/snapshot") return readFails ? json({ message: "unavailable" }, 500) : json({ ...snapshot(), threadPolicy: saved });
        return json({});
      };
      const registry = yield* scopedRegistry();
      const stops = [atoms.snapshotAtom, shell.chatSettingsDraft, shell.chatSettingsStatus].map((atom) => registry.mount(atom as Atom.Atom<unknown>));
      yield* settled(registry, atoms.snapshotAtom, "the first snapshot");
      registry.set(shell.chatSettingsDraft, draft);
      registry.set(shell.saveChatSettings, draft);
      const status = yield* until(registry, shell.chatSettingsStatus, (value) => !value.saving && value.message !== "", "the unknown outcome");
      assert.deepEqual(status, { saving: false, uncertain: true, message: "Chat settings invalid or changed in another tab. Reload first." }, `${label} applied=${applied}`);
      assert.deepEqual(registry.get(shell.chatSettingsDraft), draft, "the draft is kept");
      registry.set(shell.saveChatSettings, draft);
      yield* Effect.sleep("50 millis");
      assert.equal(sentTo("/api/guidance/thread-policy").length, 1, "no second save before a verified read");

      // a failed read keeps the fence
      readFails = true;
      registry.set(shell.reloadChatSettings, undefined);
      yield* settled(registry, atoms.snapshotAtom, "the failed read");
      yield* Effect.sleep("50 millis");
      assert.equal(registry.get(shell.chatSettingsStatus).uncertain, true, "a failed read lifts nothing");

      readFails = false;
      registry.set(shell.reloadChatSettings, undefined);
      const reloaded = yield* until(registry, shell.chatSettingsStatus, (value) => !value.uncertain, "the verified read");
      assert.deepEqual([reloaded.message, registry.get(shell.chatSettingsDraft)], applied
        ? ["Chat settings saved and applied.", null] : ["", draft], `applied=${applied}: the verified read reconciles the draft`);
      if (!applied) {
        browser.state.reply = (request) => request.path === "/api/guidance/thread-policy" ? json(draft) : json({ ...snapshot(), threadPolicy: saved });
        registry.set(shell.saveChatSettings, draft);
        yield* until(registry, shell.chatSettingsStatus, (value) => value.message === "Chat settings saved and applied.", "the explicit save after the read");
        assert.equal(sentTo("/api/guidance/thread-policy").length, 2);
      }
      for (const stop of stops) stop();
      registry.dispose();
    }
  }), { timeout: 10_000 });
}

it.effect("R22 a chat settings save refused definitely (sent without a CSRF token) keeps Save open", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  browser.state.reply = (request) => request.path === "/api/csrf" ? json({ csrf: "token" })
    : request.path === "/api/guidance/thread-policy" ? json({ message: "Refresh the local dashboard before changing settings." }, 403) : json(snapshot());
  const registry = yield* scopedRegistry();
  const stops = [atoms.snapshotAtom, shell.chatSettingsStatus].map((atom) => registry.mount(atom as Atom.Atom<unknown>));
  yield* settled(registry, atoms.snapshotAtom, "the first snapshot");
  registry.set(shell.saveChatSettings, policy);
  const status = yield* until(registry, shell.chatSettingsStatus, (value) => !value.saving && value.message !== "", "the refusal");
  assert.deepEqual(status, { saving: false, uncertain: false, message: "Chat settings invalid or changed in another tab. Reload first." });
  registry.set(shell.saveChatSettings, policy);
  yield* browser.request((request) => request.path === "/api/guidance/thread-policy" && sentTo("/api/guidance/thread-policy").length === 2, "the second save");
  for (const stop of stops) stop();
  registry.dispose();
}), { timeout: 10_000 });

it.effect("D2 an admitted operation is claimed per registry: repeated writes in one registry join its request, another registry sends its own", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  const releases: Array<(response: Response) => void> = [];
  browser.state.reply = (request) => request.path === "/api/guidance/thread-policy"
    ? new Promise<Response>((resolve) => { releases.push(resolve); })
    : json({ csrf: "csrf-1" });
  const save = atoms.admittedMutation((input: typeof policy) => Effect.flatMap(api.ApiClient, (client) => client.guidance.threadPolicy({ payload: input })));
  const operation = save({ scope: atoms.scopeKey("claim"), operationId: "op-1" });
  const first = yield* scopedRegistry();
  const second = yield* scopedRegistry();
  first.set(operation, policy);
  first.set(operation, policy);
  yield* browser.request(() => sentTo("/api/guidance/thread-policy").length === 1, "the first registry's request");
  second.set(operation, policy);
  second.set(operation, policy);
  yield* browser.request(() => sentTo("/api/guidance/thread-policy").length === 2, "the second registry's own request");
  for (const release of releases) release(json(policy));
  const answered = yield* Effect.all([first, second].map((registry) => settled(registry, operation, "the answer")), { concurrency: "unbounded" });
  assert.ok(answered.every(AsyncResult.isSuccess));
  assert.equal(sentTo("/api/guidance/thread-policy").length, 2, "one request per registry");
  first.dispose();
  second.dispose();
}), { timeout: 10_000 });

it.live("D3 signed-out 401s leave the auth epoch as it was, so the epoch-keyed reads repeat only on their polls, and a sign-in reads each of them once", () => Effect.gen(function* () {
  // a signed-in page that knows its T3 environment signs out
  browser.local.set("supervisor-session", "session-0");
  browser.sent.length = 0;
  browser.state.reply = (request) => request.path === "/api/guidance/snapshot" ? json(snapshot()) : json({ csrf: "csrf-0" });
  const registry = yield* scopedRegistry();
  const stopEpoch = registry.mount(atoms.authEpochAtom);
  const stopSnapshot = registry.mount(atoms.snapshotAtom);
  yield* until(registry, atoms.environmentAtom, (value) => value === "environment", "the environment");
  const run = (effect: Effect.Effect<void, never, import("../ui/src/access.js").SessionAccess>) => {
    const action = atoms.uiRuntime.fn(() => effect);
    const stop = registry.mount(action);
    registry.set(action, undefined);
    return settled(registry, action, "the session change").pipe(Effect.ensuring(Effect.sync(stop)));
  };
  yield* run(Effect.flatMap(access.SessionAccess, (service) => service.clear()));
  const signedOut = epochOf(registry);
  assert.equal(signedOut, 1, "the sign-out removed a present session");

  // answers arrive on a later turn of the event loop, as network answers do, so a read loop cannot starve the timers
  browser.state.reply = () => new Promise<Response>((resolve) => setImmediate(() => resolve(json({ message: "Sign in to Supervisor." }, 401))));
  yield* settled(registry, atoms.snapshotAtom, "the signed-out snapshot");
  browser.sent.length = 0;
  const model = overview.makeOverview(40);
  registry.set(model.enabled, true);
  const search = noProject.chatCandidates("exclude")("")(0);
  const ticks = atoms.pollSignal(40);
  const polling = [ticks, shell.snapshotPoll(40), shell.accessRefresh, model.polled].map((atom) => registry.mount(atom as Atom.Atom<unknown>));
  const stopSearch = registry.mount(search);
  const polls = yield* until(registry, ticks, (value) => AsyncResult.isSuccess(value) && value.value >= 4, "four polls");
  const count = AsyncResult.isSuccess(polls) ? polls.value : 0;
  assert.equal(epochOf(registry), signedOut, "no 401 while signed out advances the epoch");
  assert.ok(sentTo("/api/guidance/snapshot").length <= count + 2, `snapshot reads bounded by the polls: ${sentTo("/api/guidance/snapshot").length}`);
  assert.ok(sentTo("/api/guidance/dashboard-overview").length <= count + 2, `overview reads bounded by the polls: ${sentTo("/api/guidance/dashboard-overview").length}`);
  assert.equal(sentTo("/api/guidance/supervision-candidates").length, 1, "an unpolled search is read once");
  assert.ok(sentTo("/api/csrf").length <= 2 * count + 4, `access refreshes bounded by the reads: ${sentTo("/api/csrf").length}`);

  // without polls, a sign-in is the only reason to read again
  for (const stop of polling) stop();
  const stopOverview = registry.mount(model.read);
  yield* Effect.all([atoms.snapshotAtom, model.read, search].map((atom) =>
    settled(registry, atom as Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>, "the signed-out read")), { concurrency: "unbounded" });
  browser.state.reply = (request) => request.path === "/api/csrf" ? json({ csrf: "csrf-1" })
    : request.path === "/api/guidance/snapshot" ? json(snapshot())
    : request.path === "/api/guidance/dashboard-overview" ? json(overviewPage)
    : request.path === "/api/guidance/supervision-candidates" ? json(candidates) : json({ message: "Not found." }, 404);
  browser.sent.length = 0;
  yield* run(Effect.flatMap(access.SessionAccess, (service) => Effect.orDie(service.signIn(session))));
  assert.equal(epochOf(registry), signedOut + 1, "the sign-in stored a new session");
  const paths = ["/api/guidance/snapshot", "/api/guidance/dashboard-overview", "/api/guidance/supervision-candidates"];
  for (const path of paths) yield* browser.request((request) => request.path === path && request.session === session, `${path} after the sign-in`);
  // absence of a second read can only be observed over time
  yield* Effect.sleep("150 millis");
  for (const path of paths) assert.deepEqual(sentTo(path).map((request) => request.session), [session], `${path} is read once for the new session`);
  assert.equal(epochOf(registry), signedOut + 1);
  for (const stop of [stopOverview, stopSearch, stopSnapshot, stopEpoch]) stop();
  registry.dispose();
}), { timeout: 10_000 });

it("D3 the No Project mode is read again for a new session or environment key while it is shown, never over a mode draft or a change in flight", { timeout: 10_000 }, () => {
  const panel = { active: true, loaded: atoms.scopeKey("environment", 0), readKey: atoms.scopeKey("environment", 1), dirty: false, busy: false };
  assert.equal(noProject.noProjectReadDue(panel), true);
  assert.equal(noProject.noProjectReadDue({ ...panel, readKey: panel.loaded }), false, "the key it was read for");
  assert.equal(noProject.noProjectReadDue({ ...panel, dirty: true }), false);
  assert.equal(noProject.noProjectReadDue({ ...panel, busy: true }), false);
  assert.equal(noProject.noProjectReadDue({ ...panel, active: false }), false);
  assert.equal(noProject.noProjectReadDue({ ...panel, loaded: null }), true, "the first read");
});

it.effect("D4 a failed definitions refresh keeps the latest successful read beside its failure; the refresh reads the same key again", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  let fail = false;
  browser.state.reply = (request) => request.path === "/api/csrf" ? json({ csrf: "csrf-1" })
    : fail ? json({ message: "Unavailable." }, 500) : json(loadedDefinitions("a".repeat(64)));
  const registry = yield* scopedRegistry();
  const read = definitionsApi.projectDefinitionsAtom(definitionsApi.definitionsReadKey("environment", "project", null, 0));
  const stop = registry.mount(read);
  const first = yield* settled(registry, read, "the first read");
  assert.equal(definitions.definitionsShown(first, null).result?.definitions.revision, "a".repeat(64));
  fail = true;
  registry.refresh(read);
  assert.equal(definitions.definitionsShown(registry.get(read), null).reading, true, "a refresh is reading");
  assert.equal(definitions.definitionsShown(registry.get(read), null).result?.definitions.revision, "a".repeat(64), "the read stays shown while it refreshes");
  const failed = yield* settled(registry, read, "the failed refresh");
  const shown = definitions.definitionsShown(failed, null);
  assert.deepEqual([shown.result?.definitions.revision, shown.error, shown.reading], ["a".repeat(64), true, false]);
  assert.deepEqual(sentTo("/api/guidance/project-configuration").map((request) => request.search.toString()), ["projectId=project", "projectId=project"]);
  const saved = { definitions: loadedDefinitions("c".repeat(64)), loadedAt: 2, environmentId: "environment" };
  assert.deepEqual(definitions.definitionsShown(failed, saved), { result: saved, error: false, reading: false }, "a verified save is shown instead");
  stop();
  registry.dispose();
}), { timeout: 10_000 });

it.effect("D5 the access check tells an unreachable server from a signed-out session, and the transitional module functions and props are gone", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  const registry = yield* scopedRegistry();
  const stopRuntime = registry.mount(atoms.uiRuntime);
  const runtime = registry.get(atoms.uiRuntime);
  assert.ok(AsyncResult.isSuccess(runtime));
  const run = <A, E>(effect: Effect.Effect<A, E, import("../ui/src/access.js").SessionAccess>) => Effect.exit(effect.pipe(Effect.provide(runtime.value)));
  const check = Effect.flatMap(access.SessionAccess, (service) => service.check);
  const load = Effect.flatMap(access.SessionAccess, (service) => service.load);
  browser.state.reply = () => Promise.reject(new TypeError("Failed to fetch"));
  assert.deepEqual(yield* run(check), Exit.fail(new access.AccessUnreachable()));
  assert.deepEqual(yield* run(load), Exit.succeed(false), "the access refresh of a request reads it as not signed in");
  browser.state.reply = () => new Response("{", { status: 200 });
  assert.deepEqual(yield* run(check), Exit.fail(new access.AccessUnreachable()), "an unreadable answer");
  browser.state.reply = () => json({ csrf: "csrf-1" });
  assert.deepEqual(yield* run(check), Exit.succeed(true));
  browser.state.reply = () => json({ message: "Sign in to Supervisor." }, 401);
  assert.deepEqual(yield* run(check), Exit.succeed(false));
  stopRuntime();
  registry.dispose();

  assert.deepEqual(Object.keys(access).sort(), ["AccessUnreachable", "SessionAccess", "StorageBlocked"], "no module-level session or CSRF functions");
  for (const name of ["getCsrfToken", "loadAccess", "threadPolicyAtom", "snapshotAtom"]) assert.equal(name in api, false, `api.ts no longer exports ${name}`);
  assert.equal("readOverviewPages" in overview, false, "one overview range reader, in src/dashboard-overview.ts");
  const files = yield* sources;
  assert.deepEqual(files.filter((file) => /csrfToken|getCsrfToken|loadAccess/u.test(file.text)).map((file) => file.name), []);
}), { timeout: 10_000 });

it("D6 the guard's confirmed discard of a project change resets the project's keep-alive Supervisor drafts and the configuration draft", { timeout: 10_000 }, () => {
  const registry = AtomRegistry.make();
  const loaded = loadedDefinitions("a".repeat(64));
  const settingsDraft = ps.projectSupervisorDraft(ps.projectSupervisorKey("environment", "project"));
  const setupChoice = controls.supervisionSetupSelection(controls.supervisionControlKey("environment", "project"));
  const configuration = editor.configurationDrafts(editor.configurationScope("environment", loaded));
  const edited = () => ({ ...editor.freshDraft(), editing: true, config: { workflows: [], steps: [] } });
  const draft = { projectId: "project", modelValue: { instanceId: "i", model: "m", options: [] }, modelBaseline: { instanceId: "i", model: "n", options: [] },
    monitoringValue: { intervalMinutes: "5", activityThreshold: "10" }, monitoringBaseline: { intervalMinutes: "5", activityThreshold: "10" },
    teamSettingsValue: { maxHelpersPerRoot: "2" }, teamSettingsBaseline: { maxHelpersPerRoot: "2" }, expectedGeneration: 3 };
  const stops = [settingsDraft, setupChoice, configuration].map((atom) => registry.mount(atom as Atom.Atom<unknown>));

  // a conversation change in the same project discards only the configuration draft
  registry.set(settingsDraft, draft);
  registry.set(setupChoice, "checkout");
  registry.set(configuration, edited());
  definitions.discardProjectDrafts(registry, "environment", "project", { definitions: loaded, loadedAt: 1, environmentId: "environment" }, false);
  assert.deepEqual([registry.get(settingsDraft), registry.get(setupChoice), registry.get(configuration).editing], [draft, "checkout", false]);

  // a project change discards the Supervisor drafts as well, while the panels stay mounted
  registry.set(configuration, edited());
  definitions.discardProjectDrafts(registry, "environment", "project", { definitions: loaded, loadedAt: 1, environmentId: "environment" }, true);
  assert.deepEqual([registry.get(settingsDraft), registry.get(setupChoice), registry.get(configuration).editing], [null, "", false]);
  for (const stop of stops) stop();
  registry.dispose();
});

it.effect("D7 after a sign-in settles no atom keeps the consumed token as an argument or in a result", () => Effect.gen(function* () {
  browser.local.clear();
  browser.sent.length = 0;
  const token = "single-use-token-for-the-registry-scan";
  browser.state.reply = (request) => request.path === "/auth/login" ? json({ authenticated: true, session })
    : request.path === "/api/csrf" ? json({ csrf: "csrf-1" }) : json(snapshot());
  const registry = yield* scopedRegistry();
  const stop = registry.mount(shell.accessAtom);
  yield* settled(registry, shell.accessAtom, "the first access check");
  registry.set(shell.signInAction, token);
  const signedIn = yield* settled(registry, shell.signInAction, "the sign-in");
  assert.ok(AsyncResult.isSuccess(signedIn) && signedIn.value === true);
  assert.equal(JSON.parse(sentTo("/auth/login")[0]!.body).token, token, "the token was sent");
  assert.equal(browser.local.get("supervisor-session"), session);
  // every value held by the registry, searched for the token
  const holders: string[] = [];
  const seen = new WeakSet<object>();
  const search = (value: unknown, path: string, depth: number): void => {
    if (typeof value === "string") { if (value.includes(token)) holders.push(path); return; }
    if (typeof value !== "object" || value === null || depth > 12 || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) { for (const [key, entry] of value) { search(key, `${path}.key`, depth + 1); search(entry, `${path}.value`, depth + 1); } return; }
    if (value instanceof Set) { for (const entry of value) search(entry, `${path}.entry`, depth + 1); return; }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) search(descriptor.value, `${path}.${String(key)}`, depth + 1);
    }
  };
  let index = 0;
  for (const node of registry.getNodes().values()) {
    const value = node.valueOption();
    if (value._tag === "Some") search(value.value, `node ${index}`, 0);
    index++;
  }
  assert.deepEqual(holders, [], "the token is held nowhere in the registry");
  stop();
  registry.dispose();
}), { timeout: 10_000 });

it.effect("D8 the root snapshot's T3 environment scopes the panels' keys and drafts: another environment has its own No Project draft and reads the overview again", () => Effect.gen(function* () {
  browser.local.set("supervisor-session", "session-1");
  browser.sent.length = 0;
  let environment = "environment-a";
  browser.state.reply = (request) => request.path === "/api/guidance/snapshot" ? json(snapshot(environment))
    : request.path === "/api/guidance/dashboard-overview" ? json(overviewPage) : json({ csrf: "csrf-1" });
  const registry = yield* scopedRegistry();
  assert.equal(registry.get(atoms.environmentAtom), null, "unknown before the first snapshot, and reading it reads nothing");
  assert.equal(browser.sent.length, 0);
  const stops = [atoms.snapshotAtom, atoms.environmentAtom, noProject.noProjectState].map((atom) => registry.mount(atom as Atom.Atom<unknown>));
  yield* until(registry, atoms.environmentAtom, (value) => value === "environment-a", "environment a");
  const model = overview.makeOverview(60_000);
  registry.set(model.enabled, true);
  stops.push(registry.mount(model.read));
  yield* until(registry, model.read, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the overview of environment a");
  registry.set(noProject.noProjectState, { ...registry.get(noProject.noProjectState), mode: "automatic" });

  environment = "environment-b";
  registry.refresh(atoms.snapshotAtom);
  yield* until(registry, atoms.environmentAtom, (value) => value === "environment-b", "environment b");
  assert.equal(registry.get(noProject.noProjectState).mode, "on_request", "environment b has its own mode draft");
  yield* browser.request(() => sentTo("/api/guidance/dashboard-overview").length === 2, "the overview of environment b");
  environment = "environment-a";
  registry.refresh(atoms.snapshotAtom);
  yield* until(registry, atoms.environmentAtom, (value) => value === "environment-a", "environment a again");
  assert.equal(registry.get(noProject.noProjectState).mode, "automatic", "environment a's draft is kept");

  const loaded = loadedDefinitions("a".repeat(64));
  const keys = (environmentId: string) => [ps.projectSupervisorKey(environmentId, "project"), controls.supervisionControlKey(environmentId, "project"),
    controls.globalDefinitionsKey(environmentId), definitionsApi.definitionsReadKey(environmentId, "project", null, 0), editor.configurationScope(environmentId, loaded)];
  const [a, b] = [keys("environment-a"), keys("environment-b")];
  a.forEach((key, index) => assert.notEqual(key, b[index], `key ${index} includes the environment`));
  assert.ok(a.every((key) => JSON.parse(key).includes("environment-a")));
  for (const stop of stops) stop();
  registry.dispose();
}), { timeout: 10_000 });
