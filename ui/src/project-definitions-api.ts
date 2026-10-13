import { Schema } from "effect";
import { ProjectDefinitions, type ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";

export const loadProjectDefinitions = async (projectId: string, threadId: string | null, signal: AbortSignal): Promise<ProjectDefinitionSnapshot> => {
  const query = new URLSearchParams({projectId});
  if (threadId !== null) query.set("threadId", threadId);
  const response = await fetch(`/api/guidance/project-definitions?${query}`, {credentials: "same-origin", signal});
  if (!response.ok) throw new Error("Project definitions could not be loaded.");
  const value = Schema.decodeUnknownSync(ProjectDefinitions)(await response.json());
  if (signal.aborted || value.projectId !== projectId || value.threadId !== threadId) throw new Error("The definition response belongs to another selection.");
  return value;
};
