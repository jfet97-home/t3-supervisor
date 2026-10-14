import type { ProjectSupervisorStore, BindingRecord } from "./project-supervisor-store.js";
import type { WorkflowStateStore } from "./workflow-state-store.js";
import {
  workflowExecutionStatuses,
  workflowMutationLimits,
  type WorkflowApplyInput,
  type WorkflowControllerLineage,
  type WorkflowStateEvidenceInput,
  type WorkflowEnsureResult,
  type WorkflowMutationResult,
  type WorkflowOwner,
  type WorkflowStateDocument,
} from "./workflow-state-contract.js";
import type { Projection, ThreadInfo } from "./types.js";
import {
  canonicalJson,
  isRecord,
  verifyWorkflowToolEvidence,
  workflowEvidenceCandidates,
  workflowRequestHash,
  workflowTurnItemDetailMaxBytes,
  workflowToolInputMaxBytes,
  workflowToolInputSize,
  type WorkflowEvidenceMatch,
  type WorkflowEvidenceCheck,
} from "./workflow-write-evidence.js";

export type WorkflowNativeAccess = {
  listThreads(signal: AbortSignal): Promise<readonly ThreadInfo[]>;
  projection(threadId: string, signal: AbortSignal): Promise<Projection>;
  getTurnItem(
    input: {threadId: string; itemId: string},
    signal: AbortSignal,
  ): Promise<{item: unknown | null}>;
};

export type WorkflowWriteControllerOptions = {
  supervisors: ProjectSupervisorStore;
  workflows: WorkflowStateStore;
  native: WorkflowNativeAccess;
  isEnabled?: (projectId: string) => boolean;
  now?: () => number;
  maxEvidenceWaitMs?: number;
  pendingCandidateTtlMs?: number;
  pendingCandidateCapacity?: number;
};

export type WorkflowLocator = {
  supervisorThreadId: string;
  bindingGeneration: number;
};

export type WorkflowApplyPatch = Pick<WorkflowApplyInput, "operationId" | "workflowId" | "expectedRevision" | "note"> &
  Partial<Pick<WorkflowApplyInput, "status" | "objective" | "rules" | "steps">> &
  {evidence?: WorkflowStateEvidenceInput[]};

export type WorkflowWritePayload = WorkflowLocator & (
  | {action: "ensure_main"; operationId: string; note: string}
  | {action: "link_child"; operationId: string; childThreadId: string; note: string}
  | {action: "apply"; input: WorkflowApplyPatch}
);

export type WorkflowReadPayload = WorkflowLocator & {
  workflowId?: string;
  workflowOffset?: number;
  lineageOffset?: number;
  limit?: number;
};

export type WorkflowWriteResult = WorkflowEnsureResult | WorkflowMutationResult | {
  status: "pending" | "denied" | "invalid" | "unavailable" | "too_large";
  operationId?: string;
  reason: string;
  retryable?: boolean;
};

export type WorkflowReadResult = {
  status: "ok";
  owner: WorkflowOwner;
  mainTaskAgreementStatus: "agreed" | "stale" | null;
  agreementValidityNote: string;
  workflows: Array<{
    document: WorkflowStateDocument;
    parentStepReferences: Array<{
      parentWorkflowId: string;
      parentThreadId: string;
      stepId: string;
      stepName: string;
    }>;
  }>;
  workflowOffset: number;
  workflowHasMore: boolean;
  lineage: Array<{
    threadId: string;
    parentThreadId: string | null;
    relationshipToParent: string | null;
    archivedAt: string | null;
  }>;
  lineageOffset: number;
  lineageHasMore: boolean;
} | {
  status: "denied" | "invalid" | "unavailable" | "too_large";
  reason: string;
};

type ParsedInput =
  | {ok: true; value: WorkflowWritePayload}
  | {ok: false; reason: string; operationId?: string};

type ParsedReadInput =
  | {ok: true; value: WorkflowReadPayload}
  | {ok: false; reason: string};

type NativeScope = {
  main: ThreadInfo;
  byId: Map<string, ThreadInfo>;
  descendants: ThreadInfo[];
  allowedIds: Set<string>;
  liveIds: Set<string>;
  depthById: Map<string, number>;
};

type ProofRow = {
  request_hash: string;
  operation_id: string;
  operation_namespace: "edit";
  project_id: string;
  main_thread_id: string;
  supervisor_thread_id: string;
  binding_generation: number;
  result: string;
};

const maxBindingGeneration = 2_147_483_647;
const maxWorkflowReadDocs = 50;
const maxWorkflowReadBytes = 1024 * 1024;
const maxScopeThreads = 10_000;
const maxLineageDepth = 100;
const writeOperationNamespace = "edit" as const;

const isText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0);

const isId = (value: unknown, max = workflowMutationLimits.maxOperationIdLength): value is string =>
  isText(value, max);

const hasExactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
};

const isStatus = (value: unknown): value is typeof workflowExecutionStatuses[number] =>
  typeof value === "string" && workflowExecutionStatuses.includes(value as typeof workflowExecutionStatuses[number]);

const parseLocator = (value: Record<string, unknown>): WorkflowLocator | null => {
  if (!isId(value.supervisorThreadId) || !Number.isSafeInteger(value.bindingGeneration) ||
    (value.bindingGeneration as number) < 1 || (value.bindingGeneration as number) > maxBindingGeneration) return null;
  return {supervisorThreadId: value.supervisorThreadId, bindingGeneration: value.bindingGeneration as number};
};

const parseApplyInput = (value: unknown): WorkflowApplyPatch | null => {
  if (!isRecord(value) || !hasExactKeys(value,
    ["operationId", "workflowId", "expectedRevision", "note"], ["status", "objective", "rules", "steps", "evidence"])) return null;
  if (!isId(value.operationId) || !isId(value.workflowId) || !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 1 || value.status !== undefined && !isStatus(value.status) ||
    value.objective !== undefined && !(value.objective === null || isText(value.objective, workflowMutationLimits.maxTextLength)) ||
    !isText(value.note, workflowMutationLimits.maxTextLength) ||
    value.rules !== undefined && (!Array.isArray(value.rules) || value.rules.length > workflowMutationLimits.maxRules) ||
    value.steps !== undefined && (!Array.isArray(value.steps) || value.steps.length > workflowMutationLimits.maxSteps)) return null;
  const rules = value.rules ?? [];
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (!isRecord(rule) || !hasExactKeys(rule, ["index", "name", "applies", "reason"]) ||
      !Number.isSafeInteger(rule.index) || (rule.index as number) < 0 || !isText(rule.name, workflowMutationLimits.maxTextLength) ||
      typeof rule.applies !== "boolean" || !isText(rule.reason, workflowMutationLimits.maxTextLength)) return null;
  }
  const steps = value.steps ?? [];
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    if (!isRecord(step) || !hasExactKeys(step, ["blockId", "name", "reason", "status", "contributorThreadIds"], ["id"]) ||
      !(step.id === undefined || isId(step.id)) || !(step.blockId === null || isId(step.blockId)) ||
      !isText(step.name, workflowMutationLimits.maxTextLength) || !isText(step.reason, workflowMutationLimits.maxTextLength) ||
      !isStatus(step.status) || !Array.isArray(step.contributorThreadIds) ||
      step.contributorThreadIds.length > workflowMutationLimits.maxContributorsPerStep ||
      !step.contributorThreadIds.every(id => isId(id)) ||
      new Set(step.contributorThreadIds).size !== step.contributorThreadIds.length) return null;
  }
  if (value.evidence !== undefined) {
    if (!Array.isArray(value.evidence) || value.evidence.length > workflowMutationLimits.maxEvidencePerApply) return null;
    for (const item of value.evidence) {
      if (!isRecord(item) || !hasExactKeys(item, ["kind", "note"], ["targetStepId"]) ||
        !["status_changed", "note", "observation"].includes(String(item.kind)) ||
        !isText(item.note, workflowMutationLimits.maxTextLength) ||
        !(item.targetStepId === undefined || item.targetStepId === null || isId(item.targetStepId))) return null;
    }
  }
  return value as WorkflowApplyPatch;
};

const parseWritePayload = (value: unknown): ParsedInput => {
  if (!isRecord(value)) return {ok: false, reason: "arguments_must_be_an_object"};
  const locator = parseLocator(value);
  if (!locator) return {ok: false, reason: "invalid_owner_locator"};
  if (value.action === "ensure_main") {
    if (!hasExactKeys(value, ["action", "supervisorThreadId", "bindingGeneration", "operationId", "note"]) ||
      !isId(value.operationId) || !isText(value.note, workflowMutationLimits.maxTextLength))
      return {ok: false, reason: "invalid_ensure_main", ...(isId(value.operationId) ? {operationId: value.operationId} : {})};
    return {ok: true, value: {...locator, action: "ensure_main", operationId: value.operationId, note: value.note}};
  }
  if (value.action === "link_child") {
    if (!hasExactKeys(value, ["action", "supervisorThreadId", "bindingGeneration", "operationId", "childThreadId", "note"]) ||
      !isId(value.operationId) || !isId(value.childThreadId) || !isText(value.note, workflowMutationLimits.maxTextLength))
      return {ok: false, reason: "invalid_link_child", ...(isId(value.operationId) ? {operationId: value.operationId} : {})};
    return {ok: true, value: {...locator, action: "link_child", operationId: value.operationId,
      childThreadId: value.childThreadId, note: value.note}};
  }
  if (value.action === "apply") {
    if (!hasExactKeys(value, ["action", "supervisorThreadId", "bindingGeneration", "input"]))
      return {ok: false, reason: "invalid_apply"};
    const input = parseApplyInput(value.input);
    return input ? {ok: true, value: {...locator, action: "apply", input}} : {ok: false,
      reason: "invalid_apply_input", ...(isRecord(value.input) && isId(value.input.operationId) ? {operationId: value.input.operationId} : {})};
  }
  return {ok: false, reason: "unknown_action"};
};

const parseReadPayload = (value: unknown): ParsedReadInput => {
  if (!isRecord(value) || !hasExactKeys(value, ["supervisorThreadId", "bindingGeneration"],
    ["workflowId", "workflowOffset", "lineageOffset", "limit"])) return {ok: false, reason: "invalid_read_arguments"};
  const locator = parseLocator(value);
  if (!locator || value.workflowId !== undefined && !isId(value.workflowId) ||
    value.workflowOffset !== undefined && (!Number.isSafeInteger(value.workflowOffset) || (value.workflowOffset as number) < 0 || (value.workflowOffset as number) > 10_000) ||
    value.lineageOffset !== undefined && (!Number.isSafeInteger(value.lineageOffset) || (value.lineageOffset as number) < 0 || (value.lineageOffset as number) > 10_000) ||
    value.limit !== undefined && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > maxWorkflowReadDocs))
    return {ok: false, reason: "invalid_read_arguments"};
  return {ok: true, value: {
    ...locator,
    ...(typeof value.workflowId === "string" ? {workflowId: value.workflowId} : {}),
    ...(typeof value.workflowOffset === "number" ? {workflowOffset: value.workflowOffset} : {}),
    ...(typeof value.lineageOffset === "number" ? {lineageOffset: value.lineageOffset} : {}),
    ...(typeof value.limit === "number" ? {limit: value.limit} : {}),
  }};
};

const isOwnedThread = (thread: ThreadInfo): boolean =>
  thread.deletedAt === null && (thread.archivedAt === null || typeof thread.archivedAt === "string");

const isLiveThread = (thread: ThreadInfo): boolean => isOwnedThread(thread) && thread.archivedAt == null;

const buildNativeScope = (threads: readonly ThreadInfo[], owner: WorkflowOwner): NativeScope | null => {
  if (threads.length > maxScopeThreads) return null;
  const byId = new Map<string, ThreadInfo>();
  for (const thread of threads) {
    if (typeof thread.id !== "string" || !thread.id) continue;
    if (byId.has(thread.id)) return null;
    byId.set(thread.id, thread);
  }
  const main = byId.get(owner.mainThreadId);
  if (!main || main.projectId !== owner.projectId || !isLiveThread(main) || main.lineage.relationshipToParent === "subagent") return null;
  const allowedIds = new Set<string>([owner.mainThreadId]);
  const liveIds = new Set<string>([owner.mainThreadId]);
  const depthById = new Map<string, number>([[owner.mainThreadId, 0]]);
  const descendants: ThreadInfo[] = [];
  const isDescendant = (threadId: string): number | null => {
    let current = byId.get(threadId);
    if (!current || current.id === owner.mainThreadId) return current ? 0 : null;
    const visited = new Set<string>();
    let depth = 0;
    while (current.id !== owner.mainThreadId) {
      if (visited.has(current.id) || visited.size >= maxLineageDepth || current.projectId !== owner.projectId ||
        !isOwnedThread(current) || current.lineage.relationshipToParent !== "subagent" ||
        typeof current.lineage.parentThreadId !== "string" || !current.lineage.parentThreadId) return null;
      visited.add(current.id);
      current = byId.get(current.lineage.parentThreadId)!;
      if (!current) return null;
      depth++;
    }
    return depth;
  };
  for (const thread of threads) {
    if (thread.id === owner.mainThreadId) continue;
    const depth = isDescendant(thread.id);
    if (depth === null || depth === 0) continue;
    allowedIds.add(thread.id);
    if (isLiveThread(thread)) liveIds.add(thread.id);
    depthById.set(thread.id, depth);
    descendants.push(thread);
  }
  descendants.sort((left, right) => (depthById.get(left.id) ?? 0) - (depthById.get(right.id) ?? 0) || left.id.localeCompare(right.id));
  return {main, byId, descendants, allowedIds, liveIds, depthById};
};

const ownerFor = (binding: BindingRecord): WorkflowOwner => ({
  projectId: binding.projectId,
  mainThreadId: binding.mainThreadId,
  supervisorThreadId: binding.threadId,
  bindingGeneration: binding.generation,
});

const sameOwner = (left: WorkflowOwner, right: WorkflowOwner): boolean =>
  left.projectId === right.projectId && left.mainThreadId === right.mainThreadId &&
  left.supervisorThreadId === right.supervisorThreadId && left.bindingGeneration === right.bindingGeneration;

const isSuccessfulResult = (result: WorkflowWriteResult): boolean =>
  result.status === "created" || result.status === "applied" || result.status === "exists";

const operationIdOf = (value: WorkflowWritePayload): string =>
  value.action === "apply" ? value.input.operationId : value.operationId;

const operationConflict = (operationId: string): WorkflowMutationResult => ({
  status: "conflict", operationId, reason: "operation_id_reused", currentRevision: null,
});

const textSchema = (maxLength: number): Record<string, unknown> => ({type: "string", minLength: 1, maxLength});
const idSchema = (maxLength = workflowMutationLimits.maxOperationIdLength): Record<string, unknown> => ({type: "string", minLength: 1, maxLength});
const operationIdSchema = {...idSchema(), description: "Unique within this Supervisor binding and the edit namespace; use a stable action suffix."};
const locatorProperties = {
  supervisorThreadId: idSchema(),
  bindingGeneration: {type: "integer", minimum: 1, maximum: maxBindingGeneration},
};
const applyInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operationId", "workflowId", "expectedRevision", "note"],
  properties: {
    operationId: operationIdSchema,
    workflowId: idSchema(),
    expectedRevision: {type: "integer", minimum: 1},
    status: {type: "string", enum: workflowExecutionStatuses},
    objective: {type: ["string", "null"], maxLength: workflowMutationLimits.maxTextLength},
    rules: {type: "array", maxItems: workflowMutationLimits.maxRules, items: {
      type: "object", additionalProperties: false, required: ["index", "name", "applies", "reason"], properties: {
        index: {type: "integer", minimum: 0}, name: textSchema(workflowMutationLimits.maxTextLength),
        applies: {type: "boolean"}, reason: textSchema(workflowMutationLimits.maxTextLength),
      },
    }},
    steps: {type: "array", maxItems: workflowMutationLimits.maxSteps, items: {
      type: "object", additionalProperties: false, required: ["blockId", "name", "reason", "status", "contributorThreadIds"], properties: {
        id: idSchema(), blockId: {anyOf: [idSchema(), {type: "null"}]}, name: textSchema(workflowMutationLimits.maxTextLength),
        reason: textSchema(workflowMutationLimits.maxTextLength), status: {type: "string", enum: workflowExecutionStatuses},
        contributorThreadIds: {type: "array", maxItems: workflowMutationLimits.maxContributorsPerStep, uniqueItems: true, items: idSchema()},
      },
    }},
    note: textSchema(workflowMutationLimits.maxTextLength),
    evidence: {type: "array", maxItems: workflowMutationLimits.maxEvidencePerApply, items: {
      type: "object", additionalProperties: false, required: ["kind", "note"], properties: {
        kind: {type: "string", enum: ["status_changed", "note", "observation"]},
        note: textSchema(workflowMutationLimits.maxTextLength),
        targetStepId: {anyOf: [idSchema(), {type: "null"}]},
      },
    }},
  },
};

export const workflowReadToolDefinition = {
  name: "workflow_read",
  description: "Read bounded workflow records for this current Supervisor binding and a fresh main-thread descendant summary, including retained archived descendants and their archivedAt flags. Writes currently accept only strong Codex native item references; Claude Agent and unknown source labels are not authorized. currentAgreementKey only marks content matching a retained snapshot; it does not prove current acceptance, execution, or definition validity.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["supervisorThreadId", "bindingGeneration"],
    properties: {
      ...locatorProperties,
      workflowId: idSchema(),
      workflowOffset: {type: "integer", minimum: 0, maximum: 10_000},
      lineageOffset: {type: "integer", minimum: 0, maximum: 10_000},
      limit: {type: "integer", minimum: 1, maximum: maxWorkflowReadDocs},
    },
  },
} as const;

export const workflowWriteToolDefinition = {
  name: "workflow_write",
  description: "Create the main draft, link a verified live descendant, or update one current workflow with revision CAS. apply accepts only changed plan fields; omitted status, objective, rules, and steps remain unchanged. Write evidence is limited to a strong Codex native item reference; Claude Agent and unknown source labels are not authorized. Keep operationId unique within this Supervisor binding and edit namespace. Status and notes are agent-reported and do not prove execution. Never include source run or message claims.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "supervisorThreadId", "bindingGeneration"],
    properties: {
      ...locatorProperties,
      action: {type: "string", enum: ["ensure_main", "link_child", "apply"]},
      operationId: operationIdSchema,
      note: textSchema(workflowMutationLimits.maxTextLength),
      childThreadId: idSchema(),
      input: applyInputSchema,
    },
    oneOf: [
      {properties: {action: {const: "ensure_main"}}, required: ["operationId", "note"]},
      {properties: {action: {const: "link_child"}}, required: ["operationId", "childThreadId", "note"]},
      {properties: {action: {const: "apply"}}, required: ["input"]},
    ],
  },
} as const;

export class WorkflowWriteController {
  private readonly isEnabled: (projectId: string) => boolean;
  private readonly now: () => number;
  private readonly maxEvidenceWaitMs: number;
  private readonly pendingCandidateTtlMs: number;
  private readonly pendingCandidateCapacity: number;
  private readonly pendingCandidates = new Map<string, number>();

  constructor(readonly options: WorkflowWriteControllerOptions) {
    this.isEnabled = options.isEnabled ?? (projectId => options.supervisors.enabled(projectId));
    this.now = options.now ?? Date.now;
    this.maxEvidenceWaitMs = options.maxEvidenceWaitMs ?? 400;
    this.pendingCandidateTtlMs = options.pendingCandidateTtlMs ?? 120_000;
    this.pendingCandidateCapacity = options.pendingCandidateCapacity ?? 256;
    options.supervisors.store.db.exec(`
      CREATE TABLE IF NOT EXISTS supervisor_workflow_write_receipts (
        operation_id TEXT NOT NULL,
        operation_namespace TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        main_thread_id TEXT NOT NULL,
        supervisor_thread_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,main_thread_id,supervisor_thread_id,binding_generation,operation_namespace,operation_id)
      );
      CREATE TABLE IF NOT EXISTS supervisor_workflow_write_evidence (
        supervisor_thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation_namespace TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        main_thread_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        native_evidence TEXT NOT NULL,
        result TEXT NOT NULL,
        successful INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(supervisor_thread_id,item_id)
      );
      CREATE INDEX IF NOT EXISTS supervisor_workflow_write_evidence_operation
        ON supervisor_workflow_write_evidence(project_id,main_thread_id,supervisor_thread_id,binding_generation,operation_namespace,operation_id,created_at);
    `);
  }

  async read(input: unknown, signal = AbortSignal.timeout(10_000)): Promise<WorkflowReadResult> {
    let inputBytes: number;
    try {inputBytes = workflowToolInputSize(input);} catch {return {status: "invalid", reason: "arguments_not_json"};}
    if (inputBytes > workflowToolInputMaxBytes) return {status: "invalid", reason: "arguments_too_large"};
    const parsed = parseReadPayload(input);
    if (!parsed.ok) return {status: "invalid", reason: parsed.reason};
    const binding = this.resolveBinding(parsed.value);
    if (!binding) return {status: "denied", reason: "owner_not_current_ready_enabled"};
    const owner = ownerFor(binding);
    let threads: readonly ThreadInfo[];
    try {threads = await this.options.native.listThreads(signal);}
    catch {return {status: "unavailable", reason: "native_lineage_unavailable"};}
    const scope = buildNativeScope(threads, owner);
    if (!scope) return {status: "unavailable", reason: "native_lineage_incomplete"};
    const limit = parsed.value.limit ?? 20;
    const workflowOffset = parsed.value.workflowOffset ?? 0;
    const lineageOffset = parsed.value.lineageOffset ?? 0;
    const requestedLineage = [scope.main, ...scope.descendants].slice(lineageOffset, lineageOffset + limit).map(thread => ({
      threadId: thread.id,
      parentThreadId: thread.lineage.parentThreadId,
      relationshipToParent: thread.lineage.relationshipToParent,
      archivedAt: typeof thread.archivedAt === "string" ? thread.archivedAt : null,
    }));
    const rows = this.options.supervisors.store.transaction(() => {
      const current = this.resolveBinding(parsed.value);
      if (!current || !sameOwner(owner, ownerFor(current))) return {status: "owner_mismatch" as const};
      if (parsed.value.workflowId) {
        const result = this.options.workflows.getByIdForOwnerInTransaction(owner, parsed.value.workflowId);
        if (result.status === "owner_mismatch") return {status: "owner_mismatch" as const};
        if (result.status === "not_found") return {status: "not_found" as const};
        const document = result.document;
        if (!scope.allowedIds.has(document.threadId) || document.projectId !== owner.projectId || document.mainThreadId !== owner.mainThreadId)
          return {status: "not_found" as const};
        return {status: "ok" as const, documents: [document]};
      }
      return {status: "ok" as const, documents: this.options.workflows.list(owner.projectId, owner.mainThreadId)
        .filter(document => scope.allowedIds.has(document.threadId) && document.projectId === owner.projectId && document.mainThreadId === owner.mainThreadId)
        .sort((left, right) => scope.depthById.get(left.threadId)! - scope.depthById.get(right.threadId)! || left.threadId.localeCompare(right.threadId))};
    });
    if (rows.status === "owner_mismatch") return {status: "denied", reason: "owner_changed"};
    if (rows.status === "not_found") return {status: "unavailable", reason: "workflow_not_found_in_current_scope"};
    const all = rows.documents;
    const page = all.slice(workflowOffset, workflowOffset + limit);
    const withReferences = page.map(document => ({
      document,
      parentStepReferences: this.parentStepReferences(owner, scope, document),
    }));
    const task = this.options.supervisors.task(owner.mainThreadId);
    const result: WorkflowReadResult = {
      status: "ok",
      owner,
      mainTaskAgreementStatus: task?.agreement?.status ?? null,
      agreementValidityNote: "Agreement status is current task metadata. currentAgreementKey only marks content matching a retained accepted snapshot; neither field proves execution or current definition validity.",
      workflows: withReferences,
      workflowOffset,
      workflowHasMore: workflowOffset + page.length < all.length,
      lineage: requestedLineage,
      lineageOffset,
      lineageHasMore: lineageOffset + requestedLineage.length < 1 + scope.descendants.length,
    };
    let size = Buffer.byteLength(JSON.stringify(result), "utf8");
    while (size > maxWorkflowReadBytes && result.workflows.length > 1) {
      result.workflows.pop();
      result.workflowHasMore = true;
      size = Buffer.byteLength(JSON.stringify(result), "utf8");
    }
    if (size > maxWorkflowReadBytes) return {status: "too_large", reason: "workflow_read_exceeds_response_limit"};
    return result;
  }

  async write(input: unknown, signal = AbortSignal.timeout(10_000)): Promise<WorkflowWriteResult> {
    let inputBytes: number;
    try {inputBytes = workflowToolInputSize(input);} catch {return {status: "invalid", reason: "arguments_not_json"};}
    if (inputBytes > workflowToolInputMaxBytes) return {status: "invalid", reason: "arguments_too_large"};
    const parsed = parseWritePayload(input);
    if (!parsed.ok) return {status: "invalid", ...(parsed.operationId ? {operationId: parsed.operationId} : {}), reason: parsed.reason};
    const payload = parsed.value;
    const binding = this.resolveBinding(payload);
    if (!binding) return {status: "denied", operationId: operationIdOf(payload), reason: "owner_not_current_ready_enabled"};
    const owner = ownerFor(binding);
    const operationId = operationIdOf(payload);
    const requestHash = workflowRequestHash({owner, arguments: payload});
    const receipt = this.readOperationReceipt(owner, writeOperationNamespace, operationId, requestHash);
    if (receipt.kind === "replay") return receipt.result;
    if (receipt.kind === "conflict") return operationConflict(operationId);

    const verified = await this.findEvidence(payload, owner, signal);
    if (verified.status === "pending") {
      this.rememberPendingCandidate(requestHash);
      return {status: "pending", operationId, reason: verified.reason, retryable: true};
    }
    if (verified.status === "denied") return {status: "denied", operationId, reason: verified.reason};
    if (signal.aborted) {
      this.rememberPendingCandidate(requestHash);
      return {status: "pending", operationId, reason: "native_evidence_wait_interrupted", retryable: true};
    }
    const evidence = verified.evidence;
    let threads: readonly ThreadInfo[];
    try {threads = await this.options.native.listThreads(signal);}
    catch {
      this.rememberPendingCandidate(requestHash);
      return {status: "pending", operationId, reason: "native_lineage_unavailable", retryable: true};
    }
    if (signal.aborted) {
      this.rememberPendingCandidate(requestHash);
      return {status: "pending", operationId, reason: "native_lineage_interrupted", retryable: true};
    }
    const scope = buildNativeScope(threads, owner);
    if (!scope) return this.commitDenied(owner, payload, evidence, requestHash, "native_lineage_incomplete");
    if (payload.action === "link_child" && !scope.liveIds.has(payload.childThreadId))
      return this.commitDenied(owner, payload, evidence, requestHash, "child_not_current_native_descendant");

    const result = this.commitWrite(owner, payload, evidence, requestHash, scope);
    this.pendingCandidates.delete(requestHash);
    return result;
  }

  private resolveBinding(locator: WorkflowLocator): BindingRecord | null {
    if (!this.options.supervisors.scopeCompatible) return null;
    const rows = this.options.supervisors.store.db.prepare(
      "SELECT document FROM supervisor_main_bindings WHERE json_extract(document,'$.threadId')=? LIMIT 2",
    ).all(locator.supervisorThreadId);
    if (rows.length !== 1) return null;
    let binding: BindingRecord;
    try {binding = JSON.parse(String(rows[0]?.document)) as BindingRecord;}
    catch {return null;}
    if (binding.threadId !== locator.supervisorThreadId || binding.generation !== locator.bindingGeneration ||
      binding.state !== "ready" || !this.options.supervisors.ownedIds.has(binding.threadId) ||
      !isId(binding.projectId) || !isId(binding.mainThreadId)) return null;
    try {if (!this.isEnabled(binding.projectId)) return null;}
    catch {return null;}
    return binding;
  }

  private async findEvidence(payload: WorkflowWritePayload, owner: WorkflowOwner, signal: AbortSignal): Promise<
    | {status: "verified"; evidence: WorkflowEvidenceMatch}
    | {status: "pending"; reason: string}
    | {status: "denied"; reason: string}
  > {
    const startedAt = performance.now();
    let lastReason = "native_evidence_not_visible";
    const inspected = new Map<string, {signature: string; check: WorkflowEvidenceCheck; retryAfter?: number; retryCount: number}>();
    let detailReads = 0;
    const maxDetailReads = 64;
    do {
      if (signal.aborted) return {status: "pending", reason: "native_evidence_wait_interrupted"};
      let projection: Projection;
      try {projection = await this.options.native.projection(payload.supervisorThreadId, signal);}
      catch {
        lastReason = "supervisor_projection_unavailable";
        if (performance.now() - startedAt >= this.maxEvidenceWaitMs) break;
        await this.pauseEvidencePoll(signal);
        continue;
      }
      if (projection.thread.id !== payload.supervisorThreadId || projection.thread.projectId !== owner.projectId ||
        projection.thread.archivedAt != null || projection.thread.deletedAt != null)
        return {status: "denied", reason: "supervisor_projection_not_current"};
      const candidates = workflowEvidenceCandidates(projection, payload.supervisorThreadId, "write", payload);
      for (const candidate of candidates) {
        if (signal.aborted) return {status: "pending", reason: "native_evidence_wait_interrupted"};
        const cached = inspected.get(candidate.itemId);
        const canRetry = cached?.signature === candidate.snapshotSignature && cached.retryAfter !== undefined &&
          cached.retryCount < 1 && this.now() >= cached.retryAfter;
        let check: WorkflowEvidenceCheck;
        if (cached?.signature === candidate.snapshotSignature && !canRetry) {
          check = cached.check;
        } else {
          if (detailReads >= maxDetailReads) {
            lastReason = "native_item_detail_limit";
            continue;
          }
          detailReads++;
          let detail: unknown;
          try {
            const response = await this.options.native.getTurnItem({threadId: payload.supervisorThreadId, itemId: candidate.itemId}, signal);
            detail = response.item;
          } catch {
            check = {status: "pending", reason: "native_item_detail_unavailable"};
            const retryCount = cached?.signature === candidate.snapshotSignature ? cached.retryCount + Number(canRetry) : 0;
            inspected.set(candidate.itemId, {signature: candidate.snapshotSignature, check, retryAfter: this.now() + 100, retryCount});
            lastReason = check.reason;
            continue;
          }
          if (!isRecord(detail)) {
            check = {status: "pending", reason: "native_item_unavailable"};
          } else {
            let detailBytes = Number.POSITIVE_INFINITY;
            try {detailBytes = Buffer.byteLength(JSON.stringify(detail), "utf8");} catch { /* invalid native detail remains pending */ }
            if (detailBytes > workflowTurnItemDetailMaxBytes) {
              check = {status: "pending", reason: "native_item_detail_too_large"};
            } else {
              check = verifyWorkflowToolEvidence({projection, supervisorThreadId: payload.supervisorThreadId,
                itemId: candidate.itemId, detail, tool: "write", arguments: payload});
            }
          }
          const retryCount = cached?.signature === candidate.snapshotSignature ? cached.retryCount + Number(canRetry) : 0;
          const retryableUnavailable = check.status === "pending" &&
            ["native_item_unavailable", "native_item_detail_unavailable"].includes(check.reason);
          inspected.set(candidate.itemId, {signature: candidate.snapshotSignature, check,
            ...(retryableUnavailable && retryCount < 1 ? {retryAfter: this.now() + 100} : {}), retryCount});
        }
        if (check.status === "verified") return {status: "verified", evidence: check.evidence};
        if (check.status === "denied") return {status: "denied", reason: check.reason};
        lastReason = check.reason;
      }
      if (performance.now() - startedAt >= this.maxEvidenceWaitMs) break;
      await this.pauseEvidencePoll(signal);
    } while (true);
    return {status: "pending", reason: lastReason};
  }

  private pauseEvidencePoll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(done, 50);
      const abort = () => done();
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      }
      signal.addEventListener("abort", abort, {once: true});
    });
  }

  private rememberPendingCandidate(requestHash: string): void {
    const now = this.now();
    for (const [key, seenAt] of this.pendingCandidates) if (now - seenAt > this.pendingCandidateTtlMs) this.pendingCandidates.delete(key);
    if (!this.pendingCandidates.has(requestHash) && this.pendingCandidates.size >= this.pendingCandidateCapacity) {
      const oldest = [...this.pendingCandidates.entries()].sort((left, right) => left[1] - right[1])[0]?.[0];
      if (oldest !== undefined) this.pendingCandidates.delete(oldest);
    }
    this.pendingCandidates.set(requestHash, now);
  }

  private readOperationReceipt(owner: WorkflowOwner, operationNamespace: "edit", operationId: string, requestHash: string):
    | {kind: "none"}
    | {kind: "replay"; result: WorkflowWriteResult}
    | {kind: "conflict"} {
    const row = this.options.supervisors.store.db.prepare(
      "SELECT request_hash,project_id,main_thread_id,supervisor_thread_id,binding_generation,operation_namespace,result FROM supervisor_workflow_write_receipts WHERE project_id=? AND main_thread_id=? AND supervisor_thread_id=? AND binding_generation=? AND operation_namespace=? AND operation_id=?",
    ).get(owner.projectId, owner.mainThreadId, owner.supervisorThreadId, owner.bindingGeneration, operationNamespace, operationId) as ProofRow | undefined;
    if (!row) return {kind: "none"};
    if (row.request_hash !== requestHash || row.operation_namespace !== operationNamespace || row.project_id !== owner.projectId ||
      row.main_thread_id !== owner.mainThreadId || row.supervisor_thread_id !== owner.supervisorThreadId ||
      Number(row.binding_generation) !== owner.bindingGeneration) return {kind: "conflict"};
    try {return {kind: "replay", result: JSON.parse(row.result) as WorkflowWriteResult};}
    catch {return {kind: "conflict"};}
  }

  private commitDenied(
    owner: WorkflowOwner,
    payload: WorkflowWritePayload,
    evidence: WorkflowEvidenceMatch,
    requestHash: string,
    reason: string,
  ): WorkflowWriteResult {
    return this.commit(owner, payload, evidence, requestHash, () => ({status: "denied", operationId: operationIdOf(payload), reason}));
  }

  private commitWrite(
    owner: WorkflowOwner,
    payload: WorkflowWritePayload,
    evidence: WorkflowEvidenceMatch,
    requestHash: string,
    scope: NativeScope,
  ): WorkflowWriteResult {
    return this.commit(owner, payload, evidence, requestHash, () => {
      if (payload.action === "ensure_main")
        return this.options.workflows.ensureMainInTransaction(owner, payload.operationId, payload.note, this.now());
      if (payload.action === "link_child") {
        const child = scope.byId.get(payload.childThreadId);
        const parentThreadId = child?.lineage.parentThreadId;
        if (!child || !scope.liveIds.has(child.id) || typeof parentThreadId !== "string" || !scope.allowedIds.has(parentThreadId))
          return {status: "denied", operationId: payload.operationId, reason: "child_parent_not_in_current_scope"};
        const lineage: WorkflowControllerLineage = {threadId: child.id, parentThreadId, relationshipToParent: "subagent"};
        return this.options.workflows.linkChildInTransaction(owner, {operationId: payload.operationId, lineage, note: payload.note}, this.now());
      }
      const found = this.options.workflows.getByIdForOwnerInTransaction(owner, payload.input.workflowId);
      if (found.status === "owner_mismatch") return {status: "owner_mismatch", operationId: payload.input.operationId};
      if (found.status === "not_found") return {status: "not_found", operationId: payload.input.operationId};
      if (!scope.allowedIds.has(found.document.threadId) ||
        found.document.projectId !== owner.projectId || found.document.mainThreadId !== owner.mainThreadId)
        return {status: "denied", operationId: payload.input.operationId, reason: "workflow_outside_current_scope"};
      const current = found.document;
      const applyInput: WorkflowApplyInput = {
        operationId: payload.input.operationId,
        workflowId: payload.input.workflowId,
        expectedRevision: payload.input.expectedRevision,
        status: payload.input.status ?? current.status,
        objective: payload.input.objective === undefined ? current.objective : payload.input.objective,
        rules: payload.input.rules ?? current.rules,
        steps: payload.input.steps ?? current.steps,
        note: payload.input.note,
        ...(payload.input.evidence !== undefined ? {evidence: payload.input.evidence} : {}),
      };
      const contributorsByStep = new Map(current.steps.map(step => [step.id, new Set(step.contributorThreadIds)]));
      for (const step of applyInput.steps) {
        const existingOnStep = typeof step.id === "string" ? contributorsByStep.get(step.id) : undefined;
        for (const contributorThreadId of step.contributorThreadIds) {
          if (existingOnStep?.has(contributorThreadId)) continue;
          if (!scope.allowedIds.has(contributorThreadId))
            return {status: "denied", operationId: applyInput.operationId, reason: "contributor_outside_current_scope"};
          if (!scope.liveIds.has(contributorThreadId))
            return {status: "denied", operationId: applyInput.operationId, reason: "new_contributor_not_live"};
        }
      }
      return this.options.workflows.applyInTransaction(owner, applyInput, this.now());
    });
  }

  private commit(
    owner: WorkflowOwner,
    payload: WorkflowWritePayload,
    evidence: WorkflowEvidenceMatch,
    requestHash: string,
    execute: () => WorkflowWriteResult,
  ): WorkflowWriteResult {
    const operationId = operationIdOf(payload);
    try {
      return this.options.supervisors.store.transaction(() => {
        const latest = this.resolveBinding(payload);
        if (!latest || !sameOwner(owner, ownerFor(latest))) return {status: "denied", operationId, reason: "owner_changed"};
        const existingEvidence = this.options.supervisors.store.db.prepare(
          "SELECT operation_id,operation_namespace,request_hash,project_id,main_thread_id,binding_generation,result FROM supervisor_workflow_write_evidence WHERE supervisor_thread_id=? AND item_id=?",
        ).get(owner.supervisorThreadId, evidence.itemId);
        if (existingEvidence) {
          const row = existingEvidence as {operation_id: string; operation_namespace: string; request_hash: string; project_id: string; main_thread_id: string; binding_generation: number; result: string};
          if (row.operation_id !== operationId || row.operation_namespace !== writeOperationNamespace || row.request_hash !== requestHash || row.project_id !== owner.projectId ||
            row.main_thread_id !== owner.mainThreadId || Number(row.binding_generation) !== owner.bindingGeneration)
            return {status: "denied", operationId, reason: "native_evidence_reused"};
          return JSON.parse(row.result) as WorkflowWriteResult;
        }
        const prior = this.readOperationReceipt(owner, writeOperationNamespace, operationId, requestHash);
        if (prior.kind === "conflict") return operationConflict(operationId);
        if (prior.kind === "replay") {
          this.recordEvidence(owner, payload, evidence, requestHash, prior.result, true);
          return prior.result;
        }
        const result = execute();
        if (result.status === "owner_mismatch") return result;
        const successful = isSuccessfulResult(result);
        if (successful) {
          this.options.supervisors.store.db.prepare(
            "INSERT INTO supervisor_workflow_write_receipts(operation_id,operation_namespace,request_hash,project_id,main_thread_id,supervisor_thread_id,binding_generation,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          ).run(operationId, writeOperationNamespace, requestHash, owner.projectId, owner.mainThreadId, owner.supervisorThreadId,
            owner.bindingGeneration, JSON.stringify(result), this.now());
        }
        this.recordEvidence(owner, payload, evidence, requestHash, result, successful);
        return result;
      });
    } catch {
      return {status: "denied", operationId, reason: "workflow_write_transaction_failed"};
    }
  }

  private recordEvidence(
    owner: WorkflowOwner,
    payload: WorkflowWritePayload,
    evidence: WorkflowEvidenceMatch,
    requestHash: string,
    result: WorkflowWriteResult,
    successful: boolean,
  ): void {
    const nativeEvidence = canonicalJson({
      itemId: evidence.itemId,
      runId: evidence.runId,
      toolName: evidence.toolName,
      inputHash: evidence.inputHash,
      nativeInputCanonical: evidence.nativeInputCanonical,
      providerThreadId: evidence.providerThreadId,
      ordinal: evidence.ordinal,
      status: evidence.status,
      nativeItemRef: evidence.nativeItemRef,
      owner,
    });
    this.options.supervisors.store.db.prepare(
      "INSERT INTO supervisor_workflow_write_evidence(supervisor_thread_id,item_id,operation_id,operation_namespace,request_hash,project_id,main_thread_id,binding_generation,native_evidence,result,successful,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(owner.supervisorThreadId, evidence.itemId, operationIdOf(payload), writeOperationNamespace, requestHash, owner.projectId, owner.mainThreadId,
      owner.bindingGeneration, nativeEvidence, JSON.stringify(result), successful ? 1 : 0, this.now());
  }

  private parentStepReferences(owner: WorkflowOwner, scope: NativeScope, document: WorkflowStateDocument): Array<{
    parentWorkflowId: string;
    parentThreadId: string;
    stepId: string;
    stepName: string;
  }> {
    if (!document.parentWorkflowId || !document.parentThreadId || !scope.allowedIds.has(document.parentThreadId)) return [];
    const parent = this.options.workflows.get(owner.projectId, owner.mainThreadId, document.parentThreadId);
    if (!parent || parent.workflowId !== document.parentWorkflowId) return [];
    return parent.steps.filter(step => step.contributorThreadIds.includes(document.threadId)).map(step => ({
      parentWorkflowId: parent.workflowId,
      parentThreadId: parent.threadId,
      stepId: step.id,
      stepName: step.name,
    }));
  }
}
