import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { GuidanceStore, fingerprint } from "../src/guidance-store.js";
import type { ProjectDefinitionLoader } from "../src/project-definitions.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { ProjectSupervisorStore, defaultSupervisorModel, type BindingRecord, type TaskRecord } from "../src/project-supervisor-store.js";
import { ProjectSupervisor } from "../src/project-supervisor.js";
import { SupervisorConversation, firstObservedOrdinal, workflowIntroductionText } from "../src/supervisor-conversation.js";
import { buildProjectDefinitionReviewRequest, extractApprovedProjectDefinitions } from "../src/supervisor-definition-review.js";
import { parseWorkflowInterpretation, prepareWorkflowRequest, validateWorkflowPlan, type WorkflowPlanValue } from "../src/supervisor-workflow.js";
import type { ConversationRequest, WorkflowIntroduction } from "../src/supervisor-conversation-store.js";
import { SupervisorRpcError, type SupervisorRpc } from "../src/supervisor-native.js";
import { T3TransportError } from "../src/t3.js";
import type { MessageInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";

const projectId = "project-a";
const operativeThreadId = "operative-a";
const sourceMessageId = "operative-task";
const sourceText = "Implement the export workflow";
const workspaceRoot = "/work/project/worktrees/feature";
const revision = "steps-revision-7";
const baseTime = Date.parse("2026-10-13T10:00:00.000Z");
const iso = (time = baseTime): string => new Date(time).toISOString();

const definitions = (): ProjectDefinitionSnapshot => ({
  projectId,
  threadId: operativeThreadId,
  workspaceRoot,
  revision,
  globalRevision: null,
  globalOnly: false,
  editingAvailable: true,
  status: "ready",
  steps: [{id: "test-plan", name: "Test plan", description: "Verify the behavior.", origin: "project", path: ".t3-supervisor/steps/test-plan.md", sourceId: "project:test-plan"}],
  workflows: [],
  config: {required: [{step: "test-plan"}]},
  projectConfig: {required: [{step: "test-plan"}]},
  complete: true,
  sources: [
    {path: ".t3-supervisor/project.yaml", content: "required:\n  - step: test-plan\n", origin: "project"},
    {path: ".t3-supervisor/steps/test-plan.md", content: "---\nid: test-plan\nname: Test plan\ndescription: Verify the behavior.\n---\n", origin: "project"},
  ],
  issues: [],
});

const fixedWorkflowDefinitions = (nextRevision = revision, workflowIds: readonly string[] = ["reviewer"]): ProjectDefinitionSnapshot => {
  const snapshot = definitions();
  const workflows = workflowIds.map(id => ({id, name: id === "reviewer" ? "Reviewer" : "Live audit", description: `Complete ${id}.`, fixed: true,
    sequence: [{step: "test-plan" as const}], origin: "project" as const, path: `.t3-supervisor/workflows/${id}.yaml`, sourceId: `project:${id}`}));
  const sources = workflowIds.map(id => ({path: `.t3-supervisor/workflows/${id}.yaml`,
    content: `id: ${id}\nname: ${id === "reviewer" ? "Reviewer" : "Live audit"}\ndescription: Complete ${id}.\nfixed: true\nsequence:\n  - step: test-plan\n`, origin: "project" as const}));
  return {...snapshot, revision: nextRevision, workflows, sources: [...snapshot.sources, ...sources]};
};

const renamedStepDefinitions = (nextRevision: string, name: string): ProjectDefinitionSnapshot => {
  const snapshot = definitions();
  return {...snapshot, revision: nextRevision,
    steps: snapshot.steps.map(step => step.id === "test-plan" ? {...step, name} : step),
    sources: snapshot.sources.map(source => source.path.endsWith("steps/test-plan.md")
      ? {...source, content: source.content.replace("name: Test plan", `name: ${name}`)} : source)};
};

const requiredPlanForContext = (context: NonNullable<TaskRecord["definitionContext"]>, reason = "Verify the change."): WorkflowPlanValue => {
  const plan = validateWorkflowPlan({requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The task changes behavior."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "test-plan", reason}]}}, context);
  assert.ok(plan);
  return plan;
};

const planWithFixedWorkflows = (context: NonNullable<TaskRecord["definitionContext"]>, workflowIds: readonly string[]): WorkflowPlanValue => {
  const plan = validateWorkflowPlan({requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The task changes behavior."}],
    plan: {kind: "sequence", nodes: [...workflowIds.map(id => ({kind: "workflow", definitionId: id, reason: `Include ${id}.`})),
      {kind: "step", definitionId: "test-plan", reason: "Verify the change."}]}}, context);
  assert.ok(plan);
  return plan;
};

const makeThread = (input: {
  id: string;
  title: string;
  runtimeMode?: string;
  interactionMode?: string;
}): ThreadInfo => ({
  id: input.id,
  title: input.title,
  projectId,
  runtimeMode: input.runtimeMode ?? "full-access",
  interactionMode: input.interactionMode ?? "default",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.id },
});

const makeProjection = (thread: ThreadInfo): Projection => ({
  thread,
  runs: [],
  messages: [],
  nodes: [],
  providerTurns: [],
  runtimeRequests: [],
  turnItems: [],
});

const nodesOf = (projection: Projection): Array<Record<string, unknown>> => {
  if (!Array.isArray(projection.nodes)) projection.nodes = [];
  return projection.nodes as Array<Record<string, unknown>>;
};

const turnItemsOf = (projection: Projection): Array<Record<string, unknown>> => {
  if (!Array.isArray(projection.turnItems)) projection.turnItems = [];
  return projection.turnItems as Array<Record<string, unknown>>;
};

const appendRun = (input: {
  projection: Projection;
  id: string;
  ordinal: number;
  status: string;
  messageId: string;
  text: string;
  createdBy?: string;
  creationSource?: string;
  now?: number;
}): RunInfo => {
  const { projection } = input;
  const threadId = projection.thread.id;
  const now = input.now ?? baseTime;
  const rootNodeId = `${input.id}-root`;
  const providerThreadId = `${input.id}-provider`;
  const activeAttemptId = input.status === "running" ? `${input.id}-attempt` : null;
  const completed = input.status === "completed";
  const run: RunInfo = {
    id: input.id,
    threadId,
    ordinal: input.ordinal,
    status: input.status,
    requestedAt: iso(now - 2_000),
    startedAt: completed || input.status === "running" ? iso(now - 1_000) : null,
    completedAt: completed ? iso(now) : null,
    rootNodeId,
    userMessageId: input.messageId,
    activeAttemptId,
    providerThreadId,
  };
  projection.runs.push(run);
  if (activeAttemptId) (projection.providerTurns as Record<string, unknown>[]).push({id: `${input.id}-provider-turn`, runAttemptId: activeAttemptId,
    nodeId: rootNodeId, status: "running"});
  nodesOf(projection).push({
    id: rootNodeId,
    threadId,
    runId: run.id,
    parentNodeId: null,
    rootNodeId,
    kind: "root_turn",
    status: completed ? "completed" : input.status === "queued" ? "pending" : "running",
    providerThreadId,
  });
  const message: MessageInfo = {
    id: input.messageId,
    threadId,
    runId: run.id,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    streaming: false,
    createdAt: iso(now),
    updatedAt: iso(now),
    createdBy: input.createdBy ?? "user",
    creationSource: input.creationSource ?? "web",
  };
  projection.messages.push(message);
  return run;
};

const activateProviderTurn = (projection: Projection, run: RunInfo, attemptId = `${run.id}-attempt-ready`): void => {
  run.status = "running";
  run.activeAttemptId = attemptId;
  run.startedAt = iso(baseTime);
  const root = nodesOf(projection).find(node => node.id === run.rootNodeId);
  assert.ok(root);
  root.status = "running";
  (projection.providerTurns as Record<string, unknown>[]).push({id: `${attemptId}-provider-turn`, runAttemptId: attemptId,
    nodeId: run.rootNodeId, status: "running"});
};

const restartRun = (projection: Projection, run: RunInfo, input: {messageId: string; text: string; now: number; oldRootStatus?: string}) => {
  const oldRootId = run.rootNodeId;
  assert.ok(oldRootId);
  const oldRoot = nodesOf(projection).find(node => node.id === oldRootId);
  assert.ok(oldRoot);
  const oldMessages = projection.messages.filter(message => message.runId === run.id).map(message => [message.id, message.nodeId] as const);
  oldRoot.status = input.oldRootStatus ?? "interrupted";
  const rootNodeId = `${input.messageId}-root`;
  const providerThreadId = String(run.providerThreadId);
  nodesOf(projection).push({
    id: rootNodeId,
    threadId: projection.thread.id,
    runId: run.id,
    parentNodeId: null,
    rootNodeId,
    kind: "root_turn",
    status: "running",
    providerThreadId,
  });
  run.rootNodeId = rootNodeId;
  run.userMessageId = input.messageId;
  run.status = "running";
  const activeAttemptId = `${run.id}-attempt-${(projection.providerTurns as Record<string, unknown>[]).length + 1}`;
  run.activeAttemptId = activeAttemptId;
  run.startedAt = iso(input.now);
  run.completedAt = null;
  (projection.providerTurns as Record<string, unknown>[]).push({id: `${activeAttemptId}-provider-turn`, runAttemptId: activeAttemptId,
    nodeId: rootNodeId, status: "running"});
  const message: MessageInfo = {
    id: input.messageId,
    threadId: projection.thread.id,
    runId: run.id,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    streaming: false,
    createdAt: iso(input.now),
    updatedAt: iso(input.now),
    createdBy: "user",
    creationSource: "web",
  };
  projection.messages.push(message);
  projection.thread.activeRunId = run.id;
  for (const [messageId, nodeId] of oldMessages) assert.equal(projection.messages.find(item => item.id === messageId)?.nodeId, nodeId);
  return {oldRootId, rootNodeId, message};
};

const appendMessageToRun = (
  projection: Projection,
  run: RunInfo,
  input: { id: string; role: "user" | "assistant"; text: string; createdBy?: string; creationSource?: string; now?: number },
): MessageInfo => {
  const now = input.now ?? baseTime;
  const rootNodeId = run.rootNodeId!;
  const providerThreadId = String(run.providerThreadId);
  const nodeId = input.role === "user" ? rootNodeId : `${input.id}-node`;
  if (input.role === "assistant") nodesOf(projection).push({
    id: nodeId,
    threadId: projection.thread.id,
    runId: run.id,
    parentNodeId: rootNodeId,
    rootNodeId,
    kind: "assistant_message",
    status: "completed",
    providerThreadId,
  });
  const message: MessageInfo = {
    id: input.id,
    threadId: projection.thread.id,
    runId: run.id,
    nodeId,
    role: input.role,
    text: input.text,
    streaming: false,
    createdAt: iso(now),
    updatedAt: iso(now),
    createdBy: input.createdBy ?? (input.role === "user" ? "user" : "agent"),
    creationSource: input.creationSource ?? (input.role === "user" ? "web" : "provider"),
  };
  projection.messages.push(message);
  return message;
};

const completeRun = (projection: Projection, run: RunInfo, response: string, now = baseTime): void => {
  const completedAttemptId = run.activeAttemptId;
  run.status = "completed";
  run.completedAt = iso(now);
  run.activeAttemptId = null;
  for (const turn of (projection.providerTurns ?? []) as Array<Record<string, unknown>>) if (turn.runAttemptId === completedAttemptId) turn.status = "completed";
  const root = nodesOf(projection).find(node => node.id === run.rootNodeId);
  assert.ok(root);
  root.status = "completed";
  const request = projection.messages.find(message => message.id === run.userMessageId);
  const envelope = request?.text.match(/UNTRUSTED_CONTEXT_ENVELOPE\n([\s\S]*?)\nEND_UNTRUSTED_CONTEXT_ENVELOPE/u)?.[1];
  if (envelope && request?.text.includes("This initializes supervision")) {
    try {
      const value = JSON.parse(envelope) as {initialProposal?: unknown};
      const proposal = value.initialProposal;
      response = `\`\`\`workflow-proposal\n${JSON.stringify(proposal)}\n\`\`\`\n${response}`;
    } catch { /* retain the supplied test response when its context envelope is malformed */ }
  }
  appendMessageToRun(projection, run, { id: `assistant-${run.id}`, role: "assistant", text: response, now });
};

const addCommandActivity = (projection: Projection, id: string, input: string, now: number): void => {
  const run = projection.runs.find(candidate => candidate.id === projection.thread.activeRunId);
  assert.ok(run?.rootNodeId);
  const nodeId = `${id}-node`;
  const providerThreadId = String(run.providerThreadId);
  nodesOf(projection).push({
    id: nodeId,
    threadId: projection.thread.id,
    runId: run.id,
    parentNodeId: run.rootNodeId,
    rootNodeId: run.rootNodeId,
    kind: "tool_call",
    status: "completed",
    providerThreadId,
  });
  turnItemsOf(projection).push({
    id,
    threadId: projection.thread.id,
    runId: run.id,
    nodeId,
    providerThreadId,
    providerTurnId: "operative-turn",
    ordinal: turnItemsOf(projection).length + 1,
    status: "completed",
    startedAt: iso(now - 100),
    completedAt: iso(now),
    updatedAt: iso(now),
    type: "command_execution",
    input,
    output: "ok",
  });
};

interface FixtureOptions {
  supervisorRuntimeMode?: string;
  supervisorInteractionMode?: string;
  workflow?: boolean;
  operativeActive?: boolean;
  settings?: { intervalMinutes: number; activityThreshold: number };
  queuePeerDuringNextSupervisorDispatch?: boolean;
}

interface Clock { now: number }

const makeFixture = async (clock: Clock, options: FixtureOptions = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-conversation-test-"));
  const guidance = new GuidanceStore(directory);
  const projectStore = new ProjectSupervisorStore(guidance, new Set());
  const binding = projectStore.reserve(projectId, operativeThreadId, "Project A", defaultSupervisorModel, 10, clock.now);
  projectStore.setBinding({ ...binding, state: "ready" });
  const settings = projectStore.settings(projectId);
  projectStore.saveSettings(projectId, settings.generation, settings.modelSelection, options.settings ?? {
    intervalMinutes: 5,
    activityThreshold: 3,
  });

  const operative = makeProjection(makeThread({ id: operativeThreadId, title: "Operative", runtimeMode: "full-access", interactionMode: "default" }));
  const sourceRun = appendRun({
    projection: operative,
    id: "operative-source-run",
    ordinal: 1,
    status: "completed",
    messageId: sourceMessageId,
    text: sourceText,
    now: clock.now - 120_000,
  });
  if (options.operativeActive !== false) {
    appendRun({
      projection: operative,
      id: "operative-active-run",
      ordinal: 2,
      status: "running",
      messageId: "operative-active-input",
      text: "Continue the task",
      now: clock.now - 20_000,
    });
    operative.thread.activeRunId = "operative-active-run";
  }
  const supervisor = makeProjection(makeThread({
    id: binding.threadId,
    title: "Project Supervisor",
    runtimeMode: options.supervisorRuntimeMode ?? "full-access",
    interactionMode: options.supervisorInteractionMode ?? "default",
  }));
  supervisor.thread.modelSelection = defaultSupervisorModel;
  const projections = new Map([[operativeThreadId, operative], [binding.threadId, supervisor]]);
  const projectionFailures = new Map<string, Error>();
  let definitionSnapshot = definitions();
  let definitionReadFailure: Error | null = null;
  const prepared = prepareWorkflowRequest(operativeThreadId, sourceMessageId, sourceText, definitionSnapshot);
  assert.ok(prepared.context);
  const initialPlan = requiredPlanForContext(prepared.context);
  const task: TaskRecord = {
    id: "proposal-1",
    threadId: operativeThreadId,
    projectId,
    sourceRunId: sourceRun.id,
    sourceMessageId,
    sourceHash: fingerprint(sourceText),
    sourceOrdinal: sourceRun.ordinal,
    status: "inferred",
    objective: "Implement the export workflow",
    reason: "The source message requests the workflow.",
    updatedAt: clock.now,
    definitionContext: prepared.context,
    requestText: "",
    supervisorThreadId: binding.threadId,
    definitionSnapshot: definitions(),
    messageId: "supervisor-objective:proposal-1",
    dispatchedAt: null,
    replayCount: 0,
    supervisorRunId: "supervisor-objective-run",
    ...(options.workflow === false ? {} : {
      workflow: {
        status: "proposed" as const,
        message: "A draft is ready.",
        workspaceRoot,
        revision,
        globalRevision: null,
        ...initialPlan,
      },
    }),
  };
  projectStore.saveTask(task);

  let queuePeerDuringNextSupervisorDispatch = options.queuePeerDuringNextSupervisorDispatch ?? false;
  let failNextIntroduction = false;
  let introductionsToReject = 0;
  let returnInvalidNextIntroductionReceipt = false;
  let nextSupervisorRun = 0;
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const rpc: SupervisorRpc = async (tag, payload) => {
    const call = { tag, payload: { ...payload } };
    calls.push(call);
    if (tag !== "orchestration.dispatchCommand" || payload.type !== "message.dispatch")
      throw new Error(`unexpected fake native command ${tag}/${String(payload.type)}`);

    const targetThreadId = String(payload.threadId);
    if (targetThreadId === binding.threadId) {
      if (queuePeerDuringNextSupervisorDispatch) {
        queuePeerDuringNextSupervisorDispatch = false;
        appendRun({
          projection: supervisor,
          id: "supervisor-peer-run",
          ordinal: 1,
          status: "running",
          messageId: "supervisor-peer-message",
          text: "A direct peer reply arrived.",
          now: clock.now,
        });
      }
      nextSupervisorRun++;
      const isBusy = supervisor.runs.some(run => ["preparing", "queued", "starting", "running", "waiting"].includes(run.status));
      const status = payload.dispatchMode && (payload.dispatchMode as Record<string, unknown>).type === "queue_after_active" && isBusy
        ? "queued"
        : "running";
      const run = appendRun({
        projection: supervisor,
        id: `supervisor-run-${nextSupervisorRun}`,
        ordinal: nextSupervisorRun + supervisor.runs.length,
        status,
        messageId: String(payload.messageId),
        text: String(payload.text),
        createdBy: "system",
        creationSource: "server",
        now: clock.now,
      });
      run.queuePosition = status === "queued" ? 1 : null;
      return { sequence: calls.length };
    }

    const operativeTarget = projections.get(targetThreadId);
    if (operativeTarget && targetThreadId !== binding.threadId) {
      if (failNextIntroduction) {
        failNextIntroduction = false;
        throw new SupervisorRpcError("uncertain");
      }
      if (introductionsToReject > 0) {
        introductionsToReject--;
        throw new SupervisorRpcError("rejected", true);
      }
      if (returnInvalidNextIntroductionReceipt) {
        returnInvalidNextIntroductionReceipt = false;
        return { sequence: -1 };
      }
      const dispatchMode = payload.dispatchMode as Record<string, unknown> | undefined;
      if (dispatchMode?.type === "queue_after_active" && !operativeTarget.runs.some(candidate => ["running", "waiting", "starting", "queued"].includes(candidate.status))) {
        appendRun({projection: operativeTarget, id: `operative-notice-run-${calls.length}`,
          ordinal: Math.max(0, ...operativeTarget.runs.map(candidate => candidate.ordinal)) + 1, status: "running",
          messageId: String(payload.messageId), text: String(payload.text), createdBy: "user", creationSource: "server", now: clock.now});
        return {sequence: calls.length};
      }
      const runId = String(dispatchMode?.targetRunId ?? operativeTarget.thread.activeRunId ?? "operative-active-run");
      const run = operativeTarget.runs.find(candidate => candidate.id === runId);
      assert.ok(run);
      appendMessageToRun(operativeTarget, run, {
        id: String(payload.messageId),
        role: "user",
        text: String(payload.text),
        createdBy: "system",
        creationSource: "server",
        now: clock.now,
      });
      return { sequence: calls.length };
    }

    throw new Error(`unexpected fake target ${targetThreadId}`);
  };
  const definitionLoader: Pick<ProjectDefinitionLoader, "load"> = {
    load: async (loadedProjectId, threadId) => {
      if (definitionReadFailure) throw definitionReadFailure;
      const snapshot = definitionSnapshot;
      return { ...snapshot, projectId: loadedProjectId, threadId: threadId ?? null };
    },
  };
  const threadList = [supervisor.thread, operative.thread];
  const workflows = new WorkflowStateStore(projectStore, () => true);
  const conversation = new SupervisorConversation(
    projectStore,
    rpc,
    async threadId => {
      const failure = projectionFailures.get(threadId);
      if (failure) throw failure;
      const projection = projections.get(threadId);
      if (!projection) throw new Error(`missing test projection ${threadId}`);
      return projection;
    },
    definitionLoader,
    thread => thread.id.startsWith("operative-") && thread.projectId === projectId,
    () => true,
    workflows,
  );
  const apiConfig = {
    dataDirectory: directory,
    t3Url: "http://localhost",
    t3TokenFile: "",
    mcpxUrl: "http://localhost",
    cxCommand: "",
    cxHome: "",
    cxSeedFile: "",
    excludedThreadIds: [],
    healthPort: 0,
    modelTimeoutMs: 1,
  } satisfies SupervisorConfig;
  const modelConfig = {
    providers: [{
      enabled: true,
      instanceId: "codex",
      displayName: "Codex",
      installed: true,
      status: "ready",
      models: [{
        slug: "gpt-6-luna",
        name: "GPT-6 Luna",
        capabilities: { optionDescriptors: [{
          id: "reasoningEffort",
          label: "Reasoning effort",
          type: "select",
          currentValue: "high",
          options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }, { id: "max", label: "Max" }],
        }] },
      }],
    }],
  };
  const projectSupervisor = new ProjectSupervisor(
    apiConfig,
    projectStore,
    { catalog: () => Effect.succeed({ projects: [{ project: { id: projectId, title: "Project A", workspaceRoot }, available: true }], threads: threadList }) },
    { projection: (threadId) => {
      const projection = projections.get(threadId);
      if (!projection) throw new Error(`missing test projection ${threadId}`);
      return Effect.succeed({ snapshotSequence: 1, projection });
    } },
    async tag => {
      if (tag !== "server.getConfig") throw new Error(`unexpected fake read command ${tag}`);
      return modelConfig;
    },
    rpc,
    async () => ({ snapshotSequence: 1, threads: [] }),
    definitionLoader,
  );
  const addOperative = (threadId: string, proposalId: string) => {
    const projection = makeProjection(makeThread({ id: threadId, title: `Operative ${proposalId}` }));
    const messageId = `${threadId}-task`;
    const messageText = `Implement ${proposalId}`;
    const source = appendRun({ projection, id: `${threadId}-source-run`, ordinal: 1, status: "completed", messageId, text: messageText, now: clock.now - 120_000 });
    const activeRun = appendRun({ projection, id: `${threadId}-active-run`, ordinal: 2, status: "running", messageId: `${threadId}-active-input`, text: "Continue the task", now: clock.now - 20_000 });
    projection.thread.activeRunId = activeRun.id;
    projections.set(threadId, projection);
    threadList.push(projection.thread);
    const additionalTask: TaskRecord = {
      ...task,
      id: proposalId,
      threadId,
      sourceRunId: source.id,
      sourceMessageId: messageId,
      sourceHash: fingerprint(messageText),
      sourceOrdinal: source.ordinal,
      definitionContext: prepareWorkflowRequest(threadId, messageId, messageText, {...definitionSnapshot, threadId}).context,
      definitionSnapshot: {...definitionSnapshot, threadId},
      messageId: `supervisor-objective:${proposalId}`,
    };
    projectStore.saveTask(additionalTask);
    return { projection, task: additionalTask };
  };
  const signal = AbortSignal.timeout(10_000);
  return {
    binding: projectStore.binding(projectId, operativeThreadId) as BindingRecord,
    calls,
    cleanup: async () => { guidance.close(); await rm(directory, { recursive: true, force: true }); },
    conversation,
    addOperative,
    failNextIntroduction: () => { failNextIntroduction = true; },
    rejectNextIntroduction: (count = 1) => { introductionsToReject += count; },
    makeProjectSupervisor: () => projectSupervisor,
    makeRestartedConversation: () => new SupervisorConversation(projectStore, null, async threadId => {
      const failure = projectionFailures.get(threadId);
      if (failure) throw failure;
      const projection = projections.get(threadId);
      if (!projection) throw new Error(`missing restarted test projection ${threadId}`);
      return projection;
    }, definitionLoader, thread => thread.id.startsWith("operative-") && thread.projectId === projectId, () => true, workflows),
    returnInvalidNextIntroductionReceipt: () => { returnInvalidNextIntroductionReceipt = true; },
    setDefinitions: (snapshot: ProjectDefinitionSnapshot) => { definitionSnapshot = snapshot; },
    setDefinitionReadFailure: (failure: Error | null) => { definitionReadFailure = failure; },
    setProjectionFailure: (threadId: string, failure: Error | null) => { if (failure) projectionFailures.set(threadId, failure); else projectionFailures.delete(threadId); },
    projection: (threadId: string) => projections.get(threadId) ?? null,
    addChildProjection: (projection: Projection) => {projections.set(projection.thread.id, projection);threadList.push(projection.thread);},
    operative,
    projectStore,
    run: () => conversation.run(projectStore.binding(projectId, operativeThreadId) as BindingRecord, supervisor, threadList, signal),
    supervisor,
    task,
    threadList,
    workflows,
  };
};

const installTaskDefinitions = (fixture: Awaited<ReturnType<typeof makeFixture>>, snapshot: ProjectDefinitionSnapshot, workflowIds: readonly string[]): TaskRecord => {
  const current = fixture.projectStore.task(fixture.task.threadId)!;
  const prepared = prepareWorkflowRequest(current.threadId, current.sourceMessageId, current.objective ?? sourceText, snapshot);
  assert.ok(prepared.context);
  const plan = planWithFixedWorkflows(prepared.context, workflowIds);
  const task: TaskRecord = {...current, definitionContext: prepared.context, definitionSnapshot: snapshot,
    workflow: {status: "proposed", message: "A complete proposal is ready for review.", workspaceRoot: prepared.context.workspaceRoot,
      revision: prepared.context.revision, globalRevision: prepared.context.globalRevision ?? null, ...plan},
    workflowProposalId: current.workflowProposalId ?? current.id};
  fixture.projectStore.saveTask(task);
  fixture.setDefinitions(snapshot);
  return task;
};

const appendNoticeForTask = (
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  task: TaskRecord,
  projection: Projection,
): WorkflowIntroduction => {
  const introduction: WorkflowIntroduction = {
    taskId: task.id,
    projectId,
    threadId: task.threadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "sent",
    text: workflowIntroductionText(task),
    messageId: `supervisor-notice:workflow:${task.id}`,
    targetRunId: String(projection.thread.activeRunId ?? "operative-active-run"),
    error: null,
  };
  fixture.conversation.requests.saveIntroduction(introduction);
  const run = projection.runs.find(candidate => candidate.id === introduction.targetRunId);
  assert.ok(run);
  appendMessageToRun(projection, run, {
    id: introduction.messageId,
    role: "user",
    text: introduction.text,
    createdBy: "user",
    creationSource: "server",
  });
  return introduction;
};

const appendNoticeToOperative = (fixture: Awaited<ReturnType<typeof makeFixture>>): WorkflowIntroduction =>
  appendNoticeForTask(fixture, fixture.task, fixture.operative);

const supervisorRequestCall = (fixture: Awaited<ReturnType<typeof makeFixture>>, kind?: "context" | "review") =>
  fixture.calls.find(call => call.payload.threadId === fixture.binding.threadId &&
    (kind === undefined || String(call.payload.text).includes(kind === "context" ? "This initializes supervision" : "Review this factual change index.")));

const workflowValue = (task: TaskRecord): WorkflowPlanValue => ({
  definitionsStatus: task.workflow!.definitionsStatus,
  definitionsComplete: task.workflow!.definitionsComplete,
  requirementsKnown: task.workflow!.requirementsKnown,
  requirements: task.workflow!.requirements,
  issues: task.workflow!.issues,
  plan: task.workflow!.plan,
});
const workflowPlan = (task: TaskRecord): WorkflowPlanValue => workflowValue(task);
const withLocalStep = (task: TaskRecord, name: string, reason: string): WorkflowPlanValue => {
  const value = workflowPlan(task);
  assert.ok(value.plan);
  return {...value, plan: {...value.plan, nodes: [...value.plan.nodes, {kind: "step", nodeId: randomUUID(), definitionId: null,
    localId: `local-${randomUUID()}`, templatePath: null, name, description: reason, source: null, resolution: "resolved", reason,
    status: "planned", contributorThreadIds: []}]}};
};
const workflowWithoutRequiredStep = (task: TaskRecord): WorkflowPlanValue => {
  const value = validateWorkflowPlan({requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The verification remains required."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "skip-verification", name: "Skip verification", description: "No verification will be done.", reason: "Skip."}]}}, task.definitionContext!);
  assert.ok(value);
  return value;
};
const workflowRecord = (task: TaskRecord, proposalId: string, workflow = workflowPlan(task)) => ({
  taskId: task.id,
  proposalId,
  workspaceRoot: task.workflow!.workspaceRoot,
  revision: task.workflow!.revision,
  workflow,
});
const workflowFence = (kind: "workflow-proposal" | "workflow-acceptance", value: unknown) => "```" + kind + "\n" + JSON.stringify(value) + "\n```";
const projectDefinitionDecisionFence = (value: unknown) => `\`\`\`project-definition-decision\n${JSON.stringify(value)}\n\`\`\``;

const projectDefinitionDecision = (task: TaskRecord, observedRevision: string, decision: "authorized" | "revert_requested",
  userMessageIds: readonly string[], reason: string) => ({taskId: task.id, expectedRevision: task.workflow!.revision, observedRevision, decision, userMessageIds, reason});

const appendActualUserMessage = (projection: Projection, id: string, text: string, now: number): MessageInfo => {
  const ordinal = projection.runs.reduce((value, run) => Math.max(value, run.ordinal), 0) + 1;
  const run = appendRun({projection, id: `${id}-run`, ordinal, status: "completed", messageId: id, text, now});
  return projection.messages.find(message => message.id === run.userMessageId)!;
};

const appendDefinitionDecision = (fixture: Awaited<ReturnType<typeof makeFixture>>, value: unknown, now: number) =>
  appendAssistantTurn(fixture.supervisor, `definition-decision-${fixture.supervisor.runs.length}`, projectDefinitionDecisionFence(value), now);

const appendAssistantTurn = (projection: Projection, id: string, text: string, now: number, options: {
  runStatus?: string;
  streaming?: boolean;
  nodeKind?: string;
} = {}) => {
  const ordinal = projection.runs.reduce((value, run) => Math.max(value, run.ordinal), 0) + 1;
  const run = appendRun({projection, id: `${id}-run`, ordinal, status: options.runStatus ?? "completed", messageId: `${id}-input`, text: "Review this workflow.", now});
  const message = appendMessageToRun(projection, run, {id: `${id}-answer`, role: "assistant", text, now});
  if (options.streaming) message.streaming = true;
  if (options.nodeKind) {
    const node = nodesOf(projection).find(candidate => candidate.id === message.nodeId);
    assert.ok(node);
    node.kind = options.nodeKind;
  }
  return {run, message};
};

const appendSupervisorProposal = (fixture: Awaited<ReturnType<typeof makeFixture>>, proposalId = fixture.task.id,
  workflow = workflowPlan(fixture.task), now = baseTime, recordTask = fixture.task) => appendAssistantTurn(fixture.supervisor,
  `supervisor-proposal-${proposalId}-${fixture.supervisor.runs.length}`,
  `I propose this workflow.\n${workflowFence("workflow-proposal", workflowRecord(recordTask, proposalId, workflow))}`, now);

const appendOperativeAcceptance = (fixture: Awaited<ReturnType<typeof makeFixture>>, value: unknown, now: number, options: {
  text?: string;
  streaming?: boolean;
  nodeKind?: string;
  run?: RunInfo;
} = {}) => {
  const run = options.run ?? fixture.operative.runs.find(item => item.id === fixture.operative.thread.activeRunId);
  assert.ok(run);
  const message = appendMessageToRun(fixture.operative, run, {id: `operative-acceptance-${fixture.operative.messages.length}`,
    role: "assistant", text: options.text ?? workflowFence("workflow-acceptance", value), now});
  if (options.streaming) message.streaming = true;
  if (options.nodeKind) {
    const node = nodesOf(fixture.operative).find(candidate => candidate.id === message.nodeId);
    assert.ok(node);
    node.kind = options.nodeKind;
  }
  return message;
};

const observeAgreement = (fixture: Awaited<ReturnType<typeof makeFixture>>, now: number) =>
  fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), now);

test("first descendant observation seeds past quiet history but includes active native or delegated work", () => {
  const projection = makeProjection(makeThread({id: "child", title: "Child"}));
  projection.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  const taskStartedAt = baseTime - 120_000;
  projection.turnItems = [1, 2, 3].map(ordinal => ({id: `old-${ordinal}`, threadId: projection.thread.id, runId: null,
    type: "command_execution", status: "completed", ordinal, completedAt: iso(baseTime - 300_000), updatedAt: iso(baseTime - 300_000)}));
  assert.equal(firstObservedOrdinal(projection), 4);
  assert.equal(firstObservedOrdinal(projection, taskStartedAt), 4, "pre-task child history is not replayed when the child is first seen");
  for (const item of projection.turnItems) {
    item.completedAt = iso(baseTime - 30_000);
    item.updatedAt = iso(baseTime - 30_000);
  }
  assert.equal(firstObservedOrdinal(projection, taskStartedAt), 1, "completed runless activity after the main task source is retained on first sight");
  projection.turnItems.push({id: "active-input", threadId: projection.thread.id, runId: null, type: "user_input_request", status: "waiting", ordinal: 4});
  assert.equal(firstObservedOrdinal(projection), 4);
  projection.runs = [
    {id: "old-run", threadId: projection.thread.id, ordinal: 1, status: "completed", requestedAt: iso(baseTime - 300_000),
      startedAt: iso(baseTime - 300_000), completedAt: iso(baseTime - 240_000), rootNodeId: null},
    {id: "active-run", threadId: projection.thread.id, ordinal: 6, status: "running", requestedAt: iso(baseTime - 30_000),
      startedAt: iso(baseTime - 30_000), completedAt: null, rootNodeId: null},
  ];
  assert.equal(firstObservedOrdinal(projection), 6);
  assert.equal(firstObservedOrdinal(projection, taskStartedAt), 1, "current-task completed child activity is retained even when a later run is active");
  projection.runs[1]!.status = "completed";
  assert.equal(firstObservedOrdinal(projection), 7);
});

test("first child checkpoint includes relevant completed work before a later active run and all work on a new child", () => {
  const taskStartedAt = baseTime - 120_000;
  const projection = makeProjection(makeThread({id: "reused-running-child", title: "Reused running child"}));
  projection.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  projection.runs = [
    {id: "pre-task-run", threadId: projection.thread.id, ordinal: 1, status: "completed", requestedAt: iso(taskStartedAt - 60_000),
      startedAt: iso(taskStartedAt - 59_000), completedAt: iso(taskStartedAt - 30_000), rootNodeId: null},
    {id: "current-completed-run", threadId: projection.thread.id, ordinal: 2, status: "completed", requestedAt: iso(taskStartedAt + 10_000),
      startedAt: iso(taskStartedAt + 11_000), completedAt: iso(taskStartedAt + 20_000), rootNodeId: null},
    {id: "current-active-run", threadId: projection.thread.id, ordinal: 6, status: "running", requestedAt: iso(taskStartedAt + 30_000),
      startedAt: iso(taskStartedAt + 31_000), completedAt: null, rootNodeId: null},
  ];
  projection.turnItems = [
    {id: "pre-task-command", threadId: projection.thread.id, runId: "pre-task-run", ordinal: 1, type: "command_execution", status: "completed",
      completedAt: iso(taskStartedAt - 40_000)},
    {id: "current-completed-command", threadId: projection.thread.id, runId: "current-completed-run", ordinal: 2, type: "command_execution", status: "completed"},
    {id: "current-active-command", threadId: projection.thread.id, runId: "current-active-run", ordinal: 6, type: "command_execution", status: "running"},
  ];
  assert.equal(firstObservedOrdinal(projection, taskStartedAt), 2,
    "a relevant completed AppRun remains in scope even when the child already has a later active run");

  const newChild = makeProjection(makeThread({id: "new-child-with-sparse-activity", title: "New child"}));
  newChild.thread.createdAt = iso(taskStartedAt + 1);
  newChild.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  newChild.runs = [{id: "new-child-run", threadId: newChild.thread.id, ordinal: 1, status: "completed", requestedAt: iso(taskStartedAt + 2),
    startedAt: iso(taskStartedAt + 3), completedAt: iso(taskStartedAt + 4), rootNodeId: null}];
  newChild.turnItems = [{id: "new-child-command", threadId: newChild.thread.id, runId: "new-child-run", ordinal: 1,
    type: "command_execution", status: "completed"}];
  assert.equal(firstObservedOrdinal(newChild, taskStartedAt), 1,
    "newly created descendants include their own activity when item timestamps are absent");
});

test("a child first discovered after restart retains a current failed AppRun but skips earlier completed history", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock, {operativeActive: false, settings: {intervalMinutes: 5, activityThreshold: 3}});
  t.after(fixture.cleanup);
  fixture.projectStore.saveTask({...fixture.task, sourceOrdinal: 2});
  fixture.conversation.requests.saveIntroduction({taskId: fixture.task.id, projectId, threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId, state: "sent", text: "Existing workflow context.", messageId: "workflow-context",
    targetRunId: null, error: null});
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);

  const child = makeProjection(makeThread({id: "operative-restarted-child", title: "Reused delegated child"}));
  child.thread.projectId = "other-project";
  child.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  child.thread.creationSource = "mcp";
  const oldRun = appendRun({projection: child, id: "pre-task-child-run", ordinal: 1, status: "completed",
    messageId: "pre-task-child-input", text: "Earlier work", now: clock.now - 300_000});
  child.thread.activeRunId = oldRun.id;
  addCommandActivity(child, "pre-task-child-command", "PRIVATE_PRE_TASK_CHILD_BODY", clock.now - 240_000);
  const failedRun = appendRun({projection: child, id: "current-failed-child-run", ordinal: 2, status: "failed",
    messageId: "current-failed-child-input", text: "Current child work failed", now: clock.now - 20_000});
  failedRun.completedAt = iso(clock.now - 10_000);
  nodesOf(child).find(node => node.id === failedRun.rootNodeId)!.status = "failed";
  child.thread.activeRunId = failedRun.id;
  addCommandActivity(child, "current-failed-child-command", "PRIVATE_CURRENT_FAILED_CHILD_BODY", clock.now - 15_000);
  child.thread.activeRunId = null;
  fixture.addChildProjection(child);

  const restarted = fixture.makeRestartedConversation();
  await restarted.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now + 5_001);
  const pending = restarted.monitor.pending(projectId, child.thread.id);
  assert.ok(pending.some(item => item.id === "run:current-failed-child-run" && item.priority === "run_failed"));
  assert.ok(pending.some(item => item.id === "current-failed-child-command"));
  assert.equal(pending.some(item => item.id === "pre-task-child-command"), false);
  assert.equal(restarted.monitor.hasState(projectId, child.thread.id), true);
});

test("context bootstrap is queued atomically, correlated to its own run, and only then steers the operative run", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { queuePeerDuringNextSupervisorDispatch: true });
  t.after(fixture.cleanup);

  await fixture.run();
  const contextCall = supervisorRequestCall(fixture, "context");
  assert.ok(contextCall);
  assert.deepEqual(contextCall.payload.dispatchMode, { type: "queue_after_active" });
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(request);
  assert.equal(request.kind, "context");
  assert.equal(request.messageId, contextCall.payload.messageId);
  assert.ok(request.completionMarker.length > 0);
  assert.ok(String(contextCall.payload.text).includes(request.completionMarker));
  assert.ok(String(contextCall.payload.text).includes(`supervisorThreadId=${JSON.stringify(fixture.binding.threadId)}, bindingGeneration=${fixture.binding.generation}`));
  assert.ok(String(contextCall.payload.text).includes("Steps describe outcomes or checks, not delegated tasks"));
  assert.ok(String(contextCall.payload.text).includes("For each new task, reassess required work for that task; earlier inclusion, completion, or review does not prove work for new changes"));
  const message = fixture.supervisor.messages.find(item => item.id === request.messageId && item.text === request.text);
  assert.ok(message);
  const run = fixture.supervisor.runs.find(item => item.userMessageId === request.messageId && item.id === message.runId);
  assert.ok(run);
  assert.equal(run.status, "queued", "a direct peer run that starts during dispatch keeps its place ahead of context");
  assert.equal(fixture.calls.some(call => call.payload.threadId === operativeThreadId), false);

  await fixture.run();
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId)?.runId, run.id);
  assert.equal(fixture.calls.some(call => call.payload.threadId === operativeThreadId), false);

  const peerRun = fixture.supervisor.runs.find(item => item.id === "supervisor-peer-run");
  assert.ok(peerRun);
  peerRun.status = "completed";
  peerRun.completedAt = iso(clock.now + 1);
  completeRun(fixture.supervisor, run, `Ready to discuss the draft. \`${request.completionMarker}\`!!!`, clock.now + 2);
  clock.now += 2;
  await fixture.run();
  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === request.id)?.state, "completed");
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "ready");
  assert.equal(fixture.calls.some(call => call.payload.threadId === operativeThreadId), false, "completion reconciliation does not send the introduction in the same poll");

  await fixture.run();
  const introductionCall = fixture.calls.find(call => call.payload.threadId === operativeThreadId);
  assert.ok(introductionCall);
  assert.deepEqual(introductionCall.payload.dispatchMode, { type: "steer_active", targetRunId: "operative-active-run" });
  assert.equal(introductionCall.payload.messageId, `supervisor-notice:workflow:${fixture.task.id}`);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "accepted");

  await fixture.run();
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "sent");
});

test("a replaced context primary closes the request and blocks the proposal instead of hanging", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);

  await fixture.run();
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(request?.kind === "context");
  const message = fixture.supervisor.messages.find(item => item.id === request.messageId);
  assert.ok(message);
  const run = fixture.supervisor.runs.find(item => item.id === message.runId);
  assert.ok(run);
  run.userMessageId = "peer-restart-primary-message";
  completeRun(fixture.supervisor, run, `Ready after restart. \`${request.completionMarker}\`!`, clock.now + 1);
  clock.now++;

  await fixture.run();

  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === request.id)?.state, "failed");
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId), null);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "blocked");
});

test("older approval-required/plan Supervisor chats are blocked without mode upgrades", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { supervisorRuntimeMode: "approval-required", supervisorInteractionMode: "plan" });
  t.after(fixture.cleanup);

  await fixture.run();

  const introduction = fixture.conversation.requests.introduction(fixture.task.id);
  assert.equal(introduction?.state, "blocked");
  assert.match(introduction?.error ?? "", /native modes/u);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.supervisor.thread.runtimeMode, "approval-required");
  assert.equal(fixture.supervisor.thread.interactionMode, "plan");
});

test("uncertain operative introduction is not replayed automatically; explicit retry reuses its identity and target", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const ready: WorkflowIntroduction = {
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "ready",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: null,
    error: null,
  };
  fixture.conversation.requests.saveIntroduction(ready);
  fixture.failNextIntroduction();

  await fixture.run();
  const firstCall = fixture.calls.find(call => call.payload.threadId === operativeThreadId);
  assert.ok(firstCall);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "uncertain");
  const retained = fixture.conversation.requests.introduction(fixture.task.id);
  assert.equal(retained?.messageId, firstCall.payload.messageId);
  assert.equal(retained?.targetRunId, "operative-active-run");

  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.payload.threadId === operativeThreadId).length, 1);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "uncertain");

  fixture.conversation.retry(projectId, fixture.binding.threadId);
  await fixture.run();
  const retries = fixture.calls.filter(call => call.payload.threadId === operativeThreadId);
  assert.equal(retries.length, 2);
  assert.equal(retries[1]?.payload.commandId, firstCall.payload.commandId);
  assert.equal(retries[1]?.payload.messageId, firstCall.payload.messageId);
  assert.deepEqual(retries[1]?.payload.dispatchMode, firstCall.payload.dispatchMode);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "accepted");
});

test("an uncertain idle introduction preserves its queued dispatch mode when an active run appears before retry", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { operativeActive: false });
  t.after(fixture.cleanup);
  fixture.conversation.requests.saveIntroduction({
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "ready",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: null,
    error: null,
  });
  fixture.failNextIntroduction();

  await fixture.run();
  const firstCall = fixture.calls.find(call => call.payload.threadId === operativeThreadId);
  assert.ok(firstCall);
  assert.deepEqual(firstCall.payload.dispatchMode, { type: "queue_after_active" });
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "uncertain");
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.targetRunId, null);

  const activeRun = appendRun({
    projection: fixture.operative,
    id: "operative-run-started-after-uncertain-send",
    ordinal: 2,
    status: "running",
    messageId: "operative-late-active-input",
    text: "Work has started while delivery is unresolved.",
    now: clock.now + 1,
  });
  fixture.operative.thread.activeRunId = activeRun.id;
  clock.now++;
  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.payload.threadId === operativeThreadId).length, 1);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "uncertain");

  fixture.conversation.retry(projectId, fixture.binding.threadId);
  await fixture.run();
  const calls = fixture.calls.filter(call => call.payload.threadId === operativeThreadId);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.payload.commandId, firstCall.payload.commandId);
  assert.equal(calls[1]?.payload.messageId, firstCall.payload.messageId);
  assert.deepEqual(calls[1]?.payload.dispatchMode, { type: "queue_after_active" });
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "accepted");
});

test("an invalid native receipt makes introduction delivery uncertain without automatic replay", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  fixture.conversation.requests.saveIntroduction({
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "ready",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: null,
    error: null,
  });
  fixture.returnInvalidNextIntroductionReceipt();

  await fixture.run();
  const firstCall = fixture.calls.find(call => call.payload.threadId === operativeThreadId);
  assert.ok(firstCall);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "uncertain");
  assert.equal(fixture.operative.messages.some(message => message.id === firstCall.payload.messageId), false);

  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.payload.threadId === operativeThreadId).length, 1);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "uncertain");

  fixture.conversation.retry(projectId, fixture.binding.threadId);
  await fixture.run();
  const calls = fixture.calls.filter(call => call.payload.threadId === operativeThreadId);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.payload.commandId, firstCall.payload.commandId);
  assert.equal(calls[1]?.payload.messageId, firstCall.payload.messageId);
  assert.deepEqual(calls[1]?.payload.dispatchMode, firstCall.payload.dispatchMode);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "accepted");
});

test("a still-invisible accepted introduction does not starve another operative chat's review", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  const second = fixture.addOperative("operative-b", "proposal-2");
  fixture.conversation.requests.saveIntroduction({
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "accepted",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: "operative-active-run",
    dispatchMode: { type: "steer_active", targetRunId: "operative-active-run" },
    acceptedAt: clock.now,
    visibilityMisses: 0,
    error: null,
  });
  appendNoticeForTask(fixture, second.task, second.projection);
  for (let index = 1; index <= 3; index++) addCommandActivity(second.projection, `second-chat-command-${index}`, `PRIVATE_SECOND_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);

  await fixture.run();

  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "accepted");
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.visibilityMisses, 1);
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(request?.kind, "review");
  assert.deepEqual(request?.batch?.threads.map(thread => thread.threadId), [second.task.threadId]);
  assert.ok(supervisorRequestCall(fixture, "review"));
});

test("a deleted operative introduction is blocked while another operative chat still gets reviewed", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  const second = fixture.addOperative("operative-b", "proposal-2");
  fixture.conversation.requests.saveIntroduction({
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "ready",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: null,
    error: null,
  });
  appendNoticeForTask(fixture, second.task, second.projection);
  for (let index = 1; index <= 3; index++) addCommandActivity(second.projection, `surviving-chat-command-${index}`, `PRIVATE_SURVIVING_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  fixture.setProjectionFailure(operativeThreadId, new T3TransportError("deleted", 404));

  await fixture.run();

  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "blocked");
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(request?.kind, "review");
  assert.deepEqual(request?.batch?.threads.map(thread => thread.threadId), [second.task.threadId]);
  assert.ok(supervisorRequestCall(fixture, "review"));
});

test("an unreadable introduced chat does not stop a healthy chat review or acknowledge unread activity", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const projectionFailures: Array<{ label: string; error: Error }> = [
    { label: "projection error", error: new Error("projection unavailable") },
    { label: "deleted thread", error: new T3TransportError("deleted", 404) },
  ];
  for (const [index, failure] of projectionFailures.entries()) {
    const fixture = await makeFixture(clock, { settings: { intervalMinutes: 5, activityThreshold: 3 } });
    t.after(fixture.cleanup);
    const healthy = fixture.addOperative("operative-b", `proposal-healthy-${index}`);
    appendNoticeToOperative(fixture);
    appendNoticeForTask(fixture, healthy.task, healthy.projection);
    for (let item = 1; item <= 3; item++) {
      addCommandActivity(fixture.operative, `unreadable-${index}-${item}`, `PRIVATE_UNREADABLE_${item}`, clock.now - item * 1_000);
      addCommandActivity(healthy.projection, `healthy-${index}-${item}`, `PRIVATE_HEALTHY_${item}`, clock.now - item * 1_000);
    }
    await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
    fixture.setProjectionFailure(operativeThreadId, failure.error);

    await fixture.run();

    const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
    assert.equal(request?.kind, "review", failure.label);
    assert.deepEqual(request?.batch?.threads.map(thread => thread.threadId), [healthy.task.threadId], failure.label);
    const reviewRun = fixture.supervisor.runs.find(run => run.userMessageId === request?.messageId);
    assert.ok(reviewRun);
    completeRun(fixture.supervisor, reviewRun, `Healthy chat review complete. ${request?.completionMarker}`, clock.now + 1);
    clock.now++;
    await fixture.run();

    const unreadablePendingIds = new Set(fixture.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id));
    const healthyPendingIds = new Set(fixture.conversation.monitor.pending(projectId, healthy.task.threadId).map(item => item.id));
    for (let item = 1; item <= 3; item++) {
      assert.ok(unreadablePendingIds.has(`unreadable-${index}-${item}`), `${failure.label} must retain unread activity`);
      assert.equal(healthyPendingIds.has(`healthy-${index}-${item}`), false, `${failure.label} must not prevent healthy activity acknowledgement`);
    }
    clock.now += 60_001;
  }
});

test("preparing, starting, and waiting operative runs keep the initial proposal ready without latching a mode", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  for (const status of ["preparing", "starting", "waiting"] as const) {
    const fixture = await makeFixture(clock, { operativeActive: false });
    t.after(fixture.cleanup);
    const run = appendRun({
      projection: fixture.operative,
      id: `operative-${status}-run`,
      ordinal: 2,
      status,
      messageId: `operative-${status}-input`,
      text: "The task is not actively running yet.",
      now: clock.now,
    });
    fixture.operative.thread.activeRunId = run.id;
    fixture.conversation.requests.saveIntroduction({
      taskId: fixture.task.id,
      projectId,
      threadId: operativeThreadId,
      supervisorThreadId: fixture.binding.threadId,
      state: "ready",
      text: workflowIntroductionText(fixture.task),
      messageId: `supervisor-notice:workflow:${fixture.task.id}`,
      targetRunId: null,
      error: null,
    });

    await fixture.run();

    assert.equal(fixture.calls.some(item => item.payload.threadId === operativeThreadId), false, `${status} runs wait without an RPC`);
    assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "ready");
    assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.dispatchMode, undefined);
    const reopened = fixture.makeRestartedConversation();
    assert.equal(reopened.requests.introduction(fixture.task.id)?.state, "ready", "the existing durable ready proposal survives a service reopen");
    assert.equal(reopened.requests.introduction(fixture.task.id)?.dispatchMode, undefined, "waiting does not latch a dispatch mode");

    if (status !== "waiting") {
      activateProviderTurn(fixture.operative, run);
      fixture.operative.thread.activeRunId = run.id;
      clock.now += 5_001;
      await fixture.run();
      const call = fixture.calls.find(item => item.payload.threadId === operativeThreadId);
      assert.ok(call, `${status} proposal sends after a real provider turn starts`);
      assert.deepEqual(call.payload.dispatchMode, {type: "steer_active", targetRunId: run.id});
    }
    clock.now++;
  }
});

test("a running main without matching provider-turn evidence waits, then targets the live turn", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  fixture.operative.providerTurns = [];
  fixture.conversation.requests.saveIntroduction({
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "ready",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: null,
    error: null,
  });

  await fixture.run();
  assert.equal(fixture.calls.some(item => item.payload.threadId === operativeThreadId), false);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "ready");
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.dispatchMode, undefined);

  const activeRun = fixture.operative.runs.find(run => run.id === fixture.operative.thread.activeRunId);
  assert.ok(activeRun);
  fixture.operative.providerTurns = [{id: "live-provider-turn", runAttemptId: activeRun.activeAttemptId, nodeId: activeRun.rootNodeId, status: "running"}];
  clock.now += 5_001;
  await fixture.run();
  const call = fixture.calls.find(item => item.payload.threadId === operativeThreadId);
  assert.ok(call);
  assert.deepEqual(call.payload.dispatchMode, {type: "steer_active", targetRunId: activeRun.id});
});

test("a fresh pending owner runtime request holds the proposal until resolution", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const activeRun = fixture.operative.runs.find(run => run.id === fixture.operative.thread.activeRunId);
  assert.ok(activeRun?.rootNodeId);
  fixture.operative.runtimeRequests = [{id: "owner-question", kind: "user_input", status: "pending", nodeId: activeRun.rootNodeId,
    providerTurnId: "owner-provider-turn", createdAt: iso(clock.now)}];
  fixture.conversation.requests.saveIntroduction({
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "ready",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: null,
    error: null,
  });

  await fixture.run();
  assert.equal(fixture.calls.some(item => item.payload.threadId === operativeThreadId), false);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "ready");
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.dispatchMode, undefined);

  (fixture.operative.runtimeRequests as Array<Record<string, unknown>>)[0]!.status = "resolved";
  clock.now += 5_001;
  await fixture.run();
  const call = fixture.calls.find(item => item.payload.threadId === operativeThreadId);
  assert.ok(call);
  assert.deepEqual(call.payload.dispatchMode, {type: "steer_active", targetRunId: activeRun.id});
});

test("a definite active-steering rejection falls back once with new queued IDs and retains the rejected attempt", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  fixture.conversation.requests.saveIntroduction({
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "ready",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: null,
    error: null,
  });
  fixture.rejectNextIntroduction();

  await fixture.run();

  const initial = fixture.calls.find(call => call.payload.threadId === operativeThreadId);
  assert.ok(initial);
  assert.deepEqual(initial.payload.dispatchMode, { type: "steer_active", targetRunId: "operative-active-run" });
  const queued = fixture.conversation.requests.introduction(fixture.task.id);
  assert.equal(queued?.state, "ready");
  assert.deepEqual(queued?.dispatchMode, { type: "queue_after_active" });
  assert.equal(queued?.rejectedAttempts?.length, 1);
  assert.deepEqual(queued?.rejectedAttempts?.[0], {
    messageId: initial.payload.messageId,
    commandId: initial.payload.commandId,
    dispatchMode: initial.payload.dispatchMode,
  });

  await fixture.run();
  const attempts = fixture.calls.filter(call => call.payload.threadId === operativeThreadId);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[1]?.payload.messageId, initial.payload.messageId);
  assert.notEqual(attempts[1]?.payload.commandId, initial.payload.commandId);
  assert.deepEqual(attempts[1]?.payload.dispatchMode, { type: "queue_after_active" });
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "accepted");

  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.payload.threadId === operativeThreadId).length, 2, "the fallback is sent only once");
});

test("a rejected queued fallback waits for explicit retry, then uses fresh queued IDs with both attempts retained", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  fixture.conversation.requests.saveIntroduction({
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "ready",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: null,
    error: null,
  });
  fixture.rejectNextIntroduction(2);

  await fixture.run();
  const initial = fixture.calls.find(call => call.payload.threadId === operativeThreadId);
  assert.ok(initial);
  await fixture.run();
  const firstFallback = fixture.calls.filter(call => call.payload.threadId === operativeThreadId)[1];
  assert.ok(firstFallback);
  assert.notEqual(firstFallback.payload.messageId, initial.payload.messageId);
  assert.notEqual(firstFallback.payload.commandId, initial.payload.commandId);
  assert.deepEqual(firstFallback.payload.dispatchMode, { type: "queue_after_active" });
  const blocked = fixture.conversation.requests.introduction(fixture.task.id);
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.definiteRejection, true);
  assert.equal(blocked?.rejectedAttempts?.length, 1, "the first steer rejection remains attached while the fallback rejection is current");

  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.payload.threadId === operativeThreadId).length, 2, "a definite queue rejection is never replayed automatically");
  fixture.conversation.retry(projectId, fixture.binding.threadId);
  const retry = fixture.conversation.requests.introduction(fixture.task.id);
  assert.equal(retry?.state, "ready");
  assert.deepEqual(retry?.dispatchMode, { type: "queue_after_active" });
  assert.equal(retry?.rejectedAttempts?.length, 2);
  assert.deepEqual(retry?.rejectedAttempts?.[0], {
    messageId: initial.payload.messageId,
    commandId: initial.payload.commandId,
    dispatchMode: initial.payload.dispatchMode,
  });
  assert.deepEqual(retry?.rejectedAttempts?.[1], {
    messageId: firstFallback.payload.messageId,
    commandId: firstFallback.payload.commandId,
    dispatchMode: firstFallback.payload.dispatchMode,
  });

  await fixture.run();
  const attempts = fixture.calls.filter(call => call.payload.threadId === operativeThreadId);
  assert.equal(attempts.length, 3);
  assert.notEqual(attempts[2]?.payload.messageId, firstFallback.payload.messageId);
  assert.notEqual(attempts[2]?.payload.commandId, firstFallback.payload.commandId);
  assert.deepEqual(attempts[2]?.payload.dispatchMode, { type: "queue_after_active" });
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "accepted");
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.rejectedAttempts?.length, 2);
});

test("a pending owner request does not block reconciliation of an uncertain queued fallback", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  fixture.conversation.requests.saveIntroduction({
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "ready",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: null,
    error: null,
  });
  fixture.rejectNextIntroduction();

  await fixture.run();
  const rejectedSteer = fixture.calls.find(call => call.payload.threadId === operativeThreadId);
  assert.ok(rejectedSteer);
  assert.deepEqual(rejectedSteer.payload.dispatchMode, {type: "steer_active", targetRunId: "operative-active-run"});
  fixture.failNextIntroduction();
  await fixture.run();
  const uncertainFallback = fixture.calls.filter(call => call.payload.threadId === operativeThreadId)[1];
  assert.ok(uncertainFallback);
  assert.deepEqual(uncertainFallback.payload.dispatchMode, {type: "queue_after_active"});
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "uncertain");

  const activeRun = fixture.operative.runs.find(run => run.id === fixture.operative.thread.activeRunId);
  assert.ok(activeRun?.rootNodeId);
  fixture.operative.runtimeRequests = [{id: "owner-question-during-reconcile", kind: "user_input", status: "pending", nodeId: activeRun.rootNodeId,
    providerTurnId: "owner-provider-turn", createdAt: iso(clock.now)}];
  fixture.conversation.retry(projectId, fixture.binding.threadId);
  clock.now += 5_001;
  await fixture.run();

  const attempts = fixture.calls.filter(call => call.payload.threadId === operativeThreadId);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[2]?.payload.messageId, uncertainFallback.payload.messageId);
  assert.equal(attempts[2]?.payload.commandId, uncertainFallback.payload.commandId);
  assert.deepEqual(attempts[2]?.payload.dispatchMode, uncertainFallback.payload.dispatchMode);
});

test("one review stays in flight while activity changes and acknowledges only its frozen batch", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);

  await fixture.run();
  const firstCall = supervisorRequestCall(fixture, "review");
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(firstCall && request?.batch);
  assert.equal(request.kind, "review");
  assert.deepEqual(firstCall.payload.dispatchMode, { type: "queue_after_active" });
  for (let index = 1; index <= 3; index++) assert.equal(String(firstCall.payload.text).includes(`PRIVATE_COMMAND_BODY_${index}`), false);
  assert.equal(JSON.stringify(request.batch).includes("PRIVATE_COMMAND_BODY"), false);

  addCommandActivity(fixture.operative, "command-arrived-during-review", "PRIVATE_COMMAND_BODY_NEW", clock.now + 31_000);
  clock.now += 31_000;
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.payload.threadId === fixture.binding.threadId).length, 1);
  assert.ok(fixture.conversation.monitor.pending(projectId, operativeThreadId).some(item => item.id === "command-arrived-during-review"));

  const reviewRun = fixture.supervisor.runs.find(run => run.userMessageId === request.messageId);
  assert.ok(reviewRun);
  completeRun(fixture.supervisor, reviewRun, `No intervention is needed. ${request.completionMarker}`, clock.now + 1);
  clock.now++;
  await fixture.run();
  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === request.id)?.state, "completed");
  assert.deepEqual(fixture.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id), ["command-arrived-during-review"]);
});

test("primary replacement, missing markers and an untrusted interruption close reviews until the third miss requires retry", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `contaminated-command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  const requests: ConversationRequest[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await fixture.run();
    const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
    assert.ok(request?.kind === "review" && request.batch);
    requests.push(request);
    const run = fixture.supervisor.runs.find(candidate => candidate.userMessageId === request.messageId);
    assert.ok(run);
    if (attempt === 1) {
      run.userMessageId = "peer-restart-primary-message";
      assert.notEqual(run.userMessageId, request.messageId);
    }
    if (attempt === 2) {
      appendMessageToRun(fixture.supervisor, run, {
        id: "untrusted-human-interruption-during-review",
        role: "user",
        text: "Please do another task.",
        createdBy: "user",
        creationSource: "web",
        now: clock.now,
      });
    }
    completeRun(fixture.supervisor, run, "The completed review omitted its required marker.", clock.now + 1);
    clock.now += 60_001;
    await fixture.run();

    const closed = fixture.conversation.requests.requests(projectId).find(item => item.id === request.id);
    assert.equal(closed?.state, attempt < 3 ? "completed" : "failed");
    if (attempt === 1) assert.equal(closed?.runId, run.id, "the restarted run is terminally reconciled by its request message");
    assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId), null, "a replaced run primary is terminal rather than an endless wait");
    assert.equal(fixture.conversation.requests.reviewMisses(fixture.binding.threadId), attempt);
    const pendingIds = new Set(fixture.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id));
    for (let index = 1; index <= 3; index++) assert.ok(pendingIds.has(`contaminated-command-${index}`));
    if (attempt < 3) assert.equal(fixture.conversation.status(projectId, fixture.binding.threadId).state, "idle");
  }

  assert.equal(fixture.conversation.status(projectId, fixture.binding.threadId).state, "unavailable");
  assert.equal(requests[2]?.failureAcknowledged, undefined);
  fixture.conversation.retry(projectId, fixture.binding.threadId);
  assert.equal(fixture.conversation.requests.reviewMisses(fixture.binding.threadId), 0);
  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === requests[2]?.id)?.failureAcknowledged, true);
  await fixture.run();
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId)?.kind, "review");
});

test("a direct peer reply with senderThreadId does not contaminate a valid review", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `peer-safe-command-${index}`, `PRIVATE_PEER_SAFE_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  await fixture.run();

  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(request?.kind === "review" && request.batch);
  const run = fixture.supervisor.runs.find(candidate => candidate.userMessageId === request.messageId);
  assert.ok(run);
  const peer = appendMessageToRun(fixture.supervisor, run, {
    id: "trusted-peer-reply-during-review",
    role: "user",
    text: "The response is from a linked peer.",
    createdBy: "user",
    creationSource: "web",
    now: clock.now,
  });
  peer.senderThreadId = "peer-thread";
  completeRun(fixture.supervisor, run, `Review complete. ${request.completionMarker}`, clock.now + 1);
  clock.now++;

  await fixture.run();

  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === request.id)?.state, "completed");
  assert.equal(fixture.conversation.monitor.pending(projectId, operativeThreadId).length, 0);
});

test("a 100-item monitor burst freezes and acknowledges all activity while showing only 20 IDs in the prompt", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  for (let index = 0; index < 100; index++) addCommandActivity(fixture.operative, `burst-command-${index}`, `PRIVATE_BURST_BODY_${index}`, clock.now - (100 - index) * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  await fixture.run();

  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(request?.kind === "review" && request.batch);
  const frozenIds = new Set(request.batch.threads[0]?.items.map(item => item.id));
  assert.ok((frozenIds.size ?? 0) >= 100);
  for (let index = 0; index < 100; index++) assert.ok(frozenIds.has(`burst-command-${index}`));
  assert.equal(request.batch.threads[0]?.previewItems.length, 20);
  assert.equal(JSON.stringify(request.batch).includes("PRIVATE_BURST_BODY"), false);
  const envelopeStart = request.text.indexOf("UNTRUSTED_MONITOR_ENVELOPE\n") + "UNTRUSTED_MONITOR_ENVELOPE\n".length;
  const envelopeEnd = request.text.indexOf("\nEND_UNTRUSTED_MONITOR_ENVELOPE", envelopeStart);
  const envelope = JSON.parse(request.text.slice(envelopeStart, envelopeEnd)) as { threads: Array<{ items: Array<{ id: string }>; pendingItemCount: number }> };
  const preview = envelope.threads[0]?.items ?? [];
  assert.equal(preview.length, 20, "the model receives a bounded preview rather than every frozen activity ID");
  assert.equal(new Set(preview.map(item => item.id)).size, 20);
  assert.equal(envelope.threads[0]?.pendingItemCount, frozenIds.size, "the preview retains the complete frozen count");
  for (const item of preview) assert.ok(frozenIds.has(item.id));

  const reviewRun = fixture.supervisor.runs.find(run => run.userMessageId === request.messageId);
  assert.ok(reviewRun);
  completeRun(fixture.supervisor, reviewRun, `Burst review complete. ${request.completionMarker}`, clock.now + 1);
  clock.now++;
  await fixture.run();

  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === request.id)?.state, "completed");
  assert.equal(fixture.conversation.monitor.pending(projectId, operativeThreadId).length, 0, "all 100 frozen metadata items are acknowledged together");
});

test("completed activity first observed on new and reused children is batched by the owning Supervisor", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, {operativeActive: false, settings: {intervalMinutes: 5, activityThreshold: 3}});
  t.after(fixture.cleanup);
  fixture.projectStore.saveTask({...fixture.task, sourceOrdinal: 2});
  fixture.conversation.requests.saveIntroduction({taskId: fixture.task.id, projectId, threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId, state: "sent", text: "Existing workflow context.", messageId: "workflow-context",
    targetRunId: null, error: null});
  const child = makeProjection(makeThread({id: "operative-native-child", title: "Native child"}));
  child.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  child.thread.creationSource = "provider";
  for (let index = 1; index <= 3; index++) turnItemsOf(child).push({id: `child-command-${index}`, threadId: child.thread.id,
    runId: null, type: "command_execution", status: "completed", ordinal: index, completedAt: iso(clock.now - 30_000 + index),
    updatedAt: iso(clock.now - 30_000 + index), input: `PRIVATE_CHILD_BODY_${index}`, output: "ok"});
  fixture.addChildProjection(child);

  const nested = makeProjection(makeThread({id: "operative-nested-delegated-child", title: "Nested delegated child"}));
  nested.thread.lineage = {parentThreadId: child.thread.id, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  nested.thread.creationSource = "mcp";
  const nestedRun = appendRun({projection: nested, id: "nested-current-run", ordinal: 1, status: "completed",
    messageId: "nested-current-input", text: "Nested delegated child work", now: clock.now - 25_000});
  nested.thread.activeRunId = nestedRun.id;
  addCommandActivity(nested, "nested-current-command", "PRIVATE_NESTED_BODY", clock.now - 20_000);
  nested.thread.activeRunId = null;
  fixture.addChildProjection(nested);

  const delegated = makeProjection(makeThread({id: "operative-new-delegated-child", title: "New delegated child"}));
  delegated.thread.projectId = "other-project";
  delegated.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  delegated.thread.creationSource = "mcp";
  const delegatedRun = appendRun({projection: delegated, id: "delegated-current-run", ordinal: 1, status: "completed",
    messageId: "delegated-current-input", text: "Current delegated child work", now: clock.now - 25_000});
  delegated.thread.activeRunId = delegatedRun.id;
  addCommandActivity(delegated, "delegated-current-command", "PRIVATE_DELEGATED_BODY", clock.now - 20_000);
  delegated.thread.activeRunId = null;
  fixture.addChildProjection(delegated);

  const reused = makeProjection(makeThread({id: "operative-reused-child", title: "Reused delegated child"}));
  reused.thread.projectId = "other-project";
  reused.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  reused.thread.creationSource = "mcp";
  const oldRun = appendRun({projection: reused, id: "reused-old-run", ordinal: 1, status: "completed",
    messageId: "reused-old-input", text: "Old child work", now: clock.now - 300_000});
  reused.thread.activeRunId = oldRun.id;
  addCommandActivity(reused, "reused-old-command", "PRIVATE_OLD_CHILD_BODY", clock.now - 240_000);
  const currentRun = appendRun({projection: reused, id: "reused-current-run", ordinal: 2, status: "completed",
    messageId: "reused-current-input", text: "Current child work", now: clock.now - 30_000});
  reused.thread.activeRunId = currentRun.id;
  addCommandActivity(reused, "reused-current-command", "PRIVATE_CURRENT_CHILD_BODY", clock.now - 20_000);
  reused.thread.activeRunId = null;
  fixture.addChildProjection(reused);

  const routeParent = makeProjection(makeThread({id: "operative-active-delegated-parent", title: "Active delegated parent"}));
  routeParent.thread.projectId = "other-project";
  routeParent.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  routeParent.thread.creationSource = "mcp";
  const routeParentRun = appendRun({projection: routeParent, id: "route-parent-active-run", ordinal: 1, status: "running",
    messageId: "route-parent-input", text: "Active delegated parent work", now: clock.now - 20_000});
  routeParent.thread.activeRunId = routeParentRun.id;
  fixture.addChildProjection(routeParent);

  const routeTarget = makeProjection(makeThread({id: "operative-child-with-active-parent", title: "Child with active delegated parent"}));
  routeTarget.thread.lineage = {parentThreadId: routeParent.thread.id, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  routeTarget.thread.creationSource = "mcp";
  const routeTargetRun = appendRun({projection: routeTarget, id: "route-target-run", ordinal: 1, status: "completed",
    messageId: "route-target-input", text: "Child work below the active delegated parent", now: clock.now - 30_000});
  routeTarget.thread.activeRunId = routeTargetRun.id;
  addCommandActivity(routeTarget, "route-target-command", "PRIVATE_ROUTE_TARGET_BODY", clock.now - 20_000);
  routeTarget.thread.activeRunId = null;
  fixture.addChildProjection(routeTarget);

  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  assert.equal(fixture.conversation.monitor.hasState(projectId, child.thread.id), true);
  assert.equal(fixture.conversation.monitor.pending(projectId, operativeThreadId).length, 0);
  assert.equal(fixture.conversation.monitor.pending(projectId, child.thread.id).length, 3);
  assert.equal(fixture.conversation.monitor.pending(projectId, delegated.thread.id).some(item => item.id === "delegated-current-command"), true);
  assert.equal(fixture.conversation.monitor.pending(projectId, reused.thread.id).some(item => item.id === "reused-current-command"), true);
  assert.equal(fixture.conversation.monitor.pending(projectId, reused.thread.id).some(item => item.id === "reused-old-command"), false);
  await fixture.run();

  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(request?.kind === "review" && request.batch);
  assert.deepEqual(request.batch.threads.map(item => item.threadId).sort(), [child.thread.id, nested.thread.id, delegated.thread.id, reused.thread.id, routeTarget.thread.id].sort());
  assert.equal(request.batch.threads.find(item => item.threadId === child.thread.id)?.items.length, 3);
  assert.equal(request.batch.threads.find(item => item.threadId === reused.thread.id)?.items.some(item => item.id === "reused-current-command"), true);
  assert.equal(request.batch.threads.find(item => item.threadId === reused.thread.id)?.items.some(item => item.id === "reused-old-command"), false);
  assert.equal(request.batch.threads.find(item => item.threadId === delegated.thread.id)?.items.some(item => item.id === "delegated-current-command"), true);
  const envelopeStart = request.text.indexOf("UNTRUSTED_MONITOR_ENVELOPE\n") + "UNTRUSTED_MONITOR_ENVELOPE\n".length;
  const envelopeEnd = request.text.indexOf("\nEND_UNTRUSTED_MONITOR_ENVELOPE", envelopeStart);
  const envelope = JSON.parse(request.text.slice(envelopeStart, envelopeEnd)) as {threads: Array<{threadId: string; origin: string; parentThreadId: string | null;
    fallbackAncestors: Array<{threadId: string; main: boolean; eligible: boolean; contactable: boolean}>;
    activityRefs: Array<{sourceThreadId: string; sourceItemId: string | null}>}>};
  const nativeEnvelope = envelope.threads.find(item => item.threadId === child.thread.id);
  assert.equal(nativeEnvelope?.origin, "native_child");
  assert.equal(nativeEnvelope?.parentThreadId, operativeThreadId);
  assert.deepEqual(nativeEnvelope?.fallbackAncestors, [{threadId: operativeThreadId, main: true, eligible: true, contactable: true}]);
  assert.equal(nativeEnvelope?.activityRefs[0]?.sourceThreadId, child.thread.id);
  assert.ok(nativeEnvelope?.activityRefs[0]?.sourceItemId);
  assert.equal(envelope.threads.find(item => item.threadId === delegated.thread.id)?.origin, "delegated_child");
  assert.equal(envelope.threads.find(item => item.threadId === reused.thread.id)?.origin, "delegated_child");
  const nestedEnvelope = envelope.threads.find(item => item.threadId === nested.thread.id);
  assert.deepEqual(nestedEnvelope?.fallbackAncestors, [
    {threadId: child.thread.id, main: false, eligible: false, contactable: false},
    {threadId: operativeThreadId, main: true, eligible: true, contactable: true},
  ], "native ancestors are not offered as direct delivery routes; the main remains a possible route");
  const routeEnvelope = envelope.threads.find(item => item.threadId === routeTarget.thread.id);
  assert.deepEqual(routeEnvelope?.fallbackAncestors, [
    {threadId: routeParent.thread.id, main: false, eligible: true, contactable: true},
    {threadId: operativeThreadId, main: true, eligible: true, contactable: true},
  ], "a delegated ancestor is offered only with matching running provider-turn evidence and verified scope, not project ID equality");
  assert.equal(request.text.includes("PRIVATE_CHILD_BODY"), false);
  assert.equal(request.text.includes("PRIVATE_DELEGATED_BODY"), false);
  assert.equal(request.text.includes("PRIVATE_OLD_CHILD_BODY"), false);
  assert.equal(request.text.includes("PRIVATE_CURRENT_CHILD_BODY"), false);
  assert.equal(request.text.includes("PRIVATE_NESTED_BODY"), false);
  assert.equal(request.text.includes("PRIVATE_ROUTE_TARGET_BODY"), false);
  assert.ok(request.text.includes("Contact the operative main using mode auto; T3 will steer an active turn or start/queue a turn when idle."));
  assert.ok(request.text.includes("Guide native children through their nearest verified eligible, contactable ancestor in fallbackAncestors."));
  assert.ok(request.text.includes("For a verified active delegated child, use mode steer only."));
  assert.ok(request.text.includes("If its result is delivery:started instead of steered, treat it as a wake"));
  assert.ok(request.text.includes("route through the nearest verified eligible, contactable ancestor"));
  assert.ok(request.text.includes("After a definite rejection from the main, fresh-read and reconsider at a later check-in"));
  assert.ok(request.text.includes("When a child cannot be steered or a definite child-steer rejection occurs, use the supplied fallbackAncestors in order"));
  assert.ok(request.text.includes("pending runtime question or approval, defer potentially interrupting guidance"));
  assert.equal(fixture.calls.filter(call => call.payload.threadId === fixture.binding.threadId && call.payload.type === "message.dispatch").length, 1);
});

test("a fresh native child terminal record wakes the owning Supervisor without age/count and fences stale history", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, {operativeActive: false, settings: {intervalMinutes: 60, activityThreshold: 10}});
  t.after(fixture.cleanup);
  fixture.projectStore.saveTask({...fixture.task, sourceOrdinal: 2});
  fixture.conversation.requests.saveIntroduction({taskId: fixture.task.id, projectId, threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId, state: "sent", text: "Existing workflow context.", messageId: "workflow-context",
    targetRunId: null, error: null});

  const current = makeProjection(makeThread({id: "native-terminal-current", title: "Current native child"}));
  current.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  current.thread.creationSource = "provider";
  current.thread.createdAt = iso(clock.now - 10_000);
  current.thread.activityRunStatus = "idle";
  fixture.addChildProjection(current);

  const old = makeProjection(makeThread({id: "native-terminal-old", title: "Old native child"}));
  old.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  old.thread.creationSource = "provider";
  old.thread.createdAt = iso(clock.now - 10_000);
  fixture.addChildProjection(old);

  const ambiguous = makeProjection(makeThread({id: "native-terminal-ambiguous", title: "Ambiguous native child"}));
  ambiguous.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  ambiguous.thread.creationSource = "provider";
  ambiguous.thread.createdAt = iso(clock.now - 10_000);
  fixture.addChildProjection(ambiguous);

  const unknownTimestamp = makeProjection(makeThread({id: "native-terminal-unknown-time", title: "Native child without terminal time"}));
  unknownTimestamp.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  unknownTimestamp.thread.creationSource = "provider";
  unknownTimestamp.thread.createdAt = iso(clock.now - 10_000);
  fixture.addChildProjection(unknownTimestamp);

  const currentRecord = {id: "native-node-current", childThreadId: current.thread.id, providerThreadId: "provider-current",
    runId: "parent-run-current", status: "completed", startedAt: iso(clock.now - 5_000), completedAt: iso(clock.now - 1_000), updatedAt: iso(clock.now - 900)};
  const oldRecord = {id: "native-node-old", childThreadId: old.thread.id, providerThreadId: "provider-old",
    runId: "parent-run-old", status: "completed", startedAt: iso(clock.now - 700_000), completedAt: iso(clock.now - 650_000), updatedAt: iso(clock.now - 500)};
  const unknownTimestampRecord = {id: "native-node-unknown-time", childThreadId: unknownTimestamp.thread.id,
    providerThreadId: "provider-unknown-time", runId: "parent-run-unknown-time", status: "completed",
    startedAt: iso(clock.now - 5_000), completedAt: null, updatedAt: null};
  fixture.operative.subagents = [currentRecord, oldRecord,
    {...currentRecord, id: "native-node-ambiguous-running", childThreadId: ambiguous.thread.id, status: "running", completedAt: null},
    unknownTimestampRecord];
  turnItemsOf(fixture.operative).push(
    {id: "parent-native-current", type: "subagent", threadId: operativeThreadId, childThreadId: current.thread.id,
      subagentId: currentRecord.id, providerThreadId: currentRecord.providerThreadId, runId: currentRecord.runId, status: currentRecord.status,
      startedAt: currentRecord.startedAt, completedAt: currentRecord.completedAt, updatedAt: currentRecord.updatedAt},
    {id: "parent-native-old", type: "subagent", threadId: operativeThreadId, childThreadId: old.thread.id,
      subagentId: oldRecord.id, providerThreadId: oldRecord.providerThreadId, runId: oldRecord.runId, status: oldRecord.status,
      startedAt: oldRecord.startedAt, completedAt: oldRecord.completedAt, updatedAt: oldRecord.updatedAt},
    {id: "parent-native-ambiguous", type: "subagent", threadId: operativeThreadId, childThreadId: ambiguous.thread.id,
      subagentId: "native-node-ambiguous-completed", providerThreadId: "provider-ambiguous", runId: "parent-run-ambiguous",
      status: "completed", startedAt: iso(clock.now - 5_000), completedAt: iso(clock.now - 1_000), updatedAt: iso(clock.now - 900)},
    {id: "parent-native-unknown-time", type: "subagent", threadId: operativeThreadId, childThreadId: unknownTimestamp.thread.id,
      subagentId: unknownTimestampRecord.id, providerThreadId: unknownTimestampRecord.providerThreadId, runId: unknownTimestampRecord.runId,
      status: "completed", startedAt: unknownTimestampRecord.startedAt, completedAt: null, updatedAt: null},
  );

  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  const currentPending = fixture.conversation.monitor.pending(projectId, current.thread.id);
  assert.equal(currentPending.length, 1);
  assert.equal(currentPending[0]?.type, "native_child_lifecycle");
  assert.equal(currentPending[0]?.priority, "run_finished");
  assert.deepEqual(fixture.conversation.monitor.pending(projectId, old.thread.id), []);
  assert.deepEqual(fixture.conversation.monitor.pending(projectId, ambiguous.thread.id), []);
  assert.deepEqual(fixture.conversation.monitor.pending(projectId, unknownTimestamp.thread.id), []);
  await fixture.run();
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(request?.kind === "review" && request.batch);
  assert.equal(request.batch.trigger, "priority");
  assert.deepEqual(request.batch.threads.map(item => item.threadId), [current.thread.id]);
  assert.equal(request.batch.threads[0]?.items[0]?.type, "native_child_lifecycle");
  const run = fixture.supervisor.runs.find(candidate => candidate.userMessageId === request.messageId);
  assert.ok(run);
  completeRun(fixture.supervisor, run, `Terminal child record reviewed. ${request.completionMarker}`, clock.now + 1);
  clock.now++;
  await fixture.run();
  assert.deepEqual(fixture.conversation.monitor.pending(projectId, current.thread.id), []);
});

test("terminal child AppRuns are not duplicated when their parent completion arrives later", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, {operativeActive: false, settings: {intervalMinutes: 60, activityThreshold: 10}});
  t.after(fixture.cleanup);
  fixture.projectStore.saveTask({...fixture.task, sourceOrdinal: 2});
  fixture.conversation.requests.saveIntroduction({taskId: fixture.task.id, projectId, threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId, state: "sent", text: "Existing workflow context.", messageId: "workflow-context",
    targetRunId: null, error: null});

  const child = makeProjection(makeThread({id: "delegated-terminal-child", title: "Delegated terminal child"}));
  child.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  child.thread.creationSource = "mcp";
  child.thread.createdAt = iso(clock.now - 10_000);
  appendRun({projection: child, id: "delegated-terminal-run", ordinal: 1, status: "completed",
    messageId: "delegated-terminal-input", text: "Finish delegated work.", createdBy: "system", creationSource: "server",
    now: clock.now - 5_000});
  child.messages = [];
  fixture.addChildProjection(child);

  const nativeMirror = makeProjection(makeThread({id: "provider-terminal-child", title: "Provider terminal child"}));
  nativeMirror.thread.lineage = {parentThreadId: operativeThreadId, relationshipToParent: "subagent", rootThreadId: operativeThreadId};
  nativeMirror.thread.creationSource = "provider";
  nativeMirror.thread.createdAt = iso(clock.now - 10_000);
  appendRun({projection: nativeMirror, id: "provider-terminal-run", ordinal: 1, status: "completed",
    messageId: "provider-terminal-input", text: "Finish provider work.", createdBy: "system", creationSource: "server",
    now: clock.now - 5_000});
  nativeMirror.messages = [];
  fixture.addChildProjection(nativeMirror);

  const parentRecord = {id: "delegated-child-record", childThreadId: child.thread.id, runId: "parent-run-delegated",
    status: "running", startedAt: iso(clock.now - 6_000), completedAt: null as string | null, updatedAt: iso(clock.now - 5_000)};
  const nativeParentRecord = {id: "provider-child-record", childThreadId: nativeMirror.thread.id, runId: "parent-run-provider",
    status: "running", startedAt: iso(clock.now - 6_000), completedAt: null as string | null, updatedAt: iso(clock.now - 5_000)};
  fixture.operative.subagents = [parentRecord, nativeParentRecord];
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  for (const childId of [child.thread.id, nativeMirror.thread.id]) {
    const pending = fixture.conversation.monitor.pending(projectId, childId);
    assert.equal(pending.filter(item => item.type === "run_finished").length, 1);
    assert.equal(pending.some(item => item.type === "native_child_lifecycle"), false);
  }

  parentRecord.status = "completed";
  parentRecord.completedAt = iso(clock.now - 1_000);
  parentRecord.updatedAt = iso(clock.now - 900);
  nativeParentRecord.status = "completed";
  nativeParentRecord.completedAt = iso(clock.now - 1_000);
  nativeParentRecord.updatedAt = iso(clock.now - 900);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now + 1);
  for (const childId of [child.thread.id, nativeMirror.thread.id]) {
    const pending = fixture.conversation.monitor.pending(projectId, childId);
    assert.equal(pending.filter(item => item.type === "run_finished").length, 1);
    assert.equal(pending.some(item => item.type === "native_child_lifecycle"), false,
      "the delayed parent row must not create a second priority event for an existing terminal AppRun");
  }
});

test("completed history is bounded to the latest 100 while ancient uncertain work remains durable and does not consume capacity", async t => {
  const clock = { now: baseTime };
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const uncertain: ConversationRequest = {
    id: "ancient-uncertain-request",
    projectId,
    supervisorThreadId: fixture.binding.threadId,
    kind: "review",
    taskId: null,
    text: "uncertain",
    messageId: "uncertain-message",
    state: "uncertain",
    batch: null,
    createdAt: clock.now - 40 * 86_400_000,
    sentAt: null,
    runId: null,
    error: "delivery unknown",
    completionMarker: "marker",
  };
  for (let index = 0; index < 1_000; index++) {
    fixture.conversation.requests.saveRequest({
      ...uncertain,
      id: `completed-${index}`,
      messageId: `completed-message-${index}`,
      state: "completed",
      createdAt: clock.now,
      error: null,
    });
  }
  const next = fixture.conversation.requests.prepare({
    projectId,
    supervisorThreadId: fixture.binding.threadId,
    kind: "review",
    taskId: null,
    text: "next request",
    batch: null,
    completionMarker: "next marker",
  }, clock.now);
  assert.equal(next.state, "prepared", "a thousand retained terminal records do not block new work");
  fixture.conversation.requests.saveRequest(uncertain);
  fixture.conversation.requests.prune(clock.now);

  const retained = fixture.conversation.requests.requests(projectId);
  const terminal = retained.filter(request => request.state === "completed");
  assert.equal(terminal.length, 100);
  assert.equal(terminal.some(request => request.id === "completed-0"), false);
  assert.equal(terminal.some(request => request.id === "completed-999"), true);
  assert.equal(retained.some(request => request.id === uncertain.id && request.state === "uncertain"), true);
  assert.equal(retained.some(request => request.id === next.id && request.state === "prepared"), true);
});

test("prepared requests retain their native identity when monitoring settings change", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const request = fixture.conversation.requests.prepare({
    projectId,
    supervisorThreadId: fixture.binding.threadId,
    kind: "review",
    taskId: null,
    text: "Prepared before monitoring settings changed.",
    batch: null,
    completionMarker: "prepared request complete",
  }, clock.now);
  const settings = fixture.projectStore.settings(projectId);
  fixture.projectStore.saveSettings(projectId, settings.generation, settings.modelSelection, {
    intervalMinutes: 5,
    activityThreshold: 3,
  });

  await fixture.run();

  const dispatched = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(dispatched?.id, request.id);
  assert.equal(dispatched?.messageId, request.messageId);
  assert.equal(dispatched?.state, "waiting");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0]?.payload.messageId, request.messageId);
});

test("monitoring-only API saves update the live threshold without losing pending activity", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  const saveMonitoring = async (monitoring: { intervalMinutes: number; activityThreshold: number }) => {
    const settings = fixture.projectStore.settings(projectId);
    const outcome = await fixture.makeProjectSupervisor().save({
      projectId,
      expectedGeneration: settings.generation,
      modelSelection: settings.modelSelection,
      monitoring,
    }, AbortSignal.timeout(5_000));
    assert.equal(outcome.status, "saved", outcome.message);
    assert.deepEqual(outcome.snapshot?.settings.monitoring, monitoring);
    assert.deepEqual(outcome.snapshot?.settings.modelSelection, settings.modelSelection);
    return outcome;
  };
  appendNoticeToOperative(fixture);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  await fixture.run();
  const firstRequest = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(firstRequest?.kind === "review");
  const firstRun = fixture.supervisor.runs.find(run => run.userMessageId === firstRequest.messageId);
  assert.ok(firstRun);
  completeRun(fixture.supervisor, firstRun, `Initial check complete. ${firstRequest.completionMarker}`, clock.now + 1);
  clock.now++;
  await fixture.run();
  assert.equal(fixture.conversation.monitor.pending(projectId, operativeThreadId).length, 0);

  clock.now += 31_000;
  addCommandActivity(fixture.operative, "threshold-command-1", "PRIVATE_COMMAND_BODY_1", clock.now - 1_000);
  addCommandActivity(fixture.operative, "threshold-command-2", "PRIVATE_COMMAND_BODY_2", clock.now);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  assert.equal(fixture.conversation.monitor.pending(projectId, operativeThreadId).length, 2);

  await saveMonitoring({
    intervalMinutes: 5,
    activityThreshold: 4,
  });
  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.payload.threadId === fixture.binding.threadId).length, 1);
  assert.equal(fixture.conversation.monitor.pending(projectId, operativeThreadId).length, 2);

  addCommandActivity(fixture.operative, "threshold-command-3", "PRIVATE_COMMAND_BODY_3", clock.now + 1_000);
  clock.now += 31_000;
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  const pendingIds = new Set(fixture.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id));
  for (let index = 1; index <= 3; index++) assert.ok(pendingIds.has(`threshold-command-${index}`));

  clock.now += 31_000;
  await saveMonitoring({
    intervalMinutes: 5,
    activityThreshold: 3,
  });
  await fixture.run();
  const reviewCalls = fixture.calls.filter(call => call.payload.threadId === fixture.binding.threadId && String(call.payload.text).includes("Review this factual change index."));
  assert.equal(reviewCalls.length, 2);
  const resumedPendingIds = new Set(fixture.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id));
  const batchIds = new Set(fixture.conversation.requests.pending(projectId, fixture.binding.threadId)?.batch?.threads[0]?.items.map(item => item.id));
  for (let index = 1; index <= 3; index++) {
    assert.ok(resumedPendingIds.has(`threshold-command-${index}`));
    assert.ok(batchIds.has(`threshold-command-${index}`));
  }
});

test("legacy objective-only tasks without a proposed workflow do not create introductions", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { workflow: false });
  t.after(fixture.cleanup);

  await fixture.run();

  assert.equal(fixture.conversation.requests.introduction(fixture.task.id), null);
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId), null);
  assert.equal(fixture.calls.length, 0);
});

test("invalid and incomplete definitions still introduce finite provisional planning without saving agreement", async t => {
  const snapshots = [
    {...definitions(), status: "invalid" as const, revision: "invalid-observation-revision", projectConfig: null,
      issues: [{path: ".t3-supervisor/project.yaml", code: "project_configuration_invalid", message: "Repair the local configuration."}]},
    {...definitions(), status: "missing" as const, revision: null, complete: false, projectConfig: null,
      issues: [{path: ".t3-supervisor/project.yaml", code: "configuration_missing", message: "Create the local configuration."}]},
  ];
  for (const [index, snapshot] of snapshots.entries()) {
    const clock = {now: baseTime + index * 1_000_000};
    const fixture = await makeFixture(clock, {operativeActive: false});
    t.after(fixture.cleanup);
    const observed = {...snapshot, config: {required: [{step: "test-plan"}]}};
    const context = prepareWorkflowRequest(operativeThreadId, sourceMessageId, sourceText, observed).context;
    assert.ok(context);
    const plan = validateWorkflowPlan({requirements: [{kind: "step", id: "test-plan", applies: "unknown", reason: "The effective project configuration is incomplete."}], plan: {kind: "sequence", nodes: [
      {kind: "step", definitionId: null, localId: "bounded-review", name: "Review available context", description: "State unknown obligations.", reason: "Continue with finite planning."},
    ]}}, context);
    assert.ok(plan);
    assert.equal(plan.requirementsKnown, false);
    const provisionalTask: TaskRecord = {...fixture.task, definitionSnapshot: observed, definitionContext: context,
      workflow: {status: "provisional", message: "Requirements remain unknown.", workspaceRoot, revision: observed.revision,
        globalRevision: observed.globalRevision ?? null, ...plan}};
    fixture.projectStore.saveTask(provisionalTask);
    fixture.setDefinitions(observed);
    fixture.setDefinitionReadFailure(new Error("temporary definition source read failure"));

    await fixture.run();
    const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
    assert.equal(request?.kind, "context");
    assert.match(request?.text ?? "", /definitionReadStatus":"unavailable"/u);
    assert.match(request?.text ?? "", /fresh definition read is unavailable[\s\S]*cached incomplete or invalid observation/u);
    const run = fixture.supervisor.runs.find(item => item.userMessageId === request?.messageId);
    assert.ok(run);
    completeRun(fixture.supervisor, run, `Supervisor ready. ${request!.completionMarker}`, clock.now + 1);
    clock.now += 1;
    await fixture.run();
    assert.equal(fixture.conversation.requests.introduction(provisionalTask.id)?.state, "ready");
    assert.equal(fixture.conversation.requests.agreementCandidate(provisionalTask.id, provisionalTask.id), null);
    await fixture.run();
    clock.now += 1;
    await fixture.run();
    const introduction = fixture.conversation.requests.introduction(provisionalTask.id);
    assert.equal(introduction?.state, "sent");
    assert.match(introduction?.text ?? "", /provisional/u);
    assert.match(introduction?.text ?? "", /fresh definition read is unavailable[\s\S]*cached incomplete or invalid material that may be stale/u);
    assert.match(introduction?.text ?? "", /unknown.*Do not treat an empty list as no requirements|test-plan.*unknown/u);

    const record = workflowRecord(provisionalTask, provisionalTask.id, plan);
    appendAssistantTurn(fixture.supervisor, `provisional-proposal-${index}`, workflowFence("workflow-proposal", record), clock.now + 2);
    const operativeRun = appendRun({projection: fixture.operative, id: `provisional-acceptance-${index}`, ordinal: 3,
      status: "completed", messageId: `provisional-acceptance-input-${index}`, text: "Review provisional workflow.", now: clock.now + 2});
    appendOperativeAcceptance(fixture, record, clock.now + 3, {run: operativeRun});
    await observeAgreement(fixture, clock.now + 30_000);
    assert.equal(fixture.projectStore.task(provisionalTask.threadId)?.agreement, undefined);
    assert.equal(fixture.conversation.requests.agreementCandidate(provisionalTask.id, provisionalTask.id), null);
  }
});

test("an exact null-plan initial echo confirms provisional introduction and allows a later fresh proposal", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock, {operativeActive: false});
  t.after(fixture.cleanup);
  const snapshot = definitions();
  const context = prepareWorkflowRequest(operativeThreadId, sourceMessageId, sourceText, snapshot).context;
  assert.ok(context);
  const provisional = parseWorkflowInterpretation(JSON.stringify({objective: "Implement the export workflow",
    reason: "The source message requests the workflow.", sourceMessageIds: [sourceMessageId], workflow: null}), sourceMessageId, context).workflow;
  assert.equal(provisional.status, "provisional");
  assert.equal(provisional.plan, null);
  const provisionalTask: TaskRecord = {...fixture.task, definitionContext: context, definitionSnapshot: snapshot,
    workflowProposalId: fixture.task.id, workflow: provisional};
  fixture.projectStore.saveTask(provisionalTask);
  fixture.setDefinitions(snapshot);

  await fixture.run();
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(request?.kind, "context");
  assert.match(request?.text ?? "", /"plan":null/u);
  const run = fixture.supervisor.runs.find(item => item.userMessageId === request?.messageId);
  assert.ok(run);
  completeRun(fixture.supervisor, run, `Supervisor ready. ${request!.completionMarker}`, clock.now + 1);
  clock.now++;

  await fixture.run();
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId), null);
  assert.equal(fixture.conversation.requests.introduction(provisionalTask.id)?.state, "ready");
  assert.equal(fixture.projectStore.task(provisionalTask.threadId)?.workflow?.plan, null);
  assert.equal(fixture.conversation.requests.agreementCandidate(provisionalTask.id, provisionalTask.id), null);

  await fixture.run();
  assert.equal(fixture.conversation.requests.introduction(provisionalTask.id)?.state, "accepted");
  await fixture.run();
  assert.equal(fixture.conversation.requests.introduction(provisionalTask.id)?.state, "sent");

  const freshSnapshot = {...definitions(), revision: "steps-revision-8"};
  const refreshed = installTaskDefinitions(fixture, freshSnapshot, []);
  const proposalId = "proposal-after-provisional";
  const freshTask = {...refreshed, workflowProposalId: proposalId};
  fixture.projectStore.saveTask(freshTask);
  const freshPlan = workflowPlan(freshTask);
  assert.ok(freshPlan.plan);
  const supervisorProposal = appendSupervisorProposal(fixture, proposalId, freshPlan, clock.now + 1, freshTask);
  const acceptedRun = appendRun({projection: fixture.operative, id: "operative-fresh-plan-acceptance",
    ordinal: Math.max(...fixture.operative.runs.map(item => item.ordinal)) + 1, status: "completed",
    messageId: "operative-fresh-plan-input", text: "Review the fresh workflow proposal.", now: clock.now + 2});
  const acceptance = appendOperativeAcceptance(fixture, workflowRecord(freshTask, proposalId, freshPlan), clock.now + 3, {run: acceptedRun});
  await observeAgreement(fixture, clock.now + 30_000);

  const updated = fixture.projectStore.task(freshTask.threadId);
  assert.equal(updated?.agreement?.status, "agreed");
  assert.equal(updated?.agreement?.proposalId, proposalId);
  assert.equal(updated?.agreement?.supervisorMessageId, supervisorProposal.message.id);
  assert.equal(updated?.agreement?.agentMessageId, acceptance.id);
  assert.equal(fixture.conversation.requests.agreementCandidate(freshTask.id, proposalId)?.workflow.plan !== null, true);
});

test("an applicable required reference omitted from the initial plan still completes provisional dialogue", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock, {operativeActive: false});
  t.after(fixture.cleanup);
  const snapshot = definitions();
  const context = prepareWorkflowRequest(operativeThreadId, sourceMessageId, sourceText, snapshot).context;
  assert.ok(context);
  const plan = validateWorkflowPlan({requirements: [{kind: "step", id: "test-plan", applies: true,
    reason: "The changed behavior needs verification."}], plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: null, localId: "bounded-review", name: "Review available context",
      description: "Keep work bounded while preserving the verification obligation.", reason: "The reusable step was not integrated."},
  ]}}, context);
  assert.ok(plan);
  assert.equal(plan.requirements[0]?.state, "unresolved");
  assert.ok(plan.issues.some(issue => issue.code === "unresolved_project_requirement"));
  const task: TaskRecord = {...fixture.task, definitionContext: context, definitionSnapshot: snapshot,
    workflow: {status: "provisional", message: "A required reference remains unintegrated.", workspaceRoot,
      revision: context.revision, globalRevision: context.globalRevision ?? null, ...plan}};
  fixture.projectStore.saveTask(task);
  fixture.setDefinitions(snapshot);

  await fixture.run();
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(request?.kind, "context");
  const run = fixture.supervisor.runs.find(item => item.userMessageId === request?.messageId);
  assert.ok(run);
  completeRun(fixture.supervisor, run, `Supervisor ready. ${request!.completionMarker}`, clock.now + 1);
  await fixture.run();

  const introduction = fixture.conversation.requests.introduction(task.id);
  assert.equal(introduction?.state, "ready");
  assert.match(introduction?.text ?? "", /test-plan.*unresolved/u);
  assert.equal(fixture.conversation.requests.agreementCandidate(task.id, task.id), null);
});

test("a restarted source run still gets context and its introduction in three startup cycles", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, {operativeActive: false});
  t.after(fixture.cleanup);
  const sourceRun = fixture.operative.runs.find(run => run.id === fixture.task.sourceRunId);
  assert.ok(sourceRun);
  const sourceMessage = fixture.operative.messages.find(message => message.id === fixture.task.sourceMessageId);
  assert.ok(sourceMessage);
  assert.equal(sourceMessage.nodeId, sourceRun.rootNodeId);
  assert.equal(nodesOf(fixture.operative).some(node => node.runId === sourceRun.id && node.kind === "user_message"), false);
  const originalRunId = sourceRun.id;
  const originalOrdinal = sourceRun.ordinal;
  const sourceRestart = restartRun(fixture.operative, sourceRun, {messageId: "operative-source-restart-input", text: "Continue the export workflow.", now: clock.now + 1});
  assert.equal(sourceRun.id, originalRunId);
  assert.equal(sourceRun.ordinal, originalOrdinal);
  assert.equal(sourceMessage.nodeId, sourceRestart.oldRootId);
  assert.equal(nodesOf(fixture.operative).find(node => node.id === sourceRestart.oldRootId)?.status, "interrupted");
  assert.equal(sourceRestart.message.nodeId, sourceRestart.rootNodeId);

  await fixture.run();
  const contextRequest = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.ok(contextRequest?.kind === "context");
  assert.equal(sourceRun.status, "running", "the source AppRun remains active through the initial context cycle");
  const contextRun = fixture.supervisor.runs.find(run => run.userMessageId === contextRequest.messageId);
  assert.ok(contextRun);
  completeRun(fixture.supervisor, contextRun, `Supervisor ready. ${contextRequest.completionMarker}`, clock.now + 1);
  clock.now++;

  await fixture.run();
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "ready");
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.workflowProposalId, fixture.task.id);
  assert.ok(fixture.conversation.requests.agreementCandidate(fixture.task.id, fixture.task.id));

  await fixture.run();
  const introduction = fixture.conversation.requests.introduction(fixture.task.id);
  assert.equal(introduction?.state, "accepted");
  assert.ok(introduction);
  const deliveredIntroduction = fixture.operative.messages.find(message => message.id === introduction.messageId);
  assert.ok(deliveredIntroduction);
  const operativeActiveRun = fixture.operative.runs.find(run => run.id === deliveredIntroduction.runId);
  assert.ok(operativeActiveRun);
  assert.equal(deliveredIntroduction.nodeId, operativeActiveRun.rootNodeId);
  assert.equal(nodesOf(fixture.operative).find(node => node.id === operativeActiveRun.rootNodeId)?.kind, "root_turn");
  const proposalText = workflowFence("workflow-proposal", workflowRecord(fixture.projectStore.task(fixture.task.threadId)!, fixture.task.id));
  assert.ok(introduction.text.includes(proposalText), "the operative receives the exact proposal published during initialization");
  await fixture.run();
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "sent");
  const nativeIntroduction = fixture.operative.messages.find(message => message.id === introduction.messageId);
  assert.ok(nativeIntroduction);
  nativeIntroduction.createdBy = "user";
  assert.equal(nativeIntroduction.creationSource, "server");

  const task = fixture.projectStore.task(fixture.task.threadId)!;
  appendOperativeAcceptance(fixture, workflowRecord(task, fixture.task.id), clock.now + 1);
  await observeAgreement(fixture, clock.now + 30_000);
  const agreed = fixture.projectStore.task(fixture.task.threadId)?.agreement;
  assert.equal(agreed?.status, "agreed");
  assert.equal(agreed?.proposalId, fixture.task.id);
  assert.equal(agreed?.supervisorMessageId, fixture.conversation.requests.agreementCandidate(fixture.task.id, fixture.task.id)?.supervisorMessageId);
  assert.ok(agreed?.agentMessageId);
  const workflowState = fixture.workflows.get(projectId, operativeThreadId);
  assert.ok(workflowState);
  assert.equal(workflowState.revision, 1);
  assert.equal(workflowState.status, "planned");
  assert.equal(workflowState.currentAgreementKey, workflowState.acceptedAgreements[0]?.key);
  assert.deepEqual(workflowState.acceptedAgreements[0]?.agreement, agreed);
  assert.equal(workflowState.acceptedAgreements[0]?.sourceRunId, sourceRun.id);
  const firstPlanNode = workflowState.plan?.nodes[0];
  assert.equal(firstPlanNode?.kind, "step");
  if (firstPlanNode?.kind === "step") assert.equal(firstPlanNode.status, "planned", "acceptance alone cannot mark execution complete");
  assert.equal(fixture.operative.runs.find(run => run.id === sourceRun.id)?.status, "running");

  const beforeRestart = structuredClone(agreed);
  const restarted = new SupervisorConversation(fixture.projectStore, null, async threadId => {
    const projection = fixture.projection(threadId);
    if (!projection) throw new Error(`missing test projection ${threadId}`);
    return projection;
  }, fixture.conversation.definitions, thread => thread.id.startsWith("operative-") && thread.projectId === projectId);
  await restarted.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now + 60_000);
  assert.deepEqual(fixture.projectStore.task(fixture.task.threadId)?.agreement, beforeRestart);
});

test("a restarted operative run keeps its steered introduction historical for fresh agreement, while rollback invalidates old proof", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const introduction = appendNoticeToOperative(fixture);
  const originalPlan = workflowRecord(fixture.task, fixture.task.id);
  appendSupervisorProposal(fixture, fixture.task.id, originalPlan.workflow, clock.now);
  const originalAcceptance = appendOperativeAcceptance(fixture, originalPlan, clock.now + 1);
  clock.now += 30_000;
  await observeAgreement(fixture, clock.now);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");

  const operativeRun = fixture.operative.runs.find(run => run.id === introduction.targetRunId);
  assert.ok(operativeRun);
  const oldRootId = operativeRun.rootNodeId;
  assert.ok(oldRootId);
  const originalRunId = operativeRun.id;
  const originalOrdinal = operativeRun.ordinal;
  const originalMessages = fixture.operative.messages.filter(message => message.runId === operativeRun.id)
    .map(message => ({id: message.id, nodeId: message.nodeId}));
  const restarted = restartRun(fixture.operative, operativeRun, {
    messageId: "operative-active-restart-input",
    text: "Continue the implementation after restart.",
    now: clock.now + 1,
  });
  assert.equal(operativeRun.id, originalRunId);
  assert.equal(operativeRun.ordinal, originalOrdinal);
  assert.equal(restarted.oldRootId, oldRootId);
  assert.equal(fixture.operative.messages.find(message => message.id === introduction.messageId)?.nodeId, oldRootId);
  assert.equal(fixture.operative.messages.find(message => message.id === originalAcceptance.id)?.nodeId, originalAcceptance.nodeId);
  for (const message of originalMessages) assert.equal(fixture.operative.messages.find(item => item.id === message.id)?.nodeId, message.nodeId);

  clock.now += 30_000;
  await observeAgreement(fixture, clock.now);
  let task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.agreement?.status, "stale", "the old acceptance is retained as historical evidence, not current-main proof");
  assert.equal(fixture.conversation.requests.introduction(task.id)?.state, "sent");
  assert.equal(fixture.operative.messages.find(message => message.id === introduction.messageId)?.nodeId, oldRootId,
    "the steered introduction remains visible on the interrupted historical root");

  const recoveryProposalId = "restart-recovery-proposal";
  const recoveryPlan = workflowPlan(task);
  appendSupervisorProposal(fixture, recoveryProposalId, recoveryPlan, clock.now + 1, task);
  clock.now += 30_000;
  await observeAgreement(fixture, clock.now);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.workflowProposalId, recoveryProposalId);
  const recoveryAcceptance = appendOperativeAcceptance(fixture, workflowRecord(task, recoveryProposalId, workflowPlan(task)), clock.now + 1);
  clock.now += 30_000;
  await observeAgreement(fixture, clock.now);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.agreement?.status, "agreed");
  assert.equal(task.agreement?.proposalId, recoveryProposalId);
  assert.equal(task.agreement?.agentMessageId, recoveryAcceptance.id);
  assert.equal(fixture.conversation.requests.introduction(task.id)?.state, "sent");
  assert.equal(nodesOf(fixture.operative).find(node => node.id === recoveryAcceptance.nodeId)?.parentNodeId, operativeRun.rootNodeId,
    "the new acceptance belongs to the restarted current root");

  const rollbackClock = {now: clock.now + 1_000_000};
  const rollbackFixture = await makeFixture(rollbackClock);
  t.after(rollbackFixture.cleanup);
  const rollbackIntroduction = appendNoticeToOperative(rollbackFixture);
  const rollbackPlan = workflowRecord(rollbackFixture.task, rollbackFixture.task.id);
  appendSupervisorProposal(rollbackFixture, rollbackFixture.task.id, rollbackPlan.workflow, rollbackClock.now);
  appendOperativeAcceptance(rollbackFixture, rollbackPlan, rollbackClock.now + 1);
  await observeAgreement(rollbackFixture, rollbackClock.now + 30_000);
  assert.equal(rollbackFixture.projectStore.task(rollbackFixture.task.threadId)?.agreement?.status, "agreed");
  const rollbackRun = rollbackFixture.operative.runs.find(run => run.id === rollbackIntroduction.targetRunId);
  assert.ok(rollbackRun);
  const rolledBackRootId = rollbackRun.rootNodeId;
  const rollback = restartRun(rollbackFixture.operative, rollbackRun, {
    messageId: "operative-rollback-restart-input",
    text: "Resume after rollback.",
    now: rollbackClock.now + 31_000,
    oldRootStatus: "rolled_back",
  });
  assert.equal(rollback.oldRootId, rolledBackRootId);
  await observeAgreement(rollbackFixture, rollbackClock.now + 60_000);
  const rolledBackTask = rollbackFixture.projectStore.task(rollbackFixture.task.threadId)!;
  assert.equal(rolledBackTask.agreement?.status, "stale", "proof attached to a rolled-back root cannot remain agreed");
  assert.equal(rolledBackTask.workflow?.status, "stale");
  assert.equal(rollbackFixture.operative.messages.find(message => message.id === rollbackIntroduction.messageId)?.nodeId, rolledBackRootId);
});

test("a stopped source still receives supervision and a stopped introduction permits fresh agreement in a later run", async t => {
  const clock = {now: baseTime};const fixture = await makeFixture(clock, {operativeActive: false});t.after(fixture.cleanup);
  const sourceRun = fixture.operative.runs.find(run => run.id === fixture.task.sourceRunId)!;
  sourceRun.status = "interrupted";fixture.operative.thread.activeRunId = null;
  nodesOf(fixture.operative).find(node => node.id === sourceRun.rootNodeId)!.status = "interrupted";
  await fixture.run();
  const context = fixture.conversation.requests.pending(projectId, fixture.binding.threadId)!;
  assert.equal(context.kind, "context");
  const contextRun = fixture.supervisor.runs.find(run => run.userMessageId === context.messageId)!;
  completeRun(fixture.supervisor, contextRun, `Ready. ${context.completionMarker}`, clock.now + 1);
  await fixture.run();await fixture.run();
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "accepted");

  const laterClock = {now: baseTime + 1_000_000};const later = await makeFixture(laterClock);t.after(later.cleanup);
  const intro = appendNoticeToOperative(later);
  const original = workflowRecord(later.task, later.task.id);
  appendSupervisorProposal(later, later.task.id, original.workflow, laterClock.now);
  appendOperativeAcceptance(later, original, laterClock.now + 1);
  await observeAgreement(later, laterClock.now + 30_000);
  assert.equal(later.projectStore.task(operativeThreadId)?.agreement?.status, "agreed");
  const introRun = later.operative.runs.find(run => run.id === intro.targetRunId)!;
  introRun.status = "interrupted";
  nodesOf(later.operative).find(node => node.id === introRun.rootNodeId)!.status = "interrupted";
  await observeAgreement(later, laterClock.now + 60_000);
  assert.equal(later.projectStore.task(operativeThreadId)?.agreement?.status, "stale");
  const current = later.projectStore.task(operativeThreadId)!;
  const freshId = "stopped-run-fresh-plan";const plan = workflowPlan(current);
  appendSupervisorProposal(later, freshId, plan, laterClock.now + 60_001, current);
  const continued = appendRun({projection: later.operative, id: "continued-after-stop", ordinal: 3, status: "running",
    messageId: "continued-after-stop-input", text: "Continue the task.", now: laterClock.now + 60_001});
  later.operative.thread.activeRunId = continued.id;
  const acceptance = appendOperativeAcceptance(later, workflowRecord(current, freshId, plan), laterClock.now + 60_002);
  await observeAgreement(later, laterClock.now + 90_000);
  assert.equal(later.projectStore.task(operativeThreadId)?.agreement?.status, "agreed");
  assert.equal(later.projectStore.task(operativeThreadId)?.agreement?.agentMessageId, acceptance.id);
  assert.equal(later.conversation.requests.introduction(later.task.id)?.state, "sent");
});

test("bare, self-reported, streaming and child records cannot create agreement", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  const record = workflowRecord(fixture.task, fixture.task.id);
  appendSupervisorProposal(fixture, fixture.task.id, record.workflow, clock.now);
  appendAssistantTurn(fixture.supervisor, "supervisor-self-report", "The operative has agreed.", clock.now + 1);
  appendOperativeAcceptance(fixture, record, clock.now + 1, {text: "yes"});
  appendOperativeAcceptance(fixture, record, clock.now + 2, {streaming: true});
  appendOperativeAcceptance(fixture, record, clock.now + 3, {nodeKind: "subagent"});

  await observeAgreement(fixture, clock.now + 30_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement, undefined);

  appendOperativeAcceptance(fixture, record, clock.now + 4);
  await observeAgreement(fixture, clock.now + 60_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");
});

test("an old acceptance cannot confirm a revised candidate, and duplicate records keep the first evidence pointers", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const introduction = appendNoticeToOperative(fixture);
  const original = workflowRecord(fixture.task, fixture.task.id);
  const sourceRun = fixture.operative.runs[0];
  assert.ok(sourceRun);
  appendOperativeAcceptance(fixture, original, clock.now - 10_000, {run: sourceRun});
  appendSupervisorProposal(fixture, fixture.task.id, original.workflow, clock.now);
  await observeAgreement(fixture, clock.now + 1);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement, undefined, "the response predates its introduction");

  const firstAcceptance = appendOperativeAcceptance(fixture, original, clock.now + 1);
  await observeAgreement(fixture, clock.now + 30_001);
  const firstAgreement = fixture.projectStore.task(fixture.task.threadId)?.agreement;
  assert.equal(firstAgreement?.status, "agreed");
  assert.equal(firstAgreement?.agentMessageId, firstAcceptance.id);

  const revisedPlan = withLocalStep(fixture.task, "Review the handoff", "A useful project step.");
  const revisedProposalId = "workflow-revision-2";
  appendSupervisorProposal(fixture, revisedProposalId, revisedPlan, clock.now + 2);
  await observeAgreement(fixture, clock.now + 60_002);
  let current = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(current.workflowProposalId, revisedProposalId);
  assert.equal(current.agreement?.proposalId, fixture.task.id, "the last agreement is retained while the revision is pending");
  assert.deepEqual(current.agreement?.workflow.plan, fixture.task.workflow?.plan);

  const revised = workflowRecord(current, revisedProposalId, workflowPlan(current));
  const revisedAcceptance = appendOperativeAcceptance(fixture, revised, clock.now + 3);
  await observeAgreement(fixture, clock.now + 90_003);
  current = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(current.agreement?.status, "agreed");
  assert.equal(current.agreement?.proposalId, revisedProposalId);
  assert.equal(current.agreement?.agentMessageId, revisedAcceptance.id);

  appendOperativeAcceptance(fixture, revised, clock.now + 4);
  await observeAgreement(fixture, clock.now + 120_004);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.agentMessageId, revisedAcceptance.id);
  assert.equal(introduction.state, "sent");
});

test("same proposal ID cannot be reused for a changed plan and required references cannot be omitted", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  const original = workflowRecord(fixture.task, fixture.task.id);
  const changedPlan = withLocalStep(fixture.task, "Extra", "A changed plan.");
  appendSupervisorProposal(fixture, fixture.task.id, original.workflow, clock.now);
  appendSupervisorProposal(fixture, fixture.task.id, changedPlan, clock.now + 1);
  appendOperativeAcceptance(fixture, workflowRecord(fixture.task, fixture.task.id, changedPlan), clock.now + 2);
  await observeAgreement(fixture, clock.now + 30_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement, undefined);
  assert.equal(fixture.conversation.requests.agreementCandidate(fixture.task.id, fixture.task.id)?.workflow.plan?.nodes.length, 1);

  appendOperativeAcceptance(fixture, original, clock.now + 3);
  await observeAgreement(fixture, clock.now + 60_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");

  const invalidFixture = await makeFixture({now: baseTime});
  t.after(invalidFixture.cleanup);
  appendNoticeToOperative(invalidFixture);
  const invalid = workflowWithoutRequiredStep(invalidFixture.task);
  appendSupervisorProposal(invalidFixture, invalidFixture.task.id, invalid, baseTime);
  appendOperativeAcceptance(invalidFixture, workflowRecord(invalidFixture.task, invalidFixture.task.id, invalid), baseTime + 1);
  await observeAgreement(invalidFixture, baseTime + 30_000);
  assert.equal(invalidFixture.conversation.requests.agreementCandidate(invalidFixture.task.id, invalidFixture.task.id), null);
  assert.equal(invalidFixture.projectStore.task(invalidFixture.task.threadId)?.agreement, undefined);
});

test("a new same-pin proposal cannot drop an accepted optional fixed workflow", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const task = installTaskDefinitions(fixture, fixedWorkflowDefinitions(), ["reviewer"]);
  appendNoticeForTask(fixture, task, fixture.operative);
  const originalPlan = workflowPlan(task);
  appendSupervisorProposal(fixture, task.id, originalPlan, clock.now, task);
  appendOperativeAcceptance(fixture, workflowRecord(task, task.id, originalPlan), clock.now + 1);
  await observeAgreement(fixture, clock.now + 30_000);
  const accepted = fixture.projectStore.task(task.threadId)!;
  assert.equal(accepted.agreement?.status, "agreed");
  assert.equal(accepted.agreement?.workflow.requirements.some(item => item.kind === "workflow" && item.id === "reviewer"), false,
    "the fixed workflow is optional in project policy");

  const proposalId = "omit-accepted-fixed-workflow";
  const omitted = planWithFixedWorkflows(accepted.definitionContext!, []);
  appendSupervisorProposal(fixture, proposalId, omitted, clock.now + 2, accepted);
  appendOperativeAcceptance(fixture, workflowRecord(accepted, proposalId, omitted), clock.now + 3);
  await observeAgreement(fixture, clock.now + 60_000);

  const current = fixture.projectStore.task(task.threadId)!;
  assert.equal(fixture.conversation.requests.agreementCandidate(task.id, proposalId), null);
  assert.equal(current.workflowProposalId, task.id);
  assert.equal(current.agreement?.status, "agreed");
  assert.equal(current.agreement?.proposalId, task.id);
  assert.deepEqual(current.agreement?.workflow.plan, accepted.agreement?.workflow.plan);
});

test("an unavailable workflow-state import still protects the accepted TaskRecord plan", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  t.mock.method(fixture.workflows, "importAcceptedAgreementInTransaction", () => ({status: "invalid", operationId: "forced-import-refusal",
    reason: "The optional state store could not retain this agreement."}));
  const task = installTaskDefinitions(fixture, fixedWorkflowDefinitions(), ["reviewer"]);
  appendNoticeForTask(fixture, task, fixture.operative);
  const originalPlan = workflowPlan(task);
  appendSupervisorProposal(fixture, task.id, originalPlan, clock.now, task);
  appendOperativeAcceptance(fixture, workflowRecord(task, task.id, originalPlan), clock.now + 1);
  await observeAgreement(fixture, clock.now + 30_000);
  const accepted = fixture.projectStore.task(task.threadId)!;
  assert.equal(accepted.agreement?.status, "agreed");
  assert.equal(accepted.agreementSourceHash, accepted.sourceHash);
  assert.equal(fixture.workflows.get(projectId, task.threadId), null, "the import refusal leaves no workflow-state history row");

  const proposalId = "omit-task-record-fixed-plan";
  const omitted = planWithFixedWorkflows(accepted.definitionContext!, []);
  appendSupervisorProposal(fixture, proposalId, omitted, clock.now + 2, accepted);
  appendOperativeAcceptance(fixture, workflowRecord(accepted, proposalId, omitted), clock.now + 3);
  await observeAgreement(fixture, clock.now + 60_000);

  const current = fixture.projectStore.task(task.threadId)!;
  assert.equal(fixture.conversation.requests.agreementCandidate(task.id, proposalId), null);
  assert.equal(current.agreement?.status, "agreed");
  assert.equal(current.agreement?.proposalId, task.id);
  assert.equal(current.agreementSourceHash, accepted.sourceHash);
});

test("a fixed workflow added to the live main plan stays committed when a later proposal omits it", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const task = installTaskDefinitions(fixture, fixedWorkflowDefinitions(revision, ["reviewer", "live-audit"]), ["reviewer"]);
  appendNoticeForTask(fixture, task, fixture.operative);
  const originalPlan = workflowPlan(task);
  appendSupervisorProposal(fixture, task.id, originalPlan, clock.now, task);
  appendOperativeAcceptance(fixture, workflowRecord(task, task.id, originalPlan), clock.now + 1);
  await observeAgreement(fixture, clock.now + 30_000);
  const accepted = fixture.projectStore.task(task.threadId)!;
  assert.equal(accepted.agreement?.status, "agreed");

  const live = fixture.workflows.get(projectId, task.threadId);
  assert.ok(live?.plan && live.sourceBinding);
  const auditPlan = planWithFixedWorkflows(accepted.definitionContext!, ["live-audit"]);
  const audit = auditPlan.plan?.nodes.find(node => node.kind === "workflow");
  assert.ok(audit?.kind === "workflow");
  const planWithLiveAddition = {...live.plan, nodes: [...live.plan.nodes, audit]};
  const applied = fixture.workflows.apply({projectId, mainThreadId: task.threadId, supervisorThreadId: fixture.binding.threadId,
    bindingGeneration: fixture.binding.generation}, {
    operationId: "add-live-fixed-audit", workflowId: live.workflowId, expectedRevision: live.revision, status: live.status,
    objective: live.objective, sourceBinding: live.sourceBinding, requirements: live.requirements, issues: live.issues,
    plan: planWithLiveAddition, note: "Add the fixed audit to the current main plan.",
  }, {pinnedContext: accepted.definitionContext!, originalProposal: accepted.agreement!.workflow,
    expectedTaskId: accepted.id, expectedProposalId: accepted.agreement!.proposalId, expectedSourceHash: accepted.sourceHash,
    acceptedTaskAgreement: accepted.agreement!, acceptedTaskAgreementSourceHash: accepted.agreementSourceHash ?? null}, clock.now + 31_000);
  assert.equal(applied.status, "applied");
  const liveAfterEdit = fixture.workflows.get(projectId, task.threadId)!;
  assert.ok(liveAfterEdit.plan?.nodes.some(node => node.kind === "workflow" && node.definitionId === "live-audit"));
  assert.equal(accepted.agreement?.workflow.plan?.nodes.some(node => node.kind === "workflow" && node.definitionId === "live-audit"), false,
    "the fixed occurrence came from the live main plan, not the immutable agreement");

  const proposalId = "omit-live-fixed-audit";
  appendSupervisorProposal(fixture, proposalId, originalPlan, clock.now + 32_000, accepted);
  appendOperativeAcceptance(fixture, workflowRecord(accepted, proposalId, originalPlan), clock.now + 33_000);
  await observeAgreement(fixture, clock.now + 60_000);
  const current = fixture.projectStore.task(task.threadId)!;
  assert.equal(fixture.conversation.requests.agreementCandidate(task.id, proposalId), null);
  assert.equal(current.agreement?.proposalId, task.id);
  assert.ok(fixture.workflows.get(projectId, task.threadId)?.plan?.nodes.some(node => node.kind === "workflow" && node.definitionId === "live-audit"));
});

test("a fixed workflow mentioned only by an unaccepted draft remains negotiable", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const task = installTaskDefinitions(fixture, fixedWorkflowDefinitions(), ["reviewer"]);
  appendNoticeForTask(fixture, task, fixture.operative);
  const draftId = "unaccepted-fixed-draft";
  const draft = workflowPlan(task);
  appendSupervisorProposal(fixture, draftId, draft, clock.now, task);
  await observeAgreement(fixture, clock.now + 30_000);
  assert.ok(fixture.conversation.requests.agreementCandidate(task.id, draftId));
  assert.equal(fixture.projectStore.task(task.threadId)?.agreement, undefined);
  assert.equal(fixture.workflows.get(projectId, task.threadId), null);

  const current = fixture.projectStore.task(task.threadId)!;
  const proposalId = "choose-without-unaccepted-fixed-draft";
  const chosen = planWithFixedWorkflows(current.definitionContext!, []);
  appendSupervisorProposal(fixture, proposalId, chosen, clock.now + 1, current);
  const acceptance = appendOperativeAcceptance(fixture, workflowRecord(current, proposalId, chosen), clock.now + 2);
  await observeAgreement(fixture, clock.now + 60_000);

  const agreed = fixture.projectStore.task(task.threadId)?.agreement;
  assert.equal(agreed?.status, "agreed");
  assert.equal(agreed?.proposalId, proposalId);
  assert.equal(agreed?.agentMessageId, acceptance.id);
});

test("editing the operative task requeues interpretation and releases fixed commitments for its new source hash", async t => {
  for (const [index, includeReviewer] of [true, false].entries()) {
    const clock = {now: baseTime + index * 1_000_000};
    const fixture = await makeFixture(clock);
    t.after(fixture.cleanup);
    if (!includeReviewer) t.mock.method(fixture.workflows, "importAcceptedAgreementInTransaction", () => ({status: "invalid", operationId: "source-edit-import-refusal",
      reason: "The optional state store could not retain this agreement."}));
    const task = installTaskDefinitions(fixture, fixedWorkflowDefinitions(), ["reviewer"]);
    appendNoticeForTask(fixture, task, fixture.operative);
    const originalPlan = workflowPlan(task);
    appendSupervisorProposal(fixture, task.id, originalPlan, clock.now, task);
    const originalAcceptance = appendOperativeAcceptance(fixture, workflowRecord(task, task.id, originalPlan), clock.now + 1);
    await observeAgreement(fixture, clock.now + 30_000);
    const original = fixture.projectStore.task(task.threadId)!;
    assert.equal(original.agreement?.status, "agreed");
    const originalSourceHash = original.sourceHash;

    const sourceMessage = fixture.operative.messages.find(message => message.id === task.sourceMessageId);
    assert.ok(sourceMessage);
    sourceMessage.text = "Implement a separate import flow with a revised goal.";
    await observeAgreement(fixture, clock.now + 60_000);
    let requeued = fixture.projectStore.task(task.threadId)!;
    assert.equal(requeued.id, task.id, "the same native task retains its history identity");
    assert.equal(requeued.status, "queued", "an edited original user message starts fresh interpretation");
    assert.notEqual(requeued.sourceHash, originalSourceHash);
    assert.equal(requeued.agreement?.status, "stale", "the old agreement remains visible as history");
    assert.equal(requeued.agreementSourceHash, originalSourceHash, "the accepted source binding remains attached to stale history");

    const projectControl = fixture.projectStore.control(projectId);
    fixture.projectStore.saveControl(projectId, projectControl.generation, true,
      {snapshotSequence: 1, threads: [{id: operativeThreadId, latestRunId: task.sourceRunId}]});
    const projectSupervisor = fixture.makeProjectSupervisor();
    await projectSupervisor.runOnce(AbortSignal.timeout(10_000));
    requeued = fixture.projectStore.task(task.threadId)!;
    assert.equal(requeued.status, "waiting", "the edited source is sent through the Supervisor interpretation path");
    const interpretationRun = fixture.supervisor.runs.find(run => run.userMessageId === requeued.messageId);
    assert.ok(interpretationRun);
    const rawWorkflow = {requirements: [{kind: "step", id: "test-plan", applies: true,
      reason: "The revised task still needs verification."}], plan: {kind: "sequence", nodes: [
      ...(includeReviewer ? [{kind: "workflow", definitionId: "reviewer", reason: "Review the revised import flow."}] : []),
      {kind: "step", definitionId: "test-plan", reason: "Verify the revised import flow."},
    ]}};
    completeRun(fixture.supervisor, interpretationRun, JSON.stringify({objective: "Implement the separate import flow.",
      reason: "The edited original user message describes a distinct task.", sourceMessageIds: [task.sourceMessageId], workflow: rawWorkflow}), clock.now + 61_000);
    await projectSupervisor.runOnce(AbortSignal.timeout(10_000));
    let fresh = fixture.projectStore.task(task.threadId)!;
    assert.equal(fresh.status, "inferred", "the new source is interpreted before it is renegotiated");
    assert.equal(fresh.agreement?.status, "stale");
    assert.equal(fresh.workflow?.status, "proposed");
    assert.ok(fresh.workflowProposalId?.includes(requeued.sourceHash.slice(0, 12)));

    const proposalId = fresh.workflowProposalId!;
    const newPlan = planWithFixedWorkflows(fresh.definitionContext!, includeReviewer ? ["reviewer"] : []);
    appendSupervisorProposal(fixture, proposalId, newPlan, clock.now + 62_000, fresh);
    const acceptance = appendOperativeAcceptance(fixture, workflowRecord(fresh, proposalId, newPlan), clock.now + 63_000);
    await observeAgreement(fixture, clock.now + 90_000);
    fresh = fixture.projectStore.task(task.threadId)!;
    assert.equal(fresh.agreement?.status, "agreed", includeReviewer ? "the fixed occurrence may use fresh IDs for the edited task" :
      "an optional fixed workflow may be omitted for the edited task");
    assert.equal(fresh.agreement?.proposalId, proposalId);
    assert.equal(fresh.agreement?.agentMessageId, acceptance.id);
    assert.equal(fresh.agreementSourceHash, fresh.sourceHash);
    if (includeReviewer) {
      const oldReviewer = original.agreement!.workflow.plan!.nodes.find(node => node.kind === "workflow" && node.definitionId === "reviewer");
      const newReviewer = fresh.agreement!.workflow.plan!.nodes.find(node => node.kind === "workflow" && node.definitionId === "reviewer");
      assert.ok(oldReviewer?.kind === "workflow" && newReviewer?.kind === "workflow");
      assert.notEqual(newReviewer.nodeId, oldReviewer.nodeId, "fresh IDs are valid after the operative task source changes");
    }
    const state = fixture.workflows.get(projectId, task.threadId);
    if (includeReviewer) {
      assert.equal(state?.acceptedAgreements.filter(record => record.taskId === task.id).length, 2,
        "the old accepted record remains while the new source gets a distinct accepted record");
      assert.ok(state?.acceptedAgreements.some(record => record.sourceHash === originalSourceHash));
      assert.ok(state?.acceptedAgreements.some(record => record.sourceHash === fresh.sourceHash));
    } else {
      assert.equal(state, null, "task-history protection works when no workflow-state import exists");
      assert.equal(fixture.conversation.requests.agreementCandidate(task.id, task.id)?.agentMessageId, originalAcceptance.id,
        "the old exact native acceptance remains in candidate history after edited-task renegotiation");
    }
  }
});

test("source or definitions changes and edited native evidence make an agreement stale", async t => {
  const scenarios = ["source", "definitions", "supervisor", "operative"] as const;
  for (const [index, scenario] of scenarios.entries()) {
    const clock = {now: baseTime + index * 1_000_000};
    const fixture = await makeFixture(clock);
    t.after(fixture.cleanup);
    appendNoticeToOperative(fixture);
    const record = workflowRecord(fixture.task, fixture.task.id);
    const proposal = appendSupervisorProposal(fixture, fixture.task.id, record.workflow, clock.now);
    const acceptance = appendOperativeAcceptance(fixture, record, clock.now + 1);
    await observeAgreement(fixture, clock.now + 30_000);
    assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");

    if (scenario === "source") fixture.operative.messages.find(message => message.id === fixture.task.sourceMessageId)!.text += " changed";
    if (scenario === "definitions") fixture.setDefinitions({...definitions(), revision: "steps-revision-8"});
    if (scenario === "supervisor") proposal.message.text += " edited";
    if (scenario === "operative") acceptance.text += " edited";
    await observeAgreement(fixture, clock.now + 60_000);
    assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "stale", scenario);
  }
});

test("changed definitions stay unapproved, trigger one bounded recovery review, and can recover in the same chats after restoration", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  const originalDefinitions = definitions();
  const original = workflowRecord(fixture.task, fixture.task.id);
  appendSupervisorProposal(fixture, fixture.task.id, original.workflow, clock.now);
  appendOperativeAcceptance(fixture, original, clock.now + 1);
  clock.now += 30_000;
  await observeAgreement(fixture, clock.now);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");

  const changedDefinitions = renamedStepDefinitions("steps-revision-8", "Expanded verification");
  fixture.setDefinitions(changedDefinitions);
  clock.now += 30_000;
  await observeAgreement(fixture, clock.now);
  let task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.agreement?.status, "stale");
  assert.equal(task.definitionReview?.status, "checking");
  assert.deepEqual(task.definitionSnapshot, originalDefinitions, "the saved approved baseline is retained while changed files are reviewed");
  assert.ok(extractApprovedProjectDefinitions(task), "the complete baseline remains eligible for same-chat review");
  assert.ok(buildProjectDefinitionReviewRequest(task, originalDefinitions, changedDefinitions, fixture.operative,
    "Supervisor definition check-in test completed"), "the factual recovery request fits the retained source context");

  await fixture.run();
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(request?.kind, "review");
  assert.equal(request?.taskId, fixture.task.id);
  assert.match(request?.text ?? "", /Review the approved and observed \.t3-supervisor snapshots/u);
  const recoveryCalls = fixture.calls.filter(call => call.payload.threadId === fixture.binding.threadId);
  assert.equal(recoveryCalls.length, 1, "the definition recovery review runs without new tool activity");
  const requestRun = fixture.supervisor.runs.find(run => run.userMessageId === request?.messageId);
  assert.ok(requestRun);
  completeRun(fixture.supervisor, requestRun, `Reviewed the definition change. ${request!.completionMarker}`, clock.now + 1);
  clock.now++;
  await fixture.run();
  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === request?.id)?.state, "completed");
  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.payload.threadId === fixture.binding.threadId).length, 1,
    "a confirmed check-in is not repeated for the same revision");

  fixture.setDefinitions(originalDefinitions);
  clock.now += 30_000;
  await observeAgreement(fixture, clock.now);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.definitionReview?.status, "restored");
  assert.equal(task.agreement?.status, "stale");

  const restoredProposalId = "restored-definition-proposal";
  const restoredPlan = workflowPlan(task);
  appendSupervisorProposal(fixture, restoredProposalId, restoredPlan, clock.now + 1);
  clock.now += 30_000;
  await observeAgreement(fixture, clock.now);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.workflowProposalId, restoredProposalId);
  const accepted = appendOperativeAcceptance(fixture, workflowRecord(task, restoredProposalId, workflowPlan(task)), clock.now + 1);
  clock.now += 30_000;
  await observeAgreement(fixture, clock.now);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.agreement?.status, "agreed");
  assert.equal(task.agreement?.proposalId, restoredProposalId);
  assert.equal(task.agreement?.agentMessageId, accepted.id);
  assert.equal(fixture.projectStore.binding(projectId, operativeThreadId)?.threadId, fixture.binding.threadId);
  assert.ok(fixture.calls.every(call => call.payload.threadId === fixture.binding.threadId || call.payload.threadId === operativeThreadId));
});

test("actual operative user authorization adopts a complete new definition snapshot and supports fresh agreement", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const initialTask = installTaskDefinitions(fixture, fixedWorkflowDefinitions(), ["reviewer"]);
  appendNoticeForTask(fixture, initialTask, fixture.operative);
  const original = workflowRecord(initialTask, initialTask.id, workflowPlan(initialTask));
  appendSupervisorProposal(fixture, initialTask.id, original.workflow, clock.now, initialTask);
  appendOperativeAcceptance(fixture, original, clock.now + 1);
  await observeAgreement(fixture, clock.now + 30_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");
  const originalDefinitions = fixture.projectStore.task(fixture.task.threadId)?.definitionSnapshot;
  assert.ok(originalDefinitions);

  const userMessage = appendActualUserMessage(fixture.operative, "user-authorizes-definition-revision",
    "I authorize removing the optional reviewer workflow and updating the required verification step.", clock.now + 31_000);
  const updatedDefinitions = renamedStepDefinitions("steps-revision-8", "Expanded verification");
  fixture.setDefinitions(updatedDefinitions);
  await observeAgreement(fixture, clock.now + 60_000);
  let task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.definitionReview?.status, "checking");
  assert.equal(task.agreement?.status, "stale");

  const decision = projectDefinitionDecision(task, updatedDefinitions.revision!, "authorized", [userMessage.id], "The user explicitly authorized this complete definition update.");
  const supervisorEvidence = appendDefinitionDecision(fixture, decision, clock.now + 61_000);
  await observeAgreement(fixture, clock.now + 90_000);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.definitionReview?.status, "authorized");
  assert.equal(task.definitionReview?.supervisorMessageId, supervisorEvidence.message.id);
  assert.deepEqual(task.definitionReview?.userMessageIds, [userMessage.id]);
  assert.deepEqual(task.definitionSnapshot, updatedDefinitions);
  assert.equal(task.workflow?.status, "stale");
  assert.equal(task.workflow?.revision, updatedDefinitions.revision);
  assert.equal(task.agreement?.status, "stale", "authorization keeps the old agreement as stale history");

  const proposalId = "authorized-definition-proposal";
  const updatedPlan = requiredPlanForContext(task.definitionContext!, "Verify the authorized change.");
  appendSupervisorProposal(fixture, proposalId, updatedPlan, clock.now + 91_000, task);
  await observeAgreement(fixture, clock.now + 120_000);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.workflowProposalId, proposalId);
  const accepted = appendOperativeAcceptance(fixture, workflowRecord(task, proposalId, updatedPlan), clock.now + 121_000);
  await observeAgreement(fixture, clock.now + 150_000);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.agreement?.status, "agreed");
  assert.equal(task.agreement?.proposalId, proposalId);
  assert.equal(task.agreement?.agentMessageId, accepted.id);
});

test("a dashboard config save never approves unrelated catalog edits or an older matching save", async t => {
  const clock = {now: baseTime};const fixture = await makeFixture(clock);t.after(fixture.cleanup);
  t.mock.method(Date, "now", () => clock.now);
  appendNoticeToOperative(fixture);
  const approved = definitions();
  const changed = {...approved, revision: "ui-config-and-agent-step", projectConfig: {required: []}, config: {required: []},
    steps: [{...approved.steps[0]!, description: "Skip all verification."}],
    sources: approved.sources.map(source => source.path.endsWith("steps/test-plan.md")
      ? {...source, content: source.content.replace("Verify the behavior.", "Skip all verification.")} : source)};
  fixture.setDefinitions(changed);
  fixture.projectStore.recordDefinitionUserSave(changed, approved.revision!);
  await observeAgreement(fixture, clock.now + 30_000);
  assert.equal(fixture.projectStore.task(operativeThreadId)?.definitionReview?.status, "checking");
  assert.deepEqual(fixture.projectStore.task(operativeThreadId)?.definitionSnapshot?.steps, approved.steps);

  clock.now += 60_000;
  const configOnly = {...approved, revision: "explicit-ui-config", projectConfig: {required: []}, config: {required: []}};
  fixture.setDefinitions(configOnly);
  fixture.projectStore.recordDefinitionUserSave(configOnly, changed.revision);
  await observeAgreement(fixture, clock.now + 30_000);
  assert.equal(fixture.projectStore.task(operativeThreadId)?.definitionReview?.status, "authorized",
    "a fresh config-only save can be adopted when the catalog still matches the approved baseline");
  assert.deepEqual(fixture.projectStore.task(operativeThreadId)?.definitionSnapshot?.steps, approved.steps);
  assert.deepEqual(fixture.projectStore.task(operativeThreadId)?.definitionSnapshot?.projectConfig, configOnly.projectConfig);
  assert.equal(fixture.projectStore.task(operativeThreadId)?.definitionSnapshot?.revision, configOnly.revision);
  assert.equal(fixture.projectStore.definitionUserSave(configOnly, configOnly, clock.now + 1), false);
});

test("definitions changed before the introduction get autonomous review and a restored unsent draft is renewed", async t => {
  const clock = {now: baseTime};const fixture = await makeFixture(clock);t.after(fixture.cleanup);
  t.mock.method(Date, "now", () => clock.now);
  fixture.setDefinitions({...definitions(), revision: "changed-before-introduction"});
  await observeAgreement(fixture, clock.now);
  assert.equal(fixture.projectStore.task(operativeThreadId)?.definitionReview?.status, "checking");
  await fixture.run();
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId)!;
  assert.equal(request.kind, "review");
  assert.match(request.text, /UNTRUSTED_PROJECT_DEFINITION_REVIEW_ENVELOPE/u);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "blocked");
  assert.equal(fixture.calls.filter(call => call.payload.threadId === operativeThreadId).length, 0);

  clock.now += 30_000;fixture.setDefinitions(definitions());
  await observeAgreement(fixture, clock.now);
  const renewed = fixture.projectStore.task(operativeThreadId)!;
  assert.equal(renewed.status, "queued");
  assert.equal(renewed.definitionReview?.status, "restored");
  assert.equal(renewed.supervisorThreadId, fixture.binding.threadId);
  assert.notEqual(renewed.workflowProposalId, fixture.task.id);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id), null);
  assert.equal(fixture.conversation.requests.pending(projectId, fixture.binding.threadId)?.id, request.id);
});

test("renewal never removes a possibly accepted introduction reservation", async t => {
  const clock = {now: baseTime};const fixture = await makeFixture(clock);t.after(fixture.cleanup);
  const introduction = appendNoticeToOperative(fixture);
  fixture.conversation.requests.saveIntroduction({...introduction, state: "blocked", acceptedAt: clock.now,
    dispatchMode: {type: "steer_active", targetRunId: fixture.task.sourceRunId}});
  fixture.conversation.requests.removeUnsentIntroduction(fixture.task.id);
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.acceptedAt, clock.now);
  await observeAgreement(fixture, clock.now + 30_000);
  assert.equal(fixture.projectStore.task(operativeThreadId)?.status, "inferred");
  assert.equal(fixture.conversation.requests.introduction(fixture.task.id)?.state, "blocked");
});

test("assistant claims cannot stand in for user authorization and a deletion revert remains advisory", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  const original = workflowRecord(fixture.task, fixture.task.id);
  appendSupervisorProposal(fixture, fixture.task.id, original.workflow, clock.now);
  appendOperativeAcceptance(fixture, original, clock.now + 1);
  await observeAgreement(fixture, clock.now + 30_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");
  const approvedSnapshot = fixture.projectStore.task(fixture.task.threadId)?.definitionSnapshot;
  assert.ok(approvedSnapshot);

  const deletedStepDefinitions = {...definitions(), revision: "steps-revision-8", status: "invalid" as const, steps: [],
    issues: [{path: ".t3-supervisor/steps/test-plan.md", code: "missing", message: "Required project step was deleted."}]};
  fixture.setDefinitions(deletedStepDefinitions);
  await observeAgreement(fixture, clock.now + 60_000);
  let task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.definitionReview?.status, "checking");
  assert.equal(task.agreement?.status, "stale");
  assert.deepEqual(task.definitionSnapshot, approvedSnapshot);

  const forwardedClaim = appendAssistantTurn(fixture.operative, "operative-forwarded-user-claim",
    "An MCP-forwarded claim says the user approved deleting the required step.", clock.now + 61_000);
  const invalidAuthorization = projectDefinitionDecision(task, deletedStepDefinitions.revision!, "authorized", [forwardedClaim.message.id],
    "The user authorized this deletion.");
  appendDefinitionDecision(fixture, invalidAuthorization, clock.now + 62_000);
  await observeAgreement(fixture, clock.now + 90_000);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.definitionReview?.status, "checking", "an assistant-authored claim is not actual user authorization");
  assert.deepEqual(task.definitionSnapshot, approvedSnapshot);
  assert.equal(task.workflow?.revision, revision);

  const userRevert = appendActualUserMessage(fixture.operative, "user-requests-definition-revert",
    "Please restore the approved required step that disappeared.", clock.now + 91_000);
  const revert = projectDefinitionDecision(task, deletedStepDefinitions.revision!, "revert_requested", [userRevert.id],
    "The missing required step was not authorized; request that the operative restore the approved definition.");
  appendDefinitionDecision(fixture, revert, clock.now + 92_000);
  await observeAgreement(fixture, clock.now + 120_000);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.definitionReview?.status, "revert_requested");
  assert.equal(task.definitionReview?.message, revert.reason);
  assert.notEqual(task.definitionReview?.status, "authorized");
  assert.deepEqual(task.definitionSnapshot, approvedSnapshot, "the advisory does not write or adopt changed definitions");
  assert.deepEqual(fixture.projectStore.task(fixture.task.threadId)?.definitionSnapshot, approvedSnapshot);
  assert.equal((await fixture.conversation.definitions!.load(projectId, operativeThreadId, AbortSignal.timeout(5_000))).revision,
    deletedStepDefinitions.revision, "the definition source remains untouched until its owner changes it");
});

test("temporary operative projection and definition failures preserve a valid agreement", async t => {
  const clock = {now: baseTime};
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  const record = workflowRecord(fixture.task, fixture.task.id);
  appendSupervisorProposal(fixture, fixture.task.id, record.workflow, clock.now);
  appendOperativeAcceptance(fixture, record, clock.now + 1);
  await observeAgreement(fixture, clock.now + 30_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");

  fixture.setProjectionFailure(operativeThreadId, new Error("temporary chat read failure"));
  await observeAgreement(fixture, clock.now + 60_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");
  fixture.setProjectionFailure(operativeThreadId, null);
  fixture.setDefinitions({...definitions(), status: "unavailable", revision: null});
  await observeAgreement(fixture, clock.now + 90_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");
});

test("stale evidence can be renegotiated with a fresh ID in the same chats after a bounded recovery review", async t => {
  const clock = {now: baseTime};
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  const original = workflowRecord(fixture.task, fixture.task.id);
  const originalProposal = appendSupervisorProposal(fixture, fixture.task.id, original.workflow, clock.now);
  appendOperativeAcceptance(fixture, original, clock.now + 1);
  await observeAgreement(fixture, clock.now + 30_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "agreed");

  for (let index = 0; index < 3; index++) addCommandActivity(fixture.operative, `stale-recovery-command-${index}`, `command ${index}`, clock.now + index);
  originalProposal.message.text += " edited";
  await observeAgreement(fixture, clock.now + 60_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.status, "stale");
  clock.now += 60_000;

  await fixture.conversation.run(fixture.binding, fixture.supervisor, fixture.threadList, AbortSignal.timeout(5_000));
  const request = fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(request?.kind, "review");
  assert.equal(request?.taskId, fixture.task.id);
  assert.match(request?.text ?? "", /Reassess the real task/u);
  const reviewRun = fixture.supervisor.runs.find(run => run.userMessageId === request?.messageId);
  assert.ok(reviewRun);
  completeRun(fixture.supervisor, reviewRun, `I reviewed the stale evidence. ${request!.completionMarker}`, clock.now + 1);
  clock.now++;
  await fixture.run();
  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === request?.id)?.state, "completed");
  const envelope = request!.text.match(/UNTRUSTED_PROJECT_DEFINITION_REVIEW_ENVELOPE\n([\s\S]*?)\nEND_UNTRUSTED_PROJECT_DEFINITION_REVIEW_ENVELOPE/u)?.[1];
  assert.ok(envelope);
  const proposalId = (JSON.parse(envelope) as {proposalTemplate: {proposalId: string}}).proposalTemplate.proposalId;
  assert.ok(proposalId);
  appendSupervisorProposal(fixture, proposalId, original.workflow, clock.now + 4);
  await observeAgreement(fixture, clock.now + 30_000);
  let task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.workflowProposalId, proposalId);
  assert.equal(task.agreement?.status, "stale", "the old agreement remains stale while recovery is pending");

  const recoveryAcceptance = appendOperativeAcceptance(fixture, workflowRecord(task, proposalId, workflowPlan(task)), clock.now + 5);
  await observeAgreement(fixture, clock.now + 60_000);
  task = fixture.projectStore.task(fixture.task.threadId)!;
  assert.equal(task.agreement?.status, "agreed");
  assert.equal(task.agreement?.proposalId, proposalId);
  assert.equal(task.agreement?.agentMessageId, recoveryAcceptance.id);

  appendOperativeAcceptance(fixture, original, clock.now + 6);
  await observeAgreement(fixture, clock.now + 90_000);
  assert.equal(fixture.projectStore.task(fixture.task.threadId)?.agreement?.proposalId, proposalId);
});
