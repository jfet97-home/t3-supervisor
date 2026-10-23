import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import {guidanceTransaction} from "../src/guidance-sql.js";
import {fingerprint} from "../src/guidance-store.js";
import {defaultSupervisorModel, type ProjectSupervisorStore} from "../src/project-supervisor-store.js";
import {proposalContextFromDefinitions, validateWorkflowApplyAgainstPinnedContext, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {acceptedWorkflowPlansForBinding, parseExternalContributionRecord, type WorkflowStateStore} from "../src/workflow-state-store.js";
import {externalContributionLimits, workflowMutationLimits} from "../src/workflow-state-contract.js";
import type {ExternalContributionImport, WorkflowAgreementImport, WorkflowApplyInput, WorkflowOwner, WorkflowStateDocument, WorkflowStatePlan, WorkflowStateSourceBinding} from "../src/workflow-state-contract.js";
import type {DefinitionReference, ProjectDefinitionSnapshot} from "../src/project-definitions-contract.js";
import type {WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo} from "../src/project-supervisor-contract.js";
import type {GuidanceDb} from "../src/db.js";
import {effectiveIndex, projectIndex, testSummary} from "./project-definitions-fixture.js";
import {execute, openWorkflowStores, query, temporaryDirectory} from "./support/g12-stores.js";

// live Effect tests on the workflow state store service over the production layers: each fixture writes a real guidance.sqlite3
// in a temporary directory, closed and removed with the test scope; a reopen closes the client and opens the file again. a
// `*InTransaction` call inside the caller's transaction is the plain method inside a guidance transaction

type Fixture = {
  directory: string;
  sql: GuidanceDb["Service"];
  supervisors: ProjectSupervisorStore["Service"];
  workflows: WorkflowStateStore["Service"];
  close: Effect.Effect<void>;
  owner: WorkflowOwner;
  definitions: ProjectDefinitionSnapshot;
  context: ReturnType<typeof proposalContextFromDefinitions>;
  proposal: WorkflowProposalInfo;
};
const contributorThreadId = "00000000-0000-4000-8000-000000000001";
const taskSourceHash = fingerprint("Prepare the export workflow.");

const definitionIds = {steps: ["prepare", "verify", "publish"], workflows: ["release"]};
const definitionSnapshot = (required: readonly DefinitionReference[] = [{workflow: "release"}]): ProjectDefinitionSnapshot => ({
  projectId: "project-a",
  threadId: "main-a",
  workspaceRoot: "/workspace/project-a",
  globalOnly: false,
  globalRevision: null,
  revision: "definition-revision-a",
  editingAvailable: true,
  status: "ready",
  steps: [
    {id: "prepare", name: "Prepare", description: "Prepare the release inputs.", summary: testSummary("prepare"), origin: "project", path: "steps/prepare.md", sourceId: "project:step:prepare"},
    {id: "verify", name: "Verify", description: "Run the release checks.", summary: testSummary("verify"), origin: "project", path: "steps/verify.md", sourceId: "project:step:verify"},
    {id: "publish", name: "Publish", description: "Publish the release artifact.", summary: testSummary("publish"), origin: "project", path: "steps/publish.md", sourceId: "project:step:publish"},
  ],
  workflows: [{id: "release", name: "Release", description: "Prepare and publish a release.", summary: testSummary("release"), fixed: true,
    sequence: [{step: "prepare"}, {parallel: [{step: "verify"}, {step: "verify"}]}, {step: "publish"}],
    origin: "project", path: "workflows/release.yaml", sourceId: "project:workflow:release"}],
  config: effectiveIndex({steps: definitionIds.steps.map(id => ({id})), workflows: definitionIds.workflows.map(id => ({id}))}, required, "release"),
  projectConfig: projectIndex({...definitionIds, required, default_workflow: "release"}),
  definitionFiles: [],
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

const makeFixture = (required: readonly DefinitionReference[] = [{workflow: "release"}], includeRelease = true) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("workflow-state-test-");
  const stores = yield* openWorkflowStores(directory);
  const projectId = "project-a";
  const mainThreadId = "main-a";
  yield* execute(stores.sql, "INSERT INTO meta VALUES(?,?)", `supervisor_control:${JSON.stringify(projectId)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const reserved = yield* stores.supervisors.reserve(projectId, mainThreadId, "Main conversation", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  yield* stores.supervisors.setBinding(binding);
  const definitions = definitionSnapshot(required);
  const context = proposalContextFromDefinitions(definitions);
  const assessments = required.map(reference => ({kind: "workflow" as const, id: "workflow" in reference ? reference.workflow : reference.step,
    applies: true as const, reason: "This configured definition applies to the task."}));
  const proposal = makeProposal(definitions, context, proposalPlan(includeRelease), assessments);
  const fixture: Fixture = {directory, sql: stores.sql, supervisors: stores.supervisors, workflows: stores.workflows, close: stores.close,
    owner: {projectId, mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation}, definitions, context, proposal};
  return fixture;
});

// the fixture's client closed and the file opened again with fresh services, as a restart does
const reopen = (fixture: Fixture) => Effect.gen(function* () {
  yield* fixture.close;
  const stores = yield* openWorkflowStores(fixture.directory);
  Object.assign(fixture, {sql: stores.sql, supervisors: stores.supervisors, workflows: stores.workflows, close: stores.close});
});

// one guidance transaction on the fixture's current client, as the baseline store transaction
const transaction = <A, E>(fixture: Fixture, body: Effect.Effect<A, E>) => guidanceTransaction(fixture.sql)(body);
const count = (fixture: Fixture, table: string) => Effect.map(query(fixture.sql, `SELECT count(*) AS n FROM ${table}`), ([row]) => Number(row?.n));

it.live("file references survive agreement import, apply, restart and defensive state copies", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  fixture.definitions = {...fixture.definitions,
    steps: fixture.definitions.steps.map(step => ({...step, references: [`docs/${step.id}.md`]})),
    workflows: fixture.definitions.workflows.map(workflow => ({...workflow, references: ["docs/release.md"]}))};
  fixture.context = proposalContextFromDefinitions(fixture.definitions);
  fixture.proposal = makeProposal(fixture.definitions, fixture.context!, proposalPlan(true), [
    {kind: "workflow", id: "release", applies: true, reason: "Required for this task."},
  ]);
  const imported = yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(fixture.owner, acceptedAgreement(fixture.proposal), 100));
  assert.equal(imported.status, "applied");
  const original = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const wrapper = original.plan!.nodes[0];
  assert(wrapper?.kind === "workflow");
  assert.deepEqual(wrapper.references, ["docs/release.md"]);
  (wrapper.references as string[]).push("not-in-the-store.md");
  const current = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const fresh = current.plan!.nodes[0];
  assert(fresh?.kind === "workflow");
  assert.deepEqual(fresh.references, ["docs/release.md"]);
  const support = localPlanInput(["support"]).nodes[0]!;
  assert(support.kind === "step");
  support.references = ["src/support.ts"];
  const plan = {...current.plan!, nodes: [...current.plan!.nodes, support]};
  const result = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, current, plan, "references-support"), validationFor(fixture));
  assert.equal(result.status, "applied");
  const afterApply = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const invalidPlan = structuredClone(afterApply.plan!);
  Object.assign(invalidPlan.nodes.at(-1)!, {references: ["docs/ghp_" + "A".repeat(32) + ".md"]});
  assert.equal((yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, afterApply, invalidPlan, "sensitive-reference"), validationFor(fixture))).status, "invalid");
  assert.equal((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!.revision, afterApply.revision);
  yield* reopen(fixture);
  const restored = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.deepEqual(restored.plan, plan);
}));

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

const applyInput = (fixture: Fixture, document: WorkflowStateDocument, plan: WorkflowStatePlan,
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

it.live("nested agreement imports preserve reusable occurrence IDs and exact history", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  const source = acceptedAgreement(fixture.proposal);
  const imported = yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(fixture.owner, source, 100));
  assert.equal(imported.status, "applied");
  if (imported.status !== "applied") return;
  const first = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
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
  assert.deepEqual(yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(
    fixture.owner, source, 200)), imported, "an exact import replay does not regenerate occurrence IDs");

  const extra = localPlanInput(["extra"]).nodes[0]!;
  const editedPlan: WorkflowPlanGroupInfo = {...first.plan!, nodes: [...first.plan!.nodes, extra]};
  const editedInput = applyInput(fixture, first, editedPlan, "append-local");
  const direct = validateWorkflowApplyAgainstPinnedContext({plan: editedInput.plan, requirements: editedInput.requirements,
    issues: editedInput.issues, sourceBinding: editedInput.sourceBinding!}, fixture.context!, fixture.proposal, "task-a", "proposal-a",
  taskSourceHash, {targetThreadId: "main-a", mainThreadId: "main-a"}, acceptedWorkflowPlansForBinding(first, sourceBinding(fixture.proposal)), first.plan);
  assert.ok(direct, JSON.stringify({proposalIssues: fixture.proposal.issues, requirementStates: fixture.proposal.requirements.map(item => item.state)}));
  const edited = yield* fixture.workflows.apply(fixture.owner, editedInput, validationFor(fixture), 300);
  assert.equal(edited.status, "applied", JSON.stringify(edited));
  const afterEdit = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.equal(afterEdit.currentAgreementKey, null);
  assert.deepEqual(afterEdit.acceptedAgreements[0]?.agreement, source.agreement);
  assert.deepEqual(yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(fixture.owner, source, 400)), imported);
  assert.equal((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))?.revision, 2,
    "historical acceptance replay leaves the edited plan untouched");
}));

it.live("nested moves and insertions preserve occurrence status and contributor identity with CAS receipts", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([], false);
  const source = acceptedAgreement(fixture.proposal);
  const created = yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(fixture.owner, source, 100));
  assert.equal(created.status, "applied");
  if (created.status !== "applied") return;
  const initial = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
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
  const applied = yield* fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 200);
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  if (applied.status !== "applied") return;
  const updated = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const retainedFirst = updated.plan!.nodes[1];
  assert.equal(retainedFirst?.kind, "step");
  if (retainedFirst?.kind !== "step") return;
  assert.equal(retainedFirst.nodeId, firstStep.nodeId);
  assert.equal(retainedFirst.status, "underway");
  assert.deepEqual(retainedFirst.contributorThreadIds, [contributorThreadId]);
  assert.ok(updated.evidence.some(item => item.kind === "status_changed" && item.targetNodeId === firstStep.nodeId &&
    item.statusFrom === "planned" && item.statusTo === "underway" && item.sourceThreadId === "child-a" &&
    item.sourceItemId === "turn-item-child-command"));
  assert.deepEqual(yield* fixture.workflows.apply(reverseObjectKeys(fixture.owner) as WorkflowOwner,
    reverseObjectKeys(input) as WorkflowApplyInput, validationFor(fixture), 900), applied,
  "object-key order does not change operation replay");

  const repeated = yield* fixture.workflows.apply(fixture.owner, input, undefined, 901);
  assert.deepEqual(repeated, applied, "an exact durable receipt replays even when a fresh definition pin is unavailable");
  const reused = yield* fixture.workflows.apply(fixture.owner, {...input, note: "A different request reused this operation ID."}, validationFor(fixture), 902);
  assert.equal(reused.status, "conflict");
  if (reused.status === "conflict") assert.equal(reused.reason, "operation_id_reused");
  const stale = yield* fixture.workflows.apply(fixture.owner, {...input, operationId: "stale-write", expectedRevision: initial.revision}, validationFor(fixture), 903);
  assert.equal(stale.status, "conflict");
  if (stale.status === "conflict") assert.equal(stale.reason, "revision");

  const current = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const newStep = {kind: "step" as const, definitionId: null, localId: "third", templatePath: null, name: "Local third",
    description: "Complete local task third.", source: null, resolution: "resolved" as const,
    reason: "This task adds third.", status: "planned" as const, contributorThreadIds: []};
  const inserted: WorkflowPlanGroupInfo = {...current.plan!, nodes: [newStep as unknown as WorkflowPlanNodeInfo, ...current.plan!.nodes]};
  const insertedInput = applyInput(fixture, current, inserted, "insert-third", {requirements: [], issues: []});
  assert.equal((yield* fixture.workflows.apply(fixture.owner, insertedInput, validationFor(fixture), 1_000)).status, "applied");
  const afterInsert = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const assignedNewStep = planEntities(afterInsert.plan).find(node => node.kind === "step" && node.localId === "third");
  assert.ok(assignedNewStep?.nodeId, "the trusted validator assigns a stable ID to a proven new node");
  const preserved = planEntities(afterInsert.plan).find(node => node.nodeId === firstStep.nodeId);
  assert.equal(preserved?.status, "underway");
  assert.deepEqual(preserved?.contributorThreadIds, [contributorThreadId]);

  const omittedExistingId = {...afterInsert.plan!, nodes: afterInsert.plan!.nodes.map(node =>
    node.kind === "step" && node.localId === "local-b" ? {...node, nodeId: undefined} : node)} as unknown as WorkflowPlanGroupInfo;
  const identityLoss = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, afterInsert, omittedExistingId, "omit-existing-id", {requirements: [], issues: []}),
    validationFor(fixture), 1_050);
  assert.equal(identityLoss.status, "invalid", "an omitted ID cannot silently turn an existing occurrence into a new node");
  const withoutNew = {...afterInsert.plan!, nodes: afterInsert.plan!.nodes.filter(node => !("nodeId" in node) || node.nodeId !== assignedNewStep?.nodeId)};
  const removeInput = applyInput(fixture, afterInsert, withoutNew, "remove-third", {requirements: [], issues: [], note: "The temporary local occurrence was removed after its work was folded into the parent."});
  assert.equal((yield* fixture.workflows.apply(fixture.owner, removeInput, validationFor(fixture), 1_100)).status, "applied");
  const removed = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!.evidence.find(item => item.kind === "node_removed" && item.targetNodeId === assignedNewStep?.nodeId);
  assert.equal(removed?.note, removeInput.note, "removal history keeps the explicit note");
}));

it.live("a child can work a subset of main requirements without weakening its own fixed commitments", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([], false);
  const mainAgreement = acceptedAgreement(fixture.proposal);
  assert.equal((yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(fixture.owner, mainAgreement, 100))).status, "applied");
  const linked = yield* transaction(fixture, fixture.workflows.linkChild(fixture.owner,
    {operationId: "link-child", lineage: {threadId: "child-a", parentThreadId: "main-a", relationshipToParent: "subagent"}, note: "The controller verified this native descendant."}));
  assert.equal(linked.status, "created");
  const child = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a"))!;
  const localChildPlan = localPlanInput(["child-local"]);
  const childInput = applyInput(fixture, child, localChildPlan, "child-local-plan", {requirements: [], issues: []});
  assert.equal((yield* fixture.workflows.apply(fixture.owner, childInput, validationFor(fixture), 200)).status, "applied",
    "a child plan need not copy the main task's required workflow");
  const fixedProposal = makeProposal(fixture.definitions, fixture.context!, proposalPlan(true), []);
  const currentChild = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a"))!;
  const fixedChild: WorkflowPlanGroupInfo = {...currentChild.plan!, nodes: [...currentChild.plan!.nodes, ...fixedProposal.plan!.nodes]};
  const addFixedInput = applyInput(fixture, currentChild, fixedChild, "child-add-fixed", {requirements: [], issues: []});
  assert.equal((yield* fixture.workflows.apply(fixture.owner, addFixedInput, validationFor(fixture), 300)).status, "applied");
  const childWithFixed = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a"))!;
  const omitFixedInput = applyInput(fixture, childWithFixed, localChildPlan, "child-remove-fixed", {requirements: [], issues: []});
  const removal = yield* fixture.workflows.apply(fixture.owner, omitFixedInput, validationFor(fixture), 400);
  assert.equal(removal.status, "invalid", "a child cannot later remove a fixed workflow it committed to");
  assert.equal((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a"))?.revision, childWithFixed.revision);
}));

it.live("a fixed workflow added after the original proposal remains pinned in main state", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([], false);
  const source = acceptedAgreement(fixture.proposal);
  assert.equal((yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(fixture.owner, source, 100))).status, "applied");
  const current = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const fixedProposal = makeProposal(fixture.definitions, fixture.context!, proposalPlan(true), []);
  const withFixed: WorkflowPlanGroupInfo = {...current.plan!, nodes: [...current.plan!.nodes, ...fixedProposal.plan!.nodes]};
  const add = applyInput(fixture, current, withFixed, "main-add-fixed", {requirements: [], issues: []});
  assert.equal((yield* fixture.workflows.apply(fixture.owner, add, validationFor(fixture), 200)).status, "applied");
  const pinned = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const remove = applyInput(fixture, pinned, current.plan, "main-remove-fixed", {requirements: [], issues: []});
  const rejected = yield* fixture.workflows.apply(fixture.owner, remove, validationFor(fixture), 300);
  assert.equal(rejected.status, "invalid", "mutable current state is canonicalized against pinned definitions before preserving fixed nodes");
  assert.equal((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))?.revision, pinned.revision);
}));

it.live("workflow needs-attention lookup is scoped, bounded, and reports incomplete scans", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  const main = yield* transaction(fixture, fixture.workflows.ensureMain(
    fixture.owner, "attention-scan-main", "Create the main workflow.", 100));
  assert.equal(main.status, "created");
  const child = yield* transaction(fixture, fixture.workflows.linkChild(fixture.owner, {
    operationId: "attention-scan-child",
    lineage: {threadId: "child-a", parentThreadId: fixture.owner.mainThreadId, relationshipToParent: "subagent"},
    note: "Create a child workflow.",
  }, 101));
  assert.equal(child.status, "created");
  assert.equal((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId, "child-a"))?.status, "planned");

  const mainDocument = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
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
  yield* execute(fixture.sql, "UPDATE supervisor_workflow_state SET document=?,updated_at=? WHERE workflow_id=?",
    JSON.stringify(needsAttentionDocument), 102, mainDocument.workflowId);

  assert.deepEqual(yield* fixture.workflows.hasNeedsAttention(fixture.owner.projectId, fixture.owner.mainThreadId,
    [fixture.owner.mainThreadId, "child-a"], 2), {status: "complete", needsAttention: true, inspected: 2});
  assert.deepEqual(yield* fixture.workflows.hasNeedsAttention(fixture.owner.projectId, fixture.owner.mainThreadId,
    [fixture.owner.mainThreadId, "child-a"], 1), {status: "incomplete", needsAttention: false, inspected: 1, reason: "limit_exceeded"});
  assert.equal((yield* fixture.workflows.hasNeedsAttention(fixture.owner.projectId, fixture.owner.mainThreadId,
    [fixture.owner.mainThreadId, fixture.owner.mainThreadId], 2)).status, "incomplete");
}));

it.live("agreement size bounds reject without creating a row or reserving a receipt", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  const source = acceptedAgreement(fixture.proposal);
  const oversized = {...source, agreement: {...source.agreement, message: "é".repeat(Math.ceil(workflowMutationLimits.maxDocumentBytes / 2))}};
  const rejected = yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(fixture.owner, oversized, 150));
  assert.equal(rejected.status, "invalid");
  if (rejected.status === "invalid") assert.equal(rejected.reason, "document_capacity");
  assert.equal((yield* fixture.workflows.getState(fixture.owner.projectId, fixture.owner.mainThreadId)).status, "not_found");
  assert.equal(yield* count(fixture, "supervisor_workflow_state"), 0);
  assert.equal(yield* count(fixture, "supervisor_workflow_operations"), 0);
}));

it.live("unversioned flat documents and receipts are reported incompatible and retained raw", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  const workflowId = "legacy-workflow";
  const raw = JSON.stringify({workflowId, projectId: fixture.owner.projectId, mainThreadId: fixture.owner.mainThreadId, threadId: fixture.owner.mainThreadId,
    parentWorkflowId: null, parentThreadId: null, revision: 7, status: "planned", objective: "A retired flat plan.", rules: [],
    steps: [{id: "old-step", blockId: null, name: "Old format", reason: "Preserve as raw data.", status: "planned", contributorThreadIds: []}],
    currentAgreementKey: null, acceptedAgreements: [], evidence: [], createdAt: 10, updatedAt: 11});
  yield* execute(fixture.sql, "INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    workflowId, fixture.owner.projectId, fixture.owner.mainThreadId, fixture.owner.mainThreadId, null, null, 7, raw, 10, 11);
  const request = {kind: "ensure-main", owner: fixture.owner, note: "Start a draft."};
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
  };
  const oldResult = JSON.stringify({status: "created", operationId: "legacy-replay", workflowId, revision: 7, stateHash: "legacy-hash"});
  yield* execute(fixture.sql, "INSERT INTO supervisor_workflow_operations(project_id,main_thread_id,actor_thread_id,binding_generation,operation_namespace,operation_id,request_hash,result,workflow_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    fixture.owner.projectId, fixture.owner.mainThreadId, fixture.owner.supervisorThreadId, fixture.owner.bindingGeneration, "edit", "legacy-replay",
    fingerprint(canonical(request)), oldResult, workflowId, 12);

  assert.deepEqual(yield* fixture.workflows.getState(fixture.owner.projectId, fixture.owner.mainThreadId),
    {status: "incompatible", workflowId, formatVersion: null});
  const lookup = yield* transaction(fixture, fixture.workflows.getByIdForOwner(fixture.owner, workflowId));
  assert.deepEqual(lookup, {status: "incompatible", workflowId, formatVersion: null});
  assert.deepEqual(yield* fixture.workflows.listResult(fixture.owner.projectId, fixture.owner.mainThreadId), {documents: [], incompatible: [{workflowId, formatVersion: null}]});
  assert.deepEqual(yield* fixture.workflows.ensureMain(fixture.owner, "ensure-existing-legacy", "Do not reinterpret this row."),
    {status: "incompatible", workflowId, formatVersion: null, operationId: "ensure-existing-legacy"});
  assert.equal((yield* fixture.workflows.ensureMain(fixture.owner, "legacy-replay", "Start a draft.")).status, "incompatible",
    "an old receipt is never replayed as a v2 successful write");
  const applyLegacy: WorkflowApplyInput = {operationId: "apply-legacy", workflowId, expectedRevision: 7, status: "planned",
    objective: "A retired flat plan.", sourceBinding: sourceBinding(fixture.proposal), requirements: [...fixture.proposal.requirements],
    issues: [...fixture.proposal.issues], plan: fixture.proposal.plan, note: "Do not reinterpret or overwrite the old row."};
  assert.deepEqual(yield* fixture.workflows.apply(fixture.owner, applyLegacy, validationFor(fixture)),
    {status: "incompatible", workflowId, formatVersion: null, operationId: "apply-legacy"});
  assert.equal((yield* query(fixture.sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", workflowId))[0]?.document, raw);
  assert.equal((yield* query(fixture.sql, "SELECT result FROM supervisor_workflow_operations WHERE operation_id=?", "legacy-replay"))[0]?.result, oldResult);
  assert.equal(yield* count(fixture, "supervisor_workflow_state"), 1);
  assert.equal(yield* count(fixture, "supervisor_workflow_operations"), 1);
}));

it.live("missing pinned context and incompatible supervisor scope fail closed without reserving operations", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  const source = acceptedAgreement(fixture.proposal);
  const created = yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(fixture.owner, source, 100));
  assert.equal(created.status, "applied");
  if (created.status !== "applied") return;
  const current = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const input = applyInput(fixture, current, current.plan, "missing-pin");
  assert.deepEqual(yield* fixture.workflows.apply(fixture.owner, input, undefined), {
    status: "invalid", operationId: input.operationId, reason: "pinned_definition_context_required",
  });
  assert.equal(yield* count(fixture, "supervisor_workflow_operations"), 1);

  yield* execute(fixture.sql, "UPDATE meta SET value='future' WHERE key='supervisor_scope_version'");
  yield* reopen(fixture);
  const {supervisors, workflows} = fixture;
  assert.equal(supervisors.scopeCompatible, false);
  assert.equal((yield* workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))?.revision, current.revision);
  assert.deepEqual(yield* workflows.apply(fixture.owner, {...input, operationId: "scope-retry"}, validationFor(fixture)),
    {status: "owner_mismatch", operationId: "scope-retry"});
  assert.equal((yield* workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))?.revision, current.revision);
  assert.equal(yield* count(fixture, "supervisor_workflow_operations"), 1);
}));

const plannedFirstExpected = "insert with status \"planned\" in this apply, then change status in a separate apply with status_changed evidence.";
const missingEvidenceExpected = "include status_changed evidence for this status change in the same apply.";
const plannedFirstSentinel = "zzsentinelplannedfirst9f3c";

const liveStep = (localId: string, status: "planned" | "underway" | "completed" | "needs_attention", text = `Local ${localId}`) => ({
  kind: "step" as const, definitionId: null, localId, templatePath: null, name: text, description: text, source: null,
  resolution: "resolved" as const, reason: `This task adds ${localId}.`, status, contributorThreadIds: [] as string[],
});

const appendNodes = (plan: WorkflowPlanGroupInfo, nodes: readonly unknown[]): WorkflowPlanGroupInfo => ({
  ...plan, nodes: [...plan.nodes, ...nodes as WorkflowPlanNodeInfo[]],
});

const seedLocalWorkflow = Effect.gen(function* () {
  const fixture = yield* makeFixture([], false);
  const created = yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(
    fixture.owner, acceptedAgreement(fixture.proposal), 100));
  assert.equal(created.status, "applied");
  const current = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.equal(current.plan?.nodes.length, 2);
  return {fixture, current};
});

it.live("a new live node inserted underway, completed, or needs_attention is rejected with new_node_must_start_planned and a structural status pointer", () => Effect.gen(function* () {
  const {fixture, current} = yield* seedLocalWorkflow;
  const index = current.plan!.nodes.length;
  for (const status of ["underway", "completed", "needs_attention"] as const) {
    const result = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, current, appendNodes(current.plan!, [liveStep(`new-${status}`, status)]), `insert-${status}`), validationFor(fixture));
    assert.equal(result.status, "invalid", status);
    if (result.status !== "invalid") continue;
    assert.equal(result.reason, "new_node_must_start_planned", status);
    assert.deepEqual(result.diagnostic, {code: "new_node_must_start_planned", path: `/plan/nodes/${index}/status`, expected: plannedFirstExpected}, status);
    assert.deepEqual(Object.keys(result).sort(), ["diagnostic", "operationId", "reason", "status"]);
  }
  const later = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, current, appendNodes(current.plan!, [
    liveStep("new-planned", "planned"), liveStep("new-completed", "completed")]), "insert-planned-then-completed"), validationFor(fixture));
  assert.equal(later.status, "invalid");
  if (later.status === "invalid") assert.deepEqual(later.diagnostic, {
    code: "new_node_must_start_planned", path: `/plan/nodes/${index + 1}/status`, expected: plannedFirstExpected,
  }, "the pointer identifies the first non-planned insert, skipping a new planned node");
  const first = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, current, {
    ...current.plan!, nodes: [liveStep("early-underway", "underway") as unknown as WorkflowPlanNodeInfo, ...current.plan!.nodes,
      liveStep("late-completed", "completed") as unknown as WorkflowPlanNodeInfo],
  }, "insert-underway-first"), validationFor(fixture));
  assert.equal(first.status, "invalid");
  if (first.status === "invalid") assert.equal(first.diagnostic?.path, "/plan/nodes/0/status", "walk order reports the first offending node");
  const nestedIndex = current.plan!.nodes.length;
  const nested = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, current, appendNodes(current.plan!, [{
    kind: "parallel", templatePath: null, nodes: [liveStep("nested-completed", "completed") as unknown as WorkflowPlanNodeInfo],
  }]), "insert-nested-completed"), validationFor(fixture));
  assert.equal(nested.status, "invalid");
  if (nested.status === "invalid") assert.equal(nested.diagnostic?.path, `/plan/nodes/${nestedIndex}/nodes/0/status`);
  assert.equal((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))?.revision, current.revision);
}));

it.live("planned-first rejection does not echo the submitted node name, description, or id", () => Effect.gen(function* () {
  const {fixture, current} = yield* seedLocalWorkflow;
  const plan = appendNodes(current.plan!, [liveStep(plannedFirstSentinel, "completed", plannedFirstSentinel)]);
  const offending = plan.nodes.at(-1);
  assert.equal(offending && "name" in offending ? offending.name : "", plannedFirstSentinel);
  assert.equal(offending && "description" in offending ? offending.description : "", plannedFirstSentinel);
  assert.equal(offending && "localId" in offending ? offending.localId : "", plannedFirstSentinel);
  const result = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, current, plan, "reject-sentinel-node"), validationFor(fixture));
  assert.equal(result.status, "invalid");
  assert.equal(JSON.stringify(result).includes(plannedFirstSentinel), false);
  if (result.status === "invalid") {
    assert.equal(result.reason, "new_node_must_start_planned");
    assert.equal(result.diagnostic?.path, `/plan/nodes/${current.plan!.nodes.length}/status`);
    assert.equal(result.diagnostic?.expected, plannedFirstExpected);
  }
}));

it.live("a new planned node becomes underway or completed only in a separate apply with status_changed evidence", () => Effect.gen(function* () {
  const {fixture, current} = yield* seedLocalWorkflow;
  const inserted = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, current, appendNodes(current.plan!, [liveStep("third", "planned")]), "insert-planned"), validationFor(fixture));
  assert.equal(inserted.status, "applied");
  const afterInsert = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const third = planEntities(afterInsert.plan).find(node => node.kind === "step" && node.localId === "third");
  assert.equal(third?.status, "planned");
  assert.ok(third?.nodeId);
  const withoutEvidence = {...afterInsert.plan!, nodes: afterInsert.plan!.nodes.map(node => node.kind === "step" && node.nodeId === third?.nodeId ? {...node, status: "underway" as const} : node)};
  const missing = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, afterInsert, withoutEvidence, "start-without-evidence"), validationFor(fixture));
  assert.equal(missing.status, "invalid");
  if (missing.status === "invalid") assert.deepEqual(missing.diagnostic, {
    code: "missing_status_changed_evidence", path: `/plan/nodes/${afterInsert.plan!.nodes.length - 1}/status`, expected: missingEvidenceExpected,
  });
  assert.equal((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))?.revision, afterInsert.revision);
  const started = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, afterInsert, withoutEvidence, "start-with-evidence", {
    evidence: [{kind: "status_changed", targetNodeId: third?.nodeId, note: "The new occurrence started."}],
  }), validationFor(fixture));
  assert.equal(started.status, "applied");
  const afterStart = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.equal(planEntities(afterStart.plan).find(node => node.nodeId === third?.nodeId)?.status, "underway");
  const completedPlan = {...afterStart.plan!, nodes: afterStart.plan!.nodes.map(node => node.kind === "step" && node.nodeId === third?.nodeId ? {...node, status: "completed" as const} : node)};
  const completed = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, afterStart, completedPlan, "complete-with-evidence", {
    evidence: [{kind: "status_changed", targetNodeId: third?.nodeId, note: "The new occurrence finished."}],
  }), validationFor(fixture));
  assert.equal(completed.status, "applied");
  assert.equal(planEntities((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))?.plan ?? null).find(node => node.nodeId === third?.nodeId)?.status, "completed");
}));

it.live("document status changes still require untargeted status_changed evidence and unknown evidence targets stay generic", () => Effect.gen(function* () {
  const {fixture, current} = yield* seedLocalWorkflow;
  const first = current.plan!.nodes[0];
  assert.equal(first?.kind, "step");
  if (first?.kind !== "step") return;
  const nodeOnly = yield* fixture.workflows.apply(fixture.owner, {...applyInput(fixture, current, current.plan, "document-node-evidence", {
    evidence: [{kind: "status_changed", targetNodeId: first.nodeId, note: "This evidence names a step."}],
  }), status: "underway"}, validationFor(fixture));
  assert.equal(nodeOnly.status, "invalid");
  if (nodeOnly.status === "invalid") assert.deepEqual(nodeOnly.diagnostic, {
    code: "missing_status_changed_evidence", path: "/status", expected: missingEvidenceExpected,
  });
  const missing = yield* fixture.workflows.apply(fixture.owner, {...applyInput(fixture, current, current.plan, "document-without-evidence"), status: "underway"}, validationFor(fixture));
  assert.equal(missing.status, "invalid");
  if (missing.status === "invalid") assert.equal(missing.diagnostic?.path, "/status");
  assert.equal((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))?.status, "planned");
  const accepted = yield* fixture.workflows.apply(fixture.owner, {...applyInput(fixture, current, current.plan, "document-with-evidence", {
    evidence: [{kind: "status_changed", targetNodeId: null, note: "The workflow itself started."}],
  }), status: "underway"}, validationFor(fixture));
  assert.equal(accepted.status, "applied");
  const started = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.equal(started.status, "underway");
  assert.equal(planEntities(started.plan).every(node => node.status === "planned"), true);
  const dangling = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, started, started.plan, "dangling-evidence-target", {
    evidence: [{kind: "status_changed", targetNodeId: randomUUID(), note: "This target is not in the plan."}],
  }), validationFor(fixture));
  assert.equal(dangling.status, "invalid");
  if (dangling.status === "invalid") {
    assert.equal(dangling.reason, "invalid_plan_or_missing_status_evidence");
    assert.equal(dangling.diagnostic, undefined);
  }
  assert.equal((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))?.revision, started.revision);
}));

const contributionRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({taskId: "task-a", contributionId: "review:external-1",
  nodeId: "e4b9739d-55f2-4c66-80ba-afdf6ec7c23f", revision: 1, state: "awaiting_result", summary: "An external reviewer is checking the export.",
  references: [{kind: "url", value: "https://reviews.example/42"}], externalRef: "review-42", ...overrides});

const contribution = (nodeId: string, overrides: Partial<ExternalContributionImport> = {}): ExternalContributionImport => ({contributionId: "review:external-1",
  nodeId, revision: 1, state: "awaiting_result", summary: "An external reviewer is checking the export.", references: [], externalRef: null,
  sourceThreadId: "main-a", sourceRunId: "run-main", sourceMessageId: "message-1", ...overrides});

const seedLocalMain = (fixture: Fixture) => Effect.gen(function* () {
  assert.equal((yield* transaction(fixture, fixture.workflows.importAcceptedAgreement(fixture.owner, acceptedAgreement(fixture.proposal), 100))).status, "applied");
  const document = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const steps = planEntities(document.plan);
  assert.equal(steps.length, 2);
  return {document, first: steps[0]!, second: steps[1]!};
});

const record = (fixture: Fixture, input: ExternalContributionImport, now = 500) =>
  transaction(fixture, fixture.workflows.recordContribution(fixture.owner, input, now));

const statusSnapshot = (fixture: Fixture) => Effect.gen(function* () {
  const document = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  return {status: document.status, nodes: planEntities(document.plan).map(node => [node.nodeId, node.status, [...node.contributorThreadIds]])};
});

it("external-contribution records parse only with every exact field, type and cap", () => {
  const parsed = parseExternalContributionRecord(contributionRecord());
  assert.deepEqual(parsed, contributionRecord());
  assert.deepEqual(parseExternalContributionRecord(contributionRecord({references: [], externalRef: null, summary: ""}))?.references, []);
  const atCaps = contributionRecord({contributionId: "a".repeat(64), summary: "s".repeat(externalContributionLimits.maxSummaryLength),
    references: Array.from({length: externalContributionLimits.maxReferences}, (_, index) => ({kind: (["file", "url", "source", "text"] as const)[index % 4], value: "v".repeat(500)})),
    externalRef: "r".repeat(200)});
  assert.ok(parseExternalContributionRecord(atCaps), "every cap is inclusive");
  const missing = contributionRecord();
  delete missing.externalRef;
  const rejected: Array<[string, unknown]> = [
    ["missing field", missing],
    ["extra field", contributionRecord({mainThreadId: "main-a"})],
    ["array", [contributionRecord()]],
    ["null", null],
    ["string revision", contributionRecord({revision: "1"})],
    ["zero revision", contributionRecord({revision: 0})],
    ["fractional revision", contributionRecord({revision: 1.5})],
    ["unknown state", contributionRecord({state: "done"})],
    ["long summary", contributionRecord({summary: "s".repeat(2001)})],
    ["non-string summary", contributionRecord({summary: null})],
    ["too many references", contributionRecord({references: Array.from({length: 9}, () => ({kind: "text", value: "x"}))})],
    ["reference extra key", contributionRecord({references: [{kind: "url", value: "https://example.test", label: "x"}]})],
    ["reference kind", contributionRecord({references: [{kind: "link", value: "https://example.test"}]})],
    ["long reference", contributionRecord({references: [{kind: "text", value: "v".repeat(501)}]})],
    ["empty reference", contributionRecord({references: [{kind: "text", value: ""}]})],
    ["references object", contributionRecord({references: {kind: "text", value: "x"}})],
    ["long externalRef", contributionRecord({externalRef: "r".repeat(201)})],
    ["empty externalRef", contributionRecord({externalRef: ""})],
    ["contribution ID characters", contributionRecord({contributionId: "two words"})],
    ["long contribution ID", contributionRecord({contributionId: "a".repeat(65)})],
    ["numeric node ID", contributionRecord({nodeId: 7})],
    ["missing task ID", contributionRecord({taskId: ""})],
  ];
  for (const [label, value] of rejected) assert.equal(parseExternalContributionRecord(value), null, label);
});

it.live("contribution revisions start at one, grow by one, replay as no-ops and end at withdrawn", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([], false);
  const {first} = yield* seedLocalMain(fixture);
  const before = yield* statusSnapshot(fixture);
  const created = yield* record(fixture, contribution(first.nodeId), 500);
  assert.equal(created.status, "applied");
  let document = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.equal(document.revision, 2);
  assert.deepEqual(document.contributions, [{...contribution(first.nodeId), recordedAt: 500, assessment: null}]);
  const recorded = document.evidence.at(-1)!;
  assert.equal(recorded.kind, "contribution_recorded");
  assert.deepEqual(recorded.contribution, {contributionId: "review:external-1", revision: 1, state: "awaiting_result", decision: null});
  assert.equal(recorded.targetNodeId, first.nodeId);
  assert.equal(recorded.sourceMessageId, "message-1");

  assert.deepEqual(yield* record(fixture, contribution(first.nodeId, {sourceMessageId: "message-repeat"})), {status: "unchanged", workflowId: document.workflowId, revision: 2},
    "an identical replay from a later message keeps the original source");
  assert.deepEqual(yield* record(fixture, contribution(first.nodeId, {summary: "Changed without a new revision."})), {status: "rejected", code: "contribution_revision_conflict"});
  assert.deepEqual(yield* record(fixture, contribution(first.nodeId, {revision: 3, state: "result"})), {status: "rejected", code: "contribution_revision_gap"});
  assert.deepEqual(yield* record(fixture, contribution(first.nodeId, {contributionId: "late-start", revision: 2})), {status: "rejected", code: "contribution_revision_gap"});
  assert.deepEqual(yield* record(fixture, contribution(first.nodeId, {contributionId: "never-registered", state: "withdrawn"})), {status: "rejected", code: "contribution_record_invalid"});
  assert.equal((yield* record(fixture, contribution(first.nodeId, {revision: 2, state: "result", summary: "The external review passed.", sourceMessageId: "message-2"}))).status, "applied");
  assert.deepEqual(yield* record(fixture, contribution(first.nodeId)), {status: "rejected", code: "contribution_revision_stale"});
  assert.equal((yield* record(fixture, contribution(first.nodeId, {revision: 3, state: "withdrawn", summary: "No longer needed.", sourceMessageId: "message-3"}))).status, "applied");
  document = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.equal(document.revision, 4);
  assert.deepEqual(yield* record(fixture, contribution(first.nodeId, {revision: 4, state: "result"})), {status: "rejected", code: "contribution_withdrawn"});
  assert.deepEqual(yield* record(fixture, contribution(first.nodeId, {revision: 3, state: "withdrawn", summary: "No longer needed.", sourceMessageId: "message-3"})),
    {status: "unchanged", workflowId: document.workflowId, revision: 4});
  assert.deepEqual(document.evidence.filter(item => item.kind === "contribution_recorded").map(item => [item.contribution?.revision, item.contribution?.state, item.sourceMessageId]),
    [[1, "awaiting_result", "message-1"], [2, "result", "message-2"], [3, "withdrawn", "message-3"]]);
  assert.deepEqual(yield* statusSnapshot(fixture), before, "a contribution never changes statuses or contributor threads");
}));

it.live("contributions need a current main-plan node and keep their history when the node is removed", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([], false);
  assert.deepEqual(yield* record(fixture, contribution(randomUUID())), {status: "rejected", code: "contribution_node_unknown"}, "no main workflow yet");
  const {first, second} = yield* seedLocalMain(fixture);
  assert.deepEqual(yield* record(fixture, contribution(randomUUID())), {status: "rejected", code: "contribution_node_unknown"});
  assert.equal((yield* record(fixture, contribution(second.nodeId, {contributionId: "removed-node"}))).status, "applied");
  assert.equal((yield* record(fixture, contribution(second.nodeId, {contributionId: "withdrawn-later"}))).status, "applied");
  const current = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const removed = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, current, {...current.plan!, nodes: [first]}, "remove-second"), validationFor(fixture), 600);
  assert.equal(removed.status, "applied", JSON.stringify(removed));
  const after = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.deepEqual(after.contributions.map(item => [item.contributionId, item.nodeId]), [["removed-node", second.nodeId], ["withdrawn-later", second.nodeId]],
    "a Supervisor edit keeps contributions for a removed node as history");
  assert.ok(after.evidence.some(item => item.kind === "node_removed" && item.targetNodeId === second.nodeId));
  assert.deepEqual(yield* record(fixture, contribution(second.nodeId, {contributionId: "removed-node", revision: 2, state: "result"})),
    {status: "rejected", code: "contribution_node_unknown"});
  assert.equal((yield* record(fixture, contribution(second.nodeId, {contributionId: "withdrawn-later", revision: 2, state: "withdrawn"}))).status, "applied",
    "a withdrawal may still name the removed node");
  assert.equal((yield* record(fixture, contribution(first.nodeId, {contributionId: "removed-node", revision: 2, state: "result", summary: "Moved to the remaining step."}))).status, "applied",
    "a later revision may move the contribution to a current node");
}));

it.live("a contribution assessment covers one exact result revision, never changes status and is cleared by a later main revision", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([], false);
  const {first} = yield* seedLocalMain(fixture);
  yield* record(fixture, contribution(first.nodeId), 500);
  const before = yield* statusSnapshot(fixture);
  let document = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const assess = (overrides: Record<string, unknown> = {}, now = 700) => transaction(fixture, fixture.workflows.assessContribution(fixture.owner,
    {operationId: "assess-1", workflowId: document.workflowId, expectedRevision: document.revision, contributionId: "review:external-1",
      resultRevision: 1, decision: "accepted", note: "The external review satisfies the step.", ...overrides} as never, now));
  assert.deepEqual(yield* assess(), {status: "invalid", operationId: "assess-1", reason: "contribution_not_a_result"});
  yield* record(fixture, contribution(first.nodeId, {revision: 2, state: "result", summary: "Review passed.", sourceMessageId: "message-2"}), 600);
  document = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.deepEqual(yield* assess({expectedRevision: document.revision - 1}), {status: "conflict", operationId: "assess-1", reason: "revision", currentRevision: document.revision});
  assert.deepEqual(yield* assess({resultRevision: 1}), {status: "conflict", operationId: "assess-1", reason: "contribution_result_stale", currentRevision: document.revision});
  assert.deepEqual(yield* assess({contributionId: "unknown"}), {status: "invalid", operationId: "assess-1", reason: "contribution_not_found"});
  assert.deepEqual(yield* assess({decision: "completed", resultRevision: 2}), {status: "invalid", operationId: "assess-1", reason: "invalid_contribution_assessment"});
  const accepted = yield* assess({resultRevision: 2, decision: "needs_more", note: "Attach the reviewer's findings."});
  assert.equal(accepted.status, "applied");
  assert.deepEqual(yield* assess({resultRevision: 2, decision: "needs_more", note: "Attach the reviewer's findings."}, 999), accepted, "an exact replay returns its receipt");
  assert.deepEqual(yield* assess({resultRevision: 2, decision: "accepted", note: "Attach the reviewer's findings."}),
    {status: "conflict", operationId: "assess-1", reason: "operation_id_reused", currentRevision: null});
  document = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  const assessed = document.evidence.at(-1)!;
  assert.equal(assessed.kind, "contribution_assessed");
  assert.deepEqual(assessed.contribution, {contributionId: "review:external-1", revision: 2, state: "result", decision: "needs_more"});
  assert.equal(assessed.sourceMessageId, "message-2", "the assessment cites the main's result message");
  assert.deepEqual(document.contributions[0]?.assessment, {decision: "needs_more", resultRevision: 2, note: "Attach the reviewer's findings.",
    actorSupervisorThreadId: fixture.owner.supervisorThreadId, evidenceId: assessed.id, recordedAt: 700});
  assert.deepEqual(yield* statusSnapshot(fixture), before, "an assessment never changes a status");

  yield* record(fixture, contribution(first.nodeId, {revision: 3, state: "result", summary: "Findings attached.", sourceMessageId: "message-3"}), 800);
  document = (yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.equal(document.contributions[0]?.assessment, null, "a later main revision clears the current assessment");
  assert.ok(document.evidence.some(item => item.kind === "contribution_assessed" && item.contribution?.decision === "needs_more"), "history stays in evidence");
  const final = yield* transaction(fixture, fixture.workflows.assessContribution(fixture.owner, {operationId: "assess-2",
    workflowId: document.workflowId, expectedRevision: document.revision, contributionId: "review:external-1", resultRevision: 3, decision: "accepted",
    note: "The findings satisfy the step."}, 900));
  assert.equal(final.status, "applied");
  assert.deepEqual(yield* statusSnapshot(fixture), before, "an accepted result does not complete the step");
}));

it.live("contributions persist across reopen and a stored document without the field still loads as empty", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([], false);
  const {first} = yield* seedLocalMain(fixture);
  const raw = (yield* query(fixture.sql, "SELECT document FROM supervisor_workflow_state WHERE thread_id=?", "main-a"))[0] as {document: string};
  const stored = JSON.parse(raw.document) as Record<string, unknown>;
  delete stored.contributions;
  yield* execute(fixture.sql, "UPDATE supervisor_workflow_state SET document=? WHERE thread_id=?", JSON.stringify(stored), "main-a");
  assert.deepEqual((yield* fixture.workflows.get(fixture.owner.projectId, fixture.owner.mainThreadId))?.contributions, []);
  assert.equal((yield* record(fixture, contribution(first.nodeId), 500)).status, "applied");
  yield* reopen(fixture);
  const reopened = fixture.workflows;
  const document = (yield* reopened.get(fixture.owner.projectId, fixture.owner.mainThreadId))!;
  assert.deepEqual(document.contributions.map(item => [item.contributionId, item.revision, item.state, item.sourceMessageId]),
    [["review:external-1", 1, "awaiting_result", "message-1"]]);
}));

it.live("contribution capacity is bounded per document and by the evidence history cap", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([], false);
  const {first} = yield* seedLocalMain(fixture);
  for (let index = 0; index < externalContributionLimits.maxContributions; index++)
    assert.equal((yield* record(fixture, contribution(first.nodeId, {contributionId: `external-${index}`, summary: "s".repeat(2000),
      references: Array.from({length: 8}, () => ({kind: "text" as const, value: "v".repeat(500)})), externalRef: "r".repeat(200)}))).status, "applied");
  assert.deepEqual(yield* record(fixture, contribution(first.nodeId, {contributionId: "one-too-many"})), {status: "rejected", code: "contribution_capacity"});
  assert.equal((yield* record(fixture, contribution(first.nodeId, {contributionId: "external-0", revision: 2, state: "result"}))).status, "applied",
    "existing contributions still accept revisions at the cap");
  const raw = (yield* query(fixture.sql, "SELECT document FROM supervisor_workflow_state WHERE thread_id=?", "main-a"))[0] as {document: string};
  const stored = JSON.parse(raw.document) as {evidence: unknown[]};
  const filler = stored.evidence.at(-1) as Record<string, unknown>;
  while (stored.evidence.length < workflowMutationLimits.maxEvidence) stored.evidence.push({...filler, id: randomUUID()});
  yield* execute(fixture.sql, "UPDATE supervisor_workflow_state SET document=? WHERE thread_id=?", JSON.stringify(stored), "main-a");
  assert.deepEqual(yield* record(fixture, contribution(first.nodeId, {contributionId: "external-1", revision: 2, state: "result"})), {status: "rejected", code: "contribution_capacity"});
}));
