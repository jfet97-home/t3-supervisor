import assert from "node:assert/strict";
import type { TaskRecord } from "../../src/project-supervisor-store.js";
import type { Projection } from "../../src/types.js";
import { workflowToolNames } from "../../src/workflow-write-evidence.js";

// a Supervisor root's typed interpretation submission as the native graph records it: one executed dynamic_tool item of the
// supervision_interpretation_submit tool (direct or through MCPX) in the run of the task's persisted request message, with its item
// detail as orchestration.getTurnItem answers it

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
    attemptId: task.attempt.attemptId, sourcePin: task.attempt.key.source,
    ...(task.conversation && fields.conversation === undefined ? {conversation: {
      draft: {objective: typeof fields.objective === "string" ? fields.objective : null, constraints: [], questions: [], findings: [], duties: []},
      intent: typeof fields.objective === "string" && fields.supervision !== "not_needed" ? "authorize" : "following",
      outcome: typeof fields.objective === "string" ? fields.objective : null, limits: [], sourceMessageIds: [task.sourceMessageId], antecedentMessageIds: [], scope: "changed",
    }} : {}), ...fields};
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
  // the projection's turn item carries the complete detail, so a reader serving details from the projection answers it as well
  const detail: Record<string, unknown> = {id: itemId, type: "dynamic_tool", threadId: root.thread.id, runId: run.id, nodeId, providerThreadId: run.providerThreadId,
    parentItemId: null, ordinal: 500 + byItem.size, status, toolName, input, nativeItemRef: {driver: "codex", nativeId: `native-${itemId}`, strength: "strong"},
    toolNonExecutionKind: null};
  root.turnItems = [...(root.turnItems ?? []), detail as NonNullable<Projection["turnItems"]>[number]];
  byItem.set(itemId, detail);
  return itemId;
};

// a turn item's native status as the root's later turn changes it (a rollback, or the item's completion)
export const setSubmissionStatus = (root: Projection, itemId: string, status: "running" | "completed" | "rolled_back", nodeStatus = status): void => {
  const detail = details.get(root)?.get(itemId);
  assert.ok(detail, "a recorded submission item");
  detail.status = status;
  const node = (Array.isArray(root.nodes) ? root.nodes as Array<Record<string, unknown>> : []).find(value => value.id === detail.nodeId);
  if (node) node.status = nodeStatus;
};
