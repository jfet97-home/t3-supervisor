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
  const guideCountsByMember = new Map<string, number>();
  const uncertainGuidanceMembers = new Set<string>();
  const guideRequests = team.unresolvedRequests(binding).filter(request => request.requestId.startsWith("guide:"));
  const guideRequestIds = new Set(guideRequests.map(request => request.requestId));
  for (const request of guideRequests) {
    guideCountsByMember.set(request.memberThreadId, (guideCountsByMember.get(request.memberThreadId) ?? 0) + 1);
    if (request.state === "uncertain") uncertainGuidanceMembers.add(request.memberThreadId);
  }
  const deferredGuidanceMembers = new Set<string>();
  if (guideRequestIds.size > 0) {
    const rows = team.supervisors.store.db.prepare(`SELECT actor_thread_id,json_extract(document,'$.requestId') AS request_id
      FROM supervisor_team_tool_receipts WHERE owner_thread_id=? AND binding_generation=?
      AND json_extract(document,'$.status')='needs_fallback' AND json_extract(document,'$.reason')='target_pending_owner_input'`)
      .all(binding.threadId, binding.generation);
    for (const row of rows) {
      if (typeof row.request_id === "string" && guideRequestIds.has(row.request_id)) deferredGuidanceMembers.add(String(row.actor_thread_id));
    }
  }
  const unresolvedNotices = snapshot.notifications.filter(value => value.assignmentRootThreadId !== null && ["pending", "sending", "uncertain", "delivered"].includes(value.state));
  const unconfirmedNotices = new Set(unresolvedNotices.map(value => value.recipientThreadId));
  const interruptedNotices = new Set(unresolvedNotices.filter(value => value.observedRun).map(value => value.recipientThreadId));
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
          uncertainGuidanceMembers.has(member.threadId) ? "An operational-child guidance delivery is uncertain; its original target and native command remain pending reconciliation." :
            deferredGuidanceMembers.has(member.threadId) ? "Guidance is deferred for an owner decision on its original target; no answer or alternate route has been sent." :
            (guideCountsByMember.get(member.threadId) ?? 0) > 0 ? "An operational-child steer is still awaiting native-history confirmation on its original target; no alternate route has been sent." :
          pending?.state === "uncertain" ? "Check-in delivery is uncertain; its original identity is retained." :
            pending ? "A bounded monitoring turn is in progress." :
            interruptedNotices.has(member.threadId) ? "A delivered handover notice ended before confirming; the root keeps responsibility and nothing was resent." :
            unconfirmedNotices.has(member.threadId) ? "A handover notice is awaiting confirmation; the root keeps responsibility until it is confirmed." :
            "Available for the next check-in or reassignment.",
        lastAssessment: member.lastAssessment ? {summary: member.lastAssessment, assessedAt: assessment?.createdAt ?? null} : null,
        assignments: snapshot.assignments.filter(value => value.memberThreadId === member.threadId || value.toMemberThreadId === member.threadId || value.fromMemberThreadId === member.threadId)
          .map(value => ({threadId: value.subtreeRootThreadId, title: byId.get(value.subtreeRootThreadId)?.title ?? null,
            state: value.state === "transferring" ? "transfer" : value.memberThreadId === member.threadId ? "active" : "released"})),
        pendingHandovers: snapshot.notifications.flatMap(value => {
          if (value.recipientThreadId !== member.threadId || value.state === "acknowledged" || value.assignmentRootThreadId === null) return [];
          return [{targetThreadId: value.assignmentRootThreadId, targetTitle: byId.get(value.assignmentRootThreadId)?.title ?? null,
            direction: value.kind === "handover_receive" ? "incoming" as const : "outgoing" as const, state: value.state,
            summary: value.message, updatedAt: value.updatedAt, ...(value.observedRun ? {runStatus: value.observedRun.status} : {})}];
        }).slice(-100),
        issues: issues.filter(issue => snapshot.events.find(event => event.id === issue.id)?.memberThreadId === member.threadId),
      };
    }), issues};
};
