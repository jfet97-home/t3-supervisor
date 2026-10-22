import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it, type TestContext} from "vitest";
import {after} from "./support/node-test.js";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {DatabaseSync} from "node:sqlite";
import {GuidanceStore} from "../src/guidance-store.js";
import {ProjectSupervisorStore, defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {SupervisorTeamStore} from "../src/supervisor-team-store.js";
import {SupervisorTeamController} from "../src/supervisor-team-controller.js";
import {SupervisorRpcError, type SupervisorRpc} from "../src/supervisor-native.js";
import {WorkflowWriteController} from "../src/workflow-write-controller.js";
import {WorkflowStateStore} from "../src/workflow-state-store.js";
import {workflowToolInputMaxBytes, workflowToolInputSize, workflowToolNames} from "../src/workflow-write-evidence.js";
import type {Projection, ThreadInfo} from "../src/types.js";
import {withDeadline} from "./support/c1-loopback.js";

type Call = {tag: string; payload: Record<string, unknown>; signal: AbortSignal};

// the baseline controller suite's fixture, with a ready helper actively assigned a running delegated child and a native rpc
const fixture = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "c1-team-controller-"));
  const opened: GuidanceStore[] = [];
  const guidance = new GuidanceStore(directory);opened.push(guidance);
  const supervisors = new ProjectSupervisorStore(guidance, new Set());
  const binding = {...supervisors.reserve("project", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const};
  supervisors.setBinding(binding);
  const team = new SupervisorTeamStore(supervisors);
  const registered = team.registerMember(binding, {threadId: "helper", taskId: "task", bootstrapRunId: "bootstrap"});
  const member = team.markReady(binding, registered.threadId, registered.epoch);
  const modes = {runtimeMode: "full-access", interactionMode: "default"};
  const threads: ThreadInfo[] = [
    {id: "main", title: "main", projectId: "project", lineage: {parentThreadId: null, relationshipToParent: null}},
    {id: "branch", title: "branch", projectId: "project", creationSource: "mcp", activeRunId: "branch-run", ...modes,
      lineage: {parentThreadId: "main", relationshipToParent: "subagent"}},
    {id: binding.threadId, title: "root", projectId: "project", ...modes, lineage: {parentThreadId: "main", relationshipToParent: "subagent"}},
    {id: member.threadId, title: "helper", projectId: "project", ...modes, lineage: {parentThreadId: binding.threadId, relationshipToParent: "subagent"}},
  ];
  const projections = new Map<string, Projection>(threads.map(thread => [thread.id, {thread, runs: [], nodes: [], messages: [], turnItems: [], runtimeRequests: []}]));
  const branch = projections.get("branch")!;
  branch.runs.push({id: "branch-run", threadId: "branch", ordinal: 1, status: "running", activeAttemptId: "branch-attempt", rootNodeId: "branch-root",
    requestedAt: "2026-10-19T00:00:00Z", startedAt: "2026-10-19T00:00:00Z", completedAt: null});
  branch.providerTurns = [{id: "branch-turn", runAttemptId: "branch-attempt", nodeId: "branch-root", status: "running"}];
  const parents = new Map<string, string | null>([["main", null], ["branch", "main"]]);
  const assignment = team.assign(binding, "branch", member.threadId, parents);
  for (const notice of team.snapshot(binding).notifications.filter(value => value.assignmentEpoch === assignment.epoch)) {
    team.updateNotificationDelivery(binding, binding.threadId, notice.id, "sending");
    team.updateNotificationDelivery(binding, binding.threadId, notice.id, "delivered");
    team.acknowledgeNotification(binding, notice.recipientThreadId, notice.id, notice.memberEpoch);
  }
  team.completeTransfer(binding, "branch", assignment.epoch);
  const details = new Map<string, unknown>();
  const reads: string[] = [];
  let readHook: ((id: string) => Promise<void> | null) | null = null;
  const native = {listThreads: async () => threads, getTurnItem: async ({itemId}: {itemId: string}) => ({item: details.get(itemId)}),
    projection: async (id: string) => {
      reads.push(id);
      const held = readHook?.(id) ?? null;
      if (held) await held;
      const projection = projections.get(id);
      if (!projection) throw new Error("unreadable");
      return projection;
    }};
  const calls: Call[] = [];
  let interceptor: ((call: Call) => Promise<unknown> | null) | null = null;
  const pending: Array<PromiseWithResolvers<unknown>> = [];
  const rpc: SupervisorRpc = async (tag, payload, signal) => {
    const call = {tag, payload, signal};calls.push(call);
    const held = interceptor?.(call) ?? null;
    if (held) return held;
    return {sequence: calls.length};
  };
  const makeController = (store: ProjectSupervisorStore, teamStore: SupervisorTeamStore) => {
    const workflows = new WorkflowWriteController({supervisors: store, team: teamStore, workflows: new WorkflowStateStore(store, () => true),
      native, isEnabled: () => true, isChatStopped: () => false, maxEvidenceWaitMs: 0});
    return new SupervisorTeamController(workflows, teamStore, rpc);
  };
  const controller = makeController(supervisors, team);
  after(t, async () => {
    for (const held of pending) held.reject(new Error("abandoned dispatch"));
    for (const db of opened) try {db.close();} catch { /* closed by a simulated crash */ }
    await rm(directory, {recursive: true, force: true});
  });
  // the caller's own completed native tool call whose complete arguments equal the request
  const proof = (input: Record<string, unknown>, actor: string, tool: "team" | "guide") => {
    const projection = projections.get(actor)!;
    const itemId = `native-tool-${details.size}`;
    const runId = `caller-run-${itemId}`;
    const rootNodeId = `root-${itemId}`;
    const nodeId = `tool-node-${itemId}`;
    const providerThreadId = `provider-${actor}`;
    const detail = {id: itemId, type: "dynamic_tool", threadId: actor, runId, nodeId, providerThreadId,
      providerTurnId: `turn-${itemId}`, nativeItemRef: {driver: "codex", nativeId: itemId, strength: "strong"},
      parentItemId: null, ordinal: details.size + 1, status: "completed", toolNonExecutionKind: null, toolName: workflowToolNames[tool].direct[0], input};
    details.set(itemId, detail);
    projection.runs.push({id: runId, threadId: actor, ordinal: projection.runs.length + 1, status: "completed",
      requestedAt: "2026-10-19T00:00:00Z", startedAt: null, completedAt: null, rootNodeId, providerThreadId});
    (projection.nodes as unknown[]).push({id: rootNodeId, kind: "root_turn", threadId: actor, runId, rootNodeId, providerThreadId, status: "completed"},
      {id: nodeId, kind: "dynamic_tool", threadId: actor, runId, rootNodeId, providerThreadId, parentNodeId: rootNodeId, status: "completed"});
    projection.turnItems!.push({...detail, input: "snapshot-summary"});
  };
  const guideInput = (operationId: string) => ({supervisorThreadId: member.threadId, bindingGeneration: binding.generation, memberEpoch: member.epoch,
    assignmentRootThreadId: "branch", assignmentEpoch: assignment.epoch, operationId, targetThreadId: "branch", text: `Check the failing test (${operationId}).`});
  const receipt = (db: DatabaseSync, operationId: string) => {
    const row = db.prepare("SELECT document FROM supervisor_team_tool_receipts WHERE operation_id=?").get(operationId);
    return row ? JSON.parse(String(row.document)) as {status: string; requestId: string; messageId: string; commandId: string; attempts: Array<{status: string; reason?: string}>} : null;
  };
  return {directory, guidance, supervisors, team, binding, member, assignment, threads, projections, branch, reads, calls, controller, proof, guideInput, receipt,
    dispatches: () => calls.filter(call => call.tag === "orchestration.dispatchCommand"),
    intercept: (next: typeof interceptor) => {interceptor = next;},
    holdReads: (hook: typeof readHook) => {readHook = hook;},
    never: () => {const held = Promise.withResolvers<unknown>();pending.push(held);return held.promise;},
    reopen: () => {
      const reopened = new GuidanceStore(directory);opened.push(reopened);
      const store = new ProjectSupervisorStore(reopened, new Set());
      const teamStore = new SupervisorTeamStore(store);
      return {guidance: reopened, team: teamStore, controller: makeController(store, teamStore)};
    }};
};

type GuideResult = {status: string; reason?: string; attempts?: unknown[]};
const requestStates = (db: DatabaseSync, requestId: string): string[] =>
  db.prepare("SELECT state FROM supervisor_team_requests WHERE request_id=?").all(requestId).map(row => String(row.state));
const guide = (controller: SupervisorTeamController, input: Record<string, unknown>, signal: AbortSignal = AbortSignal.timeout(5_000)) =>
  controller.guide(input, signal) as Promise<GuideResult>;

// the visible native steer the guide's message identity names
const deliver = (f: Awaited<ReturnType<typeof fixture>>, messageId: string, text: string) => f.branch.messages.push({id: messageId, threadId: "branch", runId: "branch-run",
  nodeId: "branch-root", role: "user", text, createdBy: "user", creationSource: "server", streaming: false, createdAt: "2026-10-19T00:00:01Z", updatedAt: "2026-10-19T00:00:01Z"});

for (const variant of ["after the request was sent", "before the request was sent"] as const) {
  it(`CT-TCTRL-01: aborting guide() ${variant} classifies the reserved attempt and a later guide() only reconciles it`, {timeout: 10_000}, async t => {
    const f = await fixture(t);
    const input = f.guideInput(`abort-${variant.startsWith("after") ? "sent" : "unsent"}`);
    f.proof(input, f.member.threadId, "guide");
    const reached = Promise.withResolvers<Call>();
    after(t, () => reached.resolve({tag: "", payload: {}, signal: AbortSignal.abort()}));
    f.intercept(call => {
      reached.resolve(call);
      // the real client classifies an abort as uncertain once its request frame was sent, rejected before that
      return new Promise((_resolve, reject) => call.signal.addEventListener("abort", () =>
        reject(new SupervisorRpcError(variant.startsWith("after") ? "uncertain" : "rejected")), {once: true}));
    });
    const controller = new AbortController();
    const running = guide(f.controller, input, controller.signal);
    const call = await withDeadline(reached.promise, 3_000, "dispatch");
    const prepared = f.receipt(f.guidance.db, input.operationId);
    assert.ok(prepared);
    assert.deepEqual([prepared.status, prepared.attempts.length, prepared.attempts[0]?.status], ["prepared", 1, "prepared"]);
    assert.deepEqual([call.payload.messageId, call.payload.commandId, call.payload.threadId], [prepared.messageId, prepared.commandId, "branch"]);
    controller.abort();
    const result = await withDeadline(running, 3_000, "aborted guide");
    const teamRequest = () => requestStates(f.guidance.db, prepared.requestId).join();
    if (variant.startsWith("after")) {
      assert.deepEqual([result.status, result.reason], ["uncertain", "original_send_requires_reconciliation"]);
      assert.equal(f.receipt(f.guidance.db, input.operationId)?.attempts[0]?.status, "uncertain");
      assert.equal(teamRequest(), "uncertain");
      f.intercept(null);
      assert.deepEqual(await guide(f.controller, input).then(value => [value.status, value.reason]), ["uncertain", "original_send_requires_reconciliation"]);
      deliver(f, prepared.messageId, input.text);
      assert.equal((await guide(f.controller, input)).status, "delivered");
      assert.equal(teamRequest(), "settled");
    } else {
      assert.deepEqual([result.status, result.reason], ["not_sent", "native_transport_not_sent"]);
      assert.equal(teamRequest(), "settled");
      f.intercept(null);
      assert.equal((await guide(f.controller, input)).status, "not_sent", "the stored outcome is returned without another dispatch");
    }
    assert.equal(f.dispatches().length, 1);
  });
}

it("CT-TCTRL-01: a crash after the reservation keeps the receipt 'prepared'; a new process reconciles it by message id without a second dispatch", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const input = f.guideInput("crash");
  f.proof(input, f.member.threadId, "guide");
  const reached = Promise.withResolvers<void>();
  after(t, () => reached.resolve());
  f.intercept(() => {reached.resolve();return f.never();});
  const abandoned = guide(f.controller, input).then(() => "settled", () => "failed");
  after(t, () => withDeadline(abandoned, 3_000, "abandoned guide"));
  await withDeadline(reached.promise, 3_000, "dispatch");
  const prepared = f.receipt(f.guidance.db, input.operationId);
  assert.ok(prepared?.status === "prepared");
  f.guidance.close();

  f.intercept(null);
  const restarted = f.reopen();
  assert.deepEqual(f.receipt(restarted.guidance.db, input.operationId), prepared, "reopening performs no recovery");
  assert.deepEqual(await guide(restarted.controller, input).then(value => [value.status, value.reason]), ["uncertain", "original_send_requires_reconciliation"]);
  deliver(f, prepared.messageId, input.text);
  assert.equal((await guide(restarted.controller, input)).status, "delivered");
  assert.deepEqual(requestStates(restarted.guidance.db, prepared.requestId), ["settled"]);
  assert.equal(f.dispatches().length, 1);
});

it("CT-TCTRL-02: two concurrent guide() calls with one operationId reserve one attempt and dispatch once; the other returns the stored record", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const input = f.guideInput("concurrent");
  f.proof(input, f.member.threadId, "guide");
  // both calls pass their receipt check and meet at the target read inside the route search
  let arrived = 0;
  const barrier = Promise.withResolvers<void>();
  after(t, () => barrier.resolve());
  f.holdReads(id => {
    if (id !== "branch" || arrived >= 2) return null;
    arrived += 1;
    if (arrived === 2) barrier.resolve();
    return barrier.promise;
  });
  const dispatched = Promise.withResolvers<unknown>();
  after(t, () => dispatched.resolve({sequence: 1}));
  f.intercept(() => dispatched.promise);
  const first = guide(f.controller, input);
  const second = guide(f.controller, input);
  const settledFirst = await Promise.race([first.then(value => ["first", value] as const), second.then(value => ["second", value] as const)]);
  assert.equal(settledFirst[1].status, "prepared", "the call that lost the reservation returns the stored record");
  assert.equal(f.dispatches().length, 1);
  dispatched.resolve({sequence: 7});
  const results = await withDeadline(Promise.all([first, second]), 3_000, "guides");
  assert.deepEqual(results.map(value => value.status).sort(), ["accepted", "prepared"]);
  const stored = f.receipt(f.guidance.db, input.operationId);
  assert.equal(stored?.status, "accepted");
  assert.equal(stored?.attempts.length, 1);
  assert.deepEqual(requestStates(f.guidance.db, String(stored?.requestId)), ["pending"]);
  f.holdReads(null);
  assert.equal((await guide(f.controller, input)).status, "accepted");
  assert.equal(f.dispatches().length, 1);
});

const tableDigest = (db: DatabaseSync): string => {
  const hash = createHash("sha256");
  for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{name: string}>)
    hash.update(`${name}\0${JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())}\0`);
  return hash.digest("hex");
};
const totalChanges = (db: DatabaseSync): number => Number(db.prepare("SELECT total_changes() AS n").get()?.n);

it("CT-TCTRL-04: register is denied with native_completed_bootstrap_not_verified and writes nothing unless the first run is the exact completed bootstrap", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const root = f.projections.get(f.binding.threadId)!;
  root.runs.push({id: "root-delegate-run", threadId: f.binding.threadId, ordinal: 100, status: "completed", requestedAt: "2026-10-19T00:00:00Z",
    startedAt: "2026-10-19T00:00:00Z", completedAt: "2026-10-19T00:00:02Z", rootNodeId: null});
  root.subagents = [{id: "delegate-task", origin: "app_owned", threadId: f.binding.threadId, childThreadId: "helper-new", status: "completed",
    result: "ready", runId: "root-delegate-run", prompt: "Bootstrap the helper role."}];
  const childThread: ThreadInfo = {id: "helper-new", title: "helper-new", projectId: "project", forkedFrom: {type: "node", nodeId: "delegate-task"},
    lineage: {parentThreadId: f.binding.threadId, relationshipToParent: "subagent"}};
  f.threads.push(childThread);
  const child: Projection = {thread: childThread, nodes: [], turnItems: [], runtimeRequests: [],
    runs: [{id: "bootstrap-run", threadId: "helper-new", ordinal: 2, status: "completed", userMessageId: "bootstrap-message",
      requestedAt: "2026-10-19T00:00:00Z", startedAt: "2026-10-19T00:00:00Z", completedAt: "2026-10-19T00:00:01Z", rootNodeId: null}],
    messages: [{id: "bootstrap-message", threadId: "helper-new", runId: "bootstrap-run", nodeId: null, role: "user", text: "Bootstrap the helper role.",
      streaming: false, createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z"}]};
  f.projections.set("helper-new", child);
  const register = async (operationId: string) => {
    const input = {supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, action: "register", operationId,
      memberThreadId: "helper-new", taskId: "delegate-task", bootstrapRunId: "bootstrap-run"};
    f.proof(input, f.binding.threadId, "team");
    const digest = tableDigest(f.guidance.db);
    const changes = totalChanges(f.guidance.db);
    const result = await f.controller.call(input, AbortSignal.timeout(5_000)) as {status: string; reason?: string};
    return {result, unchanged: tableDigest(f.guidance.db) === digest && totalChanges(f.guidance.db) === changes};
  };
  const denied = {result: {status: "denied", reason: "native_completed_bootstrap_not_verified"}, unchanged: true};

  const earlier = {id: "earlier-run", threadId: "helper-new", ordinal: 1, status: "completed", userMessageId: null,
    requestedAt: "2026-10-19T00:00:00Z", startedAt: "2026-10-19T00:00:00Z", completedAt: "2026-10-19T00:00:00Z", rootNodeId: null};
  child.runs.unshift(earlier);
  assert.deepEqual(await register("register-not-first"), denied);
  child.runs.shift();
  child.messages[0]!.text = "A different bootstrap text.";
  assert.deepEqual(await register("register-other-text"), denied);
  child.runs[0]!.status = "running";
  child.messages[0]!.text = "Bootstrap the helper role.";
  assert.deepEqual(await register("register-unfinished"), denied);

  // the same native records with the exact completed bootstrap register the helper
  child.runs[0]!.status = "completed";
  const accepted = await register("register-exact");
  assert.equal(accepted.result.status, "ok");
  assert.equal(accepted.unchanged, false);
  assert.ok(f.team.snapshot(f.binding).members.some(value => value.threadId === "helper-new"));
});

it("CT-TCTRL-05: unknown keys, oversize input and non-integer epochs return invalid_team_arguments and invalid_guidance_arguments exactly", {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const team = {supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, action: "note", operationId: "note-operation",
    memberThreadId: f.member.threadId, summary: ""};
  const pad = workflowToolInputMaxBytes - workflowToolInputSize(team);
  const digest = tableDigest(f.guidance.db);
  const changes = totalChanges(f.guidance.db);
  const invalidTeam = {status: "invalid", reason: "invalid_team_arguments"};
  for (const input of [
    {...team, unexpected: true},
    {...team, summary: "x".repeat(pad + 1)},
    {...team, memberEpoch: 1.5},
    {...team, memberEpoch: 0},
    {...team, memberEpoch: "1"},
    {...team, assignmentEpoch: 2.5},
    {...team, bindingGeneration: 0},
    {...team, bindingGeneration: 1.5},
    {...team, assignmentRootThreadId: ""},
  ]) assert.deepEqual(await f.controller.call(input, AbortSignal.timeout(5_000)), invalidTeam, JSON.stringify(input).slice(0, 120));
  assert.equal(workflowToolInputSize({...team, summary: "x".repeat(pad)}), workflowToolInputMaxBytes);
  assert.notDeepEqual(await f.controller.call({...team, summary: "x".repeat(pad)}, AbortSignal.timeout(5_000)), invalidTeam, "an input at the byte limit is parsed");

  const guidance = f.guideInput("parse");
  const invalidGuidance = {status: "invalid", reason: "invalid_guidance_arguments"};
  for (const input of [
    {...guidance, action: "read"},
    {...guidance, text: "x".repeat(workflowToolInputMaxBytes)},
    {...guidance, text: "x".repeat(12_001)},
    {...guidance, memberEpoch: 1.5},
    {...guidance, assignmentEpoch: "1"},
    {...guidance, bindingGeneration: 0},
  ]) assert.deepEqual(await f.controller.guide(input, AbortSignal.timeout(5_000)), invalidGuidance, JSON.stringify(input).slice(0, 120));
  assert.deepEqual(f.calls, []);
  assert.equal(tableDigest(f.guidance.db), digest);
  assert.equal(totalChanges(f.guidance.db), changes);
});
