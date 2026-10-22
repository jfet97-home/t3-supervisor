import { afterAll, describe, it, onTestFinished } from "vitest";

it("hanging finalizer", () => {
  onTestFinished(() => new Promise<never>(() => undefined));
});

it("throwing finalizer", () => {
  onTestFinished(() => {
    throw new Error("finalizer failed");
  });
});

describe("hanging suite finalizer", () => {
  afterAll(() => new Promise<never>(() => undefined));
  it("passing body", () => undefined);
});
