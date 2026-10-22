import {WorkflowWriteController} from "../src/workflow-write-controller.js";
import { ThreadPolicyStore } from "../src/thread-policy.js";
import assert from "node:assert/strict";
import { it } from "vitest";
import { after, mockMethod } from "./support/node-test.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { createServer } from "node:http";
import { GuidanceStore } from "../src/guidance-store.js";
import { parseInterpretation, ProjectSupervisor } from "../src/project-supervisor.js";
import { defaultSupervisorModel, ProjectSupervisorStore, type SupervisorBaseline } from "../src/project-supervisor-store.js";
import type { SupervisorModelSelection } from "../src/project-supervisor-contract.js";
import { ProjectSupervisorSnapshot } from "../src/project-supervisor-contract.js";
import { SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { makeT3Client, T3Client, T3TransportError, type T3ClientShape } from "../src/t3.js";
import type { MessageInfo, ProjectInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "../src/types.js";
import { effectiveIndex, makeDefinitionFixture, projectIndex, stepSource } from "./project-definitions-fixture.js";

const activationSequence = 10;
const day = 24 * 60 * 60 * 1000;
const baseTime = "2026-10-13T10:00:00.000Z";

const missingDefinitions = (projectId: string, threadId: string | null, workspaceRoot: string) => ({
  projectId, threadId, workspaceRoot, globalOnly: false, globalRevision: null, revision: null,
  editingAvailable: false, status: "missing" as const, steps: [], workflows: [], config: effectiveIndex({steps: [], workflows: []}), projectConfig: null,
  definitionFiles: [], complete: false, sources: [], issues: [],
});

const workflowSnapshot = (withStep = true) => ({
  status: "proposed" as const, message: "Current draft", workspaceRoot: "/work/a", revision: "definitions-1", globalRevision: null,
  definitionsStatus: "ready" as const, definitionsComplete: true, requirementsKnown: true, requirements: [], issues: [],
  plan: {kind: "sequence" as const, templatePath: null, nodes: withStep ? [{kind: "step" as const, nodeId: "00000000-0000-4000-8000-000000000001",
    definitionId: null, localId: "csv-export", templatePath: null, name: "Implement CSV export", description: "Add the requested feature.",
    source: null, resolution: "resolved" as const, reason: "Add the requested feature.", status: "planned" as const, contributorThreadIds: []}] : []},
});

const projects: ProjectInfo[] = [
  { id: "project-a", title: "Project A", workspaceRoot: "/work/a" },
  { id: "project-b", title: "Project B", workspaceRoot: "/work/b" },
];

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

type Turn = { id: string; sequence: number; text: string; creationSource?: "web" | "mobile" | "server"; createdBy?: "user" | "assistant" | "system" };

const makeSourceProjection = (threadId: string, projectId: string, turns: Turn[]): Projection => {
  const thread: ThreadInfo = {
    id: threadId,
    title: "Task conversation",
    projectId,
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const runs: RunInfo[] = [];
  const messages: MessageInfo[] = [];
  const nodes: Array<Record<string, unknown>> = [];
  for (const [index, turn] of turns.entries()) {
    const runId = "run-" + turn.id;
    const rootId = "root-" + turn.id;
    runs.push({
      id: runId,
      threadId,
      ordinal: index + 1,
      status: "completed",
      requestedAt: baseTime,
      startedAt: baseTime,
      completedAt: baseTime,
      rootNodeId: rootId,
      userMessageId: turn.id,
      providerThreadId: "provider-" + threadId,
    });
    messages.push({
      id: turn.id,
      threadId,
      runId,
      nodeId: rootId,
      role: "user",
      text: turn.text,
      streaming: false,
      createdAt: baseTime,
      updatedAt: baseTime,
      createdBy: turn.createdBy ?? "user",
      creationSource: turn.creationSource ?? "web",
    });
    nodes.push(
      { id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "completed", providerThreadId: "provider-" + threadId },
    );
  }
  return { thread, runs, messages, nodes };
};

const emptySupervisorProjection = (threadId: string, projectId: string, model: SupervisorModelSelection): Projection => ({
  thread: {
    id: threadId,
    title: "Project Supervisor",
    projectId,
    lineage: { parentThreadId: null, relationshipToParent: null },
    modelSelection: model,
  },
  runs: [],
  messages: [],
  nodes: [],
});

const addSupervisorRequest = (projection: Projection, payload: Record<string, unknown>): void => {
  const threadId = projection.thread.id;
  const ordinal = projection.runs.length + 1;
  const runId = "supervisor-run-" + ordinal;
  const rootId = "supervisor-root-" + ordinal;
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
  });
  const nodes = Array.isArray(projection.nodes) ? projection.nodes as Array<Record<string, unknown>> : [];
  projection.nodes = nodes;
  nodes.push(
    { id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "running", providerThreadId: "supervisor-provider" },
  );
};

const completeSupervisorRequest = (projection: Projection, messageId: string, response: string): void => {
  const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
  assert.ok(run?.rootNodeId);
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  const nodes = Array.isArray(projection.nodes) ? projection.nodes as Array<Record<string, unknown>> : [];
  const root = nodes.find((node) => node.id === run.rootNodeId);
  assert.ok(root);
  root.status = "completed";
  const nodeId = "supervisor-assistant-node-" + run.id;
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
    id: "assistant-" + run.id,
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

const workflowResult = (messageId: string, objective: string, reason: string): string => JSON.stringify({
  objective,
  reason,
  sourceMessageIds: [messageId],
  workflow: {requirements: [], plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "bounded-task-step",
    name: "Review the available context", description: "State what remains unknown and keep the plan finite.",
    reason: "The current task needs a bounded plan."}]}},
});

const retryInput = (
  projectId: string,
  expectedGeneration: number,
  binding: { threadId: string; generation: number; mainThreadId: string },
  action: "retry" | "replace",
) => ({ projectId, mainThreadId: binding.mainThreadId, expectedGeneration, threadId: binding.threadId, bindingGeneration: binding.generation, action });

const makeFixture = async (initial: Array<{ threadId: string; projectId: string; turns: Turn[] }>) => {
  const directory = await mkdtemp(join(tmpdir(), "project-supervisor-test-"));
  const projections = new Map<string, Projection>();
  const turnsByThread = new Map<string, Turn[]>();
  let registeredProjects = [...projects];
  const operations: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const projectionReads: string[] = [];
  let unknownDispatches = 0;
  let acceptedDispatchesWithoutRun = 0;
  let unknownLaunchResponses = 0;
  let launchFailuresBeforeCreate = 0;
  let durableLaunchRejections = 0;
  let providerDisabledLaunchRejections = 0;
  let providerDisabledDispatches = 0;
  let unknownModelUpdates = 0;
  let durableModelRejections = 0;
  let nextModelReadback: SupervisorModelSelection | null = null;
  let nextMissingProjectionFailure: T3TransportError | null = null;
  const projectionFailures = new Map<string, T3TransportError>();
  let snapshotSequence = activationSequence;
  let baselineReads = 0;
  let scheduledTasks: Record<string, unknown>[] = [];
  for (const source of initial) {
    projections.set(source.threadId, makeSourceProjection(source.threadId, source.projectId, source.turns));
    turnsByThread.set(source.threadId, [...source.turns]);
  }
  let guidance = new GuidanceStore(directory);
  let ownedIds = new Set<string>();
  let supervisorStore = new ProjectSupervisorStore(guidance, ownedIds);
  for (const project of projects) guidance.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`supervisor_control:${JSON.stringify(project.id)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const config: SupervisorConfig = {
    supervisorOwnedThreadIds: ownedIds,
    dataDirectory: directory,
    t3Url: "http://unused",
    t3TokenFile: "unused",
    excludedThreadIds: [],
    healthPort: 0,
  };
  const source = {
    catalog: () => Effect.succeed({
      projects: registeredProjects.map((project) => ({ project, available: true })),
      threads: [...projections.values()].map((projection) => projection.thread),
    }),
  };
  let nativeProjection: ((threadId: string) => ReturnType<T3ClientShape["projection"]>) | null = null;
  const t3 = {
    projection: (threadId: string) => {
      if (nativeProjection) return nativeProjection(threadId);
      projectionReads.push(threadId);
      const knownFailure = projectionFailures.get(threadId);
      if (knownFailure) return Effect.fail(knownFailure);
      const projection = projections.get(threadId);
      if (projection) return Effect.succeed({ projection, snapshotSequence: 20 });
      if (nextMissingProjectionFailure) {
        const failure = nextMissingProjectionFailure;
        nextMissingProjectionFailure = null;
        return Effect.fail(failure);
      }
      return Effect.fail(new T3TransportError("missing projection", 404));
    },
  };
  const readRpc = async (tag: string): Promise<unknown> => {
    if (tag === "server.getConfig") return modelConfig;
    throw new Error("unexpected fake read RPC");
  };
  const operateRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    operations.push({ tag, payload });
    if (tag === "scheduledTasks.list") return {tasks: scheduledTasks};
    if (tag === "scheduledTasks.delete") {
      scheduledTasks = scheduledTasks.filter(task => task.id !== payload.id);
      return {deleted: true};
    }
    if (tag === "orchestration.launchThread") {
      const threadId = String(payload.threadId);
      const projectId = String(payload.projectId);
      const existing = projections.has(threadId);
      if (payload.reuseExistingThread === true && !existing) throw new Error("reuseExistingThread requires a thread already visible in projection");
      if (!existing && providerDisabledLaunchRejections > 0) {
        providerDisabledLaunchRejections -= 1;
        throw new SupervisorRpcError("rejected", true, true);
      }
      if (!existing && durableLaunchRejections > 0) {
        durableLaunchRejections -= 1;
        throw new SupervisorRpcError("rejected", true);
      }
      if (!existing && launchFailuresBeforeCreate > 0) {
        launchFailuresBeforeCreate -= 1;
        throw new Error("simulated lost launch response before native creation");
      }
      if (!existing) projections.set(threadId, emptySupervisorProjection(threadId, projectId, payload.modelSelection as SupervisorModelSelection));
      if (unknownLaunchResponses > 0) {
        unknownLaunchResponses -= 1;
        throw new Error("simulated lost launch response after native creation");
      }
      return { accepted: true };
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "message.dispatch") {
      if (providerDisabledDispatches > 0) {
        providerDisabledDispatches -= 1;
        throw new SupervisorRpcError("rejected", true, true);
      }
      if (unknownDispatches > 0) {
        unknownDispatches -= 1;
        throw new Error("simulated lost response");
      }
      const projection = projections.get(String(payload.threadId));
      assert.ok(projection);
      if (acceptedDispatchesWithoutRun > 0) {
        acceptedDispatchesWithoutRun -= 1;
        return { accepted: true };
      }
      addSupervisorRequest(projection, payload);
      delete projection.thread.settledAt;
      return { accepted: true };
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "thread.model-selection.set") {
      const projection = projections.get(String(payload.threadId));
      assert.ok(projection);
      if (durableModelRejections > 0) {
        durableModelRejections -= 1;
        projection.thread.modelSelection = nextModelReadback ?? defaultSupervisorModel;
        nextModelReadback = null;
        throw new SupervisorRpcError("rejected", true);
      }
      if (unknownModelUpdates > 0) {
        unknownModelUpdates -= 1;
        throw new Error("simulated lost model update response");
      }
      projection.thread.modelSelection = nextModelReadback ?? payload.modelSelection;
      nextModelReadback = null;
      return { accepted: true };
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "thread.settle") {
      const projection = projections.get(String(payload.threadId));
      assert.ok(projection);
      projection.thread.settledAt = new Date().toISOString();
      return {sequence: 20};
    }
    throw new Error("unexpected fake operate RPC");
  };
  const activationSnapshot = async (_signal: AbortSignal): Promise<SupervisorBaseline> => {
    baselineReads += 1;
    return {
      snapshotSequence,
      threads: [...projections.values()].map((projection) => {
        const historical = (turnsByThread.get(projection.thread.id) ?? []).filter((turn) => turn.sequence <= snapshotSequence);
        const latest = historical.at(-1);
        return { id: projection.thread.id, latestRunId: latest ? "run-" + latest.id : null };
      }),
    };
  };
  const addTurn = (threadId: string, projectId: string, turn: Turn): void => {
    const turns = [...(turnsByThread.get(threadId) ?? []), turn];
    turnsByThread.set(threadId, turns);
    projections.set(threadId, makeSourceProjection(threadId, projectId, turns));
  };
  const defaultDefinitions = {load: async (projectId: string, threadId: string | null) => {
    const workspaceRoot = registeredProjects.find(project => project.id === projectId)?.workspaceRoot ?? "";
    return missingDefinitions(projectId, threadId, workspaceRoot);
  }};
  const makeSupervisor = (definitions: ConstructorParameters<typeof ProjectSupervisor>[7] | null = defaultDefinitions) =>
    new ProjectSupervisor(config, supervisorStore, source, t3, readRpc, operateRpc, activationSnapshot, definitions ?? undefined);
  const restart = (): void => {
    guidance.close();
    guidance = new GuidanceStore(directory);
    ownedIds = new Set<string>();
    supervisorStore = new ProjectSupervisorStore(guidance, ownedIds);
    config.supervisorOwnedThreadIds = ownedIds;
  };
  return {
    directory,
    config,
    operations,
    projectionReads,
    projections,
    get supervisorStore() { return supervisorStore; },
    get baselineReads() { return baselineReads; },
    makeSupervisor,
    addProject: (project: ProjectInfo) => {registeredProjects = [...registeredProjects, project];},
    restart,
    addTurn,
    setSnapshotSequence: (value: number) => { snapshotSequence = value; },
    setUnknownDispatches: (count: number) => { unknownDispatches = count; },
    setAcceptedDispatchesWithoutRun: (count: number) => { acceptedDispatchesWithoutRun = count; },
    setUnknownLaunchResponses: (count: number) => { unknownLaunchResponses = count; },
    setLaunchFailuresBeforeCreate: (count: number) => { launchFailuresBeforeCreate = count; },
    setDurableLaunchRejections: (count: number) => { durableLaunchRejections = count; },
    setProviderDisabledLaunchRejections: (count: number) => { providerDisabledLaunchRejections = count; },
    setProviderDisabledDispatches: (count: number) => { providerDisabledDispatches = count; },
    setUnknownModelUpdates: (count: number) => { unknownModelUpdates = count; },
    setDurableModelRejections: (count: number) => { durableModelRejections = count; },
    setNextModelReadback: (selection: SupervisorModelSelection) => { nextModelReadback = selection; },
    setNextMissingProjectionFailure: (error: T3TransportError) => { nextMissingProjectionFailure = error; },
    setProjectionFailure: (threadId: string, error: T3TransportError) => {projectionFailures.set(threadId, error);},
    setScheduledTasks: (tasks: Record<string, unknown>[]) => {scheduledTasks = tasks;},
    useNativeProjection: (read: (threadId: string) => ReturnType<T3ClientShape["projection"]>) => {nativeProjection = read;},
    get scheduledTasks() {return scheduledTasks;},
    setLegacyBaseline: (baseline: Record<string, unknown>) => {
      supervisorStore.store.db.prepare("INSERT INTO meta VALUES('supervisor_activation_baseline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(baseline));
    },
    close: () => guidance.close(),
    cleanup: async () => { try { guidance.close(); } catch { /* already closed during a simulated restart */ } await rm(directory, { recursive: true, force: true }); },
  };
};

const reserveReadyBinding = (fixture: Awaited<ReturnType<typeof makeFixture>>, mainThreadId = "source-thread") => {
  const main = fixture.projections.get(mainThreadId);
  assert.ok(main);
  const binding = fixture.supervisorStore.reserve("project-a", mainThreadId, main.thread.title, defaultSupervisorModel, activationSequence, Date.now());
  const ready = {...binding, state: "ready" as const};
  fixture.supervisorStore.setBinding(ready);
  fixture.projections.set(ready.threadId, emptySupervisorProjection(ready.threadId, ready.projectId, defaultSupervisorModel));
  return ready;
};

const registerReadyHelper = (fixture: Awaited<ReturnType<typeof makeFixture>>, supervisor: ProjectSupervisor,
  binding: ReturnType<typeof reserveReadyBinding>, threadId: string) => {
  const helperProjection = makeSourceProjection(threadId, binding.projectId, []);
  helperProjection.thread.lineage = {parentThreadId: binding.threadId, relationshipToParent: "subagent", rootThreadId: binding.threadId};
  fixture.projections.set(threadId, helperProjection);
  const registering = supervisor.team.registerMember(binding, {threadId, taskId: `task-${threadId}`, bootstrapRunId: `run-${threadId}`});
  return supervisor.team.markReady(binding, threadId, registering.epoch);
};

const markRootMissing = (fixture: Awaited<ReturnType<typeof makeFixture>>, binding: ReturnType<typeof reserveReadyBinding>) => {
  fixture.projections.delete(binding.threadId);
  fixture.supervisorStore.setBinding({...binding, state: "missing"});
  return {...binding, state: "missing" as const};
};

const addPendingHelperCheckin = (supervisor: ProjectSupervisor, binding: ReturnType<typeof reserveReadyBinding>, memberThreadId: string,
  requestId: string, now: number, state: "waiting" | "uncertain" = "waiting") => {
  const prepared = supervisor.conversation.requests.prepare({id: requestId, projectId: binding.projectId, supervisorThreadId: memberThreadId,
    kind: "review", taskId: null, text: "Bounded helper check-in", batch: null, completionMarker: `complete:${requestId}`}, now);
  const pending = {...prepared, state, sentAt: now + 1, runId: `run:${requestId}`};
  supervisor.conversation.requests.saveRequest(pending);
  return pending;
};

it("scopeSnapshot returns current binding coordinates and verified descendant lineage across project mirrors", async t => {
  const fixture = await makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  const binding = reserveReadyBinding(fixture);
  const main = fixture.projections.get("source-thread");assert.ok(main);
  const child = makeSourceProjection("native-child", "other-project", []);
  child.thread.projectId = null;
  child.thread.lineage = {parentThreadId: "source-thread", relationshipToParent: "subagent", rootThreadId: "source-thread"};
  child.thread.creationSource = "provider";
  child.thread.activeRunId = null;
  const delegated = makeSourceProjection("delegated-child", "other-project", []);
  delegated.thread.lineage = {parentThreadId: "source-thread", relationshipToParent: "subagent", rootThreadId: "source-thread"};
  delegated.thread.creationSource = "mcp";
  main.subagents = [{childThreadId: child.thread.id, status: "running"}, {childThreadId: delegated.thread.id, status: "completed"}];
  fixture.projections.set(child.thread.id, child);
  fixture.projections.set(delegated.thread.id, delegated);

  const supervisor = fixture.makeSupervisor();
  assert.deepEqual(supervisor.workflowLocator("project-a", "source-thread"), {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation});
  const readsBefore = fixture.projectionReads.length;
  const snapshot = await supervisor.scopeSnapshot("project-a", "source-thread", AbortSignal.timeout(5_000), {lineageOffset: 2, limit: 1});
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.supervisorThreadId, binding.threadId);
  assert.equal(snapshot.bindingGeneration, binding.generation);
  assert.equal(snapshot.lineageTotal, 3);
  assert.equal(snapshot.lineageOffset, 2);
  assert.equal(snapshot.lineageHasMore, false);
  assert.deepEqual(snapshot.threads.map(row => row.threadId), ["native-child"]);
  assert.equal(snapshot.threads[0]?.parentThreadId, "source-thread");
  assert.equal(snapshot.threads[0]?.origin, "native_child");
  assert.equal(snapshot.threads[0]?.lifecycle, "running");
  assert.match(snapshot.threads[0]?.contactLimit ?? "", /direct parent/u);
  assert.deepEqual(fixture.projectionReads.slice(readsBefore), [binding.threadId, "native-child", "source-thread"],
    "the snapshot reads only the requested child and its parent, plus the owning Supervisor");
});

it("an unbound scopeSnapshot returns only the requested lineage page without Supervisor reads", async t => {
  const fixture = await makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  for (const id of ["child-one", "child-two"]) {
    const child = makeSourceProjection(id, "other-project", []);
    child.thread.projectId = null;
    child.thread.lineage = {parentThreadId: "source-thread", relationshipToParent: "subagent", rootThreadId: "source-thread"};
    child.thread.creationSource = "provider";
    fixture.projections.set(id, child);
  }
  const readsBefore = fixture.projectionReads.length;
  const snapshot = await fixture.makeSupervisor().scopeSnapshot("project-a", "source-thread", AbortSignal.timeout(5_000), {lineageOffset: 1, limit: 1});
  assert.equal(snapshot.supervisorThreadId, null);
  assert.equal(snapshot.bindingGeneration, null);
  assert.equal(snapshot.lineageTotal, 3);
  assert.deepEqual(snapshot.threads.map(row => row.threadId), ["child-one"]);
  assert.deepEqual(fixture.projectionReads.slice(readsBefore), ["child-one", "source-thread"]);
});

it("activation baseline excludes existing runs and gives independent mains separate Supervisors", async (t) => {
  const fixture = await makeFixture([
    { threadId: "old-thread", projectId: "project-a", turns: [{ id: "old-task", sequence: 9, text: "Old work" }] },
    { threadId: "current-thread", projectId: "project-a", turns: [
      { id: "current-history", sequence: 10, text: "Earlier request" },
      { id: "current-task", sequence: 11, text: "Build the invoice export" },
    ] },
    { threadId: "archived-history", projectId: "project-a", turns: [{ id: "archived-task", sequence: 8, text: "Archived work" }] },
  ]);
  after(t, fixture.cleanup);
  fixture.projections.get("archived-history")!.thread.archivedAt = baseTime;
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const baseline = fixture.supervisorStore.baseline();
  assert.equal(baseline?.snapshotSequence, activationSequence);
  assert.equal(baseline?.version, 2);
  assert.equal(baseline?.threads.find((thread) => thread.id === "old-thread")?.latestRunId, "run-old-task");
  assert.equal(baseline?.threads.find((thread) => thread.id === "current-thread")?.latestRunId, "run-current-history");
  assert.equal(baseline?.threads.find((thread) => thread.id === "archived-history")?.latestRunId, "run-archived-task");
  assert.equal(fixture.supervisorStore.task("old-thread"), null);
  assert.equal(fixture.supervisorStore.task("current-thread")?.status, "waiting");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
  const initialLaunch = fixture.operations.find((call) => call.tag === "orchestration.launchThread");
  assert.ok(initialLaunch);
  assert.ok(initialLaunch.payload.reuseExistingThread === undefined || initialLaunch.payload.reuseExistingThread === false);
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 1);

  const childProjection = makeSourceProjection("owned-descendant", "project-a", [{ id: "child-task", sequence: 99, text: "Do not recurse" }]);
  childProjection.thread.lineage = { parentThreadId: binding.threadId, relationshipToParent: "fork" };
  fixture.projections.set("owned-descendant", childProjection);
  fixture.addTurn("second-thread", "project-a", { id: "second-task", sequence: 12, text: "Prepare a release note" });

  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("second-thread")?.status, "waiting");
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 2, "each main can have its own in-flight interpretation");
  assert.equal(fixture.projectionReads.includes("owned-descendant"), false);

  const firstTask = fixture.supervisorStore.task("current-thread");
  assert.ok(firstTask);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  const linkedResult = workflowResult(firstTask.sourceMessageId, "Build the invoice export", "The source request asks for an export to be built.");
  completeSupervisorRequest(supervisorProjection, firstTask.messageId, linkedResult);
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("current-thread")?.status, "inferred");
  assert.equal(fixture.supervisorStore.task("current-thread")?.objective, "Build the invoice export");
  assert.throws(() => parseInterpretation(JSON.stringify({
    objective: "A different task",
    reason: "The response points to another input.",
    sourceMessageIds: ["unrelated-message"],
  }), firstTask.sourceMessageId));

  await supervisor.runOnce();
  const dispatches = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(dispatches.length, 2);
  assert.deepEqual(new Set(dispatches.map(call => call.payload.threadId)), new Set(fixture.supervisorStore.bindings().map(binding => binding.threadId)));
  assert.notEqual(dispatches[0]?.payload.messageId, dispatches[1]?.payload.messageId);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 2);
});

it("a newly registered project reuses startup history bounds and auto-enables before its next prompt", async t => {
  const fixture = await makeFixture([{threadId: "new-main", projectId: "project-new", turns: [
    {id: "preexisting-history", sequence: 9, text: "A task that predates the service startup boundary"},
  ]}]);
  after(t, fixture.cleanup);
  const definitions = {
    load: async (projectId: string, threadId: string | null) => missingDefinitions(projectId, threadId, "/work/new"),
    presence: async (projectId: string) => ({status: projectId === "project-new" ? "present" as const : "missing" as const}),
  };
  const supervisor = fixture.makeSupervisor(definitions);
  await supervisor.runOnce();
  fixture.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.autoControlInitialized("project-new"), true);
  assert.equal(fixture.supervisorStore.control("project-new").enabled, true);
  assert.equal(fixture.supervisorStore.task("new-main"), null, "startup history stays excluded even before the project appears in the catalog");
  assert.equal(fixture.baselineReads, 1, "first known-present detection reuses the startup baseline");

  fixture.addTurn("new-main", "project-new", {id: "first-task", sequence: 11, text: "Build the first project change"});
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("new-main")?.sourceMessageId, "first-task");
  assert.equal(fixture.supervisorStore.task("new-main")?.status, "waiting");
  assert.equal(fixture.supervisorStore.bindings().some(binding => binding.projectId === "project-new" && binding.mainThreadId === "new-main"), true);
  assert.equal(fixture.baselineReads, 1, "auto-detection does not move the boundary past the first subsequent task");
});

it("a project added with its first human task between polls supervises that task", async t => {
  const fixture = await makeFixture([{threadId: "existing-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  const definitions = {
    load: async (projectId: string, threadId: string | null) => missingDefinitions(projectId, threadId, "/work/new"),
    presence: async (projectId: string) => ({status: projectId === "project-new" ? "present" as const : "missing" as const}),
  };
  const supervisor = fixture.makeSupervisor(definitions);
  await supervisor.runOnce();
  fixture.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
  fixture.addTurn("first-main", "project-new", {id: "first-task", sequence: 11, text: "Build the first project change"});

  await supervisor.runOnce();

  assert.equal(fixture.supervisorStore.autoControlInitialized("project-new"), true);
  assert.equal(fixture.supervisorStore.control("project-new").effectiveEnabled, true);
  assert.equal(fixture.supervisorStore.task("first-main")?.sourceMessageId, "first-task");
  assert.equal(fixture.supervisorStore.task("first-main")?.status, "waiting");
  assert.equal(fixture.baselineReads, 1, "the post-startup task is not absorbed by a late first-seen snapshot");
});

it("a project that was unreadable recaptures its boundary before resuming discovery", async t => {
  const fixture = await makeFixture([{threadId: "existing-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  let folderStatus: "present" | "unavailable" = "unavailable";
  const definitions = {
    load: async (projectId: string, threadId: string | null) => missingDefinitions(projectId, threadId, "/work/new"),
    presence: async (projectId: string) => ({status: projectId === "project-new" ? folderStatus : "missing" as const}),
  };
  const supervisor = fixture.makeSupervisor(definitions);
  await supervisor.runOnce();
  fixture.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.autoControlInitialized("project-new"), false);
  assert.equal(fixture.supervisorStore.projectBoundary("project-new"), null);

  fixture.restart();
  const restartedSupervisor = fixture.makeSupervisor(definitions);
  fixture.addTurn("new-main", "project-new", {id: "first-task", sequence: 11, text: "Work created during an unreadable interval"});
  fixture.setSnapshotSequence(11);
  folderStatus = "present";
  await restartedSupervisor.runOnce();
  assert.equal(fixture.supervisorStore.control("project-new").enabled, true);
  assert.equal(fixture.supervisorStore.task("new-main"), null, "the unreadable interval is excluded from first-time discovery");
  assert.equal(fixture.supervisorStore.bindings().some(binding => binding.projectId === "project-new"), false);

  fixture.addTurn("new-main", "project-new", {id: "next-task", sequence: 12, text: "Work submitted after the folder became readable"});
  await restartedSupervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("new-main")?.sourceMessageId, "next-task");
  assert.equal(fixture.supervisorStore.task("new-main")?.status, "waiting");
});

it("a web-originated message with non-user authorship is not treated as a task", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{
      id: "non-user-source",
      sequence: 11,
      text: "A web-originated message not authored by the user",
      creationSource: "web",
      createdBy: "assistant",
    }] },
  ]);
  after(t, fixture.cleanup);
  await fixture.makeSupervisor().runOnce();

  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 0);
});

it("a missing baseline run anchor fails closed instead of interpreting later projection history", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "baseline-anchor", sequence: 9, text: "Historical request" }] },
  ]);
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.baselineOrdinal("source-thread", fixture.projections.get("source-thread")!), 1);

  fixture.projections.set("source-thread", makeSourceProjection("source-thread", "project-a", [
    { id: "later-task", sequence: 11, text: "This run must not pass a missing baseline anchor" },
  ]));
  await supervisor.runOnce();

  assert.equal(fixture.supervisorStore.baselineOrdinal("source-thread", fixture.projections.get("source-thread")!), null);
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 0);
});

it("an unversioned activation baseline is replaced by a conservative version 2 capture", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [
      { id: "legacy-history", sequence: 9, text: "Do not backfill this old task" },
      { id: "post-activation-task", sequence: 11, text: "Review the next change" },
    ] },
  ]);
  after(t, fixture.cleanup);
  fixture.setLegacyBaseline({ snapshotSequence: 9, threads: [] });
  assert.equal(fixture.supervisorStore.baseline(), null);

  await fixture.makeSupervisor().runOnce();

  const baseline = fixture.supervisorStore.baseline();
  assert.equal(baseline?.version, 2);
  assert.equal(baseline?.snapshotSequence, activationSequence);
  assert.equal(baseline?.threads.find((thread) => thread.id === "source-thread")?.latestRunId, "run-legacy-history");
  assert.equal(fixture.baselineReads, 1);
  assert.equal(fixture.supervisorStore.task("source-thread")?.sourceMessageId, "post-activation-task");
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
});

it("model choices are checked against T3 and saved per project with generation CAS", async (t) => {
  const fixture = await makeFixture([]);
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  const signal = AbortSignal.timeout(1000);
  const invalid = await supervisor.save({
    projectId: "project-a",
    expectedGeneration: 0,
    modelSelection: { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "unadvertised" }] },
  }, signal);
  assert.equal(invalid.status, "invalid");

  const savedA = await supervisor.save({
    projectId: "project-a",
    expectedGeneration: 0,
    modelSelection: { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "low" }] },
  }, signal);
  assert.equal(savedA.status, "saved");
  assert.equal(savedA.snapshot?.settings.generation, 1);
  const conflict = await supervisor.save({
    projectId: "project-a",
    expectedGeneration: 0,
    modelSelection: defaultSupervisorModel,
  }, signal);
  assert.equal(conflict.status, "conflict");

  const savedB = await supervisor.save({
    projectId: "project-b",
    expectedGeneration: 0,
    modelSelection: { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "max" }] },
  }, signal);
  assert.equal(savedB.status, "saved");
  assert.equal(fixture.supervisorStore.settings("project-a").modelSelection.options[0]?.value, "low");
  assert.equal(fixture.supervisorStore.settings("project-b").modelSelection.model, "gpt-6-astra");
  assert.equal(fixture.supervisorStore.settings("project-b").generation, 1);
});

it("model defaults affect new Supervisors while independent T3 selections remain authoritative", async t => {
  const fixture = await makeFixture([{threadId: "first", projectId: "project-a", turns: [{id: "first-task", sequence: 11, text: "Implement first"}]}]);
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = fixture.supervisorStore.binding("project-a", "first")!;
  const manual = {...defaultSupervisorModel, model: "gpt-6-astra", options: [{id: "reasoningEffort", value: "max"}]};
  fixture.projections.get(first.threadId)!.thread.modelSelection = manual;
  const defaults = {...defaultSupervisorModel, options: [{id: "reasoningEffort", value: "low"}]};
  assert.equal((await supervisor.save({projectId: "project-a", expectedGeneration: 0, modelSelection: defaults}, AbortSignal.timeout(1000))).status, "saved");
  fixture.addTurn("second", "project-a", {id: "second-task", sequence: 12, text: "Implement second"});
  await supervisor.runOnce();
  const second = fixture.supervisorStore.binding("project-a", "second")!;
  assert.notEqual(first.threadId, second.threadId);
  assert.deepEqual(fixture.projections.get(first.threadId)!.thread.modelSelection, manual);
  assert.deepEqual(fixture.projections.get(second.threadId)!.thread.modelSelection, defaults);
  assert.deepEqual(fixture.supervisorStore.settings("project-a").modelSelection, defaults);
  assert.equal(fixture.operations.some(call => call.payload.type === "thread.model-selection.set"), false);
  const selected = await supervisor.snapshot("project-a", AbortSignal.timeout(1000), "first");
  assert.deepEqual(selected.modelSelection, manual);
  const noSelection = await supervisor.snapshot("project-a", AbortSignal.timeout(1000));
  assert.equal(noSelection.binding, null);assert.equal(noSelection.modelSelection, null);assert.deepEqual(noSelection.tasks, []);
});

it("unknown dispatch survives restart and retention with the original native identities", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  after(t, fixture.cleanup);
  fixture.setUnknownDispatches(1);
  await fixture.makeSupervisor().runOnce();
  const uncertain = fixture.supervisorStore.task("source-thread");
  assert.equal(uncertain?.status, "uncertain");
  assert.ok(uncertain);
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  fixture.supervisorStore.saveTask({ ...uncertain, updatedAt: Date.now() - 31 * day });
  const activationBaseline = fixture.supervisorStore.baseline();
  assert.ok(activationBaseline);

  fixture.setSnapshotSequence(12);
  fixture.restart();
  assert.equal(fixture.supervisorStore.ownedIds.has(binding.threadId), true);
  assert.deepEqual(fixture.supervisorStore.baseline(), activationBaseline);
  assert.equal(fixture.baselineReads, 1, "restart must reuse the original baseline instead of moving activation forward");
  fixture.supervisorStore.prune(Date.now());
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "uncertain");

  await fixture.makeSupervisor().runOnce();
  const dispatches = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[1]?.payload.commandId, dispatches[0]?.payload.commandId);
  assert.equal(dispatches[1]?.payload.messageId, dispatches[0]?.payload.messageId);
  assert.equal(dispatches[1]?.payload.text, dispatches[0]?.payload.text);
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
  assert.equal(fixture.operations.some((call) => ["runtime-request.respond", "thread.interrupt", "runtime-request.interrupt"].includes(String(call.payload.type))), false);
});

it("accepted requests without native runs stop after two replays and remain available for explicit retry", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  after(t, fixture.cleanup);
  fixture.setAcceptedDispatchesWithoutRun(3);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  for (let attempt = 0; attempt < 3; attempt += 1) await supervisor.runOnce();

  const uncertain = fixture.supervisorStore.task("source-thread");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(uncertain && binding);
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.replayCount, 2);
  const dispatches = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(dispatches.length, 3);
  assert.ok(dispatches.every((call) => call.payload.commandId === dispatches[0]?.payload.commandId));
  assert.ok(dispatches.every((call) => call.payload.messageId === dispatches[0]?.payload.messageId));

  await supervisor.runOnce();
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 3, "uncertainty waits for an explicit UI retry");
  const retry = await supervisor.retry(retryInput("project-a", 0, binding, "retry"), AbortSignal.timeout(1000));
  assert.equal(retry.status, "saved");
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
  const retried = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(retried.length, 4);
  assert.equal(retried[3]?.payload.commandId, retried[0]?.payload.commandId);
  assert.equal(retried[3]?.payload.messageId, retried[0]?.payload.messageId);
});

it("a transient Supervisor projection failure is not treated as proof the thread is missing", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  after(t, fixture.cleanup);
  fixture.setNextMissingProjectionFailure(new T3TransportError("projection unavailable", 503));
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();

  const reserved = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(reserved);
  assert.equal(reserved.state, "creating");
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 0);

  await supervisor.runOnce();
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.state, "ready");
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
});

it("creation attempts stop after three failures until explicit retry reuses the original command identity", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  after(t, fixture.cleanup);
  fixture.setLaunchFailuresBeforeCreate(3);
  const supervisor = fixture.makeSupervisor();
  for (let attempt = 0; attempt < 4; attempt += 1) await supervisor.runOnce();

  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  assert.equal(binding.state, "uncertain");
  assert.equal(binding.creationAttempts, 3);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 3);
  const originalCommandId = fixture.operations.find((call) => call.tag === "orchestration.launchThread")?.payload.commandId;
  assert.ok(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").every((call) => call.payload.commandId === originalCommandId));
  assert.equal(fixture.supervisorStore.task("source-thread"), null);

  const retry = await supervisor.retry(retryInput("project-a", 0, binding, "retry"), AbortSignal.timeout(1000));
  assert.equal(retry.status, "saved");
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.threadId, binding.threadId);
  const launches = fixture.operations.filter((call) => call.tag === "orchestration.launchThread");
  assert.equal(launches.length, 4);
  assert.equal(launches[3]?.payload.commandId, originalCommandId);
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
});

it("durable creation rejection requires explicit retry and advances only the native command generation", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  after(t, fixture.cleanup);
  fixture.setDurableLaunchRejections(1);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const rejected = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(rejected);
  assert.equal(rejected.state, "rejected");
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  await supervisor.runOnce();
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1, "durable rejection cannot auto-replay");

  const retry = await supervisor.retry(retryInput("project-a", 0, rejected, "retry"), AbortSignal.timeout(1000));
  assert.equal(retry.status, "saved");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.equal(binding?.threadId, rejected.threadId);
  assert.equal(binding?.generation, rejected.generation + 1);
  const launches = fixture.operations.filter((call) => call.tag === "orchestration.launchThread");
  assert.equal(launches.length, 2);
  assert.notEqual(launches[0]?.payload.commandId, launches[1]?.payload.commandId);
  assert.equal(launches[0]?.payload.threadId, launches[1]?.payload.threadId);
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
});

it("a provider-disabled initial creation is durably rejected without automatic relaunch", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  after(t, fixture.cleanup);
  fixture.setProviderDisabledLaunchRejections(1);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();

  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.state, "rejected");
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  await supervisor.runOnce();
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
});

it("a provider-disabled objective does not block another main in the same project", async t => {
  const fixture = await makeFixture([{threadId: "first-thread", projectId: "project-a", turns: [{id: "first-task", sequence: 11, text: "Implement first"}]},
    {threadId: "second-thread", projectId: "project-a", turns: [{id: "second-task", sequence: 12, text: "Implement second"}]}]);
  after(t, fixture.cleanup);fixture.setProviderDisabledDispatches(1);
  await fixture.makeSupervisor().runOnce();
  assert.equal(fixture.supervisorStore.task("first-thread")?.status, "unavailable");
  assert.equal(fixture.supervisorStore.task("second-thread")?.status, "waiting");
  assert.notEqual(fixture.supervisorStore.task("first-thread")?.supervisorThreadId, fixture.supervisorStore.task("second-thread")?.supervisorThreadId);
});

it("a lost launch response recovers the native-created Supervisor without duplicate launch or ownership", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  after(t, fixture.cleanup);
  fixture.setUnknownLaunchResponses(1);
  await fixture.makeSupervisor().runOnce();

  const reserved = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(reserved);
  assert.equal(reserved.state, "ready", "the native-created thread is reconciled from its visible projection");
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
  assert.ok(fixture.projections.has(reserved.threadId), "the fake native server created the thread before losing its reply");

  await fixture.makeSupervisor().runOnce();
  const recovered = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.equal(recovered?.threadId, reserved.threadId);
  assert.equal(recovered?.state, "ready");
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
  assert.equal(fixture.supervisorStore.ownedIds.has(reserved.threadId), true);
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
});

it("an archived reserved binding is retained and never launched again", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  after(t, fixture.cleanup);
  fixture.setUnknownLaunchResponses(1);
  await fixture.makeSupervisor().runOnce();
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  const projection = fixture.projections.get(binding.threadId);
  assert.ok(projection);
  projection.thread.archivedAt = baseTime;

  await fixture.makeSupervisor().runOnce();
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.threadId, binding.threadId);
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.state, "ready");
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
});

it("workflow editing waits for classification and keeps No Project activation independent of definitions", async t => {
  const fixture = await makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  reserveReadyBinding(fixture);
  const supervisor = fixture.makeSupervisor();
  assert.equal(supervisor.workflowEditingEnabled("project-a"), false, "startup cannot bypass unknown Scratch classification");
  await supervisor.runOnce();
  assert.equal(supervisor.workflowEditingEnabled("project-a"), true);
  const guidance = fixture.supervisorStore.store;
  guidance.classify("project-a", "scratch", guidance.settings().generation);
  assert.equal(supervisor.workflowEditingEnabled("project-a"), false);
  fixture.supervisorStore.saveGlobalDefinitionsControl(0, true);
  assert.equal(supervisor.workflowEditingEnabled("project-a"), false);
  await supervisor.saveNoProjectControl({expectedGeneration: 0, mode: "automatic"}, AbortSignal.timeout(1000));
  assert.equal(supervisor.workflowEditingEnabled("project-a"), true);
  fixture.supervisorStore.saveGlobalDefinitionsControl(1, false);
  assert.equal(supervisor.workflowEditingEnabled("project-a"), true);
  guidance.classify("project-a", "project", guidance.settings().generation);
  assert.equal(supervisor.workflowEditingEnabled("project-a"), true);
  fixture.supervisorStore.saveControl("project-a", 1, false);
  assert.equal(supervisor.workflowEditingEnabled("project-a"), false);
  fixture.supervisorStore.saveControl("project-a", 2, true, {snapshotSequence: activationSequence, threads: []});
  assert.equal(supervisor.workflowEditingEnabled("project-a"), true);
  fixture.supervisorStore.saveControl(null, 0, false);
  assert.equal(supervisor.workflowEditingEnabled("project-a"), false);
});

it("global or project off still parks closed idle bindings without semantic work", { timeout: 60_000 }, async t => {
  const clock = {now: Date.parse(baseTime)};
  mockMethod(t, Date, "now", () => clock.now);
  for (const disabledScope of ["global", "project"] as const) {
    const fixture = await makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
    after(t, fixture.cleanup);
    const binding = reserveReadyBinding(fixture);
    fixture.projections.get("source-thread")!.thread.archivedAt = baseTime;
    if (disabledScope === "global") fixture.supervisorStore.saveControl(null, 0, false);
    else fixture.supervisorStore.saveControl("project-a", 1, false);

    const supervisor = fixture.makeSupervisor();
    await supervisor.runOnce();
    assert.equal(fixture.supervisorStore.binding("project-a", "source-thread")?.settlement, undefined);
    clock.now += SUPERVISOR_SETTLE_QUIET_MS + 1;
    await supervisor.runOnce();
    assert.equal(fixture.supervisorStore.binding("project-a", "source-thread")?.settlement?.state, "settled");
    assert.equal(fixture.operations.filter(call => call.payload.type === "thread.settle").length, 1);
    assert.equal(fixture.operations.some(call => call.payload.type === "message.dispatch" || call.tag === "orchestration.launchThread"), false);
    assert.equal(fixture.supervisorStore.task("source-thread"), null);
    assert.ok(fixture.projections.has(binding.threadId));
  }
});

it("disabled supervision never settles a closed main with an active Supervisor run", async t => {
  const fixture = await makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  const binding = reserveReadyBinding(fixture);
  fixture.projections.get("source-thread")!.thread.archivedAt = baseTime;
  const supervisorProjection = fixture.projections.get(binding.threadId)!;
  supervisorProjection.runs.push({id: "active-supervisor-run", threadId: binding.threadId, ordinal: 1, status: "running", requestedAt: baseTime,
    startedAt: baseTime, completedAt: null, rootNodeId: "active-supervisor-root"});
  fixture.supervisorStore.saveControl(null, 0, false);

  await fixture.makeSupervisor().runOnce();
  assert.equal(fixture.operations.some(call => call.payload.type === "thread.settle"), false);
  assert.equal(fixture.operations.some(call => call.payload.type === "message.dispatch" || call.tag === "orchestration.launchThread"), false);
  assert.equal(fixture.supervisorStore.binding("project-a", "source-thread")?.settlement, undefined);
});

it("missing-root replacement terminalizes helper check-ins after confirming active and previously missing helpers", async t => {
  const fixture = await makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  const binding = reserveReadyBinding(fixture);
  const supervisor = fixture.makeSupervisor();
  const reviewHelper = registerReadyHelper(fixture, supervisor, binding, "helper-review-missing");
  const reviewTarget = makeSourceProjection("operational-review", binding.projectId, []);
  reviewTarget.thread.lineage = {parentThreadId: binding.mainThreadId, relationshipToParent: "subagent", rootThreadId: binding.mainThreadId};
  fixture.projections.set(reviewTarget.thread.id, reviewTarget);
  const parents = new Map<string, string | null>([[binding.mainThreadId, null], [reviewTarget.thread.id, binding.mainThreadId]]);
  const assignment = supervisor.team.assign(binding, reviewTarget.thread.id, reviewHelper.threadId, parents, 10);
  const receive = supervisor.team.snapshot(binding).notifications.find(value => value.assignmentRootThreadId === reviewTarget.thread.id &&
    value.assignmentEpoch === assignment.epoch && value.kind === "handover_receive");
  assert.ok(receive);
  supervisor.team.updateNotificationDelivery(binding, binding.threadId, receive.id, "sending", 11, receive.deliveryAttempt);
  supervisor.team.updateNotificationDelivery(binding, binding.threadId, receive.id, "delivered", 12, receive.deliveryAttempt);
  supervisor.team.acknowledgeNotification(binding, reviewHelper.threadId, receive.id, reviewHelper.epoch, 13, receive.deliveryAttempt);
  supervisor.team.completeTransfer(binding, reviewTarget.thread.id, assignment.epoch, 14);
  const reviewCheckin = addPendingHelperCheckin(supervisor, binding, reviewHelper.threadId, "team-review:lost", 15);
  const reviewCoverage = supervisor.team.coverage(binding, reviewTarget.thread.id, parents);
  supervisor.team.recordRequest(binding, {requestId: reviewCheckin.id, memberThreadId: reviewHelper.threadId, memberEpoch: reviewHelper.epoch,
    targets: [{targetThreadId: reviewTarget.thread.id, assignmentRootThreadId: reviewCoverage.assignmentRootThreadId!,
      assignmentEpoch: reviewCoverage.assignmentEpoch!}], parentById: parents, now: 16});

  const readyThread = "helper-readiness-missing";
  const readyProjection = makeSourceProjection(readyThread, binding.projectId, []);
  readyProjection.thread.lineage = {parentThreadId: binding.threadId, relationshipToParent: "subagent", rootThreadId: binding.threadId};
  fixture.projections.set(readyThread, readyProjection);
  const registering = supervisor.team.registerMember(binding, {threadId: readyThread, taskId: `task-${readyThread}`, bootstrapRunId: `run-${readyThread}`, now: 17});
  const readinessCheckin = addPendingHelperCheckin(supervisor, binding, readyThread, "team-ready:lost", 18, "uncertain");
  supervisor.team.markMissing(binding, readyThread, 20);

  fixture.projections.delete(reviewHelper.threadId);
  fixture.projections.delete(readyThread);
  const missing = markRootMissing(fixture, binding);
  const outcome = await supervisor.retry(retryInput("project-a", 0, missing, "replace"), AbortSignal.timeout(5000));

  assert.equal(outcome.status, "saved");
  assert.notEqual(fixture.supervisorStore.binding("project-a", "source-thread")?.threadId, binding.threadId);
  for (const checkin of [reviewCheckin, readinessCheckin]) {
    const failed = supervisor.conversation.requests.requests(binding.projectId, checkin.supervisorThreadId).find(value => value.id === checkin.id);
    assert.equal(failed?.state, "failed");
    assert.match(failed?.error ?? "", /conversation is confirmed missing/u);
  }
  const teamReview = fixture.supervisorStore.store.db.prepare("SELECT document FROM supervisor_team_requests WHERE owner_thread_id=? AND owner_generation=? AND request_id=?")
    .get(binding.threadId, binding.generation, reviewCheckin.id);
  assert.equal(JSON.parse(String(teamReview?.document)).state, "settled");
  assert.equal(fixture.supervisorStore.ownedIds.has(reviewHelper.threadId), true);
  assert.equal(fixture.supervisorStore.ownedIds.has(registering.threadId), true);
});

it("explicit root replacement confirms missing helpers, retires owned webhook jobs, and retains team history", async t => {
  const fixture = await makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  const binding = reserveReadyBinding(fixture);
  const supervisor = fixture.makeSupervisor();
  const deletedHelper = registerReadyHelper(fixture, supervisor, binding, "helper-deleted");
  const archivedHelper = registerReadyHelper(fixture, supervisor, binding, "helper-archived");
  fixture.projections.delete(deletedHelper.threadId);
  fixture.projections.get(archivedHelper.threadId)!.thread.archivedAt = baseTime;
  const ownedTasks = [deletedHelper, archivedHelper].map((helper, index) => {
    const taskId = `owned-helper-webhook-${index}`;
    const createdAt = `2026-10-16T10:0${index}:00.000Z`;
    fixture.supervisorStore.store.db.prepare("INSERT INTO supervisor_helper_channels VALUES(?,?,?,?)")
      .run(binding.threadId, binding.generation, helper.threadId, JSON.stringify({taskId, helperThreadId: helper.threadId, createdAt, state: "ready"}));
    return {id: taskId, threadId: helper.threadId, projectId: binding.projectId, prompt: "{{body.text}}", schedule: {type: "webhook"}, createdAt};
  });
  fixture.setScheduledTasks(ownedTasks);
  const missing = markRootMissing(fixture, binding);

  const outcome = await supervisor.retry(retryInput("project-a", 0, missing, "replace"), AbortSignal.timeout(5000));

  assert.equal(outcome.status, "saved");
  const current = fixture.supervisorStore.binding("project-a", "source-thread");
  assert.ok(current);
  assert.notEqual(current.threadId, binding.threadId);
  assert.ok(fixture.supervisorStore.ownedIds.has(binding.threadId));
  for (const helper of [deletedHelper, archivedHelper]) {
    const memberRow = fixture.supervisorStore.store.db.prepare("SELECT document FROM supervisor_team_members WHERE owner_thread_id=? AND owner_generation=? AND member_thread_id=?")
      .get(binding.threadId, binding.generation, helper.threadId);
    assert.equal(JSON.parse(String(memberRow?.document)).state, "missing");
    assert.ok(fixture.supervisorStore.ownedIds.has(helper.threadId));
    assert.ok(fixture.operations.some(call => call.tag === "scheduledTasks.delete" && ownedTasks.some(task =>
      task.threadId === helper.threadId && call.payload.id === task.id)));
  }
  assert.equal(fixture.scheduledTasks.length, 0);
  assert.equal(fixture.supervisorStore.store.db.prepare("SELECT count(*) AS n FROM supervisor_team_events WHERE owner_thread_id=? AND owner_generation=? AND json_extract(document,'$.kind')='member_missing'")
    .get(binding.threadId, binding.generation)?.n, 2);
});

it("missing-root replacement refuses a still-present helper without retiring or relabeling it", async t => {
  const fixture = await makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  const binding = reserveReadyBinding(fixture);
  const supervisor = fixture.makeSupervisor();
  const helper = registerReadyHelper(fixture, supervisor, binding, "helper-still-present");
  const missing = markRootMissing(fixture, binding);

  const outcome = await supervisor.retry(retryInput("project-a", 0, missing, "replace"), AbortSignal.timeout(5000));

  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.message, /still present in T3/u);
  assert.equal(fixture.supervisorStore.binding("project-a", "source-thread")?.threadId, binding.threadId);
  const memberRow = fixture.supervisorStore.store.db.prepare("SELECT document FROM supervisor_team_members WHERE owner_thread_id=? AND owner_generation=? AND member_thread_id=?")
    .get(binding.threadId, binding.generation, helper.threadId);
  assert.equal(JSON.parse(String(memberRow?.document)).state, "ready");
  assert.equal(fixture.operations.some(call => call.tag === "scheduledTasks.delete" || call.tag === "orchestration.launchThread"), false);
});

it("missing-root replacement fails closed when a known helper lookup is uncertain", async t => {
  const fixture = await makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  const binding = reserveReadyBinding(fixture);
  const supervisor = fixture.makeSupervisor();
  const helper = registerReadyHelper(fixture, supervisor, binding, "helper-lookup-unknown");
  const missing = markRootMissing(fixture, binding);
  fixture.setProjectionFailure(helper.threadId, new T3TransportError("projection unavailable", 503));

  const outcome = await supervisor.retry(retryInput("project-a", 0, missing, "replace"), AbortSignal.timeout(5000));

  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.message, /could not verify every registered helper/u);
  assert.equal(fixture.supervisorStore.binding("project-a", "source-thread")?.threadId, binding.threadId);
  const memberRow = fixture.supervisorStore.store.db.prepare("SELECT document FROM supervisor_team_members WHERE owner_thread_id=? AND owner_generation=? AND member_thread_id=?")
    .get(binding.threadId, binding.generation, helper.threadId);
  assert.equal(JSON.parse(String(memberRow?.document)).state, "ready");
  assert.equal(fixture.operations.some(call => call.tag === "scheduledTasks.delete" || call.tag === "orchestration.launchThread"), false);
});

it("missing-root replacement preserves and remains blocked by an uncertain helper effect", async t => {
  const fixture = await makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  after(t, fixture.cleanup);
  const binding = reserveReadyBinding(fixture);
  const supervisor = fixture.makeSupervisor();
  const helper = registerReadyHelper(fixture, supervisor, binding, "helper-uncertain-effect");
  const target = makeSourceProjection("operational-thread", binding.projectId, []);
  target.thread.lineage = {parentThreadId: binding.mainThreadId, relationshipToParent: "subagent", rootThreadId: binding.mainThreadId};
  fixture.projections.set(target.thread.id, target);
  const parents = new Map<string, string | null>([[binding.mainThreadId, null], [target.thread.id, binding.mainThreadId]]);
  const assignment = supervisor.team.assign(binding, target.thread.id, helper.threadId, parents);
  const receive = supervisor.team.snapshot(binding).notifications.find(value => value.assignmentRootThreadId === target.thread.id &&
    value.assignmentEpoch === assignment.epoch && value.kind === "handover_receive");
  assert.ok(receive);
  supervisor.team.updateNotificationDelivery(binding, binding.threadId, receive.id, "sending");
  supervisor.team.updateNotificationDelivery(binding, binding.threadId, receive.id, "delivered");
  supervisor.team.acknowledgeNotification(binding, helper.threadId, receive.id, helper.epoch);
  supervisor.team.completeTransfer(binding, target.thread.id, assignment.epoch);
  const coverage = supervisor.team.coverage(binding, target.thread.id, parents);
  const request = supervisor.team.recordRequest(binding, {requestId: "guide:unknown-result", memberThreadId: helper.threadId, memberEpoch: helper.epoch,
    targets: [{targetThreadId: target.thread.id, assignmentRootThreadId: coverage.assignmentRootThreadId!, assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents});
  const checkin = addPendingHelperCheckin(supervisor, binding, helper.threadId, "team-review:effect-checkin", 10, "uncertain");
  supervisor.team.recordRequest(binding, {requestId: checkin.id, memberThreadId: helper.threadId, memberEpoch: helper.epoch,
    targets: [{targetThreadId: target.thread.id, assignmentRootThreadId: coverage.assignmentRootThreadId!, assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents, now: 11});
  supervisor.team.setRequestState(binding, helper.threadId, request.requestId, helper.epoch, "uncertain");
  const missing = markRootMissing(fixture, binding);
  fixture.projections.delete(helper.threadId);

  const outcome = await supervisor.retry(retryInput("project-a", 0, missing, "replace"), AbortSignal.timeout(5000));

  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.message, /unresolved handover state or native effects/u);
  assert.equal(fixture.supervisorStore.binding("project-a", "source-thread")?.threadId, binding.threadId);
  assert.equal(fixture.supervisorStore.ownedIds.has(helper.threadId), true);
  const memberRow = fixture.supervisorStore.store.db.prepare("SELECT document FROM supervisor_team_members WHERE owner_thread_id=? AND owner_generation=? AND member_thread_id=?")
    .get(binding.threadId, binding.generation, helper.threadId);
  assert.equal(JSON.parse(String(memberRow?.document)).state, "missing");
  const requestRow = fixture.supervisorStore.store.db.prepare("SELECT document FROM supervisor_team_requests WHERE owner_thread_id=? AND owner_generation=? AND request_id=?")
    .get(binding.threadId, binding.generation, request.requestId);
  assert.equal(JSON.parse(String(requestRow?.document)).state, "uncertain");
  const checkinTeamRequest = fixture.supervisorStore.store.db.prepare("SELECT document FROM supervisor_team_requests WHERE owner_thread_id=? AND owner_generation=? AND request_id=?")
    .get(binding.threadId, binding.generation, checkin.id);
  assert.equal(JSON.parse(String(checkinTeamRequest?.document)).state, "settled");
  assert.equal(supervisor.conversation.requests.requests(binding.projectId, helper.threadId).find(value => value.id === checkin.id)?.state, "failed");
  assert.equal(fixture.operations.some(call => call.tag === "orchestration.launchThread"), false);
});

it("a stale retry intent cannot replace a missing binding; explicit replacement retains old ownership", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const original = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  const originalTask = fixture.supervisorStore.task("source-thread");
  assert.ok(original && originalTask);
  fixture.projections.delete(original.threadId);
  await supervisor.runOnce();
  const missing = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.equal(missing?.state, "missing");

  const staleRetry = await supervisor.retry(retryInput("project-a", 0, original, "retry"), AbortSignal.timeout(1000));
  assert.equal(staleRetry.status, "conflict");
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.threadId, original.threadId);
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);

  const replacement = await supervisor.retry(retryInput("project-a", 0, missing!, "replace"), AbortSignal.timeout(1000));
  assert.equal(replacement.status, "saved");
  const current = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(current);
  assert.notEqual(current.threadId, original.threadId);
  assert.equal(fixture.supervisorStore.ownedIds.size, 2);
  assert.equal(fixture.supervisorStore.ownedIds.has(original.threadId), true);
  assert.equal(fixture.supervisorStore.ownedIds.has(current.threadId), true);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 2);
  const retained = fixture.supervisorStore.task("source-thread");
  assert.equal(retained?.status, "unavailable");
  assert.equal(retained?.id, originalTask.id);
  assert.equal(retained?.messageId, originalTask.messageId);
});

it("a changed source invalidates a completed Supervisor result without an operational reply", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Deploy the release" }] },
  ]);
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const task = fixture.supervisorStore.task("source-thread");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(task && binding);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  completeSupervisorRequest(supervisorProjection, task.messageId,
    workflowResult(task.sourceMessageId, "Deploy the release", "The source request asks for a deployment."));

  const sourceProjection = fixture.projections.get("source-thread");
  assert.ok(sourceProjection);
  sourceProjection.messages[0]!.text = "Actually, do not deploy anything";
  await supervisor.runOnce();
  const stale = fixture.supervisorStore.task("source-thread");
  assert.equal(stale?.status, "unavailable");
  assert.equal(stale?.objective, null);
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 1);
  assert.equal(fixture.operations.some((call) => ["runtime-request.respond", "thread.interrupt"].includes(String(call.payload.type))), false);
});

it("a completed interpretation with unrelated source IDs is rejected", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a release checklist" }] },
  ]);
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const task = fixture.supervisorStore.task("source-thread");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(task && binding);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  const unrelated = JSON.parse(workflowResult(task.sourceMessageId, "Publish a release", "This response cites another message.")) as Record<string, unknown>;
  unrelated.sourceMessageIds = ["unrelated-message"];
  completeSupervisorRequest(supervisorProjection, task.messageId, JSON.stringify(unrelated));

  await supervisor.runOnce();
  const rejected = fixture.supervisorStore.task("source-thread");
  assert.equal(rejected?.status, "unavailable");
  assert.equal(rejected?.objective, null);
  assert.match(rejected?.reason ?? "", /valid, source-linked interpretation/u);
});

it("interrupted and stalled Supervisor runs become unavailable without answers or interruption commands", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "first-task", sequence: 11, text: "Review the release" }] },
  ]);
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  const first = fixture.supervisorStore.task("source-thread");
  assert.ok(binding && first);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  const firstRun = supervisorProjection.runs.find((run) => run.userMessageId === first.messageId);
  assert.ok(firstRun);
  firstRun.status = "interrupted";
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "unavailable");

  fixture.addTurn("source-thread", "project-a", { id: "second-task", sequence: 12, text: "Check the rollout plan" });
  await supervisor.runOnce();
  const second = fixture.supervisorStore.task("source-thread");
  assert.equal(second?.status, "waiting");
  assert.ok(second);
  const secondRun = supervisorProjection.runs.find((run) => run.userMessageId === second.messageId);
  assert.ok(secondRun);
  secondRun.status = "waiting";
  secondRun.startedAt = new Date(Date.now() - 301_000).toISOString();
  fixture.supervisorStore.saveTask({ ...second, dispatchedAt: Date.now() - 301_000 });
  await supervisor.runOnce();

  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "unavailable");
  assert.match(fixture.supervisorStore.task("source-thread")?.reason ?? "", /does not answer or interrupt/u);
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 2);
  assert.equal(fixture.operations.some((call) => ["runtime-request.respond", "thread.interrupt", "runtime-request.interrupt"].includes(String(call.payload.type))), false);
  assert.equal(fixture.projections.get("source-thread")?.messages.length, 2);
});

it("queued and not-yet-started Supervisor runs do not time out from stale dispatch time", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "first-task", sequence: 11, text: "Review the release" }] },
  ]);
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  const task = fixture.supervisorStore.task("source-thread");
  assert.ok(binding && task);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  const run = supervisorProjection.runs.find((candidate) => candidate.userMessageId === task.messageId);
  assert.ok(run);

  fixture.supervisorStore.saveTask({ ...task, dispatchedAt: Date.now() - 301_000 });
  run.status = "queued";
  run.startedAt = null;
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");

  run.status = "running";
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");

  run.startedAt = new Date(Date.now() - 301_000).toISOString();
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "unavailable");
});

it("agreement snapshots preserve mixed plans through restart and mark replaced ownership stale", async (t) => {
  const fixture = await makeFixture([{threadId: "agreement-source", projectId: "project-a", turns: [{id: "agreement-task", sequence: 11, text: "Add CSV export"}]}]);
  after(t, fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const task = fixture.supervisorStore.task("agreement-source")!;
  const workflow = workflowSnapshot();
  const agreement = {status: "agreed" as const, message: "Both conversations confirmed the plan", proposalId: "csv-1", agreedAt: Date.now(),
    supervisorMessageId: "supervisor-proof", agentMessageId: "operative-proof", workflow};
  const diagnostic = {role: "operative" as const, proposalId: "csv-2", messageId: "compact-acceptance", code: "record_fields", observedAt: Date.now()};
  fixture.supervisorStore.saveTask({...task, status: "inferred", objective: "Add CSV export", workflow, workflowProposalId: "csv-2", agreement,
    workflowProtocolDiagnostic: diagnostic});
  fixture.restart();
  const restored = fixture.makeSupervisor();
  const snapshot = Schema.decodeUnknownSync(ProjectSupervisorSnapshot)(await restored.snapshot("project-a", new AbortController().signal, "agreement-source"));
  assert.equal(snapshot.tasks[0]?.workflowProposalId, "csv-2");
  assert.deepEqual(snapshot.tasks[0]?.agreement, agreement);
  assert.deepEqual(snapshot.tasks[0]?.workflowProtocolDiagnostic, diagnostic);
  assert.equal(snapshot.tasks[0]?.workflow?.plan?.nodes[0]?.kind, "step");
  if (snapshot.tasks[0]?.workflow?.plan?.nodes[0]?.kind === "step") assert.equal(snapshot.tasks[0].workflow?.plan?.nodes[0]?.localId, "csv-export");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)!;
  fixture.supervisorStore.setBinding({...binding, state: "missing", deliveredRoleVersion: "delivered-to-old-root"});
  const replaced = fixture.supervisorStore.replaceMissingBinding({...binding, state: "missing", deliveredRoleVersion: "delivered-to-old-root"}, defaultSupervisorModel);
  assert.equal(replaced.deliveredRoleVersion, undefined, "a replacement conversation receives the full standing instructions again");
  const stale = fixture.supervisorStore.task("agreement-source")?.agreement;
  assert.equal(stale?.status, "stale");
  assert.equal(stale?.supervisorMessageId, "supervisor-proof");
  assert.deepEqual(stale?.workflow, workflow);
});

it("task payload expiry clears retained agreement plans and current proposal identity", async (t) => {
  const fixture = await makeFixture([{threadId: "expiry-source", projectId: "project-a", turns: [{id: "expiry-task", sequence: 11, text: "Add CSV export"}]}]);
  after(t, fixture.cleanup);
  await fixture.makeSupervisor().runOnce();
  const task = fixture.supervisorStore.task("expiry-source")!;
  const workflow = workflowSnapshot(false);
  fixture.supervisorStore.saveTask({...task, status: "inferred", workflow, workflowProposalId: "csv-1", updatedAt: 1,
    agreement: {status: "agreed", message: "Accepted", proposalId: "csv-1", agreedAt: 1, supervisorMessageId: "supervisor-proof", agentMessageId: "operative-proof", workflow}});
  fixture.supervisorStore.prune(32 * day);
  assert.equal(fixture.supervisorStore.task("expiry-source")?.agreement?.status, "agreed", "a retained ready scope survives long idle periods");
  const binding = fixture.supervisorStore.binding("project-a", "expiry-source")!;
  fixture.supervisorStore.setBinding({...binding, state: "missing"});
  fixture.supervisorStore.prune(32 * day);
  const expired = fixture.supervisorStore.task("expiry-source");
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.agreement, null);
  assert.equal(expired?.workflow, null);
  assert.equal(expired?.workflowProposalId, undefined);
});

it("explicit editor authorization binds exact complete definition contents and workspace", async t => {
  const fixture = await makeFixture([]);after(t, fixture.cleanup);
  const source = makeDefinitionFixture({projectId: "project-a", root: "/work/a", threadRoot: "/work/a"});
  source.addFile("/work/a", ".t3-supervisor/steps/verify.md", stepSource("verify", "Check the changed behavior."));
  source.addDirectory("/work/a", ".t3-supervisor/workflows");
  source.writeIndex("/work/a", {required: [{step: "verify"}]});
  const approved = await source.loader.load("project-a", "thread", AbortSignal.timeout(2000));
  assert.equal(approved.status, "ready");
  assert.ok(approved.projectConfig);
  const changedConfig = {...approved, revision: "edited-revision", projectConfig: projectIndex({steps: ["verify"]}), config: effectiveIndex(approved)};
  fixture.supervisorStore.recordDefinitionUserSave(changedConfig, approved.revision!);
  assert.equal(fixture.supervisorStore.definitionUserSave({...changedConfig, threadId: "operative", revision: "bound-revision"}, approved, 0), true);
  assert.equal(fixture.supervisorStore.definitionUserSave({...changedConfig, workspaceRoot: "/work/other"}, approved, 0), false);
  assert.equal(fixture.supervisorStore.definitionUserSave({...changedConfig, status: "invalid"}, approved, 0), false);
  const editedStep = {...changedConfig, steps: changedConfig.steps.map(step => ({...step, description: "Skip all checks."}))};
  assert.equal(fixture.supervisorStore.definitionUserSave(editedStep, approved, 0), false);
  const editedSummary = {...changedConfig, projectConfig: {...changedConfig.projectConfig, steps: changedConfig.projectConfig.steps.map(entry => ({...entry, summary: "Skip all checks."}))}};
  assert.equal(fixture.supervisorStore.definitionUserSave(editedSummary, approved, 0), false, "the signed index covers summaries");
  assert.equal(fixture.supervisorStore.definitionUserSave(changedConfig, approved, Date.now() + 1000), false);
  fixture.supervisorStore.recordDefinitionUserSave(approved, approved.revision!);
  fixture.restart();
  assert.equal(fixture.supervisorStore.definitionUserSave(approved, approved, 0), true);
});

it("parallel main worktrees retain distinct ownership and scoped recovery through restart", async t => {
  const fixture = await makeFixture([{threadId: "tree-a", projectId: "project-a", turns: [{id: "a-task", sequence: 11, text: "Implement in tree A"}]},
    {threadId: "tree-b", projectId: "project-a", turns: [{id: "b-task", sequence: 12, text: "Implement in tree B"}]}]);
  after(t, fixture.cleanup);
  fixture.projections.get("tree-a")!.thread.worktreePath = "/work/a/tree-a";fixture.projections.get("tree-b")!.thread.worktreePath = "/work/a/tree-b";
  fixture.setUnknownDispatches(1);await fixture.makeSupervisor().runOnce();
  const a = fixture.supervisorStore.binding("project-a", "tree-a")!;const b = fixture.supervisorStore.binding("project-a", "tree-b")!;
  assert.notEqual(a.threadId, b.threadId);assert.equal(fixture.supervisorStore.task("tree-a")?.status, "uncertain");assert.equal(fixture.supervisorStore.task("tree-b")?.status, "waiting");
  const bTask = fixture.supervisorStore.task("tree-b")!;
  fixture.restart();const restored = fixture.makeSupervisor();
  const mismatch = await restored.retry({...retryInput("project-a", 0, a, "retry"), mainThreadId: "tree-b"}, AbortSignal.timeout(1000));
  assert.equal(mismatch.status, "conflict");assert.deepEqual(fixture.supervisorStore.task("tree-b"), bTask);
  assert.equal((await restored.snapshot("project-a", AbortSignal.timeout(1000), "tree-b")).binding?.threadId, b.threadId);
  assert.equal((await restored.snapshot("project-a", AbortSignal.timeout(1000), "tree-a")).tasks[0]?.threadId, "tree-a");
  assert.ok(fixture.operations.filter(call => call.tag === "orchestration.launchThread").every(call => (call.payload.workspaceStrategy as {type: string}).type === "root"));
});

it("a native keep-active choice does not restore stale binding creation state", async t => {
  const fixture = await makeFixture([{threadId: "pinned-source", projectId: "project-a", turns: [{id: "pin-task", sequence: 11, text: "Implement a task"}]}]);
  after(t, fixture.cleanup);const supervisor = fixture.makeSupervisor();await supervisor.runOnce();
  const binding = fixture.supervisorStore.binding("project-a", "pinned-source")!;
  fixture.supervisorStore.setBinding({...binding, state: "uncertain"});
  fixture.projections.get(binding.threadId)!.thread.settledOverride = "active";
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.binding("project-a", "pinned-source")?.state, "ready");
  assert.equal(fixture.supervisorStore.binding("project-a", "pinned-source")?.manualKeepActive, true);
});


it("an independent fork remains eligible when its old parent is absent from the active catalog", async t => {
  const fixture = await makeFixture([{threadId: "fork-main", projectId: "project-a", turns: [{id: "fork-task", sequence: 11, text: "Implement separately"}]}]);
  after(t, fixture.cleanup);fixture.projections.get("fork-main")!.thread.lineage = {parentThreadId: "archived-parent", relationshipToParent: "fork", rootThreadId: "historical-root"};
  await fixture.makeSupervisor().runOnce();assert.equal(fixture.supervisorStore.task("fork-main")?.status, "waiting");
  assert.ok(fixture.supervisorStore.binding("project-a", "fork-main"));
});

it("repeated short passes rotate past a hung Supervisor and keep later mains progressing", async t => {
  const initial = Array.from({length: 9}, (_, index) => ({threadId: `main-${index}`, projectId: "project-a", turns: [{id: `old-${index}`, sequence: 9, text: "Old task"}]}));
  const fixture = await makeFixture(initial);after(t, fixture.cleanup);
  const ids = new Map<string, string>();const touched = new Set<string>();
  for (const item of initial) {
    const binding = {...fixture.supervisorStore.reserve("project-a", item.threadId, item.threadId, defaultSupervisorModel, 10, Date.now()), state: "ready" as const};
    fixture.supervisorStore.setBinding(binding);ids.set(binding.threadId, item.threadId);
    fixture.projections.set(binding.threadId, emptySupervisorProjection(binding.threadId, "project-a", defaultSupervisorModel));
  }
  const supervisor = fixture.makeSupervisor();const original = supervisor.t3.projection;
  mockMethod(t, supervisor.t3, "projection", (id: string) => {
    const main = ids.get(id);if (main) touched.add(main);
    return main === "main-0" ? Effect.never : original(id);
  });
  for (let attempt = 0; attempt < 3; attempt++) await supervisor.runOnce(AbortSignal.timeout(25));
  assert.equal(touched.size, 9, "the same slow first binding must not permanently hide tail mains");
});

it("a main conversation over the buffered cap is discovered and interpreted from its exact old source", { timeout: 60_000 }, async (t) => {
  const turns: Turn[] = [{ id: "before-activation", sequence: 5, text: "Earlier unrelated request" },
    { id: "old-task", sequence: 11, text: "Build the invoice export" },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `later-${index}`, sequence: 12 + index, text: `Follow-up request ${index}` }))];
  const fixture = await makeFixture([{ threadId: "huge-main", projectId: "project-a", turns }]);
  after(t, fixture.cleanup);
  // every native read is served in full over HTTP, padded with arrays the Supervisor never reads
  const retainedBudget = 96 * 1024;
  const padding = Array.from({ length: 300 }, (_, index) => ({ position: index, visibility: "local", sourceThreadId: "huge-main",
    sourceItemId: `row-${index}`, item: { id: `row-${index}`, text: "p".repeat(1000) } }));
  let largestBody = 0;
  const server = createServer((request, response) => {
    const id = decodeURIComponent((request.url ?? "").replace("/api/orchestration/threads/", ""));
    const projection = fixture.projections.get(id);
    if (!projection) {response.writeHead(404).end();return;}
    const body = JSON.stringify({ snapshotSequence: 20, projection: { ...projection, visibleTurnItems: padding, checkpoints: padding.slice(0, 40) } });
    largestBody = Math.max(largestBody, Buffer.byteLength(body));
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  after(t, () => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(makeT3Client({ baseUrl: `http://127.0.0.1:${address.port}`, token: "test-token", maxResponseBytes: retainedBudget }));
    return Context.get(context, T3Client);
  })));
  fixture.useNativeProjection(threadId => client.projection(threadId));

  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  assert.ok(largestBody > 2 * retainedBudget, "the native body exceeds what the buffered reader accepts");
  const task = fixture.supervisorStore.task("huge-main");
  assert.equal(task?.sourceMessageId, "old-task", "the first request after activation stays the source behind twelve newer turns");
  assert.equal(task?.sourceRunId, "run-old-task");
  assert.equal(task?.status, "waiting");
  const binding = fixture.supervisorStore.bindings().find(value => value.mainThreadId === "huge-main");
  assert.ok(binding);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  completeSupervisorRequest(supervisorProjection, task.messageId, workflowResult("old-task", "Build the invoice export",
    "The source request asks for an export to be built."));
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("huge-main")?.status, "inferred");
  assert.equal(fixture.supervisorStore.task("huge-main")?.objective, "Build the invoice export");
});

const noProjectFixture = async () => {
  const fixture = await makeFixture([{threadId: "manual", projectId: "project-a", turns: []}, {threadId: "other", projectId: "project-a", turns: []}]);
  fixture.supervisorStore.store.db.prepare("INSERT INTO classifications VALUES(?,?)").run("project-a", "scratch");
  const policy = new ThreadPolicyStore(fixture.directory, {excludedThreadIds: []});fixture.config.threadPolicy = policy;
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  fixture.addTurn("manual", "project-a", {id: "request-start", sequence: 20, text: "Have Supervisor follow this task: add a CSV export."});
  const projection = fixture.projections.get("manual")!;
  projection.messages[0]!.createdAt = new Date(Date.now() - 1000).toISOString();
  return {fixture, supervisor, policy, cleanup: async () => {policy.close();await fixture.cleanup();}};
};

it("No Project defaults to On request and shared definitions never activate a chat", async () => {
  const f = await noProjectFixture();
  try {
    assert.equal(f.supervisor.noProjectControl().mode, "on_request");
    f.fixture.supervisorStore.saveGlobalDefinitionsControl(0, true);
    await f.supervisor.runOnce();
    assert.equal(f.fixture.operations.length, 0);
    assert.equal(f.fixture.supervisorStore.bindings().length, 0);
    assert.equal(f.supervisor.scopeEnabled("project-a", "manual"), false);
    assert.equal(f.supervisor.scopeEnabled("project-b", "ordinary"), true);
  } finally {await f.cleanup();}
});

it("native Start runs one intent interpretation, grants only that chat and survives restart", async () => {
  const f = await noProjectFixture();
  try {
    const args = {callerThreadId: "manual", userMessageId: "request-start", operationId: "own-start"};
    const result = await f.supervisor.startSupervision(args, {runId: "run-request-start"}, AbortSignal.timeout(1000));
    assert.equal(result.status, "pending");
    await f.supervisor.runOnce();
    const task = f.fixture.supervisorStore.task("manual")!;assert.ok(task);
    assert.equal(f.supervisor.scopeEnabled("project-a", "manual"), false);
    assert.equal(f.supervisor.workflowEditingEnabled("project-a", "manual"), false);
    assert.match(task.requestText, /startRequested/);
    assert.equal(f.fixture.operations.filter(op => op.payload.type === "message.dispatch").length, 1);
    const root = f.fixture.projections.get(task.supervisorThreadId)!;
    completeSupervisorRequest(root, task.messageId, JSON.stringify({objective: null, reason: "User requested supervision; awaiting a substantive task.", sourceMessageIds: [args.userMessageId], startRequested: true, workflow: null}));
    await f.supervisor.runOnce();
    assert.equal(f.fixture.supervisorStore.start("manual")?.status, "active", JSON.stringify({start:f.fixture.supervisorStore.start("manual"),task:f.fixture.supervisorStore.task("manual")}));
    assert.equal(f.supervisor.scopeEnabled("project-a", "manual"), true);
    assert.equal(f.supervisor.scopeEnabled("project-a", "other"), false);
    assert.equal(f.fixture.supervisorStore.task("manual")?.status, "needs_context");
    const originalTask = task.id;
    await f.supervisor.runOnce();assert.equal(f.fixture.supervisorStore.task("manual")?.id, originalTask);
    f.fixture.restart();const resumed = f.fixture.makeSupervisor();await resumed.runOnce();
    assert.equal(resumed.scopeEnabled("project-a", "manual"), true);
    assert.equal(resumed.scopeEnabled("project-a", "other"), false);
  } finally {await f.cleanup();}
});

it("negative Start intent and later Stop fence interpretation without operative contact", { timeout: 60_000 }, async () => {
  for (const outcome of ["negative", "stop", "mode", "edited"] as const) {
    const f = await noProjectFixture();
    try {
      const args = {callerThreadId: "manual", userMessageId: "request-start", operationId: "start"};
      await f.supervisor.startSupervision(args, {runId: "run-request-start"}, AbortSignal.timeout(1000));await f.supervisor.runOnce();
      const task = f.fixture.supervisorStore.task("manual")!;
      if (outcome === "stop") await f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: f.policy.get().generation, enabled: false}, AbortSignal.timeout(1000));
      if (outcome === "mode") await f.supervisor.saveNoProjectControl({expectedGeneration: 0, mode: "off"}, AbortSignal.timeout(1000));
      if (outcome === "edited") f.fixture.projections.get("manual")!.messages[0]!.text = "Changed request";
      completeSupervisorRequest(f.fixture.projections.get(task.supervisorThreadId)!, task.messageId, JSON.stringify({objective: null, reason: "No task", sourceMessageIds: [args.userMessageId], startRequested: outcome !== "negative", workflow: null}));
      await f.supervisor.runOnce();
      assert.equal(f.supervisor.scopeEnabled("project-a", "manual"), false, outcome);
      assert.equal(f.fixture.operations.filter(op => op.payload.threadId === "manual").length, 0, outcome);
    } finally {await f.cleanup();}
  }
});

it("dashboard Start grants next-request permission when current work is already finished", async () => {
  const f = await noProjectFixture();
  try {
    assert.equal((await f.supervisor.dashboardStart("manual", "dashboard", AbortSignal.timeout(1000))).status, "active");
    await f.supervisor.runOnce();
    assert.equal(f.fixture.supervisorStore.task("manual"), null);
    assert.equal(f.fixture.operations.length, 0);
    assert.equal((await f.supervisor.dashboardStart("manual", "dashboard", AbortSignal.timeout(1000))).status, "active");
    assert.equal(f.fixture.supervisorStore.start("manual")?.taskId, null);
    const off = await f.supervisor.saveNoProjectControl({expectedGeneration: 0, mode: "off"}, AbortSignal.timeout(1000));
    assert.equal(off.status, "saved");assert.equal(f.supervisor.scopeEnabled("project-a", "manual"), false);
    await f.supervisor.saveNoProjectControl({expectedGeneration: 1, mode: "on_request"}, AbortSignal.timeout(1000));
    assert.equal(f.supervisor.scopeEnabled("project-a", "manual"), true);
  } finally {await f.cleanup();}
});

it("Start intake requires exact native own-run proof before reserving permission", { timeout: 60_000 }, async () => {
  for (const variant of ["direct", "mcpx", "forged", "foreign", "rollback", "wrong_tool"] as const) {
    const f = await noProjectFixture();
    try {
      const args = {callerThreadId: "manual", userMessageId: "request-start", operationId: "native-start"};
      const caller = f.fixture.projections.get("manual")!;const run = caller.runs[0]!;
      if (variant === "rollback") run.status = "rolled_back";
      const nodeId = "native-start-node";
      (caller.nodes as Array<Record<string, unknown>>).push({id: nodeId, kind: "dynamic_tool", threadId: "manual", runId: run.id, rootNodeId: run.rootNodeId, parentNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, status: "completed"});
      const item = {id: "native-start-item", type: "dynamic_tool", threadId: variant === "foreign" ? "other" : "manual", runId: run.id, nodeId, providerThreadId: run.providerThreadId,
        nativeItemRef: {driver: "codex", nativeId: "native-start-item", strength: "strong"}, parentItemId: null, ordinal: 2, status: "completed", toolNonExecutionKind: null,
        toolName: variant === "mcpx" ? "mcp__mcpx__mcpx_call_tool" : variant === "wrong_tool" ? "mcp__t3-supervisor-workflows__supervision_stop" : "mcp__t3-supervisor-workflows__supervision_start",
        input: variant === "mcpx" ? {name: "t3-supervisor-workflows__supervision_start", arguments: args} : variant === "forged" ? {...args, operationId: "other"} : args};
      caller.turnItems = [item];
      const controller = new WorkflowWriteController({supervisors: f.fixture.supervisorStore, workflows: f.supervisor.workflowStates, maxEvidenceWaitMs: 0,
        native: {listThreads: async () => [caller.thread], projection: async () => caller, getTurnItem: async () => ({item})},
        starts: {start: (input, evidence, signal) => f.supervisor.startSupervision(input, evidence, signal)}});
      const result = await controller.startSupervision(args);
      assert.equal(result.status === "pending" && f.fixture.supervisorStore.start("manual") !== null, variant === "direct" || variant === "mcpx", variant);
      assert.equal(f.fixture.operations.length, 0, "intake alone never calls a model or operative");
    } finally {await f.cleanup();}
  }
});

it("Start rejects nonhuman, wrong-turn, project and stale sources, and keeps duplicate operation identity", async () => {
  const f = await noProjectFixture();
  try {
    const args = {callerThreadId: "manual", userMessageId: "request-start", operationId: "identity"};
    assert.equal((await f.supervisor.startSupervision(args, {runId: "other-run"}, AbortSignal.timeout(1000))).status, "denied");
    const human = f.fixture.projections.get("manual")!.messages[0]!;human.creationSource = "mcp";args.operationId = "nonhuman";
    assert.equal((await f.supervisor.startSupervision(args, {runId: "run-request-start"}, AbortSignal.timeout(1000))).status, "denied");human.creationSource = "web";
    args.operationId = "stale";f.fixture.supervisorStore.saveUnboundStop("manual", {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: Date.now()});
    assert.equal((await f.supervisor.startSupervision(args, {runId: "run-request-start"}, AbortSignal.timeout(1000))).status, "denied");
    f.fixture.supervisorStore.saveUnboundStop("manual", null);args.operationId = "positive";
    assert.equal((await f.supervisor.startSupervision(args, {runId: "run-request-start"}, AbortSignal.timeout(1000))).status, "pending");
    const id = f.fixture.supervisorStore.start("manual")!.taskId;
    assert.equal((await f.supervisor.startSupervision(args, {runId: "run-request-start"}, AbortSignal.timeout(1000))).status, "pending");
    assert.equal(f.fixture.supervisorStore.start("manual")!.taskId, id);
  } finally {await f.cleanup();}
});

it("Retry reaches a started No Project chat and still reconciles Stop notice/settlement in ordinary projects", async () => {
  for (const noProject of [false, true]) {
    const f = await noProjectFixture();
    try {
      if (!noProject) f.fixture.supervisorStore.store.db.prepare("UPDATE classifications SET classification='project' WHERE project_id='project-a'").run();
      else await f.supervisor.dashboardStart("manual", "recovery-grant", AbortSignal.timeout(1000));
      const binding = reserveReadyBinding(f.fixture, "manual");
      const first = await f.supervisor.retry(retryInput("project-a", 0, binding, "retry"), AbortSignal.timeout(1000));
      assert.notEqual(first.status, "unavailable", noProject ? "started No Project recovery is reachable" : "ordinary recovery works");
      await f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: f.policy.get().generation, enabled: false}, AbortSignal.timeout(1000));
      const stopped = f.fixture.supervisorStore.binding("project-a", "manual")!;
      assert.ok(stopped.stopNotice);
      f.fixture.supervisorStore.setStopNotice(stopped, stopped.stopNotice.messageId, {...stopped.stopNotice, state: "unconfirmed"});
      f.fixture.supervisorStore.setBinding({...stopped, settlement: {commandId: "uncertain-settle", state: "uncertain", attempts: 3, observedAt: 1}});
      const before = f.fixture.operations.length;
      const result = await f.supervisor.retry(retryInput("project-a", 0, stopped, "retry"), AbortSignal.timeout(1000));
      assert.notEqual(result.status, "unavailable", JSON.stringify({noProject, result}));
      const retried = f.fixture.supervisorStore.binding("project-a", "manual")!;
      assert.equal(retried.stopNotice?.state, "uncertain");assert.equal(retried.stopNotice?.messageId, stopped.stopNotice.messageId);
      assert.equal(retried.settlement?.attempts, 0);assert.equal(retried.settlement?.commandId, "uncertain-settle");
      assert.equal(f.fixture.operations.length, before, "recovery rearms reconciliation without posting new work");
    } finally {await f.cleanup();}
  }
});

it("an inactive rejected Start parks its root without a human Stop or losing source history", async () => {
  const f = await noProjectFixture();
  try {
    await f.supervisor.startSupervision({callerThreadId: "manual", userMessageId: "request-start", operationId: "reject-and-park"}, {runId: "run-request-start"}, AbortSignal.timeout(1000));
    await f.supervisor.runOnce();const task = f.fixture.supervisorStore.task("manual")!;
    completeSupervisorRequest(f.fixture.projections.get(task.supervisorThreadId)!, task.messageId, JSON.stringify({objective: null, reason: "No Start intent", sourceMessageIds: [task.sourceMessageId], startRequested: false, workflow: null}));
    await f.supervisor.runOnce();await f.supervisor.runOnce();
    const binding = f.fixture.supervisorStore.binding("project-a", "manual")!;
    assert.equal(binding.settlement?.state, "settled");assert.equal(binding.supervisionStop, undefined);assert.equal(binding.stopObservedAt, undefined);
    assert.equal(f.policy.get().excludedThreadIds.length, 0);
    assert.equal(f.fixture.supervisorStore.task("manual")?.sourceMessageId, task.sourceMessageId);
    assert.equal(f.fixture.operations.filter(op => op.payload.threadId === "manual").length, 0);
  } finally {await f.cleanup();}
});

it("a Stop before any root exists still exposes its original caller/source/time without creating a conversation", async () => {
  const f = await noProjectFixture();
  try {
    f.fixture.addTurn("manual", "project-a", {id: "stop-without-root", sequence: 21, text: "Stop supervision for this chat."});
    const message = f.fixture.projections.get("manual")!.messages.at(-1)!;message.createdAt = new Date().toISOString();
    const result = await f.supervisor.stopSupervision({callerThreadId: "manual", targetThreadId: "manual", userMessageId: message.id, operationId: "unbound-stop"}, {runId: message.runId}, AbortSignal.timeout(1000));
    assert.equal(result.status, "stopped");
    const snapshot = await f.supervisor.snapshot("project-a", AbortSignal.timeout(1000), "manual");
    assert.equal(snapshot.binding, null);assert.equal(snapshot.chatSupervision?.stopped, true);
    assert.equal(snapshot.chatSupervision?.stoppedCallerThreadId, "manual");
    assert.equal(snapshot.chatSupervision?.stoppedUserMessageId, message.id);
    assert.equal(snapshot.chatSupervision?.stoppedAt, Date.parse(message.createdAt));
    assert.equal(f.fixture.operations.length, 0);
  } finally {await f.cleanup();}
});

it("a later human task survives repeated discovery and restart without recreating the Start interpretation", async () => {
  const f = await noProjectFixture();
  try {
    await f.supervisor.startSupervision({callerThreadId: "manual", userMessageId: "request-start", operationId: "start-handoff"}, {runId: "run-request-start"}, AbortSignal.timeout(1000));await f.supervisor.runOnce();
    const initial = f.fixture.supervisorStore.task("manual")!;
    completeSupervisorRequest(f.fixture.projections.get(initial.supervisorThreadId)!, initial.messageId, JSON.stringify({startRequested: true, objective: null, reason: "User requested supervision", sourceMessageIds: [initial.sourceMessageId], workflow: null}));
    await f.supervisor.runOnce();
    f.fixture.restart();const resumed = f.fixture.makeSupervisor();
    f.fixture.addTurn("manual", "project-a", {id: "later-greeting", sequence: 21, text: "Reply with a greeting."});
    f.fixture.projections.get("manual")!.messages.at(-1)!.createdAt = new Date(Date.now() + 1000).toISOString();
    await resumed.runOnce();const next = f.fixture.supervisorStore.task("manual")!;
    assert.notEqual(next.id, initial.id);assert.equal(next.sourceMessageId, "later-greeting");
    await resumed.runOnce();assert.equal(f.fixture.supervisorStore.task("manual")?.id, next.id);
    completeSupervisorRequest(f.fixture.projections.get(next.supervisorThreadId)!, next.messageId, JSON.stringify({objective: "Reply with a greeting", reason: "Self-contained greeting", sourceMessageIds: [next.sourceMessageId], supervision: "not_needed", workflow: null}));
    await resumed.runOnce();await resumed.runOnce();
    assert.equal(f.fixture.supervisorStore.task("manual")?.id, next.id);assert.equal(f.fixture.supervisorStore.task("manual")?.status, "not_supervised");
    assert.equal(f.fixture.operations.filter(op => op.payload.type === "message.dispatch" && op.payload.threadId === initial.supervisorThreadId).length, 2);
    assert.equal(resumed.scopeEnabled("project-a", "manual"), true);
  } finally {await f.cleanup();}
});

it("Off pauses an active No Project permission without Stop-style fencing of prepared team/context work", async () => {
  const f = await noProjectFixture();
  try {
    await f.supervisor.dashboardStart("manual", "pause-grant", AbortSignal.timeout(1000));
    const binding = reserveReadyBinding(f.fixture, "manual");
    const prepared = f.supervisor.conversation.requests.prepare({id: "prepared-before-off", projectId: binding.projectId, supervisorThreadId: binding.threadId,
      kind: "review", taskId: null, text: "A retained review", batch: null, completionMarker: "retained-review-complete"}, Date.now());
    await f.supervisor.saveNoProjectControl({expectedGeneration: 0, mode: "off"}, AbortSignal.timeout(1000));
    await f.supervisor.runOnce();
    assert.deepEqual(f.supervisor.conversation.requests.requests(binding.projectId, binding.threadId).find(row => row.id === prepared.id), prepared);
    assert.equal(f.fixture.supervisorStore.start("manual")?.status, "active");
    assert.equal(f.fixture.supervisorStore.binding(binding.projectId, "manual")?.supervisionStop, undefined);
    assert.equal(f.fixture.operations.length, 0);
  } finally {await f.cleanup();}
});

it("archived exclusions disappear from the relevant editor without dropping the saved policy", async () => {
  const f = await noProjectFixture();
  try {
    await f.supervisor.dashboardStart("manual", "exclusion-visibility", AbortSignal.timeout(1000));
    await f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: f.policy.get().generation, enabled: false}, AbortSignal.timeout(1000));
    assert.ok((await f.supervisor.candidates("", "exclude")).exceptions.includes("manual"));
    f.fixture.projections.get("manual")!.thread.archivedAt = new Date().toISOString();
    assert.equal((await f.supervisor.candidates("", "exclude")).exceptions.includes("manual"), false);
    assert.ok(f.policy.get().excludedThreadIds.includes("manual"));
  } finally {await f.cleanup();}
});
