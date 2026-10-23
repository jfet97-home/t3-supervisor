import { Effect, Layer } from "effect";
import { SupervisorIds } from "./ids.js";
import { ProjectSupervisorStore } from "./project-supervisor-store.js";
import { ProjectSupervisor } from "./project-supervisor.js";
import { ScopeLocks } from "./scope-locks.js";
import { SupervisionControl } from "./supervision-control.js";
import { SupervisionGate, SupervisionScopeService } from "./supervision-gate.js";
import { SupervisorConversation } from "./supervisor-conversation.js";
import { SupervisorConversationStore } from "./supervisor-conversation-store.js";
import { HelperTransport } from "./supervisor-helper-transport.js";
import { SupervisorLifecycle } from "./supervisor-lifecycle.js";
import { ProjectSupervisorMonitorStore } from "./supervisor-monitor-store.js";
import { SupervisorStateReset } from "./supervisor-state-reset.js";
import { SupervisorTeamController } from "./supervisor-team-controller.js";
import { SupervisorTeamRuntime } from "./supervisor-team-runtime.js";
import { SupervisorTeamStore } from "./supervisor-team-store.js";
import { WorkflowStateStore } from "./workflow-state-store.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "./workflow-write-controller.js";

// the services of one supervision run as one layer graph (plan 3.9, s6c): built once in the run's scope over the run's guidance
// client and store, the process's thread-policy store and ownership set, and the root's native clients (the read client and its
// shell, the operate client when configured, the catalog, the T3 client, the definitions and the native transport); released in
// reverse, the project supervisor first and the supervision stores last

// one supervision run: whether the operate credential is configured, the T3 base url of the helper webhooks and the configured
// helper provider instance
export interface SupervisionRun {
  readonly operateRpcAvailable: boolean;
  readonly baseUrl: string;
  readonly helperProviderInstanceId?: string | undefined;
}

// the supervision stores on the run's guidance client, acquired in the baseline constructor order over the guidance store: the
// one-time state reset, the project supervision store (its schema, the reset, the Start recovery and the ownership reload, before
// the run filters the catalog), then the conversation, monitor and team stores
export const SupervisionStoresLive = SupervisorTeamStore.layer.pipe(
  Layer.provideMerge(ProjectSupervisorMonitorStore.layer),
  Layer.provideMerge(SupervisorConversationStore.layer),
  Layer.provideMerge(ProjectSupervisorStore.layer),
  Layer.provideMerge(SupervisorStateReset.layer),
);

// the run's scope predicates over its stores and the workflow state store, whose owner check is their workflow-editing predicate
export const SupervisionScopeLive = (operateRpcAvailable: boolean) => Layer.unwrap(Effect.map(Effect.service(SupervisionScopeService), (scope) =>
  WorkflowStateStore.layerWith((projectId, mainThreadId) => scope.workflowEditingEnabled(projectId, mainThreadId)))).pipe(
  Layer.provideMerge(SupervisionScopeService.layer(operateRpcAvailable)),
);

// i-01/i-02: the admission gate over the scope predicates, then the helper transport, the team runtime, the conversation and the
// lifecycle of the run
export const SupervisionTeamLive = (run: Pick<SupervisionRun, "baseUrl">) => SupervisorLifecycle.layer.pipe(
  Layer.provideMerge(SupervisorConversation.layer),
  Layer.provideMerge(SupervisorTeamRuntime.layer()),
  Layer.provideMerge(HelperTransport.layer({baseUrl: run.baseUrl})),
  Layer.provideMerge(SupervisionGate.layer),
);

// the Start/Stop control, the workflow proof and scope reads on the read credential, and the workflow write and team
// controllers over the team services
export const SupervisionControllersLive = (run: Pick<SupervisionRun, "helperProviderInstanceId">) =>
  SupervisorTeamController.layer(run.helperProviderInstanceId ? {helperProviderInstanceId: run.helperProviderInstanceId} : {}).pipe(
    Layer.provideMerge(WorkflowWriteController.layer()),
    Layer.provideMerge(Layer.mergeAll(SupervisionControl.layer, WorkflowNativeAccess.layer)),
  );

// the whole run over its supervision stores (SupervisionStoresLive, built first by the caller): the per-scope locks and the ids,
// the scope predicates, the team services, the controllers and the project supervisor
export const SupervisionLive = (run: SupervisionRun) => ProjectSupervisor.layer().pipe(
  Layer.provideMerge(SupervisionControllersLive(run)),
  Layer.provideMerge(SupervisionTeamLive(run)),
  Layer.provideMerge(SupervisionScopeLive(run.operateRpcAvailable)),
  Layer.provideMerge(Layer.mergeAll(ScopeLocks.layer, SupervisorIds.layer)),
);
