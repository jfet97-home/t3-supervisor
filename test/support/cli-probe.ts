import type { FakeT3 } from "./cli-fake-t3.js";
import type { RunningProcess } from "./cli-process.js";

// scripts/probe-t3.ts in a real child process against a loopback fake T3; real providers are never configured

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
