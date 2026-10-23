import assert from "node:assert/strict";
import { join } from "node:path";
import { Effect, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { fingerprint } from "../../src/guidance-store.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { defaultSupervisorModel, type BindingRecord, type TaskRecord } from "../../src/project-supervisor-store.js";
import { workflowIntroductionText } from "../../src/supervisor-conversation.js";
import { prepareWorkflowRequest, validateWorkflowPlan, type WorkflowPlanValue } from "../../src/supervisor-workflow.js";
import type { WorkflowIntroduction } from "../../src/supervisor-conversation-store.js";
import { SupervisorRpcError } from "../../src/supervisor-native.js";
import type { MessageInfo, Projection, RunInfo, ThreadInfo } from "../../src/types.js";
import { compactProposalDigest } from "../../src/supervisor-workflow-agreement.js";
import { effectiveIndex, indexSource, projectIndex, testSummary } from "../project-definitions-fixture.js";
import { recordInterpretationSubmission } from "./interpretation-evidence-fixture.js";
import {
  atWallTime, makeFakeT3, noNativeRead, openConversationProcess, openProjectSupervisor, runSettings, temporaryDirectory, type ConversationProcess, type RpcCall,
} from "./g1b-conversation.js";

export { abortHonouringSend, proceed, type Flight, type RpcCall } from "./g1b-conversation.js";

// copied from test/supervisor-conversation.test.ts (frozen baseline suite) and extended with an rpc interceptor, a reopened
// process on the same files and a second bound main; the processes are the production services of ./g1b-conversation.ts over
// the fake T3 below, opened in the test's scope

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

const nodesOf = (projection: Projection): Array<Record<string, unknown>> => {
  if (!Array.isArray(projection.nodes)) projection.nodes = [];
  return projection.nodes as Array<Record<string, unknown>>;
};

const turnItemsOf = (projection: Projection): Array<Record<string, unknown>> => {
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

/** The suite's wall time: the fake T3 stamps what it records with it; `setNow` moves the services' test clock with it. */
export interface FixtureClock { now: number }

/** A suite clock at `time`, with the services' test clock there too, as the baseline suites mocked Date.now to the suite clock. */
export const suiteClock = (time: number): Effect.Effect<FixtureClock> => Effect.as(TestClock.setTime(time), {now: time});
/** Moves the suite clock and the services' test clock to `time`. */
export const setNow = (clock: FixtureClock, time: number): Effect.Effect<void> => Effect.andThen(Effect.sync(() => {clock.now = time;}), TestClock.setTime(time));

const eligible = (thread: ThreadInfo) => thread.id.startsWith("operative-") && thread.projectId === projectId;

/** One process's run of a binding of the operative main: its current binding record, the Supervisor projection and the threads. */
const runOf = (process: ConversationProcess, mainThreadId: string, supervisor: Projection, threads: readonly ThreadInfo[]) =>
  Effect.flatMap(process.store.binding(projectId, mainThreadId), (binding) => process.conversation.run(binding as BindingRecord, supervisor, threads));

export const makeFixture = (clock: FixtureClock, options: FixtureOptions = {}) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c1-conversation-");
  const threadPolicyDirectory = join(directory, "thread-policy");
  const definitionSnapshot = definitions();
  const projections = new Map<string, Projection>();
  const supervisorThreadIds = new Set<string>();
  let nextSupervisorRun = 0;
  // T3's own handling of a command: a settle shows the thread settled; a message dispatch starts or queues a Supervisor run, starts
  // a notice run on an idle operative or steers the operative's active run; anything else fails as the real client classifies a
  // failure after sending
  const unexpected = Effect.fail(new SupervisorRpcError("uncertain"));
  const answer = (call: RpcCall, calls: ReadonlyArray<RpcCall>) => Effect.suspend(() => {
    const {tag, payload} = call;
    if (tag === "orchestration.dispatchCommand" && payload.type === "thread.settle") {
      const projection = projections.get(String(payload.threadId));
      if (!projection) return unexpected;
      projection.thread.settledAt = iso(clock.now);projection.thread.settledOverride = "settled";
      return Effect.succeed({sequence: calls.length});
    }
    if (tag !== "orchestration.dispatchCommand" || payload.type !== "message.dispatch") return unexpected;

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
      return Effect.succeed({ sequence: calls.length });
    }

    const operativeTarget = projections.get(targetThreadId);
    if (operativeTarget) {
      const dispatchMode = payload.dispatchMode as Record<string, unknown> | undefined;
      if (dispatchMode?.type === "queue_after_active" && !operativeTarget.runs.some(candidate => ["running", "waiting", "starting", "queued"].includes(candidate.status))) {
        appendRun({projection: operativeTarget, id: `operative-notice-run-${calls.length}`,
          ordinal: Math.max(0, ...operativeTarget.runs.map(candidate => candidate.ordinal)) + 1, status: "running",
          messageId: String(payload.messageId), text: String(payload.text), createdBy: "user", creationSource: "server", now: clock.now});
        return Effect.succeed({sequence: calls.length});
      }
      const runId = String(dispatchMode?.targetRunId ?? operativeTarget.thread.activeRunId ?? "operative-active-run");
      const run = operativeTarget.runs.find(candidate => candidate.id === runId);
      if (!run) return unexpected;
      appendMessageToRun(operativeTarget, run, {
        id: String(payload.messageId),
        role: "user",
        text: String(payload.text),
        createdBy: "system",
        creationSource: "server",
        now: clock.now,
      });
      return Effect.succeed({ sequence: calls.length });
    }

    return unexpected;
  });
  const fake = yield* makeFakeT3({projections, answer, definitions: (loadedProjectId, threadId) => ({...definitionSnapshot, projectId: loadedProjectId, threadId})});
  /** a process on the suite's files over the fake T3: its own database clients and services, closed with the test */
  const openProcess = openConversationProcess({directory, policyDirectory: threadPolicyDirectory, fake, eligible});
  const process = yield* openProcess;
  const projectStore = process.store;
  const binding = yield* projectStore.reserve(projectId, operativeThreadId, "Project A", defaultSupervisorModel, 10, clock.now);
  yield* projectStore.setBinding({ ...binding, state: "ready" });
  const settings = yield* projectStore.settings(projectId);
  yield* projectStore.saveSettings(projectId, settings.generation, settings.modelSelection, options.settings ?? {
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
  projections.set(operativeThreadId, operative);
  projections.set(binding.threadId, supervisor);
  supervisorThreadIds.add(binding.threadId);
  const prepared = prepareWorkflowRequest(operativeThreadId, sourceMessageId, sourceText, definitionSnapshot);
  assert.ok(prepared.context);
  const initialPlan = requiredPlanForContext(prepared.context);
  const draftTask: TaskRecord = {
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
  const task = options.task === false || options.workflow === false ? draftTask : yield* setInterpretationSubmission(supervisor, draftTask, requiredRawPlan());
  if (options.task !== false) yield* projectStore.saveTask(task);
  yield* projectStore.baseline({snapshotSequence: 1, threads: []});

  const threadList = [supervisor.thread, operative.thread];
  /** a new process on the same files: fresh database clients and services over the same fake T3 */
  const reopen = Effect.map(openProcess, (reopened) => ({...reopened, run: runOf(reopened, operativeThreadId, supervisor, threadList)}));
  /** a second main with its own Supervisor binding in the same project */
  const addBoundOperative = (threadId: string, taskId: string) => Effect.gen(function* () {
    const reserved = yield* projectStore.reserve(projectId, threadId, "Project A", defaultSupervisorModel, 10, clock.now);
    yield* projectStore.setBinding({...reserved, state: "ready"});
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
    const draftBound: TaskRecord = {...draftTask, id: taskId, threadId, sourceRunId: source.id, sourceMessageId: messageId, sourceHash: fingerprint(messageText),
      sourceOrdinal: source.ordinal, definitionContext: context, definitionSnapshot: {...definitionSnapshot, threadId},
      messageId: `supervisor-objective:${taskId}`, supervisorThreadId: reserved.threadId,
      workflow: {status: "proposed", message: "A draft is ready.", workspaceRoot, revision, globalRevision: null, ...requiredPlanForContext(context)}};
    const boundTask = yield* setInterpretationSubmission(ownSupervisor, draftBound, requiredRawPlan());
    yield* projectStore.saveTask(boundTask);
    const boundBinding = (yield* projectStore.binding(projectId, threadId)) as BindingRecord;
    return {binding: boundBinding, supervisor: ownSupervisor, projection, task: boundTask, run: runOf(process, threadId, ownSupervisor, threadList)};
  }).pipe(Effect.orDie);
  /** the production project supervisor beside the process, over its stores, with its own scope predicates and team services */
  const makeProjectSupervisor: Effect.Effect<Effect.Success<ReturnType<typeof openProjectSupervisor>>, never, Scope.Scope> = Effect.suspend(() => openProjectSupervisor(process, fake, {
    settings: runSettings(directory, "http://localhost"),
    read: noNativeRead,
    catalog: () => Effect.succeed({ projects: [{ project: { id: projectId, title: "Project A", workspaceRoot }, available: true }], threads: threadList }),
    baseline: {snapshotSequence: 1, threads: []},
    now: () => clock.now,
  }));
  return {
    directory,
    clock,
    binding: (yield* projectStore.binding(projectId, operativeThreadId)) as BindingRecord,
    fake,
    calls: fake.calls,
    projectionReads: fake.projectionReads,
    intercept: fake.intercept,
    process,
    sql: process.sql,
    projectStore,
    requests: process.requests,
    monitor: process.monitor,
    threadPolicy: process.policy,
    workflows: process.workflows,
    conversation: process.conversation,
    /** ends this process's connections without any further write, as a crash would */
    crash: process.crash,
    reopen,
    addBoundOperative,
    makeProjectSupervisor,
    operative,
    run: runOf(process, operativeThreadId, supervisor, threadList),
    supervisor,
    task,
    threadList,
  };
}).pipe(Effect.orDie);
export type Fixture = Effect.Success<ReturnType<typeof makeFixture>>;

// the Supervisor's own completed interpretation run (the root's first turn) and its recorded typed submission: the task as
// finalization leaves it holds the attempt, the evidence pinning the executed tool item and the submitted plan
export const setInterpretationSubmission = (supervisor: Projection, task: TaskRecord, raw: unknown, objective = task.objective) => Effect.gen(function* () {
  const runId = task.supervisorRunId ?? "supervisor-objective-run";
  const run = supervisor.runs.find(item => item.id === runId) ??
    appendRun({projection: supervisor, id: runId, ordinal: 0, status: "completed", messageId: task.messageId, text: "Interpret the task.", now: baseTime - 60_000});
  return (yield* recordInterpretationSubmission({supervisor, run, task, bindingGeneration: 1, workflow: raw, objective})).task;
});

export const appendNoticeForTask = (fixture: Fixture, task: TaskRecord, projection: Projection) => Effect.gen(function* () {
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
  yield* fixture.requests.saveIntroduction(introduction);
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
});

export const appendNoticeToOperative = (fixture: Fixture) => appendNoticeForTask(fixture, fixture.task, fixture.operative);

export const workflowPlan = (task: TaskRecord): WorkflowPlanValue => ({
  definitionsStatus: task.workflow!.definitionsStatus,
  definitionsComplete: task.workflow!.definitionsComplete,
  requirementsKnown: task.workflow!.requirementsKnown,
  requirements: task.workflow!.requirements,
  issues: task.workflow!.issues,
  plan: task.workflow!.plan,
});
export const workflowRecord = (task: TaskRecord, proposalId: string, workflow = workflowPlan(task)) => ({
  taskId: task.id,
  proposalId,
  workspaceRoot: task.workflow!.workspaceRoot,
  revision: task.workflow!.revision,
  workflow,
});
const workflowFence = (kind: "workflow-proposal" | "workflow-acceptance", value: unknown) => "```" + kind + "\n" + JSON.stringify(value) + "\n```";
type FullWorkflowRecord = ReturnType<typeof workflowRecord>;
const isFullRecord = (value: unknown): value is FullWorkflowRecord => typeof value === "object" && value !== null && "workflow" in value && "workspaceRoot" in value;
const draftRequirements = (workflow: WorkflowPlanValue) => workflow.requirements.map(item => ({kind: item.kind, id: item.id,
  applies: item.state === "not_applicable" ? false : item.state === "unknown" ? "unknown" as const : true, reason: item.reason}));
/** The compact draft a root publishes for a canonical plan; the service re-derives the identical canonical record. */
export const compactDraft = (task: TaskRecord, record: FullWorkflowRecord) => ({taskId: record.taskId, taskRevision: task.sourceHash, proposalId: record.proposalId,
  revision: record.revision, draft: {requirements: draftRequirements(record.workflow), plan: record.workflow.plan}});
/** The operative's compact acceptance of a canonical record: its task, proposal and exact digest. */
const acceptanceReference = (task: TaskRecord, record: FullWorkflowRecord) => ({taskId: record.taskId, proposalId: record.proposalId,
  digest: compactProposalDigest({taskId: task.id, taskRevision: task.sourceHash}, {workspaceRoot: record.workspaceRoot!, revision: record.revision, workflow: record.workflow})});

const appendAssistantTurn = (projection: Projection, id: string, text: string, now: number) => {
  const ordinal = projection.runs.reduce((value, run) => Math.max(value, run.ordinal), 0) + 1;
  const run = appendRun({projection, id: `${id}-run`, ordinal, status: "completed", messageId: `${id}-input`, text: "Review this workflow.", now});
  const message = appendMessageToRun(projection, run, {id: `${id}-answer`, role: "assistant", text, now});
  return {run, message};
};

export const appendSupervisorProposal = (fixture: Fixture, proposalId = fixture.task.id, workflow = workflowPlan(fixture.task), now = baseTime, recordTask = fixture.task) =>
  Effect.map(fixture.projectStore.task(recordTask.threadId), (stored) => appendAssistantTurn(fixture.supervisor,
    `supervisor-proposal-${proposalId}-${fixture.supervisor.runs.length}`,
    `I propose this workflow.\n${workflowFence("workflow-proposal", compactDraft(stored ?? recordTask, workflowRecord(recordTask, proposalId, workflow)))}`, now));

export const appendOperativeAcceptance = (fixture: Fixture, value: unknown, now: number) => Effect.map(fixture.projectStore.task(fixture.task.threadId), (stored) => {
  const run = fixture.operative.runs.find(item => item.id === fixture.operative.thread.activeRunId);
  assert.ok(run);
  const task = stored ?? fixture.task;
  const record = isFullRecord(value) ? acceptanceReference(task, value) : value;
  return appendMessageToRun(fixture.operative, run, {id: `operative-acceptance-${fixture.operative.messages.length}`,
    role: "assistant", text: workflowFence("workflow-acceptance", record), now});
});

/** One observation of every thread at the wall time `now`. */
export const observeAgreement = (fixture: Fixture, now: number) => fixture.conversation.observe(fixture.threadList).pipe(atWallTime(now));
