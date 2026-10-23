import { Effect } from "effect";
import { ProjectSupervisor, type ProjectSupervisorScopeSnapshotOptions } from "../../src/project-supervisor.js";
import type { ProjectSupervisorScopeSnapshot } from "../../src/supervisor-observation.js";
import type { WorkflowProgressPageQuery, WorkflowProgressSnapshot } from "../../src/workflow-progress.js";
import { readWorkflowProgressPage as readPage } from "../../src/workflow-progress-reader.js";
import { WorkflowWriteController, type WorkflowReadResult } from "../../src/workflow-write-controller.js";

// the baseline promise fakes of the progress reads: the supervisor's locator and scope reads and the controller's workflow read
type SupervisionFake = {
  workflowLocator(projectId: string, mainThreadId: string): {supervisorThreadId: string; bindingGeneration: number} | null;
  scopeSnapshot(projectId: string, mainThreadId: string, signal: AbortSignal, options?: ProjectSupervisorScopeSnapshotOptions): Promise<ProjectSupervisorScopeSnapshot>;
};
type ReaderFake = {read(input: unknown, signal?: AbortSignal): Promise<WorkflowReadResult>};

// the page read in its baseline call shape: the fakes as the supervisor and write controller services, the request's signal as
// the read's interruption; a rejected fake read rejects the page read
export const readWorkflowProgressPage = (supervision: unknown, workflowReader: unknown, query: WorkflowProgressPageQuery,
  signal: AbortSignal): Promise<WorkflowProgressSnapshot> => {
  const fake = supervision as SupervisionFake;
  const reader = workflowReader as ReaderFake;
  const supervisor = {
    // the locator is the supervisor's effect; the fake answers when the reader runs it, as the baseline call did
    workflowLocator: (projectId: string, mainThreadId: string) => Effect.sync(() => fake.workflowLocator(projectId, mainThreadId)),
    scopeSnapshot: (projectId: string, mainThreadId: string, options?: ProjectSupervisorScopeSnapshotOptions) =>
      Effect.promise((read) => fake.scopeSnapshot(projectId, mainThreadId, read, options)),
  } as unknown as ProjectSupervisor["Service"];
  const writes = {read: (input: unknown) => Effect.promise(() => reader.read(input))} as unknown as WorkflowWriteController["Service"];
  return Effect.runPromise(readPage(query).pipe(Effect.provideService(ProjectSupervisor, supervisor), Effect.provideService(WorkflowWriteController, writes)), {signal});
};
