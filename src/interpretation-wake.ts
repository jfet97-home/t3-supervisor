import { Cause, Context, Effect, FiberMap, HashMap, Layer, Option, Queue, Ref, Scope, SynchronizedRef } from "effect";
import { logEvent } from "./logging.js";
import { supervisorScopeKey } from "./supervisor-scope.js";

// the coalesced per-scope wake of a recorded interpretation submission (plan 3.12 item 6): the intake signals its scope once the
// receipt committed and returns at once; the supervision service serves the wakes in its own scope, one handler run at a time per
// scope, with every signal that arrives while one runs coalesced into the next run (Queue.sliding(1)). The persisted task is the
// record of the work: a lost wake changes nothing that restart and the normal cycle do not recover

export type InterpretationWakeScope = {readonly projectId: string; readonly mainThreadId: string};

export interface InterpretationWakeShape {
  // signals the scope's wake; it never blocks, never fails and never runs the handler on the caller's fiber
  readonly signal: (scope: InterpretationWakeScope) => Effect.Effect<void>;
  // serves the wakes with the handler until the caller's scope closes, which interrupts every running handler; a handler failure
  // ends that run and is reported by its event alone
  readonly serve: <E>(handler: (scope: InterpretationWakeScope) => Effect.Effect<void, E>) => Effect.Effect<void, never, Scope.Scope>;
}

type Served = {readonly workers: FiberMap.FiberMap<string>; readonly handler: (scope: InterpretationWakeScope) => Effect.Effect<void, unknown>};

const make = Effect.gen(function* () {
  const queues = yield* SynchronizedRef.make(HashMap.empty<string, Queue.Queue<InterpretationWakeScope>>());
  const served = yield* Ref.make<Served | null>(null);
  // a handler failure ends that run only: its event carries no cause, and the scope's next signal runs the handler again
  const worker = (queue: Queue.Queue<InterpretationWakeScope>, handler: Served["handler"]) => Effect.forever(Effect.flatMap(Queue.take(queue), (scope) =>
    handler(scope).pipe(Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt : logEvent("interpretation_wake_failed")))));
  // the scope's worker in the serving scope, once
  const start = (key: string, queue: Queue.Queue<InterpretationWakeScope>) => Effect.flatMap(Ref.get(served), (current) => current
    ? Effect.asVoid(FiberMap.run(current.workers, key, worker(queue, current.handler), {onlyIfMissing: true}))
    : Effect.void);
  const queueOf = (key: string) => SynchronizedRef.modifyEffect(queues, (map) => Option.match(HashMap.get(map, key), {
    onSome: (queue) => Effect.succeed([queue, map] as const),
    onNone: () => Effect.map(Queue.sliding<InterpretationWakeScope>(1), (queue) => [queue, HashMap.set(map, key, queue)] as const),
  }));
  return InterpretationWake.of({
    signal: (scope) => Effect.gen(function* () {
      const key = supervisorScopeKey(scope.projectId, scope.mainThreadId);
      const queue = yield* queueOf(key);
      yield* Queue.offer(queue, scope);
      yield* start(key, queue);
    }),
    serve: (handler) => Effect.gen(function* () {
      const workers = yield* FiberMap.make<string>();
      yield* Ref.set(served, {workers, handler});
      yield* Effect.addFinalizer(() => Ref.set(served, null));
      for (const [key, queue] of yield* SynchronizedRef.get(queues)) yield* start(key, queue);
    }),
  });
});

// the wake of one supervision run, built before its controllers (the intake signals it) and its project supervisor (which serves it)
export class InterpretationWake extends Context.Service<InterpretationWake, InterpretationWakeShape>()("t3-supervisor/InterpretationWake") {
  static readonly make = make;
  static readonly layer: Layer.Layer<InterpretationWake> = Layer.effect(InterpretationWake, make);
}
