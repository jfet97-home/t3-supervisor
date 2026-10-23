import assert from "node:assert/strict";
import { it } from "vitest";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import type { WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo } from "../src/project-supervisor-contract.js";
import {
  canonicalAuthoringMaterial,
  canonicalizeProposalDraft,
  interpretationFromFields,
  prepareWorkflowRequest,
  seededNodeIds,
  validateWorkflowApplyAgainstPinnedContext,
  validateWorkflowPlan,
  validateWorkflowRecord,
  workflowInterpretationOutcome,
} from "../src/supervisor-workflow.js";
import { goldenSnapshot } from "./support/c1-workflow-fixture.js";

// the golden catalog with the delivery workflow required, so requirement assessment expands its template
const requiredDelivery: ProjectDefinitionSnapshot = {
  ...goldenSnapshot,
  config: {...goldenSnapshot.config, workflows: goldenSnapshot.config.workflows.map(entry => ({...entry, required: true}))},
  projectConfig: {...goldenSnapshot.projectConfig!, workflows: goldenSnapshot.projectConfig!.workflows.map(entry => ({...entry, required: true}))},
};
const contextFor = (snapshot: ProjectDefinitionSnapshot) => {
  const context = prepareWorkflowRequest("thread-a", "message-a", "Ship the export.", snapshot).context;
  assert.ok(context);
  return context;
};
const draft = {
  requirements: [
    {kind: "workflow", id: "delivery", applies: true, reason: "The export ships."},
    {kind: "step", id: "verify", applies: true, reason: "The task changes behavior."},
  ],
  plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "delivery", reason: "Use the delivery guidance."},
    {kind: "step", definitionId: null, localId: "notes", name: "Write notes", description: "Record release notes.", reason: "The task needs notes."},
  ]},
};
const nodeIdsOf = (group: WorkflowPlanGroupInfo | null): string[] => {
  const ids: string[] = [];
  const walk = (nodes: readonly WorkflowPlanNodeInfo[]) => {
    for (const node of nodes) {
      if (node.kind === "step") ids.push(node.nodeId);
      else if (node.kind === "workflow") {
        ids.push(node.nodeId);
        if (node.plan) walk(node.plan.nodes);
      } else walk(node.nodes);
    }
  };
  if (group) walk(group.nodes);
  return ids;
};
const take = (generator: () => string, count: number): string[] => Array.from({length: count}, () => generator());

it("plan builders allocate every new occurrence from the injected generator in traversal order", {timeout: 10_000}, () => {
  const context = contextFor(requiredDelivery);
  const plan = validateWorkflowPlan(draft, context, seededNodeIds("injected"));
  assert.ok(plan?.plan);
  const ids = nodeIdsOf(plan.plan);
  assert.equal(ids.length, 4);
  assert.deepEqual(ids, take(seededNodeIds("injected"), ids.length));
  assert.deepEqual(plan.requirements.map(item => [item.id, item.state]), [["delivery", "included"], ["verify", "included"]]);
  // the same generator state yields the same plan, so nothing else draws ids
  assert.deepEqual(validateWorkflowPlan(draft, context, seededNodeIds("injected")), plan);
  assert.deepEqual(validateWorkflowRecord(plan, context), plan);

  // the interpretation outcome a submission decodes to draws its occurrence ids from the same injected generator
  const fields = interpretationFromFields({objective: "Ship the export.", reason: "A repository change.", sourceMessageIds: ["message-a"]}, "message-a");
  assert.ok(fields.ok);
  const interpreted = workflowInterpretationOutcome(fields.value, "needed", draft, context, seededNodeIds("injected"));
  assert.ok(interpreted.ok);
  assert.deepEqual(nodeIdsOf(interpreted.value.workflow.plan), ids);

  const material = canonicalAuthoringMaterial(context, 24_000, seededNodeIds("authoring"));
  assert.ok(material.workflow?.plan);
  const materialIds = nodeIdsOf(material.workflow.plan);
  assert.equal(material.localStepExample.nodeId, take(seededNodeIds("authoring"), materialIds.length + 1).at(-1));
  assert.equal(new Set([...materialIds, material.localStepExample.nodeId]).size, materialIds.length + 1);
});

it("a compact draft with a required workflow takes the leading ids of its seeded sequence and repeats exactly", {timeout: 10_000}, () => {
  const context = contextFor(requiredDelivery);
  const canonical = canonicalizeProposalDraft(draft, context, "task-a\0source-hash\0proposal-a");
  assert.ok(canonical.ok);
  const ids = nodeIdsOf(canonical.workflow.plan);
  assert.deepEqual(ids, take(seededNodeIds("task-a\0source-hash\0proposal-a"), ids.length));
  assert.deepEqual(canonicalizeProposalDraft(draft, context, "task-a\0source-hash\0proposal-a"), canonical);
});

it("apply validation assigns added occurrences from the injected generator and keeps existing ids", {timeout: 10_000}, () => {
  const context = contextFor(goldenSnapshot);
  const initial = validateWorkflowPlan({requirements: [{kind: "step", id: "verify", applies: true, reason: "The task changes behavior."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "verify", reason: "Check the changed behavior."}]}}, context, seededNodeIds("initial"));
  assert.ok(initial?.plan);
  const proposal: WorkflowProposalInfo = {status: "proposed", message: "Draft.", workspaceRoot: context.workspaceRoot, revision: context.revision,
    globalRevision: null, ...initial};
  const sourceBinding = {workspaceRoot: context.workspaceRoot, revision: context.revision, globalRevision: null, definitionsStatus: "ready" as const,
    definitionsComplete: true, requirementsKnown: true, taskId: "task-a", proposalId: "proposal-a", sourceHash: "source-hash"};
  const added = {kind: "step", definitionId: null, localId: "notes", name: "Write notes", description: "Record release notes.", reason: "The task needs notes."};
  const applied = validateWorkflowApplyAgainstPinnedContext({plan: {...initial.plan, nodes: [...initial.plan.nodes, added]},
    requirements: proposal.requirements, issues: proposal.issues, sourceBinding}, context, proposal, "task-a", "proposal-a", "source-hash",
  {targetThreadId: "thread-a", mainThreadId: "thread-a"}, [], initial.plan, undefined, seededNodeIds("apply"));
  assert.ok(applied);
  assert.deepEqual(nodeIdsOf(applied.plan), [...nodeIdsOf(initial.plan), take(seededNodeIds("apply"), 1)[0]]);
});
