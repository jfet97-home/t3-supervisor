import { fingerprint } from "./guidance-store.js";
import { record } from "./supervisor-native.js";
import { validateWorkflowPlan, type ProposalContext } from "./supervisor-workflow.js";
import type { WorkflowProposalInfo } from "./project-supervisor-contract.js";

export type WorkflowAgreementRecordKind = "workflow-proposal" | "workflow-acceptance";
export type NormalizedWorkflowPlan = Pick<WorkflowProposalInfo, "rules" | "steps">;
export type ParsedWorkflowAgreementRecord = {
  taskId: string;
  proposalId: string;
  workspaceRoot: string;
  revision: string;
  workflow: NormalizedWorkflowPlan;
};

const proposalIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const recordFields = ["taskId", "proposalId", "workspaceRoot", "revision", "workflow"];

/** Extracts bounded named fences without accepting prose or a bare confirmation. */
export const extractWorkflowAgreementRecords = (text: string, kind: WorkflowAgreementRecordKind): unknown[] => {
  if (text.length > 128_000) return [];
  const lines = text.split(/\r?\n/u);
  const records: unknown[] = [];
  for (let index = 0; index < lines.length && records.length < 20; index++) {
    if (!/^ {0,3}```workflow-(?:proposal|acceptance)[ \t]*$/u.test(lines[index]!)) continue;
    if (lines[index]!.trim() !== "```" + kind) continue;
    const body: string[] = [];
    let bodyLength = 0;
    let closed = false;
    for (index++; index < lines.length; index++) {
      if (/^ {0,3}```[ \t]*$/u.test(lines[index]!)) {closed = true; break;}
      body.push(lines[index]!);
      bodyLength += lines[index]!.length + 1;
      if (bodyLength > 128_000) break;
    }
    if (!closed) continue;
    try {records.push(JSON.parse(body.join("\n")) as unknown);} catch { /* malformed records are ignored */ }
  }
  return records;
};

/** Validates the complete task identity and definition-backed plan in one record. */
export const parseWorkflowAgreementRecord = (
  value: unknown,
  taskId: string,
  workspaceRoot: string,
  revision: string,
  context: ProposalContext,
  requiredRuleIndexes: ReadonlySet<number>,
): ParsedWorkflowAgreementRecord | null => {
  if (!record(value) || Object.keys(value).length !== recordFields.length || recordFields.some(field => !Object.hasOwn(value, field)) ||
    value.taskId !== taskId || typeof value.proposalId !== "string" || !proposalIdPattern.test(value.proposalId) ||
    value.workspaceRoot !== workspaceRoot || value.workspaceRoot !== context.workspaceRoot ||
    value.revision !== revision || value.revision !== context.revision) return null;
  const workflow = validateWorkflowPlan(value.workflow, context, requiredRuleIndexes);
  return workflow ? {taskId, proposalId: value.proposalId, workspaceRoot, revision, workflow} : null;
};

export const workflowAgreementPlanHash = (recordValue: Pick<ParsedWorkflowAgreementRecord, "workspaceRoot" | "revision" | "workflow">): string =>
  fingerprint({workspaceRoot: recordValue.workspaceRoot, revision: recordValue.revision, workflow: recordValue.workflow});

export const workflowPlanValue = (workflow: NormalizedWorkflowPlan): NormalizedWorkflowPlan => ({rules: workflow.rules, steps: workflow.steps});
