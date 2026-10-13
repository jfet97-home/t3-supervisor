import WebSocket from "ws";

export type FileFailure = "missing" | "invalid_file" | "permission_required" | "unavailable";
export class ProjectFileError extends Error {
  constructor(readonly code: FileFailure) {
    super(code === "permission_required"
      ? "Enable filesystem:read on the Supervisor read credential through deployment setup."
      : code === "missing" ? "The requested project path does not exist."
        : code === "invalid_file" ? "Definitions must be readable UTF-8 text files, not binary files or directories."
        : "T3 project file access is unavailable.");
  }
}
export interface ProjectFiles {
  directoryExists(root: string, signal: AbortSignal): Promise<boolean>;
  list(root: string, path: string, signal: AbortSignal): Promise<{ entries: Array<{path: string; kind: "file" | "directory"}>; truncated: boolean }>;
  read(root: string, path: string, signal: AbortSignal): Promise<{contents: string; byteLength: number; truncated: boolean}>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validPath = (path: string): boolean => path.startsWith(".supervisor/") && !path.includes("\\") && !path.includes("\0") &&
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
export const makeProjectFiles = (baseUrl: string, token: string): ProjectFiles => {
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
          else finish(new ProjectFileError(failure(frame.exit)));
        }
      } catch {abort();}
    });
  });
  return {
    async directoryExists(root, signal) {
      const v = await rpc("filesystem.getMetadata", {paths: [root]}, signal);
      if (!record(v) || !Array.isArray(v.entries) || v.entries.length !== 1) throw new ProjectFileError("unavailable");
      return record(v.entries[0]) && v.entries[0].kind === "directory";
    },
    async list(root, path, signal) {
      if (path !== ".supervisor" && !validPath(path)) throw new ProjectFileError("unavailable");
      const v = await rpc("projects.listEntries", {cwd: root, directoryPath: path}, signal);
      if (!record(v) || typeof v.truncated !== "boolean" || !Array.isArray(v.entries) || v.entries.length > 512 ||
        !v.entries.every(e => record(e) && typeof e.path === "string" && (e.kind === "file" || e.kind === "directory"))) throw new ProjectFileError("unavailable");
      return v as unknown as Awaited<ReturnType<ProjectFiles["list"]>>;
    },
    async read(root, path, signal) {
      if (!validPath(path)) throw new ProjectFileError("unavailable");
      const v = await rpc("projects.readFile", {cwd: root, relativePath: path}, signal);
      if (!record(v) || typeof v.contents !== "string" || typeof v.byteLength !== "number" || !Number.isSafeInteger(v.byteLength) ||
        v.byteLength < 0 || typeof v.truncated !== "boolean") throw new ProjectFileError("unavailable");
      return v as unknown as Awaited<ReturnType<ProjectFiles["read"]>>;
    },
  };
};
