import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {NodeServices} from "@effect/platform-node";
import {it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import type {SqlClient} from "effect/sql";
import {TestClock} from "effect/testing";
import {fingerprint} from "../src/guidance-store.js";
import {defaultSupervisorModel, type ProjectSupervisorStoreShape} from "../src/project-supervisor-store.js";
import {proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {WorkflowStateStoreError, type WorkflowStateStoreShape} from "../src/workflow-state-store.js";
import type {ExternalContributionImport, WorkflowAgreementImport, WorkflowApplyInput, WorkflowOwner, WorkflowStateDocument, WorkflowStatePlan, WorkflowStateSourceBinding} from "../src/workflow-state-contract.js";
import type {ProjectDefinitionSnapshot} from "../src/project-definitions-contract.js";
import type {WorkflowPlanGroupInfo, WorkflowProposalInfo} from "../src/project-supervisor-contract.js";
import {effectiveIndex, projectIndex} from "./project-definitions-fixture.js";
import {countingIds, guidanceStoresFixture, reopenGuidanceStores} from "./support/guidance-store-services.js";

// target regressions of the WorkflowStateStore service (s6d step 1, manifest CT-WSS-01..04, and the stored-shape classification
// of CT-WSC-01 that the schema decode at the row boundary must keep); the synchronous characterizations stay in
// test/workflow-state.characterization.test.ts until the switch

type StoreFixture = {
  directory: string;
  sql: SqlClient.SqlClient;
  supervisors: ProjectSupervisorStoreShape;
  workflows: WorkflowStateStoreShape;
  close: Effect.Effect<void>;
  owner: WorkflowOwner;
  context: ReturnType<typeof proposalContextFromDefinitions>;
  proposal: WorkflowProposalInfo;
};

const live = <A, E, R>(body: Effect.Effect<A, E, R>) => body.pipe(Effect.provide(NodeServices.layer));
const taskSourceHash = fingerprint("Prepare the export workflow.");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const definitionSnapshot = (): ProjectDefinitionSnapshot => ({
  projectId: "project-a", threadId: "main-a", workspaceRoot: "/workspace/project-a", globalOnly: false, globalRevision: null,
  revision: "definition-revision-a", editingAvailable: true, status: "ready", steps: [], workflows: [],
  config: effectiveIndex({steps: [], workflows: []}), projectConfig: projectIndex(), definitionFiles: [], complete: true, sources: [], issues: [],
});

const localPlanInput = (ids: readonly string[]): WorkflowPlanGroupInfo => ({kind: "sequence", templatePath: null, nodes: ids.map(id => ({
  kind: "step", nodeId: randomUUID(), definitionId: null, localId: id, templatePath: null, name: `Local ${id}`,
  description: `Complete local task ${id}.`, source: null, resolution: "resolved", reason: `This task adds ${id}.`, status: "planned", contributorThreadIds: [],
}))});

const ownerFor = (supervisors: ProjectSupervisorStoreShape, mainThreadId: string) => Effect.gen(function* () {
  const reserved = yield* supervisors.reserve("project-a", mainThreadId, "Main conversation", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  yield* supervisors.setBinding(binding);
  return {projectId: "project-a", mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation} satisfies WorkflowOwner;
});

const makeStoreFixture = Effect.gen(function* () {
  const stores = yield* guidanceStoresFixture("workflow-state-regression-");
  yield* stores.sql`INSERT INTO meta VALUES(${`supervisor_control:${JSON.stringify("project-a")}`},${JSON.stringify({generation: 1, enabled: true, manual: true})})`;
  const definitions = definitionSnapshot();
  const context = proposalContextFromDefinitions(definitions);
  const canonical = validateWorkflowPlan({requirements: [], plan: localPlanInput(["local-a", "local-b"])}, context);
  assert.ok(canonical);
  const proposal = Object.assign({status: "proposed", message: "A source-bound draft plan.", workspaceRoot: definitions.workspaceRoot,
    revision: definitions.revision, globalRevision: definitions.globalRevision ?? null}, canonical) as WorkflowProposalInfo;
  const fixture: StoreFixture = {directory: stores.directory, sql: stores.sql, supervisors: stores.supervisors, workflows: stores.workflows, close: stores.close,
    owner: yield* ownerFor(stores.supervisors, "main-a"), context, proposal};
  return fixture;
});

const reopen = (fixture: StoreFixture) => Effect.gen(function* () {
  yield* fixture.close;
  const stores = yield* reopenGuidanceStores(fixture.directory);
  Object.assign(fixture, {sql: stores.sql, supervisors: stores.supervisors, workflows: stores.workflows, close: stores.close});
});

const sourceBinding = (proposal: WorkflowProposalInfo): WorkflowStateSourceBinding => ({
  workspaceRoot: proposal.workspaceRoot!, revision: proposal.revision, globalRevision: proposal.globalRevision, definitionsStatus: proposal.definitionsStatus,
  definitionsComplete: proposal.definitionsComplete, requirementsKnown: proposal.requirementsKnown, taskId: "task-a", proposalId: "proposal-a", sourceHash: taskSourceHash,
});

const acceptedAgreement = (proposal: WorkflowProposalInfo): WorkflowAgreementImport => ({
  taskId: "task-a", sourceThreadId: "main-a", sourceRunId: "run-a", sourceMessageId: "message-a", sourceHash: taskSourceHash, objective: "Prepare the export workflow.",
  agreement: {status: "agreed", message: "The complete workflow was echoed by the operative assistant.", proposalId: "proposal-a", agreedAt: 123,
    evidence: {kind: "supervisor_message", messageId: "supervisor-message-a"}, agentMessageId: "agent-message-a", workflow: proposal},
});

const validationFor = (fixture: StoreFixture) => ({
  pinnedContext: fixture.context, originalProposal: fixture.proposal, expectedTaskId: "task-a", expectedProposalId: "proposal-a",
  expectedSourceHash: taskSourceHash, acceptedTaskAgreement: null, acceptedTaskAgreementSourceHash: null,
});

const applyInput = (fixture: StoreFixture, document: WorkflowStateDocument, plan: WorkflowStatePlan, operationId: string,
  note = "The plan was reviewed and updated."): WorkflowApplyInput => ({
  operationId, workflowId: document.workflowId, expectedRevision: document.revision, status: document.status, objective: document.objective,
  sourceBinding: sourceBinding(fixture.proposal), requirements: [...fixture.proposal.requirements], issues: [...fixture.proposal.issues], plan, note,
});

const importMain = (fixture: StoreFixture) => Effect.gen(function* () {
  const imported = yield* fixture.sql.withTransaction(fixture.workflows.importAcceptedAgreement(fixture.owner, acceptedAgreement(fixture.proposal), 100));
  assert.equal(imported.status, "applied");
  return (yield* fixture.workflows.get("project-a", "main-a"))!;
});

// a plan that keeps every current node and appends one local step
const appendLocal = (document: WorkflowStateDocument, id: string): WorkflowPlanGroupInfo =>
  ({...document.plan!, nodes: [...document.plan!.nodes, localPlanInput([id]).nodes[0]!]});

type RawRow = {workflowId: string; projectId?: string; mainThreadId?: string; threadId: string; parentWorkflowId?: string | null;
  parentThreadId?: string | null; revision: number; document: string; createdAt?: number};
const insertRaw = (sql: SqlClient.SqlClient, row: RawRow) =>
  sql`INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document,created_at,updated_at) VALUES(${row.workflowId},${row.projectId ?? "project-a"},${row.mainThreadId ?? "main-a"},${row.threadId},${row.parentWorkflowId ?? null},${row.parentThreadId ?? null},${row.revision},${row.document},${row.createdAt ?? 500},${row.createdAt ?? 500})`;
const rawDocument = (sql: SqlClient.SqlClient, workflowId: string) =>
  Effect.map(sql`SELECT document FROM supervisor_workflow_state WHERE workflow_id=${workflowId}`, ([row]) => String(row?.document));
const operationRows = (sql: SqlClient.SqlClient) =>
  Effect.map(sql.unsafe<Record<string, unknown>>("SELECT * FROM supervisor_workflow_operations ORDER BY operation_namespace,operation_id"), (rows) => rows.map((row) => ({...row})));
const storedResult = (sql: SqlClient.SqlClient, operationId: string) =>
  Effect.map(sql`SELECT result FROM supervisor_workflow_operations WHERE operation_id=${operationId}`, ([row]) => String(row?.result));
const legacyFlatDocument = (workflowId: string, threadId: string): string => JSON.stringify({workflowId, projectId: "project-a", mainThreadId: "main-a",
  threadId, parentWorkflowId: null, parentThreadId: null, revision: 7, status: "planned", objective: "A retired flat plan.", rules: [],
  steps: [{id: "old-step", blockId: null, name: "Old format", reason: "Preserve as raw data.", status: "planned", contributorThreadIds: []}],
  currentAgreementKey: null, acceptedAgreements: [], evidence: [], createdAt: 10, updatedAt: 11});

it.live("CT-WSS-01: a failure after the CAS update and before the operation insert rolls the document revision back", () => live(Effect.gen(function* () {
  const fixture = yield* makeStoreFixture;
  const current = yield* importMain(fixture);
  const before = {document: yield* rawDocument(fixture.sql, current.workflowId), operations: yield* operationRows(fixture.sql)};
  // the operation insert fails only once the CAS update has already moved the stored revision in the same transaction
  yield* fixture.sql.unsafe(`CREATE TEMP TRIGGER wss_operation_after_cas BEFORE INSERT ON supervisor_workflow_operations
    WHEN (SELECT revision FROM main.supervisor_workflow_state WHERE workflow_id=NEW.workflow_id) = ${current.revision + 1}
    BEGIN SELECT RAISE(ABORT, 'wss_operation_insert_failed'); END`);
  const input = applyInput(fixture, current, appendLocal(current, "after-cas"), "cas-then-fail");

  const failed = yield* Effect.flip(fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 300));
  assert.ok(failed instanceof WorkflowStateStoreError);
  assert.equal(failed.reason, "workflow_store_unavailable");
  assert.equal(yield* rawDocument(fixture.sql, current.workflowId), before.document);
  assert.equal((yield* fixture.workflows.get("project-a", "main-a"))?.revision, current.revision);
  assert.deepEqual(yield* operationRows(fixture.sql), before.operations);

  // joined into a caller's transaction, the same failure fails the caller and leaves nothing either
  const joined = yield* Effect.exit(fixture.sql.withTransaction(fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 350)));
  assert.ok(Exit.isFailure(joined));
  assert.equal(yield* rawDocument(fixture.sql, current.workflowId), before.document);
  assert.deepEqual(yield* operationRows(fixture.sql), before.operations);

  // nothing was reserved: the identical request applies once the failure is removed
  yield* fixture.sql.unsafe("DROP TRIGGER temp.wss_operation_after_cas");
  const applied = yield* fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 400);
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal((yield* fixture.workflows.get("project-a", "main-a"))?.revision, current.revision + 1);
  assert.equal((yield* operationRows(fixture.sql)).length, before.operations.length + 1);
})), {timeout: 10_000});

it.live("CT-WSS-02: concurrent applies at one expected revision yield one applied and one revision conflict, and an identical operation ID writes once", () => live(Effect.gen(function* () {
  const fixture = yield* makeStoreFixture;
  const current = yield* importMain(fixture);
  const first = applyInput(fixture, current, appendLocal(current, "first"), "concurrent-a");
  const second = applyInput(fixture, current, appendLocal(current, "second"), "concurrent-b");
  const results = yield* Effect.all([
    fixture.workflows.apply(fixture.owner, first, validationFor(fixture), 300),
    fixture.workflows.apply(fixture.owner, second, validationFor(fixture), 301),
  ], {concurrency: "unbounded"});
  const applied = results.filter(result => result.status === "applied");
  const conflicts = results.filter(result => result.status === "conflict");
  assert.equal(applied.length, 1, JSON.stringify(results));
  assert.equal(conflicts.length, 1, JSON.stringify(results));
  const winner = applied[0]!;
  const loser = conflicts[0]!;
  assert.ok(winner.status === "applied" && loser.status === "conflict");
  assert.equal(winner.revision, current.revision + 1);
  assert.deepEqual(loser, {status: "conflict", operationId: loser.operationId, reason: "revision", currentRevision: current.revision + 1});
  assert.equal(winner.stateHash, sha256(yield* rawDocument(fixture.sql, current.workflowId)));
  assert.deepEqual((yield* operationRows(fixture.sql)).map(row => row.operation_id).sort(), [winner.operationId, "agreement:" + fingerprint(["task-a", "proposal-a"])].sort());

  // the same operation ID from two fibers writes once and both receive the identical receipt
  const latest = (yield* fixture.workflows.get("project-a", "main-a"))!;
  const once = applyInput(fixture, latest, appendLocal(latest, "once"), "same-op");
  const [left, right] = yield* Effect.all([
    fixture.workflows.apply(fixture.owner, once, validationFor(fixture), 400),
    fixture.workflows.apply(fixture.owner, once, validationFor(fixture), 401),
  ], {concurrency: "unbounded"});
  assert.equal(left.status, "applied", JSON.stringify(left));
  assert.deepEqual(right, left);
  assert.equal(JSON.stringify(right), JSON.stringify(left));
  assert.equal((yield* fixture.workflows.get("project-a", "main-a"))?.revision, latest.revision + 1);
  assert.equal((yield* operationRows(fixture.sql)).filter(row => row.operation_id === "same-op").length, 1);
})), {timeout: 10_000});

it.live("CT-WSS-03: receipts and incompatible rows survive reopen and an exact replay returns the byte-identical receipt", () => live(Effect.gen(function* () {
  const fixture = yield* makeStoreFixture;
  const current = yield* importMain(fixture);
  const input = applyInput(fixture, current, appendLocal(current, "durable"), "durable-apply");
  const receipt = yield* fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 300);
  assert.equal(receipt.status, "applied", JSON.stringify(receipt));
  const legacyId = "legacy-workflow";
  const legacyRaw = legacyFlatDocument(legacyId, "legacy-thread");
  yield* insertRaw(fixture.sql, {workflowId: legacyId, threadId: "legacy-thread", revision: 7, document: legacyRaw});
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
  };
  const legacyResult = JSON.stringify({status: "created", operationId: "legacy-replay", workflowId: legacyId, revision: 7, stateHash: "legacy-hash"});
  yield* fixture.sql`INSERT INTO supervisor_workflow_operations(project_id,main_thread_id,actor_thread_id,binding_generation,operation_namespace,operation_id,request_hash,result,workflow_id,created_at) VALUES(${fixture.owner.projectId},${fixture.owner.mainThreadId},${fixture.owner.supervisorThreadId},${fixture.owner.bindingGeneration},${"edit"},${"legacy-replay"},${fingerprint(canonical({kind: "ensure-main", owner: fixture.owner, note: "Start a draft."}))},${legacyResult},${legacyId},${12})`;
  const before = {document: yield* rawDocument(fixture.sql, current.workflowId), operations: yield* operationRows(fixture.sql)};
  const stored = yield* storedResult(fixture.sql, "durable-apply");
  assert.equal(stored, JSON.stringify(receipt));

  yield* reopen(fixture);
  const replay = yield* fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 900);
  assert.equal(JSON.stringify(replay), stored, "the replay is the stored receipt byte for byte");
  assert.deepEqual(replay, receipt);
  assert.equal(receipt.status === "applied" ? receipt.stateHash : null, sha256(before.document), "the stateHash is the sha256 of the stored document text");
  assert.equal(yield* rawDocument(fixture.sql, current.workflowId), before.document);
  assert.deepEqual(yield* operationRows(fixture.sql), before.operations);

  assert.deepEqual(yield* fixture.workflows.getState("project-a", "main-a", "legacy-thread"), {status: "incompatible", workflowId: legacyId, formatVersion: null});
  assert.deepEqual((yield* fixture.workflows.listResult("project-a", "main-a")).incompatible, [{workflowId: legacyId, formatVersion: null}]);
  assert.equal((yield* fixture.workflows.ensureMain(fixture.owner, "legacy-replay", "Start a draft.")).status, "incompatible",
    "the legacy receipt is never replayed as a successful write after reopen");
  assert.equal(yield* rawDocument(fixture.sql, legacyId), legacyRaw);
  assert.deepEqual(yield* operationRows(fixture.sql), before.operations);
})), {timeout: 10_000});

// a draft shaped exactly as ensureMain stores it, with fixed identities and times (the goldens of CT-WSS-04 in the characterization)
const goldenDraft = {
  formatVersion: 2, workflowId: "golden-workflow", projectId: "project-a", mainThreadId: "main-a", threadId: "main-a",
  parentWorkflowId: null, parentThreadId: null, revision: 1, status: "planned", objective: null, sourceBinding: null, requirements: [], issues: [],
  plan: null, currentAgreementKey: null, acceptedAgreements: [], contributions: [],
  evidence: [{operationId: "golden-ensure", kind: "draft_created", targetNodeId: null, targetNodeName: null, statusFrom: null, statusTo: "planned",
    sourceThreadId: null, sourceRunId: null, sourceMessageId: null, agreementKey: null, note: "Start a golden draft.", sourceItemId: null,
    id: "00000000-0000-4000-8000-0000000000e1", recordedAt: 1000, actorSupervisorThreadId: "golden-supervisor"}],
  createdAt: 1000, updatedAt: 1000,
};
const goldenDraftStateHash = "821e3c5c283547badbf3f115b8faa237a2ec8140a09c2baefc4073ef3aad1ec8";
const goldenDraftWithoutContributionsStateHash = "2959af5af9e736fbef6d0bef7d3fb7ca5cca8d3004222a02e0f32a46fbce93ca";

const keyShape = (value: unknown): unknown => Array.isArray(value) ? value.map(keyShape) :
  value !== null && typeof value === "object" ? Object.entries(value).map(([key, item]) => [key, keyShape(item)]) : typeof value;

it.live("CT-WSS-04: golden stateHash and receipt for a fixture document", () => live(Effect.gen(function* () {
  const fixture = yield* makeStoreFixture;
  // the golden literal has the key order and value types of a draft the service writes
  const real = yield* fixture.workflows.ensureMain(fixture.owner, "real-ensure", "Start a golden draft.", 1000);
  assert.equal(real.status, "created");
  if (real.status !== "created") return;
  const realStored = JSON.parse(yield* rawDocument(fixture.sql, real.workflowId)) as Record<string, unknown>;
  assert.deepEqual(keyShape(goldenDraft), keyShape(realStored));
  assert.equal(real.stateHash, sha256(yield* rawDocument(fixture.sql, real.workflowId)));
  yield* fixture.sql`DELETE FROM supervisor_workflow_state WHERE workflow_id=${real.workflowId}`;

  const text = JSON.stringify(goldenDraft);
  yield* insertRaw(fixture.sql, {workflowId: goldenDraft.workflowId, threadId: "main-a", revision: 1, document: text, createdAt: 1000});
  assert.equal(fingerprint(goldenDraft), goldenDraftStateHash);
  assert.equal(sha256(text), goldenDraftStateHash);
  const exists = yield* fixture.workflows.ensureMain(fixture.owner, "golden-exists", "Start a golden draft.", 2000);
  assert.equal(JSON.stringify(exists),
    `{"status":"exists","operationId":"golden-exists","workflowId":"golden-workflow","revision":1,"stateHash":"${goldenDraftStateHash}","formatVersion":2}`);

  // the hash covers the decoded document: a stored draft without contributions hashes with an empty list appended last
  const withoutContributions: Record<string, unknown> = {...goldenDraft};
  delete withoutContributions.contributions;
  yield* fixture.sql`UPDATE supervisor_workflow_state SET document=${JSON.stringify(withoutContributions)} WHERE workflow_id=${goldenDraft.workflowId}`;
  const legacyExists = yield* fixture.workflows.ensureMain(fixture.owner, "golden-exists-legacy", "Start a golden draft.", 2000);
  assert.equal(legacyExists.status === "exists" ? legacyExists.stateHash : null, goldenDraftWithoutContributionsStateHash);
  assert.equal(fingerprint({...withoutContributions, contributions: []}), goldenDraftWithoutContributionsStateHash);
  assert.notEqual(goldenDraftWithoutContributionsStateHash, goldenDraftStateHash);
  yield* fixture.sql`UPDATE supervisor_workflow_state SET document=${text} WHERE workflow_id=${goldenDraft.workflowId}`;

  // an applied receipt is stored with a fixed key order and the sha256 of the stored document text as its stateHash
  const draft = (yield* fixture.workflows.get("project-a", "main-a"))!;
  const applied = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, draft, fixture.proposal.plan, "golden-apply"), validationFor(fixture), 3000);
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  const document = yield* rawDocument(fixture.sql, goldenDraft.workflowId);
  const receipt = yield* storedResult(fixture.sql, "golden-apply");
  assert.equal(receipt,
    `{"status":"applied","operationId":"golden-apply","workflowId":"golden-workflow","revision":2,"stateHash":"${sha256(document)}","formatVersion":2}`);
  assert.equal(JSON.stringify(applied), receipt);
  assert.equal(fingerprint(yield* fixture.workflows.get("project-a", "main-a")), sha256(document));
})), {timeout: 10_000});

it.live("CT-WSC-01 (service): every stored document shape decodes to the golden found or incompatible classification", () => live(Effect.gen(function* () {
  const fixture = yield* makeStoreFixture;
  const imported = yield* importMain(fixture);
  const nodeId = imported.plan!.nodes[0]!.kind === "step" ? (imported.plan!.nodes[0] as {nodeId: string}).nodeId : "";
  const contribution: ExternalContributionImport = {contributionId: "review:external-1", nodeId, revision: 1, state: "awaiting_result",
    summary: "An external reviewer is checking the export.", references: [{kind: "url", value: "https://reviews.example/42"}], externalRef: "review-42",
    sourceThreadId: "main-a", sourceRunId: "run-main", sourceMessageId: "message-1"};
  assert.equal((yield* fixture.sql.withTransaction(fixture.workflows.recordContribution(fixture.owner, contribution, 200))).status, "applied");
  const main = (yield* fixture.workflows.get("project-a", "main-a"))!;
  const stored = JSON.parse(yield* rawDocument(fixture.sql, main.workflowId)) as Record<string, unknown>;
  assert.equal((stored.contributions as unknown[]).length, 1);

  // a real draft written by the service for a second main
  const ownerB = yield* ownerFor(fixture.supervisors, "main-b");
  const draft = yield* fixture.workflows.ensureMain(ownerB, "draft-b", "Start a draft.", 300);
  assert.equal(draft.status, "created");
  const draftStored = JSON.parse(yield* rawDocument(fixture.sql, (yield* fixture.workflows.get("project-a", "main-b"))!.workflowId)) as Record<string, unknown>;

  const variant = (label: string, change: (document: Record<string, unknown>) => void, base = stored): RawRow => {
    const document = structuredClone(base);
    document.workflowId = `wsc-${label}`;
    document.threadId = `thread-${label}`;
    change(document);
    return {workflowId: `wsc-${label}`, mainThreadId: String(document.mainThreadId), threadId: `thread-${label}`,
      parentWorkflowId: document.parentWorkflowId as string | null, parentThreadId: document.parentThreadId as string | null,
      revision: Number(document.revision), document: JSON.stringify(document)};
  };
  const text = (label: string, document: string): RawRow => ({workflowId: `wsc-${label}`, threadId: `thread-${label}`, revision: 1, document});
  const rows: Array<[string, RawRow]> = [
    ["without-contributions", variant("without-contributions", document => {delete document.contributions;})],
    ["extra-top-level-field", variant("extra-top-level-field", document => {document.futureField = {kept: true};})],
    ["revision-zero", variant("revision-zero", document => {document.revision = 0;})],
    ["linked-child-draft", variant("linked-child-draft", document => {document.parentWorkflowId = draftStored.workflowId; document.parentThreadId = "main-b";}, draftStored)],
    ["not-json", text("not-json", "{not json")],
    ["json-array", text("json-array", "[]")],
    ["legacy-flat", {...text("legacy-flat", legacyFlatDocument("wsc-legacy-flat", "thread-legacy-flat")), revision: 7}],
    ["format-version-1", variant("format-version-1", document => {document.formatVersion = 1;})],
    ["format-version-3", variant("format-version-3", document => {document.formatVersion = 3;})],
    ["format-version-string", variant("format-version-string", document => {document.formatVersion = "2";})],
    ["revision-column-mismatch", {...variant("revision-column-mismatch", () => undefined), revision: Number(stored.revision) + 5}],
    ["workflow-id-column-mismatch", variant("workflow-id-column-mismatch", document => {document.workflowId = "another-workflow";})],
    ["negative-revision", variant("negative-revision", document => {document.revision = -1;})],
    ["unknown-status", variant("unknown-status", document => {document.status = "done";})],
    ["unknown-evidence-kind", variant("unknown-evidence-kind", document => {(document.evidence as Array<Record<string, unknown>>)[0]!.kind = "imported";})],
    ["missing-evidence", variant("missing-evidence", document => {delete document.evidence;})],
    ["contributions-null", variant("contributions-null", document => {document.contributions = null;})],
    ["contribution-entry-invalid", variant("contribution-entry-invalid", document => {document.contributions = [{}];})],
    ["empty-plan-group", variant("empty-plan-group", document => {document.plan = {kind: "sequence", templatePath: null, nodes: []};})],
  ];
  for (const [, row] of rows) yield* insertRaw(fixture.sql, row);

  // the golden classification of the synchronous store
  const golden: Array<[string, "found" | "incompatible", number | null]> = [
    ["without-contributions", "found", null], ["extra-top-level-field", "found", null], ["revision-zero", "found", null], ["linked-child-draft", "found", null],
    ["not-json", "incompatible", null], ["json-array", "incompatible", null], ["legacy-flat", "incompatible", null],
    ["format-version-1", "incompatible", 1], ["format-version-3", "incompatible", 3], ["format-version-string", "incompatible", null],
    ["revision-column-mismatch", "incompatible", 2], ["workflow-id-column-mismatch", "incompatible", 2], ["negative-revision", "incompatible", 2],
    ["unknown-status", "incompatible", 2], ["unknown-evidence-kind", "incompatible", 2], ["missing-evidence", "incompatible", 2],
    ["contributions-null", "incompatible", 2], ["contribution-entry-invalid", "incompatible", 2], ["empty-plan-group", "incompatible", 2],
  ];
  assert.deepEqual(golden.map(([label]) => label), rows.map(([label]) => label));
  const byLabel = new Map(rows);
  for (const [label, status, formatVersion] of golden) {
    const row = byLabel.get(label)!;
    const result = yield* fixture.workflows.getState("project-a", row.mainThreadId ?? "main-a", row.threadId);
    if (status === "incompatible") {
      assert.deepEqual(result, {status, workflowId: row.workflowId, formatVersion}, label);
      continue;
    }
    const parsed = JSON.parse(row.document) as Record<string, unknown>;
    // found documents are returned as stored, with a missing contributions field read as empty and unknown fields retained
    assert.deepEqual(result, {status: "found", document: {...parsed, contributions: parsed.contributions ?? []}}, label);
  }
  assert.deepEqual(yield* fixture.workflows.getState("project-a", "main-a"), {status: "found", document: stored});
  assert.deepEqual(yield* fixture.workflows.getState("project-a", "main-b"), {status: "found", document: draftStored});
  for (const [, row] of rows) assert.equal(yield* rawDocument(fixture.sql, row.workflowId), row.document, "classification never rewrites a row");
})), {timeout: 10_000});

it.effect("CC-CLOCK-WALL and CC-IDS: workflow times default to Clock and workflow and evidence identities come from SupervisorIds", () => live(Effect.gen(function* () {
  const stores = yield* guidanceStoresFixture("workflow-state-clock-", {ids: countingIds});
  const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  yield* stores.sql`INSERT INTO meta VALUES(${`supervisor_control:${JSON.stringify("project-a")}`},${JSON.stringify({generation: 1, enabled: true, manual: true})})`;
  yield* TestClock.setTime(1_800_000_000_000);
  const owner = yield* ownerFor(stores.supervisors, "main-a");
  assert.equal(owner.supervisorThreadId, `supervisor-root:${id(1)}`);
  const created = yield* stores.workflows.ensureMain(owner, "clock-ensure", "Start a draft.");
  assert.deepEqual(created, {status: "created", operationId: "clock-ensure", workflowId: id(2), revision: 1,
    stateHash: sha256(yield* rawDocument(stores.sql, id(2))), formatVersion: 2});
  const document = (yield* stores.workflows.get("project-a", "main-a"))!;
  assert.deepEqual([document.createdAt, document.updatedAt, document.evidence[0]?.id, document.evidence[0]?.recordedAt],
    [1_800_000_000_000, 1_800_000_000_000, id(3), 1_800_000_000_000]);
  const [operation] = yield* stores.sql`SELECT created_at FROM supervisor_workflow_operations WHERE operation_id=${"clock-ensure"}`;
  assert.equal(operation?.created_at, 1_800_000_000_000);
})), {timeout: 10_000});
