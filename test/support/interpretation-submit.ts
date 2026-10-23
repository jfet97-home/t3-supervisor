import assert from "node:assert/strict";
import { Effect } from "effect";
import type { InterpretationSubmitResponse } from "../../src/interpretation-submission.js";
import type { ProjectSupervisorStore, TaskRecord } from "../../src/project-supervisor-store.js";
import { T3TransportError } from "../../src/t3.js";
import type { Projection } from "../../src/types.js";
import type { WorkflowStateStore } from "../../src/workflow-state-store.js";
import { workflowToolNames } from "../../src/workflow-write-evidence.js";
import type { Promised } from "./store-units.js";
import { workflowWriteControllerService, workflowWriteControllerUnit } from "./workflow-controller-units.js";

// a Supervisor root's typed interpretation submission as the native graph records it: one executed dynamic_tool item of the
// supervision_interpretation_submit tool (direct or through MCPX) in the run of the task's persisted request message, with its item
// detail as orchestration.getTurnItem answers it; the submission goes through the real write controller and its intake

// the item details of each root projection, as the native turn-item read answers them
const details = new WeakMap<Projection, Map<string, Record<string, unknown>>>();
export const submissionDetail = (projection: Projection | undefined, itemId: string): Record<string, unknown> | null =>
  projection ? details.get(projection)?.get(itemId) ?? null : null;
// a fake read rpc's answer for orchestration.getTurnItem over the given projections, or undefined for another tag
export const turnItemAnswer = (projections: ReadonlyMap<string, Projection>, tag: string, payload: Record<string, unknown>): {item: unknown} | undefined =>
  tag === "orchestration.getTurnItem" ? {item: submissionDetail(projections.get(String(payload.threadId)), String(payload.itemId))} : undefined;

// the arguments a root copies from its request: the attempt's envelope, then its interpretation fields
export const submissionArguments = (task: TaskRecord, fields: Record<string, unknown>): Record<string, unknown> => {
  assert.ok(task.attempt, "the task has a minted attempt");
  return {supervisorThreadId: task.supervisorThreadId, bindingGeneration: task.attempt.key.bindingGeneration, taskId: task.id,
    attemptId: task.attempt.attemptId, sourcePin: task.attempt.key.source, ...fields};
};

// a finite one-step plan, the interpretation fields the reader prompt asks for with a definition context
export const workflowFields = (objective: string, reason: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  objective, reason, sourceMessageIds: [], supervision: "needed",
  workflow: {requirements: [], plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "bounded-task-step",
    name: "Review the available context", description: "State what remains unknown and keep the plan finite.", reason: "The current task needs a bounded plan."}]}},
  ...extra,
});
// the fields of a task interpretation that cite its source
export const taskFields = (task: TaskRecord, objective: string, reason: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({...workflowFields(objective, reason), sourceMessageIds: [task.sourceMessageId], ...extra});

export type SubmissionItemOptions = {
  itemId?: string;
  // the native call shape: the direct tool name or the MCPX call wrapper
  wrapper?: "direct" | "mcpx";
  status?: "running" | "completed" | "rolled_back";
  nodeStatus?: "running" | "completed" | "rolled_back";
  // another run of the root than the task's request run
  runId?: string;
  // the native input when it differs from the submitted arguments
  input?: Record<string, unknown>;
};

/** Installs one native submission item in the root's projection and returns its item ID; the run itself is left as it is. */
export const installSubmission = (root: Projection, task: TaskRecord, args: Record<string, unknown>, options: SubmissionItemOptions = {}): string => {
  const run = options.runId ? root.runs.find(item => item.id === options.runId) : root.runs.find(item => item.userMessageId === task.messageId);
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
  const item = {id: itemId, type: "dynamic_tool", threadId: root.thread.id, runId: run.id, nodeId, providerThreadId: run.providerThreadId,
    parentItemId: null, ordinal: 500 + byItem.size, status, toolName, input};
  root.turnItems = [...(root.turnItems ?? []), item];
  byItem.set(itemId, {...item, nativeItemRef: {driver: "codex", nativeId: `native-${itemId}`, strength: "strong"}, toolNonExecutionKind: null});
  return itemId;
};

// a turn item's native status as the root's later turn changes it (a rollback, or the item's completion)
export const setSubmissionStatus = (root: Projection, itemId: string, status: "running" | "completed" | "rolled_back", nodeStatus = status): void => {
  const detail = details.get(root)?.get(itemId);
  assert.ok(detail, "a recorded submission item");
  detail.status = status;
  const item = (root.turnItems ?? []).find(value => value.id === itemId);
  if (item) item.status = status;
  const node = (Array.isArray(root.nodes) ? root.nodes as Array<Record<string, unknown>> : []).find(value => value.id === detail.nodeId);
  if (node) node.status = nodeStatus;
};

export type InterpretationSubmitter = {
  // installs the native item for the arguments (unless told not to) and calls the tool through the write controller
  submit(task: TaskRecord, args: Record<string, unknown>, options?: SubmissionItemOptions & {install?: boolean}): Promise<InterpretationSubmitResponse>;
};

/** The write controller over the given stores and projections as the root's native reads; its intake records into the same guidance file. */
export const interpretationSubmitter = (input: {
  supervisors: Promised<ProjectSupervisorStore["Service"]>;
  workflows: Promised<WorkflowStateStore["Service"]>;
  projections: ReadonlyMap<string, Projection>;
  isChatStopped?: (mainThreadId: string) => boolean | Promise<boolean>;
}): InterpretationSubmitter => {
  const projectionOf = async (threadId: string) => {
    const projection = input.projections.get(threadId);
    if (!projection) throw new T3TransportError("missing projection", 404);
    return projection;
  };
  const unit = workflowWriteControllerUnit({supervisors: input.supervisors, workflows: input.workflows, maxEvidenceWaitMs: 0,
    ...(input.isChatStopped ? {isChatStopped: input.isChatStopped} : {}),
    native: {listThreads: async () => [], projection: projectionOf,
      getTurnItem: async ({threadId, itemId}) => ({item: submissionDetail(input.projections.get(threadId), itemId)})}});
  const service = workflowWriteControllerService(unit);
  return {
    submit: async (task, args, options = {}) => {
      const root = input.projections.get(task.supervisorThreadId);
      assert.ok(root, "the bound root's projection");
      if (options.install !== false) installSubmission(root, task, args, options);
      return await Effect.runPromise(service.submitInterpretation(args));
    },
  };
};
