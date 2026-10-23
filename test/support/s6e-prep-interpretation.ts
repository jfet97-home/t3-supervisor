import type { InterpretationAttempt, InterpretationBinding, InterpretationProofInput, InterpretationSubmission } from "../../src/interpretation-submission.js";
import { interpretationAttemptId, interpretationAttemptKey, interpretationTextHash } from "../../src/interpretation-submission.js";
import type { Projection, RunInfo, ThreadInfo } from "../../src/types.js";
import { workflowToolNames } from "../../src/workflow-write-evidence.js";

// pure projection fixtures for the typed interpretation submission: one bound root with the interpretation request run and an
// earlier run, the task's source pin and attempt, and one native tool item whose arguments are the submission

export const projectId = "project-interpretation";
export const mainThreadId = "main-interpretation";
export const rootThreadId = "supervisor-root-interpretation";
export const helperThreadId = "supervisor-helper-interpretation";
export const otherRootThreadId = "supervisor-root-other";
export const providerThreadId = "provider-thread-interpretation";
export const requestMessageId = "supervisor-objective-message";
export const requestText = "Interpret the request with the supplied attempt; submit it once through the interpretation tool.";
export const sourceText = "Ship export support for the reports page.";
export const attemptUuid = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
export const renewedAttemptUuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

export const thread = (id: string, project = projectId): ThreadInfo => ({id, title: id, projectId: project, archivedAt: null, deletedAt: null,
  lineage: {parentThreadId: null, relationshipToParent: null}});

export const binding = (overrides: Partial<InterpretationBinding> = {}): InterpretationBinding =>
  ({projectId, mainThreadId, threadId: rootThreadId, generation: 3, state: "ready", ...overrides});

export const task = {id: "task-interpretation", sourceMessageId: "source-message", sourceRunId: "source-run", sourceOrdinal: 4,
  sourceHash: interpretationTextHash(sourceText)};

export const attempt = (overrides: {uuid?: string; requestMessageId?: string; requestText?: string; task?: typeof task; generation?: number} = {}):
  InterpretationAttempt => ({
  attemptId: interpretationAttemptId(overrides.uuid ?? attemptUuid),
  key: interpretationAttemptKey({bindingGeneration: overrides.generation ?? 3, task: overrides.task ?? task,
    requestMessageId: overrides.requestMessageId ?? requestMessageId, requestText: overrides.requestText ?? requestText}),
});

// the plain arguments of the current attempt: envelope, objective, reason and the cited source
export const plainArguments = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const current = attempt();
  return {supervisorThreadId: rootThreadId, bindingGeneration: 3, taskId: task.id, attemptId: current.attemptId, sourcePin: {...current.key.source},
    objective: "Ship export support", reason: "The latest message asks for a concrete change.", sourceMessageIds: [task.sourceMessageId], ...overrides};
};

const identity = (runId: string) => ({threadId: rootThreadId, runId, providerThreadId});

export type ProofState = {
  thread: ThreadInfo;
  requestRun: RunInfo;
  earlierRun: RunInfo;
  requestMessage: Record<string, unknown>;
  root: Record<string, unknown>;
  node: Record<string, unknown>;
  extraNodes: Array<Record<string, unknown>>;
  item: Record<string, unknown>;
};

// the bound root with the request run (running) and its executed strong main-run tool item holding the arguments
export const proofState = (args: Record<string, unknown>): ProofState => ({
  thread: thread(rootThreadId),
  requestRun: {id: "request-run", ordinal: 2, status: "running", requestedAt: "2026-10-20T10:00:00.000Z", startedAt: "2026-10-20T10:00:01.000Z",
    completedAt: null, rootNodeId: "request-root", threadId: rootThreadId, providerThreadId, userMessageId: requestMessageId},
  earlierRun: {id: "earlier-run", ordinal: 1, status: "completed", requestedAt: "2026-10-20T09:00:00.000Z", startedAt: "2026-10-20T09:00:01.000Z",
    completedAt: "2026-10-20T09:00:09.000Z", rootNodeId: "earlier-root", threadId: rootThreadId, providerThreadId, userMessageId: "earlier-message"},
  requestMessage: {id: requestMessageId, runId: "request-run", nodeId: "request-root", threadId: rootThreadId, role: "user", text: requestText,
    streaming: false, createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-20T10:00:00.000Z"},
  root: {id: "request-root", kind: "root_turn", ...identity("request-run"), rootNodeId: "request-root", parentNodeId: null, status: "running"},
  node: {id: "tool-node", kind: "dynamic_tool", ...identity("request-run"), rootNodeId: "request-root", parentNodeId: "request-root", status: "running"},
  extraNodes: [
    {id: "earlier-root", kind: "root_turn", ...identity("earlier-run"), rootNodeId: "earlier-root", parentNodeId: null, status: "completed"},
    {id: "earlier-tool-node", kind: "dynamic_tool", ...identity("earlier-run"), rootNodeId: "earlier-root", parentNodeId: "earlier-root", status: "completed"},
  ],
  item: {id: "tool-item", type: "dynamic_tool", ...identity("request-run"), nodeId: "tool-node",
    nativeItemRef: {driver: "codex", nativeId: "native-tool-item", strength: "strong"}, parentItemId: null, ordinal: 9, status: "running",
    toolNonExecutionKind: null, toolName: workflowToolNames.interpretation.direct[0], input: structuredClone(args)},
});

export const proofProjection = (state: ProofState): Projection => ({
  thread: state.thread,
  runs: [state.earlierRun, state.requestRun],
  messages: [state.requestMessage as Projection["messages"][number]],
  nodes: [state.extraNodes[0], state.root, state.node, ...state.extraNodes.slice(1)],
  turnItems: [state.item],
});

// the verifier input of one submission against one item: the task's main chat, its current binding and the attempt's request
export const proofInput = (submission: Pick<InterpretationSubmission, "envelope" | "rawArguments" | "argumentsHash">, state: ProofState,
  overrides: Partial<InterpretationProofInput> = {}): InterpretationProofInput => ({
  phase: "intake",
  submission,
  scope: {projectId, mainThreadId},
  request: attempt().key,
  binding: binding(),
  ownedThreadIds: new Set([rootThreadId, helperThreadId, otherRootThreadId]),
  projection: proofProjection(state),
  itemId: "tool-item",
  detail: state.item,
  ...overrides,
});
