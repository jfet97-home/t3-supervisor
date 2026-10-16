import type { GuidanceStore } from "./guidance-store.js";
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

interface MonitorThreadRow {
  project_id: unknown;
  thread_id: unknown;
  source_ordinal: unknown;
  activation_ordinal: unknown;
  saturated: unknown;
  saturation_at: unknown;
  last_acknowledged_at: unknown;
  untracked_count: unknown;
}

interface MonitorItemRow {
  item_id: unknown;
  read_item_id: unknown;
  type: unknown;
  status: unknown;
  ordinal: unknown;
  detected_at: unknown;
  version: unknown;
  priority: unknown;
  eligible: unknown;
  active: unknown;
  reviewed_version: unknown;
}

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

const asActivity = (row: MonitorItemRow): SupervisorMonitorActivity => ({
  id: String(row.item_id),
  readItemId: typeof row.read_item_id === "string" ? row.read_item_id : null,
  type: String(row.type),
  status: String(row.status),
  ordinal: Number(row.ordinal),
  detectedAt: Number(row.detected_at),
  version: String(row.version),
  priority: knownPriority(row.priority),
});

const optionalNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

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

/** Persists metadata-only activity checkpoints in the existing guidance database. */
export class ProjectSupervisorMonitorStore {
  constructor(
    readonly store: GuidanceStore,
    readonly maxItemsPerThread = SUPERVISOR_MONITOR_MAX_ITEMS_PER_THREAD,
  ) {
    if (
      !Number.isSafeInteger(maxItemsPerThread) ||
      maxItemsPerThread < 1 ||
      maxItemsPerThread > SUPERVISOR_MONITOR_MAX_ITEMS_PER_THREAD
    )
      throw new Error("invalid_monitor_capacity");
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS supervisor_monitor_threads(
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        source_ordinal INTEGER NOT NULL,
        activation_ordinal INTEGER NOT NULL,
        saturated INTEGER NOT NULL DEFAULT 0,
        saturation_at INTEGER,
        last_acknowledged_at INTEGER,
        untracked_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS supervisor_monitor_items(
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
      );
      CREATE INDEX IF NOT EXISTS supervisor_monitor_pending
        ON supervisor_monitor_items(project_id, thread_id, eligible, reviewed_version);
    `);
    const threadColumns = store.db.prepare("PRAGMA table_info(supervisor_monitor_threads)").all();
    if (!threadColumns.some((column) => column.name === "activation_ordinal")) {
      store.db.exec("ALTER TABLE supervisor_monitor_threads ADD COLUMN activation_ordinal INTEGER");
      store.db.exec(`UPDATE supervisor_monitor_threads SET activation_ordinal=source_ordinal
        WHERE activation_ordinal IS NULL`);
    }
    if (!threadColumns.some((column) => column.name === "untracked_count"))
      store.db.exec("ALTER TABLE supervisor_monitor_threads ADD COLUMN untracked_count INTEGER NOT NULL DEFAULT 0");
    const itemColumns = store.db.prepare("PRAGMA table_info(supervisor_monitor_items)").all();
    if (!itemColumns.some((column) => column.name === "read_item_id"))
      store.db.exec("ALTER TABLE supervisor_monitor_items ADD COLUMN read_item_id TEXT");
    if (!itemColumns.some((column) => column.name === "active"))
      store.db.exec("ALTER TABLE supervisor_monitor_items ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  }

  observe(input: {
    projectId: string;
    threadId: string;
    sourceOrdinal: number;
    projection: Projection;
    now?: number;
    excludedIds?: ReadonlySet<string>;
    includeDetachedChildItems?: boolean;
    nativeChildLifecycle?: SupervisorNativeChildLifecycleEvidence;
    preserveNativeChildLifecycle?: boolean;
  }): SupervisorMonitorObservation {
    if (
      !input.projectId.trim() ||
      !input.threadId.trim() ||
      input.projection.thread.id !== input.threadId ||
      !Number.isSafeInteger(input.sourceOrdinal) ||
      input.sourceOrdinal < 0
    )
      throw new Error("invalid_monitor_observation");
    const now = input.now ?? Date.now();
    if (!Number.isFinite(now)) throw new Error("invalid_monitor_time");

    return this.store.transaction(() => {
      this.store.db
        .prepare(`INSERT INTO supervisor_monitor_threads(project_id,thread_id,source_ordinal,activation_ordinal)
          VALUES(?,?,?,?) ON CONFLICT(project_id,thread_id) DO UPDATE SET
          source_ordinal=MAX(source_ordinal,excluded.source_ordinal),
          activation_ordinal=MIN(activation_ordinal,excluded.activation_ordinal)`)
        .run(input.projectId, input.threadId, input.sourceOrdinal, input.sourceOrdinal);
      const thread = this.threadRow(input.projectId, input.threadId)!;
      const currentFloor = Number(thread.source_ordinal);
      const activationOrdinal = Number(thread.activation_ordinal ?? input.sourceOrdinal);
      const reactivatedOrdinal = input.projection.runs
        .filter(
          (run) =>
            run.threadId === input.threadId &&
            run.ordinal >= activationOrdinal &&
            run.ordinal < currentFloor &&
            liveRunStatuses.has(run.status) &&
            isCurrentMainGraphRun(input.projection, run),
        )
        .reduce<number | null>(
          (lowest, run) => (lowest === null ? run.ordinal : Math.min(lowest, run.ordinal)),
          null,
        );
      const collectionFloor = reactivatedOrdinal ?? currentFloor;
      if (collectionFloor < currentFloor)
        this.store.db
          .prepare(`UPDATE supervisor_monitor_threads SET source_ordinal=?
            WHERE project_id=? AND thread_id=?`)
          .run(collectionFloor, input.projectId, input.threadId);

      const trackedIds = new Set(
        this.store.db
          .prepare("SELECT item_id FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
          .all(input.projectId, input.threadId)
          .map((row) => String(row.item_id)),
      );
      const activity = collectSupervisorActivity(
        input.projection,
        collectionFloor,
        now,
        input.excludedIds,
        trackedIds,
        input.includeDetachedChildItems === true,
        input.nativeChildLifecycle,
      );
      this.store.db
        .prepare("UPDATE supervisor_monitor_items SET active=0 WHERE project_id=? AND thread_id=?")
        .run(input.projectId, input.threadId);
      const activateItem = this.store.db.prepare(`UPDATE supervisor_monitor_items SET active=1
        WHERE project_id=? AND thread_id=? AND item_id=?`);
      for (const item of activity) activateItem.run(input.projectId, input.threadId, item.id);
      if (input.preserveNativeChildLifecycle === true)
        this.store.db
          .prepare(`UPDATE supervisor_monitor_items SET active=1
            WHERE project_id=? AND thread_id=? AND type='native_child_lifecycle'`)
          .run(input.projectId, input.threadId);
      this.store.db
        .prepare("DELETE FROM supervisor_monitor_items WHERE project_id=? AND thread_id=? AND active=0")
        .run(input.projectId, input.threadId);
      const sourceOrdinal = this.advanceSourceOrdinal(
        input.projectId,
        input.threadId,
        collectionFloor,
        input.projection,
        activity,
        input.includeDetachedChildItems === true,
      );
      if (sourceOrdinal !== collectionFloor)
        this.store.db
          .prepare(`UPDATE supervisor_monitor_threads SET source_ordinal=?
            WHERE project_id=? AND thread_id=?`)
          .run(sourceOrdinal, input.projectId, input.threadId);
      this.store.db
        .prepare(`DELETE FROM supervisor_monitor_items
          WHERE project_id=? AND thread_id=? AND ordinal<?
          AND type<>'native_child_lifecycle'
          AND (reviewed_version=version OR active=0)`)
        .run(input.projectId, input.threadId, sourceOrdinal);
      const currentActivity = activity.filter((item) => item.ordinal >= sourceOrdinal);
      let inserted = 0;
      let updated = 0;
      let untrackedCount = 0;
      const countRows = (): number =>
        Number(
          this.store.db
            .prepare("SELECT COUNT(*) AS count FROM supervisor_monitor_items WHERE project_id=? AND thread_id=?")
            .get(input.projectId, input.threadId)?.count ?? 0,
        );

      for (const item of currentActivity) {
        const current = this.itemRow(input.projectId, input.threadId, item.id);
        if (current) {
          if (String(current.version) === item.version) {
            if (current.active !== 1 || (current.read_item_id === null && item.readItemId !== null) ||
              item.type === "native_child_lifecycle" && Number(current.ordinal) !== item.ordinal)
              this.store.db
                .prepare(`UPDATE supervisor_monitor_items SET read_item_id=COALESCE(?,read_item_id),ordinal=?,active=1
                  WHERE project_id=? AND thread_id=? AND item_id=? AND version=?`)
                .run(item.readItemId, item.ordinal, input.projectId, input.threadId, item.id, item.version);
            continue;
          }
          const eligible = Number(current.eligible) === 1 || item.ordinal >= sourceOrdinal;
          this.store.db
            .prepare(`UPDATE supervisor_monitor_items SET read_item_id=COALESCE(?,read_item_id),type=?,status=?,ordinal=?,detected_at=?,version=?,
              priority=?,eligible=?,active=1,reviewed_version=?,updated_at=?
              WHERE project_id=? AND thread_id=? AND item_id=?`)
            .run(
              item.readItemId,
              item.type,
              item.status,
              item.ordinal,
              item.detectedAt,
              item.version,
              item.priority,
              eligible ? 1 : 0,
              eligible ? null : item.version,
              now,
              input.projectId,
              input.threadId,
              item.id,
            );
          updated++;
          continue;
        }
        const eligible = item.ordinal >= sourceOrdinal;
        if (!eligible) continue;
        if (countRows() >= this.maxItemsPerThread) {
          untrackedCount++;
          continue;
        }
        this.store.db
          .prepare(`INSERT INTO supervisor_monitor_items(
            project_id,thread_id,item_id,read_item_id,type,status,ordinal,detected_at,version,priority,eligible,active,reviewed_version,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            input.projectId,
            input.threadId,
            item.id,
            item.readItemId,
            item.type,
            item.status,
            item.ordinal,
            item.detectedAt,
            item.version,
            item.priority,
            1,
            1,
            null,
            now,
          );
        inserted++;
      }

      if (untrackedCount > 0) {
        this.store.db
          .prepare(`UPDATE supervisor_monitor_threads SET saturated=1,
            saturation_at=COALESCE(saturation_at,?),untracked_count=?
            WHERE project_id=? AND thread_id=?`)
          .run(now, untrackedCount, input.projectId, input.threadId);
      } else {
        this.store.db
          .prepare(`UPDATE supervisor_monitor_threads SET saturated=0,
            saturation_at=NULL,untracked_count=0
            WHERE project_id=? AND thread_id=?`)
          .run(input.projectId, input.threadId);
      }

      const pending = this.pending(input.projectId, input.threadId);
      const state = this.threadRow(input.projectId, input.threadId)!;
      return {
        projectId: input.projectId,
        threadId: input.threadId,
        sourceOrdinal,
        inserted,
        updated,
        pendingItemCount: pending.length,
        saturated: Number(state.saturated) === 1,
        untrackedCount,
      };
    });
  }

  pending(projectId: string, threadId: string): SupervisorMonitorActivity[] {
    return this.state(projectId, threadId).activities.filter(isReviewable);
  }

  state(projectId: string, threadId: string): SupervisorMonitorThreadState {
    const thread = this.threadRow(projectId, threadId);
    const activities = this.store.db
      .prepare(`SELECT item_id,read_item_id,type,status,ordinal,detected_at,version,priority,eligible,active,reviewed_version
        FROM supervisor_monitor_items WHERE project_id=? AND thread_id=? AND eligible=1
        AND active=1 AND (reviewed_version IS NULL OR reviewed_version<>version)
        ORDER BY ordinal,detected_at,item_id`)
      .all(projectId, threadId)
      .map((row) => asActivity(row as unknown as MonitorItemRow));
    return {
      projectId,
      threadId,
      sourceOrdinal: thread ? Number(thread.source_ordinal) : 0,
      activities,
      saturated: Number(thread?.saturated ?? 0) === 1,
      saturationAt: optionalNumber(thread?.saturation_at),
      lastAcknowledgedAt: optionalNumber(thread?.last_acknowledged_at),
      untrackedCount: Number(thread?.untracked_count ?? 0),
    };
  }

  hasState(projectId: string, threadId: string): boolean {
    return this.threadRow(projectId, threadId) !== undefined;
  }

  hasPendingReviewableActivity(projectId: string, threadIds: readonly string[]): SupervisorMonitorScopePendingScan {
    if (!projectId.trim() || !Array.isArray(threadIds) || threadIds.length < 1 || threadIds.length > 10_000 ||
      threadIds.some(threadId => typeof threadId !== "string" || !threadId.trim()) || new Set(threadIds).size !== threadIds.length)
      return {status: "incomplete"};
    for (let start = 0; start < threadIds.length; start += 400) {
      const ids = threadIds.slice(start, start + 400);
      const placeholders = ids.map(() => "?").join(",");
      try {
        const match = this.store.db.prepare(`SELECT 1 AS pending FROM supervisor_monitor_items
          WHERE project_id=? AND thread_id IN (${placeholders}) AND eligible=1 AND active=1
          AND (reviewed_version IS NULL OR reviewed_version<>version)
          AND (status IN ('completed','failed','cancelled','interrupted','resolved','expired') OR priority='waiting_input') LIMIT 1`)
          .get(projectId, ...ids);
        if (match) return {status: "complete", pending: true};
      } catch {return {status: "incomplete"};}
    }
    return {status: "complete", pending: false};
  }

  private advanceSourceOrdinal(
    projectId: string,
    threadId: string,
    currentFloor: number,
    projection: Projection,
    activity: readonly SupervisorMonitorActivity[],
    includeDetachedChildItems: boolean,
  ): number {
    const runs = projection.runs
      .filter((run) => run.threadId === threadId && run.ordinal >= currentFloor)
      .sort((left, right) => left.ordinal - right.ordinal);
    if (includeDetachedChildItems && projection.thread.lineage.relationshipToParent === "subagent" && runs.length === 0) {
      const detached = activity.filter((item) => item.type !== "native_child_lifecycle" && item.ordinal >= currentFloor);
      if (!detached.length) return currentFloor;
      const maxOrdinal = Math.max(...detached.map(item => item.ordinal));
      for (const item of detached) {
        if (!isReviewable(item)) continue;
        const row = this.itemRow(projectId, threadId, item.id);
        if (!row || Number(row.eligible) !== 1 || String(row.version) !== item.version || row.reviewed_version !== item.version)
          return currentFloor;
      }
      return Math.max(currentFloor, maxOrdinal + 1);
    }
    let floor = currentFloor;
    for (const run of runs) {
      if (run.ordinal !== floor) break;
      if (liveRunStatuses.has(run.status) && isCurrentMainGraphRun(projection, run)) break;
      const runActivity = activity.filter((item) => item.ordinal === run.ordinal);
      let fullyAcknowledged = true;
      for (const item of runActivity) {
        if (!isReviewable(item)) continue;
        const row = this.itemRow(projectId, threadId, item.id);
        if (
          !row ||
          Number(row.eligible) !== 1 ||
          String(row.version) !== item.version ||
          row.reviewed_version !== item.version
        ) {
          fullyAcknowledged = false;
          break;
        }
      }
      if (!fullyAcknowledged) break;
      floor = run.ordinal + 1;
    }
    return floor;
  }

  select(
    projectId: string,
    settings: SupervisorMonitoringSettings,
    now: number,
    lastProjectNoticeAt: number | null,
    optionsOrLimit: SupervisorMonitorSelectOptions | number = {},
    eligibleThreadIds?: ReadonlySet<string>,
  ): SupervisorMonitorBatch | null {
    if (!Number.isFinite(now)) return null;
    const options =
      typeof optionsOrLimit === "number"
        ? { maxItems: optionsOrLimit, eligibleThreadIds }
        : { ...optionsOrLimit, eligibleThreadIds: eligibleThreadIds ?? optionsOrLimit.eligibleThreadIds };
    const maxPreviewItems = boundedInteger(
      options.maxItems,
      SUPERVISOR_MONITOR_MAX_BATCH_ITEMS,
      SUPERVISOR_MONITOR_MAX_BATCH_ITEMS,
    );
    const maxPreviewItemsPerThread = boundedInteger(
      options.maxItemsPerThread,
      Math.min(SUPERVISOR_MONITOR_MAX_ITEMS_PER_CHAT, maxPreviewItems),
      Math.min(SUPERVISOR_MONITOR_MAX_ITEMS_PER_CHAT, maxPreviewItems),
    );
    const maxThreads = boundedInteger(options.maxThreads, SUPERVISOR_MONITOR_MAX_SELECTED_THREADS, SUPERVISOR_MONITOR_MAX_SELECTED_THREADS);
    const maxFrozenItems = boundedInteger(
      options.maxFrozenItems,
      SUPERVISOR_MONITOR_MAX_FROZEN_ITEMS_PER_BATCH,
      SUPERVISOR_MONITOR_MAX_FROZEN_ITEMS_PER_BATCH,
    );
    const rows = this.store.db
      .prepare("SELECT * FROM supervisor_monitor_threads WHERE project_id=? ORDER BY thread_id")
      .all(projectId) as unknown as MonitorThreadRow[];
    const due = rows
      .filter((row) => !options.eligibleThreadIds || options.eligibleThreadIds.has(String(row.thread_id)))
      .map((row) => {
        const threadId = String(row.thread_id);
        const state = this.state(projectId, threadId);
        const reviewable = state.activities.filter(isReviewable);
        const decision = evaluateSupervisorMonitoring(
          reviewable,
          settings,
          now,
          lastProjectNoticeAt,
          false,
        );
        return {
          ...state,
          decision,
          reviewable: reviewable.sort(compareMonitorPriority),
        };
      })
      .filter((candidate) => candidate.decision.due)
      .sort(threadSort);
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
        if (
          current.length >= maxPreviewItemsPerThread ||
          current.length >= candidate.reviewable.length
        )
          continue;
        current.push(candidate.reviewable[current.length]!);
        previewByThread.set(candidate.threadId, current);
        previewRemaining--;
        progressed = true;
        if (previewRemaining === 0) break;
      }
      if (!progressed) break;
    }

    const threads: SupervisorMonitorThreadBatch[] = [];
    for (const candidate of selectedCandidates) {
      threads.push(
        threadBatch(
          candidate.threadId,
          candidate.reviewable,
          previewByThread.get(candidate.threadId) ?? [],
          candidate.decision,
          candidate.saturated,
          candidate.untrackedCount,
        ),
      );
    }
    if (threads.length === 0) return null;
    const trigger = [...threads]
      .map((thread) => thread.trigger)
      .sort(compareMonitorTrigger)[0]!;
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
    };
  }

  acknowledge(batch: SupervisorMonitorBatch, reviewedAt = Date.now()): { acknowledged: number; stale: number } {
    if (!Number.isFinite(reviewedAt)) throw new Error("invalid_monitor_review_time");
    return this.store.transaction(() => this.acknowledgeInTransaction(batch, reviewedAt));
  }

  /** Acknowledges a frozen batch inside a caller-owned GuidanceStore transaction. */
  acknowledgeInTransaction(
    batch: SupervisorMonitorBatch,
    reviewedAt = Date.now(),
  ): { acknowledged: number; stale: number } {
    if (!Number.isFinite(reviewedAt)) throw new Error("invalid_monitor_review_time");
    let acknowledged = 0;
    let stale = 0;
    for (const thread of batch.threads) {
      let threadAcknowledged = 0;
      for (const item of thread.items) {
        const result = this.store.db
          .prepare(`UPDATE supervisor_monitor_items SET reviewed_version=version
            WHERE project_id=? AND thread_id=? AND item_id=? AND version=? AND eligible=1 AND active=1`)
          .run(batch.projectId, thread.threadId, item.id, item.version);
        if (result.changes > 0) {
          acknowledged++;
          threadAcknowledged++;
        } else stale++;
      }
      if (threadAcknowledged > 0)
        this.store.db
          .prepare(`UPDATE supervisor_monitor_threads SET last_acknowledged_at=?
            WHERE project_id=? AND thread_id=?`)
          .run(reviewedAt, batch.projectId, thread.threadId);
    }
    return { acknowledged, stale };
  }

  private threadRow(projectId: string, threadId: string): MonitorThreadRow | undefined {
    return this.store.db
      .prepare("SELECT * FROM supervisor_monitor_threads WHERE project_id=? AND thread_id=?")
      .get(projectId, threadId) as MonitorThreadRow | undefined;
  }

  private itemRow(projectId: string, threadId: string, itemId: string): MonitorItemRow | undefined {
    return this.store.db
      .prepare(`SELECT item_id,read_item_id,type,status,ordinal,detected_at,version,priority,eligible,active,reviewed_version
        FROM supervisor_monitor_items WHERE project_id=? AND thread_id=? AND item_id=?`)
      .get(projectId, threadId, itemId) as MonitorItemRow | undefined;
  }
}
