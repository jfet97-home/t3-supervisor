import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GuidanceSnapshot } from "../../src/guidance-contract.js";
import { requiredReferences, type DefinitionNode, type DefinitionStepInfo, type DefinitionWorkflowInfo, type ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { loadProjectDefinitions } from "./project-definitions-api.js";
import { ProjectConfigurationEditor } from "./project-configuration-editor.js";
import { ProjectSupervisorPanel } from "./project-supervisor.js";
import { type OverviewState, ReadTime, WorkState } from "./overview.js";
import { Icon } from "./icons.js";
import { DefinitionReferences } from "./definition-references.js";
import { directoryRoute, openProject, RouteLink, type NavigationGuard, type Route } from "./navigation.js";

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
        {step && <DefinitionReferences references={step.references}/>}
      </div>;
    }
    return <div className="stack definition-node-content">
      <p><strong>Local step:</strong> {node.step.name} <span className="muted small">({node.step.id})</span></p>
      <p className="definition-copy">{node.step.description}</p>
      <DefinitionReferences references={node.step.references}/>
    </div>;
  }
  if ("workflow" in node) {
    const workflow = definitions.workflows.find(item => item.id === node.workflow);
    return <div className="stack definition-node-content">
      <p><strong>Workflow:</strong> <DefinitionLink kind="workflow" id={node.workflow} steps={definitions.steps} workflows={definitions.workflows}/></p>
      {workflow && <><p className="definition-copy">{workflow.description}</p><p className="muted small">Open “{workflow.name}” below to inspect its contents.</p></>}
      {workflow && <DefinitionReferences references={workflow.references}/>}
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
    <DefinitionReferences references={workflow.references}/>
    <div><h4>{kind === "sequence" ? "Sequence" : "Parallel group"}</h4>
      <p className="muted small">{kind === "sequence" ? "The sequence states intended semantic order; it is not an execution scheduler." : "Members have no declared order and may overlap; the group does not launch agents."}</p>
      <DefinitionNodes kind={kind} nodes={nodes} definitions={definitions}/>
    </div>
  </div>;
}

function EffectiveConfiguration({definitions}: {definitions: ProjectDefinitionSnapshot}) {
  const readable = definitions.complete && definitions.status === "ready";
  const config = definitions.config;
  const required = requiredReferences(config);
  return <section className="stack" aria-labelledby="effective-config-title">
    <div><h3 id="effective-config-title">Effective requirements <span className="muted">({required.length} references)</span></h3>
      <p className="muted">This view combines the selected checkout with enabled global definitions. The project editor below changes only the checkout's project.yaml.</p></div>
    {required.length === 0
      ? <p className="panel muted">{readable ? "No effective required references are configured." : "No readable required references are available. Invalid or incomplete source may contain additional requirements."}</p>
      : <ul className="panel stack effective-requirements">{required.map((reference, index) => {
        const kind = "step" in reference ? "step" : "workflow";
        const id = "step" in reference ? reference.step : reference.workflow;
        return <li key={`${kind}:${id}:${index}`}><strong>{kind === "step" ? "Required step" : "Required workflow"}:</strong> <DefinitionLink kind={kind} id={id} steps={definitions.steps} workflows={definitions.workflows}/></li>;
      })}</ul>}
    <p><strong>Effective default workflow:</strong> {config.default_workflow
      ? <DefinitionLink kind="workflow" id={config.default_workflow} steps={definitions.steps} workflows={definitions.workflows}/>
      : "None"} <span className="muted">· starting suggestion</span></p>
  </section>;
}

function DefinitionCatalog({kind, definitions}: {kind: "workflows" | "steps"; definitions: ProjectDefinitionSnapshot}) {
  const entries = definitions.config[kind];
  const title = kind === "workflows" ? "Workflows" : "Steps";
  const singular = kind === "workflows" ? "workflow" : "step";
  return <section className="stack" aria-labelledby={`project-${kind}-title`}>
    <div><h3 id={`project-${kind}-title`}>{title} index <span className="muted">({entries.length})</span></h3>
      <p className="muted">Summaries help you choose what to read. Open the full definition for its policy; global entries are read-only here.</p></div>
    {entries.length === 0 && <p className="panel muted">{definitions.complete && definitions.status === "ready" ? `No reusable ${kind} are indexed in the effective scope.` : `No readable ${kind} index entries are available. See the status and issues above.`}</p>}
    {entries.map(entry => {
      const step = kind === "steps" ? definitions.steps.find(item => item.id === entry.id && item.origin === entry.origin) : undefined;
      const workflow = kind === "workflows" ? definitions.workflows.find(item => item.id === entry.id && item.origin === entry.origin) : undefined;
      return <div className="panel stack" key={`${entry.origin}:${entry.id}`}>
        <div className="row between"><h4 className="definition-path"><code>{entry.sourceId}</code></h4><div className="row">
          <span className="muted small">{entry.origin === "global" ? "Global · read-only" : "Project"}</span>
          <span className={`pill ${entry.required ? "blue" : ""}`}>{entry.required ? "Required" : "Optional"}</span>
          {workflow?.fixed && <span className="pill blue">Fixed</span>}
        </div></div>
        <p className="muted small definition-path"><code>{entry.path}</code></p>
        <p className="definition-index-summary">{entry.summary}</p>
        {step || workflow ? <details className="definition-block">
          <summary>Full definition: {step?.name ?? workflow!.name}</summary>
          {workflow ? <WorkflowContents workflow={workflow} definitions={definitions}/> : <>
            <DefinitionSource definition={step!}/>
            <p className="definition-copy">{step!.description}</p>
            <DefinitionReferences references={step!.references}/>
          </>}
        </details> : <p className="pill amber">Missing or invalid {singular}: {entry.sourceId}. Its index entry and required flag are retained.</p>}
      </div>;
    })}
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
      <p>Start with <code>project.yaml</code>, the index of all reusable definitions in this checkout, then read relevant full definitions. Enabled global definitions use the same layout and their origin is shown with each item.</p>
      <p className="muted">The index inventories reusable files; task plans can add local steps and new combinations while preserving required and fixed commitments.</p>
      {definitions.status === "missing" && <p>No definitions were found in the selected scope. The expected layout is <code>.t3-supervisor/project.yaml</code>, <code>steps/</code> and <code>workflows/</code>. A missing scope does not establish that another enabled scope is empty.</p>}
      {definitions.status === "invalid" && <p>This collection has invalid files or references. Readable definitions are shown below, but an invalid or incomplete collection never means requirements are absent.</p>}
      {!definitions.complete && <p>The read was incomplete. The items shown may be only part of the requirements; resolve the access or source issues and refresh.</p>}
      {definitions.status === "permission_required" && <p>The deployment needs file-reading permission. Credentials cannot be entered or changed from this page.</p>}
      {definitions.issues.length > 0 && <ul className="definition-issues">{definitions.issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`}>
        {issue.path && <code>{issue.path}</code>}<p>{issue.message}</p>
      </li>)}</ul>}
    </div>

    <EffectiveConfiguration definitions={definitions}/>

    <DefinitionCatalog kind="workflows" definitions={definitions}/>
    <DefinitionCatalog kind="steps" definitions={definitions}/>

    <details className="panel stack" aria-labelledby="project-source-title">
      <summary id="project-source-title">Definition source files</summary><p className="muted">Raw bounded content is shown as text to help diagnose invalid files.</p>
      {definitions.sources.length === 0 && <p className="panel muted">No source contents were readable.</p>}
      {definitions.sources.map((source, index) => <details className="panel definition-block" key={`${source.origin ?? ""}:${source.path}:${index}`}>
        <summary><code>{source.path}</code> <span className="muted small">{source.origin ?? "unknown source"}</span></summary>
        <pre className="definition-copy">{source.content}</pre>
      </details>)}
    </details>
  </div>;
}

export function ProjectDefinitionsPanel({data, overview, route, navigate, guard, csrfToken = "", onDirtyChange, onDraftTargetChange}: {
  data: GuidanceSnapshot; overview?: OverviewState; route: Route; navigate: (route: Route) => void; guard: React.RefObject<NavigationGuard>;
  csrfToken?: string; onDirtyChange?: (dirty: boolean) => void; onDraftTargetChange?: (route: Route | null) => void;
}) {
  const [projectQuery, setProjectQuery] = useState("");
  const [conversationQuery, setConversationQuery] = useState("");
  const retained = useRef({projectId: "", threadId: "", contextSelected: false});
  const inWorkspace = route.page === "projects" && Boolean(route.projectId);
  const selection = inWorkspace ? {projectId: route.projectId, threadId: route.main ?? "", contextSelected: route.main !== null} : retained.current;
  retained.current = selection;
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
  useEffect(() => {onDraftTargetChange?.(dirty || saving ? {page: "projects", projectId: selection.projectId, main: selection.contextSelected ? selection.threadId : null, section: configurationDirty ? "definitions" : "settings"} : null);}, [dirty, saving, selection.projectId, selection.threadId, selection.contextSelected, configurationDirty, onDraftTargetChange]);
  const projects = data.projects.filter(project => project.available);
  const projectId = projects.some(project => project.id === selection.projectId) ? selection.projectId : "";
  const threads = data.threads.filter(thread => thread.available && thread.projectId === projectId);
  const threadUnavailable = Boolean(projectId && selection.threadId && !threads.some(thread => thread.id === selection.threadId));
  const threadId = selection.threadId;
  const canLoad = Boolean(projectId && selection.contextSelected && !threadUnavailable && data.connected);
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
  useEffect(() => {
    guard.current = next => {
      if (next.page !== "projects" || !next.projectId) return true;
      const projectChanges = next.projectId !== selection.projectId;
      const scopeChanges = projectChanges || (next.main ?? "") !== selection.threadId;
      return !scopeChanges || discard(projectChanges);
    };
    return () => { guard.current = () => true; };
  });
  const changeContext = (main: string, section = route.section) => navigate({...route, page: "projects", projectId: selection.projectId, main, section});
  const workspaceRoute = {...route, page: "projects" as const, projectId: selection.projectId};
  const showDefinitions = inWorkspace && route.section === "definitions";
  const showSupervisor = inWorkspace && route.section !== "definitions";
  const selectedProject = data.projects.find(project => project.id === selection.projectId);
  return <section className="stack project-definitions" aria-label="Projects">
    <div hidden={inWorkspace} className="stack">
      <div className="page-heading heading-actions"><div><h1>Projects</h1><p className="muted">A workspace for each project, with its conversations, definitions and supervision settings.</p></div><ReadTime value={overview?.data?.observedAt ?? null}/></div>
      <label className="search project-search"><Icon name="search" size={18}/><span className="sr-only">Find a project</span><input type="search" aria-label="Find a project" placeholder="Find a project" value={projectQuery} onChange={event => setProjectQuery(event.target.value)}/></label>
      <div className="project-list">
        {data.projects.filter(project => project.title.toLowerCase().includes(projectQuery.toLowerCase())).map(project => {
          const status = overview?.data?.projects.find(item => item.id === project.id);
          const work = overview?.data?.work.filter(item => item.projectId === project.id) ?? [];
          return <RouteLink key={project.id} to={openProject(project.id)} navigate={navigate} className="project-card">
            <span className="project-avatar" aria-hidden="true"><Icon name="projects"/></span>
            <span className="project-card-copy"><strong>{project.title}</strong><span className="muted small">{data.threads.filter(thread => thread.available && thread.projectId === project.id).length} conversations{project.classification === "scratch" ? " · Scratch workspace" : ""}</span></span>
            <span className="project-status"><span className={`pill ${!project.available ? "amber" : status?.effectiveEnabled ? "green" : ""}`}>{!project.available ? "Project unavailable" : status ? status.effectiveEnabled ? "Supervision on" : status.enabled ? "Not active" : "Supervision off" : "Supervision status not read"}</span><span className="small muted">{work.some(item => item.attention.length) ? "Attention needed in loaded work" : "Open workspace"}</span></span><Icon name="arrow" size={18}/>
          </RouteLink>;
        })}
      </div>
      {!data.projects.some(project => project.title.toLowerCase().includes(projectQuery.toLowerCase())) && <p className="empty-state muted">{projectQuery ? "No projects match your search." : "No T3 projects are available. Add a project in T3 to begin."}</p>}
    </div>
    <div hidden={!inWorkspace} className="stack">
      <div className="page-heading"><RouteLink to={directoryRoute} navigate={navigate} className="back-link">Projects / {selectedProject?.title ?? "Unavailable project"}</RouteLink><div className="row between"><div><h1>{threadId && ["progress", "plan", "supervision"].includes(route.section) ? threads.find(thread => thread.id === threadId)?.title ?? "Unavailable conversation" : selectedProject?.title ?? "Unavailable project"}</h1>{threadId && ["progress", "plan", "supervision"].includes(route.section) && <p className="muted small">Main conversation · {selectedProject?.title}</p>}</div>{threadId && <a className="button-link" href={`t3-thread://v1/${threadId}`}><Icon name="external" size={16}/>Open in T3</a>}</div></div>
      <nav className="project-nav" aria-label="Project sections">
        <RouteLink to={{...workspaceRoute, main: null, section: "progress"}} navigate={navigate} aria-current={["progress", "plan", "supervision"].includes(route.section) ? "page" : undefined}>Conversations</RouteLink>
        <RouteLink to={{...workspaceRoute, section: "definitions"}} navigate={navigate} aria-current={route.section === "definitions" ? "page" : undefined}>Definitions</RouteLink>
        <RouteLink to={{...workspaceRoute, main: null, section: "settings"}} navigate={navigate} aria-current={route.section === "settings" ? "page" : undefined}>Project settings</RouteLink>
      </nav>
      <details className="context-switcher" hidden={route.section === "settings" || route.main === null && route.section !== "definitions"} open={route.section === "definitions"}><summary>{route.section === "definitions" ? "Definitions checkout" : "Switch conversation or inspect checkout"}</summary><div className="context-bar stack">
        <div className="definition-controls">
          <label className="context-project" htmlFor="definition-project">Project<select id="definition-project" value={selection.projectId} disabled={saving} onChange={event => navigate(openProject(event.target.value))}>
            {!projectId && <option value={selection.projectId}>Project unavailable</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select></label>
          <label htmlFor="definition-thread">{route.section === "definitions" ? "Definitions checkout" : "Conversation"}<select id="definition-thread" value={route.main === null ? "__choose__" : threadId} disabled={!projectId || saving} onChange={event => changeContext(event.target.value, route.section === "definitions" ? "definitions" : event.target.value ? "progress" : "definitions")}>
            <option value="__choose__" disabled>{route.section === "definitions" ? "Choose a checkout" : "Choose a conversation"}</option>
            {threadUnavailable && <option value={threadId} disabled>Conversation unavailable</option>}
            <option value="">Project root checkout</option>{threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
          </select></label>
          <button hidden={route.section !== "definitions"} type="button" disabled={!canLoad || busy || saving} onClick={() => {if (discard()) setRevision(value => value + 1);}}>Refresh definitions</button>
        </div>
        {current?.result?.workspaceRoot && <p className="small muted definition-path">Working folder <code>{current.result.workspaceRoot}</code></p>}
      </div></details>
      {!projectId && <p className="panel" role="status">The selected project is unavailable. Its context is kept; choose an available project to continue.</p>}
      {threadUnavailable && <p className="panel" role="status">The selected conversation is no longer available in this project. Choose another conversation.</p>}
      {!data.connected && <p className="panel" role="status">T3 is disconnected. Any unsaved project configuration draft is kept.</p>}
      {saving && <p className="notice" role="status">A save or supervision setup outcome is pending. Inspect Project settings and reload an uncertain outcome before changing scope.</p>}
      {dirty && !onDraftTargetChange && <p className="draft-notice" role="status">Unsaved changes · <RouteLink to={{...workspaceRoute, section: configurationDirty ? "definitions" : "settings"}} navigate={navigate}>Return to your draft</RouteLink>. Switching views keeps your changes.</p>}
      {threadId && ["progress", "plan", "supervision"].includes(route.section) && <nav className="section-nav" aria-label="Conversation views">{(["progress", "plan", "supervision"] as const).map(section => <RouteLink key={section} to={{...workspaceRoute, section}} navigate={navigate} aria-current={route.section === section ? "page" : undefined}>{({progress: "Overview", plan: "Plan & agreement", supervision: "Supervision"})[section]}</RouteLink>)}</nav>}
      {inWorkspace && <div className={threadId && ["progress", "plan", "supervision"].includes(route.section) ? "sr-only" : "section-heading"}><h2 id="project-section-heading" tabIndex={-1}>{({progress: route.main === null ? "Conversations" : "Conversation overview", plan: "Plan & agreement", supervision: "Supervision", definitions: "Definitions", settings: "Project settings"})[route.section]}</h2><p className="muted">{({progress: route.main === null ? "Open a conversation to understand its work and supervision." : "The task, current assessment and connected work in one place.", plan: "Review the current proposal, agreement and required commitments.", supervision: "Inspect the Supervisor, helpers, monitoring and recovery for this conversation.", definitions: "Choose the exact checkout, then browse and edit its reusable definition index.", settings: "Enable supervision and set defaults for new Supervisors in this project."})[route.section]}</p></div>}
      {route.main === null && route.section !== "settings" && <div className="panel stack">
        <h3>{route.section === "definitions" ? "Choose the definitions checkout" : "Find a conversation"}</h3><label className="search"><span className="sr-only">Find a conversation</span><input aria-label="Find a conversation" type="search" placeholder="Search conversation titles" value={conversationQuery} onChange={event => setConversationQuery(event.target.value)}/></label>
        <div className="conversation-list">{threads.filter(thread => thread.title.toLowerCase().includes(conversationQuery.toLowerCase())).map(thread => {
          const work = overview?.data?.work.find(item => item.mainThreadId === thread.id);
          return <RouteLink key={thread.id} to={{...workspaceRoute, main: thread.id}} navigate={navigate}><div className="conversation-list-copy"><strong>{thread.title}</strong><p className="muted small">{work?.objective ?? "Open to inspect task, plan and current supervision."}</p></div>{work && <WorkState work={work}/>}<Icon name="arrow" size={18}/></RouteLink>;
        })}</div>
        {threads.length === 0 && <p>No available main conversations in this project.</p>}
        <RouteLink className="context-root-link" to={{...workspaceRoute, main: "", section: "definitions"}} navigate={navigate}>Inspect project root checkout</RouteLink>
      </div>}
    </div>
    {selection.projectId && <div hidden={!showSupervisor || (route.main === null && route.section !== "settings")} inert={configurationSaving}><ProjectSupervisorPanel key={selection.projectId} projectId={selection.projectId} threadId={threadId}
      section={route.section} attentionEnabled={overview?.data?.projects.find(project => project.id === selection.projectId)?.effectiveEnabled ?? false} connected={data.connected && Boolean(projectId)} csrfToken={csrfToken}
      onDirtyChange={setSupervisorDirty} onSavingChange={setSupervisorSaving}/></div>}
    <div hidden={!showDefinitions} className="stack">
      {busy && <p className="panel" role="status">Reading project definitions…</p>}
      {canLoad && current?.error && <p className="panel" role="alert">Could not load definitions. Refresh to try again or check the Supervisor connection.</p>}
      {savedMessage && <p role="status">{savedMessage}</p>}
      {canLoad && current?.result && <div className="stack"><p className="muted small" role="status">Loaded {new Date(current.loadedAt!).toLocaleTimeString()}. Refresh after repository changes.</p><DefinitionsContent key={key} definitions={current.result}/></div>}
      {state.result && <div hidden={!canLoad || state.key !== key} inert={supervisorSaving || configurationSaving}>
        <ProjectConfigurationEditor key={JSON.stringify([state.result.projectId, state.result.threadId, state.result.revision, revision])} definitions={state.result} csrfToken={csrfToken} onDirtyChange={reportDirty} onSavingChange={setConfigurationSaving}
          onSaved={result => {setState({key, result, error: false, loadedAt: Date.now()});setSavedMessage("Saved project configuration to .t3-supervisor/project.yaml.");}}/>
      </div>}
    </div>
  </section>;
}
