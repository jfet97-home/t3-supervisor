import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { ScopeLocks } from "../src/scope-locks.js";

// ScopeLocks (plan 3.5, O-04): one operation per key at a time, keys leased per operation and released by completion,
// failure or interruption (queued or running), and no key retained once its last user left


it.effect("operations of one key run one at a time in arrival order; other keys run concurrently", () => Effect.gen(function* () {
  const scope = yield* ScopeLocks;
  const order: string[] = [];
  const gates = [yield* Deferred.make<void>(), yield* Deferred.make<void>(), yield* Deferred.make<void>()];
  const step = (name: string, gate: Deferred.Deferred<void>) => scope.withLock("project-a")(Effect.gen(function* () {
    order.push(`${name}:start`);
    yield* Deferred.await(gate);
    order.push(`${name}:end`);
  }));
  const fibers = [];
  for (const [index, name] of ["first", "second", "third"].entries()) {
    fibers.push(yield* Effect.forkChild(step(name, gates[index]!)));
    yield* Effect.yieldNow;
  }
  // another key is not blocked by project-a
  yield* scope.withLock("project-b")(Effect.sync(() => order.push("other-key")));
  for (const gate of gates) {
    yield* Deferred.succeed(gate, undefined);
    yield* Effect.yieldNow;
  }
  yield* Fiber.joinAll(fibers);
  assert.deepEqual(order, ["first:start", "other-key", "first:end", "second:start", "second:end", "third:start", "third:end"]);
  assert.deepEqual(yield* scope.leased, []);
}).pipe(Effect.provide(ScopeLocks.layer)), { timeout: 10_000 });

it.effect("CT-PS-11 shape: an interrupted queued caller and a failed holder release their key and leave nothing leased", () => Effect.gen(function* () {
  const scope = yield* ScopeLocks;
  const hold = yield* Deferred.make<void>();
  const holder = yield* Effect.forkChild(scope.withLock("project-a")(Effect.andThen(Deferred.await(hold), Effect.fail("holder failed" as const))));
  yield* Effect.yieldNow;
  const queued = yield* Effect.forkChild(scope.withLock("project-a")(Effect.sync(() => "never")));
  yield* Effect.yieldNow;
  assert.deepEqual(yield* scope.leased, ["project-a"]);
  yield* Fiber.interrupt(queued);
  yield* Deferred.succeed(hold, undefined);
  assert.equal((yield* Effect.flip(Fiber.join(holder))), "holder failed");
  assert.deepEqual(yield* scope.leased, []);
  // the key works again after the failure and the cancellation
  assert.equal(yield* scope.withLock("project-a")(Effect.succeed("after")), "after");
  assert.deepEqual(yield* scope.leased, []);
}).pipe(Effect.provide(ScopeLocks.layer)), { timeout: 10_000 });
