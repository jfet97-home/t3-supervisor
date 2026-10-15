import React, { useCallback, useEffect, useState } from "react";
import type { GuidanceSnapshot } from "../../src/guidance-contract.js";
import type { DefinitionNode, DefinitionStepInfo, DefinitionWorkflowInfo, ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { loadProjectDefinitions } from "./project-definitions-api.js";
import { ProjectConfigurationEditor } from "./project-configuration-editor.js";
import { ProjectSupervisorPanel } from "./project-supervisor.js";

const statusText: Record<ProjectDefinitionSnapshot["status"], string> = {
  ready: "Definitions valid",
  missing: "No definitions in this scope",
  invalid: "Definitions need attention",
  permission_required: "File access needs setup",
  unavailable: "Definitions unavailable",
};

function DefinitionSource({definition}: {definition: {origin?: "global" | "project" | undefined; path?: string | undefined}}) {
  if (!definition.origin && !definition.path) return null;
  return <p className="small muted">Source: {definition.origin ?? "unknown"}{definition.path && <> · <code>{definition.path}</code></>}</p>;
}

function DefinitionLink({kind, id, steps, workflows}: {kind: "step" | "workflow"; id: string; steps: readonly DefinitionStepInfo[]; workflows: readonly DefinitionWorkflowInfo[]}) {
  const item = kind === "step" ? steps.find(step => step.id === id) : workflows.find(workflow => workflow.id === id);
  return item
    ? <span>{item.name} <span className="muted small">({id}{item.origin === "global" ? " · global" : ""})</span></span>
    : <span className="pill amber">Missing or invalid {kind}: {id}</span>;
}

function NodeDescription({node, definitions}: {node: DefinitionNode; definitions: ProjectDefinitionSnapshot}) {
  if ("step" in node) {
    if (typeof node.step === "string") {
      const step = definitions.steps.find(item => item.id === node.step);
      return <div className="stack definition-node-content">
        <p><strong>Step:</strong> <DefinitionLink kind="step" id={node.step} steps={definitions.steps} workflows={definitions.workflows}/></p>
        {step && <p className="definition-copy">{step.description}</p>}
      </div>;
    }
    return <div className="stack definition-node-content">
      <p><strong>Local step:</strong> {node.step.name} <span className="muted small">({node.step.id})</span></p>
      <p className="definition-copy">{node.step.description}</p>
    </div>;
  }
  if ("workflow" in node) {
    const workflow = definitions.workflows.find(item => item.id === node.workflow);
    return <div className="stack definition-node-content">
      <p><strong>Workflow:</strong> <DefinitionLink kind="workflow" id={node.workflow} steps={definitions.steps} workflows={definitions.workflows}/></p>
      {workflow && <><p className="definition-copy">{workflow.description}</p><p className="muted small">Open “{workflow.name}” below to inspect its contents.</p></>}
    </div>;
  }
  const kind = "sequence" in node ? "sequence" : "parallel";
  const nodes = "sequence" in node ? node.sequence : node.parallel;
  return <div className="stack definition-node-group">
    <p><strong>{kind === "sequence" ? "Sequence" : "Parallel group"}</strong> <span className="muted">{kind === "sequence" ? "— intended order" : "— members have no declared order"}</span></p>
    <DefinitionNodes kind={kind} nodes={nodes} definitions={definitions}/>
  </div>;
}

function DefinitionNodes({kind, nodes, definitions}: {kind: "sequence" | "parallel"; nodes: readonly DefinitionNode[]; definitions: ProjectDefinitionSnapshot}) {
  const List = kind === "sequence" ? "ol" : "ul";
  return <List className="stack definition-nodes">{nodes.map((node, index) => <li key={`${kind}:${index}`}><NodeDescription node={node} definitions={definitions}/></li>)}</List>;
}

function WorkflowContents({workflow, definitions}: {workflow: DefinitionWorkflowInfo; definitions: ProjectDefinitionSnapshot}) {
  const kind = workflow.sequence ? "sequence" : "parallel";
  const nodes = workflow.sequence ?? workflow.parallel ?? [];
  return <div className="stack">
    <DefinitionSource definition={workflow}/>
    {workflow.fixed && <p className="pill blue">Fixed fragment: original members and relationships are preserved; support work may be inserted around or between them.</p>}
    <p className="definition-copy">{workflow.description}</p>
    <div><h4>{kind === "sequence" ? "Sequence" : "Parallel group"}</h4>
      <p className="muted small">{kind === "sequence" ? "The sequence states intended semantic order; it is not an execution scheduler." : "Members have no declared order and may overlap; the group does not launch agents."}</p>
      <DefinitionNodes kind={kind} nodes={nodes} definitions={definitions}/>
    </div>
  </div>;
}

function EffectiveConfiguration({definitions}: {definitions: ProjectDefinitionSnapshot}) {
  const readable = definitions.complete && definitions.status === "ready";
  const config = definitions.config;
  return <section className="stack" aria-labelledby="effective-config-title">
    <div><h3 id="effective-config-title">Effective requirements <span className="muted">({config.required.length} references)</span></h3>
      <p className="muted">This view combines the selected checkout with enabled global definitions. The project editor below changes only the checkout's project.yaml.</p></div>
    {config.required.length === 0
      ? <p className="panel muted">{readable ? "No effective required references are configured." : "No readable required references are available. Invalid or incomplete source may contain additional requirements."}</p>
      : <ul className="panel stack effective-requirements">{config.required.map((reference, index) => {
        const kind = "step" in reference ? "step" : "workflow";
        const id = "step" in reference ? reference.step : reference.workflow;
        return <li key={`${kind}:${id}:${index}`}><strong>{kind === "step" ? "Required step" : "Required workflow"}:</strong> <DefinitionLink kind={kind} id={id} steps={definitions.steps} workflows={definitions.workflows}/></li>;
      })}</ul>}
    <p><strong>Effective default workflow:</strong> {config.default_workflow
      ? <DefinitionLink kind="workflow" id={config.default_workflow} steps={definitions.steps} workflows={definitions.workflows}/>
      : "None"}</p>
  </section>;
}

export function DefinitionsContent({definitions}: {definitions: ProjectDefinitionSnapshot}) {
  const readableAndValid = definitions.complete && definitions.status === "ready";
  return <div className="stack">
    <div className="panel stack">
      <div className="row between">
        <h3>{statusText[definitions.status]}</h3>
        <span className={`pill ${readableAndValid ? "green" : "amber"}`}>{readableAndValid ? "Valid and complete" : definitions.complete ? "Read complete; review validity" : "Read incomplete"}</span>
      </div>
      {definitions.workspaceRoot && <p className="muted definition-path">Working checkout: <code>{definitions.workspaceRoot}</code></p>}
      {definitions.workspaceRoot && !definitions.globalOnly && <p className="muted definition-path">Project source: <code>{definitions.workspaceRoot}/.t3-supervisor</code></p>}
      {definitions.globalOnly && <p>Global-only scope. Project editing does not write global definitions.</p>}
      <p>Definitions follow the selected checkout. Enabled global definitions use the same layout and their origin is shown with each item.</p>
      {definitions.status === "missing" && <p>No definitions were found in the selected scope. The expected layout is <code>.t3-supervisor/project.yaml</code>, <code>steps/</code> and <code>workflows/</code>. A missing scope does not establish that another enabled scope is empty.</p>}
      {definitions.status === "invalid" && <p>This collection has invalid files or references. Readable definitions are shown below, but an invalid or incomplete collection never means requirements are absent.</p>}
      {!definitions.complete && <p>The read was incomplete. The items shown may be only part of the requirements; resolve the access or source issues and refresh.</p>}
      {definitions.status === "permission_required" && <p>The deployment needs file-reading permission. Credentials cannot be entered or changed from this page.</p>}
      {definitions.issues.length > 0 && <ul className="definition-issues">{definitions.issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`}>
        {issue.path && <code>{issue.path}</code>}<p>{issue.message}</p>
      </li>)}</ul>}
    </div>

    <EffectiveConfiguration definitions={definitions}/>

    <section className="stack" aria-labelledby="project-step-title">
      <div><h3 id="project-step-title">Reusable steps <span className="muted">({definitions.steps.length})</span></h3><p className="muted">Each step has an ID, name and complete description.</p></div>
      {definitions.steps.length === 0 && <p className="panel muted">{readableAndValid ? "No reusable steps are defined in the effective scope." : "No readable reusable steps are available. See the status and issues above."}</p>}
      {definitions.steps.map(step => <details className="panel definition-block" key={`${step.origin ?? ""}:${step.id}`}>
        <summary>{step.name} <span className="muted small">{step.sourceId ?? step.id}.md</span></summary>
        <DefinitionSource definition={step}/>
        <p className="definition-copy">{step.description}</p>
      </details>)}
    </section>

    <section className="stack" aria-labelledby="project-workflow-title">
      <div><h3 id="project-workflow-title">Reusable workflows <span className="muted">({definitions.workflows.length})</span></h3><p className="muted">Inspect the plan structure, nested groups and source descriptions.</p></div>
      {definitions.workflows.length === 0 && <p className="panel muted">{readableAndValid ? "No reusable workflows are defined in the effective scope." : "No readable reusable workflows are available. See the status and issues above."}</p>}
      {definitions.workflows.map(workflow => <details className="panel definition-block" key={`${workflow.origin ?? ""}:${workflow.id}`}>
        <summary>{workflow.name} <span className="muted small">{workflow.sourceId ?? workflow.id}.yaml</span>{workflow.fixed && <span className="pill blue">Fixed</span>}</summary>
        <WorkflowContents workflow={workflow} definitions={definitions}/>
      </details>)}
    </section>

    <section className="stack" aria-labelledby="project-source-title">
      <div><h3 id="project-source-title">Definition source files</h3><p className="muted">Raw bounded content is shown as text to help diagnose invalid files.</p></div>
      {definitions.sources.length === 0 && <p className="panel muted">No source contents were readable.</p>}
      {definitions.sources.map((source, index) => <details className="panel definition-block" key={`${source.origin ?? ""}:${source.path}:${index}`}>
        <summary><code>{source.path}</code> <span className="muted small">{source.origin ?? "unknown source"}</span></summary>
        <pre className="definition-copy">{source.content}</pre>
      </details>)}
    </section>
  </div>;
}

export function ProjectDefinitionsPanel({data, csrfToken = "", onDirtyChange}: {data: GuidanceSnapshot; csrfToken?: string; onDirtyChange?: (dirty: boolean) => void}) {
  const [selection, setSelection] = useState({projectId: "", threadId: ""});
  const [revision, setRevision] = useState(0);
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const [configurationSaving, setConfigurationSaving] = useState(false);
  const [supervisorDirty, setSupervisorDirty] = useState(false);
  const [supervisorSaving, setSupervisorSaving] = useState(false);
  const dirty = configurationDirty || supervisorDirty;
  const saving = configurationSaving || supervisorSaving;
  const [savedMessage, setSavedMessage] = useState("");
  const reportDirty = useCallback((value: boolean) => setConfigurationDirty(value), []);
  useEffect(() => {onDirtyChange?.(dirty || saving);}, [dirty, saving, onDirtyChange]);
  const projects = data.projects.filter(project => project.available);
  const projectId = projects.some(project => project.id === selection.projectId) ? selection.projectId : "";
  const threads = data.threads.filter(thread => thread.available && thread.projectId === projectId);
  const threadUnavailable = Boolean(projectId && selection.threadId && !threads.some(thread => thread.id === selection.threadId));
  const threadId = selection.threadId;
  const canLoad = Boolean(projectId && !threadUnavailable && data.connected);
  const key = JSON.stringify([projectId, threadId, revision, canLoad]);
  const [state, setState] = useState<{key: string; result: ProjectDefinitionSnapshot | null; error: boolean; loadedAt: number | null}>({key: "", result: null, error: false, loadedAt: null});
  useEffect(() => {
    if (configurationDirty || configurationSaving) return;
    if (!canLoad) return;
    setState({key, result: null, error: false, loadedAt: null});
    const controller = new AbortController();
    void loadProjectDefinitions(projectId, threadId || null, controller.signal).then(result => {
      if (!controller.signal.aborted) setState({key, result, error: false, loadedAt: Date.now()});
    }, () => {
      if (!controller.signal.aborted) setState({key, result: null, error: true, loadedAt: null});
    });
    return () => controller.abort();
  }, [projectId, threadId, key, canLoad, configurationDirty, configurationSaving]);
  const current = state.key === key ? state : null;
  const busy = Boolean(canLoad && !current?.result && !current?.error);
  const discard = (includeSupervisor = false) => {
    if (saving || (configurationDirty || includeSupervisor && supervisorDirty) && !confirm(includeSupervisor ? "Discard unsaved project configuration and Supervisor settings?" : "Discard unsaved project-configuration changes and reload definitions?")) return false;
    if (includeSupervisor) setSupervisorDirty(false);
    reportDirty(false);setSavedMessage("");setState({key: "", result: null, error: false, loadedAt: null});return true;
  };
  return <section className="stack project-definitions" aria-labelledby="definition-title">
    <div><h2 id="definition-title">Steps and workflows</h2><p className="muted">Inspect reusable definitions and effective requirements. Edit only this checkout's project configuration.</p></div>
    <div className="panel definition-controls">
      <label htmlFor="definition-project">Project<select id="definition-project" value={projectId} disabled={saving} onChange={event => {if (discard(true)) setSelection({projectId: event.target.value, threadId: ""});}}>
        <option value="">Select a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select></label>
      <label htmlFor="definition-thread">Main conversation / working directory<select id="definition-thread" value={threadId} disabled={!projectId || saving} onChange={event => {if (discard()) setSelection(previous => ({...previous, threadId: event.target.value}));}}>
        {threadUnavailable && <option value={threadId} disabled>Conversation unavailable</option>}
        <option value="">Project root / defaults only</option>{threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
      </select></label>
      <button type="button" disabled={!canLoad || busy || saving} onClick={() => {if (discard()) setRevision(value => value + 1);}}>Refresh definitions</button>
    </div>
    {selection.projectId && <div inert={configurationSaving}><ProjectSupervisorPanel key={selection.projectId} projectId={selection.projectId} threadId={threadId}
      connected={data.connected && Boolean(projectId)} csrfToken={csrfToken}
      onDirtyChange={setSupervisorDirty} onSavingChange={setSupervisorSaving}/></div>}
    {!projectId && <p className="panel muted">{projects.length ? "Select a project to inspect its definitions." : "No available T3 projects. Add a project in T3 to inspect its definitions here."}</p>}
    {threadUnavailable && <p className="panel" role="status">The selected conversation is no longer available in this project. Choose another working directory.</p>}
    {!data.connected && <p className="panel" role="status">T3 is disconnected. Any unsaved project configuration draft is kept.</p>}
    {busy && <p className="panel" role="status">Reading project definitions…</p>}
    {canLoad && current?.error && <p className="panel" role="alert">Could not load definitions. Refresh to try again or check the Supervisor connection.</p>}
    {savedMessage && <p role="status">{savedMessage}</p>}
    {state.result && <div hidden={!canLoad || state.key !== key} inert={supervisorSaving || configurationSaving}>
      <ProjectConfigurationEditor key={JSON.stringify([state.result.projectId, state.result.threadId, state.result.revision, revision])} definitions={state.result} csrfToken={csrfToken} onDirtyChange={reportDirty} onSavingChange={setConfigurationSaving}
        onSaved={result => {setState({key, result, error: false, loadedAt: Date.now()});setSavedMessage("Saved project configuration to .t3-supervisor/project.yaml.");}}/>
    </div>}
    {canLoad && current?.result && <>
      <p className="muted small" role="status">Loaded {new Date(current.loadedAt!).toLocaleTimeString()}. Refresh after repository changes.</p>
      <DefinitionsContent key={key} definitions={current.result}/>
    </>}
  </section>;
}
