import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { guidanceTransaction } from "../src/guidance-sql.js";
import { fingerprint } from "../src/guidance-store.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import type { WorkflowPlanGroupInfo, WorkflowProposalInfo } from "../src/project-supervisor-contract.js";
import { defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { proposalContextFromDefinitions, seededNodeIds, validateWorkflowPlan } from "../src/supervisor-workflow.js";
import {
  ExternalContributionRecordSchema,
  externalContributionLimits,
  WorkflowMutationReceiptSchema,
  WorkflowStateDocumentSchema,
  type WorkflowOwner,
  type WorkflowStateDocument,
} from "../src/workflow-state-contract.js";
import { parseExternalContributionRecord } from "../src/workflow-state-store.js";
import { effectiveIndex, projectIndex } from "./project-definitions-fixture.js";
import { execute, openWorkflowStores, query, temporaryDirectory } from "./support/g12-stores.js";

// live Effect tests: the stores write a real guidance.sqlite3 in a temporary directory; nothing here waits on time

const decodeDocument = Schema.decodeUnknownExit(Schema.fromJsonString(WorkflowStateDocumentSchema));
const decodeReceipt = Schema.decodeUnknownExit(Schema.fromJsonString(WorkflowMutationReceiptSchema));
const decodeRecord = Schema.decodeUnknownExit(ExternalContributionRecordSchema);
const sourceHash = fingerprint("Prepare the export workflow.");

const definitions: ProjectDefinitionSnapshot = {projectId: "project-a", threadId: "main-a", workspaceRoot: "/workspace/project-a", globalOnly: false,
  globalRevision: null, revision: "definition-revision-a", editingAvailable: true, status: "ready", steps: [], workflows: [],
  config: effectiveIndex({steps: [], workflows: []}), projectConfig: projectIndex(), definitionFiles: [], complete: true, sources: [], issues: []};

const localPlan = (ids: readonly string[], nodeIds = seededNodeIds("schema")): WorkflowPlanGroupInfo => ({kind: "sequence", templatePath: null, nodes: ids.map(id => ({
  kind: "step", nodeId: nodeIds(), definitionId: null, localId: id, templatePath: null, name: `Local ${id}`,
  description: `Complete local task ${id}.`, source: null, resolution: "resolved", reason: `This task adds ${id}.`, status: "planned", contributorThreadIds: []}))});

// a temp-file guidance database with ready bindings for main-a and main-b, closed and removed with the test scope
const storeFixture = Effect.gen(function* () {
  const {sql, supervisors, workflows} = yield* openWorkflowStores(yield* temporaryDirectory("workflow-state-schema-"));
  yield* execute(sql, "INSERT INTO meta VALUES(?,?)", `supervisor_control:${JSON.stringify("project-a")}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const owner = (mainThreadId: string) => Effect.gen(function* () {
    const binding = {...(yield* supervisors.reserve("project-a", mainThreadId, "Main conversation", defaultSupervisorModel, 1, 1)), state: "ready" as const};
    yield* supervisors.setBinding(binding);
    return {projectId: "project-a", mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation} satisfies WorkflowOwner;
  });
  return {sql, transaction: guidanceTransaction(sql), workflows, ownerA: yield* owner("main-a"), ownerB: yield* owner("main-b")};
});

it.live("documents and receipts written by the store decode with the stored-shape schemas", () => Effect.gen(function* () {
  const {sql, transaction, workflows, ownerA, ownerB} = yield* storeFixture;
  const plan = validateWorkflowPlan({requirements: [], plan: localPlan(["local-a", "local-b"])}, proposalContextFromDefinitions(definitions), seededNodeIds("plan"));
  assert.ok(plan);
  const proposal = {status: "proposed", message: "A source-bound draft plan.", workspaceRoot: definitions.workspaceRoot, revision: definitions.revision,
    globalRevision: null, ...plan} as WorkflowProposalInfo;
  const imported = yield* transaction(workflows.importAcceptedAgreement(ownerA, {taskId: "task-a", sourceThreadId: "main-a",
    sourceRunId: "run-a", sourceMessageId: "message-a", sourceHash, objective: "Prepare the export workflow.", agreement: {status: "agreed",
      message: "The complete workflow was echoed by the operative assistant.", proposalId: "proposal-a", agreedAt: 123,
      supervisorMessageId: "supervisor-message-a", agentMessageId: "agent-message-a", workflow: proposal}}, 100));
  assert.equal(imported.status, "applied");
  const main = (yield* workflows.get("project-a", "main-a"))!;
  const nodeId = (main.plan!.nodes[0] as {nodeId: string}).nodeId;
  assert.equal((yield* transaction(workflows.recordContribution(ownerA, {contributionId: "review:external-1", nodeId, revision: 1,
    state: "result", summary: "An external reviewer checked the export.", references: [{kind: "url", value: "https://reviews.example/42"}],
    externalRef: "review-42", sourceThreadId: "main-a", sourceRunId: "run-main", sourceMessageId: "message-1"}, 200))).status, "applied");
  const recorded = (yield* workflows.get("project-a", "main-a"))!;
  assert.equal((yield* transaction(workflows.assessContribution(ownerA, {operationId: "assess-1", workflowId: recorded.workflowId,
    expectedRevision: recorded.revision, contributionId: "review:external-1", resultRevision: 1, decision: "accepted", note: "The review covers the export."},
  300))).status, "applied");
  assert.equal((yield* workflows.ensureMain(ownerB, "draft-b", "Start a draft.", 400)).status, "created");

  const rows = (yield* query(sql, "SELECT document FROM supervisor_workflow_state ORDER BY created_at")).map(row => String(row.document));
  assert.equal(rows.length, 2);
  for (const raw of rows) {
    const decoded = decodeDocument(raw);
    assert.ok(Exit.isSuccess(decoded), raw.slice(0, 80));
    assert.deepEqual(decoded.value, JSON.parse(raw), "a stored document decodes without losing or adding a field");
  }
  const stored = JSON.parse(rows[0]!) as WorkflowStateDocument;
  assert.equal(stored.contributions[0]?.assessment?.decision, "accepted");
  assert.ok(stored.evidence.some(item => item.contribution !== undefined));
  assert.ok(stored.acceptedAgreements.length === 1);

  const receipts = (yield* query(sql, "SELECT result FROM supervisor_workflow_operations")).map(row => String(row.result));
  assert.ok(receipts.length >= 2);
  for (const raw of receipts) {
    const decoded = decodeReceipt(raw);
    assert.ok(Exit.isSuccess(decoded), raw);
    assert.deepEqual(decoded.value, JSON.parse(raw));
  }
}), {timeout: 10_000});

it.live("the document schema covers the structural incompatibilities and leaves identity and plan rules to the store", () => Effect.gen(function* () {
  const {sql, workflows, ownerA} = yield* storeFixture;
  assert.equal((yield* workflows.ensureMain(ownerA, "draft-a", "Start a draft.", 100)).status, "created");
  const base = JSON.parse(String((yield* query(sql, "SELECT document FROM supervisor_workflow_state"))[0]?.document)) as Record<string, unknown>;
  const variant = (change: (document: Record<string, unknown>) => void): string => {
    const document = structuredClone(base);
    change(document);
    return JSON.stringify(document);
  };
  const decodes = (raw: string): boolean => Exit.isSuccess(decodeDocument(raw));

  const withoutContributions = decodeDocument(variant(document => {delete document.contributions;}));
  assert.ok(Exit.isSuccess(withoutContributions));
  assert.deepEqual(withoutContributions.value.contributions, [], "an older row reads with no contributions");
  // unknown top-level fields are accepted but not part of the decoded value; the row stays the source of hashes and returned documents
  const extra = decodeDocument(variant(document => {document.futureField = {kept: true};}));
  assert.ok(Exit.isSuccess(extra));
  assert.equal(Object.hasOwn(extra.value, "futureField"), false);

  for (const [label, raw] of [
    ["not json", "{not json"],
    ["json array", "[]"],
    ["format version 1", variant(document => {document.formatVersion = 1;})],
    ["format version string", variant(document => {document.formatVersion = "2";})],
    ["unknown status", variant(document => {document.status = "done";})],
    ["unknown evidence kind", variant(document => {(document.evidence as Array<Record<string, unknown>>)[0]!.kind = "imported";})],
    ["missing evidence", variant(document => {delete document.evidence;})],
    ["null contributions", variant(document => {document.contributions = null;})],
    ["invalid contribution", variant(document => {document.contributions = [{}];})],
  ] as Array<[string, string]>) assert.equal(decodes(raw), false, label);
  // these rows are incompatible today through column, range and plan checks that run after decode
  for (const [label, raw] of [
    ["negative revision", variant(document => {document.revision = -1;})],
    ["empty plan group", variant(document => {document.plan = {kind: "sequence", templatePath: null, nodes: []};})],
    ["empty workflow id", variant(document => {document.workflowId = "";})],
  ] as Array<[string, string]>) assert.equal(decodes(raw), true, label);
}), {timeout: 10_000});

it("contribution records decode exactly where the store parser accepts them", {timeout: 10_000}, () => {
  const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({taskId: "task-a", contributionId: "review:external-1",
    nodeId: "node-1", revision: 1, state: "result", summary: "Checked.", references: [{kind: "url", value: "https://reviews.example/42"}],
    externalRef: "review-42", ...overrides});
  const exact = (value: unknown) => Exit.isSuccess(decodeRecord(value, {onExcessProperty: "error"}));
  const missing = record();
  delete missing.externalRef;
  const cases: Array<[string, unknown]> = [
    ["valid", record()],
    ["empty lists", record({references: [], externalRef: null, summary: ""})],
    ["at caps", record({summary: "s".repeat(externalContributionLimits.maxSummaryLength), externalRef: "r".repeat(200)})],
    ["missing field", missing],
    ["extra field", record({mainThreadId: "main-a"})],
    ["array", [record()]],
    ["null", null],
    ["string revision", record({revision: "1"})],
    ["unknown state", record({state: "done"})],
    ["non-string summary", record({summary: null})],
    ["reference kind", record({references: [{kind: "link", value: "x"}]})],
    ["references object", record({references: {kind: "text", value: "x"}})],
    ["numeric node ID", record({nodeId: 7})],
    ["numeric external ref", record({externalRef: 7})],
  ];
  for (const [label, value] of cases) {
    if (parseExternalContributionRecord(value)) assert.ok(exact(value), `${label}: the schema never rejects an accepted record`);
  }
  assert.deepEqual(cases.filter(([, value]) => exact(value)).map(([label]) => label), ["valid", "empty lists", "at caps"]);
  // value bounds stay with the parser after decode
  for (const value of [record({revision: 0}), record({summary: "s".repeat(2001)}), record({contributionId: "two words"}), record({taskId: ""})]) {
    assert.ok(exact(value));
    assert.equal(parseExternalContributionRecord(value), null);
  }
});
