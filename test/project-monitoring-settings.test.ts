import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GuidanceStore } from "../src/guidance-store.js";
import { defaultMonitoringSettings, type SupervisorMonitoringSettings } from "../src/project-supervisor-contract.js";
import { defaultSupervisorModel, ProjectSupervisorStore } from "../src/project-supervisor-store.js";

const withStore = async (run: (supervisor: ProjectSupervisorStore) => void | Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "project-monitoring-settings-"));
  const guidance = new GuidanceStore(directory);
  const supervisor = new ProjectSupervisorStore(guidance, new Set());
  try {await run(supervisor);} finally {guidance.close();await rm(directory, {recursive: true, force: true});}
};

const setStoredSettings = (supervisor: ProjectSupervisorStore, value: Record<string, unknown>) => {
  supervisor.store.db.prepare("INSERT INTO supervisor_project_settings VALUES(?,?)").run(String(value.projectId), JSON.stringify(value));
};

test("new and legacy project settings receive the monitoring defaults", async () => {
  await withStore(supervisor => {
    assert.deepEqual(supervisor.settings("new-project").monitoring, {intervalMinutes: 5, activityThreshold: 10});
    assert.equal(supervisor.settings("new-project").modelMutationGeneration, 0);
    setStoredSettings(supervisor, {
      projectId: "legacy-project",
      generation: 2,
      modelSelection: defaultSupervisorModel,
      pending: false,
      applyAttempts: 1,
      applicationMessage: "A legacy native update is unresolved.",
    });
    const legacy = supervisor.settings("legacy-project");
    assert.deepEqual(legacy.monitoring, defaultMonitoringSettings);
    assert.equal(legacy.modelMutationGeneration, 2, "legacy model identity starts at the existing shared generation");
    assert.equal(legacy.applyAttempts, 1);
    assert.equal(legacy.applicationMessage, "A legacy native update is unresolved.");
  });
});

test("monitoring-only saves preserve model attempts and legacy saves keep current monitoring", async () => {
  await withStore(supervisor => {
    const currentMonitoring: SupervisorMonitoringSettings = {intervalMinutes: 8, activityThreshold: 24};
    setStoredSettings(supervisor, {
      projectId: "project",
      generation: 4,
      modelSelection: defaultSupervisorModel,
      pending: true,
      monitoring: currentMonitoring,
      applyAttempts: 2,
      applicationMessage: "The native model update is still being reconciled.",
    });

    const changedMonitoring: SupervisorMonitoringSettings = {intervalMinutes: 12, activityThreshold: 35};
    const savedMonitoring = supervisor.saveSettings("project", 4, defaultSupervisorModel, changedMonitoring);
    assert.equal(savedMonitoring.generation, 5);
    assert.equal(savedMonitoring.modelMutationGeneration, 4);
    assert.deepEqual(savedMonitoring.monitoring, changedMonitoring);
    assert.equal(savedMonitoring.pending, false);
    assert.equal(savedMonitoring.applyAttempts, 2);
    assert.equal(savedMonitoring.applicationMessage, "The native model update is still being reconciled.");

    const legacySave = supervisor.saveSettings("project", 5, defaultSupervisorModel);
    assert.deepEqual(legacySave.monitoring, changedMonitoring);
    assert.equal(legacySave.modelMutationGeneration, 4);
    assert.equal(legacySave.pending, false);
    assert.equal(legacySave.applyAttempts, 2);
    assert.equal(legacySave.applicationMessage, "The native model update is still being reconciled.");
  });
});

test("only a changed model selection starts a new native model mutation", async () => {
  await withStore(supervisor => {
    setStoredSettings(supervisor, {
      projectId: "project",
      generation: 3,
      modelSelection: defaultSupervisorModel,
      pending: false,
      monitoring: {...defaultMonitoringSettings, intervalMinutes: 9},
      applyAttempts: 4,
      applicationMessage: "A previous model operation was recorded.",
    });
    const changed = supervisor.saveSettings("project", 3, {
      ...defaultSupervisorModel,
      options: [{id: "reasoningEffort", value: "low"}],
    });
    assert.equal(changed.pending, false);
    assert.equal(changed.modelMutationGeneration, 4, "a legacy generation 3 advances when the model target changes");
    assert.equal(changed.applyAttempts, 0);
    assert.equal(changed.applicationMessage, null);
    assert.deepEqual(changed.monitoring, {...defaultMonitoringSettings, intervalMinutes: 9});
  });
});

test("native model readback changes only its binding and preserves project defaults", async () => {
  await withStore(supervisor => {
    const requested = {...defaultSupervisorModel, options: [{id: "reasoningEffort", value: "low"}]};
    supervisor.saveSettings("project", 0, requested);
    const first = supervisor.reserve("project", "main-a", "First", requested, 10, Date.now());
    const second = supervisor.reserve("project", "main-b", "Second", requested, 10, Date.now());
    supervisor.observeModel(first, defaultSupervisorModel);
    assert.deepEqual(supervisor.settings("project").modelSelection, requested);
    assert.deepEqual(supervisor.modelState(supervisor.binding("project", "main-a")!).modelSelection, defaultSupervisorModel);
    assert.deepEqual(supervisor.modelState(second).modelSelection, requested);
  });
});

test("monitoring intervals and thresholds are range checked as integers", async () => {
  await withStore(supervisor => {
    const invalidValues: SupervisorMonitoringSettings[] = [
      {...defaultMonitoringSettings, intervalMinutes: 0},
      {...defaultMonitoringSettings, intervalMinutes: 61},
      {...defaultMonitoringSettings, intervalMinutes: 5.5},
      {...defaultMonitoringSettings, activityThreshold: 2},
      {...defaultMonitoringSettings, activityThreshold: 101},
      {...defaultMonitoringSettings, activityThreshold: 10.5},
    ];
    for (const monitoring of invalidValues) {
      assert.throws(() => supervisor.saveSettings("project", 0, defaultSupervisorModel, monitoring), /invalid_monitoring_settings/);
      assert.equal(supervisor.settings("project").generation, 0);
    }
  });
});
