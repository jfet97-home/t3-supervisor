import assert from "node:assert/strict";
import { beforeAll, it } from "@effect/vitest";
import { Effect } from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { clockedRegistry } from "./support/g7-page.js";
import { makeBrowser, nextTurn, until } from "./support/g7-browser.js";
import { countedRegistry, elapse } from "./support/s8ui-clock.js";

// target regressions of the route atom (plan section 9 history adapter): history and hash events feed the route, a
// guarded entry is restored, the bounded restore timer recovers a traversal without an event, and every listener and
// pending timer is released with the atom. the restore timer runs on the page runtime, so its one-second deadline passes
// with TestClock steps on the runtime's clock; the waits for a route or a history write are bounded on the live clock

const browser = makeBrowser();
type Navigation = typeof import("../ui/src/navigation.js");
let ui: Navigation;
let atoms: typeof import("../ui/src/atoms.js");

beforeAll(() => Effect.gen(function* () {
  yield* browser.install;
  atoms = yield* Effect.promise(() => import("../ui/src/atoms.js"));
  ui = yield* Effect.promise(() => import("../ui/src/navigation.js"));
}));

const project = (projectId: string, main: string | null = "", section: "progress" | "plan" = "progress") => ({...ui.directoryRoute, projectId, main, section});

it.effect("the route atom follows navigation and history, restores a guarded entry, recovers a silent traversal and releases its listeners", () => Effect.gen(function* () {
  const registry = yield* clockedRegistry(atoms.uiRuntime);
  const stop = registry.subscribe(ui.navigationAtom, () => undefined, { immediate: true });
  assert.deepEqual([browser.listeners.get("hashchange"), browser.listeners.get("popstate")], [1, 1]);
  assert.deepEqual(registry.get(ui.navigationAtom).route, ui.homeRoute);
  assert.equal(browser.location.hash, "#/home");

  const {navigate, guard} = registry.get(ui.navigationAtom);
  navigate(project("a", "chat-1", "plan"));
  assert.deepEqual(registry.get(ui.navigationAtom).route, project("a", "chat-1", "plan"));
  assert.equal(browser.session.get("supervisor-context:a"), JSON.stringify({main: "chat-1", section: "plan"}));
  assert.equal(registry.get(ui.navigationAtom).navigate, navigate, "navigate stays stable across routes");
  navigate(project("a"));

  // a typed hash rejected by the guard leaves the route and restores the address
  let prompts = 0;
  guard.current = () => { prompts++; return false; };
  browser.typeHash("#/settings");
  assert.equal(prompts, 1);
  assert.deepEqual(registry.get(ui.navigationAtom).route, project("a"));
  assert.equal(browser.location.hash, ui.routeHref(project("a")));

  // a typed hash that replaced a forward entry produces no event when restored; the bounded timer recovers it
  guard.current = () => true;
  navigate(project("b"));
  browser.history.go(-1);
  yield* until(registry, ui.navigationAtom, (state) => state.route.projectId === "a", "Back to a");
  guard.current = () => false;
  const before = browser.entries.length;
  browser.typeHash("#/guide");
  assert.equal(browser.entries.length, before, "the typed hash replaced the forward entry");
  // the one-second restore deadline passes on the page runtime's clock
  yield* elapse("1 second");
  assert.equal(browser.entries.length, before + 1, "the recovery entry");
  assert.equal(browser.location.hash, ui.routeHref(project("a")));
  assert.ok(browser.entries.some((entry) => entry.hash === "#/guide"), "the typed entry is kept");
  assert.deepEqual(registry.get(ui.navigationAtom).route, project("a"));
  guard.current = () => true;
  navigate(project("c"));
  assert.deepEqual(registry.get(ui.navigationAtom).route, project("c"), "navigation is not latched");

  stop();
  registry.dispose();
  assert.deepEqual([browser.listeners.get("hashchange"), browser.listeners.get("popstate")], [0, 0]);
}), { timeout: 10_000 });

it.effect("disposing the route atom cancels a pending restore", () => Effect.gen(function* () {
  const registry = yield* clockedRegistry(atoms.uiRuntime);
  const stop = registry.subscribe(ui.navigationAtom, () => undefined, { immediate: true });
  const {navigate, guard} = registry.get(ui.navigationAtom);
  navigate(project("d"));
  browser.history.go(-1);
  yield* until(registry, ui.navigationAtom, (state) => state.route.projectId === "c", "Back to c");
  guard.current = () => false;
  browser.typeHash("#/activity");
  stop();
  registry.dispose();
  const entries = browser.entries.length;
  // the one-second restore deadline, and 200 ms more, pass on the page runtime's clock after disposal
  yield* elapse("1200 millis");
  assert.equal(browser.entries.length, entries, "no recovery entry after disposal");
  assert.deepEqual([browser.listeners.get("hashchange"), browser.listeners.get("popstate")], [0, 0]);
}), { timeout: 10_000 });

// a guarded hash typed over the forward entry of a project the page went back to: the restore traversal produces no
// event, so only the restore deadline recovers it; answers the project's route and the entry count before the recovery
const pendingRestore = (registry: AtomRegistry.AtomRegistry, from: string, away: string) => Effect.gen(function* () {
  const {navigate, guard} = registry.get(ui.navigationAtom);
  guard.current = () => true;
  navigate(project(from));
  navigate(project(away));
  browser.history.go(-1);
  yield* until(registry, ui.navigationAtom, (state) => state.route.projectId === from, `Back to ${from}`);
  guard.current = () => false;
  const before = browser.entries.length;
  browser.typeHash("#/guide");
  assert.equal(browser.entries.length, before, "the typed hash replaced the forward entry");
  assert.deepEqual(registry.get(ui.navigationAtom).route, project(from), "the guard kept the route");
  return {route: project(from), before};
});

it.effect("the restore deadline runs on the page runtime's clock: no recovery before it passes, the recovery when it passes, and no timer after it", () => Effect.gen(function* () {
  const {registry, sleeps} = yield* countedRegistry(atoms.uiRuntime);
  const stop = registry.subscribe(ui.navigationAtom, () => undefined, { immediate: true });
  const {route, before} = yield* pendingRestore(registry, "e", "f");
  assert.equal(sleeps(), 1, "the restore deadline is the one timer on the page runtime's clock");
  yield* elapse("999 millis");
  assert.equal(browser.entries.length, before, "no recovery before the deadline passes");
  yield* elapse("1 millis");
  assert.equal(browser.entries.length, before + 1, "the recovery entry when the deadline passes");
  assert.equal(browser.location.hash, ui.routeHref(route));
  assert.equal(sleeps(), 0, "no timer outlives the deadline");
  stop();
}), { timeout: 10_000 });

it.effect("unmounting the route atom or disposing its registry cancels a pending restore and leaves no timer on the page runtime's clock", () => Effect.gen(function* () {
  // the last subscriber of the route atom unmounts it
  const unmounted = yield* countedRegistry(atoms.uiRuntime);
  const stop = unmounted.registry.subscribe(ui.navigationAtom, () => undefined, { immediate: true });
  const first = yield* pendingRestore(unmounted.registry, "g", "h");
  assert.equal(unmounted.sleeps(), 1, "the restore deadline is pending");
  stop();
  // the registry removes an atom without subscribers on its next task
  yield* nextTurn;
  assert.deepEqual([browser.listeners.get("hashchange"), browser.listeners.get("popstate")], [0, 0]);
  assert.equal(unmounted.sleeps(), 0, "no timer after unmounting");
  yield* elapse("1200 millis");
  assert.equal(browser.entries.length, first.before, "no recovery entry after unmounting");

  // the registry is disposed with the route atom mounted
  const disposed = yield* countedRegistry(atoms.uiRuntime);
  disposed.registry.subscribe(ui.navigationAtom, () => undefined, { immediate: true });
  const second = yield* pendingRestore(disposed.registry, "i", "j");
  assert.equal(disposed.sleeps(), 1, "the restore deadline is pending");
  disposed.registry.dispose();
  assert.deepEqual([browser.listeners.get("hashchange"), browser.listeners.get("popstate")], [0, 0]);
  assert.equal(disposed.sleeps(), 0, "no timer after disposal");
  yield* elapse("1200 millis");
  assert.equal(browser.entries.length, second.before, "no recovery entry after disposal");
}), { timeout: 10_000 });

it.effect("a traversal back to the page's entry settles a pending restore: its deadline then passes without a recovery and leaves no timer", () => Effect.gen(function* () {
  const {registry, sleeps} = yield* countedRegistry(atoms.uiRuntime);
  const stop = registry.subscribe(ui.navigationAtom, () => undefined, { immediate: true });
  const {route, before} = yield* pendingRestore(registry, "k", "l");
  assert.equal(sleeps(), 1, "the restore deadline is pending");
  // Back returns to the entry the page shows before the deadline; its popstate is handled once the turn ends
  browser.history.go(-1);
  yield* nextTurn;
  assert.equal(browser.location.hash, ui.routeHref(route));
  assert.deepEqual(registry.get(ui.navigationAtom).route, route);
  yield* elapse("1 second");
  assert.equal(browser.entries.length, before, "the settled restore writes no recovery entry");
  assert.equal(browser.location.hash, ui.routeHref(route));
  assert.equal(sleeps(), 0, "no timer outlives the deadline");
  // navigation is not latched by the settled restore
  registry.get(ui.navigationAtom).guard.current = () => true;
  registry.get(ui.navigationAtom).navigate(project("m"));
  assert.deepEqual(registry.get(ui.navigationAtom).route, project("m"));
  stop();
}), { timeout: 10_000 });
