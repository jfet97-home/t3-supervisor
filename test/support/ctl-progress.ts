import { Effect } from "effect";
import { ProjectSupervisor } from "../../src/project-supervisor.js";
import type { ProjectSupervisorScopeSnapshot } from "../../src/supervisor-observation.js";
import type { WorkflowProgressPageQuery } from "../../src/workflow-progress.js";
import { readWorkflowProgressPage as readPage } from "../../src/workflow-progress-reader.js";
import { WorkflowWriteController, type WorkflowReadResult } from "../../src/workflow-write-controller.js";

// partial services: the page reader calls only the locator, the scope read and the workflow read
export interface ProgressSupervision {
  workflowLocator(): {supervisorThreadId: string; bindingGeneration: number} | null;
  scopeSnapshot(projectId: string, mainThreadId: string, options?: unknown): ProjectSupervisorScopeSnapshot;
}

export interface ProgressReader {
  read(input: unknown): WorkflowReadResult;
}

/** The production progress page over in-memory supervision and workflow reads. Locator mutations are visible on the next read. */
export const readWorkflowProgressPage = (supervision: ProgressSupervision, reader: ProgressReader, query: WorkflowProgressPageQuery) =>
  readPage(query).pipe(
    Effect.provideService(ProjectSupervisor, ProjectSupervisor.of({
      workflowLocator: () => Effect.sync(() => supervision.workflowLocator()),
      scopeSnapshot: (projectId: string, mainThreadId: string, options?: unknown) => Effect.sync(() => supervision.scopeSnapshot(projectId, mainThreadId, options)),
    } as unknown as ProjectSupervisor["Service"])),
    Effect.provideService(WorkflowWriteController, WorkflowWriteController.of({
      read: (input: unknown) => Effect.sync(() => reader.read(input)),
    } as unknown as WorkflowWriteController["Service"])),
  );
