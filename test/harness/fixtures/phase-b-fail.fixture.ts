import { expect, it } from "vitest";
import { mark } from "./phase-marker.js";

it("b fails", () => {
  mark("phase-b-fail");
  expect(1).toBe(2);
});
