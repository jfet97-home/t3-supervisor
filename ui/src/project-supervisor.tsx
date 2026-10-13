import React, { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  ProjectSupervisorInfo,
  SupervisorModelInfo,
  SupervisorModelSelection,
  WorkflowProposalInfo,
} from "../../src/project-supervisor-contract.js";
import { loadProjectSupervisor, ProjectSupervisorRequestError, retryProjectSupervisor, saveProjectSupervisor } from "./project-supervisor-api.js";

type Draft = {
  projectId: string;
  value: SupervisorModelSelection;
  baseline: SupervisorModelSelection;
  expectedGeneration: number;
};

type SnapshotState = {projectId: string; snapshot: ProjectSupervisorInfo};
type LoadState = {key: string; status: "idle" | "loading" | "error"};
type PanelMessage = {projectId: string; text: string; alert: boolean} | null;

const selectionKey = (selection: SupervisorModelSelection) => JSON.stringify(selection);
const copySelection = (selection: SupervisorModelSelection): SupervisorModelSelection => ({
  instanceId: selection.instanceId,
  model: selection.model,
  options: selection.options.map(option => ({...option})),
});
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

export const shouldOfferNativeRetry = (snapshot: ProjectSupervisorInfo) =>
  snapshot.binding?.state === "uncertain" ||
  snapshot.binding?.state === "rejected" ||
  snapshot.binding?.state === "missing" ||
  snapshot.tasks.some(task => task.status === "uncertain") ||
  snapshot.settings.pending && snapshot.binding?.state === "ready";

function WorkflowProposalView({workflow}: {workflow: WorkflowProposalInfo | null | undefined}) {
  if (workflow == null) return <section className="stack" aria-labelledby="workflow-proposal-title">
    <h4 id="workflow-proposal-title">Workflow proposal</h4>
    <p className="muted">No workflow proposal was recorded for this task. Earlier objective-only records are not automatically reprocessed.</p>
  </section>;

  const orderedRules = [...workflow.rules].sort((left, right) => left.index - right.index);

  return <section className="stack" aria-labelledby="workflow-proposal-title">
    <h4 id="workflow-proposal-title">Workflow proposal</h4>
    <p><strong>Status:</strong> {workflow.status}</p>
    <p>{workflow.message}</p>
    {workflow.status === "proposed" && <p className="muted">This is an advisory draft. It has not been accepted or executed.</p>}

    <div className="stack">
      <h5>Provenance</h5>
      <p><strong>Workspace root:</strong> {workflow.workspaceRoot === null ? "Not recorded" : <code>{workflow.workspaceRoot}</code>}</p>
      <p><strong>Rules revision:</strong> {workflow.revision === null ? "Not recorded" : <code>{workflow.revision}</code>}</p>
    </div>

    <div className="stack">
      <h5>Rule applicability</h5>
      {orderedRules.length > 0
        ? <ol className="stack">{orderedRules.map(rule => <li key={`${rule.index}:${rule.name}`}>
          <strong>{rule.name}</strong>
          <p><strong>Decision:</strong> {rule.applies ? "Applies" : "Does not apply"}</p>
          <p>{rule.reason}</p>
        </li>)}</ol>
        : <p className="muted">No rules were evaluated for this proposal.</p>}
    </div>

    <div className="stack">
      <h5>Proposed steps</h5>
      {workflow.steps.length > 0
        ? <ol className="stack">{workflow.steps.map((step, index) => <li key={`${step.blockId}:${index}`}>
          <strong>Step {index + 1}: {step.name}</strong>
          <p><strong>Block ID:</strong> <code>{step.blockId}</code></p>
          <p>{step.reason}</p>
        </li>)}</ol>
        : <p className="muted">{workflow.status === "proposed" ? "No workflow steps were proposed." : "No workflow steps are available for this proposal."}</p>}
    </div>
  </section>;
}

export function ProjectSupervisorView({
  snapshot,
  selection,
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
  onDiscard,
  onRetry,
  onSubmit,
}: {
  snapshot: ProjectSupervisorInfo;
  selection: SupervisorModelSelection;
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
        <label>Model
          <select value={selectedModelKey(selection)} disabled={!modelCanChange} onChange={event => {
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
        </label>
        {reasoning && reasoning.choices.length > 0 && <label>{reasoning.label}
          <select value={encodeChoice(reasoningValue!)} disabled={!reasoningCanChange} onChange={event => {
            const value = parseChoice(event.target.value);
            onSelectionChange(withReasoningValue(selection, selected!, reasoning.id, value));
          }}>
            {!reasoningIsAdvertised && <option value={encodeChoice(reasoningValue!)} disabled>Stored value: {String(reasoningValue)}</option>}
            {reasoning.choices.map(choice => <option key={encodeChoice(choice.value)} value={encodeChoice(choice.value)}>{choice.label}</option>)}
          </select>
        </label>}
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
      <WorkflowProposalView workflow={selectedTask.workflow} />
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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({key: "", status: "idle"});
  const [panelMessage, setPanelMessage] = useState<PanelMessage>(null);
  const [revision, setRevision] = useState(0);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const activeProject = useRef(projectId);
  const draftRef = useRef(draft);
  const savingRef = useRef(false);
  const activeLoadKey = useRef("");
  const completedLoadKey = useRef("");
  activeProject.current = projectId;
  draftRef.current = draft;

  const activeSnapshot = snapshotState?.projectId === projectId ? snapshotState.snapshot : null;
  const activeDraft = draft?.projectId === projectId ? draft : null;
  const dirty = Boolean(activeDraft && selectionKey(activeDraft.value) !== selectionKey(activeDraft.baseline));
  const requestKey = JSON.stringify([projectId, revision]);
  const isLoading = connected && loadState.key === requestKey && loadState.status === "loading";
  const loadError = loadState.key === requestKey && loadState.status === "error";
  const fieldsBusy = saving || isLoading;
  const selectedModel = activeSnapshot && activeDraft ? findModel(activeSnapshot, activeDraft.value) : undefined;
  const canSave = Boolean(activeSnapshot?.available && selectedModel?.available && activeDraft && dirty && connected && !fieldsBusy && !blocked);
  const needsRetry = Boolean(activeSnapshot && shouldOfferNativeRetry(activeSnapshot));
  const retryButtonLabel = activeSnapshot?.binding?.state === "missing" ? "Replace deleted Supervisor conversation" : "Retry native access";
  const canRetry = Boolean(needsRetry && activeSnapshot?.available && activeSnapshot.binding && activeDraft && !dirty && connected && !fieldsBusy && !blocked);

  useEffect(() => {onDirtyChange?.(dirty);}, [dirty, onDirtyChange]);
  useEffect(() => {onSavingChange?.(saving);}, [saving, onSavingChange]);

  useEffect(() => {
    if (!projectId || !connected || saving) return;
    if (!forceRefresh && dirty) return;
    if (!forceRefresh && completedLoadKey.current === requestKey) return;
    const controller = new AbortController();
    activeLoadKey.current = requestKey;
    setLoadState({key: requestKey, status: "loading"});
    void loadProjectSupervisor(projectId, controller.signal).then(snapshot => {
      if (controller.signal.aborted || activeLoadKey.current !== requestKey || activeProject.current !== projectId) return;
      const priorDraft = draftRef.current?.projectId === projectId ? draftRef.current : null;
      const priorWasDirty = Boolean(priorDraft && selectionKey(priorDraft.value) !== selectionKey(priorDraft.baseline));
      const baseline = copySelection(snapshot.settings.modelSelection);
      const value = priorWasDirty ? copySelection(priorDraft!.value) : copySelection(baseline);
      completedLoadKey.current = requestKey;
      setSnapshotState({projectId, snapshot});
      setDraft({projectId, value, baseline, expectedGeneration: snapshot.settings.generation});
      setLoadState({key: requestKey, status: "idle"});
      setBlocked(false);
      if (forceRefresh) setPanelMessage({
        projectId,
        text: priorWasDirty && selectionKey(value) !== selectionKey(baseline)
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
  }, [projectId, connected, saving, dirty, forceRefresh, requestKey]);

  const refresh = () => {
    if (!projectId || !connected || saving || isLoading) return;
    setForceRefresh(true);
    setRevision(value => value + 1);
  };

  const updateSelection = (selection: SupervisorModelSelection) => {
    setDraft(current => current?.projectId === projectId ? {...current, value: copySelection(selection)} : current);
    setPanelMessage(null);
  };

  const discardDraft = () => {
    if (saving || blocked) return;
    setDraft(current => current?.projectId === projectId ? {...current, value: copySelection(current.baseline)} : current);
    setPanelMessage(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current || !canSave || !activeDraft || !activeSnapshot) return;
    const targetProject = projectId;
    const input = {
      projectId: targetProject,
      expectedGeneration: activeDraft.expectedGeneration,
      modelSelection: copySelection(activeDraft.value),
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
          setSnapshotState({projectId: targetProject, snapshot: result.snapshot});
          setDraft({projectId: targetProject, value: canonical, baseline: copySelection(canonical), expectedGeneration: result.snapshot.settings.generation});
          setBlocked(false);
          setPanelMessage({projectId: targetProject, text: result.message, alert: false});
        } else {
          setDraft(current => current?.projectId === targetProject ? {...current, value: copySelection(input.modelSelection), baseline: copySelection(input.modelSelection)} : current);
          setBlocked(true);
          setPanelMessage({projectId: targetProject, text: `${result.message} Refresh Supervisor settings before making another change.`, alert: false});
        }
      } else if (result.status === "uncertain") {
        setBlocked(true);
        setPanelMessage({projectId: targetProject, text: result.message, alert: true});
      } else if (result.snapshot) {
        const baseline = copySelection(result.snapshot.settings.modelSelection);
        setSnapshotState({projectId: targetProject, snapshot: result.snapshot});
        setDraft(current => current?.projectId === targetProject ? {...current, baseline, expectedGeneration: result.snapshot!.settings.generation} : current);
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
        setSnapshotState({projectId: targetProject, snapshot: result.snapshot});
        setDraft({projectId: targetProject, value: canonical, baseline: copySelection(canonical), expectedGeneration: result.snapshot.settings.generation});
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
      selection={activeDraft.value}
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
