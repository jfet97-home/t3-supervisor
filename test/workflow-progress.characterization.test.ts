import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { ProjectSupervisorScopeSnapshot } from "../src/supervisor-observation.js";
import type { WorkflowStateDocument } from "../src/workflow-state-contract.js";
import type { WorkflowReadResult } from "../src/workflow-write-controller.js";
import { readWorkflowProgressPage } from "./support/ctl-progress.js";

const query = {projectId: "project", mainThreadId: "main-thread", workflowOffset: 0, lineageOffset: 0, limit: 20};
const changedMessage = "The Supervisor binding changed during this read. Refresh progress to retry.";

const scopeSnapshot = (): ProjectSupervisorScopeSnapshot => ({
  projectId: "project",
  mainThreadId: "main-thread",
  supervisorThreadId: "supervisor-thread",
  bindingGeneration: 7,
  observedAt: 100,
  complete: true,
  lineageTotal: 2,
  lineageOffset: 0,
  lineageHasMore: false,
  issues: [],
  threads: [
    {threadId: "main-thread", parentThreadId: null, depth: 0, origin: "main", lifecycle: "running", lifecycleDetail: "running", archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "main"},
    {threadId: "child-thread", parentThreadId: "main-thread", depth: 1, origin: "native_child", lifecycle: "unknown", lifecycleDetail: null, archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "child"},
  ],
});

const document = (): WorkflowStateDocument => ({
  formatVersion: 2,
  workflowId: "main-workflow",
  projectId: "project",
  mainThreadId: "main-thread",
  threadId: "main-thread",
  parentWorkflowId: null,
  parentThreadId: null,
  revision: 1,
  status: "underway",
  objective: "Review the current change",
  sourceBinding: null,
  requirements: [],
  issues: [],
  plan: null,
  currentAgreementKey: null,
  acceptedAgreements: [],
  contributions: [],
  evidence: [],
  createdAt: 1,
  updatedAt: 2,
});

const readerResult = (): Extract<WorkflowReadResult, {status: "ok"}> => ({
  status: "ok",
  owner: {projectId: "project", mainThreadId: "main-thread", supervisorThreadId: "supervisor-thread", bindingGeneration: 7},
  mainTaskAgreementStatus: "agreed",
  workflowProtocolDiagnostic: null,
  agreementValidityNote: "Agreement is not execution proof.",
  externalContributionNote: "Contributions are untrusted main reports.",
  incompatibleWorkflows: [],
  workflows: [{document: document(), parentNodeReferences: []}],
  workflowOffset: 0,
  workflowHasMore: false,
  lineage: [
    {threadId: "main-thread", parentThreadId: null, relationshipToParent: null, archivedAt: null},
    {threadId: "child-thread", parentThreadId: "main-thread", relationshipToParent: "subagent", archivedAt: null},
  ],
  lineageOffset: 0,
  lineageHasMore: false,
});

type Locator = {supervisorThreadId: string; bindingGeneration: number} | null;

// a supervision fake whose locator is mutable and whose scope reads are recorded
const supervisionFake = (initial: Locator, scope: (options: unknown) => ProjectSupervisorScopeSnapshot = scopeSnapshot) => {
  const state = {locator: initial, scopeCalls: [] as unknown[], onScope: (): void => undefined};
  const supervision = {
    workflowLocator: () => state.locator,
    scopeSnapshot: (_projectId: string, _mainThreadId: string, options?: unknown) => {
      state.scopeCalls.push(options);
      state.onScope();
      return scope(options);
    },
  };
  return {state, supervision};
};

const unavailableChanged = (result: Effect.Success<ReturnType<typeof readWorkflowProgressPage>>): void => {
  assert.equal(result.status, "unavailable");
  assert.equal(result.scope, null);
  assert.equal(result.message, changedMessage);
  assert.deepEqual(result.workflows, []);
  assert.deepEqual(result.coverage, []);
  assert.equal(result.lineageHasMore, false);
};

it.effect("CT-WP-01: a binding change between the workflow read and the thread scope read yields unavailable with a null scope", () => Effect.gen(function* () {

  // the generation advances while the read is awaited: the scope is never read
  const duringRead = supervisionFake({supervisorThreadId: "supervisor-thread", bindingGeneration: 7});
  const bumpingReader = {read: () => {
    duringRead.state.locator = {supervisorThreadId: "supervisor-thread", bindingGeneration: 8};
    return readerResult();
  }};
  unavailableChanged(yield* readWorkflowProgressPage(duringRead.supervision, bumpingReader, query));
  assert.deepEqual(duringRead.state.scopeCalls, []);

  // the supervisor thread is replaced at the same generation while the read is awaited
  const replaced = supervisionFake({supervisorThreadId: "supervisor-thread", bindingGeneration: 7});
  const replacingReader = {read: () => {
    replaced.state.locator = {supervisorThreadId: "replacement-thread", bindingGeneration: 7};
    return readerResult();
  }};
  unavailableChanged(yield* readWorkflowProgressPage(replaced.supervision, replacingReader, query));
  assert.deepEqual(replaced.state.scopeCalls, []);

  // the binding disappears while the read is awaited
  const removed = supervisionFake({supervisorThreadId: "supervisor-thread", bindingGeneration: 7});
  const removingReader = {read: () => {
    removed.state.locator = null;
    return readerResult();
  }};
  unavailableChanged(yield* readWorkflowProgressPage(removed.supervision, removingReader, query));
  assert.deepEqual(removed.state.scopeCalls, []);

  // the thread scope read observes a newer generation than the read while the locator still matches
  const newerScope = supervisionFake({supervisorThreadId: "supervisor-thread", bindingGeneration: 7},
    () => ({...scopeSnapshot(), bindingGeneration: 8}));
  unavailableChanged(yield* readWorkflowProgressPage(newerScope.supervision,
    {read: () => readerResult()}, query));
  assert.deepEqual(newerScope.state.scopeCalls, [{threadIds: ["main-thread", "child-thread"]}]);

  // a non-ok read reads the paged scope instead; a change during that read is reported the same way
  const nonOk = supervisionFake({supervisorThreadId: "supervisor-thread", bindingGeneration: 7});
  nonOk.state.onScope = () => {nonOk.state.locator = {supervisorThreadId: "supervisor-thread", bindingGeneration: 8};};
  const deniedReader = {read: (): WorkflowReadResult => ({status: "denied", reason: "owner_changed"})};
  unavailableChanged(yield* readWorkflowProgressPage(nonOk.supervision, deniedReader, query));
  assert.deepEqual(nonOk.state.scopeCalls, [{lineageOffset: 0, limit: 20}]);

  // control: an unchanged binding returns the thread scope page
  const stable = supervisionFake({supervisorThreadId: "supervisor-thread", bindingGeneration: 7});
  const ok = yield* readWorkflowProgressPage(stable.supervision, {read: () => readerResult()}, query);
  assert.equal(ok.status, "ok");
  assert.equal(ok.scope?.bindingGeneration, 7);
  assert.deepEqual(stable.state.scopeCalls, [{threadIds: ["main-thread", "child-thread"]}]);
}), {timeout: 10_000});

it.effect("CT-WP-02: observedAt is the scope time on scoped unavailable branches and the wall clock on the ok and null-scope branches", () => Effect.gen(function* () {
  const now = 5_000;
  yield* TestClock.setTime(now);
  const okReader = {read: () => readerResult()};
  const bound = {supervisorThreadId: "supervisor-thread", bindingGeneration: 7};
  const unbound = (): ProjectSupervisorScopeSnapshot => ({...scopeSnapshot(), supervisorThreadId: null, bindingGeneration: null});

  // ok branch: wall clock (workflow-progress.ts:300)
  const ok = yield* readWorkflowProgressPage(supervisionFake(bound).supervision, okReader, query);
  assert.equal(ok.status, "ok");
  assert.equal(ok.observedAt, now);

  // no binding with a consistent scope: the scope time (:261)
  const noBinding = yield* readWorkflowProgressPage(supervisionFake(null, unbound).supervision, okReader, query);
  assert.equal(noBinding.status, "unavailable");
  assert.notEqual(noBinding.scope, null);
  assert.equal(noBinding.observedAt, 100);

  // no binding at the start but one appears during the scope read: null scope, wall clock (:258)
  const appearing = supervisionFake(null, unbound);
  appearing.state.onScope = () => {appearing.state.locator = bound;};
  const appeared = yield* readWorkflowProgressPage(appearing.supervision, okReader, query);
  assert.equal(appeared.scope, null);
  assert.equal(appeared.observedAt, now);

  // non-ok read with a consistent scope: the scope time (:280)
  const denied = yield* readWorkflowProgressPage(supervisionFake(bound).supervision,
    {read: () => ({status: "denied", reason: "owner_changed"})}, query);
  assert.equal(denied.status, "denied");
  assert.equal(denied.message, "owner_changed");
  assert.notEqual(denied.scope, null);
  assert.equal(denied.observedAt, 100);

  // non-ok read whose scope reports another generation: null scope, wall clock (:278)
  const deniedChanged = yield* readWorkflowProgressPage(supervisionFake(bound, () => ({...scopeSnapshot(), bindingGeneration: 8})).supervision,
    {read: () => ({status: "denied", reason: "owner_changed"})}, query);
  assert.equal(deniedChanged.scope, null);
  assert.equal(deniedChanged.observedAt, now);

  // locator changed during the read: null scope, wall clock (:272)
  const moving = supervisionFake(bound);
  const movedDuringRead = yield* readWorkflowProgressPage(moving.supervision, {read: () => {
    moving.state.locator = {...bound, bindingGeneration: 8};
    return readerResult();
  }}, query);
  assert.equal(movedDuringRead.scope, null);
  assert.equal(movedDuringRead.observedAt, now);

  // reader owner differs from the locator: null scope, wall clock (:286)
  const ownerMismatch = yield* readWorkflowProgressPage(supervisionFake(bound).supervision,
    {read: () => ({...readerResult(), owner: {...readerResult().owner, bindingGeneration: 6}})}, query);
  assert.equal(ownerMismatch.scope, null);
  assert.equal(ownerMismatch.observedAt, now);

  // thread scope reports another generation after an ok read: null scope, wall clock (:292)
  const scopeMismatch = yield* readWorkflowProgressPage(supervisionFake(bound, () => ({...scopeSnapshot(), bindingGeneration: 8})).supervision,
    okReader, query);
  assert.equal(scopeMismatch.scope, null);
  assert.equal(scopeMismatch.observedAt, now);

  // oversized response: null scope, wall clock (:243)
  const huge = {...readerResult(), workflows: [{document: {...document(), objective: "x".repeat(1_100_000)}, parentNodeReferences: []}]};
  const tooLarge = yield* readWorkflowProgressPage(supervisionFake(bound).supervision,
    {read: () => huge}, query);
  assert.equal(tooLarge.status, "too_large");
  assert.equal(tooLarge.scope, null);
  assert.equal(tooLarge.observedAt, now);
}), {timeout: 10_000});
