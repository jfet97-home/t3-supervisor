import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { exitTimeoutMs } from "./support/cli-probe.js";
import { probeHarness } from "./support/g8-cli.js";
import { privately } from "./support/private-assert.js";

// target behaviour of scripts/probe-t3.ts on runMain: the token is a non-empty trimmed value read only from T3_TOKEN_FILE,
// every token failure prints one fixed line without a stack, and a signal interrupts the watch without writing to T3.
// live (it.live): child processes and a loopback peer

it.live("probe token: a blank token file and an empty T3_TOKEN_FILE exit 1 with a fixed line before any temp directory or T3 contact",
  () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const harness = yield* probeHarness({ activeThreads: 1, archiveThreads: 1 });
    const blankFile = join(harness.temporary, "..", "blank-token");
    yield* fs.writeFileString(blankFile, " \n\t\n", { mode: 0o600 });
    const blank = yield* (yield* harness.start({ ...harness.env, T3_TOKEN_FILE: blankFile })).closed(exitTimeoutMs);
    privately("blank token file", [harness.token], () =>
      assert.deepEqual(blank, { code: 1, signal: null, stdout: "", stderr: "T3_TOKEN_FILE holds no token\n" }));
    const empty = yield* (yield* harness.start({ ...harness.env, T3_TOKEN_FILE: "" })).closed(exitTimeoutMs);
    privately("empty T3_TOKEN_FILE", [harness.token], () =>
      assert.deepEqual(empty, { code: 1, signal: null, stdout: "", stderr: "Set T3_TOKEN_FILE to the private credential path\n" }));
    assert.deepEqual(yield* harness.probeDirectories, []);
    assert.deepEqual(harness.fake.traffic.http, []);
    assert.equal(harness.fake.traffic.upgrades, 0);
  }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

it.live("probe token: a missing token file exits 1 with one line naming node's errno text and no stack", () => Effect.gen(function* () {
  const harness = yield* probeHarness({ activeThreads: 1, archiveThreads: 1 });
  const missingFile = join(harness.temporary, "..", "missing-token");
  const absent = yield* (yield* harness.start({ ...harness.env, T3_TOKEN_FILE: missingFile })).closed(exitTimeoutMs);
  privately("missing token file", [harness.token], () => assert.deepEqual(absent, {
    code: 1, signal: null, stdout: "", stderr: `T3_TOKEN_FILE could not be read: ENOENT: no such file or directory, open '${missingFile}'\n`,
  }));
  assert.deepEqual(yield* harness.probeDirectories, []);
  assert.deepEqual(harness.fake.traffic.http, []);
}).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });

it.live("BC-PROBE-02: SIGINT or SIGTERM during the watch writes nothing to T3 after the active snapshot ack and removes its temp directory",
  () => Effect.gen(function* () {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const harness = yield* probeHarness({ activeThreads: 1, sendArchiveSnapshot: false });
      const child = yield* harness.start();
      yield* harness.fake.until((traffic) => traffic.acks.includes("1"), exitTimeoutMs, "the active snapshot ack");
      process.kill(child.pid, signal);
      const interrupted = yield* child.closed(exitTimeoutMs);
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
      assert.deepEqual(yield* harness.probeDirectories, [], signal);
    }
  }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 60_000 });
