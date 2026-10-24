import { Context, Data, Deferred, Effect, Layer, Schema } from "effect";
import { posix } from "node:path";
import { NativeEnvelope, nativeMaxPayload, NativeStep, type NativeCall, type NativeEndpoint, type NativeExit } from "./native-envelope.js";

export const FileFailure = Schema.Literals(["missing", "invalid_file", "permission_required", "unavailable"]);
export type FileFailure = typeof FileFailure.Type;
export type FileScope = "read" | "write";
export type GitOperationState = {status: "safe"} | {status: "in_progress"; marker: string} | {status: "unavailable"; message: string};
export interface FreshGitInfo {
  workspaceRoot: string;
  branch: string | null;
  isRepo: boolean;
  changedPaths: string[];
  operationState: GitOperationState;
}

const fileErrorMessage = (code: FileFailure, scope: FileScope): string => code === "permission_required"
  ? `Enable filesystem:${scope} on the Supervisor ${scope} credential through deployment setup.`
  : code === "missing" ? "The requested project path does not exist."
    : code === "invalid_file" ? "Definitions must be readable UTF-8 text files, not binary files or directories."
      : "T3 project file access is unavailable.";

// a native file failure with its fixed message per code and credential scope; the positional constructor is the baseline call shape
export class ProjectFileError extends Data.TaggedError("ProjectFileError")<{readonly code: FileFailure; readonly scope: FileScope}> {
  constructor(code: FileFailure, scope: FileScope = "read") {
    super({code, scope});
  }
  override readonly message: string = fileErrorMessage(this.code, this.scope);
}

// the native results each client accepts; a client returns the native value itself, so revisions hash exactly what T3 returned
const Entry = Schema.Struct({path: Schema.String, kind: Schema.Literals(["file", "directory"])});
export const ListEntries = Schema.Struct({truncated: Schema.Boolean, entries: Schema.Array(Entry)});
export type ListEntries = typeof ListEntries.Type;
const ByteLength = Schema.Number.check(Schema.makeFilter((value: number) => Number.isSafeInteger(value) && value >= 0));
export const ReadFileResult = Schema.Struct({contents: Schema.String, byteLength: ByteLength, truncated: Schema.Boolean});
export type ReadFileResult = typeof ReadFileResult.Type;
export const Metadata = Schema.Struct({entries: Schema.Array(Schema.Unknown)});
export const VcsStatus = Schema.Struct({isRepo: Schema.Boolean, workingTree: Schema.Struct({files: Schema.Array(Schema.Struct({path: Schema.String}))})});
export const VcsRefs = Schema.Struct({isRepo: Schema.Boolean, refs: Schema.Array(Schema.Struct({name: Schema.String, current: Schema.Boolean,
  isDefault: Schema.Boolean, worktreePath: Schema.NullOr(Schema.String), isRemote: Schema.optionalKey(Schema.Boolean), remoteName: Schema.optionalKey(Schema.String)}))});
export type VcsInfo = {isRepo: boolean; branch: string | null; changedPaths?: string[]; refs?: typeof VcsRefs.Type.refs};
const CreatedCommit = Schema.Struct({commit: Schema.Struct({status: Schema.Literal("created"), commitSha: Schema.String})});
const isListEntries = Schema.is(ListEntries);
const isReadFileResult = Schema.is(ReadFileResult);
const isMetadata = Schema.is(Metadata);
const isVcsStatus = Schema.is(VcsStatus);
const isCreatedCommit = Schema.is(CreatedCommit);
const record = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const validPath = (path: string): boolean => path.startsWith(".t3-supervisor/") && !path.includes("\\") && !path.includes("\0") &&
  path.split("/").every(part => part !== ".." && part !== "." && part.length > 0);

const failure = (value: unknown, depth = 0): FileFailure => {
  if (depth > 12 || !value || typeof value !== "object") return "unavailable";
  if (record(value)) {
    if (value._tag === "EnvironmentAuthorizationError") return "permission_required";
    if (value.code === "ENOENT" || typeof value.message === "string" && /^ENOENT:/.test(value.message)) return "missing";
    if (value.code === "EACCES" || value.code === "EPERM" || typeof value.message === "string" && /^(?:EACCES|EPERM):/.test(value.message)) return "invalid_file";
    if (value.failure === "binary_file" || value.failure === "path_not_file") return "invalid_file";
  }
  const codes = Object.values(value).map(v => failure(v, depth + 1));
  return codes.includes("permission_required") ? "permission_required" : codes.includes("invalid_file") ? "invalid_file" : codes.includes("missing") ? "missing" : "unavailable";
};

// one native request on its own socket: 2 MiB frames, 5 s handshake, deadline over the whole call; a completed cancel ends it as unavailable
const fileCall = <A, E>(endpoint: NativeEndpoint, call: Pick<NativeCall<A, E>, "request" | "onChunk" | "onExit" | "cancel">, timeout: "10 seconds" | "30 seconds") =>
  ({endpoint, maxPayload: nativeMaxPayload.files, handshakeTimeout: "5 seconds", timeout, ...call}) satisfies NativeCall<A, E>;

const makeRpc = (native: NativeEnvelope["Service"], endpoint: NativeEndpoint, scope: FileScope) =>
  (tag: string, payload: Record<string, unknown>, cancel: Deferred.Deferred<void> | undefined): Effect.Effect<unknown, ProjectFileError> =>
    native.call(fileCall(endpoint, {request: {id: "definitions", tag, payload}, cancel,
      onExit: (exit: NativeExit) => exit._tag === "Success" ? Effect.succeed(NativeStep.done(exit.value))
        : Effect.fail(new ProjectFileError(exit._tag === "Malformed" ? "unavailable" : failure(exit.exit), scope)),
    }, "10 seconds")).pipe(Effect.catchTag("NativeEnvelopeError", () => Effect.fail(new ProjectFileError("unavailable", scope))));

// the first snapshot or local update of a status subscription, never acknowledged; an Exit before it is a failure
const vcsSnapshot = (native: NativeEnvelope["Service"], endpoint: NativeEndpoint, payload: Record<string, unknown>, cancel: Deferred.Deferred<void> | undefined) =>
  native.call(fileCall(endpoint, {request: {id: "definition-vcs-snapshot", tag: "subscribeVcsStatus", payload}, cancel,
    onChunk: (values: ReadonlyArray<unknown>) => {
      const event = values.find(value => record(value) && (value._tag === "snapshot" || value._tag === "localUpdated" || value.type === "snapshot" || value.type === "localUpdated"));
      return Effect.succeed(record(event) && record(event.local) ? NativeStep.done<unknown>(event.local) : NativeStep.continue);
    },
    onExit: (exit: NativeExit) => Effect.fail(new ProjectFileError(exit._tag === "Failure" ? failure(exit.exit) : "unavailable")),
  }, "10 seconds")).pipe(Effect.catchTag("NativeEnvelopeError", () => Effect.fail(new ProjectFileError("unavailable"))));

const unavailable = (message: string): GitOperationState => ({status: "unavailable", message});

const makeProjectFiles = Effect.fnUntraced(function* (endpoint: NativeEndpoint) {
  const native = yield* NativeEnvelope;
  const rpc = makeRpc(native, endpoint, "read");
  const readNativeFile = (root: string, path: string, cancel: Deferred.Deferred<void> | undefined) => Effect.gen(function* () {
    if (path.length > 512 || path.includes("\0") || path.includes("\\")) return yield* new ProjectFileError("unavailable");
    const value = yield* rpc("projects.readFile", {cwd: root, relativePath: path}, cancel);
    if (!isReadFileResult(value)) return yield* new ProjectFileError("unavailable");
    return value;
  });
  const gitOperationState = (root: string, cancel?: Deferred.Deferred<void>): Effect.Effect<GitOperationState, ProjectFileError> => Effect.gen(function* () {
    if (!posix.isAbsolute(root)) return unavailable("T3 requires an absolute checkout path to inspect Git state.");
    const metadataPath = posix.join(root, ".git");
    if (metadataPath.length > 512) return unavailable("The checkout path is too long to inspect Git state safely.");
    const metadata = yield* rpc("filesystem.getMetadata", {paths: [metadataPath]}, cancel);
    const kind = isMetadata(metadata) && metadata.entries.length === 1 && record(metadata.entries[0]) ? metadata.entries[0].kind : undefined;
    if (kind !== "directory" && kind !== "file") return unavailable("T3 could not identify this checkout's Git metadata directory.");
    let readGitFile: (path: string) => Effect.Effect<ReadFileResult, ProjectFileError>;
    if (kind === "directory") readGitFile = path => readNativeFile(root, `.git/${path}`, cancel);
    else {
      const read = yield* Effect.result(readNativeFile(root, ".git", cancel));
      if (read._tag === "Failure") return unavailable("T3 could not read this checkout's Git directory pointer.");
      const pointer = read.success;
      if (pointer.truncated || pointer.byteLength > 4096) return unavailable("This checkout's Git directory pointer is incomplete.");
      const match = /^gitdir:[ \t]*(.+?)[ \t]*\r?\n?$/.exec(pointer.contents);
      if (!match || !match[1] || match[1].includes("\0") || match[1].includes("\\")) return unavailable("This checkout has an unsupported Git directory pointer.");
      const gitDirectory = posix.isAbsolute(match[1]) ? posix.normalize(match[1]) : posix.resolve(root, match[1]);
      if (!posix.isAbsolute(gitDirectory) || gitDirectory.length > 512) return unavailable("This checkout's Git directory path is invalid or too long.");
      const gitDirectoryMetadata = yield* rpc("filesystem.getMetadata", {paths: [gitDirectory]}, cancel);
      if (!isMetadata(gitDirectoryMetadata) || gitDirectoryMetadata.entries.length !== 1 || !record(gitDirectoryMetadata.entries[0]) ||
        gitDirectoryMetadata.entries[0].kind !== "directory") return unavailable("T3 could not verify this checkout's Git metadata directory.");
      // linked worktrees store private metadata outside the checkout; inspect only fixed filenames read from the native pointer.
      readGitFile = path => readNativeFile(root, posix.join(gitDirectory, path), cancel);
    }
    const head = yield* Effect.result(readGitFile("HEAD"));
    if (head._tag === "Failure" || head.success.truncated || head.success.byteLength > 4096) return unavailable("T3 could not verify the checkout's Git HEAD file.");
    const operationFiles = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_LOG", "BISECT_START", "SQUASH_MSG", "AUTO_MERGE", "index.lock", "HEAD.lock", "packed-refs.lock", "config.lock"];
    const operationDirectories = ["rebase-merge", "rebase-apply", "sequencer"];
    for (const marker of operationFiles) {
      const found = yield* Effect.result(readGitFile(marker));
      if (found._tag === "Success") return {status: "in_progress", marker};
      if (found.failure.code !== "missing") return unavailable("T3 could not verify the checkout's Git operation state.");
    }
    for (const marker of operationDirectories) {
      const found = yield* Effect.result(readGitFile(marker));
      if (found._tag === "Success" || found.failure.code === "invalid_file") return {status: "in_progress", marker};
      if (found.failure.code !== "missing") return unavailable("T3 could not verify the checkout's Git operation state.");
    }
    return {status: "safe"};
  });
  return ProjectFiles.of({
    directoryExists: (root, cancel) => Effect.gen(function* () {
      const value = yield* rpc("filesystem.getMetadata", {paths: [root]}, cancel);
      if (!isMetadata(value) || value.entries.length !== 1) return yield* new ProjectFileError("unavailable");
      return record(value.entries[0]) && value.entries[0].kind === "directory";
    }),
    list: (root, path, cancel) => Effect.gen(function* () {
      if (path !== "" && path !== ".t3-supervisor" && !validPath(path)) return yield* new ProjectFileError("unavailable");
      const value = yield* rpc("projects.listEntries", {cwd: root, directoryPath: path}, cancel);
      if (!isListEntries(value) || value.entries.length > 512) return yield* new ProjectFileError("unavailable");
      return value;
    }),
    read: (root, path, cancel) => validPath(path) ? readNativeFile(root, path, cancel) : Effect.fail(new ProjectFileError("unavailable")),
    vcsInfo: (root, cancel) => Effect.gen(function* () {
      const refs = yield* rpc("vcs.listRefs", {cwd: root, refKind: "all", limit: 200}, cancel);
      if (!Schema.is(VcsRefs)(refs)) return yield* new ProjectFileError("unavailable");
      const current = refs.refs.filter(ref => ref.current === true && !ref.isRemote);
      if (current.length > 1) return yield* new ProjectFileError("unavailable");
      if (!refs.isRepo) return {isRepo: false, branch: null, changedPaths: []};
      const status = yield* vcsSnapshot(native, endpoint, {cwd: root, includeRemote: false}, cancel);
      if (!isVcsStatus(status)) return yield* new ProjectFileError("unavailable");
      return {isRepo: true, branch: current[0] ? String(current[0].name) : null, refs: refs.refs, changedPaths: status.workingTree.files.map(entry => String(entry.path))};
    }),
    gitOperationState,
  });
});

/** Uses native T3 read RPCs; it never reads project content from the container filesystem. */
export class ProjectFiles extends Context.Service<ProjectFiles, {
  // each call is one native request with a 10 s deadline; a completed cancel ends it, before connecting when already completed, as unavailable
  readonly directoryExists: (root: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<boolean, ProjectFileError>;
  readonly list: (root: string, path: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<ListEntries, ProjectFileError>;
  readonly read: (root: string, path: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<ReadFileResult, ProjectFileError>;
  readonly vcsInfo?: ((root: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<VcsInfo, ProjectFileError>) | undefined;
  readonly gitOperationState?: ((root: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<GitOperationState, ProjectFileError>) | undefined;
}>()("t3-supervisor/ProjectFiles") {
  static readonly make: (endpoint: NativeEndpoint) => Effect.Effect<ProjectFiles["Service"], never, NativeEnvelope> = makeProjectFiles;
  static readonly layer = (endpoint: NativeEndpoint): Layer.Layer<ProjectFiles, never, NativeEnvelope> => Layer.effect(ProjectFiles, makeProjectFiles(endpoint));
}

const makeProjectWriter = Effect.fnUntraced(function* (endpoint: NativeEndpoint) {
  const rpc = makeRpc(yield* NativeEnvelope, endpoint, "write");
  const writeFile = (root: string, path: string, contents: string, cancel?: Deferred.Deferred<void>) => Effect.gen(function* () {
    if (!validPath(path)) return yield* new ProjectFileError("unavailable", "write");
    const result = yield* rpc("projects.writeFile", {cwd: root, relativePath: path, contents}, cancel);
    if (!record(result) || result.relativePath !== path) return yield* new ProjectFileError("unavailable", "write");
  });
  const includes = (value: unknown, path: string, kind: string) => record(value) && value.truncated === false && Array.isArray(value.entries) &&
    value.entries.some(entry => record(entry) && entry.path === path && entry.kind === kind);
  return ProjectWriter.of({
    checkProjectConfigFile: (root, cancel) => Effect.gen(function* () {
      const rootEntries = yield* rpc("projects.listEntries", {cwd: root, directoryPath: ""}, cancel);
      if (!includes(rootEntries, ".t3-supervisor", "directory")) return false;
      const folder = yield* rpc("projects.listEntries", {cwd: root, directoryPath: ".t3-supervisor"}, cancel);
      return includes(folder, ".t3-supervisor/project.yaml", "file");
    }),
    writeProjectConfig: (root, contents, cancel) => writeFile(root, ".t3-supervisor/project.yaml", contents, cancel),
    writeFile,
  });
});

// writes only fixed .t3-supervisor paths through the native filesystem:write credential and verifies the echoed path
export class ProjectWriter extends Context.Service<ProjectWriter, {
  // whether .t3-supervisor is a directory holding a regular project.yaml, both from complete listings
  readonly checkProjectConfigFile: (root: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<boolean, ProjectFileError>;
  readonly writeProjectConfig: (root: string, contents: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<void, ProjectFileError>;
  readonly writeFile: (root: string, path: string, contents: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<void, ProjectFileError>;
}>()("t3-supervisor/ProjectWriter") {
  static readonly make: (endpoint: NativeEndpoint) => Effect.Effect<ProjectWriter["Service"], never, NativeEnvelope> = makeProjectWriter;
  static readonly layer = (endpoint: NativeEndpoint): Layer.Layer<ProjectWriter, never, NativeEnvelope> => Layer.effect(ProjectWriter, makeProjectWriter(endpoint));
}

export type CommitOutcome = {status: "committed" | "uncertain"; commitSha?: string};
const uncertain: CommitOutcome = {status: "uncertain"};

const makeProjectCommitter = Effect.fnUntraced(function* (endpoint: NativeEndpoint) {
  const native = yield* NativeEnvelope;
  const commit = (payload: {readonly actionId: string} & Record<string, unknown>, cancel: Deferred.Deferred<void> | undefined) => Effect.gen(function* () {
    // an already cancelled commit connects nothing; once a socket exists every unconfirmed end is uncertain
    if (cancel !== undefined && (yield* Deferred.isDone(cancel))) return yield* new ProjectFileError("unavailable", "write");
    let actionResult: unknown;
    let actionFailed = false;
    let actionFinished = false;
    return yield* native.call(fileCall(endpoint, {request: {id: "definition-setup-commit", tag: "git.runStackedAction", payload}, cancel,
      // every chunk of the action is acknowledged once its events were taken in
      onChunk: (values: ReadonlyArray<unknown>) => Effect.sync(() => {
        for (const event of values) {
          if (!record(event)) return NativeStep.done(uncertain);
          if (event.actionId !== payload.actionId) continue;
          if (event.kind === "action_failed") actionFailed = true;
          if (event.kind === "action_finished") {actionFinished = true;actionResult = event.result;}
        }
        return NativeStep.ack();
      }),
      onExit: (exit: NativeExit) => {
        if (exit._tag === "Failure") {
          if (failure(exit.exit) === "permission_required") return Effect.fail(new ProjectFileError("permission_required", "write"));
          return actionFinished || actionFailed ? Effect.succeed(NativeStep.done(uncertain)) : Effect.fail(new ProjectFileError("unavailable", "write"));
        }
        if (exit._tag !== "Success") return Effect.succeed(NativeStep.done(uncertain));
        if (actionFailed || !actionFinished || !isCreatedCommit(actionResult)) return Effect.fail(new ProjectFileError("unavailable", "write"));
        return Effect.succeed(NativeStep.done<CommitOutcome>({status: "committed", commitSha: actionResult.commit.commitSha}));
      },
    }, "30 seconds")).pipe(Effect.catchTag("NativeEnvelopeError", () => Effect.succeed(uncertain)));
  });
  return ProjectCommitter.of({
    commitFiles: (root, paths, message, actionId, cancel) => !paths.length || !paths.every(validPath)
      ? Effect.fail(new ProjectFileError("unavailable", "write"))
      : commit({actionId, cwd: root, action: "commit", commitMessage: message, filePaths: [...paths]}, cancel),
  });
});

// commits fixed setup paths through git.runStackedAction under the caller's deterministic action id; it never retries
export class ProjectCommitter extends Context.Service<ProjectCommitter, {
  // committed only for a finished action that created a commit; a lost connection, cancel or 30 s deadline after connecting is uncertain
  readonly commitFiles: (root: string, paths: readonly string[], message: string, actionId: string, cancel?: Deferred.Deferred<void>) =>
    Effect.Effect<CommitOutcome, ProjectFileError>;
}>()("t3-supervisor/ProjectCommitter") {
  static readonly make: (endpoint: NativeEndpoint) => Effect.Effect<ProjectCommitter["Service"], never, NativeEnvelope> = makeProjectCommitter;
  static readonly layer = (endpoint: NativeEndpoint): Layer.Layer<ProjectCommitter, never, NativeEnvelope> => Layer.effect(ProjectCommitter, makeProjectCommitter(endpoint));
}
