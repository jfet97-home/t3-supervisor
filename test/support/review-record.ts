import { Effect } from "effect";
import type { ConversationRequest, ReviewOutcomeKind } from "../../src/supervisor-conversation-store.js";
import type { Projection, ThreadInfo } from "../../src/types.js";
import type { WorkflowNativeAccessShape, WorkflowWriteController, WorkflowWriteResult } from "../../src/workflow-write-controller.js";
import { workflowToolNames } from "../../src/workflow-write-evidence.js";

// a root's monitoring review outcome recorded the production way: the root's own workflow_write record_review call is installed as
// an executed native tool item of the review's run on the root's projection, and the production write controller verifies that
// native proof and commits the outcome on the review's request

/** The native reads a controller verifies a root's own calls with: its threads, its projection and each installed tool item. */
export const rootNative = (root: Projection, threads: () => ReadonlyArray<ThreadInfo>): WorkflowNativeAccessShape => ({
  listThreads: () => Effect.sync(() => [...threads()]),
  projection: () => Effect.succeed(root),
  getTurnItem: ({itemId}) => Effect.sync(() => ({item: (root.turnItems ?? []).find(item => item.id === itemId) ?? null})),
});

export interface ReviewRecordOptions {
  readonly reason?: string;
  readonly applyOperationIds?: ReadonlyArray<string>;
  readonly operationId?: string;
  // the native item's status; a call still running is not completed proof
  readonly status?: "completed" | "running";
  // another run of the root than the review's own
  readonly runId?: string;
}

let calls = 0;

/** Records `outcome` for the review `request` through `controller`, as the root's own native call in the review's run. */
export const recordReview = (controller: WorkflowWriteController["Service"], root: Projection, request: ConversationRequest, outcome: ReviewOutcomeKind,
  options: ReviewRecordOptions = {}): Effect.Effect<WorkflowWriteResult, unknown> => Effect.suspend(() => {
  const run = options.runId ? root.runs.find(item => item.id === options.runId) : root.runs.find(item => item.userMessageId === request.messageId);
  if (!run) return Effect.die(new Error("the review run is not in the root's projection"));
  const args = {action: "record_review", supervisorThreadId: request.supervisorThreadId, bindingGeneration: request.reviewPins?.bindingGeneration ?? 0,
    operationId: options.operationId ?? `record-review:${request.id}`, requestId: request.id, outcome,
    ...(options.reason !== undefined ? {reason: options.reason} : {}),
    ...(options.applyOperationIds !== undefined ? {applyOperationIds: [...options.applyOperationIds]} : {})};
  const callId = `record-review-call-${++calls}`;
  const nodeId = `${callId}-node`;
  const nodes = (root.nodes ??= []) as Array<Record<string, unknown>>;
  nodes.push({id: nodeId, kind: "dynamic_tool", threadId: root.thread.id, runId: run.id, rootNodeId: run.rootNodeId, providerThreadId: run.providerThreadId,
    parentNodeId: run.rootNodeId, status: options.status ?? "completed"});
  (root.turnItems ??= []).push({id: callId, type: "dynamic_tool", threadId: root.thread.id, runId: run.id, nodeId, providerThreadId: run.providerThreadId,
    nativeItemRef: {driver: "codex", nativeId: callId, strength: "strong"}, parentItemId: null, ordinal: 1_000 + calls, status: options.status ?? "completed",
    toolNonExecutionKind: null, toolName: workflowToolNames.write.direct[1], input: args});
  return controller.write(args);
});
