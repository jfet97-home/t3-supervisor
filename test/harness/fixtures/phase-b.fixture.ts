import { expect, it } from "vitest";
import { mark } from "./phase-marker.js";

it("b one", () => {
  mark("phase-b");
  expect(1).toBe(1);
});

it("b two", () => {
  mark("phase-b-two");
  expect(2).toBe(2);
});
