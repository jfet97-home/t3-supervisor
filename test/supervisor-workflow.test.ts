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
  assert.match(prepared.requestText, /For a newly added workflow-reference node, set its own templatePath to null/u);
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
