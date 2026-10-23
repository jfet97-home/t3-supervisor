import { Deferred, Effect, Fiber } from "effect";
import { it } from "vitest";

// a suspended fiber that is still referenced when the file ends is a real leak, even without a timer or socket
export const retained: Array<Fiber.Fiber<unknown, unknown>> = [];

it("retained suspended fiber", async () => {
  const never = Effect.runSync(Deferred.make<void>());
  retained.push(Effect.runFork(Effect.flatMap(Effect.yieldNow, () => Deferred.await(never))));
  await new Promise((resolve) => setTimeout(resolve, 10));
});
