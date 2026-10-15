import { Schema } from "effect";
import { ProjectConfigSaveResult, ProjectDefinitions, type ProjectConfigSave, type ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { getCsrfToken, loadAccess, sessionHeaders } from "./access.js";

export class ProjectConfigRequestError extends Error {
  constructor(message: string, readonly definitelyNotSaved: boolean) {super(message);}
}

export const loadProjectDefinitions = async (projectId: string, threadId: string | null, signal: AbortSignal): Promise<ProjectDefinitionSnapshot> => {
  const query = new URLSearchParams({projectId});
  if (threadId !== null) query.set("threadId", threadId);
  const response = await fetch(`/api/guidance/project-configuration?${query}`, {credentials: "omit", headers: sessionHeaders(), signal});
  if (!response.ok) throw new Error("Project definitions could not be loaded.");
  const value = Schema.decodeUnknownSync(ProjectDefinitions)(await response.json());
  if (signal.aborted || value.projectId !== projectId || value.threadId !== threadId) throw new Error("The definition response belongs to another selection.");
  return value;
};

export const saveProjectConfiguration = async (input: ProjectConfigSave, csrfToken: string) => {
  const response = await fetch("/api/guidance/project-configuration", {method: "POST", credentials: "omit", headers: {"Content-Type": "application/json", ...sessionHeaders(), "x-csrf-token": getCsrfToken() || csrfToken}, body: JSON.stringify(input)});
  if (response.status === 401 || response.status === 403) {
    const refreshed = await loadAccess().catch(() => false);
    throw new ProjectConfigRequestError(refreshed ? "Session refreshed. Your draft was not saved; review it and save again." : "Your draft was not saved. Session refresh failed; reconnect and save again.", true);
  }
  if (response.status === 413 || response.status === 415)
    throw new ProjectConfigRequestError(response.status === 413 ? "Your draft was not saved. The request is too large; shorten the project configuration before saving again." : "Your draft was not saved. The server rejected the request format.", true);
  if (!response.ok) throw new ProjectConfigRequestError("The save outcome could not be confirmed. Refresh and inspect project.yaml before retrying.", false);
  const result = Schema.decodeUnknownSync(ProjectConfigSaveResult)(await response.json());
  if (result.definitions && (result.definitions.projectId !== input.projectId || result.definitions.threadId !== input.threadId))
    throw new ProjectConfigRequestError("The save response belongs to another workspace. Refresh and inspect project.yaml before retrying.", false);
  return result;
};
