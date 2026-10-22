import assert from "node:assert/strict";
import { it } from "vitest";
import { record } from "../src/supervisor-native.js";
import { exactFenceRecords, extractWorkflowAgreementRecords } from "../src/supervisor-workflow-agreement.js";
import { extractProjectDefinitionDecisionRecords } from "../src/supervisor-definition-review.js";
import { parseInterpretation, parseWorkflowInterpretation, prepareWorkflowRequest, redact, seededNodeIds } from "../src/supervisor-workflow.js";
import { goldenSnapshot } from "./support/c1-workflow-fixture.js";

const sourceId = "message-a";
// the hand validation that preceded the schema decode, kept as the acceptance oracle
const oracle = (text: string): {objective: string | null; reason: string} | "rejected" => {
  try {
    if (text.length > 16_000) return "rejected";
    const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/u.exec(text.trim());
    const value: unknown = JSON.parse(fenced ? fenced[1]! : text);
    if (!record(value) || Object.keys(value).sort().join(",") !== "objective,reason,sourceMessageIds" ||
      !(value.objective === null || typeof value.objective === "string" && value.objective.trim().length > 0 && value.objective.length <= 2000) ||
      typeof value.reason !== "string" || value.reason.length > 1000 || !Array.isArray(value.sourceMessageIds) || value.sourceMessageIds.length > 1 ||
      value.sourceMessageIds.some(id => id !== sourceId) || value.objective !== null && value.sourceMessageIds.length !== 1) return "rejected";
    return {objective: typeof value.objective === "string" ? redact(value.objective.trim()) : null, reason: redact(value.reason)};
  } catch {return "rejected";}
};
const reply = (value: Record<string, unknown>) => JSON.stringify(value);
const valid = {objective: " Ship the export ", reason: "A repository change.", sourceMessageIds: [sourceId]};
const replies: Array<[string, string]> = [
  ["valid", reply(valid)],
  ["fenced", "```json\n" + reply(valid) + "\n```"],
  ["bare fence", "```\n" + reply(valid) + "\n```"],
  ["null objective without source", reply({objective: null, reason: "Only a greeting.", sourceMessageIds: []})],
  ["null objective with source", reply({objective: null, reason: "Unclear.", sourceMessageIds: [sourceId]})],
  ["objective at bound", reply({...valid, objective: "o".repeat(2000)})],
  ["objective over bound", reply({...valid, objective: "o".repeat(2001)})],
  ["blank objective", reply({...valid, objective: "   "})],
  ["numeric objective", reply({...valid, objective: 3})],
  ["reason at bound", reply({...valid, reason: "r".repeat(1000)})],
  ["reason over bound", reply({...valid, reason: "r".repeat(1001)})],
  ["empty reason", reply({...valid, reason: ""})],
  ["missing reason", reply({objective: valid.objective, sourceMessageIds: [sourceId]})],
  ["excess key", reply({...valid, workflow: null})],
  ["prototype key", reply(valid).replace("{", "{\"__proto__\":1,")],
  ["other source", reply({...valid, sourceMessageIds: ["message-b"]})],
  ["two sources", reply({...valid, sourceMessageIds: [sourceId, sourceId]})],
  ["no source", reply({...valid, sourceMessageIds: []})],
  ["numeric source", reply({...valid, sourceMessageIds: [7]})],
  ["source string", reply({...valid, sourceMessageIds: sourceId})],
  ["array", "[]"],
  ["null", "null"],
  ["malformed", "{\"objective\": \"Ship"],
  ["prose", "I will ship the export."],
  ["oversized", reply({...valid, reason: "r".repeat(16_000)})],
  ["credential", reply({...valid, objective: "Use token=github_pat_12345678901234567890 to ship"})],
];

it("interpretation replies decode with the oracle's exact acceptance, values and fixed failure", {timeout: 10_000}, () => {
  for (const [label, text] of replies) {
    const expected = oracle(text);
    if (expected === "rejected") {
      assert.throws(() => parseInterpretation(text, sourceId), (error: unknown) => error instanceof Error && error.message === "invalid_interpretation", label);
      continue;
    }
    assert.deepEqual(parseInterpretation(text, sourceId), expected, label);
  }
  assert.deepEqual(replies.filter(([, text]) => oracle(text) !== "rejected").map(([label]) => label),
    ["valid", "fenced", "bare fence", "null objective without source", "null objective with source", "objective at bound", "reason at bound", "empty reason", "credential"]);
});

it("workflow replies keep the envelope error for their own keys and the interpretation error for its fields", {timeout: 10_000}, () => {
  const context = prepareWorkflowRequest("thread-a", sourceId, "Ship the export.", goldenSnapshot).context;
  assert.ok(context);
  const workflow = {requirements: [{kind: "step", id: "verify", applies: true, reason: "The task changes behavior."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "verify", reason: "Check the changed behavior."}]}};
  const base = {objective: "Ship the export.", reason: "A repository change.", sourceMessageIds: [sourceId], workflow};
  const failure = (text: string): string => {
    try {
      parseWorkflowInterpretation(text, sourceId, context, seededNodeIds("reply"));
      return "accepted";
    } catch (error) {return error instanceof Error ? error.message : "unknown";}
  };
  assert.equal(failure(reply(base)), "accepted");
  assert.equal(failure(reply({...base, supervision: "needed"})), "accepted");
  assert.equal(failure("```json\n" + reply({...base, supervision: "needed"}) + "\n```"), "accepted");
  for (const text of ["{\"objective\": \"Ship", reply({...base, supervision: "required"}), reply({...base, extra: true}),
    reply({objective: base.objective, reason: base.reason, sourceMessageIds: base.sourceMessageIds}), "[]",
    reply({...base, reason: "r".repeat(128_001)})])
    assert.equal(failure(text), "invalid_workflow_response", text.slice(0, 60));
  for (const text of [reply({...base, objective: 3}), reply({...base, sourceMessageIds: ["message-b"]}), reply({...base, reason: "r".repeat(1001)})])
    assert.equal(failure(text), "invalid_interpretation", text.slice(0, 60));
  assert.equal(parseWorkflowInterpretation(reply({...base, supervision: "needed"}), sourceId, context, seededNodeIds("reply")).workflow.status, "proposed");
  const notNeeded = parseWorkflowInterpretation(reply({...base, supervision: "not_needed", workflow: null}), sourceId, context, seededNodeIds("reply"));
  assert.equal(notNeeded.supervision, "not_needed");
  assert.equal(notNeeded.workflow.plan, null);
});

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
