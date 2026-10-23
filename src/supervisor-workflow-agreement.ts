import { Exit, Schema } from "effect";
import { fingerprint } from "./guidance-store.js";
import { canonicalizeProposalDraft, validateWorkflowRecord, workflowRecordDiagnostic, workflowRecordDiagnosticCodes, type ProposalContext, type WorkflowPlanValue } from "./supervisor-workflow.js";
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

export const workflowProtocolDiagnosticCodes = ["record_json_invalid", "task_mismatch", "plan_not_formal", "task_revision_mismatch", "draft_invalid",
  "proposal_reference_unknown", "acceptance_proposal_unknown", "acceptance_digest_mismatch", "objective_source_invalid", "proposal_id_conflict",
  "legacy_record_format", ...workflowRecordDiagnosticCodes] as const;
export type WorkflowProtocolDiagnosticCode = typeof workflowProtocolDiagnosticCodes[number];

export type ExactFenceRecord = {value: unknown | null; malformedJson: boolean; lineCount: number};
// a record body is model output: decoded as JSON here, its shape is checked by the record parsers
const decodeRecordJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
// reads only top-level fences of exactly one kind; quoted, indented and nested copies are ignored. With enclosingFences, any
// run of three or more backticks or tildes indented by at most three spaces encloses everything up to a bare run of the
// same character at least as long, and an unclosed one leaves the rest of the message inert
export const exactFenceRecords = (text: string, kind: string, maxRecords: number, enclosingFences = false): ExactFenceRecord[] => {
  if (text.length > maxRecordLength) return [];
  const lines = text.split(/\r?\n/u);
  const values: ExactFenceRecord[] = [];
  let inOtherFence = false;
  let enclosing: string | null = null;
  for (let index = 0; index < lines.length && values.length < maxRecords; index++) {
    const line = lines[index]!;
    if (enclosing !== null) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line)?.[1];
      if (closing && closing[0] === enclosing[0] && closing.length >= enclosing.length) enclosing = null;
      continue;
    }
    if (inOtherFence) {
      if (line === "```") inOtherFence = false;
      continue;
    }
    if (enclosingFences && line !== "```" + kind) {
      // an enclosing block may be indented by up to three spaces; a backtick info string never holds a backtick
      const opening = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/u.exec(line);
      if (opening) {enclosing = opening[1] ?? opening[2]!;continue;}
    }
    if (line.startsWith(">") || line.startsWith(" ") || line.startsWith("\t")) continue;
    if (line === "```" + kind) {
      const recordLines: string[] = [];
      let length = 0;
      while (++index < lines.length && lines[index] !== "```") {
        const recordLine = lines[index]!;
        length += recordLine.length + 1;
        if (length > maxRecordLength) break;
        recordLines.push(recordLine);
      }
      if (length <= maxRecordLength && lines[index] === "```") {
        const decoded = decodeRecordJson(recordLines.join("\n"));
        values.push(Exit.isSuccess(decoded) ? {value: decoded.value, malformedJson: false, lineCount: recordLines.length}
          : {value: null, malformedJson: true, lineCount: recordLines.length});
      }
      continue;
    }
    if (!enclosingFences && (line === "```" || /^```[^`]+$/u.test(line))) inOtherFence = true;
  }
  return values;
};

/** Reads only exact top-level proposal or acceptance fences; quoted, indented and enclosed copies are ignored. */
export const extractWorkflowAgreementRecords = (text: string, kind: WorkflowAgreementRecordKind): unknown[] =>
  exactFenceRecords(text, kind, maxRecords, true).flatMap(item => item.malformedJson ? [] : [item.value]);

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

/** Exact native binding the author observed: the task source revision and the definition revision it read. */
export type CompactProposalPins = {taskId: string; taskRevision: string};
export type CompactProposal = ParsedWorkflowProposalRecord & {digest: string; formal: boolean;
  objective: {text: string; sourceMessageIds: string[]} | null};
export type CompactProposalResult =
  | {ok: true; proposal: CompactProposal}
  | {ok: false; code: string; proposalId: string | null; path: string | null; expected: string | null; detail: string | null};
export type StoredProposalDigest = {proposalId: string; digest: string; workspaceRoot: string; revision: string | null; workflow: WorkflowPlanValue};

/** Immutable identity of one service-canonicalized proposal: task source revision, definition pins and the whole canonical plan. */
export const compactProposalDigest = (pins: CompactProposalPins, value: Pick<ParsedWorkflowProposalRecord, "workspaceRoot" | "revision" | "workflow">): string =>
  fingerprint({taskId: pins.taskId, taskRevision: pins.taskRevision, workspaceRoot: value.workspaceRoot, revision: value.revision, workflow: value.workflow});

const formalRecord = (workflow: WorkflowPlanValue, context: ProposalContext): boolean =>
  context.status === "ready" && context.complete && Boolean(context.revision) && workflow.definitionsStatus === "ready" &&
  workflow.definitionsComplete && fullyResolvedPlan(workflow);
const failure = (code: string, proposalId: unknown, path: string | null = null, expected: string | null = null, detail: string | null = null): CompactProposalResult =>
  ({ok: false, code, proposalId: idText(proposalId) ? proposalId.slice(0, 200) : null, path, expected, detail});
const objectiveValue = (value: unknown): {text: string; sourceMessageIds: string[]} | null | false => {
  if (value === undefined) return null;
  if (!record(value) || !exactFields(value, ["text", "sourceMessageIds"]) || typeof value.text !== "string" || !value.text.trim() ||
    value.text.length > 2_000 || !Array.isArray(value.sourceMessageIds) || value.sourceMessageIds.length < 1 || value.sourceMessageIds.length > 20 ||
    !value.sourceMessageIds.every(idText)) return false;
  return {text: value.text.trim(), sourceMessageIds: [...new Set(value.sourceMessageIds as string[])]};
};

/**
 * Resolves the compact chat protocol. A Supervisor draft names the task revision and definition revision it was authored
 * against; the service derives workspace and provenance from the trusted context and canonicalizes deterministically. A
 * reference names a service-prepared proposal or a stored immutable candidate by its digest.
 */
export const resolveCompactProposal = (value: unknown, pins: CompactProposalPins, context: ProposalContext,
  known: (proposalId: string) => StoredProposalDigest | null): CompactProposalResult => {
  if (!record(value)) return failure("record_fields", null);
  if (value.taskId !== pins.taskId) return failure("task_mismatch", value.proposalId);
  if (exactFields(value, ["taskId", "proposalId", "digest"])) {
    if (!idText(value.proposalId) || typeof value.digest !== "string") return failure("record_fields", value.proposalId);
    const stored = known(value.proposalId);
    if (!stored || stored.digest !== value.digest) return failure("proposal_reference_unknown", value.proposalId, "/digest", "the digest of a service-prepared or stored proposal");
    return {ok: true, proposal: {taskId: pins.taskId, proposalId: stored.proposalId, workspaceRoot: stored.workspaceRoot, revision: stored.revision,
      workflow: stored.workflow, digest: stored.digest, formal: formalRecord(stored.workflow, context), objective: null}};
  }
  const draftFields = ["taskId", "taskRevision", "proposalId", "revision", "draft"];
  if (!(exactFields(value, draftFields) || exactFields(value, [...draftFields, "objective"])))
    return failure("record_fields", value.proposalId, "/", "exactly taskId, taskRevision, proposalId, revision, draft and optional objective");
  if (!idText(value.proposalId)) return failure("record_fields", value.proposalId, "/proposalId", "a stable proposal ID of at most 512 characters");
  if (value.taskRevision !== pins.taskRevision) return failure("task_revision_mismatch", value.proposalId, "/taskRevision", pins.taskRevision);
  if (value.revision !== context.revision) return failure("source_pin_mismatch", value.proposalId, "/revision", String(context.revision));
  const objective = objectiveValue(value.objective);
  if (objective === false) return failure("record_fields", value.proposalId, "/objective", "{text, sourceMessageIds:[user message IDs]}");
  const canonical = canonicalizeProposalDraft(value.draft, context, `${pins.taskId}\0${pins.taskRevision}\0${value.proposalId}`);
  if (!canonical.ok) return failure("draft_invalid", value.proposalId, canonical.path, canonical.expected, canonical.code);
  const proposal = {taskId: pins.taskId, proposalId: value.proposalId, workspaceRoot: context.workspaceRoot, revision: context.revision, workflow: canonical.workflow};
  return {ok: true, proposal: {...proposal, digest: compactProposalDigest(pins, proposal), formal: formalRecord(canonical.workflow, context), objective}};
};

/** An operative acceptance is exactly {taskId, proposalId, digest} naming one stored immutable candidate. */
export const resolveCompactAcceptance = (value: unknown, taskId: string, known: (proposalId: string) => {digest: string} | null):
  {ok: true; proposalId: string; digest: string} | {ok: false; code: string; proposalId: string | null} => {
  if (!record(value) || !exactFields(value, ["taskId", "proposalId", "digest"]) || !idText(value.proposalId) || typeof value.digest !== "string")
    return {ok: false, code: "record_fields", proposalId: record(value) && idText(value.proposalId) ? value.proposalId : null};
  if (value.taskId !== taskId) return {ok: false, code: "task_mismatch", proposalId: value.proposalId};
  const stored = known(value.proposalId);
  if (!stored) return {ok: false, code: "acceptance_proposal_unknown", proposalId: value.proposalId};
  if (stored.digest !== value.digest) return {ok: false, code: "acceptance_digest_mismatch", proposalId: value.proposalId};
  return {ok: true, proposalId: value.proposalId, digest: value.digest};
};
