import { createHash } from "node:crypto";
import { mainRunNodeReader } from "./domain.js";
import type { Projection, RunInfo } from "./types.js";

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
  mcpxCall: ["mcpx.mcpx_call_tool", "mcp__mcpx__mcpx_call_tool"],
} as const;

export type WorkflowEvidenceTool = "read" | "write";

export type WorkflowEvidenceMatch = {
  itemId: string;
  runId: string;
  toolName: string;
  inputHash: string;
  nativeInputCanonical: string;
  providerThreadId: string;
  ordinal: number;
  status: "running" | "completed";
  nativeItemRef: {driver: "codex"; nativeId: string; strength: "strong"};
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
  | {status: "denied"; reason: string};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
};

const normalizeJson = (value: unknown, depth = 0): unknown => {
  if (depth > 64) throw new Error("json_depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("json_number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(item => normalizeJson(item, depth + 1));
  if (!isRecord(value)) throw new Error("json_value");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("json_prototype");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) result[key] = normalizeJson(value[key], depth + 1);
  return result;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(normalizeJson(value));

export const workflowRequestHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export const workflowToolInputSize = (value: unknown): number =>
  Buffer.byteLength(canonicalJson(value), "utf8");

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
    if (!names.includes(item.toolName as never) && !workflowToolNames.mcpxCall.includes(item.toolName as never)) return [];
    const run = runs.get(item.runId);
    if (!run || run.threadId !== supervisorThreadId) return [];
    const snapshotInput = item.input;
    let plausible = false;
    if (isRecord(snapshotInput)) {
      const snapshotArguments = recordedArguments(item, tool);
      if (snapshotArguments) {
        try {plausible = canonicalJson(snapshotArguments) === expectedCanonical;}
        catch {plausible = false;}
      }
      if (!plausible && isTruncatedSnapshot(item)) plausible = true;
    } else if (typeof snapshotInput === "string" && snapshotInput.trim().length > 0) {
      plausible = true;
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
): Record<string, unknown> | null => {
  if (!isRecord(item.input)) return null;
  const toolName = item.toolName;
  if (typeof toolName !== "string") return null;
  if (workflowToolNames[tool].direct.includes(toolName as never)) return item.input;
  if (!workflowToolNames.mcpxCall.includes(toolName as never)) return null;
  if (!exactKeys(item.input, ["name", "arguments"]) || item.input.name !== workflowToolNames[tool].mcpxTarget ||
    !isRecord(item.input.arguments)) return null;
  return item.input.arguments;
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
  const actualArguments = recordedArguments(item, input.tool);
  if (!actualArguments) return {status: "pending", reason: "native_tool_name_or_wrapper_mismatch"};
  let expectedCanonical: string;
  let actualCanonical: string;
  let nativeInputCanonical: string;
  try {
    expectedCanonical = canonicalJson(input.arguments);
    actualCanonical = canonicalJson(actualArguments);
    nativeInputCanonical = canonicalJson(item.input);
  } catch {
    return {status: "pending", reason: "native_input_not_json"};
  }
  if (Buffer.byteLength(actualCanonical, "utf8") > workflowToolInputMaxBytes)
    return {status: "pending", reason: "native_input_too_large"};
  if (Object.keys(actualArguments).length === 0) return {status: "pending", reason: "native_input_empty"};
  if (actualCanonical !== expectedCanonical) return {status: "pending", reason: "native_input_does_not_match_request"};
  if (item.id !== input.itemId || item.type !== "dynamic_tool" || item.threadId !== input.supervisorThreadId ||
    typeof item.nodeId !== "string") return {status: "denied", reason: "native_item_identity_mismatch"};
  if (input.projection.thread.id !== input.supervisorThreadId) return {status: "denied", reason: "supervisor_projection_mismatch"};
  if (item.parentItemId !== null) return {status: "denied", reason: "native_item_not_main_strong"};
  if (!isRecord(item.nativeItemRef) || item.nativeItemRef.strength !== "strong")
    return {status: "denied", reason: "native_item_not_main_strong"};
  if (item.nativeItemRef.driver !== "codex") return {status: "denied", reason: "native_driver_unverified"};
  if (typeof item.nativeItemRef.nativeId !== "string" || !item.nativeItemRef.nativeId ||
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
        driver: "codex",
        nativeId: item.nativeItemRef.nativeId as string,
        strength: "strong",
      },
    },
  };
};
