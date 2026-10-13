import React, { useEffect, useRef, useState } from "react";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { saveProjectRules, ProjectRuleRequestError } from "./project-definitions-api.js";

type Rule = {name: string; description: string; required_blocks: string[]};
const copy = (definitions: ProjectDefinitionSnapshot): Rule[] => definitions.rules.map(rule => ({...rule, required_blocks: [...rule.required_blocks]}));

export function ProjectRulesEditor({definitions, csrfToken, onSaved, onDirtyChange, onSavingChange}: {
  definitions: ProjectDefinitionSnapshot; csrfToken: string;
  onSaved: (result: ProjectDefinitionSnapshot) => void;
  onDirtyChange: (dirty: boolean) => void; onSavingChange: (saving: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [rules, setRules] = useState<Rule[]>(() => copy(definitions));
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const error = useRef<HTMLParagraphElement>(null);
  const dirty = JSON.stringify(rules) !== JSON.stringify(definitions.rules);
  useEffect(() => {onDirtyChange(dirty);}, [dirty, onDirtyChange]);
  const change = (index: number, patch: Partial<Rule>) => {setRules(previous => previous.map((rule, i) => i === index ? {...rule, ...patch} : rule));setMessage("");};
  if (!definitions.editingAvailable) return <p className="panel muted">Project editing needs a dedicated filesystem read/write credential configured through deployment setup.</p>;
  if (!definitions.revision) return <p className="panel muted">Editing requires an existing valid rules.yaml and a complete block collection. Create missing files or fix invalid files in the repository first.</p>;
  if (!editing) return <div className="row"><button type="button" onClick={() => setEditing(true)}>Edit project rules</button><span className="muted">Saved directly to this working directory's .supervisor/rules.yaml.</span></div>;
  return <form className="panel stack project-rule-editor" method="post" action="/api/guidance/project-rules" onSubmit={async event => {
    event.preventDefault();
    if (saving || blocked) return;
    if (rules.some(rule => !rule.name.trim() || !rule.description.trim() || !rule.required_blocks.length) || new Set(rules.map(r => r.name.trim())).size !== rules.length) {
      setMessage("Each rule needs a unique name, a description and at least one required block.");error.current?.focus();return;
    }
    if (!confirm(`Save project rules to ${definitions.workspaceRoot}/.supervisor/rules.yaml? This updates the selected working tree; YAML formatting may be normalized.`)) return;
    setSaving(true);onSavingChange(true);setMessage("");
    try {
      const result = await saveProjectRules({projectId: definitions.projectId, threadId: definitions.threadId, expectedRevision: definitions.revision!, rules}, csrfToken);
      setMessage(result.message);
      if (result.status === "saved" && result.definitions) {onDirtyChange(false);setEditing(false);onSaved(result.definitions);}
      else {setBlocked(result.status === "conflict" || result.status === "uncertain" || result.status === "unavailable");error.current?.focus();}
    } catch (cause) {setMessage(cause instanceof Error ? cause.message : "Save outcome unknown. Refresh before retrying.");setBlocked(!(cause instanceof ProjectRuleRequestError && cause.definitelyNotSaved));}
    finally {setSaving(false);onSavingChange(false);}
  }}>
    <div><h3>Edit project rules</h3><p className="definition-path">Target: <code>{definitions.workspaceRoot}/.supervisor/rules.yaml</code></p><p className="muted">The description explains when a rule applies. Required blocks come from this project's existing Markdown files.</p></div>
    <fieldset disabled={saving} className="stack">
      <legend>Rules</legend>
      {rules.map((rule, index) => <fieldset key={index} className="stack definition-rule-fields">
        <legend>Rule {index + 1}</legend>
        <label>Name (required)<input name={`name-${index}`} required maxLength={160} value={rule.name} onChange={e => change(index, {name: e.target.value})}/></label>
        <label>Description (required)<textarea name={`description-${index}`} required maxLength={8000} rows={3} value={rule.description} onChange={e => change(index, {description: e.target.value})}/></label>
        <fieldset><legend>Required blocks (choose at least one)</legend>
          {definitions.blocks.map(block => <label className="toggle" key={block.id}>
            <input type="checkbox" name={`blocks-${index}`} value={block.id} checked={rule.required_blocks.includes(block.id)} onChange={e => change(index, {required_blocks: e.target.checked ? [...rule.required_blocks, block.id] : rule.required_blocks.filter(id => id !== block.id)})}/>
            <span>{block.name}<small>{block.id} · {block.description}</small></span>
          </label>)}
          {rule.required_blocks.filter(id => !definitions.blocks.some(block => block.id === id)).map(id => <label className="toggle" key={id}>
            <input type="checkbox" name={`blocks-${index}`} value={id} checked onChange={() => change(index, {required_blocks: rule.required_blocks.filter(value => value !== id)})}/><span>Missing or invalid: {id}<small>Uncheck this reference or repair the block in the repository.</small></span>
          </label>)}
        </fieldset>
        <button type="button" onClick={() => setRules(previous => previous.filter((_, i) => i !== index))}>Remove rule {index + 1}</button>
      </fieldset>)}
      {!rules.length && <p>No project requirements. Saving writes an empty rules list.</p>}
      <button type="button" disabled={!definitions.blocks.length || rules.length >= 100} onClick={() => setRules(previous => [...previous, {name: "", description: "", required_blocks: []}])}>Add rule</button>
      {!definitions.blocks.length && <p className="muted">Add a Markdown block in .supervisor/blocks before creating a rule.</p>}
    </fieldset>
    <p ref={error} tabIndex={-1} role={blocked ? "alert" : "status"}>{message}</p>
    {blocked && <p>Your draft is kept. Use Refresh definitions to inspect the latest file before retrying.</p>}
    <div className="row"><button className="primary" type="submit" disabled={saving || blocked}>{saving ? "Saving…" : "Save project rules"}</button>
      <button type="button" disabled={saving} onClick={() => {if (dirty && !confirm("Discard unsaved project-rule changes?")) return;setRules(copy(definitions));onDirtyChange(false);setEditing(false);setBlocked(false);setMessage("");}}>Cancel editing</button>
    </div>
  </form>;
}
