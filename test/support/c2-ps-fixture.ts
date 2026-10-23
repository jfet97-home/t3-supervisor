import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { GuidanceStore } from "../../src/guidance-store.js";
import { projectSupervisorUnit, type ProjectSupervisorUnitDefinitions } from "./team-units.js";
import type { ScopeLocksShape } from "../../src/scope-locks.js";
import { defaultSupervisorModel, ProjectSupervisorStore, type SupervisorBaseline } from "../../src/project-supervisor-store.js";
import type { SupervisorModelSelection } from "../../src/project-supervisor-contract.js";
import { T3TransportError, type T3ClientShape } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { MessageInfo, ProjectInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import { effectiveIndex } from "../project-definitions-fixture.js";

// copied from test/project-supervisor.test.ts, with interceptable native calls, an optional thread policy file and a file-keeping restart

export const activationSequence = 10;
export const baseTime = "2026-10-13T10:00:00.000Z";

export const projects: ProjectInfo[] = [
  {id: "project-a", title: "Project A", workspaceRoot: "/work/a"},
  {id: "project-b", title: "Project B", workspaceRoot: "/work/b"},
];

export const modelConfig = {
  providers: [{
    enabled: true, instanceId: "codex", displayName: "Codex", installed: true, status: "ready",
    models: ["gpt-6-luna", "gpt-6-astra"].map(slug => ({
      slug, name: slug,
      capabilities: {optionDescriptors: [{id: "reasoningEffort", label: "Reasoning effort", type: "select", currentValue: "high",
        options: [{id: "low", label: "Low"}, {id: "high", label: "High"}, {id: "max", label: "Max"}]}]},
    })),
  }],
};

export type Turn = {id: string; sequence: number; text: string; creationSource?: "web" | "mobile" | "server"; createdBy?: "user" | "assistant" | "system"};
export type Operation = {tag: string; payload: Record<string, unknown>};
export type Rpc = (tag: string, payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
// returns undefined to fall through to the default fake behaviour
export type OperateHook = (tag: string, payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown> | undefined;
export type ProjectionHook = (threadId: string) => ReturnType<T3ClientShape["projection"]> | undefined;

export const missingDefinitions = (projectId: string, threadId: string | null, workspaceRoot: string) => ({
  projectId, threadId, workspaceRoot, globalOnly: false, globalRevision: null, revision: null,
  editingAvailable: false, status: "missing" as const, steps: [], workflows: [],
  config: effectiveIndex({steps: [], workflows: []}), projectConfig: null, definitionFiles: [], complete: false, sources: [], issues: [],
});

export const makeSourceProjection = (threadId: string, projectId: string, turns: Turn[]): Projection => {
  const thread: ThreadInfo = {id: threadId, title: "Task conversation", projectId, lineage: {parentThreadId: null, relationshipToParent: null}};
  const runs: RunInfo[] = [];
  const messages: MessageInfo[] = [];
  const nodes: Array<Record<string, unknown>> = [];
  for (const [index, turn] of turns.entries()) {
    const runId = "run-" + turn.id;
    const rootId = "root-" + turn.id;
    runs.push({id: runId, threadId, ordinal: index + 1, status: "completed", requestedAt: baseTime, startedAt: baseTime, completedAt: baseTime,
      rootNodeId: rootId, userMessageId: turn.id, providerThreadId: "provider-" + threadId});
    messages.push({id: turn.id, threadId, runId, nodeId: rootId, role: "user", text: turn.text, streaming: false, createdAt: baseTime, updatedAt: baseTime,
      createdBy: turn.createdBy ?? "user", creationSource: turn.creationSource ?? "web"});
    nodes.push({id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "completed", providerThreadId: "provider-" + threadId});
  }
  return {thread, runs, messages, nodes};
};

export const emptySupervisorProjection = (threadId: string, projectId: string, model: SupervisorModelSelection): Projection => ({
  thread: {id: threadId, title: "Project Supervisor", projectId, lineage: {parentThreadId: null, relationshipToParent: null}, modelSelection: model},
  runs: [], messages: [], nodes: [],
});

export const addSupervisorRequest = (projection: Projection, payload: Record<string, unknown>): void => {
  const threadId = projection.thread.id;
  const ordinal = projection.runs.length + 1;
  const runId = "supervisor-run-" + ordinal;
  const rootId = "supervisor-root-" + ordinal;
  const messageId = String(payload.messageId);
  const now = new Date().toISOString();
  projection.runs.push({id: runId, threadId, ordinal, status: "running", requestedAt: now, startedAt: now, completedAt: null, rootNodeId: rootId,
    userMessageId: messageId, providerThreadId: "supervisor-provider"});
  projection.messages.push({id: messageId, threadId, runId, nodeId: rootId, role: "user", text: String(payload.text), streaming: false, createdAt: now,
    updatedAt: now, creationSource: "server"});
  const nodes = Array.isArray(projection.nodes) ? projection.nodes as Array<Record<string, unknown>> : [];
  projection.nodes = nodes;
  nodes.push({id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "running", providerThreadId: "supervisor-provider"});
};

export const completeSupervisorRequest = (projection: Projection, messageId: string, response: string): void => {
  const run = projection.runs.find(candidate => candidate.userMessageId === messageId);
  assert.ok(run?.rootNodeId);
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  const nodes = Array.isArray(projection.nodes) ? projection.nodes as Array<Record<string, unknown>> : [];
  const root = nodes.find(node => node.id === run.rootNodeId);
  assert.ok(root);
  root.status = "completed";
  const nodeId = "supervisor-assistant-node-" + run.id;
  nodes.push({id: nodeId, threadId: projection.thread.id, runId: run.id, parentNodeId: run.rootNodeId, rootNodeId: run.rootNodeId,
    kind: "assistant_message", status: "completed", providerThreadId: "supervisor-provider"});
  const now = new Date().toISOString();
  projection.messages.push({id: "assistant-" + run.id, threadId: projection.thread.id, runId: run.id, nodeId, role: "assistant", text: response,
    streaming: false, createdAt: now, updatedAt: now});
};

export const workflowResult = (messageId: string, objective: string, reason: string): string => JSON.stringify({
  objective, reason, sourceMessageIds: [messageId],
  workflow: {requirements: [], plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "bounded-task-step",
    name: "Review the available context", description: "State what remains unknown and keep the plan finite.",
    reason: "The current task needs a bounded plan."}]}},
});

export const retryInput = (projectId: string, expectedGeneration: number, binding: {threadId: string; generation: number; mainThreadId: string},
  action: "retry" | "replace") => ({projectId, mainThreadId: binding.mainThreadId, expectedGeneration, threadId: binding.threadId, bindingGeneration: binding.generation, action});

// rejects when `promise` has not settled within `ms`; the deadline timer and its promise always settle
export const within = async <A>(promise: Promise<A>, ms: number, label: string): Promise<A> => {
  let stop!: () => void;
  const expired = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(true), ms);
    stop = () => {clearTimeout(timer);resolve(false);};
  });
  try {
    const settled = await Promise.race([promise.then(value => ({value})), expired.then(() => null)]);
    if (!settled) throw new Error(`${label} did not settle within ${ms} ms`);
    return settled.value;
  } finally {stop();}
};

// a promise settled from outside, used as a test barrier
export const deferred = <A = void>() => {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((ok, fail) => {resolve = ok;reject = fail;});
  return {promise, resolve, reject};
};

export type FixtureOptions = {threadPolicy?: boolean};

export const makeFixture = async (initial: Array<{threadId: string; projectId: string; turns: Turn[]}>, options: FixtureOptions = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "c2-project-supervisor-"));
  const projections = new Map<string, Projection>();
  const turnsByThread = new Map<string, Turn[]>();
  const registeredProjects = [...projects];
  const operations: Operation[] = [];
  const projectionReads: string[] = [];
  let acceptedDispatchesWithoutRun = 0;
  let operateHook: OperateHook | null = null;
  let projectionHook: ProjectionHook | null = null;
  // runs when a read rpc has its answer, before the caller receives it
  let readHook: ((tag: string) => void) | null = null;
  let baselineReads = 0;
  for (const source of initial) {
    projections.set(source.threadId, makeSourceProjection(source.threadId, source.projectId, source.turns));
    turnsByThread.set(source.threadId, [...source.turns]);
  }
  let guidance = new GuidanceStore(directory);
  let ownedIds = new Set<string>();
  let supervisorStore = new ProjectSupervisorStore(guidance, ownedIds);
  for (const project of projects) guidance.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`supervisor_control:${JSON.stringify(project.id)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const threadPolicy = options.threadPolicy ? new ThreadPolicyStore(directory, {excludedThreadIds: []}) : undefined;
  const config: SupervisorConfig = {supervisorOwnedThreadIds: ownedIds, dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "unused",
    excludedThreadIds: [], healthPort: 0, ...(threadPolicy ? {threadPolicy} : {})};
  const source = {
    catalog: () => Effect.succeed({
      projects: registeredProjects.map(project => ({project, available: true})),
      threads: [...projections.values()].map(projection => projection.thread),
    }),
  };
  const t3 = {
    projection: (threadId: string) => {
      projectionReads.push(threadId);
      const hooked = projectionHook?.(threadId);
      if (hooked) return hooked;
      const projection = projections.get(threadId);
      if (projection) return Effect.succeed({projection, snapshotSequence: 20});
      return Effect.fail(new T3TransportError("missing projection", 404));
    },
  };
  const readRpc: Rpc = async tag => {
    if (tag === "server.getConfig") {readHook?.(tag);return modelConfig;}
    throw new Error("unexpected fake read RPC");
  };
  const operateRpc: Rpc = async (tag, payload, signal) => {
    operations.push({tag, payload});
    const hooked = operateHook?.(tag, payload, signal);
    if (hooked) return hooked;
    if (tag === "scheduledTasks.list") return {tasks: []};
    if (tag === "orchestration.launchThread") {
      const threadId = String(payload.threadId);
      if (!projections.has(threadId)) projections.set(threadId, emptySupervisorProjection(threadId, String(payload.projectId), payload.modelSelection as SupervisorModelSelection));
      return {accepted: true};
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "message.dispatch") {
      const projection = projections.get(String(payload.threadId));
      assert.ok(projection);
      if (acceptedDispatchesWithoutRun > 0) {
        acceptedDispatchesWithoutRun -= 1;
        return {accepted: true};
      }
      addSupervisorRequest(projection, payload);
      delete projection.thread.settledAt;
      return {accepted: true};
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "thread.model-selection.set") {
      const projection = projections.get(String(payload.threadId));
      assert.ok(projection);
      projection.thread.modelSelection = payload.modelSelection;
      return {accepted: true};
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
    return {snapshotSequence: activationSequence, threads: [...projections.values()].map(projection => {
      const historical = (turnsByThread.get(projection.thread.id) ?? []).filter(turn => turn.sequence <= activationSequence);
      const latest = historical.at(-1);
      return {id: projection.thread.id, latestRunId: latest ? "run-" + latest.id : null};
    })};
  };
  const defaultDefinitions = {load: async (projectId: string, threadId: string | null) => {
    const workspaceRoot = registeredProjects.find(project => project.id === projectId)?.workspaceRoot ?? "";
    return missingDefinitions(projectId, threadId, workspaceRoot);
  }};
  const makeSupervisor = (overrides: {activationSnapshot?: typeof activationSnapshot; definitions?: ProjectSupervisorUnitDefinitions;
    now?: () => number; locks?: (locks: ScopeLocksShape) => ScopeLocksShape} = {}) =>
    projectSupervisorUnit(config, supervisorStore, source, t3, readRpc, operateRpc, overrides.activationSnapshot ?? activationSnapshot,
      overrides.definitions ?? defaultDefinitions, overrides.now, overrides.locks ? {locks: overrides.locks} : {});
  // a process restart: the old connection is closed and a new store opens the same guidance.sqlite3
  const restart = (): void => {
    guidance.close();
    guidance = new GuidanceStore(directory);
    ownedIds = new Set<string>();
    supervisorStore = new ProjectSupervisorStore(guidance, ownedIds);
    config.supervisorOwnedThreadIds = ownedIds;
  };
  const messageDispatches = () => operations.filter(call => call.tag === "orchestration.dispatchCommand" && call.payload.type === "message.dispatch");
  const launches = () => operations.filter(call => call.tag === "orchestration.launchThread");
  return {
    directory, config, operations, projectionReads, projections, threadPolicy,
    get guidance() {return guidance;},
    get supervisorStore() {return supervisorStore;},
    get baselineReads() {return baselineReads;},
    makeSupervisor, restart, messageDispatches, launches,
    setAcceptedDispatchesWithoutRun: (count: number) => {acceptedDispatchesWithoutRun = count;},
    setOperateHook: (hook: OperateHook | null) => {operateHook = hook;},
    setProjectionHook: (hook: ProjectionHook | null) => {projectionHook = hook;},
    setReadHook: (hook: ((tag: string) => void) | null) => {readHook = hook;},
    cleanup: async () => {
      try {guidance.close();} catch { /* already closed by a simulated crash */ }
      threadPolicy?.close();
      await rm(directory, {recursive: true, force: true});
    },
  };
};
export type Fixture = Awaited<ReturnType<typeof makeFixture>>;

export const reserveReadyBinding = (fixture: Fixture, mainThreadId = "source-thread", projectId = "project-a") => {
  const main = fixture.projections.get(mainThreadId);
  assert.ok(main);
  const binding = fixture.supervisorStore.reserve(projectId, mainThreadId, main.thread.title, defaultSupervisorModel, activationSequence, Date.now());
  const ready = {...binding, state: "ready" as const};
  fixture.supervisorStore.setBinding(ready);
  fixture.projections.set(ready.threadId, emptySupervisorProjection(ready.threadId, ready.projectId, defaultSupervisorModel));
  return ready;
};
