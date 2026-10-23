import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {it} from "@effect/vitest";
import {Clock, Context, Deferred, Effect, Exit, Layer} from "effect";
import type {GuidanceDb} from "../src/db.js";
import {guidanceTransaction} from "../src/guidance-sql.js";
import {fingerprint} from "../src/guidance-store.js";
import {defaultSupervisorModel, type BindingRecord, type ProjectSupervisorStore, type TaskRecord} from "../src/project-supervisor-store.js";
import {ProjectDefinitions} from "../src/project-definitions.js";
import {SupervisionScopeService} from "../src/supervision-gate.js";
import {SupervisorTeamStore} from "../src/supervisor-team-store.js";
import {proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import {WorkflowStateStoreError, type WorkflowStateStore} from "../src/workflow-state-store.js";
import type {ExternalContributionImport, WorkflowAgreementImport, WorkflowApplyInput, WorkflowOwner, WorkflowStateDocument, WorkflowStatePlan, WorkflowStateSourceBinding} from "../src/workflow-state-contract.js";
import {WorkflowNativeAccess, WorkflowWriteController, type WorkflowApplyPatch} from "../src/workflow-write-controller.js";
import {workflowToolNames} from "../src/workflow-write-evidence.js";
import type {ProjectDefinitionSnapshot} from "../src/project-definitions-contract.js";
import type {WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo, WorkflowSourceBindingInfo} from "../src/project-supervisor-contract.js";
import type {Projection, ThreadInfo} from "../src/types.js";
import {effectiveIndex, projectIndex} from "./project-definitions-fixture.js";
import {admissionLayer, execute, openWorkflowStores, policyClient, query, runConfig, temporaryDirectory, type StatementObserver} from "./support/g12-stores.js";

// live Effect tests on the workflow state store and write controller services over the production layers: each fixture writes a
// real guidance.sqlite3 (and, for the controller, thread-settings.sqlite3) in a temporary directory, closed and removed with
// the test scope; nothing here waits on time

// store fixture: one ready binding for main-a on a temp-file guidance database, a local two-step proposal (copied from test/workflow-state.test.ts)
type StoreFixture = {
  directory: string;
  sql: GuidanceDb["Service"];
  supervisors: ProjectSupervisorStore["Service"];
  workflows: WorkflowStateStore["Service"];
  close: Effect.Effect<void>;
  owner: WorkflowOwner;
  context: ReturnType<typeof proposalContextFromDefinitions>;
  proposal: WorkflowProposalInfo;
};

const taskSourceHash = fingerprint("Prepare the export workflow.");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const definitionSnapshot = (): ProjectDefinitionSnapshot => ({
  projectId: "project-a",
  threadId: "main-a",
  workspaceRoot: "/workspace/project-a",
  globalOnly: false,
  globalRevision: null,
  revision: "definition-revision-a",
  editingAvailable: true,
  status: "ready",
  steps: [],
  workflows: [],
  config: effectiveIndex({steps: [], workflows: []}),
  projectConfig: projectIndex(),
  definitionFiles: [],
  complete: true,
  sources: [],
  issues: [],
});

const localPlanInput = (ids: readonly string[]): WorkflowPlanGroupInfo => ({kind: "sequence", templatePath: null, nodes: ids.map(id => ({
  kind: "step",
  nodeId: randomUUID(),
  definitionId: null,
  localId: id,
  templatePath: null,
  name: `Local ${id}`,
  description: `Complete local task ${id}.`,
  source: null,
  resolution: "resolved",
  reason: `This task adds ${id}.`,
  status: "planned",
  contributorThreadIds: [],
}))});

// the stores of a temp-file guidance database; an observed client reports the statements a test watches
const openStore = (directory: string, observe?: StatementObserver) => Effect.map(openWorkflowStores(directory, {observe}),
  (opened) => ({sql: opened.sql, supervisors: opened.supervisors, workflows: opened.workflows, close: opened.close}));

const makeStoreFixture = (observe?: StatementObserver) => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("workflow-state-characterization-");
  // a reopen replaces the client; the test scope closes whichever one is current
  const opened = yield* openStore(directory, observe);
  yield* execute(opened.sql, "INSERT INTO meta VALUES(?,?)", `supervisor_control:${JSON.stringify("project-a")}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const definitions = definitionSnapshot();
  const context = proposalContextFromDefinitions(definitions);
  const canonical = validateWorkflowPlan({requirements: [], plan: localPlanInput(["local-a", "local-b"])}, context);
  assert.ok(canonical);
  const proposal = Object.assign({status: "proposed", message: "A source-bound draft plan.", workspaceRoot: definitions.workspaceRoot,
    revision: definitions.revision, globalRevision: definitions.globalRevision ?? null}, canonical) as WorkflowProposalInfo;
  const fixture: StoreFixture = {directory, ...opened, owner: yield* ownerFor(opened.supervisors, "main-a"), context, proposal};
  return fixture;
});

const ownerFor = (supervisors: ProjectSupervisorStore["Service"], mainThreadId: string) => Effect.gen(function* () {
  const reserved = yield* supervisors.reserve("project-a", mainThreadId, "Main conversation", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  yield* supervisors.setBinding(binding);
  return {projectId: "project-a", mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation} satisfies WorkflowOwner;
});

// the client closed and the file opened again with fresh services, as a restart does
const reopen = (fixture: StoreFixture) => Effect.gen(function* () {
  yield* fixture.close;
  Object.assign(fixture, yield* openStore(fixture.directory));
});

// whether the client's connection is inside a transaction: BEGIN fails on an open one, a fresh one is rolled back at once
const inTransaction = (sql: GuidanceDb["Service"]) => Effect.flatMap(Effect.exit(sql.unsafe("BEGIN")),
  (begun) => begun._tag === "Success" ? Effect.as(execute(sql, "ROLLBACK"), false) : Effect.succeed(true));

const sourceBinding = (proposal: WorkflowProposalInfo): WorkflowStateSourceBinding => ({
  workspaceRoot: proposal.workspaceRoot!,
  revision: proposal.revision,
  globalRevision: proposal.globalRevision,
  definitionsStatus: proposal.definitionsStatus,
  definitionsComplete: proposal.definitionsComplete,
  requirementsKnown: proposal.requirementsKnown,
  taskId: "task-a",
  proposalId: "proposal-a",
  sourceHash: taskSourceHash,
});

const acceptedAgreement = (proposal: WorkflowProposalInfo): WorkflowAgreementImport => ({
  taskId: "task-a",
  sourceThreadId: "main-a",
  sourceRunId: "run-a",
  sourceMessageId: "message-a",
  sourceHash: taskSourceHash,
  objective: "Prepare the export workflow.",
  agreement: {
    status: "agreed",
    message: "The complete workflow was echoed by the operative assistant.",
    proposalId: "proposal-a",
    agreedAt: 123,
    evidence: {kind: "supervisor_message", messageId: "supervisor-message-a"},
    agentMessageId: "agent-message-a",
    workflow: proposal,
  },
});

const validationFor = (fixture: StoreFixture) => ({
  pinnedContext: fixture.context,
  originalProposal: fixture.proposal,
  expectedTaskId: "task-a",
  expectedProposalId: "proposal-a",
  expectedSourceHash: taskSourceHash,
  acceptedTaskAgreement: null,
  acceptedTaskAgreementSourceHash: null,
});

const applyInput = (fixture: StoreFixture, document: WorkflowStateDocument, plan: WorkflowStatePlan, operationId: string,
  note = "The plan was reviewed and updated."): WorkflowApplyInput => ({
  operationId,
  workflowId: document.workflowId,
  expectedRevision: document.revision,
  status: document.status,
  objective: document.objective,
  sourceBinding: sourceBinding(fixture.proposal),
  requirements: [...fixture.proposal.requirements],
  issues: [...fixture.proposal.issues],
  plan,
  note,
});

const importMain = (fixture: StoreFixture) => Effect.gen(function* () {
  const imported = yield* guidanceTransaction(fixture.sql)(fixture.workflows.importAcceptedAgreement(fixture.owner, acceptedAgreement(fixture.proposal), 100));
  assert.equal(imported.status, "applied");
  return (yield* fixture.workflows.get("project-a", "main-a"))!;
});

// a plan that keeps every current node and appends one local step
const appendLocal = (document: WorkflowStateDocument, id: string): WorkflowPlanGroupInfo =>
  ({...document.plan!, nodes: [...document.plan!.nodes, localPlanInput([id]).nodes[0]!]});

type RawRow = {workflowId: string; projectId?: string; mainThreadId?: string; threadId: string; parentWorkflowId?: string | null;
  parentThreadId?: string | null; revision: number; document: string; createdAt?: number};

const insertRaw = (sql: GuidanceDb["Service"], row: RawRow) =>
  execute(sql, "INSERT INTO supervisor_workflow_state(workflow_id,project_id,main_thread_id,thread_id,parent_workflow_id,parent_thread_id,revision,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    row.workflowId, row.projectId ?? "project-a", row.mainThreadId ?? "main-a", row.threadId, row.parentWorkflowId ?? null,
    row.parentThreadId ?? null, row.revision, row.document, row.createdAt ?? 500, row.createdAt ?? 500);

const rawDocument = (sql: GuidanceDb["Service"], workflowId: string) =>
  Effect.map(query(sql, "SELECT document FROM supervisor_workflow_state WHERE workflow_id=?", workflowId), ([row]) => String(row?.document));

const operationRows = (sql: GuidanceDb["Service"]) =>
  query(sql, "SELECT * FROM supervisor_workflow_operations ORDER BY operation_namespace,operation_id");

const legacyFlatDocument = (workflowId: string, threadId: string): string => JSON.stringify({workflowId, projectId: "project-a", mainThreadId: "main-a",
  threadId, parentWorkflowId: null, parentThreadId: null, revision: 7, status: "planned", objective: "A retired flat plan.", rules: [],
  steps: [{id: "old-step", blockId: null, name: "Old format", reason: "Preserve as raw data.", status: "planned", contributorThreadIds: []}],
  currentAgreementKey: null, acceptedAgreements: [], evidence: [], createdAt: 10, updatedAt: 11});

it.live("CT-WSC-01: every stored document shape decodes to the golden found or incompatible classification", () => Effect.gen(function* () {
  const fixture = yield* makeStoreFixture();
  const imported = yield* importMain(fixture);
  const nodeId = imported.plan!.nodes[0]!.kind === "step" ? (imported.plan!.nodes[0] as {nodeId: string}).nodeId : "";
  const contribution: ExternalContributionImport = {contributionId: "review:external-1", nodeId, revision: 1, state: "awaiting_result",
    summary: "An external reviewer is checking the export.", references: [{kind: "url", value: "https://reviews.example/42"}], externalRef: "review-42",
    sourceThreadId: "main-a", sourceRunId: "run-main", sourceMessageId: "message-1"};
  assert.equal((yield* guidanceTransaction(fixture.sql)(fixture.workflows.recordContribution(fixture.owner, contribution, 200))).status, "applied");
  const main = (yield* fixture.workflows.get("project-a", "main-a"))!;
  const mainRaw = yield* rawDocument(fixture.sql, main.workflowId);
  const stored = JSON.parse(mainRaw) as Record<string, unknown>;
  assert.equal((stored.contributions as unknown[]).length, 1);

  // a real draft written by the store for a second main
  const ownerB = yield* ownerFor(fixture.supervisors, "main-b");
  const draft = yield* fixture.workflows.ensureMain(ownerB, "draft-b", "Start a draft.", 300);
  assert.equal(draft.status, "created");
  const draftStored = JSON.parse(yield* rawDocument(fixture.sql, (yield* fixture.workflows.get("project-a", "main-b"))!.workflowId)) as Record<string, unknown>;
  assert.equal(draftStored.plan, null);
  assert.equal(draftStored.sourceBinding, null);

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

  // golden classification recorded from the unchanged source
  const golden: Array<[string, "found" | "incompatible", number | null]> = [
    ["without-contributions", "found", null],
    ["extra-top-level-field", "found", null],
    ["revision-zero", "found", null],
    ["linked-child-draft", "found", null],
    ["not-json", "incompatible", null],
    ["json-array", "incompatible", null],
    ["legacy-flat", "incompatible", null],
    ["format-version-1", "incompatible", 1],
    ["format-version-3", "incompatible", 3],
    ["format-version-string", "incompatible", null],
    ["revision-column-mismatch", "incompatible", 2],
    ["workflow-id-column-mismatch", "incompatible", 2],
    ["negative-revision", "incompatible", 2],
    ["unknown-status", "incompatible", 2],
    ["unknown-evidence-kind", "incompatible", 2],
    ["missing-evidence", "incompatible", 2],
    ["contributions-null", "incompatible", 2],
    ["contribution-entry-invalid", "incompatible", 2],
    ["empty-plan-group", "incompatible", 2],
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

  // the store's own rows are found exactly as stored
  assert.deepEqual(yield* fixture.workflows.getState("project-a", "main-a"), {status: "found", document: stored});
  assert.deepEqual(yield* fixture.workflows.getState("project-a", "main-b"), {status: "found", document: draftStored});
  const listed = yield* fixture.workflows.listResult("project-a", "main-a");
  assert.deepEqual(listed.documents.map(document => document.workflowId).sort(),
    [main.workflowId, "wsc-extra-top-level-field", "wsc-revision-zero", "wsc-without-contributions"].sort());
  assert.deepEqual(listed.incompatible.map(item => [item.workflowId, item.formatVersion]).sort(),
    golden.filter(([label, status]) => status === "incompatible" && label !== "linked-child-draft")
      .map(([label, , formatVersion]) => [`wsc-${label}`, formatVersion]).sort());
  assert.deepEqual((yield* fixture.workflows.listResult("project-a", "main-b")).documents.map(document => document.workflowId).sort(),
    [draftStored.workflowId, "wsc-linked-child-draft"].sort());
  for (const [, row] of rows) assert.equal(yield* rawDocument(fixture.sql, row.workflowId), row.document, "classification never rewrites a row");
}), {timeout: 10_000});

it.live("CT-WSS-01: a failure after the CAS update and before the operation insert rolls the document revision back", () => Effect.gen(function* () {
  const updates: number[] = [];
  let watching = false;
  // once watched, the CAS update reports its new revision when it changed the row, from outside the transaction it runs in
  const fixture = yield* makeStoreFixture((statement) => statement.startsWith("UPDATE supervisor_workflow_state ")
    ? (params, rows) => {if (watching && (rows as ReadonlyArray<unknown>).length > 0) updates.push(Number(params[0]));} : undefined);
  const current = yield* importMain(fixture);
  const before = {document: yield* rawDocument(fixture.sql, current.workflowId), operations: yield* operationRows(fixture.sql)};
  watching = true;
  yield* execute(fixture.sql, "CREATE TEMP TRIGGER ct_wss_01_operation BEFORE INSERT ON supervisor_workflow_operations BEGIN SELECT RAISE(ABORT, 'ct_wss_01_operation_insert_failed'); END;");
  const input = applyInput(fixture, current, appendLocal(current, "after-cas"), "cas-then-fail");

  // the driver's text stays out of the typed store error (s6d contract: SqlError is mapped, never leaked raw)
  const failed = yield* Effect.flip(fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 300));
  assert.ok(failed instanceof WorkflowStateStoreError);
  assert.equal(failed.reason, "workflow_store_unavailable");
  assert.deepEqual(updates, [current.revision + 1], "the CAS UPDATE ran before the operation insert failed");
  assert.equal(yield* inTransaction(fixture.sql), false);
  assert.equal(yield* rawDocument(fixture.sql, current.workflowId), before.document);
  assert.equal((yield* fixture.workflows.get("project-a", "main-a"))?.revision, current.revision);
  assert.deepEqual(yield* operationRows(fixture.sql), before.operations);

  // joined into a caller's transaction, the same failure fails the caller and leaves nothing either
  const joined = yield* Effect.exit(guidanceTransaction(fixture.sql)(fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 350)));
  assert.ok(Exit.isFailure(joined));
  assert.deepEqual(updates, [current.revision + 1, current.revision + 1], "the joined CAS UPDATE also ran before the operation insert failed");
  assert.equal(yield* rawDocument(fixture.sql, current.workflowId), before.document);
  assert.deepEqual(yield* operationRows(fixture.sql), before.operations);

  // nothing was reserved: the identical request applies once the failure is removed
  yield* execute(fixture.sql, "DROP TRIGGER temp.ct_wss_01_operation");
  const applied = yield* fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 400);
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal((yield* fixture.workflows.get("project-a", "main-a"))?.revision, current.revision + 1);
  assert.equal((yield* operationRows(fixture.sql)).length, before.operations.length + 1);
}), {timeout: 10_000});

// controller fixture: a ready binding, an inferred task with a source-bound proposal and fake native reads (copied from test/workflow-write-controller.test.ts)
type ControllerFixture = {
  sql: GuidanceDb["Service"];
  supervisors: ProjectSupervisorStore["Service"];
  workflows: WorkflowStateStore["Service"];
  controller: WorkflowWriteController["Service"];
  binding: BindingRecord;
  projectId: string;
  mainThreadId: string;
  supervisorThreadId: string;
  projection: Projection;
  details: Map<string, unknown>;
  proposal: WorkflowProposalInfo;
  sourceBinding: WorkflowSourceBindingInfo;
  listThreadsGate: {waiting: number; arrived: number; open: Deferred.Deferred<void> | null};
};

const thread = (id: string, projectId: string): ThreadInfo => ({id, title: id, projectId, archivedAt: null, deletedAt: null,
  lineage: {parentThreadId: null, relationshipToParent: null}});

const localStep = (name: string, description: string) => ({
  kind: "step" as const,
  definitionId: null,
  localId: name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, ""),
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

// the production write controller over the production scope predicates, admission gate, thread policy and stores of one temp-file
// run (without the team store's authority, as the baseline controller without a team); the native reads and the definitions
// are small effect fakes
const makeControllerFixture = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("workflow-state-characterization-controller-");
  const stores = yield* openWorkflowStores(directory);
  const {sql, supervisors, workflows} = stores;
  const projectId = "project-workflows";
  const mainThreadId = "main-workflows";
  for (const scope of [null, projectId]) yield* execute(sql, "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    `supervisor_control:${JSON.stringify(scope)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const reserved = yield* supervisors.reserve(projectId, mainThreadId, "Main thread", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  yield* supervisors.setBinding(binding);
  const supervisorThreadId = binding.threadId;
  const definitions: ProjectDefinitionSnapshot = {projectId, threadId: mainThreadId, workspaceRoot: "/workspace/project-workflows", globalOnly: false,
    globalRevision: null, revision: "definition-revision-1", editingAvailable: true, status: "ready", steps: [], workflows: [],
    config: effectiveIndex({steps: [], workflows: []}), projectConfig: projectIndex(), definitionFiles: [], complete: true, sources: [], issues: []};
  const definitionContext = proposalContextFromDefinitions(definitions);
  const normalized = validateWorkflowPlan({requirements: [], plan: sequencePlan([localStep("Baseline review", "Review the current task context.")])}, definitionContext);
  if (!normalized?.plan) throw new Error("test_workflow_proposal_invalid");
  const proposal: WorkflowProposalInfo = {status: "proposed", message: "A source-bound workflow proposal for this task.",
    workspaceRoot: definitions.workspaceRoot, revision: definitions.revision, globalRevision: null, definitionsStatus: "ready",
    definitionsComplete: true, requirementsKnown: true, requirements: normalized.requirements, issues: normalized.issues, plan: normalized.plan};
  const sourceHash = fingerprint("Complete the current project task.");
  const task: TaskRecord = {id: "task-current", threadId: mainThreadId, projectId, sourceRunId: "source-run-current", sourceMessageId: "source-message-current",
    status: "inferred", objective: "Complete the current project task.", reason: "The latest user message describes an actionable task.",
    updatedAt: yield* Clock.currentTimeMillis, workflow: proposal, agreement: null, workflowProposalId: "proposal-current", sourceHash,
    requestText: "Complete the current project task.", supervisorThreadId, messageId: "source-message-current", dispatchedAt: null, replayCount: 0,
    supervisorRunId: "source-run-current", sourceOrdinal: 1, definitionContext, definitionSnapshot: definitions};
  yield* supervisors.saveTask(task);
  const threads = [thread(mainThreadId, projectId), thread(supervisorThreadId, projectId)];
  const projection: Projection = {thread: thread(supervisorThreadId, projectId), runs: [], messages: [], nodes: [], turnItems: []};
  const details = new Map<string, unknown>();
  // listThreads can hold its callers until a given number arrived, so concurrent writes reach their commit together
  const listThreadsGate: ControllerFixture["listThreadsGate"] = {waiting: 0, arrived: 0, open: null};
  const native = WorkflowNativeAccess.of({
    listThreads: () => Effect.gen(function* () {
      const open = listThreadsGate.open;
      if (open) {
        listThreadsGate.arrived++;
        if (listThreadsGate.arrived >= listThreadsGate.waiting) yield* Deferred.succeed(open, undefined);
        yield* Deferred.await(open);
      }
      return threads;
    }),
    projection: (id) => id === supervisorThreadId ? Effect.succeed(projection) : Effect.die(new Error("unexpected_projection")),
    getTurnItem: ({itemId}) => Effect.succeed({item: details.get(itemId) ?? null}),
  });
  // only the fresh pin read of the definitions is used
  const loader = {load: () => Effect.succeed(definitions)} as unknown as ProjectDefinitions["Service"];
  const run = yield* Layer.build(WorkflowWriteController.layer({withoutTeam: true, maxEvidenceWaitMs: 0}).pipe(
    Layer.provideMerge(admissionLayer(true)),
    Layer.provideMerge(SupervisorTeamStore.layer),
    Layer.provide(Layer.mergeAll(Layer.succeedContext(stores.context), policyClient(directory), runConfig(directory),
      Layer.succeed(WorkflowNativeAccess, native), Layer.succeed(ProjectDefinitions, loader))),
  )).pipe(Effect.orDie);
  // the run has read the catalog's classifications, as every supervision cycle does before workflow editing is enabled
  yield* Context.get(run, SupervisionScopeService).rememberScratchProjects([{id: projectId, workspaceRoot: definitions.workspaceRoot}]).pipe(Effect.orDie);
  const fixture: ControllerFixture = {sql, supervisors, workflows, controller: Context.get(run, WorkflowWriteController), binding, projectId, mainThreadId,
    supervisorThreadId, projection, details, proposal, sourceBinding: {workspaceRoot: definitions.workspaceRoot, revision: definitions.revision, globalRevision: null,
      definitionsStatus: "ready", definitionsComplete: true, requirementsKnown: true, taskId: "task-current", proposalId: "proposal-current", sourceHash}, listThreadsGate};
  return fixture;
});

// installs one completed native tool item per argument set in the same completed Supervisor run
const installEvidence = (fixture: ControllerFixture, argumentSets: ReadonlyArray<Record<string, unknown>>): string[] => {
  const runId = "supervisor-run-current";
  const providerThreadId = "provider-thread-current";
  const rootNodeId = "supervisor-root";
  fixture.projection.runs = [{id: runId, ordinal: 1, status: "completed", requestedAt: "2026-10-14T00:00:00.000Z",
    startedAt: "2026-10-14T00:00:00.000Z", completedAt: "2026-10-14T00:00:01.000Z", rootNodeId, threadId: fixture.supervisorThreadId, providerThreadId}];
  const nodes: Array<Record<string, unknown>> = [{id: rootNodeId, kind: "root_turn", threadId: fixture.supervisorThreadId, runId, rootNodeId,
    providerThreadId, parentNodeId: null, status: "completed"}];
  const turnItems: NonNullable<Projection["turnItems"]> = [];
  const itemIds = argumentSets.map(args => {
    const index = fixture.details.size + 1;
    const itemId = `workflow-tool-${index}`;
    const nodeId = `node-${itemId}`;
    const toolName = workflowToolNames.write.direct[0];
    fixture.details.set(itemId, {id: itemId, type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId, nodeId, providerThreadId,
      providerTurnId: "provider-turn-current", nativeItemRef: {driver: "codex", nativeId: `native-${itemId}`, strength: "strong"}, parentItemId: null,
      ordinal: 100 + index, status: "completed", toolNonExecutionKind: null, toolName, input: args});
    nodes.push({id: nodeId, kind: "dynamic_tool", threadId: fixture.supervisorThreadId, runId, rootNodeId, providerThreadId,
      parentNodeId: rootNodeId, status: "completed"});
    turnItems.push({id: itemId, type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId, nodeId, providerThreadId,
      parentItemId: null, ordinal: 100 + index, status: "completed", toolName, input: "snapshot-summary"});
    return itemId;
  });
  fixture.projection.nodes = nodes;
  fixture.projection.turnItems = turnItems;
  return itemIds;
};

const controllerApplyArgs = (fixture: ControllerFixture, input: WorkflowApplyPatch) => ({
  action: "apply",
  supervisorThreadId: fixture.supervisorThreadId,
  bindingGeneration: fixture.binding.generation,
  input: {sourceBinding: fixture.sourceBinding, requirements: fixture.proposal.requirements, issues: fixture.proposal.issues, ...input},
});

it.live("CT-WSS-02: concurrent applies at one expected revision yield one applied and one revision conflict, and an identical operation ID writes once", () => Effect.gen(function* () {
  // controller: two real write() calls interleave across their native awaits and both reach the commit
  const fixture = yield* makeControllerFixture;
  const ensure = {action: "ensure_main", supervisorThreadId: fixture.supervisorThreadId, bindingGeneration: fixture.binding.generation,
    operationId: "concurrent-create", note: "Create a workflow before the concurrent edits."};
  installEvidence(fixture, [ensure]);
  const created = yield* fixture.controller.write(ensure);
  assert.equal(created.status, "created");
  if (created.status !== "created") return;
  const edit = (operationId: string, name: string) => controllerApplyArgs(fixture, {operationId, workflowId: created.workflowId,
    expectedRevision: created.revision, status: "planned", objective: "Track the export workflow.",
    plan: sequencePlan([localStep(name, `Complete ${name}.`)]), note: `Add ${name}.`});
  const first = edit("concurrent-a", "First edit");
  const second = edit("concurrent-b", "Second edit");
  const [firstItem, secondItem] = installEvidence(fixture, [first, second]);
  fixture.listThreadsGate.waiting = 2;
  fixture.listThreadsGate.open = yield* Deferred.make<void>();
  const results = yield* Effect.all([fixture.controller.write(first), fixture.controller.write(second)], {concurrency: "unbounded"});
  fixture.listThreadsGate.open = null;
  assert.equal(fixture.listThreadsGate.arrived, 2, "both writes passed evidence verification before either committed");

  const applied = results.filter(result => result.status === "applied");
  const conflicts = results.filter(result => result.status === "conflict");
  assert.equal(applied.length, 1, JSON.stringify(results));
  assert.equal(conflicts.length, 1, JSON.stringify(results));
  const winner = applied[0]!;
  const loser = conflicts[0]!;
  assert.ok(winner.status === "applied" && loser.status === "conflict");
  assert.equal(winner.revision, created.revision + 1);
  assert.deepEqual(loser, {status: "conflict", operationId: loser.operationId, reason: "revision", currentRevision: created.revision + 1});
  const winnerName = winner.operationId === "concurrent-a" ? "First edit" : "Second edit";
  const document = (yield* fixture.workflows.get(fixture.projectId, fixture.mainThreadId))!;
  assert.equal(document.revision, created.revision + 1);
  assert.deepEqual(document.plan!.nodes.map(node => "name" in node ? node.name : null), [winnerName]);
  assert.equal(winner.stateHash, sha256(yield* rawDocument(fixture.sql, created.workflowId)));
  const receipts = (yield* query(fixture.sql, "SELECT operation_id FROM supervisor_workflow_write_receipts ORDER BY operation_id")).map(row => row.operation_id);
  assert.deepEqual(receipts, ["concurrent-create", winner.operationId].sort());
  const operations = (yield* query(fixture.sql, "SELECT operation_id FROM supervisor_workflow_operations ORDER BY operation_id")).map(row => row.operation_id);
  assert.deepEqual(operations, ["concurrent-create", winner.operationId].sort());
  // the losing native item is bound to its unsuccessful outcome
  const evidence = (yield* query(fixture.sql, "SELECT item_id,operation_id,successful,result FROM supervisor_workflow_write_evidence WHERE item_id IN (?,?) ORDER BY item_id",
    firstItem!, secondItem!)).map(row => [row.operation_id, row.successful, JSON.parse(String(row.result))]);
  assert.deepEqual(evidence.sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    [[winner.operationId, 1, winner], [loser.operationId, 0, loser]].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));

  // store: sequential applies with an identical operation ID write once and replay the identical receipt; a stale revision conflicts
  const store = yield* makeStoreFixture();
  const current = yield* importMain(store);
  const input = applyInput(store, current, appendLocal(current, "once"), "same-op");
  const once = yield* store.workflows.apply(store.owner, input, validationFor(store), 300);
  assert.equal(once.status, "applied", JSON.stringify(once));
  const afterOnce = {document: yield* rawDocument(store.sql, current.workflowId), operations: yield* operationRows(store.sql)};
  const twice = yield* store.workflows.apply(store.owner, input, validationFor(store), 400);
  assert.deepEqual(twice, once);
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
  assert.equal(yield* rawDocument(store.sql, current.workflowId), afterOnce.document);
  assert.deepEqual(yield* operationRows(store.sql), afterOnce.operations);
  const stale = yield* store.workflows.apply(store.owner, applyInput(store, current, appendLocal(current, "stale"), "other-op"), validationFor(store), 500);
  assert.deepEqual(stale, {status: "conflict", operationId: "other-op", reason: "revision", currentRevision: current.revision + 1});
  assert.equal(yield* rawDocument(store.sql, current.workflowId), afterOnce.document);
  assert.deepEqual(yield* operationRows(store.sql), afterOnce.operations);

  // store: concurrent applies at one expected revision yield one applied and one revision conflict, and the same operation ID
  // from two fibers writes once and both receive the identical receipt
  {
    const fixture = yield* makeStoreFixture();
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
  }
}), {timeout: 10_000});

it.live("CT-WSS-03: receipts and incompatible rows survive reopen and an exact replay returns the byte-identical receipt", () => Effect.gen(function* () {
  const fixture = yield* makeStoreFixture();
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
  yield* execute(fixture.sql, "INSERT INTO supervisor_workflow_operations(project_id,main_thread_id,actor_thread_id,binding_generation,operation_namespace,operation_id,request_hash,result,workflow_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    fixture.owner.projectId, fixture.owner.mainThreadId, fixture.owner.supervisorThreadId, fixture.owner.bindingGeneration, "edit", "legacy-replay",
    fingerprint(canonical({kind: "ensure-main", owner: fixture.owner, note: "Start a draft."})), legacyResult, legacyId, 12);
  const before = {document: yield* rawDocument(fixture.sql, current.workflowId), operations: yield* operationRows(fixture.sql)};
  const storedResult = String((yield* query(fixture.sql, "SELECT result FROM supervisor_workflow_operations WHERE operation_id=?", "durable-apply"))[0]?.result);
  assert.equal(storedResult, JSON.stringify(receipt));

  yield* reopen(fixture);
  const replay = yield* fixture.workflows.apply(fixture.owner, input, validationFor(fixture), 900);
  assert.equal(JSON.stringify(replay), storedResult, "the replay is the stored receipt byte for byte");
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
}), {timeout: 10_000});

// a draft shaped exactly as ensureMainInTransaction stores it, with fixed identities and times
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

it.live("CT-WSS-04: golden stateHash and receipt for a fixture document", () => Effect.gen(function* () {
  const fixture = yield* makeStoreFixture();
  // the golden literal has the key order and value types of a draft the store writes
  const real = yield* fixture.workflows.ensureMain(fixture.owner, "real-ensure", "Start a golden draft.", 1000);
  assert.equal(real.status, "created");
  if (real.status !== "created") return;
  const realStored = JSON.parse(yield* rawDocument(fixture.sql, real.workflowId)) as Record<string, unknown>;
  assert.deepEqual(keyShape(goldenDraft), keyShape(realStored));
  assert.equal(real.stateHash, sha256(yield* rawDocument(fixture.sql, real.workflowId)));
  yield* execute(fixture.sql, "DELETE FROM supervisor_workflow_state WHERE workflow_id=?", real.workflowId);

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
  yield* execute(fixture.sql, "UPDATE supervisor_workflow_state SET document=? WHERE workflow_id=?", JSON.stringify(withoutContributions), goldenDraft.workflowId);
  const legacyExists = yield* fixture.workflows.ensureMain(fixture.owner, "golden-exists-legacy", "Start a golden draft.", 2000);
  assert.equal(legacyExists.status === "exists" ? legacyExists.stateHash : null, goldenDraftWithoutContributionsStateHash);
  assert.equal(fingerprint({...withoutContributions, contributions: []}), goldenDraftWithoutContributionsStateHash);
  assert.notEqual(goldenDraftWithoutContributionsStateHash, goldenDraftStateHash);
  yield* execute(fixture.sql, "UPDATE supervisor_workflow_state SET document=? WHERE workflow_id=?", text, goldenDraft.workflowId);

  // an applied receipt is stored with a fixed key order and the sha256 of the stored document text as its stateHash
  const draft = (yield* fixture.workflows.get("project-a", "main-a"))!;
  const applied = yield* fixture.workflows.apply(fixture.owner, applyInput(fixture, draft, fixture.proposal.plan, "golden-apply"), validationFor(fixture), 3000);
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  const storedDocument = yield* rawDocument(fixture.sql, goldenDraft.workflowId);
  const storedReceipt = String((yield* query(fixture.sql, "SELECT result FROM supervisor_workflow_operations WHERE operation_id=?", "golden-apply"))[0]?.result);
  assert.equal(storedReceipt,
    `{"status":"applied","operationId":"golden-apply","workflowId":"golden-workflow","revision":2,"stateHash":"${sha256(storedDocument)}","formatVersion":2}`);
  assert.equal(JSON.stringify(applied), storedReceipt);
  assert.equal(fingerprint(yield* fixture.workflows.get("project-a", "main-a")), sha256(storedDocument));
}), {timeout: 10_000});
