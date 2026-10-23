import { Schema } from "effect";
import { ProjectSupervisorScopeSnapshotSchema, type ProjectSupervisorScopeSnapshot } from "./supervisor-observation.js";
import { WorkflowExecutionStatus, WorkflowPlanGroupSchema, type WorkflowPlanGroupInfo } from "./project-supervisor-contract.js";
import { externalContributionDecisions, externalContributionReferenceKinds, externalContributionStates,
  type WorkflowStateDocument, type WorkflowStateEvidence } from "./workflow-state-contract.js";

import { WorkflowAssessment, workflowAssessment } from "./workflow-assessment.js";

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

// a main-reported external contribution; its text is untrusted and its execution was not observed
export const WorkflowProgressContributionSchema = Schema.Struct({
  contributionId: Schema.String,
  nodeId: Schema.String,
  nodeName: NullableText,
  inCurrentPlan: Schema.Boolean,
  state: Schema.Literals(externalContributionStates),
  revision: Schema.Number,
  summary: Schema.String,
  references: Schema.Array(Schema.Struct({kind: Schema.Literals(externalContributionReferenceKinds), value: Schema.String})),
  externalRef: NullableText,
  sourceThreadId: Schema.String,
  sourceMessageId: Schema.String,
  recordedAt: Schema.Number,
  assessment: Schema.NullOr(Schema.Struct({
    decision: Schema.Literals(externalContributionDecisions),
    resultRevision: Schema.Number,
    note: Schema.String,
    recordedAt: Schema.Number,
  })),
});
export type WorkflowProgressContribution = typeof WorkflowProgressContributionSchema.Type;

export const WorkflowProgressWorkflowSchema = Schema.Struct({
  workflowId: Schema.String,
  projectId: Schema.String,
  mainThreadId: Schema.String,
  threadId: Schema.String,
  parentThreadId: NullableText,
  revision: Schema.Number,
  status: WorkflowExecutionStatus,
  assessment: Schema.optionalKey(Schema.NullOr(WorkflowAssessment)),
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
  contributions: Schema.Array(WorkflowProgressContributionSchema),
});
export type WorkflowProgressWorkflow = typeof WorkflowProgressWorkflowSchema.Type;

export const WorkflowProgressCoverageSchema = Schema.Struct({
  threadId: Schema.String,
  state: Schema.Literals(["root", "assigned", "transfer", "observe_only", "unknown"]),
  assigneeThreadId: NullableText,
  assigneeTitle: NullableText,
  assignmentRootThreadId: NullableText,
});
export type WorkflowProgressCoverage = typeof WorkflowProgressCoverageSchema.Type;

export const WorkflowProgressSnapshotSchema = Schema.Struct({
  status: Schema.Literals(["ok", "unavailable", "denied", "invalid", "incompatible", "too_large"]),
  message: NullableText,
  projectId: Schema.String,
  mainThreadId: Schema.String,
  observedAt: Schema.Number,
  scope: Schema.NullOr(ProjectSupervisorScopeSnapshotSchema),
  coverage: Schema.optionalKey(Schema.Array(WorkflowProgressCoverageSchema)),
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

export const maxWorkflowProgressResponseBytes = 1_048_576;

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

// a page without workflow content; observedAt is the scope's time, else the reader's clock
export const emptyPage = (query: WorkflowProgressPageQuery, status: WorkflowProgressSnapshot["status"], message: string,
  scope: ProjectSupervisorScopeSnapshot | null, observedAt: number): WorkflowProgressSnapshot => ({
  status,
  message,
  projectId: query.projectId,
  mainThreadId: query.mainThreadId,
  observedAt,
  scope,
  coverage: [],
  incompatibleWorkflows: [],
  workflows: [],
  workflowOffset: query.workflowOffset,
  workflowHasMore: false,
  lineageOffset: query.lineageOffset,
  lineageHasMore: false,
});

export const scopePage = (scope: ProjectSupervisorScopeSnapshot, threadIds: readonly string[]): ProjectSupervisorScopeSnapshot => {
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

// the browser bundle imports this module's types, so it walks the plan itself instead of loading the store
const planNodeNames = (plan: WorkflowPlanGroupInfo | null, names = new Map<string, string>()): Map<string, string> => {
  for (const node of plan?.nodes ?? []) {
    if ("nodes" in node) planNodeNames(node, names);
    else {
      names.set(node.nodeId, node.name);
      if (node.kind === "workflow") planNodeNames(node.plan, names);
    }
  }
  return names;
};

// a removed node keeps the last name recorded for it so its contributions stay recognizable as history
const contributionNodeName = (document: WorkflowStateDocument, nodeId: string, planNames: ReadonlyMap<string, string>): string | null =>
  planNames.get(nodeId) ?? document.evidence.findLast(item => item.targetNodeId === nodeId && item.targetNodeName !== null)?.targetNodeName ?? null;

const progressContributions = (document: WorkflowStateDocument): WorkflowProgressContribution[] => {
  const planNames = planNodeNames(document.plan);
  return document.contributions.map(item => ({
    contributionId: item.contributionId,
    nodeId: item.nodeId,
    nodeName: contributionNodeName(document, item.nodeId, planNames),
    inCurrentPlan: planNames.has(item.nodeId),
    state: item.state,
    revision: item.revision,
    summary: item.summary,
    references: item.references.map(reference => ({kind: reference.kind, value: reference.value})),
    externalRef: item.externalRef,
    sourceThreadId: item.sourceThreadId,
    sourceMessageId: item.sourceMessageId,
    recordedAt: item.recordedAt,
    assessment: item.assessment ? {decision: item.assessment.decision, resultRevision: item.assessment.resultRevision,
      note: item.assessment.note, recordedAt: item.assessment.recordedAt} : null,
  }));
};

export const progressWorkflow = (document: WorkflowStateDocument, parentNodeReferences: readonly ParentNodeReference[]): WorkflowProgressWorkflow => ({
  workflowId: document.workflowId,
  projectId: document.projectId,
  mainThreadId: document.mainThreadId,
  threadId: document.threadId,
  parentThreadId: document.parentThreadId,
  revision: document.revision,
  status: document.status,
  assessment: workflowAssessment(document),
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
  contributions: progressContributions(document),
});
