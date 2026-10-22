import { it } from "vitest";

it("leaves an interval running", () => {
  setInterval(() => undefined, 60_000);
});
