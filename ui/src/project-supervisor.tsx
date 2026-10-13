import React, { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  ProjectSupervisorInfo,
  DefinitionReviewInfo,
  SupervisorModelInfo,
  SupervisorModelSelection,
  SupervisorMonitoringSettings,
  WorkflowAgreementInfo,
  WorkflowProposalInfo,
} from "../../src/project-supervisor-contract.js";
import { defaultMonitoringSettings } from "../../src/project-supervisor-contract.js";
import { loadProjectSupervisor, ProjectSupervisorRequestError, retryProjectSupervisor, saveProjectSupervisor } from "./project-supervisor-api.js";

type MonitoringDraft = {
  enabled: boolean;
  intervalMinutes: string;
  activityThreshold: string;
};

type Draft = {
  projectId: string;
  modelValue: SupervisorModelSelection;
  modelBaseline: SupervisorModelSelection;
  monitoringValue: MonitoringDraft;
  monitoringBaseline: MonitoringDraft;
  expectedGeneration: number;
};
type Drafts = Record<string, Draft>;

type SnapshotState = {projectId: string; snapshot: ProjectSupervisorInfo};
type LoadState = {key: string; status: "idle" | "loading" | "error"};
type PanelMessage = {projectId: string; text: string; alert: boolean} | null;

const selectionKey = (selection: SupervisorModelSelection) => JSON.stringify(selection);
const copySelection = (selection: SupervisorModelSelection): SupervisorModelSelection => ({
  instanceId: selection.instanceId,
  model: selection.model,
  options: selection.options.map(option => ({...option})),
});
const copyMonitoringDraft = (monitoring: MonitoringDraft): MonitoringDraft => ({...monitoring});
const monitoringDraft = (monitoring: SupervisorMonitoringSettings): MonitoringDraft => ({
  enabled: monitoring.enabled,
  intervalMinutes: String(monitoring.intervalMinutes),
  activityThreshold: String(monitoring.activityThreshold),
});
const copyMonitoringSettings = (monitoring: SupervisorMonitoringSettings): SupervisorMonitoringSettings => ({...monitoring});
const sameMonitoring = (left: MonitoringDraft, right: MonitoringDraft) =>
  left.enabled === right.enabled && left.intervalMinutes === right.intervalMinutes && left.activityThreshold === right.activityThreshold;
const readMonitoring = (snapshot: ProjectSupervisorInfo) => copyMonitoringSettings(snapshot.settings.monitoring ?? defaultMonitoringSettings);
const readMonitoringDraft = (snapshot: ProjectSupervisorInfo) => monitoringDraft(readMonitoring(snapshot));
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
  return {enabled: value.enabled, intervalMinutes: Number(value.intervalMinutes), activityThreshold: Number(value.activityThreshold)};
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
  return monitoringNeedsRetry ||
    snapshot.binding?.state === "uncertain" ||
    snapshot.binding?.state === "rejected" ||
    snapshot.binding?.state === "missing" ||
    snapshot.tasks.some(task => task.status === "uncertain") ||
    snapshot.settings.pending && snapshot.binding?.state === "ready";
}

const formatWorkflowAgreementTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};

function WorkflowDetails({workflow, stepHeading, emptyStepsMessage}: {
  workflow: WorkflowProposalInfo;
  stepHeading: string;
  emptyStepsMessage: string;
}) {
  const orderedRules = [...workflow.rules].sort((left, right) => left.index - right.index);

  return <>
    <div className="stack">
      <h6>Rule applicability</h6>
      {orderedRules.length > 0
        ? <ol className="stack">{orderedRules.map(rule => <li key={`${rule.index}:${rule.name}`}>
          <strong>{rule.name}</strong>
          <p><strong>Decision:</strong> {rule.applies ? "Applies" : "Does not apply"}</p>
          <p>{rule.reason}</p>
        </li>)}</ol>
        : <p className="muted">No rules were evaluated for this proposal.</p>}
    </div>

    <div className="stack">
      <h6>{stepHeading}</h6>
      {workflow.steps.length > 0
        ? <ol className="stack">{workflow.steps.map((step, index) => <li key={`${step.blockId ?? "task-specific"}:${step.name}:${index}`}>
          <strong>Step {index + 1}: {step.name}</strong>
          {step.blockId === null
            ? <p className="muted">Task-specific step</p>
            : <p><strong>Block ID:</strong> <code>{step.blockId}</code></p>}
          <p>{step.reason}</p>
        </li>)}</ol>
        : <p className="muted">{emptyStepsMessage}</p>}
    </div>
  </>;
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
    <WorkflowDetails
      workflow={agreement.workflow}
      stepHeading={stale ? "Steps in this historical agreement" : "Agreed steps"}
      emptyStepsMessage="No workflow steps are recorded in this agreement." />
    <details className="stack">
      <summary>{stale ? "Historical agreement details" : "Agreement details"}</summary>
      <p><strong>Proposal ID:</strong> <code>{agreement.proposalId}</code></p>
      <p><strong>Agreed at:</strong> {agreedAt
        ? <time dateTime={agreedAt.toISOString()}>{agreedAt.toLocaleString()}</time>
        : "Unknown"}</p>
      <p><strong>Workspace root:</strong> {agreement.workflow.workspaceRoot === null ? "Not recorded" : <code>{agreement.workflow.workspaceRoot}</code>}</p>
      <p><strong>Rules revision:</strong> {agreement.workflow.revision === null ? "Not recorded" : <code>{agreement.workflow.revision}</code>}</p>
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
    {noWorkflowRecord && <p className="muted">No workflow proposal was recorded for this task. Earlier objective-only records are not automatically reprocessed.</p>}
    {hasAgreement && <WorkflowAgreementView agreement={agreement} />}
    {workflow != null && !sameAsActiveAgreement && <section className="stack">
      <h5>Current workflow draft</h5>
      <p><strong>Draft status:</strong> {workflow.status}</p>
      {proposalId && <p><strong>Proposal ID:</strong> <code>{proposalId}</code></p>}
      <p>{workflow.message}</p>
      {workflow.status === "proposed" && <p className="muted">This is a draft. No agreement is recorded for this proposal.</p>}
      {workflow.status === "pending" && <p className="muted">This proposal is still being prepared; no agreement is recorded for it.</p>}

      <div className="stack">
        <h6>Provenance</h6>
        <p><strong>Workspace root:</strong> {workflow.workspaceRoot === null ? "Not recorded" : <code>{workflow.workspaceRoot}</code>}</p>
        <p><strong>Rules revision:</strong> {workflow.revision === null ? "Not recorded" : <code>{workflow.revision}</code>}</p>
      </div>
      <WorkflowDetails
        workflow={workflow}
        stepHeading="Proposed steps"
        emptyStepsMessage={workflow.status === "proposed" ? "No workflow steps were proposed." : "No workflow steps are available for this proposal."} />
    </section>}
    {workflow == null && agreement?.status === "stale" && <p className="muted">No current workflow draft is recorded for this task.</p>}
    {sameAsActiveAgreement && <p className="muted">The latest proposal is the agreed workflow shown above.</p>}
  </section>;
}

export function ProjectSupervisorView({
  snapshot,
  selection,
  monitoring,
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
  onSelectionChange,
  onMonitoringChange,
  onDiscard,
  onRetry,
  onSubmit,
}: {
  snapshot: ProjectSupervisorInfo;
  selection: SupervisorModelSelection;
  monitoring: MonitoringDraft;
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
  onSelectionChange: (selection: SupervisorModelSelection) => void;
  onMonitoringChange: (monitoring: MonitoringDraft) => void;
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
          ? <p>Bound conversation: <a href={`t3-thread://v1/${encodeURIComponent(snapshot.binding.threadId)}`}>Open in T3</a> <code>{snapshot.binding.threadId}</code></p>
        : <p>No Supervisor conversation is bound yet.</p>}
      <p className="muted">Saving settings does not start a conversation. T3 creates the Supervisor conversation for the first task that needs it, then reuses that conversation for later tasks.</p>
      <p className="muted">Supervisor work runs in the project root. Role instructions limit it to reading and messaging through T3, but those instructions do not enforce tool restrictions.</p>
      <p>{snapshot.message}</p>
      <p><strong>Saved Supervisor model:</strong> {formatModel(snapshot, snapshot.settings.modelSelection)}</p>
      <p><strong>Current model observed in T3:</strong> {formatModel(snapshot, snapshot.modelSelection)}</p>
      {snapshot.settings.pending && snapshot.binding?.state === "ready" && <p role="status">T3 is waiting to apply the saved model selection while the Supervisor is idle.</p>}
      {snapshot.settings.pending && !snapshot.binding && <p role="status">The saved model selection will apply when T3 creates the Supervisor conversation for the first needed task.</p>}
      {!snapshot.available && <p role="status">Supervisor settings are currently unavailable.</p>}
    </div>

    <form className="panel stack" onSubmit={onSubmit} aria-label="Supervisor settings">
      <fieldset disabled={fieldsDisabled} className="stack">
        <legend>Model selection</legend>
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
        <p className="muted">Monitoring wakes the project’s ordinary Supervisor chat when pending activity reaches its maximum age or the finalized activity threshold. Defaults apply to new task workflows; existing objective-only tasks are not reprocessed.</p>
        {snapshot.monitoringStatus && <section className="stack" aria-labelledby="supervisor-monitoring-status-title">
          <h4 id="supervisor-monitoring-status-title">Current monitoring status</h4>
          <p><strong>Status:</strong> {snapshot.monitoringStatus.state}</p>
          <p><strong>Pending activities:</strong> {snapshot.monitoringStatus.pendingItems}</p>
          <p><strong>Next review:</strong> {formatMonitoringTime(snapshot.monitoringStatus.nextReviewAt)}</p>
          <p><strong>Last notice:</strong> {formatMonitoringTime(snapshot.monitoringStatus.lastNoticeAt)}</p>
          <p>{snapshot.monitoringStatus.message}</p>
        </section>}
        <div className="stack">
          <label htmlFor="supervisor-monitoring-enabled">Enable ongoing monitoring</label>
          <input id="supervisor-monitoring-enabled" name="monitoringEnabled" type="checkbox" checked={monitoring.enabled}
            aria-describedby="supervisor-monitoring-enabled-help" onChange={event => onMonitoringChange({...monitoring, enabled: event.target.checked})} />
          <span id="supervisor-monitoring-enabled-help" className="small muted">Turn this off to pause monitoring sends for this project.</span>
        </div>
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
        <p><strong>Project cooldown:</strong> 60 seconds between monitoring sends.</p>
        <p><strong>Model review limit:</strong> one in-flight review per project.</p>
      </fieldset>
      <button type="submit" disabled={!canSave || saving || blocked}>{saving ? "Saving…" : "Save Supervisor settings"}</button>
      {dirty && <button type="button" disabled={saving || blocked} onClick={onDiscard}>Discard draft</button>}
    </form>

    {shouldOfferRetry && <div className="panel stack">
      <h3>{snapshot.binding?.state === "missing" ? "Deleted Supervisor conversation" : "Native Supervisor access"}</h3>
      <p className="muted">{snapshot.binding?.state === "missing"
        ? "T3 confirmed that the bound conversation was deleted. This explicit action replaces it with a new Supervisor conversation."
        : "Use this explicit action to retry the project's pending or rejected native operation."}</p>
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
  const activeProject = useRef(projectId);
  const draftRef = useRef(drafts);
  const savingRef = useRef(false);
  const activeLoadKey = useRef("");
  const completedLoadKey = useRef("");
  activeProject.current = projectId;
  draftRef.current = drafts;

  const activeSnapshot = snapshotState?.projectId === projectId ? snapshotState.snapshot : null;
  const activeDraft = drafts[projectId] ?? null;
  const modelDirty = Boolean(activeDraft && selectionKey(activeDraft.modelValue) !== selectionKey(activeDraft.modelBaseline));
  const monitoringDirty = Boolean(activeDraft && !sameMonitoring(activeDraft.monitoringValue, activeDraft.monitoringBaseline));
  const dirty = modelDirty || monitoringDirty;
  const requestKey = JSON.stringify([projectId, revision]);
  const isLoading = connected && loadState.key === requestKey && loadState.status === "loading";
  const loadError = loadState.key === requestKey && loadState.status === "error";
  const fieldsBusy = saving || isLoading;
  const selectedModel = activeSnapshot && activeDraft ? findModel(activeSnapshot, activeDraft.modelValue) : undefined;
  const validMonitoring = activeDraft ? parseMonitoringDraft(activeDraft.monitoringValue) : null;
  const canSave = Boolean(activeSnapshot?.available && activeDraft && dirty && validMonitoring && (!modelDirty || selectedModel?.available) && connected && !fieldsBusy && !blocked);
  const needsRetry = Boolean(activeSnapshot && shouldOfferNativeRetry(activeSnapshot));
  const retryButtonLabel = activeSnapshot?.binding?.state === "missing" ? "Replace deleted Supervisor conversation" : "Retry native access";
  const canRetry = Boolean(needsRetry && activeSnapshot?.available && activeSnapshot.binding && activeDraft && !dirty && connected && !fieldsBusy && !blocked);

  useEffect(() => {onDirtyChange?.(dirty);}, [dirty, onDirtyChange]);
  useEffect(() => {onSavingChange?.(saving);}, [saving, onSavingChange]);

  useEffect(() => {
    if (!projectId || !connected || saving) return;
    if (!forceRefresh && dirty && activeSnapshot) return;
    if (!forceRefresh && completedLoadKey.current === requestKey) return;
    const controller = new AbortController();
    activeLoadKey.current = requestKey;
    setLoadState({key: requestKey, status: "loading"});
    void loadProjectSupervisor(projectId, controller.signal).then(snapshot => {
      if (controller.signal.aborted || activeLoadKey.current !== requestKey || activeProject.current !== projectId) return;
      const priorDraft = draftRef.current[projectId] ?? null;
      const priorModelWasDirty = Boolean(priorDraft && selectionKey(priorDraft.modelValue) !== selectionKey(priorDraft.modelBaseline));
      const priorMonitoringWasDirty = Boolean(priorDraft && !sameMonitoring(priorDraft.monitoringValue, priorDraft.monitoringBaseline));
      const modelBaseline = copySelection(snapshot.settings.modelSelection);
      const modelValue = priorModelWasDirty ? copySelection(priorDraft!.modelValue) : copySelection(modelBaseline);
      const monitoringBaseline = readMonitoringDraft(snapshot);
      const monitoringValue = priorMonitoringWasDirty ? copyMonitoringDraft(priorDraft!.monitoringValue) : copyMonitoringDraft(monitoringBaseline);
      completedLoadKey.current = requestKey;
      setSnapshotState({projectId, snapshot});
      setDrafts(current => ({...current, [projectId]: {projectId, modelValue, modelBaseline, monitoringValue, monitoringBaseline, expectedGeneration: snapshot.settings.generation}}));
      setLoadState({key: requestKey, status: "idle"});
      setBlocked(false);
      if (forceRefresh) setPanelMessage({
        projectId,
        text: (priorModelWasDirty && selectionKey(modelValue) !== selectionKey(modelBaseline)) ||
          (priorMonitoringWasDirty && !sameMonitoring(monitoringValue, monitoringBaseline))
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

  const discardDraft = () => {
    if (saving || blocked) return;
    setDrafts(current => {
      const currentDraft = current[projectId];
      return currentDraft ? {...current, [projectId]: {
        ...currentDraft,
        modelValue: copySelection(currentDraft.modelBaseline),
        monitoringValue: copyMonitoringDraft(currentDraft.monitoringBaseline),
      }} : current;
    });
    setPanelMessage(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current || !canSave || !activeDraft || !activeSnapshot || !validMonitoring) return;
    const targetProject = projectId;
    const input = {
      projectId: targetProject,
      expectedGeneration: activeDraft.expectedGeneration,
      modelSelection: copySelection(activeDraft.modelValue),
      monitoring: copyMonitoringSettings(validMonitoring),
    };
    savingRef.current = true;
    setSaving(true);
    setPanelMessage(null);
    try {
      const result = await saveProjectSupervisor(input, csrfToken);
      if (activeProject.current !== targetProject) return;
      if (result.status === "saved") {
        if (result.snapshot) {
          const canonical = copySelection(result.snapshot.settings.modelSelection);
          const canonicalMonitoring = readMonitoring(result.snapshot);
          const canonicalMonitoringDraft = monitoringDraft(canonicalMonitoring);
          setSnapshotState({projectId: targetProject, snapshot: result.snapshot});
          setDrafts(current => ({...current, [targetProject]: {
            projectId: targetProject,
            modelValue: canonical,
            modelBaseline: copySelection(canonical),
            monitoringValue: copyMonitoringDraft(canonicalMonitoringDraft),
            monitoringBaseline: copyMonitoringDraft(canonicalMonitoringDraft),
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
        setSnapshotState({projectId: targetProject, snapshot: result.snapshot});
        setDrafts(current => {
          const currentDraft = current[targetProject];
          return currentDraft ? {...current, [targetProject]: {
            ...currentDraft,
            modelBaseline,
            monitoringBaseline,
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
      if (activeProject.current !== targetProject) return;
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
    const input = {
      projectId: targetProject,
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
      if (activeProject.current !== targetProject) return;
      if (result.status === "uncertain") {
        setBlocked(true);
        setPanelMessage({projectId: targetProject, text: result.message, alert: true});
      } else if (result.snapshot) {
        const canonical = copySelection(result.snapshot.settings.modelSelection);
        const canonicalMonitoring = readMonitoringDraft(result.snapshot);
        setSnapshotState({projectId: targetProject, snapshot: result.snapshot});
        setDrafts(current => ({...current, [targetProject]: {
          projectId: targetProject,
          modelValue: canonical,
          modelBaseline: copySelection(canonical),
          monitoringValue: copyMonitoringDraft(canonicalMonitoring),
          monitoringBaseline: copyMonitoringDraft(canonicalMonitoring),
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
      if (activeProject.current !== targetProject) return;
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
    <div><h2 id="project-supervisor-title">Project Supervisor settings</h2><p className="muted">Choose the model T3 should use for this project’s Supervisor tasks.</p></div>
    {!projectId && <p className="panel muted">Select a project to manage its Supervisor settings.</p>}
    {projectId && !connected && <p className="panel" role="status">T3 is disconnected. Any unsaved Supervisor settings draft is kept.</p>}
    {projectId && connected && !activeSnapshot && isLoading && <p className="panel" role="status">Loading Supervisor settings…</p>}
    {projectId && connected && loadError && <p className="panel" role="alert">Could not load Supervisor settings. Refresh to try again or check the T3 connection.</p>}
    {projectId && activeSnapshot && activeDraft && <ProjectSupervisorView
      snapshot={activeSnapshot}
      selection={activeDraft.modelValue}
      monitoring={activeDraft.monitoringValue}
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
      onSelectionChange={updateSelection}
      onMonitoringChange={updateMonitoring}
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
