import {definitionReferenceFields, validDefinitionReferences} from "./definition-references.js";
import {Buffer} from "node:buffer";
import {Clock, Context, Data, Effect, Exit, Layer, Schema} from "effect";
import type {SqlError} from "effect/sql";
import {GuidanceDb, untracedSql} from "./db.js";
import {type GuidanceStoreError, mapSqlError, rowFindings, rowKey, rowsOf, schemaChanges, snapshotRead, type StoredRowScan, type SupervisionStoreError} from "./guidance-sql.js";
import {fingerprint} from "./guidance-store.js";
import {SupervisorIds} from "./ids.js";
import {ProjectSupervisorStore, type ProjectSupervisorStoreError} from "./project-supervisor-store.js";
import {validateWorkflowApplyAgainstPinnedContext} from "./supervisor-workflow.js";
import {
  externalContributionDecisions,
  externalContributionLimits,
  externalContributionReferenceKinds,
  externalContributionStates,
  workflowExecutionStatuses,
  workflowMutationLimits,
  WorkflowMutationReceiptSchema,
  WorkflowStateDocumentSchema,
  type AcceptedWorkflowAgreementRecord,
  type ExternalContribution,
  type ExternalContributionDiagnosticCode,
  type ExternalContributionImport,
  type ExternalContributionImportResult,
  type ExternalContributionRecord,
  type WorkflowContributionAssessmentInput,
  type WorkflowAgreementImport,
  type WorkflowApplyInput,
  type WorkflowControllerLineage,
  type WorkflowEnsureResult,
  type WorkflowExecutionStatus,
  type WorkflowMutationReceipt,
  type WorkflowMutationResult,
  type WorkflowOwner,
  type WorkflowStateDocument,
  type WorkflowStateEvidence,
  type WorkflowStateEvidenceInput,
  type WorkflowStateIssue,
  type WorkflowStateLookupResult,
  type WorkflowStatePlan,
  type WorkflowStateRequirement,
  type WorkflowStateSourceBinding,
} from "./workflow-state-contract.js";
import type {WorkflowAgreementInfo, WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo, WorkflowSourceBindingInfo} from "./project-supervisor-contract.js";
import type {ProposalContext, WorkflowApplyDiagnostic} from "./supervisor-workflow.js";

export type WorkflowApplyValidationContext = {
  pinnedContext: ProposalContext;
  originalProposal: WorkflowProposalInfo;
  expectedTaskId: string;
  expectedProposalId: string;
  expectedSourceHash: string;
  acceptedTaskAgreement: WorkflowAgreementInfo | null;
  acceptedTaskAgreementSourceHash: string | null;
};

export const acceptedWorkflowPlansForBinding = (document: WorkflowStateDocument, binding: WorkflowStateSourceBinding): WorkflowPlanGroupInfo[] => {
  if (binding.definitionsStatus !== "ready" || !binding.definitionsComplete || !binding.requirementsKnown) return [];
  return document.acceptedAgreements.flatMap(record => {
    const acceptedBinding = record.sourceBinding;
    if (record.sourceThreadId !== document.threadId || record.taskId !== binding.taskId || record.sourceHash !== binding.sourceHash ||
      acceptedBinding.taskId !== binding.taskId || acceptedBinding.sourceHash !== binding.sourceHash ||
      acceptedBinding.workspaceRoot !== binding.workspaceRoot || acceptedBinding.revision !== binding.revision ||
      acceptedBinding.globalRevision !== binding.globalRevision || acceptedBinding.definitionsStatus !== "ready" ||
      !acceptedBinding.definitionsComplete || !acceptedBinding.requirementsKnown || !record.plan) return [];
    return [record.plan];
  });
};

export const acceptedTaskPlanForBinding = (agreement: WorkflowAgreementInfo | null | undefined, agreementSourceHash: string | null | undefined,
  expectedSourceHash: string, binding: WorkflowStateSourceBinding): WorkflowPlanGroupInfo | null => {
  const workflow = agreement?.workflow;
  if (!agreement || !["agreed", "stale"].includes(agreement.status) || agreementSourceHash !== expectedSourceHash ||
    !workflow || !["proposed", "stale"].includes(workflow.status) || workflow.definitionsStatus !== "ready" ||
    !workflow.definitionsComplete || !workflow.requirementsKnown || !workflow.plan || workflow.workspaceRoot !== binding.workspaceRoot ||
    workflow.revision !== binding.revision || (workflow.globalRevision ?? null) !== binding.globalRevision) return null;
  return workflow.plan;
};

type WorkflowOperationNamespace = "edit" | "agreement";
type WorkflowRow = {
  workflow_id: string;
  project_id: string;
  main_thread_id: string;
  thread_id: string;
  parent_workflow_id: string | null;
  parent_thread_id: string | null;
  revision: number;
  document: string;
};
type PlanEntity = Exclude<WorkflowPlanNodeInfo, WorkflowPlanGroupInfo>;
type WorkflowApplyResult = Exclude<WorkflowMutationResult, {status: "invalid"}> | {
  status: "invalid";
  operationId: string;
  reason: string;
  diagnostic?: WorkflowApplyDiagnostic;
};
type WorkflowStateDecode = {status: "found"; document: WorkflowStateDocument} | WorkflowStateLookupResult & {status: "incompatible"};
type PlanBudget = {nodes: number; nodeIds: Set<string>};

export type WorkflowNeedsAttentionScan =
  | {status: "complete"; needsAttention: boolean; inspected: number}
  | {status: "incomplete"; needsAttention: boolean; inspected: number; reason: "invalid_scope" | "limit_exceeded" | "unreadable_workflow"};

const statuses = new Set<string>(workflowExecutionStatuses);
const maxNeedsAttentionScan = 512;
const needsAttentionThreadChunkSize = 400;
const definitionStatuses = new Set(["ready", "missing", "invalid", "permission_required", "unavailable"]);
const requirementStates = new Set(["included", "not_applicable", "unresolved", "unknown"]);
const opaqueId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isPlanGroup = (value: WorkflowPlanNodeInfo): value is WorkflowPlanGroupInfo => value.kind === "sequence" || value.kind === "parallel";
const isStatus = (value: unknown): value is WorkflowExecutionStatus => typeof value === "string" && statuses.has(value);
const validText = (value: unknown, allowEmpty = false): value is string =>
  typeof value === "string" && value.length <= workflowMutationLimits.maxTextLength && (allowEmpty || value.trim().length > 0);
const validPlanText = (value: unknown, allowEmpty = false): value is string =>
  typeof value === "string" && value.length <= workflowMutationLimits.maxPlanTextLength && (allowEmpty || value.trim().length > 0);
const validPlanReason = (value: unknown, allowEmpty = false): value is string =>
  typeof value === "string" && value.length <= workflowMutationLimits.maxPlanReasonLength && (allowEmpty || value.trim().length > 0);
const validId = (value: unknown, limit = workflowMutationLimits.maxOperationIdLength): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;
const validNodeId = (value: unknown): value is string => typeof value === "string" && opaqueId.test(value);
const json = (value: unknown): string => JSON.stringify(value);
const documentFits = (serialized: string): boolean => Buffer.byteLength(serialized, "utf8") <= workflowMutationLimits.maxDocumentBytes;
const canonicalRequestValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalRequestValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalRequestValue(value[key])]));
};
const requestFingerprint = (value: unknown): string => fingerprint(canonicalRequestValue(value));
const acceptedKey = (taskId: string, proposalId: string): string => "agreement:" + fingerprint([taskId, proposalId]);

const validWorkflowSource = (value: unknown): boolean => value === null || isRecord(value) &&
  (value.origin === null || value.origin === "global" || value.origin === "project") &&
  (value.path === null || validText(value.path)) && (value.sourceId === null || validId(value.sourceId));

const validSourceBinding = (value: unknown): value is WorkflowStateSourceBinding => value === null || isRecord(value) &&
  validText(value.workspaceRoot) &&
  (value.revision === null || validText(value.revision)) &&
  (value.globalRevision === null || validText(value.globalRevision)) &&
  typeof value.definitionsStatus === "string" && definitionStatuses.has(value.definitionsStatus) &&
  typeof value.definitionsComplete === "boolean" && typeof value.requirementsKnown === "boolean" &&
  validId(value.taskId) && validId(value.proposalId) && validText(value.sourceHash);

const validRequirements = (value: unknown): value is WorkflowStateRequirement[] => Array.isArray(value) &&
  value.length <= workflowMutationLimits.maxPlanNodes && value.every(item => isRecord(item) &&
    (item.kind === "step" || item.kind === "workflow") && validId(item.id) && validPlanText(item.name) &&
    validWorkflowSource(item.source) && typeof item.state === "string" && requirementStates.has(item.state) && validPlanReason(item.reason, true));

const validIssues = (value: unknown): value is WorkflowStateIssue[] => Array.isArray(value) &&
  value.length <= workflowMutationLimits.maxPlanNodes && value.every(item => isRecord(item) &&
    validPlanText(item.path, true) && validId(item.code) && validPlanText(item.message, true));

const validContributorIds = (value: unknown): value is readonly string[] => Array.isArray(value) &&
  value.length <= workflowMutationLimits.maxContributorsPerNode && value.every(id => validId(id)) && new Set(value).size === value.length;

const validOmissions = (value: unknown): boolean => Array.isArray(value) && value.length <= workflowMutationLimits.maxPlanNodes &&
  value.every(item => isRecord(item) && validPlanText(item.templatePath) && (item.kind === "step" || item.kind === "workflow") &&
    validId(item.id) && validPlanText(item.name) && validWorkflowSource(item.source) && validPlanReason(item.reason));

const newNodeMustStartPlannedExpected = "insert with status \"planned\" in this apply, then change status in a separate apply with status_changed evidence.";
const missingStatusChangedEvidenceExpected = "include status_changed evidence for this status change in the same apply.";

const contributionIdPattern = /^[A-Za-z0-9._:-]{1,64}$/u;
const contributionStates = new Set<string>(externalContributionStates);
const contributionDecisions = new Set<string>(externalContributionDecisions);
const contributionReferenceKinds = new Set<string>(externalContributionReferenceKinds);
const contributionRecordKeys = ["taskId", "contributionId", "nodeId", "revision", "state", "summary", "references", "externalRef"] as const;
const exactRecordKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validContributionId = (value: unknown): value is string => typeof value === "string" && contributionIdPattern.test(value);
const validContributionRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= externalContributionLimits.maxRevision;
const validContributionReferences = (value: unknown): value is ExternalContributionRecord["references"] => Array.isArray(value) &&
  value.length <= externalContributionLimits.maxReferences && value.every(item => isRecord(item) && exactRecordKeys(item, ["kind", "value"]) &&
    typeof item.kind === "string" && contributionReferenceKinds.has(item.kind) && typeof item.value === "string" &&
    item.value.length > 0 && item.value.length <= externalContributionLimits.maxReferenceValueLength);
const validContributionContent = (value: Record<string, unknown>): boolean =>
  validContributionId(value.contributionId) && typeof value.nodeId === "string" && value.nodeId.length > 0 &&
  value.nodeId.length <= externalContributionLimits.maxNodeIdLength && validContributionRevision(value.revision) &&
  typeof value.state === "string" && contributionStates.has(value.state) &&
  typeof value.summary === "string" && value.summary.length <= externalContributionLimits.maxSummaryLength &&
  validContributionReferences(value.references) && (value.externalRef === null || typeof value.externalRef === "string" &&
    value.externalRef.length > 0 && value.externalRef.length <= externalContributionLimits.maxExternalRefLength);

/** Parses one external-contribution chat record exactly: every field present, no extras, bounded text. */
export const parseExternalContributionRecord = (value: unknown): ExternalContributionRecord | null =>
  isRecord(value) && exactRecordKeys(value, contributionRecordKeys) && typeof value.taskId === "string" && value.taskId.length > 0 &&
  value.taskId.length <= externalContributionLimits.maxTaskIdLength && validContributionContent(value)
    ? {taskId: value.taskId as string, contributionId: value.contributionId as string, nodeId: value.nodeId as string,
      revision: value.revision as number, state: value.state as ExternalContributionRecord["state"], summary: value.summary as string,
      references: (value.references as ExternalContributionRecord["references"]).map(item => ({kind: item.kind, value: item.value})),
      externalRef: value.externalRef as string | null}
    : null;

const contributionContentKey = (value: Pick<ExternalContribution, "nodeId" | "state" | "summary" | "references" | "externalRef">): string =>
  JSON.stringify([value.nodeId, value.state, value.summary, value.references.map(item => [item.kind, item.value]), value.externalRef]);

const validContributionAssessment = (value: unknown): boolean => value === null || isRecord(value) &&
  typeof value.decision === "string" && contributionDecisions.has(value.decision) && validContributionRevision(value.resultRevision) &&
  typeof value.note === "string" && value.note.trim().length > 0 && value.note.length <= externalContributionLimits.maxAssessmentNoteLength &&
  validId(value.actorSupervisorThreadId) && validId(value.evidenceId) && Number.isFinite(value.recordedAt);

const validContributions = (value: unknown): value is ExternalContribution[] => Array.isArray(value) &&
  value.length <= externalContributionLimits.maxContributions && new Set(value.map(item => isRecord(item) ? item.contributionId : null)).size === value.length &&
  value.every(item => isRecord(item) && validContributionContent(item) && validId(item.sourceThreadId) && validId(item.sourceRunId) &&
    validId(item.sourceMessageId) && Number.isFinite(item.recordedAt) && validContributionAssessment(item.assessment));

const validEvidenceContribution = (value: unknown): boolean => value === undefined || isRecord(value) &&
  validContributionId(value.contributionId) && validContributionRevision(value.revision) &&
  (value.state === null || typeof value.state === "string" && contributionStates.has(value.state)) &&
  (value.decision === null || typeof value.decision === "string" && contributionDecisions.has(value.decision));

const validContributionImport = (value: unknown): value is ExternalContributionImport => isRecord(value) &&
  exactRecordKeys(value, ["contributionId", "nodeId", "revision", "state", "summary", "references", "externalRef", "sourceThreadId", "sourceRunId", "sourceMessageId"]) &&
  validContributionContent(value) && validId(value.sourceThreadId) && validId(value.sourceRunId) && validId(value.sourceMessageId);

const validContributionAssessmentInput = (value: unknown): value is WorkflowContributionAssessmentInput => isRecord(value) &&
  validId(value.operationId) && validId(value.workflowId) && Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 1 &&
  validContributionId(value.contributionId) && validContributionRevision(value.resultRevision) &&
  typeof value.decision === "string" && contributionDecisions.has(value.decision) &&
  typeof value.note === "string" && value.note.trim().length > 0 && value.note.length <= externalContributionLimits.maxAssessmentNoteLength;

// points into the canonical plan; workflow_write maps it onto the submitted arguments
const planStatusPointer = (plan: WorkflowStatePlan, target: PlanEntity): string | null => {
  const visit = (group: WorkflowPlanGroupInfo | null, path: string): string | null => {
    if (!group) return null;
    for (const [index, node] of group.nodes.entries()) {
      const nodePath = `${path}/nodes/${index}`;
      if (isPlanGroup(node)) {
        const found = visit(node, nodePath);
        if (found) return found;
        continue;
      }
      if (node === target) return `${nodePath}/status`;
      if (node.kind === "workflow") {
        const found = visit(node.plan, `${nodePath}/plan`);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(plan, "/plan");
};

const collectPlanEntities = (plan: WorkflowStatePlan): PlanEntity[] => {
  const entities: PlanEntity[] = [];
  const walk = (group: WorkflowPlanGroupInfo | null): void => {
    if (!group) return;
    for (const node of group.nodes) {
      if (isPlanGroup(node)) walk(node);
      else if (node.kind === "step" || node.kind === "workflow") {
        entities.push(node);
        if (node.kind === "workflow") walk(node.plan);
      }
    }
  };
  walk(plan);
  return entities;
};

const collectSubmittedNodeIds = (value: unknown): Set<string> => {
  const result = new Set<string>();
  const walkGroup = (group: unknown): void => {
    if (!isRecord(group) || !Array.isArray(group.nodes)) return;
    for (const node of group.nodes) {
      if (!isRecord(node)) continue;
      if (validNodeId(node.nodeId)) result.add(node.nodeId);
      if (node.kind === "sequence" || node.kind === "parallel") walkGroup(node);
      else if (node.kind === "workflow" && node.plan !== null) walkGroup(node.plan);
    }
  };
  walkGroup(value);
  return result;
};

const identityKey = (node: PlanEntity): string => JSON.stringify({kind: node.kind, templatePath: node.templatePath,
  definitionId: node.definitionId, local: node.templatePath === null && node.kind === "step" ? "root-local" : null});

const validPlan = (value: unknown): value is WorkflowStatePlan => {
  if (value === null) return true;
  const budget: PlanBudget = {nodes: 0, nodeIds: new Set()};
  const visit = (group: unknown, depth: number): boolean => {
    if (!isRecord(group) || (group.kind !== "sequence" && group.kind !== "parallel") ||
      !validPlanText(group.templatePath, true) && group.templatePath !== null || !Array.isArray(group.nodes) || group.nodes.length === 0 ||
      depth > workflowMutationLimits.maxPlanDepth) return false;
    budget.nodes++;
    if (budget.nodes > workflowMutationLimits.maxPlanNodes) return false;
    for (const node of group.nodes) {
      if (!isRecord(node)) return false;
      if (node.kind === "sequence" || node.kind === "parallel") {
        if (!visit(node, depth + 1)) return false;
        continue;
      }
      budget.nodes++;
      if (budget.nodes > workflowMutationLimits.maxPlanNodes || !validNodeId(node.nodeId) || budget.nodeIds.has(node.nodeId) ||
        !validPlanText(node.templatePath, true) && node.templatePath !== null || !validPlanText(node.name) || !validPlanText(node.description, true) ||
        Object.hasOwn(node, "references") && !validDefinitionReferences(node.references) ||
        !validWorkflowSource(node.source) || !isStatus(node.status) || !validContributorIds(node.contributorThreadIds)) return false;
      budget.nodeIds.add(node.nodeId);
      if (node.kind === "step") {
        if (!(node.definitionId === null || validId(node.definitionId)) || !(node.localId === null || validId(node.localId)) ||
          (node.resolution !== "resolved" && node.resolution !== "unresolved") || !validPlanReason(node.reason, true)) return false;
      } else if (node.kind === "workflow") {
        if (!validId(node.definitionId) || !(node.fixed === null || typeof node.fixed === "boolean") ||
          !["resolved", "partial", "unresolved"].includes(String(node.resolution)) || !validPlanReason(node.reason, true) ||
          !validOmissions(node.omissions) || !(node.plan === null || visit(node.plan, depth + 1))) return false;
      } else return false;
    }
    return true;
  };
  return value === null || visit(value, 0);
};

const validApplyPlan = (value: unknown): boolean => {
  const budget: PlanBudget = {nodes: 0, nodeIds: new Set()};
  const optionalText = (record: Record<string, unknown>, key: string): boolean => !Object.hasOwn(record, key) || validPlanText(record[key], true);
  const optionalStatus = (record: Record<string, unknown>): boolean => !Object.hasOwn(record, "status") || isStatus(record.status);
  const optionalContributors = (record: Record<string, unknown>): boolean =>
    !Object.hasOwn(record, "contributorThreadIds") || validContributorIds(record.contributorThreadIds);
  const visit = (group: unknown, depth: number): boolean => {
    if (!isRecord(group) || (group.kind !== "sequence" && group.kind !== "parallel") ||
      !(group.templatePath === undefined || group.templatePath === null || validPlanText(group.templatePath, true)) ||
      !Array.isArray(group.nodes) || group.nodes.length === 0 || depth > workflowMutationLimits.maxPlanDepth) return false;
    budget.nodes++;
    if (budget.nodes > workflowMutationLimits.maxPlanNodes) return false;
    for (const node of group.nodes) {
      if (!isRecord(node)) return false;
      if (node.kind === "sequence" || node.kind === "parallel") {
        if (!visit(node, depth + 1)) return false;
        continue;
      }
      budget.nodes++;
      if (budget.nodes > workflowMutationLimits.maxPlanNodes ||
        !(node.nodeId === undefined || validNodeId(node.nodeId) && !budget.nodeIds.has(node.nodeId)) ||
        !(node.templatePath === undefined || node.templatePath === null || validPlanText(node.templatePath, true)) ||
        !optionalText(node, "name") || !optionalText(node, "description") ||
        Object.hasOwn(node, "references") && !validDefinitionReferences(node.references) ||
        !optionalStatus(node) || !optionalContributors(node) ||
        Object.hasOwn(node, "source") && !validWorkflowSource(node.source)) return false;
      if (validNodeId(node.nodeId)) budget.nodeIds.add(node.nodeId);
      if (node.kind === "step") {
        if (!validPlanReason(node.reason) ||
          Object.hasOwn(node, "definitionId") && !(node.definitionId === null || validId(node.definitionId)) ||
          Object.hasOwn(node, "localId") && !(node.localId === null || validId(node.localId)) ||
          Object.hasOwn(node, "resolution") && node.resolution !== "resolved" && node.resolution !== "unresolved" ||
          node.definitionId === null && (!validId(node.localId) || !validPlanText(node.name) || !validPlanText(node.description, true))) return false;
      } else if (node.kind === "workflow") {
        if (!validId(node.definitionId) || !validPlanReason(node.reason) ||
          Object.hasOwn(node, "fixed") && !(node.fixed === null || typeof node.fixed === "boolean") ||
          Object.hasOwn(node, "resolution") && !["resolved", "partial", "unresolved"].includes(String(node.resolution)) ||
          Object.hasOwn(node, "omissions") && !validOmissions(node.omissions) ||
          Object.hasOwn(node, "plan") && !(node.plan === null || visit(node.plan, depth + 1))) return false;
      } else return false;
    }
    return true;
  };
  return value === null || visit(value, 0);
};

const validEvidenceInput = (evidence: unknown): evidence is readonly WorkflowStateEvidenceInput[] =>
  evidence === undefined || Array.isArray(evidence) && evidence.length <= workflowMutationLimits.maxEvidencePerApply && evidence.every(item => item !== null &&
    typeof item === "object" && ["status_changed", "note", "observation"].includes((item as Record<string, unknown>).kind as string) &&
    validText((item as Record<string, unknown>).note) &&
    ((item as Record<string, unknown>).targetNodeId === undefined || (item as Record<string, unknown>).targetNodeId === null || validNodeId((item as Record<string, unknown>).targetNodeId)) &&
    ((item as Record<string, unknown>).sourceThreadId === undefined || (item as Record<string, unknown>).sourceThreadId === null || validId((item as Record<string, unknown>).sourceThreadId)) &&
    ((item as Record<string, unknown>).sourceRunId === undefined || (item as Record<string, unknown>).sourceRunId === null || validId((item as Record<string, unknown>).sourceRunId)) &&
    ((item as Record<string, unknown>).sourceMessageId === undefined || (item as Record<string, unknown>).sourceMessageId === null || validId((item as Record<string, unknown>).sourceMessageId)) &&
    ((item as Record<string, unknown>).sourceItemId === undefined || (item as Record<string, unknown>).sourceItemId === null || validId((item as Record<string, unknown>).sourceItemId)));

export const workflowPlanEntities = collectPlanEntities;

const copyPlanNode = (node: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
  if (isPlanGroup(node)) return {...node, nodes: node.nodes.map(copyPlanNode)};
  if (node.kind === "step") return {...node, ...definitionReferenceFields(node.references), source: node.source ? {...node.source} : null, contributorThreadIds: [...node.contributorThreadIds]};
  return {...node, ...definitionReferenceFields(node.references), source: node.source ? {...node.source} : null, contributorThreadIds: [...node.contributorThreadIds],
    omissions: node.omissions.map(item => ({...item, source: item.source ? {...item.source} : null})),
    plan: node.plan ? copyPlanNode(node.plan) as WorkflowPlanGroupInfo : null};
};

const copyPlan = (plan: WorkflowStatePlan): WorkflowStatePlan => plan ? copyPlanNode(plan) as WorkflowPlanGroupInfo : null;
const copyRequirements = (items: readonly WorkflowStateRequirement[]): WorkflowStateRequirement[] => items.map(item => ({...item, source: item.source ? {...item.source} : null}));
const copyIssues = (items: readonly WorkflowStateIssue[]): WorkflowStateIssue[] => items.map(item => ({...item}));
const copyBinding = (value: WorkflowStateSourceBinding | null): WorkflowStateSourceBinding | null => value ? {...value} : null;

const staticPlan = (plan: WorkflowStatePlan): unknown => {
  if (!plan) return null;
  return {kind: plan.kind, templatePath: plan.templatePath, nodes: plan.nodes.map(node => {
    if (isPlanGroup(node)) return staticPlan(node);
    if (node.kind === "step") {
      const content = {...node} as Record<string, unknown>;
      delete content.status;
      delete content.contributorThreadIds;
      return content;
    }
    const content = {...node} as Record<string, unknown>;
    delete content.status;
    delete content.contributorThreadIds;
    return {...content, plan: staticPlan(node.plan)};
  })};
};

const workflowPlanSignature = (objective: string | null, sourceBinding: WorkflowStateSourceBinding | null,
  requirements: readonly WorkflowStateRequirement[], issues: readonly WorkflowStateIssue[], plan: WorkflowStatePlan): string =>
  fingerprint({objective, sourceBinding, requirements, issues, plan: staticPlan(plan)});

const sourceBindingOf = (workflow: WorkflowAgreementInfo["workflow"], taskId: string, proposalId: string, sourceHash: string): WorkflowStateSourceBinding => ({
  workspaceRoot: workflow.workspaceRoot ?? "",
  revision: workflow.revision,
  globalRevision: workflow.globalRevision,
  definitionsStatus: workflow.definitionsStatus,
  definitionsComplete: workflow.definitionsComplete,
  requirementsKnown: workflow.requirementsKnown,
  taskId,
  proposalId,
  sourceHash,
});

/**
 * Decides one contribution revision against the current main document: revisions start at 1 and grow by exactly one,
 * an identical replay is a no-op, and withdrawn is terminal.
 */
export const contributionImportDecision = (document: WorkflowStateDocument, input: Omit<ExternalContributionImport, "sourceThreadId" | "sourceRunId" | "sourceMessageId">):
  | {kind: "unchanged"}
  | {kind: "rejected"; code: ExternalContributionDiagnosticCode}
  | {kind: "record"; existing: ExternalContribution | null; node: PlanEntity | null} => {
  const existing = document.contributions.find(item => item.contributionId === input.contributionId) ?? null;
  if (existing && existing.revision === input.revision && contributionContentKey(existing) === contributionContentKey(input)) return {kind: "unchanged"};
  const reject = (code: ExternalContributionDiagnosticCode) => ({kind: "rejected" as const, code});
  if (existing?.state === "withdrawn") return reject("contribution_withdrawn");
  if (existing && input.revision === existing.revision) return reject("contribution_revision_conflict");
  if (existing && input.revision < existing.revision) return reject("contribution_revision_stale");
  if (input.revision !== (existing?.revision ?? 0) + 1) return reject("contribution_revision_gap");
  if (!existing && input.state === "withdrawn") return reject("contribution_record_invalid");
  const node = collectPlanEntities(document.plan).find(item => item.nodeId === input.nodeId) ?? null;
  // a withdrawal may still name a node the plan has since removed
  if (!node && !(input.state === "withdrawn" && existing?.nodeId === input.nodeId)) return reject("contribution_node_unknown");
  if (!existing && document.contributions.length >= externalContributionLimits.maxContributions) return reject("contribution_capacity");
  if (document.evidence.length >= workflowMutationLimits.maxEvidence) return reject("contribution_capacity");
  return {kind: "record", existing, node};
};


const validApplyInput = (value: unknown): boolean => isRecord(value) &&
  validId(value.operationId) && validId(value.workflowId) && Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 1 &&
  validText(value.note) && isStatus(value.status) && (value.objective === null || validText(value.objective)) &&
  validSourceBinding(value.sourceBinding) && validRequirements(value.requirements) && validIssues(value.issues) && validApplyPlan(value.plan) && validEvidenceInput(value.evidence);

const validDocument = (value: Record<string, unknown>): boolean => value.formatVersion === 2 && validId(value.workflowId) &&
  validId(value.projectId) && validId(value.mainThreadId) && validId(value.threadId) &&
  (value.parentWorkflowId === null || validId(value.parentWorkflowId)) && (value.parentThreadId === null || validId(value.parentThreadId)) &&
  Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && isStatus(value.status) &&
  (value.objective === null || validText(value.objective)) && validSourceBinding(value.sourceBinding) &&
  validRequirements(value.requirements) && validIssues(value.issues) && validPlan(value.plan) &&
  (value.currentAgreementKey === null || validText(value.currentAgreementKey)) && Array.isArray(value.acceptedAgreements) &&
  value.acceptedAgreements.length <= workflowMutationLimits.maxAcceptedAgreements && value.acceptedAgreements.every(item => isRecord(item) &&
    validText(item.key) && validId(item.taskId) && validId(item.sourceThreadId) && validId(item.sourceRunId) && validId(item.sourceMessageId) &&
    validText(item.sourceHash) && validText(item.objective) && validText(item.planHash) && isRecord(item.sourceBinding) && validSourceBinding(item.sourceBinding) &&
    validRequirements(item.requirements) && validIssues(item.issues) && validPlan(item.plan) && item.plan !== null &&
    isRecord(item.agreement) && item.agreement.status === "agreed" && validId(item.agreement.proposalId) &&
    isRecord(item.agreement.workflow) && validPlan(item.agreement.workflow.plan)) &&
  (value.contributions === undefined || validContributions(value.contributions)) &&
  Array.isArray(value.evidence) && value.evidence.length <= workflowMutationLimits.maxEvidence && value.evidence.every(item => isRecord(item) &&
    validId(item.id) && validId(item.operationId) && ["draft_created", "lineage_linked", "agreement_imported", "plan_updated", "status_changed", "node_removed", "note", "observation",
      "contribution_recorded", "contribution_assessed"].includes(String(item.kind)) && validEvidenceContribution(item.contribution) &&
    Number.isFinite(item.recordedAt) && validId(item.actorSupervisorThreadId) && (item.targetNodeId === null || validNodeId(item.targetNodeId)) &&
    (item.targetNodeName === null || validPlanText(item.targetNodeName)) && (item.statusFrom === null || isStatus(item.statusFrom)) &&
    (item.statusTo === null || isStatus(item.statusTo)) && (item.sourceThreadId === null || validId(item.sourceThreadId)) &&
    (item.sourceRunId === null || validId(item.sourceRunId)) && (item.sourceMessageId === null || validId(item.sourceMessageId)) &&
    (item.sourceItemId === undefined || item.sourceItemId === null || validId(item.sourceItemId)) &&
    (item.agreementKey === null || validText(item.agreementKey)) && validText(item.note)) &&
  Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt);

export type WorkflowStateStoreReason = "workflow_revision_conflict" | "workflow_store_unavailable" | "workflow_row_invalid";

// a database failure carries no query, value or driver text; a stored row whose columns are unreadable names its kind (an
// unreadable document is classified incompatible instead, as at baseline)
export class WorkflowStateStoreError extends Data.TaggedError("WorkflowStateStoreError")<{
  readonly reason: WorkflowStateStoreReason;
  readonly row?: "workflow" | "operation" | undefined;
}> {
  override readonly message: string = this.reason;
}

/** Whether workflow editing is enabled for a scope; it runs inside the store's transaction, so it forks nothing and calls nothing natively. */
export type WorkflowEditingEnabled = (projectId: string, mainThreadId?: string) => Effect.Effect<boolean, SupervisionStoreError>;
type WorkflowScope = Pick<WorkflowOwner, "projectId" | "mainThreadId">;
type WorkflowFailure = SupervisionStoreError | SqlError.SqlError;
type WorkflowEffect<A> = Effect.Effect<A, SupervisionStoreError>;

/** The workflow state store; each method joins the caller's transaction when it runs inside one. */
export interface WorkflowStateStoreShape {
  readonly get: (projectId: string, mainThreadId: string, threadId?: string) => WorkflowEffect<WorkflowStateDocument | null>;
  readonly getState: (projectId: string, mainThreadId: string, threadId?: string) => WorkflowEffect<WorkflowStateLookupResult>;
  readonly getByIdForOwner: (owner: WorkflowOwner, workflowId: string) => WorkflowEffect<WorkflowStateLookupResult>;
  readonly listResult: (projectId: string, mainThreadId: string) => WorkflowEffect<{documents: WorkflowStateDocument[]; incompatible: Array<{workflowId: string; formatVersion: number | null}>}>;
  readonly list: (projectId: string, mainThreadId: string) => WorkflowEffect<WorkflowStateDocument[]>;
  readonly hasNeedsAttention: (projectId: string, mainThreadId: string, threadIds: readonly string[], limit?: number) => WorkflowEffect<WorkflowNeedsAttentionScan>;
  readonly apply: (owner: WorkflowOwner, input: WorkflowApplyInput, validation: WorkflowApplyValidationContext | undefined, now?: number) => WorkflowEffect<WorkflowApplyResult>;
  readonly ensureMain: (owner: WorkflowOwner, operationId: string, note: string, now?: number) => WorkflowEffect<WorkflowEnsureResult>;
  readonly linkChild: (owner: WorkflowOwner, input: {operationId: string; lineage: WorkflowControllerLineage; note: string}, now?: number) => WorkflowEffect<WorkflowMutationResult>;
  readonly importAcceptedAgreement: (owner: WorkflowOwner, source: WorkflowAgreementImport, now?: number) => WorkflowEffect<WorkflowMutationResult>;
  readonly recordContribution: (owner: WorkflowOwner, input: ExternalContributionImport, now?: number) => WorkflowEffect<ExternalContributionImportResult>;
  readonly assessContribution: (owner: WorkflowOwner, input: WorkflowContributionAssessmentInput, now?: number) => WorkflowEffect<WorkflowMutationResult>;
}

const workflowColumns = "workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document";
const decodeWorkflowRow = Schema.decodeUnknownEffect(Schema.Struct({workflow_id: Schema.String, project_id: Schema.String, main_thread_id: Schema.String,
  thread_id: Schema.String, parent_workflow_id: Schema.NullOr(Schema.String), parent_thread_id: Schema.NullOr(Schema.String), revision: Schema.Finite, document: Schema.String}));
const decodeOperationRow = Schema.decodeUnknownEffect(Schema.Struct({request_hash: Schema.String, result: Schema.String}));
const decodeWorkflowJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeStoredDocument = Schema.decodeUnknownExit(WorkflowStateDocumentSchema);
const decodeStoredReceipt = Schema.decodeUnknownExit(WorkflowMutationReceiptSchema);

// a stored document must decode with the stored-shape schema and pass the store's own limits and row identity; it is
// returned as stored (key order included), since its fingerprint is the receipt's stateHash
const classifyWorkflowRow = (row: WorkflowRow): WorkflowStateDecode => {
  const parsed = decodeWorkflowJson(row.document);
  if (Exit.isFailure(parsed)) return {status: "incompatible", workflowId: row.workflow_id, formatVersion: null};
  const value = parsed.value;
  if (!isRecord(value) || value.formatVersion !== 2 || Exit.isFailure(decodeStoredDocument(value)) || !validDocument(value) || value.workflowId !== row.workflow_id ||
    value.projectId !== row.project_id || value.mainThreadId !== row.main_thread_id || value.threadId !== row.thread_id ||
    value.revision !== row.revision || value.parentWorkflowId !== row.parent_workflow_id || value.parentThreadId !== row.parent_thread_id)
    return {status: "incompatible", workflowId: row.workflow_id,
      formatVersion: isRecord(value) && Number.isSafeInteger(value.formatVersion) ? Number(value.formatVersion) : null};
  return {status: "found", document: {...value, contributions: value.contributions ?? []} as unknown as WorkflowStateDocument};
};

// a stored receipt replays only when it decodes with the receipt schema; anything else is reported incompatible, never as a write
const classifyReceipt = (operationId: string, text: string): WorkflowMutationResult => {
  const parsed = decodeWorkflowJson(text);
  if (Exit.isFailure(parsed)) return {status: "incompatible", operationId, workflowId: "unknown", formatVersion: null};
  const result = parsed.value;
  if (!isRecord(result) || result.formatVersion !== 2 || !validId(result.workflowId) || Exit.isFailure(decodeStoredReceipt(result)))
    return {status: "incompatible", operationId, workflowId: isRecord(result) && validId(result.workflowId) ? result.workflowId : "unknown",
      formatVersion: isRecord(result) && Number.isSafeInteger(result.formatVersion) ? Number(result.formatVersion) : null};
  return result as unknown as WorkflowMutationReceipt;
};

const workflowReceipt = (status: "applied" | "created", operationId: string, document: WorkflowStateDocument): WorkflowMutationReceipt =>
  ({status, operationId, workflowId: document.workflowId, revision: document.revision, stateHash: fingerprint(document), formatVersion: 2});

// the plan and evidence checks, as pure functions
const normalizeWorkflowPlan = (input: WorkflowStatePlan, existing: WorkflowStatePlan, submittedNodeIds: ReadonlySet<string>):
  {ok: true; plan: WorkflowStatePlan} | {ok: false; diagnostic: WorkflowApplyDiagnostic | null} => {
  if (!validPlan(input)) return {ok: false, diagnostic: null};
  const existingEntities = collectPlanEntities(existing);
  const existingById = new Map(existingEntities.map(node => [node.nodeId, node]));
  const nextEntities = collectPlanEntities(input);
  const existingByIdentity = new Map<string, PlanEntity[]>();
  const nextByIdentity = new Map<string, PlanEntity[]>();
  for (const node of existingEntities) existingByIdentity.set(identityKey(node), [...(existingByIdentity.get(identityKey(node)) ?? []), node]);
  for (const node of nextEntities) nextByIdentity.set(identityKey(node), [...(nextByIdentity.get(identityKey(node)) ?? []), node]);
  for (const [key, previous] of existingByIdentity) {
    const missingPreviousIds = previous.filter(node => !submittedNodeIds.has(node.nodeId));
    const generatedSameIdentity = (nextByIdentity.get(key) ?? []).some(node => !submittedNodeIds.has(node.nodeId));
    if (missingPreviousIds.length && generatedSameIdentity) return {ok: false, diagnostic: null};
  }
  for (const node of nextEntities) {
    const previous = existingById.get(node.nodeId);
    if (!previous && node.status !== "planned") {
      const path = planStatusPointer(input, node);
      return {ok: false, diagnostic: path ? {code: "new_node_must_start_planned", path, expected: newNodeMustStartPlannedExpected} : null};
    }
  }
  return {ok: true, plan: copyPlan(input)};
};

const workflowStatusEvidenceProblem = (current: WorkflowStateDocument, input: WorkflowApplyInput, nextPlan: WorkflowStatePlan): WorkflowApplyDiagnostic | "generic" | null => {
  const evidence = input.evidence ?? [];
  const previousNodes = new Map(collectPlanEntities(current.plan).map(node => [node.nodeId, node]));
  const nextNodes = new Map(collectPlanEntities(nextPlan).map(node => [node.nodeId, node]));
  for (const node of nextNodes.values()) {
    const previous = previousNodes.get(node.nodeId);
    if (!previous) continue;
    if (previous.status !== node.status && !evidence.some(item => item.kind === "status_changed" && item.targetNodeId === node.nodeId)) {
      const path = planStatusPointer(nextPlan, node);
      return path ? {code: "missing_status_changed_evidence", path, expected: missingStatusChangedEvidenceExpected} : "generic";
    }
  }
  if (current.status !== input.status && !evidence.some(item => item.kind === "status_changed" && (item.targetNodeId === null || item.targetNodeId === undefined)))
    return {code: "missing_status_changed_evidence", path: "/status", expected: missingStatusChangedEvidenceExpected};
  if (!evidence.every(item => item.targetNodeId === null || item.targetNodeId === undefined || nextNodes.has(item.targetNodeId))) return "generic";
  return null;
};

const validWorkflowAgreementImport = (source: WorkflowAgreementImport): boolean => {
  if (!isRecord(source) || !validId(source.taskId) || !validId(source.sourceThreadId) || !validId(source.sourceRunId) || !validId(source.sourceMessageId) ||
    !validText(source.sourceHash) || !validText(source.objective) || !isRecord(source.agreement) || source.agreement.status !== "agreed" ||
    !validId(source.agreement.proposalId) || !validText(source.agreement.supervisorMessageId) || !validText(source.agreement.agentMessageId) ||
    !Number.isFinite(source.agreement.agreedAt) || !isRecord(source.agreement.workflow) || source.agreement.workflow.status !== "proposed") return false;
  const workflow = source.agreement.workflow;
  const binding = sourceBindingOf(source.agreement.workflow, source.taskId, source.agreement.proposalId, source.sourceHash);
  return validSourceBinding(binding) && binding.definitionsStatus === "ready" && binding.definitionsComplete && binding.requirementsKnown &&
    validText(binding.workspaceRoot) && validText(binding.revision) && validRequirements(workflow.requirements) &&
    validIssues(workflow.issues) && workflow.issues.length === 0 &&
    workflow.requirements.every(item => item.state === "included" || item.state === "not_applicable") &&
    validPlan(workflow.plan) && workflow.plan !== null &&
    collectPlanEntities(workflow.plan).every(node => node.resolution === "resolved") &&
    workflow.definitionsStatus === binding.definitionsStatus && workflow.definitionsComplete === binding.definitionsComplete &&
    workflow.requirementsKnown === binding.requirementsKnown;
};

const acceptedWorkflowPlanHash = (source: WorkflowAgreementImport): string => {
  const workflow = source.agreement.workflow;
  const binding = sourceBindingOf(workflow, source.taskId, source.agreement.proposalId, source.sourceHash);
  return fingerprint({objective: source.objective, sourceBinding: binding, requirements: workflow.requirements,
    issues: workflow.issues, plan: staticPlan(workflow.plan)});
};

const makeWorkflowStateStore = (enabledFor?: WorkflowEditingEnabled) => Effect.gen(function* () {
  const sql = yield* GuidanceDb;
  const ids = yield* SupervisorIds;
  const supervisors = yield* ProjectSupervisorStore;
  const isEnabled: WorkflowEditingEnabled = enabledFor ?? (projectId => supervisors.enabled(projectId));

  const unavailable = new WorkflowStateStoreError({reason: "workflow_store_unavailable"});
  const run = mapSqlError(() => unavailable);
  // every write is one transaction, or a savepoint of the caller's: the owner check, the revision CAS and the receipt commit together
  const write = <A>(body: Effect.Effect<A, WorkflowFailure>): WorkflowEffect<A> => run(sql.withTransaction(body));
  const read = <A>(body: Effect.Effect<A, WorkflowFailure>): WorkflowEffect<A> => run(snapshotRead(sql)(body));
  const nowOr = (now: number | undefined) => now === undefined ? Clock.currentTimeMillis : Effect.succeed(now);
  const workflowRows = (rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) => decodeWorkflowRow(row).pipe(Effect.mapError(() => new WorkflowStateStoreError({reason: "workflow_row_invalid", row: "workflow"}))));
  const firstWorkflow = (rows: ReadonlyArray<unknown>) => Effect.map(workflowRows(rows.slice(0, 1)), ([row]): WorkflowRow | null => row ?? null);

  const workflowByThread = (scope: WorkflowScope, threadId: string) =>
    sql.unsafe(`SELECT ${workflowColumns} FROM supervisor_workflow_state WHERE project_id=? AND main_thread_id=? AND thread_id=?`, [scope.projectId, scope.mainThreadId, threadId]).pipe(Effect.flatMap(firstWorkflow));
  const workflowById = (owner: WorkflowScope, workflowId: string) =>
    sql.unsafe(`SELECT ${workflowColumns} FROM supervisor_workflow_state WHERE workflow_id=? AND project_id=? AND main_thread_id=?`, [workflowId, owner.projectId, owner.mainThreadId]).pipe(Effect.flatMap(firstWorkflow));
  const currentRevision = (owner: WorkflowOwner, workflowId: string) => Effect.map(workflowById(owner, workflowId), (latest) => {
    if (!latest) return null;
    const decoded = classifyWorkflowRow(latest);
    return decoded.status === "found" ? decoded.document.revision : null;
  });
  // the revision cas: exactly one row changes only when the stored revision is still the expected one
  const casUpdate = (owner: WorkflowScope, workflowId: string, revision: number, serialized: string, updatedAt: number, expectedRevision: number) =>
    sql`UPDATE supervisor_workflow_state SET revision=${revision},document=${serialized},updated_at=${updatedAt} WHERE workflow_id=${workflowId} AND project_id=${owner.projectId} AND main_thread_id=${owner.mainThreadId} AND revision=${expectedRevision} RETURNING workflow_id`.pipe(
      Effect.map((rows) => rows.length === 1));
  const insertWorkflow = (document: WorkflowStateDocument, serialized: string) =>
    sql`INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document,created_at,updated_at) VALUES(${document.workflowId},${document.projectId},${document.mainThreadId},${document.threadId},${document.parentWorkflowId},${document.parentThreadId},${document.revision},${serialized},${document.createdAt},${document.updatedAt})`;
  const replaceWorkflow = Effect.fnUntraced(function* (document: WorkflowStateDocument, serialized: string, expectedRevision: number) {
    if (!(yield* casUpdate(document, document.workflowId, document.revision, serialized, document.updatedAt, expectedRevision)))
      return yield* new WorkflowStateStoreError({reason: "workflow_revision_conflict"});
  });

  const currentOwner = Effect.fnUntraced(function* (owner: WorkflowOwner) {
    if (!supervisors.scopeCompatible || !validId(owner.projectId) || !validId(owner.mainThreadId) || !validId(owner.supervisorThreadId) ||
      !Number.isSafeInteger(owner.bindingGeneration) || owner.bindingGeneration < 1) return false;
    const binding = yield* supervisors.binding(owner.projectId, owner.mainThreadId);
    if (!(yield* isEnabled(owner.projectId, owner.mainThreadId))) return false;
    return binding?.state === "ready" && binding.threadId === owner.supervisorThreadId && binding.generation === owner.bindingGeneration;
  });
  // receipts are keyed (project, main, actor, binding generation, namespace, operation id); another request hash under the same
  // id is operation_id_reused, an identical one replays the stored receipt
  const operationReplay = Effect.fnUntraced(function* (owner: WorkflowOwner, namespace: WorkflowOperationNamespace, operationId: string, requestHash: string) {
    const [stored] = yield* sql`SELECT request_hash,result FROM supervisor_workflow_operations WHERE project_id=${owner.projectId} AND main_thread_id=${owner.mainThreadId} AND actor_thread_id=${owner.supervisorThreadId} AND binding_generation=${owner.bindingGeneration} AND operation_namespace=${namespace} AND operation_id=${operationId}`;
    if (stored === undefined) return null;
    const row = yield* decodeOperationRow(stored).pipe(Effect.mapError(() => new WorkflowStateStoreError({reason: "workflow_row_invalid", row: "operation"})));
    if (row.request_hash !== requestHash) return {status: "conflict", operationId, reason: "operation_id_reused", currentRevision: null} satisfies WorkflowMutationResult as WorkflowMutationResult;
    return classifyReceipt(operationId, row.result);
  });
  const recordOperation = (owner: WorkflowOwner, namespace: WorkflowOperationNamespace, operationId: string, requestHash: string, receipt: WorkflowMutationReceipt, now: number) =>
    sql`INSERT INTO supervisor_workflow_operations(project_id,main_thread_id,actor_thread_id,binding_generation,operation_namespace,operation_id,request_hash,result,workflow_id,created_at) VALUES(${owner.projectId},${owner.mainThreadId},${owner.supervisorThreadId},${owner.bindingGeneration},${namespace},${operationId},${requestHash},${json(receipt)},${receipt.workflowId},${now})`;
  const emptyDocument = Effect.fnUntraced(function* (owner: WorkflowOwner, threadId: string, parentWorkflowId: string | null, parentThreadId: string | null, revision: number, now: number) {
    return {formatVersion: 2, workflowId: yield* ids.uuid, projectId: owner.projectId, mainThreadId: owner.mainThreadId, threadId,
      parentWorkflowId, parentThreadId, revision, status: "planned", objective: null, sourceBinding: null, requirements: [], issues: [], plan: null,
      currentAgreementKey: null, acceptedAgreements: [], contributions: [], evidence: [], createdAt: now, updatedAt: now} satisfies WorkflowStateDocument as WorkflowStateDocument;
  });
  const makeEvidence = Effect.fnUntraced(function* (input: Omit<WorkflowStateEvidence, "id" | "recordedAt" | "actorSupervisorThreadId"> & {owner: WorkflowOwner; now: number}) {
    const {owner, now, ...rest} = input;
    return {...rest, sourceItemId: rest.sourceItemId ?? null, id: yield* ids.uuid, recordedAt: now, actorSupervisorThreadId: owner.supervisorThreadId} satisfies WorkflowStateEvidence as WorkflowStateEvidence;
  });

  const getState = (projectId: string, mainThreadId: string, threadId = mainThreadId) => run(Effect.gen(function* () {
    const row = yield* workflowByThread({projectId, mainThreadId}, threadId);
    return row ? classifyWorkflowRow(row) : {status: "not_found"} satisfies WorkflowStateLookupResult as WorkflowStateLookupResult;
  }));
  const get = (projectId: string, mainThreadId: string, threadId = mainThreadId) =>
    Effect.map(getState(projectId, mainThreadId, threadId), (decoded) => decoded.status === "found" ? decoded.document : null);
  /** Looks up a workflow by ID only for the current owner; joins the caller's transaction. */
  const getByIdForOwner = (owner: WorkflowOwner, workflowId: string) => read(Effect.gen(function* () {
    if (!(yield* currentOwner(owner))) return {status: "owner_mismatch"} satisfies WorkflowStateLookupResult as WorkflowStateLookupResult;
    if (!validId(workflowId)) return {status: "not_found"} satisfies WorkflowStateLookupResult as WorkflowStateLookupResult;
    const row = yield* workflowById(owner, workflowId);
    return row ? classifyWorkflowRow(row) : {status: "not_found"} satisfies WorkflowStateLookupResult as WorkflowStateLookupResult;
  }));
  const listResult = (projectId: string, mainThreadId: string) => run(Effect.gen(function* () {
    const rows = yield* sql.unsafe(`SELECT ${workflowColumns} FROM supervisor_workflow_state WHERE project_id=? AND main_thread_id=? ORDER BY created_at,thread_id`, [projectId, mainThreadId]).pipe(
      Effect.flatMap(workflowRows));
    const documents: WorkflowStateDocument[] = [];
    const incompatible: Array<{workflowId: string; formatVersion: number | null}> = [];
    for (const row of rows) {
      const decoded = classifyWorkflowRow(row);
      if (decoded.status === "found") documents.push(decoded.document);
      else incompatible.push({workflowId: decoded.workflowId, formatVersion: decoded.formatVersion});
    }
    return {documents, incompatible};
  }));
  const list = (projectId: string, mainThreadId: string) => Effect.map(listResult(projectId, mainThreadId), (result) => result.documents);
  // bounded: at most 512 rows, thread ids chunked by 400; an unreadable query or row makes the scan incomplete
  const hasNeedsAttention = (projectId: string, mainThreadId: string, threadIds: readonly string[], limit = maxNeedsAttentionScan) => {
    if (!validId(projectId) || !validId(mainThreadId) || !Array.isArray(threadIds) || threadIds.length < 1 || threadIds.length > 10_000 ||
      !threadIds.every(id => validId(id)) || new Set(threadIds).size !== threadIds.length || !threadIds.includes(mainThreadId))
      return Effect.succeed<WorkflowNeedsAttentionScan>({status: "incomplete", needsAttention: false, inspected: 0, reason: "invalid_scope"});
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxNeedsAttentionScan)
      return Effect.succeed<WorkflowNeedsAttentionScan>({status: "incomplete", needsAttention: false, inspected: 0, reason: "limit_exceeded"});
    return read(Effect.gen(function* () {
      let inspected = 0;
      for (let start = 0; start < threadIds.length; start += needsAttentionThreadChunkSize) {
        const chunk = threadIds.slice(start, start + needsAttentionThreadChunkSize);
        const remaining = limit - inspected;
        const queryLimit = remaining + 1;
        const placeholders = chunk.map(() => "?").join(",");
        const rows = yield* sql.unsafe(`SELECT ${workflowColumns} FROM supervisor_workflow_state WHERE project_id=? AND main_thread_id=? AND thread_id IN (${placeholders}) ORDER BY thread_id LIMIT ${queryLimit}`,
          [projectId, mainThreadId, ...chunk]).pipe(Effect.flatMap(workflowRows), Effect.option);
        if (rows._tag === "None") return {status: "incomplete", needsAttention: false, inspected, reason: "unreadable_workflow"} satisfies WorkflowNeedsAttentionScan as WorkflowNeedsAttentionScan;
        for (const row of rows.value.slice(0, remaining)) {
          inspected++;
          const decoded = classifyWorkflowRow(row);
          if (decoded.status !== "found")
            return {status: "incomplete", needsAttention: false, inspected, reason: "unreadable_workflow"} satisfies WorkflowNeedsAttentionScan as WorkflowNeedsAttentionScan;
          if (decoded.document.status === "needs_attention" || collectPlanEntities(decoded.document.plan).some(node => node.status === "needs_attention"))
            return {status: "complete", needsAttention: true, inspected} satisfies WorkflowNeedsAttentionScan as WorkflowNeedsAttentionScan;
        }
        if (rows.value.length > remaining)
          return {status: "incomplete", needsAttention: false, inspected, reason: "limit_exceeded"} satisfies WorkflowNeedsAttentionScan as WorkflowNeedsAttentionScan;
      }
      return {status: "complete", needsAttention: false, inspected} satisfies WorkflowNeedsAttentionScan as WorkflowNeedsAttentionScan;
    }));
  };

  /** Applies a full editable document; joins the caller's transaction. */
  const apply = (owner: WorkflowOwner, input: WorkflowApplyInput, validation: WorkflowApplyValidationContext | undefined, now?: number) => write(Effect.gen(function* () {
    if (!validApplyInput(input)) return {status: "invalid", operationId: input.operationId, reason: "invalid_workflow_document"} satisfies WorkflowApplyResult as WorkflowApplyResult;
    const at = yield* nowOr(now);
    const submittedNodeIds = collectSubmittedNodeIds(input.plan);
    if (!(yield* currentOwner(owner))) return {status: "owner_mismatch", operationId: input.operationId} satisfies WorkflowApplyResult as WorkflowApplyResult;

    const requestHash = requestFingerprint({kind: "apply", owner, input});
    const replay = yield* operationReplay(owner, "edit", input.operationId, requestHash);
    if (replay) return replay;

    const row = yield* workflowById(owner, input.workflowId);
    if (!row) return {status: "not_found", operationId: input.operationId} satisfies WorkflowApplyResult as WorkflowApplyResult;
    const decoded = classifyWorkflowRow(row);
    if (decoded.status === "incompatible") return {...decoded, operationId: input.operationId};
    const current = decoded.document;
    if (current.revision !== input.expectedRevision) return {status: "conflict", operationId: input.operationId,
      reason: "revision", currentRevision: current.revision} satisfies WorkflowApplyResult as WorkflowApplyResult;
    if (!validation || !isRecord(validation.pinnedContext) || !isRecord(validation.originalProposal) ||
      !validId(validation.expectedTaskId) || !validId(validation.expectedProposalId) ||
      !Object.hasOwn(validation, "acceptedTaskAgreement") || !Object.hasOwn(validation, "acceptedTaskAgreementSourceHash") || !input.sourceBinding)
      return {status: "invalid", operationId: input.operationId, reason: "pinned_definition_context_required"} satisfies WorkflowApplyResult as WorkflowApplyResult;
    let canonical: ReturnType<typeof validateWorkflowApplyAgainstPinnedContext> = null;
    try {
      const currentBinding = current.sourceBinding;
      const currentPlan = currentBinding?.taskId === validation.expectedTaskId &&
        currentBinding.sourceHash === validation.expectedSourceHash &&
        currentBinding.workspaceRoot === validation.pinnedContext.workspaceRoot &&
        currentBinding.revision === validation.pinnedContext.revision &&
        currentBinding.globalRevision === (validation.pinnedContext.globalRevision ?? null) &&
        currentBinding.definitionsStatus === "ready" && currentBinding.definitionsComplete && currentBinding.requirementsKnown
        ? current.plan : null;
      const trustedBinding = sourceBindingOf(validation.originalProposal, validation.expectedTaskId, validation.expectedProposalId, validation.expectedSourceHash);
      const acceptedTaskPlan = current.threadId === owner.mainThreadId ? acceptedTaskPlanForBinding(validation.acceptedTaskAgreement,
        validation.acceptedTaskAgreementSourceHash, validation.expectedSourceHash, trustedBinding) : null;
      const acceptedPlans = [...acceptedWorkflowPlansForBinding(current, trustedBinding), ...(acceptedTaskPlan ? [acceptedTaskPlan] : [])];
      canonical = validateWorkflowApplyAgainstPinnedContext({plan: input.plan, requirements: input.requirements, issues: input.issues,
        sourceBinding: input.sourceBinding as WorkflowSourceBindingInfo}, validation.pinnedContext, validation.originalProposal,
      validation.expectedTaskId, validation.expectedProposalId, validation.expectedSourceHash,
      {targetThreadId: current.threadId, mainThreadId: owner.mainThreadId}, acceptedPlans, currentPlan);
    } catch {canonical = null;}
    if (!canonical) return {status: "invalid", operationId: input.operationId, reason: "pinned_definition_context_mismatch"} satisfies WorkflowApplyResult as WorkflowApplyResult;
    const validatedInput: WorkflowApplyInput = {...input, plan: canonical.plan, requirements: canonical.requirements, issues: canonical.issues};

    const normalized = normalizeWorkflowPlan(validatedInput.plan, current.plan, submittedNodeIds);
    if (!normalized.ok) return {status: "invalid", operationId: input.operationId,
      reason: normalized.diagnostic?.code ?? "invalid_plan_or_missing_status_evidence",
      ...(normalized.diagnostic ? {diagnostic: normalized.diagnostic} : {})} satisfies WorkflowApplyResult as WorkflowApplyResult;
    const evidenceProblem = workflowStatusEvidenceProblem(current, validatedInput, normalized.plan);
    if (evidenceProblem) return {status: "invalid", operationId: input.operationId,
      reason: evidenceProblem === "generic" ? "invalid_plan_or_missing_status_evidence" : evidenceProblem.code,
      ...(evidenceProblem === "generic" ? {} : {diagnostic: evidenceProblem})} satisfies WorkflowApplyResult as WorkflowApplyResult;
    const nextPlan = normalized.plan;
    const evidenceInputs = validatedInput.evidence ?? [];
    const previousNodes = new Map(collectPlanEntities(current.plan).map(node => [node.nodeId, node]));
    const nextNodes = new Map(collectPlanEntities(nextPlan).map(node => [node.nodeId, node]));
    const evidence = [...current.evidence];
    for (const item of evidenceInputs) {
      const nodeId = item.targetNodeId ?? null;
      const previous = nodeId ? previousNodes.get(nodeId) : null;
      const next = nodeId ? nextNodes.get(nodeId) : null;
      evidence.push(yield* makeEvidence({operationId: input.operationId, owner, kind: item.kind, now: at,
        targetNodeId: nodeId, targetNodeName: next?.name ?? previous?.name ?? null,
        statusFrom: previous?.status ?? (nodeId === null ? current.status : null),
        statusTo: next?.status ?? (nodeId === null ? validatedInput.status : null),
        sourceThreadId: item.sourceThreadId ?? ((item.sourceRunId ?? item.sourceMessageId ?? item.sourceItemId) ? current.threadId : null),
        sourceRunId: item.sourceRunId ?? null,
        sourceMessageId: item.sourceMessageId ?? null, sourceItemId: item.sourceItemId ?? null, agreementKey: null, note: item.note}));
    }
    for (const node of previousNodes.values()) {
      if (!nextNodes.has(node.nodeId)) evidence.push(yield* makeEvidence({operationId: input.operationId, owner, kind: "node_removed", now: at,
        targetNodeId: node.nodeId, targetNodeName: node.name, statusFrom: node.status, statusTo: null,
        sourceThreadId: null, sourceRunId: null, sourceMessageId: null, sourceItemId: null, agreementKey: null, note: input.note}));
    }

    const oldPlanHash = workflowPlanSignature(current.objective, current.sourceBinding, current.requirements, current.issues, current.plan);
    const newPlanHash = workflowPlanSignature(validatedInput.objective, validatedInput.sourceBinding, validatedInput.requirements, validatedInput.issues, nextPlan);
    evidence.push(yield* makeEvidence({operationId: input.operationId, owner, kind: "plan_updated", now: at,
      targetNodeId: null, targetNodeName: null, statusFrom: current.status, statusTo: validatedInput.status,
      sourceThreadId: null, sourceRunId: null, sourceMessageId: null, sourceItemId: null, agreementKey: null, note: input.note}));
    if (evidence.length > workflowMutationLimits.maxEvidence) return {status: "invalid", operationId: input.operationId, reason: "evidence_capacity"} satisfies WorkflowApplyResult as WorkflowApplyResult;

    const next: WorkflowStateDocument = {...current, revision: current.revision + 1, status: validatedInput.status, objective: validatedInput.objective,
      sourceBinding: copyBinding(validatedInput.sourceBinding), requirements: copyRequirements(validatedInput.requirements), issues: copyIssues(validatedInput.issues),
      plan: nextPlan, currentAgreementKey: oldPlanHash === newPlanHash ? current.currentAgreementKey : null,
      evidence, updatedAt: at};
    const serialized = json(next);
    if (!documentFits(serialized)) return {status: "invalid", operationId: input.operationId, reason: "document_capacity"} satisfies WorkflowApplyResult as WorkflowApplyResult;
    if (!(yield* casUpdate(owner, current.workflowId, next.revision, serialized, at, input.expectedRevision))) {
      const latest = yield* workflowById(owner, current.workflowId);
      const latestState = latest ? classifyWorkflowRow(latest) : null;
      return {status: "conflict", operationId: input.operationId, reason: "revision",
        currentRevision: latestState?.status === "found" ? latestState.document.revision : null} satisfies WorkflowApplyResult as WorkflowApplyResult;
    }
    const receipt = workflowReceipt("applied", input.operationId, next);
    yield* recordOperation(owner, "edit", input.operationId, requestHash, receipt, at);
    return receipt;
  }));

  /** Creates an unaccepted main draft; joins the caller's verified transaction. */
  const ensureMain = (owner: WorkflowOwner, operationId: string, note: string, now?: number) => write(Effect.gen(function* () {
    if (!validId(operationId) || !validText(note)) return {status: "invalid", operationId, reason: "invalid_main_workflow_draft"} satisfies WorkflowEnsureResult as WorkflowEnsureResult;
    const at = yield* nowOr(now);
    if (!(yield* currentOwner(owner))) return {status: "owner_mismatch", operationId} satisfies WorkflowEnsureResult as WorkflowEnsureResult;
    const requestHash = requestFingerprint({kind: "ensure-main", owner, note});
    const replay = yield* operationReplay(owner, "edit", operationId, requestHash);
    if (replay) return replay;
    const existing = yield* workflowByThread(owner, owner.mainThreadId);
    if (existing) {
      const decoded = classifyWorkflowRow(existing);
      if (decoded.status === "incompatible") return {...decoded, operationId};
      return {status: "exists", operationId, workflowId: decoded.document.workflowId, revision: decoded.document.revision,
        stateHash: fingerprint(decoded.document), formatVersion: 2} satisfies WorkflowEnsureResult as WorkflowEnsureResult;
    }
    const document = yield* emptyDocument(owner, owner.mainThreadId, null, null, 1, at);
    document.evidence.push(yield* makeEvidence({operationId, owner, kind: "draft_created", now: at,
      targetNodeId: null, targetNodeName: null, statusFrom: null, statusTo: "planned",
      sourceThreadId: null, sourceRunId: null, sourceMessageId: null, agreementKey: null, note}));
    const serialized = json(document);
    if (!documentFits(serialized)) return {status: "invalid", operationId, reason: "document_capacity"} satisfies WorkflowEnsureResult as WorkflowEnsureResult;
    yield* insertWorkflow(document, serialized);
    const receipt = workflowReceipt("created", operationId, document);
    yield* recordOperation(owner, "edit", operationId, requestHash, receipt, at);
    return receipt;
  }));

  /** Links a native descendant without inferring a proposal or agreement for it; joins the caller's transaction. */
  const linkChild = (owner: WorkflowOwner, input: {operationId: string; lineage: WorkflowControllerLineage; note: string}, now?: number) => write(Effect.gen(function* () {
    const {operationId, lineage} = input;
    if (!validId(operationId) || !validId(lineage.threadId) || !validId(lineage.parentThreadId) ||
      lineage.relationshipToParent !== "subagent" || lineage.threadId === owner.mainThreadId || !validText(input.note))
      return {status: "invalid", operationId, reason: "invalid_child_lineage"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const at = yield* nowOr(now);
    if (!(yield* currentOwner(owner))) return {status: "owner_mismatch", operationId} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const requestHash = requestFingerprint({kind: "link-child", owner, lineage, note: input.note});
    const replay = yield* operationReplay(owner, "edit", operationId, requestHash);
    if (replay) return replay;

    const parent = yield* workflowByThread(owner, lineage.parentThreadId);
    if (!parent) return {status: "conflict", operationId, reason: "parent_missing", currentRevision: null} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const parentResult = classifyWorkflowRow(parent);
    if (parentResult.status === "incompatible") return {...parentResult, operationId};
    const existing = yield* workflowByThread(owner, lineage.threadId);
    if (existing) {
      const decoded = classifyWorkflowRow(existing);
      if (decoded.status === "incompatible") return {...decoded, operationId};
      return {status: "conflict", operationId, reason: "child_already_linked", currentRevision: decoded.document.revision} satisfies WorkflowMutationResult as WorkflowMutationResult;
    }
    const parentDocument = parentResult.document;
    const document = yield* emptyDocument(owner, lineage.threadId, parentDocument.workflowId, lineage.parentThreadId, 1, at);
    document.evidence.push(yield* makeEvidence({operationId, owner, kind: "lineage_linked", now: at,
      targetNodeId: null, targetNodeName: null, statusFrom: null, statusTo: "planned",
      sourceThreadId: lineage.threadId, sourceRunId: null, sourceMessageId: null, agreementKey: null, note: input.note}));
    const serialized = json(document);
    if (!documentFits(serialized)) return {status: "invalid", operationId, reason: "document_capacity"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    yield* insertWorkflow(document, serialized);
    const receipt = workflowReceipt("created", operationId, document);
    yield* recordOperation(owner, "edit", operationId, requestHash, receipt, at);
    return receipt;
  }));

  /** Imports a validated acceptance without changing an already populated broad plan; joins the caller's transaction. */
  const importAcceptedAgreement = (owner: WorkflowOwner, source: WorkflowAgreementImport, now?: number) => write(Effect.gen(function* () {
    const operationId = acceptedKey(source.taskId, source.agreement.proposalId);
    if (!validWorkflowAgreementImport(source)) return {status: "invalid", operationId, reason: "invalid_accepted_agreement"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const at = yield* nowOr(now);
    if (!(yield* currentOwner(owner))) return {status: "owner_mismatch", operationId} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const requestHash = requestFingerprint({kind: "agreement-import", owner, source});
    const replay = yield* operationReplay(owner, "agreement", operationId, requestHash);
    if (replay) return replay;

    const row = yield* workflowByThread(owner, source.sourceThreadId);
    const creatingMain = !row && source.sourceThreadId === owner.mainThreadId;
    if (!row && !creatingMain) return {status: "not_found", operationId} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const decoded = row ? classifyWorkflowRow(row) : null;
    if (decoded?.status === "incompatible") return {...decoded, operationId};
    const current = decoded?.status === "found" ? decoded.document :
      yield* emptyDocument(owner, owner.mainThreadId, null, null, 0, at);
    if (current.acceptedAgreements.some(item => item.key === acceptedKey(source.taskId, source.agreement.proposalId))) {
      const receipt = workflowReceipt("applied", operationId, current);
      yield* recordOperation(owner, "agreement", operationId, requestHash, receipt, at);
      return receipt;
    }
    if (current.acceptedAgreements.length >= workflowMutationLimits.maxAcceptedAgreements)
      return {status: "invalid", operationId, reason: "agreement_history_capacity"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    if (current.evidence.length >= workflowMutationLimits.maxEvidence)
      return {status: "invalid", operationId, reason: "evidence_capacity"} satisfies WorkflowMutationResult as WorkflowMutationResult;

    const binding = sourceBindingOf(source.agreement.workflow, source.taskId, source.agreement.proposalId, source.sourceHash);
    const acceptedPlan = copyPlan(source.agreement.workflow.plan);
    const acceptedRequirements = copyRequirements(source.agreement.workflow.requirements);
    const acceptedIssues = copyIssues(source.agreement.workflow.issues);
    const key = acceptedKey(source.taskId, source.agreement.proposalId);
    const accepted: AcceptedWorkflowAgreementRecord = {key, taskId: source.taskId, sourceThreadId: source.sourceThreadId,
      sourceRunId: source.sourceRunId, sourceMessageId: source.sourceMessageId, sourceHash: source.sourceHash,
      objective: source.objective, planHash: acceptedWorkflowPlanHash(source), sourceBinding: binding,
      requirements: acceptedRequirements, issues: acceptedIssues, plan: acceptedPlan, agreement: source.agreement};
    const emptyPlan = current.objective === null && current.plan === null;
    const currentMatches = workflowPlanSignature(current.objective, current.sourceBinding, current.requirements, current.issues, current.plan) ===
      workflowPlanSignature(source.objective, binding, acceptedRequirements, acceptedIssues, acceptedPlan);
    const shouldSeed = emptyPlan;
    const next: WorkflowStateDocument = {...current, revision: current.revision + 1,
      ...(shouldSeed ? {objective: source.objective, sourceBinding: copyBinding(binding), requirements: acceptedRequirements,
        issues: acceptedIssues, plan: acceptedPlan} : {}),
      currentAgreementKey: shouldSeed || currentMatches ? key : current.currentAgreementKey,
      acceptedAgreements: [...current.acceptedAgreements, accepted],
      evidence: [...current.evidence, yield* makeEvidence({operationId, owner, kind: "agreement_imported", now: at,
        targetNodeId: null, targetNodeName: null, statusFrom: null, statusTo: null,
        sourceThreadId: source.sourceThreadId, sourceRunId: source.sourceRunId, sourceMessageId: source.sourceMessageId,
        agreementKey: key, note: "A validated workflow agreement was retained as historical source evidence."})],
      updatedAt: at};
    const serialized = json(next);
    if (!documentFits(serialized)) return {status: "invalid", operationId, reason: "document_capacity"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    if (creatingMain) yield* insertWorkflow(next, serialized);
    else if (row?.revision === 0) yield* replaceWorkflow(next, serialized, 0);
    else if (!(yield* casUpdate(owner, next.workflowId, next.revision, serialized, at, row!.revision)))
      return {status: "conflict", operationId, reason: "revision", currentRevision: yield* currentRevision(owner, next.workflowId)} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const receipt = workflowReceipt("applied", operationId, next);
    yield* recordOperation(owner, "agreement", operationId, requestHash, receipt, at);
    return receipt;
  }));

  /**
   * Records one revision of a main-authored external contribution on the main workflow; joins the caller's transaction. It
   * never changes a node status or the plan, writes no receipt, and a later revision clears the current assessment.
   */
  const recordContribution = (owner: WorkflowOwner, input: ExternalContributionImport, now?: number) => write(Effect.gen(function* () {
    if (!validContributionImport(input)) return {status: "rejected", code: "contribution_record_invalid"} satisfies ExternalContributionImportResult as ExternalContributionImportResult;
    const at = yield* nowOr(now);
    if (!(yield* currentOwner(owner))) return {status: "owner_mismatch"} satisfies ExternalContributionImportResult as ExternalContributionImportResult;
    const row = yield* workflowByThread(owner, owner.mainThreadId);
    if (!row) return {status: "rejected", code: "contribution_node_unknown"} satisfies ExternalContributionImportResult as ExternalContributionImportResult;
    const decoded = classifyWorkflowRow(row);
    if (decoded.status === "incompatible") return decoded;
    const current = decoded.document;
    if (current.parentWorkflowId !== null || current.threadId !== owner.mainThreadId) return {status: "not_found"} satisfies ExternalContributionImportResult as ExternalContributionImportResult;
    const decision = contributionImportDecision(current, input);
    if (decision.kind === "unchanged") return {status: "unchanged", workflowId: current.workflowId, revision: current.revision} satisfies ExternalContributionImportResult as ExternalContributionImportResult;
    if (decision.kind === "rejected") return {status: "rejected", code: decision.code} satisfies ExternalContributionImportResult as ExternalContributionImportResult;
    const {existing, node} = decision;

    const entry: ExternalContribution = {contributionId: input.contributionId, nodeId: input.nodeId, state: input.state, revision: input.revision,
      summary: input.summary, references: input.references.map(item => ({kind: item.kind, value: item.value})), externalRef: input.externalRef,
      sourceThreadId: input.sourceThreadId, sourceRunId: input.sourceRunId, sourceMessageId: input.sourceMessageId, recordedAt: at, assessment: null};
    const evidence = yield* makeEvidence({operationId: `contribution:${fingerprint([input.contributionId, input.revision])}`, owner, kind: "contribution_recorded", now: at,
      targetNodeId: validNodeId(input.nodeId) ? input.nodeId : null, targetNodeName: node?.name ?? null, statusFrom: null, statusTo: null,
      sourceThreadId: input.sourceThreadId, sourceRunId: input.sourceRunId, sourceMessageId: input.sourceMessageId, agreementKey: null,
      note: `The main reported external contribution ${input.contributionId} revision ${input.revision} as ${input.state}; this is untrusted evidence, not observed execution.`,
      contribution: {contributionId: input.contributionId, revision: input.revision, state: input.state, decision: null}});
    const next: WorkflowStateDocument = {...current, revision: current.revision + 1,
      contributions: existing ? current.contributions.map(item => item.contributionId === entry.contributionId ? entry : item) : [...current.contributions, entry],
      evidence: [...current.evidence, evidence], updatedAt: at};
    const serialized = json(next);
    if (!documentFits(serialized)) return {status: "rejected", code: "contribution_capacity"} satisfies ExternalContributionImportResult as ExternalContributionImportResult;
    if (!(yield* casUpdate(owner, next.workflowId, next.revision, serialized, at, row.revision)))
      return {status: "conflict", reason: "revision", currentRevision: yield* currentRevision(owner, next.workflowId)} satisfies ExternalContributionImportResult as ExternalContributionImportResult;
    return workflowReceipt("applied", evidence.operationId, next);
  }));

  /** Records the owning root's assessment of one exact result revision without changing any status; joins the caller's transaction. */
  const assessContribution = (owner: WorkflowOwner, input: WorkflowContributionAssessmentInput, now?: number) => write(Effect.gen(function* () {
    const operationId = isRecord(input) && validId(input.operationId) ? input.operationId : "";
    if (!validContributionAssessmentInput(input)) return {status: "invalid", operationId, reason: "invalid_contribution_assessment"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const at = yield* nowOr(now);
    if (!(yield* currentOwner(owner))) return {status: "owner_mismatch", operationId} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const requestHash = requestFingerprint({kind: "assess-contribution", owner, input});
    const replay = yield* operationReplay(owner, "edit", operationId, requestHash);
    if (replay) return replay;
    const row = yield* workflowById(owner, input.workflowId);
    if (!row) return {status: "not_found", operationId} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const decoded = classifyWorkflowRow(row);
    if (decoded.status === "incompatible") return {...decoded, operationId};
    const current = decoded.document;
    if (current.threadId !== owner.mainThreadId || current.parentWorkflowId !== null)
      return {status: "invalid", operationId, reason: "contribution_main_workflow_only"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    if (current.revision !== input.expectedRevision) return {status: "conflict", operationId, reason: "revision", currentRevision: current.revision} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const contribution = current.contributions.find(item => item.contributionId === input.contributionId);
    if (!contribution) return {status: "invalid", operationId, reason: "contribution_not_found"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    if (contribution.revision !== input.resultRevision)
      return {status: "conflict", operationId, reason: "contribution_result_stale", currentRevision: current.revision} satisfies WorkflowMutationResult as WorkflowMutationResult;
    if (contribution.state !== "result") return {status: "invalid", operationId, reason: "contribution_not_a_result"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    if (current.evidence.length >= workflowMutationLimits.maxEvidence) return {status: "invalid", operationId, reason: "evidence_capacity"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const node = collectPlanEntities(current.plan).find(item => item.nodeId === contribution.nodeId) ?? null;
    const evidence = yield* makeEvidence({operationId, owner, kind: "contribution_assessed", now: at,
      targetNodeId: validNodeId(contribution.nodeId) ? contribution.nodeId : null, targetNodeName: node?.name ?? null, statusFrom: null, statusTo: null,
      sourceThreadId: contribution.sourceThreadId, sourceRunId: contribution.sourceRunId, sourceMessageId: contribution.sourceMessageId,
      agreementKey: null, note: input.note,
      contribution: {contributionId: contribution.contributionId, revision: contribution.revision, state: contribution.state, decision: input.decision}});
    const assessed: ExternalContribution = {...contribution, assessment: {decision: input.decision, resultRevision: input.resultRevision, note: input.note,
      actorSupervisorThreadId: owner.supervisorThreadId, evidenceId: evidence.id, recordedAt: at}};
    const next: WorkflowStateDocument = {...current, revision: current.revision + 1,
      contributions: current.contributions.map(item => item.contributionId === assessed.contributionId ? assessed : item),
      evidence: [...current.evidence, evidence], updatedAt: at};
    const serialized = json(next);
    if (!documentFits(serialized)) return {status: "invalid", operationId, reason: "document_capacity"} satisfies WorkflowMutationResult as WorkflowMutationResult;
    if (!(yield* casUpdate(owner, current.workflowId, next.revision, serialized, at, input.expectedRevision)))
      return {status: "conflict", operationId, reason: "revision", currentRevision: yield* currentRevision(owner, current.workflowId)} satisfies WorkflowMutationResult as WorkflowMutationResult;
    const receipt = workflowReceipt("applied", operationId, next);
    yield* recordOperation(owner, "edit", operationId, requestHash, receipt, at);
    return receipt;
  }));

  // acquisition: the workflow schema, statement for statement as the baseline constructor wrote it
  yield* run(Effect.gen(function* () {
    yield* sql.unsafe("CREATE TABLE IF NOT EXISTS supervisor_workflow_state (" +
      "workflow_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,thread_id TEXT NOT NULL," +
      "parent_workflow_id TEXT,parent_thread_id TEXT,revision INTEGER NOT NULL,document TEXT NOT NULL," +
      "created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(project_id,main_thread_id,thread_id))");
    yield* sql.unsafe("CREATE INDEX IF NOT EXISTS supervisor_workflow_scope ON supervisor_workflow_state(project_id,main_thread_id)");
    yield* sql.unsafe("CREATE TABLE IF NOT EXISTS supervisor_workflow_operations (" +
      "project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,actor_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL," +
      "operation_namespace TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,workflow_id TEXT NOT NULL," +
      "created_at INTEGER NOT NULL,PRIMARY KEY(project_id,main_thread_id,actor_thread_id,binding_generation,operation_namespace,operation_id))");
  }));

  return {get, getState, getByIdForOwner, listResult, list, hasNeedsAttention, apply, ensureMain, linkChild, importAcceptedAgreement,
    recordContribution, assessContribution} satisfies WorkflowStateStoreShape;
});

// effect/sql spans carry statement text, so the construction and every operation run untraced
export class WorkflowStateStore extends Context.Service<WorkflowStateStore, WorkflowStateStoreShape>()("t3-supervisor/WorkflowStateStore") {
  /** The store whose owner check reads the project's effective enable state. */
  static readonly layer: Layer.Layer<WorkflowStateStore, WorkflowStateStoreError | ProjectSupervisorStoreError, GuidanceDb | SupervisorIds | ProjectSupervisorStore> =
    Layer.effect(WorkflowStateStore, untracedSql(makeWorkflowStateStore()));
  /** The store whose owner check reads the given workflow-editing predicate (the supervision scope's). */
  static readonly layerWith = (isEnabled: WorkflowEditingEnabled): Layer.Layer<WorkflowStateStore, WorkflowStateStoreError | ProjectSupervisorStoreError, GuidanceDb | SupervisorIds | ProjectSupervisorStore> =>
    Layer.effect(WorkflowStateStore, untracedSql(makeWorkflowStateStore(isEnabled)));
}

/**
 * The rollout scan of the workflow state tables (read only): a state row whose columns do not decode, or an operation row, is a
 * failure of the call that reads it; a state document or a stored receipt the store classifies incompatible is reported as
 * such (its readers answer `incompatible` for it, as at baseline). The open adds the tables when they are missing.
 */
export const checkWorkflowStateRows: Effect.Effect<StoredRowScan, SqlError.SqlError | GuidanceStoreError, GuidanceDb> = Effect.gen(function* () {
  const sql = yield* GuidanceDb;
  const changes = [...yield* schemaChanges(sql, "supervisor_workflow_state"), ...yield* schemaChanges(sql, "supervisor_workflow_operations")];
  const states = yield* rowsOf(sql, "supervisor_workflow_state", `SELECT ${workflowColumns} FROM supervisor_workflow_state`);
  const operations = yield* rowsOf(sql, "supervisor_workflow_operations", "SELECT project_id,main_thread_id,operation_namespace,operation_id,request_hash,result FROM supervisor_workflow_operations");
  const stateKey = (row: Record<string, unknown>) => rowKey(row, ["workflow_id"]);
  const operationKey = (row: Record<string, unknown>) => rowKey(row, ["project_id", "main_thread_id", "operation_namespace", "operation_id"]);
  const findings = [
    ...yield* rowFindings(states, {table: "supervisor_workflow_state", kind: "workflow state", problem: "undecodable", read: "call"}, stateKey, decodeWorkflowRow),
    ...yield* rowFindings(states, {table: "supervisor_workflow_state", kind: "workflow state", problem: "incompatible", read: "call"}, stateKey,
      (row) => Effect.flatMap(Effect.option(decodeWorkflowRow(row)), (decoded) =>
        decoded._tag === "Some" && classifyWorkflowRow(decoded.value).status === "incompatible" ? Effect.fail("incompatible") : Effect.void)),
    ...yield* rowFindings(operations, {table: "supervisor_workflow_operations", kind: "operation", problem: "undecodable", read: "call"}, operationKey, decodeOperationRow),
    ...yield* rowFindings(operations, {table: "supervisor_workflow_operations", kind: "operation receipt", problem: "incompatible", read: "call"}, operationKey,
      (row) => Effect.flatMap(Effect.option(decodeOperationRow(row)), (decoded) =>
        decoded._tag === "Some" && classifyReceipt(String(row.operation_id), decoded.value.result).status === "incompatible" ? Effect.fail("incompatible") : Effect.void)),
  ];
  return {findings, changes};
});
