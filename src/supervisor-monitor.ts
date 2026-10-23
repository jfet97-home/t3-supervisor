import { createHash } from "node:crypto";
import { freshRuntimeRequestStatus, mainRunNodeReader, timestampMs } from "./domain.js";
import type { SupervisorMonitoringSettings } from "./project-supervisor-contract.js";
import type { Projection, RunInfo } from "./types.js";

export const SUPERVISOR_MONITOR_AGE_MS = 5 * 60_000;
export const SUPERVISOR_MONITOR_COOLDOWN_MS = 60_000;
export const SUPERVISOR_MONITOR_MAX_ITEMS_PER_THREAD = 1000;
export const SUPERVISOR_MONITOR_MAX_BATCH_ITEMS = 100;
export const SUPERVISOR_MONITOR_MAX_ITEMS_PER_CHAT = 20;
export const SUPERVISOR_MONITOR_MAX_FROZEN_ITEMS_PER_BATCH = 10_000;
export const SUPERVISOR_MONITOR_MAX_SELECTED_THREADS = 100;

export type SupervisorMonitorPriority =
  | "user_instruction"
  | "run_finished"
  | "run_failed"
  | "waiting_input";

export type SupervisorMonitorTrigger =
  | "priority"
  | "activity_threshold"
  | "activity_age"
  | "saturated";

export interface SupervisorMonitorActivity {
  id: string;
  readItemId: string | null;
  type: string;
  status: string;
  ordinal: number;
  detectedAt: number;
  version: string;
  priority: SupervisorMonitorPriority | null;
}

export type SupervisorMonitorActivityItem = SupervisorMonitorActivity;

export interface SupervisorMonitorThreadBatch {
  threadId: string;
  teamCoverageState?: "root" | "transferring" | "unavailable";
  trigger: SupervisorMonitorTrigger;
  finalizedActivityCount: number;
  pendingItemCount: number;
  oldestAt: number | null;
  priority: boolean;
  priorityKinds: SupervisorMonitorPriority[];
  saturated: boolean;
  untrackedCount: number;
  items: SupervisorMonitorActivityItem[];
  previewItems: SupervisorMonitorActivityItem[];
}

export interface SupervisorMonitorBatch {
  projectId: string;
  createdAt: number;
  trigger: SupervisorMonitorTrigger;
  finalizedActivityCount: number;
  pendingItemCount: number;
  truncated: boolean;
  threads: SupervisorMonitorThreadBatch[];
}

export interface SupervisorMonitorDecision {
  due: boolean;
  trigger: SupervisorMonitorTrigger | null;
  finalizedActivityCount: number;
  pendingItemCount: number;
  oldestAt: number | null;
  priorityKinds: SupervisorMonitorPriority[];
  cooldownUntil: number | null;
}

export interface SupervisorNativeChildLifecycleEvidence {
  parentThreadId: string;
  parentRunId: string | null;
  recordId: string | null;
  status: string;
  completedAt: string | null;
  updatedAt: string | null;
}

const finalizedStatuses = new Set(["completed", "failed", "cancelled", "interrupted", "resolved", "expired"]);
const nativeChildTerminalStatuses = new Set(["completed", "failed", "interrupted", "cancelled", "resolved", "expired"]);
const terminalRuntimeRequestStatuses = new Set(["resolved", "expired", "cancelled"]);
const runTerminalStatuses = new Set(["completed", "failed", "interrupted", "cancelled"]);
const countableTypes = new Set([
  "user_message",
  "assistant_message",
  "proposed_plan",
  "todo_list",
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
  "error",
  "checkpoint",
  "dynamic_tool",
  "runtime_request",
  "user_input_request",
  "approval_request",
  "secret_request",
  "native_child_lifecycle",
]);
const excludedTypes = new Set([
  "notification",
  "reasoning",
  "system_notice",
  "run_interrupt_request",
  "run_interrupt_result",
  "subagent",
  "handoff",
  "fork",
  "thread_created",
  "compaction",
]);
const excludedMessagePrefixes = ["supervisor-notice:", "supervisor-peer:"];

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const runtimeRequestUpdatedAt = (projection: Projection, requestId: string | null, nodeId: string | null): string | null => {
  if (!requestId || !nodeId || !Array.isArray(projection.runtimeRequests)) return null;
  const matches = projection.runtimeRequests.filter(value => isRecord(value) &&
    (stringValue(value.id) ?? stringValue(value.requestId)) === requestId && value.nodeId === nodeId);
  if (matches.length !== 1) return null;
  const request = matches[0]!;
  return stringValue(request.resolvedAt) ?? stringValue(request.updatedAt) ?? stringValue(request.createdAt);
};

const inputIntentPriority = (value: RecordLike, ordinal: number, sourceOrdinal: number): SupervisorMonitorPriority | null => {
  if (value.type !== "user_message") return null;
  const intent = stringValue(value.inputIntent);
  if (ordinal === sourceOrdinal && (intent === null || intent === "turn_start")) return null;
  return "user_instruction";
};

const userMessageIsExternal = (value: RecordLike): boolean =>
  value.createdBy === "user" &&
  (value.creationSource === "web" || value.creationSource === "mobile") &&
  value.senderThreadId === undefined &&
  value.scheduledTaskId === undefined &&
  value.source === undefined;

const nodeKindsByItemType: Record<string, readonly string[]> = {
  user_message: ["root_turn", "user_message"],
  assistant_message: ["assistant_message"],
  proposed_plan: ["plan"],
  todo_list: ["todo_list"],
  user_input_request: ["tool_call", "user_input_request"],
  approval_request: ["tool_call", "approval_request"],
  secret_request: ["tool_call", "secret_request"],
};

const validNodeForItem = (value: RecordLike, nodeKind: string): boolean => {
  const type = stringValue(value.type);
  if (!type) return false;
  const expected = nodeKindsByItemType[type];
  if (expected) return expected.includes(nodeKind);
  return nodeKind === "tool_call";
};

const recordVersion = (
  id: string,
  type: string,
  status: string,
  ordinal: number | null,
  updatedAt: string | null,
  priority: SupervisorMonitorPriority | null,
  nodeId: string | null,
  rootNodeId: string | null,
): string =>
  createHash("sha256")
    .update(JSON.stringify([id, type, status, ordinal, updatedAt, priority, nodeId, rootNodeId]))
    .digest("hex");

export const isCurrentMainGraphRun = (projection: Projection, run: RunInfo): boolean => {
  if (
    run.threadId !== projection.thread.id ||
    typeof run.rootNodeId !== "string" ||
    run.status === "rolled_back"
  )
    return false;
  const root = mainRunNodeReader(projection, run)(run.rootNodeId);
  return Boolean(root && root.kind === "root_turn" && root.status !== "rolled_back");
};

const isExcluded = (
  id: string,
  rawId: string,
  excludedIds: ReadonlySet<string>,
): boolean =>
  excludedIds.has(id) ||
  excludedIds.has(rawId) ||
  excludedMessagePrefixes.some((prefix) => rawId.startsWith(prefix));

const activity = (input: {
  id: string;
  readItemId: string | null;
  type: string;
  status: string;
  ordinal: number;
  detectedAt: number;
  updatedAt: string | null;
  priority: SupervisorMonitorPriority | null;
  nodeId: string | null;
  rootNodeId: string | null;
}): SupervisorMonitorActivity => ({
  id: input.id,
  readItemId: input.readItemId,
  type: input.type,
  status: input.status,
  ordinal: input.ordinal,
  detectedAt: input.detectedAt,
  version: recordVersion(
    input.id,
    input.type,
    input.status,
    input.type === "native_child_lifecycle" ? null : input.ordinal,
    input.updatedAt,
    input.priority,
    input.nodeId,
    input.rootNodeId,
  ),
  priority: input.priority,
});

const runActivity = (
  run: RunInfo,
  now: number,
  rootNode: RecordLike,
): SupervisorMonitorActivity | null => {
  if (run.status === "rolled_back" || rootNode.status === "rolled_back") return null;
  if (!runTerminalStatuses.has(run.status)) return null;
  const completed = run.status === "completed";
  const type = completed ? "run_finished" : "run_failed";
  const priority = completed ? "run_finished" : "run_failed";
  const updatedAt = stringValue(run.completedAt);
  return activity({
    id: `run:${run.id}`,
    readItemId: null,
    type,
    status: run.status,
    ordinal: run.ordinal,
    detectedAt: timestampMs(updatedAt) ?? timestampMs(run.requestedAt) ?? now,
    updatedAt,
    priority,
    nodeId: run.rootNodeId,
    rootNodeId: run.rootNodeId,
  });
};

const nativeChildLifecycleActivity = (
  childThreadId: string,
  evidence: SupervisorNativeChildLifecycleEvidence,
  ordinal: number,
): SupervisorMonitorActivity | null => {
  if (!childThreadId || !evidence.parentThreadId) return null;
  if (!nativeChildTerminalStatuses.has(evidence.status)) return null;
  const identity = evidence.recordId ?? evidence.parentRunId;
  if (!identity) return null;
  const completedAt = timestampMs(evidence.completedAt);
  const updatedAt = timestampMs(evidence.updatedAt);
  const terminalAt = completedAt ?? updatedAt;
  if (terminalAt === null) return null;
  const completed = ["completed", "resolved", "expired"].includes(evidence.status);
  const priority = completed ? "run_finished" : "run_failed";
  const versionTimestamp = JSON.stringify(completedAt === null ? ["updatedAt", updatedAt] : ["completedAt", completedAt]);
  return activity({
    id: `native-child-lifecycle:${evidence.parentThreadId}:${childThreadId}:${identity}`,
    readItemId: null,
    type: "native_child_lifecycle",
    status: evidence.status,
    ordinal,
    detectedAt: terminalAt,
    updatedAt: versionTimestamp,
    priority,
    nodeId: evidence.recordId,
    rootNodeId: evidence.parentRunId,
  });
};

const messageActivity = (
  threadId: string,
  run: RunInfo,
  nodeFor: (nodeId: string) => RecordLike | undefined,
  message: RecordLike,
  sourceOrdinal: number,
  now: number,
): SupervisorMonitorActivity | null => {
  const id = stringValue(message.id);
  const nodeId = stringValue(message.nodeId);
  const role = stringValue(message.role);
  if (
    !id ||
    !nodeId ||
    message.threadId !== threadId ||
    (role !== "user" && role !== "assistant")
  )
    return null;
  const node = nodeFor(nodeId);
  if (!node) return null;
  if (role === "user" && (!userMessageIsExternal(message) || !["root_turn", "user_message"].includes(String(node.kind)))) return null;
  if (role === "assistant" && (node.kind !== "assistant_message" || message.createdBy === "system")) return null;
  const text = stringValue(message.text);
  if (text === null || (message.streaming !== true && text.trim() === "")) return null;
  const itemId = `message:${id}`;
  const status = message.streaming === true ? "streaming" : "completed";
  const updatedAt = stringValue(message.updatedAt);
  return activity({
    id: itemId,
    readItemId: null,
    type: role === "user" ? "user_message" : "assistant_message",
    status,
    ordinal: run.ordinal,
    detectedAt: timestampMs(updatedAt) ?? timestampMs(message.createdAt) ?? now,
    updatedAt,
    priority: role === "user" && userMessageIsExternal(message)
      ? run.ordinal > sourceOrdinal || message.inputIntent === "queued_turn" || message.inputIntent === "steer" || message.inputIntent === "promoted_queued_to_steer"
        ? "user_instruction"
        : null
      : null,
    nodeId,
    rootNodeId: run.rootNodeId,
  });
};

const turnItemActivity = (
  threadId: string,
  run: RunInfo,
  nodeFor: (nodeId: string) => RecordLike | undefined,
  item: RecordLike,
  pairedMessage: RecordLike | undefined,
  sourceOrdinal: number,
  now: number,
  requestStatus: string,
  requestUpdatedAt: string | null,
): SupervisorMonitorActivity | null => {
  const type = stringValue(item.type);
  const nativeId = stringValue(item.id);
  const nodeId = stringValue(item.nodeId);
  if (
    !type ||
    !nativeId ||
    !nodeId ||
    item.threadId !== threadId ||
    excludedTypes.has(type) ||
    !countableTypes.has(type)
  )
    return null;
  const node = nodeFor(nodeId);
  if (!node || !validNodeForItem(item, String(node.kind))) return null;
  if (type === "user_message" && !userMessageIsExternal(item)) return null;
  if (type === "assistant_message" && item.createdBy === "system") return null;
  if (type === "dynamic_tool" && /thread[_-]?send/iu.test(String(item.toolName ?? ""))) return null;
  const streaming = item.streaming === true;
  if (type === "assistant_message" && (typeof item.text !== "string" || (!streaming && item.text.trim() === ""))) return null;
  if (type === "user_message" && (typeof item.text !== "string" || (!streaming && item.text.trim() === ""))) return null;
  if (type === "proposed_plan" && (typeof item.markdown !== "string" || (!streaming && item.markdown.trim() === ""))) return null;

  const rawMessageId = type === "user_message" || type === "assistant_message" ? stringValue(item.messageId) : null;
  const isRequestItem = type === "user_input_request" || type === "approval_request" || type === "secret_request";
  const requestId = isRequestItem ? stringValue(item.requestId) : null;
  const id = rawMessageId ? `message:${rawMessageId}` : requestId ? `request:${requestId}` : nativeId;
  const sourceStatus = streaming ? "streaming" : stringValue(item.status) ?? "unknown";
  const status = isRequestItem && requestStatus === "pending"
    ? "waiting"
    : isRequestItem && terminalRuntimeRequestStatuses.has(requestStatus)
      ? requestStatus
      : sourceStatus;
  const updatedAt = rawMessageId && pairedMessage
    ? stringValue(pairedMessage.updatedAt)
    : isRequestItem && terminalRuntimeRequestStatuses.has(requestStatus)
      ? requestUpdatedAt ?? stringValue(item.updatedAt)
    : stringValue(item.updatedAt);
  let priority: SupervisorMonitorPriority | null = null;
  if (type === "user_message") priority = inputIntentPriority(item, run.ordinal, sourceOrdinal);
  if (isRequestItem) {
    if (requestStatus === "pending" || !terminalRuntimeRequestStatuses.has(requestStatus) &&
      (sourceStatus === "waiting" || sourceStatus === "pending")) priority = "waiting_input";
  }
  return activity({
    id,
    readItemId: nativeId,
    type,
    status,
    ordinal: run.ordinal,
    detectedAt: timestampMs(updatedAt) ?? timestampMs(item.completedAt) ?? timestampMs(item.startedAt) ?? now,
    updatedAt,
    priority,
    nodeId,
    rootNodeId: run.rootNodeId,
  });
};

/** Extracts metadata-only activity from the current main graph at or after the task run; now is the caller's Clock time. */
export const collectSupervisorActivity = (
  projection: Projection,
  sourceOrdinal: number,
  now: number,
  excludedIds: ReadonlySet<string> = new Set(),
  trackedIds: ReadonlySet<string> = new Set(),
  includeDetachedChildItems = false,
  nativeChildLifecycle?: SupervisorNativeChildLifecycleEvidence,
): SupervisorMonitorActivity[] => {
  const ordinal = Number.isSafeInteger(sourceOrdinal) && sourceOrdinal >= 0 ? sourceOrdinal : 0;
  const runs = new Map<string, { run: RunInfo; nodeFor: (nodeId: string) => RecordLike | undefined; root: RecordLike }>();
  for (const run of projection.runs) {
    if (!isCurrentMainGraphRun(projection, run) || typeof run.rootNodeId !== "string") continue;
    const nodeFor = mainRunNodeReader(projection, run);
    const root = nodeFor(run.rootNodeId);
    if (root?.kind === "root_turn" && root.status !== "rolled_back") runs.set(run.id, { run, nodeFor, root });
  }
  const records = new Map<string, SupervisorMonitorActivity>();
  const messagesById = new Map<string, RecordLike>();
  for (const value of projection.messages) {
    if (!isRecord(value)) continue;
    const id = stringValue(value.id);
    if (id) messagesById.set(id, value);
  }

  for (const context of runs.values()) {
    const { run, root } = context;
    const isCurrent = run.ordinal >= ordinal;
    if (!isCurrent && !trackedIds.has(`run:${run.id}`)) continue;
    const terminal = runActivity(run, now, root);
    if (terminal && !isExcluded(terminal.id, run.id, excludedIds)) records.set(terminal.id, terminal);
  }

  for (const value of projection.turnItems ?? []) {
    if (!isRecord(value)) continue;
    const runId = stringValue(value.runId);
    const context = runId ? runs.get(runId) : undefined;
    if (!context) continue;
    const nativeId = stringValue(value.id);
    const messageId = stringValue(value.messageId);
    const requestId = stringValue(value.requestId);
    const tracked = Boolean(
      (nativeId && trackedIds.has(nativeId)) ||
        (messageId && trackedIds.has(`message:${messageId}`)) ||
        (requestId && trackedIds.has(`request:${requestId}`)),
    );
    if (context.run.ordinal < ordinal && !tracked) continue;
    const pairedMessage = messageId ? messagesById.get(messageId) : undefined;
    const requestType = ["user_input_request", "approval_request", "secret_request"].includes(String(value.type));
    const requestStatus = requestType
      ? freshRuntimeRequestStatus(projection, {requestId, nodeId: stringValue(value.nodeId)})
      : "unknown";
    const requestUpdatedAt = requestType && terminalRuntimeRequestStatuses.has(requestStatus)
      ? runtimeRequestUpdatedAt(projection, requestId, stringValue(value.nodeId))
      : null;
    const record = turnItemActivity(
      projection.thread.id,
      context.run,
      context.nodeFor,
      value,
      pairedMessage,
      ordinal,
      now,
      requestStatus,
      requestUpdatedAt,
    );
    if (!record) continue;
    if (isExcluded(record.id, messageId ?? String(value.id), excludedIds)) continue;
    records.set(record.id, record);
  }

  for (const value of projection.messages) {
    if (!isRecord(value)) continue;
    const runId = stringValue(value.runId);
    const context = runId ? runs.get(runId) : undefined;
    if (!context) continue;
    const id = stringValue(value.id);
    if (!id) continue;
    const canonicalId = `message:${id}`;
    if (records.has(canonicalId) || (context.run.ordinal < ordinal && !trackedIds.has(canonicalId))) continue;
    const record = messageActivity(projection.thread.id, context.run, context.nodeFor, value, ordinal, now);
    if (record && !isExcluded(record.id, id, excludedIds)) records.set(record.id, record);
  }

  // native child mirrors may expose activity with runId:null and no AppRun.
  // accept it only for a verified child observation, never as main-run proof.
  if (includeDetachedChildItems && projection.thread.lineage.relationshipToParent === "subagent") {
    for (const [index, value] of (projection.turnItems ?? []).entries()) {
      if (!isRecord(value) || value.threadId !== projection.thread.id || value.runId !== null) continue;
      const type = stringValue(value.type);
      const nativeId = stringValue(value.id);
      if (!type || !nativeId || excludedTypes.has(type) || !countableTypes.has(type)) continue;
      const messageId = stringValue(value.messageId);
      const requestType = ["user_input_request", "approval_request", "secret_request"].includes(type);
      const requestId = requestType ? stringValue(value.requestId) : null;
      const id = messageId ? `message:${messageId}` : requestId ? `request:${requestId}` : nativeId;
      if (isExcluded(id, messageId ?? nativeId, excludedIds)) continue;
      if ((type === "assistant_message" || type === "user_message") &&
        (typeof value.text !== "string" || value.streaming !== true && value.text.trim() === "")) continue;
      if (type === "proposed_plan" &&
        (typeof value.markdown !== "string" || value.streaming !== true && value.markdown.trim() === "")) continue;
      const sourceStatus = value.streaming === true ? "streaming" : stringValue(value.status) ?? "unknown";
      const itemOrdinal = Number.isSafeInteger(value.ordinal) && Number(value.ordinal) >= 0 ? Number(value.ordinal) : index + 1;
      if (itemOrdinal < ordinal && !trackedIds.has(id) && !trackedIds.has(nativeId)) continue;
      const pairedMessage = messageId ? messagesById.get(messageId) : undefined;
      const requestStatus = requestType
        ? freshRuntimeRequestStatus(projection, {requestId, nodeId: stringValue(value.nodeId)})
        : "unknown";
      const requestUpdatedAt = requestType && terminalRuntimeRequestStatuses.has(requestStatus)
        ? runtimeRequestUpdatedAt(projection, requestId, stringValue(value.nodeId))
        : null;
      const updatedAt = pairedMessage ? stringValue(pairedMessage.updatedAt) :
        requestUpdatedAt ?? stringValue(value.updatedAt);
      const status = requestType && requestStatus === "pending"
        ? "waiting"
        : requestType && terminalRuntimeRequestStatuses.has(requestStatus)
          ? requestStatus
          : sourceStatus;
      const priority = requestType && (requestStatus === "pending" || !terminalRuntimeRequestStatuses.has(requestStatus) &&
        (sourceStatus === "waiting" || sourceStatus === "pending")) ? "waiting_input" : null;
      records.set(id, activity({
        id,
        readItemId: nativeId,
        type,
        status,
        ordinal: itemOrdinal,
        detectedAt: timestampMs(updatedAt) ?? timestampMs(value.completedAt) ?? timestampMs(value.startedAt) ?? now,
        updatedAt,
        priority,
        nodeId: stringValue(value.nodeId),
        rootNodeId: null,
      }));
    }
    if (nativeChildLifecycle && projection.thread.lineage.parentThreadId === nativeChildLifecycle.parentThreadId) {
      const terminal = nativeChildLifecycleActivity(projection.thread.id, nativeChildLifecycle, ordinal);
      if (terminal && !isExcluded(terminal.id, terminal.id, excludedIds)) records.set(terminal.id, terminal);
    }
  }

  const approvalRequestKinds = new Set([
    "command",
    "file-read",
    "file-change",
    "mcp-elicitation",
    "permission",
  ]);
  const requestItems = new Map<string, RecordLike>();
  for (const value of projection.turnItems ?? []) {
    if (!isRecord(value) || value.threadId !== projection.thread.id) continue;
    const requestId = stringValue(value.requestId);
    if (
      requestId &&
      stringValue(value.id) &&
      ["user_input_request", "approval_request", "secret_request"].includes(String(value.type))
    )
      requestItems.set(requestId, value);
  }
  const runtimeRequests = Array.isArray(projection.runtimeRequests) ? projection.runtimeRequests : [];
  for (const value of runtimeRequests) {
    if (!isRecord(value)) continue;
    const requestId = stringValue(value.id);
    const nodeId = stringValue(value.nodeId);
    const kind = stringValue(value.kind);
    if (!requestId || !nodeId || !kind) continue;
    const id = `request:${requestId}`;
    const context = [...runs.values()].find((candidate) => candidate.nodeFor(nodeId) !== undefined);
    if (!context || (context.run.ordinal < ordinal && !trackedIds.has(id))) continue;
    if (kind !== "user_input" && !approvalRequestKinds.has(kind)) continue;
    const freshStatus = freshRuntimeRequestStatus(projection, {requestId, nodeId});
    const status = freshStatus === "unknown" ? "pending" : freshStatus;
    if (status !== "pending" && !trackedIds.has(id)) continue;
    if (!isExcluded(id, requestId, excludedIds)) {
      const item = requestItems.get(requestId);
      const readItemId =
        item && item.nodeId === nodeId ? stringValue(item.id) : null;
      const updatedAt = stringValue(value.resolvedAt) ?? stringValue(value.updatedAt) ?? stringValue(value.createdAt);
      const priority = status === "pending" ? "waiting_input" : null;
      records.set(
        id,
        activity({
          id,
          readItemId,
          type: "runtime_request",
          status: status === "pending" ? "waiting" : status,
          ordinal: context.run.ordinal,
          detectedAt: timestampMs(updatedAt) ?? now,
          updatedAt,
          priority,
          nodeId,
          rootNodeId: context.run.rootNodeId,
        }),
      );
    }
  }

  return [...records.values()].sort(
    (left, right) => left.ordinal - right.ordinal || left.detectedAt - right.detectedAt || left.id.localeCompare(right.id),
  );
};

const isFinalized = (item: Pick<SupervisorMonitorActivity, "status">): boolean =>
  finalizedStatuses.has(item.status);

const finalizedActivity = (item: SupervisorMonitorActivity): boolean =>
  item.type !== "run_finished" &&
  item.type !== "run_failed" &&
  countableTypes.has(item.type) &&
  isFinalized(item);

const priorityRank = (item: SupervisorMonitorActivity): number => {
  if (item.priority === "run_failed") return 0;
  if (item.priority === "waiting_input") return 1;
  if (item.priority === "run_finished") return 2;
  if (item.priority === "user_instruction") return 3;
  return 4;
};

const triggerRank = (trigger: SupervisorMonitorTrigger): number =>
  trigger === "priority" ? 0 : trigger === "saturated" ? 1 : trigger === "activity_age" ? 2 : 3;

/** Applies the per-chat age/count/priority policy and project cooldown. */
export const evaluateSupervisorMonitoring = (
  pending: readonly SupervisorMonitorActivity[],
  settings: SupervisorMonitoringSettings,
  now: number,
  lastProjectNoticeAt: number | null,
  saturated = false,
): SupervisorMonitorDecision => {
  const reviewable = pending.filter(
    (item) => isFinalized(item) || item.priority === "waiting_input",
  );
  const finalized = reviewable.filter(finalizedActivity);
  const ageThresholdMs =
    Number.isFinite(settings.intervalMinutes) && settings.intervalMinutes > 0
      ? settings.intervalMinutes * 60_000
      : SUPERVISOR_MONITOR_AGE_MS;
  const oldestAt = finalized.length
    ? Math.min(...finalized.map((item) => item.detectedAt))
    : null;
  const priorityKinds = [...new Set(reviewable.flatMap((item) => item.priority ? [item.priority] : []))];
  let trigger: SupervisorMonitorTrigger | null = null;
  if (priorityKinds.length > 0) trigger = "priority";
  else if (finalized.length >= settings.activityThreshold) trigger = "activity_threshold";
  else if (oldestAt !== null && now - oldestAt >= ageThresholdMs) trigger = "activity_age";
  else if (saturated) trigger = "saturated";

  const cooldownUntil =
    lastProjectNoticeAt === null
      ? null
      : lastProjectNoticeAt + SUPERVISOR_MONITOR_COOLDOWN_MS;
  const inCooldown = cooldownUntil !== null && now < cooldownUntil;
  const due = trigger !== null && !inCooldown;
  return {
    due,
    trigger,
    finalizedActivityCount: finalized.length,
    pendingItemCount: reviewable.length,
    oldestAt,
    priorityKinds,
    cooldownUntil: inCooldown ? cooldownUntil : null,
  };
};

export const compareMonitorPriority = (
  left: SupervisorMonitorActivity,
  right: SupervisorMonitorActivity,
): number =>
  priorityRank(left) - priorityRank(right) ||
  left.detectedAt - right.detectedAt ||
  left.ordinal - right.ordinal ||
  left.id.localeCompare(right.id);

export const compareMonitorTrigger = (
  left: SupervisorMonitorTrigger,
  right: SupervisorMonitorTrigger,
): number => triggerRank(left) - triggerRank(right);
