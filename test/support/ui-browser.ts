import type { Atom, AtomRegistry } from "effect/reactivity";

// a stubbed browser for ui atom tests (the pattern of test/ui-core-atoms.test.ts): the globals are installed before the ui
// modules load, every request is recorded and answered by the current reply, and restore() puts the globals back

export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly body: string;
  readonly session: string | null;
  readonly csrf: string | null;
  readonly contentType: string | null;
  readonly signal: AbortSignal;
}

export type Reply = (request: SentRequest) => Response | Promise<Response>;

// an answer that never arrives; like fetch, it rejects when the request is aborted
export const held = (request: SentRequest) => new Promise<Response>((_resolve, reject) => {
  request.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
});

export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export const makeBrowser = (origin = "http://127.0.0.1:4100") => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const sent: SentRequest[] = [];
  const waiters = new Set<(request: SentRequest) => void>();
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const window = new EventTarget();
  const listeners = new Map<string, number>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  window.addEventListener = (type: string, ...rest: [EventListenerOrEventListenerObject | null, (boolean | AddEventListenerOptions)?]) => {
    listeners.set(type, (listeners.get(type) ?? 0) + 1);
    add(type, ...rest);
  };
  window.removeEventListener = (type: string, ...rest: [EventListenerOrEventListenerObject | null, (boolean | EventListenerOptions)?]) => {
    listeners.set(type, (listeners.get(type) ?? 0) - 1);
    remove(type, ...rest);
  };
  const state = {
    reply: (() => json({ message: "Not found." }, 404)) as Reply,
    visibility: "visible" as "visible" | "hidden",
    sessionBlocked: false,
    localBlocked: false,
    // what document.getElementById answers, for modules that mount a root
    root: null as unknown,
  };
  const location = { origin, pathname: "/", hash: "" };
  const entries: Array<{ hash: string; state: unknown }> = [{ hash: "", state: null }];
  let cursor = 0;
  const historyWaiters = new Set<() => void>();
  const historyWritten = () => { for (const waiter of [...historyWaiters]) waiter(); };
  const history = {
    get state() { return entries[cursor]!.state; },
    get length() { return entries.length; },
    pushState: (value: unknown, _title: string, href: string) => { entries.splice(++cursor); entries.push({ hash: href, state: value }); location.hash = href; historyWritten(); },
    replaceState: (value: unknown, _title: string, href: string) => { entries[cursor] = { hash: href, state: value }; location.hash = href; historyWritten(); },
    go: (delta: number) => {
      const target = cursor + delta;
      if (target < 0 || target >= entries.length) return;
      cursor = target;
      location.hash = entries[cursor]!.hash;
      queueMicrotask(() => window.dispatchEvent(new Event("popstate")));
    },
  };
  const storage = (values: Map<string, string>, blocked: () => boolean) => ({
    getItem: (key: string) => { if (blocked()) throw new Error("blocked"); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (blocked()) throw new Error("blocked"); values.set(key, value); },
    removeItem: (key: string) => { if (blocked()) throw new Error("blocked"); values.delete(key); },
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    clear: () => values.clear(),
  });
  const localStorage = storage(local, () => state.localBlocked);
  const sessionStorage = storage(session, () => state.sessionBlocked);
  return {
    sent, local, session, state, location, history, entries, listeners,
    install() {
      Object.assign(window, { location, history });
      install("location", location);
      install("window", window);
      install("history", history);
      install("document", { get visibilityState() { return state.visibility; }, get hidden() { return state.visibility === "hidden"; },
        getElementById: () => state.root, querySelectorAll: () => [] });
      install("localStorage", localStorage);
      install("sessionStorage", sessionStorage);
      install("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), origin), init);
        const url = new URL(request.url);
        const record: SentRequest = { method: request.method, path: url.pathname, search: url.searchParams, body: await request.text(),
          session: request.headers.get("x-supervisor-session"), csrf: request.headers.get("x-csrf-token"), contentType: request.headers.get("content-type"),
          signal: request.signal };
        sent.push(record);
        for (const waiter of [...waiters]) waiter(record);
        return state.reply(record);
      });
    },
    restore() {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
    // another tab changed the stored session
    storageEvent(key: string | null) {
      const event = new Event("storage");
      Object.defineProperties(event, { key: { value: key }, storageArea: { value: localStorage } });
      window.dispatchEvent(event);
    },
    // resolves with the first request, sent already or later, that matches the predicate; fails after five seconds
    request(predicate: (request: SentRequest) => boolean, label: string) {
      return new Promise<SentRequest>((resolve, reject) => {
        const found = sent.find(predicate);
        if (found) return resolve(found);
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`${label} not sent`)); }, 5_000);
        const waiter = (request: SentRequest) => {
          if (!predicate(request)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(request);
        };
        waiters.add(waiter);
      });
    },
    // resolves once the page has written history entries that satisfy the predicate; fails after five seconds
    historyWhere(predicate: () => boolean, label: string) {
      return new Promise<void>((resolve, reject) => {
        if (predicate()) return resolve();
        const timer = setTimeout(() => { historyWaiters.delete(waiter); reject(new Error(`${label} not written`)); }, 5_000);
        const waiter = () => {
          if (!predicate()) return;
          clearTimeout(timer);
          historyWaiters.delete(waiter);
          resolve();
        };
        historyWaiters.add(waiter);
      });
    },
    get cursor() { return cursor; },
    // a hash typed into the address bar
    typeHash(hash: string) {
      entries.splice(cursor + 1);
      entries.push({ hash, state: null });
      cursor++;
      location.hash = hash;
      window.dispatchEvent(new Event("hashchange"));
    },
  };
};

// resolves with the first value of the atom that satisfies the predicate, or fails after five seconds
export const until = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, predicate: (value: A) => boolean, label: string) =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error(`${label} not reached`)); }, 5_000);
    const stop = registry.subscribe(atom, (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      queueMicrotask(() => stop());
      resolve(value);
    }, { immediate: true });
  });
