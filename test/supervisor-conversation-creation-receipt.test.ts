import assert from "node:assert/strict";
import { Context, Effect, Fiber } from "effect";
import { it, type TestContext } from "vitest";
import { after, mockMethod } from "./support/node-test.js";
import { withDeadline } from "./support/c1-loopback.js";
import type { BindingRecord } from "../src/project-supervisor-store.js";
import type { ConversationRequest, WorkflowIntroduction } from "../src/supervisor-conversation-store.js";
import { SupervisorConversation, workflowIntroductionText } from "../src/supervisor-conversation.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { appendMessageToRun, appendRun, baseTime, makeFixture, operativeThreadId, projectId, type Fixture, type RpcCall } from "./support/c1-conversation-fixture.js";

// target regressions of the introduction and root check-in receipts (S6b): every write a public caller makes from what it
// read earlier (a creation, a native-modes refusal, an unavailable or blocked record, a reconciled check-in) happens only
// while the stored record is still exactly that read, so a send another caller recorded meanwhile keeps its unknown receipt,
// identities, body and route, Retry never deletes or resets it, and nothing initiates it again

const isIntroduction = (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === operativeThreadId;
const binding = async /*s6d*/ (fixture: Fixture): Promise<BindingRecord> => (await fixture.projectStore.binding(projectId, operativeThreadId))!;
const introduction = async /*s6d*/ (fixture: Fixture): Promise<WorkflowIntroduction | null> => await fixture.conversation.requests.introduction(fixture.task.id);
// the attempt's identities, body and route
const attempt = (value: WorkflowIntroduction | null) => value && {state: value.state, messageId: value.messageId, commandId: value.commandId ?? null,
  text: value.text, dispatchMode: value.dispatchMode ?? null, targetRunId: value.targetRunId, definiteRejection: value.definiteRejection ?? null};

// holds the first projection read of one thread until released
const holdFirstRead = (t: TestContext, fixture: Fixture, threadId: string) => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  after(t, () => release.resolve());
  const read = fixture.conversation.projection;
  let held = false;
  mockMethod(t, fixture.conversation, "projection", async (id: string, signal: AbortSignal) => {
    if (id === threadId && !held) {
      held = true;
      arrived.resolve();
      await release.promise;
    }
    return read(id, signal);
  });
  return {arrived: () => withDeadline(arrived.promise, 3_000, "the held read"), release: () => release.resolve()};
};

// the reports' sequence on the public service: an older run found no introduction and is held at its operative read with a
// Supervisor snapshot whose modes cannot contact the operative; a newer run creates the introduction, posts it and records an
// unknown outcome; then the older run resumes
const staleRefusalOverUnknown = async (t: TestContext, fixture: Fixture) => {
  const conversation = Context.get(fixture.conversation.context, SupervisorConversation);
  const read = holdFirstRead(t, fixture, operativeThreadId);
  fixture.intercept(call => isIntroduction(call) ? Promise.reject(new SupervisorRpcError("uncertain")) : null);
  const stale = structuredClone(fixture.supervisor);
  stale.thread.interactionMode = "plan";
  const older = Effect.runFork(conversation.run(await binding(fixture), stale, fixture.threadList));
  await read.arrived();
  await withDeadline(Effect.runPromise(conversation.run(await binding(fixture), fixture.supervisor, fixture.threadList)), 3_000, "the newer run");
  const unknown = await introduction(fixture);
  read.release();
  await withDeadline(Effect.runPromise(Fiber.join(older)), 3_000, "the older run");
  fixture.intercept(null);
  return {conversation, unknown, afterStale: await introduction(fixture)};
};

it("S6b-CONV-07: a stale native-modes refusal never overwrites the unknown introduction another public run recorded; Retry keeps it and the next run initiates nothing", {timeout: 10_000}, async t => {
  const fixture = await makeFixture({now: baseTime});
  after(t, fixture.cleanup);
  const {conversation, unknown, afterStale} = await staleRefusalOverUnknown(t, fixture);
  await fixture.conversation.retry(projectId, (await binding(fixture)).threadId);
  const afterRetry = await introduction(fixture);
  await withDeadline(Effect.runPromise(conversation.run(await binding(fixture), fixture.supervisor, fixture.threadList)), 3_000, "the next run");

  assert.equal(fixture.calls.filter(isIntroduction).length, 1, "one native initiation in total");
  assert.equal(unknown?.state, "uncertain");
  assert.equal(unknown?.definiteRejection, false);
  assert.deepEqual(afterStale, unknown, "the stale refusal leaves the unknown receipt exactly as recorded");
  assert.deepEqual(afterRetry, unknown, "Retry neither deletes nor resets the unknown receipt");
  assert.deepEqual(attempt(await introduction(fixture)), attempt(unknown), "the next run only observes the receipt: same state, identities, body and route");
});

it("S6b-CONV-08: a caller paused before an operative mode change never refuses over the unknown introduction a contactable caller recorded; after restored modes, Retry and a run it is not initiated again", {timeout: 10_000}, async t => {
  // a plan-mode Supervisor can contact a plan-mode operative only; both public runs found no introduction and pause at their
  // first operative read
  const fixture = await makeFixture({now: baseTime}, {supervisorInteractionMode: "plan"});
  after(t, fixture.cleanup);
  fixture.operative.thread.interactionMode = "plan";
  const arrivals = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  after(t, () => {for (const release of releases) release.resolve();});
  const read = fixture.conversation.projection;
  let held = 0;
  mockMethod(t, fixture.conversation, "projection", async (id: string, signal: AbortSignal) => {
    if (id === operativeThreadId && held < 2) {const index = held++;arrivals[index]!.resolve();await releases[index]!.promise;}
    return read(id, signal);
  });
  fixture.intercept(call => isIntroduction(call) ? Promise.reject(new SupervisorRpcError("uncertain")) : null);
  const conversation = Context.get(fixture.conversation.context, SupervisorConversation);
  const first = Effect.runFork(conversation.run(await binding(fixture), fixture.supervisor, fixture.threadList));
  await withDeadline(arrivals[0]!.promise, 3_000, "the first run at its operative read");
  const second = Effect.runFork(conversation.run(await binding(fixture), fixture.supervisor, fixture.threadList));
  await withDeadline(arrivals[1]!.promise, 3_000, "the second run at its operative read");
  // the first run reads the plan-mode operative, posts and records an unknown outcome
  releases[0]!.resolve();
  await withDeadline(Effect.runPromise(Fiber.join(first)), 3_000, "the first run");
  const unknown = await introduction(fixture);
  // the operative's current mode is default, which the plan-mode Supervisor cannot contact: the second run's refusal is stale
  fixture.operative.thread.interactionMode = "default";
  releases[1]!.resolve();
  await withDeadline(Effect.runPromise(Fiber.join(second)), 3_000, "the second run");
  const afterStale = await introduction(fixture);
  // contactable modes again, then Retry and another public run
  fixture.supervisor.thread.interactionMode = "default";
  fixture.intercept(null);
  await fixture.conversation.retry(projectId, (await binding(fixture)).threadId);
  const afterRetry = await introduction(fixture);
  await withDeadline(Effect.runPromise(conversation.run(await binding(fixture), fixture.supervisor, fixture.threadList)), 3_000, "the next run");

  assert.equal(fixture.calls.filter(isIntroduction).length, 1, "one native initiation in total");
  assert.equal(unknown?.state, "uncertain");
  assert.deepEqual(afterStale, unknown, "the stale refusal leaves the unknown receipt exactly as recorded");
  assert.deepEqual(afterRetry, unknown, "Retry neither deletes nor resets the unknown receipt");
  assert.deepEqual(attempt(await introduction(fixture)), attempt(unknown), "the next run only observes the receipt: same state, identities, body and route");
});

it("S6b-CONV-09: after a stale refusal, Retry through ProjectSupervisor and its supervision pass keep the unknown introduction and initiate nothing", {timeout: 10_000}, async t => {
  const fixture = await makeFixture({now: baseTime});
  after(t, fixture.cleanup);
  // the project is enabled for the supervisor's own scope predicates, with no activation anchor for the operative
  await fixture.projectStore.saveControl(projectId, (await fixture.projectStore.control(projectId)).generation, true, {snapshotSequence: 1, threads: []});
  const {unknown, afterStale} = await staleRefusalOverUnknown(t, fixture);
  const service = fixture.makeProjectSupervisor();
  const current = await binding(fixture);
  const retried = await withDeadline(service.retry({projectId, mainThreadId: operativeThreadId, expectedGeneration: (await fixture.projectStore.settings(projectId)).generation,
    threadId: current.threadId, bindingGeneration: current.generation, action: "retry"}, AbortSignal.timeout(8_000)), 3_000, "the retry");

  assert.equal(fixture.calls.filter(isIntroduction).length, 1, "one native initiation in total");
  assert.notEqual(retried.status, "conflict");
  assert.deepEqual(afterStale, unknown, "the stale refusal leaves the unknown receipt exactly as recorded");
  assert.deepEqual(attempt(await introduction(fixture)), attempt(unknown), "Retry and the supervision pass keep the receipt's state, identities, body and route");
});

it("S6b-CONV-10: a public run reconciling a stale copy of a check-in another run already completed commits nothing again", {timeout: 10_000}, async t => {
  // plan-mode Supervisor modes keep the introduction unsent; the prepared introduction holds each run at its last read
  const fixture = await makeFixture({now: baseTime}, {supervisorInteractionMode: "plan"});
  after(t, fixture.cleanup);
  await fixture.conversation.requests.saveIntroduction({taskId: fixture.task.id, projectId, threadId: operativeThreadId, supervisorThreadId: fixture.binding.threadId,
    state: "ready", text: workflowIntroductionText(fixture.task), messageId: `supervisor-notice:workflow:${fixture.task.id}`, targetRunId: null, error: null});
  const prepared = await fixture.conversation.requests.prepare({projectId, supervisorThreadId: fixture.binding.threadId, kind: "review", taskId: null,
    text: "Check in on the current activity.", batch: null, completionMarker: "Supervisor check-in completed"}, baseTime);
  // the check-in as its dispatch recorded it: waiting, with its notice time
  const sent: ConversationRequest = {...prepared, state: "waiting", sentAt: baseTime};
  await fixture.conversation.requests.saveRequest(sent);
  await fixture.conversation.requests.noticeSent(fixture.binding.threadId, baseTime);
  // the check-in ran to completion without its marker, so it counts as one missed review
  const run = appendRun({projection: fixture.supervisor, id: "check-in-run", ordinal: 5, status: "completed", messageId: sent.messageId, text: sent.text, now: baseTime + 1});
  appendMessageToRun(fixture.supervisor, run, {id: "check-in-answer", role: "assistant", text: "Observed; no marker.", now: baseTime + 2});
  const conversation = Context.get(fixture.conversation.context, SupervisorConversation);
  const arrivals = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  after(t, () => {for (const release of releases) release.resolve();});
  const read = fixture.conversation.projection;
  let held = 0;
  mockMethod(t, fixture.conversation, "projection", async (id: string, signal: AbortSignal) => {
    if (id === fixture.binding.threadId && held < 2) {const index = held++;arrivals[index]!.resolve();await releases[index]!.promise;}
    return read(id, signal);
  });
  const fibers = await Promise.all([0, 1].map(async /*s6d*/ () => Effect.runFork(conversation.run(await binding(fixture), fixture.supervisor, fixture.threadList))));
  await withDeadline(Promise.all(arrivals.map(item => item.promise)), 3_000, "both runs at their last read");
  assert.deepEqual(await fixture.conversation.requests.pending(projectId, fixture.binding.threadId), sent, "both runs read the same waiting check-in");
  releases[0]!.resolve();
  await withDeadline(Promise.race(fibers.map(fiber => Effect.runPromise(Fiber.await(fiber)))), 3_000, "the released run");
  const completed = (await fixture.conversation.requests.requests(projectId, fixture.binding.threadId)).find(item => item.id === sent.id);
  assert.equal(completed?.state, "completed");
  assert.equal(await fixture.conversation.requests.reviewMisses(fixture.binding.threadId), 1);
  releases[1]!.resolve();
  await withDeadline(Promise.all(fibers.map(fiber => Effect.runPromise(Fiber.join(fiber)))), 3_000, "both runs");

  assert.equal(await fixture.conversation.requests.reviewMisses(fixture.binding.threadId), 1, "the miss is counted once");
  assert.deepEqual((await fixture.conversation.requests.requests(projectId, fixture.binding.threadId)).find(item => item.id === sent.id), completed,
    "the completed check-in is not reverted or recommitted from the stale copy");
});
