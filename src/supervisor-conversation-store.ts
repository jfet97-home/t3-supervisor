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
  error: string | null;
};

/** Keeps native request identities and unacknowledged activity through restarts. */
export class SupervisorConversationStore {
  constructor(readonly store: GuidanceStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS supervisor_conversation_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS supervisor_conversation_project ON supervisor_conversation_requests(project_id);
      CREATE TABLE IF NOT EXISTS supervisor_workflow_introductions(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_monitor_project_clock(project_id TEXT PRIMARY KEY,last_notice_at INTEGER NOT NULL);`);
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
    if (this.requests(input.projectId).length >= 1000) throw new Error("supervisor_request_capacity");
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
    this.store.db.prepare("INSERT INTO supervisor_monitor_project_clock VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET last_notice_at=excluded.last_notice_at").run(projectId, now);
  }
  prune(now: number): void {
    for (const request of this.store.db.prepare("SELECT id,document FROM supervisor_conversation_requests WHERE created_at<?").all(now - 30 * 86400_000)) {
      const value = JSON.parse(String(request.document)) as ConversationRequest;
      if (value.state === "completed" || value.state === "failed") this.store.db.prepare("DELETE FROM supervisor_conversation_requests WHERE id=?").run(String(request.id));
    }
  }
}
