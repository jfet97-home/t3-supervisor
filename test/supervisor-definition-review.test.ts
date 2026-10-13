import assert from "node:assert/strict";
import test from "node:test";
import { fingerprint } from "../src/guidance-store.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { buildProjectDefinitionReviewRequest, extractApprovedProjectDefinitions, extractProjectDefinitionDecisionRecords, parseProjectDefinitionDecisionRecord } from "../src/supervisor-definition-review.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import type { Projection } from "../src/types.js";
import { prepareWorkflowRequest } from "../src/supervisor-workflow.js";

const projectId = "project-a";
const operativeThreadId = "operative-thread";
const supervisorThreadId = "supervisor-thread";
const sourceText = "Add a carefully bounded feature.";
const userText = "Please update the project's required checks for this feature.";
const root = "/workspace/project";
const oldRevision = "a".repeat(64);
const newRevision = "b".repeat(64);
const definitions = (overrides: Partial<ProjectDefinitionSnapshot> = {}): ProjectDefinitionSnapshot => ({
  projectId,
  threadId: operativeThreadId,
  workspaceRoot: root,
  revision: oldRevision,
  editingAvailable: true,
  status: "ready",
  rules: [{name: "Required verification", description: "Verify behavior.", required_blocks: ["verify"]}],
  blocks: [{id: "verify", name: "Verification", description: "Verify the change.", instructions: "Run the focused checks.", expected_result: "All checks pass."}],
  issues: [],
  ...overrides,
});

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => {
  const approved = definitions();
  const prepared = prepareWorkflowRequest(operativeThreadId, "source-0", sourceText, approved);
  assert.ok(prepared.context);
  return {
    threadId: operativeThreadId,
    projectId,
    sourceRunId: "operative-run-1",
    sourceMessageId: "source-0",
    status: "inferred",
    objective: "Add a carefully bounded feature.",
    reason: "The user requested a concrete feature.",
    updatedAt: 100,
    workflow: {status: "proposed", message: "Draft.", workspaceRoot: root, revision: oldRevision,
      rules: [{index: 0, name: "Required verification", applies: true, reason: "The task changes behavior."}],
      steps: [{blockId: "verify", name: "Verification", reason: "Check the change."}]},
    id: "task-1",
    sourceHash: fingerprint(sourceText),
    requestText: prepared.requestText,
    supervisorThreadId,
    messageId: "supervisor-request-1",
    dispatchedAt: 100,
    replayCount: 0,
    supervisorRunId: "supervisor-run-1",
    sourceOrdinal: 1,
    definitionContext: prepared.context,
    definitionSnapshot: approved,
    ...overrides,
  };
};

type UserFixture = {id: string; text: string; runStatus?: string; nodeKind?: string; nodeStatus?: string; streaming?: boolean;
  createdBy?: string; creationSource?: string; senderThreadId?: string | null; scheduledTaskId?: string | null; source?: string | null};

const agentProjection = (users: UserFixture[] = [{id: "user-1", text: userText}]): Projection => {
  const messages = [{id: "source-0", runId: "operative-run-1", nodeId: "source-node", role: "user", text: sourceText, streaming: false,
    createdAt: "2026-10-13T10:00:00.000Z", updatedAt: "2026-10-13T10:00:00.000Z", createdBy: "user", creationSource: "web", threadId: operativeThreadId},
  ...users.map((user, index) => ({id: user.id, runId: `operative-run-${index + 2}`, nodeId: `user-node-${user.id}`, role: "user", text: user.text,
    streaming: user.streaming ?? false, createdAt: `2026-10-13T10:${String(index + 1).padStart(2, "0")}:00.000Z`, updatedAt: "2026-10-13T10:30:00.000Z",
    createdBy: user.createdBy ?? "user", creationSource: user.creationSource ?? "web", senderThreadId: user.senderThreadId,
    scheduledTaskId: user.scheduledTaskId, source: user.source, threadId: operativeThreadId}))];
  const runs = [
    {id: "operative-run-1", threadId: operativeThreadId, ordinal: 1, status: "completed", requestedAt: "2026-10-13T10:00:00.000Z",
      startedAt: "2026-10-13T10:00:00.000Z", completedAt: "2026-10-13T10:00:30.000Z", rootNodeId: "root-operative-run-1", providerThreadId: "provider"},
    ...users.map((user, index) => ({id: `operative-run-${index + 2}`, threadId: operativeThreadId, ordinal: index + 2,
      status: user.runStatus ?? "running", requestedAt: "2026-10-13T10:01:00.000Z", startedAt: "2026-10-13T10:01:00.000Z",
      completedAt: null, rootNodeId: `root-operative-run-${index + 2}`, providerThreadId: "provider"})),
  ];
  const nodes = runs.flatMap((run, index) => {
    const messageId = index === 0 ? "source-0" : users[index - 1]!.id;
    const nodeId = index === 0 ? "source-node" : `user-node-${messageId}`;
    return [
      {id: run.rootNodeId!, kind: "root_turn", threadId: operativeThreadId, runId: run.id, rootNodeId: run.rootNodeId,
        providerThreadId: "provider", status: "completed", parentNodeId: null},
      {id: nodeId, kind: index === 0 ? "user_message" : users[index - 1]!.nodeKind ?? "user_message", threadId: operativeThreadId,
        runId: run.id, rootNodeId: run.rootNodeId, providerThreadId: "provider", status: index === 0 ? "completed" : users[index - 1]!.nodeStatus ?? "completed",
        parentNodeId: run.rootNodeId},
    ];
  });
  return {thread: {id: operativeThreadId, title: "Task", projectId, workspaceRoot: root,
    lineage: {parentThreadId: null, relationshipToParent: null}}, runs, messages, nodes};
};

const decisionRecord = (overrides: Record<string, unknown> = {}) => ({taskId: "task-1", expectedRevision: oldRevision, observedRevision: newRevision,
  decision: "authorized", userMessageIds: ["user-1"], reason: "The user explicitly requested these checks.", ...overrides});

const parseEnvelope = (request: string): Record<string, unknown> => {
  const start = request.indexOf("UNTRUSTED_PROJECT_DEFINITION_REVIEW_ENVELOPE\n") + "UNTRUSTED_PROJECT_DEFINITION_REVIEW_ENVELOPE\n".length;
  const end = request.indexOf("\nEND_UNTRUSTED_PROJECT_DEFINITION_REVIEW_ENVELOPE", start);
  return JSON.parse(request.slice(start, end)) as Record<string, unknown>;
};

test("approved definitions come from the stored snapshot and strict legacy workflow envelope fallback", () => {
  const current = task();
  assert.deepEqual(extractApprovedProjectDefinitions(current), definitions());

  const fallback = task({definitionSnapshot: null});
  const extracted = extractApprovedProjectDefinitions(fallback);
  assert.ok(extracted);
  assert.equal(extracted.revision, oldRevision);
  assert.deepEqual(extracted.rules, definitions().rules);
  assert.deepEqual(extracted.blocks, definitions().blocks);

  assert.equal(extractApprovedProjectDefinitions(task({definitionSnapshot: null, requestText: "partial prompt"})), null);
  assert.equal(extractApprovedProjectDefinitions(task({definitionSnapshot: null, workflow: {...current.workflow!, revision: newRevision}})), null);
});

test("decision fences are exact and bounded by message and record caps", () => {
  const content = ["```project-definition-decision", JSON.stringify(decisionRecord()), "```", "```workflow-acceptance", "{}", "```"].join("\n");
  assert.deepEqual(extractProjectDefinitionDecisionRecords(content), [decisionRecord()]);
  assert.deepEqual(extractProjectDefinitionDecisionRecords("yes"), []);
  assert.deepEqual(extractProjectDefinitionDecisionRecords("x".repeat(128_001)), []);
  const tooMany = Array.from({length: 21}, () => ["```project-definition-decision", "{}", "```"].join("\n")).join("\n");
  assert.equal(extractProjectDefinitionDecisionRecords(tooMany).length, 20);
});

test("authorized decisions require exact current revisions and completed main-graph external user messages", () => {
  const current = task();
  const agent = agentProjection();
  const parsed = parseProjectDefinitionDecisionRecord(decisionRecord(), current, definitions({revision: newRevision}), agent);
  assert.ok(parsed);
  assert.equal(parsed.decision.decision, "authorized");
  assert.deepEqual(parsed.decision.userMessageIds, ["user-1"]);
  assert.deepEqual(parsed.userTextHashes, [{messageId: "user-1", textHash: fingerprint(userText)}]);

  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({taskId: "another-task"}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({expectedRevision: newRevision}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({observedRevision: oldRevision}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({observedRevision: oldRevision}), current, definitions(), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({unexpected: true}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({reason: "r".repeat(1001)}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({userMessageIds: []}), current, definitions({revision: newRevision}), agent), null);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord(), current, definitions({status: "invalid", revision: newRevision,
    issues: [{path: ".supervisor/rules.yaml", code: "invalid_definition", message: "Incomplete rules."}]}), agent), null);
});

test("forwarded, scheduled, source-tagged, streaming, failed, and non-main user messages cannot authorize definitions", () => {
  const current = task();
  const observed = definitions({revision: newRevision});
  const rejected: UserFixture[] = [
    {id: "sender", text: userText, senderThreadId: "parent-thread"},
    {id: "scheduled", text: userText, scheduledTaskId: "schedule-1"},
    {id: "source-tagged", text: userText, source: "import"},
    {id: "assistant-authored", text: userText, createdBy: "assistant"},
    {id: "other-origin", text: userText, creationSource: "import"},
    {id: "streaming", text: userText, streaming: true},
    {id: "failed-run", text: userText, runStatus: "failed"},
    {id: "child-node", text: userText, nodeKind: "subagent"},
    {id: "incomplete-node", text: userText, nodeStatus: "running"},
  ];
  for (const user of rejected) {
    assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({userMessageIds: [user.id]}), current, observed, agentProjection([user])), null, user.id);
  }
});

test("revert decisions may cite no users and retain a null observed revision for missing definitions", () => {
  const current = task();
  const missing = definitions({status: "missing", revision: null, rules: [], blocks: [], issues: [{path: ".supervisor", code: "definitions_missing", message: "Missing."}]});
  const parsed = parseProjectDefinitionDecisionRecord(decisionRecord({observedRevision: null, decision: "revert_requested", userMessageIds: [],
    reason: "No real user message authorized these agent-authored file changes."}), current, missing, agentProjection([]));
  assert.ok(parsed);
  assert.equal(parsed.decision.observedRevision, null);
  assert.deepEqual(parsed.decision.userMessageIds, []);
  assert.deepEqual(parsed.userTextHashes, []);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({observedRevision: null, decision: "authorized", userMessageIds: ["user-1"]}),
    current, missing, agentProjection()), null);
});

test("decision reasons and review envelopes redact credentials and preserve complete definition snapshots", () => {
  const current = task();
  const observed = definitions({revision: newRevision,
    rules: [{name: "secret=rule-token", description: "Keep token=rule-secret private.", required_blocks: ["verify"]}],
    blocks: [{id: "verify", name: "secret=block-token", description: "Check safely.", instructions: "Use api_key=private-instructions", expected_result: "password:private-result"}]});
  const parsed = parseProjectDefinitionDecisionRecord(decisionRecord({reason: "Bearer abcdefghijklmnopqrstuvwxyz123456"}), current, observed, agentProjection());
  assert.equal(parsed?.decision.reason, "[redacted credential]");

  const prompt = buildProjectDefinitionReviewRequest(current, definitions(), observed, agentProjection(), "Review marker");
  assert.ok(prompt);
  assert.match(prompt, /UNTRUSTED_PROJECT_DEFINITION_REVIEW_ENVELOPE/u);
  assert.match(prompt, /UNTRUSTED DATA/u);
  assert.match(prompt, /preserving all user edits/u);
  assert.match(prompt, /Never edit files/u);
  assert.match(prompt, /workflow-proposal/u);
  assert.match(prompt, /Review marker/u);
  for (const secret of ["rule-secret", "block-token", "private-instructions", "private-result"]) assert.equal(prompt.includes(secret), false);
  const envelope = parseEnvelope(prompt);
  assert.equal((envelope.approved as Record<string, unknown>).revision, oldRevision);
  assert.equal((envelope.observed as Record<string, unknown>).revision, newRevision);
  assert.equal((envelope.originalTask as Record<string, unknown>).sourceMessageId, "source-0");
  assert.deepEqual((envelope.userMessages as Array<Record<string, unknown>>).map(message => message.messageId), ["source-0", "user-1"]);
  assert.equal(envelope.decisionTemplate !== null, true);
  assert.equal(envelope.proposalTemplate !== null, true);
});

test("review requests handle invalid snapshots and refresh proposals after restore or authorization", () => {
  const current = task();
  const invalid = definitions({status: "invalid", revision: null, rules: [], blocks: [],
    issues: [{path: ".supervisor/rules.yaml", code: "invalid_definition", message: "The rules are incomplete."}]});
  const invalidRequest = buildProjectDefinitionReviewRequest(current, definitions(), invalid, agentProjection(), "Invalid marker");
  assert.ok(invalidRequest);
  const invalidEnvelope = parseEnvelope(invalidRequest);
  assert.equal(invalidEnvelope.decisionTemplate !== null, true);
  assert.equal((invalidEnvelope.decisionTemplate as Record<string, unknown>).observedRevision, null);
  assert.equal(invalidEnvelope.proposalTemplate, null);

  const authorized = definitions({revision: newRevision});
  const refreshRequest = buildProjectDefinitionReviewRequest(current, authorized, authorized, agentProjection(), "Refresh marker");
  assert.ok(refreshRequest);
  const refreshEnvelope = parseEnvelope(refreshRequest);
  assert.equal(refreshEnvelope.decisionTemplate, null);
  assert.equal(refreshEnvelope.proposalTemplate !== null, true);
  assert.match(refreshRequest, /Reassess the real task against the complete current rules and blocks/u);

  assert.equal(buildProjectDefinitionReviewRequest(current, definitions(), definitions({status: "permission_required", revision: null}), agentProjection(), "Blocked"), null);
  const staleSource = agentProjection();
  staleSource.messages[0]!.text = "tampered original source";
  assert.equal(buildProjectDefinitionReviewRequest(current, definitions(), authorized, staleSource, "Stale source"), null);
});
