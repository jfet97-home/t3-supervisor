import { Schema } from "effect";

export const ModelSelection = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
  options: Schema.Array(Schema.Struct({id: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean])})),
});
export type SupervisorModelSelection = typeof ModelSelection.Type;
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
  threadId: Schema.String,
  generation: Schema.Number,
  enabledAt: Schema.Number,
  state: Schema.Literals(["creating", "ready", "uncertain", "rejected", "missing"]),
});
export type SupervisorBinding = typeof ProjectSupervisorBinding.Type;
export const TaskInterpretation = Schema.Struct({
  threadId: Schema.String,
  projectId: Schema.String,
  sourceRunId: Schema.String,
  sourceMessageId: Schema.String,
  status: Schema.Literals(["queued", "dispatching", "waiting", "inferred", "needs_context", "unavailable", "uncertain", "expired"]),
  objective: Schema.NullOr(Schema.String),
  reason: Schema.String,
  updatedAt: Schema.Number,
});
export type TaskInterpretationInfo = typeof TaskInterpretation.Type;
export const ProjectSupervisorSnapshot = Schema.Struct({
  projectId: Schema.String,
  settings: Schema.Struct({generation: Schema.Number, modelSelection: ModelSelection, pending: Schema.Boolean}),
  binding: Schema.NullOr(ProjectSupervisorBinding),
  modelSelection: Schema.NullOr(ModelSelection),
  models: Schema.Array(SupervisorModel),
  available: Schema.Boolean,
  message: Schema.String,
  tasks: Schema.Array(TaskInterpretation),
});
export type ProjectSupervisorInfo = typeof ProjectSupervisorSnapshot.Type;
export const ProjectSupervisorSave = Schema.Struct({
  projectId: Schema.String,
  expectedGeneration: Schema.Number,
  modelSelection: ModelSelection,
});
export type ProjectSupervisorSaveInput = typeof ProjectSupervisorSave.Type;
export const ProjectSupervisorRetry = Schema.Struct({
  projectId: Schema.String,
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
