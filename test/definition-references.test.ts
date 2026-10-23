import {canonicalJson} from "../src/canonical-json.js";
import type {WorkflowWriteResult} from "../src/workflow-write-controller.js";
import {workflowAgreementPlanHash} from "../src/supervisor-workflow-agreement.js";
import {workflowIntroductionText} from "../src/supervisor-conversation.js";
import {applyArgs, ensureArgs, installEvidence, locator, makeFixture as makeWriteFixture, planEntities, proposalForDefinitions, replaceCurrentProposal, sequencePlan} from "./support/wwc-fixture.js";
import {openWwcStores, sqlGet} from "./support/wwc-stores.js";
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import {Effect, Schema} from "effect";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {parseDefinitionStep, parseDefinitionWorkflow, ProjectDefinitions as DefinitionsService} from "../src/project-definitions.js";
import {ProjectDefinitions} from "../src/project-definitions-contract.js";
import {WorkflowPlanGroupSchema, type WorkflowPlanGroupInfo} from "../src/project-supervisor-contract.js";
import {fixedOccurrencesPreserved, prepareWorkflowRequest, validateWorkflowPlan, validateWorkflowRecord} from "../src/supervisor-workflow.js";
import {DefinitionsContent} from "../ui/src/project-definitions.js";
import {redact} from "../src/credential-redaction.js";
import {definitionReferenceFields, definitionReferenceProblem, describeDefinitionReferenceProblem, sameDefinitionReferences, SupportingReferences, type SupportingReference} from "../src/definition-references.js";
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
    ["../shared/guide.md"], ["docs/../private.md"], ["https://example.com/a.md"], ["docs\\a.md"], ["docs/a\n.md"], ["docs/a\u0085.md"], ["docs/a\u2028.md"], ["docs/a\u202e.md"],
    ["notes/token=example.md"], ["docs/ghp_" + "A".repeat(32) + ".md"], ["x".repeat(4097)], Array.from({length: 101}, () => "a.md")]) {
    assert.throws(() => parseDefinitionStep("review", step(references)), /references/u);
    assert.throws(() => parseDefinitionWorkflow("delivery", workflow(references)), /references/u);
    assert.throws(() => parseDefinitionWorkflow("delivery", workflow(undefined, references)), /references/u);
  }
  assert.deepEqual(parseDefinitionStep("review", step(["docs/shared/guide.md", "docs/With spaces.md", "docs/日本語.txt"])).references,
    ["docs/shared/guide.md", "docs/With spaces.md", "docs/日本語.txt"]);
});

// a seeded checkout loaded through the definitions service over the fixture's in-memory sources
const fixture = (global = false) => {
  const f = makeDefinitionFixture({globalEnabled: global});
  f.addFile(f.threadRoot!, ".t3-supervisor/project.yaml", indexSource({steps: ["review"], workflows: ["delivery"], default_workflow: "delivery"}));
  f.addFile(f.threadRoot!, ".t3-supervisor/steps/review.md", step(paths));
  f.addFile(f.threadRoot!, ".t3-supervisor/workflows/delivery.yaml", workflow(["docs/delivery.md"], ["src/local.ts"]));
  if (global) {
    f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", indexSource({steps: ["review"], workflows: ["delivery"]}));
    f.addFile(f.globalRoot, ".t3-supervisor/steps/review.md", step(["docs/shared.md"]));
    f.addFile(f.globalRoot, ".t3-supervisor/workflows/delivery.yaml", workflow(["docs/shared-workflow.md"], ["src/shared.ts"]));
  }
  return Effect.gen(function* () {
    const service = yield* DefinitionsService;
    return {f, definitions: yield* service.load(f.projectId, "thread")};
  }).pipe(Effect.provide(f.definitionsLayer));
};

it.effect("definition loading and API schemas preserve references without reading their targets, including shared definitions", () => Effect.gen(function* () {
  const {f, definitions} = yield* fixture(true);
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
}));

it.effect("reference lists survive model context, canonical plans and strict record schemas; forged reusable paths are rejected", () => Effect.gen(function* () {
  const {definitions} = yield* fixture();
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
}));

it.effect("read-only references escape text and appear on reusable, workflow and local definition views", () => Effect.gen(function* () {
  const {definitions} = yield* fixture();
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions}));
  for (const path of [...paths, "docs/delivery.md", "src/local.ts"]) assert(html.includes(path));
  assert.match(html, /Shown read-only; file contents are not loaded or verified/u);
  const escaped = renderToStaticMarkup(createElement(DefinitionReferences, {references: ["docs/<script>alert(1)</script>.md"]}));
  assert(!escaped.includes("<script>"));
  assert(escaped.includes("&lt;script&gt;"));
  assert.equal(renderToStaticMarkup(createElement(DefinitionReferences, {references: []})), "");
}));

it("rejected references report a fixed reason and position without repeating the submitted path", () => {
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
  assert.equal(definitionReferenceProblem(["docs/shared/guide.md", "docs/日本語.txt"]), null);
  const original = ["docs/ok.md", `docs/${secret}.md`];
  assert.throws(() => parseDefinitionStep("review", step(original)), (error: Error) =>
    error.message === "Step references[1] is invalid: a reference cannot contain credential-like text." && !error.message.includes(secret));
  assert.throws(() => parseDefinitionWorkflow("delivery", workflow(undefined, original)), (error: Error) =>
    error.message === "Local step local references[1] is invalid: a reference cannot contain credential-like text.");
  assert.throws(() => parseDefinitionWorkflow("delivery", workflow(["/abs.md"])), /^Error: Workflow references\[0\] is invalid: a reference must be relative/u);
  assert.deepEqual(original, ["docs/ok.md", `docs/${secret}.md`], "the submitted list is not rewritten");
});


const mixedReferences: readonly SupportingReference[] = [
  "docs/testing.md",
  {skill: {scope: "local", path: "skills/project-testing/SKILL.md"}},
  {skill: {scope: "global", name: "effect-v4-development"}},
  {skill: {scope: "global", name: "plugin:review"}},
];

it("supporting reference schemas preserve strict local and global skills without normalization or aliasing", () => {
  const decoded = Schema.decodeUnknownSync(SupportingReferences)(mixedReferences);
  assert.deepEqual(decoded, mixedReferences);
  assert.deepEqual(parseDefinitionStep("review", step(mixedReferences)).references, mixedReferences);
  const parsed = parseDefinitionWorkflow("delivery", workflow(mixedReferences, mixedReferences));
  assert.deepEqual(parsed.references, mixedReferences);
  const local = parsed.sequence?.[1];
  assert(local && "step" in local && typeof local.step !== "string");
  assert.deepEqual(local.step.references, mixedReferences);
  const reordered = ["docs/testing.md", {skill: {path: "skills/project-testing/SKILL.md", scope: "local" as const}},
    {skill: {name: "effect-v4-development", scope: "global" as const}}, {skill: {name: "plugin:review", scope: "global" as const}}];
  assert(sameDefinitionReferences(mixedReferences, reordered), "object key order does not change reference identity");
  const copied = definitionReferenceFields(mixedReferences).references!;
  assert.deepEqual(copied, mixedReferences);
  assert.notEqual(copied[1], mixedReferences[1]);
  assert.notEqual((copied[1] as Exclude<SupportingReference, string>).skill, (mixedReferences[1] as Exclude<SupportingReference, string>).skill);
  assert(!sameDefinitionReferences(mixedReferences, [...mixedReferences].reverse()));
  assert(!sameDefinitionReferences(["effect-v4-development"], [{skill: {scope: "global", name: "effect-v4-development"}}]));
});

it("skill shape, traversal, schemes, privacy and size checks reject at every definition boundary", () => {
  const secret = "ghp_" + "C".repeat(32);
  const invalid: unknown[] = [
    {skill: {scope: "local", path: "../skills/test/SKILL.md"}}, {skill: {scope: "local", path: "/skills/test/SKILL.md"}},
    {skill: {scope: "local", path: "~/skills/test/SKILL.md"}}, {skill: {scope: "local", path: "https://host/SKILL.md"}},
    {skill: {scope: "local", path: "skills/test/guide.md"}}, {skill: {scope: "local", path: "skills/\u202e/SKILL.md"}},
    {skill: {scope: "local", path: `skills/${secret}/SKILL.md`}}, {skill: {scope: "local", path: "a".repeat(4097)}},
    {skill: {scope: "global", name: "../private"}}, {skill: {scope: "global", name: "https://host/skill"}},
    {skill: {scope: "global", name: secret}}, {skill: {scope: "global", name: "a".repeat(4097)}},
    {skill: {scope: "global", name: "with space"}}, {skill: {scope: "global", name: "missing\nname"}},
    {skill: {scope: "global", name: "review", path: "skills/review/SKILL.md"}},
    {skill: {scope: "local", path: "skills/review/SKILL.md", name: "review"}},
    {skill: {scope: "global", name: "review"}, file: "guide.md"}, {skill: {scope: "project", name: "review"}},
    {skill: {scope: "global"}}, {skill: null}, {file: "guide.md"},
  ];
  for (const reference of invalid) {
    const refs = ["docs/ok.md", reference];
    assert.equal(Schema.is(SupportingReferences)(refs), false);
    const problem = definitionReferenceProblem(refs);
    assert(problem);
    assert.equal(problem.index, 1);
    assert(!describeDefinitionReferenceProblem(problem).includes(secret));
    for (const run of [() => parseDefinitionStep("review", step(refs)), () => parseDefinitionWorkflow("delivery", workflow(refs)),
      () => parseDefinitionWorkflow("delivery", workflow(undefined, refs))]) {
      assert.throws(run, (error: Error) => /references\[1\] is invalid/u.test(error.message) && !error.message.includes(secret));
    }
  }
  assert(Schema.is(SupportingReferences)(Array.from({length: 100}, () => mixedReferences[1]!)));
  assert(!Schema.is(SupportingReferences)(Array.from({length: 101}, () => mixedReferences[1]!)));
});

it.effect("shared and inline skill references flow through canonical plans and fixed commitments without target reads or writes", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({globalEnabled: true});
  for (const root of [f.threadRoot!, f.globalRoot]) {
    f.addFile(root, ".t3-supervisor/project.yaml", indexSource({steps: ["review"], workflows: ["delivery"]}));
    f.addFile(root, ".t3-supervisor/steps/review.md", step(mixedReferences));
    f.addFile(root, ".t3-supervisor/workflows/delivery.yaml", workflow(mixedReferences, mixedReferences));
  }
  const service = yield* DefinitionsService.pipe(Effect.provide(f.definitionsLayer));
  const definitions = yield* service.load(f.projectId, "thread");
  assert.equal(definitions.status, "ready");
  for (const item of [...definitions.steps, ...definitions.workflows]) assert.deepEqual(item.references, mixedReferences);
  const shared = definitions.workflows.find(item => item.origin === "global")!;
  const prepared = prepareWorkflowRequest("thread", "message", "Review the behavior", definitions);
  assert(prepared.context);
  const normalized = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: shared.id, reason: "Use the shared review."},
    {kind: "workflow", definitionId: "delivery", reason: "Use the local review."},
  ]}}, prepared.context);
  assert(normalized?.plan);
  assert.deepEqual(Schema.decodeUnknownSync(WorkflowPlanGroupSchema)(normalized.plan), normalized.plan);
  assert.deepEqual(validateWorkflowRecord(normalized, prepared.context), normalized);
  for (const wrapper of normalized.plan.nodes) {
    assert(wrapper.kind === "workflow" && wrapper.plan);
    assert.deepEqual(wrapper.references, mixedReferences);
    for (const node of wrapper.plan.nodes) {
      assert(node.kind === "step");
      assert.deepEqual(node.references, mixedReferences);
    }
  }
  for (const references of [[], ["different.md"], [{skill: {scope: "local" as const, path: "skills/other/SKILL.md"}}],
    [{skill: {scope: "global" as const, name: "different"}}]]) {
    const changed: NonNullable<typeof normalized> = structuredClone(normalized);
    const wrapper = changed.plan!.nodes[0];
    assert(wrapper?.kind === "workflow");
    wrapper.references = references;
    assert.equal(validateWorkflowRecord(changed, prepared.context), null);
    assert.equal(fixedOccurrencesPreserved(normalized.plan, changed.plan!), false);
    const value = {workspaceRoot: definitions.workspaceRoot, revision: definitions.revision};
    assert.notEqual(workflowAgreementPlanHash({...value, workflow: changed}), workflowAgreementPlanHash({...value, workflow: normalized}));
  }
  assert(f.calls.every(call => call.path.startsWith(".t3-supervisor")), "targets and host skill roots are never probed");
  assert.deepEqual(f.writes, []);
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions}));
  for (const label of ["File:", "Local skill:", "Global skill:", "effect-v4-development", "plugin:review"]) assert(html.includes(label));
  const firstRevision = definitions.revision;
  f.addFile(f.threadRoot!, ".t3-supervisor/steps/review.md", step([{skill: {scope: "global", name: "different"}}]));
  assert.notEqual((yield* service.load(f.projectId, "thread")).revision, firstRevision);
}));


it.effect("short contracts deliver all reference kinds through native-verified writes, SQL restart, workflow reads and operative introductions", () => Effect.gen(function* () {
  const f = yield* makeWriteFixture();
  const base = f.definitionReader.current;
  const description = "Review the changed behavior using the referenced guidance; report failures and limits.";
  const nativeFiles = makeDefinitionFixture({projectId: f.projectId, root: base.workspaceRoot, threadRoot: base.workspaceRoot, globalEnabled: true});
  for (const root of [base.workspaceRoot, nativeFiles.globalRoot]) {
    nativeFiles.addFile(root, ".t3-supervisor/project.yaml", indexSource({steps: ["review"], workflows: ["delivery"]}));
    nativeFiles.addFile(root, ".t3-supervisor/steps/review.md", step(mixedReferences).replace("Review the change.", description));
    nativeFiles.addFile(root, ".t3-supervisor/workflows/delivery.yaml", workflow(mixedReferences, mixedReferences));
  }
  const definitions = yield* (yield* nativeFiles.makeDefinitions()).load(f.projectId, f.mainThreadId);
  assert.equal(definitions.status, "ready");
  const shared = definitions.workflows.find(item => item.origin === "global")!;
  const proposal = proposalForDefinitions(definitions, sequencePlan([
    {kind: "workflow", definitionId: shared.id, reason: "Use the shared review."},
    {kind: "workflow", definitionId: "delivery", reason: "Use the project review."},
  ]));
  yield* replaceCurrentProposal(f, "references-proposal", definitions, proposal);
  const create = ensureArgs(f, "references-create", "Prepare the agreed review.");
  installEvidence(f, create);
  const created = yield* f.controller.write(create);
  assert.equal(created.status, "created");
  if (created.status !== "created") return;
  const args = yield* applyArgs(f, {operationId: "references-apply", workflowId: created.workflowId, expectedRevision: created.revision,
    plan: proposal.plan, note: "Record the short review contract and its supporting pointers."});
  const itemId = installEvidence(f, args);
  assert.equal((yield* f.controller.write(args)).status, "applied");
  const read = yield* f.controller.read({...locator(f), limit: 10});
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  const saved = planEntities(read.workflows[0]!.document.plan);
  assert.equal(saved.length, 6, "both workflow wrappers, reusable steps and inline steps survive");
  for (const node of saved) assert.deepEqual(node.references, mixedReferences);
  assert.equal(saved.find(node => node.kind === "step" && node.definitionId === "review")?.description, description);
  assert(nativeFiles.calls.every(call => call.path.startsWith(".t3-supervisor")));
  assert.deepEqual(nativeFiles.writes, []);
  const proof = yield* sqlGet(f.db, "SELECT native_evidence FROM supervisor_workflow_write_evidence WHERE item_id=?", itemId);
  assert.equal((JSON.parse(String(proof?.native_evidence)) as {nativeInputCanonical: string}).nativeInputCanonical, canonicalJson(args),
    "the proof retains every exact structured reference, not decoded replacements");
  const task = (yield* f.supervisors.task(f.mainThreadId))!;
  const introduction = workflowIntroductionText(task);
  for (const label of ["File: docs/testing.md", "Local skill: skills/project-testing/SKILL.md", "Global skill: effect-v4-development", "Global skill: plugin:review"])
    assert(introduction.includes(label), "the operative receives each pointer, including exact namespaces");
  assert(introduction.includes("missing or ambiguous skills remain explicit gaps"));
  assert(!introduction.includes("contents of the testing guide"), "no supporting content is synthesized");
  yield* f.close;
  const reopened = yield* openWwcStores(f.directory);
  const retained = planEntities((yield* reopened.workflows.get(f.projectId, f.mainThreadId))!.plan);
  assert.deepEqual(retained, saved);
  assert.deepEqual((yield* reopened.supervisors.task(f.mainThreadId))!.definitionSnapshot!.steps[0]!.references, mixedReferences);
  yield* reopened.close;
}));


it.effect("invalid skill pointers fail before native reads or durable mutation without exposing rejected values", () => Effect.gen(function* () {
  const f = yield* makeWriteFixture();
  const secret = "ghp_" + "D".repeat(32);
  const create = ensureArgs(f, "invalid-pointers-create", "Prepare a workflow.");
  installEvidence(f, create);
  const created = yield* f.controller.write(create);
  assert(created.status === "created");
  for (const references of [["../private.md"], [{skill: {scope: "local", path: `skills/${secret}/SKILL.md`}}],
    [{skill: {scope: "global", name: "review", path: "unexpected"}}]]) {
    const before = {...f.calls, projection: [...f.calls.projection], detail: [...f.calls.detail]};
    const current = (yield* f.workflows.get(f.projectId, f.mainThreadId))!;
    const args: Record<string, unknown> = yield* applyArgs(f, {operationId: "invalid-pointers", workflowId: created.workflowId, expectedRevision: current.revision,
      plan: sequencePlan([{kind: "step", definitionId: null, localId: "review", name: "Review", description: "Review the behavior.",
        references, reason: "A local review."}]), note: "Record local work."});
    const result: WorkflowWriteResult = yield* f.controller.write(args);
    assert.equal(result.status, "invalid");
    assert(!JSON.stringify(result).includes(secret));
    assert.deepEqual(f.calls, before);
    assert.deepEqual(yield* f.workflows.get(f.projectId, f.mainThreadId), current);
  }
}));
