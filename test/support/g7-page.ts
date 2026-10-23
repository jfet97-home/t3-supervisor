import assert from "node:assert/strict";
import { Cause, Clock, Deferred, Effect, Exit, Layer, type Scope } from "effect";
import { type Atom, AtomRegistry } from "effect/reactivity";

// the page registries of the ui atom suites (G7): browser globals for a scope, a registry for the test's scope, one whose
// page runtime runs on the test's clock, subscriptions released with the scope, and assert.rejects for an effect. nothing
// here imports a ui module, so a suite can install its stubbed browser before the ui modules read it at load

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

// a registry disposed when the test's scope closes; disposing is idempotent, so a test may dispose it earlier as its own step
export const scopedRegistry = (options?: Parameters<typeof AtomRegistry.make>[0]): Effect.Effect<AtomRegistry.AtomRegistry, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(() => AtomRegistry.make(options)), (registry) => Effect.sync(() => registry.dispose()));

// a registry whose page runtime has the current clock (the test clock of an it.effect test) next to its own layers, so
// the poll signals and search delays that run on the runtime advance only with TestClock.adjust; the runtime is passed in
// because the ui modules load after the stubbed browser is installed
export const clockedRegistry = <R, E>(runtime: Atom.AtomRuntime<R, E>): Effect.Effect<AtomRegistry.AtomRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const scratch = AtomRegistry.make();
    const layer = scratch.get(runtime.layer);
    scratch.dispose();
    return yield* scopedRegistry({initialValues: [[runtime.layer, Layer.merge(layer, Layer.succeed(Clock.Clock, clock))]]});
  });

// a subscription released when the test's scope closes; the returned stop is the test's own step and runs once
export const subscribed = (registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<unknown>): Effect.Effect<() => void, never, Scope.Scope> =>
  Effect.map(Effect.acquireRelease(Effect.sync(() => {
    const stop = registry.subscribe(atom, () => undefined, {immediate: true});
    let active = true;
    return () => { if (active) { active = false; stop(); } };
  }), (stop) => Effect.sync(stop)), (stop) => stop);

// assert.rejects for an effect: it must fail, and the squashed failure, the error its baseline promise rejected with, must
// match the pattern (tested against its string form) or satisfy the predicate when one is given
export const rejects = <A, E, R>(effect: Effect.Effect<A, E, R>, expected?: RegExp | ((error: unknown) => boolean), message?: string) =>
  Effect.flatMap(Effect.exit(effect), (exit) => Effect.sync(() => {
    if (Exit.isSuccess(exit)) assert.fail(message ?? "Missing expected rejection.");
    if (expected === undefined) return;
    const error = Cause.squash(exit.cause);
    if (expected instanceof RegExp) assert.match(String(error), expected, message);
    else assert.equal(expected(error), true, message ?? "The validation function is expected to return \"true\".");
  }));

// a stubbed answer the test releases, and the event that its request reached the stub; the event resumes the test on a
// microtask, after the stub has returned the held answer, as the baseline promise of the event did
export const heldResponse = Effect.map(Deferred.make<void>(), (reached) => {
  let release!: (response: Response) => void;
  return {
    response: new Promise<Response>((resolve) => {release = resolve;}),
    reached: Deferred.await(reached),
    arrive: () => queueMicrotask(() => Deferred.doneUnsafe(reached, Exit.void)),
    release: (response: Response) => release(response),
  };
});
