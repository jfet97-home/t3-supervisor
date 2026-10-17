import {readFile} from "node:fs/promises";
import {Effect} from "effect";
import {T3Client, makeT3Client} from "../dist/t3.js";
import {classifyCompletionRun, summarizeRecentCompletionCoverage} from "../dist/completion-coverage.js";
import {buildContext, eligibleRuns, formatReplyParts, telegramRouteUpdateId} from "../dist/domain.js";

const threadId = process.env.COMPLETION_PROBE_THREAD_ID;
const compareId = process.env.COMPLETION_PROBE_COMPARE_THREAD_ID;
if (!threadId || threadId.length > 512) throw new Error("Set COMPLETION_PROBE_THREAD_ID to the selected native chat.");
const token = (await readFile(process.env.T3_TOKEN_FILE ?? "/run/secrets/t3-read-token", "utf8")).trim();
await Effect.runPromise(Effect.gen(function* () {
  const t3 = yield* T3Client;
  const started = Date.now();
  const snapshot = yield* t3.boundedCompletionProjection(threadId);
  const classification = {};
  for (const run of snapshot.projection.runs) {
    const evidence = classifyCompletionRun(snapshot.projection, run.id);
    classification[evidence.state] = (classification[evidence.state] ?? 0) + 1;
  }
  console.log(JSON.stringify({proof: "real-recent-completion-window", elapsedMs: Date.now() - started,
    serializedBytes: Buffer.byteLength(JSON.stringify(snapshot)), runs: snapshot.projection.runs.length,
    hasMoreHistory: snapshot.hasMoreHistory, payloadBudgetExceeded: snapshot.payloadBudgetExceeded,
    classification, olderHistory: summarizeRecentCompletionCoverage(snapshot.projection, snapshot).olderHistory}));
  if (!compareId) return;
  const recent = yield* t3.boundedCompletionProjection(compareId);
  const full = yield* t3.projection(compareId);
  let compared = 0;
  for (const run of eligibleRuns(recent.projection, 0)) {
    if (classifyCompletionRun(recent.projection, run.id).state !== "complete") continue;
    const original = full.projection.runs.find(value => value.id === run.id);
    if (!original || JSON.stringify(buildContext(recent.projection, run.id, null)) !== JSON.stringify(buildContext(full.projection, run.id, null)) ||
      telegramRouteUpdateId(recent.projection, run) !== telegramRouteUpdateId(full.projection, original) ||
      JSON.stringify(formatReplyParts(recent.projection, run, null)) !== JSON.stringify(formatReplyParts(full.projection, original, null)))
      throw new Error("native full/window completion equivalence failed");
    compared += 1;
  }
  if (compared === 0) throw new Error("comparison chat has no complete eligible recent turn");
  console.log(JSON.stringify({proof: "native-full-window-equivalence", completeRunsCompared: compared, matched: true}));
}).pipe(Effect.provide(makeT3Client({baseUrl: process.env.T3_URL ?? "http://127.0.0.1:3773", token}))));
