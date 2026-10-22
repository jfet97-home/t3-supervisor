import assert from "node:assert/strict";
import { it } from "vitest";
import { fingerprint } from "../src/guidance-store.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import { parseProjectDefinitionDecisionRecord } from "../src/supervisor-definition-review.js";
import { prepareWorkflowRequest, seededNodeIds, validateWorkflowPlan } from "../src/supervisor-workflow.js";
import type { Projection } from "../src/types.js";
import { effectiveIndex, indexSource, projectIndex, stepSource, testSummary } from "./project-definitions-fixture.js";

const projectId = "project-a";
const threadId = "operative-thread";
const root = "/workspace/project";
const oldRevision = "a".repeat(64);
const newRevision = "b".repeat(64);
const sourceText = "Add a carefully bounded feature.";

const definitions = (revision: string): ProjectDefinitionSnapshot => {
  const steps: ProjectDefinitionSnapshot["steps"] = [{id: "verify", name: "Verification", description: "Verify the change.", summary: testSummary("verify"),
    origin: "project", path: ".t3-supervisor/steps/verify.md", sourceId: "verify"}];
  return {projectId, threadId, workspaceRoot: root, revision, globalOnly: false, globalRevision: null, editingAvailable: true, status: "ready", steps, workflows: [],
    config: effectiveIndex({steps, workflows: []}, [{step: "verify"}]), projectConfig: projectIndex({steps: ["verify"], workflows: [], required: [{step: "verify"}]}),
    definitionFiles: [], complete: true, issues: [],
    sources: [
      {path: ".t3-supervisor/project.yaml", content: indexSource({steps: ["verify"], required: [{step: "verify"}]}), origin: "project"},
      {path: ".t3-supervisor/steps/verify.md", content: stepSource("verify", "Verify the change."), origin: "project"},
    ]};
};

const task = (): TaskRecord => {
  const approved = definitions(oldRevision);
  const prepared = prepareWorkflowRequest(threadId, "source-0", sourceText, approved);
  assert.ok(prepared.context);
  const plan = validateWorkflowPlan({requirements: [{kind: "step", id: "verify", applies: true, reason: "The task changes behavior."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "verify", reason: "Check the change."}]}}, prepared.context, seededNodeIds("decision"));
  assert.ok(plan);
  return {threadId, projectId, sourceRunId: "run-0", sourceMessageId: "source-0", status: "inferred", objective: sourceText, reason: "A concrete feature.",
    updatedAt: 100, workflow: {status: "proposed", message: "Draft.", workspaceRoot: root, revision: oldRevision, globalRevision: null, ...plan},
    id: "task-1", sourceHash: fingerprint(sourceText), requestText: prepared.requestText, supervisorThreadId: "supervisor-thread", messageId: "request-1",
    dispatchedAt: 100, replayCount: 0, supervisorRunId: "supervisor-run-1", sourceOrdinal: 0, definitionContext: prepared.context, definitionSnapshot: approved};
};

// one genuine web user message per run on the operative main, each on its own running root turn
const projection = (userCount: number): Projection => {
  const ids = ["source-0", ...Array.from({length: userCount}, (_, index) => `user-${index + 1}`)];
  return {
    thread: {id: threadId, title: "Task", projectId, workspaceRoot: root, lineage: {parentThreadId: null, relationshipToParent: null}},
    messages: ids.map((id, index) => ({id, runId: `run-${index}`, nodeId: `root-${index}`, role: "user", text: index === 0 ? sourceText : `Change the checks ${index}.`,
      streaming: false, createdAt: "2026-10-13T10:00:00.000Z", updatedAt: "2026-10-13T10:00:00.000Z", createdBy: "user", creationSource: "web", threadId})),
    runs: ids.map((id, index) => ({id: `run-${index}`, threadId, ordinal: index + 1, status: "running", userMessageId: id, requestedAt: "2026-10-13T10:00:00.000Z",
      startedAt: "2026-10-13T10:00:00.000Z", completedAt: null, rootNodeId: `root-${index}`, providerThreadId: "provider"})),
    nodes: ids.map((_, index) => ({id: `root-${index}`, kind: "root_turn", threadId, runId: `run-${index}`, rootNodeId: `root-${index}`, providerThreadId: "provider",
      status: "running", parentNodeId: null})),
  } as Projection;
};

const decision = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({taskId: "task-1", expectedRevision: oldRevision,
  observedRevision: newRevision, decision: "authorized", userMessageIds: ["user-1"], reason: "The user asked for these checks.", ...overrides});

it("decision records decode with the exact key set, literals and bounds before task evidence is checked", {timeout: 10_000}, () => {
  const current = task();
  const observed = definitions(newRevision);
  const agent = projection(101);
  const parse = (value: unknown) => parseProjectDefinitionDecisionRecord(value, current, observed, agent);
  const accepted = parse(decision());
  assert.deepEqual(accepted?.decision, {taskId: "task-1", expectedRevision: oldRevision, observedRevision: newRevision, decision: "authorized",
    userMessageIds: ["user-1"], reason: "The user asked for these checks."});
  assert.ok(parse(decision({reason: "r".repeat(1000)})));
  assert.ok(parse(decision({reason: ""})));
  const hundred = Array.from({length: 100}, (_, index) => `user-${index + 1}`);
  assert.equal(parse(decision({userMessageIds: hundred}))?.decision.userMessageIds.length, 100);
  assert.ok(parse(decision({decision: "revert_requested", userMessageIds: []})));

  const missingReason = decision();
  delete missingReason.reason;
  for (const [label, value] of [
    ["missing key", missingReason],
    ["excess key", decision({extra: null})],
    ["prototype key", JSON.parse(JSON.stringify(decision()).replace("{", "{\"__proto__\":null,")) as unknown],
    ["unknown decision", decision({decision: "approve"})],
    ["reason over bound", decision({reason: "r".repeat(1001)})],
    ["numeric reason", decision({reason: 1})],
    ["reference over bound", decision({userMessageIds: [...hundred, "user-101"]})],
    ["numeric reference", decision({userMessageIds: [1]})],
    ["blank reference", decision({userMessageIds: [" "]})],
    ["duplicate reference", decision({userMessageIds: ["user-1", "user-1"]})],
    ["numeric observed revision", decision({observedRevision: 7})],
    ["missing observed revision", decision({observedRevision: undefined})],
    ["array", [decision()]],
    ["string", JSON.stringify(decision())],
    ["null", null],
  ] as Array<[string, unknown]>) assert.equal(parse(value), null, label);
});
