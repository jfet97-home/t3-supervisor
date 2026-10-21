import { freshRuntimeRequestStatus, projectionHasOngoingWork } from "./domain.js";
import { randomUUID } from "node:crypto";
import { fingerprint } from "./guidance-store.js";
import { record, SupervisorRpcError, type SupervisorRpc } from "./supervisor-native.js";
import type { BindingRecord, ProjectSupervisorStore } from "./project-supervisor-store.js";
import type { SupervisorConversation } from "./supervisor-conversation.js";
import { introductionOutcomeUnknown } from "./supervisor-conversation-store.js";
import { T3TransportError } from "./t3.js";
import type { Projection, ThreadInfo } from "./types.js";
import { resolveSupervisorScope, type SupervisorScopeResolution } from "./supervisor-scope.js";
import { childOrigin, delegatedLifecycle, directParentChildLifecycle, normalizeLifecycle } from "./supervisor-observation.js";
import type { WorkflowStateStore } from "./workflow-state-store.js";

export const SUPERVISOR_SETTLE_QUIET_MS = 60_000;
const SUPERVISOR_LIFECYCLE_MAX_PROJECTION_READS = 100;
const SUPERVISOR_LIFECYCLE_MAX_CACHE_REFRESHES = 20;
const SUPERVISOR_LIFECYCLE_MAX_CACHE_ENTRIES = 10_000;
const SUPERVISOR_LIFECYCLE_MAX_SCAN_OFFSETS = 256;
export const userKeepsSupervisorActive = (thread: ThreadInfo): boolean => Boolean(thread.pinnedAt || thread.autoSettleDisabledAt || thread.settledOverride === "active");
const laterThan = (value: unknown, since: number): boolean => typeof value === "string" && Date.parse(value) > since;
/** A keep-active choice counts against a stop only when the human made it after the stop; an unstamped override predates it. */
export const userKeepsSupervisorActiveSince = (thread: ThreadInfo, since: number): boolean =>
  laterThan(thread.pinnedAt, since) || laterThan(thread.autoSettleDisabledAt, since) || thread.settledOverride === "active" && laterThan(thread.unsettledAt, since);
const hasUnresolvedRuntimeRequestHint = (projection: Projection, value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value !== null && value !== undefined;
  const request = value as Record<string, unknown>;
  const requestId = typeof request.id === "string" ? request.id : typeof request.requestId === "string" ? request.requestId : null;
  const nodeId = typeof request.nodeId === "string" ? request.nodeId : null;
  const status = freshRuntimeRequestStatus(projection, {requestId, nodeId});
  return !["resolved", "expired", "cancelled"].includes(status);
};

export const projectionNeedsAttention = (projection: Projection, shell?: ThreadInfo): boolean =>
  projectionHasOngoingWork(projection, shell) || Boolean(projection.thread.activeRunId || hasUnresolvedRuntimeRequestHint(projection, projection.thread.pendingRuntimeRequest));
const activityVersion = (projection: Projection) => fingerprint({
  archivedAt: projection.thread.archivedAt ?? null,
  deletedAt: projection.thread.deletedAt ?? null,
  updatedAt: projection.thread.updatedAt,
  runs: projection.runs.map(run => [run.id, run.status, run.completedAt]),
  messages: projection.messages.map(message => [message.id, message.updatedAt, message.streaming]),
  items: projection.turnItems?.map(item => [item.id, item.type, item.status, item.updatedAt, item.childThreadId, item.providerThreadId]),
  subagents: projection.subagents?.map(item => [item.childThreadId, item.providerThreadId, item.status, item.completedAt]),
});
const lifecycleShellVersion = (thread: ThreadInfo): string => fingerprint({
  id: thread.id,
  parentThreadId: thread.lineage.parentThreadId,
  relationshipToParent: thread.lineage.relationshipToParent,
  creationSource: thread.creationSource ?? null,
  updatedAt: thread.updatedAt ?? null,
  archivedAt: thread.archivedAt ?? null,
  deletedAt: thread.deletedAt ?? null,
  latestRunId: thread.latestRunId ?? null,
  activeRunId: thread.activeRunId ?? null,
  activityRunStatus: thread.activityRunStatus ?? null,
  latestRunCompletedAt: thread.latestRunCompletedAt ?? null,
  pendingRuntimeRequest: thread.pendingRuntimeRequest ?? null,
  pendingBackgroundTasks: thread.pendingBackgroundTasks ?? null,
  pullRequests: thread.pullRequests ?? null,
});
type QuietChildObservation = {childShellVersion: string; parentShellVersion: string; parentProjectionVersion: string; resultVersion: string};

const activeDetachedChildWork = (projection: Projection): boolean => (projection.turnItems ?? []).some(item => {
  if (item.threadId !== projection.thread.id || item.runId !== null) return false;
  const requestItem = ["user_input_request", "approval_request", "secret_request"].includes(String(item.type));
  if (requestItem) {
    const requestStatus = freshRuntimeRequestStatus(projection, {
      requestId: typeof item.requestId === "string" ? item.requestId : null,
      nodeId: typeof item.nodeId === "string" ? item.nodeId : null,
    });
    if (["resolved", "expired", "cancelled"].includes(requestStatus)) return false;
    if (requestStatus === "pending") return true;
  }
  return item.streaming === true || ["preparing", "queued", "starting", "running", "waiting"].includes(String(item.status));
});

/** Parks only owned idle conversations, retaining their identity for normal native dispatch. */
export class SupervisorLifecycle {
  private readonly childObservations = new Map<string, QuietChildObservation>();
  private readonly childScanOffsets = new Map<string, number>();
  constructor(readonly store: ProjectSupervisorStore, readonly conversation: SupervisorConversation,
    readonly projection: (threadId: string, signal: AbortSignal) => Promise<Projection>, readonly rpc: SupervisorRpc | null,
    readonly workflows?: WorkflowStateStore) {}

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

  private workflowAttention(binding: BindingRecord, threadIds: readonly string[]): {blocked: boolean; version: string} {
    if (!this.workflows) return {blocked: false, version: "workflow-store-unavailable-in-test"};
    const result = this.workflows.hasNeedsAttention(binding.projectId, binding.mainThreadId, threadIds);
    return {blocked: result.status !== "complete" || result.needsAttention, version: fingerprint(result)};
  }

  // a not-needed or unresolved request gets no check-ins, so unreviewed activity retained for the next genuine request does not keep
  // its Supervisor open (an incomplete scan still does); any other task still waits for that activity to be reviewed
  private awaitsReview(binding: BindingRecord): boolean {
    const task = this.store.task(binding.mainThreadId);
    return !task || task.supervisorThreadId !== binding.threadId || !["not_supervised", "needs_context"].includes(task.status);
  }

  /** Returns the first gate that keeps the main supervision active, or null when settlement may proceed. */
  private mainAttention(binding: BindingRecord, supervisor: Projection, main: Projection | null, closedMain: boolean, source?: ThreadInfo): string | null {
    if (binding.manualKeepActive || userKeepsSupervisorActive(supervisor.thread)) return "keep_active";
    if (this.store.modelState(binding).pending) return "model_change_pending";
    if (projectionNeedsAttention(supervisor)) return "supervisor_busy";
    if (this.conversation.teamRuntime?.hasBlockingWork(binding)) return "team_work";
    if (closedMain) return main && projectionNeedsAttention(main, source ?? main.thread) ? "main_busy" : null;
    if (!source) return "main_not_cataloged";
    const tasks = this.store.tasksFor(binding);
    const requests = this.conversation.requests.requests(binding.projectId, binding.threadId);
    const status = this.conversation.status(binding.projectId, binding.threadId);
    if (status.state !== "idle") return "monitoring_not_idle";
    if (status.pendingItems > 0) return "pending_activity";
    if (this.conversation.requests.reviewMisses(binding.threadId) > 0) return "review_misses";
    // a temporary not-needed decision or an unresolved request leaves nothing to supervise until the next genuine request
    if (tasks.length === 0 || tasks.some(task => !["inferred", "not_supervised", "needs_context"].includes(task.status) || task.definitionReview?.status === "checking" ||
      task.definitionReview?.status === "revert_requested" || task.agreement?.status === "stale")) return "task_state";
    // the current task's unsent introduction and any introduction with an unknown outcome hold the Supervisor; a known-unsent draft
    // of a replaced task is history
    const current = this.store.task(binding.mainThreadId);
    if (this.conversation.requests.introductions(binding.projectId).some(intro => intro.supervisorThreadId === binding.threadId && intro.state !== "sent" &&
      (intro.taskId === current?.id || introductionOutcomeUnknown(intro))))
      return "introduction_unsent";
    if (requests.some(request => ["prepared", "sending", "waiting", "uncertain"].includes(request.state) ||
      request.state === "failed" && request.kind === "review" && !request.failureAcknowledged)) return "request_open";
    // a queued request cancelled before it started executed nothing; the latest executed run decides completion
    const latest = main ? [...main.runs].filter(run => !(run.status === "cancelled" && !run.startedAt))
      .sort((left, right) => right.ordinal - left.ordinal)[0] : undefined;
    if (!main || !latest || latest.status !== "completed") return "main_run_not_completed";
    return projectionNeedsAttention(main, source ?? main.thread) ? "main_busy" : null;
  }

  private scopeFor(binding: BindingRecord, main: Projection | null, threads: readonly ThreadInfo[]): SupervisorScopeResolution | null {
    if (!main || main.thread.deletedAt) return null;
    const nativeThreads = threads.some(thread => thread.id === main.thread.id) ? threads : [...threads, main.thread];
    return resolveSupervisorScope(nativeThreads, binding.projectId, binding.mainThreadId, this.store.ownedIds);
  }

  private childObservationKey(binding: BindingRecord, childThreadId: string): string {
    return JSON.stringify([binding.projectId, binding.mainThreadId, childThreadId]);
  }

  private rememberChildObservation(key: string, value: QuietChildObservation): void {
    this.childObservations.delete(key);
    this.childObservations.set(key, value);
    while (this.childObservations.size > SUPERVISOR_LIFECYCLE_MAX_CACHE_ENTRIES)
      this.childObservations.delete(this.childObservations.keys().next().value!);
  }

  private rememberScanOffset(scopeKey: string, offset: number): void {
    this.childScanOffsets.delete(scopeKey);
    this.childScanOffsets.set(scopeKey, offset);
    while (this.childScanOffsets.size > SUPERVISOR_LIFECYCLE_MAX_SCAN_OFFSETS)
      this.childScanOffsets.delete(this.childScanOffsets.keys().next().value!);
  }

  private async relatedChildren(binding: BindingRecord, main: Projection | null, threads: readonly ThreadInfo[], scope: SupervisorScopeResolution | null,
    signal: AbortSignal): Promise<{blocked: boolean; version: string; threadIds: string[]}> {
    if (!main || main.thread.deletedAt) return {blocked: false, version: fingerprint("deleted-main"), threadIds: [binding.mainThreadId]};
    if (!scope || !scope.complete || !scope.main || !scope.allowedIds.has(scope.main.id))
      return {blocked: true, version: fingerprint(["incomplete-child-scope", scope?.issues ?? []]), threadIds: scope ? [...scope.allowedIds] : [binding.mainThreadId]};
    const projections = new Map<string, Projection>([[main.thread.id, main]]);
    const children = scope.descendants.filter(child => scope.allowedIds.has(child.id) && child.lineage.relationshipToParent !== "fork");
    const scopeKey = JSON.stringify([binding.projectId, binding.mainThreadId]);
    const start = children.length ? (this.childScanOffsets.get(scopeKey) ?? 0) % children.length : 0;
    const ordered = [...children.slice(start), ...children.slice(0, start)];
    const observed = new Map<string, readonly unknown[]>();
    const stale: ThreadInfo[] = [];
    for (const child of ordered) {
      const parentId = child.lineage.parentThreadId;
      const parentInfo = parentId ? scope.byId.get(parentId) : null;
      if (!parentId || !scope.allowedIds.has(parentId) || !parentInfo)
        return {blocked: true, version: fingerprint(["child_parent_outside_scope", child.id]), threadIds: [...scope.allowedIds]};
      const cacheKey = this.childObservationKey(binding, child.id);
      const cached = this.childObservations.get(cacheKey);
      const parentProjection = projections.get(parentId);
      const parentProjectionVersion = parentProjection ? activityVersion(parentProjection) : null;
      const current = cached && cached.childShellVersion === lifecycleShellVersion(child) &&
        cached.parentShellVersion === lifecycleShellVersion(parentInfo) &&
        (parentProjectionVersion === null || cached.parentProjectionVersion === parentProjectionVersion) ? cached : null;
      if (current && !stale.includes(child)) {
        this.childObservations.delete(cacheKey);
        this.childObservations.set(cacheKey, current);
        observed.set(child.id, [child.id, current.resultVersion]);
      } else stale.push(child);
    }
    const refreshCandidates = [...stale, ...ordered.filter(child => observed.has(child.id)).slice(0, SUPERVISOR_LIFECYCLE_MAX_CACHE_REFRESHES)];
    let projectionReads = 0;
    let scanned = 0;
    const readProjection = async (threadId: string): Promise<Projection | null | "budget"> => {
      const existing = projections.get(threadId);
      if (existing) return existing;
      if (projectionReads >= SUPERVISOR_LIFECYCLE_MAX_PROJECTION_READS) return "budget";
      projectionReads++;
      try {
        const value = await this.projection(threadId, signal);
        if (value.thread.id !== threadId) return null;
        projections.set(threadId, value);
        return value;
      } catch (cause) {
        if (cause instanceof T3TransportError && cause.httpStatus === 404) return null;
        throw cause;
      }
    };
    let incomplete = false;
    for (const child of refreshCandidates) {
      if (signal.aborted) throw new Error("child_lifecycle_observation_aborted");
      const parentId = child.lineage.parentThreadId;
      if (!parentId) return {blocked: true, version: fingerprint(["child_parent_missing", child.id]), threadIds: [...scope.allowedIds]};
      let parentProjection = projections.get(parentId) ?? null;
      if (!parentProjection) {
        const read = await readProjection(parentId);
        if (read === "budget") {incomplete = true;break;}
        parentProjection = read;
      }
      if (!parentProjection) return {blocked: true, version: fingerprint(["parent_projection_unavailable", child.id]), threadIds: [...scope.allowedIds]};
      const parentInfo = scope.byId.get(parentId);
      if (parentProjection.thread.id !== parentId || !parentInfo || parentId !== binding.mainThreadId && (parentProjection.thread.lineage.relationshipToParent !== "subagent" ||
        parentProjection.thread.lineage.parentThreadId !== parentInfo.lineage.parentThreadId))
        return {blocked: true, version: fingerprint(["parent_lineage_mismatch", child.id]), threadIds: [...scope.allowedIds]};
      const parentRecord = directParentChildLifecycle(parentProjection, child.id);
      let childProjection: Projection | null = null;
      if (!child.deletedAt) {
        const read = await readProjection(child.id);
        if (read === "budget") {incomplete = true;break;}
        childProjection = read;
      }
      if (!childProjection && !child.deletedAt && !child.archivedAt)
        return {blocked: true, version: fingerprint(["child_projection_unavailable", child.id]), threadIds: [...scope.allowedIds]};
      if (childProjection && (childProjection.thread.id !== child.id || childProjection.thread.lineage.relationshipToParent !== "subagent" ||
        childProjection.thread.lineage.parentThreadId !== parentId))
        return {blocked: true, version: fingerprint(["child_scope_mismatch", child.id]), threadIds: [...scope.allowedIds]};
      if (childProjection) projections.set(child.id, childProjection);
      if (childProjection && (projectionNeedsAttention(childProjection, childProjection.thread) || activeDetachedChildWork(childProjection)))
        return {blocked: true, version: fingerprint([child.id, activityVersion(childProjection), parentRecord?.status ?? null]), threadIds: [...scope.allowedIds]};

      const origin = childOrigin(child, parentProjection ?? undefined);
      const lifecycle = origin === "native_child"
        ? parentRecord ? normalizeLifecycle(parentRecord.status) : {lifecycle: "unknown" as const, detail: null}
        : origin === "delegated_child" && childProjection
          ? delegatedLifecycle(childProjection.thread, childProjection)
          : {lifecycle: "unknown" as const, detail: null};
      if (lifecycle.lifecycle === "running" || parentRecord && normalizeLifecycle(parentRecord.status).lifecycle === "running")
        return {blocked: true, version: fingerprint([child.id, activityVersion(childProjection ?? {thread: child, runs: [], messages: []}), parentRecord?.status ?? null]), threadIds: [...scope.allowedIds]};
      const parentVersion = activityVersion(parentProjection);
      const childVersion = activityVersion(childProjection ?? {thread: child, runs: [], messages: []});
      const resultVersion = fingerprint([child.id, childVersion, parentRecord?.status ?? null, parentVersion]);
      this.rememberChildObservation(this.childObservationKey(binding, child.id), {childShellVersion: lifecycleShellVersion(child),
        parentShellVersion: lifecycleShellVersion(parentInfo), parentProjectionVersion: parentVersion, resultVersion});
      observed.set(child.id, [child.id, resultVersion]);
      scanned++;
    }
    if (children.length) this.rememberScanOffset(scopeKey, (start + Math.max(1, scanned)) % children.length);
    const allObserved = children.every(child => observed.has(child.id));
    const orderedVersion = children.map(child => observed.get(child.id) ?? [child.id, "not-yet-observed"]);
    return {blocked: incomplete || !allObserved, version: fingerprint(orderedVersion), threadIds: [...scope.allowedIds]};
  }

  async check(input: BindingRecord, threads: readonly ThreadInfo[], signal: AbortSignal, now = Date.now()): Promise<void> {
    let binding = this.store.binding(input.projectId, input.mainThreadId);
    if (!binding || binding.threadId !== input.threadId || binding.state !== "ready" || !this.rpc) return;
    let supervisor: Projection;
    try {supervisor = await this.projection(binding.threadId, signal);}
    catch {this.clearQuiet(binding, "supervisor_unreadable");return;}
    if (supervisor.thread.id !== binding.threadId || supervisor.thread.projectId !== binding.projectId || supervisor.thread.archivedAt || supervisor.thread.deletedAt) return;
    const stopped = this.conversation.supervisionStopped(binding.mainThreadId);
    if (!stopped && binding.stopObservedAt !== undefined) {
      binding = {...binding};delete binding.stopObservedAt;this.store.setBinding(binding);
    }
    if (!stopped && supervisor.thread.settledOverride === "active" && !binding.manualKeepActive) {
      binding = {...binding, manualKeepActive: true};this.store.setBinding(binding);
    }
    if (supervisor.thread.settledAt || supervisor.thread.settledOverride === "settled") {
      if (binding.settlement && binding.settlement.state !== "settled") this.store.setBinding({...binding, settlement: {...binding.settlement, state: "settled"}});
      return;
    }
    if (stopped) {await this.settleStopped(binding, supervisor, signal, now);return;}
    const supervisorAttention = this.mainAttention(binding, supervisor, null, true);
    if (supervisorAttention) {this.clearQuiet(binding, supervisorAttention);return;}
    let main: Projection | null;
    try {main = await this.readMain(binding, signal);}
    catch {this.clearQuiet(binding, "main_unreadable");return;}
    const closedMain = !main || Boolean(main.thread.archivedAt || main.thread.deletedAt);
    const source = threads.find(thread => thread.id === input.mainThreadId && thread.projectId === input.projectId);
    const attention = this.mainAttention(binding, supervisor, main, closedMain, source);
    if (attention) {this.clearQuiet(binding, attention);return;}
    const scope = this.scopeFor(binding, main, threads);
    if (main && !main.thread.deletedAt && (!scope || !scope.complete || !scope.main || !scope.allowedIds.has(scope.main.id))) {
      this.clearQuiet(binding, "scope_incomplete");return;
    }
    const threadIds = scope ? [...scope.allowedIds] : [binding.mainThreadId];
    const monitorPending = this.conversation.monitor.hasPendingReviewableActivity(binding.projectId, threadIds);
    const workflowAttention = this.workflowAttention(binding, threadIds);
    if (monitorPending.status !== "complete" || this.awaitsReview(binding) && monitorPending.pending) {this.clearQuiet(binding, "pending_activity");return;}
    if (workflowAttention.blocked) {this.clearQuiet(binding, "workflow_attention");return;}
    let childScopes: {blocked: boolean; version: string; threadIds: string[]};
    try {childScopes = await this.relatedChildren(binding, main, threads, scope, signal);}
    catch {this.clearQuiet(binding, "children_unreadable");return;}
    if (childScopes.blocked) {this.clearQuiet(binding, "children_active");return;}
    const version = fingerprint({main: main ? activityVersion(main) : "missing", supervisor: activityVersion(supervisor), children: childScopes.version,
      workflows: workflowAttention.version});
    if (binding.settlement && ["pending", "uncertain"].includes(binding.settlement.state) && binding.settlement.activityVersion !== version) {
      this.store.setBinding({...binding, quietSince: null, settlement: {...binding.settlement, state: "superseded"}});return;
    }
    if (binding.settlement?.state === "uncertain" && ((binding.settlement.attempts ?? 0) >= 3 || now - binding.settlement.observedAt < SUPERVISOR_SETTLE_QUIET_MS)) return;
    if (binding.quietFingerprint !== version || binding.quietSince == null) {
      this.store.setBinding({...binding, quietFingerprint: version, quietSince: now, settlementBlockedBy: "quiet_window"});return;
    }
    if (now - binding.quietSince < SUPERVISOR_SETTLE_QUIET_MS) return;
    // recheck both chats immediately before the native effect; native settlement rejects busy Supervisors
    let freshMain: Projection | null;
    try {freshMain = await this.readMain(binding, signal);}
    catch {this.clearQuiet(binding, "main_unreadable");return;}
    try {supervisor = await this.projection(binding.threadId, signal);}
    catch {this.clearQuiet(binding, "supervisor_unreadable");return;}
    if (supervisor.thread.id !== binding.threadId || supervisor.thread.projectId !== binding.projectId || supervisor.thread.archivedAt || supervisor.thread.deletedAt) {this.clearQuiet(binding, "supervisor_unavailable");return;}
    const freshClosedMain = !freshMain || Boolean(freshMain.thread.archivedAt || freshMain.thread.deletedAt);
    const freshAttention = this.mainAttention(binding, supervisor, freshMain, freshClosedMain, source);
    if (freshAttention) {this.clearQuiet(binding, freshAttention);return;}
    const freshScope = this.scopeFor(binding, freshMain, threads);
    if (freshMain && !freshMain.thread.deletedAt && (!freshScope || !freshScope.complete || !freshScope.main || !freshScope.allowedIds.has(freshScope.main.id))) {
      this.clearQuiet(binding, "scope_incomplete");return;
    }
    const freshThreadIds = freshScope ? [...freshScope.allowedIds] : [binding.mainThreadId];
    const freshMonitorPending = this.conversation.monitor.hasPendingReviewableActivity(binding.projectId, freshThreadIds);
    const freshWorkflowAttention = this.workflowAttention(binding, freshThreadIds);
    if (freshMonitorPending.status !== "complete" || this.awaitsReview(binding) && freshMonitorPending.pending) {this.clearQuiet(binding, "pending_activity");return;}
    if (freshWorkflowAttention.blocked) {this.clearQuiet(binding, "workflow_attention");return;}
    let freshChildren: {blocked: boolean; version: string; threadIds: string[]};
    try {freshChildren = await this.relatedChildren(binding, freshMain, threads, freshScope, signal);}
    catch {this.clearQuiet(binding, "children_unreadable");return;}
    if (freshClosedMain !== closedMain || freshChildren.blocked ||
      fingerprint({main: freshMain ? activityVersion(freshMain) : "missing", supervisor: activityVersion(supervisor), children: freshChildren.version,
        workflows: freshWorkflowAttention.version}) !== version ||
      freshMain && projectionNeedsAttention(freshMain, source ?? freshMain.thread)) {
      this.clearQuiet(binding, "activity_changed");return;
    }
    binding = this.store.binding(binding.projectId, binding.mainThreadId)!;
    if (!closedMain && this.conversation.hasInflight(binding.projectId, binding.threadId)) return;
    await this.sendSettlement(binding, version, now, signal);
  }
  /** Gates that still hold a stopped chat's own Supervisor: only a keep-active choice made after the stop, and unreconciled native work. */
  private stoppedAttention(binding: BindingRecord, supervisor: Projection, stoppedAt: number): string | null {
    if (userKeepsSupervisorActiveSince(supervisor.thread, stoppedAt)) return "keep_active";
    if (this.store.modelState(binding).pending) return "model_change_pending";
    if (projectionNeedsAttention(supervisor)) return "supervisor_busy";
    if (this.conversation.teamRuntime?.hasInflightEffects(binding)) return "team_effect_unresolved";
    // an interpretation T3 accepted, or may have accepted, can still start a Supervisor run
    if (this.store.tasksFor(binding).some(task => ["dispatching", "waiting", "uncertain"].includes(task.status))) return "stopped_interpretation_unresolved";
    return null;
  }
  /**
   * A chat whose supervision a human stopped: its owned Supervisor settles after the quiet window once idle and once every
   * accepted request has a confirmed native outcome. The stop supersedes earlier keep-active choices for that Supervisor; a stop without a
   * recorded time dates from its first observation. Uncertain identities are retained, and the operative main is never settled or interrupted.
   */
  private async settleStopped(binding: BindingRecord, supervisor: Projection, signal: AbortSignal, now: number): Promise<void> {
    let stoppedAt = binding.supervisionStop?.stoppedAt ?? binding.stopObservedAt;
    if (stoppedAt === undefined) {
      stoppedAt = now;binding = {...binding, stopObservedAt: now};this.store.setBinding(binding);
    }
    const attention = this.stoppedAttention(binding, supervisor, stoppedAt);
    if (attention) {this.clearQuiet(binding, attention);return;}
    // an accepted delivery without a confirmed native outcome can still start a run, so it holds the Supervisor; elapsed time never resolves it
    if (this.conversation.requests.pending(binding.projectId, binding.threadId)) {this.clearQuiet(binding, "stopped_request_unresolved");return;}
    const version = fingerprint({stopped: true, supervisor: activityVersion(supervisor)});
    if (binding.settlement && ["pending", "uncertain"].includes(binding.settlement.state) && binding.settlement.activityVersion !== version) {
      this.store.setBinding({...binding, quietSince: null, settlement: {...binding.settlement, state: "superseded"}});return;
    }
    if (binding.settlement?.state === "uncertain" && ((binding.settlement.attempts ?? 0) >= 3 || now - binding.settlement.observedAt < SUPERVISOR_SETTLE_QUIET_MS)) return;
    if (binding.quietFingerprint !== version || binding.quietSince == null) {
      this.store.setBinding({...binding, quietFingerprint: version, quietSince: now, settlementBlockedBy: "quiet_window"});return;
    }
    if (now - binding.quietSince < SUPERVISOR_SETTLE_QUIET_MS) return;
    let fresh: Projection;
    try {fresh = await this.projection(binding.threadId, signal);} catch {this.clearQuiet(binding, "supervisor_unreadable");return;}
    if (fresh.thread.id !== binding.threadId || fresh.thread.projectId !== binding.projectId || fresh.thread.archivedAt || fresh.thread.deletedAt) {this.clearQuiet(binding, "supervisor_unavailable");return;}
    const freshAttention = this.stoppedAttention(binding, fresh, stoppedAt);
    if (freshAttention) {this.clearQuiet(binding, freshAttention);return;}
    if (fingerprint({stopped: true, supervisor: activityVersion(fresh)}) !== version) {this.clearQuiet(binding, "activity_changed");return;}
    await this.sendSettlement(this.store.binding(binding.projectId, binding.mainThreadId)!, version, now, signal);
  }
  private async sendSettlement(binding: BindingRecord, version: string, now: number, signal: AbortSignal): Promise<void> {
    if (!this.rpc) return;
    const settlement = binding.settlement && ["pending", "uncertain"].includes(binding.settlement.state) ? binding.settlement : {commandId: `supervisor-settle:${randomUUID()}`, state: "pending" as const, observedAt: now, activityVersion: version, attempts: 0};
    const sending = {...settlement, attempts: (settlement.attempts ?? 0) + 1, observedAt: now};
    this.store.setBinding({...binding, settlement: sending});
    try {
      const receipt = await this.rpc("orchestration.dispatchCommand", {type: "thread.settle", commandId: settlement.commandId, threadId: binding.threadId}, signal);
      if (!record(receipt) || !Number.isSafeInteger(receipt.sequence)) throw new SupervisorRpcError("uncertain");
      this.store.setBinding({...binding, settlementBlockedBy: null, settlement: {...sending, state: "settled"}});
      const current = await this.projection(binding.threadId, signal);
      this.store.setBinding({...binding, settlementBlockedBy: null, settlement: {...sending, state: current.thread.settledAt || current.thread.settledOverride === "settled" ? "settled" : "superseded"}});
    } catch (cause) {
      if (cause instanceof SupervisorRpcError && cause.definiteRejection) this.store.setBinding({...binding, quietSince: null, settlement: {...sending, state: "superseded"}});
      else if (this.store.binding(binding.projectId, binding.mainThreadId)?.settlement?.state !== "settled") this.store.setBinding({...binding, settlement: {...sending, state: "uncertain"}});
    }
  }
  private clearQuiet(binding: BindingRecord, blockedBy: string): void {
    const next = {...binding, quietSince: null, settlementBlockedBy: blockedBy};delete next.quietFingerprint;
    if (next.settlement?.state !== "uncertain") delete next.settlement;
    this.store.setBinding(next);
  }
}
