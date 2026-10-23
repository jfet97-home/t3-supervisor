// scripts/probe-t3.ts in a real child process against a loopback fake T3; real providers are never configured

export const exitTimeoutMs = 30_000;

export const verifiedLine = (threads: number) =>
  `${JSON.stringify({ readOnly: true, activeSnapshot: true, archiveSnapshot: true, threads, verified: true, notificationsSent: 0 })}\n`;
export const failedLine = (activeSnapshot: boolean) =>
  `${JSON.stringify({ readOnly: true, activeSnapshot, archiveSnapshot: false, verified: false })}\n`;
