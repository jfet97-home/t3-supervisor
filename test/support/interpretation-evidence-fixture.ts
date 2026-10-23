import { createHash } from "node:crypto";
import { Effect } from "effect";
import { interpretationPlanDigest, type InterpretationSubmissionEvidence } from "../../src/interpretation-evidence.js";
import {
  decodeInterpretationSubmission, interpretationAttemptId, interpretationAttemptKey, interpretationSourcePin, type InterpretationPayload,
} from "../../src/interpretation-submission.js";
import type { TaskRecord } from "../../src/project-supervisor-store.js";
import type { SupervisorRpc } from "../../src/supervisor-native.js";
import { SupervisorRpcError } from "../../src/supervisor-native.js";
import type { Projection, RunInfo } from "../../src/types.js";
import { workflowToolNames } from "../../src/workflow-write-evidence.js";

// the typed interpretation submission as the bound root records it (plan 3.12 items 4, 7 and 8): the decoded payload finalization
// applies, the executed tool item in the request run holding the exact arguments, and the attempt and evidence the task then holds

// a deterministic uuid v4 for a task's attempt, so a fixture's identities are stable across runs
const attemptUuid = (seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export type RecordedSubmission = {
  // the task as finalization leaves it: its attempt, its evidence and the payload's plan
  readonly task: TaskRecord;
  readonly payload: InterpretationPayload;
  readonly evidence: InterpretationSubmissionEvidence;
  readonly item: Record<string, unknown>;
  readonly arguments: Record<string, unknown>;
};

export const recordInterpretationSubmission = (input: {
  readonly supervisor: Projection;
  // the completed run of the task's interpretation request message
  readonly run: RunInfo;
  readonly task: TaskRecord;
  readonly bindingGeneration: number;
  // the submitted plan draft, or null
  readonly workflow: unknown;
  readonly objective?: string | null;
  readonly supervision?: "needed" | "not_needed";
  readonly itemId?: string;
  // the MCPX call wrapper instead of the direct tool name
  readonly mcpx?: boolean;
  readonly now?: number;
}): RecordedSubmission => {
  const {supervisor, run, task} = input;
  const requestText = String(supervisor.messages.find(message => message.id === task.messageId)?.text ?? "");
  const attempt = {attemptId: interpretationAttemptId(attemptUuid(`${task.id}\0${task.messageId}\0${task.sourceHash}`)),
    key: interpretationAttemptKey({bindingGeneration: input.bindingGeneration, task, requestMessageId: task.messageId, requestText})};
  const args: Record<string, unknown> = {supervisorThreadId: supervisor.thread.id, bindingGeneration: input.bindingGeneration, taskId: task.id,
    attemptId: attempt.attemptId, sourcePin: interpretationSourcePin(task), objective: input.objective === undefined ? task.objective : input.objective,
    reason: task.reason, sourceMessageIds: [task.sourceMessageId],
    ...(task.definitionContext ? {supervision: input.supervision ?? "needed", workflow: input.workflow} : {})};
  const submission = Effect.runSync(decodeInterpretationSubmission(args, {definitionContext: task.definitionContext ?? null, pendingStart: false}));
  const payload = submission.payload;
  const workflow = payload.kind === "interpretation" ? payload.workflow : undefined;
  const itemId = input.itemId ?? `${run.id}-interpretation-submit-${(supervisor.turnItems ?? []).filter(item => item.runId === run.id).length + 1}`;
  const nodeId = `${itemId}-node`;
  const now = input.now ?? Date.parse(String(run.completedAt ?? run.startedAt ?? "2026-10-13T10:00:00.000Z"));
  if (!Array.isArray(supervisor.nodes)) supervisor.nodes = [];
  (supervisor.nodes as Array<Record<string, unknown>>).push({id: nodeId, kind: "dynamic_tool", threadId: supervisor.thread.id, runId: run.id, rootNodeId: run.rootNodeId,
    parentNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, status: "completed"});
  const item: Record<string, unknown> = {id: itemId, type: "dynamic_tool", threadId: supervisor.thread.id, runId: run.id, nodeId,
    providerThreadId: run.providerThreadId, nativeItemRef: {driver: "codex", nativeId: `native-${itemId}`, strength: "strong"}, parentItemId: null,
    ordinal: (supervisor.turnItems ?? []).length + 1, status: "completed", toolNonExecutionKind: null,
    toolName: input.mcpx ? workflowToolNames.mcpxCall[0] : workflowToolNames.interpretation.direct[0],
    input: input.mcpx ? {name: workflowToolNames.interpretation.mcpxTarget, arguments: structuredClone(args)} : structuredClone(args),
    updatedAt: new Date(now).toISOString()};
  (supervisor.turnItems ??= []).push(item);
  const evidence: InterpretationSubmissionEvidence = {kind: "interpretation_submission", taskId: task.id, attemptId: attempt.attemptId, itemId,
    runId: run.id, argumentsHash: submission.argumentsHash, sourcePin: interpretationSourcePin(task), planDigest: interpretationPlanDigest(workflow)};
  return {task: {...task, attempt, interpretationEvidence: evidence, ...(workflow ? {workflow} : {})}, payload, evidence, item, arguments: args};
};

// the read credential's native item detail of a thread's turn item, served from the projection it appears in; an item the projection
// no longer shows is unavailable
export const turnItemReader = (projection: (threadId: string) => Projection | null | undefined, reads?: Array<string>): SupervisorRpc =>
  async (tag, payload) => {
    if (tag !== "orchestration.getTurnItem") throw new Error(`unexpected fake read command ${tag}`);
    reads?.push(String(payload.itemId));
    const item = (projection(String(payload.threadId))?.turnItems ?? []).find(candidate => candidate.id === payload.itemId);
    if (!item) throw new SupervisorRpcError("rejected", true);
    return {item: structuredClone(item)};
  };
