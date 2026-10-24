import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { applyArgs, ensureArgs, installEvidence, localStep, mainStep, makeFixture, proposalForDefinitions,
  replaceCurrentProposal, sequencePlan, openWrite } from "./support/wwc-fixture.js";
import { fingerprint } from "../src/guidance-store.js";

it.effect("initial planned duties reconcile fully and partly satisfied non-research work through verified writes before agreement", () => Effect.gen(function* () {
  const f = yield* makeFixture();
  try {
    const prior = f.projections.get(f.mainThreadId)!;
    prior.runs.push({id: "earlier-work", threadId: f.mainThreadId, ordinal: 0, status: "completed", requestedAt: "2026-10-01T10:00:00Z", startedAt: "2026-10-01T10:00:00Z",
      completedAt: "2026-10-01T10:01:00Z", userMessageId: null, rootNodeId: "earlier-root"});
    prior.messages.push({id: "earlier-result", threadId: f.mainThreadId, runId: "earlier-work", nodeId: "earlier-report", role: "assistant", streaming: false,
      text: "The requested implementation artifact is present; its exact behavior was inspected. The focused verification passed; integration and error cases remain.",
      createdAt: "2026-10-01T10:01:00Z", updatedAt: "2026-10-01T10:01:00Z"});
    f.projections.set(f.mainThreadId, prior);
    const send = (args: Record<string, unknown>) => {installEvidence(f, args);return f.controller.write(args);};
    const created = yield* send(ensureArgs(f, "prior-draft", "Create the workflow independently of any acceptance."));
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const plan = sequencePlan([localStep("Implement export retry", "Produce the requested retry behavior."), localStep("Verify retry", "Verify focused, integration and error behavior.")]);
    const seeded = yield* send(yield* applyArgs(f, {operationId: "prior-plan", workflowId: created.workflowId, expectedRevision: created.revision, plan,
      note: "Introduce all live duties planned; earlier work is evidence, not automatic completion."}));
    assert.equal(seeded.status, "applied");
    const before = (yield* f.workflows.get(f.projectId, f.mainThreadId))!;
    assert.deepEqual([mainStep(before.plan, 0)?.status, mainStep(before.plan, 1)?.status], ["planned", "planned"]);
    const first = mainStep(before.plan, 0)!, second = mainStep(before.plan, 1)!;
    const assessed = yield* send(yield* applyArgs(f, {operationId: "prior-assess", workflowId: before.workflowId, expectedRevision: before.revision,
      plan: sequencePlan([{...first, status: "completed"}, {...second, status: "underway"}]),
      note: "Reconcile actual earlier artifacts; do not rerun the implementation or the satisfied verification subset.",
      evidence: [{kind: "status_changed", targetNodeId: first.nodeId, sourceRunId: "earlier-work", sourceMessageId: "earlier-result",
        note: "The earlier inspected artifact satisfies the full implementation duty."},
      {kind: "status_changed", targetNodeId: second.nodeId, sourceRunId: "earlier-work", sourceMessageId: "earlier-result",
        note: "Focused behavior is verified. Remaining obligations: integration and error cases."}]}));
    assert.equal(assessed.status, "applied", JSON.stringify(assessed));
    const after = (yield* f.workflows.get(f.projectId, f.mainThreadId))!;
    assert.deepEqual([mainStep(after.plan, 0)?.status, mainStep(after.plan, 1)?.status], ["completed", "underway"]);
    assert.deepEqual([mainStep(after.plan, 0)?.nodeId, mainStep(after.plan, 1)?.nodeId], [first.nodeId, second.nodeId]);
    assert.equal(after.acceptedAgreements.length, 0, "credit predates initial agreement and never manufactures acceptance");
    assert.match(after.evidence.find(item => item.targetNodeId === second.nodeId && item.kind === "status_changed")!.note, /Remaining obligations: integration and error cases/u);

    // an expanded requested outcome cannot inherit old node completion without an explicit assessment against its scope.
    const completed = mainStep(after.plan, 0)!, partial = mainStep(after.plan, 1)!;
    const expandedPlan = sequencePlan([completed, partial, localStep("Document deployment", "Document the newly requested deployment behavior.")]);
    const expanded = proposalForDefinitions(f.definitionReader.current, expandedPlan);
    yield* replaceCurrentProposal(f, "expanded-proposal", f.definitionReader.current, expanded, {sourceHash: fingerprint("An expanded requested outcome")});
    const unassessed = yield* send(yield* applyArgs(f, {operationId: "expanded-carry", workflowId: after.workflowId, expectedRevision: after.revision,
      plan: expandedPlan,
      note: "The scope changed; old completion alone must not satisfy the new outcome."}));
    assert.equal(unassessed.status, "invalid");
    assert.equal("reason" in unassessed && unassessed.reason, "scope_assessment_required");
    assert.equal((yield* f.workflows.get(f.projectId, f.mainThreadId))!.revision, after.revision);
  } finally {yield* f.close;}
}));

it.effect("an existing binding cannot create workflow state after its agent-created origin is excluded", () => Effect.gen(function* () {
  const f = yield* makeFixture();
  try {
    Object.assign(f.threads.find(thread => thread.id === f.mainThreadId)!, {createdBy: "agent", creationSource: "mcp"});
    const args = ensureArgs(f, "excluded-origin-write", "Attempt a write from an old binding.");installEvidence(f, args);
    assert.deepEqual(yield* f.controller.write(args), {status: "denied", operationId: "excluded-origin-write", reason: "conversation_origin_excluded"});
    assert.equal(yield* f.workflows.get(f.projectId, f.mainThreadId), null);
    assert.ok(yield* f.supervisors.task(f.mainThreadId), "the existing task is retained");
  } finally {yield* f.close;}
}));

it.effect("a newer requester message at the last definition read defers a verified workflow write without reserving it", () => Effect.gen(function* () {
  const f = yield* makeFixture();
  try {
    const create = ensureArgs(f, "before-pause", "Prepare the workflow.");installEvidence(f, create);
    const created = yield* f.controller.write(create);assert.equal(created.status, "created");if (created.status !== "created") return;
    const args = yield* applyArgs(f, {operationId: "racing-pause", workflowId: created.workflowId, expectedRevision: created.revision,
      plan: sequencePlan([localStep("Implement the change", "Make the requested change.")]), note: "A verified write whose final admission must see a newer requester."});
    installEvidence(f, args);
    const controller = yield* openWrite(f, {loadDefinitions: () => Effect.sync(() => {
      const main = f.projections.get(f.mainThreadId)!;
      main.runs.push({id: "pause-run", threadId: f.mainThreadId, ordinal: 2, status: "completed", userMessageId: "pause-message", rootNodeId: "pause-root",
        requestedAt: "2026-10-01T12:00:00Z", startedAt: "2026-10-01T12:00:00Z", completedAt: "2026-10-01T12:01:00Z"});
      main.messages.push({id: "pause-message", threadId: f.mainThreadId, runId: "pause-run", nodeId: "pause-root", role: "user", text: "Pause implementation; let's discuss.",
        streaming: false, createdBy: "user", creationSource: "web", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z"});
      (main.nodes as unknown[]).push({id: "pause-root", rootNodeId: "pause-root", kind: "root_turn", threadId: f.mainThreadId, runId: "pause-run", status: "completed"});
      return f.definitionReader.current;
    })});
    const result = yield* controller.write(args);
    assert.deepEqual(result, {status: "pending", operationId: "racing-pause", reason: "conversation_authority_not_current", retryable: true});
    assert.equal((yield* f.workflows.get(f.projectId, f.mainThreadId))!.revision, created.revision);
    const receipts = yield* f.db`SELECT operation_id FROM supervisor_workflow_write_receipts WHERE operation_id=${"racing-pause"}`;
    const evidence = yield* f.db`SELECT operation_id FROM supervisor_workflow_write_evidence WHERE operation_id=${"racing-pause"}`;
    assert.equal(receipts.length, 0);assert.equal(evidence.length, 0);
  } finally {yield* f.close;}
}));
