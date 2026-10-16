import { fingerprint } from "./guidance-store.js";
import { validateWorkflowRecord, workflowRecordDiagnostic, workflowRecordDiagnosticCodes, type ProposalContext, type WorkflowPlanValue } from "./supervisor-workflow.js";
import type { WorkflowPlanGroupInfo } from "./project-supervisor-contract.js";

export type WorkflowAgreementRecordKind = "workflow-proposal" | "workflow-acceptance";
export type ParsedWorkflowProposalRecord = {
  taskId: string;
  proposalId: string;
  workspaceRoot: string;
  revision: string | null;
  workflow: WorkflowPlanValue;
};
export type ParsedWorkflowAgreementRecord = ParsedWorkflowProposalRecord & {revision: string};

const maxRecordLength = 128_000;
const maxRecords = 20;
const idText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactFields = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

export const workflowProtocolDiagnosticCodes = ["record_json_invalid", "task_mismatch", "plan_not_formal", ...workflowRecordDiagnosticCodes] as const;
export type WorkflowProtocolDiagnosticCode = typeof workflowProtocolDiagnosticCodes[number];

/** Reads only exact named proposal or acceptance fences from completed message text. */
export const extractWorkflowAgreementRecords = (text: string, kind: WorkflowAgreementRecordKind): unknown[] => {
  if (text.length > maxRecordLength) return [];
  const values: unknown[] = [];
  const pattern = /```(workflow-proposal|workflow-acceptance)\r?\n([\s\S]*?)\r?\n```/gu;
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== kind || values.length >= maxRecords || match[2]!.length > maxRecordLength) continue;
    try {values.push(JSON.parse(match[2]!));} catch { /* malformed fenced records are ignored */ }
  }
  return values;
};

const parseProposal = (value: unknown, taskId: string, context: ProposalContext): ParsedWorkflowProposalRecord | null => {
  if (!record(value) || !exactFields(value, ["taskId", "proposalId", "workspaceRoot", "revision", "workflow"]) ||
    value.taskId !== taskId || !idText(value.proposalId) || value.workspaceRoot !== context.workspaceRoot ||
    !(value.revision === null || typeof value.revision === "string") || value.revision !== context.revision ||
    typeof value.workspaceRoot !== "string" || value.workspaceRoot.length > 4096) return null;
  const workflow = validateWorkflowRecord(value.workflow, context);
  if (!workflow) return null;
  return {taskId, proposalId: value.proposalId, workspaceRoot: value.workspaceRoot, revision: value.revision, workflow};
};

/** Validates a canonical proposal for presentation, including provisional source states. */
export const parseWorkflowProposalRecord = (value: unknown, taskId: string, context: ProposalContext): ParsedWorkflowProposalRecord | null =>
  parseProposal(value, taskId, context);

export const diagnoseWorkflowProposalRecord = (value: unknown, taskId: string, context: ProposalContext, requireFormal = false): string | null => {
  try {
    if (!record(value) || !exactFields(value, ["taskId", "proposalId", "workspaceRoot", "revision", "workflow"])) return "record_fields";
    if (value.taskId !== taskId) return "task_mismatch";
    if (!idText(value.proposalId) || typeof value.workspaceRoot !== "string" || value.workspaceRoot.length > 4096 ||
      !(value.revision === null || typeof value.revision === "string")) return "record_fields";
    if (value.workspaceRoot !== context.workspaceRoot || value.revision !== context.revision) return "source_pin_mismatch";
    const workflowDiagnostic = workflowRecordDiagnostic(value.workflow, context);
    if (workflowDiagnostic) return workflowDiagnostic;
    if (requireFormal && !parseWorkflowAgreementRecord(value, taskId, context)) return "plan_not_formal";
    return null;
  } catch {
    return "invalid";
  }
};

const fullyResolvedPlan = (workflow: WorkflowPlanValue): boolean => {
  if (!workflow.plan || !workflow.requirementsKnown || workflow.requirements.some(item => item.state === "unknown" || item.state === "unresolved")) return false;
  if (workflow.issues.some(item => ["definition_context_incomplete", "supervisor_context_limit", "workflow_cycle_in_plan",
    "workflow_cycle_in_definition", "fixed_workflow_changed", "workflow_member_unresolved", "unresolved_project_requirement",
    "unresolved_step_reference", "unresolved_workflow_reference"].includes(item.code))) return false;
  const walk = (group: WorkflowPlanGroupInfo): boolean => group.nodes.every(node => {
    switch (node.kind) {
      case "sequence":
      case "parallel": return walk(node);
      case "step": return node.resolution === "resolved";
      case "workflow": return node.resolution === "resolved" && node.fixed !== null && node.plan !== null && walk(node.plan);
    }
  });
  return walk(workflow.plan);
};

/** Parses only current complete valid agreements; invalid or incomplete definitions stay provisional. */
export const parseWorkflowAgreementRecord = (value: unknown, taskId: string, context: ProposalContext): ParsedWorkflowAgreementRecord | null => {
  const proposal = parseProposal(value, taskId, context);
  if (!proposal || context.status !== "ready" || !context.complete || !context.revision ||
    proposal.workflow.definitionsStatus !== "ready" || !proposal.workflow.definitionsComplete || !fullyResolvedPlan(proposal.workflow)) return null;
  return {...proposal, revision: context.revision};
};

/** Hashes the exact source-bound canonical record, retaining node identity and group order. */
export const workflowAgreementPlanHash = (value: Pick<ParsedWorkflowProposalRecord, "workspaceRoot" | "revision" | "workflow">): string =>
  fingerprint({workspaceRoot: value.workspaceRoot, revision: value.revision, workflow: value.workflow});
