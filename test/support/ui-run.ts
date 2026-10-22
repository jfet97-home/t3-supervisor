import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import type { SessionAccess } from "../../ui/src/access.js";
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

// runs a dashboard effect on the page runtime's own layers; aborting the signal interrupts it
export const runUi = <A, E>(effect: Effect.Effect<A, E, ApiClient | SessionAccess>, signal?: AbortSignal): Promise<A> => {
  const registry = AtomRegistry.make();
  return Effect.runPromise(effect.pipe(Effect.provide(registry.get(uiRuntime.layer)), Effect.provideService(FetchHttpClient.Fetch, baselineFetch)),
    signal ? {signal} : undefined).finally(() => registry.dispose());
};
