import assert from "node:assert/strict";
import { Context, Effect, Fiber } from "effect";
import { it, type TestContext } from "vitest";
import { after, mockMethod } from "./support/node-test.js";
import { withDeadline } from "./support/c1-loopback.js";
import type { BindingRecord } from "../src/project-supervisor-store.js";
import { SupervisorConversation } from "../src/supervisor-conversation.js";
import {
  abortHonouringSend, addCommandActivity, appendNoticeToOperative, baseTime, makeFixture, operativeThreadId, proceed, projectId, type Fixture, type RpcCall,
} from "./support/c1-conversation-fixture.js";

// target regressions of the ported root check-in (S6b): its guard, 'sending' receipt and POST run in the one admission
// section the policy writers use, the reply is awaited outside it, and an interrupted cycle classifies the send it owns

const isCheckIn = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === fixture.binding.threadId;

// three due command activities beside a sent introduction, observed into the monitor; the project is enabled for the
// supervisor's own scope predicates
const dueCheckIn = async (t: TestContext, clock: {now: number}) => {
  mockMethod(t, Date, "now", () => clock.now);
  const fixture = await makeFixture(clock, {settings: {intervalMinutes: 5, activityThreshold: 3}});
  after(t, fixture.cleanup);
  await appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  await fixture.conversation.observe(fixture.threadList, AbortSignal.timeout(5_000), clock.now);
  await fixture.projectStore.saveControl(projectId, (await fixture.projectStore.control(projectId)).generation, true, {snapshotSequence: 1, threads: []});
  return fixture;
};

const binding = async /*s6d*/ (fixture: Fixture): Promise<BindingRecord> => (await fixture.projectStore.binding(projectId, operativeThreadId))!;

it("S6b-CONV-01: a Stop requested while a root check-in's reply is pending commits without waiting for it; the check-in keeps its identity", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  const fixture = await dueCheckIn(t, clock);
  const service = fixture.makeProjectSupervisor();
  const reached = Promise.withResolvers<RpcCall>();
  const reply = Promise.withResolvers<unknown>();
  after(t, () => reply.resolve(proceed));
  fixture.intercept(call => {
    if (!isCheckIn(fixture)(call)) return null;
    reached.resolve(call);
    return reply.promise;
  });
  const signal = AbortSignal.timeout(8_000);
  const running = service.conversation.run(await binding(fixture), fixture.supervisor, fixture.threadList, signal);
  const call = await withDeadline(reached.promise, 3_000, "check-in POST");
  const sending = await service.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(sending?.state, "sending");
  assert.equal(call.payload.commandId, `supervisor-review:${sending.id}`);

  // the dashboard Stop runs its policy write in the same admission section the POST was started in
  const stopped = await withDeadline(service.setChatSupervision({projectId, mainThreadId: operativeThreadId, enabled: false,
    policyGeneration: (await fixture.threadPolicy.get()).generation}, signal), 3_000, "Stop while the reply is pending");
  assert.equal(stopped.status, "saved");
  assert.deepEqual(await service.conversation.requests.pending(projectId, fixture.binding.threadId), sending, "the Stop leaves the started check-in's identity untouched");

  reply.resolve(proceed);
  await withDeadline(running, 3_000, "cycle");
  assert.deepEqual(await service.conversation.requests.pending(projectId, fixture.binding.threadId), {...sending, state: "waiting"});
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [call]);
});

it("S6b-CONV-02: a Stop committed while a root check-in waits for the admission section prepares and sends nothing", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  const fixture = await dueCheckIn(t, clock);
  const service = fixture.makeProjectSupervisor();
  const barrier = Promise.withResolvers<void>();
  after(t, () => barrier.resolve());
  const holding = Promise.withResolvers<void>();
  // the check-in's main read is its last native read before its section: the section is taken right there
  const read = service.t3.projection.bind(service.t3);
  let held: Promise<unknown> | null = null;
  mockMethod(t, service.t3, "projection", (threadId: string) => {
    if (threadId === operativeThreadId && held === null) {
      held = Effect.runPromise(service.admission.gate.admit(() => Effect.promise(() => barrier.promise)));
      holding.resolve();
    }
    return read(threadId);
  });
  const running = service.conversation.run(await binding(fixture), fixture.supervisor, fixture.threadList, AbortSignal.timeout(8_000));
  await withDeadline(holding.promise, 3_000, "section held");
  // a policy write made while the section is held, as a Stop's own section would make it
  const policy = await fixture.threadPolicy.get();
  await fixture.threadPolicy.save({...policy, excludedThreadIds: [...policy.excludedThreadIds, operativeThreadId]});
  barrier.resolve();
  await withDeadline(running, 3_000, "cycle");
  await withDeadline(held!, 3_000, "section released");
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [], "nothing is posted after the Stop");
  assert.equal(await service.conversation.requests.pending(projectId, fixture.binding.threadId), null, "no check-in is prepared");
  assert.ok((await Promise.all(["command-1", "command-2", "command-3"].map(async id => (await service.conversation.monitor.pending(projectId, operativeThreadId)).some(item => item.id === id)))).every(Boolean),
    "the pending activity is retained");
});

it("S6b-CONV-03: interrupting a cycle while its root check-in reply is pending leaves the check-in uncertain under its identity, releases the call once and never resends", {timeout: 10_000}, async t => {
  const clock = {now: baseTime};
  const fixture = await dueCheckIn(t, clock);
  const conversation = Context.get(fixture.conversation.context, SupervisorConversation);
  const reached = Promise.withResolvers<{call: RpcCall; signal: AbortSignal}>();
  let aborts = 0;
  fixture.intercept((call, signal) => {
    if (!isCheckIn(fixture)(call)) return null;
    signal.addEventListener("abort", () => {aborts++;});
    reached.resolve({call, signal});
    return abortHonouringSend(signal);
  });
  const fiber = Effect.runFork(conversation.run(await binding(fixture), fixture.supervisor, fixture.threadList));
  const {call, signal} = await withDeadline(reached.promise, 3_000, "check-in POST");
  const sending = await fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(sending?.state, "sending");
  await withDeadline(Effect.runPromise(Fiber.interrupt(fiber)), 3_000, "interrupted cycle");
  assert.equal(signal.aborted, true);
  assert.equal(aborts, 1);
  const uncertain = await fixture.conversation.requests.pending(projectId, fixture.binding.threadId);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "Supervisor request delivery is uncertain; its original identity is retained and only observed, never resent."});

  fixture.intercept(null);
  clock.now += 120_000;
  await fixture.run();
  assert.deepEqual(await fixture.conversation.requests.pending(projectId, fixture.binding.threadId), uncertain);
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [call]);
});
