import assert from "node:assert/strict";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { Clock } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { DefinitionSourceFailure, ProjectDefinitions, type DefinitionPresence } from "../../src/project-definitions.js";
import { defaultSupervisorModel, type SupervisorBaseline, type TaskRecord } from "../../src/project-supervisor-store.js";
import type { SupervisorModelSelection } from "../../src/project-supervisor-contract.js";
import { ProjectSupervisor, type SupervisorDefinitionsAccess } from "../../src/project-supervisor.js";
import { ScopeLocks } from "../../src/scope-locks.js";
import { Store, type StoreShape } from "../../src/store.js";
import { SupervisionControl } from "../../src/supervision-control.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService } from "../../src/supervision-gate.js";
import { SupervisionTeamLive } from "../../src/supervision-live.js";
import { NativeOperateRpc, NativeRpc, NativeShell, SupervisorRpcError } from "../../src/supervisor-native.js";
import { SupervisorTeamStore, type TeamBinding } from "../../src/supervisor-team-store.js";
import { T3Client, T3TransportError, type T3ClientShape } from "../../src/t3.js";
import type { MessageInfo, ProjectInfo, Projection, RunInfo, ThreadInfo } from "../../src/types.js";
import { effectiveIndex } from "../project-definitions-fixture.js";
import {
  dataDirectory, definitionsService, interpretationSubmitter, nativeClient, openStores, type ConversationStores,
} from "./g1a-conversation.js";
import { execute as executeSql, query as querySql } from "./g12-stores.js";
import type { InterpretationSubmitResponse } from "../../src/interpretation-submission.js";
import { submissionArguments, turnItemAnswer, type SubmissionItemOptions } from "./interpretation-submit.js";
import { WorkflowNativeAccess, WorkflowWriteController, type WorkflowNativeAccessShape } from "../../src/workflow-write-controller.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";

export const activationSequence = 10;
export const day = 24 * 60 * 60 * 1000;
export const baseTime = "2026-10-13T10:00:00.000Z";

export const missingDefinitions = (projectId: string, threadId: string | null, workspaceRoot: string): ProjectDefinitionSnapshot => ({
  projectId, threadId, workspaceRoot, globalOnly: false, globalRevision: null, revision: null,
  editingAvailable: false, status: "missing", steps: [], workflows: [], config: effectiveIndex({steps: [], workflows: []}), projectConfig: null,
  definitionFiles: [], complete: false, sources: [], issues: [],
}) as ProjectDefinitionSnapshot;

export const workflowSnapshot = (withStep = true) => ({
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
    models: ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol"].map((slug) => ({
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

// an agent's turn carries T3's native MCP provenance: createdBy agent, creationSource mcp and the sending thread
export type Turn = { id: string; sequence: number; text: string; creationSource?: "web" | "mobile" | "server" | "mcp"; createdBy?: "user" | "assistant" | "system" | "agent";
  senderThreadId?: string; scheduledTaskId?: string; createdAt?: string };

export const makeSourceProjection = (threadId: string, projectId: string, turns: Turn[]): Projection => {
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
      createdAt: turn.createdAt ?? baseTime,
      updatedAt: turn.createdAt ?? baseTime,
      createdBy: turn.createdBy ?? "user",
      creationSource: turn.creationSource ?? "web",
      ...(turn.senderThreadId ? { senderThreadId: turn.senderThreadId } : {}),
      ...(turn.scheduledTaskId ? { scheduledTaskId: turn.scheduledTaskId } : {}),
    });
    nodes.push(
      { id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "completed", providerThreadId: "provider-" + threadId },
    );
  }
  return { thread, runs, messages, nodes };
};

export const emptySupervisorProjection = (threadId: string, projectId: string, model: SupervisorModelSelection): Projection => ({
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

// supervisor request stamps stay on the wall clock, as the suite's source messages compare against each other
export const addSupervisorRequest = (projection: Projection, payload: Record<string, unknown>): void => {
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

export const completeSupervisorRequest = (projection: Projection, messageId: string, response: string): void => {
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

export const workflowResult = (messageId: string, objective: string, reason: string): string => JSON.stringify({
  objective,
  reason,
  sourceMessageIds: [messageId],
  workflow: {requirements: [], plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "bounded-task-step",
    name: "Review the available context", description: "State what remains unknown and keep the plan finite.",
    reason: "The current task needs a bounded plan."}]}},
});

export const retryInput = (
  projectId: string,
  expectedGeneration: number,
  binding: { threadId: string; generation: number; mainThreadId: string },
  action: "retry" | "replace",
) => ({ projectId, mainThreadId: binding.mainThreadId, expectedGeneration, threadId: binding.threadId, bindingGeneration: binding.generation, action });

export interface PsDefinitions {
  readonly load: (projectId: string, threadId: string | null) => Effect.Effect<ProjectDefinitionSnapshot, unknown>;
  readonly presence?: (projectId: string) => Effect.Effect<DefinitionPresence, unknown>;
}

type ProjectionResult = Effect.Effect<{readonly projection: Projection; readonly snapshotSequence: number}, T3TransportError>;

const definitionsAccessOf = (loader: PsDefinitions): SupervisorDefinitionsAccess => ({
  load: (projectId, threadId) => Effect.mapError(Effect.suspend(() => loader.load(projectId, threadId)), (error) => new DefinitionSourceFailure({error})),
  ...(loader.presence ? {presence: (projectId: string) => Effect.mapError(Effect.suspend(() => loader.presence!(projectId)), (error) => new DefinitionSourceFailure({error}))} : {}),
});

const yieldToEventLoop = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});

// one raw cycle. a hung supervisor read does not interrupt its batch: the node loop drains until sibling progress is quiet, then the cycle fiber is interrupted.
export const interruptHungPass = <A, E>(cycle: Effect.Effect<A, E>, hung: Deferred.Deferred<void>, progressed: () => number) => Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(cycle);
  const winner = yield* Effect.raceFirst(
    Effect.map(Fiber.await(fiber), (exit) => ({kind: "done" as const, exit})),
    Effect.map(Deferred.await(hung), () => ({kind: "hung" as const})),
  );
  if (winner.kind === "hung") {
    let previous = progressed();
    let stable = 0;
    for (let turn = 0; turn < 80 && stable < 5; turn++) {
      yield* yieldToEventLoop;
      const current = progressed();
      if (current === previous) stable += 1;
      else { previous = current; stable = 0; }
    }
    yield* Fiber.interrupt(fiber);
    return;
  }
  if (Exit.isFailure(winner.exit)) return yield* Effect.failCause(winner.exit.cause);
});

export interface PsSupervisor {
  readonly runOnce: Effect.Effect<void, unknown>;
  readonly cycle: ProjectSupervisor["Service"]["cycle"];
  readonly scope: SupervisionScope;
  readonly gate: SupervisionGate["Service"];
  readonly control: SupervisionControl["Service"];
  readonly team: SupervisorTeamStore["Service"];
  readonly requests: ConversationStores["requests"];
  readonly workflows: WorkflowStateStore["Service"];
  readonly stores: ConversationStores;
  readonly scopeEnabled: SupervisionScope["scopeEnabled"];
  readonly workflowEditingEnabled: SupervisionScope["workflowEditingEnabled"];
  readonly startSupervision: SupervisionControl["Service"]["startSupervision"];
  readonly dashboardStart: SupervisionControl["Service"]["dashboardStart"];
  readonly stopSupervision: SupervisionControl["Service"]["stopSupervision"];
  readonly noProjectControl: ProjectSupervisor["Service"]["noProjectControl"];
  readonly workflowLocator: ProjectSupervisor["Service"]["workflowLocator"];
  readonly scopeSnapshot: ProjectSupervisor["Service"]["scopeSnapshot"];
  readonly saveNoProjectControl: ProjectSupervisor["Service"]["saveNoProjectControl"];
  readonly saveGlobalDefinitionsControl: ProjectSupervisor["Service"]["saveGlobalDefinitionsControl"];
  readonly saveControl: ProjectSupervisor["Service"]["saveControl"];
  readonly candidates: ProjectSupervisor["Service"]["candidates"];
  readonly snapshot: ProjectSupervisor["Service"]["snapshot"];
  readonly save: ProjectSupervisor["Service"]["save"];
  readonly setChatSupervision: ProjectSupervisor["Service"]["setChatSupervision"];
  readonly retry: ProjectSupervisor["Service"]["retry"];
  readonly submit: (task: TaskRecord, fields: Record<string, unknown>, options?: SubmissionItemOptions) => Effect.Effect<InterpretationSubmitResponse, unknown>;
}

export const makeFixture = Effect.fnUntraced(function* (initial: Array<{ threadId: string; projectId: string; turns: Turn[] }>) {
  const directory = yield* dataDirectory("project-supervisor-test-");
  const clock = yield* Clock.Clock;
  // it.effect's test clock starts at 0; a live clock is already wall time and is left alone
  if (clock.currentTimeMillisUnsafe() === 0) yield* TestClock.setTime(Date.parse(baseTime));
  const now = () => clock.currentTimeMillisUnsafe();
  const projections = new Map<string, Projection>();
  const turnsByThread = new Map<string, Turn[]>();
  let registeredProjects = [...projects];
  const operations: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const projectionReads: string[] = [];
  let unknownDispatches = 0;
  // one lost response, or one provider-disabled rejection, for the first message dispatch the predicate selects, whatever
  // order concurrent mains dispatch in
  let unknownDispatchMatching: ((payload: Record<string, unknown>) => boolean) | null = null;
  let providerDisabledDispatchMatching: ((payload: Record<string, unknown>) => boolean) | null = null;
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
  let nativeProjection: ((threadId: string) => ProjectionResult) | null = null;
  let holdReads: ((threadId: string) => ProjectionResult | null) | null = null;
  for (const source of initial) {
    projections.set(source.threadId, makeSourceProjection(source.threadId, source.projectId, source.turns));
    turnsByThread.set(source.threadId, [...source.turns]);
  }
  const parent = yield* Effect.scope;
  let process = yield* Scope.fork(parent, "sequential");
  let stores = yield* openStores(directory, directory).pipe(Effect.provideService(Scope.Scope, process));
  let seeded = false;
  const seedManual = Effect.gen(function* () {
    if (seeded) return;
    seeded = true;
    for (const project of projects) {
      yield* executeSql(stores.sql, "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        `supervisor_control:${JSON.stringify(project.id)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
    }
  });
  yield* seedManual;
  const config = {
    dataDirectory: directory,
    t3Url: "http://unused",
    t3TokenFile: "unused",
    excludedThreadIds: [],
    healthPort: 0,
  };
  const catalog = () => Effect.sync(() => ({
    projects: registeredProjects.map((project) => ({ project, available: true })),
    threads: [...projections.values()].map((projection) => projection.thread),
  }));
  const t3: T3ClientShape = {
    descriptor: () => Effect.die(new Error("unused T3 descriptor")),
    watch: () => Effect.die(new Error("unused T3 watch")),
    projection: (threadId) => Effect.suspend(() => {
      const held = holdReads?.(threadId);
      if (held) return held;
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
    }),
  };
  const readRpc = nativeClient((tag, payload) => {
    if (tag === "server.getConfig") return modelConfig;
    const item = turnItemAnswer(projections, tag, payload);
    if (item) return item;
    throw new Error("unexpected fake read RPC");
  });
  const operateRpc = nativeClient((tag, payload) => {
    operations.push({ tag, payload: {...payload} });
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
      if (providerDisabledDispatchMatching?.(payload)) {
        providerDisabledDispatchMatching = null;
        throw new SupervisorRpcError("rejected", true, true);
      }
      if (unknownDispatches > 0) {
        unknownDispatches -= 1;
        throw new Error("simulated lost response");
      }
      if (unknownDispatchMatching?.(payload)) {
        unknownDispatchMatching = null;
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
      projection.thread.modelSelection = nextModelReadback ?? payload.modelSelection as SupervisorModelSelection;
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
  });
  const activationSnapshot: Effect.Effect<SupervisorBaseline, SupervisorRpcError> = Effect.sync(() => {
    baselineReads += 1;
    return {
      snapshotSequence,
      threads: [...projections.values()].map((projection) => {
        const historical = (turnsByThread.get(projection.thread.id) ?? []).filter((turn) => turn.sequence <= snapshotSequence);
        const latest = historical.at(-1);
        return { id: projection.thread.id, latestRunId: latest ? "run-" + latest.id : null };
      }),
    };
  });
  const defaultDefinitions: PsDefinitions = {
    load: (projectId, threadId) => Effect.sync(() => missingDefinitions(projectId, threadId, registeredProjects.find(project => project.id === projectId)?.workspaceRoot ?? "")),
  };
  const build = (definitions: PsDefinitions) => Effect.gen(function* () {
    const current = stores;
    const scope = new SupervisionScope(config, {guidance: current.guidance, supervisors: current.supervisors, policy: current.policy}, true);
    const workflowContext = yield* Layer.build(WorkflowStateStore.layerWith((projectId, mainThreadId) => scope.workflowEditingEnabled(projectId, mainThreadId)).pipe(
      Layer.provide(Layer.succeedContext(current.context)))).pipe(Effect.orDie);
    const workflows = Context.get(workflowContext, WorkflowStateStore);
    const base = Context.merge(current.context, workflowContext).pipe(Context.add(SupervisionScopeService, scope));
    const loader = {load: (projectId: string, threadId: string | null = null) => Effect.mapError(definitions.load(projectId, threadId), (error) => error instanceof Error ? error : new Error(String(error)))};
    const teamContext = yield* Layer.build(SupervisionTeamLive({baseUrl: config.t3Url}).pipe(Layer.provide(Layer.mergeAll(
      Layer.succeedContext(base), Layer.succeed(T3Client, t3), Layer.succeed(ProjectDefinitions, definitionsService(loader)),
      Layer.succeed(NativeRpc, readRpc), Layer.succeed(NativeOperateRpc, operateRpc), FetchHttpClient.layer)))).pipe(Effect.orDie);
    const locks = yield* Layer.build(ScopeLocks.layer);
    const shell = NativeShell.of({baseline: activationSnapshot, threads: Effect.die(new Error("unused native lineage read"))});
    const clients = Context.merge(Context.merge(base, teamContext), locks).pipe(Context.add(Store, {catalog} as unknown as StoreShape),
      Context.add(T3Client, t3), Context.add(NativeRpc, readRpc), Context.add(NativeShell, shell), Context.add(NativeOperateRpc, operateRpc));
    const control = yield* SupervisionControl.make.pipe(Effect.provide(clients));
    const {service} = yield* ProjectSupervisor.makeUnit({definitions: definitionsAccessOf(definitions)}).pipe(
      Effect.provideService(SupervisionControl, control), Effect.provide(clients));
    const gate = yield* makeSupervisionGate(scope).pipe(Effect.provide(clients));
    const runOnce = Effect.asVoid(Effect.timeoutOption(service.cycle, "120 seconds"));
    return {
      runOnce, cycle: service.cycle, scope, gate, control, team: current.team, requests: current.requests, workflows, stores: current,
      scopeEnabled: scope.scopeEnabled.bind(scope), workflowEditingEnabled: scope.workflowEditingEnabled.bind(scope),
      startSupervision: control.startSupervision, dashboardStart: control.dashboardStart, stopSupervision: control.stopSupervision,
      noProjectControl: service.noProjectControl, workflowLocator: service.workflowLocator, scopeSnapshot: service.scopeSnapshot,
      saveNoProjectControl: service.saveNoProjectControl, saveGlobalDefinitionsControl: service.saveGlobalDefinitionsControl,
      saveControl: service.saveControl, candidates: service.candidates, snapshot: service.snapshot, save: service.save,
      setChatSupervision: service.setChatSupervision, retry: service.retry,
      submit: (task: TaskRecord, fields: Record<string, unknown>, options?: SubmissionItemOptions) => interpretationSubmitter({stores: current, workflows, projections}).pipe(
        Effect.flatMap((submitter) => submitter.submit(task, submissionArguments(task, fields), options ?? {}))),
    } satisfies PsSupervisor;
  });
  return {
    directory,
    projections,
    operations,
    projectionReads,
    now,
    get store() { return stores.supervisors; },
    get guidance() { return stores.guidance; },
    get policy() { return stores.policy; },
    get baselineReads() { return baselineReads; },
    get scheduledTasks() { return scheduledTasks; },
    makeSupervisor: (definitions?: PsDefinitions) => Effect.suspend(() => build(definitions ?? defaultDefinitions).pipe(Effect.provideService(Scope.Scope, process))),
    addProject: (project: ProjectInfo) => { registeredProjects = [...registeredProjects, project]; },
    restart: Effect.gen(function* () {
      yield* Scope.close(process, Exit.void);
      process = yield* Scope.fork(parent, "sequential");
      stores = yield* openStores(directory, directory).pipe(Effect.provideService(Scope.Scope, process));
    }),
    addTurn: (threadId: string, projectId: string, turn: Turn) => {
      const turns = [...(turnsByThread.get(threadId) ?? []), turn];
      turnsByThread.set(threadId, turns);
      projections.set(threadId, makeSourceProjection(threadId, projectId, turns));
    },
    setSnapshotSequence: (value: number) => { snapshotSequence = value; },
    setUnknownDispatches: (count: number) => { unknownDispatches = count; },
    setUnknownDispatchMatching: (predicate: (payload: Record<string, unknown>) => boolean) => { unknownDispatchMatching = predicate; },
    setProviderDisabledDispatchMatching: (predicate: (payload: Record<string, unknown>) => boolean) => { providerDisabledDispatchMatching = predicate; },
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
    setProjectionFailure: (threadId: string, error: T3TransportError) => { projectionFailures.set(threadId, error); },
    setScheduledTasks: (tasks: Record<string, unknown>[]) => { scheduledTasks = tasks; },
    useNativeProjection: (read: (threadId: string) => ProjectionResult) => { nativeProjection = read; },
    setHoldReads: (hold: ((threadId: string) => ProjectionResult | null) | null) => { holdReads = hold; },
    setLegacyBaseline: Effect.fnUntraced(function* (baseline: Record<string, unknown>) {
      yield* executeSql(stores.sql, "INSERT INTO meta VALUES('supervisor_activation_baseline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(baseline));
    }),
    query: (statement: string, ...params: readonly unknown[]) => Effect.suspend(() => querySql(stores.sql, statement, ...params)),
    execute: (statement: string, ...params: readonly unknown[]) => Effect.suspend(() => executeSql(stores.sql, statement, ...params)),
  };
});

export type PsFixture = Effect.Success<ReturnType<typeof makeFixture>>;

export const reserveReadyBinding = (fixture: PsFixture, mainThreadId = "source-thread") => Effect.gen(function* () {
  const main = fixture.projections.get(mainThreadId);
  assert.ok(main);
  const binding = yield* fixture.store.reserve("project-a", mainThreadId, main.thread.title, defaultSupervisorModel, activationSequence, fixture.now());
  const ready = {...binding, state: "ready" as const};
  yield* fixture.store.setBinding(ready);
  fixture.projections.set(ready.threadId, emptySupervisorProjection(ready.threadId, ready.projectId, defaultSupervisorModel));
  return ready;
});

export const registerReadyHelper = (fixture: PsFixture, supervisor: PsSupervisor, binding: TeamBinding, threadId: string) => Effect.gen(function* () {
  const helperProjection = makeSourceProjection(threadId, binding.projectId, []);
  helperProjection.thread.lineage = {parentThreadId: binding.threadId, relationshipToParent: "subagent", rootThreadId: binding.threadId};
  fixture.projections.set(threadId, helperProjection);
  const registering = yield* supervisor.team.registerMember(binding, {threadId, taskId: `task-${threadId}`, bootstrapRunId: `run-${threadId}`});
  return yield* supervisor.team.markReady(binding, threadId, registering.epoch);
});

export const markRootMissing = (fixture: PsFixture, binding: Effect.Success<ReturnType<typeof reserveReadyBinding>>) => Effect.gen(function* () {
  fixture.projections.delete(binding.threadId);
  yield* fixture.store.setBinding({...binding, state: "missing"});
  return {...binding, state: "missing" as const};
});

export const addPendingHelperCheckin = (supervisor: PsSupervisor, binding: {projectId: string}, memberThreadId: string, requestId: string, now: number, state: "waiting" | "uncertain" = "waiting") => Effect.gen(function* () {
  const prepared = yield* supervisor.requests.prepare({id: requestId, projectId: binding.projectId, supervisorThreadId: memberThreadId,
    kind: "review", taskId: null, text: "Bounded helper check-in", batch: null, completionMarker: `complete:${requestId}`}, now);
  const pending = {...prepared, state, sentAt: now + 1, runId: `run:${requestId}`};
  yield* supervisor.requests.saveRequest(pending);
  return pending;
});

// the production write controller over this supervisor's control, with no evidence wait
export const startIntake = (supervisor: PsSupervisor, native: WorkflowNativeAccessShape) => WorkflowWriteController.make({withoutTeam: true, maxEvidenceWaitMs: 0}).pipe(
  Effect.provideService(WorkflowNativeAccess, WorkflowNativeAccess.of(native)),
  Effect.provideService(SupervisionControl, supervisor.control),
  Effect.provideService(SupervisionGate, supervisor.gate),
  Effect.provideService(SupervisionScopeService, supervisor.scope),
  Effect.provideService(WorkflowStateStore, supervisor.workflows),
  Effect.provide(supervisor.stores.context),
);

export const noProjectFixture = Effect.fnUntraced(function* () {
  const fixture = yield* makeFixture([{threadId: "manual", projectId: "project-a", turns: []}, {threadId: "other", projectId: "project-a", turns: []}, {threadId: "ordinary", projectId: "project-b", turns: []}]);
  yield* fixture.execute("INSERT INTO classifications VALUES(?,?)", "project-a", "scratch");
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  fixture.addTurn("manual", "project-a", {id: "request-start", sequence: 20, text: "Have Supervisor follow this task: add a CSV export."});
  const projection = fixture.projections.get("manual")!;
  // one second before the test clock, so a clock-stamped stop or enable lands after this source
  projection.messages[0]!.createdAt = new Date(fixture.now() - 1000).toISOString();
  return {fixture, supervisor, get policy() { return fixture.policy; }};
});
