import { Context, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { GuidanceStore } from "../../src/guidance-store.js";
import { ProjectSupervisorStore } from "../../src/project-supervisor-store.js";
import { SupervisionGate, SupervisionScope, SupervisionScopeService } from "../../src/supervision-gate.js";
import { HelperTransport } from "../../src/supervisor-helper-transport.js";
import { NativeOperateRpc, NativeRpc, NativeShell, type NativeRpcShape } from "../../src/supervisor-native.js";
import { SupervisorTeamController } from "../../src/supervisor-team-controller.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { T3Client, type T3TransportError } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { Projection, SupervisorSettings, ThreadInfo } from "../../src/types.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "../../src/workflow-write-controller.js";
import type { SupervisionStores } from "./g11-stores.js";

// the team controller of the g11 suites over its production layers, as src/supervision-live.ts composes a run: the workflow
// state store over the scope's workflow-editing predicate, the admission gate over the scope predicates, the workflow native
// access over the read clients, the helper transport (its receipts are read, it posts nothing here), the write controller and
// the team controller, all on the supervision stores of a temporary guidance file and the process's thread-policy store.
// The native side is small effect fakes: the shell lineage, the T3 projections and the read rpc's turn items, and the operate
// rpc when a suite dispatches

/** The fake native reads: fresh lineage, a projection by thread id and a turn item by item id. */
export interface TeamNative {
  readonly listThreads: () => Effect.Effect<ReadonlyArray<ThreadInfo>>;
  readonly projection: (threadId: string) => Effect.Effect<Projection, T3TransportError>;
  readonly turnItem: (itemId: string) => Effect.Effect<unknown>;
}

// the suites' scope predicates: every scope is enabled and workflow editing is available, as the baseline units' isEnabled
// answered; the per-chat stop is the production read of the process's thread policy
class SuiteScope extends SupervisionScope {
  override scopeEnabled() {return Effect.succeed(true);}
  override workflowEditingEnabled() {return Effect.succeed(true);}
}

const settings = (dataDirectory: string): SupervisorSettings =>
  ({dataDirectory, t3Url: "http://unused.invalid", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0});

const unused = (client: string) => Effect.die(new Error(`unused native ${client}`));

// the read clients of the workflow native access and the helper transport over the fake
const readClients = (native: TeamNative) => Layer.mergeAll(
  Layer.succeed(NativeShell, {baseline: unused("shell baseline"), threads: Effect.suspend(native.listThreads)}),
  Layer.succeed(T3Client, {descriptor: () => unused("T3 descriptor"), watch: () => unused("T3 watch"),
    projection: (threadId) => Effect.map(Effect.suspend(() => native.projection(threadId)), (projection) => ({snapshotSequence: 0, projection}))}),
  Layer.succeed(NativeRpc, {
    call: (tag, payload) => tag === "orchestration.getTurnItem" ? Effect.map(native.turnItem(String(payload.itemId)), (item) => ({item})) : unused(tag),
    initiate: (tag) => unused(tag),
  } satisfies NativeRpcShape),
  // the helper transport's webhook client; no suite posts
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, () => Promise.reject(new Error("no webhook POST in the team controller suites"))))));

export type TeamControllerOptions = {
  // the operate client; without one no guidance is dispatched
  readonly rpc?: NativeRpcShape | null | undefined;
  // a team store built again on the same client, as a recreated controller's own store
  readonly freshTeam?: boolean | undefined;
};

/** The controllers over `stores` and `policy`, built in the current scope. */
export const teamControllers = (stores: SupervisionStores, policy: ThreadPolicyStore["Service"], native: TeamNative, options: TeamControllerOptions = {}) =>
  Effect.gen(function* () {
    const scope = Layer.effect(SupervisionScopeService, Effect.gen(function* () {
      return new SuiteScope(settings(stores.directory), {guidance: yield* GuidanceStore, supervisors: yield* ProjectSupervisorStore, policy: yield* ThreadPolicyStore}, true);
    }));
    const workflows = Layer.unwrap(Effect.map(Effect.service(SupervisionScopeService), (current) =>
      WorkflowStateStore.layerWith((projectId, mainThreadId) => current.workflowEditingEnabled(projectId, mainThreadId))));
    const controllers = SupervisorTeamController.layer().pipe(
      Layer.provideMerge(WorkflowWriteController.layer({maxEvidenceWaitMs: 0})),
      Layer.provideMerge(Layer.mergeAll(HelperTransport.layer({baseUrl: "http://unused.invalid"}), WorkflowNativeAccess.layer)),
      Layer.provideMerge(SupervisionGate.layer),
      Layer.provideMerge(workflows),
      Layer.provideMerge(scope),
      Layer.provideMerge(options.freshTeam ? Layer.fresh(SupervisorTeamStore.layer) : Layer.empty),
      Layer.provideMerge(Layer.mergeAll(readClients(native), options.rpc ? Layer.succeed(NativeOperateRpc, options.rpc) : Layer.empty,
        Layer.succeed(ThreadPolicyStore, policy), Layer.succeedContext(stores.context))));
    const context = yield* Layer.build(controllers).pipe(Effect.orDie);
    return {
      controller: Context.get(context, SupervisorTeamController),
      workflows: Context.get(context, WorkflowWriteController),
      team: Context.get(context, SupervisorTeamStore),
    };
  });

/** Stops (or, with null, re-enables) supervision of one main chat through the process's thread policy. */
export const stopMain = (policy: ThreadPolicyStore["Service"], threadId: string | null) => Effect.gen(function* () {
  const current = yield* policy.get();
  yield* policy.save({generation: current.generation, excludedThreadIds: threadId === null ? [] : [threadId]});
}).pipe(Effect.orDie);
