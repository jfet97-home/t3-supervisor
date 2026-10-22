import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { GitProbeError } from "../src/git-probe.js";
import { makeGitProbe } from "./support/native-files-promise.js";
import { GuidanceStore } from "../src/guidance-store.js";
import { within } from "./support/c3a-fake-t3.js";
import { startFakeTerminalT3, type ProbeStatus } from "./support/c3a-fake-terminal-t3.js";

const root = "/workspace";
const status: ProbeStatus = { workspaceRoot: root, branch: "main", isRepo: true, changedPaths: [], operationState: { status: "safe" } };
const probeToken = "terminal-operate-test-token";

const storeFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "t3-git-probe-characterization-"));
  const store = new GuidanceStore(directory);
  return { store, close: () => {store.close();rmSync(directory, { recursive: true, force: true });} };
};

const pendingSessions = (store: GuidanceStore): unknown =>
  JSON.parse(String(store.db.prepare("SELECT value FROM meta WHERE key='native_git_probe_sessions'").get()?.value));

it("CT-PROBE-02: aborting a probe mid-stream still closes the terminal with deleteHistory and drops the pending entry", { timeout: 10_000 }, async () => {
  const t3 = await startFakeTerminalT3(status, () => true);
  const state = storeFixture();
  try {
    const probe = makeGitProbe(t3.url, probeToken, state.store);
    const controller = new AbortController();
    const outcome = probe.probe(root, controller.signal).then((result) => ({ result }), (error: unknown) => ({ error }));
    // the helper is written and answered; the attach stream is open and the result is withheld
    const session = await within(t3.helperWritten, 2500, "helper write");
    assert.ok(session);
    assert.deepEqual(pendingSessions(state.store), [session]);
    assert.deepEqual(t3.requests.map((request) => request.tag),
      ["terminal.open", "terminal.attach", "terminal.write", "terminal.write"]);

    controller.abort();
    const settled = await within(outcome, 2500, "probe outcome");
    assert.ok("error" in settled && settled.error instanceof GitProbeError);
    assert.equal(settled.error.message, "The terminal Git probe was canceled or disconnected.");
    await within(t3.attachGone(session.threadId), 2500, "attach stream closed by the client");
    const closes = t3.requests.filter((request) => request.tag === "terminal.close");
    assert.deepEqual(closes.map((request) => request.payload), [{ ...session, deleteHistory: true }]);
    assert.deepEqual(pendingSessions(state.store), []);
  } finally {
    state.close();
    await t3.close();
  }
});

it("CT-PROBE-03: two concurrent probes are serialized so the second terminal opens only after the first closes", { timeout: 10_000 }, async () => {
  const t3 = await startFakeTerminalT3(status, (index) => index === 0);
  const state = storeFixture();
  try {
    const probe = makeGitProbe(t3.url, probeToken, state.store);
    const first = probe.probe(root, new AbortController().signal);
    const second = probe.probe(root, new AbortController().signal);
    const held = await within(t3.helperWritten, 2500, "first helper write");
    assert.ok(held);
    // the first probe is mid-stream and the second has not reached T3
    assert.deepEqual(t3.requests.map((request) => [request.tag, request.threadId === held.threadId]), [
      ["terminal.open", true], ["terminal.attach", true], ["terminal.write", true], ["terminal.write", true],
    ]);

    t3.releaseResult();
    assert.deepEqual(await within(Promise.all([first, second]), 2500, "both probes"), [status, status]);
    const order = t3.requests.map((request) => `${request.tag}:${request.threadId === held.threadId ? "first" : "second"}`);
    assert.deepEqual(order, [
      "terminal.open:first", "terminal.attach:first", "terminal.write:first", "terminal.write:first", "terminal.close:first",
      "terminal.open:second", "terminal.attach:second", "terminal.write:second", "terminal.write:second", "terminal.close:second",
    ]);
    assert.deepEqual(pendingSessions(state.store), []);
  } finally {
    state.close();
    await t3.close();
  }
});
