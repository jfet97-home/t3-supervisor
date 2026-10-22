import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "vitest";
import { startFakeT3, type FakeT3, type FakeT3Options } from "./cli-fake-t3.js";
import { nodePath, repositoryRoot, startProcess, tsxLoader, type RunningProcess } from "./cli-process.js";
import { after } from "./node-test.js";

// scripts/probe-t3.ts in a real child process against a loopback fake T3; real providers are never configured

const probe = join(repositoryRoot, "scripts", "probe-t3.ts");

export const exitTimeoutMs = 30_000;

export const verifiedLine = (threads: number) =>
  `${JSON.stringify({ readOnly: true, activeSnapshot: true, archiveSnapshot: true, threads, verified: true, notificationsSent: 0 })}\n`;
export const failedLine = (activeSnapshot: boolean) =>
  `${JSON.stringify({ readOnly: true, activeSnapshot, archiveSnapshot: false, verified: false })}\n`;

export interface ProbeHarness {
  readonly fake: FakeT3;
  readonly token: string;
  readonly temporary: string;
  readonly env: NodeJS.ProcessEnv;
  start(env?: NodeJS.ProcessEnv): RunningProcess;
  // the probe's own mkdtemp directories under the redirected TMPDIR
  probeDirectories(): Promise<string[]>;
}

export const probeHarness = async (t: TestContext, options: Omit<FakeT3Options, "token"> & { readonly serverToken?: string } = {}): Promise<ProbeHarness> => {
  const root = await mkdtemp(join(tmpdir(), "cli-probe-"));
  const children: RunningProcess[] = [];
  const started: { fake?: FakeT3 } = {};
  after(t, async () => {
    try {
      for (const child of children) await child.dispose();
      await started.fake?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const token = randomBytes(32).toString("base64url");
  const tokenFile = join(root, "t3-read-token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const temporary = join(root, "tmp");
  await mkdir(temporary);
  const fake = await startFakeT3({ ...options, token: options.serverToken ?? token });
  started.fake = fake;
  const env: NodeJS.ProcessEnv = { PATH: nodePath(), HOME: root, TMPDIR: temporary, T3_URL: fake.baseUrl, T3_TOKEN_FILE: tokenFile };
  return {
    fake, token, temporary, env,
    start: (overrides = env) => {
      const child = startProcess(process.execPath, ["--import", tsxLoader, probe], { env: overrides, cwd: root });
      children.push(child);
      return child;
    },
    probeDirectories: async () => (await readdir(temporary)).filter((name) => name.startsWith("supervisor-t3-probe-")),
  };
};
