import assert from "node:assert/strict";
import { it } from "vitest";
import { createSetupFence } from "../ui/src/supervisor-control.js";

// only the exported fence is pinned here; the panel's request/read race lives in component state (mounted story UI-STORY-07)
it("CT-UI-SETUP-01: overlapping setup requests stay fenced until a read that started after all of them ended, and confirmation releases only one request", {timeout: 10_000}, () => {
  const states: Array<{fenced: boolean; pending: boolean}> = [];
  const fence = createSetupFence(state => {states.push({...state});});

  fence.request(true);
  fence.request(true);
  const readDuringBoth = fence.epoch();
  fence.request(false);
  const readDuringOne = fence.epoch();
  fence.verified(readDuringBoth);
  fence.verified(readDuringOne);
  assert.deepEqual(states.at(-1), {fenced: true, pending: true}, "no read clears the fence while a request is still running");
  fence.request(false);
  fence.verified(readDuringOne);
  assert.deepEqual(states.at(-1), {fenced: true, pending: false}, "a read that started before the last request ended is stale");
  const settledRead = fence.epoch();
  fence.verified(settledRead);
  assert.deepEqual(states, [
    {fenced: true, pending: true}, {fenced: true, pending: true}, {fenced: true, pending: true}, {fenced: true, pending: false}, {fenced: false, pending: false},
  ]);
  assert.equal(settledRead, 4, "each request start and end advances the epoch");

  // a latch fences once and invalidates reads that started before it
  states.length = 0;
  const beforeLatch = fence.epoch();
  fence.latch();
  fence.latch();
  fence.verified(beforeLatch);
  assert.deepEqual(states, [{fenced: true, pending: false}]);
  fence.verified(fence.epoch());
  assert.deepEqual(states.at(-1), {fenced: false, pending: false});

  // a confirmed result releases the fence only while at most one request is active
  states.length = 0;
  fence.request(true);
  fence.request(true);
  fence.confirmed();
  assert.deepEqual(states.at(-1), {fenced: true, pending: true});
  fence.request(false);
  fence.confirmed();
  assert.deepEqual(states.at(-1), {fenced: false, pending: true}, "confirmation releases while the last request is still active");
  fence.request(false);
  assert.deepEqual(states, [{fenced: true, pending: true}, {fenced: true, pending: true}, {fenced: true, pending: true}, {fenced: false, pending: true},
    {fenced: false, pending: false}]);
  // an unmatched end never drives the active count below zero
  fence.request(false);
  fence.request(true);
  assert.deepEqual(states.at(-1), {fenced: true, pending: true});
});
