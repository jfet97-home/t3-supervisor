import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { nativeUserMessageVisible, timestampMs } from "./domain.js";
import { fingerprint } from "./guidance-store.js";
import { isSupervisorThread, prepareStopNotice, type BindingRecord, type ProjectSupervisorStore, type SupervisionStartRecord } from "./project-supervisor-store.js";
import type { StoreShape } from "./store.js";
import type { LegacyAdmission, SupervisionScope } from "./supervision-gate.js";
import type { SupervisorConversation } from "./supervisor-conversation.js";
import { introductionOutcomeUnknown } from "./supervisor-conversation-store.js";
import { mainConversation } from "./supervisor-scope.js";
import type { T3ClientShape } from "./t3.js";
import type { ThreadPolicySettings } from "./thread-policy-contract.js";
import type { MessageInfo, Projection, SupervisorConfig } from "./types.js";
import type { SupervisionStartInput, SupervisionStartResult, SupervisionStopInput, SupervisionStopResult } from "./workflow-write-controller.js";

// an exact whole-token mention of a chat ID; a prefix of a longer ID never names that chat
const namesThread = (text: string, threadId: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9:_%.-])${threadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9:_%-]|\\.[A-Za-z0-9:_%-])`, "u").test(text);

// Start, Stop and Enable (plan 3.9 dependency extraction, moved verbatim from ProjectSupervisor): the requested Start
// operations, the explicit Stop/Enable policy writes and their guidance bookkeeping; it depends only on lower objects
// (the scope predicates, the catalog, projections, the interim stores and the conversation fence)
export class SupervisionControl {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(readonly config: SupervisorConfig, readonly store: ProjectSupervisorStore, readonly gate: SupervisionScope,
    readonly source: Pick<StoreShape, "catalog">, readonly t3: Pick<T3ClientShape, "projection">, readonly conversation: SupervisorConversation,
    private readonly operateRpcAvailable: boolean, private readonly now: () => number, private readonly admission: LegacyAdmission) {}
  private async serial<A>(key: string, work: () => Promise<A>): Promise<A> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);this.queues.set(key, next);
    try {return await next;} finally {if (this.queues.get(key) === next) this.queues.delete(key);}
  }
  private async projection(threadId: string, signal: AbortSignal): Promise<Projection> {return (await Effect.runPromise(this.t3.projection(threadId), {signal})).projection;}
  rejectStart(start: SupervisionStartRecord, reason: string): void {
    if (this.store.start(start.threadId)?.operationId === start.operationId) this.store.saveStart({...start, status: "rejected", reason});
  }
  activateStart(start: SupervisionStartRecord): boolean {
    if (!this.gate.validPendingStart(start)) return false;
    // pending is durable before the separate policy write; a crash cannot grant on-request effects without the committed permission
    const written = this.writeChatPolicy(start.threadId, false);
    if (written.status !== "saved") return false;
    this.store.recordChatEnable(start.threadId, start.intentAt);
    this.applyChatStop(start.threadId, null);
    this.store.saveStart({...start, status: "active", reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor."});
    return true;
  }
  startStatus(threadId: string, operationId: string) {
    const operation = this.store.startOperation(threadId, operationId);
    return operation ? {threadId, operationId, status: operation.status, reason: operation.reason}
      : {threadId, operationId, status: "denied" as const, reason: "No matching Start operation is recorded. Nothing was replayed."};
  }
  private async requestStart(threadId: string, operationId: string, route: "agent" | "ui", userMessageId: string | null,
    runId: string | null, signal: AbortSignal): Promise<SupervisionStartResult> {
    const requestHash = fingerprint({threadId, operationId, route, userMessageId});
    const prior = this.store.startOperation(threadId, operationId);
    if (prior) return prior.requestHash === requestHash ? {status: prior.status, reason: prior.reason} : {status: "denied", reason: "operation_id_conflict"};
    if (!threadId || threadId.length > 512 || !operationId || operationId.length > 512) return {status: "invalid", reason: "invalid_start_arguments"};
    this.store.saveStartOperation({threadId, operationId, requestHash, status: "pending", reason: "Checking the requested chat and original human source.", preparing: true});
    let result: SupervisionStartResult;
    try {result = await this.evaluateStart(threadId, operationId, route, userMessageId, runId, signal);}
    catch {result = {status: "unavailable", reason: "Start preparation failed before activation. Use a new explicit request after inspecting this outcome."};}
    const saved = this.store.startOperation(threadId, operationId);
    if (saved?.preparing) this.store.saveStartOperation({threadId, operationId, requestHash, status: result.status === "invalid" ? "denied" : result.status, reason: result.reason});
    return result;
  }
  private async evaluateStart(threadId: string, operationId: string, route: "agent" | "ui", userMessageId: string | null,
    runId: string | null, signal: AbortSignal): Promise<SupervisionStartResult> {
    if (!threadId || threadId.length > 512 || !operationId || operationId.length > 512 || /[\s\x00-\x1f\x7f]/u.test(operationId)) return {status: "invalid", reason: "invalid_start_arguments"};
    const catalog = await Effect.runPromise(this.source.catalog());
    this.gate.rememberScratchProjects(catalog.projects.map(item => item.project));
    const thread = catalog.threads.find(item => item.id === threadId);
    if (!thread?.projectId || !this.gate.mainShape(thread) || mainConversation(thread, catalog.threads)?.id !== threadId ||
      !catalog.projects.some(item => item.available && item.project.id === thread.projectId) || !this.gate.isNoProject(thread.projectId))
      return {status: "denied", reason: "own_ordinary_no_project_chat_required"};
    const mode = this.store.noProjectControl();const master = this.store.control(null);
    if (!this.operateRpcAvailable || !this.store.scopeCompatible || !master.enabled || mode.mode === "off") return {status: "denied", reason: "master_or_no_project_mode_off"};
    const requestHash = fingerprint({threadId, operationId, route, userMessageId});
    const previous = this.store.start(threadId);
    if (previous?.operationId === operationId) return previous.requestHash === requestHash
      ? {status: previous.status, reason: previous.reason} : {status: "denied", reason: "operation_id_conflict"};
    if (previous?.status === "pending") return {status: "denied", reason: "An earlier Start is unresolved. Reconcile its operation ID before another request."};
    const projection = await this.projection(threadId, signal);
    const projectId = thread.projectId;
    // t-07: from the last await, the rechecks, the start record and a dashboard activation run as one admission section
    return this.admission.run((): SupervisionStartResult => {
    if (projection.thread.projectId !== thread.projectId || !this.gate.mainShape(projection.thread)) return {status: "denied", reason: "scope_changed"};
    let message = userMessageId ? this.genuineUserMessage(projection, userMessageId) : null;
    const latestHuman = [...projection.messages].filter(item => this.genuineUserMessage(projection, item.id)).sort((a,b) => (timestampMs(b.createdAt) ?? 0) - (timestampMs(a.createdAt) ?? 0)).at(0);
    if (route === "agent" && (!message || message.runId !== runId || latestHuman?.id !== message.id)) return {status: "denied", reason: "start_call_not_in_genuine_human_turn"};
    if (route === "ui") message = latestHuman && projection.runs.some(run => run.id === latestHuman.runId && ["preparing", "queued", "starting", "running", "waiting"].includes(run.status)) ? latestHuman : null;
    if (message && message.text.length > 24_000) return {status: "denied", reason: "start_source_too_large"};
    const intentAt = route === "agent" ? timestampMs(message?.createdAt) : this.now();
    if (intentAt === null || (this.store.chatStop(threadId)?.stoppedAt ?? -1) >= intentAt || (this.store.chatEnabledAt(threadId) ?? -1) >= intentAt)
      return {status: "denied", reason: "superseded_by_later_stop_or_enable"};
    const task = this.store.task(threadId);
    const intro = task ? this.conversation.requests.introduction(task.id) : null;
    if (task && ["queued", "dispatching", "waiting", "uncertain"].includes(task.status) || intro && introductionOutcomeUnknown(intro))
      return {status: "denied", reason: "Existing native work has an unresolved outcome; its original identities must be reconciled first."};
    if (previous?.status === "active" && !this.gate.supervisionStopped(threadId)) return {status: "active", reason: previous.reason};
    if (mode.generation !== this.store.noProjectControl().generation || master.generation !== this.store.control(null).generation || !this.store.control(null).enabled)
      return {status: "denied", reason: "scope_mode_changed"};
    const run = message ? projection.runs.find(item => item.id === message!.runId)! : null;
    const record: SupervisionStartRecord = {threadId, projectId, operationId, requestHash, route, status: "pending",
      reason: "Waiting for the Supervisor's first source-bound Start interpretation.", intentAt, modeGeneration: mode.generation, masterGeneration: master.generation,
      taskId: message ? randomUUID() : null, ...(message && run ? {source: {messageId: message.id, runId: run.id, ordinal: run.ordinal, hash: fingerprint(message.text)}} : {})};
    this.store.saveStart(record);
    if (route === "ui") {
      if (!this.store.store.transaction(() => this.activateStart(record))) {this.rejectStart(record, "Start could not be committed.");return {status: "unavailable", reason: "Start was not activated."};}
      return {status: "active", reason: this.store.start(threadId)!.reason};
    }
    return {status: "pending", reason: record.reason};
    });
  }
  /** The agent can request only its own chat; exact native wire evidence has already been verified. */
  startSupervision(input: SupervisionStartInput, evidence: {runId: string}, signal: AbortSignal): Promise<SupervisionStartResult> {
    return this.serial(`start:${input.callerThreadId}`, () => this.requestStart(input.callerThreadId, input.operationId, "agent", input.userMessageId, evidence.runId, signal));
  }
  dashboardStart(threadId: string, operationId: string, signal: AbortSignal): Promise<SupervisionStartResult> {
    return this.serial(`start:${threadId}`, () => this.requestStart(threadId, operationId, "ui", null, null, signal));
  }
  writeChatPolicy(threadId: string, stopped: boolean, expectedGeneration?: number):
    {status: "saved"; changed: boolean} | {status: "conflict" | "unavailable" | "full"} {
    const policy = this.config.threadPolicy;
    if (!policy) return {status: "unavailable"};
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = policy.get();
      if (expectedGeneration !== undefined && current.generation !== expectedGeneration) return {status: "conflict"};
      if (current.excludedThreadIds.includes(threadId) === stopped) return {status: "saved", changed: false};
      if (stopped && current.excludedThreadIds.length >= 500) return {status: "full"};
      try {
        policy.save({...current, excludedThreadIds: stopped ? [...current.excludedThreadIds, threadId] : current.excludedThreadIds.filter(id => id !== threadId)});
        return {status: "saved", changed: true};
      } catch {if (expectedGeneration !== undefined) return {status: "conflict"};}
    }
    return {status: "conflict"};
  }
  // records the stop and a single operative notice, and fences unsent check-ins without cancelling operative work.
  // a stop supersedes any earlier keep-active choice for the owned Supervisor, so its settlement is not vetoed by an older intent.
  applyChatStop(threadId: string, stop: NonNullable<BindingRecord["supervisionStop"]> | null): void {
    const start = this.store.start(threadId);
    if (stop && start?.status === "pending" && stop.stoppedAt >= start.intentAt)
      this.store.saveStart({...start, status: "rejected", reason: "Superseded by a later Stop."});
    const bindings = this.store.bindings().filter(item => item.mainThreadId === threadId);
    if (!bindings.length) this.store.saveUnboundStop(threadId, stop);
    for (const binding of bindings) {
      const write = () => {
        this.store.setSupervisionStop(binding, stop);
        const notice = binding.stopNotice;
        const enabledAt = this.store.chatEnabledAt(threadId);
        if (stop && (!notice || notice.enabledAt !== enabledAt && ["sent", "blocked", "superseded"].includes(notice.state)))
          this.store.setStopNotice(binding, notice?.messageId ?? null, prepareStopNotice(binding, stop.stoppedAt, enabledAt));
        else if (stop && notice?.state === "unconfirmed") this.store.setStopNotice(binding, notice.messageId, {...notice, state: "uncertain", visibilityMisses: 0, nextObserveAt: this.now()});
        else if (!stop && notice?.state === "ready") this.store.setStopNotice(binding, notice.messageId, {...notice, state: "superseded"});
      };
      if (this.store.store.db.isTransaction) write(); else this.store.store.transaction(write);
      if (stop) this.conversation.fenceStoppedSupervision(this.store.binding(binding.projectId, binding.mainThreadId)!);
    }
  }
  genuineUserMessage(projection: Projection, messageId: string): MessageInfo | null {
    const message = projection.messages.find(item => item.id === messageId && item.threadId === projection.thread.id);
    const run = message?.runId ? projection.runs.find(item => item.id === message.runId && item.threadId === projection.thread.id) : undefined;
    return message && run && message.role === "user" && message.createdBy === "user" && !message.streaming &&
      (message.creationSource === "web" || message.creationSource === "mobile") && !message.senderThreadId && !message.scheduledTaskId && !message.source &&
      !message.id.startsWith("supervisor-notice:") && nativeUserMessageVisible(projection, run, message) ? message : null;
  }
  /**
   * Applies a verified supervision_stop. The caller's own native tool call is already verified; this resolves the route from the
   * caller's relation to the exact target and requires the human's original native message: in the bound root or its main (direct,
   * relay), in the main itself (relay), or in another ordinary chat whose message names the exact target ID (chat).
   */
  async stopSupervision(input: SupervisionStopInput, evidence: unknown, signal: AbortSignal): Promise<SupervisionStopResult> {
    const catalog = await Effect.runPromise(this.source.catalog());
    const target = catalog.threads.find(thread => thread.id === input.targetThreadId);
    if (!target || isSupervisorThread(this.config, target) || target.lineage.relationshipToParent === "subagent" ||
      mainConversation(target, catalog.threads)?.id !== target.id) return {status: "denied", reason: "target_not_main_conversation"};
    const binding = this.store.bindingForSupervisor(input.callerThreadId);
    if (binding && (binding.mainThreadId !== target.id || binding.state !== "ready")) return {status: "denied", reason: "target_outside_supervisor_scope"};
    let caller: Projection;
    try {caller = await this.projection(input.callerThreadId, signal);} catch {return {status: "unavailable", reason: "caller_projection_unavailable", retryable: true};}
    let candidates: Array<{threadId: string; route: "direct" | "relay" | "chat"}>;
    if (binding) {
      candidates = [{threadId: input.callerThreadId, route: "direct"}, {threadId: target.id, route: "relay"}];
    } else if (isSupervisorThread(this.config, caller.thread)) return {status: "denied", reason: "supervisor_thread_not_bound_to_target"};
    else if (input.callerThreadId === target.id) candidates = [{threadId: target.id, route: "relay"}];
    else candidates = [{threadId: input.callerThreadId, route: "chat"}];
    const startedAt = this.now();
    for (const candidate of candidates) {
      let projection: Projection;
      try {projection = candidate.threadId === input.callerThreadId ? caller : await this.projection(candidate.threadId, signal);}
      catch {return {status: "unavailable", reason: "evidence_projection_unavailable", retryable: true};}
      // t-07: from the last await, the source checks, the policy write and its bookkeeping run as one admission section
      const outcome = await this.admission.run((): SupervisionStopResult | null => {
      const message = this.genuineUserMessage(projection, input.userMessageId);
      if (!message) return null;
      // the calling assistant judges that the human asked to stop; the service only verifies provenance, target and ordering
      const words = message.text;
      // a human message that names another chat's ID authorizes only that chat, never the agent's choice of a different one, and
      // naming any second chat, the caller's own, a child or another Supervisor included, leaves the choice to the human; only the
      // target's own Supervisor conversation may be named alongside it
      const namesTarget = namesThread(words, target.id);
      const pairedSupervisorId = this.store.bindings().find(item => item.mainThreadId === target.id)?.threadId;
      if (catalog.threads.some(thread => thread.id !== target.id && thread.id !== pairedSupervisorId && namesThread(words, thread.id)))
        return {status: "denied", reason: namesTarget ? "target_ambiguous" : "target_not_named_by_user"};
      // a request from another chat must name the exact target so the human, not the agent, selects the stopped scope
      if (candidate.route === "chat" && !namesTarget) return {status: "denied", reason: "target_not_named_by_user"};
      // a stop instruction older than the latest explicit Enable never reverses it, including a replayed tool call
      const enabledAt = Math.max(this.store.chatEnabledAt(target.id) ?? -1, (this.store.start(target.id)?.status === "rejected" ? -1 : this.store.start(target.id)?.intentAt) ?? -1);
      if (enabledAt !== null && !(Date.parse(message.createdAt) > enabledAt)) return {status: "denied", reason: "superseded_by_later_enable"};
      // when the caller acts in the chat the human wrote in, its verified native call must answer that message, not a later unrelated turn
      const verifiedRunId = typeof evidence === "object" && evidence !== null && typeof (evidence as {runId?: unknown}).runId === "string" ? (evidence as {runId: string}).runId : null;
      if (verifiedRunId !== null && candidate.threadId === input.callerThreadId && verifiedRunId !== message.runId)
        return {status: "denied", reason: "stop_call_not_in_human_turn"};
      const route = candidate.route;
      const instructedAt = Number.isFinite(Date.parse(message.createdAt)) ? Date.parse(message.createdAt) : startedAt;
      const recorded = this.store.chatStop(target.id);
      const written = this.writeChatPolicy(target.id, true);
      if (written.status !== "saved") return {status: "unavailable", reason: `thread_policy_${written.status}`, retryable: written.status === "conflict"};
      // the stop dates from the human's instruction; a replay or an older instruction keeps the recorded stop, so a keep-active
      // the human chose after it still holds, while a newer human stop supersedes that choice
      if (written.changed || !recorded || recorded.stoppedAt < instructedAt)
        this.applyChatStop(target.id, {route, callerThreadId: input.callerThreadId, userMessageId: input.userMessageId, stoppedAt: instructedAt});
      return {status: "stopped", targetThreadId: target.id, route, alreadyStopped: !written.changed};
      });
      if (outcome) return outcome;
    }
    return {status: "denied", reason: "user_message_not_genuine"};
  }
  /**
   * The Settings excluded-chat editor saves the same list as Stop supervision, so each chat it removes or adds gets the same
   * explicit Enable or Stop record as the dashboard control: a replayed stop never reverses that Enable.
   */
  saveThreadPolicy(input: ThreadPolicySettings): Effect.Effect<ThreadPolicySettings, unknown> {
    // t-02/t-07: the save and its Stop/Enable bookkeeping as one admission section, yielded by the handler
    return this.admission.effect(() => {
    const policy = this.config.threadPolicy;
    if (!policy) throw new Error("Chat settings unavailable.");
    const before = policy.get();
    if (before.generation !== input.generation) throw new Error("Chat settings changed in another tab. Reload first.");
    const saved = policy.save(input);
    const now = this.now();
    for (const id of before.excludedThreadIds.filter(id => !saved.excludedThreadIds.includes(id))) {this.store.recordChatEnable(id, now);this.applyChatStop(id, null);}
    for (const id of saved.excludedThreadIds.filter(id => !before.excludedThreadIds.includes(id)))
      this.applyChatStop(id, {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: now});
    return saved;
    });
  }
}
