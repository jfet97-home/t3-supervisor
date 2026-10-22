import { Context, Effect, Layer, RcMap, Semaphore } from "effect";

// per-scope serialization (plan 3.5, CC-SCOPE-SERIAL): one Semaphore(1) per key, leased per operation with RcMap.get
// inside the operation's own scope, so a completed, failed or interrupted caller (queued or running) releases its key
// and an unused key is dropped; nothing retains every key for the layer's lifetime (O-04, CT-PS-11)
// order: ScopeLocks key -> admission section (SupervisionGate) -> database critical section; never the reverse
export interface ScopeLocksShape {
  // runs `self` while holding the lock of `key`; callers of one key run one at a time
  readonly withLock: (key: string) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  // the keys currently leased by a running or waiting operation, for diagnostics and tests
  readonly leased: Effect.Effect<ReadonlyArray<string>>;
}

export class ScopeLocks extends Context.Service<ScopeLocks, ScopeLocksShape>()("t3-supervisor/ScopeLocks") {
  static readonly layer: Layer.Layer<ScopeLocks> = Layer.effect(ScopeLocks, Effect.gen(function* () {
    const locks = yield* RcMap.make({ lookup: (_key: string) => Semaphore.make(1) });
    return ScopeLocks.of({
      withLock: (key) => (self) => Effect.scoped(Effect.flatMap(RcMap.get(locks, key), (lock) => Semaphore.withPermits(lock, 1)(self))),
      leased: Effect.map(RcMap.keys(locks), (keys) => [...keys]),
    });
  }));
}
