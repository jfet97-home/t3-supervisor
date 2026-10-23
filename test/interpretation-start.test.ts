import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import { mcpCall } from "./support/glinint-wiring.js";
import { submissionArguments } from "./support/interpretation-submit.js";
import { planFields, startInterpretationFixture, type InterpretationFixture } from "./support/interpretation-fixture.js";

// a pending start's verdict inside the typed interpretation (plan 3.12 items 5 and 7; extends the project-supervisor start cases)
// over the production boundary: the main's own supervision_start call and the root's submission both go through the authenticated
// /mcp/workflows route, with their native items in the loopback peer's projections.
// it.live: every case crosses the real mcp listener and the peer's http and websocket sockets, and the real sqlite files

const startText = "Have Supervisor follow this task: add a CSV export.";

// a no project main whose genuine request asked for supervision through its own native supervision_start call, interpreted once
const pendingStart = Effect.gen(function* () {
  const f = yield* startInterpretationFixture({noProject: true});
  f.addRequest("request-start", startText);
  const main = f.main();
  const run = main.runs.find(value => value.userMessageId === "request-start")!;
  const args = {callerThreadId: f.mainThreadId, userMessageId: "request-start", operationId: "own-start"};
  const nodeId = "start-node";
  (main.nodes as Array<Record<string, unknown>>).push({id: nodeId, kind: "dynamic_tool", threadId: f.mainThreadId, runId: run.id, rootNodeId: run.rootNodeId,
    parentNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, status: "completed"});
  const item = {id: "start-item", type: "dynamic_tool", threadId: f.mainThreadId, runId: run.id, nodeId, providerThreadId: run.providerThreadId,
    parentItemId: null, ordinal: 1, status: "completed", toolName: workflowToolNames.start.direct[1], input: args};
  main.turnItems = [item];
  f.native.details.set(item.id, {...item, nativeItemRef: {driver: "codex", nativeId: "native-start-item", strength: "strong"}, toolNonExecutionKind: null});
  assert.equal(((yield* mcpCall(f.endpoint, "supervision_start", args)).value as {status: string}).status, "pending");
  assert.equal((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "pending");
  yield* f.runOnce();
  yield* f.runOnce();
  const task = yield* f.task();
  assert.equal(task.status, "waiting");
  const request = String(f.interpretationDispatches().at(-1)?.text);
  assert.match(request, /START AUTHORIZATION/u);
  assert.match(request, /startRequested/u);
  return {f, task};
});

const verdict = (task: TaskRecord, startRequested: boolean, objective: string | null = null) =>
  submissionArguments(task, {...planFields(task, objective ?? "unused"), objective, ...(objective === null ? {workflow: null} : {}), startRequested});

it.live("CT-ISUB-07: a positive verdict activates the Start only after its run completes; recording never activates it and grants no general effect", () => Effect.gen(function* () {
  const {f, task} = yield* pendingStart;
  assert.equal((yield* f.submit(task, verdict(task, true))).value.status, "submitted");
  assert.equal((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "pending", "recording never activates a Start");
  assert.equal(yield* f.core.scope.scopeEnabled(task.projectId, f.mainThreadId).pipe(Effect.orDie), false, "no widening to general effects before activation");
  f.endRun(task, "completed");
  yield* f.runOnce();
  assert.equal((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "active");
  assert.equal(yield* f.core.scope.scopeEnabled(task.projectId, f.mainThreadId).pipe(Effect.orDie), true);
  // a bare start without a task activates permission and contacts nobody
  assert.equal((yield* f.task()).status, "needs_context");
  assert.equal(f.operativeSends().length, 0);
}), {timeout: 60_000});

it.live("CT-ISUB-07: a negative verdict rejects the Start and a submission without the verdict is invalid", () => Effect.gen(function* () {
  {
    const {f, task} = yield* pendingStart;
    const missing = submissionArguments(task, {...planFields(task, "unused"), objective: null, workflow: null});
    const reply = yield* f.submit(task, missing);
    assert.equal(reply.value.status, "invalid");
    assert.deepEqual(reply.value.status === "invalid" ? reply.value.issues : [], [{code: "missing_key", path: "/startRequested"}]);
    assert.equal((yield* f.receipts()).length, 0);
    assert.equal((yield* f.submit(task, verdict(task, false))).value.status, "submitted", "a corrected submission in the same run");
    f.endRun(task, "completed");
    yield* f.runOnce();
    assert.equal((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "rejected");
    assert.equal((yield* f.task()).status, "not_supervised");
    assert.equal(yield* f.core.scope.scopeEnabled(task.projectId, f.mainThreadId).pipe(Effect.orDie), false);
    assert.equal(f.operativeSends().length, 0);
  }
}), {timeout: 60_000});

it.live("CT-ISUB-07: a mode change, a later Stop or a rolled-back tool item before activation prevents it", () => Effect.gen(function* () {
  for (const change of ["mode", "stop", "rolled_back"] as const) {
    const {f, task} = yield* pendingStart;
    const args = verdict(task, true);
    assert.equal((yield* f.submit(task, args, {itemId: "start-verdict"})).value.status, "submitted", change);
    if (change === "mode") {
      const control = yield* f.core.supervisor.noProjectControl().pipe(Effect.orDie);
      assert.equal((yield* f.core.supervisor.saveNoProjectControl({expectedGeneration: control.generation, mode: "off"}).pipe(Effect.orDie)).status, "saved");
    }
    if (change === "stop") yield* f.core.supervisor.setChatSupervision({projectId: task.projectId, mainThreadId: f.mainThreadId,
      policyGeneration: (yield* f.core.policy.get().pipe(Effect.orDie)).generation, enabled: false}).pipe(Effect.orDie);
    if (change === "rolled_back") f.setItemStatus("start-verdict", "rolled_back");
    f.endRun(task, "completed");
    yield* f.runOnce();
    assert.notEqual((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "active", change);
    assert.equal(yield* f.core.scope.scopeEnabled(task.projectId, f.mainThreadId).pipe(Effect.orDie), false, change);
    assert.equal(f.operativeSends().length, 0, change);
  }
}), {timeout: 60_000});

// the final proof read awaits getturnitem after its main snapshot. a genuine source edit inside that await is a later revision
const editSourceAtProof = (f: InterpretationFixture, task: TaskRecord) => {
  let changed = 0;
  f.native.beforeTurnItem = Effect.sync(() => {
    if (changed++) return;
    f.main().messages.find(message => message.id === task.sourceMessageId)!.text = "Hello, I do not request supervision.";
  });
  return () => changed;
};

it.live("SOL-R42-01: a genuine source edit during the final proof read does not activate a bare Start", () => Effect.gen(function* () {
  const {f, task} = yield* pendingStart;
  assert.equal((yield* f.submit(task, verdict(task, true))).value.status, "submitted");
  f.endRun(task, "completed");
  const changed = editSourceAtProof(f, task);
  yield* f.runOnce();
  assert.ok(changed() > 0, "mutation crossed actual getTurnItem boundary");
  const closed = yield* f.task();
  assert.notEqual((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "active", "edited source must be checked after final native proof read");
  assert.equal(closed.status, "unavailable");
  assert.equal(closed.reason, "The task source changed before the interpretation completed.");
  assert.equal(closed.interpretationEvidence, undefined);
  assert.equal((yield* f.receipts()).length, 1, "the recorded receipt stays; nothing is resent");
  assert.equal(f.interpretationDispatches().length, 1);
  assert.equal(f.operativeSends().length, 0);
}), {timeout: 60_000});

it.live("SOL-R42-01: a genuine source edit during the final proof read does not apply a negative Start", () => Effect.gen(function* () {
  const {f, task} = yield* pendingStart;
  assert.equal((yield* f.submit(task, verdict(task, false))).value.status, "submitted");
  f.endRun(task, "completed");
  const changed = editSourceAtProof(f, task);
  yield* f.runOnce();
  assert.ok(changed() > 0, "mutation crossed actual getTurnItem boundary");
  const closed = yield* f.task();
  assert.notEqual((yield* f.core.store.start(f.mainThreadId).pipe(Effect.orDie))?.status, "active");
  assert.equal(closed.status, "unavailable");
  assert.equal(closed.reason, "The task source changed before the interpretation completed.");
  assert.equal((yield* f.receipts()).length, 1);
  assert.equal(f.interpretationDispatches().length, 1);
  assert.equal(f.operativeSends().length, 0);
}), {timeout: 60_000});
