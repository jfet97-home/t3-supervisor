import { Effect } from "effect";
import { nativeUserMessageVisible, timestampMs } from "./domain.js";
import { isSupervisorThreadId, type ProjectSupervisorStore, type ProjectSupervisorStoreError } from "./project-supervisor-store.js";
import type { MessageInfo, Projection, RunInfo, ThreadInfo } from "./types.js";

// chat origin is checked before requester provenance. Agent-created mains remain excluded while the project's opt-in is off,
// including later human follow-ups. With it on, genuine humans and the exact launching agent may request work. An agent is never
// treated as a human one, and the human-only Start, Stop and definition approvals keep their own human-only checks

/**
 * The requesters a main's task discovery accepts: agent requests only when written after the project turned agent-created
 * conversations on (`agentRequestsAfter`, null while off), and never from a Supervisor thread of the permanent ownership.
 */
export type TaskRequesterPolicy = {readonly agentRequestsAfter: number | null; readonly owned: ReadonlySet<string>};
/** The requester policy of a project, from its saved settings, read when the caller runs it (inside its transaction, if any). */
export const projectRequesterPolicy = (store: ProjectSupervisorStore["Service"], projectId: string): Effect.Effect<TaskRequesterPolicy, ProjectSupervisorStoreError> =>
  Effect.map(store.settings(projectId), (settings) => ({agentRequestsAfter: settings.agentCreatedThreadsEnabledAt, owned: store.ownedIds}));

// the human's own web or mobile message, never a relayed, scheduled or imported one
const humanRequest = (message: MessageInfo): boolean => message.createdBy === "user" &&
  (message.creationSource === "web" || message.creationSource === "mobile") && !message.senderThreadId && !message.scheduledTaskId && !message.source;

// a message an agent sent through T3's MCP server from another, non-Supervisor thread, never a scheduled or imported one
const agentMessage = (thread: ThreadInfo, message: MessageInfo, owned: ReadonlySet<string>): message is MessageInfo & {senderThreadId: string} =>
  message.createdBy === "agent" && message.creationSource === "mcp" && typeof message.senderThreadId === "string" && message.senderThreadId !== thread.id &&
  !isSupervisorThreadId(owned, message.senderThreadId) && !message.scheduledTaskId && !message.source;

/** An ordinary main created through T3's MCP server: an independent root, not a delegated child, fork or Supervisor thread. */
export const agentCreatedMain = (thread: ThreadInfo, owned: ReadonlySet<string>): boolean => thread.creationSource === "mcp" &&
  thread.lineage.parentThreadId === null && thread.lineage.relationshipToParent == null &&
  (thread.lineage.rootThreadId === undefined || thread.lineage.rootThreadId === thread.id) && !isSupervisorThreadId(owned, thread.id);

export const agentCreatedOrigin = (thread: ThreadInfo): boolean => thread.createdBy === "agent" || thread.creationSource === "mcp";
/** Immutable native origin plus the current opt-in; source verification additionally requires the actual opening launcher. */
export const conversationOriginAllowed = (thread: ThreadInfo, policy: TaskRequesterPolicy): boolean =>
  !isSupervisorThreadId(policy.owned, thread.id) && thread.lineage.relationshipToParent !== "subagent" &&
  thread.createdBy !== "system" && thread.creationSource !== "server" &&
  (!agentCreatedOrigin(thread) || policy.agentRequestsAfter !== null && agentCreatedMain(thread, policy.owned));

/** The agent thread that launched an ordinary agent-created main: the sender of its visible opening request, else null. */
export const launchingAgent = (projection: Projection, owned: ReadonlySet<string>): string | null => {
  const {thread} = projection;
  if (!agentCreatedMain(thread, owned)) return null;
  const opening = projection.runs.filter(run => run.threadId === thread.id).reduce<RunInfo | undefined>((first, run) => !first || run.ordinal < first.ordinal ? run : first, undefined);
  const message = opening && projection.messages.find(item => item.id === opening.userMessageId && item.threadId === thread.id && item.runId === opening.id);
  return opening && message && message.role === "user" && message.streaming === false && agentMessage(thread, message, owned) &&
    nativeUserMessageVisible(projection, opening, message) ? message.senderThreadId : null;
};

/** The requester of a message that may become or support a main's task: a finished, visible root message of the main's own run. */
export const taskRequester = (projection: Projection, run: RunInfo, message: MessageInfo, policy: TaskRequesterPolicy): {readonly kind: "human"} | {readonly kind: "agent"; readonly threadId: string} | null => {
  if (!conversationOriginAllowed(projection.thread, policy) || agentCreatedOrigin(projection.thread) && !launchingAgent(projection, policy.owned)) return null;
  if (message.threadId !== projection.thread.id || message.runId !== run.id || message.role !== "user" || message.streaming !== false ||
    message.id.startsWith("supervisor-notice:") || !nativeUserMessageVisible(projection, run, message)) return null;
  if (humanRequest(message)) return {kind: "human"};
  if (policy.agentRequestsAfter === null || !((timestampMs(message.createdAt) ?? 0) > policy.agentRequestsAfter) ||
    !agentMessage(projection.thread, message, policy.owned)) return null;
  return message.senderThreadId === launchingAgent(projection, policy.owned) ? {kind: "agent", threadId: message.senderThreadId} : null;
};
