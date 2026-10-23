import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Scope } from "effect";
import { startFakeT3, untilTraffic, type FakeT3, type FakeT3Options } from "./support/cli-fake-t3.js";
import { fakeT3 } from "./support/g8-cli.js";
import { connectRefused } from "./support/g8-process.js";

// waits on the loopback fake T3 own their resources: each wait's own timer (recorded by its exact delay) and its traffic
// listener end with the wait, whether it is interrupted, its fake closes, or both; a fake acquired in a scope always
// closes with it (real loopback fake)

const bound = 2_000;
const never = () => false;
const label = "a request that never comes";

// the fake for the caller's scope: released unconditionally, also when the scope is interrupted before any explicit close
const peer = (options: FakeT3Options = {token: "token"}) =>
  Effect.acquireRelease(Effect.promise(() => startFakeT3(options)), (fake) => Effect.promise(() => fake.close()));

// the timers armed with exactly `delay` ms while in scope, and which of them were cleared before firing
const timersOf = (delay: number) => Effect.acquireRelease(Effect.sync(() => {
  const original = {set: globalThis.setTimeout, clear: globalThis.clearTimeout};
  const armed = new Set<unknown>();
  const cleared = new Set<unknown>();
  globalThis.setTimeout = ((handler: (...args: Array<unknown>) => void, ms?: number, ...args: Array<unknown>) => {
    const handle = original.set(handler, ms, ...args);
    if (ms === delay) armed.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    if (armed.has(handle)) cleared.add(handle);
    original.clear(handle);
  }) as typeof clearTimeout;
  return {armed, cleared, restore: () => {
    globalThis.setTimeout = original.set;
    globalThis.clearTimeout = original.clear;
  }};
}), (recorder) => Effect.sync(recorder.restore));

// the fiber's exit within a live second; a wait still pending then is the defect under test
const settled = <A, E>(fiber: Fiber.Fiber<A, E>, what: string) => Fiber.await(fiber).pipe(
  Effect.timeoutOrElse({duration: Duration.seconds(1), orElse: () => Effect.die(new Error(`${what} stayed pending`))}));

const armedWait = (fake: FakeT3, recorder: {armed: Set<unknown>}) => Effect.gen(function* () {
  const waiting = yield* Effect.forkChild(untilTraffic(fake, never, bound, label));
  while (recorder.armed.size === 0 || fake.waits() === 0) yield* Effect.sleep("5 millis");
  assert.equal(recorder.armed.size, 1, "the wait arms exactly its own bound");
  assert.equal(fake.waits(), 1, "the wait holds exactly one traffic listener");
  return waiting;
});

const closedFailure = (exit: Exit.Exit<void>) => Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "succeeded";

it.live("an interrupted traffic wait and a closed fake leave no timer behind", () => Effect.gen(function* () {
  const recorder = yield* timersOf(bound);
  const fake = yield* peer();
  const waiting = yield* armedWait(fake, recorder);
  yield* Fiber.interrupt(waiting);
  assert.deepEqual([...recorder.cleared], [...recorder.armed], "interrupting the wait clears its own bound");
  assert.equal(fake.waits(), 0, "interrupting the wait removes its listener");
  yield* Effect.promise(() => fake.close());
  assert.equal(fake.waits(), 0);
}));

it.live("closing the fake ends a pending promise wait: its timer is cleared and it rejects", () => Effect.gen(function* () {
  const recorder = yield* timersOf(bound);
  const fake = yield* peer();
  const pending = fake.until(never, bound, label).then(() => "resolved", (error: Error) => error.message);
  assert.equal(recorder.armed.size, 1, "the promise wait arms exactly its own timer");
  assert.equal(fake.waits(), 1);
  yield* Effect.promise(() => fake.close());
  assert.equal(yield* Effect.promise(() => pending), `fake T3 closed before it observed ${label}`);
  assert.deepEqual([...recorder.cleared], [...recorder.armed], "closing the fake clears the pending wait's own timer");
  assert.equal(fake.waits(), 0);
}));

it.live("closing the fake alone settles an active traffic wait: it fails as closed, removes its listener and clears its bound", () => Effect.gen(function* () {
  const recorder = yield* timersOf(bound);
  const fake = yield* peer();
  const waiting = yield* armedWait(fake, recorder);
  // no interruption: the peer's close alone must end the wait
  yield* Effect.promise(() => fake.close());
  const exit = yield* settled(waiting, "the traffic wait after its fake closed");
  assert.equal(closedFailure(exit), `Error: fake T3 closed before it observed ${label}`);
  assert.equal(fake.waits(), 0, "the closed wait removed its listener");
  assert.deepEqual([...recorder.cleared], [...recorder.armed], "the closed wait cleared its own bound");
}));

it.live("closing the G8 facade's fake with its scope settles the facade's readiness wait", () => Effect.gen(function* () {
  const recorder = yield* timersOf(bound);
  // the facade's own scope, closed explicitly below and in any case with the test's scope
  const inner = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
  const facade = yield* Scope.provide(inner)(fakeT3({token: "token"}));
  const waiting = yield* Effect.forkChild(facade.until(never, bound, label));
  while (recorder.armed.size === 0) yield* Effect.sleep("5 millis");
  // the facade's scope releases the fake; nothing interrupts the wait
  yield* Scope.close(inner, Exit.void);
  const exit = yield* settled(waiting, "the facade's readiness wait after its fake closed");
  assert.equal(closedFailure(exit), `Error: fake T3 closed before it observed ${label}`);
  assert.deepEqual([...recorder.cleared], [...recorder.armed], "the closed facade wait cleared its own bound");
}));

it.live("a fake acquired in a scope closes when the scope is interrupted before any explicit close", () => Effect.gen(function* () {
  const acquired = yield* Deferred.make<number>();
  const holding = yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
    const fake = yield* peer();
    yield* Deferred.succeed(acquired, Number(new URL(fake.baseUrl).port));
    return yield* Effect.never;
  })));
  const port = yield* Deferred.await(acquired);
  assert.equal(yield* connectRefused(port), false, "the fake listens while its scope is open");
  yield* Fiber.interrupt(holding);
  assert.equal(yield* connectRefused(port), true, "the interrupted scope closed the fake's listener");
}));
