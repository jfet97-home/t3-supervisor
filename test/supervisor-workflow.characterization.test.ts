import assert from "node:assert/strict";
import { it } from "vitest";
import { canonicalizeProposalDraft, interpretationPrompt, prepareWorkflowRequest, seededNodeIds } from "../src/supervisor-workflow.js";
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
  assert.equal(prepared.requestText.length, 5429);
  assert.equal(sha256(prepared.requestText), "65a267fb5ff9c01cd330c1761fd353dc173620266859478229984d38418b7c83");
  assert.equal(prepared.requestText.includes("github_pat_12345678901234567890"), false);
  assert.equal(sha256(JSON.stringify(prepared.context)), "4b22e3c45e9060410b2a752eea3eb602c960836021edd7c79e75d9d8d3e45f4f");
  assert.equal(sha256(JSON.stringify(prepared.workflow)), "a263f8572ef36eca2578bb7f9a3f3e0860a0690bca1f4869eba7ebf4b61d0db4");

  const reader = prepareWorkflowRequest("thread-a", "message-a", "Check this task.", goldenSnapshot,
    {reader: {supervisorThreadId: "supervisor-a", bindingGeneration: 3}, earlierMessages: [{messageId: "message-0", text: "Earlier request."}]});
  assert.equal(reader.requestText.length, 1555);
  assert.equal(sha256(reader.requestText), "d90954428ad788a1de595746a62fe4583a388f74e29e5e107cf8881e905e2fb5");
  assert.equal(sha256(interpretationPrompt("thread-a", "message-a", "Check this task.")), "ce8ab4b6b0c44fd5a932cfa2ea7b91abb4f2a915c1ff4f6680a33cdc4a2cfeb5");

  const canonical = canonicalizeProposalDraft(goldenDraft, prepared.context, goldenSeed);
  assert.deepEqual(canonical, {ok: true, workflow: canonicalWorkflow});
  // key order and node ID traversal order are part of the golden
  assert.equal(sha256(JSON.stringify(canonical)), "4bf1d1543e63acd2e3370ec115ff4cc1997a61ae1d2d7651843278fea9eecd08");
  const sequence = seededNodeIds(goldenSeed);
  assert.deepEqual(nodeIds.map(() => sequence()), nodeIds);
  assert.deepEqual(canonicalizeProposalDraft(goldenDraft, prepared.context, goldenSeed), canonical);
});
