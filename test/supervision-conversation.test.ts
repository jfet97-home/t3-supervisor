import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { deriveConversationEngagement } from "../src/supervision-conversation.js";
import { appendSourceMessage, makeWorkflowFixture, sourceMessageId, sourceThreadId, submitAndComplete } from "./support/ctl-workflow.js";
import type { ConversationDecision } from "../src/supervision-conversation-contract.js";
import { interpretationSubmitter } from "./support/g1a-conversation.js";
import { submissionArguments } from "./support/interpretation-submit.js";
import { projectId } from "./support/ctl-workflow.js";
import { WebSocketServer } from "ws";
import { loopbackOperate } from "./support/wwc-fixture.js";

const draft = {objective: "Understand the export retry race", constraints: ["Do not deploy"], questions: [], findings: [], duties: ["Explain the cause"]};
const decision = (extra: Partial<ConversationDecision> = {}): ConversationDecision => ({draft, intent: "following", outcome: null, limits: [],
  sourceMessageIds: [], antecedentMessageIds: [], scope: "changed", ...extra});
const research = (messageId: string) => ({objective: "Report the export retry race", reason: "The requester authorized a bounded investigation and report, without fixing it.",
  sourceMessageIds: [messageId], supervision: "needed", conversation: decision({intent: "authorize", outcome: "Report the export retry race", limits: ["Do not fix or deploy"], sourceMessageIds: [messageId]}),
  workflow: {requirements: [{kind: "step", id: "test-plan", applies: false, reason: "This is a research report; implementation tests are not requested."}],
    plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "report", name: "Report the cause", description: "Investigate the actual incident and explain the cause with evidence; do not change code.", reason: "This is the requested outcome."}]}}});

it.live("discussion remains quiet; later grants use distinct commands through the real native transport and resume the same task", () => Effect.gen(function* () {
  const f = yield* makeWorkflowFixture();
  const source = f.projections.get(sourceThreadId)!;
  source.runtimeRequests = [];
  source.thread.runtimeMode = "full-access"; source.thread.interactionMode = "default";
  source.messages[0]!.text = "Let's discuss why export is flaky before deciding; read code and logs as needed.";
  const peer = yield* Effect.acquireRelease(Effect.sync(() => new WebSocketServer({port: 0})), server => Effect.callback<void>(resume => {
    for (const client of server.clients) client.terminate();
    server.close(() => resume(Effect.void));
  }));
  yield* Effect.callback<void>(resume => {peer.once("listening", () => resume(Effect.void));});
  const address = peer.address();
  assert.ok(address && typeof address !== "string");
  let sequence = 0;
  peer.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(data.toString()) as { _tag: string; id: string; tag: string; payload: Record<string, unknown> };
    if (frame._tag === "Ping") {socket.send(JSON.stringify({_tag: "Pong"}));return;}
    if (frame._tag !== "Request") return;
    const result = f.handleNativeOperation(frame.tag, frame.payload);
    socket.send(JSON.stringify({_tag: "Exit", requestId: frame.id, exit: {_tag: "Success", value: frame.tag === "orchestration.dispatchCommand" ? {sequence: ++sequence} : result}}));
  }));
  const controller = yield* f.makeSupervisor(true, yield* loopbackOperate(`http://127.0.0.1:${address.port}`, "fixture-native-transport"));
  yield* controller.cycle;
  const first = (yield* f.task())!;
  const root = f.projections.get(first.supervisorThreadId)!;
  root.thread.runtimeMode = "full-access"; root.thread.interactionMode = "default";
  assert.match(first.requestText, /discussion with exploration stays quiet/u);
  yield* submitAndComplete(f, controller, first, {objective: draft.objective, reason: "Discussion before deciding", sourceMessageIds: [sourceMessageId], supervision: "not_needed", workflow: null, conversation: decision()});
  yield* controller.cycle;
  const following = (yield* f.task())!;
  assert.equal(following.supervision, "not_needed");
  assert.equal(following.workflow, null);
  assert.equal(following.conversation?.authorization, null);
  assert.deepEqual(deriveConversationEngagement({task: following, enabled: true, available: true}), {mode: "following", availability: "current", consideredAt: following.conversation!.updatedAt});
  assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 0);
  yield* controller.cycle;
  assert.equal(f.dispatches().length, 1, "quiet activity creates no routine check-in");
  appendSourceMessage(source, "research-request", 2, "Investigate this incident and report the cause; do not fix it.");
  yield* controller.cycle;
  const pending = (yield* f.task())!;
  assert.equal(pending.id, first.id);
  assert.equal(pending.sourceMessageId, "research-request");
  assert.ok(root.runs.some(run => run.userMessageId === pending.messageId), "the later requester gets its own native interpretation run");
  yield* submitAndComplete(f, controller, pending, research("research-request"));
  yield* controller.cycle;
  const engaged = (yield* f.task())!;
  assert.equal(engaged.supervision, "needed");
  assert.ok(engaged.workflow?.plan);
  assert.equal(engaged.conversation?.authorization?.state, "authorized");
  assert.equal(deriveConversationEngagement({task: engaged, enabled: true, available: true}).mode, "engaged");
  assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 1, JSON.stringify(yield* controller.conversation.requests.introduction(engaged.id)));
  appendSourceMessage(source, "pause-request", 3, "Wait, let's discuss whether a fix is needed.");
  yield* controller.cycle;
  const pause = (yield* f.task())!;
  assert.equal(pause.sourceMessageId, "pause-request", JSON.stringify({status: pause.status, intro: yield* controller.conversation.requests.introduction(pause.id), observed: pause.conversation?.observed}));
  assert.equal(pause.status, "waiting");
  const oldProposal = pause.workflowProposalId;
  const oldRevision = pause.conversation!.authorization!.scopeRevision;
  yield* submitAndComplete(f, controller, pause, {objective: draft.objective, reason: "Pause the task to discuss", sourceMessageIds: ["pause-request"], supervision: "not_needed", workflow: null,
    conversation: decision({intent: "pause"})});
  yield* controller.cycle;
  const paused = (yield* f.task())!;
  assert.equal(paused.id, first.id);
  assert.equal(paused.conversation!.authorization!.state, "paused");
  assert.equal(paused.conversation!.authorization!.scopeRevision, oldRevision);
  assert.equal(paused.workflowProposalId, oldProposal);
  const rootDispatches = f.dispatches().filter(call => call.payload.threadId === first.supervisorThreadId);
  assert.equal(new Set(rootDispatches.map(call => call.payload.commandId)).size, 3, "each interpretation has its own stable native command identity");
  assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 1);
  appendSourceMessage(source, "resume-request", 4, "Resume that same investigation and report; still do not fix or deploy.");
  yield* controller.cycle;
  const resume = (yield* f.task())!;
  yield* submitAndComplete(f, controller, resume, {...research("resume-request"), workflow: null,
    conversation: decision({intent: "resume", scope: "same", outcome: "Report the export retry race", limits: ["Do not fix or deploy"], sourceMessageIds: ["resume-request"]})});
  yield* controller.cycle;
  assert.equal((yield* f.task())!.conversation!.authorization!.state, "authorized");
  assert.equal((yield* f.task())!.workflowProposalId, oldProposal);
  assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 1, "same-scope resume never reintroduces the plan");
  assert.equal(f.dispatches().length, 5, "four requester interpretations and one introduction; no repeated operative contact or routine check-ins");
}));

const heldPlan = Effect.gen(function* () {
  const f = yield* makeWorkflowFixture();
  const source = f.projections.get(sourceThreadId)!;
  source.runtimeRequests = [];
  source.thread.runtimeMode = "full-access"; source.thread.interactionMode = "default";
  const controller = yield* f.makeSupervisor(true);
  yield* controller.cycle;
  const first = (yield* f.task())!;
  const root = f.projections.get(first.supervisorThreadId)!;
  root.thread.runtimeMode = "full-access"; root.thread.interactionMode = "plan";
  yield* submitAndComplete(f, controller, first, research(sourceMessageId));
  yield* controller.cycle;
  const retained = (yield* f.task())!;
  assert.ok(retained.workflow?.plan);
  assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 0, "native modes hold the first introduction");
  assert.match((yield* controller.conversation.requests.introduction(first.id))?.error ?? "", /native modes/u);
  root.thread.interactionMode = "default";
  return {f, source, controller, first, root, retained};
});

it.effect("same-scope pause and resume before first contact retain the plan's native evidence", () => Effect.gen(function* () {
  const {f, source, controller, first, retained} = yield* heldPlan;
  appendSourceMessage(source, "pause-before-contact", 2, "Wait, discuss this before starting.");
  yield* controller.cycle;
  yield* submitAndComplete(f, controller, (yield* f.task())!, {objective: draft.objective, reason: "Pause before contact", sourceMessageIds: ["pause-before-contact"], supervision: "needed", workflow: null,
    conversation: decision({intent: "pause"})});
  yield* controller.cycle;
  assert.equal((yield* f.task())!.conversation!.authorization!.state, "paused");
  assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 0);
  appendSourceMessage(source, "resume-before-contact", 3, "Resume the same report; do not fix or deploy.");
  yield* controller.cycle;
  yield* submitAndComplete(f, controller, (yield* f.task())!, {...research("resume-before-contact"), workflow: null,
    conversation: decision({intent: "resume", scope: "same", outcome: "Report the export retry race", limits: ["Do not fix or deploy"], sourceMessageIds: ["resume-before-contact"]})});
  yield* controller.conversation.retry(projectId, first.supervisorThreadId);
  yield* controller.cycle;
  const resumed = (yield* f.task())!;
  assert.equal(resumed.id, retained.id);
  assert.equal(resumed.workflowProposalId, retained.workflowProposalId);
  assert.deepEqual(resumed.interpretationEvidence, retained.interpretationEvidence);
  assert.deepEqual(resumed.conversation!.authorization!.scopeSources, retained.conversation!.authorization!.scopeSources);
  assert.equal(resumed.interpretationEvidence?.kind === "interpretation_submission" && resumed.interpretationEvidence.scopeRevision,
    resumed.conversation!.authorization!.scopeRevision);
  assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 1,
    JSON.stringify(yield* controller.conversation.requests.introduction(first.id)));
  yield* controller.cycle;
  assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 1, "retained evidence permits one introduction only");
}));

it.effect("retained first-contact proof rejects another scope, missing revision, altered grant, rolled-back tool and a newer requester", () => Effect.gen(function* () {
  for (const variant of ["changed_scope", "missing_revision", "grant_edited", "native_rollback", "newer_requester"] as const) {
    const {f, source, controller, first, root, retained} = yield* heldPlan;
    const changedScope = variant === "changed_scope";
    appendSourceMessage(source, "later-request", 2, changedScope ? "Instead, report deployment health; do not fix or deploy." : "How is the same investigation going?");
    yield* controller.cycle;
    yield* submitAndComplete(f, controller, (yield* f.task())!, {objective: changedScope ? "Report deployment health" : draft.objective,
      reason: "Consider the later requester", sourceMessageIds: ["later-request"], supervision: "not_needed", workflow: null,
      conversation: changedScope ? decision({intent: "authorize", outcome: "Report deployment health", limits: ["Do not fix or deploy"], sourceMessageIds: [sourceMessageId, "later-request"]}) : decision()});
    if (changedScope) {
      yield* controller.cycle;
      const changed = (yield* f.task())!;
      assert.notEqual(changed.conversation!.authorization!.scopeRevision, retained.conversation!.authorization!.scopeRevision);
      assert.deepEqual(changed.interpretationEvidence, retained.interpretationEvidence, "the historical plan remains reviewable");
      appendSourceMessage(source, "resume-changed-scope", 3, "Proceed with that deployment report; do not fix or deploy.");
      yield* controller.cycle;
      yield* submitAndComplete(f, controller, (yield* f.task())!, {...research("resume-changed-scope"), objective: "Report deployment health", workflow: null,
        conversation: decision({intent: "resume", scope: "same", outcome: "Report deployment health", limits: ["Do not fix or deploy"], sourceMessageIds: ["resume-changed-scope"]})});
    }
    if (variant === "missing_revision") {
      const task = (yield* f.task())!;
      const evidence = task.interpretationEvidence;
      assert.ok(evidence?.kind === "interpretation_submission");
      yield* f.store.saveTask({...task, interpretationEvidence: {...evidence, scopeRevision: undefined}});
    }
    if (variant === "grant_edited") source.messages[0]!.text = "The original grant was withdrawn.";
    if (variant === "native_rollback") root.turnItems!.find(item => item.id === (retained.interpretationEvidence?.kind === "interpretation_submission" ? retained.interpretationEvidence.itemId : ""))!.status = "rolled_back";
    if (variant === "newer_requester") appendSourceMessage(source, "newer-pause", 3, "Wait; do not start.");
    yield* controller.conversation.retry(projectId, first.supervisorThreadId);
    yield* controller.cycle;
    assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 0, variant);
  }
}));

it.effect("a later changed scope stamps its own plan before a same-scope pause and resume", () => Effect.gen(function* () {
  const {f, source, controller, first, root, retained} = yield* heldPlan;
  root.thread.interactionMode = "plan";
  appendSourceMessage(source, "second-grant", 2, "Investigate deployment recovery instead; report without fixing or deploying.");
  yield* controller.cycle;
  yield* submitAndComplete(f, controller, (yield* f.task())!, {...research("second-grant"), objective: "Report deployment recovery",
    conversation: decision({intent: "authorize", outcome: "Report deployment recovery", limits: ["Do not fix or deploy"], sourceMessageIds: ["second-grant"]})});
  yield* controller.cycle;
  const second = (yield* f.task())!;
  assert.notEqual(second.conversation!.authorization!.scopeRevision, retained.conversation!.authorization!.scopeRevision);
  assert.notEqual(second.workflowProposalId, retained.workflowProposalId);
  assert.equal(second.interpretationEvidence?.kind === "interpretation_submission" && second.interpretationEvidence.scopeRevision,
    second.conversation!.authorization!.scopeRevision);
  root.thread.interactionMode = "default";
  appendSourceMessage(source, "second-pause", 3, "Wait, discuss this first.");
  yield* controller.cycle;
  yield* submitAndComplete(f, controller, (yield* f.task())!, {objective: "Report deployment recovery", reason: "Pause the second scope", sourceMessageIds: ["second-pause"], supervision: "needed", workflow: null,
    conversation: decision({intent: "pause"})});
  yield* controller.cycle;
  appendSourceMessage(source, "second-resume", 4, "Resume that deployment report; do not fix or deploy.");
  yield* controller.cycle;
  yield* submitAndComplete(f, controller, (yield* f.task())!, {...research("second-resume"), objective: "Report deployment recovery", workflow: null,
    conversation: decision({intent: "resume", scope: "same", outcome: "Report deployment recovery", limits: ["Do not fix or deploy"], sourceMessageIds: ["second-resume"]})});
  yield* controller.conversation.retry(projectId, first.supervisorThreadId);
  yield* controller.cycle;
  assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 1);
  assert.equal((yield* f.task())!.workflowProposalId, second.workflowProposalId);
}));

it.effect("a concurrent dispatch under the same task id is never overwritten by discovery", () => Effect.gen(function* () {
  const f = yield* makeWorkflowFixture();
  const controller = yield* f.makeSupervisor();
  yield* controller.cycle;
  const first = (yield* f.task())!;
  yield* submitAndComplete(f, controller, first, research(sourceMessageId));
  yield* controller.cycle;
  appendSourceMessage(f.projections.get(sourceThreadId)!, "new-request", 2, "Now expand the report.");
  let changed = false;
  f.onModelsRead(() => Effect.gen(function* () {
    if (changed) return; changed = true;
    const task = (yield* f.task())!;
    yield* f.store.saveTask({...task, status: "waiting", messageId: "concurrently-dispatched", dispatchedAt: 42, supervisorRunId: "retained-native-run"});
  }));
  yield* controller.cycle;
  const retained = (yield* f.task())!;
  assert.equal(retained.messageId, "concurrently-dispatched");
  assert.equal(retained.dispatchedAt, 42);
  assert.equal(retained.supervisorRunId, "retained-native-run");
  assert.equal(retained.sourceMessageId, first.sourceMessageId);
}));

it.effect("a newer requester message rejects a grant at the actual typed intake before it reserves a receipt", () => Effect.gen(function* () {
  const f = yield* makeWorkflowFixture();
  const controller = yield* f.makeSupervisor();
  yield* controller.cycle;
  const task = (yield* f.task())!;
  appendSourceMessage(f.projections.get(sourceThreadId)!, "new-pause", 2, "Wait; do not start, let's discuss.");
  const submitter = yield* interpretationSubmitter({stores: f.stores, workflows: controller.workflows, projections: f.projections});
  const result = yield* submitter.submit(task, submissionArguments(task, research(sourceMessageId)));
  assert.equal(result.status, "stale");
  assert.equal((yield* f.task())!.conversation!.authorization, null);
  assert.equal(f.dispatches().filter(call => call.payload.threadId === sourceThreadId).length, 0);
  assert.equal((yield* f.stores.sql`SELECT count(*) AS n FROM supervisor_workflow_write_receipts WHERE operation_namespace='interpretation'`)[0]?.n, 0);
}));

it.effect("a neutral requester update retains participation and exact plan identity", () => Effect.gen(function* () {
  const f = yield* makeWorkflowFixture();
  const controller = yield* f.makeSupervisor();
  yield* controller.cycle;
  const first = (yield* f.task())!;
  yield* submitAndComplete(f, controller, first, research(sourceMessageId));
  yield* controller.cycle;
  const active = (yield* f.task())!;
  appendSourceMessage(f.projections.get(sourceThreadId)!, "neutral", 2, "How is it going?");
  yield* controller.cycle;
  const next = (yield* f.task())!;
  yield* submitAndComplete(f, controller, next, {objective: null, reason: "A neutral update within the existing task", sourceMessageIds: [],
    supervision: "not_needed", workflow: null, conversation: decision()});
  yield* controller.cycle;
  const kept = (yield* f.task())!;
  assert.equal(kept.status, "inferred");
  assert.equal(kept.conversation!.authorization!.state, "authorized");
  assert.equal(kept.workflowProposalId, active.workflowProposalId);
  assert.deepEqual(kept.workflow, active.workflow);
  assert.equal(kept.conversation!.authorization!.scopeRevision, active.conversation!.authorization!.scopeRevision);
}));

it.effect("a legitimate launching agent cannot lift a human pause, and its grant is never relabeled human", () => Effect.gen(function* () {
  const f = yield* makeWorkflowFixture();
  const settings = yield* f.store.settings(projectId);
  yield* f.store.saveSettings(projectId, settings.generation, settings.modelSelection, settings.monitoring, undefined, true);
  const enabledAt = (yield* f.store.settings(projectId)).agentCreatedThreadsEnabledAt!;
  const source = f.projections.get(sourceThreadId)!;
  source.thread.creationSource = "mcp";
  source.messages[0] = {...source.messages[0]!, createdBy: "agent", creationSource: "mcp", senderThreadId: "launcher", createdAt: new Date(enabledAt + 1).toISOString()};
  f.projections.set("launcher", {thread: {id: "launcher", title: "Coordinator", projectId, lineage: {parentThreadId: null, relationshipToParent: null}}, messages: [], runs: [], nodes: []});
  const controller = yield* f.makeSupervisor();
  yield* controller.cycle;
  const initial = (yield* f.task())!;
  yield* submitAndComplete(f, controller, initial, research(sourceMessageId));
  yield* controller.cycle;
  assert.equal((yield* f.task())!.conversation!.authorization!.scopeSources[0]!.requester, "launching_agent");
  appendSourceMessage(source, "human-pause", 2, "Pause the investigation; let's discuss.");
  yield* controller.cycle;
  yield* submitAndComplete(f, controller, (yield* f.task())!, {objective: draft.objective, reason: "The human paused participation", sourceMessageIds: ["human-pause"],
    supervision: "needed", workflow: null, conversation: decision({intent: "pause"})});
  yield* controller.cycle;
  appendSourceMessage(source, "agent-resume", 3, "Resume the investigation.");
  Object.assign(source.messages.at(-1)!, {createdBy: "agent", creationSource: "mcp", senderThreadId: "launcher", createdAt: new Date(enabledAt + 2).toISOString()});
  yield* controller.cycle;
  const attempted = (yield* f.task())!;
  const submitter = yield* interpretationSubmitter({stores: f.stores, workflows: controller.workflows, projections: f.projections});
  const result = yield* submitter.submit(attempted, submissionArguments(attempted, {...research("agent-resume"), workflow: null,
    conversation: decision({intent: "resume", scope: "same", outcome: "Report the export retry race", limits: ["Do not fix or deploy"], sourceMessageIds: ["agent-resume"]})}));
  assert.equal(result.status, "invalid");
  assert.equal((yield* f.task())!.conversation!.authorization!.state, "paused");
  assert.equal((yield* f.task())!.conversation!.authorization!.stateSource.requester, "human");
}));

it.effect("agent-created chat origin stays excluded while off, including every later genuine human follow-up", () => Effect.gen(function* () {
  const f = yield* makeWorkflowFixture();
  const main = f.projections.get(sourceThreadId)!;
  Object.assign(main.thread, {createdBy: "agent", creationSource: "mcp"});
  Object.assign(main.messages[0]!, {createdBy: "agent", creationSource: "mcp", senderThreadId: "launcher"});
  appendSourceMessage(main, "later-human", 2, "Implement the requested report now.");
  const controller = yield* f.makeSupervisor();
  yield* controller.cycle;
  appendSourceMessage(main, "later-human-again", 3, "I am the human; please investigate.");
  yield* controller.cycle;
  assert.equal(yield* f.task(), null);
  assert.equal((yield* f.store.bindings()).length, 0);
  assert.equal(f.dispatches().length, 0, "human follow-ups do not bypass the origin opt-in");
}));

it.effect("turning the origin opt-in off fences an existing human-authorized binding and retains its records", () => Effect.gen(function* () {
  const f = yield* makeWorkflowFixture();
  const settings = yield* f.store.settings(projectId);
  yield* f.store.saveSettings(projectId, settings.generation, settings.modelSelection, settings.monitoring, undefined, true);
  const main = f.projections.get(sourceThreadId)!;
  Object.assign(main.thread, {createdBy: "agent", creationSource: "mcp"});
  Object.assign(main.messages[0]!, {createdBy: "agent", creationSource: "mcp", senderThreadId: "launcher"});
  f.projections.set("launcher", {thread: {id: "launcher", title: "Coordinator", projectId, lineage: {parentThreadId: null, relationshipToParent: null}}, messages: [], runs: [], nodes: []});
  appendSourceMessage(main, "human-authorized", 2, "Investigate and report the cause; do not fix.");
  const controller = yield* f.makeSupervisor();
  yield* controller.cycle;
  const pending = (yield* f.task())!;
  yield* submitAndComplete(f, controller, pending, research("human-authorized"));
  yield* controller.cycle;
  const before = (yield* f.task())!;
  assert.equal(before.conversation!.authorization!.scopeSources[0]!.requester, "human");
  const saved = yield* f.store.settings(projectId);
  yield* f.store.saveSettings(projectId, saved.generation, saved.modelSelection, saved.monitoring, undefined, false);
  const sends = f.dispatches().length;
  appendSourceMessage(main, "human-after-off", 3, "Continue with the work.");
  yield* controller.cycle;yield* controller.cycle;
  assert.equal(f.dispatches().length, sends);
  assert.deepEqual(yield* f.task(), before, "ineligible work is inactive, not reset or discarded");
  assert.equal((yield* controller.snapshot(projectId, sourceThreadId)).chatSupervision?.effectiveEnabled, false);
}));
