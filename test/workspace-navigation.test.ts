import assert from "node:assert/strict";
import { test } from "node:test";
import { directoryRoute, openProject, parseRoute, rememberContext, routeHref } from "../ui/src/navigation.js";

test("deep links preserve exact opaque project and conversation identities and explicit root choice", () => {
  const route = {...directoryRoute, projectId: "project/with ?#%", main: "mcp:chat/&?#", section: "plan" as const};
  assert.deepEqual(parseRoute(routeHref(route)), route);
  assert.equal(parseRoute("#/projects/a/progress").main, null);
  assert.equal(parseRoute("#/projects/a/definitions?main=").main, "");
  assert.equal(parseRoute("#/projects/a/progress?main=deleted-thread").main, "deleted-thread");
  assert.deepEqual(parseRoute("#/projects/%ZZ/progress"), directoryRoute);
});

test("remembered context is per project and cannot override an explicit deep link", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {configurable: true, value: {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value)}});
  try {
    rememberContext({...directoryRoute, projectId: "a", main: "old", section: "settings"});
    rememberContext({...directoryRoute, projectId: "b", main: "", section: "definitions"});
    assert.equal(openProject("a").main, "old");
    assert.equal(openProject("b").main, "");
    assert.equal(openProject("c").main, null);
    assert.equal(parseRoute("#/projects/a/progress?main=new").main, "new");
    values.set("supervisor-context:c", '{"main":3,"section":"plan"}');
    assert.equal(openProject("c").main, null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("canceling Back restores the current entry without erasing the destination or prompting twice", async () => {
  const {createNavigator} = await import("../ui/src/navigation.js");
  const first = {...directoryRoute, projectId: "a", main: "old"};
  const second = {...first, main: "new"};
  const entries = [{hash: routeHref(first), state: {} as object}];
  let cursor = 0;
  let pending = 0;
  let allowed = true;
  let prompts = 0;
  let current: ReturnType<typeof parseRoute> = first;
  const controller = createNavigator(first, {
    read: () => entries[cursor]!,
    push: (hash, state) => {entries.splice(++cursor); entries.push({hash, state});},
    replace: (hash, state) => {entries[cursor] = {hash, state};},
    go: delta => {pending = delta;},
  }, () => {prompts++;return allowed;}, route => {current = route;});
  controller.start(); controller.navigate(second);
  assert.deepEqual(current, second);
  const originalDestination = {...entries[0]!};
  allowed = false; prompts = 0; cursor--;
  controller.historyChanged(); controller.historyChanged();
  assert.equal(prompts, 1);
  assert.equal(pending, 1);
  assert.deepEqual(entries[0], originalDestination);
  assert.deepEqual(current, second);
  cursor += pending; pending = 0; controller.historyChanged();
  allowed = true; cursor--; controller.historyChanged();
  assert.deepEqual(current, first);
  assert.deepEqual(entries[0], originalDestination);
});

test("a canceled manually entered hash retains the current route and earlier history", async () => {
  const {createNavigator} = await import("../ui/src/navigation.js");
  const route = {...directoryRoute, projectId: "a", main: "exact"};
  let value: {hash: string; state: unknown} = {hash: routeHref(route), state: null};
  let changed = false;
  const controller = createNavigator(route, {read: () => value, push: () => {}, replace: (hash, state) => {value = {hash, state};}, go: () => assert.fail("an untracked hash must not guess a traversal offset")}, () => false, () => {changed = true;});
  controller.start(); value = {hash: "#/projects/b/progress?main=other", state: null};
  controller.historyChanged();
  assert.equal(value.hash, routeHref(route));
  assert.equal(changed, false);
});
