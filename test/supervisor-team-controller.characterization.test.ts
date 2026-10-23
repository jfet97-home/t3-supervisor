import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it} from "@effect/vitest";
import {Context, Deferred, Effect, Fiber, Layer} from "effect";
import type {SqlClient} from "effect/sql";
import {defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {SupervisorRpcError, type NativeRpcShape} from "../src/supervisor-native.js";
import type {SupervisorTeamController} from "../src/supervisor-team-controller.js";
import {ThreadPolicyStore} from "../src/thread-policy.js";
import type {WorkflowCallCancel} from "../src/workflow-write-controller.js";
import {workflowToolInputMaxBytes, workflowToolInputSize, workflowToolNames} from "../src/workflow-write-evidence.js";
import type {Projection, ThreadInfo} from "../src/types.js";
import {cancelAfter, within} from "./support/g11-http.js";
import {openSupervisionStores, policyLayer, row, rows, supervisionStores, temporaryDirectory} from "./support/g11-stores.js";
import {teamControllers, type TeamNative} from "./support/g11-team.js";

// the baseline controller characterizations on the team controller's production layers over the store services of a
// temporary guidance file, with fake native reads and a fake operate client. it.live: the stores are real database files,
// times the stores leave out are the wall clock as at baseline, and the baseline's call and wait deadlines stay on the live
// clock

// one operate request: its tag, payload and the call's cancel (the baseline signal)
type Call = {tag: string; payload: Record<string, unknown>; cancel: WorkflowCallCancel};

// a call under the baseline's AbortSignal.timeout(5_000), as a cancel that completes at that deadline
const deadline = <A, E>(call: (cancel: WorkflowCallCancel) => Effect.Effect<A, E>) => Effect.scoped(Effect.flatMap(cancelAfter("5 seconds"), call));

const settings = (dataDirectory: string) => ({dataDirectory, t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0});

// the baseline controller suite's fixture, with a ready helper actively assigned a running delegated child and a native rpc
const fixture = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("c1-team-controller-");
  // the first client of the file is closed by a simulated crash, or with the test scope
  const stores = yield* supervisionStores(directory);
  const policy = Context.get(yield* Layer.build(policyLayer(settings(directory))), ThreadPolicyStore);
  const {supervisors, team, sql} = stores;
  const binding = {...(yield* supervisors.reserve("project", "main", "main", defaultSupervisorModel, 1, 1)), state: "ready" as const};
  yield* supervisors.setBinding(binding);
  const registered = yield* team.registerMember(binding, {threadId: "helper", taskId: "task", bootstrapRunId: "bootstrap"});
  const member = yield* team.markReady(binding, registered.threadId, registered.epoch);
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
  const assignment = yield* team.assign(binding, "branch", member.threadId, parents);
  for (const notice of (yield* team.snapshot(binding)).notifications.filter(value => value.assignmentEpoch === assignment.epoch)) {
    yield* team.updateNotificationDelivery(binding, binding.threadId, notice.id, "sending");
    yield* team.updateNotificationDelivery(binding, binding.threadId, notice.id, "delivered");
    yield* team.acknowledgeNotification(binding, notice.recipientThreadId, notice.id, notice.memberEpoch);
  }
  yield* team.completeTransfer(binding, "branch", assignment.epoch);
  const details = new Map<string, unknown>();
  const reads: string[] = [];
  let readHook: ((id: string) => Effect.Effect<void> | null) | null = null;
  const native: TeamNative = {listThreads: () => Effect.succeed(threads), turnItem: (itemId) => Effect.sync(() => details.get(itemId)),
    projection: (id) => Effect.gen(function* () {
      reads.push(id);
      const held = readHook?.(id) ?? null;
      if (held) yield* held;
      const projection = projections.get(id);
      if (!projection) return yield* Effect.die(new Error("unreadable"));
      return projection;
    })};
  const calls: Call[] = [];
  let interceptor: ((call: Call) => Effect.Effect<unknown, SupervisorRpcError> | null) | null = null;
  const pending: Array<Deferred.Deferred<unknown, SupervisorRpcError>> = [];
  // the operate client: a request is recorded and intercepted when it is committed; an initiation commits it at once
  const invoke = (tag: string, payload: Readonly<Record<string, unknown>>, cancel: WorkflowCallCancel | undefined) => {
    const call: Call = {tag, payload: {...payload}, cancel: cancel ?? Deferred.makeUnsafe<void>()};calls.push(call);
    const held = interceptor?.(call) ?? null;
    if (held) return held;
    return Effect.succeed({sequence: calls.length});
  };
  const rpc: NativeRpcShape = {
    call: (tag, payload, cancel) => Effect.suspend(() => invoke(tag, payload, cancel)),
    initiate: (tag, payload, cancel) => Effect.sync(() => ({sent: Effect.succeed(true), result: invoke(tag, payload, cancel), release: Effect.void})),
  };
  const makeController = (opened: typeof stores) => Effect.map(teamControllers(opened, policy, native, {rpc}), (built) => built.controller);
  const controller = yield* makeController(stores);
  // a dispatch still pending when the test ends is abandoned: it fails as the baseline call failed when its test finished
  yield* Effect.addFinalizer(() => Effect.forEach(pending, (held) => Deferred.fail(held, new SupervisorRpcError("uncertain")), {discard: true}));
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
  const receipt = (db: SqlClient.SqlClient, operationId: string) => Effect.map(row(db, "SELECT document FROM supervisor_team_tool_receipts WHERE operation_id=?", operationId),
    (found) => found ? JSON.parse(String(found.document)) as {status: string; requestId: string; messageId: string; commandId: string; attempts: Array<{status: string; reason?: string}>} : null);
  return {directory, sql, supervisors, team, binding, member, assignment, threads, projections, branch, reads, calls, controller, proof, guideInput, receipt,
    dispatches: () => calls.filter(call => call.tag === "orchestration.dispatchCommand"),
    intercept: (next: typeof interceptor) => {interceptor = next;},
    holdReads: (hook: typeof readHook) => {readHook = hook;},
    never: () => {const held = Deferred.makeUnsafe<unknown, SupervisorRpcError>();pending.push(held);return Deferred.await(held);},
    // the first client closes, as a crash closes the process's file
    crash: stores.close,
    abandon: Effect.forEach(pending, (held) => Deferred.fail(held, new SupervisorRpcError("uncertain")), {discard: true}),
    reopen: Effect.gen(function* () {
      const reopened = yield* Effect.acquireRelease(openSupervisionStores(directory), (opened) => opened.close);
      return {sql: reopened.sql, team: reopened.team, controller: yield* makeController(reopened)};
    })};
});

type GuideResult = {status: string; reason?: string; attempts?: unknown[]};
const requestStates = (db: SqlClient.SqlClient, requestId: string) =>
  Effect.map(rows(db, "SELECT state FROM supervisor_team_requests WHERE request_id=?", requestId), (found) => found.map(item => String(item.state)));
// a guide under the given cancel, else under the baseline's 5 s deadline
const guide = (controller: SupervisorTeamController["Service"], input: Record<string, unknown>, cancel?: WorkflowCallCancel) =>
  Effect.map(cancel ? controller.guide(input, cancel) : deadline((bounded) => controller.guide(input, bounded)), (value) => value as GuideResult);

// the visible native steer the guide's message identity names
const deliver = (f: Effect.Success<typeof fixture>, messageId: string, text: string) => f.branch.messages.push({id: messageId, threadId: "branch", runId: "branch-run",
  nodeId: "branch-root", role: "user", text, createdBy: "user", creationSource: "server", streaming: false, createdAt: "2026-10-19T00:00:01Z", updatedAt: "2026-10-19T00:00:01Z"});

for (const variant of ["after the request was sent", "before the request was sent"] as const) {
  it.live(`CT-TCTRL-01: aborting guide() ${variant} classifies the reserved attempt and a later guide() only reconciles it`, () => Effect.gen(function* () {
    const f = yield* fixture;
    const input = f.guideInput(`abort-${variant.startsWith("after") ? "sent" : "unsent"}`);
    f.proof(input, f.member.threadId, "guide");
    const reached = yield* Deferred.make<Call>();
    f.intercept(call => {
      Deferred.doneUnsafe(reached, Effect.succeed(call));
      // the real client classifies an abort as uncertain once its request frame was sent, rejected before that
      return Effect.andThen(Deferred.await(call.cancel), Effect.fail(new SupervisorRpcError(variant.startsWith("after") ? "uncertain" : "rejected")));
    });
    const cancel = yield* Deferred.make<void>();
    const running = yield* Effect.forkChild(guide(f.controller, input, cancel));
    const call = yield* within(Deferred.await(reached), "3 seconds", "dispatch");
    const prepared = yield* f.receipt(f.sql, input.operationId);
    assert.ok(prepared);
    assert.deepEqual([prepared.status, prepared.attempts.length, prepared.attempts[0]?.status], ["prepared", 1, "prepared"]);
    assert.deepEqual([call.payload.messageId, call.payload.commandId, call.payload.threadId], [prepared.messageId, prepared.commandId, "branch"]);
    yield* Deferred.succeed(cancel, undefined);
    const result = yield* within(Fiber.join(running), "3 seconds", "aborted guide");
    const teamRequest = Effect.map(requestStates(f.sql, prepared.requestId), (states) => states.join());
    if (variant.startsWith("after")) {
      assert.deepEqual([result.status, result.reason], ["uncertain", "original_send_requires_reconciliation"]);
      assert.equal((yield* f.receipt(f.sql, input.operationId))?.attempts[0]?.status, "uncertain");
      assert.equal(yield* teamRequest, "uncertain");
      f.intercept(null);
      assert.deepEqual(yield* Effect.map(guide(f.controller, input), value => [value.status, value.reason]), ["uncertain", "original_send_requires_reconciliation"]);
      deliver(f, prepared.messageId, input.text);
      assert.equal((yield* guide(f.controller, input)).status, "delivered");
      assert.equal(yield* teamRequest, "settled");
    } else {
      assert.deepEqual([result.status, result.reason], ["not_sent", "native_transport_not_sent"]);
      assert.equal(yield* teamRequest, "settled");
      f.intercept(null);
      assert.equal((yield* guide(f.controller, input)).status, "not_sent", "the stored outcome is returned without another dispatch");
    }
    assert.equal(f.dispatches().length, 1);
  }), {timeout: 10_000});
}

it.live("CT-TCTRL-01: a crash after the reservation keeps the receipt 'prepared'; a new process reconciles it by message id without a second dispatch", () => Effect.gen(function* () {
  const f = yield* fixture;
  const input = f.guideInput("crash");
  f.proof(input, f.member.threadId, "guide");
  const reached = yield* Deferred.make<void>();
  f.intercept(() => {Deferred.doneUnsafe(reached, Effect.void);return f.never();});
  const abandoned = yield* Effect.forkChild(guide(f.controller, input));
  yield* Effect.gen(function* () {
    yield* within(Deferred.await(reached), "3 seconds", "dispatch");
    const prepared = yield* f.receipt(f.sql, input.operationId);
    assert.ok(prepared?.status === "prepared");
    yield* f.crash;

    f.intercept(null);
    const restarted = yield* f.reopen;
    assert.deepEqual(yield* f.receipt(restarted.sql, input.operationId), prepared, "reopening performs no recovery");
    assert.deepEqual(yield* Effect.map(guide(restarted.controller, input), value => [value.status, value.reason]), ["uncertain", "original_send_requires_reconciliation"]);
    deliver(f, prepared.messageId, input.text);
    assert.equal((yield* guide(restarted.controller, input)).status, "delivered");
    assert.deepEqual(yield* requestStates(restarted.sql, prepared.requestId), ["settled"]);
    assert.equal(f.dispatches().length, 1);
  }).pipe(
    // the abandoned dispatch fails as the baseline's did when its test finished, and the abandoned guide then settles
    Effect.ensuring(Effect.andThen(f.abandon, within(Fiber.await(abandoned), "3 seconds", "abandoned guide"))));
}), {timeout: 10_000});

it.live("CT-TCTRL-02: two concurrent guide() calls with one operationId reserve one attempt and dispatch once; the other returns the stored record", () => Effect.gen(function* () {
  const f = yield* fixture;
  const input = f.guideInput("concurrent");
  f.proof(input, f.member.threadId, "guide");
  // both calls pass their receipt check and meet at the target read inside the route search
  let arrived = 0;
  const barrier = yield* Deferred.make<void>();
  f.holdReads(id => {
    if (id !== "branch" || arrived >= 2) return null;
    arrived += 1;
    if (arrived === 2) Deferred.doneUnsafe(barrier, Effect.void);
    return Deferred.await(barrier);
  });
  const dispatched = yield* Deferred.make<unknown, SupervisorRpcError>();
  f.intercept(() => Deferred.await(dispatched));
  const first = yield* Effect.forkChild(guide(f.controller, input));
  const second = yield* Effect.forkChild(guide(f.controller, input));
  const settledFirst = yield* Effect.raceFirst(Effect.map(Fiber.join(first), value => ["first", value] as const), Effect.map(Fiber.join(second), value => ["second", value] as const));
  assert.equal(settledFirst[1].status, "prepared", "the call that lost the reservation returns the stored record");
  assert.equal(f.dispatches().length, 1);
  yield* Deferred.succeed(dispatched, {sequence: 7});
  const results = yield* within(Effect.all([Fiber.join(first), Fiber.join(second)]), "3 seconds", "guides");
  assert.deepEqual(results.map(value => value.status).sort(), ["accepted", "prepared"]);
  const stored = yield* f.receipt(f.sql, input.operationId);
  assert.equal(stored?.status, "accepted");
  assert.equal(stored?.attempts.length, 1);
  assert.deepEqual(yield* requestStates(f.sql, String(stored?.requestId)), ["pending"]);
  f.holdReads(null);
  assert.equal((yield* guide(f.controller, input)).status, "accepted");
  assert.equal(f.dispatches().length, 1);
}), {timeout: 10_000});

const tableDigest = (db: SqlClient.SqlClient) => Effect.gen(function* () {
  const hash = createHash("sha256");
  for (const {name} of yield* rows(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
    hash.update(`${String(name)}\0${JSON.stringify(yield* rows(db, `SELECT * FROM "${String(name)}" ORDER BY rowid`))}\0`);
  return hash.digest("hex");
});
const totalChanges = (db: SqlClient.SqlClient) => Effect.map(row(db, "SELECT total_changes() AS n"), (found) => Number(found?.n));

it.live("CT-TCTRL-04: register is denied with native_completed_bootstrap_not_verified and writes nothing unless the first run is the exact completed bootstrap", () => Effect.gen(function* () {
  const f = yield* fixture;
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
  const register = (operationId: string) => Effect.gen(function* () {
    const input = {supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, action: "register", operationId,
      memberThreadId: "helper-new", taskId: "delegate-task", bootstrapRunId: "bootstrap-run"};
    f.proof(input, f.binding.threadId, "team");
    const digest = yield* tableDigest(f.sql);
    const changes = yield* totalChanges(f.sql);
    const result = (yield* deadline((cancel) => f.controller.call(input, cancel))) as {status: string; reason?: string};
    return {result, unchanged: (yield* tableDigest(f.sql)) === digest && (yield* totalChanges(f.sql)) === changes};
  });
  const denied = {result: {status: "denied", reason: "native_completed_bootstrap_not_verified"}, unchanged: true};

  const earlier = {id: "earlier-run", threadId: "helper-new", ordinal: 1, status: "completed", userMessageId: null,
    requestedAt: "2026-10-19T00:00:00Z", startedAt: "2026-10-19T00:00:00Z", completedAt: "2026-10-19T00:00:00Z", rootNodeId: null};
  child.runs.unshift(earlier);
  assert.deepEqual(yield* register("register-not-first"), denied);
  child.runs.shift();
  child.messages[0]!.text = "A different bootstrap text.";
  assert.deepEqual(yield* register("register-other-text"), denied);
  child.runs[0]!.status = "running";
  child.messages[0]!.text = "Bootstrap the helper role.";
  assert.deepEqual(yield* register("register-unfinished"), denied);

  // the same native records with the exact completed bootstrap register the helper
  child.runs[0]!.status = "completed";
  const accepted = yield* register("register-exact");
  assert.equal(accepted.result.status, "ok");
  assert.equal(accepted.unchanged, false);
  assert.ok((yield* f.team.snapshot(f.binding)).members.some(value => value.threadId === "helper-new"));
}), {timeout: 10_000});

it.live("CT-TCTRL-05: unknown keys, oversize input and non-integer epochs return invalid_team_arguments and invalid_guidance_arguments exactly", () => Effect.gen(function* () {
  const f = yield* fixture;
  const team = {supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, action: "note", operationId: "note-operation",
    memberThreadId: f.member.threadId, summary: ""};
  const pad = workflowToolInputMaxBytes - workflowToolInputSize(team);
  const digest = yield* tableDigest(f.sql);
  const changes = yield* totalChanges(f.sql);
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
  ]) assert.deepEqual(yield* deadline((cancel) => f.controller.call(input, cancel)), invalidTeam, JSON.stringify(input).slice(0, 120));
  assert.equal(workflowToolInputSize({...team, summary: "x".repeat(pad)}), workflowToolInputMaxBytes);
  assert.notDeepEqual(yield* deadline((cancel) => f.controller.call({...team, summary: "x".repeat(pad)}, cancel)), invalidTeam, "an input at the byte limit is parsed");

  const guidance = f.guideInput("parse");
  const invalidGuidance = {status: "invalid", reason: "invalid_guidance_arguments"};
  for (const input of [
    {...guidance, action: "read"},
    {...guidance, text: "x".repeat(workflowToolInputMaxBytes)},
    {...guidance, text: "x".repeat(12_001)},
    {...guidance, memberEpoch: 1.5},
    {...guidance, assignmentEpoch: "1"},
    {...guidance, bindingGeneration: 0},
  ]) assert.deepEqual(yield* deadline((cancel) => f.controller.guide(input, cancel)), invalidGuidance, JSON.stringify(input).slice(0, 120));
  assert.deepEqual(f.calls, []);
  assert.equal(yield* tableDigest(f.sql), digest);
  assert.equal(yield* totalChanges(f.sql), changes);
}), {timeout: 10_000});
