import { Context } from "effect";
import type { ProjectSupervisorStore } from "./project-supervisor-store.js";
import type { SupervisorConversationStore } from "./supervisor-conversation-store.js";
import type { ProjectSupervisorMonitorStore } from "./supervisor-monitor-store.js";
import type { SupervisorTeamStore } from "./supervisor-team-store.js";
import type { WorkflowStateStore } from "./workflow-state-store.js";

// the interim synchronous stores (b-02, plan 3.4) as one record, built once by the composition root over the guidance
// database; ported services call them only inside synchronous critical sections until the store port (S6d)
export interface SupervisionStoresShape {
  readonly supervisors: ProjectSupervisorStore;
  readonly requests: SupervisorConversationStore;
  readonly monitor: ProjectSupervisorMonitorStore;
  readonly team: SupervisorTeamStore;
  // null only where a unit is exercised without workflow state, as the baseline optional constructor argument allowed
  readonly workflows: WorkflowStateStore | null;
}

export class SupervisionStores extends Context.Service<SupervisionStores, SupervisionStoresShape>()("t3-supervisor/SupervisionStores") {}
