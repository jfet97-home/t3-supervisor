import { Effect, Layer } from "effect";
import { SupervisorIds } from "./ids.js";
import type { ProjectSupervisorStore } from "./project-supervisor-store.js";
import { ProjectSupervisor } from "./project-supervisor.js";
import { ScopeLocks } from "./scope-locks.js";
import { SupervisionControl } from "./supervision-control.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScopeService, type SupervisionScope } from "./supervision-gate.js";
import { SupervisionStores } from "./supervision-stores.js";
import { SupervisorConversation } from "./supervisor-conversation.js";
import { SupervisorConversationStore } from "./supervisor-conversation-store.js";
import { HelperTransport } from "./supervisor-helper-transport.js";
import { SupervisorLifecycle } from "./supervisor-lifecycle.js";
import { ProjectSupervisorMonitorStore } from "./supervisor-monitor-store.js";
import { SupervisorTeamController } from "./supervisor-team-controller.js";
import { SupervisorTeamRuntime } from "./supervisor-team-runtime.js";
import { SupervisorTeamStore } from "./supervisor-team-store.js";
import { WorkflowStateStore } from "./workflow-state-store.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "./workflow-write-controller.js";

// the services of one supervision run as one layer graph (plan 3.9, s6c): built once in the run's scope over the root's
// native clients (the read client and its shell, the operate client when configured, the catalog, the T3 client, the
// definitions and the native transport), and released in reverse, the project supervisor first and the interim stores last

// one supervision run: the interim binding store (b-02 until s6d), its scope predicates, the T3 base url of the helper
// webhooks and the configured helper provider instance
export interface SupervisionRun {
  readonly store: ProjectSupervisorStore;
  readonly scope: SupervisionScope;
  readonly baseUrl: string;
  readonly helperProviderInstanceId?: string | undefined;
}

// the record of the interim synchronous stores over the run's binding store (b-02 until s6d) and the scope predicates; workflow
// editing is guarded by those predicates
const runStores = (run: SupervisionRun) => Layer.mergeAll(
  Layer.succeed(SupervisionScopeService, run.scope),
  Layer.sync(SupervisionStores, () => SupervisionStores.of({supervisors: run.store, requests: new SupervisorConversationStore(run.store.store),
    monitor: new ProjectSupervisorMonitorStore(run.store.store), team: new SupervisorTeamStore(run.store),
    workflows: new WorkflowStateStore(run.store, (projectId, mainThreadId) => run.scope.workflowEditingEnabled(projectId, mainThreadId))})),
);

// the run's one admission section, guarding with its scope predicates (plan 3.11)
const runGate = Layer.effect(SupervisionGate, Effect.gen(function* () {
  return yield* makeSupervisionGate(yield* SupervisionScopeService);
}));

// the team runtime over the interim stores and the helper transport
const teamRuntime = Layer.effect(SupervisorTeamRuntime, Effect.gen(function* () {
  const stores = yield* SupervisionStores;
  return yield* SupervisorTeamRuntime.make({store: stores.supervisors, teamStore: stores.team, requests: stores.requests, monitor: stores.monitor});
}));

// i-01/i-02: the interim stores, the scope predicates and their admission gate, then the helper transport, the team runtime,
// the conversation and the lifecycle of the run
export const SupervisionTeamLive = (run: SupervisionRun) => SupervisorLifecycle.layer.pipe(
  Layer.provideMerge(SupervisorConversation.layer),
  Layer.provideMerge(teamRuntime),
  Layer.provideMerge(HelperTransport.layer({store: run.store, baseUrl: run.baseUrl})),
  Layer.provideMerge(runGate),
  Layer.provideMerge(runStores(run)),
);

// the Start/Stop control, the workflow proof and scope reads on the read credential, and the workflow write and team
// controllers over the team services
export const SupervisionControllersLive = (run: Pick<SupervisionRun, "helperProviderInstanceId">) =>
  SupervisorTeamController.layer(run.helperProviderInstanceId ? {helperProviderInstanceId: run.helperProviderInstanceId} : {}).pipe(
    Layer.provideMerge(WorkflowWriteController.layer()),
    Layer.provideMerge(Layer.mergeAll(SupervisionControl.layer, WorkflowNativeAccess.layer)),
  );

// the whole run: the per-scope locks and the ids, the team services, the controllers and the project supervisor
export const SupervisionLive = (run: SupervisionRun) => ProjectSupervisor.layer().pipe(
  Layer.provideMerge(SupervisionControllersLive(run)),
  Layer.provideMerge(SupervisionTeamLive(run)),
  Layer.provideMerge(Layer.mergeAll(ScopeLocks.layer, SupervisorIds.layer)),
);
