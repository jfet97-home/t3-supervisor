import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Effect, Stream } from "effect";
import { DashboardUpdates } from "../src/dashboard-updates.js";
import { defaultSupervisorModel } from "../src/project-supervisor-store.js";
import type { SupervisorTeamStoreShape, TeamBinding, TeamMember, TeamNotification } from "../src/supervisor-team-store.js";
import { dataDirectory, type SupervisionStores, withSupervisionStores } from "./support/g9-stores.js";

// the SupervisorTeamStore service over a temporary guidance.sqlite3 (its production client and the production store layers);
// a refusal is the service's typed failure with the same code. it.live: a time a case leaves out is the store's Clock, the
// wall clock as at baseline, and no case waits on time

const parents = new Map<string, string | null>([
  ["branch-a", "main"], ["branch-b", "main"], ["leaf-a", "branch-a"], ["leaf-deep", "leaf-a"], ["leaf-b", "branch-b"], ["foreign", "outside"],
  ["peer-a", "branch-a"],
]);

type Fixture = SupervisionStores & { readonly directory: string; readonly binding: TeamBinding };

// the stores of a fresh directory with the main root reserved, open while `use` runs
const fixture = <A, E, R>(use: (f: Fixture) => Effect.Effect<A, E, R>) => Effect.flatMap(dataDirectory("supervisor-team-store-"), (directory) =>
  withSupervisionStores(directory, (stores) => Effect.gen(function* () {
    const root = yield* stores.supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 0, 1);
    const binding: TeamBinding = { projectId: root.projectId, mainThreadId: root.mainThreadId, threadId: root.threadId, generation: root.generation };
    return yield* use({ ...stores, directory, binding });
  })));

// the failure of `effect`, an error validated as `assert.throws` validates a thrown error
const rejects = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: RegExp | ((error: unknown) => boolean), message?: string) =>
  Effect.map(Effect.flip(effect), (error) => {
    assert.ok(error instanceof Error, "the failure is an error");
    assert.throws(() => { throw error; }, expected, message);
  });

const member = (team: SupervisorTeamStoreShape, binding: TeamBinding, threadId: string, now: number): Effect.Effect<TeamMember, unknown> => Effect.gen(function* () {
  const registered = yield* team.registerMember(binding, {threadId, taskId: `task-${threadId}`, bootstrapRunId: `run-${threadId}`, now});
  return yield* team.markReady(binding, threadId, registered.epoch, now + 1);
});

const activate = (team: SupervisorTeamStoreShape, binding: TeamBinding, subtreeRootThreadId: string, memberThreadId: string, now: number) => Effect.gen(function* () {
  const assignment = yield* team.assign(binding, subtreeRootThreadId, memberThreadId, parents, now);
  for (const notification of (yield* team.snapshot(binding)).notifications.filter(value => value.assignmentRootThreadId === subtreeRootThreadId && value.assignmentEpoch === assignment.epoch)) {
    yield* team.updateNotificationDelivery(binding, binding.threadId, notification.id, "sending", now + 1);
    yield* team.updateNotificationDelivery(binding, binding.threadId, notification.id, "delivered", now + 2);
    yield* team.acknowledgeNotification(binding, notification.recipientThreadId, notification.id, notification.memberEpoch, now + 3);
  }
  return yield* team.completeTransfer(binding, subtreeRootThreadId, assignment.epoch, now + 4);
});

it.live("root owns main and unassigned work; helpers gain subtree authority only after readiness and acknowledged handover", () => fixture((f) => Effect.gen(function* () {
  assert.equal((yield* f.team.coverage(f.binding, "main", parents)).actorThreadId, f.binding.threadId);
  assert.equal((yield* f.team.coverage(f.binding, "leaf-a", parents)).state, "root");
  assert.equal((yield* f.team.coverage(f.binding, "foreign", parents)).state, "unavailable");
  assert.equal(yield* f.team.authorizeWrite(f.binding, f.binding.threadId, "main", parents), true);
  assert.equal(yield* f.team.authorizeWrite(f.binding, f.binding.threadId, "leaf-a", parents), true);
  assert.equal(yield* f.team.authorizeWrite(f.binding, f.binding.threadId, "foreign", parents), false);
  const registering = yield* f.team.registerMember(f.binding, {threadId: "helper-a", taskId: "task-a", bootstrapRunId: "run-a", now: 10});
  assert.equal(yield* f.team.resolveActor(f.binding, "helper-a", registering.epoch), null);
  assert.equal((yield* f.team.bindingForActor("helper-a", f.binding.generation))?.threadId, f.binding.threadId);
  const ready = yield* f.team.markReady(f.binding, "helper-a", registering.epoch, 11);
  const pending = yield* f.team.assign(f.binding, "branch-a", ready.threadId, parents, 12);
  assert.equal((yield* f.team.coverage(f.binding, "leaf-deep", parents)).state, "transferring");
  yield* rejects(f.team.completeTransfer(f.binding, "branch-a", pending.epoch, 13), /supervisor_team_handover_unacknowledged/u);
  assert.equal((yield* activate(f.team, f.binding, "branch-a", ready.threadId, 14)).state, "active");
  const coverage = yield* f.team.coverage(f.binding, "leaf-deep", parents);
  assert.equal(coverage.actorThreadId, "helper-a");
  assert.equal(coverage.state, "assigned");
  assert.equal(yield* f.team.authorizeWrite(f.binding, "helper-a", "leaf-deep", parents, {
    memberEpoch: ready.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: coverage.assignmentEpoch,
  }), true);
  assert.equal(yield* f.team.authorizeWrite(f.binding, "helper-a", "branch-b", parents, {
    memberEpoch: ready.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: coverage.assignmentEpoch,
  }), false);
})));

it.live("subtree overrides stay local and unrelated assignment changes do not stale work", () => fixture((f) => Effect.gen(function* () {
  const first = yield* member(f.team, f.binding, "helper-one", 1);
  const second = yield* member(f.team, f.binding, "helper-two", 10);
  yield* activate(f.team, f.binding, "branch-a", first.threadId, 20);
  yield* activate(f.team, f.binding, "branch-b", first.threadId, 30);
  const inherited = yield* f.team.coverage(f.binding, "leaf-deep", parents);
  const leafAssignment = yield* f.team.assign(f.binding, "leaf-a", second.threadId, parents, 40);
  const leafNotices = (yield* f.team.snapshot(f.binding)).notifications.filter(value => value.assignmentRootThreadId === "leaf-a" && value.assignmentEpoch === leafAssignment.epoch);
  assert.deepEqual(leafNotices.map(value => value.kind).sort(), ["handover_receive", "handover_release"]);
  for (const notification of leafNotices) {
    yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "sending", 41);
    yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "delivered", 42);
    yield* f.team.acknowledgeNotification(f.binding, notification.recipientThreadId, notification.id, notification.memberEpoch, 43);
  }
  yield* f.team.completeTransfer(f.binding, "leaf-a", leafAssignment.epoch, 44);
  const specific = yield* f.team.coverage(f.binding, "leaf-deep", parents);
  const otherBranch = yield* f.team.coverage(f.binding, "leaf-b", parents);
  assert.equal(specific.actorThreadId, second.threadId);
  assert.equal(specific.assignmentRootThreadId, "leaf-a");
  assert.equal(otherBranch.actorThreadId, first.threadId);
  assert.equal((yield* f.team.coverage(f.binding, "leaf-b", parents)).assignmentEpoch, inherited.assignmentEpoch);
  yield* rejects(f.team.assign(f.binding, "foreign", second.threadId, parents), /supervisor_team_assignment_out_of_scope/u);
})));

it.live("a more-specific handover notifies the inherited owner and drains only work inside that subtree", () => fixture((f) => Effect.gen(function* () {
  const first = yield* member(f.team, f.binding, "helper-inherited", 1);
  const second = yield* member(f.team, f.binding, "helper-override", 10);
  yield* activate(f.team, f.binding, "branch-a", first.threadId, 20);
  const inherited = yield* f.team.coverage(f.binding, "leaf-a", parents);
  const request = yield* f.team.recordRequest(f.binding, {requestId: "check-in-request", memberThreadId: first.threadId, memberEpoch: first.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: inherited.assignmentEpoch!}], parentById: parents, now: 30});
  assert.equal(yield* f.team.authorizeWrite(f.binding, first.threadId, "leaf-a", parents, {
    memberEpoch: first.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: inherited.assignmentEpoch,
  }), true, "the active helper can still write during its own recorded check-in");
  const transfer = yield* f.team.assign(f.binding, "leaf-a", second.threadId, parents, 31);
  assert.equal(transfer.fromMemberThreadId, first.threadId);
  assert.equal(transfer.fromAssignmentRootThreadId, "branch-a");
  assert.deepEqual(transfer.pendingRequestIds, [request.requestId]);
  assert.deepEqual(transfer.remainingAssignmentRoots, ["branch-a"]);
  assert.match((yield* f.team.snapshot(f.binding)).notifications.find(value => value.assignmentRootThreadId === "leaf-a" && value.kind === "handover_release")?.message ?? "", /except leaf-a/u);
  const notices = (yield* f.team.snapshot(f.binding)).notifications.filter(value => value.assignmentRootThreadId === "leaf-a" && value.assignmentEpoch === transfer.epoch);
  for (const notification of notices) {
    yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "sending", 32);
    yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "delivered", 33);
    yield* f.team.acknowledgeNotification(f.binding, notification.recipientThreadId, notification.id, notification.memberEpoch, 34);
  }
  yield* rejects(f.team.completeTransfer(f.binding, "leaf-a", transfer.epoch, 35), /supervisor_team_handover_pending_effects/u);
  yield* f.team.settleRequest(f.binding, request.requestId, 36);
  yield* f.team.completeTransfer(f.binding, "leaf-a", transfer.epoch, 37);
  assert.equal((yield* f.team.coverage(f.binding, "peer-a", parents)).actorThreadId, first.threadId);
  assert.equal((yield* f.team.coverage(f.binding, "leaf-deep", parents)).actorThreadId, second.threadId);
})));

it.live("handover retains uncertain effects and rejects stale owner authority until they settle", () => fixture((f) => Effect.gen(function* () {
  const first = yield* member(f.team, f.binding, "helper-old", 1);
  const second = yield* member(f.team, f.binding, "helper-new", 10);
  yield* activate(f.team, f.binding, "branch-a", first.threadId, 20);
  const originalCoverage = yield* f.team.coverage(f.binding, "leaf-a", parents);
  const request = yield* f.team.recordRequest(f.binding, {requestId: "guide-1", memberThreadId: first.threadId, memberEpoch: first.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: originalCoverage.assignmentEpoch!}], parentById: parents, now: 30});
  assert.equal(request.state, "pending");
  yield* f.team.setRequestState(f.binding, first.threadId, request.requestId, first.epoch, "uncertain", 31);
  const transfer = yield* f.team.beginTransfer(f.binding, "branch-a", second.threadId, parents, 32);
  assert.equal((yield* f.team.coverage(f.binding, "leaf-a", parents)).state, "transferring");
  assert.equal(yield* f.team.authorizeWrite(f.binding, first.threadId, "leaf-a", parents, {
    memberEpoch: first.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: originalCoverage.assignmentEpoch,
  }), false);
  const handovers = (yield* f.team.snapshot(f.binding)).notifications.filter(value => value.assignmentRootThreadId === "branch-a" && value.assignmentEpoch === transfer.epoch);
  for (const notification of handovers) {
    yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "sending", 34);
    yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "delivered", 35);
    yield* f.team.acknowledgeNotification(f.binding, notification.recipientThreadId, notification.id, notification.memberEpoch, 36);
  }
  yield* rejects(f.team.completeTransfer(f.binding, "branch-a", transfer.epoch, 35), /supervisor_team_handover_pending_effects/u);
  yield* f.team.settleRequest(f.binding, request.requestId, 36);
  yield* f.team.completeTransfer(f.binding, "branch-a", transfer.epoch, 37);
  assert.equal(yield* f.team.authorizeWrite(f.binding, first.threadId, "leaf-a", parents, {
    memberEpoch: first.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: originalCoverage.assignmentEpoch,
  }), false);
  assert.equal(yield* f.team.authorizeWrite(f.binding, second.threadId, "leaf-a", parents, {
    memberEpoch: second.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: transfer.epoch,
  }), true);
})));

it.live("confirmed member loss releases coverage but fences targets with unresolved original effects", () => fixture((f) => Effect.gen(function* () {
  const helper = yield* member(f.team, f.binding, "helper-lost", 1);
  yield* activate(f.team, f.binding, "branch-a", helper.threadId, 10);
  const coverage = yield* f.team.coverage(f.binding, "leaf-a", parents);
  const request = yield* f.team.recordRequest(f.binding, {requestId: "uncertain-guide", memberThreadId: helper.threadId, memberEpoch: helper.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents, now: 20});
  yield* f.team.setRequestState(f.binding, helper.threadId, request.requestId, helper.epoch, "uncertain", 21);
  yield* f.team.markMissing(f.binding, helper.threadId, 22);
  assert.equal((yield* f.team.coverage(f.binding, "leaf-a", parents)).state, "unavailable");
  assert.equal(yield* f.team.authorizeWrite(f.binding, f.binding.threadId, "leaf-a", parents), false);
  assert.equal(yield* f.team.bindingForActor(helper.threadId, f.binding.generation), null);
  yield* f.team.settleRequest(f.binding, request.requestId, 23);
  assert.equal((yield* f.team.coverage(f.binding, "leaf-a", parents)).state, "root");
  const missing = (yield* f.team.snapshot(f.binding)).events.find(event => event.kind === "member_missing");
  assert.ok(missing);
  assert.equal(yield* f.team.hasBlockingWork(f.binding), true);
  yield* f.team.acknowledgeEvent(f.binding, f.binding.threadId, missing.id, 24);
})));

it.live("quarantine fences a present helper, preserves uncertain handovers and guide effects, then permits retirement", () => fixture((f) => Effect.gen(function* () {
  const first = yield* member(f.team, f.binding, "helper-quarantined", 1);
  const second = yield* member(f.team, f.binding, "helper-next", 10);
  yield* activate(f.team, f.binding, "branch-a", first.threadId, 20);
  const coverage = yield* f.team.coverage(f.binding, "leaf-a", parents);
  const request = yield* f.team.recordRequest(f.binding, {requestId: "guide-quarantined", memberThreadId: first.threadId, memberEpoch: first.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents, now: 30});
  yield* f.team.setRequestState(f.binding, first.threadId, request.requestId, first.epoch, "uncertain", 31);
  const transfer = yield* f.team.beginTransfer(f.binding, "branch-a", second.threadId, parents, 32);
  const handovers = (yield* f.team.snapshot(f.binding)).notifications.filter(value => value.assignmentRootThreadId === "branch-a" && value.assignmentEpoch === transfer.epoch);
  const release = handovers.find(value => value.kind === "handover_release");
  const receive = handovers.find(value => value.kind === "handover_receive");
  assert.ok(release && receive);
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, release.id, "sending", 33);
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, release.id, "uncertain", 34);

  const quarantined = yield* f.team.quarantineMember(f.binding, first.threadId, 35);
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.epoch, first.epoch + 1);
  assert.equal((yield* f.team.quarantineMember(f.binding, first.threadId, 36)).epoch, quarantined.epoch, "repeat quarantine is idempotent");
  assert.equal(yield* f.team.bindingForActor(first.threadId, f.binding.generation), null);
  assert.equal(yield* f.team.resolveActor(f.binding, first.threadId, first.epoch), null);
  yield* rejects(f.team.setRequestState(f.binding, first.threadId, request.requestId, first.epoch, "settled", 37), /supervisor_team_actor_stale/u);
  yield* rejects(f.team.acknowledgeNotification(f.binding, first.threadId, release.id, first.epoch, 37), /supervisor_team_actor_stale/u);
  assert.equal(yield* f.team.retryFailedNotifications(f.binding, first.threadId, 37), 0);
  assert.equal((yield* f.team.unresolvedRequests(f.binding)).find(value => value.requestId === request.requestId)?.state, "uncertain");
  assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === release.id)?.state, "uncertain");
  assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === receive.id)?.state, "superseded",
    "a never-sent receive notice is superseded, not acknowledged");
  const rootAssignment = (yield* f.team.snapshot(f.binding)).assignments.find(value => value.subtreeRootThreadId === "branch-a");
  assert.equal(rootAssignment?.memberThreadId, null);
  assert.equal(rootAssignment?.state, "active");
  assert.equal(rootAssignment?.epoch, transfer.epoch + 1);
  assert.equal(rootAssignment?.fromMemberThreadId, undefined);
  assert.equal((yield* f.team.coverage(f.binding, "leaf-a", parents)).state, "unavailable", "unknown guide effects remain fenced");
  assert.equal(yield* f.team.authorizeWrite(f.binding, f.binding.threadId, "leaf-a", parents), false);
  assert.equal((yield* f.team.retireMember(f.binding, first.threadId, 38)).state, "retired");
  assert.equal((yield* f.team.snapshot(f.binding)).events.some(event => event.kind === "member_quarantined" && event.severity === "attention"), true);

  yield* f.team.settleRequest(f.binding, request.requestId, 39);
  const nextTransfer = yield* f.team.assign(f.binding, "branch-a", second.threadId, parents, 40);
  assert.equal(nextTransfer.state, "transferring");
  yield* rejects(f.team.completeTransfer(f.binding, "branch-a", nextTransfer.epoch, 41), /supervisor_team_handover_unacknowledged/u,
    "a later assignment still requires its own receive acknowledgement");
  const nextReceive = (yield* f.team.snapshot(f.binding)).notifications.find(value => value.assignmentRootThreadId === "branch-a" &&
    value.assignmentEpoch === nextTransfer.epoch && value.kind === "handover_receive");
  assert.ok(nextReceive);
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, nextReceive.id, "sending", 42);
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, nextReceive.id, "delivered", 43);
  yield* f.team.acknowledgeNotification(f.binding, second.threadId, nextReceive.id, second.epoch, 44);
  yield* f.team.completeTransfer(f.binding, "branch-a", nextTransfer.epoch, 45);
  assert.equal((yield* f.team.coverage(f.binding, "leaf-a", parents)).actorThreadId, second.threadId);
})));

it.live("definite notification failure is latched and only explicit retry creates a fresh attempt", () => fixture((f) => Effect.gen(function* () {
  const helper = yield* member(f.team, f.binding, "helper-notification-retry", 1);
  const assignment = yield* f.team.assign(f.binding, "branch-a", helper.threadId, parents, 10);
  const receive = (yield* f.team.snapshot(f.binding)).notifications.find(value => value.assignmentRootThreadId === "branch-a" &&
    value.assignmentEpoch === assignment.epoch && value.kind === "handover_receive");
  assert.ok(receive);
  assert.equal(receive.deliveryAttempt, 0);
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, receive.id, "sending", 11);
  const failed = yield* f.team.markNotificationRejected(f.binding, f.binding.threadId, receive.id, "native_definite_rejection", 0, 12);
  assert.equal(failed.state, "failed");
  assert.equal(failed.deliveryAttempt, 0);
  assert.equal(failed.failureReason, "native_definite_rejection");
  yield* rejects(f.team.acknowledgeNotification(f.binding, helper.threadId, receive.id, helper.epoch, 13, 0),
    /supervisor_team_notification_not_delivered/u);

  const note = yield* f.team.note(f.binding, {eventId: "uncertain-note-event", notificationId: "uncertain-note", memberThreadId: helper.threadId,
    memberEpoch: helper.epoch, message: "Keep this uncertain notice unchanged.", now: 14});
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, note.id, "sending", 15);
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, note.id, "uncertain", 16);
  assert.equal(yield* f.team.retryFailedNotifications(f.binding, helper.threadId, 17), 1);
  const retried = (yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === receive.id);
  assert.equal(retried?.state, "pending");
  assert.equal(retried?.deliveryAttempt, 1);
  assert.equal(retried?.failureReason, undefined);
  const unchanged = (yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === note.id);
  assert.equal(unchanged?.state, "uncertain");
  assert.equal(unchanged?.deliveryAttempt, 0);
  yield* rejects(f.team.markNotificationRejected(f.binding, f.binding.threadId, receive.id, "stale_failure", 0, 18),
    /supervisor_team_notification_attempt_conflict/u);
  yield* rejects(f.team.updateNotificationDelivery(f.binding, f.binding.threadId, receive.id, "uncertain", 18, 0),
    /supervisor_team_notification_attempt_conflict/u);
  yield* rejects(f.team.acknowledgeNotification(f.binding, helper.threadId, receive.id, helper.epoch, 18, 0),
    /supervisor_team_notification_attempt_conflict/u);
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, receive.id, "sending", 19);
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, receive.id, "delivered", 20);
  yield* f.team.acknowledgeNotification(f.binding, helper.threadId, receive.id, helper.epoch, 21, 1);
  yield* f.team.completeTransfer(f.binding, "branch-a", assignment.epoch, 22);
  assert.equal((yield* f.team.coverage(f.binding, "leaf-a", parents)).actorThreadId, helper.threadId);
})));

it.live("helper limit uses project settings, permits zero, and retains idle reusable helpers", () => fixture((f) => Effect.gen(function* () {
  assert.equal((yield* f.team.settings(f.binding)).maxHelpersPerRoot, 5);
  assert.equal((yield* f.team.setMaxHelpersPerRoot(f.binding, 0, 1)).maxHelpersPerRoot, 1);
  const helper = yield* member(f.team, f.binding, "helper-reusable", 1);
  yield* activate(f.team, f.binding, "branch-a", helper.threadId, 10);
  const released = yield* f.team.release(f.binding, "branch-a", parents, 20);
  const notice = (yield* f.team.snapshot(f.binding)).notifications.find(value => value.assignmentRootThreadId === "branch-a" && value.assignmentEpoch === released.epoch);
  assert.ok(notice);
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notice.id, "sending", 21);
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notice.id, "delivered", 22);
  yield* f.team.acknowledgeNotification(f.binding, helper.threadId, notice.id, helper.epoch, 23);
  yield* f.team.completeTransfer(f.binding, "branch-a", released.epoch, 24);
  assert.equal((yield* f.team.snapshot(f.binding)).members.find(value => value.threadId === helper.threadId)?.state, "ready");
  assert.equal((yield* f.team.snapshot(f.binding)).assignments.find(value => value.subtreeRootThreadId === "branch-a")?.memberThreadId, null);
  yield* rejects(f.team.registerMember(f.binding, {threadId: "helper-extra", taskId: "task-extra", bootstrapRunId: "run-extra"}), /supervisor_team_helper_limit/u);
  assert.equal((yield* f.team.setMaxHelpersPerRoot(f.binding, 1, 0)).maxHelpersPerRoot, 0);
  assert.equal((yield* f.team.snapshot(f.binding)).members.length, 1);
  yield* rejects(f.team.setMaxHelpersPerRoot(f.binding, 2, 21), /supervisor_team_invalid_helper_limit/u);
})));

it.live("members, assignments, and uncertain handover notifications survive database reopen", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-team-reopen-");
  const {helper, transfer, notification} = yield* withSupervisionStores(directory, ({supervisors, team}) => Effect.gen(function* () {
    const root = yield* supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 0, 1);
    const binding: TeamBinding = {projectId: root.projectId, mainThreadId: root.mainThreadId, threadId: root.threadId, generation: root.generation};
    const helper = yield* member(team, binding, "persistent-helper", 10);
    const transfer = yield* team.assign(binding, "branch-a", helper.threadId, parents, 20);
    const notification = (yield* team.snapshot(binding)).notifications.find(value => value.assignmentEpoch === transfer.epoch);
    assert.ok(notification);
    yield* team.updateNotificationDelivery(binding, binding.threadId, notification.id, "sending", 21);
    return {helper, transfer, notification};
  }));
  // the first client closed; the stores reopen on the same file over a fresh ownership set
  yield* withSupervisionStores(directory, ({supervisors, team}) => Effect.gen(function* () {
    const reopened = yield* supervisors.binding("project", "main");
    assert.ok(reopened);
    const snapshot = yield* team.snapshot(reopened);
    assert.equal(snapshot.members.find(value => value.threadId === helper.threadId)?.state, "ready");
    assert.equal(snapshot.assignments.find(value => value.subtreeRootThreadId === "branch-a")?.state, "transferring");
    assert.equal(snapshot.notifications.find(value => value.id === notification.id)?.state, "uncertain");
    assert.equal(supervisors.ownedIds.has(helper.threadId), true);
    yield* rejects(team.completeTransfer(reopened, "branch-a", transfer.epoch), /supervisor_team_handover_unacknowledged/u);
  }));
}));

const attempt = (notice: TeamNotification) => ({notificationId: notice.id,
  deliveryAttempt: notice.deliveryAttempt, runId: notice.observedRun!.runId});
const reviewInput = (original: TeamNotification, operationId: string,
  chain = [original]) => ({operationId, notificationId: original.id, expectedDeliveryAttempt: original.deliveryAttempt,
  expectedRunId: original.observedRun!.runId, expectedChain: chain.map(attempt)});
const interruptNotice = (team: SupervisorTeamStoreShape, binding: TeamBinding, notice: TeamNotification) => Effect.gen(function* () {
  yield* team.updateNotificationDelivery(binding, binding.threadId, notice.id, "sending", 100, notice.deliveryAttempt);
  yield* team.updateNotificationDelivery(binding, binding.threadId, notice.id, "delivered", 101, notice.deliveryAttempt);
  return yield* team.recordNotificationRun(binding, binding.threadId, notice.id, notice.deliveryAttempt, {runId: `run:${notice.id}`, status: "interrupted"}, 102);
});

type Handover = Fixture & { readonly helper: TeamMember; readonly transfer: { readonly epoch: number }; readonly original: TeamNotification };

// a fixture whose helper's released handover notice was interrupted while a guide effect stays unresolved
const interruptedHandover = <A, E, R>(use: (f: Handover) => Effect.Effect<A, E, R>) => fixture((f) => Effect.gen(function* () {
  const helper = yield* member(f.team, f.binding, "review-helper", 1);
  yield* activate(f.team, f.binding, "branch-a", helper.threadId, 10);
  const coverage = yield* f.team.coverage(f.binding, "leaf-a", parents);
  yield* f.team.recordRequest(f.binding, {requestId: "guide:unresolved", memberThreadId: helper.threadId, memberEpoch: helper.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents, now: 20});
  const transfer = yield* f.team.release(f.binding, "branch-a", parents, 30);
  const original = yield* interruptNotice(f.team, f.binding, (yield* f.team.snapshot(f.binding)).notifications.find(value => value.assignmentEpoch === transfer.epoch)!);
  return yield* use({...f, helper, transfer, original});
}));

it.live("interrupted review chains close durably without acknowledging history or settling request effects", () => Effect.gen(function* () {
  const {directory, binding, original, transfer, first, second} = yield* interruptedHandover((f) => Effect.gen(function* () {
    const first = yield* interruptNotice(f.team, f.binding, yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "review-one"), 110));
    yield* rejects(f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "incomplete-chain")), /supervisor_team_review_chain_conflict/u);
    const input = {...reviewInput(f.original, "review-two", [f.original, first]), note: "Inspect native effects; do not assume they failed."};
    const second = yield* f.team.reviewHandover(f.binding, f.binding.threadId, input, 120);
    assert.deepEqual(second.reviewOf, attempt(f.original));
    assert.deepEqual(second.reviewChain, [f.original, first].map(attempt));
    assert.deepEqual(yield* f.team.reviewHandover(f.binding, f.binding.threadId, input, 121), second);
    return {directory: f.directory, binding: f.binding, original: f.original, transfer: f.transfer, first, second};
  }));
  // the first client closed; a restarted team store over a fresh project store and ownership set
  yield* withSupervisionStores(directory, ({team: restarted}) => Effect.gen(function* () {
    assert.deepEqual((yield* restarted.snapshot(binding)).notifications.find(value => value.id === second.id), second);
    yield* interruptNotice(restarted, binding, second);
    yield* restarted.acknowledgeNotificationRun(binding, binding.threadId, second.id, second.deliveryAttempt, `run:${second.id}`, 130, second.reviewChain);
    const snapshot = yield* restarted.snapshot(binding);
    for (const previous of [original, first]) {
      const closed = snapshot.notifications.find(value => value.id === previous.id)!;
      assert.deepEqual(closed, {...previous, updatedAt: 130,
        resolvedByReview: {reviewNotificationId: second.id, reviewRunId: `run:${second.id}`, resolvedAt: 130}});
      assert.equal(closed.state, "delivered");
    }
    assert.equal(snapshot.notifications.find(value => value.id === second.id)?.state, "acknowledged");
    for (const event of snapshot.events) yield* restarted.acknowledgeEvent(binding, binding.threadId, event.id, 131);
    assert.equal(yield* restarted.hasBlockingWork(binding), true);
    assert.equal((yield* restarted.unresolvedRequests(binding)).length, 1);
    yield* rejects(restarted.completeTransfer(binding, "branch-a", transfer.epoch), /supervisor_team_handover_pending_effects/u);
    yield* restarted.settleRequest(binding, "guide:unresolved", 132);
    yield* restarted.completeTransfer(binding, "branch-a", transfer.epoch, 133);
    for (const event of (yield* restarted.snapshot(binding)).events) yield* restarted.acknowledgeEvent(binding, binding.threadId, event.id, 134);
    assert.equal(yield* restarted.hasBlockingWork(binding), false, "closed notice history is no longer work");
  }));
}));

it.live("late original completion supersedes only pending reviews and sent reviews keep their own fence", () => Effect.gen(function* () {
  for (const state of ["pending", "sending", "uncertain", "delivered"] as const) yield* interruptedHandover((f) => Effect.gen(function* () {
    const review = yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "late-review"));
    if (state !== "pending") yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, review.id, "sending");
    if (state === "uncertain" || state === "delivered") yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, review.id, state);
    yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, f.original.id, 0, "late-native-completion");
    assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === review.id)?.state, state === "pending" ? "superseded" : state);
    yield* f.team.settleRequest(f.binding, "guide:unresolved");
    if (state !== "pending") {
      yield* rejects(f.team.completeTransfer(f.binding, "branch-a", f.transfer.epoch), /supervisor_team_handover_unacknowledged/u);
      if (state !== "delivered") yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, review.id, "delivered");
      yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, review.id, 0, "own-review-completion");
    }
    assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === f.original.id)?.resolvedByReview, undefined);
    yield* f.team.completeTransfer(f.binding, "branch-a", f.transfer.epoch);
  }));
}), { timeout: 60_000 });

it.live("epoch changes supersede pending reviews while sent reviews acknowledge only themselves", () => Effect.gen(function* () {
  for (const lifecycle of ["missing", "quarantine"] as const) for (const sent of [false, true]) yield* interruptedHandover((f) => Effect.gen(function* () {
    const review = yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "epoch-review"));
    if (sent) yield* interruptNotice(f.team, f.binding, review);
    if (lifecycle === "missing") yield* f.team.markMissing(f.binding, f.helper.threadId);
    else yield* f.team.quarantineMember(f.binding, f.helper.threadId);
    assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === review.id)?.state, sent ? "delivered" : "superseded");
    const next = yield* member(f.team, f.binding, "next-helper", 200);
    const reassigned = yield* f.team.assign(f.binding, "branch-a", next.threadId, parents, 201);
    assert.ok(reassigned.epoch > f.transfer.epoch);
    yield* rejects(f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "stale-review")), /supervisor_team_member_epoch_conflict/u);
    if (sent) {
      yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, review.id, 0, "review-completed-after-epoch");
      assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === review.id)?.state, "acknowledged");
      assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === f.original.id)?.resolvedByReview, undefined);
    }
    assert.equal((yield* f.team.unresolvedRequests(f.binding)).length, 1);
    for (const event of (yield* f.team.snapshot(f.binding)).events) yield* f.team.acknowledgeEvent(f.binding, f.binding.threadId, event.id);
    assert.equal(yield* f.team.hasBlockingWork(f.binding), true);
  }));
}), { timeout: 60_000 });

it.live("review CAS and operation identities reject forged helper acknowledgements and reflect no input", () => interruptedHandover((f) => Effect.gen(function* () {
  const input = {...reviewInput(f.original, "sentinel-operation"), note: "sentinel-note"};
  const before = yield* f.team.snapshot(f.binding);
  const denies = <A, E>(call: Effect.Effect<A, E>) => rejects(call, error => error instanceof Error &&
    /^supervisor_team_[a-z_]+$/u.test(error.message) && !error.message.includes("sentinel"));
  yield* denies(f.team.reviewHandover(f.binding, f.helper.threadId, input));
  yield* denies(f.team.reviewHandover(f.binding, f.binding.threadId, {...input, expectedRunId: "sentinel-run"}));
  yield* denies(f.team.reviewHandover(f.binding, f.binding.threadId, {...input, expectedDeliveryAttempt: 12}));
  yield* denies(f.team.reviewHandover(f.binding, f.binding.threadId, {...input, note: "sentinel".repeat(150)}));
  yield* denies(f.team.reviewHandover(f.binding, f.binding.threadId, {...input, note: "sentinel\u0000"}));
  yield* denies(f.team.acknowledgeNotification(f.binding, f.helper.threadId, f.original.id, f.helper.epoch));
  yield* denies(f.team.acknowledgeNotificationRun(f.binding, f.helper.threadId, f.original.id, 0, "sentinel-run"));
  assert.deepEqual(yield* f.team.snapshot(f.binding), before);
  const review = yield* f.team.reviewHandover(f.binding, f.binding.threadId, input);
  assert.deepEqual(yield* f.team.reviewHandover(f.binding, f.binding.threadId, input), review);
  yield* denies(f.team.reviewHandover(f.binding, f.binding.threadId, {...input, note: "sentinel-changed"}));
  yield* denies(f.team.reviewHandover(f.binding, f.binding.threadId, {...input, operationId: "sentinel-concurrent"}));
  yield* interruptNotice(f.team, f.binding, review);
  yield* denies(f.team.acknowledgeNotification(f.binding, f.helper.threadId, review.id, f.helper.epoch));
  yield* denies(f.team.acknowledgeNotificationRun(f.binding, f.helper.threadId, review.id, 0, "sentinel-forged"));
})));

it.live("failed reviews retry only their still-open exact chain", () => interruptedHandover((f) => Effect.gen(function* () {
  const review = yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "failed-review"));
  yield* f.team.markNotificationRejected(f.binding, f.binding.threadId, review.id, "Definite rejection", 0);
  assert.equal(yield* f.team.retryFailedNotifications(f.binding, f.helper.threadId), 1);
  const retry = (yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === review.id)!;
  assert.equal(retry.deliveryAttempt, 1);
  assert.deepEqual(retry.reviewChain, review.reviewChain);
  yield* f.team.markNotificationRejected(f.binding, f.binding.threadId, review.id, "Definite rejection", 1);
  yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, f.original.id, 0, "late-completed");
  assert.equal(yield* f.team.retryFailedNotifications(f.binding, f.helper.threadId), 0);
  const rejected = (yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === review.id)!;
  assert.deepEqual({state: rejected.state, deliveryAttempt: rejected.deliveryAttempt, failureReason: rejected.failureReason, reviewChain: rejected.reviewChain},
    {state: "superseded", deliveryAttempt: 1, failureReason: "Definite rejection", reviewChain: review.reviewChain}, "definite non-delivery is retired with its evidence");
  assert.equal(rejected.completedRunId, undefined);
  yield* rejects(f.team.completeTransfer(f.binding, "branch-a", f.transfer.epoch), /supervisor_team_handover_pending_effects/u);
  yield* f.team.settleRequest(f.binding, "guide:unresolved");
  assert.equal((yield* f.team.completeTransfer(f.binding, "branch-a", f.transfer.epoch)).state, "active");
})));

it.live("a rejected review never strands its chain, while an unknown review POST keeps its fence", () => Effect.gen(function* () {
  for (const state of ["failed", "uncertain"] as const) yield* interruptedHandover((f) => Effect.gen(function* () {
    const first = yield* interruptNotice(f.team, f.binding, yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "first-review")));
    const second = yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "second-review", [f.original, first]));
    yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, second.id, "sending");
    if (state === "failed") yield* f.team.markNotificationRejected(f.binding, f.binding.threadId, second.id, "Definite rejection", 0);
    else yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, second.id, "uncertain");
    yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, f.original.id, 0, "late-original-completion");
    assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === second.id)?.state, state === "failed" ? "superseded" : "uncertain");
    if (state === "uncertain") {
      yield* rejects(f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "third-review", [first])), /supervisor_team_review_in_progress/u);
      return;
    }
    const third = yield* interruptNotice(f.team, f.binding, yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "third-review", [first])));
    yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, third.id, 0, "third-review-completed", yield* Clock.currentTimeMillis, third.reviewChain);
    assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === first.id)?.resolvedByReview?.reviewNotificationId, third.id);
    yield* f.team.settleRequest(f.binding, "guide:unresolved");
    yield* f.team.completeTransfer(f.binding, "branch-a", f.transfer.epoch);
  }));
}), { timeout: 60_000 });

it.live("an unsent review retires when an exact attempt of its own chain closes, and only then", () => Effect.gen(function* () {
  for (const state of ["pending", "failed"] as const) yield* interruptedHandover((f) => Effect.gen(function* () {
    const first = yield* interruptNotice(f.team, f.binding, yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, `first-${state}`)));
    yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, f.original.id, 0, "late-original");
    const second = yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, `second-${state}`, [first]));
    if (state === "failed") yield* f.team.markNotificationRejected(f.binding, f.binding.threadId, second.id, "Definite rejection", 0);
    assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === second.id)?.state, state, "its chain [first] is still open");
    yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, first.id, 0, "late-first-review", yield* Clock.currentTimeMillis, first.reviewChain);
    assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === second.id)?.state, "superseded");
    yield* rejects(f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, `third-${state}`, [first])), /supervisor_team_review_chain_closed/u);
    yield* f.team.settleRequest(f.binding, "guide:unresolved");
    yield* f.team.completeTransfer(f.binding, "branch-a", f.transfer.epoch);
  }));
  yield* interruptedHandover((f) => Effect.gen(function* () {
    const first = yield* interruptNotice(f.team, f.binding, yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "closure-first")));
    const second = yield* interruptNotice(f.team, f.binding, yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "closure-second", [f.original, first])));
    yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, first.id, 0, "late-first", yield* Clock.currentTimeMillis, first.reviewChain);
    assert.ok((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === f.original.id)?.resolvedByReview);
    const third = yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "closure-third", [second]));
    yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, f.original.id, 0, "late-original-after-review");
    assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === third.id)?.state, "pending",
      "an already-closed original gaining its own acknowledgement leaves a successor over the unchanged open set");
  }));
}), { timeout: 60_000 });

it.live("a definite rejection arriving after its chain or transfer epoch closed is retired immediately", () => Effect.gen(function* () {
  yield* interruptedHandover((f) => Effect.gen(function* () {
    const review = yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "in-flight-reject"));
    yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, review.id, "sending");
    yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, f.original.id, 0, "late-original");
    assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === review.id)?.state, "sending", "a possibly posted review keeps its fence");
    const rejected = yield* f.team.markNotificationRejected(f.binding, f.binding.threadId, review.id, "Definite rejection after closure", 0);
    assert.deepEqual({state: rejected.state, failureReason: rejected.failureReason}, {state: "superseded", failureReason: "Definite rejection after closure"});
    yield* f.team.settleRequest(f.binding, "guide:unresolved");
    yield* f.team.completeTransfer(f.binding, "branch-a", f.transfer.epoch);
  }));

  yield* fixture((g) => Effect.gen(function* () {
    const from = yield* member(g.team, g.binding, "late-from", 1), to = yield* member(g.team, g.binding, "late-to", 2);
    yield* activate(g.team, g.binding, "branch-a", from.threadId, 10);
    const transfer = yield* g.team.assign(g.binding, "branch-a", to.threadId, parents, 20);
    const receive = (yield* g.team.snapshot(g.binding)).notifications.find(value => value.assignmentEpoch === transfer.epoch && value.kind === "handover_receive")!;
    yield* g.team.updateNotificationDelivery(g.binding, g.binding.threadId, receive.id, "sending");
    yield* g.team.markMissing(g.binding, from.threadId);
    assert.equal((yield* g.team.snapshot(g.binding)).notifications.find(value => value.id === receive.id)?.state, "sending");
    assert.equal((yield* g.team.markNotificationRejected(g.binding, g.binding.threadId, receive.id, "Late definite rejection", 0)).state, "superseded");
    for (const event of (yield* g.team.snapshot(g.binding)).events) yield* g.team.acknowledgeEvent(g.binding, g.binding.threadId, event.id);
    assert.equal(yield* g.team.hasBlockingWork(g.binding), false);
  }));
}));

it.live("review events identify no raw notification IDs", () => interruptedHandover((f) => Effect.gen(function* () {
  const review = yield* interruptNotice(f.team, f.binding, yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "event-text")));
  yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, review.id, 0, "event-text-run");
  const summaries = (yield* f.team.snapshot(f.binding)).events.filter(event => event.kind.startsWith("handover_review_")).map(event => event.summary);
  assert.equal(summaries.length, 2);
  for (const summary of summaries) for (const id of [f.original.id, review.id, "event-text-run"]) assert.equal(summary.includes(id), false);
})));

it.live("ending a transfer epoch retires definitely undelivered notices for a still-ready recipient", () => fixture((f) => Effect.gen(function* () {
  const from = yield* member(f.team, f.binding, "from-helper", 1);
  const to = yield* member(f.team, f.binding, "to-helper", 2);
  yield* activate(f.team, f.binding, "branch-a", from.threadId, 10);
  const transfer = yield* f.team.assign(f.binding, "branch-a", to.threadId, parents, 20);
  const receive = (yield* f.team.snapshot(f.binding)).notifications.find(value => value.assignmentEpoch === transfer.epoch && value.kind === "handover_receive")!;
  yield* f.team.updateNotificationDelivery(f.binding, f.binding.threadId, receive.id, "sending", 21);
  yield* f.team.markNotificationRejected(f.binding, f.binding.threadId, receive.id, "Definite rejection", 0, 22);
  yield* f.team.markMissing(f.binding, from.threadId, 30);
  const retired = (yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === receive.id)!;
  assert.deepEqual({state: retired.state, failureReason: retired.failureReason}, {state: "superseded", failureReason: "Definite rejection"});
  assert.equal((yield* f.team.resolveActor(f.binding, to.threadId, to.epoch))?.role, "helper");
  for (const event of (yield* f.team.snapshot(f.binding)).events) yield* f.team.acknowledgeEvent(f.binding, f.binding.threadId, event.id);
  assert.equal(yield* f.team.hasBlockingWork(f.binding), false);
})));

it.live("an interrupted sent review remains reviewable after the original late acknowledgement", () => interruptedHandover((f) => Effect.gen(function* () {
  const first = yield* interruptNotice(f.team, f.binding, yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "sent-before-original-completed")));
  yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, f.original.id, 0, "original-now-completed");
  const second = yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "review-only-unresolved-effects", [first]));
  assert.deepEqual(second.reviewChain, [attempt(first)]);
  yield* interruptNotice(f.team, f.binding, second);
  yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, second.id, 0, "second-review-completed", yield* Clock.currentTimeMillis, second.reviewChain);
  assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === first.id)?.resolvedByReview?.reviewNotificationId, second.id);
  assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === f.original.id)?.resolvedByReview, undefined);
})));

it.live("reassignment and release cannot reuse an old review even when its recipient is still ready", () => Effect.gen(function* () {
  for (const sent of [false, true]) yield* fixture((f) => Effect.gen(function* () {
    const first = yield* member(f.team, f.binding, "old-owner", 1);
    const second = yield* member(f.team, f.binding, "lost-recipient", 2);
    yield* activate(f.team, f.binding, "branch-a", first.threadId, 10);
    const transfer = yield* f.team.assign(f.binding, "branch-a", second.threadId, parents, 20);
    const original = yield* interruptNotice(f.team, f.binding, (yield* f.team.snapshot(f.binding)).notifications.find(value => value.assignmentEpoch === transfer.epoch && value.kind === "handover_release")!);
    const review = yield* f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(original, "old-epoch-review"));
    if (sent) yield* interruptNotice(f.team, f.binding, review);
    yield* f.team.markMissing(f.binding, second.threadId);
    assert.equal((yield* f.team.resolveActor(f.binding, first.threadId, first.epoch))?.role, "helper");
    assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === review.id)?.state, sent ? "delivered" : "superseded");
    yield* activate(f.team, f.binding, "branch-a", first.threadId, 200);
    yield* f.team.release(f.binding, "branch-a", parents, 210);
    yield* rejects(f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(original, "cannot-review-stale-assignment")), /supervisor_team_assignment_epoch_conflict/u);
    if (sent) {
      yield* f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, review.id, 0, "stale-review-completed");
      assert.equal((yield* f.team.snapshot(f.binding)).notifications.find(value => value.id === original.id)?.resolvedByReview, undefined);
    }
  }));
}));

it.live("acknowledging a team attention event publishes once while its idempotent replay stays quiet", () => {
  const hints: unknown[] = [];
  const updates = DashboardUpdates.of({publish: keys => Effect.sync(() => {hints.push(keys);}), stream: Stream.never});
  return fixture(f => Effect.gen(function* () {
    const event = yield* f.team.serviceAttention(f.binding, {eventId: "dashboard-attention", memberThreadId: f.binding.threadId, summary: "Fixture attention"}, 20);
    hints.length = 0;
    yield* f.team.acknowledgeEvent(f.binding, f.binding.threadId, event.id, 21);
    assert.equal(hints.length, 1);
    hints.length = 0;
    yield* f.team.acknowledgeEvent(f.binding, f.binding.threadId, event.id, 22);
    assert.equal(hints.length, 0);
  })).pipe(Effect.provideService(DashboardUpdates, updates));
});
