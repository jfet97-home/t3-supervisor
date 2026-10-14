import { projectionHasOngoingWork } from "./domain.js";
import { randomUUID } from "node:crypto";
import { fingerprint } from "./guidance-store.js";
import { record, SupervisorRpcError, type SupervisorRpc } from "./supervisor-native.js";
import type { BindingRecord, ProjectSupervisorStore } from "./project-supervisor-store.js";
import type { SupervisorConversation } from "./supervisor-conversation.js";
import { T3TransportError } from "./t3.js";
import type { Projection, ThreadInfo } from "./types.js";

export const SUPERVISOR_SETTLE_QUIET_MS = 60_000;
const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back", "idle"]);
export const userKeepsSupervisorActive = (thread: ThreadInfo): boolean => Boolean(thread.pinnedAt || thread.autoSettleDisabledAt || thread.settledOverride === "active");
export const projectionNeedsAttention = (projection: Projection, shell?: ThreadInfo): boolean =>
  projectionHasOngoingWork(projection, shell) || Boolean(projection.thread.activeRunId || projection.thread.pendingRuntimeRequest) ||
  (projection.subagents ?? []).some(child => !terminal.has(String(child.status)));
const activityVersion = (projection: Projection) => fingerprint({
  archivedAt: projection.thread.archivedAt ?? null,
  deletedAt: projection.thread.deletedAt ?? null,
  updatedAt: projection.thread.updatedAt,
  runs: projection.runs.map(run => [run.id, run.status, run.completedAt]),
  messages: projection.messages.map(message => [message.id, message.updatedAt, message.streaming]),
  items: projection.turnItems?.map(item => [item.id, item.status, item.updatedAt]),
});

/** Parks only owned idle conversations, retaining their identity for normal native dispatch. */
export class SupervisorLifecycle {
  constructor(readonly store: ProjectSupervisorStore, readonly conversation: SupervisorConversation,
    readonly projection: (threadId: string, signal: AbortSignal) => Promise<Projection>, readonly rpc: SupervisorRpc | null) {}

  /** Returns a confirmed missing main as null; every other unreadable or mismatched scope fails closed. */
  async readMain(binding: BindingRecord, signal: AbortSignal): Promise<Projection | null> {
    let projection: Projection;
    try {projection = await this.projection(binding.mainThreadId, signal);}
    catch (cause) {
      if (cause instanceof T3TransportError && cause.httpStatus === 404) return null;
      throw cause;
    }
    if (projection.thread.id !== binding.mainThreadId || projection.thread.projectId !== binding.projectId) throw new Error("main_scope_mismatch");
    return projection;
  }

  private async relatedChildren(binding: BindingRecord, main: Projection | null, threads: readonly ThreadInfo[], signal: AbortSignal): Promise<{blocked: boolean; version: string}> {
    if (!main || main.thread.deletedAt) return {blocked: false, version: fingerprint("deleted-main")};
    const shells = new Map(threads.map(thread => [thread.id, thread]));
    const projections = new Map<string, Projection>();
    if (main) {shells.set(main.thread.id, main.thread);projections.set(main.thread.id, main);}
    const candidates = threads.filter(thread => thread.id !== binding.mainThreadId && thread.projectId === binding.projectId &&
      !thread.deletedAt && thread.lineage.relationshipToParent === "subagent");
    const relatedIds = new Set<string>();
    const missingAncestor = Symbol("missing-ancestor");
    const readShell = async (threadId: string): Promise<ThreadInfo | typeof missingAncestor | null> => {
      const known = shells.get(threadId);
      if (known) return known.deletedAt ? missingAncestor : known;
      const existing = projections.get(threadId);
      if (existing) return existing.thread.deletedAt ? missingAncestor : existing.thread;
      let projection: Projection;
      try {projection = await this.projection(threadId, signal);}
      catch (cause) {
        if (cause instanceof T3TransportError && cause.httpStatus === 404) return missingAncestor;
        throw cause;
      }
      if (projection.thread.id !== threadId || projection.thread.projectId !== binding.projectId) return null;
      shells.set(threadId, projection.thread);projections.set(threadId, projection);
      return projection.thread.deletedAt ? missingAncestor : projection.thread;
    };
    const family = async (candidate: ThreadInfo): Promise<"child" | "other" | "unknown"> => {
      let current = candidate;
      const seen = new Set<string>();
      const path: string[] = [];
      for (let depth = 0; depth < 64; depth++) {
        if (current.projectId !== binding.projectId) return "unknown";
        if (current.lineage.relationshipToParent !== "subagent") return "other";
        const parentId = current.lineage.parentThreadId;
        if (!parentId || seen.has(current.id)) return "unknown";
        path.push(current.id);
        if (parentId === binding.mainThreadId) {for (const id of path) relatedIds.add(id);return "child";}
        seen.add(current.id);
        const parent = await readShell(parentId);
        if (parent === missingAncestor) return "other";
        if (!parent) return "unknown";
        current = parent;
      }
      return "unknown";
    };
    for (const candidate of candidates) {
      const membership = await family(candidate);
      if (membership === "unknown") return {blocked: true, version: fingerprint(["unknown-child-ancestry", candidate.id])};
      if (membership === "child") relatedIds.add(candidate.id);
    }
    const relatedProjections: Projection[] = [];
    for (const childId of [...relatedIds].sort()) {
      let projection = projections.get(childId);
      if (!projection) {
        try {projection = await this.projection(childId, signal);}
        catch (cause) {
          if (cause instanceof T3TransportError && cause.httpStatus === 404) continue;
          throw cause;
        }
        if (projection.thread.id !== childId || projection.thread.projectId !== binding.projectId) return {blocked: true, version: fingerprint(["child-scope-mismatch", childId])};
        projections.set(childId, projection);shells.set(childId, projection.thread);
      }
      const child = projection.thread;
      relatedProjections.push(projection);
      if (projectionNeedsAttention(projection, projection.thread)) return {blocked: true, version: fingerprint([child.id, activityVersion(projection)])};
      if (projection.runs.length === 0) {
        const parentId = child.lineage.parentThreadId;
        let parent = parentId ? projections.get(parentId) : null;
        if (parentId && !parent) {
          try {parent = await this.projection(parentId, signal);}
          catch (cause) {
            if (!(cause instanceof T3TransportError && cause.httpStatus === 404)) throw cause;
          }
          if (parent && (parent.thread.id !== parentId || parent.thread.projectId !== binding.projectId)) return {blocked: true, version: fingerprint(["parent-scope-mismatch", parentId])};
          if (parent) projections.set(parentId, parent);
        }
        if (!(parent?.subagents ?? []).some(task => task.childThreadId === child.id && terminal.has(String(task.status)))) {
          return {blocked: true, version: fingerprint(["unconfirmed-runless-child", child.id])};
        }
      }
    }
    const version = fingerprint(relatedProjections.map(projection => [projection.thread.id, activityVersion(projection)] as const).sort(([a], [b]) => a.localeCompare(b)));
    return {blocked: false, version};
  }

  async check(input: BindingRecord, threads: readonly ThreadInfo[], signal: AbortSignal, now = Date.now()): Promise<void> {
    let binding = this.store.binding(input.projectId, input.mainThreadId);
    if (!binding || binding.threadId !== input.threadId || binding.state !== "ready" || !this.rpc) return;
    let supervisor: Projection;
    try {supervisor = await this.projection(binding.threadId, signal);}
    catch {this.clearQuiet(binding);return;}
    if (supervisor.thread.id !== binding.threadId || supervisor.thread.projectId !== binding.projectId || supervisor.thread.archivedAt || supervisor.thread.deletedAt) return;
    if (supervisor.thread.settledOverride === "active" && !binding.manualKeepActive) {
      binding = {...binding, manualKeepActive: true};this.store.setBinding(binding);
    }
    if (supervisor.thread.settledAt || supervisor.thread.settledOverride === "settled") {
      if (binding.settlement && binding.settlement.state !== "settled") this.store.setBinding({...binding, settlement: {...binding.settlement, state: "settled"}});
      return;
    }
    let main: Projection | null;
    try {main = await this.readMain(binding, signal);}
    catch {this.clearQuiet(binding);return;}
    const closedMain = !main || Boolean(main.thread.archivedAt || main.thread.deletedAt);
    const source = threads.find(thread => thread.id === input.mainThreadId && thread.projectId === input.projectId);
    let childScopes: {blocked: boolean; version: string};
    try {childScopes = await this.relatedChildren(binding, main, threads, signal);}
    catch {this.clearQuiet(binding);return;}
    if (childScopes.blocked) {this.clearQuiet(binding);return;}
    const version = fingerprint({main: main ? activityVersion(main) : "missing", supervisor: activityVersion(supervisor), children: childScopes.version});
    if (binding.settlement && ["pending", "uncertain"].includes(binding.settlement.state) && binding.settlement.activityVersion !== version) {
      this.store.setBinding({...binding, quietSince: null, settlement: {...binding.settlement, state: "superseded"}});return;
    }
    if (binding.settlement?.state === "uncertain" && ((binding.settlement.attempts ?? 0) >= 3 || now - binding.settlement.observedAt < SUPERVISOR_SETTLE_QUIET_MS)) return;
    if (binding.manualKeepActive || userKeepsSupervisorActive(supervisor.thread) || this.store.modelState(binding).pending || projectionNeedsAttention(supervisor)) {
      this.clearQuiet(binding);return;
    }
    if (!closedMain) {
      const tasks = this.store.tasksFor(binding);
      const requests = this.conversation.requests.requests(binding.projectId, binding.threadId);
      const status = this.conversation.status(binding.projectId, binding.threadId);
      const blocked = !source || !["idle"].includes(status.state) || status.pendingItems > 0 || this.conversation.requests.reviewMisses(binding.threadId) > 0 ||
        tasks.length === 0 || tasks.some(task => task.status !== "inferred" || task.definitionReview?.status === "checking" || task.definitionReview?.status === "revert_requested" || task.agreement?.status === "stale") ||
        this.conversation.requests.introductions(binding.projectId).some(intro => intro.supervisorThreadId === binding!.threadId && intro.state !== "sent") ||
        requests.some(request => ["prepared", "sending", "waiting", "uncertain"].includes(request.state) || request.state === "failed" && request.kind === "review" && !request.failureAcknowledged);
      const latest = [...main!.runs].sort((a, b) => b.ordinal - a.ordinal)[0];
      if (blocked || !latest || latest.status !== "completed" || projectionNeedsAttention(main!, source ?? main!.thread)) {this.clearQuiet(binding);return;}
    } else if (main && projectionNeedsAttention(main, source ?? main.thread)) {
      this.clearQuiet(binding);return;
    }
    if (binding.quietFingerprint !== version || binding.quietSince == null) {
      this.store.setBinding({...binding, quietFingerprint: version, quietSince: now});return;
    }
    if (now - binding.quietSince < SUPERVISOR_SETTLE_QUIET_MS) return;
    // recheck both chats immediately before the native effect; native settlement rejects busy Supervisors
    let freshMain: Projection | null;
    try {freshMain = await this.readMain(binding, signal);}
    catch {this.clearQuiet(binding);return;}
    try {supervisor = await this.projection(binding.threadId, signal);}
    catch {this.clearQuiet(binding);return;}
    if (supervisor.thread.id !== binding.threadId || supervisor.thread.projectId !== binding.projectId || supervisor.thread.archivedAt || supervisor.thread.deletedAt) {this.clearQuiet(binding);return;}
    const freshClosedMain = !freshMain || Boolean(freshMain.thread.archivedAt || freshMain.thread.deletedAt);
    let freshChildren: {blocked: boolean; version: string};
    try {freshChildren = await this.relatedChildren(binding, freshMain, threads, signal);}
    catch {this.clearQuiet(binding);return;}
    if (freshClosedMain !== closedMain || freshChildren.blocked || fingerprint({main: freshMain ? activityVersion(freshMain) : "missing", supervisor: activityVersion(supervisor), children: freshChildren.version}) !== version ||
      freshMain && projectionNeedsAttention(freshMain, source ?? freshMain.thread) || projectionNeedsAttention(supervisor) || userKeepsSupervisorActive(supervisor.thread)) {
      this.clearQuiet(binding);return;
    }
    binding = this.store.binding(binding.projectId, binding.mainThreadId)!;
    if (!closedMain && this.conversation.hasInflight(binding.projectId, binding.threadId)) return;
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
