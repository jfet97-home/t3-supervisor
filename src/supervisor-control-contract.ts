import { Schema } from "effect";

export const SupervisionControl = Schema.Struct({
  projectId: Schema.NullOr(Schema.String),
  generation: Schema.Number,
  enabled: Schema.Boolean,
  manual: Schema.Boolean,
  globallyEnabled: Schema.Boolean,
  effectiveEnabled: Schema.Boolean,
  detectionStatus: Schema.Literals(["present", "missing", "unavailable", "not_checked"]),
  detectionError: Schema.NullOr(Schema.String),
});
export type SupervisionControlInfo = typeof SupervisionControl.Type;
export const SupervisionControlSave = Schema.Struct({
  projectId: Schema.NullOr(Schema.String),
  expectedGeneration: Schema.Number,
  enabled: Schema.Boolean,
});
export type SupervisionControlInput = typeof SupervisionControlSave.Type;
export const SupervisionSetupCheckout = Schema.Struct({
  origin: Schema.Literal("project"),
  threadId: Schema.NullOr(Schema.String),
  workspaceRoot: Schema.String,
  branch: Schema.NullOr(Schema.String),
  isGitRepository: Schema.Boolean,
  folderStatus: Schema.Literals(["present", "missing", "unavailable"]),
});
export const SupervisionSetupOptions = Schema.Struct({
  projectId: Schema.String,
  generation: Schema.Number,
  available: Schema.Boolean,
  message: Schema.String,
  checkouts: Schema.Array(SupervisionSetupCheckout),
});
export const SupervisionSetup = Schema.Struct({
  projectId: Schema.String,
  expectedGeneration: Schema.Number,
  origin: Schema.Literal("project"),
  threadId: Schema.NullOr(Schema.String),
  expectedWorkspaceRoot: Schema.String,
  expectedBranch: Schema.NullOr(Schema.String),
  action: Schema.Literals(["create", "create_and_commit", "enable_existing"]),
});
export type SupervisionSetupInput = typeof SupervisionSetup.Type;
export const GlobalDefinitionsControl = Schema.Struct({
  generation: Schema.Number,
  enabled: Schema.Boolean,
  manual: Schema.Boolean,
  effectiveEnabled: Schema.Boolean,
  homePath: Schema.String,
  detectionStatus: Schema.Literals(["present", "missing", "unavailable", "not_checked"]),
  detectionError: Schema.NullOr(Schema.String),
});
export type GlobalDefinitionsControlInfo = typeof GlobalDefinitionsControl.Type;
export const GlobalDefinitionsControlSave = Schema.Struct({
  expectedGeneration: Schema.Number,
  enabled: Schema.Boolean,
});
export type GlobalDefinitionsControlInput = typeof GlobalDefinitionsControlSave.Type;
export const GlobalDefinitionsControlResult = Schema.Struct({
  status: Schema.Literals(["saved", "conflict", "unavailable", "uncertain"]),
  message: Schema.String,
  control: GlobalDefinitionsControl,
});
export const SupervisionControlResult = Schema.Struct({
  status: Schema.Literals(["saved", "conflict", "unavailable", "setup_required"]),
  message: Schema.String,
  control: SupervisionControl,
});
export const SupervisionSetupResult = Schema.Struct({
  status: Schema.Literals(["saved", "conflict", "unavailable", "uncertain"]),
  message: Schema.String,
  control: SupervisionControl,
  workspaceRoot: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});
