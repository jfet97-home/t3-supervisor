import { vi, type MockInstance, type TestContext } from "vitest";

// node:test semantics kept for the converted suites: `t.after` hooks run in registration order and stop at the
// first failure, and `t.mock.method` mocks are restored after those hooks; vitest runs onTestFinished last-first
type Finish = {hooks: Array<() => unknown>; mocks: Array<MockInstance>};
const finishes = new WeakMap<TestContext, Finish>();

const finish = (t: TestContext): Finish => {
  const existing = finishes.get(t);
  if (existing) return existing;
  const created: Finish = {hooks: [], mocks: []};
  finishes.set(t, created);
  t.onTestFinished(async () => {
    try {
      for (const hook of created.hooks) await hook();
    } finally {
      for (const mock of created.mocks) mock.mockRestore();
    }
  });
  return created;
};

/** `t.after(hook)` of node:test. */
export const after = (t: TestContext, hook: () => unknown): void => {
  finish(t).hooks.push(hook);
};

/** `t.mock.method(object, name, implementation)` of node:test, restored when the test finishes. */
export const mockMethod = (t: TestContext, object: object, name: string, implementation?: (...args: never[]) => unknown): MockInstance => {
  const spy = (vi.spyOn as unknown as (target: object, key: string) => MockInstance)(object, name);
  if (implementation !== undefined) spy.mockImplementation(implementation as (...args: unknown[]) => unknown);
  finish(t).mocks.push(spy);
  return spy;
};
