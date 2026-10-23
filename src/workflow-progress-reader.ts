import { Clock, Deferred, Effect } from "effect";
import { ProjectSupervisor } from "./project-supervisor.js";
import { emptyPage, maxWorkflowProgressResponseBytes, progressWorkflow, scopePage, type WorkflowProgressPageQuery, type WorkflowProgressSnapshot } from "./workflow-progress.js";
import { WorkflowWriteController } from "./workflow-write-controller.js";

// the server side of the dashboard's live progress page; the browser bundle imports only the schemas of workflow-progress.ts

const changedDuringRead = "The Supervisor binding changed during this read. Refresh progress to retry.";

/**
 * One live progress page for the current ready binding of a main: the workflow read and the native scope, the binding locator
 * rechecked after every read (any change answers unavailable with no partial data) and the combined response bounded to 1 MiB.
 */
export const readWorkflowProgressPage = Effect.fn("readWorkflowProgressPage")(function* (query: WorkflowProgressPageQuery) {
  const supervision = yield* ProjectSupervisor;
  const workflowReader = yield* WorkflowWriteController;
  const bounded = (result: WorkflowProgressSnapshot, observedAt: number): WorkflowProgressSnapshot =>
    new TextEncoder().encode(JSON.stringify(result)).length <= maxWorkflowProgressResponseBytes
      ? result
      : emptyPage(query, "too_large", "The combined live snapshot exceeds the dashboard response limit; no partial status was returned.", null, observedAt);
  const changed = Effect.map(Clock.currentTimeMillis, (observedAt) => emptyPage(query, "unavailable", changedDuringRead, null, observedAt));
  const locator = supervision.workflowLocator(query.projectId, query.mainThreadId);
  const matchingLocator = (expected: NonNullable<typeof locator>) => {
    const current = supervision.workflowLocator(query.projectId, query.mainThreadId);
    return current?.supervisorThreadId === expected.supervisorThreadId && current.bindingGeneration === expected.bindingGeneration;
  };
  const pageScope = supervision.scopeSnapshot(query.projectId, query.mainThreadId, {lineageOffset: query.lineageOffset, limit: query.limit});

  if (!locator) {
    const scope = yield* pageScope;
    if (scope.projectId !== query.projectId || scope.mainThreadId !== query.mainThreadId ||
      supervision.workflowLocator(query.projectId, query.mainThreadId)) return yield* changed;
    return bounded({...emptyPage(query, "unavailable", "No current ready Supervisor binding is available for this main conversation.",
      scope, scope.observedAt), lineageHasMore: scope.lineageHasMore}, yield* Clock.currentTimeMillis);
  }

  // the dashboard read ends with its request, not at the workflow tool's own deadline
  const requestBound = yield* Deferred.make<void>();
  const read = yield* workflowReader.read({
    supervisorThreadId: locator.supervisorThreadId,
    bindingGeneration: locator.bindingGeneration,
    workflowOffset: query.workflowOffset,
    lineageOffset: query.lineageOffset,
    limit: query.limit,
  }, requestBound);
  if (!matchingLocator(locator)) return yield* changed;
  if (read.status !== "ok") {
    const scope = yield* pageScope;
    if (!matchingLocator(locator) || scope.supervisorThreadId !== locator.supervisorThreadId ||
      scope.bindingGeneration !== locator.bindingGeneration || scope.projectId !== query.projectId || scope.mainThreadId !== query.mainThreadId) return yield* changed;
    return bounded({...emptyPage(query, read.status, read.reason, scope, scope.observedAt),
      lineageHasMore: scope.lineageHasMore,
      incompatibleWorkflows: read.status === "incompatible" ? [{workflowId: read.workflowId, formatVersion: read.formatVersion}] : []}, yield* Clock.currentTimeMillis);
  }
  if (read.owner.projectId !== query.projectId || read.owner.mainThreadId !== query.mainThreadId ||
    read.owner.supervisorThreadId !== locator.supervisorThreadId || read.owner.bindingGeneration !== locator.bindingGeneration) return yield* changed;
  const workflowThreadIds = read.lineage.map(thread => thread.threadId);
  const scope = yield* supervision.scopeSnapshot(query.projectId, query.mainThreadId, {threadIds: workflowThreadIds});
  if (!matchingLocator(locator) || scope.projectId !== query.projectId || scope.mainThreadId !== query.mainThreadId ||
    scope.supervisorThreadId !== locator.supervisorThreadId || scope.bindingGeneration !== locator.bindingGeneration) return yield* changed;
  const threadScope = scopePage(scope, workflowThreadIds);
  const observedAt = yield* Clock.currentTimeMillis;
  return bounded({
    status: "ok",
    message: scope.complete ? null : "Native scope observation is incomplete. Review the issues below before relying on this snapshot.",
    projectId: query.projectId,
    mainThreadId: query.mainThreadId,
    observedAt,
    scope: threadScope,
    coverage: (read.coverage ?? []).map(item => {
      const observeOnlyRoot = item.state === "unavailable" && item.actorThreadId === locator.supervisorThreadId;
      return {
        threadId: item.threadId,
        state: item.state === "root" ? "root" as const : item.state === "assigned" ? "assigned" as const :
          item.state === "transferring" ? "transfer" as const : observeOnlyRoot ? "observe_only" as const : "unknown" as const,
        assigneeThreadId: item.state === "assigned" || observeOnlyRoot ? item.actorThreadId : null,
        assigneeTitle: item.state === "assigned" || observeOnlyRoot ? item.actorTitle : null,
        assignmentRootThreadId: item.assignmentRootThreadId,
      };
    }),
    incompatibleWorkflows: read.incompatibleWorkflows,
    workflows: read.workflows.map(({document, parentNodeReferences}) => progressWorkflow(document, parentNodeReferences)),
    workflowOffset: read.workflowOffset,
    workflowHasMore: read.workflowHasMore,
    lineageOffset: read.lineageOffset,
    lineageHasMore: read.lineageHasMore,
  }, observedAt);
});
