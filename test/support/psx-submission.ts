import assert from "node:assert/strict";
import { Context, Effect } from "effect";
import { ProjectSupervisorStore, type TaskRecord } from "../../src/project-supervisor-store.js";
import { GuidanceDb } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService, type SupervisionScopeStores } from "../../src/supervision-gate.js";
import { T3TransportError } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { MessageInfo, Projection, RunInfo, ThreadInfo } from "../../src/types.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "../../src/workflow-write-controller.js";
import { workflowToolNames } from "../../src/workflow-write-evidence.js";
import type { StoreOpen } from "./psx-stores.js";

// copied from the characterization fixtures: the native submission item and the write controller that records it.
// these helpers do not load the promise facades.

const details = new WeakMap<Projection, Map<string, Record<string, unknown>>>();

export const submissionDetail = (projection: Projection | undefined, itemId: string): Record<string, unknown> | null =>
  projection ? details.get(projection)?.get(itemId) ?? null : null;

/** A fake read rpc's answer for orchestration.getTurnItem, or undefined for another tag. */
export const turnItemAnswer = (projections: ReadonlyMap<string, Projection>, tag: string, payload: Record<string, unknown>): {item: unknown} | undefined =>
  tag === "orchestration.getTurnItem" ? {item: submissionDetail(projections.get(String(payload.threadId)), String(payload.itemId))} : undefined;

/** The arguments a root copies from its request: the attempt's envelope, then its interpretation fields. */
export const submissionArguments = (task: TaskRecord, fields: Record<string, unknown>): Record<string, unknown> => {
  assert.ok(task.attempt, "the task has a minted attempt");
  return {supervisorThreadId: task.supervisorThreadId, bindingGeneration: task.attempt.key.bindingGeneration, taskId: task.id,
    attemptId: task.attempt.attemptId, sourcePin: task.attempt.key.source, ...fields};
};

export type SubmissionItemOptions = {
  itemId?: string;
  wrapper?: "direct" | "mcpx";
  status?: "running" | "completed" | "rolled_back";
  nodeStatus?: "running" | "completed" | "rolled_back";
  runId?: string;
  input?: Record<string, unknown>;
};

/** Installs one native submission item in the root's projection and returns its item id. */
export const installSubmission = (root: Projection, task: TaskRecord, args: Record<string, unknown>, options: SubmissionItemOptions = {}): string => {
  const run = options.runId ? root.runs.find((item) => item.id === options.runId) : root.runs.find((item) => item.userMessageId === task.messageId);
  assert.ok(run?.rootNodeId, "the request run is visible");
  const byItem = details.get(root) ?? new Map<string, Record<string, unknown>>();
  details.set(root, byItem);
  const itemId = options.itemId ?? `submission-item-${byItem.size + 1}`;
  const nodeId = `submission-node-${itemId}`;
  const status = options.status ?? "completed";
  const native = options.input ?? args;
  const wrapper = options.wrapper ?? "direct";
  const toolName = wrapper === "mcpx" ? workflowToolNames.mcpxCall[1] : workflowToolNames.interpretation.direct[1];
  const input = wrapper === "mcpx" ? {name: workflowToolNames.interpretation.mcpxTarget, arguments: native} : native;
  const nodes = Array.isArray(root.nodes) ? root.nodes as Array<Record<string, unknown>> : [];
  root.nodes = nodes;
  nodes.push({id: nodeId, kind: "dynamic_tool", threadId: root.thread.id, runId: run.id, rootNodeId: run.rootNodeId, parentNodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId, status: options.nodeStatus ?? status});
  const detail: Record<string, unknown> = {id: itemId, type: "dynamic_tool", threadId: root.thread.id, runId: run.id, nodeId, providerThreadId: run.providerThreadId,
    parentItemId: null, ordinal: 500 + byItem.size, status, toolName, input, nativeItemRef: {driver: "codex", nativeId: `native-${itemId}`, strength: "strong"},
    toolNonExecutionKind: null};
  root.turnItems = [...(root.turnItems ?? []), detail as NonNullable<Projection["turnItems"]>[number]];
  byItem.set(itemId, detail);
  return itemId;
};

export const baseTime = "2026-10-13T10:00:00.000Z";
export type Turn = {id: string; sequence: number; text: string; creationSource?: "web" | "mobile" | "server"; createdBy?: "user" | "assistant" | "system"};

export const makeSourceProjection = (threadId: string, projectId: string, turns: readonly Turn[]): Projection => {
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

export const emptySupervisorProjection = (threadId: string, projectId: string, model: ThreadInfo["modelSelection"]): Projection => ({
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
  const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
  assert.ok(run?.rootNodeId);
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  const nodes = Array.isArray(projection.nodes) ? projection.nodes as Array<Record<string, unknown>> : [];
  const root = nodes.find((node) => node.id === run.rootNodeId);
  assert.ok(root);
  root.status = "completed";
  const nodeId = "supervisor-assistant-node-" + run.id;
  nodes.push({id: nodeId, threadId: projection.thread.id, runId: run.id, parentNodeId: run.rootNodeId, rootNodeId: run.rootNodeId,
    kind: "assistant_message", status: "completed", providerThreadId: "supervisor-provider"});
  const now = new Date().toISOString();
  projection.messages.push({id: "assistant-" + run.id, threadId: projection.thread.id, runId: run.id, nodeId, role: "assistant", text: response,
    streaming: false, createdAt: now, updatedAt: now});
};

/** The interpretation fields of a finite one-step plan citing the source message. */
export const workflowFields = (messageId: string, objective: string, reason: string): Record<string, unknown> => ({
  objective, reason, sourceMessageIds: [messageId], supervision: "needed",
  workflow: {requirements: [], plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "bounded-task-step",
    name: "Review the available context", description: "State what remains unknown and keep the plan finite.",
    reason: "The current task needs a bounded plan."}]}},
});

export const retryInput = (projectId: string, expectedGeneration: number, binding: {threadId: string; generation: number; mainThreadId: string},
  action: "retry" | "replace") => ({projectId, mainThreadId: binding.mainThreadId, expectedGeneration, threadId: binding.threadId, bindingGeneration: binding.generation, action});

const writeController = (stores: SupervisionScopeStores & {readonly sql: GuidanceDb["Service"]; readonly context: StoreOpen["context"]},
  workflows: WorkflowStateStore["Service"], projections: ReadonlyMap<string, Projection>) => Effect.gen(function* () {
  // every scope stays enabled for the submission's section; workflow editing follows the stored control; no chat is stopped
  const scope = new class extends SupervisionScope {
    override scopeEnabled() {return Effect.succeed(true);}
    override workflowEditingEnabled(projectId: string) {return stores.supervisors.enabled(projectId);}
    override supervisionStopped() {return Effect.succeed(false);}
  }({dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0}, stores, true);
  const context = Context.add(stores.context, WorkflowStateStore, workflows).pipe(Context.add(SupervisionScopeService, scope));
  const gate = yield* makeSupervisionGate(scope).pipe(Effect.provideService(GuidanceDb, stores.sql));
  return yield* WorkflowWriteController.make({withoutTeam: true, maxEvidenceWaitMs: 0}).pipe(
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(WorkflowNativeAccess, WorkflowNativeAccess.of({
      listThreads: () => Effect.succeed([]),
      projection: (threadId) => {
        const projection = projections.get(threadId);
        return projection ? Effect.succeed(projection) : Effect.fail(new T3TransportError("missing projection", 404));
      },
      getTurnItem: ({threadId, itemId}) => Effect.succeed({item: submissionDetail(projections.get(threadId), itemId)}),
    })),
    Effect.provide(context),
  );
});

export interface SubmissionStores {
  readonly sql: GuidanceDb["Service"];
  readonly guidance: GuidanceStore["Service"];
  readonly supervisors: ProjectSupervisorStore["Service"];
  readonly policy: ThreadPolicyStore["Service"];
  readonly context: StoreOpen["context"];
  readonly workflows: WorkflowStateStore["Service"];
  readonly projections: ReadonlyMap<string, Projection>;
}

/** Installs the native item and submits it through the production write controller. Evidence wait is zero. */
export const submitInterpretation = (stores: SubmissionStores, task: TaskRecord, fields: Record<string, unknown>) =>
  Effect.gen(function* () {
    const root = stores.projections.get(task.supervisorThreadId);
    if (!root) return yield* Effect.die(new Error("the bound root's projection is missing"));
    const args = submissionArguments(task, fields);
    installSubmission(root, task, args);
    const controller = yield* writeController(stores, stores.workflows, stores.projections);
    return yield* controller.submitInterpretation(args);
  });
