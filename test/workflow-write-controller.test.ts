import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GuidanceStore } from "../src/guidance-store.js";
import { defaultSupervisorModel, ProjectSupervisorStore, type BindingRecord } from "../src/project-supervisor-store.js";
import type { Projection, ThreadInfo } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import type { WorkflowApplyInput, WorkflowOwner } from "../src/workflow-state-contract.js";
import { WorkflowWriteController, workflowReadToolDefinition, workflowWriteToolDefinition, type WorkflowApplyPatch, type WorkflowNativeAccess } from "../src/workflow-write-controller.js";
import { workflowToolInputMaxBytes, workflowToolInputSize, workflowToolNames, workflowTurnItemDetailMaxBytes } from "../src/workflow-write-evidence.js";

type Fixture = {
  directory: string;
  guidance: GuidanceStore;
  supervisors: ProjectSupervisorStore;
  workflows: WorkflowStateStore;
  controller: WorkflowWriteController;
  owner: WorkflowOwner;
  binding: BindingRecord;
  projectId: string;
  mainThreadId: string;
  supervisorThreadId: string;
  threads: ThreadInfo[];
  projection: Projection;
  projections: Map<string, Projection>;
  details: Map<string, unknown>;
  projectionCalls: string[];
  detailCalls: string[];
  native: WorkflowNativeAccess;
};

const thread = (id: string, projectId: string, parentThreadId: string | null = null, relationshipToParent: string | null = null,
  rootThreadId?: string): ThreadInfo => ({id, title: id, projectId, archivedAt: null, deletedAt: null,
  lineage: {parentThreadId, relationshipToParent,
    ...(rootThreadId ? {rootThreadId} : {})}});

const makeProjection = (supervisorThreadId: string, projectId: string): Projection => ({
  thread: thread(supervisorThreadId, projectId),
  runs: [],
  messages: [],
  nodes: [],
  turnItems: [],
});

const makeFixture = async (mainThread = thread("main-workflows", "project-workflows")): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-write-controller-test-"));
  const guidance = new GuidanceStore(directory);
  const supervisors = new ProjectSupervisorStore(guidance, new Set());
  const projectId = "project-workflows";
  const mainThreadId = mainThread.id;
  const supervisorControl = (scope: string | null, enabled: boolean) => guidance.db.prepare(
    "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(`supervisor_control:${JSON.stringify(scope)}`, JSON.stringify({generation: 1, enabled, manual: true}));
  supervisorControl(null, true);
  supervisorControl(projectId, true);
  const reserved = supervisors.reserve(projectId, mainThreadId, "Main thread", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  supervisors.setBinding(binding);
  const workflows = new WorkflowStateStore(supervisors, id => supervisors.enabled(id));
  const supervisorThreadId = binding.threadId;
  const threads = [mainThread, thread(supervisorThreadId, projectId)];
  const projection = makeProjection(supervisorThreadId, projectId);
  const projections = new Map([[supervisorThreadId, projection]]);
  const details = new Map<string, unknown>();
  const projectionCalls: string[] = [];
  const detailCalls: string[] = [];
  const native: WorkflowNativeAccess = {
    listThreads: async () => threads,
    projection: async id => {
      projectionCalls.push(id);
      const current = projections.get(id);
      if (!current) throw new Error("unexpected_projection");
      return current;
    },
    getTurnItem: async ({itemId}) => {
      detailCalls.push(itemId);
      return {item: details.get(itemId) ?? null};
    },
  };
  const controller = new WorkflowWriteController({supervisors, workflows, native, isEnabled: id => supervisors.enabled(id), maxEvidenceWaitMs: 0});
  return {directory, guidance, supervisors, workflows, controller,
    owner: {projectId, mainThreadId, supervisorThreadId, bindingGeneration: binding.generation}, binding,
    projectId, mainThreadId, supervisorThreadId, threads, projection, projections, details, projectionCalls, detailCalls, native};
};

const closeFixture = async (fixture: Fixture): Promise<void> => {
  fixture.guidance.close();
  await rm(fixture.directory, {recursive: true, force: true});
};

const locator = (fixture: Fixture) => ({
  supervisorThreadId: fixture.supervisorThreadId,
  bindingGeneration: fixture.binding.generation,
});

const ensureArgs = (fixture: Fixture, operationId: string, note: string) => ({
  action: "ensure_main",
  ...locator(fixture),
  operationId,
  note,
});

const installEvidence = (fixture: Fixture, args: Record<string, unknown>, options: {
  itemId?: string;
  input?: unknown;
  toolName?: string;
  nodeKind?: string;
  status?: string;
  runStatus?: string;
  rootNodeStatus?: string;
  toolNodeStatus?: string;
  parentItemId?: string | null;
  runId?: string;
  providerThreadId?: string;
  appRunOrdinal?: number;
  snapshotInput?: unknown;
  driver?: string;
} = {}): string => {
  const itemId = options.itemId ?? `workflow-tool-${fixture.details.size + 1}`;
  const runId = options.runId ?? "supervisor-run-current";
  const providerThreadId = options.providerThreadId ?? "provider-thread-current";
  const rootNodeId = "supervisor-root";
  const nodeId = `node-${itemId}`;
  const toolName = options.toolName ?? workflowToolNames.write.direct[0];
  const input = options.input ?? args;
  const detail = {
    id: itemId,
    type: "dynamic_tool",
    threadId: fixture.supervisorThreadId,
    runId,
    nodeId,
    providerThreadId,
    providerTurnId: "provider-turn-current",
    nativeItemRef: {driver: options.driver ?? "codex", nativeId: `native-${itemId}`, strength: "strong"},
    parentItemId: options.parentItemId === undefined ? null : options.parentItemId,
    ordinal: 100 + fixture.details.size,
    status: options.status ?? "completed",
    toolNonExecutionKind: null,
    toolName,
    input,
  };
  fixture.details.set(itemId, detail);
  fixture.projection.runs = [{id: runId, ordinal: options.appRunOrdinal ?? 1, status: options.runStatus ?? "completed", requestedAt: "2026-10-14T00:00:00.000Z",
    startedAt: "2026-10-14T00:00:00.000Z", completedAt: "2026-10-14T00:00:01.000Z", rootNodeId,
    threadId: fixture.supervisorThreadId, providerThreadId}];
  fixture.projection.nodes = [
    {id: rootNodeId, kind: "root_turn", threadId: fixture.supervisorThreadId, runId, rootNodeId,
      providerThreadId, parentNodeId: null, status: options.rootNodeStatus ?? "completed"},
    {id: nodeId, kind: options.nodeKind ?? "dynamic_tool", threadId: fixture.supervisorThreadId, runId, rootNodeId,
      providerThreadId, parentNodeId: rootNodeId, status: options.toolNodeStatus ?? options.status ?? "completed"},
  ];
  fixture.projection.turnItems = [{id: itemId, type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId,
    nodeId, providerThreadId, parentItemId: null, ordinal: 100 + fixture.details.size, status: options.status ?? "completed", toolName,
    input: options.snapshotInput ?? (typeof input === "string" ? input : "snapshot-summary")}];
  return itemId;
};

const installMcpXEvidence = (fixture: Fixture, args: Record<string, unknown>, itemId?: string): string =>
  installEvidence(fixture, args, {...(itemId ? {itemId} : {}), toolName: workflowToolNames.mcpxCall[0],
    input: {name: workflowToolNames.write.mcpxTarget, arguments: args}});

const applyArgs = (fixture: Fixture, input: WorkflowApplyPatch) => ({
  action: "apply",
  ...locator(fixture),
  input,
});

test("unverified JSON stays pending without reserving an operation and a verified retry applies", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "forged-op", "Create a main workflow.");
    const forged = await fixture.controller.write(args);
    assert.equal(forged.status, "pending");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts").get()?.n), 0);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_evidence").get()?.n), 0);

    installEvidence(fixture, args);
    const applied = await fixture.controller.write(args);
    assert.equal(applied.status, "created");
    assert.ok(fixture.workflows.get(fixture.projectId, fixture.mainThreadId));
  } finally {await closeFixture(fixture);}
});

test("MCPX input unwrap is exact and the verified native item is stored with the mutation", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "mcpx-op", "Create through MCPX.");
    const itemId = installMcpXEvidence(fixture, args);
    const result = await fixture.controller.write(args);
    assert.equal(result.status, "created");
    const proof = fixture.guidance.db.prepare(
      "SELECT item_id,native_evidence,successful FROM supervisor_workflow_write_evidence WHERE operation_id=?",
    ).get("mcpx-op") as {item_id: string; native_evidence: string; successful: number} | undefined;
    assert.equal(proof?.item_id, itemId);
    assert.equal(proof?.successful, 1);
    const saved = JSON.parse(proof!.native_evidence) as {nativeInputCanonical: string; toolName: string};
    assert.equal(saved.toolName, workflowToolNames.mcpxCall[0]);
    assert.match(saved.nativeInputCanonical, /t3-supervisor-workflows__workflow_write/u);
  } finally {await closeFixture(fixture);}
});

test("AppRun order selects new-provider evidence ahead of older provider item ordinals", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "new-provider-evidence", "Use the current provider run.");
    const itemId = installEvidence(fixture, args, {itemId: "new-provider-item", runId: "app-run-new",
      providerThreadId: "provider-thread-new", appRunOrdinal: 44, snapshotInput: args});
    fixture.projection.runs.push({id: "app-run-old", ordinal: 43, status: "completed", requestedAt: "2026-10-13T00:00:00.000Z",
      startedAt: "2026-10-13T00:00:00.000Z", completedAt: "2026-10-13T00:00:01.000Z", rootNodeId: "old-root",
      threadId: fixture.supervisorThreadId, providerThreadId: "provider-thread-old"});
    for (let index = 0; index < 40; index++) fixture.projection.turnItems?.push({
      id: `old-provider-${index}`, type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId: "app-run-old",
      nodeId: `old-node-${index}`, providerThreadId: "provider-thread-old", ordinal: 600_000 + index,
      status: "completed", toolName: workflowToolNames.write.direct[0], input: "old provider summary",
    });
    assert.equal((await fixture.controller.write(args)).status, "created");
    assert.deepEqual(fixture.detailCalls, [itemId]);
  } finally {await closeFixture(fixture);}
});

test("complete snapshot inputs filter unrelated tools before detail RPCs", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "snapshot-prefilter", "Read only plausible native evidence.");
    const itemId = installEvidence(fixture, args, {itemId: "matching-snapshot-item", snapshotInput: args});
    for (let index = 0; index < 100; index++) fixture.projection.turnItems?.push({
      id: `unrelated-snapshot-${index}`, type: "dynamic_tool", threadId: fixture.supervisorThreadId,
      runId: "supervisor-run-current", nodeId: `unrelated-node-${index}`, providerThreadId: "provider-thread-current",
      ordinal: 1000 + index, status: "completed", toolName: workflowToolNames.write.direct[0],
      input: {...args, note: `unrelated-${index}`},
    });
    assert.equal((await fixture.controller.write(args)).status, "created");
    assert.deepEqual(fixture.detailCalls, [itemId]);
  } finally {await closeFixture(fixture);}
});

test("an oversized getTurnItem detail remains pending even when its snapshot arguments match", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "oversized-detail", "Do not authorize an oversized native detail.");
    const itemId = installEvidence(fixture, args, {itemId: "oversized-detail-item", snapshotInput: args});
    const detail = fixture.details.get(itemId) as Record<string, unknown>;
    detail.output = "x".repeat(280 * 1024);
    assert.equal((await fixture.controller.write(args)).status, "pending");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    assert.deepEqual(fixture.detailCalls, [itemId]);
  } finally {await closeFixture(fixture);}
});

test("a history of unrelated complete tool inputs causes no detail RPCs", async () => {
  const fixture = await makeFixture();
  try {
    const wanted = ensureArgs(fixture, "no-matching-snapshot", "Wait for a matching tool record.");
    const unrelated = ensureArgs(fixture, "unrelated-snapshot-only", "This is not the requested operation.");
    installEvidence(fixture, unrelated, {itemId: "unrelated-seed", snapshotInput: unrelated});
    for (let index = 0; index < 100; index++) fixture.projection.turnItems?.push({
      id: `unrelated-only-${index}`, type: "dynamic_tool", threadId: fixture.supervisorThreadId,
      runId: "supervisor-run-current", nodeId: `unrelated-only-node-${index}`, providerThreadId: "provider-thread-current",
      ordinal: 1000 + index, status: "completed", toolName: workflowToolNames.write.direct[0],
      input: {...unrelated, note: `not-the-current-input-${index}`},
    });
    assert.equal((await fixture.controller.write(wanted)).status, "pending");
    assert.deepEqual(fixture.detailCalls, []);
  } finally {await closeFixture(fixture);}
});

test("unrelated empty and rolled-back snapshot placeholders stay pending without detail lookups", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "wanted-current-evidence", "Only this exact call can authorize the write.");
    const other = ensureArgs(fixture, "stale-other-evidence", "This is a different request.");
    installEvidence(fixture, other, {itemId: "placeholder-seed", snapshotInput: other});
    fixture.projection.turnItems = [
      {id: "empty-placeholder", type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId: "supervisor-run-current",
        nodeId: "empty-node", providerThreadId: "provider-thread-current", ordinal: 900, status: "completed",
        toolName: workflowToolNames.write.direct[0], input: {}},
      {id: "stale-rolled-back", type: "dynamic_tool", threadId: fixture.supervisorThreadId, runId: "supervisor-run-current",
        nodeId: "rolled-back-node", providerThreadId: "provider-thread-current", ordinal: 901, status: "rolled_back",
        toolName: workflowToolNames.write.direct[0], input: other},
    ];
    assert.equal((await fixture.controller.write(args)).status, "pending");
    assert.deepEqual(fixture.detailCalls, []);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
  } finally {await closeFixture(fixture);}
});

test("a delayed current record becomes verifiable after fresh projection polling", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "delayed-current-record", "Wait for this current native record.");
    const originalProjection = fixture.native.projection;
    let polls = 0;
    fixture.native.projection = async (threadId, signal) => {
      polls++;
      if (polls === 3) installEvidence(fixture, args, {itemId: "delayed-current-item", snapshotInput: "x".repeat(20 * 1024)});
      return originalProjection(threadId, signal);
    };
    const controller = new WorkflowWriteController({supervisors: fixture.supervisors, workflows: fixture.workflows,
      native: fixture.native, isEnabled: id => fixture.supervisors.enabled(id), maxEvidenceWaitMs: 500});
    assert.equal((await controller.write(args)).status, "created");
    assert.ok(polls >= 3);
    assert.deepEqual(fixture.detailCalls, ["delayed-current-item"]);
  } finally {await closeFixture(fixture);}
});

test("unchanged inspected detail is cached throughout the pending window", async () => {
  const fixture = await makeFixture();
  try {
    const requested = ensureArgs(fixture, "pending-current", "Wait for matching evidence.");
    const unrelated = ensureArgs(fixture, "pending-other", "This evidence has a different request.");
    const itemId = installEvidence(fixture, unrelated, {itemId: "unchanged-mismatch", snapshotInput: "x".repeat(20 * 1024)});
    const controller = new WorkflowWriteController({supervisors: fixture.supervisors, workflows: fixture.workflows,
      native: fixture.native, isEnabled: id => fixture.supervisors.enabled(id)});
    assert.equal((await controller.write(requested)).status, "pending");
    assert.deepEqual(fixture.detailCalls, [itemId]);
  } finally {await closeFixture(fixture);}
});

test("rolled-back runs, roots, and tool nodes cannot authorize an old matching tool item", async () => {
  for (const [label, state] of [
    ["run", {runStatus: "rolled_back"}],
    ["root", {rootNodeStatus: "rolled_back"}],
    ["tool-node", {toolNodeStatus: "rolled_back"}],
    ["tool-item", {status: "rolled_back"}],
  ] as const) {
    const fixture = await makeFixture();
    try {
      const args = ensureArgs(fixture, `rolled-back-${label}`, "Do not apply an action from rolled-back history.");
      installEvidence(fixture, args, state);
      const result = await fixture.controller.write(args);
      assert.equal(result.status, "denied", label);
      assert.match(result.status === "denied" ? result.reason : "", /rolled_back/u);
      assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
      assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts").get()?.n), 0);
    } finally {await closeFixture(fixture);}
  }
});

test("only verified Codex native item references authorize workflow writes", async () => {
  for (const driver of ["claudeAgent", "future-provider"]) {
    const fixture = await makeFixture();
    try {
      const args = ensureArgs(fixture, `unsupported-driver-${driver}`, "Require a verified native source.");
      installEvidence(fixture, args, {driver});
      assert.deepEqual(await fixture.controller.write(args), {
        status: "denied", operationId: args.operationId, reason: "native_driver_unverified",
      });
      assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    } finally {await closeFixture(fixture);}
  }
  assert.match(workflowReadToolDefinition.description, /strong Codex native item references/u);
  assert.match(workflowWriteToolDefinition.description, /Claude Agent and unknown source labels are not authorized/u);
});

test("a child-thread tool record cannot authorize a write for the bound Supervisor", async () => {
  const fixture = await makeFixture();
  try {
    const childId = "helper-thread";
    fixture.threads.push(thread(childId, fixture.projectId, fixture.supervisorThreadId, "subagent", fixture.supervisorThreadId));
    const args = ensureArgs(fixture, "child-actor-op", "A helper cannot authorize this write.");
    installEvidence(fixture, args, {nodeKind: "subagent"});
    const result = await fixture.controller.write(args);
    assert.equal(result.status, "denied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
    assert.deepEqual(fixture.projectionCalls, [fixture.supervisorThreadId]);
  } finally {await closeFixture(fixture);}
});

test("empty and truncated detail inputs stay pending without authorizing a write", async () => {
  for (const input of ["truncated native input", {}]) {
    const fixture = await makeFixture();
    try {
      const args = ensureArgs(fixture, `bad-input-${typeof input}`, "Reject incomplete evidence.");
      installEvidence(fixture, args, {input});
      const result = await fixture.controller.write(args);
      assert.equal(result.status, "pending");
      assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
      assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts").get()?.n), 0);
    } finally {await closeFixture(fixture);}
  }
});

test("write arguments above the inline-input bound are rejected before native reads", async () => {
  const fixture = await makeFixture();
  try {
    const input = {
      operationId: "oversized-apply",
      workflowId: "workflow-not-created",
      expectedRevision: 1,
      status: "planned",
      objective: "O".repeat(2000),
      rules: Array.from({length: 100}, (_, index) => ({index, name: `Rule ${index} ${"N".repeat(1000)}`,
        applies: true, reason: "R".repeat(1000)})),
      steps: Array.from({length: 8}, (_, index) => ({blockId: null, name: `Step ${index} ${"N".repeat(1500)}`,
        reason: "R".repeat(1500), status: "planned", contributorThreadIds: [fixture.mainThreadId]})),
      note: "Reject before looking up native evidence.",
    };
    const args = applyArgs(fixture, input as WorkflowApplyInput);
    assert.ok(workflowToolInputSize(args) > workflowToolInputMaxBytes);
    const result = await fixture.controller.write(args);
    assert.deepEqual(result, {status: "invalid", reason: "arguments_too_large"});
    assert.deepEqual(fixture.projectionCalls, []);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
  } finally {await closeFixture(fixture);}
});

test("disabled and replaced bindings deny old owner locators", async () => {
  const fixture = await makeFixture();
  try {
    const disabledArgs = ensureArgs(fixture, "disabled-op", "Do not write while disabled.");
    fixture.guidance.db.prepare("UPDATE meta SET value=? WHERE key=?").run(
      JSON.stringify({generation: 2, enabled: false, manual: true}), `supervisor_control:${JSON.stringify(fixture.projectId)}`);
    installEvidence(fixture, disabledArgs);
    assert.equal((await fixture.controller.write(disabledArgs)).status, "denied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);

    fixture.guidance.db.prepare("UPDATE meta SET value=? WHERE key=?").run(
      JSON.stringify({generation: 3, enabled: true, manual: true}), `supervisor_control:${JSON.stringify(fixture.projectId)}`);
    const replacement = {...fixture.binding, threadId: "replacement-supervisor", generation: fixture.binding.generation + 1, state: "ready" as const};
    fixture.supervisors.setBinding(replacement);
    assert.equal((await fixture.controller.write(disabledArgs)).status, "denied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
  } finally {await closeFixture(fixture);}
});

test("an incompatible main-scope version disables the default controller without resetting ownership", async () => {
  const fixture = await makeFixture();
  try {
    Object.defineProperty(fixture.supervisors, "scopeCompatible", {value: false});
    const controller = new WorkflowWriteController({
      supervisors: fixture.supervisors,
      workflows: fixture.workflows,
      native: fixture.native,
      maxEvidenceWaitMs: 0,
    });
    const args = ensureArgs(fixture, "incompatible-scope-op", "Do not write under an unsupported scope version.");
    installEvidence(fixture, args);
    assert.deepEqual(await controller.write(args), {
      status: "denied", operationId: "incompatible-scope-op", reason: "owner_not_current_ready_enabled",
    });
    assert.deepEqual(fixture.projectionCalls, []);
    assert.equal(fixture.supervisors.binding(fixture.projectId, fixture.mainThreadId)?.threadId, fixture.supervisorThreadId);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
  } finally {await closeFixture(fixture);}
});

test("independent and foreign children cannot be linked", async () => {
  for (const child of [
    thread("independent-child", "project-workflows", "independent-root", "subagent", "independent-root"),
    thread("foreign-child", "project-foreign", "main-workflows", "subagent", "main-workflows"),
  ]) {
    const fixture = await makeFixture();
    try {
      fixture.threads.push(child);
      const args = {action: "link_child", ...locator(fixture), operationId: `link-${child.id}`, childThreadId: child.id,
        note: "Try linking this thread."};
      installEvidence(fixture, args);
      const result = await fixture.controller.write(args);
      assert.equal(result.status, "denied");
      assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId), null);
      assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, child.id), null);
    } finally {await closeFixture(fixture);}
  }
});

test("a fork can own a workflow and subagent descendants in its own logical scope", async () => {
  const projectId = "project-workflows";
  const ancestor = thread("ancestor-main", projectId);
  const forkMain = thread("fork-main", projectId, ancestor.id, "fork", ancestor.id);
  const forkChild = thread("fork-child", projectId, forkMain.id, "subagent", ancestor.id);
  const fixture = await makeFixture(forkMain);
  try {
    fixture.threads.unshift(ancestor);
    fixture.threads.push(forkChild);
    const ensure = ensureArgs(fixture, "fork-main-draft", "Create the fork-owned workflow.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");

    const link = {action: "link_child", ...locator(fixture), operationId: "fork-child-link",
      childThreadId: forkChild.id, note: "Create a child workflow within this fork scope."};
    installEvidence(fixture, link);
    assert.equal((await fixture.controller.write(link)).status, "created");

    const read = await fixture.controller.read({...locator(fixture), limit: 10});
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    assert.deepEqual(read.lineage.map(item => item.threadId), [forkMain.id, forkChild.id]);
    assert.ok(fixture.workflows.get(projectId, forkMain.id, forkChild.id));
  } finally {await closeFixture(fixture);}
});

test("an ancestor owner cannot link a fork's subagent descendant", async () => {
  const fixture = await makeFixture();
  try {
    const forkMain = thread("independent-fork", fixture.projectId, fixture.mainThreadId, "fork", fixture.mainThreadId);
    const forkChild = thread("fork-subagent", fixture.projectId, forkMain.id, "subagent", fixture.mainThreadId);
    fixture.threads.push(forkMain, forkChild);
    const args = {action: "link_child", ...locator(fixture), operationId: "ancestor-cross-fork-link",
      childThreadId: forkChild.id, note: "This descendant belongs to the fork owner."};
    installEvidence(fixture, args);
    assert.deepEqual(await fixture.controller.write(args), {
      status: "denied", operationId: "ancestor-cross-fork-link", reason: "child_not_current_native_descendant",
    });
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, forkChild.id), null);
  } finally {await closeFixture(fixture);}
});

test("successful exact replays survive projection windowing and operation ID reuse conflicts", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "replay-op", "Create once.");
    installEvidence(fixture, args);
    const created = await fixture.controller.write(args);
    assert.equal(created.status, "created");
    fixture.projection.turnItems = [];
    const replay = await fixture.controller.write(args);
    assert.deepEqual(replay, created);
    const reused = await fixture.controller.write({...args, note: "Different input under the same operation ID."});
    assert.deepEqual(reused, {status: "conflict", operationId: "replay-op", reason: "operation_id_reused", currentRevision: null});
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.evidence.length, 1);
  } finally {await closeFixture(fixture);}
});

test("the same edit operation ID is isolated across Supervisor owners", async () => {
  const fixture = await makeFixture();
  try {
    const firstArgs = ensureArgs(fixture, "shared-edit-id", "Create the first owner's draft.");
    installEvidence(fixture, firstArgs);
    const first = await fixture.controller.write(firstArgs);
    assert.equal(first.status, "created");

    const secondMain = thread("second-main-workflows", fixture.projectId);
    const secondReserved = fixture.supervisors.reserve(fixture.projectId, secondMain.id, "Second main", defaultSupervisorModel, 1, 1);
    const secondBinding = {...secondReserved, state: "ready" as const};
    fixture.supervisors.setBinding(secondBinding);
    const secondProjection = makeProjection(secondBinding.threadId, fixture.projectId);
    fixture.projections.set(secondBinding.threadId, secondProjection);
    fixture.threads.push(secondMain, thread(secondBinding.threadId, fixture.projectId));
    fixture.mainThreadId = secondMain.id;
    fixture.supervisorThreadId = secondBinding.threadId;
    fixture.binding = secondBinding;
    fixture.owner = {projectId: fixture.projectId, mainThreadId: secondMain.id, supervisorThreadId: secondBinding.threadId,
      bindingGeneration: secondBinding.generation};
    fixture.projection = secondProjection;

    const secondArgs = ensureArgs(fixture, "shared-edit-id", "Create the second owner's draft.");
    installEvidence(fixture, secondArgs);
    const second = await fixture.controller.write(secondArgs);
    assert.equal(second.status, "created");
    if (first.status !== "created" || second.status !== "created") return;
    assert.notEqual(first.workflowId, second.workflowId);
    assert.equal(Number(fixture.guidance.db.prepare(
      "SELECT count(*) AS n FROM supervisor_workflow_write_receipts WHERE operation_id=? AND operation_namespace='edit'",
    ).get("shared-edit-id")?.n), 2);
  } finally {await closeFixture(fixture);}
});

test("apply uses owner-scoped lookup and revision CAS without dropping contributors", async () => {
  const fixture = await makeFixture();
  try {
    const mainArgs = ensureArgs(fixture, "cas-create", "Create a workflow before editing.");
    installEvidence(fixture, mainArgs);
    const created = await fixture.controller.write(mainArgs);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const input: WorkflowApplyInput = {
      operationId: "cas-apply",
      workflowId: created.workflowId,
      expectedRevision: created.revision,
      status: "planned",
      objective: "Track the export workflow.",
      rules: [],
      steps: [{blockId: null, name: "Inspect exporter", reason: "Find the current path.", status: "planned",
        contributorThreadIds: [fixture.mainThreadId]}],
      note: "Add the first implementation step.",
    };
    const args = applyArgs(fixture, input);
    installEvidence(fixture, args);
    const applied = await fixture.controller.write(args);
    assert.equal(applied.status, "applied");
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(current.steps[0]?.contributorThreadIds[0], fixture.mainThreadId);

    const staleInput = {...input, operationId: "cas-stale", expectedRevision: 1, note: "A stale revision."};
    const staleArgs = applyArgs(fixture, staleInput);
    installEvidence(fixture, staleArgs);
    const stale = await fixture.controller.write(staleArgs);
    assert.deepEqual(stale, {status: "conflict", operationId: "cas-stale", reason: "revision", currentRevision: 2});
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, 2);
    assert.equal(Number(fixture.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_write_receipts WHERE operation_id='cas-stale'").get()?.n), 0);
  } finally {await closeFixture(fixture);}
});

test("a partial apply keeps every omitted plan field from the current CAS revision", async () => {
  const fixture = await makeFixture();
  try {
    const ensure = ensureArgs(fixture, "partial-create", "Create a draft before a partial edit.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const full: WorkflowApplyInput = {
      operationId: "partial-initial-plan",
      workflowId: created.workflowId,
      expectedRevision: created.revision,
      status: "planned",
      objective: "Keep the original objective.",
      rules: [{index: 0, name: "Preserve behavior", applies: true, reason: "Required for this plan."}],
      steps: [{blockId: null, name: "Inspect current flow", reason: "Keep this step intact.", status: "planned",
        contributorThreadIds: [fixture.mainThreadId]}],
      note: "Record the complete starting plan.",
    };
    const fullArgs = applyArgs(fixture, full);
    installEvidence(fixture, fullArgs);
    assert.equal((await fixture.controller.write(fullArgs)).status, "applied");
    const before = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;

    const partial = {operationId: "partial-objective-only", workflowId: before.workflowId,
      expectedRevision: before.revision, objective: "Change only the objective.", note: "Leave other fields unchanged."};
    const partialArgs = applyArgs(fixture, partial);
    installEvidence(fixture, partialArgs);
    assert.equal((await fixture.controller.write(partialArgs)).status, "applied");
    const after = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(after.objective, "Change only the objective.");
    assert.equal(after.status, before.status);
    assert.deepEqual(after.rules, before.rules);
    assert.deepEqual(after.steps, before.steps);
    assert.equal(after.revision, before.revision + 1);
  } finally {await closeFixture(fixture);}
});

test("a 40-rule and 12-step plan larger than 16 KiB remains editable", async () => {
  const fixture = await makeFixture();
  try {
    const ensure = ensureArgs(fixture, "large-plan-create", "Create a draft for the imported plan.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const input: WorkflowApplyInput = {
      operationId: "large-plan-apply",
      workflowId: created.workflowId,
      expectedRevision: created.revision,
      status: "planned",
      objective: `Import the plan ${"O".repeat(900)}`,
      rules: Array.from({length: 40}, (_, index) => ({index, name: `Rule ${index} ${"N".repeat(1900)}`,
        applies: true, reason: `Rule rationale ${"R".repeat(1900)}`})),
      steps: Array.from({length: 12}, (_, index) => ({blockId: null, name: `Step ${index} ${"S".repeat(1500)}`,
        reason: `Step rationale ${"T".repeat(1500)}`, status: "planned" as const, contributorThreadIds: [fixture.mainThreadId]})),
      note: "Import the full plan without dropping rule or step detail.",
    };
    const args = applyArgs(fixture, input);
    const bytes = workflowToolInputSize(args);
    assert.ok(bytes > 16 * 1024);
    assert.ok(bytes > 185 * 1024);
    assert.ok(bytes < workflowToolInputMaxBytes);
    fixture.detailCalls.length = 0;
    installEvidence(fixture, args, {itemId: "large-plan-item", snapshotInput: "x".repeat(20 * 1024)});
    const detailBytes = Buffer.byteLength(JSON.stringify(fixture.details.get("large-plan-item")), "utf8");
    assert.ok(detailBytes > 185 * 1024);
    assert.ok(detailBytes < workflowTurnItemDetailMaxBytes);
    assert.equal((await fixture.controller.write(args)).status, "applied");
    const saved = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(saved.rules.length, 40);
    assert.equal(saved.steps.length, 12);
    assert.deepEqual(fixture.detailCalls, ["large-plan-item"]);
  } finally {await closeFixture(fixture);}
});

test("workflow read exposes bounded live lineage and every shared parent-step reference", async () => {
  const fixture = await makeFixture();
  try {
    const childA = thread("child-a", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    const childB = thread("child-b", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    fixture.threads.push(childA, childB);
    const ensure = ensureArgs(fixture, "association-main", "Create the parent workflow.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    for (const [childId, operationId] of [[childA.id, "association-child-a"], [childB.id, "association-child-b"]]) {
      const linkArgs = {action: "link_child", ...locator(fixture), operationId, childThreadId: childId,
        note: `Link ${childId} to the live parent.`};
      installEvidence(fixture, linkArgs);
      assert.equal((await fixture.controller.write(linkArgs)).status, "created");
    }

    const parentInput: WorkflowApplyInput = {
      operationId: "association-parent-steps",
      workflowId: created.workflowId,
      expectedRevision: 1,
      status: "planned",
      objective: "Coordinate two children.",
      rules: [],
      steps: [
        {blockId: null, name: "Inspect output", reason: "One child checks the shape.", status: "planned", contributorThreadIds: [childA.id, childB.id]},
        {blockId: null, name: "Review edge cases", reason: "The same child checks another area.", status: "planned", contributorThreadIds: [childA.id]},
      ],
      note: "Keep shared child associations on the parent steps.",
    };
    const parentArgs = applyArgs(fixture, parentInput);
    installEvidence(fixture, parentArgs);
    assert.equal((await fixture.controller.write(parentArgs)).status, "applied");

    const read = await fixture.controller.read({...locator(fixture), limit: 10});
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    assert.deepEqual(read.lineage.map(item => item.threadId), [fixture.mainThreadId, childA.id, childB.id]);
    const a = read.workflows.find(item => item.document.threadId === childA.id)!;
    const b = read.workflows.find(item => item.document.threadId === childB.id)!;
    assert.deepEqual(a.parentStepReferences.map(step => step.stepName), ["Inspect output", "Review edge cases"]);
    assert.deepEqual(b.parentStepReferences.map(step => step.stepName), ["Inspect output"]);
    assert.equal(a.parentStepReferences[0]?.parentWorkflowId, created.workflowId);

    const childWorkflow = a.document;
    const childInput: WorkflowApplyInput = {
      operationId: "association-child-expansion",
      workflowId: childWorkflow.workflowId,
      expectedRevision: childWorkflow.revision,
      status: "underway",
      objective: "Break output inspection into child tasks.",
      rules: [],
      steps: [{blockId: null, name: "Check columns", reason: "Validate the output headers.", status: "planned", contributorThreadIds: [childA.id]}],
      note: "Expand the child subflow independently.",
      evidence: [{kind: "status_changed", note: "The child subflow started."}],
    };
    const childArgs = applyArgs(fixture, childInput);
    installEvidence(fixture, childArgs);
    const childUpdate = await fixture.controller.write(childArgs);
    assert.equal(childUpdate.status, "applied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, 2);
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, childA.id)?.steps[0]?.name, "Check columns");
  } finally {await closeFixture(fixture);}
});

test("workflow read reports an oversized selected legacy document instead of omitting it", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "oversized-read-create", "Create a main workflow.");
    installEvidence(fixture, args);
    const created = await fixture.controller.write(args);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const legacyDocument = {...current, objective: "L".repeat(1_100_000)};
    fixture.guidance.db.prepare("UPDATE supervisor_workflow_state SET document=? WHERE workflow_id=?")
      .run(JSON.stringify(legacyDocument), current.workflowId);
    assert.deepEqual(await fixture.controller.read({...locator(fixture), workflowId: current.workflowId, limit: 1}), {
      status: "too_large", reason: "workflow_read_exceeds_response_limit",
    });
  } finally {await closeFixture(fixture);}
});

test("archived descendants stay owned for reads and semantic edits but cannot gain new work", async () => {
  const fixture = await makeFixture();
  try {
    const archivedChild = thread("archived-child", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    fixture.threads.push(archivedChild);
    const ensure = ensureArgs(fixture, "archive-main-draft", "Create the parent workflow.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const link = {action: "link_child", ...locator(fixture), operationId: "archive-child-link",
      childThreadId: archivedChild.id, note: "Link this live child before it is archived."};
    installEvidence(fixture, link);
    assert.equal((await fixture.controller.write(link)).status, "created");
    const parentPlan: WorkflowApplyInput = {
      operationId: "archive-parent-plan",
      workflowId: created.workflowId,
      expectedRevision: 1,
      status: "planned",
      objective: "Coordinate the child work.",
      rules: [],
      steps: [{blockId: null, name: "Inspect the result", reason: "The child owns this check.", status: "planned",
        contributorThreadIds: [archivedChild.id]}],
      note: "Record the parent association.",
    };
    const parentPlanArgs = applyArgs(fixture, parentPlan);
    installEvidence(fixture, parentPlanArgs);
    assert.equal((await fixture.controller.write(parentPlanArgs)).status, "applied");

    const childDocument = fixture.workflows.get(fixture.projectId, fixture.mainThreadId, archivedChild.id)!;
    const childPlan: WorkflowApplyInput = {
      operationId: "archive-child-plan",
      workflowId: childDocument.workflowId,
      expectedRevision: childDocument.revision,
      status: "planned",
      objective: "Keep a child-owned subflow.",
      rules: [],
      steps: [{blockId: null, name: "Review inputs", reason: "Keep the prior contributor association.", status: "planned",
        contributorThreadIds: [archivedChild.id]}],
      note: "Create the child plan while its thread is live.",
    };
    const childPlanArgs = applyArgs(fixture, childPlan);
    installEvidence(fixture, childPlanArgs);
    assert.equal((await fixture.controller.write(childPlanArgs)).status, "applied");

    archivedChild.archivedAt = "2026-10-14T21:00:00.000Z";
    const grandchild = thread("live-grandchild", fixture.projectId, archivedChild.id, "subagent", fixture.mainThreadId);
    fixture.threads.push(grandchild);
    const read = await fixture.controller.read({...locator(fixture), limit: 10});
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    assert.deepEqual(read.lineage.map(item => item.threadId), [fixture.mainThreadId, archivedChild.id, grandchild.id]);
    assert.equal(read.lineage.find(item => item.threadId === archivedChild.id)?.archivedAt, archivedChild.archivedAt);

    const parent = read.workflows.find(item => item.document.threadId === fixture.mainThreadId)!.document;
    const parentUpdate = applyArgs(fixture, {operationId: "archive-parent-objective", workflowId: parent.workflowId,
      expectedRevision: parent.revision, objective: "Keep the retained child association.", note: "Update parent semantics only."});
    installEvidence(fixture, parentUpdate);
    assert.equal((await fixture.controller.write(parentUpdate)).status, "applied");
    assert.deepEqual(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.steps[0]?.contributorThreadIds, [archivedChild.id]);

    const archivedWorkflow = fixture.workflows.get(fixture.projectId, fixture.mainThreadId, archivedChild.id)!;
    const archivedUpdate = applyArgs(fixture, {operationId: "archive-child-objective", workflowId: archivedWorkflow.workflowId,
      expectedRevision: archivedWorkflow.revision, status: "underway", objective: "Edit the retained child workflow.",
      evidence: [{kind: "status_changed", note: "Resume the retained plan status."}], note: "Change child semantics after archive."});
    installEvidence(fixture, archivedUpdate);
    assert.equal((await fixture.controller.write(archivedUpdate)).status, "applied");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, archivedChild.id)?.objective,
      "Edit the retained child workflow.");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId, archivedChild.id)?.status, "underway");

    const archivedLink = {action: "link_child", ...locator(fixture), operationId: "archive-child-relink",
      childThreadId: archivedChild.id, note: "Do not create new links to archived chats."};
    installEvidence(fixture, archivedLink);
    assert.equal((await fixture.controller.write(archivedLink)).status, "denied");

    const unlinkedArchived = thread("new-archived-child", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    unlinkedArchived.archivedAt = "2026-10-14T21:01:00.000Z";
    fixture.threads.push(unlinkedArchived);
    const newArchivedLink = {action: "link_child", ...locator(fixture), operationId: "new-archived-link",
      childThreadId: unlinkedArchived.id, note: "Do not link newly archived work."};
    installEvidence(fixture, newArchivedLink);
    assert.equal((await fixture.controller.write(newArchivedLink)).status, "denied");

    const currentParent = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const moveArchivedContributor = applyArgs(fixture, {operationId: "archive-contributor-move", workflowId: currentParent.workflowId,
      expectedRevision: currentParent.revision, steps: [
        {...currentParent.steps[0]!, contributorThreadIds: [fixture.mainThreadId]},
        {blockId: null, name: "New archived work", reason: "An archived child cannot move to a new step.", status: "planned",
          contributorThreadIds: [archivedChild.id]},
      ], note: "Do not move a retained archived contributor to another step."});
    installEvidence(fixture, moveArchivedContributor);
    assert.deepEqual(await fixture.controller.write(moveArchivedContributor), {
      status: "denied", operationId: "archive-contributor-move", reason: "new_contributor_not_live",
    });

    const currentAfterMove = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const removeArchivedContributor = applyArgs(fixture, {operationId: "archive-contributor-remove", workflowId: currentAfterMove.workflowId,
      expectedRevision: currentAfterMove.revision, steps: [
        {...currentAfterMove.steps[0]!, contributorThreadIds: [fixture.mainThreadId]},
      ], note: "Remove an archived contributor from its original step."});
    installEvidence(fixture, removeArchivedContributor);
    assert.equal((await fixture.controller.write(removeArchivedContributor)).status, "applied");

    const currentAfterRemoval = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const readdArchivedContributor = applyArgs(fixture, {operationId: "archive-contributor-readd", workflowId: currentAfterRemoval.workflowId,
      expectedRevision: currentAfterRemoval.revision, steps: [
        {...currentAfterRemoval.steps[0]!, contributorThreadIds: [archivedChild.id]},
      ], note: "Do not re-add an archived contributor after removing it."});
    installEvidence(fixture, readdArchivedContributor);
    assert.deepEqual(await fixture.controller.write(readdArchivedContributor), {
      status: "denied", operationId: "archive-contributor-readd", reason: "new_contributor_not_live",
    });

    const parentAfterRemoval = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const addArchivedContributor = applyArgs(fixture, {operationId: "new-archived-contributor", workflowId: currentParent.workflowId,
      expectedRevision: parentAfterRemoval.revision, steps: [
        {...parentAfterRemoval.steps[0]!, contributorThreadIds: [fixture.mainThreadId]},
        {blockId: null, name: "New archived work", reason: "This contributor was not already present.", status: "planned",
          contributorThreadIds: [unlinkedArchived.id]},
      ], note: "Do not add an archived contributor."});
    installEvidence(fixture, addArchivedContributor);
    assert.deepEqual(await fixture.controller.write(addArchivedContributor), {
      status: "denied", operationId: "new-archived-contributor", reason: "new_contributor_not_live",
    });

    const main = fixture.threads.find(item => item.id === fixture.mainThreadId)!;
    main.archivedAt = "2026-10-14T21:02:00.000Z";
    assert.equal((await fixture.controller.read({...locator(fixture)})).status, "unavailable");
  } finally {await closeFixture(fixture);}
});

test("partial status edits retain contributors whose child is no longer in the current thread inventory", async () => {
  const fixture = await makeFixture();
  try {
    const child = thread("deleted-contributor", fixture.projectId, fixture.mainThreadId, "subagent", fixture.mainThreadId);
    fixture.threads.push(child);
    const ensure = ensureArgs(fixture, "deleted-contributor-create", "Create the parent workflow.");
    installEvidence(fixture, ensure);
    const created = await fixture.controller.write(ensure);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const initialPlan = applyArgs(fixture, {operationId: "deleted-contributor-plan", workflowId: created.workflowId,
      expectedRevision: created.revision, status: "planned", objective: "Retain the planned association.", rules: [],
      steps: [{blockId: null, name: "Review child output", reason: "The child was live when assigned.", status: "planned",
        contributorThreadIds: [child.id]}], note: "Associate the live descendant with this step."});
    installEvidence(fixture, initialPlan);
    assert.equal((await fixture.controller.write(initialPlan)).status, "applied");

    child.deletedAt = "2026-10-14T21:05:00.000Z";
    fixture.threads.splice(fixture.threads.indexOf(child), 1);
    const current = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    const partial = applyArgs(fixture, {operationId: "deleted-contributor-status", workflowId: current.workflowId,
      expectedRevision: current.revision, status: "underway", evidence: [{kind: "status_changed", note: "The parent work started."}],
      note: "Change parent status without removing the deleted child association."});
    installEvidence(fixture, partial);
    assert.equal((await fixture.controller.write(partial)).status, "applied");
    const updated = fixture.workflows.get(fixture.projectId, fixture.mainThreadId)!;
    assert.equal(updated.status, "underway");
    assert.deepEqual(updated.steps[0]?.contributorThreadIds, [child.id]);
  } finally {await closeFixture(fixture);}
});

test("source IDs are not accepted as agent-authored progress evidence", async () => {
  const fixture = await makeFixture();
  try {
    const args = ensureArgs(fixture, "source-evidence-create", "Create a workflow.");
    installEvidence(fixture, args);
    const created = await fixture.controller.write(args);
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    const input = {
      operationId: "source-evidence-apply",
      workflowId: created.workflowId,
      expectedRevision: created.revision,
      status: "planned",
      objective: "Keep the evidence source native.",
      rules: [],
      steps: [{blockId: null, name: "Check evidence", reason: "Avoid fabricated pointers.", status: "planned", contributorThreadIds: [fixture.mainThreadId]}],
      note: "Try to attribute an arbitrary source.",
      evidence: [{kind: "observation", note: "Unverified source.", sourceThreadId: "foreign", sourceRunId: "run-x"}],
    };
    const argsWithClaim = {action: "apply", ...locator(fixture), input};
    assert.equal((await fixture.controller.write(argsWithClaim)).status, "invalid");
    assert.equal(fixture.workflows.get(fixture.projectId, fixture.mainThreadId)?.revision, 1);
  } finally {await closeFixture(fixture);}
});
