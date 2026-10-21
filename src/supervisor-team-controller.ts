import type {SupervisorConversationStore} from "./supervisor-conversation-store.js";
import {isRecord, workflowRequestHash, workflowToolInputSize, workflowToolInputMaxBytes} from "./workflow-write-evidence.js";
import {WorkflowWriteController, type WorkflowLocator} from "./workflow-write-controller.js";
import {resolveSupervisorScope} from "./supervisor-scope.js";
import {modelSelection, SupervisorRpcError, type SupervisorRpc} from "./supervisor-native.js";
import {canSupervisorContact, hasPendingOwnerInput, resolveSteerableRun} from "./supervisor-conversation.js";
import {childOrigin} from "./supervisor-observation.js";
import type {BindingRecord} from "./project-supervisor-store.js";
import {endedWithoutCompletion, maxHandoverReviewChain, parseHandoverReview, type HandoverReviewInput, type SupervisorTeamStore} from "./supervisor-team-store.js";
import {attributesHelperDelivery} from "./supervisor-helper-transport.js";
import {teamNotificationEvidence, teamNotificationText} from "./supervisor-team-runtime.js";
import type {Projection, ThreadInfo} from "./types.js";

const locator = {
  supervisorThreadId: {type: "string", minLength: 1, maxLength: 512},
  bindingGeneration: {type: "integer", minimum: 1},
  memberEpoch: {type: "integer", minimum: 1},
  assignmentRootThreadId: {type: "string", minLength: 1, maxLength: 512},
  assignmentEpoch: {type: "integer", minimum: 1},
};
const text = (maxLength: number) => ({type: "string", minLength: 1, maxLength});
const unresolvedGuideAttentionGraceMs = 60_000;
// native/provider errors can contain input or message bodies. Only these fixed codes
// may escape the review action; do not forward arbitrary Error.message strings.
const handoverReviewErrors = new Set([
  "supervisor_team_notification_missing", "supervisor_team_review_requires_handover", "supervisor_team_notification_attempt_conflict",
  "supervisor_team_notification_run_conflict", "supervisor_team_member_epoch_conflict", "supervisor_team_assignment_epoch_conflict",
  "supervisor_team_notification_identity_conflict", "supervisor_team_review_in_progress", "supervisor_team_review_requires_retry",
  "supervisor_team_review_chain_closed", "supervisor_team_review_chain_conflict", "supervisor_team_invalid_handover_review",
  "supervisor_team_review_operation_conflict", "supervisor_team_notification_capacity", "supervisor_team_event_capacity",
  "supervisor_team_review_native_unavailable", "supervisor_team_review_native_completed", "supervisor_team_review_native_changed",
]);
export const supervisionTeamToolDefinition = {
  name: "supervision_team",
  description: "Read this root's flat Supervisor team. Root registers actual completed native delegate_task children, assigns or releases operational subtrees, retires or quarantines helpers, sends notes, reviews interrupted handovers with review_handover, and retries only definite failed deliveries. review_handover requires notificationId, expectedDeliveryAttempt, expectedRunId and the exact ordered expectedChain of open attempts; optional note is bounded untrusted plain text. Helpers acknowledge readiness and report significant assessments/escalations. All mutations require exact native caller proof; IDs and transport credentials alone grant no authority. Later helper check-ins are service-managed, not raw t3_thread_send.",
  inputSchema: {type: "object", additionalProperties: false, required: ["supervisorThreadId", "bindingGeneration", "action"], properties: {
    ...locator, action: {type: "string", enum: ["read", "register", "assign", "release", "retire", "quarantine", "note", "retry", "ready", "report", "review_handover"]},
    operationId: text(128), memberThreadId: text(512), taskId: text(512), bootstrapRunId: text(512),
    notificationId: text(512), expectedDeliveryAttempt: {type: "integer", minimum: 0}, expectedRunId: text(512), note: text(1000),
    expectedChain: {type: "array", minItems: 1, maxItems: maxHandoverReviewChain, items: {type: "object", additionalProperties: false,
      required: ["notificationId", "deliveryAttempt", "runId"], properties: {notificationId: text(512), deliveryAttempt: {type: "integer", minimum: 0}, runId: text(512)}}},
    targetThreadId: text(512), summary: text(4000), reportKind: {type: "string", enum: ["assessment", "escalation", "group_result"]},
  }},
} as const;
export const supervisionGuideToolDefinition = {
  name: "supervision_guide",
  description: "Guide an operational child within your CURRENT assigned subtree through the Supervisor service. Fresh native ownership, pending-input and running-turn checks apply. Only targeted steer is used on delegated children. After T3's specific dispatch-command failure, the service retries the exact command once with the same IDs, target and run to read its durable result. Only a definite rejection permits a fresh read and one steer to the nearest contactable ancestor in the same assignment; cross-assignment or unavailable routes escalate to the root. Accepted or uncertain sends keep their original route and identities; never retry via t3_thread_send or change route.",
  inputSchema: {type: "object", additionalProperties: false,
    required: ["supervisorThreadId", "bindingGeneration", "operationId", "targetThreadId", "text"],
    properties: {...locator, operationId: text(128), targetThreadId: text(512), text: text(12000)}},
} as const;

type Payload = WorkflowLocator & Record<string, unknown>;
type GuideAttempt = {
  routedThreadId: string;
  commandId: string;
  messageId: string;
  targetRunId: string;
  status: "prepared" | "replaying" | "accepted" | "uncertain" | "rejected" | "not_sent" | "delivered";
  dispatchFailureReplayAttempted?: boolean;
  reason?: string;
};
type GuideRecord = {
  status: "prepared" | "replaying" | "needs_fallback" | "needs_escalation" | "accepted" | "uncertain" | "not_sent" | "delivered" | "denied" | "escalated";
  targetThreadId: string;
  supervisorThreadId: string;
  bindingGeneration: number;
  memberEpoch: number;
  assignmentRootThreadId: string;
  assignmentEpoch: number;
  operationId: string;
  routedThreadId: string;
  commandId: string;
  messageId: string;
  requestId: string;
  targetRunId: string;
  text: string;
  attempts: GuideAttempt[];
  escalationSummary?: string;
  reason?: string;
};
type GuideRouteSearch = {route: Projection | null; parents: ReadonlyMap<string, string | null>; reason: string | null; freshScope: boolean};
const fail = (reason: string) => ({status: "denied", reason});
const id = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512;
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const parentMap = (threads: readonly ThreadInfo[]) => new Map(threads.map(thread => [thread.id, thread.lineage.parentThreadId]));

/** Mediates team changes and guidance using the existing private database and native proof. */
export class SupervisorTeamController {
  private readonly reconcileOffsets = new Map<string, number>();
  constructor(readonly workflows: WorkflowWriteController, readonly team: SupervisorTeamStore, readonly rpc: SupervisorRpc | null, readonly requests?: SupervisorConversationStore) {
    workflows.options.supervisors.store.db.exec(`CREATE TABLE IF NOT EXISTS supervisor_team_tool_receipts(
      owner_thread_id TEXT NOT NULL,actor_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,actor_epoch INTEGER NOT NULL,operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,evidence_item_id TEXT NOT NULL,document TEXT NOT NULL,
      PRIMARY KEY(owner_thread_id,actor_thread_id,binding_generation,actor_epoch,operation_id));`);
  }
  private parse(input: unknown, allowed: readonly string[]): Payload | null {
    if (!isRecord(input) || Object.keys(input).some(key => ![...Object.keys(locator), ...allowed].includes(key)) ||
      !id(input.supervisorThreadId) || !Number.isSafeInteger(input.bindingGeneration) || Number(input.bindingGeneration) < 1) return null;
    try {if (workflowToolInputSize(input) > workflowToolInputMaxBytes) return null;} catch {return null;}
    for (const field of ["memberEpoch", "assignmentEpoch"]) if (input[field] !== undefined &&
      (!Number.isSafeInteger(input[field]) || Number(input[field]) < 1)) return null;
    if (input.assignmentRootThreadId !== undefined && !id(input.assignmentRootThreadId)) return null;
    return input as Payload;
  }
  private receipt(payload: Payload, binding: BindingRecord): {hash: string; value: Record<string, unknown>} | null {
    const row = this.workflows.options.supervisors.store.db.prepare("SELECT request_hash,document FROM supervisor_team_tool_receipts WHERE owner_thread_id=? AND actor_thread_id=? AND binding_generation=? AND actor_epoch=? AND operation_id=?")
      .get(binding.threadId, payload.supervisorThreadId, payload.bindingGeneration, payload.memberEpoch ?? 0, String(payload.operationId));
    return row ? {hash: String(row.request_hash), value: JSON.parse(String(row.document)) as Record<string, unknown>} : null;
  }
  private save(payload: Payload, binding: BindingRecord, evidenceItemId: string, result: unknown): void {
    this.workflows.options.supervisors.store.db.prepare(`INSERT INTO supervisor_team_tool_receipts VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_thread_id,actor_thread_id,binding_generation,actor_epoch,operation_id) DO UPDATE SET document=excluded.document`)
      .run(binding.threadId, payload.supervisorThreadId, payload.bindingGeneration, payload.memberEpoch ?? 0, String(payload.operationId), workflowRequestHash(payload), evidenceItemId, JSON.stringify(result));
  }
  private atomic<A>(work: () => A): A {
    const store = this.workflows.options.supervisors.store;
    return store.db.isTransaction ? work() : store.transaction(work);
  }
  private current(payload: Payload, binding: BindingRecord, allowRegistering = false): boolean {
    const latest = this.workflows.resolveBinding(payload, allowRegistering);
    return latest?.threadId === binding.threadId && latest.generation === binding.generation;
  }
  async call(input: unknown, signal: AbortSignal): Promise<unknown> {
    const payload = this.parse(input, ["action", "operationId", "memberThreadId", "taskId", "bootstrapRunId", "targetThreadId", "summary", "reportKind",
      "notificationId", "expectedDeliveryAttempt", "expectedRunId", "expectedChain", "note"]);
    if (!payload || typeof payload.action !== "string") return {status: "invalid", reason: "invalid_team_arguments"};
    if (payload.action !== "read" && !bounded(payload.operationId, 128)) return {status: "invalid", reason: "operation_id_required"};
    const reviewInput = payload.action === "review_handover" ? parseHandoverReview(payload) : null;
    if (payload.action === "review_handover" && !reviewInput) return fail("supervisor_team_invalid_handover_review");
    // reading the team stays possible after a human stop; every other action is an effect fenced by the stop
    const binding = this.workflows.resolveBinding(payload, payload.action === "ready", payload.action === "read" ? "read" : "effect");
    if (!binding && payload.action === "ready" && typeof payload.memberEpoch === "number") {
      const current = this.workflows.resolveBinding({...payload, memberEpoch: payload.memberEpoch + 1});
      const member = current && this.team.snapshot(current).members.find(item => item.threadId === payload.supervisorThreadId);
      if (current && member?.state === "ready" && member.epoch === payload.memberEpoch + 1) {
        const receipt = this.receipt(payload, current);
        if (receipt?.hash === workflowRequestHash(payload)) return receipt.value;
      }
    }
    if (!binding) return fail("actor_not_current_ready_enabled");
    if (payload.action === "read") return {status: "ok", team: this.team.snapshot(binding)};
    const proof = await this.workflows.authorizeNative(payload, "team", signal, payload.action === "ready");
    if (proof.status !== "verified") return payload.action === "review_handover" ? fail("native_root_proof_required") : proof;
    const prior = this.receipt(payload, binding);
    if (prior) return prior.hash === workflowRequestHash(payload) ? prior.value : fail("operation_id_conflict");
    const root = payload.supervisorThreadId === binding.threadId;
    if (!root && !["ready", "report"].includes(payload.action)) return fail("root_authority_required");
    try {
      const threads = await this.workflows.options.native.listThreads(signal);
      const scope = resolveSupervisorScope(threads, binding.projectId, binding.mainThreadId, this.workflows.options.supervisors.ownedIds);
      if (!scope.complete || !scope.main || !scope.liveIds.has(binding.mainThreadId)) return fail("native_scope_unavailable");
      if (payload.action === "register") await this.verifyMember(binding, payload, signal);
      if (reviewInput) await this.verifyHandoverReview(binding, reviewInput, signal);
      if (["assign", "release", "report"].includes(payload.action) &&
        (!id(payload.targetThreadId) || payload.targetThreadId === binding.mainThreadId || !scope.liveIds.has(payload.targetThreadId)))
        return fail("target_not_live_operational_descendant");
      return this.atomic(() => {
        if (!this.current(payload, binding, payload.action === "ready")) return fail("actor_changed");
        const concurrent = this.receipt(payload, binding);
        if (concurrent) return concurrent.hash === workflowRequestHash(payload) ? concurrent.value : fail("operation_id_conflict");
        let result: unknown;
        if (reviewInput) {
          result = this.team.reviewHandover(binding, payload.supervisorThreadId, reviewInput);
        } else if (payload.action === "register") {
          if (!id(payload.memberThreadId) || !id(payload.taskId) || !id(payload.bootstrapRunId)) return fail("invalid_registration");
          result = this.team.registerMember(binding, {threadId: payload.memberThreadId, taskId: payload.taskId, bootstrapRunId: payload.bootstrapRunId});
        } else if (payload.action === "ready") {
          if (root || typeof payload.memberEpoch !== "number") return fail("registered_helper_required");
          result = this.team.markReady(binding, payload.supervisorThreadId, payload.memberEpoch);
        } else if (payload.action === "assign" || payload.action === "release") {
          if (payload.action === "assign" && !id(payload.memberThreadId)) return fail("member_required");
          result = this.team.assign(binding, String(payload.targetThreadId), payload.action === "release" ? null : String(payload.memberThreadId), parentMap(threads));
        } else if (payload.action === "retire") {
          if (!id(payload.memberThreadId)) return fail("member_required");
          result = this.team.retireMember(binding, payload.memberThreadId);
        } else if (payload.action === "quarantine") {
          if (!root || !id(payload.memberThreadId)) return fail("root_authority_required");
          result = this.team.quarantineMember(binding, payload.memberThreadId);
        } else if (payload.action === "retry") {
          if (!id(payload.memberThreadId)) return fail("member_required");
          const pendingRequestsRemain = this.team.unresolvedRequests(binding).some(item => item.memberThreadId === payload.memberThreadId);
          const failed = pendingRequestsRemain ? [] :
            this.requests?.requests(binding.projectId, payload.memberThreadId).filter(item => item.state === "failed" && !item.failureAcknowledged) ?? [];
          if (this.requests) for (const request of failed) this.requests.saveRequest({...request, failureAcknowledged: true});
          const retriedNotifications = this.team.retryFailedNotifications(binding, payload.memberThreadId);
          result = {acknowledgedFailures: failed.length, retriedNotifications, pendingRequestsRemain};
        } else if (payload.action === "note") {
          if (!id(payload.memberThreadId) || !bounded(payload.summary, 4000)) return fail("member_and_summary_required");
          const member = this.team.snapshot(binding).members.find(item => item.threadId === payload.memberThreadId);
          if (!member) return fail("member_required");
          result = this.team.note(binding, {eventId: `note:${payload.operationId}`, notificationId: `note:${payload.operationId}`,
            memberThreadId: payload.memberThreadId, memberEpoch: member.epoch, message: payload.summary});
        } else if (payload.action === "report") {
          if (root || !bounded(payload.summary, 4000) || !["assessment", "escalation", "group_result"].includes(String(payload.reportKind)) ||
            !this.team.authorizeWrite(binding, payload.supervisorThreadId, String(payload.targetThreadId), parentMap(threads), payload))
            return fail("report_outside_current_assignment");
          const report = {eventId: `report:${payload.supervisorThreadId}:${payload.operationId}`, actorThreadId: payload.supervisorThreadId,
            memberEpoch: payload.memberEpoch!, targets: [{targetThreadId: String(payload.targetThreadId),
              assignmentRootThreadId: payload.assignmentRootThreadId!, assignmentEpoch: payload.assignmentEpoch!}],
            summary: payload.summary, parentById: parentMap(threads), ...(payload.reportKind === "group_result" ? {severity: "result" as const} : {})};
          result = payload.reportKind === "escalation" ? this.team.escalate(binding, report) : this.team.assessment(binding, report);
        } else return {status: "invalid", reason: "unknown_team_action"};
        const response = {status: "ok", result, team: this.team.snapshot(binding)};
        this.save(payload, binding, proof.evidence.itemId, response);
        return response;
      });
    } catch (cause) {
      if (payload.action === "review_handover") return fail(cause instanceof Error && handoverReviewErrors.has(cause.message)
        ? cause.message : "supervisor_team_review_native_unavailable");
      return fail(cause instanceof Error && /^[a-z_]+$/u.test(cause.message) ? cause.message : "team_operation_unavailable");
    }
  }
  private async verifyHandoverReview(binding: BindingRecord, input: HandoverReviewInput, signal: AbortSignal): Promise<void> {
    const {original, chain} = this.team.handoverReviewContext(binding, input);
    const projection = await this.workflows.options.native.projection(original.recipientThreadId, signal);
    if (signal.aborted || projection.thread.id !== original.recipientThreadId || projection.thread.projectId !== binding.projectId ||
      projection.thread.lineage.parentThreadId !== binding.threadId || projection.thread.lineage.relationshipToParent !== "subagent" ||
      projection.thread.archivedAt != null || projection.thread.deletedAt != null) throw new Error("supervisor_team_review_native_unavailable");
    for (const notification of chain) {
      const {marker} = teamNotificationText(binding, notification);
      // read only the existing transport receipt. No channel creation, POST or native
      // mutation is permitted here. Its exact sent bytes + owned scheduled task identify
      // the delivery; regenerated text would not survive a later wording change.
      const row = this.workflows.options.supervisors.store.db.prepare(
        "SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
        .get(binding.threadId, binding.generation, `supervisor-team-notice:${notification.id}:attempt:${notification.deliveryAttempt}`);
      const delivery: unknown = row && JSON.parse(String(row.document));
      if (!isRecord(delivery) || delivery.state === "rejected") throw new Error("supervisor_team_review_native_unavailable");
      const sentText = delivery.text;
      const helperThreadId = delivery.threadId;
      const taskId = delivery.taskId;
      if (typeof sentText !== "string" || helperThreadId !== notification.recipientThreadId || !id(taskId)) throw new Error("supervisor_team_review_native_unavailable");
      // the same attribution predicate as check-ins: exact frame or bound rendering, never a second copy of the matcher
      const evidence = teamNotificationEvidence(projection, notification, marker, message => attributesHelperDelivery({
        state: String(delivery.state), text: sentText, threadId: notification.recipientThreadId, taskId,
        nativeDeliveryId: delivery.nativeDeliveryId, renderedText: delivery.renderedText, nativeMessageId: delivery.nativeMessageId,
      }, message, projection.messages));
      if (evidence.completedRun) throw new Error("supervisor_team_review_native_completed");
      const run = evidence.runs.find(value => value.id === notification.observedRun?.runId);
      if (!evidence.message || !run || run.status !== notification.observedRun?.status || !endedWithoutCompletion.has(run.status) ||
        evidence.runs.some(value => !endedWithoutCompletion.has(value.status))) throw new Error("supervisor_team_review_native_changed");
    }
  }

  /**
   * Guidance receipts of a stopped chat, observation only: a delivered steer settles, and a rejected attempt awaiting a fallback
   * or escalation is closed as not sent because a stop never sends another route. An unknown send keeps its identities.
   */
  reconcileStopped(binding: BindingRecord, signal: AbortSignal): Promise<void> {return this.reconcile(binding, signal, Date.now(), true);}
  async reconcile(binding: BindingRecord, signal: AbortSignal, now = Date.now(), stopped = false): Promise<void> {
    const members = this.team.snapshot(binding).members;
    const actors = new Set(members.map(member => member.threadId));
    const rows = this.workflows.options.supervisors.store.db.prepare("SELECT actor_thread_id,actor_epoch,operation_id,evidence_item_id,document FROM supervisor_team_tool_receipts WHERE owner_thread_id=? AND binding_generation=? AND json_extract(document,'$.requestId') LIKE 'guide:%' AND json_extract(document,'$.status') IN ('prepared','replaying','needs_fallback','needs_escalation','accepted','uncertain') ORDER BY rowid")
      .all(binding.threadId, binding.generation).filter(row => actors.has(String(row.actor_thread_id)));
    const offset = rows.length ? (this.reconcileOffsets.get(binding.threadId) ?? 0) % rows.length : 0;
    this.reconcileOffsets.set(binding.threadId, offset + 4);
    for (const row of [...rows.slice(offset), ...rows.slice(0, offset)].slice(0, 4)) {
      if (signal.aborted) return;
      const value = JSON.parse(String(row.document)) as GuideRecord;
      try {
        const payload = this.guidePayload(value);
        if (stopped && (value.status === "needs_fallback" || value.status === "needs_escalation")) {
          this.atomic(() => {
            this.workflows.options.supervisors.store.db.prepare("UPDATE supervisor_team_tool_receipts SET document=? WHERE owner_thread_id=? AND actor_thread_id=? AND binding_generation=? AND actor_epoch=? AND operation_id=?")
              .run(JSON.stringify({...value, status: "not_sent"}), binding.threadId, String(row.actor_thread_id), binding.generation, Number(row.actor_epoch), String(row.operation_id));
            if (this.team.unresolvedRequests(binding).some(item => item.requestId === value.requestId)) this.team.setRequestState(binding, binding.threadId, value.requestId, 0, "settled");
          });
          continue;
        }
        if (value.status === "needs_fallback") {
          const result = await this.continueAfterDefiniteRejection(payload, binding, String(row.evidence_item_id), value, signal);
          if (result.status === "needs_fallback" && result.reason === "target_pending_owner_input") {
            const request = this.team.unresolvedRequests(binding).find(item => item.requestId === value.requestId);
            if (!signal.aborted && request && now - request.updatedAt >= unresolvedGuideAttentionGraceMs) this.team.serviceAttention(binding, {
              eventId: `guide-deferred:${value.requestId}`, memberThreadId: String(row.actor_thread_id), targetThreadId: value.targetThreadId,
              summary: `Guidance for ${value.targetThreadId} is deferred for a pending native owner decision. The question has not been answered and no ancestor route has been sent.`}, now);
          }
          continue;
        }
        if (value.status === "needs_escalation") {
          await this.finishRootEscalation(payload, binding, String(row.evidence_item_id), value, value.attempts?.length > 0);
          continue;
        }
        if (!value.routedThreadId || !value.messageId) continue;
        let message: Projection["messages"][number] | undefined;
        try {
          const projection = await this.workflows.options.native.projection(value.routedThreadId, signal);
          message = projection.messages.find(item => item.id === value.messageId && item.threadId === value.routedThreadId && item.text === value.text &&
            item.createdBy === "user" && item.creationSource === "server");
        } catch { /* native uncertainty retains the original route and identities */ }
        if (message) {
          this.atomic(() => {
            const result = {...value, status: "delivered" as const};
            this.workflows.options.supervisors.store.db.prepare("UPDATE supervisor_team_tool_receipts SET document=? WHERE owner_thread_id=? AND actor_thread_id=? AND binding_generation=? AND actor_epoch=? AND operation_id=?")
              .run(JSON.stringify(result), binding.threadId, String(row.actor_thread_id), binding.generation, Number(row.actor_epoch), String(row.operation_id));
            this.team.setRequestState(binding, binding.threadId, value.requestId, 0, "settled");
            if (message.runId && message.runId !== value.targetRunId) this.team.serviceAttention(binding, {
              eventId: `late-guide:${value.requestId}`, memberThreadId: String(row.actor_thread_id), targetThreadId: value.targetThreadId,
              summary: `The native steer reached a new run in ${value.routedThreadId} after the targeted run ended. Stop further direct guidance and assess whether its operational parent needs attention.`});
          });
          continue;
        }
        const request = this.team.unresolvedRequests(binding).find(item => item.requestId === value.requestId);
        if (!signal.aborted && request && now - request.updatedAt >= unresolvedGuideAttentionGraceMs) this.team.serviceAttention(binding, {
          eventId: `guide-unresolved:${value.requestId}`, memberThreadId: String(row.actor_thread_id), targetThreadId: value.targetThreadId,
          summary: `A native guidance send to ${value.targetThreadId} remains unresolved after its reconciliation grace period. Its original target and command identities are retained; no alternate route is attempted.`});
      } catch { /* native uncertainty retains the original route and identities */ }
    }
  }
  private async verifyMember(binding: BindingRecord, payload: Payload, signal: AbortSignal): Promise<void> {
    if (!id(payload.memberThreadId) || !id(payload.taskId) || !id(payload.bootstrapRunId)) throw new Error("invalid_registration");
    const root = await this.workflows.options.native.projection(binding.threadId, signal);
    const child = await this.workflows.options.native.projection(payload.memberThreadId, signal);
    const task = root.subagents?.find(item => item.id === payload.taskId && item.origin === "app_owned" &&
      item.threadId === binding.threadId && item.childThreadId === payload.memberThreadId);
    const parentRun = root.runs.find(run => run.id === task?.runId && run.threadId === binding.threadId);
    const bootstrap = child.runs.find(run => run.id === payload.bootstrapRunId && run.threadId === payload.memberThreadId);
    const fork = child.thread.forkedFrom;
    if (root.thread.id !== binding.threadId || child.thread.id !== payload.memberThreadId || child.thread.archivedAt != null || child.thread.deletedAt != null ||
      child.thread.lineage.relationshipToParent !== "subagent" || child.thread.lineage.parentThreadId !== binding.threadId ||
      !isRecord(fork) || fork.type !== "node" || fork.nodeId !== payload.taskId ||
      !task || task.status !== "completed" || task.result == null || !parentRun || parentRun.status === "rolled_back" ||
      !bootstrap || bootstrap.status !== "completed" ||
      child.runs.filter(run => run.threadId === payload.memberThreadId).sort((a, b) => a.ordinal - b.ordinal)[0]?.id !== bootstrap.id ||
      !child.messages.some(message => message.id === bootstrap.userMessageId && message.runId === bootstrap.id && message.text === task.prompt)) throw new Error("native_completed_bootstrap_not_verified");
    this.verifyHelperProviderIsolation(binding, payload, root, child);
  }
  private verifyHelperProviderIsolation(binding: BindingRecord, payload: Payload, root: Projection, child: Projection): void {
    const configuredInstanceId = this.workflows.options.helperProviderInstanceId;
    if (!configuredInstanceId) return;
    const rootSelection = modelSelection(root.thread.modelSelection);
    const childSelection = modelSelection(child.thread.modelSelection);
    const ownProviderThreads = (projection: Projection, ownerThreadId: string) => Array.isArray(projection.providerThreads)
      ? projection.providerThreads.filter(row => isRecord(row) && row.appThreadId === ownerThreadId)
      : [];
    const rootProviderThreads = ownProviderThreads(root, root.thread.id);
    const childProviderThreads = ownProviderThreads(child, child.thread.id);
    const hasSession = (row: Record<string, unknown>): row is Record<string, unknown> & {providerSessionId: string} =>
      typeof row.providerSessionId === "string" && row.providerSessionId.trim().length > 0;
    const rootSessions = new Set(rootProviderThreads.filter(hasSession).map(row => row.providerSessionId));
    const childSessionThreads = childProviderThreads.filter(hasSession);
    const childSessions = new Set(childSessionThreads.map(row => row.providerSessionId));
    const failIsolation = (reason: string): never => {
      const memberThreadId = String(payload.memberThreadId);
      const eventIdentity = workflowRequestHash({supervisorThreadId: binding.threadId, bindingGeneration: binding.generation,
        memberThreadId, taskId: payload.taskId, bootstrapRunId: payload.bootstrapRunId});
      this.team.serviceAttention(binding, {eventId: `helper-provider-isolation:${eventIdentity.slice(0, 32)}`,
        memberThreadId: binding.threadId, targetThreadId: memberThreadId,
        summary: `Helper ${memberThreadId} was not registered because its configured provider isolation could not be verified (${reason}). No helper membership or webhook was created, and no shared-session fallback occurred.`});
      throw new Error(reason);
    };

    if (!rootSelection || rootSelection.instanceId === configuredInstanceId) failIsolation("helper_provider_instance_matches_root");
    if (!childSelection || childSelection.instanceId !== configuredInstanceId ||
      childSessionThreads.some(row => row.providerInstanceId !== configuredInstanceId))
      failIsolation("helper_provider_instance_mismatch");
    if (!rootSessions.size || !childSessions.size) failIsolation("helper_provider_session_unavailable");
    if ([...childSessions].some(sessionId => rootSessions.has(sessionId))) failIsolation("helper_provider_session_shared");
  }
  private guidePayload(record: GuideRecord): Payload {
    return {supervisorThreadId: record.supervisorThreadId, bindingGeneration: record.bindingGeneration, memberEpoch: record.memberEpoch,
      assignmentRootThreadId: record.assignmentRootThreadId, assignmentEpoch: record.assignmentEpoch, operationId: record.operationId,
      targetThreadId: record.targetThreadId, text: record.text};
  }
  private guideRecord(payload: Payload, binding: BindingRecord): GuideRecord {
    const requestId = `guide:${workflowRequestHash(payload)}`;
    return {status: "prepared", targetThreadId: String(payload.targetThreadId), supervisorThreadId: payload.supervisorThreadId,
      bindingGeneration: binding.generation, memberEpoch: Number(payload.memberEpoch), assignmentRootThreadId: String(payload.assignmentRootThreadId),
      assignmentEpoch: Number(payload.assignmentEpoch), operationId: String(payload.operationId), routedThreadId: "", commandId: "", messageId: "",
      requestId, targetRunId: "", text: String(payload.text), attempts: []};
  }
  private async findGuideRoute(binding: BindingRecord, payload: Payload, includeTarget: boolean, signal: AbortSignal): Promise<GuideRouteSearch> {
    const threads = await this.workflows.options.native.listThreads(signal);
    const scope = resolveSupervisorScope(threads, binding.projectId, binding.mainThreadId, this.workflows.options.supervisors.ownedIds);
    const parents = parentMap(threads);
    if (!scope.complete || !scope.main || !scope.liveIds.has(String(payload.targetThreadId)))
      return {route: null, parents, reason: "native_scope_unavailable", freshScope: false};
    if (!this.current(payload, binding) || !this.team.authorizeWrite(binding, payload.supervisorThreadId, String(payload.targetThreadId), parents, payload))
      return {route: null, parents, reason: "guidance_assignment_changed", freshScope: true};
    const actor = await this.workflows.options.native.projection(payload.supervisorThreadId, signal);
    if (actor.thread.id !== payload.supervisorThreadId || actor.thread.archivedAt != null || actor.thread.deletedAt != null || !this.current(payload, binding))
      return {route: null, parents, reason: "helper_identity_changed", freshScope: true};
    const original = scope.byId.get(String(payload.targetThreadId));
    if (!original) return {route: null, parents, reason: "target_lineage_unavailable", freshScope: true};
    const target = await this.workflows.options.native.projection(original.id, signal);
    if (target.thread.id !== original.id || target.thread.lineage.parentThreadId !== original.lineage.parentThreadId ||
      target.thread.lineage.relationshipToParent !== original.lineage.relationshipToParent)
      return {route: null, parents, reason: "target_lineage_changed", freshScope: true};
    if (hasPendingOwnerInput(target)) return {route: null, parents, reason: "target_pending_owner_input", freshScope: true};
    let candidate = includeTarget ? original : original.lineage.parentThreadId ? scope.byId.get(original.lineage.parentThreadId) : undefined;
    while (candidate && candidate.id !== binding.mainThreadId) {
      if (!scope.liveIds.has(candidate.id)) {
        candidate = candidate.lineage.parentThreadId ? scope.byId.get(candidate.lineage.parentThreadId) : undefined;
        continue;
      }
      if (!this.current(payload, binding) || !this.team.authorizeWrite(binding, payload.supervisorThreadId, String(payload.targetThreadId), parents, payload))
        return {route: null, parents, reason: "guidance_assignment_changed", freshScope: true};
      if (!this.team.authorizeWrite(binding, payload.supervisorThreadId, candidate.id, parents, payload))
        return {route: null, parents, reason: "ancestor_outside_current_assignment", freshScope: true};
      const current = candidate.id === original.id ? target : await this.workflows.options.native.projection(candidate.id, signal);
      if (current.thread.id !== candidate.id || current.thread.lineage.parentThreadId !== candidate.lineage.parentThreadId ||
        current.thread.lineage.relationshipToParent !== candidate.lineage.relationshipToParent)
        return {route: null, parents, reason: "target_lineage_changed", freshScope: true};
      if (current.thread.archivedAt == null && current.thread.deletedAt == null && !hasPendingOwnerInput(current)) {
        const parentThread = candidate.lineage.parentThreadId ? scope.byId.get(candidate.lineage.parentThreadId) : undefined;
        const parent = parentThread ? await this.workflows.options.native.projection(parentThread.id, signal) : undefined;
        const run = resolveSteerableRun(current);
        if (childOrigin(current.thread, parent) === "delegated_child" && run &&
          canSupervisorContact(actor.thread, current.thread) && this.current(payload, binding) &&
          this.team.authorizeWrite(binding, payload.supervisorThreadId, String(payload.targetThreadId), parents, payload) &&
          this.team.authorizeWrite(binding, payload.supervisorThreadId, candidate.id, parents, payload)) return {route: current, parents, reason: null, freshScope: true};
      }
      candidate = candidate.lineage.parentThreadId ? scope.byId.get(candidate.lineage.parentThreadId) : undefined;
    }
    return {route: null, parents, reason: "no_contactable_ancestor_in_assignment", freshScope: true};
  }
  private changedAttempt(record: GuideRecord, attemptIndex: number, status: GuideAttempt["status"], reason?: string): GuideRecord {
    const attempts = [...record.attempts];
    const attempt = attempts[attemptIndex];
    if (!attempt) return record;
    attempts[attemptIndex] = {...attempt, status, ...(reason ? {reason} : {})};
    return {...record, attempts, ...(attemptIndex === attempts.length - 1 ? {routedThreadId: attempt.routedThreadId,
      commandId: attempt.commandId, messageId: attempt.messageId, targetRunId: attempt.targetRunId} : {})};
  }
  private guideCommand(attempt: GuideAttempt, textValue: string): Record<string, unknown> {
    return {type: "message.dispatch", commandId: attempt.commandId, messageId: attempt.messageId,
      threadId: attempt.routedThreadId, text: textValue, attachments: [], createdBy: "system", creationSource: "server",
      dispatchMode: {type: "steer_active", targetRunId: attempt.targetRunId}};
  }
  private currentGuide(payload: Payload, binding: BindingRecord): GuideRecord | null {
    const current = this.receipt(payload, binding);
    return current ? current.value as GuideRecord : null;
  }
  private async finishRootEscalation(payload: Payload, binding: BindingRecord, evidenceItemId: string, record: GuideRecord,
    requestRecorded: boolean): Promise<GuideRecord> {
    const summary = record.escalationSummary ??
      `A definite steer rejection left ${record.targetThreadId} without a contactable ancestor in the helper's current assignment. Root intervention is required.`;
    const escalated: GuideRecord = {...record, status: "escalated", escalationSummary: summary, reason: "root_intervention_required"};
    try {
      this.atomic(() => {
        this.team.serviceAttention(binding, {eventId: `guide-service-attention:${record.requestId}`, memberThreadId: record.supervisorThreadId,
          targetThreadId: record.targetThreadId, summary});
        if (requestRecorded) this.team.setRequestState(binding, binding.threadId, record.requestId, 0, "settled");
        this.save(payload, binding, evidenceItemId, escalated);
      });
      return escalated;
    } catch {
      const pending: GuideRecord = {...record, status: "needs_escalation", escalationSummary: summary, reason: "root_attention_recording_unavailable"};
      this.save(payload, binding, evidenceItemId, pending);
      return pending;
    }
  }
  private async continueAfterDefiniteRejection(payload: Payload, binding: BindingRecord, evidenceItemId: string, record: GuideRecord,
    signal: AbortSignal): Promise<GuideRecord> {
    const summary = record.escalationSummary ??
      `A definite steer rejection left ${record.targetThreadId} without a contactable ancestor in the helper's current assignment. Root intervention is required.`;
    try {
      const search = await this.findGuideRoute(binding, payload, false, signal);
      if (search.route && search.reason === null) return this.sendGuideAttempt(payload, binding, evidenceItemId, record, search.route, search.parents, signal);
      if (search.reason === "target_pending_owner_input") {
        const deferred: GuideRecord = {...record, status: "needs_fallback", reason: search.reason};
        this.save(payload, binding, evidenceItemId, deferred);
        return deferred;
      }
      const needsEscalation: GuideRecord = {...record, status: "needs_escalation", escalationSummary: summary,
        reason: search.reason ?? "no_contactable_ancestor_in_assignment"};
      this.save(payload, binding, evidenceItemId, needsEscalation);
      return this.finishRootEscalation(payload, binding, evidenceItemId, needsEscalation, record.attempts.length > 0);
    } catch {
      const needsEscalation: GuideRecord = {...record, status: "needs_escalation", escalationSummary: summary, reason: "ancestor_route_read_unavailable"};
      this.save(payload, binding, evidenceItemId, needsEscalation);
      return this.finishRootEscalation(payload, binding, evidenceItemId, needsEscalation, record.attempts.length > 0);
    }
  }
  private async sendGuideAttempt(payload: Payload, binding: BindingRecord, evidenceItemId: string, record: GuideRecord,
    route: Projection, parents: ReadonlyMap<string, string | null>, signal: AbortSignal): Promise<GuideRecord> {
    const targetRunId = resolveSteerableRun(route)?.id;
    if (typeof targetRunId !== "string" || targetRunId.length === 0) {
      const needsEscalation: GuideRecord = {...record, status: "needs_escalation", escalationSummary:
        `A definite steer rejection left ${record.targetThreadId} without a contactable ancestor in the helper's current assignment. Root intervention is required.`,
      reason: "route_run_unavailable"};
      this.save(payload, binding, evidenceItemId, needsEscalation);
      return this.finishRootEscalation(payload, binding, evidenceItemId, needsEscalation, record.attempts.length > 0);
    }
    const reservation: {record: GuideRecord | null; attemptIndex: number} = {record: null, attemptIndex: -1};
    this.atomic(() => {
      const existing = this.currentGuide(payload, binding);
      const current = existing ?? record;
      const attempts = current.attempts ?? [];
      if (existing && (current.status !== "needs_fallback" || attempts.length !== record.attempts.length)) {
        reservation.record = current;
        return;
      }
      if (!this.current(payload, binding) || !this.team.authorizeWrite(binding, payload.supervisorThreadId, record.targetThreadId, parents, payload) ||
        !this.team.authorizeWrite(binding, payload.supervisorThreadId, route.thread.id, parents, payload)) throw new Error("guidance_assignment_changed");
      reservation.attemptIndex = attempts.length;
      const attempt: GuideAttempt = {routedThreadId: route.thread.id, commandId: `${record.requestId}:command:${reservation.attemptIndex}`,
        messageId: `${record.requestId}:message:${reservation.attemptIndex}`, targetRunId, status: "prepared"};
      reservation.record = {...current, status: "prepared", routedThreadId: attempt.routedThreadId, commandId: attempt.commandId,
        messageId: attempt.messageId, targetRunId: attempt.targetRunId, attempts: [...attempts, attempt]};
      delete reservation.record.reason;
      delete reservation.record.escalationSummary;
      if (attempts.length === 0) {
        const coverage = this.team.coverage(binding, record.targetThreadId, parents);
        this.team.recordRequest(binding, {requestId: record.requestId, memberThreadId: payload.supervisorThreadId,
          memberEpoch: coverage.memberEpoch ?? 0, targets: [{targetThreadId: record.targetThreadId,
            assignmentRootThreadId: coverage.assignmentRootThreadId ?? binding.mainThreadId, assignmentEpoch: coverage.assignmentEpoch ?? 0}], parentById: parents});
      }
      this.save(payload, binding, evidenceItemId, reservation.record);
    });
    const prepared = reservation.record;
    const attemptIndex = reservation.attemptIndex;
    if (!prepared || attemptIndex < 0) return prepared ?? record;
    const attempt = prepared.attempts[attemptIndex]!;
    const command = this.guideCommand(attempt, record.text);
    const acceptedResult = (current: GuideRecord): GuideRecord => {
      const result = {...this.changedAttempt(current, attemptIndex, "accepted"), status: "accepted" as const,
        reason: "Native steer command accepted; late completion can still start a turn. Do not send another route."};
      this.save(payload, binding, evidenceItemId, result);
      return result;
    };
    const rejectedResult = async (current: GuideRecord, cause: unknown): Promise<GuideRecord> => {
      if (cause instanceof SupervisorRpcError && cause.outcome === "rejected" && !cause.definiteRejection) {
        const notSent: GuideRecord = {...this.changedAttempt(current, attemptIndex, "not_sent", "native_transport_not_sent"),
          status: "not_sent", reason: "native_transport_not_sent"};
        this.save(payload, binding, evidenceItemId, notSent);
        this.team.setRequestState(binding, binding.threadId, record.requestId, 0, "settled");
        return notSent;
      }
      const definite = cause instanceof SupervisorRpcError && cause.definiteRejection;
      if (definite && attemptIndex === 0 && attempt.routedThreadId === record.targetThreadId) {
        const rejected = {...this.changedAttempt(current, attemptIndex, "rejected", "native_steer_rejected"), status: "needs_fallback" as const,
          reason: "native_steer_rejected"};
        this.save(payload, binding, evidenceItemId, rejected);
        return this.continueAfterDefiniteRejection(payload, binding, evidenceItemId, rejected, signal);
      }
      if (definite) {
        const needsEscalation: GuideRecord = {...this.changedAttempt(current, attemptIndex, "rejected", "native_steer_rejected"),
          status: "needs_escalation", escalationSummary:
            `A definite steer rejection left ${record.targetThreadId} without a contactable ancestor in the helper's current assignment. Root intervention is required.`,
          reason: "native_steer_rejected"};
        this.save(payload, binding, evidenceItemId, needsEscalation);
        return this.finishRootEscalation(payload, binding, evidenceItemId, needsEscalation, true);
      }
      const reason = cause instanceof SupervisorRpcError && cause.dispatchCommandFailure
        ? "dispatch_failure_replay_requires_reconciliation" : "original_send_requires_reconciliation";
      const uncertain: GuideRecord = {...this.changedAttempt(current, attemptIndex, "uncertain", reason), status: "uncertain", reason};
      this.save(payload, binding, evidenceItemId, uncertain);
      this.team.setRequestState(binding, binding.threadId, record.requestId, 0, "uncertain");
      return uncertain;
    };
    try {
      const receipt = await this.rpc!("orchestration.dispatchCommand", command, signal);
      if (!isRecord(receipt) || !Number.isSafeInteger(receipt.sequence)) throw new SupervisorRpcError("uncertain");
      return acceptedResult(prepared);
    } catch (cause) {
      if (!(cause instanceof SupervisorRpcError) || !cause.dispatchCommandFailure) return rejectedResult(prepared, cause);
      const replayState: {record: GuideRecord | null; reserved: boolean} = {record: null, reserved: false};
      this.atomic(() => {
        const current = this.currentGuide(payload, binding) ?? prepared!;
        const latestAttempt = current.attempts?.[attemptIndex];
        if (!latestAttempt || latestAttempt.dispatchFailureReplayAttempted || latestAttempt.status !== "prepared") {
          replayState.record = current;
          return;
        }
        const attempts = [...current.attempts];
        attempts[attemptIndex] = {...latestAttempt, status: "replaying", dispatchFailureReplayAttempted: true,
          reason: "received_dispatch_command_failure"};
        replayState.record = {...current, attempts, status: "replaying"};
        replayState.reserved = true;
        this.save(payload, binding, evidenceItemId, replayState.record);
      });
      const replaying = replayState.record;
      if (!replayState.reserved || !replaying) return replaying ?? prepared;
      try {
        const receipt = await this.rpc!("orchestration.dispatchCommand", command, signal);
        if (!isRecord(receipt) || !Number.isSafeInteger(receipt.sequence)) throw new SupervisorRpcError("uncertain");
        return acceptedResult(replaying);
      } catch (replayCause) {
        return rejectedResult(this.currentGuide(payload, binding) ?? replaying, replayCause);
      }
    }
  }
  async guide(input: unknown, signal: AbortSignal): Promise<unknown> {
    const payload = this.parse(input, ["operationId", "targetThreadId", "text"]);
    if (!payload || !id(payload.targetThreadId) || !bounded(payload.operationId, 128) || !bounded(payload.text, 12000)) return {status: "invalid", reason: "invalid_guidance_arguments"};
    const proof = await this.workflows.authorizeNative(payload, "guide", signal);
    if (proof.status !== "verified") return proof;
    const binding = proof.binding;
    const prior = this.receipt(payload, binding);
    if (prior && prior.hash !== workflowRequestHash(payload)) return fail("operation_id_conflict");
    if (!this.rpc) return fail("native_guidance_unavailable");
    if (payload.supervisorThreadId === binding.threadId) return fail("helper_guidance_only_use_main_dialogue");
    try {
      if (prior) {
        const original = prior.value as GuideRecord;
        if (!Array.isArray(original.attempts)) {
          const projection = await this.workflows.options.native.projection(original.routedThreadId, signal);
          if (projection.messages.some(message => message.id === original.messageId && message.threadId === original.routedThreadId && message.text === payload.text)) {
            const result = {...original, status: "delivered"};this.save(payload, binding, proof.evidence.itemId, result);
            this.team.setRequestState(binding, binding.threadId, original.requestId, 0, "settled");return result;
          }
          return {...original, status: "uncertain", reason: "original_send_requires_reconciliation"};
        }
        if (["accepted", "delivered", "denied", "escalated", "not_sent"].includes(original.status)) return prior.value;
        if (original.status === "needs_fallback")
          return this.continueAfterDefiniteRejection(payload, binding, proof.evidence.itemId, original, signal);
        if (original.status === "needs_escalation")
          return this.finishRootEscalation(payload, binding, proof.evidence.itemId, original, original.attempts.length > 0);
        if (original.routedThreadId) {
          const projection = await this.workflows.options.native.projection(original.routedThreadId, signal);
          const message = projection.messages.find(item => item.id === original.messageId && item.threadId === original.routedThreadId && item.text === payload.text &&
            item.createdBy === "user" && item.creationSource === "server");
          if (message) {
            const result = {...original, status: "delivered"};this.save(payload, binding, proof.evidence.itemId, result);
            this.team.setRequestState(binding, binding.threadId, original.requestId, 0, "settled");
            if (message.runId && message.runId !== original.targetRunId) this.team.serviceAttention(binding, {
              eventId: `late-guide:${original.requestId}`, memberThreadId: original.supervisorThreadId, targetThreadId: original.targetThreadId,
              summary: `The native steer reached a new run in ${original.routedThreadId} after the targeted run ended. Stop further direct guidance and assess whether its operational parent needs attention.`});
            return result;
          }
        }
        const uncertain: GuideRecord = {...original, status: "uncertain", reason: "original_send_requires_reconciliation"};
        this.save(payload, binding, proof.evidence.itemId, uncertain);
        return uncertain;
      }
      if (this.team.unresolvedRequests(binding).some(request => request.requestId.startsWith("guide:") &&
        request.targets.some(target => target.targetThreadId === payload.targetThreadId))) return {status: "pending", reason: "prior_guidance_requires_reconciliation"};
      const record = this.guideRecord(payload, binding);
      const search = await this.findGuideRoute(binding, payload, true, signal);
      if (!search.route) {
        if (search.reason === "no_contactable_ancestor_in_assignment" || search.reason === "ancestor_outside_current_assignment")
          this.team.escalate(binding, {eventId: `guide-escalation:${workflowRequestHash(payload)}`, actorThreadId: payload.supervisorThreadId,
            memberEpoch: payload.memberEpoch!, targets: [{targetThreadId: payload.targetThreadId,
              assignmentRootThreadId: payload.assignmentRootThreadId!, assignmentEpoch: payload.assignmentEpoch!}], parentById: search.parents,
            summary: `Guidance needs root attention for ${payload.targetThreadId}: ${payload.text.slice(0, 3000)}`});
        if (search.reason === "no_contactable_ancestor_in_assignment" || search.reason === "ancestor_outside_current_assignment")
          return fail("no_contactable_ancestor_in_assignment_escalated");
        return fail(search.reason ?? "no_contactable_ancestor_in_assignment_escalated");
      }
      if (!this.current(payload, binding) || !this.team.authorizeWrite(binding, payload.supervisorThreadId, record.targetThreadId, search.parents, payload) ||
        !this.team.authorizeWrite(binding, payload.supervisorThreadId, search.route.thread.id, search.parents, payload)) {
        return fail("assignment_changed");
      }
      return this.sendGuideAttempt(payload, binding, proof.evidence.itemId, record, search.route, search.parents, signal);
    } catch {
      return fail("guidance_native_read_unavailable");
    }
  }
}
