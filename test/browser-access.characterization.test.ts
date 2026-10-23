import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { rejects } from "./support/g7-page.js";
import { keepGlobals, pageAccess } from "./support/g7-runtime.js";
import { within } from "./support/g7-browser.js";

// the session access of a page runtime over stubbed browser storage and fetch: the test waits only for the access checks
// it starts and the re-run access check (bounded on the live clock), so it is it.effect

const storage = () => {
  const values = new Map<string, string>();
  return {values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);},
    removeItem: (key: string) => {values.delete(key);}};
};

it.effect("CT-UI-AUTH-01: shared sign-in storage, cross-tab invalidation, stale 401s, blocked storage and matching sign-out follow the baseline rules", () => Effect.gen(function* () {
  yield* keepGlobals(["localStorage", "sessionStorage", "window", "fetch"]);
  const install = (key: string, value: unknown) => Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  const local = storage();
  const window = new EventTarget();
  install("localStorage", local);
  install("sessionStorage", storage());
  install("window", window);
  // the page is built once the browser is installed, so its session access listens to this window
  const access = yield* pageAccess;
  const csrf = Effect.map(access.headers, (headers) => headers["x-csrf-token"]);
  let expired = 0;
  window.addEventListener("supervisor-auth-required", () => {expired++;});
  const csrfReads: string[] = [];
  let csrfReply = (session: string): Promise<Response> => Promise.resolve(new Response(JSON.stringify({csrf: `csrf-for-${session}`})));
  install("fetch", (url: string, init?: RequestInit) => {
    assert.equal(url, "/api/csrf");
    assert.equal(init?.credentials, "omit");
    const session = (init?.headers as Record<string, string>)["x-supervisor-session"]!;
    csrfReads.push(session);
    return csrfReply(session);
  });

  // a sign-in result is kept in shared browser storage and sent as the session header
  yield* access.signIn("session-a");
  assert.equal(local.values.get("supervisor-session"), "session-a");
  assert.deepEqual({"x-supervisor-session": (yield* access.headers)["x-supervisor-session"]}, {"x-supervisor-session": "session-a"});
  assert.equal(yield* access.load, true);
  assert.equal(yield* csrf, "csrf-for-session-a");

  // another tab's storage event clears the cached CSRF token at once and re-runs access with the new session; the watcher
  // hears only another tab's storage events, subscribes before the first event and stops with the test
  const rerun = yield* Deferred.make<boolean>();
  yield* Effect.forkChild(Stream.runForEach(Stream.filter(access.changes, (change) => change === "storage"),
    () => Effect.forkChild(Effect.flatMap(access.load, (value) => Deferred.succeed(rerun, value)))), {startImmediately: true});
  const storageEvent = (key: string | null, area: unknown = local) => {
    const event = new Event("storage");
    Object.defineProperties(event, {key: {value: key}, storageArea: {value: area}});
    window.dispatchEvent(event);
  };
  storageEvent("unrelated-key");
  storageEvent("supervisor-session", storage());
  assert.equal(yield* csrf, "csrf-for-session-a", "other keys and other storage areas are ignored");
  local.values.set("supervisor-session", "session-b");
  storageEvent("supervisor-session");
  assert.equal(yield* csrf, "", "the CSRF token is invalidated synchronously");
  assert.equal(yield* Deferred.await(rerun).pipe(within("timed out waiting for access re-run", "5 seconds")), true);
  assert.equal(yield* csrf, "csrf-for-session-b");
  assert.deepEqual(csrfReads, ["session-a", "session-b"]);

  // a 401 that answers an older session never clears the newer session or announces expiry; the stubbed fetch holds its
  // answer until the test releases it
  let answerLate!: (response: Response) => void;
  const late = new Promise<Response>((resolve) => {answerLate = resolve;});
  csrfReply = () => late;
  const stale = yield* Effect.forkChild(access.load, {startImmediately: true});
  yield* access.signIn("session-c");
  answerLate(new Response(JSON.stringify({message: "Sign in to Supervisor."}), {status: 401}));
  assert.equal(yield* Fiber.join(stale), false);
  assert.equal(yield* access.session, "session-c");
  assert.equal(yield* csrf, "csrf-for-session-b", "the stale answer leaves the cached token alone");
  assert.equal(expired, 0);
  // a 401 for the current session clears it and announces expiry once
  csrfReply = () => Promise.resolve(new Response("{}", {status: 401}));
  assert.equal(yield* access.load, false);
  assert.equal(yield* access.session, "");
  assert.equal(yield* csrf, "");
  assert.equal(expired, 1);

  // sign-out clears only the session it was issued for
  yield* access.signIn("session-d");
  csrfReply = session => Promise.resolve(new Response(JSON.stringify({csrf: `csrf-for-${session}`})));
  assert.equal(yield* access.load, true);
  yield* access.clear("session-c");
  assert.deepEqual([yield* access.session, yield* csrf], ["session-d", "csrf-for-session-d"]);
  yield* access.clear("session-d");
  assert.deepEqual([yield* access.session, yield* csrf], ["", ""]);
  yield* access.signIn("session-e");
  yield* access.clear();
  assert.equal(yield* access.session, "", "the default clears the current session");

  // blocked storage reads as signed out, refuses to save with the exact message and still clears the token; the baseline
  // threw a plain Error with the sign-in form's text, and the service fails with StorageBlocked, which carries that text
  const blocked = () => {throw new DOMException("The operation is insecure.", "SecurityError");};
  install("localStorage", {getItem: blocked, setItem: blocked, removeItem: blocked});
  assert.equal(yield* access.session, "");
  yield* rejects(access.signIn("session-f").pipe(Effect.mapError((failure) => new Error(failure.message))), (error: unknown) => error instanceof Error && error.constructor === Error &&
    error.message === "Your browser blocked saved sign-in. Allow site storage for Supervisor and try again.");
  assert.ok(Exit.isSuccess(yield* Effect.exit(access.clear(""))));
}), {timeout: 10_000});
