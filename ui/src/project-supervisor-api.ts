import { Schema } from "effect";
import { WorkflowProgressSnapshotSchema, type WorkflowProgressSnapshot } from "../../src/workflow-progress.js";
import {
  ProjectSupervisorSnapshot,
  ProjectSupervisorSaveResult,
  type ProjectSupervisorInfo,
  type ProjectSupervisorChatSupervisionInput, ProjectSupervisorRetryInput,
  type ProjectSupervisorSaveInput,
} from "../../src/project-supervisor-contract.js";
import { getCsrfToken, loadAccess, sessionHeaders } from "./access.js";

export class ProjectSupervisorRequestError extends Error {
  constructor(message: string, readonly definitelyNotSaved: boolean) {super(message);}
}

export const loadProjectSupervisor = async (projectId: string, signal: AbortSignal, mainThreadId: string | null = null): Promise<ProjectSupervisorInfo> => {
  const query = new URLSearchParams({projectId});
  if (mainThreadId) query.set("mainThreadId", mainThreadId);
  const response = await fetch(`/api/guidance/project-supervisor?${query}`, {credentials: "omit", headers: sessionHeaders(), signal});
  if (!response.ok) throw new Error("Supervisor settings could not be loaded.");
  const value = Schema.decodeUnknownSync(ProjectSupervisorSnapshot)(await response.json());
  if (signal.aborted || value.projectId !== projectId || value.mainThreadId !== mainThreadId) throw new Error("The Supervisor response belongs to another project.");
  if (value.settings.teamSettings && (!Number.isInteger(value.settings.teamSettings.maxHelpersPerRoot) ||
    value.settings.teamSettings.maxHelpersPerRoot < 0 || value.settings.teamSettings.maxHelpersPerRoot > 20))
    throw new Error("The Supervisor team settings are outside the supported range.");
  if (value.team && value.binding && value.team.root.threadId !== value.binding.threadId)
    throw new Error("The Supervisor team response belongs to another root conversation.");
  return value;
};

export type WorkflowProgressPageRequest = {
  workflowOffset?: number;
  lineageOffset?: number;
  limit?: number;
  expectedBinding?: {threadId: string; generation: number};
};

export const loadWorkflowProgress = async (
  projectId: string,
  mainThreadId: string,
  signal: AbortSignal,
  page: WorkflowProgressPageRequest = {},
): Promise<WorkflowProgressSnapshot> => {
  const query = new URLSearchParams({projectId, mainThreadId});
  if (page.workflowOffset !== undefined) query.set("workflowOffset", String(page.workflowOffset));
  if (page.lineageOffset !== undefined) query.set("lineageOffset", String(page.lineageOffset));
  if (page.limit !== undefined) query.set("limit", String(page.limit));
  const response = await fetch(`/api/guidance/workflow-progress?${query}`, {
    credentials: "omit",
    headers: sessionHeaders(),
    signal,
  });
  if (!response.ok) throw new Error("Live workflow progress could not be loaded.");
  const value = Schema.decodeUnknownSync(WorkflowProgressSnapshotSchema)(await response.json());
  if (signal.aborted || value.projectId !== projectId || value.mainThreadId !== mainThreadId ||
    value.workflowOffset !== (page.workflowOffset ?? 0) || value.lineageOffset !== (page.lineageOffset ?? 0))
    throw new Error("The live workflow progress response belongs to another selection or page.");
  if (page.expectedBinding && value.scope && (value.scope.supervisorThreadId !== page.expectedBinding.threadId ||
    value.scope.bindingGeneration !== page.expectedBinding.generation))
    throw new Error("The live workflow progress response belongs to another Supervisor binding.");
  if (value.coverage) {
    const scopeThreadIds = new Set(value.scope?.threads.map(thread => thread.threadId) ?? []);
    if (value.coverage.some(item => !scopeThreadIds.has(item.threadId)) ||
      new Set(value.coverage.map(item => item.threadId)).size !== value.coverage.length)
      throw new Error("The live workflow coverage response does not match its native scope page.");
  }
  return value;
};

export const refreshWorkflowProgressPages = async (
  projectId: string,
  mainThreadId: string,
  signal: AbortSignal,
  pages: readonly WorkflowProgressPageRequest[],
): Promise<WorkflowProgressSnapshot[]> => {
  const requests = pages.length > 0 ? pages : [{workflowOffset: 0, lineageOffset: 0}];
  const refreshed: WorkflowProgressSnapshot[] = [];
  for (const page of requests) {
    const result = await loadWorkflowProgress(projectId, mainThreadId, signal, page);
    refreshed.push(result);
    if (result.status !== "ok") break;
  }
  return refreshed;
};

const postProjectSupervisor = async (path: string, input: ProjectSupervisorSaveInput | ProjectSupervisorRetryInput | ProjectSupervisorChatSupervisionInput, csrfToken: string) => {
  const response = await fetch(path, {
    method: "POST",
    credentials: "omit",
    headers: {"Content-Type": "application/json", ...sessionHeaders(), "x-csrf-token": getCsrfToken() || csrfToken},
    body: JSON.stringify(input),
  });
  if (response.status === 401 || response.status === 403) {
    const refreshed = await loadAccess().catch(() => false);
    throw new ProjectSupervisorRequestError(
      refreshed ? "Session refreshed. Your Supervisor change was not performed; review the state and try again." : "Your Supervisor change was not performed. Session refresh failed; reconnect and try again.",
      true,
    );
  }
  if (response.status === 413 || response.status === 415) {
    throw new ProjectSupervisorRequestError(
      response.status === 413 ? "Your Supervisor change was not performed because the request is too large." : "Your Supervisor change was not performed because the server rejected the request format.",
      true,
    );
  }
  if (!response.ok) throw new ProjectSupervisorRequestError("The operation outcome could not be confirmed. Refresh Supervisor settings before trying again.", false);

  let result;
  try {
    result = Schema.decodeUnknownSync(ProjectSupervisorSaveResult)(await response.json());
  } catch {
    throw new ProjectSupervisorRequestError("The operation outcome could not be confirmed. Refresh Supervisor settings before trying again.", false);
  }
  if (result.snapshot && (result.snapshot.projectId !== input.projectId || result.snapshot.mainThreadId !== (input.mainThreadId ?? null))) {
    throw new ProjectSupervisorRequestError("The response belongs to another project. Refresh Supervisor settings before trying again.", false);
  }
  return result;
};

export const saveProjectSupervisor = (input: ProjectSupervisorSaveInput, csrfToken: string) =>
  postProjectSupervisor("/api/guidance/project-supervisor", input, csrfToken);

export const retryProjectSupervisor = (input: ProjectSupervisorRetryInput, csrfToken: string) =>
  postProjectSupervisor("/api/guidance/project-supervisor/retry", input, csrfToken);

/** The dashboard's per-chat Stop supervision / Enable supervision control, backed by the instance thread policy. */
export const setChatSupervision = (input: ProjectSupervisorChatSupervisionInput, csrfToken: string) =>
  postProjectSupervisor("/api/guidance/project-supervisor/chat-supervision", input, csrfToken);
