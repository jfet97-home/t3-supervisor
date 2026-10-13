import { randomUUID } from "node:crypto";
import type { GuidanceStore } from "./guidance-store.js";
import type { SupervisorMonitorBatch } from "./supervisor-monitor.js";
import type { WorkflowProposalInfo } from "./project-supervisor-contract.js";

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
export type WorkflowAgreementCandidate = {
  taskId: string;
  projectId: string;
  proposalId: string;
  planHash: string;
  workflow: WorkflowProposalInfo;
  supervisorMessageId: string;
  supervisorRunId: string;
  supervisorRunOrdinal: number;
  supervisorTextHash: string;
  proposedAt: number;
  agentMessageId?: string;
  agentTextHash?: string;
};

/** Keeps native request identities and unacknowledged activity through restarts. */
export class SupervisorConversationStore {
  constructor(readonly store: GuidanceStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS supervisor_conversation_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS supervisor_conversation_project ON supervisor_conversation_requests(project_id);
      CREATE TABLE IF NOT EXISTS supervisor_workflow_introductions(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_workflow_agreement_candidates(task_id TEXT NOT NULL,proposal_id TEXT NOT NULL,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(task_id,proposal_id));
      CREATE INDEX IF NOT EXISTS supervisor_workflow_agreement_project ON supervisor_workflow_agreement_candidates(project_id);
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
  removeUnsentIntroduction(taskId: string): void {
    const introduction = this.introduction(taskId);
    if (introduction && ["context", "ready", "blocked"].includes(introduction.state) && !introduction.dispatchMode &&
      !introduction.acceptedAt && !introduction.rejectedAttempts?.length)
      this.store.db.prepare("DELETE FROM supervisor_workflow_introductions WHERE task_id=?").run(taskId);
  }
  agreementCandidates(taskId: string): WorkflowAgreementCandidate[] {
    return this.store.db.prepare("SELECT document FROM supervisor_workflow_agreement_candidates WHERE task_id=? ORDER BY created_at,rowid").all(taskId)
      .map(row => JSON.parse(String(row.document)) as WorkflowAgreementCandidate);
  }
  agreementCandidate(taskId: string, proposalId: string): WorkflowAgreementCandidate | null {
    const row = this.store.db.prepare("SELECT document FROM supervisor_workflow_agreement_candidates WHERE task_id=? AND proposal_id=?").get(taskId, proposalId);
    return row ? JSON.parse(String(row.document)) as WorkflowAgreementCandidate : null;
  }
  saveAgreementCandidate(candidate: WorkflowAgreementCandidate): "saved" | "same" | "conflict" | "full" {
    const existing = this.agreementCandidate(candidate.taskId, candidate.proposalId);
    if (existing) return existing.planHash === candidate.planHash ? "same" : "conflict";
    const taskCount = Number(this.store.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_agreement_candidates WHERE task_id=?").get(candidate.taskId)?.n ?? 0);
    const projectCount = Number(this.store.db.prepare("SELECT count(*) AS n FROM supervisor_workflow_agreement_candidates WHERE project_id=?").get(candidate.projectId)?.n ?? 0);
    if (taskCount >= 50 || projectCount >= 5000) return "full";
    this.store.db.prepare("INSERT INTO supervisor_workflow_agreement_candidates VALUES(?,?,?,?,?)")
      .run(candidate.taskId, candidate.proposalId, candidate.projectId, JSON.stringify(candidate), candidate.proposedAt);
    return "saved";
  }
  saveAgreementEvidence(taskId: string, proposalId: string, agentMessageId: string, agentTextHash: string): void {
    const candidate = this.agreementCandidate(taskId, proposalId);
    if (!candidate || candidate.agentMessageId && (candidate.agentMessageId !== agentMessageId || candidate.agentTextHash !== agentTextHash)) return;
    this.store.db.prepare("UPDATE supervisor_workflow_agreement_candidates SET document=? WHERE task_id=? AND proposal_id=?")
      .run(JSON.stringify({...candidate, agentMessageId, agentTextHash}), taskId, proposalId);
  }
  clearAgreementCandidates(taskId: string): void {
    this.store.db.prepare("DELETE FROM supervisor_workflow_agreement_candidates WHERE task_id=?").run(taskId);
  }
  pruneAgreementCandidates(taskIds: readonly string[]): void {
    if (taskIds.length === 0) return;
    const placeholders = taskIds.map(() => "?").join(",");
    this.store.db.prepare(`DELETE FROM supervisor_workflow_agreement_candidates WHERE task_id IN (${placeholders})`).run(...taskIds);
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
