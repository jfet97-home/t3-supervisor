import { Cause, Clock, Context, Data, Deferred, Effect, Layer, Option } from "effect";
import { nativeUserMessageVisible, timestampMs } from "./domain.js";
import { fingerprint } from "./guidance-store.js";
import { SupervisorIds } from "./ids.js";
import { isSupervisorThread, prepareStopNotice, type BindingRecord, type SupervisionStartRecord } from "./project-supervisor-store.js";
import { ScopeLocks } from "./scope-locks.js";
import { Store, type StoreError } from "./store.js";
import { SupervisionGate, SupervisionScopeService } from "./supervision-gate.js";
import { SupervisionStores } from "./supervision-stores.js";
import { SupervisorConversation } from "./supervisor-conversation.js";
import { introductionOutcomeUnknown } from "./supervisor-conversation-store.js";
import { NativeOperateRpc } from "./supervisor-native.js";
import { mainConversation } from "./supervisor-scope.js";
import { T3Client, type T3TransportError } from "./t3.js";
import type { ThreadPolicySettings } from "./thread-policy-contract.js";
import type { MessageInfo, Projection } from "./types.js";
import type { SupervisionStartInput, SupervisionStartResult, SupervisionStopInput, SupervisionStopResult } from "./workflow-write-controller.js";

// an exact whole-token mention of a chat ID; a prefix of a longer ID never names that chat
const namesThread = (text: string, threadId: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9:_%.-])${threadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9:_%-]|\\.[A-Za-z0-9:_%-])`, "u").test(text);

/** The human's own message in this projection's thread: a visible, finished web or mobile message of a native user run. */
export const genuineUserMessage = (projection: Projection, messageId: string): MessageInfo | null => {
  const message = projection.messages.find(item => item.id === messageId && item.threadId === projection.thread.id);
  const run = message?.runId ? projection.runs.find(item => item.id === message.runId && item.threadId === projection.thread.id) : undefined;
  return message && run && message.role === "user" && message.createdBy === "user" && !message.streaming &&
    (message.creationSource === "web" || message.creationSource === "mobile") && !message.senderThreadId && !message.scheduledTaskId && !message.source &&
    !message.id.startsWith("supervisor-notice:") && nativeUserMessageVisible(projection, run, message) ? message : null;
};

// a thread-policy save that did not commit, with the reason the settings editor shows
export class ThreadPolicySaveFailed extends Data.TaggedError("ThreadPolicySaveFailed")<{readonly message: string}> {}

// an evidence read ended by the caller's cancel, as the aborted baseline read rejected
class EvidenceReadCancelled extends Data.TaggedError("EvidenceReadCancelled") {}

// the outcome of one chat-policy write
export type ChatPolicyWrite = {status: "saved"; changed: boolean} | {status: "conflict" | "unavailable" | "full"};

export type SupervisionStartStatusInfo = {threadId: string; operationId: string; status: "pending" | "active" | "rejected" | "denied" | "unavailable"; reason: string};

// a caught failure or defect of an awaited step, as the baseline catch saw it; an interruption is never caught
type Attempt<A> = {readonly ok: true; readonly value: A} | {readonly ok: false};
const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Attempt<A>, never, R> =>
  Effect.catchCauseIf(Effect.map(effect, (value): Attempt<A> => ({ok: true, value})), (cause) => !Cause.hasInterruptsOnly(cause),
    () => Effect.succeed<Attempt<A>>({ok: false})) as Effect.Effect<Attempt<A>, never, R>;

const failedPreparation: SupervisionStartResult = {status: "unavailable", reason: "Start preparation failed before activation. Use a new explicit request after inspecting this outcome."};

export interface SupervisionControlShape {
  /**
   * The agent can request only its own chat; exact native wire evidence has already been verified. A call's cancel ends its
   * evidence read as the baseline signal did (the write controller's tool deadline); interruption ends the whole call.
   */
  readonly startSupervision: (input: SupervisionStartInput, evidence: {runId: string}, cancel?: Deferred.Deferred<void>) => Effect.Effect<SupervisionStartResult>;
  readonly dashboardStart: (threadId: string, operationId: string) => Effect.Effect<SupervisionStartResult>;
  /**
   * Applies a verified supervision_stop. The caller's own native tool call is already verified; this resolves the route from the
   * caller's relation to the exact target and requires the human's original native message: in the bound root or its main (direct,
   * relay), in the main itself (relay), or in another ordinary chat whose message names the exact target ID (chat).
   */
  readonly stopSupervision: (input: SupervisionStopInput, evidence: unknown, cancel?: Deferred.Deferred<void>) => Effect.Effect<SupervisionStopResult, StoreError>;
  /**
   * The Settings excluded-chat editor saves the same list as Stop supervision, so each chat it removes or adds gets the same
   * explicit Enable or Stop record as the dashboard control: a replayed stop never reverses that Enable.
   */
  readonly saveThreadPolicy: (input: ThreadPolicySettings) => Effect.Effect<ThreadPolicySettings, ThreadPolicySaveFailed>;
  // the dashboard's chat-policy write with its Enable or Stop bookkeeping, as one admission section
  readonly setChatPolicy: (threadId: string, enabled: boolean, policyGeneration: number) => Effect.Effect<ChatPolicyWrite>;
  // section-only: called inside SupervisionGate.admit, synchronous store work over the interim stores
  readonly activateStart: (start: SupervisionStartRecord) => boolean;
  readonly rejectStart: (start: SupervisionStartRecord, reason: string) => void;
  // a synchronous b-02 read of the recorded operation
  readonly startStatus: (threadId: string, operationId: string) => SupervisionStartStatusInfo;
}

// Start, Stop and Enable: the requested Start operations, the explicit Stop/Enable policy writes and their guidance bookkeeping
const makeSupervisionControl = Effect.gen(function* () {
  const stores = yield* SupervisionStores;
  const scope = yield* SupervisionScopeService;
  const gate = yield* SupervisionGate;
  const locks = yield* ScopeLocks;
  const source = yield* Store;
  const t3 = yield* T3Client;
  const conversation = yield* SupervisorConversation;
  const ids = yield* SupervisorIds;
  // the synchronous blocks stamp their time from the clock the service was built with
  const clock = yield* Clock.Clock;
  const operateRpcAvailable = Option.isSome(yield* Effect.serviceOption(NativeOperateRpc));
  const {supervisors: store, requests} = stores;
  const config = scope.config;
  const now = () => clock.currentTimeMillisUnsafe();
  const projection = (threadId: string, cancel?: Deferred.Deferred<void>): Effect.Effect<Projection, T3TransportError | EvidenceReadCancelled> => {
    const read = Effect.map(t3.projection(threadId), (snapshot) => snapshot.projection);
    return cancel === undefined ? read : Effect.raceFirst(read, Effect.andThen(Deferred.await(cancel), Effect.fail(new EvidenceReadCancelled())));
  };
  const rejectStart = (start: SupervisionStartRecord, reason: string): void => {
    if (store.start(start.threadId)?.operationId === start.operationId) store.saveStart({...start, status: "rejected", reason});
  };
  const writeChatPolicy = (threadId: string, stopped: boolean, expectedGeneration?: number): ChatPolicyWrite => {
    const policy = config.threadPolicy;
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
  };
  // records the stop and a single operative notice, and fences unsent check-ins without cancelling operative work.
  // a stop supersedes any earlier keep-active choice for the owned Supervisor, so its settlement is not vetoed by an older intent.
  const applyChatStop = (threadId: string, stop: NonNullable<BindingRecord["supervisionStop"]> | null): void => {
    const start = store.start(threadId);
    if (stop && start?.status === "pending" && stop.stoppedAt >= start.intentAt)
      store.saveStart({...start, status: "rejected", reason: "Superseded by a later Stop."});
    const bindings = store.bindings().filter(item => item.mainThreadId === threadId);
    if (!bindings.length) store.saveUnboundStop(threadId, stop);
    for (const binding of bindings) {
      const write = () => {
        store.setSupervisionStop(binding, stop);
        const notice = binding.stopNotice;
        const enabledAt = store.chatEnabledAt(threadId);
        if (stop && (!notice || notice.enabledAt !== enabledAt && ["sent", "blocked", "superseded"].includes(notice.state)))
          store.setStopNotice(binding, notice?.messageId ?? null, prepareStopNotice(binding, stop.stoppedAt, enabledAt));
        else if (stop && notice?.state === "unconfirmed") store.setStopNotice(binding, notice.messageId, {...notice, state: "uncertain", visibilityMisses: 0, nextObserveAt: now()});
        else if (!stop && notice?.state === "ready") store.setStopNotice(binding, notice.messageId, {...notice, state: "superseded"});
      };
      if (store.store.db.isTransaction) write(); else store.store.transaction(write);
      if (stop) conversation.fenceStoppedSupervision(store.binding(binding.projectId, binding.mainThreadId)!);
    }
  };
  const activateStart = (start: SupervisionStartRecord): boolean => {
    if (!scope.validPendingStart(start)) return false;
    // pending is durable before the separate policy write; a crash cannot grant on-request effects without the committed permission
    const written = writeChatPolicy(start.threadId, false);
    if (written.status !== "saved") return false;
    store.recordChatEnable(start.threadId, start.intentAt);
    applyChatStop(start.threadId, null);
    store.saveStart({...start, status: "active", reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor."});
    return true;
  };
  const startStatus = (threadId: string, operationId: string): SupervisionStartStatusInfo => {
    const operation = store.startOperation(threadId, operationId);
    return operation ? {threadId, operationId, status: operation.status, reason: operation.reason}
      : {threadId, operationId, status: "denied" as const, reason: "No matching Start operation is recorded. Nothing was replayed."};
  };
  const evaluateStart = (threadId: string, operationId: string, route: "agent" | "ui", userMessageId: string | null, runId: string | null,
    cancel: Deferred.Deferred<void> | undefined, decided: (result: SupervisionStartResult) => void): Effect.Effect<SupervisionStartResult, StoreError | T3TransportError | EvidenceReadCancelled> => Effect.gen(function* () {
    if (!threadId || threadId.length > 512 || !operationId || operationId.length > 512 || /[\s\x00-\x1f\x7f]/u.test(operationId)) return {status: "invalid", reason: "invalid_start_arguments"};
    const catalog = yield* source.catalog();
    scope.rememberScratchProjects(catalog.projects.map(item => item.project));
    const thread = catalog.threads.find(item => item.id === threadId);
    if (!thread?.projectId || !scope.mainShape(thread) || mainConversation(thread, catalog.threads)?.id !== threadId ||
      !catalog.projects.some(item => item.available && item.project.id === thread.projectId) || !scope.isNoProject(thread.projectId))
      return {status: "denied", reason: "own_ordinary_no_project_chat_required"};
    const mode = store.noProjectControl();const master = store.control(null);
    if (!operateRpcAvailable || !store.scopeCompatible || !master.enabled || mode.mode === "off") return {status: "denied", reason: "master_or_no_project_mode_off"};
    const requestHash = fingerprint({threadId, operationId, route, userMessageId});
    const previous = store.start(threadId);
    if (previous?.operationId === operationId) return previous.requestHash === requestHash
      ? {status: previous.status, reason: previous.reason} : {status: "denied", reason: "operation_id_conflict"};
    if (previous?.status === "pending") return {status: "denied", reason: "An earlier Start is unresolved. Reconcile its operation ID before another request."};
    const main = yield* projection(threadId, cancel);
    const projectId = thread.projectId;
    // the task identity of a source-bound Start, allocated before the section
    const taskId = yield* ids.uuid;
    // from the last await, the rechecks, the start record and a dashboard activation run as one admission section
    return yield* gate.admit(() => Effect.sync((): SupervisionStartResult => {
      const result = ((): SupervisionStartResult => {
        if (main.thread.projectId !== thread.projectId || !scope.mainShape(main.thread)) return {status: "denied", reason: "scope_changed"};
        let message = userMessageId ? genuineUserMessage(main, userMessageId) : null;
        const latestHuman = [...main.messages].filter(item => genuineUserMessage(main, item.id)).sort((a,b) => (timestampMs(b.createdAt) ?? 0) - (timestampMs(a.createdAt) ?? 0)).at(0);
        if (route === "agent" && (!message || message.runId !== runId || latestHuman?.id !== message.id)) return {status: "denied", reason: "start_call_not_in_genuine_human_turn"};
        if (route === "ui") message = latestHuman && main.runs.some(run => run.id === latestHuman.runId && ["preparing", "queued", "starting", "running", "waiting"].includes(run.status)) ? latestHuman : null;
        if (message && message.text.length > 24_000) return {status: "denied", reason: "start_source_too_large"};
        const intentAt = route === "agent" ? timestampMs(message?.createdAt) : now();
        if (intentAt === null || (store.chatStop(threadId)?.stoppedAt ?? -1) >= intentAt || (store.chatEnabledAt(threadId) ?? -1) >= intentAt)
          return {status: "denied", reason: "superseded_by_later_stop_or_enable"};
        const task = store.task(threadId);
        const intro = task ? requests.introduction(task.id) : null;
        if (task && ["queued", "dispatching", "waiting", "uncertain"].includes(task.status) || intro && introductionOutcomeUnknown(intro))
          return {status: "denied", reason: "Existing native work has an unresolved outcome; its original identities must be reconciled first."};
        if (previous?.status === "active" && !scope.supervisionStopped(threadId)) return {status: "active", reason: previous.reason};
        if (mode.generation !== store.noProjectControl().generation || master.generation !== store.control(null).generation || !store.control(null).enabled)
          return {status: "denied", reason: "scope_mode_changed"};
        const run = message ? main.runs.find(item => item.id === message!.runId)! : null;
        const record: SupervisionStartRecord = {threadId, projectId, operationId, requestHash, route, status: "pending",
          reason: "Waiting for the Supervisor's first source-bound Start interpretation.", intentAt, modeGeneration: mode.generation, masterGeneration: master.generation,
          taskId: message ? taskId : null, ...(message && run ? {source: {messageId: message.id, runId: run.id, ordinal: run.ordinal, hash: fingerprint(message.text)}} : {})};
        store.saveStart(record);
        if (route === "ui") {
          if (!store.store.transaction(() => activateStart(record))) {rejectStart(record, "Start could not be committed.");return {status: "unavailable", reason: "Start was not activated."};}
          return {status: "active", reason: store.start(threadId)!.reason};
        }
        return {status: "pending", reason: record.reason};
      })();
      decided(result);
      return result;
    }));
  });
  const requestStart = (threadId: string, operationId: string, route: "agent" | "ui", userMessageId: string | null, runId: string | null,
    cancel?: Deferred.Deferred<void>) => Effect.gen(function* () {
    const requestHash = fingerprint({threadId, operationId, route, userMessageId});
    const prior = store.startOperation(threadId, operationId);
    if (prior) return prior.requestHash === requestHash ? {status: prior.status, reason: prior.reason} : {status: "denied", reason: "operation_id_conflict"} as SupervisionStartResult;
    if (!threadId || threadId.length > 512 || !operationId || operationId.length > 512) return {status: "invalid", reason: "invalid_start_arguments"} as SupervisionStartResult;
    store.saveStartOperation({threadId, operationId, requestHash, status: "pending", reason: "Checking the requested chat and original human source.", preparing: true});
    // the final status is written only while the operation is still preparing
    const finish = (result: SupervisionStartResult): SupervisionStartResult => {
      const saved = store.startOperation(threadId, operationId);
      if (saved?.preparing) store.saveStartOperation({threadId, operationId, requestHash, status: result.status === "invalid" ? "denied" : result.status, reason: result.reason});
      return result;
    };
    // an interrupted request finishes with the outcome its section decided, or as a failed preparation, as the aborted baseline read did
    let decided: SupervisionStartResult | null = null;
    const evaluated = yield* attempt(evaluateStart(threadId, operationId, route, userMessageId, runId, cancel, (result) => {decided = result;})).pipe(
      Effect.onInterrupt(() => Effect.sync(() => finish(decided ?? failedPreparation))));
    return finish(evaluated.ok ? evaluated.value : failedPreparation);
  });
  const stopSupervision = (input: SupervisionStopInput, evidence: unknown, cancel?: Deferred.Deferred<void>): Effect.Effect<SupervisionStopResult, StoreError> => Effect.gen(function* () {
    const catalog = yield* source.catalog();
    const target = catalog.threads.find(thread => thread.id === input.targetThreadId);
    if (!target || isSupervisorThread(config, target) || target.lineage.relationshipToParent === "subagent" ||
      mainConversation(target, catalog.threads)?.id !== target.id) return {status: "denied", reason: "target_not_main_conversation"};
    const binding = store.bindingForSupervisor(input.callerThreadId);
    if (binding && (binding.mainThreadId !== target.id || binding.state !== "ready")) return {status: "denied", reason: "target_outside_supervisor_scope"};
    const callerRead = yield* attempt(projection(input.callerThreadId, cancel));
    if (!callerRead.ok) return {status: "unavailable", reason: "caller_projection_unavailable", retryable: true};
    const caller = callerRead.value;
    let candidates: Array<{threadId: string; route: "direct" | "relay" | "chat"}>;
    if (binding) {
      candidates = [{threadId: input.callerThreadId, route: "direct"}, {threadId: target.id, route: "relay"}];
    } else if (isSupervisorThread(config, caller.thread)) return {status: "denied", reason: "supervisor_thread_not_bound_to_target"};
    else if (input.callerThreadId === target.id) candidates = [{threadId: target.id, route: "relay"}];
    else candidates = [{threadId: input.callerThreadId, route: "chat"}];
    const startedAt = now();
    for (const candidate of candidates) {
      let evidenceProjection: Projection;
      if (candidate.threadId === input.callerThreadId) evidenceProjection = caller;
      else {
        const read = yield* attempt(projection(candidate.threadId, cancel));
        if (!read.ok) return {status: "unavailable", reason: "evidence_projection_unavailable", retryable: true};
        evidenceProjection = read.value;
      }
      // from the last await, the source checks, the policy write and its bookkeeping run as one admission section
      const outcome = yield* gate.admit(() => Effect.sync((): SupervisionStopResult | null => {
        const message = genuineUserMessage(evidenceProjection, input.userMessageId);
        if (!message) return null;
        // the calling assistant judges that the human asked to stop; the service only verifies provenance, target and ordering
        const words = message.text;
        // a human message that names another chat's ID authorizes only that chat, never the agent's choice of a different one, and
        // naming any second chat, the caller's own, a child or another Supervisor included, leaves the choice to the human; only the
        // target's own Supervisor conversation may be named alongside it
        const namesTarget = namesThread(words, target.id);
        const pairedSupervisorId = store.bindings().find(item => item.mainThreadId === target.id)?.threadId;
        if (catalog.threads.some(thread => thread.id !== target.id && thread.id !== pairedSupervisorId && namesThread(words, thread.id)))
          return {status: "denied", reason: namesTarget ? "target_ambiguous" : "target_not_named_by_user"};
        // a request from another chat must name the exact target so the human, not the agent, selects the stopped scope
        if (candidate.route === "chat" && !namesTarget) return {status: "denied", reason: "target_not_named_by_user"};
        // a stop instruction older than the latest explicit Enable never reverses it, including a replayed tool call
        const enabledAt = Math.max(store.chatEnabledAt(target.id) ?? -1, (store.start(target.id)?.status === "rejected" ? -1 : store.start(target.id)?.intentAt) ?? -1);
        if (enabledAt !== null && !(Date.parse(message.createdAt) > enabledAt)) return {status: "denied", reason: "superseded_by_later_enable"};
        // when the caller acts in the chat the human wrote in, its verified native call must answer that message, not a later unrelated turn
        const verifiedRunId = typeof evidence === "object" && evidence !== null && typeof (evidence as {runId?: unknown}).runId === "string" ? (evidence as {runId: string}).runId : null;
        if (verifiedRunId !== null && candidate.threadId === input.callerThreadId && verifiedRunId !== message.runId)
          return {status: "denied", reason: "stop_call_not_in_human_turn"};
        const route = candidate.route;
        const instructedAt = Number.isFinite(Date.parse(message.createdAt)) ? Date.parse(message.createdAt) : startedAt;
        const recorded = store.chatStop(target.id);
        const written = writeChatPolicy(target.id, true);
        if (written.status !== "saved") return {status: "unavailable", reason: `thread_policy_${written.status}`, retryable: written.status === "conflict"};
        // the stop dates from the human's instruction; a replay or an older instruction keeps the recorded stop, so a keep-active
        // the human chose after it still holds, while a newer human stop supersedes that choice
        if (written.changed || !recorded || recorded.stoppedAt < instructedAt)
          applyChatStop(target.id, {route, callerThreadId: input.callerThreadId, userMessageId: input.userMessageId, stoppedAt: instructedAt});
        return {status: "stopped", targetThreadId: target.id, route, alreadyStopped: !written.changed};
      }));
      if (outcome) return outcome;
    }
    return {status: "denied", reason: "user_message_not_genuine"};
  });
  // the save and its Stop/Enable bookkeeping as one admission section; a failure anywhere in it is the save's failure
  const saveThreadPolicy = (input: ThreadPolicySettings) => gate.admit(() => Effect.try({
    try: (): ThreadPolicySettings => {
      const policy = config.threadPolicy;
      if (!policy) throw new Error("Chat settings unavailable.");
      const before = policy.get();
      if (before.generation !== input.generation) throw new Error("Chat settings changed in another tab. Reload first.");
      const saved = policy.save(input);
      const at = now();
      for (const id of before.excludedThreadIds.filter(id => !saved.excludedThreadIds.includes(id))) {store.recordChatEnable(id, at);applyChatStop(id, null);}
      for (const id of saved.excludedThreadIds.filter(id => !before.excludedThreadIds.includes(id)))
        applyChatStop(id, {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: at});
      return saved;
    },
    catch: (cause) => new ThreadPolicySaveFailed({message: cause instanceof Error ? cause.message : "Chat settings invalid. Reload first."}),
  }));
  // the chat policy write and its Enable/Stop bookkeeping as one admission section
  const setChatPolicy = (threadId: string, enabled: boolean, policyGeneration: number) => gate.admit(() => Effect.sync((): ChatPolicyWrite => {
    const write = writeChatPolicy(threadId, !enabled, policyGeneration);
    if (write.status !== "saved") return write;
    if (enabled) store.recordChatEnable(threadId, now());
    applyChatStop(threadId, enabled ? null : {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: now()});
    return write;
  }));
  return SupervisionControl.of({
    startSupervision: (input, evidence, cancel) =>
      locks.withLock(`start:${input.callerThreadId}`)(requestStart(input.callerThreadId, input.operationId, "agent", input.userMessageId, evidence.runId, cancel)),
    dashboardStart: (threadId, operationId) => locks.withLock(`start:${threadId}`)(requestStart(threadId, operationId, "ui", null, null)),
    stopSupervision,
    saveThreadPolicy,
    setChatPolicy,
    activateStart,
    rejectStart,
    startStatus,
  });
});

// Start, Stop and Enable over the interim stores, the scope predicates, the admission section, the per-scope locks, the
// catalog, projections and the conversation fence
export class SupervisionControl extends Context.Service<SupervisionControl, SupervisionControlShape>()("t3-supervisor/SupervisionControl") {
  static readonly make = makeSupervisionControl;
  static readonly layer = Layer.effect(SupervisionControl, makeSupervisionControl);
}
