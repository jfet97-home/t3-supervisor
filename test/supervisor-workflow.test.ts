import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { interpretationPrompt, parseWorkflowInterpretation, prepareWorkflowRequest } from "../src/supervisor-workflow.js";

const threadId = "operational-thread";
const sourceId = "source-message";

const definitions = (overrides: Partial<ProjectDefinitionSnapshot> = {}): ProjectDefinitionSnapshot => ({
  projectId: "project-a",
  threadId,
  workspaceRoot: "/workspace/feature-branch",
  revision: "revision-1",
  editingAvailable: true,
  status: "ready",
  rules: [
    { name: "Tests first", description: "Run focused tests before changes are merged.", required_blocks: ["test-plan"] },
    { name: "API compatibility", description: "Preserve the existing public contract.", required_blocks: ["api-check"] },
  ],
  blocks: [
    { id: "test-plan", name: "Test plan", description: "Check focused behavior.", instructions: "Add a focused test for the behavior.", expected_result: "The test passes." },
    { id: "api-check", name: "API review", description: "Check exported shapes.", instructions: "Review changed public names.", expected_result: "Existing consumers still compile." },
    { id: "optional-docs", name: "Documentation", description: "Document user-facing behavior.", instructions: "Update the usage note.", expected_result: "The behavior is clear." },
  ],
  issues: [],
  ...overrides,
});

const validInterpretation = () => ({
  objective: "Add a project-specific workflow proposal",
  reason: "The request asks for a bounded feature change.",
  sourceMessageIds: [sourceId],
  workflow: {
    rules: [
      { index: 1, applies: false, reason: "No public contract is being changed." },
      { index: 0, applies: true, reason: "The requested feature needs behavior checks." },
    ],
    steps: [
      { blockId: "test-plan", reason: "The applicable rule requires a focused test." },
      { blockId: "optional-docs", reason: "A usage note will clarify the feature." },
    ],
  },
});

test("ready definitions enter the prompt with the exact worktree, revision, rules, and complete block contents", () => {
  const snapshot = definitions();
  const prepared = prepareWorkflowRequest(threadId, sourceId, "Add export support", snapshot);

  assert.equal(prepared.workflow.status, "pending");
  assert.equal(prepared.context?.workspaceRoot, snapshot.workspaceRoot);
  assert.equal(prepared.context?.revision, snapshot.revision);
  assert.deepEqual(prepared.context?.rules.map((rule) => rule.required_blocks), [["test-plan"], ["api-check"]]);
  assert.match(prepared.requestText, /UNTRUSTED_WORKFLOW_ENVELOPE/u);
  assert.match(prepared.requestText, /"workspaceRoot":"\/workspace\/feature-branch"/u);
  assert.match(prepared.requestText, /"revision":"revision-1"/u);
  assert.match(prepared.requestText, /Run focused tests before changes are merged\./u);
  assert.match(prepared.requestText, /Preserve the existing public contract\./u);
  assert.match(prepared.requestText, /Review changed public names\./u);
  assert.match(prepared.requestText, /Existing consumers still compile\./u);
  assert.match(prepared.requestText, /"required_blocks":\["test-plan"\]/u);
  assert.match(prepared.requestText, /Add export support/u);
});

test("non-ready, incomplete, or worktree-mismatched definitions never become an empty rule set", () => {
  for (const status of ["missing", "invalid", "permission_required", "unavailable"] as const) {
    const prepared = prepareWorkflowRequest(threadId, sourceId, "Add export support", definitions({ status }));
    assert.equal(prepared.context, null, `${status} definitions must not be proposed as empty rules`);
    assert.equal(prepared.workflow.status, "unavailable");
    assert.equal(prepared.requestText, interpretationPrompt(threadId, sourceId, "Add export support"));
    assert.doesNotMatch(prepared.requestText, /UNTRUSTED_WORKFLOW_ENVELOPE/u);
  }

  const incomplete = prepareWorkflowRequest(threadId, sourceId, "Add export support", definitions({
    status: "invalid",
    rules: [{ name: "Missing mandatory block", description: "This rule is incomplete.", required_blocks: ["not-loaded"] }],
  }));
  assert.equal(incomplete.context, null);
  assert.equal(incomplete.workflow.status, "unavailable");

  const wrongWorktree = prepareWorkflowRequest(threadId, sourceId, "Add export support", definitions({ threadId: "another-thread" }));
  assert.equal(wrongWorktree.context, null);
  assert.equal(wrongWorktree.workflow.status, "unavailable");
  assert.equal(wrongWorktree.requestText, interpretationPrompt(threadId, sourceId, "Add export support"));
});

test("oversized complete definitions fall back without truncating the rule or block context", () => {
  const oversized = "complete-instruction-".repeat(6_000);
  const prepared = prepareWorkflowRequest(threadId, sourceId, "Add export support", definitions({
    blocks: [{ id: "test-plan", name: "Test plan", description: "Long block", instructions: oversized, expected_result: "Complete." }],
  }));

  assert.equal(prepared.context, null);
  assert.equal(prepared.workflow.status, "unavailable");
  assert.match(prepared.workflow.message, /exceed the prompt limit/u);
  assert.equal(prepared.requestText, interpretationPrompt(threadId, sourceId, "Add export support"));
  assert.ok(prepared.requestText.length < 120_000);
  assert.doesNotMatch(prepared.requestText, /complete-instruction-/u);
});

test("task and definition credentials are redacted before entering the workflow envelope", () => {
  const prepared = prepareWorkflowRequest(threadId, sourceId, "Ship this with Bearer abcdefghijklmnopqrstuvwxyz123456", definitions({
    rules: [{ name: "secret=project-rule-token", description: "Use token=super-secret-rule-value", required_blocks: ["test-plan"] }],
    blocks: [{ id: "test-plan", name: "secret=block-name-token", description: "Credential ghp_abcdefghijklmnopqrstuvwxyz1234", instructions: "Use api_key=do-not-send-this", expected_result: "password:still-secret" }],
  }));

  assert.match(prepared.requestText, /\[redacted credential\]/u);
  assert.match(prepared.requestText, /token=\[redacted\]/u);
  assert.match(prepared.requestText, /api_key=\[redacted\]/u);
  assert.match(prepared.requestText, /password:\[redacted\]/u);
  for (const secret of ["abcdefghijklmnopqrstuvwxyz123456", "super-secret-rule-value", "ghp_abcdefghijklmnopqrstuvwxyz1234", "do-not-send-this", "still-secret"]) {
    assert.equal(prepared.requestText.includes(secret), false);
  }
});

test("workflow interpretation checks every rule, block membership, duplicates, and mandatory applicable blocks", () => {
  const prepared = prepareWorkflowRequest(threadId, sourceId, "Add export support", definitions());
  assert.ok(prepared.context);
  const parsed = parseWorkflowInterpretation(JSON.stringify(validInterpretation()), sourceId, prepared.context);
  assert.equal(parsed.objective, "Add a project-specific workflow proposal");
  assert.equal(parsed.workflow.status, "proposed");
  assert.deepEqual(parsed.workflow.rules.map((rule) => [rule.index, rule.applies]), [[0, true], [1, false]]);
  assert.deepEqual(parsed.workflow.steps.map((step) => step.blockId), ["test-plan", "optional-docs"]);

  const invalidProposals = [
    { ...validInterpretation(), workflow: { ...validInterpretation().workflow, rules: [{ index: 0, applies: true, reason: "Only one decision." }] } },
    { ...validInterpretation(), workflow: { ...validInterpretation().workflow, rules: [
      { index: 0, applies: true, reason: "First decision." }, { index: 0, applies: false, reason: "Duplicate decision." },
    ] } },
    { ...validInterpretation(), workflow: { ...validInterpretation().workflow, steps: [{ blockId: "missing-block", reason: "Not supplied." }] } },
    { ...validInterpretation(), workflow: { ...validInterpretation().workflow, steps: [
      { blockId: "test-plan", reason: "First use." }, { blockId: "test-plan", reason: "Duplicate use." },
    ] } },
    { ...validInterpretation(), workflow: { ...validInterpretation().workflow, steps: [{ blockId: "optional-docs", reason: "Mandatory block omitted." }] } },
    { ...validInterpretation(), workflow: { ...validInterpretation().workflow, rules: [
      { index: 0, applies: true, reason: "Missing second rule decision." }, { index: 1, applies: true, reason: "This rule requires a block." },
    ] } },
  ];
  for (const invalid of invalidProposals) {
    const result = parseWorkflowInterpretation(JSON.stringify(invalid), sourceId, prepared.context);
    assert.equal(result.objective, "Add a project-specific workflow proposal");
    assert.equal(result.workflow.status, "invalid");
    assert.deepEqual(result.workflow.steps, []);
  }
});

test("malformed workflow proposals retain a valid objective while source identity and response caps remain strict", () => {
  const prepared = prepareWorkflowRequest(threadId, sourceId, "Add export support", definitions());
  const context = prepared.context;
  assert.ok(context);
  const malformed = parseWorkflowInterpretation(JSON.stringify({
    objective: "Add a project-specific workflow proposal",
    reason: "The objective is valid despite the malformed workflow.",
    sourceMessageIds: [sourceId],
    workflow: { rules: "not an array", steps: [] },
  }), sourceId, context);
  assert.equal(malformed.objective, "Add a project-specific workflow proposal");
  assert.equal(malformed.workflow.status, "invalid");
  assert.deepEqual(malformed.workflow.rules, []);

  assert.throws(() => parseWorkflowInterpretation(JSON.stringify({
    objective: "Add a project-specific workflow proposal",
    reason: "Wrong source.",
    sourceMessageIds: ["another-source"],
    workflow: { rules: [], steps: [] },
  }), sourceId, context));
  assert.throws(() => parseWorkflowInterpretation("x".repeat(128_001), sourceId, context));

  const redacted = parseWorkflowInterpretation(JSON.stringify({
    objective: "Use token=secret-objective-value",
    reason: "The task contains Bearer abcdefghijklmnopqrstuvwxyz123456.",
    sourceMessageIds: [sourceId],
    workflow: {
      rules: [
        { index: 0, applies: true, reason: "password=secret-rule-value" },
        { index: 1, applies: false, reason: "No API change." },
      ],
      steps: [
        { blockId: "test-plan", reason: "api_key=secret-step-value" },
      ],
    },
  }), sourceId, context);
  assert.equal(redacted.workflow.status, "proposed");
  assert.equal(redacted.objective, "Use token=[redacted]");
  assert.equal(redacted.reason.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(redacted.workflow.rules[0]?.reason, "password=[redacted]");
  assert.equal(redacted.workflow.steps[0]?.reason, "api_key=[redacted]");
});
