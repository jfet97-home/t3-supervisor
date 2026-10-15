import assert from "node:assert/strict";
import test from "node:test";
import { nativeUserMessageVisible } from "../src/domain.js";
import { fingerprint } from "../src/guidance-store.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { buildProjectDefinitionReviewRequest, extractApprovedProjectDefinitions, extractProjectDefinitionDecisionRecords, parseProjectDefinitionDecisionRecord } from "../src/supervisor-definition-review.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import type { Projection } from "../src/types.js";
import { prepareWorkflowRequest, validateWorkflowPlan } from "../src/supervisor-workflow.js";
import { stepSource } from "./project-definitions-fixture.js";

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
  globalOnly: false,
  globalRevision: null,
  editingAvailable: true,
  status: "ready",
  steps: [{id: "verify", name: "Verification", description: "Verify the change.", origin: "project", path: ".t3-supervisor/steps/verify.md", sourceId: "verify"}],
  workflows: [],
  config: {required: [{step: "verify"}]},
  projectConfig: {required: [{step: "verify"}]},
  complete: true,
  sources: [
    {path: ".t3-supervisor/project.yaml", content: "required:\n  - step: verify\n", origin: "project"},
    {path: ".t3-supervisor/steps/verify.md", content: stepSource("verify", "Verify the change."), origin: "project"},
  ],
  issues: [],
  ...overrides,
});

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => {
  const approved = definitions();
  const prepared = prepareWorkflowRequest(operativeThreadId, "source-0", sourceText, approved);
  assert.ok(prepared.context);
  const plan = validateWorkflowPlan({requirements: [{kind: "step", id: "verify", applies: true, reason: "The task changes behavior."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "verify", reason: "Check the change."}]}}, prepared.context);
  assert.ok(plan);
  return {
    threadId: operativeThreadId,
    projectId,
    sourceRunId: "operative-run-1",
    sourceMessageId: "source-0",
    status: "inferred",
    objective: "Add a carefully bounded feature.",
    reason: "The user requested a concrete feature.",
    updatedAt: 100,
    workflow: {status: "proposed", message: "Draft.", workspaceRoot: root, revision: oldRevision, globalRevision: null, ...plan},
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

type UserFixture = {id: string; text: string; runStatus?: string; rootKind?: string; rootStatus?: string; nodeId?: string; historicalRoot?: boolean; streaming?: boolean;
  createdBy?: string; creationSource?: string; senderThreadId?: string | null; scheduledTaskId?: string | null; source?: string | null};

const agentProjection = (users: UserFixture[] = [{id: "user-1", text: userText}], sourceRunStatus = "completed", sourceRestarted = false): Projection => {
  const messages = [{id: "source-0", runId: "operative-run-1", nodeId: "root-operative-run-1", role: "user", text: sourceText, streaming: false,
    createdAt: "2026-10-13T10:00:00.000Z", updatedAt: "2026-10-13T10:00:00.000Z", createdBy: "user", creationSource: "web", threadId: operativeThreadId},
  ...users.map((user, index) => ({id: user.id, runId: `operative-run-${index + 2}`, nodeId: user.nodeId ?? `root-operative-run-${index + 2}`, role: "user", text: user.text,
    streaming: user.streaming ?? false, createdAt: `2026-10-13T10:${String(index + 1).padStart(2, "0")}:00.000Z`, updatedAt: "2026-10-13T10:30:00.000Z",
    createdBy: user.createdBy ?? "user", creationSource: user.creationSource ?? "web", senderThreadId: user.senderThreadId,
    scheduledTaskId: user.scheduledTaskId, source: user.source, threadId: operativeThreadId}))];
  const runs = [
    {id: "operative-run-1", threadId: operativeThreadId, ordinal: 1, status: sourceRunStatus, userMessageId: sourceRestarted ? "source-restart-message" : "source-0", requestedAt: "2026-10-13T10:00:00.000Z",
      startedAt: "2026-10-13T10:00:00.000Z", completedAt: sourceRunStatus === "completed" ? "2026-10-13T10:00:30.000Z" : null,
      rootNodeId: sourceRestarted ? "restart-root-operative-run-1" : "root-operative-run-1", providerThreadId: "provider"},
    ...users.map((user, index) => ({id: `operative-run-${index + 2}`, threadId: operativeThreadId, ordinal: index + 2,
      status: user.runStatus ?? "running", userMessageId: user.historicalRoot ? `${user.id}-restart` : user.id,
      requestedAt: "2026-10-13T10:01:00.000Z", startedAt: "2026-10-13T10:01:00.000Z",
      completedAt: null, rootNodeId: user.historicalRoot ? `restart-root-operative-run-${index + 2}` : `root-operative-run-${index + 2}`, providerThreadId: "provider"})),
  ];
  const nodes = runs.map((run, index) => ({id: run.rootNodeId!, kind: index === 0 ? "root_turn" : users[index - 1]!.rootKind ?? "root_turn",
    threadId: operativeThreadId, runId: run.id, rootNodeId: run.rootNodeId, providerThreadId: "provider",
    status: index === 0 ? sourceRunStatus : users[index - 1]!.runStatus ?? "running", parentNodeId: null}));
  for (const [index, user] of users.entries()) {
    if (user.historicalRoot) nodes.push({id: `root-operative-run-${index + 2}`, kind: "root_turn", threadId: operativeThreadId,
      runId: `operative-run-${index + 2}`, rootNodeId: `root-operative-run-${index + 2}`, providerThreadId: "provider",
      status: user.rootStatus ?? "interrupted", parentNodeId: null});
  }
  if (sourceRestarted) nodes.push({id: "root-operative-run-1", kind: "root_turn", threadId: operativeThreadId, runId: "operative-run-1",
    rootNodeId: "root-operative-run-1", providerThreadId: "provider", status: "interrupted", parentNodeId: null});
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

test("approved definitions require the stored complete snapshot and do not use a legacy fallback", () => {
  const current = task();
  assert.deepEqual(extractApprovedProjectDefinitions(current), definitions());

  const fallback = task({definitionSnapshot: null});
  assert.equal(extractApprovedProjectDefinitions(fallback), null);

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

test("authorized decisions require exact revisions and native main-root external user messages", () => {
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
    issues: [{path: ".t3-supervisor/project.yaml", code: "project_configuration_invalid", message: "Invalid configuration."}]}), agent), null);
});

test("native primary user messages use the running root_turn node", () => {
  const projection = agentProjection([{id: "user-1", text: userText, runStatus: "waiting", rootStatus: "starting"}], "running");
  const source = projection.messages[0]!;
  const sourceRun = projection.runs.find(run => run.id === source.runId)!;
  const user = projection.messages[1]!;
  const userRun = projection.runs.find(run => run.id === user.runId)!;
  assert.equal(nativeUserMessageVisible(projection, sourceRun, source), true);
  assert.equal(nativeUserMessageVisible(projection, userRun, user), true);
  assert.equal(buildProjectDefinitionReviewRequest(task(), definitions(), definitions({revision: newRevision}), projection, "Running marker") !== null, true);
});

test("restart_active preserves source and citation messages on interrupted historical roots", () => {
  const projection = agentProjection([{id: "user-1", text: userText, runStatus: "running", historicalRoot: true}], "running", true);
  const source = projection.messages[0]!;
  const sourceRun = projection.runs.find(run => run.id === source.runId)!;
  const user = projection.messages[1]!;
  const userRun = projection.runs.find(run => run.id === user.runId)!;
  assert.notEqual(source.nodeId, sourceRun.rootNodeId);
  assert.notEqual(user.nodeId, userRun.rootNodeId);
  assert.equal(nativeUserMessageVisible(projection, sourceRun, source), true);
  assert.equal(nativeUserMessageVisible(projection, userRun, user), true);

  const current = task();
  const observed = definitions({revision: newRevision});
  const parsed = parseProjectDefinitionDecisionRecord(decisionRecord(), current, observed, projection);
  assert.ok(parsed);
  assert.deepEqual(parsed.decision.userMessageIds, ["user-1"]);
  const request = buildProjectDefinitionReviewRequest(current, definitions(), observed, projection, "Restart marker");
  assert.ok(request);
  assert.deepEqual((parseEnvelope(request).userMessages as Array<Record<string, unknown>>).map(message => message.messageId), ["source-0", "user-1"]);

  const rolledBack = agentProjection([{id: "user-1", text: userText, runStatus: "running", historicalRoot: true, rootStatus: "rolled_back"}], "running", true);
  const rolledBackUser = rolledBack.messages[1]!;
  const rolledBackRun = rolledBack.runs.find(run => run.id === rolledBackUser.runId)!;
  assert.equal(nativeUserMessageVisible(rolledBack, rolledBackRun, rolledBackUser), false);
  assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord(), current, observed, rolledBack), null);
});

test("forwarded, scheduled, source-tagged, streaming, rolled-back and non-root user messages cannot authorize definitions", () => {
  const current = task();
  const observed = definitions({revision: newRevision});
  const rejected: UserFixture[] = [
    {id: "sender", text: userText, senderThreadId: "parent-thread"},
    {id: "scheduled", text: userText, scheduledTaskId: "schedule-1"},
    {id: "source-tagged", text: userText, source: "import"},
    {id: "assistant-authored", text: userText, createdBy: "assistant"},
    {id: "other-origin", text: userText, creationSource: "import"},
    {id: "streaming", text: userText, streaming: true},
    {id: "rolled-back-run", text: userText, runStatus: "rolled_back"},
    {id: "off-root-node", text: userText, nodeId: "off-root-user-node"},
    {id: "wrong-root-kind", text: userText, rootKind: "subagent"},
  ];
  for (const user of rejected) {
    assert.equal(parseProjectDefinitionDecisionRecord(decisionRecord({userMessageIds: [user.id]}), current, observed, agentProjection([user])), null, user.id);
  }
});

test("stopped, failed and cancelled runs retain their real user request and authorization history", () => {
  for (const status of ["interrupted", "failed", "cancelled"]) {
    const projection = agentProjection([{id: "user-1", text: userText, runStatus: status}], status);
    const source = projection.messages[0]!;const sourceRun = projection.runs.find(run => run.id === source.runId)!;
    assert.equal(nativeUserMessageVisible(projection, sourceRun, source), true, status);
    assert.ok(parseProjectDefinitionDecisionRecord(decisionRecord(), task(), definitions({revision: newRevision}), projection), status);
    assert.ok(buildProjectDefinitionReviewRequest(task(), definitions(), definitions({revision: newRevision}), projection, "Stopped history marker"), status);
  }
});

test("revert decisions may cite no users and retain a null observed revision for missing definitions", () => {
  const current = task();
  const missing = definitions({status: "missing", revision: null, projectConfig: null, config: {required: []}, steps: [], workflows: [], complete: false,
    sources: [], issues: [{path: ".t3-supervisor/project.yaml", code: "configuration_missing", message: "Missing."}]});
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
    steps: [{id: "verify", name: "secret=step-token", description: "Keep token=step-secret private.", origin: "project",
      path: ".t3-supervisor/steps/verify.md", sourceId: "verify"}],
    sources: definitions().sources.map(source => source.path.endsWith("steps/verify.md")
      ? {...source, content: stepSource("verify", "Check safely with api_key=private-instructions and password:private-result.")} : source)});
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
  for (const secret of ["step-secret", "step-token", "private-instructions", "private-result"]) assert.equal(prompt.includes(secret), false);
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
  const invalid = definitions({status: "invalid", revision: null, projectConfig: null, config: {required: []}, steps: [], workflows: [], complete: false,
    sources: [], issues: [{path: ".t3-supervisor/project.yaml", code: "project_configuration_invalid", message: "The configuration is invalid."}]});
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
  assert.match(refreshRequest, /Reassess the real task against the complete current project configuration and definition catalog/u);

  assert.equal(buildProjectDefinitionReviewRequest(current, definitions(), definitions({status: "permission_required", revision: null}), agentProjection(), "Blocked"), null);
  const staleSource = agentProjection();
  staleSource.messages[0]!.text = "tampered original source";
  assert.equal(buildProjectDefinitionReviewRequest(current, definitions(), authorized, staleSource, "Stale source"), null);
});
