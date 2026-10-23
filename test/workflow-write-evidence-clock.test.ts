import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Context, Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import { GuidanceDb } from "../src/db.js";
import { defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService } from "../src/supervision-gate.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "../src/workflow-write-controller.js";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import { openGuidance, openSupervisors, openWorkflows, temporaryDirectory } from "./support/psx-stores.js";

// CT-WWC-07 (target regression): the 400 ms evidence budget runs on the Effect clock (monotonic time, 50 ms pauses) instead of
// performance.now and setTimeout, so its polls and its single 100 ms detail retry are counted exactly under the TestClock.
// Real sqlite files, so the opens use the live filesystem; the budget itself is the TestClock.

const thread = (id: string, projectId: string): ThreadInfo => ({id, title: id, projectId, archivedAt: null, deletedAt: null,
  lineage: {parentThreadId: null, relationshipToParent: null}});

it.effect("CT-WWC-07: with a 400 ms budget a pending write polls the projection every 50 ms nine times and retries one unavailable detail read once after 100 ms", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory("workflow-write-evidence-clock-");
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const guidance = yield* openGuidance(directory, scope);
  const stores = yield* openSupervisors(directory, guidance, scope);
  for (const id of [null, "project-workflows"]) yield* stores.sql`INSERT INTO meta VALUES(${`supervisor_control:${JSON.stringify(id)}`},${JSON.stringify({generation: 1, enabled: true, manual: true})}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
  const supervisors = stores.supervisors;
  const binding = {...(yield* supervisors.reserve("project-workflows", "main-workflows", "Main thread", defaultSupervisorModel, 1, 1)), state: "ready" as const};
  yield* supervisors.setBinding(binding);
  const workflows = yield* openWorkflows(stores, scope, (projectId) => supervisors.enabled(projectId));
  const args = {action: "ensure_main", supervisorThreadId: binding.threadId, bindingGeneration: binding.generation, operationId: "budget-op", note: "Wait for evidence."};
  const identity = {threadId: binding.threadId, runId: "supervisor-run", providerThreadId: "provider-thread"};
  // one snapshot candidate whose detail read always fails, so the write stays pending through the whole budget
  const projection: Projection = {thread: thread(binding.threadId, "project-workflows"), messages: [],
    runs: [{id: "supervisor-run", ordinal: 1, status: "completed", requestedAt: "2026-10-14T00:00:00.000Z", startedAt: "2026-10-14T00:00:00.000Z",
      completedAt: "2026-10-14T00:00:01.000Z", rootNodeId: "supervisor-root", threadId: binding.threadId, providerThreadId: "provider-thread"}],
    nodes: [{id: "supervisor-root", kind: "root_turn", ...identity, rootNodeId: "supervisor-root", parentNodeId: null, status: "completed"},
      {id: "tool-node", kind: "dynamic_tool", ...identity, rootNodeId: "supervisor-root", parentNodeId: "supervisor-root", status: "completed"}],
    turnItems: [{id: "tool-item", type: "dynamic_tool", ...identity, nodeId: "tool-node", parentItemId: null, ordinal: 100, status: "completed",
      toolName: workflowToolNames.write.direct[0], input: args}]};
  const polls: number[] = [];
  const details: number[] = [];
  const native = WorkflowNativeAccess.of({
    listThreads: () => Effect.succeed([thread("main-workflows", "project-workflows"), thread(binding.threadId, "project-workflows")]),
    projection: () => Effect.map(Clock.currentTimeMillis, (now) => {polls.push(now);return projection;}),
    getTurnItem: () => Effect.flatMap(Clock.currentTimeMillis, (now) => {details.push(now);return Effect.fail(new SupervisorRpcError("uncertain"));}),
  });
  const gate = yield* makeSupervisionGate({scopeEnabled: () => Effect.succeed(true), supervisionStopped: () => Effect.succeed(false),
    workflowEditingEnabled: () => Effect.succeed(true)}).pipe(Effect.provideService(GuidanceDb, stores.sql));
  const display = new SupervisionScope({dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0},
    {guidance: stores.guidance, supervisors, policy: stores.policy}, true);
  yield* display.rememberScratchProjects([]);
  const controller = yield* WorkflowWriteController.make({maxEvidenceWaitMs: 400, withoutTeam: true}).pipe(Effect.provideService(SupervisionGate, gate),
    Effect.provideService(WorkflowNativeAccess, native), Effect.provideService(SupervisionScopeService, display),
    Effect.provide(Context.add(stores.context, WorkflowStateStore, workflows)));

  const writing = yield* Effect.forkChild(controller.write(args));
  yield* Effect.yieldNow;
  assert.deepEqual([polls, details], [[0], [0]], "the first poll and its detail read happen at once");
  for (let step = 1; step <= 7; step++) {
    yield* TestClock.adjust("50 millis");
    assert.equal(polls.length, step + 1, `one poll after each 50 ms pause (step ${step})`);
  }
  assert.equal(writing.pollUnsafe(), undefined, "the write still waits before 400 ms");
  yield* TestClock.adjust("50 millis");
  assert.deepEqual(yield* Fiber.join(writing), {status: "pending", operationId: "budget-op", reason: "native_item_detail_unavailable", retryable: true});
  assert.deepEqual(polls, [0, 50, 100, 150, 200, 250, 300, 350, 400], "nine polls, the last at the 400 ms budget");
  assert.deepEqual(details, [0, 100], "the unavailable detail is read again once, 100 ms later");
  assert.equal(Number((yield* stores.sql<{n: number}>`SELECT count(*) AS n FROM supervisor_workflow_write_receipts`)[0]?.n), 0);
}), {timeout: 10_000});
