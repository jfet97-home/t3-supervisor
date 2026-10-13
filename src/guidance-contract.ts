import { ThreadPolicy } from "./thread-policy-contract.js";
import { ProjectDefinitions, ProjectRuleSaveInput, ProjectRuleSaveResult } from "./project-definitions-contract.js";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

const Text = Schema.String;
const NullableText = Schema.NullOr(Text);
export const RuleMode = Schema.Literals(["paused", "observe", "send"]);
export const RuleInput = Schema.Struct({
  id: NullableText,
  expectedGeneration: Schema.Number,
  name: Text,
  condition: Text,
  message: Text,
  scope: Schema.Literals(["global", "project", "scratch"]),
  projectId: NullableText,
  mode: RuleMode,
});
export const Rule = Schema.Struct({
  ...RuleInput.fields,
  id: Text,
  revision: Schema.Number,
  generation: Schema.Number,
  liveSince: Schema.Number,
  updatedAt: Schema.Number,
});
export type GuidanceRule = typeof Rule.Type;
export type GuidanceRuleInput = typeof RuleInput.Type;
export const Settings = Schema.Struct({
  generation: Schema.Number,
  guidancePaused: Schema.Boolean,
  monitoringPaused: Schema.Boolean,
  allowFollowupRace: Schema.Boolean,
  verifiedServerVersion: Schema.NullOr(Schema.String),
  model: Text,
  reasoning: Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
  dailyTokenBudget: Schema.Number,
  evidenceHours: Schema.Number,
  maxAnchorAgeSeconds: Schema.Number,
});
export type GuidanceSettings = typeof Settings.Type;
export const Project = Schema.Struct({
  id: Text,
  title: Text,
  available: Schema.Boolean,
  classification: Schema.Literals(["project", "scratch", "unclassified"]),
});
export const Activity = Schema.Struct({
  id: Text,
  kind: Text,
  threadId: NullableText,
  ruleId: NullableText,
  runId: NullableText,
  state: Text,
  reason: Text,
  detail: NullableText,
  createdAt: Schema.Number,
  noticeId: Schema.optional(NullableText),
  episodeEpoch: Schema.optional(Schema.Number),
});
export type GuidanceActivity = typeof Activity.Type;
export const guidanceScopeForSelection = (selected: string,projects: ReadonlyArray<typeof Project.Type>): string =>
  projects.some(project=>project.id===selected && project.classification==="scratch") ? "scratch" : selected;
export const guidanceScopeAfterClassification = (selected: string,classifiedProject: string): string =>
  selected===classifiedProject ? "scratch" : selected;
export const canResetActivity = (activity: GuidanceActivity): boolean =>
  activity.threadId !== null && activity.ruleId !== null && Number.isSafeInteger(activity.episodeEpoch);
export const Snapshot = Schema.Struct({
  environmentId: NullableText,
  serverVersion: NullableText,
  connected: Schema.Boolean,
  lastCycleAt: Schema.NullOr(Schema.Number),
  sendingReady: Schema.Boolean,
  sendingReason: Text,
  settings: Settings,
  threadPolicy: ThreadPolicy,
  threads: Schema.Array(Schema.Struct({ id: Text, title: Text, projectId: NullableText, available: Schema.Boolean })),
  projects: Schema.Array(Project),
  rules: Schema.Array(Rule),
  mutes: Schema.Array(Schema.Struct({ ruleId: Text, scopeId: Text })),
  activity: Schema.Array(Activity),
  history: Schema.Array(Activity),
  coverage: Text,
  tokensUsed: Schema.Number,
});
export type GuidanceSnapshot = typeof Snapshot.Type;
export const Decision = Schema.Struct({
  verdict: Schema.Literals(["match", "no_match", "needs_context"]),
  evidenceIds: Schema.Array(Text),
  reason: Text,
  phase: Schema.Literals(["same", "resolved", "new"]),
  objectId: NullableText,
});
export type GuidanceDecision = typeof Decision.Type;
export const PreviewInput = Schema.Struct({
  condition: Text,
  message: Text,
  evidence: Text,
});
export const ActionInput = Schema.Struct({
  id: Text,
  noticeId: NullableText,
  expectedEpoch: Schema.Number,
  action: Schema.Literals(["reset", "accept_uncertainty", "feedback_wrong"]),
});
export const ClassificationInput = Schema.Struct({
  projectId: Text,
  classification: Schema.Literals(["project", "scratch"]),
  expectedGeneration: Schema.Number,
});
export const MuteInput = Schema.Struct({
  ruleId: Text,
  scopeId: Text,
  muted: Schema.Boolean,
  expectedGeneration: Schema.Number,
});
export class UiError extends Schema.TaggedError<UiError>()(
  "UiError",
  { message: Text },
  { httpApiStatus: 400 },
) {}
export const SupervisorApi = HttpApi.make("supervisor").add(
  HttpApiGroup.make("guidance")
    .add(
      HttpApiEndpoint.get("snapshot", "/snapshot", { success: Snapshot }),
      HttpApiEndpoint.get("projectDefinitions", "/project-definitions", {
        query: {projectId: Text, threadId: Schema.optional(Text)},
        success: ProjectDefinitions,
        error: UiError,
      }),
      HttpApiEndpoint.post("saveProjectRules", "/project-rules", {
        payload: ProjectRuleSaveInput,
        success: ProjectRuleSaveResult,
        error: UiError,
      }),
      HttpApiEndpoint.post("saveRule", "/rules", {
        payload: RuleInput,
        success: Rule,
        error: UiError,
      }),
      HttpApiEndpoint.post("settings", "/settings", {
        payload: Settings,
        success: Settings,
        error: UiError,
      }),
      HttpApiEndpoint.post("threadPolicy", "/thread-policy", { payload: ThreadPolicy, success: ThreadPolicy, error: UiError }),
      HttpApiEndpoint.post("mute", "/mute", {
        payload: MuteInput,
        success: Schema.Void,
        error: UiError,
      }),
      HttpApiEndpoint.post("classify", "/classify", {
        payload: ClassificationInput,
        success: Schema.Void,
        error: UiError,
      }),
      HttpApiEndpoint.post("action", "/action", {
        payload: ActionInput,
        success: Schema.Void,
        error: UiError,
      }),
      HttpApiEndpoint.post("preview", "/preview", {
        payload: PreviewInput,
        success: Decision,
        error: UiError,
      }),
    )
    .prefix("/api/guidance"),
);
