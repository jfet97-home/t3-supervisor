import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";
import { childFailure, privately } from "../../support/private-assert.js";

// every assertion shape the cli and auth suites use, failing on a synthetic token; the outer test checks that
// neither the console nor the json report carries the token bytes
const token = (): string => randomBytes(32).toString("base64url");
const issued = token();
const unknownInStderr = token();
const knownInStdout = token();
const secretInMessage = token();
const childOutput = token();
const matchedStderr = token();
const eventStdout = token();
writeFileSync(join(process.env.HARNESS_MARKERS ?? "", "private-tokens.json"),
  JSON.stringify([issued, unknownInStderr, knownInStdout, secretInMessage, childOutput, matchedStderr, eventStdout]));

it("a repeated token fails as a boolean", () => {
  const forged = [issued, issued];
  assert.equal(forged[0] === forged[1], false, "every forge issues a new token");
});

it("a token in stderr fails the exact output comparison", () => {
  privately("forge output", [], () => assert.deepEqual({ code: 0, stderr: `${unknownInStderr}\n`, stdout: "" }, { code: 0, stderr: "", stdout: "" }));
});

it("a known token in stdout fails the exact output comparison", () => {
  privately("probe output", [knownInStdout], () => assert.deepEqual({ stdout: `verified ${knownInStdout}\n` }, { stdout: "verified\n" }));
});

it("a secret inside an error message fails the message comparison", () => {
  privately("failure messages", [secretInMessage], () => assert.deepEqual([`invalid service auth ${secretInMessage}`], ["invalid service auth"]));
});

it("a failed child process with a token in its output", async () => {
  await promisify(execFile)(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(childOutput)}); process.exit(3)`])
    .catch((error: unknown) => { throw childFailure("auth forge child", error); });
});

it("a token in stderr fails the pattern match", () => {
  privately("startup failure", [], () => assert.match(`Error: ${matchedStderr}\n`, /^Error: invalid_helper_provider_instance_id$/mu));
});

it("a token in a non-json stdout line fails the event parse", () => {
  const events = (stdout: string): unknown[] => stdout.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { event?: unknown }).event);
  privately("shutdown output", [], () => assert.deepEqual(events(`{"event":"supervisor_started"}\nbearer ${eventStdout}\n`), ["supervisor_started"]));
});
