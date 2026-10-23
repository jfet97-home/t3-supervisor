import { createHash } from "node:crypto";
import { Exit, Schema } from "effect";
import { mainRunNodeReader } from "./domain.js";
import { canonicalJson } from "./canonical-json.js";
import type { Projection, RunInfo } from "./types.js";

export {canonicalJson};

export const workflowToolInputMaxBytes = 192 * 1024;
export const workflowTurnItemDetailMaxBytes = 256 * 1024;

export const workflowToolNames = {
  read: {
    direct: [
      "t3-supervisor-workflows.workflow_read",
      "mcp__t3-supervisor-workflows__workflow_read",
    ],
    mcpxTarget: "t3-supervisor-workflows__workflow_read",
  },
  write: {
    direct: [
      "t3-supervisor-workflows.workflow_write",
      "mcp__t3-supervisor-workflows__workflow_write",
    ],
    mcpxTarget: "t3-supervisor-workflows__workflow_write",
  },
  team: {
    direct: ["t3-supervisor-workflows.supervision_team", "mcp__t3-supervisor-workflows__supervision_team"],
    mcpxTarget: "t3-supervisor-workflows__supervision_team",
  },
  guide: {
    direct: ["t3-supervisor-workflows.supervision_guide", "mcp__t3-supervisor-workflows__supervision_guide"],
    mcpxTarget: "t3-supervisor-workflows__supervision_guide",
  },
  stop: {
    direct: ["t3-supervisor-workflows.supervision_stop", "mcp__t3-supervisor-workflows__supervision_stop"],
    mcpxTarget: "t3-supervisor-workflows__supervision_stop",
  },
  start: {
    direct: ["t3-supervisor-workflows.supervision_start", "mcp__t3-supervisor-workflows__supervision_start"],
    mcpxTarget: "t3-supervisor-workflows__supervision_start",
  },
  interpretation: {
    direct: ["t3-supervisor-workflows.supervision_interpretation_submit", "mcp__t3-supervisor-workflows__supervision_interpretation_submit"],
    mcpxTarget: "t3-supervisor-workflows__supervision_interpretation_submit",
  },
  mcpxCall: ["mcpx.mcpx_call_tool", "mcp__mcpx__mcpx_call_tool"],
} as const;

export type WorkflowEvidenceTool = "read" | "write" | "team" | "guide" | "stop" | "start" | "interpretation";

export type WorkflowEvidenceMatch = {
  itemId: string;
  runId: string;
  toolName: string;
  inputHash: string;
  nativeInputCanonical: string;
  providerThreadId: string;
  ordinal: number;
  status: "running" | "completed";
  nativeItemRef: {driver: string; nativeId: string; strength: "strong"};
};

export type WorkflowEvidenceCandidate = {
  itemId: string;
  snapshotSignature: string;
  appRunOrdinal: number;
  appRunTime: number;
  itemOrdinal: number;
};

export type WorkflowEvidenceCheck =
  | {status: "verified"; evidence: WorkflowEvidenceMatch}
  | {status: "pending"; reason: string}
  | {status: "denied"; reason: string; observedToolName?: string};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
};

export const workflowRequestHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export const workflowToolInputSize = (value: unknown): number =>
  Buffer.byteLength(canonicalJson(value), "utf8");

const knownDirectToolNames = new Set<string>([
  ...workflowToolNames.read.direct,
  ...workflowToolNames.write.direct,
  ...workflowToolNames.team.direct,
  ...workflowToolNames.guide.direct,
  ...workflowToolNames.stop.direct,
  ...workflowToolNames.start.direct,
  ...workflowToolNames.interpretation.direct,
]);
const knownMcpxTargets = new Set<string>([
  workflowToolNames.read.mcpxTarget,
  workflowToolNames.write.mcpxTarget,
  workflowToolNames.team.mcpxTarget,
  workflowToolNames.guide.mcpxTarget,
  workflowToolNames.stop.mcpxTarget,
  workflowToolNames.start.mcpxTarget,
  workflowToolNames.interpretation.mcpxTarget,
]);
const isMcpxCall = (toolName: string): boolean => workflowToolNames.mcpxCall.includes(toolName as never);
const maxObservedToolNameLength = 128;

const boundedObservedToolName = (toolName: string): string =>
  toolName.length <= maxObservedToolNameLength ? toolName : `${toolName.slice(0, maxObservedToolNameLength - 3)}...`;

type RecordedArguments = {
  arguments: Record<string, unknown>;
  recognized: boolean;
  observedToolName?: string;
};

// a string snapshot input is decoded as JSON before its arguments are compared; malformed input matches no arguments
const decodeSnapshotJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const isTruncatedSnapshot = (item: Record<string, unknown>): boolean =>
  item.inputTruncated === true || item.truncated === true || isRecord(item.input) && item.input.truncated === true;

const appRunTime = (run: RunInfo): number => {
  for (const value of [run.startedAt, run.requestedAt]) {
    if (typeof value !== "string") continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return -1;
};

export const workflowEvidenceCandidates = (
  projection: Projection,
  supervisorThreadId: string,
  tool: WorkflowEvidenceTool,
  expectedArguments: Record<string, unknown>,
): WorkflowEvidenceCandidate[] => {
  const names = workflowToolNames[tool].direct;
  const runs = new Map(projection.runs.map(run => [run.id, run]));
  const expectedCanonical = canonicalJson(expectedArguments);
  return (projection.turnItems ?? []).flatMap(item => {
    if (item.type !== "dynamic_tool" || item.threadId !== supervisorThreadId ||
      typeof item.runId !== "string" || typeof item.id !== "string" || typeof item.toolName !== "string") return [];
    if (!names.includes(item.toolName as never) && !isMcpxCall(item.toolName) && knownDirectToolNames.has(item.toolName)) return [];
    const run = runs.get(item.runId);
    if (!run || run.threadId !== supervisorThreadId) return [];
    const snapshotInput = item.input;
    const unknownToolName = !names.includes(item.toolName as never) && !isMcpxCall(item.toolName) &&
      !knownDirectToolNames.has(item.toolName);
    let plausible = false;
    if (isRecord(snapshotInput)) {
      const snapshotArguments = recordedArguments(item, tool);
      if (snapshotArguments) {
        try {plausible = canonicalJson(snapshotArguments.arguments) === expectedCanonical;}
        catch {plausible = false;}
      }
      if (!plausible && isTruncatedSnapshot(item)) plausible = true;
    } else if (typeof snapshotInput === "string" && snapshotInput.trim().length > 0) {
      if (!unknownToolName) {
        plausible = true;
      } else {
        const parsed = decodeSnapshotJson(snapshotInput);
        if (Exit.isSuccess(parsed) && isRecord(parsed.value)) {
          try {
            const snapshotArguments = recordedArguments({...item, input: parsed.value}, tool);
            plausible = snapshotArguments !== null && canonicalJson(snapshotArguments.arguments) === expectedCanonical;
          } catch {plausible = false;}
        }
        if (!plausible && isTruncatedSnapshot(item)) plausible = true;
      }
    }
    if (!plausible) return [];
    let snapshotSignature: string;
    try {
      snapshotSignature = workflowRequestHash({id: item.id, runId: item.runId, providerThreadId: item.providerThreadId ?? null,
        updatedAt: item.updatedAt ?? null, status: item.status ?? null, toolName: item.toolName, input: snapshotInput});
    } catch {return [];}
    return [{itemId: item.id, snapshotSignature,
      appRunOrdinal: Number.isSafeInteger(run.ordinal) ? run.ordinal : -1,
      appRunTime: appRunTime(run),
      itemOrdinal: Number.isSafeInteger(item.ordinal) ? item.ordinal as number : -1}];
  }).sort((left, right) => right.appRunOrdinal - left.appRunOrdinal || right.appRunTime - left.appRunTime ||
    right.itemOrdinal - left.itemOrdinal || right.itemId.localeCompare(left.itemId));
};

const recordedArguments = (
  item: Record<string, unknown>,
  tool: WorkflowEvidenceTool,
): RecordedArguments | null => {
  if (!isRecord(item.input)) return null;
  const toolName = item.toolName;
  if (typeof toolName !== "string") return null;
  if (workflowToolNames[tool].direct.includes(toolName as never)) return {arguments: item.input, recognized: true};
  if (knownDirectToolNames.has(toolName)) return null;
  if (isMcpxCall(toolName)) {
    if (!exactKeys(item.input, ["name", "arguments"]) || typeof item.input.name !== "string" ||
      !isRecord(item.input.arguments)) return null;
    if (item.input.name === workflowToolNames[tool].mcpxTarget)
      return {arguments: item.input.arguments, recognized: true};
    if (knownMcpxTargets.has(item.input.name)) return null;
    return {arguments: item.input.arguments, recognized: false, observedToolName: item.input.name};
  }
  if (exactKeys(item.input, ["name", "arguments"]) && item.input.name === workflowToolNames[tool].mcpxTarget &&
    isRecord(item.input.arguments))
    return {arguments: item.input.arguments, recognized: false, observedToolName: toolName};
  return {arguments: item.input, recognized: false, observedToolName: toolName};
};

const getRun = (projection: Projection, runId: string): RunInfo | undefined =>
  projection.runs.find(run => run.id === runId);

export const verifyWorkflowToolEvidence = (input: {
  projection: Projection;
  supervisorThreadId: string;
  itemId: string;
  detail: unknown;
  tool: WorkflowEvidenceTool;
  arguments: Record<string, unknown>;
}): WorkflowEvidenceCheck => {
  if (!isRecord(input.detail)) return {status: "pending", reason: "native_item_unavailable"};
  const item = input.detail;
  if (typeof item.runId !== "string" || typeof item.toolName !== "string" || !isRecord(item.input))
    return {status: "pending", reason: "native_input_incomplete"};
  const recorded = recordedArguments(item, input.tool);
  if (!recorded) return {status: "pending", reason: "native_tool_name_or_wrapper_mismatch"};
  let expectedCanonical: string;
  let actualCanonical: string;
  let nativeInputCanonical: string;
  try {
    expectedCanonical = canonicalJson(input.arguments);
    actualCanonical = canonicalJson(recorded.arguments);
    nativeInputCanonical = canonicalJson(item.input);
  } catch {
    return {status: "pending", reason: "native_input_not_json"};
  }
  if (Buffer.byteLength(actualCanonical, "utf8") > workflowToolInputMaxBytes)
    return {status: "pending", reason: "native_input_too_large"};
  if (Object.keys(recorded.arguments).length === 0) return {status: "pending", reason: "native_input_empty"};
  if (actualCanonical !== expectedCanonical) return {status: "pending", reason: "native_input_does_not_match_request"};
  if (item.id !== input.itemId || item.type !== "dynamic_tool" || item.threadId !== input.supervisorThreadId ||
    typeof item.nodeId !== "string") return {status: "denied", reason: "native_item_identity_mismatch"};
  if (input.projection.thread.id !== input.supervisorThreadId) return {status: "denied", reason: "supervisor_projection_mismatch"};
  if (item.parentItemId !== null) return {status: "denied", reason: "native_item_not_main_strong"};
  if (!isRecord(item.nativeItemRef) || item.nativeItemRef.strength !== "strong")
    return {status: "denied", reason: "native_item_not_main_strong"};
  const providerDriver = item.nativeItemRef.driver;
  if (typeof providerDriver !== "string" || !providerDriver || providerDriver.length > 128 || providerDriver.trim() !== providerDriver ||
    typeof item.nativeItemRef.nativeId !== "string" || !item.nativeItemRef.nativeId ||
    typeof item.ordinal !== "number" || !Number.isSafeInteger(item.ordinal) || item.ordinal < 0)
    return {status: "denied", reason: "native_item_identity_incomplete"};
  if (item.toolNonExecutionKind !== undefined && item.toolNonExecutionKind !== null)
    return {status: "denied", reason: "native_item_not_executed"};
  if (item.status === "rolled_back") return {status: "denied", reason: "native_tool_item_rolled_back"};
  if (item.status !== "running" && item.status !== "completed")
    return {status: "denied", reason: "native_item_not_running_or_completed"};
  const run = getRun(input.projection, item.runId);
  if (!run || run.threadId !== input.supervisorThreadId || typeof run.providerThreadId !== "string" ||
    item.providerThreadId !== run.providerThreadId)
    return {status: "denied", reason: "native_run_identity_mismatch"};
  if (run.status === "rolled_back") return {status: "denied", reason: "native_run_rolled_back"};
  const root = Array.isArray(input.projection.nodes)
    ? input.projection.nodes.find(node => isRecord(node) && node.id === run.rootNodeId)
    : undefined;
  if (isRecord(root) && root.status === "rolled_back") return {status: "denied", reason: "native_root_node_rolled_back"};
  const node = mainRunNodeReader(input.projection, run)(item.nodeId);
  if (!node) return {status: "denied", reason: "native_item_outside_main_run"};
  if (node.status === "rolled_back") return {status: "denied", reason: "native_tool_node_rolled_back"};
  if (!recorded.recognized) return {status: "denied", reason: "native_tool_name_unrecognized",
    ...(recorded.observedToolName ? {observedToolName: boundedObservedToolName(recorded.observedToolName)} : {})};
  return {
    status: "verified",
    evidence: {
      itemId: input.itemId,
      runId: item.runId,
      toolName: item.toolName,
      inputHash: workflowRequestHash(input.arguments),
      nativeInputCanonical,
      providerThreadId: item.providerThreadId as string,
      ordinal: item.ordinal as number,
      status: item.status,
      nativeItemRef: {
        driver: providerDriver,
        nativeId: item.nativeItemRef.nativeId as string,
        strength: "strong",
      },
    },
  };
};
