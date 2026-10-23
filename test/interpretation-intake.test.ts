import assert from "node:assert/strict";
import { it, type TestContext } from "vitest";
import { after } from "./support/node-test.js";
import { fingerprint } from "../src/guidance-store.js";
import { interpretationAttemptId } from "../src/interpretation-submission.js";
import { prepareWorkflowRequest } from "../src/supervisor-workflow.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import { workflowRequestHash } from "../src/workflow-write-evidence.js";
import { rawMcpPost } from "./support/int-production-wiring.js";
import { submissionArguments } from "./support/interpretation-submit.js";
import { planFields, startInterpretationFixture, type InterpretationFixture } from "./support/interpretation-fixture.js";

// the typed interpretation intake (plan 3.12 items 1, 2, 4 and 5) over the production boundary: the authenticated /mcp/workflows
// route, the production-wired write controller and project supervisor, the loopback native peer and the guidance file

const fixture = async (t: TestContext): Promise<InterpretationFixture> => {
  const f = await startInterpretationFixture();
  after(t, f.close);
  return f;
};

const dispatched = async (f: InterpretationFixture, id = "request-1", text = "Implement the CSV export in the reports page."): Promise<TaskRecord> => {
  f.addRequest(id, text);
  await f.runOnce();
  const task = await f.task();
  assert.equal(task.status, "waiting");
  assert.ok(task.attempt);
  return task;
};

const submitted = (task: TaskRecord) => ({httpStatus: 200, isError: false, value: {status: "submitted", attemptId: task.attempt!.attemptId, retry: "none"}});
const duplicate = (task: TaskRecord) => ({httpStatus: 200, isError: false, value: {status: "duplicate", attemptId: task.attempt!.attemptId, retry: "none"}});

it("CT-INT-01: the interpretation tool sits behind the route's token, Host and Origin checks and its valid submission commits one attempt receipt over the real wire", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  const task = await dispatched(f);
  const args = submissionArguments(task, planFields(task));
  const before = f.peer.log.length;
  const missing = await fetch(`http://127.0.0.1:${f.endpoint.port}/mcp/workflows`, {method: "POST", signal: AbortSignal.timeout(20_000),
    headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "supervision_interpretation_submit", arguments: args}})});
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), {message: "A workflow MCP token is required."});
  const foreignHost = await rawMcpPost(f.endpoint.port, {Host: "evil.example:80", Authorization: `Bearer ${f.endpoint.token}`});
  assert.equal(foreignHost.status, 403);
  const foreignOrigin = await rawMcpPost(f.endpoint.port, {Origin: "http://evil.example", Authorization: `Bearer ${f.endpoint.token}`});
  assert.equal(foreignOrigin.status, 403);
  assert.equal(f.peer.log.length, before, "no native read before the gate");
  assert.equal((await f.receipts()).length, 0);

  const listed = await fetch(`http://127.0.0.1:${f.endpoint.port}/mcp/workflows`, {method: "POST", signal: AbortSignal.timeout(20_000),
    headers: {Authorization: `Bearer ${f.endpoint.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream"},
    body: JSON.stringify({jsonrpc: "2.0", id: 2, method: "tools/list"})});
  const tools = (await listed.json() as {result: {tools: Array<{name: string}>}}).result.tools.map(tool => tool.name);
  assert.ok(tools.includes("supervision_interpretation_submit"));

  assert.deepEqual(await f.submit(task, args), submitted(task));
  const receipts = await f.receipts();
  assert.equal(receipts.length, 1);
  const row = receipts[0]!;
  assert.deepEqual({operation: row.operation_id, namespace: row.operation_namespace, hash: row.request_hash, project: row.project_id, main: row.main_thread_id,
    root: row.supervisor_thread_id, generation: row.binding_generation},
  {operation: task.attempt!.attemptId, namespace: "interpretation", hash: workflowRequestHash(args), project: task.projectId, main: f.mainThreadId,
    root: f.binding.threadId, generation: f.binding.generation});
  const receipt = JSON.parse(String(row.result)) as {payload: {kind: string; objective: string}; proof: {itemId: string; runId: string; requestMessageId: string}};
  assert.equal(receipt.payload.kind, "interpretation");
  assert.equal(receipt.payload.objective, "Implement the export");
  assert.equal(receipt.proof.requestMessageId, task.messageId);
  assert.equal(receipt.proof.runId, f.root().runs.find(run => run.userMessageId === task.messageId)!.id);
  assert.equal((await f.task()).status, "waiting", "recording neither finalizes nor sends");
  assert.equal(f.operativeSends().length, 0);
  assert.deepEqual(f.peer.unexpected, []);
});

it("CT-ISUB-04: concurrent, replayed, conflicting and retried submissions of one attempt record one receipt; a failed commit rolls back", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  const task = await dispatched(f);
  const args = submissionArguments(task, planFields(task));
  // a failing statement in the commit: nothing is recorded, and an identical retry is meaningful
  await f.core.guidance.db.prepare(`CREATE TRIGGER refuse_interpretation_receipt BEFORE INSERT ON supervisor_workflow_write_receipts
    WHEN NEW.operation_namespace='interpretation' BEGIN SELECT RAISE(ABORT, 'refused'); END`).run();
  assert.deepEqual((await f.submit(task, args)).value, {status: "storage_failed", code: "storage_failed", retry: "identical"});
  assert.equal((await f.receipts()).length, 0);
  await f.core.guidance.db.prepare("DROP TRIGGER refuse_interpretation_receipt").run();
  // an identical in-run retry of the same arguments (a second native call) and two identical concurrent calls: one receipt
  const replies = await Promise.all([f.submit(task, args, {install: false}), f.submit(task, args)]);
  assert.deepEqual(replies.map(reply => reply.value.status).sort(), ["duplicate", "submitted"]);
  const receipts = await f.receipts();
  assert.equal(receipts.length, 1);
  const recorded = String(receipts[0]!.result);
  // an identical replay (a lost response, then the retry) answers the original receipt
  assert.deepEqual(await f.submit(task, args, {install: false}), duplicate(task));
  // another native item for the same attempt with identical content is the same recorded result
  assert.deepEqual(await f.submit(task, args), duplicate(task));
  // changed content under the same attempt conflicts, after its own native proof; nothing replaces the committed result
  const changed = submissionArguments(task, planFields(task, "Implement a different export"));
  assert.deepEqual((await f.submit(task, changed)).value, {status: "conflict", code: "attempt_already_recorded", retry: "none"});
  assert.equal((await f.receipts()).length, 1);
  assert.equal(String((await f.receipts())[0]!.result), recorded);
  // a replay after finalization answers the receipt without re-activation or a new send
  f.endRun(task, "completed");
  await f.runOnce();
  const finalized = await f.task();
  assert.equal(finalized.status, "inferred");
  const sends = f.commands.length;
  assert.deepEqual(await f.submit(task, args, {install: false}), duplicate(task));
  await f.runOnce();
  const again = await f.task();
  assert.deepEqual([again.status, again.objective, again.attempt, again.interpretationEvidence, again.workflow],
    [finalized.status, finalized.objective, finalized.attempt, finalized.interpretationEvidence, finalized.workflow], "no re-finalization");
  assert.equal(f.commands.length, sends, "a replay never sends");
  assert.equal(f.interpretationDispatches().length, 1);
});

it("CT-ISUB-04: a submission whose original tool item never completed, or whose proof is not yet visible, is never applied", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  const task = await dispatched(f);
  const args = submissionArguments(task, planFields(task));
  // the native item is not visible yet: pending proof, nothing reserved
  const pending = await f.submit(task, args, {install: false});
  assert.deepEqual(pending.value, {status: "pending_proof", code: "native_evidence_not_visible", retry: "identical"});
  assert.equal((await f.receipts()).length, 0);
  // the running item counts for intake
  const reply = await f.submit(task, args, {status: "running"});
  assert.equal(reply.value.status, "submitted");
  // the run completes while the tool item never completed: finalization re-verifies and discards it
  f.endRun(task, "completed");
  await f.runOnce();
  const closed = await f.task();
  assert.equal(closed.status, "unavailable");
  assert.match(closed.reason, /could not be re-verified|changed, was rolled back/u);
  assert.equal(closed.interpretationEvidence, undefined);
  assert.equal(f.operativeSends().length, 0);
});

it("CT-ISUB-06: a source edit, a new genuine request, a binding change and a control change between proof, commit and finalization record or apply nothing stale", {timeout: 60_000}, async (t) => {
  {
    // the source edited before the commit: the attempt's pinned source is no longer current
    const f = await fixture(t);
    const task = await dispatched(f);
    f.main().messages.find(message => message.id === task.sourceMessageId)!.text = "Actually, export PDF instead.";
    assert.deepEqual((await f.submitFields(task, planFields(task))).value, {status: "stale", code: "attempt_not_current", retry: "none"});
    assert.equal((await f.receipts()).length, 0);
  }
  {
    // the source edited after the commit and before finalization: the finalization closes the attempt unapplied
    const f = await fixture(t);
    const task = await dispatched(f);
    assert.equal((await f.submitFields(task, planFields(task))).value.status, "submitted");
    f.main().messages.find(message => message.id === task.sourceMessageId)!.text = "Actually, export PDF instead.";
    f.endRun(task, "completed");
    await f.runOnce();
    const closed = await f.task();
    assert.equal(closed.status, "unavailable");
    assert.equal(closed.reason, "The task source changed before the interpretation completed.");
    assert.equal(f.operativeSends().length, 0);
  }
  {
    // a new genuine request in the main after the commit does not replace the in-flight attempt, which finalizes on its own source
    const f = await fixture(t);
    const task = await dispatched(f);
    assert.equal((await f.submitFields(task, planFields(task))).value.status, "submitted");
    f.addRequest("request-2", "Also add a footer.");
    await f.runOnce();
    assert.equal((await f.task()).id, task.id);
    f.endRun(task, "completed");
    await f.runOnce();
    assert.equal((await f.task()).status, "inferred");
    assert.equal((await f.task()).sourceMessageId, task.sourceMessageId);
  }
  {
    // the binding generation changed before the commit: the asserted generation no longer verifies
    const f = await fixture(t);
    const task = await dispatched(f);
    await f.core.store.setBinding({...f.binding, generation: f.binding.generation + 1});
    assert.deepEqual((await f.submitFields(task, planFields(task))).value, {status: "denied", code: "binding_generation_mismatch", retry: "none"});
    assert.equal((await f.receipts()).length, 0);
  }
  {
    // the project disabled before the commit denies it; disabled after the commit, the finalization leaves the result unapplied
    const f = await fixture(t);
    const task = await dispatched(f);
    const disable = async (enabled: boolean) => await f.core.guidance.db.prepare("UPDATE meta SET value=? WHERE key=?")
      .run(JSON.stringify({generation: 2, enabled, manual: true}), `supervisor_control:${JSON.stringify(task.projectId)}`);
    await disable(false);
    assert.equal((await f.submitFields(task, planFields(task))).value.status, "denied");
    assert.equal((await f.receipts()).length, 0);
    await disable(true);
    assert.equal((await f.submitFields(task, planFields(task))).value.status, "submitted");
    await disable(false);
    f.endRun(task, "completed");
    await f.runOnce();
    assert.equal((await f.task()).status, "waiting", "a disabled scope leaves the recorded result unapplied");
    assert.equal(f.operativeSends().length, 0);
  }
});

it("CT-ISUB-19: a renewed request mints a new attempt; old and unknown attempts write nothing, a duplicate after apply answers the receipt and the current run's submission finalizes once", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  const first = await dispatched(f);
  const firstArgs = submissionArguments(first, planFields(first));
  assert.deepEqual(await f.submit(first, firstArgs), submitted(first));
  f.endRun(first, "completed");
  await f.runOnce();
  assert.equal((await f.task()).status, "inferred");
  assert.equal(f.operativeSends().length, 1);
  // a duplicate after apply answers the original receipt
  assert.deepEqual(await f.submit(first, firstArgs, {install: false}), duplicate(first));
  // the approved-definitions renewal of the unsent proposal, as the conversation writes it: same task ID, a new request message
  const inferred = await f.task();
  const renewed: TaskRecord = {...inferred, status: "queued", requestText: "", messageId: "supervisor-task-renewal:renewed", supervisorRunId: null,
    dispatchedAt: null, replayCount: 0, reason: "Approved project definitions are ready.", updatedAt: Date.now()};
  delete renewed.definitionContext;delete renewed.definitionReadAttempts;delete renewed.revalidationAttempts;delete renewed.definitionNoticeKey;
  await f.core.store.saveTask(renewed);
  await f.runOnce();
  const second = await f.task();
  assert.equal(second.id, first.id);
  assert.equal(second.status, "waiting");
  assert.ok(second.attempt && second.attempt.attemptId !== first.attempt!.attemptId, "the renewal minted a new attempt");
  assert.equal(second.attempt.key.requestMessageId, "supervisor-task-renewal:renewed");
  assert.equal(f.interpretationDispatches().length, 2);
  const receiptsBefore = await f.receipts();
  // a late submission from the old run quoting the old attempt with changed content conflicts; identical content is its receipt
  assert.equal((await f.submit(first, submissionArguments(first, planFields(first, "A late different plan")), {runId: f.root().runs[0]!.id})).value.status, "conflict");
  assert.deepEqual(await f.submit(first, firstArgs, {install: false}), duplicate(first));
  // a late call from the old run quoting the new attempt is not the new request's run
  assert.deepEqual((await f.submitFields(second, planFields(second), {runId: f.root().runs[0]!.id})).value,
    {status: "denied", code: "native_run_not_request_run", retry: "none"});
  // an attempt nothing records and that is not current is stale and writes nothing
  const unknown = {...second, attempt: {...second.attempt, attemptId: interpretationAttemptId("00000000-0000-4000-8000-000000000999")}};
  assert.deepEqual((await f.submitFields(unknown, planFields(second))).value, {status: "stale", code: "attempt_not_current", retry: "none"});
  assert.deepEqual(await f.receipts(), receiptsBefore);
  assert.equal((await f.task()).status, "waiting");
  // the current run's submission is recorded and finalizes once
  assert.deepEqual(await f.submitFields(second, planFields(second, "Implement the renewed export")), submitted(second));
  f.endRun(second, "completed");
  await f.runOnce();
  await f.runOnce();
  const final = await f.task();
  assert.equal(final.status, "inferred");
  assert.equal(final.objective, "Implement the renewed export");
  assert.equal(final.interpretationEvidence?.kind === "interpretation_submission" ? final.interpretationEvidence.attemptId : null, second.attempt.attemptId);
  assert.equal((await f.receipts()).length, 2);
  assert.equal(f.interpretationDispatches().length, 2, "no refused submission sends anything");
  assert.equal(fingerprint(final.requestText), fingerprint(""), "the finalized task keeps no request text");
});

it("CT-ISUB-01: a queued task prepared under the old prompt is prepared again with a typed attempt, and a stored legacy request text is never sent", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  f.addRequest("request-1", "Implement the CSV export in the reports page.");
  const source = f.main().runs.find(run => run.userMessageId === "request-1")!;
  const legacyText = "LEGACY: reply with exactly one JSON object.";
  const prepared = prepareWorkflowRequest(f.mainThreadId, "request-1", "Implement the CSV export in the reports page.", f.definitions.current);
  const legacy: TaskRecord = {id: "legacy-task", threadId: f.mainThreadId, projectId: f.binding.projectId, sourceRunId: source.id, sourceMessageId: "request-1",
    sourceOrdinal: source.ordinal, sourceHash: fingerprint("Implement the CSV export in the reports page."), status: "queued", objective: null,
    reason: "Waiting for the project Supervisor.", updatedAt: Date.now(), requestText: legacyText, supervisorThreadId: f.binding.threadId,
    messageId: "supervisor-objective:legacy-task", supervisorRunId: null, dispatchedAt: null, replayCount: 0,
    definitionContext: prepared.context, workflow: prepared.workflow, definitionSnapshot: f.definitions.current};
  await f.core.store.saveTask(legacy);
  await f.runOnce();
  const task = await f.task();
  assert.equal(task.id, legacy.id);
  assert.equal(task.status, "waiting");
  assert.ok(task.attempt, "the old-prompt preparation is replaced by a typed one");
  assert.notEqual(task.requestText, legacyText);
  assert.deepEqual(f.interpretationDispatches().map(command => String(command.text).includes(task.attempt!.attemptId)), [true]);
  assert.equal(f.commands.some(command => command.text === legacyText), false, "the legacy text is never sent");
  // an in-flight request without a typed attempt and without a native run is never replayed with its stored text
  const root = f.root();
  root.runs.length = 0;
  root.messages.length = 0;
  await f.core.store.saveTask({...legacy, status: "waiting", dispatchedAt: Date.now()});
  await f.runOnce();
  await f.runOnce();
  assert.equal(f.commands.some(command => command.text === legacyText), false);
  assert.equal(f.interpretationDispatches().length, 1);
});
