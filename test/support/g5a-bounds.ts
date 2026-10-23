import { Clock, Deferred, Duration, Effect, type Scope } from "effect";

// a real-time bound on an awaited effect: the effect keeps the current clock (the test clock of an it.effect suite), only the
// bound's timer runs on the live clock, and an expired bound dies naming the awaited event
export const within = <A, E, R>(effect: Effect.Effect<A, E, R>, milliseconds: number, label: string): Effect.Effect<A, E, R> =>
  Effect.raceFirst(effect, Effect.sleep(Duration.millis(milliseconds)).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
    Effect.andThen(Effect.die(new Error(`timed out waiting for ${label}`)))));

// a native call's cancel trigger that completes once the bound has passed on the current clock; its timer ends with the
// caller's scope
export const cancelAfter = (bound: Duration.Input): Effect.Effect<Deferred.Deferred<void>, never, Scope.Scope> => Effect.gen(function* () {
  const cancel = yield* Deferred.make<void>();
  yield* Effect.forkScoped(Effect.andThen(Effect.sleep(bound), Deferred.succeed(cancel, undefined)));
  return cancel;
});
