import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuidanceStore } from "../src/guidance-store.js";
import { defaultSupervisorModel, ProjectSupervisorStore } from "../src/project-supervisor-store.js";
import { SupervisorTeamStore, type TeamBinding, type TeamMember } from "../src/supervisor-team-store.js";

const parents = new Map<string, string | null>([
  ["branch-a", "main"], ["branch-b", "main"], ["leaf-a", "branch-a"], ["leaf-deep", "leaf-a"], ["leaf-b", "branch-b"], ["foreign", "outside"],
  ["peer-a", "branch-a"],
]);

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-team-store-"));
  const guidance = new GuidanceStore(directory);
  const supervisors = new ProjectSupervisorStore(guidance, new Set());
  const root = supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 0, 1);
  const team = new SupervisorTeamStore(supervisors);
  const binding: TeamBinding = { projectId: root.projectId, mainThreadId: root.mainThreadId, threadId: root.threadId, generation: root.generation };
  return { directory, guidance, supervisors, binding, team, cleanup: async () => {guidance.close();await rm(directory, {recursive: true, force: true});} };
};

const member = (team: SupervisorTeamStore, binding: TeamBinding, threadId: string, now: number): TeamMember => {
  const registered = team.registerMember(binding, {threadId, taskId: `task-${threadId}`, bootstrapRunId: `run-${threadId}`, now});
  return team.markReady(binding, threadId, registered.epoch, now + 1);
};

const activate = (team: SupervisorTeamStore, binding: TeamBinding, subtreeRootThreadId: string, memberThreadId: string, now: number) => {
  const assignment = team.assign(binding, subtreeRootThreadId, memberThreadId, parents, now);
  for (const notification of team.snapshot(binding).notifications.filter(value => value.assignmentRootThreadId === subtreeRootThreadId && value.assignmentEpoch === assignment.epoch)) {
    team.updateNotificationDelivery(binding, binding.threadId, notification.id, "sending", now + 1);
    team.updateNotificationDelivery(binding, binding.threadId, notification.id, "delivered", now + 2);
    team.acknowledgeNotification(binding, notification.recipientThreadId, notification.id, notification.memberEpoch, now + 3);
  }
  return team.completeTransfer(binding, subtreeRootThreadId, assignment.epoch, now + 4);
};

test("root owns main and unassigned work; helpers gain subtree authority only after readiness and acknowledged handover", async t => {
  const f = await fixture();t.after(f.cleanup);
  assert.equal(f.team.coverage(f.binding, "main", parents).actorThreadId, f.binding.threadId);
  assert.equal(f.team.coverage(f.binding, "leaf-a", parents).state, "root");
  assert.equal(f.team.coverage(f.binding, "foreign", parents).state, "unavailable");
  assert.equal(f.team.authorizeWrite(f.binding, f.binding.threadId, "main", parents), true);
  assert.equal(f.team.authorizeWrite(f.binding, f.binding.threadId, "leaf-a", parents), true);
  assert.equal(f.team.authorizeWrite(f.binding, f.binding.threadId, "foreign", parents), false);
  const registering = f.team.registerMember(f.binding, {threadId: "helper-a", taskId: "task-a", bootstrapRunId: "run-a", now: 10});
  assert.equal(f.team.resolveActor(f.binding, "helper-a", registering.epoch), null);
  assert.equal(f.team.bindingForActor("helper-a", f.binding.generation)?.threadId, f.binding.threadId);
  const ready = f.team.markReady(f.binding, "helper-a", registering.epoch, 11);
  const pending = f.team.assign(f.binding, "branch-a", ready.threadId, parents, 12);
  assert.equal(f.team.coverage(f.binding, "leaf-deep", parents).state, "transferring");
  assert.throws(() => f.team.completeTransfer(f.binding, "branch-a", pending.epoch, 13), /supervisor_team_handover_unacknowledged/u);
  assert.equal(activate(f.team, f.binding, "branch-a", ready.threadId, 14).state, "active");
  const coverage = f.team.coverage(f.binding, "leaf-deep", parents);
  assert.equal(coverage.actorThreadId, "helper-a");
  assert.equal(coverage.state, "assigned");
  assert.equal(f.team.authorizeWrite(f.binding, "helper-a", "leaf-deep", parents, {
    memberEpoch: ready.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: coverage.assignmentEpoch,
  }), true);
  assert.equal(f.team.authorizeWrite(f.binding, "helper-a", "branch-b", parents, {
    memberEpoch: ready.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: coverage.assignmentEpoch,
  }), false);
});

test("subtree overrides stay local and unrelated assignment changes do not stale work", async t => {
  const f = await fixture();t.after(f.cleanup);
  const first = member(f.team, f.binding, "helper-one", 1);
  const second = member(f.team, f.binding, "helper-two", 10);
  activate(f.team, f.binding, "branch-a", first.threadId, 20);
  activate(f.team, f.binding, "branch-b", first.threadId, 30);
  const inherited = f.team.coverage(f.binding, "leaf-deep", parents);
  const leafAssignment = f.team.assign(f.binding, "leaf-a", second.threadId, parents, 40);
  const leafNotices = f.team.snapshot(f.binding).notifications.filter(value => value.assignmentRootThreadId === "leaf-a" && value.assignmentEpoch === leafAssignment.epoch);
  assert.deepEqual(leafNotices.map(value => value.kind).sort(), ["handover_receive", "handover_release"]);
  for (const notification of leafNotices) {
    f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "sending", 41);
    f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "delivered", 42);
    f.team.acknowledgeNotification(f.binding, notification.recipientThreadId, notification.id, notification.memberEpoch, 43);
  }
  f.team.completeTransfer(f.binding, "leaf-a", leafAssignment.epoch, 44);
  const specific = f.team.coverage(f.binding, "leaf-deep", parents);
  const otherBranch = f.team.coverage(f.binding, "leaf-b", parents);
  assert.equal(specific.actorThreadId, second.threadId);
  assert.equal(specific.assignmentRootThreadId, "leaf-a");
  assert.equal(otherBranch.actorThreadId, first.threadId);
  assert.equal(f.team.coverage(f.binding, "leaf-b", parents).assignmentEpoch, inherited.assignmentEpoch);
  assert.throws(() => f.team.assign(f.binding, "foreign", second.threadId, parents), /supervisor_team_assignment_out_of_scope/u);
});

test("a more-specific handover notifies the inherited owner and drains only work inside that subtree", async t => {
  const f = await fixture();t.after(f.cleanup);
  const first = member(f.team, f.binding, "helper-inherited", 1);
  const second = member(f.team, f.binding, "helper-override", 10);
  activate(f.team, f.binding, "branch-a", first.threadId, 20);
  const inherited = f.team.coverage(f.binding, "leaf-a", parents);
  const request = f.team.recordRequest(f.binding, {requestId: "check-in-request", memberThreadId: first.threadId, memberEpoch: first.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: inherited.assignmentEpoch!}], parentById: parents, now: 30});
  assert.equal(f.team.authorizeWrite(f.binding, first.threadId, "leaf-a", parents, {
    memberEpoch: first.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: inherited.assignmentEpoch,
  }), true, "the active helper can still write during its own recorded check-in");
  const transfer = f.team.assign(f.binding, "leaf-a", second.threadId, parents, 31);
  assert.equal(transfer.fromMemberThreadId, first.threadId);
  assert.equal(transfer.fromAssignmentRootThreadId, "branch-a");
  assert.deepEqual(transfer.pendingRequestIds, [request.requestId]);
  assert.deepEqual(transfer.remainingAssignmentRoots, ["branch-a"]);
  assert.match(f.team.snapshot(f.binding).notifications.find(value => value.assignmentRootThreadId === "leaf-a" && value.kind === "handover_release")?.message ?? "", /except leaf-a/u);
  const notices = f.team.snapshot(f.binding).notifications.filter(value => value.assignmentRootThreadId === "leaf-a" && value.assignmentEpoch === transfer.epoch);
  for (const notification of notices) {
    f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "sending", 32);
    f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "delivered", 33);
    f.team.acknowledgeNotification(f.binding, notification.recipientThreadId, notification.id, notification.memberEpoch, 34);
  }
  assert.throws(() => f.team.completeTransfer(f.binding, "leaf-a", transfer.epoch, 35), /supervisor_team_handover_pending_effects/u);
  f.team.settleRequest(f.binding, request.requestId, 36);
  f.team.completeTransfer(f.binding, "leaf-a", transfer.epoch, 37);
  assert.equal(f.team.coverage(f.binding, "peer-a", parents).actorThreadId, first.threadId);
  assert.equal(f.team.coverage(f.binding, "leaf-deep", parents).actorThreadId, second.threadId);
});

test("handover retains uncertain effects and rejects stale owner authority until they settle", async t => {
  const f = await fixture();t.after(f.cleanup);
  const first = member(f.team, f.binding, "helper-old", 1);
  const second = member(f.team, f.binding, "helper-new", 10);
  activate(f.team, f.binding, "branch-a", first.threadId, 20);
  const originalCoverage = f.team.coverage(f.binding, "leaf-a", parents);
  const request = f.team.recordRequest(f.binding, {requestId: "guide-1", memberThreadId: first.threadId, memberEpoch: first.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: originalCoverage.assignmentEpoch!}], parentById: parents, now: 30});
  assert.equal(request.state, "pending");
  f.team.setRequestState(f.binding, first.threadId, request.requestId, first.epoch, "uncertain", 31);
  const transfer = f.team.beginTransfer(f.binding, "branch-a", second.threadId, parents, 32);
  assert.equal(f.team.coverage(f.binding, "leaf-a", parents).state, "transferring");
  assert.equal(f.team.authorizeWrite(f.binding, first.threadId, "leaf-a", parents, {
    memberEpoch: first.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: originalCoverage.assignmentEpoch,
  }), false);
  const handovers = f.team.snapshot(f.binding).notifications.filter(value => value.assignmentRootThreadId === "branch-a" && value.assignmentEpoch === transfer.epoch);
  for (const notification of handovers) {
    f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "sending", 34);
    f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notification.id, "delivered", 35);
    f.team.acknowledgeNotification(f.binding, notification.recipientThreadId, notification.id, notification.memberEpoch, 36);
  }
  assert.throws(() => f.team.completeTransfer(f.binding, "branch-a", transfer.epoch, 35), /supervisor_team_handover_pending_effects/u);
  f.team.settleRequest(f.binding, request.requestId, 36);
  f.team.completeTransfer(f.binding, "branch-a", transfer.epoch, 37);
  assert.equal(f.team.authorizeWrite(f.binding, first.threadId, "leaf-a", parents, {
    memberEpoch: first.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: originalCoverage.assignmentEpoch,
  }), false);
  assert.equal(f.team.authorizeWrite(f.binding, second.threadId, "leaf-a", parents, {
    memberEpoch: second.epoch, assignmentRootThreadId: "branch-a", assignmentEpoch: transfer.epoch,
  }), true);
});

test("confirmed member loss releases coverage but fences targets with unresolved original effects", async t => {
  const f = await fixture();t.after(f.cleanup);
  const helper = member(f.team, f.binding, "helper-lost", 1);
  activate(f.team, f.binding, "branch-a", helper.threadId, 10);
  const coverage = f.team.coverage(f.binding, "leaf-a", parents);
  const request = f.team.recordRequest(f.binding, {requestId: "uncertain-guide", memberThreadId: helper.threadId, memberEpoch: helper.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents, now: 20});
  f.team.setRequestState(f.binding, helper.threadId, request.requestId, helper.epoch, "uncertain", 21);
  f.team.markMissing(f.binding, helper.threadId, 22);
  assert.equal(f.team.coverage(f.binding, "leaf-a", parents).state, "unavailable");
  assert.equal(f.team.authorizeWrite(f.binding, f.binding.threadId, "leaf-a", parents), false);
  assert.equal(f.team.bindingForActor(helper.threadId, f.binding.generation), null);
  f.team.settleRequest(f.binding, request.requestId, 23);
  assert.equal(f.team.coverage(f.binding, "leaf-a", parents).state, "root");
  const missing = f.team.snapshot(f.binding).events.find(event => event.kind === "member_missing");
  assert.ok(missing);
  assert.equal(f.team.hasBlockingWork(f.binding), true);
  f.team.acknowledgeEvent(f.binding, f.binding.threadId, missing.id, 24);
});

test("quarantine fences a present helper, preserves uncertain handovers and guide effects, then permits retirement", async t => {
  const f = await fixture();t.after(f.cleanup);
  const first = member(f.team, f.binding, "helper-quarantined", 1);
  const second = member(f.team, f.binding, "helper-next", 10);
  activate(f.team, f.binding, "branch-a", first.threadId, 20);
  const coverage = f.team.coverage(f.binding, "leaf-a", parents);
  const request = f.team.recordRequest(f.binding, {requestId: "guide-quarantined", memberThreadId: first.threadId, memberEpoch: first.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents, now: 30});
  f.team.setRequestState(f.binding, first.threadId, request.requestId, first.epoch, "uncertain", 31);
  const transfer = f.team.beginTransfer(f.binding, "branch-a", second.threadId, parents, 32);
  const handovers = f.team.snapshot(f.binding).notifications.filter(value => value.assignmentRootThreadId === "branch-a" && value.assignmentEpoch === transfer.epoch);
  const release = handovers.find(value => value.kind === "handover_release");
  const receive = handovers.find(value => value.kind === "handover_receive");
  assert.ok(release && receive);
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, release.id, "sending", 33);
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, release.id, "uncertain", 34);

  const quarantined = f.team.quarantineMember(f.binding, first.threadId, 35);
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.epoch, first.epoch + 1);
  assert.equal(f.team.quarantineMember(f.binding, first.threadId, 36).epoch, quarantined.epoch, "repeat quarantine is idempotent");
  assert.equal(f.team.bindingForActor(first.threadId, f.binding.generation), null);
  assert.equal(f.team.resolveActor(f.binding, first.threadId, first.epoch), null);
  assert.throws(() => f.team.setRequestState(f.binding, first.threadId, request.requestId, first.epoch, "settled", 37), /supervisor_team_actor_stale/u);
  assert.throws(() => f.team.acknowledgeNotification(f.binding, first.threadId, release.id, first.epoch, 37), /supervisor_team_actor_stale/u);
  assert.equal(f.team.retryFailedNotifications(f.binding, first.threadId, 37), 0);
  assert.equal(f.team.unresolvedRequests(f.binding).find(value => value.requestId === request.requestId)?.state, "uncertain");
  assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === release.id)?.state, "uncertain");
  assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === receive.id)?.state, "superseded",
    "a never-sent receive notice is superseded, not acknowledged");
  const rootAssignment = f.team.snapshot(f.binding).assignments.find(value => value.subtreeRootThreadId === "branch-a");
  assert.equal(rootAssignment?.memberThreadId, null);
  assert.equal(rootAssignment?.state, "active");
  assert.equal(rootAssignment?.epoch, transfer.epoch + 1);
  assert.equal(rootAssignment?.fromMemberThreadId, undefined);
  assert.equal(f.team.coverage(f.binding, "leaf-a", parents).state, "unavailable", "unknown guide effects remain fenced");
  assert.equal(f.team.authorizeWrite(f.binding, f.binding.threadId, "leaf-a", parents), false);
  assert.equal(f.team.retireMember(f.binding, first.threadId, 38).state, "retired");
  assert.equal(f.team.snapshot(f.binding).events.some(event => event.kind === "member_quarantined" && event.severity === "attention"), true);

  f.team.settleRequest(f.binding, request.requestId, 39);
  const nextTransfer = f.team.assign(f.binding, "branch-a", second.threadId, parents, 40);
  assert.equal(nextTransfer.state, "transferring");
  assert.throws(() => f.team.completeTransfer(f.binding, "branch-a", nextTransfer.epoch, 41), /supervisor_team_handover_unacknowledged/u,
    "a later assignment still requires its own receive acknowledgement");
  const nextReceive = f.team.snapshot(f.binding).notifications.find(value => value.assignmentRootThreadId === "branch-a" &&
    value.assignmentEpoch === nextTransfer.epoch && value.kind === "handover_receive");
  assert.ok(nextReceive);
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, nextReceive.id, "sending", 42);
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, nextReceive.id, "delivered", 43);
  f.team.acknowledgeNotification(f.binding, second.threadId, nextReceive.id, second.epoch, 44);
  f.team.completeTransfer(f.binding, "branch-a", nextTransfer.epoch, 45);
  assert.equal(f.team.coverage(f.binding, "leaf-a", parents).actorThreadId, second.threadId);
});

test("definite notification failure is latched and only explicit retry creates a fresh attempt", async t => {
  const f = await fixture();t.after(f.cleanup);
  const helper = member(f.team, f.binding, "helper-notification-retry", 1);
  const assignment = f.team.assign(f.binding, "branch-a", helper.threadId, parents, 10);
  const receive = f.team.snapshot(f.binding).notifications.find(value => value.assignmentRootThreadId === "branch-a" &&
    value.assignmentEpoch === assignment.epoch && value.kind === "handover_receive");
  assert.ok(receive);
  assert.equal(receive.deliveryAttempt, 0);
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, receive.id, "sending", 11);
  const failed = f.team.markNotificationRejected(f.binding, f.binding.threadId, receive.id, "native_definite_rejection", 0, 12);
  assert.equal(failed.state, "failed");
  assert.equal(failed.deliveryAttempt, 0);
  assert.equal(failed.failureReason, "native_definite_rejection");
  assert.throws(() => f.team.acknowledgeNotification(f.binding, helper.threadId, receive.id, helper.epoch, 13, 0),
    /supervisor_team_notification_not_delivered/u);

  const note = f.team.note(f.binding, {eventId: "uncertain-note-event", notificationId: "uncertain-note", memberThreadId: helper.threadId,
    memberEpoch: helper.epoch, message: "Keep this uncertain notice unchanged.", now: 14});
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, note.id, "sending", 15);
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, note.id, "uncertain", 16);
  assert.equal(f.team.retryFailedNotifications(f.binding, helper.threadId, 17), 1);
  const retried = f.team.snapshot(f.binding).notifications.find(value => value.id === receive.id);
  assert.equal(retried?.state, "pending");
  assert.equal(retried?.deliveryAttempt, 1);
  assert.equal(retried?.failureReason, undefined);
  const unchanged = f.team.snapshot(f.binding).notifications.find(value => value.id === note.id);
  assert.equal(unchanged?.state, "uncertain");
  assert.equal(unchanged?.deliveryAttempt, 0);
  assert.throws(() => f.team.markNotificationRejected(f.binding, f.binding.threadId, receive.id, "stale_failure", 0, 18),
    /supervisor_team_notification_attempt_conflict/u);
  assert.throws(() => f.team.updateNotificationDelivery(f.binding, f.binding.threadId, receive.id, "uncertain", 18, 0),
    /supervisor_team_notification_attempt_conflict/u);
  assert.throws(() => f.team.acknowledgeNotification(f.binding, helper.threadId, receive.id, helper.epoch, 18, 0),
    /supervisor_team_notification_attempt_conflict/u);
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, receive.id, "sending", 19);
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, receive.id, "delivered", 20);
  f.team.acknowledgeNotification(f.binding, helper.threadId, receive.id, helper.epoch, 21, 1);
  f.team.completeTransfer(f.binding, "branch-a", assignment.epoch, 22);
  assert.equal(f.team.coverage(f.binding, "leaf-a", parents).actorThreadId, helper.threadId);
});

test("helper limit uses project settings, permits zero, and retains idle reusable helpers", async t => {
  const f = await fixture();t.after(f.cleanup);
  assert.equal(f.team.settings(f.binding).maxHelpersPerRoot, 5);
  assert.equal(f.team.setMaxHelpersPerRoot(f.binding, 0, 1).maxHelpersPerRoot, 1);
  const helper = member(f.team, f.binding, "helper-reusable", 1);
  activate(f.team, f.binding, "branch-a", helper.threadId, 10);
  const released = f.team.release(f.binding, "branch-a", parents, 20);
  const notice = f.team.snapshot(f.binding).notifications.find(value => value.assignmentRootThreadId === "branch-a" && value.assignmentEpoch === released.epoch);
  assert.ok(notice);
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notice.id, "sending", 21);
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, notice.id, "delivered", 22);
  f.team.acknowledgeNotification(f.binding, helper.threadId, notice.id, helper.epoch, 23);
  f.team.completeTransfer(f.binding, "branch-a", released.epoch, 24);
  assert.equal(f.team.snapshot(f.binding).members.find(value => value.threadId === helper.threadId)?.state, "ready");
  assert.equal(f.team.snapshot(f.binding).assignments.find(value => value.subtreeRootThreadId === "branch-a")?.memberThreadId, null);
  assert.throws(() => f.team.registerMember(f.binding, {threadId: "helper-extra", taskId: "task-extra", bootstrapRunId: "run-extra"}), /supervisor_team_helper_limit/u);
  assert.equal(f.team.setMaxHelpersPerRoot(f.binding, 1, 0).maxHelpersPerRoot, 0);
  assert.equal(f.team.snapshot(f.binding).members.length, 1);
  assert.throws(() => f.team.setMaxHelpersPerRoot(f.binding, 2, 21), /supervisor_team_invalid_helper_limit/u);
});

test("members, assignments, and uncertain handover notifications survive database reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-team-reopen-"));
  let guidance = new GuidanceStore(directory);
  let supervisors = new ProjectSupervisorStore(guidance, new Set());
  const root = supervisors.reserve("project", "main", "Main", defaultSupervisorModel, 0, 1);
  let team = new SupervisorTeamStore(supervisors);
  const binding: TeamBinding = {projectId: root.projectId, mainThreadId: root.mainThreadId, threadId: root.threadId, generation: root.generation};
  try {
    const helper = member(team, binding, "persistent-helper", 10);
    const transfer = team.assign(binding, "branch-a", helper.threadId, parents, 20);
    const notification = team.snapshot(binding).notifications.find(value => value.assignmentEpoch === transfer.epoch);
    assert.ok(notification);
    team.updateNotificationDelivery(binding, binding.threadId, notification.id, "sending", 21);
    guidance.close();
    guidance = new GuidanceStore(directory);
    supervisors = new ProjectSupervisorStore(guidance, new Set());
    team = new SupervisorTeamStore(supervisors);
    const reopened = supervisors.binding("project", "main");
    assert.ok(reopened);
    const snapshot = team.snapshot(reopened);
    assert.equal(snapshot.members.find(value => value.threadId === helper.threadId)?.state, "ready");
    assert.equal(snapshot.assignments.find(value => value.subtreeRootThreadId === "branch-a")?.state, "transferring");
    assert.equal(snapshot.notifications.find(value => value.id === notification.id)?.state, "uncertain");
    assert.equal(supervisors.ownedIds.has(helper.threadId), true);
    assert.throws(() => team.completeTransfer(reopened, "branch-a", transfer.epoch), /supervisor_team_handover_unacknowledged/u);
  } finally {
    guidance.close();
    await rm(directory, {recursive: true, force: true});
  }
});

const attempt = (notice: import("../src/supervisor-team-store.js").TeamNotification) => ({notificationId: notice.id,
  deliveryAttempt: notice.deliveryAttempt, runId: notice.observedRun!.runId});
const reviewInput = (original: import("../src/supervisor-team-store.js").TeamNotification, operationId: string,
  chain = [original]) => ({operationId, notificationId: original.id, expectedDeliveryAttempt: original.deliveryAttempt,
  expectedRunId: original.observedRun!.runId, expectedChain: chain.map(attempt)});
const interruptNotice = (team: SupervisorTeamStore, binding: TeamBinding, notice: import("../src/supervisor-team-store.js").TeamNotification) => {
  team.updateNotificationDelivery(binding, binding.threadId, notice.id, "sending", 100, notice.deliveryAttempt);
  team.updateNotificationDelivery(binding, binding.threadId, notice.id, "delivered", 101, notice.deliveryAttempt);
  return team.recordNotificationRun(binding, binding.threadId, notice.id, notice.deliveryAttempt, {runId: `run:${notice.id}`, status: "interrupted"}, 102);
};

const interruptedHandover = async () => {
  const f = await fixture();
  const helper = member(f.team, f.binding, "review-helper", 1);
  activate(f.team, f.binding, "branch-a", helper.threadId, 10);
  const coverage = f.team.coverage(f.binding, "leaf-a", parents);
  f.team.recordRequest(f.binding, {requestId: "guide:unresolved", memberThreadId: helper.threadId, memberEpoch: helper.epoch,
    targets: [{targetThreadId: "leaf-a", assignmentRootThreadId: "branch-a", assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents, now: 20});
  const transfer = f.team.release(f.binding, "branch-a", parents, 30);
  const original = interruptNotice(f.team, f.binding, f.team.snapshot(f.binding).notifications.find(value => value.assignmentEpoch === transfer.epoch)!);
  return {...f, helper, transfer, original};
};

test("interrupted review chains close durably without acknowledging history or settling request effects", async t => {
  const f = await interruptedHandover();
  let guidance = f.guidance;
  t.after(async () => {guidance.close();await rm(f.directory, {recursive: true, force: true});});
  const first = interruptNotice(f.team, f.binding, f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "review-one"), 110));
  assert.throws(() => f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "incomplete-chain")), /supervisor_team_review_chain_conflict/u);
  const input = {...reviewInput(f.original, "review-two", [f.original, first]), note: "Inspect native effects; do not assume they failed."};
  const second = f.team.reviewHandover(f.binding, f.binding.threadId, input, 120);
  assert.deepEqual(second.reviewOf, attempt(f.original));
  assert.deepEqual(second.reviewChain, [f.original, first].map(attempt));
  assert.deepEqual(f.team.reviewHandover(f.binding, f.binding.threadId, input, 121), second);
  guidance.close();
  guidance = new GuidanceStore(f.directory);
  const restarted = new SupervisorTeamStore(new ProjectSupervisorStore(guidance, new Set()));
  assert.deepEqual(restarted.snapshot(f.binding).notifications.find(value => value.id === second.id), second);
  interruptNotice(restarted, f.binding, second);
  restarted.acknowledgeNotificationRun(f.binding, f.binding.threadId, second.id, second.deliveryAttempt, `run:${second.id}`, 130);
  const snapshot = restarted.snapshot(f.binding);
  for (const previous of [f.original, first]) {
    const closed = snapshot.notifications.find(value => value.id === previous.id)!;
    assert.deepEqual(closed, {...previous, updatedAt: 130,
      resolvedByReview: {reviewNotificationId: second.id, reviewRunId: `run:${second.id}`, resolvedAt: 130}});
    assert.equal(closed.state, "delivered");
  }
  assert.equal(snapshot.notifications.find(value => value.id === second.id)?.state, "acknowledged");
  for (const event of snapshot.events) restarted.acknowledgeEvent(f.binding, f.binding.threadId, event.id, 131);
  assert.equal(restarted.hasBlockingWork(f.binding), true);
  assert.equal(restarted.unresolvedRequests(f.binding).length, 1);
  assert.throws(() => restarted.completeTransfer(f.binding, "branch-a", f.transfer.epoch), /supervisor_team_handover_pending_effects/u);
  restarted.settleRequest(f.binding, "guide:unresolved", 132);
  restarted.completeTransfer(f.binding, "branch-a", f.transfer.epoch, 133);
  for (const event of restarted.snapshot(f.binding).events) restarted.acknowledgeEvent(f.binding, f.binding.threadId, event.id, 134);
  assert.equal(restarted.hasBlockingWork(f.binding), false, "closed notice history is no longer work");
});

test("late original completion supersedes only pending reviews and sent reviews keep their own fence", async t => {
  for (const state of ["pending", "sending", "uncertain", "delivered"] as const) {
    const f = await interruptedHandover();t.after(f.cleanup);
    const review = f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "late-review"));
    if (state !== "pending") f.team.updateNotificationDelivery(f.binding, f.binding.threadId, review.id, "sending");
    if (state === "uncertain" || state === "delivered") f.team.updateNotificationDelivery(f.binding, f.binding.threadId, review.id, state);
    f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, f.original.id, 0, "late-native-completion");
    assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === review.id)?.state, state === "pending" ? "superseded" : state);
    f.team.settleRequest(f.binding, "guide:unresolved");
    if (state !== "pending") {
      assert.throws(() => f.team.completeTransfer(f.binding, "branch-a", f.transfer.epoch), /supervisor_team_handover_unacknowledged/u);
      if (state !== "delivered") f.team.updateNotificationDelivery(f.binding, f.binding.threadId, review.id, "delivered");
      f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, review.id, 0, "own-review-completion");
    }
    assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === f.original.id)?.resolvedByReview, undefined);
    f.team.completeTransfer(f.binding, "branch-a", f.transfer.epoch);
  }
});

test("epoch changes supersede pending reviews while sent reviews acknowledge only themselves", async t => {
  for (const lifecycle of ["missing", "quarantine"] as const) for (const sent of [false, true]) {
    const f = await interruptedHandover();t.after(f.cleanup);
    const review = f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "epoch-review"));
    if (sent) interruptNotice(f.team, f.binding, review);
    if (lifecycle === "missing") f.team.markMissing(f.binding, f.helper.threadId);
    else f.team.quarantineMember(f.binding, f.helper.threadId);
    assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === review.id)?.state, sent ? "delivered" : "superseded");
    const next = member(f.team, f.binding, "next-helper", 200);
    const reassigned = f.team.assign(f.binding, "branch-a", next.threadId, parents, 201);
    assert.ok(reassigned.epoch > f.transfer.epoch);
    assert.throws(() => f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "stale-review")), /supervisor_team_member_epoch_conflict/u);
    if (sent) {
      f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, review.id, 0, "review-completed-after-epoch");
      assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === review.id)?.state, "acknowledged");
      assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === f.original.id)?.resolvedByReview, undefined);
    }
    assert.equal(f.team.unresolvedRequests(f.binding).length, 1);
    for (const event of f.team.snapshot(f.binding).events) f.team.acknowledgeEvent(f.binding, f.binding.threadId, event.id);
    assert.equal(f.team.hasBlockingWork(f.binding), true);
  }
});

test("review CAS and operation identities reject forged helper acknowledgements and reflect no input", async t => {
  const f = await interruptedHandover();t.after(f.cleanup);
  const input = {...reviewInput(f.original, "sentinel-operation"), note: "sentinel-note"};
  const before = f.team.snapshot(f.binding);
  const denies = (call: () => unknown) => assert.throws(call, error => error instanceof Error &&
    /^supervisor_team_[a-z_]+$/u.test(error.message) && !error.message.includes("sentinel"));
  denies(() => f.team.reviewHandover(f.binding, f.helper.threadId, input));
  denies(() => f.team.reviewHandover(f.binding, f.binding.threadId, {...input, expectedRunId: "sentinel-run"}));
  denies(() => f.team.reviewHandover(f.binding, f.binding.threadId, {...input, expectedDeliveryAttempt: 12}));
  denies(() => f.team.reviewHandover(f.binding, f.binding.threadId, {...input, note: "sentinel".repeat(150)}));
  denies(() => f.team.reviewHandover(f.binding, f.binding.threadId, {...input, note: "sentinel\u0000"}));
  denies(() => f.team.acknowledgeNotification(f.binding, f.helper.threadId, f.original.id, f.helper.epoch));
  denies(() => f.team.acknowledgeNotificationRun(f.binding, f.helper.threadId, f.original.id, 0, "sentinel-run"));
  assert.deepEqual(f.team.snapshot(f.binding), before);
  const review = f.team.reviewHandover(f.binding, f.binding.threadId, input);
  assert.deepEqual(f.team.reviewHandover(f.binding, f.binding.threadId, input), review);
  denies(() => f.team.reviewHandover(f.binding, f.binding.threadId, {...input, note: "sentinel-changed"}));
  denies(() => f.team.reviewHandover(f.binding, f.binding.threadId, {...input, operationId: "sentinel-concurrent"}));
  interruptNotice(f.team, f.binding, review);
  denies(() => f.team.acknowledgeNotification(f.binding, f.helper.threadId, review.id, f.helper.epoch));
  denies(() => f.team.acknowledgeNotificationRun(f.binding, f.helper.threadId, review.id, 0, "sentinel-forged"));
});

test("failed reviews retry only their still-open exact chain", async t => {
  const f = await interruptedHandover();t.after(f.cleanup);
  const review = f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "failed-review"));
  f.team.markNotificationRejected(f.binding, f.binding.threadId, review.id, "Definite rejection", 0);
  assert.equal(f.team.retryFailedNotifications(f.binding, f.helper.threadId), 1);
  const retry = f.team.snapshot(f.binding).notifications.find(value => value.id === review.id)!;
  assert.equal(retry.deliveryAttempt, 1);
  assert.deepEqual(retry.reviewChain, review.reviewChain);
  f.team.markNotificationRejected(f.binding, f.binding.threadId, review.id, "Definite rejection", 1);
  f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, f.original.id, 0, "late-completed");
  assert.equal(f.team.retryFailedNotifications(f.binding, f.helper.threadId), 0);
});

test("an interrupted sent review remains reviewable after the original late acknowledgement", async t => {
  const f = await interruptedHandover();t.after(f.cleanup);
  const first = interruptNotice(f.team, f.binding, f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "sent-before-original-completed")));
  f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, f.original.id, 0, "original-now-completed");
  const second = f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(f.original, "review-only-unresolved-effects", [first]));
  assert.deepEqual(second.reviewChain, [attempt(first)]);
  interruptNotice(f.team, f.binding, second);
  f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, second.id, 0, "second-review-completed");
  assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === first.id)?.resolvedByReview?.reviewNotificationId, second.id);
  assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === f.original.id)?.resolvedByReview, undefined);
});

test("reassignment and release cannot reuse an old review even when its recipient is still ready", async t => {
  for (const sent of [false, true]) {
    const f = await fixture();t.after(f.cleanup);
    const first = member(f.team, f.binding, "old-owner", 1);
    const second = member(f.team, f.binding, "lost-recipient", 2);
    activate(f.team, f.binding, "branch-a", first.threadId, 10);
    const transfer = f.team.assign(f.binding, "branch-a", second.threadId, parents, 20);
    const original = interruptNotice(f.team, f.binding, f.team.snapshot(f.binding).notifications.find(value => value.assignmentEpoch === transfer.epoch && value.kind === "handover_release")!);
    const review = f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(original, "old-epoch-review"));
    if (sent) interruptNotice(f.team, f.binding, review);
    f.team.markMissing(f.binding, second.threadId);
    assert.equal(f.team.resolveActor(f.binding, first.threadId, first.epoch)?.role, "helper");
    assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === review.id)?.state, sent ? "delivered" : "superseded");
    activate(f.team, f.binding, "branch-a", first.threadId, 200);
    f.team.release(f.binding, "branch-a", parents, 210);
    assert.throws(() => f.team.reviewHandover(f.binding, f.binding.threadId, reviewInput(original, "cannot-review-stale-assignment")), /supervisor_team_assignment_epoch_conflict/u);
    if (sent) {
      f.team.acknowledgeNotificationRun(f.binding, f.binding.threadId, review.id, 0, "stale-review-completed");
      assert.equal(f.team.snapshot(f.binding).notifications.find(value => value.id === original.id)?.resolvedByReview, undefined);
    }
  }
});
