import assert from "node:assert/strict";
import { Effect, Option } from "effect";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { afterAll, beforeAll, it } from "vitest";
import type { ProjectConfigurationInfo, ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { json, makeBrowser, until } from "./support/ui-browser.js";

// target regressions of the definitions panel's save completions (R22 A-R18-03) over a stubbed browser and the real page
// runtime: a save of environment a whose answer arrives after the panel moved to environment b and saved there settles a
// only. the panel keeps this state in pure reducers (DefinitionsCompletion) and hands the editor callbacks built by
// editorCompletion; the editor settles a save through completeSave. the cases drive real reads and admitted saves and
// apply every completion through those functions, in the order the mounted panel applies them

const browser = makeBrowser();
let atoms: typeof import("../ui/src/atoms.js");
let panel: typeof import("../ui/src/project-definitions.js");
let api: typeof import("../ui/src/project-definitions-api.js");
let editor: typeof import("../ui/src/project-configuration-editor.js");

beforeAll(async () => {
  browser.install();
  browser.local.set("supervisor-session", "session-1");
  atoms = await import("../ui/src/atoms.js");
  panel = await import("../ui/src/project-definitions.js");
  api = await import("../ui/src/project-definitions-api.js");
  editor = await import("../ui/src/project-configuration-editor.js");
});
afterAll(() => browser.restore());

type Environment = "environment-a" | "environment-b";
const savedText = "Saved project configuration to .t3-supervisor/project.yaml.";
const snapshot = (environmentId: string) => ({
  environmentId, serverVersion: "build", connected: true, lastCycleAt: 1, sendingReady: true, sendingReason: "",
  settings: { generation: 1, guidancePaused: false, monitoringPaused: false, allowFollowupRace: false, verifiedServerVersion: null, model: "model",
    reasoning: "low", dailyTokenBudget: 1, evidenceHours: 1, maxAnchorAgeSeconds: 1 },
  threadPolicy: { generation: 1, excludedThreadIds: [] }, threads: [], projects: [], rules: [], mutes: [], activity: [], coverage: "", tokensUsed: 0,
});
const configuration = (summary: string): ProjectConfigurationInfo => ({workflows: [], steps: [{path: "steps/fixture-tests.md", summary, required: false}]});
const definitionsOf = (revision: string, summary: string): ProjectDefinitionSnapshot => ({
  projectId: "project", threadId: null, workspaceRoot: "/workspace", globalOnly: false, globalRevision: null, revision, editingAvailable: true,
  status: "ready", steps: [], workflows: [], config: {workflows: [], steps: []}, projectConfig: configuration(summary), definitionFiles: [],
  complete: true, sources: [], issues: [],
});
const summaryOf = (loaded: {definitions: ProjectDefinitionSnapshot} | null) => loaded?.definitions.projectConfig?.steps[0]?.summary ?? null;
// the save request whose draft carries this summary
const saveSent = (summary: string) => browser.request((request) => request.method === "POST" && request.path === "/api/guidance/project-configuration" &&
  (JSON.parse(request.body) as {config: ProjectConfigurationInfo}).config.steps[0]?.summary === summary, `the save of "${summary}"`);

// a synthetic server per environment: a save is applied when it is received, in the environment it was received in, and
// its answer is held when the test says so
const server = () => {
  let environment: Environment = "environment-a";
  let revision = 0;
  const stored: Record<Environment, ProjectDefinitionSnapshot> = {
    "environment-a": definitionsOf("a".repeat(64), "Fixture step: environment a."),
    "environment-b": definitionsOf("b".repeat(64), "Fixture B step: environment b."),
  };
  const holding = new Set<Environment>();
  const held: Array<{environment: Environment; answer: () => void}> = [];
  browser.sent.length = 0;
  browser.state.reply = (request) => {
    if (request.path === "/api/guidance/snapshot") return json(snapshot(environment));
    if (request.path === "/api/csrf") return json({csrf: "csrf-1"});
    if (request.path !== "/api/guidance/project-configuration") return json({message: "Not found."}, 404);
    if (request.method === "GET") return json(stored[environment]);
    const received = environment;
    const input = JSON.parse(request.body) as {config: ProjectConfigurationInfo};
    stored[received] = {...stored[received], revision: String(++revision).padStart(64, "c"), projectConfig: input.config};
    const answer = json({status: "saved", message: "Saved.", definitions: stored[received]});
    if (!holding.has(received)) return answer;
    return new Promise<Response>((resolve) => { held.push({environment: received, answer: () => resolve(answer)}); });
  };
  return {
    stored, holding,
    switchTo: (next: Environment) => { environment = next; },
    release: (from: Environment) => { const index = held.findIndex((item) => item.environment === from); held.splice(index, 1)[0]!.answer(); },
  };
};

// the panel of one registry: its completion state, the view of the current environment and its mounted read
const mountedPanel = (registry: AtomRegistry.AtomRegistry) => {
  let state = panel.noCompletion;
  const update = (change: (current: typeof state) => typeof state) => { state = change(state); };
  let stopRead: (() => void) | null = null;
  const view = (environmentId: Environment) => {
    const read = api.definitionsReadKey(environmentId, "project", null, 0);
    return {read, environmentId, atom: api.projectDefinitionsAtom(read)};
  };
  return {
    get state() { return state; },
    update,
    // the panel shows one view at a time: a view change unmounts the previous read and mounts the new one
    async show(environmentId: Environment) {
      stopRead?.();
      const shown = view(environmentId);
      stopRead = registry.mount(shown.atom);
      await until(registry, shown.atom, (result) => AsyncResult.isSuccess(result) && !result.waiting, `the read of ${environmentId}`);
      return shown;
    },
    // what the panel shows for a view: a verified save, else the latest successful read, and the saved message
    shownFor(shown: ReturnType<typeof view>) {
      const read = registry.get(shown.atom);
      const saved = panel.savedFor(state, shown.read, Option.getOrNull(AsyncResult.value(read)));
      return {definitions: panel.definitionsShown(read, saved).result, message: panel.messageFor(state, shown), report: panel.reportOf(state, shown.environmentId)};
    },
    stop() { stopRead?.(); },
  };
};

// one editor save of the shown definitions, completed as the mounted editor completes it: the admitted save written
// through the registry, its settled exit awaited as the promiseExit setter awaits it, then completeSave with the panel's
// callbacks for the view it was started from
const startSave = (registry: AtomRegistry.AtomRegistry, mounted: ReturnType<typeof mountedPanel>, shown: {read: string; environmentId: Environment; atom: Atom.Atom<AsyncResult.AsyncResult<{definitions: ProjectDefinitionSnapshot}, unknown>>}, summary: string) => {
  const loaded = registry.get(shown.atom);
  assert.ok(AsyncResult.isSuccess(loaded));
  const definitions = loaded.value.definitions;
  const reports = panel.editorCompletion(mounted.update, shown.read, shown.environmentId, Date.now);
  const scope = editor.configurationScope(shown.environmentId, definitions);
  const draft = editor.configurationDrafts(scope);
  registry.set(draft, {...editor.freshDraft(), editing: true, config: configuration(summary)});
  reports.onDirtyChange(true);
  const plan = editor.planSave(definitions, configuration(summary), () => true);
  assert.ok(plan._tag === "Save");
  const attempt = api.saveProjectConfigurationAtom({scope, operationId: registry.get(draft).operationId});
  reports.onSavingChange(true);
  registry.set(attempt, plan.input);
  return Effect.runPromiseExit(AtomRegistry.getResult(registry, attempt, {suspendOnWaiting: true})).then((exit) =>
    editor.completeSave(api.resolveSave(plan.input)(exit), plan.normalized, (change) => registry.update(draft, change), reports));
};

it("A-R22 a save of a answered after b saved settles a only: b keeps its verified definitions and message, and a shows its own on return", {timeout: 10_000}, async () => {
  const fake = server();
  const registry = AtomRegistry.make();
  const stopSnapshot = registry.mount(atoms.snapshotAtom);
  const switchTo = async (next: Environment) => {
    fake.switchTo(next);
    registry.refresh(atoms.snapshotAtom);
    await until(registry, atoms.environmentAtom, (value) => value === next, next);
  };
  const mounted = mountedPanel(registry);
  await until(registry, atoms.environmentAtom, (value) => value === "environment-a", "environment a");

  // a saves, and its answer is held after the server applied it
  const viewA = await mounted.show("environment-a");
  fake.holding.add("environment-a");
  const saveA = startSave(registry, mounted, viewA, "A pending save marker");
  await saveSent("A pending save marker");

  // the page moves to b, which saves normally
  await switchTo("environment-b");
  const viewB = await mounted.show("environment-b");
  assert.equal(summaryOf(mounted.shownFor(viewB).definitions), "Fixture B step: environment b.");
  await startSave(registry, mounted, viewB, "B verified save marker");
  const beforeLate = mounted.shownFor(viewB);
  assert.deepEqual([summaryOf(beforeLate.definitions), beforeLate.message], ["B verified save marker", savedText], "b shows its verified save");

  // a's answer arrives late
  fake.release("environment-a");
  await saveA;
  const afterLate = mounted.shownFor(viewB);
  assert.equal(summaryOf(afterLate.definitions), "B verified save marker", "b still shows its verified definitions");
  assert.equal(afterLate.definitions?.environmentId, "environment-b");
  assert.equal(afterLate.message, savedText, "b keeps its saved message");
  assert.deepEqual([afterLate.report.dirty, afterLate.report.saving], [false, false], "b's draft guards are b's");
  assert.equal(summaryOf(panel.savedFor(mounted.state, viewA.read, null)), "A pending save marker", "a's verified save is recorded for a");
  assert.equal(panel.messageFor(mounted.state, viewA), savedText, "a's saved message is recorded for a");
  assert.equal(summaryOf({definitions: fake.stored["environment-b"]}), "B verified save marker", "b's stored data is b's");

  // back in a, the page shows a's applied save and its message
  await switchTo("environment-a");
  const returned = await mounted.show("environment-a");
  const shownA = mounted.shownFor(returned);
  assert.deepEqual([summaryOf(shownA.definitions), shownA.definitions?.environmentId, shownA.message], ["A pending save marker", "environment-a", savedText]);
  assert.deepEqual([shownA.report.dirty, shownA.report.saving], [false, false], "a's settled save leaves a clean and not saving");
  const posts = browser.sent.filter((request) => request.method === "POST" && request.path === "/api/guidance/project-configuration");
  assert.equal(posts.length, 2, "one save per environment, nothing replayed");
  mounted.stop();
  stopSnapshot();
  registry.dispose();
});

it("A-R22 a late completion of a never changes b's dirty or saving report", {timeout: 10_000}, async () => {
  const fake = server();
  const registry = AtomRegistry.make();
  const stopSnapshot = registry.mount(atoms.snapshotAtom);
  const mounted = mountedPanel(registry);
  await until(registry, atoms.environmentAtom, (value) => value === "environment-a", "environment a");
  const viewA = await mounted.show("environment-a");
  fake.holding.add("environment-a");
  const saveA = startSave(registry, mounted, viewA, "A pending save marker");
  await saveSent("A pending save marker");

  fake.switchTo("environment-b");
  registry.refresh(atoms.snapshotAtom);
  await until(registry, atoms.environmentAtom, (value) => value === "environment-b", "environment b");
  const viewB = await mounted.show("environment-b");
  // b's editor holds a draft whose save is still running
  fake.holding.add("environment-b");
  const saveB = startSave(registry, mounted, viewB, "B pending save marker");
  await saveSent("B pending save marker");

  fake.release("environment-a");
  await saveA;
  assert.deepEqual([mounted.shownFor(viewB).report.dirty, mounted.shownFor(viewB).report.saving], [true, true], "b's draft and save still guard b");
  fake.release("environment-b");
  await saveB;
  assert.deepEqual([mounted.shownFor(viewB).report.dirty, mounted.shownFor(viewB).report.saving], [false, false]);
  mounted.stop();
  stopSnapshot();
  registry.dispose();
});
