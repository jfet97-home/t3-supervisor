import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import type { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { GuidanceStore } from "../src/guidance-store.js";
import { defaultSupervisorModel, ProjectSupervisorStore } from "../src/project-supervisor-store.js";
import { SupervisorTeamStore, TeamStoreError, type SupervisorTeamStoreShape, type TeamBinding } from "../src/supervisor-team-store.js";
import { countingIds, guidanceStoresFixture, type StatementInterposer } from "./support/guidance-store-services.js";

// target regressions of the SupervisorTeamStore service (s6d step 1): CT-TSTORE-01 and CT-TSTORE-02 (manifest) and CT-TCTRL-03
// at service level (cc-owned, the d-21 fix), with its old-code control on the synchronous class

const parents = new Map<string, string | null>([["branch-a", "main"], ["branch-b", "main"], ["leaf-a", "branch-a"], ["leaf-b", "branch-b"]]);
const live = <A, E, R>(body: Effect.Effect<A, E, R>) => body.pipe(Effect.provide(NodeServices.layer));
const rows = (sql: SqlClient.SqlClient, statement: string) => Effect.map(sql.unsafe<Record<string, unknown>>(statement), (values) => values.map((row) => ({...row})));

// a test seam that holds the first matching statement of an armed phase inside its transaction until the test releases it
const statementGate = () => {
  let armed: string | null = null;
  let reached: Deferred.Deferred<void> | null = null;
  let proceed: Deferred.Deferred<void> | null = null;
  const interpose: StatementInterposer = (statement) => {
    if (armed === null || !statement.includes(armed) || reached === null || proceed === null) return undefined;
    armed = null;
    return Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(proceed));
  };
  const arm = (fragment: string) => Effect.gen(function* () {
    reached = yield* Deferred.make<void>();
    proceed = yield* Deferred.make<void>();
    armed = fragment;
    return {reached, proceed};
  });
  return {interpose, arm};
};

const teamFixture = (interpose?: StatementInterposer) => Effect.gen(function* () {
  const stores = yield* guidanceStoresFixture("team-service-regression-", interpose ? {interpose} : {});
  const root = yield* stores.supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 0, 1);
  const binding: TeamBinding = {projectId: root.projectId, mainThreadId: root.mainThreadId, threadId: root.threadId, generation: root.generation};
  return {...stores, binding};
});
const member = (team: SupervisorTeamStoreShape, binding: TeamBinding, threadId: string, now: number) => Effect.gen(function* () {
  const registered = yield* team.registerMember(binding, {threadId, taskId: `task-${threadId}`, bootstrapRunId: `run-${threadId}`, now});
  return yield* team.markReady(binding, threadId, registered.epoch, now + 1);
});
const activate = (team: SupervisorTeamStoreShape, binding: TeamBinding, subtreeRootThreadId: string, memberThreadId: string, now: number) => Effect.gen(function* () {
  const assignment = yield* team.assign(binding, subtreeRootThreadId, memberThreadId, parents, now);
  for (const notification of (yield* team.snapshot(binding)).notifications.filter((value) => value.assignmentRootThreadId === subtreeRootThreadId && value.assignmentEpoch === assignment.epoch)) {
    yield* team.updateNotificationDelivery(binding, binding.threadId, notification.id, "sending", now + 1);
    yield* team.updateNotificationDelivery(binding, binding.threadId, notification.id, "delivered", now + 2);
    yield* team.acknowledgeNotification(binding, notification.recipientThreadId, notification.id, notification.memberEpoch, now + 3);
  }
  return yield* team.completeTransfer(binding, subtreeRootThreadId, assignment.epoch, now + 4);
});

it.live("CT-TSTORE-01: a quarantine or reassignment committed after a caller's pre-check fails the request or assessment, and none can commit inside the mutation", () => live(Effect.gen(function* () {
  const gate = statementGate();
  const f = yield* teamFixture(gate.interpose);
  const helper = yield* member(f.team, f.binding, "helper-a", 1);
  const other = yield* member(f.team, f.binding, "helper-b", 5);
  yield* activate(f.team, f.binding, "branch-a", helper.threadId, 10);
  yield* activate(f.team, f.binding, "branch-b", other.threadId, 20);
  const coverageA = yield* f.team.coverage(f.binding, "leaf-a", parents);
  const coverageB = yield* f.team.coverage(f.binding, "leaf-b", parents);

  // a caller's own actor check passes, a quarantine commits from another fiber, then the request is refused in its transaction
  const checked = yield* Deferred.make<void>();
  const quarantined = yield* Deferred.make<void>();
  const requester = yield* Effect.forkChild(Effect.gen(function* () {
    assert.equal((yield* f.team.resolveActor(f.binding, helper.threadId, helper.epoch))?.role, "helper", "the caller's pre-check passes");
    yield* Deferred.succeed(checked, undefined);
    yield* Deferred.await(quarantined);
    return yield* Effect.flip(f.team.recordRequest(f.binding, {requestId: "stale-request", memberThreadId: helper.threadId, memberEpoch: helper.epoch,
      targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: coverageA.assignmentEpoch!}], parentById: parents, now: 40}));
  }));
  yield* Effect.forkChild(Effect.gen(function* () {
    yield* Deferred.await(checked);
    yield* f.team.quarantineMember(f.binding, helper.threadId, 30);
    yield* Deferred.succeed(quarantined, undefined);
  }));
  const refused = yield* Fiber.join(requester);
  assert.ok(refused instanceof TeamStoreError);
  assert.equal(refused.reason, "supervisor_team_actor_stale");
  assert.deepEqual(yield* rows(f.sql, "SELECT request_id FROM supervisor_team_requests"), [], "no request is recorded against the stale epoch");

  // the assessing helper's pre-check passes, its subtree moves into a handover, then the assessment is refused in its transaction
  assert.equal((yield* f.team.resolveActor(f.binding, other.threadId, other.epoch))?.role, "helper");
  yield* f.team.beginTransfer(f.binding, "branch-b", null, parents, 50);
  const staleAssessment = yield* Effect.flip(f.team.assessment(f.binding, {eventId: "stale-assessment", actorThreadId: other.threadId, memberEpoch: other.epoch,
    targets: [{targetThreadId: "leaf-b", assignmentRootThreadId: "branch-b", assignmentEpoch: coverageB.assignmentEpoch!}], parentById: parents, summary: "Looks done.", now: 60}));
  assert.ok(staleAssessment instanceof TeamStoreError);
  assert.equal(staleAssessment.reason, "supervisor_team_assessment_scope_stale");
  assert.deepEqual(yield* rows(f.sql, "SELECT id FROM supervisor_team_events WHERE id='stale-assessment'"), []);
  assert.equal((yield* f.team.snapshot(f.binding)).members.find((value) => value.threadId === other.threadId)?.lastAssessment, null);

  // held at its write, a request's checks and write form one critical section: a quarantine started meanwhile waits for the commit
  const third = yield* member(f.team, f.binding, "helper-c", 70);
  yield* activate(f.team, f.binding, "branch-a", third.threadId, 80);
  const coverageC = yield* f.team.coverage(f.binding, "leaf-a", parents);
  const held = yield* gate.arm("INSERT INTO supervisor_team_requests");
  const request = yield* Effect.forkChild(f.team.recordRequest(f.binding, {requestId: "held-request", memberThreadId: third.threadId, memberEpoch: third.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: coverageC.assignmentEpoch!}], parentById: parents, now: 90}));
  yield* Deferred.await(held.reached);
  const quarantine = yield* Effect.forkChild(f.team.quarantineMember(f.binding, third.threadId, 91), {startImmediately: true});
  assert.equal(quarantine.pollUnsafe(), undefined, "the quarantine cannot commit between the request's checks and its write");
  yield* Deferred.succeed(held.proceed, undefined);
  const recorded = yield* Fiber.join(request);
  const quarantinedMember = yield* Fiber.join(quarantine);
  assert.deepEqual({state: recorded.state, memberEpoch: recorded.memberEpoch}, {state: "pending", memberEpoch: third.epoch},
    "the request was checked and recorded at the epoch that was current when it committed");
  assert.equal(quarantinedMember.epoch, third.epoch + 1);
  assert.equal((yield* f.team.unresolvedRequests(f.binding)).find((value) => value.requestId === "held-request")?.memberEpoch, third.epoch,
    "the retained request keeps fencing the quarantined helper's subtree");
})), {timeout: 10_000});

it.live("CT-TSTORE-02: concurrent service-attention events with one id write exactly one row; identical inputs return it and a different summary conflicts", () => live(Effect.gen(function* () {
  const f = yield* teamFixture();
  const input = {eventId: "attention-1", memberThreadId: "helper-x", summary: "The helper needs attention."};
  const [left, right] = yield* Effect.all([f.team.serviceAttention(f.binding, input, 10), f.team.serviceAttention(f.binding, input, 11)], {concurrency: "unbounded"});
  assert.deepEqual(left, right, "an identical replay returns the stored event");
  assert.deepEqual(yield* rows(f.sql, "SELECT id FROM supervisor_team_events WHERE id='attention-1'"), [{id: "attention-1"}]);

  const results = yield* Effect.all([
    f.team.serviceAttention(f.binding, {...input, eventId: "attention-2", summary: "First summary."}, 20),
    f.team.serviceAttention(f.binding, {...input, eventId: "attention-2", summary: "Second summary."}, 21),
  ], {concurrency: "unbounded", mode: "result"});
  const stored = results.flatMap((result) => result._tag === "Success" ? [result.success] : []);
  const refused = results.flatMap((result) => result._tag === "Failure" ? [result.failure] : []);
  assert.equal(stored.length, 1, "exactly one of the two different events is stored");
  assert.deepEqual(refused.map((error) => error instanceof TeamStoreError ? error.reason : error), ["supervisor_team_event_identity_conflict"]);
  const events = yield* rows(f.sql, "SELECT document FROM supervisor_team_events WHERE id='attention-2'");
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(String(events[0]!.document)).summary, stored[0]!.summary, "the stored row is the admitted event, not a silently ignored one");
})), {timeout: 10_000});

it.live("CT-TCTRL-03: a helper registered inside a caller's transaction that then fails leaves no member, owned-thread or event row and no owned id", () => live(Effect.gen(function* () {
  const f = yield* teamFixture();
  // the caller's step after the team mutation (the controller's receipt write) fails inside the same transaction
  yield* f.sql.unsafe("CREATE TEMP TABLE receipt_probe(id TEXT PRIMARY KEY)");
  yield* f.sql.unsafe("CREATE TEMP TRIGGER receipt_probe_fails BEFORE INSERT ON receipt_probe BEGIN SELECT RAISE(ABORT, 'receipt_write_failed'); END");
  const failed = yield* Effect.exit(f.sql.withTransaction(Effect.gen(function* () {
    yield* f.team.registerMember(f.binding, {threadId: "helper-phantom", taskId: "task-phantom", bootstrapRunId: "run-phantom", now: 10});
    yield* f.sql`INSERT INTO receipt_probe VALUES(${"helper-phantom"})`;
  })));
  assert.ok(Exit.isFailure(failed), "the caller's transaction failed");
  assert.deepEqual(yield* rows(f.sql, "SELECT member_thread_id FROM supervisor_team_members"), [], "the member row rolled back");
  assert.deepEqual(yield* rows(f.sql, "SELECT id FROM supervisor_owned_threads WHERE id='helper-phantom'"), [], "the owned-thread row rolled back");
  assert.deepEqual(yield* rows(f.sql, "SELECT id FROM supervisor_team_events"), [], "the registration event rolled back");
  assert.equal(f.supervisors.ownedIds.has("helper-phantom"), false, "ownedIds holds no phantom helper (d-21)");
  assert.equal(f.owned.has("helper-phantom"), false, "the root's shared ownership set holds no phantom helper");

  // inside a committing caller transaction the helper joins ownedIds only once the outermost transaction commits
  let insideCommit: boolean | null = null;
  yield* f.sql.withTransaction(Effect.gen(function* () {
    yield* f.team.registerMember(f.binding, {threadId: "helper-committed", taskId: "task-committed", bootstrapRunId: "run-committed", now: 20});
    insideCommit = f.supervisors.ownedIds.has("helper-committed");
  }));
  assert.equal(insideCommit, false);
  assert.equal(f.supervisors.ownedIds.has("helper-committed"), true);
  assert.deepEqual(yield* rows(f.sql, "SELECT id FROM supervisor_owned_threads WHERE id='helper-committed'"), [{id: "helper-committed"}]);

  // on its own the registration is its own transaction and the id joins after that commit
  yield* f.team.registerMember(f.binding, {threadId: "helper-alone", taskId: "task-alone", bootstrapRunId: "run-alone", now: 30});
  assert.equal(f.supervisors.ownedIds.has("helper-alone"), true);
})), {timeout: 10_000});

it("CT-TCTRL-03 old-code control: the synchronous registerMember inside a rolled-back transaction leaves the helper in ownedIds (d-21)", {timeout: 10_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-sync-control-"));
  const guidance = new GuidanceStore(directory);
  try {
    const owned = new Set<string>();
    const supervisors = new ProjectSupervisorStore(guidance, owned);
    const root = supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 0, 1);
    const team = new SupervisorTeamStore(supervisors);
    const binding: TeamBinding = {projectId: root.projectId, mainThreadId: root.mainThreadId, threadId: root.threadId, generation: root.generation};
    assert.throws(() => guidance.transaction(() => {
      team.registerMember(binding, {threadId: "helper-phantom", taskId: "task-phantom", bootstrapRunId: "run-phantom", now: 10});
      throw new Error("receipt_write_failed");
    }), /receipt_write_failed/u);
    assert.equal(guidance.db.prepare("SELECT count(*) AS n FROM supervisor_team_members").get()?.n, 0, "the rows roll back");
    assert.equal(guidance.db.prepare("SELECT count(*) AS n FROM supervisor_owned_threads WHERE id='helper-phantom'").get()?.n, 0);
    // the target assertion of CT-TCTRL-03 (no phantom owned id) fails on the synchronous class
    assert.equal(owned.has("helper-phantom"), true, "the synchronous class keeps the rolled-back helper in ownedIds");
  } finally {
    guidance.close();
    await rm(directory, {recursive: true, force: true});
  }
});

it.effect("CC-CLOCK-WALL and CC-IDS: team times default to Clock and assignment, notice and event identities come from SupervisorIds", () => live(Effect.gen(function* () {
  const f = yield* guidanceStoresFixture("team-service-clock-", {ids: countingIds});
  const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  yield* TestClock.setTime(1_800_000_000_000);
  const root = yield* f.supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 0, 1);
  assert.equal(root.threadId, `supervisor-root:${id(1)}`);
  const binding: TeamBinding = {projectId: root.projectId, mainThreadId: root.mainThreadId, threadId: root.threadId, generation: root.generation};
  const registered = yield* f.team.registerMember(binding, {threadId: "helper-a", taskId: "task-a", bootstrapRunId: "run-a"});
  assert.deepEqual([registered.registeredAt, registered.updatedAt], [1_800_000_000_000, 1_800_000_000_000]);
  yield* TestClock.adjust("5 seconds");
  const ready = yield* f.team.markReady(binding, "helper-a", registered.epoch);
  assert.equal(ready.updatedAt, 1_800_000_005_000);
  const assignment = yield* f.team.assign(binding, "branch-a", "helper-a", parents);
  assert.deepEqual([assignment.id, assignment.createdAt], [id(4), 1_800_000_005_000]);
  const snapshot = yield* f.team.snapshot(binding);
  assert.deepEqual(snapshot.notifications.map((value) => [value.kind, value.id, value.createdAt]), [["handover_receive", id(5), 1_800_000_005_000]]);
  assert.deepEqual(snapshot.events.map((value) => [value.kind, value.id]), [["member_registered", id(2)], ["member_ready", id(3)], ["assignment_handover_started", id(6)]]);
})), {timeout: 10_000});
