import { NodeChildProcessSpawner, NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node";
import { Console, Deferred, Duration, Effect, Exit, Layer, Runtime } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

// outer watchdog (plan 5.3 rule 4): vitest runs in its own process group; on expiry the group gets SIGTERM, SIGKILL after the grace, exit 124

const defaultDeadline = Duration.minutes(20);
const killGrace = Duration.seconds(10);
const deadlineExitCode = 124;
const deadlineOption = "--watchdog-deadline-ms=";
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type ForwardedSignal = (typeof forwardedSignals)[number];

type Outcome =
  | { readonly _tag: "Exited"; readonly code: number }
  | { readonly _tag: "Crashed"; readonly message: string }
  | { readonly _tag: "Signalled"; readonly signal: ForwardedSignal }
  | { readonly _tag: "Expired" };

// read by the teardown, because an interrupted program has no success value to carry the exit code
const received: { signal: ForwardedSignal | undefined; expired: boolean } = { signal: undefined, expired: false };

const signalExitCode = (signal: ForwardedSignal): number => 128 + constants.signals[signal];

const vitestEntry = fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json")));

const usageExitCode = 2;

const parseArguments = (argv: ReadonlyArray<string>): { readonly deadline: Duration.Duration; readonly forwarded: ReadonlyArray<string> } | string => {
  let deadline = defaultDeadline;
  const forwarded: string[] = [];
  for (const argument of argv) {
    if (!argument.startsWith(deadlineOption)) {
      forwarded.push(argument);
      continue;
    }
    const millis = Number(argument.slice(deadlineOption.length));
    if (!Number.isSafeInteger(millis) || millis <= 0) return `watchdog: ${argument} must be a positive integer`;
    deadline = Duration.millis(millis);
  }
  return { deadline, forwarded };
};

// prepended so the signal is recorded before NodeRuntime.runMain interrupts the program
const listenForSignals = (signal: Deferred.Deferred<ForwardedSignal>) => Effect.acquireRelease(
  Effect.sync(() => forwardedSignals.map((name) => {
    const listener = () => {
      received.signal ??= name;
      Deferred.doneUnsafe(signal, Exit.succeed(name));
    };
    process.prependListener(name, listener);
    return { name, listener };
  })),
  (listeners) => Effect.sync(() => {
    for (const { name, listener } of listeners) process.removeListener(name, listener);
  }),
);

const program = Effect.gen(function* () {
  const parsed = parseArguments(process.argv.slice(2));
  if (typeof parsed === "string") {
    yield* Console.error(parsed);
    return usageExitCode;
  }
  const { deadline, forwarded } = parsed;
  const signal = yield* Deferred.make<ForwardedSignal>();
  yield* listenForSignals(signal);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // detached makes vitest a process-group leader; the spawner's finalizer terminates the whole group
  const vitest = yield* spawner.spawn(ChildProcess.make(process.execPath, [vitestEntry, "run", ...forwarded], {
    detached: true,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    killSignal: "SIGTERM",
    forceKillAfter: killGrace,
  }));
  const group = vitest.pid;
  yield* Console.error(`watchdog: vitest pid ${vitest.pid} leads process group ${group}; deadline ${Duration.toMillis(deadline)} ms`);
  const terminate = (name: ForwardedSignal) => vitest.kill({ killSignal: name, forceKillAfter: killGrace }).pipe(
    Effect.catch((error) => Console.error(`watchdog: signalling process group ${group} failed: ${error.message}`)),
    Effect.uninterruptible,
  );
  const outcome = yield* Effect.raceAll<Effect.Effect<Outcome>>([
    vitest.exitCode.pipe(
      Effect.map((code): Outcome => ({ _tag: "Exited", code })),
      Effect.catch((error) => Effect.succeed<Outcome>({ _tag: "Crashed", message: error.message })),
    ),
    Deferred.await(signal).pipe(Effect.map((name): Outcome => ({ _tag: "Signalled", signal: name }))),
    Effect.sleep(deadline).pipe(Effect.as<Outcome>({ _tag: "Expired" })),
  ]).pipe(Effect.onInterrupt(() => terminate(received.signal ?? "SIGTERM")));
  switch (outcome._tag) {
    case "Exited":
      return outcome.code;
    case "Crashed":
      yield* Console.error(`watchdog: vitest ended abnormally: ${outcome.message}`);
      return 1;
    case "Signalled":
      yield* terminate(outcome.signal);
      return signalExitCode(outcome.signal);
    case "Expired":
      received.expired = true;
      yield* Console.error(`watchdog: test run exceeded ${Duration.toMillis(deadline)} ms; terminating process group ${group} (SIGTERM, SIGKILL after ${Duration.toMillis(killGrace)} ms)`);
      yield* terminate("SIGTERM");
      return deadlineExitCode;
  }
});

const services = NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(services)), {
  teardown: (exit, onExit) => {
    if (received.expired) return onExit(deadlineExitCode);
    if (received.signal !== undefined) return onExit(signalExitCode(received.signal));
    if (Exit.isSuccess(exit) && typeof exit.value === "number") return onExit(exit.value);
    Runtime.defaultTeardown(exit, onExit);
  },
});
