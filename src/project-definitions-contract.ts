import { Schema } from "effect";

export const DefinitionRule = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  required_blocks: Schema.Array(Schema.String),
});
export const DefinitionBlock = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  expected_result: Schema.String,
});
export const DefinitionIssue = Schema.Struct({
  path: Schema.String,
  code: Schema.String,
  message: Schema.String,
});
export const ProjectDefinitions = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  workspaceRoot: Schema.String,
  revision: Schema.NullOr(Schema.String),
  editingAvailable: Schema.Boolean,
  status: Schema.Literals(["ready", "missing", "invalid", "permission_required", "unavailable"]),
  rules: Schema.Array(DefinitionRule),
  blocks: Schema.Array(DefinitionBlock),
  issues: Schema.Array(DefinitionIssue),
});
export type ProjectDefinitionSnapshot = typeof ProjectDefinitions.Type;

export const ProjectRuleSaveInput = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  expectedRevision: Schema.String,
  rules: Schema.Array(DefinitionRule),
});
export const ProjectRuleSaveResult = Schema.Struct({
  status: Schema.Literals(["saved", "conflict", "invalid", "permission_required", "unavailable", "uncertain"]),
  message: Schema.String,
  definitions: Schema.NullOr(ProjectDefinitions),
});
export type ProjectRuleSave = typeof ProjectRuleSaveInput.Type;
export type ProjectRuleSaveOutcome = typeof ProjectRuleSaveResult.Type;
