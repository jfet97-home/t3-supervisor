import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { GuidanceStore } from "../src/guidance-store.js";
import { ProjectSupervisor } from "../src/project-supervisor.js";
import { ProjectSupervisorStore } from "../src/project-supervisor-store.js";
import type { ProjectDefinitionLoader } from "../src/project-definitions.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import type { SupervisorModelSelection } from "../src/project-supervisor-contract.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { T3TransportError } from "../src/t3.js";
import type { MessageInfo, ProjectInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "../src/types.js";

const projectId = "project-a";
const sourceThreadId = "source-thread";
const sourceMessageId = "source-message";
const baseTime = "2026-10-13T10:00:00.000Z";

const project: ProjectInfo = { id: projectId, title: "Project A", workspaceRoot: "/work/project" };
const modelConfig = {
  providers: [{
    enabled: true,
    instanceId: "codex",
    displayName: "Codex",
    installed: true,
    status: "ready",
    models: ["gpt-6-luna", "gpt-6-astra"].map((slug) => ({
      slug,
      name: slug,
      capabilities: { optionDescriptors: [{
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
          { id: "max", label: "Max" },
        ],
      }] },
    })),
  }],
};

const definitionSnapshot = (overrides: Partial<ProjectDefinitionSnapshot> = {}): ProjectDefinitionSnapshot => ({
  projectId,
  threadId: sourceThreadId,
  workspaceRoot: "/work/project/worktrees/feature",
  revision: "revision-1",
  editingAvailable: true,
  status: "ready",
  rules: [{ name: "Focused verification", description: "Check the changed behavior.", required_blocks: ["test-plan"] }],
  blocks: [{ id: "test-plan", name: "Test plan", description: "Verify behavior.", instructions: "Add a focused regression test.", expected_result: "The regression test passes." }],
  issues: [],
  ...overrides,
});

const sourceProjection = (): Projection => {
  const thread: ThreadInfo = {
    id: sourceThreadId,
    title: "Task conversation",
    projectId,
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const run: RunInfo = {
    id: "source-run",
    threadId: sourceThreadId,
    ordinal: 1,
    status: "completed",
    requestedAt: baseTime,
    startedAt: baseTime,
    completedAt: baseTime,
    rootNodeId: "source-root",
    userMessageId: sourceMessageId,
    providerThreadId: "source-provider",
  };
  const message: MessageInfo = {
    id: sourceMessageId,
    threadId: sourceThreadId,
    runId: run.id,
    nodeId: "source-root",
    role: "user",
    text: "Implement the export workflow",
    streaming: false,
    createdAt: baseTime,
    updatedAt: baseTime,
    createdBy: "user",
    creationSource: "web",
  };
  return {
    thread,
    runs: [run],
    messages: [message],
    nodes: [
      { id: "source-root", threadId: sourceThreadId, runId: run.id, parentNodeId: null, rootNodeId: "source-root", kind: "root_turn", status: "completed", providerThreadId: "source-provider" },
    ],
  };
};

const emptySupervisorProjection = (threadId: string, selection: SupervisorModelSelection): Projection => ({
  thread: {
    id: threadId,
    title: "Project Supervisor",
    projectId,
    lineage: { parentThreadId: null, relationshipToParent: null },
    modelSelection: selection,
  },
  runs: [],
  messages: [],
  nodes: [],
});

const addSupervisorRequest = (projection: Projection, payload: Record<string, unknown>): void => {
  const threadId = projection.thread.id;
  const ordinal = projection.runs.length + 1;
  const runId = `supervisor-run-${ordinal}`;
  const rootId = `supervisor-root-${ordinal}`;
  const messageId = String(payload.messageId);
  const now = new Date().toISOString();
  projection.runs.push({
    id: runId,
    threadId,
    ordinal,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    rootNodeId: rootId,
    userMessageId: messageId,
    providerThreadId: "supervisor-provider",
  });
  projection.messages.push({
    id: messageId,
    threadId,
    runId,
    nodeId: rootId,
    role: "user",
    text: String(payload.text),
    streaming: false,
    createdAt: now,
    updatedAt: now,
    creationSource: "server",
    createdBy: "system",
  });
  const nodes = projection.nodes as Array<Record<string, unknown>>;
  nodes.push(
    { id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "running", providerThreadId: "supervisor-provider" },
  );
};

const completeSupervisorRequest = (projection: Projection, messageId: string, response: string): void => {
  const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
  assert.ok(run?.rootNodeId);
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  const nodes = projection.nodes as Array<Record<string, unknown>>;
  const root = nodes.find((node) => node.id === run.rootNodeId);
  assert.ok(root);
  root.status = "completed";
  const nodeId = `supervisor-assistant-node-${run.id}`;
  nodes.push({
    id: nodeId,
    threadId: projection.thread.id,
    runId: run.id,
    parentNodeId: run.rootNodeId,
    rootNodeId: run.rootNodeId,
    kind: "assistant_message",
    status: "completed",
    providerThreadId: "supervisor-provider",
  });
  const now = new Date().toISOString();
  projection.messages.push({
    id: `assistant-${run.id}`,
    threadId: projection.thread.id,
    runId: run.id,
    nodeId,
    role: "assistant",
    text: response,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  });
};

const workflowResponse = (messageId: string): string => JSON.stringify({
  objective: "Implement the export workflow",
  reason: "The source conversation requests an export implementation.",
  sourceMessageIds: [messageId],
  workflow: {
    rules: [{ index: 0, applies: true, reason: "The change needs a focused behavior check." }],
    steps: [{ blockId: "test-plan", reason: "Verify the export behavior with a regression test." }],
  },
});

const objectiveResponse = (messageId: string): string => JSON.stringify({
  objective: "Implement the export workflow",
  reason: "The source conversation requests an export implementation.",
  sourceMessageIds: [messageId],
});

const makeFixture = async (initialDefinitions: ProjectDefinitionSnapshot = definitionSnapshot()) => {
  const directory = await mkdtemp(join(tmpdir(), "project-supervisor-workflow-test-"));
  const source = sourceProjection();
  const projections = new Map<string, Projection>([[sourceThreadId, source]]);
  const operations: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const definitionReads: Array<{ projectId: string; threadId: string | null }> = [];
  let definitionReadOutcomes: Array<ProjectDefinitionSnapshot | Error> = [];
  let currentDefinitions = initialDefinitions;
  let dispatchFailure: "unknown" | "rejected" | null = null;
  const guidance = new GuidanceStore(directory);
  const ownedIds = new Set<string>();
  const store = new ProjectSupervisorStore(guidance, ownedIds);
  guidance.db.prepare("INSERT INTO meta VALUES(?,?)").run(`supervisor_control:${JSON.stringify(source.thread.projectId)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const config: SupervisorConfig = {
    supervisorOwnedThreadIds: ownedIds,
    dataDirectory: directory,
    t3Url: "http://unused",
    t3TokenFile: "unused",
    mcpxUrl: "http://unused",
    cxCommand: "unused",
    cxHome: directory,
    cxSeedFile: "unused",
    excludedThreadIds: [],
    healthPort: 0,
    modelTimeoutMs: 1000,
  };
  const sourceStore = {
    catalog: () => Effect.succeed({
      projects: [{ project, available: true }],
      threads: [...projections.values()].map((projection) => projection.thread),
    }),
  };
  const t3 = {
    projection: (threadId: string) => {
      const projection = projections.get(threadId);
      return projection ? Effect.succeed({ projection, snapshotSequence: 20 }) : Effect.fail(new T3TransportError("missing projection", 404));
    },
  };
  const readRpc = async (tag: string): Promise<unknown> => {
    if (tag === "server.getConfig") return modelConfig;
    throw new Error(`unexpected fake read RPC: ${tag}`);
  };
  const operateRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    operations.push({ tag, payload });
    if (tag === "orchestration.launchThread") {
      const threadId = String(payload.threadId);
      projections.set(threadId, emptySupervisorProjection(threadId, payload.modelSelection as SupervisorModelSelection));
      return { accepted: true };
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "message.dispatch") {
      if (dispatchFailure === "unknown") {
        dispatchFailure = null;
        throw new Error("simulated lost dispatch response");
      }
      if (dispatchFailure === "rejected") {
        dispatchFailure = null;
        throw new SupervisorRpcError("rejected", true);
      }
      const projection = projections.get(String(payload.threadId));
      assert.ok(projection);
      addSupervisorRequest(projection, payload);
      delete projection.thread.settledAt;
      return { accepted: true };
    }
    throw new Error(`unexpected fake operation: ${tag}`);
  };
  const activationSnapshot = async () => ({ version: 2 as const, snapshotSequence: 10, threads: [] });
  const definitionLoader: Pick<ProjectDefinitionLoader, "load"> = {
    load: async (loadedProjectId, threadId) => {
      definitionReads.push({ projectId: loadedProjectId, threadId: threadId ?? null });
      const outcome = definitionReadOutcomes.shift();
      if (outcome instanceof Error) throw outcome;
      if (outcome) return outcome;
      return currentDefinitions;
    },
  };
  const makeSupervisor = (withDefinitions = true) => new ProjectSupervisor(
    config,
    store,
    sourceStore,
    t3,
    readRpc,
    operateRpc,
    activationSnapshot,
    withDefinitions ? definitionLoader : undefined,
  );
  return {
    binding: () => store.binding(projectId, sourceThreadId),
    cleanup: async () => { guidance.close(); await rm(directory, { recursive: true, force: true }); },
    definitionReads,
    dispatches: () => operations.filter((call) => call.tag === "orchestration.dispatchCommand" && call.payload.type === "message.dispatch"),
    makeSupervisor,
    projections,
    setDefinitions: (next: ProjectDefinitionSnapshot) => { currentDefinitions = next; },
    setDefinitionReadOutcomes: (outcomes: Array<ProjectDefinitionSnapshot | Error>) => { definitionReadOutcomes = [...outcomes]; },
    setDispatchFailure: (failure: "unknown" | "rejected") => { dispatchFailure = failure; },
    task: () => store.task(sourceThreadId),
    store,
  };
};

test("dispatch uses complete definitions from the operative source worktree", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();

  const task = fixture.task();
  const binding = fixture.binding();
  const dispatch = fixture.dispatches()[0]?.payload;
  assert.ok(task && binding && dispatch);
  assert.equal(task.status, "waiting");
  assert.equal(fixture.definitionReads.length, 1);
  assert.deepEqual(fixture.definitionReads[0], { projectId, threadId: sourceThreadId });
  assert.equal(dispatch.threadId, binding.threadId);
  assert.equal(task.definitionContext?.workspaceRoot, "/work/project/worktrees/feature");
  assert.equal(task.definitionContext?.revision, "revision-1");
  assert.match(String(dispatch.text), /"workspaceRoot":"\/work\/project\/worktrees\/feature"/u);
  assert.match(String(dispatch.text), /"revision":"revision-1"/u);
  assert.match(String(dispatch.text), /Add a focused regression test\./u);
  assert.match(String(dispatch.text), /The regression test passes\./u);
});

test("a correlated native result appears in the project DTO without repeating or self-triggering work", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const task = fixture.task();
  const binding = fixture.binding();
  assert.ok(task && binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  completeSupervisorRequest(native, task.messageId, workflowResponse(task.sourceMessageId));

  await supervisor.runOnce();
  const inferred = fixture.task();
  assert.equal(inferred?.status, "inferred");
  assert.equal(inferred?.objective, "Implement the export workflow");
  assert.equal(inferred?.workflow?.status, "proposed");
  assert.deepEqual(inferred?.workflow?.steps.map((step) => step.blockId), ["test-plan"]);

  const snapshot = await supervisor.snapshot(projectId, AbortSignal.timeout(1000), sourceThreadId);
  const dto = snapshot.tasks.find((candidate) => candidate.threadId === sourceThreadId);
  assert.equal(dto?.workflow?.status, "proposed");
  assert.equal(dto?.workflow?.revision, "revision-1");
  assert.deepEqual(dto?.workflow?.rules.map((rule) => [rule.index, rule.applies]), [[0, true]]);
  assert.deepEqual(dto?.workflow?.steps.map((step) => [step.blockId, step.name]), [["test-plan", "Test plan"]]);

  await supervisor.runOnce();
  assert.equal(fixture.dispatches().length, 1);
  assert.equal(fixture.definitionReads.length, 3, "preparation, completed-result revalidation and one bounded unsent-definition observation load definitions");
  assert.equal(fixture.store.task(binding.threadId), null, "the owned Supervisor conversation is not a new source task");
});

test("changed or non-ready definitions stale the workflow while preserving the inferred objective", async (t) => {
  const variants: Array<{ name: string; snapshot: ProjectDefinitionSnapshot }> = [
    { name: "revision", snapshot: definitionSnapshot({ revision: "revision-2" }) },
    { name: "worktree", snapshot: definitionSnapshot({ workspaceRoot: "/work/project/worktrees/other" }) },
    { name: "permission", snapshot: definitionSnapshot({ status: "permission_required" }) },
    { name: "invalid", snapshot: definitionSnapshot({ status: "invalid" }) },
  ];

  for (const variant of variants) {
    const fixture = await makeFixture();
    t.after(fixture.cleanup);
    const supervisor = fixture.makeSupervisor();
    await supervisor.runOnce();
    const task = fixture.task();
    const binding = fixture.binding();
    assert.ok(task && binding, variant.name);
    const native = fixture.projections.get(binding.threadId);
    assert.ok(native, variant.name);
    fixture.setDefinitions(variant.snapshot);
    completeSupervisorRequest(native, task.messageId, workflowResponse(task.sourceMessageId));

    await supervisor.runOnce();
    const completed = fixture.task();
    assert.equal(completed?.status, "inferred", variant.name);
    assert.equal(completed?.objective, "Implement the export workflow", variant.name);
    assert.equal(completed?.workflow?.status, "stale", variant.name);
    assert.deepEqual(completed?.workflow?.rules, [], variant.name);
    assert.deepEqual(completed?.workflow?.steps, [], variant.name);
    assert.equal(completed?.revalidationAttempts ?? 0, 0, variant.name);
  }
});

test("a transient preparation read failure recovers across Supervisor instances and dispatches once", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  fixture.setDefinitionReadOutcomes([new Error("temporary filesystem read failure"), definitionSnapshot()]);

  await fixture.makeSupervisor().runOnce();
  const queued = fixture.task();
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.definitionReadAttempts, 1);
  assert.equal(fixture.dispatches().length, 0);

  await fixture.makeSupervisor().runOnce();
  const waiting = fixture.task();
  assert.equal(waiting?.status, "waiting");
  assert.equal(waiting?.definitionReadAttempts, 1);
  assert.equal(waiting?.definitionContext?.revision, "revision-1");
  assert.equal(fixture.dispatches().length, 1);
  assert.match(String(fixture.dispatches()[0]?.payload.text), /UNTRUSTED_WORKFLOW_ENVELOPE/u);

  await fixture.makeSupervisor().runOnce();
  assert.equal(fixture.definitionReads.length, 2);
  assert.equal(fixture.dispatches().length, 1, "preparation retry must not create duplicate native requests");
});

test("three unavailable preparation reads fall back to objective-only work and release the queue", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  fixture.setDefinitionReadOutcomes([
    definitionSnapshot({ status: "unavailable" }),
    new Error("second temporary read failure"),
    definitionSnapshot({ status: "unavailable" }),
  ]);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fixture.makeSupervisor().runOnce();
    const task = fixture.task();
    assert.equal(task?.definitionReadAttempts, attempt);
    if (attempt < 3) {
      assert.equal(task?.status, "queued");
      assert.equal(fixture.dispatches().length, 0);
    }
  }

  const dispatched = fixture.task();
  const request = fixture.dispatches()[0]?.payload.text;
  assert.equal(dispatched?.status, "waiting");
  assert.equal(dispatched?.workflow?.status, "unavailable");
  assert.match(dispatched?.workflow?.message ?? "", /Workflow proposal unavailable/u);
  assert.equal(dispatched?.definitionContext, null);
  assert.doesNotMatch(String(request), /UNTRUSTED_WORKFLOW_ENVELOPE/u);
  assert.match(String(request), /UNTRUSTED_INPUT_ENVELOPE/u);
  assert.equal(fixture.dispatches().length, 1);

  const binding = fixture.binding();
  assert.ok(binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  assert.equal(fixture.store.tasks(projectId).filter((task) => task.status === "queued").length, 0);
  completeSupervisorRequest(native, dispatched!.messageId, objectiveResponse(dispatched!.sourceMessageId));
  await fixture.makeSupervisor().runOnce();
  assert.equal(fixture.task()?.status, "inferred");
  assert.equal(fixture.dispatches().length, 1);
});

test("transient completion revalidation recovers and accepts the completed response without redispatch", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  await fixture.makeSupervisor().runOnce();
  const task = fixture.task();
  const binding = fixture.binding();
  assert.ok(task && binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  completeSupervisorRequest(native, task.messageId, workflowResponse(task.sourceMessageId));
  fixture.setDefinitionReadOutcomes([definitionSnapshot({ status: "unavailable" }), definitionSnapshot()]);

  await fixture.makeSupervisor().runOnce();
  const pendingRevalidation = fixture.task();
  assert.equal(pendingRevalidation?.status, "waiting");
  assert.equal(pendingRevalidation?.objective, null);
  assert.equal(pendingRevalidation?.revalidationAttempts, 1);
  assert.equal(pendingRevalidation?.workflow?.status, "pending");
  assert.equal(fixture.dispatches().length, 1);

  await fixture.makeSupervisor().runOnce();
  const accepted = fixture.task();
  assert.equal(accepted?.status, "inferred");
  assert.equal(accepted?.objective, "Implement the export workflow");
  assert.equal(accepted?.revalidationAttempts, 1);
  assert.equal(accepted?.workflow?.status, "proposed");
  assert.equal(fixture.dispatches().length, 1, "revalidation retries inspect the original completed native run");
  assert.equal(fixture.definitionReads.length, 4, "includes one bounded unsent-definition observation after acceptance");
});

test("three transient completion read failures stale only the proposal and preserve the objective", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  await fixture.makeSupervisor().runOnce();
  const task = fixture.task();
  const binding = fixture.binding();
  assert.ok(task && binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  completeSupervisorRequest(native, task.messageId, workflowResponse(task.sourceMessageId));
  fixture.setDefinitionReadOutcomes([
    new Error("first revalidation failure"),
    definitionSnapshot({ status: "unavailable" }),
    new Error("third revalidation failure"),
  ]);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fixture.makeSupervisor().runOnce();
    const current = fixture.task();
    assert.equal(current?.revalidationAttempts, attempt);
    if (attempt < 3) {
      assert.equal(current?.status, "waiting");
      assert.equal(current?.objective, null);
      assert.equal(current?.workflow?.status, "pending");
    }
  }

  const stale = fixture.task();
  assert.equal(stale?.status, "inferred");
  assert.equal(stale?.objective, "Implement the export workflow");
  assert.equal(stale?.workflow?.status, "stale");
  assert.deepEqual(stale?.workflow?.rules, []);
  assert.deepEqual(stale?.workflow?.steps, []);
  assert.match(stale?.workflow?.message ?? "", /could not be revalidated/u);
  assert.equal(fixture.dispatches().length, 1);
  assert.equal(fixture.definitionReads.length, 5, "the separate unsent-definition observation does not change the three-attempt budget");
});

test("interrupted and definitively rejected requests clear pending workflow proposals", async (t) => {
  const interruptedFixture = await makeFixture();
  t.after(interruptedFixture.cleanup);
  const interruptedSupervisor = interruptedFixture.makeSupervisor();
  await interruptedSupervisor.runOnce();
  const interruptedTask = interruptedFixture.task();
  const interruptedBinding = interruptedFixture.binding();
  assert.ok(interruptedTask && interruptedBinding);
  const interruptedNative = interruptedFixture.projections.get(interruptedBinding.threadId);
  assert.ok(interruptedNative);
  const interruptedRun = interruptedNative.runs.find((run) => run.userMessageId === interruptedTask.messageId);
  assert.ok(interruptedRun);
  interruptedRun.status = "interrupted";

  await interruptedSupervisor.runOnce();
  const interrupted = interruptedFixture.task();
  assert.equal(interrupted?.status, "unavailable");
  assert.equal(interrupted?.workflow?.status, "unavailable");
  assert.deepEqual(interrupted?.workflow?.steps, []);
  assert.deepEqual(interrupted?.workflow?.rules, []);

  const rejectedFixture = await makeFixture();
  t.after(rejectedFixture.cleanup);
  rejectedFixture.setDispatchFailure("rejected");
  await rejectedFixture.makeSupervisor().runOnce();
  const rejected = rejectedFixture.task();
  assert.equal(rejected?.status, "unavailable");
  assert.equal(rejected?.workflow?.status, "unavailable");
  assert.deepEqual(rejected?.workflow?.steps, []);
  assert.deepEqual(rejected?.workflow?.rules, []);
  assert.match(rejected?.workflow?.message ?? "", /definitively rejected/u);
});

test("unknown dispatch retry reuses the persisted request and definition context", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  fixture.setDispatchFailure("unknown");
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const uncertain = fixture.task();
  const binding = fixture.binding();
  assert.ok(uncertain && binding);
  assert.equal(uncertain.status, "uncertain");
  const originalText = fixture.dispatches()[0]?.payload.text;
  const originalContext = uncertain.definitionContext;
  assert.ok(originalText && originalContext);

  fixture.setDefinitions(definitionSnapshot({ revision: "mutated-revision", workspaceRoot: "/work/project/worktrees/mutated" }));
  const retry = await supervisor.retry({
    projectId,
    mainThreadId: binding.mainThreadId,
    expectedGeneration: 0,
    threadId: binding.threadId,
    bindingGeneration: binding.generation,
    action: "retry",
  }, AbortSignal.timeout(1000));

  const dispatches = fixture.dispatches();
  assert.equal(retry.status, "saved");
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[1]?.payload.text, originalText);
  assert.equal(dispatches[1]?.payload.messageId, dispatches[0]?.payload.messageId);
  assert.equal(dispatches[1]?.payload.commandId, dispatches[0]?.payload.commandId);
  assert.deepEqual(fixture.task()?.definitionContext, originalContext);
  assert.equal(fixture.definitionReads.length, 1, "retry must not reread mutated project definitions");
});

test("legacy in-flight and completed objective-only records are not backfilled", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const legacySupervisor = fixture.makeSupervisor(false);
  await legacySupervisor.runOnce();
  const legacyTask = fixture.task();
  const binding = fixture.binding();
  assert.ok(legacyTask && binding);
  assert.equal(legacyTask.status, "waiting");
  assert.equal(legacyTask.definitionContext, undefined);
  assert.equal(legacyTask.workflow, undefined);

  const definitionsEnabledSupervisor = fixture.makeSupervisor();
  await definitionsEnabledSupervisor.runOnce();
  assert.equal(fixture.definitionReads.length, 0, "the persisted in-flight request is not prepared again");
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  completeSupervisorRequest(native, legacyTask.messageId, objectiveResponse(legacyTask.sourceMessageId));
  await definitionsEnabledSupervisor.runOnce();

  const completed = fixture.task();
  assert.equal(completed?.status, "inferred");
  assert.equal(completed?.objective, "Implement the export workflow");
  assert.equal(completed?.workflow, null);
  await definitionsEnabledSupervisor.runOnce();
  assert.equal(fixture.definitionReads.length, 0, "a completed objective-only record remains unchanged");
  assert.equal(fixture.dispatches().length, 1);
});
