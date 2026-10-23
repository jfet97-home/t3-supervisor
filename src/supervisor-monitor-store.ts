import { Clock, Context, Data, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/sql";
import { GuidanceDb, untracedSql } from "./db.js";
import { changedRows, decodeGuidanceRow, type GuidanceStoreError, guidanceSql, rowFindings, rowKey, rowsOf, schemaChanges, type StoredRowScan, tableColumns } from "./guidance-sql.js";
import {
  collectSupervisorActivity,
  compareMonitorPriority,
  compareMonitorTrigger,
  evaluateSupervisorMonitoring,
  isCurrentMainGraphRun,
  SUPERVISOR_MONITOR_MAX_BATCH_ITEMS,
  SUPERVISOR_MONITOR_MAX_FROZEN_ITEMS_PER_BATCH,
  SUPERVISOR_MONITOR_MAX_ITEMS_PER_CHAT,
  SUPERVISOR_MONITOR_MAX_ITEMS_PER_THREAD,
  SUPERVISOR_MONITOR_MAX_SELECTED_THREADS,
  type SupervisorMonitorActivity,
  type SupervisorMonitorBatch,
  type SupervisorMonitorPriority,
  type SupervisorMonitorThreadBatch,
  type SupervisorNativeChildLifecycleEvidence,
} from "./supervisor-monitor.js";
import type { SupervisorMonitoringSettings } from "./project-supervisor-contract.js";
import type { Projection } from "./types.js";



export interface SupervisorMonitorObservation {
  projectId: string;
  threadId: string;
  sourceOrdinal: number;
  inserted: number;
  updated: number;
  pendingItemCount: number;
  saturated: boolean;
  untrackedCount: number;
}

export interface SupervisorMonitorThreadState {
  projectId: string;
  threadId: string;
  sourceOrdinal: number;
  activities: SupervisorMonitorActivity[];
  saturated: boolean;
  saturationAt: number | null;
  lastAcknowledgedAt: number | null;
  untrackedCount: number;
}

export interface SupervisorMonitorSelectOptions {
  maxItems?: number;
  maxItemsPerThread?: number;
  maxThreads?: number;
  maxFrozenItems?: number;
  eligibleThreadIds?: ReadonlySet<string>;
}

export type SupervisorMonitorScopePendingScan =
  | {status: "complete"; pending: boolean}
  | {status: "incomplete"};

const knownPriority = (value: unknown): SupervisorMonitorPriority | null =>
  value === "user_instruction" ||
  value === "run_finished" ||
  value === "run_failed" ||
  value === "waiting_input"
    ? value
    : null;

const isFinalized = (item: Pick<SupervisorMonitorActivity, "status">): boolean =>
  ["completed", "failed", "cancelled", "interrupted", "resolved", "expired"].includes(item.status);

const isReviewable = (item: SupervisorMonitorActivity): boolean =>
  isFinalized(item) || item.priority === "waiting_input";

const liveRunStatuses = new Set(["preparing", "queued", "starting", "running", "waiting"]);


const boundedInteger = (value: number | undefined, fallback: number, max: number): number =>
  Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, max) : fallback;

const threadSort = (
  left: { decision: ReturnType<typeof evaluateSupervisorMonitoring>; lastAcknowledgedAt: number | null; threadId: string },
  right: { decision: ReturnType<typeof evaluateSupervisorMonitoring>; lastAcknowledgedAt: number | null; threadId: string },
): number => {
  const leftTrigger = left.decision.trigger;
  const rightTrigger = right.decision.trigger;
  const triggerComparison =
    leftTrigger && rightTrigger
      ? compareMonitorTrigger(leftTrigger, rightTrigger)
      : leftTrigger
        ? -1
        : rightTrigger
          ? 1
          : 0;
  return (
    triggerComparison ||
    (left.decision.oldestAt ?? Number.MAX_SAFE_INTEGER) -
      (right.decision.oldestAt ?? Number.MAX_SAFE_INTEGER) ||
    (left.lastAcknowledgedAt ?? 0) - (right.lastAcknowledgedAt ?? 0) ||
    left.threadId.localeCompare(right.threadId)
  );
};

const threadBatch = (
  threadId: string,
  activities: SupervisorMonitorActivity[],
  previewItems: SupervisorMonitorActivity[],
  decision: ReturnType<typeof evaluateSupervisorMonitoring>,
  saturated: boolean,
  untrackedCount: number,
): SupervisorMonitorThreadBatch => {
  const ordered = [...activities].sort(compareMonitorPriority);
  const preview = [...previewItems].sort(compareMonitorPriority);
  const priorities = [...new Set(ordered.flatMap((item) => item.priority ? [item.priority] : []))];
  return {
    threadId,
    trigger: decision.trigger ?? (saturated ? "saturated" : "activity_age"),
    finalizedActivityCount: decision.finalizedActivityCount,
    pendingItemCount: decision.pendingItemCount,
    oldestAt: decision.oldestAt,
    priority: priorities.length > 0,
    priorityKinds: priorities,
    saturated,
    untrackedCount,
    items: ordered,
    previewItems: preview,
  };
};

/** An observation, review time or acknowledgement the store refuses; the message is its reason. */
export class InvalidMonitorObservation extends Data.TaggedError("InvalidMonitorObservation")<{
  readonly reason: "invalid_monitor_observation" | "invalid_monitor_time" | "invalid_monitor_review_time";
}> {
  override get message(): string {
    return this.reason;
  }
}

/** A per-thread capacity outside 1..SUPERVISOR_MONITOR_MAX_ITEMS_PER_THREAD. */
export class InvalidMonitorCapacity extends Data.TaggedError("InvalidMonitorCapacity") {
  override readonly message = "invalid_monitor_capacity";
}

const MonitorThreadColumns = Schema.Struct({
  project_id: Schema.String, thread_id: Schema.String, source_ordinal: Schema.Number, activation_ordinal: Schema.NullOr(Schema.Number),
  saturated: Schema.Number, saturation_at: Schema.NullOr(Schema.Number), last_acknowledged_at: Schema.NullOr(Schema.Number),
  untracked_count: Schema.Number,
});
type MonitorThreadColumns = typeof MonitorThreadColumns.Type;
const MonitorItemColumns = Schema.Struct({
  item_id: Schema.String, read_item_id: Schema.NullOr(Schema.String), type: Schema.String, status: Schema.String, ordinal: Schema.Number,
  detected_at: Schema.Number, version: Schema.String, priority: Schema.NullOr(Schema.String), eligible: Schema.Number, active: Schema.Number,
  reviewed_version: Schema.NullOr(Schema.String),
});
type MonitorItemColumns = typeof MonitorItemColumns.Type;
const decodeThreadRow = decodeGuidanceRow(MonitorThreadColumns, "monitor_thread");
const decodeItemRow = decodeGuidanceRow(MonitorItemColumns, "monitor_item");
const decodeItemIdRow = decodeGuidanceRow(Schema.Struct({ item_id: Schema.String }), "monitor_item");
const decodeCountRow = decodeGuidanceRow(Schema.Struct({ count: Schema.Number }), "monitor_item_count");

const itemActivity = (row: MonitorItemColumns): SupervisorMonitorActivity => ({
  id: row.item_id,
  readItemId: row.read_item_id,
  type: row.type,
  status: row.status,
  ordinal: row.ordinal,
  detectedAt: row.detected_at,
  version: row.version,
  priority: knownPriority(row.priority),
});

type ObserveInput = {
  projectId: string;
  threadId: string;
  sourceOrdinal: number;
  projection: Projection;
  now?: number;
  excludedIds?: ReadonlySet<string>;
  includeDetachedChildItems?: boolean;
  nativeChildLifecycle?: SupervisorNativeChildLifecycleEvidence;
  preserveNativeChildLifecycle?: boolean;
};

/** The monitor store: metadata-only activity checkpoints per main and descendant thread. */
export interface ProjectSupervisorMonitorStoreShape {
  readonly maxItemsPerThread: number;
  readonly observe: (input: ObserveInput) => Effect.Effect<SupervisorMonitorObservation, InvalidMonitorObservation | GuidanceStoreError>;
  readonly pending: (projectId: string, threadId: string) => Effect.Effect<SupervisorMonitorActivity[], GuidanceStoreError>;
  readonly state: (projectId: string, threadId: string) => Effect.Effect<SupervisorMonitorThreadState, GuidanceStoreError>;
  readonly hasState: (projectId: string, threadId: string) => Effect.Effect<boolean, GuidanceStoreError>;
  readonly hasPendingReviewableActivity: (projectId: string, threadIds: readonly string[]) => Effect.Effect<SupervisorMonitorScopePendingScan>;
  readonly select: (projectId: string, settings: SupervisorMonitoringSettings, now: number, lastProjectNoticeAt: number | null,
    optionsOrLimit?: SupervisorMonitorSelectOptions | number, eligibleThreadIds?: ReadonlySet<string>) =>
    Effect.Effect<SupervisorMonitorBatch | null, GuidanceStoreError>;
  /** Acknowledges a frozen batch at its exact versions; joins the caller's transaction (CC-MONITOR-ACK). */
  readonly acknowledge: (batch: SupervisorMonitorBatch, reviewedAt?: number) =>
    Effect.Effect<{ acknowledged: number; stale: number }, InvalidMonitorObservation | GuidanceStoreError>;
}

const monitorSchema = [
  `CREATE TABLE IF NOT EXISTS supervisor_monitor_threads(
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        source_ordinal INTEGER NOT NULL,
        activation_ordinal INTEGER NOT NULL,
        saturated INTEGER NOT NULL DEFAULT 0,
        saturation_at INTEGER,
        last_acknowledged_at INTEGER,
        untracked_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id, thread_id)
      )`,
  `CREATE TABLE IF NOT EXISTS supervisor_monitor_items(
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        read_item_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        detected_at INTEGER NOT NULL,
        version TEXT NOT NULL,
        priority TEXT,
        eligible INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        reviewed_version TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, thread_id, item_id)
      )`,
  `CREATE INDEX IF NOT EXISTS supervisor_monitor_pending
        ON supervisor_monitor_items(project_id, thread_id, eligible, reviewed_version)`,
];

/**
 * Builds the monitor store on the run's GuidanceDb client with the given per-thread capacity: the tables and the
 * column additions are created once, in the baseline constructor's order.
 */
export const makeProjectSupervisorMonitorStore = (maxItemsPerThread = SUPERVISOR_MONITOR_MAX_ITEMS_PER_THREAD) => Effect.gen(function* () {
  if (!Number.isSafeInteger(maxItemsPerThread) || maxItemsPerThread < 1 || maxItemsPerThread > SUPERVISOR_MONITOR_MAX_ITEMS_PER_THREAD)
    return yield* new InvalidMonitorCapacity();
  const db = yield* GuidanceDb;

  yield* guidanceSql(db.withTransaction(Effect.gen(function* () {
    for (const statement of monitorSchema) yield* db.unsafe(statement);
    const threadColumns = yield* tableColumns(db, "supervisor_monitor_threads");
    if (!threadColumns.includes("activation_ordinal")) {
      yield* db.unsafe("ALTER TABLE supervisor_monitor_threads ADD COLUMN activation_ordinal INTEGER");
      yield* db.unsafe(`UPDATE supervisor_monitor_threads SET activation_ordinal=source_ordinal
        WHERE activation_ordinal IS NULL`);
    }
    if (!threadColumns.includes("untracked_count"))
      yield* db.unsafe("ALTER TABLE supervisor_monitor_threads ADD COLUMN untracked_count INTEGER NOT NULL DEFAULT 0");
    const itemColumns = yield* tableColumns(db, "supervisor_monitor_items");
    if (!itemColumns.includes("read_item_id")) yield* db.unsafe("ALTER TABLE supervisor_monitor_items ADD COLUMN read_item_id TEXT");
    if (!itemColumns.includes("active")) yield* db.unsafe("ALTER TABLE supervisor_monitor_items ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  })));

  const threadRow = (projectId: string, threadId: string) =>
    db`SELECT * FROM supervisor_monitor_threads WHERE project_id=${projectId} AND thread_id=${threadId}`.pipe(
      Effect.flatMap(([row]) => row === undefined ? Effect.succeed(undefined) : decodeThreadRow(row)));
  const itemRow = (projectId: string, threadId: string, itemId: string) =>
    db`SELECT item_id,read_item_id,type,status,ordinal,detected_at,version,priority,eligible,active,reviewed_version
        FROM supervisor_monitor_items WHERE project_id=${projectId} AND thread_id=${threadId} AND item_id=${itemId}`.pipe(
      Effect.flatMap(([row]) => row === undefined ? Effect.succeed(undefined) : decodeItemRow(row)));
  const readState = (projectId: string, threadId: string) => Effect.gen(function* () {
    const thread = yield* threadRow(projectId, threadId);
    const activities: SupervisorMonitorActivity[] = [];
    for (const row of yield* db`SELECT item_id,read_item_id,type,status,ordinal,detected_at,version,priority,eligible,active,reviewed_version
        FROM supervisor_monitor_items WHERE project_id=${projectId} AND thread_id=${threadId} AND eligible=1
        AND active=1 AND (reviewed_version IS NULL OR reviewed_version<>version)
        ORDER BY ordinal,detected_at,item_id`)
      activities.push(itemActivity(yield* decodeItemRow(row)));
    return {
      projectId,
      threadId,
      sourceOrdinal: thread ? thread.source_ordinal : 0,
      activities,
      saturated: (thread?.saturated ?? 0) === 1,
      saturationAt: thread?.saturation_at ?? null,
      lastAcknowledgedAt: thread?.last_acknowledged_at ?? null,
      untrackedCount: thread?.untracked_count ?? 0,
    } satisfies SupervisorMonitorThreadState;
  });
  const readPending = (projectId: string, threadId: string) => Effect.map(readState(projectId, threadId), (state) => state.activities.filter(isReviewable));

  // a reviewable item holds the floor until its row is eligible and acknowledged at its current version
  const acknowledgedAtVersion = (projectId: string, threadId: string, item: SupervisorMonitorActivity) => Effect.map(itemRow(projectId, threadId, item.id),
    (row) => row !== undefined && row.eligible === 1 && row.version === item.version && row.reviewed_version === item.version);

  const advanceSourceOrdinal = (projectId: string, threadId: string, currentFloor: number, projection: Projection,
    activity: readonly SupervisorMonitorActivity[], includeDetachedChildItems: boolean) => Effect.gen(function* () {
    const runs = projection.runs
      .filter((run) => run.threadId === threadId && run.ordinal >= currentFloor)
      .sort((left, right) => left.ordinal - right.ordinal);
    if (includeDetachedChildItems && projection.thread.lineage.relationshipToParent === "subagent" && runs.length === 0) {
      const detached = activity.filter((item) => item.type !== "native_child_lifecycle" && item.ordinal >= currentFloor);
      if (!detached.length) return currentFloor;
      const maxOrdinal = Math.max(...detached.map(item => item.ordinal));
      for (const item of detached) {
        if (!isReviewable(item)) continue;
        if (!(yield* acknowledgedAtVersion(projectId, threadId, item))) return currentFloor;
      }
      return Math.max(currentFloor, maxOrdinal + 1);
    }
    let floor = currentFloor;
    for (const run of runs) {
      if (run.ordinal !== floor) break;
      if (liveRunStatuses.has(run.status) && isCurrentMainGraphRun(projection, run)) break;
      let fullyAcknowledged = true;
      for (const item of activity.filter((candidate) => candidate.ordinal === run.ordinal)) {
        if (!isReviewable(item)) continue;
        if (!(yield* acknowledgedAtVersion(projectId, threadId, item))) {
          fullyAcknowledged = false;
          break;
        }
      }
      if (!fullyAcknowledged) break;
      floor = run.ordinal + 1;
    }
    return floor;
  });

  // floor, activation ordinal, item activation and deletion, upserts and saturation commit together
  const observe = (input: ObserveInput) => guidanceSql(Effect.gen(function* () {
    if (!input.projectId.trim() || !input.threadId.trim() || input.projection.thread.id !== input.threadId ||
      !Number.isSafeInteger(input.sourceOrdinal) || input.sourceOrdinal < 0)
      return yield* new InvalidMonitorObservation({ reason: "invalid_monitor_observation" });
    const now = input.now ?? (yield* Clock.currentTimeMillis);
    if (!Number.isFinite(now)) return yield* new InvalidMonitorObservation({ reason: "invalid_monitor_time" });

    return yield* db.withTransaction(Effect.gen(function* () {
      yield* db`INSERT INTO supervisor_monitor_threads(project_id,thread_id,source_ordinal,activation_ordinal)
          VALUES(${input.projectId},${input.threadId},${input.sourceOrdinal},${input.sourceOrdinal}) ON CONFLICT(project_id,thread_id) DO UPDATE SET
          source_ordinal=MAX(source_ordinal,excluded.source_ordinal),
          activation_ordinal=MIN(activation_ordinal,excluded.activation_ordinal)`;
      const thread = (yield* threadRow(input.projectId, input.threadId))!;
      const currentFloor = thread.source_ordinal;
      const activationOrdinal = thread.activation_ordinal ?? input.sourceOrdinal;
      const reactivatedOrdinal = input.projection.runs
        .filter((run) => run.threadId === input.threadId && run.ordinal >= activationOrdinal && run.ordinal < currentFloor &&
          liveRunStatuses.has(run.status) && isCurrentMainGraphRun(input.projection, run))
        .reduce<number | null>((lowest, run) => (lowest === null ? run.ordinal : Math.min(lowest, run.ordinal)), null);
      const collectionFloor = reactivatedOrdinal ?? currentFloor;
      if (collectionFloor < currentFloor)
        yield* db`UPDATE supervisor_monitor_threads SET source_ordinal=${collectionFloor}
            WHERE project_id=${input.projectId} AND thread_id=${input.threadId}`;

      const trackedIds = new Set<string>();
      for (const row of yield* db`SELECT item_id FROM supervisor_monitor_items WHERE project_id=${input.projectId} AND thread_id=${input.threadId}`)
        trackedIds.add((yield* decodeItemIdRow(row)).item_id);
      const activity = collectSupervisorActivity(input.projection, collectionFloor, now, input.excludedIds, trackedIds,
        input.includeDetachedChildItems === true, input.nativeChildLifecycle);
      yield* db`UPDATE supervisor_monitor_items SET active=0 WHERE project_id=${input.projectId} AND thread_id=${input.threadId}`;
      for (const item of activity)
        yield* db`UPDATE supervisor_monitor_items SET active=1
          WHERE project_id=${input.projectId} AND thread_id=${input.threadId} AND item_id=${item.id}`;
      if (input.preserveNativeChildLifecycle === true)
        yield* db`UPDATE supervisor_monitor_items SET active=1
            WHERE project_id=${input.projectId} AND thread_id=${input.threadId} AND type='native_child_lifecycle'`;
      yield* db`DELETE FROM supervisor_monitor_items WHERE project_id=${input.projectId} AND thread_id=${input.threadId} AND active=0`;
      const sourceOrdinal = yield* advanceSourceOrdinal(input.projectId, input.threadId, collectionFloor, input.projection, activity,
        input.includeDetachedChildItems === true);
      if (sourceOrdinal !== collectionFloor)
        yield* db`UPDATE supervisor_monitor_threads SET source_ordinal=${sourceOrdinal}
            WHERE project_id=${input.projectId} AND thread_id=${input.threadId}`;
      yield* db`DELETE FROM supervisor_monitor_items
          WHERE project_id=${input.projectId} AND thread_id=${input.threadId} AND ordinal<${sourceOrdinal}
          AND type<>'native_child_lifecycle'
          AND (reviewed_version=version OR active=0)`;
      const currentActivity = activity.filter((item) => item.ordinal >= sourceOrdinal);
      let inserted = 0;
      let updated = 0;
      let untrackedCount = 0;
      const countRows = db`SELECT COUNT(*) AS count FROM supervisor_monitor_items WHERE project_id=${input.projectId} AND thread_id=${input.threadId}`.pipe(
        Effect.flatMap(([row]) => row === undefined ? Effect.succeed(0) : Effect.map(decodeCountRow(row), (value) => value.count)));

      for (const item of currentActivity) {
        const current = yield* itemRow(input.projectId, input.threadId, item.id);
        if (current) {
          if (current.version === item.version) {
            if (current.active !== 1 || (current.read_item_id === null && item.readItemId !== null) ||
              item.type === "native_child_lifecycle" && current.ordinal !== item.ordinal)
              yield* db`UPDATE supervisor_monitor_items SET read_item_id=COALESCE(${item.readItemId},read_item_id),ordinal=${item.ordinal},active=1
                  WHERE project_id=${input.projectId} AND thread_id=${input.threadId} AND item_id=${item.id} AND version=${item.version}`;
            continue;
          }
          const eligible = current.eligible === 1 || item.ordinal >= sourceOrdinal;
          yield* db`UPDATE supervisor_monitor_items SET read_item_id=COALESCE(${item.readItemId},read_item_id),type=${item.type},status=${item.status},ordinal=${item.ordinal},detected_at=${item.detectedAt},version=${item.version},
              priority=${item.priority},eligible=${eligible ? 1 : 0},active=1,reviewed_version=${eligible ? null : item.version},updated_at=${now}
              WHERE project_id=${input.projectId} AND thread_id=${input.threadId} AND item_id=${item.id}`;
          updated++;
          continue;
        }
        const eligible = item.ordinal >= sourceOrdinal;
        if (!eligible) continue;
        if ((yield* countRows) >= maxItemsPerThread) {
          untrackedCount++;
          continue;
        }
        yield* db`INSERT INTO supervisor_monitor_items(
            project_id,thread_id,item_id,read_item_id,type,status,ordinal,detected_at,version,priority,eligible,active,reviewed_version,updated_at
          ) VALUES(${input.projectId},${input.threadId},${item.id},${item.readItemId},${item.type},${item.status},${item.ordinal},${item.detectedAt},${item.version},${item.priority},${1},${1},${null},${now})`;
        inserted++;
      }

      if (untrackedCount > 0) {
        yield* db`UPDATE supervisor_monitor_threads SET saturated=1,
            saturation_at=COALESCE(saturation_at,${now}),untracked_count=${untrackedCount}
            WHERE project_id=${input.projectId} AND thread_id=${input.threadId}`;
      } else {
        yield* db`UPDATE supervisor_monitor_threads SET saturated=0,
            saturation_at=NULL,untracked_count=0
            WHERE project_id=${input.projectId} AND thread_id=${input.threadId}`;
      }

      const pendingItems = yield* readPending(input.projectId, input.threadId);
      const state = (yield* threadRow(input.projectId, input.threadId))!;
      return {
        projectId: input.projectId,
        threadId: input.threadId,
        sourceOrdinal,
        inserted,
        updated,
        pendingItemCount: pendingItems.length,
        saturated: state.saturated === 1,
        untrackedCount,
      } satisfies SupervisorMonitorObservation;
    }));
  }));

  // the thread row and its items are read from one snapshot
  const state = (projectId: string, threadId: string) => guidanceSql(db.withTransaction(readState(projectId, threadId)));
  const pending = (projectId: string, threadId: string) => guidanceSql(db.withTransaction(readPending(projectId, threadId)));
  const hasState = (projectId: string, threadId: string) => guidanceSql(Effect.map(threadRow(projectId, threadId), (row) => row !== undefined));

  // invalid input, a failed read or a row that does not decode leaves the scan incomplete
  const hasPendingReviewableActivity = (projectId: string, threadIds: readonly string[]): Effect.Effect<SupervisorMonitorScopePendingScan> => {
    if (!projectId.trim() || !Array.isArray(threadIds) || threadIds.length < 1 || threadIds.length > 10_000 ||
      threadIds.some(threadId => typeof threadId !== "string" || !threadId.trim()) || new Set(threadIds).size !== threadIds.length)
      return Effect.succeed({status: "incomplete"});
    return guidanceSql(db.withTransaction(Effect.gen(function* () {
      for (let start = 0; start < threadIds.length; start += 400) {
        const chunk = threadIds.slice(start, start + 400);
        const match = yield* db`SELECT 1 AS pending FROM supervisor_monitor_items
          WHERE project_id=${projectId} AND thread_id IN ${db.in(chunk)} AND eligible=1 AND active=1
          AND (reviewed_version IS NULL OR reviewed_version<>version)
          AND (status IN ('completed','failed','cancelled','interrupted','resolved','expired') OR priority='waiting_input') LIMIT 1`;
        if (match.length > 0) return {status: "complete", pending: true} as const;
      }
      return {status: "complete", pending: false} as const;
    }))).pipe(Effect.orElseSucceed(() => ({status: "incomplete"} as const)));
  };

  // every read of the selection comes from one snapshot
  const select = (projectId: string, settings: SupervisorMonitoringSettings, now: number, lastProjectNoticeAt: number | null,
    optionsOrLimit: SupervisorMonitorSelectOptions | number = {}, eligibleThreadIds?: ReadonlySet<string>) => {
    if (!Number.isFinite(now)) return Effect.succeed(null);
    const options = typeof optionsOrLimit === "number"
      ? { maxItems: optionsOrLimit, eligibleThreadIds }
      : { ...optionsOrLimit, eligibleThreadIds: eligibleThreadIds ?? optionsOrLimit.eligibleThreadIds };
    const maxPreviewItems = boundedInteger(options.maxItems, SUPERVISOR_MONITOR_MAX_BATCH_ITEMS, SUPERVISOR_MONITOR_MAX_BATCH_ITEMS);
    const maxPreviewItemsPerThread = boundedInteger(options.maxItemsPerThread, Math.min(SUPERVISOR_MONITOR_MAX_ITEMS_PER_CHAT, maxPreviewItems),
      Math.min(SUPERVISOR_MONITOR_MAX_ITEMS_PER_CHAT, maxPreviewItems));
    const maxThreads = boundedInteger(options.maxThreads, SUPERVISOR_MONITOR_MAX_SELECTED_THREADS, SUPERVISOR_MONITOR_MAX_SELECTED_THREADS);
    const maxFrozenItems = boundedInteger(options.maxFrozenItems, SUPERVISOR_MONITOR_MAX_FROZEN_ITEMS_PER_BATCH,
      SUPERVISOR_MONITOR_MAX_FROZEN_ITEMS_PER_BATCH);
    return guidanceSql(db.withTransaction(Effect.gen(function* () {
      const rows: MonitorThreadColumns[] = [];
      for (const row of yield* db`SELECT * FROM supervisor_monitor_threads WHERE project_id=${projectId} ORDER BY thread_id`)
        rows.push(yield* decodeThreadRow(row));
      const candidates = [];
      for (const row of rows) {
        if (options.eligibleThreadIds && !options.eligibleThreadIds.has(row.thread_id)) continue;
        const state = yield* readState(projectId, row.thread_id);
        const reviewable = state.activities.filter(isReviewable);
        const decision = evaluateSupervisorMonitoring(reviewable, settings, now, lastProjectNoticeAt, false);
        candidates.push({ ...state, decision, reviewable: reviewable.sort(compareMonitorPriority) });
      }
      const due = candidates.filter((candidate) => candidate.decision.due).sort(threadSort);
      if (!due.length) return null;

      const selectedCandidates: typeof due = [];
      let frozenCount = 0;
      let skippedDueChats = false;
      for (const candidate of due) {
        if (selectedCandidates.length >= maxThreads) {
          skippedDueChats = true;
          break;
        }
        if (candidate.reviewable.length > maxFrozenItems - frozenCount) {
          skippedDueChats = true;
          continue;
        }
        selectedCandidates.push(candidate);
        frozenCount += candidate.reviewable.length;
      }
      if (!selectedCandidates.length) return null;

      const previewByThread = new Map<string, SupervisorMonitorActivity[]>();
      let previewRemaining = maxPreviewItems;
      while (previewRemaining > 0) {
        let progressed = false;
        for (const candidate of selectedCandidates) {
          const current = previewByThread.get(candidate.threadId) ?? [];
          if (current.length >= maxPreviewItemsPerThread || current.length >= candidate.reviewable.length) continue;
          current.push(candidate.reviewable[current.length]!);
          previewByThread.set(candidate.threadId, current);
          previewRemaining--;
          progressed = true;
          if (previewRemaining === 0) break;
        }
        if (!progressed) break;
      }

      const threads: SupervisorMonitorThreadBatch[] = [];
      for (const candidate of selectedCandidates)
        threads.push(threadBatch(candidate.threadId, candidate.reviewable, previewByThread.get(candidate.threadId) ?? [], candidate.decision,
          candidate.saturated, candidate.untrackedCount));
      if (threads.length === 0) return null;
      const trigger = [...threads].map((thread) => thread.trigger).sort(compareMonitorTrigger)[0]!;
      const totalPending = due.reduce((sum, candidate) => sum + candidate.decision.pendingItemCount, 0);
      const totalFinalized = due.reduce((sum, candidate) => sum + candidate.decision.finalizedActivityCount, 0);
      const previewCount = threads.reduce((sum, thread) => sum + thread.previewItems.length, 0);
      return {
        projectId,
        createdAt: now,
        trigger,
        finalizedActivityCount: totalFinalized,
        pendingItemCount: totalPending,
        truncated: skippedDueChats || previewCount < frozenCount,
        threads,
      } satisfies SupervisorMonitorBatch;
    })));
  };

  // CC-MONITOR-ACK: each frozen item is acknowledged only while its row still has the frozen version, eligible and
  // active; the acknowledgements and the thread clocks commit together, inside the caller's transaction when it has one
  const acknowledge = (batch: SupervisorMonitorBatch, reviewedAt?: number) => guidanceSql(Effect.gen(function* () {
    const at = reviewedAt ?? (yield* Clock.currentTimeMillis);
    if (!Number.isFinite(at)) return yield* new InvalidMonitorObservation({ reason: "invalid_monitor_review_time" });
    return yield* db.withTransaction(Effect.gen(function* () {
      let acknowledged = 0;
      let stale = 0;
      for (const thread of batch.threads) {
        let threadAcknowledged = 0;
        for (const item of thread.items) {
          const changes = yield* changedRows(db`UPDATE supervisor_monitor_items SET reviewed_version=version
            WHERE project_id=${batch.projectId} AND thread_id=${thread.threadId} AND item_id=${item.id} AND version=${item.version} AND eligible=1 AND active=1`.raw);
          if (changes > 0) {
            acknowledged++;
            threadAcknowledged++;
          } else stale++;
        }
        if (threadAcknowledged > 0)
          yield* db`UPDATE supervisor_monitor_threads SET last_acknowledged_at=${at}
            WHERE project_id=${batch.projectId} AND thread_id=${thread.threadId}`;
      }
      return { acknowledged, stale };
    }));
  }));

  return ProjectSupervisorMonitorStore.of({
    maxItemsPerThread, observe, pending, state, hasState, hasPendingReviewableActivity, select, acknowledge,
  });
}).pipe(untracedSql);

/**
 * The monitor store on the run's GuidanceDb client, with the default per-thread capacity. Every multi-statement method
 * runs in one transaction and joins the caller's transaction when there is one (a savepoint), acknowledge included.
 */
export class ProjectSupervisorMonitorStore extends Context.Service<ProjectSupervisorMonitorStore, ProjectSupervisorMonitorStoreShape>()(
  "t3-supervisor/ProjectSupervisorMonitorStore") {
  static readonly layer: Layer.Layer<ProjectSupervisorMonitorStore, GuidanceStoreError | InvalidMonitorCapacity, GuidanceDb> =
    Layer.effect(ProjectSupervisorMonitorStore, makeProjectSupervisorMonitorStore());
}

/**
 * The rollout scan of the monitor tables (read only): every thread and item row through the decoder its reader uses, with the
 * columns the open adds read as the open fills them, and the open's table and column additions.
 */
export const checkMonitorRows: Effect.Effect<StoredRowScan, SqlError.SqlError | GuidanceStoreError, GuidanceDb> = Effect.gen(function* () {
  const db = yield* GuidanceDb;
  const changes = [
    ...yield* schemaChanges(db, "supervisor_monitor_threads", ["activation_ordinal", "untracked_count"]),
    ...yield* schemaChanges(db, "supervisor_monitor_items", ["read_item_id", "active"]),
  ];
  const cycle = { problem: "undecodable", read: "cycle" } as const;
  const findings = [
    ...yield* rowFindings(yield* rowsOf(db, "supervisor_monitor_threads", "SELECT * FROM supervisor_monitor_threads"),
      { ...cycle, table: "supervisor_monitor_threads", kind: "monitor thread" }, (row) => rowKey(row, ["project_id", "thread_id"]),
      (row) => decodeThreadRow({ untracked_count: 0, ...row, activation_ordinal: row.activation_ordinal ?? row.source_ordinal })),
    ...yield* rowFindings(yield* rowsOf(db, "supervisor_monitor_items", "SELECT * FROM supervisor_monitor_items"),
      { ...cycle, table: "supervisor_monitor_items", kind: "monitor item" }, (row) => rowKey(row, ["project_id", "thread_id", "item_id"]),
      (row) => decodeItemRow({ read_item_id: null, active: 1, ...row })),
  ];
  return { findings, changes };
});
