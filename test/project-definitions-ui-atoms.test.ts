import assert from "node:assert/strict";
import { Cause, Effect, Exit } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterAll, beforeAll, it, type TestContext } from "vitest";
import type { ProjectConfigEditor } from "../src/project-config-editor.js";
import type { ProjectDefinitionLoader } from "../src/project-definitions.js";
import type { ProjectConfigSave, ProjectConfigSaveOutcome, ProjectConfigurationInfo, ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { NotPerformed, Unconfirmed } from "../ui/src/api.js";
import { definitionsReadKey, projectDefinitionsAtom, resolveSave, saveProjectConfigurationAtom } from "../ui/src/project-definitions-api.js";
import { configurationScope, freshDraft, planSave, savedDefinitions, settleSave, type ConfigurationDraft } from "../ui/src/project-configuration-editor.js";
import { confirmDiscard, draftTarget, heldView, scopeChange, type DefinitionsSelection, type DefinitionsView } from "../ui/src/project-definitions.js";
import { defer, deferred, signIn, within } from "./support/c3b-http.js";
import { startUi } from "./support/c3b-ui.js";
import { sessionAccessOf } from "./support/ui-run.js";

// target regressions of the definitions panel and configuration editor ports (WP-S7-DEFS) over a stubbed browser and the
// real dashboard server: the held definitions read, guarded navigation, the draft target route, validation before
// confirm, the outcome rules of an admitted save and its expectedRevision compare-and-set

const originals = new Map<string, PropertyDescriptor | undefined>();
const install = (key: string, value: unknown) => {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
};
const page = {origin: "http://127.0.0.1:9", pathname: "/"};
const storage = new Map<string, string>();
interface Sent {readonly method: string; readonly path: string; readonly signal: AbortSignal | null}
const sent: Sent[] = [];

// a browser fetch: page-relative urls, the page origin on every write, and a record of each request and its abort signal
beforeAll(() => {
  const network = globalThis.fetch;
  install("location", page);
  install("window", new EventTarget());
  install("localStorage", {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => {storage.set(key, value);},
    removeItem: (key: string) => {storage.delete(key);}});
  install("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), page.origin);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (method !== "GET") headers.set("origin", page.origin);
    sent.push({method, path: url.pathname, signal: init?.signal ?? null});
    return network(url, {...init, headers});
  });
});
afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const revisionA = "a".repeat(64);
const revisionB = "b".repeat(64);
const revisionC = "c".repeat(64);
const indexed: ProjectConfigurationInfo = {workflows: [], steps: [{path: "steps/e2e-testing.md", summary: "Verify the change.", required: true}]};
const edited: ProjectConfigurationInfo = {workflows: [], steps: [{path: "steps/e2e-testing.md", summary: "Verify the changed behaviour.", required: true}]};
const snapshot = (revision: string, projectConfig: ProjectConfigurationInfo | null = indexed, threadId: string | null = null): ProjectDefinitionSnapshot => ({
  projectId: "project", threadId, workspaceRoot: "/workspace", globalOnly: false, globalRevision: null, revision, editingAvailable: true,
  status: "ready", steps: [], workflows: [], config: {workflows: [], steps: []}, projectConfig, definitionFiles: [], complete: true,
  sources: [], issues: [],
});

// the dashboard server with the given definitions and editor, signed in for the stubbed browser
const signedIn = async (t: TestContext, options: {definitions: ProjectDefinitionLoader; editor?: ProjectConfigEditor}) => {
  const started = await startUi(t, options);
  page.origin = started.origin;
  storage.set("supervisor-session", await signIn(started.origin, started.directory));
  const registry = AtomRegistry.make();
  defer(t, () => registry.dispose());
  assert.equal(await Effect.runPromise(sessionAccessOf(registry).load), true);
  defer(t, () => {Effect.runSync(sessionAccessOf(registry).clear());storage.clear();});
  return registry;
};

// resolves with the first value of the atom that satisfies the predicate
const until = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, predicate: (value: A) => boolean, label: string) =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => {stop();reject(new Error(`${label} not reached`));}, 5_000);
    const stop = registry.subscribe(atom, (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      queueMicrotask(() => stop());
      resolve(value);
    }, {immediate: true});
  });

// the admitted save of one attempt, settled as the editor's promiseExit setter observes it
const admittedSave = (registry: AtomRegistry.AtomRegistry, draft: ConfigurationDraft, scope: string, input: ProjectConfigSave) => {
  const attempt = saveProjectConfigurationAtom({scope, operationId: draft.operationId});
  registry.set(attempt, input);
  return Effect.runPromiseExit(AtomRegistry.getResult(registry, attempt, {suspendOnWaiting: true}));
};

it("no definitions reload starts while the configuration is dirty or saving, and a new view disposes and interrupts the old read", {timeout: 10_000}, async t => {
  const reads: Array<string | null> = [];
  const hung = deferred<ProjectDefinitionSnapshot>();
  const hungEntered = deferred();
  const definitions = {load: (_projectId: string, threadId: string | null) => {
    reads.push(threadId);
    if (reads.length !== 3) return Promise.resolve(snapshot(revisionA, indexed, threadId));
    hungEntered.resolve();
    return hung.promise;
  }} as unknown as ProjectDefinitionLoader;
  const registry = await signedIn(t, {definitions});
  defer(t, () => hung.resolve(snapshot(revisionA)));

  // the panel's render: the held view follows the live view unless the editor holds a draft or a save; the mounted
  // read is the held view's
  let view: DefinitionsView = {key: "", read: null};
  let mounted: {read: string; stop: () => void} | null = null;
  const render = (reload: number, epoch: number, holding: boolean, threadId: string | null = null) => {
    view = heldView(view, {key: JSON.stringify(["project", threadId ?? "", reload, true]), read: definitionsReadKey(null, "project", threadId, epoch)}, holding);
    if (mounted?.read === view.read) return projectDefinitionsAtom(mounted.read);
    mounted?.stop();
    const read = view.read!;
    mounted = {read, stop: registry.subscribe(projectDefinitionsAtom(read), () => undefined, {immediate: true})};
    return projectDefinitionsAtom(read);
  };
  const reads0 = render(0, 0, false);
  const first = await until(registry, reads0, AsyncResult.isSuccess, "the first read");
  assert.equal(AsyncResult.isSuccess(first) && first.value.definitions.revision, revisionA);
  assert.equal(reads.length, 1);

  // a refresh count and a new session while dirty, then while saving: the held read stays mounted and nothing is read
  assert.equal(render(1, 0, true), reads0);
  assert.equal(render(1, 1, true), reads0);
  assert.equal(render(2, 1, true), reads0);
  // absence of a read can only be observed over time
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(reads.length, 1, "no reload while the configuration is dirty or saving");
  assert.ok(AsyncResult.isSuccess(registry.get(reads0)), "the held read keeps its snapshot");

  // a clean editor follows the live view: one new read
  const reads1 = render(2, 1, false);
  await until(registry, reads1, AsyncResult.isSuccess, "the reload");
  assert.equal(reads.length, 2);

  // a scope change while the next read is in flight disposes it and aborts its request
  const pending = render(2, 1, false, "thread-1");
  await until(registry, pending, AsyncResult.isInitial, "the pending read");
  await within(hungEntered.promise, 5_000, "the pending read on the server");
  const inFlight = sent.filter(request => request.path === "/api/guidance/project-configuration").at(-1)!;
  assert.equal(inFlight.signal?.aborted, false);
  render(3, 1, false, "thread-2");
  await until(registry, projectDefinitionsAtom(view.read!), AsyncResult.isSuccess, "the read of the new scope");
  assert.equal(inFlight.signal?.aborted, true, "the disposed read aborted its request");
  mounted!.stop();
});

it("a save compares against the loaded revision: a concurrent change answers conflict and blocks, a fresh read saves", {timeout: 10_000}, async t => {
  let current = snapshot(revisionA);
  const saves: ProjectConfigSave[] = [];
  const definitions = {load: async () => current} as unknown as ProjectDefinitionLoader;
  const editor = {save: async (input: ProjectConfigSave): Promise<ProjectConfigSaveOutcome> => {
    saves.push(input);
    if (input.expectedRevision !== current.revision)
      return {status: "conflict", message: "project.yaml changed since it was read. Refresh definitions before saving again.", definitions: null};
    current = snapshot(revisionC, input.config);
    return {status: "saved", message: "Saved project.yaml.", definitions: current};
  }} as unknown as ProjectConfigEditor;
  const registry = await signedIn(t, {definitions, editor});
  const read = async (reload: number) => {
    const atom = projectDefinitionsAtom(definitionsReadKey(null, "project", null, 0));
    const stop = registry.subscribe(atom, () => undefined, {immediate: true});
    if (reload > 0) registry.refresh(atom);
    const loaded = await until(registry, atom, (result) => AsyncResult.isSuccess(result) && !result.waiting, `read ${reload}`);
    stop();
    assert.ok(AsyncResult.isSuccess(loaded));
    return loaded.value.definitions;
  };

  const loaded = await read(0);
  // another writer changes project.yaml after the read
  current = snapshot(revisionB);
  const plan = planSave(loaded, edited, () => true);
  assert.ok(plan._tag === "Save");
  assert.equal(plan.input.expectedRevision, revisionA, "the save carries the revision it was edited from");
  const scope = configurationScope(null, loaded);
  const draft = {...freshDraft(), editing: true, config: edited};
  const conflict = resolveSave(plan.input)(await admittedSave(registry, draft, scope, plan.input));
  const blocked = settleSave(draft, conflict, plan.normalized);
  assert.deepEqual([blocked.blocked, blocked.message, blocked.messageAlert, blocked.config], [true,
    "project.yaml changed since it was read. Refresh definitions before saving again.", true, edited], "the draft is kept and blocked");
  assert.equal(savedDefinitions(conflict), null);
  assert.notEqual(blocked.operationId, draft.operationId, "the settled attempt is never written again");
  assert.deepEqual([saves.map(save => save.expectedRevision), current.revision], [[revisionA], revisionB], "the concurrent change survived");

  const fresh = await read(1);
  const retry = planSave(fresh, edited, () => true);
  assert.ok(retry._tag === "Save");
  assert.equal(retry.input.expectedRevision, revisionB);
  const saved = resolveSave(retry.input)(await admittedSave(registry, {...freshDraft(), editing: true, config: edited}, configurationScope(null, fresh), retry.input));
  assert.equal(savedDefinitions(saved)?.revision, revisionC);
  const cleared = settleSave({...freshDraft(), editing: true, config: edited}, saved, retry.normalized);
  assert.deepEqual([cleared.editing, cleared.blocked, cleared.config, cleared.message, cleared.messageAlert], [false, false, edited, "Saved project.yaml.", false]);
  assert.deepEqual(saves.map(save => save.expectedRevision), [revisionA, revisionB]);
});

it("an answered conflict, uncertain, unavailable or permission_required save blocks the editor; invalid keeps editing allowed", {timeout: 10_000}, async t => {
  let answer: ProjectConfigSaveOutcome = {status: "invalid", message: "", definitions: null};
  const definitions = {load: async () => snapshot(revisionA)} as unknown as ProjectDefinitionLoader;
  const editor = {save: async () => answer} as unknown as ProjectConfigEditor;
  const registry = await signedIn(t, {definitions, editor});
  const loaded = snapshot(revisionA);
  const cases: Array<[ProjectConfigSaveOutcome, boolean, string]> = [
    [{status: "conflict", message: "Conflict.", definitions: null}, true, "Conflict."],
    [{status: "uncertain", message: "Uncertain.", definitions: null}, true, "Uncertain."],
    [{status: "unavailable", message: "Unavailable.", definitions: null}, true, "Unavailable."],
    [{status: "permission_required", message: "Permission required.", definitions: null}, true, "Permission required."],
    [{status: "invalid", message: "Invalid.", definitions: snapshot(revisionA)}, false, "Invalid."],
    [{status: "saved", message: "Saved.", definitions: null}, true, "Saved. Refresh definitions to inspect the saved project.yaml before editing again."],
  ];
  for (const [reply, blocks, message] of cases) {
    answer = reply;
    const plan = planSave(loaded, edited, () => true);
    assert.ok(plan._tag === "Save");
    const draft = {...freshDraft(), editing: true, config: edited};
    const outcome = resolveSave(plan.input)(await admittedSave(registry, draft, configurationScope(null, loaded), plan.input));
    const settled = settleSave(draft, outcome, plan.normalized);
    assert.deepEqual([settled.blocked, settled.message, settled.messageAlert, settled.editing, settled.config], [blocks, message, true, true, edited], reply.status);
  }
});

it("a refused save keeps editing allowed with its golden text; an unconfirmed, interrupted or misdirected save blocks", {timeout: 10_000}, () => {
  const input: ProjectConfigSave = {projectId: "project", threadId: null, expectedRevision: revisionA, config: edited};
  const draft = {...freshDraft(), editing: true, config: edited};
  const settle = (exit: Exit.Exit<ProjectConfigSaveOutcome, NotPerformed | Unconfirmed>) => {
    const settled = settleSave(draft, resolveSave(input)(exit), edited);
    return [settled.message, settled.blocked, settled.messageAlert, settled.config === edited];
  };
  const refusal = (reason: NotPerformed["reason"]) => Exit.fail(new NotPerformed({reason}));
  assert.deepEqual(settle(refusal("refreshed")), ["Session refreshed. Your draft was not saved; review it and save again.", false, true, true]);
  assert.deepEqual(settle(refusal("refresh_failed")), ["Your draft was not saved. Session refresh failed; reconnect and save again.", false, true, true]);
  assert.deepEqual(settle(refusal("too_large")), ["Your draft was not saved. The request is too large; shorten the project configuration before saving again.", false, true, true]);
  assert.deepEqual(settle(refusal("format")), ["Your draft was not saved. The server rejected the request format.", false, true, true]);
  assert.deepEqual(settle(Exit.fail(new Unconfirmed())), ["The save outcome could not be confirmed. Refresh and inspect project.yaml before retrying.", true, true, true]);
  assert.deepEqual(settle(Exit.failCause(Cause.interrupt())), ["Save outcome unknown. Refresh before retrying.", true, true, true]);
  assert.deepEqual(settle(Exit.succeed({status: "saved", message: "Saved.", definitions: {...snapshot(revisionC), projectId: "other"}})),
    ["The save response belongs to another workspace. Refresh and inspect project.yaml before retrying.", true, true, true]);
});

it("the editor validates the draft before it asks to write the exact project.yaml path", {timeout: 10_000}, () => {
  const asked: string[] = [];
  const ask = (answer: boolean) => (question: string) => {asked.push(question);return answer;};
  const invalid = {workflows: [], steps: [...edited.steps, ...edited.steps]};
  assert.deepEqual(planSave(snapshot(revisionA), invalid, ask(true)), {_tag: "Invalid", message: "Step steps/e2e-testing.md is indexed more than once."});
  assert.deepEqual(planSave(snapshot(revisionA), {workflows: [], steps: [{path: "steps/x.md", summary: " ", required: false}]}, ask(true)),
    {_tag: "Invalid", message: "Step steps/x.md: needs a nonempty summary."});
  assert.deepEqual(asked, [], "an invalid draft never asks");
  assert.deepEqual(planSave(snapshot(revisionA), edited, ask(false)), {_tag: "Declined"});
  const plan = planSave(snapshot(revisionA), {workflows: [], steps: [{path: "steps/e2e-testing.md", summary: " Verify the changed behaviour. ", required: true}]}, ask(true));
  assert.deepEqual(plan, {_tag: "Save", normalized: edited, input: {projectId: "project", threadId: null, expectedRevision: revisionA, config: edited}});
  planSave(snapshot(revisionA, null), edited, ask(true));
  assert.deepEqual(asked, [
    "Save project configuration at /workspace/.t3-supervisor/project.yaml? This updates the selected working tree.",
    "Save project configuration at /workspace/.t3-supervisor/project.yaml? This updates the selected working tree.",
    "Replace the unreadable project.yaml with this configuration at /workspace/.t3-supervisor/project.yaml? This updates the selected working tree.",
  ]);
});

it("navigation that leaves the selected scope asks before discarding a dirty draft and never discards a pending save", {timeout: 10_000}, () => {
  const selection: DefinitionsSelection = {projectId: "project", threadId: "thread-1", contextSelected: true};
  const route = {page: "projects" as const, projectId: "project", main: "thread-1", section: "definitions" as const};
  assert.equal(scopeChange({...route, section: "settings"}, selection), null, "a section change stays in scope");
  assert.equal(scopeChange({...route, page: "home"}, selection), null, "leaving the projects page keeps the draft");
  assert.equal(scopeChange({...route, projectId: ""}, selection), null);
  assert.deepEqual(scopeChange({...route, main: "thread-2"}, selection), {projectChanges: false});
  assert.deepEqual(scopeChange({...route, main: null}, selection), {projectChanges: false});
  assert.deepEqual(scopeChange({...route, projectId: "other"}, selection), {projectChanges: true});

  const asked: string[] = [];
  const ask = (answer: boolean) => (question: string) => {asked.push(question);return answer;};
  const clean = {saving: false, configurationDirty: false, supervisorDirty: false};
  assert.equal(confirmDiscard(clean, true, ask(false)), true);
  assert.equal(confirmDiscard({...clean, supervisorDirty: true}, false, ask(false)), true, "a thread change keeps the project's Supervisor settings");
  assert.deepEqual(asked, []);
  assert.equal(confirmDiscard({...clean, configurationDirty: true}, false, ask(false)), false);
  assert.equal(confirmDiscard({...clean, configurationDirty: true}, false, ask(true)), true);
  assert.equal(confirmDiscard({...clean, supervisorDirty: true}, true, ask(true)), true);
  assert.deepEqual(asked, [
    "Discard unsaved project-configuration changes and reload definitions?",
    "Discard unsaved project-configuration changes and reload definitions?",
    "Discard unsaved project configuration and Supervisor settings?",
  ]);
  asked.length = 0;
  assert.equal(confirmDiscard({...clean, saving: true}, false, ask(true)), false);
  assert.equal(confirmDiscard({...clean, saving: true, configurationDirty: true}, true, ask(true)), false);
  assert.deepEqual(asked, [], "a pending save is never discarded and never asks");
});

it("the shell is told the route of a pending project draft and nothing while the project is clean", {timeout: 10_000}, () => {
  const selection: DefinitionsSelection = {projectId: "project", threadId: "thread-1", contextSelected: true};
  const none = {dirty: false, saving: false, configurationDirty: false};
  assert.equal(draftTarget(selection, none), null);
  assert.deepEqual(draftTarget(selection, {...none, dirty: true, configurationDirty: true}), {page: "projects", projectId: "project", main: "thread-1", section: "definitions"});
  assert.deepEqual(draftTarget(selection, {...none, dirty: true}), {page: "projects", projectId: "project", main: "thread-1", section: "settings"});
  assert.deepEqual(draftTarget(selection, {...none, saving: true}), {page: "projects", projectId: "project", main: "thread-1", section: "settings"});
  assert.deepEqual(draftTarget({...selection, threadId: "", contextSelected: false}, {...none, dirty: true, configurationDirty: true}),
    {page: "projects", projectId: "project", main: null, section: "definitions"});
});
