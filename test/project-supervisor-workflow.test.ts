import assert from "node:assert/strict";
import { it } from "vitest";
import { after } from "./support/node-test.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { projectSupervisorUnit } from "./support/team-units.js";
import type { ProjectDefinitionLoader } from "./support/root-facades.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import type { SupervisorModelSelection } from "../src/project-supervisor-contract.js";
import type { WorkflowIntroduction } from "../src/supervisor-conversation-store.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { T3TransportError } from "../src/t3.js";
import type { MessageInfo, ProjectInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "../src/types.js";
import { effectiveIndex, indexSource, projectIndex, stepSource, testSummary } from "./project-definitions-fixture.js";
import { openGuidance, openSupervisors, serviceOf } from "./support/store-units.js";
import { interpretationSubmitter, submissionArguments, turnItemAnswer } from "./support/interpretation-submit.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";

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
  globalOnly: false,
  globalRevision: null,
  editingAvailable: true,
  status: "ready",
  steps: [{id: "test-plan", name: "Test plan", description: "Verify behavior.", summary: testSummary("test-plan"), origin: "project", path: ".t3-supervisor/steps/test-plan.md", sourceId: "test-plan"}],
  workflows: [],
  config: effectiveIndex({steps: [{id: "test-plan"}], workflows: []}, [{step: "test-plan"}]),
  projectConfig: projectIndex({steps: ["test-plan"], required: [{step: "test-plan"}]}),
  definitionFiles: [],
  complete: true,
  sources: [
    {path: ".t3-supervisor/project.yaml", content: indexSource({steps: ["test-plan"], required: [{step: "test-plan"}]}), origin: "project"},
    {path: ".t3-supervisor/steps/test-plan.md", content: stepSource("test-plan", "Verify behavior."), origin: "project"},
  ],
  issues: [],
  ...overrides,
});

const unavailableDefinitionSnapshot = (): ProjectDefinitionSnapshot => ({...definitionSnapshot(),
  workspaceRoot: "/work/project/worktrees/feature", revision: null, editingAvailable: false, status: "unavailable",
  steps: [], workflows: [], config: {workflows: [], steps: []}, projectConfig: null, definitionFiles: [], complete: false, sources: [],
  issues: [{path: ".t3-supervisor", code: "definition_read_failed",
    message: "Definition sources could not be read. Requirements and policy remain unknown; make a finite provisional plan."}],
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

// the interpretation fields a root submits for the export task
const workflowFields = (messageId: string): Record<string, unknown> => ({
  objective: "Implement the export workflow",
  reason: "The source conversation requests an export implementation.",
  sourceMessageIds: [messageId],
  supervision: "needed",
  workflow: {
    requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The change needs a focused behavior check."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "test-plan", reason: "Verify the export behavior with a regression test."}]},
  },
});

const objectiveResponse = (messageId: string): string => JSON.stringify({
  objective: "Implement the export workflow",
  reason: "The source conversation requests an export implementation.",
  sourceMessageIds: [messageId],
});

const provisionalWorkflowFields = (messageId: string): Record<string, unknown> => ({
  objective: "Implement the export workflow",
  reason: "The source conversation requests an export implementation.",
  sourceMessageIds: [messageId],
  supervision: "needed",
  workflow: {
    requirements: [],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "bounded-review", name: "Review available context",
      description: "State what remains unknown while making a finite plan.", reason: "The definition read is unavailable."}]},
  },
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
  // runs when the models read has its answer, before the caller receives it
  let modelsRead: (() => void) | null = null;
  const guidance = await openGuidance(directory);
  const ownedIds = new Set<string>();
  const store = await openSupervisors(guidance, ownedIds);
  await guidance.db.prepare("INSERT INTO meta VALUES(?,?)").run(`supervisor_control:${JSON.stringify(source.thread.projectId)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const config: SupervisorConfig = {
    dataDirectory: directory,
    t3Url: "http://unused",
    t3TokenFile: "unused",
    excludedThreadIds: [],
    healthPort: 0,
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
  const readRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (tag === "server.getConfig") {modelsRead?.();return modelConfig;}
    const item = turnItemAnswer(projections, tag, payload);
    if (item) return item;
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
  const makeSupervisor = (withDefinitions = true) => projectSupervisorUnit(
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
    binding: async () => await store.binding(projectId, sourceThreadId),
    cleanup: async () => { await guidance.close(); await rm(directory, { recursive: true, force: true }); },
    definitionReads,
    dispatches: () => operations.filter((call) => call.tag === "orchestration.dispatchCommand" && call.payload.type === "message.dispatch"),
    makeSupervisor,
    projections,
    setDefinitions: (next: ProjectDefinitionSnapshot) => { currentDefinitions = next; },
    setDefinitionReadOutcomes: (outcomes: Array<ProjectDefinitionSnapshot | Error>) => { definitionReadOutcomes = [...outcomes]; },
    setDispatchFailure: (failure: "unknown" | "rejected") => { dispatchFailure = failure; },
    onModelsRead: (hook: (() => void) | null) => { modelsRead = hook; },
    task: async () => await store.task(sourceThreadId),
    store,
  };
};

type WorkflowFixture = Awaited<ReturnType<typeof makeFixture>>;
// the root's typed submission (its executed tool item in the request run, through the write controller) and the run's completion with
// a final chat answer in prose, which neither the interpretation nor its proposal evidence reads
const submitAndComplete = async (fixture: WorkflowFixture, supervisor: {workflowStates: Parameters<typeof interpretationSubmitter>[0]["workflows"]} | null,
  task: TaskRecord, fields: Record<string, unknown>) => {
  const workflows = (supervisor ?? fixture.makeSupervisor()).workflowStates;
  const submitted = await interpretationSubmitter({supervisors: fixture.store, workflows, projections: fixture.projections})
    .submit(task, submissionArguments(task, fields));
  assert.equal(submitted.status, "submitted", JSON.stringify(submitted));
  completeSupervisorRequest(fixture.projections.get(task.supervisorThreadId)!, task.messageId, "I submitted the interpretation through the tool.");
};

it("dispatch uses complete definitions from the operative source worktree", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();

  const task = await fixture.task();
  const binding = await fixture.binding();
  const dispatch = fixture.dispatches()[0]?.payload;
  assert.ok(task && binding && dispatch);
  assert.equal(task.status, "waiting");
  assert.equal(fixture.definitionReads.length, 1);
  assert.deepEqual(fixture.definitionReads[0], { projectId, threadId: sourceThreadId });
  assert.equal(dispatch.threadId, binding.threadId);
  assert.equal(task.definitionContext?.workspaceRoot, "/work/project/worktrees/feature");
  assert.equal(task.definitionContext?.revision, "revision-1");
  const definitions = await supervisor.conversation.readContextView(binding, {view: "definitions"}, AbortSignal.timeout(5000));
  const material = JSON.stringify(definitions);
  assert.match(material, /"workspaceRoot":"\/work\/project\/worktrees\/feature"/u);
  assert.match(material, /"revision":"revision-1"/u);
  assert.ok(material.includes(`"summary":${JSON.stringify(testSummary("test-plan"))}`));
  assert.doesNotMatch(String(dispatch.text), /"workspaceRoot":|"required":|"summary":/u, "the complete source-bound catalog stays pull-only");

});

it("a correlated native result appears in the project DTO without repeating or self-triggering work", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const task = await fixture.task();
  const binding = await fixture.binding();
  assert.ok(task && binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  await submitAndComplete(fixture, supervisor, task, workflowFields(task.sourceMessageId));

  await supervisor.runOnce();
  const inferred = await fixture.task();
  assert.equal(inferred?.status, "inferred");
  assert.equal(inferred?.objective, "Implement the export workflow");
  assert.equal(inferred?.workflow?.status, "proposed");
  assert.equal(inferred?.workflow?.requirements[0]?.state, "included");
  assert.equal(inferred?.workflow?.plan?.nodes[0]?.kind, "step");
  if (inferred?.workflow?.plan?.nodes[0]?.kind === "step") assert.equal(inferred.workflow.plan.nodes[0].definitionId, "test-plan");

  const snapshot = await supervisor.snapshot(projectId, AbortSignal.timeout(1000), sourceThreadId);
  const dto = snapshot.tasks.find((candidate) => candidate.threadId === sourceThreadId);
  assert.equal(dto?.workflow?.status, "proposed");
  assert.equal(dto?.workflow?.revision, "revision-1");
  assert.deepEqual(dto?.workflow?.requirements.map(item => [item.kind, item.id, item.state]), [["step", "test-plan", "included"]]);
  assert.equal(dto?.workflow?.plan?.nodes[0]?.kind, "step");

  await supervisor.runOnce();
  assert.equal(fixture.dispatches().length, 1);
  // the proposal is handled in its interpretation's completion cycle, so no unsent proposal waits for a separate definition observation
  assert.ok(await supervisor.conversation.requests.introduction((await fixture.task())!.id), "the proposal was handled in its completion cycle");
  assert.equal(fixture.definitionReads.length, 2, "only preparation and completed-result revalidation load definitions");
  assert.equal(await fixture.store.task(binding.threadId), null, "the owned Supervisor conversation is not a new source task");
});

it("changed or non-ready definitions stale the workflow while preserving the inferred objective", { timeout: 60_000 }, async (t) => {
  const variants: Array<{ name: string; snapshot: ProjectDefinitionSnapshot }> = [
    { name: "revision", snapshot: definitionSnapshot({ revision: "revision-2" }) },
    { name: "worktree", snapshot: definitionSnapshot({ workspaceRoot: "/work/project/worktrees/other" }) },
    { name: "permission", snapshot: definitionSnapshot({ status: "permission_required" }) },
    { name: "invalid", snapshot: definitionSnapshot({ status: "invalid" }) },
  ];

  for (const variant of variants) {
    const fixture = await makeFixture();
    after(t, fixture.cleanup);
    const supervisor = fixture.makeSupervisor();
    await supervisor.runOnce();
    const task = await fixture.task();
    const binding = await fixture.binding();
    assert.ok(task && binding, variant.name);
    const native = fixture.projections.get(binding.threadId);
    assert.ok(native, variant.name);
    fixture.setDefinitions(variant.snapshot);
    await submitAndComplete(fixture, supervisor, task, workflowFields(task.sourceMessageId));

    await supervisor.runOnce();
    const completed = await fixture.task();
    assert.equal(completed?.status, "inferred", variant.name);
    assert.equal(completed?.objective, "Implement the export workflow", variant.name);
    assert.equal(completed?.workflow?.status, "stale", variant.name);
    assert.ok(completed?.workflow?.plan?.nodes.length, variant.name);
    assert.equal(completed?.revalidationAttempts ?? 0, 0, variant.name);
  }
});

it("a transient preparation read failure recovers across Supervisor instances and dispatches once", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  fixture.setDefinitionReadOutcomes([new Error("temporary filesystem read failure"), definitionSnapshot()]);

  await fixture.makeSupervisor().runOnce();
  const queued = await fixture.task();
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.definitionReadAttempts, 1);
  assert.equal(fixture.dispatches().length, 0);

  await fixture.makeSupervisor().runOnce();
  const waiting = await fixture.task();
  assert.equal(waiting?.status, "waiting");
  assert.equal(waiting?.definitionReadAttempts, 1);
  assert.equal(waiting?.definitionContext?.revision, "revision-1");
  assert.equal(fixture.dispatches().length, 1);
  assert.match(String(fixture.dispatches()[0]?.payload.text), /UNTRUSTED_WORKFLOW_ENVELOPE/u);

  await fixture.makeSupervisor().runOnce();
  assert.equal(fixture.definitionReads.length, 2);
  assert.equal(fixture.dispatches().length, 1, "preparation retry must not create duplicate native requests");
});

it("bounded unavailable preparation reads still dispatch a provisional workflow with unknown requirements", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  fixture.setDefinitionReadOutcomes([
    unavailableDefinitionSnapshot(),
    new Error("second temporary read failure"),
    unavailableDefinitionSnapshot(),
  ]);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fixture.makeSupervisor().runOnce();
    const task = await fixture.task();
    assert.equal(task?.definitionReadAttempts, attempt);
    if (attempt < 3) {
      assert.equal(task?.status, "queued");
      assert.equal(fixture.dispatches().length, 0);
    }
  }

  const dispatched = await fixture.task();
  const request = fixture.dispatches()[0]?.payload.text;
  assert.equal(dispatched?.status, "waiting");
  assert.equal(dispatched?.workflow?.status, "pending");
  assert.equal(dispatched?.workflow?.definitionsStatus, "unavailable");
  assert.equal(dispatched?.workflow?.definitionsComplete, false);
  assert.equal(dispatched?.workflow?.requirementsKnown, false);
  assert.equal(dispatched?.definitionContext?.revision, null);
  assert.match(String(request), /UNTRUSTED_WORKFLOW_ENVELOPE/u);
  assert.doesNotMatch(String(request), /"requirementsKnown"/u, "unknown definition details stay in the source-bound reader");
  assert.equal(fixture.dispatches().length, 1);

  const binding = await fixture.binding();
  assert.ok(binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  assert.equal((await fixture.store.tasks(projectId)).filter((task) => task.status === "queued").length, 0);
  await submitAndComplete(fixture, null, dispatched!, provisionalWorkflowFields(dispatched!.sourceMessageId));
  await fixture.makeSupervisor().runOnce();
  assert.equal((await fixture.task())?.status, "inferred");
  assert.equal((await fixture.task())?.workflow?.status, "stale");
  assert.equal((await fixture.task())?.workflow?.requirementsKnown, false);
  assert.ok((await fixture.task())?.workflow?.plan?.nodes.length);
  assert.equal(fixture.dispatches().length, 1);
});

it("a known unavailable completion read stales the proposal without redispatch", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  await fixture.makeSupervisor().runOnce();
  const task = await fixture.task();
  const binding = await fixture.binding();
  assert.ok(task && binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  await submitAndComplete(fixture, null, task, workflowFields(task.sourceMessageId));
  fixture.setDefinitionReadOutcomes([unavailableDefinitionSnapshot()]);

  await fixture.makeSupervisor().runOnce();
  const stale = await fixture.task();
  assert.equal(stale?.status, "inferred");
  assert.equal(stale?.objective, "Implement the export workflow");
  assert.equal(stale?.revalidationAttempts ?? 0, 0);
  assert.equal(stale?.workflow?.status, "stale");
  assert.ok(stale?.workflow?.plan?.nodes.length);
  assert.equal(fixture.dispatches().length, 1);
  assert.ok(await fixture.makeSupervisor().conversation.requests.introduction((await fixture.task())!.id), "the stale proposal was handled in its completion cycle");
  assert.equal(fixture.definitionReads.length, 2, "only preparation and completion revalidation read definitions");
});

it("three transient completion read failures stale only the proposal and preserve the objective", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  await fixture.makeSupervisor().runOnce();
  const task = await fixture.task();
  const binding = await fixture.binding();
  assert.ok(task && binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  await submitAndComplete(fixture, null, task, workflowFields(task.sourceMessageId));
  fixture.setDefinitionReadOutcomes([
    new Error("first revalidation failure"),
    new Error("second revalidation failure"),
    new Error("third revalidation failure"),
  ]);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fixture.makeSupervisor().runOnce();
    const current = await fixture.task();
    assert.equal(current?.revalidationAttempts, attempt);
    if (attempt < 3) {
      assert.equal(current?.status, "waiting");
      assert.equal(current?.objective, null);
      assert.equal(current?.workflow?.status, "pending");
    }
  }

  const stale = await fixture.task();
  assert.equal(stale?.status, "inferred");
  assert.equal(stale?.objective, "Implement the export workflow");
  assert.equal(stale?.workflow?.status, "stale");
  assert.ok(stale?.workflow?.plan?.nodes.length);
  assert.match(stale?.workflow?.message ?? "", /could not be revalidated/u);
  assert.equal(fixture.dispatches().length, 1);
  assert.ok(await fixture.makeSupervisor().conversation.requests.introduction((await fixture.task())!.id), "the stale proposal was handled in its completion cycle");
  assert.equal(fixture.definitionReads.length, 4, "preparation plus exactly the three bounded revalidation attempts read definitions");
});

it("interrupted and definitively rejected requests clear pending workflow proposals", { timeout: 60_000 }, async (t) => {
  const interruptedFixture = await makeFixture();
  after(t, interruptedFixture.cleanup);
  const interruptedSupervisor = interruptedFixture.makeSupervisor();
  await interruptedSupervisor.runOnce();
  const interruptedTask = await interruptedFixture.task();
  const interruptedBinding = await interruptedFixture.binding();
  assert.ok(interruptedTask && interruptedBinding);
  const interruptedNative = interruptedFixture.projections.get(interruptedBinding.threadId);
  assert.ok(interruptedNative);
  const interruptedRun = interruptedNative.runs.find((run) => run.userMessageId === interruptedTask.messageId);
  assert.ok(interruptedRun);
  interruptedRun.status = "interrupted";

  await interruptedSupervisor.runOnce();
  const interrupted = await interruptedFixture.task();
  assert.equal(interrupted?.status, "unavailable");
  assert.equal(interrupted?.workflow?.status, "unavailable");
  assert.equal(interrupted?.workflow?.plan, null);

  const rejectedFixture = await makeFixture();
  after(t, rejectedFixture.cleanup);
  rejectedFixture.setDispatchFailure("rejected");
  await rejectedFixture.makeSupervisor().runOnce();
  const rejected = await rejectedFixture.task();
  assert.equal(rejected?.status, "unavailable");
  assert.equal(rejected?.workflow?.status, "unavailable");
  assert.equal(rejected?.workflow?.plan, null);
  assert.match(rejected?.workflow?.message ?? "", /definitively rejected/u);
});

it("unknown dispatch retry reuses the persisted request and definition context", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  fixture.setDispatchFailure("unknown");
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const uncertain = await fixture.task();
  const binding = await fixture.binding();
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
  assert.deepEqual((await fixture.task())?.definitionContext, originalContext);
  assert.equal(fixture.definitionReads.length, 1, "retry must not reread mutated project definitions");
});

it("persisted objective-only records are not backfilled or replayed", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  await fixture.makeSupervisor(false).runOnce();
  const queued = await fixture.task();
  const binding = await fixture.binding();
  assert.ok(queued && binding);
  const legacyText = "Interpret this previously persisted objective-only task.";
  const legacyTask = {...queued, status: "waiting" as const, requestText: legacyText, dispatchedAt: Date.now()};
  await fixture.store.saveTask(legacyTask);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  addSupervisorRequest(native, {threadId: binding.threadId, messageId: legacyTask.messageId, text: legacyText});
  assert.equal(legacyTask.status, "waiting");
  assert.equal(legacyTask.definitionContext, undefined);
  assert.equal(legacyTask.workflow, undefined);

  const definitionsEnabledSupervisor = fixture.makeSupervisor();
  await definitionsEnabledSupervisor.runOnce();
  assert.equal(fixture.definitionReads.length, 0, "the persisted in-flight request is not prepared again");
  // an in-flight record without a typed attempt has no recorded submission: its final chat answer is never applied (typed
  // protocol; the old final-chat parser applied it as inferred)
  completeSupervisorRequest(native, legacyTask.messageId, objectiveResponse(legacyTask.sourceMessageId));
  await definitionsEnabledSupervisor.runOnce();

  const completed = await fixture.task();
  assert.equal(completed?.status, "unavailable");
  assert.equal(completed?.reason, "The Supervisor did not submit a valid, source-linked interpretation.");
  assert.equal(completed?.objective, null);
  assert.equal(completed?.workflow, null);
  await definitionsEnabledSupervisor.runOnce();
  assert.equal(fixture.definitionReads.length, 0, "a completed objective-only record remains unchanged");
  assert.equal(native.runs.length, 1, "reconciliation does not replay the prior native request");
  assert.equal(fixture.dispatches().length, 0, "the synthetic historical request is not dispatched again");
});

const appendSourceMessage = (projection: Projection, id: string, ordinal: number, text: string): void => {
  const runId = `${id}-run`;
  const rootId = `${id}-root`;
  projection.runs.push({id: runId, threadId: sourceThreadId, ordinal, status: "completed", requestedAt: baseTime, startedAt: baseTime, completedAt: baseTime,
    rootNodeId: rootId, userMessageId: id, providerThreadId: `${id}-provider`});
  projection.messages.push({id, threadId: sourceThreadId, runId, nodeId: rootId, role: "user", text, streaming: false, createdAt: baseTime, updatedAt: baseTime,
    createdBy: "user", creationSource: "web"});
  (projection.nodes as Array<Record<string, unknown>>).push({id: rootId, threadId: sourceThreadId, runId, parentNodeId: null, rootNodeId: rootId,
    kind: "root_turn", status: "completed", providerThreadId: `${id}-provider`});
};

it("a link-only request stays context for the next genuine request instead of being replaced by a bootstrap instruction", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const source = fixture.projections.get(sourceThreadId)!;
  source.messages[0]!.text = "https://issues.example/browse/PROJ-1";
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = (await fixture.task())!;
  await submitAndComplete(fixture, supervisor, first, {objective: null, reason: "Only an issue link was supplied.", sourceMessageIds: [],
    supervision: "needed", workflow: null});
  await supervisor.runOnce();
  assert.equal((await fixture.task())?.status, "needs_context");

  appendSourceMessage(source, "bootstrap-message", 2, "Recover the failed worktree manually with Nix, then continue.");
  await supervisor.runOnce();
  const second = (await fixture.task())!;
  assert.equal(second.sourceMessageId, "bootstrap-message");
  assert.deepEqual(second.contextMessageIds, [sourceMessageId], "the unresolved link stays part of the task");
  const dispatched = String(fixture.dispatches().at(-1)?.payload.text);
  assert.ok(dispatched.includes(JSON.stringify([{messageId: sourceMessageId, text: "https://issues.example/browse/PROJ-1"}])),
    "the interpretation sees the original request beside the bootstrap instruction");
  assert.match(dispatched, /Earlier unresolved requests remain part of the task/u);
});

it("a semantic not-needed decision is persisted without negotiation and the next genuine request is reconsidered", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const source = fixture.projections.get(sourceThreadId)!;
  source.messages[0]!.text = "Thank the colleague for the documents and ask for the missing one.";
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = (await fixture.task())!;
  await submitAndComplete(fixture, supervisor, first, {objective: "Thank the colleague and ask for the missing document",
    reason: "A short self-contained message with no workflow obligations.", sourceMessageIds: [sourceMessageId], supervision: "not_needed", workflow: null});
  await supervisor.runOnce();
  const decided = (await fixture.task())!;
  assert.equal(decided.status, "not_supervised");
  assert.equal(decided.objective, "Thank the colleague and ask for the missing document");
  assert.equal(decided.workflow?.plan ?? null, null);
  await supervisor.runOnce();
  assert.equal(fixture.dispatches().length, 1, "a not-needed task gets no initialization, introduction or negotiation");

  appendSourceMessage(source, "substantive-message", 2, "Now implement the export retry policy in the service.");
  await supervisor.runOnce();
  const next = (await fixture.task())!;
  assert.equal(next.sourceMessageId, "substantive-message");
  assert.equal(next.contextMessageIds, undefined, "an answered not-needed request is complete and never carried into the next task as unresolved");
  assert.equal(fixture.dispatches().length, 2, "a later genuine request is interpreted again in the same Supervisor conversation");
  assert.equal(fixture.dispatches().at(-1)?.payload.threadId, (await fixture.binding())!.threadId);
});

it("after an explicit Enable only a request written after it is interpreted", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const source = fixture.projections.get(sourceThreadId)!;
  source.messages[0]!.text = "Thank the colleague for the documents and ask for the missing one.";
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = (await fixture.task())!;
  await submitAndComplete(fixture, supervisor, first, {objective: "Thank the colleague and ask for the missing document",
    reason: "A short self-contained message with no workflow obligations.", sourceMessageIds: [sourceMessageId], supervision: "not_needed", workflow: null});
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.status, "not_supervised");
  // a request the human wrote while supervision was stopped, then an explicit Enable
  appendSourceMessage(source, "stopped-period-request", 2, "Now implement the export retry policy in the service.");
  const written = Date.parse(source.messages.at(-1)!.createdAt);
  await supervisor.store.recordChatEnable(sourceThreadId, written + 1_000);
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.sourceMessageId, sourceMessageId, "the stopped-period request is not the next request");
  assert.equal(fixture.dispatches().length, 1);
  appendSourceMessage(source, "after-enable-request", 3, "Also add a retry test.");
  source.messages.at(-1)!.createdAt = new Date(written + 2_000).toISOString();
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.sourceMessageId, "after-enable-request");
  assert.equal(fixture.dispatches().length, 2);
});

it("a request queued or sent before an explicit Enable is never interpreted after it", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const source = fixture.projections.get(sourceThreadId)!;
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = (await fixture.task())!;
  const dispatched = fixture.dispatches().length;
  // the stop put an undispatched interpretation back in the queue; the human then enabled supervision again
  const store = supervisor.store;
  await store.saveTask({...first, status: "queued", dispatchedAt: null, messageId: `${first.messageId}-requeued`, reason: "Supervision was stopped for this chat before dispatch; this task identity remains unsent."});
  await store.recordChatEnable(sourceThreadId, Date.parse(source.messages[0]!.createdAt) + 1_000);
  const native = fixture.projections.get((await fixture.binding())!.threadId)!;
  for (const run of native.runs) run.status = "completed";
  native.thread.activeRunId = null;
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.status, "expired");
  assert.equal(fixture.dispatches().length, dispatched, "nothing is dispatched for the request written before the Enable");
  // an interpretation sent before the Enable whose exact native run has ended is closed unapplied, never applied or resent
  await store.saveTask({...first, status: "waiting", dispatchedAt: Date.parse(source.messages[0]!.createdAt), replayCount: 0});
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.status, "expired");
  assert.equal((await fixture.task())!.objective, null);
  assert.equal(fixture.dispatches().length, dispatched, "a pre-Enable interpretation is never resent");
});

it("an interpretation sent before an explicit Enable with no native outcome keeps its identity and is never closed, replayed or applied", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const source = fixture.projections.get(sourceThreadId)!;
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = (await fixture.task())!;
  const dispatched = fixture.dispatches().length;
  const store = supervisor.store;
  await store.recordChatEnable(sourceThreadId, Date.parse(source.messages[0]!.createdAt) + 1_000);
  const native = fixture.projections.get((await fixture.binding())!.threadId)!;
  for (const run of native.runs) run.status = "completed";
  native.thread.activeRunId = null;
  // absence of a native run is not proof of non-delivery, whether or not the identity carries its dispatch time
  for (const [suffix, dispatchedAt] of [["lost", Date.parse(source.messages[0]!.createdAt)], ["undated", null]] as const) {
    const held = {...first, status: "uncertain" as const, messageId: `${first.messageId}-${suffix}`, dispatchedAt, replayCount: 0};
    await store.saveTask(held);
    for (let cycle = 0; cycle < 3; cycle++) await supervisor.runOnce();
    assert.equal((await fixture.task())!.status, "uncertain", suffix);
    assert.equal((await fixture.task())!.messageId, held.messageId, suffix);
    assert.equal(fixture.dispatches().length, dispatched, `${suffix}: nothing is resent`);
  }
  // a native message with this identity but other request text is not its outcome
  await store.saveTask({...first, status: "waiting", requestText: `${first.requestText} (changed)`, dispatchedAt: null, replayCount: 0});
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.status, "waiting");
  assert.equal(fixture.dispatches().length, dispatched);
});

it("an interpretation in flight across a project re-enable boundary at its source is never applied or resent", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = (await fixture.task())!;
  const dispatched = fixture.dispatches().length;
  const store = supervisor.store;
  // the project was disabled and enabled again with its boundary at the request's own run while the interpretation was in flight
  await store.saveControl(projectId, (await store.control(projectId)).generation, false);
  await store.saveControl(projectId, (await store.control(projectId)).generation, true, {snapshotSequence: 11, threads: [{id: sourceThreadId, latestRunId: first.sourceRunId}]});
  const native = fixture.projections.get((await fixture.binding())!.threadId)!;
  for (const run of native.runs) run.status = "completed";
  native.thread.activeRunId = null;
  // an identity with no native outcome stays held and is never resent
  await store.saveTask({...first, status: "uncertain", messageId: `${first.messageId}-lost`, replayCount: 0});
  for (let cycle = 0; cycle < 3; cycle++) await supervisor.runOnce();
  assert.equal((await fixture.task())!.status, "uncertain");
  assert.equal((await fixture.task())!.messageId, `${first.messageId}-lost`);
  assert.equal(fixture.dispatches().length, dispatched, "nothing is resent across the boundary");
  // its exact native run has ended: it closes unapplied
  await store.saveTask({...first, status: "waiting", replayCount: 0});
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.status, "expired");
  assert.equal((await fixture.task())!.objective, null);
  assert.equal(fixture.dispatches().length, dispatched);
});

it("a queued request at or before the project activation boundary is never interpreted", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = (await fixture.task())!;
  const dispatched = fixture.dispatches().length;
  const store = supervisor.store;
  await store.saveTask({...first, status: "queued", dispatchedAt: null, messageId: `${first.messageId}-requeued`, reason: "Supervision was disabled before dispatch; this task identity remains queued."});
  // the project was disabled and enabled again with its boundary at the request's own run
  await store.saveControl(projectId, (await store.control(projectId)).generation, false);
  await store.saveControl(projectId, (await store.control(projectId)).generation, true, {snapshotSequence: 11, threads: [{id: sourceThreadId, latestRunId: first.sourceRunId}]});
  const native = fixture.projections.get((await fixture.binding())!.threadId)!;
  for (const run of native.runs) run.status = "completed";
  native.thread.activeRunId = null;
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.status, "expired");
  assert.equal(fixture.dispatches().length, dispatched, "nothing is dispatched for a request before the boundary");
});

it("the interpretation request carries the concise standing role once, permits reader discovery wrappers and decides relevance before definitions", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const task = (await fixture.task())!;
  const text = String(fixture.dispatches()[0]?.payload.text);
  assert.ok(task.roleVersion, "the root's first message carries the standing role");
  const occurrences = (part: string) => text.split(part).length - 1;
  assert.equal(occurrences("Never restate a human request"), 1);
  assert.equal(occurrences(`Standing instructions version ${task.roleVersion}.`), 1);
  assert.match(text, /Only local t3-code t3_thread_read\/t3_thread_send/u);
  assert.match(text, /MCPX wrappers may invoke them/u);
  assert.match(text, /Decide relevance before definitions/u);
  assert.match(text, /freshly read your own local thread and cite the latest exact human message/u);
  assert.match(text, /Never reuse an earlier Stop ID/u);
  const envelope = JSON.parse(text.slice(text.indexOf("UNTRUSTED_WORKFLOW_ENVELOPE\n") + "UNTRUSTED_WORKFLOW_ENVELOPE\n".length, text.indexOf("\nEND_UNTRUSTED_WORKFLOW_ENVELOPE")));
  assert.deepEqual(envelope.reader, {supervisorThreadId: (await fixture.binding())!.threadId, bindingGeneration: (await fixture.binding())!.generation});
  const instructions = await supervisor.conversation.readContextView((await fixture.binding())!, {view: "interpretation"}, AbortSignal.timeout(5000));
  assert.match(String(instructions.instructions), /configured required references alone never make a task needed/u);
  assert.match(String(instructions.instructions), /If you cannot invoke workflow_read, that says nothing about the project's definitions/u);
  // the typed protocol adds one bounded submission block with the quoted attempt; the rest of the request stays as concise as before
  const submission = text.slice(text.indexOf("SUBMISSION: "), text.indexOf("UNTRUSTED_WORKFLOW_ENVELOPE\n"));
  assert.match(submission, /supervision_interpretation_submit/u);
  assert.ok(submission.length < 1000, `submission block ${submission.length} characters`);
  assert.ok(text.length - submission.length < 5000, `interpretation request ${text.length - submission.length} characters without the submission block`);
  await submitAndComplete(fixture, supervisor, task, workflowFields(sourceMessageId));
  await supervisor.runOnce();
  assert.equal((await fixture.binding())!.deliveredRoleVersion, task.roleVersion, "the completed interpretation delivered the standing role");
  assert.equal(await supervisor.conversation.interpretationRole((await fixture.binding())!), null, "later root messages carry no second copy");
});

it("an Enable or re-enable saved during the final awaits leaves the request undispatched and a finished result unapplied", { timeout: 60_000 }, async (t) => {
  {
    const fixture = await makeFixture();
    after(t, fixture.cleanup);
    const supervisor = fixture.makeSupervisor();
    const stores = serviceOf(supervisor.store);
    // the Enable lands while the last read before dispatch is awaited, after the queued gate and definition preparation; the
    // hook's read and write run synchronously, before the read answers, as the baseline hook's did
    fixture.onModelsRead(() => {
      const queued = Effect.runSync(stores.task(sourceThreadId));
      if (queued?.status === "queued" && queued.definitionContext) Effect.runSync(stores.recordChatEnable(sourceThreadId, Date.now()));
    });
    await supervisor.runOnce();
    assert.equal(fixture.dispatches().length, 0, "a request written before the Enable is never dispatched");
    assert.equal((await fixture.task())!.status, "expired");
  }
  {
    const fixture = await makeFixture();
    after(t, fixture.cleanup);
    const supervisor = fixture.makeSupervisor();
    await supervisor.runOnce();
    const first = (await fixture.task())!;
    await submitAndComplete(fixture, supervisor, first, workflowFields(sourceMessageId));
    const internal = supervisor as unknown as {definitions: {load: (...args: unknown[]) => Promise<unknown>}};
    const stores = serviceOf(supervisor.store);
    const load = internal.definitions.load.bind(internal.definitions);
    // the project is disabled and re-enabled with its boundary at the request's run while the finished result is revalidated; the
    // reads and writes run synchronously once the read has its value, as the baseline ones did
    internal.definitions.load = async (...args: unknown[]) => {
      const value = await load(...args);
      if (Effect.runSync(stores.task(sourceThreadId))?.status === "waiting") {
        Effect.runSync(Effect.flatMap(stores.control(projectId), (control) => stores.saveControl(projectId, control.generation, false)));
        Effect.runSync(Effect.flatMap(stores.control(projectId), (control) =>
          stores.saveControl(projectId, control.generation, true, {snapshotSequence: 11, threads: [{id: sourceThreadId, latestRunId: first.sourceRunId}]})));
      }
      return value;
    };
    await supervisor.runOnce();
    assert.equal((await fixture.task())!.status, "expired", "the result is never applied across the boundary");
    assert.equal((await fixture.task())!.objective, null);
    assert.equal(fixture.dispatches().length, 1, "nothing is resent");
  }
});

it("an earlier unresolved request carries forward only from the current supervision epoch", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const source = fixture.projections.get(sourceThreadId)!;
  source.messages[0]!.text = "https://issues.example/browse/PROJ-1";
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = (await fixture.task())!;
  await submitAndComplete(fixture, supervisor, first, {objective: null, reason: "Only an issue link was supplied.", sourceMessageIds: [],
    supervision: "needed", workflow: null});
  await supervisor.runOnce();
  assert.equal((await fixture.task())?.status, "needs_context");
  // the human stopped and enabled supervision again after the link; the next request starts a new epoch
  const enabledAt = Date.parse(source.messages[0]!.createdAt) + 1_000;
  await supervisor.store.recordChatEnable(sourceThreadId, enabledAt);
  appendSourceMessage(source, "after-enable-message", 2, "Implement the export described in PROJ-1.");
  source.messages.at(-1)!.createdAt = new Date(enabledAt + 1_000).toISOString();
  await supervisor.runOnce();
  const second = (await fixture.task())!;
  assert.equal(second.sourceMessageId, "after-enable-message");
  assert.equal(second.contextMessageIds, undefined, "a request from before the latest Enable never joins the new interpretation");
  assert.doesNotMatch(String(fixture.dispatches().at(-1)?.payload.text), /issues\.example/u);
});

it("after an Enable the chat's next request is interpreted afresh by the same Supervisor, even when an earlier task was interpreted", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const source = fixture.projections.get(sourceThreadId)!;
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = (await fixture.task())!;
  const rootId = (await fixture.binding())!.threadId;
  await submitAndComplete(fixture, supervisor, first, workflowFields(sourceMessageId));
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.status, "inferred");
  const interpretations = () => fixture.dispatches().filter(call => call.payload.threadId === rootId).length;
  const before = interpretations();
  // without an Enable, a follow-up in the same main stays part of the interpreted task
  appendSourceMessage(source, "follow-up-message", 2, "Please also keep the old export working.");
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.id, first.id);
  assert.equal(interpretations(), before);
  // after the human stops and enables supervision again, the next request gets a fresh interpretation in the same Supervisor
  const enabledAt = Date.now();
  await supervisor.store.recordChatEnable(sourceThreadId, enabledAt);
  appendSourceMessage(source, "after-enable-greeting", 3, "Hi, just checking in.");
  source.messages.at(-1)!.createdAt = new Date(enabledAt + 1_000).toISOString();
  await supervisor.runOnce();
  const fresh = (await fixture.task())!;
  assert.notEqual(fresh.id, first.id);
  assert.equal(fresh.sourceMessageId, "after-enable-greeting");
  assert.equal(fresh.supervisorThreadId, first.supervisorThreadId);
  assert.equal(interpretations(), before + 1);
  assert.match(String(fixture.dispatches().at(-1)?.payload.text), /Hi, just checking in\./u);
});

it("across an Enable only an attempted introduction with an unknown outcome keeps its task; a known-unsent fallback does not hold the next request", { timeout: 60_000 }, async (t) => {
  const priors: Record<string, Pick<WorkflowIntroduction, "state" | "error"> & Partial<WorkflowIntroduction>> = {
    uncertain: {state: "uncertain", dispatchMode: {type: "queue_after_active"}, definiteRejection: false, error: "Proposal delivery is uncertain."},
    acceptedUnobserved: {state: "blocked", dispatchMode: {type: "queue_after_active"}, acceptedAt: 1, error: "T3 accepted this introduction, but it was not found unchanged."},
    rejectedFallback: {state: "ready", dispatchMode: {type: "queue_after_active"}, error: null,
      rejectedAttempts: [{messageId: "supervisor-notice:workflow:steer", commandId: "supervisor-workflow:steer", dispatchMode: {type: "steer_active", targetRunId: "run-1"}}]},
  };
  for (const [name, prior] of Object.entries(priors)) {
    const fixture = await makeFixture();
    after(t, fixture.cleanup);
    const source = fixture.projections.get(sourceThreadId)!;
    const supervisor = fixture.makeSupervisor();
    await supervisor.runOnce();
    const first = (await fixture.task())!;
    await submitAndComplete(fixture, supervisor, first, workflowFields(sourceMessageId));
    await supervisor.runOnce();
    const fallbackId = `supervisor-notice:workflow:${first.id}:queue`;
    await supervisor.conversation.requests.saveIntroduction({taskId: first.id, projectId, threadId: sourceThreadId, supervisorThreadId: first.supervisorThreadId,
      text: "Introduction of the earlier request.", messageId: fallbackId, commandId: `supervisor-workflow:${first.id}:queue`, targetRunId: null, ...prior});
    const enabledAt = Date.now();
    await supervisor.store.recordChatEnable(sourceThreadId, enabledAt);
    appendSourceMessage(source, "after-enable-request", 2, "Hi, just checking in.");
    source.messages.at(-1)!.createdAt = new Date(enabledAt + 1_000).toISOString();
    // the catalog names the main's latest run, as T3's does
    source.thread.latestRunId = "after-enable-request-run";
    await supervisor.runOnce();
    if (name === "rejectedFallback") {
      assert.notEqual((await fixture.task())!.id, first.id, `${name}: the next request is interpreted afresh`);
      assert.equal((await fixture.task())!.sourceMessageId, "after-enable-request", name);
    } else {
      assert.equal((await fixture.task())!.id, first.id, `${name}: the unresolved introduction keeps its task`);
      assert.equal((await supervisor.conversation.requests.introduction(first.id))?.state, prior.state, name);
      // once the delivery is confirmed, the same pending request is interpreted, though the main has no newer run
      await supervisor.conversation.requests.saveIntroduction({...(await supervisor.conversation.requests.introduction(first.id))!, state: "sent", error: null});
      await supervisor.runOnce();
      assert.notEqual((await fixture.task())!.id, first.id, `${name}: the held request is reconsidered after delivery is known`);
      assert.equal((await fixture.task())!.sourceMessageId, "after-enable-request", name);
    }
    assert.equal(fixture.dispatches().filter(call => call.payload.messageId === fallbackId).length, 0, `${name}: the earlier introduction is never sent after the Enable`);
  }
});

it("the proposal is introduced in the same cycle its interpretation completes", async (t) => {
  const fixture = await makeFixture();
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const task = (await fixture.task())!;
  // both conversations use native modes that permit Supervisor contact
  for (const projection of [fixture.projections.get(sourceThreadId)!, fixture.projections.get((await fixture.binding())!.threadId)!])
    Object.assign(projection.thread, {runtimeMode: "full-access", interactionMode: "default"});
  // and the operative has no pending owner question or approval
  (fixture.projections.get(sourceThreadId)! as {runtimeRequests?: unknown[]}).runtimeRequests = [];
  await submitAndComplete(fixture, supervisor, task, workflowFields(sourceMessageId));
  await supervisor.runOnce();
  assert.equal((await fixture.task())!.status, "inferred");
  const introduction = fixture.dispatches().find(call => call.payload.threadId === sourceThreadId);
  assert.equal(introduction?.payload.messageId, `supervisor-notice:workflow:${task.id}`, "the introduction goes out in the completion cycle");
});
