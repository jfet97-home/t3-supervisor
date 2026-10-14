import type { ThreadInfo } from "./types.js";

/** Follows child ownership only; forks remain independent operational scopes. */
export const mainConversation = (thread: ThreadInfo, threads: readonly ThreadInfo[]): ThreadInfo | null => {
  let current = thread;
  const seen = new Set<string>();
  while (current.lineage.relationshipToParent === "subagent") {
    if (seen.has(current.id) || seen.size >= 64 || !current.lineage.parentThreadId) return null;
    seen.add(current.id);
    const parent = threads.find(candidate => candidate.id === current.lineage.parentThreadId);
    if (!parent || parent.projectId !== thread.projectId) return null;
    current = parent;
  }
  return current;
};
export const supervisorScopeKey = (projectId: string, mainThreadId: string): string => JSON.stringify([projectId, mainThreadId]);
