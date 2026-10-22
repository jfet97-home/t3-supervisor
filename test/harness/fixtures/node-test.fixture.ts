import { it } from "vitest";
import { after, mockMethod } from "../../support/node-test.js";

// cleanup order of node:test kept by the shim: registration order, stop at the first failure, mocks restored last
const clock = { now: () => 1 };

it("ordered", (t) => {
  mockMethod(t, clock, "now", () => 2);
  after(t, () => console.log("event:ordered after-1"));
  after(t, () => console.log("event:ordered after-2"));
  after(t, () => console.log(`event:ordered ${clock.now() === 2 ? "mock-active-in-hook" : "mock-restored-too-early"}`));
});

it("failing", (t) => {
  after(t, () => { console.log("event:failing after-1"); throw new Error("first cleanup fails"); });
  after(t, () => console.log("event:failing after-2"));
});

it("next-test", () => {
  console.log(`event:next-test ${clock.now() === 1 ? "mock-restored" : "mock-leaked"}`);
});
