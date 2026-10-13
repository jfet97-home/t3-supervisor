import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { GuidanceStore, fingerprint } from "../src/guidance-store.js";
import type { ProjectDefinitionLoader } from "../src/project-definitions.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { ProjectSupervisorStore, defaultSupervisorModel, type BindingRecord, type TaskRecord } from "../src/project-supervisor-store.js";
import { ProjectSupervisor } from "../src/project-supervisor.js";
import { SupervisorConversation, workflowIntroductionText } from "../src/supervisor-conversation.js";
import type { ConversationRequest, WorkflowIntroduction } from "../src/supervisor-conversation-store.js";
import { SupervisorRpcError, type SupervisorRpc } from "../src/supervisor-native.js";
import { T3TransportError } from "../src/t3.js";
import type { MessageInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "../src/types.js";

const projectId = "project-a";
const operativeThreadId = "operative-a";
const sourceMessageId = "operative-task";
const sourceText = "Implement the export workflow";
const workspaceRoot = "/work/project/worktrees/feature";
const revision = "rules-revision-7";
const baseTime = Date.parse("2026-10-13T10:00:00.000Z");
const iso = (time = baseTime): string => new Date(time).toISOString();

const definitions = (): ProjectDefinitionSnapshot => ({
  projectId,
  threadId: operativeThreadId,
  workspaceRoot,
  revision,
  editingAvailable: true,
  status: "ready",
  rules: [{ name: "Focused verification", description: "Test changed behavior.", required_blocks: ["test-plan"] }],
  blocks: [{ id: "test-plan", name: "Test plan", description: "Verify the behavior.", instructions: "Add a focused test.", expected_result: "The test passes." }],
  issues: [],
});

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
    providerThreadId,
  };
  projection.runs.push(run);
  nodesOf(projection).push(
    {
      id: rootNodeId,
      threadId,
      runId: run.id,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: completed ? "completed" : input.status === "queued" ? "pending" : "running",
      providerThreadId,
    },
    {
      id: `${input.messageId}-node`,
      threadId,
      runId: run.id,
      parentNodeId: rootNodeId,
      rootNodeId,
      kind: "user_message",
      status: "completed",
      providerThreadId,
    },
  );
  const message: MessageInfo = {
    id: input.messageId,
    threadId,
    runId: run.id,
    nodeId: `${input.messageId}-node`,
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

const appendMessageToRun = (
  projection: Projection,
  run: RunInfo,
  input: { id: string; role: "user" | "assistant"; text: string; createdBy?: string; creationSource?: string; now?: number },
): MessageInfo => {
  const now = input.now ?? baseTime;
  const nodeId = `${input.id}-node`;
  const rootNodeId = run.rootNodeId!;
  const providerThreadId = String(run.providerThreadId);
  nodesOf(projection).push({
    id: nodeId,
    threadId: projection.thread.id,
    runId: run.id,
    parentNodeId: rootNodeId,
    rootNodeId,
    kind: input.role === "assistant" ? "assistant_message" : "user_message",
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

const completeRun = (projection: Projection, run: RunInfo, text: string, now = baseTime): void => {
  run.status = "completed";
  run.completedAt = iso(now);
  const root = nodesOf(projection).find(node => node.id === run.rootNodeId);
  assert.ok(root);
  root.status = "completed";
  appendMessageToRun(projection, run, { id: `assistant-${run.id}`, role: "assistant", text, now });
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
  settings?: { enabled: boolean; intervalMinutes: number; activityThreshold: number };
  queuePeerDuringNextSupervisorDispatch?: boolean;
}

interface Clock { now: number }

const makeFixture = async (clock: Clock, options: FixtureOptions = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-conversation-test-"));
  const guidance = new GuidanceStore(directory);
  const projectStore = new ProjectSupervisorStore(guidance, new Set());
  const binding = projectStore.reserve(projectId, "Project A", defaultSupervisorModel, 10, clock.now);
  projectStore.setBinding({ ...binding, state: "ready" });
  const settings = projectStore.settings(projectId);
  projectStore.saveSettings(projectId, settings.generation, settings.modelSelection, options.settings ?? {
    enabled: true,
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
    requestText: "",
    supervisorThreadId: binding.threadId,
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
        rules: [{ index: 0, name: "Focused verification", applies: true, reason: "The task changes behavior." }],
        steps: [{ blockId: "test-plan", name: "Test plan", reason: "Verify the change." }],
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
      const snapshot = definitions();
      return { ...snapshot, projectId: loadedProjectId, threadId: threadId ?? null };
    },
  };
  const threadList = [supervisor.thread, operative.thread];
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
      messageId: `supervisor-objective:${proposalId}`,
    };
    projectStore.saveTask(additionalTask);
    return { projection, task: additionalTask };
  };
  const signal = AbortSignal.timeout(10_000);
  return {
    binding: projectStore.binding(projectId) as BindingRecord,
    calls,
    cleanup: async () => { guidance.close(); await rm(directory, { recursive: true, force: true }); },
    conversation,
    addOperative,
    failNextIntroduction: () => { failNextIntroduction = true; },
    rejectNextIntroduction: (count = 1) => { introductionsToReject += count; },
    makeProjectSupervisor: () => projectSupervisor,
    returnInvalidNextIntroductionReceipt: () => { returnInvalidNextIntroductionReceipt = true; },
    setProjectionFailure: (threadId: string, failure: Error) => { projectionFailures.set(threadId, failure); },
    projection: (threadId: string) => projections.get(threadId) ?? null,
    operative,
    projectStore,
    run: () => conversation.run(projectStore.binding(projectId) as BindingRecord, supervisor, threadList, signal),
    supervisor,
    task,
    threadList,
  };
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
    createdBy: "system",
    creationSource: "server",
  });
  return introduction;
};

const appendNoticeToOperative = (fixture: Awaited<ReturnType<typeof makeFixture>>): WorkflowIntroduction =>
  appendNoticeForTask(fixture, fixture.task, fixture.operative);

const supervisorRequestCall = (fixture: Awaited<ReturnType<typeof makeFixture>>, kind?: "context" | "review") =>
  fixture.calls.find(call => call.payload.threadId === fixture.binding.threadId &&
    (kind === undefined || String(call.payload.text).includes(kind === "context" ? "This initializes supervision" : "Review this factual change index.")));

test("context bootstrap is queued atomically, correlated to its own run, and only then steers the operative run", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { queuePeerDuringNextSupervisorDispatch: true });
  t.after(fixture.cleanup);

  await fixture.run();
  const contextCall = supervisorRequestCall(fixture, "context");
  assert.ok(contextCall);
  assert.deepEqual(contextCall.payload.dispatchMode, { type: "queue_after_active" });
  const request = fixture.conversation.requests.pending(projectId);
  assert.ok(request);
  assert.equal(request.kind, "context");
  assert.equal(request.messageId, contextCall.payload.messageId);
  assert.ok(request.completionMarker.length > 0);
  assert.ok(String(contextCall.payload.text).includes(request.completionMarker));
  const message = fixture.supervisor.messages.find(item => item.id === request.messageId && item.text === request.text);
  assert.ok(message);
  const run = fixture.supervisor.runs.find(item => item.userMessageId === request.messageId && item.id === message.runId);
  assert.ok(run);
  assert.equal(run.status, "queued", "a direct peer run that starts during dispatch keeps its place ahead of context");
  assert.equal(fixture.calls.some(call => call.payload.threadId === operativeThreadId), false);

  await fixture.run();
  assert.equal(fixture.conversation.requests.pending(projectId)?.runId, run.id);
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
  const request = fixture.conversation.requests.pending(projectId);
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
  assert.equal(fixture.conversation.requests.pending(projectId), null);
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

  fixture.conversation.retry(projectId);
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

  fixture.conversation.retry(projectId);
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

  fixture.conversation.retry(projectId);
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
  const fixture = await makeFixture(clock, { settings: { enabled: true, intervalMinutes: 5, activityThreshold: 3 } });
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
  const request = fixture.conversation.requests.pending(projectId);
  assert.equal(request?.kind, "review");
  assert.deepEqual(request?.batch?.threads.map(thread => thread.threadId), [second.task.threadId]);
  assert.ok(supervisorRequestCall(fixture, "review"));
});

test("a deleted operative introduction is blocked while another operative chat still gets reviewed", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { enabled: true, intervalMinutes: 5, activityThreshold: 3 } });
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
  const request = fixture.conversation.requests.pending(projectId);
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
    const fixture = await makeFixture(clock, { settings: { enabled: true, intervalMinutes: 5, activityThreshold: 3 } });
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

    const request = fixture.conversation.requests.pending(projectId);
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

test("starting and waiting operative runs are queued instead of actively steered", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  for (const status of ["starting", "waiting"] as const) {
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

    const call = fixture.calls.find(item => item.payload.threadId === operativeThreadId);
    assert.ok(call);
    assert.deepEqual(call.payload.dispatchMode, { type: "queue_after_active" }, `${status} runs must not be steered`);
    clock.now++;
  }
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
  fixture.conversation.retry(projectId);
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

test("one review stays in flight while activity changes and acknowledges only its frozen batch", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { enabled: true, intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);

  await fixture.run();
  const firstCall = supervisorRequestCall(fixture, "review");
  const request = fixture.conversation.requests.pending(projectId);
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
  const fixture = await makeFixture(clock, { settings: { enabled: true, intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `contaminated-command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  const requests: ConversationRequest[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await fixture.run();
    const request = fixture.conversation.requests.pending(projectId);
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
    assert.equal(fixture.conversation.requests.pending(projectId), null, "a replaced run primary is terminal rather than an endless wait");
    assert.equal(fixture.conversation.requests.reviewMisses(projectId), attempt);
    const pendingIds = new Set(fixture.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id));
    for (let index = 1; index <= 3; index++) assert.ok(pendingIds.has(`contaminated-command-${index}`));
    if (attempt < 3) assert.equal(fixture.conversation.status(projectId).state, "idle");
  }

  assert.equal(fixture.conversation.status(projectId).state, "unavailable");
  assert.equal(requests[2]?.failureAcknowledged, undefined);
  fixture.conversation.retry(projectId);
  assert.equal(fixture.conversation.requests.reviewMisses(projectId), 0);
  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === requests[2]?.id)?.failureAcknowledged, true);
  await fixture.run();
  assert.equal(fixture.conversation.requests.pending(projectId)?.kind, "review");
});

test("a direct peer reply with senderThreadId does not contaminate a valid review", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { enabled: true, intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `peer-safe-command-${index}`, `PRIVATE_PEER_SAFE_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  await fixture.run();

  const request = fixture.conversation.requests.pending(projectId);
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
  const fixture = await makeFixture(clock, { settings: { enabled: true, intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  for (let index = 0; index < 100; index++) addCommandActivity(fixture.operative, `burst-command-${index}`, `PRIVATE_BURST_BODY_${index}`, clock.now - (100 - index) * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  await fixture.run();

  const request = fixture.conversation.requests.pending(projectId);
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

test("paused prepared requests retain their native identity until monitoring resumes", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock);
  t.after(fixture.cleanup);
  const request = fixture.conversation.requests.prepare({
    projectId,
    supervisorThreadId: fixture.binding.threadId,
    kind: "review",
    taskId: null,
    text: "Prepared before monitoring was paused.",
    batch: null,
    completionMarker: "prepared request complete",
  }, clock.now);
  let settings = fixture.projectStore.settings(projectId);
  fixture.projectStore.saveSettings(projectId, settings.generation, settings.modelSelection, {
    enabled: false,
    intervalMinutes: 5,
    activityThreshold: 3,
  });

  await fixture.run();
  assert.equal(fixture.conversation.requests.pending(projectId)?.state, "prepared");
  assert.equal(fixture.calls.length, 0);

  settings = fixture.projectStore.settings(projectId);
  fixture.projectStore.saveSettings(projectId, settings.generation, settings.modelSelection, {
    enabled: true,
    intervalMinutes: 5,
    activityThreshold: 3,
  });
  await fixture.run();

  const dispatched = fixture.conversation.requests.pending(projectId);
  assert.equal(dispatched?.id, request.id);
  assert.equal(dispatched?.messageId, request.messageId);
  assert.equal(dispatched?.state, "waiting");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0]?.payload.messageId, request.messageId);
});

test("monitoring-only API saves pause and resume the live threshold without losing pending activity", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { enabled: true, intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  const saveMonitoring = async (monitoring: { enabled: boolean; intervalMinutes: number; activityThreshold: number }) => {
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
  const firstRequest = fixture.conversation.requests.pending(projectId);
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
    enabled: true,
    intervalMinutes: 5,
    activityThreshold: 4,
  });
  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.payload.threadId === fixture.binding.threadId).length, 1);
  assert.equal(fixture.conversation.monitor.pending(projectId, operativeThreadId).length, 2);

  await saveMonitoring({
    enabled: false,
    intervalMinutes: 5,
    activityThreshold: 4,
  });
  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.payload.threadId === fixture.binding.threadId).length, 1);
  addCommandActivity(fixture.operative, "threshold-command-3", "PRIVATE_COMMAND_BODY_3", clock.now + 1_000);
  clock.now += 31_000;
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  const pendingIds = new Set(fixture.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id));
  for (let index = 1; index <= 3; index++) assert.ok(pendingIds.has(`threshold-command-${index}`));

  clock.now += 31_000;
  await saveMonitoring({
    enabled: true,
    intervalMinutes: 5,
    activityThreshold: 3,
  });
  await fixture.run();
  const reviewCalls = fixture.calls.filter(call => call.payload.threadId === fixture.binding.threadId && String(call.payload.text).includes("Review this factual change index."));
  assert.equal(reviewCalls.length, 2);
  const resumedPendingIds = new Set(fixture.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id));
  const batchIds = new Set(fixture.conversation.requests.pending(projectId)?.batch?.threads[0]?.items.map(item => item.id));
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
  assert.equal(fixture.conversation.requests.pending(projectId), null);
  assert.equal(fixture.calls.length, 0);
});
