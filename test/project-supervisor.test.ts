import assert from "node:assert/strict";
import { createServer } from "node:http";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { effectiveIndex, makeDefinitionFixture, projectIndex, stepSource } from "./project-definitions-fixture.js";
import { defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { ProjectSupervisorSnapshot } from "../src/project-supervisor-contract.js";
import { SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import { makeT3Client, T3Client, T3TransportError } from "../src/t3.js";
import { taskFields } from "./support/interpretation-submit.js";
import {
  activationSequence, addPendingHelperCheckin, baseTime, completeSupervisorRequest, day, emptySupervisorProjection, interruptHungPass,
  makeFixture, makeSourceProjection, markRootMissing, missingDefinitions, noProjectFixture, registerReadyHelper, reserveReadyBinding,
  retryInput, startIntake, workflowResult, workflowSnapshot, type Turn,
} from "./support/ps-fixture.js";

it.effect("scopeSnapshot returns current binding coordinates and verified descendant lineage across project mirrors", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  const binding = yield* reserveReadyBinding(fixture);
  const main = fixture.projections.get("source-thread");
  assert.ok(main);
  const child = makeSourceProjection("native-child", "other-project", []);
  child.thread.projectId = null;
  child.thread.lineage = {parentThreadId: "source-thread", relationshipToParent: "subagent", rootThreadId: "source-thread"};
  child.thread.creationSource = "provider";
  child.thread.activeRunId = null;
  const delegated = makeSourceProjection("delegated-child", "other-project", []);
  delegated.thread.lineage = {parentThreadId: "source-thread", relationshipToParent: "subagent", rootThreadId: "source-thread"};
  delegated.thread.creationSource = "mcp";
  main.subagents = [{childThreadId: child.thread.id, status: "running"}, {childThreadId: delegated.thread.id, status: "completed"}];
  fixture.projections.set(child.thread.id, child);
  fixture.projections.set(delegated.thread.id, delegated);

  const supervisor = yield* fixture.makeSupervisor();
  assert.deepEqual(yield* supervisor.workflowLocator("project-a", "source-thread"), {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation});
  const readsBefore = fixture.projectionReads.length;
  const snapshot = yield* supervisor.scopeSnapshot("project-a", "source-thread", {lineageOffset: 2, limit: 1});
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.supervisorThreadId, binding.threadId);
  assert.equal(snapshot.bindingGeneration, binding.generation);
  assert.equal(snapshot.lineageTotal, 3);
  assert.equal(snapshot.lineageOffset, 2);
  assert.equal(snapshot.lineageHasMore, false);
  assert.deepEqual(snapshot.threads.map(row => row.threadId), ["native-child"]);
  assert.equal(snapshot.threads[0]?.parentThreadId, "source-thread");
  assert.equal(snapshot.threads[0]?.origin, "native_child");
  assert.equal(snapshot.threads[0]?.lifecycle, "running");
  assert.match(snapshot.threads[0]?.contactLimit ?? "", /direct parent/u);
  assert.deepEqual(fixture.projectionReads.slice(readsBefore), [binding.threadId, "native-child", "source-thread"],
    "the snapshot reads only the requested child and its parent, plus the owning Supervisor");
}));

it.effect("an unbound scopeSnapshot returns only the requested lineage page without Supervisor reads", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  for (const id of ["child-one", "child-two"]) {
    const child = makeSourceProjection(id, "other-project", []);
    child.thread.projectId = null;
    child.thread.lineage = {parentThreadId: "source-thread", relationshipToParent: "subagent", rootThreadId: "source-thread"};
    child.thread.creationSource = "provider";
    fixture.projections.set(id, child);
  }
  const readsBefore = fixture.projectionReads.length;
  const supervisor = yield* fixture.makeSupervisor();
  const snapshot = yield* supervisor.scopeSnapshot("project-a", "source-thread", {lineageOffset: 1, limit: 1});
  assert.equal(snapshot.supervisorThreadId, null);
  assert.equal(snapshot.bindingGeneration, null);
  assert.equal(snapshot.lineageTotal, 3);
  assert.deepEqual(snapshot.threads.map(row => row.threadId), ["child-one"]);
  assert.deepEqual(fixture.projectionReads.slice(readsBefore), ["child-one", "source-thread"]);
}));

it.effect("activation baseline excludes existing runs and gives independent mains separate Supervisors", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "old-thread", projectId: "project-a", turns: [{ id: "old-task", sequence: 9, text: "Old work" }] },
    { threadId: "current-thread", projectId: "project-a", turns: [
      { id: "current-history", sequence: 10, text: "Earlier request" },
      { id: "current-task", sequence: 11, text: "Build the invoice export" },
    ] },
    { threadId: "archived-history", projectId: "project-a", turns: [{ id: "archived-task", sequence: 8, text: "Archived work" }] },
  ]);
  fixture.projections.get("archived-history")!.thread.archivedAt = baseTime;
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const baseline = yield* fixture.store.baseline();
  assert.equal(baseline?.snapshotSequence, activationSequence);
  assert.equal(baseline?.version, 2);
  assert.equal(baseline?.threads.find((thread) => thread.id === "old-thread")?.latestRunId, "run-old-task");
  assert.equal(baseline?.threads.find((thread) => thread.id === "current-thread")?.latestRunId, "run-current-history");
  assert.equal(baseline?.threads.find((thread) => thread.id === "archived-history")?.latestRunId, "run-archived-task");
  assert.equal(yield* fixture.store.task("old-thread"), null);
  assert.equal((yield* fixture.store.task("current-thread"))?.status, "waiting");
  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
  const initialLaunch = fixture.operations.find((call) => call.tag === "orchestration.launchThread");
  assert.ok(initialLaunch);
  assert.ok(initialLaunch.payload.reuseExistingThread === undefined || initialLaunch.payload.reuseExistingThread === false);
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 1);

  const childProjection = makeSourceProjection("owned-descendant", "project-a", [{ id: "child-task", sequence: 99, text: "Do not recurse" }]);
  childProjection.thread.lineage = { parentThreadId: binding.threadId, relationshipToParent: "fork" };
  fixture.projections.set("owned-descendant", childProjection);
  fixture.addTurn("second-thread", "project-a", { id: "second-task", sequence: 12, text: "Prepare a release note" });

  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("second-thread"))?.status, "waiting");
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 2, "each main can have its own in-flight interpretation");
  assert.equal(fixture.projectionReads.includes("owned-descendant"), false);

  const firstTask = yield* fixture.store.task("current-thread");
  assert.ok(firstTask);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  // a submission citing another input is refused with its typed diagnostic and records nothing; the source-linked one is recorded
  assert.deepEqual(yield* supervisor.submit(firstTask, taskFields(firstTask, "A different task", "The response points to another input.",
    {sourceMessageIds: ["unrelated-message"]})), {status: "invalid", code: "source_message_ids_mismatch",
    issues: [{code: "source_message_ids_mismatch", path: "/sourceMessageIds"}], retry: "corrected"});
  assert.deepEqual(yield* supervisor.submit(firstTask, taskFields(firstTask, "Build the invoice export", "The source request asks for an export to be built.")),
    {status: "submitted", attemptId: firstTask.attempt!.attemptId, retry: "none"});
  completeSupervisorRequest(supervisorProjection, firstTask.messageId, "Submitted the interpretation.");
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("current-thread"))?.status, "inferred");
  assert.equal((yield* fixture.store.task("current-thread"))?.objective, "Build the invoice export");

  yield* supervisor.runOnce;
  const dispatches = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(dispatches.length, 2);
  assert.deepEqual(new Set(dispatches.map(call => call.payload.threadId)), new Set((yield* fixture.store.bindings()).map(binding => binding.threadId)));
  assert.notEqual(dispatches[0]?.payload.messageId, dispatches[1]?.payload.messageId);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 2);
}));

it.effect("a newly registered project reuses startup history bounds and auto-enables before its next prompt", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "new-main", projectId: "project-new", turns: [
    {id: "preexisting-history", sequence: 9, text: "A task that predates the service startup boundary"},
  ]}]);
  const definitions = {
    load: (projectId: string, threadId: string | null) => Effect.succeed(missingDefinitions(projectId, threadId, "/work/new")),
    presence: (projectId: string) => Effect.succeed({status: projectId === "project-new" ? "present" as const : "missing" as const}),
  };
  const supervisor = yield* fixture.makeSupervisor(definitions);
  yield* supervisor.runOnce;
  fixture.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
  yield* supervisor.runOnce;
  assert.equal(yield* fixture.store.autoControlInitialized("project-new"), true);
  assert.equal((yield* fixture.store.control("project-new")).enabled, true);
  assert.equal(yield* fixture.store.task("new-main"), null, "startup history stays excluded even before the project appears in the catalog");
  assert.equal(fixture.baselineReads, 1, "first known-present detection reuses the startup baseline");

  fixture.addTurn("new-main", "project-new", {id: "first-task", sequence: 11, text: "Build the first project change"});
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("new-main"))?.sourceMessageId, "first-task");
  assert.equal((yield* fixture.store.task("new-main"))?.status, "waiting");
  assert.equal((yield* fixture.store.bindings()).some(binding => binding.projectId === "project-new" && binding.mainThreadId === "new-main"), true);
  assert.equal(fixture.baselineReads, 1, "auto-detection does not move the boundary past the first subsequent task");
}));

it.effect("a project added with its first human task between polls supervises that task", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "existing-thread", projectId: "project-a", turns: []}]);
  const definitions = {
    load: (projectId: string, threadId: string | null) => Effect.succeed(missingDefinitions(projectId, threadId, "/work/new")),
    presence: (projectId: string) => Effect.succeed({status: projectId === "project-new" ? "present" as const : "missing" as const}),
  };
  const supervisor = yield* fixture.makeSupervisor(definitions);
  yield* supervisor.runOnce;
  fixture.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
  fixture.addTurn("first-main", "project-new", {id: "first-task", sequence: 11, text: "Build the first project change"});

  yield* supervisor.runOnce;

  assert.equal(yield* fixture.store.autoControlInitialized("project-new"), true);
  assert.equal((yield* fixture.store.control("project-new")).effectiveEnabled, true);
  assert.equal((yield* fixture.store.task("first-main"))?.sourceMessageId, "first-task");
  assert.equal((yield* fixture.store.task("first-main"))?.status, "waiting");
  assert.equal(fixture.baselineReads, 1, "the post-startup task is not absorbed by a late first-seen snapshot");
}));

it.effect("a project that was unreadable recaptures its boundary before resuming discovery", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "existing-thread", projectId: "project-a", turns: []}]);
  let folderStatus: "present" | "unavailable" = "unavailable";
  const definitions = {
    load: (projectId: string, threadId: string | null) => Effect.succeed(missingDefinitions(projectId, threadId, "/work/new")),
    presence: (projectId: string) => Effect.sync(() => ({status: projectId === "project-new" ? folderStatus : "missing" as const})),
  };
  const supervisor = yield* fixture.makeSupervisor(definitions);
  yield* supervisor.runOnce;
  fixture.addProject({id: "project-new", title: "New project", workspaceRoot: "/work/new"});
  yield* supervisor.runOnce;
  assert.equal(yield* fixture.store.autoControlInitialized("project-new"), false);
  assert.equal(yield* fixture.store.projectBoundary("project-new"), null);

  yield* fixture.restart;
  const restartedSupervisor = yield* fixture.makeSupervisor(definitions);
  fixture.addTurn("new-main", "project-new", {id: "first-task", sequence: 11, text: "Work created during an unreadable interval"});
  fixture.setSnapshotSequence(11);
  folderStatus = "present";
  yield* restartedSupervisor.runOnce;
  assert.equal((yield* fixture.store.control("project-new")).enabled, true);
  assert.equal(yield* fixture.store.task("new-main"), null, "the unreadable interval is excluded from first-time discovery");
  assert.equal((yield* fixture.store.bindings()).some(binding => binding.projectId === "project-new"), false);

  fixture.addTurn("new-main", "project-new", {id: "next-task", sequence: 12, text: "Work submitted after the folder became readable"});
  yield* restartedSupervisor.runOnce;
  assert.equal((yield* fixture.store.task("new-main"))?.sourceMessageId, "next-task");
  assert.equal((yield* fixture.store.task("new-main"))?.status, "waiting");
}));

it.effect("a web-originated message with non-user authorship is not treated as a task", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{
      id: "non-user-source",
      sequence: 11,
      text: "A web-originated message not authored by the user",
      creationSource: "web",
      createdBy: "assistant",
    }] },
  ]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;

  assert.equal(yield* fixture.store.task("source-thread"), null);
  assert.equal(((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 0);
}));

it.effect("a missing baseline run anchor fails closed instead of interpreting later projection history", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "baseline-anchor", sequence: 9, text: "Historical request" }] },
  ]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  assert.equal(yield* fixture.store.baselineOrdinal("source-thread", fixture.projections.get("source-thread")!), 1);

  fixture.projections.set("source-thread", makeSourceProjection("source-thread", "project-a", [
    { id: "later-task", sequence: 11, text: "This run must not pass a missing baseline anchor" },
  ]));
  yield* supervisor.runOnce;

  assert.equal(yield* fixture.store.baselineOrdinal("source-thread", fixture.projections.get("source-thread")!), null);
  assert.equal(yield* fixture.store.task("source-thread"), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 0);
}));

it.effect("an unversioned activation baseline is replaced by a conservative version 2 capture", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [
      { id: "legacy-history", sequence: 9, text: "Do not backfill this old task" },
      { id: "post-activation-task", sequence: 11, text: "Review the next change" },
    ] },
  ]);
  yield* fixture.setLegacyBaseline({ snapshotSequence: 9, threads: [] });
  assert.equal(yield* fixture.store.baseline(), null);

  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;

  const baseline = yield* fixture.store.baseline();
  assert.equal(baseline?.version, 2);
  assert.equal(baseline?.snapshotSequence, activationSequence);
  assert.equal(baseline?.threads.find((thread) => thread.id === "source-thread")?.latestRunId, "run-legacy-history");
  assert.equal(fixture.baselineReads, 1);
  assert.equal((yield* fixture.store.task("source-thread"))?.sourceMessageId, "post-activation-task");
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "waiting");
}));

it.effect("model choices are checked against T3 and saved per project with generation CAS", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([]);
  const supervisor = yield* fixture.makeSupervisor();
  const invalid = yield* supervisor.save({
    projectId: "project-a",
    expectedGeneration: 0,
    modelSelection: { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "unadvertised" }] },
  });
  assert.equal(invalid.status, "invalid");

  const savedA = yield* supervisor.save({
    projectId: "project-a",
    expectedGeneration: 0,
    modelSelection: { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "low" }] },
  });
  assert.equal(savedA.status, "saved");
  assert.equal(savedA.snapshot?.settings.generation, 1);
  const conflict = yield* supervisor.save({
    projectId: "project-a",
    expectedGeneration: 0,
    modelSelection: defaultSupervisorModel,
  });
  assert.equal(conflict.status, "conflict");

  const savedB = yield* supervisor.save({
    projectId: "project-b",
    expectedGeneration: 0,
    modelSelection: { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "max" }] },
  });
  assert.equal(savedB.status, "saved");
  assert.equal((yield* fixture.store.settings("project-a")).modelSelection.options[0]?.value, "low");
  assert.equal((yield* fixture.store.settings("project-b")).modelSelection.model, "gpt-6-astra");
  assert.equal((yield* fixture.store.settings("project-b")).generation, 1);
}));

it.effect("model defaults affect new Supervisors while independent T3 selections remain authoritative", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "first", projectId: "project-a", turns: [{id: "first-task", sequence: 11, text: "Implement first"}]}]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const first = (yield* fixture.store.binding("project-a", "first"))!;
  const manual = {...defaultSupervisorModel, model: "gpt-6-astra", options: [{id: "reasoningEffort", value: "max"}]};
  fixture.projections.get(first.threadId)!.thread.modelSelection = manual;
  const defaults = {...defaultSupervisorModel, options: [{id: "reasoningEffort", value: "low"}]};
  assert.equal((yield* supervisor.save({projectId: "project-a", expectedGeneration: 0, modelSelection: defaults})).status, "saved");
  fixture.addTurn("second", "project-a", {id: "second-task", sequence: 12, text: "Implement second"});
  yield* supervisor.runOnce;
  const second = (yield* fixture.store.binding("project-a", "second"))!;
  assert.notEqual(first.threadId, second.threadId);
  assert.deepEqual(fixture.projections.get(first.threadId)!.thread.modelSelection, manual);
  assert.deepEqual(fixture.projections.get(second.threadId)!.thread.modelSelection, defaults);
  assert.deepEqual((yield* fixture.store.settings("project-a")).modelSelection, defaults);
  assert.equal(fixture.operations.some(call => call.payload.type === "thread.model-selection.set"), false);
  const selected = yield* supervisor.snapshot("project-a", "first");
  assert.deepEqual(selected.modelSelection, manual);
  const noSelection = yield* supervisor.snapshot("project-a", null);
  assert.equal(noSelection.binding, null);
  assert.equal(noSelection.modelSelection, null);
  assert.deepEqual(noSelection.tasks, []);
}));

it.effect("unknown dispatch survives restart and retention with the original native identities", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  fixture.setUnknownDispatches(1);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const uncertain = yield* fixture.store.task("source-thread");
  assert.equal(uncertain?.status, "uncertain");
  assert.ok(uncertain);
  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  yield* fixture.store.saveTask({ ...uncertain, updatedAt: Date.now() - 31 * day });
  const activationBaseline = yield* fixture.store.baseline();
  assert.ok(activationBaseline);

  fixture.setSnapshotSequence(12);
  yield* fixture.restart;
  assert.equal(fixture.store.ownedIds.has(binding.threadId), true);
  assert.deepEqual(yield* fixture.store.baseline(), activationBaseline);
  assert.equal(fixture.baselineReads, 1, "restart must reuse the original baseline instead of moving activation forward");
  yield* fixture.store.prune(Date.now());
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "uncertain");

  const resumed = yield* fixture.makeSupervisor();
  yield* resumed.runOnce;
  const dispatches = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[1]?.payload.commandId, dispatches[0]?.payload.commandId);
  assert.equal(dispatches[1]?.payload.messageId, dispatches[0]?.payload.messageId);
  assert.equal(dispatches[1]?.payload.text, dispatches[0]?.payload.text);
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "waiting");
  assert.equal(fixture.operations.some((call) => ["runtime-request.respond", "thread.interrupt", "runtime-request.interrupt"].includes(String(call.payload.type))), false);
}));

it.effect("accepted requests without native runs stop after two replays and remain available for explicit retry", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  fixture.setAcceptedDispatchesWithoutRun(3);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  for (let attempt = 0; attempt < 3; attempt += 1) yield* supervisor.runOnce;

  const uncertain = yield* fixture.store.task("source-thread");
  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(uncertain && binding);
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.replayCount, 2);
  const dispatches = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(dispatches.length, 3);
  assert.ok(dispatches.every((call) => call.payload.commandId === dispatches[0]?.payload.commandId));
  assert.ok(dispatches.every((call) => call.payload.messageId === dispatches[0]?.payload.messageId));

  yield* supervisor.runOnce;
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 3, "uncertainty waits for an explicit UI retry");
  const retry = yield* supervisor.retry(retryInput("project-a", 0, binding, "retry"));
  assert.equal(retry.status, "saved");
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "waiting");
  const retried = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(retried.length, 4);
  assert.equal(retried[3]?.payload.commandId, retried[0]?.payload.commandId);
  assert.equal(retried[3]?.payload.messageId, retried[0]?.payload.messageId);
}));

it.effect("a transient Supervisor projection failure is not treated as proof the thread is missing", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  fixture.setNextMissingProjectionFailure(new T3TransportError("projection unavailable", 503));
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;

  const reserved = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(reserved);
  assert.equal(reserved.state, "creating");
  assert.equal(yield* fixture.store.task("source-thread"), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 0);

  yield* supervisor.runOnce;
  assert.equal(((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null)?.state, "ready");
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "waiting");
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
}));

it.effect("creation attempts stop after three failures until explicit retry reuses the original command identity", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  fixture.setLaunchFailuresBeforeCreate(3);
  const supervisor = yield* fixture.makeSupervisor();
  for (let attempt = 0; attempt < 4; attempt += 1) yield* supervisor.runOnce;

  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  assert.equal(binding.state, "uncertain");
  assert.equal(binding.creationAttempts, 3);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 3);
  const originalCommandId = fixture.operations.find((call) => call.tag === "orchestration.launchThread")?.payload.commandId;
  assert.ok(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").every((call) => call.payload.commandId === originalCommandId));
  assert.equal(yield* fixture.store.task("source-thread"), null);

  const retry = yield* supervisor.retry(retryInput("project-a", 0, binding, "retry"));
  assert.equal(retry.status, "saved");
  assert.equal(((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null)?.threadId, binding.threadId);
  const launches = fixture.operations.filter((call) => call.tag === "orchestration.launchThread");
  assert.equal(launches.length, 4);
  assert.equal(launches[3]?.payload.commandId, originalCommandId);
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "waiting");
  assert.equal(fixture.store.ownedIds.size, 1);
}));

it.effect("durable creation rejection requires explicit retry and advances only the native command generation", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  fixture.setDurableLaunchRejections(1);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const rejected = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(rejected);
  assert.equal(rejected.state, "rejected");
  assert.equal(yield* fixture.store.task("source-thread"), null);
  yield* supervisor.runOnce;
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1, "durable rejection cannot auto-replay");

  const retry = yield* supervisor.retry(retryInput("project-a", 0, rejected, "retry"));
  assert.equal(retry.status, "saved");
  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.equal(binding?.threadId, rejected.threadId);
  assert.equal(binding?.generation, rejected.generation + 1);
  const launches = fixture.operations.filter((call) => call.tag === "orchestration.launchThread");
  assert.equal(launches.length, 2);
  assert.notEqual(launches[0]?.payload.commandId, launches[1]?.payload.commandId);
  assert.equal(launches[0]?.payload.threadId, launches[1]?.payload.threadId);
  assert.equal(fixture.store.ownedIds.size, 1);
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "waiting");
}));

it.effect("a provider-disabled initial creation is durably rejected without automatic relaunch", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  fixture.setProviderDisabledLaunchRejections(1);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;

  assert.equal(((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null)?.state, "rejected");
  assert.equal(yield* fixture.store.task("source-thread"), null);
  yield* supervisor.runOnce;
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
}));

it.effect("a provider-disabled objective does not block another main in the same project", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "first-thread", projectId: "project-a", turns: [{id: "first-task", sequence: 11, text: "Implement first"}]},
    {threadId: "second-thread", projectId: "project-a", turns: [{id: "second-task", sequence: 12, text: "Implement second"}]}]);
  // the two mains dispatch concurrently: only the first main's interpretation request is rejected as provider-disabled
  fixture.setProviderDisabledDispatchMatching((payload) => String(payload.text).includes("Implement first"));
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("first-thread"))?.status, "unavailable");
  assert.equal((yield* fixture.store.task("second-thread"))?.status, "waiting");
  assert.notEqual((yield* fixture.store.task("first-thread"))?.supervisorThreadId, (yield* fixture.store.task("second-thread"))?.supervisorThreadId);
}));

it.effect("a lost launch response recovers the native-created Supervisor without duplicate launch or ownership", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  fixture.setUnknownLaunchResponses(1);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;

  const reserved = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(reserved);
  assert.equal(reserved.state, "ready", "the native-created thread is reconciled from its visible projection");
  assert.equal(yield* fixture.store.task("source-thread"), null);
  assert.equal(fixture.store.ownedIds.size, 1);
  assert.ok(fixture.projections.has(reserved.threadId), "the fake native server created the thread before losing its reply");

  const resumed = yield* fixture.makeSupervisor();
  yield* resumed.runOnce;
  const recovered = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.equal(recovered?.threadId, reserved.threadId);
  assert.equal(recovered?.state, "ready");
  assert.equal(fixture.store.ownedIds.size, 1);
  assert.equal(fixture.store.ownedIds.has(reserved.threadId), true);
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "waiting");
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
}));

it.effect("an archived reserved binding is retained and never launched again", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  fixture.setUnknownLaunchResponses(1);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  const projection = fixture.projections.get(binding.threadId);
  assert.ok(projection);
  projection.thread.archivedAt = baseTime;

  const resumed = yield* fixture.makeSupervisor();
  yield* resumed.runOnce;
  assert.equal(((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null)?.threadId, binding.threadId);
  assert.equal(((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null)?.state, "ready");
  assert.equal(fixture.store.ownedIds.size, 1);
  assert.equal(yield* fixture.store.task("source-thread"), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
}));

it.effect("workflow editing waits for classification and keeps No Project activation independent of definitions", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  yield* reserveReadyBinding(fixture);
  const supervisor = yield* fixture.makeSupervisor();
  assert.equal(yield* supervisor.workflowEditingEnabled("project-a"), false, "startup cannot bypass unknown Scratch classification");
  yield* supervisor.runOnce;
  assert.equal(yield* supervisor.workflowEditingEnabled("project-a"), true);
  const guidance = fixture.guidance;
  yield* guidance.classify("project-a", "scratch", (yield* guidance.settings()).generation);
  assert.equal(yield* supervisor.workflowEditingEnabled("project-a"), false);
  yield* fixture.store.saveGlobalDefinitionsControl(0, true);
  assert.equal(yield* supervisor.workflowEditingEnabled("project-a"), false);
  yield* supervisor.saveNoProjectControl({expectedGeneration: 0, mode: "automatic"});
  assert.equal(yield* supervisor.workflowEditingEnabled("project-a"), true);
  yield* fixture.store.saveGlobalDefinitionsControl(1, false);
  assert.equal(yield* supervisor.workflowEditingEnabled("project-a"), true);
  yield* guidance.classify("project-a", "project", (yield* guidance.settings()).generation);
  assert.equal(yield* supervisor.workflowEditingEnabled("project-a"), true);
  yield* fixture.store.saveControl("project-a", 1, false);
  assert.equal(yield* supervisor.workflowEditingEnabled("project-a"), false);
  yield* fixture.store.saveControl("project-a", 2, true, {snapshotSequence: activationSequence, threads: []});
  assert.equal(yield* supervisor.workflowEditingEnabled("project-a"), true);
  yield* fixture.store.saveControl(null, 0, false);
  assert.equal(yield* supervisor.workflowEditingEnabled("project-a"), false);
}));

it.effect("global or project off still parks closed idle bindings without semantic work", () => Effect.gen(function* () {
  for (const disabledScope of ["global", "project"] as const) {
    const fixture = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
    const binding = yield* reserveReadyBinding(fixture);
    fixture.projections.get("source-thread")!.thread.archivedAt = baseTime;
    if (disabledScope === "global") yield* fixture.store.saveControl(null, 0, false);
    else yield* fixture.store.saveControl("project-a", 1, false);

    const supervisor = yield* fixture.makeSupervisor();
    yield* supervisor.runOnce;
    assert.equal((yield* fixture.store.binding("project-a", "source-thread"))?.settlement, undefined);
    yield* TestClock.adjust(SUPERVISOR_SETTLE_QUIET_MS + 1);
    yield* supervisor.runOnce;
    assert.equal((yield* fixture.store.binding("project-a", "source-thread"))?.settlement?.state, "settled");
    assert.equal(fixture.operations.filter(call => call.payload.type === "thread.settle").length, 1);
    assert.equal(fixture.operations.some(call => call.payload.type === "message.dispatch" || call.tag === "orchestration.launchThread"), false);
    assert.equal(yield* fixture.store.task("source-thread"), null);
    assert.ok(fixture.projections.has(binding.threadId));
  }
}), { timeout: 60_000 });

it.effect("disabled supervision never settles a closed main with an active Supervisor run", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  const binding = yield* reserveReadyBinding(fixture);
  fixture.projections.get("source-thread")!.thread.archivedAt = baseTime;
  const supervisorProjection = fixture.projections.get(binding.threadId)!;
  supervisorProjection.runs.push({id: "active-supervisor-run", threadId: binding.threadId, ordinal: 1, status: "running", requestedAt: baseTime,
    startedAt: baseTime, completedAt: null, rootNodeId: "active-supervisor-root"});
  yield* fixture.store.saveControl(null, 0, false);

  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  assert.equal(fixture.operations.some(call => call.payload.type === "thread.settle"), false);
  assert.equal(fixture.operations.some(call => call.payload.type === "message.dispatch" || call.tag === "orchestration.launchThread"), false);
  assert.equal((yield* fixture.store.binding("project-a", "source-thread"))?.settlement, undefined);
}));

it.effect("missing-root replacement terminalizes helper check-ins after confirming active and previously missing helpers", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  const binding = yield* reserveReadyBinding(fixture);
  const supervisor = yield* fixture.makeSupervisor();
  const reviewHelper = yield* registerReadyHelper(fixture, supervisor, binding, "helper-review-missing");
  const reviewTarget = makeSourceProjection("operational-review", binding.projectId, []);
  reviewTarget.thread.lineage = {parentThreadId: binding.mainThreadId, relationshipToParent: "subagent", rootThreadId: binding.mainThreadId};
  fixture.projections.set(reviewTarget.thread.id, reviewTarget);
  const parents = new Map<string, string | null>([[binding.mainThreadId, null], [reviewTarget.thread.id, binding.mainThreadId]]);
  const assignment = yield* supervisor.team.assign(binding, reviewTarget.thread.id, reviewHelper.threadId, parents, 10);
  const receive = (yield* supervisor.team.snapshot(binding)).notifications.find(value => value.assignmentRootThreadId === reviewTarget.thread.id &&
    value.assignmentEpoch === assignment.epoch && value.kind === "handover_receive");
  assert.ok(receive);
  yield* supervisor.team.updateNotificationDelivery(binding, binding.threadId, receive.id, "sending", 11, receive.deliveryAttempt);
  yield* supervisor.team.updateNotificationDelivery(binding, binding.threadId, receive.id, "delivered", 12, receive.deliveryAttempt);
  yield* supervisor.team.acknowledgeNotification(binding, reviewHelper.threadId, receive.id, reviewHelper.epoch, 13, receive.deliveryAttempt);
  yield* supervisor.team.completeTransfer(binding, reviewTarget.thread.id, assignment.epoch, 14);
  const reviewCheckin = yield* addPendingHelperCheckin(supervisor, binding, reviewHelper.threadId, "team-review:lost", 15);
  const reviewCoverage = yield* supervisor.team.coverage(binding, reviewTarget.thread.id, parents);
  yield* supervisor.team.recordRequest(binding, {requestId: reviewCheckin.id, memberThreadId: reviewHelper.threadId, memberEpoch: reviewHelper.epoch,
    targets: [{targetThreadId: reviewTarget.thread.id, assignmentRootThreadId: reviewCoverage.assignmentRootThreadId!,
      assignmentEpoch: reviewCoverage.assignmentEpoch!}], parentById: parents, now: 16});

  const readyThread = "helper-readiness-missing";
  const readyProjection = makeSourceProjection(readyThread, binding.projectId, []);
  readyProjection.thread.lineage = {parentThreadId: binding.threadId, relationshipToParent: "subagent", rootThreadId: binding.threadId};
  fixture.projections.set(readyThread, readyProjection);
  const registering = yield* supervisor.team.registerMember(binding, {threadId: readyThread, taskId: `task-${readyThread}`, bootstrapRunId: `run-${readyThread}`, now: 17});
  const readinessCheckin = yield* addPendingHelperCheckin(supervisor, binding, readyThread, "team-ready:lost", 18, "uncertain");
  yield* supervisor.team.markMissing(binding, readyThread, 20);

  fixture.projections.delete(reviewHelper.threadId);
  fixture.projections.delete(readyThread);
  const missing = yield* markRootMissing(fixture, binding);
  const outcome = yield* supervisor.retry(retryInput("project-a", 0, missing, "replace"));

  assert.equal(outcome.status, "saved");
  assert.notEqual((yield* fixture.store.binding("project-a", "source-thread"))?.threadId, binding.threadId);
  for (const checkin of [reviewCheckin, readinessCheckin]) {
    const failed = (yield* supervisor.requests.requests(binding.projectId, checkin.supervisorThreadId)).find(value => value.id === checkin.id);
    assert.equal(failed?.state, "failed");
    assert.match(failed?.error ?? "", /conversation is confirmed missing/u);
  }
  const teamReview = (yield* fixture.query("SELECT document FROM supervisor_team_requests WHERE owner_thread_id=? AND owner_generation=? AND request_id=?",
    binding.threadId, binding.generation, reviewCheckin.id))[0];
  assert.equal(JSON.parse(String(teamReview?.document)).state, "settled");
  assert.equal(fixture.store.ownedIds.has(reviewHelper.threadId), true);
  assert.equal(fixture.store.ownedIds.has(registering.threadId), true);
}));

it.effect("explicit root replacement confirms missing helpers, retires owned webhook jobs, and retains team history", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  const binding = yield* reserveReadyBinding(fixture);
  const supervisor = yield* fixture.makeSupervisor();
  const deletedHelper = yield* registerReadyHelper(fixture, supervisor, binding, "helper-deleted");
  const archivedHelper = yield* registerReadyHelper(fixture, supervisor, binding, "helper-archived");
  fixture.projections.delete(deletedHelper.threadId);
  fixture.projections.get(archivedHelper.threadId)!.thread.archivedAt = baseTime;
  const ownedTasks: Record<string, unknown>[] = [];
  for (const [index, helper] of [deletedHelper, archivedHelper].entries()) {
    const taskId = `owned-helper-webhook-${index}`;
    const createdAt = `2026-10-16T10:0${index}:00.000Z`;
    yield* fixture.execute("INSERT INTO supervisor_helper_channels VALUES(?,?,?,?)",
      binding.threadId, binding.generation, helper.threadId, JSON.stringify({taskId, helperThreadId: helper.threadId, createdAt, state: "ready"}));
    ownedTasks.push({id: taskId, threadId: helper.threadId, projectId: binding.projectId, prompt: "{{body.text}}", schedule: {type: "webhook"}, createdAt});
  }
  fixture.setScheduledTasks(ownedTasks);
  const missing = yield* markRootMissing(fixture, binding);

  const outcome = yield* supervisor.retry(retryInput("project-a", 0, missing, "replace"));

  assert.equal(outcome.status, "saved");
  const current = yield* fixture.store.binding("project-a", "source-thread");
  assert.ok(current);
  assert.notEqual(current.threadId, binding.threadId);
  assert.ok(fixture.store.ownedIds.has(binding.threadId));
  for (const helper of [deletedHelper, archivedHelper]) {
    const memberRow = (yield* fixture.query("SELECT document FROM supervisor_team_members WHERE owner_thread_id=? AND owner_generation=? AND member_thread_id=?",
      binding.threadId, binding.generation, helper.threadId))[0];
    assert.equal(JSON.parse(String(memberRow?.document)).state, "missing");
    assert.ok(fixture.store.ownedIds.has(helper.threadId));
    assert.ok(fixture.operations.some(call => call.tag === "scheduledTasks.delete" && ownedTasks.some(task =>
      task.threadId === helper.threadId && call.payload.id === task.id)));
  }
  assert.equal(fixture.scheduledTasks.length, 0);
  assert.equal((yield* fixture.query("SELECT count(*) AS n FROM supervisor_team_events WHERE owner_thread_id=? AND owner_generation=? AND json_extract(document,'$.kind')='member_missing'",
    binding.threadId, binding.generation))[0]?.n, 2);
}));

it.effect("missing-root replacement refuses a still-present helper without retiring or relabeling it", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  const binding = yield* reserveReadyBinding(fixture);
  const supervisor = yield* fixture.makeSupervisor();
  const helper = yield* registerReadyHelper(fixture, supervisor, binding, "helper-still-present");
  const missing = yield* markRootMissing(fixture, binding);

  const outcome = yield* supervisor.retry(retryInput("project-a", 0, missing, "replace"));

  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.message, /still present in T3/u);
  assert.equal((yield* fixture.store.binding("project-a", "source-thread"))?.threadId, binding.threadId);
  const memberRow = (yield* fixture.query("SELECT document FROM supervisor_team_members WHERE owner_thread_id=? AND owner_generation=? AND member_thread_id=?",
    binding.threadId, binding.generation, helper.threadId))[0];
  assert.equal(JSON.parse(String(memberRow?.document)).state, "ready");
  assert.equal(fixture.operations.some(call => call.tag === "scheduledTasks.delete" || call.tag === "orchestration.launchThread"), false);
}));

it.effect("missing-root replacement fails closed when a known helper lookup is uncertain", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  const binding = yield* reserveReadyBinding(fixture);
  const supervisor = yield* fixture.makeSupervisor();
  const helper = yield* registerReadyHelper(fixture, supervisor, binding, "helper-lookup-unknown");
  const missing = yield* markRootMissing(fixture, binding);
  fixture.setProjectionFailure(helper.threadId, new T3TransportError("projection unavailable", 503));

  const outcome = yield* supervisor.retry(retryInput("project-a", 0, missing, "replace"));

  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.message, /could not verify every registered helper/u);
  assert.equal((yield* fixture.store.binding("project-a", "source-thread"))?.threadId, binding.threadId);
  const memberRow = (yield* fixture.query("SELECT document FROM supervisor_team_members WHERE owner_thread_id=? AND owner_generation=? AND member_thread_id=?",
    binding.threadId, binding.generation, helper.threadId))[0];
  assert.equal(JSON.parse(String(memberRow?.document)).state, "ready");
  assert.equal(fixture.operations.some(call => call.tag === "scheduledTasks.delete" || call.tag === "orchestration.launchThread"), false);
}));

it.effect("missing-root replacement preserves and remains blocked by an uncertain helper effect", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "source-thread", projectId: "project-a", turns: []}]);
  const binding = yield* reserveReadyBinding(fixture);
  const supervisor = yield* fixture.makeSupervisor();
  const helper = yield* registerReadyHelper(fixture, supervisor, binding, "helper-uncertain-effect");
  const target = makeSourceProjection("operational-thread", binding.projectId, []);
  target.thread.lineage = {parentThreadId: binding.mainThreadId, relationshipToParent: "subagent", rootThreadId: binding.mainThreadId};
  fixture.projections.set(target.thread.id, target);
  const parents = new Map<string, string | null>([[binding.mainThreadId, null], [target.thread.id, binding.mainThreadId]]);
  const assignment = yield* supervisor.team.assign(binding, target.thread.id, helper.threadId, parents);
  const receive = (yield* supervisor.team.snapshot(binding)).notifications.find(value => value.assignmentRootThreadId === target.thread.id &&
    value.assignmentEpoch === assignment.epoch && value.kind === "handover_receive");
  assert.ok(receive);
  yield* supervisor.team.updateNotificationDelivery(binding, binding.threadId, receive.id, "sending");
  yield* supervisor.team.updateNotificationDelivery(binding, binding.threadId, receive.id, "delivered");
  yield* supervisor.team.acknowledgeNotification(binding, helper.threadId, receive.id, helper.epoch);
  yield* supervisor.team.completeTransfer(binding, target.thread.id, assignment.epoch);
  const coverage = yield* supervisor.team.coverage(binding, target.thread.id, parents);
  const request = yield* supervisor.team.recordRequest(binding, {requestId: "guide:unknown-result", memberThreadId: helper.threadId, memberEpoch: helper.epoch,
    targets: [{targetThreadId: target.thread.id, assignmentRootThreadId: coverage.assignmentRootThreadId!, assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents});
  const checkin = yield* addPendingHelperCheckin(supervisor, binding, helper.threadId, "team-review:effect-checkin", 10, "uncertain");
  yield* supervisor.team.recordRequest(binding, {requestId: checkin.id, memberThreadId: helper.threadId, memberEpoch: helper.epoch,
    targets: [{targetThreadId: target.thread.id, assignmentRootThreadId: coverage.assignmentRootThreadId!, assignmentEpoch: coverage.assignmentEpoch!}], parentById: parents, now: 11});
  yield* supervisor.team.setRequestState(binding, helper.threadId, request.requestId, helper.epoch, "uncertain");
  const missing = yield* markRootMissing(fixture, binding);
  fixture.projections.delete(helper.threadId);

  const outcome = yield* supervisor.retry(retryInput("project-a", 0, missing, "replace"));

  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.message, /unresolved handover state or native effects/u);
  assert.equal((yield* fixture.store.binding("project-a", "source-thread"))?.threadId, binding.threadId);
  assert.equal(fixture.store.ownedIds.has(helper.threadId), true);
  const memberRow = (yield* fixture.query("SELECT document FROM supervisor_team_members WHERE owner_thread_id=? AND owner_generation=? AND member_thread_id=?",
    binding.threadId, binding.generation, helper.threadId))[0];
  assert.equal(JSON.parse(String(memberRow?.document)).state, "missing");
  const requestRow = (yield* fixture.query("SELECT document FROM supervisor_team_requests WHERE owner_thread_id=? AND owner_generation=? AND request_id=?",
    binding.threadId, binding.generation, request.requestId))[0];
  assert.equal(JSON.parse(String(requestRow?.document)).state, "uncertain");
  const checkinTeamRequest = (yield* fixture.query("SELECT document FROM supervisor_team_requests WHERE owner_thread_id=? AND owner_generation=? AND request_id=?",
    binding.threadId, binding.generation, checkin.id))[0];
  assert.equal(JSON.parse(String(checkinTeamRequest?.document)).state, "settled");
  assert.equal((yield* supervisor.requests.requests(binding.projectId, helper.threadId)).find(value => value.id === checkin.id)?.state, "failed");
  assert.equal(fixture.operations.some(call => call.tag === "orchestration.launchThread"), false);
}));

it.effect("a stale retry intent cannot replace a missing binding; explicit replacement retains old ownership", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const original = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  const originalTask = yield* fixture.store.task("source-thread");
  assert.ok(original && originalTask);
  fixture.projections.delete(original.threadId);
  yield* supervisor.runOnce;
  const missing = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.equal(missing?.state, "missing");

  const staleRetry = yield* supervisor.retry(retryInput("project-a", 0, original, "retry"));
  assert.equal(staleRetry.status, "conflict");
  assert.equal(((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null)?.threadId, original.threadId);
  assert.equal(fixture.store.ownedIds.size, 1);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);

  const replacement = yield* supervisor.retry(retryInput("project-a", 0, missing!, "replace"));
  assert.equal(replacement.status, "saved");
  const current = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(current);
  assert.notEqual(current.threadId, original.threadId);
  assert.equal(fixture.store.ownedIds.size, 2);
  assert.equal(fixture.store.ownedIds.has(original.threadId), true);
  assert.equal(fixture.store.ownedIds.has(current.threadId), true);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 2);
  const retained = yield* fixture.store.task("source-thread");
  assert.equal(retained?.status, "unavailable");
  assert.equal(retained?.id, originalTask.id);
  assert.equal(retained?.messageId, originalTask.messageId);
}));

it.effect("a changed source invalidates a completed Supervisor result without an operational reply", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Deploy the release" }] },
  ]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const task = yield* fixture.store.task("source-thread");
  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(task && binding);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  assert.equal((yield* supervisor.submit(task, taskFields(task, "Deploy the release", "The source request asks for a deployment."))).status, "submitted");
  completeSupervisorRequest(supervisorProjection, task.messageId, "Submitted the interpretation.");

  const sourceProjection = fixture.projections.get("source-thread");
  assert.ok(sourceProjection);
  sourceProjection.messages[0]!.text = "Actually, do not deploy anything";
  yield* supervisor.runOnce;
  const stale = yield* fixture.store.task("source-thread");
  assert.equal(stale?.status, "unavailable");
  assert.equal(stale?.objective, null);
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 1);
  assert.equal(fixture.operations.some((call) => ["runtime-request.respond", "thread.interrupt"].includes(String(call.payload.type))), false);
}));

it.effect("a completed interpretation with unrelated source IDs is rejected", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a release checklist" }] },
  ]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const task = yield* fixture.store.task("source-thread");
  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(task && binding);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  const unrelated = yield* supervisor.submit(task, taskFields(task, "Publish a release", "This response cites another message.",
    {sourceMessageIds: ["unrelated-message"]}));
  assert.equal(unrelated.status, "invalid");
  // the run's final answer, even well-formed final-chat json, is never read
  completeSupervisorRequest(supervisorProjection, task.messageId, workflowResult(task.sourceMessageId, "Publish a release", "This response cites the source."));

  yield* supervisor.runOnce;
  const rejected = yield* fixture.store.task("source-thread");
  assert.equal(rejected?.status, "unavailable");
  assert.equal(rejected?.objective, null);
  assert.match(rejected?.reason ?? "", /valid, source-linked interpretation/u);
}));

it.effect("interrupted and stalled Supervisor runs become unavailable without answers or interruption commands", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "first-task", sequence: 11, text: "Review the release" }] },
  ]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  const first = yield* fixture.store.task("source-thread");
  assert.ok(binding && first);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  const firstRun = supervisorProjection.runs.find((run) => run.userMessageId === first.messageId);
  assert.ok(firstRun);
  firstRun.status = "interrupted";
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "unavailable");

  fixture.addTurn("source-thread", "project-a", { id: "second-task", sequence: 12, text: "Check the rollout plan" });
  yield* supervisor.runOnce;
  const second = yield* fixture.store.task("source-thread");
  assert.equal(second?.status, "waiting");
  assert.ok(second);
  const secondRun = supervisorProjection.runs.find((run) => run.userMessageId === second.messageId);
  assert.ok(secondRun);
  secondRun.status = "waiting";
  secondRun.startedAt = new Date(fixture.now() - 301_000).toISOString();
  yield* fixture.store.saveTask({ ...second, dispatchedAt: fixture.now() - 301_000 });
  yield* supervisor.runOnce;

  assert.equal((yield* fixture.store.task("source-thread"))?.status, "unavailable");
  assert.match((yield* fixture.store.task("source-thread"))?.reason ?? "", /does not answer or interrupt/u);
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 2);
  assert.equal(fixture.operations.some((call) => ["runtime-request.respond", "thread.interrupt", "runtime-request.interrupt"].includes(String(call.payload.type))), false);
  assert.equal(fixture.projections.get("source-thread")?.messages.length, 2);
}));

it.effect("queued and not-yet-started Supervisor runs do not time out from stale dispatch time", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "first-task", sequence: 11, text: "Review the release" }] },
  ]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null);
  const task = yield* fixture.store.task("source-thread");
  assert.ok(binding && task);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  const run = supervisorProjection.runs.find((candidate) => candidate.userMessageId === task.messageId);
  assert.ok(run);

  yield* fixture.store.saveTask({ ...task, dispatchedAt: fixture.now() - 301_000 });
  run.status = "queued";
  run.startedAt = null;
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "waiting");

  run.status = "running";
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "waiting");

  run.startedAt = new Date(fixture.now() - 301_000).toISOString();
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("source-thread"))?.status, "unavailable");
}));

it.effect("agreement snapshots preserve mixed plans through restart and mark replaced ownership stale", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "agreement-source", projectId: "project-a", turns: [{id: "agreement-task", sequence: 11, text: "Add CSV export"}]}]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const task = (yield* fixture.store.task("agreement-source"))!;
  const workflow = workflowSnapshot();
  const agreement = {status: "agreed" as const, message: "Both conversations confirmed the plan", proposalId: "csv-1", agreedAt: Date.now(),
    evidence: {kind: "supervisor_message" as const, messageId: "supervisor-proof"}, agentMessageId: "operative-proof", workflow};
  const diagnostic = {role: "operative" as const, proposalId: "csv-2", messageId: "compact-acceptance", code: "record_fields", observedAt: Date.now()};
  yield* fixture.store.saveTask({...task, status: "inferred", objective: "Add CSV export", workflow, workflowProposalId: "csv-2", agreement,
    workflowProtocolDiagnostic: diagnostic});
  yield* fixture.restart;
  const restored = yield* fixture.makeSupervisor();
  const snapshot = Schema.decodeUnknownSync(ProjectSupervisorSnapshot)(yield* restored.snapshot("project-a", "agreement-source"));
  assert.equal(snapshot.tasks[0]?.workflowProposalId, "csv-2");
  assert.deepEqual(snapshot.tasks[0]?.agreement, agreement);
  assert.deepEqual(snapshot.tasks[0]?.workflowProtocolDiagnostic, diagnostic);
  assert.equal(snapshot.tasks[0]?.workflow?.plan?.nodes[0]?.kind, "step");
  if (snapshot.tasks[0]?.workflow?.plan?.nodes[0]?.kind === "step") assert.equal(snapshot.tasks[0].workflow?.plan?.nodes[0]?.localId, "csv-export");
  const binding = ((yield* fixture.store.bindings()).find(binding => binding.projectId === "project-a") ?? null)!;
  yield* fixture.store.setBinding({...binding, state: "missing", deliveredRoleVersion: "delivered-to-old-root"});
  const replaced = yield* fixture.store.replaceMissingBinding({...binding, state: "missing", deliveredRoleVersion: "delivered-to-old-root"}, defaultSupervisorModel);
  assert.equal(replaced.deliveredRoleVersion, undefined, "a replacement conversation receives the full standing instructions again");
  const stale = (yield* fixture.store.task("agreement-source"))?.agreement;
  assert.equal(stale?.status, "stale");
  assert.deepEqual(stale?.evidence, {kind: "supervisor_message", messageId: "supervisor-proof"});
  assert.deepEqual(stale?.workflow, workflow);
}));

it.effect("task payload expiry clears retained agreement plans and current proposal identity", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "expiry-source", projectId: "project-a", turns: [{id: "expiry-task", sequence: 11, text: "Add CSV export"}]}]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const task = (yield* fixture.store.task("expiry-source"))!;
  const workflow = workflowSnapshot(false);
  yield* fixture.store.saveTask({...task, status: "inferred", workflow, workflowProposalId: "csv-1", updatedAt: 1,
    agreement: {status: "agreed", message: "Accepted", proposalId: "csv-1", agreedAt: 1, evidence: {kind: "supervisor_message", messageId: "supervisor-proof"}, agentMessageId: "operative-proof", workflow}});
  yield* fixture.store.prune(32 * day);
  assert.equal((yield* fixture.store.task("expiry-source"))?.agreement?.status, "agreed", "a retained ready scope survives long idle periods");
  const binding = (yield* fixture.store.binding("project-a", "expiry-source"))!;
  yield* fixture.store.setBinding({...binding, state: "missing"});
  yield* fixture.store.prune(32 * day);
  const expired = yield* fixture.store.task("expiry-source");
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.agreement, null);
  assert.equal(expired?.workflow, null);
  assert.equal(expired?.workflowProposalId, undefined);
}));

it.effect("explicit editor authorization binds exact complete definition contents and workspace", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([]);
  const source = makeDefinitionFixture({projectId: "project-a", root: "/work/a", threadRoot: "/work/a"});
  source.addFile("/work/a", ".t3-supervisor/steps/verify.md", stepSource("verify", "Check the changed behavior."));
  source.addDirectory("/work/a", ".t3-supervisor/workflows");
  source.writeIndex("/work/a", {required: [{step: "verify"}]});
  const definitions = yield* source.makeDefinitions();
  const approved = yield* definitions.load("project-a", "thread");
  assert.equal(approved.status, "ready");
  assert.ok(approved.projectConfig);
  const changedConfig = {...approved, revision: "edited-revision", projectConfig: projectIndex({steps: ["verify"]}), config: effectiveIndex(approved)};
  yield* fixture.store.recordDefinitionUserSave(changedConfig, approved.revision!);
  assert.equal(yield* fixture.store.definitionUserSave({...changedConfig, threadId: "operative", revision: "bound-revision"}, approved, 0), true);
  assert.equal(yield* fixture.store.definitionUserSave({...changedConfig, workspaceRoot: "/work/other"}, approved, 0), false);
  assert.equal(yield* fixture.store.definitionUserSave({...changedConfig, status: "invalid"}, approved, 0), false);
  const editedStep = {...changedConfig, steps: changedConfig.steps.map(step => ({...step, description: "Skip all checks."}))};
  assert.equal(yield* fixture.store.definitionUserSave(editedStep, approved, 0), false);
  const editedSummary = {...changedConfig, projectConfig: {...changedConfig.projectConfig, steps: changedConfig.projectConfig.steps.map(entry => ({...entry, summary: "Skip all checks."}))}};
  assert.equal(yield* fixture.store.definitionUserSave(editedSummary, approved, 0), false, "the signed index covers summaries");
  assert.equal(yield* fixture.store.definitionUserSave(changedConfig, approved, Date.now() + 1000), false);
  yield* fixture.store.recordDefinitionUserSave(approved, approved.revision!);
  yield* fixture.restart;
  assert.equal(yield* fixture.store.definitionUserSave(approved, approved, 0), true);
}));

it.effect("parallel main worktrees retain distinct ownership and scoped recovery through restart", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "tree-a", projectId: "project-a", turns: [{id: "a-task", sequence: 11, text: "Implement in tree A"}]},
    {threadId: "tree-b", projectId: "project-a", turns: [{id: "b-task", sequence: 12, text: "Implement in tree B"}]}]);
  fixture.projections.get("tree-a")!.thread.worktreePath = "/work/a/tree-a";
  fixture.projections.get("tree-b")!.thread.worktreePath = "/work/a/tree-b";
  // the two mains dispatch concurrently: only tree A's interpretation request loses its response
  fixture.setUnknownDispatchMatching((payload) => String(payload.text).includes("Implement in tree A"));
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const a = (yield* fixture.store.binding("project-a", "tree-a"))!;
  const b = (yield* fixture.store.binding("project-a", "tree-b"))!;
  assert.notEqual(a.threadId, b.threadId);
  assert.equal((yield* fixture.store.task("tree-a"))?.status, "uncertain");
  assert.equal((yield* fixture.store.task("tree-b"))?.status, "waiting");
  const bTask = (yield* fixture.store.task("tree-b"))!;
  yield* fixture.restart;
  const restored = yield* fixture.makeSupervisor();
  const mismatch = yield* restored.retry({...retryInput("project-a", 0, a, "retry"), mainThreadId: "tree-b"});
  assert.equal(mismatch.status, "conflict");
  assert.deepEqual(yield* fixture.store.task("tree-b"), bTask);
  assert.equal((yield* restored.snapshot("project-a", "tree-b")).binding?.threadId, b.threadId);
  assert.equal((yield* restored.snapshot("project-a", "tree-a")).tasks[0]?.threadId, "tree-a");
  assert.ok(fixture.operations.filter(call => call.tag === "orchestration.launchThread").every(call => (call.payload.workspaceStrategy as {type: string}).type === "root"));
}));

it.effect("a native keep-active choice does not restore stale binding creation state", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "pinned-source", projectId: "project-a", turns: [{id: "pin-task", sequence: 11, text: "Implement a task"}]}]);
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  const binding = (yield* fixture.store.binding("project-a", "pinned-source"))!;
  yield* fixture.store.setBinding({...binding, state: "uncertain"});
  fixture.projections.get(binding.threadId)!.thread.settledOverride = "active";
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.binding("project-a", "pinned-source"))?.state, "ready");
  assert.equal((yield* fixture.store.binding("project-a", "pinned-source"))?.manualKeepActive, true);
}));

it.effect("an independent fork remains eligible when its old parent is absent from the active catalog", () => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "fork-main", projectId: "project-a", turns: [{id: "fork-task", sequence: 11, text: "Implement separately"}]}]);
  fixture.projections.get("fork-main")!.thread.lineage = {parentThreadId: "archived-parent", relationshipToParent: "fork", rootThreadId: "historical-root"};
  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("fork-main"))?.status, "waiting");
  assert.ok(yield* fixture.store.binding("project-a", "fork-main"));
}));

it.effect("repeated short passes rotate past a hung Supervisor and keep later mains progressing", () => Effect.gen(function* () {
  const initial = Array.from({length: 9}, (_, index) => ({threadId: `main-${index}`, projectId: "project-a", turns: [{id: `old-${index}`, sequence: 9, text: "Old task"}]}));
  const fixture = yield* makeFixture(initial);
  const ids = new Map<string, string>();
  const touched = new Set<string>();
  for (const item of initial) {
    const reserved = yield* fixture.store.reserve("project-a", item.threadId, item.threadId, defaultSupervisorModel, 10, fixture.now());
    const binding = {...reserved, state: "ready" as const};
    yield* fixture.store.setBinding(binding);
    ids.set(binding.threadId, item.threadId);
    fixture.projections.set(binding.threadId, emptySupervisorProjection(binding.threadId, "project-a", defaultSupervisorModel));
  }
  const supervisor = yield* fixture.makeSupervisor();
  // the hung read suspends the pass; sibling batch work finishes on the node loop, then the pass is interrupted. twelve passes stay the bound.
  for (let attempt = 0; attempt < 12 && touched.size < 9; attempt++) {
    const hung = yield* Deferred.make<void>();
    fixture.setHoldReads((id) => {
      const main = ids.get(id);
      if (main === undefined) return null;
      touched.add(main);
      if (main !== "main-0") return null;
      return Effect.andThen(Effect.uninterruptible(Effect.ignore(Deferred.succeed(hung, undefined))), Effect.never);
    });
    yield* interruptHungPass(supervisor.cycle, hung, () => touched.size);
  }
  fixture.setHoldReads(null);
  assert.equal(touched.size, 9, "the same slow first binding must not permanently hide tail mains");
}));

// real loopback socket so the production t3 client's buffered reader sees a body larger than its retained budget
it.live("a main conversation over the buffered cap is discovered and interpreted from its exact old source", () => Effect.gen(function* () {
  const turns: Turn[] = [{ id: "before-activation", sequence: 5, text: "Earlier unrelated request" },
    { id: "old-task", sequence: 11, text: "Build the invoice export" },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `later-${index}`, sequence: 12 + index, text: `Follow-up request ${index}` }))];
  const fixture = yield* makeFixture([{ threadId: "huge-main", projectId: "project-a", turns }]);
  const retainedBudget = 96 * 1024;
  const padding = Array.from({ length: 300 }, (_, index) => ({ position: index, visibility: "local", sourceThreadId: "huge-main",
    sourceItemId: `row-${index}`, item: { id: `row-${index}`, text: "p".repeat(1000) } }));
  let largestBody = 0;
  const server = createServer((request, response) => {
    const id = decodeURIComponent((request.url ?? "").replace("/api/orchestration/threads/", ""));
    const projection = fixture.projections.get(id);
    if (!projection) {response.writeHead(404).end();return;}
    const body = JSON.stringify({ snapshotSequence: 20, projection: { ...projection, visibleTurnItems: padding, checkpoints: padding.slice(0, 40) } });
    largestBody = Math.max(largestBody, Buffer.byteLength(body));
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => { server.listen(0, "127.0.0.1", () => resume(Effect.void)); }),
    () => Effect.callback<void>((resume) => { server.close(() => resume(Effect.void)); }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const context = yield* Layer.build(makeT3Client({ baseUrl: `http://127.0.0.1:${address.port}`, token: "test-token", maxResponseBytes: retainedBudget }));
  const client = Context.get(context, T3Client);
  fixture.useNativeProjection((threadId) => client.projection(threadId));

  const supervisor = yield* fixture.makeSupervisor();
  yield* supervisor.runOnce;
  assert.ok(largestBody > 2 * retainedBudget, "the native body exceeds what the buffered reader accepts");
  const task = yield* fixture.store.task("huge-main");
  assert.equal(task?.sourceMessageId, "old-task", "the first request after activation stays the source behind twelve newer turns");
  assert.equal(task?.sourceRunId, "run-old-task");
  assert.equal(task?.status, "waiting");
  const binding = (yield* fixture.store.bindings()).find(value => value.mainThreadId === "huge-main");
  assert.ok(binding);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  assert.equal((yield* supervisor.submit(task, taskFields(task, "Build the invoice export",
    "The source request asks for an export to be built."))).status, "submitted");
  completeSupervisorRequest(supervisorProjection, task.messageId, "Submitted the interpretation.");
  yield* supervisor.runOnce;
  assert.equal((yield* fixture.store.task("huge-main"))?.status, "inferred");
  assert.equal((yield* fixture.store.task("huge-main"))?.objective, "Build the invoice export");
}), { timeout: 60_000 });

it.effect("No Project defaults to On request and shared definitions never activate a chat", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  assert.equal((yield* f.supervisor.noProjectControl()).mode, "on_request");
  yield* f.fixture.store.saveGlobalDefinitionsControl(0, true);
  yield* f.supervisor.runOnce;
  assert.equal(f.fixture.operations.length, 0);
  assert.equal((yield* f.fixture.store.bindings()).length, 0);
  assert.equal(yield* f.supervisor.scopeEnabled("project-a", "manual"), false);
  assert.equal(yield* f.supervisor.scopeEnabled("project-b", "ordinary"), true);
}));

it.effect("native Start runs one intent interpretation, grants only that chat and survives restart", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  const args = {callerThreadId: "manual", userMessageId: "request-start", operationId: "own-start"};
  const result = yield* f.supervisor.startSupervision(args, {runId: "run-request-start"});
  assert.equal(result.status, "pending");
  yield* f.supervisor.runOnce;
  const task = (yield* f.fixture.store.task("manual"))!;
  assert.ok(task);
  assert.equal(yield* f.supervisor.scopeEnabled("project-a", "manual"), false);
  assert.equal(yield* f.supervisor.workflowEditingEnabled("project-a", "manual"), false);
  assert.match(task.requestText, /startRequested/);
  assert.equal(f.fixture.operations.filter(op => op.payload.type === "message.dispatch").length, 1);
  const root = f.fixture.projections.get(task.supervisorThreadId)!;
  assert.equal((yield* f.supervisor.submit(task, {objective: null, reason: "User requested supervision; awaiting a substantive task.", sourceMessageIds: [args.userMessageId],
    supervision: "needed", startRequested: true, workflow: null})).status, "submitted");
  assert.equal((yield* f.fixture.store.start("manual"))?.status, "pending", "recording never activates a Start");
  completeSupervisorRequest(root, task.messageId, "Submitted the Start verdict.");
  yield* f.supervisor.runOnce;
  assert.equal((yield* f.fixture.store.start("manual"))?.status, "active", JSON.stringify({start: yield* f.fixture.store.start("manual"), task: yield* f.fixture.store.task("manual")}));
  assert.equal(yield* f.supervisor.scopeEnabled("project-a", "manual"), true);
  assert.equal(yield* f.supervisor.scopeEnabled("project-a", "other"), false);
  assert.equal((yield* f.fixture.store.task("manual"))?.status, "needs_context");
  const originalTask = task.id;
  yield* f.supervisor.runOnce;
  assert.equal((yield* f.fixture.store.task("manual"))?.id, originalTask);
  yield* f.fixture.restart;
  const resumed = yield* f.fixture.makeSupervisor();
  yield* resumed.runOnce;
  assert.equal(yield* resumed.scopeEnabled("project-a", "manual"), true);
  assert.equal(yield* resumed.scopeEnabled("project-a", "other"), false);
}));

it.effect("negative Start intent and later Stop fence interpretation without operative contact", () => Effect.gen(function* () {
  for (const outcome of ["negative", "stop", "mode", "edited"] as const) {
    const f = yield* noProjectFixture();
    const args = {callerThreadId: "manual", userMessageId: "request-start", operationId: "start"};
    yield* f.supervisor.startSupervision(args, {runId: "run-request-start"});
    yield* f.supervisor.runOnce;
    const task = (yield* f.fixture.store.task("manual"))!;
    if (outcome === "stop") yield* f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: (yield* f.policy.get()).generation, enabled: false});
    if (outcome === "mode") yield* f.supervisor.saveNoProjectControl({expectedGeneration: 0, mode: "off"});
    if (outcome === "edited") f.fixture.projections.get("manual")!.messages[0]!.text = "Changed request";
    yield* f.supervisor.submit(task, {objective: null, reason: "No task", sourceMessageIds: [args.userMessageId], supervision: "needed",
      startRequested: outcome !== "negative", workflow: null});
    completeSupervisorRequest(f.fixture.projections.get(task.supervisorThreadId)!, task.messageId, "Submitted the Start verdict.");
    yield* f.supervisor.runOnce;
    assert.equal(yield* f.supervisor.scopeEnabled("project-a", "manual"), false, outcome);
    assert.equal(f.fixture.operations.filter(op => op.payload.threadId === "manual").length, 0, outcome);
  }
}), { timeout: 60_000 });

it.effect("dashboard Start grants next-request permission when current work is already finished", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  assert.equal((yield* f.supervisor.dashboardStart("manual", "dashboard")).status, "active");
  yield* f.supervisor.runOnce;
  assert.equal(yield* f.fixture.store.task("manual"), null);
  assert.equal(f.fixture.operations.length, 0);
  assert.equal((yield* f.supervisor.dashboardStart("manual", "dashboard")).status, "active");
  assert.equal((yield* f.fixture.store.start("manual"))?.taskId, null);
  const off = yield* f.supervisor.saveNoProjectControl({expectedGeneration: 0, mode: "off"});
  assert.equal(off.status, "saved");
  assert.equal(yield* f.supervisor.scopeEnabled("project-a", "manual"), false);
  yield* f.supervisor.saveNoProjectControl({expectedGeneration: 1, mode: "on_request"});
  assert.equal(yield* f.supervisor.scopeEnabled("project-a", "manual"), true);
}));

it.effect("Start intake requires exact native own-run proof before reserving permission", () => Effect.gen(function* () {
  for (const variant of ["direct", "mcpx", "forged", "foreign", "rollback", "wrong_tool"] as const) {
    const f = yield* noProjectFixture();
    const args = {callerThreadId: "manual", userMessageId: "request-start", operationId: "native-start"};
    const caller = f.fixture.projections.get("manual")!;
    const run = caller.runs[0]!;
    if (variant === "rollback") run.status = "rolled_back";
    const nodeId = "native-start-node";
    (caller.nodes as Array<Record<string, unknown>>).push({id: nodeId, kind: "dynamic_tool", threadId: "manual", runId: run.id, rootNodeId: run.rootNodeId, parentNodeId: run.rootNodeId, providerThreadId: run.providerThreadId, status: "completed"});
    const item = {id: "native-start-item", type: "dynamic_tool", threadId: variant === "foreign" ? "other" : "manual", runId: run.id, nodeId, providerThreadId: run.providerThreadId,
      nativeItemRef: {driver: "codex", nativeId: "native-start-item", strength: "strong"}, parentItemId: null, ordinal: 2, status: "completed", toolNonExecutionKind: null,
      toolName: variant === "mcpx" ? "mcp__mcpx__mcpx_call_tool" : variant === "wrong_tool" ? "mcp__t3-supervisor-workflows__supervision_stop" : "mcp__t3-supervisor-workflows__supervision_start",
      input: variant === "mcpx" ? {name: "t3-supervisor-workflows__supervision_start", arguments: args} : variant === "forged" ? {...args, operationId: "other"} : args};
    caller.turnItems = [item];
    const controller = yield* startIntake(f.supervisor, {
      listThreads: () => Effect.succeed([caller.thread]),
      projection: () => Effect.succeed(caller),
      getTurnItem: () => Effect.succeed({item}),
    });
    const result = yield* controller.startSupervision(args);
    assert.equal(result.status === "pending" && (yield* f.fixture.store.start("manual")) !== null, variant === "direct" || variant === "mcpx", variant);
    assert.equal(f.fixture.operations.length, 0, "intake alone never calls a model or operative");
  }
}), { timeout: 60_000 });

it.effect("Start rejects nonhuman, wrong-turn, project and stale sources, and keeps duplicate operation identity", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  const args = {callerThreadId: "manual", userMessageId: "request-start", operationId: "identity"};
  assert.equal((yield* f.supervisor.startSupervision(args, {runId: "other-run"})).status, "denied");
  const human = f.fixture.projections.get("manual")!.messages[0]!;
  human.creationSource = "mcp";
  args.operationId = "nonhuman";
  assert.equal((yield* f.supervisor.startSupervision(args, {runId: "run-request-start"})).status, "denied");
  human.creationSource = "web";
  args.operationId = "stale";
  yield* f.fixture.store.saveUnboundStop("manual", {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: Date.now()});
  assert.equal((yield* f.supervisor.startSupervision(args, {runId: "run-request-start"})).status, "denied");
  yield* f.fixture.store.saveUnboundStop("manual", null);
  args.operationId = "positive";
  assert.equal((yield* f.supervisor.startSupervision(args, {runId: "run-request-start"})).status, "pending");
  const id = (yield* f.fixture.store.start("manual"))!.taskId;
  assert.equal((yield* f.supervisor.startSupervision(args, {runId: "run-request-start"})).status, "pending");
  assert.equal((yield* f.fixture.store.start("manual"))!.taskId, id);
}));

it.effect("Retry reaches a started No Project chat and still reconciles Stop notice/settlement in ordinary projects", () => Effect.gen(function* () {
  for (const noProject of [false, true]) {
    const f = yield* noProjectFixture();
    if (!noProject) yield* f.fixture.execute("UPDATE classifications SET classification='project' WHERE project_id='project-a'");
    else yield* f.supervisor.dashboardStart("manual", "recovery-grant");
    const binding = yield* reserveReadyBinding(f.fixture, "manual");
    const first = yield* f.supervisor.retry(retryInput("project-a", 0, binding, "retry"));
    assert.notEqual(first.status, "unavailable", noProject ? "started No Project recovery is reachable" : "ordinary recovery works");
    yield* f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: (yield* f.policy.get()).generation, enabled: false});
    const stopped = (yield* f.fixture.store.binding("project-a", "manual"))!;
    assert.ok(stopped.stopNotice);
    yield* f.fixture.store.setStopNotice(stopped, stopped.stopNotice.messageId, {...stopped.stopNotice, state: "unconfirmed"});
    yield* f.fixture.store.setBinding({...stopped, settlement: {commandId: "uncertain-settle", state: "uncertain", attempts: 3, observedAt: 1}});
    const before = f.fixture.operations.length;
    const result = yield* f.supervisor.retry(retryInput("project-a", 0, stopped, "retry"));
    assert.notEqual(result.status, "unavailable", JSON.stringify({noProject, result}));
    const retried = (yield* f.fixture.store.binding("project-a", "manual"))!;
    assert.equal(retried.stopNotice?.state, "uncertain");
    assert.equal(retried.stopNotice?.messageId, stopped.stopNotice.messageId);
    assert.equal(retried.settlement?.attempts, 0);
    assert.equal(retried.settlement?.commandId, "uncertain-settle");
    assert.equal(f.fixture.operations.length, before, "recovery rearms reconciliation without posting new work");
  }
}));

it.effect("an inactive rejected Start parks its root without a human Stop or losing source history", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  yield* f.supervisor.startSupervision({callerThreadId: "manual", userMessageId: "request-start", operationId: "reject-and-park"}, {runId: "run-request-start"});
  yield* f.supervisor.runOnce;
  const task = (yield* f.fixture.store.task("manual"))!;
  assert.equal((yield* f.supervisor.submit(task, {objective: null, reason: "No Start intent", sourceMessageIds: [task.sourceMessageId], supervision: "needed",
    startRequested: false, workflow: null})).status, "submitted");
  completeSupervisorRequest(f.fixture.projections.get(task.supervisorThreadId)!, task.messageId, "Submitted the Start verdict.");
  yield* f.supervisor.runOnce;
  yield* f.supervisor.runOnce;
  const binding = (yield* f.fixture.store.binding("project-a", "manual"))!;
  assert.equal(binding.settlement?.state, "settled");
  assert.equal(binding.supervisionStop, undefined);
  assert.equal(binding.stopObservedAt, undefined);
  assert.equal((yield* f.policy.get()).excludedThreadIds.length, 0);
  assert.equal((yield* f.fixture.store.task("manual"))?.sourceMessageId, task.sourceMessageId);
  assert.equal(f.fixture.operations.filter(op => op.payload.threadId === "manual").length, 0);
}));

it.effect("a Stop before any root exists still exposes its original caller/source/time without creating a conversation", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  f.fixture.addTurn("manual", "project-a", {id: "stop-without-root", sequence: 21, text: "Stop supervision for this chat."});
  const message = f.fixture.projections.get("manual")!.messages.at(-1)!;
  message.createdAt = new Date().toISOString();
  const result = yield* f.supervisor.stopSupervision({callerThreadId: "manual", targetThreadId: "manual", userMessageId: message.id, operationId: "unbound-stop"}, {runId: message.runId});
  assert.equal(result.status, "stopped");
  const snapshot = yield* f.supervisor.snapshot("project-a", "manual");
  assert.equal(snapshot.binding, null);
  assert.equal(snapshot.chatSupervision?.stopped, true);
  assert.equal(snapshot.chatSupervision?.stoppedCallerThreadId, "manual");
  assert.equal(snapshot.chatSupervision?.stoppedUserMessageId, message.id);
  assert.equal(snapshot.chatSupervision?.stoppedAt, Date.parse(message.createdAt));
  assert.equal(f.fixture.operations.length, 0);
}));

it.effect("a later human task survives repeated discovery and restart without recreating the Start interpretation", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  yield* f.supervisor.startSupervision({callerThreadId: "manual", userMessageId: "request-start", operationId: "start-handoff"}, {runId: "run-request-start"});
  yield* f.supervisor.runOnce;
  const initial = (yield* f.fixture.store.task("manual"))!;
  assert.equal((yield* f.supervisor.submit(initial, {startRequested: true, objective: null, reason: "User requested supervision", sourceMessageIds: [initial.sourceMessageId],
    supervision: "needed", workflow: null})).status, "submitted");
  completeSupervisorRequest(f.fixture.projections.get(initial.supervisorThreadId)!, initial.messageId, "Submitted the Start verdict.");
  yield* f.supervisor.runOnce;
  yield* f.fixture.restart;
  const resumed = yield* f.fixture.makeSupervisor();
  f.fixture.addTurn("manual", "project-a", {id: "later-greeting", sequence: 21, text: "Reply with a greeting."});
  f.fixture.projections.get("manual")!.messages.at(-1)!.createdAt = new Date(f.fixture.now() + 1000).toISOString();
  yield* resumed.runOnce;
  const next = (yield* f.fixture.store.task("manual"))!;
  assert.notEqual(next.id, initial.id);
  assert.equal(next.sourceMessageId, "later-greeting");
  yield* resumed.runOnce;
  assert.equal((yield* f.fixture.store.task("manual"))?.id, next.id);
  assert.equal((yield* resumed.submit(next, {objective: "Reply with a greeting", reason: "Self-contained greeting", sourceMessageIds: [next.sourceMessageId],
    supervision: "not_needed", workflow: null})).status, "submitted");
  completeSupervisorRequest(f.fixture.projections.get(next.supervisorThreadId)!, next.messageId, "Submitted the interpretation.");
  yield* resumed.runOnce;
  yield* resumed.runOnce;
  assert.equal((yield* f.fixture.store.task("manual"))?.id, next.id);
  assert.equal((yield* f.fixture.store.task("manual"))?.status, "not_supervised");
  assert.equal(f.fixture.operations.filter(op => op.payload.type === "message.dispatch" && op.payload.threadId === initial.supervisorThreadId).length, 2);
  assert.equal(yield* resumed.scopeEnabled("project-a", "manual"), true);
}));

it.effect("Off pauses an active No Project permission without Stop-style fencing of prepared team/context work", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  yield* f.supervisor.dashboardStart("manual", "pause-grant");
  const binding = yield* reserveReadyBinding(f.fixture, "manual");
  const prepared = yield* f.supervisor.requests.prepare({id: "prepared-before-off", projectId: binding.projectId, supervisorThreadId: binding.threadId,
    kind: "review", taskId: null, text: "A retained review", batch: null, completionMarker: "retained-review-complete"}, Date.now());
  yield* f.supervisor.saveNoProjectControl({expectedGeneration: 0, mode: "off"});
  yield* f.supervisor.runOnce;
  assert.deepEqual((yield* f.supervisor.requests.requests(binding.projectId, binding.threadId)).find(row => row.id === prepared.id), prepared);
  assert.equal((yield* f.fixture.store.start("manual"))?.status, "active");
  assert.equal((yield* f.fixture.store.binding(binding.projectId, "manual"))?.supervisionStop, undefined);
  assert.equal(f.fixture.operations.length, 0);
}));

it.effect("archived exclusions disappear from the relevant editor without dropping the saved policy", () => Effect.gen(function* () {
  const f = yield* noProjectFixture();
  yield* f.supervisor.dashboardStart("manual", "exclusion-visibility");
  yield* f.supervisor.setChatSupervision({projectId: "project-a", mainThreadId: "manual", policyGeneration: (yield* f.policy.get()).generation, enabled: false});
  assert.ok((yield* f.supervisor.candidates("", "exclude")).exceptions.includes("manual"));
  f.fixture.projections.get("manual")!.thread.archivedAt = new Date().toISOString();
  assert.equal((yield* f.supervisor.candidates("", "exclude")).exceptions.includes("manual"), false);
  assert.ok((yield* f.policy.get()).excludedThreadIds.includes("manual"));
}));
