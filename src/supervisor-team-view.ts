import type {ProjectSupervisorTeamInfo} from "./project-supervisor-contract.js";
import type {BindingRecord} from "./project-supervisor-store.js";
import type {SupervisorTeamStore} from "./supervisor-team-store.js";
import type {ThreadInfo} from "./types.js";
import type {SupervisorConversationStore} from "./supervisor-conversation-store.js";

/** Presents existing team records without waking or polling every helper conversation. */
export const supervisorTeamView = (team: SupervisorTeamStore, binding: BindingRecord, threads: readonly ThreadInfo[],
  requests: SupervisorConversationStore, now = Date.now()): ProjectSupervisorTeamInfo => {
  const snapshot = team.snapshot(binding);
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const issues = snapshot.events.filter(event => event.acknowledgedAt === null && event.severity === "attention").slice(-100)
    .map(event => ({id: event.id, severity: "warning" as const, summary: event.summary, observedAt: event.createdAt}));
  return {status: "ok", message: "Assignments are monitoring responsibility; operational child workflows remain connected to their parent.", observedAt: now,
    root: {threadId: binding.threadId, title: binding.title, model: snapshot.root.modelSelection.model,
      readiness: binding.state === "ready" ? "ready" : "pending",
      lifecycle: requests.pending(binding.projectId, binding.threadId) ? "active" : "idle", currentState: "Coordinates the main workflow, policy and unassigned work.", lastAssessment: null},
    members: snapshot.members.slice(0, 100).map(member => {
      const thread = byId.get(member.threadId);
      const pending = requests.pending(binding.projectId, member.threadId);
      const latest = requests.requests(binding.projectId, member.threadId).at(-1);
      const assessment = snapshot.events.filter(event => event.memberThreadId === member.threadId && event.kind === "assessment").at(-1);
      return {threadId: member.threadId, title: member.title ?? thread?.title ?? null,
        model: member.modelSelection?.model ?? (thread?.modelSelection as {model?: string} | undefined)?.model ?? snapshot.root.modelSelection.model,
        readiness: member.state === "ready" ? "ready" : member.state === "registering" ? "pending" : "unavailable",
        lifecycle: member.state === "quarantined" ? "quarantined" : member.state === "retired" ? "retired" : member.state === "missing" || latest?.state === "failed" ? "failed" : pending ? "active" : "idle",
        currentState: member.state === "quarantined" ? "Quarantined: the root owns its former operational coverage; unresolved writes and notices remain fenced, and the native conversation may still exist or run." :
          member.state === "registering" ? "Awaiting the native readiness handshake; the root retains responsibility." :
          pending?.state === "uncertain" ? "Check-in delivery is uncertain; its original identity is retained." :
            pending ? "A bounded monitoring turn is in progress." : "Available for the next check-in or reassignment.",
        lastAssessment: member.lastAssessment ? {summary: member.lastAssessment, assessedAt: assessment?.createdAt ?? null} : null,
        assignments: snapshot.assignments.filter(value => value.memberThreadId === member.threadId || value.toMemberThreadId === member.threadId || value.fromMemberThreadId === member.threadId)
          .map(value => ({threadId: value.subtreeRootThreadId, title: byId.get(value.subtreeRootThreadId)?.title ?? null,
            state: value.state === "transferring" ? "transfer" : value.memberThreadId === member.threadId ? "active" : "released"})),
        pendingHandovers: snapshot.notifications.flatMap(value => {
          if (value.recipientThreadId !== member.threadId || value.state === "acknowledged" || value.assignmentRootThreadId === null) return [];
          return [{targetThreadId: value.assignmentRootThreadId, targetTitle: byId.get(value.assignmentRootThreadId)?.title ?? null,
            direction: value.kind === "handover_receive" ? "incoming" as const : "outgoing" as const, state: value.state,
            summary: value.message, updatedAt: value.updatedAt}];
        }).slice(-100),
        issues: issues.filter(issue => snapshot.events.find(event => event.id === issue.id)?.memberThreadId === member.threadId),
      };
    }), issues};
};
