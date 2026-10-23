import assert from "node:assert/strict";
import { Cause, Context, type Duration, Effect, Exit, Layer, Option, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { uiRuntime } from "../../ui/src/atoms.js";

// the dashboard page of the ui suites over Effect: globals installed for a scope, a registry with the page runtime as a
// layer, and the waits and rejection checks of those suites as effects

// installs a global for the scope and puts back the descriptor it replaced when the scope closes
export const installGlobal = (key: string, value: unknown) => Effect.acquireRelease(
  Effect.sync(() => {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
    return original;
  }),
  (original) => Effect.sync(() => {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }),
);

// the page location the dashboard client resolves its request paths against, for the layer's life
export const locationLayer = (origin = "http://localhost") => Layer.effectDiscard(installGlobal("location", {origin, pathname: "/"}));

// the browser fetch as the scope found it, put back when the scope closes, so a test may replace globalThis.fetch freely
export const keepFetch = Effect.acquireRelease(Effect.sync(() => globalThis.fetch), (original) => Effect.sync(() => {globalThis.fetch = original;}));

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

// one page: a registry disposed with the layer, the page runtime mounted on it for the registry's life, and that runtime's
// services, the ones the registry's atoms and requests use. client effects provided with the page send their requests
// through baselineFetch; the atoms' own reads run on the runtime and use the browser fetch as it is
export const pageLayer = Layer.effectContext(Effect.gen(function* () {
  const registry = yield* AtomRegistry.AtomRegistry;
  yield* AtomRegistry.mount(registry, uiRuntime);
  const runtime = registry.get(uiRuntime);
  if (!AsyncResult.isSuccess(runtime)) return yield* Effect.die(new Error("the page runtime did not build"));
  return Context.add(runtime.value, FetchHttpClient.Fetch, baselineFetch);
})).pipe(Layer.provideMerge(AtomRegistry.layer));

// the first value of the atom that satisfies the predicate, read while subscribed to it; fails after five seconds
export const until = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, predicate: (value: A) => boolean, label: string) =>
  AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    within(`${label} not reached`),
  );

// an explicit deadline for an awaited event
export const within = (message: string, deadline: Duration.Input = "5 seconds") => <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.timeoutOrElse(self, {duration: deadline, orElse: () => Effect.die(new Error(message))});

// assert.rejects for an effect: it must fail, and the squashed failure, the error its baseline promise rejected with, must
// match the pattern (tested against its string form) or satisfy the predicate
export const rejects = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: RegExp | ((error: unknown) => boolean), message?: string) =>
  Effect.flatMap(Effect.exit(effect), (exit) => Effect.sync(() => {
    if (Exit.isSuccess(exit)) assert.fail(message ?? "Missing expected rejection.");
    const error = Cause.squash(exit.cause);
    if (expected instanceof RegExp) assert.match(String(error), expected, message);
    else assert.equal(expected(error), true, message ?? "The validation function is expected to return \"true\".");
  }));
