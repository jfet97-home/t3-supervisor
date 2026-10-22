import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "vitest";
import { leakedSecrets, type ProcessResult } from "./support/cli-process.js";
import { exitTimeoutMs, failedLine, probeHarness, verifiedLine } from "./support/cli-probe.js";
import { privately } from "./support/private-assert.js";

// scripts/probe-t3.ts in a real child process against a loopback fake T3; real providers are never configured

it("CT-PROBE-T3-01: a verified probe prints exactly one success line, exits 0 and removes its temp directory", { timeout: 60_000 }, async (t) => {
  const harness = await probeHarness(t, { activeThreads: 2, archiveThreads: 1 });
  const result = await harness.start().closed(exitTimeoutMs);
  privately("verified probe", [harness.token], () => assert.deepEqual(result, { code: 0, signal: null, stdout: verifiedLine(3), stderr: "" }));
  assert.deepEqual(await harness.probeDirectories(), []);
});

it("CT-PROBE-T3-02: a refused token prints the verified:false line and exits 1 with its temp directory removed; a missing T3_TOKEN_FILE exits 1 with a fixed message",
  { timeout: 60_000 }, async (t) => {
    const harness = await probeHarness(t, { serverToken: "a-different-token", activeThreads: 1, archiveThreads: 1 });
    const refused = await harness.start().closed(exitTimeoutMs);
    // the fingerprint-only leak check runs before the exact output comparison, which fails without rendering a token
    assert.deepEqual(leakedSecrets(refused.stdout + refused.stderr, [harness.token]), []);
    privately("refused probe", [harness.token], () => assert.deepEqual(refused, { code: 1, signal: null, stdout: failedLine(false), stderr: "" }));
    assert.deepEqual(harness.fake.traffic.http, ["GET /.well-known/t3/environment"]);
    assert.equal(harness.fake.traffic.unauthorized, 1);
    assert.deepEqual(await harness.probeDirectories(), []);

    // BC-PROBE-01: an unset T3_TOKEN_FILE prints one fixed line and no stack (baseline: node's uncaught error with its stack)
    const unset: NodeJS.ProcessEnv = { ...harness.env };
    delete unset.T3_TOKEN_FILE;
    const missingVariable: ProcessResult = await harness.start(unset).closed(exitTimeoutMs);
    privately("missing T3_TOKEN_FILE", [harness.token], () => {
      assert.deepEqual({ code: missingVariable.code, signal: missingVariable.signal, stdout: missingVariable.stdout }, { code: 1, signal: null, stdout: "" });
      assert.equal(missingVariable.stderr, "Set T3_TOKEN_FILE to the private credential path\n");
    });
    const missingFile = join(harness.temporary, "..", "missing-token");
    const absent: ProcessResult = await harness.start({ ...harness.env, T3_TOKEN_FILE: missingFile }).closed(exitTimeoutMs);
    privately("missing token file", [harness.token], () => {
      assert.deepEqual({ code: absent.code, signal: absent.signal, stdout: absent.stdout }, { code: 1, signal: null, stdout: "" });
      assert.match(absent.stderr, /ENOENT: no such file or directory, open '[^']+missing-token'/u);
    });
    assert.deepEqual(await harness.probeDirectories(), [], "the token is read before the temp directory is created");
    assert.deepEqual(harness.fake.traffic.http, ["GET /.well-known/t3/environment"], "neither failure contacts T3");
  });

it("CT-PROBE-T3-03: SIGINT during the watch interrupts the probe, removes its temp directory and exits with the interrupt code",
  { timeout: 60_000 }, async (t) => {
    const harness = await probeHarness(t, { activeThreads: 1, sendArchiveSnapshot: false });
    const child = harness.start();
    // the active snapshot is ingested and acknowledged; the archive snapshot never comes
    await harness.fake.until((traffic) => traffic.acks.includes("1"), exitTimeoutMs, "the active snapshot ack");
    process.kill(child.pid, "SIGINT");
    const interrupted = await child.closed(exitTimeoutMs);
    // BC-PROBE-02: runMain interrupts the program, whose scope removes the temp directory and its catalog, and exits 130
    // (baseline: the default disposition killed the probe by SIGINT and left the directory behind)
    privately("interrupted probe", [harness.token], () => assert.deepEqual(interrupted, { code: 130, signal: null, stdout: "", stderr: "" }));
    assert.deepEqual(await harness.probeDirectories(), []);
  });

it("CT-PROBE-T3-04: the probe issues only the descriptor read, the two shell subscriptions and an Ack", { timeout: 60_000 }, async (t) => {
  const harness = await probeHarness(t, { activeThreads: 1, archiveThreads: 1 });
  const result = await harness.start().closed(exitTimeoutMs);
  privately("verified probe", [harness.token], () => assert.deepEqual(result, { code: 0, signal: null, stdout: verifiedLine(2), stderr: "" }));
  // the archive chunk completes the probe inside its item handler, so only the active chunk is acknowledged
  assert.deepEqual(harness.fake.traffic, {
    http: ["GET /.well-known/t3/environment"],
    requests: ["orchestration.subscribeShell", "orchestration.subscribeArchivedShell"],
    acks: ["1"],
    frames: ["Request", "Request", "Ack"],
    unauthorized: 0,
    upgrades: 1,
  });
});

it("CT-PROBE-T3-05: the fixed 30 s deadline ends a probe whose archive snapshot never arrives with the verified:false line and exit 1",
  { timeout: 60_000 }, async (t) => {
    const harness = await probeHarness(t, { activeThreads: 1, sendArchiveSnapshot: false });
    const child = harness.start();
    const result = await child.closed(50_000);
    const elapsedMs = performance.now() - child.startedAt;
    privately("expired probe", [harness.token], () => assert.deepEqual(result, { code: 1, signal: null, stdout: failedLine(true), stderr: "" }));
    assert.ok(elapsedMs >= 30_000 && elapsedMs < 45_000, `the probe ended after ${Math.round(elapsedMs)} ms`);
    assert.deepEqual(await harness.probeDirectories(), []);
  });
