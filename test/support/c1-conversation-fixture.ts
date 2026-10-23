import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { GuidanceStore, fingerprint } from "../../src/guidance-store.js";
import type { ProjectDefinitionLoader } from "./root-facades.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ProjectSupervisorStore, defaultSupervisorModel, type BindingRecord, type TaskRecord } from "../../src/project-supervisor-store.js";
import { projectSupervisorUnit, supervisorConversationUnit } from "./team-units.js";
import { workflowIntroductionText } from "../../src/supervisor-conversation.js";
import { prepareWorkflowRequest, validateWorkflowPlan, type WorkflowPlanValue } from "../../src/supervisor-workflow.js";
import type { ConversationRequest, WorkflowIntroduction } from "../../src/supervisor-conversation-store.js";
import { SupervisorRpcError, type SupervisorRpc } from "../../src/supervisor-native.js";
import type { MessageInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";
import { compactProposalDigest } from "../../src/supervisor-workflow-agreement.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import { effectiveIndex, indexSource, projectIndex, testSummary } from "../project-definitions-fixture.js";

// copied from test/supervisor-conversation.test.ts (frozen baseline suite) and extended with an rpc interceptor,
// a reopened controller on the same files and a second bound main

export const projectId = "project-a";
export const operativeThreadId = "operative-a";
export const sourceMessageId = "operative-task";
export const sourceText = "Implement the export workflow";
export const workspaceRoot = "/work/project/worktrees/feature";
export const revision = "steps-revision-7";
export const baseTime = Date.parse("2026-10-13T10:00:00.000Z");
export const iso = (time = baseTime): string => new Date(time).toISOString();

export const definitions = (): ProjectDefinitionSnapshot => ({
  projectId,
  threadId: operativeThreadId,
  workspaceRoot,
  revision,
  globalRevision: null,
  globalOnly: false,
  editingAvailable: true,
  status: "ready",
  steps: [{id: "test-plan", name: "Test plan", description: "Verify the behavior.", summary: testSummary("test-plan"), origin: "project", path: ".t3-supervisor/steps/test-plan.md", sourceId: "project:test-plan"}],
  workflows: [],
  config: effectiveIndex({steps: [{id: "test-plan"}], workflows: []}, [{step: "test-plan"}]),
  projectConfig: projectIndex({steps: ["test-plan"], required: [{step: "test-plan"}]}),
  definitionFiles: [],
  complete: true,
  sources: [
    {path: ".t3-supervisor/project.yaml", content: indexSource({steps: ["test-plan"], required: [{step: "test-plan"}]}), origin: "project"},
    {path: ".t3-supervisor/steps/test-plan.md", content: "---\nid: test-plan\nname: Test plan\ndescription: Verify the behavior.\n---\n", origin: "project"},
  ],
  issues: [],
});

export const requiredRawPlan = (reason = "Verify the change.") => ({requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The task changes behavior."}],
  plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "test-plan", reason}]}});
export const requiredPlanForContext = (context: NonNullable<TaskRecord["definitionContext"]>, reason = "Verify the change."): WorkflowPlanValue => {
  const plan = validateWorkflowPlan(requiredRawPlan(reason), context);
  assert.ok(plan);
  return plan;
};

export const makeThread = (input: {
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

export const makeProjection = (thread: ThreadInfo): Projection => ({
  thread,
  runs: [],
  messages: [],
  nodes: [],
  providerTurns: [],
  runtimeRequests: [],
  turnItems: [],
});

export const nodesOf = (projection: Projection): Array<Record<string, unknown>> => {
  if (!Array.isArray(projection.nodes)) projection.nodes = [];
  return projection.nodes as Array<Record<string, unknown>>;
};

export const turnItemsOf = (projection: Projection): Array<Record<string, unknown>> => {
  if (!Array.isArray(projection.turnItems)) projection.turnItems = [];
  return projection.turnItems as Array<Record<string, unknown>>;
};

export const appendRun = (input: {
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

export const activateProviderTurn = (projection: Projection, run: RunInfo, attemptId = `${run.id}-attempt-ready`): void => {
  run.status = "running";
  run.activeAttemptId = attemptId;
  run.startedAt = iso(baseTime);
  const root = nodesOf(projection).find(node => node.id === run.rootNodeId);
  assert.ok(root);
  root.status = "running";
  (projection.providerTurns as Record<string, unknown>[]).push({id: `${attemptId}-provider-turn`, runAttemptId: attemptId,
    nodeId: run.rootNodeId, status: "running"});
};

export const restartRun = (projection: Projection, run: RunInfo, input: {messageId: string; text: string; now: number; oldRootStatus?: string}) => {
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

export const appendMessageToRun = (
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

export const completeRun = (projection: Projection, run: RunInfo, response: string, now = baseTime): void => {
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
    // a cooperative root echoes the exact initialization reference it was given
    const reference = request.text.match(/```workflow-proposal\n(\{[^\n]*\})\n```/u)?.[1];
    if (reference) response = `\`\`\`workflow-proposal\n${reference}\n\`\`\`\n${response}`;
  }
  appendMessageToRun(projection, run, { id: `assistant-${run.id}`, role: "assistant", text: response, now });
};

export const addCommandActivity = (projection: Projection, id: string, input: string, now: number): void => {
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

export interface FixtureOptions {
  supervisorRuntimeMode?: string;
  supervisorInteractionMode?: string;
  workflow?: boolean;
  /** false leaves the binding without any inferred task */
  task?: boolean;
  operativeActive?: boolean;
  settings?: { intervalMinutes: number; activityThreshold: number };
}

export interface Clock { now: number }

export type RpcCall = { tag: string; payload: Record<string, unknown> };
/** an interceptor settlement that hands the held call back to the default fake T3 behaviour */
export const proceed: unique symbol = Symbol("proceed");
/** returns a settlement for a recorded call to take over its outcome, or null for the default fake T3 behaviour */
export type RpcInterceptor = (call: RpcCall, signal: AbortSignal) => Promise<unknown> | null;

// a send that reached the fake peer and settles only through the caller's abort, classified as the real client does after sending
export const abortHonouringSend = (signal: AbortSignal): Promise<unknown> => new Promise((_resolve, reject) => {
  if (signal.aborted) {reject(new SupervisorRpcError("uncertain"));return;}
  signal.addEventListener("abort", () => reject(new SupervisorRpcError("uncertain")), {once: true});
});

export const makeFixture = async (clock: Clock, options: FixtureOptions = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "c1-conversation-"));
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
  const supervisorThreadIds = new Set([binding.threadId]);
  const definitionSnapshot = definitions();
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
  if (options.task !== false) {
    projectStore.saveTask(task);
    if (options.workflow !== false) setInterpretationAnswer(supervisor, task, requiredRawPlan());
  }
  projectStore.baseline({snapshotSequence: 1, threads: []});

  let nextSupervisorRun = 0;
  let interceptor: RpcInterceptor | null = null;
  const calls: RpcCall[] = [];
  const projectionReads: string[] = [];
  const rpc: SupervisorRpc = async (tag, payload, signal) => {
    const call = { tag, payload: { ...payload } };
    calls.push(call);
    const intercepted = interceptor?.(call, signal) ?? null;
    if (intercepted) {
      const outcome = await intercepted;
      if (outcome !== proceed) return outcome;
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "thread.settle") {
      const projection = projections.get(String(payload.threadId));assert.ok(projection);
      projection.thread.settledAt = iso(clock.now);projection.thread.settledOverride = "settled";
      return {sequence: calls.length};
    }
    if (tag !== "orchestration.dispatchCommand" || payload.type !== "message.dispatch")
      throw new Error(`unexpected fake native command ${tag}/${String(payload.type)}`);

    const targetThreadId = String(payload.threadId);
    const supervisorTarget = supervisorThreadIds.has(targetThreadId) ? projections.get(targetThreadId) : undefined;
    if (supervisorTarget) {
      nextSupervisorRun++;
      const isBusy = supervisorTarget.runs.some(run => ["preparing", "queued", "starting", "running", "waiting"].includes(run.status));
      const status = payload.dispatchMode && (payload.dispatchMode as Record<string, unknown>).type === "queue_after_active" && isBusy
        ? "queued"
        : "running";
      const run = appendRun({
        projection: supervisorTarget,
        id: `supervisor-run-${nextSupervisorRun}`,
        // native run ordinals only grow within a thread
        ordinal: Math.max(nextSupervisorRun + supervisorTarget.runs.length, ...supervisorTarget.runs.map(item => item.ordinal + 1)),
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
    if (operativeTarget) {
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
    load: async (loadedProjectId, threadId) => ({ ...definitionSnapshot, projectId: loadedProjectId, threadId: threadId ?? null }),
  };
  const readProjection = async (threadId: string) => {
    projectionReads.push(threadId);
    const projection = projections.get(threadId);
    if (!projection) throw new Error(`missing test projection ${threadId}`);
    return projection;
  };
  const eligible = (thread: ThreadInfo) => thread.id.startsWith("operative-") && thread.projectId === projectId;
  const threadList = [supervisor.thread, operative.thread];
  const threadPolicyDirectory = join(directory, "thread-policy");
  const threadPolicy = new ThreadPolicyStore(threadPolicyDirectory, {excludedThreadIds: []});
  const closables: Array<{close(): void}> = [threadPolicy, guidance];
  const closed = new Set<{close(): void}>();
  const close = (store: {close(): void}) => {
    if (closed.has(store)) return;
    closed.add(store);
    store.close();
  };
  // one controller over one database connection, as one supervisor process owns it
  const makeController = (store: ProjectSupervisorStore, policy: ThreadPolicyStore) => {
    const workflows = new WorkflowStateStore(store, () => true);
    const conversation = supervisorConversationUnit(store, rpc, readProjection, definitionLoader, eligible, () => true, workflows);
    conversation.supervisionStopped = threadId => policy.get().excludedThreadIds.includes(threadId);
    return {conversation, workflows};
  };
  const {conversation, workflows} = makeController(projectStore, threadPolicy);
  const apiConfig = {
    threadPolicy,
    dataDirectory: directory,
    t3Url: "http://localhost",
    t3TokenFile: "",
    excludedThreadIds: [],
    healthPort: 0,
  } satisfies SupervisorConfig;
  const makeProjectSupervisor = () => projectSupervisorUnit(
    apiConfig,
    projectStore,
    { catalog: () => Effect.succeed({ projects: [{ project: { id: projectId, title: "Project A", workspaceRoot }, available: true }], threads: threadList }) },
    { projection: (threadId) => {
      const projection = projections.get(threadId);
      if (!projection) throw new Error(`missing test projection ${threadId}`);
      return Effect.succeed({ snapshotSequence: 1, projection });
    } },
    async () => { throw new Error("no native read is expected"); },
    rpc,
    async () => ({ snapshotSequence: 1, threads: [] }),
    definitionLoader,
    () => clock.now,
  );
  const signal = AbortSignal.timeout(10_000);
  /** a new process on the same files: fresh connections and a fresh controller with the same fake T3 */
  const reopen = () => {
    const reopenedGuidance = new GuidanceStore(directory);
    const reopenedPolicy = new ThreadPolicyStore(threadPolicyDirectory, {excludedThreadIds: []});
    closables.push(reopenedPolicy, reopenedGuidance);
    const store = new ProjectSupervisorStore(reopenedGuidance, new Set());
    const controller = makeController(store, reopenedPolicy);
    return {guidance: reopenedGuidance, projectStore: store, ...controller,
      run: (runSignal: AbortSignal = signal) => controller.conversation.run(store.binding(projectId, operativeThreadId) as BindingRecord, supervisor, threadList, runSignal)};
  };
  /** a second main with its own Supervisor binding in the same project */
  const addBoundOperative = (threadId: string, taskId: string) => {
    const reserved = projectStore.reserve(projectId, threadId, "Project A", defaultSupervisorModel, 10, clock.now);
    projectStore.setBinding({...reserved, state: "ready"});
    const ownSupervisor = makeProjection(makeThread({id: reserved.threadId, title: `Project Supervisor ${threadId}`}));
    ownSupervisor.thread.modelSelection = defaultSupervisorModel;
    const projection = makeProjection(makeThread({id: threadId, title: `Operative ${threadId}`}));
    const messageId = `${threadId}-task`;
    const messageText = `Implement ${taskId}`;
    const source = appendRun({projection, id: `${threadId}-source-run`, ordinal: 1, status: "completed", messageId, text: messageText, now: clock.now - 120_000});
    const activeRun = appendRun({projection, id: `${threadId}-active-run`, ordinal: 2, status: "running", messageId: `${threadId}-active-input`, text: "Continue the task", now: clock.now - 20_000});
    projection.thread.activeRunId = activeRun.id;
    projections.set(threadId, projection);
    projections.set(reserved.threadId, ownSupervisor);
    supervisorThreadIds.add(reserved.threadId);
    threadList.push(projection.thread, ownSupervisor.thread);
    const context = prepareWorkflowRequest(threadId, messageId, messageText, {...definitionSnapshot, threadId}).context;
    assert.ok(context);
    const boundTask: TaskRecord = {...task, id: taskId, threadId, sourceRunId: source.id, sourceMessageId: messageId, sourceHash: fingerprint(messageText),
      sourceOrdinal: source.ordinal, definitionContext: context, definitionSnapshot: {...definitionSnapshot, threadId},
      messageId: `supervisor-objective:${taskId}`, supervisorThreadId: reserved.threadId,
      workflow: {status: "proposed", message: "A draft is ready.", workspaceRoot, revision, globalRevision: null, ...requiredPlanForContext(context)}};
    projectStore.saveTask(boundTask);
    setInterpretationAnswer(ownSupervisor, boundTask, requiredRawPlan());
    const boundBinding = projectStore.binding(projectId, threadId) as BindingRecord;
    return {binding: boundBinding, supervisor: ownSupervisor, projection, task: boundTask,
      run: (runSignal: AbortSignal = signal) => conversation.run(projectStore.binding(projectId, threadId) as BindingRecord, ownSupervisor, threadList, runSignal)};
  };
  return {
    directory,
    binding: projectStore.binding(projectId, operativeThreadId) as BindingRecord,
    calls,
    projectionReads,
    intercept: (next: RpcInterceptor | null) => { interceptor = next; },
    cleanup: async () => {
      for (const store of closables) close(store);
      await rm(directory, { recursive: true, force: true });
    },
    /** ends this process's connections without any further write, as a crash would */
    crash: () => { close(threadPolicy); close(guidance); },
    reopen,
    addBoundOperative,
    guidance,
    threadPolicy,
    conversation,
    makeProjectSupervisor,
    operative,
    projectStore,
    run: (runSignal: AbortSignal = signal) => conversation.run(projectStore.binding(projectId, operativeThreadId) as BindingRecord, supervisor, threadList, runSignal),
    supervisor,
    task,
    threadList,
    workflows,
  };
};
export type Fixture = Awaited<ReturnType<typeof makeFixture>>;

export const setInterpretationAnswer = (supervisor: Projection, task: TaskRecord, raw: unknown, objective = task.objective) => {
  const runId = task.supervisorRunId ?? "supervisor-objective-run";
  const text = JSON.stringify({objective, reason: task.reason, sourceMessageIds: [task.sourceMessageId], supervision: "needed", workflow: raw});
  const existing = supervisor.messages.find(message => message.id === `${runId}-answer`);
  if (existing) {existing.text = text;return;}
  const run = appendRun({projection: supervisor, id: runId, ordinal: 0, status: "completed", messageId: task.messageId, text: "Interpret the task.", now: baseTime - 60_000});
  appendMessageToRun(supervisor, run, {id: `${runId}-answer`, role: "assistant", text, now: baseTime - 59_000});
};

// stores a task whose workflow is the service's parse of the Supervisor's own answer, as interpretation stores it

export const appendNoticeForTask = (
  fixture: Fixture,
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

export const appendNoticeToOperative = (fixture: Fixture): WorkflowIntroduction =>
  appendNoticeForTask(fixture, fixture.task, fixture.operative);

// prepares a task context request and anchors the task to its prompt in one step, as the introduction path does
export const prepareTaskContext = (fixture: Fixture, input: {text: string; completionMarker: string}, now: number,
  anchored = true): ConversationRequest => {
  const request = fixture.conversation.requests.prepare({projectId, supervisorThreadId: fixture.binding.threadId, kind: "context",
    taskId: fixture.task.id, batch: null, ...input}, now);
  const task = fixture.projectStore.task(fixture.task.threadId)!;
  if (anchored) fixture.projectStore.saveTask({...task, protocolAnchor: {supervisorThreadId: fixture.binding.threadId, sourceHash: task.sourceHash,
    promptMessageId: request.messageId}});
  return request;
};

// records the native turn item T3 assigns to a message: ordinals continue within the run's own ordinal range

export const supervisorRequestCall = (fixture: Fixture, kind?: "context" | "review") =>
  fixture.calls.find(call => call.payload.threadId === fixture.binding.threadId &&
    (kind === undefined || String(call.payload.text).includes(kind === "context" ? "This initializes supervision" : "Review this factual change index.")));

export const workflowValue = (task: TaskRecord): WorkflowPlanValue => ({
  definitionsStatus: task.workflow!.definitionsStatus,
  definitionsComplete: task.workflow!.definitionsComplete,
  requirementsKnown: task.workflow!.requirementsKnown,
  requirements: task.workflow!.requirements,
  issues: task.workflow!.issues,
  plan: task.workflow!.plan,
});
export const workflowPlan = (task: TaskRecord): WorkflowPlanValue => workflowValue(task);
export const withLocalStep = (task: TaskRecord, name: string, reason: string): WorkflowPlanValue => {
  const value = workflowPlan(task);
  assert.ok(value.plan);
  return {...value, plan: {...value.plan, nodes: [...value.plan.nodes, {kind: "step", nodeId: randomUUID(), definitionId: null,
    localId: `local-${randomUUID()}`, templatePath: null, name, description: reason, source: null, resolution: "resolved", reason,
    status: "planned", contributorThreadIds: []}]}};
};
export const workflowWithoutRequiredStep = (task: TaskRecord): WorkflowPlanValue => {
  const value = validateWorkflowPlan({requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The verification remains required."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "skip-verification", name: "Skip verification", description: "No verification will be done.", reason: "Skip."}]}}, task.definitionContext!);
  assert.ok(value);
  return value;
};
export const workflowRecord = (task: TaskRecord, proposalId: string, workflow = workflowPlan(task)) => ({
  taskId: task.id,
  proposalId,
  workspaceRoot: task.workflow!.workspaceRoot,
  revision: task.workflow!.revision,
  workflow,
});
export const workflowFence = (kind: "workflow-proposal" | "workflow-acceptance", value: unknown) => "```" + kind + "\n" + JSON.stringify(value) + "\n```";
export type FullWorkflowRecord = ReturnType<typeof workflowRecord>;
export const isFullRecord = (value: unknown): value is FullWorkflowRecord => typeof value === "object" && value !== null && "workflow" in value && "workspaceRoot" in value;
export const draftRequirements = (workflow: WorkflowPlanValue) => workflow.requirements.map(item => ({kind: item.kind, id: item.id,
  applies: item.state === "not_applicable" ? false : item.state === "unknown" ? "unknown" as const : true, reason: item.reason}));
/** The compact draft a root publishes for a canonical plan; the service re-derives the identical canonical record. */
export const compactDraft = (task: TaskRecord, record: FullWorkflowRecord) => ({taskId: record.taskId, taskRevision: task.sourceHash, proposalId: record.proposalId,
  revision: record.revision, draft: {requirements: draftRequirements(record.workflow), plan: record.workflow.plan}});
/** The operative's compact acceptance of a canonical record: its task, proposal and exact digest. */
export const acceptanceReference = (task: TaskRecord, record: FullWorkflowRecord) => ({taskId: record.taskId, proposalId: record.proposalId,
  digest: compactProposalDigest({taskId: task.id, taskRevision: task.sourceHash}, {workspaceRoot: record.workspaceRoot!, revision: record.revision, workflow: record.workflow})});
export const projectDefinitionDecisionFence = (value: unknown) => `\`\`\`project-definition-decision\n${JSON.stringify(value)}\n\`\`\``;

export const appendActualUserMessage = (projection: Projection, id: string, text: string, now: number): MessageInfo => {
  const ordinal = projection.runs.reduce((value, run) => Math.max(value, run.ordinal), 0) + 1;
  const run = appendRun({projection, id: `${id}-run`, ordinal, status: "completed", messageId: id, text, now});
  return projection.messages.find(message => message.id === run.userMessageId)!;
};

export const appendDefinitionDecision = (fixture: Fixture, value: unknown, now: number) =>
  appendAssistantTurn(fixture.supervisor, `definition-decision-${fixture.supervisor.runs.length}`, projectDefinitionDecisionFence(value), now);

export const appendAssistantTurn = (projection: Projection, id: string, text: string, now: number, options: {
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

export const appendSupervisorProposal = (fixture: Fixture, proposalId = fixture.task.id,
  workflow = workflowPlan(fixture.task), now = baseTime, recordTask = fixture.task) => appendAssistantTurn(fixture.supervisor,
  `supervisor-proposal-${proposalId}-${fixture.supervisor.runs.length}`,
  `I propose this workflow.\n${workflowFence("workflow-proposal", compactDraft(fixture.projectStore.task(recordTask.threadId) ?? recordTask, workflowRecord(recordTask, proposalId, workflow)))}`, now);

export const appendOperativeAcceptance = (fixture: Fixture, value: unknown, now: number, options: {
  text?: string;
  streaming?: boolean;
  nodeKind?: string;
  run?: RunInfo;
} = {}) => {
  const run = options.run ?? fixture.operative.runs.find(item => item.id === fixture.operative.thread.activeRunId);
  assert.ok(run);
  const task = fixture.projectStore.task(fixture.task.threadId) ?? fixture.task;
  const record = isFullRecord(value) ? acceptanceReference(task, value) : value;
  const message = appendMessageToRun(fixture.operative, run, {id: `operative-acceptance-${fixture.operative.messages.length}`,
    role: "assistant", text: options.text ?? workflowFence("workflow-acceptance", record), now});
  if (options.streaming) message.streaming = true;
  if (options.nodeKind) {
    const node = nodesOf(fixture.operative).find(candidate => candidate.id === message.nodeId);
    assert.ok(node);
    node.kind = options.nodeKind;
  }
  return message;
};

export const observeAgreement = (fixture: Fixture, now: number) =>
  fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), now);
