import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { GuidanceSnapshot } from "../../src/guidance-contract.js";
import { requiredReferences, type DefinitionNode, type DefinitionStepInfo, type DefinitionWorkflowInfo, type ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { authEpochAtom, environmentAtom, scopeKey } from "./atoms.js";
import { definitionsReadKey, projectDefinitionsAtom, type LoadedDefinitions, type ProjectDefinitionsReadError } from "./project-definitions-api.js";
import { configurationDrafts, configurationScope, freshDraft, ProjectConfigurationEditor } from "./project-configuration-editor.js";
import { discardSupervisorDrafts, ProjectSupervisorPanel } from "./project-supervisor.js";
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
    <div><h3 id="effective-config-title">Effective requirements <span className="muted">({required.length} {required.length === 1 ? "reference" : "references"})</span></h3>
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
      return <div className="definition-index-row stack" key={`${entry.origin}:${entry.id}`}>
        <div className="row between"><h4 className="definition-path">{step?.name ?? workflow?.name ?? entry.sourceId}</h4><div className="row">
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
      <details><summary>How these definitions are used</summary><p>Start with <code>project.yaml</code>, the index of all reusable definitions in this checkout, then read relevant full definitions. Enabled global definitions use the same layout and their origin is shown with each item.</p>
      <p className="muted">The index inventories reusable files; task plans can add local steps and new combinations while preserving required and fixed commitments.</p></details>
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

// the checkout a definitions view is scoped to; it is retained while the workspace is not shown
export type DefinitionsSelection = {readonly projectId: string; readonly threadId: string; readonly contextSelected: boolean};

// the route of the pending project draft that the shell links to, or null while nothing is pending
export const draftTarget = (selection: DefinitionsSelection, pending: {dirty: boolean; saving: boolean; configurationDirty: boolean}): Route | null =>
  pending.dirty || pending.saving
    ? {page: "projects", projectId: selection.projectId, main: selection.contextSelected ? selection.threadId : null, section: pending.configurationDirty ? "definitions" : "settings"}
    : null;

// whether a navigation leaves the selected scope; leaving the projects page or changing only the section stays in scope
export const scopeChange = (next: Route, selection: DefinitionsSelection): {projectChanges: boolean} | null => {
  if (next.page !== "projects" || !next.projectId) return null;
  const projectChanges = next.projectId !== selection.projectId;
  return projectChanges || (next.main ?? "") !== selection.threadId ? {projectChanges} : null;
};

// whether pending project work may be discarded: never while a save or setup is pending, and a dirty draft only after
// the user confirms
export const confirmDiscard = (pending: {saving: boolean; configurationDirty: boolean; supervisorDirty: boolean}, includeSupervisor: boolean, ask: (question: string) => boolean): boolean =>
  !pending.saving && (!(pending.configurationDirty || includeSupervisor && pending.supervisorDirty) ||
    ask(includeSupervisor ? "Discard unsaved project configuration and Supervisor settings?" : "Discard unsaved project-configuration changes and reload definitions?"));

// the confirmed discard of the pending project work, applied to the keep-alive drafts rather than by remounting: the
// configuration draft of the shown checkout in the environment it was read for and, when the project changes, the
// project's Supervisor drafts of the current environment
export const discardProjectDrafts = (registry: AtomRegistry.AtomRegistry, environmentId: string | null, projectId: string,
  loaded: LoadedDefinitions | null, includeSupervisor: boolean) => {
  if (includeSupervisor) discardSupervisorDrafts(registry, environmentId, projectId);
  if (loaded) registry.set(configurationDrafts(configurationScope(loaded.environmentId, loaded.definitions)), freshDraft());
};

// the view a definitions read belongs to (the baseline view key with its T3 environment), its read key, null while
// nothing may be read, and the environment it reads
export type DefinitionsView = {readonly key: string; readonly read: string | null; readonly environmentId: string | null};

// the view the panel shows: it follows the live view, except that no reload starts while the configuration editor holds
// a draft or a save; a draft never holds another environment's view, so a new environment reads its own definitions and
// the draft stays with the environment it was made in
export const heldView = (held: DefinitionsView, live: DefinitionsView, holding: boolean): DefinitionsView =>
  holding && held.environmentId === live.environmentId ? held : live;

// what the configuration editor of an environment last reported; a report counts only in its environment
export type ConfigurationReport = {readonly environmentId: string | null; readonly dirty: boolean; readonly saving: boolean};

// the panel state that saves and the configuration editor complete, each kept with what it belongs to: a verified save
// and its message with the read (environment, project, checkout and session) it answers, and an editor report with the
// environment of the definitions the editor edits. a completion that arrives after the panel moved to another
// environment or scope therefore settles its own entry and never changes what another view shows
export type DefinitionsCompletion = {
  readonly saved: Readonly<Record<string, LoadedDefinitions>>;
  readonly messages: Readonly<Record<string, string>>;
  readonly reports: Readonly<Record<string, ConfigurationReport>>;
};
export const noCompletion: DefinitionsCompletion = {saved: {}, messages: {}, reports: {}};
const savedText = "Saved project configuration to .t3-supervisor/project.yaml.";
const without = <A,>(entries: Readonly<Record<string, A>>, key: string): Readonly<Record<string, A>> =>
  Object.fromEntries(Object.entries(entries).filter(([entry]) => entry !== key));
// the verified save of a read: it is shown for that read, with its message, until the read is newer or discarded
export const recordSaved = (state: DefinitionsCompletion, read: string | null, loaded: LoadedDefinitions): DefinitionsCompletion =>
  read === null ? state : {...state, saved: {...state.saved, [read]: loaded}, messages: {...state.messages, [read]: savedText}};
// an explicit discard or refresh of a view: the verified save and the message of its read are gone
export const discardSaved = (state: DefinitionsCompletion, read: string | null): DefinitionsCompletion =>
  read === null ? state : {...state, saved: without(state.saved, read), messages: without(state.messages, read)};
// the verified save shown for a read: the newer of it and the latest successful read of that key
export const savedFor = (state: DefinitionsCompletion, read: string | null, latest: LoadedDefinitions | null): LoadedDefinitions | null => {
  const saved = read === null ? undefined : state.saved[read];
  return saved !== undefined && (latest === null || saved.loadedAt >= latest.loadedAt) ? saved : null;
};
// the message of a verified save shown for a view
export const messageFor = (state: DefinitionsCompletion, view: {readonly read: string | null; readonly environmentId: string | null}): string | null =>
  view.read === null ? null : state.messages[view.read] ?? null;
// the editor's report counted in an environment, and a new report of the editor of definitions read in `environmentId`
export const reportOf = (state: DefinitionsCompletion, environmentId: string | null): ConfigurationReport =>
  state.reports[scopeKey(environmentId)] ?? {environmentId, dirty: false, saving: false};
export const recordReport = (state: DefinitionsCompletion, environmentId: string | null, report: {readonly dirty?: boolean; readonly saving?: boolean}): DefinitionsCompletion =>
  ({...state, reports: {...state.reports, [scopeKey(environmentId)]: {...reportOf(state, environmentId), ...report}}});
// the callbacks the panel hands the configuration editor of definitions read for `read` in `environmentId`
export const editorCompletion = (update: (change: (state: DefinitionsCompletion) => DefinitionsCompletion) => void, read: string | null,
  environmentId: string | null, now: () => number) => ({
  onDirtyChange: (dirty: boolean) => update(state => recordReport(state, environmentId, {dirty})),
  onSavingChange: (saving: boolean) => update(state => recordReport(state, environmentId, {saving})),
  onSaved: (definitions: ProjectDefinitionSnapshot) => update(state => recordSaved(state, read, {definitions, loadedAt: now(), environmentId})),
});

// what the definitions view shows for its read: a verified save, else the latest successful read, which a failed refresh
// keeps beside its failure; the failure is shown once no read is running
export const definitionsShown = (read: AsyncResult.AsyncResult<LoadedDefinitions, unknown>, saved: LoadedDefinitions | null) => ({
  result: saved ?? Option.getOrNull(AsyncResult.value(read)),
  error: saved === null && AsyncResult.isFailure(read) && !read.waiting,
  reading: saved === null && read.waiting,
});

const noDefinitions: Atom.Atom<AsyncResult.AsyncResult<LoadedDefinitions, ProjectDefinitionsReadError>> = Atom.make(AsyncResult.initial());
const epochOf = (epoch: AsyncResult.AsyncResult<number, unknown>) => Option.getOrElse(AsyncResult.value(epoch), () => 0);

export function ProjectDefinitionsPanel({data, overview, route, navigate, guard, onDirtyChange, onDraftTargetChange}: {
  data: GuidanceSnapshot; overview?: OverviewState; route: Route; navigate: (route: Route) => void; guard: React.RefObject<NavigationGuard>;
  onDirtyChange?: (dirty: boolean) => void; onDraftTargetChange?: (route: Route | null) => void;
}) {
  const [projectQuery, setProjectQuery] = useState("");
  const [conversationQuery, setConversationQuery] = useState("");
  const retained = useRef<DefinitionsSelection>({projectId: "", threadId: "", contextSelected: false});
  const inWorkspace = route.page === "projects" && Boolean(route.projectId);
  const selection: DefinitionsSelection = inWorkspace ? {projectId: route.projectId, threadId: route.main ?? "", contextSelected: route.main !== null} : retained.current;
  retained.current = selection;
  const [revision, setRevision] = useState(0);
  const environmentId = useAtomValue(environmentAtom);
  const [completion, setCompletion] = useState<DefinitionsCompletion>(noCompletion);
  const {dirty: configurationDirty, saving: configurationSaving} = reportOf(completion, environmentId);
  const [supervisorDirty, setSupervisorDirty] = useState(false);
  const [supervisorSaving, setSupervisorSaving] = useState(false);
  const dirty = configurationDirty || supervisorDirty;
  const saving = configurationSaving || supervisorSaving;
  useEffect(() => {onDirtyChange?.(dirty || saving);}, [dirty, saving, onDirtyChange]);
  useEffect(() => {onDraftTargetChange?.(draftTarget(selection, {dirty, saving, configurationDirty}));}, [dirty, saving, selection.projectId, selection.threadId, selection.contextSelected, configurationDirty, onDraftTargetChange]);
  const projects = data.projects.filter(project => project.available);
  const projectId = projects.some(project => project.id === selection.projectId) ? selection.projectId : "";
  const threads = data.threads.filter(thread => thread.available && thread.projectId === projectId);
  const threadUnavailable = Boolean(projectId && selection.threadId && !threads.some(thread => thread.id === selection.threadId));
  const threadId = selection.threadId;
  const canLoad = Boolean(projectId && selection.contextSelected && !threadUnavailable && data.connected);
  const key = JSON.stringify([environmentId, projectId, threadId, revision, canLoad]);
  const epoch = useAtomValue(authEpochAtom, epochOf);
  const live = {key, read: canLoad ? definitionsReadKey(environmentId, projectId, threadId || null, epoch) : null, environmentId};
  const held = useRef(live);
  held.current = heldView(held.current, live, configurationDirty || configurationSaving);
  const view = held.current;
  const read = useAtomValue(view.read === null ? noDefinitions : projectDefinitionsAtom(view.read));
  // a verified save replaces the shown snapshot until the view reads it again
  const savedView = savedFor(completion, view.read, Option.getOrNull(AsyncResult.value(read)));
  const shown = definitionsShown(read, savedView);
  // definitions read for another environment are never shown or edited here
  const loaded = shown.result?.environmentId === environmentId ? shown.result : null;
  const current = view.key === key ? {result: loaded, error: shown.error, loadedAt: loaded?.loadedAt ?? null} : null;
  const busy = Boolean(canLoad && (shown.reading || !current?.result && !current?.error));
  const registry = useContext(RegistryContext);
  // the editor's reports and completions belong to the read and environment of the definitions it edits
  const editorEnvironment = loaded?.environmentId ?? environmentId;
  const editorReports = useMemo(() => editorCompletion(setCompletion, view.read, editorEnvironment, Date.now), [view.read, editorEnvironment]);
  const discard = (includeSupervisor = false) => {
    if (!confirmDiscard({saving, configurationDirty, supervisorDirty}, includeSupervisor, question => confirm(question))) return false;
    if (includeSupervisor) setSupervisorDirty(false);
    discardProjectDrafts(registry, environmentId, selection.projectId, loaded, includeSupervisor);
    setCompletion(state => discardSaved(recordReport(state, editorEnvironment, {dirty: false}), view.read));return true;
  };
  // a refresh reads the shown checkout again; its latest successful read stays visible until the new one settles
  const refresh = () => {
    if (!discard()) return;
    setRevision(value => value + 1);
    if (view.read !== null) registry.refresh(projectDefinitionsAtom(view.read));
  };
  useEffect(() => {
    guard.current = next => {
      const change = scopeChange(next, selection);
      return change === null || discard(change.projectChanges);
    };
    return () => { guard.current = () => true; };
  });
  const changeContext = (main: string, section = route.section) => navigate({...route, page: "projects", projectId: selection.projectId, main, section});
  const workspaceRoute = {...route, page: "projects" as const, projectId: selection.projectId};
  const showDefinitions = inWorkspace && route.section === "definitions";
  const showSupervisor = inWorkspace && route.section !== "definitions" && route.section !== "conversations";
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
    <div hidden={!inWorkspace} className={`stack ${threadId && ["progress", "plan", "supervision"].includes(route.section) ? "conversation-workspace" : ""}`}>
      <div className="page-heading"><nav className="workspace-breadcrumb" aria-label="Workspace breadcrumb"><RouteLink to={directoryRoute} navigate={navigate}>Projects</RouteLink><span aria-hidden="true">/</span><RouteLink to={{...workspaceRoute, main: null, section: "conversations"}} navigate={navigate}>{selectedProject?.title ?? "Unavailable project"}</RouteLink>{threadId && ["progress", "plan", "supervision"].includes(route.section) && <span className="muted">/ Conversation</span>}</nav><div className="row between"><div><h1>{threadId && ["progress", "plan", "supervision"].includes(route.section) ? threads.find(thread => thread.id === threadId)?.title ?? "Unavailable conversation" : selectedProject?.title ?? "Unavailable project"}</h1>{threadId && ["progress", "plan", "supervision"].includes(route.section) && <p className="muted small">Main conversation · {selectedProject?.title}</p>}</div>{threadId && ["progress", "plan", "supervision"].includes(route.section) && <a className="button-link" href={`t3-thread://v1/${threadId}`}><Icon name="external" size={16}/>Open in T3</a>}</div></div>
      <nav className="project-nav" aria-label="Project sections" hidden={Boolean(threadId && ["progress", "plan", "supervision"].includes(route.section))}>
        <RouteLink to={{...workspaceRoute, section: "conversations"}} navigate={navigate} aria-current={["progress", "plan", "supervision", "conversations"].includes(route.section) ? "page" : undefined}>Conversations</RouteLink>
        <RouteLink to={{...workspaceRoute, section: "definitions"}} navigate={navigate} aria-current={route.section === "definitions" ? "page" : undefined}>Definitions</RouteLink>
        <RouteLink to={{...workspaceRoute, section: "settings"}} navigate={navigate} aria-current={route.section === "settings" ? "page" : undefined}>Project settings</RouteLink>
      </nav>
      <details className="context-switcher" hidden={route.section !== "definitions"}><summary>{route.section === "definitions" ? "Definitions checkout" : "Switch conversation or inspect checkout"}</summary><div className="context-bar stack">
        <div className="definition-controls">
          <label className="context-project" htmlFor="definition-project">Project<select id="definition-project" value={selection.projectId} disabled={saving} onChange={event => navigate(openProject(event.target.value))}>
            {!projectId && <option value={selection.projectId}>Project unavailable</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select></label>
          <label htmlFor="definition-thread">{route.section === "definitions" ? "Definitions checkout" : "Conversation"}<select id="definition-thread" value={route.main === null ? "__choose__" : threadId} disabled={!projectId || saving} onChange={event => changeContext(event.target.value, route.section === "definitions" ? "definitions" : event.target.value ? "progress" : "definitions")}>
            <option value="__choose__" disabled>{route.section === "definitions" ? "Choose a checkout" : "Choose a conversation"}</option>
            {threadUnavailable && <option value={threadId} disabled>Conversation unavailable</option>}
            <option value="">Project root checkout</option>{threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
          </select></label>
          <button hidden={route.section !== "definitions"} type="button" disabled={!canLoad || busy || saving} onClick={refresh}>Refresh definitions</button>
        </div>
        {current?.result?.definitions.workspaceRoot && <p className="small muted definition-path">Working folder <code>{current.result.definitions.workspaceRoot}</code></p>}
      </div></details>
      {!projectId && <p className="panel" role="status">The selected project is unavailable. Its context is kept; choose an available project to continue.</p>}
      {threadUnavailable && !["settings", "conversations"].includes(route.section) && <p className="panel" role="status">The selected conversation is no longer available in this project. Choose another conversation.</p>}
      {!data.connected && <p className="panel" role="status">T3 is disconnected. Any unsaved project configuration draft is kept.</p>}
      {saving && <p className="notice" role="status">A save or supervision setup outcome is pending. Inspect Project settings and reload an uncertain outcome before changing scope.</p>}
      {dirty && !onDraftTargetChange && <p className="draft-notice" role="status">Unsaved changes · <RouteLink to={{...workspaceRoute, section: configurationDirty ? "definitions" : "settings"}} navigate={navigate}>Return to your draft</RouteLink>. Switching views keeps your changes.</p>}
      {threadId && ["progress", "plan", "supervision"].includes(route.section) && <nav className="section-nav" aria-label="Conversation views">{(["progress", "plan", "supervision"] as const).map(section => <RouteLink key={section} to={{...workspaceRoute, section}} navigate={navigate} aria-current={route.section === section ? "page" : undefined}>{({progress: "Overview", plan: "Plan & agreement", supervision: "Supervision"})[section]}</RouteLink>)}</nav>}
      {inWorkspace && <div className={threadId && ["progress", "plan", "supervision"].includes(route.section) ? "sr-only" : "section-heading"}><h2 id="project-section-heading" tabIndex={-1}>{({conversations: "Conversations", progress: route.main === null ? "Conversations" : "Conversation overview", plan: "Plan & agreement", supervision: "Supervision", definitions: "Definitions", settings: "Project settings"})[route.section]}</h2><p className="muted">{({conversations: "Open a conversation to understand its work and supervision.", progress: route.main === null ? "Open a conversation to understand its work and supervision." : "The task, current assessment and connected work in one place.", plan: "Review the current proposal, agreement and required commitments.", supervision: "Inspect the Supervisor, helpers, monitoring and recovery for this conversation.", definitions: "Choose the exact checkout, then browse and edit its reusable definition index.", settings: "Enable supervision and set defaults for new Supervisors in this project."})[route.section]}</p></div>}
      {(route.section === "conversations" || route.main === null && route.section !== "settings") && <div className="panel stack">
        <h3>{route.section === "definitions" ? "Choose the definitions checkout" : "Find a conversation"}</h3><label className="search"><span className="sr-only">Find a conversation</span><input aria-label="Find a conversation" type="search" placeholder="Search conversation titles" value={conversationQuery} onChange={event => setConversationQuery(event.target.value)}/></label>
        <div className="conversation-list">{threads.filter(thread => thread.title.toLowerCase().includes(conversationQuery.toLowerCase())).map(thread => {
          const work = overview?.data?.work.find(item => item.mainThreadId === thread.id);
          return <RouteLink key={thread.id} to={{...workspaceRoute, main: thread.id, section: route.section === "definitions" ? "definitions" : "progress"}} navigate={navigate}><div className="conversation-list-copy"><strong>{thread.title}</strong><p className="muted small">{work?.objective ?? "Open to inspect task, plan and current supervision."}</p></div>{work && <WorkState work={work}/>}<Icon name="arrow" size={18}/></RouteLink>;
        })}</div>
        {threads.length === 0 && <p>No available main conversations in this project.</p>}
        <RouteLink className="context-root-link" to={{...workspaceRoute, main: "", section: "definitions"}} navigate={navigate}>Inspect project root checkout</RouteLink>
      </div>}
    </div>
    {selection.projectId && <div hidden={!showSupervisor || (route.main === null && route.section !== "settings")} inert={configurationSaving}><ProjectSupervisorPanel key={selection.projectId} projectId={selection.projectId} threadId={route.section === "settings" ? "" : threadId}
      section={route.section === "conversations" ? "progress" : route.section} attentionEnabled={overview?.data?.projects.find(project => project.id === selection.projectId)?.effectiveEnabled ?? false} connected={data.connected && Boolean(projectId)}
      onDirtyChange={setSupervisorDirty} onSavingChange={setSupervisorSaving}/></div>}
    <div hidden={!showDefinitions} className="stack">
      {busy && <p className="panel" role="status">Reading project definitions…</p>}
      {canLoad && current?.error && <p className="panel" role="alert">Could not load definitions. Refresh to try again or check the Supervisor connection.</p>}
      {messageFor(completion, {read: view.read, environmentId}) !== null && <p role="status">{messageFor(completion, {read: view.read, environmentId})}</p>}
      {canLoad && current?.result && <div className="stack"><p className="muted small" role="status">Loaded {new Date(current.loadedAt!).toLocaleTimeString()}. Refresh after repository changes.</p><DefinitionsContent key={key} definitions={current.result.definitions}/></div>}
      {loaded && <div hidden={!canLoad || view.key !== key} inert={supervisorSaving || configurationSaving}>
        <ProjectConfigurationEditor key={JSON.stringify([loaded.environmentId, loaded.definitions.projectId, loaded.definitions.threadId, loaded.definitions.revision, revision])} definitions={loaded.definitions} onDirtyChange={editorReports.onDirtyChange}
          onSavingChange={editorReports.onSavingChange} onSaved={editorReports.onSaved}/>
      </div>}
    </div>
  </section>;
}
