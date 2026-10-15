import React, { useEffect, useRef, useState } from "react";
import type { DefinitionReference, ProjectConfigurationInfo, ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ProjectConfigRequestError, saveProjectConfiguration } from "./project-definitions-api.js";

const copyConfiguration = (value: ProjectConfigurationInfo): ProjectConfigurationInfo => ({
  required: value.required.map(reference => "step" in reference ? {step: reference.step} : {workflow: reference.workflow}),
  ...(value.default_workflow === undefined ? {} : {default_workflow: value.default_workflow}),
});

const referenceKey = (reference: DefinitionReference) => "step" in reference ? `step:${reference.step}` : `workflow:${reference.workflow}`;
const referenceId = (reference: DefinitionReference) => "step" in reference ? reference.step : reference.workflow;
const referenceKind = (reference: DefinitionReference) => "step" in reference ? "step" : "workflow";

function optionLabel(kind: "step" | "workflow", id: string, definitions: ProjectDefinitionSnapshot) {
  const item = kind === "step"
    ? definitions.steps.find(step => step.origin === "project" && step.id === id)
    : definitions.workflows.find(workflow => workflow.origin === "project" && workflow.id === id);
  return item ? `${item.name} (${id}) · project` : `${id} · missing or invalid project definition`;
}

function typeOptions(definitions: ProjectDefinitionSnapshot, kind: "step" | "workflow") {
  return kind === "step"
    ? definitions.steps.filter(step => step.origin === "project")
    : definitions.workflows.filter(workflow => workflow.origin === "project");
}

export function ProjectConfigurationEditor({definitions, csrfToken, onSaved, onDirtyChange, onSavingChange}: {
  definitions: ProjectDefinitionSnapshot;
  csrfToken: string;
  onSaved: (result: ProjectDefinitionSnapshot) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [config, setConfig] = useState<ProjectConfigurationInfo>(() => copyConfiguration(definitions.projectConfig ?? {required: []}));
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [messageAlert, setMessageAlert] = useState(false);
  const error = useRef<HTMLParagraphElement>(null);
  const projectConfig = definitions.projectConfig;
  const brokenConfigSource = definitions.sources.find(source => source.origin === "project" && source.path === ".t3-supervisor/project.yaml");
  const baseline = projectConfig ? copyConfiguration(projectConfig) : null;
  const dirty = baseline ? JSON.stringify(config) !== JSON.stringify(baseline) : editing && brokenConfigSource !== undefined;
  useEffect(() => {onDirtyChange(dirty);}, [dirty, onDirtyChange]);
  const update = (next: ProjectConfigurationInfo) => {setConfig(next);setMessage("");setMessageAlert(false);};

  if (definitions.globalOnly) return <div className="panel stack"><h3>Project configuration</h3><p className="muted">This view is global-only. Its definitions are inspectable, but a project editor does not write global files.</p></div>;
  if (!definitions.editingAvailable) return <div className="panel stack"><h3>Project configuration</h3><p className="muted">Editing needs a dedicated filesystem read/write credential configured through deployment setup.</p></div>;
  if (!definitions.complete || !definitions.revision) return <div className="panel stack"><h3>Project configuration</h3><p className="muted">Editing requires a complete read and a current revision. Refresh after access or repository issues are resolved.</p></div>;
  if (!projectConfig && !brokenConfigSource) return <div className="panel stack"><h3>Project configuration</h3><p className="muted">This checkout has no readable project.yaml to update. Create <code>.t3-supervisor/project.yaml</code> with a required list, then refresh.</p></div>;

  if (!editing) return <div className="panel stack project-configuration-summary">
    <div>
      <h3>{projectConfig ? "Project configuration" : "Project configuration needs repair"}</h3>
      <p className="muted">This editor changes only the selected checkout's <code>.t3-supervisor/project.yaml</code>. Reusable step and workflow files remain read-only here.</p>
    </div>
    {projectConfig
      ? <><p><strong>Required in this checkout:</strong> {projectConfig.required.length === 0 ? "None" : projectConfig.required.map(reference => referenceKey(reference)).join(", ")}</p>
        <p><strong>Default workflow:</strong> {projectConfig.default_workflow ?? "None"}</p></>
      : <><p>The existing file was read but could not be parsed, so its requirements are unknown. The repair form starts with an empty replacement draft; that does not mean the unreadable file had no requirements.</p>
        <details className="definition-block"><summary>Inspect the unreadable project.yaml source</summary><pre className="definition-copy">{brokenConfigSource!.content}</pre></details></>}
    <div><button type="button" onClick={() => setEditing(true)}>{projectConfig ? "Edit project configuration" : "Repair project configuration"}</button></div>
  </div>;

  return <form className="panel stack project-configuration-editor" method="post" action="/api/guidance/project-configuration" onSubmit={async event => {
    event.preventDefault();
    if (saving || blocked) return;
    const keys = config.required.map(referenceKey);
    if (config.required.some(reference => !referenceId(reference)) || new Set(keys).size !== keys.length) {
      setMessage("Choose a definition for each requirement and remove duplicate references.");setMessageAlert(true);error.current?.focus();return;
    }
    const action = projectConfig ? "Save project configuration" : "Replace the unreadable project.yaml with this configuration";
    if (!confirm(`${action} at ${definitions.workspaceRoot}/.t3-supervisor/project.yaml? This updates the selected working tree.`)) return;
    setSaving(true);onSavingChange(true);setMessage("");setMessageAlert(false);
    try {
      const result = await saveProjectConfiguration({
        projectId: definitions.projectId,
        threadId: definitions.threadId,
        expectedRevision: definitions.revision!,
        config: copyConfiguration(config),
      }, csrfToken);
      if (result.status === "saved" && result.definitions) {
        setMessage(result.message);setMessageAlert(false);onDirtyChange(false);setEditing(false);onSaved(result.definitions);
      } else if (result.status === "saved") {
        setMessage(`${result.message} Refresh definitions to inspect the saved project.yaml before editing again.`);setMessageAlert(true);setBlocked(true);error.current?.focus();
      } else {
        setMessage(result.message);setMessageAlert(true);
        setBlocked(result.status === "conflict" || result.status === "uncertain" || result.status === "unavailable" || result.status === "permission_required");
        error.current?.focus();
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Save outcome unknown. Refresh before retrying.");
      setMessageAlert(true);
      setBlocked(!(cause instanceof ProjectConfigRequestError && cause.definitelyNotSaved));
      error.current?.focus();
    } finally {setSaving(false);onSavingChange(false);}
  }}>
    <div>
      <h3>{projectConfig ? "Edit project configuration" : "Repair project configuration"}</h3>
      <p className="definition-path">Target: <code>{definitions.workspaceRoot}/.t3-supervisor/project.yaml</code></p>
      <p className="muted">Requirements here are local to this checkout. Enabled global requirements remain separate and read-only.</p>
      {!projectConfig && <p className="panel" role="note">The current file could not be parsed. This replacement starts with an empty required list and does not establish that the unreadable file had no requirements. Review the source above before saving.</p>}
    </div>
    <fieldset disabled={saving || blocked} className="stack">
      <legend>Required reusable definitions</legend>
      <p id="project-config-required-help" className="muted">A requirement names a reusable step or workflow in this checkout. Workflow contents count recursively when the Supervisor checks a plan.</p>
      {config.required.map((reference, index) => {
        const kind = referenceKind(reference);
        const id = referenceId(reference);
        const options = typeOptions(definitions, kind);
        const known = options.some(item => item.id === id);
        return <fieldset key={`${index}:${referenceKey(reference)}`} className="stack project-config-requirement">
          <legend>Requirement {index + 1}</legend>
          <label htmlFor={`project-config-kind-${index}`}>Definition type</label>
          <select id={`project-config-kind-${index}`} value={kind} aria-describedby="project-config-required-help" onChange={event => {
            const nextKind = event.target.value as "step" | "workflow";
            const first = typeOptions(definitions, nextKind)[0]?.id ?? "";
            update({...config, required: config.required.map((item, itemIndex) => itemIndex === index
              ? nextKind === "step" ? {step: first} : {workflow: first}
              : item)});
          }}>
            <option value="step">Step</option><option value="workflow">Workflow</option>
          </select>
          <label htmlFor={`project-config-reference-${index}`}>Reusable definition</label>
          <select id={`project-config-reference-${index}`} required value={id} aria-describedby="project-config-required-help" onChange={event => {
            update({...config, required: config.required.map((item, itemIndex) => itemIndex === index
              ? kind === "step" ? {step: event.target.value} : {workflow: event.target.value}
              : item)});
          }}>
            {!known && id && <option value={id}>{optionLabel(kind, id, definitions)}</option>}
            {!options.length && <option value="">No reusable {kind}s are available</option>}
            {options.map(item => <option key={item.id} value={item.id}>{optionLabel(kind, item.id, definitions)}</option>)}
          </select>
          <button type="button" onClick={() => update({...config, required: config.required.filter((_, itemIndex) => itemIndex !== index)})}>Remove requirement {index + 1}</button>
        </fieldset>;
      })}
      {config.required.length === 0 && <p>No checkout-local requirements are configured. This says nothing about enabled global requirements or unresolved definitions.</p>}
      <button type="button" disabled={config.required.length >= 100 || (!typeOptions(definitions, "step").length && !typeOptions(definitions, "workflow").length)} onClick={() => {
        const firstStep = typeOptions(definitions, "step")[0];
        const firstWorkflow = typeOptions(definitions, "workflow")[0];
        const next: DefinitionReference = firstStep ? {step: firstStep.id} : {workflow: firstWorkflow!.id};
        update({...config, required: [...config.required, next]});
      }}>Add requirement</button>
    </fieldset>
    <fieldset disabled={saving || blocked} className="stack">
      <legend>Default workflow</legend>
      <label htmlFor="project-config-default-workflow">Starting workflow template</label>
      <select id="project-config-default-workflow" value={config.default_workflow ?? ""} aria-describedby="project-config-default-help" onChange={event => {
        update(event.target.value ? {required: config.required, default_workflow: event.target.value} : {required: config.required});
      }}>
        <option value="">No default workflow</option>
        {config.default_workflow && !typeOptions(definitions, "workflow").some(workflow => workflow.id === config.default_workflow) && <option value={config.default_workflow}>{optionLabel("workflow", config.default_workflow, definitions)}</option>}
        {typeOptions(definitions, "workflow").map(workflow => <option key={workflow.id} value={workflow.id}>{optionLabel("workflow", workflow.id, definitions)}</option>)}
      </select>
      <p id="project-config-default-help" className="muted">Choose a reusable workflow in this checkout. The default is a starting template; other workflows can still be negotiated for a task.</p>
    </fieldset>
    <p ref={error} tabIndex={-1} role={messageAlert ? "alert" : "status"}>{message}</p>
    {blocked && <p>Your draft is kept. Refresh project definitions and inspect project.yaml before trying again.</p>}
    <div className="row">
      <button className="primary" type="submit" disabled={saving || blocked}>{saving ? "Saving…" : "Save project configuration"}</button>
      <button type="button" disabled={saving} onClick={() => {
        if (dirty && !confirm("Discard unsaved project configuration changes?")) return;
        setConfig(copyConfiguration(projectConfig ?? {required: []}));onDirtyChange(false);setEditing(false);setBlocked(false);setMessage("");setMessageAlert(false);
      }}>Cancel editing</button>
    </div>
  </form>;
}
