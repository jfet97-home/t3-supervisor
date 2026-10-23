import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readTestResults, runFixture } from "./fixture-run.js";

describe("private assertions in a nested run", () => {
  it("token-bearing failures still fail, and neither the console nor the json report carries a token", async () => {
    const { run, report, markers } = await runFixture("private-assert", 30_000);
    const tokens = JSON.parse(await readFile(`${markers}/private-tokens.json`, "utf8")) as string[];
    const results = await readTestResults(report);
    expect(run.code).toBe(1);
    expect([...results.values()].map((result) => result.status)).toEqual(["failed", "failed", "failed", "failed", "failed", "failed", "failed"]);
    expect(results.get("a token in stderr fails the exact output comparison")?.failureMessages[0]).toMatch(/^Error: forge output: /u);
    expect(results.get("a failed child process with a token in its output")?.failureMessages[0])
      .toMatch(/^Error: auth forge child failed \(code 3, signal null, stdout 43 bytes, stderr 0 bytes\)/u);
    const reportText = await readFile(report, "utf8");
    expect(results.get("a token in stderr fails the pattern match")?.failureMessages[0]).toMatch(/^Error: startup failure: /u);
    expect(results.get("a token in a non-json stdout line fails the event parse")?.failureMessages[0]).toMatch(/^Error: shutdown output: /u);
    expect(tokens).toHaveLength(7);
    for (const value of tokens) {
      expect(run.output.includes(value)).toBe(false);
      expect(reportText.includes(value)).toBe(false);
    }
  });
});
