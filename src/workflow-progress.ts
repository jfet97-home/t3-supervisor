import { Schema } from "effect";
import type { ProjectSupervisor } from "./project-supervisor.js";
import type { WorkflowWriteController } from "./workflow-write-controller.js";
import { ProjectSupervisorScopeSnapshotSchema, type ProjectSupervisorScopeSnapshot } from "./supervisor-observation.js";
import { WorkflowExecutionStatus, WorkflowPlanGroupSchema } from "./project-supervisor-contract.js";
import type { WorkflowStateDocument, WorkflowStateEvidence } from "./workflow-state-contract.js";

const NullableText = Schema.NullOr(Schema.String);

export const WorkflowProgressObservationSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["status_changed", "note", "observation"]),
  recordedAt: Schema.Number,
  targetNodeId: NullableText,
  targetNodeName: NullableText,
  statusFrom: Schema.NullOr(WorkflowExecutionStatus),
  statusTo: Schema.NullOr(WorkflowExecutionStatus),
  sourceThreadId: NullableText,
  sourceRunId: NullableText,
  sourceMessageId: NullableText,
  sourceItemId: Schema.optionalKey(NullableText),
  note: Schema.String,
});
export type WorkflowProgressObservation = typeof WorkflowProgressObservationSchema.Type;

export const WorkflowProgressWorkflowSchema = Schema.Struct({
  workflowId: Schema.String,
  projectId: Schema.String,
  mainThreadId: Schema.String,
  threadId: Schema.String,
  parentThreadId: NullableText,
  revision: Schema.Number,
  status: WorkflowExecutionStatus,
  objective: NullableText,
  plan: Schema.NullOr(WorkflowPlanGroupSchema),
  updatedAt: Schema.Number,
  parentNodeReferences: Schema.Array(Schema.Struct({
    parentWorkflowId: Schema.String,
    parentThreadId: Schema.String,
    nodeId: Schema.String,
    nodeKind: Schema.Literals(["step", "workflow"]),
    nodeName: Schema.String,
  })),
  observations: Schema.Array(WorkflowProgressObservationSchema),
});
export type WorkflowProgressWorkflow = typeof WorkflowProgressWorkflowSchema.Type;

export const WorkflowProgressSnapshotSchema = Schema.Struct({
  status: Schema.Literals(["ok", "unavailable", "denied", "invalid", "incompatible", "too_large"]),
  message: NullableText,
  projectId: Schema.String,
  mainThreadId: Schema.String,
  observedAt: Schema.Number,
  scope: Schema.NullOr(ProjectSupervisorScopeSnapshotSchema),
  incompatibleWorkflows: Schema.Array(Schema.Struct({workflowId: Schema.String, formatVersion: Schema.NullOr(Schema.Number)})),
  workflows: Schema.Array(WorkflowProgressWorkflowSchema),
  workflowOffset: Schema.Number,
  workflowHasMore: Schema.Boolean,
  lineageOffset: Schema.Number,
  lineageHasMore: Schema.Boolean,
});
export type WorkflowProgressSnapshot = typeof WorkflowProgressSnapshotSchema.Type;

export type WorkflowProgressPageQuery = {
  projectId: string;
  mainThreadId: string;
  workflowOffset: number;
  lineageOffset: number;
  limit: number;
};

export type WorkflowProgressPagingQuery = {
  projectId: string;
  mainThreadId: string;
  workflowOffset?: string | undefined;
  lineageOffset?: string | undefined;
  limit?: string | undefined;
};

const maxWorkflowProgressResponseBytes = 1_048_576;

const parseInteger = (value: string | undefined, fallback: number, minimum: number, maximum: number): number | null => {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
};

export const parseWorkflowProgressPageQuery = (query: WorkflowProgressPagingQuery): WorkflowProgressPageQuery | null => {
  const workflowOffset = parseInteger(query.workflowOffset, 0, 0, 10_000);
  const lineageOffset = parseInteger(query.lineageOffset, 0, 0, 10_000);
  const limit = parseInteger(query.limit, 20, 1, 50);
  if (workflowOffset === null || lineageOffset === null || limit === null || !query.projectId || !query.mainThreadId) return null;
  return {projectId: query.projectId, mainThreadId: query.mainThreadId, workflowOffset, lineageOffset, limit};
};

const emptyPage = (query: WorkflowProgressPageQuery, status: WorkflowProgressSnapshot["status"], message: string,
  scope: ProjectSupervisorScopeSnapshot | null, observedAt = Date.now()): WorkflowProgressSnapshot => ({
  status,
  message,
  projectId: query.projectId,
  mainThreadId: query.mainThreadId,
  observedAt,
  scope,
  incompatibleWorkflows: [],
  workflows: [],
  workflowOffset: query.workflowOffset,
  workflowHasMore: false,
  lineageOffset: query.lineageOffset,
  lineageHasMore: false,
});

const scopePage = (scope: ProjectSupervisorScopeSnapshot, threadIds: readonly string[]): ProjectSupervisorScopeSnapshot => {
  const wanted = new Set(threadIds);
  return {...scope, threads: scope.threads.filter(thread => wanted.has(thread.threadId))};
};

const observationKinds = new Set<WorkflowStateEvidence["kind"]>(["status_changed", "note", "observation"]);

type ParentNodeReference = {
  parentWorkflowId: string;
  parentThreadId: string;
  nodeId: string;
  nodeKind: "step" | "workflow";
  nodeName: string;
};

const progressWorkflow = (document: WorkflowStateDocument, parentNodeReferences: readonly ParentNodeReference[]): WorkflowProgressWorkflow => ({
  workflowId: document.workflowId,
  projectId: document.projectId,
  mainThreadId: document.mainThreadId,
  threadId: document.threadId,
  parentThreadId: document.parentThreadId,
  revision: document.revision,
  status: document.status,
  objective: document.objective,
  plan: document.plan,
  updatedAt: document.updatedAt,
  parentNodeReferences: [...parentNodeReferences],
  observations: document.evidence.filter(item => observationKinds.has(item.kind))
    .sort((left, right) => right.recordedAt - left.recordedAt).slice(0, 20).map(item => ({
      id: item.id,
      kind: item.kind as "status_changed" | "note" | "observation",
      recordedAt: item.recordedAt,
      targetNodeId: item.targetNodeId,
      targetNodeName: item.targetNodeName,
      statusFrom: item.statusFrom,
      statusTo: item.statusTo,
      sourceThreadId: item.sourceThreadId,
      sourceRunId: item.sourceRunId,
      sourceMessageId: item.sourceMessageId,
      sourceItemId: (item as WorkflowStateEvidence & {sourceItemId?: string | null}).sourceItemId ?? null,
      note: item.note,
    })),
});

export const readWorkflowProgressPage = async (
  supervision: ProjectSupervisor,
  workflowReader: WorkflowWriteController,
  query: WorkflowProgressPageQuery,
  signal: AbortSignal,
): Promise<WorkflowProgressSnapshot> => {
  const bounded = (result: WorkflowProgressSnapshot): WorkflowProgressSnapshot =>
    new TextEncoder().encode(JSON.stringify(result)).length <= maxWorkflowProgressResponseBytes
      ? result
      : emptyPage(query, "too_large", "The combined live snapshot exceeds the dashboard response limit; no partial status was returned.", null);
  const locator = supervision.workflowLocator(query.projectId, query.mainThreadId);
  const matchingLocator = (expected: NonNullable<typeof locator>) => {
    const current = supervision.workflowLocator(query.projectId, query.mainThreadId);
    return current?.supervisorThreadId === expected.supervisorThreadId && current.bindingGeneration === expected.bindingGeneration;
  };
  const pageScope = async () => supervision.scopeSnapshot(query.projectId, query.mainThreadId, signal, {
    lineageOffset: query.lineageOffset,
    limit: query.limit,
  });

  if (!locator) {
    const scope = await pageScope();
    if (scope.projectId !== query.projectId || scope.mainThreadId !== query.mainThreadId ||
      supervision.workflowLocator(query.projectId, query.mainThreadId)) {
      return emptyPage(query, "unavailable", "The Supervisor binding changed during this read. Refresh progress to retry.", null);
    }
    return bounded({...emptyPage(query, "unavailable", "No current ready Supervisor binding is available for this main conversation.",
      scope, scope.observedAt), lineageHasMore: scope.lineageHasMore});
  }

  const read = await workflowReader.read({
    supervisorThreadId: locator.supervisorThreadId,
    bindingGeneration: locator.bindingGeneration,
    workflowOffset: query.workflowOffset,
    lineageOffset: query.lineageOffset,
    limit: query.limit,
  }, signal);
  if (!matchingLocator(locator)) {
    return emptyPage(query, "unavailable", "The Supervisor binding changed during this read. Refresh progress to retry.", null);
  }
  if (read.status !== "ok") {
    const scope = await pageScope();
    if (!matchingLocator(locator) || scope.supervisorThreadId !== locator.supervisorThreadId ||
      scope.bindingGeneration !== locator.bindingGeneration || scope.projectId !== query.projectId || scope.mainThreadId !== query.mainThreadId) {
      return emptyPage(query, "unavailable", "The Supervisor binding changed during this read. Refresh progress to retry.", null);
    }
    return bounded({...emptyPage(query, read.status, read.reason, scope, scope.observedAt),
      lineageHasMore: scope.lineageHasMore,
      incompatibleWorkflows: read.status === "incompatible" ? [{workflowId: read.workflowId, formatVersion: read.formatVersion}] : []});
  }
  if (read.owner.projectId !== query.projectId || read.owner.mainThreadId !== query.mainThreadId ||
    read.owner.supervisorThreadId !== locator.supervisorThreadId || read.owner.bindingGeneration !== locator.bindingGeneration) {
    return emptyPage(query, "unavailable", "The Supervisor binding changed during this read. Refresh progress to retry.", null);
  }
  const workflowThreadIds = read.lineage.map(thread => thread.threadId);
  const scope = await supervision.scopeSnapshot(query.projectId, query.mainThreadId, signal, {threadIds: workflowThreadIds});
  if (!matchingLocator(locator) || scope.projectId !== query.projectId || scope.mainThreadId !== query.mainThreadId ||
    scope.supervisorThreadId !== locator.supervisorThreadId || scope.bindingGeneration !== locator.bindingGeneration) {
    return emptyPage(query, "unavailable", "The Supervisor binding changed during this read. Refresh progress to retry.", null);
  }
  const threadScope = scopePage(scope, workflowThreadIds);
  return bounded({
    status: "ok",
    message: scope.complete ? null : "Native scope observation is incomplete. Review the issues below before relying on this snapshot.",
    projectId: query.projectId,
    mainThreadId: query.mainThreadId,
    observedAt: Date.now(),
    scope: threadScope,
    incompatibleWorkflows: read.incompatibleWorkflows,
    workflows: read.workflows.map(({document, parentNodeReferences}) => progressWorkflow(document, parentNodeReferences)),
    workflowOffset: read.workflowOffset,
    workflowHasMore: read.workflowHasMore,
    lineageOffset: read.lineageOffset,
    lineageHasMore: read.lineageHasMore,
  });
};
