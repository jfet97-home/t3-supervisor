import { Data, Effect, Schema, type SchemaAST, type SchemaIssue } from "effect";
import { canonicalJson } from "./canonical-json.js";
import type { LogFields } from "./logging.js";
import { WorkflowProposal } from "./project-supervisor-contract.js";
import {
  interpretationFromFields,
  interpretationLimits,
  seededNodeIds,
  workflowInterpretationOutcome,
  type NodeIds,
  type ProposalContext,
} from "./supervisor-workflow.js";
import type { Projection } from "./types.js";
import { isRecord, verifyWorkflowToolEvidence, workflowRequestHash, workflowToolInputMaxBytes } from "./workflow-write-evidence.js";
import { workflowMutationLimits } from "./workflow-state-contract.js";

// the typed interpretation submission's store-independent parts (plan 3.12 items 1-4 and 6): attempt identity, the exact
// arguments schema, the strict decode with the raw canonical hash, the native proof verifier and the redacted result codes

export const interpretationSubmitToolName = "supervision_interpretation_submit";

// diagnostics: a fixed code and a path of known argument keys and indices, never an input value

export const interpretationIssueCodes = [
  "missing_key", "unexpected_key", "invalid_type", "invalid_value", "too_long", "invalid_format", "not_integer", "too_small", "blank",
  "no_match", "ambiguous", "forbidden",
  "arguments_not_object", "arguments_not_json", "arguments_too_deep", "arguments_too_large", "plan_node_limit",
  "objective_empty", "source_message_ids_mismatch", "not_needed_workflow_present", "attempt_pin_mismatch",
] as const;
export type InterpretationIssueCode = typeof interpretationIssueCodes[number];
export type InterpretationIssue = {readonly code: InterpretationIssueCode; readonly path: string};

const maxIssues = 20;
const maxPathLength = 256;

// the issue code of each check this module builds, looked up by the failed filter itself
const filterCodes = new Map<unknown, InterpretationIssueCode>();
const coded = <C>(check: C, code: InterpretationIssueCode): C => {
  filterCodes.set(check, code);
  return check;
};
const maxLength = (max: number) => coded(Schema.isMaxLength(max), "too_long");
const nonBlank = coded(Schema.makeFilter((value: string) => value.trim().length > 0, {expected: "a non-blank string"}), "blank");
const sha256Pattern = coded(Schema.isPattern(/^[0-9a-f]{64}$/u), "invalid_format");
const attemptIdPattern = /^interpretation-attempt:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const attemptIdFormat = coded(Schema.isPattern(attemptIdPattern), "invalid_format");
const nonNegative = coded(Schema.isGreaterThanOrEqualTo(0), "too_small");

// every key a submission may name; any other key in a path (an unexpected one) is written as *
const knownPathKeys = new Set([
  "supervisorThreadId", "bindingGeneration", "taskId", "attemptId", "sourcePin", "messageId", "runId", "ordinal", "hash",
  "objective", "reason", "sourceMessageIds", "supervision", "workflow", "startRequested", "requirements", "plan", "kind", "id",
  "applies", "nodes", "definitionId", "localId", "name", "description", "references",
]);
const pathOf = (segments: ReadonlyArray<PropertyKey>): string => {
  let path = "";
  for (const segment of segments) {
    const part = `/${typeof segment === "number" ? String(segment) :
      typeof segment === "string" && (knownPathKeys.has(segment) || /^(?:0|[1-9][0-9]{0,5})$/u.test(segment)) ? segment : "*"}`;
    // a path beyond the bound keeps its leading segments and ends in /*
    if (path.length + part.length > maxPathLength - 2) return `${path}/*`;
    path += part;
  }
  return path;
};

const schemaIssueCode = (issue: SchemaIssue.Leaf): InterpretationIssueCode => {
  switch (issue._tag) {
    case "MissingKey": return "missing_key";
    case "UnexpectedKey": return "unexpected_key";
    case "InvalidType": return "invalid_type";
    case "InvalidValue": return "invalid_value";
    case "Forbidden": return "forbidden";
    case "OneOf": return "ambiguous";
  }
};

const collectIssues = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>, issues: Array<InterpretationIssue>): void => {
  if (issues.length >= maxIssues) return;
  const add = (code: InterpretationIssueCode) => {
    const entry = {code, path: pathOf(path)};
    if (!issues.some(item => item.code === entry.code && item.path === entry.path)) issues.push(entry);
  };
  switch (issue._tag) {
    case "Pointer": return collectIssues(issue.issue, [...path, ...issue.path], issues);
    case "Encoding": return collectIssues(issue.issue, path, issues);
    case "Filter": return add(filterCodes.get(issue.filter) ?? "invalid_value");
    case "Composite":
      for (const child of issue.issues) collectIssues(child, path, issues);
      return;
    case "AnyOf":
      if (issue.issues.length === 0) return add("no_match");
      for (const child of issue.issues) collectIssues(child, path, issues);
      return;
    default: return add(schemaIssueCode(issue));
  }
};

// the redacted issue list of a Schema failure: codes and paths of known keys only
export const interpretationSchemaIssues = (issue: SchemaIssue.Issue): ReadonlyArray<InterpretationIssue> => {
  const issues: Array<InterpretationIssue> = [];
  collectIssues(issue, [], issues);
  return issues;
};

// attempt identity (item 1)

const ToolId = Schema.String.check(maxLength(workflowMutationLimits.maxOperationIdLength), nonBlank);
const Sha256 = Schema.String.check(sha256Pattern);
const Count = Schema.Number.check(coded(Schema.isInt(), "not_integer"), nonNegative);

// the task's source revision a submission is pinned to: the genuine human message, its run and ordinal, and its text hash
export const InterpretationSourcePin = Schema.Struct({messageId: ToolId, runId: ToolId, ordinal: Count, hash: Sha256});
export type InterpretationSourcePin = typeof InterpretationSourcePin.Type;

// the immutable key of one interpretation attempt; the task ID alone never identifies an attempt
export const InterpretationAttemptKey = Schema.Struct({
  bindingGeneration: Count,
  taskId: ToolId,
  source: InterpretationSourcePin,
  requestMessageId: ToolId,
  requestTextHash: Sha256,
});
export type InterpretationAttemptKey = typeof InterpretationAttemptKey.Type;

export const InterpretationAttemptId = Schema.String.check(attemptIdFormat);
// the task's pointer to its current attempt: the minted opaque ID and the key it was minted for
export const InterpretationAttempt = Schema.Struct({attemptId: InterpretationAttemptId, key: InterpretationAttemptKey});
export type InterpretationAttempt = typeof InterpretationAttempt.Type;

// the hash a persisted text is pinned by: sha256 of its JSON string, the same value as the stores' text fingerprint
export const interpretationTextHash = (text: string): string => workflowRequestHash(text);

// the source pin of a task's current source revision
export const interpretationSourcePin = (task: {readonly sourceMessageId: string; readonly sourceRunId: string; readonly sourceOrdinal: number;
  readonly sourceHash: string}): InterpretationSourcePin =>
  ({messageId: task.sourceMessageId, runId: task.sourceRunId, ordinal: task.sourceOrdinal, hash: task.sourceHash});

// the attempt key of a built interpretation request: binding generation, task, source revision and the request message and text
export const interpretationAttemptKey = (input: {
  readonly bindingGeneration: number;
  readonly task: {readonly id: string; readonly sourceMessageId: string; readonly sourceRunId: string; readonly sourceOrdinal: number; readonly sourceHash: string};
  readonly requestMessageId: string;
  readonly requestText: string;
}): InterpretationAttemptKey => ({bindingGeneration: input.bindingGeneration, taskId: input.task.id, source: interpretationSourcePin(input.task),
  requestMessageId: input.requestMessageId, requestTextHash: interpretationTextHash(input.requestText)});

export const sameInterpretationAttemptKey = (left: InterpretationAttemptKey, right: InterpretationAttemptKey): boolean =>
  canonicalJson(left) === canonicalJson(right);

// the attempt ID for a freshly minted SupervisorIds uuid; nothing of the key is derived into it
export const interpretationAttemptId = (uuid: string): string => `interpretation-attempt:${uuid}`;

// the retained attempt when an identical request is replayed under the same key; null when a new attempt must be minted
export const retainedInterpretationAttempt = (current: InterpretationAttempt | null | undefined, key: InterpretationAttemptKey): InterpretationAttempt | null =>
  current && sameInterpretationAttemptKey(current.key, key) ? current : null;

// arguments (item 2): no target thread, run, dispatch mode, delivery body, model or provider, acceptance or callback field

// a model-authored plan node: a reusable step, a task-local step, a workflow reference or a nested group
export type InterpretationPlanNode =
  | {readonly kind: "step"; readonly definitionId: string; readonly reason: string}
  | {readonly kind: "step"; readonly definitionId: null; readonly localId: string; readonly name: string; readonly description: string;
    readonly reason: string; readonly references?: ReadonlyArray<string>}
  | {readonly kind: "workflow"; readonly definitionId: string; readonly reason: string}
  | InterpretationPlanGroup;
export type InterpretationPlanGroup = {readonly kind: "sequence" | "parallel"; readonly nodes: ReadonlyArray<InterpretationPlanNode>};

const limits = interpretationLimits;
const DefinitionId = Schema.String.check(maxLength(limits.maxDefinitionIdLength));
const Reason = Schema.String.check(maxLength(limits.maxReasonLength));
const PlanText = Schema.String.check(maxLength(limits.maxPlanTextLength));
const PlanNode: Schema.Codec<InterpretationPlanNode> = Schema.suspend((): Schema.Codec<InterpretationPlanNode> => Schema.Union([
  Schema.Struct({kind: Schema.Literal("step"), definitionId: DefinitionId, reason: Reason}),
  Schema.Struct({kind: Schema.Literal("step"), definitionId: Schema.Null, localId: DefinitionId, name: PlanText, description: PlanText, reason: Reason,
    references: Schema.optionalKey(Schema.Array(Schema.String))}),
  Schema.Struct({kind: Schema.Literal("workflow"), definitionId: DefinitionId, reason: Reason}),
  PlanGroup,
]));
const PlanGroup: Schema.Codec<InterpretationPlanGroup> = Schema.Struct({
  kind: Schema.Literals(["sequence", "parallel"]),
  nodes: Schema.Array(PlanNode).check(maxLength(limits.maxExpandedNodes)),
});
const Requirement = Schema.Struct({
  kind: Schema.Literals(["step", "workflow"]),
  id: DefinitionId,
  applies: Schema.Union([Schema.Boolean, Schema.Literal("unknown")]),
  reason: Reason,
});
// the interpretation's semantic plan draft: an assessment of every configured requirement and a finite plan
export const InterpretationWorkflowDraft = Schema.Struct({
  requirements: Schema.Array(Requirement).check(maxLength(limits.maxRequirementAssessments)),
  plan: PlanGroup,
});
export type InterpretationWorkflowDraft = typeof InterpretationWorkflowDraft.Type;

const envelopeFields = {
  supervisorThreadId: ToolId,
  bindingGeneration: Count,
  taskId: ToolId,
  attemptId: InterpretationAttemptId,
  sourcePin: InterpretationSourcePin,
};
const interpretationFields = {
  objective: Schema.NullOr(Schema.String.check(maxLength(limits.maxObjectiveLength))),
  reason: Reason,
  sourceMessageIds: Schema.Array(ToolId).check(maxLength(limits.maxSourceMessageIds)),
};
const workflowFields = {supervision: Schema.Literals(["needed", "not_needed"]), workflow: Schema.NullOr(InterpretationWorkflowDraft)};
const startFields = {startRequested: Schema.Boolean};

// the arguments for each task state: supervision and workflow with a definition context, startRequested for a matching pending Start
export const interpretationArgumentSchemas = {
  plain: Schema.Struct({...envelopeFields, ...interpretationFields}),
  workflow: Schema.Struct({...envelopeFields, ...interpretationFields, ...workflowFields}),
  start: Schema.Struct({...envelopeFields, ...interpretationFields, ...startFields}),
  workflowStart: Schema.Struct({...envelopeFields, ...interpretationFields, ...workflowFields, ...startFields}),
} as const;

// the quoted identity every submission carries; both values are assertions checked against durable state and grant nothing
export type InterpretationEnvelope = {
  readonly supervisorThreadId: string;
  readonly bindingGeneration: number;
  readonly taskId: string;
  readonly attemptId: string;
  readonly sourcePin: InterpretationSourcePin;
};
type DecodedArguments = InterpretationEnvelope & {
  readonly objective: string | null;
  readonly reason: string;
  readonly sourceMessageIds: ReadonlyArray<string>;
  readonly supervision?: "needed" | "not_needed";
  readonly workflow?: InterpretationWorkflowDraft | null;
  readonly startRequested?: boolean;
};

// decode (item 3)

// the immutable decoded result an attempt records: a negative Start verdict, or the semantic interpretation outcome
export const InterpretationPayload = Schema.Union([
  Schema.Struct({kind: Schema.Literal("start_rejected")}),
  Schema.Struct({
    kind: Schema.Literal("interpretation"),
    objective: Schema.NullOr(Schema.String),
    reason: Schema.String,
    supervision: Schema.optionalKey(Schema.Literals(["needed", "not_needed"])),
    workflow: Schema.optionalKey(WorkflowProposal),
    startRequested: Schema.Boolean,
  }),
]);
export type InterpretationPayload = typeof InterpretationPayload.Type;

// one decoded submission: the complete raw argument object with its canonical form and hash, the envelope and the payload
export type InterpretationSubmission = {
  readonly rawArguments: Readonly<Record<string, unknown>>;
  readonly argumentsCanonical: string;
  readonly argumentsHash: string;
  readonly envelope: InterpretationEnvelope;
  readonly payload: InterpretationPayload;
};

// what the task's state makes the arguments: its definition context (or none) and whether it holds a matching pending Start
export type InterpretationDecodeContext = {
  readonly definitionContext: ProposalContext | null;
  readonly pendingStart: boolean;
  // new plan occurrence IDs; by default seeded by the attempt ID, so an identical replay decodes to the same payload
  readonly nodeIds?: NodeIds;
};

export const interpretationInvalidCodes = [
  "arguments_not_object", "arguments_not_json", "arguments_too_deep", "arguments_too_large", "arguments_schema", "plan_node_limit",
  "objective_empty", "source_message_ids_mismatch", "not_needed_workflow_present", "attempt_pin_mismatch",
] as const;
export type InterpretationInvalidCode = typeof interpretationInvalidCodes[number];

// a rejected submission: a fixed code and redacted issues; it carries no argument value, so rendering it leaks none
export class InterpretationArgumentsInvalid extends Data.TaggedError("InterpretationArgumentsInvalid")<{
  readonly code: InterpretationInvalidCode;
  readonly issues: ReadonlyArray<InterpretationIssue>;
}> {
  override get message(): string {return this.code;}
}

const invalid = (code: InterpretationInvalidCode, issues: ReadonlyArray<InterpretationIssue>): InterpretationArgumentsInvalid =>
  new InterpretationArgumentsInvalid({code, issues});
const rootInvalid = (code: InterpretationInvalidCode & InterpretationIssueCode) => invalid(code, [{code, path: ""}]);

const decodeOptions: SchemaAST.ParseOptions = {onExcessProperty: "error", errors: "all"};

type Captured = {readonly ok: true; readonly raw: Readonly<Record<string, unknown>>; readonly canonical: string} |
  {readonly ok: false; readonly code: InterpretationInvalidCode & InterpretationIssueCode};

// the complete raw argument object and its canonical form, before any decode, trimming, redaction or defaulting; the canonical
// form's nesting bound is the depth limit, the old final-reply length and the workflow tool input bytes are the size limits
const captureRaw = (raw: unknown, withDefinitions: boolean): Captured => {
  if (!isRecord(raw)) return {ok: false, code: "arguments_not_object"};
  let canonical: string;
  try {canonical = canonicalJson(raw);} catch (cause) {
    return {ok: false, code: cause instanceof Error && cause.message === "json_depth" ? "arguments_too_deep" : "arguments_not_json"};
  }
  const maxText = withDefinitions ? limits.maxWorkflowInterpretationReplyLength : limits.maxInterpretationReplyLength;
  if (canonical.length > maxText || Buffer.byteLength(canonical, "utf8") > workflowToolInputMaxBytes) return {ok: false, code: "arguments_too_large"};
  return {ok: true, raw, canonical};
};

// submitted groups and leaves, as the plan canonicalization counts them against the shared node limit
const planNodeCount = (group: InterpretationPlanGroup): number =>
  1 + group.nodes.reduce((count, node) => count + (node.kind === "sequence" || node.kind === "parallel" ? planNodeCount(node) : 1), 0);

const schemaFor = (context: InterpretationDecodeContext) => context.definitionContext
  ? context.pendingStart ? interpretationArgumentSchemas.workflowStart : interpretationArgumentSchemas.workflow
  : context.pendingStart ? interpretationArgumentSchemas.start : interpretationArgumentSchemas.plain;

const semanticPayload = (decoded: DecodedArguments, context: InterpretationDecodeContext): InterpretationPayload | InterpretationArgumentsInvalid => {
  const sourceId = decoded.sourcePin.messageId;
  if (decoded.workflow && planNodeCount(decoded.workflow.plan) > limits.maxExpandedNodes)
    return invalid("plan_node_limit", [{code: "plan_node_limit", path: "/workflow/plan"}]);
  if (decoded.startRequested !== undefined) {
    // a pending-Start verdict cites exactly the pinned source whatever the objective; a negative one grants nothing more
    if (decoded.sourceMessageIds.length !== 1 || decoded.sourceMessageIds[0] !== sourceId)
      return invalid("source_message_ids_mismatch", [{code: "source_message_ids_mismatch", path: "/sourceMessageIds"}]);
    if (!decoded.startRequested) return {kind: "start_rejected"};
  }
  const startRequested = decoded.startRequested === true;
  const interpretation = interpretationFromFields(decoded, sourceId);
  if (!interpretation.ok) return invalid(interpretation.code, [{code: interpretation.code, path: interpretation.path}]);
  if (!context.definitionContext) return {kind: "interpretation", ...interpretation.value, startRequested};
  const outcome = workflowInterpretationOutcome(interpretation.value, decoded.supervision, decoded.workflow ?? null, context.definitionContext,
    context.nodeIds ?? seededNodeIds(`t3-supervisor:interpretation:${decoded.attemptId}`));
  if (!outcome.ok) return invalid(outcome.code, [{code: outcome.code, path: outcome.path}]);
  return {kind: "interpretation", ...outcome.value, startRequested};
};

// decodes one submission: the raw object and its canonical hash first, then the bounds, the exact Schema for the task's state and
// the existing semantic validation; a failure is a redacted typed error and reserves nothing
export const decodeInterpretationSubmission = (raw: unknown, context: InterpretationDecodeContext):
  Effect.Effect<InterpretationSubmission, InterpretationArgumentsInvalid> => Effect.suspend(() => {
  const captured = captureRaw(raw, context.definitionContext !== null);
  if (!captured.ok) return Effect.fail(rootInvalid(captured.code));
  const argumentsHash = workflowRequestHash(captured.raw);
  const decode: (input: unknown, options?: SchemaAST.ParseOptions) => Effect.Effect<DecodedArguments, Schema.SchemaError> =
    Schema.decodeUnknownEffect(schemaFor(context), decodeOptions);
  return decode(captured.raw).pipe(
    Effect.mapError((error) => invalid("arguments_schema", interpretationSchemaIssues(error.issue))),
    Effect.flatMap((decoded) => {
      const payload = semanticPayload(decoded, context);
      if (payload instanceof InterpretationArgumentsInvalid) return Effect.fail(payload);
      const envelope: InterpretationEnvelope = {supervisorThreadId: decoded.supervisorThreadId, bindingGeneration: decoded.bindingGeneration,
        taskId: decoded.taskId, attemptId: decoded.attemptId, sourcePin: {...decoded.sourcePin}};
      return Effect.succeed({rawArguments: captured.raw, argumentsCanonical: captured.canonical, argumentsHash, envelope, payload});
    }),
  );
});

// attempt state gate (item 5 order: after the proof and the receipt lookup)

export const interpretationStaleCodes = ["attempt_not_current", "attempt_settled"] as const;
export type InterpretationStaleCode = typeof interpretationStaleCodes[number];

export type InterpretationAttemptGate =
  | {readonly status: "current"}
  | {readonly status: "stale"; readonly code: InterpretationStaleCode}
  | {readonly status: "invalid"; readonly code: "attempt_pin_mismatch"; readonly issues: ReadonlyArray<InterpretationIssue>};

// whether a submission without a receipt answers the task's current attempt: another or superseded attempt is stale, a settled
// task is stale, and the current attempt ID quoted with another task or source pin is an invalid assertion
export const interpretationAttemptGate = (envelope: InterpretationEnvelope, task: {
  readonly id: string;
  readonly status: string;
  readonly attempt: InterpretationAttempt | null | undefined;
}): InterpretationAttemptGate => {
  const attempt = task.attempt;
  if (!attempt || attempt.attemptId !== envelope.attemptId || attempt.key.taskId !== task.id ||
    attempt.key.bindingGeneration !== envelope.bindingGeneration) return {status: "stale", code: "attempt_not_current"};
  const issues: Array<InterpretationIssue> = [];
  if (envelope.taskId !== attempt.key.taskId) issues.push({code: "attempt_pin_mismatch", path: "/taskId"});
  if (canonicalJson(envelope.sourcePin) !== canonicalJson(attempt.key.source)) issues.push({code: "attempt_pin_mismatch", path: "/sourcePin"});
  if (issues.length > 0) return {status: "invalid", code: "attempt_pin_mismatch", issues};
  if (!["dispatching", "waiting", "uncertain"].includes(task.status)) return {status: "stale", code: "attempt_settled"};
  return {status: "current"};
};

// native authority (item 4)

export const interpretationPendingProofCodes = [
  "native_item_unavailable", "native_input_incomplete", "native_tool_name_or_wrapper_mismatch", "native_input_not_json", "native_input_too_large",
  "native_input_empty", "native_input_does_not_match_request", "native_evidence_not_visible", "native_item_detail_unavailable",
  "native_item_detail_limit", "native_item_detail_too_large", "native_evidence_wait_interrupted", "supervisor_projection_unavailable",
  "native_request_message_not_visible", "native_proof_pending",
] as const;
export type InterpretationPendingProofCode = typeof interpretationPendingProofCodes[number];

export const interpretationDeniedCodes = [
  "binding_not_ready", "caller_not_bound_root", "root_not_owned", "binding_generation_mismatch", "root_not_task_owner",
  "supervisor_projection_not_current", "supervisor_projection_mismatch", "native_item_identity_mismatch", "native_item_not_main_strong",
  "native_item_identity_incomplete", "native_item_not_executed", "native_tool_item_rolled_back", "native_item_not_running_or_completed",
  "native_run_identity_mismatch", "native_run_rolled_back", "native_root_node_rolled_back", "native_item_outside_main_run",
  "native_tool_node_rolled_back", "native_tool_name_unrecognized", "arguments_hash_mismatch", "native_run_not_request_run",
  "native_request_text_mismatch", "native_run_not_completed", "native_tool_not_completed", "native_proof_changed",
  "supervision_stopped", "supervision_disabled", "start_permission_missing", "native_proof_denied",
] as const;
export type InterpretationDeniedCode = typeof interpretationDeniedCodes[number];

const pendingProofCodeSet = new Set<string>(interpretationPendingProofCodes);
const deniedCodeSet = new Set<string>(interpretationDeniedCodes);
// a native evidence pending reason as its closed code; an unlisted reason is the generic one
export const interpretationPendingProofCode = (reason: string): InterpretationPendingProofCode =>
  pendingProofCodeSet.has(reason) ? reason as InterpretationPendingProofCode : "native_proof_pending";
// a native evidence denial as its closed code; an unlisted reason is the generic one
export const interpretationDeniedCode = (reason: string): InterpretationDeniedCode =>
  deniedCodeSet.has(reason) ? reason as InterpretationDeniedCode : "native_proof_denied";

// the native proof reference a receipt retains: item, run, node and provider identity, and the raw-argument hash
export const InterpretationProofReference = Schema.Struct({
  itemId: Schema.String,
  runId: Schema.String,
  nodeId: Schema.String,
  providerThreadId: Schema.String,
  toolName: Schema.String,
  driver: Schema.String,
  nativeId: Schema.String,
  itemOrdinal: Count,
  argumentsHash: Sha256,
  requestMessageId: Schema.String,
});
export type InterpretationProofReference = typeof InterpretationProofReference.Type;

// the scope's binding as the verifier reads it
export type InterpretationBinding = {
  readonly projectId: string;
  readonly mainThreadId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly state: string;
};

export type InterpretationProofInput = {
  // intake accepts a running or completed item; finalization needs the completed item and run and the retained proof unchanged
  readonly phase: "intake" | "finalization";
  readonly submission: Pick<InterpretationSubmission, "envelope" | "rawArguments" | "argumentsHash">;
  // the attempt's main chat
  readonly scope: {readonly projectId: string; readonly mainThreadId: string};
  // the attempt's persisted interpretation request
  readonly request: Pick<InterpretationAttemptKey, "requestMessageId" | "requestTextHash">;
  // the scope's current binding, or null
  readonly binding: InterpretationBinding | null;
  readonly ownedThreadIds: ReadonlySet<string>;
  // the bound root's projection the item was found in
  readonly projection: Projection;
  readonly itemId: string;
  // the native item detail
  readonly detail: unknown;
  readonly retained?: InterpretationProofReference;
};

export type InterpretationProofVerdict =
  | {readonly status: "verified"; readonly proof: InterpretationProofReference; readonly itemStatus: "running" | "completed"}
  | {readonly status: "pending_proof"; readonly code: InterpretationPendingProofCode}
  | {readonly status: "denied"; readonly code: InterpretationDeniedCode};

const denied = (code: InterpretationDeniedCode): InterpretationProofVerdict => ({status: "denied", code});

// verifies one native tool item as the proof of a submission: the current owned root of the exact ready binding and generation, an
// executed strong main-run item and node of the interpretation tool (direct or MCPX) whose complete raw arguments canonically equal
// the submission, in the run of the attempt's persisted request message and text hash
export const verifyInterpretationProof = (input: InterpretationProofInput): InterpretationProofVerdict => {
  const {binding, projection, submission} = input;
  const envelope = submission.envelope;
  if (!binding || binding.state !== "ready") return denied("binding_not_ready");
  if (envelope.supervisorThreadId !== binding.threadId) return denied("caller_not_bound_root");
  if (!input.ownedThreadIds.has(binding.threadId)) return denied("root_not_owned");
  if (envelope.bindingGeneration !== binding.generation) return denied("binding_generation_mismatch");
  if (binding.projectId !== input.scope.projectId || binding.mainThreadId !== input.scope.mainThreadId) return denied("root_not_task_owner");
  if (projection.thread.id !== binding.threadId || projection.thread.projectId !== binding.projectId ||
    projection.thread.archivedAt != null || projection.thread.deletedAt != null) return denied("supervisor_projection_not_current");
  const check = verifyWorkflowToolEvidence({projection, supervisorThreadId: binding.threadId, itemId: input.itemId, detail: input.detail,
    tool: "interpretation", arguments: submission.rawArguments});
  if (check.status === "pending") return {status: "pending_proof", code: interpretationPendingProofCode(check.reason)};
  if (check.status === "denied") return denied(interpretationDeniedCode(check.reason));
  const evidence = check.evidence;
  if (evidence.inputHash !== submission.argumentsHash) return denied("arguments_hash_mismatch");
  // the verified detail carries the main-run node the verifier resolved
  const nodeId = isRecord(input.detail) && typeof input.detail.nodeId === "string" ? input.detail.nodeId : null;
  if (nodeId === null) return denied("native_item_identity_mismatch");
  const run = projection.runs.find(item => item.id === evidence.runId);
  if (!run || run.userMessageId !== input.request.requestMessageId) return denied("native_run_not_request_run");
  const request = projection.messages.find(item => item.id === input.request.requestMessageId && item.runId === run.id &&
    item.threadId === binding.threadId);
  if (!request) return {status: "pending_proof", code: "native_request_message_not_visible"};
  if (interpretationTextHash(request.text) !== input.request.requestTextHash) return denied("native_request_text_mismatch");
  const proof: InterpretationProofReference = {itemId: evidence.itemId, runId: evidence.runId, nodeId, providerThreadId: evidence.providerThreadId,
    toolName: evidence.toolName, driver: evidence.nativeItemRef.driver, nativeId: evidence.nativeItemRef.nativeId, itemOrdinal: evidence.ordinal,
    argumentsHash: evidence.inputHash, requestMessageId: input.request.requestMessageId};
  if (input.phase === "finalization") {
    if (run.status !== "completed") return denied("native_run_not_completed");
    if (evidence.status !== "completed") return denied("native_tool_not_completed");
    const retained = input.retained;
    if (!retained || retained.itemId !== proof.itemId || retained.runId !== proof.runId || retained.nodeId !== proof.nodeId ||
      retained.providerThreadId !== proof.providerThreadId || retained.toolName !== proof.toolName || retained.driver !== proof.driver ||
      retained.nativeId !== proof.nativeId || retained.argumentsHash !== proof.argumentsHash ||
      retained.requestMessageId !== proof.requestMessageId) return denied("native_proof_changed");
  }
  return {status: "verified", proof, itemStatus: evidence.status};
};

// results (item 6): codes and paths only, never raw arguments, secrets or pretty-printed causes

export const interpretationConflictCodes = ["attempt_already_recorded"] as const;
export const interpretationUnavailableCodes = ["interpretation_submission_unavailable", "native_access_unavailable", "submission_unavailable"] as const;
export type InterpretationConflictCode = typeof interpretationConflictCodes[number];
export type InterpretationUnavailableCode = typeof interpretationUnavailableCodes[number];

export type InterpretationSubmitResult =
  | {readonly status: "submitted"; readonly attemptId: string}
  | {readonly status: "duplicate"; readonly attemptId: string}
  | {readonly status: "pending_proof"; readonly code: InterpretationPendingProofCode}
  | {readonly status: "invalid"; readonly code: InterpretationInvalidCode; readonly issues: ReadonlyArray<InterpretationIssue>}
  | {readonly status: "stale"; readonly code: InterpretationStaleCode}
  | {readonly status: "denied"; readonly code: InterpretationDeniedCode}
  | {readonly status: "conflict"; readonly code: InterpretationConflictCode}
  | {readonly status: "unavailable"; readonly code: InterpretationUnavailableCode}
  | {readonly status: "storage_failed"; readonly code: "storage_failed"};

const IssuePath = Schema.String.check(maxLength(maxPathLength), Schema.isPattern(/^(?:\/(?:[A-Za-z]+|[0-9]+|\*))*$/u));
const Issue = Schema.Struct({code: Schema.Literals(interpretationIssueCodes), path: IssuePath});
const retryFor = {submitted: "none", duplicate: "none", pending_proof: "identical", invalid: "corrected", stale: "none", denied: "none",
  conflict: "none", unavailable: "identical", storage_failed: "identical"} as const;

// the tool response: the status, its closed code or the attempt ID, redacted issues and which retry is meaningful
export const InterpretationSubmitResponse = Schema.Union([
  Schema.Struct({status: Schema.Literals(["submitted", "duplicate"]), attemptId: InterpretationAttemptId, retry: Schema.Literal("none")}),
  Schema.Struct({status: Schema.Literal("pending_proof"), code: Schema.Literals(interpretationPendingProofCodes), retry: Schema.Literal("identical")}),
  Schema.Struct({status: Schema.Literal("invalid"), code: Schema.Literals(interpretationInvalidCodes),
    issues: Schema.Array(Issue).check(maxLength(maxIssues)), retry: Schema.Literal("corrected")}),
  Schema.Struct({status: Schema.Literal("stale"), code: Schema.Literals(interpretationStaleCodes), retry: Schema.Literal("none")}),
  Schema.Struct({status: Schema.Literal("denied"), code: Schema.Literals(interpretationDeniedCodes), retry: Schema.Literal("none")}),
  Schema.Struct({status: Schema.Literal("conflict"), code: Schema.Literals(interpretationConflictCodes), retry: Schema.Literal("none")}),
  Schema.Struct({status: Schema.Literal("unavailable"), code: Schema.Literals(interpretationUnavailableCodes), retry: Schema.Literal("identical")}),
  Schema.Struct({status: Schema.Literal("storage_failed"), code: Schema.Literal("storage_failed"), retry: Schema.Literal("identical")}),
]);
export type InterpretationSubmitResponse = typeof InterpretationSubmitResponse.Type;

const closed = <C extends string>(codes: ReadonlyArray<C>, value: string, fallback: C): C =>
  (codes as ReadonlyArray<string>).includes(value) ? value as C : fallback;
const closedIssues = (issues: ReadonlyArray<InterpretationIssue>): Array<InterpretationIssue> => issues.slice(0, maxIssues).map(issue => {
  const path = Schema.is(IssuePath)(issue.path) ? issue.path : "/*";
  return {code: closed(interpretationIssueCodes, issue.code, "invalid_value"), path};
});

// a fresh response object of only declared fields, closed codes and well-formed paths, whatever the result value carries
export const interpretationSubmitResponse = (result: InterpretationSubmitResult): InterpretationSubmitResponse => {
  switch (result.status) {
    case "submitted":
    case "duplicate":
      return Schema.is(InterpretationAttemptId)(result.attemptId)
        ? {status: result.status, attemptId: result.attemptId, retry: "none"}
        : {status: "unavailable", code: "interpretation_submission_unavailable", retry: "identical"};
    case "pending_proof": return {status: "pending_proof", code: closed(interpretationPendingProofCodes, result.code, "native_proof_pending"), retry: retryFor.pending_proof};
    case "invalid": return {status: "invalid", code: closed(interpretationInvalidCodes, result.code, "arguments_schema"), issues: closedIssues(result.issues),
      retry: retryFor.invalid};
    case "stale": return {status: "stale", code: closed(interpretationStaleCodes, result.code, "attempt_not_current"), retry: retryFor.stale};
    case "denied": return {status: "denied", code: closed(interpretationDeniedCodes, result.code, "native_proof_denied"), retry: retryFor.denied};
    case "conflict": return {status: "conflict", code: "attempt_already_recorded", retry: retryFor.conflict};
    case "unavailable": return {status: "unavailable", code: closed(interpretationUnavailableCodes, result.code, "submission_unavailable"),
      retry: retryFor.unavailable};
    case "storage_failed": return {status: "storage_failed", code: "storage_failed", retry: retryFor.storage_failed};
  }
};

// the log and span fields of a result: its status, code and issue paths; never an argument, an ID the model chose or a cause
export const interpretationSubmitLogFields = (result: InterpretationSubmitResult): LogFields => {
  const response = interpretationSubmitResponse(result);
  if ("attemptId" in response) return {status: response.status};
  if (response.status === "invalid")
    return {status: response.status, code: response.code, issues: response.issues.map(issue => `${issue.code}@${issue.path}`).join(",")};
  return {status: response.status, code: response.code};
};

// the invalid result of a rejected decode or attempt assertion
export const interpretationInvalidResult = (error: {readonly code: InterpretationInvalidCode; readonly issues: ReadonlyArray<InterpretationIssue>}):
  InterpretationSubmitResult => ({status: "invalid", code: error.code, issues: error.issues});

// the result of a proof that did not verify
export const interpretationProofResult = (verdict: Exclude<InterpretationProofVerdict, {readonly status: "verified"}>): InterpretationSubmitResult =>
  verdict.status === "pending_proof" ? {status: "pending_proof", code: verdict.code} : {status: "denied", code: verdict.code};
