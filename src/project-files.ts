import WebSocket from "ws";
import { posix } from "node:path";

export type FileFailure = "missing" | "invalid_file" | "permission_required" | "unavailable";
export type GitOperationState = {status: "safe"} | {status: "in_progress"; marker: string} | {status: "unavailable"; message: string};
export interface FreshGitInfo {
  workspaceRoot: string;
  branch: string | null;
  isRepo: boolean;
  changedPaths: string[];
  operationState: GitOperationState;
}
export type FreshGitProbe = (root: string, signal: AbortSignal) => Promise<FreshGitInfo>;
export class ProjectFileError extends Error {
  constructor(readonly code: FileFailure, scope: "read" | "write" = "read") {
    super(code === "permission_required"
      ? `Enable filesystem:${scope} on the Supervisor ${scope} credential through deployment setup.`
      : code === "missing" ? "The requested project path does not exist."
        : code === "invalid_file" ? "Definitions must be readable UTF-8 text files, not binary files or directories."
        : "T3 project file access is unavailable.");
  }
}
export interface ProjectFiles {
  directoryExists(root: string, signal: AbortSignal): Promise<boolean>;
  list(root: string, path: string, signal: AbortSignal): Promise<{ entries: Array<{path: string; kind: "file" | "directory"}>; truncated: boolean }>;
  read(root: string, path: string, signal: AbortSignal): Promise<{contents: string; byteLength: number; truncated: boolean}>;
  vcsInfo?(root: string, signal: AbortSignal): Promise<{isRepo: boolean; branch: string | null; changedPaths?: string[]}>;
  gitOperationState?(root: string, signal: AbortSignal): Promise<GitOperationState>;
}
export interface ProjectWriter {
  checkProjectConfigFile(root: string, signal: AbortSignal): Promise<boolean>;
  writeProjectConfig(root: string, contents: string, signal: AbortSignal): Promise<void>;
  writeFile?(root: string, path: string, contents: string, signal: AbortSignal): Promise<void>;
}
export interface ProjectCommitter {
  commitFiles(root: string, paths: readonly string[], message: string, actionId: string, signal: AbortSignal): Promise<{status: "committed" | "uncertain"; commitSha?: string}>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
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

/** Uses native T3 read RPCs; it never reads project content from the container filesystem. */
const makeProjectRpc = (baseUrl: string, token: string, scope: "read" | "write" = "read") => {
  const rpc = (tag: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProjectFileError("unavailable"));
    const url = new URL("/ws?orchestrationProtocol=2", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {headers: {Authorization: `Bearer ${token}`}, handshakeTimeout: 5000, maxPayload: 2 * 1024 * 1024});
    let settled = false;
    const finish = (error?: ProjectFileError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      ws.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new ProjectFileError("unavailable"));
    const timer = setTimeout(abort, 10_000);
    signal.addEventListener("abort", abort, {once: true});
    ws.on("error", abort);
    ws.on("close", abort);
    ws.on("open", () => {
      if (settled || signal.aborted) return abort();
      ws.send(JSON.stringify({_tag: "Request", id: "definitions", tag, payload, headers: []}), error => {if (error) abort();});
    });
    ws.on("message", (data, binary) => {
      if (binary) return abort();
      try {
        const decoded: unknown = JSON.parse(data.toString());
        const frames: unknown[] = Array.isArray(decoded) ? decoded.flat(4) : [decoded];
        for (const frame of frames) {
          if (!record(frame)) return abort();
          if (frame._tag === "Ping") {ws.send(JSON.stringify({_tag: "Pong"}), error => {if (error) abort();}); continue;}
          if (frame._tag !== "Exit" || frame.requestId !== "definitions") continue;
          if (!record(frame.exit)) return abort();
          if (frame.exit._tag === "Success") finish(undefined, frame.exit.value);
          else finish(new ProjectFileError(failure(frame.exit), scope));
        }
      } catch {abort();}
    });
  });
  return rpc;
};

const makeProjectStreamSnapshotRpc = (baseUrl: string, token: string) =>
  (tag: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProjectFileError("unavailable"));
    const url = new URL("/ws?orchestrationProtocol=2", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {headers: {Authorization: `Bearer ${token}`}, handshakeTimeout: 5000, maxPayload: 2 * 1024 * 1024});
    let settled = false;
    const finish = (error?: ProjectFileError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      ws.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new ProjectFileError("unavailable"));
    const timer = setTimeout(abort, 10_000);
    signal.addEventListener("abort", abort, {once: true});
    ws.on("error", abort);
    ws.on("close", abort);
    ws.on("open", () => {
      if (settled || signal.aborted) return abort();
      ws.send(JSON.stringify({_tag: "Request", id: "definition-vcs-snapshot", tag, payload, headers: []}), error => {if (error) abort();});
    });
    ws.on("message", (data, binary) => {
      if (binary) return abort();
      try {
        const decoded: unknown = JSON.parse(data.toString());
        const frames: unknown[] = Array.isArray(decoded) ? decoded.flat(4) : [decoded];
        for (const frame of frames) {
          if (!record(frame)) return abort();
          if (frame._tag === "Ping") {ws.send(JSON.stringify({_tag: "Pong"}), error => {if (error) abort();});continue;}
          if (frame._tag === "Chunk" && frame.requestId === "definition-vcs-snapshot" && Array.isArray(frame.values)) {
            const event = frame.values.find(value => record(value) && (value._tag === "snapshot" || value._tag === "localUpdated" || value.type === "snapshot" || value.type === "localUpdated"));
            if (record(event) && record(event.local)) return finish(undefined, event.local);
            continue;
          }
          if (frame._tag !== "Exit" || frame.requestId !== "definition-vcs-snapshot") continue;
          if (!record(frame.exit)) return abort();
          if (frame.exit._tag === "Failure") finish(new ProjectFileError(failure(frame.exit)));
          else finish(new ProjectFileError("unavailable"));
        }
      } catch {abort();}
    });
  });

export const makeProjectWriter = (baseUrl: string, token: string): ProjectWriter => {
  const rpc = makeProjectRpc(baseUrl, token, "write");
  const writeFile = async (root: string, path: string, contents: string, signal: AbortSignal) => {
    if (!validPath(path)) throw new ProjectFileError("unavailable", "write");
    const result = await rpc("projects.writeFile", {cwd: root, relativePath: path, contents}, signal);
    if (!record(result) || result.relativePath !== path) throw new ProjectFileError("unavailable", "write");
  };
  const checkProjectConfigFile = async (root: string, signal: AbortSignal) => {
    const rootEntries = await rpc("projects.listEntries", {cwd: root, directoryPath: ""}, signal);
    const includes = (value: unknown, path: string, kind: string) => record(value) && value.truncated === false && Array.isArray(value.entries) &&
      value.entries.some(e => record(e) && e.path === path && e.kind === kind);
    if (!includes(rootEntries, ".t3-supervisor", "directory")) return false;
    const folder = await rpc("projects.listEntries", {cwd: root, directoryPath: ".t3-supervisor"}, signal);
    return Boolean(includes(folder, ".t3-supervisor/project.yaml", "file"));
  };
  return {checkProjectConfigFile, async writeProjectConfig(root, contents, signal) {
    await writeFile(root, ".t3-supervisor/project.yaml", contents, signal);
  }, writeFile};
};

export const makeProjectFiles = (baseUrl: string, token: string): ProjectFiles => {
  const rpc = makeProjectRpc(baseUrl, token);
  const readNativeFile = async (root: string, path: string, signal: AbortSignal) => {
    if (path.length > 512 || path.includes("\0") || path.includes("\\")) throw new ProjectFileError("unavailable");
    const value = await rpc("projects.readFile", {cwd: root, relativePath: path}, signal);
    if (!record(value) || typeof value.contents !== "string" || typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 0 || typeof value.truncated !== "boolean") throw new ProjectFileError("unavailable");
    return value as {contents: string; byteLength: number; truncated: boolean};
  };
  return {
    async directoryExists(root, signal) {
      const v = await rpc("filesystem.getMetadata", {paths: [root]}, signal);
      if (!record(v) || !Array.isArray(v.entries) || v.entries.length !== 1) throw new ProjectFileError("unavailable");
      return record(v.entries[0]) && v.entries[0].kind === "directory";
    },
    async list(root, path, signal) {
      if (path !== "" && path !== ".t3-supervisor" && !validPath(path)) throw new ProjectFileError("unavailable");
      const v = await rpc("projects.listEntries", {cwd: root, directoryPath: path}, signal);
      if (!record(v) || typeof v.truncated !== "boolean" || !Array.isArray(v.entries) || v.entries.length > 512 ||
        !v.entries.every(e => record(e) && typeof e.path === "string" && (e.kind === "file" || e.kind === "directory"))) throw new ProjectFileError("unavailable");
      return v as unknown as Awaited<ReturnType<ProjectFiles["list"]>>;
    },
    async read(root, path, signal) {
      if (!validPath(path)) throw new ProjectFileError("unavailable");
      return readNativeFile(root, path, signal);
    },
    async vcsInfo(root, signal) {
      const v = await rpc("vcs.listRefs", {cwd: root, refKind: "local", limit: 200}, signal);
      if (!record(v) || typeof v.isRepo !== "boolean" || !Array.isArray(v.refs) ||
        !v.refs.every(ref => record(ref) && typeof ref.current === "boolean" && typeof ref.name === "string"))
        throw new ProjectFileError("unavailable");
      const current = v.refs.filter((ref): ref is Record<string, unknown> => record(ref) && ref.current === true);
      if (current.length > 1) throw new ProjectFileError("unavailable");
      if (!v.isRepo) return {isRepo: false, branch: null, changedPaths: []};
      const status = await makeProjectStreamSnapshotRpc(baseUrl, token)("subscribeVcsStatus", {cwd: root, includeRemote: false}, signal);
      if (!record(status) || typeof status.isRepo !== "boolean" || !record(status.workingTree) || !Array.isArray(status.workingTree.files) ||
        !status.workingTree.files.every(entry => record(entry) && typeof entry.path === "string")) throw new ProjectFileError("unavailable");
      return {isRepo: true, branch: current[0] ? String(current[0].name) : null, changedPaths: status.workingTree.files.map(entry => String((entry as Record<string, unknown>).path))};
    },
    async gitOperationState(root, signal): Promise<GitOperationState> {
      if (!posix.isAbsolute(root)) return {status: "unavailable", message: "T3 requires an absolute checkout path to inspect Git state."};
      const metadataPath = posix.join(root, ".git");
      if (metadataPath.length > 512) return {status: "unavailable", message: "The checkout path is too long to inspect Git state safely."};
      const metadata = await rpc("filesystem.getMetadata", {paths: [metadataPath]}, signal);
      if (!record(metadata) || !Array.isArray(metadata.entries) || metadata.entries.length !== 1 || !record(metadata.entries[0]) ||
        (metadata.entries[0].kind !== "directory" && metadata.entries[0].kind !== "file"))
        return {status: "unavailable", message: "T3 could not identify this checkout's Git metadata directory."};
      let readGitFile: (path: string) => Promise<{contents: string; byteLength: number; truncated: boolean}>;
      if (metadata.entries[0].kind === "directory") readGitFile = path => readNativeFile(root, `.git/${path}`, signal);
      else {
        let pointer: Awaited<ReturnType<typeof readNativeFile>>;
        try {pointer = await readNativeFile(root, ".git", signal);}
        catch {return {status: "unavailable", message: "T3 could not read this checkout's Git directory pointer."};}
        if (pointer.truncated || pointer.byteLength > 4096) return {status: "unavailable", message: "This checkout's Git directory pointer is incomplete."};
        const match = /^gitdir:[ \t]*(.+?)[ \t]*\r?\n?$/.exec(pointer.contents);
        if (!match || !match[1] || match[1].includes("\0") || match[1].includes("\\"))
          return {status: "unavailable", message: "This checkout has an unsupported Git directory pointer."};
        const gitDirectory = posix.isAbsolute(match[1]) ? posix.normalize(match[1]) : posix.resolve(root, match[1]);
        if (!posix.isAbsolute(gitDirectory) || gitDirectory.length > 512) return {status: "unavailable", message: "This checkout's Git directory path is invalid or too long."};
        const gitDirectoryMetadata = await rpc("filesystem.getMetadata", {paths: [gitDirectory]}, signal);
        if (!record(gitDirectoryMetadata) || !Array.isArray(gitDirectoryMetadata.entries) || gitDirectoryMetadata.entries.length !== 1 ||
          !record(gitDirectoryMetadata.entries[0]) || gitDirectoryMetadata.entries[0].kind !== "directory")
          return {status: "unavailable", message: "T3 could not verify this checkout's Git metadata directory."};
        // linked worktrees store private metadata outside the checkout; inspect only fixed filenames read from the native pointer.
        readGitFile = path => readNativeFile(root, posix.join(gitDirectory, path), signal);
      }
      try {
        const head = await readGitFile("HEAD");
        if (head.truncated || head.byteLength > 4096) return {status: "unavailable", message: "T3 could not verify the checkout's Git HEAD file."};
      } catch {
        return {status: "unavailable", message: "T3 could not verify the checkout's Git HEAD file."};
      }
      const operationFiles = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_LOG", "BISECT_START", "SQUASH_MSG", "AUTO_MERGE", "index.lock", "HEAD.lock", "packed-refs.lock", "config.lock"];
      const operationDirectories = ["rebase-merge", "rebase-apply", "sequencer"];
      for (const marker of operationFiles) {
        try {await readGitFile(marker);return {status: "in_progress", marker};}
        catch (error) {
          if (error instanceof ProjectFileError && error.code === "missing") continue;
          return {status: "unavailable", message: "T3 could not verify the checkout's Git operation state."};
        }
      }
      for (const marker of operationDirectories) {
        try {await readGitFile(marker);return {status: "in_progress", marker};}
        catch (error) {
          if (error instanceof ProjectFileError && error.code === "missing") continue;
          if (error instanceof ProjectFileError && error.code === "invalid_file") return {status: "in_progress", marker};
          return {status: "unavailable", message: "T3 could not verify the checkout's Git operation state."};
        }
      }
      return {status: "safe"};
    },
  };
};

export const makeProjectCommitter = (baseUrl: string, token: string): ProjectCommitter => {
  const rpc = (payload: Record<string, unknown>, signal: AbortSignal): Promise<{status: "committed" | "uncertain"; commitSha?: string}> => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProjectFileError("unavailable", "write"));
    const url = new URL("/ws?orchestrationProtocol=2", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {headers: {Authorization: `Bearer ${token}`}, handshakeTimeout: 5000, maxPayload: 2 * 1024 * 1024});
    let settled = false;
    let actionResult: unknown;
    let actionFailed = false;
    let actionFinished = false;
    let disconnected = false;
    const finish = (error?: ProjectFileError, value?: {status: "committed" | "uncertain"; commitSha?: string}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      ws.terminate();
      if (error) reject(error); else resolve(value ?? {status: "uncertain"});
    };
    const abort = () => {disconnected = true;finish(undefined, {status: "uncertain"});};
    const timer = setTimeout(abort, 30_000);
    signal.addEventListener("abort", abort, {once: true});
    ws.on("error", abort);
    ws.on("close", abort);
    ws.on("open", () => {
      if (settled || signal.aborted) return abort();
      ws.send(JSON.stringify({_tag: "Request", id: "definition-setup-commit", tag: "git.runStackedAction", payload, headers: []}), error => {if (error) abort();});
    });
    ws.on("message", (data, binary) => {
      if (binary) return abort();
      try {
        const decoded: unknown = JSON.parse(data.toString());
        const frames: unknown[] = Array.isArray(decoded) ? decoded.flat(4) : [decoded];
        for (const frame of frames) {
          if (!record(frame)) return abort();
          if (frame._tag === "Ping") {ws.send(JSON.stringify({_tag: "Pong"}), error => {if (error) abort();}); continue;}
          if (frame._tag === "Chunk" && frame.requestId === "definition-setup-commit" && Array.isArray(frame.values)) {
            for (const event of frame.values) {
              if (!record(event)) return abort();
              if (event.actionId !== payload.actionId) continue;
              if (event.kind === "action_failed") actionFailed = true;
              if (event.kind === "action_finished") {actionFinished = true;actionResult = event.result;}
            }
            ws.send(JSON.stringify({_tag: "Ack", requestId: "definition-setup-commit"}), error => {if (error) abort();});
            continue;
          }
          if (frame._tag !== "Exit" || frame.requestId !== "definition-setup-commit") continue;
          if (!record(frame.exit)) return abort();
          if (frame.exit._tag === "Failure") {
            if (failure(frame.exit) === "permission_required") finish(new ProjectFileError("permission_required", "write"));
            else if (actionFinished || actionFailed || disconnected) finish(undefined, {status: "uncertain"});
            else finish(new ProjectFileError("unavailable", "write"));
            continue;
          }
          if (frame.exit._tag !== "Success") return abort();
          if (actionFailed || !actionFinished || !record(actionResult) || !record(actionResult.commit) ||
            actionResult.commit.status !== "created" || typeof actionResult.commit.commitSha !== "string") {
            finish(new ProjectFileError("unavailable", "write"));
          } else finish(undefined, {status: "committed", commitSha: actionResult.commit.commitSha});
        }
      } catch {abort();}
    });
  });
  return {async commitFiles(root, paths, message, actionId, signal) {
    if (!paths.length || !paths.every(validPath)) throw new ProjectFileError("unavailable", "write");
    return rpc({actionId, cwd: root, action: "commit", commitMessage: message, filePaths: [...paths]}, signal);
  }};
};
