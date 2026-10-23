import { Context, Effect, Layer, type Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { SessionAccess } from "../../ui/src/access.js";
import { uiRuntime } from "../../ui/src/atoms.js";

// the dashboard page of the suites that need no browser global while the ui modules load (G7): a registry disposed with
// the layer, the page runtime mounted on it for the registry's life, and that runtime's services. client effects provided
// with the page call the globalThis.fetch installed when they send, as the baseline helpers did. the runtime is built
// with the layer, so its session access listens to the window installed then
export const pageLayer = Layer.effectContext(Effect.gen(function* () {
  const registry = yield* AtomRegistry.AtomRegistry;
  yield* AtomRegistry.mount(registry, uiRuntime);
  const runtime = registry.get(uiRuntime);
  if (!AsyncResult.isSuccess(runtime)) return yield* Effect.die(new Error("the page runtime did not build"));
  return Context.add(runtime.value, FetchHttpClient.Fetch, (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
})).pipe(Layer.provideMerge(AtomRegistry.layer));

// the session access of a page built for the test's scope
export const pageAccess: Effect.Effect<SessionAccess["Service"], never, Scope.Scope> =
  Effect.map(Layer.build(pageLayer), (context) => Context.get(context, SessionAccess));

// keeps the globals as the scope found them: every one of the keys is put back when the scope closes, however often the
// test replaced it
export const keepGlobals = (keys: ReadonlyArray<string>) => Effect.acquireRelease(
  Effect.sync(() => new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))),
  (originals) => Effect.sync(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }),
);
