import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Schema} from "effect";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ProjectSupervisorSnapshot} from "../src/project-supervisor-contract.js";
import {WorkflowProgressSnapshotSchema} from "../src/workflow-progress.js";
import {PlanJourney, TaskAlignment, TaskOutcome} from "../ui/src/workflow-journey.js";
import {fixtureJourney, journeyCases} from "./ui-fixture/journey.js";
import {FixtureModel, fixtureIds, isScenarioName} from "./ui-fixture/scenarios.js";

const example = (phase: typeof journeyCases[number]) => fixtureJourney(phase, fixtureIds.projectA, fixtureIds.threadA1, "fixture-supervisor-a1", 1_800_000_000_000);

it("the complete nested plan retains parallel boundaries and every step beyond eight without completing its parent", () => {
  const {progress} = example("nested");
  const html = renderToStaticMarkup(createElement(PlanJourney, {node: progress.workflows[0]!.plan!, live: true}));
  assert.match(html, /aria-label="Parallel branches"/);
  assert.match(html, /aria-label="Plan sequence"/);
  assert.match(html, /Retry case 9: refund webhook/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /Verify webhook behavior<small>Workflow<\/small><\/span><span class="step-state">In progress/);
  assert.doesNotMatch(html, /first 8|percent|%/);
});

it("a proposal never borrows completed step states from the saved plan", () => {
  const {task} = example("completed");
  const html = renderToStaticMarkup(createElement(PlanJourney, {node: task.workflow!.plan!}));
  assert.match(html, /Proposed/);
  assert.doesNotMatch(html, />Completed<|aria-current="step"|state-completed/);
});

it("journey disclosures expose separate read-only file and skill lists", () => {
  const {task} = example("working");
  const html = renderToStaticMarkup(createElement(PlanJourney, {node: task.workflow!.plan!, live: true}));
  assert.match(html, /<strong>References<\/strong>/);
  assert.match(html, /<strong>Skills<\/strong>/);
  assert.match(html, /<code>docs\/payments\/webhook-retries.md<\/code>/);
  assert.match(html, /webhook-retry-idempotency-validation\/SKILL.md/);
  assert.match(html, /<code>plugin:review<\/code>/);
  assert.doesNotMatch(html, /href="(?:docs|\.claude)/);
});

it("accepted commitments are labelled as agreed without implying execution", () => {
  const {task} = example("completed");
  const html = renderToStaticMarkup(createElement(PlanJourney, {node: task.workflow!.plan!, context: "agreed"}));
  assert.match(html, /In agreed plan/);
  assert.doesNotMatch(html, />Proposed<|>Completed<|state-completed/);
});

it("alignment keeps missing acceptance and stale acceptance distinct from an agreed plan", () => {
  const proposal = renderToStaticMarkup(createElement(TaskAlignment, {task: example("proposal").task}));
  assert.match(proposal, /Awaiting acceptance/);
  assert.match(proposal, /Acceptance has not been recorded/);
  assert.doesNotMatch(proposal, /Accepted this plan/);
  const stale = renderToStaticMarkup(createElement(TaskAlignment, {task: example("stale").task}));
  assert.match(stale, /Earlier acceptance is out of date/);
  assert.doesNotMatch(stale, /Accepted this plan/);
  const agreed = renderToStaticMarkup(createElement(TaskAlignment, {task: example("agreed").task}));
  assert.match(agreed, /Accepted this plan/);
  assert.match(agreed, /fixture-agent-acceptance/);
});

it("an accepted earlier proposal does not approve a new draft and a pending draft is still being prepared", () => {
  const {task} = example("agreed");
  const html = renderToStaticMarkup(createElement(TaskAlignment, {task: {...task, workflowProposalId: "new-proposal", workflow: {...task.workflow!, status: "pending"}}}));
  assert.match(html, /Plan update awaiting agreement/);
  assert.match(html, /Preparing the plan/);
  assert.match(html, /Earlier plan accepted; update not accepted/);
  assert.doesNotMatch(html, /Accepted this plan|Prepared the plan/);
});

it("a stopped task cannot retain the completed outcome heading and source text stays escaped", () => {
  const {progress} = example("completed");
  const html = renderToStaticMarkup(createElement(TaskOutcome, {assessment: {...progress.workflows[0]!.assessment!, summary: "<script>untrusted</script>"}, stopped: true, fallback: "No assessment"}));
  assert.match(html, /Supervision stopped/);
  assert.doesNotMatch(html, /Task completed|<script>/);
  assert.match(html, /&lt;script&gt;/);
});

it("every journey fixture decodes through the production contracts and stays scoped to its environment", () => {
  const model = new FixtureModel(() => 1_800_000_000_000);
  for (const phase of journeyCases) {
    assert.ok(isScenarioName(`journey-${phase}`), `journey-${phase} must be exposed by the HTTP fixture`);
    model.setJourney(phase);
    const supervisor = Schema.decodeUnknownSync(ProjectSupervisorSnapshot)(model.projectSupervisor(fixtureIds.projectA, fixtureIds.threadA1));
    const progress = Schema.decodeUnknownSync(WorkflowProgressSnapshotSchema)(model.workflowProgress({projectId: fixtureIds.projectA, mainThreadId: fixtureIds.threadA1}, 1_800_000_000_000));
    assert.equal(supervisor.tasks.find(task => task.threadId === fixtureIds.threadA1)!.id, "fixture-task-email");
    assert.ok(progress.workflows.every(workflow => workflow.assessment?.taskId === (phase === "retained" ? "fixture-earlier-task" : "fixture-task-email")));
    model.switchEnvironment("b");
    assert.equal(model.projectSupervisor(fixtureIds.projectA, fixtureIds.threadA1).tasks.some(task => task.id === "fixture-task-email"), false);
    model.switchEnvironment("a");
  }
});

it("a planned workflow opens to reveal active descendants without borrowing their assessment", () => {
  const {progress} = example("nested-attention");
  const root = progress.workflows[0]!.plan!;
  if (!("nodes" in root)) throw new Error("expected fixture sequence");
  const branch = root.nodes[2]!;
  if (branch.kind !== "workflow" || !branch.plan || !("nodes" in branch.plan)) throw new Error("expected fixture workflow");
  for (const status of ["underway", "needs_attention"] as const) {
    const node = {...branch, plan: {...branch.plan, nodes: branch.plan.nodes.map(child => ({...child, status}))}};
    const live = renderToStaticMarkup(createElement(PlanJourney, {node, live: true}));
    assert.match(live, /state-planned"><details class="journey-step" open=""/);
    assert.match(live, /Verify webhook behavior<small>Workflow<\/small><\/span><span class="step-state">Planned/);
    const agreed = renderToStaticMarkup(createElement(PlanJourney, {node, context: "agreed"}));
    assert.doesNotMatch(agreed, /open=""|aria-current="step"/);
  }
});
