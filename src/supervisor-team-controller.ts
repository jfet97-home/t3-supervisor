import type {SupervisorConversationStore} from "./supervisor-conversation-store.js";
import {isRecord, workflowRequestHash, workflowToolInputSize, workflowToolInputMaxBytes} from "./workflow-write-evidence.js";
import {WorkflowWriteController, type WorkflowLocator} from "./workflow-write-controller.js";
import {resolveSupervisorScope} from "./supervisor-scope.js";
import {SupervisorRpcError, type SupervisorRpc} from "./supervisor-native.js";
import {canSupervisorContact, hasPendingOwnerInput, hasRunningProviderTurn} from "./supervisor-conversation.js";
import {childOrigin} from "./supervisor-observation.js";
import type {BindingRecord} from "./project-supervisor-store.js";
import type {SupervisorTeamStore} from "./supervisor-team-store.js";
import type {Projection, ThreadInfo} from "./types.js";

const locator = {
  supervisorThreadId: {type: "string", minLength: 1, maxLength: 512},
  bindingGeneration: {type: "integer", minimum: 1},
  memberEpoch: {type: "integer", minimum: 1},
  assignmentRootThreadId: {type: "string", minLength: 1, maxLength: 512},
  assignmentEpoch: {type: "integer", minimum: 1},
};
const text = (maxLength: number) => ({type: "string", minLength: 1, maxLength});
export const supervisionTeamToolDefinition = {
  name: "supervision_team",
  description: "Read this root's flat Supervisor team. Root registers actual completed native delegate_task children, assigns operational subtrees, releases, retires or sends notes. Helpers acknowledge readiness and report significant assessments/escalations. All mutations require exact native caller proof; IDs and transport credentials alone grant no authority. Later helper check-ins are service-managed, not raw t3_thread_send.",
  inputSchema: {type: "object", additionalProperties: false, required: ["supervisorThreadId", "bindingGeneration", "action"], properties: {
    ...locator, action: {type: "string", enum: ["read", "register", "assign", "release", "retire", "note", "retry", "ready", "report"]},
    operationId: text(128), memberThreadId: text(512), taskId: text(512), bootstrapRunId: text(512),
    targetThreadId: text(512), summary: text(4000), reportKind: {type: "string", enum: ["assessment", "escalation", "group_result"]},
  }},
} as const;
export const supervisionGuideToolDefinition = {
  name: "supervision_guide",
  description: "Guide an operational child within your CURRENT assigned subtree through the Supervisor service. Fresh native ownership, pending-input and running-turn checks apply. Only targeted steer is used on delegated children. Native/read-only or unavailable children use an in-scope eligible ancestor; cross-scope guidance escalates to the root. Unknown sends retain their identity; never retry via t3_thread_send or change route.",
  inputSchema: {type: "object", additionalProperties: false,
    required: ["supervisorThreadId", "bindingGeneration", "operationId", "targetThreadId", "text"],
    properties: {...locator, operationId: text(128), targetThreadId: text(512), text: text(12000)}},
} as const;

type Payload = WorkflowLocator & Record<string, unknown>;
type GuideRecord = {status: "prepared" | "accepted" | "uncertain" | "delivered" | "denied"; targetThreadId: string; routedThreadId: string;
  commandId: string; messageId: string; requestId: string; targetRunId: string; text: string; reason?: string};
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
    const payload = this.parse(input, ["action", "operationId", "memberThreadId", "taskId", "bootstrapRunId", "targetThreadId", "summary", "reportKind"]);
    if (!payload || typeof payload.action !== "string") return {status: "invalid", reason: "invalid_team_arguments"};
    if (payload.action !== "read" && !bounded(payload.operationId, 128)) return {status: "invalid", reason: "operation_id_required"};
    const binding = this.workflows.resolveBinding(payload, payload.action === "ready");
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
    if (proof.status !== "verified") return proof;
    const prior = this.receipt(payload, binding);
    if (prior) return prior.hash === workflowRequestHash(payload) ? prior.value : fail("operation_id_conflict");
    const root = payload.supervisorThreadId === binding.threadId;
    if (!root && !["ready", "report"].includes(payload.action)) return fail("root_authority_required");
    try {
      const threads = await this.workflows.options.native.listThreads(signal);
      const scope = resolveSupervisorScope(threads, binding.projectId, binding.mainThreadId, this.workflows.options.supervisors.ownedIds);
      if (!scope.complete || !scope.main || !scope.liveIds.has(binding.mainThreadId)) return fail("native_scope_unavailable");
      if (payload.action === "register") await this.verifyMember(binding, payload, signal);
      if (["assign", "release", "report"].includes(payload.action) &&
        (!id(payload.targetThreadId) || payload.targetThreadId === binding.mainThreadId || !scope.liveIds.has(payload.targetThreadId)))
        return fail("target_not_live_operational_descendant");
      return this.atomic(() => {
        if (!this.current(payload, binding, payload.action === "ready")) return fail("actor_changed");
        let result: unknown;
        if (payload.action === "register") {
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
        } else if (payload.action === "retry") {
          if (!id(payload.memberThreadId) || !this.requests || this.team.unresolvedRequests(binding).some(item => item.memberThreadId === payload.memberThreadId))
            return fail("member_has_unresolved_delivery");
          const failed = this.requests.requests(binding.projectId, payload.memberThreadId).filter(item => item.state === "failed" && !item.failureAcknowledged);
          for (const request of failed) this.requests.saveRequest({...request, failureAcknowledged: true});
          result = {acknowledgedFailures: failed.length};
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
    } catch (cause) {return fail(cause instanceof Error && /^[a-z_]+$/u.test(cause.message) ? cause.message : "team_operation_unavailable");}
  }
  async reconcile(binding: BindingRecord, signal: AbortSignal): Promise<void> {
    const members = this.team.snapshot(binding).members;
    const actors = new Set(members.map(member => member.threadId));
    const rows = this.workflows.options.supervisors.store.db.prepare("SELECT actor_thread_id,actor_epoch,operation_id,document FROM supervisor_team_tool_receipts WHERE owner_thread_id=? AND binding_generation=? AND json_extract(document,'$.requestId') LIKE 'guide:%' AND json_extract(document,'$.status') IN ('prepared','accepted','uncertain') ORDER BY rowid")
      .all(binding.threadId, binding.generation).filter(row => actors.has(String(row.actor_thread_id)));
    const offset = rows.length ? (this.reconcileOffsets.get(binding.threadId) ?? 0) % rows.length : 0;
    this.reconcileOffsets.set(binding.threadId, offset + 4);
    for (const row of [...rows.slice(offset), ...rows.slice(0, offset)].slice(0, 4)) {
      if (signal.aborted) return;
      const value = JSON.parse(String(row.document)) as GuideRecord;
      try {
        const projection = await this.workflows.options.native.projection(value.routedThreadId, signal);
        const message = projection.messages.find(item => item.id === value.messageId && item.threadId === value.routedThreadId && item.text === value.text &&
          item.createdBy === "user" && item.creationSource === "server");
        if (!message) continue;
        this.atomic(() => {
          const result = {...value, status: "delivered"};
          this.workflows.options.supervisors.store.db.prepare("UPDATE supervisor_team_tool_receipts SET document=? WHERE owner_thread_id=? AND actor_thread_id=? AND binding_generation=? AND actor_epoch=? AND operation_id=?")
            .run(JSON.stringify(result), binding.threadId, String(row.actor_thread_id), binding.generation, Number(row.actor_epoch), String(row.operation_id));
          this.team.setRequestState(binding, binding.threadId, value.requestId, 0, "settled");
          if (message.runId && message.runId !== value.targetRunId) this.team.serviceAttention(binding, {
            eventId: `late-guide:${value.requestId}`, memberThreadId: String(row.actor_thread_id), targetThreadId: value.targetThreadId,
            summary: `The native steer reached a new run in ${value.routedThreadId} after the targeted run ended. Stop further direct guidance and assess whether its operational parent needs attention.`});
        });
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
  }
  async guide(input: unknown, signal: AbortSignal): Promise<unknown> {
    const payload = this.parse(input, ["operationId", "targetThreadId", "text"]);
    if (!payload || !id(payload.targetThreadId) || !bounded(payload.operationId, 128) || !bounded(payload.text, 12000)) return {status: "invalid", reason: "invalid_guidance_arguments"};
    const proof = await this.workflows.authorizeNative(payload, "guide", signal);
    if (proof.status !== "verified") return proof;
    const binding = proof.binding;
    const prior = this.receipt(payload, binding);
    if (prior && prior.hash !== workflowRequestHash(payload)) return fail("operation_id_conflict");
    if (prior && !["uncertain", "prepared"].includes(String(prior.value.status))) return prior.value;
    if (!this.rpc) return fail("native_guidance_unavailable");
    if (payload.supervisorThreadId === binding.threadId) return fail("helper_guidance_only_use_main_dialogue");
    try {
      const threads = await this.workflows.options.native.listThreads(signal);
      const scope = resolveSupervisorScope(threads, binding.projectId, binding.mainThreadId, this.workflows.options.supervisors.ownedIds);
      const parents = parentMap(threads);
      if (!scope.complete || !scope.liveIds.has(payload.targetThreadId)) return fail("native_scope_unavailable");
      if (!this.current(payload, binding) || !this.team.authorizeWrite(binding, payload.supervisorThreadId, payload.targetThreadId, parents, payload))
        return fail("guidance_outside_current_assignment");
      if (prior) {
        const original = prior.value as GuideRecord;
        const projection = await this.workflows.options.native.projection(original.routedThreadId, signal);
        if (projection.messages.some(message => message.id === original.messageId && message.threadId === original.routedThreadId && message.text === payload.text)) {
          const result = {...original, status: "delivered"};this.save(payload, binding, proof.evidence.itemId, result);
          this.team.setRequestState(binding, binding.threadId, original.requestId, 0, "settled");return result;
        }
        return {...original, status: "uncertain", reason: "original_send_requires_reconciliation"};
      }
      if (this.team.unresolvedRequests(binding).some(request => request.requestId.startsWith("guide:") &&
        request.targets.some(target => target.targetThreadId === payload.targetThreadId))) return {status: "pending", reason: "prior_guidance_requires_reconciliation"};
      const actor = await this.workflows.options.native.projection(payload.supervisorThreadId, signal);
      let target = scope.byId.get(payload.targetThreadId);
      let routed: Projection | null = null;
      while (target) {
        if (!this.team.authorizeWrite(binding, payload.supervisorThreadId, target.id, parents, payload)) break;
        const current = await this.workflows.options.native.projection(target.id, signal);
        if (current.thread.id !== target.id || current.thread.lineage.parentThreadId !== target.lineage.parentThreadId ||
          current.thread.lineage.relationshipToParent !== target.lineage.relationshipToParent) return fail("target_lineage_changed");
        if (hasPendingOwnerInput(current)) return fail("pending_owner_input");
        const parent = target.lineage.parentThreadId ? await this.workflows.options.native.projection(target.lineage.parentThreadId, signal) : undefined;
        const run = current.runs.find(item => item.id === current.thread.activeRunId && item.status === "running");
        if (target.id !== binding.mainThreadId && childOrigin(current.thread, parent) === "delegated_child" && run &&
          hasRunningProviderTurn(current, run) && canSupervisorContact(actor.thread, current.thread)) {routed = current;break;}
        if (target.id === binding.mainThreadId) break;
        target = target.lineage.parentThreadId ? scope.byId.get(target.lineage.parentThreadId) : undefined;
      }
      if (!routed) {
        if (payload.supervisorThreadId !== binding.threadId) this.team.escalate(binding, {eventId: `guide-escalation:${workflowRequestHash(payload)}`, actorThreadId: payload.supervisorThreadId,
          memberEpoch: payload.memberEpoch!, targets: [{targetThreadId: payload.targetThreadId,
            assignmentRootThreadId: payload.assignmentRootThreadId!, assignmentEpoch: payload.assignmentEpoch!}], parentById: parents,
          summary: `Guidance needs root attention for ${payload.targetThreadId}: ${payload.text.slice(0, 3000)}`});
        return fail("no_contactable_ancestor_in_assignment_escalated");
      }
      const coverage = this.team.coverage(binding, payload.targetThreadId, parents);
      if (!this.current(payload, binding) || !this.team.authorizeWrite(binding, payload.supervisorThreadId, payload.targetThreadId, parents, payload) ||
        !this.team.authorizeWrite(binding, payload.supervisorThreadId, routed.thread.id, parents, payload)) return fail("assignment_changed");
      const requestId = `guide:${workflowRequestHash(payload)}`;
      const record: GuideRecord = {status: "prepared", targetThreadId: String(payload.targetThreadId), routedThreadId: routed.thread.id,
        commandId: requestId, messageId: requestId, requestId, text: payload.text, targetRunId: String(routed.thread.activeRunId)};
      this.atomic(() => {
        this.team.recordRequest(binding, {requestId, memberThreadId: payload.supervisorThreadId, memberEpoch: coverage.memberEpoch ?? 0,
          targets: [{targetThreadId: String(payload.targetThreadId), assignmentRootThreadId: coverage.assignmentRootThreadId ?? binding.mainThreadId, assignmentEpoch: coverage.assignmentEpoch ?? 0}], parentById: parents});
        this.save(payload, binding, proof.evidence.itemId, record);
      });
      try {
        const receipt = await this.rpc("orchestration.dispatchCommand", {type: "message.dispatch", commandId: record.commandId, messageId: record.messageId,
          threadId: record.routedThreadId, text: payload.text, attachments: [], createdBy: "system", creationSource: "server",
          dispatchMode: {type: "steer_active", targetRunId: record.targetRunId}}, signal);
        if (!isRecord(receipt) || !Number.isSafeInteger(receipt.sequence)) throw new SupervisorRpcError("uncertain");
        const result = {...record, status: "accepted", reason: "Native steer command accepted; late completion can still start a turn. Do not send another route."};
        this.save(payload, binding, proof.evidence.itemId, result);
        return result;
      } catch (cause) {
        const definite = cause instanceof SupervisorRpcError && cause.definiteRejection;
        const result = {...record, status: definite ? "denied" : "uncertain", reason: definite ? "native_steer_rejected" : "original_send_requires_reconciliation"};
        this.save(payload, binding, proof.evidence.itemId, result);
        this.team.setRequestState(binding, binding.threadId, requestId, 0, definite ? "settled" : "uncertain");
        return result;
      }
    } catch {return fail("guidance_native_read_unavailable");}
  }
}
