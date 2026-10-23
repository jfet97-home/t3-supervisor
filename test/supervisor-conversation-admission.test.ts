import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import type { BindingRecord } from "../src/project-supervisor-store.js";
import { atWallTime, within } from "./support/g1b-conversation.js";
import {
  abortHonouringSend, addCommandActivity, appendNoticeToOperative, baseTime, makeFixture, operativeThreadId, proceed, projectId, setNow, type Fixture,
  type FixtureClock, type Flight, type RpcCall,
} from "./support/c1-conversation-fixture.js";

// target regressions of the ported root check-in (S6b): its guard, 'sending' receipt and POST run in the one admission
// section the policy writers use, the reply is awaited outside it, and an interrupted cycle classifies the send it owns.
// the cases are Effect tests on the production conversation, project supervisor, admission gate and stores over real files in a
// temporary directory, with the fake T3 as an effect fake and the suite clock on the test clock; the baseline per-call 8 s
// abort deadlines and the observation's 5 s are gone with the signal parameter: hang guards, which each case's 10 s bound and
// the 3 s live-clock bounds of its awaited events still cover

const isCheckIn = (fixture: Fixture) => (call: RpcCall) => call.payload.type === "message.dispatch" && call.payload.threadId === fixture.binding.threadId;

// three due command activities beside a sent introduction, observed into the monitor; the project is enabled for the
// supervisor's own scope predicates
const dueCheckIn = (clock: FixtureClock) => Effect.gen(function* () {
  yield* setNow(clock, clock.now);
  const fixture = yield* makeFixture(clock, {settings: {intervalMinutes: 2, activityThreshold: 3}});
  yield* appendNoticeToOperative(fixture);
  for (let index = 1; index <= 3; index++) addCommandActivity(fixture.operative, `command-${index}`, `PRIVATE_COMMAND_BODY_${index}`, clock.now - index * 1_000);
  yield* fixture.conversation.observe(fixture.threadList).pipe(atWallTime(clock.now));
  yield* fixture.projectStore.saveControl(projectId, (yield* fixture.projectStore.control(projectId)).generation, true, {snapshotSequence: 1, threads: []});
  return fixture;
});

const binding = (fixture: Fixture) => Effect.map(fixture.projectStore.binding(projectId, operativeThreadId), (current) => current as BindingRecord);

it.effect("S6b-CONV-01: a Stop requested while a root check-in's reply is pending commits without waiting for it; the check-in keeps its identity", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const fixture = yield* dueCheckIn(clock);
  const service = yield* fixture.makeProjectSupervisor;
  const reached = yield* Deferred.make<RpcCall>();
  const reply = yield* Deferred.make<unknown>();
  fixture.intercept(call => {
    if (!isCheckIn(fixture)(call)) return null;
    return Effect.andThen(Deferred.succeed(reached, call), Deferred.await(reply));
  });
  const running = yield* Effect.forkChild(service.conversation.run(yield* binding(fixture), fixture.supervisor, fixture.threadList));
  const call = yield* within(Deferred.await(reached), 3_000, "check-in POST");
  const sending = yield* service.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(sending?.state, "sending");
  assert.equal(call.payload.commandId, `supervisor-review:${sending.id}`);

  // the dashboard Stop runs its policy write in the same admission section the POST was started in
  const stopped = yield* within(service.supervisor.setChatSupervision({projectId, mainThreadId: operativeThreadId, enabled: false,
    policyGeneration: (yield* fixture.threadPolicy.get()).generation}), 3_000, "Stop while the reply is pending");
  assert.equal(stopped.status, "saved");
  assert.deepEqual(yield* service.requests.pending(projectId, fixture.binding.threadId), sending, "the Stop leaves the started check-in's identity untouched");

  yield* Deferred.succeed(reply, proceed);
  yield* within(Fiber.join(running), 3_000, "cycle");
  assert.deepEqual(yield* service.requests.pending(projectId, fixture.binding.threadId), {...sending, state: "waiting"});
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [call]);
}), {timeout: 10_000});

it.effect("S6b-CONV-02: a Stop committed while a root check-in waits for the admission section prepares and sends nothing", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const fixture = yield* dueCheckIn(clock);
  const service = yield* fixture.makeProjectSupervisor;
  const scope = yield* Effect.scope;
  const barrier = yield* Deferred.make<void>();
  const holding = yield* Deferred.make<void>();
  // the check-in's main read is its last native read before its section: the section is taken right there
  let held: Fiber.Fiber<void> | null = null;
  fixture.fake.holdSupervisorReads((threadId, read) => Effect.gen(function* () {
    if (threadId === operativeThreadId && held === null) {
      held = yield* Effect.forkIn(service.gate.admit(() => Deferred.await(barrier)), scope, {startImmediately: true});
      yield* Deferred.succeed(holding, undefined);
    }
    return yield* read;
  }));
  const running = yield* Effect.forkChild(service.conversation.run(yield* binding(fixture), fixture.supervisor, fixture.threadList));
  yield* within(Deferred.await(holding), 3_000, "section held");
  // a policy write made while the section is held, as a Stop's own section would make it
  const policy = yield* fixture.threadPolicy.get();
  yield* fixture.threadPolicy.save({...policy, excludedThreadIds: [...policy.excludedThreadIds, operativeThreadId]});
  yield* Deferred.succeed(barrier, undefined);
  yield* within(Fiber.join(running), 3_000, "cycle");
  yield* within(Fiber.join(held!), 3_000, "section released");
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [], "nothing is posted after the Stop");
  assert.equal(yield* service.requests.pending(projectId, fixture.binding.threadId), null, "no check-in is prepared");
  assert.ok((yield* Effect.forEach(["command-1", "command-2", "command-3"], id => Effect.map(service.monitor.pending(projectId, operativeThreadId), items => items.some(item => item.id === id)))).every(Boolean),
    "the pending activity is retained");
}), {timeout: 10_000});

it.effect("S6b-CONV-03: interrupting a cycle while its root check-in reply is pending leaves the check-in uncertain under its identity, releases the call once and never resends", () => Effect.gen(function* () {
  const clock = {now: baseTime};
  const fixture = yield* dueCheckIn(clock);
  const conversation = fixture.conversation;
  const reached = yield* Deferred.make<{call: RpcCall; flight: Flight}>();
  fixture.intercept((call, flight) => {
    if (!isCheckIn(fixture)(call)) return null;
    return Effect.andThen(Deferred.succeed(reached, {call, flight}), abortHonouringSend(flight));
  });
  const fiber = yield* Effect.forkChild(conversation.run(yield* binding(fixture), fixture.supervisor, fixture.threadList));
  const {call, flight} = yield* within(Deferred.await(reached), 3_000, "check-in POST");
  const sending = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.equal(sending?.state, "sending");
  yield* within(Fiber.interrupt(fiber), 3_000, "interrupted cycle");
  assert.equal(yield* Deferred.isDone(flight.released), true);
  assert.equal(flight.releases, 1);
  const uncertain = yield* fixture.requests.pending(projectId, fixture.binding.threadId);
  assert.deepEqual(uncertain, {...sending, state: "uncertain",
    error: "Supervisor request delivery is uncertain; its original identity is retained and only observed, never resent."});

  fixture.intercept(null);
  yield* setNow(clock, clock.now + 120_000);
  yield* fixture.run;
  assert.deepEqual(yield* fixture.requests.pending(projectId, fixture.binding.threadId), uncertain);
  assert.deepEqual(fixture.calls.filter(isCheckIn(fixture)), [call]);
}), {timeout: 10_000});
