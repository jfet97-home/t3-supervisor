import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Predicate } from "effect";
import { GuidanceDb } from "../src/db.js";
import { defaultSupervisorModel } from "../src/project-supervisor-store.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService, type GateGuard, type SupervisionGateShape, type SupervisionScopeStores } from "../src/supervision-gate.js";
import { HelperTransport } from "../src/supervisor-helper-transport.js";
import { NativeOperateRpc, type NativeRpcShape } from "../src/supervisor-native.js";
import { SupervisorTeamController } from "../src/supervisor-team-controller.js";
import type { Projection, SupervisorConfig, ThreadInfo } from "../src/types.js";
import { WorkflowStateStore } from "../src/workflow-state-store.js";
import { WorkflowNativeAccess, WorkflowWriteController } from "../src/workflow-write-controller.js";
import { workflowToolNames } from "../src/workflow-write-evidence.js";
import { openStores, openWorkflows, serviceOf } from "./support/store-units.js";
import { scopeStores } from "./support/team-units.js";

// CT-LIN-08 (target regression, plan 3.11): the workflow_write commit, a supervision_team mutation and a guide's reservation and
// steer each run as one admission section. A writer that asks for the section while a Stop holds it waits: its guard reads the
// Stop's commit and it writes nothing. A writer that committed before the Stop keeps its write.

type Fixture = Effect.Success<typeof setup>;

// the display reads of the writers' early checks: the chat stop as the Stop sections commit it, every scope enabled
class StopScope extends SupervisionScope {
  constructor(stores: SupervisionScopeStores, private readonly stopped: ReadonlySet<string>) {
    super({dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0} satisfies SupervisorConfig, stores, true);
  }
  override scopeEnabled() {return Effect.succeed(true);}
  override workflowEditingEnabled() {return Effect.succeed(true);}
  override supervisionStopped(threadId: string) {return Effect.succeed(this.stopped.has(threadId));}
}

const setup = Effect.gen(function* () {
  const directory = mkdtempSync(join(tmpdir(), "workflow-team-admission-"));
  const stores = yield* Effect.promise(() => openStores(directory));
  const sql = stores.sql;
  const supervisors = serviceOf(stores.supervisors);
  for (const scope of [null, "project"]) yield* sql`INSERT INTO meta VALUES(${`supervisor_control:${JSON.stringify(scope)}`},${JSON.stringify({generation: 1, enabled: true, manual: true})}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
  const binding = {...(yield* supervisors.reserve("project", "main", "main", defaultSupervisorModel, 1, 1)), state: "ready" as const};
  yield* supervisors.setBinding(binding);
  const team = serviceOf(stores.team);
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
  const projections = new Map<string, Projection>(threads.map(item => [item.id, {thread: item, runs: [], nodes: [], messages: [], turnItems: [], runtimeRequests: []}]));
  const branch = projections.get("branch")!;
  branch.runs.push({id: "branch-run", threadId: "branch", ordinal: 1, status: "running", activeAttemptId: "branch-attempt", rootNodeId: "branch-root",
    requestedAt: "2026-10-19T00:00:00Z", startedAt: "2026-10-19T00:00:00Z", completedAt: null});
  branch.providerTurns = [{id: "branch-turn", runAttemptId: "branch-attempt", nodeId: "branch-root", status: "running"}];
  const assignment = yield* team.assign(binding, "branch", member.threadId, new Map<string, string | null>([["main", null], ["branch", "main"]]));
  for (const notice of (yield* team.snapshot(binding)).notifications.filter(value => value.assignmentEpoch === assignment.epoch)) {
    yield* team.updateNotificationDelivery(binding, binding.threadId, notice.id, "sending");
    yield* team.updateNotificationDelivery(binding, binding.threadId, notice.id, "delivered");
    yield* team.acknowledgeNotification(binding, notice.recipientThreadId, notice.id, notice.memberEpoch);
  }
  yield* team.completeTransfer(binding, "branch", assignment.epoch);
  const details = new Map<string, unknown>();
  // the caller's own completed native tool call whose complete arguments equal the request
  const proof = (input: Record<string, unknown>, actor: string, tool: "write" | "team" | "guide") => {
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
  // the chat stop the admission guard and the display reads see; a Stop section sets it. `log` records the Stop's steps, each
  // admission request and each stop read of the admission guard, which only a section reads
  const stopped = new Set<string>();
  const log: string[] = [];
  const display = new StopScope(scopeStores(stores.supervisors), stopped);
  const guard: GateGuard = {scopeEnabled: () => Effect.succeed(true), supervisionStopped: (threadId) => Effect.sync(() => {log.push("guard");return stopped.has(threadId);}),
    workflowEditingEnabled: () => Effect.succeed(true)};
  const close = Effect.promise(() => stores.close()).pipe(Effect.andThen(Effect.sync(() => rmSync(directory, {recursive: true, force: true}))));
  return {stores, sql, supervisors, binding, team, member, assignment, threads, projections, details, proof, stopped, log, display, guard, close};
});

// the services over one admission gate, which records each admission request before it waits for the section
const services = (f: Fixture) => Effect.gen(function* () {
  const sections = yield* makeSupervisionGate(f.guard).pipe(Effect.provideService(GuidanceDb, f.sql));
  const gate: SupervisionGateShape = {admit: (body) => Effect.andThen(Effect.sync(() => f.log.push("admit")), sections.admit(body))};
  const dispatched: Array<Record<string, unknown>> = [];
  const native = WorkflowNativeAccess.of({
    listThreads: () => Effect.succeed(f.threads),
    projection: (threadId) => Effect.sync(() => f.projections.get(threadId)!),
    getTurnItem: ({itemId}) => Effect.succeed({item: f.details.get(itemId) ?? null}),
  });
  const operate: NativeRpcShape = {
    call: () => Effect.die(new Error("the guide only initiates")),
    initiate: (_tag, payload) => Effect.sync(() => {
      dispatched.push({...payload});
      return {sent: Effect.succeed(true), result: Effect.succeed({sequence: dispatched.length}), release: Effect.void};
    }),
  };
  const workflows = yield* Effect.promise(() => openWorkflows(f.stores, () => true));
  const stores = Context.add(f.stores.context, WorkflowStateStore, serviceOf(workflows));
  const writes = yield* WorkflowWriteController.make({maxEvidenceWaitMs: 0}).pipe(Effect.provideService(SupervisionGate, gate),
    Effect.provideService(WorkflowNativeAccess, native), Effect.provideService(SupervisionScopeService, f.display), Effect.provide(stores));
  const team = yield* SupervisorTeamController.make().pipe(Effect.provide(stores),
    Effect.provideService(WorkflowWriteController, writes), Effect.provideService(WorkflowNativeAccess, native),
    Effect.provideService(SupervisionGate, gate), Effect.provideService(NativeOperateRpc, operate),
    // the helper receipts are not read by these actions
    Effect.provideService(HelperTransport, {receiptDocument: () => Effect.succeed(null)} as unknown as HelperTransport["Service"]));
  return {gate, writes, team, dispatched};
});

const until = (condition: () => boolean) => Effect.gen(function* () {while (!condition()) yield* Effect.yieldNow;});
const admissions = (f: Fixture) => f.log.filter(entry => entry === "admit").length;

// a Stop that holds the section from its entry and commits the chat stop only once released
const stopSection = (f: Fixture, gate: SupervisionGateShape) => Effect.gen(function* () {
  const release = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkChild(gate.admit(() => Effect.gen(function* () {
    f.log.push("stop-entered");
    yield* Deferred.await(release);
    f.stopped.add("main");
    f.log.push("stop-committed");
  })));
  yield* until(() => f.log.includes("stop-entered"));
  return {release: Deferred.succeed(release, undefined), done: Fiber.join(fiber)};
});

// the writer asks for the section while the Stop holds it, and reads its guard only after the Stop committed
const waitedBehindStop = (f: Fixture) => {
  const committed = f.log.indexOf("stop-committed");
  const firstGuard = f.log.indexOf("guard");
  return committed >= 0 && firstGuard > committed && f.log.slice(0, committed).filter(entry => entry === "admit").length === 2;
};

const count = (f: Fixture, table: string) => Effect.map(f.sql.unsafe<{n: number}>(`SELECT count(*) AS n FROM ${table}`), (rows) => Number(rows[0]?.n));

const fixture = Effect.acquireRelease(setup, (f) => f.close);

it.live("CT-LIN-08: workflow_write: a write asking for its commit section while a Stop holds it waits, reads the Stop and stores nothing", () => Effect.gen(function* () {
  const f = yield* fixture;
  const {gate, writes} = yield* services(f);
  const args = {action: "ensure_main", supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, operationId: "stop-before-commit", note: "Create the main workflow."};
  f.proof(args, f.binding.threadId, "write");
  const stop = yield* stopSection(f, gate);
  const writing = yield* Effect.forkChild(writes.write(args));
  yield* until(() => admissions(f) === 2);
  yield* stop.release;
  yield* stop.done;
  assert.deepEqual(yield* Fiber.join(writing), {status: "denied", operationId: "stop-before-commit", reason: "owner_changed"});
  assert.ok(waitedBehindStop(f), f.log.join());
  assert.deepEqual([yield* count(f, "supervisor_workflow_write_receipts"), yield* count(f, "supervisor_workflow_write_evidence"), yield* count(f, "supervisor_workflow_state")], [0, 0, 0]);

  // a write committed before the Stop keeps it
  f.stopped.clear();
  const committed = {...args, operationId: "commit-before-stop"};
  f.proof(committed, f.binding.threadId, "write");
  assert.equal((yield* writes.write(committed)).status, "created");
  const later = yield* stopSection(f, gate);
  yield* later.release;
  yield* later.done;
  assert.deepEqual([yield* count(f, "supervisor_workflow_write_receipts"), yield* count(f, "supervisor_workflow_state")], [1, 1]);
}), {timeout: 10_000});

it.live("CT-LIN-08: supervision_team: a mutation asking for its section while a Stop holds it waits, reads the Stop and writes no receipt or notification", () => Effect.gen(function* () {
  const f = yield* fixture;
  const {gate, team} = yield* services(f);
  const args = {supervisorThreadId: f.binding.threadId, bindingGeneration: f.binding.generation, action: "note", operationId: "note-after-stop",
    memberThreadId: f.member.threadId, summary: "Check the failing test."};
  f.proof(args, f.binding.threadId, "team");
  const before = yield* f.team.snapshot(f.binding);
  const stop = yield* stopSection(f, gate);
  const calling = yield* Effect.forkChild(team.call(args));
  yield* until(() => admissions(f) === 2);
  yield* stop.release;
  yield* stop.done;
  assert.deepEqual(yield* Fiber.join(calling), {status: "denied", reason: "actor_changed"});
  assert.ok(waitedBehindStop(f), f.log.join());
  assert.deepEqual(yield* f.team.snapshot(f.binding), before);
  assert.equal(yield* count(f, "supervisor_team_tool_receipts"), 0);
}), {timeout: 10_000});

it.live("CT-LIN-08: supervision_guide: a guide asking for its reservation section while a Stop holds it waits, reads the Stop, reserves nothing, sends no steer and rejects as guidance_assignment_changed", () => Effect.gen(function* () {
  const f = yield* fixture;
  const {gate, team, dispatched} = yield* services(f);
  const args = {supervisorThreadId: f.member.threadId, bindingGeneration: f.binding.generation, memberEpoch: f.member.epoch, assignmentRootThreadId: "branch",
    assignmentEpoch: f.assignment.epoch, operationId: "guide-after-stop", targetThreadId: "branch", text: "Check the failing test."};
  f.proof(args, f.member.threadId, "guide");
  const stop = yield* stopSection(f, gate);
  const guiding = yield* Effect.forkChild(team.guide(args));
  yield* until(() => admissions(f) === 2);
  yield* stop.release;
  yield* stop.done;
  // the baseline reservation threw guidance_assignment_changed out of the unawaited send, so the call rejects
  const exit = yield* Fiber.await(guiding);
  assert.ok(Exit.isFailure(exit));
  assert.deepEqual(Predicate.isTagged(Cause.squash(exit.cause), "TeamDenied") ? (Cause.squash(exit.cause) as {reason: string}).reason : null, "guidance_assignment_changed");
  assert.ok(waitedBehindStop(f), f.log.join());
  assert.deepEqual(dispatched, []);
  assert.equal(yield* count(f, "supervisor_team_tool_receipts"), 0);
  assert.deepEqual(yield* f.team.unresolvedRequests(f.binding), []);

  // without a Stop the same guide reserves one attempt and sends one steer
  f.stopped.clear();
  const sent = {...args, operationId: "guide-without-stop"};
  f.proof(sent, f.member.threadId, "guide");
  assert.equal(((yield* team.guide(sent)) as {status: string}).status, "accepted");
  assert.equal(dispatched.length, 1);
}), {timeout: 10_000});
