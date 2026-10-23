import { spawn, type ChildProcess } from "node:child_process";
import { get } from "node:http";
import { connect, createServer } from "node:net";
import { Clock, Deferred, Duration, Effect, Exit, type Scope } from "effect";
import { groupAlive, type ProcessResult, type StartOptions } from "./cli-process.js";

// real child processes and loopback probes as scoped effects (test harness only). node's spawn stays the boundary: the
// suites read the raw exit code and signal, signal the leader alone, and check that no process of the child's own group
// outlives it, which a spawner that terminates the group on exit would hide. every child leads its own process group

// an effect bounded on the live clock, also inside a TestClock suite: once the duration passed the effect is interrupted
// and the bound dies with the message; without a duration the effect is unbounded
export const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>, milliseconds: number | undefined, message: () => string): Effect.Effect<A, E, R> =>
  milliseconds === undefined ? effect : Effect.raceFirst(effect, Effect.sleep(Duration.millis(milliseconds)).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
    Effect.andThen(Effect.suspend(() => Effect.die(new Error(message()))))));

export interface RunningProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  // the clock reading at spawn
  readonly startedAt: number;
  stdout(): string;
  stderr(): string;
  // completes as soon as the collected stdout satisfies `predicate`; an exit before that dies. without a bound it waits
  // as long as its caller does
  waitForStdout(predicate: (stdout: string) => boolean, timeoutMs: number | undefined, label: string): Effect.Effect<void>;
  // the result once the process exited and its stdio closed
  closed(timeoutMs?: number): Effect.Effect<ProcessResult>;
}

const outputLimit = 1024 * 1024;

// a child process for the caller's scope; the release sends SIGKILL to the whole group if anything is still alive and
// waits for the close
export const startProcess = (command: string, args: ReadonlyArray<string>, options: StartOptions): Effect.Effect<RunningProcess, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const child = spawn(command, args, { env: options.env, cwd: options.cwd, detached: true, stdio: [options.stdin ?? "ignore", "pipe", "pipe"] });
    const pid = child.pid;
    if (pid === undefined) return yield* Effect.die(new Error(`could not start ${command}`));
    const done = Deferred.makeUnsafe<ProcessResult>();
    let stdout = "";
    let stderr = "";
    let result: ProcessResult | undefined;
    const watchers = new Set<() => void>();
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < outputLimit) stdout += chunk;
      for (const watcher of [...watchers]) watcher();
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < outputLimit) stderr += chunk; });
    child.once("close", (code, signal) => {
      result = { code, signal, stdout, stderr };
      Deferred.doneUnsafe(done, Exit.succeed(result));
      for (const watcher of [...watchers]) watcher();
    });
    const closed = (timeoutMs?: number) => bounded(Deferred.await(done), timeoutMs, () => `process ${pid} did not exit within ${timeoutMs} ms`);
    const running: RunningProcess = {
      child, pid, startedAt,
      stdout: () => stdout,
      stderr: () => stderr,
      waitForStdout: (predicate, timeoutMs, label) => bounded(Effect.callback<void>((resume) => {
        const check = () => {
          if (predicate(stdout)) {
            watchers.delete(check);
            resume(Effect.void);
          } else if (result !== undefined) {
            watchers.delete(check);
            resume(Effect.die(new Error(`process ${pid} exited before ${label}`)));
          }
        };
        watchers.add(check);
        check();
        return Effect.sync(() => watchers.delete(check));
      }), timeoutMs, () => `no ${label} from process ${pid} within ${timeoutMs} ms`),
      closed,
    };
    return running;
  }), (running) => Effect.gen(function* () {
    if (groupAlive(running.pid)) process.kill(-running.pid, "SIGKILL");
    if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
    running.child.stdin?.destroy();
    yield* running.closed(10_000);
  }));

// a process run to its exit within the bound, then released
export const runProcess = (command: string, args: ReadonlyArray<string>, options: StartOptions & { readonly timeoutMs: number }): Effect.Effect<ProcessResult> =>
  Effect.scoped(Effect.flatMap(startProcess(command, args, options), (running) => running.closed(options.timeoutMs)));

// a port that was free a moment ago on the loopback interface
export const freePort: Effect.Effect<number> = Effect.callback<number>((resume) => {
  const server = createServer();
  server.once("error", (error) => resume(Effect.die(error)));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(port > 0 ? Effect.succeed(port) : Effect.die(new Error("no free port"))));
  });
});

// "refused" when nothing listens on the loopback port any more
export const portState = (port: number): Effect.Effect<"open" | "refused"> => Effect.callback<"open" | "refused">((resume) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => {
    socket.destroy();
    resume(Effect.succeed("open"));
  });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    socket.destroy();
    resume(error.code === "ECONNREFUSED" ? Effect.succeed("refused") : Effect.die(error));
  });
  return Effect.sync(() => socket.destroy());
});

// a tcp connect attempt; true when no listener accepts on the port
export const connectRefused = (port: number): Effect.Effect<boolean> => Effect.callback<boolean>((resume) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resume(Effect.succeed(false)); });
  socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); resume(Effect.succeed(error.code === "ECONNREFUSED")); });
  return Effect.sync(() => socket.destroy());
});

// one request on a fresh connection that is closed afterwards, so no pooled socket outlives the test
export const httpGet = (url: string, timeoutMs: number): Effect.Effect<{ status: number; body: string }, Error> =>
  Effect.callback<{ status: number; body: string }, Error>((resume) => {
    const request = get(url, { agent: false, headers: { connection: "close" }, timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
      response.once("end", () => resume(Effect.succeed({ status: response.statusCode ?? 0, body })));
      response.once("error", (error) => resume(Effect.fail(error)));
    });
    request.once("timeout", () => request.destroy(new Error(`${url} timed out`)));
    request.once("error", (error) => resume(Effect.fail(error)));
    return Effect.sync(() => request.destroy());
  });

// polls a child's http endpoint (no event exists for its readiness) until `accept` holds or the deadline passes
export const waitForHttp = (url: string, accept: (status: number, body: string) => boolean, timeoutMs: number,
  alive: () => boolean): Effect.Effect<{ status: number; body: string }> => Effect.gen(function* () {
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  let last = "no response";
  while ((yield* Clock.currentTimeMillis) < deadline) {
    if (!alive()) return yield* Effect.die(new Error(`process exited while waiting for ${url} (${last})`));
    const response = yield* Effect.option(httpGet(url, 2_000));
    if (response._tag === "Some") {
      last = `HTTP ${response.value.status}`;
      if (accept(response.value.status, response.value.body)) return response.value;
    } else {
      last = "connection failed";
    }
    yield* Effect.sleep("100 millis");
  }
  return yield* Effect.die(new Error(`${url} did not reach the expected state within ${timeoutMs} ms (${last})`));
});

// one event loop turn: every callback already queued has run before it completes
export const loopTurn: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const immediate = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(immediate));
});

// an explicit live-clock deadline for an awaited loopback event
export const within = <A, E, R>(effect: Effect.Effect<A, E, R>, milliseconds: number, label: string): Effect.Effect<A, E, R> =>
  bounded(effect, milliseconds, () => `timed out waiting for ${label}`);
