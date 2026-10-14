import {Buffer} from "node:buffer";
import { randomUUID } from "node:crypto";
import { fingerprint } from "./guidance-store.js";
import type { ProjectSupervisorStore } from "./project-supervisor-store.js";
import {
  workflowExecutionStatuses,
  workflowMutationLimits,
  type AcceptedWorkflowAgreementRecord,
  type WorkflowAgreementImport,
  type WorkflowApplyInput,
  type WorkflowControllerLineage,
  type WorkflowEnsureResult,
  type WorkflowExecutionStatus,
  type WorkflowMutationReceipt,
  type WorkflowMutationResult,
  type WorkflowOwner,
  type WorkflowStateDocument,
  type WorkflowStateEvidence,
  type WorkflowStateEvidenceInput,
  type WorkflowStateLookupResult,
  type WorkflowStateRule,
  type WorkflowStateStep,
  type WorkflowStateStepInput,
} from "./workflow-state-contract.js";

type StoredOperation = {request_hash: string; result: string};
type WorkflowOperationNamespace = "edit" | "agreement";

type WorkflowRow = {
  workflow_id: string;
  project_id: string;
  main_thread_id: string;
  thread_id: string;
  parent_workflow_id: string | null;
  parent_thread_id: string | null;
  revision: number;
  document: string;
};

const statuses = new Set<string>(workflowExecutionStatuses);
const isStatus = (value: unknown): value is WorkflowExecutionStatus => typeof value === "string" && statuses.has(value);
const validText = (value: unknown, allowEmpty = false): value is string =>
  typeof value === "string" && value.length <= workflowMutationLimits.maxTextLength && (allowEmpty || value.trim().length > 0);
const validId = (value: unknown, limit = workflowMutationLimits.maxOperationIdLength): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;
const json = (value: unknown): string => JSON.stringify(value);
const documentFits = (serialized: string): boolean => Buffer.byteLength(serialized, "utf8") <= workflowMutationLimits.maxDocumentBytes;
const canonicalRequestValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalRequestValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalRequestValue(record[key])]));
};
const requestFingerprint = (value: unknown): string => fingerprint(canonicalRequestValue(value));

const workflowPlanSignature = (objective: string | null, rules: readonly WorkflowStateRule[], steps: readonly Pick<WorkflowStateStep, "blockId" | "name" | "reason">[]): string =>
  fingerprint({objective, rules, steps: steps.map(step => ({blockId: step.blockId, name: step.name, reason: step.reason}))});

const validRules = (rules: unknown): rules is WorkflowStateRule[] => Array.isArray(rules) && rules.length <= workflowMutationLimits.maxRules &&
  rules.every(rule => rule !== null && typeof rule === "object" && Number.isSafeInteger(rule.index) && rule.index >= 0 &&
    validText(rule.name) && typeof rule.applies === "boolean" && validText(rule.reason));

const validEvidenceInput = (evidence: unknown): evidence is readonly WorkflowStateEvidenceInput[] =>
  evidence === undefined || Array.isArray(evidence) && evidence.length <= workflowMutationLimits.maxEvidencePerApply && evidence.every(item => item !== null &&
    typeof item === "object" && ["status_changed", "note", "observation"].includes(item.kind) && validText(item.note) &&
    (item.targetStepId === undefined || item.targetStepId === null || validId(item.targetStepId)) &&
    (item.sourceThreadId === undefined || item.sourceThreadId === null || validId(item.sourceThreadId)) &&
    (item.sourceRunId === undefined || item.sourceRunId === null || validId(item.sourceRunId)) &&
    (item.sourceMessageId === undefined || item.sourceMessageId === null || validId(item.sourceMessageId)));

const acceptedKey = (taskId: string, proposalId: string): string => "agreement:" + fingerprint([taskId, proposalId]);

/** Persists broad per-main workflow state without turning plans into a scheduler. */
export class WorkflowStateStore {
  constructor(readonly supervisors: ProjectSupervisorStore,
    private readonly isEnabled: (projectId: string) => boolean = projectId => supervisors.enabled(projectId)) {
    supervisors.store.db.exec("CREATE TABLE IF NOT EXISTS supervisor_workflow_state (" +
      "workflow_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,thread_id TEXT NOT NULL," +
      "parent_workflow_id TEXT,parent_thread_id TEXT,revision INTEGER NOT NULL,document TEXT NOT NULL," +
      "created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(project_id,main_thread_id,thread_id));" +
      "CREATE INDEX IF NOT EXISTS supervisor_workflow_scope ON supervisor_workflow_state(project_id,main_thread_id);" +
      "CREATE TABLE IF NOT EXISTS supervisor_workflow_operations (" +
      "project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,actor_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL," +
      "operation_namespace TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,workflow_id TEXT NOT NULL," +
      "created_at INTEGER NOT NULL,PRIMARY KEY(project_id,main_thread_id,actor_thread_id,binding_generation,operation_namespace,operation_id));");
  }

  get(projectId: string, mainThreadId: string, threadId = mainThreadId): WorkflowStateDocument | null {
    const row = this.supervisors.store.db.prepare("SELECT document FROM supervisor_workflow_state WHERE project_id=? AND main_thread_id=? AND thread_id=?")
      .get(projectId, mainThreadId, threadId);
    return row ? JSON.parse(String(row.document)) as WorkflowStateDocument : null;
  }

  /** Looks up a workflow by ID only for the current owner inside its transaction. */
  getByIdForOwnerInTransaction(owner: WorkflowOwner, workflowId: string): WorkflowStateLookupResult {
    if (!this.currentOwner(owner)) return {status: "owner_mismatch"};
    if (!validId(workflowId)) return {status: "not_found"};
    const row = this.workflowById(owner, workflowId);
    return row ? {status: "found", document: JSON.parse(row.document) as WorkflowStateDocument} : {status: "not_found"};
  }

  list(projectId: string, mainThreadId: string): WorkflowStateDocument[] {
    return this.supervisors.store.db.prepare("SELECT document FROM supervisor_workflow_state WHERE project_id=? AND main_thread_id=? ORDER BY created_at,thread_id")
      .all(projectId, mainThreadId).map(row => JSON.parse(String(row.document)) as WorkflowStateDocument);
  }

  apply(owner: WorkflowOwner, input: WorkflowApplyInput, now = Date.now()): WorkflowMutationResult {
    return this.supervisors.store.transaction(() => this.applyInTransaction(owner, input, now));
  }

  /** Applies a full editable document inside a controller-owned transaction. */
  applyInTransaction(owner: WorkflowOwner, input: WorkflowApplyInput, now = Date.now()): WorkflowMutationResult {
    if (!validId(input.operationId) || !validId(input.workflowId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      !validText(input.note) || !isStatus(input.status) || !(input.objective === null || validText(input.objective)) ||
      !validRules(input.rules) || !Array.isArray(input.steps) || input.steps.length > workflowMutationLimits.maxSteps || !validEvidenceInput(input.evidence))
      return {status: "invalid", operationId: input.operationId, reason: "invalid_workflow_document"};
    if (!this.currentOwner(owner)) return {status: "owner_mismatch", operationId: input.operationId};

    const requestHash = requestFingerprint({kind: "apply", owner, input});
    const replay = this.operationReplay(owner, "edit", input.operationId, requestHash);
    if (replay) return replay;

    const row = this.workflowById(owner, input.workflowId);
    if (!row) return {status: "not_found", operationId: input.operationId};
    const current = JSON.parse(row.document) as WorkflowStateDocument;
    if (current.revision !== input.expectedRevision) return {status: "conflict", operationId: input.operationId,
      reason: "revision", currentRevision: current.revision};

    const normalized = this.normalizeSteps(input.steps, current.steps);
    if (!normalized || !this.statusEvidenceValid(current, input, normalized))
      return {status: "invalid", operationId: input.operationId, reason: "invalid_steps_or_missing_status_evidence"};
    const evidenceInputs = input.evidence ?? [];
    const nextSteps = normalized.steps;
    const previousSteps = new Map(current.steps.map(step => [step.id, step]));
    const nextStepIds = new Set(nextSteps.map(step => step.id));
    const evidence = [...current.evidence];
    for (const item of evidenceInputs) {
      const stepId = item.targetStepId ?? null;
      const previous = stepId ? previousSteps.get(stepId) : null;
      const next = stepId ? nextSteps.find(step => step.id === stepId) : null;
      evidence.push(this.makeEvidence({operationId: input.operationId, owner, kind: item.kind, now,
        targetStepId: stepId, targetStepName: next?.name ?? previous?.name ?? null,
        statusFrom: previous?.status ?? (stepId === null ? current.status : null),
        statusTo: next?.status ?? (stepId === null ? input.status : null),
        sourceThreadId: item.sourceThreadId ?? null, sourceRunId: item.sourceRunId ?? null,
        sourceMessageId: item.sourceMessageId ?? null, agreementKey: null, note: item.note}));
    }
    const removed = current.steps.filter(step => !nextStepIds.has(step.id));
    for (const step of removed) evidence.push(this.makeEvidence({operationId: input.operationId, owner, kind: "step_removed", now,
      targetStepId: step.id, targetStepName: step.name, statusFrom: step.status, statusTo: null,
      sourceThreadId: null, sourceRunId: null, sourceMessageId: null, agreementKey: null, note: input.note}));

    const oldPlanHash = workflowPlanSignature(current.objective, current.rules, current.steps);
    const newPlanHash = workflowPlanSignature(input.objective, input.rules, nextSteps);
    evidence.push(this.makeEvidence({operationId: input.operationId, owner, kind: "plan_updated", now,
      targetStepId: null, targetStepName: null, statusFrom: current.status, statusTo: input.status,
      sourceThreadId: null, sourceRunId: null, sourceMessageId: null, agreementKey: null, note: input.note}));
    if (evidence.length > workflowMutationLimits.maxEvidence) return {status: "invalid", operationId: input.operationId, reason: "evidence_capacity"};

    const next: WorkflowStateDocument = {...current, revision: current.revision + 1, status: input.status, objective: input.objective,
      rules: input.rules.map(rule => ({index: rule.index, name: rule.name, applies: rule.applies, reason: rule.reason})),
      steps: nextSteps, currentAgreementKey: oldPlanHash === newPlanHash ? current.currentAgreementKey : null,
      evidence, updatedAt: now};
    const serialized = json(next);
    if (!documentFits(serialized)) return {status: "invalid", operationId: input.operationId, reason: "document_capacity"};
    const update = this.supervisors.store.db.prepare("UPDATE supervisor_workflow_state SET revision=?,document=?,updated_at=? WHERE workflow_id=? AND project_id=? AND main_thread_id=? AND revision=?")
      .run(next.revision, serialized, now, current.workflowId, owner.projectId, owner.mainThreadId, input.expectedRevision);
    if (Number(update.changes) !== 1) {
      const latest = this.workflowById(owner, current.workflowId);
      return {status: "conflict", operationId: input.operationId, reason: "revision", currentRevision: latest?.revision ?? null};
    }
    const receipt = this.receipt("applied", input.operationId, next);
    this.recordOperation(owner, "edit", input.operationId, requestHash, receipt, now);
    return receipt;
  }

  /** Creates an unaccepted main draft inside the verified controller transaction. */
  ensureMainInTransaction(owner: WorkflowOwner, operationId: string, note: string, now = Date.now()): WorkflowEnsureResult {
    if (!validId(operationId) || !validText(note)) return {status: "invalid", operationId, reason: "invalid_main_workflow_draft"};
    if (!this.currentOwner(owner)) return {status: "owner_mismatch", operationId};
    const requestHash = requestFingerprint({kind: "ensure-main", owner, note});
    const replay = this.operationReplay(owner, "edit", operationId, requestHash);
    if (replay) return replay;
    const existing = this.workflowByThread(owner, owner.mainThreadId);
    if (existing) {
      const document = JSON.parse(existing.document) as WorkflowStateDocument;
      return {status: "exists", operationId, workflowId: document.workflowId, revision: document.revision, stateHash: fingerprint(document)};
    }

    const document = this.emptyDocument(owner, owner.mainThreadId, null, null, 1, now);
    document.evidence.push(this.makeEvidence({operationId, owner, kind: "draft_created", now,
      targetStepId: null, targetStepName: null, statusFrom: null, statusTo: "planned",
      sourceThreadId: null, sourceRunId: null, sourceMessageId: null, agreementKey: null, note}));
    const serialized = json(document);
    if (!documentFits(serialized)) return {status: "invalid", operationId, reason: "document_capacity"};
    this.insertWorkflow(document, serialized);
    const receipt = this.receipt("created", operationId, document);
    this.recordOperation(owner, "edit", operationId, requestHash, receipt, now);
    return receipt;
  }

  /** Links a native descendant without inferring a proposal or agreement for it. */
  linkChildInTransaction(owner: WorkflowOwner, input: {operationId: string; lineage: WorkflowControllerLineage; note: string}, now = Date.now()): WorkflowMutationResult {
    const {operationId, lineage} = input;
    if (!validId(operationId) || !validId(lineage.threadId) || !validId(lineage.parentThreadId) ||
      lineage.relationshipToParent !== "subagent" || lineage.threadId === owner.mainThreadId || !validText(input.note))
      return {status: "invalid", operationId, reason: "invalid_child_lineage"};
    if (!this.currentOwner(owner)) return {status: "owner_mismatch", operationId};
    const requestHash = requestFingerprint({kind: "link-child", owner, lineage, note: input.note});
    const replay = this.operationReplay(owner, "edit", operationId, requestHash);
    if (replay) return replay;

    const parent = this.workflowByThread(owner, lineage.parentThreadId);
    if (!parent) return {status: "conflict", operationId, reason: "parent_missing", currentRevision: null};
    const existing = this.workflowByThread(owner, lineage.threadId);
    if (existing) return {status: "conflict", operationId, reason: "child_already_linked", currentRevision: existing.revision};
    const parentDocument = JSON.parse(parent.document) as WorkflowStateDocument;
    const document = this.emptyDocument(owner, lineage.threadId, parentDocument.workflowId, lineage.parentThreadId, 1, now);
    document.evidence.push(this.makeEvidence({operationId, owner, kind: "lineage_linked", now,
      targetStepId: null, targetStepName: null, statusFrom: null, statusTo: "planned",
      sourceThreadId: lineage.threadId, sourceRunId: null, sourceMessageId: null, agreementKey: null, note: input.note}));
    const serialized = json(document);
    if (!documentFits(serialized)) return {status: "invalid", operationId, reason: "document_capacity"};
    this.insertWorkflow(document, serialized);
    const receipt = this.receipt("created", operationId, document);
    this.recordOperation(owner, "edit", operationId, requestHash, receipt, now);
    return receipt;
  }

  /** Imports a validated acceptance without changing an already populated broad plan. */
  importAcceptedAgreementInTransaction(owner: WorkflowOwner, source: WorkflowAgreementImport, now = Date.now()): WorkflowMutationResult {
    const operationId = acceptedKey(source.taskId, source.agreement.proposalId);
    if (!this.validAgreementImport(source)) return {status: "invalid", operationId, reason: "invalid_accepted_agreement"};
    if (!this.currentOwner(owner)) return {status: "owner_mismatch", operationId};
    const requestHash = requestFingerprint({kind: "agreement-import", owner, source});
    const replay = this.operationReplay(owner, "agreement", operationId, requestHash);
    if (replay) return replay;

    const row = this.workflowByThread(owner, source.sourceThreadId);
    const creatingMain = !row && source.sourceThreadId === owner.mainThreadId;
    if (!row && !creatingMain) return {status: "not_found", operationId};
    const current = row ? JSON.parse(row.document) as WorkflowStateDocument :
      this.emptyDocument(owner, owner.mainThreadId, null, null, 0, now);
    if (current.acceptedAgreements.some(item => item.key === acceptedKey(source.taskId, source.agreement.proposalId))) {
      const receipt = this.receipt("applied", operationId, current);
      this.recordOperation(owner, "agreement", operationId, requestHash, receipt, now);
      return receipt;
    }
    if (current.acceptedAgreements.length >= workflowMutationLimits.maxAcceptedAgreements)
      return {status: "invalid", operationId, reason: "agreement_history_capacity"};
    if (current.evidence.length >= workflowMutationLimits.maxEvidence)
      return {status: "invalid", operationId, reason: "evidence_capacity"};

    const key = acceptedKey(source.taskId, source.agreement.proposalId);
    const accepted: AcceptedWorkflowAgreementRecord = {key, taskId: source.taskId, sourceThreadId: source.sourceThreadId,
      sourceRunId: source.sourceRunId, sourceMessageId: source.sourceMessageId, sourceHash: source.sourceHash,
      objective: source.objective, planHash: this.acceptedPlanHash(source), agreement: source.agreement};
    const acceptedPlan = this.acceptedPlan(source);
    const emptyPlan = current.objective === null && current.rules.length === 0 && current.steps.length === 0;
    const currentMatches = workflowPlanSignature(current.objective, current.rules, current.steps) ===
      workflowPlanSignature(source.objective, acceptedPlan.rules, acceptedPlan.steps);
    const shouldSeed = emptyPlan;
    const next: WorkflowStateDocument = {...current, revision: current.revision + 1,
      ...(shouldSeed ? {objective: source.objective, rules: acceptedPlan.rules, steps: acceptedPlan.steps} : {}),
      currentAgreementKey: shouldSeed || currentMatches ? key : current.currentAgreementKey,
      acceptedAgreements: [...current.acceptedAgreements, accepted],
      evidence: [...current.evidence, this.makeEvidence({operationId, owner, kind: "agreement_imported", now,
        targetStepId: null, targetStepName: null, statusFrom: null, statusTo: null,
        sourceThreadId: source.sourceThreadId, sourceRunId: source.sourceRunId, sourceMessageId: source.sourceMessageId,
        agreementKey: key, note: "A validated workflow agreement was retained as historical source evidence."})],
      updatedAt: now};
    const serialized = json(next);
    if (!documentFits(serialized)) return {status: "invalid", operationId, reason: "document_capacity"};
    if (creatingMain) this.insertWorkflow(next, serialized);
    else if (row?.revision === 0) this.replaceWorkflow(next, serialized, 0);
    else {
      const update = this.supervisors.store.db.prepare("UPDATE supervisor_workflow_state SET revision=?,document=?,updated_at=? WHERE workflow_id=? AND project_id=? AND main_thread_id=? AND revision=?")
        .run(next.revision, serialized, now, next.workflowId, owner.projectId, owner.mainThreadId, row!.revision);
      if (Number(update.changes) !== 1) return {status: "conflict", operationId, reason: "revision", currentRevision: this.workflowById(owner, next.workflowId)?.revision ?? null};
    }
    const receipt = this.receipt("applied", operationId, next);
    this.recordOperation(owner, "agreement", operationId, requestHash, receipt, now);
    return receipt;
  }

  private currentOwner(owner: WorkflowOwner): boolean {
    if (!this.supervisors.scopeCompatible || !validId(owner.projectId) || !validId(owner.mainThreadId) || !validId(owner.supervisorThreadId) ||
      !Number.isSafeInteger(owner.bindingGeneration) || owner.bindingGeneration < 1) return false;
    const binding = this.supervisors.binding(owner.projectId, owner.mainThreadId);
    return this.isEnabled(owner.projectId) && binding?.state === "ready" &&
      binding.threadId === owner.supervisorThreadId && binding.generation === owner.bindingGeneration;
  }

  private operationReplay(owner: WorkflowOwner, namespace: WorkflowOperationNamespace, operationId: string, requestHash: string): WorkflowMutationResult | null {
    const row = this.supervisors.store.db.prepare("SELECT request_hash,result FROM supervisor_workflow_operations WHERE project_id=? AND main_thread_id=? AND actor_thread_id=? AND binding_generation=? AND operation_namespace=? AND operation_id=?")
      .get(owner.projectId, owner.mainThreadId, owner.supervisorThreadId, owner.bindingGeneration, namespace, operationId) as StoredOperation | undefined;
    if (!row) return null;
    if (row.request_hash !== requestHash)
      return {status: "conflict", operationId, reason: "operation_id_reused", currentRevision: null};
    return JSON.parse(row.result) as WorkflowMutationReceipt;
  }

  private recordOperation(owner: WorkflowOwner, namespace: WorkflowOperationNamespace, operationId: string, requestHash: string, receipt: WorkflowMutationReceipt, now: number): void {
    this.supervisors.store.db.prepare("INSERT INTO supervisor_workflow_operations(project_id,main_thread_id,actor_thread_id,binding_generation,operation_namespace,operation_id,request_hash,result,workflow_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(owner.projectId, owner.mainThreadId, owner.supervisorThreadId, owner.bindingGeneration, namespace,
        operationId, requestHash, json(receipt), receipt.workflowId, now);
  }

  private receipt(status: "applied" | "created", operationId: string, document: WorkflowStateDocument): WorkflowMutationReceipt {
    return {status, operationId, workflowId: document.workflowId, revision: document.revision, stateHash: fingerprint(document)};
  }

  private emptyDocument(owner: WorkflowOwner, threadId: string, parentWorkflowId: string | null, parentThreadId: string | null,
    revision: number, now: number): WorkflowStateDocument {
    return {workflowId: randomUUID(), projectId: owner.projectId, mainThreadId: owner.mainThreadId, threadId,
      parentWorkflowId, parentThreadId, revision, status: "planned", objective: null, rules: [], steps: [], currentAgreementKey: null,
      acceptedAgreements: [], evidence: [], createdAt: now, updatedAt: now};
  }

  private makeEvidence(input: Omit<WorkflowStateEvidence, "id" | "recordedAt" | "actorSupervisorThreadId"> & {owner: WorkflowOwner; now: number}): WorkflowStateEvidence {
    const {owner, now, ...rest} = input;
    return {...rest, id: randomUUID(), recordedAt: now, actorSupervisorThreadId: owner.supervisorThreadId};
  }

  private insertWorkflow(document: WorkflowStateDocument, serialized: string): void {
    this.supervisors.store.db.prepare("INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(document.workflowId, document.projectId, document.mainThreadId, document.threadId, document.parentWorkflowId,
        document.parentThreadId, document.revision, serialized, document.createdAt, document.updatedAt);
  }

  private replaceWorkflow(document: WorkflowStateDocument, serialized: string, expectedRevision: number): void {
    const result = this.supervisors.store.db.prepare("UPDATE supervisor_workflow_state SET revision=?,document=?,updated_at=? WHERE workflow_id=? AND project_id=? AND main_thread_id=? AND revision=?")
      .run(document.revision, serialized, document.updatedAt, document.workflowId, document.projectId, document.mainThreadId, expectedRevision);
    if (Number(result.changes) !== 1) throw new Error("workflow_revision_conflict");
  }

  private workflowByThread(owner: WorkflowOwner, threadId: string): WorkflowRow | null {
    const row = this.supervisors.store.db.prepare("SELECT workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document FROM supervisor_workflow_state WHERE project_id=? AND main_thread_id=? AND thread_id=?")
      .get(owner.projectId, owner.mainThreadId, threadId);
    return row ? row as WorkflowRow : null;
  }

  private workflowById(owner: WorkflowOwner, workflowId: string): WorkflowRow | null {
    const row = this.supervisors.store.db.prepare("SELECT workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document FROM supervisor_workflow_state WHERE workflow_id=? AND project_id=? AND main_thread_id=?")
      .get(workflowId, owner.projectId, owner.mainThreadId);
    return row ? row as WorkflowRow : null;
  }

  private normalizeSteps(inputs: readonly WorkflowStateStepInput[], existing: readonly WorkflowStateStep[]): {steps: WorkflowStateStep[]} | null {
    const existingById = new Map(existing.map(step => [step.id, step]));
    const used = new Set<string>();
    const steps: WorkflowStateStep[] = [];
    for (const input of inputs) {
      if (input === null || typeof input !== "object" || !(input.blockId === null || validId(input.blockId)) ||
        !validText(input.name) || !validText(input.reason) || !isStatus(input.status) || !Array.isArray(input.contributorThreadIds) ||
        input.contributorThreadIds.length > workflowMutationLimits.maxContributorsPerStep ||
        !input.contributorThreadIds.every(id => validId(id)) || new Set(input.contributorThreadIds).size !== input.contributorThreadIds.length) return null;
      let id: string;
      if (input.id === undefined) {
        if (input.status !== "planned") return null;
        id = randomUUID();
      } else {
        if (!validId(input.id) || !existingById.has(input.id)) return null;
        id = input.id;
      }
      if (used.has(id)) return null;
      used.add(id);
      steps.push({id, blockId: input.blockId, name: input.name, reason: input.reason, status: input.status,
        contributorThreadIds: [...input.contributorThreadIds]});
    }
    return {steps};
  }

  private statusEvidenceValid(current: WorkflowStateDocument, input: WorkflowApplyInput, normalized: {steps: WorkflowStateStep[]}): boolean {
    const evidence = input.evidence ?? [];
    const stepsById = new Map(current.steps.map(step => [step.id, step]));
    for (const step of normalized.steps) {
      const previous = stepsById.get(step.id);
      if (!previous) continue;
      if (previous.status !== step.status && !evidence.some(item => item.kind === "status_changed" && item.targetStepId === step.id)) return false;
    }
    if (current.status !== input.status && !evidence.some(item => item.kind === "status_changed" && (item.targetStepId === null || item.targetStepId === undefined))) return false;
    const nextIds = new Set(normalized.steps.map(step => step.id));
    return evidence.every(item => item.targetStepId === null || item.targetStepId === undefined || nextIds.has(item.targetStepId));
  }

  private validAgreementImport(source: WorkflowAgreementImport): boolean {
    if (!validId(source.taskId) || !validId(source.sourceThreadId) || !validId(source.sourceRunId) || !validId(source.sourceMessageId) ||
      !validText(source.sourceHash) || !validText(source.objective) || source.agreement?.status !== "agreed" ||
      !validId(source.agreement.proposalId) || !validText(source.agreement.supervisorMessageId) || !validText(source.agreement.agentMessageId) ||
      !Number.isFinite(source.agreement.agreedAt) || !validText(source.agreement.workflow.workspaceRoot ?? "") ||
      !validText(source.agreement.workflow.revision ?? "") || !validRules(source.agreement.workflow.rules) ||
      !Array.isArray(source.agreement.workflow.steps) || source.agreement.workflow.steps.length > workflowMutationLimits.maxSteps) return false;
    return source.agreement.workflow.steps.every(step => step !== null && typeof step === "object" &&
      (step.blockId === null || validId(step.blockId)) && validText(step.name) && validText(step.reason));
  }

  private acceptedPlan(source: WorkflowAgreementImport): {rules: WorkflowStateRule[]; steps: WorkflowStateStep[]} {
    return {rules: source.agreement.workflow.rules.map(rule => ({index: rule.index, name: rule.name, applies: rule.applies, reason: rule.reason})),
      steps: source.agreement.workflow.steps.map(step => ({id: randomUUID(), blockId: step.blockId, name: step.name,
        reason: step.reason, status: "planned", contributorThreadIds: []}))};
  }

  private acceptedPlanHash(source: WorkflowAgreementImport): string {
    return fingerprint({workspaceRoot: source.agreement.workflow.workspaceRoot, revision: source.agreement.workflow.revision,
      workflow: {rules: source.agreement.workflow.rules, steps: source.agreement.workflow.steps}});
  }
}
