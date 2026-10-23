import assert from "node:assert/strict";
import { Effect } from "effect";
import { it, type TestContext } from "vitest";
import { after } from "./support/node-test.js";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import { callTool } from "./support/int-production-wiring.js";
import { submissionArguments } from "./support/interpretation-submit.js";
import { planFields, startInterpretationFixture, type InterpretationFixture } from "./support/interpretation-fixture.js";

// a pending Start's verdict inside the typed interpretation (plan 3.12 items 5 and 7; extends the project-supervisor Start cases)
// over the production boundary: the main's own supervision_start call and the root's submission both go through the authenticated
// /mcp/workflows route, with their native items in the loopback peer's projections

const startText = "Have Supervisor follow this task: add a CSV export.";

// a No Project main whose genuine request asked for supervision through its own native supervision_start call, interpreted once
const pendingStart = async (t: TestContext): Promise<{f: InterpretationFixture; task: TaskRecord}> => {
  const f = await startInterpretationFixture({noProject: true});
  after(t, f.close);
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
  assert.equal(((await callTool(f.endpoint, "supervision_start", args)).value as {status: string}).status, "pending");
  assert.equal((await f.core.store.start(f.mainThreadId))?.status, "pending");
  await f.runOnce();
  await f.runOnce();
  const task = await f.task();
  assert.equal(task.status, "waiting");
  const request = String(f.interpretationDispatches().at(-1)?.text);
  assert.match(request, /START AUTHORIZATION/u);
  assert.match(request, /startRequested/u);
  return {f, task};
};

const verdict = (task: TaskRecord, startRequested: boolean, objective: string | null = null) =>
  submissionArguments(task, {...planFields(task, objective ?? "unused"), objective, ...(objective === null ? {workflow: null} : {}), startRequested});

it("CT-ISUB-07: a positive verdict activates the Start only after its run completes; recording never activates it and grants no general effect", {timeout: 60_000}, async (t) => {
  const {f, task} = await pendingStart(t);
  assert.equal((await f.submit(task, verdict(task, true))).value.status, "submitted");
  assert.equal((await f.core.store.start(f.mainThreadId))?.status, "pending", "recording never activates a Start");
  assert.equal(await f.core.supervision.scopeEnabled(task.projectId, f.mainThreadId), false, "no widening to general effects before activation");
  f.endRun(task, "completed");
  await f.runOnce();
  assert.equal((await f.core.store.start(f.mainThreadId))?.status, "active");
  assert.equal(await f.core.supervision.scopeEnabled(task.projectId, f.mainThreadId), true);
  // a bare Start without a task activates permission and contacts nobody
  assert.equal((await f.task()).status, "needs_context");
  assert.equal(f.operativeSends().length, 0);
});

it("CT-ISUB-07: a negative verdict rejects the Start and a submission without the verdict is invalid", {timeout: 60_000}, async (t) => {
  {
    const {f, task} = await pendingStart(t);
    const missing = submissionArguments(task, {...planFields(task, "unused"), objective: null, workflow: null});
    const reply = await f.submit(task, missing);
    assert.equal(reply.value.status, "invalid");
    assert.deepEqual(reply.value.status === "invalid" ? reply.value.issues : [], [{code: "missing_key", path: "/startRequested"}]);
    assert.equal((await f.receipts()).length, 0);
    assert.equal((await f.submit(task, verdict(task, false))).value.status, "submitted", "a corrected submission in the same run");
    f.endRun(task, "completed");
    await f.runOnce();
    assert.equal((await f.core.store.start(f.mainThreadId))?.status, "rejected");
    assert.equal((await f.task()).status, "not_supervised");
    assert.equal(await f.core.supervision.scopeEnabled(task.projectId, f.mainThreadId), false);
    assert.equal(f.operativeSends().length, 0);
  }
});

it("CT-ISUB-07: a mode change, a later Stop or a rolled-back tool item before activation prevents it", {timeout: 60_000}, async (t) => {
  for (const change of ["mode", "stop", "rolled_back"] as const) {
    const {f, task} = await pendingStart(t);
    const args = verdict(task, true);
    assert.equal((await f.submit(task, args, {itemId: "start-verdict"})).value.status, "submitted", change);
    if (change === "mode") {
      const control = await Effect.runPromise(f.core.supervision.noProjectControl());
      assert.equal((await f.core.supervision.saveNoProjectControl({expectedGeneration: control.generation, mode: "off"}, AbortSignal.timeout(5_000))).status, "saved");
    }
    if (change === "stop") await f.core.supervision.setChatSupervision({projectId: task.projectId, mainThreadId: f.mainThreadId,
      policyGeneration: (await f.core.policy.get()).generation, enabled: false}, AbortSignal.timeout(5_000));
    if (change === "rolled_back") f.setItemStatus("start-verdict", "rolled_back");
    f.endRun(task, "completed");
    await f.runOnce();
    assert.notEqual((await f.core.store.start(f.mainThreadId))?.status, "active", change);
    assert.equal(await f.core.supervision.scopeEnabled(task.projectId, f.mainThreadId), false, change);
    assert.equal(f.operativeSends().length, 0, change);
  }
});
