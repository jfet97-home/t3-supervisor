import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import type { WorkflowIntroduction } from "../src/supervisor-conversation-store.js";
import { testSummary } from "./project-definitions-fixture.js";
import {
  addSupervisorRequest, appendSourceMessage, completeSupervisorRequest, definitionSnapshot, makeWorkflowFixture, projectId,
  sourceMessageId, sourceThreadId, submitAndComplete, unavailableDefinitionSnapshot,
} from "./support/ctl-workflow.js";

// the interpretation fields a root submits for the export task
const workflowFields = (messageId: string): Record<string, unknown> => ({
  objective: "Implement the export workflow",
  reason: "The source conversation requests an export implementation.",
  sourceMessageIds: [messageId],
  supervision: "needed",
  workflow: {
    requirements: [{kind: "step", id: "test-plan", applies: true, reason: "The change needs a focused behavior check."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: "test-plan", reason: "Verify the export behavior with a regression test."}]},
  },
});

const objectiveResponse = (messageId: string): string => JSON.stringify({
  objective: "Implement the export workflow",
  reason: "The source conversation requests an export implementation.",
  sourceMessageIds: [messageId],
});

const provisionalWorkflowFields = (messageId: string): Record<string, unknown> => ({
  objective: "Implement the export workflow",
  reason: "The source conversation requests an export implementation.",
  sourceMessageIds: [messageId],
  supervision: "needed",
  workflow: {
    requirements: [],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "bounded-review", name: "Review available context",
      description: "State what remains unknown while making a finite plan.", reason: "The definition read is unavailable."}]},
  },
});

it.effect("dispatch uses complete definitions from the operative source worktree", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;

  const task = yield* fixture.task();
  const binding = yield* fixture.binding();
  const dispatch = fixture.dispatches()[0]?.payload;
  assert.ok(task && binding && dispatch);
  assert.equal(task.status, "waiting");
  assert.equal(fixture.definitionReads.length, 1);
  assert.deepEqual(fixture.definitionReads[0], { projectId, threadId: sourceThreadId });
  assert.equal(dispatch.threadId, binding.threadId);
  assert.equal(task.definitionContext?.workspaceRoot, "/work/project/worktrees/feature");
  assert.equal(task.definitionContext?.revision, "revision-1");
  const definitions = yield* supervisor.conversation.readContextView(binding, {view: "definitions"});
  const material = JSON.stringify(definitions);
  assert.match(material, /"workspaceRoot":"\/work\/project\/worktrees\/feature"/u);
  assert.match(material, /"revision":"revision-1"/u);
  assert.ok(material.includes(`"summary":${JSON.stringify(testSummary("test-plan"))}`));
  assert.doesNotMatch(String(dispatch.text), /"workspaceRoot":|"required":|"summary":/u, "the complete source-bound catalog stays pull-only");

}));

it.effect("a correlated native result appears in the project DTO without repeating or self-triggering work", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const task = yield* fixture.task();
  const binding = yield* fixture.binding();
  assert.ok(task && binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  yield* submitAndComplete(fixture, supervisor, task, workflowFields(task.sourceMessageId));

  yield* supervisor.cycle;
  const inferred = yield* fixture.task();
  assert.equal(inferred?.status, "inferred");
  assert.equal(inferred?.objective, "Implement the export workflow");
  assert.equal(inferred?.workflow?.status, "proposed");
  assert.equal(inferred?.workflow?.requirements[0]?.state, "included");
  assert.equal(inferred?.workflow?.plan?.nodes[0]?.kind, "step");
  if (inferred?.workflow?.plan?.nodes[0]?.kind === "step") assert.equal(inferred.workflow.plan.nodes[0].definitionId, "test-plan");

  const snapshot = yield* supervisor.snapshot(projectId, sourceThreadId);
  const dto = snapshot.tasks.find((candidate) => candidate.threadId === sourceThreadId);
  assert.equal(dto?.workflow?.status, "proposed");
  assert.equal(dto?.workflow?.revision, "revision-1");
  assert.deepEqual(dto?.workflow?.requirements.map(item => [item.kind, item.id, item.state]), [["step", "test-plan", "included"]]);
  assert.equal(dto?.workflow?.plan?.nodes[0]?.kind, "step");

  yield* supervisor.cycle;
  assert.equal(fixture.dispatches().length, 1);
  // the proposal is handled in its interpretation's completion cycle, so no unsent proposal waits for a separate definition observation
  assert.ok(yield* supervisor.conversation.requests.introduction((yield* fixture.task())!.id), "the proposal was handled in its completion cycle");
  assert.equal(fixture.definitionReads.length, 2, "only preparation and completed-result revalidation load definitions");
  assert.equal(yield* fixture.store.task(binding.threadId), null, "the owned Supervisor conversation is not a new source task");
}));

it.effect("changed or non-ready definitions stale the workflow while preserving the inferred objective", () => Effect.gen(function* () {
  const variants: Array<{ name: string; snapshot: ProjectDefinitionSnapshot }> = [
    { name: "revision", snapshot: definitionSnapshot({ revision: "revision-2" }) },
    { name: "worktree", snapshot: definitionSnapshot({ workspaceRoot: "/work/project/worktrees/other" }) },
    { name: "permission", snapshot: definitionSnapshot({ status: "permission_required" }) },
    { name: "invalid", snapshot: definitionSnapshot({ status: "invalid" }) },
  ];

  for (const variant of variants) {
    const fixture = yield* makeWorkflowFixture();
    const supervisor = yield* fixture.makeSupervisor();
    yield* supervisor.cycle;
    const task = yield* fixture.task();
    const binding = yield* fixture.binding();
    assert.ok(task && binding, variant.name);
    const native = fixture.projections.get(binding.threadId);
    assert.ok(native, variant.name);
    fixture.setDefinitions(variant.snapshot);
    yield* submitAndComplete(fixture, supervisor, task, workflowFields(task.sourceMessageId));

    yield* supervisor.cycle;
    const completed = yield* fixture.task();
    assert.equal(completed?.status, "inferred", variant.name);
    assert.equal(completed?.objective, "Implement the export workflow", variant.name);
    assert.equal(completed?.workflow?.status, "stale", variant.name);
    assert.ok(completed?.workflow?.plan?.nodes.length, variant.name);
    assert.equal(completed?.revalidationAttempts ?? 0, 0, variant.name);
  }
}), { timeout: 60_000 });

it.effect("a transient preparation read failure recovers across Supervisor instances and dispatches once", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  fixture.setDefinitionReadOutcomes([new Error("temporary filesystem read failure"), definitionSnapshot()]);

  yield* (yield* fixture.makeSupervisor()).cycle;
  const queued = yield* fixture.task();
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.definitionReadAttempts, 1);
  assert.equal(fixture.dispatches().length, 0);

  yield* (yield* fixture.makeSupervisor()).cycle;
  const waiting = yield* fixture.task();
  assert.equal(waiting?.status, "waiting");
  assert.equal(waiting?.definitionReadAttempts, 1);
  assert.equal(waiting?.definitionContext?.revision, "revision-1");
  assert.equal(fixture.dispatches().length, 1);
  assert.match(String(fixture.dispatches()[0]?.payload.text), /UNTRUSTED_WORKFLOW_ENVELOPE/u);

  yield* (yield* fixture.makeSupervisor()).cycle;
  assert.equal(fixture.definitionReads.length, 2);
  assert.equal(fixture.dispatches().length, 1, "preparation retry must not create duplicate native requests");
}));

it.effect("bounded unavailable preparation reads still dispatch a provisional workflow with unknown requirements", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  fixture.setDefinitionReadOutcomes([
    unavailableDefinitionSnapshot(),
    new Error("second temporary read failure"),
    unavailableDefinitionSnapshot(),
  ]);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    yield* (yield* fixture.makeSupervisor()).cycle;
    const task = yield* fixture.task();
    assert.equal(task?.definitionReadAttempts, attempt);
    if (attempt < 3) {
      assert.equal(task?.status, "queued");
      assert.equal(fixture.dispatches().length, 0);
    }
  }

  const dispatched = yield* fixture.task();
  const request = fixture.dispatches()[0]?.payload.text;
  assert.equal(dispatched?.status, "waiting");
  assert.equal(dispatched?.workflow ?? null, null, "preparation is not an operative proposal");
  assert.equal(dispatched?.definitionContext?.status, "unavailable");
  assert.equal(dispatched?.definitionContext?.complete, false);
  assert.equal(dispatched?.definitionContext?.requirementsKnown, false);
  assert.equal(dispatched?.definitionContext?.revision, null);
  assert.match(String(request), /UNTRUSTED_WORKFLOW_ENVELOPE/u);
  assert.doesNotMatch(String(request), /"requirementsKnown"/u, "unknown definition details stay in the source-bound reader");
  assert.equal(fixture.dispatches().length, 1);

  const binding = yield* fixture.binding();
  assert.ok(binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  assert.equal((yield* fixture.store.tasks(projectId)).filter((task) => task.status === "queued").length, 0);
  yield* submitAndComplete(fixture, null, dispatched!, provisionalWorkflowFields(dispatched!.sourceMessageId));
  yield* (yield* fixture.makeSupervisor()).cycle;
  assert.equal((yield* fixture.task())?.status, "inferred");
  assert.equal((yield* fixture.task())?.workflow?.status, "stale");
  assert.equal((yield* fixture.task())?.workflow?.requirementsKnown, false);
  assert.ok((yield* fixture.task())?.workflow?.plan?.nodes.length);
  assert.equal(fixture.dispatches().length, 1);
}));

it.effect("a known unavailable completion read stales the proposal without redispatch", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  yield* (yield* fixture.makeSupervisor()).cycle;
  const task = yield* fixture.task();
  const binding = yield* fixture.binding();
  assert.ok(task && binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  yield* submitAndComplete(fixture, null, task, workflowFields(task.sourceMessageId));
  fixture.setDefinitionReadOutcomes([unavailableDefinitionSnapshot()]);

  yield* (yield* fixture.makeSupervisor()).cycle;
  const stale = yield* fixture.task();
  assert.equal(stale?.status, "inferred");
  assert.equal(stale?.objective, "Implement the export workflow");
  assert.equal(stale?.revalidationAttempts ?? 0, 0);
  assert.equal(stale?.workflow?.status, "stale");
  assert.ok(stale?.workflow?.plan?.nodes.length);
  assert.equal(fixture.dispatches().length, 1);
  assert.ok(yield* (yield* fixture.makeSupervisor()).conversation.requests.introduction((yield* fixture.task())!.id), "the stale proposal was handled in its completion cycle");
  assert.equal(fixture.definitionReads.length, 2, "only preparation and completion revalidation read definitions");
}));

it.effect("three transient completion read failures stale only the proposal and preserve the objective", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  yield* (yield* fixture.makeSupervisor()).cycle;
  const task = yield* fixture.task();
  const binding = yield* fixture.binding();
  assert.ok(task && binding);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  yield* submitAndComplete(fixture, null, task, workflowFields(task.sourceMessageId));
  fixture.setDefinitionReadOutcomes([
    new Error("first revalidation failure"),
    new Error("second revalidation failure"),
    new Error("third revalidation failure"),
  ]);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    yield* (yield* fixture.makeSupervisor()).cycle;
    const current = yield* fixture.task();
    assert.equal(current?.revalidationAttempts, attempt);
    if (attempt < 3) {
      assert.equal(current?.status, "waiting");
      assert.equal(current?.objective, null);
      assert.equal(current?.workflow ?? null, null, "pending interpretation stays separate from the plan");
    }
  }

  const stale = yield* fixture.task();
  assert.equal(stale?.status, "inferred");
  assert.equal(stale?.objective, "Implement the export workflow");
  assert.equal(stale?.workflow?.status, "stale");
  assert.ok(stale?.workflow?.plan?.nodes.length);
  assert.match(stale?.workflow?.message ?? "", /could not be revalidated/u);
  assert.equal(fixture.dispatches().length, 1);
  assert.ok(yield* (yield* fixture.makeSupervisor()).conversation.requests.introduction((yield* fixture.task())!.id), "the stale proposal was handled in its completion cycle");
  assert.equal(fixture.definitionReads.length, 4, "preparation plus exactly the three bounded revalidation attempts read definitions");
}));

it.effect("interrupted and definitively rejected requests clear pending workflow proposals", () => Effect.gen(function* () {
  const interruptedFixture = yield* makeWorkflowFixture();
  const interruptedSupervisor = yield* interruptedFixture.makeSupervisor();
  yield* interruptedSupervisor.cycle;
  const interruptedTask = yield* interruptedFixture.task();
  const interruptedBinding = yield* interruptedFixture.binding();
  assert.ok(interruptedTask && interruptedBinding);
  const interruptedNative = interruptedFixture.projections.get(interruptedBinding.threadId);
  assert.ok(interruptedNative);
  const interruptedRun = interruptedNative.runs.find((run) => run.userMessageId === interruptedTask.messageId);
  assert.ok(interruptedRun);
  interruptedRun.status = "interrupted";

  yield* interruptedSupervisor.cycle;
  const interrupted = yield* interruptedFixture.task();
  assert.equal(interrupted?.status, "unavailable");
  assert.equal(interrupted?.workflow ?? null, null);

  const rejectedFixture = yield* makeWorkflowFixture();
  rejectedFixture.setDispatchFailure("rejected");
  yield* (yield* rejectedFixture.makeSupervisor()).cycle;
  const rejected = yield* rejectedFixture.task();
  assert.equal(rejected?.status, "unavailable");
  assert.equal(rejected?.workflow ?? null, null);
  assert.match(rejected?.reason ?? "", /definitively rejected/u);
}), { timeout: 60_000 });

it.effect("unknown dispatch retry reuses the persisted request and definition context", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  fixture.setDispatchFailure("unknown");
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const uncertain = yield* fixture.task();
  const binding = yield* fixture.binding();
  assert.ok(uncertain && binding);
  assert.equal(uncertain.status, "uncertain");
  const originalText = fixture.dispatches()[0]?.payload.text;
  const originalContext = uncertain.definitionContext;
  assert.ok(originalText && originalContext);

  fixture.setDefinitions(definitionSnapshot({ revision: "mutated-revision", workspaceRoot: "/work/project/worktrees/mutated" }));
  const retry = yield* supervisor.retry({
    projectId,
    mainThreadId: binding.mainThreadId,
    expectedGeneration: 0,
    threadId: binding.threadId,
    bindingGeneration: binding.generation,
    action: "retry",
  });

  const dispatches = fixture.dispatches();
  assert.equal(retry.status, "saved");
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[1]?.payload.text, originalText);
  assert.equal(dispatches[1]?.payload.messageId, dispatches[0]?.payload.messageId);
  assert.equal(dispatches[1]?.payload.commandId, dispatches[0]?.payload.commandId);
  assert.deepEqual((yield* fixture.task())?.definitionContext, originalContext);
  assert.equal(fixture.definitionReads.length, 1, "retry must not reread mutated project definitions");
}));

it.effect("persisted objective-only records are not backfilled or replayed", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  yield* (yield* fixture.makeSupervisor(false)).cycle;
  const queued = yield* fixture.task();
  const binding = yield* fixture.binding();
  assert.ok(queued && binding);
  const legacyText = "Interpret this previously persisted objective-only task.";
  const legacyTask = {...queued, status: "waiting" as const, requestText: legacyText, dispatchedAt: Date.now()};
  yield* fixture.store.saveTask(legacyTask);
  const native = fixture.projections.get(binding.threadId);
  assert.ok(native);
  addSupervisorRequest(native, {threadId: binding.threadId, messageId: legacyTask.messageId, text: legacyText});
  assert.equal(legacyTask.status, "waiting");
  assert.equal(legacyTask.definitionContext, null);
  assert.equal(legacyTask.workflow, undefined);

  const definitionsEnabledSupervisor = yield* fixture.makeSupervisor();
  yield* definitionsEnabledSupervisor.cycle;
  assert.equal(fixture.definitionReads.length, 0, "the persisted in-flight request is not prepared again");
  // an in-flight record without a typed attempt has no recorded submission: its final chat answer is never applied (typed
  // protocol; the old final-chat parser applied it as inferred)
  completeSupervisorRequest(native, legacyTask.messageId, objectiveResponse(legacyTask.sourceMessageId));
  yield* definitionsEnabledSupervisor.cycle;

  const completed = yield* fixture.task();
  assert.equal(completed?.status, "unavailable");
  assert.equal(completed?.reason, "The Supervisor did not submit a valid, source-linked interpretation.");
  assert.equal(completed?.objective, null);
  assert.equal(completed?.workflow, null);
  yield* definitionsEnabledSupervisor.cycle;
  assert.equal(fixture.definitionReads.length, 0, "a completed objective-only record remains unchanged");
  assert.equal(native.runs.length, 1, "reconciliation does not replay the prior native request");
  assert.equal(fixture.dispatches().length, 0, "the synthetic historical request is not dispatched again");
}));

it.effect("a link-only request stays context for the next genuine request instead of being replaced by a bootstrap instruction", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const source = fixture.projections.get(sourceThreadId)!;
  source.messages[0]!.text = "https://issues.example/browse/PROJ-1";
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const first = (yield* fixture.task())!;
  yield* submitAndComplete(fixture, supervisor, first, {objective: null, reason: "Only an issue link was supplied.", sourceMessageIds: [],
    supervision: "needed", workflow: null});
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())?.status, "needs_context");

  appendSourceMessage(source, "bootstrap-message", 2, "Recover the failed worktree manually with Nix, then continue.");
  yield* supervisor.cycle;
  const second = (yield* fixture.task())!;
  assert.equal(second.sourceMessageId, "bootstrap-message");
  assert.deepEqual(second.contextMessageIds, [sourceMessageId], "the unresolved link stays part of the task");
  const dispatched = String(fixture.dispatches().at(-1)?.payload.text);
  assert.ok(dispatched.includes(JSON.stringify([{messageId: sourceMessageId, text: "https://issues.example/browse/PROJ-1"}])),
    "the interpretation sees the original request beside the bootstrap instruction");
  assert.match(dispatched, /Earlier unresolved requests remain part of the task/u);
}));

it.effect("a semantic not-needed decision is persisted without negotiation and the next genuine request is reconsidered", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const source = fixture.projections.get(sourceThreadId)!;
  source.messages[0]!.text = "Thank the colleague for the documents and ask for the missing one.";
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const first = (yield* fixture.task())!;
  yield* submitAndComplete(fixture, supervisor, first, {objective: "Thank the colleague and ask for the missing document",
    reason: "A short self-contained message with no workflow obligations.", sourceMessageIds: [sourceMessageId], supervision: "not_needed", workflow: null});
  yield* supervisor.cycle;
  const decided = (yield* fixture.task())!;
  assert.equal(decided.status, "inferred");
  assert.equal(decided.supervision, "not_needed");
  assert.equal(decided.objective, "Thank the colleague and ask for the missing document");
  assert.equal(decided.workflow?.plan ?? null, null);
  yield* supervisor.cycle;
  assert.equal(fixture.dispatches().length, 1, "a not-needed task gets no initialization, introduction or negotiation");

  appendSourceMessage(source, "substantive-message", 2, "Now implement the export retry policy in the service.");
  yield* supervisor.cycle;
  const next = (yield* fixture.task())!;
  assert.equal(next.sourceMessageId, "substantive-message");
  assert.deepEqual(next.contextMessageIds, [sourceMessageId], "the same conversation remains observable after a temporary triviality verdict");
  assert.equal(fixture.dispatches().length, 2, "a later genuine request is interpreted again in the same Supervisor conversation");
  assert.equal(fixture.dispatches().at(-1)?.payload.threadId, (yield* fixture.binding())!.threadId);
}));

it.effect("after an explicit Enable only a request written after it is interpreted", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const source = fixture.projections.get(sourceThreadId)!;
  source.messages[0]!.text = "Thank the colleague for the documents and ask for the missing one.";
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const first = (yield* fixture.task())!;
  yield* submitAndComplete(fixture, supervisor, first, {objective: "Thank the colleague and ask for the missing document",
    reason: "A short self-contained message with no workflow obligations.", sourceMessageIds: [sourceMessageId], supervision: "not_needed", workflow: null});
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.status, "inferred");
  // a request the human wrote while supervision was stopped, then an explicit Enable
  appendSourceMessage(source, "stopped-period-request", 2, "Now implement the export retry policy in the service.");
  const written = Date.parse(source.messages.at(-1)!.createdAt);
  yield* supervisor.store.recordChatEnable(sourceThreadId, written + 1_000);
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.sourceMessageId, sourceMessageId, "the stopped-period request is not the next request");
  assert.equal(fixture.dispatches().length, 1);
  appendSourceMessage(source, "after-enable-request", 3, "Also add a retry test.");
  source.messages.at(-1)!.createdAt = new Date(written + 2_000).toISOString();
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.sourceMessageId, "after-enable-request");
  assert.equal(fixture.dispatches().length, 2);
}));

it.effect("a request queued or sent before an explicit Enable is never interpreted after it", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const source = fixture.projections.get(sourceThreadId)!;
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const first = (yield* fixture.task())!;
  const dispatched = fixture.dispatches().length;
  // the stop put an undispatched interpretation back in the queue; the human then enabled supervision again
  const store = supervisor.store;
  yield* store.saveTask({...first, status: "queued", dispatchedAt: null, messageId: `${first.messageId}-requeued`, reason: "Supervision was stopped for this chat before dispatch; this task identity remains unsent."});
  yield* store.recordChatEnable(sourceThreadId, Date.parse(source.messages[0]!.createdAt) + 1_000);
  const native = fixture.projections.get((yield* fixture.binding())!.threadId)!;
  for (const run of native.runs) run.status = "completed";
  native.thread.activeRunId = null;
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.status, "expired");
  assert.equal(fixture.dispatches().length, dispatched, "nothing is dispatched for the request written before the Enable");
  // an interpretation sent before the Enable whose exact native run has ended is closed unapplied, never applied or resent
  yield* store.saveTask({...first, status: "waiting", dispatchedAt: Date.parse(source.messages[0]!.createdAt), replayCount: 0});
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.status, "expired");
  assert.equal((yield* fixture.task())!.objective, null);
  assert.equal(fixture.dispatches().length, dispatched, "a pre-Enable interpretation is never resent");
}));

it.effect("an interpretation sent before an explicit Enable with no native outcome keeps its identity and is never closed, replayed or applied", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const source = fixture.projections.get(sourceThreadId)!;
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const first = (yield* fixture.task())!;
  const dispatched = fixture.dispatches().length;
  const store = supervisor.store;
  yield* store.recordChatEnable(sourceThreadId, Date.parse(source.messages[0]!.createdAt) + 1_000);
  const native = fixture.projections.get((yield* fixture.binding())!.threadId)!;
  for (const run of native.runs) run.status = "completed";
  native.thread.activeRunId = null;
  // absence of a native run is not proof of non-delivery, whether or not the identity carries its dispatch time
  for (const [suffix, dispatchedAt] of [["lost", Date.parse(source.messages[0]!.createdAt)], ["undated", null]] as const) {
    const held = {...first, status: "uncertain" as const, messageId: `${first.messageId}-${suffix}`, dispatchedAt, replayCount: 0};
    yield* store.saveTask(held);
    for (let cycle = 0; cycle < 3; cycle++) yield* supervisor.cycle;
    assert.equal((yield* fixture.task())!.status, "uncertain", suffix);
    assert.equal((yield* fixture.task())!.messageId, held.messageId, suffix);
    assert.equal(fixture.dispatches().length, dispatched, `${suffix}: nothing is resent`);
  }
  // a native message with this identity but other request text is not its outcome
  yield* store.saveTask({...first, status: "waiting", requestText: `${first.requestText} (changed)`, dispatchedAt: null, replayCount: 0});
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.status, "waiting");
  assert.equal(fixture.dispatches().length, dispatched);
}));

it.effect("an interpretation in flight across a project re-enable boundary at its source is never applied or resent", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const first = (yield* fixture.task())!;
  const dispatched = fixture.dispatches().length;
  const store = supervisor.store;
  // the project was disabled and enabled again with its boundary at the request's own run while the interpretation was in flight
  yield* store.saveControl(projectId, (yield* store.control(projectId)).generation, false);
  yield* store.saveControl(projectId, (yield* store.control(projectId)).generation, true, {snapshotSequence: 11, threads: [{id: sourceThreadId, latestRunId: first.sourceRunId}]});
  const native = fixture.projections.get((yield* fixture.binding())!.threadId)!;
  for (const run of native.runs) run.status = "completed";
  native.thread.activeRunId = null;
  // an identity with no native outcome stays held and is never resent
  yield* store.saveTask({...first, status: "uncertain", messageId: `${first.messageId}-lost`, replayCount: 0});
  for (let cycle = 0; cycle < 3; cycle++) yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.status, "uncertain");
  assert.equal((yield* fixture.task())!.messageId, `${first.messageId}-lost`);
  assert.equal(fixture.dispatches().length, dispatched, "nothing is resent across the boundary");
  // its exact native run has ended: it closes unapplied
  yield* store.saveTask({...first, status: "waiting", replayCount: 0});
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.status, "expired");
  assert.equal((yield* fixture.task())!.objective, null);
  assert.equal(fixture.dispatches().length, dispatched);
}));

it.effect("a queued request at or before the project activation boundary is never interpreted", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const first = (yield* fixture.task())!;
  const dispatched = fixture.dispatches().length;
  const store = supervisor.store;
  yield* store.saveTask({...first, status: "queued", dispatchedAt: null, messageId: `${first.messageId}-requeued`, reason: "Supervision was disabled before dispatch; this task identity remains queued."});
  // the project was disabled and enabled again with its boundary at the request's own run
  yield* store.saveControl(projectId, (yield* store.control(projectId)).generation, false);
  yield* store.saveControl(projectId, (yield* store.control(projectId)).generation, true, {snapshotSequence: 11, threads: [{id: sourceThreadId, latestRunId: first.sourceRunId}]});
  const native = fixture.projections.get((yield* fixture.binding())!.threadId)!;
  for (const run of native.runs) run.status = "completed";
  native.thread.activeRunId = null;
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.status, "expired");
  assert.equal(fixture.dispatches().length, dispatched, "nothing is dispatched for a request before the boundary");
}));

it.effect("the interpretation request carries the concise standing role once, permits reader discovery wrappers and decides relevance before definitions", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const task = (yield* fixture.task())!;
  const text = String(fixture.dispatches()[0]?.payload.text);
  assert.ok(task.roleVersion, "the root's first message carries the standing role");
  const occurrences = (part: string) => text.split(part).length - 1;
  assert.equal(occurrences("Never restate a human request"), 1);
  assert.equal(occurrences("Thread tools: load this environment"), 1, "the standing role carries the local routing rule once");
  assert.equal(occurrences(`Standing instructions version ${task.roleVersion}.`), 1);
  assert.match(text, /Only local t3-code t3_thread_read\/t3_thread_send/u);
  assert.match(text, /MCPX mcpx_call_tool may invoke them/u);
  assert.match(text, /Decide relevance before definitions/u);
  assert.match(text, /freshly read your own local thread and cite the latest exact human message/u);
  assert.match(text, /Never reuse an earlier Stop ID/u);
  const envelope = JSON.parse(text.slice(text.indexOf("UNTRUSTED_WORKFLOW_ENVELOPE\n") + "UNTRUSTED_WORKFLOW_ENVELOPE\n".length, text.indexOf("\nEND_UNTRUSTED_WORKFLOW_ENVELOPE")));
  assert.deepEqual(envelope.reader, {supervisorThreadId: (yield* fixture.binding())!.threadId, bindingGeneration: (yield* fixture.binding())!.generation});
  const instructions = yield* supervisor.conversation.readContextView((yield* fixture.binding())!, {view: "interpretation"});
  assert.match(String(instructions.instructions), /configured required references alone never make a task needed/u);
  assert.match(String(instructions.instructions), /If you cannot invoke workflow_read, that says nothing about the project's definitions/u);
  // the typed protocol adds one bounded submission block with the quoted attempt; the rest of the request stays as concise as before
  const submission = text.slice(text.indexOf("SUBMISSION: "), text.indexOf("UNTRUSTED_WORKFLOW_ENVELOPE\n"));
  assert.match(submission, /supervision_interpretation_submit/u);
  assert.ok(submission.length < 1000, `submission block ${submission.length} characters`);
  // the standing role it carries once per instructions version includes the monitoring review duty and outcome rules (about 0.9 KB)
  assert.ok(text.length - submission.length < 7200, `interpretation request ${text.length - submission.length} characters without the submission block`);
  yield* submitAndComplete(fixture, supervisor, task, workflowFields(sourceMessageId));
  yield* supervisor.cycle;
  assert.equal((yield* fixture.binding())!.deliveredRoleVersion, task.roleVersion, "the completed interpretation delivered the standing role");
  assert.equal(yield* supervisor.conversation.interpretationRole((yield* fixture.binding())!), null, "later root messages carry no second copy");
}));

it.effect("an Enable or re-enable saved during the final awaits leaves the request undispatched and a finished result unapplied", () => Effect.gen(function* () {
  {
    const fixture = yield* makeWorkflowFixture();
    const supervisor = yield* fixture.makeSupervisor();
    // the Enable lands while the last read before dispatch is awaited, after the queued gate and definition preparation; the
    // hook's read and write run synchronously, before the read answers, as the baseline hook's did
    fixture.onModelsRead(() => Effect.gen(function* () {
      const queued = yield* fixture.store.task(sourceThreadId);
      if (queued?.status === "queued" && queued.definitionContext) yield* fixture.store.recordChatEnable(sourceThreadId, Date.now());
    }));
    yield* supervisor.cycle;
    assert.equal(fixture.dispatches().length, 0, "a request written before the Enable is never dispatched");
    assert.equal((yield* fixture.task())!.status, "expired");
  }
  {
    const fixture = yield* makeWorkflowFixture();
    const supervisor = yield* fixture.makeSupervisor();
    yield* supervisor.cycle;
    const first = (yield* fixture.task())!;
    yield* submitAndComplete(fixture, supervisor, first, workflowFields(sourceMessageId));
    const load = fixture.definitions.load;
    // the project is disabled and re-enabled with its boundary at the request's run while the finished result is revalidated; the
    // reads and writes run synchronously once the read has its value, as the baseline ones did
    fixture.definitions.load = (loadedProjectId, threadId) => Effect.gen(function* () {
      const value = yield* load(loadedProjectId, threadId);
      if ((yield* fixture.store.task(sourceThreadId))?.status === "waiting") {
        const disabled = yield* fixture.store.control(projectId);
        yield* fixture.store.saveControl(projectId, disabled.generation, false);
        const enabled = yield* fixture.store.control(projectId);
        yield* fixture.store.saveControl(projectId, enabled.generation, true, {snapshotSequence: 11, threads: [{id: sourceThreadId, latestRunId: first.sourceRunId}]});
      }
      return value;
    });
    yield* supervisor.cycle;
    assert.equal((yield* fixture.task())!.status, "expired", "the result is never applied across the boundary");
    assert.equal((yield* fixture.task())!.objective, null);
    assert.equal(fixture.dispatches().length, 1, "nothing is resent");
  }
}), { timeout: 60_000 });

it.effect("an earlier unresolved request carries forward only from the current supervision epoch", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const source = fixture.projections.get(sourceThreadId)!;
  source.messages[0]!.text = "https://issues.example/browse/PROJ-1";
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const first = (yield* fixture.task())!;
  yield* submitAndComplete(fixture, supervisor, first, {objective: null, reason: "Only an issue link was supplied.", sourceMessageIds: [],
    supervision: "needed", workflow: null});
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())?.status, "needs_context");
  // the human stopped and enabled supervision again after the link; the next request starts a new epoch
  const enabledAt = Date.parse(source.messages[0]!.createdAt) + 1_000;
  yield* supervisor.store.recordChatEnable(sourceThreadId, enabledAt);
  appendSourceMessage(source, "after-enable-message", 2, "Implement the export described in PROJ-1.");
  source.messages.at(-1)!.createdAt = new Date(enabledAt + 1_000).toISOString();
  yield* supervisor.cycle;
  const second = (yield* fixture.task())!;
  assert.equal(second.sourceMessageId, "after-enable-message");
  assert.equal(second.contextMessageIds, undefined, "a request from before the latest Enable never joins the new interpretation");
  assert.doesNotMatch(String(fixture.dispatches().at(-1)?.payload.text), /issues\.example/u);
}));

it.effect("after an Enable the chat's next request is interpreted afresh by the same Supervisor, even when an earlier task was interpreted", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const source = fixture.projections.get(sourceThreadId)!;
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const first = (yield* fixture.task())!;
  const rootId = (yield* fixture.binding())!.threadId;
  yield* submitAndComplete(fixture, supervisor, first, workflowFields(sourceMessageId));
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.status, "inferred");
  const interpretations = () => fixture.dispatches().filter(call => call.payload.threadId === rootId).length;
  const before = interpretations();
  // without an Enable, a follow-up in the same main stays part of the interpreted task
  appendSourceMessage(source, "follow-up-message", 2, "Please also keep the old export working.");
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.id, first.id);
  assert.equal(interpretations(), before + 1, "a later genuine requester message is interpreted on the same task");
  const followup = (yield* fixture.task())!;
  yield* submitAndComplete(fixture, supervisor, followup, workflowFields(followup.sourceMessageId));
  yield* supervisor.cycle;
  // after the human stops and enables supervision again, the next request gets a fresh interpretation in the same Supervisor
  const enabledAt = Date.now();
  yield* supervisor.store.recordChatEnable(sourceThreadId, enabledAt);
  appendSourceMessage(source, "after-enable-greeting", 3, "Hi, just checking in.");
  source.messages.at(-1)!.createdAt = new Date(enabledAt + 1_000).toISOString();
  yield* supervisor.cycle;
  const fresh = (yield* fixture.task())!;
  assert.notEqual(fresh.id, first.id);
  assert.equal(fresh.sourceMessageId, "after-enable-greeting");
  assert.equal(fresh.supervisorThreadId, first.supervisorThreadId);
  assert.equal(interpretations(), before + 2);
  assert.match(String(fixture.dispatches().at(-1)?.payload.text), /Hi, just checking in\./u);
}));

it.effect("across an Enable only an attempted introduction with an unknown outcome keeps its task; a known-unsent fallback does not hold the next request", () => Effect.gen(function* () {
  const priors: Record<string, Pick<WorkflowIntroduction, "state" | "error"> & Partial<WorkflowIntroduction>> = {
    uncertain: {state: "uncertain", dispatchMode: {type: "queue_after_active"}, definiteRejection: false, error: "Proposal delivery is uncertain."},
    acceptedUnobserved: {state: "blocked", dispatchMode: {type: "queue_after_active"}, acceptedAt: 1, error: "T3 accepted this introduction, but it was not found unchanged."},
    rejectedFallback: {state: "ready", dispatchMode: {type: "queue_after_active"}, error: null,
      rejectedAttempts: [{messageId: "supervisor-notice:workflow:steer", commandId: "supervisor-workflow:steer", dispatchMode: {type: "steer_active", targetRunId: "run-1"}}]},
  };
  for (const [name, prior] of Object.entries(priors)) {
    const fixture = yield* makeWorkflowFixture();
    const source = fixture.projections.get(sourceThreadId)!;
    const supervisor = yield* fixture.makeSupervisor();
    yield* supervisor.cycle;
    const first = (yield* fixture.task())!;
    yield* submitAndComplete(fixture, supervisor, first, workflowFields(sourceMessageId));
    yield* supervisor.cycle;
    const fallbackId = `supervisor-notice:workflow:${first.id}:queue`;
    yield* supervisor.conversation.requests.saveIntroduction({taskId: first.id, projectId, threadId: sourceThreadId, supervisorThreadId: first.supervisorThreadId,
      text: "Introduction of the earlier request.", messageId: fallbackId, commandId: `supervisor-workflow:${first.id}:queue`, targetRunId: null, ...prior});
    const enabledAt = Date.now();
    yield* supervisor.store.recordChatEnable(sourceThreadId, enabledAt);
    appendSourceMessage(source, "after-enable-request", 2, "Hi, just checking in.");
    source.messages.at(-1)!.createdAt = new Date(enabledAt + 1_000).toISOString();
    // the catalog names the main's latest run, as T3's does
    source.thread.latestRunId = "after-enable-request-run";
    yield* supervisor.cycle;
    if (name === "rejectedFallback") {
      assert.notEqual((yield* fixture.task())!.id, first.id, `${name}: the next request is interpreted afresh`);
      assert.equal((yield* fixture.task())!.sourceMessageId, "after-enable-request", name);
    } else {
      assert.equal((yield* fixture.task())!.id, first.id, `${name}: the unresolved introduction keeps its task`);
      assert.equal((yield* supervisor.conversation.requests.introduction(first.id))?.state, prior.state, name);
      // once the delivery is confirmed, the same pending request is interpreted, though the main has no newer run
      yield* supervisor.conversation.requests.saveIntroduction({...(yield* supervisor.conversation.requests.introduction(first.id))!, state: "sent", error: null});
      yield* supervisor.cycle;
      assert.notEqual((yield* fixture.task())!.id, first.id, `${name}: the held request is reconsidered after delivery is known`);
      assert.equal((yield* fixture.task())!.sourceMessageId, "after-enable-request", name);
    }
    assert.equal(fixture.dispatches().filter(call => call.payload.messageId === fallbackId).length, 0, `${name}: the earlier introduction is never sent after the Enable`);
  }
}), { timeout: 60_000 });

it.effect("the proposal is introduced in the same cycle its interpretation completes", () => Effect.gen(function* () {
  const fixture = yield* makeWorkflowFixture();
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.cycle;
  const task = (yield* fixture.task())!;
  // both conversations use native modes that permit Supervisor contact
  for (const projection of [fixture.projections.get(sourceThreadId)!, fixture.projections.get((yield* fixture.binding())!.threadId)!])
    Object.assign(projection.thread, {runtimeMode: "full-access", interactionMode: "default"});
  // and the operative has no pending owner question or approval
  (fixture.projections.get(sourceThreadId)! as {runtimeRequests?: unknown[]}).runtimeRequests = [];
  yield* submitAndComplete(fixture, supervisor, task, workflowFields(sourceMessageId));
  yield* supervisor.cycle;
  assert.equal((yield* fixture.task())!.status, "inferred");
  const introduction = fixture.dispatches().find(call => call.payload.threadId === sourceThreadId);
  assert.equal(introduction?.payload.messageId, `supervisor-notice:workflow:${task.id}:${task.sourceHash.slice(0, 20)}`, "the introduction goes out in the completion cycle");
}));
