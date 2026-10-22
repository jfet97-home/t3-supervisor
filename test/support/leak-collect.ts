import { afterAll } from "vitest";

// node emits `destroy` for an unreachable async resource (such as the context effect keeps for a suspended fiber)
// only after garbage collection; collecting before vitest's leak scan leaves the resources that are still reachable,
// while active handles keep reporting through hasRef and pending promises stay pending
afterAll(async () => {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (typeof collect !== "function") throw new Error("leak-gate: test workers must run with --expose-gc");
  collect();
  await new Promise((resolve) => setImmediate(resolve));
});
