import assert from "node:assert/strict";
import {test} from "node:test";
import {ProjectConfigEditor} from "../src/project-config-editor.js";
import {parseDefinitionStep, parseDefinitionWorkflow, parseProjectConfiguration} from "../src/project-definitions.js";
import {ProjectFileError} from "../src/project-files.js";
import {proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {makeDefinitionFixture, stepSource, workflowSource} from "./project-definitions-fixture.js";

test("parses the strict project configuration and step formats", () => {
  assert.deepEqual(parseProjectConfiguration("required: []\ndefault_workflow: reviewer\n"), {default_workflow: "reviewer", required: []});
  assert.deepEqual(parseProjectConfiguration("required:\n  - step: e2e-testing\n  - workflow: reviewer\n"), {
    required: [{step: "e2e-testing"}, {workflow: "reviewer"}],
  });
  for (const text of [
    "required: []\nextra: true\n",
    "required:\n  - step: invalid/identifier\n",
    "required:\n  - step: shared\n  - step: shared\n",
    "required: [\n",
    "required: &shared\n  - step: foo\ndefault_workflow: *shared\n",
    "required: !custom []\n",
  ]) assert.throws(() => parseProjectConfiguration(text));

  const source = "---\r\nid: review\r\nname: Review\r\ndescription: |\r\n  Inspect the change.\r\n---\r\n  \r\n";
  assert.deepEqual(parseDefinitionStep("review", source), {id: "review", name: "Review", description: "Inspect the change."});
  for (const [id, contents] of [
    ["other", source],
    ["review", source.replace("name: Review", "name: Review\nextra: forbidden")],
    ["review", source + "A body is forbidden.\n"],
    ["../review", source],
  ]) assert.throws(() => parseDefinitionStep(id!, contents!));
});

test("parses reusable and local steps in nested ordered and parallel workflow groups", () => {
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

test("retains unknown refs as diagnostics in a complete invalid source snapshot", async () => {
  const f = makeDefinitionFixture();
  const configuration = "required:\n  - step: missing-required\n  - workflow: missing-workflow\ndefault_workflow: missing-default\n";
  const step = stepSource("known", "A reusable step.");
  const workflow = workflowSource("Delivery", "  - step: missing-step\n  - workflow: missing-nested\n  - parallel:\n      - step: known\n");
  f.addFile(f.root, ".t3-supervisor/project.yaml", configuration);
  f.addFile(f.root, ".t3-supervisor/steps/known.md", step);
  f.addFile(f.root, ".t3-supervisor/workflows/delivery.yaml", workflow);
  const snapshot = await f.loader.load(f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.match(snapshot.revision ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.projectConfig, {default_workflow: "missing-default", required: [{step: "missing-required"}, {workflow: "missing-workflow"}]});
  assert.deepEqual(snapshot.config, snapshot.projectConfig);
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
});

test("allows independent workflow reuse and reports exact direct and indirect cycles", async () => {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", "required: []\ndefault_workflow: root\n");
  f.addFile(f.root, ".t3-supervisor/steps/check.md", stepSource("check"));
  f.addFile(f.root, ".t3-supervisor/workflows/root.yaml", workflowSource("Root", "  - workflow: branch-a\n  - workflow: branch-b\n  - workflow: shared\n  - workflow: shared\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/branch-a.yaml", workflowSource("Branch A", "  - workflow: shared\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/branch-b.yaml", workflowSource("Branch B", "  - workflow: shared\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/shared.yaml", workflowSource("Shared", "  - step: check\n"));
  const reusable = await f.loader.load(f.projectId);
  assert.equal(reusable.status, "ready");
  assert.equal(reusable.complete, true);
  assert.equal(reusable.issues.length, 0);

  f.addFile(f.root, ".t3-supervisor/workflows/branch-a.yaml", workflowSource("Branch A", "  - workflow: shared\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/shared.yaml", workflowSource("Shared", "  - workflow: branch-a\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/direct.yaml", workflowSource("Direct", "  - workflow: direct\n"));
  const cycles = await f.loader.load(f.projectId);
  assert.equal(cycles.status, "invalid");
  const messages = cycles.issues.filter(issue => issue.code === "workflow_cycle").map(issue => issue.message);
  assert.ok(messages.includes("Workflow reference cycle: branch-a -> shared -> branch-a."));
  assert.ok(messages.includes("Workflow reference cycle: direct -> direct."));
  assert.equal(cycles.complete, true);
  assert.ok(cycles.revision);
});

test("rejects statically expanded workflow graphs beyond the shared node budget", async () => {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", "required: []\n");
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

  const snapshot = await f.loader.load(f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true, "all source files were readable; expansion failure is a definition diagnostic");
  assert.ok(snapshot.revision);
  assert.ok(snapshot.issues.some(issue => issue.code === "workflow_expansion_limit"));
  assert.ok(snapshot.issues.some(issue => issue.code === "workflow_expansion_depth") === false,
    "the graph exceeds the node budget without exceeding the depth bound");
});

test("keeps a 12-workflow reference chain within the shared structural depth bound", async () => {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", "required: []\n");
  f.addDirectory(f.root, ".t3-supervisor/steps");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  f.addFile(f.root, ".t3-supervisor/steps/check.md", stepSource("check"));
  for (let index = 0; index < 12; index++) {
    const nodes = index === 11 ? "  - step: check\n" : `  - workflow: chain-${index + 1}\n`;
    f.addFile(f.root, `.t3-supervisor/workflows/chain-${index}.yaml`, workflowSource(`Chain ${index}`, nodes));
  }

  const snapshot = await f.loader.load(f.projectId);
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
});

test("keeps a genuinely over-bound workflow reference chain explicitly invalid", async () => {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", "required: []\n");
  f.addDirectory(f.root, ".t3-supervisor/steps");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  f.addFile(f.root, ".t3-supervisor/steps/check.md", stepSource("check"));
  for (let index = 0; index < 16; index++) {
    const nodes = index === 15 ? "  - step: check\n" : `  - workflow: chain-${index + 1}\n`;
    f.addFile(f.root, `.t3-supervisor/workflows/chain-${index}.yaml`, workflowSource(`Chain ${index}`, nodes));
  }

  const snapshot = await f.loader.load(f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.revision);
  assert.ok(snapshot.issues.some(issue => issue.code === "workflow_expansion_depth"));
  const proposal = validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [
    {kind: "workflow", definitionId: "chain-0", reason: "This source exceeds the structural depth bound."},
  ]}}, proposalContextFromDefinitions(snapshot));
  assert.ok(proposal);
  assert.ok(proposal.issues.some(issue => issue.code === "workflow_expansion_depth"));
});

test("keeps invalid readable files and project config diagnostics without inventing empty valid policy", async () => {
  const f = makeDefinitionFixture();
  const configuration = "required: [\n";
  const step = "---\nid: review\nname: Review\ndescription: Inspect.\n---\nBody text is not allowed.\n";
  const workflow = "name: Review\ndescription: Invalid root.\nsteps: [review]\n";
  f.addFile(f.root, ".t3-supervisor/project.yaml", configuration);
  f.addFile(f.root, ".t3-supervisor/steps/review.md", step);
  f.addFile(f.root, ".t3-supervisor/workflows/reviewer.yaml", workflow);
  const snapshot = await f.loader.load(f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.revision);
  assert.equal(snapshot.projectConfig, null);
  assert.deepEqual(snapshot.config, {required: []});
  assert.deepEqual(snapshot.sources.map(source => source.content), [configuration, step, workflow]);
  assert.ok(snapshot.issues.some(issue => issue.code === "project_configuration_invalid"));
  assert.ok(snapshot.issues.some(issue => issue.code === "steps_invalid"));
  assert.ok(snapshot.issues.some(issue => issue.code === "workflows_invalid"));
});

test("reports stray and retired entries without reading or counting them as definition sources", async () => {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", "required: []\n");
  f.addFile(f.root, ".t3-supervisor/steps/valid.md", "invalid definition content\n");
  f.addFile(f.root, ".t3-supervisor/steps/README.md", "#" + "x".repeat(64 * 1024));
  f.addFile(f.root, ".t3-supervisor/steps/.DS_Store", "#" + "x".repeat(64 * 1024));
  f.addFile(f.root, ".t3-supervisor/steps/valid.MD", "#" + "x".repeat(64 * 1024));
  f.addFile(f.root, ".t3-supervisor/.DS_Store", "#" + "x".repeat(64 * 1024));
  f.addFile(f.root, ".t3-supervisor/rules.yaml", "rules: []\n");
  f.addDirectory(f.root, ".t3-supervisor/blocks");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  const snapshot = await f.loader.load(f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.revision);
  assert.deepEqual(snapshot.sources.map(source => source.path), [".t3-supervisor/project.yaml", ".t3-supervisor/steps/valid.md"]);
  assert.ok(snapshot.issues.some(issue => issue.code === "legacy_definition_format" && issue.message.includes("Replace it with project.yaml")));
  assert.ok(snapshot.issues.some(issue => issue.code === "steps_path_invalid"));
  assert.ok(snapshot.issues.some(issue => issue.code === "steps_case_collision"));
  assert.ok(!snapshot.issues.some(issue => issue.path.includes(".DS_Store")));
  assert.ok(!f.calls.some(call => call.kind === "read" && /README|DS_Store|rules\.yaml|valid\.MD/.test(call.path)));

  const saved = await new ProjectConfigEditor(f.loader, f.writer).save({
    projectId: f.projectId, threadId: null, expectedRevision: snapshot.revision!, config: {required: []},
  });
  assert.equal(saved.status, "saved");
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]?.path, ".t3-supervisor/project.yaml");
});

test("ignores inert Finder metadata without making a valid definition scope invalid", async () => {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", "required: []\n");
  f.addFile(f.root, ".t3-supervisor/.DS_Store", "metadata only\n");
  f.addFile(f.root, ".t3-supervisor/steps/.DS_Store", "metadata only\n");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  const snapshot = await f.loader.load(f.projectId);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.sources.length, 1);
  assert.equal(snapshot.issues.length, 0);
  assert.ok(!f.calls.some(call => call.kind === "read" && call.path.includes(".DS_Store")));
});

test("does not migrate old-only folders and explains the manual format replacement", async () => {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/rules.yaml", "rules: []\n");
  f.addDirectory(f.root, ".t3-supervisor/blocks");
  const snapshot = await f.loader.load(f.projectId);
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.revision);
  assert.equal(snapshot.sources.some(source => source.path.includes("rules.yaml")), false);
  assert.ok(snapshot.issues.some(issue => issue.code === "legacy_definition_format" && /required: \[\]/.test(issue.message)));
});

test("permission, truncation, unsafe paths and source size limits never appear complete", async () => {
  const denied = makeDefinitionFixture();
  denied.addFile(denied.root, ".t3-supervisor/project.yaml", "required: []\n");
  denied.addFile(denied.root, ".t3-supervisor/steps/review.md", stepSource("review"));
  denied.failures.set(`${denied.root}|.t3-supervisor/steps/review.md`, new ProjectFileError("permission_required"));
  const permission = await denied.loader.load(denied.projectId);
  assert.equal(permission.status, "permission_required");
  assert.equal(permission.complete, false);
  assert.equal(permission.revision, null);
  assert.equal(permission.sources.length, 1);

  const truncated = makeDefinitionFixture();
  truncated.addFile(truncated.root, ".t3-supervisor/project.yaml", "required: []\n");
  truncated.addDirectory(truncated.root, ".t3-supervisor/steps");
  truncated.truncatedPaths.add(`${truncated.root}|.t3-supervisor/steps`);
  const partial = await truncated.loader.load(truncated.projectId);
  assert.equal(partial.complete, false);
  assert.equal(partial.revision, null);
  assert.ok(partial.issues.some(issue => issue.code === "steps_listing_incomplete"));

  const unsafe = makeDefinitionFixture();
  unsafe.addFile(unsafe.root, ".t3-supervisor/project.yaml", "required: []\n");
  unsafe.addDirectory(unsafe.root, ".t3-supervisor/steps");
  const list = unsafe.files.list;
  unsafe.files.list = async (root, path, signal) => path === ".t3-supervisor/steps"
    ? {truncated: false, entries: [{path: ".t3-supervisor/../../outside.md", kind: "file"}]}
    : list(root, path, signal);
  const malformedListing = await unsafe.loader.load(unsafe.projectId);
  assert.equal(malformedListing.complete, false);
  assert.ok(!unsafe.calls.some(call => call.kind === "read" && call.path.includes("outside")));

  const oversized = makeDefinitionFixture();
  oversized.addFile(oversized.root, ".t3-supervisor/project.yaml", "required: []\n");
  oversized.addFile(oversized.root, ".t3-supervisor/steps/large.md", `#${"x".repeat(64 * 1024)}\n`);
  const tooLarge = await oversized.loader.load(oversized.projectId);
  assert.equal(tooLarge.status, "invalid");
  assert.equal(tooLarge.complete, false);
  assert.equal(tooLarge.revision, null);
  assert.ok(tooLarge.sources.every(source => Buffer.byteLength(source.content, "utf8") <= 64 * 1024));

  const combined = makeDefinitionFixture();
  combined.addFile(combined.root, ".t3-supervisor/project.yaml", "required: []\n");
  for (let index = 0; index < 9; index++) combined.addFile(combined.root, `.t3-supervisor/steps/file-${index}.md`, `#${"x".repeat(60_000)}\n`);
  const totalLimit = await combined.loader.load(combined.projectId);
  assert.equal(totalLimit.complete, false);
  assert.equal(totalLimit.revision, null);
  assert.ok(totalLimit.issues.some(issue => issue.code === "definition_source_unreadable"));
});

test("selects the native operative worktree binding and keeps missing project scope explicit", async () => {
  const f = makeDefinitionFixture();
  f.addFile("/worktrees/feature", ".t3-supervisor/project.yaml", "required: []\n");
  const snapshot = await f.loader.load(f.projectId, "thread");
  assert.equal(snapshot.workspaceRoot, "/worktrees/feature");
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.issues.some(issue => issue.code === "steps_directory_missing"));

  const missing = makeDefinitionFixture();
  const absent = await missing.loader.load(missing.projectId);
  assert.equal(absent.status, "missing");
  assert.equal(absent.complete, true);
  assert.equal(absent.revision !== null, true);
  assert.equal(absent.sources.length, 0);
});
