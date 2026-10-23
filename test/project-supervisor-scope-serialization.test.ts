import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import type { ScopeLocksShape } from "../src/scope-locks.js";
import { supervisorScopeKey } from "../src/supervisor-scope.js";
import { retryInput } from "./support/psx-submission.js";
import { makeFixture, type PsxFixture } from "./support/psx-supervisor.js";

// target regression (S6b): the per-scope serial queues of ProjectSupervisor became ScopeLocks keys leased per operation; every
// span the queue covered holds its key, so two callers never supervise one main at the same time, while the mains of one
// binding batch still run side by side.
// it.live: each case opens a real sqlite guidance file. The per-call deadlines are gone; the 10s vitest timeout is the hang guard.

const earlier = [{id: "old-turn", sequence: 1, text: "An earlier request before the activation boundary."}];

// the lock events of the supervisor: a caller asks for a key, holds it and releases it.
// onWait runs synchronously inside the lock effect, so the deferred is completed with doneUnsafe.
const observedLocks = (events: string[], onWait: (key: string) => void) => (locks: ScopeLocksShape): ScopeLocksShape => ({
  withLock: (key) => (self) => Effect.suspend(() => {
    events.push(`wait ${key}`);
    onWait(key);
    return locks.withLock(key)(Effect.suspend(() => {
      events.push(`hold ${key}`);
      return self;
    }).pipe(Effect.ensuring(Effect.sync(() => {events.push(`release ${key}`);}))));
  }),
  leased: locks.leased,
});

// holds every Supervisor projection read of the given threads until released, counting the reads in progress
const holdSupervisorReads = (fixture: PsxFixture, threadIds: ReadonlySet<string>) => Effect.gen(function* () {
  const state = {active: 0, maxActive: 0, released: false};
  const gate = yield* Deferred.make<void>();
  const entries: Array<{count: number; reached: Deferred.Deferred<void>}> = [];
  fixture.setProjectionHook((threadId) => {
    if (!threadIds.has(threadId) || state.released) return undefined;
    const projection = fixture.projections.get(threadId)!;
    return Effect.gen(function* () {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      for (const entry of entries) if (state.active >= entry.count) Deferred.doneUnsafe(entry.reached, Effect.void);
      yield* Deferred.await(gate);
      return {projection, snapshotSequence: 20};
    }).pipe(Effect.ensuring(Effect.sync(() => {state.active -= 1;})));
  });
  return {
    state,
    // resolves once `count` held reads are in progress at the same time
    reached: (count: number) => Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      entries.push({count, reached});
      if (state.active >= count) Deferred.doneUnsafe(reached, Effect.void);
      return yield* Deferred.await(reached);
    }),
    // releases the held reads and settles every barrier still waiting for a count
    release: () => Effect.sync(() => {
      state.released = true;
      Deferred.doneUnsafe(gate, Effect.void);
      for (const entry of entries) Deferred.doneUnsafe(entry.reached, Effect.void);
    }),
  };
});

it.live("a cycle and a retry for one main supervise it one at a time under its scope key", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "main", projectId: "project-a", turns: earlier}]);
  const binding = yield* fixture.reserveReadyBinding("main");
  const key = supervisorScopeKey("project-a", "main");
  const events: string[] = [];
  const queued = yield* Deferred.make<void>();
  let onWait: (lockKey: string) => void = () => undefined;
  const supervisor = yield* fixture.makeSupervisor({locks: observedLocks(events, (lockKey) => onWait(lockKey))});
  const reads = yield* holdSupervisorReads(fixture, new Set([binding.threadId]));

  // the cycle holds the main's key while its Supervisor read is held
  const cycle = yield* Effect.forkChild(supervisor.cycle);
  yield* reads.reached(1);
  assert.equal(events.at(-1), `hold ${key}`);
  assert.equal(supervisor.queues.size, 1);

  // the retry for the same main queues behind it on the same key
  onWait = (lockKey) => {if (lockKey === key) Deferred.doneUnsafe(queued, Effect.void);};
  const retry = yield* Effect.forkChild(supervisor.retry(retryInput("project-a", 0, binding, "retry")));
  // the retry either waits for the main's key or, unserialized, reaches the main's Supervisor read beside the cycle
  yield* Effect.race(Deferred.await(queued), reads.reached(2));
  const waitedAt = events.length;
  assert.equal(reads.state.active, 1, "only the cycle is inside the main's supervision");
  assert.equal(events.at(-1), `wait ${key}`);
  assert.equal(supervisor.queues.size, 1, "both callers lease the one key of the main");

  yield* reads.release();
  yield* Fiber.join(cycle);
  yield* Fiber.join(retry);
  assert.equal(reads.state.maxActive, 1, "the two callers never read the main's Supervisor at the same time");
  // the retry holds the key only after the cycle released it
  const after = events.slice(waitedAt);
  assert.ok(after.indexOf(`release ${key}`) >= 0 && after.indexOf(`release ${key}`) < after.indexOf(`hold ${key}`), after.join(", "));
  assert.equal(supervisor.queues.size, 0);
}), {timeout: 10_000});

it.live("one cycle supervises two mains of a binding batch side by side under their own keys", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "main-a", projectId: "project-a", turns: earlier}, {threadId: "main-b", projectId: "project-a", turns: earlier}]);
  const first = yield* fixture.reserveReadyBinding("main-a");
  const second = yield* fixture.reserveReadyBinding("main-b");
  const events: string[] = [];
  const supervisor = yield* fixture.makeSupervisor({locks: observedLocks(events, () => undefined)});
  const reads = yield* holdSupervisorReads(fixture, new Set([first.threadId, second.threadId]));

  const cycle = yield* Effect.forkChild(supervisor.cycle);
  // both mains are inside their supervision at once: one key each, neither waiting for the other
  yield* reads.reached(2);
  assert.equal(supervisor.queues.size, 2);
  assert.ok(events.includes(`hold ${supervisorScopeKey("project-a", "main-a")}`) && events.includes(`hold ${supervisorScopeKey("project-a", "main-b")}`));
  yield* reads.release();
  yield* Fiber.join(cycle);
  assert.equal(reads.state.maxActive, 2);
  assert.equal(supervisor.queues.size, 0);
}), {timeout: 10_000});
