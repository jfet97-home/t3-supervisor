import { Icon } from "./icons.js";
import { EntityDetails, HelpDisclosure } from "./disclosure.js";
import { ConversationStatus, ConversationUnderstanding } from "./conversation-status.js";
import {alignmentLabel, PlanChanges, PlanJourney, planSteps, StepContributions, TaskAlignment, TaskOutcome} from "./workflow-journey.js";
import {acceptedAgreement, journeyRecord, pendingProposal, planChanges, recordsByStep, stepNotes} from "./task-record.js";
import {StopNotice} from "./stop-notice.js";
import { assessmentForTask } from "../../src/workflow-assessment.js";
import { planStatusAttention, protocolDiagnosticAttention, staleAgreementAttention, workAttention } from "../../src/dashboard-overview.js";
import React, { useContext, useEffect, useState, type FormEvent } from "react";
import { Cause, Clock, Effect, Exit, Option, Result } from "effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { RegistryContext, useAtom, useAtomMount, useAtomValue } from "@effect/atom-react";
import type {
  ProjectSupervisorChatSupervisionInput,
  ProjectSupervisorInfo,
  ProjectSupervisorRetryInput,
  ProjectSupervisorSaveInput,
  ProjectSupervisorSaveOutcome,
  TaskInterpretationInfo,
  ProjectSupervisorTeamInfo,
  DefinitionReviewInfo,
  SupervisorModelInfo,
  SupervisorModelSelection,
  SupervisorMonitoringReview,
  SupervisorMonitoringSettings,
  SupervisorTeamSettingsInfo,
  WorkflowProtocolDiagnostic,
} from "../../src/project-supervisor-contract.js";
import type { WorkflowProgressContribution, WorkflowProgressCoverage, WorkflowProgressSnapshot, WorkflowProgressWorkflow } from "../../src/workflow-progress.js";
import { defaultMonitoringSettings, defaultSupervisorTeamSettings, monitoringIntervalMinutes } from "../../src/project-supervisor-contract.js";
import { loadProjectSupervisor, loadWorkflowProgress, type ProjectSupervisorRequestError, refreshWorkflowProgressPages, retryProjectSupervisor, saveProjectSupervisor, setChatSupervision } from "./project-supervisor-api.js";
import { admit, admittedMutation, authEpochAtom, draftFamily, environmentAtom, refreshOnDashboardChange, scopeKey, uiRuntime, type MutationKey, type MutationResult } from "./atoms.js";
import { idleControlActivity, SupervisionControlPanel, supervisionControlKey, supervisionSetupSelection } from "./supervisor-control.js";

type MonitoringDraft = {
  intervalMinutes: string;
  activityThreshold: string;
};
type TeamSettingsDraft = {maxHelpersPerRoot: string};

export type Draft = {
  projectId: string;
  modelValue: SupervisorModelSelection;
  modelBaseline: SupervisorModelSelection;
  monitoringValue: MonitoringDraft;
  monitoringBaseline: MonitoringDraft;
  teamSettingsValue: TeamSettingsDraft;
  teamSettingsBaseline: TeamSettingsDraft;
  agentThreadsValue: boolean;
  agentThreadsBaseline: boolean;
  expectedGeneration: number;
};
export type WorkflowProgressPanelState = {key: string; pages: WorkflowProgressSnapshot[]; loading: boolean; error: string | null};

const selectionKey = (selection: SupervisorModelSelection) => JSON.stringify(selection);
const copySelection = (selection: SupervisorModelSelection): SupervisorModelSelection => ({
  instanceId: selection.instanceId,
  model: selection.model,
  options: selection.options.map(option => ({...option})),
});
const copyMonitoringDraft = (monitoring: MonitoringDraft): MonitoringDraft => ({...monitoring});
const copyTeamSettingsDraft = (settings: TeamSettingsDraft): TeamSettingsDraft => ({...settings});
const monitoringDraft = (monitoring: SupervisorMonitoringSettings): MonitoringDraft => ({
  intervalMinutes: String(monitoring.intervalMinutes),
  activityThreshold: String(monitoring.activityThreshold),
});
const copyMonitoringSettings = (monitoring: SupervisorMonitoringSettings): SupervisorMonitoringSettings => ({...monitoring});
const sameMonitoring = (left: MonitoringDraft, right: MonitoringDraft) =>
  left.intervalMinutes === right.intervalMinutes && left.activityThreshold === right.activityThreshold;
const sameTeamSettings = (left: TeamSettingsDraft, right: TeamSettingsDraft) => left.maxHelpersPerRoot === right.maxHelpersPerRoot;
const readMonitoring = (snapshot: ProjectSupervisorInfo) => copyMonitoringSettings(snapshot.settings.monitoring ?? defaultMonitoringSettings);
const readMonitoringDraft = (snapshot: ProjectSupervisorInfo) => monitoringDraft(readMonitoring(snapshot));
const readTeamSettings = (snapshot: ProjectSupervisorInfo): SupervisorTeamSettingsInfo => ({...(snapshot.settings.teamSettings ?? defaultSupervisorTeamSettings)});
const teamSettingsDraft = (settings: SupervisorTeamSettingsInfo): TeamSettingsDraft => ({maxHelpersPerRoot: String(settings.maxHelpersPerRoot)});
const readTeamSettingsDraft = (snapshot: ProjectSupervisorInfo) => teamSettingsDraft(readTeamSettings(snapshot));
const readAgentThreads = (snapshot: ProjectSupervisorInfo) => snapshot.settings.superviseAgentCreatedThreads === true;
const formatMonitoringTime = (value: number | null) => value === null ? "Not scheduled" : new Date(value).toLocaleString();
const reviewOutcomeLabels = {progress_updated: "Progress updated", no_change: "No change", needs_attention: "Needs attention",
  insufficient_evidence: "Insufficient evidence"} as const;
const reviewStateLabels = {recorded: "recorded, awaiting confirmation", unconfirmed: "not confirmed", missing: "no outcome recorded"} as const;
// the last confirmed check-in outcome and the current one that is not confirmed; an outcome is the Supervisor's assessment, not
// evidence that the operative acted on it
const ReviewOutcomes = ({review}: {readonly review: SupervisorMonitoringReview}) => <div className="stack">
  <p><strong>Last confirmed review:</strong> {review.lastConfirmed
    ? `${reviewOutcomeLabels[review.lastConfirmed.outcome]} (${formatMonitoringTime(review.lastConfirmed.at)})${review.lastConfirmed.reason ? `: ${review.lastConfirmed.reason}` : ""}`
    : "None yet"}</p>
  {review.current && <p><strong>Current review:</strong> {review.current.outcome ? reviewOutcomeLabels[review.current.outcome] : "No outcome"}, {reviewStateLabels[review.current.state]}
    {review.current.reason ? `: ${review.current.reason}` : ""}{review.current.problem && review.current.state !== "recorded" ? ` (${review.current.problem})` : ""}</p>}
</div>;
const monitoringError = (value: string, minimum: number, maximum: number, field: string) => {
  if (!value.trim()) return `Enter ${field} from ${minimum} to ${maximum}.`;
  const number = Number(value);
  if (!Number.isInteger(number)) return `Enter a whole number for ${field}.`;
  if (number < minimum || number > maximum) return `Enter ${field} from ${minimum} to ${maximum}.`;
  return "";
};
const parseMonitoringDraft = (value: MonitoringDraft): SupervisorMonitoringSettings | null => {
  if (monitoringError(value.intervalMinutes, monitoringIntervalMinutes.min, monitoringIntervalMinutes.max, "maximum pending activity age in minutes") ||
    monitoringError(value.activityThreshold, 3, 100, "finalized activity threshold")) return null;
  return {intervalMinutes: Number(value.intervalMinutes), activityThreshold: Number(value.activityThreshold)};
};
const parseTeamSettingsDraft = (value: TeamSettingsDraft): SupervisorTeamSettingsInfo | null => {
  if (monitoringError(value.maxHelpersPerRoot, 0, 20, "maximum helpers per root")) return null;
  return {maxHelpersPerRoot: Number(value.maxHelpersPerRoot)};
};
const modelKey = (model: Pick<SupervisorModelInfo, "instanceId" | "model">) => JSON.stringify([model.instanceId, model.model]);
const selectedModelKey = (selection: SupervisorModelSelection) => JSON.stringify([selection.instanceId, selection.model]);
const encodeChoice = (value: string | boolean) => JSON.stringify(value);

const isReasoningOption = (option: SupervisorModelInfo["options"][number]) => {
  const id = option.id.toLowerCase().replace(/[^a-z]/g, "");
  const label = option.label.toLowerCase();
  return id === "reasoningeffort" || id === "effort" || id === "thinking" || label.includes("reasoning") || label.includes("thinking");
};

const findModel = (snapshot: ProjectSupervisorInfo, selection: SupervisorModelSelection) =>
  snapshot.models.find(model => model.instanceId === selection.instanceId && model.model === selection.model);

const formatModel = (snapshot: ProjectSupervisorInfo, selection: SupervisorModelSelection | null) => {
  if (!selection) return "Not reported by T3 yet";
  const model = findModel(snapshot, selection);
  return model
    ? `${model.providerName} · ${model.name} (${model.model})${model.available ? "" : " — unavailable"}`
    : `${selection.instanceId} · ${selection.model} — unavailable`;
};

const parseChoice = (value: string): string | boolean => {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "string" && typeof parsed !== "boolean") throw new Error("Invalid advertised model option.");
  return parsed;
};

const parseModelKey = (value: string): {instanceId: string; model: string} => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") throw new Error("Invalid advertised model.");
  return {instanceId: parsed[0], model: parsed[1]};
};

const withModelDefaults = (model: SupervisorModelInfo): SupervisorModelSelection => ({
  instanceId: model.instanceId,
  model: model.model,
  options: model.options.map(option => ({id: option.id, value: option.defaultValue})),
});

const withReasoningValue = (selection: SupervisorModelSelection, model: SupervisorModelInfo, optionId: string, value: string | boolean) => ({
  ...selection,
  options: model.options.flatMap(option => {
    if (option.id === optionId) return [{id: option.id, value}];
    const existing = selection.options.find(candidate => candidate.id === option.id && option.choices.some(choice => choice.value === candidate.value));
    return existing ? [{...existing}] : [];
  }),
});

/**
 * Runs one per-chat supervision change and returns the server-confirmed state to show. It returns null once the selected
 * project or chat has changed, so a late response never replaces another chat's view; the next load shows that chat's state.
 */
export const confirmChatSupervisionChange = <R1, R2>(
  change: Effect.Effect<{snapshot?: ProjectSupervisorInfo | null; message: string}, unknown, R1>,
  reload: Effect.Effect<ProjectSupervisorInfo, unknown, R2>,
  isCurrent: () => boolean,
): Effect.Effect<{snapshot: ProjectSupervisorInfo | null; message: string} | null, never, R1 | R2> => Effect.gen(function* () {
  const result = yield* change;
  if (!isCurrent()) return null;
  const confirmed = result.snapshot ?? (yield* reload);
  return isCurrent() ? {snapshot: confirmed, message: result.message} : null;
}).pipe(Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.gen(function* () {
  if (!isCurrent()) return null;
  const saved = yield* Effect.exit(reload);
  if (Exit.isSuccess(saved)) return isCurrent() ? {snapshot: saved.value, message: "The change could not be confirmed. The saved state is shown."} : null;
  return isCurrent() ? {snapshot: null, message: "The change could not be confirmed and the saved state could not be read. Refresh Supervisor status."} : null;
})));

export const shouldOfferNativeRetry = (snapshot: ProjectSupervisorInfo) => {
  const monitoringNeedsRetry = (snapshot.monitoringStatus?.state === "uncertain" || snapshot.monitoringStatus?.state === "unavailable") &&
    snapshot.monitoringStatus.retryable !== false;
  return monitoringNeedsRetry || snapshot.binding?.settlementState === "uncertain" ||
    snapshot.binding?.state === "uncertain" ||
    snapshot.binding?.state === "rejected" ||
    snapshot.binding?.state === "missing" ||
    snapshot.tasks.some(task => task.status === "uncertain") ||
    Boolean(snapshot.modelApplication?.pending) && snapshot.binding?.state === "ready";
}

const formatWorkflowAgreementTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};

const definitionReviewMessages: Record<DefinitionReviewInfo["status"], string> = {
  checking: "Project definitions changed; Supervisor is checking user authorization.",
  revert_requested: "Unrequested changes: revert requested.",
  authorized: "User-authorized definitions adopted.",
  restored: "Approved definitions restored; renegotiation needed.",
};

function DefinitionReviewView({review}: {review: DefinitionReviewInfo}) {
  const outcome = review.status === "authorized" || review.status === "restored";
  const updatedAt = formatWorkflowAgreementTime(review.updatedAt);

  return <section className="stack" aria-labelledby="workflow-definition-review-title">
    <h5 id="workflow-definition-review-title">Project definition review</h5>
    <p><strong>Status:</strong> {definitionReviewMessages[review.status]}</p>
    {review.message && <p>{review.message}</p>}
    {outcome && <EntityDetails title={<>Definition review details</>} >
      
      <p><strong>Expected revision:</strong> <code>{review.expectedRevision}</code></p>
      <p><strong>Observed revision:</strong> {review.observedRevision === null ? "Not recorded" : <code>{review.observedRevision}</code>}</p>
      <p><strong>Supervisor message ID:</strong> {review.supervisorMessageId === null ? "Not recorded" : <code>{review.supervisorMessageId}</code>}</p>
      <div className="stack">
        <strong>User message IDs</strong>
        {review.userMessageIds.length > 0
          ? <ol className="stack">{review.userMessageIds.map(messageId => <li key={messageId}><code>{messageId}</code></li>)}</ol>
          : <p className="muted">No user message IDs were recorded.</p>}
      </div>
      <p><strong>Updated:</strong> {updatedAt
        ? <time dateTime={updatedAt.toISOString()}>{updatedAt.toLocaleString()}</time>
        : "Unknown"}</p>
    </EntityDetails>}
  </section>;
}
function WorkflowProtocolDiagnosticView({diagnostic}: {diagnostic: WorkflowProtocolDiagnostic | null | undefined}) {
  if (!diagnostic) return null;
  const isSupervisor = diagnostic.role === "supervisor";
  const notFormal = diagnostic.code === "plan_not_formal";
  if (diagnostic.code.startsWith("contribution_")) return <section className="notice stack" aria-labelledby="workflow-protocol-diagnostic-title">
    <h5 id="workflow-protocol-diagnostic-title">External contribution record needs follow-up</h5>
    <p>The main assistant’s latest external-contribution record was not recorded. It needs a complete record with the next revision for an existing step of the current main workflow.</p>
    <p className="muted">This diagnostic is informational. It does not change any recorded contribution, assessment or step status.</p>
    <p className="small muted"><strong>Record:</strong> Main assistant external contribution · <strong>Code:</strong> <code>{diagnostic.code}</code> · <strong>Message ID:</strong> <code>{diagnostic.messageId}</code></p>
  </section>;

  return <section className="notice stack" aria-labelledby="workflow-protocol-diagnostic-title">
    <h5 id="workflow-protocol-diagnostic-title">Workflow dialogue needs follow-up</h5>
    <p>{notFormal
      ? "This workflow record is provisional or has unresolved obligations, so it cannot establish formal agreement. Resolve the outstanding definitions or requirements and continue the dialogue with a complete record."
      : isSupervisor
        ? "The Supervisor’s workflow proposal was not recognized as the current canonical record. The task needs a complete proposal tied to its current task and source before the main assistant can establish agreement."
        : "The main assistant’s workflow acceptance was not recognized as an exact match for the current proposal. The task needs a complete acceptance record that echoes the current proposal."}</p>
    <p className="muted">This diagnostic is informational. It does not create or remove a saved agreement or prove execution.</p>
    <p className="small muted"><strong>Record:</strong> {isSupervisor ? "Supervisor proposal" : "Main assistant acceptance"} · <strong>Code:</strong> <code>{diagnostic.code}</code> · <strong>Message ID:</strong> <code>{diagnostic.messageId}</code></p>
  </section>;
}

const workflowExecutionStatusText = {
  planned: "Planned",
  underway: "Underway",
  completed: "Completed",
  needs_attention: "Needs attention",
} as const;
const childOriginText = {
  main: "Main conversation",
  native_child: "Native child",
  delegated_child: "Delegated child",
  unknown_child: "Child type unknown",
} as const;
const progressStatusText = {
  ok: "Current workflow data",
  unavailable: "Workflow data unavailable",
  denied: "Workflow read is not available for this binding",
  invalid: "Workflow data could not be read",
  incompatible: "An incompatible workflow record was retained",
  too_large: "Workflow data exceeds the read limit",
} as const;

const formatProgressTime = (value: number) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString();
};
const threadHref = (threadId: string) => `t3-thread://v1/${threadId}`;

type WorkflowProgressScopeThread = NonNullable<WorkflowProgressSnapshot["scope"]>["threads"][number];

const lifecyclePresentation = (thread: WorkflowProgressScopeThread): {label: string; tone: "blue" | "green" | "amber"} => {
  if (thread.deletedAt) return {label: "Deleted", tone: "amber"};
  if (thread.archivedAt) return {label: "Archived", tone: "amber"};
  const detail = thread.lifecycleDetail?.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (detail === "failed") return {label: "Failed", tone: "amber"};
  if (detail === "cancelled" || detail === "canceled") return {label: "Cancelled", tone: "amber"};
  if (detail === "rolled_back") return {label: "Rolled back", tone: "amber"};
  if (detail === "interrupted") return {label: "Interrupted", tone: "amber"};
  if (detail === "expired") return {label: "Expired", tone: "amber"};
  if (detail === "resolved") return {label: "Resolved", tone: "amber"};
  if (detail === "idle") return {label: "Unknown", tone: "amber"};
  if (detail === "completed") return {label: "Completed", tone: "green"};
  if (thread.lifecycle === "completed") return {label: "Completed", tone: "green"};
  if (thread.lifecycle === "running") return {label: "Running", tone: "blue"};
  if (thread.lifecycle === "interrupted") return {label: "Interrupted", tone: "amber"};
  return {label: "Unknown", tone: "amber"};
};

const readinessLabels = {
  pending: "Readiness pending",
  ready: "Ready",
  unavailable: "Unavailable",
  unknown: "Readiness unknown",
} as const;
const lifecycleLabels = {
  active: "Active",
  idle: "Idle",
  failed: "Failed",
  quarantined: "Quarantined",
  retired: "Retired",
  unknown: "Lifecycle unknown",
} as const;
const handoverStateLabels = {
  pending: "Pending",
  sending: "Delivery in progress",
  uncertain: "Delivery uncertain",
  delivered: "Delivered; acknowledgment pending",
  failed: "Delivery definitely failed; root recovery required",
  superseded: "Superseded before delivery; no acknowledgment is needed",
} as const;
const handoverReviewLabels = {
  in_progress: "Root-requested review in progress; the root keeps responsibility",
  completed: "Root-requested review completed by the helper’s native run; this does not prove its effects were absent, and request fences remain separate",
} as const;
const readinessTone = (value: ProjectSupervisorTeamInfo["root"]["readiness"]) => value === "ready" ? "green" : value === "pending" ? "blue" : "amber";
const lifecycleTone = (value: ProjectSupervisorTeamInfo["root"]["lifecycle"] | ProjectSupervisorTeamInfo["members"][number]["lifecycle"]) => value === "active" ? "blue" : value === "idle" ? "green" : "amber";
const issueTone = (severity: ProjectSupervisorTeamInfo["issues"][number]["severity"]) => severity === "critical" ? "critical" : severity === "info" ? "blue" : "amber";

function TeamAssessment({assessment}: {assessment: NonNullable<ProjectSupervisorTeamInfo["root"]["lastAssessment"]>}) {
  return <p className="small muted">
    Last assessment: {assessment.summary}{assessment.assessedAt === null ? "" : <> · {formatProgressTime(assessment.assessedAt)}</>}
  </p>;
}

function ProjectSupervisorTeamPanel({team, settings, mainThreadId}: {team: ProjectSupervisorTeamInfo | null | undefined; settings: SupervisorTeamSettingsInfo; mainThreadId: string | null}) {
  return <section className="panel stack supervisor-team" aria-labelledby="supervisor-team-title">
    <div className="row between">
      <h3 id="supervisor-team-title">Supervisor team</h3>
      <span className="pill">Saved maximum helpers per root: {settings.maxHelpersPerRoot}</span>
    </div>
    <HelpDisclosure title={<>How the Supervisor team works</>} ><div className="stack"><p className="muted">The Supervisor team is separate from the operational workflow tree. The root owns unassigned work; each helper covers its assigned subtree and future operational descendants.</p>
    <p className="small muted">A person who messages a helper in T3 follows T3’s native follow-up behavior. Root-to-helper notes and routine check-ins use Supervisor team operations, not raw <code>t3_thread_send</code>.</p>
    <p className="small muted">Quarantine revokes a helper’s Supervisor authority and returns coverage to the root. Unresolved effects stay fenced, and the helper’s native T3 conversation or a turn already running there may continue.</p>
    </div></HelpDisclosure>
    {!mainThreadId
      ? <p className="muted">Select a main conversation to inspect its Supervisor team.</p>
      : !team
        ? <p className="muted">No team snapshot was reported for this main conversation.</p>
      : <>
        <p className="small muted">Observed {formatProgressTime(team.observedAt)}</p>
        {team.status !== "ok" && <p className="panel" role={team.status === "unavailable" ? "alert" : "status"}>
          {team.status === "incomplete" ? "The team snapshot is incomplete; some membership or assignment details may be missing." : "The team snapshot is unavailable."}
          {team.message && <> {team.message}</>}
        </p>}
        <article className="stack supervisor-team-member">
          <div className="row between">
            <strong>{team.root.title ?? "Supervisor root"}</strong>
            <div className="row">
              <span className={`pill ${readinessTone(team.root.readiness)}`}>{readinessLabels[team.root.readiness]}</span>
              <span className={`pill ${lifecycleTone(team.root.lifecycle)}`}>{lifecycleLabels[team.root.lifecycle]}</span>
            </div>
          </div>
          <p><a href={threadHref(team.root.threadId)}>Open root Supervisor in T3</a> · <code>{team.root.threadId}</code></p>
          <p className="small"><strong>Model:</strong> {team.root.model ?? "Not reported by T3"}</p>
          {team.root.currentState && <p><strong>Current state:</strong> {team.root.currentState}</p>}
          {team.root.lastAssessment && <TeamAssessment assessment={team.root.lastAssessment}/>}
        </article>
        {team.members.length === 0
          ? <p className="muted">No Supervisor helpers are registered. Unassigned operational work remains with the root.</p>
          : <div className="stack">
            <h4>Helpers</h4>
            <ul className="stack supervisor-team-members" role="list">{team.members.map(member => <li key={member.threadId} className="supervisor-team-member stack">
              <div className="row between">
                <strong>{member.title ?? "Supervisor helper"}</strong>
                <div className="row">
                  <span className={`pill ${readinessTone(member.readiness)}`}>{readinessLabels[member.readiness]}</span>
                  <span className={`pill ${lifecycleTone(member.lifecycle)}`}>{lifecycleLabels[member.lifecycle]}</span>
                </div>
              </div>
              <p><a href={threadHref(member.threadId)}>Open helper in T3</a> · <code>{member.threadId}</code></p>
              <p className="small"><strong>Model:</strong> {member.model ?? "Not reported by T3"}</p>
              {member.currentState && <p><strong>Current state:</strong> {member.currentState}</p>}
              {member.lastAssessment && <TeamAssessment assessment={member.lastAssessment}/>}
              <div>
                <strong>Current assignments</strong>
                {member.assignments.length === 0
                  ? <p className="small muted">No operational subtree is assigned.</p>
                  : <ul className="small">{member.assignments.map(assignment => <li key={`${assignment.threadId}:${assignment.state}`}>
                    <a href={threadHref(assignment.threadId)}>{assignment.title ?? `Operational subtree ${assignment.threadId}`}</a> · {assignment.state === "active" ? "Active coverage" : assignment.state === "pending" ? "Assignment pending" : assignment.state === "transfer" ? "Transfer in progress" : "Released"}
                  </li>)}</ul>}
              </div>
              {member.pendingHandovers.length > 0 && <div>
                <strong>Pending handovers</strong>
                <ul className="small">{member.pendingHandovers.map((handover, index) => <li key={`${handover.targetThreadId}:${handover.direction}:${index}`}>
                  {handover.direction === "incoming" ? "Incoming" : "Outgoing"} · <a href={threadHref(handover.targetThreadId)}>{handover.targetTitle ?? `Operational subtree ${handover.targetThreadId}`}</a>
                  {handover.review === "requested" && <> · Root-requested effect review</>} · {handover.review === "completed" ? handoverReviewLabels.completed : handoverStateLabels[handover.state]}
                  {handover.runStatus && <> · Native run ended {handover.runStatus.replace("_", " ")} before confirming; nothing was resent</>}
                  {handover.review === "in_progress" && <> · {handoverReviewLabels.in_progress}</>}
                  {handover.summary && <> — {handover.summary}</>}
                </li>)}</ul>
              </div>}
              {member.issues.length > 0 && <div>
                <strong>Significant issues</strong>
                <ul className="small">{member.issues.map(issue => <li key={issue.id}>
                  <span className={`pill ${issueTone(issue.severity)}`}>{issue.severity}</span> {issue.summary} · {formatProgressTime(issue.observedAt)}
                </li>)}</ul>
              </div>}
            </li>)}</ul>
          </div>}
        {team.issues.length > 0 && <div>
          <h4>Team issues</h4>
          <ul className="small">{team.issues.map(issue => <li key={issue.id}>
            <span className={`pill ${issueTone(issue.severity)}`}>{issue.severity}</span> {issue.summary} · {formatProgressTime(issue.observedAt)}
          </li>)}</ul>
        </div>}
      </>}
  </section>;
}

function WorkflowAssignee({coverage}: {coverage: WorkflowProgressCoverage | undefined}) {
  if (!coverage) return <p className="small muted"><strong>Assigned to:</strong> Not reported in this snapshot.</p>;
  if (coverage.state === "root") return <p className="small"><strong>Assigned to:</strong> Supervisor root (unassigned operational work).</p>;
  if (coverage.state === "assigned") return <p className="small"><strong>Assigned to:</strong> {coverage.assigneeThreadId
    ? <a href={threadHref(coverage.assigneeThreadId)}>{coverage.assigneeTitle ?? `Supervisor helper ${coverage.assigneeThreadId}`}</a>
    : "A helper; its T3 identity was not reported."}
    {coverage.assignmentRootThreadId && <> · subtree rooted at <a href={threadHref(coverage.assignmentRootThreadId)}>{coverage.assignmentRootThreadId}</a></>}
  </p>;
  if (coverage.state === "transfer") return <p className="small" role="status"><strong>Assigned to:</strong> Handover in progress{coverage.assignmentRootThreadId && <> for <a href={threadHref(coverage.assignmentRootThreadId)}>this subtree</a></>}.</p>;
  if (coverage.state === "observe_only") return <p className="small" role="status"><strong>Assigned to:</strong> {coverage.assigneeThreadId
    ? <a href={threadHref(coverage.assigneeThreadId)}>{coverage.assigneeTitle ?? "Supervisor root"}</a>
    : "Supervisor root"} · observe-only while unresolved effects block writes{coverage.assignmentRootThreadId && <> for <a href={threadHref(coverage.assignmentRootThreadId)}>this subtree</a></>}.</p>;
  return <p className="small muted"><strong>Assigned to:</strong> Unknown; the current owner could not be confirmed.</p>;
}

type WorkflowProgressThreadView = NonNullable<WorkflowProgressSnapshot["scope"]>["threads"][number];

/** The merged pages of the selected main conversation's progress read. */
export function progressView(pages: readonly WorkflowProgressSnapshot[]) {
  const latest = pages.at(-1);
  const threadById = new Map<string, WorkflowProgressThreadView>();
  const workflowByThreadId = new Map<string, WorkflowProgressWorkflow>();
  const coverageByThreadId = new Map<string, WorkflowProgressCoverage>();
  for (const page of pages) {
    for (const thread of page.scope?.threads ?? []) threadById.set(thread.threadId, thread);
    for (const coverage of page.coverage ?? []) coverageByThreadId.set(coverage.threadId, coverage);
    for (const workflow of page.workflows) {
      const previous = workflowByThreadId.get(workflow.threadId);
      if (!previous || workflow.updatedAt >= previous.updatedAt) workflowByThreadId.set(workflow.threadId, workflow);
    }
  }
  return {
    latest, threadById, workflowByThreadId, coverageByThreadId,
    complete: pages.length > 0 && pages.every(page => page.status === "ok") && !latest?.workflowHasMore,
    failure: [...pages].reverse().find(page => page.status !== "ok"),
    canLoadMore: Boolean(latest && (latest.workflowHasMore || latest.lineageHasMore)),
  };
}

function SupervisorRecords({workflow}: {workflow: WorkflowProgressWorkflow}) {
  const names = new Map(planSteps(workflow.plan).map(step => [step.nodeId, step.name] as const));
  if (workflow.observations.length === 0) return <p className="muted">No Supervisor records were read for this workflow.</p>;
  return <ol className="stack supervisor-records">{[...workflow.observations].sort((a, b) => b.recordedAt - a.recordedAt).map(observation => <li key={observation.id}>
    <p>{observation.note}</p>
    <p className="small muted">{observation.targetNodeId ? observation.targetNodeName ?? names.get(observation.targetNodeId) ?? "Step no longer in the plan" : "Whole task"} · {observation.kind === "status_changed"
      ? `${observation.statusFrom ? workflowExecutionStatusText[observation.statusFrom].toLowerCase() : "new"} → ${observation.statusTo ? workflowExecutionStatusText[observation.statusTo].toLowerCase() : "removed"}` : "note"} · {formatProgressTime(observation.recordedAt)}
      {observation.sourceThreadId && <> · <a href={threadHref(observation.sourceThreadId)}>Supporting conversation</a></>}
      {(observation.sourceRunId || observation.sourceMessageId) && <> · {observation.sourceRunId && <>run <code>{observation.sourceRunId}</code> </>}{observation.sourceMessageId && <>message <code>{observation.sourceMessageId}</code></>}</>}</p>
  </li>)}</ol>;
}

const contributionsByNode = (workflow: WorkflowProgressWorkflow) => {
  const byNode = new Map<string, WorkflowProgressContribution[]>();
  for (const item of workflow.contributions) if (item.inCurrentPlan) byNode.set(item.nodeId, [...byNode.get(item.nodeId) ?? [], item]);
  return byNode;
};

function SupportingActivity({thread}: {thread: WorkflowProgressThreadView}) {
  if (thread.activityRefs.length === 0) return null;
  return <EntityDetails title={<>Supporting activity ({thread.activityRefs.length})</>} >
    <ul className="stack">{thread.activityRefs.map((activity, index) => <li key={`${activity.sourceThreadId}:${activity.sourceItemId ?? activity.sourceMessageId ?? index}`}>
      <p>{activity.label} · {formatProgressTime(activity.observedAt)}</p>
      <p className="small"><a href={threadHref(activity.sourceThreadId)}>Open supporting conversation {activity.sourceThreadId}</a></p>
      {(activity.sourceRunId || activity.sourceMessageId || activity.sourceItemId) && <p className="small muted">
        {activity.sourceRunId && <>Run <code>{activity.sourceRunId}</code> </>}
        {activity.sourceMessageId && <>Message <code>{activity.sourceMessageId}</code> </>}
        {activity.sourceItemId && <>Item <code>{activity.sourceItemId}</code></>}
      </p>}
    </li>)}</ul>
  </EntityDetails>;
}

function ConnectedWork({threads, mainThreadId, workflows, coverage, task, complete}: {threads: readonly WorkflowProgressThreadView[]; mainThreadId: string;
  workflows: ReadonlyMap<string, WorkflowProgressWorkflow>; coverage: ReadonlyMap<string, WorkflowProgressCoverage>; task: TaskInterpretationInfo | undefined; complete: boolean}) {
  const children = threads.filter(thread => thread.threadId !== mainThreadId);
  const mainCoverage = coverage.get(mainThreadId);
  
  return <section className="stack connected-work" aria-labelledby="connected-work-title">
    <h2 id="connected-work-title">Connected work</h2><p className="muted">Conversations started from this task. Their workflows and contributions are recorded separately; a finished child does not complete a parent step.</p>{children.length === 0 && <p>{complete ? "No contributing child conversations are recorded in this read." : "No children in the loaded pages. More conversations may be on a later page."}</p>}
    {mainCoverage && mainCoverage.state !== "root" && <WorkflowAssignee coverage={mainCoverage}/>}
    <ul className="stack">{children.map(thread => {
      const lifecycle = lifecyclePresentation(thread);
      const workflow = workflows.get(thread.threadId);
      const notes = workflow ? stepNotes(task, {kind: "live", workflow, plan: workflow.plan ?? {kind: "sequence", templatePath: null, nodes: []}}) : null;
      return <li key={thread.threadId} className="workflow-progress-thread">
        <div className="row between">
          <div><strong>{thread.title || workflow?.objective || `Conversation ${thread.threadId}`}</strong><p className="muted small">{childOriginText[thread.origin]}{workflow ? ` · ${workflowExecutionStatusText[workflow.status]}` : ""}</p></div>
          <span className={`pill ${lifecycle.tone}`}>{lifecycle.label}</span>
        </div>
        <p className="small">{workflow?.parentNodeReferences.length ? <>Contributes to: {workflow.parentNodeReferences.map(reference => reference.nodeName).join(", ")}</> : "No recorded contribution to a parent step"}</p><div className="conversation-meta"><WorkflowAssignee coverage={coverage.get(thread.threadId)}/>{!thread.deletedAt && <a href={threadHref(thread.threadId)}>Open in T3 →</a>}</div>
        <EntityDetails title={<>{workflow ? "Child workflow and records" : "Conversation details"}</>} ><div className="stack">
          {workflow?.objective && <p>{workflow.objective}</p>}
          {workflow?.parentNodeReferences.length ? <p className="small">Contributes to parent steps: {workflow.parentNodeReferences.map(reference => reference.nodeName).join(", ")}</p> : null}
          {workflow?.plan && notes && <PlanJourney node={workflow.plan} mode="live" notes={{...notes, agreed: null, proposed: null, changed: new Set()}} contributions={contributionsByNode(workflow)}/>}
          {workflow && <SupervisorRecords workflow={workflow}/>}
          <p className="small">Lifecycle: {lifecycle.label}{thread.lifecycleDetail ? ` · T3 detail: ${thread.lifecycleDetail}` : ""}</p>
          <SupportingActivity thread={thread}/>
          {lifecycle.label === "Unknown" && <p className="small muted">T3 has not established this conversation’s current lifecycle. An idle thread mirror alone does not establish that its work is finished.</p>}
          {thread.contactLimit && <p className="small muted">{thread.contactLimit}</p>}
          {!workflow && <p className="small muted">{complete ? "No workflow document is recorded for this conversation." : "Workflow state for this conversation may be on a later page."}</p>}
        </div></EntityDetails>
      </li>;
    })}</ul>
  </section>;
}

/**
 * The canonical task workspace: the task and its current state, one journey, one agreement context and one place for
 * evidence and history. Statuses come only from the live workflow bound to this task.
 */
export function TaskWorkspace({snapshot, task, threadId, progress, connected, attention, stopped, readAt, refreshing, onRefresh, onLoadMore, supervisionLink, connectedWorkLink, currentRead = true}: {
  snapshot: ProjectSupervisorInfo; task: TaskInterpretationInfo | undefined; threadId: string; progress: WorkflowProgressPanelState | undefined; connected: boolean;
  attention: readonly string[]; stopped: boolean; readAt: number | null; refreshing: boolean; onRefresh: () => void; onLoadMore: () => void; supervisionLink?: React.ReactNode; connectedWorkLink?: React.ReactNode; currentRead?: boolean;
}) {
  const view = progressView(progress?.pages ?? []);
  const mainWorkflow = view.workflowByThreadId.get(threadId);
  const currentAssessment = assessmentForTask(mainWorkflow?.assessment, task);
  const record = journeyRecord(task, mainWorkflow);
  const notes = stepNotes(task, record);
  const accepted = acceptedAgreement(task);
  const pending = pendingProposal(task);
  const changes = accepted && pending ? pending.plan ? planChanges(accepted.workflow.plan, pending.plan) : [] : null;
  const steps = record.kind === "none" ? [] : planSteps(record.plan);
  const current = record.kind === "live" ? steps.filter(step => step.status === "underway" || step.status === "needs_attention").map(step => step.name).join(" · ") : "";
  const latestObservation = record.kind === "live" ? [...record.workflow.observations].sort((a, b) => b.recordedAt - a.recordedAt)[0] : undefined;
  const retained = mainWorkflow && record.kind !== "live" ? [mainWorkflow] : [];
  const staleAgreement = task?.agreement?.status === "stale" ? task.agreement : null;
  const removedContributions = record.kind === "live" ? record.workflow.contributions.filter(item => !item.inCurrentPlan) : [];
  const mainThread = view.threadById.get(threadId);
  const assessmentState = currentAssessment ? `Assessed ${formatProgressTime(currentAssessment.updatedAt)}` : progress?.error ? "Assessment unavailable"
    : progress?.loading ? "Reading assessment…" : !view.complete ? "Assessment coverage incomplete" : mainWorkflow ? "Retained workflow; not linked to this task" : "No current workflow record";
  const fallback = task?.engagement?.mode === "following" ? "Task scope remains open" : task?.status === "not_supervised" ? "Supervision not needed" : record.kind === "agreed" ? "Plan accepted · work not yet assessed"
    : task?.agreement?.status === "stale" ? "Plan needs acceptance again" : task?.workflow ? "Agreeing a plan"
    : task?.status === "waiting" || task?.status === "queued" || task?.status === "dispatching" ? "Reading the request"
    : progress?.loading ? "Reading assessment…" : "No assessment recorded";
  return <div className="task-workspace stack">
    <section className="task-band" aria-label="Task">
      <ConversationStatus explicitlyStopped={stopped} engagement={task?.engagement} fresh={connected && snapshot.available && currentRead}/>
      <p className="task-objective">{task?.objective ?? (snapshot.available ? "No task objective has been recorded for this conversation." : "The task could not be read.")}</p>
      {task?.reason && task.status !== "inferred" && <p className="muted">{task.reason}</p>}
      <TaskOutcome {...(currentAssessment && current ? {currentStep: current} : {})} assessment={currentAssessment} fallback={fallback} stopped={stopped}/>
      <div className="task-reading">
        <span><strong>{alignmentLabel(task)}</strong></span>
        <span>{assessmentState}</span>
        <span className="task-refresh">{readAt !== null && <span>Read {new Date(readAt).toLocaleTimeString()}</span>}<button type="button" className="quiet-button" aria-disabled={!connected || refreshing} onClick={() => {if (connected && !refreshing) onRefresh();}}>{refreshing ? "Refreshing…" : "Refresh"}</button></span>
      </div>
    </section>
    <ConversationUnderstanding draft={task?.conversation?.draft}/>
    {(attention.length > 0 || task?.definitionReview || task?.workflowProtocolDiagnostic) && <section className="notice stack attention-band" aria-labelledby="task-attention-title">
      <h2 id="task-attention-title">Needs attention</h2>
      {attention.length === 1 ? <p>{attention[0]}</p> : attention.length > 1 && <ul>{attention.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      {task?.definitionReview && <DefinitionReviewView review={task.definitionReview}/>}
      <WorkflowProtocolDiagnosticView diagnostic={task?.workflowProtocolDiagnostic}/>
      {supervisionLink}
    </section>}
    {progress?.error && <p role="status">{progress.error} {currentAssessment ? "Showing the retained assessment." : "Current status is unknown."}</p>}
    {!progress?.error && view.failure && <p role="alert">{progressStatusText[view.failure.status]}. {view.failure.message}</p>}
    {view.latest?.scope && !view.latest.scope.complete && <p className="notice" role="status">Connected child observation is incomplete. Some lifecycle or activity details may be missing.{view.latest.scope.issues.length > 0 && <> {view.latest.scope.issues.map(issue => issue.message).join(" ")}</>}</p>}
    <div className="workflow-journey-layout">
      <section className="workflow-plan-surface" aria-labelledby="journey-title">
        <div className="journey-head">
          <h2 id="journey-title">{record.kind === "live" ? "Workflow" : record.kind === "agreed" ? "Accepted plan" : record.kind === "proposed" ? "Proposed plan" : "Plan"}</h2>
          <span className="small muted">{record.kind === "live" && !currentAssessment ? "Earlier scope assessments retained" : record.kind === "live" ? `${steps.filter(step => step.status === "completed").length} of ${steps.length} steps assessed complete` : record.kind === "agreed" ? "Not yet assessed" : record.kind === "proposed" ? "Awaiting acceptance" : ""}</span>
        </div>
        {record.kind === "none"
          ? <p className="muted">{task?.workflow ? "No plan structure is available for this proposal." : task ? "No workflow proposal was recorded for this task." : snapshot.available ? "No task interpretation or plan has been recorded for this conversation." : "Task and plan state could not be read. Their absence has not been established."}</p>
          : <PlanJourney node={record.plan} mode={record.kind} notes={notes} {...(record.kind === "live" ? {contributions: contributionsByNode(record.workflow)} : {})}/>}
      </section>
      <aside className="workflow-context">
        <TaskAlignment task={task} {...(snapshot.binding ? {supervisorThreadId: snapshot.binding.threadId} : {})}/>
        {pending && changes && <PlanChanges changes={changes} proposal={pending} proposalId={task?.workflowProposalId}/>}
        {latestObservation && <section className="workflow-observation-summary" aria-labelledby="latest-observation-title"><h3 id="latest-observation-title">Latest Supervisor record</h3>
          <p>{latestObservation.note}</p><p className="small muted">{latestObservation.targetNodeId ? latestObservation.targetNodeName ?? "Step" : "Whole task"} · {formatProgressTime(latestObservation.recordedAt)}</p></section>}
      </aside>
    </div>
    <div className="connected-summary"><Icon name="tree" size={18}/><span>{[...view.threadById.keys()].filter(id => id !== threadId).length} connected conversations in this read</span>{connectedWorkLink}</div>
    <EntityDetails title={<>Evidence and history</>} className="evidence-history"><div className="stack">
      <p className="small muted">Statuses and notes are the Supervisor’s assessments of the conversation’s work; they are not independent proof of execution. A parent step does not complete when a child finishes.</p>
      {record.kind === "live" && <section className="stack"><h3>Supervisor records</h3><SupervisorRecords workflow={record.workflow}/></section>}
      {removedContributions.length > 0 && <section className="stack"><h3>Contributions for steps no longer in the plan</h3><StepContributions items={removedContributions}/></section>}
      {mainThread && <section className="stack"><h3>Native conversation</h3><p className="small">{lifecyclePresentation(mainThread).label}{mainThread.lifecycleDetail ? ` · ${mainThread.lifecycleDetail}` : ""} · <a href={threadHref(threadId)}>Open in T3</a></p>{mainThread.contactLimit && <p className="small muted">{mainThread.contactLimit}</p>}<SupportingActivity thread={mainThread}/></section>}
      {staleAgreement?.workflow.plan && <EntityDetails title={<>Earlier acceptance (out of date)</>} className="retained-workflow"><p className="notice">This acceptance is history. The current plan still needs acceptance.</p><PlanJourney node={staleAgreement.workflow.plan} mode="historical"/></EntityDetails>}
      {retained.map(workflow => <EntityDetails title={<>Earlier workflow: {workflow.objective ?? "Objective not recorded"}</>} key={workflow.workflowId} className="retained-workflow">
        <p className="notice">Retained workflow record. It is not linked to the current task.</p>
        {workflow.plan && <PlanJourney node={workflow.plan} mode="live" notes={{agreed: null, proposed: null, records: recordsByStep(workflow.observations), changed: new Set()}} contributions={contributionsByNode(workflow)}/>}
        <SupervisorRecords workflow={workflow}/></EntityDetails>)}
      {(view.latest?.incompatibleWorkflows.length ?? 0) > 0 && <p className="notice" role="status">Some retained workflow records use an incompatible format and remain read-only: {view.latest!.incompatibleWorkflows.map(item => item.workflowId).join(", ")}.</p>}
    </div></EntityDetails>
    {view.canLoadMore && <button type="button" disabled={!connected || progress?.loading} onClick={onLoadMore}>Load more connected workflows and activity</button>}
  </div>;
}


export type ConversationSection = "all" | "task" | "supervision" | "settings" | "connected";

// outside projects the instance's No Project mode, not a project switch, decides which chats are supervised
const noProjectEligibility = {
  off: "No Project mode is Off, so no chat outside a project is supervised.",
  on_request: "No Project mode is On request: people’s requests are supervised only in chats outside projects where supervision has been started.",
  automatic: "No Project mode is Automatic: people’s requests in every eligible chat outside a project are supervised.",
} as const;

/** The read time and the one refresh action of a Supervisor view. */
function Freshness({readAt, refreshing, connected, onRefresh}: {readAt: number | null; refreshing: boolean; connected: boolean; onRefresh: () => void}) {
  return <div className="view-freshness small muted">{readAt !== null && <span>Read {new Date(readAt).toLocaleTimeString()}</span>}
    <button type="button" className="quiet-button" aria-disabled={!connected || refreshing} onClick={() => {if (connected && !refreshing) onRefresh();}}>{refreshing ? "Refreshing…" : "Refresh"}</button></div>;
}

export function ProjectSupervisorView({
  section = "all",
  readAt = null,
  refreshing = false,
  currentRead = true,
  onRefresh = () => {},
  supervisionLink, connectedWorkLink,
  attentionEnabled = true,
  snapshot,
  selection,
  monitoring,
  teamSettings,
  agentThreads = false,
  threadId,
  connected,
  saving,
  fieldsBusy,
  blocked,
  dirty,
  canSave,
  shouldOfferRetry,
  retryButtonLabel,
  canRetry,
  workflowProgress,
  onWorkflowProgressLoadMore,
  onSelectionChange,
  onMonitoringChange,
  onTeamSettingsChange,
  onAgentThreadsChange = () => {},
  onDiscard,
  onRetry,
  onSubmit,
  chatSupervisionBusy = false,
  chatSupervisionLocked = false,
  chatSupervisionMessage = null,
  onChatSupervision = () => {},
}: {
  attentionEnabled?: boolean;
  chatSupervisionBusy?: boolean;
  chatSupervisionLocked?: boolean;
  chatSupervisionMessage?: string | null;
  onChatSupervision?: (enabled: boolean) => void;
  section?: ConversationSection;
  readAt?: number | null;
  refreshing?: boolean;
  currentRead?: boolean;
  onRefresh?: () => void;
  supervisionLink?: React.ReactNode;
  connectedWorkLink?: React.ReactNode;
  snapshot: ProjectSupervisorInfo;
  selection: SupervisorModelSelection;
  monitoring: MonitoringDraft;
  teamSettings: TeamSettingsDraft;
  agentThreads?: boolean;
  threadId?: string;
  connected: boolean;
  saving: boolean;
  fieldsBusy: boolean;
  blocked: boolean;
  dirty: boolean;
  canSave: boolean;
  shouldOfferRetry: boolean;
  retryButtonLabel: string;
  canRetry: boolean;
  workflowProgress?: WorkflowProgressPanelState;
  onWorkflowProgressLoadMore?: () => void;
  onSelectionChange: (selection: SupervisorModelSelection) => void;
  onMonitoringChange: (monitoring: MonitoringDraft) => void;
  onTeamSettingsChange: (settings: TeamSettingsDraft) => void;
  onAgentThreadsChange?: (enabled: boolean) => void;
  onDiscard: () => void;
  onRetry: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const selected = findModel(snapshot, selection);
  const reasoning = selected?.options.find(isReasoningOption);
  const storedReasoning = reasoning && selection.options.find(option => option.id === reasoning.id)?.value;
  const reasoningValue = storedReasoning ?? reasoning?.defaultValue;
  const reasoningIsAdvertised = reasoning?.choices.some(choice => choice.value === reasoningValue) ?? false;
  const listedSelection = snapshot.models.some(model => modelKey(model) === selectedModelKey(selection));
  const providerGroups = [...new Set(snapshot.models.map(model => model.providerName))];
  const selectedTask = threadId ? snapshot.tasks.find(task => task.threadId === threadId && task.projectId === snapshot.projectId) : undefined;
  const mainWorkflow = threadId ? progressView(workflowProgress?.pages ?? []).workflowByThreadId.get(threadId) : undefined;
  const currentAssessment = assessmentForTask(mainWorkflow?.assessment, selectedTask);
  // reasons the task workspace already states in its outcome, agreement panel or the record's own details
  const shownElsewhere = new Set([currentAssessment?.summary, protocolDiagnosticAttention, staleAgreementAttention,
    selectedTask?.workflow ? planStatusAttention(selectedTask.workflow.status) : undefined,
    selectedTask?.definitionReview?.status === "revert_requested" ? selectedTask.definitionReview.message.slice(0, 700) : undefined]);
  const attention = workAttention({enabled: (snapshot.chatSupervision?.effectiveEnabled ?? attentionEnabled) && !snapshot.chatSupervision?.stopped, bindingState: snapshot.binding?.state ?? null,
    settlementState: snapshot.binding?.settlementState ?? null, monitoring: snapshot.monitoringStatus, task: selectedTask, assessment: currentAssessment})
    .filter(reason => !shownElsewhere.has(reason));
  const fieldsDisabled = !connected || !snapshot.available || fieldsBusy || blocked;
  const intervalError = monitoringError(monitoring.intervalMinutes, monitoringIntervalMinutes.min, monitoringIntervalMinutes.max, "maximum pending activity age in minutes");
  const thresholdError = monitoringError(monitoring.activityThreshold, 3, 100, "finalized activity threshold");
  const teamSettingsError = monitoringError(teamSettings.maxHelpersPerRoot, 0, 20, "maximum helpers per root");
  const modelCanChange = !fieldsDisabled;
  const reasoningCanChange = !fieldsDisabled && Boolean(selected?.available && reasoning?.choices.length);

  return <div className="stack">
    {!snapshot.available && <p className="panel" role="alert">Supervisor state is unavailable. {snapshot.message}</p>}
    {(section === "all" || section === "task") && threadId && <TaskWorkspace currentRead={currentRead} snapshot={snapshot} task={selectedTask} threadId={threadId} progress={workflowProgress} connected={connected}
      attention={attention} stopped={Boolean(snapshot.chatSupervision?.stopped)} readAt={readAt} refreshing={refreshing} onRefresh={onRefresh}
      onLoadMore={onWorkflowProgressLoadMore ?? (() => {})} {...(supervisionLink ? {supervisionLink} : {})} {...(connectedWorkLink ? {connectedWorkLink} : {})}/>}
    {section === "connected" && threadId && (() => {
      const view = progressView(workflowProgress?.pages ?? []);
      return <div className="stack"><Freshness readAt={readAt} refreshing={refreshing} connected={connected} onRefresh={onRefresh}/><ConnectedWork threads={[...view.threadById.values()]} mainThreadId={threadId} workflows={view.workflowByThreadId} coverage={view.coverageByThreadId} task={selectedTask} complete={view.complete}/>{workflowProgress?.error && <p role="status">{workflowProgress.error}</p>}{view.canLoadMore && <button type="button" disabled={!connected || workflowProgress?.loading} onClick={onWorkflowProgressLoadMore}>Load more connected workflows and activity</button>}</div>;
    })()}
    {section === "supervision" && <Freshness readAt={readAt} refreshing={refreshing} connected={connected} onRefresh={onRefresh}/>}
    {(section === "all" || section === "supervision") && snapshot.mainThreadId && snapshot.chatSupervision?.stopped && snapshot.chatSupervision.stoppedAt !== null && <StopNotice title={threadId ?? snapshot.mainThreadId} audit={{route: snapshot.chatSupervision.stoppedBy ?? "unknown", stoppedAt: snapshot.chatSupervision.stoppedAt, callerThreadId: snapshot.chatSupervision.stoppedCallerThreadId ?? null, userMessageId: snapshot.chatSupervision.stoppedUserMessageId ?? null}} onEnable={() => onChatSupervision(true)} busy={!connected || chatSupervisionBusy || chatSupervisionLocked}/>}
    <div hidden={section !== "all" && section !== "supervision"} className="panel stack">
      <div className="row between">
        <h3>Supervisor health</h3>
        {snapshot.binding && <span className={`pill ${snapshot.binding.state === "ready" ? "green" : "amber"}`}>{{creating: "Creating conversation", ready: "Ready", uncertain: "Outcome uncertain", rejected: "Access rejected", missing: "Conversation deleted"}[snapshot.binding.state]}</span>}
      </div>
      <p className="supervision-health">{snapshot.monitoringStatus?.state === "unavailable" || snapshot.monitoringStatus?.state === "uncertain" ? snapshot.monitoringStatus.message : snapshot.binding?.state === "ready" ? snapshot.monitoringStatus?.state === "busy" ? "Supervisor is reviewing recent activity." : "Supervisor is ready and waiting for new activity." : "Supervisor is not ready. Review its connection and recovery options."}</p>
      {snapshot.binding?.state === "missing"
        ? <p>Deleted Supervisor conversation: <code>{snapshot.binding.threadId}</code></p>
        : snapshot.binding
          ? <p>Bound conversation: <a href={`t3-thread://v1/${snapshot.binding.threadId}`}>Open in T3</a> <code>{snapshot.binding.threadId}</code></p>
        : <p>{snapshot.mainThreadId ? "No Supervisor is bound to this main conversation yet." : "Select a main conversation to inspect its Supervisor."}</p>}
      <EntityDetails title={<>Conversation and model details</>} ><div className="stack"><p className="muted">Saving settings does not start a conversation. T3 creates the Supervisor conversation for the first task that needs it, then reuses it when that main conversation resumes. Independent main conversations have separate Supervisors.</p>
      {snapshot.binding?.settlementState && <p>Automatic settlement: {snapshot.binding.settlementState}. Resumed work uses this same conversation.</p>}
      {snapshot.binding?.settlementBlockedBy && !snapshot.binding.settlementState && <p className="muted">Automatic settlement is waiting on: {snapshot.binding.settlementBlockedBy.replaceAll("_", " ")}.</p>}
      {snapshot.binding?.keptActive && <p>Automatic settlement is held by a user keep-active choice.</p>}
      <p className="muted">Supervisor work runs in the project root. Role instructions limit it to reading and messaging through T3, but those instructions do not enforce tool restrictions.</p>
      <p><strong>Project default for new Supervisors:</strong> {formatModel(snapshot, snapshot.settings.modelSelection)}</p>
      {snapshot.mainThreadId && <p><strong>Selected Supervisor model in T3:</strong> {formatModel(snapshot, snapshot.modelSelection)}. Edit this conversation’s model using T3 controls.</p>}
      {snapshot.modelApplication?.pending && snapshot.binding?.state === "ready" && <p role="status">T3 is waiting to apply the saved model selection while the Supervisor is idle.</p>}
      {snapshot.settings.pending && !snapshot.binding && <p role="status">The saved model selection will apply when T3 creates the Supervisor conversation for the first needed task.</p>}
      </div></EntityDetails>
      <p>{snapshot.message}</p>
      {!snapshot.available && <p role="status">Supervisor status is currently unavailable.</p>}

    </div>



    <div hidden={section !== "all" && section !== "supervision"} className="panel stack">
        {snapshot.monitoringStatus && <section className="stack" aria-labelledby="supervisor-monitoring-status-title">
          <h4 id="supervisor-monitoring-status-title">Monitoring</h4><p>{snapshot.monitoringStatus.message}</p><EntityDetails title={<>Monitoring details and check-ins</>} ><div className="stack">
          <p><strong>Status:</strong> {snapshot.monitoringStatus.state}</p>
          <p><strong>Pending activities:</strong> {snapshot.monitoringStatus.pendingItems}</p>
          <p><strong>Next review:</strong> {formatMonitoringTime(snapshot.monitoringStatus.nextReviewAt)}</p>
          <p><strong>Last notice:</strong> {formatMonitoringTime(snapshot.monitoringStatus.lastNoticeAt)}</p>
          <p>{snapshot.monitoringStatus.message}</p>
          {snapshot.monitoringStatus.review && <ReviewOutcomes review={snapshot.monitoringStatus.review} />}</div></EntityDetails>
        </section>}
    </div>

    {section === "settings" && <Freshness readAt={readAt} refreshing={refreshing} connected={connected} onRefresh={onRefresh}/>}
    <form hidden={section !== "all" && section !== "settings"} className="panel stack" onSubmit={onSubmit} aria-label="Supervisor settings">
      <fieldset disabled={fieldsDisabled} className="stack">
        <legend>Which conversations are supervised</legend>
        <p className="muted">{snapshot.noProjectMode ? noProjectEligibility[snapshot.noProjectMode] : "People’s requests in this project’s main conversations are supervised while the project switch above is on."}</p>
        <label className="toggle" htmlFor="supervisor-agent-created-threads"><input id="supervisor-agent-created-threads" name="superviseAgentCreatedThreads" type="checkbox"
          checked={agentThreads} onChange={event => onAgentThreadsChange(event.target.checked)} />
          <span>Supervise conversations created by agents<small>Off by default: agent-created conversations stay excluded even after later human messages. When on, genuine human requests and requests written afterwards by the agent that launched an ordinary conversation {snapshot.noProjectMode ? "outside a project" : "in this project"} are interpreted and negotiated like a person’s task, and remain attributed to that agent. Earlier requests, other agents, Supervisor conversations, helpers and delegated child tasks are never supervised this way. Start, Stop and definition approval still need a person.{snapshot.noProjectMode && " The No Project mode still decides which chats are supervised."}</small></span>
        </label>
      </fieldset>
      <h3 className="form-section-title">Defaults for new Supervisors</h3>
      <fieldset disabled={fieldsDisabled} className="stack">
        <legend>Model</legend>
        <label htmlFor="supervisor-model">Model</label>
        <select id="supervisor-model" name="model" value={selectedModelKey(selection)} disabled={!modelCanChange} onChange={event => {
            const next = parseModelKey(event.target.value);
            const model = snapshot.models.find(candidate => candidate.instanceId === next.instanceId && candidate.model === next.model);
            if (model?.available) onSelectionChange(withModelDefaults(model));
          }}>
            {!listedSelection && <option value={selectedModelKey(selection)} disabled>Saved selection unavailable: {selection.instanceId} · {selection.model}</option>}
            {providerGroups.map(provider => <optgroup key={provider} label={provider}>
              {snapshot.models.filter(model => model.providerName === provider).map(model => <option key={modelKey(model)} value={modelKey(model)} disabled={!model.available}>
                {model.name} ({model.model}){model.available ? "" : " — unavailable"}
              </option>)}
            </optgroup>)}
        </select>
        {reasoning && reasoning.choices.length > 0 && <>
          <label htmlFor="supervisor-reasoning">{reasoning.label}</label>
          <select id="supervisor-reasoning" name="reasoning" value={encodeChoice(reasoningValue!)} disabled={!reasoningCanChange} onChange={event => {
            const value = parseChoice(event.target.value);
            onSelectionChange(withReasoningValue(selection, selected!, reasoning.id, value));
          }}>
            {!reasoningIsAdvertised && <option value={encodeChoice(reasoningValue!)} disabled>Stored value: {String(reasoningValue)}</option>}
            {reasoning.choices.map(choice => <option key={encodeChoice(choice.value)} value={encodeChoice(choice.value)}>{choice.label}</option>)}
          </select>
        </>}
      </fieldset>
      <fieldset disabled={fieldsDisabled} className="stack">
        <legend>Ongoing monitoring</legend>
        <p className="muted">Monitoring wakes each main conversation’s own Supervisor chat when pending activity reaches its maximum age or the finalized activity threshold. Defaults apply to new task workflows; existing objective-only tasks are not reprocessed.</p>
        <div className="stack">
          <label htmlFor="supervisor-monitoring-interval">Maximum pending activity age (minutes)</label>
          <input id="supervisor-monitoring-interval" name="intervalMinutes" type="number" min={monitoringIntervalMinutes.min} max={monitoringIntervalMinutes.max} step={1} required
            value={monitoring.intervalMinutes} aria-invalid={intervalError ? true : undefined}
            aria-describedby="supervisor-monitoring-interval-help supervisor-monitoring-interval-error"
            onChange={event => onMonitoringChange({...monitoring, intervalMinutes: event.target.value})} />
          <span id="supervisor-monitoring-interval-help" className="small muted">Enter 1 or 2 minutes; 2 is the default and the upper bound. A check-in also waits for the cooldown and any check-in still in flight.</span>
          <span id="supervisor-monitoring-interval-error" className="small" aria-live="polite">{intervalError}</span>
        </div>
        <div className="stack">
          <label htmlFor="supervisor-monitoring-threshold">Finalized activities per operative chat</label>
          <input id="supervisor-monitoring-threshold" name="activityThreshold" type="number" min={3} max={100} step={1} required
            value={monitoring.activityThreshold} aria-invalid={thresholdError ? true : undefined}
            aria-describedby="supervisor-monitoring-threshold-help supervisor-monitoring-threshold-error"
            onChange={event => onMonitoringChange({...monitoring, activityThreshold: event.target.value})} />
          <span id="supervisor-monitoring-threshold-help" className="small muted">Enter a whole number from 3 to 100 finalized activities.</span>
          <span id="supervisor-monitoring-threshold-error" className="small" aria-live="polite">{thresholdError}</span>
        </div>
        <p><strong>Supervisor cooldown:</strong> 30 seconds between monitoring sends.</p>
        <p><strong>Model review limit:</strong> one in-flight review per Supervisor.</p>
      </fieldset>
      <fieldset disabled={fieldsDisabled} className="stack">
        <legend>Supervisor team</legend>
        <p className="muted">Set the maximum number of helpers the root may recruit. The limit applies to new recruitment; existing helpers remain when the value is 0 or the limit is lowered.</p>
        <label htmlFor="supervisor-team-max-helpers">Maximum helpers per root</label>
        <input id="supervisor-team-max-helpers" name="maxHelpersPerRoot" type="number" min={0} max={20} step={1} required
          value={teamSettings.maxHelpersPerRoot} aria-invalid={teamSettingsError ? true : undefined}
          aria-describedby="supervisor-team-max-helpers-help supervisor-team-max-helpers-error"
          onChange={event => onTeamSettingsChange({...teamSettings, maxHelpersPerRoot: event.target.value})} />
        <span id="supervisor-team-max-helpers-help" className="small muted">Enter a whole number from 0 to 20. The default is 5; 0 disables new recruitment.</span>
        <span id="supervisor-team-max-helpers-error" className="small" aria-live="polite">{teamSettingsError}</span>
      </fieldset>

      <div className="save-bar">{dirty && <span>Unsaved Supervisor settings</span>}<button className="primary" type="submit" disabled={!canSave || saving || blocked}>{saving ? "Saving…" : "Save Supervisor settings"}</button>
      {dirty && <button type="button" disabled={saving || blocked} onClick={onDiscard}>Discard draft</button>}</div>
    </form>

    {shouldOfferRetry && <div hidden={section !== "all" && section !== "supervision"} className="panel stack">
      <h3>{snapshot.binding?.state === "missing" ? "Deleted Supervisor conversation" : "Native Supervisor access"}</h3>
      <p className="muted">{snapshot.binding?.state === "missing"
        ? "T3 confirmed that the bound conversation was deleted. This explicit action replaces it with a new Supervisor conversation."
        : "Use this explicit action to retry the selected conversation’s pending or rejected native operation."}</p>
      {!snapshot.binding && <p role="status">No bound Supervisor conversation is available to retry yet. Refresh after the service establishes one.</p>}
      {dirty && <p role="status">Save or discard your settings draft before retrying native access.</p>}
      <button type="button" disabled={!canRetry || saving || blocked} onClick={onRetry}>{retryButtonLabel}</button>
    </div>}

    <div hidden={section !== "all" && section !== "supervision"} className="conversation-supervision stack">      {snapshot.mainThreadId && snapshot.chatSupervision && <div className="stack">
        <h4>Chat supervision</h4>
        <p>{snapshot.chatSupervision.stopped
          ? `Supervision is stopped for this chat${snapshot.chatSupervision.stoppedBy ? ` (${{direct: "asked directly in the Supervisor conversation", relay: "asked in this chat", chat: "asked from another chat", ui: "stopped here"}[snapshot.chatSupervision.stoppedBy]})` : ""}. It stays off until you enable it again; the chat itself is not changed.`
          : snapshot.chatSupervision.activation === "not_started" ? "Not started. Choose this chat from Home to start supervision." : snapshot.chatSupervision.activation === "pending" ? "Start pending. No supervision effects are authorized yet." : "Allowed for this chat; project/global settings still apply."}</p>
        {(!snapshot.chatSupervision.stopped || snapshot.chatSupervision.stoppedAt === null) && <div><button type="button" className={snapshot.chatSupervision.stopped ? "primary" : "danger-button"} disabled={!connected || chatSupervisionBusy || chatSupervisionLocked} aria-busy={chatSupervisionBusy || undefined}
          onClick={() => onChatSupervision(snapshot.chatSupervision!.stopped)}>
          {chatSupervisionBusy ? "Saving…" : snapshot.chatSupervision.stopped ? "Enable supervision" : "Stop supervision"}</button></div>}
        <p role="status">{chatSupervisionMessage ?? ""}</p>
      </div>}
    </div>
    <div hidden={section !== "all" && section !== "supervision"}><ProjectSupervisorTeamPanel team={snapshot.team} settings={readTeamSettings(snapshot)} mainThreadId={snapshot.mainThreadId}/></div>
  </div>;
}

// the settings change outcome a panel applies: a decoded result or the request error that replaced it (undefined when the
// failure carried no request error)
type ChangeOutcome = Result.Result<ProjectSupervisorSaveOutcome, ProjectSupervisorRequestError | undefined>;
type SettingsState = {view: ProjectSupervisorView; draft: Draft | null};

const canonicalDraft = (projectId: string, snapshot: ProjectSupervisorInfo): Draft => {
  const canonical = copySelection(snapshot.settings.modelSelection);
  const monitoring = readMonitoringDraft(snapshot);
  const teamSettings = readTeamSettingsDraft(snapshot);
  return {projectId, modelValue: canonical, modelBaseline: copySelection(canonical), monitoringValue: copyMonitoringDraft(monitoring),
    monitoringBaseline: copyMonitoringDraft(monitoring), teamSettingsValue: copyTeamSettingsDraft(teamSettings),
    teamSettingsBaseline: copyTeamSettingsDraft(teamSettings), agentThreadsValue: readAgentThreads(snapshot), agentThreadsBaseline: readAgentThreads(snapshot),
    expectedGeneration: snapshot.settings.generation};
};

/**
 * Applies a read to the project's draft: every field takes the read's saved value as its baseline and the expected generation
 * moves to the read; a dirty field keeps its value, so a reload never overwrites an unsaved edit. `keptDirty` reports
 * whether an unsaved edit still differs from the new baseline.
 */
export const mergeLoadedDraft = (prior: Draft | null, projectId: string, snapshot: ProjectSupervisorInfo): {draft: Draft; keptDirty: boolean} => {
  const modelWasDirty = Boolean(prior && selectionKey(prior.modelValue) !== selectionKey(prior.modelBaseline));
  const monitoringWasDirty = Boolean(prior && !sameMonitoring(prior.monitoringValue, prior.monitoringBaseline));
  const teamSettingsWereDirty = Boolean(prior && !sameTeamSettings(prior.teamSettingsValue, prior.teamSettingsBaseline));
  const agentThreadsWereDirty = Boolean(prior && prior.agentThreadsValue !== prior.agentThreadsBaseline);
  const modelBaseline = copySelection(snapshot.settings.modelSelection);
  const modelValue = modelWasDirty ? copySelection(prior!.modelValue) : copySelection(modelBaseline);
  const monitoringBaseline = readMonitoringDraft(snapshot);
  const monitoringValue = monitoringWasDirty ? copyMonitoringDraft(prior!.monitoringValue) : copyMonitoringDraft(monitoringBaseline);
  const teamSettingsBaseline = readTeamSettingsDraft(snapshot);
  const teamSettingsValue = teamSettingsWereDirty ? copyTeamSettingsDraft(prior!.teamSettingsValue) : copyTeamSettingsDraft(teamSettingsBaseline);
  const agentThreadsBaseline = readAgentThreads(snapshot);
  const agentThreadsValue = agentThreadsWereDirty ? prior!.agentThreadsValue : agentThreadsBaseline;
  return {
    draft: {projectId, modelValue, modelBaseline, monitoringValue, monitoringBaseline, teamSettingsValue, teamSettingsBaseline,
      agentThreadsValue, agentThreadsBaseline, expectedGeneration: snapshot.settings.generation},
    keptDirty: (modelWasDirty && selectionKey(modelValue) !== selectionKey(modelBaseline)) ||
      (monitoringWasDirty && !sameMonitoring(monitoringValue, monitoringBaseline)) ||
      (teamSettingsWereDirty && !sameTeamSettings(teamSettingsValue, teamSettingsBaseline)) ||
      (agentThreadsWereDirty && agentThreadsValue !== agentThreadsBaseline),
  };
};

const withMessage = (view: ProjectSupervisorView, scope: string, text: string, alert: boolean): ProjectSupervisorView =>
  ({...view, message: {scope, text, alert}});

/**
 * The outcome of a settings save for its own scope: a verified save resets the draft to the saved settings, a save without
 * a read-back or an uncertain outcome blocks further changes until a refresh, a conflict keeps the draft against the latest
 * generation, and a definite refusal keeps the draft editable.
 */
export const settleSave = ({view, draft}: SettingsState, scope: string, input: ProjectSupervisorSaveInput, outcome: ChangeOutcome): SettingsState => {
  if (Result.isFailure(outcome)) {
    const definitelyNotSaved = outcome.failure?.definitelyNotSaved ?? false;
    return {draft, view: withMessage({...view, blocked: !definitelyNotSaved}, scope,
      outcome.failure?.message ?? "The save outcome could not be confirmed. Refresh Supervisor status before trying again.", !definitelyNotSaved)};
  }
  const result = outcome.success;
  if (result.status === "saved") {
    if (result.snapshot) return {draft: canonicalDraft(input.projectId, result.snapshot),
      view: withMessage({...view, snapshot: result.snapshot, blocked: false}, scope, result.message, false)};
    return {
      draft: draft ? {...draft, modelValue: copySelection(input.modelSelection), modelBaseline: copySelection(input.modelSelection),
        monitoringValue: monitoringDraft(input.monitoring ?? defaultMonitoringSettings), monitoringBaseline: monitoringDraft(input.monitoring ?? defaultMonitoringSettings),
        teamSettingsValue: teamSettingsDraft(input.teamSettings ?? defaultSupervisorTeamSettings), teamSettingsBaseline: teamSettingsDraft(input.teamSettings ?? defaultSupervisorTeamSettings),
        agentThreadsValue: input.superviseAgentCreatedThreads ?? draft.agentThreadsBaseline, agentThreadsBaseline: input.superviseAgentCreatedThreads ?? draft.agentThreadsBaseline} : draft,
      view: withMessage({...view, blocked: true}, scope, `${result.message} Refresh Supervisor status before making another change.`, false),
    };
  }
  if (result.status === "uncertain") return {draft, view: withMessage({...view, blocked: true}, scope, result.message, true)};
  if (result.snapshot) return {
    draft: draft ? {...draft, modelBaseline: copySelection(result.snapshot.settings.modelSelection), monitoringBaseline: readMonitoringDraft(result.snapshot),
      teamSettingsBaseline: readTeamSettingsDraft(result.snapshot), agentThreadsBaseline: readAgentThreads(result.snapshot), expectedGeneration: result.snapshot.settings.generation} : draft,
    view: withMessage({...view, snapshot: result.snapshot, blocked: false}, scope, result.message, result.status === "invalid"),
  };
  return {draft, view: withMessage({...view, blocked: result.status === "conflict"}, scope,
    result.status === "conflict" ? `${result.message} Refresh Supervisor status before trying again.` : result.message, result.status === "invalid")};
};

/** The outcome of an explicit native access retry or replacement for its own scope (see {@link settleSave}). */
export const settleRetry = ({view, draft}: SettingsState, scope: string, input: ProjectSupervisorRetryInput, outcome: ChangeOutcome): SettingsState => {
  if (Result.isFailure(outcome)) {
    const definitelyNotSaved = outcome.failure?.definitelyNotSaved ?? false;
    return {draft, view: withMessage({...view, blocked: !definitelyNotSaved}, scope,
      outcome.failure?.message ?? "The native access retry outcome could not be confirmed. Refresh Supervisor status before trying again.", !definitelyNotSaved)};
  }
  const result = outcome.success;
  if (result.status === "uncertain") return {draft, view: withMessage({...view, blocked: true}, scope, result.message, true)};
  if (result.snapshot) return {draft: canonicalDraft(input.projectId, result.snapshot),
    view: withMessage({...view, snapshot: result.snapshot, blocked: false}, scope, result.message, result.status === "invalid")};
  const mustRefresh = result.status === "conflict" || result.status === "saved";
  return {draft, view: withMessage({...view, blocked: mustRefresh}, scope,
    mustRefresh ? `${result.message} Refresh Supervisor status before trying again.` : result.message, result.status === "invalid")};
};

type PanelMessage = {scope: string; text: string; alert: boolean};

/**
 * Applies a settled snapshot read to the panel: the snapshot is shown with its read time, the block after an unconfirmed
 * outcome is lifted and the draft merges the read (see {@link mergeLoadedDraft}); an explicit refresh reports whether an
 * unsaved draft was kept.
 */
export const settleRead = ({view, draft}: SettingsState, projectId: string, scope: string, read: {snapshot: ProjectSupervisorInfo; readAt: number},
  forced: boolean): SettingsState => {
  const merged = mergeLoadedDraft(draft, projectId, read.snapshot);
  return {draft: merged.draft, view: {...view, snapshot: read.snapshot, readAt: read.readAt, blocked: false, message: forced ? {scope, alert: false, text: merged.keptDirty
    ? "Supervisor status refreshed. Your unsaved draft was kept against the latest saved generation."
    : "Supervisor status refreshed from T3."} : view.message}};
};

/**
 * Whether the panel reads its scope now: never while a settings change is in flight, never automatically over a dirty draft
 * of the shown snapshot (only an explicit refresh moves the draft's expected generation), and once per scope revision.
 */
export const snapshotReadNeeded = (panel: {projectId: string; connected: boolean; saving: boolean; forceRefresh: boolean; dirty: boolean;
  shown: boolean; completedKey: string | null; requestKey: string}) =>
  Boolean(panel.projectId) && panel.connected && !panel.saving && (panel.forceRefresh || !(panel.dirty && panel.shown)) && panel.completedKey !== panel.requestKey;

/** The chat supervision refresh of the selected chat, or null while a settings or chat change is in flight or T3 is disconnected. */
export const chatRefreshScope = (view: ProjectSupervisorView, panel: {projectId: string; threadId: string | undefined; connected: boolean; epoch: number}) =>
  panel.connected && panel.threadId && !view.operation && !view.chat ? {projectId: panel.projectId, mainThreadId: panel.threadId, epoch: panel.epoch} : null;

/** a background read updates operational records while configured form baselines and mutation fences keep their owners. */
export const settleChatRefresh = (view: ProjectSupervisorView, scope: string, refreshed: ProjectSupervisorInfo): ProjectSupervisorView =>
  view.operation || view.chat || view.scope !== scope || view.snapshot?.projectId !== refreshed.projectId || view.snapshot.mainThreadId !== refreshed.mainThreadId
    ? view : {...view, snapshot: {...refreshed, settings: view.snapshot.settings, models: view.snapshot.models,
      modelSelection: view.snapshot.modelSelection, modelApplication: view.snapshot.modelApplication}};

// the panel state of one project that outlives the component: the shown snapshot and its read time, the outcome message of
// the last change for the scope it belongs to, the block after an unconfirmed outcome and the changes in flight
export type ProjectSupervisorView = {
  scope: string | null;
  snapshot: ProjectSupervisorInfo | null;
  readAt: number | null;
  message: PanelMessage | null;
  blocked: boolean;
  operation: {kind: "save" | "retry"; scope: string; operationId: string} | null;
  chat: {scope: string; operationId: string} | null;
  chatMessage: {scope: string; text: string} | null;
};
const idleView: ProjectSupervisorView = {scope: null, snapshot: null, readAt: null, message: null, blocked: false, operation: null, chat: null,
  chatMessage: null};

export const projectSupervisorKey = (environmentId: string | null, projectId: string) => scopeKey("project-supervisor", environmentId, projectId);
export const projectSupervisorView = Atom.family((_projectKey: string) => Atom.keepAlive(Atom.make(idleView)));
export const projectSupervisorDraft = draftFamily<Draft | null>(() => null);

// the confirmed discard of a project's Supervisor drafts: the settings draft is dropped, so the panel takes the saved
// settings from its next read, and the setup checkout choice is cleared
export const discardSupervisorDrafts = (registry: AtomRegistry.AtomRegistry, environmentId: string | null, projectId: string) => {
  registry.set(projectSupervisorDraft(projectSupervisorKey(environmentId, projectId)), null);
  registry.set(supervisionSetupSelection(supervisionControlKey(environmentId, projectId)), "");
};

type SnapshotScope = {readonly environmentId: string | null; readonly projectId: string; readonly mainThreadId: string | null; readonly revision: number; readonly epoch: number};

// one snapshot read per scope; a scope change or unmount interrupts it, and a refresh is a new scope revision
export const projectSupervisorRead = Atom.family((scope: SnapshotScope) => uiRuntime.atom(Effect.gen(function* () {
  const snapshot = yield* loadProjectSupervisor(scope.projectId, scope.mainThreadId);
  return {snapshot, readAt: yield* Clock.currentTimeMillis};
})));

type ChatRefreshScope = {readonly environmentId: string | null; readonly projectId: string; readonly mainThreadId: string; readonly epoch: number};

// the selected chat's saved supervision state; the first evaluation reads nothing because the snapshot read has just read it,
// every refresh reads it again
export const chatSupervisionRead = Atom.family((scope: ChatRefreshScope) => uiRuntime.atom((get) => {
  const previous = get.self<AsyncResult.AsyncResult<Option.Option<ProjectSupervisorInfo>>>();
  return Option.isNone(previous) || AsyncResult.isInitial(previous.value)
    ? Effect.succeed(Option.none<ProjectSupervisorInfo>())
    : Effect.map(loadProjectSupervisor(scope.projectId, scope.mainThreadId), Option.some);
}));

// the chat supervision read refreshed by matching committed changes
export const chatSupervisionLive = Atom.family((scope: ChatRefreshScope) => chatSupervisionRead(scope).pipe(refreshOnDashboardChange(`project:${scope.projectId}`)));

type ProgressScope = {
  readonly environmentId: string | null;
  readonly projectId: string;
  readonly mainThreadId: string;
  readonly bindingThreadId: string | null;
  readonly bindingGeneration: number | null;
  readonly epoch: number;
};
export type WorkflowProgressPages = {readonly pages: readonly WorkflowProgressSnapshot[]; readonly error: string | null; readonly more: number};
type ProgressPage = {workflowOffset: number; lineageOffset: number};

// the next page asked for by "Load more" in one progress scope, numbered so a refresh can tell it was already appended
export const workflowProgressMore = Atom.family((_scope: ProgressScope) => Atom.make<{seq: number; page: ProgressPage | null}>({seq: 0, page: null}));

/**
 * Live progress of one main conversation and Supervisor binding. The first read loads the first page, "Load more" appends
 * the next page, and every refresh re-reads the loaded pages one after another; a failed or incomplete refresh keeps the
 * pages already shown with the reason.
 */
export const workflowProgressRead = Atom.family((scope: ProgressScope) => uiRuntime.atom((get) => {
  const more = get(workflowProgressMore(scope));
  const previous = Option.flatMap(get.self<AsyncResult.AsyncResult<WorkflowProgressPages>>(), AsyncResult.value);
  const expectedBinding = scope.bindingThreadId !== null && scope.bindingGeneration !== null
    ? {expectedBinding: {threadId: scope.bindingThreadId, generation: scope.bindingGeneration}} : {};
  if (Option.isSome(previous) && more.page && more.seq !== previous.value.more) {
    const current = previous.value;
    return loadWorkflowProgress(scope.projectId, scope.mainThreadId, {...more.page, ...expectedBinding}).pipe(Effect.match({
      onSuccess: (result): WorkflowProgressPages => ({pages: [...current.pages, result], error: result.status === "ok" ? null : result.message, more: more.seq}),
      onFailure: (): WorkflowProgressPages => ({...current, error: "The next progress page could not be loaded. The last successful snapshot is retained.", more: more.seq}),
    }));
  }
  const loaded = Option.isSome(previous) ? previous.value.pages : [];
  const requests = (loaded.length > 0 ? loaded.map(page => ({workflowOffset: page.workflowOffset, lineageOffset: page.lineageOffset})) : [{workflowOffset: 0, lineageOffset: 0}])
    .map(page => ({...page, ...expectedBinding}));
  return refreshWorkflowProgressPages(scope.projectId, scope.mainThreadId, requests).pipe(Effect.match({
    onSuccess: (pages): WorkflowProgressPages => {
      const failed = pages.find(page => page.status !== "ok");
      return Option.isSome(previous) && previous.value.pages.length > 0 && failed
        ? {...previous.value, error: failed.message ?? "Progress could not be refreshed.", more: more.seq}
        : {pages, error: failed?.message ?? null, more: more.seq};
    },
    onFailure: (): WorkflowProgressPages => Option.isSome(previous)
      ? {...previous.value, error: "Progress could not be refreshed. The last successful snapshot is retained.", more: more.seq}
      : {pages: [], error: "Progress could not be loaded for this main conversation.", more: more.seq},
  }));
}));

// the progress read refreshed by matching committed changes; the panel mounts it only while no read is running
export const workflowProgressLive = Atom.family((scope: ProgressScope) => workflowProgressRead(scope).pipe(refreshOnDashboardChange(`progress:${scope.projectId}:${scope.mainThreadId}`)));

const idleAtom = Atom.make(AsyncResult.initial<never>());

// the admitted requests; each user action is one operation that is sent once and never replayed
const saveRequest = admittedMutation((input: ProjectSupervisorSaveInput) => Effect.result(saveProjectSupervisor(input)));
const retryRequest = admittedMutation((input: ProjectSupervisorRetryInput) => Effect.result(retryProjectSupervisor(input)));
const chatRequest = admittedMutation((input: ProjectSupervisorChatSupervisionInput) => Effect.result(setChatSupervision(input)));

type SettingsChange<I> = {projectKey: string; key: MutationKey; input: I};

// awaits an admitted change and applies its outcome to the project's draft and view, mounted or not; an outcome is shown
// only while its own [project, chat] scope is still selected and is applied once
const settleChange = <I,>(
  request: (key: MutationKey) => Atom.Writable<MutationResult<Result.Result<ProjectSupervisorSaveOutcome, ProjectSupervisorRequestError>>, I>,
  settle: (state: SettingsState, scope: string, input: I, outcome: ChangeOutcome) => SettingsState,
) => Atom.family((_key: string) => Atom.keepAlive(uiRuntime.fn((change: SettingsChange<I>, get) => Effect.gen(function* () {
  const registry = get.registry;
  const outcome: ChangeOutcome = yield* admit(registry, request(change.key), change.input).pipe(
    Effect.catch(() => Effect.succeed(Result.fail(undefined))));
  const viewAtom = projectSupervisorView(change.projectKey);
  const view = registry.get(viewAtom);
  if (view.operation?.operationId !== change.key.operationId || view.operation.scope !== change.key.scope) return;
  if (view.scope !== change.key.scope) return registry.set(viewAtom, {...view, operation: null});
  const draftAtom = projectSupervisorDraft(change.projectKey);
  const next = settle({view: {...view, operation: null}, draft: registry.get(draftAtom)}, change.key.scope, change.input, outcome);
  registry.set(draftAtom, next.draft);
  registry.set(viewAtom, next.view);
}), {concurrent: true})));

export const saveSupervisorSettings = settleChange(saveRequest, settleSave);
export const retrySupervisorAccess = settleChange(retryRequest, settleRetry);

// the read that confirms a chat supervision change without its own snapshot; after 10 s the change is reported as unconfirmed
export const chatSupervisionConfirmRead = (projectId: string, mainThreadId: string) =>
  loadProjectSupervisor(projectId, mainThreadId).pipe(Effect.timeout("10 seconds"));

/**
 * One explicit Stop supervision / Enable supervision change for the exact [project, chat] that started it: the change is
 * admitted once, confirmed by its own snapshot or by a follow-up read within 10 s, and shown only while that chat is still
 * selected.
 */
export const changeChatSupervision = Atom.family((_key: string) => Atom.keepAlive(uiRuntime.fn((change: SettingsChange<ProjectSupervisorChatSupervisionInput>, get) =>
  Effect.gen(function* () {
    const registry = get.registry;
    const viewAtom = projectSupervisorView(change.projectKey);
    const outcome = yield* confirmChatSupervisionChange(
      admit(registry, chatRequest(change.key), change.input).pipe(Effect.flatMap(result => Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure))),
      chatSupervisionConfirmRead(change.input.projectId, change.input.mainThreadId),
      () => registry.get(viewAtom).scope === change.key.scope);
    registry.update(viewAtom, view => view.chat?.operationId !== change.key.operationId ? view : {...view, chat: null,
      ...(outcome ? {chatMessage: {scope: change.key.scope, text: outcome.message}, snapshot: outcome.snapshot ?? view.snapshot} : {})});
  }), {concurrent: true})));

// admits one settings save or native access retry for the selected scope unless a change is already in flight; the change
// atom applies its outcome even after the panel unmounts
export const startSettingsChange = (registry: AtomRegistry.AtomRegistry, projectKey: string, scope: string,
  change: {kind: "save"; input: ProjectSupervisorSaveInput} | {kind: "retry"; input: ProjectSupervisorRetryInput}) => {
  const viewAtom = projectSupervisorView(projectKey);
  const current = registry.get(viewAtom);
  if (current.operation) return;
  const key = {scope, operationId: crypto.randomUUID()};
  registry.set(viewAtom, {...current, operation: {kind: change.kind, ...key}, message: null});
  if (change.kind === "save") registry.set(saveSupervisorSettings(scopeKey(key.scope, key.operationId)), {projectKey, key, input: change.input});
  else registry.set(retrySupervisorAccess(scopeKey(key.scope, key.operationId)), {projectKey, key, input: change.input});
};

// admits one per-chat supervision change for the selected scope unless one is already in flight in the project
export const startChatSupervisionChange = (registry: AtomRegistry.AtomRegistry, projectKey: string, scope: string, input: ProjectSupervisorChatSupervisionInput) => {
  const viewAtom = projectSupervisorView(projectKey);
  const current = registry.get(viewAtom);
  if (current.chat) return;
  const key = {scope, operationId: crypto.randomUUID()};
  registry.set(viewAtom, {...current, chat: key, chatMessage: null});
  registry.set(changeChatSupervision(scopeKey(key.scope, key.operationId)), {projectKey, key, input});
};

export function ProjectSupervisorPanel({projectId, threadId, section = "all", attentionEnabled = true, connected, onDirtyChange, onSavingChange, supervisionLink, connectedWorkLink}: {
  projectId: string;
  threadId?: string;
  section?: ConversationSection;
  attentionEnabled?: boolean;
  supervisionLink?: React.ReactNode;
  connectedWorkLink?: React.ReactNode;
  connected: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const registry = useContext(RegistryContext);
  const environmentId = useAtomValue(environmentAtom);
  const projectKey = projectSupervisorKey(environmentId, projectId);
  const mainThreadId = threadId || null;
  const scope = scopeKey(environmentId, projectId, mainThreadId);
  const epoch = useAtomValue(authEpochAtom, result => Option.getOrElse(AsyncResult.value(result), () => 0));
  const [view, setView] = useAtom(projectSupervisorView(projectKey));
  const [activeDraft, setDraft] = useAtom(projectSupervisorDraft(projectKey));
  const [revision, setRevision] = useState(0);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [completedRead, setCompletedRead] = useState<{key: string; failed: boolean} | null>(null);
  const [controlActivity, setControlActivity] = useState(idleControlActivity);

  const activeSnapshot = view.snapshot?.projectId === projectId && view.snapshot.mainThreadId === mainThreadId ? view.snapshot : null;
  const saving = view.operation !== null;
  const blocked = view.blocked;
  const modelDirty = Boolean(activeDraft && selectionKey(activeDraft.modelValue) !== selectionKey(activeDraft.modelBaseline));
  const monitoringDirty = Boolean(activeDraft && !sameMonitoring(activeDraft.monitoringValue, activeDraft.monitoringBaseline));
  const teamSettingsDirty = Boolean(activeDraft && !sameTeamSettings(activeDraft.teamSettingsValue, activeDraft.teamSettingsBaseline));
  const agentThreadsDirty = Boolean(activeDraft && activeDraft.agentThreadsValue !== activeDraft.agentThreadsBaseline);
  const dirty = modelDirty || monitoringDirty || teamSettingsDirty || agentThreadsDirty;

  // no read while saving, and no automatic read over a dirty draft of the shown snapshot: only an explicit refresh moves
  // the draft's expected generation; each scope revision is read once
  const requestKey = scopeKey(environmentId, projectId, mainThreadId, revision, epoch);
  const readNeeded = snapshotReadNeeded({projectId, connected, saving, forceRefresh, dirty, shown: activeSnapshot !== null, completedKey: completedRead?.key ?? null, requestKey});
  const read = useAtomValue(readNeeded ? projectSupervisorRead({environmentId, projectId, mainThreadId, revision, epoch}) : idleAtom);
  const isLoading = readNeeded;
  const loadError = completedRead?.key === requestKey && completedRead.failed;
  const fieldsBusy = saving || isLoading;
  const selectedModel = activeSnapshot && activeDraft ? findModel(activeSnapshot, activeDraft.modelValue) : undefined;
  const validMonitoring = activeDraft ? parseMonitoringDraft(activeDraft.monitoringValue) : null;
  const validTeamSettings = activeDraft ? parseTeamSettingsDraft(activeDraft.teamSettingsValue) : null;
  const canSave = Boolean(activeSnapshot?.available && activeDraft && dirty && validMonitoring && validTeamSettings && (!modelDirty || selectedModel?.available) && connected && !fieldsBusy && !blocked);
  const needsRetry = Boolean(activeSnapshot && shouldOfferNativeRetry(activeSnapshot));
  const retryButtonLabel = activeSnapshot?.binding?.state === "missing" ? "Replace deleted Supervisor conversation" : "Retry native access";
  const canRetry = Boolean(needsRetry && activeSnapshot?.available && activeSnapshot.binding && activeDraft && !dirty && connected && !fieldsBusy && !blocked);

  // the selected [project, chat] decides which outcomes are applied and shown; a new selection clears the last message
  useEffect(() => {setView(current => current.scope === scope ? current : {...current, scope, message: null, readAt: null});}, [scope, setView]);
  useEffect(() => {onDirtyChange?.(dirty || controlActivity.dirty);}, [dirty, controlActivity.dirty, onDirtyChange]);
  useEffect(() => {onSavingChange?.(saving || controlActivity.busy || controlActivity.uncertain);}, [saving, controlActivity.busy, controlActivity.uncertain, onSavingChange]);

  // a read applies once, when it settles; a failed read keeps the shown snapshot
  useEffect(() => {
    if (!readNeeded) return;
    if (AsyncResult.isFailure(read)) {
      setCompletedRead({key: requestKey, failed: true});
      setForceRefresh(false);
      return;
    }
    if (!AsyncResult.isSuccess(read) || read.waiting) return;
    const next = settleRead({view: registry.get(projectSupervisorView(projectKey)), draft: registry.get(projectSupervisorDraft(projectKey))}, projectId, scope,
      read.value, forceRefresh);
    setDraft(next.draft);
    setView(next.view);
    setCompletedRead({key: requestKey, failed: false});
    setForceRefresh(false);
  }, [read]);

  // operational refresh is not mounted while a change is in flight; form drafts keep their pinned baselines
  const refreshScope = chatRefreshScope(view, {projectId, threadId, connected, epoch});
  const refreshed = useAtomValue(refreshScope ? chatSupervisionLive({...refreshScope, environmentId}) : idleAtom);
  const refreshedSnapshot = AsyncResult.isSuccess(refreshed) && !refreshed.waiting ? Option.getOrNull(refreshed.value) : null;
  useEffect(() => {
    if (refreshedSnapshot) setView(current => settleChatRefresh(current, scope, refreshedSnapshot));
  }, [refreshedSnapshot]);

  const progressMain = projectId && connected ? activeSnapshot?.mainThreadId ?? null : null;
  const progressScope: ProgressScope | null = progressMain ? {environmentId, projectId, mainThreadId: progressMain, bindingThreadId: activeSnapshot?.binding?.threadId ?? null,
    bindingGeneration: activeSnapshot?.binding?.generation ?? null, epoch} : null;
  const progress = useAtomValue(progressScope ? workflowProgressRead(progressScope) : idleAtom);
  const progressPages = Option.getOrNull(AsyncResult.value(progress));
  const progressLoading = progressScope !== null && (AsyncResult.isInitial(progress) || progress.waiting);
  useAtomMount(progressScope && !progressLoading ? workflowProgressLive(progressScope) : idleAtom);
  const workflowProgressKey = scopeKey(environmentId, projectId, activeSnapshot?.mainThreadId ?? mainThreadId, activeSnapshot?.binding?.threadId ?? null, activeSnapshot?.binding?.generation ?? null);
  const workflowProgressState: WorkflowProgressPanelState = {key: workflowProgressKey, pages: progressScope ? [...progressPages?.pages ?? []] : [],
    loading: progressLoading, error: progressScope ? progressPages?.error ?? null : null};

  const refresh = () => {
    if (!projectId || !connected || saving || isLoading) return;
    setForceRefresh(true);
    setRevision(value => value + 1);
  };

  const refreshWorkflowProgress = () => {
    if (!progressScope || progressLoading) return;
    registry.refresh(workflowProgressRead(progressScope));
  };

  const loadMoreWorkflowProgress = () => {
    const latest = progressPages?.pages.at(-1);
    if (!progressScope || !latest || progressLoading || (!latest.workflowHasMore && !latest.lineageHasMore)) return;
    const page = {
      workflowOffset: latest.workflowHasMore ? latest.workflowOffset + latest.workflows.length : latest.workflowOffset,
      lineageOffset: latest.lineageHasMore ? latest.lineageOffset + (latest.scope?.threads.length ?? 0) : latest.lineageOffset,
    };
    if (page.workflowOffset === latest.workflowOffset && page.lineageOffset === latest.lineageOffset) return;
    registry.update(workflowProgressMore(progressScope), current => ({seq: current.seq + 1, page}));
  };

  const editDraft = (edit: (draft: Draft) => Draft) => {
    setDraft(current => current ? edit(current) : current);
    setView(current => ({...current, message: null}));
  };
  const updateSelection = (selection: SupervisorModelSelection) => editDraft(current => ({...current, modelValue: copySelection(selection)}));
  const updateMonitoring = (monitoring: MonitoringDraft) => editDraft(current => ({...current, monitoringValue: copyMonitoringDraft(monitoring)}));
  const updateTeamSettings = (settings: TeamSettingsDraft) => editDraft(current => ({...current, teamSettingsValue: copyTeamSettingsDraft(settings)}));
  const updateAgentThreads = (enabled: boolean) => editDraft(current => ({...current, agentThreadsValue: enabled}));
  const discardDraft = () => {
    if (saving || blocked) return;
    editDraft(current => ({...current, modelValue: copySelection(current.modelBaseline), monitoringValue: copyMonitoringDraft(current.monitoringBaseline),
      teamSettingsValue: copyTeamSettingsDraft(current.teamSettingsBaseline), agentThreadsValue: current.agentThreadsBaseline}));
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !canSave || !activeDraft || !activeSnapshot || !validMonitoring || !validTeamSettings) return;
    startSettingsChange(registry, projectKey, scope, {kind: "save", input: {
      projectId,
      ...(threadId ? {mainThreadId: threadId} : {}),
      expectedGeneration: activeDraft.expectedGeneration,
      modelSelection: copySelection(activeDraft.modelValue),
      monitoring: copyMonitoringSettings(validMonitoring),
      teamSettings: {...validTeamSettings},
      superviseAgentCreatedThreads: activeDraft.agentThreadsValue,
    }});
  };

  const retryNativeAccess = () => {
    const binding = activeSnapshot?.binding;
    if (saving || !canRetry || !activeDraft || !binding) return;
    startSettingsChange(registry, projectKey, scope, {kind: "retry", input: {
      projectId,
      mainThreadId: binding.mainThreadId,
      expectedGeneration: activeDraft.expectedGeneration,
      threadId: binding.threadId,
      bindingGeneration: binding.generation,
      action: binding.state === "missing" ? "replace" : "retry",
    }});
  };

  // one explicit per-chat change at a time in this project; the server-confirmed snapshot is shown afterwards, including
  // after conflicts, but only while the same project and chat are still selected
  const changeChat = (enabled: boolean) => {
    if (!projectId || !activeSnapshot?.mainThreadId || !activeSnapshot.chatSupervision) return;
    startChatSupervisionChange(registry, projectKey, scope, {projectId, mainThreadId: activeSnapshot.mainThreadId, enabled,
      policyGeneration: activeSnapshot.chatSupervision.policyGeneration});
  };

  const visibleMessage = view.message?.scope === scope ? view.message : null;

  return <section className="stack project-supervisor" aria-labelledby="project-supervisor-title">
    <h2 id="project-supervisor-title" className="sr-only">Project Supervisor</h2>
    <div hidden={section !== "all" && section !== "settings"}>{projectId && (activeSnapshot?.noProjectMode ? <p className="panel">No Project mode: <strong>{activeSnapshot.noProjectMode.replaceAll("_", " ")}</strong>. Change this in Instance settings. Shared definitions supply policy independently.</p> : <SupervisionControlPanel key={projectId} projectId={projectId} active={section === "settings" || section === "all"} onStateChange={setControlActivity} />)}</div>
    {!projectId && <p className="panel muted">Select a project to manage its Supervisor settings.</p>}
    {projectId && !connected && <p className="panel" role="status">T3 is disconnected. Any unsaved Supervisor settings draft is kept.</p>}
    {projectId && connected && !activeSnapshot && isLoading && <p className="panel" role="status">Loading Supervisor status…</p>}
    {projectId && connected && loadError && <p className="panel" role="alert">{activeSnapshot ? "Could not refresh Supervisor state. The previous snapshot remains visible." : "Could not load Supervisor state. No snapshot is available."} <button type="button" onClick={refresh}>Retry Supervisor read</button></p>}
    {projectId && activeSnapshot && activeDraft && <ProjectSupervisorView
      section={section}
      attentionEnabled={attentionEnabled}
      snapshot={activeSnapshot}
      currentRead={!loadError && !AsyncResult.isFailure(refreshed)}
      selection={activeDraft.modelValue}
      monitoring={activeDraft.monitoringValue}
      teamSettings={activeDraft.teamSettingsValue}
      agentThreads={activeDraft.agentThreadsValue}
      {...(threadId === undefined ? {} : {threadId})}
      connected={connected}
      saving={saving}
      fieldsBusy={fieldsBusy}
      blocked={blocked}
      dirty={dirty}
      canSave={canSave}
      shouldOfferRetry={needsRetry}
      retryButtonLabel={retryButtonLabel}
      canRetry={canRetry}
      workflowProgress={workflowProgressState}
      readAt={view.readAt}
      refreshing={isLoading || workflowProgressState.loading}
      onRefresh={() => { refresh(); refreshWorkflowProgress(); }}
      {...(supervisionLink ? {supervisionLink} : {})} {...(connectedWorkLink ? {connectedWorkLink} : {})}
      onWorkflowProgressLoadMore={loadMoreWorkflowProgress}
      onSelectionChange={updateSelection}
      onMonitoringChange={updateMonitoring}
      onTeamSettingsChange={updateTeamSettings}
      onAgentThreadsChange={updateAgentThreads}
      onDiscard={discardDraft}
      onRetry={retryNativeAccess}
      chatSupervisionBusy={view.chat?.scope === scope}
      chatSupervisionLocked={view.chat !== null}
      chatSupervisionMessage={view.chatMessage?.scope === scope ? view.chatMessage.text : null}
      onChatSupervision={changeChat}
      onSubmit={save}
    />}
    {projectId && connected && activeSnapshot && !activeDraft && isLoading && <p className="panel" role="status">Loading the selected project’s Supervisor status…</p>}
    {projectId && connected && !activeSnapshot && !isLoading && !loadError && <p className="panel muted">Supervisor status is not loaded yet.</p>}
    {visibleMessage && <p role={visibleMessage.alert ? "alert" : "status"}>{visibleMessage.text}</p>}
  </section>;
}
