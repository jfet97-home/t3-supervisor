import { nativeUserMessageVisible, timestampMs } from "./domain.js";
import { fingerprint } from "./guidance-store.js";
import { taskRequester, type TaskRequesterPolicy } from "./task-requester.js";
import type { Projection } from "./types.js";
import { emptyConversation, type ConversationDecision, type ConversationFacts, type RequesterSource } from "./supervision-conversation-contract.js";
import { conversationMayContact, type ConversationTask } from "./supervision-conversation-contract.js";
import type { WorkflowPlanGroupInfo, WorkflowPlanNodeInfo } from "./project-supervisor-contract.js";

export { taskScopeRevision, conversationEngaged, conversationMayContact, deriveConversationEngagement } from "./supervision-conversation-contract.js";
export const requesterSources = (main: Projection, policy: TaskRequesterPolicy, floor = -1, enabledAt: number | null = null): RequesterSource[] =>
  main.messages.flatMap(message => {
    const run = main.runs.find(run => run.id === message.runId);
    const who = run && taskRequester(main, run, message, policy);
    return run && who && run.ordinal > floor && (enabledAt === null || (timestampMs(message.createdAt) ?? 0) > enabledAt)
      ? [{messageId: message.id, runId: run.id, ordinal: run.ordinal, hash: fingerprint(message.text),
        requester: who.kind === "human" ? "human" as const : "launching_agent" as const}] : [];
  }).sort((a, b) => a.ordinal - b.ordinal);

export const conversationAuthorityCurrent = (task: ConversationTask, main: Projection, policy: TaskRequesterPolicy): boolean => {
  if (!conversationMayContact(task)) return false;
  const sources = requesterSources(main, policy), latest = sources.at(-1);
  const facts = task.conversation!;
  return latest?.messageId === facts.considered?.messageId && latest?.hash === facts.considered?.hash &&
    [...facts.authorization!.scopeSources, facts.authorization!.stateSource].every(pin =>
      sources.some(source => source.messageId === pin.messageId && source.runId === pin.runId && source.hash === pin.hash && source.requester === pin.requester));
};

/** The last native projection is checked after proof reads and again inside admission before the facts are saved. */
export const resolveConversationDecision = (input: {
  previous?: ConversationFacts | undefined; decision: ConversationDecision; main: Projection; policy: TaskRequesterPolicy;
  floor: number; enabledAt: number | null; watermark: RequesterSource; attemptId: string; now: number; initialRevision: string;
}): {ok: true; facts: ConversationFacts; scopeChanged: boolean} | {ok: false; reason: string} => {
  const {decision, main, watermark} = input;
  const sources = requesterSources(main, input.policy, input.floor, input.enabledAt);
  const latest = sources.at(-1);
  if (!latest || latest.messageId !== watermark.messageId || latest.hash !== watermark.hash) return {ok: false, reason: "requester_watermark_changed"};
  const prior = input.previous ?? emptyConversation(input.now);
  const sourceIds = new Set(decision.sourceMessageIds);
  const scopeSources = sources.filter(source => sourceIds.has(source.messageId));
  if (scopeSources.length !== sourceIds.size || scopeSources.some(source => source.ordinal > watermark.ordinal)) return {ok: false, reason: "requester_source_invalid"};
  const contentIds = decision.intent === "pause" ? [] : [...decision.antecedentMessageIds, ...decision.draft.findings.flatMap(finding => finding.messageIds)];
  const grantPosition = main.messages.findIndex(message => message.id === watermark.messageId);
  for (const id of contentIds) {
    const message = main.messages.find(item => item.id === id && item.threadId === main.thread.id && item.streaming === false);
    const run = main.runs.find(item => item.id === message?.runId);
    if (!message || !run || run.ordinal > watermark.ordinal || decision.antecedentMessageIds.includes(id) &&
      (grantPosition < 0 || main.messages.indexOf(message) >= grantPosition) ||
      !(message.role === "user" ? nativeUserMessageVisible(main, run, message) : message.role === "assistant" && run.status !== "rolled_back" &&
        Array.isArray(main.nodes) && main.nodes.some(node => node.id === message.nodeId && node.runId === run.id && node.status !== "rolled_back")))
      return {ok: false, reason: "conversation_content_invalid"};
  }
  // antecedents are actual earlier conversation content. The semantic interpreter must resolve an ambiguous pronoun; a citation
  // grants no authority, and a future finding can never serve as its antecedent.
  let authorization = prior.authorization;
  let scopeChanged = false;
  if (decision.intent === "authorize" || decision.intent === "resume") {
    if (!sourceIds.has(watermark.messageId) || !decision.outcome?.trim() || scopeSources.length === 0) return {ok: false, reason: "authorization_source_required"};
    if (authorization?.state === "paused" && authorization.stateSource.requester === "human" && watermark.requester === "launching_agent")
      return {ok: false, reason: "human_pause_retained"};
    const same = authorization !== null && decision.scope === "same" && decision.outcome === authorization.outcome && fingerprint(decision.limits) === fingerprint(authorization.limits);
    if (decision.scope === "same" && !same) return {ok: false, reason: "scope_changed"};
    scopeChanged = !same;
    authorization = {...(same ? authorization! : {scopeRevision: prior.authorization ? fingerprint({outcome: decision.outcome, limits: decision.limits, scopeSources}) : input.initialRevision,
      outcome: decision.outcome, limits: [...decision.limits], scopeSources}), state: "authorized", stateSource: watermark, attemptId: input.attemptId};
  } else if (decision.intent === "pause" && authorization && !(authorization.state === "paused" && authorization.stateSource.requester === "human" && watermark.requester === "launching_agent")) {
    // returning to discussion pauses participation without disabling Supervisor or discarding the accepted scope.
    authorization = {...authorization, state: "paused", stateSource: watermark, attemptId: input.attemptId};
  } else if (authorization?.state === "authorized" && !authorization.scopeSources.every(pin => sources.some(source => source.messageId === pin.messageId && source.hash === pin.hash))) {
    return {ok: false, reason: "authorization_source_changed"};
  }
  return {ok: true, scopeChanged, facts: {draft: decision.intent === "pause" ? prior.draft : decision.draft, authorization, considered: watermark, observed: watermark, updatedAt: input.now}};
};

/** Reuse exact commitment occurrences, in occurrence order. Scope changes never turn a similarly named new duty into old work. */
export const preserveOccurrenceIds = (next: WorkflowPlanGroupInfo, previous: WorkflowPlanGroupInfo | null): WorkflowPlanGroupInfo => {
  const occurrences = new Map<string, string[]>();
  const key = (node: Exclude<WorkflowPlanNodeInfo, WorkflowPlanGroupInfo>) => fingerprint({kind: node.kind, definitionId: node.definitionId,
    localId: node.kind === "step" ? node.localId : null, templatePath: node.templatePath, name: node.name, description: node.description,
    references: node.references, skills: node.skills, ...(node.kind === "workflow" ? {fixed: node.fixed, omissions: node.omissions} : {})});
  const remember = (node: WorkflowPlanNodeInfo): void => {
    if ("nodes" in node) {node.nodes.forEach(remember);return;}
    const id = key(node); occurrences.set(id, [...(occurrences.get(id) ?? []), node.nodeId]);
    if (node.kind === "workflow" && node.plan) remember(node.plan);
  };
  if (previous) remember(previous);
  const visit = (node: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
    if ("nodes" in node) return {...node, nodes: node.nodes.map(visit)};
    const nodeId = occurrences.get(key(node))?.shift() ?? node.nodeId;
    return node.kind === "workflow" ? {...node, nodeId, plan: node.plan ? group(node.plan) : null} : {...node, nodeId};
  };
  const group = (node: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...node, nodes: node.nodes.map(visit)});
  return group(next);
};
