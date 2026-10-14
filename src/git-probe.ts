import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { posix } from "node:path";
import type { GuidanceStore } from "./guidance-store.js";
import type { FreshGitInfo, GitOperationState } from "./project-files.js";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PROBE_OUTPUT_BYTES = 768 * 1024;
const MAX_CHANGED_PATHS = 4096;
const MAX_CHANGED_PATH_BYTES = 4096;
const PROBE_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const PENDING_KEY = "native_git_probe_sessions";
const PROBE_PREFIX = "T3_SUPERVISOR_GIT_PROBE";

type SessionIds = {threadId: string; terminalId: string};
type ProbeResult = FreshGitInfo;
type RpcFrame = Record<string, unknown>;
type StreamState = {
  ready: Promise<Record<string, unknown>>;
  helperReady(): Promise<void>;
  result(): Promise<ProbeResult>;
  close(): void;
};

export class GitProbeError extends Error {
  constructor(message = "A fresh native Git probe failed.") {super(message);}
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const frameList = (value: unknown): unknown[] => Array.isArray(value) ? value.flat(4) : [value];

const payloadBytes = (data: WebSocket.RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map(part => Buffer.from(part)));
  return Buffer.from(data as ArrayBuffer);
};

const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

const pythonSource = String.raw`import base64, json, os, subprocess, sys
MAX_STATUS = 768 * 1024
MAX_PATHS = 4096
MAX_PATH = 4096
import selectors, time
root_arg = __T3_ROOT_EXPRESSION__
nonce = __T3_NONCE__
requested_root = os.path.abspath(root_arg)
root = os.path.realpath(requested_root)
env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
env["GIT_OPTIONAL_LOCKS"] = "0"

def git(args, cwd=root, limit=8192, timeout=5):
    command = ["git", "-C", cwd, "-c", "core.fsmonitor=false", "--no-optional-locks"] + args
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=timeout)
    if len(result.stdout) > limit:
        raise RuntimeError("git output limit")
    return result

def git_path(args, cwd=root):
    result = git(args, cwd=cwd, limit=4096)
    if result.returncode != 0:
        raise RuntimeError("git metadata unavailable")
    return os.path.realpath(os.path.join(cwd, os.fsdecode(result.stdout.rstrip(b"\r\n"))))

def operation_state(git_dir, common_dir, index_path, branch_ref):
    files = [
        (git_dir, "MERGE_HEAD"), (git_dir, "CHERRY_PICK_HEAD"), (git_dir, "REVERT_HEAD"),
        (git_dir, "REBASE_HEAD"), (git_dir, "BISECT_LOG"), (git_dir, "BISECT_START"),
        (git_dir, "SQUASH_MSG"), (git_dir, "AUTO_MERGE"), (git_dir, "HEAD.lock"),
        (os.path.dirname(index_path), os.path.basename(index_path) + ".lock"),
        (common_dir, "packed-refs.lock"), (common_dir, "config.lock"), (common_dir, "shallow.lock"),
    ]
    if branch_ref:
        files.append((common_dir, branch_ref + ".lock"))
    for directory, name in files:
        try:
            os.lstat(os.path.join(directory, name))
            return {"status": "in_progress", "marker": name}
        except FileNotFoundError:
            pass
    for name in ("rebase-merge", "rebase-apply", "sequencer"):
        try:
            os.lstat(os.path.join(git_dir, name))
            return {"status": "in_progress", "marker": name}
        except FileNotFoundError:
            pass
    return {"status": "safe"}

def changed_paths(raw):
    if len(raw) > MAX_STATUS:
        raise RuntimeError("git status output limit")
    fields = raw.split(b"\0")
    result = []
    index = 0
    while index < len(fields):
        entry = fields[index]
        index += 1
        if not entry:
            continue
        if len(entry) < 4 or entry[2:3] != b" ":
            raise RuntimeError("malformed git status")
        code, path = entry[:2], entry[3:]
        result.append(os.fsdecode(path))
        if b"R" in code or b"C" in code:
            if index >= len(fields) or not fields[index]:
                raise RuntimeError("malformed git rename status")
            result.append(os.fsdecode(fields[index]))
            index += 1
        if len(result) > MAX_PATHS or any(not item or len(os.fsencode(item)) > MAX_PATH for item in result):
            raise RuntimeError("git path limit")
    return result

def bounded_status():
    command = ["git", "-C", root, "-c", "core.fsmonitor=false", "--no-optional-locks",
               "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    if process.stdout is None:
        raise RuntimeError("git status output unavailable")
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    chunks = []
    total = 0
    deadline = time.monotonic() + 8
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("git status timed out")
            if not selector.select(remaining):
                if process.poll() is not None:
                    break
                continue
            chunk = os.read(process.stdout.fileno(), min(65536, MAX_STATUS + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_STATUS:
                raise RuntimeError("git status output limit")
            chunks.append(chunk)
        return_code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        if return_code != 0:
            raise RuntimeError("git status failed")
        return b"".join(chunks)
    except Exception:
        process.kill()
        process.wait(timeout=2)
        raise
    finally:
        selector.close()
        process.stdout.close()

def emit(value):
    encoded = base64.b64encode(json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("utf-8")).decode("ascii")
    sys.stdout.write("\nT3_SUPERVISOR_GIT_PROBE:" + nonce + ":" + encoded + "\n")
    sys.stdout.flush()

try:
    top = git(["rev-parse", "--show-toplevel"], limit=4096)
    if top.returncode != 0:
        emit({"ok": True, "workspaceRoot": requested_root, "branch": None, "isRepo": False, "changedPaths": [], "operationState": {"status": "safe"}})
        sys.exit(0)
    git_root = os.path.realpath(os.fsdecode(top.stdout.rstrip(b"\r\n")))
    if git_root != root:
        emit({"ok": True, "workspaceRoot": git_root, "branch": None, "isRepo": True, "changedPaths": [], "operationState": {"status": "safe"}})
        sys.exit(0)
    symbolic = git(["symbolic-ref", "--quiet", "HEAD"], limit=4096)
    if symbolic.returncode not in (0, 1):
        raise RuntimeError("git branch unavailable")
    branch_ref = os.fsdecode(symbolic.stdout.rstrip(b"\r\n")) if symbolic.returncode == 0 else None
    branch = branch_ref[len("refs/heads/"):] if branch_ref and branch_ref.startswith("refs/heads/") else None
    git_dir = git_path(["rev-parse", "--absolute-git-dir"])
    common_arg = git(["rev-parse", "--git-common-dir"], limit=4096)
    index_path = git_path(["rev-parse", "--git-path", "index"])
    if common_arg.returncode != 0:
        raise RuntimeError("git common directory unavailable")
    common_dir = os.path.realpath(os.path.join(root, os.fsdecode(common_arg.stdout.rstrip(b"\r\n"))))
    state = operation_state(git_dir, common_dir, index_path, branch_ref)
    if state["status"] != "safe":
        paths = []
    else:
        paths = changed_paths(bounded_status())
    emit({"ok": True, "workspaceRoot": requested_root, "branch": branch, "isRepo": True, "changedPaths": paths, "operationState": state})
except Exception:
    emit({"ok": False})
    sys.exit(1)
`;

const validateResult = (value: unknown): FreshGitInfo => {
  if (!record(value) || value.ok !== true || typeof value.workspaceRoot !== "string" ||
    !(value.branch === null || typeof value.branch === "string") || typeof value.isRepo !== "boolean" ||
    !Array.isArray(value.changedPaths) || value.changedPaths.length > MAX_CHANGED_PATHS ||
    !value.changedPaths.every(path => typeof path === "string" && path.length > 0 && path.length <= MAX_CHANGED_PATH_BYTES && !path.includes("\0")) ||
    !record(value.operationState)) throw new GitProbeError("The native Git probe returned an invalid result.");
  const state = value.operationState;
  let operationState: GitOperationState;
  if (state.status === "safe") operationState = {status: "safe"};
  else if (state.status === "in_progress" && typeof state.marker === "string" && state.marker.length > 0 && state.marker.length <= 256)
    operationState = {status: "in_progress", marker: state.marker};
  else if (state.status === "unavailable" && typeof state.message === "string" && state.message.length > 0 && state.message.length <= 512)
    operationState = {status: "unavailable", message: state.message};
  else throw new GitProbeError("The native Git probe returned an invalid operation state.");
  if (!posix.isAbsolute(value.workspaceRoot) || value.workspaceRoot.length > 4096 || value.workspaceRoot.includes("\0"))
    throw new GitProbeError("The native Git probe returned an invalid checkout path.");
  return {
    workspaceRoot: value.workspaceRoot,
    branch: value.branch as string | null,
    isRepo: value.isRepo,
    changedPaths: value.changedPaths as string[],
    operationState,
  };
};

const parseFrame = (data: WebSocket.RawData, binary: boolean): RpcFrame[] => {
  if (binary) throw new GitProbeError("T3 returned a binary terminal frame.");
  const bytes = payloadBytes(data);
  if (bytes.length > MAX_FRAME_BYTES) throw new GitProbeError("T3 returned an oversized terminal frame.");
  let decoded: unknown;
  try {decoded = JSON.parse(bytes.toString("utf8")) as unknown;}
  catch {throw new GitProbeError("T3 returned malformed terminal data.");}
  const frames = frameList(decoded);
  if (frames.length > 256 || !frames.every(record)) throw new GitProbeError("T3 returned an invalid terminal frame.");
  return frames as RpcFrame[];
};

const makeRpc = (baseUrl: string, token: string) => (tag: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new GitProbeError("The Git probe was canceled."));
    const url = new URL("/ws?orchestrationProtocol=2", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const requestId = "git-probe-" + randomUUID();
    const socket = new WebSocket(url, {headers: {Authorization: "Bearer " + token}, handshakeTimeout: RPC_TIMEOUT_MS, maxPayload: MAX_FRAME_BYTES});
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new GitProbeError("The Git probe RPC was canceled or timed out."));
    const timer = setTimeout(abort, RPC_TIMEOUT_MS);
    signal.addEventListener("abort", abort, {once: true});
    socket.on("error", abort);
    socket.on("close", abort);
    socket.on("open", () => {
      if (settled || signal.aborted) return abort();
      socket.send(JSON.stringify({_tag: "Request", id: requestId, tag, payload, headers: []}), error => {if (error) abort();});
    });
    socket.on("message", (data, binary) => {
      try {
        for (const frame of parseFrame(data, binary)) {
          if (frame._tag === "Ping") {socket.send(JSON.stringify({_tag: "Pong"}), error => {if (error) abort();});continue;}
          if (frame._tag !== "Exit" || frame.requestId !== requestId || !record(frame.exit)) continue;
          if (frame.exit._tag === "Success") finish(undefined, frame.exit.value);
          else finish(new GitProbeError("T3 rejected a terminal Git probe request."));
        }
      } catch (error) {finish(error instanceof Error ? error : new GitProbeError());}
    });
  });

const snapshotIsTarget = (snapshot: Record<string, unknown>, ids: SessionIds, root: string): boolean =>
  snapshot.threadId === ids.threadId && snapshot.terminalId === ids.terminalId && snapshot.cwd === root && snapshot.status === "running";

const makePythonSource = (root: string, nonce: string): string => {
  const encodedRoot = Buffer.from(root, "utf8").toString("base64");
  const rootExpression = encodedRoot.match(/.{1,400}/g)?.map(part => JSON.stringify(part)).join(" +\n    ") ?? '""';
  return pythonSource
    .replace("__T3_ROOT_EXPRESSION__", "os.fsdecode(base64.b64decode(\n    " + rootExpression + "\n))")
    .replace("__T3_NONCE__", JSON.stringify(nonce));
};

const makeBootstrap = (nonce: string): string => {
  const pythonCommand = "import sys;exec(compile(sys.stdin.read(),'t3-git-probe','exec'))";
  return "stty -echo; printf '\\nT3_SUPERVISOR_GIT_READY:" + nonce + "\\n'; exec /usr/bin/env python3 -c " + shellQuote(pythonCommand) + "\n";
};

const startAttachStream = (baseUrl: string, token: string, ids: SessionIds, root: string, nonce: string, signal: AbortSignal): StreamState => {
  const url = new URL("/ws?orchestrationProtocol=2", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const requestId = "git-probe-stream-" + randomUUID();
  const socket = new WebSocket(url, {headers: {Authorization: "Bearer " + token}, handshakeTimeout: RPC_TIMEOUT_MS, maxPayload: MAX_FRAME_BYTES});
  let readyResolve!: (snapshot: Record<string, unknown>) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {readyResolve = resolve;readyReject = reject;});
  let readySettled = false;
  let helperReadyResolve!: () => void;
  let helperReadyReject!: (error: Error) => void;
  const helperReady = new Promise<void>((resolve, reject) => {helperReadyResolve = resolve;helperReadyReject = reject;});
  let helperReadySettled = false;
  let helperReadyObserved = false;
  const helperReadyMarker = "T3_SUPERVISOR_GIT_READY:" + nonce;
  let snapshotToResolve: Record<string, unknown> | undefined;
  let capture = false;
  let capturePromise: Promise<ProbeResult> | undefined;
  let resolveCapture: ((result: ProbeResult) => void) | undefined;
  let rejectCapture: ((error: Error) => void) | undefined;
  let output = "";
  let packet: ProbeResult | undefined;
  let exit: {exitCode: number | null; exitSignal: number | null} | undefined;
  let priorExit = false;
  let streamFailure: Error | undefined;
  let closed = false;
  const fail = (error: Error) => {
    streamFailure ??= error;
    if (!readySettled) {readySettled = true;readyReject(error);}
    if (!helperReadySettled) {helperReadySettled = true;helperReadyReject(error);}
    rejectCapture?.(error);
  };
  const maybeFinish = () => {
    if (streamFailure) return rejectCapture?.(streamFailure);
    if (!packet || !exit) return;
    if (exit.exitCode !== 0 || exit.exitSignal !== null && exit.exitSignal !== 0) return fail(new GitProbeError("The Git probe process did not exit successfully."));
    resolveCapture?.(packet);
  };
  const acceptPacketLine = (line: string) => {
    const prefix = PROBE_PREFIX + ":" + nonce + ":";
    if (!line.startsWith(prefix)) return;
    const encoded = line.slice(prefix.length);
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return fail(new GitProbeError("The Git probe returned a malformed result frame."));
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded || decoded.length > MAX_PROBE_OUTPUT_BYTES) return fail(new GitProbeError("The Git probe returned an invalid result frame."));
    let value: unknown;
    try {value = JSON.parse(decoded.toString("utf8")) as unknown;}
    catch {return fail(new GitProbeError("The Git probe returned malformed result data."));}
    if (packet) return fail(new GitProbeError("The Git probe returned duplicate result frames."));
    try {packet = validateResult(value);}
    catch (error) {return fail(error instanceof Error ? error : new GitProbeError());}
  };
  const consumeOutput = (data: string) => {
    output += data;
    if (Buffer.byteLength(output, "utf8") > MAX_PROBE_OUTPUT_BYTES) return fail(new GitProbeError("The Git probe output exceeded its limit."));
    const lines = output.split(/\r?\n/);
    output = lines.pop() ?? "";
    for (const line of lines) {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!helperReadySettled && normalized === helperReadyMarker) helperReadyObserved = true;
      if (capture) acceptPacketLine(normalized);
    }
  };
  const abort = () => fail(new GitProbeError("The terminal Git probe was canceled or disconnected."));
  const timer = setTimeout(abort, PROBE_TIMEOUT_MS);
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    socket.terminate();
  };
  signal.addEventListener("abort", abort, {once: true});
  socket.on("error", abort);
  socket.on("close", () => {if (!closed && (!packet || !exit)) abort();});
  socket.on("open", () => {
    if (signal.aborted) return abort();
    socket.send(JSON.stringify({_tag: "Request", id: requestId, tag: "terminal.attach", payload: {
      threadId: ids.threadId, terminalId: ids.terminalId, cwd: root, worktreePath: null, restartIfNotRunning: false,
    }, headers: []}), error => {if (error) abort();});
  });
  socket.on("message", (data, binary) => {
    try {
      for (const frame of parseFrame(data, binary)) {
        if (frame._tag === "Ping") {socket.send(JSON.stringify({_tag: "Pong"}), error => {if (error) abort();});continue;}
        if (frame._tag === "Exit" && frame.requestId === requestId) {
          if (!record(frame.exit) || frame.exit._tag !== "Success") fail(new GitProbeError("T3 rejected the terminal attach request."));
          else if (!packet) abort();
          continue;
        }
        if (frame._tag !== "Chunk" || frame.requestId !== requestId || !Array.isArray(frame.values)) continue;
        for (const event of frame.values) {
          if (!record(event)) return abort();
          if (event.type === "snapshot" && record(event.snapshot)) {
            if (!snapshotIsTarget(event.snapshot, ids, root)) return fail(new GitProbeError("T3 attached the probe to an unexpected terminal."));
            if (!readySettled) snapshotToResolve = event.snapshot;
            continue;
          }
          if (event.threadId !== ids.threadId || event.terminalId !== ids.terminalId) continue;
          if (event.type === "output" && typeof event.data === "string") consumeOutput(event.data);
          else if (event.type === "exited" && (event.exitCode === null || Number.isInteger(event.exitCode)) &&
            (event.exitSignal === null || Number.isInteger(event.exitSignal))) {
            if (capture) exit = {exitCode: event.exitCode as number | null, exitSignal: event.exitSignal as number | null};
            else priorExit = true;
          } else if (event.type === "error") fail(new GitProbeError("The terminal Git probe reported an error."));
        }
        if (!closed && !streamFailure) {
          socket.send(JSON.stringify({_tag: "Ack", requestId}), error => {
            if (error) return abort();
            if (snapshotToResolve && !readySettled) {readySettled = true;readyResolve(snapshotToResolve);snapshotToResolve = undefined;}
            if (helperReadyObserved && !helperReadySettled) {helperReadySettled = true;helperReadyResolve();}
            maybeFinish();
          });
        }
      }
    } catch (error) {fail(error instanceof Error ? error : new GitProbeError());}
  });
  return {
    ready,
    helperReady: () => helperReady,
    result() {
      if (capturePromise) return capturePromise;
      capture = true;
      capturePromise = new Promise<ProbeResult>((resolve, reject) => {resolveCapture = resolve;rejectCapture = reject;});
      if (priorExit) rejectCapture?.(new GitProbeError("The probe terminal exited before the Git check started."));
      else if (streamFailure) rejectCapture?.(streamFailure);
      else maybeFinish();
      return capturePromise;
    },
    close,
  };
};

const validateRoot = (root: string): void => {
  if (!posix.isAbsolute(root) || root.length > 4096 || root.includes("\0") || root.includes("\\") || /[\r\n]/.test(root))
    throw new GitProbeError("The selected checkout path is invalid.");
};

const parsePending = (value: unknown): SessionIds[] => {
  if (value === undefined) return [];
  let parsed: unknown;
  try {parsed = JSON.parse(String(value)) as unknown;}
  catch {throw new GitProbeError("Pending native Git probe cleanup state is invalid.");}
  const generatedId = (id: unknown): id is string => typeof id === "string" &&
    /^t3-supervisor-git-probe-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
  if (!Array.isArray(parsed) || parsed.length > 128 || !parsed.every(item => record(item) &&
    generatedId(item.threadId) && generatedId(item.terminalId)))
    throw new GitProbeError("Pending native Git probe cleanup state is invalid.");
  return parsed as SessionIds[];
};

export const makeGitProbe = (baseUrl: string, token: string, store: GuidanceStore) => {
  const rpc = makeRpc(baseUrl, token);
  let queue = Promise.resolve();
  const serialize = <A>(work: () => Promise<A>): Promise<A> => {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const pending = (): SessionIds[] =>
    parsePending(store.db.prepare("SELECT value FROM meta WHERE key=?").get(PENDING_KEY)?.value);
  const savePending = (sessions: SessionIds[]): void => {
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(PENDING_KEY, JSON.stringify(sessions));
  };
  const addPending = (session: SessionIds): void => savePending([...pending(), session]);
  const removePending = (session: SessionIds): void =>
    savePending(pending().filter(item => item.threadId !== session.threadId || item.terminalId !== session.terminalId));
  const closeSession = async (session: SessionIds, signal: AbortSignal): Promise<void> => {
    await rpc("terminal.close", {threadId: session.threadId, terminalId: session.terminalId, deleteHistory: true}, signal);
    removePending(session);
  };
  const cleanupPending = async (signal: AbortSignal): Promise<void> => {
    const sessions = pending();
    let failed = false;
    for (const session of sessions) {
      try {await closeSession(session, signal);}
      catch {failed = true;}
    }
    if (failed) throw new GitProbeError("T3 could not clean up a previous Git probe terminal.");
  };
  const cleanup = (): Promise<void> => serialize(() => cleanupPending(AbortSignal.timeout(CLEANUP_TIMEOUT_MS)));
  const probe = (root: string, parentSignal: AbortSignal): Promise<FreshGitInfo> => serialize(async () => {
    if (parentSignal.aborted) throw new GitProbeError("The Git probe was canceled.");
    validateRoot(root);
    const deadline = AbortSignal.any([AbortSignal.timeout(PROBE_TIMEOUT_MS), parentSignal]);
    await cleanupPending(AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
    const ids: SessionIds = {
      threadId: "t3-supervisor-git-probe-" + randomUUID(),
      terminalId: "t3-supervisor-git-probe-" + randomUUID(),
    };
    addPending(ids);
    let stream: StreamState | undefined;
    let result: FreshGitInfo | undefined;
    let failure: unknown;
    try {
      const opened = await rpc("terminal.open", {
        threadId: ids.threadId,
        terminalId: ids.terminalId,
        cwd: root,
        worktreePath: null,
        cols: 1000,
        rows: 40,
        env: {HISTFILE: "/dev/null", TERM: "dumb", ZDOTDIR: "/nonexistent"},
      }, deadline);
      if (!record(opened) || !snapshotIsTarget(opened, ids, root)) throw new GitProbeError("T3 did not start the Git probe terminal in the selected checkout.");
      const nonce = randomBytes(16).toString("hex");
      stream = startAttachStream(baseUrl, token, ids, root, nonce, deadline);
      const attached = await stream.ready;
      if (!snapshotIsTarget(attached, ids, root)) throw new GitProbeError("T3 attached the Git probe to an unexpected terminal.");
      const bootstrap = makeBootstrap(nonce);
      if (bootstrap.length > 256) throw new GitProbeError("The Git probe bootstrap exceeded its input limit.");
      await rpc("terminal.write", {threadId: ids.threadId, terminalId: ids.terminalId, data: bootstrap}, deadline);
      await stream.helperReady();
      const completed = stream.result().then(
        value => ({ok: true as const, value}),
        error => ({ok: false as const, error}),
      );
      const helper = makePythonSource(root, nonce) + "\n\x04";
      if (helper.length > 32_000) throw new GitProbeError("The Git probe helper exceeded its input limit.");
      await rpc("terminal.write", {threadId: ids.threadId, terminalId: ids.terminalId, data: helper}, deadline);
      const completion = await completed;
      if (!completion.ok) throw completion.error;
      const probeResult = completion.value;
      if (probeResult.workspaceRoot !== posix.normalize(root)) throw new GitProbeError("The Git probe resolved a different checkout.");
      result = probeResult;
    } catch (error) {
      failure = error;
    } finally {
      stream?.close();
      try {await closeSession(ids, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));}
      catch (error) {failure ??= error;}
    }
    if (failure !== undefined) throw failure instanceof GitProbeError ? failure : new GitProbeError();
    if (!result) throw new GitProbeError();
    return result;
  });
  return {probe, cleanup};
};
