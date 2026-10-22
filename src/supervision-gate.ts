import { Context, Effect, Exit, Fiber, FiberMap, Layer, Option, Semaphore } from "effect";

// the admission section of plan 3.11 (CC-STOP-LIN): one process-wide Semaphore(1); Stop, Enable, thread-policy saves,
// chat-supervision changes and Start activation, every fresh send's final guard + receipt commit + native initiation,
// and every policy-dependent durable write run inside it; the guard predicates are reachable only through `admit`

// the authoritative policy and guidance reads a section guards with; synchronous B-02 store reads until S6d
export interface GateGuard {
  readonly scopeEnabled: (projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile") => boolean;
  readonly supervisionStopped: (threadId: string) => boolean;
  readonly workflowEditingEnabled: (projectId: string, mainThreadId?: string, purpose?: "effect" | "status" | "read") => boolean;
}

export interface SupervisionGateShape {
  // one admission section: waiting for the permit stays interruptible (nothing is admitted before it), the body is
  // uninterruptible and contains only synchronous store work (short withTransaction blocks after S6d) and at most one
  // native initiation; it is never entered inside a database transaction
  readonly admit: <A, E, R>(body: (guard: GateGuard) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

// one gate over the given predicates; the predicates come from the composition root over the interim stores (B-02)
// until the store port (S6d)
export const makeSupervisionGate = (guard: GateGuard): Effect.Effect<SupervisionGateShape> => Effect.map(Semaphore.make(1), (admission) => ({
  admit: (body) => Semaphore.withPermits(admission, 1)(Effect.uninterruptible(Effect.suspend(() => body(guard)))),
}));

export class SupervisionGate extends Context.Service<SupervisionGate, SupervisionGateShape>()("t3-supervisor/SupervisionGate") {
  static readonly layer = (guard: GateGuard): Layer.Layer<SupervisionGate> => Layer.effect(SupervisionGate, makeSupervisionGate(guard));
}

// a send handed to its native transport: `result` resolves to the path's baseline outcome for every reply and error (it
// never fails) and classifies its own interruption on the durable receipt (uncertain once the request left); `release` is
// the adapter's local cleanup and runs exactly once
export interface AdmittedInFlight<A> {
  readonly result: Effect.Effect<A>;
  readonly release: Effect.Effect<void>;
}

// what a send decides inside the section once no live operation holds its identity
export type SendPreparation<A> =
  // a durable receipt exists (admitted, sent, unknown or completed) or the guard failed: answer without sending
  | { readonly _tag: "Answer"; readonly value: A }
  // the receipt is committed: initiate is the transport's synchronous handoff (Effect.sync in production)
  | { readonly _tag: "Initiate"; readonly initiate: Effect.Effect<AdmittedInFlight<A>> };

export interface AdmittedSend<Id, A, E, R> {
  readonly identity: Id;
  // the transport's service-lifetime in-flight map (closing its scope interrupts each operation and runs its release;
  // once closed, no send is admitted)
  readonly inFlight: FiberMap.FiberMap<Id, A>;
  // inside the section, after the in-flight lookup found nothing: reads the receipt and the guard, then answers or
  // commits the receipt and returns the initiation
  readonly prepare: (guard: GateGuard) => Effect.Effect<SendPreparation<A>, E, R>;
  // the reconciliation-only outcome from the durable receipt, for a duplicate whose original was interrupted
  readonly reconcile: Effect.Effect<A, E, R>;
}

// one send under the admission contract (plan 3.11 items 1-3, CT-LIN-05): a live operation for the identity is joined
// as a duplicate and nothing is initiated; a closed transport admits nothing (no receipt, no initiation) and the send
// ends interrupted, as one interrupted before the permit; otherwise prepare runs in the section, the native initiation
// happens in the section and its operation is registered in the in-flight map before the section ends; the caller that
// initiated is the only cancellation owner (its interruption, in the section or while awaiting the reply, interrupts the
// registered operation and waits for its release); a duplicate's interruption only ends its own wait; the reply is
// awaited outside the section
export const admitSend = <Id, A, E, R>(gate: SupervisionGateShape, send: AdmittedSend<Id, A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let owned: Fiber.Fiber<A> | undefined;
    return Effect.gen(function* () {
      const decision = yield* gate.admit((guard) => Effect.gen(function* () {
        const existing = yield* FiberMap.get(send.inFlight, send.identity);
        if (Option.isSome(existing)) return { _tag: "Join" as const, fiber: existing.value };
        if (send.inFlight.state._tag === "Closed") return yield* Effect.interrupt;
        const prepared = yield* send.prepare(guard);
        if (prepared._tag === "Answer") return prepared;
        const inFlight = yield* prepared.initiate;
        // the operation starts at once, so its classification and release are installed before it is registered; a
        // transport that closed since the check above interrupts it on registration, which still classifies and releases
        // the initiated request, and the caller reconciles
        owned = yield* Effect.forkDetach(inFlight.result.pipe(Effect.ensuring(inFlight.release)), { startImmediately: true });
        yield* FiberMap.set(send.inFlight, send.identity, owned);
        return { _tag: "Join" as const, fiber: owned };
      }));
      if (decision._tag === "Answer") return decision.value;
      const exit = yield* Effect.exit(Fiber.join(decision.fiber));
      if (Exit.isSuccess(exit)) return exit.value;
      // the original was interrupted: its receipt decides (unsent before the request left, uncertain after)
      return yield* send.reconcile;
    }).pipe(Effect.onInterrupt(() => owned ? Fiber.interrupt(owned) : Effect.void));
  });
