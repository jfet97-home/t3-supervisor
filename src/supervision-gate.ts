import { resolve } from "node:path";
import { Context, Data, Effect, Exit, Fiber, FiberMap, Layer, Option, Semaphore } from "effect";
import { SupervisorConfig as Configuration } from "./config.js";
import { GuidanceDb } from "./db.js";
import type { GuidanceStoreError, SupervisionStoreError } from "./guidance-sql.js";
import { GuidanceStore } from "./guidance-store.js";
import { isSupervisorThread, ProjectSupervisorStore, type ProjectSupervisorStoreError, type SupervisionStartRecord } from "./project-supervisor-store.js";
import { mainConversation } from "./supervisor-scope.js";
import {conversationOriginAllowed, projectRequesterPolicy} from "./task-requester.js";
import { ThreadPolicyStore, type ThreadPolicyStoreError } from "./thread-policy.js";
import type { SupervisorSettings, ThreadInfo } from "./types.js";

// the admission section of plan 3.11 (CC-STOP-LIN): one process-wide Semaphore(1); Stop, Enable, thread-policy saves,
// chat-supervision changes and Start activation, every fresh send's final guard + receipt commit + native initiation,
// and every policy-dependent durable write run inside it; the guard predicates are reachable only through `admit`

// the authoritative policy and guidance reads a section guards with: each reads the stores when it runs, inside the
// section's transaction when the section opened one
export interface GateGuard {
  readonly scopeEnabled: (projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile") => Effect.Effect<boolean, SupervisionStoreError>;
  readonly supervisionStopped: (threadId: string) => Effect.Effect<boolean, ThreadPolicyStoreError>;
  readonly workflowEditingEnabled: (projectId: string, mainThreadId?: string, purpose?: "effect" | "status" | "read") => Effect.Effect<boolean, SupervisionStoreError>;
}

const unavailable = (thread: ThreadInfo) => Boolean(thread.archivedAt || thread.deletedAt);

// the stores the scope predicates read
export interface SupervisionScopeStores {
  readonly guidance: GuidanceStore["Service"];
  readonly supervisors: ProjectSupervisorStore["Service"];
  readonly policy: ThreadPolicyStore["Service"];
}

// the scope predicates (moved verbatim from ProjectSupervisor): reads of the guidance and policy stores and the scratch
// classification memory that every guard uses; lower services read them here instead of calling back into ProjectSupervisor
export class SupervisionScope implements GateGuard {
  private readonly scratchProjectIds = new Set<string>();
  private catalogClassificationsReady = false;
  private readonly nativeThreads = new Map<string, ThreadInfo>();
  constructor(readonly config: SupervisorSettings, private readonly stores: SupervisionScopeStores, private readonly operateRpcAvailable: boolean) {}
  /** The permanent root and helper ownership the scope checks treat as Supervisor threads. */
  get owned(): ReadonlySet<string> {return this.stores.supervisors.ownedIds;}
  // the classifications are read first and the memory is replaced at once, so no reader sees a partly applied catalog
  rememberCatalog(projects: readonly {id: string; workspaceRoot: string}[], threads: readonly ThreadInfo[]): Effect.Effect<void, GuidanceStoreError> {
    return Effect.flatMap(Effect.forEach(projects, (project) => Effect.map(this.scratchProject(project.id, project.workspaceRoot), (scratch) => [project.id, scratch] as const)),
      (classified) => Effect.sync(() => {
        for (const [id, scratch] of classified) {
          if (scratch) this.scratchProjectIds.add(id);
          else this.scratchProjectIds.delete(id);
        }
        this.catalogClassificationsReady = true;
        this.nativeThreads.clear();
        for (const thread of threads.slice(0, 10_000)) this.nativeThreads.set(thread.id, thread);
      }));
  }
  scratchProject(projectId: string, workspaceRoot: string): Effect.Effect<boolean, GuidanceStoreError> {
    return Effect.map(this.stores.guidance.classification(projectId), (classification) => classification !== "unclassified"
      ? classification === "scratch" : Boolean(this.config.managedScratchRoot && resolve(workspaceRoot) === resolve(this.config.managedScratchRoot)));
  }
  isNoProject(projectId: string): Effect.Effect<boolean, GuidanceStoreError> {
    return Effect.map(this.stores.guidance.classification(projectId), (classification) =>
      classification === "unclassified" ? this.scratchProjectIds.has(projectId) : classification === "scratch");
  }
  /** One scope predicate protects every effect; only a pending Start's interpretation can run before activation. */
  scopeEnabled(projectId: string, mainThreadId?: string, purpose: "effect" | "interpretation" | "reconcile" = "effect"): Effect.Effect<boolean, SupervisionStoreError> {
    const store = this.stores.supervisors;
    return Effect.gen({self: this}, function* () {
      if (mainThreadId && purpose !== "reconcile") {
        const main = this.nativeThreads.get(mainThreadId);
        if (!main || main.projectId !== projectId || !conversationOriginAllowed(main, yield* projectRequesterPolicy(store, projectId))) return false;
      }
      if (!(yield* this.isNoProject(projectId)))
        return (yield* store.enabled(projectId)) && (purpose === "reconcile" || !mainThreadId || !(yield* this.supervisionStopped(mainThreadId)));
      const control = yield* store.noProjectControl();
      if (!control.globallyEnabled || control.mode === "off") return false;
      if (!mainThreadId) return control.mode === "automatic";
      const start = yield* store.start(mainThreadId);
      if (start?.status === "pending") return purpose !== "effect" && (yield* this.validPendingStart(start));
      if (purpose !== "reconcile" && (yield* this.supervisionStopped(mainThreadId))) return false;
      return control.mode === "automatic" || start?.status === "active";
    });
  }
  validPendingStart(start: SupervisionStartRecord): Effect.Effect<boolean, ProjectSupervisorStoreError> {
    const store = this.stores.supervisors;
    return Effect.gen(function* () {
      if (start.status !== "pending") return false;
      const mode = yield* store.noProjectControl();
      return mode.globallyEnabled && mode.mode !== "off" && mode.generation === start.modeGeneration &&
        (yield* store.control(null)).generation === start.masterGeneration && ((yield* store.chatStop(start.threadId))?.stoppedAt ?? -1) < start.intentAt &&
        ((yield* store.chatEnabledAt(start.threadId)) ?? -1) <= start.intentAt;
    });
  }
  projectEnabled(projectId: string, mainThreadId?: string): Effect.Effect<boolean, SupervisionStoreError> {return this.scopeEnabled(projectId, mainThreadId, "interpretation");}
  workflowEditingEnabled(projectId: string, mainThreadId?: string, purpose: "effect" | "status" | "read" = "effect"): Effect.Effect<boolean, SupervisionStoreError> {
    return this.catalogClassificationsReady && this.operateRpcAvailable && this.stores.supervisors.scopeCompatible
      ? this.scopeEnabled(projectId, mainThreadId, purpose !== "effect" ? "reconcile" : "effect") : Effect.succeed(false);
  }
  validPendingStartFor(threadId: string): Effect.Effect<boolean, ProjectSupervisorStoreError> {
    return Effect.flatMap(this.stores.supervisors.start(threadId), (start) => start ? this.validPendingStart(start) : Effect.succeed(false));
  }
  /** Whether the instance thread policy stops supervision of this chat; the same control backs the dashboard and supervision_stop. */
  supervisionStopped(threadId: string): Effect.Effect<boolean, ThreadPolicyStoreError> {
    return Effect.map(this.stores.policy.get(), (policy) => policy.excludedThreadIds.includes(threadId));
  }
  mainShape(thread: ThreadInfo): boolean {
    return !isSupervisorThread(this.owned, thread) && !unavailable(thread) && thread.lineage.relationshipToParent !== "subagent";
  }
  eligible(thread: ThreadInfo, threads: readonly ThreadInfo[]): Effect.Effect<boolean, SupervisionStoreError> {
    return Effect.gen({self: this}, function* () {
      if (isSupervisorThread(this.owned, thread) || unavailable(thread) || thread.lineage.relationshipToParent === "subagent" ||
        !conversationOriginAllowed(thread, thread.projectId === null ? {owned: this.owned, agentRequestsAfter: null} : yield* projectRequesterPolicy(this.stores.supervisors, thread.projectId)) ||
        (yield* this.supervisionStopped(thread.id)) && !(yield* this.validPendingStartFor(thread.id))) return false;
      return mainConversation(thread, threads)?.id === thread.id;
    });
  }
}

// the scope predicates as a service: the one SupervisionScope of a supervision run, over its stores
export class SupervisionScopeService extends Context.Service<SupervisionScopeService, SupervisionScope>()("t3-supervisor/SupervisionScopeService") {
  static readonly layer = (operateRpcAvailable: boolean): Layer.Layer<SupervisionScopeService, never, Configuration | GuidanceStore | ProjectSupervisorStore | ThreadPolicyStore> =>
    Layer.effect(SupervisionScopeService, Effect.gen(function* () {
      return new SupervisionScope(yield* Configuration, {guidance: yield* GuidanceStore, supervisors: yield* ProjectSupervisorStore, policy: yield* ThreadPolicyStore},
        operateRpcAvailable);
    }));
}

// admission was requested while a guidance transaction is open on the calling fiber: the section is never acquired inside a
// transaction (plan 3.11 item 2, CT-LIN-07), so this is a defect
export class AdmissionInsideTransaction extends Data.TaggedError("AdmissionInsideTransaction") {
  override readonly message = "admission requested inside a guidance transaction";
}

export interface SupervisionGateShape {
  // one admission section: waiting for the permit stays interruptible (nothing is admitted before it), the body is
  // uninterruptible and contains only short guidance transactions and at most one native initiation; requested while a
  // guidance transaction is open on the calling fiber, it dies
  readonly admit: <A, E, R>(body: (guard: GateGuard) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

// one gate over the given predicates, on the run's guidance client whose transactions it is never entered from
export const makeSupervisionGate = (guard: GateGuard): Effect.Effect<SupervisionGateShape, never, GuidanceDb> => Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const admission = yield* Semaphore.make(1);
  return {
    admit: (body) => Effect.flatMap(Effect.serviceOption(db.transactionService), (open) => Option.isSome(open)
      ? Effect.die(new AdmissionInsideTransaction())
      : Semaphore.withPermits(admission, 1)(Effect.uninterruptible(Effect.suspend(() => body(guard))))),
  };
});

export class SupervisionGate extends Context.Service<SupervisionGate, SupervisionGateShape>()("t3-supervisor/SupervisionGate") {
  static readonly layer: Layer.Layer<SupervisionGate, never, SupervisionScopeService | GuidanceDb> =
    Layer.effect(SupervisionGate, Effect.flatMap(Effect.service(SupervisionScopeService), makeSupervisionGate));
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
