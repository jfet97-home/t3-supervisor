import { NoProjectControl, NoProjectControlSave, NoProjectControlResult, SupervisionStart, SupervisionStartStatus, SupervisionCandidates } from "./supervisor-control-contract.js";
import { ThreadPolicy } from "./thread-policy-contract.js";
import { ProjectDefinitions, ProjectConfigSaveInput, ProjectConfigSaveResult } from "./project-definitions-contract.js";
import { Schema } from "effect";
import { DashboardOverview } from "./dashboard-overview.js";
import { ProjectSupervisorSnapshot, ProjectSupervisorSave, ProjectSupervisorChatSupervision, ProjectSupervisorRetry, ProjectSupervisorSaveResult } from "./project-supervisor-contract.js";
import { WorkflowProgressSnapshotSchema } from "./workflow-progress.js";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { SupervisionControl, SupervisionControlSave, SupervisionControlResult, SupervisionSetup, SupervisionSetupOptions, SupervisionSetupResult, GlobalDefinitionsControl, GlobalDefinitionsControlSave, GlobalDefinitionsControlResult } from "./supervisor-control-contract.js";

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
  coverage: Text,
  tokensUsed: Schema.Number,
});
export type GuidanceSnapshot = typeof Snapshot.Type;
// the sign-in body: any other json value signs in with an empty token, which is refused
export const LoginRequest = Schema.Struct({ token: Text });
export class UiError extends Schema.TaggedError<UiError>()(
  "UiError",
  { message: Text },
  { httpApiStatus: 400 },
) {}
export const SupervisorApi = HttpApi.make("supervisor").add(
  HttpApiGroup.make("guidance")
    .add(
      HttpApiEndpoint.get("snapshot", "/snapshot", { success: Snapshot }),
      HttpApiEndpoint.get("dashboardOverview", "/dashboard-overview", {
        query: {offset: Schema.optional(Text), limit: Schema.optional(Text)}, success: DashboardOverview, error: UiError,
      }),
      HttpApiEndpoint.get("noProjectControl", "/no-project-control", {success: NoProjectControl, error: UiError}),
      HttpApiEndpoint.post("saveNoProjectControl", "/no-project-control", {payload: NoProjectControlSave, success: NoProjectControlResult, error: UiError}),
      HttpApiEndpoint.get("supervisionCandidates", "/supervision-candidates", {query: {query: Schema.optional(Text), purpose: Schema.optional(Schema.Literals(["start", "exclude"]))}, success: SupervisionCandidates, error: UiError}),
      HttpApiEndpoint.post("startSupervision", "/supervision-start", {payload: SupervisionStart, success: SupervisionStartStatus, error: UiError}),
      HttpApiEndpoint.get("supervisionStartStatus", "/supervision-start", {query: {threadId: Text, operationId: Text}, success: SupervisionStartStatus, error: UiError}),
      HttpApiEndpoint.get("supervisionControl", "/supervision-control", {
        query: {projectId: Schema.optional(Schema.String)}, success: SupervisionControl, error: UiError,
      }),
      HttpApiEndpoint.post("saveSupervisionControl", "/supervision-control", {
        payload: SupervisionControlSave, success: SupervisionControlResult, error: UiError,
      }),
      HttpApiEndpoint.get("supervisionSetupOptions", "/supervision-setup", {
        query: {projectId: Schema.String}, success: SupervisionSetupOptions, error: UiError,
      }),
      HttpApiEndpoint.post("setupSupervision", "/supervision-setup", {
        payload: SupervisionSetup, success: SupervisionSetupResult, error: UiError,
      }),
      HttpApiEndpoint.get("globalDefinitionsControl", "/global-definitions-control", {
        success: GlobalDefinitionsControl, error: UiError,
      }),
      HttpApiEndpoint.post("saveGlobalDefinitionsControl", "/global-definitions-control", {
        payload: GlobalDefinitionsControlSave, success: GlobalDefinitionsControlResult, error: UiError,
      }),
      HttpApiEndpoint.get("projectSupervisor", "/project-supervisor", {
        query: {projectId: Text, mainThreadId: Schema.optional(Text)}, success: ProjectSupervisorSnapshot, error: UiError,
      }),
      HttpApiEndpoint.get("workflowProgress", "/workflow-progress", {
        query: {
          projectId: Text,
          mainThreadId: Text,
          workflowOffset: Schema.optional(Text),
          lineageOffset: Schema.optional(Text),
          limit: Schema.optional(Text),
        },
        success: WorkflowProgressSnapshotSchema,
        error: UiError,
      }),
      HttpApiEndpoint.post("saveProjectSupervisor", "/project-supervisor", {
        payload: ProjectSupervisorSave, success: ProjectSupervisorSaveResult, error: UiError,
      }),
      HttpApiEndpoint.post("retryProjectSupervisor", "/project-supervisor/retry", {
        payload: ProjectSupervisorRetry, success: ProjectSupervisorSaveResult, error: UiError,
      }),
      HttpApiEndpoint.post("chatSupervision", "/project-supervisor/chat-supervision", {
        payload: ProjectSupervisorChatSupervision, success: ProjectSupervisorSaveResult, error: UiError,
      }),
      HttpApiEndpoint.get("projectConfiguration", "/project-configuration", {
        query: {projectId: Text, threadId: Schema.optional(Text)},
        success: ProjectDefinitions,
        error: UiError,
      }),
      // a legacy or unknown field is rejected at decoding, never stripped into a different save
      HttpApiEndpoint.post("saveProjectConfiguration", "/project-configuration", {
        payload: ProjectConfigSaveInput,
        success: ProjectConfigSaveResult,
        error: UiError,
      }).annotate(HttpApi.PayloadParseOptions, {onExcessProperty: "error"}),
      HttpApiEndpoint.post("threadPolicy", "/thread-policy", { payload: ThreadPolicy, success: ThreadPolicy, error: UiError }),
    )
    .prefix("/api/guidance"),
);
