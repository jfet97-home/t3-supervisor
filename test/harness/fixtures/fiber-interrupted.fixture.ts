import { Effect, Fiber } from "effect";
import { it } from "vitest";

it("interrupted fiber", async () => {
  const fiber = Effect.runFork(Effect.never);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Effect.runPromise(Fiber.interrupt(fiber));
});
