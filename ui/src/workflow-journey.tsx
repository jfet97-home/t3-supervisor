import React from "react";
import {DefinitionReferences} from "./definition-references.js";
import type { TaskInterpretationInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo } from "../../src/project-supervisor-contract.js";
import type { WorkflowAssessmentInfo } from "../../src/workflow-assessment.js";
import type { WorkflowProgressContribution, WorkflowProgressObservation } from "../../src/workflow-progress.js";
import { acceptedAgreement, pendingProposal, statusRecord, type PlanChange, type PlanChangeField, type StepNotes } from "./task-record.js";

const states = {planned: "Planned", underway: "In progress", completed: "Completed", needs_attention: "Needs attention"} as const;
const recordStates = {planned: "planned", underway: "in progress", completed: "completed", needs_attention: "needs attention"} as const;
export type JourneyMode = "live" | "agreed" | "proposed" | "historical";
const modeLabels = {agreed: "Accepted", proposed: "Proposed", historical: "In earlier plan"} as const;

const formatTime = (value: number) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : date.toLocaleString();
};

export function StepMark({state}: {state: string}) {
  return <span className={`step-mark state-${state}`} aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {state === "completed" ? <path d="m5 10 3 3 7-7"/> : state === "needs_attention" ? <path d="M10 5v6m0 3h.01"/> : state === "underway" ? <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none"/> : null}
  </svg></span>;
}

export function planSteps(node: WorkflowPlanNodeInfo | null): Array<Extract<WorkflowPlanNodeInfo, {kind: "step"}>> {
  if (!node) return [];
  if ("nodes" in node) return node.nodes.flatMap(planSteps);
  return node.kind === "workflow" ? planSteps(node.plan) : [node];
}

export const hasCurrentAgreement = (task: TaskInterpretationInfo | undefined) => Boolean(acceptedAgreement(task) && !pendingProposal(task));

/** The one-line agreement state for the task band. */
export const alignmentLabel = (task: TaskInterpretationInfo | undefined) => hasCurrentAgreement(task) ? "Plan accepted"
  : acceptedAgreement(task) ? "Update awaiting acceptance"
  : task?.agreement?.status === "stale" ? "Acceptance needs review"
  : task?.workflow?.status === "proposed" ? "Awaiting acceptance"
  : task?.workflow ? "Plan being prepared" : "No plan yet";

const hasActiveNode = (node: WorkflowPlanNodeInfo): boolean => "nodes" in node ? node.nodes.some(hasActiveNode) :
  node.status === "underway" || node.status === "needs_attention" || node.kind === "workflow" && node.plan !== null && hasActiveNode(node.plan);

const noNotes: StepNotes = {agreed: null, proposed: null, records: null, changed: new Set()};

/** The step's records: the status record that explains its current state, then any other notes about it. */
function StepRecords({status, records}: {status: keyof typeof states; records: readonly WorkflowProgressObservation[] | undefined}) {
  const current = status === "planned" ? null : statusRecord(records, status);
  const others = (records ?? []).filter(item => item !== current).reverse();
  return <>
    {current
      ? <div className="step-assessment"><strong>Supervisor assessment</strong><p>{current.note}</p>
        <p className="small muted">Recorded {current.statusFrom ? `${recordStates[current.statusFrom]} → ` : ""}{recordStates[status]} · {formatTime(current.recordedAt)}</p></div>
      : status !== "planned" && <p className="small muted">No status record for this step was read.</p>}
    {others.length > 0 && <details className="step-history"><summary>Earlier step records ({others.length})</summary><ol className="stack">{others.map(item => <li key={item.id}>
      <p>{item.note}</p><p className="small muted">{item.kind === "status_changed" ? `Status ${item.statusFrom ? recordStates[item.statusFrom] : "new"} → ${item.statusTo ? recordStates[item.statusTo] : "removed"}` : "Note"} · {formatTime(item.recordedAt)}</p>
    </li>)}</ol></details>}
  </>;
}

export function StepContributions({items}: {items: readonly WorkflowProgressContribution[] | undefined}) {
  if (!items?.length) return null;
  return <div className="stack step-contributions"><strong>External contributions</strong><ul className="stack">{items.map(item => <li key={item.contributionId} className="workflow-progress-observation">
    <p>{item.state === "awaiting_result" ? "Awaiting external result" : item.state === "withdrawn" ? "External contribution withdrawn"
      : item.assessment?.resultRevision !== item.revision ? "External result received – awaiting assessment" : item.assessment.decision === "accepted" ? "External result accepted" : "Further work requested"}{!item.inCurrentPlan && <> · No longer in the current plan</>} · revision {item.revision} · <code>{item.contributionId}</code></p>
    {item.summary && <p className="definition-copy">{item.summary}</p>}
    {item.references.length > 0 && <ul className="small">{item.references.map((reference, index) => <li key={`${index}:${reference.kind}`}>{({file: "File", url: "URL", source: "Source", text: "Text"})[reference.kind]}: <code>{reference.value}</code></li>)}</ul>}
    {item.externalRef && <p className="small">External reference: <code>{item.externalRef}</code></p>}
    {item.assessment && item.assessment.resultRevision === item.revision && <p className="definition-copy"><strong>Supervisor assessment of the result:</strong> {item.assessment.note}</p>}
    <p className="small muted">Reported by the main · <a href={`t3-thread://v1/${item.sourceThreadId}`}>Open conversation {item.sourceThreadId}</a> · Message <code>{item.sourceMessageId}</code> · {formatTime(item.recordedAt)}</p>
    <p className="small muted">The external work itself was not observed. Summaries and references are the main’s report, not evidence of execution; an accepted result does not complete the step.</p>
  </li>)}</ul></div>;
}

type JourneyProps = {
  node: WorkflowPlanNodeInfo;
  mode?: JourneyMode;
  notes?: StepNotes;
  contributions?: ReadonlyMap<string, readonly WorkflowProgressContribution[]>;
};

/** Preserves sequence, parallel and nested workflow boundaries without deriving parent completion from children. */
export function PlanJourney({node, mode = "proposed", notes = noNotes, contributions}: JourneyProps) {
  const live = mode === "live";
  if ("nodes" in node) {
    const List = node.kind === "parallel" ? "ul" : "ol";
    return <div className={`journey-group group-${node.kind}`}>
      {node.kind === "parallel" && <p className="parallel-label">In parallel <span>These branches have no declared order</span></p>}
      <List role="list" className="journey-track" aria-label={node.kind === "parallel" ? "Parallel branches" : "Plan sequence"}>{node.nodes.map((child, index) =>
        <li key={"nodeId" in child ? child.nodeId : `${child.kind}:${index}`}><PlanJourney node={child} mode={mode} notes={notes} {...(contributions ? {contributions} : {})}/></li>)}</List>
    </div>;
  }
  const state = live ? node.status : mode === "proposed" ? "proposed" : "planned";
  const label = live ? states[node.status] : modeLabels[mode];
  const accepted = notes.agreed?.get(node.nodeId)?.node;
  const proposed = notes.proposed?.get(node.nodeId)?.node;
  const acceptedNote = accepted && accepted.reason !== node.reason ? accepted.reason : null;
  const proposedNote = proposed && proposed.reason !== node.reason && proposed.reason !== accepted?.reason ? proposed.reason : null;
  const outsideAccepted = live && notes.agreed !== null && !accepted;
  const changeProposed = notes.changed.has(node.nodeId);
  return <div className={`journey-stop state-${state}`}>
    <details className="journey-step" open={live && hasActiveNode(node) || undefined}>
      <summary aria-current={live && node.status === "underway" ? "step" : undefined}>
        <StepMark state={state}/><span className="step-name">{node.name}{node.kind === "workflow" && <small>Workflow</small>}
          {(changeProposed || outsideAccepted) && <span className="step-flags">{changeProposed && <span className="pill blue">Update proposed</span>}{outsideAccepted && <span className="pill">Not in the accepted plan</span>}</span>}</span>
        <span className="step-state">{label}</span><svg className="step-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.7"/></svg>
      </summary>
      <div className="step-explanation">
        {node.description && <p>{node.description}</p>}
        <DefinitionReferences references={node.references} skills={node.skills}/>
        {node.reason && <div className="step-note"><strong>Plan note</strong><p>{node.reason}</p></div>}
        {acceptedNote && <div className="step-note"><strong>Accepted plan note</strong><p>{acceptedNote}</p></div>}
        {proposedNote && <div className="step-note proposed"><strong>Proposed plan note · awaiting acceptance</strong><p>{proposedNote}</p></div>}
        {live && <StepRecords status={node.status} records={notes.records?.get(node.nodeId)}/>}
        {node.kind === "workflow" && node.omissions.length > 0 && <div className="step-note"><strong>Not applicable in this plan</strong><ul className="stack">{node.omissions.map((omission, index) =>
          <li key={`${omission.templatePath}:${omission.id}:${index}`}><strong>{omission.name}</strong> <span className="muted">({omission.kind} {omission.id})</span> — {omission.reason}</li>)}</ul></div>}
        {node.resolution !== "resolved" && <p className="notice">Definition {node.resolution}. Some commitments still need clarification.</p>}
        {live && <StepContributions items={contributions?.get(node.nodeId)}/>}
        {node.contributorThreadIds.length > 0 && <p className="small">Contributors: {node.contributorThreadIds.map((id, index) => <React.Fragment key={id}>{index > 0 && ", "}<a href={`t3-thread://v1/${id}`}>Conversation {index + 1}</a></React.Fragment>)}</p>}
        <p className="small muted step-source">{node.definitionId ? <>Definition <code>{node.definitionId}</code></> : node.kind === "step" && node.localId ? <>Task-local step <code>{node.localId}</code></> : "Definition not recorded"}
          {node.source?.path && <> · <code>{node.source.path}</code></>}{node.kind === "workflow" && node.fixed && <> · fixed workflow</>}</p>
      </div>
      {node.kind === "workflow" && node.plan && <div className="nested-journey"><PlanJourney node={node.plan} mode={mode} notes={notes} {...(contributions ? {contributions} : {})}/></div>}
      {node.kind === "workflow" && !node.plan && <p className="small muted">No expanded plan is recorded for this workflow.</p>}
    </details>
  </div>;
}

const proposalStatusDescription: Record<WorkflowProposalInfo["status"], string> = {
  pending: "The plan is still being prepared; no acceptance is recorded for it.",
  proposed: "Proposed for acceptance. No acceptance is recorded for this proposal.",
  provisional: "A finite working plan is available while unresolved requirements or definition issues remain visible.",
  unavailable: "A usable plan could not be prepared from the available definitions.",
  stale: "The source revision changed. Review the definitions and negotiate the plan again.",
  invalid: "The proposal could not be accepted as a valid plan.",
};
const proposalProgress: Record<WorkflowProposalInfo["status"], string> = {pending: "Preparing the plan", proposed: "Proposed the plan", provisional: "Provisional plan with open issues",
  unavailable: "Plan unavailable", invalid: "Plan needs correction", stale: "Plan needs review"};

/** The actual proposal and acceptance records for the task, each stated once. */
export function TaskAlignment({task, supervisorThreadId}: {task: TaskInterpretationInfo | undefined; supervisorThreadId?: string}) {
  const accepted = acceptedAgreement(task);
  const pending = pendingProposal(task);
  const current = Boolean(accepted && !pending);
  const stale = task?.agreement?.status === "stale";
  const historical = Boolean(task && ["expired", "not_supervised"].includes(task.status));
  const proposal = pending ?? task?.workflow ?? task?.agreement?.workflow;
  const update = Boolean(accepted && pending);
  const supervisorLine = task?.engagement?.mode === "following" ? "Understanding and draft duties retained" : !proposal ? "No plan recorded yet" : update ? proposal.status === "pending" ? "Preparing an updated plan" : "Proposed an updated plan" : proposalProgress[proposal.status];
  // the proposal's own message is shown only while it is the open question; an accepted plan is described by its acceptance
  const proposalMessage = proposal && (pending || !accepted) && !(stale && !pending) ? proposal.message : null;
  const agentLine = historical && task?.agreement ? "Earlier acceptance retained"
    : current ? "Accepted this plan"
    : update ? "Earlier plan accepted; update awaiting acceptance"
    : stale ? "Earlier acceptance is out of date"
    : "Acceptance has not been recorded";
  const agreement = task?.agreement;
  const agreedAt = agreement ? formatTime(agreement.agreedAt) : null;
  const shown = accepted?.workflow ?? proposal;
  return <section className={`task-alignment ${current ? "is-agreed" : ""}`} aria-labelledby="task-alignment-title">
    <h3 id="task-alignment-title">Agent and Supervisor</h3>
    <ol className="alignment-exchange" role="list">
      <li><StepMark state={proposal?.status === "proposed" ? "completed" : "planned"}/><div><strong>Supervisor</strong><p>{supervisorLine}</p>{proposalMessage && <p className="alignment-note">{proposalMessage}</p>}</div></li>
      <li><StepMark state={current ? "completed" : stale || update ? "needs_attention" : "planned"}/><div><strong>Agent</strong><p>{agentLine}{agreedAt && (current || update) ? <span className="small muted"> · {agreedAt}</span> : null}</p>
        {agreement && (current || historical) && <p className="alignment-note">{agreement.message}</p>}</div></li>
    </ol>
    <div className="alignment-links">{supervisorThreadId && <a href={`t3-thread://v1/${supervisorThreadId}`}>Open Supervisor</a>}{task && <a href={`t3-thread://v1/${task.threadId}`}>Open agent conversation</a>}</div>
    {agreement && <details className="small"><summary>{current ? "Acceptance record" : "Earlier acceptance record"}</summary><div className="stack">
      {!current && <p>{agreement.message}</p>}
      <p>Accepted <time dateTime={new Date(agreement.agreedAt).toISOString()}>{agreedAt}</time> · proposal <code>{agreement.proposalId}</code></p>
      <p>Agent message <code>{agreement.agentMessageId}</code> · {agreement.evidence.kind === "supervisor_message" ? <>Supervisor message <code>{agreement.evidence.messageId}</code></>
        : <>Interpretation submission: attempt <code>{agreement.evidence.attemptId}</code>, item <code>{agreement.evidence.itemId}</code></>}</p>
      <p className="muted">Acceptance records an agreed plan; it does not show that any step was performed.</p>
    </div></details>}
    {shown && <details className="small"><summary>Plan provenance</summary><div className="stack">
      {proposal && (pending || !accepted) && <p>{proposalStatusDescription[proposal.status]}{task?.workflowProposalId && <> Proposal <code>{task.workflowProposalId}</code>.</>}</p>}
      <p>Definitions {shown.definitionsStatus === "ready" ? "valid" : shown.definitionsStatus.replaceAll("_", " ")}{shown.definitionsComplete ? "" : " · read incomplete"}{shown.requirementsKnown ? "" : " · requirements unknown"}</p>
      {shown.workspaceRoot && <p>Checkout <code>{shown.workspaceRoot}</code>{shown.revision && <> · revision <code>{shown.revision}</code></>}</p>}
      {shown.requirements.length > 0
        ? <ul className="stack">{shown.requirements.map((requirement, index) => <li key={`${requirement.kind}:${requirement.id}:${index}`}>Required {requirement.kind} <strong>{requirement.name}</strong> · {({included: "included", not_applicable: "not applicable", unresolved: "unresolved", unknown: "unknown"})[requirement.state]}{requirement.reason ? ` — ${requirement.reason}` : ""}</li>)}</ul>
        : <p className="muted">{shown.requirementsKnown && shown.definitionsComplete && shown.definitionsStatus === "ready" ? "No required definitions are configured." : "Requirements may be unknown because the definitions are missing, invalid or incompletely read."}</p>}
      {shown.issues.length > 0 && <ul className="definition-issues">{shown.issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`}><code>{issue.path}</code><p>{issue.message}</p></li>)}</ul>}
      <p className="muted">A plan or its acceptance does not prove that work was performed.</p>
    </div></details>}
    {task && <details className="small"><summary>Task interpretation</summary><p>{task.status === "inferred" ? "Interpreted from the request." : task.status.replaceAll("_", " ")}{task.reason ? ` ${task.reason}` : ""}</p></details>}
  </section>;
}

const changeLabels: Record<PlanChangeField, string> = {name: "name", description: "description", note: "plan note", definition: "definition", references: "references",
  skills: "skills", fixed: "fixed workflow", omissions: "not-applicable items", grouping: "grouping", order: "order"};

/** The actual differences between the accepted plan and the proposal awaiting acceptance. */
export function PlanChanges({changes, proposal, proposalId}: {changes: readonly PlanChange[]; proposal: WorkflowProposalInfo; proposalId?: string | undefined}) {
  return <section className="plan-changes" aria-labelledby="plan-changes-title">
    <h3 id="plan-changes-title">Proposed update awaiting acceptance</h3>
    <p className="small muted">{proposalStatusDescription[proposal.status]}{proposalId && <> Proposal <code>{proposalId}</code>.</>} {proposal.plan ? "Compared with the accepted plan; step statuses below are unchanged until the Supervisor records new assessments." : ""}</p>
    {!proposal.plan ? <p>The update’s plan is not recorded yet.</p> : changes.length === 0 ? <p>No changes to the plan’s steps were found; inspect the proposal details.</p> : <ul className="stack">{changes.map(change => <li key={`${change.kind}:${change.nodeId}`}>
      {change.kind === "added" ? <><strong>Adds {change.name}</strong>{change.note && <p className="small">{change.note}</p>}</>
        : change.kind === "removed" ? <strong>Removes {change.name}</strong>
        : <><strong>{change.previousName === change.name ? change.name : `${change.previousName} → ${change.name}`}</strong>
          <span className="small muted"> · changes {change.fields.map(field => changeLabels[field]).join(", ")}</span>
          {change.fields.includes("note") && <details className="note-compare-toggle"><summary>Compare plan notes</summary><dl className="note-compare"><div><dt>Accepted</dt><dd>{change.previousNote}</dd></div><div><dt>Proposed</dt><dd>{change.note}</dd></div></dl></details>}</>}
    </li>)}</ul>}
  </section>;
}

export function TaskOutcome({assessment, fallback, stopped, currentStep}: {assessment: WorkflowAssessmentInfo | null; fallback: string; stopped: boolean; currentStep?: string}) {
  const state = stopped ? "paused" : assessment?.status ?? "planned";
  const title = stopped ? "Supervision stopped" : assessment?.status === "completed" ? "Task completed" : assessment?.status === "underway" ? "Work in progress" : assessment?.status === "needs_attention" ? "Needs attention" : fallback;
  return <div className={`task-outcome state-${state}`}><StepMark state={state}/><div><strong>{title}</strong>{currentStep && !stopped && <p className="outcome-current">Now: {currentStep}</p>}{assessment && <p>{assessment.summary}</p>}{!assessment && <p>Progress appears when the Supervisor records an assessment for this task.</p>}</div></div>;
}
