import assert from "node:assert/strict";
import { it } from "vitest";
import { createNavigator, directoryRoute, openProject, parseRoute, rememberContext, routeHref } from "../ui/src/navigation.js";

it("deep links preserve exact opaque project and conversation identities and explicit root choice", () => {
  const route = {...directoryRoute, projectId: "project/with ?#%", main: "mcp:chat/&?#", section: "supervision" as const};
  assert.deepEqual(parseRoute(routeHref(route)), route);
  assert.equal(parseRoute("#/projects/a/task").main, null);
  assert.equal(parseRoute("#/projects/a").section, "conversations");
  assert.equal(parseRoute("#/projects/a?main=chat").section, "task");
  assert.equal(parseRoute("#/projects/a/definitions?main=").main, "");
  assert.equal(parseRoute("#/projects/a/task?main=deleted-thread").main, "deleted-thread");
  assert.deepEqual(parseRoute("#/projects/%ZZ/task"), directoryRoute);
});

it("remembered context is per project and cannot override an explicit deep link", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {configurable: true, value: {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value)}});
  try {
    rememberContext({...directoryRoute, projectId: "a", main: "old", section: "settings"});
    rememberContext({...directoryRoute, projectId: "b", main: "", section: "definitions"});
    assert.equal(openProject("a").main, "old");
    assert.equal(openProject("b").main, "");
    assert.equal(openProject("c").main, null);
    assert.equal(parseRoute("#/projects/a/task?main=new").main, "new");
    values.set("supervisor-context:c", '{"main":3,"section":"plan"}');
    assert.equal(openProject("c").main, null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

it("canceling Back restores the current entry without erasing the destination or prompting twice", () => {
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

it("a canceled manually entered hash retains the current route and earlier history", () => {
  const route = {...directoryRoute, projectId: "a", main: "exact"};
  let value: {hash: string; state: unknown} = {hash: routeHref(route), state: null};
  let changed = false;
  const controller = createNavigator(route, {read: () => value, push: () => {}, replace: (hash, state) => {value = {hash, state};}, go: () => assert.fail("an untracked hash must not guess a traversal offset")}, () => false, () => {changed = true;});
  controller.start(); value = {hash: "#/projects/b/task?main=other", state: null};
  controller.historyChanged();
  assert.equal(value.hash, routeHref(route));
  assert.equal(changed, false);
});

it("canceling a manual hash then a long Back keeps distinct positions and navigation usable", () => {
  const route = (id: string) => ({...directoryRoute, projectId: id, main: ""});
  const entries: Array<{hash: string; state: unknown}> = [{hash: routeHref(route("a")), state: null}];
  let cursor = 0; let pending = 0; let allowed = true; let current = route("a");
  const controller = createNavigator(current, {read: () => entries[cursor]!, push: (hash, state) => {entries.splice(++cursor);entries.push({hash,state});}, replace: (hash,state) => {entries[cursor] = {hash,state};}, go: delta => {pending = delta;}}, () => allowed, next => {current = {...next, main: next.main ?? ""};});
  controller.start();controller.navigate(route("b"));allowed = false;
  entries.push({hash: routeHref(route("c")), state: null});cursor++;
  controller.historyChanged();
  const positions = entries.map(entry => (entry.state as {supervisorPosition: number}).supervisorPosition);
  assert.equal(new Set(positions).size, entries.length);
  allowed = true;controller.navigate(route("d"));allowed = false;cursor = 0;controller.historyChanged();cursor += pending;pending = 0;controller.historyChanged();
  assert.equal(entries[cursor]!.hash,routeHref(route("d")));
  allowed = true;controller.navigate(route("e"));assert.equal(current.projectId,"e");
});

it("an unexpected traversal during restoration cannot permanently latch navigation", () => {
  const route = (id: string) => ({...directoryRoute, projectId:id, main:""});
  const entries: Array<{hash:string;state:object}> = [{hash:routeHref(route("a")),state:{}}];let cursor=0;let pending=0;let allowed=true;let current=route("a");
  const controller=createNavigator(current,{read:()=>({...entries[cursor]!,index:cursor}),push:(hash,state)=>{entries.splice(++cursor);entries.push({hash,state});},replace:(hash,state)=>{entries[cursor]={hash,state};},go:delta=>{pending=delta;}},()=>allowed,next=>{current={...next,main:next.main??""};});
  controller.start();controller.navigate(route("b"));controller.navigate(route("c"));allowed=false;cursor=1;controller.historyChanged();cursor=0;controller.historyChanged();cursor+=pending;controller.historyChanged();allowed=true;controller.navigate(route("d"));assert.equal(current.projectId,"d");
});

it("browser entry indices restore a canceled Back into history predating initialization", () => {
  const before={...directoryRoute,projectId:"before",main:""};const initial={...directoryRoute,projectId:"current",main:""};
  const entries:Array<{hash:string;state:unknown}>=[{hash:routeHref(before),state:null},{hash:routeHref(initial),state:null}];let cursor=1;let pending=0;
  const controller=createNavigator(initial,{read:()=>({...entries[cursor]!,index:cursor}),push:(hash,state)=>{entries.splice(++cursor);entries.push({hash,state});},replace:(hash,state)=>{entries[cursor]={hash,state};},go:delta=>{pending=delta;}},()=>false,()=>assert.fail("the canceled destination must not become current"));
  controller.start();cursor=0;controller.historyChanged();assert.equal(pending,1);assert.equal(entries[0]!.hash,routeHref(before));assert.equal(entries[0]!.state,null);cursor+=pending;controller.historyChanged();assert.equal(entries[cursor]!.hash,routeHref(initial));
});

// models a browser without the Navigation API: traversals are asynchronous, fire popstate and then hashchange, and ignore out-of-range offsets
const markerBrowser = (preInitialized: Array<string | {id: string; state: unknown}>, initial: string) => {
  const route = (id: string) => ({...directoryRoute, projectId: id, main: ""});
  const entries: Array<{hash: string; state: unknown}> = [...preInitialized, initial].map(item => typeof item === "string" ? {hash: routeHref(route(item)), state: null} : {hash: routeHref(route(item.id)), state: item.state});
  let cursor = entries.length - 1;
  const traversals: number[] = [];
  const timers: Array<() => void> = [];
  const state = {dirty: false, prompts: 0, current: route(initial)};
  const controller = createNavigator(route(initial), {
    read: () => ({...entries[cursor]!, length: entries.length}),
    push: (hash, value) => {entries.splice(++cursor);entries.push({hash, state: value});},
    replace: (hash, value) => {entries[cursor] = {hash, state: value};},
    go: delta => {assert.notEqual(delta, 0, "go(0) would reload the page");traversals.push(delta);},
    later: callback => {timers.push(callback);},
  }, () => {state.prompts++;return !state.dirty;}, next => {state.current = {...next, main: next.main ?? ""};});
  const settle = () => {
    for (let step = 0; traversals.length > 0 && step < 50; step++) {
      const target = cursor + traversals.shift()!;
      if (target < 0 || target >= entries.length) continue;
      const previous = entries[cursor]!.hash;
      cursor = target;
      controller.historyChanged();
      if (entries[cursor]!.hash !== previous) controller.historyChanged();
    }
  };
  controller.start();
  return {
    route, entries, state, controller,
    at: () => parseRoute(entries[cursor]!.hash).projectId,
    app: () => state.current.projectId,
    hashes: () => entries.map(entry => parseRoute(entry.hash).projectId),
    go: (delta: number) => {traversals.push(delta);settle();},
    type: (id: string) => {entries.splice(cursor + 1);entries.push({hash: routeHref(route(id)), state: null});cursor++;controller.historyChanged();controller.historyChanged();settle();},
    expire: () => {timers.splice(0).forEach(callback => callback());settle();},
    link: (id: string) => controller.navigate(route(id)),
  };
};

it("without the Navigation API, canceled traversal into pre-initialization history keeps every entry and navigation usable", () => {
  const browser = markerBrowser(["a"], "b");
  browser.link("c");
  browser.state.dirty = true;
  browser.go(-2);
  assert.equal(browser.at(), "c");
  assert.equal(browser.app(), "c");
  assert.deepEqual(browser.hashes(), ["a", "b", "c"]);
  assert.equal(browser.entries[0]!.state, null, "the pre-initialization destination is not rewritten");
  browser.go(-1);
  assert.equal(browser.at(), "c");
  browser.go(-2);browser.go(1);
  assert.deepEqual([browser.at(), browser.app()], ["c", "c"]);
  browser.state.dirty = false;
  browser.link("d");
  assert.deepEqual([browser.at(), browser.app()], ["d", "d"]);
  browser.go(-2);
  assert.deepEqual([browser.at(), browser.app()], ["b", "b"]);
  browser.go(1);
  assert.deepEqual([browser.at(), browser.app()], ["c", "c"]);
});

it("without the Navigation API, an accepted pre-initialization entry stays unindexed and later cancellations return to it", () => {
  const browser = markerBrowser(["a", "z"], "b");
  browser.go(-1);
  assert.deepEqual([browser.at(), browser.app()], ["z", "z"]);
  assert.equal(browser.entries[1]!.state, null);
  browser.state.dirty = true;
  browser.go(1);
  assert.deepEqual([browser.at(), browser.app()], ["z", "z"]);
  browser.go(-1);
  assert.deepEqual([browser.at(), browser.app()], ["z", "z"]);
  assert.deepEqual(browser.hashes(), ["a", "z", "b"]);
  assert.deepEqual([browser.entries[0]!.state, browser.entries[1]!.state], [null, null]);
  browser.state.dirty = false;
  browser.go(1);
  assert.deepEqual([browser.at(), browser.app()], ["b", "b"]);
  browser.go(-1);
  browser.link("c");
  assert.deepEqual([browser.at(), browser.app()], ["c", "c"]);
  browser.go(-1);
  assert.deepEqual([browser.at(), browser.app()], ["z", "z"]);
});

it("without the Navigation API, a canceled manual hash that replaced a forward entry recovers instead of waiting forever", () => {
  const browser = markerBrowser([], "a");
  browser.link("b");
  browser.go(-1);
  browser.state.dirty = true;
  browser.type("x");
  assert.equal(browser.app(), "a");
  browser.link("c");
  assert.equal(browser.app(), "a", "navigation waits only while the bounded restoration is pending");
  browser.expire();
  assert.deepEqual([browser.at(), browser.app()], ["a", "a"]);
  assert.ok(browser.hashes().includes("x"), "the typed entry is kept rather than overwritten");
  browser.state.dirty = false;
  browser.link("c");
  assert.deepEqual([browser.at(), browser.app()], ["c", "c"]);
});

it("without the Navigation API, a canceled manual hash at the end is replaced immediately", () => {
  const browser = markerBrowser([], "a");
  browser.state.dirty = true;
  browser.type("x");
  assert.deepEqual([browser.at(), browser.app()], ["a", "a"]);
  assert.deepEqual(browser.hashes(), ["a", "a"]);
  browser.go(-1);
  assert.deepEqual([browser.at(), browser.app()], ["a", "a"]);
  browser.state.dirty = false;
  browser.link("b");
  browser.go(-1);
  assert.deepEqual([browser.at(), browser.app()], ["a", "a"]);
});

it("without the Navigation API, duplicate traversal events prompt once and markers from another page lifetime are not trusted", () => {
  const stale = {supervisorPosition: 5, owner: "other"};
  const browser = markerBrowser([{id: "a", state: stale}], "b");
  browser.link("c");
  browser.state.dirty = true;
  browser.state.prompts = 0;
  browser.go(-2);
  assert.equal(browser.state.prompts, 1);
  assert.deepEqual([browser.at(), browser.app()], ["c", "c"]);
  assert.equal(browser.entries[0]!.state, stale);
});

it("without the Navigation API, indistinguishable unindexed entries end in a bounded recovery instead of a lock", () => {
  const browser = markerBrowser(["a", "a"], "b");
  browser.state.dirty = true;
  browser.go(-2);
  browser.expire();
  assert.deepEqual([browser.at(), browser.app()], ["b", "b"]);
  browser.state.dirty = false;
  browser.link("c");
  assert.deepEqual([browser.at(), browser.app()], ["c", "c"]);
  browser.go(-1);
  assert.deepEqual([browser.at(), browser.app()], ["b", "b"]);
});

it("without the Navigation API, a marker lineage adopted from the initial entry restores consistent entries and never rewrites inconsistent ones", () => {
  const route = (id: string) => ({...directoryRoute, projectId: id, main: ""});
  const run = (earlierPosition: number) => {
    const earlier = {supervisorHistory: "earlier", supervisorPosition: earlierPosition};
    const entries: Array<{hash: string; state: unknown}> = [{hash: routeHref(route("a")), state: earlier},
      {hash: routeHref(route("b")), state: {supervisorHistory: "earlier", supervisorPosition: 1}}];
    let cursor = 1;
    const traversals: number[] = [];
    const timers: Array<() => void> = [];
    const state = {dirty: true, prompts: 0, current: route("b")};
    const controller = createNavigator(route("b"), {
      read: () => ({...entries[cursor]!, length: entries.length}),
      push: (hash, value) => {entries.splice(++cursor);entries.push({hash, state: value});},
      replace: (hash, value) => {entries[cursor] = {hash, state: value};},
      go: delta => {assert.notEqual(delta, 0);traversals.push(delta);},
      later: callback => {timers.push(callback);},
    }, () => {state.prompts++;return !state.dirty;}, next => {state.current = {...next, main: next.main ?? ""};});
    controller.start();
    cursor = 0;controller.historyChanged();controller.historyChanged();
    for (const delta of traversals.splice(0)) if (cursor + delta >= 0 && cursor + delta < entries.length) {cursor += delta;controller.historyChanged();}
    timers.splice(0).forEach(callback => callback());
    assert.equal(state.prompts, 1);
    assert.equal(entries[0]!.hash, routeHref(route("a")));
    assert.equal(entries[0]!.state, earlier, "the destination entry is never rewritten");
    assert.equal(parseRoute(entries[cursor]!.hash).projectId, "b");
    assert.equal(state.current.projectId, "b");
    state.dirty = false;
    controller.navigate(route("c"));
    assert.equal(state.current.projectId, "c");
    assert.deepEqual(entries.map(entry => parseRoute(entry.hash).projectId), ["a", "b", "c"]);
    return (entries[1]!.state as {supervisorHistory: string}).supervisorHistory;
  };
  assert.equal(run(0), "earlier", "a consistent adopted marker restores the original entry");
  assert.notEqual(run(7), "earlier", "an inconsistent adopted marker recovers on a new entry instead of overwriting one");
});

it("without the Navigation API, markers written without a lineage never steer a canceled Forward", () => {
  const route = (id: string) => ({...directoryRoute, projectId: id, main: ""});
  const scenario = (stack: Array<[string, number | null]>, initial: number, back: number, reinitialize: boolean) => {
    const entries: Array<{hash: string; state: unknown}> = stack.map(([id, marker]) => ({hash: routeHref(route(id)), state: marker === null ? null : {supervisorPosition: marker}}));
    const original = entries.map(entry => ({...entry}));
    let cursor = initial;
    const traversals: number[] = [];
    const timers: Array<() => void> = [];
    const state = {dirty: false, prompts: 0, current: route(stack[initial]![0])};
    const make = () => createNavigator(parseRoute(entries[cursor]!.hash), {
      read: () => ({...entries[cursor]!, length: entries.length}),
      push: (hash, value) => {entries.splice(++cursor);entries.push({hash, state: value});},
      replace: (hash, value) => {entries[cursor] = {hash, state: value};},
      go: delta => {assert.notEqual(delta, 0);traversals.push(delta);},
      later: callback => {timers.push(callback);},
    }, () => {state.prompts++;return !state.dirty;}, next => {state.current = {...next, main: next.main ?? ""};});
    let controller = make();
    controller.start();
    if (reinitialize) {controller = make();controller.start();}
    const settle = () => {
      for (let step = 0; traversals.length > 0 && step < 20; step++) {
        const target = cursor + traversals.shift()!;
        if (target < 0 || target >= entries.length) continue;
        const previous = entries[cursor]!.hash;
        cursor = target;controller.historyChanged();
        if (entries[cursor]!.hash !== previous) controller.historyChanged();
      }
    };
    const go = (delta: number) => {traversals.push(delta);settle();};
    go(-back);
    const landed = cursor;
    state.dirty = true;state.prompts = 0;
    go(1);
    timers.splice(0).forEach(callback => callback());settle();
    assert.equal(state.prompts, 1);
    assert.equal(cursor, landed, "the canceled Forward returns to the entry the page shows");
    assert.equal(state.current.projectId, stack[landed]![0]);
    entries.forEach((entry, index) => {
      if (index !== initial) assert.deepEqual(entry, original[index], `entry ${index} is unchanged`);
    });
    state.dirty = false;
    controller.navigate(route("next"));
    assert.equal(state.current.projectId, "next");
  };
  for (const reinitialize of [false, true]) {
    scenario([["a", 0], ["b", 1]], 1, 1, reinitialize);
    scenario([["a", 0], ["b", 1], ["c", 2]], 1, 1, reinitialize);
    scenario([["a", 0], ["b", 1], ["c", 2]], 2, 2, reinitialize);
    scenario([["pre", null], ["a", 0], ["b", 1]], 2, 1, reinitialize);
    scenario([["pre", null], ["a", 0], ["b", 1]], 2, 2, reinitialize);
  }
});
