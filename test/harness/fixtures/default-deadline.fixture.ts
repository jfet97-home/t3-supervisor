import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";

// tests without their own timeout get the configured default; a slow test keeps its explicit bound
const markers = process.env.HARNESS_MARKERS ?? "";

it.effect("unlisted never-ending effect", () =>
  Effect.never.pipe(Effect.ensuring(Effect.sync(() => writeFileSync(join(markers, "default-deadline-finalized.json"), JSON.stringify({ finalized: 1 }))))));

it("unlisted never-resolving promise", () => new Promise<never>(() => undefined));

it("listed slow test with its explicit bound", { timeout: 2_000 }, () => new Promise<void>((resolve) => setTimeout(resolve, 600)));
