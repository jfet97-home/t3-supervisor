import {SupportingReferences, SupportingSkills, type SupportingReference} from "./definition-references.js";
import { Schema } from "effect";

export const ModelSelection = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
  options: Schema.Array(Schema.Struct({id: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean])})),
});
export type SupervisorModelSelection = typeof ModelSelection.Type;
export const MonitoringSettings = Schema.Struct({
  intervalMinutes: Schema.Number,
  activityThreshold: Schema.Number,
});
export type SupervisorMonitoringSettings = typeof MonitoringSettings.Type;
/** The age bound of pending ordinary activity, in whole minutes: the oldest finished item becomes due after at most two minutes. */
export const monitoringIntervalMinutes = {min: 1, max: 2} as const;
export const defaultMonitoringSettings: SupervisorMonitoringSettings = {intervalMinutes: monitoringIntervalMinutes.max, activityThreshold: 10};
export const SupervisorTeamSettings = Schema.Struct({maxHelpersPerRoot: Schema.Number});
export type SupervisorTeamSettingsInfo = typeof SupervisorTeamSettings.Type;
export const defaultSupervisorTeamSettings: SupervisorTeamSettingsInfo = {maxHelpersPerRoot: 5};
const SupervisorTeamAssessment = Schema.Struct({summary: Schema.String, assessedAt: Schema.NullOr(Schema.Number)});
const SupervisorTeamHandover = Schema.Struct({
  targetThreadId: Schema.String,
  targetTitle: Schema.NullOr(Schema.String),
  direction: Schema.Literals(["incoming", "outgoing"]),
  state: Schema.Literals(["pending", "sending", "uncertain", "delivered", "failed", "superseded"]),
  summary: Schema.String,
  updatedAt: Schema.Number,
  runStatus: Schema.optionalKey(Schema.String),
  // requested: this entry is a root-requested effect review; in_progress: an open review covers it;
  // completed: a review's own native run completed and closed it, which does not prove its effects absent
  review: Schema.optionalKey(Schema.Literals(["requested", "in_progress", "completed"])),
});
const SupervisorTeamIssue = Schema.Struct({
  id: Schema.String,
  severity: Schema.Literals(["info", "warning", "critical"]),
  summary: Schema.String,
  observedAt: Schema.Number,
});
const SupervisorTeamRoot = Schema.Struct({
  threadId: Schema.String,
  title: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  readiness: Schema.Literals(["pending", "ready", "unavailable", "unknown"]),
  lifecycle: Schema.Literals(["active", "idle", "failed", "retired", "unknown"]),
  currentState: Schema.NullOr(Schema.String),
  lastAssessment: Schema.NullOr(SupervisorTeamAssessment),
});
const SupervisorTeamAssignmentView = Schema.Struct({
  threadId: Schema.String,
  title: Schema.NullOr(Schema.String),
  state: Schema.Literals(["active", "pending", "transfer", "released"]),
});
const SupervisorTeamMember = Schema.Struct({
  threadId: Schema.String,
  title: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  readiness: Schema.Literals(["pending", "ready", "unavailable", "unknown"]),
  lifecycle: Schema.Literals(["active", "idle", "failed", "quarantined", "retired", "unknown"]),
  assignments: Schema.Array(SupervisorTeamAssignmentView),
  currentState: Schema.NullOr(Schema.String),
  lastAssessment: Schema.NullOr(SupervisorTeamAssessment),
  pendingHandovers: Schema.Array(SupervisorTeamHandover),
  issues: Schema.Array(SupervisorTeamIssue),
});
export const ProjectSupervisorTeamSnapshot = Schema.Struct({
  status: Schema.Literals(["ok", "incomplete", "unavailable"]),
  message: Schema.NullOr(Schema.String),
  observedAt: Schema.Number,
  root: SupervisorTeamRoot,
  members: Schema.Array(SupervisorTeamMember),
  issues: Schema.Array(SupervisorTeamIssue),
});
export type ProjectSupervisorTeamInfo = typeof ProjectSupervisorTeamSnapshot.Type;
export const SupervisorModel = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
  name: Schema.String,
  providerName: Schema.String,
  available: Schema.Boolean,
  options: Schema.Array(Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    choices: Schema.Array(Schema.Struct({value: Schema.Union([Schema.String, Schema.Boolean]), label: Schema.String})),
    defaultValue: Schema.Union([Schema.String, Schema.Boolean]),
  })),
});
export type SupervisorModelInfo = typeof SupervisorModel.Type;
export const ProjectSupervisorBinding = Schema.Struct({
  projectId: Schema.String,
  mainThreadId: Schema.String,
  threadId: Schema.String,
  generation: Schema.Number,
  enabledAt: Schema.Number,
  state: Schema.Literals(["creating", "ready", "uncertain", "rejected", "missing"]),
  settlementState: Schema.optionalKey(Schema.NullOr(Schema.Literals(["pending", "uncertain", "settled", "superseded"]))),
  keptActive: Schema.optionalKey(Schema.Boolean),
  /** First lifecycle gate that kept the service-owned Supervisor active at its latest check, or null. */
  settlementBlockedBy: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type SupervisorBinding = typeof ProjectSupervisorBinding.Type;
export const WorkflowExecutionStatus = Schema.Literals(["planned", "underway", "completed", "needs_attention"]);
export type WorkflowExecutionStatusInfo = typeof WorkflowExecutionStatus.Type;
export type WorkflowSourceInfo = {
  origin: "global" | "project" | null;
  path: string | null;
  sourceId: string | null;
};
const WorkflowSource = Schema.Struct({
  origin: Schema.NullOr(Schema.Literals(["global", "project"])),
  path: Schema.NullOr(Schema.String),
  sourceId: Schema.NullOr(Schema.String),
});
export type WorkflowRequirementInfo = {
  kind: "step" | "workflow";
  id: string;
  name: string;
  source: WorkflowSourceInfo | null;
  state: "included" | "not_applicable" | "unresolved" | "unknown";
  reason: string;
};
export const WorkflowRequirement = Schema.Struct({
  kind: Schema.Literals(["step", "workflow"]),
  id: Schema.String,
  name: Schema.String,
  source: Schema.NullOr(WorkflowSource),
  state: Schema.Literals(["included", "not_applicable", "unresolved", "unknown"]),
  reason: Schema.String,
});
export type WorkflowIssueInfo = {path: string; code: string; message: string};
export const WorkflowIssue = Schema.Struct({path: Schema.String, code: Schema.String, message: Schema.String});
export type WorkflowSourceBindingInfo = {
  workspaceRoot: string;
  revision: string | null;
  globalRevision: string | null;
  definitionsStatus: "ready" | "missing" | "invalid" | "permission_required" | "unavailable";
  definitionsComplete: boolean;
  requirementsKnown: boolean;
  taskId: string;
  proposalId: string;
  sourceHash: string;
};
export const WorkflowSourceBinding = Schema.Struct({
  workspaceRoot: Schema.String,
  revision: Schema.NullOr(Schema.String),
  globalRevision: Schema.NullOr(Schema.String),
  definitionsStatus: Schema.Literals(["ready", "missing", "invalid", "permission_required", "unavailable"]),
  definitionsComplete: Schema.Boolean,
  requirementsKnown: Schema.Boolean,
  taskId: Schema.String,
  proposalId: Schema.String,
  sourceHash: Schema.String,
});
export type WorkflowPlanStepInfo = {
  kind: "step";
  nodeId: string;
  definitionId: string | null;
  localId: string | null;
  templatePath: string | null;
  name: string;
  description: string;
  references?: readonly SupportingReference[]; skills?: readonly string[];
  source: WorkflowSourceInfo | null;
  resolution: "resolved" | "unresolved";
  reason: string;
  status: WorkflowExecutionStatusInfo;
  contributorThreadIds: readonly string[];
};
export type WorkflowOmissionInfo = {
  templatePath: string;
  kind: "step" | "workflow";
  id: string;
  name: string;
  source: WorkflowSourceInfo | null;
  reason: string;
};
export type WorkflowPlanWorkflowInfo = {
  kind: "workflow";
  nodeId: string;
  definitionId: string;
  templatePath: string | null;
  name: string;
  description: string;
  references?: readonly SupportingReference[]; skills?: readonly string[];
  fixed: boolean | null;
  source: WorkflowSourceInfo | null;
  resolution: "resolved" | "partial" | "unresolved";
  reason: string;
  status: WorkflowExecutionStatusInfo;
  contributorThreadIds: readonly string[];
  omissions: readonly WorkflowOmissionInfo[];
  plan: WorkflowPlanGroupInfo | null;
};
export type WorkflowPlanGroupInfo = {kind: "sequence" | "parallel"; templatePath: string | null; nodes: readonly WorkflowPlanNodeInfo[]};
export type WorkflowPlanNodeInfo = WorkflowPlanStepInfo | WorkflowPlanWorkflowInfo | WorkflowPlanGroupInfo;
const WorkflowPlanStep = Schema.Struct({
  kind: Schema.Literal("step"),
  nodeId: Schema.String,
  definitionId: Schema.NullOr(Schema.String),
  localId: Schema.NullOr(Schema.String),
  templatePath: Schema.NullOr(Schema.String),
  name: Schema.String,
  description: Schema.String,
  references: Schema.optionalKey(SupportingReferences), skills: Schema.optionalKey(SupportingSkills),
  source: Schema.NullOr(WorkflowSource),
  resolution: Schema.Literals(["resolved", "unresolved"]),
  reason: Schema.String,
  status: WorkflowExecutionStatus,
  contributorThreadIds: Schema.Array(Schema.String),
});
const workflowPlanNodeSchema = (): Schema.Codec<WorkflowPlanNodeInfo, WorkflowPlanNodeInfo, never, never> => Schema.suspend((): Schema.Codec<WorkflowPlanNodeInfo, WorkflowPlanNodeInfo, never, never> => Schema.Union([
  WorkflowPlanStep,
  WorkflowPlanWorkflow,
  WorkflowPlanGroup,
]));
const WorkflowPlanGroup: Schema.Codec<WorkflowPlanGroupInfo, WorkflowPlanGroupInfo, never, never> = Schema.suspend((): Schema.Codec<WorkflowPlanGroupInfo, WorkflowPlanGroupInfo, never, never> => Schema.Struct({
  kind: Schema.Literals(["sequence", "parallel"]),
  templatePath: Schema.NullOr(Schema.String),
  nodes: Schema.Array(workflowPlanNodeSchema()),
}));
const WorkflowOmission = Schema.Struct({
  templatePath: Schema.String,
  kind: Schema.Literals(["step", "workflow"]),
  id: Schema.String,
  name: Schema.String,
  source: Schema.NullOr(WorkflowSource),
  reason: Schema.String,
});
const WorkflowPlanWorkflow = Schema.Struct({
  kind: Schema.Literal("workflow"),
  nodeId: Schema.String,
  definitionId: Schema.String,
  templatePath: Schema.NullOr(Schema.String),
  name: Schema.String,
  description: Schema.String,
  references: Schema.optionalKey(SupportingReferences), skills: Schema.optionalKey(SupportingSkills),
  fixed: Schema.NullOr(Schema.Boolean),
  source: Schema.NullOr(WorkflowSource),
  resolution: Schema.Literals(["resolved", "partial", "unresolved"]),
  reason: Schema.String,
  status: WorkflowExecutionStatus,
  contributorThreadIds: Schema.Array(Schema.String),
  omissions: Schema.Array(WorkflowOmission),
  plan: Schema.NullOr(WorkflowPlanGroup),
});
const WorkflowPlanNodeSchemaInternal = workflowPlanNodeSchema();
export const WorkflowPlanGroupSchema = WorkflowPlanGroup;
export const WorkflowPlanNodeSchema = WorkflowPlanNodeSchemaInternal;
export const WorkflowProposal = Schema.Struct({
  status: Schema.Literals(["pending", "proposed", "provisional", "unavailable", "stale", "invalid"]),
  message: Schema.String,
  workspaceRoot: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.String),
  globalRevision: Schema.NullOr(Schema.String),
  definitionsStatus: Schema.Literals(["ready", "missing", "invalid", "permission_required", "unavailable"]),
  definitionsComplete: Schema.Boolean,
  requirementsKnown: Schema.Boolean,
  requirements: Schema.Array(WorkflowRequirement),
  issues: Schema.Array(WorkflowIssue),
  plan: Schema.NullOr(WorkflowPlanGroup),
});
export type WorkflowProposalInfo = typeof WorkflowProposal.Type;
// the identity of an agreed proposal's evidence, projected from InterpretationEvidence: the publishing message or the recorded tool submission
const EvidenceId = Schema.String.check(Schema.isNonEmpty());
export const AgreementEvidence = Schema.Union([
  Schema.Struct({kind: Schema.Literal("supervisor_message"), messageId: EvidenceId}),
  Schema.Struct({kind: Schema.Literal("interpretation_submission"), taskId: EvidenceId, attemptId: EvidenceId, itemId: EvidenceId, runId: EvidenceId,
    argumentsHash: EvidenceId}),
]);
export type AgreementEvidence = typeof AgreementEvidence.Type;
export const WorkflowAgreement = Schema.Struct({
  status: Schema.Literals(["agreed", "stale"]),
  message: Schema.String,
  proposalId: Schema.String,
  agreedAt: Schema.Number,
  evidence: AgreementEvidence,
  agentMessageId: Schema.String,
  workflow: WorkflowProposal,
});
export type WorkflowAgreementInfo = typeof WorkflowAgreement.Type;
export const WorkflowProtocolDiagnosticSchema = Schema.Struct({
  role: Schema.Literals(["supervisor", "operative"]),
  proposalId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  messageId: Schema.String.check(Schema.isMaxLength(512)),
  code: Schema.String.check(Schema.isMaxLength(80)),
  observedAt: Schema.Finite,
  /** Record path of the first failing field and its expected shape, for focused repair. */
  path: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(512)))),
  expected: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(300)))),
  detail: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(80)))),
  /** Consecutive rejected Supervisor proposals without an accepted repair. */
  attempts: Schema.optionalKey(Schema.Finite),
});
export type WorkflowProtocolDiagnostic = typeof WorkflowProtocolDiagnosticSchema.Type;
export const DefinitionReview = Schema.Struct({
  status: Schema.Literals(["checking", "revert_requested", "authorized", "restored"]),
  message: Schema.String,
  expectedRevision: Schema.String,
  observedRevision: Schema.NullOr(Schema.String),
  supervisorMessageId: Schema.NullOr(Schema.String),
  userMessageIds: Schema.Array(Schema.String),
  updatedAt: Schema.Number,
});
export type DefinitionReviewInfo = typeof DefinitionReview.Type;
/** The four results a root monitoring review records; none sends anything by itself. */
export const reviewOutcomes = ["progress_updated", "no_change", "needs_attention", "insufficient_evidence"] as const;
const ReviewOutcomeKind = Schema.Literals(reviewOutcomes);
/** The last confirmed review outcome and the current one not (yet) confirmed: recorded, unconfirmed, or missing. */
export const MonitoringReview = Schema.Struct({
  lastConfirmed: Schema.NullOr(Schema.Struct({outcome: ReviewOutcomeKind, reason: Schema.NullOr(Schema.String), at: Schema.Number})),
  current: Schema.NullOr(Schema.Struct({
    state: Schema.Literals(["recorded", "unconfirmed", "missing"]),
    outcome: Schema.NullOr(ReviewOutcomeKind),
    reason: Schema.NullOr(Schema.String),
    problem: Schema.NullOr(Schema.String),
    at: Schema.Number,
  })),
});
export type SupervisorMonitoringReview = typeof MonitoringReview.Type;
export const MonitoringStatus = Schema.Struct({
  state: Schema.Literals(["idle", "busy", "unavailable", "uncertain"]),
  message: Schema.String,
  pendingItems: Schema.Number,
  nextReviewAt: Schema.NullOr(Schema.Number),
  lastNoticeAt: Schema.NullOr(Schema.Number),
  retryable: Schema.optionalKey(Schema.Boolean),
  review: Schema.optionalKey(MonitoringReview),
});
export type SupervisorMonitoringStatus = typeof MonitoringStatus.Type;
export const TaskInterpretation = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  sourceHash: Schema.optionalKey(Schema.String),
  threadId: Schema.String,
  projectId: Schema.String,
  sourceRunId: Schema.String,
  sourceMessageId: Schema.String,
  status: Schema.Literals(["queued", "dispatching", "waiting", "inferred", "needs_context", "not_supervised", "unavailable", "uncertain", "expired"]),
  objective: Schema.NullOr(Schema.String),
  reason: Schema.String,
  updatedAt: Schema.Number,
  workflow: Schema.optionalKey(Schema.NullOr(WorkflowProposal)),
  agreement: Schema.optionalKey(Schema.NullOr(WorkflowAgreement)),
  workflowProposalId: Schema.optionalKey(Schema.String),
  definitionReview: Schema.optionalKey(Schema.NullOr(DefinitionReview)),
  workflowProtocolDiagnostic: Schema.optionalKey(Schema.NullOr(WorkflowProtocolDiagnosticSchema)),
});
export type TaskInterpretationInfo = typeof TaskInterpretation.Type;
export const ProjectSupervisorSnapshot = Schema.Struct({
  noProjectMode: Schema.optional(Schema.Literals(["off", "on_request", "automatic"])),
  projectId: Schema.String,
  mainThreadId: Schema.NullOr(Schema.String),
  modelApplication: Schema.NullOr(Schema.Struct({pending: Schema.Boolean, attempts: Schema.Number, message: Schema.NullOr(Schema.String)})),
  settings: Schema.Struct({generation: Schema.Number, modelSelection: ModelSelection, pending: Schema.Boolean, monitoring: Schema.optionalKey(MonitoringSettings), teamSettings: Schema.optionalKey(SupervisorTeamSettings)}),
  binding: Schema.NullOr(ProjectSupervisorBinding),
  modelSelection: Schema.NullOr(ModelSelection),
  models: Schema.Array(SupervisorModel),
  monitoringStatus: Schema.optionalKey(MonitoringStatus),
  available: Schema.Boolean,
  message: Schema.String,
  tasks: Schema.Array(TaskInterpretation),
  team: Schema.optionalKey(Schema.NullOr(ProjectSupervisorTeamSnapshot)),
  /** Durable per-chat stop for the selected main, backed by the instance thread policy. */
  chatSupervision: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    stopped: Schema.Boolean,
    policyGeneration: Schema.Number,
    stoppedBy: Schema.NullOr(Schema.Literals(["direct", "relay", "chat", "ui"])),
    stoppedCallerThreadId: Schema.optional(Schema.NullOr(Schema.String)), stoppedUserMessageId: Schema.optional(Schema.NullOr(Schema.String)),
    effectiveEnabled: Schema.optional(Schema.Boolean), activation: Schema.optional(Schema.String), stoppedAt: Schema.NullOr(Schema.Number),
  }))),
});
export type ProjectSupervisorInfo = typeof ProjectSupervisorSnapshot.Type;
export const ProjectSupervisorChatSupervision = Schema.Struct({
  projectId: Schema.String,
  mainThreadId: Schema.String,
  enabled: Schema.Boolean,
  policyGeneration: Schema.Number,
});
export type ProjectSupervisorChatSupervisionInput = typeof ProjectSupervisorChatSupervision.Type;
export const ProjectSupervisorSave = Schema.Struct({
  projectId: Schema.String,
  mainThreadId: Schema.optionalKey(Schema.String),
  expectedGeneration: Schema.Number,
  modelSelection: ModelSelection,
  monitoring: Schema.optionalKey(MonitoringSettings),
  teamSettings: Schema.optionalKey(SupervisorTeamSettings),
});
export type ProjectSupervisorSaveInput = typeof ProjectSupervisorSave.Type;
export const ProjectSupervisorRetry = Schema.Struct({
  projectId: Schema.String,
  mainThreadId: Schema.String,
  expectedGeneration: Schema.Number,
  threadId: Schema.String,
  bindingGeneration: Schema.Number,
  action: Schema.Literals(["retry", "replace"]),
});
export type ProjectSupervisorRetryInput = typeof ProjectSupervisorRetry.Type;
export const ProjectSupervisorSaveResult = Schema.Struct({
  status: Schema.Literals(["saved", "conflict", "invalid", "unavailable", "uncertain"]),
  message: Schema.String,
  snapshot: Schema.NullOr(ProjectSupervisorSnapshot),
});
export type ProjectSupervisorSaveOutcome = typeof ProjectSupervisorSaveResult.Type;
