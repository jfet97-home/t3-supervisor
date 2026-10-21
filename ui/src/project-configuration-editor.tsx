import React, { useEffect, useId, useRef, useState } from "react";
import { catalogSummaryLimits, definitionCatalogPath, normalizeProjectConfiguration, projectConfigurationError, requiredReferences, type ProjectConfigurationInfo, type ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ProjectConfigRequestError, saveProjectConfiguration } from "./project-definitions-api.js";

const emptyConfiguration = (): ProjectConfigurationInfo => ({workflows: [], steps: []});
const copyConfiguration = (value: ProjectConfigurationInfo): ProjectConfigurationInfo => ({
  workflows: value.workflows.map(entry => ({...entry})),
  steps: value.steps.map(entry => ({...entry})),
  ...(value.default_workflow === undefined ? {} : {default_workflow: value.default_workflow}),
});
type CatalogKind = "workflows" | "steps";
const canonicalPath = (kind: CatalogKind, id: string) => id ? definitionCatalogPath(kind, id) : "";

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
      const definition = definitions[kind].find(item => item.origin === "project" && item.id === entry.id);
      return <fieldset key={index} className="stack project-config-entry">
        <legend>{kind === "steps" ? "Step" : "Workflow"} {index + 1}</legend>
        <div className="project-config-identity">
          <label htmlFor={`${field}-id`}>ID
            <input id={`${field}-id`} value={entry.id} required maxLength={64} autoCapitalize="none" spellCheck={false} aria-describedby={`${prefix}-help`} onChange={event => {
              const id = event.target.value;
              updateEntry(index, {id, ...(entry.path === canonicalPath(kind, entry.id) || !entry.path ? {path: canonicalPath(kind, id)} : {})});
            }}/>
          </label>
          <label htmlFor={`${field}-path`}>Path
            <input id={`${field}-path`} value={entry.path} required autoCapitalize="none" spellCheck={false} aria-describedby={`${field}-path-help`} onChange={event => updateEntry(index, {path: event.target.value})}/>
          </label>
        </div>
        <p id={`${field}-path-help`} className="muted small definition-path">Use <code>{kind}/&lt;id&gt;.{kind === "steps" ? "md" : "yaml"}</code>, matching the ID above.</p>
        <label htmlFor={`${field}-summary`}>Summary</label>
        <textarea id={`${field}-summary`} className="project-config-summary" rows={2} maxLength={catalogSummaryLimits.maxChars} required value={entry.summary} aria-describedby={`${field}-summary-help`} onChange={event => updateEntry(index, {summary: event.target.value})}/>
        <p id={`${field}-summary-help`} className="muted small">Briefly explain purpose or applicability from the full description. At most 2 lines · {entry.summary.length}/240 characters. The definition file remains the full policy.</p>
        <div className="row between">
          <label className="project-config-required" htmlFor={`${field}-required`}><input id={`${field}-required`} type="checkbox" checked={entry.required} onChange={event => updateEntry(index, {required: event.target.checked})}/> Required</label>
          <button type="button" onClick={() => onChange({...config, [kind]: entries.filter((_, position) => position !== index)})}>Remove {singular} {index + 1}</button>
        </div>
        {entry.id && !definition && <p className="muted small">Missing or invalid in the current read. This entry and its required flag are kept; saving checks the indexed file again.</p>}
      </fieldset>;
    })}
    {entries.length === 0 && <p>No local {kind} are indexed. Any existing {singular} files must be added before this index is valid.</p>}
    {unlisted.length > 0 && <div className="stack"><p>Files not indexed in this draft:</p><ul className="project-config-unlisted">{unlisted.map(file => <li key={file.path}><code>{file.path}</code> <button type="button" disabled={config.steps.length + config.workflows.length >= catalogSummaryLimits.maxEntries} onClick={() => onChange({...config, [kind]: [...entries, {id: file.id, path: file.path, summary: "", required: false}]})}>Index {file.id}</button></li>)}</ul></div>}
    <div><button type="button" disabled={config.steps.length + config.workflows.length >= catalogSummaryLimits.maxEntries} onClick={() => onChange({...config, [kind]: [...entries, {id: "", path: "", summary: "", required: false}]})}>Add {singular}</button></div>
  </fieldset>;
}

export function ProjectConfigurationEditor({definitions, csrfToken, onSaved, onDirtyChange, onSavingChange}: {
  definitions: ProjectDefinitionSnapshot;
  csrfToken: string;
  onSaved: (result: ProjectDefinitionSnapshot) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [config, setConfig] = useState<ProjectConfigurationInfo>(() => copyConfiguration(definitions.projectConfig ?? emptyConfiguration()));
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [messageAlert, setMessageAlert] = useState(false);
  const error = useRef<HTMLParagraphElement>(null);
  const messageId = useId();
  const projectConfig = definitions.projectConfig;
  const brokenConfigSource = definitions.sources.find(source => source.origin === "project" && source.path === ".t3-supervisor/project.yaml");
  const baseline = projectConfig ? copyConfiguration(projectConfig) : null;
  const dirty = baseline ? JSON.stringify(config) !== JSON.stringify(baseline) : editing && brokenConfigSource !== undefined;
  useEffect(() => {onDirtyChange(dirty);}, [dirty, onDirtyChange]);
  useEffect(() => {if (message && messageAlert) error.current?.focus();}, [message, messageAlert]);
  const update = (next: ProjectConfigurationInfo) => {setConfig(next);setMessage("");setMessageAlert(false);};
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
      <div><button type="button" onClick={() => setEditing(true)}>{projectConfig ? "Edit project configuration" : "Repair project configuration"}</button></div>
    </div>;
  }

  return <form className="panel stack project-configuration-editor" method="post" action="/api/guidance/project-configuration" noValidate aria-describedby={message ? messageId : undefined} onSubmit={async event => {
    event.preventDefault();
    if (saving || blocked) return;
    const normalized = normalizeProjectConfiguration(config);
    const validationError = projectConfigurationError(normalized);
    if (validationError) {setMessage(validationError);setMessageAlert(true);error.current?.focus();return;}
    const action = projectConfig ? "Save project configuration" : "Replace the unreadable project.yaml with this configuration";
    if (!confirm(`${action} at ${definitions.workspaceRoot}/.t3-supervisor/project.yaml? This updates the selected working tree.`)) return;
    setSaving(true);onSavingChange(true);setMessage("");setMessageAlert(false);
    try {
      const result = await saveProjectConfiguration({
        projectId: definitions.projectId,
        threadId: definitions.threadId,
        expectedRevision: definitions.revision!,
        config: copyConfiguration(normalized),
      }, csrfToken);
      if (result.status === "saved" && result.definitions) {
        setConfig(copyConfiguration(result.definitions.projectConfig ?? normalized));
        setMessage(result.message);setMessageAlert(false);onDirtyChange(false);setEditing(false);onSaved(result.definitions);
      } else if (result.status === "saved") {
        setMessage(`${result.message} Refresh definitions to inspect the saved project.yaml before editing again.`);setMessageAlert(true);setBlocked(true);
      } else {
        setMessage(result.message);setMessageAlert(true);
        setBlocked(result.status === "conflict" || result.status === "uncertain" || result.status === "unavailable" || result.status === "permission_required");
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Save outcome unknown. Refresh before retrying.");
      setMessageAlert(true);
      setBlocked(!(cause instanceof ProjectConfigRequestError && cause.definitelyNotSaved));
    } finally {setSaving(false);onSavingChange(false);}
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
        {config.default_workflow && !config.workflows.some(workflow => workflow.id === config.default_workflow) && <option value={config.default_workflow}>{config.default_workflow} · missing from index</option>}
        {config.workflows.filter(workflow => workflow.id).map((workflow, index) => <option key={index} value={workflow.id}>{workflow.id}</option>)}
      </select>
      <p id="project-config-default-help" className="muted">Choose an indexed workflow in this checkout. Task plans can use other workflows, new combinations and local steps while preserving required and fixed commitments.</p>
    </fieldset>
    <p id={messageId} ref={error} tabIndex={-1} role={messageAlert ? "alert" : "status"}>{message}</p>
    {blocked && <p>Your draft is kept. Refresh project definitions and inspect project.yaml before trying again.</p>}
    <div className="row">
      <button className="primary" type="submit" disabled={saving || blocked}>{saving ? "Saving…" : "Save project configuration"}</button>
      <button type="button" disabled={saving} onClick={() => {
        if (dirty && !confirm("Discard unsaved project configuration changes?")) return;
        setConfig(copyConfiguration(projectConfig ?? emptyConfiguration()));onDirtyChange(false);setEditing(false);setBlocked(false);setMessage("");setMessageAlert(false);
      }}>Cancel editing</button>
    </div>
  </form>;
}
