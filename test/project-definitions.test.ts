import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import {Effect} from "effect";
import {ProjectConfigEditorService} from "../src/project-config-editor.js";
import {parseDefinitionStep, parseDefinitionWorkflow, parseProjectConfiguration} from "../src/project-definitions.js";
import {ProjectFileError, type ProjectFiles} from "../src/project-files.js";
import {proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {requiredReferences} from "../src/project-definitions-contract.js";
import {indexSource, makeDefinitionFixture, stepSource, workflowSource} from "./project-definitions-fixture.js";

type Fixture = ReturnType<typeof makeDefinitionFixture>;
// one load through a definitions service over the fixture's in-memory sources, or over replaced native files, released after the load
const load = (f: Fixture, projectId: string, threadId: string | null = null, files: ProjectFiles["Service"] = f.projectFiles) =>
  Effect.scoped(Effect.flatMap(f.makeDefinitions({files}), definitions => definitions.load(projectId, threadId)));

it("parses the strict project.yaml index and step formats", () => {
  const index = "workflows:\n  - path: workflows/reviewer.yaml\n    summary: |\n      Review a change before release.\n      Use it for every public change.\n    required: true\n" +
    "steps:\n  - path: steps/e2e-testing.md\n    summary: \"  Run end-to-end tests when behavior changes.  \"\n    required: false\ndefault_workflow: reviewer\n";
  assert.deepEqual(parseProjectConfiguration(index), {
    workflows: [{path: "workflows/reviewer.yaml", summary: "Review a change before release.\nUse it for every public change.", required: true}],
    steps: [{path: "steps/e2e-testing.md", summary: "Run end-to-end tests when behavior changes.", required: false}],
    default_workflow: "reviewer",
  });
  assert.deepEqual(requiredReferences(parseProjectConfiguration(index)), [{workflow: "reviewer"}], "the flags are the only authored requirement; the ID comes from the path");
  assert.deepEqual(parseProjectConfiguration("workflows: []\nsteps: []\n"), {workflows: [], steps: []});
  // an omitted required flag is false; explicit flags are kept as written
  const flags = parseProjectConfiguration("workflows: []\nsteps:\n  - {path: steps/check.md, summary: Check it.}\n  - {path: steps/lint_2.md, summary: Lint it., required: false}\n  - {path: steps/test.md, summary: Test it., required: true}\n");
  assert.deepEqual(flags.steps.map(row => row.required), [false, false, true]);
  assert.deepEqual(requiredReferences({...flags, steps: flags.steps.map(row => ({...row, required: true}))}), [{step: "check"}, {step: "lint_2"}, {step: "test"}]);
  assert.throws(() => parseProjectConfiguration("required: []\n"), /each entry's required flag/u, "the old top-level required list is rejected, not converted");
  const entry = (fields: string) => `workflows: []\nsteps:\n  - ${fields}\n`;
  for (const [text, reason] of [
    ["workflows: []\n", /workflows and steps lists/u],
    ["workflows: []\nsteps: []\nextra: true\n", /workflows and steps lists/u],
    ["workflows: []\nsteps: []\nrequired: []\n", /each entry's required flag/u],
    [entry("{id: check, path: steps/check.md, summary: Check it.}"), /exactly path, summary and optional required/u],
    [entry("{path: steps/check.md, summary: Check it., required: true, extra: 1}"), /exactly path, summary and optional required/u],
    [entry("{summary: Check it.}"), /exactly path, summary and optional required/u],
    [entry("{path: 1, summary: Check it.}"), /exactly path, summary and optional required/u],
    [entry("{path: steps/check.md, summary: Check it., required: null}"), /exactly path, summary and optional required/u],
    [entry("{path: steps/check.md, summary: Check it., required: 1}"), /exactly path, summary and optional required/u],
    [entry("{path: steps/check.md, summary: Check it., required: \"yes\"}"), /exactly path, summary and optional required/u],
    ...["steps/Check.md", "../steps/check.md", "./steps/check.md", "steps/check.yaml", "workflows/check.yaml", "steps/nested/check.md", "steps/.md", `steps/${"x".repeat(65)}.md`, "\"\""]
      .map(path => [entry(`{path: ${path}, summary: Check it.}`), /path must be steps\/<id>\.md/u] as const),
    ["workflows:\n  - {path: steps/check.md, summary: Check it.}\nsteps: []\n", /path must be workflows\/<id>\.yaml/u],
    [entry("{path: steps/check.md, summary: \"  \"}"), /nonempty summary/u],
    [entry("{path: steps/check.md, summary: \"One.\\nTwo.\\nThree.\"}"), /at most 2 nonempty lines/u],
    [entry("{path: steps/check.md, summary: \"One.\\n\\nTwo.\"}"), /at most 2 nonempty lines/u],
    [entry(`{path: steps/check.md, summary: ${"x".repeat(241)}}`), /at most 240 characters/u],
    ["workflows: []\nsteps:\n  - {path: steps/check.md, summary: One.}\n  - {path: steps/check.md, summary: Two., required: true}\n", /steps\/check\.md is indexed more than once/u],
    ["workflows: []\nsteps: []\ndefault_workflow: missing\n", /must be an indexed workflow/u],
    ["workflows: &shared []\nsteps: *shared\n", /aliases/u],
    ["workflows: !custom []\nsteps: []\n", /Invalid YAML/u],
    ["workflows: [\n", /Invalid YAML/u],
  ] as const) assert.throws(() => parseProjectConfiguration(text), reason, text);

  const source = "---\r\nid: review\r\nname: Review\r\ndescription: |\r\n  Inspect the change.\r\n---\r\n  \r\n";
  assert.deepEqual(parseDefinitionStep("review", source), {id: "review", name: "Review", description: "Inspect the change."});
  for (const [id, contents] of [
    ["other", source],
    ["review", source.replace("name: Review", "name: Review\nextra: forbidden")],
    ["review", source + "A body is forbidden.\n"],
    ["../review", source],
  ]) assert.throws(() => parseDefinitionStep(id!, contents!));
});

it("parses reusable and local steps in nested ordered and parallel workflow groups", () => {
  const workflow = parseDefinitionWorkflow("delivery", `name: Delivery\ndescription: Ship the change.\nfixed: true\nsequence:\n  - step: e2e-testing\n  - step:\n      id: check-notes\n      name: Check notes\n      description: Compare notes with behavior.\n  - parallel:\n      - step: security-review\n      - sequence:\n          - workflow: reviewer\n          - step: report\n`);
  assert.equal(workflow.id, "delivery");
  assert.equal(workflow.fixed, true);
  assert.deepEqual(workflow.sequence?.[0], {step: "e2e-testing"});
  assert.deepEqual(workflow.sequence?.[1], {step: {id: "check-notes", name: "Check notes", description: "Compare notes with behavior."}});
  assert.deepEqual(workflow.sequence?.[2], {parallel: [{step: "security-review"}, {sequence: [{workflow: "reviewer"}, {step: "report"}]}]});

  for (const contents of [
    "name: Bad\ndescription: No root.\n",
    "name: Bad\ndescription: Two roots.\nsequence: [step]\nparallel: [step]\n",
    "name: Bad\ndescription: Empty group.\nsequence: []\n",
    "name: Bad\ndescription: Inline workflows forbidden.\nsequence:\n  - workflow:\n      id: inline\n      name: Inline\n      description: No.\n",
    "name: Bad\ndescription: Unknown field.\nsequence:\n  - step: review\nextra: true\n",
    "name: Bad\ndescription: Duplicate local IDs.\nsequence:\n  - step: {id: local, name: First, description: First.}\n  - step: {id: local, name: Second, description: Second.}\n",
  ]) assert.throws(() => parseDefinitionWorkflow("bad", contents));
});

it.effect("retains unknown refs as diagnostics in a complete invalid source snapshot", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  const configuration = indexSource({steps: ["known", "missing-required"], workflows: ["delivery", "missing-default", "missing-workflow"],
    required: [{step: "missing-required"}, {workflow: "missing-workflow"}], default_workflow: "missing-default"});
  const step = stepSource("known", "A reusable step.");
  const workflow = workflowSource("Delivery", "  - step: missing-step\n  - workflow: missing-nested\n  - parallel:\n      - step: known\n");
  f.addFile(f.root, ".t3-supervisor/project.yaml", configuration);
  f.addFile(f.root, ".t3-supervisor/steps/known.md", step);
  f.addFile(f.root, ".t3-supervisor/workflows/delivery.yaml", workflow);
  const snapshot = yield* load(f, f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.match(snapshot.revision ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.projectConfig, parseProjectConfiguration(configuration));
  assert.deepEqual(requiredReferences(snapshot.config), [{workflow: "missing-workflow"}, {step: "missing-required"}], "missing rows keep their required flags");
  assert.deepEqual(snapshot.config.steps.map(row => [row.id, row.origin, row.sourceId]), [["known", "project", "known"], ["missing-required", "project", "missing-required"]]);
  assert.deepEqual(snapshot.steps.map(step => step.summary), [snapshot.config.steps[0]!.summary], "a loaded definition carries its index summary");
  assert.deepEqual(snapshot.workflows[0]?.sequence, [{step: "missing-step"}, {workflow: "missing-nested"}, {parallel: [{step: "known"}]}]);
  assert.deepEqual(snapshot.sources.map(source => source.content), [configuration, step, workflow]);
  assert.deepEqual(snapshot.sources.map(source => source.path), [
    ".t3-supervisor/project.yaml", ".t3-supervisor/steps/known.md", ".t3-supervisor/workflows/delivery.yaml",
  ]);
  assert.ok(snapshot.issues.some(issue => issue.code === "required_step_missing" && issue.message.includes("missing-required")));
  assert.ok(snapshot.issues.some(issue => issue.code === "required_workflow_missing" && issue.message.includes("missing-workflow")));
  assert.ok(snapshot.issues.some(issue => issue.code === "default_workflow_missing" && issue.message.includes("missing-default")));
  assert.ok(snapshot.issues.some(issue => issue.code === "workflow_step_missing" && issue.message.includes("missing-step")));
  assert.ok(snapshot.issues.some(issue => issue.code === "workflow_reference_missing" && issue.message.includes("missing-nested")));
  assert.deepEqual(snapshot.issues.filter(issue => issue.code === "catalog_entry_missing").map(issue => issue.path).sort(), [
    ".t3-supervisor/steps/missing-required.md", ".t3-supervisor/workflows/missing-default.yaml", ".t3-supervisor/workflows/missing-workflow.yaml",
  ]);
}));

it.effect("allows independent workflow reuse and reports exact direct and indirect cycles", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/steps/check.md", stepSource("check"));
  f.addFile(f.root, ".t3-supervisor/workflows/root.yaml", workflowSource("Root", "  - workflow: branch-a\n  - workflow: branch-b\n  - workflow: shared\n  - workflow: shared\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/branch-a.yaml", workflowSource("Branch A", "  - workflow: shared\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/branch-b.yaml", workflowSource("Branch B", "  - workflow: shared\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/shared.yaml", workflowSource("Shared", "  - step: check\n"));
  f.writeIndex(f.root, {default_workflow: "root"});
  const reusable = yield* load(f, f.projectId);
  assert.equal(reusable.status, "ready");
  assert.equal(reusable.complete, true);
  assert.equal(reusable.issues.length, 0);

  f.addFile(f.root, ".t3-supervisor/workflows/branch-a.yaml", workflowSource("Branch A", "  - workflow: shared\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/shared.yaml", workflowSource("Shared", "  - workflow: branch-a\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/direct.yaml", workflowSource("Direct", "  - workflow: direct\n"));
  f.writeIndex(f.root, {default_workflow: "root"});
  const cycles = yield* load(f, f.projectId);
  assert.equal(cycles.status, "invalid");
  const messages = cycles.issues.filter(issue => issue.code === "workflow_cycle").map(issue => issue.message);
  assert.ok(messages.includes("Workflow reference cycle: branch-a -> shared -> branch-a."));
  assert.ok(messages.includes("Workflow reference cycle: direct -> direct."));
  assert.equal(cycles.complete, true);
  assert.ok(cycles.revision);
}));

it.effect("rejects statically expanded workflow graphs beyond the shared node budget", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addDirectory(f.root, ".t3-supervisor/steps");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  const leaves = Array.from({length: 8}, (_, index) => `leaf-${index}`);
  const middle = Array.from({length: 8}, (_, index) => `middle-${index}`);
  const top = Array.from({length: 8}, (_, index) => `top-${index}`);
  const stepNodes = Array.from({length: 8}, (_, index) => `  - step: step-${index}\n`).join("");
  const leafReferences = leaves.map(id => `  - workflow: ${id}\n`).join("");
  const middleReferences = middle.map(id => `  - workflow: ${id}\n`).join("");
  for (let index = 0; index < 8; index++) f.addFile(f.root, `.t3-supervisor/steps/step-${index}.md`, stepSource(`step-${index}`));
  for (const id of leaves) f.addFile(f.root, `.t3-supervisor/workflows/${id}.yaml`, workflowSource(id, stepNodes));
  for (const id of middle) f.addFile(f.root, `.t3-supervisor/workflows/${id}.yaml`, workflowSource(id, leafReferences));
  for (const id of top) f.addFile(f.root, `.t3-supervisor/workflows/${id}.yaml`, workflowSource(id, middleReferences));

  f.writeIndex(f.root);
  const snapshot = yield* load(f, f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true, "all source files were readable; expansion failure is a definition diagnostic");
  assert.ok(snapshot.revision);
  assert.ok(snapshot.issues.some(issue => issue.code === "workflow_expansion_limit"));
  assert.ok(snapshot.issues.some(issue => issue.code === "workflow_expansion_depth") === false,
    "the graph exceeds the node budget without exceeding the depth bound");
}));

it.effect("keeps a 12-workflow reference chain within the shared structural depth bound", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addDirectory(f.root, ".t3-supervisor/steps");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  f.addFile(f.root, ".t3-supervisor/steps/check.md", stepSource("check"));
  for (let index = 0; index < 12; index++) {
    const nodes = index === 11 ? "  - step: check\n" : `  - workflow: chain-${index + 1}\n`;
    f.addFile(f.root, `.t3-supervisor/workflows/chain-${index}.yaml`, workflowSource(`Chain ${index}`, nodes));
  }

  f.writeIndex(f.root);
  const snapshot = yield* load(f, f.projectId);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.issues, []);
  assert.ok(snapshot.revision);
  const context = proposalContextFromDefinitions(snapshot);
  const proposal = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "chain-0", reason: "Use the complete reusable chain."},
  ]}}, context);
  assert.ok(proposal);
  assert.ok(!proposal.issues.some(issue => issue.code === "workflow_expansion_depth"));
}));

it.effect("keeps a genuinely over-bound workflow reference chain explicitly invalid", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addDirectory(f.root, ".t3-supervisor/steps");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  f.addFile(f.root, ".t3-supervisor/steps/check.md", stepSource("check"));
  for (let index = 0; index < 16; index++) {
    const nodes = index === 15 ? "  - step: check\n" : `  - workflow: chain-${index + 1}\n`;
    f.addFile(f.root, `.t3-supervisor/workflows/chain-${index}.yaml`, workflowSource(`Chain ${index}`, nodes));
  }

  f.writeIndex(f.root);
  const snapshot = yield* load(f, f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.revision);
  assert.ok(snapshot.issues.some(issue => issue.code === "workflow_expansion_depth"));
  const proposal = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "chain-0", reason: "This source exceeds the structural depth bound."},
  ]}}, proposalContextFromDefinitions(snapshot));
  assert.ok(proposal);
  assert.ok(proposal.issues.some(issue => issue.code === "workflow_expansion_depth"));
}));

it.effect("an unreadable index reads no definitions, keeps their files in the inventory and invents no empty valid policy", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  const configuration = "workflows: [\n";
  const step = "---\nid: review\nname: Review\ndescription: Inspect.\n---\nBody text is not allowed.\n";
  const workflow = "name: Review\ndescription: Invalid root.\nsteps: [review]\n";
  f.addFile(f.root, ".t3-supervisor/project.yaml", configuration);
  f.addFile(f.root, ".t3-supervisor/steps/review.md", step);
  f.addFile(f.root, ".t3-supervisor/workflows/reviewer.yaml", workflow);
  const snapshot = yield* load(f, f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.revision);
  assert.equal(snapshot.projectConfig, null);
  assert.deepEqual(snapshot.config, {workflows: [], steps: []});
  assert.deepEqual(snapshot.sources.map(source => source.content), [configuration], "without a valid index no definition file is read");
  assert.deepEqual(snapshot.definitionFiles, [{origin: "project", kind: "steps", id: "review", path: "steps/review.md"},
    {origin: "project", kind: "workflows", id: "reviewer", path: "workflows/reviewer.yaml"}]);
  assert.ok(snapshot.issues.some(issue => issue.code === "project_configuration_invalid"));
  assert.equal(proposalContextFromDefinitions(snapshot).requirementsKnown, false, "an unreadable index leaves requirements unknown");

  // with a valid index the same invalid files are read and diagnosed
  f.writeIndex(f.root);
  const indexed = yield* load(f, f.projectId);
  assert.equal(indexed.status, "invalid");
  assert.ok(indexed.issues.some(issue => issue.code === "steps_invalid"));
  assert.ok(indexed.issues.some(issue => issue.code === "workflows_invalid"));
}));

it.effect("reports stray and retired entries without reading or counting them as definition sources", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/steps/valid.md", "invalid definition content\n");
  f.addFile(f.root, ".t3-supervisor/steps/README.md", "#" + "x".repeat(64 * 1024));
  f.addFile(f.root, ".t3-supervisor/steps/.DS_Store", "#" + "x".repeat(64 * 1024));
  f.addFile(f.root, ".t3-supervisor/steps/valid.MD", "#" + "x".repeat(64 * 1024));
  f.addFile(f.root, ".t3-supervisor/.DS_Store", "#" + "x".repeat(64 * 1024));
  f.addFile(f.root, ".t3-supervisor/rules.yaml", "rules: []\n");
  f.addDirectory(f.root, ".t3-supervisor/blocks");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  f.writeIndex(f.root);
  const snapshot = yield* load(f, f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.revision);
  assert.deepEqual(snapshot.sources.map(source => source.path), [".t3-supervisor/project.yaml", ".t3-supervisor/steps/valid.md"]);
  assert.ok(snapshot.issues.some(issue => issue.code === "legacy_definition_format" && issue.message.includes("Replace it with project.yaml")));
  assert.ok(snapshot.issues.some(issue => issue.code === "steps_path_invalid"));
  assert.ok(snapshot.issues.some(issue => issue.code === "steps_case_collision"));
  assert.ok(!snapshot.issues.some(issue => issue.path.includes(".DS_Store")));
  assert.ok(!f.calls.some(call => call.kind === "read" && /README|DS_Store|rules\.yaml|valid\.MD/.test(call.path)));

  const saved = yield* Effect.gen(function* () {
    const editor = yield* ProjectConfigEditorService;
    return yield* editor.save({projectId: f.projectId, threadId: null, expectedRevision: snapshot.revision!, config: snapshot.projectConfig!});
  }).pipe(Effect.provide(f.configEditorLayer()));
  assert.equal(saved.status, "saved");
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]?.path, ".t3-supervisor/project.yaml");
}));

it.effect("ignores inert Finder metadata without making a valid definition scope invalid", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", indexSource());
  f.addFile(f.root, ".t3-supervisor/.DS_Store", "metadata only\n");
  f.addFile(f.root, ".t3-supervisor/steps/.DS_Store", "metadata only\n");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  const snapshot = yield* load(f, f.projectId);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.sources.length, 1);
  assert.equal(snapshot.issues.length, 0);
  assert.ok(!f.calls.some(call => call.kind === "read" && call.path.includes(".DS_Store")));
}));

it.effect("does not migrate old-only folders and explains the manual format replacement", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/rules.yaml", "rules: []\n");
  f.addDirectory(f.root, ".t3-supervisor/blocks");
  const snapshot = yield* load(f, f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.revision);
  assert.equal(snapshot.sources.some(source => source.path.includes("rules.yaml")), false);
  assert.ok(snapshot.issues.some(issue => issue.code === "legacy_definition_format" && /workflows: \[\] and steps: \[\]/.test(issue.message)));
}));

it.effect("permission, truncation, unsafe paths and source size limits never appear complete", () => Effect.gen(function* () {
  const denied = makeDefinitionFixture();
  denied.addFile(denied.root, ".t3-supervisor/project.yaml", indexSource({steps: ["review"]}));
  denied.addFile(denied.root, ".t3-supervisor/steps/review.md", stepSource("review"));
  denied.failures.set(`${denied.root}|.t3-supervisor/steps/review.md`, new ProjectFileError("permission_required"));
  const permission = yield* load(denied, denied.projectId);
  assert.equal(permission.status, "permission_required");
  assert.equal(permission.complete, false);
  assert.equal(permission.revision, null);
  assert.equal(permission.sources.length, 1);

  const truncated = makeDefinitionFixture();
  truncated.addFile(truncated.root, ".t3-supervisor/project.yaml", indexSource());
  truncated.addDirectory(truncated.root, ".t3-supervisor/steps");
  truncated.truncatedPaths.add(`${truncated.root}|.t3-supervisor/steps`);
  const partial = yield* load(truncated, truncated.projectId);
  assert.equal(partial.complete, false);
  assert.equal(partial.revision, null);
  assert.ok(partial.issues.some(issue => issue.code === "steps_listing_incomplete"));

  const unsafe = makeDefinitionFixture();
  unsafe.addFile(unsafe.root, ".t3-supervisor/project.yaml", indexSource());
  unsafe.addDirectory(unsafe.root, ".t3-supervisor/steps");
  // the native listing of the steps folder names a path outside it; every other listing comes from the in-memory checkout
  const files: ProjectFiles["Service"] = {...unsafe.projectFiles, list: (root, path) => path === ".t3-supervisor/steps"
    ? Effect.succeed({truncated: false, entries: [{path: ".t3-supervisor/../../outside.md", kind: "file" as const}]})
    : unsafe.projectFiles.list(root, path)};
  const malformedListing = yield* load(unsafe, unsafe.projectId, null, files);
  assert.equal(malformedListing.complete, false);
  assert.ok(!unsafe.calls.some(call => call.kind === "read" && call.path.includes("outside")));

  const oversized = makeDefinitionFixture();
  oversized.addFile(oversized.root, ".t3-supervisor/project.yaml", indexSource({steps: ["large"]}));
  oversized.addFile(oversized.root, ".t3-supervisor/steps/large.md", `#${"x".repeat(64 * 1024)}\n`);
  const tooLarge = yield* load(oversized, oversized.projectId);
  assert.equal(tooLarge.status, "invalid");
  assert.equal(tooLarge.complete, false);
  assert.equal(tooLarge.revision, null);
  assert.ok(tooLarge.sources.every(source => Buffer.byteLength(source.content, "utf8") <= 64 * 1024));

  const combined = makeDefinitionFixture();
  combined.addFile(combined.root, ".t3-supervisor/project.yaml", indexSource({steps: Array.from({length: 9}, (_, index) => `file-${index}`)}));
  for (let index = 0; index < 9; index++) combined.addFile(combined.root, `.t3-supervisor/steps/file-${index}.md`, `#${"x".repeat(60_000)}\n`);
  const totalLimit = yield* load(combined, combined.projectId);
  assert.equal(totalLimit.complete, false);
  assert.equal(totalLimit.revision, null);
  assert.ok(totalLimit.issues.some(issue => issue.code === "definition_source_unreadable"));
}));

it.effect("selects the native operative worktree binding and keeps missing project scope explicit", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addFile("/worktrees/feature", ".t3-supervisor/project.yaml", indexSource());
  const snapshot = yield* load(f, f.projectId, "thread");
  assert.equal(snapshot.workspaceRoot, "/worktrees/feature");
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.issues.some(issue => issue.code === "steps_directory_missing"));

  const missing = makeDefinitionFixture();
  const absent = yield* load(missing, missing.projectId);
  assert.equal(absent.status, "missing");
  assert.equal(absent.complete, true);
  assert.equal(absent.revision !== null, true);
  assert.equal(absent.sources.length, 0);
}));

it.effect("a representative 12-step and 5-workflow index loads every indexed definition with its summary and derives inclusion from flags", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  const steps = ["scope-and-authority", "context", "plan", "implement", "unit-tests", "integration-tests", "lint", "docs", "security", "performance", "release-notes", "verify"];
  const workflows = ["review", "delivery", "hotfix", "research", "release"];
  for (const id of steps) f.addFile(f.root, `.t3-supervisor/steps/${id}.md`, stepSource(id, `Full guidance for ${id}.`));
  f.addFile(f.root, ".t3-supervisor/workflows/review.yaml", workflowSource("Review", "  - step: security\n  - step: verify\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/delivery.yaml", workflowSource("Delivery", "  - workflow: review\n  - step: release-notes\n"));
  for (const id of ["hotfix", "research", "release"]) f.addFile(f.root, `.t3-supervisor/workflows/${id}.yaml`, workflowSource(id, "  - step: plan\n  - step: implement\n"));
  f.writeIndex(f.root, {required: [{step: "scope-and-authority"}, {workflow: "review"}], default_workflow: "delivery"});
  const snapshot = yield* load(f, f.projectId);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.issues, []);
  assert.equal(snapshot.steps.length, 12);
  assert.deepEqual(snapshot.workflows.map(workflow => workflow.id).sort(), [...workflows].sort());
  assert.deepEqual(snapshot.steps.map(step => step.id).sort(), [...steps].sort());
  assert.equal(snapshot.definitionFiles.length, 17);
  assert.deepEqual(requiredReferences(snapshot.config), [{workflow: "review"}, {step: "scope-and-authority"}]);
  assert.equal(snapshot.config.default_workflow, "delivery");
  for (const definition of [...snapshot.steps, ...snapshot.workflows])
    assert.equal(definition.summary, [...snapshot.config.steps, ...snapshot.config.workflows].find(row => row.id === definition.id)?.summary);
  assert.equal(snapshot.steps.find(step => step.id === "verify")?.description, "Full guidance for verify.", "the full description stays the policy");
  const context = proposalContextFromDefinitions(snapshot);
  assert.equal(context.requirementsKnown, true);
  assert.deepEqual(context.config.required, [{workflow: "review"}, {step: "scope-and-authority"}]);
}));

it.effect("unlisted, missing and stale definition files are diagnosed without dropping any required flag", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/steps/listed.md", stepSource("listed"));
  f.addFile(f.root, ".t3-supervisor/steps/stray.md", stepSource("stray"));
  f.addFile(f.root, ".t3-supervisor/workflows/forgotten.yaml", workflowSource("Forgotten", "  - step: listed\n"));
  f.addFile(f.root, ".t3-supervisor/project.yaml", indexSource({steps: ["listed", "gone"], workflows: ["review"], required: [{step: "gone"}, {workflow: "review"}]}));
  const snapshot = yield* load(f, f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true, "every file was observed; the gaps are authoring diagnostics");
  assert.ok(snapshot.revision);
  assert.deepEqual(snapshot.steps.map(step => step.id), ["listed"], "only indexed files are reusable definitions");
  assert.deepEqual(snapshot.workflows, []);
  assert.ok(!f.calls.some(call => call.kind === "read" && /stray|forgotten/.test(call.path)), "unlisted files are reported but never read");
  const codes = (code: string) => snapshot.issues.filter(issue => issue.code === code).map(issue => issue.path).sort();
  assert.deepEqual(codes("definition_unlisted"), [".t3-supervisor/steps/stray.md", ".t3-supervisor/workflows/forgotten.yaml"]);
  assert.deepEqual(codes("catalog_entry_missing"), [".t3-supervisor/steps/gone.md", ".t3-supervisor/workflows/review.yaml"]);
  assert.ok(snapshot.issues.some(issue => issue.code === "required_step_missing" && issue.message.includes("gone")));
  assert.ok(snapshot.issues.some(issue => issue.code === "required_workflow_missing" && issue.message.includes("review")));
  assert.deepEqual(requiredReferences(snapshot.config), [{workflow: "review"}, {step: "gone"}], "missing rows keep their required flags");
  assert.deepEqual(snapshot.definitionFiles.map(file => file.path), ["steps/listed.md", "steps/stray.md", "workflows/forgotten.yaml"]);
  const context = proposalContextFromDefinitions(snapshot);
  assert.deepEqual(context.knownRequirementKeys, ["workflow:review", "step:gone"], "the unresolved obligations stay known and visible");
}));
