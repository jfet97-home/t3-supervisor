import type {
  WorkflowAgreementInfo,
  WorkflowIssueInfo,
  WorkflowPlanGroupInfo,
  WorkflowPlanNodeInfo,
  WorkflowRequirementInfo,
  WorkflowSourceBindingInfo,
} from "./project-supervisor-contract.js";

export const workflowExecutionStatuses = ["planned", "underway", "completed", "needs_attention"] as const;
export type WorkflowExecutionStatus = typeof workflowExecutionStatuses[number];

export type WorkflowStatePlan = WorkflowPlanGroupInfo | null;
export type WorkflowStatePlanNode = WorkflowPlanNodeInfo;
export type WorkflowStateRequirement = WorkflowRequirementInfo;
export type WorkflowStateIssue = WorkflowIssueInfo;

export type WorkflowStateSourceBinding = WorkflowSourceBindingInfo;

export const externalContributionStates = ["awaiting_result", "result", "withdrawn"] as const;
export type ExternalContributionState = typeof externalContributionStates[number];
export const externalContributionDecisions = ["accepted", "needs_more"] as const;
export type ExternalContributionDecision = typeof externalContributionDecisions[number];
export const externalContributionReferenceKinds = ["file", "url", "source", "text"] as const;
export type ExternalContributionReference = {kind: typeof externalContributionReferenceKinds[number]; value: string};

export const externalContributionLimits = {
  maxContributions: 32,
  maxRecordsPerMessage: 8,
  maxContributionIdLength: 64,
  maxNodeIdLength: 64,
  maxTaskIdLength: 200,
  maxRevision: 1_000_000,
  maxSummaryLength: 2000,
  maxReferences: 8,
  maxReferenceValueLength: 500,
  maxExternalRefLength: 200,
  maxAssessmentNoteLength: 2000,
} as const;

// fixed codes for the single task protocol diagnostic slot; a rejected record changes nothing
export const externalContributionDiagnosticCodes = [
  "contribution_json_invalid",
  "contribution_record_invalid",
  "contribution_message_limit",
  "contribution_duplicate_in_message",
  "contribution_node_unknown",
  "contribution_revision_conflict",
  "contribution_revision_gap",
  "contribution_revision_stale",
  "contribution_withdrawn",
  "contribution_capacity",
] as const;
export type ExternalContributionDiagnosticCode = typeof externalContributionDiagnosticCodes[number];

/** The Supervisor's current judgement of one result revision; it never changes a step status. */
export type ExternalContributionAssessment = {
  decision: ExternalContributionDecision;
  resultRevision: number;
  note: string;
  actorSupervisorThreadId: string;
  evidenceId: string;
  recordedAt: number;
};

/** A main-reported contribution whose execution happened outside observed T3 activity. Its text is untrusted. */
export type ExternalContribution = {
  contributionId: string;
  nodeId: string;
  state: ExternalContributionState;
  revision: number;
  summary: string;
  references: ExternalContributionReference[];
  externalRef: string | null;
  sourceThreadId: string;
  sourceRunId: string;
  sourceMessageId: string;
  recordedAt: number;
  assessment: ExternalContributionAssessment | null;
};

/** The exact fields of one main-authored external-contribution chat record. */
export type ExternalContributionRecord = {
  taskId: string;
  contributionId: string;
  nodeId: string;
  revision: number;
  state: ExternalContributionState;
  summary: string;
  references: ExternalContributionReference[];
  externalRef: string | null;
};

export type ExternalContributionImport = Omit<ExternalContributionRecord, "taskId"> & {
  sourceThreadId: string;
  sourceRunId: string;
  sourceMessageId: string;
};

export type ExternalContributionImportResult =
  | WorkflowMutationReceipt
  | {status: "unchanged"; workflowId: string; revision: number}
  | {status: "rejected"; code: ExternalContributionDiagnosticCode}
  | {status: "conflict"; reason: "revision"; currentRevision: number | null}
  | {status: "owner_mismatch" | "not_found"}
  | {status: "incompatible"; workflowId: string; formatVersion: number | null};

export type WorkflowContributionAssessmentInput = {
  operationId: string;
  workflowId: string;
  expectedRevision: number;
  contributionId: string;
  resultRevision: number;
  decision: ExternalContributionDecision;
  note: string;
};

export type WorkflowStateEvidence = {
  id: string;
  operationId: string;
  kind: "draft_created" | "lineage_linked" | "agreement_imported" | "plan_updated" | "status_changed" | "node_removed" | "note" | "observation" |
    "contribution_recorded" | "contribution_assessed";
  recordedAt: number;
  actorSupervisorThreadId: string;
  targetNodeId: string | null;
  targetNodeName: string | null;
  statusFrom: WorkflowExecutionStatus | null;
  statusTo: WorkflowExecutionStatus | null;
  sourceThreadId: string | null;
  sourceRunId: string | null;
  sourceMessageId: string | null;
  sourceItemId?: string | null;
  agreementKey: string | null;
  note: string;
  // present only on contribution evidence; the summary and references stay on the current contribution entry
  contribution?: {contributionId: string; revision: number; state: ExternalContributionState | null; decision: ExternalContributionDecision | null};
};

export type WorkflowStateEvidenceInput = {
  kind: "status_changed" | "note" | "observation";
  note: string;
  targetNodeId?: string | null;
  sourceThreadId?: string | null;
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
  sourceItemId?: string | null;
};

export type AcceptedWorkflowAgreementRecord = {
  key: string;
  taskId: string;
  sourceThreadId: string;
  sourceRunId: string;
  sourceMessageId: string;
  sourceHash: string;
  objective: string;
  planHash: string;
  sourceBinding: WorkflowStateSourceBinding;
  requirements: WorkflowStateRequirement[];
  issues: WorkflowStateIssue[];
  plan: WorkflowStatePlan;
  agreement: WorkflowAgreementInfo;
};

export type WorkflowStateDocument = {
  formatVersion: 2;
  workflowId: string;
  projectId: string;
  mainThreadId: string;
  threadId: string;
  parentWorkflowId: string | null;
  parentThreadId: string | null;
  revision: number;
  status: WorkflowExecutionStatus;
  objective: string | null;
  sourceBinding: WorkflowStateSourceBinding | null;
  requirements: WorkflowStateRequirement[];
  issues: WorkflowStateIssue[];
  plan: WorkflowStatePlan;
  currentAgreementKey: string | null;
  acceptedAgreements: AcceptedWorkflowAgreementRecord[];
  // main workflow only; a stored document without this field reads as empty
  contributions: ExternalContribution[];
  evidence: WorkflowStateEvidence[];
  createdAt: number;
  updatedAt: number;
};

export type WorkflowStateIncompatible = {
  status: "incompatible";
  workflowId: string;
  formatVersion: number | null;
};

export type WorkflowStateLookupResult =
  | {status: "found"; document: WorkflowStateDocument}
  | {status: "not_found"}
  | {status: "owner_mismatch"}
  | WorkflowStateIncompatible;

export type WorkflowOwner = {
  projectId: string;
  mainThreadId: string;
  supervisorThreadId: string;
  bindingGeneration: number;
};

export type WorkflowApplyInput = {
  operationId: string;
  workflowId: string;
  expectedRevision: number;
  status: WorkflowExecutionStatus;
  objective: string | null;
  sourceBinding: WorkflowStateSourceBinding | null;
  requirements: WorkflowStateRequirement[];
  issues: WorkflowStateIssue[];
  plan: WorkflowStatePlan;
  note: string;
  evidence?: WorkflowStateEvidenceInput[];
};

export type WorkflowControllerLineage = {
  threadId: string;
  parentThreadId: string;
  relationshipToParent: "subagent";
};

export type WorkflowAgreementImport = {
  taskId: string;
  sourceThreadId: string;
  sourceRunId: string;
  sourceMessageId: string;
  sourceHash: string;
  objective: string;
  agreement: WorkflowAgreementInfo;
};

export type WorkflowMutationReceipt = {
  formatVersion: 2;
  status: "applied" | "created";
  operationId: string;
  workflowId: string;
  revision: number;
  stateHash: string;
};

export type WorkflowMutationResult = WorkflowMutationReceipt | {
  status: "conflict";
  operationId: string;
  reason: "revision" | "operation_id_reused" | "workflow_exists" | "child_already_linked" | "parent_missing" | "not_found" | "contribution_result_stale";
  currentRevision: number | null;
} | {
  status: "owner_mismatch";
  operationId: string;
} | {
  status: "invalid";
  operationId: string;
  reason: string;
} | {
  status: "not_found";
  operationId: string;
} | {
  status: "incompatible";
  operationId: string;
  workflowId: string;
  formatVersion: number | null;
};

export type WorkflowEnsureResult = WorkflowMutationResult | {
  formatVersion: 2;
  status: "exists";
  operationId: string;
  workflowId: string;
  revision: number;
  stateHash: string;
} | {
  status: "incompatible";
  operationId: string;
  workflowId: string;
  formatVersion: number | null;
};

export type WorkflowMutationLimits = {
  maxPlanNodes: number;
  maxPlanDepth: number;
  maxContributorsPerNode: number;
  maxEvidence: number;
  maxAcceptedAgreements: number;
  maxEvidencePerApply: number;
  maxTextLength: number;
  maxPlanTextLength: number;
  maxPlanReasonLength: number;
  maxOperationIdLength: number;
  maxDocumentBytes: number;
};

export const workflowMutationLimits: WorkflowMutationLimits = {
  maxPlanNodes: 500,
  maxPlanDepth: 32,
  maxContributorsPerNode: 50,
  maxEvidence: 500,
  maxAcceptedAgreements: 100,
  maxEvidencePerApply: 50,
  maxTextLength: 2000,
  maxPlanTextLength: 8000,
  maxPlanReasonLength: 1000,
  maxOperationIdLength: 200,
  maxDocumentBytes: 524_288, // serialized JSON UTF-8 byte limit
};
