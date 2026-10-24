import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { canonicalJson } from "../src/canonical-json.js";
import {
  InterpretationArgumentsInvalid,
  InterpretationAttempt,
  InterpretationPayload,
  InterpretationProofReference,
  InterpretationSubmitResponse,
  decodeInterpretationSubmission,
  interpretationAttemptGate,
  interpretationAttemptId,
  interpretationAttemptKey,
  interpretationInvalidResult,
  interpretationProofResult,
  interpretationSubmitLogFields,
  interpretationSubmitResponse,
  interpretationTextHash,
  retainedInterpretationAttempt,
  sameInterpretationAttemptKey,
  verifyInterpretationProof,
  type InterpretationDecodeContext,
  type InterpretationIssue,
  type InterpretationProofInput,
  type InterpretationProofVerdict,
  type InterpretationSubmission,
  type InterpretationSubmitResult,
} from "../src/interpretation-submission.js";
import { interpretationLimits, prepareWorkflowRequest } from "../src/supervisor-workflow.js";
import { verifyWorkflowToolEvidence, workflowRequestHash, workflowToolNames } from "../src/workflow-write-evidence.js";
import { makeDefinitionFixture, stepSource, workflowSource } from "./project-definitions-fixture.js";
import * as fx from "./support/s6e-prep-interpretation.js";

// WP-S6e-PREP (plan 3.12 items 1-4 and 6): the pure parts of CT-ISUB-02, -03, -05, -18 and -19 over projection fixtures; the
// route, intake transaction, finalization and wake cases belong to S6e proper

const plain: InterpretationDecodeContext = {definitionContext: null, pendingStart: false};
const startContext: InterpretationDecodeContext = {definitionContext: null, pendingStart: true};
const decode = (raw: unknown, context: InterpretationDecodeContext = plain) => decodeInterpretationSubmission(raw, context);
const rejected = (raw: unknown, context: InterpretationDecodeContext = plain) => Effect.flip(decode(raw, context));

// a ready definition context: inspect is required, reviewer composes inspect and report
const definitionContext = Effect.gen(function* () {
  const fixture = makeDefinitionFixture();
  fixture.addFile(fixture.threadRoot!, ".t3-supervisor/steps/inspect.md", stepSource("inspect", "Inspect the current behavior."));
  fixture.addFile(fixture.threadRoot!, ".t3-supervisor/steps/report.md", stepSource("report", "Report findings and remaining risks."));
  fixture.addFile(fixture.threadRoot!, ".t3-supervisor/workflows/reviewer.yaml", workflowSource("Reviewer", "  - step: inspect\n  - step: report\n"));
  fixture.writeIndex(fixture.threadRoot!, {required: [{step: "inspect"}]});
  const snapshot = yield* (yield* fixture.makeDefinitions()).load("project", "thread");
  const context = prepareWorkflowRequest("thread", fx.task.sourceMessageId, fx.sourceText, snapshot).context;
  assert.ok(context, "the task carries a definition context");
  return context;
});

const formalWorkflow = {
  requirements: [{kind: "step", id: "inspect", applies: true, reason: "The change needs an inspection first."}],
  plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: "inspect", reason: "Inspect the reports page."},
    {kind: "step", definitionId: null, localId: "export", name: "Export", description: "Add the export action.", reason: "The requested change."},
    {kind: "workflow", definitionId: "reviewer", reason: "Review the change."},
  ]},
};
const workflowArguments = (overrides: Record<string, unknown> = {}) =>
  fx.plainArguments({supervision: "needed", workflow: structuredClone(formalWorkflow), ...overrides});
const nested = (depth: number): Record<string, unknown> => depth === 0
  ? {kind: "step", definitionId: "inspect", reason: "Inspect."}
  : {kind: "sequence", nodes: [nested(depth - 1)]};
const leaves = (count: number) => Array.from({length: count}, () => ({kind: "step", definitionId: "inspect", reason: "Inspect."}));
const issue = (code: InterpretationIssue["code"], path: string): InterpretationIssue => ({code, path});

it.effect("CT-ISUB-03: excess keys at every level, including any target or route field, are rejected with their known-key paths", () => Effect.gen(function* () {
  // a route field the tool never accepts: its path names it when it is a known argument word and is * otherwise
  const routeFields: ReadonlyArray<readonly [string, string]> = [
    ["targetThreadId", "/*"], ["threadId", "/*"], ["runId", "/runId"], ["dispatchMode", "/*"], ["mode", "/*"], ["body", "/*"], ["text", "/*"],
    ["model", "/*"], ["modelSelection", "/*"], ["providerInstanceId", "/*"], ["acceptance", "/*"], ["proposalId", "/*"], ["callback", "/*"],
    ["operationId", "/*"], ["messageId", "/messageId"],
  ];
  for (const [key, path] of routeFields) {
    const error = yield* rejected({...fx.plainArguments(), [key]: "main-interpretation"});
    assert.ok(error instanceof InterpretationArgumentsInvalid, key);
    assert.deepEqual([error.code, error.issues], ["arguments_schema", [issue("unexpected_key", path)]], key);
  }
  const pin = yield* rejected(fx.plainArguments({sourcePin: {...fx.attempt().key.source, targetRunId: "run"}}));
  assert.deepEqual(pin.issues, [issue("unexpected_key", "/sourcePin/*")]);
  // the fields of another task state are excess, and a missing one of this state is missing
  assert.deepEqual((yield* rejected(fx.plainArguments({supervision: "needed", workflow: null}))).issues,
    [issue("unexpected_key", "/supervision"), issue("unexpected_key", "/workflow")]);
  assert.deepEqual((yield* rejected(fx.plainArguments({startRequested: true}))).issues, [issue("unexpected_key", "/startRequested")]);
  assert.deepEqual((yield* rejected(fx.plainArguments(), startContext)).issues, [issue("missing_key", "/startRequested")]);
  const context = yield* definitionContext;
  const withDefinitions = {definitionContext: context, pendingStart: false};
  assert.deepEqual((yield* rejected(fx.plainArguments(), withDefinitions)).issues, [issue("missing_key", "/supervision"), issue("missing_key", "/workflow")]);
  assert.deepEqual((yield* rejected(workflowArguments({workflow: {...formalWorkflow, targetThreadId: "main"}}), withDefinitions)).issues,
    [issue("unexpected_key", "/workflow/*")]);
  assert.deepEqual((yield* rejected(workflowArguments({workflow: {...formalWorkflow, plan: {...formalWorkflow.plan, dispatch: "steer"}}}), withDefinitions)).issues,
    [issue("unexpected_key", "/workflow/plan/*")]);
  assert.deepEqual((yield* rejected(workflowArguments({workflow: {...formalWorkflow, requirements: [{...formalWorkflow.requirements[0], route: "main"}]}}),
    withDefinitions)).issues, [issue("unexpected_key", "/workflow/requirements/0/*")]);
  // a service-owned node field is no model-authored plan member
  const nodeId = yield* rejected(workflowArguments({workflow: {...formalWorkflow, plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: "inspect", reason: "Inspect.", nodeId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427"}]}}}), withDefinitions);
  assert.equal(nodeId.code, "arguments_schema");
  assert.ok(nodeId.issues.some(item => item.code === "unexpected_key" && item.path === "/workflow/plan/nodes/0/*"), JSON.stringify(nodeId.issues));
}), {timeout: 10_000});

it.effect("CT-ISUB-03: oversize text and arguments, depth and plan node limits are rejected; the shared bounds still admit their maximum", () => Effect.gen(function* () {
  const context = yield* definitionContext;
  const withDefinitions = {definitionContext: context, pendingStart: false};
  assert.deepEqual((yield* rejected(fx.plainArguments({objective: "o".repeat(interpretationLimits.maxObjectiveLength + 1)}))).issues,
    [issue("too_long", "/objective")]);
  assert.deepEqual((yield* rejected(fx.plainArguments({reason: "r".repeat(interpretationLimits.maxReasonLength + 1)}))).issues, [issue("too_long", "/reason")]);
  const longName = yield* rejected(workflowArguments({workflow: {...formalWorkflow, plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: null, localId: "export", name: "n".repeat(interpretationLimits.maxPlanTextLength + 1), description: "Export.", reason: "Export."}]}}}),
  withDefinitions);
  assert.ok(longName.issues.some(item => item.code === "too_long" && item.path === "/workflow/plan/nodes/0/name"), JSON.stringify(longName.issues));
  // the old final-reply bounds cap the canonical arguments, the workflow tool input bound caps their bytes
  const tooLong = yield* rejected(fx.plainArguments({reason: "r".repeat(interpretationLimits.maxInterpretationReplyLength)}));
  assert.deepEqual([tooLong.code, tooLong.issues], ["arguments_too_large", [issue("arguments_too_large", "")]]);
  const wideBytes = yield* rejected(workflowArguments({reason: "€".repeat(70_000)}), withDefinitions);
  assert.equal(wideBytes.code, "arguments_too_large", "70 000 three-byte characters are below the text bound but above 192 KiB");
  // the canonical nesting bound is the depth limit; non-JSON values and non-objects are rejected before any decode
  assert.equal((yield* rejected(workflowArguments({workflow: {requirements: [], plan: nested(40)}}), withDefinitions)).code, "arguments_too_deep");
  assert.equal((yield* rejected(fx.plainArguments({bindingGeneration: Number.NaN}))).code, "arguments_not_json");
  for (const raw of [null, [], "submit", 3]) assert.equal((yield* rejected(raw)).code, "arguments_not_object", JSON.stringify(raw));
  // one group above the shared node limit, and nested groups whose submitted nodes together exceed it
  assert.deepEqual((yield* rejected(workflowArguments({workflow: {requirements: formalWorkflow.requirements,
    plan: {kind: "parallel", nodes: leaves(interpretationLimits.maxExpandedNodes + 1)}}}), withDefinitions)).issues, [issue("too_long", "/workflow/plan/nodes")]);
  const total = yield* rejected(workflowArguments({workflow: {requirements: formalWorkflow.requirements, plan: {kind: "sequence", nodes: [
    {kind: "parallel", nodes: leaves(200)}, {kind: "parallel", nodes: leaves(200)}, {kind: "parallel", nodes: leaves(200)}]}}}), withDefinitions);
  assert.deepEqual([total.code, total.issues], ["plan_node_limit", [issue("plan_node_limit", "/workflow/plan")]]);
  // the root group and 499 leaves are exactly the limit
  const maximum = yield* decode(workflowArguments({workflow: {requirements: formalWorkflow.requirements,
    plan: {kind: "parallel", nodes: leaves(interpretationLimits.maxExpandedNodes - 1)}}}), withDefinitions);
  assert.equal(maximum.payload.kind === "interpretation" && maximum.payload.workflow?.plan?.nodes.length, interpretationLimits.maxExpandedNodes - 1);
}), {timeout: 10_000});

it.effect("CT-ISUB-03: the raw argument object and its canonical hash are captured before normalization, so normalization cannot hide a mismatch", () => Effect.gen(function* () {
  const raw = fx.plainArguments({objective: "  Ship export support  ", reason: "The request cites github_pat_12345678901234567890 as its token."});
  const submission = yield* decode(raw);
  assert.equal(submission.rawArguments, raw, "the complete raw object itself");
  assert.equal(submission.argumentsCanonical, canonicalJson(raw));
  assert.equal(submission.argumentsHash, workflowRequestHash(raw));
  assert.ok(submission.payload.kind === "interpretation");
  assert.equal(submission.payload.objective, "Ship export support", "the payload is trimmed");
  assert.equal(submission.payload.reason.includes("12345678901234567890"), false, "the payload is redacted");
  const normalized = {...raw, objective: submission.payload.objective, reason: submission.payload.reason};
  assert.notEqual(workflowRequestHash(normalized), submission.argumentsHash);
  // a native item holding the normalized form does not prove the raw submission; one holding the raw object in any key order does
  const normalizedItem = fx.proofState(normalized);
  assert.deepEqual(verifyInterpretationProof(fx.proofInput(submission, normalizedItem)), {status: "pending_proof", code: "native_input_does_not_match_request"});
  const reordered = fx.proofState(Object.fromEntries(Object.entries(raw).reverse()));
  const verdict = verifyInterpretationProof(fx.proofInput(submission, reordered));
  assert.equal(verdict.status, "verified");
  assert.equal(verdict.status === "verified" && verdict.proof.argumentsHash, submission.argumentsHash);
  // a hash that no longer covers the raw object proves nothing
  assert.deepEqual(verifyInterpretationProof(fx.proofInput({...submission, argumentsHash: "0".repeat(64)}, fx.proofState(raw))),
    {status: "denied", code: "arguments_hash_mismatch"});
}), {timeout: 10_000});

type ProofCase = {
  name: string;
  args?: Record<string, unknown>;
  edit?: (state: fx.ProofState) => void;
  input?: (state: fx.ProofState) => Partial<InterpretationProofInput>;
  expected: InterpretationProofVerdict["status"] | readonly [InterpretationProofVerdict["status"], string];
};

const nativeRef = (state: fx.ProofState) => state.item.nativeItemRef as Record<string, unknown>;
const mcpx = (state: fx.ProofState, name: string) => {
  state.item.toolName = name;
  state.item.input = {name: workflowToolNames.interpretation.mcpxTarget, arguments: state.item.input};
};
const completed = (state: fx.ProofState) => {
  state.requestRun.status = "completed";
  state.requestRun.completedAt = "2026-10-20T10:00:09.000Z";
  for (const value of [state.root, state.node, state.item]) value.status = "completed";
};

const proofCases: ReadonlyArray<ProofCase> = [
  {name: "first direct name, running item at intake", expected: "verified"},
  {name: "second direct name, completed item", edit: state => {state.item.toolName = workflowToolNames.interpretation.direct[1];completed(state);}, expected: "verified"},
  {name: "first mcpx wrapper", edit: state => mcpx(state, workflowToolNames.mcpxCall[0]), expected: "verified"},
  {name: "second mcpx wrapper", edit: state => mcpx(state, workflowToolNames.mcpxCall[1]), expected: "verified"},
  {name: "other root bound to another main", args: {supervisorThreadId: fx.otherRootThreadId},
    input: () => ({binding: fx.binding({threadId: fx.otherRootThreadId, mainThreadId: "main-other"})}), expected: ["denied", "root_not_task_owner"]},
  {name: "helper of the bound root", args: {supervisorThreadId: fx.helperThreadId}, expected: ["denied", "caller_not_bound_root"]},
  {name: "operative main", args: {supervisorThreadId: fx.mainThreadId}, expected: ["denied", "caller_not_bound_root"]},
  {name: "root no longer owned", input: () => ({ownedThreadIds: new Set([fx.helperThreadId])}), expected: ["denied", "root_not_owned"]},
  {name: "binding not ready", input: () => ({binding: fx.binding({state: "missing"})}), expected: ["denied", "binding_not_ready"]},
  {name: "no binding", input: () => ({binding: null}), expected: ["denied", "binding_not_ready"]},
  {name: "replaced binding generation", input: () => ({binding: fx.binding({generation: 4})}), expected: ["denied", "binding_generation_mismatch"]},
  {name: "archived root", edit: state => {state.thread = {...state.thread, archivedAt: "2026-10-20T11:00:00.000Z"};}, expected: ["denied", "supervisor_projection_not_current"]},
  {name: "earlier run of the same root", edit: state => {state.item.runId = "earlier-run";state.item.nodeId = "earlier-tool-node";},
    expected: ["denied", "native_run_not_request_run"]},
  {name: "another provider identity", edit: state => {state.item.providerThreadId = "provider-thread-other";}, expected: ["denied", "native_run_identity_mismatch"]},
  {name: "changed raw arguments", edit: state => {state.item.input = {...(state.item.input as object), objective: "Ship a different change"};},
    expected: ["pending_proof", "native_input_does_not_match_request"]},
  {name: "weak item", edit: state => {nativeRef(state).strength = "weak";}, expected: ["denied", "native_item_not_main_strong"]},
  {name: "truncated summary input", edit: state => {state.item.input = "supervision_interpretation_submit {\"taskId\":";}, expected: ["pending_proof", "native_input_incomplete"]},
  {name: "truncated partial input", edit: state => {state.item.inputTruncated = true;state.item.input = {taskId: fx.task.id};},
    expected: ["pending_proof", "native_input_does_not_match_request"]},
  {name: "forged item id", edit: state => {state.item.id = "forged-item";}, expected: ["denied", "native_item_identity_mismatch"]},
  {name: "forged item of another thread", edit: state => {state.item.threadId = fx.otherRootThreadId;}, expected: ["denied", "native_item_identity_mismatch"]},
  {name: "forged item type", edit: state => {state.item.type = "tool_call";}, expected: ["denied", "native_item_identity_mismatch"]},
  {name: "forged native reference", edit: state => {delete state.item.nativeItemRef;}, expected: ["denied", "native_item_not_main_strong"]},
  {name: "forged gateway name", edit: state => {state.item.toolName = "custom-gateway.supervision_interpretation_submit";},
    expected: ["denied", "native_tool_name_unrecognized"]},
  {name: "another known tool", edit: state => {state.item.toolName = workflowToolNames.start.direct[0];}, expected: ["pending_proof", "native_tool_name_or_wrapper_mismatch"]},
  {name: "nested item", edit: state => {state.item.parentItemId = "parent-item";}, expected: ["denied", "native_item_not_main_strong"]},
  {name: "node below a subagent", edit: state => {
    state.extraNodes.push({id: "subagent-node", kind: "subagent", threadId: fx.rootThreadId, runId: "request-run", rootNodeId: "request-root",
      providerThreadId: fx.providerThreadId, parentNodeId: "request-root", status: "running"});
    state.node.parentNodeId = "subagent-node";
  }, expected: ["denied", "native_item_outside_main_run"]},
  {name: "unexecuted item", edit: state => {state.item.toolNonExecutionKind = "denied";}, expected: ["denied", "native_item_not_executed"]},
  {name: "rolled-back item", edit: state => {state.item.status = "rolled_back";}, expected: ["denied", "native_tool_item_rolled_back"]},
  {name: "rolled-back node", edit: state => {state.node.status = "rolled_back";}, expected: ["denied", "native_tool_node_rolled_back"]},
  {name: "rolled-back run", edit: state => {state.requestRun.status = "rolled_back";}, expected: ["denied", "native_run_rolled_back"]},
  {name: "rolled-back root node", edit: state => {state.root.status = "rolled_back";}, expected: ["denied", "native_root_node_rolled_back"]},
  {name: "request text changed", edit: state => {state.requestMessage.text = "Another request text.";}, expected: ["denied", "native_request_text_mismatch"]},
  {name: "request message not visible", edit: state => {state.requestMessage.id = "another-message";}, expected: ["pending_proof", "native_request_message_not_visible"]},
];

it.effect("CT-ISUB-02: only the bound root's executed strong main-run item of the request run proves a submission, through direct and MCPX names", () => Effect.gen(function* () {
  for (const testCase of proofCases) {
    const raw = fx.plainArguments(testCase.args ?? {});
    const submission = yield* decode(raw);
    const state = fx.proofState(raw);
    testCase.edit?.(state);
    const verdict = verifyInterpretationProof(fx.proofInput(submission, state, testCase.input?.(state) ?? {}));
    if (testCase.expected === "verified") {
      assert.equal(verdict.status, "verified", `${testCase.name}: ${JSON.stringify(verdict)}`);
      assert.deepEqual(verdict.status === "verified" && {...verdict.proof}, {itemId: "tool-item", runId: "request-run", nodeId: "tool-node",
        providerThreadId: fx.providerThreadId, toolName: state.item.toolName, driver: "codex", nativeId: "native-tool-item", itemOrdinal: 9,
        argumentsHash: submission.argumentsHash, requestMessageId: fx.requestMessageId}, testCase.name);
    } else {
      const [status, code] = testCase.expected;
      assert.deepEqual(verdict, {status, code}, testCase.name);
    }
  }
}), {timeout: 10_000});

// the native shape of an executed MCPX call (getTurnItem 2026-10-23, a root's workflow_read through the native mcpx.mcpx_call_tool,
// output and title removed; Codex's own history shows native mcpx tool calls only): an integration toolSource, Codex's exec- item id,
// a provider turn and a large ordinal, one strong main-run dynamic_tool item without a parent; the same shape carrying the
// submission target proves it
it.effect("CT-ISUB-02: an executed native mcpx.mcpx_call_tool item, in the recorded native shape, proves the submission", () => Effect.gen(function* () {
  const raw = fx.plainArguments();
  const submission = yield* decode(raw);
  const state = fx.proofState(raw);
  mcpx(state, "mcpx.mcpx_call_tool");
  completed(state);
  Object.assign(state.item, {toolSource: {key: "mcp:mcpx", name: "mcpx", kind: "integration"}, parentItemId: null, ordinal: 21000006,
    providerTurnId: "provider-turn:provider:codex:native-turn:01a1683a-1a26-7682-8aae-db34e62c51d9",
    startedAt: "2026-10-20T10:00:08.727Z", completedAt: "2026-10-20T10:00:08.735Z", updatedAt: "2026-10-20T10:00:08.735Z"});
  nativeRef(state).nativeId = "exec-52376326-8504-4fd1-af4e-f43b3ffc4bd6";
  assert.deepEqual(Object.keys(state.item.input as object), ["name", "arguments"]);
  const verdict = verifyInterpretationProof(fx.proofInput(submission, state, {}));
  assert.equal(verdict.status, "verified", JSON.stringify(verdict));
  assert.deepEqual(verdict.status === "verified" && {...verdict.proof}, {itemId: "tool-item", runId: "request-run", nodeId: "tool-node",
    providerThreadId: fx.providerThreadId, toolName: "mcpx.mcpx_call_tool", driver: "codex", nativeId: "exec-52376326-8504-4fd1-af4e-f43b3ffc4bd6",
    itemOrdinal: 21000006, argumentsHash: submission.argumentsHash, requestMessageId: fx.requestMessageId});
  // the same item naming another target, or nested under another item, proves nothing
  const other = fx.proofState(raw);
  mcpx(other, "mcpx.mcpx_call_tool");
  (other.item.input as Record<string, unknown>).name = "t3-supervisor-workflows__workflow_read";
  assert.notEqual(verifyInterpretationProof(fx.proofInput(submission, other, {})).status, "verified");
  const nested = fx.proofState(raw);
  mcpx(nested, "mcpx.mcpx_call_tool");
  nested.item.parentItemId = "turn-item:provider:codex:native-item:exec-parent";
  assert.deepEqual(verifyInterpretationProof(fx.proofInput(submission, nested, {})), {status: "denied", code: "native_item_not_main_strong"});
}), {timeout: 10_000});

it.effect("CT-ISUB-02: finalization needs the completed item and run and the retained proof unchanged, including its provider identity", () => Effect.gen(function* () {
  const raw = fx.plainArguments();
  const submission = yield* decode(raw);
  const intake = verifyInterpretationProof(fx.proofInput(submission, fx.proofState(raw)));
  assert.ok(intake.status === "verified" && intake.itemStatus === "running", "a running item counts for intake");
  const retained: InterpretationProofReference = intake.proof;
  const finalize = (edit: (state: fx.ProofState) => void, retainedProof: InterpretationProofReference | null = retained) => {
    const state = fx.proofState(raw);
    completed(state);
    edit(state);
    return verifyInterpretationProof(fx.proofInput(submission, state, {phase: "finalization", ...(retainedProof ? {retained: retainedProof} : {})}));
  };
  assert.deepEqual(Schema.decodeUnknownSync(InterpretationProofReference)(JSON.parse(JSON.stringify(retained)), {onExcessProperty: "error"}), retained,
    "the proof reference a receipt retains round-trips through its schema");
  const unchanged = finalize(() => undefined);
  assert.ok(unchanged.status === "verified" && unchanged.itemStatus === "completed");
  assert.deepEqual(unchanged.status === "verified" && unchanged.proof, retained);
  assert.deepEqual(finalize(state => {state.item.status = "running";}), {status: "denied", code: "native_tool_not_completed"});
  assert.deepEqual(finalize(state => {state.requestRun.status = "failed";}), {status: "denied", code: "native_run_not_completed"});
  assert.deepEqual(finalize(state => {state.item.status = "rolled_back";}), {status: "denied", code: "native_tool_item_rolled_back"});
  assert.deepEqual(finalize(state => {state.node.status = "rolled_back";}), {status: "denied", code: "native_tool_node_rolled_back"});
  assert.deepEqual(finalize(() => undefined, null), {status: "denied", code: "native_proof_changed"});
  for (const changed of [{driver: "claude"}, {providerThreadId: "provider-thread-other"}, {nativeId: "native-other"}, {nodeId: "tool-node-other"},
    {itemId: "tool-item-other"}, {argumentsHash: "1".repeat(64)}, {toolName: workflowToolNames.interpretation.direct[1]}])
    assert.deepEqual(finalize(() => undefined, {...retained, ...changed}), {status: "denied", code: "native_proof_changed"}, JSON.stringify(changed));
}), {timeout: 10_000});

it.effect("CT-ISUB-02: the interpretation evidence kind has its own direct and MCPX names, known to every other tool", () => Effect.sync(() => {
  assert.deepEqual(workflowToolNames.interpretation, {
    direct: ["t3-supervisor-workflows.supervision_interpretation_submit", "mcp__t3-supervisor-workflows__supervision_interpretation_submit"],
    mcpxTarget: "t3-supervisor-workflows__supervision_interpretation_submit",
  });
  const raw = fx.plainArguments();
  const direct = fx.proofState(raw);
  const projection = fx.proofProjection(direct);
  const check = (detail: Record<string, unknown>, tool: "write" | "start" | "interpretation") =>
    verifyWorkflowToolEvidence({projection, supervisorThreadId: fx.rootThreadId, itemId: "tool-item", detail, tool, arguments: raw});
  assert.equal(check(direct.item, "interpretation").status, "verified");
  // a known name of another tool is a mismatch, never an unrecognized gateway
  assert.deepEqual(check(direct.item, "write"), {status: "pending", reason: "native_tool_name_or_wrapper_mismatch"});
  const wrapped = fx.proofState(raw);
  mcpx(wrapped, workflowToolNames.mcpxCall[0]);
  assert.deepEqual(check(wrapped.item, "start"), {status: "pending", reason: "native_tool_name_or_wrapper_mismatch"});
  assert.equal(check(wrapped.item, "interpretation").status, "verified");
}), {timeout: 10_000});

it.effect("CT-ISUB-05: invalid inputs fail with typed diagnostics, and a corrected resubmission in the same run is proved", () => Effect.gen(function* () {
  const context = yield* definitionContext;
  const withDefinitions = {definitionContext: context, pendingStart: false};
  const cases: ReadonlyArray<readonly [string, unknown, InterpretationDecodeContext, InterpretationArgumentsInvalid["code"], ReadonlyArray<InterpretationIssue>]> = [
    ["blank objective", fx.plainArguments({objective: "   "}), plain, "objective_empty", [issue("objective_empty", "/objective")]],
    ["objective without its source", fx.plainArguments({sourceMessageIds: []}), plain, "source_message_ids_mismatch", [issue("source_message_ids_mismatch", "/sourceMessageIds")]],
    ["another source", fx.plainArguments({sourceMessageIds: ["source-other"]}), plain, "source_message_ids_mismatch", [issue("source_message_ids_mismatch", "/sourceMessageIds")]],
    ["start verdict without its source", fx.plainArguments({objective: null, sourceMessageIds: [], startRequested: false}), startContext, "source_message_ids_mismatch",
      [issue("source_message_ids_mismatch", "/sourceMessageIds")]],
    ["not needed with a workflow", workflowArguments({supervision: "not_needed"}), withDefinitions, "not_needed_workflow_present", [issue("not_needed_workflow_present", "/workflow")]],
    ["generation as text", fx.plainArguments({bindingGeneration: "3"}), plain, "arguments_schema", [issue("invalid_type", "/bindingGeneration")]],
    ["fractional generation", fx.plainArguments({bindingGeneration: 2.5}), plain, "arguments_schema", [issue("not_integer", "/bindingGeneration")]],
    ["negative ordinal", fx.plainArguments({sourcePin: {...fx.attempt().key.source, ordinal: -1}}), plain, "arguments_schema", [issue("too_small", "/sourcePin/ordinal")]],
    ["blank task", fx.plainArguments({taskId: "  "}), plain, "arguments_schema", [issue("blank", "/taskId")]],
    ["foreign attempt id", fx.plainArguments({attemptId: "attempt-1"}), plain, "arguments_schema", [issue("invalid_format", "/attemptId")]],
    ["malformed source hash", fx.plainArguments({sourcePin: {...fx.attempt().key.source, hash: "abc"}}), plain, "arguments_schema", [issue("invalid_format", "/sourcePin/hash")]],
    ["missing reason", (({reason: _reason, ...rest}) => rest)(fx.plainArguments()), plain, "arguments_schema", [issue("missing_key", "/reason")]],
    ["two sources", fx.plainArguments({sourceMessageIds: [fx.task.sourceMessageId, fx.task.sourceMessageId]}), plain, "arguments_schema", [issue("too_long", "/sourceMessageIds")]],
    ["unknown supervision", workflowArguments({supervision: "required"}), withDefinitions, "arguments_schema", [issue("no_match", "/supervision")]],
  ];
  for (const [name, raw, decodeContext, code, issues] of cases) {
    const error = yield* rejected(raw, decodeContext);
    assert.ok(error instanceof InterpretationArgumentsInvalid, name);
    assert.deepEqual([error._tag, error.code, error.message, error.issues], ["InterpretationArgumentsInvalid", code, code, issues], name);
  }
  // the blank call is item one of the request run; its corrected retry is item two of the same run and is the one that proves it
  const invalidArgs = fx.plainArguments({objective: "   "});
  const corrected = fx.plainArguments();
  assert.equal((yield* rejected(invalidArgs)).code, "objective_empty");
  const submission = yield* decode(corrected);
  const first = fx.proofState(invalidArgs);
  const second = fx.proofState(corrected);
  second.item.id = "tool-item-2";
  second.item.ordinal = 10;
  second.item.nodeId = "tool-node-2";
  second.node.id = "tool-node-2";
  const sameRun: fx.ProofState = {...first, extraNodes: [...first.extraNodes, second.node]};
  const projection = {...fx.proofProjection(sameRun), turnItems: [first.item, second.item]};
  assert.deepEqual(verifyInterpretationProof(fx.proofInput(submission, sameRun, {projection, itemId: "tool-item", detail: first.item})),
    {status: "pending_proof", code: "native_input_does_not_match_request"});
  const proved = verifyInterpretationProof(fx.proofInput(submission, sameRun, {projection, itemId: "tool-item-2", detail: second.item}));
  assert.ok(proved.status === "verified" && proved.proof.itemId === "tool-item-2" && proved.proof.runId === "request-run", JSON.stringify(proved));
}), {timeout: 10_000});

it.effect("CT-ISUB-05: the decode keeps today's semantic outcomes: formal, provisional, unavailable, not needed and the Start verdicts", () => Effect.gen(function* () {
  const context = yield* definitionContext;
  // the factored semantic step decides the outcome the deleted final-chat parser decided over the same fields and node ids: the
  // canonical digests below are that parser's results, recorded once before it was removed
  const parserDigests = [
    "a2a8ba4bd64f8883001b94fbc220b0ecfe33a5d5bc0cb1f58398d432714859c6",
    "4ff64e44bd7907199550801eb14aee0b0fccc3ac68f315e1b2720cb3c10c81de",
    "ea6c4c1ddddd11cbdc2eb95ca0ab34c8f0aba1a94c2ef9593c02638e44ee5578",
    "d80cc274844ad99927f3f2e820bfff21b5ba93351d42f41e6e8a7cf805174f7d",
    "a199d38e9c2ecc68375b8dcb1dd4bd37e45a16b3406fd7a978cf0cbf50340a38",
  ];
  let compared = 0;
  const sameAsParser = (_raw: Record<string, unknown>, submission: InterpretationSubmission) => {
    assert.equal(createHash("sha256").update(canonicalJson(submission.payload)).digest("hex"), parserDigests[compared++]);
    assert.ok(submission.payload.kind === "interpretation" && submission.payload.workflow);
    return {...submission.payload, workflow: submission.payload.workflow};
  };
  const withDefinitions = {definitionContext: context, pendingStart: false};
  const formalRaw = workflowArguments();
  const formal = sameAsParser(formalRaw, yield* decode(formalRaw, withDefinitions));
  assert.equal(formal.workflow.status, "proposed");
  const unresolvedRaw = workflowArguments({workflow: {...formalWorkflow, plan: {kind: "sequence", nodes: [...formalWorkflow.plan.nodes,
    {kind: "step", definitionId: "missing-step", reason: "Run the missing step."}]}}});
  assert.equal(sameAsParser(unresolvedRaw, yield* decode(unresolvedRaw, withDefinitions)).workflow.status, "provisional");
  const nullWorkflowRaw = workflowArguments({workflow: null});
  const nullWorkflow = sameAsParser(nullWorkflowRaw, yield* decode(nullWorkflowRaw, withDefinitions));
  assert.deepEqual([nullWorkflow.workflow.status, nullWorkflow.workflow.plan], ["provisional", null], "workflow:null stays a provisional plan, never promoted");
  const unclearRaw = workflowArguments({objective: null, sourceMessageIds: [], workflow: null});
  assert.equal(sameAsParser(unclearRaw, yield* decode(unclearRaw, withDefinitions)).workflow.status, "unavailable");
  const notNeededRaw = workflowArguments({supervision: "not_needed", workflow: null});
  const notNeeded = sameAsParser(notNeededRaw, yield* decode(notNeededRaw, withDefinitions));
  assert.deepEqual([notNeeded.supervision, notNeeded.workflow.status], ["not_needed", "unavailable"]);
  // an identical replay decodes to the identical payload
  assert.deepEqual((yield* decode(formalRaw, withDefinitions)).payload, (yield* decode(structuredClone(formalRaw), withDefinitions)).payload);
  // without definitions the payload is the old interpretation; a pending Start adds the verdict, and a negative one grants nothing else
  const plainRaw = fx.plainArguments();
  assert.equal(compared, parserDigests.length);
  assert.deepEqual((yield* decode(plainRaw)).payload, {kind: "interpretation", objective: "Ship export support",
    reason: "The latest message asks for a concrete change.", startRequested: false});
  assert.deepEqual((yield* decode(fx.plainArguments({startRequested: true}), startContext)).payload,
    {kind: "interpretation", objective: "Ship export support", reason: "The latest message asks for a concrete change.", startRequested: true});
  assert.deepEqual((yield* decode(fx.plainArguments({objective: null, startRequested: true}), startContext)).payload,
    {kind: "interpretation", objective: null, reason: "The latest message asks for a concrete change.", startRequested: true});
  assert.deepEqual((yield* decode(fx.plainArguments({objective: null, startRequested: false}), startContext)).payload, {kind: "start_rejected"});
  const startWithDefinitions = yield* decode(workflowArguments({startRequested: true}), {definitionContext: context, pendingStart: true});
  assert.ok(startWithDefinitions.payload.kind === "interpretation" && startWithDefinitions.payload.startRequested &&
    startWithDefinitions.payload.workflow?.status === "proposed");
  // the payload a receipt records round-trips through its schema
  for (const payload of [(yield* decode(formalRaw, withDefinitions)).payload, startWithDefinitions.payload, {kind: "start_rejected" as const}])
    assert.deepEqual(Schema.decodeUnknownSync(InterpretationPayload)(JSON.parse(JSON.stringify(payload)), {onExcessProperty: "error"}), payload);
}), {timeout: 10_000});

const secret = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const apiKey = `sk-ant-api03-${"Zq9".repeat(16)}`;

it.effect("CT-ISUB-18: responses, log fields and errors carry codes and paths only, never raw arguments or secret-shaped values", () => Effect.gen(function* () {
  const raw = {...fx.plainArguments({objective: `${apiKey} ${"y".repeat(2100)}`, reason: secret}), [secret]: apiKey};
  const error = yield* rejected(raw);
  assert.deepEqual(error.issues, [issue("unexpected_key", "/*"), issue("too_long", "/objective")]);
  const result = interpretationInvalidResult(error);
  const renderings = [JSON.stringify(interpretationSubmitResponse(result)), JSON.stringify(interpretationSubmitLogFields(result)), String(error), error.message,
    JSON.stringify(error), JSON.stringify(Exit.fail(error))];
  for (const rendering of renderings)
    for (const value of [secret, apiKey, "yyyy", "Ship export support", fx.task.sourceMessageId])
      assert.equal(rendering.includes(value), false, `${rendering.slice(0, 80)} leaks ${value.slice(0, 8)}`);
  assert.deepEqual(interpretationSubmitLogFields(result), {status: "invalid", code: "arguments_schema", issues: "unexpected_key@/*,too_long@/objective"});
  // every status encodes to only its declared fields, closed codes and well-formed paths, whatever the value carried at runtime
  const attemptId = interpretationAttemptId(fx.attemptUuid);
  const results: ReadonlyArray<readonly [InterpretationSubmitResult, Record<string, unknown>]> = [
    [{status: "submitted", attemptId}, {status: "submitted", attemptId, retry: "none"}],
    [{status: "duplicate", attemptId}, {status: "duplicate", attemptId, retry: "none"}],
    [{status: "submitted", attemptId: apiKey}, {status: "unavailable", code: "interpretation_submission_unavailable", retry: "identical"}],
    [interpretationProofResult({status: "pending_proof", code: "native_input_does_not_match_request"}),
      {status: "pending_proof", code: "native_input_does_not_match_request", retry: "identical"}],
    [interpretationProofResult({status: "denied", code: "native_run_not_request_run"}), {status: "denied", code: "native_run_not_request_run", retry: "none"}],
    [{status: "invalid", code: "arguments_schema", issues: [issue("too_long", `/${secret}`)]},
      {status: "invalid", code: "arguments_schema", issues: [issue("too_long", "/*")], retry: "corrected"}],
    [{status: "stale", code: "attempt_not_current"}, {status: "stale", code: "attempt_not_current", retry: "none"}],
    [{status: "conflict", code: "attempt_already_recorded"}, {status: "conflict", code: "attempt_already_recorded", retry: "none"}],
    [{status: "unavailable", code: "submission_unavailable"}, {status: "unavailable", code: "submission_unavailable", retry: "identical"}],
    [{status: "storage_failed", code: "storage_failed"}, {status: "storage_failed", code: "storage_failed", retry: "identical"}],
    [{status: "denied", code: apiKey, cause: secret, arguments: raw} as unknown as InterpretationSubmitResult,
      {status: "denied", code: "native_proof_denied", retry: "none"}],
    [{status: "pending_proof", code: secret} as unknown as InterpretationSubmitResult, {status: "pending_proof", code: "native_proof_pending", retry: "identical"}],
  ];
  for (const [value, expected] of results) {
    const response = interpretationSubmitResponse(value);
    assert.deepEqual(response, expected);
    assert.equal(Exit.isSuccess(Schema.decodeUnknownExit(InterpretationSubmitResponse)(response, {onExcessProperty: "error"})), true, JSON.stringify(response));
    for (const rendering of [JSON.stringify(response), JSON.stringify(interpretationSubmitLogFields(value))])
      for (const leaked of [secret, apiKey]) assert.equal(rendering.includes(leaked), false, rendering);
  }
  assert.deepEqual(interpretationSubmitLogFields({status: "submitted", attemptId}), {status: "submitted"}, "the log carries no model-quoted id");
}), {timeout: 10_000});

it.effect("CT-ISUB-19: an identical replay keeps its attempt; a source edit or renewal of the same task ID needs a new one; a late old-attempt submission is stale", () => Effect.gen(function* () {
  const current = fx.attempt();
  assert.ok(sameInterpretationAttemptKey(current.key, interpretationAttemptKey({bindingGeneration: 3, task: {...fx.task}, requestMessageId: fx.requestMessageId,
    requestText: fx.requestText})), "an identical request has the identical key");
  assert.equal(retainedInterpretationAttempt(current, structuredClone(current.key)), current, "an identical replay keeps the attempt");
  assert.equal(current.key.requestTextHash, interpretationTextHash(fx.requestText));
  // the text hash is the stores' fingerprint of a text, so a task's sourceHash is its source pin hash
  for (const text of [fx.requestText, fx.sourceText, "", "line\nbreak \"quoted\" €"])
    assert.equal(interpretationTextHash(text), createHash("sha256").update(JSON.stringify(text)).digest("hex"));
  // the attempt id is the minted uuid alone: no key value is derived into it
  assert.equal(current.attemptId, `interpretation-attempt:${fx.attemptUuid}`);
  for (const part of [fx.task.id, fx.task.sourceMessageId, fx.requestMessageId, current.key.requestTextHash]) assert.equal(current.attemptId.includes(part), false);
  // the baseline keeps task.id across a source edit (a new source revision) and an approved-definitions renewal (a new request message)
  const editedTask = {...fx.task, sourceMessageId: "source-message-edited", sourceRunId: "source-run-edited", sourceOrdinal: 5,
    sourceHash: interpretationTextHash("Ship export support for every page.")};
  const edited = fx.attempt({uuid: fx.renewedAttemptUuid, task: editedTask, requestMessageId: "supervisor-task-revision:edited"});
  const renewed = fx.attempt({uuid: fx.renewedAttemptUuid, requestMessageId: "supervisor-task-renewal:renewed", requestText: `${fx.requestText} Renewed.`});
  const rebound = fx.attempt({uuid: fx.renewedAttemptUuid, generation: 4});
  for (const [name, next] of [["source edit", edited], ["renewal", renewed], ["binding replacement", rebound]] as const) {
    assert.equal(next.key.taskId, current.key.taskId, `${name} keeps the task id`);
    assert.equal(sameInterpretationAttemptKey(current.key, next.key), false, name);
    assert.equal(retainedInterpretationAttempt(current, next.key), null, `${name} mints a new attempt`);
  }
  // the late submission of the old attempt decodes, then the gate finds it stale; the current attempt's own submission is current
  const late = yield* decode(fx.plainArguments());
  assert.deepEqual(interpretationAttemptGate(late.envelope, {id: fx.task.id, status: "waiting", attempt: renewed}), {status: "stale", code: "attempt_not_current"});
  assert.deepEqual(interpretationAttemptGate(late.envelope, {id: fx.task.id, status: "waiting", attempt: rebound}), {status: "stale", code: "attempt_not_current"});
  assert.deepEqual(interpretationAttemptGate(late.envelope, {id: fx.task.id, status: "waiting", attempt: null}), {status: "stale", code: "attempt_not_current"},
    "a task still on the old prompt has no typed attempt");
  const editedArgs = fx.plainArguments({attemptId: edited.attemptId, sourcePin: {...edited.key.source}, sourceMessageIds: [editedTask.sourceMessageId]});
  const currentSubmission = yield* decode(editedArgs);
  assert.deepEqual(interpretationAttemptGate(currentSubmission.envelope, {id: fx.task.id, status: "dispatching", attempt: edited}), {status: "current"});
  assert.deepEqual(interpretationAttemptGate(currentSubmission.envelope, {id: fx.task.id, status: "inferred", attempt: edited}), {status: "stale", code: "attempt_settled"});
  // the current attempt id quoted with the superseded source pin is an invalid assertion, not a submission of either attempt
  const mispinned = yield* decode(fx.plainArguments({attemptId: edited.attemptId}));
  assert.deepEqual(interpretationAttemptGate(mispinned.envelope, {id: fx.task.id, status: "waiting", attempt: edited}),
    {status: "invalid", code: "attempt_pin_mismatch", issues: [issue("attempt_pin_mismatch", "/sourcePin")]});
  // the old run's item does not prove anything for the renewed request
  const oldRun = fx.proofState(fx.plainArguments());
  assert.deepEqual(verifyInterpretationProof(fx.proofInput(late, oldRun, {request: renewed.key})), {status: "denied", code: "native_run_not_request_run"});
  // the stored pointer round-trips through its schema; a foreign attempt id does not
  assert.deepEqual(Schema.decodeUnknownSync(InterpretationAttempt)(JSON.parse(JSON.stringify(edited))), edited);
  assert.equal(Exit.isFailure(Schema.decodeUnknownExit(InterpretationAttempt)({...edited, attemptId: `attempt:${fx.renewedAttemptUuid}`})), true);
}), {timeout: 10_000});


it.effect("typed interpretation preserves task-local skill pointers and their exact native argument hash", () => Effect.gen(function* () {
  const context = {definitionContext: yield* definitionContext, pendingStart: false};
  const references = ["docs/testing.md"];
  const skills = [".claude/skills/testing/SKILL.md", "plugin:testing"];
  const plan = structuredClone(formalWorkflow);
  Object.assign(plan.plan.nodes[1]!, {references, skills});
  const raw = workflowArguments({workflow: plan});
  const result = yield* decode(raw, context);
  assert.deepEqual(result.rawArguments, raw);
  assert.equal(result.argumentsHash, workflowRequestHash(raw));
  assert.equal(result.payload.kind, "interpretation");
  assert(result.payload.kind === "interpretation");
  const local = result.payload.workflow?.plan?.nodes[1];
  assert(local?.kind === "step");
  assert.deepEqual(local.references, references);
  assert.deepEqual(local.skills, skills);
  const changed = structuredClone(plan);
  Object.assign(changed.plan.nodes[1]!, {skills: ["other:testing"]});
  assert.notEqual((yield* decode(workflowArguments({workflow: changed}), context)).argumentsHash, result.argumentsHash);
  Object.assign(changed.plan.nodes[1]!, {skills: [{skill: {scope: "global", name: "testing"}}]});
  assert.equal((yield* rejected(workflowArguments({workflow: changed}), context)).code, "arguments_schema");
}));
