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
    assert.deepEqual((yield* supervisor.settings("new-project")).monitoring, {intervalMinutes: 5, activityThreshold: 10});
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
    const currentMonitoring: SupervisorMonitoringSettings = {intervalMinutes: 8, activityThreshold: 24};
    yield* setStoredSettings(db, {
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
  })));

it.effect("only a changed model selection starts a new native model mutation", () =>
  withStore((supervisor, db) => Effect.gen(function* () {
    yield* setStoredSettings(db, {
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
      options: [{id: "reasoningEffort", value: "high"}],
    });
    assert.equal(changed.pending, false);
    assert.equal(changed.modelMutationGeneration, 4, "a legacy generation 3 advances when the model target changes");
    assert.equal(changed.applyAttempts, 0);
    assert.equal(changed.applicationMessage, null);
    assert.deepEqual(changed.monitoring, {...defaultMonitoringSettings, intervalMinutes: 9});
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
  })));
