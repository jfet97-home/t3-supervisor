import type {
  MessageInfo,
  Projection,
  RunInfo,
  ThreadInfo,
} from "./types.js";
export { timestampMs } from "./timestamp.js";

const activeRunStates = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const activeTaskStates = new Set(["pending", "running", "waiting"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type FreshRuntimeRequestStatus = "pending" | "resolved" | "expired" | "cancelled" | "unknown";

export const freshRuntimeRequestStatus = (
  projection: Projection,
  identity: {requestId?: string | null; nodeId?: string | null},
): FreshRuntimeRequestStatus => {
  if (!Array.isArray(projection.runtimeRequests) || !identity.requestId || !identity.nodeId) return "unknown";
  const node = nodeIndex(projection).get(identity.nodeId);
  if (!node || node.threadId !== projection.thread.id) return "unknown";
  const matches = projection.runtimeRequests.filter((value) => {
    if (!isRecord(value)) return false;
    const requestId = typeof value.id === "string" ? value.id : typeof value.requestId === "string" ? value.requestId : null;
    return requestId === identity.requestId && value.nodeId === identity.nodeId;
  });
  if (matches.length !== 1) return "unknown";
  const status = matches[0]?.status;
  return status === "pending" || status === "resolved" || status === "expired" || status === "cancelled"
    ? status
    : "unknown";
};

const runtimeRequestIdentity = (value: unknown): {requestId?: string; nodeId?: string} => {
  if (!isRecord(value)) return {};
  const requestId = typeof value.id === "string" ? value.id : typeof value.requestId === "string" ? value.requestId : undefined;
  const nodeId = typeof value.nodeId === "string" ? value.nodeId : undefined;
  return {...(requestId === undefined ? {} : {requestId}), ...(nodeId === undefined ? {} : {nodeId})};
};

const runtimeRequestMayBePending = (projection: Projection, value: unknown): boolean => {
  if (!isRecord(value)) return true;
  const status = freshRuntimeRequestStatus(projection, runtimeRequestIdentity(value));
  return status === "pending" || status === "unknown" && value.status === "pending";
};

const hasBlockingBackgroundTask = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;
  return value.some((task) => !isRecord(task) || task.kind !== "command");
};

const hasPullRequestWatch = (thread: ThreadInfo): boolean =>
  Array.isArray(thread.pullRequests) && thread.pullRequests.some((value) =>
    isRecord(value) && value.watch !== undefined && value.watch !== null && value.source !== "stack-dismissed"
  );

const nodeIndex = (projection: Projection): Map<string, Record<string, unknown>> => {
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(projection.nodes)) return result;
  for (const value of projection.nodes) {
    if (isRecord(value) && typeof value.id === "string") result.set(value.id, value);
  }
  return result;
};

const isMainRootNode = (
  projection: Projection,
  run: RunInfo,
  nodeId: string,
  nodes: Map<string, Record<string, unknown>>,
  completedAssistant: boolean,
): boolean => {
  const rootId = run.rootNodeId;
  const providerThreadId = run.providerThreadId;
  if (typeof rootId !== "string" || typeof providerThreadId !== "string" || typeof nodeId !== "string") return false;
  const root = nodes.get(rootId);
  const candidate = nodes.get(nodeId);
  if (
    !root ||
    root.kind !== "root_turn" ||
    root.id !== rootId ||
    root.threadId !== projection.thread.id ||
    root.runId !== run.id ||
    root.rootNodeId !== rootId ||
    root.providerThreadId !== providerThreadId ||
    (completedAssistant && root.status !== "completed") ||
    !candidate ||
    (completedAssistant && candidate.kind !== "assistant_message") ||
    candidate.id !== nodeId ||
    candidate.threadId !== projection.thread.id ||
    candidate.runId !== run.id ||
    candidate.rootNodeId !== rootId ||
    candidate.providerThreadId !== providerThreadId ||
    (completedAssistant && candidate.status !== "completed")
  ) return false;

  let current = candidate;
  const visited = new Set<string>();
  while (current.id !== rootId) {
    if (typeof current.id !== "string" || visited.has(current.id) || current.kind === "subagent") return false;
    visited.add(current.id);
    const parentId = current.parentNodeId;
    if (typeof parentId !== "string") return false;
    const parent = nodes.get(parentId);
    if (
      !parent ||
      parent.kind === "subagent" ||
      parent.threadId !== projection.thread.id ||
      parent.runId !== run.id ||
      parent.rootNodeId !== rootId ||
      parent.providerThreadId !== providerThreadId
    ) return false;
    current = parent;
  }
  return true;
};

export const mainRunNodeReader = (projection: Projection, run: RunInfo) => {
  const nodes=nodeIndex(projection);
  return (nodeId:string): Record<string,unknown>|undefined =>
    isMainRootNode(projection,run,nodeId,nodes,false) ? nodes.get(nodeId) : undefined;
};

/** Matches a native primary user message to its retained root_turn node, including after restart. */
export const nativeUserMessageVisible = (projection: Projection, run: RunInfo, message: MessageInfo): boolean => {
  if (run.threadId !== projection.thread.id || message.threadId !== projection.thread.id || message.runId !== run.id ||
    typeof message.nodeId !== "string" || message.role !== "user" || message.streaming !== false || run.status === "rolled_back") return false;
  const root = Array.isArray(projection.nodes) ? projection.nodes.find(node => isRecord(node) && node.id === message.nodeId) : undefined;
  return isRecord(root) && root.kind === "root_turn" && root.id === root.rootNodeId && root.threadId === projection.thread.id &&
    root.runId === run.id && (root.parentNodeId === null || root.parentNodeId === undefined) && root.status !== "rolled_back";
};

const runIsBusy = (projection: Projection, run: RunInfo, shell?: Record<string, unknown>): boolean => {
  const nodes = nodeIndex(projection);
  const latestRun = projection.runs.reduce<RunInfo | undefined>(
    (latest, candidate) => latest === undefined || candidate.ordinal > latest.ordinal ? candidate : latest,
    undefined,
  );
  const isLatest = latestRun?.id === run.id;
  const belongsToRun = (value: unknown): boolean => {
    if (!isRecord(value)) return isLatest;
    for (const key of ["parentRunId", "sourceRunId", "runId"]) {
      if (typeof value[key] === "string") return value[key] === run.id;
    }
    for (const key of ["ownerNodeId", "parentNodeId", "nodeId", "rootNodeId"]) {
      if (typeof value[key] !== "string") continue;
      const owner = nodes.get(value[key]);
      if (typeof owner?.runId === "string") return owner.runId === run.id;
    }
    // unscoped thread state only applies to the latest run
    return isLatest;
  };
  const thread = projection.thread;
  const summary = shell ?? thread;
  const requestHint = summary.pendingRuntimeRequest;
  const requestHintStatus = requestHint === undefined || requestHint === null
    ? null
    : freshRuntimeRequestStatus(projection, runtimeRequestIdentity(requestHint));
  if (
    summary.activeRunId === run.id ||
    (isLatest && (
      (Boolean(summary.activeRunId) && !projection.runs.some((candidate) => candidate.id === summary.activeRunId)) ||
      (typeof summary.activityRunStatus === "string" && activeRunStates.has(summary.activityRunStatus)) ||
      (typeof summary.status === "string" && activeRunStates.has(summary.status)) ||
      hasBlockingBackgroundTask(summary.pendingBackgroundTasks)
    )) ||
    (requestHintStatus === "unknown" && belongsToRun(requestHint))
  ) return true;

  if (Array.isArray(projection.runtimeRequests) && projection.runtimeRequests.some((request) =>
    runtimeRequestMayBePending(projection, request) && belongsToRun(request)
  )) return true;

  if (Array.isArray(projection.turnItems) && projection.turnItems.some((item) =>
    isRecord(item) && (item.type === "dynamic_tool" || item.type === "subagent") &&
    activeTaskStates.has(String(item.status)) && belongsToRun(item) &&
    !(item.type === "dynamic_tool" && isRecord(item.input) && item.input.persistent === true)
  )) return true;

  if (Array.isArray(projection.subagents) && projection.subagents.some((task) => {
    if (!belongsToRun(task)) return false;
    if (!isRecord(task)) return true;
    const delivery = isRecord(task.completionDelivery) ? task.completionDelivery : {};
    return activeTaskStates.has(String(task.status)) || delivery.state === "pending" || delivery.state === "claimed";
  })) return true;

  // provider goals, rosters and watches describe ongoing thread work, not prior turns
  if (!isLatest) return false;
  if (hasPullRequestWatch(thread)) return true;
  const providerThreadId = typeof thread.activeProviderThreadId === "string"
    ? thread.activeProviderThreadId
    : typeof run.providerThreadId === "string" ? run.providerThreadId : null;
  if (providerThreadId !== null && Array.isArray(projection.providerThreads)) {
    for (const providerThread of projection.providerThreads) {
      if (!isRecord(providerThread) || providerThread.id !== providerThreadId) continue;
      if (hasBlockingBackgroundTask(providerThread.pendingBackgroundTasks)) return true;
      if (isRecord(providerThread.goal) && providerThread.goal.status === "active") return true;
    }
  }
  return false;
};

/** Checks native activity that can keep a conversation from being considered idle. */
export const projectionHasOngoingWork = (projection: Projection, shell?: ThreadInfo): boolean => {
  if (projection.runs.some(run => activeRunStates.has(run.status))) return true;
  if (Array.isArray(projection.runtimeRequests) && projection.runtimeRequests.some(request => runtimeRequestMayBePending(projection, request))) return true;
  const latest = projection.runs.reduce<RunInfo | undefined>((old, run) => !old || run.ordinal > old.ordinal ? run : old, undefined);
  if (latest && runIsBusy(projection, latest, shell)) return true;
  if (hasPullRequestWatch(projection.thread) || hasBlockingBackgroundTask((shell ?? projection.thread).pendingBackgroundTasks)) return true;
  if (Array.isArray(projection.providerThreads) && projection.providerThreads.some(provider => isRecord(provider) &&
    (hasBlockingBackgroundTask(provider.pendingBackgroundTasks) || isRecord(provider.goal) && provider.goal.status === "active"))) return true;
  return (projection.subagents ?? []).some(task => {
    const delivery = isRecord(task.completionDelivery) ? task.completionDelivery : {};
    return activeTaskStates.has(String(task.status)) || delivery.state === "pending" || delivery.state === "claimed";
  });
};
