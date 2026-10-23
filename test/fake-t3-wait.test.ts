import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { startFakeT3, untilTraffic } from "./support/cli-fake-t3.js";

// waits on the loopback fake T3 own their timers: an interrupted wait, or a pending wait whose fake closes, leaves no timer
// that could fire after the test's scopes ended (real loopback fake; the process's active timers are the observation)

const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
const settle = Effect.sleep("20 millis");

it.live("an interrupted traffic wait and a closed fake leave no timer behind", () => Effect.gen(function* () {
  const fake = yield* Effect.promise(() => startFakeT3({token: "token"}));
  yield* settle;
  const before = timers();
  const waiting = yield* Effect.forkChild(untilTraffic(fake, () => false, 2_000, "a request that never comes"));
  yield* settle;
  assert.equal(timers(), before + 1, "the wait's bound is armed");
  yield* Fiber.interrupt(waiting);
  yield* Effect.promise(() => fake.close());
  yield* settle;
  assert.equal(timers(), before, "interrupting the wait and closing its fake must leave no timer behind");
}));

it.live("closing the fake ends a pending promise wait: its timer is cleared and it rejects", () => Effect.gen(function* () {
  const fake = yield* Effect.promise(() => startFakeT3({token: "token"}));
  yield* settle;
  const before = timers();
  const pending = fake.until(() => false, 2_000, "a request that never comes").then(() => "resolved", (error: Error) => error.message);
  assert.equal(timers(), before + 1, "the wait's timer is armed");
  yield* Effect.promise(() => fake.close());
  assert.equal(yield* Effect.promise(() => pending), "fake T3 closed before it observed a request that never comes");
  yield* settle;
  assert.equal(timers(), before, "closing the fake must clear the pending wait's timer");
}));
