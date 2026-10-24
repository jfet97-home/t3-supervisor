import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { Atom } from "effect/reactivity";
import type { ProjectConfigSave, ProjectConfigSaveOutcome, ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ApiClient, classifyMutation, type MutationFailure, type MutationRefusal } from "./api.js";
import { admittedMutation, scopeKey, uiRuntime } from "./atoms.js";

// a save outcome the editor reports with its golden text; definitelyNotSaved keeps editing allowed
export class ProjectConfigRequestError extends Data.TaggedError("ProjectConfigRequestError")<{
  readonly message: string;
  readonly definitelyNotSaved: boolean;
}> {}

// a definitions read that failed or answered for another selection; the panel shows its own text for both
export class ProjectDefinitionsReadError extends Data.TaggedError("ProjectDefinitionsReadError")<{readonly message: string}> {}

// reads the definitions of one checkout selection; an answer for another selection is not a read of this one
export const loadProjectDefinitions = (projectId: string, threadId: string | null, checkout?: string) => Effect.gen(function* () {
  const client = yield* ApiClient;
  const value = yield* client.guidance.projectConfiguration({query: {...(threadId === null ? {projectId} : {projectId, threadId}), ...(checkout ? {checkout} : {})}}).pipe(
    Effect.mapError(() => new ProjectDefinitionsReadError({message: "Project definitions could not be loaded."})));
  if (value.projectId !== projectId || value.threadId !== threadId)
    return yield* new ProjectDefinitionsReadError({message: "The definition response belongs to another selection."});
  return value;
});

export interface LoadedDefinitions {
  readonly definitions: ProjectDefinitionSnapshot;
  readonly loadedAt: number;
  // the T3 environment the definitions were read for; drafts, saves and their outcomes stay with it
  readonly environmentId: string | null;
}

// the family key of one definitions read: the T3 environment, the checkout selection and the auth epoch; a refresh reads
// the same key again, so a failed refresh keeps the latest successful read
export const definitionsReadKey = (environmentId: string | null, projectId: string, threadId: string | null, authEpoch: number, checkout?: string): string =>
  scopeKey(environmentId, projectId, threadId, authEpoch, checkout ?? null);

// the definitions read of one key (definitionsReadKey), recording the environment it was read for; a new key disposes and
// interrupts the previous read
export const projectDefinitionsAtom = Atom.family((key: string) => {
  const [environmentId, projectId, threadId, , checkout] = JSON.parse(key) as [string | null, string, string | null, number, string | null];
  return uiRuntime.atom(Effect.zipWith(loadProjectDefinitions(projectId, threadId, checkout ?? undefined), Clock.currentTimeMillis,
    (definitions, loadedAt): LoadedDefinitions => ({definitions, loadedAt, environmentId})));
});

const requestSave = (input: ProjectConfigSave) =>
  Effect.flatMap(ApiClient, (client) => client.guidance.saveProjectConfiguration({payload: input}));

// one admitted save per user action, keyed by the editor's draft scope and the attempt's operation id
export const saveProjectConfigurationAtom = admittedMutation(requestSave);

const refusalText: Record<MutationRefusal, string> = {
  refreshed: "Session refreshed. Your draft was not saved; review it and save again.",
  refresh_failed: "Your draft was not saved. Session refresh failed; reconnect and save again.",
  too_large: "Your draft was not saved. The request is too large; shorten the project configuration before saving again.",
  format: "Your draft was not saved. The server rejected the request format.",
};
const unconfirmed = (message: string) => new ProjectConfigRequestError({message, definitelyNotSaved: false});

// the editor's outcome of an admitted save (CT-UI-API-01): a refusal before the write keeps editing allowed; an
// unconfirmed or interrupted save and an answer for another workspace are not confirmed
export const resolveSave = (input: ProjectConfigSave) =>
  (exit: Exit.Exit<ProjectConfigSaveOutcome, MutationFailure>): Exit.Exit<ProjectConfigSaveOutcome, ProjectConfigRequestError> => {
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      if (Option.isNone(failure)) return Exit.fail(unconfirmed("Save outcome unknown. Refresh before retrying."));
      return Exit.fail(failure.value._tag === "NotPerformed"
        ? new ProjectConfigRequestError({message: refusalText[failure.value.reason], definitelyNotSaved: true})
        : unconfirmed("The save outcome could not be confirmed. Refresh and inspect project.yaml before retrying."));
    }
    const result = exit.value;
    if (result.definitions && (result.definitions.projectId !== input.projectId || result.definitions.threadId !== input.threadId))
      return Exit.fail(unconfirmed("The save response belongs to another workspace. Refresh and inspect project.yaml before retrying."));
    return Exit.succeed(result);
  };

// the classified save request resolved as the editor resolves its admitted save
export const saveProjectConfiguration = (input: ProjectConfigSave) =>
  Effect.flatMap(Effect.exit(classifyMutation(requestSave(input))), resolveSave(input));

// native folder and Git facts are read on Definitions entry or explicit refresh, never from the SSE hint stream
export const projectCheckouts = Atom.family((key: string) => uiRuntime.atom(Effect.gen(function* () {
  const [, projectId] = JSON.parse(key) as [string | null, string, number, number];
  const client = yield* ApiClient;
  const value = yield* client.guidance.projectCheckouts({query: {projectId}});
  if (value.projectId !== projectId) return yield* new ProjectDefinitionsReadError({message: "Working folders belong to another project."});
  return value;
})));
