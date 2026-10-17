import { Effect } from "effect";
import { buildContext, eligibleRuns, formatReplyParts, telegramRouteUpdateId, timestampMs } from "./domain.js";
import { classifyCompletionRun, summarizeRecentCompletionCoverage } from "./completion-coverage.js";
import { StoreError, type StoreShape } from "./store.js";
import type { T3BoundedCompletionSnapshot } from "./t3.js";

/** Collects only native completions whose request and result are present in this window. */
export const collectRecentCompletions = (
  store: StoreShape,
  snapshot: T3BoundedCompletionSnapshot,
  environmentId: string,
  notificationsAfter: number,
  now: number,
) => Effect.gen(function* () {
  const projection = snapshot.projection;
  const threadId = projection.thread.id;
  const coverage = summarizeRecentCompletionCoverage(projection, snapshot);
  const project = yield* store.project(threadId);
  const eligible = new Set(eligibleRuns(projection, notificationsAfter).map(run => run.id));
  let settling = false;
  let queued = 0;
  const relevant = projection.runs.filter(run => run.status === "completed" &&
    (timestampMs(run.completedAt) ?? -Infinity) > notificationsAfter);
  if (coverage.olderHistory === "limited" && relevant.length > 0) {
    if (!store.recordCompletionGap) return yield* Effect.fail(new StoreError("completion coverage reporting unavailable"));
    yield* store.recordCompletionGap(threadId, "older_history_not_read", null, now);
  }
  for (const run of relevant) {
    if (yield* store.hasIdentity(environmentId, threadId, run.id)) continue;
    const evidence = classifyCompletionRun(projection, run.id);
    if (evidence.state === "incomplete") {
      if (!store.recordCompletionGap) return yield* Effect.fail(new StoreError("completion coverage reporting unavailable"));
      yield* store.recordCompletionGap(threadId, "incomplete_turn", run.id, now);
      continue;
    }
    if (evidence.state !== "complete" || !eligible.has(run.id)) {
      settling = true;
      continue;
    }
    const updateId = telegramRouteUpdateId(projection, run);
    const jobId = updateId === null
      ? yield* store.enqueue(environmentId, threadId, run.id, yield* Effect.try(() => buildContext(projection, run.id, project)), now)
      : yield* store.enqueueReply(environmentId, threadId, run.id, yield* Effect.try(() => formatReplyParts(projection, run, project)), now);
    if (jobId) queued += 1;
  }
  return {settling, queued, coverage};
});
