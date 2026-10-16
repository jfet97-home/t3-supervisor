import {SupervisorTeamStore} from "../src/supervisor-team-store.js";
import {SupervisorTeamController, supervisionTeamToolDefinition} from "../src/supervisor-team-controller.js";
import {SupervisorConversationStore} from "../src/supervisor-conversation-store.js";
import {supervisorTeamView} from "../src/supervisor-team-view.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint, GuidanceStore } from "../src/guidance-store.js";
import { defaultSupervisorModel, ProjectSupervisorStore, type BindingRecord, type TaskRecord } from "../src/project-supervisor-store.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import type { WorkflowAgreementImport, WorkflowOwner } from "../src/workflow-state-contract.js";
import { WorkflowWriteController, workflowReadToolDefinition, workflowWriteToolDefinition, type WorkflowApplyPatch, type WorkflowNativeAccess } from "../src/workflow-write-controller.js";
import { workflowToolInputMaxBytes, workflowToolInputSize, workflowToolNames, workflowTurnItemDetailMaxBytes } from "../src/workflow-write-evidence.js";
import type { WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo, WorkflowSourceBindingInfo } from "../src/project-supervisor-contract.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { parseWorkflowInterpretation, proposalContextFromDefinitions, validateWorkflowPlan } from "../src/supervisor-workflow.js";
import { WebSocketServer } from "ws";
import { makeSupervisorRpc, SupervisorRpcError } from "../src/supervisor-native.js";

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

test("workflow_read exposes the main task's bounded workflow protocol diagnostic", async () => {
  const fixture = await makeFixture();
  try {
    const diagnostic = {role: "operative" as const, proposalId: "proposal-current", messageId: "compact-acceptance",
      code: "record_fields", observedAt: 1234};
    fixture.supervisors.saveTask({...fixture.supervisors.task(fixture.mainThreadId)!, workflowProtocolDiagnostic: diagnostic});
    const read = await fixture.controller.read({...locator(fixture), limit: 10});
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    assert.deepEqual(read.workflowProtocolDiagnostic, diagnostic);
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

test("Claude-shaped and future native tool records pass the shared exact proof", async () => {
  for (const [driver, nodeKind] of [["claudeAgent", "tool_call"], ["future-provider", "tool_call"]] as const) {
    const fixture = await makeFixture();
    try {
      const args = ensureArgs(fixture, `provider-neutral-${driver}`, "Require the exact native tool record.");
      const itemId = installEvidence(fixture, args, {
        driver,
        nodeKind,
        toolName: workflowToolNames.write.direct[1],
        snapshotInput: args,
      });
      assert.equal((await fixture.controller.write(args)).status, "created", driver);
      assert.deepEqual(fixture.detailCalls, [itemId]);
      const proof = fixture.guidance.db.prepare(
        "SELECT native_evidence FROM supervisor_workflow_write_evidence WHERE operation_id=?",
      ).get(args.operationId) as {native_evidence: string} | undefined;
      assert.equal(JSON.parse(proof!.native_evidence).nativeItemRef.driver, driver);
    } finally {await closeFixture(fixture);}
  }
  assert.match(workflowReadToolDefinition.description, /strong native item references/u);
  assert.match(workflowWriteToolDefinition.description, /sourceItemId/u);
});

test("provider-neutral records retain strong native identity and main-run quality gates", async () => {
  for (const [label, mutate, expectedReason] of [
    ["weak-ref", (detail: Record<string, unknown>) => {
      (detail.nativeItemRef as Record<string, unknown>).strength = "weak";
    }, "native_item_not_main_strong"],
    ["parent-item", (detail: Record<string, unknown>) => {detail.parentItemId = "parent-item";}, "native_item_not_main_strong"],
    ["non-execution", (detail: Record<string, unknown>) => {detail.toolNonExecutionKind = "preview";}, "native_item_not_executed"],
    ["invalid-driver", (detail: Record<string, unknown>) => {
      (detail.nativeItemRef as Record<string, unknown>).driver = " ";
    }, "native_item_identity_incomplete"],
  ] as const) {
    const fixture = await makeFixture();
    try {
      const args = ensureArgs(fixture, `provider-quality-${label}`, "Reject incomplete native evidence.");
      const itemId = installEvidence(fixture, args, {
        driver: "claudeAgent",
        nodeKind: "tool_call",
        toolName: workflowToolNames.write.direct[1],
        snapshotInput: args,
      });
      mutate(fixture.details.get(itemId) as Record<string, unknown>);
      const result = await fixture.controller.write(args);
      assert.equal(result.status, "denied", label);
      assert.equal(result.status === "denied" ? result.reason : "", expectedReason, label);
      assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
      assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts").get()?.n), 0);
    } finally {await closeFixture(fixture);}
  }
});

test("an exact strong own-main record with an unrecognized tool name is explicitly denied", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "unknown-native-tool-name", "Do not infer authority from an unknown tool name.");
    const observedToolName = "claudeAgent.dynamic_tool.workflow_write";
    const itemId = installEvidence(fixture, args, {
      driver: "claudeAgent",
      nodeKind: "tool_call",
      toolName: observedToolName,
      snapshotInput: args,
    });
    const controller = new WorkflowWriteController({
      supervisors: fixture.supervisors,
      workflows: fixture.workflows,
      native: fixture.native,
      loadDefinitions: async () => fixture.definitionReader.current,
      isEnabled: id => fixture.supervisors.enabled(id),
      maxEvidenceWaitMs: 60,
    });
    assert.deepEqual(await controller.write(args), {
      status: "denied",
      operationId: args.operationId,
      reason: "native_tool_name_unrecognized",
      observedToolName,
    });
    assert.deepEqual(fixture.detailCalls, [itemId]);
    assert.ok(fixture.projectionCalls.length > 1, "waits through the bounded evidence window before denying an unknown name");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts").get()?.n), 0);
  } finally {await closeFixture(fixture);}
});

test("an unrecognized name is reported only after all native ownership gates and stays bounded", async () => {
  for (const [label, options] of [
    ["weak", {refStrength: "weak"}],
    ["nested", {parentItemId: "parent-item"}],
  ] as const) {
    const fixture = await makeFixture();
    try {
      const args = ensureArgs(fixture, `unknown-tool-quality-${label}`, "An unknown name cannot bypass evidence quality.");
      const itemId = installEvidence(fixture, args, {
        driver: "future-provider",
        nodeKind: "tool_call",
        toolName: `unrecognized-${label}`,
        snapshotInput: args,
        ...(options.parentItemId ? {parentItemId: options.parentItemId} : {}),
      });
      if (options.refStrength) (fixture.details.get(itemId) as {nativeItemRef: {strength: string}}).nativeItemRef.strength = options.refStrength;
      const result = await fixture.controller.write(args);
      assert.equal(result.status, "denied");
      assert.equal(result.status === "denied" ? result.reason : "", "native_item_not_main_strong");
      assert.equal(result.status === "denied" ? result.observedToolName : undefined, undefined);
      assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    } finally {await closeFixture(fixture);}
  }

  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "bounded-unknown-tool-name", "Bound names returned from native activity.");
    const observedToolName = "x".repeat(300);
    installEvidence(fixture, args, {
      driver: "future-provider",
      nodeKind: "tool_call",
      toolName: observedToolName,
      snapshotInput: args,
    });
    const result = await fixture.controller.write(args);
    assert.equal(result.status, "denied");
    assert.equal(result.status === "denied" ? result.reason : "", "native_tool_name_unrecognized");
    assert.equal(result.status === "denied" ? result.observedToolName?.length : undefined, 128);
  } finally {await closeFixture(fixture);}
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

test("apply denies a null-plan provisional current task before reading or changing the draft", async () => {
  const fixture = await makeFixture();
  try {
    const ensure = ensureArgs(fixture, "null-plan-provisional-create", "Create a draft before checking its current proposal.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const context = proposalContextFromDefinitions(fixture.definitionReader.current);
    const provisional = parseWorkflowInterpretation(JSON.stringify({objective: "Complete the current project task.",
      reason: "The latest message describes an actionable task.", sourceMessageIds: ["source-message-current"], workflow: null}),
    "source-message-current", context).workflow;
    assert.equal(provisional.status, "provisional");
    assert.equal(provisional.plan, null);
    replaceCurrentProposal(fixture, "proposal-null-plan-provisional", fixture.definitionReader.current, provisional);

    const args = applyArgs(fixture, {operationId: "null-plan-provisional-apply", workflowId: created.workflowId,
      expectedRevision: created.revision, plan: sequencePlan([localStep("Inspect source", "Use the task's pinned definitions.")]),
      note: "The provisional task has no source-bound plan."});
    installEvidence(fixture, args);
    assert.deepEqual(await fixture.controller.write(args), {
      status: "invalid", operationId: "null-plan-provisional-apply", reason: "current_task_has_no_valid_source_bound_plan",
    });
    assert.equal(fixture.definitionReader.calls, 0);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, created.revision);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts WHERE operation_id='null-plan-provisional-apply'").get()?.n), 0);
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


test("a registered helper writes only its assigned child using its own exact main-run evidence", async () => {
  const f = await makeFixture();
  try {
    const team = new SupervisorTeamStore(f.supervisors);
    const member = team.registerMember(f.binding, {threadId: "helper-own", taskId: "helper-task", bootstrapRunId: "bootstrap"});
    const ready = team.markReady(f.binding, member.threadId, member.epoch);
    const child = thread("operational-a", f.projectId, f.mainThreadId, "subagent");
    const other = thread("operational-b", f.projectId, f.mainThreadId, "subagent");
    f.threads.push(child, other, thread(member.threadId, f.projectId, f.supervisorThreadId, "subagent"));
    const parents = new Map(f.threads.map(item => [item.id, item.lineage.parentThreadId]));
    const assignment = team.assign(f.binding, child.id, member.threadId, parents);
    for (const notification of team.snapshot(f.binding).notifications) {
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "sending");
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "delivered");
      team.acknowledgeNotification(f.binding, member.threadId, notification.id, ready.epoch);
    }
    team.completeTransfer(f.binding, child.id, assignment.epoch);
    f.workflows.ensureMainInTransaction(f.owner, "seed-main", "Main remains owned by root.");
    const own = makeProjection(member.threadId, f.projectId);
    own.thread = f.threads.find(item => item.id === member.threadId)!;
    f.projections.set(member.threadId, own);
    const actorFixture = {...f, supervisorThreadId: member.threadId, projection: own};
    const controller = new WorkflowWriteController({...f.controller.options, team});
    const authority = {supervisorThreadId: member.threadId, bindingGeneration: f.binding.generation,
      memberEpoch: ready.epoch, assignmentRootThreadId: child.id, assignmentEpoch: assignment.epoch};
    const args = {...authority, action: "link_child", operationId: "shared-operation", childThreadId: child.id, note: "Helper child plan."};
    installEvidence(f, args);
    assert.equal((await controller.write(args)).status, "pending", "projected proof in root cannot authorize helper");
    installEvidence(actorFixture, args);
    const result = await controller.write(args);
    assert.equal(result.status, "created");
    const doc = f.workflows.get(f.projectId, f.mainThreadId, child.id)!;
    assert.equal((await controller.read({...authority})).status, "ok");
    assert.equal(f.workflows.getByIdForOwner(f.owner, doc.workflowId).status, "found");
    const foreign = {...args, operationId: "foreign", childThreadId: other.id};
    installEvidence(actorFixture, foreign);
    assert.deepEqual(await controller.write(foreign), {status: "denied", operationId: "foreign", reason: "actor_outside_current_assignment"});
    const main = {...authority, action: "ensure_main", operationId: "forbidden-main", note: "Cannot own root."};
    installEvidence(actorFixture, main);
    assert.equal((await controller.write(main)).status, "denied");
    const transfer = team.release(f.binding, child.id, parents);
    const stale = {...args, operationId: "stale-after-transfer"};
    installEvidence(actorFixture, stale);
    assert.equal((await controller.write(stale)).status, "denied");
    assert(transfer.epoch > assignment.epoch);
    assert.equal(f.workflows.get(f.projectId, f.mainThreadId, child.id)!.workflowId, doc.workflowId);
  } finally {f.guidance.close();await rm(f.directory, {recursive: true, force: true});}
});

test("team registration requires a completed app-owned bootstrap and readiness requires helper-own proof", async () => {
  const f = await makeFixture();
  try {
    const team = new SupervisorTeamStore(f.supervisors);
    const reader = new WorkflowWriteController({...f.controller.options, team});
    const controller = new SupervisorTeamController(reader, team, null);
    const args = {...locator(f), action: "register", operationId: "register-1", memberThreadId: "real-helper", taskId: "task-node", bootstrapRunId: "boot-run"};
    installEvidence(f, args, {toolName: workflowToolNames.team.direct[0]});
    const child = makeProjection("real-helper", f.projectId);
    child.thread.lineage = {parentThreadId: f.supervisorThreadId, relationshipToParent: "subagent"};
    child.thread.forkedFrom = {type: "node", nodeId: "task-node"};
    child.runs = [{id: "boot-run", threadId: "real-helper", ordinal: 1, status: "completed", userMessageId: "bootstrap-message", requestedAt: "2026-10-16T10:00:00Z", startedAt: null, completedAt: null, rootNodeId: "boot-root"}];
    child.messages = [{id: "bootstrap-message", threadId: "real-helper", runId: "boot-run", nodeId: "boot-root", role: "user", text: "Bootstrap ready", streaming: false, createdAt: "2026-10-16T10:00:00Z", updatedAt: "2026-10-16T10:00:00Z"}];
    f.projections.set("real-helper", child);
    f.threads.push(child.thread);
    assert.equal((await controller.call(args, AbortSignal.timeout(1000)) as {status: string}).status, "denied");
    assert.equal(team.snapshot(f.binding).members.length, 0);
    f.projection.subagents = [{id: "task-node", threadId: f.supervisorThreadId, runId: "supervisor-run-current", origin: "app_owned", childThreadId: "real-helper", status: "completed", prompt: "Bootstrap ready", result: {summary: "Bootstrap complete."}}];
    const beforeRegistrationReads = f.projectionCalls.length;
    assert.equal((await controller.call(args, AbortSignal.timeout(1000)) as {status: string}).status, "ok");
    assert.deepEqual(f.projectionCalls.slice(beforeRegistrationReads), [f.supervisorThreadId, f.supervisorThreadId, "real-helper"],
      "unset helper isolation preserves the existing native reads");
    const member = team.snapshot(f.binding).members[0]!;
    const ready = {supervisorThreadId: member.threadId, bindingGeneration: f.binding.generation, memberEpoch: member.epoch, action: "ready", operationId: "ready-1"};
    assert.equal((await controller.call(ready, AbortSignal.timeout(1000)) as {status: string}).status, "pending");
    installEvidence({...f, supervisorThreadId: member.threadId, projection: child}, ready, {toolName: workflowToolNames.team.direct[0]});
    const result = await controller.call(ready, AbortSignal.timeout(1000)) as {status: string};
    assert.equal(result.status, "ok");
    assert.equal(team.snapshot(f.binding).members[0]!.state, "ready");
    assert.deepEqual(await controller.call(ready, AbortSignal.timeout(1000)), result, "lost readiness response replays after epoch advances");
  } finally {f.guidance.close();await rm(f.directory, {recursive: true, force: true});}
});

test("opt-in helper provider isolation accepts only a distinct configured instance and owned provider sessions", async () => {
  const configuredInstanceId = "supervisor-helpers-20348";
  const register = async (variant: "isolated" | "wrong-instance" | "same-instance" | "shared-session" | "missing-session" | "missing-owner") => {
    const f = await makeFixture();
    const team = new SupervisorTeamStore(f.supervisors);
    const reader = new WorkflowWriteController({...f.controller.options, team, helperProviderInstanceId: configuredInstanceId});
    const controller = new SupervisorTeamController(reader, team, null);
    const args = {...locator(f), action: "register", operationId: `register-${variant}`, memberThreadId: "isolated-helper",
      taskId: `task-${variant}`, bootstrapRunId: `boot-${variant}`};
    installEvidence(f, args, {toolName: workflowToolNames.team.direct[0]});
    f.projection.thread.modelSelection = {instanceId: variant === "same-instance" ? configuredInstanceId : "codex", model: "gpt-6-luna", options: []};
    f.projection.subagents = [{id: args.taskId, threadId: f.supervisorThreadId, runId: "supervisor-run-current", origin: "app_owned",
      childThreadId: args.memberThreadId, status: "completed", prompt: "Bootstrap ready", result: {summary: "Bootstrap complete."}}];
    const child = makeProjection(args.memberThreadId, f.projectId);
    child.thread.lineage = {parentThreadId: f.supervisorThreadId, relationshipToParent: "subagent"};
    child.thread.forkedFrom = {type: "node", nodeId: args.taskId};
    const childInstanceId = variant === "wrong-instance" ? "codex" : configuredInstanceId;
    child.thread.modelSelection = {instanceId: childInstanceId, model: "gpt-6-luna", options: []};
    child.runs = [{id: args.bootstrapRunId, threadId: args.memberThreadId, ordinal: 1, status: "completed", userMessageId: "bootstrap-message",
      requestedAt: "2026-10-16T10:00:00Z", startedAt: null, completedAt: null, rootNodeId: "boot-root"}];
    child.messages = [{id: "bootstrap-message", threadId: args.memberThreadId, runId: args.bootstrapRunId, nodeId: "boot-root", role: "user",
      text: "Bootstrap ready", streaming: false, createdAt: "2026-10-16T10:00:00Z", updatedAt: "2026-10-16T10:00:00Z"}];
    const childSessionId = variant === "shared-session" ? "root-session" : variant === "missing-session" ? null : "helper-session";
    const childOwner = variant === "missing-owner" ? null : args.memberThreadId;
    child.providerThreads = [{id: "child-provider-thread", appThreadId: childOwner, providerSessionId: childSessionId,
      providerInstanceId: childInstanceId}];
    f.projection.providerThreads = [
      {id: "root-provider-thread", appThreadId: f.supervisorThreadId, providerSessionId: "root-session", providerInstanceId: "codex"},
      {id: "joined-child-provider-thread", appThreadId: args.memberThreadId, providerSessionId: childSessionId,
        providerInstanceId: childInstanceId},
    ];
    f.projections.set(args.memberThreadId, child);
    f.threads.push(child.thread);
    try {
      return {f, team, result: await controller.call(args, AbortSignal.timeout(1000)) as {status: string; reason?: string}};
    } catch (cause) {
      f.guidance.close();await rm(f.directory, {recursive: true, force: true});throw cause;
    }
  };

  for (const variant of ["isolated", "wrong-instance", "same-instance", "shared-session", "missing-session", "missing-owner"] as const) {
    const {f, team, result} = await register(variant);
    try {
      if (variant === "isolated") {
        assert.equal(result.status, "ok");
        assert.equal(team.snapshot(f.binding).members.length, 1);
      } else {
        assert.deepEqual(result, {status: "denied", reason: variant === "same-instance" ? "helper_provider_instance_matches_root" :
          variant === "shared-session" ? "helper_provider_session_shared" : variant === "missing-session" || variant === "missing-owner"
            ? "helper_provider_session_unavailable" : "helper_provider_instance_mismatch"});
        const snapshot = team.snapshot(f.binding);
        assert.equal(snapshot.members.length, 0, "rejected isolation evidence creates no member");
        assert.equal(snapshot.notifications.length, 0, "rejected isolation evidence creates no helper notification");
        assert.equal(snapshot.events.filter(event => event.kind === "service_attention" && event.targetThreadId === "isolated-helper").length, 1,
          "the rejected helper attempt raises one root-attention event");
      }
      assert.equal(f.projectionCalls.filter(id => id === f.supervisorThreadId).length, 2);
      assert.equal(f.projectionCalls.filter(id => id === "isolated-helper").length, 1);
    } finally {f.guidance.close();await rm(f.directory, {recursive: true, force: true});}
  }
});

test("helper guidance uses native steer only and retains uncertain identity across a handover", async () => {
  const f = await makeFixture();
  try {
    const team = new SupervisorTeamStore(f.supervisors);
    const member = team.registerMember(f.binding, {threadId: "guide-helper", taskId: "guide-task", bootstrapRunId: "guide-bootstrap"});
    const ready = team.markReady(f.binding, member.threadId, member.epoch);
    const target = thread("guide-target", f.projectId, f.mainThreadId, "subagent");
    Object.assign(target, {creationSource: "mcp", runtimeMode: "full-access", interactionMode: "default", activeRunId: "guide-active"});
    f.threads.push(target, thread(member.threadId, f.projectId, f.supervisorThreadId, "subagent"));
    const parents = new Map(f.threads.map(item => [item.id, item.lineage.parentThreadId]));
    const assignment = team.assign(f.binding, target.id, member.threadId, parents);
    for (const notification of team.snapshot(f.binding).notifications) {
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "sending");
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "delivered");
      team.acknowledgeNotification(f.binding, member.threadId, notification.id, ready.epoch);
    }
    team.completeTransfer(f.binding, target.id, assignment.epoch);
    const targetProjection = makeProjection(target.id, f.projectId);
    targetProjection.thread = target;
    targetProjection.runtimeRequests = [];
    targetProjection.runs = [{id: "guide-active", threadId: target.id, status: "running", ordinal: 1,
      requestedAt: "2026-10-16T10:00:00Z", startedAt: null, completedAt: null, rootNodeId: "guide-root", activeAttemptId: "guide-attempt"}];
    targetProjection.providerTurns = [{id: "guide-turn", nodeId: "guide-root", runAttemptId: "guide-attempt", status: "running"}];
    f.projections.set(target.id, targetProjection);
    const mainProjection = makeProjection(f.mainThreadId, f.projectId);
    f.projections.set(f.mainThreadId, mainProjection);
    const own = makeProjection(member.threadId, f.projectId);
    Object.assign(own.thread, {runtimeMode: "full-access", interactionMode: "default"});
    f.projections.set(member.threadId, own);
    const actorFixture = {...f, supervisorThreadId: member.threadId, projection: own};
    const reader = new WorkflowWriteController({...f.controller.options, team});
    const sent: Record<string, unknown>[] = [];
    const controller = new SupervisorTeamController(reader, team, async (_tag, command) => {sent.push(command);throw new Error("lost_send_reply");});
    const args = {supervisorThreadId: member.threadId, bindingGeneration: f.binding.generation, memberEpoch: ready.epoch,
      assignmentRootThreadId: target.id, assignmentEpoch: assignment.epoch,
      operationId: "uncertain-guidance", targetThreadId: target.id, text: "Reconsider the observed failed test before completing this step."};
    installEvidence(actorFixture, args, {toolName: workflowToolNames.guide.direct[0]});
    const first = await controller.guide(args, AbortSignal.timeout(1000)) as {status: string; messageId: string};
    assert.equal(first.status, "uncertain");
    assert.deepEqual(sent[0]!.dispatchMode, {type: "steer_active", targetRunId: "guide-active"});
    assert.equal(sent[0]!.createdBy, "system");
    assert.equal(sent[0]!.creationSource, "server");
    assert.equal(team.unresolvedRequests(f.binding).length, 1);
    const conversationRequests = new SupervisorConversationStore(f.guidance);
    const initialTeamView = supervisorTeamView(team, f.binding, f.threads, conversationRequests);
    assert.equal(initialTeamView.members[0]?.lifecycle, "idle");
    assert.match(initialTeamView.members[0]?.currentState ?? "", /guidance delivery is uncertain/u);
    assert.doesNotMatch(initialTeamView.members[0]?.currentState ?? "", /Available for the next check-in/u);
    const transfer = team.release(f.binding, target.id, parents);
    await controller.guide(args, AbortSignal.timeout(1000));
    assert.equal(sent.length, 1, "handover cannot create a second send or change route");
    const guideRequest = team.unresolvedRequests(f.binding)[0]!;
    const attentionEventId = `guide-unresolved:${guideRequest.requestId}`;
    await controller.reconcile(f.binding, AbortSignal.timeout(1000), guideRequest.updatedAt);
    assert.equal(team.snapshot(f.binding).events.some(event => event.id === attentionEventId), false, "root attention waits through the reconciliation grace period");
    await controller.reconcile(f.binding, AbortSignal.timeout(1000), guideRequest.updatedAt + 60_001);
    let unresolvedAttention = team.snapshot(f.binding).events.filter(event => event.id === attentionEventId);
    assert.equal(unresolvedAttention.length, 1);
    assert.equal(unresolvedAttention[0]?.kind, "service_attention");
    assert.equal(unresolvedAttention[0]?.acknowledgedAt, null);
    assert.equal(team.unresolvedRequests(f.binding).length, 1, "root attention never settles the unknown native effect");
    assert.equal(sent.length, 1, "reconciliation attention never retries or reroutes the native send");
    await controller.reconcile(f.binding, AbortSignal.timeout(1000), guideRequest.updatedAt + 120_001);
    unresolvedAttention = team.snapshot(f.binding).events.filter(event => event.id === attentionEventId);
    assert.equal(unresolvedAttention.length, 1, "repeated reconciliation reuses the durable root attention event");
    const attendedTeamView = supervisorTeamView(team, f.binding, f.threads, conversationRequests);
    assert.match(attendedTeamView.members[0]?.currentState ?? "", /guidance delivery is uncertain/u);
    assert.equal(attendedTeamView.members[0]?.issues.some(issue => issue.id === attentionEventId), true);
    for (const notification of team.snapshot(f.binding).notifications.filter(item => item.state !== "acknowledged")) {
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "sending");
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "delivered");
      team.acknowledgeNotification(f.binding, member.threadId, notification.id, ready.epoch);
    }
    assert.throws(() => team.completeTransfer(f.binding, target.id, transfer.epoch), /pending_effects/u);
    targetProjection.messages.push({id: first.messageId, threadId: target.id, runId: "guide-active", nodeId: "guide-root", role: "user", text: args.text,
      streaming: false, createdAt: "2026-10-16T10:00:00Z", updatedAt: "2026-10-16T10:00:00Z", createdBy: "user", creationSource: "server"});
    await controller.reconcile(f.binding, AbortSignal.timeout(1000));
    assert.equal(team.unresolvedRequests(f.binding).length, 0);
    team.completeTransfer(f.binding, target.id, transfer.epoch);
    assert.equal(team.coverage(f.binding, target.id, parents).state, "root");
  } finally {f.guidance.close();await rm(f.directory, {recursive: true, force: true});}
});

test("helper guidance defers on target owner input without routing to an eligible ancestor", async () => {
  const f = await makeFixture();
  try {
    const team = new SupervisorTeamStore(f.supervisors);
    const member = team.registerMember(f.binding, {threadId: "guide-owner-input-helper", taskId: "guide-owner-input-task", bootstrapRunId: "guide-owner-input-bootstrap"});
    const ready = team.markReady(f.binding, member.threadId, member.epoch);
    const parent = thread("guide-owner-input-parent", f.projectId, f.mainThreadId, "subagent");
    const targets = [
      thread("guide-owner-input-pending", f.projectId, parent.id, "subagent"),
      thread("guide-owner-input-resolved", f.projectId, parent.id, "subagent"),
      thread("guide-owner-input-expired", f.projectId, parent.id, "subagent"),
    ];
    const helper = thread(member.threadId, f.projectId, f.supervisorThreadId, "subagent");
    for (const item of [parent, ...targets]) Object.assign(item, {creationSource: "mcp", runtimeMode: "full-access", interactionMode: "default"});
    f.threads.push(parent, ...targets, helper);
    const parents = new Map(f.threads.map(item => [item.id, item.lineage.parentThreadId]));
    const assignment = team.assign(f.binding, parent.id, member.threadId, parents);
    for (const notification of team.snapshot(f.binding).notifications) {
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "sending");
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "delivered");
      team.acknowledgeNotification(f.binding, member.threadId, notification.id, ready.epoch);
    }
    team.completeTransfer(f.binding, parent.id, assignment.epoch);

    const projectionForRun = (value: ThreadInfo, runId: string, requestStatus?: string): Projection => {
      const rootNodeId = `${runId}-root`;
      const result = makeProjection(value.id, f.projectId);
      result.thread = value;
      result.runtimeRequests = requestStatus ? [{id: `${value.id}-question`, nodeId: rootNodeId, kind: "user_input", status: requestStatus}] : [];
      result.runs = [{id: runId, threadId: value.id, status: "running", ordinal: 1,
        requestedAt: "2026-10-16T10:00:00Z", startedAt: null, completedAt: null, rootNodeId, activeAttemptId: `${runId}-attempt`}];
      result.nodes = [{id: rootNodeId, threadId: value.id, runId, kind: "root_turn", rootNodeId, parentNodeId: null}];
      result.providerTurns = [{id: `${runId}-turn`, nodeId: rootNodeId, runAttemptId: `${runId}-attempt`, status: "running"}];
      if (requestStatus) result.turnItems = [{id: `${value.id}-question-item`, threadId: value.id, runId, nodeId: rootNodeId,
        type: "user_input_request", requestId: `${value.id}-question`, status: "pending"}];
      return result;
    };
    parent.activeRunId = "guide-owner-input-parent-run";
    const parentProjection = projectionForRun(parent, parent.activeRunId);
    f.projections.set(parent.id, parentProjection);
    const requestStatuses = ["pending", "resolved", "expired"] as const;
    for (const [index, status] of requestStatuses.entries()) {
      const target = targets[index]!;
      const runId = `guide-owner-input-target-run-${status}`;
      target.activeRunId = runId;
      Object.assign(target, {pendingRuntimeRequest: {id: `${target.id}-question`, nodeId: `${runId}-root`, kind: "user_input", status: "pending"}});
      f.projections.set(target.id, projectionForRun(target, runId, status));
    }
    f.projections.set(f.mainThreadId, makeProjection(f.mainThreadId, f.projectId));
    const own = makeProjection(member.threadId, f.projectId);
    Object.assign(own.thread, {runtimeMode: "full-access", interactionMode: "default"});
    f.projections.set(member.threadId, own);
    const actorFixture = {...f, supervisorThreadId: member.threadId, projection: own};
    const reader = new WorkflowWriteController({...f.controller.options, team});
    const sent: Record<string, unknown>[] = [];
    const controller = new SupervisorTeamController(reader, team, async (_tag, command) => {
      sent.push(command);
      return {sequence: sent.length};
    });
    const guide = async (target: ThreadInfo, operationId: string) => {
      const args = {supervisorThreadId: member.threadId, bindingGeneration: f.binding.generation, memberEpoch: ready.epoch,
        assignmentRootThreadId: parent.id, assignmentEpoch: assignment.epoch, operationId,
        targetThreadId: target.id, text: "Recheck the current native owner request before continuing."};
      installEvidence(actorFixture, args, {toolName: workflowToolNames.guide.direct[0]});
      return controller.guide(args, AbortSignal.timeout(1000)) as Promise<{status: string; reason?: string}>;
    };

    const pendingResult = await guide(targets[0]!, "guide-owner-input-pending");
    assert.deepEqual(pendingResult, {status: "denied", reason: "target_pending_owner_input"});
    assert.equal(sent.length, 0, "pending owner input prevents both target and ancestor dispatch");

    for (const [index, status] of ["resolved", "expired"].entries()) {
      const result = await guide(targets[index + 1]!, `guide-owner-input-${status}`);
      assert.equal(result.status, "accepted", `${status} current request status must clear stale shell and turn-item hints`);
      assert.equal(sent[index]?.threadId, targets[index + 1]!.id);
    }
  } finally {f.guidance.close();await rm(f.directory, {recursive: true, force: true});}
});

test("deferred owner guidance raises one stable attention after grace and routes only after resolution", async () => {
  const f = await makeFixture();
  try {
    const team = new SupervisorTeamStore(f.supervisors);
    const member = team.registerMember(f.binding, {threadId: "guide-deferred-helper", taskId: "guide-deferred-task", bootstrapRunId: "guide-deferred-bootstrap"});
    const ready = team.markReady(f.binding, member.threadId, member.epoch);
    const parent = thread("guide-deferred-parent", f.projectId, f.mainThreadId, "subagent");
    const target = thread("guide-deferred-target", f.projectId, parent.id, "subagent");
    const helper = thread(member.threadId, f.projectId, f.supervisorThreadId, "subagent");
    for (const item of [parent, target]) Object.assign(item, {creationSource: "mcp", runtimeMode: "full-access", interactionMode: "default"});
    f.threads.push(parent, target, helper);
    const parents = new Map(f.threads.map(item => [item.id, item.lineage.parentThreadId]));
    const assignment = team.assign(f.binding, parent.id, member.threadId, parents);
    for (const notification of team.snapshot(f.binding).notifications) {
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "sending");
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "delivered");
      team.acknowledgeNotification(f.binding, member.threadId, notification.id, ready.epoch);
    }
    team.completeTransfer(f.binding, parent.id, assignment.epoch);

    const projectionForRun = (value: ThreadInfo, runId: string): Projection => {
      const rootNodeId = `${runId}-root`;
      const result = makeProjection(value.id, f.projectId);
      result.thread = value;
      result.runtimeRequests = [];
      result.runs = [{id: runId, threadId: value.id, status: "running", ordinal: 1,
        requestedAt: "2026-10-16T10:00:00Z", startedAt: null, completedAt: null, rootNodeId, activeAttemptId: `${runId}-attempt`}];
      result.nodes = [{id: rootNodeId, threadId: value.id, runId, kind: "root_turn", rootNodeId, parentNodeId: null}];
      result.providerTurns = [{id: `${runId}-turn`, nodeId: rootNodeId, runAttemptId: `${runId}-attempt`, status: "running"}];
      return result;
    };
    parent.activeRunId = "guide-deferred-parent-run";
    target.activeRunId = "guide-deferred-target-run";
    const parentProjection = projectionForRun(parent, parent.activeRunId);
    const targetProjection = projectionForRun(target, target.activeRunId);
    f.projections.set(parent.id, parentProjection);
    f.projections.set(target.id, targetProjection);
    f.projections.set(f.mainThreadId, makeProjection(f.mainThreadId, f.projectId));
    const own = makeProjection(member.threadId, f.projectId);
    Object.assign(own.thread, {runtimeMode: "full-access", interactionMode: "default"});
    f.projections.set(member.threadId, own);
    const actorFixture = {...f, supervisorThreadId: member.threadId, projection: own};
    const reader = new WorkflowWriteController({...f.controller.options, team});
    const sent: Record<string, unknown>[] = [];
    const controller = new SupervisorTeamController(reader, team, async (_tag, command) => {
      sent.push(command);
      if (command.threadId === target.id) {
        const rootNodeId = `${target.activeRunId}-root`;
        const ownerRequest = {id: `${target.id}-owner-question`, nodeId: rootNodeId, kind: "user_input", status: "pending"};
        targetProjection.runtimeRequests = [ownerRequest];
        targetProjection.turnItems = [{id: `${target.id}-owner-question-item`, threadId: target.id, runId: target.activeRunId,
          nodeId: rootNodeId, type: "user_input_request", requestId: ownerRequest.id, status: "pending"}];
        Object.assign(target, {pendingRuntimeRequest: ownerRequest});
        throw new SupervisorRpcError("rejected", true);
      }
      return {sequence: sent.length};
    });
    const args = {supervisorThreadId: member.threadId, bindingGeneration: f.binding.generation, memberEpoch: ready.epoch,
      assignmentRootThreadId: parent.id, assignmentEpoch: assignment.epoch, operationId: "guide-deferred-owner-input",
      targetThreadId: target.id, text: "Recheck the target after its owner request is resolved."};
    installEvidence(actorFixture, args, {toolName: workflowToolNames.guide.direct[0]});

    const deferred = await controller.guide(args, AbortSignal.timeout(1000)) as {
      status: string; reason?: string; requestId: string; attempts: Array<{commandId: string; status: string}>;
    };
    assert.equal(deferred.status, "needs_fallback");
    assert.equal(deferred.reason, "target_pending_owner_input");
    assert.equal(deferred.attempts[0]?.status, "rejected");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.threadId, target.id);
    const guideRequest = team.unresolvedRequests(f.binding).find(request => request.requestId === deferred.requestId);
    assert.ok(guideRequest);
    assert.equal(team.hasBlockingWork(f.binding), true);

    const conversationRequests = new SupervisorConversationStore(f.guidance);
    const deferredView = supervisorTeamView(team, f.binding, f.threads, conversationRequests);
    assert.match(deferredView.members[0]?.currentState ?? "", /deferred for an owner decision/u);
    assert.doesNotMatch(deferredView.members[0]?.currentState ?? "", /awaiting native-history confirmation/u);

    await controller.reconcile(f.binding, AbortSignal.timeout(1000), guideRequest.updatedAt);
    const attentionId = `guide-deferred:${deferred.requestId}`;
    assert.equal(team.snapshot(f.binding).events.some(event => event.id === attentionId), false);
    assert.equal(sent.length, 1, "reconciliation does not route around a pending owner decision");
    await controller.reconcile(f.binding, AbortSignal.timeout(1000), guideRequest.updatedAt + 60_001);
    let attention = team.snapshot(f.binding).events.filter(event => event.id === attentionId);
    assert.equal(attention.length, 1);
    assert.equal(attention[0]?.kind, "service_attention");
    assert.match(attention[0]?.summary ?? "", /pending native owner decision/u);
    assert.equal(sent.length, 1);
    await controller.reconcile(f.binding, AbortSignal.timeout(1000), guideRequest.updatedAt + 120_001);
    attention = team.snapshot(f.binding).events.filter(event => event.id === attentionId);
    assert.equal(attention.length, 1, "repeated checks reuse the stable attention event");
    assert.equal(sent.length, 1);

    (targetProjection.runtimeRequests as Array<Record<string, unknown>>)[0]!.status = "resolved";
    await controller.reconcile(f.binding, AbortSignal.timeout(1000), guideRequest.updatedAt + 120_002);
    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.threadId, parent.id, "the same operation routes through the eligible ancestor after fresh resolution");
    assert.notEqual(sent[1]?.commandId, sent[0]?.commandId);
    assert.equal(team.unresolvedRequests(f.binding).some(request => request.requestId === deferred.requestId), true);
    assert.equal(supervisorTeamView(team, f.binding, f.threads, conversationRequests).members[0]?.currentState?.includes("deferred for an owner decision"), false);
    await controller.reconcile(f.binding, AbortSignal.timeout(1000), guideRequest.updatedAt + 120_003);
    assert.equal(sent.length, 2, "accepted ancestor guidance is never retransmitted with another identity");
  } finally {f.guidance.close();await rm(f.directory, {recursive: true, force: true});}
});

test("helper guidance records a pre-open transport refusal as not sent without ancestor fallback or a pending-effect fence", async () => {
  const f = await makeFixture();
  const server = createServer();
  let upgrades = 0;
  server.on("upgrade", (_request, socket) => {upgrades += 1;socket.destroy();});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const team = new SupervisorTeamStore(f.supervisors);
    const member = team.registerMember(f.binding, {threadId: "guide-not-sent-helper", taskId: "guide-not-sent-task", bootstrapRunId: "guide-not-sent-bootstrap"});
    const ready = team.markReady(f.binding, member.threadId, member.epoch);
    const parent = thread("guide-not-sent-parent", f.projectId, f.mainThreadId, "subagent");
    const target = thread("guide-not-sent-target", f.projectId, parent.id, "subagent");
    const helper = thread(member.threadId, f.projectId, f.supervisorThreadId, "subagent");
    for (const item of [parent, target]) Object.assign(item, {creationSource: "mcp", runtimeMode: "full-access", interactionMode: "default"});
    f.threads.push(parent, target, helper);
    const parents = new Map(f.threads.map(item => [item.id, item.lineage.parentThreadId]));
    const assignment = team.assign(f.binding, parent.id, member.threadId, parents);
    for (const notification of team.snapshot(f.binding).notifications) {
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "sending");
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "delivered");
      team.acknowledgeNotification(f.binding, member.threadId, notification.id, ready.epoch);
    }
    team.completeTransfer(f.binding, parent.id, assignment.epoch);

    const projectionForRun = (value: ThreadInfo, runId: string) => {
      const projection = makeProjection(value.id, f.projectId);
      projection.thread = value;
      projection.runtimeRequests = [];
      projection.runs = [{id: runId, threadId: value.id, status: "running", ordinal: 1,
        requestedAt: "2026-10-16T10:00:00Z", startedAt: null, completedAt: null, rootNodeId: `${runId}-root`, activeAttemptId: `${runId}-attempt`}];
      projection.providerTurns = [{id: `${runId}-turn`, nodeId: `${runId}-root`, runAttemptId: `${runId}-attempt`, status: "running"}];
      return projection;
    };
    parent.activeRunId = "guide-not-sent-parent-run";
    target.activeRunId = "guide-not-sent-target-run";
    const parentProjection = projectionForRun(parent, parent.activeRunId);
    const targetProjection = projectionForRun(target, target.activeRunId);
    const own = makeProjection(member.threadId, f.projectId);
    Object.assign(own.thread, {runtimeMode: "full-access", interactionMode: "default"});
    f.projections.set(parent.id, parentProjection);
    f.projections.set(target.id, targetProjection);
    f.projections.set(f.mainThreadId, makeProjection(f.mainThreadId, f.projectId));
    f.projections.set(member.threadId, own);

    const actorFixture = {...f, supervisorThreadId: member.threadId, projection: own};
    const reader = new WorkflowWriteController({...f.controller.options, team});
    const controller = new SupervisorTeamController(reader, team,
      makeSupervisorRpc(`http://127.0.0.1:${address.port}`, "team-guide-preopen-token"));
    const args = {supervisorThreadId: member.threadId, bindingGeneration: f.binding.generation, memberEpoch: ready.epoch,
      assignmentRootThreadId: parent.id, assignmentEpoch: assignment.epoch, operationId: "guide-preopen-refusal",
      targetThreadId: target.id, text: "Recheck the failing child before continuing."};
    installEvidence(actorFixture, args, {toolName: workflowToolNames.guide.direct[0]});

    const result = await controller.guide(args, AbortSignal.timeout(3000)) as {
      status: string; reason: string; attempts: Array<{routedThreadId: string; status: string}>;
    };
    assert.equal(result.status, "not_sent");
    assert.equal(result.reason, "native_transport_not_sent");
    assert.equal(result.attempts.length, 1, "a pre-open failure does not create a second ancestor route");
    assert.equal(result.attempts[0]?.routedThreadId, target.id);
    assert.equal(result.attempts[0]?.status, "not_sent");
    assert.equal(upgrades, 1);
    assert.equal(team.unresolvedRequests(f.binding).length, 0, "a command that never reached T3 does not retain a pending-effect fence");
    assert.equal(team.authorizeWrite(f.binding, member.threadId, target.id, parents,
      {memberEpoch: ready.epoch, assignmentRootThreadId: parent.id, assignmentEpoch: assignment.epoch}), true);
    assert.equal(team.snapshot(f.binding).events.some(event => event.kind === "service_attention"), false);
    assert.deepEqual(await controller.guide(args, AbortSignal.timeout(1000)), result, "same-operation replay returns the settled not-sent receipt");
    assert.equal(upgrades, 1, "same-operation receipt replay does not open another native connection");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.guidance.close();
    await rm(f.directory, {recursive: true, force: true});
  }
});

test("helper guidance replays a received dispatch failure with the exact command before steering its nearest same-assignment ancestor", async () => {
  const f = await makeFixture();
  const server = new WebSocketServer({port: 0});
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const calls: Record<string, unknown>[] = [];
  const counts = new Map<string, number>();
  server.on("connection", socket => socket.on("message", data => {
    const frame: unknown = JSON.parse(data.toString());
    assert.ok(typeof frame === "object" && frame !== null);
    const request = frame as Record<string, unknown>;
    if (request._tag !== "Request" || request.tag !== "orchestration.dispatchCommand" || typeof request.payload !== "object" || request.payload === null) return;
    const command = request.payload as Record<string, unknown>;
    calls.push(command);
    const commandId = String(command.commandId);
    const count = (counts.get(commandId) ?? 0) + 1;
    counts.set(commandId, count);
    const exit = command.threadId === "guide-replay-target"
      ? { _tag: "Failure", cause: { _tag: "Fail", failure: { _tag: count === 1
        ? "OrchestrationV2DispatchCommandError" : "OrchestratorCommandPreviouslyRejectedError" } } }
      : { _tag: "Success", value: {sequence: calls.length} };
    socket.send(JSON.stringify({_tag: "Exit", requestId: request.id, exit}));
  }));
  try {
    const team = new SupervisorTeamStore(f.supervisors);
    const member = team.registerMember(f.binding, {threadId: "guide-replay-helper", taskId: "guide-replay-task", bootstrapRunId: "guide-replay-bootstrap"});
    const ready = team.markReady(f.binding, member.threadId, member.epoch);
    const parent = thread("guide-replay-parent", f.projectId, f.mainThreadId, "subagent");
    const target = thread("guide-replay-target", f.projectId, parent.id, "subagent");
    const helper = thread(member.threadId, f.projectId, f.supervisorThreadId, "subagent");
    for (const item of [parent, target]) Object.assign(item, {creationSource: "mcp", runtimeMode: "full-access", interactionMode: "default"});
    f.threads.push(parent, target, helper);
    const parents = new Map(f.threads.map(item => [item.id, item.lineage.parentThreadId]));
    const assignment = team.assign(f.binding, parent.id, member.threadId, parents);
    for (const notification of team.snapshot(f.binding).notifications) {
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "sending");
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "delivered");
      team.acknowledgeNotification(f.binding, member.threadId, notification.id, ready.epoch);
    }
    team.completeTransfer(f.binding, parent.id, assignment.epoch);

    const projectionForRun = (value: ThreadInfo, runId: string) => {
      const projection = makeProjection(value.id, f.projectId);
      projection.thread = value;
      projection.runtimeRequests = [];
      projection.runs = [{id: runId, threadId: value.id, status: "running", ordinal: 1,
        requestedAt: "2026-10-16T10:00:00Z", startedAt: null, completedAt: null, rootNodeId: `${runId}-root`, activeAttemptId: `${runId}-attempt`}];
      projection.providerTurns = [{id: `${runId}-turn`, nodeId: `${runId}-root`, runAttemptId: `${runId}-attempt`, status: "running"}];
      return projection;
    };
    parent.activeRunId = "guide-replay-parent-run";
    target.activeRunId = "guide-replay-target-run";
    const parentProjection = projectionForRun(parent, "guide-replay-parent-run");
    const targetProjection = projectionForRun(target, "guide-replay-target-run");
    const mainProjection = makeProjection(f.mainThreadId, f.projectId);
    const own = makeProjection(member.threadId, f.projectId);
    Object.assign(own.thread, {runtimeMode: "full-access", interactionMode: "default"});
    f.projections.set(parent.id, parentProjection);
    f.projections.set(target.id, targetProjection);
    f.projections.set(f.mainThreadId, mainProjection);
    f.projections.set(member.threadId, own);
    const actorFixture = {...f, supervisorThreadId: member.threadId, projection: own};
    const reader = new WorkflowWriteController({...f.controller.options, team});
    const controller = new SupervisorTeamController(reader, team,
      makeSupervisorRpc(`http://127.0.0.1:${address.port}`, "team-guide-test-token"));
    const args = {supervisorThreadId: member.threadId, bindingGeneration: f.binding.generation, memberEpoch: ready.epoch,
      assignmentRootThreadId: parent.id, assignmentEpoch: assignment.epoch, operationId: "guide-replay",
      targetThreadId: target.id, text: "Recheck the blocked test before marking this subtree complete."};
    installEvidence(actorFixture, args, {toolName: workflowToolNames.guide.direct[0]});

    const result = await controller.guide(args, AbortSignal.timeout(3000)) as {
      status: string; attempts: Array<{routedThreadId: string; commandId: string; messageId: string; targetRunId: string; status: string; dispatchFailureReplayAttempted?: boolean}>;
    };
    assert.equal(result.status, "accepted");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], calls[1], "the server-failure replay must preserve the full native command payload");
    assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1]), "the persisted replay uses the same serialized command bytes");
    assert.equal(calls[0]!.threadId, target.id);
    assert.equal(calls[0]!.commandId, calls[1]!.commandId);
    assert.equal(calls[0]!.messageId, calls[1]!.messageId);
    assert.deepEqual(calls[0]!.dispatchMode, {type: "steer_active", targetRunId: target.activeRunId});
    assert.equal(calls[2]!.threadId, parent.id, "fallback uses the nearest eligible ancestor in the assigned subtree");
    assert.notEqual(calls[2]!.commandId, calls[0]!.commandId);
    assert.notEqual(calls[2]!.messageId, calls[0]!.messageId);
    assert.deepEqual(calls[2]!.dispatchMode, {type: "steer_active", targetRunId: parent.activeRunId});
    assert.equal(result.attempts[0]?.dispatchFailureReplayAttempted, true);
    assert.equal(result.attempts[0]?.status, "rejected");
    assert.equal(result.attempts[1]?.status, "accepted");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.guidance.close();
    await rm(f.directory, {recursive: true, force: true});
  }
});

test("root quarantine uses native team proof and preserves unresolved requests while fencing helper authority", async () => {
  assert.ok((supervisionTeamToolDefinition.inputSchema.properties.action.enum as readonly string[]).includes("quarantine"));
  const f = await makeFixture();
  try {
    const team = new SupervisorTeamStore(f.supervisors);
    const member = team.registerMember(f.binding, {threadId: "quarantine-helper", taskId: "quarantine-task", bootstrapRunId: "quarantine-bootstrap"});
    const ready = team.markReady(f.binding, member.threadId, member.epoch);
    const target = thread("quarantine-target", f.projectId, f.mainThreadId, "subagent");
    f.threads.push(target, thread(member.threadId, f.projectId, f.supervisorThreadId, "subagent"));
    const parents = new Map(f.threads.map(item => [item.id, item.lineage.parentThreadId]));
    const assignment = team.assign(f.binding, target.id, member.threadId, parents);
    for (const notification of team.snapshot(f.binding).notifications) {
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "sending");
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "delivered");
      team.acknowledgeNotification(f.binding, member.threadId, notification.id, ready.epoch);
    }
    team.completeTransfer(f.binding, target.id, assignment.epoch);
    team.recordRequest(f.binding, {requestId: "guide:uncertain-before-quarantine", memberThreadId: member.threadId, memberEpoch: ready.epoch,
      targets: [{targetThreadId: target.id, assignmentRootThreadId: target.id, assignmentEpoch: assignment.epoch}], parentById: parents});
    team.setRequestState(f.binding, f.binding.threadId, "guide:uncertain-before-quarantine", 0, "uncertain");

    const args = {supervisorThreadId: f.supervisorThreadId, bindingGeneration: f.binding.generation,
      action: "quarantine", operationId: "quarantine-helper", memberThreadId: member.threadId};
    installEvidence(f, args, {toolName: workflowToolNames.team.direct[0]});
    const reader = new WorkflowWriteController({...f.controller.options, team});
    const controller = new SupervisorTeamController(reader, team, null);
    const result = await controller.call(args, AbortSignal.timeout(1000)) as {status: string; result: {state: string; epoch: number}};

    assert.equal(result.status, "ok");
    assert.equal(result.result.state, "quarantined");
    assert.equal(result.result.epoch, ready.epoch + 1);
    assert.equal(team.coverage(f.binding, target.id, parents).state, "unavailable", "unresolved requests keep root coverage observe-only");
    assert.equal(team.authorizeWrite(f.binding, f.supervisorThreadId, target.id, parents), false);
    assert.equal(team.unresolvedRequests(f.binding).some(request => request.requestId === "guide:uncertain-before-quarantine"), true);
    assert.equal(team.snapshot(f.binding).events.some(event => event.kind === "member_quarantined" && event.memberThreadId === member.threadId), true);
  } finally {f.guidance.close();await rm(f.directory, {recursive: true, force: true});}
});

test("root team retry restarts a definitely rejected note without changing an unknown guide effect", async () => {
  const f = await makeFixture();
  try {
    const team = new SupervisorTeamStore(f.supervisors);
    const member = team.registerMember(f.binding, {threadId: "retry-notice-helper", taskId: "retry-notice-task", bootstrapRunId: "retry-notice-bootstrap"});
    const ready = team.markReady(f.binding, member.threadId, member.epoch);
    const target = thread("retry-notice-target", f.projectId, f.mainThreadId, "subagent");
    f.threads.push(target, thread(member.threadId, f.projectId, f.supervisorThreadId, "subagent"));
    const parents = new Map(f.threads.map(item => [item.id, item.lineage.parentThreadId]));
    const assignment = team.assign(f.binding, target.id, member.threadId, parents);
    for (const notification of team.snapshot(f.binding).notifications) {
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "sending");
      team.updateNotificationDelivery(f.binding, f.supervisorThreadId, notification.id, "delivered");
      team.acknowledgeNotification(f.binding, member.threadId, notification.id, ready.epoch);
    }
    team.completeTransfer(f.binding, target.id, assignment.epoch);
    const targetCoverage = team.coverage(f.binding, target.id, parents);
    team.recordRequest(f.binding, {requestId: "guide:unrelated-unknown-target", memberThreadId: member.threadId, memberEpoch: ready.epoch,
      targets: [{targetThreadId: target.id, assignmentRootThreadId: targetCoverage.assignmentRootThreadId!, assignmentEpoch: targetCoverage.assignmentEpoch!}], parentById: parents});
    team.setRequestState(f.binding, f.binding.threadId, "guide:unrelated-unknown-target", 0, "uncertain");
    const unresolvedBefore = team.unresolvedRequests(f.binding);
    const failed = team.note(f.binding, {eventId: "failed-notice-event", notificationId: "failed-notice", memberThreadId: member.threadId,
      memberEpoch: ready.epoch, message: "Review the handover plan."});
    team.markNotificationRejected(f.binding, f.supervisorThreadId, failed.id, "T3 rejected the notice.", failed.deliveryAttempt);
    const uncertain = team.note(f.binding, {eventId: "uncertain-notice-event", notificationId: "uncertain-notice", memberThreadId: member.threadId,
      memberEpoch: ready.epoch, message: "The second handover outcome is unknown."});
    team.updateNotificationDelivery(f.binding, f.supervisorThreadId, uncertain.id, "sending");
    team.updateNotificationDelivery(f.binding, f.supervisorThreadId, uncertain.id, "uncertain");

    const args = {supervisorThreadId: f.supervisorThreadId, bindingGeneration: f.binding.generation,
      action: "retry", operationId: "retry-failed-team-notices", memberThreadId: member.threadId};
    installEvidence(f, args, {toolName: workflowToolNames.team.direct[0]});
    const reader = new WorkflowWriteController({...f.controller.options, team});
    const controller = new SupervisorTeamController(reader, team, null);
    const result = await controller.call(args, AbortSignal.timeout(1000)) as {
      status: string; result: {retriedNotifications: number; pendingRequestsRemain: boolean};
    };
    const notifications = team.snapshot(f.binding).notifications;
    const retried = notifications.find(item => item.id === failed.id);
    const retained = notifications.find(item => item.id === uncertain.id);

    assert.equal(result.status, "ok");
    assert.equal(result.result.retriedNotifications, 1);
    assert.equal(result.result.pendingRequestsRemain, true);
    assert.deepEqual(team.unresolvedRequests(f.binding), unresolvedBefore, "the unknown guide request stays byte-for-byte unchanged");
    assert.equal(team.coverage(f.binding, target.id, parents).state, "assigned", "retry leaves the operational assignment unchanged");
    assert.equal(team.coverage(f.binding, target.id, parents).actorThreadId, member.threadId);
    assert.equal(team.authorizeWrite(f.binding, f.binding.threadId, target.id, parents), false);
    assert.equal(retried?.state, "pending");
    assert.equal(retried?.deliveryAttempt, failed.deliveryAttempt + 1);
    assert.equal(retained?.state, "uncertain");
    assert.equal(retained?.deliveryAttempt, uncertain.deliveryAttempt);
  } finally {f.guidance.close();await rm(f.directory, {recursive: true, force: true});}
});
