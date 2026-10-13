import React, { useCallback, useEffect, useState } from "react";
import type { GuidanceSnapshot } from "../../src/guidance-contract.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { loadProjectDefinitions } from "./project-definitions-api.js";
import { ProjectRulesEditor } from "./project-rules-editor.js";
import { ProjectSupervisorPanel } from "./project-supervisor.js";

const statusText: Record<ProjectDefinitionSnapshot["status"], string> = {
  ready: "Definitions valid",
  missing: "No project definitions",
  invalid: "Definitions need attention",
  permission_required: "File access needs setup",
  unavailable: "Definitions unavailable",
};

export function DefinitionsContent({definitions}: {definitions: ProjectDefinitionSnapshot}) {
  const ids = new Set(definitions.blocks.map(b => b.id));
  const inspect = (id: string) => {
    const block = document.getElementById(`definition-block-${id}`);
    if (block instanceof HTMLDetailsElement) {
      block.open = true;
      block.querySelector("summary")?.focus({preventScroll: true});
      block.scrollIntoView({block: "start"});
    }
  };
  return <div className="stack">
    <div className="panel stack">
      <div className="row between">
        <h3>{statusText[definitions.status]}</h3>
        <span className={`pill ${definitions.status === "ready" ? "green" : "amber"}`}>{definitions.status === "ready" ? "Valid" : "Check definitions"}</span>
      </div>
      {definitions.workspaceRoot && <p className="muted definition-path">Read from <code>{definitions.workspaceRoot}/.supervisor</code></p>}
      {definitions.status === "missing" && <p>Create <code>.supervisor/rules.yaml</code> and reusable Markdown blocks in this project's working directory.</p>}
      {definitions.status === "invalid" && <p>This collection is incomplete or invalid. Valid items below are available for inspection.</p>}
      {definitions.status === "permission_required" && <p>The deployment needs file-reading permission. No credential can be entered or changed from this page.</p>}
      {definitions.issues.length > 0 && <ul className="definition-issues">{definitions.issues.map((issue, i) => <li key={`${issue.path}:${issue.code}:${i}`}>
        {issue.path && <code>{issue.path}</code>}<p>{issue.message}</p>
      </li>)}</ul>}
    </div>
    {(definitions.status === "ready" || definitions.rules.length > 0 || definitions.blocks.length > 0) && <>
      <section className="stack" aria-labelledby="project-rule-title">
        <div><h3 id="project-rule-title">Project rules <span className="muted">({definitions.rules.length})</span></h3><p className="muted">Descriptions explain when the listed blocks are required.</p></div>
        {definitions.rules.length === 0 && <p className="panel muted">{definitions.status === "ready" ? "No requirements are declared in this collection." : "No readable rules are available. See issues above."}</p>}
        {definitions.rules.map(rule => <article className="panel stack" key={rule.name}>
          <h4 className="definition-name">{rule.name}</h4><p className="definition-copy">{rule.description}</p>
          <div><p className="small muted">Required blocks</p><div className="row">{rule.required_blocks.map(id => ids.has(id)
            ? <button key={id} type="button" onClick={() => inspect(id)}>{definitions.blocks.find(b => b.id === id)!.name} <span className="muted small">({id})</span></button>
            : <span key={id} className="pill amber">Missing or invalid: {id}</span>)}</div></div>
        </article>)}
      </section>
      <section className="stack" aria-labelledby="project-block-title">
        <div><h3 id="project-block-title">Reusable blocks <span className="muted">({definitions.blocks.length})</span></h3><p className="muted">Inspect instructions, expected results and the rules that reference each block.</p></div>
        {definitions.blocks.length === 0 && <p className="panel muted">No reusable blocks are available.</p>}
        {definitions.blocks.map(block => {
          const rules = definitions.rules.filter(rule => rule.required_blocks.includes(block.id));
          return <details className="panel definition-block" key={block.id} id={`definition-block-${block.id}`}>
            <summary>{block.name} <span className="muted small">{block.id}.md</span></summary>
            <div className="stack"><p className="definition-copy">{block.description}</p>
              {(rules.length > 0 || definitions.status === "ready") && <p className="muted small">{rules.length ? `Referenced by loaded rules: ${rules.map(rule => rule.name).join(", ")}` : "No declared rule references this block."}</p>}
              <div><h4>Instructions</h4><pre className="definition-copy">{block.instructions}</pre></div>
              <div><h4>Expected result</h4><pre className="definition-copy">{block.expected_result}</pre></div>
            </div>
          </details>;
        })}
      </section>
    </>}
  </div>;
}

export function ProjectDefinitionsPanel({data, csrfToken = "", onDirtyChange}: {data: GuidanceSnapshot; csrfToken?: string; onDirtyChange?: (dirty: boolean) => void}) {
  const [selection, setSelection] = useState({projectId: "", threadId: ""});
  const [revision, setRevision] = useState(0);
  const [rulesDirty, setRulesDirty] = useState(false);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [supervisorDirty, setSupervisorDirty] = useState(false);
  const [supervisorSaving, setSupervisorSaving] = useState(false);
  const dirty = rulesDirty || supervisorDirty;
  const saving = rulesSaving || supervisorSaving;
  const [savedMessage, setSavedMessage] = useState("");
  const reportDirty = useCallback((value: boolean) => setRulesDirty(value), []);
  useEffect(() => {onDirtyChange?.(dirty || saving);}, [dirty, saving, onDirtyChange]);
  const projects = data.projects.filter(p => p.available);
  const projectId = projects.some(p => p.id === selection.projectId) ? selection.projectId : "";
  const threads = data.threads.filter(t => t.available && t.projectId === projectId);
  const threadUnavailable = Boolean(projectId && selection.threadId && !threads.some(t => t.id === selection.threadId));
  const threadId = selection.threadId;
  const canLoad = Boolean(projectId && !threadUnavailable && data.connected);
  const key = JSON.stringify([projectId, threadId, revision, canLoad]);
  const [state, setState] = useState<{key: string; result: ProjectDefinitionSnapshot | null; error: boolean; loadedAt: number | null}>({key: "", result: null, error: false, loadedAt: null});
  useEffect(() => {
    if (rulesDirty || rulesSaving) return;
    if (!canLoad) return;
    setState({key, result: null, error: false, loadedAt: null});
    const controller = new AbortController();
    void loadProjectDefinitions(projectId, threadId || null, controller.signal).then(result => {
      if (!controller.signal.aborted) setState({key, result, error: false, loadedAt: Date.now()});
    }, () => {
      if (!controller.signal.aborted) setState({key, result: null, error: true, loadedAt: null});
    });
    return () => controller.abort();
  }, [projectId, threadId, key, canLoad]);
  const current = state.key === key ? state : null;
  const busy = Boolean(canLoad && !current?.result && !current?.error);
  const discard = (includeSupervisor = false) => {
    if (saving || (rulesDirty || includeSupervisor && supervisorDirty) && !confirm(includeSupervisor ? "Discard unsaved project rules and Supervisor settings?" : "Discard unsaved project-rule changes and reload definitions?")) return false;
    if (includeSupervisor) setSupervisorDirty(false);
    reportDirty(false);setSavedMessage("");setState({key: "", result: null, error: false, loadedAt: null});return true;
  };
  return <section className="stack project-definitions" aria-labelledby="definition-title">
    <div><h2 id="definition-title">Project definitions</h2><p className="muted">Edit project rules and inspect reusable blocks. Files in the repository are the source of truth.</p></div>
    <div className="panel definition-controls">
      <label>Project<select value={projectId} disabled={saving} onChange={event => {if (discard(true)) setSelection({projectId: event.target.value, threadId: ""});}}>
        <option value="">Select a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select></label>
      <label>Working directory<select value={threadId} disabled={!projectId || saving} onChange={event => {if (discard()) setSelection(previous => ({...previous, threadId: event.target.value}));}}>
        {threadUnavailable && <option value={threadId} disabled>Conversation unavailable</option>}
        <option value="">Project root</option>{threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
      </select></label>
      <button type="button" disabled={!canLoad || busy || saving} onClick={() => {if (discard()) setRevision(n => n + 1);}}>Refresh definitions</button>
    </div>
    {selection.projectId && <div inert={rulesSaving}><ProjectSupervisorPanel key={selection.projectId} projectId={selection.projectId} threadId={threadId}
      connected={data.connected && Boolean(projectId)} csrfToken={csrfToken}
      onDirtyChange={setSupervisorDirty} onSavingChange={setSupervisorSaving}/></div>}
    {!projectId && <p className="panel muted">{projects.length ? "Select a project to inspect its definitions." : "No available T3 projects. Add a project in T3 to inspect its definitions here."}</p>}
    {threadUnavailable && <p className="panel" role="status">The selected conversation is no longer available in this project. Choose another working directory.</p>}
    {!data.connected && <p className="panel" role="status">T3 is disconnected. Any unsaved draft is kept.</p>}
    {busy && <p className="panel" role="status">Reading project definitions…</p>}
    {canLoad && current?.error && <p className="panel" role="alert">Could not load definitions. Refresh to try again or check the Supervisor connection.</p>}
    {savedMessage && <p role="status">{savedMessage}</p>}
    {state.result && <div hidden={!canLoad || state.key !== key} inert={supervisorSaving}>
      <ProjectRulesEditor key={JSON.stringify([state.result.projectId, state.result.threadId, state.result.revision, revision])} definitions={state.result} csrfToken={csrfToken} onDirtyChange={reportDirty} onSavingChange={setRulesSaving}
        onSaved={result => {setState({key, result, error: false, loadedAt: Date.now()});setSavedMessage("Saved project rules to .supervisor/rules.yaml.");}}/>
    </div>}
    {canLoad && current?.result && <>
      <p className="muted small" role="status">Loaded {new Date(current.loadedAt!).toLocaleTimeString()}. Refresh after repository changes.</p>
      <DefinitionsContent key={key} definitions={current.result}/>
    </>}
  </section>;
}
