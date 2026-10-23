import assert from "node:assert/strict";
import { beforeAll, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { TestClock } from "effect/testing";
import { clockedRegistry, installGlobal, scopedRegistry } from "./support/g7-page.js";
import { orAfter, until } from "./support/g7-browser.js";

// target regressions of the shared ui atom contract (plan 3.8, WP-S7-CORE) over a stubbed browser: admitted mutations,
// outcome classification, visibility-aware polling, retained last success, keep-alive drafts and the auth epoch. the
// waits for an atom value are bounded on the live clock; the poll test steps the page runtime's clock with TestClock, and
// the disposal test is it.live because the absence of an abort can only be observed over real event-loop time

interface Sent { readonly method: string; readonly path: string; readonly session: string | null; readonly csrf: string | null }
const sent: Sent[] = [];
let reply: (path: string, signal: AbortSignal | undefined) => Promise<Response> = async () => new Response("{}");
const storage = new Map<string, string>();
const browser = new EventTarget();
let visibility: "visible" | "hidden" = "visible";

type Core = typeof import("../ui/src/atoms.js");
type Access = typeof import("../ui/src/access.js");
type Api = typeof import("../ui/src/api.js");
let core: Core;
let access: Access;
let api: Api;

// the stubbed browser, installed before the ui modules load and put back when the suite's scope closes; the fetch stub is
// the native boundary of the suite
beforeAll(() => Effect.gen(function* () {
  yield* installGlobal("location", { origin: "http://supervisor.test" });
  yield* installGlobal("window", browser);
  yield* installGlobal("document", { get visibilityState() { return visibility; }, get hidden() { return visibility === "hidden"; } });
  yield* installGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); } });
  yield* installGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://supervisor.test");
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    sent.push({ method: input instanceof Request ? input.method : init?.method ?? "GET", path: url.pathname,
      session: headers.get("x-supervisor-session"), csrf: headers.get("x-csrf-token") });
    return reply(url.pathname, init?.signal ?? (input instanceof Request ? input.signal : undefined));
  });
  access = yield* Effect.promise(() => import("../ui/src/access.js"));
  api = yield* Effect.promise(() => import("../ui/src/api.js"));
  core = yield* Effect.promise(() => import("../ui/src/atoms.js"));
}));

const policy = { generation: 1, excludedThreadIds: [] as string[] };
const savePolicy = () => core.admittedMutation((input: typeof policy) =>
  Effect.flatMap(api.ApiClient, (client) => client.guidance.threadPolicy({ payload: input })));

it.effect("an admitted mutation sends one request for repeated writes, survives unmount and keeps its outcome for its scope", () => Effect.gen(function* () {
  const registry = yield* scopedRegistry();
  storage.set("supervisor-session", "session-1");
  sent.length = 0;
  let release: (response: Response) => void = () => undefined;
  reply = () => new Promise<Response>((resolve) => { release = resolve; });
  const mutation = savePolicy()({ scope: core.scopeKey("settings", "env-1"), operationId: "op-1" });
  const unmount = registry.mount(mutation);
  registry.set(mutation, policy);
  registry.set(mutation, { ...policy, generation: 2 });
  unmount();
  yield* until(registry, mutation, AsyncResult.isWaiting, "waiting");
  release(new Response(JSON.stringify({ generation: 2, excludedThreadIds: [] })));
  const done = yield* until(registry, mutation, AsyncResult.isSuccess, "saved");
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
}), { timeout: 10_000 });

it.live("disposing the registry aborts a pending admitted request and runs its finalizers after unmount kept it; the operation stays unconfirmed and is not replayed", () => Effect.gen(function* () {
  const registry = yield* scopedRegistry();
  storage.set("supervisor-session", "session-1");
  sent.length = 0;
  let signal: AbortSignal | undefined;
  const requested = yield* Deferred.make<void>();
  const abort = yield* Deferred.make<void>();
  reply = (_path, received) => new Promise<Response>((_resolve, reject) => {
    signal = received;
    received?.addEventListener("abort", () => { reject(new DOMException("aborted", "AbortError")); Deferred.doneUnsafe(abort, Effect.void); }, { once: true });
    Deferred.doneUnsafe(requested, Effect.void);
  });
  const finalizers: string[] = [];
  const finalized = yield* Deferred.make<void>();
  const finalizer = (name: string) => Effect.suspend(() => { finalizers.push(name); return finalizers.length === 2 ? Deferred.succeed(finalized, undefined) : Effect.void; });
  const save = core.admittedMutation((input: typeof policy) => Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.void, () => finalizer("scoped resource"));
    const client = yield* api.ApiClient;
    return yield* client.guidance.threadPolicy({ payload: input });
  })).pipe(Effect.ensuring(finalizer("request"))));
  const mutation = save({ scope: core.scopeKey("dispose", "env-1"), operationId: "op-1" });
  const unmount = registry.mount(mutation);
  registry.set(mutation, policy);
  yield* Deferred.await(requested);
  // the panel unmounting keeps the request running
  unmount();
  yield* Effect.sleep("20 millis");
  assert.equal(signal?.aborted, false);
  assert.deepEqual(finalizers, []);
  registry.dispose();
  // bounded only so that a request left running fails here by name; disposal aborts it at once
  const settled = (event: Deferred.Deferred<void>, name: string) => Deferred.await(event).pipe(Effect.as(name), orAfter("2 seconds", "still pending"));
  assert.equal(yield* settled(abort, "aborted"), "aborted");
  assert.equal(yield* settled(finalized, "finalized"), "finalized");
  assert.equal(signal?.aborted, true);
  assert.deepEqual(finalizers, ["scoped resource", "request"]);
  // the claim belongs to the disposed registry: in a new registry the operation starts initial and sends nothing until written
  const next = yield* scopedRegistry();
  assert.ok(AsyncResult.isInitial(next.get(mutation)));
  assert.equal(sent.length, 1);
  next.dispose();
}), { timeout: 10_000 });

it.effect("mutation failures follow the baseline outcome rules without replaying the request", () => Effect.gen(function* () {
  const cases: Array<[string, number, string, number, string]> = [
    // target change (story03): a 401 for a sent session may answer a browser resend after the first attempt applied
    ["401 for a session, refreshed", 401, JSON.stringify({ csrf: "fresh" }), 200, "Unconfirmed"],
    // a change sent without a CSRF token is refused on every attempt
    ["403 without a token, refresh failed", 403, "{}", 401, "NotPerformed:refresh_failed"],
    ["413", 413, "{}", 200, "NotPerformed:too_large"],
    ["415", 415, "{}", 200, "NotPerformed:format"],
    ["500", 500, "{}", 200, "Unconfirmed"],
    ["400 UiError", 400, JSON.stringify({ _tag: "UiError", message: "Reload first." }), 200, "Unconfirmed"],
    ["undecodable success", 200, JSON.stringify({ generation: "x" }), 200, "Unconfirmed"],
  ];
  for (const [label, status, csrfBody, csrfStatus, expected] of cases) {
    const registry = yield* scopedRegistry();
    storage.set("supervisor-session", "session-1");
    sent.length = 0;
    reply = async (path) => path === "/api/csrf"
      ? new Response(csrfBody, { status: csrfStatus })
      : new Response(status === 200 ? JSON.stringify({ generation: "x" }) : status === 400 ? csrfBody : "{}", { status });
    const mutation = savePolicy()({ scope: core.scopeKey("failures", label), operationId: "op" });
    registry.set(mutation, policy);
    const failed = yield* until(registry, mutation, AsyncResult.isFailure, label);
    const squashed = AsyncResult.error(failed);
    const tag = squashed._tag === "Some" ? (squashed.value._tag === "NotPerformed" ? `NotPerformed:${squashed.value.reason}` : squashed.value._tag) : "none";
    assert.equal(tag, expected, label);
    const posts = sent.filter((request) => request.path === "/api/guidance/thread-policy");
    assert.equal(posts.length, 1, `${label}: never replayed`);
    registry.dispose();
  }
}), { timeout: 10_000 });

it.effect("the poll signal ticks only while the page is visible and a refreshed read keeps its last success after a failure", () => Effect.gen(function* () {
  const registry = yield* clockedRegistry(core.uiRuntime);
  let reads = 0;
  let fail = false;
  const read = core.uiRuntime.atom(Effect.suspend(() => { reads++; return fail ? Effect.fail("unavailable" as const) : Effect.succeed(reads); }))
    .pipe(core.pollWhileVisible(20));
  const stop = registry.subscribe(read, () => undefined, { immediate: true });
  // one interval passes on the page runtime's clock
  yield* TestClock.adjust("20 millis");
  yield* until(registry, read, (value) => AsyncResult.isSuccess(value) && reads >= 2, "a visible tick refreshes");
  visibility = "hidden";
  const hiddenFrom = reads;
  // six intervals pass while hidden and nothing reads
  yield* TestClock.adjust("120 millis");
  assert.equal(reads, hiddenFrom, "no polling while hidden");
  fail = true;
  visibility = "visible";
  yield* TestClock.adjust("20 millis");
  const failed = yield* until(registry, read, AsyncResult.isFailure, "the next visible tick fails");
  assert.ok(AsyncResult.isFailure(failed) && failed.previousSuccess._tag === "Some", "the last successful read is kept");
  stop();
  registry.dispose();
}), { timeout: 10_000 });

it.effect("drafts are keep-alive per scope and survive unmount; the auth epoch advances on sign-in and on another tab's change", () => Effect.gen(function* () {
  const registry = yield* scopedRegistry();
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
  yield* until(registry, core.authEpochAtom, (value) => AsyncResult.isSuccess(value) && value.value >= 1, "sign-in advances the epoch");
  // another tab stores a different session; the epoch counts changes of the stored value
  storage.set("supervisor-session", "session-3");
  const event = new Event("storage");
  Object.defineProperties(event, { key: { value: "supervisor-session" }, storageArea: { value: globalThis.localStorage } });
  browser.dispatchEvent(event);
  yield* until(registry, core.authEpochAtom, (value) => AsyncResult.isSuccess(value) && value.value >= 2, "another tab advances the epoch");
  stopEpoch();
  registry.dispose();
}), { timeout: 10_000 });
