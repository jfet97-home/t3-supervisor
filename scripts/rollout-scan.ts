import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Cause, Console, Data, Effect, FileSystem } from "effect";
import { renderRolloutScan, rolloutScan } from "../src/rollout-scan.js";
import { makeT3Client, T3Client } from "../src/t3.js";

// the read-only rollout scan of a supervisor data directory before the store switch is deployed on it:
//   node --import tsx scripts/rollout-scan.ts <data-directory> [--json] [--t3-url <url> --t3-token-file <read-token-file>]
// it opens guidance.sqlite3 and thread-settings.sqlite3 read only, writes nothing and never sends to T3; the report names each
// table, row kind and key of a row the switched stores would not read as stored, never its content. Its interpretation
// cut-over section prints the plan of the s6e startup step by identities, counts and reasons; given the T3 URL and the read
// token it reads the supervisor roots' projections (read only) to classify in-flight attempts and native evidence. Exit 0:
// nothing blocks the run; exit 2: a row read at open or in every supervision cycle would fail the run, or the cut-over would
// refuse; exit 1: the scan itself failed

const usage = "usage: node --import tsx scripts/rollout-scan.ts <data-directory> [--json] [--t3-url <url> --t3-token-file <read-token-file>]";

// the arguments, or null when they do not parse
const parse = (args: ReadonlyArray<string>) => {
  const [directory, ...rest] = args;
  if (!directory || directory.startsWith("--")) return null;
  let json = false, url: string | undefined, tokenFile: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--json" && !json) json = true;
    else if (flag === "--t3-url" && url === undefined && rest[index + 1]) url = rest[++index];
    else if (flag === "--t3-token-file" && tokenFile === undefined && rest[index + 1]) tokenFile = rest[++index];
    else return null;
  }
  if ((url === undefined) !== (tokenFile === undefined)) return null;
  return {directory, json, native: url !== undefined && tokenFile !== undefined ? {url, tokenFile} : undefined};
};

class ReadTokenUnavailable extends Data.TaggedError("ReadTokenUnavailable") {}

const program = Effect.gen(function* () {
  const parsed = parse(process.argv.slice(2));
  if (!parsed) {
    yield* Console.error(usage);
    return 1;
  }
  const scanned = (native?: T3Client["Service"]) => Effect.gen(function* () {
    const scan = yield* rolloutScan(parsed.directory, native);
    yield* Console.log(parsed.json ? JSON.stringify(scan) : renderRolloutScan(parsed.directory, scan));
    return scan.blocking || scan.cutover?.blockers.length ? 2 : 0;
  });
  if (!parsed.native) return yield* scanned();
  const {url, tokenFile} = parsed.native;
  const token = (yield* FileSystem.FileSystem.use((files) => files.readFileString(tokenFile)).pipe(Effect.mapError(() => new ReadTokenUnavailable()))).trim();
  if (!token) return yield* new ReadTokenUnavailable();
  return yield* Effect.gen(function* () {return yield* scanned(yield* T3Client);}).pipe(Effect.provide(makeT3Client({baseUrl: url, token})));
});

// a failed scan prints only its fixed line (a driver error may quote stored values; a token is never printed)
NodeRuntime.runMain(program.pipe(
  Effect.catchCause((cause) => Effect.as(Console.error(Cause.squash(cause) instanceof ReadTokenUnavailable
    ? "rollout scan failed: the read token could not be read" : "rollout scan failed: a store file could not be read"), 1)),
  Effect.flatMap((code) => Effect.sync(() => {process.exitCode = code;})),
  Effect.provide(NodeFileSystem.layer),
), {disableErrorReporting: true});
