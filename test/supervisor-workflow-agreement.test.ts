import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { parseWorkflowInterpretation, prepareWorkflowRequest, validateWorkflowPlan, type WorkflowPlanValue } from "../src/supervisor-workflow.js";
import { extractWorkflowAgreementRecords, parseWorkflowAgreementRecord, parseWorkflowProposalRecord, workflowAgreementPlanHash } from "../src/supervisor-workflow-agreement.js";

const definitions = (overrides: Partial<ProjectDefinitionSnapshot> = {}): ProjectDefinitionSnapshot => ({
  projectId: "project-a",
  threadId: "thread-a",
  workspaceRoot: "/work/project",
  globalOnly: false,
  globalRevision: null,
  revision: "revision-ready",
  editingAvailable: true,
  status: "ready",
  steps: [
    {id: "verify", name: "Verify behavior", description: "Check the changed behavior.", origin: "project", path: ".t3-supervisor/steps/verify.md", sourceId: "project:verify"},
    {id: "publish", name: "Prepare handoff", description: "Write a concise handoff.", origin: "project", path: ".t3-supervisor/steps/publish.md", sourceId: "project:publish"},
  ],
  workflows: [],
  config: {required: [{step: "verify"}]},
  projectConfig: {required: [{step: "verify"}]},
  complete: true,
  sources: [],
  issues: [],
  ...overrides,
});

const contextFor = (snapshot: ProjectDefinitionSnapshot) => prepareWorkflowRequest("thread-a", "message-a", "Check this task.", snapshot).context!;

const validPlan = (snapshot: ProjectDefinitionSnapshot): WorkflowPlanValue => {
  const context = contextFor(snapshot);
  const workflow = validateWorkflowPlan({
    requirements: [{kind: "step", id: "verify", applies: true, reason: "The task changes behavior."}],
    plan: {kind: "sequence", nodes: [
      {kind: "step", definitionId: "verify", reason: "Check the changed behavior."},
      {kind: "step", definitionId: "publish", reason: "Prepare the requested handoff."},
    ]},
  }, context);
  assert.ok(workflow);
  return workflow;
};

const proposal = (snapshot: ProjectDefinitionSnapshot, workflow = validPlan(snapshot), overrides: Record<string, unknown> = {}) => ({
  taskId: "task-a",
  proposalId: "proposal-a",
  workspaceRoot: snapshot.workspaceRoot,
  revision: snapshot.revision,
  workflow,
  ...overrides,
});

const fence = (kind: "workflow-proposal" | "workflow-acceptance", value: unknown): string =>
  `\`\`\`${kind}\n${JSON.stringify(value)}\n\`\`\``;

test("only exact named fences yield canonical plans with stable node identities", () => {
  const snapshot = definitions();
  const value = proposal(snapshot);
  const text = ["A plain yes is not a record.", "", fence("workflow-proposal", value), "", fence("workflow-acceptance", value)].join("\n");
  const records = extractWorkflowAgreementRecords(text, "workflow-proposal");
  assert.equal(records.length, 1);
  const parsed = parseWorkflowProposalRecord(records[0], "task-a", contextFor(snapshot));
  assert.ok(parsed);
  assert.deepEqual(parsed.workflow, value.workflow);
  assert.equal(parsed.workflow.plan?.nodes[0]?.kind, "step");
  assert.deepEqual(extractWorkflowAgreementRecords(text, "workflow-acceptance").length, 1);
  assert.deepEqual(extractWorkflowAgreementRecords("```json\n{}\n```", "workflow-acceptance"), []);
});

test("formal acceptance requires a complete current valid context and resolved requirements", () => {
  const snapshot = definitions();
  const context = contextFor(snapshot);
  const value = proposal(snapshot);
  assert.ok(parseWorkflowAgreementRecord(value, "task-a", context));
  assert.equal(parseWorkflowAgreementRecord(value, "another-task", context), null);
  assert.equal(parseWorkflowAgreementRecord(proposal(snapshot, value.workflow, {revision: "changed"}), "task-a", context), null);

  const missingRequired = validateWorkflowPlan({
    requirements: [{kind: "step", id: "verify", applies: true, reason: "Verification is required."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "skip-verify", name: "Skip verification", description: "No check.", reason: "Skip."}]},
  }, context);
  assert.ok(missingRequired);
  assert.equal(parseWorkflowAgreementRecord(proposal(snapshot, missingRequired), "task-a", context), null);
});

test("invalid and revision-null definitions can be shown provisionally but cannot be formally accepted", () => {
  for (const snapshot of [
    definitions({status: "invalid", revision: "observed-invalid-revision", projectConfig: null, complete: true,
      issues: [{path: ".t3-supervisor/project.yaml", code: "project_configuration_invalid", message: "Repair local configuration."}]}),
    definitions({status: "missing", revision: null, projectConfig: null, complete: false,
      issues: [{path: ".t3-supervisor/project.yaml", code: "configuration_missing", message: "Create project configuration."}]}),
  ]) {
    const context = contextFor(snapshot);
    const plan = validateWorkflowPlan({
      requirements: [{kind: "step", id: "verify", applies: "unknown", reason: "The effective configuration is incomplete."}],
      plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "bounded-review", name: "Review the available context",
        description: "State what remains unknown.", reason: "Continue useful bounded planning."}]},
    }, context);
    assert.ok(plan);
    assert.equal(plan.requirementsKnown, false);
    const record = proposal(snapshot, plan);
    assert.ok(parseWorkflowProposalRecord(record, "task-a", context));
    assert.equal(parseWorkflowAgreementRecord(record, "task-a", context), null);
  }
});

test("an exact null-plan provisional echo is a proposal but never a formal agreement", () => {
  const snapshot = definitions();
  const context = contextFor(snapshot);
  const provisional = parseWorkflowInterpretation(JSON.stringify({
    objective: "Check this task.",
    reason: "The latest message describes a concrete task.",
    sourceMessageIds: ["message-a"],
    workflow: null,
  }), "message-a", context).workflow;
  assert.equal(provisional.plan, null);
  assert.equal(provisional.issues.filter(item => item.code === "provisional_plan_required").length, 1);
  const echoed = proposal(snapshot, {
    definitionsStatus: provisional.definitionsStatus,
    definitionsComplete: provisional.definitionsComplete,
    requirementsKnown: provisional.requirementsKnown,
    requirements: provisional.requirements,
    issues: provisional.issues,
    plan: provisional.plan,
  });

  assert.ok(parseWorkflowProposalRecord(echoed, "task-a", context));
  assert.equal(parseWorkflowAgreementRecord(echoed, "task-a", context), null);
});

test("plan fingerprints bind source revision, nested identity, and meaningful order", () => {
  const snapshot = definitions();
  const context = contextFor(snapshot);
  const first = proposal(snapshot);
  const firstParsed = parseWorkflowAgreementRecord(first, "task-a", context);
  assert.ok(firstParsed);
  const plan = firstParsed.workflow.plan;
  assert.ok(plan);
  const reordered = proposal(snapshot, {...firstParsed.workflow, plan: {...plan, nodes: [...plan.nodes].reverse()}});
  const reorderedParsed = parseWorkflowAgreementRecord(reordered, "task-a", context);
  assert.ok(reorderedParsed);
  assert.notEqual(workflowAgreementPlanHash(firstParsed), workflowAgreementPlanHash(reorderedParsed));
  const nextRevision = parseWorkflowAgreementRecord(proposal(definitions({revision: "revision-next"})), "task-a", contextFor(definitions({revision: "revision-next"})));
  assert.ok(nextRevision);
  assert.notEqual(workflowAgreementPlanHash(firstParsed), workflowAgreementPlanHash(nextRevision));
});
