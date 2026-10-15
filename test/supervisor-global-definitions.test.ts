import assert from "node:assert/strict";
import {test} from "node:test";
import {ProjectFileError} from "../src/project-files.js";
import {proposalContextFromDefinitions} from "../src/supervisor-workflow.js";
import {makeDefinitionFixture, stepSource, workflowSource} from "./project-definitions-fixture.js";

test("merges global and project definitions with separate identities and editable local configuration", async () => {
  const f = makeDefinitionFixture({globalEnabled: true});
  const globalConfig = "required:\n  - step: review\n  - workflow: delivery\ndefault_workflow: delivery\n";
  const projectConfig = "required:\n  - step: review\n  - workflow: delivery\ndefault_workflow: delivery\n";
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", globalConfig);
  f.addFile(f.globalRoot, ".t3-supervisor/steps/review.md", stepSource("review", "Shared review instructions."));
  f.addFile(f.globalRoot, ".t3-supervisor/workflows/reviewer.yaml", workflowSource("Reviewer", "  - step: review\n"));
  f.addFile(f.globalRoot, ".t3-supervisor/workflows/delivery.yaml", workflowSource("Global delivery", "  - workflow: reviewer\n"));
  f.addFile(f.root, ".t3-supervisor/project.yaml", projectConfig);
  f.addFile(f.root, ".t3-supervisor/steps/review.md", stepSource("review", "Project review instructions."));
  f.addFile(f.root, ".t3-supervisor/workflows/reviewer.yaml", workflowSource("Project reviewer", "  - step: review\n"));
  f.addFile(f.root, ".t3-supervisor/workflows/delivery.yaml", workflowSource("Project delivery", "  - workflow: reviewer\n"));

  const snapshot = await f.loader.load(f.projectId);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.globalOnly, false);
  assert.ok(snapshot.revision);
  assert.ok(snapshot.globalRevision);
  assert.deepEqual(snapshot.projectConfig, {default_workflow: "delivery", required: [{step: "review"}, {workflow: "delivery"}]});
  assert.deepEqual(snapshot.config.required.slice(2), snapshot.projectConfig.required);
  assert.equal(snapshot.config.default_workflow, "delivery");
  assert.equal(snapshot.steps.length, 2);
  const globalStep = snapshot.steps.find(step => step.origin === "global");
  const projectStep = snapshot.steps.find(step => step.origin === "project");
  assert.ok(globalStep);
  assert.ok(projectStep);
  assert.notEqual(globalStep.id, projectStep.id);
  assert.equal(globalStep.sourceId, "review");
  assert.equal(globalStep.path, "/server-home/.t3-supervisor/steps/review.md");
  assert.equal(projectStep.id, "review");
  const globalDelivery = snapshot.workflows.find(workflow => workflow.origin === "global" && workflow.sourceId === "delivery");
  const projectDelivery = snapshot.workflows.find(workflow => workflow.origin === "project" && workflow.id === "delivery");
  assert.ok(globalDelivery);
  assert.ok(projectDelivery);
  assert.notEqual(globalDelivery.id, projectDelivery.id);
  assert.deepEqual(globalDelivery.sequence, [{workflow: snapshot.workflows.find(workflow => workflow.origin === "global" && workflow.sourceId === "reviewer")!.id}]);
  assert.deepEqual(projectDelivery.sequence, [{workflow: "reviewer"}]);
  assert.deepEqual(snapshot.sources.map(source => source.origin), ["global", "global", "global", "global", "project", "project", "project", "project"]);
  assert.equal(snapshot.globalRevision, await f.loader.globalFingerprint(AbortSignal.timeout(5000)));
});

test("uses enabled global definitions alone for Scratch and never reads the scratch checkout", async () => {
  let globalEnabled = true;
  const f = makeDefinitionFixture({projectId: "scratch", root: "/scratch", scratch: true, globalEnabled});
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", "required:\n  - workflow: shared\ndefault_workflow: shared\n");
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared.md", stepSource("shared"));
  f.addFile(f.globalRoot, ".t3-supervisor/workflows/shared.yaml", workflowSource("Shared", "  - step: shared\n"));
  f.addFile("/scratch", ".t3-supervisor/project.yaml", "required: []\n");
  f.addFile("/scratch", ".t3-supervisor/steps/local.md", stepSource("local"));
  const active = await f.loader.load("scratch", "thread");
  assert.equal(active.status, "ready");
  assert.equal(active.globalOnly, true);
  assert.equal(active.workspaceRoot, "/worktrees/feature");
  assert.equal(active.projectConfig, null);
  assert.deepEqual(active.config.required, [{workflow: active.workflows.find(workflow => workflow.origin === "global")!.id}]);
  assert.ok(f.calls.every(call => call.root !== "/worktrees/feature" && call.root !== "/scratch"));

  globalEnabled = false;
  const disabledFixture = makeDefinitionFixture({projectId: "scratch", root: "/scratch", scratch: true, globalEnabled});
  disabledFixture.addFile(disabledFixture.globalRoot, ".t3-supervisor/project.yaml", "required: []\n");
  const disabled = await disabledFixture.loader.load("scratch", "thread");
  assert.equal(disabled.status, "ready");
  assert.equal(disabled.globalOnly, true);
  assert.equal(disabled.globalRevision, null);
  assert.equal(disabled.sources.length, 0);
  assert.deepEqual(disabled.config, {required: []});
  assert.equal(disabled.complete, true);
  assert.ok(disabledFixture.calls.every(call => call.root !== disabledFixture.globalRoot && call.root !== "/worktrees/feature"));
});

test("an unreadable enabled global scope cannot become an empty ready collection", async () => {
  const f = makeDefinitionFixture({globalEnabled: true});
  f.addFile(f.root, ".t3-supervisor/project.yaml", "required: []\n");
  f.addDirectory(f.root, ".t3-supervisor/steps");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  f.failures.set(`${f.globalRoot}|.t3-supervisor`, new ProjectFileError("permission_required"));
  const snapshot = await f.loader.load(f.projectId);
  assert.equal(snapshot.status, "permission_required");
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.revision, null);
  assert.equal(snapshot.globalRevision, null);
  assert.deepEqual(snapshot.sources.map(source => source.origin), ["project"]);
});

test("keeps enabled global requirements visible when the project folder is missing", async () => {
  const f = makeDefinitionFixture({globalEnabled: true});
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", "required:\n  - step: shared\n");
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared.md", stepSource("shared"));
  f.addDirectory(f.globalRoot, ".t3-supervisor/workflows");
  const snapshot = await f.loader.load(f.projectId);
  assert.equal(snapshot.status, "missing");
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.revision);
  assert.equal(snapshot.config.required.length, 1);
  assert.equal("step" in snapshot.config.required[0]!, true);
  assert.equal(snapshot.steps[0]?.origin, "global");
});

test("missing enabled global definitions remain explicit and global fingerprints track later sources", async () => {
  const f = makeDefinitionFixture({globalEnabled: true});
  f.addFile(f.root, ".t3-supervisor/project.yaml", "required: []\n");
  f.addDirectory(f.root, ".t3-supervisor/steps");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
  const localOnly = await f.loader.load(f.projectId);
  assert.equal(localOnly.status, "missing");
  assert.equal(localOnly.complete, true);
  assert.ok(localOnly.revision);
  assert.ok(localOnly.globalRevision);
  assert.ok(localOnly.issues.some(issue => issue.code === "global_definitions_missing"));
  assert.equal(proposalContextFromDefinitions(localOnly).requirementsKnown, false);

  const malformed = "required: [\n";
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", malformed);
  f.addFile(f.globalRoot, ".t3-supervisor/steps/not-a-step.md", "invalid but readable\n");
  const invalid = await f.loader.load(f.projectId);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.complete, true);
  assert.ok(invalid.revision);
  assert.notEqual(invalid.globalRevision, localOnly.globalRevision);
  assert.ok(invalid.sources.some(source => source.origin === "global" && source.content === malformed));
});
