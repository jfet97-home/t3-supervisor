import { Clock, type Duration, Effect } from "effect";
import type { Atom, AtomRegistry } from "effect/reactivity";

// a stubbed browser for ui atom tests: the globals are installed for the scope that installs them (before the ui modules
// load), every request is recorded and answered by the current reply, and the waits for a request, a history write or an
// atom value are effects bounded on the live clock

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

// the answer of the browser fetch to one request: the native boundary of these suites, so it is a Response or its promise
export type Reply = (request: SentRequest) => Response | Promise<Response>;

// an answer that never arrives; like fetch, it rejects when the request is aborted
export const held = (request: SentRequest) => new Promise<Response>((_resolve, reject) => {
  request.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
});

export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

// a sleep on the live clock, also inside an it.effect test whose own clock is the test clock
export const liveSleep = (duration: Duration.Input) => Effect.sleep(duration).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()));

// a real-time bound on an awaited event: the event keeps the current clock, only the bound's timer runs on the live clock,
// and an expired bound dies naming the event
export const within = (message: string, deadline: Duration.Input = "5 seconds") => <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.raceFirst(self, liveSleep(deadline).pipe(Effect.andThen(Effect.die(new Error(message)))));

// the event's value, or `missing` once the real-time bound has passed, so an event that never comes fails the assertion
// that names it
export const orAfter = <B>(deadline: Duration.Input, missing: B) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.raceFirst(self, Effect.as(liveSleep(deadline), missing));

// resumes a waiting test on a microtask, as the baseline promise of the wait continued its awaiter: a resumed fiber runs
// at once, so resuming inside the notifying stub or registry would run the test before the notifier's own next step
const later = <A>(resume: (effect: Effect.Effect<A>) => void, value: A) => queueMicrotask(() => resume(Effect.succeed(value)));

// completes once the request's signal has aborted
export const abortOf = (signal: AbortSignal) => Effect.callback<void>((resume) => {
  if (signal.aborted) return later(resume, undefined);
  const listener = () => later(resume, undefined);
  signal.addEventListener("abort", listener, { once: true });
  return Effect.sync(() => signal.removeEventListener("abort", listener));
});

// one turn of the event loop: the current job and its microtasks end before it completes
export const nextTurn = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});

// the first value of the atom, current or later, that satisfies the predicate, read while subscribed to it; the predicate
// sees each value when the registry notifies it. fails after five seconds
export const until = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, predicate: (value: A) => boolean, label: string) =>
  Effect.callback<A>((resume) => {
    let done = false;
    const stop = registry.subscribe(atom, (value) => {
      if (done || !predicate(value)) return;
      done = true;
      queueMicrotask(() => stop());
      later(resume, value);
    }, { immediate: true });
    return Effect.sync(() => { if (!done) stop(); });
  }).pipe(within(`${label} not reached`));

export const makeBrowser = (origin = "http://127.0.0.1:4100") => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const installOne = (key: string, value: unknown) => {
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
  const restore = () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    originals.clear();
  };
  return {
    sent, local, session, state, location, history, entries, listeners,
    // installs the browser globals for the scope that runs it and puts back what they replaced when the scope closes
    install: Effect.acquireRelease(Effect.sync(() => {
      Object.assign(window, { location, history });
      installOne("location", location);
      installOne("window", window);
      installOne("history", history);
      installOne("document", { get visibilityState() { return state.visibility; }, get hidden() { return state.visibility === "hidden"; },
        getElementById: () => state.root, querySelectorAll: () => [] });
      installOne("localStorage", localStorage);
      installOne("sessionStorage", sessionStorage);
      installOne("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), origin), init);
        const url = new URL(request.url);
        const record: SentRequest = { method: request.method, path: url.pathname, search: url.searchParams, body: await request.text(),
          session: request.headers.get("x-supervisor-session"), csrf: request.headers.get("x-csrf-token"), contentType: request.headers.get("content-type"),
          signal: request.signal };
        sent.push(record);
        for (const waiter of [...waiters]) waiter(record);
        return state.reply(record);
      });
    }), () => Effect.sync(restore)),
    // another tab changed the stored session
    storageEvent(key: string | null) {
      const event = new Event("storage");
      Object.defineProperties(event, { key: { value: key }, storageArea: { value: localStorage } });
      window.dispatchEvent(event);
    },
    // the first request, sent already or later, that matches the predicate; fails after five seconds
    request: (predicate: (request: SentRequest) => boolean, label: string) => Effect.callback<SentRequest>((resume) => {
      const found = sent.find(predicate);
      if (found) return later(resume, found);
      const waiter = (request: SentRequest) => {
        if (!predicate(request)) return;
        waiters.delete(waiter);
        later(resume, request);
      };
      waiters.add(waiter);
      return Effect.sync(() => { waiters.delete(waiter); });
    }).pipe(within(`${label} not sent`)),
    // completes once the page has written history entries that satisfy the predicate; fails after five seconds
    historyWhere: (predicate: () => boolean, label: string) => Effect.callback<void>((resume) => {
      if (predicate()) return later(resume, undefined);
      const waiter = () => {
        if (!predicate()) return;
        historyWaiters.delete(waiter);
        later(resume, undefined);
      };
      historyWaiters.add(waiter);
      return Effect.sync(() => { historyWaiters.delete(waiter); });
    }).pipe(within(`${label} not written`)),
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
