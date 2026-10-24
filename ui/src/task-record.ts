import type { TaskInterpretationInfo, WorkflowAgreementInfo, WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo } from "../../src/project-supervisor-contract.js";
import type { WorkflowProgressObservation, WorkflowProgressWorkflow } from "../../src/workflow-progress.js";
import { assessmentForTask } from "../../src/workflow-assessment.js";

// The one task workspace reads three records of the same task: the current proposal, the recorded acceptance and the live
// workflow bound to the task. Statuses only ever come from the live workflow; plan notes and step-level Supervisor records are
// matched to its steps by occurrence ID (nodeId), never by name, and nothing here derives or merges a status.

export type PlanOccurrence = Exclude<WorkflowPlanNodeInfo, WorkflowPlanGroupInfo>;
export type OccurrenceIndex = ReadonlyMap<string, {node: PlanOccurrence; parent: string}>;

const ended = (task: TaskInterpretationInfo | undefined) => !task || ["expired", "not_supervised"].includes(task.status);

/** The task's recorded acceptance while the task is current. It may have accepted an earlier proposal than the latest one. */
export const acceptedAgreement = (task: TaskInterpretationInfo | undefined): WorkflowAgreementInfo | null =>
  task?.agreement?.status === "agreed" && !ended(task) ? task.agreement : null;

/** The task's latest proposal when it is not the proposal the recorded acceptance covers. */
export const pendingProposal = (task: TaskInterpretationInfo | undefined): WorkflowProposalInfo | null => {
  if (!task?.workflow || ended(task)) return null;
  const agreement = acceptedAgreement(task);
  return agreement && task.workflowProposalId === agreement.proposalId ? null : task.workflow;
};

/** Every step and workflow occurrence in a plan, with the occurrence that contains it ("" at the root). */
export function occurrences(plan: WorkflowPlanGroupInfo | null | undefined, parent = "", index = new Map<string, {node: PlanOccurrence; parent: string}>()): OccurrenceIndex {
  for (const node of plan?.nodes ?? []) {
    if ("nodes" in node) occurrences(node, parent, index);
    else {
      index.set(node.nodeId, {node, parent});
      if (node.kind === "workflow") occurrences(node.plan, node.nodeId, index);
    }
  }
  return index;
}

export type PlanChange =
  | {kind: "added"; nodeId: string; name: string; note: string}
  | {kind: "removed"; nodeId: string; name: string}
  | {kind: "changed"; nodeId: string; name: string; previousName: string; fields: ReadonlyArray<"name" | "description" | "note" | "definition" | "position">;
    previousNote: string; note: string};

/** The differences between the plan the agreement accepted and a later proposal of the same task, by occurrence. */
export function planChanges(accepted: WorkflowPlanGroupInfo | null | undefined, proposed: WorkflowPlanGroupInfo | null | undefined): PlanChange[] {
  const before = occurrences(accepted), after = occurrences(proposed);
  const changes: PlanChange[] = [];
  for (const [nodeId, {node, parent}] of after) {
    const prior = before.get(nodeId);
    if (!prior) { changes.push({kind: "added", nodeId, name: node.name, note: node.reason}); continue; }
    const fields: Array<"name" | "description" | "note" | "definition" | "position"> = [];
    if (prior.node.name !== node.name) fields.push("name");
    if (prior.node.description !== node.description) fields.push("description");
    if (prior.node.reason !== node.reason) fields.push("note");
    if (prior.node.kind !== node.kind || prior.node.definitionId !== node.definitionId) fields.push("definition");
    if (prior.parent !== parent) fields.push("position");
    if (fields.length) changes.push({kind: "changed", nodeId, name: node.name, previousName: prior.node.name, fields, previousNote: prior.node.reason, note: node.reason});
  }
  for (const [nodeId, {node}] of before) if (!after.has(nodeId)) changes.push({kind: "removed", nodeId, name: node.name});
  return changes;
}

/** The Supervisor's step-level records, oldest first, keyed by the step occurrence they target. */
export function recordsByStep(observations: readonly WorkflowProgressObservation[]): ReadonlyMap<string, WorkflowProgressObservation[]> {
  const byStep = new Map<string, WorkflowProgressObservation[]>();
  for (const item of [...observations].sort((a, b) => a.recordedAt - b.recordedAt)) {
    if (!item.targetNodeId) continue;
    byStep.set(item.targetNodeId, [...byStep.get(item.targetNodeId) ?? [], item]);
  }
  return byStep;
}

/** The record that explains a step's current status: its latest status change into that status, if one was read. */
export const statusRecord = (records: readonly WorkflowProgressObservation[] | undefined, status: string) =>
  [...records ?? []].reverse().find(item => item.kind === "status_changed" && item.statusTo === status) ?? null;

export type JourneyRecord =
  | {kind: "live"; workflow: WorkflowProgressWorkflow; plan: WorkflowPlanGroupInfo}
  | {kind: "agreed"; plan: WorkflowPlanGroupInfo}
  | {kind: "proposed"; plan: WorkflowPlanGroupInfo}
  | {kind: "none"};

/**
 * The single plan the task workspace shows: the live workflow bound to this task, else the plan the recorded acceptance
 * accepted, else the current proposal. A proposal never replaces the live workflow or the accepted plan.
 */
export function journeyRecord(task: TaskInterpretationInfo | undefined, mainWorkflow: WorkflowProgressWorkflow | undefined): JourneyRecord {
  if (mainWorkflow?.plan && assessmentForTask(mainWorkflow.assessment, task)) return {kind: "live", workflow: mainWorkflow, plan: mainWorkflow.plan};
  const agreement = acceptedAgreement(task);
  if (agreement?.workflow.plan) return {kind: "agreed", plan: agreement.workflow.plan};
  if (task?.workflow?.plan && !ended(task)) return {kind: "proposed", plan: task.workflow.plan};
  return {kind: "none"};
}

/** Plan notes and records for each shown step, from records of this same task only. */
export type StepNotes = {
  agreed: OccurrenceIndex | null;
  proposed: OccurrenceIndex | null;
  records: ReadonlyMap<string, WorkflowProgressObservation[]> | null;
  changed: ReadonlySet<string>;
};

export function stepNotes(task: TaskInterpretationInfo | undefined, record: JourneyRecord): StepNotes {
  const agreement = acceptedAgreement(task);
  const pending = pendingProposal(task);
  const changes = agreement && pending?.plan ? planChanges(agreement.workflow.plan, pending.plan) : [];
  return {
    agreed: agreement && record.kind !== "proposed" ? occurrences(agreement.workflow.plan) : null,
    proposed: pending && record.kind !== "proposed" ? occurrences(pending.plan) : null,
    records: record.kind === "live" ? recordsByStep(record.workflow.observations) : null,
    changed: new Set(changes.filter(change => change.kind !== "added").map(change => change.nodeId)),
  };
}
