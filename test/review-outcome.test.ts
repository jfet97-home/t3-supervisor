import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import type { ConversationRequest, ReviewOutcomeKind } from "../src/supervisor-conversation-store.js";
import { sqlGet } from "./support/wwc-stores.js";
import { applyArgs, ensureArgs, installEvidence, localStep, locator, makeFixture, openWrite, sequencePlan, type WwcFixture } from "./support/wwc-fixture.js";

// workflow_write record_review through the production controller and its native proof: the root records the outcome of its own
// pending monitoring review, bound to its native call; progress cites apply edits of that same run; no outcome sends anything

// a root monitoring review the conversation sent, pinned and waiting in a native run of the root
const pendingReview = (fixture: WwcFixture, options: {runId?: string | null; state?: ConversationRequest["state"]; pinned?: boolean} = {}) =>
  Effect.gen(function* () {
    const prepared = yield* fixture.requests.prepare({projectId: fixture.projectId, supervisorThreadId: fixture.supervisorThreadId, kind: "review", taskId: null,
      text: "Review this factual change index.", batch: null, completionMarker: "Supervisor check-in monitor:1 completed",
      ...(options.pinned === false ? {} : {reviewPins: {bindingGeneration: fixture.binding.generation, tasks: []}})}, 1).pipe(Effect.orDie);
    const request: ConversationRequest = {...prepared, state: options.state ?? "waiting", runId: options.runId === undefined ? "supervisor-run-current" : options.runId, sentAt: 1};
    yield* fixture.requests.saveRequest(request).pipe(Effect.orDie);
    return request;
  });

const recordArgs = (fixture: WwcFixture, requestId: string, outcome: ReviewOutcomeKind, operationId: string,
  extra: {reason?: string; applyOperationIds?: string[]} = {}) =>
  ({action: "record_review", ...locator(fixture), operationId, requestId, outcome, ...extra});

const storedRequest = (fixture: WwcFixture, id: string) =>
  Effect.map(fixture.requests.requests(fixture.projectId, fixture.supervisorThreadId), (requests) => requests.find(request => request.id === id)).pipe(Effect.orDie);

const evidenceRows = (fixture: WwcFixture, itemId: string) =>
  Effect.map(sqlGet(fixture.db, "SELECT count(*) AS n FROM supervisor_workflow_write_evidence WHERE item_id=?", itemId), (row) => Number(row?.n));

it.effect("record_review records the root's outcome on its own pending review, bound to the native call; a replay returns the same result and nothing is sent", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  try {
    const request = yield* pendingReview(fixture);
    const args = recordArgs(fixture, request.id, "no_change", "review-no-change");
    const itemId = installEvidence(fixture, args);
    const recorded = yield* fixture.controller.write(args);
    assert.deepEqual(recorded, {status: "recorded", operationId: "review-no-change", requestId: request.id, outcome: "no_change"});
    const stored = (yield* storedRequest(fixture, request.id))!;
    assert.equal(stored.state, "waiting", "recording completes nothing");
    assert.deepEqual({...stored.reviewOutcome, recordedAt: 0, ordinal: 0}, {outcome: "no_change", reason: null, applies: [], itemId,
      runId: "supervisor-run-current", ordinal: 0, operationId: "review-no-change", recordedAt: 0, state: "recorded", problem: null});

    assert.deepEqual(yield* fixture.controller.write(args), recorded, "the same native call replays its receipt");
    assert.equal(yield* evidenceRows(fixture, itemId), 1);
    assert.equal(fixture.calls.listThreads, 1, "the replay reads no lineage");
    assert.equal(yield* fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null, "an outcome edits no workflow");
  } finally {yield* fixture.close;}
}));

it.effect("record_review refuses an unknown, unpinned, settled or other-run review and malformed outcomes, recording nothing", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  try {
    const write = (args: Record<string, unknown>) => Effect.suspend(() => {
      installEvidence(fixture, args);
      return fixture.controller.write(args);
    });
    assert.deepEqual(yield* write(recordArgs(fixture, "no-such-request", "no_change", "unknown")),
      {status: "denied", operationId: "unknown", reason: "review_request_unknown"});

    // malformed outcomes are refused before any proof is read
    for (const [operationId, args] of [
      ["attention-without-reason", recordArgs(fixture, "any", "needs_attention", "attention-without-reason")],
      ["insufficient-without-reason", recordArgs(fixture, "any", "insufficient_evidence", "insufficient-without-reason")],
      ["progress-without-applies", recordArgs(fixture, "any", "progress_updated", "progress-without-applies")],
      ["no-change-with-applies", recordArgs(fixture, "any", "no_change", "no-change-with-applies", {applyOperationIds: ["apply"]})],
    ] as const) assert.deepEqual(yield* fixture.controller.write(args), {status: "invalid", operationId, reason: "invalid_record_review"});

    const unpinned = yield* pendingReview(fixture, {pinned: false});
    assert.deepEqual(yield* write(recordArgs(fixture, unpinned.id, "no_change", "unpinned")),
      {status: "denied", operationId: "unpinned", reason: "review_request_unknown"});
    yield* fixture.requests.saveRequest({...unpinned, state: "completed"}).pipe(Effect.orDie);

    const otherRun = yield* pendingReview(fixture, {runId: "supervisor-run-older"});
    assert.deepEqual(yield* write(recordArgs(fixture, otherRun.id, "no_change", "other-run")),
      {status: "denied", operationId: "other-run", reason: "review_outcome_other_run"});
    yield* fixture.requests.saveRequest({...otherRun, state: "completed"}).pipe(Effect.orDie);
    assert.deepEqual(yield* write(recordArgs(fixture, otherRun.id, "no_change", "settled")),
      {status: "denied", operationId: "settled", reason: "review_request_not_pending"});

    for (const request of yield* fixture.requests.requests(fixture.projectId, fixture.supervisorThreadId).pipe(Effect.orDie))
      assert.equal(request.reviewOutcome, undefined);
  } finally {yield* fixture.close;}
}));

it.effect("progress_updated cites only apply edits of the same run, and no_change is refused once that run edited the workflow", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  try {
    const ensure = ensureArgs(fixture, "review-create", "Create the main workflow.");
    installEvidence(fixture, ensure);
    const created = yield* fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    // an older run planned the work
    const plan = yield* applyArgs(fixture, {operationId: "review-plan", workflowId: created.workflowId, expectedRevision: created.revision, status: "planned",
      objective: "Track the export change.", plan: sequencePlan([localStep("Implement the export", "Change the exporter.")]), note: "Plan the work."});
    installEvidence(fixture, plan, {runId: "supervisor-run-older"});
    assert.equal((yield* fixture.controller.write(plan)).status, "applied");

    const request = yield* pendingReview(fixture);
    // this review's run marks the completed operative work: the plan no longer stays planned
    const progress = yield* applyArgs(fixture, {operationId: "review-progress", workflowId: created.workflowId, expectedRevision: 2, status: "underway",
      evidence: [{kind: "status_changed", note: "The operative finished the exporter change.", sourceThreadId: fixture.mainThreadId}], note: "Record the progress."});
    installEvidence(fixture, progress);
    assert.equal((yield* fixture.controller.write(progress)).status, "applied");
    assert.equal((yield* fixture.workflows.get(fixture.projectId, fixture.mainThreadId))?.status, "underway");

    const noChange = recordArgs(fixture, request.id, "no_change", "review-claims-no-change");
    installEvidence(fixture, noChange);
    assert.deepEqual(yield* fixture.controller.write(noChange),
      {status: "denied", operationId: "review-claims-no-change", reason: "review_no_change_after_apply"});
    const older = recordArgs(fixture, request.id, "progress_updated", "review-cites-older", {applyOperationIds: ["review-plan"]});
    installEvidence(fixture, older);
    assert.deepEqual(yield* fixture.controller.write(older),
      {status: "denied", operationId: "review-cites-older", reason: "review_progress_apply_unverified"});
    assert.equal((yield* storedRequest(fixture, request.id))?.reviewOutcome, undefined);

    const cited = recordArgs(fixture, request.id, "progress_updated", "review-cites-own", {applyOperationIds: ["review-progress"]});
    installEvidence(fixture, cited);
    assert.equal((yield* fixture.controller.write(cited)).status, "recorded");
    assert.deepEqual((yield* storedRequest(fixture, request.id))?.reviewOutcome?.applies,
      [{operationId: "review-progress", workflowId: created.workflowId, revision: 3}]);
  } finally {yield* fixture.close;}
}));

it.effect("a stopped chat's Supervisor records no review outcome", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  try {
    const request = yield* pendingReview(fixture);
    const controller = yield* openWrite(fixture, {maxEvidenceWaitMs: 0, isChatStopped: () => true});
    const args = recordArgs(fixture, request.id, "needs_attention", "stopped-attention", {reason: "The operative skipped the review."});
    installEvidence(fixture, args);
    const result = yield* controller.write(args);
    assert.equal(result.status, "denied");
    assert.equal((yield* storedRequest(fixture, request.id))?.reviewOutcome, undefined);
  } finally {yield* fixture.close;}
}));

it.effect("without its native call the outcome stays unrecorded and the write is pending, never inferred", () => Effect.gen(function* () {
  const fixture = yield* makeFixture();
  try {
    const request = yield* pendingReview(fixture);
    const result = yield* fixture.controller.write(recordArgs(fixture, request.id, "insufficient_evidence", "unproven", {reason: "The test log is missing."}));
    assert.equal(result.status, "pending");
    assert.equal((yield* storedRequest(fixture, request.id))?.reviewOutcome, undefined);
  } finally {yield* fixture.close;}
}));
