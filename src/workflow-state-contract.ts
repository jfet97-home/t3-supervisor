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

export type WorkflowStateEvidence = {
  id: string;
  operationId: string;
  kind: "draft_created" | "lineage_linked" | "agreement_imported" | "plan_updated" | "status_changed" | "node_removed" | "note" | "observation";
  recordedAt: number;
  actorSupervisorThreadId: string;
  targetNodeId: string | null;
  targetNodeName: string | null;
  statusFrom: WorkflowExecutionStatus | null;
  statusTo: WorkflowExecutionStatus | null;
  sourceThreadId: string | null;
  sourceRunId: string | null;
  sourceMessageId: string | null;
  agreementKey: string | null;
  note: string;
};

export type WorkflowStateEvidenceInput = {
  kind: "status_changed" | "note" | "observation";
  note: string;
  targetNodeId?: string | null;
  sourceThreadId?: string | null;
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
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
  reason: "revision" | "operation_id_reused" | "workflow_exists" | "child_already_linked" | "parent_missing" | "not_found";
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
