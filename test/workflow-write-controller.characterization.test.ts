import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, vi } from "vitest";
import { fingerprint, GuidanceStore } from "../src/guidance-store.js";
import { defaultSupervisorModel, ProjectSupervisorStore, type BindingRecord, type TaskRecord } from "../src/project-supervisor-store.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import type { WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo, WorkflowSourceBindingInfo } from "../src/project-supervisor-contract.js";
import { proposalContextFromDefinitions, validateWorkflowPlan } from "../src/supervisor-workflow.js";
import type { Projection, RunInfo, ThreadInfo } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import {
  supervisionStartToolDefinition,
  supervisionStopToolDefinition,
  WorkflowWriteController,
  workflowReadToolDefinition,
  workflowWriteToolDefinition,
  type WorkflowApplyPatch,
  type WorkflowNativeAccess,
} from "../src/workflow-write-controller.js";
import {
  verifyWorkflowToolEvidence,
  workflowToolInputMaxBytes,
  workflowToolNames,
  type WorkflowEvidenceCheck,
  type WorkflowEvidenceTool,
} from "../src/workflow-write-evidence.js";
import { effectiveIndex, projectIndex } from "./project-definitions-fixture.js";
import { after } from "./support/node-test.js";

// fixture helpers copied from test/workflow-write-controller.test.ts (real temp-file guidance sqlite, fake native reads)
type Fixture = {
  directory: string;
  guidance: GuidanceStore;
  supervisors: ProjectSupervisorStore;
  workflows: WorkflowStateStore;
  controller: WorkflowWriteController;
  binding: BindingRecord;
  projectId: string;
  mainThreadId: string;
  supervisorThreadId: string;
  threads: ThreadInfo[];
  projections: Map<string, Projection>;
  details: Map<string, unknown>;
  calls: {projection: string[]; detail: string[]; listThreads: number};
  native: WorkflowNativeAccess;
  proposal: WorkflowProposalInfo;
  sourceBinding: WorkflowSourceBindingInfo;
};

const thread = (id: string, projectId: string): ThreadInfo => ({id, title: id, projectId, archivedAt: null, deletedAt: null,
  lineage: {parentThreadId: null, relationshipToParent: null}});

const localStep = (name: string, description: string) => ({
  kind: "step" as const,
  definitionId: null,
  localId: name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 180),
  templatePath: null,
  name,
  description,
  source: null,
  resolution: "resolved" as const,
  reason: description,
  status: "planned" as const,
  contributorThreadIds: [] as string[],
});

const sequencePlan = (nodes: readonly unknown[]): WorkflowPlanGroupInfo => ({kind: "sequence", templatePath: null, nodes: [...nodes] as WorkflowPlanNodeInfo[]});

const makeFixture = async (): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-write-controller-characterization-"));
  const guidance = new GuidanceStore(directory);
  const supervisors = new ProjectSupervisorStore(guidance, new Set());
  const projectId = "project-workflows";
  const mainThreadId = "main-workflows";
  for (const scope of [null, projectId]) guidance.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`supervisor_control:${JSON.stringify(scope)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const binding = {...supervisors.reserve(projectId, mainThreadId, "Main thread", defaultSupervisorModel, 1, 1), state: "ready" as const};
  supervisors.setBinding(binding);
  const workflows = new WorkflowStateStore(supervisors, id => supervisors.enabled(id));
  const supervisorThreadId = binding.threadId;
  const definitionSnapshot: ProjectDefinitionSnapshot = {
    projectId, threadId: mainThreadId, workspaceRoot: "/workspace/project-workflows", globalOnly: false, globalRevision: null,
    revision: "definition-revision-1", editingAvailable: true, status: "ready", steps: [], workflows: [],
    config: effectiveIndex({steps: [], workflows: []}), projectConfig: projectIndex(), definitionFiles: [], complete: true, sources: [], issues: [],
  };
  const definitionContext = proposalContextFromDefinitions(definitionSnapshot);
  const normalized = validateWorkflowPlan({requirements: [], plan: sequencePlan([localStep("Baseline review", "Review the current task context.")])}, definitionContext);
  if (!normalized?.plan) throw new Error("test_workflow_proposal_invalid");
  const proposal: WorkflowProposalInfo = {
    status: "proposed", message: "A source-bound workflow proposal for this task.", workspaceRoot: definitionSnapshot.workspaceRoot,
    revision: definitionSnapshot.revision, globalRevision: null, definitionsStatus: "ready", definitionsComplete: true, requirementsKnown: true,
    requirements: normalized.requirements, issues: normalized.issues, plan: normalized.plan,
  };
  const sourceHash = fingerprint("Complete the current project task.");
  const task: TaskRecord = {
    id: "task-current", threadId: mainThreadId, projectId, sourceRunId: "source-run-current", sourceMessageId: "source-message-current",
    status: "inferred", objective: "Complete the current project task.", reason: "The latest user message describes an actionable task.",
    updatedAt: Date.now(), workflow: proposal, agreement: null, workflowProposalId: "proposal-current", sourceHash,
    requestText: "Complete the current project task.", supervisorThreadId, messageId: "source-message-current", dispatchedAt: null,
    replayCount: 0, supervisorRunId: "source-run-current", sourceOrdinal: 1, definitionContext, definitionSnapshot,
  };
  supervisors.saveTask(task);
  const sourceBinding: WorkflowSourceBindingInfo = {
    workspaceRoot: definitionSnapshot.workspaceRoot, revision: definitionSnapshot.revision, globalRevision: null, definitionsStatus: "ready",
    definitionsComplete: true, requirementsKnown: true, taskId: task.id, proposalId: "proposal-current", sourceHash,
  };
  const threads = [thread(mainThreadId, projectId), thread(supervisorThreadId, projectId)];
  const projections = new Map<string, Projection>([[supervisorThreadId, {thread: thread(supervisorThreadId, projectId), runs: [], messages: [], nodes: [], turnItems: []}]]);
  const details = new Map<string, unknown>();
  const calls: Fixture["calls"] = {projection: [], detail: [], listThreads: 0};
  const native: WorkflowNativeAccess = {
    listThreads: async () => {calls.listThreads++; return threads;},
    projection: async id => {
      calls.projection.push(id);
      const current = projections.get(id);
      if (!current) throw new Error("unexpected_projection");
      return current;
    },
    getTurnItem: async ({itemId}) => {calls.detail.push(itemId); return {item: details.get(itemId) ?? null};},
  };
  const controller = new WorkflowWriteController({supervisors, workflows, native, loadDefinitions: async () => definitionSnapshot,
    isEnabled: id => supervisors.enabled(id), maxEvidenceWaitMs: 0});
  return {directory, guidance, supervisors, workflows, controller, binding, projectId, mainThreadId, supervisorThreadId, threads,
    projections, details, calls, native, proposal, sourceBinding};
};

const closeFixture = async (fixture: Fixture): Promise<void> => {
  if (fixture.guidance.db.isOpen) fixture.guidance.close();
  await rm(fixture.directory, {recursive: true, force: true});
};

const ensureArgs = (fixture: Fixture, operationId: string, note: string) => ({
  action: "ensure_main", supervisorThreadId: fixture.supervisorThreadId, bindingGeneration: fixture.binding.generation, operationId, note,
});

const applyArgs = (fixture: Fixture, input: WorkflowApplyPatch) => ({
  action: "apply", supervisorThreadId: fixture.supervisorThreadId, bindingGeneration: fixture.binding.generation,
  input: {sourceBinding: fixture.sourceBinding, requirements: fixture.proposal.requirements, issues: fixture.proposal.issues, ...input},
});

const nativeRunId = "supervisor-run-current";
const nativeProviderThreadId = "provider-thread-current";
const nativeRootNodeId = "supervisor-root";

type EvidenceRecord = {itemId: string; detail: Record<string, unknown>; node: Record<string, unknown>; turnItem: Record<string, unknown>};

// one exact strong own-main tool item as the baseline suite's installEvidence builds it
const evidenceRecord = (fixture: Fixture, args: Record<string, unknown>, itemId: string, ordinal: number): EvidenceRecord => {
  const nodeId = `node-${itemId}`;
  const toolName = workflowToolNames.write.direct[0];
  const identity = {threadId: fixture.supervisorThreadId, runId: nativeRunId, providerThreadId: nativeProviderThreadId};
  return {
    itemId,
    detail: {id: itemId, type: "dynamic_tool", ...identity, nodeId, providerTurnId: "provider-turn-current",
      nativeItemRef: {driver: "codex", nativeId: `native-${itemId}`, strength: "strong"}, parentItemId: null, ordinal,
      status: "completed", toolNonExecutionKind: null, toolName, input: args},
    node: {id: nodeId, kind: "dynamic_tool", ...identity, rootNodeId: nativeRootNodeId, parentNodeId: nativeRootNodeId, status: "completed"},
    turnItem: {id: itemId, type: "dynamic_tool", ...identity, nodeId, parentItemId: null, ordinal, status: "completed", toolName, input: "snapshot-summary"},
  };
};

const evidenceView = (fixture: Fixture, records: readonly EvidenceRecord[]): Projection => ({
  thread: thread(fixture.supervisorThreadId, fixture.projectId),
  runs: [{id: nativeRunId, ordinal: 1, status: "completed", requestedAt: "2026-10-14T00:00:00.000Z", startedAt: "2026-10-14T00:00:00.000Z",
    completedAt: "2026-10-14T00:00:01.000Z", rootNodeId: nativeRootNodeId, threadId: fixture.supervisorThreadId, providerThreadId: nativeProviderThreadId}],
  messages: [],
  nodes: [{id: nativeRootNodeId, kind: "root_turn", threadId: fixture.supervisorThreadId, runId: nativeRunId, rootNodeId: nativeRootNodeId,
    providerThreadId: nativeProviderThreadId, parentNodeId: null, status: "completed"}, ...records.map(record => record.node)],
  turnItems: records.map(record => record.turnItem),
});

const installEvidence = (fixture: Fixture, args: Record<string, unknown>, itemId: string): string => {
  const record = evidenceRecord(fixture, args, itemId, 100 + fixture.details.size);
  fixture.details.set(itemId, record.detail);
  fixture.projections.set(fixture.supervisorThreadId, evidenceView(fixture, [record]));
  return itemId;
};

const rowCount = (fixture: Fixture, table: string, operationId?: string): number => Number((operationId === undefined
  ? fixture.guidance.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()
  : fixture.guidance.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE operation_id=?`).get(operationId))?.n);

const assertNothingStored = (fixture: Fixture, label: string): void => {
  assert.equal(rowCount(fixture, "supervisor_workflow_write_receipts"), 0, label);
  assert.equal(rowCount(fixture, "supervisor_workflow_write_evidence"), 0, label);
  assert.equal(rowCount(fixture, "supervisor_workflow_operations"), 0, label);
  assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null, label);
};

const storedDocument = (fixture: Fixture): string => JSON.stringify(Object.values(fixture.guidance.db.prepare(
  "SELECT workflow_id,revision,document,updated_at FROM supervisor_workflow_state WHERE project_id=? AND main_thread_id=?",
).get(fixture.projectId, fixture.mainThreadId) ?? {}));

const evidenceRows = (fixture: Fixture): string[][] => fixture.guidance.db.prepare(
  "SELECT item_id,operation_id,successful,result FROM supervisor_workflow_write_evidence ORDER BY item_id",
).all().map(row => [String(row.item_id), String(row.operation_id), String(row.successful), String(row.result)]);

it("CT-WWC-01: an abort during evidence polling or after listThreads returns the interrupted pending reason and stores nothing", {timeout: 10_000}, async t => {
  // abort while the controller waits between evidence polls and nothing matching is visible yet
  {
    const fixture = await makeFixture();
    after(t, () => closeFixture(fixture));
    const abort = new AbortController();
    const native: WorkflowNativeAccess = {...fixture.native, projection: async (threadId, signal) => {
      const projection = await fixture.native.projection(threadId, signal);
      setImmediate(() => abort.abort());
      return projection;
    }};
    const controller = new WorkflowWriteController({...fixture.controller.options, native, maxEvidenceWaitMs: 5_000});
    const args = ensureArgs(fixture, "interrupted-poll", "Create the main workflow after an interrupted poll.");
    assert.deepEqual(await controller.write(args, abort.signal),
      {status: "pending", operationId: "interrupted-poll", reason: "native_evidence_wait_interrupted", retryable: true});
    assert.deepEqual(fixture.calls.projection, [fixture.supervisorThreadId], "the abort ends the poll wait before another projection read");
    assert.equal(fixture.calls.listThreads, 0);
    assertNothingStored(fixture, "poll");
    installEvidence(fixture, args, "interrupted-poll-item");
    assert.equal((await fixture.controller.write(args)).status, "created", "the interrupted request reserved nothing");
  }
  // abort during the native detail read that verifies the evidence; the controller checks the signal after verification
  {
    const fixture = await makeFixture();
    after(t, () => closeFixture(fixture));
    const abort = new AbortController();
    const native: WorkflowNativeAccess = {...fixture.native, getTurnItem: async (input, signal) => {
      abort.abort();
      return fixture.native.getTurnItem(input, signal);
    }};
    const controller = new WorkflowWriteController({...fixture.controller.options, native});
    const args = ensureArgs(fixture, "interrupted-detail", "Create the main workflow after an interrupted detail read.");
    installEvidence(fixture, args, "interrupted-detail-item");
    assert.deepEqual(await controller.write(args, abort.signal),
      {status: "pending", operationId: "interrupted-detail", reason: "native_evidence_wait_interrupted", retryable: true});
    assert.deepEqual(fixture.calls.detail, ["interrupted-detail-item"]);
    assert.equal(fixture.calls.listThreads, 0);
    assertNothingStored(fixture, "detail");
    assert.equal((await fixture.controller.write(args)).status, "created");
  }
  // abort while listThreads is awaited after verified evidence; the lineage read itself succeeds
  {
    const fixture = await makeFixture();
    after(t, () => closeFixture(fixture));
    const abort = new AbortController();
    const native: WorkflowNativeAccess = {...fixture.native, listThreads: async signal => {
      abort.abort();
      return fixture.native.listThreads(signal);
    }};
    const controller = new WorkflowWriteController({...fixture.controller.options, native});
    const args = ensureArgs(fixture, "interrupted-lineage", "Create the main workflow after an interrupted lineage read.");
    installEvidence(fixture, args, "interrupted-lineage-item");
    assert.deepEqual(await controller.write(args, abort.signal),
      {status: "pending", operationId: "interrupted-lineage", reason: "native_lineage_interrupted", retryable: true});
    assert.deepEqual(fixture.calls.detail, ["interrupted-lineage-item"]);
    assert.equal(fixture.calls.listThreads, 1);
    assertNothingStored(fixture, "lineage");
    assert.equal((await fixture.controller.write(args)).status, "created");
  }
});

it("CT-WWC-02: concurrent identical writes proven by two distinct native items mutate once and share one receipt; a reused item is denied", {timeout: 10_000}, async t => {
  const fixture = await makeFixture();
  after(t, () => closeFixture(fixture));
  const args = ensureArgs(fixture, "concurrent-op", "Create the main workflow once.");
  const first = evidenceRecord(fixture, args, "concurrent-item-1", 101);
  const second = evidenceRecord(fixture, args, "concurrent-item-2", 102);
  fixture.details.set(first.itemId, first.detail);
  fixture.details.set(second.itemId, second.detail);
  const views = [evidenceView(fixture, [first]), evidenceView(fixture, [second])];
  let arrivals = 0;
  let bothArrived = (): void => undefined;
  const barrier = new Promise<void>(resolve => {bothArrived = resolve;});
  const native: WorkflowNativeAccess = {...fixture.native, projection: async (threadId, signal) => {
    const view = views[arrivals++];
    if (arrivals === 2) bothArrived();
    // both writes have passed their initial receipt check before either one verifies its own native item
    await barrier;
    return view ?? fixture.native.projection(threadId, signal);
  }};
  const controller = new WorkflowWriteController({...fixture.controller.options, native});
  const [left, right] = await Promise.all([controller.write(args), controller.write(args)]);
  assert.equal(left.status, "created", JSON.stringify(left));
  assert.deepEqual(right, left);
  assert.equal(JSON.stringify(right), JSON.stringify(left));
  assert.deepEqual(fixture.calls.detail.toSorted(), [first.itemId, second.itemId]);
  const document = fixture.workflows.get(fixture.projectId, fixture.mainThreadId);
  assert.equal(document?.revision, 1);
  assert.equal(document?.evidence.length, 1, "one mutation");
  assert.equal(rowCount(fixture, "supervisor_workflow_write_receipts", "concurrent-op"), 1);
  assert.equal(rowCount(fixture, "supervisor_workflow_operations", "concurrent-op"), 1);
  assert.deepEqual(evidenceRows(fixture), [
    [first.itemId, "concurrent-op", "1", JSON.stringify(left)],
    [second.itemId, "concurrent-op", "1", JSON.stringify(left)],
  ]);

  const documentBefore = storedDocument(fixture);
  const reuseArgs = ensureArgs(fixture, "reused-item-op", "A different request presented with an already used native item.");
  fixture.details.set(first.itemId, {...first.detail, input: reuseArgs});
  fixture.projections.set(fixture.supervisorThreadId, evidenceView(fixture, [first]));
  assert.deepEqual(await fixture.controller.write(reuseArgs), {status: "denied", operationId: "reused-item-op", reason: "native_evidence_reused"});
  assert.equal(rowCount(fixture, "supervisor_workflow_write_receipts", "reused-item-op"), 0);
  assert.equal(rowCount(fixture, "supervisor_workflow_write_evidence", "reused-item-op"), 0);
  assert.equal(rowCount(fixture, "supervisor_workflow_write_evidence"), 2);
  assert.equal(storedDocument(fixture), documentBefore);
});

it("CT-WWC-04: a throw from applyInTransaction after its writes yields workflow_write_transaction_failed with no receipt, evidence or document change", {timeout: 10_000}, async t => {
  const fixture = await makeFixture();
  after(t, () => closeFixture(fixture));
  const ensure = ensureArgs(fixture, "rollback-create", "Create a draft before the failing apply.");
  installEvidence(fixture, ensure, "rollback-create-item");
  const created = await fixture.controller.write(ensure);
  assert.equal(created.status, "created");
  if (created.status !== "created") return;
  const args = applyArgs(fixture, {operationId: "rollback-apply", workflowId: created.workflowId, expectedRevision: created.revision,
    status: "planned", plan: sequencePlan([localStep("Inspect exporter", "Find the current path.")]), note: "Add a step that never commits."});
  installEvidence(fixture, args, "rollback-apply-item");
  const documentBefore = storedDocument(fixture);
  const original = fixture.workflows.applyInTransaction.bind(fixture.workflows);
  const partial: Array<{status: string; revision: number | undefined; operations: number}> = [];
  const spy = vi.spyOn(fixture.workflows, "applyInTransaction").mockImplementation((...parameters) => {
    const result = original(...parameters);
    partial.push({status: result.status, revision: fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision,
      operations: rowCount(fixture, "supervisor_workflow_operations", "rollback-apply")});
    throw new Error("injected_failure_after_partial_apply");
  });
  after(t, () => spy.mockRestore());
  assert.deepEqual(await fixture.controller.write(args), {status: "denied", operationId: "rollback-apply", reason: "workflow_write_transaction_failed"});
  assert.deepEqual(partial, [{status: "applied", revision: 2, operations: 1}], "the document and its operation were written inside the transaction");
  assert.equal(fixture.guidance.db.isTransaction, false);
  assert.equal(storedDocument(fixture), documentBefore);
  assert.equal(rowCount(fixture, "supervisor_workflow_operations", "rollback-apply"), 0);
  assert.equal(rowCount(fixture, "supervisor_workflow_write_receipts", "rollback-apply"), 0);
  assert.equal(rowCount(fixture, "supervisor_workflow_write_evidence", "rollback-apply"), 0);
  assert.equal(rowCount(fixture, "supervisor_workflow_write_receipts"), 1);
  assert.equal(rowCount(fixture, "supervisor_workflow_write_evidence"), 1);
});

it("CT-WWC-05: successful receipts replay byte-identically through a new controller after the guidance store reopens", {timeout: 10_000}, async t => {
  const fixture = await makeFixture();
  let reopened: GuidanceStore | null = null;
  after(t, async () => {
    if (reopened?.db.isOpen) reopened.close();
    await closeFixture(fixture);
  });
  const ensure = ensureArgs(fixture, "reopen-create", "Create a draft before restart.");
  installEvidence(fixture, ensure, "reopen-create-item");
  const created = await fixture.controller.write(ensure);
  assert.equal(created.status, "created");
  if (created.status !== "created") return;
  const args = applyArgs(fixture, {operationId: "reopen-apply", workflowId: created.workflowId, expectedRevision: created.revision,
    plan: sequencePlan([localStep("Review source", "Keep this committed edit durable.")]), note: "Apply this edit before restart."});
  installEvidence(fixture, args, "reopen-apply-item");
  const applied = await fixture.controller.write(args);
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  const receipts = (guidance: GuidanceStore): string => JSON.stringify(guidance.db.prepare(
    "SELECT operation_id,operation_namespace,request_hash,project_id,main_thread_id,supervisor_thread_id,binding_generation,result,created_at FROM supervisor_workflow_write_receipts ORDER BY operation_id",
  ).all().map(row => Object.values(row)));
  const receiptsBefore = receipts(fixture.guidance);
  const documentBefore = storedDocument(fixture);
  fixture.guidance.close();

  const guidance = new GuidanceStore(fixture.directory);
  reopened = guidance;
  const supervisors = new ProjectSupervisorStore(guidance, new Set());
  const workflows = new WorkflowStateStore(supervisors, id => supervisors.enabled(id));
  const nativeCalls: string[] = [];
  const native: WorkflowNativeAccess = {
    listThreads: async () => {nativeCalls.push("listThreads"); throw new Error("no_native_read_expected");},
    projection: async id => {nativeCalls.push(`projection:${id}`); throw new Error("no_native_read_expected");},
    getTurnItem: async ({itemId}) => {nativeCalls.push(`detail:${itemId}`); throw new Error("no_native_read_expected");},
  };
  const controller = new WorkflowWriteController({supervisors, workflows, native, isEnabled: id => supervisors.enabled(id), maxEvidenceWaitMs: 0,
    loadDefinitions: async () => {nativeCalls.push("loadDefinitions"); throw new Error("no_definition_read_expected");}});
  const createReplay = await controller.write(ensure);
  const applyReplay = await controller.write(args);
  assert.equal(JSON.stringify(createReplay), JSON.stringify(created));
  assert.equal(JSON.stringify(applyReplay), JSON.stringify(applied));
  assert.deepEqual(createReplay, created);
  assert.deepEqual(applyReplay, applied);
  assert.deepEqual(nativeCalls, [], "a receipt replay reads no native evidence or definitions");
  assert.equal(receipts(guidance), receiptsBefore);
  fixture.guidance = guidance;
  assert.equal(storedDocument(fixture), documentBefore);
  assert.equal(rowCount(fixture, "supervisor_workflow_write_evidence"), 2);
});

it("CT-WWC-06: the four model-visible tool definitions serialize to the recorded golden JSON", {timeout: 10_000}, () => {
  const golden = readFileSync(new URL("./support/c2-wwc-tool-definitions.golden.json", import.meta.url), "utf8");
  const actual = `${JSON.stringify({workflowReadToolDefinition, workflowWriteToolDefinition, supervisionStartToolDefinition, supervisionStopToolDefinition}, null, 2)}\n`;
  assert.equal(actual, golden);
});

it("CT-WWC-08: a binding generation bump during an awaited native read after verification denies owner_changed and stores nothing", {timeout: 10_000}, async t => {
  for (const read of ["detail", "lineage"] as const) {
    const fixture = await makeFixture();
    after(t, () => closeFixture(fixture));
    const operationId = `generation-${read}`;
    const args = ensureArgs(fixture, operationId, "Create the main workflow under the original binding.");
    const itemId = installEvidence(fixture, args, `${operationId}-item`);
    const bump = (): void => fixture.supervisors.setBinding({...fixture.binding, generation: fixture.binding.generation + 1});
    const native: WorkflowNativeAccess = read === "detail"
      ? {...fixture.native, getTurnItem: async (input, signal) => {bump(); return fixture.native.getTurnItem(input, signal);}}
      : {...fixture.native, listThreads: async signal => {bump(); return fixture.native.listThreads(signal);}};
    const controller = new WorkflowWriteController({...fixture.controller.options, native});
    assert.deepEqual(await controller.write(args), {status: "denied", operationId, reason: "owner_changed"}, read);
    assert.deepEqual(fixture.calls.detail, [itemId], read);
    assert.equal(fixture.calls.listThreads, 1, read);
    assert.equal(fixture.supervisors.binding(fixture.projectId, fixture.mainThreadId)?.generation, fixture.binding.generation + 1, read);
    assertNothingStored(fixture, read);
  }
});

// a standalone exact strong own-main tool item for the pure verifier
const evidenceThreadId = "supervisor-evidence-thread";
const evidenceArgs = {action: "ensure_main", bindingGeneration: 1, note: "Create the main workflow.", operationId: "evidence-op", supervisorThreadId: evidenceThreadId};
const evidenceArgsCanonical = JSON.stringify(evidenceArgs);
const evidenceInputHash = createHash("sha256").update(evidenceArgsCanonical).digest("hex");

type EvidenceState = {
  detail: unknown;
  item: Record<string, unknown>;
  thread: ThreadInfo;
  run: RunInfo;
  root: Record<string, unknown>;
  node: Record<string, unknown>;
  extraNodes: Array<Record<string, unknown>>;
};

const evidenceState = (): EvidenceState => {
  const identity = {threadId: evidenceThreadId, runId: "evidence-run", providerThreadId: "evidence-provider-thread"};
  const item: Record<string, unknown> = {id: "evidence-item", type: "dynamic_tool", ...identity, nodeId: "evidence-node",
    nativeItemRef: {driver: "codex", nativeId: "native-evidence-item", strength: "strong"}, parentItemId: null, ordinal: 7,
    status: "completed", toolNonExecutionKind: null, toolName: workflowToolNames.write.direct[0], input: {...evidenceArgs}};
  return {
    detail: item,
    item,
    thread: thread(evidenceThreadId, "evidence-project"),
    run: {id: "evidence-run", ordinal: 1, status: "completed", requestedAt: "2026-10-14T00:00:00.000Z", startedAt: "2026-10-14T00:00:00.000Z",
      completedAt: "2026-10-14T00:00:01.000Z", rootNodeId: "evidence-root", threadId: evidenceThreadId, providerThreadId: "evidence-provider-thread"},
    root: {id: "evidence-root", kind: "root_turn", ...identity, rootNodeId: "evidence-root", parentNodeId: null, status: "completed"},
    node: {id: "evidence-node", kind: "dynamic_tool", ...identity, rootNodeId: "evidence-root", parentNodeId: "evidence-root", status: "completed"},
    extraNodes: [],
  };
};

const nativeRef = (state: EvidenceState): Record<string, unknown> => state.item.nativeItemRef as Record<string, unknown>;

const verified = (toolName: string, status: "running" | "completed", nativeInputCanonical: string): WorkflowEvidenceCheck => ({
  status: "verified",
  evidence: {itemId: "evidence-item", runId: "evidence-run", toolName, inputHash: evidenceInputHash, nativeInputCanonical,
    providerThreadId: "evidence-provider-thread", ordinal: 7, status, nativeItemRef: {driver: "codex", nativeId: "native-evidence-item", strength: "strong"}},
});
const pending = (reason: string): WorkflowEvidenceCheck => ({status: "pending", reason});
const denied = (reason: string, observedToolName?: string): WorkflowEvidenceCheck =>
  ({status: "denied", reason, ...(observedToolName === undefined ? {} : {observedToolName})});

const mcpxInput = (name: string, extra: Record<string, unknown> = {}) => ({name, arguments: {...evidenceArgs}, ...extra});
const longToolName = `custom.${"y".repeat(200)}`;

const evidenceCases: ReadonlyArray<{name: string; tool?: WorkflowEvidenceTool; edit: (state: EvidenceState) => void; expected: WorkflowEvidenceCheck}> = [
  {name: "direct write name, completed", edit: () => undefined, expected: verified(workflowToolNames.write.direct[0], "completed", evidenceArgsCanonical)},
  {name: "second direct write name, running", edit: state => {state.item.toolName = workflowToolNames.write.direct[1]; state.item.status = "running";},
    expected: verified(workflowToolNames.write.direct[1], "running", evidenceArgsCanonical)},
  {name: "mcpx call to the write target", edit: state => {state.item.toolName = workflowToolNames.mcpxCall[0]; state.item.input = mcpxInput(workflowToolNames.write.mcpxTarget);},
    expected: verified(workflowToolNames.mcpxCall[0], "completed", `{"arguments":${evidenceArgsCanonical},"name":"${workflowToolNames.write.mcpxTarget}"}`)},
  {name: "missing detail", edit: state => {state.detail = null;}, expected: pending("native_item_unavailable")},
  {name: "array detail", edit: state => {state.detail = [];}, expected: pending("native_item_unavailable")},
  {name: "summary string input", edit: state => {state.item.input = "workflow_write summary";}, expected: pending("native_input_incomplete")},
  {name: "missing run id", edit: state => {delete state.item.runId;}, expected: pending("native_input_incomplete")},
  {name: "missing tool name", edit: state => {delete state.item.toolName;}, expected: pending("native_input_incomplete")},
  {name: "another known direct tool", edit: state => {state.item.toolName = workflowToolNames.read.direct[0];}, expected: pending("native_tool_name_or_wrapper_mismatch")},
  {name: "write name verified as read", tool: "read", edit: () => undefined, expected: pending("native_tool_name_or_wrapper_mismatch")},
  {name: "mcpx wrapper with an extra key", edit: state => {state.item.toolName = workflowToolNames.mcpxCall[1]; state.item.input = mcpxInput(workflowToolNames.write.mcpxTarget, {extra: true});},
    expected: pending("native_tool_name_or_wrapper_mismatch")},
  {name: "mcpx call to another known target", edit: state => {state.item.toolName = workflowToolNames.mcpxCall[0]; state.item.input = mcpxInput(workflowToolNames.read.mcpxTarget);},
    expected: pending("native_tool_name_or_wrapper_mismatch")},
  {name: "non-json number in the input", edit: state => {state.item.input = {...evidenceArgs, note: Number.NaN};}, expected: pending("native_input_not_json")},
  {name: "input above the inline bound", edit: state => {state.item.input = {...evidenceArgs, note: "x".repeat(workflowToolInputMaxBytes)};}, expected: pending("native_input_too_large")},
  {name: "empty input", edit: state => {state.item.input = {};}, expected: pending("native_input_empty")},
  {name: "different arguments", edit: state => {state.item.input = {...evidenceArgs, note: "Another request."};}, expected: pending("native_input_does_not_match_request")},
  {name: "other item id", edit: state => {state.item.id = "other-item";}, expected: denied("native_item_identity_mismatch")},
  {name: "non dynamic_tool item", edit: state => {state.item.type = "tool_call";}, expected: denied("native_item_identity_mismatch")},
  {name: "item of another thread", edit: state => {state.item.threadId = "other-thread";}, expected: denied("native_item_identity_mismatch")},
  {name: "item without node id", edit: state => {delete state.item.nodeId;}, expected: denied("native_item_identity_mismatch")},
  {name: "projection of another thread", edit: state => {state.thread = thread("other-thread", "evidence-project");}, expected: denied("supervisor_projection_mismatch")},
  {name: "nested item", edit: state => {state.item.parentItemId = "parent-item";}, expected: denied("native_item_not_main_strong")},
  {name: "item without parentItemId", edit: state => {delete state.item.parentItemId;}, expected: denied("native_item_not_main_strong")},
  {name: "weak native reference", edit: state => {nativeRef(state).strength = "weak";}, expected: denied("native_item_not_main_strong")},
  {name: "missing native reference", edit: state => {delete state.item.nativeItemRef;}, expected: denied("native_item_not_main_strong")},
  {name: "empty driver", edit: state => {nativeRef(state).driver = "";}, expected: denied("native_item_identity_incomplete")},
  {name: "untrimmed driver", edit: state => {nativeRef(state).driver = " codex";}, expected: denied("native_item_identity_incomplete")},
  {name: "driver above 128 characters", edit: state => {nativeRef(state).driver = "d".repeat(129);}, expected: denied("native_item_identity_incomplete")},
  {name: "empty native id", edit: state => {nativeRef(state).nativeId = "";}, expected: denied("native_item_identity_incomplete")},
  {name: "negative ordinal", edit: state => {state.item.ordinal = -1;}, expected: denied("native_item_identity_incomplete")},
  {name: "fractional ordinal", edit: state => {state.item.ordinal = 1.5;}, expected: denied("native_item_identity_incomplete")},
  {name: "missing ordinal", edit: state => {delete state.item.ordinal;}, expected: denied("native_item_identity_incomplete")},
  {name: "non-executed tool item", edit: state => {state.item.toolNonExecutionKind = "denied";}, expected: denied("native_item_not_executed")},
  {name: "rolled-back tool item", edit: state => {state.item.status = "rolled_back";}, expected: denied("native_tool_item_rolled_back")},
  {name: "failed tool item", edit: state => {state.item.status = "failed";}, expected: denied("native_item_not_running_or_completed")},
  {name: "tool item without status", edit: state => {delete state.item.status;}, expected: denied("native_item_not_running_or_completed")},
  {name: "unknown run", edit: state => {state.item.runId = "unknown-run";}, expected: denied("native_run_identity_mismatch")},
  {name: "run of another thread", edit: state => {state.run.threadId = "other-thread";}, expected: denied("native_run_identity_mismatch")},
  {name: "run without provider thread", edit: state => {delete state.run.providerThreadId;}, expected: denied("native_run_identity_mismatch")},
  {name: "item of another provider thread", edit: state => {state.item.providerThreadId = "other-provider-thread";}, expected: denied("native_run_identity_mismatch")},
  {name: "rolled-back run", edit: state => {state.run.status = "rolled_back";}, expected: denied("native_run_rolled_back")},
  {name: "rolled-back root node", edit: state => {state.root.status = "rolled_back";}, expected: denied("native_root_node_rolled_back")},
  {name: "node absent from the projection", edit: state => {state.item.nodeId = "missing-node";}, expected: denied("native_item_outside_main_run")},
  {name: "node below a subagent", edit: state => {
    state.extraNodes.push({id: "subagent-node", kind: "subagent", threadId: evidenceThreadId, runId: "evidence-run", rootNodeId: "evidence-root",
      providerThreadId: "evidence-provider-thread", parentNodeId: "evidence-root", status: "completed"});
    state.node.parentNodeId = "subagent-node";
  }, expected: denied("native_item_outside_main_run")},
  {name: "node of another run", edit: state => {state.node.runId = "other-run";}, expected: denied("native_item_outside_main_run")},
  {name: "rolled-back tool node", edit: state => {state.node.status = "rolled_back";}, expected: denied("native_tool_node_rolled_back")},
  {name: "unknown direct tool name", edit: state => {state.item.toolName = "custom-gateway.workflow_write";},
    expected: denied("native_tool_name_unrecognized", "custom-gateway.workflow_write")},
  {name: "unknown tool name above 128 characters", edit: state => {state.item.toolName = longToolName;},
    expected: denied("native_tool_name_unrecognized", `${longToolName.slice(0, 125)}...`)},
  {name: "mcpx call to an unknown target", edit: state => {state.item.toolName = workflowToolNames.mcpxCall[0]; state.item.input = mcpxInput("other-gateway__workflow_write");},
    expected: denied("native_tool_name_unrecognized", "other-gateway__workflow_write")},
  {name: "unknown tool wrapping the write target", edit: state => {state.item.toolName = "other-gateway.call_tool"; state.item.input = mcpxInput(workflowToolNames.write.mcpxTarget);},
    expected: denied("native_tool_name_unrecognized", "other-gateway.call_tool")},
];

it("CT-WWE-01: verifyWorkflowToolEvidence returns each denial and pending reason for its exact native condition", {timeout: 10_000}, () => {
  for (const testCase of evidenceCases) {
    const state = evidenceState();
    testCase.edit(state);
    const projection: Projection = {thread: state.thread, runs: [state.run], messages: [], nodes: [state.root, state.node, ...state.extraNodes], turnItems: []};
    const check = verifyWorkflowToolEvidence({projection, supervisorThreadId: evidenceThreadId, itemId: "evidence-item", detail: state.detail,
      tool: testCase.tool ?? "write", arguments: evidenceArgs});
    assert.deepEqual(check, testCase.expected, testCase.name);
  }
  const reasons = new Set(evidenceCases.map(testCase => testCase.expected.status === "verified" ? "verified" : `${testCase.expected.status}:${testCase.expected.reason}`));
  assert.deepEqual([...reasons].sort(), [
    "denied:native_item_identity_incomplete",
    "denied:native_item_identity_mismatch",
    "denied:native_item_not_executed",
    "denied:native_item_not_main_strong",
    "denied:native_item_not_running_or_completed",
    "denied:native_item_outside_main_run",
    "denied:native_root_node_rolled_back",
    "denied:native_run_identity_mismatch",
    "denied:native_run_rolled_back",
    "denied:native_tool_item_rolled_back",
    "denied:native_tool_name_unrecognized",
    "denied:native_tool_node_rolled_back",
    "denied:supervisor_projection_mismatch",
    "pending:native_input_does_not_match_request",
    "pending:native_input_empty",
    "pending:native_input_incomplete",
    "pending:native_input_not_json",
    "pending:native_input_too_large",
    "pending:native_item_unavailable",
    "pending:native_tool_name_or_wrapper_mismatch",
    "verified",
  ]);
});
