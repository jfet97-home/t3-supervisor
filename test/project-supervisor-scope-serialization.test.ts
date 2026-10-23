import assert from "node:assert/strict";
import { it } from "vitest";
import { Effect } from "effect";
import type { ScopeLocksShape } from "../src/scope-locks.js";
import { supervisorScopeKey } from "../src/supervisor-scope.js";
import { after } from "./support/node-test.js";
import { deferred, makeFixture, reserveReadyBinding, retryInput, within, type Fixture } from "./support/c2-ps-fixture.js";

// target regression (S6b): the per-scope serial queues of ProjectSupervisor became ScopeLocks keys leased per operation; every
// span the queue covered holds its key, so two callers never supervise one main at the same time, while the mains of one
// binding batch still run side by side

const earlier = [{id: "old-turn", sequence: 1, text: "An earlier request before the activation boundary."}];

// the lock events of the supervisor: a caller asks for a key, holds it and releases it
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
const holdSupervisorReads = (fixture: Fixture, threadIds: ReadonlySet<string>) => {
  const state = {active: 0, maxActive: 0, released: false};
  const gate = deferred();
  const entries: Array<{count: number; reached: {resolve: () => void}}> = [];
  fixture.setProjectionHook(threadId => {
    if (!threadIds.has(threadId) || state.released) return undefined;
    const projection = fixture.projections.get(threadId)!;
    return Effect.suspend(() => {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      for (const entry of entries) if (state.active >= entry.count) entry.reached.resolve();
      return Effect.promise(() => gate.promise);
    }).pipe(Effect.ensuring(Effect.sync(() => {state.active -= 1;})), Effect.as({projection, snapshotSequence: 20}));
  });
  return {
    state,
    // resolves once `count` held reads are in progress at the same time
    reached: (count: number) => {const reached = deferred();entries.push({count, reached: {resolve: () => reached.resolve()}});if (state.active >= count) reached.resolve();return reached.promise;},
    // releases the held reads and settles every barrier still waiting for a count
    release: () => {state.released = true;gate.resolve();for (const entry of entries) entry.reached.resolve();},
  };
};

it("a cycle and a retry for one main supervise it one at a time under its scope key", {timeout: 10_000}, async t => {
  const fixture = await makeFixture([{threadId: "main", projectId: "project-a", turns: earlier}]);
  after(t, fixture.cleanup);
  const binding = reserveReadyBinding(fixture, "main");
  const key = supervisorScopeKey("project-a", "main");
  const events: string[] = [];
  let onWait: (lockKey: string) => void = () => undefined;
  const supervisor = fixture.makeSupervisor({locks: observedLocks(events, lockKey => onWait(lockKey))});
  const reads = holdSupervisorReads(fixture, new Set([binding.threadId]));

  // the cycle holds the main's key while its Supervisor read is held
  const cycle = supervisor.runOnce(AbortSignal.timeout(8_000));
  await within(reads.reached(1), 5_000, "the cycle's Supervisor read");
  assert.equal(events.at(-1), `hold ${key}`);
  assert.equal(supervisor.queues.size, 1);

  // the retry for the same main queues behind it on the same key
  const queued = deferred();
  onWait = lockKey => {if (lockKey === key) queued.resolve();};
  const retry = supervisor.retry(retryInput("project-a", 0, binding, "retry"), AbortSignal.timeout(8_000));
  // the retry either waits for the main's key or, unserialized, reaches the main's Supervisor read beside the cycle
  await within(Promise.race([queued.promise, reads.reached(2)]), 5_000, "the retry waiting for the main's key");
  const waitedAt = events.length;
  assert.equal(reads.state.active, 1, "only the cycle is inside the main's supervision");
  assert.equal(events.at(-1), `wait ${key}`);
  assert.equal(supervisor.queues.size, 1, "both callers lease the one key of the main");

  reads.release();
  await within(Promise.all([cycle, retry]), 5_000, "the cycle and the retry");
  assert.equal(reads.state.maxActive, 1, "the two callers never read the main's Supervisor at the same time");
  // the retry holds the key only after the cycle released it
  const after_ = events.slice(waitedAt);
  assert.ok(after_.indexOf(`release ${key}`) >= 0 && after_.indexOf(`release ${key}`) < after_.indexOf(`hold ${key}`), after_.join(", "));
  assert.equal(supervisor.queues.size, 0);
});

it("one cycle supervises two mains of a binding batch side by side under their own keys", {timeout: 10_000}, async t => {
  const fixture = await makeFixture([{threadId: "main-a", projectId: "project-a", turns: earlier}, {threadId: "main-b", projectId: "project-a", turns: earlier}]);
  after(t, fixture.cleanup);
  const first = reserveReadyBinding(fixture, "main-a");
  const second = reserveReadyBinding(fixture, "main-b");
  const events: string[] = [];
  const supervisor = fixture.makeSupervisor({locks: observedLocks(events, () => undefined)});
  const reads = holdSupervisorReads(fixture, new Set([first.threadId, second.threadId]));

  const cycle = supervisor.runOnce(AbortSignal.timeout(8_000));
  // both mains are inside their supervision at once: one key each, neither waiting for the other
  await within(reads.reached(2), 5_000, "both Supervisor reads");
  assert.equal(supervisor.queues.size, 2);
  assert.ok(events.includes(`hold ${supervisorScopeKey("project-a", "main-a")}`) && events.includes(`hold ${supervisorScopeKey("project-a", "main-b")}`));
  reads.release();
  await within(cycle, 5_000, "the cycle");
  assert.equal(reads.state.maxActive, 2);
  assert.equal(supervisor.queues.size, 0);
});
