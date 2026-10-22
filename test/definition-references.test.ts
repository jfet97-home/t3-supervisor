import assert from "node:assert/strict";
import { it } from "vitest";
import {Schema} from "effect";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {parseDefinitionStep, parseDefinitionWorkflow} from "../src/project-definitions.js";
import {ProjectDefinitions} from "../src/project-definitions-contract.js";
import {WorkflowPlanGroupSchema, type WorkflowPlanGroupInfo} from "../src/project-supervisor-contract.js";
import {fixedOccurrencesPreserved, prepareWorkflowRequest, validateWorkflowPlan, validateWorkflowRecord} from "../src/supervisor-workflow.js";
import {DefinitionsContent} from "../ui/src/project-definitions.js";
import {redact} from "../src/credential-redaction.js";
import {DefinitionReferences} from "../ui/src/definition-references.js";
import {indexSource, makeDefinitionFixture} from "./project-definitions-fixture.js";

const step = (references?: unknown) => `---\nid: review\nname: Review\ndescription: Review the change.\n${references === undefined ? "" : `references: ${JSON.stringify(references)}\n`}---\n`;
const workflow = (references?: unknown, localReferences?: unknown) => `name: Delivery\ndescription: Deliver the change.\nfixed: true\n${references === undefined ? "" : `references: ${JSON.stringify(references)}\n`}sequence:\n  - step: review\n  - step:\n      id: local\n      name: Local check\n      description: Check the local code.\n${localReferences === undefined ? "" : `      references: ${JSON.stringify(localReferences)}\n`}`;
const paths = ["docs/review.md", "skills/use-project/SKILL.md", "src/example.ts"];

it("steps, workflows and inline local steps support omitted, empty, single and multiple file references", () => {
  for (const references of [undefined, [], [paths[0]!], paths]) {
    assert.deepEqual(parseDefinitionStep("review", step(references)).references, references);
    const parsed = parseDefinitionWorkflow("delivery", workflow(references, references));
    assert.deepEqual(parsed.references, references);
    const local = parsed.sequence?.[1];
    assert(local && "step" in local && typeof local.step !== "string");
    assert.deepEqual(local.step.references, references);
  }
});

it("file references reject malformed lists, absolute paths and URLs consistently", () => {
  for (const references of [null, "docs/review.md", {}, [1], [""], [" docs/a.md"], ["/tmp/a.md"], ["~/a.md"], ["C:/a.md"],
    ["https://example.com/a.md"], ["docs\\a.md"], ["docs/a\n.md"], ["docs/a\u0085.md"], ["docs/a\u2028.md"], ["docs/a\u202e.md"],
    ["notes/token=example.md"], ["docs/ghp_" + "A".repeat(32) + ".md"], ["x".repeat(4097)], Array.from({length: 101}, () => "a.md")]) {
    assert.throws(() => parseDefinitionStep("review", step(references)), /references/u);
    assert.throws(() => parseDefinitionWorkflow("delivery", workflow(references)), /references/u);
    assert.throws(() => parseDefinitionWorkflow("delivery", workflow(undefined, references)), /references/u);
  }
  assert.deepEqual(parseDefinitionStep("review", step(["../shared/guide.md", "docs/With spaces.md", "docs/日本語.txt"])).references,
    ["../shared/guide.md", "docs/With spaces.md", "docs/日本語.txt"]);
});

const fixture = async (global = false) => {
  const f = makeDefinitionFixture({globalEnabled: global});
  f.addFile(f.threadRoot!, ".t3-supervisor/project.yaml", indexSource({steps: ["review"], workflows: ["delivery"], default_workflow: "delivery"}));
  f.addFile(f.threadRoot!, ".t3-supervisor/steps/review.md", step(paths));
  f.addFile(f.threadRoot!, ".t3-supervisor/workflows/delivery.yaml", workflow(["docs/delivery.md"], ["src/local.ts"]));
  if (global) {
    f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", indexSource({steps: ["review"], workflows: ["delivery"]}));
    f.addFile(f.globalRoot, ".t3-supervisor/steps/review.md", step(["docs/shared.md"]));
    f.addFile(f.globalRoot, ".t3-supervisor/workflows/delivery.yaml", workflow(["docs/shared-workflow.md"], ["src/shared.ts"]));
  }
  return {f, definitions: await f.loader.load(f.projectId, "thread")};
};

it("definition loading and API schemas preserve references without reading their targets, including shared definitions", async () => {
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

it("reference lists survive model context, canonical plans and strict record schemas; forged reusable paths are rejected", async () => {
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
  const credentialPath = "notes/ghp_" + "A".repeat(32) + ".md";
  assert.notEqual(redact(credentialPath), credentialPath);
  assert.equal(validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: null, localId: "unsafe", name: "Unsafe", description: "Review notes.", references: [credentialPath], reason: "Local support."},
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

it("read-only references escape text and appear on reusable, workflow and local definition views", async () => {
  const {definitions} = await fixture();
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions}));
  for (const path of [...paths, "docs/delivery.md", "src/local.ts"]) assert(html.includes(path));
  assert.match(html, /Shown read-only; file contents are not loaded/u);
  const escaped = renderToStaticMarkup(createElement(DefinitionReferences, {references: ["docs/<script>alert(1)</script>.md"]}));
  assert(!escaped.includes("<script>"));
  assert(escaped.includes("&lt;script&gt;"));
  assert.equal(renderToStaticMarkup(createElement(DefinitionReferences, {references: []})), "");
});

it("rejected references report a fixed reason and position without repeating the submitted path", async () => {
  const {definitionReferenceProblem, describeDefinitionReferenceProblem} = await import("../src/definition-references.js");
  const secret = "ghp_" + "B".repeat(32);
  const cases: Array<[unknown, string, number | null]> = [
    [["docs/ok.md", "/tmp/a.md"], "reference_absolute_path", 1], [[`notes/${secret}.md`], "reference_credential_like", 0],
    [["password=hunter2"], "reference_credential_like", 0], [["https://user:pass@example.com/a.md"], "reference_url_like", 0],
    [["~/notes.md"], "reference_home_path", 0], [["docs\\a.md"], "reference_backslash", 0], [["docs/a\u202e.md"], "reference_control_character", 0],
    [["docs/a\u0000.md"], "reference_control_character", 0], [[" docs/a.md"], "reference_surrounding_whitespace", 0], [[""], "reference_empty", 0],
    [["x".repeat(4097)], "reference_too_long", 0], [[1], "reference_not_text", 0], ["docs/a.md", "references_not_list", null],
    [Array.from({length: 101}, () => "a.md"), "references_too_many", null],
  ];
  for (const [value, code, index] of cases) {
    const problem = definitionReferenceProblem(value);
    assert.deepEqual(problem, {code, index});
    const message = describeDefinitionReferenceProblem(problem!);
    assert.match(message, /^references(\[\d+\])? is invalid: [A-Za-z0-9 ,.-]+\.$/u);
    for (const fragment of [secret, "hunter2", "user:pass", "/tmp", "\u202e", "\u0000"]) assert.equal(message.includes(fragment), false);
  }
  assert.equal(definitionReferenceProblem(["../shared/guide.md", "docs/日本語.txt"]), null);
  const original = ["docs/ok.md", `docs/${secret}.md`];
  assert.throws(() => parseDefinitionStep("review", step(original)), (error: Error) =>
    error.message === "Step references[1] is invalid: a reference cannot contain credential-like text." && !error.message.includes(secret));
  assert.throws(() => parseDefinitionWorkflow("delivery", workflow(undefined, original)), (error: Error) =>
    error.message === "Local step local references[1] is invalid: a reference cannot contain credential-like text.");
  assert.throws(() => parseDefinitionWorkflow("delivery", workflow(["/abs.md"])), /^Error: Workflow references\[0\] is invalid: a reference must be relative/u);
  assert.deepEqual(original, ["docs/ok.md", `docs/${secret}.md`], "the submitted list is not rewritten");
});
