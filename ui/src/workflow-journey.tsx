import React from "react";
import {DefinitionReferences} from "./definition-references.js";
import type { TaskInterpretationInfo, WorkflowPlanNodeInfo } from "../../src/project-supervisor-contract.js";
import type { WorkflowAssessmentInfo } from "../../src/workflow-assessment.js";

const states = {planned: "Planned", underway: "In progress", completed: "Completed", needs_attention: "Needs attention"} as const;

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

export const hasCurrentAgreement = (task: TaskInterpretationInfo | undefined) => Boolean(task?.agreement?.status === "agreed" &&
  !["expired", "not_supervised"].includes(task.status) && (!task.workflowProposalId || task.workflowProposalId === task.agreement.proposalId));

export const alignmentLabel = (task: TaskInterpretationInfo | undefined) => hasCurrentAgreement(task) ? "Agreed" : task?.agreement ? "Needs review" : task?.workflow?.status === "proposed" ? "Awaiting acceptance" : "Not agreed";

const hasActiveNode = (node: WorkflowPlanNodeInfo): boolean => "nodes" in node ? node.nodes.some(hasActiveNode) :
  node.status === "underway" || node.status === "needs_attention" || node.kind === "workflow" && node.plan !== null && hasActiveNode(node.plan);

/** Preserves sequence, parallel and nested workflow boundaries without deriving parent completion from children. */
export function PlanJourney({node, live = false, context = "proposed"}: {node: WorkflowPlanNodeInfo; live?: boolean; context?: "proposed" | "agreed" | "historical"}) {
  if ("nodes" in node) {
    const List = node.kind === "parallel" ? "ul" : "ol";
    return <div className={`journey-group group-${node.kind}`}>
      {node.kind === "parallel" && <p className="parallel-label">In parallel <span>These branches have no declared order</span></p>}
      <List role="list" className="journey-track" aria-label={node.kind === "parallel" ? "Parallel branches" : "Plan sequence"}>{node.nodes.map((child, index) => <li key={"nodeId" in child ? child.nodeId : `${child.kind}:${index}`}><PlanJourney node={child} live={live} context={context}/></li>)}</List>
    </div>;
  }
  const state = live ? node.status : context === "proposed" ? "proposed" : "planned";
  const label = live ? states[node.status] : context === "agreed" ? "In agreed plan" : context === "historical" ? "In earlier plan" : "Proposed";
  return <div className={`journey-stop state-${state}`}>
    <details className="journey-step" open={live && hasActiveNode(node) || undefined}>
      <summary aria-current={live && node.status === "underway" ? "step" : undefined}>
        <StepMark state={state}/><span className="step-name">{node.name}{node.kind === "workflow" && <small>Workflow</small>}</span><span className="step-state">{label}</span><svg className="step-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.7"/></svg>
      </summary>
      <div className="step-explanation">
        {node.description && <p>{node.description}</p>}
        <DefinitionReferences references={node.references} skills={node.skills}/>
        {node.reason && <div className="step-assessment"><strong>{live ? "Supervisor assessment" : "Why this step"}</strong><p>{node.reason}</p></div>}
        {node.resolution !== "resolved" && <p className="notice">Definition {node.resolution}. Some commitments still need clarification.</p>}
        {node.contributorThreadIds.length > 0 && <p className="small">Contributors: {node.contributorThreadIds.map((id, index) => <React.Fragment key={id}>{index > 0 && ", "}<a href={`t3-thread://v1/${id}`}>Conversation {index + 1}</a></React.Fragment>)}</p>}
      </div>
      {node.kind === "workflow" && node.plan && <div className="nested-journey"><PlanJourney node={node.plan} live={live} context={context}/></div>}
      {node.kind === "workflow" && !node.plan && <p className="small muted">No expanded plan is recorded for this workflow.</p>}
    </details>
  </div>;
}

export function TaskAlignment({task, supervisorThreadId}: {task: TaskInterpretationInfo | undefined; supervisorThreadId?: string}) {
  const agreement = task?.agreement;
  const agreed = hasCurrentAgreement(task);
  const stale = agreement?.status === "stale";
  const historical = Boolean(task && ["expired", "not_supervised"].includes(task.status));
  const revised = agreement?.status === "agreed" && !agreed && !historical;
  const proposal = task?.workflow ?? agreement?.workflow;
  const proposed = proposal?.status === "proposed";
  return <section className={`task-alignment ${agreed ? "is-agreed" : ""}`}>
    <div className="row between"><h4>Agent and Supervisor</h4><span className={`pill ${agreed ? "green" : stale || revised ? "amber" : ""}`}>{historical && agreement ? "Earlier agreement" : agreed ? "Plan agreed" : revised ? "Plan update awaiting agreement" : stale ? "Agreement needs review" : proposed ? "Awaiting acceptance" : "No agreement yet"}</span></div>
    <ol className="alignment-exchange" role="list">
      <li><StepMark state={proposed ? "completed" : "planned"}/><div><strong>Supervisor</strong><p>{proposal ? ({pending: "Preparing the plan", proposed: "Prepared the plan", provisional: "Provisional plan with open issues", unavailable: "Plan unavailable", invalid: "Plan needs correction", stale: "Plan needs review"})[proposal.status] : "No plan recorded yet"}</p>{proposal?.message && <p className="alignment-note">{proposal.message}</p>}</div></li>
      <li><StepMark state={agreed ? "completed" : stale || revised ? "needs_attention" : "planned"}/><div><strong>Agent</strong><p>{historical && agreement ? "Earlier acceptance retained" : agreed ? "Accepted this plan" : revised ? "Earlier plan accepted; update not accepted" : stale ? "Earlier acceptance is out of date" : "Acceptance has not been recorded"}</p></div></li>
    </ol>
    {agreement?.message && <p className="alignment-message">{agreement.message}</p>}
    {stale && <p className="small">The previous agreement is history. The current plan still needs agreement.</p>}
    <div className="alignment-links">{supervisorThreadId && <a href={`t3-thread://v1/${supervisorThreadId}`}>Open Supervisor</a>}{task && <a href={`t3-thread://v1/${task.threadId}`}>Open agent conversation</a>}</div>
    {agreement && <details className="small"><summary>Agreement record</summary><p>Accepted {new Date(agreement.agreedAt).toLocaleString()}</p><p>Proposal <code>{agreement.proposalId}</code></p><p>Agent message <code>{agreement.agentMessageId}</code></p><p>{agreement.evidence.kind === "supervisor_message" ? <>Supervisor message <code>{agreement.evidence.messageId}</code></> : <>Interpretation item <code>{agreement.evidence.itemId}</code></>}</p></details>}
  </section>;
}

export function TaskOutcome({assessment, fallback, stopped, currentStep}: {assessment: WorkflowAssessmentInfo | null; fallback: string; stopped: boolean; currentStep?: string}) {
  const state = stopped ? "paused" : assessment?.status ?? "planned";
  const title = stopped ? "Supervision stopped" : assessment?.status === "completed" ? "Task completed" : assessment?.status === "underway" ? "Work in progress" : assessment?.status === "needs_attention" ? "Needs attention" : fallback;
  return <div className={`task-outcome state-${state}`}><StepMark state={state}/><div><strong>{title}</strong>{currentStep && !stopped && <p className="outcome-current">Now: {currentStep}</p>}{assessment && <p>{assessment.summary}</p>}{!assessment && <p>Progress will appear when the Supervisor records an assessment for this task.</p>}</div></div>;
}
