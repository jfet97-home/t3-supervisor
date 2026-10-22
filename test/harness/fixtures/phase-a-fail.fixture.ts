import { expect, it } from "vitest";
import { mark } from "./phase-marker.js";

it("a fails", () => {
  mark("phase-a-fail");
  expect(1).toBe(2);
});
