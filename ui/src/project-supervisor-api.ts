import { Data, Effect } from "effect";
import type { WorkflowProgressSnapshot } from "../../src/workflow-progress.js";
import type {
  ProjectSupervisorChatSupervisionInput,
  ProjectSupervisorInfo,
  ProjectSupervisorRetryInput,
  ProjectSupervisorSaveInput,
  ProjectSupervisorSaveOutcome,
} from "../../src/project-supervisor-contract.js";
import { ApiClient, classifyMutation, type MutationFailure } from "./api.js";

// a supervisor change that failed; definitelyNotSaved tells the panel that the change was certainly not performed
export class ProjectSupervisorRequestError extends Data.TaggedError("ProjectSupervisorRequestError")<{
  readonly message: string;
  readonly definitelyNotSaved: boolean;
}> {}

// a read answered for another project, main conversation, page or Supervisor binding than the one requested
export class ScopeMismatch extends Data.TaggedError("ScopeMismatch")<{readonly message: string}> {}

export const loadProjectSupervisor = Effect.fnUntraced(function* (projectId: string, mainThreadId: string | null = null) {
  const client = yield* ApiClient;
  const value: ProjectSupervisorInfo = yield* client.guidance.projectSupervisor({query: {projectId, ...(mainThreadId ? {mainThreadId} : {})}});
  if (value.projectId !== projectId || value.mainThreadId !== mainThreadId)
    return yield* new ScopeMismatch({message: "The Supervisor response belongs to another project."});
  if (value.settings.teamSettings && (!Number.isInteger(value.settings.teamSettings.maxHelpersPerRoot) ||
    value.settings.teamSettings.maxHelpersPerRoot < 0 || value.settings.teamSettings.maxHelpersPerRoot > 20))
    return yield* new ScopeMismatch({message: "The Supervisor team settings are outside the supported range."});
  if (value.team && value.binding && value.team.root.threadId !== value.binding.threadId)
    return yield* new ScopeMismatch({message: "The Supervisor team response belongs to another root conversation."});
  return value;
});

export type WorkflowProgressPageRequest = {
  workflowOffset?: number;
  lineageOffset?: number;
  limit?: number;
  expectedBinding?: {threadId: string; generation: number};
};

export const loadWorkflowProgress = Effect.fnUntraced(function* (projectId: string, mainThreadId: string, page: WorkflowProgressPageRequest = {}) {
  const client = yield* ApiClient;
  const value: WorkflowProgressSnapshot = yield* client.guidance.workflowProgress({query: {
    projectId,
    mainThreadId,
    ...(page.workflowOffset === undefined ? {} : {workflowOffset: String(page.workflowOffset)}),
    ...(page.lineageOffset === undefined ? {} : {lineageOffset: String(page.lineageOffset)}),
    ...(page.limit === undefined ? {} : {limit: String(page.limit)}),
  }});
  if (value.projectId !== projectId || value.mainThreadId !== mainThreadId ||
    value.workflowOffset !== (page.workflowOffset ?? 0) || value.lineageOffset !== (page.lineageOffset ?? 0))
    return yield* new ScopeMismatch({message: "The live workflow progress response belongs to another selection or page."});
  if (page.expectedBinding && value.scope && (value.scope.supervisorThreadId !== page.expectedBinding.threadId ||
    value.scope.bindingGeneration !== page.expectedBinding.generation))
    return yield* new ScopeMismatch({message: "The live workflow progress response belongs to another Supervisor binding."});
  if (value.coverage) {
    const scopeThreadIds = new Set(value.scope?.threads.map(thread => thread.threadId) ?? []);
    if (value.coverage.some(item => !scopeThreadIds.has(item.threadId)) ||
      new Set(value.coverage.map(item => item.threadId)).size !== value.coverage.length)
      return yield* new ScopeMismatch({message: "The live workflow coverage response does not match its native scope page."});
  }
  return value;
});

// re-reads the loaded pages one after another and stops after the first page that is not ok
export const refreshWorkflowProgressPages = Effect.fnUntraced(function* (projectId: string, mainThreadId: string, pages: readonly WorkflowProgressPageRequest[]) {
  const requests = pages.length > 0 ? pages : [{workflowOffset: 0, lineageOffset: 0}];
  const refreshed: WorkflowProgressSnapshot[] = [];
  for (const page of requests) {
    const result = yield* loadWorkflowProgress(projectId, mainThreadId, page);
    refreshed.push(result);
    if (result.status !== "ok") break;
  }
  return refreshed;
});

const unconfirmed = "The operation outcome could not be confirmed. Refresh Supervisor settings before trying again.";

// the golden outcome texts of every supervisor change (CT-UI-API-01): a refusal keeps the change unperformed, anything else is unconfirmed
export const supervisorRequestError = (failure: MutationFailure): ProjectSupervisorRequestError => {
  if (failure._tag === "Unconfirmed") return new ProjectSupervisorRequestError({message: unconfirmed, definitelyNotSaved: false});
  const message = {
    refreshed: "Session refreshed. Your Supervisor change was not performed; review the state and try again.",
    refresh_failed: "Your Supervisor change was not performed. Session refresh failed; reconnect and try again.",
    too_large: "Your Supervisor change was not performed because the request is too large.",
    format: "Your Supervisor change was not performed because the server rejected the request format.",
  }[failure.reason];
  return new ProjectSupervisorRequestError({message, definitelyNotSaved: true});
};

type SupervisorChange = ProjectSupervisorSaveInput | ProjectSupervisorRetryInput | ProjectSupervisorChatSupervisionInput;

// one supervisor change: sent once, classified, and accepted only when its snapshot belongs to the requested project and main
const postProjectSupervisor = <I extends SupervisorChange>(send: (client: ApiClient["Service"], input: I) => Effect.Effect<ProjectSupervisorSaveOutcome, unknown>) =>
  (input: I) => classifyMutation(Effect.flatMap(ApiClient, client => send(client, input))).pipe(
    Effect.mapError(supervisorRequestError),
    Effect.flatMap(result => result.snapshot && (result.snapshot.projectId !== input.projectId || result.snapshot.mainThreadId !== (input.mainThreadId ?? null))
      ? Effect.fail(new ProjectSupervisorRequestError({message: "The response belongs to another project. Refresh Supervisor settings before trying again.", definitelyNotSaved: false}))
      : Effect.succeed(result)));

export const saveProjectSupervisor = postProjectSupervisor((client, input: ProjectSupervisorSaveInput) =>
  client.guidance.saveProjectSupervisor({payload: input}));

export const retryProjectSupervisor = postProjectSupervisor((client, input: ProjectSupervisorRetryInput) =>
  client.guidance.retryProjectSupervisor({payload: input}));

/** The dashboard's per-chat Stop supervision / Enable supervision control, backed by the instance thread policy. */
export const setChatSupervision = postProjectSupervisor((client, input: ProjectSupervisorChatSupervisionInput) =>
  client.guidance.chatSupervision({payload: input}));
