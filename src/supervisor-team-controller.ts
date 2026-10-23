import { Cause, Clock, Context, Data, Deferred, Effect, Exit, FiberMap, HashMap, Layer, Option, Ref, Schema } from "effect";
import {isRecord, workflowRequestHash, workflowToolInputSize, workflowToolInputMaxBytes} from "./workflow-write-evidence.js";
import {WorkflowNativeAccess, WorkflowWriteController, type WorkflowCallCancel, type WorkflowLocator, type WorkflowReadCancelled} from "./workflow-write-controller.js";
import {resolveSupervisorScope} from "./supervisor-scope.js";
import {modelSelection, NativeOperateRpc, SupervisorRpcError, type NativeRpcShape} from "./supervisor-native.js";
import {canSupervisorContact, hasPendingOwnerInput, resolveSteerableRun} from "./supervisor-conversation.js";
import {childOrigin} from "./supervisor-observation.js";
import type {BindingRecord} from "./project-supervisor-store.js";
import {endedWithoutCompletion, maxHandoverReviewChain, parseHandoverReview, type HandoverReviewInput} from "./supervisor-team-store.js";
import {attributesHelperDelivery, HelperTransport, invalidReceipt} from "./supervisor-helper-transport.js";
import {SupervisionStores} from "./supervision-stores.js";
import {teamNotificationEvidence, teamNotificationText} from "./supervisor-team-runtime.js";
import {admitSend, SupervisionGate, type AdmittedInFlight, type GateGuard, type SendPreparation} from "./supervision-gate.js";
import type {T3TransportError} from "./t3.js";
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

// the supervision_team and supervision_guide argument envelopes: the locator bounds and exactly the action's keys; an excess
// key is rejected, never stripped, and the raw arguments stay the proof and receipt hash source
const TeamId = Schema.String.check(Schema.makeFilter((value: string) => id(value)));
const Epoch = Schema.Number.check(Schema.makeFilter((value: number) => Number.isSafeInteger(value) && value >= 1));
const locatorFields = {supervisorThreadId: TeamId, bindingGeneration: Epoch, memberEpoch: Schema.optional(Epoch),
  assignmentRootThreadId: Schema.optional(TeamId), assignmentEpoch: Schema.optional(Epoch)};
const anyField = Schema.optional(Schema.Unknown);
const decodeTeamArguments = Schema.decodeUnknownExit(Schema.Struct({...locatorFields, action: anyField, operationId: anyField, memberThreadId: anyField,
  taskId: anyField, bootstrapRunId: anyField, targetThreadId: anyField, summary: anyField, reportKind: anyField, notificationId: anyField,
  expectedDeliveryAttempt: anyField, expectedRunId: anyField, expectedChain: anyField, note: anyField}));
const decodeGuideArguments = Schema.decodeUnknownExit(Schema.Struct({...locatorFields, operationId: Schema.String.check(Schema.makeFilter((value: string) => bounded(value, 128))),
  targetThreadId: TeamId, text: Schema.String.check(Schema.makeFilter((value: string) => bounded(value, 12000)))}));
const exactKeys = {onExcessProperty: "error"} as const;

// a fixed refusal code of a team or guidance step; only these codes, a store's own code and the review whitelist escape. A
// guide's reservation refusal escapes the call itself, with the baseline error's message
export class TeamDenied extends Data.TaggedError("TeamDenied")<{readonly reason: string}> {
  override readonly message: string = this.reason;
}
// the code a failed step may report: a refusal, or an error whose message is a bare code; native and exception text never escapes
const failureCode = (cause: Cause.Cause<unknown>): string | null => {
  const error = Cause.squash(cause);
  if (error instanceof TeamDenied) return error.reason;
  return error instanceof Error ? error.message : null;
};
// the baseline catch-all of a step: any failure or defect gives the fallback; an interruption stays an interruption
const otherwise = <B>(fallback: (cause: Cause.Cause<unknown>) => B) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
  Effect.catchCauseIf(effect, (cause) => !Cause.hasInterruptsOnly(cause), (cause) => Effect.sync(() => fallback(cause))) as Effect.Effect<A | B, never, R>;

// a team call's cancel: the b-03 caller's own signal; an effect caller relies on interruption alone
const withCancel = <A, E>(cancel: WorkflowCallCancel | undefined, body: (cancel: WorkflowCallCancel) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  cancel !== undefined ? body(cancel) : Effect.flatMap(Deferred.make<void>(), body);

// what a guide send's admission settles: its own dispatch reply, or the stored record when a reservation already exists or the
// original was interrupted, or a changed assignment found by the final guard
type GuideDispatch =
  | {readonly _tag: "Dispatched"; readonly exit: Exit.Exit<unknown, unknown>}
  | {readonly _tag: "Stored"; readonly record: GuideRecord}
  | {readonly _tag: "AssignmentChanged"};

export type SupervisorTeamControllerOptions = {
  // the configured helper provider instance; without one, helper registration checks no provider isolation
  readonly helperProviderInstanceId?: string | undefined;
};

export interface SupervisorTeamControllerShape {
  readonly call: (input: unknown, cancel?: WorkflowCallCancel) => Effect.Effect<unknown>;
  readonly guide: (input: unknown, cancel?: WorkflowCallCancel) => Effect.Effect<unknown, TeamDenied>;
  readonly reconcile: (binding: BindingRecord, stopped?: boolean, cancel?: WorkflowCallCancel) => Effect.Effect<void>;
  /**
   * Guidance receipts of a stopped chat, observation only: a delivered steer settles, and a rejected attempt awaiting a fallback
   * or escalation is closed as not sent because a stop never sends another route. An unknown send keeps its identities.
   */
  readonly reconcileStopped: (binding: BindingRecord, cancel?: WorkflowCallCancel) => Effect.Effect<void>;
}

// the baseline promise call shapes the unported workflow mcp endpoint and ProjectSupervisor use (b-03)
export interface SupervisorTeamControllerPromises {
  call(input: unknown, signal: AbortSignal): Promise<unknown>;
  guide(input: unknown, signal: AbortSignal): Promise<unknown>;
  reconcile(binding: BindingRecord, signal: AbortSignal): Promise<void>;
  reconcileStopped(binding: BindingRecord, signal: AbortSignal): Promise<void>;
}

/** Mediates team changes and guidance using the existing private database and native proof. */
const makeSupervisorTeamController = (options: SupervisorTeamControllerOptions = {}) => Effect.gen(function* () {
  const workflows = yield* WorkflowWriteController;
  // the interim synchronous stores (b-02): the binding store and its database, the team and the conversation requests
  const {supervisors, team, requests} = yield* SupervisionStores;
  const native = yield* WorkflowNativeAccess;
  const gate = yield* SupervisionGate;
  const transport = yield* HelperTransport;
  // the operate credential; without it no guidance is dispatched
  const rpc: NativeRpcShape | null = Option.getOrNull(yield* Effect.serviceOption(NativeOperateRpc));
  // the service-lifetime in-flight steers (plan 3.11): closing its scope interrupts each one and runs its release
  const inFlight = yield* FiberMap.make<string, GuideDispatch>();
  // each admitted send registers under its own key, so a concurrent duplicate is answered from the durable receipt (b) and
  // never joins another call's in-flight steer
  const sends = yield* Ref.make(0);
  const reconcileOffsets = yield* Ref.make(HashMap.empty<string, number>());
  const db = supervisors.store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS supervisor_team_tool_receipts(
      owner_thread_id TEXT NOT NULL,actor_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,actor_epoch INTEGER NOT NULL,operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,evidence_item_id TEXT NOT NULL,document TEXT NOT NULL,
      PRIMARY KEY(owner_thread_id,actor_thread_id,binding_generation,actor_epoch,operation_id));`);

  const parse = (input: unknown, decode: typeof decodeTeamArguments | typeof decodeGuideArguments): Payload | null => {
    if (Exit.isFailure(decode(input, exactKeys))) return null;
    try {if (workflowToolInputSize(input) > workflowToolInputMaxBytes) return null;} catch {return null;}
    return input as Payload;
  };
  const receipt = (payload: Payload, binding: BindingRecord): {hash: string; value: Record<string, unknown>} | null => {
    const row = db.prepare("SELECT request_hash,document FROM supervisor_team_tool_receipts WHERE owner_thread_id=? AND actor_thread_id=? AND binding_generation=? AND actor_epoch=? AND operation_id=?")
      .get(binding.threadId, payload.supervisorThreadId, payload.bindingGeneration, payload.memberEpoch ?? 0, String(payload.operationId));
    return row ? {hash: String(row.request_hash), value: JSON.parse(String(row.document)) as Record<string, unknown>} : null;
  };
  const save = (payload: Payload, binding: BindingRecord, evidenceItemId: string, result: unknown): void => {
    db.prepare(`INSERT INTO supervisor_team_tool_receipts VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_thread_id,actor_thread_id,binding_generation,actor_epoch,operation_id) DO UPDATE SET document=excluded.document`)
      .run(binding.threadId, payload.supervisorThreadId, payload.bindingGeneration, payload.memberEpoch ?? 0, String(payload.operationId), workflowRequestHash(payload), evidenceItemId, JSON.stringify(result));
  };
  const atomic = <A>(work: () => A): A => db.isTransaction ? work() : supervisors.store.transaction(work);
  // the actor's binding is still current; `guard` is the admission guard inside a section, the display predicates otherwise
  const current = (payload: Payload, binding: BindingRecord, allowRegistering = false, guard?: GateGuard): boolean => {
    const latest = workflows.resolveBinding(payload, allowRegistering, "effect", guard);
    return latest?.threadId === binding.threadId && latest.generation === binding.generation;
  };
  const currentGuide = (payload: Payload, binding: BindingRecord): GuideRecord | null => {
    const stored = receipt(payload, binding);
    return stored ? stored.value as GuideRecord : null;
  };

  const verifyHandoverReview = Effect.fnUntraced(function* (binding: BindingRecord, input: HandoverReviewInput, cancel: WorkflowCallCancel) {
    const {original, chain} = team.handoverReviewContext(binding, input);
    const projection = yield* native.projection(original.recipientThreadId, cancel);
    if ((yield* Deferred.isDone(cancel)) || projection.thread.id !== original.recipientThreadId || projection.thread.projectId !== binding.projectId ||
      projection.thread.lineage.parentThreadId !== binding.threadId || projection.thread.lineage.relationshipToParent !== "subagent" ||
      projection.thread.archivedAt != null || projection.thread.deletedAt != null) return yield* new TeamDenied({reason: "supervisor_team_review_native_unavailable"});
    for (const notification of chain) {
      const {marker} = teamNotificationText(binding, notification);
      // read only the existing transport receipt. No channel creation, POST or native
      // mutation is permitted here. Its exact sent bytes + owned scheduled task identify
      // the delivery; regenerated text would not survive a later wording change.
      const delivery = yield* transport.receiptDocument(binding, `supervisor-team-notice:${notification.id}:attempt:${notification.deliveryAttempt}`);
      // an unreadable receipt exists but proves nothing, as an absent or rejected one
      if (delivery === invalidReceipt || !isRecord(delivery) || delivery.state === "rejected")
        return yield* new TeamDenied({reason: "supervisor_team_review_native_unavailable"});
      const sentText = delivery.text;
      const helperThreadId = delivery.threadId;
      const taskId = delivery.taskId;
      if (typeof sentText !== "string" || helperThreadId !== notification.recipientThreadId || !id(taskId))
        return yield* new TeamDenied({reason: "supervisor_team_review_native_unavailable"});
      // the same attribution predicate as check-ins: exact frame or bound rendering, never a second copy of the matcher
      const evidence = teamNotificationEvidence(projection, notification, marker, message => attributesHelperDelivery({
        state: String(delivery.state), text: sentText, threadId: notification.recipientThreadId, taskId,
        nativeDeliveryId: delivery.nativeDeliveryId, renderedText: delivery.renderedText, nativeMessageId: delivery.nativeMessageId,
      }, message, projection.messages));
      if (evidence.completedRun) return yield* new TeamDenied({reason: "supervisor_team_review_native_completed"});
      const run = evidence.runs.find(value => value.id === notification.observedRun?.runId);
      if (!evidence.message || !run || run.status !== notification.observedRun?.status || !endedWithoutCompletion.has(run.status) ||
        evidence.runs.some(value => !endedWithoutCompletion.has(value.status))) return yield* new TeamDenied({reason: "supervisor_team_review_native_changed"});
    }
  });

  // the provider isolation failure of a helper registration, after one stable service-attention event, or null when isolated
  const helperProviderIsolationFailure = (binding: BindingRecord, payload: Payload, root: Projection, child: Projection): string | null => {
    const configuredInstanceId = options.helperProviderInstanceId;
    if (!configuredInstanceId) return null;
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
    const failIsolation = (reason: string): string => {
      const memberThreadId = String(payload.memberThreadId);
      const eventIdentity = workflowRequestHash({supervisorThreadId: binding.threadId, bindingGeneration: binding.generation,
        memberThreadId, taskId: payload.taskId, bootstrapRunId: payload.bootstrapRunId});
      team.serviceAttention(binding, {eventId: `helper-provider-isolation:${eventIdentity.slice(0, 32)}`,
        memberThreadId: binding.threadId, targetThreadId: memberThreadId,
        summary: `Helper ${memberThreadId} was not registered because its configured provider isolation could not be verified (${reason}). No helper membership or webhook was created, and no shared-session fallback occurred.`});
      return reason;
    };

    if (!rootSelection || rootSelection.instanceId === configuredInstanceId) return failIsolation("helper_provider_instance_matches_root");
    if (!childSelection || childSelection.instanceId !== configuredInstanceId ||
      childSessionThreads.some(row => row.providerInstanceId !== configuredInstanceId))
      return failIsolation("helper_provider_instance_mismatch");
    if (!rootSessions.size || !childSessions.size) return failIsolation("helper_provider_session_unavailable");
    if ([...childSessions].some(sessionId => rootSessions.has(sessionId))) return failIsolation("helper_provider_session_shared");
    return null;
  };

  const verifyMember = Effect.fnUntraced(function* (binding: BindingRecord, payload: Payload, cancel: WorkflowCallCancel) {
    if (!id(payload.memberThreadId) || !id(payload.taskId) || !id(payload.bootstrapRunId)) return yield* new TeamDenied({reason: "invalid_registration"});
    const root = yield* native.projection(binding.threadId, cancel);
    const child = yield* native.projection(payload.memberThreadId, cancel);
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
      !child.messages.some(message => message.id === bootstrap.userMessageId && message.runId === bootstrap.id && message.text === task.prompt))
      return yield* new TeamDenied({reason: "native_completed_bootstrap_not_verified"});
    const isolation = helperProviderIsolationFailure(binding, payload, root, child);
    if (isolation) return yield* new TeamDenied({reason: isolation});
  });

  const call = Effect.fnUntraced(function* (input: unknown, cancel: WorkflowCallCancel): Effect.fn.Return<unknown> {
    const payload = parse(input, decodeTeamArguments);
    if (!payload || typeof payload.action !== "string") return {status: "invalid", reason: "invalid_team_arguments"};
    if (payload.action !== "read" && !bounded(payload.operationId, 128)) return {status: "invalid", reason: "operation_id_required"};
    const reviewInput = payload.action === "review_handover" ? parseHandoverReview(payload) : null;
    if (payload.action === "review_handover" && !reviewInput) return fail("supervisor_team_invalid_handover_review");
    // reading the team stays possible after a human stop; every other action is an effect fenced by the stop
    const binding = workflows.resolveBinding(payload, payload.action === "ready", payload.action === "read" ? "read" : "effect");
    if (!binding && payload.action === "ready" && typeof payload.memberEpoch === "number") {
      const replayed = workflows.resolveBinding({...payload, memberEpoch: payload.memberEpoch + 1});
      const member = replayed && team.snapshot(replayed).members.find(item => item.threadId === payload.supervisorThreadId);
      if (replayed && member?.state === "ready" && member.epoch === payload.memberEpoch + 1) {
        const stored = receipt(payload, replayed);
        if (stored?.hash === workflowRequestHash(payload)) return stored.value;
      }
    }
    if (!binding) return fail("actor_not_current_ready_enabled");
    if (payload.action === "read") return {status: "ok", team: team.snapshot(binding)};
    const proof = yield* workflows.authorizeNative(payload, "team", payload.action === "ready", cancel);
    if (proof.status !== "verified") return payload.action === "review_handover" ? fail("native_root_proof_required") : proof;
    const prior = receipt(payload, binding);
    if (prior) return prior.hash === workflowRequestHash(payload) ? prior.value : fail("operation_id_conflict");
    const root = payload.supervisorThreadId === binding.threadId;
    if (!root && !["ready", "report"].includes(payload.action)) return fail("root_authority_required");
    return yield* Effect.gen(function* () {
      const threads = yield* native.listThreads(cancel);
      const nativeScope = resolveSupervisorScope(threads, binding.projectId, binding.mainThreadId, supervisors.ownedIds);
      if (!nativeScope.complete || !nativeScope.main || !nativeScope.liveIds.has(binding.mainThreadId)) return fail("native_scope_unavailable");
      if (payload.action === "register") yield* verifyMember(binding, payload, cancel);
      if (reviewInput) yield* verifyHandoverReview(binding, reviewInput, cancel);
      if (["assign", "release", "report"].includes(String(payload.action)) &&
        (!id(payload.targetThreadId) || payload.targetThreadId === binding.mainThreadId || !nativeScope.liveIds.has(payload.targetThreadId)))
        return fail("target_not_live_operational_descendant");
      // the supervision_team mutation (plan 3.11): the actor and receipt rechecks, the team change and its receipt in one
      // transaction inside the admission section, so it is ordered against every Stop and send guard
      return yield* gate.admit((guard) => Effect.sync(() => atomic((): unknown => {
        if (!current(payload, binding, payload.action === "ready", guard)) return fail("actor_changed");
        const concurrent = receipt(payload, binding);
        if (concurrent) return concurrent.hash === workflowRequestHash(payload) ? concurrent.value : fail("operation_id_conflict");
        let result: unknown;
        if (reviewInput) {
          result = team.reviewHandover(binding, payload.supervisorThreadId, reviewInput);
        } else if (payload.action === "register") {
          if (!id(payload.memberThreadId) || !id(payload.taskId) || !id(payload.bootstrapRunId)) return fail("invalid_registration");
          result = team.registerMember(binding, {threadId: payload.memberThreadId, taskId: payload.taskId, bootstrapRunId: payload.bootstrapRunId});
        } else if (payload.action === "ready") {
          if (root || typeof payload.memberEpoch !== "number") return fail("registered_helper_required");
          result = team.markReady(binding, payload.supervisorThreadId, payload.memberEpoch);
        } else if (payload.action === "assign" || payload.action === "release") {
          if (payload.action === "assign" && !id(payload.memberThreadId)) return fail("member_required");
          result = team.assign(binding, String(payload.targetThreadId), payload.action === "release" ? null : String(payload.memberThreadId), parentMap(threads));
        } else if (payload.action === "retire") {
          if (!id(payload.memberThreadId)) return fail("member_required");
          result = team.retireMember(binding, payload.memberThreadId);
        } else if (payload.action === "quarantine") {
          if (!root || !id(payload.memberThreadId)) return fail("root_authority_required");
          result = team.quarantineMember(binding, payload.memberThreadId);
        } else if (payload.action === "retry") {
          if (!id(payload.memberThreadId)) return fail("member_required");
          const memberThreadId = payload.memberThreadId;
          const pendingRequestsRemain = team.unresolvedRequests(binding).some(item => item.memberThreadId === memberThreadId);
          const failed = pendingRequestsRemain ? [] :
            requests.requests(binding.projectId, memberThreadId).filter(item => item.state === "failed" && !item.failureAcknowledged);
          for (const request of failed) requests.saveRequest({...request, failureAcknowledged: true});
          const retriedNotifications = team.retryFailedNotifications(binding, memberThreadId);
          result = {acknowledgedFailures: failed.length, retriedNotifications, pendingRequestsRemain};
        } else if (payload.action === "note") {
          if (!id(payload.memberThreadId) || !bounded(payload.summary, 4000)) return fail("member_and_summary_required");
          const memberThreadId = payload.memberThreadId;
          const member = team.snapshot(binding).members.find(item => item.threadId === memberThreadId);
          if (!member) return fail("member_required");
          result = team.note(binding, {eventId: `note:${payload.operationId}`, notificationId: `note:${payload.operationId}`,
            memberThreadId, memberEpoch: member.epoch, message: payload.summary});
        } else if (payload.action === "report") {
          if (root || !bounded(payload.summary, 4000) || !["assessment", "escalation", "group_result"].includes(String(payload.reportKind)) ||
            !team.authorizeWrite(binding, payload.supervisorThreadId, String(payload.targetThreadId), parentMap(threads), payload))
            return fail("report_outside_current_assignment");
          const report = {eventId: `report:${payload.supervisorThreadId}:${payload.operationId}`, actorThreadId: payload.supervisorThreadId,
            memberEpoch: payload.memberEpoch!, targets: [{targetThreadId: String(payload.targetThreadId),
              assignmentRootThreadId: payload.assignmentRootThreadId!, assignmentEpoch: payload.assignmentEpoch!}],
            summary: payload.summary, parentById: parentMap(threads), ...(payload.reportKind === "group_result" ? {severity: "result" as const} : {})};
          result = payload.reportKind === "escalation" ? team.escalate(binding, report) : team.assessment(binding, report);
        } else return {status: "invalid", reason: "unknown_team_action"};
        const response = {status: "ok", result, team: team.snapshot(binding)};
        save(payload, binding, proof.evidence.itemId, response);
        return response;
      })));
    }).pipe(otherwise((cause) => {
      const code = failureCode(cause);
      if (payload.action === "review_handover") return fail(code !== null && handoverReviewErrors.has(code) ? code : "supervisor_team_review_native_unavailable");
      return fail(code !== null && /^[a-z_]+$/u.test(code) ? code : "team_operation_unavailable");
    }));
  });

  const guidePayload = (record: GuideRecord): Payload =>
    ({supervisorThreadId: record.supervisorThreadId, bindingGeneration: record.bindingGeneration, memberEpoch: record.memberEpoch,
      assignmentRootThreadId: record.assignmentRootThreadId, assignmentEpoch: record.assignmentEpoch, operationId: record.operationId,
      targetThreadId: record.targetThreadId, text: record.text});
  const guideRecord = (payload: Payload, binding: BindingRecord): GuideRecord => {
    const requestId = `guide:${workflowRequestHash(payload)}`;
    return {status: "prepared", targetThreadId: String(payload.targetThreadId), supervisorThreadId: payload.supervisorThreadId,
      bindingGeneration: binding.generation, memberEpoch: Number(payload.memberEpoch), assignmentRootThreadId: String(payload.assignmentRootThreadId),
      assignmentEpoch: Number(payload.assignmentEpoch), operationId: String(payload.operationId), routedThreadId: "", commandId: "", messageId: "",
      requestId, targetRunId: "", text: String(payload.text), attempts: []};
  };
  const findGuideRoute = Effect.fnUntraced(function* (binding: BindingRecord, payload: Payload, includeTarget: boolean,
    cancel: WorkflowCallCancel): Effect.fn.Return<GuideRouteSearch, SupervisorRpcError | T3TransportError | WorkflowReadCancelled> {
    const threads = yield* native.listThreads(cancel);
    const nativeScope = resolveSupervisorScope(threads, binding.projectId, binding.mainThreadId, supervisors.ownedIds);
    const parents = parentMap(threads);
    if (!nativeScope.complete || !nativeScope.main || !nativeScope.liveIds.has(String(payload.targetThreadId)))
      return {route: null, parents, reason: "native_scope_unavailable", freshScope: false};
    if (!current(payload, binding) || !team.authorizeWrite(binding, payload.supervisorThreadId, String(payload.targetThreadId), parents, payload))
      return {route: null, parents, reason: "guidance_assignment_changed", freshScope: true};
    const actor = yield* native.projection(payload.supervisorThreadId, cancel);
    if (actor.thread.id !== payload.supervisorThreadId || actor.thread.archivedAt != null || actor.thread.deletedAt != null || !current(payload, binding))
      return {route: null, parents, reason: "helper_identity_changed", freshScope: true};
    const original = nativeScope.byId.get(String(payload.targetThreadId));
    if (!original) return {route: null, parents, reason: "target_lineage_unavailable", freshScope: true};
    const target = yield* native.projection(original.id, cancel);
    if (target.thread.id !== original.id || target.thread.lineage.parentThreadId !== original.lineage.parentThreadId ||
      target.thread.lineage.relationshipToParent !== original.lineage.relationshipToParent)
      return {route: null, parents, reason: "target_lineage_changed", freshScope: true};
    if (hasPendingOwnerInput(target)) return {route: null, parents, reason: "target_pending_owner_input", freshScope: true};
    let candidate = includeTarget ? original : original.lineage.parentThreadId ? nativeScope.byId.get(original.lineage.parentThreadId) : undefined;
    while (candidate && candidate.id !== binding.mainThreadId) {
      if (!nativeScope.liveIds.has(candidate.id)) {
        candidate = candidate.lineage.parentThreadId ? nativeScope.byId.get(candidate.lineage.parentThreadId) : undefined;
        continue;
      }
      if (!current(payload, binding) || !team.authorizeWrite(binding, payload.supervisorThreadId, String(payload.targetThreadId), parents, payload))
        return {route: null, parents, reason: "guidance_assignment_changed", freshScope: true};
      if (!team.authorizeWrite(binding, payload.supervisorThreadId, candidate.id, parents, payload))
        return {route: null, parents, reason: "ancestor_outside_current_assignment", freshScope: true};
      const route = candidate.id === original.id ? target : yield* native.projection(candidate.id, cancel);
      if (route.thread.id !== candidate.id || route.thread.lineage.parentThreadId !== candidate.lineage.parentThreadId ||
        route.thread.lineage.relationshipToParent !== candidate.lineage.relationshipToParent)
        return {route: null, parents, reason: "target_lineage_changed", freshScope: true};
      if (route.thread.archivedAt == null && route.thread.deletedAt == null && !hasPendingOwnerInput(route)) {
        const parentThread = candidate.lineage.parentThreadId ? nativeScope.byId.get(candidate.lineage.parentThreadId) : undefined;
        const parent = parentThread ? yield* native.projection(parentThread.id, cancel) : undefined;
        const run = resolveSteerableRun(route);
        if (childOrigin(route.thread, parent) === "delegated_child" && run &&
          canSupervisorContact(actor.thread, route.thread) && current(payload, binding) &&
          team.authorizeWrite(binding, payload.supervisorThreadId, String(payload.targetThreadId), parents, payload) &&
          team.authorizeWrite(binding, payload.supervisorThreadId, candidate.id, parents, payload)) return {route, parents, reason: null, freshScope: true};
      }
      candidate = candidate.lineage.parentThreadId ? nativeScope.byId.get(candidate.lineage.parentThreadId) : undefined;
    }
    return {route: null, parents, reason: "no_contactable_ancestor_in_assignment", freshScope: true};
  });
  const changedAttempt = (record: GuideRecord, attemptIndex: number, status: GuideAttempt["status"], reason?: string): GuideRecord => {
    const attempts = [...record.attempts];
    const attempt = attempts[attemptIndex];
    if (!attempt) return record;
    attempts[attemptIndex] = {...attempt, status, ...(reason ? {reason} : {})};
    return {...record, attempts, ...(attemptIndex === attempts.length - 1 ? {routedThreadId: attempt.routedThreadId,
      commandId: attempt.commandId, messageId: attempt.messageId, targetRunId: attempt.targetRunId} : {})};
  };
  const guideCommand = (attempt: GuideAttempt, textValue: string): Record<string, unknown> =>
    ({type: "message.dispatch", commandId: attempt.commandId, messageId: attempt.messageId,
      threadId: attempt.routedThreadId, text: textValue, attachments: [], createdBy: "system", creationSource: "server",
      dispatchMode: {type: "steer_active", targetRunId: attempt.targetRunId}});
  const finishRootEscalation = (payload: Payload, binding: BindingRecord, evidenceItemId: string, record: GuideRecord,
    requestRecorded: boolean): GuideRecord => {
    const summary = record.escalationSummary ??
      `A definite steer rejection left ${record.targetThreadId} without a contactable ancestor in the helper's current assignment. Root intervention is required.`;
    const escalated: GuideRecord = {...record, status: "escalated", escalationSummary: summary, reason: "root_intervention_required"};
    try {
      atomic(() => {
        team.serviceAttention(binding, {eventId: `guide-service-attention:${record.requestId}`, memberThreadId: record.supervisorThreadId,
          targetThreadId: record.targetThreadId, summary});
        if (requestRecorded) team.setRequestState(binding, binding.threadId, record.requestId, 0, "settled");
        save(payload, binding, evidenceItemId, escalated);
      });
      return escalated;
    } catch {
      const pending: GuideRecord = {...record, status: "needs_escalation", escalationSummary: summary, reason: "root_attention_recording_unavailable"};
      save(payload, binding, evidenceItemId, pending);
      return pending;
    }
  };
  // the steer, started by its admission section and awaited outside it
  const initiate = (operate: NativeRpcShape, command: Record<string, unknown>, cancel: WorkflowCallCancel): Effect.Effect<AdmittedInFlight<GuideDispatch>> =>
    Effect.map(operate.initiate("orchestration.dispatchCommand", command, cancel), (flight) => ({
      result: Effect.map(Effect.exit(flight.result), (exit): GuideDispatch => ({_tag: "Dispatched", exit})),
      release: flight.release,
    }));
  // a dispatch reply: accepted with a durable sequence, else the failure the baseline classified
  const dispatchFailure = (exit: Exit.Exit<unknown, unknown>): unknown | null => {
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause);
    return isRecord(exit.value) && Number.isSafeInteger(exit.value.sequence) ? null : new SupervisorRpcError("uncertain");
  };
  // without the operate credential the reserved attempt cannot be sent; it stays unknown, as the baseline's failed call did
  const unavailableDispatch: GuideDispatch = {_tag: "Dispatched", exit: Exit.die(new Error("native_guidance_unavailable"))};

  // after a definite rejection: a fresh route search and its records fall back to an escalation, as the baseline caught them;
  // the steer to a found route and the escalation itself fail the caller, as the baseline returned them unawaited
  const continueAfterDefiniteRejection = (payload: Payload, binding: BindingRecord, evidenceItemId: string, record: GuideRecord,
    cancel: WorkflowCallCancel): Effect.Effect<GuideRecord, TeamDenied> => {
    const summary = record.escalationSummary ??
      `A definite steer rejection left ${record.targetThreadId} without a contactable ancestor in the helper's current assignment. Root intervention is required.`;
    return Effect.gen(function* () {
      const next = yield* Effect.gen(function* () {
        const search = yield* findGuideRoute(binding, payload, false, cancel);
        if (search.route && search.reason === null) return {_tag: "Send" as const, route: search.route, parents: search.parents};
        if (search.reason === "target_pending_owner_input") {
          const deferred: GuideRecord = {...record, status: "needs_fallback", reason: search.reason};
          save(payload, binding, evidenceItemId, deferred);
          return {_tag: "Done" as const, record: deferred};
        }
        const needsEscalation: GuideRecord = {...record, status: "needs_escalation", escalationSummary: summary,
          reason: search.reason ?? "no_contactable_ancestor_in_assignment"};
        save(payload, binding, evidenceItemId, needsEscalation);
        return {_tag: "Escalate" as const, record: needsEscalation};
      }).pipe(otherwise(() => {
        const needsEscalation: GuideRecord = {...record, status: "needs_escalation", escalationSummary: summary, reason: "ancestor_route_read_unavailable"};
        save(payload, binding, evidenceItemId, needsEscalation);
        return {_tag: "Escalate" as const, record: needsEscalation};
      }));
      if (next._tag === "Send") return yield* sendGuideAttempt(payload, binding, evidenceItemId, record, next.route, next.parents, cancel);
      if (next._tag === "Done") return next.record;
      return finishRootEscalation(payload, binding, evidenceItemId, next.record, record.attempts.length > 0);
    });
  };

  const sendGuideAttempt = Effect.fnUntraced(function* (payload: Payload, binding: BindingRecord, evidenceItemId: string, record: GuideRecord,
    route: Projection, parents: ReadonlyMap<string, string | null>, cancel: WorkflowCallCancel): Effect.fn.Return<GuideRecord, TeamDenied> {
    const targetRunId = resolveSteerableRun(route)?.id;
    if (typeof targetRunId !== "string" || targetRunId.length === 0) {
      const needsEscalation: GuideRecord = {...record, status: "needs_escalation", escalationSummary:
        `A definite steer rejection left ${record.targetThreadId} without a contactable ancestor in the helper's current assignment. Root intervention is required.`,
      reason: "route_run_unavailable"};
      save(payload, binding, evidenceItemId, needsEscalation);
      return finishRootEscalation(payload, binding, evidenceItemId, needsEscalation, record.attempts.length > 0);
    }
    const reservation: {record: GuideRecord | null; attemptIndex: number} = {record: null, attemptIndex: -1};
    // a guide send (plan 3.11): the final assignment guard, the durable reservation (attempt and team request) and the steer's
    // native initiation in one admission section; the reply is awaited outside it
    const dispatch = yield* admitSend(gate, {
      identity: `${record.requestId}:command:${record.attempts.length}\u0000${yield* Ref.getAndUpdate(sends, (count) => count + 1)}`,
      inFlight,
      prepare: (guard) => Effect.sync((): SendPreparation<GuideDispatch> => atomic(() => {
        const existing = currentGuide(payload, binding);
        const latest = existing ?? record;
        const attempts = latest.attempts ?? [];
        if (existing && (latest.status !== "needs_fallback" || attempts.length !== record.attempts.length)) {
          reservation.record = latest;
          return {_tag: "Answer", value: {_tag: "Stored", record: latest}};
        }
        if (!current(payload, binding, false, guard) || !team.authorizeWrite(binding, payload.supervisorThreadId, record.targetThreadId, parents, payload) ||
          !team.authorizeWrite(binding, payload.supervisorThreadId, route.thread.id, parents, payload)) return {_tag: "Answer", value: {_tag: "AssignmentChanged"}};
        reservation.attemptIndex = attempts.length;
        const attempt: GuideAttempt = {routedThreadId: route.thread.id, commandId: `${record.requestId}:command:${reservation.attemptIndex}`,
          messageId: `${record.requestId}:message:${reservation.attemptIndex}`, targetRunId, status: "prepared"};
        const reserved: GuideRecord = {...latest, status: "prepared", routedThreadId: attempt.routedThreadId, commandId: attempt.commandId,
          messageId: attempt.messageId, targetRunId: attempt.targetRunId, attempts: [...attempts, attempt]};
        delete reserved.reason;
        delete reserved.escalationSummary;
        reservation.record = reserved;
        if (attempts.length === 0) {
          const coverage = team.coverage(binding, record.targetThreadId, parents);
          team.recordRequest(binding, {requestId: record.requestId, memberThreadId: payload.supervisorThreadId,
            memberEpoch: coverage.memberEpoch ?? 0, targets: [{targetThreadId: record.targetThreadId,
              assignmentRootThreadId: coverage.assignmentRootThreadId ?? binding.mainThreadId, assignmentEpoch: coverage.assignmentEpoch ?? 0}], parentById: parents});
        }
        save(payload, binding, evidenceItemId, reserved);
        return rpc ? {_tag: "Initiate", initiate: initiate(rpc, guideCommand(attempt, record.text), cancel)} : {_tag: "Answer", value: unavailableDispatch};
      })),
      // the original was interrupted after its initiation: its receipt keeps the reserved identities for reconciliation
      reconcile: Effect.sync((): GuideDispatch => ({_tag: "Stored", record: currentGuide(payload, binding) ?? reservation.record ?? record})),
    });
    if (dispatch._tag === "AssignmentChanged") return yield* new TeamDenied({reason: "guidance_assignment_changed"});
    if (dispatch._tag === "Stored") return dispatch.record;
    const prepared = reservation.record!;
    const attemptIndex = reservation.attemptIndex;
    const attempt = prepared.attempts[attemptIndex]!;
    const command = guideCommand(attempt, record.text);
    const acceptedResult = (latest: GuideRecord): GuideRecord => {
      const result = {...changedAttempt(latest, attemptIndex, "accepted"), status: "accepted" as const,
        reason: "Native steer command accepted; late completion can still start a turn. Do not send another route."};
      save(payload, binding, evidenceItemId, result);
      return result;
    };
    const rejectedResult = Effect.fnUntraced(function* (latest: GuideRecord, cause: unknown): Effect.fn.Return<GuideRecord, TeamDenied> {
      if (cause instanceof SupervisorRpcError && cause.outcome === "rejected" && !cause.definiteRejection) {
        const notSent: GuideRecord = {...changedAttempt(latest, attemptIndex, "not_sent", "native_transport_not_sent"),
          status: "not_sent", reason: "native_transport_not_sent"};
        save(payload, binding, evidenceItemId, notSent);
        team.setRequestState(binding, binding.threadId, record.requestId, 0, "settled");
        return notSent;
      }
      const definite = cause instanceof SupervisorRpcError && cause.definiteRejection;
      if (definite && attemptIndex === 0 && attempt.routedThreadId === record.targetThreadId) {
        const rejected = {...changedAttempt(latest, attemptIndex, "rejected", "native_steer_rejected"), status: "needs_fallback" as const,
          reason: "native_steer_rejected"};
        save(payload, binding, evidenceItemId, rejected);
        return yield* continueAfterDefiniteRejection(payload, binding, evidenceItemId, rejected, cancel);
      }
      if (definite) {
        const needsEscalation: GuideRecord = {...changedAttempt(latest, attemptIndex, "rejected", "native_steer_rejected"),
          status: "needs_escalation", escalationSummary:
            `A definite steer rejection left ${record.targetThreadId} without a contactable ancestor in the helper's current assignment. Root intervention is required.`,
          reason: "native_steer_rejected"};
        save(payload, binding, evidenceItemId, needsEscalation);
        return finishRootEscalation(payload, binding, evidenceItemId, needsEscalation, true);
      }
      const reason = cause instanceof SupervisorRpcError && cause.dispatchCommandFailure
        ? "dispatch_failure_replay_requires_reconciliation" : "original_send_requires_reconciliation";
      const uncertain: GuideRecord = {...changedAttempt(latest, attemptIndex, "uncertain", reason), status: "uncertain", reason};
      save(payload, binding, evidenceItemId, uncertain);
      team.setRequestState(binding, binding.threadId, record.requestId, 0, "uncertain");
      return uncertain;
    });
    const first = dispatchFailure(dispatch.exit);
    if (first === null) {
      try {return acceptedResult(prepared);} catch (cause) {return yield* rejectedResult(prepared, cause);}
    }
    if (!(first instanceof SupervisorRpcError) || !first.dispatchCommandFailure) return yield* rejectedResult(prepared, first);
    // a received dispatch-command failure: exactly one replay of the identical command, reserved durably before it is sent
    // again; like the baseline it rechecks no guard after the awaited reply (L-02)
    const replayState: {record: GuideRecord | null; reserved: boolean} = {record: null, reserved: false};
    const replay = yield* admitSend(gate, {
      identity: `${attempt.commandId}:replay\u0000${yield* Ref.getAndUpdate(sends, (count) => count + 1)}`,
      inFlight,
      prepare: () => Effect.sync((): SendPreparation<GuideDispatch> => {
        atomic(() => {
          const latest = currentGuide(payload, binding) ?? prepared;
          const latestAttempt = latest.attempts?.[attemptIndex];
          if (!latestAttempt || latestAttempt.dispatchFailureReplayAttempted || latestAttempt.status !== "prepared") {
            replayState.record = latest;
            return;
          }
          const attempts = [...latest.attempts];
          attempts[attemptIndex] = {...latestAttempt, status: "replaying", dispatchFailureReplayAttempted: true,
            reason: "received_dispatch_command_failure"};
          replayState.record = {...latest, attempts, status: "replaying"};
          replayState.reserved = true;
          save(payload, binding, evidenceItemId, replayState.record);
        });
        if (!replayState.reserved || !replayState.record) return {_tag: "Answer", value: {_tag: "Stored", record: replayState.record ?? prepared}};
        return rpc ? {_tag: "Initiate", initiate: initiate(rpc, command, cancel)} : {_tag: "Answer", value: unavailableDispatch};
      }),
      reconcile: Effect.sync((): GuideDispatch => ({_tag: "Stored", record: currentGuide(payload, binding) ?? replayState.record ?? prepared})),
    });
    if (replay._tag !== "Dispatched") return replay._tag === "Stored" ? replay.record : prepared;
    const replaying = replayState.record!;
    const second = dispatchFailure(replay.exit);
    if (second === null) {
      try {return acceptedResult(replaying);} catch (cause) {return yield* rejectedResult(currentGuide(payload, binding) ?? replaying, cause);}
    }
    return yield* rejectedResult(currentGuide(payload, binding) ?? replaying, second);
  });

  const guide = Effect.fnUntraced(function* (input: unknown, cancel: WorkflowCallCancel): Effect.fn.Return<unknown, TeamDenied> {
    const payload = parse(input, decodeGuideArguments);
    if (!payload) return {status: "invalid", reason: "invalid_guidance_arguments"};
    const proof = yield* workflows.authorizeNative(payload, "guide", false, cancel);
    if (proof.status !== "verified") return proof;
    const binding = proof.binding;
    const prior = receipt(payload, binding);
    if (prior && prior.hash !== workflowRequestHash(payload)) return fail("operation_id_conflict");
    if (!rpc) return fail("native_guidance_unavailable");
    if (payload.supervisorThreadId === binding.threadId) return fail("helper_guidance_only_use_main_dialogue");
    // the reads and records of the guide itself fall back to guidance_native_read_unavailable, as the baseline caught them; a
    // continued fallback, an escalation and a send fail the caller, as the baseline returned them unawaited
    const next = yield* Effect.gen(function* () {
      if (prior) {
        const original = prior.value as GuideRecord;
        if (!Array.isArray(original.attempts)) {
          const projection = yield* native.projection(original.routedThreadId, cancel);
          if (projection.messages.some(message => message.id === original.messageId && message.threadId === original.routedThreadId && message.text === payload.text)) {
            const result = {...original, status: "delivered"};save(payload, binding, proof.evidence.itemId, result);
            team.setRequestState(binding, binding.threadId, original.requestId, 0, "settled");return {_tag: "Done" as const, value: result as unknown};
          }
          return {_tag: "Done" as const, value: {...original, status: "uncertain", reason: "original_send_requires_reconciliation"} as unknown};
        }
        if (["accepted", "delivered", "denied", "escalated", "not_sent"].includes(original.status)) return {_tag: "Done" as const, value: prior.value as unknown};
        if (original.status === "needs_fallback") return {_tag: "Fallback" as const, record: original};
        if (original.status === "needs_escalation") return {_tag: "Escalate" as const, record: original};
        if (original.routedThreadId) {
          const projection = yield* native.projection(original.routedThreadId, cancel);
          const message = projection.messages.find(item => item.id === original.messageId && item.threadId === original.routedThreadId && item.text === payload.text &&
            item.createdBy === "user" && item.creationSource === "server");
          if (message) {
            const result = {...original, status: "delivered"};save(payload, binding, proof.evidence.itemId, result);
            team.setRequestState(binding, binding.threadId, original.requestId, 0, "settled");
            if (message.runId && message.runId !== original.targetRunId) team.serviceAttention(binding, {
              eventId: `late-guide:${original.requestId}`, memberThreadId: original.supervisorThreadId, targetThreadId: original.targetThreadId,
              summary: `The native steer reached a new run in ${original.routedThreadId} after the targeted run ended. Stop further direct guidance and assess whether its operational parent needs attention.`});
            return {_tag: "Done" as const, value: result as unknown};
          }
        }
        const uncertain: GuideRecord = {...original, status: "uncertain", reason: "original_send_requires_reconciliation"};
        save(payload, binding, proof.evidence.itemId, uncertain);
        return {_tag: "Done" as const, value: uncertain as unknown};
      }
      if (team.unresolvedRequests(binding).some(request => request.requestId.startsWith("guide:") &&
        request.targets.some(target => target.targetThreadId === payload.targetThreadId)))
        return {_tag: "Done" as const, value: {status: "pending", reason: "prior_guidance_requires_reconciliation"} as unknown};
      const record = guideRecord(payload, binding);
      const search = yield* findGuideRoute(binding, payload, true, cancel);
      if (!search.route) {
        if (search.reason !== "no_contactable_ancestor_in_assignment" && search.reason !== "ancestor_outside_current_assignment")
          return {_tag: "Done" as const, value: fail(search.reason ?? "no_contactable_ancestor_in_assignment_escalated") as unknown};
        // the escalation of a walk without a route (plan 3.11): the actor's binding, scope and per-chat stop rechecked with the
        // admission guard, as the reservation does, and the escalation event with the helper's last assessment in one section;
        // a scope stopped or disabled during the walk writes nothing and refuses as the walk's own recheck does
        const escalated = yield* gate.admit((guard) => Effect.sync(() => {
          if (!current(payload, binding, false, guard)) return false;
          team.escalate(binding, {eventId: `guide-escalation:${workflowRequestHash(payload)}`, actorThreadId: payload.supervisorThreadId,
            memberEpoch: payload.memberEpoch!, targets: [{targetThreadId: String(payload.targetThreadId),
              assignmentRootThreadId: payload.assignmentRootThreadId!, assignmentEpoch: payload.assignmentEpoch!}], parentById: search.parents,
            summary: `Guidance needs root attention for ${String(payload.targetThreadId)}: ${String(payload.text).slice(0, 3000)}`});
          return true;
        }));
        return {_tag: "Done" as const, value: fail(escalated ? "no_contactable_ancestor_in_assignment_escalated" : "guidance_assignment_changed") as unknown};
      }
      if (!current(payload, binding) || !team.authorizeWrite(binding, payload.supervisorThreadId, record.targetThreadId, search.parents, payload) ||
        !team.authorizeWrite(binding, payload.supervisorThreadId, search.route.thread.id, search.parents, payload)) {
        return {_tag: "Done" as const, value: fail("assignment_changed") as unknown};
      }
      return {_tag: "Send" as const, record, route: search.route, parents: search.parents};
    }).pipe(otherwise(() => ({_tag: "Done" as const, value: fail("guidance_native_read_unavailable") as unknown})));
    if (next._tag === "Done") return next.value;
    if (next._tag === "Fallback") return yield* continueAfterDefiniteRejection(payload, binding, proof.evidence.itemId, next.record, cancel);
    if (next._tag === "Escalate") return finishRootEscalation(payload, binding, proof.evidence.itemId, next.record, next.record.attempts.length > 0);
    return yield* sendGuideAttempt(payload, binding, proof.evidence.itemId, next.record, next.route, next.parents, cancel);
  });

  const reconcile = Effect.fnUntraced(function* (binding: BindingRecord, stopped: boolean, cancel: WorkflowCallCancel) {
    const now = yield* Clock.currentTimeMillis;
    const members = team.snapshot(binding).members;
    const actors = new Set(members.map(member => member.threadId));
    const rows = db.prepare("SELECT actor_thread_id,actor_epoch,operation_id,evidence_item_id,document FROM supervisor_team_tool_receipts WHERE owner_thread_id=? AND binding_generation=? AND json_extract(document,'$.requestId') LIKE 'guide:%' AND json_extract(document,'$.status') IN ('prepared','replaying','needs_fallback','needs_escalation','accepted','uncertain') ORDER BY rowid")
      .all(binding.threadId, binding.generation).filter(row => actors.has(String(row.actor_thread_id)));
    // four receipts per cycle, from a rotating offset
    const offset = yield* Ref.modify(reconcileOffsets, (offsets): [number, HashMap.HashMap<string, number>] => {
      const next = rows.length ? Option.getOrElse(HashMap.get(offsets, binding.threadId), () => 0) % rows.length : 0;
      return [next, HashMap.set(offsets, binding.threadId, next + 4)];
    });
    for (const row of [...rows.slice(offset), ...rows.slice(0, offset)].slice(0, 4)) {
      if (yield* Deferred.isDone(cancel)) return;
      const value = JSON.parse(String(row.document)) as GuideRecord;
      // native uncertainty retains the original route and identities
      yield* Effect.gen(function* () {
        const payload = guidePayload(value);
        if (stopped && (value.status === "needs_fallback" || value.status === "needs_escalation")) {
          atomic(() => {
            db.prepare("UPDATE supervisor_team_tool_receipts SET document=? WHERE owner_thread_id=? AND actor_thread_id=? AND binding_generation=? AND actor_epoch=? AND operation_id=?")
              .run(JSON.stringify({...value, status: "not_sent"}), binding.threadId, String(row.actor_thread_id), binding.generation, Number(row.actor_epoch), String(row.operation_id));
            if (team.unresolvedRequests(binding).some(item => item.requestId === value.requestId)) team.setRequestState(binding, binding.threadId, value.requestId, 0, "settled");
          });
          return;
        }
        if (value.status === "needs_fallback") {
          const result = yield* continueAfterDefiniteRejection(payload, binding, String(row.evidence_item_id), value, cancel);
          if (result.status === "needs_fallback" && result.reason === "target_pending_owner_input") {
            const request = team.unresolvedRequests(binding).find(item => item.requestId === value.requestId);
            if (!(yield* Deferred.isDone(cancel)) && request && now - request.updatedAt >= unresolvedGuideAttentionGraceMs) team.serviceAttention(binding, {
              eventId: `guide-deferred:${value.requestId}`, memberThreadId: String(row.actor_thread_id), targetThreadId: value.targetThreadId,
              summary: `Guidance for ${value.targetThreadId} is deferred for a pending native owner decision. The question has not been answered and no ancestor route has been sent.`}, now);
          }
          return;
        }
        if (value.status === "needs_escalation") {
          finishRootEscalation(payload, binding, String(row.evidence_item_id), value, value.attempts?.length > 0);
          return;
        }
        if (!value.routedThreadId || !value.messageId) return;
        const projection = yield* native.projection(value.routedThreadId, cancel).pipe(otherwise(() => null));
        const message = projection?.messages.find(item => item.id === value.messageId && item.threadId === value.routedThreadId && item.text === value.text &&
          item.createdBy === "user" && item.creationSource === "server");
        if (message) {
          atomic(() => {
            const result = {...value, status: "delivered" as const};
            db.prepare("UPDATE supervisor_team_tool_receipts SET document=? WHERE owner_thread_id=? AND actor_thread_id=? AND binding_generation=? AND actor_epoch=? AND operation_id=?")
              .run(JSON.stringify(result), binding.threadId, String(row.actor_thread_id), binding.generation, Number(row.actor_epoch), String(row.operation_id));
            team.setRequestState(binding, binding.threadId, value.requestId, 0, "settled");
            if (message.runId && message.runId !== value.targetRunId) team.serviceAttention(binding, {
              eventId: `late-guide:${value.requestId}`, memberThreadId: String(row.actor_thread_id), targetThreadId: value.targetThreadId,
              summary: `The native steer reached a new run in ${value.routedThreadId} after the targeted run ended. Stop further direct guidance and assess whether its operational parent needs attention.`});
          });
          return;
        }
        const request = team.unresolvedRequests(binding).find(item => item.requestId === value.requestId);
        if (!(yield* Deferred.isDone(cancel)) && request && now - request.updatedAt >= unresolvedGuideAttentionGraceMs) team.serviceAttention(binding, {
          eventId: `guide-unresolved:${value.requestId}`, memberThreadId: String(row.actor_thread_id), targetThreadId: value.targetThreadId,
          summary: `A native guidance send to ${value.targetThreadId} remains unresolved after its reconciliation grace period. Its original target and command identities are retained; no alternate route is attempted.`});
      }).pipe(otherwise(() => undefined));
    }
  });

  return SupervisorTeamController.of({
    call: (input, cancel) => withCancel(cancel, (bounded) => call(input, bounded)),
    guide: (input, cancel) => withCancel(cancel, (bounded) => guide(input, bounded)),
    reconcile: (binding, stopped = false, cancel) => withCancel(cancel, (bounded) => reconcile(binding, stopped, bounded)),
    reconcileStopped: (binding, cancel) => withCancel(cancel, (bounded) => reconcile(binding, true, bounded)),
  });
});

// the team controller: team changes and helper guidance under verified native proof, receipts and the admission section
export class SupervisorTeamController extends Context.Service<SupervisorTeamController, SupervisorTeamControllerShape>()("t3-supervisor/SupervisorTeamController") {
  static readonly make = makeSupervisorTeamController;
  static readonly layer = (options: SupervisorTeamControllerOptions = {}): Layer.Layer<SupervisorTeamController, never,
    WorkflowWriteController | WorkflowNativeAccess | SupervisionGate | HelperTransport | SupervisionStores> =>
    Layer.effect(SupervisorTeamController, makeSupervisorTeamController(options));
  // b-03 (plan 3.9): the promise call shapes the unported workflow mcp endpoint and ProjectSupervisor type this name with; the
  // root facade (guidance-application.ts) is their only value, and they go when those callers consume the service
  declare readonly call: SupervisorTeamControllerPromises["call"];
  declare readonly guide: SupervisorTeamControllerPromises["guide"];
  declare readonly reconcile: SupervisorTeamControllerPromises["reconcile"];
  declare readonly reconcileStopped: SupervisorTeamControllerPromises["reconcileStopped"];
}
