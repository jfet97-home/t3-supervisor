import { taskScopeRevision } from "./supervision-conversation-contract.js";
import type { ConversationFacts } from "./supervision-conversation-contract.js";
import { Schema } from "effect";
import type { WorkflowStateDocument } from "./workflow-state-contract.js";

export const WorkflowAssessment = Schema.Struct({
  taskId: Schema.String, sourceHash: Schema.String, status: Schema.String,
  summary: Schema.String, updatedAt: Schema.Number,
});
export type WorkflowAssessmentInfo = typeof WorkflowAssessment.Type;
type CurrentTask = {id?: string; sourceHash?: string; status: string; conversation?: ConversationFacts};

/** Projects the main assessment reason without mistaking later step or contribution notes for it. */
export function workflowAssessment(document: WorkflowStateDocument): WorkflowAssessmentInfo | null {
  if (!document.sourceBinding) return null;
  const evidence = [...document.evidence].reverse().find(item => item.kind === "status_changed" &&
    item.targetNodeId === null && item.statusTo === document.status);
  return {taskId: document.sourceBinding.taskId, sourceHash: document.sourceBinding.sourceHash,
    status: document.status, summary: evidence?.note.slice(0, 800) || "No explanation was recorded for this workflow assessment.",
    updatedAt: document.updatedAt};
}

export function assessmentForTask(assessment: WorkflowAssessmentInfo | null | undefined, task: CurrentTask | undefined) {
  return assessment && task?.id && task.sourceHash && !["expired", "not_supervised"].includes(task.status) &&
    assessment.taskId === task.id && assessment.sourceHash === taskScopeRevision(task) ? assessment : null;
}
