import { randomBytes } from "node:crypto";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { Clock, Context, Effect, FileSystem, Layer, Option, type Scope } from "effect";
import { shebang } from "./cli-bin.js";
import { startFakeT3, untilTraffic, type FakeT3 as NativeFakeT3, type FakeT3Options, type FakeT3Traffic } from "./cli-fake-t3.js";
import { nodePath, repositoryRoot, tsxLoader } from "./cli-process.js";
import { bounded, freePort, portState, runProcess, startProcess, waitForHttp, type RunningProcess } from "./g8-process.js";

// the supervisor, probe and installed bin harnesses of the process suites as scoped effects (test harness only): private
// temporary homes, token files and a loopback fake T3 (cli-fake-t3.ts, the native peer), each released with the caller's
// scope after the processes started in it

export interface FakeT3 {
  readonly baseUrl: string;
  readonly traffic: FakeT3Traffic;
  until(predicate: (traffic: FakeT3Traffic) => boolean, timeoutMs: number, label: string): Effect.Effect<void>;
}

// the loopback fake T3 for the caller's scope; its own deadline bounds `until`
export const fakeT3 = (options: FakeT3Options): Effect.Effect<FakeT3, never, Scope.Scope> =>
  Effect.map(Effect.acquireRelease(Effect.promise(() => startFakeT3(options)), (fake: NativeFakeT3) => Effect.promise(() => fake.close())),
    (fake) => ({
      baseUrl: fake.baseUrl,
      traffic: fake.traffic,
      until: (predicate, timeoutMs, label) => untilTraffic(fake, predicate, timeoutMs, label),
    }));

const temporaryHome = (prefix: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
});

const privateToken = (path: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const token = randomBytes(32).toString("base64url");
  yield* fs.writeFileString(path, `${token}\n`, { mode: 0o600 });
  return token;
});

// scripts/probe-t3.ts in a real child process against a loopback fake T3; real providers are never configured

const probe = join(repositoryRoot, "scripts", "probe-t3.ts");

export interface ProbeHarness {
  readonly fake: FakeT3;
  readonly token: string;
  readonly temporary: string;
  readonly env: NodeJS.ProcessEnv;
  // a probe process for the caller's scope
  start(env?: NodeJS.ProcessEnv): Effect.Effect<RunningProcess, never, Scope.Scope>;
  // the probe's own mkdtemp directories under the redirected TMPDIR
  readonly probeDirectories: Effect.Effect<string[]>;
}

export const probeHarness = (options: Omit<FakeT3Options, "token"> & { readonly serverToken?: string } = {}) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* temporaryHome("cli-probe-");
  const tokenFile = join(root, "t3-read-token");
  const token = yield* privateToken(tokenFile);
  const temporary = join(root, "tmp");
  yield* fs.makeDirectory(temporary);
  const fake = yield* fakeT3({ ...options, token: options.serverToken ?? token });
  const env: NodeJS.ProcessEnv = { PATH: nodePath(), HOME: root, TMPDIR: temporary, T3_URL: fake.baseUrl, T3_TOKEN_FILE: tokenFile };
  const harness: ProbeHarness = {
    fake, token, temporary, env,
    start: (overrides = env) => startProcess(process.execPath, ["--import", tsxLoader, probe], { env: overrides, cwd: root }),
    probeDirectories: Effect.map(Effect.orDie(fs.readDirectory(temporary)), (names) => names.filter((name) => name.startsWith("supervisor-t3-probe-"))),
  };
  return harness;
});

// a supervisor child process against a loopback fake T3, with private ports, token files and data directory

export interface SupervisorHarness {
  readonly home: string;
  readonly dataDirectory: string;
  readonly token: string;
  readonly tokenFile: string;
  readonly ports: { readonly health: number; readonly ui: number; readonly mcp: number };
  readonly fake: FakeT3;
  readonly env: NodeJS.ProcessEnv;
  // a supervisor process for the caller's scope
  start(command: string, args: ReadonlyArray<string>): Effect.Effect<RunningProcess, never, Scope.Scope>;
}

export const supervisorHarness = (fakeOptions: Omit<FakeT3Options, "token"> = {}) => Effect.gen(function* () {
  const home = yield* temporaryHome("cli-supervisor-");
  const tokenFile = join(home, "t3-read-token");
  const token = yield* privateToken(tokenFile);
  const fake = yield* fakeT3({ token, ...fakeOptions });
  const ports = { health: yield* freePort, ui: yield* freePort, mcp: yield* freePort };
  const dataDirectory = join(home, "data");
  const absent = join(home, "absent-token");
  const env: NodeJS.ProcessEnv = {
    PATH: nodePath(), HOME: home, TMPDIR: home, XDG_STATE_HOME: join(home, "state"),
    DATA_DIRECTORY: dataDirectory, T3_URL: fake.baseUrl, T3_TOKEN_FILE: tokenFile,
    HEALTH_PORT: String(ports.health), UI_PORT: String(ports.ui), UI_HOST: "127.0.0.1",
    WORKFLOW_MCP_BIND_HOST: "127.0.0.1", WORKFLOW_MCP_PORT: String(ports.mcp),
    T3_GUIDANCE_TOKEN_FILE: absent, T3_PROJECT_WRITE_TOKEN_FILE: absent, T3_PROJECT_COMMIT_TOKEN_FILE: absent, T3_GIT_PROBE_TOKEN_FILE: absent,
  };
  const harness: SupervisorHarness = {
    home, dataDirectory, token, tokenFile, ports, fake, env,
    start: (command, args) => startProcess(command, args, { env, cwd: home }),
  };
  return harness;
});

const alive = (child: RunningProcess) => () => child.child.exitCode === null && child.child.signalCode === null;

export const readyTimeoutMs = 30_000;

// /health 200: activation, T3 connection, catalog and supervision all ready
export const waitUntilReady = (harness: SupervisorHarness, child: RunningProcess) =>
  waitForHttp(`http://127.0.0.1:${harness.ports.health}/health`, (status) => status === 200, readyTimeoutMs, alive(child));

// health served while the descriptor is refused: the catalog store is open and the descriptor retry is pending
export const waitUntilDescriptorRetry = (harness: SupervisorHarness, child: RunningProcess) => Effect.gen(function* () {
  yield* harness.fake.until((traffic) => traffic.http.includes("GET /.well-known/t3/environment"), readyTimeoutMs, "a descriptor request");
  return yield* waitForHttp(`http://127.0.0.1:${harness.ports.health}/health`, (status, body) =>
    status === 503 && (JSON.parse(body) as { lastErrorPhase?: unknown }).lastErrorPhase === "t3_authentication", readyTimeoutMs, alive(child));
});

export const listenerStates = (harness: SupervisorHarness) => Effect.gen(function* () {
  return {
    health: yield* portState(harness.ports.health),
    ui: yield* portState(harness.ports.ui),
    mcp: yield* portState(harness.ports.mcp),
  };
});

// relative paths under the data directory, sorted
export const dataFiles = (harness: SupervisorHarness) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.readDirectory(harness.dataDirectory, { recursive: true }).pipe(
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed([])),
    Effect.orDie,
  )).sort();
});

// reopens every database read-write after exit and reports PRAGMA quick_check
export const quickChecks = (harness: SupervisorHarness, databases: ReadonlyArray<string>): Record<string, unknown> =>
  Object.fromEntries(databases.map((name) => {
    const database = new DatabaseSync(join(harness.dataDirectory, name));
    try {
      return [name, (database.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined)?.quick_check];
    } finally {
      database.close();
    }
  }));

// the built dist/cli.js and an installed bin from the packed tarball, prepared once for the suite that needs them

export class InstalledBin extends Context.Service<InstalledBin, {
  // dist/cli.js of this checkout, built by this run
  readonly builtCli: string;
  // the pnpm-generated bin link in a temporary global prefix
  readonly installedBin: string;
  readonly packageDirectory: string;
  readonly root: string;
}>()("test/g8/InstalledBin") {}

const stepTimeoutMs = 90_000;

// keep the shared package store, without inheriting the test command's project-specific npm_config_* values
const pnpmEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? tmpdir() };
  for (const key of ["PNPM_HOME", "XDG_DATA_HOME", "npm_config_store_dir"] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
};

const step = (label: string, command: string, args: ReadonlyArray<string>, cwd: string, env: NodeJS.ProcessEnv) =>
  Effect.flatMap(runProcess(command, args, { cwd, env, timeoutMs: stepTimeoutMs }), (result) => result.code === 0 ? Effect.void
    : Effect.die(new Error(`${label} failed (exit ${String(result.code)} ${String(result.signal)}): ${result.stderr.slice(-2_000)}`)));

// the layer's release removes the temporary root within the 30 s teardown bound of the baseline afterAll (vitest's
// hookTimeout); the layer's own hook bound covers the 120 s build, and this bound expires first on teardown
export const installedBinTeardownMs = 30_000;

// build, pack and an offline install of the packed package; the temporary root is removed with the layer
export const installedBinLayer: Layer.Layer<InstalledBin, never, FileSystem.FileSystem> = Layer.effect(InstalledBin, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* Effect.acquireRelease(Effect.orDie(fs.makeTempDirectory({ prefix: "cli-bin-install-" })), (root) =>
    bounded(Effect.orDie(fs.remove(root, { recursive: true })), installedBinTeardownMs,
      () => `the installed bin teardown did not finish within ${installedBinTeardownMs} ms`));
  const builtCli = join(repositoryRoot, "dist", "cli.js");
  const buildStarted = yield* Clock.currentTimeMillis;
  // the server half of `pnpm build`; the ui bundle is not part of these cases
  yield* step("tsc build", process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    repositoryRoot, { PATH: process.env.PATH ?? "" });
  // guard: a stale or foreign dist must not be exercised
  const built = yield* Effect.orDie(fs.stat(builtCli));
  if (Option.match(built.mtime, { onNone: () => true, onSome: (mtime) => mtime.getTime() < buildStarted - 2_000 })) {
    return yield* Effect.die(new Error("dist/cli.js was not rewritten by this build"));
  }
  const firstLine = new TextDecoder().decode(yield* Effect.orDie(fs.readFile(builtCli))).split("\n")[0] ?? "";
  if (firstLine !== shebang) return yield* Effect.die(new Error("dist/cli.js lost its shebang"));
  const pnpm = pnpmEnvironment();
  yield* step("pnpm pack", "pnpm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", root], repositoryRoot, pnpm);
  yield* step("tar extract", "tar", ["-xzf", join(root, "t3-supervisor-0.1.0.tgz"), "-C", root], root, pnpm);
  const packageDirectory = join(root, "package");
  // the tarball carries no lockfile; the baseline one keeps the installed dependency set identical to this checkout
  for (const name of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    yield* Effect.orDie(fs.copyFile(join(repositoryRoot, name), join(packageDirectory, name)));
  }
  yield* step("pnpm install", "pnpm", ["install", "--frozen-lockfile", "--prod", "--offline", "--ignore-scripts"], packageDirectory, pnpm);
  const prefix = join(root, "prefix");
  const binDirectory = join(prefix, "bin");
  yield* Effect.orDie(fs.makeDirectory(binDirectory, { recursive: true }));
  yield* step("pnpm global bin", "pnpm", ["add", "--global", ".", "--offline", "--ignore-scripts"], packageDirectory,
    { ...pnpm, PNPM_HOME: prefix, PATH: `${binDirectory}${delimiter}${pnpm.PATH}` });
  return { builtCli, installedBin: join(binDirectory, "t3-supervisor"), packageDirectory, root };
}));
