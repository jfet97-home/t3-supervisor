import assert from "node:assert/strict";
import { it } from "vitest";
import { clearAccess, getCsrfToken, getSessionToken, loadAccess, setSessionToken, watchSession } from "../ui/src/access.js";

const storage = () => {
  const values = new Map<string, string>();
  return {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }};
};

it("browser access keeps a shared session, synchronizes sign-out and ignores stale access responses", async () => {
  const originals = new Map(["localStorage", "sessionStorage", "window", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const local = storage();
  const tab = storage();
  const window = new EventTarget();
  const install = (key: string, value: unknown) => Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  install("localStorage", local); install("sessionStorage", tab); install("window", window);
  let stopWatching = () => {};
  try {
    tab.setItem("supervisor-session", "older-tab-session");
    assert.equal(getSessionToken(), "", "old tab storage cannot sign the browser back in");
    setSessionToken("new-browser-session");
    assert.equal(getSessionToken(), "new-browser-session");
    install("sessionStorage", storage());
    assert.equal(getSessionToken(), "new-browser-session", "new tabs do not need the original tab's storage");

    let changes = 0;
    stopWatching = watchSession(() => { changes++; });
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
    const staleCheck = loadAccess();
    setSessionToken("newer-session");
    respond(new Response("{}", {status: 401}));
    assert.equal(await staleCheck, false);
    assert.equal(expired, 0);
    assert.equal(getSessionToken(), "newer-session");
    clearAccess("new-browser-session");
    assert.equal(getSessionToken(), "newer-session", "an older logout cannot erase a newer login");

    let finishBody = () => {};
    const body = new ReadableStream<Uint8Array>({start(controller) {
      finishBody = () => { controller.enqueue(new TextEncoder().encode('{"csrf":"obsolete-csrf"}')); controller.close(); };
    }});
    install("fetch", async () => new Response(body));
    const staleBody = loadAccess();
    await new Promise(resolve => setImmediate(resolve));
    setSessionToken("replacement-session");
    install("fetch", async () => new Response('{"csrf":"replacement-csrf"}'));
    assert.equal(await loadAccess(), true);
    finishBody();
    assert.equal(await staleBody, false);
    assert.equal(getCsrfToken(), "replacement-csrf", "a delayed body cannot overwrite newer access state");
    clearAccess("newer-session");
    assert.equal(getCsrfToken(), "replacement-csrf", "a delayed logout cannot clear newer access state");

    install("fetch", async () => new Response('{"csrf":"fresh-csrf"}'));
    assert.equal(await loadAccess(), true);
    assert.equal(getCsrfToken(), "fresh-csrf");
    install("fetch", async () => new Response("{}", {status: 401}));
    assert.equal(await loadAccess(), false);
    assert.equal(expired, 1);
    assert.equal(getSessionToken(), "");
    assert.equal(getCsrfToken(), "");

    install("localStorage", {getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }});
    assert.equal(getSessionToken(), "");
    assert.throws(() => setSessionToken("cannot-save"), /Allow site storage/u);
  } finally {
    stopWatching();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
