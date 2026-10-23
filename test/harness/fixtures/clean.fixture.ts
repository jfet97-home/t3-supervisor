import { it } from "vitest";

it("clears its interval", () => {
  clearInterval(setInterval(() => undefined, 60_000));
});
