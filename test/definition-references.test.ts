import assert from "node:assert/strict";
import {test} from "node:test";
import {Schema} from "effect";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {parseDefinitionStep, parseDefinitionWorkflow} from "../src/project-definitions.js";
import {ProjectDefinitions} from "../src/project-definitions-contract.js";
import {WorkflowPlanGroupSchema, type WorkflowPlanGroupInfo} from "../src/project-supervisor-contract.js";
import {fixedOccurrencesPreserved, prepareWorkflowRequest, validateWorkflowPlan, validateWorkflowRecord} from "../src/supervisor-workflow.js";
import {DefinitionsContent} from "../ui/src/project-definitions.js";
import {DefinitionReferences} from "../ui/src/definition-references.js";
import {makeDefinitionFixture} from "./project-definitions-fixture.js";

const step = (references?: unknown) => `---\nid: review\nname: Review\ndescription: Review the change.\n${references === undefined ? "" : `references: ${JSON.stringify(references)}\n`}---\n`;
const workflow = (references?: unknown, localReferences?: unknown) => `name: Delivery\ndescription: Deliver the change.\nfixed: true\n${references === undefined ? "" : `references: ${JSON.stringify(references)}\n`}sequence:\n  - step: review\n  - step:\n      id: local\n      name: Local check\n      description: Check the local code.\n${localReferences === undefined ? "" : `      references: ${JSON.stringify(localReferences)}\n`}`;
const paths = ["docs/review.md", "skills/use-project/SKILL.md", "src/example.ts"];

test("steps, workflows and inline local steps support omitted, empty, single and multiple file references", () => {
  for (const references of [undefined, [], [paths[0]!], paths]) {
    assert.deepEqual(parseDefinitionStep("review", step(references)).references, references);
    const parsed = parseDefinitionWorkflow("delivery", workflow(references, references));
    assert.deepEqual(parsed.references, references);
    const local = parsed.sequence?.[1];
    assert(local && "step" in local && typeof local.step !== "string");
    assert.deepEqual(local.step.references, references);
  }
});

test("file references reject malformed lists, absolute paths and URLs consistently", () => {
  for (const references of [null, "docs/review.md", {}, [1], [""], [" docs/a.md"], ["/tmp/a.md"], ["~/a.md"], ["C:/a.md"],
    ["https://example.com/a.md"], ["docs\\a.md"], ["docs/a\n.md"], ["x".repeat(4097)], Array.from({length: 101}, () => "a.md")]) {
    assert.throws(() => parseDefinitionStep("review", step(references)), /references/u);
    assert.throws(() => parseDefinitionWorkflow("delivery", workflow(references)), /references/u);
    assert.throws(() => parseDefinitionWorkflow("delivery", workflow(undefined, references)), /references/u);
  }
  assert.deepEqual(parseDefinitionStep("review", step(["../shared/guide.md", "docs/With spaces.md", "docs/日本語.txt"])).references,
    ["../shared/guide.md", "docs/With spaces.md", "docs/日本語.txt"]);
});

const fixture = async (global = false) => {
  const f = makeDefinitionFixture({globalEnabled: global});
  f.addFile(f.threadRoot!, ".t3-supervisor/project.yaml", "required: []\ndefault_workflow: delivery\n");
  f.addFile(f.threadRoot!, ".t3-supervisor/steps/review.md", step(paths));
  f.addFile(f.threadRoot!, ".t3-supervisor/workflows/delivery.yaml", workflow(["docs/delivery.md"], ["src/local.ts"]));
  if (global) {
    f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", "required: []\n");
    f.addFile(f.globalRoot, ".t3-supervisor/steps/review.md", step(["docs/shared.md"]));
    f.addFile(f.globalRoot, ".t3-supervisor/workflows/delivery.yaml", workflow(["docs/shared-workflow.md"], ["src/shared.ts"]));
  }
  return {f, definitions: await f.loader.load(f.projectId, "thread")};
};

test("definition loading and API schemas preserve references without reading their targets, including shared definitions", async () => {
  const {f, definitions} = await fixture(true);
  assert.equal(definitions.status, "ready");
  const decoded = Schema.decodeUnknownSync(ProjectDefinitions)(definitions);
  assert.deepEqual(decoded, definitions);
  assert.deepEqual(decoded.steps.find(item => item.origin === "project")?.references, paths);
  assert.deepEqual(decoded.steps.find(item => item.origin === "global")?.references, ["docs/shared.md"]);
  const shared = decoded.workflows.find(item => item.origin === "global");
  assert.deepEqual(shared?.references, ["docs/shared-workflow.md"]);
  const local = shared?.sequence?.[1];
  assert(local && "step" in local && typeof local.step !== "string");
  assert.deepEqual(local.step.references, ["src/shared.ts"]);
  assert(f.calls.every(call => call.path.startsWith(".t3-supervisor")), "no referenced file is opened or probed");
});

test("reference lists survive model context, canonical plans and strict record schemas; forged reusable paths are rejected", async () => {
  const {definitions} = await fixture();
  const prepared = prepareWorkflowRequest("thread", "message", "Deliver the change", definitions);
  assert(prepared.context);
  const envelope = JSON.parse(prepared.requestText.split("UNTRUSTED_WORKFLOW_ENVELOPE\n")[1]!.split("\nEND_UNTRUSTED_WORKFLOW_ENVELOPE")[0]!);
  assert.deepEqual(envelope.definitions.steps[0].references, paths);
  assert.deepEqual(envelope.definitions.workflows[0].references, ["docs/delivery.md"]);
  const result = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "delivery", reason: "Deliver this task."},
    {kind: "step", definitionId: null, localId: "additional", name: "Additional", description: "Check extra behavior.", references: ["src/extra.ts"], reason: "Needed for this task."},
  ]}}, prepared.context);
  assert(result?.plan);
  const wrapper = result.plan.nodes[0];
  assert(wrapper?.kind === "workflow" && wrapper.plan);
  assert.deepEqual(wrapper.references, ["docs/delivery.md"]);
  const [reusable, local] = wrapper.plan.nodes;
  assert(reusable?.kind === "step" && local?.kind === "step");
  assert.deepEqual(reusable.references, paths);
  assert.deepEqual(local.references, ["src/local.ts"]);
  const additional = result.plan.nodes[1];
  assert(additional?.kind === "step");
  assert.deepEqual(additional.references, ["src/extra.ts"]);
  assert.deepEqual(Schema.decodeUnknownSync(WorkflowPlanGroupSchema)(result.plan), result.plan);
  assert.deepEqual(validateWorkflowRecord(result, prepared.context), result);
  assert.equal(validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: "review", references: ["forged.md"], reason: "Changed the supporting files."},
  ]}}, prepared.context), null);

  for (const target of [wrapper, reusable, local]) {
    const changed: NonNullable<typeof result> = structuredClone(result);
    const find = (group: WorkflowPlanGroupInfo | null): void => {
      if (!group) return;
      for (const node of group.nodes) {
        if (node.kind === "sequence" || node.kind === "parallel") find(node);
        else {
          if ("nodeId" in node && node.nodeId === target.nodeId) Object.assign(node, {references: ["different.md"]});
          if (node.kind === "workflow") find(node.plan);
        }
      }
    };
    find(changed.plan);
    assert.equal(validateWorkflowRecord(changed, prepared.context), null);
    assert.equal(fixedOccurrencesPreserved(result.plan, changed.plan!), false);
  }
});

test("read-only references escape text and appear on reusable, workflow and local definition views", async () => {
  const {definitions} = await fixture();
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions}));
  for (const path of [...paths, "docs/delivery.md", "src/local.ts"]) assert(html.includes(path));
  assert.match(html, /Shown read-only; file contents are not loaded/u);
  const escaped = renderToStaticMarkup(createElement(DefinitionReferences, {references: ["docs/<script>alert(1)</script>.md"]}));
  assert(!escaped.includes("<script>"));
  assert(escaped.includes("&lt;script&gt;"));
  assert.equal(renderToStaticMarkup(createElement(DefinitionReferences, {references: []})), "");
});
