import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { GuidanceStore } from "../src/guidance-store.js";
import { parseInterpretation, ProjectSupervisor } from "../src/project-supervisor.js";
import { defaultSupervisorModel, ProjectSupervisorStore, type SupervisorBaseline } from "../src/project-supervisor-store.js";
import type { SupervisorModelSelection } from "../src/project-supervisor-contract.js";
import { ProjectSupervisorSnapshot } from "../src/project-supervisor-contract.js";
import { SupervisorRpcError } from "../src/supervisor-native.js";
import { T3TransportError } from "../src/t3.js";
import type { MessageInfo, ProjectInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "../src/types.js";

const activationSequence = 10;
const day = 24 * 60 * 60 * 1000;
const baseTime = "2026-10-13T10:00:00.000Z";

const projects: ProjectInfo[] = [
  { id: "project-a", title: "Project A", workspaceRoot: "/work/a" },
  { id: "project-b", title: "Project B", workspaceRoot: "/work/b" },
];

const modelConfig = {
  providers: [{
    enabled: true,
    instanceId: "codex",
    displayName: "Codex",
    installed: true,
    status: "ready",
    models: ["gpt-6-luna", "gpt-6-astra"].map((slug) => ({
      slug,
      name: slug,
      capabilities: { optionDescriptors: [{
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
          { id: "max", label: "Max" },
        ],
      }] },
    })),
  }],
};

type Turn = { id: string; sequence: number; text: string; creationSource?: "web" | "mobile" | "server"; createdBy?: "user" | "assistant" | "system" };

const makeSourceProjection = (threadId: string, projectId: string, turns: Turn[]): Projection => {
  const thread: ThreadInfo = {
    id: threadId,
    title: "Task conversation",
    projectId,
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const runs: RunInfo[] = [];
  const messages: MessageInfo[] = [];
  const nodes: Array<Record<string, unknown>> = [];
  for (const [index, turn] of turns.entries()) {
    const runId = "run-" + turn.id;
    const rootId = "root-" + turn.id;
    runs.push({
      id: runId,
      threadId,
      ordinal: index + 1,
      status: "completed",
      requestedAt: baseTime,
      startedAt: baseTime,
      completedAt: baseTime,
      rootNodeId: rootId,
      userMessageId: turn.id,
      providerThreadId: "provider-" + threadId,
    });
    messages.push({
      id: turn.id,
      threadId,
      runId,
      nodeId: rootId,
      role: "user",
      text: turn.text,
      streaming: false,
      createdAt: baseTime,
      updatedAt: baseTime,
      createdBy: turn.createdBy ?? "user",
      creationSource: turn.creationSource ?? "web",
    });
    nodes.push(
      { id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "completed", providerThreadId: "provider-" + threadId },
    );
  }
  return { thread, runs, messages, nodes };
};

const emptySupervisorProjection = (threadId: string, projectId: string, model: SupervisorModelSelection): Projection => ({
  thread: {
    id: threadId,
    title: "Project Supervisor",
    projectId,
    lineage: { parentThreadId: null, relationshipToParent: null },
    modelSelection: model,
  },
  runs: [],
  messages: [],
  nodes: [],
});

const addSupervisorRequest = (projection: Projection, payload: Record<string, unknown>): void => {
  const threadId = projection.thread.id;
  const ordinal = projection.runs.length + 1;
  const runId = "supervisor-run-" + ordinal;
  const rootId = "supervisor-root-" + ordinal;
  const messageId = String(payload.messageId);
  const now = new Date().toISOString();
  projection.runs.push({
    id: runId,
    threadId,
    ordinal,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    rootNodeId: rootId,
    userMessageId: messageId,
    providerThreadId: "supervisor-provider",
  });
  projection.messages.push({
    id: messageId,
    threadId,
    runId,
    nodeId: rootId,
    role: "user",
    text: String(payload.text),
    streaming: false,
    createdAt: now,
    updatedAt: now,
    creationSource: "server",
  });
  const nodes = Array.isArray(projection.nodes) ? projection.nodes as Array<Record<string, unknown>> : [];
  projection.nodes = nodes;
  nodes.push(
    { id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "running", providerThreadId: "supervisor-provider" },
  );
};

const completeSupervisorRequest = (projection: Projection, messageId: string, response: string): void => {
  const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
  assert.ok(run?.rootNodeId);
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  const nodes = Array.isArray(projection.nodes) ? projection.nodes as Array<Record<string, unknown>> : [];
  const root = nodes.find((node) => node.id === run.rootNodeId);
  assert.ok(root);
  root.status = "completed";
  const nodeId = "supervisor-assistant-node-" + run.id;
  nodes.push({
    id: nodeId,
    threadId: projection.thread.id,
    runId: run.id,
    parentNodeId: run.rootNodeId,
    rootNodeId: run.rootNodeId,
    kind: "assistant_message",
    status: "completed",
    providerThreadId: "supervisor-provider",
  });
  const now = new Date().toISOString();
  projection.messages.push({
    id: "assistant-" + run.id,
    threadId: projection.thread.id,
    runId: run.id,
    nodeId,
    role: "assistant",
    text: response,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  });
};

const retryInput = (
  projectId: string,
  expectedGeneration: number,
  binding: { threadId: string; generation: number; mainThreadId: string },
  action: "retry" | "replace",
) => ({ projectId, mainThreadId: binding.mainThreadId, expectedGeneration, threadId: binding.threadId, bindingGeneration: binding.generation, action });

const makeFixture = async (initial: Array<{ threadId: string; projectId: string; turns: Turn[] }>) => {
  const directory = await mkdtemp(join(tmpdir(), "project-supervisor-test-"));
  const projections = new Map<string, Projection>();
  const turnsByThread = new Map<string, Turn[]>();
  const operations: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const projectionReads: string[] = [];
  let unknownDispatches = 0;
  let acceptedDispatchesWithoutRun = 0;
  let unknownLaunchResponses = 0;
  let launchFailuresBeforeCreate = 0;
  let durableLaunchRejections = 0;
  let providerDisabledLaunchRejections = 0;
  let providerDisabledDispatches = 0;
  let unknownModelUpdates = 0;
  let durableModelRejections = 0;
  let nextModelReadback: SupervisorModelSelection | null = null;
  let nextMissingProjectionFailure: T3TransportError | null = null;
  let snapshotSequence = activationSequence;
  let baselineReads = 0;
  for (const source of initial) {
    projections.set(source.threadId, makeSourceProjection(source.threadId, source.projectId, source.turns));
    turnsByThread.set(source.threadId, [...source.turns]);
  }
  let guidance = new GuidanceStore(directory);
  let ownedIds = new Set<string>();
  let supervisorStore = new ProjectSupervisorStore(guidance, ownedIds);
  const config: SupervisorConfig = {
    supervisorOwnedThreadIds: ownedIds,
    dataDirectory: directory,
    t3Url: "http://unused",
    t3TokenFile: "unused",
    mcpxUrl: "http://unused",
    cxCommand: "unused",
    cxHome: directory,
    cxSeedFile: "unused",
    excludedThreadIds: [],
    healthPort: 0,
    modelTimeoutMs: 1000,
  };
  const source = {
    catalog: () => Effect.succeed({
      projects: projects.map((project) => ({ project, available: true })),
      threads: [...projections.values()].map((projection) => projection.thread),
    }),
  };
  const t3 = {
    projection: (threadId: string) => {
      projectionReads.push(threadId);
      const projection = projections.get(threadId);
      if (projection) return Effect.succeed({ projection, snapshotSequence: 20 });
      if (nextMissingProjectionFailure) {
        const failure = nextMissingProjectionFailure;
        nextMissingProjectionFailure = null;
        return Effect.fail(failure);
      }
      return Effect.fail(new T3TransportError("missing projection", 404));
    },
  };
  const readRpc = async (tag: string): Promise<unknown> => {
    if (tag === "server.getConfig") return modelConfig;
    throw new Error("unexpected fake read RPC");
  };
  const operateRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    operations.push({ tag, payload });
    if (tag === "orchestration.launchThread") {
      const threadId = String(payload.threadId);
      const projectId = String(payload.projectId);
      const existing = projections.has(threadId);
      if (payload.reuseExistingThread === true && !existing) throw new Error("reuseExistingThread requires a thread already visible in projection");
      if (!existing && providerDisabledLaunchRejections > 0) {
        providerDisabledLaunchRejections -= 1;
        throw new SupervisorRpcError("rejected", true, true);
      }
      if (!existing && durableLaunchRejections > 0) {
        durableLaunchRejections -= 1;
        throw new SupervisorRpcError("rejected", true);
      }
      if (!existing && launchFailuresBeforeCreate > 0) {
        launchFailuresBeforeCreate -= 1;
        throw new Error("simulated lost launch response before native creation");
      }
      if (!existing) projections.set(threadId, emptySupervisorProjection(threadId, projectId, payload.modelSelection as SupervisorModelSelection));
      if (unknownLaunchResponses > 0) {
        unknownLaunchResponses -= 1;
        throw new Error("simulated lost launch response after native creation");
      }
      return { accepted: true };
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "message.dispatch") {
      if (providerDisabledDispatches > 0) {
        providerDisabledDispatches -= 1;
        throw new SupervisorRpcError("rejected", true, true);
      }
      if (unknownDispatches > 0) {
        unknownDispatches -= 1;
        throw new Error("simulated lost response");
      }
      const projection = projections.get(String(payload.threadId));
      assert.ok(projection);
      if (acceptedDispatchesWithoutRun > 0) {
        acceptedDispatchesWithoutRun -= 1;
        return { accepted: true };
      }
      addSupervisorRequest(projection, payload);
      delete projection.thread.settledAt;
      return { accepted: true };
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "thread.model-selection.set") {
      const projection = projections.get(String(payload.threadId));
      assert.ok(projection);
      if (durableModelRejections > 0) {
        durableModelRejections -= 1;
        projection.thread.modelSelection = nextModelReadback ?? defaultSupervisorModel;
        nextModelReadback = null;
        throw new SupervisorRpcError("rejected", true);
      }
      if (unknownModelUpdates > 0) {
        unknownModelUpdates -= 1;
        throw new Error("simulated lost model update response");
      }
      projection.thread.modelSelection = nextModelReadback ?? payload.modelSelection;
      nextModelReadback = null;
      return { accepted: true };
    }
    throw new Error("unexpected fake operate RPC");
  };
  const activationSnapshot = async (_signal: AbortSignal): Promise<SupervisorBaseline> => {
    baselineReads += 1;
    return {
      snapshotSequence,
      threads: [...projections.values()].map((projection) => {
        const historical = (turnsByThread.get(projection.thread.id) ?? []).filter((turn) => turn.sequence <= snapshotSequence);
        const latest = historical.at(-1);
        return { id: projection.thread.id, latestRunId: latest ? "run-" + latest.id : null };
      }),
    };
  };
  const addTurn = (threadId: string, projectId: string, turn: Turn): void => {
    const turns = [...(turnsByThread.get(threadId) ?? []), turn];
    turnsByThread.set(threadId, turns);
    projections.set(threadId, makeSourceProjection(threadId, projectId, turns));
  };
  const makeSupervisor = () => new ProjectSupervisor(config, supervisorStore, source, t3, readRpc, operateRpc, activationSnapshot);
  const restart = (): void => {
    guidance.close();
    guidance = new GuidanceStore(directory);
    ownedIds = new Set<string>();
    supervisorStore = new ProjectSupervisorStore(guidance, ownedIds);
    config.supervisorOwnedThreadIds = ownedIds;
  };
  return {
    directory,
    operations,
    projectionReads,
    projections,
    get supervisorStore() { return supervisorStore; },
    get baselineReads() { return baselineReads; },
    makeSupervisor,
    restart,
    addTurn,
    setSnapshotSequence: (value: number) => { snapshotSequence = value; },
    setUnknownDispatches: (count: number) => { unknownDispatches = count; },
    setAcceptedDispatchesWithoutRun: (count: number) => { acceptedDispatchesWithoutRun = count; },
    setUnknownLaunchResponses: (count: number) => { unknownLaunchResponses = count; },
    setLaunchFailuresBeforeCreate: (count: number) => { launchFailuresBeforeCreate = count; },
    setDurableLaunchRejections: (count: number) => { durableLaunchRejections = count; },
    setProviderDisabledLaunchRejections: (count: number) => { providerDisabledLaunchRejections = count; },
    setProviderDisabledDispatches: (count: number) => { providerDisabledDispatches = count; },
    setUnknownModelUpdates: (count: number) => { unknownModelUpdates = count; },
    setDurableModelRejections: (count: number) => { durableModelRejections = count; },
    setNextModelReadback: (selection: SupervisorModelSelection) => { nextModelReadback = selection; },
    setNextMissingProjectionFailure: (error: T3TransportError) => { nextMissingProjectionFailure = error; },
    setLegacyBaseline: (baseline: Record<string, unknown>) => {
      supervisorStore.store.db.prepare("INSERT INTO meta VALUES('supervisor_activation_baseline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(baseline));
    },
    close: () => guidance.close(),
    cleanup: async () => { try { guidance.close(); } catch { /* already closed during a simulated restart */ } await rm(directory, { recursive: true, force: true }); },
  };
};

test("activation baseline excludes existing runs and gives independent mains separate Supervisors", async (t) => {
  const fixture = await makeFixture([
    { threadId: "old-thread", projectId: "project-a", turns: [{ id: "old-task", sequence: 9, text: "Old work" }] },
    { threadId: "current-thread", projectId: "project-a", turns: [
      { id: "current-history", sequence: 10, text: "Earlier request" },
      { id: "current-task", sequence: 11, text: "Build the invoice export" },
    ] },
    { threadId: "archived-history", projectId: "project-a", turns: [{ id: "archived-task", sequence: 8, text: "Archived work" }] },
  ]);
  t.after(fixture.cleanup);
  fixture.projections.get("archived-history")!.thread.archivedAt = baseTime;
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const baseline = fixture.supervisorStore.baseline();
  assert.equal(baseline?.snapshotSequence, activationSequence);
  assert.equal(baseline?.version, 2);
  assert.equal(baseline?.threads.find((thread) => thread.id === "old-thread")?.latestRunId, "run-old-task");
  assert.equal(baseline?.threads.find((thread) => thread.id === "current-thread")?.latestRunId, "run-current-history");
  assert.equal(baseline?.threads.find((thread) => thread.id === "archived-history")?.latestRunId, "run-archived-task");
  assert.equal(fixture.supervisorStore.task("old-thread"), null);
  assert.equal(fixture.supervisorStore.task("current-thread")?.status, "waiting");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
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

  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("second-thread")?.status, "waiting");
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 2, "each main can have its own in-flight interpretation");
  assert.equal(fixture.projectionReads.includes("owned-descendant"), false);

  const firstTask = fixture.supervisorStore.task("current-thread");
  assert.ok(firstTask);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  const linkedResult = JSON.stringify({
    objective: "Build the invoice export",
    reason: "The source request asks for an export to be built.",
    sourceMessageIds: [firstTask.sourceMessageId],
  });
  completeSupervisorRequest(supervisorProjection, firstTask.messageId, linkedResult);
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("current-thread")?.status, "inferred");
  assert.equal(fixture.supervisorStore.task("current-thread")?.objective, "Build the invoice export");
  assert.throws(() => parseInterpretation(JSON.stringify({
    objective: "A different task",
    reason: "The response points to another input.",
    sourceMessageIds: ["unrelated-message"],
  }), firstTask.sourceMessageId));

  await supervisor.runOnce();
  const dispatches = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(dispatches.length, 2);
  assert.deepEqual(new Set(dispatches.map(call => call.payload.threadId)), new Set(fixture.supervisorStore.bindings().map(binding => binding.threadId)));
  assert.notEqual(dispatches[0]?.payload.messageId, dispatches[1]?.payload.messageId);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 2);
});

test("a web-originated message with non-user authorship is not treated as a task", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{
      id: "non-user-source",
      sequence: 11,
      text: "A web-originated message not authored by the user",
      creationSource: "web",
      createdBy: "assistant",
    }] },
  ]);
  t.after(fixture.cleanup);
  await fixture.makeSupervisor().runOnce();

  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 0);
});

test("a missing baseline run anchor fails closed instead of interpreting later projection history", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "baseline-anchor", sequence: 9, text: "Historical request" }] },
  ]);
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.baselineOrdinal("source-thread", fixture.projections.get("source-thread")!), 1);

  fixture.projections.set("source-thread", makeSourceProjection("source-thread", "project-a", [
    { id: "later-task", sequence: 11, text: "This run must not pass a missing baseline anchor" },
  ]));
  await supervisor.runOnce();

  assert.equal(fixture.supervisorStore.baselineOrdinal("source-thread", fixture.projections.get("source-thread")!), null);
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 0);
});

test("an unversioned activation baseline is replaced by a conservative version 2 capture", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [
      { id: "legacy-history", sequence: 9, text: "Do not backfill this old task" },
      { id: "post-activation-task", sequence: 11, text: "Review the next change" },
    ] },
  ]);
  t.after(fixture.cleanup);
  fixture.setLegacyBaseline({ snapshotSequence: 9, threads: [] });
  assert.equal(fixture.supervisorStore.baseline(), null);

  await fixture.makeSupervisor().runOnce();

  const baseline = fixture.supervisorStore.baseline();
  assert.equal(baseline?.version, 2);
  assert.equal(baseline?.snapshotSequence, activationSequence);
  assert.equal(baseline?.threads.find((thread) => thread.id === "source-thread")?.latestRunId, "run-legacy-history");
  assert.equal(fixture.baselineReads, 1);
  assert.equal(fixture.supervisorStore.task("source-thread")?.sourceMessageId, "post-activation-task");
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
});

test("model choices are checked against T3 and saved per project with generation CAS", async (t) => {
  const fixture = await makeFixture([]);
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  const signal = AbortSignal.timeout(1000);
  const invalid = await supervisor.save({
    projectId: "project-a",
    expectedGeneration: 0,
    modelSelection: { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "unadvertised" }] },
  }, signal);
  assert.equal(invalid.status, "invalid");

  const savedA = await supervisor.save({
    projectId: "project-a",
    expectedGeneration: 0,
    modelSelection: { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "low" }] },
  }, signal);
  assert.equal(savedA.status, "saved");
  assert.equal(savedA.snapshot?.settings.generation, 1);
  const conflict = await supervisor.save({
    projectId: "project-a",
    expectedGeneration: 0,
    modelSelection: defaultSupervisorModel,
  }, signal);
  assert.equal(conflict.status, "conflict");

  const savedB = await supervisor.save({
    projectId: "project-b",
    expectedGeneration: 0,
    modelSelection: { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "max" }] },
  }, signal);
  assert.equal(savedB.status, "saved");
  assert.equal(fixture.supervisorStore.settings("project-a").modelSelection.options[0]?.value, "low");
  assert.equal(fixture.supervisorStore.settings("project-b").modelSelection.model, "gpt-6-astra");
  assert.equal(fixture.supervisorStore.settings("project-b").generation, 1);
});

test("model defaults affect new Supervisors while independent T3 selections remain authoritative", async t => {
  const fixture = await makeFixture([{threadId: "first", projectId: "project-a", turns: [{id: "first-task", sequence: 11, text: "Implement first"}]}]);
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const first = fixture.supervisorStore.binding("project-a", "first")!;
  const manual = {...defaultSupervisorModel, model: "gpt-6-astra", options: [{id: "reasoningEffort", value: "max"}]};
  fixture.projections.get(first.threadId)!.thread.modelSelection = manual;
  const defaults = {...defaultSupervisorModel, options: [{id: "reasoningEffort", value: "low"}]};
  assert.equal((await supervisor.save({projectId: "project-a", expectedGeneration: 0, modelSelection: defaults}, AbortSignal.timeout(1000))).status, "saved");
  fixture.addTurn("second", "project-a", {id: "second-task", sequence: 12, text: "Implement second"});
  await supervisor.runOnce();
  const second = fixture.supervisorStore.binding("project-a", "second")!;
  assert.notEqual(first.threadId, second.threadId);
  assert.deepEqual(fixture.projections.get(first.threadId)!.thread.modelSelection, manual);
  assert.deepEqual(fixture.projections.get(second.threadId)!.thread.modelSelection, defaults);
  assert.deepEqual(fixture.supervisorStore.settings("project-a").modelSelection, defaults);
  assert.equal(fixture.operations.some(call => call.payload.type === "thread.model-selection.set"), false);
  const selected = await supervisor.snapshot("project-a", AbortSignal.timeout(1000), "first");
  assert.deepEqual(selected.modelSelection, manual);
  const noSelection = await supervisor.snapshot("project-a", AbortSignal.timeout(1000));
  assert.equal(noSelection.binding, null);assert.equal(noSelection.modelSelection, null);assert.deepEqual(noSelection.tasks, []);
});

test("unknown dispatch survives restart and retention with the original native identities", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  t.after(fixture.cleanup);
  fixture.setUnknownDispatches(1);
  await fixture.makeSupervisor().runOnce();
  const uncertain = fixture.supervisorStore.task("source-thread");
  assert.equal(uncertain?.status, "uncertain");
  assert.ok(uncertain);
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  fixture.supervisorStore.saveTask({ ...uncertain, updatedAt: Date.now() - 31 * day });
  const activationBaseline = fixture.supervisorStore.baseline();
  assert.ok(activationBaseline);

  fixture.setSnapshotSequence(12);
  fixture.restart();
  assert.equal(fixture.supervisorStore.ownedIds.has(binding.threadId), true);
  assert.deepEqual(fixture.supervisorStore.baseline(), activationBaseline);
  assert.equal(fixture.baselineReads, 1, "restart must reuse the original baseline instead of moving activation forward");
  fixture.supervisorStore.prune(Date.now());
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "uncertain");

  await fixture.makeSupervisor().runOnce();
  const dispatches = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[1]?.payload.commandId, dispatches[0]?.payload.commandId);
  assert.equal(dispatches[1]?.payload.messageId, dispatches[0]?.payload.messageId);
  assert.equal(dispatches[1]?.payload.text, dispatches[0]?.payload.text);
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
  assert.equal(fixture.operations.some((call) => ["runtime-request.respond", "thread.interrupt", "runtime-request.interrupt"].includes(String(call.payload.type))), false);
});

test("accepted requests without native runs stop after two replays and remain available for explicit retry", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  t.after(fixture.cleanup);
  fixture.setAcceptedDispatchesWithoutRun(3);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  for (let attempt = 0; attempt < 3; attempt += 1) await supervisor.runOnce();

  const uncertain = fixture.supervisorStore.task("source-thread");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(uncertain && binding);
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.replayCount, 2);
  const dispatches = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(dispatches.length, 3);
  assert.ok(dispatches.every((call) => call.payload.commandId === dispatches[0]?.payload.commandId));
  assert.ok(dispatches.every((call) => call.payload.messageId === dispatches[0]?.payload.messageId));

  await supervisor.runOnce();
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 3, "uncertainty waits for an explicit UI retry");
  const retry = await supervisor.retry(retryInput("project-a", 0, binding, "retry"), AbortSignal.timeout(1000));
  assert.equal(retry.status, "saved");
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
  const retried = fixture.operations.filter((call) => call.payload.type === "message.dispatch");
  assert.equal(retried.length, 4);
  assert.equal(retried[3]?.payload.commandId, retried[0]?.payload.commandId);
  assert.equal(retried[3]?.payload.messageId, retried[0]?.payload.messageId);
});

test("a transient Supervisor projection failure is not treated as proof the thread is missing", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  t.after(fixture.cleanup);
  fixture.setNextMissingProjectionFailure(new T3TransportError("projection unavailable", 503));
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();

  const reserved = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(reserved);
  assert.equal(reserved.state, "creating");
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 0);

  await supervisor.runOnce();
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.state, "ready");
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
});

test("creation attempts stop after three failures until explicit retry reuses the original command identity", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  t.after(fixture.cleanup);
  fixture.setLaunchFailuresBeforeCreate(3);
  const supervisor = fixture.makeSupervisor();
  for (let attempt = 0; attempt < 4; attempt += 1) await supervisor.runOnce();

  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  assert.equal(binding.state, "uncertain");
  assert.equal(binding.creationAttempts, 3);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 3);
  const originalCommandId = fixture.operations.find((call) => call.tag === "orchestration.launchThread")?.payload.commandId;
  assert.ok(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").every((call) => call.payload.commandId === originalCommandId));
  assert.equal(fixture.supervisorStore.task("source-thread"), null);

  const retry = await supervisor.retry(retryInput("project-a", 0, binding, "retry"), AbortSignal.timeout(1000));
  assert.equal(retry.status, "saved");
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.threadId, binding.threadId);
  const launches = fixture.operations.filter((call) => call.tag === "orchestration.launchThread");
  assert.equal(launches.length, 4);
  assert.equal(launches[3]?.payload.commandId, originalCommandId);
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
});

test("durable creation rejection requires explicit retry and advances only the native command generation", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  t.after(fixture.cleanup);
  fixture.setDurableLaunchRejections(1);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const rejected = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(rejected);
  assert.equal(rejected.state, "rejected");
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  await supervisor.runOnce();
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1, "durable rejection cannot auto-replay");

  const retry = await supervisor.retry(retryInput("project-a", 0, rejected, "retry"), AbortSignal.timeout(1000));
  assert.equal(retry.status, "saved");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.equal(binding?.threadId, rejected.threadId);
  assert.equal(binding?.generation, rejected.generation + 1);
  const launches = fixture.operations.filter((call) => call.tag === "orchestration.launchThread");
  assert.equal(launches.length, 2);
  assert.notEqual(launches[0]?.payload.commandId, launches[1]?.payload.commandId);
  assert.equal(launches[0]?.payload.threadId, launches[1]?.payload.threadId);
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
});

test("a provider-disabled initial creation is durably rejected without automatic relaunch", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  t.after(fixture.cleanup);
  fixture.setProviderDisabledLaunchRejections(1);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();

  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.state, "rejected");
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  await supervisor.runOnce();
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
});

test("a provider-disabled objective does not block another main in the same project", async t => {
  const fixture = await makeFixture([{threadId: "first-thread", projectId: "project-a", turns: [{id: "first-task", sequence: 11, text: "Implement first"}]},
    {threadId: "second-thread", projectId: "project-a", turns: [{id: "second-task", sequence: 12, text: "Implement second"}]}]);
  t.after(fixture.cleanup);fixture.setProviderDisabledDispatches(1);
  await fixture.makeSupervisor().runOnce();
  assert.equal(fixture.supervisorStore.task("first-thread")?.status, "unavailable");
  assert.equal(fixture.supervisorStore.task("second-thread")?.status, "waiting");
  assert.notEqual(fixture.supervisorStore.task("first-thread")?.supervisorThreadId, fixture.supervisorStore.task("second-thread")?.supervisorThreadId);
});

test("a lost launch response recovers the native-created Supervisor without duplicate launch or ownership", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  t.after(fixture.cleanup);
  fixture.setUnknownLaunchResponses(1);
  await fixture.makeSupervisor().runOnce();

  const reserved = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(reserved);
  assert.equal(reserved.state, "ready", "the native-created thread is reconciled from its visible projection");
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
  assert.ok(fixture.projections.has(reserved.threadId), "the fake native server created the thread before losing its reply");

  await fixture.makeSupervisor().runOnce();
  const recovered = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.equal(recovered?.threadId, reserved.threadId);
  assert.equal(recovered?.state, "ready");
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
  assert.equal(fixture.supervisorStore.ownedIds.has(reserved.threadId), true);
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
});

test("an archived reserved binding is retained and never launched again", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  t.after(fixture.cleanup);
  fixture.setUnknownLaunchResponses(1);
  await fixture.makeSupervisor().runOnce();
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(binding);
  const projection = fixture.projections.get(binding.threadId);
  assert.ok(projection);
  projection.thread.archivedAt = baseTime;

  await fixture.makeSupervisor().runOnce();
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.threadId, binding.threadId);
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.state, "ready");
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
  assert.equal(fixture.supervisorStore.task("source-thread"), null);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);
});

test("a stale retry intent cannot replace a missing binding; explicit replacement retains old ownership", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a migration plan" }] },
  ]);
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const original = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  const originalTask = fixture.supervisorStore.task("source-thread");
  assert.ok(original && originalTask);
  fixture.projections.delete(original.threadId);
  await supervisor.runOnce();
  const missing = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.equal(missing?.state, "missing");

  const staleRetry = await supervisor.retry(retryInput("project-a", 0, original, "retry"), AbortSignal.timeout(1000));
  assert.equal(staleRetry.status, "conflict");
  assert.equal((fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)?.threadId, original.threadId);
  assert.equal(fixture.supervisorStore.ownedIds.size, 1);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 1);

  const replacement = await supervisor.retry(retryInput("project-a", 0, missing!, "replace"), AbortSignal.timeout(1000));
  assert.equal(replacement.status, "saved");
  const current = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(current);
  assert.notEqual(current.threadId, original.threadId);
  assert.equal(fixture.supervisorStore.ownedIds.size, 2);
  assert.equal(fixture.supervisorStore.ownedIds.has(original.threadId), true);
  assert.equal(fixture.supervisorStore.ownedIds.has(current.threadId), true);
  assert.equal(fixture.operations.filter((call) => call.tag === "orchestration.launchThread").length, 2);
  const retained = fixture.supervisorStore.task("source-thread");
  assert.equal(retained?.status, "unavailable");
  assert.equal(retained?.id, originalTask.id);
  assert.equal(retained?.messageId, originalTask.messageId);
});

test("a changed source invalidates a completed Supervisor result without an operational reply", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Deploy the release" }] },
  ]);
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const task = fixture.supervisorStore.task("source-thread");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(task && binding);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  completeSupervisorRequest(supervisorProjection, task.messageId, JSON.stringify({
    objective: "Deploy the release",
    reason: "The source request asks for a deployment.",
    sourceMessageIds: [task.sourceMessageId],
  }));

  const sourceProjection = fixture.projections.get("source-thread");
  assert.ok(sourceProjection);
  sourceProjection.messages[0]!.text = "Actually, do not deploy anything";
  await supervisor.runOnce();
  const stale = fixture.supervisorStore.task("source-thread");
  assert.equal(stale?.status, "unavailable");
  assert.equal(stale?.objective, null);
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 1);
  assert.equal(fixture.operations.some((call) => ["runtime-request.respond", "thread.interrupt"].includes(String(call.payload.type))), false);
});

test("a completed interpretation with unrelated source IDs is rejected", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "source-task", sequence: 11, text: "Create a release checklist" }] },
  ]);
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const task = fixture.supervisorStore.task("source-thread");
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  assert.ok(task && binding);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  completeSupervisorRequest(supervisorProjection, task.messageId, JSON.stringify({
    objective: "Publish a release",
    reason: "This response cites another message.",
    sourceMessageIds: ["unrelated-message"],
  }));

  await supervisor.runOnce();
  const rejected = fixture.supervisorStore.task("source-thread");
  assert.equal(rejected?.status, "unavailable");
  assert.equal(rejected?.objective, null);
  assert.match(rejected?.reason ?? "", /valid, source-linked interpretation/u);
});

test("interrupted and stalled Supervisor runs become unavailable without answers or interruption commands", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "first-task", sequence: 11, text: "Review the release" }] },
  ]);
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  const first = fixture.supervisorStore.task("source-thread");
  assert.ok(binding && first);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  const firstRun = supervisorProjection.runs.find((run) => run.userMessageId === first.messageId);
  assert.ok(firstRun);
  firstRun.status = "interrupted";
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "unavailable");

  fixture.addTurn("source-thread", "project-a", { id: "second-task", sequence: 12, text: "Check the rollout plan" });
  await supervisor.runOnce();
  const second = fixture.supervisorStore.task("source-thread");
  assert.equal(second?.status, "waiting");
  assert.ok(second);
  const secondRun = supervisorProjection.runs.find((run) => run.userMessageId === second.messageId);
  assert.ok(secondRun);
  secondRun.status = "waiting";
  secondRun.startedAt = new Date(Date.now() - 301_000).toISOString();
  fixture.supervisorStore.saveTask({ ...second, dispatchedAt: Date.now() - 301_000 });
  await supervisor.runOnce();

  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "unavailable");
  assert.match(fixture.supervisorStore.task("source-thread")?.reason ?? "", /does not answer or interrupt/u);
  assert.equal(fixture.operations.filter((call) => call.payload.type === "message.dispatch").length, 2);
  assert.equal(fixture.operations.some((call) => ["runtime-request.respond", "thread.interrupt", "runtime-request.interrupt"].includes(String(call.payload.type))), false);
  assert.equal(fixture.projections.get("source-thread")?.messages.length, 2);
});

test("queued and not-yet-started Supervisor runs do not time out from stale dispatch time", async (t) => {
  const fixture = await makeFixture([
    { threadId: "source-thread", projectId: "project-a", turns: [{ id: "first-task", sequence: 11, text: "Review the release" }] },
  ]);
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null);
  const task = fixture.supervisorStore.task("source-thread");
  assert.ok(binding && task);
  const supervisorProjection = fixture.projections.get(binding.threadId);
  assert.ok(supervisorProjection);
  const run = supervisorProjection.runs.find((candidate) => candidate.userMessageId === task.messageId);
  assert.ok(run);

  fixture.supervisorStore.saveTask({ ...task, dispatchedAt: Date.now() - 301_000 });
  run.status = "queued";
  run.startedAt = null;
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");

  run.status = "running";
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "waiting");

  run.startedAt = new Date(Date.now() - 301_000).toISOString();
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.task("source-thread")?.status, "unavailable");
});

test("agreement snapshots preserve mixed plans through restart and mark replaced ownership stale", async (t) => {
  const fixture = await makeFixture([{threadId: "agreement-source", projectId: "project-a", turns: [{id: "agreement-task", sequence: 11, text: "Add CSV export"}]}]);
  t.after(fixture.cleanup);
  const supervisor = fixture.makeSupervisor();
  await supervisor.runOnce();
  const task = fixture.supervisorStore.task("agreement-source")!;
  const workflow = {status: "proposed" as const, message: "Current draft", workspaceRoot: "/work/a", revision: "definitions-1", rules: [],
    steps: [{blockId: null, name: "Implement CSV export", reason: "Add the requested feature"}]};
  const agreement = {status: "agreed" as const, message: "Both conversations confirmed the plan", proposalId: "csv-1", agreedAt: Date.now(),
    supervisorMessageId: "supervisor-proof", agentMessageId: "operative-proof", workflow};
  fixture.supervisorStore.saveTask({...task, status: "inferred", objective: "Add CSV export", workflow, workflowProposalId: "csv-2", agreement});
  fixture.restart();
  const restored = fixture.makeSupervisor();
  const snapshot = Schema.decodeUnknownSync(ProjectSupervisorSnapshot)(await restored.snapshot("project-a", new AbortController().signal, "agreement-source"));
  assert.equal(snapshot.tasks[0]?.workflowProposalId, "csv-2");
  assert.deepEqual(snapshot.tasks[0]?.agreement, agreement);
  assert.equal(snapshot.tasks[0]?.workflow?.steps[0]?.blockId, null);
  const binding = (fixture.supervisorStore.bindings().find(binding => binding.projectId === "project-a") ?? null)!;
  fixture.supervisorStore.setBinding({...binding, state: "missing"});
  fixture.supervisorStore.replaceMissingBinding({...binding, state: "missing"}, defaultSupervisorModel);
  const stale = fixture.supervisorStore.task("agreement-source")?.agreement;
  assert.equal(stale?.status, "stale");
  assert.equal(stale?.supervisorMessageId, "supervisor-proof");
  assert.deepEqual(stale?.workflow, workflow);
});

test("task payload expiry clears retained agreement plans and current proposal identity", async (t) => {
  const fixture = await makeFixture([{threadId: "expiry-source", projectId: "project-a", turns: [{id: "expiry-task", sequence: 11, text: "Add CSV export"}]}]);
  t.after(fixture.cleanup);
  await fixture.makeSupervisor().runOnce();
  const task = fixture.supervisorStore.task("expiry-source")!;
  const workflow = {status: "proposed" as const, message: "Draft", workspaceRoot: "/work/a", revision: "definitions-1", rules: [], steps: []};
  fixture.supervisorStore.saveTask({...task, status: "inferred", workflow, workflowProposalId: "csv-1", updatedAt: 1,
    agreement: {status: "agreed", message: "Accepted", proposalId: "csv-1", agreedAt: 1, supervisorMessageId: "supervisor-proof", agentMessageId: "operative-proof", workflow}});
  fixture.supervisorStore.prune(32 * day);
  assert.equal(fixture.supervisorStore.task("expiry-source")?.agreement?.status, "agreed", "a retained ready scope survives long idle periods");
  const binding = fixture.supervisorStore.binding("project-a", "expiry-source")!;
  fixture.supervisorStore.setBinding({...binding, state: "missing"});
  fixture.supervisorStore.prune(32 * day);
  const expired = fixture.supervisorStore.task("expiry-source");
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.agreement, null);
  assert.equal(expired?.workflow, null);
  assert.equal(expired?.workflowProposalId, undefined);
});

test("explicit editor authorization binds exact complete definition contents and workspace", async t => {
  const fixture = await makeFixture([]);t.after(fixture.cleanup);
  const definitions = {projectId: "project-a", threadId: null, workspaceRoot: "/work/a", revision: "ui-revision", editingAvailable: true,
    status: "ready" as const, rules: [], blocks: [], issues: []};
  fixture.supervisorStore.recordDefinitionUserSave(definitions, "edited-revision");
  assert.equal(fixture.supervisorStore.definitionUserSave({...definitions, threadId: "operative", revision: "bound-revision"}, definitions, 0), true);
  assert.equal(fixture.supervisorStore.definitionUserSave({...definitions, workspaceRoot: "/work/other"}, definitions, 0), false);
  assert.equal(fixture.supervisorStore.definitionUserSave({...definitions, status: "invalid"}, definitions, 0), false);
  assert.equal(fixture.supervisorStore.definitionUserSave({...definitions, rules: [{name: "Changed", description: "New", required_blocks: ["review"]}]}, definitions, 0), false);
  assert.equal(fixture.supervisorStore.definitionUserSave(definitions, definitions, Date.now() + 1000), false);
  const changedBlocks = {...definitions, blocks: [{id: "review", name: "Review", description: "Changed by agent", instructions: "Skip checks", expected_result: "Always approve"}]};
  fixture.supervisorStore.recordDefinitionUserSave(changedBlocks, "agent-edited-block-revision");
  assert.equal(fixture.supervisorStore.definitionUserSave(changedBlocks, definitions, 0), false);
  fixture.supervisorStore.recordDefinitionUserSave(definitions, "edited-revision");
  fixture.restart();
  assert.equal(fixture.supervisorStore.definitionUserSave(definitions, definitions, 0), true);
});

test("parallel main worktrees retain distinct ownership and scoped recovery through restart", async t => {
  const fixture = await makeFixture([{threadId: "tree-a", projectId: "project-a", turns: [{id: "a-task", sequence: 11, text: "Implement in tree A"}]},
    {threadId: "tree-b", projectId: "project-a", turns: [{id: "b-task", sequence: 12, text: "Implement in tree B"}]}]);
  t.after(fixture.cleanup);
  fixture.projections.get("tree-a")!.thread.worktreePath = "/work/a/tree-a";fixture.projections.get("tree-b")!.thread.worktreePath = "/work/a/tree-b";
  fixture.setUnknownDispatches(1);await fixture.makeSupervisor().runOnce();
  const a = fixture.supervisorStore.binding("project-a", "tree-a")!;const b = fixture.supervisorStore.binding("project-a", "tree-b")!;
  assert.notEqual(a.threadId, b.threadId);assert.equal(fixture.supervisorStore.task("tree-a")?.status, "uncertain");assert.equal(fixture.supervisorStore.task("tree-b")?.status, "waiting");
  const bTask = fixture.supervisorStore.task("tree-b")!;
  fixture.restart();const restored = fixture.makeSupervisor();
  const mismatch = await restored.retry({...retryInput("project-a", 0, a, "retry"), mainThreadId: "tree-b"}, AbortSignal.timeout(1000));
  assert.equal(mismatch.status, "conflict");assert.deepEqual(fixture.supervisorStore.task("tree-b"), bTask);
  assert.equal((await restored.snapshot("project-a", AbortSignal.timeout(1000), "tree-b")).binding?.threadId, b.threadId);
  assert.equal((await restored.snapshot("project-a", AbortSignal.timeout(1000), "tree-a")).tasks[0]?.threadId, "tree-a");
  assert.ok(fixture.operations.filter(call => call.tag === "orchestration.launchThread").every(call => (call.payload.workspaceStrategy as {type: string}).type === "root"));
});

test("a native keep-active choice does not restore stale binding creation state", async t => {
  const fixture = await makeFixture([{threadId: "pinned-source", projectId: "project-a", turns: [{id: "pin-task", sequence: 11, text: "Implement a task"}]}]);
  t.after(fixture.cleanup);const supervisor = fixture.makeSupervisor();await supervisor.runOnce();
  const binding = fixture.supervisorStore.binding("project-a", "pinned-source")!;
  fixture.supervisorStore.setBinding({...binding, state: "uncertain"});
  fixture.projections.get(binding.threadId)!.thread.settledOverride = "active";
  await supervisor.runOnce();
  assert.equal(fixture.supervisorStore.binding("project-a", "pinned-source")?.state, "ready");
  assert.equal(fixture.supervisorStore.binding("project-a", "pinned-source")?.manualKeepActive, true);
});


test("an independent fork remains eligible when its old parent is absent from the active catalog", async t => {
  const fixture = await makeFixture([{threadId: "fork-main", projectId: "project-a", turns: [{id: "fork-task", sequence: 11, text: "Implement separately"}]}]);
  t.after(fixture.cleanup);fixture.projections.get("fork-main")!.thread.lineage = {parentThreadId: "archived-parent", relationshipToParent: "fork", rootThreadId: "historical-root"};
  await fixture.makeSupervisor().runOnce();assert.equal(fixture.supervisorStore.task("fork-main")?.status, "waiting");
  assert.ok(fixture.supervisorStore.binding("project-a", "fork-main"));
});

test("repeated short passes rotate past a hung Supervisor and keep later mains progressing", async t => {
  const initial = Array.from({length: 9}, (_, index) => ({threadId: `main-${index}`, projectId: "project-a", turns: [{id: `old-${index}`, sequence: 9, text: "Old task"}]}));
  const fixture = await makeFixture(initial);t.after(fixture.cleanup);
  const ids = new Map<string, string>();const touched = new Set<string>();
  for (const item of initial) {
    const binding = {...fixture.supervisorStore.reserve("project-a", item.threadId, item.threadId, defaultSupervisorModel, 10, Date.now()), state: "ready" as const};
    fixture.supervisorStore.setBinding(binding);ids.set(binding.threadId, item.threadId);
    fixture.projections.set(binding.threadId, emptySupervisorProjection(binding.threadId, "project-a", defaultSupervisorModel));
  }
  const supervisor = fixture.makeSupervisor();const original = supervisor.t3.projection;
  t.mock.method(supervisor.t3, "projection", (id: string) => {
    const main = ids.get(id);if (main) touched.add(main);
    return main === "main-0" ? Effect.never : original(id);
  });
  for (let attempt = 0; attempt < 3; attempt++) await supervisor.runOnce(AbortSignal.timeout(25));
  assert.equal(touched.size, 9, "the same slow first binding must not permanently hide tail mains");
});
