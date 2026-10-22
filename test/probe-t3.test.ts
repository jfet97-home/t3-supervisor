import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "vitest";
import { startFakeT3, type FakeT3, type FakeT3Options } from "./support/cli-fake-t3.js";
import { leakedSecrets, nodePath, repositoryRoot, startProcess, tsxLoader, type ProcessResult, type RunningProcess } from "./support/cli-process.js";
import { after } from "./support/node-test.js";

// scripts/probe-t3.ts in a real child process against a loopback fake T3; real providers are never configured

const probe = join(repositoryRoot, "scripts", "probe-t3.ts");
const verifiedLine = (threads: number) =>
  `${JSON.stringify({ readOnly: true, activeSnapshot: true, archiveSnapshot: true, threads, verified: true, notificationsSent: 0 })}\n`;
const failedLine = (activeSnapshot: boolean) =>
  `${JSON.stringify({ readOnly: true, activeSnapshot, archiveSnapshot: false, verified: false })}\n`;

interface ProbeHarness {
  readonly fake: FakeT3;
  readonly token: string;
  readonly temporary: string;
  readonly env: NodeJS.ProcessEnv;
  start(env?: NodeJS.ProcessEnv): RunningProcess;
  // the probe's own mkdtemp directories under the redirected TMPDIR
  probeDirectories(): Promise<string[]>;
}

const probeHarness = async (t: TestContext, options: Omit<FakeT3Options, "token"> & { readonly serverToken?: string } = {}): Promise<ProbeHarness> => {
  const root = await mkdtemp(join(tmpdir(), "cli-probe-"));
  const children: RunningProcess[] = [];
  const started: { fake?: FakeT3 } = {};
  after(t, async () => {
    try {
      for (const child of children) await child.dispose();
      await started.fake?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const token = randomBytes(32).toString("base64url");
  const tokenFile = join(root, "t3-read-token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const temporary = join(root, "tmp");
  await mkdir(temporary);
  const fake = await startFakeT3({ ...options, token: options.serverToken ?? token });
  started.fake = fake;
  const env: NodeJS.ProcessEnv = { PATH: nodePath(), HOME: root, TMPDIR: temporary, T3_URL: fake.baseUrl, T3_TOKEN_FILE: tokenFile };
  return {
    fake, token, temporary, env,
    start: (overrides = env) => {
      const child = startProcess(process.execPath, ["--import", tsxLoader, probe], { env: overrides, cwd: root });
      children.push(child);
      return child;
    },
    probeDirectories: async () => (await readdir(temporary)).filter((name) => name.startsWith("supervisor-t3-probe-")),
  };
};

const exitTimeoutMs = 30_000;

it("CT-PROBE-T3-01: a verified probe prints exactly one success line, exits 0 and removes its temp directory", { timeout: 60_000 }, async (t) => {
  const harness = await probeHarness(t, { activeThreads: 2, archiveThreads: 1 });
  const result = await harness.start().closed(exitTimeoutMs);
  assert.deepEqual(result, { code: 0, signal: null, stdout: verifiedLine(3), stderr: "" });
  assert.deepEqual(await harness.probeDirectories(), []);
});

it("CT-PROBE-T3-02: a refused token prints the verified:false line and exits 1 with its temp directory removed; a missing T3_TOKEN_FILE throws with a stack",
  { timeout: 60_000 }, async (t) => {
    const harness = await probeHarness(t, { serverToken: "a-different-token", activeThreads: 1, archiveThreads: 1 });
    const refused = await harness.start().closed(exitTimeoutMs);
    assert.deepEqual(refused, { code: 1, signal: null, stdout: failedLine(false), stderr: "" });
    assert.deepEqual(leakedSecrets(refused.stdout + refused.stderr, [harness.token]), []);
    assert.deepEqual(harness.fake.traffic.http, ["GET /.well-known/t3/environment"]);
    assert.equal(harness.fake.traffic.unauthorized, 1);
    assert.deepEqual(await harness.probeDirectories(), []);

    // baseline: both are uncaught top-level errors printed by node with their stack (BC-PROBE-01 replaces them with a fixed message)
    const unset: NodeJS.ProcessEnv = { ...harness.env };
    delete unset.T3_TOKEN_FILE;
    const missingVariable: ProcessResult = await harness.start(unset).closed(exitTimeoutMs);
    assert.deepEqual({ code: missingVariable.code, signal: missingVariable.signal, stdout: missingVariable.stdout }, { code: 1, signal: null, stdout: "" });
    assert.match(missingVariable.stderr, /^Error: Set T3_TOKEN_FILE to the private credential path$/mu);
    assert.match(missingVariable.stderr, /^\s+at /mu);
    const missingFile = join(harness.temporary, "..", "missing-token");
    const absent: ProcessResult = await harness.start({ ...harness.env, T3_TOKEN_FILE: missingFile }).closed(exitTimeoutMs);
    assert.deepEqual({ code: absent.code, signal: absent.signal, stdout: absent.stdout }, { code: 1, signal: null, stdout: "" });
    assert.match(absent.stderr, /ENOENT: no such file or directory, open '[^']+missing-token'/u);
    assert.deepEqual(await harness.probeDirectories(), [], "the token is read before the temp directory is created");
    assert.deepEqual(harness.fake.traffic.http, ["GET /.well-known/t3/environment"], "neither failure contacts T3");
  });

it("CT-PROBE-T3-03: SIGINT during the watch ends the probe by the default signal disposition and leaves its temp directory behind",
  { timeout: 60_000 }, async (t) => {
    const harness = await probeHarness(t, { activeThreads: 1, sendArchiveSnapshot: false });
    const child = harness.start();
    // the active snapshot is ingested and acknowledged; the archive snapshot never comes
    await harness.fake.until((traffic) => traffic.acks.includes("1"), exitTimeoutMs, "the active snapshot ack");
    process.kill(child.pid, "SIGINT");
    assert.deepEqual(await child.closed(exitTimeoutMs), { code: null, signal: "SIGINT", stdout: "", stderr: "" });
    // baseline: nothing handles SIGINT, so the finally block never runs (BC-PROBE-02 removes it under runMain)
    const left = await harness.probeDirectories();
    assert.equal(left.length, 1);
    assert.ok((await readdir(join(harness.temporary, left[0] ?? ""))).includes("catalog.sqlite3"));
  });

it("CT-PROBE-T3-04: the probe issues only the descriptor read, the two shell subscriptions and an Ack", { timeout: 60_000 }, async (t) => {
  const harness = await probeHarness(t, { activeThreads: 1, archiveThreads: 1 });
  const result = await harness.start().closed(exitTimeoutMs);
  assert.deepEqual(result, { code: 0, signal: null, stdout: verifiedLine(2), stderr: "" });
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
    assert.deepEqual(result, { code: 1, signal: null, stdout: failedLine(true), stderr: "" });
    assert.ok(elapsedMs >= 30_000 && elapsedMs < 45_000, `the probe ended after ${Math.round(elapsedMs)} ms`);
    assert.deepEqual(await harness.probeDirectories(), []);
  });
