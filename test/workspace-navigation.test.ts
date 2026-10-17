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
