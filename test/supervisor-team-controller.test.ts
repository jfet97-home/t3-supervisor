import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GuidanceStore} from "../src/guidance-store.js";
import {ProjectSupervisorStore, defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {SupervisorTeamStore} from "../src/supervisor-team-store.js";
import {SupervisorTeamController, supervisionTeamToolDefinition} from "../src/supervisor-team-controller.js";
import {teamNotificationText} from "../src/supervisor-team-runtime.js";
import {SupervisorHelperTransport} from "../src/supervisor-helper-transport.js";
import {WorkflowWriteController} from "../src/workflow-write-controller.js";
import {WorkflowStateStore} from "../src/workflow-state-store.js";
import {workflowToolNames} from "../src/workflow-write-evidence.js";
import type {Projection, ThreadInfo} from "../src/types.js";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-review-controller-"));
  const guidance = new GuidanceStore(directory);
  const supervisors = new ProjectSupervisorStore(guidance, new Set());
  const reserved = supervisors.reserve("project", "main", "main", defaultSupervisorModel, 1, 1);
  const binding = {...reserved, state: "ready" as const};
  supervisors.setBinding(binding);
  const team = new SupervisorTeamStore(supervisors);
  const registered = team.registerMember(binding, {threadId: "helper", taskId: "task", bootstrapRunId: "bootstrap"});
  const member = team.markReady(binding, registered.threadId, registered.epoch);
  const threads: ThreadInfo[] = [
    {id: "main", title: "main", projectId: "project", lineage: {parentThreadId: null, relationshipToParent: null}},
    {id: "branch", title: "branch", projectId: "project", lineage: {parentThreadId: "main", relationshipToParent: "subagent"}},
    {id: binding.threadId, title: "root", projectId: "project", lineage: {parentThreadId: "main", relationshipToParent: "subagent"}},
    {id: member.threadId, title: "helper", projectId: "project", lineage: {parentThreadId: binding.threadId, relationshipToParent: "subagent"}},
  ];
  const projections = new Map<string, Projection>(threads.map(thread => [thread.id, {thread, runs: [], nodes: [], messages: [], turnItems: []}]));
  const details = new Map<string, unknown>();
  const reads: string[] = [];
  let duringRead: (() => void) | undefined;
  const native = {listThreads: async () => threads, getTurnItem: async ({itemId}: {itemId: string}) => ({item: details.get(itemId)}),
    projection: async (id: string) => {reads.push(id);if (id === member.threadId) duringRead?.();return projections.get(id)!;}};
  const workflows = new WorkflowWriteController({supervisors, team, workflows: new WorkflowStateStore(supervisors, () => true),
    native, isEnabled: () => true, maxEvidenceWaitMs: 0});
  const controller = new SupervisorTeamController(workflows, team, null);
  // Create only the local durable receipt table. No native RPC/POST is used by this fixture.
  new SupervisorHelperTransport({store: supervisors, rpc: null, baseUrl: "http://unused.invalid", projection: native.projection});
  const assignment = team.assign(binding, "branch", member.threadId, new Map([["branch", "main"]]));
  const pending = team.snapshot(binding).notifications.find(value => value.assignmentEpoch === assignment.epoch)!;
  team.updateNotificationDelivery(binding, binding.threadId, pending.id, "sending");
  team.updateNotificationDelivery(binding, binding.threadId, pending.id, "delivered");
  const original = team.recordNotificationRun(binding, binding.threadId, pending.id, 0, {runId: "interrupted-native-run", status: "interrupted"});
  const {text, marker} = teamNotificationText(binding, original);
  const logicalId = `supervisor-team-notice:${original.id}:attempt:0`;
  guidance.db.prepare("INSERT INTO supervisor_helper_deliveries VALUES(?,?,?,?)").run(binding.threadId, binding.generation, logicalId,
    JSON.stringify({messageId: logicalId, threadId: member.threadId, taskId: "owned-task", text, state: "posted"}));
  const helper = projections.get(member.threadId)!;
  helper.runs.push({id: "interrupted-native-run", threadId: member.threadId, ordinal: 1, status: "interrupted", userMessageId: "native-message",
    requestedAt: "2026-10-19T00:00:00Z", startedAt: null, completedAt: null, rootNodeId: null});
  helper.messages.push({id: "native-message", threadId: member.threadId, runId: "interrupted-native-run", role: "user", nodeId: null, text,
    scheduledTaskId: "owned-task", creationSource: "server", streaming: false, createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z"});
  const args = {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation, action: "review_handover", operationId: "review-operation",
    notificationId: original.id, expectedDeliveryAttempt: 0, expectedRunId: original.observedRun!.runId,
    expectedChain: [{notificationId: original.id, deliveryAttempt: 0, runId: original.observedRun!.runId}], note: "sentinel-root-note"};
  const proof = (input: Record<string, unknown>, actor = binding.threadId) => {
    const projection = projections.get(actor)!;
    const itemId = `native-tool-${details.size}`;
    const runId = `caller-run-${itemId}`;
    const rootNodeId = `root-${itemId}`;
    const nodeId = `tool-node-${itemId}`;
    const providerThreadId = `provider-${actor}`;
    const toolName = workflowToolNames.team.direct[0];
    const detail = {id: itemId, type: "dynamic_tool", threadId: actor, runId, nodeId, providerThreadId,
      providerTurnId: `turn-${itemId}`, nativeItemRef: {driver: "codex", nativeId: itemId, strength: "strong"},
      parentItemId: null, ordinal: details.size + 1, status: "completed", toolNonExecutionKind: null, toolName, input};
    details.set(itemId, detail);
    projection.runs.push({id: runId, threadId: actor, ordinal: projection.runs.length + 1, status: "completed",
      requestedAt: "2026-10-19T00:00:00Z", startedAt: null, completedAt: null, rootNodeId, providerThreadId});
    (projection.nodes as unknown[]).push({id: rootNodeId, kind: "root_turn", threadId: actor, runId, rootNodeId, providerThreadId, status: "completed"},
      {id: nodeId, kind: "dynamic_tool", threadId: actor, runId, rootNodeId, providerThreadId, parentNodeId: rootNodeId, status: "completed"});
    projection.turnItems!.push({...detail, input: "snapshot-summary"});
  };
  return {guidance, supervisors, team, binding, member, original, assignment, projections, helper, controller, args, proof, marker, reads,
    duringRead: (callback: () => void) => {duringRead = callback;},
    call: (input: Record<string, unknown> = args) => controller.call(input, AbortSignal.timeout(5000)) as Promise<{status: string; reason?: string; result?: unknown}>,
    cleanup: async () => {guidance.close();await rm(directory, {recursive: true, force: true});}};
};

test("review_handover requires exact native root proof and offers no helper acknowledgement action", async t => {
  const f = await fixture();t.after(f.cleanup);
  assert.ok(supervisionTeamToolDefinition.inputSchema.properties.action.enum.includes("review_handover"));
  const before = f.team.snapshot(f.binding);
  assert.equal((await f.call()).reason, "native_root_proof_required");
  const helperInput = {...f.args, supervisorThreadId: f.member.threadId, memberEpoch: f.member.epoch};
  f.proof(helperInput, f.member.threadId);
  assert.equal((await f.call(helperInput)).reason, "root_authority_required");
  const forged = {...helperInput, action: "acknowledge", operationId: "forged-ack"};
  f.proof(forged, f.member.threadId);
  assert.equal((await f.call(forged)).reason, "root_authority_required");
  f.proof({...f.args, note: "different-native-arguments"});
  assert.equal((await f.call()).reason, "native_root_proof_required");
  assert.deepEqual(f.team.snapshot(f.binding), before);
  f.proof(f.args);
  assert.equal((await f.call()).status, "ok");
  assert.ok(f.reads.includes(f.member.threadId), "the root action reads current native helper truth");
});

test("current native running completed missing or changed evidence refuses review without mutation", async t => {
  const variants = ["running", "completed", "missing-run", "missing-message", "different-text", "different-task", "changed-ended-status", "other-running-run", "other-completed-run", "marker-completed"] as const;
  for (const variant of variants) {
    const f = await fixture();t.after(f.cleanup);f.proof(f.args);
    const run = f.helper.runs[0]!;
    if (variant === "running" || variant === "completed") run.status = variant;
    if (variant === "missing-run") f.helper.runs = [];
    if (variant === "missing-message") f.helper.messages = [];
    if (variant === "different-text") f.helper.messages[0]!.text = "sentinel-replaced-native-text";
    if (variant === "different-task") f.helper.messages[0]!.scheduledTaskId = "sentinel-other-task";
    if (variant === "changed-ended-status") run.status = "failed";
    if (variant === "other-running-run") f.helper.runs.push({...run, id: "other-run", status: "running"});
    if (variant === "other-completed-run" || variant === "marker-completed") {
      const completedId = variant === "other-completed-run" ? "other-run" : run.id;
      if (completedId === run.id) run.status = "completed";
      else f.helper.runs.push({...run, id: completedId, status: "completed"});
      f.helper.messages.push({...f.helper.messages[0]!, id: "completed-final", runId: completedId, role: "assistant", text: f.marker});
    }
    const before = f.team.snapshot(f.binding);
    const result = await f.call();
    assert.equal(result.status, "denied", variant);
    assert.ok(["supervisor_team_review_native_changed", "supervisor_team_review_native_completed"].includes(result.reason!), variant);
    assert.deepEqual(f.team.snapshot(f.binding), before, variant);
    assert.equal(f.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_team_tool_receipts").get()?.n, 0);
  }
});

test("review errors never reflect note identities or native exception text", async t => {
  const f = await fixture();t.after(f.cleanup);
  for (const change of [{note: "sentinel".repeat(150)}, {note: "sentinel\u0000"}, {notificationId: "sentinel-notice"},
    {expectedRunId: "sentinel-run"}, {expectedChain: [{notificationId: "sentinel-chain", deliveryAttempt: 0, runId: "sentinel-run"}]}]) {
    const input = {...f.args, ...change};f.proof(input);
    const result = await f.call(input);
    assert.equal(result.status, "denied");
    assert.ok(!JSON.stringify(result).includes("sentinel"));
  }
  f.proof(f.args);f.duringRead(() => {throw new Error("sentinel_native_exception");});
  assert.deepEqual(await f.call(), {status: "denied", reason: "supervisor_team_review_native_unavailable"});
  assert.equal(f.team.snapshot(f.binding).notifications.length, 1);
});

test("review operation replay is durable and concurrent distinct operations admit one exact chain", async t => {
  const f = await fixture();t.after(f.cleanup);
  const competing = {...f.args, operationId: "competing-operation"};
  f.proof(f.args);f.proof(competing);
  const results = await Promise.all([f.call(), f.call(competing)]);
  assert.deepEqual(results.map(value => value.status).sort(), ["denied", "ok"]);
  const winnerIndex = results.findIndex(value => value.status === "ok");
  const winner = winnerIndex === 0 ? f.args : competing;
  assert.equal(f.team.snapshot(f.binding).notifications.filter(value => value.kind === "handover_review").length, 1);
  // Recreate the controller and remove native helper visibility: exact replay does
  // not mutate, redeliver, or need to reconsider the already-committed chain.
  const restarted = new SupervisorTeamController(f.controller.workflows, new SupervisorTeamStore(f.supervisors), null);
  f.projections.delete(f.member.threadId);f.proof(winner);
  assert.deepEqual(await restarted.call(winner, AbortSignal.timeout(5000)), results[winnerIndex]);
  const changed = {...winner, note: "sentinel-different-note"};f.proof(changed);
  assert.deepEqual(await f.call(changed), {status: "denied", reason: "operation_id_conflict"});
});

test("the store CAS rechecks member and assignment authority after the native read", async t => {
  const f = await fixture();t.after(f.cleanup);f.proof(f.args);
  f.duringRead(() => {f.team.quarantineMember(f.binding, f.member.threadId);});
  assert.equal((await f.call()).reason, "supervisor_team_member_epoch_conflict");
  assert.equal(f.team.snapshot(f.binding).notifications.some(value => value.kind === "handover_review"), false);
  assert.equal(f.guidance.db.prepare("SELECT count(*) AS n FROM supervisor_team_tool_receipts").get()?.n, 0);
});

test("native validation includes every earlier review in the expected chain", async t => {
  const f = await fixture();t.after(f.cleanup);f.proof(f.args);
  const result = await f.call();assert.equal(result.status, "ok");
  const review = f.team.snapshot(f.binding).notifications.find(value => value.kind === "handover_review")!;
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, review.id, "sending");
  f.team.updateNotificationDelivery(f.binding, f.binding.threadId, review.id, "delivered");
  f.team.recordNotificationRun(f.binding, f.binding.threadId, review.id, 0, {runId: "review-native-run", status: "interrupted"});
  const {text} = teamNotificationText(f.binding, review);
  const logicalId = `supervisor-team-notice:${review.id}:attempt:0`;
  f.guidance.db.prepare("INSERT INTO supervisor_helper_deliveries VALUES(?,?,?,?)").run(f.binding.threadId, f.binding.generation, logicalId,
    JSON.stringify({messageId: logicalId, threadId: f.member.threadId, taskId: "owned-task", text, state: "posted"}));
  f.helper.messages.push({...f.helper.messages[0]!, id: "review-native-message", runId: "review-native-run", text});
  const run = {...f.helper.runs[0]!, id: "review-native-run", userMessageId: "review-native-message", status: "running"};
  f.helper.runs.push(run);
  const input = {...f.args, operationId: "second-review", expectedChain: [...f.args.expectedChain,
    {notificationId: review.id, deliveryAttempt: 0, runId: run.id}]};
  f.proof(input);
  const before = f.team.snapshot(f.binding);
  assert.equal((await f.call(input)).reason, "supervisor_team_review_native_changed");
  assert.deepEqual(f.team.snapshot(f.binding), before);
  run.status = "interrupted";
  assert.equal((await f.call(input)).status, "ok");
});
