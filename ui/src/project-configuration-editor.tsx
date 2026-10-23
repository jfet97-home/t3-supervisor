import React, { useEffect, useId, useRef } from "react";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { catalogEntryId, catalogSummaryLimits, normalizeProjectConfiguration, projectConfigurationError, requiredReferences, type ProjectConfigSave, type ProjectConfigSaveOutcome, type ProjectConfigurationInfo, type ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { draftFamily, environmentAtom, scopeKey } from "./atoms.js";
import { resolveSave, saveProjectConfigurationAtom, type ProjectConfigRequestError } from "./project-definitions-api.js";

const emptyConfiguration = (): ProjectConfigurationInfo => ({workflows: [], steps: []});
const copyConfiguration = (value: ProjectConfigurationInfo): ProjectConfigurationInfo => ({
  workflows: value.workflows.map(entry => ({...entry})),
  steps: value.steps.map(entry => ({...entry})),
  ...(value.default_workflow === undefined ? {} : {default_workflow: value.default_workflow}),
});
type CatalogKind = "workflows" | "steps";

// the editor state of one loaded project.yaml revision (CC-UI-DRAFTS): kept across navigation, unmount, session expiry
// and re-sign-in; it equals the saved configuration after a verified save, is kept on failure or uncertainty and is
// discarded by Cancel and by the panel's confirmed discard
export interface ConfigurationDraft {
  readonly editing: boolean;
  // null until the first edit: the loaded configuration
  readonly config: ProjectConfigurationInfo | null;
  // the admitted save of the next or current attempt; a settled attempt gets a new id, so nothing is replayed
  readonly operationId: string;
  readonly blocked: boolean;
  readonly message: string;
  readonly messageAlert: boolean;
}
export const freshDraft = (): ConfigurationDraft =>
  ({editing: false, config: null, operationId: crypto.randomUUID(), blocked: false, message: "", messageAlert: false});
export const configurationDrafts = draftFamily(freshDraft);
// the draft scope of a loaded snapshot: T3 environment, project, checkout and the revision its save is compared against
export const configurationScope = (environmentId: string | null, definitions: ProjectDefinitionSnapshot): string =>
  scopeKey(environmentId, definitions.projectId, definitions.threadId, definitions.revision);

export type SavePlan =
  | {readonly _tag: "Invalid"; readonly message: string}
  | {readonly _tag: "Declined"}
  | {readonly _tag: "Save"; readonly normalized: ProjectConfigurationInfo; readonly input: ProjectConfigSave};

// validates the draft before asking to write the exact project.yaml path; the save compares against the loaded revision
export const planSave = (definitions: ProjectDefinitionSnapshot, config: ProjectConfigurationInfo, ask: (question: string) => boolean): SavePlan => {
  const normalized = normalizeProjectConfiguration(config);
  const validationError = projectConfigurationError(normalized);
  if (validationError) return {_tag: "Invalid", message: validationError};
  const action = definitions.projectConfig ? "Save project configuration" : "Replace the unreadable project.yaml with this configuration";
  if (!ask(`${action} at ${definitions.workspaceRoot}/.t3-supervisor/project.yaml? This updates the selected working tree.`)) return {_tag: "Declined"};
  return {_tag: "Save", normalized, input: {
    projectId: definitions.projectId,
    threadId: definitions.threadId,
    expectedRevision: definitions.revision!,
    config: copyConfiguration(normalized),
  }};
};

// the definitions of a verified save, which replace the loaded snapshot
export const savedDefinitions = (outcome: Exit.Exit<ProjectConfigSaveOutcome, ProjectConfigRequestError>): ProjectDefinitionSnapshot | null =>
  Exit.isSuccess(outcome) && outcome.value.status === "saved" ? outcome.value.definitions : null;

// the draft after a resolved save: a conflict, an uncertain, unavailable or permission_required answer, a saved answer
// without definitions and any unconfirmed failure block further saves; a definite refusal keeps editing allowed
export const settleSave = (draft: ConfigurationDraft, outcome: Exit.Exit<ProjectConfigSaveOutcome, ProjectConfigRequestError>, normalized: ProjectConfigurationInfo): ConfigurationDraft => {
  const next = {...draft, operationId: crypto.randomUUID()};
  if (Exit.isFailure(outcome)) {
    const failure = Option.getOrUndefined(Cause.findErrorOption(outcome.cause));
    return {...next, message: failure?.message ?? "Save outcome unknown. Refresh before retrying.", messageAlert: true, blocked: !failure?.definitelyNotSaved};
  }
  const result = outcome.value;
  if (result.status === "saved" && result.definitions)
    return {...next, config: copyConfiguration(result.definitions.projectConfig ?? normalized), message: result.message, messageAlert: false, editing: false};
  if (result.status === "saved")
    return {...next, message: `${result.message} Refresh definitions to inspect the saved project.yaml before editing again.`, messageAlert: true, blocked: true};
  return {...next, message: result.message, messageAlert: true,
    blocked: result.status === "conflict" || result.status === "uncertain" || result.status === "unavailable" || result.status === "permission_required"};
};

// the callbacks through which the editor reports to its panel
export interface EditorReports {
  readonly onSaved: (result: ProjectDefinitionSnapshot) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onSavingChange: (saving: boolean) => void;
}

// applies a resolved save to the draft it was made from, reports that the save is over and reports a verified save; it runs
// when the save settles, also after the editor that started it is gone, and reports only to the callbacks of the view it
// was started from
export const completeSave = (outcome: Exit.Exit<ProjectConfigSaveOutcome, ProjectConfigRequestError>, normalized: ProjectConfigurationInfo,
  setDraft: (change: (draft: ConfigurationDraft) => ConfigurationDraft) => void, reports: EditorReports) => {
  setDraft(current => settleSave(current, outcome, normalized));
  reports.onSavingChange(false);
  const saved = savedDefinitions(outcome);
  if (saved) {reports.onDirtyChange(false);reports.onSaved(saved);}
};

// The index is the source of rows, including entries whose full definition cannot be read.
export function ProjectCatalogFields({kind, config, definitions, disabled, onChange}: {
  kind: CatalogKind;
  config: ProjectConfigurationInfo;
  definitions: ProjectDefinitionSnapshot;
  disabled: boolean;
  onChange: (config: ProjectConfigurationInfo) => void;
}) {
  const prefix = useId();
  const singular = kind === "steps" ? "step" : "workflow";
  const entries = config[kind];
  const unlisted = (definitions.definitionFiles ?? []).filter(file => file.origin === "project" && file.kind === kind && !entries.some(entry => entry.path === file.path));
  const updateEntry = (index: number, change: Partial<ProjectConfigurationInfo["steps"][number]>) =>
    onChange({...config, [kind]: entries.map((entry, position) => position === index ? {...entry, ...change} : entry)});
  return <fieldset disabled={disabled} className="stack">
    <legend>{kind === "steps" ? "Steps" : "Workflows"} <span className="muted">({entries.length})</span></legend>
    <p id={`${prefix}-help`} className="muted">List every reusable {singular} file in this checkout. Paths are relative to <code>.t3-supervisor</code>; removing a row does not delete its file.</p>
    {entries.map((entry, index) => {
      const field = `${prefix}-${index}`;
      const id = catalogEntryId(kind, entry.path);
      const definition = id ? definitions[kind].find(item => item.origin === "project" && item.id === id) : undefined;
      return <fieldset key={index} className="stack project-config-entry">
        <legend>{kind === "steps" ? "Step" : "Workflow"} {index + 1}</legend>
        <div className="project-config-identity">
          <label htmlFor={`${field}-path`}>Path
            <input id={`${field}-path`} value={entry.path} required autoCapitalize="none" spellCheck={false} aria-describedby={`${field}-path-help`} onChange={event => updateEntry(index, {path: event.target.value})}/>
          </label>
        </div>
        <p id={`${field}-path-help`} className="muted small definition-path">Use <code>{kind}/&lt;id&gt;.{kind === "steps" ? "md" : "yaml"}</code>; the file name is the definition ID{id ? <> (<code>{id}</code>)</> : null}.</p>
        <label htmlFor={`${field}-summary`}>Summary</label>
        <textarea id={`${field}-summary`} className="project-config-summary" rows={2} maxLength={catalogSummaryLimits.maxChars} required value={entry.summary} aria-describedby={`${field}-summary-help`} onChange={event => updateEntry(index, {summary: event.target.value})}/>
        <p id={`${field}-summary-help`} className="muted small">Briefly explain purpose or applicability from the full description. At most 2 lines · {entry.summary.length}/240 characters. The definition file remains the full policy.</p>
        <div className="row between">
          <label className="project-config-required" htmlFor={`${field}-required`}><input id={`${field}-required`} type="checkbox" checked={entry.required} onChange={event => updateEntry(index, {required: event.target.checked})}/> Required</label>
          <button type="button" onClick={() => onChange({...config, [kind]: entries.filter((_, position) => position !== index)})}>Remove {singular} {index + 1}</button>
        </div>
        {id && !definition && <p className="muted small">Missing or invalid in the current read. This entry and its required flag are kept; saving checks the indexed file again.</p>}
      </fieldset>;
    })}
    {entries.length === 0 && <p>No local {kind} are indexed. Any existing {singular} files must be added before this index is valid.</p>}
    {unlisted.length > 0 && <div className="stack"><p>Files not indexed in this draft:</p><ul className="project-config-unlisted">{unlisted.map(file => <li key={file.path}><code>{file.path}</code> <button type="button" disabled={config.steps.length + config.workflows.length >= catalogSummaryLimits.maxEntries} onClick={() => onChange({...config, [kind]: [...entries, {path: file.path, summary: "", required: false}]})}>Index {file.path}</button></li>)}</ul></div>}
    <div><button type="button" disabled={config.steps.length + config.workflows.length >= catalogSummaryLimits.maxEntries} onClick={() => onChange({...config, [kind]: [...entries, {path: "", summary: "", required: false}]})}>Add {singular}</button></div>
  </fieldset>;
}

export function ProjectConfigurationEditor({definitions, onSaved, onDirtyChange, onSavingChange}: {
  definitions: ProjectDefinitionSnapshot;
  onSaved: (result: ProjectDefinitionSnapshot) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const scope = configurationScope(useAtomValue(environmentAtom), definitions);
  const [draft, setDraft] = useAtom(configurationDrafts(scope));
  const attempt = saveProjectConfigurationAtom({scope, operationId: draft.operationId});
  const save = useAtomSet(attempt, {mode: "promiseExit"});
  const saving = AsyncResult.isWaiting(useAtomValue(attempt));
  const {editing, blocked, message, messageAlert} = draft;
  const error = useRef<HTMLParagraphElement>(null);
  const messageId = useId();
  const projectConfig = definitions.projectConfig;
  const config = draft.config ?? copyConfiguration(projectConfig ?? emptyConfiguration());
  const brokenConfigSource = definitions.sources.find(source => source.origin === "project" && source.path === ".t3-supervisor/project.yaml");
  const baseline = projectConfig ? copyConfiguration(projectConfig) : null;
  const dirty = baseline ? JSON.stringify(config) !== JSON.stringify(baseline) : editing && brokenConfigSource !== undefined;
  useEffect(() => {onDirtyChange(dirty);}, [dirty, onDirtyChange]);
  useEffect(() => {onSavingChange(saving);}, [saving, onSavingChange]);
  useEffect(() => {if (message && messageAlert) error.current?.focus();}, [message, messageAlert]);
  const update = (next: ProjectConfigurationInfo) => setDraft(current => ({...current, config: next, message: "", messageAlert: false}));
  const workflowIds = [...new Set(config.workflows.flatMap(workflow => catalogEntryId("workflows", workflow.path) ?? []))];
  const unreadableSource = brokenConfigSource && <details className="definition-block"><summary>Inspect the unreadable project.yaml source</summary><pre className="definition-copy">{brokenConfigSource.content}</pre></details>;

  if (definitions.globalOnly) return <div className="panel stack"><h3>Project configuration</h3><p className="muted">This view is global-only. Its definitions are inspectable, but a project editor does not write global files.</p></div>;
  if (!definitions.editingAvailable) return <div className="panel stack"><h3>Project configuration</h3><p className="muted">Editing needs a dedicated filesystem read/write credential configured through deployment setup.</p></div>;
  if (!definitions.complete || !definitions.revision) return <div className="panel stack"><h3>Project configuration</h3><p className="muted">Editing requires a complete read and a current revision. Refresh after access or repository issues are resolved.</p></div>;
  if (!projectConfig && !brokenConfigSource) return <div className="panel stack"><h3>Project configuration</h3><p className="muted">This checkout has no readable project.yaml to update. Create <code>.t3-supervisor/project.yaml</code> with <code>workflows: []</code> and <code>steps: []</code>, then index any existing definitions and refresh.</p></div>;

  if (!editing) {
    const required = projectConfig ? requiredReferences(projectConfig).map(reference => "step" in reference ? `step:${reference.step}` : `workflow:${reference.workflow}`) : [];
    return <div className="panel stack project-configuration-summary">
      <div>
        <h3>{projectConfig ? "Project configuration" : "Project configuration needs repair"}</h3>
        <p className="muted">This editor changes only the selected checkout's <code>.t3-supervisor/project.yaml</code>. Reusable step and workflow files remain read-only here.</p>
      </div>
      {projectConfig
        ? <><p><strong>Local index:</strong> {projectConfig.workflows.length} workflows · {projectConfig.steps.length} steps</p>
          <p><strong>Required in this checkout:</strong> {required.length === 0 ? "None" : required.join(", ")}</p>
          <p><strong>Default workflow:</strong> {projectConfig.default_workflow ?? "None"} <span className="muted">· starting suggestion</span></p></>
        : <><p>The existing file was read but could not be parsed, so its requirements are unknown. The repair form starts with an empty replacement draft; that does not mean the unreadable file had no requirements.</p>{unreadableSource}</>}
      <div><button type="button" onClick={() => setDraft(current => ({...current, editing: true}))}>{projectConfig ? "Edit project configuration" : "Repair project configuration"}</button></div>
    </div>;
  }

  return <form className="panel stack project-configuration-editor" method="post" action="/api/guidance/project-configuration" noValidate aria-describedby={message ? messageId : undefined} onSubmit={async event => {
    event.preventDefault();
    if (saving || blocked) return;
    const plan = planSave(definitions, config, question => confirm(question));
    if (plan._tag === "Invalid") {setDraft(current => ({...current, message: plan.message, messageAlert: true}));error.current?.focus();return;}
    if (plan._tag === "Declined") return;
    setDraft(current => ({...current, message: "", messageAlert: false}));
    completeSave(resolveSave(plan.input)(await save(plan.input)), plan.normalized, setDraft, {onSaved, onDirtyChange, onSavingChange});
  }}>
    <div className="stack">
      <h3>{projectConfig ? "Edit project configuration" : "Repair project configuration"}</h3>
      <p className="definition-path">Target: <code>{definitions.workspaceRoot}/.t3-supervisor/project.yaml</code></p>
      <p className="muted">Index every reusable file, including optional definitions. Required flags apply to this checkout; enabled global requirements remain separate and read-only. Full definition files hold policy.</p>
      {!projectConfig && <><p className="panel" role="note">The current file could not be parsed. This replacement starts with empty workflows and steps lists; its original requirements remain unknown. Review the source before saving.</p>{unreadableSource}</>}
    </div>
    <ProjectCatalogFields kind="workflows" config={config} definitions={definitions} disabled={saving || blocked} onChange={update}/>
    <ProjectCatalogFields kind="steps" config={config} definitions={definitions} disabled={saving || blocked} onChange={update}/>
    <fieldset disabled={saving || blocked} className="stack">
      <legend>Default workflow</legend>
      <label htmlFor="project-config-default-workflow">Starting workflow suggestion</label>
      <select id="project-config-default-workflow" value={config.default_workflow ?? ""} aria-describedby="project-config-default-help" onChange={event => {
        const index = {workflows: config.workflows, steps: config.steps};
        update(event.target.value ? {...index, default_workflow: event.target.value} : index);
      }}>
        <option value="">No default workflow</option>
        {config.default_workflow && !workflowIds.includes(config.default_workflow) && <option value={config.default_workflow}>{config.default_workflow} · missing from index</option>}
        {workflowIds.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
      <p id="project-config-default-help" className="muted">Choose an indexed workflow in this checkout. Task plans can use other workflows, new combinations and local steps while preserving required and fixed commitments.</p>
    </fieldset>
    <p id={messageId} ref={error} tabIndex={-1} role={messageAlert ? "alert" : "status"}>{message}</p>
    {blocked && <p>Your draft is kept. Refresh project definitions and inspect project.yaml before trying again.</p>}
    <div className="row">
      <button className="primary" type="submit" disabled={saving || blocked}>{saving ? "Saving…" : "Save project configuration"}</button>
      <button type="button" disabled={saving} onClick={() => {
        if (dirty && !confirm("Discard unsaved project configuration changes?")) return;
        setDraft(freshDraft());onDirtyChange(false);
      }}>Cancel editing</button>
    </div>
  </form>;
}
