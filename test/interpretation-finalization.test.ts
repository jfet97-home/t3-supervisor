import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import { submissionArguments } from "./support/interpretation-submit.js";
import { planFields, startInterpretationFixture, type InterpretationFixture } from "./support/interpretation-fixture.js";

// the typed interpretation's finalization (plan 3.12 items 6, 7 and 9) over the production boundary: the real supervision cycle,
// the authenticated mcp route and write controller, the loopback native peer and the guidance file.
// it.live: every case crosses the peer's real http and websocket sockets and the real sqlite files. ct-isub-15 also waits on the
// production wake, which rechecks every 250 ms on the live clock, and checks that wall time

// one dispatched interpretation of a genuine request
const dispatched = (f: InterpretationFixture, text = "Implement the CSV export in the reports page.") => Effect.gen(function* () {
  f.addRequest("request-1", text);
  yield* f.runOnce();
  const task = yield* f.task();
  assert.equal(task.status, "waiting");
  assert.ok(task.attempt, "the request carries its minted attempt");
  return task;
});

it.live("CT-ISUB-01: a valid submission in the exact request run is submitted, finalized once on run completion and introduced once to the bound main", () => Effect.gen(function* () {
  const f = yield* startInterpretationFixture();
  const task = yield* dispatched(f);
  const request = f.interpretationDispatches();
  assert.equal(request.length, 1);
  const text = String(request[0]!.text);
  assert.ok(text.includes(task.attempt!.attemptId) && text.includes(JSON.stringify(task.attempt!.key.source)), "the request quotes its attempt and source pin");
  const reply = yield* f.submitFields(task, planFields(task));
  assert.deepEqual(reply, {httpStatus: 200, isError: false, value: {status: "submitted", attemptId: task.attempt!.attemptId, retry: "none"}});
  assert.equal((yield* f.task()).status, "waiting", "the submission records the result; it never finalizes before its run ends");
  f.endRun(task, "completed");
  yield* f.runOnce();
  const finalized = yield* f.task();
  assert.equal(finalized.status, "inferred");
  assert.equal(finalized.objective, "Implement the export");
  assert.equal(finalized.interpretationEvidence?.kind, "interpretation_submission");
  yield* f.runOnce();
  assert.equal((yield* f.task()).status, "inferred", "finalized once");
  assert.equal(f.interpretationDispatches().length, 1);
  assert.equal(f.operativeSends().length, 1, "one introduction to the bound main");
  assert.deepEqual(f.peer.unexpected, []);
}), {timeout: 60_000});

it.live("CT-ISUB-09: a completed run without a recorded submission closes unavailable; well-formed or malformed final-chat JSON and prose are ignored", () => Effect.gen(function* () {
  for (const finalText of ["well-formed", "malformed", "prose"] as const) {
    const f = yield* startInterpretationFixture();
    const task = yield* dispatched(f);
    f.endRun(task, "completed", finalText === "well-formed" ? JSON.stringify(planFields(task))
      : finalText === "malformed" ? `${JSON.stringify(planFields(task)).slice(0, -1)}` : "The task is to implement the export; I would plan one step.");
    yield* f.runOnce();
    const closed = yield* f.task();
    assert.equal(closed.status, "unavailable", finalText);
    assert.equal(closed.reason, "The Supervisor did not submit a valid, source-linked interpretation.", finalText);
    assert.equal(closed.objective, null, finalText);
    assert.equal(closed.interpretationEvidence, undefined, finalText);
    yield* f.runOnce();
    assert.equal(f.operativeSends().length, 0, finalText);
    assert.equal(f.interpretationDispatches().length, 1, `${finalText}: nothing is resent`);
  }
}), {timeout: 60_000});

it.live("CT-ISUB-10: a run that does not complete discards its submission, a rolled-back item or node discards it before apply, and another run's completion finalizes nothing", () => Effect.gen(function* () {
  for (const status of ["failed", "interrupted", "cancelled", "rolled_back"] as const) {
    const f = yield* startInterpretationFixture();
    const task = yield* dispatched(f);
    assert.equal((yield* f.submitFields(task, planFields(task))).value.status, "submitted", status);
    f.endRun(task, status);
    yield* f.runOnce();
    const closed = yield* f.task();
    assert.equal(closed.status, "unavailable", status);
    assert.equal(closed.reason, "The interpretation run did not complete successfully.", status);
    assert.equal(f.operativeSends().length, 0, status);
  }
  for (const rolledBack of ["item", "node"] as const) {
    const f = yield* startInterpretationFixture();
    const task = yield* dispatched(f);
    const args = submissionArguments(task, planFields(task));
    assert.equal((yield* f.submit(task, args, {itemId: "submission-rolled-back"})).value.status, "submitted", rolledBack);
    if (rolledBack === "item") f.setItemStatus("submission-rolled-back", "rolled_back");
    else f.setItemStatus("submission-rolled-back", "completed", "rolled_back");
    f.endRun(task, "completed");
    yield* f.runOnce();
    const closed = yield* f.task();
    assert.equal(closed.status, "unavailable", rolledBack);
    assert.equal(closed.reason, "The submitted interpretation's native tool call changed, was rolled back or could not be re-verified; it was not applied.", rolledBack);
    assert.equal(closed.objective, null, rolledBack);
    assert.equal(f.operativeSends().length, 0, `${rolledBack}: discarded before any application`);
  }
  {
    const f = yield* startInterpretationFixture();
    const task = yield* dispatched(f);
    assert.equal((yield* f.submitFields(task, planFields(task))).value.status, "submitted");
    // another completed run of the root (an unrelated turn) is not the request run
    const root = f.root();
    root.runs.push({id: "unrelated-root-run", threadId: root.thread.id, ordinal: root.runs.length + 1, status: "completed", requestedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), rootNodeId: "unrelated-root", userMessageId: "unrelated-message",
      providerThreadId: `${root.thread.id}-provider`});
    yield* f.runOnce();
    assert.equal((yield* f.task()).status, "waiting", "only the exact request run's completion finalizes");
  }
}), {timeout: 60_000});

// the final proof read awaits getturnitem after its main snapshot. a genuine source edit inside that await is a later revision
const editSourceAtProof = (f: InterpretationFixture, task: {sourceMessageId: string}) => {
  let changed = 0;
  f.native.beforeTurnItem = Effect.sync(() => {
    if (changed++) return;
    f.main().messages.find(message => message.id === task.sourceMessageId)!.text = "Hello, I do not request supervision.";
  });
  return () => changed;
};

it.live("SOL-R42-01: a genuine source edit during the final proof read applies neither a needed nor a not-needed result", () => Effect.gen(function* () {
  for (const outcome of ["needed", "not_needed"] as const) {
    const f = yield* startInterpretationFixture();
    const task = yield* dispatched(f);
    const fields = outcome === "needed" ? planFields(task) : {...planFields(task), supervision: "not_needed" as const, workflow: null};
    assert.equal((yield* f.submitFields(task, fields)).value.status, "submitted", outcome);
    f.endRun(task, "completed");
    const changed = editSourceAtProof(f, task);
    yield* f.runOnce();
    assert.ok(changed() > 0, outcome);
    const closed = yield* f.task();
    assert.equal(closed.status, "unavailable", outcome);
    assert.equal(closed.reason, "The task source changed before the interpretation completed.", outcome);
    assert.equal(closed.objective, null, outcome);
    assert.equal(closed.interpretationEvidence, undefined, outcome);
    assert.equal((yield* f.receipts()).length, 1, outcome);
    assert.equal(f.interpretationDispatches().length, 1, outcome);
    assert.equal(f.operativeSends().length, 0, outcome);
  }
}), {timeout: 60_000});

it.live("CT-ISUB-11: a restart after the commit and before the wake finalizes the recorded submission exactly once", () => Effect.gen(function* () {
  const f = yield* startInterpretationFixture();
  const task = yield* dispatched(f);
  assert.equal((yield* f.submitFields(task, planFields(task))).value.status, "submitted");
  yield* f.restart();
  f.endRun(task, "completed");
  yield* f.runOnce();
  const finalized = yield* f.task();
  assert.equal(finalized.status, "inferred");
  yield* f.runOnce();
  const again = yield* f.task();
  const finalization = (value: typeof finalized) => ({id: value.id, status: value.status, objective: value.objective, reason: value.reason, attempt: value.attempt,
    evidence: value.interpretationEvidence, workflow: value.workflow, supervisorRunId: value.supervisorRunId});
  assert.deepEqual(finalization(again), finalization(finalized), "finalized once");
  assert.equal((yield* f.receipts()).length, 1);
  assert.equal(f.interpretationDispatches().length, 1);
  assert.equal(f.operativeSends().length, 1);
}), {timeout: 60_000});

it.live("CT-ISUB-14: each phase of an interpretation is logged in order with its time, by name and service-minted attempt only", () => Effect.gen(function* () {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {lines.push(values.map(String).join(" "));});
  yield* Effect.addFinalizer(() => Effect.sync(() => {spy.mockRestore();}));
  const f = yield* startInterpretationFixture();
  const task = yield* dispatched(f);
  assert.equal((yield* f.submitFields(task, planFields(task))).value.status, "submitted");
  f.endRun(task, "completed");
  yield* f.runOnce();
  const phases = lines.flatMap(line => {
    try {
      const value = JSON.parse(line) as {event?: string; phase?: string; monotonicMs?: number; time?: string; attempt?: string};
      return value.event === "interpretation_phase" ? [value] : [];
    } catch {return [];}
  });
  const names = phases.map(value => value.phase);
  const expected = ["dispatch_admitted", "submission_received", "submission_decoded", "proof_verified", "submission_committed", "run_terminal", "finalized"];
  assert.deepEqual(names.filter(name => expected.includes(name!)).filter((name, index, all) => all.indexOf(name) === index), expected);
  const times = phases.map(value => value.monotonicMs!);
  assert.deepEqual(times, [...times].sort((left, right) => left - right), "monotonic times in phase order");
  assert.ok(phases.every(value => typeof value.time === "string"));
  for (const value of phases) if (value.attempt !== undefined) assert.equal(value.attempt, task.attempt!.attemptId);
  // no phase line carries an argument value or the model-authored text
  assert.equal(lines.filter(line => line.includes("interpretation_phase")).some(line => line.includes("Implement the export")), false);
}), {timeout: 60_000});

it.live("CT-ISUB-15: the tool returns before its run completes and the wake finalizes it without a supervision cycle", () => Effect.gen(function* () {
  const f = yield* startInterpretationFixture();
  const task = yield* dispatched(f);
  const reply = yield* f.submitFields(task, planFields(task));
  assert.equal(reply.value.status, "submitted");
  const run = f.root().runs.find(value => value.userMessageId === task.messageId)!;
  assert.equal(run.status, "running", "the tool answered while its own run is still running");
  const introduced = f.nextCommand(command => command.type === "message.dispatch" && command.threadId === f.mainThreadId);
  const completedAt = performance.now();
  f.endRun(task, "completed");
  // no runonce: only the signalled scope's wake, rechecking every 250 ms, sees the completion and finalizes it
  yield* introduced.pipe(Effect.timeoutOrElse({duration: "5 seconds",
    orElse: () => Effect.die(new Error("the introduction after the wake's finalization did not settle within 5000 ms"))}));
  assert.ok(performance.now() - completedAt < 5_000, "finalized without waiting for the 5 s cycle spacing");
  assert.equal((yield* f.task()).status, "inferred");
  assert.equal(f.operativeSends().length, 1);
}), {timeout: 60_000});
