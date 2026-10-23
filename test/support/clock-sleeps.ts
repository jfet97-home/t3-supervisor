import { Clock, Deferred, Duration, Effect, Fiber } from "effect";

// a forked effect on the test clock whose sleeps the test can wait for. the effect may first do real i/o (its sql runs in a
// database worker), so a fixed number of yields does not bring it to its first sleep; a test moves virtual time only once a
// sleep it means to wake is registered, or once the effect ended without one. sleeps longer than `within` (a tool deadline
// say) are not waited for and are never woken by advancing `within`

export interface ObservedFiber<A, E> {
  readonly fiber: Fiber.Fiber<A, E>;
  /** Completes once the effect registered its first sleep of at most `within`, or ended. */
  readonly asleep: Effect.Effect<void>;
}

/** Forks `work` with the current (test) clock, observing the sleeps it registers. */
export const forkObserved = <A, E, R>(work: Effect.Effect<A, E, R>, within: Duration.Input): Effect.Effect<ObservedFiber<A, E>, never, R> =>
  Effect.gen(function* () {
    const bound = Duration.toMillis(Duration.fromInputUnsafe(within));
    const sleeping = yield* Deferred.make<void>();
    const clock = yield* Clock.Clock;
    // the signal precedes the clock's own sleep, which registers before the effect suspends, so the waiter resumes after it
    const observed: Clock.Clock = {
      ...clock,
      sleep: (duration) => Effect.andThen(Duration.toMillis(duration) <= bound ? Deferred.succeed(sleeping, undefined) : Effect.void, clock.sleep(duration)),
    };
    const fiber = yield* Effect.forkChild(Effect.provideService(work, Clock.Clock, observed));
    return {fiber, asleep: Effect.raceFirst(Deferred.await(sleeping), Effect.asVoid(Fiber.await(fiber)))};
  });
