import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { workflowDefinitionExpansionLimits } from "../src/project-definitions-contract.js";
import type { WorkflowPlanNodeInfo, WorkflowPlanStepInfo, WorkflowProposalInfo } from "../src/project-supervisor-contract.js";
import {
  parseWorkflowInterpretation,
  prepareWorkflowRequest,
  canonicalAuthoringMaterial,
  proposalContextFromDefinitions,
  proposalContextMatches,
  redact,
  validateWorkflowApplyAgainstPinnedContext,
  type WorkflowApplyDiagnostic,
  validateWorkflowPlan,
  validateWorkflowRecord,
  workflowRecordDiagnostic,
} from "../src/supervisor-workflow.js";
import { makeDefinitionFixture, stepSource, workflowSource } from "./project-definitions-fixture.js";

const threadId = "thread";
const sourceMessageId = "m1";
type Files = Record<string, string>;

const load = async (files: Files, options: {globalEnabled?: boolean; globalFiles?: Files} = {}) => {
  const fixture = makeDefinitionFixture({globalEnabled: options.globalEnabled ?? false});
  for (const [path, contents] of Object.entries(files)) fixture.addFile(fixture.threadRoot!, `.t3-supervisor/${path}`, contents);
  for (const [path, contents] of Object.entries(options.globalFiles ?? {})) fixture.addFile(fixture.globalRoot, `.t3-supervisor/${path}`, contents);
  return {fixture, snapshot: await fixture.loader.load("project", threadId)};
};

const reply = (workflow: unknown, objective = "Ship export support") => JSON.stringify({
  objective,
  reason: "The latest message describes a concrete task.",
  sourceMessageIds: objective ? [sourceMessageId] : [],
  workflow: objective ? workflow : null,
});

const interpret = (snapshot: ProjectDefinitionSnapshot, workflow: unknown, task = "Ship export support") => {
  const prepared = prepareWorkflowRequest(threadId, sourceMessageId, task, snapshot);
  assert.ok(prepared.context, "the task retains a provisional workflow context");
  const result = parseWorkflowInterpretation(reply(workflow), sourceMessageId, prepared.context);
  return {prepared, result};
};

const proposalRecord = (workflow: WorkflowProposalInfo) => ({
  definitionsStatus: workflow.definitionsStatus,
  definitionsComplete: workflow.definitionsComplete,
  requirementsKnown: workflow.requirementsKnown,
  requirements: workflow.requirements,
  issues: workflow.issues,
  plan: workflow.plan,
});

const emptyConfig = {"project.yaml": "required: []\n", "workflows/.gitkeep": ""};
const commonSteps = {
  "steps/inspect.md": stepSource("inspect", "Inspect the current behavior."),
  "steps/e2e.md": stepSource("e2e", "Verify the user flow."),
  "steps/report.md": stepSource("report", "Report findings and remaining risks."),
  "steps/deliver.md": stepSource("deliver", "Prepare the reviewed change for delivery."),
};
const reviewer = (fixed = false) => workflowSource("Reviewer", "  - step: inspect\n  - step: e2e\n  - step: report\n", {fixed});
const delivery = (fixed = false) => workflowSource("Delivery", "  - workflow: reviewer\n  - step: deliver\n", {fixed});

test("redaction is stable while source identities and paths remain exact", () => {
  const once = redact("secret=github_pat_12345678901234567890 token=[redacted credential] password=hidden Bearer sample-credential");
  assert.equal(redact(once), once);
  assert.equal(once.includes("hidden"), false);
  assert.equal(once.includes("12345678901234567890"), false);
});

test("canonical authoring material expands the default, avoids recursive duplicates, and retains required refs", async () => {
  const {snapshot} = await load({
    ...commonSteps,
    "steps/publish.md": stepSource("publish", "Prepare the requested handoff."),
    "project.yaml": "default_workflow: delivery\nrequired:\n  - workflow: delivery\n  - step: e2e\n  - step: publish\n",
    "workflows/reviewer.yaml": reviewer(),
    "workflows/delivery.yaml": delivery(),
  });
  const context = prepareWorkflowRequest(threadId, sourceMessageId, "Ship export support", snapshot).context;
  assert.ok(context);

  const material = canonicalAuthoringMaterial(context);
  assert.equal(material.complete, true);
  assert.deepEqual(material.requiredReferences, ["workflow:delivery", "step:e2e", "step:publish"]);
  assert.deepEqual(material.omittedReferences, []);
  assert.ok(material.workflow?.plan);
  const refs: string[] = [];
  const collect = (nodes: readonly WorkflowPlanNodeInfo[]) => {
    for (const node of nodes) {
      if (node.kind === "step" && node.definitionId) refs.push(`step:${node.definitionId}`);
      else if (node.kind === "workflow") refs.push(`workflow:${node.definitionId}`);
      if (node.kind === "sequence" || node.kind === "parallel") collect(node.nodes);
      else if (node.kind === "workflow" && node.plan) collect(node.plan.nodes);
    }
  };
  collect(material.workflow.plan.nodes);
  assert.equal(refs.filter(reference => reference === "workflow:delivery").length, 1);
  assert.equal(refs.filter(reference => reference === "step:e2e").length, 1);
  assert.equal(refs.filter(reference => reference === "step:publish").length, 1);
  assert.equal(material.localStepExample.kind, "step");
  assert.equal(material.localStepExample.definitionId, null);
  assert.equal(material.localStepExample.source, null);
  assert.equal(material.localStepExample.templatePath, null);
  assert.match(material.localStepExample.nodeId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.deepEqual(validateWorkflowRecord(material.workflow, context), material.workflow);

  const bounded = canonicalAuthoringMaterial(context, 0);
  assert.equal(bounded.workflow, null);
  assert.equal(bounded.complete, false);
  assert.deepEqual(bounded.omittedReferences, ["workflow:delivery", "step:e2e", "step:publish"]);
  assert.deepEqual(bounded.requiredReferences, material.requiredReferences);
  assert.deepEqual(bounded.issues, material.issues);
});

test("canonical authoring material keeps missing and cyclic required sources explicit", async () => {
  const {snapshot} = await load({
    "project.yaml": "required:\n  - step: missing-check\n  - workflow: cycle\n",
    "workflows/cycle.yaml": workflowSource("Cycle", "  - workflow: cycle\n"),
  });
  const context = prepareWorkflowRequest(threadId, sourceMessageId, "Ship export support", snapshot).context;
  assert.ok(context);

  const material = canonicalAuthoringMaterial(context);
  assert.equal(material.complete, false);
  assert.deepEqual(material.requiredReferences, ["step:missing-check", "workflow:cycle"]);
  assert.deepEqual(material.omittedReferences, []);
  assert.ok(material.workflow);
  assert.ok(material.workflow.requirements.some(item => item.state === "unknown" || item.state === "unresolved"));
  assert.ok(material.workflow.plan?.nodes.some(node => node.kind === "step" && node.resolution === "unresolved" ||
    node.kind === "workflow" && node.resolution !== "resolved"));
  assert.ok(material.issues.some(item => item.code === "unresolved_step_reference"));
  assert.ok(material.issues.some(item => item.code === "workflow_cycle_in_plan" || item.code === "workflow_cycle_in_definition"));
});

test("the bounded request includes exact nested template paths for fixed-workflow insertions", async () => {
  const {snapshot} = await load({
    ...commonSteps,
    "project.yaml": "required:\n  - workflow: delivery\n",
    "workflows/reviewer.yaml": reviewer(true),
    "workflows/delivery.yaml": delivery(true),
  });
  const prepared = prepareWorkflowRequest(threadId, sourceMessageId, "Ship export support", snapshot);

  assert.ok(prepared.context);
  assert.equal(prepared.context.promptComplete, true);
  assert.match(prepared.requestText, /"workflowTemplates"/u);
  assert.match(prepared.requestText, /workflow:delivery\/root\/0\/workflow:reviewer\/root\/1/u);
  assert.match(prepared.requestText, /"fixed":true/u);
  assert.ok(prepared.requestText.length <= 120_000);
  assert.equal(prepared.workflow.requirements[0]?.id, snapshot.config.required[0] && "workflow" in snapshot.config.required[0]
    ? snapshot.config.required[0].workflow : "");
});

test("nested reusable paths stay stable across normalization and strict record validation preserves occurrence IDs", async () => {
  const {snapshot} = await load({
    ...commonSteps,
    ...emptyConfig,
    "workflows/reviewer.yaml": reviewer(),
    "workflows/delivery.yaml": delivery(),
  });
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "delivery", reason: "Include delivery."},
  ]}});
  const plan = result.workflow.plan;
  assert.ok(plan);
  assert.equal(result.workflow.status, "proposed");
  const deliveryNode = plan.nodes[0];
  assert.ok(deliveryNode && deliveryNode.kind === "workflow");
  const reviewerNode = deliveryNode.plan?.nodes[0];
  assert.ok(reviewerNode && reviewerNode.kind === "workflow");
  const nestedStep = reviewerNode.plan?.nodes[1];
  assert.ok(nestedStep && nestedStep.kind === "step");
  assert.match(nestedStep.templatePath ?? "", /workflow:delivery\/root\/0\/workflow:reviewer\/root\/1/u);

  const firstIds: string[] = [];
  const collectIds = (nodes: readonly WorkflowPlanNodeInfo[]) => {
    for (const node of nodes) {
      if (node.kind === "step" || node.kind === "workflow") firstIds.push(node.nodeId);
      if (node.kind === "sequence" || node.kind === "parallel") collectIds(node.nodes);
      else if (node.kind === "workflow" && node.plan) collectIds(node.plan.nodes);
    }
  };
  collectIds(plan.nodes);
  assert.equal(new Set(firstIds).size, firstIds.length);
  const strict = validateWorkflowRecord(proposalRecord(result.workflow), prepared.context!);
  assert.ok(strict);
  assert.deepEqual(strict.plan, plan);
  assert.deepEqual(strict.issues.map(item => item.code), result.workflow.issues.map(item => item.code));

  const revalidated = validateWorkflowPlan({requirements: [], plan}, prepared.context!);
  assert.ok(revalidated);
  assert.deepEqual(revalidated.plan, plan);
});

test("strict workflow records ignore object key order while preserving values and array order", async () => {
  const {snapshot} = await load({...commonSteps, "project.yaml": "required:\n  - step: e2e\n  - step: inspect\n"});
  const prepared = prepareWorkflowRequest(threadId, sourceMessageId, "Ship export support", snapshot);
  assert.ok(prepared.context);
  const workflow = validateWorkflowPlan({
    requirements: [
      {kind: "step", id: "e2e", applies: true, reason: "The user flow changes."},
      {kind: "step", id: "inspect", applies: true, reason: "Inspect the changed behavior."},
    ],
    plan: {kind: "sequence", nodes: [
      {kind: "step", definitionId: "e2e", reason: "Verify the user flow."},
      {kind: "step", definitionId: "inspect", reason: "Inspect the changed behavior."},
    ]},
  }, prepared.context);
  assert.ok(workflow);
  const canonical = {
    definitionsStatus: workflow.definitionsStatus,
    definitionsComplete: workflow.definitionsComplete,
    requirementsKnown: workflow.requirementsKnown,
    requirements: workflow.requirements,
    issues: workflow.issues,
    plan: workflow.plan,
  };
  const reverseObjectKeyOrder = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeyOrder(child)]));
  };
  const keyReordered = reverseObjectKeyOrder(canonical);
  assert.deepEqual(validateWorkflowRecord(keyReordered, prepared.context), canonical);

  const changedSource = structuredClone(canonical);
  const sourceStep = changedSource.plan?.nodes[0];
  assert.ok(sourceStep && sourceStep.kind === "step" && sourceStep.source);
  sourceStep.source.path = ".t3-supervisor/steps/changed.md";
  assert.equal(validateWorkflowRecord(changedSource, prepared.context), null);
  assert.equal(workflowRecordDiagnostic(changedSource, prepared.context), "noncanonical_step_node");

  const changedWhitespace = structuredClone(canonical);
  const reasonStep = changedWhitespace.plan?.nodes[0];
  assert.ok(reasonStep && reasonStep.kind === "step");
  reasonStep.reason += " ";
  assert.equal(validateWorkflowRecord(changedWhitespace, prepared.context), null);

  const reversedRequirements = {...canonical, requirements: [...canonical.requirements].reverse()};
  assert.equal(validateWorkflowRecord(reversedRequirements, prepared.context), null);
  assert.equal(workflowRecordDiagnostic(reversedRequirements, prepared.context), "noncanonical_workflow_requirements");
});

test("repeated workflow templates create distinct occurrences without merging their source paths", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig, "workflows/reviewer.yaml": reviewer()});
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "reviewer", reason: "Review the implementation."},
    {kind: "workflow", definitionId: "reviewer", reason: "Review the follow-up."},
  ]}});
  assert.ok(result.workflow.plan);
  const [first, second] = result.workflow.plan.nodes;
  assert.ok(first && first.kind === "workflow" && first.plan && second && second.kind === "workflow" && second.plan);
  assert.notEqual(first.nodeId, second.nodeId);
  assert.equal(first.plan.nodes[0]?.templatePath, second.plan.nodes[0]?.templatePath);
  assert.ok(validateWorkflowRecord(proposalRecord(result.workflow), prepared.context!));
});

test("a required workflow is satisfied by its exact recursive reference", async () => {
  const {snapshot} = await load({
    ...commonSteps,
    "project.yaml": "required:\n  - workflow: delivery\n",
    "workflows/reviewer.yaml": reviewer(),
    "workflows/delivery.yaml": delivery(),
  });
  const {result} = interpret(snapshot, {
    requirements: [{kind: "workflow", id: "delivery", applies: true, reason: "This task needs reviewed delivery."}],
    plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "delivery", reason: "Include reviewed delivery."}]},
  });

  assert.equal(result.workflow.status, "proposed");
  assert.equal(result.workflow.requirements[0]?.state, "included");
});

test("a required fixed workflow nested in a named delivery uses its contextual template paths", async () => {
  const requirements = [{kind: "workflow" as const, id: "protected-check", applies: true as const,
    reason: "This task requires the original inspection and recording sequence."}];
  const {snapshot} = await load({
    ...commonSteps,
    "project.yaml": "default_workflow: delivery\nrequired:\n  - workflow: protected-check\n",
    "workflows/protected-check.yaml": workflowSource("Protected result check", "  - step:\n      id: inspect-results\n      name: Inspect implementation results\n      description: Inspect implementation outputs before recording.\n  - step:\n      id: record-results\n      name: Record implementation results\n      description: Record evidence after inspection.\n", {fixed: true}),
    "workflows/delivery.yaml": workflowSource("Delivery", "  - workflow: protected-check\n  - step: deliver\n"),
  });
  const {prepared, result} = interpret(snapshot, {requirements, plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "delivery", reason: "Use the configured delivery workflow unchanged."},
  ]}});

  assert.equal(result.workflow.status, "proposed");
  assert.equal(result.workflow.requirements[0]?.state, "included");
  assert.ok(result.workflow.plan);
  const deliveryNode = result.workflow.plan.nodes[0];
  assert.ok(deliveryNode && deliveryNode.kind === "workflow" && deliveryNode.plan);
  const protectedCheck = deliveryNode.plan.nodes[0];
  assert.ok(protectedCheck && protectedCheck.kind === "workflow" && protectedCheck.plan);
  assert.equal(protectedCheck.templatePath, "workflow:delivery/root/0");
  assert.equal(protectedCheck.plan.templatePath, "workflow:delivery/root/0/workflow:protected-check/root");
  assert.deepEqual(protectedCheck.plan.nodes.map(node => node.templatePath), [
    "workflow:delivery/root/0/workflow:protected-check/root/0",
    "workflow:delivery/root/0/workflow:protected-check/root/1",
  ]);
  assert.deepEqual(validateWorkflowRecord(proposalRecord(result.workflow), prepared.context!), proposalRecord(result.workflow));

  const context = prepared.context!;
  const sourceHash = "e".repeat(64);
  const applied = validateWorkflowApplyAgainstPinnedContext({
    sourceBinding: {
      workspaceRoot: context.workspaceRoot,
      revision: context.revision,
      globalRevision: context.globalRevision ?? null,
      definitionsStatus: context.status,
      definitionsComplete: true,
      requirementsKnown: true,
      taskId: "nested-required-task",
      proposalId: "nested-required-proposal",
      sourceHash,
    },
    requirements: result.workflow.requirements,
    issues: result.workflow.issues,
    plan: result.workflow.plan,
  }, context, result.workflow, "nested-required-task", "nested-required-proposal", sourceHash,
  {targetThreadId: threadId, mainThreadId: threadId}, [], null);
  assert.ok(applied);

  const reordered = validateWorkflowPlan({
    requirements,
    plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "delivery", nodeId: deliveryNode.nodeId,
      templatePath: deliveryNode.templatePath, reason: deliveryNode.reason,
      plan: {...deliveryNode.plan, nodes: [{...protectedCheck, plan: {...protectedCheck.plan,
        nodes: [...protectedCheck.plan.nodes].reverse()}}, ...deliveryNode.plan.nodes.slice(1)]}}]},
  }, context);
  assert.ok(reordered);
  assert.equal(reordered.requirements[0]?.state, "unresolved");
  assert.ok(reordered.issues.some(item => item.code === "fixed_workflow_changed"));

  const wrongNamespace = validateWorkflowPlan({
    requirements,
    plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "delivery", reason: deliveryNode.reason,
      plan: {...deliveryNode.plan, nodes: [{...protectedCheck,
        plan: {...protectedCheck.plan, templatePath: "workflow:protected-check/root"}}, ...deliveryNode.plan.nodes.slice(1)]}}]},
  }, context);
  assert.equal(wrongNamespace, null);
});

test("a required flexible workflow nested in a named delivery uses contextual paths and still requires accounting", async () => {
  const requirements = [{kind: "workflow" as const, id: "reviewer", applies: true as const,
    reason: "This task requires the reviewer workflow."}];
  const {snapshot} = await load({
    ...commonSteps,
    "project.yaml": "default_workflow: delivery\nrequired:\n  - workflow: reviewer\n",
    "workflows/reviewer.yaml": reviewer(),
    "workflows/delivery.yaml": delivery(),
  });
  const {prepared, result} = interpret(snapshot, {requirements, plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "delivery", reason: "Use the configured delivery workflow."},
  ]}});

  assert.equal(result.workflow.status, "proposed");
  assert.equal(result.workflow.requirements[0]?.state, "included");
  assert.ok(result.workflow.plan);
  const deliveryNode = result.workflow.plan.nodes[0];
  assert.ok(deliveryNode && deliveryNode.kind === "workflow" && deliveryNode.plan);
  const reviewerNode = deliveryNode.plan.nodes[0];
  assert.ok(reviewerNode && reviewerNode.kind === "workflow" && reviewerNode.plan);
  assert.equal(reviewerNode.plan.templatePath, "workflow:delivery/root/0/workflow:reviewer/root");

  const incomplete = validateWorkflowPlan({
    requirements,
    plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "delivery", nodeId: deliveryNode.nodeId,
      templatePath: deliveryNode.templatePath, reason: deliveryNode.reason,
      plan: {...deliveryNode.plan, nodes: [{...reviewerNode,
        plan: {...reviewerNode.plan, nodes: reviewerNode.plan.nodes.slice(0, -1)}}, ...deliveryNode.plan.nodes.slice(1)]}}]},
  }, prepared.context!);
  assert.ok(incomplete);
  assert.equal(incomplete.requirements[0]?.state, "unresolved");
  assert.match(incomplete.requirements[0]?.reason ?? "", /unaccounted or empty declared members/u);
});

test("a required reusable step inside a referenced workflow counts once for the main task", async () => {
  const {snapshot} = await load({
    ...commonSteps,
    "project.yaml": "required:\n  - step: e2e\n",
    "workflows/reviewer.yaml": reviewer(),
  });
  const {result} = interpret(snapshot, {
    requirements: [{kind: "step", id: "e2e", applies: true, reason: "The user flow changes."}],
    plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "reviewer", reason: "Include review."}]},
  });

  assert.equal(result.workflow.requirements[0]?.state, "included");
  assert.equal(result.workflow.status, "proposed");
});

test("applicable but omitted reusable requirements retain their canonical unresolved reason", async () => {
  const cases = [
    {
      kind: "step" as const,
      id: "e2e",
      reason: "UI changes need E2E.",
      files: {...commonSteps, "project.yaml": "required:\n  - step: e2e\n"},
    },
    {
      kind: "workflow" as const,
      id: "reviewer",
      reason: "This task needs review.",
      files: {...commonSteps, "project.yaml": "required:\n  - workflow: reviewer\n", "workflows/reviewer.yaml": reviewer()},
    },
  ];
  const explanation = "The exact reusable definition is not integrated in the plan.";

  for (const scenario of cases) {
    const {snapshot} = await load(scenario.files);
    const {prepared, result} = interpret(snapshot, {
      requirements: [{kind: scenario.kind, id: scenario.id, applies: true, reason: scenario.reason}],
      plan: {kind: "sequence", nodes: []},
    });
    assert.equal(result.workflow.status, "provisional");
    const requirement = result.workflow.requirements[0];
    assert.ok(requirement);
    assert.equal(requirement.state, "unresolved");
    assert.ok(requirement.reason.endsWith(explanation));
    assert.equal(requirement.reason.split(explanation).length - 1, 1);

    const canonical = proposalRecord(result.workflow);
    const strict = validateWorkflowRecord(canonical, prepared.context!);
    assert.ok(strict);
    assert.deepEqual(strict, canonical);
    assert.deepEqual(validateWorkflowRecord(strict, prepared.context!), strict);
  }
});

test("null-plan provisional records round-trip only in their exact service shape", async () => {
  const {snapshot} = await load({...commonSteps, "project.yaml": "required:\n  - step: e2e\n"});
  const {prepared, result} = interpret(snapshot, null);
  assert.equal(result.workflow.status, "provisional");
  assert.equal(result.workflow.plan, null);
  assert.ok(prepared.context);
  const canonical = proposalRecord(result.workflow);
  assert.deepEqual(validateWorkflowRecord(canonical, prepared.context), canonical);

  const marker = canonical.issues.find(item => item.code === "provisional_plan_required");
  assert.ok(marker);
  const rejected: unknown[] = [];
  const changedRequirementState = {...canonical, requirements: canonical.requirements.map((item, index) =>
    index === 0 ? {...item, state: "included" as const} : item)};
  rejected.push(changedRequirementState);
  const changedRequirementReason = {...canonical, requirements: canonical.requirements.map((item, index) =>
    index === 0 ? {...item, reason: `${item.reason} Tampered.`} : item)};
  rejected.push(changedRequirementReason);
  const changedMarkerMessage = {...canonical, issues: canonical.issues.map(item => item.code === "provisional_plan_required"
    ? {...item, message: `${item.message} Tampered.`} : item)};
  rejected.push(changedMarkerMessage);
  const missingMarker = {...canonical, issues: canonical.issues.filter(item => item.code !== "provisional_plan_required")};
  rejected.push(missingMarker);
  const duplicateMarker = {...canonical, issues: [...canonical.issues, marker]};
  rejected.push(duplicateMarker);
  const unexpectedIssue = {...canonical, issues: [...canonical.issues, {path: "/work/project", code: "unexpected", message: "Additional issue."}]};
  rejected.push(unexpectedIssue);
  const unexpectedField = {...canonical, confirmed: true};
  rejected.push(unexpectedField);
  const changedDefinitionsFlag = {...canonical, definitionsComplete: false};
  rejected.push(changedDefinitionsFlag);
  const changedRequirementsFlag = {...canonical, requirementsKnown: false};
  rejected.push(changedRequirementsFlag);
  const nullWithoutMarker = {...canonical, issues: [{path: "/work/project", code: "unexpected", message: marker.message}]};
  rejected.push(nullWithoutMarker);
  for (const candidate of rejected) assert.equal(validateWorkflowRecord(candidate, prepared.context), null);

  const redactedMessage = "token=[redacted credential]";
  const redactedMarker = {...canonical,
    issues: canonical.issues.map(item => item.code === "provisional_plan_required" ? {...item, message: redactedMessage} : item),
    requirements: canonical.requirements.map(item => ({...item, reason: redactedMessage})),
  };
  assert.deepEqual(validateWorkflowRecord(redactedMarker, prepared.context), redactedMarker);
});

test("a provisional marker survives bounded context diagnostics and its record still round-trips", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig});
  const issues = Array.from({length: workflowDefinitionExpansionLimits.maxNodes + 1}, (_, index) => ({
    path: `.t3-supervisor/definitions/${index}.yaml`,
    code: "definition_source_unreadable",
    message: `Definition source ${index} could not be read.`,
  }));
  const context = proposalContextFromDefinitions({...snapshot, issues});
  const result = parseWorkflowInterpretation(reply(null), sourceMessageId, context);
  assert.equal(result.workflow.plan, null);

  const canonical = proposalRecord(result.workflow);
  assert.equal(canonical.issues.filter(item => item.code === "provisional_plan_required").length, 1);
  assert.ok(canonical.issues.some(item => item.code === "supervisor_issue_limit"));
  assert.ok(canonical.issues.length <= workflowDefinitionExpansionLimits.maxNodes);
  assert.deepEqual(validateWorkflowRecord(canonical, context), canonical);
});

test("null-plan expansion limit and depth records round-trip exactly", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig});
  const context = prepareWorkflowRequest(threadId, sourceMessageId, "Ship export support", snapshot).context;
  assert.ok(context);
  const tooWide = Array.from({length: 500}, (_, index) => ({kind: "step", definitionId: null, localId: `support-${index}`,
    name: `Support ${index}`, description: "Bounded support work.", reason: "Help the task."}));
  const limited = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: tooWide}}, context);
  assert.ok(limited);
  assert.equal(limited.plan, null);
  assert.ok(limited.issues.some(item => item.code === "workflow_expansion_limit"));
  assert.deepEqual(validateWorkflowRecord(limited, context), limited);
  const extraLimit = limited.issues.find(item => item.code === "workflow_expansion_limit");
  assert.ok(extraLimit);
  assert.equal(validateWorkflowRecord({...limited, issues: limited.issues.map(item => item.code === "workflow_expansion_limit"
    ? {...item, message: "The expansion issue no longer matches its provisional marker."} : item)}, context), null);
  assert.equal(validateWorkflowRecord({...limited, issues: [...limited.issues, extraLimit]}, context), null);

  let tooDeep: unknown = {kind: "sequence", nodes: []};
  for (let index = 0; index < 40; index++) tooDeep = {kind: "sequence", nodes: [tooDeep]};
  const depthLimited = validateWorkflowPlan({requirements: [], plan: tooDeep}, context);
  assert.ok(depthLimited);
  assert.equal(depthLimited.plan, null);
  assert.ok(depthLimited.issues.some(item => item.code === "workflow_expansion_depth"));
  assert.deepEqual(validateWorkflowRecord(depthLimited, context), depthLimited);
});

test("new workflow-reference wrappers keep null paths while their nested source plan keeps its copied root path", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig, "workflows/reviewer.yaml": reviewer()});
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "reviewer", reason: "Use the available review workflow."},
  ]}});
  assert.ok(prepared.context);
  const plan = result.workflow.plan;
  assert.ok(plan);
  const wrapper = plan.nodes[0];
  assert.ok(wrapper && wrapper.kind === "workflow" && wrapper.plan);
  assert.equal(wrapper.templatePath, null);
  assert.equal(wrapper.plan.templatePath, "workflow:reviewer/root");
  // the service expands a workflow reference itself: the instruction asks only for the compact reference, never for template paths
  const instruction = prepared.requestText.slice(0, prepared.requestText.indexOf("UNTRUSTED_WORKFLOW_ENVELOPE"));
  assert.match(instruction, /which the service expands and keeps intact/u);
  assert.doesNotMatch(instruction, /templatePath|omissions/u);
  assert.ok(validateWorkflowPlan({requirements: [], plan}, prepared.context));

  const wrongWrapper = structuredClone(plan);
  const changed = wrongWrapper.nodes[0];
  assert.ok(changed && changed.kind === "workflow");
  changed.templatePath = "workflow:reviewer/root";
  assert.equal(validateWorkflowPlan({requirements: [], plan: wrongWrapper}, prepared.context), null);
});

test("near-limit required assessment reasons still round-trip after canonical unresolved explanation", async () => {
  const {snapshot} = await load({...commonSteps, "project.yaml": "required:\n  - step: e2e\n"});
  const reason = "R".repeat(1000);
  const {prepared, result} = interpret(snapshot, {
    requirements: [{kind: "step", id: "e2e", applies: true, reason}],
    plan: {kind: "sequence", nodes: []},
  });
  assert.equal(result.workflow.status, "provisional");
  const requirement = result.workflow.requirements[0];
  assert.ok(requirement);
  assert.equal(requirement.state, "unresolved");
  assert.ok(requirement.reason.length > 1000);

  const canonical = proposalRecord(result.workflow);
  const strict = validateWorkflowRecord(canonical, prepared.context!);
  assert.ok(strict);
  assert.deepEqual(strict, canonical);
});

test("fixed workflow members may keep their order while support work is inserted in a new lane", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig, "workflows/reviewer.yaml": reviewer(true)});
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "reviewer", reason: "Include fixed review."},
  ]}});
  const workflow = result.workflow.plan?.nodes[0];
  assert.ok(workflow && workflow.kind === "workflow" && workflow.plan);
  const [inspect, e2e, report] = workflow.plan.nodes;
  assert.ok(inspect && inspect.kind === "step" && e2e && e2e.kind === "step" && report && report.kind === "step");
  const original = (step: WorkflowPlanStepInfo) => ({kind: "step", nodeId: step.nodeId, definitionId: step.definitionId,
    templatePath: step.templatePath, reason: step.reason});
  const revised = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [{kind: "workflow", nodeId: workflow.nodeId,
    definitionId: "reviewer", reason: "Include fixed review.", plan: {kind: "sequence", nodes: [
      original(inspect),
      {kind: "parallel", nodes: [original(e2e), {kind: "step", definitionId: null, localId: "perf-probe", name: "Performance probe",
        description: "Measure the changed path.", reason: "Add a focused measurement."}]},
      original(report),
    ]}}]}}, prepared.context!);

  assert.ok(revised);
  assert.equal(revised.issues.some(item => item.code === "fixed_workflow_changed"), false);
});

test("a fixed outer workflow protects original commitments inside a flexible nested workflow", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig, "workflows/reviewer.yaml": reviewer(), "workflows/delivery.yaml": delivery(true)});
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "delivery", reason: "Include fixed delivery."},
  ]}});
  const outer = result.workflow.plan?.nodes[0];
  assert.ok(outer && outer.kind === "workflow" && outer.plan);
  const inner = outer.plan.nodes[0];
  assert.ok(inner && inner.kind === "workflow" && inner.plan);
  const shortenedInner = {...inner, plan: {...inner.plan, nodes: inner.plan.nodes.slice(1)}};
  const changed = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [{kind: "workflow", nodeId: outer.nodeId,
    definitionId: "delivery", reason: outer.reason, plan: {...outer.plan, nodes: [shortenedInner, ...outer.plan.nodes.slice(1)]}}]}}, prepared.context!);

  assert.ok(changed);
  assert.ok(changed.issues.some(item => item.code === "fixed_workflow_changed"));
});

test("a local filler cannot make a required flexible workflow included after all original members are omitted", async () => {
  const {snapshot} = await load({
    ...commonSteps,
    "project.yaml": "required:\n  - workflow: reviewer\n",
    "workflows/reviewer.yaml": reviewer(),
  });
  const {prepared, result} = interpret(snapshot, {
    requirements: [{kind: "workflow", id: "reviewer", applies: true, reason: "This task requires review."}],
    plan: {kind: "sequence", nodes: [{kind: "workflow", definitionId: "reviewer", reason: "Include review."}]},
  });
  const workflow = result.workflow.plan?.nodes[0];
  assert.ok(workflow && workflow.kind === "workflow" && workflow.plan);
  const omissions = workflow.plan.nodes.map(node => {
    assert.ok(node.kind === "step");
    return {templatePath: node.templatePath, kind: "step", id: node.definitionId, name: node.name, source: node.source,
      reason: "This member does not apply to the requested change."};
  });
  const shell = validateWorkflowPlan({
    requirements: [{kind: "workflow", id: "reviewer", applies: true, reason: "This task requires review."}],
    plan: {kind: "sequence", nodes: [{kind: "workflow", nodeId: workflow.nodeId, definitionId: "reviewer", reason: workflow.reason,
      omissions, plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "note", name: "Release note",
        description: "Write a short note.", reason: "Add supporting work."}]}}]},
  }, prepared.context!);

  assert.ok(shell);
  assert.equal(shell.requirements[0]?.state, "unresolved");
});

test("a same-named local step cannot satisfy a required reusable step", async () => {
  const {snapshot} = await load({
    ...commonSteps,
    "project.yaml": "required:\n  - step: e2e\n",
  });
  const {result} = interpret(snapshot, {
    requirements: [{kind: "step", id: "e2e", applies: true, reason: "The flow changed."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "local-e2e", name: "e2e",
      description: "Run a generic test.", reason: "It sounds similar."}]},
  });

  assert.equal(result.workflow.requirements[0]?.state, "unresolved");
  assert.equal(result.workflow.status, "provisional");
});

test("a missing project scope stays provisional instead of becoming a known empty policy", async () => {
  const {snapshot} = await load({});
  assert.notEqual(snapshot.status, "ready");
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: null, localId: "inspect-task", name: "Inspect the request", description: "Read the relevant code.", reason: "Start with the reported behavior."},
  ]}});

  assert.ok(prepared.context);
  assert.equal(prepared.context.requirementsKnown, false);
  assert.equal(result.workflow.requirementsKnown, false);
  assert.equal(result.workflow.status, "provisional");
});

test("known global requirements survive a missing local scope while the policy remains provisional", async () => {
  const {snapshot} = await load({}, {globalEnabled: true, globalFiles: {
    "project.yaml": "required:\n  - step: shared-e2e\n",
    "steps/shared-e2e.md": stepSource("shared-e2e", "Verify the shared user flow."),
    "workflows/.gitkeep": "",
  }});
  assert.notEqual(snapshot.status, "ready");
  const globalRequirement = snapshot.config.required[0];
  assert.ok(globalRequirement && "step" in globalRequirement);
  const {prepared, result} = interpret(snapshot, {
    requirements: [{kind: "step", id: globalRequirement.step, applies: true, reason: "The user flow changes."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: globalRequirement.step, reason: "Include shared E2E."}]},
  });

  assert.ok(prepared.context!.knownRequirementKeys.includes(`step:${globalRequirement.step}`));
  assert.equal(result.workflow.requirements[0]?.state, "included");
  assert.equal(result.workflow.status, "provisional");
});

test("an invalid global config leaves readable local requirements included or unresolved, not unknown", async () => {
  const {snapshot} = await load({
    ...commonSteps,
    "project.yaml": "required:\n  - step: e2e\n  - step: report\n",
  }, {globalEnabled: true, globalFiles: {
    "project.yaml": "required: nope\n",
    "steps/.gitkeep": "",
    "workflows/.gitkeep": "",
  }});
  const {prepared, result} = interpret(snapshot, {
    requirements: [
      {kind: "step", id: "e2e", applies: true, reason: "The flow changes."},
      {kind: "step", id: "report", applies: true, reason: "Report results."},
    ],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "e2e", reason: "Include flow coverage."}]},
  });

  assert.deepEqual(prepared.context!.knownRequirementKeys, ["step:e2e", "step:report"]);
  assert.deepEqual(result.workflow.requirements.map(item => item.state), ["included", "unresolved"]);
  assert.equal(result.workflow.requirementsKnown, false);
});

test("a long task excerpt does not erase known references or make the unchanged source snapshot stale", async () => {
  const {snapshot} = await load({...commonSteps, "project.yaml": "required:\n  - step: e2e\n"});
  const task = `Fix this failure:\n${"x".repeat(80_000)}`;
  const prepared = prepareWorkflowRequest(threadId, sourceMessageId, task, snapshot);
  assert.ok(prepared.context);

  assert.ok(prepared.requestText.length <= 120_000);
  assert.match(prepared.requestText, /"step":"e2e"/u);
  assert.deepEqual(prepared.workflow.requirements.map(item => item.id), ["e2e"]);
  assert.equal(prepared.workflow.requirementsKnown, false);
  assert.equal(prepared.context.promptComplete, false);
  assert.equal(proposalContextMatches(prepared.context, snapshot), true);

  const provisional = parseWorkflowInterpretation(reply({requirements: [{kind: "step", id: "e2e", applies: true, reason: "Test the flow."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "e2e", reason: "Include flow coverage."}]}}), sourceMessageId, prepared.context);
  assert.equal(provisional.workflow.requirements[0]?.state, "unknown");
  assert.equal(provisional.workflow.status, "provisional");
});

test("long required descriptions stay complete while every configured reference remains in the prompt", async () => {
  const ids = Array.from({length: 12}, (_, index) => `step-${index}`);
  const files: Files = {
    "project.yaml": `required:\n${ids.map(id => `  - step: ${id}`).join("\n")}\n`,
    "workflows/.gitkeep": "",
  };
  for (const id of ids) files[`steps/${id}.md`] = stepSource(id, `Read the full subsystem and report its behavior. ${"detail ".repeat(600)}`);
  const {snapshot} = await load(files);
  const prepared = prepareWorkflowRequest(threadId, sourceMessageId, "Inspect the subsystem", snapshot);
  assert.ok(prepared.context);

  assert.ok(prepared.requestText.length <= 120_000);
  assert.equal(prepared.context.promptComplete, true);
  assert.equal(prepared.workflow.requirementsKnown, true);
  assert.ok(prepared.requestText.includes("detail detail detail"));
  for (const id of ids) assert.match(prepared.requestText, new RegExp(`"step":"${id}"`, "u"));
  assert.deepEqual(prepared.workflow.requirements.map(item => item.id), ids);
});

test("cycles and invented reusable references stay visible in finite provisional plans", async () => {
  const cycle = await load({
    ...commonSteps,
    ...emptyConfig,
    "workflows/a.yaml": workflowSource("A", "  - workflow: b\n"),
    "workflows/b.yaml": workflowSource("B", "  - workflow: a\n"),
  });
  const cycleResult = interpret(cycle.snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "a", reason: "Use the available workflow."},
  ]}}).result;
  assert.ok(cycleResult.workflow.plan);
  assert.equal(cycleResult.workflow.status, "provisional");
  assert.ok(cycleResult.workflow.issues.some(item => item.code === "workflow_cycle_in_plan"));

  const empty = await load(emptyConfig);
  const invented = interpret(empty.snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: "security-audit", name: "Security audit", description: "Organization policy.", reason: "Mandatory."},
  ]}}).result;
  const node = invented.workflow.plan?.nodes[0];
  assert.ok(node && node.kind === "step");
  assert.equal(node.name, "Unresolved step security-audit");
  assert.equal(node.resolution, "unresolved");
  assert.equal(invented.workflow.status, "provisional");
});

test("a 12-workflow chain expands within the shared depth limit and fan-out reports its shared node limit", async () => {
  const chainFiles: Files = {...commonSteps, ...emptyConfig};
  for (let index = 0; index < 12; index++) chainFiles[`workflows/w${index}.yaml`] = workflowSource(`W${index}`,
    index === 11 ? "  - step: inspect\n" : `  - workflow: w${index + 1}\n`);
  const chain = await load(chainFiles);
  assert.equal(chain.snapshot.status, "ready");
  assert.equal(chain.snapshot.complete, true);
  const chainResult = interpret(chain.snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "w0", reason: "Use the chain."},
  ]}}).result;
  assert.ok(chainResult.workflow.plan);

  const fanout = await load({
    ...commonSteps,
    ...emptyConfig,
    "workflows/top.yaml": workflowSource("Top", "  - workflow: mid\n".repeat(8)),
    "workflows/mid.yaml": workflowSource("Mid", "  - workflow: low\n".repeat(8)),
    "workflows/low.yaml": workflowSource("Low", "  - step: inspect\n".repeat(8), {group: "parallel"}),
  });
  const fanoutResult = interpret(fanout.snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "top", reason: "Use the bounded graph."},
  ]}}).result;
  assert.ok(fanoutResult.workflow.plan);
  assert.equal(fanoutResult.workflow.status, "provisional");
  assert.ok(fanoutResult.workflow.issues.some(item => item.code === "workflow_expansion_limit"));
});

test("strict record validation does not double-count repeated nested template expansions", async () => {
  const {snapshot} = await load({
    ...commonSteps,
    ...emptyConfig,
    "workflows/low.yaml": workflowSource("Low", "  - step: inspect\n".repeat(25)),
    "workflows/mid.yaml": workflowSource("Mid", "  - workflow: low\n".repeat(3)),
    "workflows/top.yaml": workflowSource("Top", "  - workflow: mid\n".repeat(3)),
  });
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "top", reason: "Use the complete nested template."},
  ]}});
  assert.equal(result.workflow.status, "proposed");
  assert.ok(result.workflow.plan);
  const countOccurrences = (nodes: readonly WorkflowPlanNodeInfo[]): number => nodes.reduce((sum, node) => sum +
    (node.kind === "sequence" || node.kind === "parallel" ? countOccurrences(node.nodes) : 1) +
    (node.kind === "workflow" && node.plan ? countOccurrences(node.plan.nodes) : 0), 0);
  assert.equal(countOccurrences(result.workflow.plan.nodes), 238);

  const strict = validateWorkflowRecord(proposalRecord(result.workflow), prepared.context!);
  assert.ok(strict);
  assert.deepEqual(strict, proposalRecord(result.workflow));
});

test("long readable definition source text does not make a bounded canonical request incomplete", async () => {
  const longDescription = "A".repeat(2500);
  const {snapshot} = await load({
    ...emptyConfig,
    "steps/inspect.md": stepSource("inspect", longDescription),
  });
  const prepared = prepareWorkflowRequest(threadId, sourceMessageId, "Inspect the current behavior", snapshot);

  assert.equal(prepared.context?.promptComplete, true);
  assert.equal(prepared.context?.steps[0]?.description, longDescription);
  assert.ok(prepared.requestText.length < 64_000);
});

test("unused optional fixed templates do not make a complete task context provisional", async () => {
  const files: Files = {...commonSteps, ...emptyConfig};
  for (let index = 0; index < 14; index++) files[`workflows/optional-${index}.yaml`] = workflowSource(`Optional ${index}`,
    "  - step: inspect\n".repeat(40), {fixed: true});
  const {snapshot} = await load(files);
  const prepared = prepareWorkflowRequest(threadId, sourceMessageId, "Inspect the current behavior", snapshot);

  assert.equal(prepared.context?.promptComplete, true);
  assert.ok(prepared.requestText.length <= 120_000);
  assert.ok(prepared.requestText.length < 64_000);
});

test("a fixed workflow named by the task receives its exact template paths on demand", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig, "workflows/reviewer.yaml": reviewer(true)});
  const prepared = prepareWorkflowRequest(threadId, sourceMessageId, "Use the reviewer workflow to check the change", snapshot);

  assert.equal(prepared.context?.promptComplete, true);
  assert.match(prepared.requestText, /workflow:reviewer\/root\/0/u);
});

test("apply validation retains existing occurrence IDs and execution state while assigning one ID to a new local step", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig});
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: null, localId: "task-check", name: "Task check", description: "Check the requested behavior.", reason: "Start here."},
  ]}});
  const context = prepared.context!;
  const original = result.workflow;
  assert.equal(original.status, "proposed", JSON.stringify({status: original.status, context: {status: context.status, complete: context.complete,
    promptComplete: context.promptComplete, requirementsKnown: context.requirementsKnown}, issues: original.issues.map(item => item.code), plan: original.plan}));
  assert.ok(original.plan);
  const existing = original.plan.nodes[0];
  assert.ok(existing && existing.kind === "step");
  const contributor = "00000000-0000-4000-8000-000000000001";
  const sourceHash = "a".repeat(64);
  const candidate = {
    sourceBinding: {
      workspaceRoot: context.workspaceRoot,
      revision: context.revision,
      globalRevision: context.globalRevision ?? null,
      definitionsStatus: context.status,
      definitionsComplete: true,
      requirementsKnown: true,
      taskId: "task-a",
      proposalId: "proposal-a",
      sourceHash,
    },
    requirements: original.requirements,
    issues: original.issues,
    plan: {kind: "sequence", nodes: [
      {kind: "step", nodeId: existing.nodeId, definitionId: null, localId: "task-check", name: existing.name,
        description: existing.description, reason: existing.reason, status: "underway", contributorThreadIds: [contributor]},
      {kind: "step", definitionId: null, localId: "follow-up", name: "Follow up", description: "Check the complete behavior.", reason: "Add a follow-up."},
    ]},
  };
  const applied = validateWorkflowApplyAgainstPinnedContext(candidate, context, original, "task-a", "proposal-a",
    sourceHash, {targetThreadId: threadId, mainThreadId: threadId}, [], original.plan);
  assert.equal(validateWorkflowApplyAgainstPinnedContext(candidate, context, original, "task-a", "proposal-a",
    "b".repeat(64), {targetThreadId: threadId, mainThreadId: threadId}, [], original.plan), null);

  assert.ok(applied);
  const retained = applied.plan.nodes[0];
  const created = applied.plan.nodes[1];
  assert.ok(retained && retained.kind === "step" && created && created.kind === "step");
  assert.equal(retained.nodeId, existing.nodeId);
  assert.equal(retained.status, "underway");
  assert.deepEqual(retained.contributorThreadIds, [contributor]);
  assert.match(created.nodeId, /^[0-9a-f-]{36}$/iu);
  assert.notEqual(created.nodeId, existing.nodeId);
});

test("apply validation rejects a missing ID when it would regenerate an existing local occurrence", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig});
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: null, localId: "local-b", name: "Local B", description: "Existing local work.", reason: "Keep it."},
  ]}});
  const context = prepared.context!;
  const original = result.workflow;
  assert.ok(original.plan);
  const sourceHash = "a".repeat(64);
  const candidate = {
    sourceBinding: {workspaceRoot: context.workspaceRoot, revision: context.revision, globalRevision: context.globalRevision ?? null,
      definitionsStatus: context.status, definitionsComplete: true, requirementsKnown: true, taskId: "task-a", proposalId: "proposal-a", sourceHash},
    requirements: original.requirements,
    issues: original.issues,
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "local-b", name: "Local B",
      description: "Existing local work.", reason: "Keep it."}]},
  };

  assert.equal(validateWorkflowApplyAgainstPinnedContext(candidate, context, original, "task-a", "proposal-a",
    sourceHash, {targetThreadId: threadId, mainThreadId: threadId}, [], original.plan), null);
});

test("apply validation reports bounded field diagnostics only for known local-step shape failures", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig});
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: null, localId: "baseline", name: "Baseline", description: "Baseline work.", reason: "Keep it."},
  ]}});
  const context = prepared.context!;
  const original = result.workflow;
  const sourceHash = "d".repeat(64);
  assert.ok(original.plan);
  const sourceBinding = {
    workspaceRoot: context.workspaceRoot,
    revision: context.revision,
    globalRevision: context.globalRevision ?? null,
    definitionsStatus: context.status,
    definitionsComplete: true,
    requirementsKnown: true,
    taskId: "task-a",
    proposalId: "proposal-a",
    sourceHash,
  };
  const target = {targetThreadId: threadId, mainThreadId: threadId};
  const nestedPlan = (node: unknown) => ({kind: "sequence", nodes: [{kind: "parallel", nodes: [{kind: "sequence", nodes: [node]}]}]});
  const cases: Array<{name: string; node: Record<string, unknown>; expected: WorkflowApplyDiagnostic}> = [
    {
      name: "missing definitionId",
      node: {kind: "step", localId: "secret-local-id", name: "secret-name", description: "secret-description", reason: "Add local work."},
      expected: {code: "local_step_definition_id_required", path: "/input/plan/nodes/0/nodes/0/nodes/0/definitionId", expected: "definitionId: null"},
    },
    {
      name: "missing localId",
      node: {kind: "step", definitionId: null, name: "secret-name", description: "secret-description", reason: "Add local work."},
      expected: {code: "local_step_local_id_required", path: "/input/plan/nodes/0/nodes/0/nodes/0/localId",
        expected: "non-empty string up to 200 characters"},
    },
    {
      name: "missing name",
      node: {kind: "step", definitionId: null, localId: "secret-local-id", description: "secret-description", reason: "Add local work."},
      expected: {code: "local_step_name_required", path: "/input/plan/nodes/0/nodes/0/nodes/0/name",
        expected: "non-empty string within the plan text limit"},
    },
    {
      name: "missing description",
      node: {kind: "step", definitionId: null, localId: "secret-local-id", name: "secret-name", reason: "Add local work."},
      expected: {code: "local_step_description_required", path: "/input/plan/nodes/0/nodes/0/nodes/0/description",
        expected: "non-empty string within the plan text limit"},
    },
    {
      name: "copied templatePath",
      node: {kind: "step", definitionId: null, localId: "secret-local-id", name: "secret-name", description: "secret-description",
        reason: "Add local work.", templatePath: "workflow:secret-parent/template-secret"},
      expected: {code: "local_step_template_path_not_allowed", path: "/input/plan/nodes/0/nodes/0/nodes/0/templatePath",
        expected: "omit templatePath or set it to null for a new local step"},
    },
  ];

  for (const item of cases) {
    const diagnostic: {value: WorkflowApplyDiagnostic | null} = {value: null};
    const candidate = {sourceBinding, requirements: original.requirements, issues: original.issues, plan: nestedPlan(item.node)};
    assert.equal(validateWorkflowApplyAgainstPinnedContext(candidate, context, original, "task-a", "proposal-a",
      sourceHash, target, [], original.plan, diagnostic), null, item.name);
    assert.deepEqual(diagnostic.value, item.expected, item.name);
    assert.doesNotMatch(JSON.stringify(diagnostic.value), /secret-local-id|secret-name|secret-description|secret-parent|template-secret/u);
  }

  const genericDiagnostic: {value: WorkflowApplyDiagnostic | null} = {value: null};
  const staleBinding = {...sourceBinding, revision: "stale-revision"};
  assert.equal(validateWorkflowApplyAgainstPinnedContext({sourceBinding: staleBinding, requirements: original.requirements,
    issues: original.issues, plan: nestedPlan({kind: "step", definitionId: null, localId: "secret-local-id", name: "secret-name",
      description: "secret-description", reason: "Add local work."})}, context, original, "task-a", "proposal-a", sourceHash,
  target, [], original.plan, genericDiagnostic), null);
  assert.equal(genericDiagnostic.value, null, "source-pin failures keep the generic result");
});

test("only accepted or current fixed occurrences constrain the first workflow apply", async () => {
  const {snapshot} = await load({...commonSteps, ...emptyConfig, "workflows/reviewer.yaml": reviewer(true)});
  const {prepared, result} = interpret(snapshot, {requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "reviewer", reason: "Use fixed review if it fits."},
    {kind: "step", definitionId: null, localId: "release-note", name: "Release note", description: "Summarize the change.", reason: "Prepare a handoff."},
  ]}});
  const context = prepared.context!;
  const original = result.workflow;
  assert.equal(original.status, "proposed");
  assert.ok(original.plan);
  const fixed = original.plan.nodes[0];
  const local = original.plan.nodes[1];
  assert.ok(fixed && fixed.kind === "workflow" && fixed.fixed);
  assert.ok(local && local.kind === "step");
  const sourceHash = "c".repeat(64);
  const candidate = {
    sourceBinding: {workspaceRoot: context.workspaceRoot, revision: context.revision, globalRevision: context.globalRevision ?? null,
      definitionsStatus: context.status, definitionsComplete: true, requirementsKnown: true, taskId: "task-a", proposalId: "proposal-a", sourceHash},
    requirements: original.requirements,
    issues: original.issues,
    plan: {kind: "sequence", nodes: [{kind: "step", nodeId: local.nodeId, definitionId: null, localId: local.localId,
      name: local.name, description: local.description, reason: local.reason}]},
  };
  const target = {targetThreadId: threadId, mainThreadId: threadId};

  assert.ok(validateWorkflowApplyAgainstPinnedContext(candidate, context, original, "task-a", "proposal-a", sourceHash, target, [], null));
  assert.equal(validateWorkflowApplyAgainstPinnedContext(candidate, context, original, "task-a", "proposal-a", sourceHash, target, [original.plan], null), null);
  assert.equal(validateWorkflowApplyAgainstPinnedContext(candidate, context, original, "task-a", "proposal-a", sourceHash, target, [], original.plan), null);
});

test("a manifest too large for one interpretation request keeps the reader and names what it omitted", async () => {
  const {snapshot} = await load({"project.yaml": "required:\n  - step: scope\n", "steps/scope.md": stepSource("scope", "Scope guidance.")});
  const reader = {supervisorThreadId: "supervisor-root:reader", bindingGeneration: 3};
  const envelopeOf = (text: string) => JSON.parse(text.split("UNTRUSTED_WORKFLOW_ENVELOPE\n")[1]!.split("\nEND_UNTRUSTED_WORKFLOW_ENVELOPE")[0]!);
  const wide = {...snapshot, workflows: Array.from({length: 40}, (_, index) => ({id: `workflow-${index}`, name: `Workflow ${index}`,
    description: "A workflow with many members.", fixed: false, sequence: Array.from({length: 400}, () => ({step: "scope"}))}))};
  const counted = prepareWorkflowRequest(threadId, sourceMessageId, "Implement the export.", wide as ProjectDefinitionSnapshot, {reader});
  const countedEnvelope = envelopeOf(counted.requestText);
  assert.ok(counted.requestText.length <= 120_000, `bounded: ${counted.requestText.length}`);
  assert.deepEqual(countedEnvelope.reader, {tool: "t3-supervisor-workflows workflow_read", ...reader,
    toolInputs: {definitions: {...reader, view: "definitions", definitionIds: []}}}, "the reader and its ready arguments are kept rather than switching to the inline protocol");
  assert.match(counted.requestText, /workflow_read/u);
  assert.equal(countedEnvelope.definitions.workflows.length, 40);
  assert.equal(countedEnvelope.definitions.workflows[0].memberCount, 400);
  assert.deepEqual(countedEnvelope.definitions.manifestOmitted, {summariesAndMembers: true, steps: 0, workflows: 0,
    read: "workflow_read view definitions returns the full manifest; definitionIds return complete definitions."});
  assert.equal(counted.context?.promptComplete, true, "complete definitions stay retrievable, so the request is not downgraded");
  const many = {...snapshot, workflows: Array.from({length: 4000}, (_, index) => ({id: `workflow-${index}-${"x".repeat(40)}`, name: `Workflow ${index} ${"y".repeat(40)}`,
    description: "A workflow.", fixed: false, sequence: [{step: "scope"}]}))};
  const prefix = prepareWorkflowRequest(threadId, sourceMessageId, "Implement the export.", many as ProjectDefinitionSnapshot, {reader});
  const prefixEnvelope = envelopeOf(prefix.requestText);
  assert.ok(prefix.requestText.length <= 120_000 && prefixEnvelope.reader, "an ID prefix still fits with the reader");
  assert.equal(prefixEnvelope.definitions.workflows.length + prefixEnvelope.definitions.manifestOmitted.workflows, 4000, "the omitted count is exact");
  assert.ok(prefixEnvelope.definitions.manifestOmitted.workflows > 0);
});

test("reader-based interpretation carries a manifest, earlier unresolved requests and reader coordinates instead of the catalog", async () => {
  const guidance = (id: string) => `${id} guidance. ${"Preserve the requested outcome, the evidence and the completion rules. ".repeat(24)}END_${id}`;
  const stepIds = ["scope", "evidence", "design", "data", "implement", "prevent", "verify", "correctness", "fit", "findings", "deliver"];
  const files: Files = {"project.yaml": "required:\n  - step: scope\n  - workflow: review\n"};
  for (const id of stepIds) files[`steps/${id}.md`] = stepSource(id, guidance(id));
  files["workflows/review.yaml"] = workflowSource("Review", "  - parallel:\n      - step: correctness\n      - step: fit\n  - step: findings\n", {fixed: true});
  for (const id of ["change", "plan", "investigate", "release"])
    files[`workflows/${id}.yaml`] = workflowSource(id, `${stepIds.slice(0, 7).map(step => `  - step: ${step}\n`).join("")}  - workflow: review\n  - step: deliver\n`);
  const {snapshot} = await load(files);
  assert.equal(snapshot.status, "ready");
  const inline = prepareWorkflowRequest(threadId, sourceMessageId, "Recover the failed worktree with Nix, then continue.", snapshot);
  const prepared = prepareWorkflowRequest(threadId, sourceMessageId, "Recover the failed worktree with Nix, then continue.", snapshot, {
    reader: {supervisorThreadId: "supervisor-root:reader", bindingGeneration: 3},
    earlierMessages: [{messageId: "m0", text: "https://issues.example/browse/PROJ-1"}],
  });
  assert.ok(prepared.context?.promptComplete, "the complete catalog stays available through the reader");
  assert.ok(prepared.requestText.length < 12_000, `manifest interpretation stays small: ${prepared.requestText.length}`);
  assert.ok(inline.requestText.length > prepared.requestText.length * 2, "the inline catalog is no longer pushed when the reader is available");
  assert.equal(prepared.requestText.includes("END_scope"), false, "complete step guidance is read on demand");
  assert.match(prepared.requestText, /workflow_read/u);
  assert.doesNotMatch(prepared.requestText, /Do not use tools, MCP/u);
  assert.match(prepared.requestText, /a bootstrap, setup or recovery instruction is a step toward that earlier request/u);
  assert.match(prepared.requestText, /"supervision" \("needed"\|"not_needed"\)/u);
  const envelope = JSON.parse(prepared.requestText.split("UNTRUSTED_WORKFLOW_ENVELOPE\n")[1]!.split("\nEND_UNTRUSTED_WORKFLOW_ENVELOPE")[0]!);
  assert.deepEqual(envelope.earlierMessages, [{messageId: "m0", text: "https://issues.example/browse/PROJ-1"}]);
  // the reader carries its coordinates and the exact ready-to-copy workflow_read arguments for selected definitions
  assert.deepEqual(envelope.reader, {tool: "t3-supervisor-workflows workflow_read", supervisorThreadId: "supervisor-root:reader", bindingGeneration: 3,
    toolInputs: {definitions: {supervisorThreadId: "supervisor-root:reader", bindingGeneration: 3, view: "definitions", definitionIds: []}}});
  assert.deepEqual(Object.keys(envelope.reader.toolInputs.definitions).sort(), ["bindingGeneration", "definitionIds", "supervisorThreadId", "view"],
    "only advertised workflow_read fields");
  assert.deepEqual(envelope.definitions.workflows.find((item: {id: string}) => item.id === "review").members, ["step:correctness", "step:fit", "step:findings"]);
  assert.ok(envelope.definitions.steps.every((item: {summary: string}) => item.summary.length <= 260));
});

test("a semantic not-needed decision returns no workflow and is distinct from an unclear task", async () => {
  const {snapshot} = await load({"project.yaml": "required:\n  - step: inspect\n", "steps/inspect.md": stepSource("inspect"),
    "workflows/check.yaml": workflowSource("Check", "  - step: inspect\n")});
  assert.equal(snapshot.status, "ready");
  const context = prepareWorkflowRequest(threadId, sourceMessageId, "Thank the colleague for the documents.", snapshot).context!;
  const result = parseWorkflowInterpretation(JSON.stringify({objective: "Thank the colleague for the documents", reason: "A short self-contained message.",
    sourceMessageIds: [sourceMessageId], supervision: "not_needed", workflow: null}), sourceMessageId, context);
  assert.equal(result.supervision, "not_needed");
  assert.equal(result.workflow.plan, null);
  assert.throws(() => parseWorkflowInterpretation(JSON.stringify({objective: "Thank the colleague", reason: "Short.", sourceMessageIds: [sourceMessageId],
    supervision: "not_needed", workflow: {requirements: [], plan: {kind: "sequence", nodes: []}}}), sourceMessageId, context), /invalid_workflow_response/u,
    "a not-needed decision cannot also smuggle a plan");
  assert.throws(() => parseWorkflowInterpretation(JSON.stringify({objective: "Thank", reason: "Short.", sourceMessageIds: [sourceMessageId],
    supervision: "maybe", workflow: null}), sourceMessageId, context), /invalid_workflow_response/u);
  const needed = parseWorkflowInterpretation(JSON.stringify({objective: "Ship the export", reason: "A repository change.", sourceMessageIds: [sourceMessageId],
    supervision: "needed", workflow: {requirements: [{kind: "step", id: "inspect", applies: true, reason: "Check it."}],
      plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "inspect", reason: "Check the export."}]}}}), sourceMessageId, context);
  assert.equal(needed.workflow.status, "proposed");
});
