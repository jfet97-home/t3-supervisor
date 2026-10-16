import React, { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  ProjectSupervisorInfo,
  ProjectSupervisorTeamInfo,
  DefinitionReviewInfo,
  SupervisorModelInfo,
  SupervisorModelSelection,
  SupervisorMonitoringSettings,
  SupervisorTeamSettingsInfo,
  WorkflowAgreementInfo,
  WorkflowPlanNodeInfo,
  WorkflowProposalInfo,
} from "../../src/project-supervisor-contract.js";
import type { WorkflowProgressCoverage, WorkflowProgressSnapshot, WorkflowProgressWorkflow } from "../../src/workflow-progress.js";
import { defaultMonitoringSettings, defaultSupervisorTeamSettings } from "../../src/project-supervisor-contract.js";
import { loadProjectSupervisor, loadWorkflowProgress, ProjectSupervisorRequestError, refreshWorkflowProgressPages, retryProjectSupervisor, saveProjectSupervisor } from "./project-supervisor-api.js";
import { SupervisionControlPanel } from "./supervisor-control.js";

type MonitoringDraft = {
  intervalMinutes: string;
  activityThreshold: string;
};
type TeamSettingsDraft = {maxHelpersPerRoot: string};

type Draft = {
  projectId: string;
  modelValue: SupervisorModelSelection;
  modelBaseline: SupervisorModelSelection;
  monitoringValue: MonitoringDraft;
  monitoringBaseline: MonitoringDraft;
  teamSettingsValue: TeamSettingsDraft;
  teamSettingsBaseline: TeamSettingsDraft;
  expectedGeneration: number;
};
type Drafts = Record<string, Draft>;

type SnapshotState = {projectId: string; snapshot: ProjectSupervisorInfo};
type LoadState = {key: string; status: "idle" | "loading" | "error"};
type PanelMessage = {projectId: string; text: string; alert: boolean} | null;
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
const formatMonitoringTime = (value: number | null) => value === null ? "Not scheduled" : new Date(value).toLocaleString();
const monitoringError = (value: string, minimum: number, maximum: number, field: string) => {
  if (!value.trim()) return `Enter ${field} from ${minimum} to ${maximum}.`;
  const number = Number(value);
  if (!Number.isInteger(number)) return `Enter a whole number for ${field}.`;
  if (number < minimum || number > maximum) return `Enter ${field} from ${minimum} to ${maximum}.`;
  return "";
};
const parseMonitoringDraft = (value: MonitoringDraft): SupervisorMonitoringSettings | null => {
  if (monitoringError(value.intervalMinutes, 1, 60, "maximum pending activity age in minutes") ||
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

const proposalStatusText: Record<WorkflowProposalInfo["status"], string> = {
  pending: "Being prepared",
  proposed: "Proposed for discussion",
  provisional: "Provisional plan with open issues",
  unavailable: "Unavailable",
  stale: "Source changed; review needed",
  invalid: "Invalid proposal",
};

const proposalStatusDescription: Record<WorkflowProposalInfo["status"], string> = {
  pending: "The plan is still being prepared; no agreement is recorded for it.",
  proposed: "This is a draft for dialogue. No agreement is recorded for this proposal.",
  provisional: "A finite working plan is available while unresolved requirements or definition issues remain visible.",
  unavailable: "A usable plan could not be prepared from the available definitions.",
  stale: "The source revision changed. Review the definitions and negotiate the plan again.",
  invalid: "The proposal could not be accepted as a valid plan.",
};

const definitionStatusText: Record<WorkflowProposalInfo["definitionsStatus"], string> = {
  ready: "Valid",
  missing: "Missing in the selected scope",
  invalid: "Needs attention",
  permission_required: "File access needs setup",
  unavailable: "Unavailable",
};

const requirementStateText: Record<WorkflowProposalInfo["requirements"][number]["state"], string> = {
  included: "Included in the plan",
  not_applicable: "Not applicable",
  unresolved: "Unresolved",
  unknown: "Unknown",
};

const planStatusText = {
  planned: "Planned",
  underway: "Reported underway",
  completed: "Reported complete",
  needs_attention: "Needs attention",
} as const;

function WorkflowSource({source, templatePath}: {source: WorkflowProposalInfo["requirements"][number]["source"]; templatePath?: string | null}) {
  if (!source && !templatePath) return null;
  return <p className="small muted">Source: {source?.origin ?? "not recorded"}{source?.path && <> · <code>{source.path}</code></>}{templatePath && <> · template <code>{templatePath}</code></>}</p>;
}

function WorkflowPlanNode({node, liveAssessment = false}: {node: WorkflowPlanNodeInfo; liveAssessment?: boolean}) {
  if ("nodes" in node) {
    const List = node.kind === "sequence" ? "ol" : "ul";
    return <div className="stack workflow-plan-group">
      <p><strong>{node.kind === "sequence" ? "Sequence" : "Parallel group"}</strong> <span className="muted">{node.kind === "sequence" ? "— intended semantic order" : "— members have no declared order"}</span></p>
      {node.templatePath && <p className="small muted">Template group: <code>{node.templatePath}</code></p>}
      <List className="stack workflow-plan-nodes">{node.nodes.map((child, index) => <li key={"nodeId" in child ? child.nodeId : `group:${child.kind}:${index}`}><WorkflowPlanNode node={child} liveAssessment={liveAssessment}/></li>)}</List>
    </div>;
  }
  if (node.kind === "step") return <article className="stack workflow-plan-node">
    <p><strong>Step: {node.name}</strong></p>
    {node.definitionId && <p className="small">Reusable step ID: <code>{node.definitionId}</code></p>}
    {node.localId && <p className="small">Task-local step ID: <code>{node.localId}</code></p>}
    <WorkflowSource source={node.source} templatePath={node.templatePath}/>
    <p>{node.description}</p>
    <p><strong>Plan status:</strong> {liveAssessment ? node.status === "underway" ? "Underway" : node.status === "completed" ? "Completed" : planStatusText[node.status] : planStatusText[node.status]} · <strong>Definition:</strong> {node.resolution === "resolved" ? "Resolved" : "Unresolved"}</p>
    <p>{node.reason}</p>
    {node.contributorThreadIds.length > 0 && <div><strong>Contributors</strong><ul>{node.contributorThreadIds.map(threadId => <li key={threadId}><a href={`t3-thread://v1/${threadId}`}>Child conversation <code>{threadId}</code></a></li>)}</ul></div>}
  </article>;
  if (node.kind !== "workflow") return null;
  return <article className="stack workflow-plan-node">
    <p><strong>Workflow: {node.name}</strong> <span className="muted">({node.definitionId})</span></p>
    <WorkflowSource source={node.source} templatePath={node.templatePath}/>
    <p>{node.description}</p>
    <p><strong>Resolution:</strong> {node.resolution} · <strong>Plan status:</strong> {liveAssessment ? node.status === "underway" ? "Underway" : node.status === "completed" ? "Completed" : planStatusText[node.status] : planStatusText[node.status]} · <strong>Fixed:</strong> {node.fixed === null ? "Unknown" : node.fixed ? "Yes" : "No"}</p>
    <p>{node.reason}</p>
    {node.omissions.length > 0 && <div className="stack">
      <strong>Not-applicable original commitments</strong>
      <ul className="stack">{node.omissions.map((omission, index) => <li key={`${omission.templatePath}:${omission.kind}:${omission.id}:${index}`}>
        <p><strong>{omission.kind}:</strong> {omission.name} <span className="muted">({omission.id})</span></p>
        <WorkflowSource source={omission.source} templatePath={omission.templatePath}/>
        <p>{omission.reason}</p>
      </li>)}</ul>
    </div>}
    {node.plan && <WorkflowPlanNode node={node.plan} liveAssessment={liveAssessment}/>}
    {!node.plan && node.resolution !== "resolved" && <p className="muted">The referenced workflow could not be expanded completely.</p>}
    {node.contributorThreadIds.length > 0 && <div><strong>Contributors</strong><ul>{node.contributorThreadIds.map(threadId => <li key={threadId}><a href={`t3-thread://v1/${threadId}`}>Child conversation <code>{threadId}</code></a></li>)}</ul></div>}
  </article>;
}

function WorkflowProposalDetails({workflow, title}: {workflow: WorkflowProposalInfo; title: string}) {
  const requirementsMayBeEmpty = workflow.requirementsKnown && workflow.definitionsComplete && workflow.definitionsStatus === "ready";
  return <div className="stack">
    <div className="stack">
      <h6>Definition status</h6>
      <p><strong>Collection:</strong> {definitionStatusText[workflow.definitionsStatus]} · <strong>Read complete:</strong> {workflow.definitionsComplete ? "Yes" : "No"}</p>
      <p><strong>Requirements known:</strong> {workflow.requirementsKnown ? "Yes" : "No"}</p>
      <p><strong>Workspace root:</strong> {workflow.workspaceRoot === null ? "Not recorded" : <code>{workflow.workspaceRoot}</code>}</p>
      <p><strong>Definition revision:</strong> {workflow.revision === null ? "Not recorded" : <code>{workflow.revision}</code>}</p>
    </div>
    {workflow.issues.length > 0 && <div className="stack">
      <h6>Definition issues</h6>
      <ul className="definition-issues">{workflow.issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`}><code>{issue.path}</code><p>{issue.message}</p></li>)}</ul>
    </div>}
    <div className="stack">
      <h6>Required definitions</h6>
      {workflow.requirements.length > 0
        ? <ol className="stack">{workflow.requirements.map((requirement, index) => <li key={`${requirement.kind}:${requirement.id}:${index}`}>
          <p><strong>{requirement.kind === "step" ? "Step" : "Workflow"}:</strong> {requirement.name} <span className="muted">({requirement.id})</span></p>
          <p><strong>Plan accounting:</strong> {requirementStateText[requirement.state]}</p>
          <WorkflowSource source={requirement.source}/>
          <p>{requirement.reason}</p>
        </li>)}</ol>
        : <p className="muted">{requirementsMayBeEmpty ? "No required definitions are configured." : "No requirement entries are available. Requirements may be unknown because the definitions are missing, invalid or incompletely read."}</p>}
    </div>
    <div className="stack">
      <h6>{title}</h6>
      {workflow.plan
        ? <WorkflowPlanNode node={workflow.plan}/>
        : <p className="muted">No plan structure is available for this proposal.</p>}
      <p className="muted">Reported plan status is not independent execution evidence. A template reference or agreement does not prove that work was performed.</p>
    </div>
  </div>;
}

function WorkflowAgreementView({agreement}: {agreement: WorkflowAgreementInfo}) {
  const agreedAt = formatWorkflowAgreementTime(agreement.agreedAt);
  const stale = agreement.status === "stale";

  return <section className="stack">
    <h5>{stale ? "Previous agreement (stale)" : "Agreed workflow"}</h5>
    <p><strong>Agreement status:</strong> {stale ? "Stale" : "Agreed"}</p>
    <p>{agreement.message}</p>
    {stale
      ? <p className="muted">This agreement is retained as history and is not the current agreed workflow.</p>
      : <p className="muted">Agreement records an accepted plan; it does not verify that any steps were completed.</p>}
    <WorkflowProposalDetails workflow={agreement.workflow} title={stale ? "Plan in this historical agreement" : "Agreed plan"}/>
    <details className="stack">
      <summary>{stale ? "Historical agreement details" : "Agreement details"}</summary>
      <p><strong>Proposal ID:</strong> <code>{agreement.proposalId}</code></p>
      <p><strong>Agreed at:</strong> {agreedAt
        ? <time dateTime={agreedAt.toISOString()}>{agreedAt.toLocaleString()}</time>
        : "Unknown"}</p>
      <p><strong>Workspace root:</strong> {agreement.workflow.workspaceRoot === null ? "Not recorded" : <code>{agreement.workflow.workspaceRoot}</code>}</p>
      <p><strong>Definition revision:</strong> {agreement.workflow.revision === null ? "Not recorded" : <code>{agreement.workflow.revision}</code>}</p>
      <p><strong>Supervisor message ID:</strong> <code>{agreement.supervisorMessageId}</code></p>
      <p><strong>Agent message ID:</strong> <code>{agreement.agentMessageId}</code></p>
    </details>
  </section>;
}

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
    {outcome && <details className="stack">
      <summary>Definition review details</summary>
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
    </details>}
  </section>;
}

function WorkflowProposalView({workflow, proposalId, agreement, definitionReview}: {
  workflow: WorkflowProposalInfo | null | undefined;
  proposalId: string | undefined;
  agreement: WorkflowAgreementInfo | null | undefined;
  definitionReview: DefinitionReviewInfo | null | undefined;
}) {
  const hasAgreement = agreement != null;
  const sameAsActiveAgreement = agreement?.status === "agreed" && proposalId !== undefined && proposalId === agreement.proposalId;
  const noWorkflowRecord = workflow == null && agreement == null;

  return <section className="stack" aria-labelledby="workflow-proposal-title">
    <h4 id="workflow-proposal-title">Workflow proposal</h4>
    {definitionReview != null && <DefinitionReviewView review={definitionReview} />}
    {noWorkflowRecord && <p className="muted">No workflow proposal was recorded for this task.</p>}
    {hasAgreement && <WorkflowAgreementView agreement={agreement} />}
    {workflow != null && !sameAsActiveAgreement && <section className="stack">
      <h5>Current workflow draft</h5>
      <p><strong>Proposal status:</strong> {proposalStatusText[workflow.status]}</p>
      {proposalId && <p><strong>Proposal ID:</strong> <code>{proposalId}</code></p>}
      <p>{workflow.message}</p>
      <p className="muted">{proposalStatusDescription[workflow.status]}</p>
      <WorkflowProposalDetails workflow={workflow} title="Current plan"/>
    </section>}
    {workflow == null && agreement?.status === "stale" && <p className="muted">No current workflow draft is recorded for this task.</p>}
    {sameAsActiveAgreement && <p className="muted">The latest proposal is the agreed workflow shown above.</p>}
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
const threadHref = (threadId: string) => `t3-thread://v1/${encodeURIComponent(threadId)}`;

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
  retired: "Retired",
  unknown: "Lifecycle unknown",
} as const;
const readinessTone = (value: ProjectSupervisorTeamInfo["root"]["readiness"]) => value === "ready" ? "green" : value === "pending" ? "blue" : "amber";
const lifecycleTone = (value: ProjectSupervisorTeamInfo["root"]["lifecycle"]) => value === "active" ? "blue" : value === "idle" ? "green" : "amber";
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
    <p className="muted">The Supervisor team is separate from the operational workflow tree. The root owns unassigned work; each helper covers its assigned subtree and future operational descendants.</p>
    <p className="small muted">A person who messages a helper in T3 follows T3’s native follow-up behavior. Root-to-helper notes and routine check-ins use Supervisor team operations, not raw <code>t3_thread_send</code>.</p>
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
                  {handover.direction === "incoming" ? "Incoming" : "Outgoing"} · <a href={threadHref(handover.targetThreadId)}>{handover.targetTitle ?? `Operational subtree ${handover.targetThreadId}`}</a> · {handover.state}
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
  return <p className="small muted"><strong>Assigned to:</strong> Unknown; the current owner could not be confirmed.</p>;
}

function WorkflowProgressDetails({workflow, scopeThread}: {workflow: WorkflowProgressWorkflow; scopeThread?: WorkflowProgressScopeThread}) {
  const lifecycle = scopeThread ? lifecyclePresentation(scopeThread) : null;
  return <article className="stack workflow-progress-document">
    <div className="row between">
      <h5>{workflow.parentThreadId ? "Child workflow" : "Main workflow"}</h5>
      <span className={`pill ${workflow.status === "needs_attention" ? "amber" : workflow.status === "completed" ? "green" : "blue"}`}>
        {workflowExecutionStatusText[workflow.status]}
      </span>
    </div>
    <p>{workflow.objective ?? "No workflow objective was recorded."}</p>
    <p className="small muted"><a href={threadHref(workflow.threadId)}>Open conversation {workflow.threadId}</a> · Revision {workflow.revision} · Updated {formatProgressTime(workflow.updatedAt)}</p>
    {scopeThread && <div className="small muted">
      <p><strong>Native lifecycle:</strong> {lifecycle!.label}</p>
      {scopeThread.lifecycleDetail && <p>T3 lifecycle detail: {scopeThread.lifecycleDetail}</p>}
      <p>{scopeThread.contactLimit}</p>
    </div>}
    {workflow.parentNodeReferences.length > 0 && <div className="stack">
      <strong>Contributes to parent steps</strong>
      <ul className="stack">{workflow.parentNodeReferences.map(reference => <li key={`${reference.parentWorkflowId}:${reference.nodeId}`}>
        {reference.nodeKind}: {reference.nodeName} · <a href={threadHref(reference.parentThreadId)}>Open parent conversation {reference.parentThreadId}</a>
      </li>)}</ul>
    </div>}
    {workflow.plan
      ? <WorkflowPlanNode node={workflow.plan} liveAssessment/>
      : <p className="muted">No current plan structure was recorded for this conversation.</p>}
    <div className="stack">
      <h6>Recent Supervisor observations</h6>
      {workflow.observations.length === 0
        ? <p className="muted">No status explanation or observation is recorded yet.</p>
        : <ol className="stack">{workflow.observations.map(observation => <li key={observation.id} className="workflow-progress-observation">
          <p>{observation.note}</p>
          <p className="small muted">{observation.kind.replaceAll("_", " ")} · {formatProgressTime(observation.recordedAt)}
            {observation.targetNodeName && <> · {observation.targetNodeName}</>}
            {(observation.statusFrom || observation.statusTo) && <> · {observation.statusFrom ?? "new"} → {observation.statusTo ?? "removed"}</>}
          </p>
          {observation.sourceThreadId && <p className="small"><a href={threadHref(observation.sourceThreadId)}>Open supporting activity in conversation {observation.sourceThreadId}</a></p>}
          {(observation.sourceRunId || observation.sourceMessageId || observation.sourceItemId) && <p className="small muted">
            {observation.sourceRunId && <>Run <code>{observation.sourceRunId}</code> </>}
            {observation.sourceMessageId && <>Message <code>{observation.sourceMessageId}</code> </>}
            {observation.sourceItemId && <>Item <code>{observation.sourceItemId}</code></>}
          </p>}
        </li>)}</ol>}
    </div>
  </article>;
}

export function WorkflowProgressPanel({mainThreadId, connected, progress, onRefresh, onLoadMore}: {
  mainThreadId: string | null;
  connected: boolean;
  progress: WorkflowProgressPanelState;
  onRefresh: () => void;
  onLoadMore: () => void;
}) {
  const pages = progress.pages;
  const latest = pages.at(-1);
  const threadById = new Map<string, NonNullable<WorkflowProgressSnapshot["scope"]>["threads"][number]>();
  const workflowByThreadId = new Map<string, WorkflowProgressWorkflow>();
  const coverageByThreadId = new Map<string, NonNullable<WorkflowProgressSnapshot["coverage"]>[number]>();
  for (const page of pages) {
    for (const thread of page.scope?.threads ?? []) threadById.set(thread.threadId, thread);
    for (const coverage of page.coverage ?? []) coverageByThreadId.set(coverage.threadId, coverage);
    for (const workflow of page.workflows) {
      const previous = workflowByThreadId.get(workflow.threadId);
      if (!previous || workflow.updatedAt >= previous.updatedAt) workflowByThreadId.set(workflow.threadId, workflow);
    }
  }
  const threads = [...threadById.values()];
  const workflows = [...workflowByThreadId.values()];
  const allWorkflowPagesLoaded = pages.length > 0 && pages.every(page => page.status === "ok") && !latest?.workflowHasMore;
  const apiFailure = [...pages].reverse().find(page => page.status !== "ok");
  const hasSuccessfulPage = pages.some(page => page.status === "ok");
  const scopeIssues = latest?.scope?.issues ?? [];
  const canLoadMore = Boolean(latest && (latest.workflowHasMore || latest.lineageHasMore));

  return <section className="panel stack" aria-labelledby="workflow-progress-title">
    <div className="row between">
      <h3 id="workflow-progress-title">Live workflow progress</h3>
      <button type="button" disabled={!connected || !mainThreadId || progress.loading} onClick={onRefresh}>Refresh live progress</button>
    </div>
    {!mainThreadId
      ? <p className="muted">Select a main conversation to inspect its current workflow and connected children.</p>
      : <>
        <p className="muted">Current Supervisor workflow state, kept separate from proposals and saved agreements. Statuses and explanations are Supervisor assessments; they are not independent proof of execution. Parent steps do not complete automatically when a child finishes.</p>
        {progress.loading && pages.length === 0 && <p role="status">Loading the selected main conversation’s live progress…</p>}
        {progress.error && hasSuccessfulPage && <p role="status">Showing the last successful progress snapshot. {progress.error}</p>}
        {progress.error && !hasSuccessfulPage && <p role="alert">{progress.error}</p>}
        {!progress.error && apiFailure && <p role="alert">{progressStatusText[apiFailure.status]}. {apiFailure.message}</p>}
        {latest?.scope && <>
          <p className="small">Observed {formatProgressTime(latest.observedAt)} · Main <code>{mainThreadId}</code></p>
          {!latest.scope.complete && <div className="panel" role="status">
            <p>Connected child observation is incomplete. Some lifecycle or activity details may be missing.</p>
            {scopeIssues.length > 0 && <ul>{scopeIssues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}</li>)}</ul>}
          </div>}
          {threads.length > 0 && <div className="stack">
            <h4>Connected conversations</h4>
            <ul className="stack">{threads.map(thread => {
              const lifecycle = lifecyclePresentation(thread);
              return <li key={thread.threadId} className="workflow-progress-thread">
              <div className="row between">
                <strong>{childOriginText[thread.origin]}</strong>
                <span className={`pill ${lifecycle.tone}`}>
                  {lifecycle.label}
                </span>
              </div>
              <p>Lifecycle: {lifecycle.label}</p>
              {thread.lifecycleDetail && <p className="small muted">T3 lifecycle detail: {thread.lifecycleDetail}</p>}
              <WorkflowAssignee coverage={coverageByThreadId.get(thread.threadId)}/>
              {thread.parentThreadId && <p className="small">Parent: <a href={threadHref(thread.parentThreadId)}>Open conversation {thread.parentThreadId}</a></p>}
              {!thread.deletedAt && <p className="small"><a href={threadHref(thread.threadId)}>Open conversation {thread.threadId}</a></p>}
              {lifecycle.label === "Unknown" && <p className="small muted">T3 has not established this conversation’s current lifecycle. An idle thread mirror alone does not establish that its work is finished.</p>}
              {thread.contactLimit && <p className="small muted">{thread.contactLimit}</p>}
              {thread.activityRefs.length > 0 && <details>
                <summary>Supporting activity ({thread.activityRefs.length})</summary>
                <ul className="stack">{thread.activityRefs.map((activity, index) => <li key={`${activity.sourceThreadId}:${activity.sourceItemId ?? activity.sourceMessageId ?? index}`}>
                  <p>{activity.label} · {formatProgressTime(activity.observedAt)}</p>
                  <p className="small"><a href={threadHref(activity.sourceThreadId)}>Open supporting conversation {activity.sourceThreadId}</a></p>
                  {(activity.sourceRunId || activity.sourceMessageId || activity.sourceItemId) && <p className="small muted">
                    {activity.sourceRunId && <>Run <code>{activity.sourceRunId}</code> </>}
                    {activity.sourceMessageId && <>Message <code>{activity.sourceMessageId}</code> </>}
                    {activity.sourceItemId && <>Item <code>{activity.sourceItemId}</code></>}
                  </p>}
                </li>)}</ul>
              </details>}
              {!workflowByThreadId.has(thread.threadId) && <p className="small muted">
                {allWorkflowPagesLoaded ? "No workflow document is recorded for this conversation." : "Workflow state for this conversation may be on a later page."}
              </p>}
            </li>;
            })}</ul>
          </div>}
          {workflows.length > 0 && <div className="stack">
            <h4>Current workflow records</h4>
            {workflows.map(workflow => {
              const scopeThread = threadById.get(workflow.threadId);
              return <WorkflowProgressDetails key={workflow.workflowId} workflow={workflow} {...(scopeThread ? {scopeThread} : {})}/>;
            })}
          </div>}
          {workflows.length === 0 && allWorkflowPagesLoaded && <p className="muted">No current workflow document has been recorded for this main or its connected children.</p>}
          {latest.incompatibleWorkflows.length > 0 && <div className="panel" role="status">
            <p>Some retained workflow records use an incompatible format and remain read-only.</p>
            <ul>{latest.incompatibleWorkflows.map(item => <li key={item.workflowId}><code>{item.workflowId}</code> · format {item.formatVersion ?? "unknown"}</li>)}</ul>
          </div>}
          {canLoadMore && <button type="button" disabled={!connected || progress.loading} onClick={onLoadMore}>Load more connected workflows and activity</button>}
        </>}
      </>}
  </section>;
}

export function ProjectSupervisorView({
  snapshot,
  selection,
  monitoring,
  teamSettings,
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
  onWorkflowProgressRefresh,
  onWorkflowProgressLoadMore,
  onSelectionChange,
  onMonitoringChange,
  onTeamSettingsChange,
  onDiscard,
  onRetry,
  onSubmit,
}: {
  snapshot: ProjectSupervisorInfo;
  selection: SupervisorModelSelection;
  monitoring: MonitoringDraft;
  teamSettings: TeamSettingsDraft;
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
  onWorkflowProgressRefresh?: () => void;
  onWorkflowProgressLoadMore?: () => void;
  onSelectionChange: (selection: SupervisorModelSelection) => void;
  onMonitoringChange: (monitoring: MonitoringDraft) => void;
  onTeamSettingsChange: (settings: TeamSettingsDraft) => void;
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
  const fieldsDisabled = !connected || !snapshot.available || fieldsBusy || blocked;
  const intervalError = monitoringError(monitoring.intervalMinutes, 1, 60, "maximum pending activity age in minutes");
  const thresholdError = monitoringError(monitoring.activityThreshold, 3, 100, "finalized activity threshold");
  const teamSettingsError = monitoringError(teamSettings.maxHelpersPerRoot, 0, 20, "maximum helpers per root");
  const modelCanChange = !fieldsDisabled;
  const reasoningCanChange = !fieldsDisabled && Boolean(selected?.available && reasoning?.choices.length);

  return <div className="stack">
    <div className="panel stack">
      <div className="row between">
        <h3>Supervisor conversation</h3>
        {snapshot.binding && <span className={`pill ${snapshot.binding.state === "ready" ? "green" : "amber"}`}>{snapshot.binding.state}</span>}
      </div>
      {snapshot.binding?.state === "missing"
        ? <p>Deleted Supervisor conversation: <code>{snapshot.binding.threadId}</code></p>
        : snapshot.binding
          ? <p>Bound conversation: <a href={`t3-thread://v1/${snapshot.binding.threadId}`}>Open in T3</a> <code>{snapshot.binding.threadId}</code></p>
        : <p>{snapshot.mainThreadId ? "No Supervisor is bound to this main conversation yet." : "Select a main conversation to inspect its Supervisor."}</p>}
      <p className="muted">Saving settings does not start a conversation. T3 creates the Supervisor conversation for the first task that needs it, then reuses it when that main conversation resumes. Independent main conversations have separate Supervisors.</p>
      {snapshot.binding?.settlementState && <p>Automatic settlement: {snapshot.binding.settlementState}. Resumed work uses this same conversation.</p>}
      {snapshot.binding?.keptActive && <p>Automatic settlement is held by a user keep-active choice.</p>}
      <p className="muted">Supervisor work runs in the project root. Role instructions limit it to reading and messaging through T3, but those instructions do not enforce tool restrictions.</p>
      <p>{snapshot.message}</p>
      <p><strong>Project default for new Supervisors:</strong> {formatModel(snapshot, snapshot.settings.modelSelection)}</p>
      {snapshot.mainThreadId && <p><strong>Selected Supervisor model in T3:</strong> {formatModel(snapshot, snapshot.modelSelection)}. Edit this conversation’s model using T3 controls.</p>}
      {snapshot.modelApplication?.pending && snapshot.binding?.state === "ready" && <p role="status">T3 is waiting to apply the saved model selection while the Supervisor is idle.</p>}
      {snapshot.settings.pending && !snapshot.binding && <p role="status">The saved model selection will apply when T3 creates the Supervisor conversation for the first needed task.</p>}
      {!snapshot.available && <p role="status">Supervisor settings are currently unavailable.</p>}
    </div>

    <ProjectSupervisorTeamPanel team={snapshot.team} settings={readTeamSettings(snapshot)} mainThreadId={snapshot.mainThreadId}/>

    <form className="panel stack" onSubmit={onSubmit} aria-label="Supervisor settings">
      <fieldset disabled={fieldsDisabled} className="stack">
        <legend>Project model defaults</legend>
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
        {snapshot.monitoringStatus && <section className="stack" aria-labelledby="supervisor-monitoring-status-title">
          <h4 id="supervisor-monitoring-status-title">Current monitoring status</h4>
          <p><strong>Status:</strong> {snapshot.monitoringStatus.state}</p>
          <p><strong>Pending activities:</strong> {snapshot.monitoringStatus.pendingItems}</p>
          <p><strong>Next review:</strong> {formatMonitoringTime(snapshot.monitoringStatus.nextReviewAt)}</p>
          <p><strong>Last notice:</strong> {formatMonitoringTime(snapshot.monitoringStatus.lastNoticeAt)}</p>
          <p>{snapshot.monitoringStatus.message}</p>
        </section>}
        <div className="stack">
          <label htmlFor="supervisor-monitoring-interval">Maximum pending activity age (minutes)</label>
          <input id="supervisor-monitoring-interval" name="intervalMinutes" type="number" min={1} max={60} step={1} required
            value={monitoring.intervalMinutes} aria-invalid={intervalError ? true : undefined}
            aria-describedby="supervisor-monitoring-interval-help supervisor-monitoring-interval-error"
            onChange={event => onMonitoringChange({...monitoring, intervalMinutes: event.target.value})} />
          <span id="supervisor-monitoring-interval-help" className="small muted">Enter a whole number from 1 to 60 minutes.</span>
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
        <p><strong>Supervisor cooldown:</strong> 60 seconds between monitoring sends.</p>
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
      <button type="submit" disabled={!canSave || saving || blocked}>{saving ? "Saving…" : "Save Supervisor settings"}</button>
      {dirty && <button type="button" disabled={saving || blocked} onClick={onDiscard}>Discard draft</button>}
    </form>

    {shouldOfferRetry && <div className="panel stack">
      <h3>{snapshot.binding?.state === "missing" ? "Deleted Supervisor conversation" : "Native Supervisor access"}</h3>
      <p className="muted">{snapshot.binding?.state === "missing"
        ? "T3 confirmed that the bound conversation was deleted. This explicit action replaces it with a new Supervisor conversation."
        : "Use this explicit action to retry the selected conversation’s pending or rejected native operation."}</p>
      {!snapshot.binding && <p role="status">No bound Supervisor conversation is available to retry yet. Refresh after the service establishes one.</p>}
      {dirty && <p role="status">Save or discard your settings draft before retrying native access.</p>}
      <button type="button" disabled={!canRetry || saving || blocked} onClick={onRetry}>{retryButtonLabel}</button>
    </div>}

    {selectedTask && <section className="panel stack" aria-labelledby="supervisor-task-title">
      <h3 id="supervisor-task-title">Task interpretation for the selected conversation</h3>
      <p><strong>Status:</strong> {selectedTask.status}</p>
      {selectedTask.objective && <p><strong>Interpreted task:</strong> {selectedTask.objective}</p>}
      <p>{selectedTask.reason}</p>
      <WorkflowProposalView workflow={selectedTask.workflow} proposalId={selectedTask.workflowProposalId} agreement={selectedTask.agreement} definitionReview={selectedTask.definitionReview} />
    </section>}
    {workflowProgress && <WorkflowProgressPanel mainThreadId={snapshot.mainThreadId} connected={connected} progress={workflowProgress}
      onRefresh={onWorkflowProgressRefresh ?? (() => {})} onLoadMore={onWorkflowProgressLoadMore ?? (() => {})}/>}
  </div>;
}

export function ProjectSupervisorPanel({projectId, threadId, connected, csrfToken = "", onDirtyChange, onSavingChange}: {
  projectId: string;
  threadId?: string;
  connected: boolean;
  csrfToken?: string;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const [snapshotState, setSnapshotState] = useState<SnapshotState | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [loadState, setLoadState] = useState<LoadState>({key: "", status: "idle"});
  const [panelMessage, setPanelMessage] = useState<PanelMessage>(null);
  const [revision, setRevision] = useState(0);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [workflowProgressState, setWorkflowProgressState] = useState<WorkflowProgressPanelState>({key: "", pages: [], loading: false, error: null});
  const [workflowProgressRevision, setWorkflowProgressRevision] = useState(0);
  const activeProject = useRef(projectId);
  const activeScope = useRef(JSON.stringify([projectId, threadId || null]));
  const draftRef = useRef(drafts);
  const savingRef = useRef(false);
  const activeLoadKey = useRef("");
  const completedLoadKey = useRef("");
  const workflowProgressStateRef = useRef(workflowProgressState);
  const workflowProgressRequestRef = useRef<AbortController | null>(null);
  const workflowProgressRequestIdRef = useRef(0);
  const activeWorkflowProgressKey = useRef("");
  activeProject.current = projectId;
  activeScope.current = JSON.stringify([projectId, threadId || null]);
  draftRef.current = drafts;
  workflowProgressStateRef.current = workflowProgressState;

  const activeSnapshot = snapshotState?.projectId === projectId && snapshotState.snapshot.mainThreadId === (threadId || null) ? snapshotState.snapshot : null;
  const workflowProgressKey = JSON.stringify([projectId, activeSnapshot?.mainThreadId ?? (threadId || null),
    activeSnapshot?.binding?.threadId ?? null, activeSnapshot?.binding?.generation ?? null]);
  activeWorkflowProgressKey.current = workflowProgressKey;
  const activeDraft = drafts[projectId] ?? null;
  const modelDirty = Boolean(activeDraft && selectionKey(activeDraft.modelValue) !== selectionKey(activeDraft.modelBaseline));
  const monitoringDirty = Boolean(activeDraft && !sameMonitoring(activeDraft.monitoringValue, activeDraft.monitoringBaseline));
  const teamSettingsDirty = Boolean(activeDraft && !sameTeamSettings(activeDraft.teamSettingsValue, activeDraft.teamSettingsBaseline));
  const dirty = modelDirty || monitoringDirty || teamSettingsDirty;
  const requestKey = JSON.stringify([projectId, threadId || null, revision]);
  const isLoading = connected && loadState.key === requestKey && loadState.status === "loading";
  const loadError = loadState.key === requestKey && loadState.status === "error";
  const fieldsBusy = saving || isLoading;
  const selectedModel = activeSnapshot && activeDraft ? findModel(activeSnapshot, activeDraft.modelValue) : undefined;
  const validMonitoring = activeDraft ? parseMonitoringDraft(activeDraft.monitoringValue) : null;
  const validTeamSettings = activeDraft ? parseTeamSettingsDraft(activeDraft.teamSettingsValue) : null;
  const canSave = Boolean(activeSnapshot?.available && activeDraft && dirty && validMonitoring && validTeamSettings && (!modelDirty || selectedModel?.available) && connected && !fieldsBusy && !blocked);
  const needsRetry = Boolean(activeSnapshot && shouldOfferNativeRetry(activeSnapshot));
  const retryButtonLabel = activeSnapshot?.binding?.state === "missing" ? "Replace deleted Supervisor conversation" : "Retry native access";
  const canRetry = Boolean(needsRetry && activeSnapshot?.available && activeSnapshot.binding && activeDraft && !dirty && connected && !fieldsBusy && !blocked);

  useEffect(() => {setPanelMessage(null);}, [projectId, threadId]);
  useEffect(() => {onDirtyChange?.(dirty);}, [dirty, onDirtyChange]);
  useEffect(() => {onSavingChange?.(saving);}, [saving, onSavingChange]);

  useEffect(() => {
    const mainThreadId = activeSnapshot?.mainThreadId ?? null;
    if (!projectId || !connected || !mainThreadId) {
      workflowProgressRequestRef.current?.abort();
      setWorkflowProgressState({key: workflowProgressKey, pages: [], loading: false, error: null});
      return;
    }
    const previous = workflowProgressStateRef.current;
    const expectedBinding = activeSnapshot?.binding
      ? {threadId: activeSnapshot.binding.threadId, generation: activeSnapshot.binding.generation}
      : undefined;
    const pageRequests = previous.key === workflowProgressKey && previous.pages.length > 0
      ? previous.pages.map(page => ({
        workflowOffset: page.workflowOffset,
        lineageOffset: page.lineageOffset,
        ...(expectedBinding ? {expectedBinding} : {}),
      }))
      : [{workflowOffset: 0, lineageOffset: 0, ...(expectedBinding ? {expectedBinding} : {})}];
    const requestId = ++workflowProgressRequestIdRef.current;
    workflowProgressRequestRef.current?.abort();
    const controller = new AbortController();
    workflowProgressRequestRef.current = controller;
    setWorkflowProgressState(current => current.key === workflowProgressKey
      ? {...current, loading: true, error: null}
      : {key: workflowProgressKey, pages: [], loading: true, error: null});
    void refreshWorkflowProgressPages(projectId, mainThreadId, controller.signal, pageRequests).then(pages => {
      if (controller.signal.aborted || requestId !== workflowProgressRequestIdRef.current || activeProject.current !== projectId ||
        activeWorkflowProgressKey.current !== workflowProgressKey) return;
      const failed = pages.find(page => page.status !== "ok");
      setWorkflowProgressState(current => {
        if (current.key === workflowProgressKey && current.pages.length > 0 && failed) return {
          ...current, loading: false, error: failed.message ?? "Progress could not be refreshed.",
        };
        return {key: workflowProgressKey, pages, loading: false, error: failed?.message ?? null};
      });
    }, () => {
      if (controller.signal.aborted || requestId !== workflowProgressRequestIdRef.current || activeProject.current !== projectId ||
        activeWorkflowProgressKey.current !== workflowProgressKey) return;
      setWorkflowProgressState(current => current.key === workflowProgressKey
        ? {...current, loading: false, error: "Progress could not be refreshed. The last successful snapshot is retained."}
        : {key: workflowProgressKey, pages: [], loading: false, error: "Progress could not be loaded for this main conversation."});
    });
    return () => {
      controller.abort();
      if (workflowProgressRequestRef.current === controller) workflowProgressRequestRef.current = null;
    };
  }, [projectId, connected, workflowProgressKey, workflowProgressRevision]);

  useEffect(() => {
    if (!connected || !activeSnapshot?.mainThreadId) return;
    const timer = setInterval(() => {
      const current = workflowProgressStateRef.current;
      if (document.visibilityState === "visible" && current.key === workflowProgressKey && !current.loading)
        setWorkflowProgressRevision(value => value + 1);
    }, 30_000);
    return () => clearInterval(timer);
  }, [connected, workflowProgressKey]);

  useEffect(() => {
    if (!projectId || !connected || saving) return;
    if (!forceRefresh && dirty && activeSnapshot) return;
    if (!forceRefresh && completedLoadKey.current === requestKey) return;
    const controller = new AbortController();
    activeLoadKey.current = requestKey;
    setLoadState({key: requestKey, status: "loading"});
    void loadProjectSupervisor(projectId, controller.signal, threadId || null).then(snapshot => {
      if (controller.signal.aborted || activeLoadKey.current !== requestKey || activeProject.current !== projectId) return;
      const priorDraft = draftRef.current[projectId] ?? null;
      const priorModelWasDirty = Boolean(priorDraft && selectionKey(priorDraft.modelValue) !== selectionKey(priorDraft.modelBaseline));
      const priorMonitoringWasDirty = Boolean(priorDraft && !sameMonitoring(priorDraft.monitoringValue, priorDraft.monitoringBaseline));
      const priorTeamSettingsWereDirty = Boolean(priorDraft && !sameTeamSettings(priorDraft.teamSettingsValue, priorDraft.teamSettingsBaseline));
      const modelBaseline = copySelection(snapshot.settings.modelSelection);
      const modelValue = priorModelWasDirty ? copySelection(priorDraft!.modelValue) : copySelection(modelBaseline);
      const monitoringBaseline = readMonitoringDraft(snapshot);
      const monitoringValue = priorMonitoringWasDirty ? copyMonitoringDraft(priorDraft!.monitoringValue) : copyMonitoringDraft(monitoringBaseline);
      const teamSettingsBaseline = readTeamSettingsDraft(snapshot);
      const teamSettingsValue = priorTeamSettingsWereDirty ? copyTeamSettingsDraft(priorDraft!.teamSettingsValue) : copyTeamSettingsDraft(teamSettingsBaseline);
      completedLoadKey.current = requestKey;
      setSnapshotState({projectId, snapshot});
      setDrafts(current => ({...current, [projectId]: {projectId, modelValue, modelBaseline, monitoringValue, monitoringBaseline,
        teamSettingsValue, teamSettingsBaseline, expectedGeneration: snapshot.settings.generation}}));
      setLoadState({key: requestKey, status: "idle"});
      setBlocked(false);
      if (forceRefresh) setPanelMessage({
        projectId,
        text: (priorModelWasDirty && selectionKey(modelValue) !== selectionKey(modelBaseline)) ||
          (priorMonitoringWasDirty && !sameMonitoring(monitoringValue, monitoringBaseline)) ||
          (priorTeamSettingsWereDirty && !sameTeamSettings(teamSettingsValue, teamSettingsBaseline))
          ? "Supervisor settings refreshed. Your unsaved draft was kept against the latest saved generation."
          : "Supervisor settings refreshed from T3.",
        alert: false,
      });
      setForceRefresh(false);
    }, () => {
      if (controller.signal.aborted || activeLoadKey.current !== requestKey || activeProject.current !== projectId) return;
      completedLoadKey.current = requestKey;
      setLoadState({key: requestKey, status: "error"});
      setForceRefresh(false);
    });
    return () => {
      controller.abort();
      if (activeLoadKey.current === requestKey) activeLoadKey.current = "";
    };
  }, [projectId, connected, saving, dirty, activeSnapshot, forceRefresh, requestKey]);

  const refresh = () => {
    if (!projectId || !connected || saving || isLoading) return;
    setForceRefresh(true);
    setRevision(value => value + 1);
  };

  const refreshWorkflowProgress = () => {
    if (!connected || !activeSnapshot?.mainThreadId || workflowProgressState.loading) return;
    setWorkflowProgressRevision(value => value + 1);
  };

  const loadMoreWorkflowProgress = () => {
    const current = workflowProgressStateRef.current;
    const latest = current.key === workflowProgressKey ? current.pages.at(-1) : undefined;
    if (!connected || !activeSnapshot?.mainThreadId || !latest || current.loading ||
      (!latest.workflowHasMore && !latest.lineageHasMore)) return;
    const page = {
      workflowOffset: latest.workflowHasMore ? latest.workflowOffset + latest.workflows.length : latest.workflowOffset,
      lineageOffset: latest.lineageHasMore ? latest.lineageOffset + (latest.scope?.threads.length ?? 0) : latest.lineageOffset,
    };
    if (page.workflowOffset === latest.workflowOffset && page.lineageOffset === latest.lineageOffset) return;
    workflowProgressRequestRef.current?.abort();
    const controller = new AbortController();
    workflowProgressRequestRef.current = controller;
    const requestId = ++workflowProgressRequestIdRef.current;
    setWorkflowProgressState(state => state.key === workflowProgressKey ? {...state, loading: true, error: null} : state);
    void loadWorkflowProgress(projectId, activeSnapshot.mainThreadId, controller.signal, {...page,
      ...(activeSnapshot.binding ? {expectedBinding: {threadId: activeSnapshot.binding.threadId, generation: activeSnapshot.binding.generation}} : {})}).then(result => {
      if (controller.signal.aborted || requestId !== workflowProgressRequestIdRef.current || activeProject.current !== projectId ||
        activeWorkflowProgressKey.current !== workflowProgressKey) return;
      setWorkflowProgressState(state => state.key === workflowProgressKey
        ? {...state, pages: [...state.pages, result], loading: false, error: result.status === "ok" ? null : result.message}
        : state);
    }, () => {
      if (controller.signal.aborted || requestId !== workflowProgressRequestIdRef.current || activeProject.current !== projectId ||
        activeWorkflowProgressKey.current !== workflowProgressKey) return;
      setWorkflowProgressState(state => state.key === workflowProgressKey
        ? {...state, loading: false, error: "The next progress page could not be loaded. The last successful snapshot is retained."}
        : state);
    });
  };

  const updateSelection = (selection: SupervisorModelSelection) => {
    setDrafts(current => {
      const currentDraft = current[projectId];
      return currentDraft ? {...current, [projectId]: {...currentDraft, modelValue: copySelection(selection)}} : current;
    });
    setPanelMessage(null);
  };

  const updateMonitoring = (monitoring: MonitoringDraft) => {
    setDrafts(current => {
      const currentDraft = current[projectId];
      return currentDraft ? {...current, [projectId]: {...currentDraft, monitoringValue: copyMonitoringDraft(monitoring)}} : current;
    });
    setPanelMessage(null);
  };

  const updateTeamSettings = (settings: TeamSettingsDraft) => {
    setDrafts(current => {
      const currentDraft = current[projectId];
      return currentDraft ? {...current, [projectId]: {...currentDraft, teamSettingsValue: copyTeamSettingsDraft(settings)}} : current;
    });
    setPanelMessage(null);
  };

  const discardDraft = () => {
    if (saving || blocked) return;
    setDrafts(current => {
      const currentDraft = current[projectId];
      return currentDraft ? {...current, [projectId]: {
        ...currentDraft,
        modelValue: copySelection(currentDraft.modelBaseline),
        monitoringValue: copyMonitoringDraft(currentDraft.monitoringBaseline),
        teamSettingsValue: copyTeamSettingsDraft(currentDraft.teamSettingsBaseline),
      }} : current;
    });
    setPanelMessage(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current || !canSave || !activeDraft || !activeSnapshot || !validMonitoring || !validTeamSettings) return;
    const targetProject = projectId;
    const targetScope = activeScope.current;
    const input = {
      projectId: targetProject,
      ...(threadId ? {mainThreadId: threadId} : {}),
      expectedGeneration: activeDraft.expectedGeneration,
      modelSelection: copySelection(activeDraft.modelValue),
      monitoring: copyMonitoringSettings(validMonitoring),
      teamSettings: {...validTeamSettings},
    };
    savingRef.current = true;
    setSaving(true);
    setPanelMessage(null);
    try {
      const result = await saveProjectSupervisor(input, csrfToken);
      if (activeProject.current !== targetProject || activeScope.current !== targetScope) return;
      if (result.status === "saved") {
        if (result.snapshot) {
          const canonical = copySelection(result.snapshot.settings.modelSelection);
          const canonicalMonitoring = readMonitoring(result.snapshot);
          const canonicalMonitoringDraft = monitoringDraft(canonicalMonitoring);
          const canonicalTeamSettings = readTeamSettingsDraft(result.snapshot);
          setSnapshotState({projectId: targetProject, snapshot: result.snapshot});
          setDrafts(current => ({...current, [targetProject]: {
            projectId: targetProject,
            modelValue: canonical,
            modelBaseline: copySelection(canonical),
            monitoringValue: copyMonitoringDraft(canonicalMonitoringDraft),
            monitoringBaseline: copyMonitoringDraft(canonicalMonitoringDraft),
            teamSettingsValue: copyTeamSettingsDraft(canonicalTeamSettings),
            teamSettingsBaseline: copyTeamSettingsDraft(canonicalTeamSettings),
            expectedGeneration: result.snapshot!.settings.generation,
          }}));
          setBlocked(false);
          setPanelMessage({projectId: targetProject, text: result.message, alert: false});
        } else {
          setDrafts(current => {
            const currentDraft = current[targetProject];
            return currentDraft ? {...current, [targetProject]: {
              ...currentDraft,
              modelValue: copySelection(input.modelSelection),
              modelBaseline: copySelection(input.modelSelection),
              monitoringValue: monitoringDraft(input.monitoring),
              monitoringBaseline: monitoringDraft(input.monitoring),
              teamSettingsValue: teamSettingsDraft(input.teamSettings),
              teamSettingsBaseline: teamSettingsDraft(input.teamSettings),
            }} : current;
          });
          setBlocked(true);
          setPanelMessage({projectId: targetProject, text: `${result.message} Refresh Supervisor settings before making another change.`, alert: false});
        }
      } else if (result.status === "uncertain") {
        setBlocked(true);
        setPanelMessage({projectId: targetProject, text: result.message, alert: true});
      } else if (result.snapshot) {
        const modelBaseline = copySelection(result.snapshot.settings.modelSelection);
        const monitoringBaseline = readMonitoringDraft(result.snapshot);
        const teamSettingsBaseline = readTeamSettingsDraft(result.snapshot);
        setSnapshotState({projectId: targetProject, snapshot: result.snapshot});
        setDrafts(current => {
          const currentDraft = current[targetProject];
          return currentDraft ? {...current, [targetProject]: {
            ...currentDraft,
            modelBaseline,
            monitoringBaseline,
            teamSettingsBaseline,
            expectedGeneration: result.snapshot!.settings.generation,
          }} : current;
        });
        setBlocked(false);
        setPanelMessage({projectId: targetProject, text: result.message, alert: result.status === "invalid"});
      } else {
        setBlocked(result.status === "conflict");
        setPanelMessage({projectId: targetProject, text: result.status === "conflict" ? `${result.message} Refresh Supervisor settings before trying again.` : result.message, alert: result.status === "invalid"});
      }
    } catch (error) {
      if (activeProject.current !== targetProject || activeScope.current !== targetScope) return;
      const definitelyNotSaved = error instanceof ProjectSupervisorRequestError && error.definitelyNotSaved;
      setBlocked(!definitelyNotSaved);
      setPanelMessage({
        projectId: targetProject,
        text: error instanceof ProjectSupervisorRequestError
          ? error.message
          : "The save outcome could not be confirmed. Refresh Supervisor settings before trying again.",
        alert: !definitelyNotSaved,
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const retryNativeAccess = async () => {
    if (savingRef.current || !canRetry || !activeDraft) return;
    const binding = activeSnapshot?.binding;
    if (!binding) return;
    const targetProject = projectId;
    const targetScope = activeScope.current;
    const input = {
      projectId: targetProject,
      mainThreadId: binding.mainThreadId,
      expectedGeneration: activeDraft.expectedGeneration,
      threadId: binding.threadId,
      bindingGeneration: binding.generation,
      action: binding.state === "missing" ? "replace" as const : "retry" as const,
    };
    savingRef.current = true;
    setSaving(true);
    setPanelMessage(null);
    try {
      const result = await retryProjectSupervisor(input, csrfToken);
      if (activeProject.current !== targetProject || activeScope.current !== targetScope) return;
      if (result.status === "uncertain") {
        setBlocked(true);
        setPanelMessage({projectId: targetProject, text: result.message, alert: true});
      } else if (result.snapshot) {
        const canonical = copySelection(result.snapshot.settings.modelSelection);
        const canonicalMonitoring = readMonitoringDraft(result.snapshot);
        const canonicalTeamSettings = readTeamSettingsDraft(result.snapshot);
        setSnapshotState({projectId: targetProject, snapshot: result.snapshot});
        setDrafts(current => ({...current, [targetProject]: {
          projectId: targetProject,
          modelValue: canonical,
          modelBaseline: copySelection(canonical),
          monitoringValue: copyMonitoringDraft(canonicalMonitoring),
          monitoringBaseline: copyMonitoringDraft(canonicalMonitoring),
          teamSettingsValue: copyTeamSettingsDraft(canonicalTeamSettings),
          teamSettingsBaseline: copyTeamSettingsDraft(canonicalTeamSettings),
          expectedGeneration: result.snapshot!.settings.generation,
        }}));
        setBlocked(false);
        setPanelMessage({projectId: targetProject, text: result.message, alert: result.status === "invalid"});
      } else {
        const mustRefresh = result.status === "conflict" || result.status === "saved";
        setBlocked(mustRefresh);
        setPanelMessage({
          projectId: targetProject,
          text: mustRefresh ? `${result.message} Refresh Supervisor settings before trying again.` : result.message,
          alert: result.status === "invalid",
        });
      }
    } catch (error) {
      if (activeProject.current !== targetProject || activeScope.current !== targetScope) return;
      const definitelyNotSaved = error instanceof ProjectSupervisorRequestError && error.definitelyNotSaved;
      setBlocked(!definitelyNotSaved);
      setPanelMessage({
        projectId: targetProject,
        text: error instanceof ProjectSupervisorRequestError
          ? error.message
          : "The native access retry outcome could not be confirmed. Refresh Supervisor settings before trying again.",
        alert: !definitelyNotSaved,
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const visibleMessage = panelMessage?.projectId === projectId ? panelMessage : null;
  const loadKey = requestKey;

  return <section className="stack project-supervisor" aria-labelledby="project-supervisor-title">
    <div><h2 id="project-supervisor-title">Project Supervisor settings</h2><p className="muted">Set defaults for new Supervisors and select a main conversation to inspect its own Supervisor.</p></div>
    {projectId && <SupervisionControlPanel key={projectId} projectId={projectId} />}
    {!projectId && <p className="panel muted">Select a project to manage its Supervisor settings.</p>}
    {projectId && !connected && <p className="panel" role="status">T3 is disconnected. Any unsaved Supervisor settings draft is kept.</p>}
    {projectId && connected && !activeSnapshot && isLoading && <p className="panel" role="status">Loading Supervisor settings…</p>}
    {projectId && connected && loadError && <p className="panel" role="alert">Could not refresh Supervisor settings. The previous snapshot remains visible; refresh to try again or check the T3 connection.</p>}
    {projectId && activeSnapshot && activeDraft && <ProjectSupervisorView
      snapshot={activeSnapshot}
      selection={activeDraft.modelValue}
      monitoring={activeDraft.monitoringValue}
      teamSettings={activeDraft.teamSettingsValue}
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
      workflowProgress={workflowProgressState.key === workflowProgressKey
        ? workflowProgressState
        : {key: workflowProgressKey, pages: [], loading: connected, error: null}}
      onWorkflowProgressRefresh={refreshWorkflowProgress}
      onWorkflowProgressLoadMore={loadMoreWorkflowProgress}
      onSelectionChange={updateSelection}
      onMonitoringChange={updateMonitoring}
      onTeamSettingsChange={updateTeamSettings}
      onDiscard={discardDraft}
      onRetry={() => {void retryNativeAccess();}}
      onSubmit={save}
    />}
    {projectId && connected && activeSnapshot && !activeDraft && isLoading && <p className="panel" role="status">Loading the selected project’s settings…</p>}
    {projectId && connected && !activeSnapshot && !isLoading && !loadError && <p className="panel muted">Supervisor settings are not loaded yet.</p>}
    {visibleMessage && <p role={visibleMessage.alert ? "alert" : "status"}>{visibleMessage.text}</p>}
    {projectId && <button type="button" disabled={!connected || saving || isLoading} onClick={refresh}>Refresh Supervisor settings</button>}
    {loadState.key === loadKey && loadState.status === "loading" && activeSnapshot && <p className="small muted" role="status">Refreshing saved settings…</p>}
  </section>;
}
