import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { defaultMonitoringSettings, type SupervisorMonitoringSettings } from "../src/project-supervisor-contract.js";
import { defaultSupervisorModel, type ProjectSupervisorStoreShape } from "../src/project-supervisor-store.js";
import { failsWith } from "./support/guidance-store-services.js";
import { dataDirectory, withSupervisionStores } from "./support/g9-stores.js";

// the ProjectSupervisorStore service over a temporary guidance.sqlite3 (its production client and layers)

const withStore = <A, E, R>(run: (supervisor: ProjectSupervisorStoreShape, db: SqlClient.SqlClient) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(dataDirectory("project-monitoring-settings-"), (directory) =>
    withSupervisionStores(directory, (stores) => run(stores.supervisors, stores.db)));

const setStoredSettings = (db: SqlClient.SqlClient, value: Record<string, unknown>) =>
  db`INSERT INTO supervisor_project_settings VALUES(${String(value.projectId)},${JSON.stringify(value)})`;

it.effect("new and legacy project settings receive the monitoring defaults", () =>
  withStore((supervisor, db) => Effect.gen(function* () {
    assert.deepEqual((yield* supervisor.settings("new-project")).monitoring, {intervalMinutes: 2, activityThreshold: 10});
    assert.equal((yield* supervisor.settings("new-project")).modelMutationGeneration, 0);
    yield* setStoredSettings(db, {
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
  })));

it.effect("monitoring-only saves preserve model attempts and legacy saves keep current monitoring", () =>
  withStore((supervisor, db) => Effect.gen(function* () {
    const currentMonitoring: SupervisorMonitoringSettings = {intervalMinutes: 1, activityThreshold: 24};
    yield* setStoredSettings(db, {
      projectId: "project",
      generation: 4,
      modelSelection: defaultSupervisorModel,
      pending: true,
      monitoring: currentMonitoring,
      applyAttempts: 2,
      applicationMessage: "The native model update is still being reconciled.",
    });

    const changedMonitoring: SupervisorMonitoringSettings = {intervalMinutes: 2, activityThreshold: 35};
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
  })));

it.effect("only a changed model selection starts a new native model mutation", () =>
  withStore((supervisor, db) => Effect.gen(function* () {
    yield* setStoredSettings(db, {
      projectId: "project",
      generation: 3,
      modelSelection: defaultSupervisorModel,
      pending: false,
      monitoring: {...defaultMonitoringSettings, intervalMinutes: 1},
      applyAttempts: 4,
      applicationMessage: "A previous model operation was recorded.",
    });
    const changed = yield* supervisor.saveSettings("project", 3, {
      ...defaultSupervisorModel,
      options: [{id: "reasoningEffort", value: "high"}],
    });
    assert.equal(changed.pending, false);
    assert.equal(changed.modelMutationGeneration, 4, "a legacy generation 3 advances when the model target changes");
    assert.equal(changed.applyAttempts, 0);
    assert.equal(changed.applicationMessage, null);
    assert.deepEqual(changed.monitoring, {...defaultMonitoringSettings, intervalMinutes: 1});
  })));

it.effect("a project without saved settings uses the GPT-6.1 Sol LOW default, while saved settings and existing bindings keep their selection", () =>
  withStore((supervisor) => Effect.gen(function* () {
    assert.deepEqual(defaultSupervisorModel, {instanceId: "codex", model: "gpt-6.1-sol", options: [{id: "reasoningEffort", value: "low"}]});
    assert.deepEqual((yield* supervisor.settings("unsaved")).modelSelection, defaultSupervisorModel);
    // a selection saved before the default changed, and a binding reserved with it, stay as they are
    const saved = {instanceId: "codex", model: "gpt-6-luna", options: [{id: "reasoningEffort", value: "high"}]};
    yield* supervisor.saveSettings("project", 0, saved);
    const binding = yield* supervisor.reserve("project", "main-a", "Main", saved, 10, yield* Clock.currentTimeMillis);
    assert.deepEqual((yield* supervisor.settings("project")).modelSelection, saved);
    assert.deepEqual((yield* supervisor.modelState(binding)).modelSelection, saved);
  })));

it.effect("native model readback changes only its binding and preserves project defaults", () =>
  withStore((supervisor) => Effect.gen(function* () {
    const requested = {...defaultSupervisorModel, options: [{id: "reasoningEffort", value: "high"}]};
    yield* supervisor.saveSettings("project", 0, requested);
    const first = yield* supervisor.reserve("project", "main-a", "First", requested, 10, yield* Clock.currentTimeMillis);
    const second = yield* supervisor.reserve("project", "main-b", "Second", requested, 10, yield* Clock.currentTimeMillis);
    yield* supervisor.observeModel(first, defaultSupervisorModel);
    assert.deepEqual((yield* supervisor.settings("project")).modelSelection, requested);
    assert.deepEqual((yield* supervisor.modelState((yield* supervisor.binding("project", "main-a"))!)).modelSelection, defaultSupervisorModel);
    assert.deepEqual((yield* supervisor.modelState(second)).modelSelection, requested);
  })));

it.effect("monitoring intervals and thresholds are range checked as integers", () =>
  withStore((supervisor) => Effect.gen(function* () {
    const invalidValues: SupervisorMonitoringSettings[] = [
      {...defaultMonitoringSettings, intervalMinutes: 0},
      {...defaultMonitoringSettings, intervalMinutes: 3},
      {...defaultMonitoringSettings, intervalMinutes: 60},
      {...defaultMonitoringSettings, intervalMinutes: 1.5},
      {...defaultMonitoringSettings, activityThreshold: 2},
      {...defaultMonitoringSettings, activityThreshold: 101},
      {...defaultMonitoringSettings, activityThreshold: 10.5},
    ];
    for (const monitoring of invalidValues) {
      yield* failsWith(supervisor.saveSettings("project", 0, defaultSupervisorModel, monitoring), /invalid_monitoring_settings/);
      assert.equal((yield* supervisor.settings("project")).generation, 0);
    }
  })));

it.effect("the pending activity age is one or two minutes: both save, and a longer stored age reads as two until a save writes two", () =>
  withStore((supervisor, db) => Effect.gen(function* () {
    const one = yield* supervisor.saveSettings("chosen", 0, defaultSupervisorModel, {intervalMinutes: 1, activityThreshold: 10});
    assert.deepEqual(one.monitoring, {intervalMinutes: 1, activityThreshold: 10});
    const two = yield* supervisor.saveSettings("chosen", 1, defaultSupervisorModel, {intervalMinutes: 2, activityThreshold: 10});
    assert.deepEqual(two.monitoring, {intervalMinutes: 2, activityThreshold: 10});

    // a five-minute age saved before the bound existed
    yield* setStoredSettings(db, {projectId: "saved-earlier", generation: 3, modelSelection: defaultSupervisorModel, pending: false,
      monitoring: {intervalMinutes: 5, activityThreshold: 24}, teamSettings: {maxHelpersPerRoot: 4}});
    const effective = yield* supervisor.settings("saved-earlier");
    assert.deepEqual(effective.monitoring, {intervalMinutes: 2, activityThreshold: 24}, "the stored age reads as the bound");
    assert.equal(effective.generation, 3);
    yield* failsWith(supervisor.saveSettings("saved-earlier", 3, defaultSupervisorModel, {intervalMinutes: 5, activityThreshold: 24}),
      /invalid_monitoring_settings/);
    const saved = yield* supervisor.saveSettings("saved-earlier", 3, defaultSupervisorModel);
    assert.deepEqual(saved.monitoring, {intervalMinutes: 2, activityThreshold: 24});
    assert.deepEqual(saved.teamSettings, {maxHelpersPerRoot: 4});
    const [row] = yield* db<{document: string}>`SELECT document FROM supervisor_project_settings WHERE project_id='saved-earlier'`;
    assert.deepEqual((JSON.parse(String(row?.document)) as {monitoring: unknown}).monitoring, {intervalMinutes: 2, activityThreshold: 24});
  })));
