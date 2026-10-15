import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint, GuidanceStore } from "../src/guidance-store.js";
import { defaultSupervisorModel, ProjectSupervisorStore, type BindingRecord, type TaskRecord } from "../src/project-supervisor-store.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import type { WorkflowAgreementImport, WorkflowOwner } from "../src/workflow-state-contract.js";
import { WorkflowWriteController, workflowReadToolDefinition, workflowWriteToolDefinition, type WorkflowApplyPatch, type WorkflowNativeAccess } from "../src/workflow-write-controller.js";
import { workflowProviderDriverFromCatalog, workflowToolInputMaxBytes, workflowToolInputSize, workflowToolNames, workflowTurnItemDetailMaxBytes, workflowWriteDriverSupport } from "../src/workflow-write-evidence.js";
import type { WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo, WorkflowSourceBindingInfo } from "../src/project-supervisor-contract.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { proposalContextFromDefinitions, validateWorkflowPlan } from "../src/supervisor-workflow.js";

type Fixture = {
  directory: string;
  guidance: GuidanceStore;
  supervisors: ProjectSupervisorStore;
  workflows: WorkflowStateStore;
  controller: WorkflowWriteController;
  owner: WorkflowOwner;
  binding: BindingRecord;
  projectId: string;
  mainThreadId: string;
  supervisorThreadId: string;
  threads: ThreadInfo[];
  projection: Projection;
  projections: Map<string, Projection>;
  details: Map<string, unknown>;
  projectionCalls: string[];
  detailCalls: string[];
  native: WorkflowNativeAccess;
  definitionReader: {current: ProjectDefinitionSnapshot; calls: number; fail?: boolean};
  proposal: WorkflowProposalInfo;
  sourceBinding: WorkflowSourceBindingInfo;
};

const thread = (id: string, projectId: string, parentThreadId: string | null = null, relationshipToParent: string | null = null,
  rootThreadId?: string): ThreadInfo => ({id, title: id, projectId, archivedAt: null, deletedAt: null,
  lineage: {parentThreadId, relationshipToParent,
    ...(rootThreadId ? {rootThreadId} : {})}});

const makeProjection = (supervisorThreadId: string, projectId: string): Projection => ({
  thread: thread(supervisorThreadId, projectId),
  runs: [],
  messages: [],
  nodes: [],
  turnItems: [],
});

const localStep = (name: string, description: string, contributorThreadIds: readonly string[] = [], nodeId?: string) => ({
  kind: "step" as const,
  ...(nodeId ? {nodeId} : {}),
  definitionId: null,
  localId: name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 180),
  templatePath: null,
  name,
  description,
  source: null,
  resolution: "resolved" as const,
  reason: description,
  status: "planned" as const,
  contributorThreadIds,
});

const sequencePlan = (nodes: readonly unknown[], templatePath: string | null = null): WorkflowPlanGroupInfo => ({
  kind: "sequence",
  templatePath,
  nodes: [...nodes] as WorkflowPlanNodeInfo[],
});

const planEntities = (plan: WorkflowPlanGroupInfo | null): Extract<WorkflowPlanNodeInfo, {kind: "step" | "workflow"}>[] => {
  if (!plan) return [];
  return plan.nodes.flatMap(node => "nodes" in node ? planEntities(node) : [node, ...(node.kind === "workflow" ? planEntities(node.plan) : [])]);
};

const mainStep = (plan: WorkflowPlanGroupInfo | null, index = 0) => planEntities(plan).filter(node => node.kind === "step")[index];

const makeFixture = async (mainThread = thread("main-workflows", "project-workflows")): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-write-controller-test-"));
  const guidance = new GuidanceStore(directory);
  const supervisors = new ProjectSupervisorStore(guidance, new Set());
  const projectId = "project-workflows";
  const mainThreadId = mainThread.id;
  const supervisorControl = (scope: string | null, enabled: boolean) => guidance.db.prepare(
    "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(`supervisor_control:${JSON.stringify(scope)}`, JSON.stringify({generation: 1, enabled, manual: true}));
  supervisorControl(null, true);
  supervisorControl(projectId, true);
  const reserved = supervisors.reserve(projectId, mainThreadId, "Main thread", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  supervisors.setBinding(binding);
  const workflows = new WorkflowStateStore(supervisors, id => supervisors.enabled(id));
  const supervisorThreadId = binding.threadId;
  const definitionSnapshot: ProjectDefinitionSnapshot = {
    projectId,
    threadId: mainThreadId,
    workspaceRoot: "/workspace/project-workflows",
    globalOnly: false,
    globalRevision: null,
    revision: "definition-revision-1",
    editingAvailable: true,
    status: "ready",
    steps: [],
    workflows: [],
    config: {required: []},
    projectConfig: {required: []},
    complete: true,
    sources: [],
    issues: [],
  };
  const definitionContext = proposalContextFromDefinitions(definitionSnapshot);
  const normalized = validateWorkflowPlan({requirements: [], plan: sequencePlan([localStep("Baseline review", "Review the current task context.")])}, definitionContext);
  if (!normalized?.plan) throw new Error("test_workflow_proposal_invalid");
  const proposal: WorkflowProposalInfo = {
    status: "proposed",
    message: "A source-bound workflow proposal for this task.",
    workspaceRoot: definitionSnapshot.workspaceRoot,
    revision: definitionSnapshot.revision,
    globalRevision: null,
    definitionsStatus: "ready",
    definitionsComplete: true,
    requirementsKnown: true,
    requirements: normalized.requirements,
    issues: normalized.issues,
    plan: normalized.plan,
  };
  const taskSourceHash = fingerprint("Complete the current project task.");
  const taskId = "task-current";
  const proposalId = "proposal-current";
  const task: TaskRecord = {
    id: taskId,
    threadId: mainThreadId,
    projectId,
    sourceRunId: "source-run-current",
    sourceMessageId: "source-message-current",
    status: "inferred",
    objective: "Complete the current project task.",
    reason: "The latest user message describes an actionable task.",
    updatedAt: Date.now(),
    workflow: proposal,
    agreement: null,
    workflowProposalId: proposalId,
    sourceHash: taskSourceHash,
    requestText: "Complete the current project task.",
    supervisorThreadId,
    messageId: "source-message-current",
    dispatchedAt: null,
    replayCount: 0,
    supervisorRunId: "source-run-current",
    sourceOrdinal: 1,
    definitionContext,
    definitionSnapshot,
  };
  supervisors.saveTask(task);
  const sourceBinding: WorkflowSourceBindingInfo = {
    workspaceRoot: definitionSnapshot.workspaceRoot,
    revision: definitionSnapshot.revision,
    globalRevision: null,
    definitionsStatus: "ready",
    definitionsComplete: true,
    requirementsKnown: true,
    taskId,
    proposalId,
    sourceHash: taskSourceHash,
  };
  const definitionReader: Fixture["definitionReader"] = {current: definitionSnapshot, calls: 0};
  const threads = [mainThread, thread(supervisorThreadId, projectId)];
  const projection = makeProjection(supervisorThreadId, projectId);
  const projections = new Map([[supervisorThreadId, projection]]);
  const details = new Map<string, unknown>();
  const projectionCalls: string[] = [];
  const detailCalls: string[] = [];
  const native: WorkflowNativeAccess = {
    listThreads: async () => threads,
    projection: async id => {
      projectionCalls.push(id);
      const current = projections.get(id);
      if (!current) throw new Error("unexpected_projection");
      return current;
    },
    getTurnItem: async ({itemId}) => {
      detailCalls.push(itemId);
      return {item: details.get(itemId) ?? null};
    },
  };
  const controller = new WorkflowWriteController({supervisors, workflows, native,
    loadDefinitions: async () => {definitionReader.calls++;if (definitionReader.fail) throw new Error("definitions_unavailable");return definitionReader.current;},
    isEnabled: id => supervisors.enabled(id), maxEvidenceWaitMs: 0});
  return {directory, guidance, supervisors, workflows, controller,
    owner: {projectId, mainThreadId, supervisorThreadId, bindingGeneration: binding.generation}, binding,
    projectId, mainThreadId, supervisorThreadId, threads, projection, projections, details, projectionCalls, detailCalls, native,
    definitionReader, proposal, sourceBinding};
};

const closeFixture = async (fixture: Fixture): Promise<void> => {
  fixture.guidance.close();
  await rm(fixture.directory, {recursive: true, force: true});
};

const locator = (fixture: Fixture) => ({
  supervisorThreadId: fixture.supervisorThreadId,
  bindingGeneration: fixture.binding.generation,
});

const ensureArgs = (fixture: Fixture, operationId: string, note: string) => ({
  action: "ensure_main",
  ...locator(fixture),
  operationId,
  note,
});

const installEvidence = (fixture: Fixture, args: Record<string, unknown>, options: {
  itemId?: string;
  input?: unknown;
  toolName?: string;
  nodeKind?: string;
  status?: string;
  runStatus?: string;
  rootNodeStatus?: string;
  toolNodeStatus?: string;
  parentItemId?: string | null;
  runId?: string;
  providerThreadId?: string;
  providerInstanceId?: string;
  appRunOrdinal?: number;
  snapshotInput?: unknown;
  driver?: string;
} = {}): string => {
  const itemId = options.itemId ?? `workflow-tool-${fixture.details.size + 1}`;
  const runId = options.runId ?? "supervisor-run-current";
  const providerThreadId = options.providerThreadId ?? "provider-thread-current";
  const rootNodeId = "supervisor-root";
  const nodeId = `node-${itemId}`;
  const toolName = options.toolName ?? workflowToolNames.write.direct[0];
  const input = options.input ?? args;
  const detail = {
    id: itemId,
    type: "dynamic_tool",
    threadId: fixture.supervisorThreadId,
    runId,
    nodeId,
    providerThreadId,
    providerTurnId: "provider-turn-current",
    nativeItemRef: {driver: options.driver ?? "codex", nativeId: `native-${itemId}`, strength: "strong"},
    parentItemId: options.parentItemId === undefined ? null : options.parentItemId,
    ordinal: 100 + fixture.details.size,
    status: options.status ?? "completed",
    toolNonExecutionKind: null,
    toolName,
    input,
  };
  fixture.details.set(itemId, detail);
  fixture.projection.runs = [{id: runId, ordinal: options.appRunOrdinal ?? 1, status: options.runStatus ?? "completed", requestedAt: "2026-10-14T00:00:00.000Z",
    startedAt: "2026-10-14T00:00:00.000Z", completedAt: "2026-10-14T00:00:01.000Z", rootNodeId,
    threadId: fixture.supervisorThreadId, providerThreadId, ...(options.providerInstanceId ? {providerInstanceId: options.providerInstanceId} : {})}];
  fixture.projection.nodes = [
    {id: rootNodeId, kind: "root_turn", threadId: fixture.supervisorThreadId, runId, rootNodeId,
      providerThreadId, parentNodeId: null, status: options.rootNodeStatus ?? "completed"},
    {id: nodeId, kind: options.nodeKind ?? "dynamic_tool", threadId: fixture.supervisorThreadId, runId, rootNodeId,
      providerThreadId, parentNodeId: rootNodeId, status: options.toolNodeStatus ?? options.status ?? "completed"},
  ];
  fixture.projection.turnItems = [{id: itemId, type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId,
    nodeId, providerThreadId, parentItemId: null, ordinal: 100 + fixture.details.size, status: options.status ?? "completed", toolName,
    input: options.snapshotInput ?? (typeof input === "string" ? input : "snapshot-summary")}];
  return itemId;
};

const installMcpXEvidence = (fixture: Fixture, args: Record<string, unknown>, itemId?: string): string =>
  installEvidence(fixture, args, {...(itemId ? {itemId} : {}), toolName: workflowToolNames.mcpxCall[0],
    input: {name: workflowToolNames.write.mcpxTarget, arguments: args}});

const applyArgs = (fixture: Fixture, input: WorkflowApplyPatch) => {
  const current = fixture.workflows.list(fixture.projectId, fixture.mainThreadId).find(document => document.workflowId === input.workflowId);
  return {
  action: "apply",
  ...locator(fixture),
    input: {
      sourceBinding: fixture.sourceBinding,
      requirements: current?.threadId === fixture.mainThreadId ? fixture.proposal.requirements : [],
      issues: fixture.proposal.issues,
      ...input,
    },
  };
};

const proposalForDefinitions = (definitions: ProjectDefinitionSnapshot, plan: WorkflowPlanGroupInfo): WorkflowProposalInfo => {
  const context = proposalContextFromDefinitions(definitions);
  const normalized = validateWorkflowPlan({requirements: [], plan}, context);
  if (!normalized?.plan) throw new Error("test_workflow_proposal_invalid");
  return {
    status: "proposed",
    message: "A current source-bound workflow proposal.",
    workspaceRoot: definitions.workspaceRoot,
    revision: definitions.revision,
    globalRevision: definitions.globalRevision ?? null,
    ...normalized,
  };
};

const replaceCurrentProposal = (fixture: Fixture, proposalId: string, definitions: ProjectDefinitionSnapshot,
  proposal: WorkflowProposalInfo, options: {sourceHash?: string; definitionReview?: NonNullable<TaskRecord["definitionReview"]>} = {}): void => {
  const task = fixture.supervisors.task(fixture.mainThreadId);
  if (!task) throw new Error("test_current_task_missing");
  const sourceHash = options.sourceHash ?? task.sourceHash;
  fixture.supervisors.saveTask({...task, sourceHash, workflowProposalId: proposalId, workflow: proposal,
    definitionContext: proposalContextFromDefinitions(definitions), definitionSnapshot: definitions,
    ...(options.definitionReview ? {definitionReview: options.definitionReview} : {})});
  fixture.proposal = proposal;
  fixture.definitionReader.current = definitions;
  fixture.sourceBinding = {
    workspaceRoot: definitions.workspaceRoot,
    revision: definitions.revision,
    globalRevision: definitions.globalRevision ?? null,
    definitionsStatus: proposal.definitionsStatus,
    definitionsComplete: proposal.definitionsComplete,
    requirementsKnown: proposal.requirementsKnown,
    taskId: task.id,
    proposalId,
    sourceHash,
  };
};

test("unverified JSON stays pending without reserving an operation and a verified retry applies", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "forged-op", "Create a main workflow.");
    const forged = await fixture.controller.write(args);
    assert.equal(forged.status, "pending");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts").get()?.n), 0);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_evidence").get()?.n), 0);

    installEvidence(fixture, args);
    const applied = await fixture.controller.write(args);
    assert.equal(applied.status, "created");
    assert.ok(fixture.workflows.get(fixture.projectId, fixture.mainThreadId));
  } finally {await closeFixture(fixture);}
});

test("MCPX input unwrap is exact and the verified native item is stored with the mutation", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "mcpx-op", "Create through MCPX.");
    const itemId = installMcpXEvidence(fixture, args);
    const result = await fixture.controller.write(args);
    assert.equal(result.status, "created");
    const proof = fixture.guidance.db.prepare(
      "SELECT item_id,native_evidence,successful FROM supervisor_workflow_write_evidence WHERE operation_id=?",
    ).get("mcpx-op") as {item_id: string; native_evidence: string; successful: number} | undefined;
    assert.equal(proof?.item_id, itemId);
    assert.equal(proof?.successful, 1);
    const saved = JSON.parse(proof!.native_evidence) as {nativeInputCanonical: string; toolName: string};
    assert.equal(saved.toolName, workflowToolNames.mcpxCall[0]);
    assert.match(saved.nativeInputCanonical, /t3-supervisor-workflows__workflow_write/u);
  } finally {await closeFixture(fixture);}
});

test("AppRun order selects new-provider evidence ahead of older provider item ordinals", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "new-provider-evidence", "Use the current provider run.");
    const itemId = installEvidence(fixture, args, {itemId: "new-provider-item", runId: "app-run-new",
      providerThreadId: "provider-thread-new", appRunOrdinal: 44, snapshotInput: args});
    fixture.projection.runs.push({id: "app-run-old", ordinal: 43, status: "completed", requestedAt: "2026-10-13T00:00:00.000Z",
      startedAt: "2026-10-13T00:00:00.000Z", completedAt: "2026-10-13T00:00:01.000Z", rootNodeId: "old-root",
      threadId: fixture.supervisorThreadId, providerThreadId: "provider-thread-old"});
    for (let index = 0; index < 40; index++) fixture.projection.turnItems?.push({
      id: `old-provider-${index}`, type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId: "app-run-old",
      nodeId: `old-node-${index}`, providerThreadId: "provider-thread-old", ordinal: 600_000 + index,
      status: "completed", toolName: workflowToolNames.write.direct[0], input: "old provider summary",
    });
    assert.equal((await fixture.controller.write(args)).status, "created");
    assert.deepEqual(fixture.detailCalls, [itemId]);
  } finally {await closeFixture(fixture);}
});

test("complete snapshot inputs filter unrelated tools before detail RPCs", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "snapshot-prefilter", "Read only plausible native evidence.");
    const itemId = installEvidence(fixture, args, {itemId: "matching-snapshot-item", snapshotInput: args});
    for (let index = 0; index < 100; index++) fixture.projection.turnItems?.push({
      id: `unrelated-snapshot-${index}`, type: "dynamic_tool", threadId: fixture.supervisorThreadId,
      runId: "supervisor-run-current", nodeId: `unrelated-node-${index}`, providerThreadId: "provider-thread-current",
      ordinal: 1000 + index, status: "completed", toolName: workflowToolNames.write.direct[0],
      input: {...args, note: `unrelated-${index}`},
    });
    assert.equal((await fixture.controller.write(args)).status, "created");
    assert.deepEqual(fixture.detailCalls, [itemId]);
  } finally {await closeFixture(fixture);}
});

test("an oversized getTurnItem detail remains pending even when its snapshot arguments match", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "oversized-detail", "Do not authorize an oversized native detail.");
    const itemId = installEvidence(fixture, args, {itemId: "oversized-detail-item", snapshotInput: args});
    const detail = fixture.details.get(itemId) as Record<string, unknown>;
    detail.output = "x".repeat(280 * 1024);
    assert.equal((await fixture.controller.write(args)).status, "pending");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    assert.deepEqual(fixture.detailCalls, [itemId]);
  } finally {await closeFixture(fixture);}
});

test("a history of unrelated complete tool inputs causes no detail RPCs", async () => {
  const fixture = await makeFixture();
  try {
    const wanted = ensureArgs(fixture, "no-matching-snapshot", "Wait for a matching tool record.");
    const unrelated = ensureArgs(fixture, "unrelated-snapshot-only", "This is not the requested operation.");
    installEvidence(fixture, unrelated, {itemId: "unrelated-seed", snapshotInput: unrelated});
    for (let index = 0; index < 100; index++) fixture.projection.turnItems?.push({
      id: `unrelated-only-${index}`, type: "dynamic_tool", threadId: fixture.supervisorThreadId,
      runId: "supervisor-run-current", nodeId: `unrelated-only-node-${index}`, providerThreadId: "provider-thread-current",
      ordinal: 1000 + index, status: "completed", toolName: workflowToolNames.write.direct[0],
      input: {...unrelated, note: `not-the-current-input-${index}`},
    });
    assert.equal((await fixture.controller.write(wanted)).status, "pending");
    assert.deepEqual(fixture.detailCalls, []);
  } finally {await closeFixture(fixture);}
});

test("unrelated empty and rolled-back snapshot placeholders stay pending without detail lookups", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "wanted-current-evidence", "Only this exact call can authorize the write.");
    const other = ensureArgs(fixture, "stale-other-evidence", "This is a different request.");
    installEvidence(fixture, other, {itemId: "placeholder-seed", snapshotInput: other});
    fixture.projection.turnItems = [
      {id: "empty-placeholder", type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId: "supervisor-run-current",
        nodeId: "empty-node", providerThreadId: "provider-thread-current", ordinal: 900, status: "completed",
        toolName: workflowToolNames.write.direct[0], input: {}},
      {id: "stale-rolled-back", type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId: "supervisor-run-current",
        nodeId: "rolled-back-node", providerThreadId: "provider-thread-current", ordinal: 901, status: "rolled_back",
        toolName: workflowToolNames.write.direct[0], input: other},
    ];
    assert.equal((await fixture.controller.write(args)).status, "pending");
    assert.deepEqual(fixture.detailCalls, []);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
  } finally {await closeFixture(fixture);}
});

test("a delayed current record becomes verifiable after fresh projection polling", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "delayed-current-record", "Wait for this current native record.");
    const originalProjection = fixture.native.projection;
    let polls = 0;
    fixture.native.projection = async (threadId, signal) => {
      polls++;
      if (polls === 3) installEvidence(fixture, args, {itemId: "delayed-current-item", snapshotInput: "x".repeat(20 * 1024)});
      return originalProjection(threadId, signal);
    };
    const controller = new WorkflowWriteController({supervisors: fixture.supervisors, workflows: fixture.workflows,
      native: fixture.native, isEnabled: id => fixture.supervisors.enabled(id), maxEvidenceWaitMs: 500});
    assert.equal((await controller.write(args)).status, "created");
    assert.ok(polls >= 3);
    assert.deepEqual(fixture.detailCalls, ["delayed-current-item"]);
  } finally {await closeFixture(fixture);}
});

test("unchanged inspected detail is cached throughout the pending window", async () => {
  const fixture = await makeFixture();
  try {
    const requested = ensureArgs(fixture, "pending-current", "Wait for matching evidence.");
    const unrelated = ensureArgs(fixture, "pending-other", "This evidence has a different request.");
    const itemId = installEvidence(fixture, unrelated, {itemId: "unchanged-mismatch", snapshotInput: "x".repeat(20 * 1024)});
    const controller = new WorkflowWriteController({supervisors: fixture.supervisors, workflows: fixture.workflows,
      native: fixture.native, isEnabled: id => fixture.supervisors.enabled(id)});
    assert.equal((await controller.write(requested)).status, "pending");
    assert.deepEqual(fixture.detailCalls, [itemId]);
  } finally {await closeFixture(fixture);}
});

test("rolled-back runs, roots, and tool nodes cannot authorize an old matching tool item", async () => {
  for (const [label, state] of [
    ["run", {runStatus: "rolled_back"}],
    ["root", {rootNodeStatus: "rolled_back"}],
    ["tool-node", {toolNodeStatus: "rolled_back"}],
    ["tool-item", {status: "rolled_back"}],
  ] as const) {
    const fixture = await makeFixture();
    try {
      const args = ensureArgs(fixture, `rolled-back-${label}`, "Do not apply an action from rolled-back history.");
      installEvidence(fixture, args, state);
      const result = await fixture.controller.write(args);
      assert.equal(result.status, "denied", label);
      assert.match(result.status === "denied" ? result.reason : "", /rolled_back/u);
      assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
      assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts").get()?.n), 0);
    } finally {await closeFixture(fixture);}
  }
});

test("unsupported native drivers return a structured proof gap and keep workflow writes closed", async () => {
  for (const driver of ["claudeAgent", "future-provider"]) {
    const fixture = await makeFixture();
    try {
      const args = ensureArgs(fixture, `unsupported-driver-${driver}`, "Require a verified native source.");
      installEvidence(fixture, args, {driver});
      assert.deepEqual(await fixture.controller.write(args), {
        status: "denied", operationId: args.operationId, reason: "provider_write_proof_unverified", providerDriver: driver,
      });
      assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    } finally {await closeFixture(fixture);}
  }
  assert.match(workflowReadToolDefinition.description, /strong native item references/u);
  assert.match(workflowWriteToolDefinition.description, /sourceItemId/u);
  assert.deepEqual(workflowWriteDriverSupport("codex"), {driverKind: "codex", status: "verified"});
  assert.deepEqual(workflowWriteDriverSupport("claudeAgent"), {driverKind: "claudeAgent", status: "provider_write_proof_unverified"});
  assert.deepEqual(workflowWriteDriverSupport("future-provider"), {driverKind: "future-provider", status: "provider_write_proof_unverified"});
  assert.equal(workflowProviderDriverFromCatalog({providers: [{instanceId: "workspace-codex", driver: "codex"}]}, "workspace-codex"), "codex");
  assert.equal(workflowProviderDriverFromCatalog({providers: [{instanceId: "workspace-codex", driverKind: "codex"}]}, "workspace-codex"), null);
  assert.equal(workflowProviderDriverFromCatalog({providers: [
    {instanceId: "workspace-codex", driver: "codex"}, {instanceId: "workspace-codex", driver: "claudeAgent"},
  ]}, "workspace-codex"), null);
});

test("a live unsupported Supervisor driver reports the proof gap before any tool item is visible", async () => {
  const fixture = await makeFixture();
  try {
    const instanceId = "custom-claude-instance";
    fixture.projection.thread.modelSelection = {instanceId, model: "claude-sonnet", options: []};
    const resolved: string[] = [];
    fixture.native.resolveProviderDriver = async value => {resolved.push(value);return "claudeAgent";};
    fixture.projection.turnItems = [];
    const args = ensureArgs(fixture, "unsupported-before-item", "Report the provider proof gap explicitly.");
    assert.deepEqual(await fixture.controller.write(args), {
      status: "denied", operationId: args.operationId, reason: "provider_write_proof_unverified", providerDriver: "claudeAgent",
    });
    assert.deepEqual(resolved, [instanceId]);
    assert.deepEqual(fixture.detailCalls, []);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
  } finally {await closeFixture(fixture);}
});

test("a sole own-main active AppRun identifies its provider before a tool item is visible", async () => {
  const fixture = await makeFixture();
  try {
    const activeInstanceId = "active-claude-instance";
    fixture.projection.thread.modelSelection = {instanceId: "next-codex-selection", model: "gpt-6-luna", options: []};
    fixture.projection.runs = [{id: "active-claude-run", threadId: fixture.supervisorThreadId, providerThreadId: "active-provider-thread",
      providerInstanceId: activeInstanceId, ordinal: 9, status: "running", requestedAt: "2026-10-15T00:00:00.000Z",
      startedAt: "2026-10-15T00:00:01.000Z", completedAt: null, rootNodeId: "active-root"}];
    fixture.projection.nodes = [{id: "active-root", threadId: fixture.supervisorThreadId, runId: "active-claude-run",
      rootNodeId: "active-root", providerThreadId: "active-provider-thread", parentNodeId: null, kind: "root_turn", status: "running"}];
    fixture.projection.turnItems = [];
    const resolved: string[] = [];
    fixture.native.resolveProviderDriver = async value => {resolved.push(value);return value === activeInstanceId ? "claudeAgent" : "codex";};
    const args = ensureArgs(fixture, "unsupported-active-provider", "Report the active provider proof gap.");
    assert.deepEqual(await fixture.controller.write(args), {
      status: "denied", operationId: args.operationId, reason: "provider_write_proof_unverified", providerDriver: "claudeAgent",
    });
    assert.deepEqual(resolved, [activeInstanceId]);
    assert.deepEqual(fixture.detailCalls, []);
  } finally {await closeFixture(fixture);}
});

test("ambiguous own-main active AppRuns do not use the next thread selection for provider feedback", async () => {
  const fixture = await makeFixture();
  try {
    fixture.projection.thread.modelSelection = {instanceId: "next-claude-selection", model: "claude-sonnet", options: []};
    fixture.projection.runs = ["provider-a", "provider-b"].map((providerThreadId, index) => ({
      id: `active-run-${index}`, threadId: fixture.supervisorThreadId, providerThreadId, providerInstanceId: providerThreadId,
      ordinal: index + 1, status: "running", requestedAt: "2026-10-15T00:00:00.000Z", startedAt: "2026-10-15T00:00:01.000Z",
      completedAt: null, rootNodeId: `active-root-${index}`,
    }));
    fixture.projection.nodes = fixture.projection.runs.map(run => ({id: run.rootNodeId, threadId: fixture.supervisorThreadId,
      runId: run.id, rootNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, parentNodeId: null,
      kind: "root_turn", status: "running"}));
    fixture.projection.turnItems = [];
    const resolved: string[] = [];
    fixture.native.resolveProviderDriver = async value => {resolved.push(value);return "claudeAgent";};
    const args = ensureArgs(fixture, "ambiguous-active-provider", "Wait for attributable native proof.");
    assert.deepEqual(await fixture.controller.write(args), {
      status: "pending", operationId: args.operationId, reason: "native_evidence_not_visible", retryable: true,
    });
    assert.deepEqual(resolved, []);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
  } finally {await closeFixture(fixture);}
});

test("a custom provider instance mapped to Codex still needs exact native Codex evidence", async () => {
  const fixture = await makeFixture();
  try {
    const instanceId = "codex-run-instance";
    fixture.projection.thread.modelSelection = {instanceId: "claude-next-selection", model: "claude-sonnet", options: []};
    const resolved: string[] = [];
    fixture.native.resolveProviderDriver = async value => {resolved.push(value);return value === instanceId ? "codex" : "claudeAgent";};
    const args = ensureArgs(fixture, "custom-instance-exact-proof", "Use the exact submitted native input.");
    const itemId = installEvidence(fixture, args, {providerInstanceId: instanceId, runStatus: "running", status: "running"});
    assert.equal((await fixture.controller.write(args)).status, "created");
    assert.deepEqual(resolved, [instanceId]);
    assert.deepEqual(fixture.detailCalls, [itemId]);
  } finally {await closeFixture(fixture);}
});

test("an unknown live catalog grants nothing and leaves exact native proof as the only successful path", async () => {
  const pendingFixture = await makeFixture();
  try {
    pendingFixture.projection.thread.modelSelection = {instanceId: "catalog-unavailable-instance", model: "unknown-model", options: []};
    pendingFixture.native.resolveProviderDriver = async () => null;
    pendingFixture.projection.turnItems = [];
    const args = ensureArgs(pendingFixture, "unknown-catalog-empty", "Do not write without visible proof.");
    assert.deepEqual(await pendingFixture.controller.write(args), {
      status: "pending", operationId: args.operationId, reason: "native_evidence_not_visible", retryable: true,
    });
    assert.equal(pendingFixture.workflows.get(pendingFixture.projectId, pendingFixture.mainThreadId), null);
  } finally {await closeFixture(pendingFixture);}

  const exactFixture = await makeFixture();
  try {
    exactFixture.projection.thread.modelSelection = {instanceId: "catalog-unavailable-instance", model: "unknown-model", options: []};
    exactFixture.native.resolveProviderDriver = async () => null;
    const args = ensureArgs(exactFixture, "unknown-catalog-exact-proof", "Require the exact Codex item record.");
    const itemId = installEvidence(exactFixture, args, {driver: "codex", providerInstanceId: "catalog-unavailable-instance"});
    assert.equal((await exactFixture.controller.write(args)).status, "created");
    assert.deepEqual(exactFixture.detailCalls, [itemId]);
  } finally {await closeFixture(exactFixture);}
});

test("a child-thread tool record cannot authorize a write for the bound Supervisor", async () => {
  const fixture = await makeFixture();
  try {
    const childId = "helper-thread";
    fixture.threads.push(thread(childId, fixture.projectId, fixture.supervisorThreadId, "subagent", fixture.supervisorThreadId));
    const args = ensureArgs(fixture, "child-actor-op", "A helper cannot authorize this write.");
    installEvidence(fixture, args, {nodeKind: "subagent"});
    const result = await fixture.controller.write(args);
    assert.equal(result.status, "denied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    assert.deepEqual(fixture.projectionCalls, [fixture.supervisorThreadId]);
  } finally {await closeFixture(fixture);}
});

test("empty and truncated detail inputs stay pending without authorizing a write", async () => {
  for (const input of ["truncated native input", {}]) {
    const fixture = await makeFixture();
    try {
      const args = ensureArgs(fixture, `bad-input-${typeof input}`, "Reject incomplete evidence.");
      installEvidence(fixture, args, {input});
      const result = await fixture.controller.write(args);
      assert.equal(result.status, "pending");
      assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
      assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts").get()?.n), 0);
    } finally {await closeFixture(fixture);}
  }
});

test("write arguments above the inline-input bound are rejected before native reads", async () => {
  const fixture = await makeFixture();
  try {
    const input = {
      operationId: "oversized-apply",
      workflowId: "workflow-not-created",
      expectedRevision: 1,
      status: "planned",
      objective: "O".repeat(2000),
      plan: sequencePlan(Array.from({length: 120}, (_, index) => localStep(`Step ${index}`, "R".repeat(1000)))),
      note: "Reject before looking up native evidence.",
    };
    const args = applyArgs(fixture, input as WorkflowApplyPatch);
    assert.ok(workflowToolInputSize(args) > workflowToolInputMaxBytes);
    const result = await fixture.controller.write(args);
    assert.deepEqual(result, {status: "invalid", reason: "arguments_too_large"});
    assert.deepEqual(fixture.projectionCalls, []);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
  } finally {await closeFixture(fixture);}
});

test("disabled and replaced bindings deny old owner locators", async () => {
  const fixture = await makeFixture();
  try {
    const disabledArgs = ensureArgs(fixture, "disabled-op", "Do not write while disabled.");
    fixture.guidance.db.prepare("UPDATE meta SET value=? WHERE key=?").run(
      JSON.stringify({generation: 2, enabled: false, manual: true}), `supervisor_control:${JSON.stringify(fixture.projectId)}`);
    installEvidence(fixture, disabledArgs);
    assert.equal((await fixture.controller.write(disabledArgs)).status, "denied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);

    fixture.guidance.db.prepare("UPDATE meta SET value=? WHERE key=?").run(
      JSON.stringify({generation: 3, enabled: true, manual: true}), `supervisor_control:${JSON.stringify(fixture.projectId)}`);
    const replacement = {...fixture.binding, threadId: "replacement-supervisor", generation: fixture.binding.generation + 1, state: "ready" as const};
    fixture.supervisors.setBinding(replacement);
    assert.equal((await fixture.controller.write(disabledArgs)).status, "denied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
  } finally {await closeFixture(fixture);}
});

test("an incompatible main-scope version disables the default controller without resetting ownership", async () => {
  const fixture = await makeFixture();
  try {
    Object.defineProperty(fixture.supervisors, "scopeCompatible", {value: false});
    const controller = new WorkflowWriteController({
      supervisors: fixture.supervisors,
      workflows: fixture.workflows,
      native: fixture.native,
      maxEvidenceWaitMs: 0,
    });
    const args = ensureArgs(fixture, "incompatible-scope-op", "Do not write under an unsupported scope version.");
    installEvidence(fixture, args);
    assert.deepEqual(await controller.write(args), {
      status: "denied", operationId: "incompatible-scope-op", reason: "owner_not_current_ready_enabled",
    });
    assert.deepEqual(fixture.projectionCalls, []);
    assert.equal(fixture.supervisors.binding(fixture.projectId, fixture.mainThreadId)?.threadId, fixture.supervisorThreadId);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
  } finally {await closeFixture(fixture);}
});

test("an independent child with no verified path to the main cannot be linked", async () => {
  const fixture = await makeFixture();
  try {
    const child = thread("independent-child", "project-workflows", "independent-root", "subagent", "independent-root");
    fixture.threads.push(child);
    const args = {action: "link_child", ...locator(fixture), operationId: `link-${child.id}`, childThreadId: child.id,
      note: "Try linking this independent thread."};
    installEvidence(fixture, args);
    const result = await fixture.controller.write(args);
    assert.equal(result.status, "denied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, child.id), null);
  } finally {await closeFixture(fixture);}
});

test("a verified descendant stays in scope when its native project ID differs", async () => {
  const fixture = await makeFixture();
  try {
    const child = thread("foreign-project-child", "project-foreign", fixture.mainThreadId, "subagent", fixture.mainThreadId);
    fixture.threads.push(child);
    const ensure = ensureArgs(fixture, "foreign-project-main", "Create the owning main workflow.");
    installEvidence(fixture, ensure);
    assert.equal((await fixture.controller.write(ensure)).status, "created");

    const link = {action: "link_child", ...locator(fixture), operationId: "foreign-project-child-link",
      childThreadId: child.id, note: "Link the child through its exact parent lineage."};
    installEvidence(fixture, link);
    assert.equal((await fixture.controller.write(link)).status, "created");
    assert.ok(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, child.id));
  } finally {await closeFixture(fixture);}
});

test("a fork can own a workflow and subagent descendants in its own logical scope", async () => {
  const projectId = "project-workflows";
  const ancestor = thread("ancestor-main", projectId);
  const forkMain = thread("fork-main", projectId, ancestor.id, "fork", ancestor.id);
  const forkChild = thread("fork-child", projectId, forkMain.id, "subagent", ancestor.id);
  const fixture = await makeFixture(forkMain);
  try {
    fixture.threads.unshift(ancestor);
    fixture.threads.push(forkChild);
    const ensure = ensureArgs(fixture, "fork-main-draft", "Create the fork-owned workflow.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");

    const link = {action: "link_child", ...locator(fixture), operationId: "fork-child-link",
      childThreadId: forkChild.id, note: "Create a child workflow within this fork scope."};
    installEvidence(fixture, link);
    assert.equal((await fixture.controller.write(link)).status, "created");

    const read = await fixture.controller.read({...locator(fixture), limit: 10});
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    assert.deepEqual(read.lineage.map(item => item.threadId), [forkMain.id, forkChild.id]);
    assert.ok(fixture.workflows.get(projectId, forkMain.id, forkChild.id));
  } finally {await closeFixture(fixture);}
});

test("an ancestor owner cannot link a fork's subagent descendant", async () => {
  const fixture = await makeFixture();
  try {
    const forkMain = thread("independent-fork", fixture.projectId, fixture.mainThreadId, "fork", fixture.mainThreadId);
    const forkChild = thread("fork-subagent", fixture.projectId, forkMain.id, "subagent", fixture.mainThreadId);
    fixture.threads.push(forkMain, forkChild);
    const args = {action: "link_child", ...locator(fixture), operationId: "ancestor-cross-fork-link",
      childThreadId: forkChild.id, note: "This descendant belongs to the fork owner."};
    installEvidence(fixture, args);
    assert.deepEqual(await fixture.controller.write(args), {
      status: "denied", operationId: "ancestor-cross-fork-link", reason: "child_not_current_native_descendant",
    });
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, forkChild.id), null);
  } finally {await closeFixture(fixture);}
});

test("successful exact replays survive projection windowing and operation ID reuse conflicts", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "replay-op", "Create once.");
    installEvidence(fixture, args);
    const created = await fixture.controller.write(args);
    assert.equal(created.status, "created");
    fixture.projection.turnItems = [];
    const replay = await fixture.controller.write(args);
    assert.deepEqual(replay, created);
    const reused = await fixture.controller.write({...args, note: "Different input under the same operation ID."});
    assert.deepEqual(reused, {status: "conflict", operationId: "replay-op", reason: "operation_id_reused", currentRevision: null});
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.evidence.length, 1);
  } finally {await closeFixture(fixture);}
});

test("the same edit operation ID is isolated across Supervisor owners", async () => {
  const fixture = await makeFixture();
  try {
    const firstArgs = ensureArgs(fixture, "shared-edit-id", "Create the first owner's draft.");
    installEvidence(fixture, firstArgs);
    const first = await fixture.controller.write(firstArgs);
    assert.equal(first.status, "created");

    const secondMain = thread("second-main-workflows", fixture.projectId);
    const secondReserved = fixture.supervisors.reserve(fixture.projectId, secondMain.id, "Second main", defaultSupervisorModel, 1, 1);
    const secondBinding = {...secondReserved, state: "ready" as const};
    fixture.supervisors.setBinding(secondBinding);
    const secondProjection = makeProjection(secondBinding.threadId, fixture.projectId);
    fixture.projections.set(secondBinding.threadId, secondProjection);
    fixture.threads.push(secondMain, thread(secondBinding.threadId, fixture.projectId));
    fixture.mainThreadId = secondMain.id;
    fixture.supervisorThreadId = secondBinding.threadId;
    fixture.binding = secondBinding;
    fixture.owner = {projectId: fixture.projectId, mainThreadId: secondMain.id, supervisorThreadId: secondBinding.threadId,
      bindingGeneration: secondBinding.generation};
    fixture.projection = secondProjection;

    const secondArgs = ensureArgs(fixture, "shared-edit-id", "Create the second owner's draft.");
    installEvidence(fixture, secondArgs);
    const second = await fixture.controller.write(secondArgs);
    assert.equal(second.status, "created");
    if (first.status !== "created" || second.status !== "created") return;
    assert.notEqual(first.workflowId, second.workflowId);
    assert.equal(Number(fixture.guidance.db.prepare(
      "SELECT count(*) AS n FROM supervisor_workflow_write_receipts WHERE operation_id=? AND operation_namespace='edit'",
    ).get("shared-edit-id")?.n), 2);
  } finally {await closeFixture(fixture);}
});

test("apply uses owner-scoped lookup and revision CAS without dropping contributors", async () => {
  const fixture = await makeFixture();
  try {
    const mainArgs = ensureArgs(fixture, "cas-create", "Create a workflow before editing.");
    installEvidence(fixture, mainArgs);
    const created = await fixture.controller.write(mainArgs);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const input: WorkflowApplyPatch = {
      operationId: "cas-apply",
      workflowId: created.workflowId,
      expectedRevision: created.revision,
      status: "planned",
      objective: "Track the export workflow.",
      plan: sequencePlan([localStep("Inspect exporter", "Find the current path.", [fixture.mainThreadId])]),
      note: "Add the first implementation step.",
    };
    const args = applyArgs(fixture, input);
    installEvidence(fixture, args);
    const applied = await fixture.controller.write(args);
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(mainStep(current.plan)?.contributorThreadIds[0], fixture.mainThreadId);

    const staleInput = {...input, operationId: "cas-stale", expectedRevision: 1, plan: current.plan!, note: "A stale revision."};
    const staleArgs = applyArgs(fixture, staleInput);
    installEvidence(fixture, staleArgs);
    const stale = await fixture.controller.write(staleArgs);
    assert.deepEqual(stale, {status: "conflict", operationId: "cas-stale", reason: "revision", currentRevision: 2});
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, 2);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts WHERE operation_id='cas-stale'").get()?.n), 0);
  } finally {await closeFixture(fixture);}
});

test("apply requires a fresh definition pin that still matches the current task proposal", async () => {
  const fixture = await makeFixture();
  try {
    const ensure = ensureArgs(fixture, "pin-create", "Create a draft before applying a pinned plan.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const input: WorkflowApplyPatch = {
      operationId: "pin-stale-source",
      workflowId: created.workflowId,
      expectedRevision: created.revision,
      plan: sequencePlan([localStep("Inspect source", "Use the task's pinned definitions.")]),
      note: "Reject the stale source version.",
    };
    const args = applyArgs(fixture, input);
    fixture.definitionReader.current = {...fixture.definitionReader.current, revision: "definition-revision-2"};
    installEvidence(fixture, args);
    assert.deepEqual(await fixture.controller.write(args), {
      status: "invalid", operationId: "pin-stale-source", reason: "definition_source_changed_or_is_not_current",
    });
    assert.equal(fixture.definitionReader.calls, 1);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, 1);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts WHERE operation_id='pin-stale-source'").get()?.n), 0);

    fixture.definitionReader.current = {...fixture.definitionReader.current, revision: fixture.proposal.revision!};
    fixture.definitionReader.fail = true;
    const unavailable = {...input, operationId: "pin-unavailable-source"};
    const unavailableArgs = applyArgs(fixture, unavailable);
    installEvidence(fixture, unavailableArgs);
    assert.deepEqual(await fixture.controller.write(unavailableArgs), {
      status: "unavailable", operationId: "pin-unavailable-source", reason: "definition_source_read_unavailable",
    });
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, 1);
  } finally {await closeFixture(fixture);}
});

test("an unaccepted proposal can omit an optional fixed workflow on its first live apply", async () => {
  const fixture = await makeFixture();
  try {
    const definitions: ProjectDefinitionSnapshot = {
      ...fixture.definitionReader.current,
      steps: [{id: "optional-review-step", name: "Review evidence", description: "Check the supporting evidence.",
        origin: "project", path: ".t3-supervisor/steps/review-evidence.md", sourceId: "project:review-evidence"}],
      workflows: [{id: "optional-fixed-review", name: "Fixed review", description: "Keep this sequence intact when selected.", fixed: true,
        sequence: [{step: "optional-review-step"}], origin: "project", path: ".t3-supervisor/workflows/fixed-review.md", sourceId: "project:fixed-review"}],
    };
    const proposal = proposalForDefinitions(definitions, sequencePlan([
      localStep("Task outcome", "Complete the current request."),
      {kind: "workflow", definitionId: "optional-fixed-review", reason: "Use the review workflow if it fits this task."},
    ]));
    replaceCurrentProposal(fixture, "proposal-with-optional-fixed", definitions, proposal);

    const ensure = ensureArgs(fixture, "optional-fixed-create", "Create a negotiable draft before editing its first plan.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const apply = applyArgs(fixture, {operationId: "optional-fixed-omit", workflowId: created.workflowId,
      expectedRevision: created.revision, plan: sequencePlan([
        localStep("Current task outcome", "Complete the interpreted task with a fresh plan occurrence."),
      ]), note: "Choose a plan without the optional fixed review workflow."});
    installEvidence(fixture, apply);
    const result = await fixture.controller.write(apply);
    assert.equal(result.status, "applied", JSON.stringify(result));
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId);
    assert.ok(current);
    assert.equal(planEntities(current.plan).some(node => node.kind === "workflow" && node.definitionId === "optional-fixed-review"), false);
    assert.equal(current.sourceBinding?.sourceHash, fixture.sourceBinding.sourceHash);
  } finally {await closeFixture(fixture);}
});

test("an unchanged-source accepted fixed workflow survives when the mutable plan has diverged", async () => {
  const fixture = await makeFixture();
  try {
    const definitions: ProjectDefinitionSnapshot = {
      ...fixture.definitionReader.current,
      steps: [{id: "accepted-review-step", name: "Review evidence", description: "Check the accepted evidence trail.",
        origin: "project", path: ".t3-supervisor/steps/accepted-review.md", sourceId: "project:accepted-review-step"}],
      workflows: [{id: "accepted-fixed-review", name: "Accepted fixed review", description: "Keep the accepted review sequence intact.", fixed: true,
        sequence: [{step: "accepted-review-step"}], origin: "project", path: ".t3-supervisor/workflows/accepted-review.md", sourceId: "project:accepted-fixed-review"}],
    };
    const acceptedProposal = proposalForDefinitions(definitions, sequencePlan([
      localStep("Accepted task outcome", "Complete the task that was reviewed."),
      {kind: "workflow", definitionId: "accepted-fixed-review", reason: "Include the fixed review in the accepted plan."},
    ]));
    replaceCurrentProposal(fixture, "proposal-accepted-fixed", definitions, acceptedProposal);
    const accepted: WorkflowAgreementImport = {
      taskId: "task-current",
      sourceThreadId: fixture.mainThreadId,
      sourceRunId: "source-run-current",
      sourceMessageId: "source-message-current",
      sourceHash: fixture.sourceBinding.sourceHash,
      objective: "Complete the current project task.",
      agreement: {
        status: "agreed",
        message: "The operative Supervisor accepted the fixed review plan.",
        proposalId: "proposal-accepted-fixed",
        agreedAt: Date.now(),
        supervisorMessageId: "accepted-fixed-supervisor-message",
        agentMessageId: "accepted-fixed-agent-message",
        workflow: acceptedProposal,
      },
    };
    const imported = fixture.supervisors.store.transaction(() =>
      fixture.workflows.importAcceptedAgreementInTransaction(fixture.owner, accepted, Date.now()));
    assert.equal(imported.status, "applied");
    const acceptedDocument = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(acceptedDocument.acceptedAgreements.length, 1);

    const draftProposal = proposalForDefinitions(definitions,
      sequencePlan([localStep("Mutable live draft", "A later same-source plan can evolve around accepted work.")]));
    replaceCurrentProposal(fixture, "proposal-new-same-source", definitions, draftProposal);
    const diverged = {...acceptedDocument, revision: acceptedDocument.revision + 1, currentAgreementKey: null,
      plan: draftProposal.plan, updatedAt: Date.now()};
    fixture.guidance.db.prepare("UPDATE supervisor_workflow_state SET revision=?,document=?,updated_at=? WHERE workflow_id=?")
      .run(diverged.revision, JSON.stringify(diverged), diverged.updatedAt, diverged.workflowId);

    const apply = applyArgs(fixture, {operationId: "accepted-fixed-omit", workflowId: diverged.workflowId,
      expectedRevision: diverged.revision, plan: sequencePlan([
        localStep("Fresh same-source plan", "Keep the task negotiable while preserving accepted fixed work."),
      ]), note: "Attempt to remove an accepted fixed occurrence on the unchanged source."});
    installEvidence(fixture, apply);
    assert.deepEqual(await fixture.controller.write(apply), {
      status: "invalid", operationId: "accepted-fixed-omit", reason: "pinned_definition_context_mismatch",
    });
    const retained = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(retained.revision, diverged.revision);
    assert.equal(retained.acceptedAgreements[0]?.plan?.nodes.some(node => node.kind === "workflow" && node.definitionId === "accepted-fixed-review"), true);
    assert.equal(planEntities(retained.plan).some(node => node.kind === "workflow" && node.definitionId === "accepted-fixed-review"), false);

    const editedSourceHash = fingerprint("The accepted task request was edited and reinterpreted.");
    const editedProposal = proposalForDefinitions(definitions,
      sequencePlan([localStep("Edited task outcome", "Reassess the edited task request.")]));
    replaceCurrentProposal(fixture, "proposal-edited-after-acceptance", definitions, editedProposal, {sourceHash: editedSourceHash});
    const reconsider = applyArgs(fixture, {operationId: "accepted-fixed-release-after-source-edit", workflowId: diverged.workflowId,
      expectedRevision: diverged.revision, plan: sequencePlan([
        localStep("Reinterpreted task outcome", "Use a new plan occurrence for the edited source."),
      ]), note: "Reconsider fixed commitments after the operative task source changed."});
    installEvidence(fixture, reconsider);
    const reconsidered = await fixture.controller.write(reconsider);
    assert.equal(reconsidered.status, "applied", JSON.stringify(reconsidered));
    const updated = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(updated.sourceBinding?.sourceHash, editedSourceHash);
    assert.equal(updated.acceptedAgreements.length, 1, "the old acceptance remains historical evidence");
    assert.equal(planEntities(updated.plan).some(node => node.kind === "workflow" && node.definitionId === "accepted-fixed-review"), false);
  } finally {await closeFixture(fixture);}
});

test("a same-source accepted TaskRecord plan is protected when live agreement import is absent", async () => {
  const fixture = await makeFixture();
  try {
    const definitions: ProjectDefinitionSnapshot = {
      ...fixture.definitionReader.current,
      steps: [{id: "task-record-review-step", name: "Review result", description: "Check the accepted result.",
        origin: "project", path: ".t3-supervisor/steps/task-record-review.md", sourceId: "project:task-record-review-step"}],
      workflows: [{id: "task-record-fixed-review", name: "Accepted task review", description: "Keep the accepted review sequence intact.", fixed: true,
        sequence: [{step: "task-record-review-step"}], origin: "project", path: ".t3-supervisor/workflows/task-record-review.md", sourceId: "project:task-record-fixed-review"}],
    };
    const acceptedProposal = proposalForDefinitions(definitions, sequencePlan([
      localStep("Accepted task", "Complete the accepted request."),
      {kind: "workflow", definitionId: "task-record-fixed-review", reason: "Include the fixed review in the accepted proposal."},
    ]));
    const currentProposal = proposalForDefinitions(definitions,
      sequencePlan([localStep("Current task", "Keep the current unaccepted proposal flexible.")]));
    replaceCurrentProposal(fixture, "proposal-current-without-fixed", definitions, currentProposal);

    const ensure = ensureArgs(fixture, "task-record-fixed-create", "Create an empty draft before live agreement import.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const task = fixture.supervisors.task(fixture.mainThreadId);
    assert.ok(task);
    fixture.supervisors.saveTask({...task, agreement: {
      status: "agreed",
      message: "The accepted plan is retained in task history.",
      proposalId: "proposal-task-record-accepted",
      agreedAt: Date.now(),
      supervisorMessageId: "task-record-agreement-supervisor-message",
      agentMessageId: "task-record-agreement-agent-message",
      workflow: acceptedProposal,
    }, agreementSourceHash: task.sourceHash, updatedAt: Date.now()});
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.acceptedAgreements.length, 0,
      "the accepted TaskRecord is the only durable agreement evidence in this case");

    const removeAccepted = applyArgs(fixture, {operationId: "task-record-fixed-drop-same-source", workflowId: created.workflowId,
      expectedRevision: created.revision, plan: sequencePlan([
        localStep("Current task outcome", "Use a fresh local occurrence for the current proposal."),
      ]), note: "Try to remove a same-source accepted fixed workflow before it has a live import."});
    installEvidence(fixture, removeAccepted);
    assert.deepEqual(await fixture.controller.write(removeAccepted), {
      status: "invalid", operationId: "task-record-fixed-drop-same-source", reason: "pinned_definition_context_mismatch",
    });

    const editedSourceHash = fingerprint("The task request changed after its accepted agreement.");
    const editedProposal = proposalForDefinitions(definitions,
      sequencePlan([localStep("Edited task", "Reinterpret the edited request.")]));
    replaceCurrentProposal(fixture, "proposal-edited-without-fixed", definitions, editedProposal, {sourceHash: editedSourceHash});
    const releaseAccepted = applyArgs(fixture, {operationId: "task-record-fixed-release-after-source-edit", workflowId: created.workflowId,
      expectedRevision: created.revision, plan: sequencePlan([
        localStep("Reinterpreted task outcome", "Use a new occurrence for the edited task source."),
      ]), note: "Release the old accepted fixed workflow for the edited operative source."});
    installEvidence(fixture, releaseAccepted);
    const released = await fixture.controller.write(releaseAccepted);
    assert.equal(released.status, "applied", JSON.stringify(released));
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(current.sourceBinding?.sourceHash, editedSourceHash);
    assert.equal(current.acceptedAgreements.length, 0);
    assert.equal(planEntities(current.plan).some(node => node.kind === "workflow" && node.definitionId === "task-record-fixed-review"), false);
  } finally {await closeFixture(fixture);}
});

test("same task and definition pin preserve added fixed workflows across proposal IDs but permit an adopted new pin", async () => {
  const fixture = await makeFixture();
  try {
    const firstDefinitions: ProjectDefinitionSnapshot = {
      ...fixture.definitionReader.current,
      steps: [{id: "fixed-review-step", name: "Review evidence", description: "Check the complete evidence trail.",
        origin: "project", path: ".t3-supervisor/steps/review-evidence.md", sourceId: "project:review-evidence"}],
      workflows: [{id: "fixed-review", name: "Fixed review", description: "Preserve the original review sequence.", fixed: true,
        sequence: [{step: "fixed-review-step"}], origin: "project", path: ".t3-supervisor/workflows/fixed-review.md", sourceId: "project:fixed-review"}],
    };
    const initialProposal = proposalForDefinitions(firstDefinitions,
      sequencePlan([localStep("Baseline review", "Review the current task context.")]));
    replaceCurrentProposal(fixture, "proposal-current", firstDefinitions, initialProposal);

    const ensure = ensureArgs(fixture, "fixed-pin-create", "Create a draft before editing fixed workflow content.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const firstApply = applyArgs(fixture, {operationId: "fixed-pin-add", workflowId: created.workflowId,
      expectedRevision: created.revision, plan: sequencePlan([
        localStep("Baseline review", "Review the current task context."),
        {kind: "workflow", definitionId: "fixed-review", reason: "Include the fixed review support workflow."},
      ]), note: "Add the fixed review support workflow to this task plan."});
    installEvidence(fixture, firstApply);
    const firstResult = await fixture.controller.write(firstApply);
    assert.equal(firstResult.status, "applied", JSON.stringify(firstResult));
    if (firstResult.status !== "applied") return;
    const afterFirst = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const fixedOccurrence = planEntities(afterFirst.plan).find(node => node.kind === "workflow" && node.definitionId === "fixed-review");
    assert.ok(fixedOccurrence?.kind === "workflow" && fixedOccurrence.fixed === true);

    const nextProposal = proposalForDefinitions(firstDefinitions,
      sequencePlan([localStep("Revised proposal", "Refine the same task scope.")]));
    replaceCurrentProposal(fixture, "proposal-current-revised", firstDefinitions, nextProposal);
    const omitFixed = applyArgs(fixture, {operationId: "fixed-pin-drop-same-source", workflowId: created.workflowId,
      expectedRevision: afterFirst.revision, plan: sequencePlan([localStep("Revised proposal", "Refine the same task scope.")]),
      note: "Try to drop a fixed occurrence under a new proposal ID for the same task and source pin."});
    installEvidence(fixture, omitFixed);
    assert.deepEqual(await fixture.controller.write(omitFixed), {
      status: "invalid", operationId: "fixed-pin-drop-same-source", reason: "pinned_definition_context_mismatch",
    });
    const retained = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(retained.revision, afterFirst.revision);
    assert.ok(planEntities(retained.plan).some(node => node.kind === "workflow" && node.definitionId === "fixed-review" && node.fixed === true));

    const replacementDefinitions: ProjectDefinitionSnapshot = {
      ...firstDefinitions,
      revision: "definition-revision-2",
      steps: [],
      workflows: [],
    };
    const replacementProposal = proposalForDefinitions(replacementDefinitions,
      sequencePlan([localStep("Reviewed replacement", "Use the newly authorized definition revision.")]));
    replaceCurrentProposal(fixture, "proposal-authorized-replacement", replacementDefinitions, replacementProposal, {definitionReview: {
      status: "authorized",
      message: "The user explicitly authorized this complete source revision.",
      expectedRevision: firstDefinitions.revision!,
      observedRevision: replacementDefinitions.revision,
      supervisorMessageId: "definition-review-supervisor-message",
      userMessageIds: ["definition-review-user-message"],
      updatedAt: Date.now(),
    }});
    const replaceOldPin = applyArgs(fixture, {operationId: "fixed-pin-replace-reviewed-source", workflowId: created.workflowId,
      expectedRevision: retained.revision, plan: sequencePlan([localStep("Reviewed replacement", "Use the newly authorized definition revision.")]),
      note: "Replace the old plan under the reviewed current definition revision."});
    installEvidence(fixture, replaceOldPin);
    const replacementResult = await fixture.controller.write(replaceOldPin);
    assert.equal(replacementResult.status, "applied", JSON.stringify(replacementResult));
    const replaced = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(replaced.sourceBinding?.revision, "definition-revision-2");
    assert.equal(replaced.sourceBinding?.proposalId, "proposal-authorized-replacement");
    assert.equal(planEntities(replaced.plan).some(node => node.kind === "workflow" && node.definitionId === "fixed-review"), false);
    assert.ok(replaced.evidence.some(item => item.kind === "node_removed" && item.targetNodeId === fixedOccurrence.nodeId));
  } finally {await closeFixture(fixture);}
});

test("a reinterpreted source hash releases fixed commitments from the prior task source", async () => {
  const fixture = await makeFixture();
  try {
    const definitions: ProjectDefinitionSnapshot = {
      ...fixture.definitionReader.current,
      steps: [{id: "source-fixed-step", name: "Review prior source", description: "Keep the prior task's fixed review complete.",
        origin: "project", path: ".t3-supervisor/steps/source-review.md", sourceId: "project:source-review"}],
      workflows: [{id: "source-fixed-review", name: "Prior source review", description: "Review the original task source.", fixed: true,
        sequence: [{step: "source-fixed-step"}], origin: "project", path: ".t3-supervisor/workflows/source-review.md", sourceId: "project:source-fixed-review"}],
    };
    const initialProposal = proposalForDefinitions(definitions,
      sequencePlan([localStep("Original task", "Implement the original task request.")]));
    replaceCurrentProposal(fixture, "proposal-original-source", definitions, initialProposal);
    const ensure = ensureArgs(fixture, "source-pin-main-create", "Create a draft before adding fixed review support.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const initialPlan = applyArgs(fixture, {operationId: "source-pin-add-fixed", workflowId: created.workflowId,
      expectedRevision: created.revision, plan: sequencePlan([
        localStep("Original task", "Implement the original task request."),
        {kind: "workflow", definitionId: "source-fixed-review", reason: "Include the fixed review for this source."},
      ]), note: "Add the fixed workflow to the original interpreted task."});
    installEvidence(fixture, initialPlan);
    assert.equal((await fixture.controller.write(initialPlan)).status, "applied");
    const committed = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const oldFixedNode = planEntities(committed.plan).find(node => node.kind === "workflow" && node.definitionId === "source-fixed-review");
    assert.ok(oldFixedNode?.kind === "workflow" && oldFixedNode.fixed === true);

    const revisedProposal = proposalForDefinitions(definitions,
      sequencePlan([localStep("Edited task", "Reinterpret the edited user request.")]));
    const editedSourceHash = fingerprint("Complete the edited project task.");
    replaceCurrentProposal(fixture, "proposal-edited-source", definitions, revisedProposal, {sourceHash: editedSourceHash});
    const editedSourcePlan = applyArgs(fixture, {operationId: "source-pin-replace-edited-task", workflowId: created.workflowId,
      expectedRevision: committed.revision, plan: sequencePlan([localStep("Edited task", "Reinterpret the edited user request.")]),
      note: "Use the fresh task interpretation after the operative source message changed."});
    installEvidence(fixture, editedSourcePlan);
    const replaced = await fixture.controller.write(editedSourcePlan);
    assert.equal(replaced.status, "applied", JSON.stringify(replaced));
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(current.sourceBinding?.sourceHash, editedSourceHash);
    assert.equal(planEntities(current.plan).some(node => node.kind === "workflow" && node.definitionId === "source-fixed-review"), false);
    assert.ok(current.evidence.some(item => item.kind === "node_removed" && item.targetNodeId === oldFixedNode.nodeId));
  } finally {await closeFixture(fixture);}
});

test("child fixed workflows survive a new same-pin main proposal without inheriting main requirements", async () => {
  const fixture = await makeFixture();
  try {
    const definitions: ProjectDefinitionSnapshot = {
      ...fixture.definitionReader.current,
      steps: [{id: "child-fixed-step", name: "Review child output", description: "Inspect the child contribution.",
        origin: "project", path: ".t3-supervisor/steps/child-review.md", sourceId: "project:child-review"}],
      workflows: [{id: "child-fixed-review", name: "Child fixed review", description: "Keep the child review complete.", fixed: true,
        sequence: [{step: "child-fixed-step"}], origin: "project", path: ".t3-supervisor/workflows/child-review.md", sourceId: "project:child-fixed-review"}],
    };
    const initialProposal = proposalForDefinitions(definitions,
      sequencePlan([localStep("Main proposal", "Keep the parent task context.")]));
    replaceCurrentProposal(fixture, "proposal-child-current", definitions, initialProposal);

    const ensure = ensureArgs(fixture, "child-fixed-main-create", "Create the main draft for child workflow testing.");
    installEvidence(fixture, ensure);
    const main = await fixture.controller.write(ensure);
    assert.equal(main.status, "created");
    if (main.status !== "created") return;
    const childThread = thread("fixed-review-child", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    fixture.threads.push(childThread);
    const link = {action: "link_child", ...locator(fixture), operationId: "child-fixed-link", childThreadId: childThread.id,
      note: "Link the verified child under the main draft."};
    installEvidence(fixture, link);
    const linked = await fixture.controller.write(link);
    assert.equal(linked.status, "created");
    if (linked.status !== "created") return;

    const firstChildPlan = applyArgs(fixture, {operationId: "child-fixed-add", workflowId: linked.workflowId,
      expectedRevision: linked.revision, plan: sequencePlan([
        localStep("Implement child contribution", "Build the assigned part."),
        {kind: "workflow", definitionId: "child-fixed-review", reason: "Retain the fixed child review."},
      ]), note: "Add a fixed workflow only to this child plan."});
    installEvidence(fixture, firstChildPlan);
    const firstChildResult = await fixture.controller.write(firstChildPlan);
    assert.equal(firstChildResult.status, "applied", JSON.stringify(firstChildResult));
    if (firstChildResult.status !== "applied") return;
    const afterFirst = fixture.workflows.get(fixture.projectId, fixture.mainThreadId, childThread.id)!;
    const fixedNode = planEntities(afterFirst.plan).find(node => node.kind === "workflow" && node.definitionId === "child-fixed-review");
    assert.ok(fixedNode?.kind === "workflow" && fixedNode.fixed === true);

    const revisedProposal = proposalForDefinitions(definitions,
      sequencePlan([localStep("Main task revised", "Reassess the parent task without copying child policy." )]));
    replaceCurrentProposal(fixture, "proposal-child-current-revised", definitions, revisedProposal);
    const omitChildFixed = applyArgs(fixture, {operationId: "child-fixed-drop-same-source", workflowId: linked.workflowId,
      expectedRevision: afterFirst.revision, plan: sequencePlan([localStep("Revised child contribution", "Keep the child subflow flexible.")]),
      note: "Do not erase child fixed commitments when the main proposal ID changes."});
    installEvidence(fixture, omitChildFixed);
    assert.deepEqual(await fixture.controller.write(omitChildFixed), {
      status: "invalid", operationId: "child-fixed-drop-same-source", reason: "pinned_definition_context_mismatch",
    });
    const retained = fixture.workflows.get(fixture.projectId, fixture.mainThreadId, childThread.id)!;
    assert.equal(retained.revision, afterFirst.revision);
    assert.ok(planEntities(retained.plan).some(node => node.kind === "workflow" && node.definitionId === "child-fixed-review" && node.fixed === true));
  } finally {await closeFixture(fixture);}
});

test("exact apply receipt replay survives a later definition revision change", async () => {
  const fixture = await makeFixture();
  try {
    const ensure = ensureArgs(fixture, "pin-replay-create", "Create a draft before applying a pinned plan.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const args = applyArgs(fixture, {
      operationId: "pin-replay-apply",
      workflowId: created.workflowId,
      expectedRevision: created.revision,
      plan: sequencePlan([localStep("Review source", "Keep this committed edit durable.")]),
      note: "Apply this source-bound edit once.",
    });
    installEvidence(fixture, args);
    const applied = await fixture.controller.write(args);
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    const definitionReads = fixture.definitionReader.calls;
    fixture.definitionReader.current = {...fixture.definitionReader.current, revision: "definition-revision-2"};
    const currentTask = fixture.supervisors.task(fixture.mainThreadId)!;
    fixture.supervisors.saveTask({...currentTask, sourceHash: fingerprint("The source changed after this receipt was recorded.")});
    fixture.projection.runs = [];
    fixture.projectionCalls.length = 0;
    assert.deepEqual(await fixture.controller.write(args), applied);
    assert.equal(fixture.definitionReader.calls, definitionReads);
    assert.deepEqual(fixture.projectionCalls, []);
  } finally {await closeFixture(fixture);}
});

test("a partial apply keeps every omitted plan field from the current CAS revision", async () => {
  const fixture = await makeFixture();
  try {
    const ensure = ensureArgs(fixture, "partial-create", "Create a draft before a partial edit.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const full: WorkflowApplyPatch = {
      operationId: "partial-initial-plan",
      workflowId: created.workflowId,
      expectedRevision: created.revision,
      status: "planned",
      objective: "Keep the original objective.",
      plan: sequencePlan([localStep("Inspect current flow", "Keep this step intact.", [fixture.mainThreadId])]),
      note: "Record the complete starting plan.",
    };
    const fullArgs = applyArgs(fixture, full);
    installEvidence(fixture, fullArgs);
    assert.equal((await fixture.controller.write(fullArgs)).status, "applied");
    const before = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;

    const partial = {operationId: "partial-objective-only", workflowId: before.workflowId,
      expectedRevision: before.revision, objective: "Change only the objective.", note: "Leave other fields unchanged."};
    const partialArgs = applyArgs(fixture, partial);
    installEvidence(fixture, partialArgs);
    assert.equal((await fixture.controller.write(partialArgs)).status, "applied");
    const after = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(after.objective, "Change only the objective.");
    assert.equal(after.status, before.status);
    assert.deepEqual(after.requirements, before.requirements);
    assert.deepEqual(after.plan, before.plan);
    assert.equal(after.revision, before.revision + 1);
  } finally {await closeFixture(fixture);}
});

test("a nested plan larger than 185 KiB remains editable within the native tool bounds", async () => {
  const fixture = await makeFixture();
  try {
    const ensure = ensureArgs(fixture, "large-plan-create", "Create a draft for the imported plan.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const largeNodes = Array.from({length: 25}, (_, index) => ({
      ...localStep(`Step ${index}`, `Description ${"S".repeat(6650)}`, [fixture.mainThreadId]),
      reason: `R${"T".repeat(650)}`,
    }));
    const input: WorkflowApplyPatch = {
      operationId: "large-plan-apply",
      workflowId: created.workflowId,
      expectedRevision: created.revision,
      status: "planned",
      objective: `Import the plan ${"O".repeat(900)}`,
      plan: sequencePlan(largeNodes),
      note: "Import the complete nested plan without dropping node detail.",
    };
    const args = applyArgs(fixture, input);
    const bytes = workflowToolInputSize(args);
    assert.ok(bytes > 16 * 1024);
    assert.ok(bytes > 185 * 1024, String(bytes));
    assert.ok(bytes < workflowToolInputMaxBytes);
    fixture.detailCalls.length = 0;
    installEvidence(fixture, args, {itemId: "large-plan-item", snapshotInput: "x".repeat(20 * 1024)});
    const detailBytes = Buffer.byteLength(JSON.stringify(fixture.details.get("large-plan-item")), "utf8");
    assert.ok(detailBytes > 185 * 1024);
    assert.ok(detailBytes < workflowTurnItemDetailMaxBytes);
    assert.equal((await fixture.controller.write(args)).status, "applied");
    const saved = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(planEntities(saved.plan).length, 25);
    assert.deepEqual(fixture.detailCalls, ["large-plan-item"]);
  } finally {await closeFixture(fixture);}
});

test("workflow read exposes bounded live lineage and every shared parent-step reference", async () => {
  const fixture = await makeFixture();
  try {
    const childA = thread("child-a", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    const childB = thread("child-b", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    fixture.threads.push(childA, childB);
    const ensure = ensureArgs(fixture, "association-main", "Create the parent workflow.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    for (const [childId, operationId] of [[childA.id, "association-child-a"], [childB.id, "association-child-b"]]) {
      const linkArgs = {action: "link_child", ...locator(fixture), operationId, childThreadId: childId,
        note: `Link ${childId} to the live parent.`};
      installEvidence(fixture, linkArgs);
      assert.equal((await fixture.controller.write(linkArgs)).status, "created");
    }

    const parentInput: WorkflowApplyPatch = {
      operationId: "association-parent-steps",
      workflowId: created.workflowId,
      expectedRevision: 1,
      status: "planned",
      objective: "Coordinate two children.",
      plan: sequencePlan([
        localStep("Inspect output", "One child checks the shape.", [childA.id, childB.id]),
        localStep("Review edge cases", "The same child checks another area.", [childA.id]),
      ]),
      note: "Keep shared child associations on the parent steps.",
    };
    const parentArgs = applyArgs(fixture, parentInput);
    installEvidence(fixture, parentArgs);
    assert.equal((await fixture.controller.write(parentArgs)).status, "applied");

    const read = await fixture.controller.read({...locator(fixture), limit: 10});
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    assert.deepEqual(read.lineage.map(item => item.threadId), [fixture.mainThreadId, childA.id, childB.id]);
    const a = read.workflows.find(item => item.document.threadId === childA.id)!;
    const b = read.workflows.find(item => item.document.threadId === childB.id)!;
    assert.deepEqual(a.parentNodeReferences.map(step => step.nodeName), ["Inspect output", "Review edge cases"]);
    assert.deepEqual(b.parentNodeReferences.map(step => step.nodeName), ["Inspect output"]);
    assert.equal(a.parentNodeReferences[0]?.parentWorkflowId, created.workflowId);

    const childWorkflow = a.document;
    const childInput: WorkflowApplyPatch = {
      operationId: "association-child-expansion",
      workflowId: childWorkflow.workflowId,
      expectedRevision: childWorkflow.revision,
      status: "underway",
      objective: "Break output inspection into child tasks.",
      plan: sequencePlan([localStep("Check columns", "Validate the output headers.", [childA.id])]),
      note: "Expand the child subflow independently.",
      evidence: [{kind: "status_changed", note: "The child subflow started."}],
    };
    const childArgs = applyArgs(fixture, childInput);
    installEvidence(fixture, childArgs);
    const childUpdate = await fixture.controller.write(childArgs);
    assert.equal(childUpdate.status, "applied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, 2);
    assert.equal(mainStep(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, childA.id)?.plan ?? null)?.name, "Check columns");
  } finally {await closeFixture(fixture);}
});

test("workflow read reports an incompatible stored document instead of omitting or rewriting it", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "oversized-read-create", "Create a main workflow.");
    installEvidence(fixture, args);
    const created = await fixture.controller.write(args);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const legacyDocument = {...current, formatVersion: 1};
    fixture.guidance.db.prepare("UPDATE supervisor_workflow_state SET document=? WHERE workflow_id=?")
      .run(JSON.stringify(legacyDocument), current.workflowId);
    assert.deepEqual(await fixture.controller.read({...locator(fixture), workflowId: current.workflowId, limit: 1}), {
      status: "incompatible", workflowId: current.workflowId, formatVersion: 1,
      reason: "This workflow uses an older or unknown storage format and is retained read-only.",
    });
    assert.deepEqual(JSON.parse(String(fixture.guidance.db.prepare("SELECT document FROM supervisor_workflow_state WHERE workflow_id=?")
      .get(current.workflowId)?.document)), legacyDocument);
  } finally {await closeFixture(fixture);}
});

test("archived descendants stay owned for reads and semantic edits but cannot gain new work", async () => {
  const fixture = await makeFixture();
  try {
    const archivedChild = thread("archived-child", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    fixture.threads.push(archivedChild);
    const ensure = ensureArgs(fixture, "archive-main-draft", "Create the parent workflow.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const link = {action: "link_child", ...locator(fixture), operationId: "archive-child-link",
      childThreadId: archivedChild.id, note: "Link this live child before it is archived."};
    installEvidence(fixture, link);
    assert.equal((await fixture.controller.write(link)).status, "created");
    const parentPlan: WorkflowApplyPatch = {
      operationId: "archive-parent-plan",
      workflowId: created.workflowId,
      expectedRevision: 1,
      status: "planned",
      objective: "Coordinate the child work.",
      plan: sequencePlan([localStep("Inspect the result", "The child owns this check.", [archivedChild.id])]),
      note: "Record the parent association.",
    };
    const parentPlanArgs = applyArgs(fixture, parentPlan);
    installEvidence(fixture, parentPlanArgs);
    assert.equal((await fixture.controller.write(parentPlanArgs)).status, "applied");

    const childDocument = fixture.workflows.get(fixture.projectId, fixture.mainThreadId, archivedChild.id)!;
    const childPlan: WorkflowApplyPatch = {
      operationId: "archive-child-plan",
      workflowId: childDocument.workflowId,
      expectedRevision: childDocument.revision,
      status: "planned",
      objective: "Keep a child-owned subflow.",
      plan: sequencePlan([localStep("Review inputs", "Keep the prior contributor association.", [archivedChild.id])]),
      note: "Create the child plan while its thread is live.",
    };
    const childPlanArgs = applyArgs(fixture, childPlan);
    installEvidence(fixture, childPlanArgs);
    assert.equal((await fixture.controller.write(childPlanArgs)).status, "applied");

    archivedChild.archivedAt = "2026-10-14T21:00:00.000Z";
    const grandchild = thread("live-grandchild", fixture.projectId, archivedChild.id, "subagent", fixture.mainThreadId);
    fixture.threads.push(grandchild);
    const read = await fixture.controller.read({...locator(fixture), limit: 10});
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    assert.deepEqual(read.lineage.map(item => item.threadId), [fixture.mainThreadId, archivedChild.id, grandchild.id]);
    assert.equal(read.lineage.find(item => item.threadId === archivedChild.id)?.archivedAt, archivedChild.archivedAt);

    const parent = read.workflows.find(item => item.document.threadId === fixture.mainThreadId)!.document;
    const parentUpdate = applyArgs(fixture, {operationId: "archive-parent-objective", workflowId: parent.workflowId,
      expectedRevision: parent.revision, objective: "Keep the retained child association.", note: "Update parent semantics only."});
    installEvidence(fixture, parentUpdate);
    assert.equal((await fixture.controller.write(parentUpdate)).status, "applied");
    assert.deepEqual(mainStep(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.plan ?? null)?.contributorThreadIds, [archivedChild.id]);

    const archivedWorkflow = fixture.workflows.get(fixture.projectId, fixture.mainThreadId, archivedChild.id)!;
    const archivedUpdate = applyArgs(fixture, {operationId: "archive-child-objective", workflowId: archivedWorkflow.workflowId,
      expectedRevision: archivedWorkflow.revision, status: "underway", objective: "Edit the retained child workflow.",
      evidence: [{kind: "status_changed", note: "Resume the retained plan status."}], note: "Change child semantics after archive."});
    installEvidence(fixture, archivedUpdate);
    assert.equal((await fixture.controller.write(archivedUpdate)).status, "applied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, archivedChild.id)?.objective,
      "Edit the retained child workflow.");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, archivedChild.id)?.status, "underway");

    const archivedLink = {action: "link_child", ...locator(fixture), operationId: "archive-child-relink",
      childThreadId: archivedChild.id, note: "Do not create new links to archived chats."};
    installEvidence(fixture, archivedLink);
    assert.equal((await fixture.controller.write(archivedLink)).status, "denied");

    const unlinkedArchived = thread("new-archived-child", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    unlinkedArchived.archivedAt = "2026-10-14T21:01:00.000Z";
    fixture.threads.push(unlinkedArchived);
    const newArchivedLink = {action: "link_child", ...locator(fixture), operationId: "new-archived-link",
      childThreadId: unlinkedArchived.id, note: "Do not link newly archived work."};
    installEvidence(fixture, newArchivedLink);
    assert.equal((await fixture.controller.write(newArchivedLink)).status, "denied");

    const currentParent = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const currentParentStep = mainStep(currentParent.plan)!;
    const moveArchivedContributor = applyArgs(fixture, {operationId: "archive-contributor-move", workflowId: currentParent.workflowId,
      expectedRevision: currentParent.revision, plan: sequencePlan([
        {...currentParentStep, contributorThreadIds: [fixture.mainThreadId]},
        localStep("New archived work", "An archived child cannot move to a new step.", [archivedChild.id]),
      ]), note: "Do not move a retained archived contributor to another step."});
    installEvidence(fixture, moveArchivedContributor);
    assert.deepEqual(await fixture.controller.write(moveArchivedContributor), {
      status: "denied", operationId: "archive-contributor-move", reason: "new_contributor_not_live",
    });

    const currentAfterMove = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const movedParentStep = mainStep(currentAfterMove.plan)!;
    const removeArchivedContributor = applyArgs(fixture, {operationId: "archive-contributor-remove", workflowId: currentAfterMove.workflowId,
      expectedRevision: currentAfterMove.revision, plan: sequencePlan([
        {...movedParentStep, contributorThreadIds: [fixture.mainThreadId]},
        ...currentAfterMove.plan!.nodes.slice(1),
      ]), note: "Remove an archived contributor from its original step."});
    installEvidence(fixture, removeArchivedContributor);
    assert.equal((await fixture.controller.write(removeArchivedContributor)).status, "applied");

    const currentAfterRemoval = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const removedParentStep = mainStep(currentAfterRemoval.plan)!;
    const readdArchivedContributor = applyArgs(fixture, {operationId: "archive-contributor-readd", workflowId: currentAfterRemoval.workflowId,
      expectedRevision: currentAfterRemoval.revision, plan: sequencePlan([
        {...removedParentStep, contributorThreadIds: [archivedChild.id]},
        ...currentAfterRemoval.plan!.nodes.slice(1),
      ]), note: "Do not re-add an archived contributor after removing it."});
    installEvidence(fixture, readdArchivedContributor);
    assert.deepEqual(await fixture.controller.write(readdArchivedContributor), {
      status: "denied", operationId: "archive-contributor-readd", reason: "new_contributor_not_live",
    });

    const parentAfterRemoval = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const addArchivedContributor = applyArgs(fixture, {operationId: "new-archived-contributor", workflowId: currentParent.workflowId,
      expectedRevision: parentAfterRemoval.revision, plan: sequencePlan([
        {...mainStep(parentAfterRemoval.plan)!, contributorThreadIds: [fixture.mainThreadId]},
        localStep("New archived work", "This contributor was not already present.", [unlinkedArchived.id]),
      ]), note: "Do not add an archived contributor."});
    installEvidence(fixture, addArchivedContributor);
    assert.deepEqual(await fixture.controller.write(addArchivedContributor), {
      status: "denied", operationId: "new-archived-contributor", reason: "new_contributor_not_live",
    });

    const main = fixture.threads.find(item => item.id === fixture.mainThreadId)!;
    main.archivedAt = "2026-10-14T21:02:00.000Z";
    assert.equal((await fixture.controller.read({...locator(fixture)})).status, "unavailable");
  } finally {await closeFixture(fixture);}
});

test("partial status edits retain contributors whose child is no longer in the current thread inventory", async () => {
  const fixture = await makeFixture();
  try {
    const child = thread("deleted-contributor", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    fixture.threads.push(child);
    const ensure = ensureArgs(fixture, "deleted-contributor-create", "Create the parent workflow.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const initialPlan = applyArgs(fixture, {operationId: "deleted-contributor-plan", workflowId: created.workflowId,
      expectedRevision: created.revision, status: "planned", objective: "Retain the planned association.",
      plan: sequencePlan([localStep("Review child output", "The child was live when assigned.", [child.id])]),
      note: "Associate the live descendant with this step."});
    installEvidence(fixture, initialPlan);
    assert.equal((await fixture.controller.write(initialPlan)).status, "applied");

    child.deletedAt = "2026-10-14T21:05:00.000Z";
    fixture.threads.splice(fixture.threads.indexOf(child), 1);
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const partial = applyArgs(fixture, {operationId: "deleted-contributor-status", workflowId: current.workflowId,
      expectedRevision: current.revision, status: "underway", evidence: [{kind: "status_changed", note: "The parent work started."}],
      note: "Change parent status without removing the deleted child association."});
    installEvidence(fixture, partial);
    assert.equal((await fixture.controller.write(partial)).status, "applied");
    const updated = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(updated.status, "underway");
    assert.deepEqual(mainStep(updated.plan)?.contributorThreadIds, [child.id]);
  } finally {await closeFixture(fixture);}
});

test("activity references are scoped and stored as navigation evidence without proving success", async () => {
  const fixture = await makeFixture();
  try {
    const create = ensureArgs(fixture, "source-evidence-create", "Create a workflow.");
    installEvidence(fixture, create);
    const created = await fixture.controller.write(create);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    fixture.details.set("source-command", {id: "source-command", type: "command_execution", threadId: fixture.mainThreadId,
      runId: null, status: "interrupted"});
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const apply = applyArgs(fixture, {operationId: "source-evidence-apply", workflowId: created.workflowId,
      expectedRevision: current.revision, status: "planned", objective: "Keep the evidence source native.",
      plan: sequencePlan([localStep("Check evidence", "Assess the command output semantically.", [fixture.mainThreadId])]),
      note: "The Supervisor assessed the observed command.", evidence: [{kind: "observation", note: "The command result was inspected.",
        sourceItemId: "source-command"}]});
    installEvidence(fixture, apply);
    const result = await fixture.controller.write(apply);
    assert.equal(result.status, "applied");
    if (result.status !== "applied") return;
    assert.equal(result.revision, 2);
    const updated = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const observation = updated.evidence.find(item => item.kind === "observation");
    assert.equal(observation?.sourceThreadId, fixture.mainThreadId, "an omitted thread defaults to the workflow target");
    assert.equal(observation?.sourceRunId, null, "native child/tool activity may not have a run ID");
    assert.equal(observation?.sourceItemId, "source-command");

    const invalidScope = applyArgs(fixture, {operationId: "source-evidence-outside-scope", workflowId: created.workflowId,
      expectedRevision: updated.revision, status: "planned", objective: updated.objective, plan: updated.plan,
      note: "Reject a link to a foreign thread.", evidence: [{kind: "observation", note: "This source is outside the owner scope.",
        sourceThreadId: "foreign-thread", sourceMessageId: "foreign-message"}]});
    installEvidence(fixture, invalidScope);
    assert.deepEqual(await fixture.controller.write(invalidScope), {
      status: "denied", operationId: "source-evidence-outside-scope", reason: "activity_reference_outside_current_scope",
    });
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, 2);
  } finally {await closeFixture(fixture);}
});

test("activity references fail closed when their workflow target is absent", async () => {
  const fixture = await makeFixture();
  try {
    const apply = applyArgs(fixture, {operationId: "reference-target-missing", workflowId: "missing-workflow",
      expectedRevision: 1, note: "Reject an unresolvable workflow target.",
      evidence: [{kind: "observation", note: "Link this to a workflow that does not exist.", sourceItemId: "source-command"}]});
    installEvidence(fixture, apply);
    assert.deepEqual(await fixture.controller.write(apply), {
      status: "invalid", operationId: "reference-target-missing", reason: "activity_reference_workflow_not_found",
    });
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts WHERE operation_id=?")
      .get("reference-target-missing")?.n), 0);
  } finally {await closeFixture(fixture);}
});

test("an exact successful apply replay precedes new activity-reference target validation", async () => {
  const fixture = await makeFixture();
  try {
    const create = ensureArgs(fixture, "reference-replay-create", "Create the workflow target.");
    installEvidence(fixture, create);
    const created = await fixture.controller.write(create);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const apply = applyArgs(fixture, {operationId: "reference-replay-apply", workflowId: created.workflowId,
      expectedRevision: created.revision, status: "underway", objective: "Track the current task.",
      plan: sequencePlan([localStep("Inspect the result", "Review the task output before completion.")]),
      note: "Apply a traceable status change.",
      evidence: [{kind: "status_changed", note: "The Supervisor assessed the current activity.", sourceThreadId: fixture.mainThreadId}]});
    installEvidence(fixture, apply);
    const applied = await fixture.controller.write(apply);
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    const detailReadCount = fixture.detailCalls.length;
    fixture.guidance.db.prepare("DELETE FROM supervisor_workflow_state WHERE workflow_id=?").run(created.workflowId);

    assert.deepEqual(await fixture.controller.write(apply), applied);
    assert.equal(fixture.detailCalls.length, detailReadCount, "receipt replay does not repeat native proof or reference validation");
  } finally {await closeFixture(fixture);}
});

test("activity references must resolve exactly and agree on their native run", async () => {
  const fixture = await makeFixture();
  try {
    const create = ensureArgs(fixture, "source-run-create", "Create a workflow.");
    installEvidence(fixture, create);
    const created = await fixture.controller.write(create);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const sourceProjection = makeProjection(fixture.mainThreadId, fixture.projectId);
    sourceProjection.runs = [{id: "source-run", ordinal: 3, status: "completed", requestedAt: "2026-10-15T00:00:00.000Z",
      startedAt: "2026-10-15T00:00:00.000Z", completedAt: "2026-10-15T00:00:01.000Z", rootNodeId: null, threadId: fixture.mainThreadId}];
    sourceProjection.messages = [{id: "source-message", runId: "source-run", nodeId: null, role: "assistant",
      text: "The test result was inspected.", streaming: false, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z",
      threadId: fixture.mainThreadId}];
    fixture.projections.set(fixture.mainThreadId, sourceProjection);
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const matching = applyArgs(fixture, {operationId: "source-run-match", workflowId: created.workflowId,
      expectedRevision: current.revision, status: "planned", objective: "Keep references attributable.",
      plan: sequencePlan([localStep("Review result", "Assess the activity semantically.", [fixture.mainThreadId])]),
      note: "The Supervisor inspected the message.", evidence: [{kind: "observation", note: "The observed result is linked.",
        sourceRunId: "source-run", sourceMessageId: "source-message"}]});
    installEvidence(fixture, matching);
    const matched = await fixture.controller.write(matching);
    assert.equal(matched.status, "applied", JSON.stringify(matched));
    if (matched.status !== "applied") return;
    const observation = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.evidence.find(item => item.kind === "observation");
    assert.equal(observation?.sourceThreadId, fixture.mainThreadId);
    assert.equal(observation?.sourceRunId, "source-run");
    assert.equal(observation?.sourceMessageId, "source-message");

    fixture.details.set("source-item-other-run", {id: "source-item-other-run", type: "command_execution", threadId: fixture.mainThreadId,
      runId: "different-run", status: "completed"});
    const latest = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const mismatched = applyArgs(fixture, {operationId: "source-run-mismatch", workflowId: created.workflowId,
      expectedRevision: latest.revision, status: "planned", objective: latest.objective, plan: latest.plan,
      note: "Reject a run that disagrees with the item.", evidence: [{kind: "observation", note: "This reference is inconsistent.",
        sourceRunId: "source-run", sourceItemId: "source-item-other-run"}]});
    installEvidence(fixture, mismatched);
    assert.deepEqual(await fixture.controller.write(mismatched), {
      status: "invalid", operationId: "source-run-mismatch", reason: "activity_reference_item_run_mismatch",
    });
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, latest.revision);
  } finally {await closeFixture(fixture);}
});

test("activity references cannot relabel inherited projection records as local activity", async () => {
  const fixture = await makeFixture();
  try {
    const create = ensureArgs(fixture, "inherited-activity-create", "Create a workflow.");
    installEvidence(fixture, create);
    const created = await fixture.controller.write(create);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const sourceProjection = makeProjection(fixture.mainThreadId, fixture.projectId);
    sourceProjection.runs = [{id: "inherited-run", ordinal: 3, status: "completed", requestedAt: "2026-10-15T00:00:00.000Z",
      startedAt: "2026-10-15T00:00:00.000Z", completedAt: "2026-10-15T00:00:01.000Z", rootNodeId: null, threadId: "foreign-thread"}];
    sourceProjection.messages = [{id: "inherited-message", runId: "inherited-run", nodeId: null, role: "assistant",
      text: "This message belongs to another thread.", streaming: false, createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z", threadId: "foreign-thread"}];
    fixture.projections.set(fixture.mainThreadId, sourceProjection);
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const common = {workflowId: created.workflowId, expectedRevision: current.revision, status: "planned" as const,
      objective: current.objective, plan: current.plan};
    const wrongRun = applyArgs(fixture, {...common, operationId: "inherited-run-reference", note: "Reject an inherited run.",
      evidence: [{kind: "observation", note: "This run belongs elsewhere.", sourceRunId: "inherited-run"}]});
    installEvidence(fixture, wrongRun);
    assert.deepEqual(await fixture.controller.write(wrongRun), {
      status: "invalid", operationId: "inherited-run-reference", reason: "activity_reference_run_mismatch",
    });

    const wrongMessage = applyArgs(fixture, {...common, operationId: "inherited-message-reference", note: "Reject an inherited message.",
      evidence: [{kind: "observation", note: "This message belongs elsewhere.", sourceMessageId: "inherited-message"}]});
    installEvidence(fixture, wrongMessage);
    assert.deepEqual(await fixture.controller.write(wrongMessage), {
      status: "invalid", operationId: "inherited-message-reference", reason: "activity_reference_message_not_found",
    });
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, current.revision);
  } finally {await closeFixture(fixture);}
});
