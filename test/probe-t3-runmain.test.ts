import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "vitest";
import { exitTimeoutMs, probeHarness } from "./support/cli-probe.js";
import { privately } from "./support/private-assert.js";

// target behaviour of scripts/probe-t3.ts on runMain: the token is a non-empty trimmed value read only from T3_TOKEN_FILE,
// every token failure prints one fixed line without a stack, and a signal interrupts the watch without writing to T3

it("probe token: a blank token file and an empty T3_TOKEN_FILE exit 1 with a fixed line before any temp directory or T3 contact",
  { timeout: 60_000 }, async (t) => {
    const harness = await probeHarness(t, { activeThreads: 1, archiveThreads: 1 });
    const blankFile = join(harness.temporary, "..", "blank-token");
    await writeFile(blankFile, " \n\t\n", { mode: 0o600 });
    const blank = await harness.start({ ...harness.env, T3_TOKEN_FILE: blankFile }).closed(exitTimeoutMs);
    privately("blank token file", [harness.token], () =>
      assert.deepEqual(blank, { code: 1, signal: null, stdout: "", stderr: "T3_TOKEN_FILE holds no token\n" }));
    const empty = await harness.start({ ...harness.env, T3_TOKEN_FILE: "" }).closed(exitTimeoutMs);
    privately("empty T3_TOKEN_FILE", [harness.token], () =>
      assert.deepEqual(empty, { code: 1, signal: null, stdout: "", stderr: "Set T3_TOKEN_FILE to the private credential path\n" }));
    assert.deepEqual(await harness.probeDirectories(), []);
    assert.deepEqual(harness.fake.traffic.http, []);
    assert.equal(harness.fake.traffic.upgrades, 0);
  });

it("probe token: a missing token file exits 1 with one line naming node's errno text and no stack", { timeout: 60_000 }, async (t) => {
  const harness = await probeHarness(t, { activeThreads: 1, archiveThreads: 1 });
  const missingFile = join(harness.temporary, "..", "missing-token");
  const absent = await harness.start({ ...harness.env, T3_TOKEN_FILE: missingFile }).closed(exitTimeoutMs);
  privately("missing token file", [harness.token], () => assert.deepEqual(absent, {
    code: 1, signal: null, stdout: "", stderr: `T3_TOKEN_FILE could not be read: ENOENT: no such file or directory, open '${missingFile}'\n`,
  }));
  assert.deepEqual(await harness.probeDirectories(), []);
  assert.deepEqual(harness.fake.traffic.http, []);
});

it("BC-PROBE-02: SIGINT or SIGTERM during the watch writes nothing to T3 after the active snapshot ack and removes its temp directory",
  { timeout: 60_000 }, async (t) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const harness = await probeHarness(t, { activeThreads: 1, sendArchiveSnapshot: false });
      const child = harness.start();
      await harness.fake.until((traffic) => traffic.acks.includes("1"), exitTimeoutMs, "the active snapshot ack");
      process.kill(child.pid, signal);
      const interrupted = await child.closed(exitTimeoutMs);
      privately(`probe stopped by ${signal}`, [harness.token], () =>
        assert.deepEqual(interrupted, { code: 130, signal: null, stdout: "", stderr: "" }));
      assert.deepEqual(harness.fake.traffic, {
        http: ["GET /.well-known/t3/environment"],
        requests: ["orchestration.subscribeShell", "orchestration.subscribeArchivedShell"],
        acks: ["1"],
        frames: ["Request", "Request", "Ack"],
        unauthorized: 0,
        upgrades: 1,
      }, signal);
      assert.deepEqual(await harness.probeDirectories(), [], signal);
    }
  });
