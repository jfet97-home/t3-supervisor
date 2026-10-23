import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { renderRolloutScan, rolloutScan } from "../src/rollout-scan.js";

// the read-only rollout scan of a supervisor data directory:
//   node --import tsx scripts/rollout-scan.ts <data-directory> [--json]
// it opens guidance.sqlite3 and thread-settings.sqlite3 read only, writes nothing and never contacts T3; the report names each
// table, row kind and key of a row the stores would not read as stored, never its content. Exit 0: nothing blocks the run;
// exit 2: a row read at open or in every supervision cycle would fail the run; exit 1: the scan itself failed

const usage = "usage: node --import tsx scripts/rollout-scan.ts <data-directory> [--json]";

const program = Effect.gen(function* () {
  const [directory, format, ...rest] = process.argv.slice(2);
  if (!directory || directory.startsWith("--") || (format !== undefined && format !== "--json") || rest.length) {
    yield* Console.error(usage);
    return 1;
  }
  const scan = yield* rolloutScan(directory);
  yield* Console.log(format === "--json" ? JSON.stringify(scan) : renderRolloutScan(directory, scan));
  return scan.blocking ? 2 : 0;
});

// a failed scan prints only its fixed line (a driver error may quote stored values)
NodeRuntime.runMain(program.pipe(
  Effect.catchCause(() => Effect.as(Console.error("rollout scan failed: a store file could not be read"), 1)),
  Effect.flatMap((code) => Effect.sync(() => {process.exitCode = code;})),
), {disableErrorReporting: true});
