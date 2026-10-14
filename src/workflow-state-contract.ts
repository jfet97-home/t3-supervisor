import type { WorkflowAgreementInfo, WorkflowProposalInfo } from "./project-supervisor-contract.js";

export const workflowExecutionStatuses = ["planned", "underway", "completed", "needs_attention"] as const;
export type WorkflowExecutionStatus = typeof workflowExecutionStatuses[number];

export type WorkflowStateRule = WorkflowProposalInfo["rules"][number];

export type WorkflowStateStep = {
  id: string;
  blockId: string | null;
  name: string;
  reason: string;
  status: WorkflowExecutionStatus;
  contributorThreadIds: string[];
};

export type WorkflowStateStepInput = Omit<WorkflowStateStep, "id"> & {id?: string};

export type WorkflowStateEvidence = {
  id: string;
  operationId: string;
  kind: "draft_created" | "lineage_linked" | "agreement_imported" | "plan_updated" | "status_changed" | "step_removed" | "note" | "observation";
  recordedAt: number;
  actorSupervisorThreadId: string;
  targetStepId: string | null;
  targetStepName: string | null;
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
  targetStepId?: string | null;
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
  agreement: WorkflowAgreementInfo;
};

export type WorkflowStateDocument = {
  workflowId: string;
  projectId: string;
  mainThreadId: string;
  threadId: string;
  parentWorkflowId: string | null;
  parentThreadId: string | null;
  revision: number;
  status: WorkflowExecutionStatus;
  objective: string | null;
  rules: WorkflowStateRule[];
  steps: WorkflowStateStep[];
  currentAgreementKey: string | null;
  acceptedAgreements: AcceptedWorkflowAgreementRecord[];
  evidence: WorkflowStateEvidence[];
  createdAt: number;
  updatedAt: number;
};

export type WorkflowStateLookupResult =
  | {status: "found"; document: WorkflowStateDocument}
  | {status: "not_found"}
  | {status: "owner_mismatch"};

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
  rules: WorkflowStateRule[];
  steps: WorkflowStateStepInput[];
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
};

export type WorkflowEnsureResult = WorkflowMutationResult | {
  status: "exists";
  operationId: string;
  workflowId: string;
  revision: number;
  stateHash: string;
};

export type WorkflowMutationLimits = {
  maxRules: number;
  maxSteps: number;
  maxContributorsPerStep: number;
  maxEvidence: number;
  maxAcceptedAgreements: number;
  maxEvidencePerApply: number;
  maxTextLength: number;
  maxOperationIdLength: number;
  maxDocumentBytes: number;
};

export const workflowMutationLimits: WorkflowMutationLimits = {
  maxRules: 100,
  maxSteps: 200,
  maxContributorsPerStep: 50,
  maxEvidence: 500,
  maxAcceptedAgreements: 100,
  maxEvidencePerApply: 50,
  maxTextLength: 2000,
  maxOperationIdLength: 200,
  maxDocumentBytes: 524_288, // serialized JSON UTF-8 byte limit
};
