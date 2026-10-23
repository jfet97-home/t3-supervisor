import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../../src/guidance-store.js";
import { defaultSupervisorModel, type BindingRecord, type TaskRecord } from "../../src/project-supervisor-store.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import type { WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo, WorkflowSourceBindingInfo } from "../../src/project-supervisor-contract.js";
import { proposalContextFromDefinitions, validateWorkflowPlan } from "../../src/supervisor-workflow.js";
import type { Projection, ThreadInfo } from "../../src/types.js";
import type { WorkflowApplyPatch } from "../../src/workflow-write-controller.js";
import { workflowToolNames } from "../../src/workflow-write-evidence.js";
import { effectiveIndex, projectIndex } from "../project-definitions-fixture.js";
import { nativeReadRoutes, nativeReadState, startIntPeer, type IntNativePeer, type NativeReadState, type ShellThread } from "./int-native-peer.js";
import { openIntSupervision, startIntEndpoint, type IntEndpoint, type IntSupervision } from "./int-production-wiring.js";

// builders copied from test/workflow-write-controller.test.ts (:49-60, :62-88, :90-206, :218-279, :285-298), values unchanged

export const thread = (id: string, projectId: string, parentThreadId: string | null = null, relationshipToParent: string | null = null,
  rootThreadId?: string): ThreadInfo => ({id, title: id, projectId, archivedAt: null, deletedAt: null,
  lineage: {parentThreadId, relationshipToParent,
    ...(rootThreadId ? {rootThreadId} : {})}});

export const makeProjection = (supervisorThreadId: string, projectId: string): Projection => ({
  thread: thread(supervisorThreadId, projectId),
  runs: [],
  messages: [],
  nodes: [],
  turnItems: [],
});

export const localStep = (name: string, description: string, contributorThreadIds: readonly string[] = [], nodeId?: string) => ({
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

export const sequencePlan = (nodes: readonly unknown[], templatePath: string | null = null): WorkflowPlanGroupInfo => ({
  kind: "sequence",
  templatePath,
  nodes: [...nodes] as WorkflowPlanNodeInfo[],
});

export const shellThread = (value: ThreadInfo): ShellThread => ({...value, latestRunId: null});

export type DefinitionReader = {current: ProjectDefinitionSnapshot; calls: number; onLoad: (() => void) | null};

export type IntWorkflowFixture = {
  directory: string;
  peer: IntNativePeer;
  native: NativeReadState;
  core: IntSupervision;
  endpoint: IntEndpoint;
  binding: BindingRecord;
  projectId: string;
  mainThreadId: string;
  supervisorThreadId: string;
  catalogThreads: ThreadInfo[];
  projection: Projection;
  details: Map<string, unknown>;
  definitionReader: DefinitionReader;
  proposal: WorkflowProposalInfo;
  sourceBinding: WorkflowSourceBindingInfo;
  close(): Promise<void>;
};

// seeds the controller suite's fixture rows into a production-wired service whose native reads go over a loopback peer
export const startWorkflowFixture = async (mainThread = thread("main-workflows", "project-workflows")): Promise<IntWorkflowFixture> => {
  const native = nativeReadState();
  const peer = await startIntPeer([nativeReadRoutes(native)]);
  const directory = await mkdtemp(join(tmpdir(), "native-authority-integration-"));
  const projectId = "project-workflows";
  const mainThreadId = mainThread.id;
  const catalogThreads: ThreadInfo[] = [mainThread];
  const definitionReader: DefinitionReader = {current: null as unknown as ProjectDefinitionSnapshot, calls: 0, onLoad: null};
  const definitions = {load: async () => {definitionReader.calls++;definitionReader.onLoad?.();return definitionReader.current;}};
  const core = await openIntSupervision({directory, peerUrl: peer.baseUrl, definitions,
    catalog: () => ({projects: [{project: {id: projectId, title: "Project workflows", workspaceRoot: "/workspace/project-workflows"}, available: true}],
      threads: catalogThreads})});
  const {guidance, store: supervisors} = core;
  const supervisorControl = async (scope: string | null, enabled: boolean) => await guidance.db.prepare(
    "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(`supervisor_control:${JSON.stringify(scope)}`, JSON.stringify({generation: 1, enabled, manual: true}));
  await supervisorControl(null, true);
  await supervisorControl(projectId, true);
  const reserved = await supervisors.reserve(projectId, mainThreadId, "Main thread", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  await supervisors.setBinding(binding);
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
    config: effectiveIndex({steps: [], workflows: []}),
    projectConfig: projectIndex(),
    definitionFiles: [],
    complete: true,
    sources: [],
    issues: [],
  };
  definitionReader.current = definitionSnapshot;
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
  await supervisors.saveTask(task);
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
  catalogThreads.push(thread(supervisorThreadId, projectId));
  native.shellThreads = catalogThreads.map(shellThread);
  const projection = makeProjection(supervisorThreadId, projectId);
  native.projections.set(supervisorThreadId, projection);
  // sets catalogClassificationsReady, without which workflowEditingEnabled denies every write (project-supervisor.ts:130-136,165)
  await core.supervision.candidates("");
  const endpoint = await startIntEndpoint(core);
  return {directory, peer, native, core, endpoint, binding, projectId, mainThreadId, supervisorThreadId, catalogThreads, projection,
    details: native.details, definitionReader, proposal, sourceBinding,
    close: async () => {
      try {await endpoint.close();}
      finally {
        try {await core.close();}
        finally {
          try {await peer.close();}
          finally {await rm(directory, {recursive: true, force: true});}
        }
      }
    }};
};

export const locator = (fixture: IntWorkflowFixture) => ({
  supervisorThreadId: fixture.supervisorThreadId,
  bindingGeneration: fixture.binding.generation,
});

export const ensureArgs = (fixture: IntWorkflowFixture, operationId: string, note: string) => ({
  action: "ensure_main",
  ...locator(fixture),
  operationId,
  note,
});

export const installEvidence = (fixture: Pick<IntWorkflowFixture, "supervisorThreadId" | "projection" | "details">, args: Record<string, unknown>, options: {
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

export const applyArgs = async (fixture: IntWorkflowFixture, input: WorkflowApplyPatch) => {
  const current = (await fixture.core.supervision.workflowStates.list(fixture.projectId, fixture.mainThreadId)).find(document => document.workflowId === input.workflowId);
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
