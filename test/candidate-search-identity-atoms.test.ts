import assert from "node:assert/strict";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { afterAll, beforeAll, it, onTestFinished } from "vitest";
import { json, makeBrowser, until } from "./support/ui-browser.js";

// target regressions of the candidate search identity (OWN-UI-01) over a stubbed browser and the real page runtime. Atom.family
// keeps its members only through weak references, so a family nested in a family keeps its inner families alive only
// while something else references them; a garbage collection between two evaluations of the search then made a new atom
// for the same key, a new registry node and a second request. the cases force that collection at the exact point: after
// the first request left and before its answer arrives, with the query, purpose, environment and session unchanged

const browser = makeBrowser();
let ui: typeof import("../ui/src/no-project.js");

beforeAll(async () => {
  browser.install();
  browser.local.set("supervisor-session", "session-1");
  ui = await import("../ui/src/no-project.js");
});
afterAll(() => browser.restore());

const collect = () => {
  const gc = (globalThis as {gc?: () => void}).gc;
  assert.equal(typeof gc, "function", "the test workers run with --expose-gc");
  gc!();
};
// one turn of the event loop: a weak reference dereferenced in the current job keeps its target until that job ends
const nextTurn = () => new Promise<void>((resolve) => { setImmediate(resolve); });
const candidates = {exceptions: [], candidates: [{id: "thread-1", projectId: "", title: "Chat", updatedAt: null, active: false, excluded: false}], message: "1 recent chat."};
const searches = () => browser.sent.filter((request) => request.path === "/api/guidance/supervision-candidates");
// a registry disposed when the test ends, also after a failed assertion
const testRegistry = () => {
  const registry = AtomRegistry.make();
  onTestFinished(() => registry.dispose());
  return registry;
};

for (const [purpose, query] of [["start", "chat"], ["exclude", ""]] as const) it(`OWN-UI-01 a ${purpose} search for ${JSON.stringify(query)} sends one request when a garbage collection runs before its answer`, {timeout: 10_000}, async () => {
  browser.sent.length = 0;
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  browser.state.reply = async (request) => {
    if (request.path === "/api/csrf") return json({csrf: "token"});
    await answered;
    return json(candidates);
  };
  const registry = testRegistry();
  const superseded = registry.subscribe(ui.chatCandidates(purpose)(`${query}-superseded`)(0), () => undefined, {immediate: true});
  superseded();
  const atom = ui.chatCandidates(purpose)(query)(0);
  const stop = registry.subscribe(atom, () => undefined, {immediate: true});
  onTestFinished(stop);
  await browser.request((request) => request.path === "/api/guidance/supervision-candidates", "the search");
  await nextTurn();
  collect();
  answer();
  const result = await until(registry, atom, (value) => AsyncResult.isSuccess(value) && !value.waiting, "the search answered");
  assert.deepEqual(AsyncResult.isSuccess(result) ? result.value : undefined, candidates);
  assert.deepEqual(searches().map((request) => Object.fromEntries(request.search)), [{query, purpose}], "the unchanged search is requested once");
});

it("OWN-UI-01 a mounted candidate search keeps its atom across a garbage collection, so a page render resolves the same search", {timeout: 10_000}, async () => {
  browser.sent.length = 0;
  browser.state.reply = () => json(candidates);
  const registry = testRegistry();
  const atom = ui.chatCandidates("start")("")(0);
  const stop = registry.subscribe(atom, () => undefined, {immediate: true});
  onTestFinished(stop);
  await until(registry, atom, (value) => AsyncResult.isSuccess(value) && !value.waiting, "the search answered");
  await nextTurn();
  collect();
  assert.equal(ui.chatCandidates("start")("")(0), atom, "the render resolves the mounted search, not a new one");
  assert.equal(searches().length, 1);
});
