import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { decodeInterpretationSubmission, type InterpretationArgumentsInvalid } from "../src/interpretation-submission.js";
import { record } from "../src/supervisor-native.js";
import { exactFenceRecords, extractWorkflowAgreementRecords } from "../src/supervisor-workflow-agreement.js";
import { extractProjectDefinitionDecisionRecords } from "../src/supervisor-definition-review.js";
import { prepareWorkflowRequest, redact } from "../src/supervisor-workflow.js";
import { goldenSnapshot } from "./support/c1-workflow-fixture.js";
import * as fx from "./support/s6e-prep-interpretation.js";

// the interpretation is a typed tool submission (plan 3.12): its fields arrive as decoded argument objects, never as final-chat text,
// so no fence, JSON text or reply syntax exists any more; the field acceptance of the old reply decode is kept as the oracle
const sourceId = fx.task.sourceMessageId;
// the hand validation that preceded the schema decode, kept as the acceptance oracle of the interpretation fields
const oracle = (value: Record<string, unknown>): {objective: string | null; reason: string} | "rejected" => {
  if (!record(value) || Object.keys(value).sort().join(",") !== "objective,reason,sourceMessageIds" ||
    !(value.objective === null || typeof value.objective === "string" && value.objective.trim().length > 0 && value.objective.length <= 2000) ||
    typeof value.reason !== "string" || value.reason.length > 1000 || !Array.isArray(value.sourceMessageIds) || value.sourceMessageIds.length > 1 ||
    value.sourceMessageIds.some(id => id !== sourceId) || value.objective !== null && value.sourceMessageIds.length !== 1) return "rejected";
  return {objective: typeof value.objective === "string" ? redact(value.objective.trim()) : null, reason: redact(value.reason)};
};
// the attempt's envelope the fields are submitted with
const envelope = (() => {
  const {supervisorThreadId, bindingGeneration, taskId, attemptId, sourcePin} = fx.plainArguments();
  return {supervisorThreadId, bindingGeneration, taskId, attemptId, sourcePin};
})();
const valid = {objective: " Ship the export ", reason: "A repository change.", sourceMessageIds: [sourceId]};
const submissions: Array<[string, Record<string, unknown>]> = [
  ["valid", valid],
  ["null objective without source", {objective: null, reason: "Only a greeting.", sourceMessageIds: []}],
  ["null objective with source", {objective: null, reason: "Unclear.", sourceMessageIds: [sourceId]}],
  ["objective at bound", {...valid, objective: "o".repeat(2000)}],
  ["objective over bound", {...valid, objective: "o".repeat(2001)}],
  ["blank objective", {...valid, objective: "   "}],
  ["numeric objective", {...valid, objective: 3}],
  ["reason at bound", {...valid, reason: "r".repeat(1000)}],
  ["reason over bound", {...valid, reason: "r".repeat(1001)}],
  ["empty reason", {...valid, reason: ""}],
  ["missing reason", {objective: valid.objective, sourceMessageIds: [sourceId]}],
  ["excess key", {...valid, workflow: null}],
  ["prototype key", JSON.parse(JSON.stringify(valid).replace("{", "{\"__proto__\":1,")) as Record<string, unknown>],
  ["other source", {...valid, sourceMessageIds: ["message-b"]}],
  ["two sources", {...valid, sourceMessageIds: [sourceId, sourceId]}],
  ["no source", {...valid, sourceMessageIds: []}],
  ["numeric source", {...valid, sourceMessageIds: [7]}],
  ["source string", {...valid, sourceMessageIds: sourceId}],
  ["oversized", {...valid, reason: "r".repeat(16_000)}],
  ["credential", {...valid, objective: "Use token=github_pat_12345678901234567890 to ship"}],
];

it.effect("interpretation submissions decode their fields with the oracle's exact acceptance and values, without any reply syntax", () => Effect.gen(function* () {
  for (const [label, value] of submissions) {
    const expected = oracle(value);
    const decoded = yield* Effect.exit(decodeInterpretationSubmission({...envelope, ...value}, {definitionContext: null, pendingStart: false}));
    if (expected === "rejected") {
      assert.ok(Exit.isFailure(decoded), label);
      continue;
    }
    assert.ok(Exit.isSuccess(decoded), label);
    assert.deepEqual(decoded.value.payload, {kind: "interpretation", ...expected, startRequested: false}, label);
  }
  assert.deepEqual(submissions.filter(([, value]) => oracle(value) !== "rejected").map(([label]) => label),
    ["valid", "null objective without source", "null objective with source", "objective at bound", "reason at bound", "empty reason", "credential"]);
}), {timeout: 10_000});

it.effect("workflow submissions report schema paths for their own keys and semantic codes for the interpretation fields", () => Effect.gen(function* () {
  const context = prepareWorkflowRequest("thread-a", sourceId, "Ship the export.", goldenSnapshot).context;
  assert.ok(context);
  const workflow = {requirements: [{kind: "step", id: "verify", applies: true, reason: "The task changes behavior."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "verify", reason: "Check the changed behavior."}]}};
  const base = {...envelope, objective: "Ship the export.", reason: "A repository change.", sourceMessageIds: [sourceId], supervision: "needed", workflow};
  const decode = (value: Record<string, unknown>) => Effect.exit(decodeInterpretationSubmission(value, {definitionContext: context, pendingStart: false}));
  const failure = (value: Record<string, unknown>) => Effect.map(decode(value), (exit): [string, string] => {
    if (Exit.isSuccess(exit)) return ["accepted", ""];
    const error = exit.cause.reasons.find(reason => reason._tag === "Fail")?.error as InterpretationArgumentsInvalid;
    return [error.code, error.issues[0]?.path ?? ""];
  });
  assert.deepEqual(yield* failure(base), ["accepted", ""]);
  const withoutSupervision: Record<string, unknown> = {...base};
  delete withoutSupervision.supervision;
  for (const [value, path] of [[{...base, supervision: "required"}, "/supervision"], [{...base, extra: true}, "/*"], [withoutSupervision, "/supervision"],
    [{...base, objective: 3}, "/objective"], [{...base, reason: "r".repeat(1001)}, "/reason"]] as const)
    assert.deepEqual(yield* failure(value), ["arguments_schema", path], path);
  assert.deepEqual(yield* failure({...base, sourceMessageIds: ["message-b"]}), ["source_message_ids_mismatch", "/sourceMessageIds"]);
  assert.deepEqual(yield* failure({...base, supervision: "not_needed"}), ["not_needed_workflow_present", "/workflow"]);
  const proposed = yield* decode(base);
  assert.ok(Exit.isSuccess(proposed) && proposed.value.payload.kind === "interpretation" && proposed.value.payload.workflow?.status === "proposed");
  const notNeeded = yield* decode({...base, supervision: "not_needed", workflow: null});
  assert.ok(Exit.isSuccess(notNeeded) && notNeeded.value.payload.kind === "interpretation");
  assert.equal(notNeeded.value.payload.kind === "interpretation" ? notNeeded.value.payload.supervision : null, "not_needed");
  assert.equal(notNeeded.value.payload.kind === "interpretation" ? notNeeded.value.payload.workflow?.plan : undefined, null);
}), {timeout: 10_000});

it("fenced protocol records decode JSON bodies and keep malformed ones inert", {timeout: 10_000}, () => {
  const text = ["```workflow-acceptance", "{\"taskId\":\"task-a\",\"proposalId\":\"proposal-a\",\"digest\":\"d\"}", "```",
    "```workflow-acceptance", "{\"taskId\": \"task-a\",", "```",
    "```workflow-acceptance", "", "```",
    "```workflow-acceptance", "[1, 2]", "```"].join("\n");
  assert.deepEqual(exactFenceRecords(text, "workflow-acceptance", 20), [
    {value: {taskId: "task-a", proposalId: "proposal-a", digest: "d"}, malformedJson: false, lineCount: 1},
    {value: null, malformedJson: true, lineCount: 1},
    {value: null, malformedJson: true, lineCount: 1},
    {value: [1, 2], malformedJson: false, lineCount: 1},
  ]);
  assert.deepEqual(extractWorkflowAgreementRecords(text, "workflow-acceptance"),
    [{taskId: "task-a", proposalId: "proposal-a", digest: "d"}, [1, 2]]);

  const decisions = ["```project-definition-decision", "{\"taskId\":\"task-1\"}", "```",
    "```project-definition-decision", "{\"taskId\":", "```",
    "```project-definition-decision", "\"text\"", "```"].join("\n");
  assert.deepEqual(extractProjectDefinitionDecisionRecords(decisions), [{taskId: "task-1"}, "text"]);
});
