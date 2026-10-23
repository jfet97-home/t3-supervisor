import assert from "node:assert/strict";
import { it, vi, type TestContext } from "vitest";
import { after } from "./support/node-test.js";
import { within } from "./support/c2-ps-fixture.js";
import { submissionArguments } from "./support/interpretation-submit.js";
import { planFields, startInterpretationFixture, type InterpretationFixture } from "./support/interpretation-fixture.js";

// the typed interpretation's finalization (plan 3.12 items 6, 7 and 9) over the production boundary: the real supervision cycle,
// the authenticated MCP route and write controller, the loopback native peer and the guidance file

const fixture = async (t: TestContext): Promise<InterpretationFixture> => {
  const f = await startInterpretationFixture();
  after(t, f.close);
  return f;
};

// one dispatched interpretation of a genuine request
const dispatched = async (f: InterpretationFixture, text = "Implement the CSV export in the reports page.") => {
  f.addRequest("request-1", text);
  await f.runOnce();
  const task = await f.task();
  assert.equal(task.status, "waiting");
  assert.ok(task.attempt, "the request carries its minted attempt");
  return task;
};

it("CT-ISUB-01: a valid submission in the exact request run is submitted, finalized once on run completion and introduced once to the bound main", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  const task = await dispatched(f);
  const request = f.interpretationDispatches();
  assert.equal(request.length, 1);
  const text = String(request[0]!.text);
  assert.ok(text.includes(task.attempt!.attemptId) && text.includes(JSON.stringify(task.attempt!.key.source)), "the request quotes its attempt and source pin");
  const reply = await f.submitFields(task, planFields(task));
  assert.deepEqual(reply, {httpStatus: 200, isError: false, value: {status: "submitted", attemptId: task.attempt!.attemptId, retry: "none"}});
  assert.equal((await f.task()).status, "waiting", "the submission records the result; it never finalizes before its run ends");
  f.endRun(task, "completed");
  await f.runOnce();
  const finalized = await f.task();
  assert.equal(finalized.status, "inferred");
  assert.equal(finalized.objective, "Implement the export");
  assert.equal(finalized.interpretationEvidence?.kind, "interpretation_submission");
  await f.runOnce();
  assert.equal((await f.task()).status, "inferred", "finalized once");
  assert.equal(f.interpretationDispatches().length, 1);
  assert.equal(f.operativeSends().length, 1, "one introduction to the bound main");
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-ISUB-09: a completed run without a recorded submission closes unavailable; well-formed or malformed final-chat JSON and prose are ignored", {timeout: 60_000}, async (t) => {
  for (const finalText of ["well-formed", "malformed", "prose"] as const) {
    const f = await fixture(t);
    const task = await dispatched(f);
    f.endRun(task, "completed", finalText === "well-formed" ? JSON.stringify(planFields(task))
      : finalText === "malformed" ? `${JSON.stringify(planFields(task)).slice(0, -1)}` : "The task is to implement the export; I would plan one step.");
    await f.runOnce();
    const closed = await f.task();
    assert.equal(closed.status, "unavailable", finalText);
    assert.equal(closed.reason, "The Supervisor did not submit a valid, source-linked interpretation.", finalText);
    assert.equal(closed.objective, null, finalText);
    assert.equal(closed.interpretationEvidence, undefined, finalText);
    await f.runOnce();
    assert.equal(f.operativeSends().length, 0, finalText);
    assert.equal(f.interpretationDispatches().length, 1, `${finalText}: nothing is resent`);
  }
});

it("CT-ISUB-10: a run that does not complete discards its submission, a rolled-back item or node discards it before apply, and another run's completion finalizes nothing", {timeout: 60_000}, async (t) => {
  for (const status of ["failed", "interrupted", "cancelled", "rolled_back"] as const) {
    const f = await fixture(t);
    const task = await dispatched(f);
    assert.equal((await f.submitFields(task, planFields(task))).value.status, "submitted", status);
    f.endRun(task, status);
    await f.runOnce();
    const closed = await f.task();
    assert.equal(closed.status, "unavailable", status);
    assert.equal(closed.reason, "The interpretation run did not complete successfully.", status);
    assert.equal(f.operativeSends().length, 0, status);
  }
  for (const rolledBack of ["item", "node"] as const) {
    const f = await fixture(t);
    const task = await dispatched(f);
    const args = submissionArguments(task, planFields(task));
    assert.equal((await f.submit(task, args, {itemId: "submission-rolled-back"})).value.status, "submitted", rolledBack);
    if (rolledBack === "item") f.setItemStatus("submission-rolled-back", "rolled_back");
    else f.setItemStatus("submission-rolled-back", "completed", "rolled_back");
    f.endRun(task, "completed");
    await f.runOnce();
    const closed = await f.task();
    assert.equal(closed.status, "unavailable", rolledBack);
    assert.equal(closed.reason, "The submitted interpretation's native tool call changed, was rolled back or could not be re-verified; it was not applied.", rolledBack);
    assert.equal(closed.objective, null, rolledBack);
    assert.equal(f.operativeSends().length, 0, `${rolledBack}: discarded before any application`);
  }
  {
    const f = await fixture(t);
    const task = await dispatched(f);
    assert.equal((await f.submitFields(task, planFields(task))).value.status, "submitted");
    // another completed run of the root (an unrelated turn) is not the request run
    const root = f.root();
    root.runs.push({id: "unrelated-root-run", threadId: root.thread.id, ordinal: root.runs.length + 1, status: "completed", requestedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), rootNodeId: "unrelated-root", userMessageId: "unrelated-message",
      providerThreadId: `${root.thread.id}-provider`});
    await f.runOnce();
    assert.equal((await f.task()).status, "waiting", "only the exact request run's completion finalizes");
  }
});

it("CT-ISUB-11: a restart after the commit and before the wake finalizes the recorded submission exactly once", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  const task = await dispatched(f);
  assert.equal((await f.submitFields(task, planFields(task))).value.status, "submitted");
  await f.restart();
  f.endRun(task, "completed");
  await f.runOnce();
  const finalized = await f.task();
  assert.equal(finalized.status, "inferred");
  await f.runOnce();
  const again = await f.task();
  const finalization = (value: typeof finalized) => ({id: value.id, status: value.status, objective: value.objective, reason: value.reason, attempt: value.attempt,
    evidence: value.interpretationEvidence, workflow: value.workflow, supervisorRunId: value.supervisorRunId});
  assert.deepEqual(finalization(again), finalization(finalized), "finalized once");
  assert.equal((await f.receipts()).length, 1);
  assert.equal(f.interpretationDispatches().length, 1);
  assert.equal(f.operativeSends().length, 1);
});

it("CT-ISUB-14: each phase of an interpretation is logged in order with its time, by name and service-minted attempt only", {timeout: 60_000}, async (t) => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {lines.push(values.map(String).join(" "));});
  after(t, () => spy.mockRestore());
  const f = await fixture(t);
  const task = await dispatched(f);
  assert.equal((await f.submitFields(task, planFields(task))).value.status, "submitted");
  f.endRun(task, "completed");
  await f.runOnce();
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
});

it("CT-ISUB-15: the tool returns before its run completes and the wake finalizes it without a supervision cycle", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  const task = await dispatched(f);
  const reply = await f.submitFields(task, planFields(task));
  assert.equal(reply.value.status, "submitted");
  const run = f.root().runs.find(value => value.userMessageId === task.messageId)!;
  assert.equal(run.status, "running", "the tool answered while its own run is still running");
  const introduced = f.nextCommand(command => command.type === "message.dispatch" && command.threadId === f.mainThreadId);
  const completedAt = performance.now();
  f.endRun(task, "completed");
  // no runOnce: only the signalled scope's wake, rechecking every 250 ms, sees the completion and finalizes it
  await within(introduced, 5_000, "the introduction after the wake's finalization");
  assert.ok(performance.now() - completedAt < 5_000, "finalized without waiting for the 5 s cycle spacing");
  assert.equal((await f.task()).status, "inferred");
  assert.equal(f.operativeSends().length, 1);
});
