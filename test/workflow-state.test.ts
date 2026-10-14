import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint, GuidanceStore } from "../src/guidance-store.js";
import { defaultSupervisorModel, ProjectSupervisorStore } from "../src/project-supervisor-store.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import { workflowMutationLimits } from "../src/workflow-state-contract.js";
import type { WorkflowAgreementImport, WorkflowApplyInput, WorkflowOwner } from "../src/workflow-state-contract.js";

type Fixture = {
  directory: string;
  guidance: GuidanceStore;
  supervisors: ProjectSupervisorStore;
  workflows: WorkflowStateStore;
  owner: WorkflowOwner;
};

const makeFixture = async (): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-state-test-"));
  const guidance = new GuidanceStore(directory);
  const supervisors = new ProjectSupervisorStore(guidance, new Set());
  const projectId = "project-a";
  const mainThreadId = "main-a";
  guidance.db.prepare("INSERT INTO meta VALUES(?,?)").run(`supervisor_control:${JSON.stringify(projectId)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const reserved = supervisors.reserve(projectId, mainThreadId, "Main conversation", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  supervisors.setBinding(binding);
  return {directory, guidance, supervisors, workflows: new WorkflowStateStore(supervisors),
    owner: {projectId, mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation}};
};

const closeFixture = async (fixture: Fixture) => {
  fixture.guidance.close();
  await rm(fixture.directory, {recursive: true, force: true});
};

const acceptedAgreement = (): WorkflowAgreementImport => ({
  taskId: "task-a",
  sourceThreadId: "main-a",
  sourceRunId: "run-a",
  sourceMessageId: "message-a",
  sourceHash: "source-hash-a",
  objective: "Prepare the export workflow.",
  agreement: {
    status: "agreed",
    message: "The complete workflow was echoed by the operative assistant.",
    proposalId: "proposal-a",
    agreedAt: 123,
    supervisorMessageId: "supervisor-message-a",
    agentMessageId: "agent-message-a",
    workflow: {
      status: "proposed",
      message: "Draft workflow proposed from the task plan.",
      workspaceRoot: "/workspace/project-a",
      revision: "definition-revision-a",
      rules: [{index: 0, name: "Tests", applies: true, reason: "This task changes code."}],
      steps: [{blockId: null, name: "Implement export", reason: "Build the requested export."}],
    },
  },
});

const reverseObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).reverse().map(key => [key, reverseObjectKeys(record[key])]));
};

const addStep = (workflowId: string, expectedRevision: number, operationId = "apply-a"): WorkflowApplyInput => ({
  operationId,
  workflowId,
  expectedRevision,
  status: "planned",
  objective: "Prepare the export workflow.",
  rules: [],
  steps: [{blockId: null, name: "Inspect the export path", reason: "Find the relevant implementation.", status: "planned", contributorThreadIds: ["main-a"]}],
  note: "The broad plan now includes the initial investigation.",
});

test("main draft edits use revision CAS and idempotent operation receipts", async () => {
  const fixture = await makeFixture();
  try {
    const created = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-a", "Start a draft before any agreement."));
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    assert.equal(created.revision, 1);
    const initial = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId);
    assert.ok(initial);
    assert.equal(initial.currentAgreementKey, null);
    assert.deepEqual(initial.acceptedAgreements, []);

    const applied = fixture.workflows.apply(fixture.owner, addStep(created.workflowId, created.revision));
    assert.equal(applied.status, "applied");
    if (applied.status !== "applied") return;
    assert.equal(applied.revision, 2);
    assert.deepEqual(fixture.workflows.apply(fixture.owner, addStep(created.workflowId, created.revision)), applied);
    assert.deepEqual(fixture.workflows.apply(reverseObjectKeys(fixture.owner) as WorkflowOwner,
      reverseObjectKeys(addStep(created.workflowId, created.revision)) as WorkflowApplyInput), applied,
    "reordered nested object keys preserve the canonical request replay");

    const reused = fixture.workflows.apply(fixture.owner, {...addStep(created.workflowId, created.revision), note: "Different payload with the same ID."});
    assert.deepEqual(reused, {status: "conflict", operationId: "apply-a", reason: "operation_id_reused", currentRevision: null});
    const stale = fixture.workflows.apply(fixture.owner, {...addStep(created.workflowId, created.revision, "apply-stale"), note: "A stale write."});
    assert.deepEqual(stale, {status: "conflict", operationId: "apply-stale", reason: "revision", currentRevision: 2});

    const current = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const step = current.steps[0]!;
    const statusUpdate: WorkflowApplyInput = {...addStep(current.workflowId, current.revision, "apply-status"), steps: [{...step, status: "underway"}],
      evidence: [{kind: "status_changed", targetStepId: step.id, note: "Work started in the main conversation.", sourceThreadId: "main-a"}]};
    const statusResult = fixture.workflows.apply(fixture.owner, statusUpdate, 456);
    assert.equal(statusResult.status, "applied");
    const updated = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    assert.equal(updated.steps[0]?.status, "underway");
    assert.ok(updated.evidence.some(item => item.kind === "status_changed" && item.targetStepId === step.id &&
      item.statusFrom === "planned" && item.statusTo === "underway" && item.sourceThreadId === "main-a"));
    assert.deepEqual(fixture.workflows.apply(fixture.owner, addStep(created.workflowId, created.revision)), applied);
    assert.equal(fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, 3,
      "replaying an earlier operation returns its receipt without reverting newer state");
  } finally {await closeFixture(fixture);}
});

test("accepted agreement history stays exact when the current plan is structurally edited", async () => {
  const fixture = await makeFixture();
  try {
    const source = acceptedAgreement();
    const imported = fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, source, 100));
    assert.equal(imported.status, "applied");
    if (imported.status !== "applied") return;
    const first = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    assert.equal(first.revision, 1);
    assert.equal(first.currentAgreementKey, first.acceptedAgreements[0]?.key);
    assert.equal(first.steps[0]?.status, "planned");
    assert.deepEqual(first.acceptedAgreements[0]?.agreement, source.agreement);
    assert.equal(first.acceptedAgreements[0]?.agreement.workflow.steps[0]?.name, "Implement export");

    const duplicate = fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(
      reverseObjectKeys(fixture.owner) as WorkflowOwner, reverseObjectKeys(source) as WorkflowAgreementImport, 200));
    assert.deepEqual(duplicate, imported);
    assert.equal(fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, 1);

    const current = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const edited = fixture.workflows.apply(fixture.owner, {...addStep(current.workflowId, current.revision, "plan-edit"),
      objective: current.objective, rules: current.rules, steps: [{...current.steps[0]!, name: "Implement and review export"}],
      note: "The plan was refined after work began."}, 300);
    assert.equal(edited.status, "applied");
    const afterEdit = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    assert.equal(afterEdit.currentAgreementKey, null);
    assert.equal(afterEdit.steps[0]?.name, "Implement and review export");
    assert.deepEqual(afterEdit.acceptedAgreements[0]?.agreement, source.agreement);
    assert.deepEqual(fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, source, 400)), imported);
    assert.equal(fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, 2,
      "an exact historical import replay leaves the edited plan untouched");

    const conflictingImport = fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner,
      {...source, agreement: {...source.agreement, workflow: {...source.agreement.workflow, steps: [{blockId: null, name: "Different", reason: "Changed under the same proposal."}]}}}));
    assert.equal(conflictingImport.status, "conflict");
    if (conflictingImport.status === "conflict") assert.equal(conflictingImport.reason, "operation_id_reused");
  } finally {await closeFixture(fixture);}
});

test("an oversized UTF-8 first agreement import leaves no partial root and can retry after reopen", async () => {
  const fixture = await makeFixture();
  let guidance: GuidanceStore | null = fixture.guidance;
  try {
    const source = acceptedAgreement();
    const oversized = {...source, agreement: {...source.agreement,
      message: "é".repeat(Math.floor(workflowMutationLimits.maxDocumentBytes / 2))}};
    const rejected = guidance!.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, oversized, 150));
    assert.deepEqual(rejected, {status: "invalid", operationId: rejected.operationId, reason: "document_capacity"});
    assert.equal(fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId), null);
    assert.equal(Number(guidance!.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_state").get()?.n), 0);
    assert.equal(Number(guidance!.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_operations").get()?.n), 0);

    guidance!.close();
    guidance = null;
    const reopenedGuidance = new GuidanceStore(fixture.directory);
    guidance = reopenedGuidance;
    const supervisors = new ProjectSupervisorStore(reopenedGuidance, new Set());
    const workflows = new WorkflowStateStore(supervisors);
    assert.equal(workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId), null,
      "a failed import did not persist a revision-zero root draft");
    const retry = reopenedGuidance.transaction(() => workflows.importAcceptedAgreementInTransaction(fixture.owner, source, 200));
    assert.equal(retry.status, "applied", "the failed payload did not reserve its deterministic operation ID");
    assert.equal(workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, 1);
  } finally {
    guidance?.close();
    await rm(fixture.directory, {recursive: true, force: true});
  }
});

test("malformed evidence input is rejected without throwing or reserving its operation ID", async () => {
  const fixture = await makeFixture();
  try {
    const created = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-evidence-guard", "Create a draft."));
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const input = addStep(created.workflowId, created.revision, "evidence-guard-retry");
    for (const evidence of [null, {length: 0}]) {
      const malformed = {...input, evidence} as unknown as WorkflowApplyInput;
      assert.deepEqual(fixture.workflows.apply(fixture.owner, malformed), {
        status: "invalid", operationId: input.operationId, reason: "invalid_workflow_document",
      });
    }
    assert.equal(fixture.workflows.apply(fixture.owner, input).status, "applied");
  } finally {await closeFixture(fixture);}
});

test("operation IDs are scoped by owner while preserving same-owner conflict checks", async () => {
  const fixture = await makeFixture();
  try {
    const secondBinding = fixture.supervisors.reserve(fixture.owner.projectId, "main-b", "Second main", defaultSupervisorModel, 1, 1);
    const readySecondBinding = {...secondBinding, state: "ready" as const};
    fixture.supervisors.setBinding(readySecondBinding);
    const secondOwner: WorkflowOwner = {...fixture.owner, mainThreadId: "main-b", supervisorThreadId: readySecondBinding.threadId,
      bindingGeneration: readySecondBinding.generation};
    const operationId = "shared-across-owners";
    const first = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, operationId, "First owner's draft."));
    const second = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(secondOwner, operationId, "Second owner's draft."));
    assert.equal(first.status, "created");
    assert.equal(second.status, "created", "another authorized owner can use the same operation ID");
    if (first.status !== "created" || second.status !== "created") return;
    assert.notEqual(first.workflowId, second.workflowId);
    assert.deepEqual(fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(
      fixture.owner, operationId, "First owner's draft.")), first);
    assert.deepEqual(fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(
      secondOwner, operationId, "Second owner's draft.")), second);
    assert.deepEqual(fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(
      fixture.owner, operationId, "Changed content for the same owner.")), {
      status: "conflict", operationId, reason: "operation_id_reused", currentRevision: null,
    });
  } finally {await closeFixture(fixture);}
});

test("an edit operation ID cannot reserve the agreement import namespace", async () => {
  const fixture = await makeFixture();
  try {
    const source = acceptedAgreement();
    const operationId = "agreement:" + fingerprint([source.taskId, source.agreement.proposalId]);
    const created = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-agreement-namespace", "Create a draft."));
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const edit = fixture.workflows.apply(fixture.owner, {...addStep(created.workflowId, created.revision, operationId),
      note: "An authorized edit used a matching text ID."});
    assert.equal(edit.status, "applied");
    const imported = fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, source));
    assert.equal(imported.status, "applied", "the edit namespace cannot block validated agreement history");
    const namespaces = fixture.guidance.db.prepare("SELECT operation_namespace FROM supervisor_workflow_operations WHERE operation_id=? ORDER BY operation_namespace")
      .all(operationId).map(row => String(row.operation_namespace));
    assert.deepEqual(namespaces, ["agreement", "edit"]);
  } finally {await closeFixture(fixture);}
});

test("trusted child linkage creates an unaccepted workflow under its native parent", async () => {
  const fixture = await makeFixture();
  try {
    const root = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-root", "Create the parent workflow."));
    assert.equal(root.status, "created");
    const linked = fixture.supervisors.store.transaction(() => fixture.workflows.linkChildInTransaction(fixture.owner,
      {operationId: "lineage-child", lineage: {threadId: "child-a", parentThreadId: "main-a", relationshipToParent: "subagent"}, note: "The controller verified this native descendant."}));
    assert.equal(linked.status, "created");
    if (root.status !== "created" || linked.status !== "created") return;
    const child = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a");
    assert.ok(child);
    assert.equal(child.parentWorkflowId, root.workflowId);
    assert.equal(child.parentThreadId, "main-a");
    assert.equal(child.currentAgreementKey, null);
    assert.deepEqual(child.acceptedAgreements, []);
    assert.ok(child.evidence.some(item => item.kind === "lineage_linked"));

    const missingParent = fixture.supervisors.store.transaction(() => fixture.workflows.linkChildInTransaction(fixture.owner,
      {operationId: "lineage-missing", lineage: {threadId: "child-b", parentThreadId: "unknown-parent", relationshipToParent: "subagent"}, note: "Unknown ancestry."}));
    assert.equal(missingParent.status, "conflict");
    if (missingParent.status === "conflict") assert.equal(missingParent.reason, "parent_missing");
  } finally {await closeFixture(fixture);}
});

test("replaced supervisor identity cannot write even when its generation is reused", async () => {
  const fixture = await makeFixture();
  try {
    const created = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-owner", "Create a draft."));
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const oldBinding = fixture.supervisors.binding(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    fixture.supervisors.setBinding({...oldBinding, state: "missing"});
    const replacement = fixture.supervisors.replaceMissingBinding({...oldBinding, state: "missing"}, defaultSupervisorModel);
    const ready = {...replacement, state: "ready" as const};
    fixture.supervisors.setBinding(ready);
    assert.equal(ready.generation, fixture.owner.bindingGeneration);
    assert.notEqual(ready.threadId, fixture.owner.supervisorThreadId);

    const oldAttempt = fixture.workflows.apply(fixture.owner, addStep(created.workflowId, created.revision, "old-owner-write"));
    assert.deepEqual(oldAttempt, {status: "owner_mismatch", operationId: "old-owner-write"});
    const newOwner = {...fixture.owner, supervisorThreadId: ready.threadId, bindingGeneration: ready.generation};
    const newAttempt = fixture.workflows.apply(newOwner, addStep(created.workflowId, created.revision, "new-owner-write"));
    assert.equal(newAttempt.status, "applied");
    const operationCount = Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_operations").get()?.n ?? 0);
    assert.equal(operationCount, 2, "the rejected old-owner write did not reserve an operation ID");
  } finally {await closeFixture(fixture);}
});

test("owner coordinates must identify the current project, main thread, supervisor and generation", async () => {
  const fixture = await makeFixture();
  try {
    const created = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-owner-coordinates", "Create a draft."));
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const invalidOwners: Array<[string, WorkflowOwner]> = [
      ["wrong-project", {...fixture.owner, projectId: "project-b"}],
      ["wrong-main", {...fixture.owner, mainThreadId: "main-b"}],
      ["wrong-supervisor", {...fixture.owner, supervisorThreadId: "supervisor-b"}],
      ["wrong-generation", {...fixture.owner, bindingGeneration: fixture.owner.bindingGeneration + 1}],
    ];
    for (const [operationId, owner] of invalidOwners) {
      const result = fixture.workflows.apply(owner, addStep(created.workflowId, created.revision, operationId));
      assert.deepEqual(result, {status: "owner_mismatch", operationId});
    }
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_operations").get()?.n), 1,
      "rejected owners do not reserve operation IDs");
    const validRetry = fixture.workflows.apply(fixture.owner, addStep(created.workflowId, created.revision, "wrong-generation"));
    assert.equal(validRetry.status, "applied", "the current owner can use an ID rejected before authorization");
  } finally {await closeFixture(fixture);}
});

test("the injected project-enabled gate blocks writes without reserving their operation ID", async () => {
  const fixture = await makeFixture();
  try {
    let projectEnabled = true;
    const workflows = new WorkflowStateStore(fixture.supervisors,
      projectId => projectEnabled && projectId === fixture.owner.projectId);
    const created = fixture.supervisors.store.transaction(() => workflows.ensureMainInTransaction(fixture.owner, "ensure-enabled-gate", "Create a draft."));
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const input = addStep(created.workflowId, created.revision, "enabled-gate-retry");
    projectEnabled = false;
    assert.equal(fixture.supervisors.enabled(fixture.owner.projectId), true,
      "the injected gate can add project-specific eligibility beyond persisted controls");
    assert.deepEqual(workflows.apply(fixture.owner, input), {status: "owner_mismatch", operationId: input.operationId});
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_operations").get()?.n), 1);
    projectEnabled = true;
    assert.equal(workflows.apply(fixture.owner, input).status, "applied");
  } finally {await closeFixture(fixture);}
});

test("workflow ID lookups are owner-scoped inside the controller transaction", async () => {
  const fixture = await makeFixture();
  try {
    const created = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-lookup", "Create a draft."));
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const found = fixture.supervisors.store.transaction(() => fixture.workflows.getByIdForOwnerInTransaction(fixture.owner, created.workflowId));
    assert.equal(found.status, "found");
    if (found.status === "found") assert.equal(found.document.threadId, fixture.owner.mainThreadId);
    assert.deepEqual(fixture.supervisors.store.transaction(() => fixture.workflows.getByIdForOwnerInTransaction(
      {...fixture.owner, mainThreadId: "main-b"}, created.workflowId)), {status: "owner_mismatch"});
    assert.deepEqual(fixture.supervisors.store.transaction(() => fixture.workflows.getByIdForOwnerInTransaction(
      fixture.owner, "workflow-missing")), {status: "not_found"});
  } finally {await closeFixture(fixture);}
});

test("an unsupported scope version blocks workflow writes while preserving retained rows", async () => {
  const fixture = await makeFixture();
  let guidance: GuidanceStore | null = fixture.guidance;
  try {
    const created = guidance!.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-scope-guard", "Create a draft."));
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const input = addStep(created.workflowId, created.revision, "unsupported-scope-write");
    guidance!.db.prepare("UPDATE meta SET value='future' WHERE key='supervisor_scope_version'").run();
    guidance!.close();
    guidance = null;

    const reopenedGuidance = new GuidanceStore(fixture.directory);
    guidance = reopenedGuidance;
    const supervisors = new ProjectSupervisorStore(reopenedGuidance, new Set());
    assert.equal(supervisors.scopeCompatible, false);
    const workflows = new WorkflowStateStore(supervisors);
    assert.equal(reopenedGuidance.db.prepare("SELECT value FROM meta WHERE key='supervisor_scope_version'").get()?.value, "future");
    assert.equal(supervisors.binding(fixture.owner.projectId, fixture.owner.mainThreadId)?.threadId, fixture.owner.supervisorThreadId);
    assert.equal(workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, created.revision);
    assert.deepEqual(workflows.apply(fixture.owner, input), {status: "owner_mismatch", operationId: input.operationId});
    assert.equal(workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, created.revision);
    assert.equal(Number(reopenedGuidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_state").get()?.n), 1);
    assert.equal(Number(reopenedGuidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_operations").get()?.n), 1,
      "the unsupported scope prevented reserving an operation ID");
  } finally {
    guidance?.close();
    await rm(fixture.directory, {recursive: true, force: true});
  }
});

test("controller-owned transaction methods compose and roll back with the caller", async () => {
  const fixture = await makeFixture();
  try {
    const created = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-transaction", "Create a draft."));
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const input = addStep(created.workflowId, created.revision, "transactional-apply");
    assert.throws(() => fixture.supervisors.store.transaction(() => {
      assert.equal(fixture.workflows.applyInTransaction(fixture.owner, input).status, "applied");
      throw new Error("rollback workflow update");
    }), /rollback workflow update/u);
    assert.equal(fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, 1);
    const committed = fixture.supervisors.store.transaction(() => fixture.workflows.applyInTransaction(fixture.owner, input));
    assert.equal(committed.status, "applied", "the rolled-back operation ID remains available for retry");
    assert.equal(fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, 2);
  } finally {await closeFixture(fixture);}
});

test("workflow state and operation receipts survive a database reopen", async () => {
  const fixture = await makeFixture();
  const create = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-persist", "Persist a draft."));
  assert.equal(create.status, "created");
  if (create.status !== "created") {
    await closeFixture(fixture);
    return;
  }
  const applied = fixture.workflows.apply(fixture.owner, addStep(create.workflowId, create.revision, "persisted-edit"), 500);
  assert.equal(applied.status, "applied");
  fixture.guidance.close();
  try {
    const guidance = new GuidanceStore(fixture.directory);
    const supervisors = new ProjectSupervisorStore(guidance, new Set());
    const workflows = new WorkflowStateStore(supervisors);
    try {
      const reopened = workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId);
      assert.equal(reopened?.revision, 2);
      assert.equal(reopened?.steps[0]?.name, "Inspect the export path");
      assert.deepEqual(workflows.apply(fixture.owner, addStep(create.workflowId, create.revision, "persisted-edit"), 900), applied);
    } finally {guidance.close();}
  } finally {await rm(fixture.directory, {recursive: true, force: true});}
});
