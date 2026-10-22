import { afterAll, beforeAll } from "vitest";

// fatal resource check for the suites that run without vitest's async leak detector (vitest.cpu-bound.config.ts):
// every handle or request a file opens (timers, immediates, sockets, servers, file and dns requests) must be closed
// when the file ends. it sees only native resources: pending promises and effect fibers are not covered.
if (typeof process.getActiveResourcesInfo !== "function") {
  throw new Error("handle-gate: process.getActiveResourcesInfo is unavailable; failing closed");
}

const counts = (): Map<string, number> => {
  const result = new Map<string, number>();
  for (const resource of process.getActiveResourcesInfo()) result.set(resource, (result.get(resource) ?? 0) + 1);
  return result;
};

let before = new Map<string, number>();

beforeAll(() => {
  before = counts();
});

// a closed server's or socket's handle is released in libuv's close phase, after the check phase of the loop turn in
// which its close callback ran; two turns let already closed handles finish while open ones stay counted
const loopTurns = async (turns: number): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

afterAll(async () => {
  await loopTurns(2);
  const after = counts();
  const opened = [...after].filter(([resource, count]) => count > (before.get(resource) ?? 0))
    .map(([resource, count]) => `${resource} x${count - (before.get(resource) ?? 0)}`);
  if (opened.length > 0) throw new Error(`handle-gate: the file left active resources: ${opened.join(", ")}`);
});
