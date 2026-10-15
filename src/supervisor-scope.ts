import type { ThreadInfo } from "./types.js";

export const SUPERVISOR_SCOPE_MAX_THREADS = 10_000;
export const SUPERVISOR_SCOPE_MAX_DEPTH = 100;

export interface SupervisorScopeIssue {
  code: "main_missing" | "main_mismatch" | "main_unavailable" | "main_owned" | "duplicate_thread_id" | "scope_limit" | "lineage_incomplete";
  message: string;
}

export interface SupervisorScopeResolution {
  main: ThreadInfo | null;
  byId: Map<string, ThreadInfo>;
  descendants: ThreadInfo[];
  allowedIds: Set<string>;
  liveIds: Set<string>;
  depthById: Map<string, number>;
  complete: boolean;
  issues: SupervisorScopeIssue[];
}

/** Follows child ownership only; forks remain independent operational scopes. */
export const mainConversation = (thread: ThreadInfo, threads: readonly ThreadInfo[]): ThreadInfo | null => {
  let current = thread;
  const byId = new Map(threads.map(candidate => [candidate.id, candidate]));
  const seen = new Set<string>();
  while (current.lineage.relationshipToParent === "subagent") {
    if (seen.has(current.id) || seen.size >= SUPERVISOR_SCOPE_MAX_DEPTH || !current.lineage.parentThreadId) return null;
    seen.add(current.id);
    const parent = byId.get(current.lineage.parentThreadId);
    if (!parent) return null;
    current = parent;
  }
  return current;
};

const issue = (code: SupervisorScopeIssue["code"], message: string): SupervisorScopeIssue => ({code, message});
const archived = (thread: ThreadInfo): boolean => thread.archivedAt != null || thread.deletedAt != null;

/** Resolves one main and its verified subagent descendants from a native thread catalog. */
export const resolveSupervisorScope = (
  threads: readonly ThreadInfo[],
  projectId: string,
  mainThreadId: string,
  ownedThreadIds: ReadonlySet<string> = new Set(),
): SupervisorScopeResolution => {
  const issues: SupervisorScopeIssue[] = [];
  const byId = new Map<string, ThreadInfo>();
  const duplicateIds = new Set<string>();
  let complete = true;
  if (threads.length > SUPERVISOR_SCOPE_MAX_THREADS) {
    complete = false;
    issues.push(issue("scope_limit", "The native thread catalog exceeds the bounded supervision scope."));
  }
  for (const thread of threads.slice(0, SUPERVISOR_SCOPE_MAX_THREADS)) {
    if (!thread.id) continue;
    if (byId.has(thread.id)) {
      complete = false;
      duplicateIds.add(thread.id);
      issues.push(issue("duplicate_thread_id", "The native thread catalog contains duplicate identities."));
      continue;
    }
    byId.set(thread.id, thread);
  }

  const main = byId.get(mainThreadId) ?? null;
  const allowedIds = new Set<string>();
  const liveIds = new Set<string>();
  const depthById = new Map<string, number>();
  if (!main) {
    complete = false;
    issues.push(issue("main_missing", "The bound main conversation is absent from the native thread catalog."));
    return {main: null, byId, descendants: [], allowedIds, liveIds, depthById, complete, issues};
  }
  let rootValid = true;
  if (duplicateIds.has(main.id) || main.projectId !== projectId || main.lineage.relationshipToParent === "subagent") {
    rootValid = false;
    complete = false;
    issues.push(issue("main_mismatch", "The bound main does not match the project or is itself a descendant."));
  } else if (ownedThreadIds.has(main.id)) {
    rootValid = false;
    complete = false;
    issues.push(issue("main_owned", "A Supervisor-owned conversation cannot own an operative scope."));
  }
  if (rootValid) {
    allowedIds.add(main.id);
    if (!archived(main)) liveIds.add(main.id);
    depthById.set(main.id, 0);
  }

  const descendants: Array<{thread: ThreadInfo; depth: number}> = [];
  if (rootValid) {
    for (const candidate of byId.values()) {
      if (candidate.id === main.id || candidate.lineage.relationshipToParent !== "subagent" || ownedThreadIds.has(candidate.id) || duplicateIds.has(candidate.id)) continue;
      let current = candidate;
      const seen = new Set<string>();
      const path: ThreadInfo[] = [];
      let invalid = false;
      let ownedAncestry = false;
      let independentFork = false;
      while (current.id !== main.id) {
        if (ownedThreadIds.has(current.id)) {ownedAncestry = true;break;}
        if (current.lineage.relationshipToParent === "fork") {independentFork = true;break;}
        if (seen.has(current.id) || seen.size >= SUPERVISOR_SCOPE_MAX_DEPTH || current.lineage.relationshipToParent !== "subagent" ||
          !current.lineage.parentThreadId) {invalid = true;break;}
        seen.add(current.id);
        path.push(current);
        if (duplicateIds.has(current.lineage.parentThreadId)) {invalid = true;break;}
        const parent = byId.get(current.lineage.parentThreadId);
        if (!parent) {invalid = true;break;}
        current = parent;
      }
      if (ownedAncestry) continue;
      if (independentFork) continue;
      if (invalid) {
        if (candidate.lineage.rootThreadId === main.id) {
          complete = false;
          issues.push(issue("lineage_incomplete", "A thread names this main as its lineage root but lacks a verifiable subagent path."));
        }
        continue;
      }
      for (const member of path) {
        const depth = seen.size - path.indexOf(member);
        if (!depthById.has(member.id)) {
          descendants.push({thread: member, depth});
          allowedIds.add(member.id);
          if (!archived(member)) liveIds.add(member.id);
          depthById.set(member.id, depth);
        }
      }
    }
  }
  descendants.sort((left, right) => left.depth - right.depth || left.thread.id.localeCompare(right.thread.id));
  return {main, byId, descendants: descendants.map(item => item.thread), allowedIds, liveIds, depthById, complete, issues};
};

export const supervisorScopeKey = (projectId: string, mainThreadId: string): string => JSON.stringify([projectId, mainThreadId]);
