import assert from "node:assert/strict";
import { it } from "vitest";
import { canonicalizeProposalDraft, prepareWorkflowRequest, seededNodeIds } from "../src/supervisor-workflow.js";
import { goldenDraft, goldenSeed, goldenSnapshot, sha256 } from "./support/c1-workflow-fixture.js";

const verifySource = {origin: "project", path: ".t3-supervisor/steps/verify.md", sourceId: "project:verify"};
const nodeIds = [
  "bd4bde5f-85e7-4826-85a9-ca6207432064",
  "450b89ca-0d6e-46ea-b578-0de9d045bd9b",
  "d697be1c-5471-4f9c-9464-89d20c530cf3",
  "74c841d9-68cd-457a-b008-95cd60191c02",
  "05ffc344-d265-4fce-82dc-f49dedd94f27",
  "5e40006b-eeb7-4e36-b685-33026e1ddf6e",
];

const canonicalWorkflow = {
  definitionsStatus: "ready",
  definitionsComplete: true,
  requirementsKnown: true,
  requirements: [{kind: "step", id: "verify", name: "Verify behavior", source: verifySource, state: "included", reason: "The task changes behavior."}],
  issues: [],
  plan: {kind: "sequence", templatePath: null, nodes: [
    {kind: "step", nodeId: nodeIds[0], definitionId: "verify", localId: null, templatePath: null, name: "Verify behavior", description: "Check the changed behavior.",
      source: verifySource, resolution: "resolved", reason: "Check the changed behavior.", status: "planned", contributorThreadIds: []},
    {kind: "workflow", nodeId: nodeIds[1], definitionId: "delivery", templatePath: null, name: "Delivery", description: "Use the reusable delivery guidance.", fixed: false,
      source: {origin: "project", path: ".t3-supervisor/workflows/delivery.yaml", sourceId: "delivery"}, resolution: "resolved", reason: "Use the delivery guidance.",
      status: "planned", contributorThreadIds: [], omissions: [],
      plan: {kind: "sequence", templatePath: "workflow:delivery/root", nodes: [
        {kind: "step", nodeId: nodeIds[2], definitionId: null, localId: "subtotal", templatePath: "workflow:delivery/root/0", name: "Review the subtotal",
          description: "Check the subtotal.", source: null, resolution: "resolved", reason: "Declared as a local step in its workflow.", status: "planned", contributorThreadIds: []},
        {kind: "step", nodeId: nodeIds[3], definitionId: "verify", localId: null, templatePath: "workflow:delivery/root/1", name: "Verify behavior",
          description: "Check the changed behavior.", source: verifySource, resolution: "resolved", reason: "Included from workflow verify.", status: "planned", contributorThreadIds: []},
      ]}},
    {kind: "parallel", templatePath: null, nodes: [
      {kind: "step", nodeId: nodeIds[4], definitionId: null, localId: "notes", templatePath: null, name: "Write notes", description: "Record release notes.",
        source: null, resolution: "resolved", reason: "The task needs notes.", status: "planned", contributorThreadIds: []},
      {kind: "step", nodeId: nodeIds[5], definitionId: "publish", localId: null, templatePath: null, name: "Prepare handoff", description: "Write a concise handoff.",
        source: {origin: "project", path: ".t3-supervisor/steps/publish.md", sourceId: "project:publish"}, resolution: "resolved", reason: "Prepare the requested handoff.",
        status: "planned", contributorThreadIds: []},
    ]},
  ]},
};

it("CT-SW-01: canonical plan JSON, seeded node IDs and prompt digests are golden for a fixed seed and fixture", {timeout: 10_000}, () => {
  const taskText = "Check this task. token=github_pat_12345678901234567890";
  const prepared = prepareWorkflowRequest("thread-a", "message-a", taskText, goldenSnapshot);
  assert.ok(prepared.context);
  // the request texts are the typed-submission prompt of plan 3.12 item 12 (the final-chat JSON prompts and the objective-only
  // interpretationPrompt are deleted); the context and workflow digests are unchanged
  assert.equal(prepared.requestText.length, 5539);
  assert.equal(sha256(prepared.requestText), "512e78d7d2f43037d1d8bc18e89bb25fd279d79b6cc65876ae25fc01343b675a");
  assert.equal(prepared.requestText.includes("github_pat_12345678901234567890"), false);
  assert.equal(sha256(JSON.stringify(prepared.context)), "4b22e3c45e9060410b2a752eea3eb602c960836021edd7c79e75d9d8d3e45f4f");
  assert.equal(sha256(JSON.stringify(prepared.workflow)), "a263f8572ef36eca2578bb7f9a3f3e0860a0690bca1f4869eba7ebf4b61d0db4");

  const reader = prepareWorkflowRequest("thread-a", "message-a", "Check this task.", goldenSnapshot,
    {reader: {supervisorThreadId: "supervisor-a", bindingGeneration: 3}, earlierMessages: [{messageId: "message-0", text: "Earlier request."}]});
  assert.equal(reader.requestText.length, 1658);
  assert.equal(sha256(reader.requestText), "085d6c578e304e9f28d34f3e005c864124c0407d103b5b3ef211b7129d643a19");
  const typed = prepareWorkflowRequest("thread-a", "message-a", "Check this task.", goldenSnapshot,
    {reader: {supervisorThreadId: "supervisor-a", bindingGeneration: 3}, earlierMessages: [{messageId: "message-0", text: "Earlier request."}],
      submission: {supervisorThreadId: "supervisor-a", bindingGeneration: 3, taskId: "task-a", attemptId: "interpretation-attempt:00000000-0000-4000-8000-000000000001",
        sourcePin: {messageId: "message-a", runId: "run-a", ordinal: 1, hash: "0".repeat(64)}, startVerdict: true}});
  assert.equal(typed.requestText.length, 2986);
  assert.equal(sha256(typed.requestText), "b46f778077d979aab17b93272a1fdf8b4d1e90525c0453bff745fdab16d6238b");

  const canonical = canonicalizeProposalDraft(goldenDraft, prepared.context, goldenSeed);
  assert.deepEqual(canonical, {ok: true, workflow: canonicalWorkflow});
  // key order and node ID traversal order are part of the golden
  assert.equal(sha256(JSON.stringify(canonical)), "4bf1d1543e63acd2e3370ec115ff4cc1997a61ae1d2d7651843278fea9eecd08");
  const sequence = seededNodeIds(goldenSeed);
  assert.deepEqual(nodeIds.map(() => sequence()), nodeIds);
  assert.deepEqual(canonicalizeProposalDraft(goldenDraft, prepared.context, goldenSeed), canonical);
});
