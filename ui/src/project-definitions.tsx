import { ProjectSupervisionStatus } from "./supervision-status.js";
import { CheckoutChooser, CheckoutIdentity, orphanedConversations } from "./checkout-identity.js";
import { projectCheckouts } from "./project-definitions-api.js";
import type { ProjectCheckoutInventoryInfo } from "../../src/project-definitions-contract.js";
import { EntityDetails, HelpDisclosure } from "./disclosure.js";
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
import { type OverviewState, ReadTime, WorkState, useConversationOverview } from "./overview.js";
import { ListPager, pageWindow } from "./pagination.js";
import { Icon } from "./icons.js";
import { DefinitionReferences } from "./definition-references.js";
import { conversationSections, directoryRoute, rememberedConversation, isConversationView, openProject, RouteLink, type NavigationGuard, type Route } from "./navigation.js";

const statusText: Record<ProjectDefinitionSnapshot["status"], string> = {
  ready: "Definitions valid",
  missing: "No definitions in this scope",
  invalid: "Definitions need attention",
  permission_required: "File access needs setup",
  unavailable: "Definitions unavailable",
};

function DefinitionSource({definition}: {definition: {origin?: "global" | "project" | undefined; path?: string | undefined}}) {
  return definition.path ? <p className="small muted definition-path">{definition.origin === "global" ? "Global source · read-only" : "Project source"} <code>{definition.path}</code></p> : null;
}
function DefinitionLink({kind, id, steps, workflows}: {kind: "step" | "workflow"; id: string; steps: readonly DefinitionStepInfo[]; workflows: readonly DefinitionWorkflowInfo[]}) {
  const entry = (kind === "step" ? steps : workflows).find(item => item.id === id);
  return entry ? <span>{entry.name} <code className="small">{id}</code></span> : <span className="pill amber">Unreadable {kind}: {id}</span>;
}
function TemplateNode({node, definitions, ancestors = []}: {node: DefinitionNode; definitions: ProjectDefinitionSnapshot; ancestors?: readonly string[]}) {
  if ("sequence" in node || "parallel" in node) {
    const parallel = "parallel" in node;
    const children = "parallel" in node ? node.parallel : node.sequence;
    const List = parallel ? "ul" : "ol";
    return <div className={parallel ? "template-parallel" : "template-sequence"}><p className="small muted">{parallel ? "In parallel — no declared order" : "In this order"}</p><List className="template-tree" role="list">{children.map((child, i) => <li key={i}><TemplateNode node={child} definitions={definitions} ancestors={ancestors}/></li>)}</List></div>;
  }
  if ("step" in node) {
    const step = typeof node.step === "string" ? definitions.steps.find(item => item.id === node.step) : node.step;
    return <EntityDetails icon="record" title={<>Step: {step?.name ?? String(node.step)}</>} className="template-node">
      {step ? <><p className="definition-copy">{step.description}</p><DefinitionReferences references={step.references} skills={step.skills}/></> : <p className="notice">This referenced step could not be read. Its obligations are not known to be absent.</p>}
    </EntityDetails>;
  }
  const workflow = definitions.workflows.find(item => item.id === node.workflow);
  const cycle = ancestors.includes(node.workflow) || ancestors.length >= 16;
  return <EntityDetails icon="tree" title={<>Workflow: {workflow?.name ?? node.workflow}</>} className="template-node">
    {!workflow ? <p className="notice">The referenced workflow could not be read.</p> : <><p className="definition-copy">{workflow.description}</p><DefinitionReferences references={workflow.references} skills={workflow.skills}/>
      {cycle ? <p className="notice">This reference cannot be expanded further. Review the definition issues and source reference.</p> : <TemplateNode node={workflow.sequence ? {sequence: workflow.sequence} : {parallel: workflow.parallel ?? []}} definitions={definitions} ancestors={[...ancestors, node.workflow]}/>}</>}
  </EntityDetails>;
}
function TemplateTopology({workflow, definitions}: {workflow: DefinitionWorkflowInfo; definitions: ProjectDefinitionSnapshot}) {
  const root = useRef<HTMLDivElement>(null);
  const expand = (open: boolean) => root.current?.querySelectorAll("details").forEach(element => {element.open = open;});
  return <section className="template-topology stack" aria-label="Workflow template structure">
    <div className="row between"><div><h3>Template structure</h3><p className="small muted">Required duties and their relationships. These are definitions, with no execution status.</p></div><div className="row"><button type="button" onClick={() => expand(true)}>Expand all</button><button type="button" onClick={() => expand(false)}>Collapse all</button></div></div>
    <div ref={root}><TemplateNode node={workflow.sequence ? {sequence: workflow.sequence} : {parallel: workflow.parallel ?? []}} definitions={definitions} ancestors={[workflow.id]}/></div>
  </section>;
}
function EffectiveConfiguration({definitions}: {definitions: ProjectDefinitionSnapshot}) {
  const required = requiredReferences(definitions.config);
  return <section className="effective-definition-rules stack"><div><h3>Requirements for this folder</h3><p className="small muted">Project and enabled global definitions are combined here. A required definition remains a commitment when a task plan is formed.</p></div>
    <p><strong>Default workflow:</strong> {definitions.config.default_workflow ? <DefinitionLink kind="workflow" id={definitions.config.default_workflow} steps={definitions.steps} workflows={definitions.workflows}/> : "No starting suggestion"}</p>
    <EntityDetails title={<>Required definitions ({required.length})</>} icon="record">{required.length ? <ul>{required.map((reference, i) => <li key={i}><DefinitionLink kind={"step" in reference ? "step" : "workflow"} id={"step" in reference ? reference.step : reference.workflow} steps={definitions.steps} workflows={definitions.workflows}/></li>)}</ul> : <p>{definitions.complete ? "No required definitions are configured in the readable index." : "The read is incomplete; requirements have not been established."}</p>}</EntityDetails>
  </section>;
}
export function DefinitionsContent({definitions, selectedDefinition = null, onSelect}: {definitions: ProjectDefinitionSnapshot; selectedDefinition?: string | null; onSelect?: (id: string | null) => void}) {
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(1);
  const select = (value: string | null) => onSelect ? onSelect(value) : setLocalSelected(value);
  const selected = onSelect ? selectedDefinition : selectedDefinition ?? localSelected;
  const entries = ([...definitions.config.workflows.map(entry => ({...entry, kind: "workflow" as const})), ...definitions.config.steps.map(entry => ({...entry, kind: "step" as const}))])
    .filter(entry => (kind === "all" || entry.kind === kind || kind === "required" && entry.required) && `${entry.id} ${entry.summary} ${entry.sourceId} ${(entry.kind === "step" ? definitions.steps : definitions.workflows).find(item => item.id === entry.id)?.name ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const range = pageWindow(entries.length, page);
  useEffect(() => {if (range.page !== page) setPage(range.page);}, [range.page, page]);
  const [selectedKind, ...idParts] = selected?.split(":") ?? [];
  const id = idParts.join(":");
  const step = selectedKind === "step" ? definitions.steps.find(item => item.id === id) : undefined;
  const workflow = selectedKind === "workflow" ? definitions.workflows.find(item => item.id === id) : undefined;
  const entry = step ?? workflow;
  const valid = definitions.complete && definitions.status === "ready";
  return <div className="stack definition-workspace">
    <div className="definition-health"><strong>{statusText[definitions.status]}</strong><span className={`pill ${valid ? "green" : "amber"}`}>{valid ? "Valid and complete" : definitions.complete ? "Review validity" : "Read incomplete"}</span></div>
    {!valid && <p className="notice">{definitions.status === "missing" ? "No definitions were found in this folder. Another enabled scope may still have requirements." : "Requirements may be unreadable or incomplete. Review the issues before interpreting this catalog as complete."}</p>}
    {selected ? <section className="definition-detail stack"><button type="button" className="back-link quiet-button" onClick={() => select(null)}><Icon name="back" size={17}/>Back to catalog</button>
      {entry ? <><header className="stack"><div className="row between"><h2>{entry.name}</h2><span className="pill">{entry.origin === "global" ? "Global · read-only" : "Project"}</span></div><p className="small muted">{workflow ? "Workflow template" : "Reusable step"} · <code>{entry.id}</code>{workflow?.fixed && " · Fixed structure"}</p><DefinitionSource definition={entry}/></header>
        <p className="definition-copy">{entry.description}</p><DefinitionReferences references={entry.references} skills={entry.skills}/>{workflow && <TemplateTopology workflow={workflow} definitions={definitions}/>}</> : <p className="notice">This definition is unreadable or no longer in the selected folder. Its reference is retained; return to the catalog to inspect the current issues.</p>}
    </section> : <><EffectiveConfiguration definitions={definitions}/><section className="stack"><div className="row between"><h2>Definition catalog</h2><span className="small muted">Templates, not execution records</span></div>
      <div className="filter-bar"><label className="search"><Icon name="search" size={18}/><span className="sr-only">Search definitions</span><input type="search" value={search} placeholder="Search names, IDs and summaries" onChange={event => {setSearch(event.target.value); setPage(1);}}/></label><label>Show<select value={kind} onChange={event => {setKind(event.target.value);setPage(1);}}><option value="all">All definitions</option><option value="workflow">Workflows</option><option value="step">Steps</option><option value="required">Required</option></select></label></div>
      <ul className="definition-catalog-list" role="list">{entries.slice(range.offset, range.offset + range.size).map(item => {
        const definition = (item.kind === "step" ? definitions.steps : definitions.workflows).find(definition => definition.id === item.id);
        return <li key={`${item.kind}:${item.id}`}><button type="button" className="catalog-row" onClick={() => select(`${item.kind}:${item.id}`)}><Icon name={item.kind === "workflow" ? "tree" : "record"}/><span className="catalog-copy"><strong>{definition?.name ?? item.sourceId}</strong><span className="small muted"><code>{item.id}</code> · {item.origin === "global" ? "Global · read-only" : "Project"}{item.required ? " · Required" : " · Optional"}{definition && "fixed" in definition && definition.fixed ? " · Fixed structure" : ""}{!definition ? " · Definition unreadable; index entry retained" : ""}</span><span className="catalog-summary">{item.summary}</span></span><Icon name="arrow" size={17}/></button></li>;
      })}</ul>{!entries.length && <p className="empty-state muted">No definitions match this view.</p>}<ListPager label="Definition catalog" total={entries.length} page={range.page} onPage={setPage}/>
    </section></>}
    {definitions.issues.length > 0 && <section className="definition-issues stack"><h3>Definition issues</h3><ul>{definitions.issues.map((issue, i) => <li key={`${issue.path}:${i}`}><code>{issue.path}</code><p>{issue.message}</p></li>)}</ul></section>}
    <HelpDisclosure title="How definitions are used"><p>The catalog combines reusable project and enabled global definitions. The index lists available files; a task can add local duties while preserving required and fixed commitments. Edit project.yaml changes only that existing index file. Full duty text, references and skills are available in each definition.</p></HelpDisclosure>
  </div>;
}

// the checkout a definitions view is scoped to; it is retained while the workspace is not shown
export type DefinitionsSelection = {readonly projectId: string; readonly threadId: string; readonly contextSelected: boolean; readonly checkout?: string};

// the route of the pending project draft that the shell links to, or null while nothing is pending
export const draftTarget = (selection: DefinitionsSelection, pending: {dirty: boolean; saving: boolean; configurationDirty: boolean}): Route | null =>
  pending.dirty || pending.saving
    ? {page: "projects", projectId: selection.projectId, main: selection.contextSelected ? selection.threadId : null, section: pending.configurationDirty ? "editor" : "settings", ...(selection.checkout ? {checkout: selection.checkout} : {})}
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

const noCheckouts = Atom.make(AsyncResult.initial<ProjectCheckoutInventoryInfo>());
const noDefinitions: Atom.Atom<AsyncResult.AsyncResult<LoadedDefinitions, ProjectDefinitionsReadError>> = Atom.make(AsyncResult.initial());
const epochOf = (epoch: AsyncResult.AsyncResult<number, unknown>) => Option.getOrElse(AsyncResult.value(epoch), () => 0);

export function ProjectDefinitionsPanel({data, overview, route, navigate, guard, onDirtyChange, onDraftTargetChange, dataCurrent = true}: {
  data: GuidanceSnapshot; dataCurrent?: boolean; overview?: OverviewState; route: Route; navigate: (route: Route, options?: {replace?: boolean}) => void; guard: React.RefObject<NavigationGuard>;
  onDirtyChange?: (dirty: boolean) => void; onDraftTargetChange?: (route: Route | null) => void;
}) {
  const [projectQuery, setProjectQuery] = useState("");
  const [projectPage, setProjectPage] = useState(1);
  const matchingProjects = data.projects.filter(project => project.title.toLowerCase().includes(projectQuery.toLowerCase())).sort((a, b) => a.id.localeCompare(b.id));
  const projectRange = pageWindow(matchingProjects.length, projectPage);
  useEffect(() => {if (projectPage !== projectRange.page) setProjectPage(projectRange.page);}, [projectPage, projectRange.page]);
  const conversationQuery = route.q ?? "";
  const conversationPage = route.listPage ?? 1;
  const retained = useRef<DefinitionsSelection>({projectId: "", threadId: "", contextSelected: false});
  const inWorkspace = route.page === "projects" && Boolean(route.projectId);
  const selection: DefinitionsSelection = inWorkspace ? {projectId: route.projectId, threadId: route.main ?? "", contextSelected: route.main !== null, ...(route.checkout ? {checkout: route.checkout} : {})} : retained.current;
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
  const projects = data.projects.filter(project => project.available);
  const projectId = projects.some(project => project.id === selection.projectId) ? selection.projectId : "";
  const threads = data.threads.filter(thread => thread.available && thread.projectId === projectId).sort((a, b) => a.id.localeCompare(b.id));
  const threadUnavailable = Boolean(projectId && selection.threadId && !threads.some(thread => thread.id === selection.threadId));
  const threadId = selection.threadId;
  const epoch = useAtomValue(authEpochAtom, epochOf);
  const definitionView = inWorkspace && ["definitions", "editor"].includes(route.section);
  const globalOnly = data.projects.find(project => project.id === projectId)?.classification === "scratch";
  const inventoryKey = scopeKey(environmentId, projectId, epoch, revision);
  const inventoryRead = useAtomValue(inWorkspace && projectId && !globalOnly ? projectCheckouts(inventoryKey) : noCheckouts);
  const inventory = AsyncResult.isFailure(inventoryRead) ? {projectId, available: false, reason: "Working folders could not be read. Check the connection and refresh folders.", complete: false, defaultBranch: null, issues: [], targets: []} : Option.getOrNull(AsyncResult.value(inventoryRead));
  const orphaned = orphanedConversations(inventory);
  const matchingThreads = threads.filter(thread => (route.showOrphaned || !orphaned.has(thread.id)) && `${thread.title} ${thread.id}`.toLowerCase().includes(conversationQuery.toLowerCase()));
  const conversationRange = pageWindow(matchingThreads.length, conversationPage);
  const visibleThreads = matchingThreads.slice(conversationRange.offset, conversationRange.offset + conversationRange.size);
  const conversationListVisible = inWorkspace && (route.section === "conversations" || route.main === null && conversationSections.includes(route.section));
  const conversationOverview = useConversationOverview(projectId, visibleThreads.map(thread => thread.id), conversationListVisible && data.connected);
  const conversationReadCurrent = Boolean(conversationOverview.data?.available) && !conversationOverview.loading && !conversationOverview.error && dataCurrent && data.connected;
  const resume = rememberedConversation(projectId);
  const listRoute: Route = {...route, page: "projects", projectId, main: null, section: "conversations"};
  useEffect(() => {
    if (dataCurrent && data.connected && projectId && route.section === "conversations" && conversationPage !== conversationRange.page)
      navigate({...listRoute, listPage: conversationRange.page}, {replace: true});
  }, [projectId, conversationQuery, conversationPage, conversationRange.page, route.section, dataCurrent, data.connected]);
  const selectedCheckout = inventory?.targets.find(target => route.checkout ? target.workspaceRoot === route.checkout : route.main !== null && (route.main === "" ? target.threadId === null : target.members.some(member => member.threadId === route.main)));
  const definitionThreadId = selectedCheckout?.threadId ?? null;
  const canLoad = Boolean(projectId && definitionView && (globalOnly || selectedCheckout?.presence === "present") && data.connected);
  const key = JSON.stringify([environmentId, projectId, selectedCheckout?.workspaceRoot ?? "global", revision, canLoad]);
  const live = {key, read: canLoad ? definitionsReadKey(environmentId, projectId, definitionThreadId, epoch, selectedCheckout && !selectedCheckout.isProjectFolder && selectedCheckout.threadId === null ? selectedCheckout.workspaceRoot : undefined) : null, environmentId};
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
  const knownDefinitions = useRef<LoadedDefinitions | null>(null);
  if (loaded) knownDefinitions.current = loaded;
  const owner = configurationDirty || configurationSaving ? knownDefinitions.current : loaded;
  useEffect(() => {
    const target = configurationDirty && owner ? {projectId: owner.definitions.projectId, threadId: "", contextSelected: false, checkout: owner.definitions.workspaceRoot} : selection;
    onDraftTargetChange?.(draftTarget(target, {dirty, saving, configurationDirty}));
  }, [dirty, saving, configurationDirty, owner?.definitions.projectId, owner?.definitions.workspaceRoot, selection.projectId, selection.threadId, selection.contextSelected, selection.checkout, onDraftTargetChange]);
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
      const folder = owner?.definitions.workspaceRoot;
      const definitionDestination = next.page === "projects" && ["definitions", "editor"].includes(next.section);
      if ((!definitionDestination || next.main === null && !next.checkout) && !supervisorDirty && !supervisorSaving) return true;
      const nextFolder = inventory?.targets.find(target => next.checkout && ["definitions", "editor"].includes(next.section) ? target.workspaceRoot === next.checkout : next.main === "" ? target.threadId === null : target.members.some(member => member.threadId === next.main));
      if (!saving && !supervisorDirty && next.projectId === selection.projectId && folder && (next.checkout === folder || nextFolder?.workspaceRoot === folder)) return true;
      const changedFolder = ["definitions", "editor"].includes(next.section) && next.checkout && next.checkout !== folder;
      const change = changedFolder ? {projectChanges: next.projectId !== selection.projectId} : scopeChange(next, selection);
      return change === null || discard(change.projectChanges);
    };
    return () => { guard.current = () => true; };
  });
  const workspaceRoute = {...route, page: "projects" as const, projectId: selection.projectId};
  const showDefinitions = inWorkspace && (route.section === "definitions" || route.section === "editor");
  const showSupervisor = inWorkspace && route.section !== "definitions" && route.section !== "editor" && route.section !== "conversations";
  const conversation = inWorkspace && Boolean(threadId) && isConversationView(route);
  const projectStatus = overview?.data?.projects.find(project => project.id === selection.projectId);
  const selectedProject = data.projects.find(project => project.id === selection.projectId);
  return <section className="stack project-definitions" aria-label="Projects">
    <div hidden={inWorkspace} className="stack">
      <div className="page-heading heading-actions"><div><h1>Projects</h1><p className="muted">A workspace for each project, with its conversations, definitions and supervision settings.</p></div><ReadTime value={overview?.data?.observedAt ?? null}/></div>
      <label className="search project-search"><Icon name="search" size={18}/><span className="sr-only">Find a project</span><input type="search" aria-label="Find a project" placeholder="Find a project" value={projectQuery} onChange={event => {setProjectQuery(event.target.value);setProjectPage(1);}}/></label>
      <div className="project-list">
        {matchingProjects.slice(projectRange.offset, projectRange.offset + projectRange.size).map(project => {
          const status = overview?.data?.projects.find(item => item.id === project.id);
          return <RouteLink key={project.id} to={openProject(project.id)} navigate={navigate} className="project-card">
            <span className="project-avatar" aria-hidden="true"><Icon name="projects"/></span>
            <span className="project-card-copy"><strong>{project.title}</strong><span className="muted small">{data.threads.filter(thread => thread.available && thread.projectId === project.id).length} {data.threads.filter(thread => thread.available && thread.projectId === project.id).length === 1 ? "conversation" : "conversations"}{project.classification === "scratch" ? " · Scratch workspace" : ""}</span></span>
            <span className="project-status"><ProjectSupervisionStatus enabled={status?.enabled ?? false} effectiveEnabled={status?.effectiveEnabled ?? false} globallyEnabled={overview?.data?.globallyEnabled ?? false} available={project.available && Boolean(status) && data.connected && !overview?.error}/><span className="small muted">{status?.attentionTotal === undefined ? "Attention state unavailable" : status.attentionTotal > 0 ? `${status.attentionTotal} ${status.attentionTotal === 1 ? "conversation needs" : "conversations need"} attention` : "Open workspace"}</span></span><Icon name="arrow" size={18}/>
          </RouteLink>;
        })}
      </div>
      <ListPager label="Projects" total={matchingProjects.length} page={projectRange.page} onPage={setProjectPage}/>
      {!data.projects.some(project => project.title.toLowerCase().includes(projectQuery.toLowerCase())) && <p className="empty-state muted">{projectQuery ? "No projects match your search." : "No T3 projects are available. Add a project in T3 to begin."}</p>}
    </div>
    <div hidden={!inWorkspace} className={`stack ${conversation ? "conversation-workspace" : ""}`}>
      <div className="page-heading">{conversation && <RouteLink className="back-link" to={listRoute} navigate={navigate}><Icon name="back" size={17}/>Back to conversations</RouteLink>}<div className="project-context-line"><nav className="workspace-breadcrumb" aria-label="Workspace breadcrumb"><RouteLink to={directoryRoute} navigate={navigate}>Projects</RouteLink><span aria-hidden="true">/</span><RouteLink to={{...workspaceRoute, main: null, section: "conversations"}} navigate={navigate}>{selectedProject?.title ?? "Unavailable project"}</RouteLink></nav><span className="project-context-status"><ProjectSupervisionStatus compact enabled={projectStatus?.enabled ?? false} effectiveEnabled={projectStatus?.effectiveEnabled ?? false} globallyEnabled={overview?.data?.globallyEnabled ?? false} available={Boolean(projectStatus?.available) && data.connected && !overview?.error}/></span></div><div className="row between page-title-row"><h1>{conversation ? threads.find(thread => thread.id === threadId)?.title ?? "Unavailable conversation" : selectedProject?.title ?? "Unavailable project"}</h1>{conversation && <div className="title-actions"><nav className="section-nav" aria-label="Conversation views">{conversationSections.map(section => <RouteLink key={section} to={{...workspaceRoute, section}} navigate={navigate} aria-current={route.section === section ? "page" : undefined}>{section === "task" ? "Task" : section === "connected" ? "Connected work" : "Supervision"}</RouteLink>)}</nav><a className="button-link" href={`t3-thread://v1/${threadId}`}><Icon name="external" size={16}/>Open in T3</a></div>}</div></div>
      <nav className="project-nav" aria-label="Project sections" hidden={conversation}>
        <RouteLink to={{...workspaceRoute, main: null, section: "conversations"}} navigate={navigate} aria-current={route.section === "conversations" || conversationSections.includes(route.section) ? "page" : undefined}>Conversations</RouteLink>
        <RouteLink to={{...workspaceRoute, section: "definitions"}} navigate={navigate} aria-current={definitionView ? "page" : undefined}>Definitions</RouteLink>
        <RouteLink to={{...workspaceRoute, section: "settings"}} navigate={navigate} aria-current={route.section === "settings" ? "page" : undefined}>Project settings</RouteLink>
      </nav>
      {inWorkspace && !conversation && <div className="section-heading"><h2 id="project-section-heading" className="sr-only">{route.section === "definitions" ? "Definitions" : route.section === "editor" ? "Edit project.yaml" : route.section === "settings" ? "Project settings" : "Conversations"}</h2><p className="muted">{route.section === "definitions" ? "Reusable steps and workflow templates in the selected working folder." : route.section === "editor" ? "Edit the selected folder’s .t3-supervisor/project.yaml. Reusable definitions remain read-only." : route.section === "settings" ? "Which conversations are supervised here, and the defaults for new Supervisors." : "Open a conversation to see its task, plan and supervision."}</p></div>}
      {route.section === "definitions" && !globalOnly && <CheckoutChooser inventory={inventory} selected={selectedCheckout?.workspaceRoot ?? null} disabled={saving || !data.connected} onSelect={checkout => navigate({...workspaceRoute, main: null, checkout, definition: ""})} onRefresh={() => registry.refresh(projectCheckouts(inventoryKey))}/>}
      {showDefinitions && globalOnly && <p className="notice">Global definitions · No Project has no project-owned configuration to edit.</p>}
      {showDefinitions && selectedCheckout && <div className="checkout-bar"><CheckoutIdentity target={selectedCheckout} projectFolder={selectedCheckout.isProjectFolder}/><div className="row">{route.section === "definitions" && selectedCheckout.presence === "present" && (selectedCheckout.isProjectFolder || selectedCheckout.threadId !== null) && <RouteLink to={{...workspaceRoute, section: "editor"}} navigate={navigate}>Edit project.yaml</RouteLink>}<button type="button" className="quiet-button" disabled={!canLoad || busy || saving} onClick={refresh}>Refresh definitions</button></div></div>}
      {route.section === "editor" && <div className="row"><RouteLink className="back-link" to={{...workspaceRoute, section: "definitions"}} navigate={navigate}><Icon name="back" size={17}/>Back to Definitions</RouteLink>{!selectedCheckout && <p className="muted small">Choose a working folder in Definitions before editing project.yaml.</p>}</div>}
      {conversation && orphaned.has(threadId) && <p className="notice" role="status"><strong>Orphaned chat · working folder missing.</strong> <code>{orphaned.get(threadId)}</code>. The conversation history is retained; this folder is no longer available.</p>}
      {!projectId && <p className="panel" role="status">The selected project is unavailable. Its context is kept; choose an available project to continue.</p>}
      {threadUnavailable && !["settings", "conversations"].includes(route.section) && <p className="panel" role="status">The selected conversation is no longer available in this project. Choose another conversation.</p>}
      {!data.connected && <p className="panel" role="status">T3 is disconnected. Any unsaved project configuration draft is kept.</p>}
      {saving && <p className="notice" role="status">A save or supervision setup outcome is pending. Inspect Project settings and reload an uncertain outcome before changing scope.</p>}
      {dirty && !onDraftTargetChange && <p className="draft-notice" role="status">Unsaved changes · <RouteLink to={{...workspaceRoute, section: configurationDirty ? "editor" : "settings"}} navigate={navigate}>Return to your draft</RouteLink>. Switching views keeps your changes.</p>}
      {(route.section === "conversations" || route.main === null && conversationSections.includes(route.section)) && <div className="panel stack">
        <label className="search"><span className="sr-only">Find a conversation</span><input aria-label="Find a conversation" type="search" placeholder="Search conversation titles" value={conversationQuery} onChange={event => navigate({...listRoute, q: event.target.value, listPage: 1}, {replace: true})}/></label>
        <div className="row between"><label className="toggle"><input type="checkbox" checked={route.showOrphaned ?? false} onChange={event => navigate({...listRoute, showOrphaned: event.target.checked, listPage: 1})}/><span>Show orphaned chats{orphaned.size ? ` (${orphaned.size})` : ""}</span></label><button type="button" className="quiet-button" onClick={() => registry.refresh(projectCheckouts(inventoryKey))} disabled={!data.connected}>Refresh folders</button></div>
        {inventory && !inventory.complete && <p className="small muted">Some folder checks are unavailable. Those chats remain visible until their folders can be verified.</p>}
        {resume && matchingThreads.some(thread => thread.id === resume.main) && <p className="small muted">Continue where you left off: <RouteLink to={resume} navigate={navigate}>{threads.find(thread => thread.id === resume.main)?.title} · {resume.section === "task" ? "Task" : resume.section === "connected" ? "Connected work" : "Supervision"}</RouteLink></p>}
        <ListPager label="Conversations" total={matchingThreads.length} page={conversationRange.page} onPage={listPage => navigate({...listRoute, listPage})}/>
        <div className="conversation-list">{visibleThreads.map(thread => {
          const work = conversationOverview.data?.work.find(item => item.mainThreadId === thread.id);
          return <RouteLink key={thread.id} to={{...workspaceRoute, main: thread.id, section: "task"}} navigate={navigate}><div className="conversation-list-copy"><strong>{thread.title}</strong>{orphaned.has(thread.id) && <p className="orphaned-chat-label"><Icon name="folder" size={15}/>Orphaned chat · folder missing <code>{orphaned.get(thread.id)}</code></p>}<p className="muted small">{work?.objective ?? "Open to inspect task, plan and current supervision."}</p></div>{orphaned.has(thread.id) ? <span className="pill amber">Orphaned</span> : work ? <WorkState work={work} fresh={conversationReadCurrent}/> : <span className="small muted">{conversationReadCurrent ? "No Supervisor yet" : conversationOverview.error || !data.connected ? "Conversation state unavailable" : "Reading conversation state…"}</span>}<Icon name="arrow" size={18}/></RouteLink>;
        })}</div>
        {matchingThreads.length === 0 && <p>{conversationQuery ? "No conversations match your search." : "No available main conversations in this project."}</p>}
      </div>}
    </div>
    {selection.projectId && <div hidden={!showSupervisor || (route.main === null && route.section !== "settings")} inert={configurationSaving}><ProjectSupervisorPanel key={selection.projectId} projectId={selection.projectId} threadId={route.section === "settings" ? "" : threadId}
      section={route.section === "settings" ? "settings" : route.section === "supervision" ? "supervision" : route.section === "connected" ? "connected" : "task"} attentionEnabled={overview?.data?.projects.find(project => project.id === selection.projectId)?.effectiveEnabled ?? false} connected={data.connected && Boolean(projectId)}
      supervisionLink={conversation && route.section === "task" ? <RouteLink to={{...workspaceRoute, section: "supervision"}} navigate={navigate}>Open Supervision for recovery and controls</RouteLink> : undefined}
      connectedWorkLink={conversation ? <RouteLink to={{...workspaceRoute, section: "connected"}} navigate={navigate}>View connected work</RouteLink> : undefined}
      onDirtyChange={setSupervisorDirty} onSavingChange={setSupervisorSaving}/></div>}
    <div hidden={!showDefinitions} className="stack">
      {busy && <p className="panel" role="status">Reading project definitions…</p>}
      {canLoad && current?.error && <p className="panel" role="alert">Could not load definitions. Refresh to try again or check the Supervisor connection.</p>}
      {messageFor(completion, {read: view.read, environmentId}) !== null && <p role="status">{messageFor(completion, {read: view.read, environmentId})}</p>}
      {canLoad && current?.result && <div className="stack"><p className="muted small" role="status">Read {new Date(current.loadedAt!).toLocaleTimeString()}. Refresh after repository changes.</p><div hidden={route.section !== "definitions"}><DefinitionsContent key={key} definitions={current.result.definitions} selectedDefinition={route.definition ?? null} onSelect={definition => navigate({...workspaceRoute, definition: definition ?? ""})}/></div></div>}
      {loaded && <div hidden={!canLoad || view.key !== key || route.section !== "editor"} inert={supervisorSaving || configurationSaving}>
        <ProjectConfigurationEditor key={JSON.stringify([loaded.environmentId, loaded.definitions.projectId, loaded.definitions.threadId, loaded.definitions.revision, revision])} definitions={loaded.definitions} editingRequested={route.section === "editor"} onDirtyChange={editorReports.onDirtyChange}
          onSavingChange={editorReports.onSavingChange} onSaved={editorReports.onSaved}/>
      </div>}
    </div>
  </section>;
}
