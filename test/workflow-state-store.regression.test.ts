import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {NodeServices} from "@effect/platform-node";
import {it} from "@effect/vitest";
import {Effect} from "effect";
import type {SqlClient} from "effect/sql";
import {TestClock} from "effect/testing";
import {defaultSupervisorModel, type ProjectSupervisorStoreShape} from "../src/project-supervisor-store.js";
import type {WorkflowOwner} from "../src/workflow-state-contract.js";
import {countingIds, guidanceStoresFixture} from "./support/guidance-store-services.js";

// the time and identity sources of the WorkflowStateStore service (s6d step 1); CT-WSS-01..04 and CT-WSC-01 live in
// test/workflow-state.characterization.test.ts

const live = <A, E, R>(body: Effect.Effect<A, E, R>) => body.pipe(Effect.provide(NodeServices.layer));
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const ownerFor = (supervisors: ProjectSupervisorStoreShape, mainThreadId: string) => Effect.gen(function* () {
  const reserved = yield* supervisors.reserve("project-a", mainThreadId, "Main conversation", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  yield* supervisors.setBinding(binding);
  return {projectId: "project-a", mainThreadId, supervisorThreadId: binding.threadId, bindingGeneration: binding.generation} satisfies WorkflowOwner;
});

const rawDocument = (sql: SqlClient.SqlClient, workflowId: string) =>
  Effect.map(sql`SELECT document FROM supervisor_workflow_state WHERE workflow_id=${workflowId}`, ([row]) => String(row?.document));

it.effect("CC-CLOCK-WALL and CC-IDS: workflow times default to Clock and workflow and evidence identities come from SupervisorIds", () => live(Effect.gen(function* () {
  const stores = yield* guidanceStoresFixture("workflow-state-clock-", {ids: countingIds});
  const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  yield* stores.sql`INSERT INTO meta VALUES(${`supervisor_control:${JSON.stringify("project-a")}`},${JSON.stringify({generation: 1, enabled: true, manual: true})})`;
  yield* TestClock.setTime(1_800_000_000_000);
  const owner = yield* ownerFor(stores.supervisors, "main-a");
  assert.equal(owner.supervisorThreadId, `supervisor-root:${id(1)}`);
  const created = yield* stores.workflows.ensureMain(owner, "clock-ensure", "Start a draft.");
  assert.deepEqual(created, {status: "created", operationId: "clock-ensure", workflowId: id(2), revision: 1,
    stateHash: sha256(yield* rawDocument(stores.sql, id(2))), formatVersion: 2});
  const document = (yield* stores.workflows.get("project-a", "main-a"))!;
  assert.deepEqual([document.createdAt, document.updatedAt, document.evidence[0]?.id, document.evidence[0]?.recordedAt],
    [1_800_000_000_000, 1_800_000_000_000, id(3), 1_800_000_000_000]);
  const [operation] = yield* stores.sql`SELECT created_at FROM supervisor_workflow_operations WHERE operation_id=${"clock-ensure"}`;
  assert.equal(operation?.created_at, 1_800_000_000_000);
})), {timeout: 10_000});
