import { copyFile, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, runProcess } from "./cli-process.js";

// the built dist/cli.js and an installed bin from the packed tarball, prepared once per run of the file that needs them

export interface InstalledBin {
  // dist/cli.js of this checkout, built by this run
  readonly builtCli: string;
  // the npm-generated bin link in a temporary global prefix
  readonly installedBin: string;
  readonly packageDirectory: string;
  readonly root: string;
}

const stepTimeoutMs = 90_000;

// nested npm must not inherit npm_config_* from `npm test` (a local_prefix would point it at this checkout)
const npmEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? tmpdir() };
  if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;
  return env;
};

const step = async (label: string, command: string, args: ReadonlyArray<string>, cwd: string, env: NodeJS.ProcessEnv): Promise<void> => {
  const result = await runProcess(command, args, { cwd, env, timeoutMs: stepTimeoutMs });
  if (result.code !== 0) throw new Error(`${label} failed (exit ${String(result.code)} ${String(result.signal)}): ${result.stderr.slice(-2_000)}`);
};

const firstLine = async (path: string): Promise<string> => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
  } finally {
    await handle.close();
  }
};

export const shebang = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning";

export const prepareInstalledBin = async (): Promise<InstalledBin> => {
  const root = await mkdtemp(join(tmpdir(), "cli-bin-install-"));
  try {
    const builtCli = join(repositoryRoot, "dist", "cli.js");
    const buildStarted = Date.now();
    // the server half of `npm run build`; the ui bundle is not part of these cases
    await step("tsc build", process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
      repositoryRoot, { PATH: process.env.PATH ?? "" });
    // guard: a stale or foreign dist must not be exercised
    if ((await stat(builtCli)).mtimeMs < buildStarted - 2_000) throw new Error("dist/cli.js was not rewritten by this build");
    if (await firstLine(builtCli) !== shebang) throw new Error("dist/cli.js lost its shebang");
    const npm = npmEnvironment();
    await step("npm pack", "npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", root], repositoryRoot, npm);
    await step("tar extract", "tar", ["-xzf", join(root, "t3-supervisor-0.1.0.tgz"), "-C", root], root, npm);
    const packageDirectory = join(root, "package");
    // the tarball carries no lockfile; the baseline one keeps the installed dependency set identical to this checkout
    await copyFile(join(repositoryRoot, "package-lock.json"), join(packageDirectory, "package-lock.json"));
    await step("npm ci", "npm", ["ci", "--prefix", packageDirectory, "--omit=dev", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      packageDirectory, npm);
    const prefix = join(root, "prefix");
    await step("npm install", "npm", ["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", packageDirectory],
      root, npm);
    return { builtCli, installedBin: join(prefix, "bin", "t3-supervisor"), packageDirectory, root };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};
