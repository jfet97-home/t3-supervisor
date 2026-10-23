import { Cause, Context, Effect, Exit, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { afterAll } from "vitest";
import { SessionAccess } from "../../ui/src/access.js";
import type { ApiClient } from "../../ui/src/api.js";
import { uiRuntime } from "../../ui/src/atoms.js";

// the dashboard client resolves its request paths against the page location; returns the restore
export const installPageLocation = (origin = "http://localhost") => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {configurable: true, writable: true, value: {origin, pathname: "/"}});
  return () => {
    if (original) Object.defineProperty(globalThis, "location", original);
    else Reflect.deleteProperty(globalThis, "location");
  };
};

// hands each request of the dashboard's HttpClient to the current globalThis.fetch in the shape the baseline fetch helpers
// used (the path with its query, the JSON body as text, GET as the default method), so the suites' fetch stubs stay as they were
const baselineFetch: typeof globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const {method, body, ...rest} = init ?? {};
  return globalThis.fetch(`${url.pathname}${url.search}`, {
    ...rest,
    ...(method && method !== "GET" ? {method} : {}),
    ...(body === undefined || body === null ? {} : {body: body instanceof Uint8Array ? new TextDecoder().decode(body) : body}),
  });
};

// the built services of a registry's page runtime; the runtime is not kept alive by itself, so the first use mounts it for
// the registry's life and every later use sees the same services and CSRF state
const mounted = new WeakSet<AtomRegistry.AtomRegistry>();
export const pageServices = (registry: AtomRegistry.AtomRegistry): Context.Context<ApiClient | SessionAccess> => {
  if (!mounted.has(registry)) {
    registry.mount(uiRuntime);
    mounted.add(registry);
  }
  const runtime = registry.get(uiRuntime);
  if (!AsyncResult.isSuccess(runtime)) throw new Error("the page runtime did not build");
  return runtime.value;
};

// the SessionAccess of a registry's page runtime, the one its atoms and requests use
export const sessionAccessOf = (registry: AtomRegistry.AtomRegistry) => Context.get(pageServices(registry), SessionAccess);

// the page of this test module: one registry whose SessionAccess every run shares, as the baseline's module-level session
// and CSRF state was shared; it is built at its first use, so it listens to the window installed then, and is disposed
// after the module's tests
let page: AtomRegistry.AtomRegistry | undefined;
const thePage = () => page ??= AtomRegistry.make();
afterAll(() => {
  page?.dispose();
  page = undefined;
});

// the services of this module's page
export const pageContext = () => pageServices(thePage());

// runs a dashboard effect on this module's page; aborting the signal interrupts it
export const runUi = <A, E>(effect: Effect.Effect<A, E, ApiClient | SessionAccess>, signal?: AbortSignal): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(pageContext()), Effect.provideService(FetchHttpClient.Fetch, baselineFetch)),
    signal ? {signal} : undefined);

// the module functions that ui/src/access.ts had, as calls on the page's SessionAccess, for the suites that pin them
const access = () => sessionAccessOf(thePage());
export const getSessionToken = (): string => Effect.runSync(access().session);
export const getCsrfToken = (): string => Effect.runSync(access().headers)["x-csrf-token"];
export const sessionHeaders = () => ({"x-supervisor-session": Effect.runSync(access().headers)["x-supervisor-session"]});
export const loadAccess = (): Promise<boolean> => Effect.runPromise(access().load);
export const clearAccess = (expected?: string): void => Effect.runSync(access().clear(expected));
// the baseline threw a plain Error with the sign-in form's text; the service fails with StorageBlocked, which carries it
export const setSessionToken = (session: string): void => {
  const exit = Effect.runSync(Effect.exit(access().signIn(session)));
  if (Exit.isSuccess(exit)) return;
  const failure = Cause.squash(exit.cause);
  throw new Error(failure instanceof Error ? failure.message : String(failure));
};
// the baseline watcher heard only another tab's storage events; the service also announces this tab's sign-in and
// sign-out and an expired check, which the watcher does not pass on; returns the stop
export const watchSession = (changed: () => void) => {
  const fiber = Effect.runFork(Stream.runForEach(Stream.filter(access().changes, (change) => change === "storage"), () => Effect.sync(changed)));
  return () => fiber.interruptUnsafe();
};
