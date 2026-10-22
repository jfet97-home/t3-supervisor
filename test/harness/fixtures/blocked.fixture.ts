import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

// the grandchild ignores SIGTERM, so only the watchdog's SIGKILL escalation can remove it
const ignoresTerm = "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000); process.stdout.write('ready\\n');";

it("blocks its worker synchronously after starting a SIGTERM-ignoring child", async () => {
  const child = spawn(process.execPath, ["-e", ignoresTerm], { stdio: ["ignore", "pipe", "inherit"] });
  await once(child.stdout, "data");
  writeFileSync(join(process.env.HARNESS_MARKERS ?? "", "blocked.json"), JSON.stringify({ worker: process.pid, grandchild: child.pid }));
  for (;;) {
    // never yields: no timer, hook or finalizer in this worker can run again
  }
});
