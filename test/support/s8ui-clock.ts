import { Clock, type Duration, Effect, type Scope } from "effect";
import type { Atom, AtomRegistry } from "effect/reactivity";
import { TestClock } from "effect/testing";
import { clockedRegistry } from "./g7-page.js";
import { nextTurn } from "./g7-browser.js";

// the timers of the page runtime on the test clock (S8 ui clock): a registry whose page runtime sleeps on the test's clock
// through a clock that counts its pending sleeps, so a test sees which timers the runtime holds, and a step of that clock
// after which the woken atom fibers have run. nothing here imports a ui module

// a registry whose page runtime runs on the current clock (the test clock of an it.effect test), and the number of sleeps
// the runtime has pending on it; a sleep stops counting when it ends or is interrupted
export const countedRegistry = <R, E>(runtime: Atom.AtomRuntime<R, E>): Effect.Effect<{
  readonly registry: AtomRegistry.AtomRegistry;
  readonly sleeps: () => number;
}, never, Scope.Scope> => Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  let pending = 0;
  const counted: Clock.Clock = {...clock, sleep: (duration) => Effect.suspend(() => {
    pending++;
    return Effect.ensuring(clock.sleep(duration), Effect.sync(() => { pending--; }));
  })};
  const registry = yield* clockedRegistry(runtime).pipe(Effect.provideService(Clock.Clock, counted));
  return {registry, sleeps: () => pending};
});

// advances the test clock; the atom fibers it wakes resume on the registry's microtask scheduler, so they have run, with
// what they write synchronously, once the next turn of the event loop begins
export const elapse = (duration: Duration.Input) => Effect.andThen(TestClock.adjust(duration), nextTurn);
