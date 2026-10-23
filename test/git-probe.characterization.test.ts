import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { GitProbeError } from "../src/git-probe.js";
import { type ProbeStatus } from "./support/c3a-fake-terminal-t3.js";
import { fakeTerminalT3, probeGuidance } from "./support/g10-probe-guidance.js";

// it.live: the probes run over the c3a loopback terminal T3 (real sockets) and keep their pending sessions in a guidance file

const root = "/workspace";
const status: ProbeStatus = { workspaceRoot: root, branch: "main", isRepo: true, changedPaths: [], operationState: { status: "safe" } };
const probeToken = "terminal-operate-test-token";

it.live("CT-PROBE-02: aborting a probe mid-stream still closes the terminal with deleteHistory and drops the pending entry", () => Effect.gen(function* () {
  const t3 = yield* fakeTerminalT3(status, () => true);
  const state = yield* probeGuidance("t3-git-probe-characterization-");
  const probe = yield* state.gitProbe(t3.url, probeToken);
  const cancel = yield* Deferred.make<void>();
  const outcome = yield* Effect.forkChild(probe.probe(root, cancel).pipe(Effect.match({ onSuccess: (result) => ({ result }), onFailure: (error) => ({ error }) })));
  // the helper is written and answered; the attach stream is open and the result is withheld
  const session = yield* Effect.promise(() => t3.helperWritten);
  assert.ok(session);
  assert.deepEqual(yield* state.pendingSessions, [session]);
  assert.deepEqual(t3.requests.map((request) => request.tag),
    ["terminal.open", "terminal.attach", "terminal.write", "terminal.write"]);

  yield* Deferred.succeed(cancel, undefined);
  const settled = yield* Fiber.join(outcome);
  assert.ok("error" in settled && settled.error instanceof GitProbeError);
  assert.equal(settled.error.message, "The terminal Git probe was canceled or disconnected.");
  yield* Effect.promise(() => t3.attachGone(session.threadId));
  const closes = t3.requests.filter((request) => request.tag === "terminal.close");
  assert.deepEqual(closes.map((request) => request.payload), [{ ...session, deleteHistory: true }]);
  assert.deepEqual(yield* state.pendingSessions, []);
}), { timeout: 10_000 });

it.live("CT-PROBE-03: two concurrent probes are serialized so the second terminal opens only after the first closes", () => Effect.gen(function* () {
  const t3 = yield* fakeTerminalT3(status, (index) => index === 0);
  const state = yield* probeGuidance("t3-git-probe-characterization-");
  const probe = yield* state.gitProbe(t3.url, probeToken);
  const first = yield* Effect.forkChild(probe.probe(root));
  const second = yield* Effect.forkChild(probe.probe(root));
  const held = yield* Effect.promise(() => t3.helperWritten);
  assert.ok(held);
  // the first probe is mid-stream and the second has not reached T3
  assert.deepEqual(t3.requests.map((request) => [request.tag, request.threadId === held.threadId]), [
    ["terminal.open", true], ["terminal.attach", true], ["terminal.write", true], ["terminal.write", true],
  ]);

  t3.releaseResult();
  assert.deepEqual(yield* Fiber.joinAll([first, second]), [status, status]);
  const order = t3.requests.map((request) => `${request.tag}:${request.threadId === held.threadId ? "first" : "second"}`);
  assert.deepEqual(order, [
    "terminal.open:first", "terminal.attach:first", "terminal.write:first", "terminal.write:first", "terminal.close:first",
    "terminal.open:second", "terminal.attach:second", "terminal.write:second", "terminal.write:second", "terminal.close:second",
  ]);
  assert.deepEqual(yield* state.pendingSessions, []);
}), { timeout: 10_000 });
