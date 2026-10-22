import assert from "node:assert/strict";
import { Effect } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterAll, beforeAll, it } from "vitest";

// target regressions of the shared ui atom contract (plan 3.8, WP-S7-CORE) over a stubbed browser: admitted mutations,
// outcome classification, visibility-aware polling, retained last success, keep-alive drafts and the auth epoch

const originals = new Map<string, PropertyDescriptor | undefined>();
const install = (key: string, value: unknown) => {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
};

interface Sent { readonly method: string; readonly path: string; readonly session: string | null; readonly csrf: string | null }
const sent: Sent[] = [];
let reply: (path: string) => Promise<Response> = async () => new Response("{}");
const storage = new Map<string, string>();
const browser = new EventTarget();
let visibility: "visible" | "hidden" = "visible";

type Core = typeof import("../ui/src/atoms.js");
type Access = typeof import("../ui/src/access.js");
type Api = typeof import("../ui/src/api.js");
let core: Core;
let access: Access;
let api: Api;

beforeAll(async () => {
  install("location", { origin: "http://supervisor.test" });
  install("window", browser);
  install("document", { get visibilityState() { return visibility; }, get hidden() { return visibility === "hidden"; } });
  install("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); } });
  install("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://supervisor.test");
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    sent.push({ method: input instanceof Request ? input.method : init?.method ?? "GET", path: url.pathname,
      session: headers.get("x-supervisor-session"), csrf: headers.get("x-csrf-token") });
    return reply(url.pathname);
  });
  access = await import("../ui/src/access.js");
  api = await import("../ui/src/api.js");
  core = await import("../ui/src/atoms.js");
});

afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

// resolves with the first value of the atom that satisfies the predicate
const until = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, predicate: (value: A) => boolean, label: string) =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error(`${label} not reached`)); }, 5_000);
    const stop = registry.subscribe(atom, (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      queueMicrotask(() => stop());
      resolve(value);
    }, { immediate: true });
  });

const policy = { generation: 1, excludedThreadIds: [] as string[] };
const savePolicy = () => core.admittedMutation((input: typeof policy) =>
  Effect.flatMap(api.ApiClient, (client) => client.guidance.threadPolicy({ payload: input })));

it("an admitted mutation sends one request for repeated writes, survives unmount and keeps its outcome for its scope", { timeout: 10_000 }, async () => {
  const registry = AtomRegistry.make();
  storage.set("supervisor-session", "session-1");
  sent.length = 0;
  let release: (response: Response) => void = () => undefined;
  reply = () => new Promise<Response>((resolve) => { release = resolve; });
  const mutation = savePolicy()({ scope: core.scopeKey("settings", "env-1"), operationId: "op-1" });
  const unmount = registry.mount(mutation);
  registry.set(mutation, policy);
  registry.set(mutation, { ...policy, generation: 2 });
  unmount();
  await until(registry, mutation, AsyncResult.isWaiting, "waiting");
  release(new Response(JSON.stringify({ generation: 2, excludedThreadIds: [] })));
  const done = await until(registry, mutation, AsyncResult.isSuccess, "saved");
  assert.deepEqual(AsyncResult.isSuccess(done) ? done.value : undefined, { generation: 2, excludedThreadIds: [] });
  assert.deepEqual(sent.map((request) => [request.method, request.path, request.session]), [["POST", "/api/guidance/thread-policy", "session-1"]]);
  // writing the finished operation again replays nothing
  registry.set(mutation, policy);
  assert.ok(AsyncResult.isSuccess(registry.get(mutation)));
  assert.equal(sent.length, 1);
  // another scope with the same operation id is a different operation
  const other = savePolicy()({ scope: core.scopeKey("settings", "env-2"), operationId: "op-1" });
  assert.ok(AsyncResult.isInitial(registry.get(other)));
  registry.dispose();
});

it("mutation failures follow the baseline outcome rules without replaying the request", { timeout: 10_000 }, async () => {
  const cases: Array<[string, number, string, number, string]> = [
    ["401 refreshed", 401, JSON.stringify({ csrf: "fresh" }), 200, "NotPerformed:refreshed"],
    ["403 refresh failed", 403, "{}", 401, "NotPerformed:refresh_failed"],
    ["413", 413, "{}", 200, "NotPerformed:too_large"],
    ["415", 415, "{}", 200, "NotPerformed:format"],
    ["500", 500, "{}", 200, "Unconfirmed"],
    ["400 UiError", 400, JSON.stringify({ _tag: "UiError", message: "Reload first." }), 200, "Unconfirmed"],
    ["undecodable success", 200, JSON.stringify({ generation: "x" }), 200, "Unconfirmed"],
  ];
  for (const [label, status, csrfBody, csrfStatus, expected] of cases) {
    const registry = AtomRegistry.make();
    storage.set("supervisor-session", "session-1");
    sent.length = 0;
    reply = async (path) => path === "/api/csrf"
      ? new Response(csrfBody, { status: csrfStatus })
      : new Response(status === 200 ? JSON.stringify({ generation: "x" }) : status === 400 ? csrfBody : "{}", { status });
    const mutation = savePolicy()({ scope: core.scopeKey("failures", label), operationId: "op" });
    registry.set(mutation, policy);
    const failed = await until(registry, mutation, AsyncResult.isFailure, label);
    const squashed = AsyncResult.error(failed);
    const tag = squashed._tag === "Some" ? (squashed.value._tag === "NotPerformed" ? `NotPerformed:${squashed.value.reason}` : squashed.value._tag) : "none";
    assert.equal(tag, expected, label);
    const posts = sent.filter((request) => request.path === "/api/guidance/thread-policy");
    assert.equal(posts.length, 1, `${label}: never replayed`);
    registry.dispose();
  }
});

it("the poll signal ticks only while the page is visible and a refreshed read keeps its last success after a failure", { timeout: 10_000 }, async () => {
  const registry = AtomRegistry.make();
  let reads = 0;
  let fail = false;
  const read = core.uiRuntime.atom(Effect.suspend(() => { reads++; return fail ? Effect.fail("unavailable" as const) : Effect.succeed(reads); }))
    .pipe(core.pollWhileVisible(20));
  const stop = registry.subscribe(read, () => undefined, { immediate: true });
  await until(registry, read, (value) => AsyncResult.isSuccess(value) && reads >= 2, "a visible tick refreshes");
  visibility = "hidden";
  const hiddenFrom = reads;
  // absence of a refresh can only be observed over time: six intervals pass while hidden and nothing reads
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(reads, hiddenFrom, "no polling while hidden");
  fail = true;
  visibility = "visible";
  const failed = await until(registry, read, AsyncResult.isFailure, "the next visible tick fails");
  assert.ok(AsyncResult.isFailure(failed) && failed.previousSuccess._tag === "Some", "the last successful read is kept");
  stop();
  registry.dispose();
});

it("drafts are keep-alive per scope and survive unmount; the auth epoch advances on sign-in and on another tab's change", { timeout: 10_000 }, async () => {
  const registry = AtomRegistry.make();
  const drafts = core.draftFamily(() => "");
  const draft = drafts(core.scopeKey("project", "p-1"));
  const unmount = registry.mount(draft);
  registry.set(draft, "edited");
  unmount();
  assert.equal(registry.get(drafts(core.scopeKey("project", "p-1"))), "edited");
  assert.equal(registry.get(drafts(core.scopeKey("project", "p-2"))), "");

  const stopEpoch = registry.subscribe(core.authEpochAtom, () => undefined, { immediate: true });
  const signIn = Effect.flatMap(access.SessionAccess, (session) => session.signIn("session-2"));
  const runIn = core.uiRuntime.fn(() => signIn);
  registry.set(runIn, undefined);
  await until(registry, core.authEpochAtom, (value) => AsyncResult.isSuccess(value) && value.value >= 1, "sign-in advances the epoch");
  const event = new Event("storage");
  Object.defineProperties(event, { key: { value: "supervisor-session" }, storageArea: { value: globalThis.localStorage } });
  browser.dispatchEvent(event);
  await until(registry, core.authEpochAtom, (value) => AsyncResult.isSuccess(value) && value.value >= 2, "another tab advances the epoch");
  stopEpoch();
  registry.dispose();
});
