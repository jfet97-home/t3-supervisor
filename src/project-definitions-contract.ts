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
  /** The project.yaml index summary: navigation for readers, never a substitute for the description. */
  summary: Schema.String,
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
  summary: Schema.String,
  fixed: Schema.Boolean,
  sequence: Schema.optional(Schema.Array(DefinitionNode)),
  parallel: Schema.optional(Schema.Array(DefinitionNode)),
  origin: Schema.optional(Schema.Literals(["global", "project"])),
  path: Schema.optional(Schema.String),
  sourceId: Schema.optional(Schema.String),
});
export type DefinitionWorkflowInfo = typeof DefinitionWorkflowInfo.Type;

export const definitionIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const catalogSummaryLimits = {maxLines: 2, maxChars: 240, maxEntries: 100} as const;
export type DefinitionCatalogKind = "workflows" | "steps";

/** One project.yaml index row; path is relative to .t3-supervisor and the required flag is the only authored requirement. */
export const DefinitionCatalogEntry = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  summary: Schema.String,
  required: Schema.Boolean,
});
export type DefinitionCatalogEntry = typeof DefinitionCatalogEntry.Type;

/** The authored project.yaml: the index of reusable definitions, as read and as saved by the editor. */
export const ProjectConfigurationInfo = Schema.Struct({
  workflows: Schema.Array(DefinitionCatalogEntry),
  steps: Schema.Array(DefinitionCatalogEntry),
  default_workflow: Schema.optional(Schema.String),
});
export type ProjectConfigurationInfo = typeof ProjectConfigurationInfo.Type;

/** An effective index row: global IDs are namespaced, sourceId keeps the authored ID and origin names the folder. */
export const EffectiveCatalogEntry = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  summary: Schema.String,
  required: Schema.Boolean,
  origin: Schema.Literals(["global", "project"]),
  sourceId: Schema.String,
});
export type EffectiveCatalogEntry = typeof EffectiveCatalogEntry.Type;
export const EffectiveConfigurationInfo = Schema.Struct({
  workflows: Schema.Array(EffectiveCatalogEntry),
  steps: Schema.Array(EffectiveCatalogEntry),
  default_workflow: Schema.optional(Schema.String),
});
export type EffectiveConfigurationInfo = typeof EffectiveConfigurationInfo.Type;

/** A candidate definition file found by the directory scan, indexed or not. */
export const DefinitionFileInfo = Schema.Struct({
  origin: Schema.Literals(["global", "project"]),
  kind: Schema.Literals(["workflows", "steps"]),
  id: Schema.String,
  path: Schema.String,
});
export type DefinitionFileInfo = typeof DefinitionFileInfo.Type;

export const definitionCatalogPath = (kind: DefinitionCatalogKind, id: string): string => kind === "workflows" ? `workflows/${id}.yaml` : `steps/${id}.md`;
/** Line endings become LF and each line and the whole summary are trimmed. */
export const normalizeCatalogSummary = (summary: string): string => summary.replace(/\r\n?/gu, "\n").split("\n").map(line => line.trim()).join("\n").trim();
export const catalogSummaryProblem = (summary: string): string | null => {
  const value = normalizeCatalogSummary(summary);
  if (!value) return "needs a nonempty summary";
  const lines = value.split("\n");
  if (lines.length > catalogSummaryLimits.maxLines || lines.some(line => !line)) return `summary must be at most ${catalogSummaryLimits.maxLines} nonempty lines`;
  if (value.length > catalogSummaryLimits.maxChars) return `summary must be at most ${catalogSummaryLimits.maxChars} characters`;
  return null;
};
export const normalizeProjectConfiguration = (config: ProjectConfigurationInfo): ProjectConfigurationInfo => {
  const rows = (entries: readonly DefinitionCatalogEntry[]) => entries.map(entry => ({id: entry.id, path: entry.path, summary: normalizeCatalogSummary(entry.summary), required: entry.required}));
  return {workflows: rows(config.workflows), steps: rows(config.steps), ...(config.default_workflow === undefined ? {} : {default_workflow: config.default_workflow})};
};
/** The first problem of an authored index, or null; the same rule the loader and the editor apply. */
export const projectConfigurationError = (config: ProjectConfigurationInfo): string | null => {
  if (config.workflows.length + config.steps.length > catalogSummaryLimits.maxEntries) return `project.yaml can index at most ${catalogSummaryLimits.maxEntries} definitions.`;
  for (const kind of ["workflows", "steps"] as const) {
    const seen = new Set<string>();
    for (const entry of config[kind]) {
      const label = `${kind === "workflows" ? "Workflow" : "Step"} ${entry.id || "(no id)"}`;
      if (!definitionIdPattern.test(entry.id)) return `${label}: id must be lowercase letters, digits, - or _ (at most 64 characters).`;
      if (seen.has(entry.id)) return `${label} is indexed more than once.`;
      seen.add(entry.id);
      if (entry.path !== definitionCatalogPath(kind, entry.id)) return `${label}: path must be ${definitionCatalogPath(kind, entry.id)}.`;
      const summary = catalogSummaryProblem(entry.summary);
      if (summary) return `${label}: ${summary}.`;
      if (typeof entry.required !== "boolean") return `${label}: required must be true or false.`;
    }
  }
  if (config.default_workflow !== undefined && !config.workflows.some(entry => entry.id === config.default_workflow))
    return `default_workflow ${config.default_workflow} must be an indexed workflow.`;
  return null;
};
/** Whether a snapshot carries the project.yaml index; one saved before the index format needs a fresh definition read. */
export const definitionSnapshotIndexed = (definitions: {readonly config?: unknown; readonly definitionFiles?: unknown}): boolean => {
  const config = definitions.config as {workflows?: unknown; steps?: unknown} | null | undefined;
  return Boolean(config) && Array.isArray(config!.workflows) && Array.isArray(config!.steps) && Array.isArray(definitions.definitionFiles);
};
/** Inclusion derived from the required flags: workflows before steps, in index order. */
export const requiredReferences = (config: {readonly workflows: ReadonlyArray<{readonly id: string; readonly required: boolean}>;
  readonly steps: ReadonlyArray<{readonly id: string; readonly required: boolean}>}): DefinitionReference[] =>
  [...config.workflows.filter(entry => entry.required).map(entry => ({workflow: entry.id})), ...config.steps.filter(entry => entry.required).map(entry => ({step: entry.id}))];

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
  config: EffectiveConfigurationInfo,
  projectConfig: Schema.NullOr(ProjectConfigurationInfo),
  definitionFiles: Schema.Array(DefinitionFileInfo),
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
