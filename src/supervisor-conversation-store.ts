import { randomUUID } from "node:crypto";
import type { GuidanceStore } from "./guidance-store.js";
import type { SupervisorMonitorBatch } from "./supervisor-monitor.js";

export type ConversationRequest = {
  id: string;
  projectId: string;
  supervisorThreadId: string;
  kind: "context" | "review";
  taskId: string | null;
  text: string;
  messageId: string;
  state: "prepared" | "sending" | "waiting" | "uncertain" | "completed" | "failed";
  batch: SupervisorMonitorBatch | null;
  createdAt: number;
  sentAt: number | null;
  runId: string | null;
  error: string | null;
  completionMarker: string;
  failureAcknowledged?: boolean;
};
export type WorkflowIntroduction = {
  taskId: string;
  projectId: string;
  threadId: string;
  supervisorThreadId: string;
  state: "context" | "ready" | "sending" | "accepted" | "sent" | "uncertain" | "blocked";
  text: string;
  messageId: string;
  targetRunId: string | null;
  dispatchMode?: {type: "steer_active"; targetRunId: string} | {type: "queue_after_active"};
  acceptedAt?: number;
  visibilityMisses?: number;
  commandId?: string;
  definiteRejection?: boolean;
  rejectedAttempts?: Array<{messageId: string; commandId: string; dispatchMode: WorkflowIntroduction["dispatchMode"]}>;
  error: string | null;
};

/** Keeps native request identities and unacknowledged activity through restarts. */
export class SupervisorConversationStore {
  constructor(readonly store: GuidanceStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS supervisor_conversation_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS supervisor_conversation_project ON supervisor_conversation_requests(project_id);
      CREATE TABLE IF NOT EXISTS supervisor_workflow_introductions(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_monitor_project_clock(project_id TEXT PRIMARY KEY,last_notice_at INTEGER NOT NULL,review_misses INTEGER NOT NULL DEFAULT 0);`);
    if (!store.db.prepare("PRAGMA table_info(supervisor_monitor_project_clock)").all().some(row => row.name === "review_misses")) store.db.exec("ALTER TABLE supervisor_monitor_project_clock ADD COLUMN review_misses INTEGER NOT NULL DEFAULT 0");
  }
  requests(projectId: string): ConversationRequest[] {
    return this.store.db.prepare("SELECT document FROM supervisor_conversation_requests WHERE project_id=? ORDER BY created_at").all(projectId)
      .map(row => JSON.parse(String(row.document)) as ConversationRequest);
  }
  pending(projectId: string): ConversationRequest | null {
    return this.requests(projectId).find(request => ["prepared", "sending", "waiting", "uncertain"].includes(request.state)) ?? null;
  }
  saveRequest(request: ConversationRequest): void {
    this.store.db.prepare("INSERT INTO supervisor_conversation_requests VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document")
      .run(request.id, request.projectId, JSON.stringify(request), request.createdAt);
  }
  prepare(input: Pick<ConversationRequest, "projectId" | "supervisorThreadId" | "kind" | "taskId" | "text" | "batch" | "completionMarker">, now: number): ConversationRequest {
    if (this.pending(input.projectId)) throw new Error("supervisor_request_inflight");
    this.prune(now);
    const id = randomUUID();
    const request: ConversationRequest = {...input, id, messageId: `supervisor-review:${id}`, state: "prepared", createdAt: now, sentAt: null, runId: null, error: null};
    this.saveRequest(request);return request;
  }
  introduction(taskId: string): WorkflowIntroduction | null {
    const row = this.store.db.prepare("SELECT document FROM supervisor_workflow_introductions WHERE task_id=?").get(taskId);
    return row ? JSON.parse(String(row.document)) as WorkflowIntroduction : null;
  }
  introductions(projectId: string): WorkflowIntroduction[] {
    return this.store.db.prepare("SELECT document FROM supervisor_workflow_introductions WHERE project_id=?").all(projectId)
      .map(row => JSON.parse(String(row.document)) as WorkflowIntroduction);
  }
  saveIntroduction(introduction: WorkflowIntroduction): void {
    this.store.db.prepare("INSERT INTO supervisor_workflow_introductions VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET document=excluded.document")
      .run(introduction.taskId, introduction.projectId, JSON.stringify(introduction));
  }
  lastNotice(projectId: string): number | null {
    const row = this.store.db.prepare("SELECT last_notice_at FROM supervisor_monitor_project_clock WHERE project_id=?").get(projectId);
    return row ? Number(row.last_notice_at) : null;
  }
  noticeSent(projectId: string, now: number): void {
    this.store.db.prepare("INSERT INTO supervisor_monitor_project_clock(project_id,last_notice_at) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET last_notice_at=excluded.last_notice_at").run(projectId, now);
  }
  reviewMisses(projectId: string, reset = false): number {
    if (reset) this.store.db.prepare("UPDATE supervisor_monitor_project_clock SET review_misses=0 WHERE project_id=?").run(projectId);
    return Number(this.store.db.prepare("SELECT review_misses FROM supervisor_monitor_project_clock WHERE project_id=?").get(projectId)?.review_misses ?? 0);
  }
  missedReview(projectId: string): number {
    this.store.db.prepare("UPDATE supervisor_monitor_project_clock SET review_misses=review_misses+1 WHERE project_id=?").run(projectId);
    return this.reviewMisses(projectId);
  }
  prune(now: number): void {
    for (const request of this.store.db.prepare("SELECT id,document FROM supervisor_conversation_requests WHERE created_at<?").all(now - 30 * 86400_000)) {
      const value = JSON.parse(String(request.document)) as ConversationRequest;
      if (value.state === "completed" || value.state === "failed" && (value.kind !== "review" || value.failureAcknowledged)) this.store.db.prepare("DELETE FROM supervisor_conversation_requests WHERE id=?").run(String(request.id));
    }
    const terminalCount = new Map<string, number>();
    for (const row of this.store.db.prepare("SELECT id,document FROM supervisor_conversation_requests ORDER BY created_at DESC,rowid DESC").all()) {
      const request = JSON.parse(String(row.document)) as ConversationRequest;
      if (request.state !== "completed" && !(request.state === "failed" && (request.kind !== "review" || request.failureAcknowledged))) continue;
      const n = (terminalCount.get(request.projectId) ?? 0) + 1;terminalCount.set(request.projectId, n);
      if (n > 100) this.store.db.prepare("DELETE FROM supervisor_conversation_requests WHERE id=?").run(String(row.id));
    }
  }
}
