import { Schema } from "effect";
import {
  ProjectSupervisorSnapshot,
  ProjectSupervisorSaveResult,
  type ProjectSupervisorInfo,
  type ProjectSupervisorRetryInput,
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
  return value;
};

const postProjectSupervisor = async (path: string, input: ProjectSupervisorSaveInput | ProjectSupervisorRetryInput, csrfToken: string) => {
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
