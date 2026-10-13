import assert from "node:assert/strict";
import test from "node:test";
import { extractWorkflowAgreementRecords, parseWorkflowAgreementRecord, workflowAgreementPlanHash } from "../src/supervisor-workflow-agreement.js";
import type { ProposalContext } from "../src/supervisor-workflow.js";

const context: ProposalContext = {
  workspaceRoot: "/work/project",
  revision: "revision-1",
  rules: [
    {name: "Required verification", required_blocks: ["verify"]},
    {name: "Optional publication", required_blocks: ["publish"]},
  ],
  blocks: [{id: "verify", name: "Verify changes"}, {id: "publish", name: "Publish results"}],
};

const proposal = (overrides: Record<string, unknown> = {}) => ({
  taskId: "task-1",
  proposalId: "task-1",
  workspaceRoot: context.workspaceRoot,
  revision: context.revision,
  workflow: {
    rules: [
      {index: 0, applies: true, reason: "The task changes behavior."},
      {index: 1, applies: false, reason: "The task does not publish."},
    ],
    steps: [
      {blockId: "verify", reason: "Check the behavior."},
      {blockId: null, name: "Review the handoff", reason: "Prepare a clear handoff."},
    ],
  },
  ...overrides,
});

test("only named fenced records parse and normalized free steps survive", () => {
  assert.deepEqual(extractWorkflowAgreementRecords("yes", "workflow-acceptance"), []);
  const content = ["A proposal follows.", "", "```workflow-proposal", JSON.stringify(proposal()), "```", "", "```workflow-acceptance",
    JSON.stringify(proposal({proposalId: "old"})), "```"].join("\n");
  const records = extractWorkflowAgreementRecords(content, "workflow-proposal");
  assert.equal(records.length, 1);
  const parsed = parseWorkflowAgreementRecord(records[0], "task-1", context.workspaceRoot, context.revision, context, new Set([0]));
  assert.ok(parsed);
  assert.deepEqual(parsed.workflow.steps.map(step => step.blockId), ["verify", null]);
  assert.equal(parsed.workflow.steps[1]?.name, "Review the handoff");
  assert.deepEqual(extractWorkflowAgreementRecords(content, "workflow-acceptance").length, 1);
});

test("context and required applicable rules must match the complete current definitions", () => {
  const omitted = proposal({workflow: {...proposal().workflow, steps: [{blockId: null, name: "Skip verification", reason: "No reason."}]}});
  assert.equal(parseWorkflowAgreementRecord(omitted, "task-1", context.workspaceRoot, context.revision, context, new Set([0])), null);
  const inapplicable = proposal({workflow: {...proposal().workflow, rules: [
    {index: 0, applies: false, reason: "Changed my mind."},
    {index: 1, applies: false, reason: "Still not relevant."},
  ]}});
  assert.equal(parseWorkflowAgreementRecord(inapplicable, "task-1", context.workspaceRoot, context.revision, context, new Set([0])), null);
  assert.equal(parseWorkflowAgreementRecord(proposal(), "another-task", context.workspaceRoot, context.revision, context, new Set([0])), null);
  assert.equal(parseWorkflowAgreementRecord(proposal(), "task-1", context.workspaceRoot, "new-revision", context, new Set([0])), null);
});

test("normalized plan fingerprints bind the definition revision and every ordered step", () => {
  const first = parseWorkflowAgreementRecord(proposal(), "task-1", context.workspaceRoot, context.revision, context, new Set([0]));
  const reordered = parseWorkflowAgreementRecord(proposal({workflow: {...proposal().workflow, steps: [
    {blockId: null, name: "Review the handoff", reason: "Prepare a clear handoff."},
    {blockId: "verify", reason: "Check the behavior."},
  ]}}), "task-1", context.workspaceRoot, context.revision, context, new Set([0]));
  assert.ok(first && reordered);
  assert.notEqual(workflowAgreementPlanHash(first), workflowAgreementPlanHash(reordered));
});
