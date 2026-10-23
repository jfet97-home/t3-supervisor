import { Effect } from "effect";
import { it } from "vitest";

it("never-resolving promise", { timeout: 200 }, async () => {
  await new Promise<never>(() => undefined);
});

it("never-resolving effect", { timeout: 200 }, () => Effect.runPromise(Effect.never));
