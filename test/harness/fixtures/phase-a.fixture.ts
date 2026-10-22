import { expect, it } from "vitest";
import { mark } from "./phase-marker.js";

it("a one", () => {
  mark("phase-a");
  expect(1).toBe(1);
});

it("a two", () => {
  expect(2).toBe(2);
});
