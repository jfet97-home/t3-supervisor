import { projectionHasOngoingWork } from "./domain.js";
import { randomUUID } from "node:crypto";
import { fingerprint } from "./guidance-store.js";
import { mainConversation } from "./supervisor-scope.js";
import { record, SupervisorRpcError, type SupervisorRpc } from "./supervisor-native.js";
import type { BindingRecord, ProjectSupervisorStore } from "./project-supervisor-store.js";
import type { SupervisorConversation } from "./supervisor-conversation.js";
import type { Projection, ThreadInfo } from "./types.js";

export const SUPERVISOR_SETTLE_QUIET_MS = 60_000;
const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back", "idle"]);
export const userKeepsSupervisorActive = (thread: ThreadInfo): boolean => Boolean(thread.pinnedAt || thread.autoSettleDisabledAt || thread.settledOverride === "active");
export const projectionNeedsAttention = (projection: Projection, shell?: ThreadInfo): boolean =>
  projectionHasOngoingWork(projection, shell) || Boolean(projection.thread.activeRunId || projection.thread.pendingRuntimeRequest) ||
  (projection.subagents ?? []).some(child => !terminal.has(String(child.status)));
const activityVersion = (projection: Projection) => fingerprint({
  updatedAt: projection.thread.updatedAt,
  runs: projection.runs.map(run => [run.id, run.status, run.completedAt]),
  messages: projection.messages.map(message => [message.id, message.updatedAt, message.streaming]),
  items: projection.turnItems?.map(item => [item.id, item.status, item.updatedAt]),
});

/** Parks only owned idle conversations, retaining their identity for normal native dispatch. */
export class SupervisorLifecycle {
  constructor(readonly store: ProjectSupervisorStore, readonly conversation: SupervisorConversation,
    readonly projection: (threadId: string, signal: AbortSignal) => Promise<Projection>, readonly rpc: SupervisorRpc | null) {}

  async check(input: BindingRecord, threads: readonly ThreadInfo[], signal: AbortSignal, now = Date.now()): Promise<void> {
    let binding = this.store.binding(input.projectId, input.mainThreadId);
    if (!binding || binding.threadId !== input.threadId || binding.state !== "ready" || !this.rpc) return;
    let supervisor = await this.projection(binding.threadId, signal);
    if (supervisor.thread.id !== binding.threadId || supervisor.thread.projectId !== binding.projectId || supervisor.thread.archivedAt || supervisor.thread.deletedAt) return;
    if (supervisor.thread.settledOverride === "active" && !binding.manualKeepActive) {
      binding = {...binding, manualKeepActive: true};this.store.setBinding(binding);
    }
    if (supervisor.thread.settledAt || supervisor.thread.settledOverride === "settled") {
      if (binding.settlement && binding.settlement.state !== "settled") this.store.setBinding({...binding, settlement: {...binding.settlement, state: "settled"}});
      return;
    }
    const main = await this.projection(binding.mainThreadId, signal);
    const version = activityVersion(main) + activityVersion(supervisor);
    if (binding.settlement && ["pending", "uncertain"].includes(binding.settlement.state) && binding.settlement.activityVersion !== version) {
      this.store.setBinding({...binding, quietSince: null, settlement: {...binding.settlement, state: "superseded"}});return;
    }
    if (binding.settlement?.state === "uncertain" && ((binding.settlement.attempts ?? 0) >= 3 || now - binding.settlement.observedAt < SUPERVISOR_SETTLE_QUIET_MS)) return;
    const tasks = this.store.tasksFor(binding);
    const requests = this.conversation.requests.requests(binding.projectId, binding.threadId);
    const source = threads.find(thread => thread.id === input.mainThreadId && thread.projectId === input.projectId);
    const status = this.conversation.status(binding.projectId, binding.threadId);
    const blocked = binding.manualKeepActive || userKeepsSupervisorActive(supervisor.thread) || this.store.modelState(binding).pending || !source || source.archivedAt || source.deletedAt ||
      !["idle", "paused"].includes(status.state) || status.pendingItems > 0 || this.conversation.requests.reviewMisses(binding.threadId) > 0 ||
      tasks.length === 0 || tasks.some(task => task.status !== "inferred" || task.definitionReview?.status === "checking" || task.definitionReview?.status === "revert_requested" || task.agreement?.status === "stale") ||
      this.conversation.requests.introductions(binding.projectId).some(intro => intro.supervisorThreadId === binding!.threadId && intro.state !== "sent") ||
      requests.some(request => ["prepared", "sending", "waiting", "uncertain"].includes(request.state) || request.state === "failed" && request.kind === "review" && !request.failureAcknowledged) || projectionNeedsAttention(supervisor);
    if (blocked) {this.clearQuiet(binding);return;}
    const latest = [...main.runs].sort((a, b) => b.ordinal - a.ordinal)[0];
    if (main.thread.projectId !== binding.projectId || main.thread.archivedAt || main.thread.deletedAt || !latest || latest.status !== "completed" || projectionNeedsAttention(main, source)) {
      this.clearQuiet(binding);return;
    }
    const children = threads.filter(thread => thread.id !== binding!.mainThreadId && mainConversation(thread, threads)?.id === binding!.mainThreadId);
    const relatives = new Map<string, Projection>([[main.thread.id, main]]);
    for (const child of children) {
      if (child.deletedAt || child.archivedAt) continue;
      const projection = await this.projection(child.id, signal);
      relatives.set(child.id, projection);
      if (projectionNeedsAttention(projection, child)) {this.clearQuiet(binding);return;}
    }
    for (const child of children) {
      const projection = relatives.get(child.id);
      if (!projection) continue;
      const parent = child.lineage.parentThreadId ? relatives.get(child.lineage.parentThreadId) : null;
      if (projection.runs.length === 0 && !(parent?.subagents ?? []).some(task =>
        task.childThreadId === child.id && terminal.has(String(task.status)))) {this.clearQuiet(binding);return;}
    }
    if (binding.quietFingerprint !== version || binding.quietSince == null) {
      this.store.setBinding({...binding, quietFingerprint: version, quietSince: now});return;
    }
    if (now - binding.quietSince < SUPERVISOR_SETTLE_QUIET_MS) return;
    // recheck both chats immediately before the native effect; native settlement rejects busy Supervisors
    const freshMain = await this.projection(binding.mainThreadId, signal);
    supervisor = await this.projection(binding.threadId, signal);
    if (activityVersion(freshMain) + activityVersion(supervisor) !== version || projectionNeedsAttention(freshMain) || projectionNeedsAttention(supervisor) || userKeepsSupervisorActive(supervisor.thread)) {
      this.clearQuiet(binding);return;
    }
    binding = this.store.binding(binding.projectId, binding.mainThreadId)!;
    if (this.conversation.hasInflight(binding.projectId, binding.threadId)) return;
    const settlement = binding.settlement && ["pending", "uncertain"].includes(binding.settlement.state) ? binding.settlement : {commandId: `supervisor-settle:${randomUUID()}`, state: "pending" as const, observedAt: now, activityVersion: version, attempts: 0};
    const sending = {...settlement, attempts: (settlement.attempts ?? 0) + 1, observedAt: now};
    this.store.setBinding({...binding, settlement: sending});
    try {
      const receipt = await this.rpc("orchestration.dispatchCommand", {type: "thread.settle", commandId: settlement.commandId, threadId: binding.threadId}, signal);
      if (!record(receipt) || !Number.isSafeInteger(receipt.sequence)) throw new SupervisorRpcError("uncertain");
      this.store.setBinding({...binding, settlement: {...sending, state: "settled"}});
      const current = await this.projection(binding.threadId, signal);
      this.store.setBinding({...binding, settlement: {...sending, state: current.thread.settledAt || current.thread.settledOverride === "settled" ? "settled" : "superseded"}});
    } catch (cause) {
      if (cause instanceof SupervisorRpcError && cause.definiteRejection) this.store.setBinding({...binding, quietSince: null, settlement: {...sending, state: "superseded"}});
      else if (this.store.binding(binding.projectId, binding.mainThreadId)?.settlement?.state !== "settled") this.store.setBinding({...binding, settlement: {...sending, state: "uncertain"}});
    }
  }
  private clearQuiet(binding: BindingRecord): void {
    const next = {...binding, quietSince: null};delete next.quietFingerprint;
    if (next.settlement?.state !== "uncertain") delete next.settlement;
    this.store.setBinding(next);
  }
}
