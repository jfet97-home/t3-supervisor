import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";

// an @effect/vitest per-test timeout interrupts the effect fiber and runs its finalizer
const markers = process.env.HARNESS_MARKERS ?? "";

it.effect("never-ending effect with a finalizer", () =>
  Effect.never.pipe(Effect.ensuring(Effect.sync(() => writeFileSync(join(markers, "effect-finalized.json"), JSON.stringify({ finalized: 1 }))))), { timeout: 200 });

it.live("live effect bounded by an in-effect deadline", () =>
  Effect.never.pipe(Effect.timeout("50 millis"), Effect.flip, Effect.map((error) => {
    if (error._tag !== "TimeoutError") throw new Error(`unexpected ${error._tag}`);
  })), { timeout: 2_000 });
