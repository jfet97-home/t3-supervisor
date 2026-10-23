import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Clock, Effect, Exit } from "effect";
import { fingerprint } from "../src/guidance-store.js";
import type { WorkflowApplyPatch } from "../src/workflow-write-controller.js";
import { workflowRequestHash, workflowToolNames } from "../src/workflow-write-evidence.js";
import { httpJson, mcpCall, mcpRawPost, operateToken, readToken, row, rows } from "./support/glinint-wiring.js";
import { hookRuntime, httpRequests, rpcRequests, type HookRuntime, type IntNativePeer } from "./support/int-native-peer.js";
import { applyArgs, ensureArgs, installEvidence, localStep, sequencePlan, shellThread, startWorkflowFixture, thread,
  type IntWorkflowFixture } from "./support/int-workflow-fixture.js";

// complete production boundary: HTTP gate -> stateless MCP -> production-wired controllers and native adapter -> loopback T3 peer,
// temp databases. it.live: every call crosses the real MCP listener and the peer's HTTP and websocket sockets, and the pending
// cases wait out the production 400 ms evidence window on the live clock

const readAuthorization = `Bearer ${readToken}`;

const count = (f: IntWorkflowFixture, table: string, where = "1=1", ...values: Array<string | number>): Effect.Effect<number> =>
  Effect.map(row(f.core.sql, `SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...values), (found) => Number(found?.n));

const projectionPath = (f: IntWorkflowFixture) => `/api/orchestration/threads/${encodeURIComponent(f.supervisorThreadId)}`;

// per-route request counts the peer observed
const traffic = (f: IntWorkflowFixture) => ({
  projection: httpRequests(f.peer, projectionPath(f)).length,
  shell: httpRequests(f.peer, "/api/orchestration/shell").length,
  archived: rpcRequests(f.peer, "orchestration.getArchivedShellSnapshot").length,
  turnItem: rpcRequests(f.peer, "orchestration.getTurnItem").length,
  total: f.peer.log.length,
});

const assertReadCredentials = (peer: IntNativePeer): void => {
  for (const entry of peer.log) {
    assert.equal(entry.authorization, readAuthorization, `${entry.kind === "http" ? entry.path : entry.tag} uses the read token`);
    if (entry.kind === "http") assert.equal(entry.protocol, "2");
  }
  assert.equal(peer.connections.filter(value => value === `Bearer ${operateToken}`).length, 0, "no operate-token connection");
  assert.deepEqual(peer.unexpected, []);
};

const noWriteRows = (f: IntWorkflowFixture) => Effect.gen(function* () {
  assert.equal(yield* count(f, "supervisor_workflow_write_receipts"), 0);
  assert.equal(yield* count(f, "supervisor_workflow_write_evidence"), 0);
  assert.equal(yield* f.core.workflowStates.get(f.projectId, f.mainThreadId), null);
});

// a Stop committed on the native fake's hook, before it replies
const stopMain = (f: IntWorkflowFixture): Effect.Effect<void> => Effect.flatMap(f.core.policy.get(), (current) =>
  f.core.control.saveThreadPolicy({...current, excludedThreadIds: [...current.excludedThreadIds, f.mainThreadId]})).pipe(Effect.asVoid, Effect.orDie);

const once = (work: Effect.Effect<void>): Effect.Effect<void> => {
  let done = false;
  return Effect.suspend(() => {
    if (done) return Effect.void;
    done = true;
    return work;
  });
};

// runs a non-suspending effect to its end on the calling turn, before the proof item is produced
const onTurn = (hooks: HookRuntime, work: Effect.Effect<void>): (() => void) => {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const fiber = hooks.run(work);
    const exit = fiber.pollUnsafe();
    if (exit === undefined) {
      fiber.interruptUnsafe();
      throw new Error("a native hook suspended inside the turn");
    }
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  };
};

// the elapsed live milliseconds of an effect
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const started = yield* Clock.monotonicTimeNanos;
  const value = yield* effect;
  return {value, elapsed: Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000};
});

const createMainWorkflow = (f: IntWorkflowFixture, operationId = "int-ensure") => Effect.gen(function* () {
  const args = ensureArgs(f, operationId, "Create the main workflow through the production route.");
  const itemId = installEvidence(f, args);
  const reply = yield* mcpCall(f.endpoint, "workflow_write", args);
  return {args, itemId, reply, value: reply.value as {status: string; operationId: string; workflowId: string; revision: number; stateHash: string; formatVersion: number}};
});

it.live("CT-INT-01: 0 gate rejects a missing token, a foreign Host and a foreign Origin before any native read", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  const missing = yield* httpJson(`http://127.0.0.1:${f.endpoint.port}/mcp/workflows`, {method: "POST",
    headers: {Accept: "application/json, text/event-stream"},
    body: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "workflow_write", arguments: ensureArgs(f, "gate", "Gate.")}}});
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.body, {message: "A workflow MCP token is required."});

  const foreignHost = yield* mcpRawPost(f.endpoint.port, {Host: "evil.example:80", Authorization: `Bearer ${f.endpoint.token}`});
  assert.equal(foreignHost.status, 403);
  assert.deepEqual(foreignHost.body, {message: "Workflow MCP request origin is not allowed."});
  // the Host/Origin check runs before authentication, so a foreign Host is refused even without a token
  const foreignHostNoToken = yield* mcpRawPost(f.endpoint.port, {Host: "evil.example:80"});
  assert.equal(foreignHostNoToken.status, 403);
  assert.deepEqual(foreignHostNoToken.body, {message: "Workflow MCP request origin is not allowed."});

  const foreignOrigin = yield* mcpRawPost(f.endpoint.port, {Origin: "http://evil.example", Authorization: `Bearer ${f.endpoint.token}`});
  assert.equal(foreignOrigin.status, 403);
  assert.deepEqual(foreignOrigin.body, {message: "Workflow MCP request origin is not allowed."});

  assert.deepEqual(f.peer.log, []);
  assert.deepEqual(f.peer.connections, []);
  yield* noWriteRows(f);
}), {timeout: 60_000});

it.live("CT-INT-01: i a valid exact own-main-run proof commits mutation, evidence and receipt over the real wire", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  const {args, itemId, reply, value} = yield* createMainWorkflow(f);
  assert.equal(reply.httpStatus, 200);
  assert.equal(reply.isError, false);
  assert.deepEqual(Object.keys(value).sort(), ["formatVersion", "operationId", "revision", "stateHash", "status", "workflowId"]);
  assert.equal(value.status, "created");
  assert.equal(value.operationId, "int-ensure");
  assert.equal(value.revision, 1);
  assert.equal(value.formatVersion, 2);
  assert.equal(typeof value.workflowId, "string");
  assert.equal(typeof value.stateHash, "string");

  const owner = {projectId: f.projectId, mainThreadId: f.mainThreadId, supervisorThreadId: f.supervisorThreadId, bindingGeneration: f.binding.generation};
  const receipts = yield* rows(f.core.sql, "SELECT * FROM supervisor_workflow_write_receipts");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.operation_id, "int-ensure");
  assert.equal(receipts[0]!.operation_namespace, "edit");
  assert.equal(receipts[0]!.request_hash, workflowRequestHash({owner, arguments: args}));
  assert.deepEqual(JSON.parse(String(receipts[0]!.result)), value);
  const evidence = yield* rows(f.core.sql, "SELECT * FROM supervisor_workflow_write_evidence");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.item_id, itemId);
  assert.equal(evidence[0]!.successful, 1);
  assert.equal((JSON.parse(String(evidence[0]!.native_evidence)) as {nativeItemRef: {strength: string}}).nativeItemRef.strength, "strong");
  assert.equal((yield* f.core.workflowStates.get(f.projectId, f.mainThreadId))?.workflowId, value.workflowId);

  assert.deepEqual(traffic(f), {projection: 1, shell: 1, archived: 1, turnItem: 1, total: 4});
  assert.deepEqual(rpcRequests(f.peer, "orchestration.getTurnItem")[0]!.payload, {threadId: f.supervisorThreadId, itemId});
  assertReadCredentials(f.peer);
}), {timeout: 60_000});

it.live("CT-INT-01: ii weak proof is denied after one item read and no lineage read", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  const args = ensureArgs(f, "int-weak", "Reject weak native evidence.");
  const itemId = installEvidence(f, args);
  ((f.details.get(itemId) as {nativeItemRef: {strength: string}}).nativeItemRef).strength = "weak";
  const reply = yield* mcpCall(f.endpoint, "workflow_write", args);
  assert.equal(reply.httpStatus, 200);
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.value, {status: "denied", operationId: "int-weak", reason: "native_item_not_main_strong"});
  assert.deepEqual(traffic(f), {projection: 1, shell: 0, archived: 0, turnItem: 1, total: 2});
  yield* noWriteRows(f);
  assertReadCredentials(f.peer);
}), {timeout: 60_000});

it.live("CT-INT-01: ii foreign proof from a child-run node is denied outside the main run", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  const args = ensureArgs(f, "int-foreign", "A child run cannot authorize this write.");
  installEvidence(f, args, {nodeKind: "subagent"});
  const reply = yield* mcpCall(f.endpoint, "workflow_write", args);
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.value, {status: "denied", operationId: "int-foreign", reason: "native_item_outside_main_run"});
  assert.deepEqual(traffic(f), {projection: 1, shell: 0, archived: 0, turnItem: 1, total: 2});
  yield* noWriteRows(f);
  assertReadCredentials(f.peer);
}), {timeout: 60_000});

it.live("CT-INT-01: ii truncated native input stays pending after the evidence window with one cached item read", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  const args = ensureArgs(f, "int-truncated", "Reject truncated native evidence.");
  installEvidence(f, args, {input: "truncated native input"});
  const {value: reply, elapsed} = yield* timed(mcpCall(f.endpoint, "workflow_write", args));
  assert.equal(reply.isError, false);
  assert.deepEqual(reply.value, {status: "pending", operationId: "int-truncated", reason: "native_input_incomplete", retryable: true});
  assert.ok(elapsed >= 400, `the production 400 ms evidence window elapsed (${Math.round(elapsed)} ms)`);
  const observed = traffic(f);
  assert.equal(observed.turnItem, 1, "an unchanged incomplete item is read once and cached");
  assert.ok(observed.projection >= 2, `the projection is polled during the window (${observed.projection})`);
  assert.equal(observed.shell, 0);
  assert.equal(observed.archived, 0);
  yield* noWriteRows(f);
  assertReadCredentials(f.peer);
}), {timeout: 60_000});

it.live("CT-INT-01: ii lagged evidence stays pending without reserving, then the published item creates", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  const args = ensureArgs(f, "int-lagged", "Wait for the native record.");
  const {value: pending, elapsed} = yield* timed(mcpCall(f.endpoint, "workflow_write", args));
  assert.equal(pending.isError, false);
  assert.deepEqual(pending.value, {status: "pending", operationId: "int-lagged", reason: "native_evidence_not_visible", retryable: true});
  assert.ok(elapsed >= 400, `the production 400 ms evidence window elapsed (${Math.round(elapsed)} ms)`);
  const before = traffic(f);
  assert.equal(before.turnItem, 0);
  assert.equal(before.shell, 0);
  assert.ok(before.projection >= 2, `the projection is polled during the window (${before.projection})`);
  yield* noWriteRows(f);

  installEvidence(f, args);
  const created = yield* mcpCall(f.endpoint, "workflow_write", args);
  assert.equal(created.isError, false);
  assert.equal((created.value as {status: string}).status, "created");
  assert.equal(yield* count(f, "supervisor_workflow_write_receipts"), 1);
  assert.equal(yield* count(f, "supervisor_workflow_write_evidence"), 1);
  assertReadCredentials(f.peer);
}), {timeout: 60_000});

it.live("CT-INT-01: ii lagged lineage stays pending after three incoherent active/archived reads", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  f.native.archivedSequence = () => f.native.snapshotSequence + 1;
  const args = ensureArgs(f, "int-lineage", "Wait for coherent native lineage.");
  installEvidence(f, args);
  const reply = yield* mcpCall(f.endpoint, "workflow_write", args);
  assert.equal(reply.isError, false);
  assert.deepEqual(reply.value, {status: "pending", operationId: "int-lineage", reason: "native_lineage_unavailable", retryable: true});
  assert.deepEqual(traffic(f), {projection: 1, shell: 3, archived: 3, turnItem: 1, total: 8});
  yield* noWriteRows(f);
  assertReadCredentials(f.peer);
}), {timeout: 60_000});

it.live("CT-INT-01: iii an exact replay and an operation ID conflict are answered from the receipt without native reads", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  const {args, reply} = yield* createMainWorkflow(f);
  assert.equal((reply.value as {status: string}).status, "created");
  const before = traffic(f);
  const connections = f.peer.connections.length;

  const replay = yield* mcpCall(f.endpoint, "workflow_write", args);
  assert.equal(replay.isError, false);
  assert.deepEqual(replay.value, reply.value);
  assert.deepEqual(traffic(f), before, "a replay issues no native request");

  const reused = yield* mcpCall(f.endpoint, "workflow_write", {...args, note: "Different input under the same operation ID."});
  assert.equal(reused.isError, false);
  assert.deepEqual(reused.value, {status: "conflict", operationId: "int-ensure", reason: "operation_id_reused", currentRevision: null});
  assert.deepEqual(traffic(f), before, "a conflict issues no native request");
  assert.equal(f.peer.connections.length, connections);
  assert.equal(yield* count(f, "supervisor_workflow_write_receipts"), 1);
  assert.equal(yield* count(f, "supervisor_workflow_write_evidence"), 1);
}), {timeout: 60_000});

it.live("CT-INT-01: iv a Stop committed between proof and commit denies at the commit recheck", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  // the shell read is the lineage read after the proof (workflow-write-controller.ts:861)
  f.native.beforeShell = once(stopMain(f));
  const args = ensureArgs(f, "int-stop", "Create the main workflow while a Stop lands.");
  installEvidence(f, args);
  const reply = yield* mcpCall(f.endpoint, "workflow_write", args);
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.value, {status: "denied", operationId: "int-stop", reason: "owner_changed"});
  yield* noWriteRows(f);
  assert.deepEqual((yield* f.core.policy.get()).excludedThreadIds, [f.mainThreadId]);
  const binding = yield* f.core.store.binding(f.projectId, f.mainThreadId);
  assert.equal(binding?.supervisionStop?.route, "ui");
  assert.equal(binding?.stopNotice?.state, "ready");
  assert.deepEqual(traffic(f), {projection: 1, shell: 1, archived: 1, turnItem: 1, total: 4});
}), {timeout: 60_000});

it.live("CT-INT-01: iv a binding generation change between proof and commit denies at the commit recheck", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  // the binding change committed on the native fake's hook, before it replies
  const supervisors = f.core.store;
  f.native.beforeShell = once(Effect.flatMap(supervisors.binding(f.projectId, f.mainThreadId),
    (binding) => supervisors.setBinding({...binding!, generation: f.binding.generation + 1})).pipe(Effect.orDie));
  const args = ensureArgs(f, "int-generation", "Create the main workflow while the binding changes.");
  installEvidence(f, args);
  const reply = yield* mcpCall(f.endpoint, "workflow_write", args);
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.value, {status: "denied", operationId: "int-generation", reason: "owner_changed"});
  yield* noWriteRows(f);
}), {timeout: 60_000});

it.live("CT-INT-01: iv a task source change during the definition read records one unsuccessful evidence row", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  const {value: created} = yield* createMainWorkflow(f);
  assert.equal(created.status, "created");
  const input: WorkflowApplyPatch = {
    operationId: "int-apply-source",
    workflowId: created.workflowId,
    expectedRevision: created.revision,
    plan: sequencePlan([localStep("Inspect source", "Use the task's pinned definitions.")]),
    note: "Apply the pinned plan while the task source changes.",
  };
  const args = yield* applyArgs(f, input);
  installEvidence(f, args);
  // the source change committed on the definitions read's hook, before the read answers
  const supervisors = f.core.store;
  f.definitionReader.onLoad = once(Effect.flatMap(supervisors.task(f.mainThreadId),
    (task) => supervisors.saveTask({...task!, sourceHash: fingerprint("changed")})).pipe(Effect.orDie));
  const reply = yield* mcpCall(f.endpoint, "workflow_write", args);
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.value, {status: "invalid", operationId: "int-apply-source", reason: "current_task_proposal_changed"});
  assert.equal(f.definitionReader.calls, 1);
  assert.equal((yield* f.core.workflowStates.get(f.projectId, f.mainThreadId))?.revision, 1);
  assert.equal(yield* count(f, "supervisor_workflow_write_receipts", "operation_id=?", "int-apply-source"), 0);
  const evidence = yield* rows(f.core.sql, "SELECT successful,result FROM supervisor_workflow_write_evidence WHERE operation_id=?", "int-apply-source");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.successful, 0);
  assert.deepEqual(JSON.parse(String(evidence[0]!.result)), reply.value);
}), {timeout: 60_000});

it.live("CT-INT-01: v excess and forbidden argument fields are rejected by the baseline parser before any native read", () => Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  // the proof binds the complete raw argument object, extra field included, so only the parser can refuse it
  const excess = {...ensureArgs(f, "int-excess", "Carry an unknown field."), unexpected: "value"};
  installEvidence(f, excess);
  const excessReply = yield* mcpCall(f.endpoint, "workflow_write", excess);
  assert.equal(excessReply.isError, true);
  assert.deepEqual(excessReply.value, {status: "invalid", operationId: "int-excess", reason: "invalid_ensure_main"});

  // an owner field is authority the service derives itself; it is not an accepted argument
  const forbidden = {...ensureArgs(f, "int-forbidden", "Name an owner main."), mainThreadId: f.mainThreadId};
  installEvidence(f, forbidden);
  const forbiddenReply = yield* mcpCall(f.endpoint, "workflow_write", forbidden);
  assert.equal(forbiddenReply.isError, true);
  assert.deepEqual(forbiddenReply.value, {status: "invalid", operationId: "int-forbidden", reason: "invalid_ensure_main"});

  assert.deepEqual(f.peer.log, []);
  yield* noWriteRows(f);
}), {timeout: 60_000});

const teamFixture = Effect.gen(function* () {
  const f = yield* startWorkflowFixture();
  const team = f.core.team;
  const member = yield* team.registerMember(f.binding, {threadId: "quarantine-helper", taskId: "quarantine-task", bootstrapRunId: "quarantine-bootstrap"});
  const ready = yield* team.markReady(f.binding, member.threadId, member.epoch);
  const helper = thread(member.threadId, f.projectId, f.supervisorThreadId, "subagent");
  f.catalogThreads.push(helper);
  f.native.shellThreads.push(shellThread(helper));
  const args = {supervisorThreadId: f.supervisorThreadId, bindingGeneration: f.binding.generation,
    action: "quarantine", operationId: "int-quarantine", memberThreadId: member.threadId};
  const memberState = (threadId = member.threadId) => Effect.map(team.snapshot(f.binding), (snapshot) => snapshot.members.find(item => item.threadId === threadId));
  return {f, team, ready, args, memberState};
});

it.live("CT-INT-02: valid, replay and conflict quarantine through native proof and one atomic team receipt", () => Effect.gen(function* () {
  const {f, team, ready, args, memberState} = yield* teamFixture;
  const second = yield* team.registerMember(f.binding, {threadId: "second-helper", taskId: "second-task", bootstrapRunId: "second-bootstrap"});
  const secondReady = yield* team.markReady(f.binding, second.threadId, second.epoch);
  const secondThread = thread(second.threadId, f.projectId, f.supervisorThreadId, "subagent");
  f.catalogThreads.push(secondThread);
  f.native.shellThreads.push(shellThread(secondThread));

  const itemId = installEvidence(f, args, {toolName: workflowToolNames.team.direct[0]});
  const reply = yield* mcpCall(f.endpoint, "supervision_team", args);
  assert.equal(reply.httpStatus, 200);
  assert.equal(reply.isError, false);
  const value = reply.value as {status: string; result: {state: string; epoch: number}; team: unknown};
  assert.equal(value.status, "ok");
  assert.equal(value.result.state, "quarantined");
  assert.equal(value.result.epoch, ready.epoch + 1);
  assert.equal(typeof value.team, "object");
  const receipts = yield* rows(f.core.sql, "SELECT evidence_item_id,document FROM supervisor_team_tool_receipts");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.evidence_item_id, itemId);
  assert.deepEqual(JSON.parse(String(receipts[0]!.document)), value);
  assert.equal((yield* team.snapshot(f.binding)).events.some(event => event.kind === "member_quarantined" && event.memberThreadId === "quarantine-helper"), true);
  assert.deepEqual(traffic(f), {projection: 1, shell: 1, archived: 1, turnItem: 1, total: 4});

  const replay = yield* mcpCall(f.endpoint, "supervision_team", args);
  assert.equal(replay.isError, false);
  assert.deepEqual(replay.value, JSON.parse(String(receipts[0]!.document)));
  assert.deepEqual(traffic(f), {projection: 2, shell: 1, archived: 1, turnItem: 2, total: 6}, "a team replay reads fresh proof but no lineage");
  assert.equal((yield* memberState())?.epoch, ready.epoch + 1);

  const conflictArgs = {...args, memberThreadId: second.threadId};
  installEvidence(f, conflictArgs, {toolName: workflowToolNames.team.direct[0]});
  const conflict = yield* mcpCall(f.endpoint, "supervision_team", conflictArgs);
  assert.equal(conflict.isError, true);
  assert.deepEqual(conflict.value, {status: "denied", reason: "operation_id_conflict"});
  assert.equal((yield* memberState(second.threadId))?.state, "ready");
  assert.equal((yield* memberState(second.threadId))?.epoch, secondReady.epoch);
  assert.equal(yield* count(f, "supervisor_team_tool_receipts"), 1);
  assertReadCredentials(f.peer);
}), {timeout: 60_000});

it.live("CT-INT-02: weak proof denies the quarantine with no lineage read and no receipt", () => Effect.gen(function* () {
  const {f, ready, args, memberState} = yield* teamFixture;
  const itemId = installEvidence(f, args, {toolName: workflowToolNames.team.direct[0]});
  ((f.details.get(itemId) as {nativeItemRef: {strength: string}}).nativeItemRef).strength = "weak";
  const reply = yield* mcpCall(f.endpoint, "supervision_team", args);
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.value, {status: "denied", reason: "native_item_not_main_strong"});
  assert.equal(yield* count(f, "supervisor_team_tool_receipts"), 0);
  assert.equal((yield* memberState())?.state, "ready");
  assert.equal((yield* memberState())?.epoch, ready.epoch);
  assert.deepEqual(traffic(f), {projection: 1, shell: 0, archived: 0, turnItem: 1, total: 2});
}), {timeout: 60_000});

it.live("CT-INT-02: a Stop between proof and mutation is caught by the post-proof recheck and by the atomic section", () => Effect.gen(function* () {
  const first = yield* teamFixture;
  const hooks = yield* hookRuntime;
  // (a) committed while the proof item is read: authorizeNative rechecks after the proof (workflow-write-controller.ts:1030)
  first.f.native.beforeTurnItem = onTurn(hooks, stopMain(first.f));
  installEvidence(first.f, first.args, {toolName: workflowToolNames.team.direct[0]});
  const proofStop = yield* mcpCall(first.f.endpoint, "supervision_team", first.args);
  assert.equal(proofStop.isError, true);
  assert.deepEqual(proofStop.value, {status: "denied", reason: "actor_changed"});
  assert.equal(yield* count(first.f, "supervisor_team_tool_receipts"), 0);
  assert.equal((yield* first.memberState())?.state, "ready");
  assert.equal((yield* first.memberState())?.epoch, first.ready.epoch);
  assert.deepEqual(traffic(first.f), {projection: 1, shell: 0, archived: 0, turnItem: 1, total: 2});

  const second = yield* teamFixture;
  // (b) committed while the lineage is read: the atomic section rechecks current() (supervisor-team-controller.ts:159)
  second.f.native.beforeShell = once(stopMain(second.f));
  installEvidence(second.f, second.args, {toolName: workflowToolNames.team.direct[0]});
  const lineageStop = yield* mcpCall(second.f.endpoint, "supervision_team", second.args);
  assert.equal(lineageStop.isError, true);
  assert.deepEqual(lineageStop.value, {status: "denied", reason: "actor_changed"});
  assert.equal(yield* count(second.f, "supervisor_team_tool_receipts"), 0);
  assert.equal((yield* second.memberState())?.state, "ready");
  assert.equal((yield* second.memberState())?.epoch, second.ready.epoch);
  assert.deepEqual(traffic(second.f), {projection: 1, shell: 1, archived: 1, turnItem: 1, total: 4});
}), {timeout: 60_000});
