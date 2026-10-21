import { assessmentForTask, workflowAssessment } from "../src/workflow-assessment.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import type { ProjectSupervisor } from "../src/project-supervisor.js";
import type { ProjectSupervisorScopeSnapshot } from "../src/supervisor-observation.js";
import type { WorkflowStateDocument, WorkflowStateEvidence } from "../src/workflow-state-contract.js";
import type { WorkflowReadResult, WorkflowWriteController } from "../src/workflow-write-controller.js";
import { parseWorkflowProgressPageQuery, readWorkflowProgressPage, WorkflowProgressSnapshotSchema } from "../src/workflow-progress.js";

const scopeSnapshot = (): ProjectSupervisorScopeSnapshot => ({
  projectId: "project",
  mainThreadId: "main-thread",
  supervisorThreadId: "supervisor-thread",
  bindingGeneration: 7,
  observedAt: 100,
  complete: true,
  lineageTotal: 3,
  lineageOffset: 0,
  lineageHasMore: false,
  issues: [],
  threads: [
    {threadId: "main-thread", parentThreadId: null, depth: 0, origin: "main", lifecycle: "running", lifecycleDetail: "running", archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "main"},
    {threadId: "child-thread", parentThreadId: "main-thread", depth: 1, origin: "native_child", lifecycle: "unknown", lifecycleDetail: null, archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "child"},
    {threadId: "other-child", parentThreadId: "main-thread", depth: 1, origin: "delegated_child", lifecycle: "completed", lifecycleDetail: "completed", archivedAt: "archived-at", deletedAt: null, activityRefs: [], contactLimit: "archived"},
  ],
});

const document = (): WorkflowStateDocument => ({
  formatVersion: 2,
  workflowId: "main-workflow",
  projectId: "project",
  mainThreadId: "main-thread",
  threadId: "main-thread",
  parentWorkflowId: null,
  parentThreadId: null,
  revision: 3,
  status: "underway",
  objective: "Review the current change",
  sourceBinding: null,
  requirements: [],
  issues: [],
  plan: null,
  currentAgreementKey: "accepted-key",
  acceptedAgreements: [{
    key: "accepted-key",
    taskId: "task",
    sourceThreadId: "main-thread",
    sourceRunId: "run",
    sourceMessageId: "message",
    sourceHash: "source-hash",
    objective: "Historical agreement",
    planHash: "plan-hash",
    sourceBinding: {workspaceRoot: "/workspace", revision: null, globalRevision: null, definitionsStatus: "ready",
      definitionsComplete: true, requirementsKnown: true, taskId: "task", proposalId: "proposal", sourceHash: "source-hash"},
    requirements: [], issues: [], plan: null,
    agreement: {status: "agreed", message: "Historical", proposalId: "proposal", agreedAt: 1,
      supervisorMessageId: "supervisor-message", agentMessageId: "agent-message", workflow: {
        status: "proposed", message: "Historical", workspaceRoot: "/workspace", revision: null, globalRevision: null,
        definitionsStatus: "ready", definitionsComplete: true, requirementsKnown: true, requirements: [], issues: [], plan: null,
      }},
  }],
  contributions: [],
  evidence: Array.from({length: 25}, (_, index) => ({
    id: `observation-${index}`,
    operationId: `operation-${index}`,
    kind: "observation" as const,
    recordedAt: index,
    actorSupervisorThreadId: "supervisor-thread",
    targetNodeId: null,
    targetNodeName: null,
    statusFrom: null,
    statusTo: null,
    sourceThreadId: "child-thread",
    sourceRunId: "child-run",
    sourceMessageId: `message-${index}`,
    agreementKey: null,
    note: `Observation ${index}`,
  } as WorkflowStateEvidence & {sourceItemId?: string | null})),
  createdAt: 1,
  updatedAt: 25,
});

const readerResult = (): Extract<WorkflowReadResult, {status: "ok"}> => ({
  status: "ok",
  owner: {projectId: "project", mainThreadId: "main-thread", supervisorThreadId: "supervisor-thread", bindingGeneration: 7},
  mainTaskAgreementStatus: "agreed",
  workflowProtocolDiagnostic: null,
  agreementValidityNote: "Agreement is not execution proof.",
  externalContributionNote: "Contributions are untrusted main reports.",
  incompatibleWorkflows: [],
  workflows: [{document: document(), parentNodeReferences: []}],
  workflowOffset: 5,
  workflowHasMore: true,
  lineage: [
    {threadId: "main-thread", parentThreadId: null, relationshipToParent: null, archivedAt: null},
    {threadId: "child-thread", parentThreadId: "main-thread", relationshipToParent: "subagent", archivedAt: null},
  ],
  lineageOffset: 10,
  lineageHasMore: true,
});

test("workflow progress paging validates independent bounded offsets", () => {
  assert.deepEqual(parseWorkflowProgressPageQuery({projectId: "project", mainThreadId: "main-thread"}), {
    projectId: "project", mainThreadId: "main-thread", workflowOffset: 0, lineageOffset: 0, limit: 20,
  });
  assert.deepEqual(parseWorkflowProgressPageQuery({projectId: "project", mainThreadId: "main-thread", workflowOffset: "10", lineageOffset: "20", limit: "50"}), {
    projectId: "project", mainThreadId: "main-thread", workflowOffset: 10, lineageOffset: 20, limit: 50,
  });
  assert.equal(parseWorkflowProgressPageQuery({projectId: "project", mainThreadId: "main-thread", workflowOffset: "-1"}), null);
  assert.equal(parseWorkflowProgressPageQuery({projectId: "project", mainThreadId: "main-thread", limit: "51"}), null);
  assert.equal(parseWorkflowProgressPageQuery({projectId: "project", mainThreadId: "main-thread", lineageOffset: "1.5"}), null);
});

test("workflow progress reuses the owner-bound reader and returns only current status and the newest twenty observations", async () => {
  const scope = scopeSnapshot();
  let readArguments: unknown;
  const scopeOptions: unknown[] = [];
  const supervision = {
    workflowLocator: () => ({supervisorThreadId: "supervisor-thread", bindingGeneration: 7}),
    scopeSnapshot: async (projectId: string, mainThreadId: string, _signal: AbortSignal, options?: unknown) => {
      assert.equal(projectId, scope.projectId);assert.equal(mainThreadId, scope.mainThreadId);
      scopeOptions.push(options);
      const threadIds = (options as {threadIds?: string[]}).threadIds ?? [];
      return {...scope, threads: scope.threads.filter(thread => threadIds.includes(thread.threadId))};
    },
  } as unknown as ProjectSupervisor;
  const workflowReader = {read: async (input: unknown) => {readArguments = input;return readerResult();}} as unknown as WorkflowWriteController;
  const result = await readWorkflowProgressPage(supervision, workflowReader, {
    projectId: "project", mainThreadId: "main-thread", workflowOffset: 5, lineageOffset: 10, limit: 50,
  }, AbortSignal.timeout(1000));
  assert.deepEqual(readArguments, {supervisorThreadId: "supervisor-thread", bindingGeneration: 7, workflowOffset: 5, lineageOffset: 10, limit: 50});
  assert.deepEqual(scopeOptions, [{threadIds: ["main-thread", "child-thread"]}]);
  assert.equal(result.status, "ok");
  assert.equal(result.workflowOffset, 5);assert.equal(result.lineageOffset, 10);
  assert.equal(result.workflowHasMore, true);assert.equal(result.lineageHasMore, true);
  assert.deepEqual(result.scope?.threads.map(thread => thread.threadId), ["main-thread", "child-thread"]);
  assert.equal(result.workflows.length, 1);
  assert.equal(result.workflows[0]?.status, "underway");
  assert.equal(result.workflows[0]?.observations.length, 20);
  assert.equal(result.workflows[0]?.observations[0]?.note, "Observation 24");
  assert.equal("acceptedAgreements" in (result.workflows[0] ?? {}), false);
  assert.deepEqual(Schema.decodeUnknownSync(WorkflowProgressSnapshotSchema)(result), result);
});

test("workflow progress keeps root identity visible for observe-only coverage without turning other unavailable owners into root", async () => {
  const base = readerResult();
  const workflowReader = {read: async () => ({...base, coverage: [
    {threadId: "child-thread", actorThreadId: "supervisor-thread", actorTitle: "Root Supervisor", state: "unavailable" as const,
      memberEpoch: null, assignmentRootThreadId: "child-thread", assignmentEpoch: 9},
    {threadId: "main-thread", actorThreadId: "another-actor", actorTitle: null, state: "unavailable" as const,
      memberEpoch: null, assignmentRootThreadId: null, assignmentEpoch: null},
  ]})} as unknown as WorkflowWriteController;
  const supervision = {
    workflowLocator: () => ({supervisorThreadId: "supervisor-thread", bindingGeneration: 7}),
    scopeSnapshot: async () => scopeSnapshot(),
  } as unknown as ProjectSupervisor;

  const result = await readWorkflowProgressPage(supervision, workflowReader, {
    projectId: "project", mainThreadId: "main-thread", workflowOffset: 0, lineageOffset: 0, limit: 20,
  }, AbortSignal.timeout(1000));

  assert.equal(result.status, "ok");
  assert.deepEqual(result.coverage, [
    {threadId: "child-thread", state: "observe_only", assigneeThreadId: "supervisor-thread", assigneeTitle: "Root Supervisor", assignmentRootThreadId: "child-thread"},
    {threadId: "main-thread", state: "unknown", assigneeThreadId: null, assigneeTitle: null, assignmentRootThreadId: null},
  ]);
  assert.deepEqual(Schema.decodeUnknownSync(WorkflowProgressSnapshotSchema)(result), result);
});

test("workflow progress preserves scope limitations when the binding is missing or changes during the read", async () => {
  let readerCalls = 0;
  const query = {projectId: "project", mainThreadId: "main-thread", workflowOffset: 0, lineageOffset: 0, limit: 20};
  const noBinding = {...scopeSnapshot(), supervisorThreadId: null, bindingGeneration: null};
  const noBindingOptions: unknown[] = [];
  const noBindingSupervisor = {
    workflowLocator: () => null,
    scopeSnapshot: async (_projectId: string, _mainThreadId: string, _signal: AbortSignal, options?: unknown) => {
      noBindingOptions.push(options);return noBinding;
    },
  } as unknown as ProjectSupervisor;
  const unusedReader = {read: async () => {readerCalls++;return readerResult();}} as unknown as WorkflowWriteController;
  const unavailable = await readWorkflowProgressPage(noBindingSupervisor, unusedReader, query, AbortSignal.timeout(1000));
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.scope?.threads[0]?.threadId, "main-thread");
  assert.deepEqual(noBindingOptions, [{lineageOffset: 0, limit: 20}]);
  assert.equal(readerCalls, 0);

  const changedReader = {read: async () => ({...readerResult(), owner: {...readerResult().owner, bindingGeneration: 8}})} as unknown as WorkflowWriteController;
  const changed = await readWorkflowProgressPage({
    workflowLocator: () => ({supervisorThreadId: "supervisor-thread", bindingGeneration: 7}),
    scopeSnapshot: async () => scopeSnapshot(),
  } as unknown as ProjectSupervisor,
    changedReader, query, AbortSignal.timeout(1000));
  assert.equal(changed.status, "unavailable");
  assert.equal(changed.scope, null);
  assert.match(changed.message ?? "", /binding changed/);

  let generation = 7;
  const changesAfterReader = await readWorkflowProgressPage({
    workflowLocator: () => ({supervisorThreadId: "supervisor-thread", bindingGeneration: generation}),
    scopeSnapshot: async () => {
      generation = 8;
      return scopeSnapshot();
    },
  } as unknown as ProjectSupervisor,
  {read: async () => readerResult()} as unknown as WorkflowWriteController, query, AbortSignal.timeout(1000));
  assert.equal(changesAfterReader.status, "unavailable");
  assert.equal(changesAfterReader.scope, null);
  assert.match(changesAfterReader.message ?? "", /binding changed/);
});

test("an oversized combined progress response returns a small explicit error without partial data or load-more loops", async () => {
  const baseScope = scopeSnapshot();
  const refs = Array.from({length: 20}, (_, index) => ({sourceThreadId: `thread-${index}`, sourceRunId: "r".repeat(512),
    sourceMessageId: "m".repeat(512), sourceItemId: "i".repeat(512), kind: "activity", observedAt: index, label: "large activity label ".repeat(1000)}));
  const scope = {...baseScope, threads: Array.from({length: 50}, (_, index) => ({
    threadId: `thread-${index}`, parentThreadId: index === 0 ? null : "main-thread", depth: index === 0 ? 0 : 1,
    origin: index === 0 ? "main" as const : "native_child" as const, lifecycle: "unknown" as const, lifecycleDetail: null,
    archivedAt: null, deletedAt: null, activityRefs: refs, contactLimit: "x".repeat(2048),
  }))};
  const base = readerResult();
  const lineage = Array.from({length: 50}, (_, index) => ({threadId: `thread-${index}`, parentThreadId: index === 0 ? null : "main-thread",
    relationshipToParent: index === 0 ? null : "subagent", archivedAt: null}));
  const supervision = {
    workflowLocator: () => ({supervisorThreadId: "supervisor-thread", bindingGeneration: 7}),
    scopeSnapshot: async (_projectId: string, _mainThreadId: string, _signal: AbortSignal, options?: unknown) => {
      const threadIds = (options as {threadIds?: string[]}).threadIds ?? [];
      return {...scope, threads: scope.threads.filter(thread => threadIds.includes(thread.threadId))};
    },
  } as unknown as ProjectSupervisor;
  const workflowReader = {read: async () => ({...base, lineage, lineageHasMore: false})} as unknown as WorkflowWriteController;
  const result = await readWorkflowProgressPage(supervision, workflowReader, {
    projectId: "project", mainThreadId: "main-thread", workflowOffset: 0, lineageOffset: 0, limit: 50,
  }, AbortSignal.timeout(1000));
  assert.equal(result.status, "too_large");
  assert.equal(result.scope, null);
  assert.equal(result.workflows.length, 0);
  assert.equal(result.workflowHasMore, false);
  assert.equal(result.lineageHasMore, false);
  assert.match(result.message ?? "", /no partial status was returned/);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length < 10_000);
});

test("multi-page progress observes only the requested child rows instead of rereading every descendant", async () => {
  const totalThreads = 150;
  const allThreads = Array.from({length: totalThreads}, (_, index) => ({
    threadId: index === 0 ? "main-thread" : `child-${index}`,
    parentThreadId: index === 0 ? null : "main-thread",
    depth: index === 0 ? 0 : 1,
    origin: index === 0 ? "main" as const : "delegated_child" as const,
    lifecycle: "unknown" as const,
    lifecycleDetail: null,
    archivedAt: null,
    deletedAt: null,
    activityRefs: [],
    contactLimit: "parent mediated",
  }));
  const allScope = {...scopeSnapshot(), lineageTotal: totalThreads, threads: allThreads};
  const observedIds: string[] = [];
  const supervision = {
    workflowLocator: () => ({supervisorThreadId: "supervisor-thread", bindingGeneration: 7}),
    scopeSnapshot: async (_projectId: string, _mainThreadId: string, _signal: AbortSignal, options?: unknown) => {
      const pageIds = (options as {threadIds: string[]}).threadIds;
      observedIds.push(...pageIds);
      return {...allScope, threads: allThreads.filter(thread => pageIds.includes(thread.threadId))};
    },
  } as unknown as ProjectSupervisor;
  const workflowReader = {read: async (input: unknown): Promise<Extract<WorkflowReadResult, {status: "ok"}>> => {
    const {lineageOffset, limit} = input as {lineageOffset: number; limit: number};
    const lineage = allThreads.slice(lineageOffset, lineageOffset + limit).map(thread => ({
      threadId: thread.threadId,
      parentThreadId: thread.parentThreadId,
      relationshipToParent: thread.threadId === "main-thread" ? null : "subagent",
      archivedAt: null,
    }));
    return {...readerResult(), lineage, lineageOffset, lineageHasMore: lineageOffset + lineage.length < totalThreads,
      workflows: [], workflowHasMore: false};
  }} as unknown as WorkflowWriteController;

  for (const lineageOffset of [0, 50, 100]) {
    const result = await readWorkflowProgressPage(supervision, workflowReader, {
      projectId: "project", mainThreadId: "main-thread", workflowOffset: 0, lineageOffset, limit: 50,
    }, AbortSignal.timeout(1000));
    assert.equal(result.status, "ok");
    assert.equal(result.scope?.threads.length, 50);
  }
  assert.equal(observedIds.length, 150);
  assert.equal(new Set(observedIds).size, 150);
  assert.deepEqual(observedIds.slice(0, 50), allThreads.slice(0, 50).map(thread => thread.threadId));
  assert.deepEqual(observedIds.slice(50, 100), allThreads.slice(50, 100).map(thread => thread.threadId));
  assert.deepEqual(observedIds.slice(100), allThreads.slice(100).map(thread => thread.threadId));
});

test("workflow progress exposes bounded contributions with honest plan membership and the current assessment only", async () => {
  const nodeId = "3f0c4b8e-2f2d-4c39-9a51-1df1b6a8a001";
  const removedId = "3f0c4b8e-2f2d-4c39-9a51-1df1b6a8a002";
  const step = {kind: "step" as const, nodeId, definitionId: null, localId: "review", templatePath: null, name: "External review", description: "Review it.",
    source: null, resolution: "resolved" as const, reason: "Review it.", status: "planned" as const, contributorThreadIds: []};
  const base = document();
  const contributed: WorkflowStateDocument = {...base, plan: {kind: "sequence", templatePath: null, nodes: [step]},
    contributions: [
      {contributionId: "external-review", nodeId, state: "result", revision: 2, summary: "<b>passed</b>", references: [{kind: "url", value: "javascript:alert(1)"}],
        externalRef: "ticket-7", sourceThreadId: "main-thread", sourceRunId: "main-run", sourceMessageId: "main-message", recordedAt: 30,
        assessment: {decision: "needs_more", resultRevision: 2, note: "Attach the findings.", actorSupervisorThreadId: "supervisor-thread", evidenceId: "assessed", recordedAt: 31}},
      {contributionId: "former-step", nodeId: removedId, state: "awaiting_result", revision: 1, summary: "", references: [], externalRef: null,
        sourceThreadId: "main-thread", sourceRunId: "main-run", sourceMessageId: "main-message-0", recordedAt: 20, assessment: null},
    ],
    evidence: [...base.evidence, {id: "removed", operationId: "remove", kind: "node_removed", recordedAt: 26, actorSupervisorThreadId: "supervisor-thread",
      targetNodeId: removedId, targetNodeName: "Former step", statusFrom: "planned", statusTo: null, sourceThreadId: null, sourceRunId: null,
      sourceMessageId: null, agreementKey: null, note: "Removed."}]};
  const workflowReader = {read: async () => ({...readerResult(), workflows: [{document: contributed, parentNodeReferences: []}]})} as unknown as WorkflowWriteController;
  const supervision = {
    workflowLocator: () => ({supervisorThreadId: "supervisor-thread", bindingGeneration: 7}),
    scopeSnapshot: async () => scopeSnapshot(),
  } as unknown as ProjectSupervisor;
  const result = await readWorkflowProgressPage(supervision, workflowReader, {
    projectId: "project", mainThreadId: "main-thread", workflowOffset: 0, lineageOffset: 0, limit: 20,
  }, AbortSignal.timeout(1000));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.workflows[0]?.contributions, [
    {contributionId: "external-review", nodeId, nodeName: "External review", inCurrentPlan: true, state: "result", revision: 2, summary: "<b>passed</b>",
      references: [{kind: "url", value: "javascript:alert(1)"}], externalRef: "ticket-7", sourceThreadId: "main-thread", sourceMessageId: "main-message",
      recordedAt: 30, assessment: {decision: "needs_more", resultRevision: 2, note: "Attach the findings.", recordedAt: 31}},
    {contributionId: "former-step", nodeId: removedId, nodeName: "Former step", inCurrentPlan: false, state: "awaiting_result", revision: 1, summary: "",
      references: [], externalRef: null, sourceThreadId: "main-thread", sourceMessageId: "main-message-0", recordedAt: 20, assessment: null},
  ]);
  assert.equal(result.workflows[0]?.observations.some(item => item.id === "removed"), false);
  assert.deepEqual(Schema.decodeUnknownSync(WorkflowProgressSnapshotSchema)(result), result);
});


test("main assessment binds task identity and source while preserving its own reason", () => {
  const base = document();
  const bound: WorkflowStateDocument = {...base, status: "needs_attention", sourceBinding: base.acceptedAgreements[0]!.sourceBinding,
    evidence: [{...base.evidence[0]!, kind: "status_changed", targetNodeId: null, statusTo: "needs_attention", note: "The current review found a blocker."},
      {...base.evidence[1]!, kind: "status_changed", targetNodeId: "step", statusTo: "completed", note: "A step passed."},
      {...base.evidence[2]!, kind: "contribution_recorded", note: "An external report arrived."}]};
  const assessment = workflowAssessment(bound);
  assert.equal(assessment?.summary, "The current review found a blocker.");
  assert.equal(assessmentForTask(assessment, {id: "task", sourceHash: "source-hash", status: "inferred"}), assessment);
  assert.equal(assessmentForTask(assessment, {id: "new-task-same-text", sourceHash: "source-hash", status: "inferred"}), null);
  assert.equal(assessmentForTask(assessment, {id: "task", sourceHash: "changed", status: "inferred"}), null);
  assert.equal(assessmentForTask(assessment, undefined), null, "replaced ownership without a current task does not inherit an assessment");
  assert.equal(assessmentForTask(assessment, {id: "task", sourceHash: "source-hash", status: "expired"}), null);
  assert.equal(workflowAssessment({...bound, sourceBinding: null}), null);
  assert.equal(workflowAssessment({...bound, evidence: []})?.summary, "No explanation was recorded for this workflow assessment.");
});
