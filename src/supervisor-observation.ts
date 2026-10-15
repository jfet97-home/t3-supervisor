import { Schema } from "effect";
import type { SupervisorMonitorActivity } from "./supervisor-monitor.js";
import type { Projection, ThreadInfo } from "./types.js";

export const SUPERVISOR_SCOPE_SNAPSHOT_MAX_THREADS = 100;
export const SUPERVISOR_SCOPE_SNAPSHOT_MAX_ACTIVITY_REFS = 20;

export const SupervisorObservationIssueSchema = Schema.Struct({code: Schema.String, message: Schema.String});
export type SupervisorObservationIssue = typeof SupervisorObservationIssueSchema.Type;

export const SupervisorActivityReferenceSchema = Schema.Struct({
  sourceThreadId: Schema.String,
  sourceRunId: Schema.NullOr(Schema.String),
  sourceMessageId: Schema.NullOr(Schema.String),
  sourceItemId: Schema.NullOr(Schema.String),
  kind: Schema.String,
  observedAt: Schema.Number,
  label: Schema.String,
});
export type SupervisorActivityReference = typeof SupervisorActivityReferenceSchema.Type;

export const SupervisorScopeOrigin = Schema.Literals(["main", "native_child", "delegated_child", "unknown_child"]);
export type SupervisorScopeOrigin = typeof SupervisorScopeOrigin.Type;
export const SupervisorScopeLifecycle = Schema.Literals(["running", "completed", "interrupted", "unknown"]);
export type SupervisorScopeLifecycle = typeof SupervisorScopeLifecycle.Type;

export const ProjectSupervisorScopeThreadSchema = Schema.Struct({
  threadId: Schema.String,
  parentThreadId: Schema.NullOr(Schema.String),
  depth: Schema.Number,
  origin: SupervisorScopeOrigin,
  lifecycle: SupervisorScopeLifecycle,
  lifecycleDetail: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  deletedAt: Schema.NullOr(Schema.String),
  activityRefs: Schema.Array(SupervisorActivityReferenceSchema),
  contactLimit: Schema.String,
});
export type ProjectSupervisorScopeThread = typeof ProjectSupervisorScopeThreadSchema.Type;

export const ProjectSupervisorScopeSnapshotSchema = Schema.Struct({
  projectId: Schema.String,
  mainThreadId: Schema.String,
  supervisorThreadId: Schema.NullOr(Schema.String),
  bindingGeneration: Schema.NullOr(Schema.Number),
  observedAt: Schema.Number,
  lineageTotal: Schema.Number,
  lineageOffset: Schema.Number,
  lineageHasMore: Schema.Boolean,
  complete: Schema.Boolean,
  issues: Schema.Array(SupervisorObservationIssueSchema),
  threads: Schema.Array(ProjectSupervisorScopeThreadSchema),
});
export type ProjectSupervisorScopeSnapshot = typeof ProjectSupervisorScopeSnapshotSchema.Type;
export type SupervisorScopeObservedThread = ProjectSupervisorScopeThread;

export type SupervisorChildLifecycleRecord = {status: string; source: "parent_subagents" | "parent_turn_item"};

/** Matches lifecycle only on the child's direct parent, never the root's stale grandchild record. */
export const directParentChildLifecycle = (parent: Projection, childThreadId: string): SupervisorChildLifecycleRecord | null => {
  const matches: SupervisorChildLifecycleRecord[] = [];
  for (const value of parent.subagents ?? []) {
    if (value.childThreadId === childThreadId && typeof value.status === "string")
      matches.push({status: value.status, source: "parent_subagents"});
  }
  for (const value of parent.turnItems ?? []) {
    if (value.type === "subagent" && value.childThreadId === childThreadId && typeof value.status === "string")
      matches.push({status: value.status, source: "parent_turn_item"});
  }
  const statuses = [...new Set(matches.map(match => match.status))];
  return statuses.length === 1 ? matches[0]! : null;
};

export const monitorActivityReference = (
  threadId: string,
  projection: Projection | null,
  activity: SupervisorMonitorActivity,
): SupervisorActivityReference => {
  const item = projection?.turnItems?.find(value => value.id === (activity.readItemId ?? activity.id) || value.id === activity.id);
  const messageId = activity.id.startsWith("message:") ? activity.id.slice("message:".length) :
    typeof item?.messageId === "string" ? item.messageId : null;
  const message = messageId ? projection?.messages.find(value => value.id === messageId && value.threadId === threadId) : undefined;
  const runId = typeof item?.runId === "string" ? item.runId :
    typeof message?.runId === "string" ? message.runId : activity.id.startsWith("run:") ? activity.id.slice("run:".length) : null;
  const rawType = activity.type.replace(/[^a-z0-9_ -]/giu, "").slice(0, 48) || "activity";
  const rawStatus = activity.status.replace(/[^a-z0-9_ -]/giu, "").slice(0, 32) || "unknown";
  return {
    sourceThreadId: threadId,
    sourceRunId: runId,
    sourceMessageId: messageId,
    sourceItemId: activity.readItemId,
    kind: rawType,
    observedAt: activity.detectedAt,
    label: `${rawType} · ${rawStatus}`.slice(0, 96),
  };
};

const runningStatuses = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const interruptedStatuses = new Set(["interrupted", "failed", "cancelled", "rolled_back"]);
const finishedStatuses = new Set(["completed", "expired", "resolved"]);

export const normalizeLifecycle = (status: unknown): {lifecycle: SupervisorScopeLifecycle; detail: string | null} => {
  if (typeof status !== "string") return {lifecycle: "unknown", detail: null};
  if (runningStatuses.has(status)) return {lifecycle: "running", detail: status};
  if (interruptedStatuses.has(status)) return {lifecycle: "interrupted", detail: status};
  if (finishedStatuses.has(status)) return {lifecycle: "completed", detail: status};
  return {lifecycle: "unknown", detail: status};
};

export const delegatedLifecycle = (thread: ThreadInfo, projection: Projection): {lifecycle: SupervisorScopeLifecycle; detail: string | null} => {
  const activeRunId = typeof thread.activeRunId === "string" ? thread.activeRunId : null;
  if (activeRunId) {
    const run = projection.runs.find(candidate => candidate.id === activeRunId);
    if (!run) return {lifecycle: "unknown", detail: null};
    return normalizeLifecycle(run.status);
  }
  if (typeof thread.activityRunStatus === "string" && runningStatuses.has(thread.activityRunStatus))
    return normalizeLifecycle(thread.activityRunStatus);
  const run = [...projection.runs].sort((left, right) => right.ordinal - left.ordinal)[0];
  return run ? normalizeLifecycle(run.status) : {lifecycle: "unknown", detail: null};
};

export const childOrigin = (thread: ThreadInfo, parent: Projection | undefined): SupervisorScopeOrigin => {
  if (thread.creationSource === "mcp") return "delegated_child";
  if (thread.creationSource === "provider" || parent && directParentChildLifecycle(parent, thread.id)) return "native_child";
  return "unknown_child";
};

export const contactLimit = (origin: SupervisorScopeOrigin, lifecycle: SupervisorScopeLifecycle, archivedAt: string | null, deletedAt: string | null): string => {
  if (archivedAt || deletedAt) return "Archived or deleted; do not contact directly.";
  if (origin === "main") return "Contact the main through its native T3 chat when its mode allows.";
  if (origin === "native_child") return "Guide through the direct parent; keep native child contact mediated.";
  if (origin === "delegated_child" && lifecycle === "running") return "Direct guidance only with active-only steer; on rejection route through the parent. Never queue.";
  if (lifecycle === "completed" || lifecycle === "interrupted") return "Terminal child; route follow-up through the parent.";
  return "Lifecycle is unknown; route guidance through the parent.";
};

export const observeScopeThread = (input: {
  thread: ThreadInfo;
  mainThreadId: string;
  depth: number;
  projection: Projection | null;
  parentProjection: Projection | null;
  lineageVerified?: boolean;
  activityRefs: SupervisorActivityReference[];
}): SupervisorScopeObservedThread => {
  const {thread, projection} = input;
  const parentThreadId = typeof thread.lineage.parentThreadId === "string" ? thread.lineage.parentThreadId : null;
  const archivedAt = typeof thread.archivedAt === "string" ? thread.archivedAt : null;
  const deletedAt = typeof thread.deletedAt === "string" ? thread.deletedAt : null;
  const origin: SupervisorScopeOrigin = thread.id === input.mainThreadId ? "main" : input.lineageVerified === false
    ? "unknown_child" : childOrigin(thread, input.parentProjection ?? undefined);
  let current: {lifecycle: SupervisorScopeLifecycle; detail: string | null} = {lifecycle: "unknown", detail: null};
  if (origin === "native_child") {
    const record = input.parentProjection ? directParentChildLifecycle(input.parentProjection, thread.id) : null;
    current = record ? normalizeLifecycle(record.status) : current;
  } else if ((origin === "delegated_child" || origin === "main") && projection) current = delegatedLifecycle(thread, projection);
  return {
    threadId: thread.id,
    parentThreadId,
    depth: input.depth,
    origin,
    lifecycle: current.lifecycle,
    lifecycleDetail: current.detail,
    archivedAt,
    deletedAt,
    activityRefs: input.lineageVerified === false ? [] : input.activityRefs.slice(0, SUPERVISOR_SCOPE_SNAPSHOT_MAX_ACTIVITY_REFS),
    contactLimit: contactLimit(origin, current.lifecycle, archivedAt, deletedAt),
  };
};
