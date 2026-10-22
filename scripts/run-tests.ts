import { NodeChildProcessSpawner, NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node";
import { Clock, Console, Deferred, Duration, Effect, Exit, Fiber, FileSystem, Layer, Runtime } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { constants } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCLI } from "vitest/node";

// outer watchdog (plan 5.3 rule 4): one process owns the whole test run. it runs the declared phases
// (`--watchdog-phase=<name>:<config>`, in order) or one plain `vitest run`, each vitest in its own process group,
// under one whole-run deadline: on expiry the active group gets SIGTERM, SIGKILL after the grace, no later phase
// starts, exit 124. caller arguments are parsed once with vitest's own parser and routed to the phases

const defaultDeadline = Duration.minutes(20);
const killGrace = Duration.seconds(10);
const deadlineExitCode = 124;
const usageExitCode = 2;
const deadlineOption = "--watchdog-deadline-ms=";
const phaseOption = "--watchdog-phase=";
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type ForwardedSignal = (typeof forwardedSignals)[number];

interface Phase {
  readonly name: string;
  readonly config: string;
}

type Outcome =
  | { readonly _tag: "Exited"; readonly code: number }
  | { readonly _tag: "Crashed"; readonly message: string }
  | { readonly _tag: "Signalled"; readonly signal: ForwardedSignal }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "Usage"; readonly message: string };

type PhaseStatus = "passed" | "failed" | "crashed" | "signalled" | "expired" | "not run";

interface PhaseRecord {
  readonly phase: string;
  readonly config: string;
  status: PhaseStatus;
  exitCode?: number;
  readonly report: string | undefined;
}

// read by the teardown, because an interrupted program has no success value to carry the exit code
const received: { signal: ForwardedSignal | undefined; expired: boolean } = { signal: undefined, expired: false };

const signalExitCode = (signal: ForwardedSignal): number => 128 + constants.signals[signal];

const vitestEntry = fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json")));

const parseRunnerArguments = (argv: ReadonlyArray<string>) => {
  let deadline = defaultDeadline;
  const phases: Phase[] = [];
  const forwarded: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith(deadlineOption)) {
      const millis = Number(argument.slice(deadlineOption.length));
      if (!Number.isSafeInteger(millis) || millis <= 0) return `watchdog: ${argument} must be a positive integer`;
      deadline = Duration.millis(millis);
    } else if (argument.startsWith(phaseOption)) {
      const [name = "", config = ""] = argument.slice(phaseOption.length).split(/:(.*)/s);
      if (!/^[a-z0-9-]+$/.test(name) || config === "") return `watchdog: ${argument} must be <name>:<config>`;
      if (phases.some((phase) => phase.name === name)) return `watchdog: phase ${name} is declared twice`;
      phases.push({ name, config });
    } else {
      forwarded.push(argument);
    }
  }
  return { deadline, phases, forwarded };
};

type Parsed = ReturnType<typeof parseCLI>;

const parseVitest = (tokens: ReadonlyArray<string>): Parsed | string => {
  try {
    return parseCLI(["vitest", "run", ...tokens]);
  } catch (error) {
    return `watchdog: ${error instanceof Error ? error.message : String(error)}`;
  }
};

// file filters leave the option tokens; vitest's parser must read the remainder as the same options and no filter
const separateFilters = (tokens: ReadonlyArray<string>, parsed: Parsed): ReadonlyArray<string> | string => {
  const pending = [...parsed.filter];
  const options = tokens.filter((token) => {
    const index = pending.indexOf(token);
    if (index === -1) return true;
    pending.splice(index, 1);
    return false;
  });
  const reparsed = parseVitest(options);
  if (typeof reparsed === "string" || reparsed.filter.length > 0 || JSON.stringify(reparsed.options) !== JSON.stringify(parsed.options)) {
    return "watchdog: file filters cannot be told apart from option values; select one configuration with --config";
  }
  return options;
};

// vitest's location filter: a trailing `:<line>` (cli-api.De07GUeT.js:10230)
const locationFilter = /^(.*):(\d+)$/s;

const filterFile = (filter: string): string => locationFilter.exec(filter)?.[1] ?? filter;

// one report file per phase next to the requested one: report.json -> report.<phase>.json
const phasePath = (path: string, phase: string): string => {
  const extension = extname(path);
  return `${path.slice(0, path.length - extension.length)}.${phase}${extension}`;
};

const outputFileOption = /^(--outputFile(?:\.[^=]+)?)(?:=(.*))?$/s;

const rewriteOutputFiles = (options: ReadonlyArray<string>, phase: string): ReadonlyArray<string> => {
  const rewritten: string[] = [];
  for (let index = 0; index < options.length; index++) {
    const token = options[index] ?? "";
    const match = outputFileOption.exec(token);
    if (match === null) {
      rewritten.push(token);
    } else if (match[2] !== undefined) {
      rewritten.push(`${match[1]}=${phasePath(match[2], phase)}`);
    } else {
      const value = options[index + 1];
      rewritten.push(token);
      if (value !== undefined) rewritten.push(phasePath(value, phase));
      index++;
    }
  }
  return rewritten;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// vitest json reports of disjoint phases: counts add up, results concatenate, the run starts at the earliest start
const mergeValue = (left: unknown, right: unknown, key: string): unknown => {
  if (typeof left === "number" && typeof right === "number") return key === "startTime" ? Math.min(left, right) : left + right;
  if (typeof left === "boolean" && typeof right === "boolean") return key === "success" ? left && right : left || right;
  if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
  if (isRecord(left) && isRecord(right)) {
    const merged: Record<string, unknown> = { ...left };
    for (const [field, value] of Object.entries(right)) merged[field] = field in left ? mergeValue(left[field], value, field) : value;
    return merged;
  }
  return right;
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
  const runner = parseRunnerArguments(process.argv.slice(2));
  if (typeof runner === "string") {
    yield* Console.error(runner);
    return usageExitCode;
  }
  const { deadline, phases, forwarded } = runner;
  const deadlineMs = Duration.toMillis(deadline);
  const signal = yield* Deferred.make<ForwardedSignal>();
  yield* listenForSignals(signal);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-run-" });
  const startedAt = yield* Clock.monotonicTimeNanos;
  const run: { group: number | undefined; records: PhaseRecord[]; combined: string | undefined } = { group: undefined, records: [], combined: undefined };

  const remainingMs = Effect.map(Clock.monotonicTimeNanos, (now) => Math.max(0, deadlineMs - Math.round(Number(now - startedAt) / 1e6)));

  // one vitest process; detached makes it a process-group leader and the spawner's finalizer terminates the group
  const runVitest = (label: string, args: ReadonlyArray<string>, stdout: "inherit" | "ignore") => Effect.scoped(Effect.gen(function* () {
    const vitest = yield* spawner.spawn(ChildProcess.make(process.execPath, [vitestEntry, ...args], {
      detached: true,
      stdin: "ignore",
      stdout,
      stderr: "inherit",
      killSignal: "SIGTERM",
      forceKillAfter: killGrace,
    }));
    const group = vitest.pid;
    run.group = group;
    yield* Console.error(`watchdog: ${label}vitest pid ${vitest.pid} leads process group ${group}; ${yield* remainingMs} of ${deadlineMs} ms remain: vitest ${args.join(" ")}`);
    const terminate = (name: ForwardedSignal) => vitest.kill({ killSignal: name, forceKillAfter: killGrace }).pipe(
      Effect.catch((error) => Console.error(`watchdog: signalling process group ${group} failed: ${error.message}`)),
      Effect.uninterruptible,
    );
    return yield* vitest.exitCode.pipe(
      Effect.map((code): Outcome => ({ _tag: "Exited", code })),
      Effect.catch((error) => Effect.succeed<Outcome>({ _tag: "Crashed", message: error.message })),
      Effect.onInterrupt(() => terminate(received.signal ?? "SIGTERM")),
      Effect.ensuring(Effect.sync(() => { run.group = undefined; })),
    );
  }).pipe(Effect.catch((error) => Effect.succeed<Outcome>({ _tag: "Crashed", message: error.message }))));

  // the files each phase selects, by vitest's own filter matching (`vitest list --filesOnly`)
  const listFiles = (phase: Phase, filters: ReadonlyArray<string>) => Effect.gen(function* () {
    const listing = join(scratch, `${phase.name}.files.json`);
    const outcome = yield* runVitest(`phase ${phase.name} files: `, ["list", "--filesOnly", `--json=${listing}`, "--config", phase.config, ...new Set(filters.map(filterFile))], "ignore");
    if (outcome._tag !== "Exited" || outcome.code !== 0) return outcome;
    const files: unknown = JSON.parse(yield* fs.readFileString(listing).pipe(Effect.orDie));
    return new Set(Array.isArray(files) ? files.flatMap((entry) => isRecord(entry) && typeof entry.file === "string" ? [entry.file] : []) : []);
  });

  const runPhases = Effect.gen(function* () {
    const single = (args: ReadonlyArray<string>, label = "") => runVitest(label, ["run", ...args], "inherit");
    if (phases.length === 0) return yield* single(forwarded);
    const parsed = parseVitest(forwarded);
    if (typeof parsed === "string") return { _tag: "Usage", message: parsed } satisfies Outcome;
    // an explicit configuration is one intentional vitest run with the caller's arguments
    if (parsed.options.config !== undefined) return yield* single(forwarded);
    if (parsed.options.project !== undefined) return { _tag: "Usage", message: "watchdog: --project selects within one configuration; add --config <file>" } satisfies Outcome;
    const options = separateFilters(forwarded, parsed);
    if (typeof options === "string") return { _tag: "Usage", message: options } satisfies Outcome;
    const filters = parsed.filter;
    const selected: Array<{ readonly phase: Phase; readonly filters: ReadonlyArray<string> }> = [];
    for (const phase of phases) {
      if (filters.length === 0) {
        selected.push({ phase, filters });
        continue;
      }
      const files = yield* listFiles(phase, filters);
      if (!(files instanceof Set)) return files;
      if (files.size === 0) continue;
      // a location filter goes only to the phase that owns its file; vitest rejects it anywhere else
      selected.push({ phase, filters: filters.filter((filter) => !locationFilter.test(filter) || files.has(resolve(filterFile(filter)))) });
    }
    // nothing selected anywhere: vitest reports the empty selection itself
    const [first] = phases;
    if (selected.length === 0 && first !== undefined) return yield* single(["--config", first.config, ...forwarded], `phase ${first.name}: `);
    if (selected.length === 1) {
      const [{ phase, filters: own }] = selected as [typeof selected[number]];
      return yield* single(["--config", phase.config, ...options, ...own], `phase ${phase.name}: `);
    }
    // several phases: every report goes to its own file; json reports also combine into the requested one
    const reporters = parsed.options.reporter ?? [];
    const outputFile: unknown = parsed.options.outputFile;
    const jsonTarget = typeof outputFile === "string" ? outputFile : isRecord(outputFile) && typeof outputFile.json === "string" ? outputFile.json : undefined;
    if (reporters.includes("json") && jsonTarget === undefined) {
      return { _tag: "Usage", message: "watchdog: --reporter=json over several phases needs --outputFile=<path> (or --outputFile.json=<path>)" } satisfies Outcome;
    }
    const combine = reporters.includes("json") ? jsonTarget : undefined;
    run.combined = combine;
    run.records = selected.map(({ phase }) => ({ phase: phase.name, config: phase.config, status: "not run", report: combine === undefined ? undefined : phasePath(combine, phase.name) }));
    for (const [index, { phase, filters: own }] of selected.entries()) {
      const record = run.records[index];
      if (record === undefined) continue;
      const outcome = yield* single(["--config", phase.config, ...rewriteOutputFiles(options, phase.name), ...own], `phase ${phase.name}: `);
      record.status = outcome._tag === "Exited" ? (outcome.code === 0 ? "passed" : "failed") : outcome._tag === "Crashed" ? "crashed" : "not run";
      if (outcome._tag === "Exited") record.exitCode = outcome.code;
      if (outcome._tag !== "Exited" || outcome.code !== 0) return outcome;
    }
    return { _tag: "Exited", code: 0 } satisfies Outcome;
  });

  const markActive = (status: PhaseStatus) => {
    const active = run.records.find((record) => record.status === "not run");
    if (active !== undefined && run.group !== undefined) active.status = status;
  };

  const phaseFiber = yield* Effect.forkChild(runPhases);
  const outcome = yield* Effect.raceAll<Effect.Effect<Outcome>>([
    Fiber.join(phaseFiber),
    Deferred.await(signal).pipe(Effect.map((name): Outcome => ({ _tag: "Signalled", signal: name }))),
    Effect.sleep(deadline).pipe(Effect.as<Outcome>({ _tag: "Expired" })),
  ]).pipe(Effect.onInterrupt(() => Fiber.interrupt(phaseFiber)));

  if (outcome._tag === "Expired") {
    received.expired = true;
    markActive("expired");
    yield* Console.error(run.group === undefined
      ? `watchdog: test run exceeded ${deadlineMs} ms; no further phase starts`
      : `watchdog: test run exceeded ${deadlineMs} ms; terminating process group ${run.group} (SIGTERM, SIGKILL after ${Duration.toMillis(killGrace)} ms); no further phase starts`);
  }
  if (outcome._tag === "Signalled") markActive("signalled");
  // the active vitest group is terminated (or already gone) before the result is reported
  if (outcome._tag === "Expired" || outcome._tag === "Signalled") yield* Fiber.interrupt(phaseFiber);

  if (run.combined !== undefined) {
    const reports: unknown[] = [];
    for (const record of run.records) {
      if (record.report === undefined || !(yield* fs.exists(record.report).pipe(Effect.orElseSucceed(() => false)))) continue;
      const report = yield* fs.readFileString(record.report).pipe(Effect.map((text): unknown => JSON.parse(text)), Effect.orElseSucceed(() => undefined));
      if (isRecord(report)) reports.push(report);
    }
    const merged = reports.reduce<unknown>((left, right) => mergeValue(left, right, ""), {});
    const complete = run.records.every((record) => record.status === "passed");
    yield* fs.writeFileString(run.combined, `${JSON.stringify({ ...(isRecord(merged) ? merged : {}), success: complete && (!isRecord(merged) || merged.success !== false), phases: run.records }, null, 2)}\n`);
    yield* Console.error(`watchdog: combined json report ${run.combined} from ${run.records.map((record) => `${record.phase} (${record.status})`).join(", ")}`);
  }

  switch (outcome._tag) {
    case "Exited":
      return outcome.code;
    case "Crashed":
      yield* Console.error(`watchdog: vitest ended abnormally: ${outcome.message}`);
      return 1;
    case "Usage":
      yield* Console.error(outcome.message);
      return usageExitCode;
    case "Signalled":
      return signalExitCode(outcome.signal);
    case "Expired":
      return deadlineExitCode;
  }
});

const services = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(services)), {
  teardown: (exit, onExit) => {
    if (received.expired) return onExit(deadlineExitCode);
    if (received.signal !== undefined) return onExit(signalExitCode(received.signal));
    if (Exit.isSuccess(exit) && typeof exit.value === "number") return onExit(exit.value);
    Runtime.defaultTeardown(exit, onExit);
  },
});
