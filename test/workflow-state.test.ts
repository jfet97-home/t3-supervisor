import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import {fingerprint, GuidanceStore} from "../src/guidance-store.js";
import {defaultSupervisorModel, ProjectSupervisorStore} from "../src/project-supervisor-store.js";
import {proposalContextFromDefinitions, validateWorkflowApplyAgainstPinnedContext, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {acceptedWorkflowPlansForBinding, WorkflowStateStore} from "../src/workflow-state-store.js";
import {workflowMutationLimits} from "../src/workflow-state-contract.js";
import type {WorkflowAgreementImport, WorkflowApplyInput, WorkflowOwner, WorkflowStatePlan, WorkflowStateSourceBinding} from "../src/workflow-state-contract.js";
import type {ProjectDefinitionSnapshot} from "../src/project-definitions-contract.js";
import type {WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo} from "../src/project-supervisor-contract.js";

type Fixture = {
  directory: string;
  guidance: GuidanceStore;
  supervisors: ProjectSupervisorStore;
  workflows: WorkflowStateStore;
  owner: WorkflowOwner;
  definitions: ProjectDefinitionSnapshot;
  context: ReturnType<typeof proposalContextFromDefinitions>;
  proposal: WorkflowProposalInfo;
};
const contributorThreadId = "00000000-0000-4000-8000-000000000001";
const taskSourceHash = fingerprint("Prepare the export workflow.");

const definitionSnapshot = (required: ProjectDefinitionSnapshot["config"]["required"] = [{workflow: "release"}]): ProjectDefinitionSnapshot => ({
  projectId: "project-a",
  threadId: "main-a",
  workspaceRoot: "/workspace/project-a",
  globalOnly: false,
  globalRevision: null,
  revision: "definition-revision-a",
  editingAvailable: true,
  status: "ready",
  steps: [
    {id: "prepare", name: "Prepare", description: "Prepare the release inputs.", origin: "project", path: "steps/prepare.md", sourceId: "project:step:prepare"},
    {id: "verify", name: "Verify", description: "Run the release checks.", origin: "project", path: "steps/verify.md", sourceId: "project:step:verify"},
    {id: "publish", name: "Publish", description: "Publish the release artifact.", origin: "project", path: "steps/publish.md", sourceId: "project:step:publish"},
  ],
  workflows: [{id: "release", name: "Release", description: "Prepare and publish a release.", fixed: true,
    sequence: [{step: "prepare"}, {parallel: [{step: "verify"}, {step: "verify"}]}, {step: "publish"}],
    origin: "project", path: "workflows/release.yaml", sourceId: "project:workflow:release"}],
  config: {required, default_workflow: "release"},
  projectConfig: {required, default_workflow: "release"},
  complete: true,
  sources: [],
  issues: [],
});

const localPlanInput = (ids: readonly string[]): WorkflowPlanGroupInfo => ({kind: "sequence", templatePath: null, nodes: ids.map(id => ({
  kind: "step",
  nodeId: randomUUID(),
  definitionId: null,
  localId: id,
  templatePath: null,
  name: `Local ${id}`,
  description: `Complete local task ${id}.`,
  source: null,
  resolution: "resolved",
  reason: `This task adds ${id}.`,
  status: "planned",
  contributorThreadIds: [],
}))});

const makeProposal = (definitions: ProjectDefinitionSnapshot, context: NonNullable<Fixture["context"]>, plan: unknown,
  assessments: readonly {kind: "step" | "workflow"; id: string; applies: boolean | "unknown"; reason: string}[]): WorkflowProposalInfo => {
  const canonical = validateWorkflowPlan({requirements: assessments, plan}, context);
  assert.ok(canonical);
  return Object.assign({
    status: "proposed",
    message: "A source-bound draft plan.",
    workspaceRoot: definitions.workspaceRoot,
    revision: definitions.revision,
    globalRevision: definitions.globalRevision ?? null,
  }, canonical) as WorkflowProposalInfo;
};

const proposalPlan = (includeRelease: boolean): unknown => includeRelease ? {kind: "sequence", templatePath: null, nodes: [
  {kind: "workflow", definitionId: "release", reason: "Use the release template."},
]} : localPlanInput(["local-a", "local-b"]);

const makeFixture = async (required: ProjectDefinitionSnapshot["config"]["required"] = [{workflow: "release"}], includeRelease = true): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-state-test-"));
  const guidance = new GuidanceStore(directory);
  const supervisors = new ProjectSupervisorStore(guidance, new Set());
  const projectId = "project-a";
  const mainThreadId = "main-a";
  guidance.db.prepare("INSERT INTO meta VALUES(?,?)").run(`supervisor_control:${JSON.stringify(projectId)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const reserved = supervisors.reserve(projectId, mainThreadId, "Main conversation", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  supervisors.setBinding(binding);
  const definitions = definitionSnapshot(required);
  const context = proposalContextFromDefinitions(definitions);
  const assessments = required.map(reference => ({kind: "workflow" as const, id: "workflow" in reference ? reference.workflow : reference.step,
    applies: true as const, reason: "This configured definition applies to the task."}));
  const proposal = makeProposal(definitions, context, proposalPlan(includeRelease), assessments);
  return {directory, guidance, supervisors, workflows: new WorkflowStateStore(supervisors),
    owner: {projectId, mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation}, definitions, context, proposal};
};

const closeFixture = async (fixture: Fixture) => {
  fixture.guidance.close();
  await rm(fixture.directory, {recursive: true, force: true});
};

test("file references survive agreement import, apply, restart and defensive state copies", async () => {
  const fixture = await makeFixture();
  try {
    fixture.definitions = {...fixture.definitions,
      steps: fixture.definitions.steps.map(step => ({...step, references: [`docs/${step.id}.md`]})),
      workflows: fixture.definitions.workflows.map(workflow => ({...workflow, references: ["docs/release.md"]}))};
    fixture.context = proposalContextFromDefinitions(fixture.definitions);
    fixture.proposal = makeProposal(fixture.definitions, fixture.context!, proposalPlan(true), [
      {kind: "workflow", id: "release", applies: true, reason: "Required for this task."},
    ]);
    const imported = fixture.guidance.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, acceptedAgreement(fixture.proposal), 100));
    assert.equal(imported.status, "applied");
    const original = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const wrapper = original.plan!.nodes[0];
    assert(wrapper?.kind === "workflow");
    assert.deepEqual(wrapper.references, ["docs/release.md"]);
    (wrapper.references as string[]).push("not-in-the-store.md");
    const current = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const fresh = current.plan!.nodes[0];
    assert(fresh?.kind === "workflow");
    assert.deepEqual(fresh.references, ["docs/release.md"]);
    const support = localPlanInput(["support"]).nodes[0]!;
    assert(support.kind === "step");
    support.references = ["src/support.ts"];
    const plan = {...current.plan!, nodes: [...current.plan!.nodes, support]};
    const result = fixture.workflows.apply(fixture.owner, applyInput(fixture, current, plan, "references-support"), validationFor(fixture));
    assert.equal(result.status, "applied");
    fixture.guidance.close();
    fixture.guidance = new GuidanceStore(fixture.directory);
    fixture.supervisors = new ProjectSupervisorStore(fixture.guidance, new Set());
    fixture.workflows = new WorkflowStateStore(fixture.supervisors);
    const restored = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    assert.deepEqual(restored.plan, plan);
  } finally {await closeFixture(fixture);}
});

const sourceBinding = (proposal: WorkflowProposalInfo, taskId = "task-a", proposalId = "proposal-a"): WorkflowStateSourceBinding => ({
  workspaceRoot: proposal.workspaceRoot!,
  revision: proposal.revision,
  globalRevision: proposal.globalRevision,
  definitionsStatus: proposal.definitionsStatus,
  definitionsComplete: proposal.definitionsComplete,
  requirementsKnown: proposal.requirementsKnown,
  taskId,
  proposalId,
  sourceHash: taskSourceHash,
});

const acceptedAgreement = (proposal: WorkflowProposalInfo): WorkflowAgreementImport => ({
  taskId: "task-a",
  sourceThreadId: "main-a",
  sourceRunId: "run-a",
  sourceMessageId: "message-a",
  sourceHash: taskSourceHash,
  objective: "Prepare the export workflow.",
  agreement: {
    status: "agreed",
    message: "The complete workflow was echoed by the operative assistant.",
    proposalId: "proposal-a",
    agreedAt: 123,
    supervisorMessageId: "supervisor-message-a",
    agentMessageId: "agent-message-a",
    workflow: proposal,
  },
});

const validationFor = (fixture: Fixture, originalProposal = fixture.proposal) => ({
  pinnedContext: fixture.context!,
  originalProposal,
  expectedTaskId: "task-a",
  expectedProposalId: "proposal-a",
    expectedSourceHash: taskSourceHash,
  acceptedTaskAgreement: null,
  acceptedTaskAgreementSourceHash: null,
});

const applyInput = (fixture: Fixture, document: NonNullable<ReturnType<WorkflowStateStore["get"]>>, plan: WorkflowStatePlan,
  operationId: string, options: {requirements?: WorkflowProposalInfo["requirements"]; issues?: WorkflowProposalInfo["issues"]; evidence?: WorkflowApplyInput["evidence"]; note?: string} = {}): WorkflowApplyInput => ({
  operationId,
  workflowId: document.workflowId,
  expectedRevision: document.revision,
  status: document.status,
  objective: document.objective,
  sourceBinding: sourceBinding(fixture.proposal),
  requirements: [...(options.requirements ?? fixture.proposal.requirements)],
  issues: [...(options.issues ?? fixture.proposal.issues)],
  plan,
  note: options.note ?? "The nested plan was reviewed and updated.",
  ...(options.evidence !== undefined ? {evidence: options.evidence} : {}),
});

const planEntities = (plan: WorkflowStatePlan): Exclude<WorkflowPlanNodeInfo, WorkflowPlanGroupInfo>[] => {
  const result: Exclude<WorkflowPlanNodeInfo, WorkflowPlanGroupInfo>[] = [];
  const walk = (group: WorkflowPlanGroupInfo | null): void => {
    if (!group) return;
    for (const node of group.nodes) {
      if (node.kind === "sequence" || node.kind === "parallel") walk(node);
      else if (node.kind === "step" || node.kind === "workflow") {
        result.push(node);
        if (node.kind === "workflow") walk(node.plan);
      }
    }
  };
  walk(plan);
  return result;
};

const reverseObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).reverse().map(key => [key, reverseObjectKeys(record[key])]));
};

test("nested agreement imports preserve reusable occurrence IDs and exact history", async () => {
  const fixture = await makeFixture();
  try {
    const source = acceptedAgreement(fixture.proposal);
    const imported = fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, source, 100));
    assert.equal(imported.status, "applied");
    if (imported.status !== "applied") return;
    const first = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    assert.equal(first.formatVersion, 2);
    assert.equal(first.revision, 1);
    assert.equal(first.currentAgreementKey, first.acceptedAgreements[0]?.key);
    assert.deepEqual(first.plan, source.agreement.workflow.plan);
    assert.deepEqual(first.acceptedAgreements[0]?.plan, source.agreement.workflow.plan);
    assert.deepEqual(first.acceptedAgreements[0]?.agreement, source.agreement);
    const verifyOccurrences = planEntities(first.plan).filter(node => node.kind === "step" && node.definitionId === "verify");
    assert.equal(verifyOccurrences.length, 2);
    assert.notEqual(verifyOccurrences[0]?.nodeId, verifyOccurrences[1]?.nodeId,
      "reusing one step definition in separate branches creates separate occurrence identities");
    assert.deepEqual(fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(
      fixture.owner, source, 200)), imported, "an exact import replay does not regenerate occurrence IDs");

    const extra = localPlanInput(["extra"]).nodes[0]!;
    const editedPlan: WorkflowPlanGroupInfo = {...first.plan!, nodes: [...first.plan!.nodes, extra]};
    const editedInput = applyInput(fixture, first, editedPlan, "append-local");
    const direct = validateWorkflowApplyAgainstPinnedContext({plan: editedInput.plan, requirements: editedInput.requirements,
      issues: editedInput.issues, sourceBinding: editedInput.sourceBinding!}, fixture.context!, fixture.proposal, "task-a", "proposal-a",
    taskSourceHash, {targetThreadId: "main-a", mainThreadId: "main-a"}, acceptedWorkflowPlansForBinding(first, sourceBinding(fixture.proposal)), first.plan);
    assert.ok(direct, JSON.stringify({proposalIssues: fixture.proposal.issues, requirementStates: fixture.proposal.requirements.map(item => item.state)}));
    const edited = fixture.workflows.apply(fixture.owner, editedInput, validationFor(fixture), 300);
    assert.equal(edited.status, "applied", JSON.stringify(edited));
    const afterEdit = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    assert.equal(afterEdit.currentAgreementKey, null);
    assert.deepEqual(afterEdit.acceptedAgreements[0]?.agreement, source.agreement);
    assert.deepEqual(fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, source, 400)), imported);
    assert.equal(fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, 2,
      "historical acceptance replay leaves the edited plan untouched");
  } finally {await closeFixture(fixture);}
});

test("nested moves and insertions preserve occurrence status and contributor identity with CAS receipts", async () => {
  const fixture = await makeFixture([], false);
  try {
    const source = acceptedAgreement(fixture.proposal);
    const created = fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, source, 100));
    assert.equal(created.status, "applied");
    if (created.status !== "applied") return;
    const initial = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const original = initial.plan!.nodes.filter((node): node is Exclude<WorkflowPlanNodeInfo, WorkflowPlanGroupInfo> => node.kind === "step");
    const [firstStep, secondStep] = original;
    assert.ok(firstStep && secondStep);
    const moved = {...initial.plan!, nodes: [
      {...secondStep, status: "planned" as const},
      {...firstStep, status: "underway" as const, contributorThreadIds: [contributorThreadId]},
    ]};
    const statusEvidence = [{kind: "status_changed" as const, targetNodeId: firstStep.nodeId,
      note: "The first occurrence started after its inputs were ready.", sourceThreadId: "child-a", sourceItemId: "turn-item-child-command"}];
    const input = applyInput(fixture, initial, moved, "move-and-start", {requirements: [], issues: [], evidence: statusEvidence});
    const applied = fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 200);
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    if (applied.status !== "applied") return;
    const updated = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const retainedFirst = updated.plan!.nodes[1];
    assert.equal(retainedFirst?.kind, "step");
    if (retainedFirst?.kind !== "step") return;
    assert.equal(retainedFirst.nodeId, firstStep.nodeId);
    assert.equal(retainedFirst.status, "underway");
    assert.deepEqual(retainedFirst.contributorThreadIds, [contributorThreadId]);
    assert.ok(updated.evidence.some(item => item.kind === "status_changed" && item.targetNodeId === firstStep.nodeId &&
      item.statusFrom === "planned" && item.statusTo === "underway" && item.sourceThreadId === "child-a" &&
      item.sourceItemId === "turn-item-child-command"));
    assert.deepEqual(fixture.workflows.apply(reverseObjectKeys(fixture.owner) as WorkflowOwner,
      reverseObjectKeys(input) as WorkflowApplyInput, validationFor(fixture), 900), applied,
    "object-key order does not change operation replay");

    const repeated = fixture.workflows.apply(fixture.owner, input, undefined, 901);
    assert.deepEqual(repeated, applied, "an exact durable receipt replays even when a fresh definition pin is unavailable");
    const reused = fixture.workflows.apply(fixture.owner, {...input, note: "A different request reused this operation ID."}, validationFor(fixture), 902);
    assert.equal(reused.status, "conflict");
    if (reused.status === "conflict") assert.equal(reused.reason, "operation_id_reused");
    const stale = fixture.workflows.apply(fixture.owner, {...input, operationId: "stale-write", expectedRevision: initial.revision}, validationFor(fixture), 903);
    assert.equal(stale.status, "conflict");
    if (stale.status === "conflict") assert.equal(stale.reason, "revision");

    const current = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const newStep = {kind: "step" as const, definitionId: null, localId: "third", templatePath: null, name: "Local third",
      description: "Complete local task third.", source: null, resolution: "resolved" as const,
      reason: "This task adds third.", status: "planned" as const, contributorThreadIds: []};
    const inserted: WorkflowPlanGroupInfo = {...current.plan!, nodes: [newStep as unknown as WorkflowPlanNodeInfo, ...current.plan!.nodes]};
    const insertedInput = applyInput(fixture, current, inserted, "insert-third", {requirements: [], issues: []});
    assert.equal(fixture.workflows.apply(fixture.owner, insertedInput, validationFor(fixture), 1_000).status, "applied");
    const afterInsert = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const assignedNewStep = planEntities(afterInsert.plan).find(node => node.kind === "step" && node.localId === "third");
    assert.ok(assignedNewStep?.nodeId, "the trusted validator assigns a stable ID to a proven new node");
    const preserved = planEntities(afterInsert.plan).find(node => node.nodeId === firstStep.nodeId);
    assert.equal(preserved?.status, "underway");
    assert.deepEqual(preserved?.contributorThreadIds, [contributorThreadId]);

    const omittedExistingId = {...afterInsert.plan!, nodes: afterInsert.plan!.nodes.map(node =>
      node.kind === "step" && node.localId === "local-b" ? {...node, nodeId: undefined} : node)} as unknown as WorkflowPlanGroupInfo;
    const identityLoss = fixture.workflows.apply(fixture.owner, applyInput(fixture, afterInsert, omittedExistingId, "omit-existing-id", {requirements: [], issues: []}),
      validationFor(fixture), 1_050);
    assert.equal(identityLoss.status, "invalid", "an omitted ID cannot silently turn an existing occurrence into a new node");
    const withoutNew = {...afterInsert.plan!, nodes: afterInsert.plan!.nodes.filter(node => !("nodeId" in node) || node.nodeId !== assignedNewStep?.nodeId)};
    const removeInput = applyInput(fixture, afterInsert, withoutNew, "remove-third", {requirements: [], issues: [], note: "The temporary local occurrence was removed after its work was folded into the parent."});
    assert.equal(fixture.workflows.apply(fixture.owner, removeInput, validationFor(fixture), 1_100).status, "applied");
    const removed = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!.evidence.find(item => item.kind === "node_removed" && item.targetNodeId === assignedNewStep?.nodeId);
    assert.equal(removed?.note, removeInput.note, "removal history keeps the explicit note");
  } finally {await closeFixture(fixture);}
});

test("a child can work a subset of main requirements without weakening its own fixed commitments", async () => {
  const fixture = await makeFixture([], false);
  try {
    const mainAgreement = acceptedAgreement(fixture.proposal);
    assert.equal(fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, mainAgreement, 100)).status, "applied");
    const linked = fixture.supervisors.store.transaction(() => fixture.workflows.linkChildInTransaction(fixture.owner,
      {operationId: "link-child", lineage: {threadId: "child-a", parentThreadId: "main-a", relationshipToParent: "subagent"}, note: "The controller verified this native descendant."}));
    assert.equal(linked.status, "created");
    const child = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a")!;
    const localChildPlan = localPlanInput(["child-local"]);
    const childInput = applyInput(fixture, child, localChildPlan, "child-local-plan", {requirements: [], issues: []});
    assert.equal(fixture.workflows.apply(fixture.owner, childInput, validationFor(fixture), 200).status, "applied",
      "a child plan need not copy the main task's required workflow");
    const fixedProposal = makeProposal(fixture.definitions, fixture.context!, proposalPlan(true), []);
    const currentChild = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a")!;
    const fixedChild: WorkflowPlanGroupInfo = {...currentChild.plan!, nodes: [...currentChild.plan!.nodes, ...fixedProposal.plan!.nodes]};
    const addFixedInput = applyInput(fixture, currentChild, fixedChild, "child-add-fixed", {requirements: [], issues: []});
    assert.equal(fixture.workflows.apply(fixture.owner, addFixedInput, validationFor(fixture), 300).status, "applied");
    const childWithFixed = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a")!;
    const omitFixedInput = applyInput(fixture, childWithFixed, localChildPlan, "child-remove-fixed", {requirements: [], issues: []});
    const removal = fixture.workflows.apply(fixture.owner, omitFixedInput, validationFor(fixture), 400);
    assert.equal(removal.status, "invalid", "a child cannot later remove a fixed workflow it committed to");
    assert.equal(fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a")?.revision, childWithFixed.revision);
  } finally {await closeFixture(fixture);}
});

test("a fixed workflow added after the original proposal remains pinned in main state", async () => {
  const fixture = await makeFixture([], false);
  try {
    const source = acceptedAgreement(fixture.proposal);
    assert.equal(fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, source, 100)).status, "applied");
    const current = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const fixedProposal = makeProposal(fixture.definitions, fixture.context!, proposalPlan(true), []);
    const withFixed: WorkflowPlanGroupInfo = {...current.plan!, nodes: [...current.plan!.nodes, ...fixedProposal.plan!.nodes]};
    const add = applyInput(fixture, current, withFixed, "main-add-fixed", {requirements: [], issues: []});
    assert.equal(fixture.workflows.apply(fixture.owner, add, validationFor(fixture), 200).status, "applied");
    const pinned = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const remove = applyInput(fixture, pinned, current.plan, "main-remove-fixed", {requirements: [], issues: []});
    const rejected = fixture.workflows.apply(fixture.owner, remove, validationFor(fixture), 300);
    assert.equal(rejected.status, "invalid", "mutable current state is canonicalized against pinned definitions before preserving fixed nodes");
    assert.equal(fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, pinned.revision);
  } finally {await closeFixture(fixture);}
});

test("workflow needs-attention lookup is scoped, bounded, and reports incomplete scans", async () => {
  const fixture = await makeFixture();
  try {
    const main = fixture.supervisors.store.transaction(() => fixture.workflows.ensureMainInTransaction(
      fixture.owner, "attention-scan-main", "Create the main workflow.", 100));
    assert.equal(main.status, "created");
    const child = fixture.supervisors.store.transaction(() => fixture.workflows.linkChildInTransaction(fixture.owner, {
      operationId: "attention-scan-child",
      lineage: {threadId: "child-a", parentThreadId: fixture.owner.mainThreadId, relationshipToParent: "subagent"},
      note: "Create a child workflow.",
    }, 101));
    assert.equal(child.status, "created");
    assert.equal(fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a")?.status, "planned");

    const mainDocument = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const rootStep = localPlanInput(["main-step"]).nodes[0];
    const attentionCandidate = localPlanInput(["attention-step"]).nodes[0];
    if (rootStep?.kind !== "step" || attentionCandidate?.kind !== "step") throw new Error("expected_local_step");
    const attentionStep = {...attentionCandidate, status: "needs_attention" as const};
    const nestedPlan: WorkflowPlanGroupInfo = {kind: "sequence", templatePath: null, nodes: [{kind: "parallel", templatePath: null,
      nodes: [rootStep, attentionStep]}]};
    const rootStatusEvidence = {
      id: randomUUID(), operationId: "attention-scan-status", kind: "status_changed" as const, recordedAt: 102,
      actorSupervisorThreadId: fixture.owner.supervisorThreadId, targetNodeId: null, targetNodeName: null,
      statusFrom: "planned" as const, statusTo: "underway" as const, sourceThreadId: null,
      sourceRunId: null, sourceMessageId: null, agreementKey: null, note: "A current issue needs attention.",
    };
    const nodeStatusEvidence = {...rootStatusEvidence, id: randomUUID(), targetNodeId: attentionStep.nodeId,
      targetNodeName: attentionStep.name, statusFrom: "planned" as const, statusTo: "needs_attention" as const};
    const needsAttentionDocument = {...mainDocument, status: "underway" as const, plan: nestedPlan,
      evidence: [...mainDocument.evidence, rootStatusEvidence, nodeStatusEvidence], updatedAt: 102};
    fixture.guidance.db.prepare("UPDATE supervisor_workflow_state SET document=?,updated_at=? WHERE workflow_id=?")
      .run(JSON.stringify(needsAttentionDocument), 102, mainDocument.workflowId);

    assert.deepEqual(fixture.workflows.hasNeedsAttention(fixture.owner.projectId, fixture.owner.mainThreadId,
      [fixture.owner.mainThreadId, "child-a"], 2), {status: "complete", needsAttention: true, inspected: 2});
    assert.deepEqual(fixture.workflows.hasNeedsAttention(fixture.owner.projectId, fixture.owner.mainThreadId,
      [fixture.owner.mainThreadId, "child-a"], 1), {status: "incomplete", needsAttention: false, inspected: 1, reason: "limit_exceeded"});
    assert.equal(fixture.workflows.hasNeedsAttention(fixture.owner.projectId, fixture.owner.mainThreadId,
      [fixture.owner.mainThreadId, fixture.owner.mainThreadId], 2).status, "incomplete");
  } finally {await closeFixture(fixture);}
});

test("agreement size bounds reject without creating a row or reserving a receipt", async () => {
  const fixture = await makeFixture();
  try {
    const source = acceptedAgreement(fixture.proposal);
    const oversized = {...source, agreement: {...source.agreement, message: "é".repeat(Math.ceil(workflowMutationLimits.maxDocumentBytes / 2))}};
    const rejected = fixture.supervisors.store.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, oversized, 150));
    assert.equal(rejected.status, "invalid");
    if (rejected.status === "invalid") assert.equal(rejected.reason, "document_capacity");
    assert.equal(fixture.workflows.getState(fixture.owner.projectId, fixture.owner.mainThreadId).status, "not_found");
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_state").get()?.n), 0);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_operations").get()?.n), 0);
  } finally {await closeFixture(fixture);}
});

test("unversioned flat documents and receipts are reported incompatible and retained raw", async () => {
  const fixture = await makeFixture();
  try {
    const workflowId = "legacy-workflow";
    const raw = JSON.stringify({workflowId, projectId: fixture.owner.projectId, mainThreadId: fixture.owner.mainThreadId, threadId: fixture.owner.mainThreadId,
      parentWorkflowId: null, parentThreadId: null, revision: 7, status: "planned", objective: "A retired flat plan.", rules: [],
      steps: [{id: "old-step", blockId: null, name: "Old format", reason: "Preserve as raw data.", status: "planned", contributorThreadIds: []}],
      currentAgreementKey: null, acceptedAgreements: [], evidence: [], createdAt: 10, updatedAt: 11});
    fixture.guidance.db.prepare("INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(workflowId, fixture.owner.projectId, fixture.owner.mainThreadId, fixture.owner.mainThreadId, null, null, 7, raw, 10, 11);
    const request = {kind: "ensure-main", owner: fixture.owner, note: "Start a draft."};
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value === null || typeof value !== "object") return value;
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
    };
    const oldResult = JSON.stringify({status: "created", operationId: "legacy-replay", workflowId, revision: 7, stateHash: "legacy-hash"});
    fixture.guidance.db.prepare("INSERT INTO supervisor_workflow_operations(project_id,main_thread_id,actor_thread_id,binding_generation,operation_namespace,operation_id,request_hash,result,workflow_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(fixture.owner.projectId, fixture.owner.mainThreadId, fixture.owner.supervisorThreadId, fixture.owner.bindingGeneration, "edit", "legacy-replay",
        fingerprint(canonical(request)), oldResult, workflowId, 12);

    assert.deepEqual(fixture.workflows.getState(fixture.owner.projectId, fixture.owner.mainThreadId),
      {status: "incompatible", workflowId, formatVersion: null});
    const lookup = fixture.supervisors.store.transaction(() => fixture.workflows.getByIdForOwnerInTransaction(fixture.owner, workflowId));
    assert.deepEqual(lookup, {status: "incompatible", workflowId, formatVersion: null});
    assert.deepEqual(fixture.workflows.listResult(fixture.owner.projectId, fixture.owner.mainThreadId), {documents: [], incompatible: [{workflowId, formatVersion: null}]});
    assert.deepEqual(fixture.workflows.ensureMainInTransaction(fixture.owner, "ensure-existing-legacy", "Do not reinterpret this row."),
      {status: "incompatible", workflowId, formatVersion: null, operationId: "ensure-existing-legacy"});
    assert.equal(fixture.workflows.ensureMainInTransaction(fixture.owner, "legacy-replay", "Start a draft.").status, "incompatible",
      "an old receipt is never replayed as a v2 successful write");
    const applyLegacy: WorkflowApplyInput = {operationId: "apply-legacy", workflowId, expectedRevision: 7, status: "planned",
      objective: "A retired flat plan.", sourceBinding: sourceBinding(fixture.proposal), requirements: [...fixture.proposal.requirements],
      issues: [...fixture.proposal.issues], plan: fixture.proposal.plan, note: "Do not reinterpret or overwrite the old row."};
    assert.deepEqual(fixture.workflows.apply(fixture.owner, applyLegacy, validationFor(fixture)),
      {status: "incompatible", workflowId, formatVersion: null, operationId: "apply-legacy"});
    assert.equal(fixture.guidance.db.prepare("SELECT document FROM supervisor_workflow_state WHERE workflow_id=?").get(workflowId)?.document, raw);
    assert.equal(fixture.guidance.db.prepare("SELECT result FROM supervisor_workflow_operations WHERE operation_id=?").get("legacy-replay")?.result, oldResult);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_state").get()?.n), 1);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_operations").get()?.n), 1);
  } finally {await closeFixture(fixture);}
});

test("missing pinned context and incompatible supervisor scope fail closed without reserving operations", async () => {
  const fixture = await makeFixture();
  let guidance: GuidanceStore | null = fixture.guidance;
  try {
    const source = acceptedAgreement(fixture.proposal);
    const created = guidance!.transaction(() => fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, source, 100));
    assert.equal(created.status, "applied");
    if (created.status !== "applied") return;
    const current = fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)!;
    const input = applyInput(fixture, current, current.plan, "missing-pin");
    assert.deepEqual(fixture.workflows.apply(fixture.owner, input, undefined), {
      status: "invalid", operationId: input.operationId, reason: "pinned_definition_context_required",
    });
    assert.equal(Number(guidance!.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_operations").get()?.n), 1);

    guidance!.db.prepare("UPDATE meta SET value='future' WHERE key='supervisor_scope_version'").run();
    guidance!.close();
    guidance = null;
    const reopened = new GuidanceStore(fixture.directory);
    guidance = reopened;
    const supervisors = new ProjectSupervisorStore(reopened, new Set());
    const workflows = new WorkflowStateStore(supervisors);
    assert.equal(supervisors.scopeCompatible, false);
    assert.equal(workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, current.revision);
    assert.deepEqual(workflows.apply(fixture.owner, {...input, operationId: "scope-retry"}, validationFor(fixture)),
      {status: "owner_mismatch", operationId: "scope-retry"});
    assert.equal(workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId)?.revision, current.revision);
    assert.equal(Number(reopened.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_operations").get()?.n), 1);
  } finally {
    guidance?.close();
    await rm(fixture.directory, {recursive: true, force: true});
  }
});
