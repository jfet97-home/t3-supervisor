import type { TaskInterpretationInfo, WorkflowAgreementInfo, WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo } from "../../src/project-supervisor-contract.js";
import type { WorkflowProgressObservation, WorkflowProgressWorkflow } from "../../src/workflow-progress.js";
import { assessmentForTask } from "../../src/workflow-assessment.js";

// the one task workspace reads three records of the same task: the current proposal, the recorded acceptance and the live
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

// the groups around each occurrence inside its workflow. A nested group is identified by its kind and the occurrences both
// plans place in it, so moving an occurrence between branches regroups every occurrence whose concurrency changed with it.
const members = (node: WorkflowPlanNodeInfo): string[] => "nodes" in node ? node.nodes.flatMap(members) : [node.nodeId];
function groupings(plan: WorkflowPlanGroupInfo | null | undefined, shared: (nodeId: string) => boolean, around = "", into = new Map<string, string>()): ReadonlyMap<string, string> {
  if (!plan) return into;
  const here = around ? `${around}>${plan.kind}(${members(plan).filter(shared).sort().join(",")})` : plan.kind;
  for (const node of plan.nodes) {
    if ("nodes" in node) groupings(node, shared, here, into);
    else {
      into.set(node.nodeId, here);
      if (node.kind === "workflow") groupings(node.plan, shared, "", into);
    }
  }
  return into;
}

// the declared order of occurrences: a sequence keeps its order, while parallel branches have none and are listed by ID
const firstId = (node: WorkflowPlanNodeInfo): string => "nodes" in node ? node.nodes.map(firstId).sort()[0] ?? "" : node.nodeId;
function declaredOrder(plan: WorkflowPlanGroupInfo | null | undefined, order: string[] = []): string[] {
  const nodes = plan?.kind === "parallel" ? [...plan.nodes].sort((a, b) => firstId(a).localeCompare(firstId(b))) : plan?.nodes ?? [];
  for (const node of nodes) {
    if ("nodes" in node) declaredOrder(node, order);
    else {
      order.push(node.nodeId);
      if (node.kind === "workflow") declaredOrder(node.plan, order);
    }
  }
  return order;
}

// the occurrences whose relative order both plans share (a longest common subsequence); the others moved
function keptInOrder(before: readonly string[], after: readonly string[]): ReadonlySet<string> {
  const table = Array.from({length: before.length + 1}, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--)
    table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const kept = new Set<string>();
  for (let i = 0, j = 0; i < before.length && j < after.length;) {
    if (before[i] === after[j]) { kept.add(before[i]!); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return kept;
}

export type PlanChangeField = "name" | "description" | "note" | "definition" | "references" | "skills" | "fixed" | "omissions" | "grouping" | "order";
export type PlanChange =
  | {kind: "added"; nodeId: string; name: string; note: string}
  | {kind: "removed"; nodeId: string; name: string}
  | {kind: "changed"; nodeId: string; name: string; previousName: string; fields: readonly PlanChangeField[]; previousNote: string; note: string};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The commitment and topology differences between the plan the agreement accepted and a later proposal of the same task,
 * matched by occurrence. Runtime fields (status, contributors) are not commitments and are ignored.
 */
export function planChanges(accepted: WorkflowPlanGroupInfo | null | undefined, proposed: WorkflowPlanGroupInfo | null | undefined): PlanChange[] {
  const before = occurrences(accepted), after = occurrences(proposed);
  const shared = (nodeId: string) => before.has(nodeId) && after.has(nodeId);
  const groupedBefore = groupings(accepted, shared), groupedAfter = groupings(proposed, shared);
  const regrouped = (nodeId: string) => before.get(nodeId)?.parent !== after.get(nodeId)?.parent || groupedBefore.get(nodeId) !== groupedAfter.get(nodeId);
  // order is compared among occurrences that stay in the same groups; a regrouped occurrence is reported as regrouped
  const stable = (plan: WorkflowPlanGroupInfo | null | undefined) => declaredOrder(plan).filter(nodeId => shared(nodeId) && !regrouped(nodeId));
  const kept = keptInOrder(stable(accepted), stable(proposed));
  const changes: PlanChange[] = [];
  for (const [nodeId, {node}] of after) {
    const prior = before.get(nodeId);
    if (!prior) { changes.push({kind: "added", nodeId, name: node.name, note: node.reason}); continue; }
    const was = prior.node;
    const fields: PlanChangeField[] = [];
    if (was.name !== node.name) fields.push("name");
    if (was.description !== node.description) fields.push("description");
    if (was.reason !== node.reason) fields.push("note");
    if (was.kind !== node.kind || was.definitionId !== node.definitionId || !same(was.kind === "step" ? was.localId : null, node.kind === "step" ? node.localId : null)
      || !same(was.source?.path, node.source?.path)) fields.push("definition");
    if (!same(was.references, node.references)) fields.push("references");
    if (!same(was.skills, node.skills)) fields.push("skills");
    if (was.kind === "workflow" && node.kind === "workflow") {
      if (was.fixed !== node.fixed) fields.push("fixed");
      if (!same(was.omissions, node.omissions)) fields.push("omissions");
    }
    if (regrouped(nodeId)) fields.push("grouping");
    else if (!kept.has(nodeId)) fields.push("order");
    if (fields.length) changes.push({kind: "changed", nodeId, name: node.name, previousName: was.name, fields, previousNote: was.reason, note: node.reason});
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
