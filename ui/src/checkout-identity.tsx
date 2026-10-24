import { useEffect, useState } from "react";
import type { ProjectCheckoutInventoryInfo } from "../../src/project-definitions-contract.js";
import { EntityDetails } from "./disclosure.js";
import { Icon } from "./icons.js";
import { ListPager, pageWindow } from "./pagination.js";

export type CheckoutTarget = ProjectCheckoutInventoryInfo["targets"][number];
export const branchLabel = (target: Pick<CheckoutTarget, "branch" | "isGitRepository" | "vcsAvailable">) => !target.vcsAvailable ? "Branch information unavailable" : !target.isGitRepository ? "Not a Git repository" : target.branch ? `Branch ${target.branch}` : "Git repository · no branch name reported";
export function CheckoutIdentity({target, projectFolder}: {target: CheckoutTarget; projectFolder: boolean}) {
  return <div className="checkout-identity"><div className="row"><Icon name="folder" size={18}/><strong>{projectFolder ? "Project folder" : "Separate working copy"}</strong><span className="small muted">{branchLabel(target)}</span></div><code className="definition-path">{target.workspaceRoot}</code><span className="small muted">Used by {target.members.length} {target.members.length === 1 ? "conversation" : "conversations"}</span></div>;
}
export function CheckoutChooser({inventory, selected, onSelect, disabled, onRefresh}: {inventory: ProjectCheckoutInventoryInfo | null; selected: string | null; onSelect: (path: string) => void; disabled: boolean; onRefresh: () => void}) {
  const [query, setQuery] = useState(""); const [page, setPage] = useState(1);
  const all = inventory?.targets ?? [];
  const matching = all.filter(target => `${target.workspaceRoot} ${target.branch ?? ""} ${target.members.map(member => member.title).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const range = pageWindow(matching.length, page);
  useEffect(() => {if (page !== range.page) setPage(range.page);}, [page, range.page]);
  const content = <section className="stack checkout-chooser" aria-labelledby="checkout-chooser-title"><div className="row between"><h2 id="checkout-chooser-title">Working folder</h2><button type="button" onClick={onRefresh} disabled={disabled}>Refresh folders</button></div>
    <p className="muted small">Conversations without a separate working copy use the project folder and share its definitions. Each folder appears once.</p>
    {!inventory ? <p role="status">Reading folder and branch identities…</p> : !inventory.available ? <p className="notice" role="status">{inventory.reason} Refresh folders after access or workspace bindings are available.</p> : <>
      {!inventory.complete && <div className="notice" role="status"><strong>Some folder identities are unavailable.</strong><ul>{inventory.issues.map((issue, i) => <li key={issue.threadId ?? i}>{issue.message}</li>)}</ul><p>Only independently verified folders are selectable. No unavailable conversation is assumed to use the project folder.</p></div>}
      <label className="search"><Icon name="search" size={18}/><span className="sr-only">Search working folders</span><input type="search" placeholder="Search folders, branches or conversations" value={query} onChange={event => {setQuery(event.target.value); setPage(1);}}/></label>
      <ul className="checkout-groups" role="list">{matching.slice(range.offset, range.offset + range.size).map(target => <li key={target.workspaceRoot}>
        <button type="button" className="checkout-target" aria-pressed={selected === target.workspaceRoot} disabled={disabled} onClick={() => onSelect(target.workspaceRoot)}><CheckoutIdentity target={target} projectFolder={target.threadId === null}/><Icon name={selected === target.workspaceRoot ? "check" : "arrow"} size={18}/></button>
        {target.members.length > 0 && <EntityDetails title={<>Conversations using this folder ({target.members.length})</>} icon="record"><ul>{target.members.slice(0, 10).map(member => <li key={member.threadId}>{member.title}</li>)}</ul>{target.members.length > 10 && <p className="small muted">And {target.members.length - 10} more conversations sharing this folder.</p>}</EntityDetails>}
      </li>)}</ul><ListPager label="Working folders" total={matching.length} page={range.page} onPage={setPage}/>
    </>}
  </section>;
  return selected ? <EntityDetails title="Change working folder" icon="folder">{content}</EntityDetails> : content;
}
