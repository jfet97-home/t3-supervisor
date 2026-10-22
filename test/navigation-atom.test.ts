import assert from "node:assert/strict";
import { AtomRegistry } from "effect/reactivity";
import { afterAll, beforeAll, it } from "vitest";
import { makeBrowser, until } from "./support/ui-browser.js";

// target regressions of the route atom (plan section 9 history adapter): history and hash events feed the route, a
// guarded entry is restored, the bounded restore timer recovers a traversal without an event, and every listener and
// pending timer is released with the atom

const browser = makeBrowser();
type Navigation = typeof import("../ui/src/navigation.js");
let ui: Navigation;

beforeAll(async () => {
  browser.install();
  ui = await import("../ui/src/navigation.js");
});
afterAll(() => browser.restore());

const project = (projectId: string, main: string | null = "", section: "progress" | "plan" = "progress") => ({...ui.directoryRoute, projectId, main, section});

it("the route atom follows navigation and history, restores a guarded entry, recovers a silent traversal and releases its listeners", { timeout: 10_000 }, async () => {
  const registry = AtomRegistry.make();
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
  await until(registry, ui.navigationAtom, (state) => state.route.projectId === "a", "Back to a");
  guard.current = () => false;
  const before = browser.entries.length;
  browser.typeHash("#/guide");
  assert.equal(browser.entries.length, before, "the typed hash replaced the forward entry");
  await browser.historyWhere(() => browser.entries.length === before + 1, "the recovery entry");
  assert.equal(browser.location.hash, ui.routeHref(project("a")));
  assert.ok(browser.entries.some((entry) => entry.hash === "#/guide"), "the typed entry is kept");
  assert.deepEqual(registry.get(ui.navigationAtom).route, project("a"));
  guard.current = () => true;
  navigate(project("c"));
  assert.deepEqual(registry.get(ui.navigationAtom).route, project("c"), "navigation is not latched");

  stop();
  registry.dispose();
  assert.deepEqual([browser.listeners.get("hashchange"), browser.listeners.get("popstate")], [0, 0]);
});

it("disposing the route atom cancels a pending restore", { timeout: 10_000 }, async () => {
  const registry = AtomRegistry.make();
  const stop = registry.subscribe(ui.navigationAtom, () => undefined, { immediate: true });
  const {navigate, guard} = registry.get(ui.navigationAtom);
  navigate(project("d"));
  browser.history.go(-1);
  await until(registry, ui.navigationAtom, (state) => state.route.projectId === "c", "Back to c");
  guard.current = () => false;
  browser.typeHash("#/activity");
  stop();
  registry.dispose();
  const entries = browser.entries.length;
  // absence of the recovery can only be observed over time: the one-second restore deadline passes after disposal
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(browser.entries.length, entries, "no recovery entry after disposal");
  assert.deepEqual([browser.listeners.get("hashchange"), browser.listeners.get("popstate")], [0, 0]);
});
