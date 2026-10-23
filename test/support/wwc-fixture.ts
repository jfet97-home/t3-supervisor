import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import type { Duration } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { fingerprint, GuidanceStore } from "../../src/guidance-store.js";
import { NativeEnvelope } from "../../src/native-envelope.js";
import { ProjectDefinitions } from "../../src/project-definitions.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { defaultSupervisorModel, ProjectSupervisorStore, type BindingRecord, type TaskRecord } from "../../src/project-supervisor-store.js";
import type { WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo, WorkflowSourceBindingInfo } from "../../src/project-supervisor-contract.js";
import { GuidanceDb } from "../../src/db.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService } from "../../src/supervision-gate.js";
import { SupervisorConversation } from "../../src/supervisor-conversation.js";
import { HelperTransport } from "../../src/supervisor-helper-transport.js";
import { NativeOperateRpc, SupervisorRpcError, type NativeRpcShape } from "../../src/supervisor-native.js";
import { SupervisorTeamController, type SupervisorTeamControllerOptions } from "../../src/supervisor-team-controller.js";
import { readTeamViewData, supervisorTeamView } from "../../src/supervisor-team-view.js";
import { proposalContextFromDefinitions, validateWorkflowPlan } from "../../src/supervisor-workflow.js";
import { T3Client, T3TransportError } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { Projection, ThreadInfo } from "../../src/types.js";
import type { WorkflowOwner } from "../../src/workflow-state-contract.js";
import { WorkflowNativeAccess, WorkflowWriteController, type SupervisorContextViewInput, type SupervisorContextViewResult, type WorkflowApplyPatch } from "../../src/workflow-write-controller.js";
import { workflowToolNames } from "../../src/workflow-write-evidence.js";
import { atWallClock, definitionsService, t3Projections, wallClock } from "./g1a-conversation.js";
import { temporaryDirectory } from "./g12-stores.js";
import { effectiveIndex, projectIndex } from "../project-definitions-fixture.js";
import { openWwcStores, sqlRun, type WwcStores } from "./wwc-stores.js";

// a workflow-write fixture over the production stores and controllers. the scope predicates match the retired unit: editing
// follows the stored project control, and the per-chat stop is a closure the test can flip while a read is in flight

export interface WwcNative {
  listThreads: (cancel?: Deferred.Deferred<void>) => Effect.Effect<readonly ThreadInfo[]>;
  projection: (threadId: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<Projection>;
  getTurnItem: (input: {threadId: string; itemId: string}, cancel?: Deferred.Deferred<void>) => Effect.Effect<{item: unknown}>;
}

export interface WwcCalls {
  projection: string[];
  detail: string[];
  listThreads: number;
}

export interface DefinitionReader {
  current: ProjectDefinitionSnapshot;
  calls: number;
  fail?: boolean;
}

export const thread = (id: string, projectId: string, parentThreadId: string | null = null, relationshipToParent: string | null = null,
  rootThreadId?: string): ThreadInfo => ({id, title: id, projectId, archivedAt: null, deletedAt: null,
  lineage: {parentThreadId, relationshipToParent, ...(rootThreadId ? {rootThreadId} : {})}});

export const makeProjection = (supervisorThreadId: string, projectId: string): Projection => ({
  thread: thread(supervisorThreadId, projectId), runs: [], messages: [], nodes: [], turnItems: [],
});

export const localStep = (name: string, description: string, contributorThreadIds: readonly string[] = [], nodeId?: string) => ({
  kind: "step" as const,
  ...(nodeId ? {nodeId} : {}),
  definitionId: null,
  localId: name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 180),
  templatePath: null,
  name,
  description,
  source: null,
  resolution: "resolved" as const,
  reason: description,
  status: "planned" as const,
  contributorThreadIds,
});

export const sequencePlan = (nodes: readonly unknown[], templatePath: string | null = null): WorkflowPlanGroupInfo => ({
  kind: "sequence", templatePath, nodes: [...nodes] as WorkflowPlanNodeInfo[],
});

export const planEntities = (plan: WorkflowPlanGroupInfo | null): Extract<WorkflowPlanNodeInfo, {kind: "step" | "workflow"}>[] => {
  if (!plan) return [];
  return plan.nodes.flatMap(node => "nodes" in node ? planEntities(node) : [node, ...(node.kind === "workflow" ? planEntities(node.plan) : [])]);
};

export const mainStep = (plan: WorkflowPlanGroupInfo | null, index = 0) => planEntities(plan).filter(node => node.kind === "step")[index];

const pinClock = Effect.clockWith((clock) => {
  const adjustable = clock as Clock.Clock & {setTime?: (timestamp: number) => Effect.Effect<void>};
  return adjustable.setTime ? adjustable.setTime(wallClock) : Effect.void;
});

class WwcScope extends SupervisionScope {
  constructor(
    guidance: GuidanceStore["Service"],
    private readonly supervisors: ProjectSupervisorStore["Service"],
    private readonly stopped: (threadId: string) => boolean,
  ) {
    super({dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0},
      {guidance, supervisors, policy: unusedPolicy}, true);
  }
  override scopeEnabled() {return Effect.succeed(true);}
  override workflowEditingEnabled(projectId: string, _mainThreadId?: string, _purpose?: "effect" | "status" | "read") {
    return this.supervisors.enabled(projectId);
  }
  override supervisionStopped(threadId: string) {return Effect.succeed(this.stopped(threadId));}
}

const unusedPolicy = {get: () => Effect.die(new Error("unused policy read"))} as unknown as ThreadPolicyStore["Service"];

interface BuiltWrite {
  readonly gate: SupervisionGate["Service"];
  readonly native: WorkflowNativeAccess["Service"];
  readonly context: Context.Context<WwcStores["context"] extends Context.Context<infer S> ? S : never>;
}

const builtWrites = new WeakMap<object, BuiltWrite>();

const nativeAccess = (native: WwcNative): WorkflowNativeAccess["Service"] => WorkflowNativeAccess.of({
  listThreads: (cancel) => Effect.suspend(() => native.listThreads(cancel)),
  projection: (threadId, cancel) => Effect.suspend(() => native.projection(threadId, cancel)),
  getTurnItem: (input, cancel) => Effect.suspend(() => native.getTurnItem(input, cancel)),
});

export interface OpenWriteOptions {
  // omitted keeps the production 400 ms evidence budget; the fixture passes 0
  readonly maxEvidenceWaitMs?: number | undefined;
  readonly team?: boolean | undefined;
  readonly native?: WwcNative | undefined;
  readonly isChatStopped?: ((threadId: string) => boolean) | undefined;
  readonly loadDefinitions?: ((projectId: string, threadId: string | null) => Effect.Effect<ProjectDefinitionSnapshot, Error>) | undefined;
  readonly contextViews?: {
    readContextView: (binding: BindingRecord, input: SupervisorContextViewInput) => Effect.Effect<SupervisorContextViewResult>;
  } | undefined;
}

export interface WwcFixture {
  readonly directory: string;
  readonly db: WwcStores["db"];
  readonly supervisors: ProjectSupervisorStore["Service"];
  readonly workflows: WwcStores["workflows"];
  readonly team: WwcStores["team"];
  readonly requests: WwcStores["requests"];
  readonly controller: WorkflowWriteController["Service"];
  readonly close: Effect.Effect<void>;
  readonly inTransaction: Effect.Effect<boolean>;
  owner: WorkflowOwner;
  binding: BindingRecord;
  readonly projectId: string;
  mainThreadId: string;
  supervisorThreadId: string;
  readonly threads: ThreadInfo[];
  projection: Projection;
  readonly projections: Map<string, Projection>;
  readonly details: Map<string, unknown>;
  readonly projectionCalls: string[];
  readonly detailCalls: string[];
  readonly calls: WwcCalls;
  native: WwcNative;
  readonly definitionReader: DefinitionReader;
  readonly loadDefinitions: (projectId: string, threadId: string | null) => Effect.Effect<ProjectDefinitionSnapshot, Error>;
  proposal: WorkflowProposalInfo;
  sourceBinding: WorkflowSourceBindingInfo;
  readonly context: WwcStores["context"];
}

/** The stores and the default write controller of one temporary guidance file, closed with the test scope. */
export const makeFixture = (mainThread: ThreadInfo = thread("main-workflows", "project-workflows")) => Effect.gen(function* () {
  yield* pinClock;
  const directory = yield* temporaryDirectory("workflow-write-controller-");
  const stores = yield* openWwcStores(directory);
  const projectId = "project-workflows";
  const mainThreadId = mainThread.id;
  const control = (scope: string | null, enabled: boolean) => sqlRun(stores.db,
    "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    `supervisor_control:${JSON.stringify(scope)}`, JSON.stringify({generation: 1, enabled, manual: true}));
  yield* control(null, true);
  yield* control(projectId, true);
  const reserved = yield* stores.supervisors.reserve(projectId, mainThreadId, "Main thread", defaultSupervisorModel, 1, 1).pipe(Effect.orDie);
  const binding = {...reserved, state: "ready" as const};
  yield* stores.supervisors.setBinding(binding).pipe(Effect.orDie);
  const supervisorThreadId = binding.threadId;
  const definitionSnapshot: ProjectDefinitionSnapshot = {
    projectId, threadId: mainThreadId, workspaceRoot: "/workspace/project-workflows", globalOnly: false, globalRevision: null,
    revision: "definition-revision-1", editingAvailable: true, status: "ready", steps: [], workflows: [],
    config: effectiveIndex({steps: [], workflows: []}), projectConfig: projectIndex(), definitionFiles: [], complete: true, sources: [], issues: [],
  };
  const definitionContext = proposalContextFromDefinitions(definitionSnapshot);
  const normalized = validateWorkflowPlan({requirements: [], plan: sequencePlan([localStep("Baseline review", "Review the current task context.")])}, definitionContext);
  if (!normalized?.plan) return yield* Effect.die(new Error("test_workflow_proposal_invalid"));
  const proposal: WorkflowProposalInfo = {
    status: "proposed", message: "A source-bound workflow proposal for this task.", workspaceRoot: definitionSnapshot.workspaceRoot,
    revision: definitionSnapshot.revision, globalRevision: null, definitionsStatus: "ready", definitionsComplete: true, requirementsKnown: true,
    requirements: normalized.requirements, issues: normalized.issues, plan: normalized.plan,
  };
  const taskSourceHash = fingerprint("Complete the current project task.");
  const updatedAt = yield* Clock.currentTimeMillis;
  const task: TaskRecord = {
    id: "task-current", threadId: mainThreadId, projectId, sourceRunId: "source-run-current", sourceMessageId: "source-message-current",
    status: "inferred", objective: "Complete the current project task.", reason: "The latest user message describes an actionable task.",
    updatedAt, workflow: proposal, agreement: null, workflowProposalId: "proposal-current", sourceHash: taskSourceHash,
    requestText: "Complete the current project task.", supervisorThreadId, messageId: "source-message-current", dispatchedAt: null,
    replayCount: 0, supervisorRunId: "source-run-current", sourceOrdinal: 1, definitionContext, definitionSnapshot,
  };
  yield* stores.supervisors.saveTask(task).pipe(Effect.orDie);
  const sourceBinding: WorkflowSourceBindingInfo = {
    workspaceRoot: definitionSnapshot.workspaceRoot, revision: definitionSnapshot.revision, globalRevision: null, definitionsStatus: "ready",
    definitionsComplete: true, requirementsKnown: true, taskId: task.id, proposalId: "proposal-current", sourceHash: taskSourceHash,
  };
  const definitionReader: DefinitionReader = {current: definitionSnapshot, calls: 0};
  const threads = [mainThread, thread(supervisorThreadId, projectId)];
  const projection = makeProjection(supervisorThreadId, projectId);
  const projections = new Map([[supervisorThreadId, projection]]);
  const details = new Map<string, unknown>();
  const projectionCalls: string[] = [];
  const detailCalls: string[] = [];
  const calls: WwcCalls = {projection: projectionCalls, detail: detailCalls, listThreads: 0};
  const native: WwcNative = {
    listThreads: () => Effect.sync(() => {calls.listThreads += 1; return threads;}),
    projection: (id) => Effect.gen(function* () {
      calls.projection.push(id);
      const current = projections.get(id);
      if (!current) return yield* Effect.die(new Error("unexpected_projection"));
      return current;
    }),
    getTurnItem: ({itemId}) => Effect.sync(() => {calls.detail.push(itemId); return {item: details.get(itemId) ?? null};}),
  };
  const loadDefinitions = (_projectId: string, _threadId: string | null) => Effect.gen(function* () {
    definitionReader.calls += 1;
    if (definitionReader.fail) return yield* Effect.fail(new Error("definitions_unavailable"));
    return definitionReader.current;
  });
  const fixture = {
    directory, db: stores.db, supervisors: stores.supervisors, workflows: stores.workflows, team: stores.team, requests: stores.requests,
    close: stores.close, inTransaction: stores.inTransaction,
    owner: {projectId, mainThreadId, supervisorThreadId, bindingGeneration: binding.generation},
    binding, projectId, mainThreadId, supervisorThreadId, threads, projection, projections, details, projectionCalls, detailCalls, calls,
    native, definitionReader, loadDefinitions, proposal, sourceBinding, context: stores.context,
  } as WwcFixture;
  const controller = yield* openWrite(fixture, {maxEvidenceWaitMs: 0, loadDefinitions});
  return Object.assign(fixture, {controller});
});

/** A write controller over this fixture. `maxEvidenceWaitMs` omitted uses the production 400 ms budget. */
export const openWrite = (fixture: WwcFixture, options: OpenWriteOptions = {}) => Effect.gen(function* () {
  const native = options.native ?? fixture.native;
  const stopped = options.isChatStopped ?? (() => false);
  const scope = new WwcScope(Context.get(fixture.context, GuidanceStore), fixture.supervisors, stopped);
  const access = nativeAccess(native);
  const gate = yield* makeSupervisionGate(scope).pipe(Effect.provideService(GuidanceDb, fixture.db));
  const loader = options.loadDefinitions;
  const definitions = loader ? definitionsService({load: (projectId, threadId = null) => loader(projectId, threadId)}) : undefined;
  const views = options.contextViews;
  let context = Context.add(fixture.context, SupervisionScopeService, scope);
  if (definitions) context = Context.add(context, ProjectDefinitions, definitions);
  if (views) context = Context.add(context, SupervisorConversation, {readContextView: (binding: BindingRecord, input: SupervisorContextViewInput) => views.readContextView(binding, input)} as unknown as SupervisorConversation["Service"]);
  const service = yield* WorkflowWriteController.make({
    ...(options.team ? {} : {withoutTeam: true}),
    ...(options.maxEvidenceWaitMs === undefined ? {} : {maxEvidenceWaitMs: options.maxEvidenceWaitMs}),
  }).pipe(
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(WorkflowNativeAccess, access),
    Effect.provide(context),
    Effect.orDie,
  );
  builtWrites.set(service, {gate, native: access, context});
  return service;
});

const rejectingFetch = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, () => Promise.reject(new Error("no webhook POST")))));

/** The team controller on the same gate and native reads as `write`. */
export const openTeam = (fixture: WwcFixture, write: WorkflowWriteController["Service"], rpc: NativeRpcShape | null,
  options: SupervisorTeamControllerOptions = {}) => Effect.gen(function* () {
  const built = builtWrites.get(write);
  if (!built) return yield* Effect.die(new Error("not a workflow write controller"));
  const transport = yield* HelperTransport.make({baseUrl: "http://unused.invalid"}).pipe(
    Effect.provideService(SupervisionGate, built.gate),
    Effect.provideService(T3Client, t3Projections((threadId) => {
      const current = fixture.projections.get(threadId);
      return current ? Effect.succeed(current) : Effect.fail(new T3TransportError("missing projection", 404));
    })),
    Effect.provide(rejectingFetch),
    Effect.provide(built.context),
    Effect.orDie,
  );
  return yield* SupervisorTeamController.make(options).pipe(
    Effect.provide(built.context),
    Effect.provideService(WorkflowWriteController, write),
    Effect.provideService(WorkflowNativeAccess, built.native),
    Effect.provideService(SupervisionGate, built.gate),
    Effect.provideService(HelperTransport, transport),
    (effect) => rpc ? Effect.provideService(effect, NativeOperateRpc, rpc) : effect,
    Effect.orDie,
  );
});

// a scripted operate client: initiate runs the handler before it returns, sent is already true, and a throw is uncertain
// unless it is already a SupervisorRpcError, as the retired promise rpc classified it
export const scriptedOperate = (handle: (tag: string, command: Record<string, unknown>) => unknown): NativeRpcShape => {
  const settle = (tag: string, payload: Readonly<Record<string, unknown>>) => Effect.try({
    try: () => handle(tag, {...payload}),
    catch: (cause) => cause instanceof SupervisorRpcError ? cause : new SupervisorRpcError("uncertain"),
  });
  const flight = (tag: string, payload: Readonly<Record<string, unknown>>) => Effect.gen(function* () {
    const exit = yield* Effect.exit(settle(tag, payload));
    return {
      sent: Effect.succeed(true),
      result: Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
      release: Effect.void,
    };
  });
  return {
    call: (tag, payload) => Effect.flatten(Effect.map(Effect.exit(settle(tag, payload)), (exit) =>
      Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))),
    initiate: flight,
  };
};

/** The production operate rpc against a loopback envelope peer. real sockets, so the caller is it.live. */
export const loopbackOperate = (baseUrl: string, token: string) => Effect.gen(function* () {
  const context = yield* Layer.build(NativeOperateRpc.layer({baseUrl, token}).pipe(Layer.provide(NativeEnvelope.layer)));
  return Context.get(context, NativeOperateRpc);
});

/** The team view at the test clock, so its grace text matches the clock reconcile uses. */
export const teamView = (fixture: WwcFixture) => Effect.gen(function* () {
  const data = yield* readTeamViewData(fixture.binding).pipe(Effect.provide(fixture.context), Effect.orDie);
  return supervisorTeamView(data, fixture.binding, fixture.threads, yield* Clock.currentTimeMillis);
});

/** Reconcile at an explicit wall time; sleeps and the monotonic clock stay where they are. */
export const reconcileAt = (controller: SupervisorTeamController["Service"], binding: BindingRecord, now?: number) =>
  atWallClock(now)(controller.reconcile(binding));

/**
 * Forks `work` and advances the test clock by `duration` once it has reached its first sleep.
 * durations here stay under the 10 s tool deadline, so that sleep is not woken.
 */
export const drive = <A, E, R>(work: Effect.Effect<A, E, R>, duration: Duration.Input) => Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(work);
  yield* Effect.yieldNow;
  yield* TestClock.adjust(duration);
  return yield* Fiber.join(fiber);
});

export const locator = (fixture: WwcFixture) => ({supervisorThreadId: fixture.supervisorThreadId, bindingGeneration: fixture.binding.generation});

export const ensureArgs = (fixture: WwcFixture, operationId: string, note: string) => ({action: "ensure_main", ...locator(fixture), operationId, note});

export const installEvidence = (fixture: WwcFixture, args: Record<string, unknown>, options: {
  itemId?: string; input?: unknown; toolName?: string; nodeKind?: string; status?: string; runStatus?: string; rootNodeStatus?: string;
  toolNodeStatus?: string; parentItemId?: string | null; runId?: string; providerThreadId?: string; providerInstanceId?: string;
  appRunOrdinal?: number; snapshotInput?: unknown; driver?: string;
} = {}): string => {
  const itemId = options.itemId ?? `workflow-tool-${fixture.details.size + 1}`;
  const runId = options.runId ?? "supervisor-run-current";
  const providerThreadId = options.providerThreadId ?? "provider-thread-current";
  const rootNodeId = "supervisor-root";
  const nodeId = `node-${itemId}`;
  const toolName = options.toolName ?? workflowToolNames.write.direct[0];
  const input = options.input ?? args;
  const detail = {
    id: itemId, type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId, nodeId, providerThreadId, providerTurnId: "provider-turn-current",
    nativeItemRef: {driver: options.driver ?? "codex", nativeId: `native-${itemId}`, strength: "strong"},
    parentItemId: options.parentItemId === undefined ? null : options.parentItemId, ordinal: 100 + fixture.details.size,
    status: options.status ?? "completed", toolNonExecutionKind: null, toolName, input,
  };
  fixture.details.set(itemId, detail);
  fixture.projection.runs = [{id: runId, ordinal: options.appRunOrdinal ?? 1, status: options.runStatus ?? "completed", requestedAt: "2026-10-14T00:00:00.000Z",
    startedAt: "2026-10-14T00:00:00.000Z", completedAt: "2026-10-14T00:00:01.000Z", rootNodeId, threadId: fixture.supervisorThreadId, providerThreadId,
    ...(options.providerInstanceId ? {providerInstanceId: options.providerInstanceId} : {})}];
  fixture.projection.nodes = [
    {id: rootNodeId, kind: "root_turn", threadId: fixture.supervisorThreadId, runId, rootNodeId, providerThreadId, parentNodeId: null, status: options.rootNodeStatus ?? "completed"},
    {id: nodeId, kind: options.nodeKind ?? "dynamic_tool", threadId: fixture.supervisorThreadId, runId, rootNodeId, providerThreadId, parentNodeId: rootNodeId, status: options.toolNodeStatus ?? options.status ?? "completed"},
  ];
  fixture.projection.turnItems = [{id: itemId, type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId, nodeId, providerThreadId, parentItemId: null,
    ordinal: 100 + fixture.details.size, status: options.status ?? "completed", toolName, input: options.snapshotInput ?? (typeof input === "string" ? input : "snapshot-summary")}];
  return itemId;
};

export const installMcpXEvidence = (fixture: WwcFixture, args: Record<string, unknown>, itemId?: string): string =>
  installEvidence(fixture, args, {...(itemId ? {itemId} : {}), toolName: workflowToolNames.mcpxCall[0],
    input: {name: workflowToolNames.write.mcpxTarget, arguments: args}});

export const applyArgs = (fixture: WwcFixture, input: WorkflowApplyPatch) => Effect.gen(function* () {
  const current = (yield* fixture.workflows.list(fixture.projectId, fixture.mainThreadId)).find(document => document.workflowId === input.workflowId);
  return {
    action: "apply", ...locator(fixture),
    input: {sourceBinding: fixture.sourceBinding, requirements: current?.threadId === fixture.mainThreadId ? fixture.proposal.requirements : [],
      issues: fixture.proposal.issues, ...input},
  };
});

/** The snapshot with exactly these definitions, each indexed in project.yaml as the loader derives it. */
export const snapshotWith = (base: ProjectDefinitionSnapshot, steps: ProjectDefinitionSnapshot["steps"], workflows: ProjectDefinitionSnapshot["workflows"]): ProjectDefinitionSnapshot => {
  const indexed = {steps: steps.map(step => step.id), workflows: workflows.map(workflow => workflow.id)};
  return {...base, steps, workflows, config: effectiveIndex({steps: indexed.steps.map(id => ({id})), workflows: indexed.workflows.map(id => ({id}))}),
    projectConfig: projectIndex(indexed)};
};

export const proposalForDefinitions = (definitions: ProjectDefinitionSnapshot, plan: WorkflowPlanGroupInfo): WorkflowProposalInfo => {
  const context = proposalContextFromDefinitions(definitions);
  const normalized = validateWorkflowPlan({requirements: [], plan}, context);
  if (!normalized?.plan) throw new Error("test_workflow_proposal_invalid");
  return {status: "proposed", message: "A current source-bound workflow proposal.", workspaceRoot: definitions.workspaceRoot,
    revision: definitions.revision, globalRevision: definitions.globalRevision ?? null, ...normalized};
};

export const replaceCurrentProposal = (fixture: WwcFixture, proposalId: string, definitions: ProjectDefinitionSnapshot,
  proposal: WorkflowProposalInfo, options: {sourceHash?: string; definitionReview?: NonNullable<TaskRecord["definitionReview"]>} = {}) =>
  Effect.gen(function* () {
    const task = yield* fixture.supervisors.task(fixture.mainThreadId);
    if (!task) return yield* Effect.die(new Error("test_current_task_missing"));
    const sourceHash = options.sourceHash ?? task.sourceHash;
    yield* fixture.supervisors.saveTask({...task, sourceHash, workflowProposalId: proposalId, workflow: proposal,
      definitionContext: proposalContextFromDefinitions(definitions), definitionSnapshot: definitions,
      ...(options.definitionReview ? {definitionReview: options.definitionReview} : {})});
    fixture.proposal = proposal;
    fixture.definitionReader.current = definitions;
    fixture.sourceBinding = {
      workspaceRoot: definitions.workspaceRoot, revision: definitions.revision, globalRevision: definitions.globalRevision ?? null,
      definitionsStatus: proposal.definitionsStatus, definitionsComplete: proposal.definitionsComplete, requirementsKnown: proposal.requirementsKnown,
      taskId: task.id, proposalId, sourceHash,
    };
  });
