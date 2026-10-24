import { useEffect, useState } from "react";
import type { ProjectCheckoutInventoryInfo } from "../../src/project-definitions-contract.js";
import { EntityDetails } from "./disclosure.js";
import { Icon } from "./icons.js";
import { ListPager, pageWindow } from "./pagination.js";

export type CheckoutTarget = ProjectCheckoutInventoryInfo["targets"][number];
export const branchLabel = (target: Pick<CheckoutTarget, "branch" | "isGitRepository" | "vcsAvailable">) => !target.vcsAvailable ? "Branch information unavailable" : target.branch ? `Branch ${target.branch}` : "Git branch undetected";
export const orphanedConversations = (inventory: ProjectCheckoutInventoryInfo | null) => new Map((inventory?.available ? inventory.targets : []).filter(target => target.presence === "missing").flatMap(target => target.members.map(member => [member.threadId, target.workspaceRoot] as const)));
export function CheckoutIdentity({target, projectFolder = target.isProjectFolder}: {target: CheckoutTarget; projectFolder?: boolean}) {
  return <div className="checkout-identity"><div className="row"><Icon name="folder" size={18}/><strong>{projectFolder ? "Project folder" : target.isDefaultBranch ? "Default branch working folder" : "Separate working copy"}</strong>
    {target.presence === "present" ? <span className={`small ${target.isDefaultBranch ? "default-branch-label" : "muted"}`}>{target.isDefaultBranch ? `Default branch ${target.branch}` : branchLabel(target)}</span> : <span className="pill amber">{target.presence === "missing" ? "Folder missing" : "Folder access unverified"}</span>}</div>
    <code className="definition-path">{target.workspaceRoot}</code><span className="small muted">{target.presence === "missing" ? "Still referenced by" : "Used by"} {target.members.length} {target.members.length === 1 ? "conversation" : "conversations"}</span></div>;
}
export function CheckoutChooser({inventory, selected, onSelect, disabled, onRefresh}: {inventory: ProjectCheckoutInventoryInfo | null; selected: string | null; onSelect: (path: string) => void; disabled: boolean; onRefresh: () => void}) {
  const [query, setQuery] = useState(""); const [page, setPage] = useState(1);
  const all = inventory?.targets ?? [];
  const matching = all.filter(target => `${target.workspaceRoot} ${target.branch ?? ""} ${target.members.map(member => member.title).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const prominent = matching.filter(target => target.presence === "present" && (target.isProjectFolder || target.isDefaultBranch)).sort((a, b) => Number(b.isProjectFolder) - Number(a.isProjectFolder));
  const other = matching.filter(target => target.presence === "present" && !target.isProjectFolder && !target.isDefaultBranch);
  const unavailable = matching.filter(target => target.presence !== "present");
  const range = pageWindow(other.length, page);
  useEffect(() => {if (page !== range.page) setPage(range.page);}, [page, range.page]);
  const row = (target: CheckoutTarget) => <li key={target.workspaceRoot} className={target.isProjectFolder || target.isDefaultBranch ? "checkout-prominent" : undefined}>
    {target.presence === "present" ? <button type="button" className="checkout-target" aria-pressed={selected === target.workspaceRoot} disabled={disabled} onClick={() => onSelect(target.workspaceRoot)}><CheckoutIdentity target={target}/><Icon name={selected === target.workspaceRoot ? "check" : "arrow"} size={18}/></button> : <div className="checkout-target checkout-unavailable"><CheckoutIdentity target={target}/></div>}
    {target.members.length > 0 && <EntityDetails title={<>{target.presence === "missing" ? "Orphaned chats" : "Conversations using this folder"} ({target.members.length})</>} icon="record"><ul>{target.members.slice(0, 10).map(member => <li key={member.threadId}>{member.title}</li>)}</ul>{target.members.length > 10 && <p className="small muted">And {target.members.length - 10} more conversations.</p>}</EntityDetails>}
  </li>;
  const content = <section className="stack checkout-chooser" aria-labelledby="checkout-chooser-title"><div className="row between"><h2 id="checkout-chooser-title">Working folder</h2><button className="quiet-button" type="button" onClick={onRefresh} disabled={disabled}>Refresh folders</button></div>
    <p className="muted small">Choose the folder whose definitions you want to read. The project folder and the default branch are shown first; they share one entry when they coincide.</p>
    {!inventory ? <p role="status">Reading folder and branch identities…</p> : !inventory.available ? <p className="notice" role="status">{inventory.reason} Refresh folders after access or workspace bindings are available.</p> : <>
      {!inventory.complete && <EntityDetails title="Some folder identities could not be verified"><ul>{inventory.issues.map((issue, i) => <li key={issue.threadId ?? i}>{issue.message}</li>)}</ul></EntityDetails>}
      {!inventory.defaultBranch && <p className="small muted">Default branch not reported by Git.</p>}
      <label className="search"><Icon name="search" size={18}/><span className="sr-only">Search working folders</span><input type="search" placeholder="Search folders, branches or conversations" value={query} onChange={event => {setQuery(event.target.value); setPage(1);}}/></label>
      <ul className="checkout-groups checkout-priority" role="list">{prominent.map(row)}</ul>
      {other.length > 0 && <section className="stack"><h3>Other working folders</h3><ul className="checkout-groups" role="list">{other.slice(range.offset, range.offset + range.size).map(row)}</ul><ListPager label="Other working folders" total={other.length} page={range.page} onPage={setPage}/></section>}
      {unavailable.length > 0 && <EntityDetails title={<>Missing or unverified folders ({unavailable.length})</>} icon="folder"><p className="small muted">Retained conversations still reference these paths. They cannot be selected until the folder is available again.</p><ul className="checkout-groups" role="list">{unavailable.map(row)}</ul></EntityDetails>}
      {!matching.length && <p className="muted">No working folders match your search.</p>}
    </>}
  </section>;
  return selected ? <EntityDetails title="Change working folder" icon="folder">{content}</EntityDetails> : content;
}
