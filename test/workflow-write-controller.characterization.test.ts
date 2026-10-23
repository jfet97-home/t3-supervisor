import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import type { Projection, RunInfo, ThreadInfo } from "../src/types.js";
import {
  supervisionStartToolDefinition,
  supervisionStopToolDefinition,
  workflowReadToolDefinition,
  workflowWriteToolDefinition,
  type WorkflowApplyPatch,
} from "../src/workflow-write-controller.js";
import {
  verifyWorkflowToolEvidence,
  workflowToolInputMaxBytes,
  workflowToolNames,
  type WorkflowEvidenceCheck,
  type WorkflowEvidenceTool,
} from "../src/workflow-write-evidence.js";
import { replaceMethod } from "./support/g1a-conversation.js";
import { sqlAll, sqlGet, openWwcStores, type WwcStores } from "./support/wwc-stores.js";
import {
  ensureArgs, localStep, makeFixture, openWrite, sequencePlan, thread,
  type WwcFixture, type WwcNative,
} from "./support/wwc-fixture.js";

// evidence helpers stay in this file: each item is the recorded shape, and apply arguments use the fixture proposal

const applyArgs = (fixture: WwcFixture, input: WorkflowApplyPatch) => ({
  action: "apply", supervisorThreadId: fixture.supervisorThreadId, bindingGeneration: fixture.binding.generation,
  input: {sourceBinding: fixture.sourceBinding, requirements: fixture.proposal.requirements, issues: fixture.proposal.issues, ...input},
});

const nativeRunId = "supervisor-run-current";
const nativeProviderThreadId = "provider-thread-current";
const nativeRootNodeId = "supervisor-root";

type EvidenceRecord = {itemId: string; detail: Record<string, unknown>; node: Record<string, unknown>; turnItem: Record<string, unknown>};

// one exact strong own-main tool item as the baseline suite's installEvidence builds it
const evidenceRecord = (fixture: WwcFixture, args: Record<string, unknown>, itemId: string, ordinal: number): EvidenceRecord => {
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

const evidenceView = (fixture: WwcFixture, records: readonly EvidenceRecord[]): Projection => ({
  thread: thread(fixture.supervisorThreadId, fixture.projectId),
  runs: [{id: nativeRunId, ordinal: 1, status: "completed", requestedAt: "2026-10-14T00:00:00.000Z", startedAt: "2026-10-14T00:00:00.000Z",
    completedAt: "2026-10-14T00:00:01.000Z", rootNodeId: nativeRootNodeId, threadId: fixture.supervisorThreadId, providerThreadId: nativeProviderThreadId}],
  messages: [],
  nodes: [{id: nativeRootNodeId, kind: "root_turn", threadId: fixture.supervisorThreadId, runId: nativeRunId, rootNodeId: nativeRootNodeId,
    providerThreadId: nativeProviderThreadId, parentNodeId: null, status: "completed"}, ...records.map(record => record.node)],
  turnItems: records.map(record => record.turnItem),
});

const installEvidence = (fixture: WwcFixture, args: Record<string, unknown>, itemId: string): string => {
  const record = evidenceRecord(fixture, args, itemId, 100 + fixture.details.size);
  fixture.details.set(itemId, record.detail);
  fixture.projections.set(fixture.supervisorThreadId, evidenceView(fixture, [record]));
  return itemId;
};

const rowCount = (fixture: WwcFixture, table: string, operationId?: string, db = fixture.db) => Effect.map(
  operationId === undefined
    ? sqlGet(db, `SELECT count(*) AS n FROM ${table}`)
    : sqlGet(db, `SELECT count(*) AS n FROM ${table} WHERE operation_id=?`, operationId),
  (row) => Number(row?.n),
);

const assertNothingStored = (fixture: WwcFixture, label: string) => Effect.gen(function* () {
  assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_receipts"), 0, label);
  assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_evidence"), 0, label);
  assert.equal(yield* rowCount(fixture, "supervisor_workflow_operations"), 0, label);
  assert.equal(yield* fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null, label);
});

const storedDocument = (fixture: WwcFixture, db = fixture.db) => Effect.gen(function* () {
  const row = yield* sqlGet(db,
    "SELECT workflow_id,revision,document,updated_at FROM supervisor_workflow_state WHERE project_id=? AND main_thread_id=?",
    fixture.projectId, fixture.mainThreadId);
  return JSON.stringify(Object.values(row ?? {}));
});

const evidenceRows = (fixture: WwcFixture) => Effect.gen(function* () {
  const rows = yield* sqlAll(fixture.db,
    "SELECT item_id,operation_id,successful,result FROM supervisor_workflow_write_evidence ORDER BY item_id");
  return rows.map(row => [String(row.item_id), String(row.operation_id), String(row.successful), String(row.result)]);
});

const withDefinitions = (fixture: WwcFixture, native: WwcNative, maxEvidenceWaitMs = 0) =>
  openWrite(fixture, {native, maxEvidenceWaitMs, loadDefinitions: fixture.loadDefinitions});

it.effect("CT-WWC-01: an abort during evidence polling or after listThreads returns the interrupted pending reason and stores nothing", () => Effect.gen(function* () {
  // completing the call cancel after a projection with no matching evidence ends the pause before another read
  {
    const fixture = yield* makeFixture();
    try {
      const cancel = yield* Deferred.make<void>();
      const native: WwcNative = {...fixture.native, projection: (threadId, caller) => Effect.gen(function* () {
        const projection = yield* fixture.native.projection(threadId, caller);
        yield* Deferred.succeed(cancel, undefined);
        return projection;
      })};
      const controller = yield* withDefinitions(fixture, native, 5_000);
      const args = ensureArgs(fixture, "interrupted-poll", "Create the main workflow after an interrupted poll.");
      assert.deepEqual(yield* controller.write(args, cancel),
        {status: "pending", operationId: "interrupted-poll", reason: "native_evidence_wait_interrupted", retryable: true});
      assert.deepEqual(fixture.calls.projection, [fixture.supervisorThreadId], "the abort ends the poll wait before another projection read");
      assert.equal(fixture.calls.listThreads, 0);
      yield* assertNothingStored(fixture, "poll");
      installEvidence(fixture, args, "interrupted-poll-item");
      assert.equal((yield* fixture.controller.write(args)).status, "created", "the interrupted request reserved nothing");
    } finally {yield* fixture.close;}
  }
  // completing the call cancel at the start of the detail read, after the controller has already begun verification
  {
    const fixture = yield* makeFixture();
    try {
      const cancel = yield* Deferred.make<void>();
      const native: WwcNative = {...fixture.native, getTurnItem: (input, caller) => Effect.gen(function* () {
        yield* Deferred.succeed(cancel, undefined);
        return yield* fixture.native.getTurnItem(input, caller);
      })};
      const controller = yield* withDefinitions(fixture, native);
      const args = ensureArgs(fixture, "interrupted-detail", "Create the main workflow after an interrupted detail read.");
      installEvidence(fixture, args, "interrupted-detail-item");
      assert.deepEqual(yield* controller.write(args, cancel),
        {status: "pending", operationId: "interrupted-detail", reason: "native_evidence_wait_interrupted", retryable: true});
      assert.deepEqual(fixture.calls.detail, ["interrupted-detail-item"]);
      assert.equal(fixture.calls.listThreads, 0);
      yield* assertNothingStored(fixture, "detail");
      assert.equal((yield* fixture.controller.write(args)).status, "created");
    } finally {yield* fixture.close;}
  }
  // completing the call cancel while listThreads runs; the lineage read itself succeeds
  {
    const fixture = yield* makeFixture();
    try {
      const cancel = yield* Deferred.make<void>();
      const native: WwcNative = {...fixture.native, listThreads: (caller) => Effect.gen(function* () {
        yield* Deferred.succeed(cancel, undefined);
        return yield* fixture.native.listThreads(caller);
      })};
      const controller = yield* withDefinitions(fixture, native);
      const args = ensureArgs(fixture, "interrupted-lineage", "Create the main workflow after an interrupted lineage read.");
      installEvidence(fixture, args, "interrupted-lineage-item");
      assert.deepEqual(yield* controller.write(args, cancel),
        {status: "pending", operationId: "interrupted-lineage", reason: "native_lineage_interrupted", retryable: true});
      assert.deepEqual(fixture.calls.detail, ["interrupted-lineage-item"]);
      assert.equal(fixture.calls.listThreads, 1);
      yield* assertNothingStored(fixture, "lineage");
      assert.equal((yield* fixture.controller.write(args)).status, "created");
    } finally {yield* fixture.close;}
  }
}), {timeout: 10_000});

it.effect("CT-WWC-02: concurrent identical writes proven by two distinct native items mutate once and share one receipt; a reused item is denied", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  try {
    const args = ensureArgs(fixture, "concurrent-op", "Create the main workflow once.");
    const first = evidenceRecord(fixture, args, "concurrent-item-1", 101);
    const second = evidenceRecord(fixture, args, "concurrent-item-2", 102);
    fixture.details.set(first.itemId, first.detail);
    fixture.details.set(second.itemId, second.detail);
    const views = [evidenceView(fixture, [first]), evidenceView(fixture, [second])];
    let arrivals = 0;
    const gate = yield* Deferred.make<void>();
    const native: WwcNative = {...fixture.native, projection: (threadId) => Effect.gen(function* () {
      const view = views[arrivals++];
      if (arrivals === 2) yield* Deferred.succeed(gate, undefined);
      // both writes have passed their initial receipt check before either one verifies its own native item
      yield* Deferred.await(gate);
      return view ?? (yield* fixture.native.projection(threadId));
    })};
    const controller = yield* withDefinitions(fixture, native);
    const [left, right] = yield* Effect.all([controller.write(args), controller.write(args)], {concurrency: "unbounded"});
    assert.equal(left.status, "created", JSON.stringify(left));
    assert.deepEqual(right, left);
    assert.equal(JSON.stringify(right), JSON.stringify(left));
    assert.deepEqual(fixture.calls.detail.toSorted(), [first.itemId, second.itemId]);
    const document = yield* fixture.workflows.get(fixture.projectId, fixture.mainThreadId);
    assert.equal(document?.revision, 1);
    assert.equal(document?.evidence.length, 1, "one mutation");
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_receipts", "concurrent-op"), 1);
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_operations", "concurrent-op"), 1);
    assert.deepEqual(yield* evidenceRows(fixture), [
      [first.itemId, "concurrent-op", "1", JSON.stringify(left)],
      [second.itemId, "concurrent-op", "1", JSON.stringify(left)],
    ]);

    const documentBefore = yield* storedDocument(fixture);
    const reuseArgs = ensureArgs(fixture, "reused-item-op", "A different request presented with an already used native item.");
    fixture.details.set(first.itemId, {...first.detail, input: reuseArgs});
    fixture.projections.set(fixture.supervisorThreadId, evidenceView(fixture, [first]));
    assert.deepEqual(yield* fixture.controller.write(reuseArgs), {status: "denied", operationId: "reused-item-op", reason: "native_evidence_reused"});
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_receipts", "reused-item-op"), 0);
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_evidence", "reused-item-op"), 0);
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_evidence"), 2);
    assert.equal(yield* storedDocument(fixture), documentBefore);
  } finally {yield* fixture.close;}
}), {timeout: 10_000});

it.effect("CT-WWC-04: a throw from applyInTransaction after its writes yields workflow_write_transaction_failed with no receipt, evidence or document change", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  try {
    const ensure = ensureArgs(fixture, "rollback-create", "Create a draft before the failing apply.");
    installEvidence(fixture, ensure, "rollback-create-item");
    const created = yield* fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const args = applyArgs(fixture, {operationId: "rollback-apply", workflowId: created.workflowId, expectedRevision: created.revision,
      status: "planned", plan: sequencePlan([localStep("Inspect exporter", "Find the current path.")]), note: "Add a step that never commits."});
    installEvidence(fixture, args, "rollback-apply-item");
    const documentBefore = yield* storedDocument(fixture);
    // the controller's apply inside its transaction; the replacement reads the partial state on that transaction, then fails
    const partial: Array<{status: string; revision: number | undefined; operations: number}> = [];
    yield* replaceMethod(fixture.workflows, "apply", (original) => (owner, input, validation, now) => Effect.gen(function* () {
      const result = yield* original(owner, input, validation, now);
      const operations = yield* sqlGet(fixture.db, "SELECT count(*) AS n FROM supervisor_workflow_operations WHERE operation_id=?", "rollback-apply");
      partial.push({status: result.status, revision: (yield* fixture.workflows.get(fixture.projectId, fixture.mainThreadId))?.revision, operations: Number(operations?.n)});
      return yield* Effect.die(new Error("injected_failure_after_partial_apply"));
    }));
    assert.deepEqual(yield* fixture.controller.write(args), {status: "denied", operationId: "rollback-apply", reason: "workflow_write_transaction_failed"});
    assert.deepEqual(partial, [{status: "applied", revision: 2, operations: 1}], "the document and its operation were written inside the transaction");
    assert.equal(fixture.inTransaction, false);
    assert.equal(yield* storedDocument(fixture), documentBefore);
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_operations", "rollback-apply"), 0);
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_receipts", "rollback-apply"), 0);
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_evidence", "rollback-apply"), 0);
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_receipts"), 1);
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_evidence"), 1);
  } finally {yield* fixture.close;}
}), {timeout: 10_000});

it.effect("CT-WWC-05: successful receipts replay byte-identically through a new controller after the guidance store reopens", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  let reopened: WwcStores | null = null;
  try {
    const ensure = ensureArgs(fixture, "reopen-create", "Create a draft before restart.");
    installEvidence(fixture, ensure, "reopen-create-item");
    const created = yield* fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const args = applyArgs(fixture, {operationId: "reopen-apply", workflowId: created.workflowId, expectedRevision: created.revision,
      plan: sequencePlan([localStep("Review source", "Keep this committed edit durable.")]), note: "Apply this edit before restart."});
    installEvidence(fixture, args, "reopen-apply-item");
    const applied = yield* fixture.controller.write(args);
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    const receipts = (db: WwcStores["db"]) => Effect.map(sqlAll(db,
      "SELECT operation_id,operation_namespace,request_hash,project_id,main_thread_id,supervisor_thread_id,binding_generation,result,created_at FROM supervisor_workflow_write_receipts ORDER BY operation_id"),
    (rows) => JSON.stringify(rows.map(row => Object.values(row))));
    const receiptsBefore = yield* receipts(fixture.db);
    const documentBefore = yield* storedDocument(fixture);
    yield* fixture.close;

    reopened = yield* openWwcStores(fixture.directory);
    const nativeCalls: string[] = [];
    const native: WwcNative = {
      listThreads: () => {nativeCalls.push("listThreads"); return Effect.die(new Error("no_native_read_expected"));},
      projection: (id) => {nativeCalls.push(`projection:${id}`); return Effect.die(new Error("no_native_read_expected"));},
      getTurnItem: ({itemId}) => {nativeCalls.push(`detail:${itemId}`); return Effect.die(new Error("no_native_read_expected"));},
    };
    const replay: WwcFixture = {...fixture, db: reopened.db, supervisors: reopened.supervisors, workflows: reopened.workflows,
      team: reopened.team, requests: reopened.requests, context: reopened.context, native, close: reopened.close};
    const controller = yield* openWrite(replay, {native, maxEvidenceWaitMs: 0, loadDefinitions: () => {
      nativeCalls.push("loadDefinitions");
      return Effect.fail(new Error("no_definition_read_expected"));
    }});
    const createReplay = yield* controller.write(ensure);
    const applyReplay = yield* controller.write(args);
    assert.equal(JSON.stringify(createReplay), JSON.stringify(created));
    assert.equal(JSON.stringify(applyReplay), JSON.stringify(applied));
    assert.deepEqual(createReplay, created);
    assert.deepEqual(applyReplay, applied);
    assert.deepEqual(nativeCalls, [], "a receipt replay reads no native evidence or definitions");
    assert.equal(yield* receipts(reopened.db), receiptsBefore);
    assert.equal(yield* storedDocument(fixture, reopened.db), documentBefore);
    assert.equal(yield* rowCount(fixture, "supervisor_workflow_write_evidence", undefined, reopened.db), 2);
  } finally {
    if (reopened) yield* reopened.close;
    yield* fixture.close;
  }
}), {timeout: 10_000});

it.effect("CT-WWC-06: the four model-visible tool definitions serialize to the recorded golden JSON", () => Effect.sync(() => {
  const golden = readFileSync(new URL("./support/c2-wwc-tool-definitions.golden.json", import.meta.url), "utf8");
  const actual = `${JSON.stringify({workflowReadToolDefinition, workflowWriteToolDefinition, supervisionStartToolDefinition, supervisionStopToolDefinition}, null, 2)}\n`;
  assert.equal(actual, golden);
}), {timeout: 10_000});

it.effect("CT-WWC-08: a binding generation bump during an awaited native read after verification denies owner_changed and stores nothing", () => Effect.gen(function* () {
  for (const read of ["detail", "lineage"] as const) {
    const fixture = yield* makeFixture();
    try {
      const operationId = `generation-${read}`;
      const args = ensureArgs(fixture, operationId, "Create the main workflow under the original binding.");
      const itemId = installEvidence(fixture, args, `${operationId}-item`);
      const bump = () => fixture.supervisors.setBinding({...fixture.binding, generation: fixture.binding.generation + 1}).pipe(Effect.orDie);
      const native: WwcNative = read === "detail"
        ? {...fixture.native, getTurnItem: (input, caller) => Effect.flatMap(bump(), () => fixture.native.getTurnItem(input, caller))}
        : {...fixture.native, listThreads: (caller) => Effect.flatMap(bump(), () => fixture.native.listThreads(caller))};
      const controller = yield* withDefinitions(fixture, native);
      assert.deepEqual(yield* controller.write(args), {status: "denied", operationId, reason: "owner_changed"}, read);
      assert.deepEqual(fixture.calls.detail, [itemId], read);
      assert.equal(fixture.calls.listThreads, 1, read);
      assert.equal((yield* fixture.supervisors.binding(fixture.projectId, fixture.mainThreadId).pipe(Effect.orDie))?.generation, fixture.binding.generation + 1, read);
      yield* assertNothingStored(fixture, read);
    } finally {yield* fixture.close;}
  }
}), {timeout: 10_000});

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

it.effect("CT-WWE-01: verifyWorkflowToolEvidence returns each denial and pending reason for its exact native condition", () => Effect.sync(() => {
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
}), {timeout: 10_000});
