import assert from "node:assert/strict";
import { it } from "vitest";
import { clearAccess, getCsrfToken, getSessionToken, loadAccess, sessionHeaders, setSessionToken, watchSession } from "../ui/src/access.js";
import { defer, deferred, within } from "./support/c3b-http.js";

const storage = () => {
  const values = new Map<string, string>();
  return {values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);},
    removeItem: (key: string) => {values.delete(key);}};
};

it("CT-UI-AUTH-01: shared sign-in storage, cross-tab invalidation, stale 401s, blocked storage and matching sign-out follow the baseline rules", {timeout: 10_000}, async t => {
  const originals = new Map(["localStorage", "sessionStorage", "window", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const install = (key: string, value: unknown) => Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  defer(t, () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const local = storage();
  const window = new EventTarget();
  install("localStorage", local);
  install("sessionStorage", storage());
  install("window", window);
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
  setSessionToken("session-a");
  assert.equal(local.values.get("supervisor-session"), "session-a");
  assert.deepEqual(sessionHeaders(), {"x-supervisor-session": "session-a"});
  assert.equal(await loadAccess(), true);
  assert.equal(getCsrfToken(), "csrf-for-session-a");

  // another tab's storage event clears the cached CSRF token at once and re-runs access with the new session
  const rerun = deferred<boolean>();
  const stopWatching = watchSession(() => {void loadAccess().then(rerun.resolve, rerun.reject);});
  defer(t, stopWatching);
  const storageEvent = (key: string | null, area: unknown = local) => {
    const event = new Event("storage");
    Object.defineProperties(event, {key: {value: key}, storageArea: {value: area}});
    window.dispatchEvent(event);
  };
  storageEvent("unrelated-key");
  storageEvent("supervisor-session", storage());
  assert.equal(getCsrfToken(), "csrf-for-session-a", "other keys and other storage areas are ignored");
  local.values.set("supervisor-session", "session-b");
  storageEvent("supervisor-session");
  assert.equal(getCsrfToken(), "", "the CSRF token is invalidated synchronously");
  assert.equal(await within(rerun.promise, 5_000, "access re-run"), true);
  assert.equal(getCsrfToken(), "csrf-for-session-b");
  assert.deepEqual(csrfReads, ["session-a", "session-b"]);

  // a 401 that answers an older session never clears the newer session or announces expiry
  const late = deferred<Response>();
  csrfReply = () => late.promise;
  const stale = loadAccess();
  setSessionToken("session-c");
  late.resolve(new Response(JSON.stringify({message: "Sign in to Supervisor."}), {status: 401}));
  assert.equal(await stale, false);
  assert.equal(getSessionToken(), "session-c");
  assert.equal(getCsrfToken(), "csrf-for-session-b", "the stale answer leaves the cached token alone");
  assert.equal(expired, 0);
  // a 401 for the current session clears it and announces expiry once
  csrfReply = () => Promise.resolve(new Response("{}", {status: 401}));
  assert.equal(await loadAccess(), false);
  assert.equal(getSessionToken(), "");
  assert.equal(getCsrfToken(), "");
  assert.equal(expired, 1);

  // sign-out clears only the session it was issued for
  setSessionToken("session-d");
  csrfReply = session => Promise.resolve(new Response(JSON.stringify({csrf: `csrf-for-${session}`})));
  assert.equal(await loadAccess(), true);
  clearAccess("session-c");
  assert.deepEqual([getSessionToken(), getCsrfToken()], ["session-d", "csrf-for-session-d"]);
  clearAccess("session-d");
  assert.deepEqual([getSessionToken(), getCsrfToken()], ["", ""]);
  setSessionToken("session-e");
  clearAccess();
  assert.equal(getSessionToken(), "", "the default clears the current session");

  // blocked storage reads as signed out, refuses to save with the exact message and still clears the token
  const blocked = () => {throw new DOMException("The operation is insecure.", "SecurityError");};
  install("localStorage", {getItem: blocked, setItem: blocked, removeItem: blocked});
  assert.equal(getSessionToken(), "");
  assert.throws(() => setSessionToken("session-f"), (error: unknown) => error instanceof Error && error.constructor === Error &&
    error.message === "Your browser blocked saved sign-in. Allow site storage for Supervisor and try again.");
  assert.doesNotThrow(() => clearAccess(""));
});
