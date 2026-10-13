import { Schema } from "effect";
import { ProjectDefinitions, ProjectRuleSaveResult, type ProjectDefinitionSnapshot, type ProjectRuleSave } from "../../src/project-definitions-contract.js";
import { getCsrfToken, loadAccess } from "./access.js";

export class ProjectRuleRequestError extends Error {
  constructor(message: string, readonly definitelyNotSaved: boolean) {super(message);}
}

export const loadProjectDefinitions = async (projectId: string, threadId: string | null, signal: AbortSignal): Promise<ProjectDefinitionSnapshot> => {
  const query = new URLSearchParams({projectId});
  if (threadId !== null) query.set("threadId", threadId);
  const response = await fetch(`/api/guidance/project-definitions?${query}`, {credentials: "same-origin", signal});
  if (!response.ok) throw new Error("Project definitions could not be loaded.");
  const value = Schema.decodeUnknownSync(ProjectDefinitions)(await response.json());
  if (signal.aborted || value.projectId !== projectId || value.threadId !== threadId) throw new Error("The definition response belongs to another selection.");
  return value;
};

export const saveProjectRules = async (input: ProjectRuleSave, csrfToken: string) => {
  const response = await fetch("/api/guidance/project-rules", {method: "POST", credentials: "same-origin", headers: {"Content-Type": "application/json", "x-csrf-token": getCsrfToken() || csrfToken}, body: JSON.stringify(input)});
  if (response.status === 403) {
    const refreshed = await loadAccess().catch(() => false);
    throw new ProjectRuleRequestError(refreshed ? "Session refreshed. Your draft was not saved; review it and save again." : "Your draft was not saved. Session refresh failed; reconnect and save again.", true);
  }
  if (response.status === 413 || response.status === 415)
    throw new ProjectRuleRequestError(response.status === 413 ? "Your draft was not saved. The request is too large; shorten the rules before saving again." : "Your draft was not saved. The server rejected the request format.", true);
  if (!response.ok) throw new ProjectRuleRequestError("The save outcome could not be confirmed. Refresh and inspect rules.yaml before retrying.", false);
  const result = Schema.decodeUnknownSync(ProjectRuleSaveResult)(await response.json());
  if (result.definitions && (result.definitions.projectId !== input.projectId || result.definitions.threadId !== input.threadId))
    throw new Error("The save response belongs to another workspace. Refresh and inspect rules.yaml before retrying.");
  return result;
};
