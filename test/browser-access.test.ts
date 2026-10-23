import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { rejects } from "./support/g7-page.js";
import { keepGlobals, pageAccess } from "./support/g7-runtime.js";
import { nextTurn } from "./support/g7-browser.js";

// the session access of a page runtime over stubbed browser storage and fetch: the test waits only for the access
// checks it starts and one event-loop turn, so it is it.effect

const storage = () => {
  const values = new Map<string, string>();
  return {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }};
};

it.effect("browser access keeps a shared session, synchronizes sign-out and ignores stale access responses", () => Effect.gen(function* () {
  yield* keepGlobals(["localStorage", "sessionStorage", "window", "fetch"]);
  const local = storage();
  const tab = storage();
  const window = new EventTarget();
  const install = (key: string, value: unknown) => Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  install("localStorage", local); install("sessionStorage", tab); install("window", window);
  // the page is built once the browser is installed, so its session access listens to this window
  const access = yield* pageAccess;
  const csrf = Effect.map(access.headers, (headers) => headers["x-csrf-token"]);
  tab.setItem("supervisor-session", "older-tab-session");
  assert.equal(yield* access.session, "", "old tab storage cannot sign the browser back in");
  yield* access.signIn("new-browser-session");
  assert.equal(yield* access.session, "new-browser-session");
  install("sessionStorage", storage());
  assert.equal(yield* access.session, "new-browser-session", "new tabs do not need the original tab's storage");

  // the watcher hears only another tab's storage events; it subscribes before the first event and stops with the test
  let changes = 0;
  yield* Effect.forkChild(Stream.runForEach(Stream.filter(access.changes, (change) => change === "storage"), () => Effect.sync(() => { changes++; })),
    {startImmediately: true});
  const notify = (key: string | null, storageArea: unknown = local) => {
    const event = new Event("storage");
    Object.defineProperties(event, {key: {value: key}, storageArea: {value: storageArea}});
    window.dispatchEvent(event);
  };
  notify("unrelated"); notify("supervisor-session", tab);
  assert.equal(changes, 0);
  notify("supervisor-session"); notify(null);
  assert.equal(changes, 2);

  let expired = 0;
  window.addEventListener("supervisor-auth-required", () => { expired++; });
  let respond: (response: Response) => void = () => {};
  install("fetch", () => new Promise<Response>(resolve => { respond = resolve; }));
  const staleCheck = yield* Effect.forkChild(access.load, {startImmediately: true});
  yield* access.signIn("newer-session");
  respond(new Response("{}", {status: 401}));
  assert.equal(yield* Fiber.join(staleCheck), false);
  assert.equal(expired, 0);
  assert.equal(yield* access.session, "newer-session");
  yield* access.clear("new-browser-session");
  assert.equal(yield* access.session, "newer-session", "an older logout cannot erase a newer login");

  let finishBody = () => {};
  const body = new ReadableStream<Uint8Array>({start(controller) {
    finishBody = () => { controller.enqueue(new TextEncoder().encode('{"csrf":"obsolete-csrf"}')); controller.close(); };
  }});
  install("fetch", async () => new Response(body));
  const staleBody = yield* Effect.forkChild(access.load, {startImmediately: true});
  yield* nextTurn;
  yield* access.signIn("replacement-session");
  install("fetch", async () => new Response('{"csrf":"replacement-csrf"}'));
  assert.equal(yield* access.load, true);
  finishBody();
  assert.equal(yield* Fiber.join(staleBody), false);
  assert.equal(yield* csrf, "replacement-csrf", "a delayed body cannot overwrite newer access state");
  yield* access.clear("newer-session");
  assert.equal(yield* csrf, "replacement-csrf", "a delayed logout cannot clear newer access state");

  install("fetch", async () => new Response('{"csrf":"fresh-csrf"}'));
  assert.equal(yield* access.load, true);
  assert.equal(yield* csrf, "fresh-csrf");
  install("fetch", async () => new Response("{}", {status: 401}));
  assert.equal(yield* access.load, false);
  assert.equal(expired, 1);
  assert.equal(yield* access.session, "");
  assert.equal(yield* csrf, "");

  install("localStorage", {getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }});
  assert.equal(yield* access.session, "");
  yield* rejects(access.signIn("cannot-save"), /Allow site storage/u);
}));
