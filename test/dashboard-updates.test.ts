import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { DashboardUpdates } from "../src/dashboard-updates.js";

it.live("a subscriber that misses hints reconciles through reset instead of treating a partial key set as complete", () => Effect.gen(function* () {
  const updates = yield* DashboardUpdates.make;
  const pull = yield* Stream.toPull(updates.stream);
  assert.equal((yield* pull)[0]?.event, "reset");
  for (let index = 0; index < 256; index++) yield* updates.publish([`project:fixture-${index}`]);
  yield* updates.publish(["snapshot"]);
  let reset = false;
  let cursor = 0;
  while (cursor < 257) {
    for (const event of yield* pull.pipe(Effect.timeoutOrElse({duration: "500 millis", orElse: () => Effect.sync(() => assert.fail("the latest committed hint was lost after buffer overflow"))}))) {
      cursor = Number(event.id);
      if (event.event === "reset") {
        reset = true;
        assert.deepEqual(JSON.parse(event.data), {keys: []});
      }
    }
  }
  assert.equal(reset, true, "a skipped cursor cannot leave a partial key set looking complete");
}).pipe(Effect.timeout("3 seconds")), {timeout: 5_000});
