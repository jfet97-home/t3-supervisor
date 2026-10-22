import { describe, expect, it } from "vitest";
import type { Vitest } from "vitest/node";
import { evaluateLeaks, LeakGate, leakAllowlist, type LeakAllowance } from "../support/leak-gate.js";
import { readTestResults, runFixture } from "./fixture-run.js";

const root = "/repo";

const leak = (type: string, frames: ReadonlyArray<string>, file = "/repo/test/a.test.ts") => ({
  type,
  stack: ["Error: VITEST_DETECT_ASYNC_LEAKS", ...frames.map((frame) => `    at ${frame}`)].join("\n"),
  filename: file,
  projectName: "",
});

const timer = leak("Timeout", [
  "new Timeout (node:internal/timers:200:12)",
  "file:///repo/node_modules/vitest/dist/chunks/index.js:40:7",
  "startPolling (/repo/src/poller.ts:12:5)",
  "/repo/test/a.test.ts:8:3",
]);

const allowance: LeakAllowance = {
  kind: "Timeout",
  source: "src/poller.ts:12:5",
  file: "test/a.test.ts",
  maxCount: 1,
  removedIn: "S6b",
  reason: "poller interval outlives the test until the controller owns its scope",
};

const runGate = (state: unknown, detectAsyncLeaks: unknown = true) => {
  const lines: string[] = [];
  let failures = 0;
  const gate = new LeakGate({ allowlist: [], write: (line) => lines.push(line), fail: () => { failures += 1; } });
  gate.onInit({ state, config: { detectAsyncLeaks, root } } as unknown as Vitest);
  gate.onTestRunEnd();
  return { lines, failures };
};

describe("leak gate reporter", () => {
  it("ships an empty allowlist", () => {
    expect(leakAllowlist).toEqual([]);
  });

  it("fails closed when vitest state has no leakSet", () => {
    expect(runGate({})).toEqual({ lines: ["leak-gate: vitest state.leakSet is missing or not a Set; failing closed"], failures: 1 });
  });

  it("fails closed when leakSet is not a Set", () => {
    expect(runGate({ leakSet: [timer] })).toEqual({ lines: ["leak-gate: vitest state.leakSet is missing or not a Set; failing closed"], failures: 1 });
  });

  it("fails closed when leak detection is disabled", () => {
    expect(runGate({ leakSet: new Set() }, false)).toEqual({ lines: ["leak-gate: detectAsyncLeaks is not enabled; failing closed"], failures: 1 });
  });

  it("fails closed when it was never initialised", () => {
    let failures = 0;
    new LeakGate({ write: () => undefined, fail: () => { failures += 1; } }).onTestRunEnd();
    expect(failures).toBe(1);
  });

  it("passes an empty leak set", () => {
    expect(runGate({ leakSet: new Set() })).toEqual({ lines: ["leak-gate: 0 leak(s), 0 allowlisted, 0 unexpected"], failures: 0 });
  });

  it("reports an unexpected leak by kind, first repository frame and file", () => {
    expect(runGate({ leakSet: new Set([timer]) })).toEqual({
      lines: ["leak-gate: 1 leak(s), 0 allowlisted, 1 unexpected", "leak-gate: unexpected Timeout from src/poller.ts:12:5 in test/a.test.ts"],
      failures: 1,
    });
  });

  it("covers allowlisted leaks up to their maximum count only", () => {
    const second = { ...timer };
    expect(evaluateLeaks({ leakSet: new Set([timer]) }, true, root, [allowance])).toEqual({
      failed: false,
      lines: ["leak-gate: 1 leak(s), 1 allowlisted, 0 unexpected"],
    });
    expect(evaluateLeaks({ leakSet: new Set([timer, second]) }, true, root, [allowance])).toEqual({
      failed: true,
      lines: ["leak-gate: 2 leak(s), 1 allowlisted, 1 unexpected", "leak-gate: unexpected Timeout from src/poller.ts:12:5 in test/a.test.ts"],
    });
  });

  it("does not let an allowance cover another file, kind or source", () => {
    const leaks = new Set([
      leak("Timeout", ["startPolling (/repo/src/poller.ts:12:5)"], "/repo/test/b.test.ts"),
      leak("Immediate", ["startPolling (/repo/src/poller.ts:12:5)"]),
      leak("Timeout", ["startPolling (/repo/src/poller.ts:13:5)"]),
    ]);
    const verdict = evaluateLeaks({ leakSet: leaks }, true, root, [{ ...allowance, maxCount: 3 }]);
    expect(verdict.failed).toBe(true);
    expect(verdict.lines[0]).toBe("leak-gate: 3 leak(s), 0 allowlisted, 3 unexpected");
  });

  it("fails closed on an incomplete allowlist entry", () => {
    expect(evaluateLeaks({ leakSet: new Set() }, true, root, [{ ...allowance, removedIn: "" }])).toEqual({
      failed: true,
      lines: ["leak-gate: invalid allowlist entry for Timeout src/poller.ts:12:5 in test/a.test.ts; failing closed"],
    });
  });
});

describe("leak gate in a nested run", () => {
  it("fails a run whose passing test leaks an interval, despite a cli reporter override", async () => {
    const { run, report } = await runFixture("leak", 30_000);
    expect(run.code).toBe(1);
    expect((await readTestResults(report)).get("leaves an interval running")?.status).toBe("passed");
    expect(run.output).toContain("leak-gate: 1 leak(s), 0 allowlisted, 1 unexpected");
    expect(run.output).toContain("leak-gate: unexpected Timeout from test/harness/fixtures/leak.fixture.ts:4:3 in test/harness/fixtures/leak.fixture.ts");
  });

  it("passes a clean run", async () => {
    const { run, report } = await runFixture("clean", 30_000);
    expect(run.code).toBe(0);
    expect((await readTestResults(report)).get("clears its interval")?.status).toBe("passed");
    expect(run.output).toContain("leak-gate: 0 leak(s), 0 allowlisted, 0 unexpected");
  });
});
