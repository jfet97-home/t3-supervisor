import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { T3TransportError } from "../src/t3.js";
import type { Projection } from "../src/types.js";
import { teamRuntimeUnit, teamStoresFixture } from "./support/g3-team.js";

// A-R40-SQL-01: a lost helper conversation (native 404, archived or deleted) applies only to the exact member state and epoch
// the runtime observed. a readiness transition committed between that observation and the loss transaction is never
// overwritten: the member keeps its newer epoch and its waiting request stays open (production SQL stores and runtime; the
// pause sits after the runtime's own guard read, the competing ready is the store's real markReady)

type Observation = "404" | "archived" | "deleted";

const lostThread = (observation: Exclude<Observation, "404">): Projection => ({
  thread: {id: "helper", title: "Helper", projectId: "p", lineage: {parentThreadId: null, relationshipToParent: null},
    ...(observation === "archived" ? {archivedAt: "2026-10-23T00:00:00.000Z"} : {deletedAt: "2026-10-23T00:00:00.000Z"})},
  runs: [], messages: [],
}) as unknown as Projection;

// one helper registered at epoch 1 with its readiness request waiting; `race` lets a newer ready commit while the runtime's
// guard read of the member is held, after that read completed
const scenario = (observation: Observation, race: boolean) => Effect.gen(function* () {
  const f = yield* teamStoresFixture("team-member-loss-");
  const binding = yield* f.store.reserve("p", "main", "Main", defaultSupervisorModel, 0, 1);
  const member = yield* f.teamStore.registerMember(binding, {threadId: "helper", taskId: "task", bootstrapRunId: "boot", now: 1});
  const prepared = yield* f.requests.prepare({id: "team-ready:held", projectId: "p", supervisorThreadId: "helper", kind: "review", taskId: null,
    text: "ready", batch: null, completionMarker: "complete", teamMemberEpoch: member.epoch}, 2);
  yield* f.requests.saveRequest({...prepared, state: "waiting", sentAt: 2});
  const guardRead = yield* Deferred.make<void>();
  const proceed = yield* Deferred.make<void>();
  let armed = false;
  // the guard's member read is held through the store's own snapshot method (the runtime reads the same service instance)
  const teamStore = f.teamStore as {-readonly [K in keyof typeof f.teamStore]: (typeof f.teamStore)[K]};
  const original = teamStore.snapshot;
  yield* Effect.acquireRelease(Effect.sync(() => {
    teamStore.snapshot = (value: Parameters<typeof original>[0]) => Effect.gen(function* () {
      const read = yield* original(value);
      if (!armed || !race) return read;
      armed = false;
      yield* Deferred.succeed(guardRead, undefined);
      yield* Deferred.await(proceed);
      return read;
    });
  }), () => Effect.sync(() => { teamStore.snapshot = original; }));
  const runtime = yield* teamRuntimeUnit({stores: f, projection: () => Effect.suspend(() => {
    armed = true;
    return observation === "404" ? Effect.fail(new T3TransportError("not found", 404)) : Effect.succeed(lostThread(observation));
  })});
  const reconciling = yield* Effect.forkChild(runtime.reconcile(binding, []));
  if (race) {
    yield* Deferred.await(guardRead);
    const newer = yield* f.teamStore.markReady(binding, member.threadId, member.epoch, 3);
    assert.deepEqual([newer.state, newer.epoch], ["ready", 2], "the competing readiness commits at the newer epoch");
    yield* Deferred.succeed(proceed, undefined);
  }
  yield* Fiber.join(reconciling);
  const stored = (yield* original(binding)).members.find((value) => value.threadId === "helper");
  const request = (yield* f.requests.requests("p", "helper")).find((value) => value.id === "team-ready:held");
  return {member: [stored?.state, stored?.epoch], request: [request?.state, request?.error ?? null]};
});

for (const observation of ["404", "archived", "deleted"] as const) {
  it.live(`A-R40-SQL-01: a stale ${observation} observation never overwrites a member that became ready at a newer epoch, nor fails its waiting request`,
    () => Effect.gen(function* () {
      const outcome = yield* scenario(observation, true);
      assert.deepEqual(outcome.member, ["ready", 2], "the newer readiness epoch is kept");
      assert.deepEqual(outcome.request, ["waiting", null], "the waiting readiness request stays open");
    }), {timeout: 10_000});
}

it.live("A-R40-SQL-01 control: a native 404 of the unchanged member still marks it missing and fails its request", () => Effect.gen(function* () {
  const outcome = yield* scenario("404", false);
  assert.equal(outcome.member[0], "missing");
  assert.deepEqual(outcome.request, ["failed",
    "The helper conversation returned native 404; its check-in was closed and pending operational effects remain fenced."]);
}), {timeout: 10_000});
