import assert from "node:assert/strict";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { defaultMonitoringSettings, type SupervisorMonitoringSettings } from "../src/project-supervisor-contract.js";
import { defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { failsWith, guidanceStoresFixture } from "./support/guidance-store-services.js";

// test/project-monitoring-settings.test.ts on the ProjectSupervisorStore service (s6d step 1), through the real layer on a
// temporary guidance database; every name and assertion is kept

const withStore = <A, E, R>(run: (stores: Effect.Success<ReturnType<typeof guidanceStoresFixture>>) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(guidanceStoresFixture("project-monitoring-settings-"), run).pipe(Effect.provide(NodeServices.layer));

const setStoredSettings = (stores: Effect.Success<ReturnType<typeof guidanceStoresFixture>>, value: Record<string, unknown>) =>
  stores.sql`INSERT INTO supervisor_project_settings VALUES(${String(value.projectId)},${JSON.stringify(value)})`;

it.live("new and legacy project settings receive the monitoring defaults", () => withStore((stores) => Effect.gen(function* () {
  const supervisor = stores.supervisors;
  assert.deepEqual((yield* supervisor.settings("new-project")).monitoring, {intervalMinutes: 5, activityThreshold: 10});
  assert.equal((yield* supervisor.settings("new-project")).modelMutationGeneration, 0);
  yield* setStoredSettings(stores, {
    projectId: "legacy-project",
    generation: 2,
    modelSelection: defaultSupervisorModel,
    pending: false,
    applyAttempts: 1,
    applicationMessage: "A legacy native update is unresolved.",
  });
  const legacy = yield* supervisor.settings("legacy-project");
  assert.deepEqual(legacy.monitoring, defaultMonitoringSettings);
  assert.equal(legacy.modelMutationGeneration, 2, "legacy model identity starts at the existing shared generation");
  assert.equal(legacy.applyAttempts, 1);
  assert.equal(legacy.applicationMessage, "A legacy native update is unresolved.");
})), {timeout: 10_000});

it.live("monitoring-only saves preserve model attempts and legacy saves keep current monitoring", () => withStore((stores) => Effect.gen(function* () {
  const supervisor = stores.supervisors;
  const currentMonitoring: SupervisorMonitoringSettings = {intervalMinutes: 8, activityThreshold: 24};
  yield* setStoredSettings(stores, {
    projectId: "project",
    generation: 4,
    modelSelection: defaultSupervisorModel,
    pending: true,
    monitoring: currentMonitoring,
    applyAttempts: 2,
    applicationMessage: "The native model update is still being reconciled.",
  });

  const changedMonitoring: SupervisorMonitoringSettings = {intervalMinutes: 12, activityThreshold: 35};
  const savedMonitoring = yield* supervisor.saveSettings("project", 4, defaultSupervisorModel, changedMonitoring);
  assert.equal(savedMonitoring.generation, 5);
  assert.equal(savedMonitoring.modelMutationGeneration, 4);
  assert.deepEqual(savedMonitoring.monitoring, changedMonitoring);
  assert.equal(savedMonitoring.pending, false);
  assert.equal(savedMonitoring.applyAttempts, 2);
  assert.equal(savedMonitoring.applicationMessage, "The native model update is still being reconciled.");

  const legacySave = yield* supervisor.saveSettings("project", 5, defaultSupervisorModel);
  assert.deepEqual(legacySave.monitoring, changedMonitoring);
  assert.equal(legacySave.modelMutationGeneration, 4);
  assert.equal(legacySave.pending, false);
  assert.equal(legacySave.applyAttempts, 2);
  assert.equal(legacySave.applicationMessage, "The native model update is still being reconciled.");
})), {timeout: 10_000});

it.live("only a changed model selection starts a new native model mutation", () => withStore((stores) => Effect.gen(function* () {
  const supervisor = stores.supervisors;
  yield* setStoredSettings(stores, {
    projectId: "project",
    generation: 3,
    modelSelection: defaultSupervisorModel,
    pending: false,
    monitoring: {...defaultMonitoringSettings, intervalMinutes: 9},
    applyAttempts: 4,
    applicationMessage: "A previous model operation was recorded.",
  });
  const changed = yield* supervisor.saveSettings("project", 3, {
    ...defaultSupervisorModel,
    options: [{id: "reasoningEffort", value: "low"}],
  });
  assert.equal(changed.pending, false);
  assert.equal(changed.modelMutationGeneration, 4, "a legacy generation 3 advances when the model target changes");
  assert.equal(changed.applyAttempts, 0);
  assert.equal(changed.applicationMessage, null);
  assert.deepEqual(changed.monitoring, {...defaultMonitoringSettings, intervalMinutes: 9});
})), {timeout: 10_000});

it.live("native model readback changes only its binding and preserves project defaults", () => withStore(({supervisors: supervisor}) => Effect.gen(function* () {
  const requested = {...defaultSupervisorModel, options: [{id: "reasoningEffort", value: "low"}]};
  yield* supervisor.saveSettings("project", 0, requested);
  const first = yield* supervisor.reserve("project", "main-a", "First", requested, 10, Date.now());
  const second = yield* supervisor.reserve("project", "main-b", "Second", requested, 10, Date.now());
  yield* supervisor.observeModel(first, defaultSupervisorModel);
  assert.deepEqual((yield* supervisor.settings("project")).modelSelection, requested);
  assert.deepEqual((yield* supervisor.modelState((yield* supervisor.binding("project", "main-a"))!)).modelSelection, defaultSupervisorModel);
  assert.deepEqual((yield* supervisor.modelState(second)).modelSelection, requested);
})), {timeout: 10_000});

it.live("monitoring intervals and thresholds are range checked as integers", () => withStore(({supervisors: supervisor}) => Effect.gen(function* () {
  const invalidValues: SupervisorMonitoringSettings[] = [
    {...defaultMonitoringSettings, intervalMinutes: 0},
    {...defaultMonitoringSettings, intervalMinutes: 61},
    {...defaultMonitoringSettings, intervalMinutes: 5.5},
    {...defaultMonitoringSettings, activityThreshold: 2},
    {...defaultMonitoringSettings, activityThreshold: 101},
    {...defaultMonitoringSettings, activityThreshold: 10.5},
  ];
  for (const monitoring of invalidValues) {
    yield* failsWith(supervisor.saveSettings("project", 0, defaultSupervisorModel, monitoring), /invalid_monitoring_settings/);
    assert.equal((yield* supervisor.settings("project")).generation, 0);
  }
})), {timeout: 10_000});
