import { Schema } from "effect";

export const workflowDefinitionExpansionLimits = {maxNodes: 500, maxDepth: 32} as const;

export const DefinitionNode = Schema.suspend((): Schema.Codec<DefinitionNode> => Schema.Union([
  Schema.Struct({step: Schema.Union([Schema.String, Schema.Struct({id: Schema.String, name: Schema.String, description: Schema.String, references: Schema.optionalKey(Schema.Array(Schema.String))})])}),
  Schema.Struct({workflow: Schema.String}),
  Schema.Struct({sequence: Schema.Array(DefinitionNode)}),
  Schema.Struct({parallel: Schema.Array(DefinitionNode)}),
]));
export type DefinitionNode =
  | {readonly step: string | {readonly id: string; readonly name: string; readonly description: string; readonly references?: readonly string[]}}
  | {readonly workflow: string}
  | {readonly sequence: readonly DefinitionNode[]}
  | {readonly parallel: readonly DefinitionNode[]};

export const DefinitionReference = Schema.Union([
  Schema.Struct({step: Schema.String}),
  Schema.Struct({workflow: Schema.String}),
]);
export type DefinitionReference = typeof DefinitionReference.Type;

export const DefinitionStepInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  references: Schema.optionalKey(Schema.Array(Schema.String)),
  origin: Schema.optional(Schema.Literals(["global", "project"])),
  path: Schema.optional(Schema.String),
  sourceId: Schema.optional(Schema.String),
});
export type DefinitionStepInfo = typeof DefinitionStepInfo.Type;

export const DefinitionWorkflowInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  references: Schema.optionalKey(Schema.Array(Schema.String)),
  fixed: Schema.Boolean,
  sequence: Schema.optional(Schema.Array(DefinitionNode)),
  parallel: Schema.optional(Schema.Array(DefinitionNode)),
  origin: Schema.optional(Schema.Literals(["global", "project"])),
  path: Schema.optional(Schema.String),
  sourceId: Schema.optional(Schema.String),
});
export type DefinitionWorkflowInfo = typeof DefinitionWorkflowInfo.Type;

export const ProjectConfigurationInfo = Schema.Struct({
  required: Schema.Array(DefinitionReference),
  default_workflow: Schema.optional(Schema.String),
});
export type ProjectConfigurationInfo = typeof ProjectConfigurationInfo.Type;

export const DefinitionSource = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  origin: Schema.optional(Schema.Literals(["global", "project"])),
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
  globalOnly: Schema.optional(Schema.Boolean),
  globalRevision: Schema.optional(Schema.NullOr(Schema.String)),
  revision: Schema.NullOr(Schema.String),
  editingAvailable: Schema.Boolean,
  status: Schema.Literals(["ready", "missing", "invalid", "permission_required", "unavailable"]),
  steps: Schema.Array(DefinitionStepInfo),
  workflows: Schema.Array(DefinitionWorkflowInfo),
  config: ProjectConfigurationInfo,
  projectConfig: Schema.NullOr(ProjectConfigurationInfo),
  complete: Schema.Boolean,
  sources: Schema.Array(DefinitionSource),
  issues: Schema.Array(DefinitionIssue),
});
export type ProjectDefinitionSnapshot = typeof ProjectDefinitions.Type;

export const ProjectConfigSaveInput = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  expectedRevision: Schema.String,
  config: ProjectConfigurationInfo,
});
export const ProjectConfigSaveResult = Schema.Struct({
  status: Schema.Literals(["saved", "conflict", "invalid", "permission_required", "unavailable", "uncertain"]),
  message: Schema.String,
  definitions: Schema.NullOr(ProjectDefinitions),
});
export type ProjectConfigSave = typeof ProjectConfigSaveInput.Type;
export type ProjectConfigSaveOutcome = typeof ProjectConfigSaveResult.Type;
