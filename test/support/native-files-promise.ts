import { Deferred, Effect } from "effect";
import type { GitProbeError } from "../../src/git-probe.js";
import { cancelOnAbort, NativeEnvelope } from "../../src/native-envelope.js";
import type { ProjectConfigWriter } from "../../src/project-config-editor.js";
import type { ProjectDefinitionLoaderOptions as LoaderOptions } from "../../src/project-definitions.js";
import { ProjectCommitter as Committer, ProjectFiles as Files, ProjectWriter as Writer, type CommitOutcome, type FreshGitInfo, type GitOperationState,
  type ListEntries, type ProjectFileError, type ReadFileResult, type VcsInfo } from "../../src/project-files.js";

// the baseline promise call shapes of the native file clients, for in-memory fakes and the characterizations (tests are not
// business code): fakes become the services through the as* adapters, and make* hand the file clients out as promises

export interface ProjectFiles {
  directoryExists(root: string, signal: AbortSignal): Promise<boolean>;
  list(root: string, path: string, signal: AbortSignal): Promise<ListEntries>;
  read(root: string, path: string, signal: AbortSignal): Promise<ReadFileResult>;
  vcsInfo?(root: string, signal: AbortSignal): Promise<VcsInfo>;
  gitOperationState?(root: string, signal: AbortSignal): Promise<GitOperationState>;
}
export interface ProjectWriter {
  checkProjectConfigFile(root: string, signal: AbortSignal): Promise<boolean>;
  writeProjectConfig(root: string, contents: string, signal: AbortSignal): Promise<void>;
  writeFile?(root: string, path: string, contents: string, signal: AbortSignal): Promise<void>;
}
export interface ProjectCommitter {
  commitFiles(root: string, paths: readonly string[], message: string, actionId: string, signal: AbortSignal): Promise<CommitOutcome>;
}
export type FreshGitProbe = (root: string, signal: AbortSignal) => Promise<FreshGitInfo>;
export interface ProjectDefinitionSetupWriter {
  writeFile(root: string, path: string, contents: string, signal: AbortSignal): Promise<void>;
  commitFiles?: ProjectCommitter["commitFiles"];
}
export interface ProjectDefinitionLoaderOptions extends Omit<LoaderOptions, "setupWriter" | "gitProbe"> {
  setupWriter?: ProjectDefinitionSetupWriter;
  gitProbe?: FreshGitProbe;
}

// a fake's call: its signal aborts once the service's cancel trigger completes (at once when it already has) or the call is interrupted
const promised = <A, E = ProjectFileError>(call: (signal: AbortSignal) => Promise<A>, cancel: Deferred.Deferred<void> | undefined): Effect.Effect<A, E> =>
  Effect.scoped(Effect.gen(function* () {
    const cancelled = new AbortController();
    if (cancel !== undefined) {
      if (Deferred.isDoneUnsafe(cancel)) cancelled.abort();
      else yield* Effect.forkScoped(Effect.andThen(Deferred.await(cancel), Effect.sync(() => cancelled.abort())));
    }
    // a fake rejects with whatever it throws; the definitions classify it as they classified the baseline rejection
    return yield* Effect.tryPromise({try: interrupted => call(AbortSignal.any([cancelled.signal, interrupted])), catch: error => error as E});
  }));

// the service shape of an in-memory file fake; its methods are read on every call, so a replaced fake method takes effect
export const asProjectFiles = (files: ProjectFiles): Files["Service"] => ({
  directoryExists: (root, cancel) => promised(signal => files.directoryExists(root, signal), cancel),
  list: (root, path, cancel) => promised(signal => files.list(root, path, signal), cancel),
  read: (root, path, cancel) => promised(signal => files.read(root, path, signal), cancel),
  ...(files.vcsInfo ? {vcsInfo: (root: string, cancel?: Deferred.Deferred<void>) => promised(signal => files.vcsInfo!(root, signal), cancel)} : {}),
  ...(files.gitOperationState ? {gitOperationState: (root: string, cancel?: Deferred.Deferred<void>) => promised(signal => files.gitOperationState!(root, signal), cancel)} : {}),
});

// the config writer shape of an in-memory writer fake
export const asProjectWriter = (writer: ProjectWriter): ProjectConfigWriter => ({
  checkProjectConfigFile: (root, cancel) => promised(signal => writer.checkProjectConfigFile(root, signal), cancel),
  writeProjectConfig: (root, contents, cancel) => promised(signal => writer.writeProjectConfig(root, contents, signal), cancel),
});

// loader options whose setup writer, commit and git probe fakes are the service shapes
export const asLoaderOptions = ({setupWriter, gitProbe, ...options}: ProjectDefinitionLoaderOptions): LoaderOptions => ({
  ...options,
  ...(setupWriter ? {setupWriter: {
    writeFile: (root: string, path: string, contents: string, cancel?: Deferred.Deferred<void>) => promised(signal => setupWriter.writeFile(root, path, contents, signal), cancel),
    ...(setupWriter.commitFiles ? {commitFiles: (root: string, paths: readonly string[], message: string, actionId: string, cancel?: Deferred.Deferred<void>) =>
      promised(signal => setupWriter.commitFiles!(root, paths, message, actionId, signal), cancel)} : {}),
  }} : {}),
  ...(gitProbe ? {gitProbe: (root: string, cancel?: Deferred.Deferred<void>) => promised<FreshGitInfo, GitProbeError>(signal => gitProbe(root, signal), cancel)} : {}),
});

const build = <S>(make: Effect.Effect<S, never, NativeEnvelope>): S => Effect.runSync(Effect.provide(make, NativeEnvelope.layer));
// one service call whose cancel trigger is the caller's signal, as the composition root hands its callers' signals to the services
const settle = <A, E>(signal: AbortSignal, call: (cancel: Deferred.Deferred<void>) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(cancelOnAbort(signal), call)));

export const makeProjectFiles = (baseUrl: string, token: string): Required<ProjectFiles> => {
  const files = build(Files.make({baseUrl, token}));
  return {
    directoryExists: (root, signal) => settle(signal, cancel => files.directoryExists(root, cancel)),
    list: (root, path, signal) => settle(signal, cancel => files.list(root, path, cancel)),
    read: (root, path, signal) => settle(signal, cancel => files.read(root, path, cancel)),
    vcsInfo: (root, signal) => settle(signal, cancel => files.vcsInfo!(root, cancel)),
    gitOperationState: (root, signal) => settle(signal, cancel => files.gitOperationState!(root, cancel)),
  };
};

export const makeProjectWriter = (baseUrl: string, token: string): Required<ProjectWriter> => {
  const writer = build(Writer.make({baseUrl, token}));
  return {
    checkProjectConfigFile: (root, signal) => settle(signal, cancel => writer.checkProjectConfigFile(root, cancel)),
    writeProjectConfig: (root, contents, signal) => settle(signal, cancel => writer.writeProjectConfig(root, contents, cancel)),
    writeFile: (root, path, contents, signal) => settle(signal, cancel => writer.writeFile(root, path, contents, cancel)),
  };
};

export const makeProjectCommitter = (baseUrl: string, token: string): ProjectCommitter => {
  const committer = build(Committer.make({baseUrl, token}));
  return {commitFiles: (root, paths, message, actionId, signal) => settle(signal, cancel => committer.commitFiles(root, paths, message, actionId, cancel))};
};
