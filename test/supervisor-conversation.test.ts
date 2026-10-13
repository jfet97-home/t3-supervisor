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
import type { WorkflowIntroduction } from "../src/supervisor-conversation-store.js";
import { SupervisorRpcError, type SupervisorRpc } from "../src/supervisor-native.js";
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
  const run = projection.runs.find(candidate => candidate.id === "operative-active-run");
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

    if (targetThreadId === operativeThreadId) {
      if (failNextIntroduction) {
        failNextIntroduction = false;
        throw new SupervisorRpcError("uncertain");
      }
      if (returnInvalidNextIntroductionReceipt) {
        returnInvalidNextIntroductionReceipt = false;
        return { sequence: -1 };
      }
      const dispatchMode = payload.dispatchMode as Record<string, unknown> | undefined;
      const runId = String(dispatchMode?.targetRunId ?? operative.thread.activeRunId ?? "operative-active-run");
      const run = operative.runs.find(candidate => candidate.id === runId);
      assert.ok(run);
      appendMessageToRun(operative, run, {
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
      const projection = projections.get(threadId);
      if (!projection) throw new Error(`missing test projection ${threadId}`);
      return projection;
    },
    definitionLoader,
    thread => thread.id === operativeThreadId && thread.projectId === projectId,
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
  const signal = AbortSignal.timeout(10_000);
  return {
    binding: projectStore.binding(projectId) as BindingRecord,
    calls,
    cleanup: async () => { guidance.close(); await rm(directory, { recursive: true, force: true }); },
    conversation,
    failNextIntroduction: () => { failNextIntroduction = true; },
    makeProjectSupervisor: () => projectSupervisor,
    returnInvalidNextIntroductionReceipt: () => { returnInvalidNextIntroductionReceipt = true; },
    operative,
    projectStore,
    run: () => conversation.run(projectStore.binding(projectId) as BindingRecord, supervisor, threadList, signal),
    supervisor,
    task,
    threadList,
  };
};

const appendNoticeToOperative = (fixture: Awaited<ReturnType<typeof makeFixture>>): WorkflowIntroduction => {
  const introduction: WorkflowIntroduction = {
    taskId: fixture.task.id,
    projectId,
    threadId: operativeThreadId,
    supervisorThreadId: fixture.binding.threadId,
    state: "sent",
    text: workflowIntroductionText(fixture.task),
    messageId: `supervisor-notice:workflow:${fixture.task.id}`,
    targetRunId: "operative-active-run",
    error: null,
  };
  fixture.conversation.requests.saveIntroduction(introduction);
  const run = fixture.operative.runs.find(candidate => candidate.id === "operative-active-run");
  assert.ok(run);
  appendMessageToRun(fixture.operative, run, {
    id: introduction.messageId,
    role: "user",
    text: introduction.text,
    createdBy: "system",
    creationSource: "server",
  });
  return introduction;
};

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
  completeRun(fixture.supervisor, run, `Ready to discuss the draft. ${request.completionMarker}`, clock.now + 2);
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

test("a user message in the reviewed Supervisor run leaves the batch unacknowledged", async t => {
  const clock = { now: baseTime };
  t.mock.method(Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, { settings: { enabled: true, intervalMinutes: 5, activityThreshold: 3 } });
  t.after(fixture.cleanup);
  appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `contaminated-command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  await fixture.run();

  const request = fixture.conversation.requests.pending(projectId);
  assert.ok(request?.batch);
  const run = fixture.supervisor.runs.find(candidate => candidate.userMessageId === request.messageId);
  assert.ok(run);
  appendMessageToRun(fixture.supervisor, run, {
    id: "direct-user-reply-during-review",
    role: "user",
    text: "Please do another task.",
    createdBy: "user",
    creationSource: "web",
    now: clock.now,
  });
  completeRun(fixture.supervisor, run, `The review is complete. ${request.completionMarker}`, clock.now + 1);
  clock.now++;

  await fixture.run();
  assert.equal(fixture.conversation.requests.requests(projectId).find(item => item.id === request.id)?.state, "failed");
  const pendingIds = new Set(fixture.conversation.monitor.pending(projectId, operativeThreadId).map(item => item.id));
  for (const item of request.batch.threads.flatMap(thread => thread.items)) assert.ok(pendingIds.has(item.id));
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
  assert.equal(fixture.conversation.monitor.pending(projectId, operativeThreadId).length, 3);

  clock.now += 31_000;
  await saveMonitoring({
    enabled: true,
    intervalMinutes: 5,
    activityThreshold: 3,
  });
  await fixture.run();
  const reviewCalls = fixture.calls.filter(call => call.payload.threadId === fixture.binding.threadId && String(call.payload.text).includes("Review this factual change index."));
  assert.equal(reviewCalls.length, 2);
  assert.equal(fixture.conversation.monitor.pending(projectId, operativeThreadId).length, 3);
  assert.deepEqual(fixture.conversation.requests.pending(projectId)?.batch?.threads[0]?.items.map(item => item.id), ["threshold-command-1", "threshold-command-2", "threshold-command-3"]);
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
