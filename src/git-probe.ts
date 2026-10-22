import { Context, Crypto, Data, Deferred, Effect, Exit, Layer, Schema, Semaphore } from "effect";
import { posix } from "node:path";
import type { GuidanceStore } from "./guidance-store.js";
import { NativeEnvelope, NativeFraming, nativeMaxPayload, NativeStep, type NativeEndpoint, type NativeEnvelopeError, type NativeExit } from "./native-envelope.js";
import type { FreshGitInfo, GitOperationState } from "./project-files.js";

const MAX_PROBE_OUTPUT_BYTES = 768 * 1024;
const MAX_CHANGED_PATHS = 4096;
const MAX_CHANGED_PATH_BYTES = 4096;
const PROBE_TIMEOUT = "15 seconds";
const RPC_TIMEOUT = "5 seconds";
const CLEANUP_TIMEOUT = "5 seconds";
const PENDING_KEY = "native_git_probe_sessions";
const PROBE_PREFIX = "T3_SUPERVISOR_GIT_PROBE";

type SessionIds = {threadId: string; terminalId: string};
type ProbeResult = FreshGitInfo;
type Cancel = Deferred.Deferred<void>;

export class GitProbeError extends Data.TaggedError("GitProbeError")<{readonly message: string}> {
  constructor(message = "A fresh native Git probe failed.") {super({message});}
}

const record = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

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

// the helper's result frame: the shape first, then its operation state, then its checkout path, each with its own fixed message
const ChangedPath = Schema.String.check(Schema.makeFilter((path: string) => path.length > 0 && path.length <= MAX_CHANGED_PATH_BYTES && !path.includes("\0")));
const ProbePacket = Schema.Struct({
  ok: Schema.Literal(true),
  workspaceRoot: Schema.String,
  branch: Schema.NullOr(Schema.String),
  isRepo: Schema.Boolean,
  changedPaths: Schema.Array(ChangedPath).check(Schema.makeFilter((paths: ReadonlyArray<string>) => paths.length <= MAX_CHANGED_PATHS)),
  operationState: Schema.Record(Schema.String, Schema.Unknown),
});
const Bounded = (max: number) => Schema.String.check(Schema.makeFilter((text: string) => text.length > 0 && text.length <= max));
const ProbeOperationState = Schema.Union([
  Schema.Struct({status: Schema.Literal("safe")}),
  Schema.Struct({status: Schema.Literal("in_progress"), marker: Bounded(256)}),
  Schema.Struct({status: Schema.Literal("unavailable"), message: Bounded(512)}),
]);
const isProbePacket = Schema.is(ProbePacket);
const isProbeOperationState = Schema.is(ProbeOperationState);

const validateResult = (value: unknown): FreshGitInfo => {
  if (!isProbePacket(value)) throw new GitProbeError("The native Git probe returned an invalid result.");
  const state = value.operationState;
  if (!isProbeOperationState(state)) throw new GitProbeError("The native Git probe returned an invalid operation state.");
  const operationState: GitOperationState = state.status === "safe" ? {status: "safe"}
    : state.status === "in_progress" ? {status: "in_progress", marker: state.marker} : {status: "unavailable", message: state.message};
  if (!posix.isAbsolute(value.workspaceRoot) || value.workspaceRoot.length > 4096 || value.workspaceRoot.includes("\0"))
    throw new GitProbeError("The native Git probe returned an invalid checkout path.");
  return {workspaceRoot: value.workspaceRoot, branch: value.branch, isRepo: value.isRepo, changedPaths: [...value.changedPaths], operationState};
};

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

const validateRoot = (root: string): Effect.Effect<void, GitProbeError> =>
  !posix.isAbsolute(root) || root.length > 4096 || root.includes("\0") || root.includes("\\") || /[\r\n]/.test(root)
    ? Effect.fail(new GitProbeError("The selected checkout path is invalid.")) : Effect.void;

// the pending probe sessions in the guidance metadata: at most 128 entries of generated ids
const GeneratedId = Schema.String.check(Schema.isPattern(/^t3-supervisor-git-probe-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
const PendingSessions = Schema.Array(Schema.Struct({threadId: GeneratedId, terminalId: GeneratedId}))
  .check(Schema.makeFilter((sessions: ReadonlyArray<unknown>) => sessions.length <= 128));
const isPendingSessions = Schema.is(PendingSessions);

// the stored entries themselves, so a rewrite keeps every stored byte of the remaining entries
const parsePending = (value: unknown): SessionIds[] => {
  if (value === undefined) return [];
  const parsed = decodeJson(String(value));
  if (parsed._tag === "None" || !isPendingSessions(parsed.value)) throw new GitProbeError("Pending native Git probe cleanup state is invalid.");
  return parsed.value as SessionIds[];
};

// envelope failures of a terminal rpc, with the baseline's fixed messages
const rpcFailure = (error: NativeEnvelopeError): GitProbeError => new GitProbeError(
  error.reason === "binary_frame" ? "T3 returned a binary terminal frame."
    : error.reason === "malformed_json" ? "T3 returned malformed terminal data."
      : error.reason === "invalid_frame" ? "T3 returned an invalid terminal frame." : "The Git probe RPC was canceled or timed out.");

interface AttachStream {
  // the attach snapshot, settled once its chunk was acknowledged
  readonly ready: Deferred.Deferred<Record<string, unknown>, GitProbeError>;
  // the standalone readiness line, settled once its chunk was acknowledged
  readonly helperReady: Deferred.Deferred<void, GitProbeError>;
  // starts capturing the helper's result frame and exit; result settles with the validated result of a successful exit
  readonly capture: Effect.Effect<void>;
  readonly result: Deferred.Deferred<ProbeResult, GitProbeError>;
}

const makeGitProbe = Effect.fnUntraced(function* (endpoint: NativeEndpoint, store: GuidanceStore) {
  const native = yield* NativeEnvelope;
  const crypto = yield* Crypto.Crypto;
  // v4 generation never fails; its signature only shares the platform error of randomBytes
  const uuid = Effect.orDie(crypto.randomUUIDv4());
  const nonce = Effect.map(Effect.orDie(crypto.randomBytes(16)), bytes => Buffer.from(bytes).toString("hex"));
  const lock = yield* Semaphore.make(1);

  const rpc = (tag: string, payload: Record<string, unknown>, cancel: Cancel | undefined): Effect.Effect<unknown, GitProbeError> => Effect.gen(function* () {
    if (cancel !== undefined && (yield* Deferred.isDone(cancel))) return yield* new GitProbeError("The Git probe was canceled.");
    const requestId = "git-probe-" + (yield* uuid);
    return yield* native.call({endpoint, request: {id: requestId, tag, payload}, maxPayload: nativeMaxPayload.probe, handshakeTimeout: RPC_TIMEOUT,
      timeout: RPC_TIMEOUT, framing: NativeFraming.flatChecked(4, 256), cancel,
      onExit: (exit: NativeExit) => exit._tag === "Malformed" ? Effect.succeed(NativeStep.continue)
        : exit._tag === "Success" ? Effect.succeed(NativeStep.done(exit.value)) : Effect.fail(new GitProbeError("T3 rejected a terminal Git probe request.")),
    }).pipe(Effect.catchTag("NativeEnvelopeError", error => Effect.fail(rpcFailure(error))));
  });

  // the attach stream runs in the caller's scope until the probe ends it; its chunks are handled in order, each in one synchronous step
  const attach = (ids: SessionIds, root: string, streamNonce: string, cancel: Cancel) => Effect.gen(function* () {
    const requestId = "git-probe-stream-" + (yield* uuid);
    const ready = yield* Deferred.make<Record<string, unknown>, GitProbeError>();
    const helperReady = yield* Deferred.make<void, GitProbeError>();
    const result = yield* Deferred.make<ProbeResult, GitProbeError>();
    const helperReadyMarker = "T3_SUPERVISOR_GIT_READY:" + streamNonce;
    let snapshotToResolve: Record<string, unknown> | undefined;
    let helperReadyObserved = false;
    let capturing = false;
    let output = "";
    let packet: ProbeResult | undefined;
    let exit: {exitCode: number | null; exitSignal: number | null} | undefined;
    let priorExit = false;
    let streamFailure: GitProbeError | undefined;
    const fail = (error: GitProbeError) => {
      streamFailure ??= error;
      Deferred.doneUnsafe(ready, Effect.fail(error));
      Deferred.doneUnsafe(helperReady, Effect.fail(error));
      if (capturing) Deferred.doneUnsafe(result, Effect.fail(error));
    };
    const abort = () => fail(new GitProbeError("The terminal Git probe was canceled or disconnected."));
    const maybeFinish = () => {
      if (streamFailure) {
        if (capturing) Deferred.doneUnsafe(result, Effect.fail(streamFailure));
        return;
      }
      if (!packet || !exit) return;
      if (exit.exitCode !== 0 || exit.exitSignal !== null && exit.exitSignal !== 0) return fail(new GitProbeError("The Git probe process did not exit successfully."));
      if (capturing) Deferred.doneUnsafe(result, Effect.succeed(packet));
    };
    const acceptPacketLine = (line: string) => {
      const prefix = PROBE_PREFIX + ":" + streamNonce + ":";
      if (!line.startsWith(prefix)) return;
      const encoded = line.slice(prefix.length);
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return fail(new GitProbeError("The Git probe returned a malformed result frame."));
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.toString("base64") !== encoded || decoded.length > MAX_PROBE_OUTPUT_BYTES) return fail(new GitProbeError("The Git probe returned an invalid result frame."));
      const value = decodeJson(decoded.toString("utf8"));
      if (value._tag === "None") return fail(new GitProbeError("The Git probe returned malformed result data."));
      if (packet) return fail(new GitProbeError("The Git probe returned duplicate result frames."));
      try {packet = validateResult(value.value);}
      catch (error) {return fail(error instanceof GitProbeError ? error : new GitProbeError());}
    };
    const consumeOutput = (data: string) => {
      output += data;
      if (Buffer.byteLength(output, "utf8") > MAX_PROBE_OUTPUT_BYTES) return fail(new GitProbeError("The Git probe output exceeded its limit."));
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? "";
      for (const line of lines) {
        const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!Deferred.isDoneUnsafe(helperReady) && normalized === helperReadyMarker) helperReadyObserved = true;
        if (capturing) acceptPacketLine(normalized);
      }
    };
    // readiness settles only after the chunk that carried it was acknowledged
    const acknowledged = Effect.sync(() => {
      if (snapshotToResolve && !Deferred.isDoneUnsafe(ready)) {
        Deferred.doneUnsafe(ready, Effect.succeed(snapshotToResolve));
        snapshotToResolve = undefined;
      }
      if (helperReadyObserved) Deferred.doneUnsafe(helperReady, Effect.void);
      maybeFinish();
    });
    // a non-record event or a foreign snapshot ends the attach stream at once, as the baseline stopped reading the message:
    // no later frame of it is handled, no Ack or Pong is written and no later exit can replace this first failure
    const onChunk = (values: ReadonlyArray<unknown>) => Effect.sync(() => {
      for (const event of values) {
        if (!record(event)) {
          abort();
          return NativeStep.done(undefined);
        }
        if (event.type === "snapshot" && record(event.snapshot)) {
          if (!snapshotIsTarget(event.snapshot, ids, root)) {
            fail(new GitProbeError("T3 attached the probe to an unexpected terminal."));
            return NativeStep.done(undefined);
          }
          if (!Deferred.isDoneUnsafe(ready)) snapshotToResolve = event.snapshot;
          continue;
        }
        if (event.threadId !== ids.threadId || event.terminalId !== ids.terminalId) continue;
        if (event.type === "output" && typeof event.data === "string") consumeOutput(event.data);
        else if (event.type === "exited" && (event.exitCode === null || Number.isInteger(event.exitCode)) &&
          (event.exitSignal === null || Number.isInteger(event.exitSignal))) {
          if (capturing) exit = {exitCode: event.exitCode as number | null, exitSignal: event.exitSignal as number | null};
          else priorExit = true;
        } else if (event.type === "error") fail(new GitProbeError("The terminal Git probe reported an error."));
      }
      return streamFailure ? NativeStep.continue : NativeStep.ack(acknowledged);
    });
    const onExit = (attachExit: NativeExit) => Effect.sync(() => {
      if (attachExit._tag !== "Success") fail(new GitProbeError("T3 rejected the terminal attach request."));
      else if (!packet) abort();
      return NativeStep.continue;
    });
    const stream = native.call({endpoint, request: {id: requestId, tag: "terminal.attach", payload: {
      threadId: ids.threadId, terminalId: ids.terminalId, cwd: root, worktreePath: null, restartIfNotRunning: false,
    }}, maxPayload: nativeMaxPayload.probe, handshakeTimeout: RPC_TIMEOUT, timeout: PROBE_TIMEOUT, framing: NativeFraming.flatChecked(4, 256), cancel, onChunk, onExit}).pipe(
      Effect.catch((error: NativeEnvelopeError) => Effect.sync(() => {
        if (error.reason === "binary_frame") fail(new GitProbeError("T3 returned a binary terminal frame."));
        else if (error.reason === "malformed_json") fail(new GitProbeError("T3 returned malformed terminal data."));
        else if (error.reason === "invalid_frame") fail(new GitProbeError("T3 returned an invalid terminal frame."));
        else if (error.reason !== "socket_closed" || !packet || !exit) abort();
      })));
    yield* Effect.forkScoped(stream);
    const capture = Effect.sync(() => {
      if (capturing) return;
      capturing = true;
      if (priorExit) Deferred.doneUnsafe(result, Effect.fail(new GitProbeError("The probe terminal exited before the Git check started.")));
      else if (streamFailure) Deferred.doneUnsafe(result, Effect.fail(streamFailure));
      else maybeFinish();
    });
    return {ready, helperReady, capture, result} satisfies AttachStream;
  });

  const pending = Effect.try({try: () => parsePending(store.db.prepare("SELECT value FROM meta WHERE key=?").get(PENDING_KEY)?.value),
    catch: error => error instanceof GitProbeError ? error : new GitProbeError()});
  const savePending = (sessions: SessionIds[]): void => {
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(PENDING_KEY, JSON.stringify(sessions));
  };
  // read, change and write the pending list in one synchronous step over the interim guidance store (b-02)
  const updatePending = (change: (sessions: SessionIds[]) => SessionIds[]) => Effect.try({
    try: () => savePending(change(parsePending(store.db.prepare("SELECT value FROM meta WHERE key=?").get(PENDING_KEY)?.value))),
    catch: error => error instanceof GitProbeError ? error : new GitProbeError(),
  });
  const addPending = (session: SessionIds) => updatePending(sessions => [...sessions, session]);
  const removePending = (session: SessionIds) =>
    updatePending(sessions => sessions.filter(item => item.threadId !== session.threadId || item.terminalId !== session.terminalId));
  const closeSession = (session: SessionIds, cancel: Cancel | undefined) =>
    rpc("terminal.close", {threadId: session.threadId, terminalId: session.terminalId, deleteHistory: true}, cancel).pipe(Effect.andThen(removePending(session)));
  // a cancel trigger completed after the duration or once the parent cancel completes, released with the caller's scope
  const deadline = (duration: typeof PROBE_TIMEOUT | typeof CLEANUP_TIMEOUT, parent?: Cancel) => Effect.gen(function* () {
    const expired = yield* Deferred.make<void>();
    const elapsed = parent === undefined ? Effect.sleep(duration) : Effect.raceFirst(Effect.sleep(duration), Deferred.await(parent));
    yield* Effect.forkScoped(Effect.andThen(elapsed, Deferred.succeed(expired, undefined)));
    return expired;
  });
  // every pending session is closed under one shared 5 s budget; any failure fails the cleanup after all were tried
  const cleanupPending = Effect.scoped(Effect.gen(function* () {
    const budget = yield* deadline(CLEANUP_TIMEOUT);
    const sessions = yield* pending;
    let failed = false;
    for (const session of sessions) if ((yield* Effect.result(closeSession(session, budget)))._tag === "Failure") failed = true;
    if (failed) return yield* new GitProbeError("T3 could not clean up a previous Git probe terminal.");
  }));

  const session = (ids: SessionIds, root: string, cancel: Cancel) => Effect.scoped(Effect.gen(function* () {
    const opened = yield* rpc("terminal.open", {
      threadId: ids.threadId,
      terminalId: ids.terminalId,
      cwd: root,
      worktreePath: null,
      cols: 1000,
      rows: 40,
      env: {HISTFILE: "/dev/null", TERM: "dumb", ZDOTDIR: "/nonexistent"},
    }, cancel);
    if (!record(opened) || !snapshotIsTarget(opened, ids, root)) return yield* new GitProbeError("T3 did not start the Git probe terminal in the selected checkout.");
    const streamNonce = yield* nonce;
    // the attach stream lives in this scope, so it ends before the session is closed
    const stream = yield* attach(ids, root, streamNonce, cancel);
    const attached = yield* Deferred.await(stream.ready);
    if (!snapshotIsTarget(attached, ids, root)) return yield* new GitProbeError("T3 attached the Git probe to an unexpected terminal.");
    const bootstrap = makeBootstrap(streamNonce);
    if (bootstrap.length > 256) return yield* new GitProbeError("The Git probe bootstrap exceeded its input limit.");
    yield* rpc("terminal.write", {threadId: ids.threadId, terminalId: ids.terminalId, data: bootstrap}, cancel);
    yield* Deferred.await(stream.helperReady);
    yield* stream.capture;
    const helper = makePythonSource(root, streamNonce) + "\n\x04";
    if (helper.length > 32_000) return yield* new GitProbeError("The Git probe helper exceeded its input limit.");
    yield* rpc("terminal.write", {threadId: ids.threadId, terminalId: ids.terminalId, data: helper}, cancel);
    const probeResult = yield* Deferred.await(stream.result);
    if (probeResult.workspaceRoot !== posix.normalize(root)) return yield* new GitProbeError("The Git probe resolved a different checkout.");
    return probeResult;
  }));

  const probeOnce = (root: string, parent: Cancel | undefined) => Effect.scoped(Effect.gen(function* () {
    if (parent !== undefined && (yield* Deferred.isDone(parent))) return yield* new GitProbeError("The Git probe was canceled.");
    yield* validateRoot(root);
    const probeDeadline = yield* deadline(PROBE_TIMEOUT, parent);
    yield* cleanupPending;
    const ids: SessionIds = {threadId: "t3-supervisor-git-probe-" + (yield* uuid), terminalId: "t3-supervisor-git-probe-" + (yield* uuid)};
    // the session is pending before T3 opens it and leaves the list only after T3 closed it with its history, even when the probe is interrupted
    return yield* Effect.uninterruptibleMask(restore => Effect.gen(function* () {
      yield* addPending(ids);
      const outcome = yield* Effect.exit(restore(session(ids, root, probeDeadline)));
      const closed = yield* Effect.exit(closeSession(ids, undefined));
      // the session's own failure is reported first; a failed close discards the result
      if (Exit.isFailure(outcome)) return yield* outcome;
      if (Exit.isFailure(closed)) return yield* Effect.failCause(closed.cause);
      return outcome.value;
    }));
  }));

  return GitProbe.of({
    probe: (root, cancel) => lock.withPermit(probeOnce(root, cancel)),
    cleanup: lock.withPermit(cleanupPending),
  });
});

// fresh git status from a disposable native T3 terminal running a python helper; probes and cleanups run one at a time
export class GitProbe extends Context.Service<GitProbe, {
  // closes pending sessions first; 15 s deadline; a completed cancel ends the probe as a failure after its terminal was closed
  readonly probe: (root: string, cancel?: Deferred.Deferred<void>) => Effect.Effect<FreshGitInfo, GitProbeError>;
  // closes every pending session left by an earlier process
  readonly cleanup: Effect.Effect<void, GitProbeError>;
}>()("t3-supervisor/GitProbe") {
  static readonly make: (endpoint: NativeEndpoint, store: GuidanceStore) => Effect.Effect<GitProbe["Service"], never, NativeEnvelope | Crypto.Crypto> = makeGitProbe;
  static readonly layer = (endpoint: NativeEndpoint, store: GuidanceStore): Layer.Layer<GitProbe, never, NativeEnvelope | Crypto.Crypto> =>
    Layer.effect(GitProbe, makeGitProbe(endpoint, store));
}

// the probe call shape the definitions take
export type FreshGitProbe = GitProbe["Service"]["probe"];
