import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { interpretationPrompt, parseWorkflowInterpretation, prepareWorkflowRequest, validateWorkflowPlan, redact } from "../src/supervisor-workflow.js";

const threadId = "operational-thread";
const sourceId = "source-message";

test("credential redaction stays stable when complete plans are echoed and revalidated", () => {
  const once = redact("secret=github_pat_12345678901234567890 token=[redacted credential] password=hidden Bearer sample-credential");
  assert.equal(redact(once), once);
  assert.equal(once.includes("credential] credential]"), false);
  assert.equal(once.includes("hidden"), false);
});

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
  assert.match(prepared.requestText, /Ordinary task-specific plan steps may be free-text/u);
  assert.match(prepared.requestText, /Project blocks are optional references/u);
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

test("mixed task steps and project blocks normalize names from canonical definitions", () => {
  const prepared = prepareWorkflowRequest(threadId, sourceId, "Add export support", definitions());
  assert.ok(prepared.context);
  const plan = validateWorkflowPlan({
    rules: [
      { index: 0, name: "Model rule label", applies: true, reason: "This task needs focused checks." },
      { index: 1, applies: false, reason: "The public API does not change." },
    ],
    steps: [
      { blockId: "test-plan", name: "Model block label", reason: "Use the project's required test instructions." },
      { blockId: null, name: "Inspect current behavior", reason: "Map the existing export path before changing it." },
    ],
  }, prepared.context);

  assert.deepEqual(plan, {
    rules: [
      { index: 0, name: "Tests first", applies: true, reason: "This task needs focused checks." },
      { index: 1, name: "API compatibility", applies: false, reason: "The public API does not change." },
    ],
    steps: [
      { blockId: "test-plan", name: "Test plan", reason: "Use the project's required test instructions." },
      { blockId: null, name: "Inspect current behavior", reason: "Map the existing export path before changing it." },
    ],
  });

  const parsed = parseWorkflowInterpretation(JSON.stringify({
    ...validInterpretation(),
    workflow: {
      rules: [
        { index: 0, applies: true, reason: "The behavior needs focused checks." },
        { index: 1, applies: false, reason: "No public contract change." },
      ],
      steps: [
        { blockId: "test-plan", reason: "Follow the required test plan." },
        { blockId: null, name: "Review the existing export path", reason: "Understand current behavior." },
      ],
    },
  }), sourceId, prepared.context);
  assert.equal(parsed.workflow.status, "proposed");
  assert.deepEqual(parsed.workflow.steps.map((step) => [step.blockId, step.name]), [
    ["test-plan", "Test plan"],
    [null, "Review the existing export path"],
  ]);
});

test("a ready empty project collection still accepts an all-free task plan", () => {
  const prepared = prepareWorkflowRequest(threadId, sourceId, "Add a regression test", definitions({ rules: [], blocks: [] }));
  assert.ok(prepared.context);
  assert.deepEqual(prepared.context.rules, []);
  assert.deepEqual(prepared.context.blocks, []);

  const parsed = parseWorkflowInterpretation(JSON.stringify({
    objective: "Add a regression test",
    reason: "The request is a concrete code change.",
    sourceMessageIds: [sourceId],
    workflow: {
      rules: [],
      steps: [{ blockId: null, name: "Add a regression test", reason: "Capture the reported behavior." }],
    },
  }), sourceId, prepared.context);
  assert.equal(parsed.workflow.status, "proposed");
  assert.deepEqual(parsed.workflow.steps, [{ blockId: null, name: "Add a regression test", reason: "Capture the reported behavior." }]);
});

test("a free test step cannot satisfy an applicable rule's required E2E block", () => {
  const context = {
    workspaceRoot: "/workspace/feature-branch",
    revision: "revision-e2e",
    rules: [{ name: "Browser coverage", required_blocks: ["e2e-check"] }],
    blocks: [{ id: "e2e-check", name: "Required E2E check" }],
  };

  assert.equal(validateWorkflowPlan({
    rules: [{ index: 0, applies: true, reason: "The change affects the user flow." }],
    steps: [{ blockId: null, name: "Run a generic test", reason: "Check the feature locally." }],
  }, context), null);
});

test("unknown and duplicate project block references are rejected", () => {
  const prepared = prepareWorkflowRequest(threadId, sourceId, "Add export support", definitions());
  assert.ok(prepared.context);
  const rules = [
    { index: 0, applies: true, reason: "The feature needs focused checks." },
    { index: 1, applies: false, reason: "The public API remains stable." },
  ];

  assert.equal(validateWorkflowPlan({
    rules,
    steps: [
      { blockId: "test-plan", reason: "Required block." },
      { blockId: "missing-block", reason: "Unknown reference." },
    ],
  }, prepared.context), null);
  assert.equal(validateWorkflowPlan({
    rules,
    steps: [
      { blockId: "test-plan", reason: "First reference." },
      { blockId: "test-plan", reason: "Duplicate reference." },
    ],
  }, prepared.context), null);
  assert.equal(validateWorkflowPlan({
    rules,
    steps: [{ blockId: "test-plan", reason: "Unknown fields are rejected.", unexpected: true }],
  }, prepared.context), null);
});

test("workflow plans enforce the 100-step, name, and reason caps and redact free text", () => {
  const context = { workspaceRoot: "/workspace/feature-branch", revision: "revision-empty", rules: [], blocks: [] };
  const steps = Array.from({ length: 100 }, (_, index) => ({ blockId: null, name: `Step ${index + 1}`, reason: "A bounded reason." }));
  const hundredSteps = validateWorkflowPlan({ rules: [], steps }, context);
  assert.equal(hundredSteps?.steps.length, 100);
  assert.equal(validateWorkflowPlan({ rules: [], steps: [...steps, { blockId: null, name: "Extra step", reason: "Too many steps." }] }, context), null);
  assert.equal(validateWorkflowPlan({ rules: [], steps: [{ blockId: null, name: "n".repeat(201), reason: "Too long." }] }, context), null);
  assert.equal(validateWorkflowPlan({ rules: [], steps: [{ blockId: null, name: "Valid name", reason: "r".repeat(1001) }] }, context), null);
  assert.equal(validateWorkflowPlan({ rules: [], steps: [{ blockId: null, name: "n".repeat(200), reason: "r".repeat(1000) }] }, context)?.steps.length, 1);

  const redacted = validateWorkflowPlan({ rules: [], steps: [{
    blockId: null,
    name: "token=secret-step-name",
    reason: "Bearer abcdefghijklmnopqrstuvwxyz123456",
  }] }, context);
  assert.deepEqual(redacted?.steps, [{ blockId: null, name: "token=[redacted]", reason: "[redacted credential]" }]);
});

test("requiredRuleIndexes keep previously applicable rules applicable", () => {
  const context = {
    workspaceRoot: "/workspace/feature-branch",
    revision: "revision-required",
    rules: [{ name: "Browser coverage", required_blocks: ["e2e-check"] }],
    blocks: [{ id: "e2e-check", name: "Required E2E check" }],
  };

  assert.equal(validateWorkflowPlan({
    rules: [{ index: 0, applies: false, reason: "The agent negotiated this rule away." }],
    steps: [],
  }, context, new Set([0])), null);
  assert.equal(validateWorkflowPlan({
    rules: [{ index: 0, applies: true, reason: "The agreed rule still applies." }],
    steps: [{ blockId: "e2e-check", reason: "The agreed E2E instructions remain required." }],
  }, context, new Set([0]))?.rules[0]?.applies, true);
  assert.equal(validateWorkflowPlan({ rules: [{ index: 0, applies: true, reason: "Applicable." }], steps: [] }, context, new Set([1])), null);
});
