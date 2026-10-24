import { Schema } from "effect";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const texts = (count: number, max: number) => Schema.Array(text(max)).check(Schema.isMaxLength(count));
export const RequesterSource = Schema.Struct({
  messageId: text(512), runId: text(512), ordinal: Schema.Int, hash: text(128),
  requester: Schema.Literals(["human", "launching_agent"]),
});
export type RequesterSource = typeof RequesterSource.Type;
export const ConversationDraft = Schema.Struct({
  objective: Schema.NullOr(text(2000)), constraints: texts(10, 300), questions: texts(10, 300),
  findings: Schema.Array(Schema.Struct({text: text(600), messageIds: texts(8, 512)})).check(Schema.isMaxLength(12)),
  duties: texts(12, 600),
});
export type ConversationDraft = typeof ConversationDraft.Type;
export const ConversationAuthorization = Schema.Struct({
  scopeRevision: text(128), outcome: text(2000), limits: texts(10, 300),
  scopeSources: Schema.Array(RequesterSource).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  state: Schema.Literals(["authorized", "paused"]), stateSource: RequesterSource,
  attemptId: text(512),
});
export type ConversationAuthorization = typeof ConversationAuthorization.Type;
export const ConversationFacts = Schema.Struct({
  draft: ConversationDraft, authorization: Schema.NullOr(ConversationAuthorization),
  considered: Schema.NullOr(RequesterSource), observed: Schema.NullOr(RequesterSource), updatedAt: Schema.Number,
});
export type ConversationFacts = typeof ConversationFacts.Type;
/** A source-bound semantic decision. Source IDs are assertions; the service resolves and verifies every one. */
export const ConversationDecision = Schema.Struct({
  draft: ConversationDraft, intent: Schema.Literals(["following", "authorize", "pause", "resume"]),
  outcome: Schema.NullOr(text(2000)), limits: texts(10, 300),
  sourceMessageIds: texts(12, 512), antecedentMessageIds: texts(12, 512),
  scope: Schema.Literals(["same", "changed"]),
});
export type ConversationDecision = typeof ConversationDecision.Type;
export const ConversationEngagement = Schema.Struct({
  mode: Schema.Literals(["following", "engaged"]),
  availability: Schema.Literals(["current", "catching_up", "stale", "uncertain", "stopped", "unavailable"]),
  consideredAt: Schema.NullOr(Schema.Number),
});
export type ConversationEngagement = typeof ConversationEngagement.Type;

export const emptyConversation = (at: number): ConversationFacts => ({
  draft: {objective: null, constraints: [], questions: [], findings: [], duties: []},
  authorization: null, considered: null, observed: null, updatedAt: at,
});

export type ConversationTask = {sourceHash?: string; status: string; supervision?: "needed" | "not_needed"; conversation?: ConversationFacts | undefined};
export const taskScopeRevision = (task: ConversationTask): string => task.conversation?.authorization?.scopeRevision ?? task.sourceHash ?? "";
export const conversationEngaged = (task: ConversationTask): boolean => task.conversation?.authorization?.state === "authorized";

export const conversationMayContact = (task: ConversationTask): boolean => conversationEngaged(task) && task.supervision !== "not_needed" && task.status === "inferred" &&
  Boolean(task.conversation?.considered && task.conversation.considered.ordinal === task.conversation.observed?.ordinal &&
    task.conversation.considered.messageId === task.conversation.observed.messageId && task.conversation.considered.hash === task.conversation.observed.hash);


/** One derivation for HTTP, Home and scheduling. A persisted mode latch cannot become stale independently of these facts. */
export const deriveConversationEngagement = (input: {
  task?: ConversationTask | undefined; enabled: boolean; available: boolean; bindingState?: string | null | undefined;
  monitoringState?: string | undefined; stale?: boolean | undefined;
}): ConversationEngagement => {
  const task = input.task, facts = task?.conversation;
  const mode = task && conversationEngaged(task) ? "engaged" : "following";
  const availability = !input.enabled ? "stopped" : !input.available || input.bindingState === "missing" || input.bindingState === "rejected" ? "unavailable"
    : input.bindingState === "uncertain" || input.monitoringState === "uncertain" || task?.status === "uncertain" ? "uncertain"
    : input.monitoringState === "unavailable" || task?.status === "unavailable" ? "unavailable"
    : input.stale || task?.status === "expired" ? "stale"
    : ["queued", "dispatching", "waiting"].includes(task?.status ?? "") ? "catching_up"
    : !facts?.considered || !facts.observed ? "unavailable"
    : facts.observed.ordinal !== facts.considered.ordinal || facts.observed.messageId !== facts.considered.messageId ||
      facts.observed.hash !== facts.considered.hash ? "catching_up" : "current";
  return {mode, availability, consideredAt: facts?.considered ? facts.updatedAt : null};
};
