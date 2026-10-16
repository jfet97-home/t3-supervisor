import { randomUUID } from "node:crypto";
import type { ProjectSupervisorStore, BindingRecord } from "./project-supervisor-store.js";
import type { SupervisorModelSelection } from "./project-supervisor-contract.js";

export type TeamBinding = Pick<BindingRecord, "projectId" | "mainThreadId" | "threadId" | "generation">;
export type TeamMemberState = "registering" | "ready" | "missing" | "retired";
export type TeamAssignmentState = "active" | "transferring";
export type TeamCoverageState = "root" | "assigned" | "transferring" | "unavailable";

export type TeamMember = {
  threadId: string;
  taskId: string;
  bootstrapRunId: string;
  title: string | null;
  modelSelection: SupervisorModelSelection | null;
  state: TeamMemberState;
  epoch: number;
  registeredAt: number;
  updatedAt: number;
  lastAssessment: string | null;
};

export type TeamAssignment = {
  id: string;
  subtreeRootThreadId: string;
  memberThreadId: string | null;
  state: TeamAssignmentState;
  epoch: number;
  createdAt: number;
  updatedAt: number;
  fromMemberThreadId?: string | null;
  toMemberThreadId?: string | null;
  fromAssignmentRootThreadId?: string | null;
  remainingAssignmentRoots?: string[];
  pendingRequestIds?: string[];
};

export type TeamCoverage = {
  actorThreadId: string;
  state: TeamCoverageState;
  memberEpoch: number | null;
  assignmentRootThreadId: string | null;
  assignmentEpoch: number | null;
};

export type TeamAuthority = { actorThreadId: string; role: "root" | "helper"; memberEpoch: number | null };
export type TeamExpectedAuthority = { memberEpoch?: number; assignmentRootThreadId?: string | null; assignmentEpoch?: number | null };

export type TeamNotificationKind = "handover_release" | "handover_receive" | "note";
export type TeamNotificationState = "pending" | "sending" | "uncertain" | "delivered" | "acknowledged" | "superseded";
export type TeamNotification = {
  id: string;
  kind: TeamNotificationKind;
  recipientThreadId: string;
  memberEpoch: number;
  assignmentRootThreadId: string | null;
  assignmentEpoch: number | null;
  message: string;
  remainingAssignmentRoots: string[];
  state: TeamNotificationState;
  createdAt: number;
  updatedAt: number;
};

export type TeamEventKind = "member_registered" | "member_ready" | "member_missing" | "member_retired" |
  "service_attention" | "assignment_handover_started" | "assignment_handover_completed" | "note" | "assessment" | "escalation";
export type TeamEvent = {
  id: string;
  kind: TeamEventKind;
  actorThreadId: string | null;
  memberThreadId: string | null;
  targetThreadId: string | null;
  assignmentRootThreadId: string | null;
  summary: string;
  severity: "info" | "result" | "attention";
  createdAt: number;
  acknowledgedAt: number | null;
};

export type TeamRequestTarget = { targetThreadId: string; assignmentRootThreadId: string; assignmentEpoch: number };
export type TeamRequestState = "pending" | "uncertain" | "settled";
export type TeamRequest = {
  requestId: string;
  memberThreadId: string;
  memberEpoch: number;
  targets: TeamRequestTarget[];
  state: TeamRequestState;
  createdAt: number;
  updatedAt: number;
};

export type TeamSettings = { maxHelpersPerRoot: number; generation: number };
export type SupervisorTeamSnapshot = {
  root: { threadId: string; title: string; modelSelection: SupervisorModelSelection };
  settings: TeamSettings;
  members: TeamMember[];
  assignments: TeamAssignment[];
  notifications: TeamNotification[];
  events: TeamEvent[];
};

const DEFAULT_MAX_HELPERS = 5;
const MAX_CONFIGURED_HELPERS = 20;
const MAX_REQUEST_TARGETS = 100;
const MAX_EVENTS = 20_000;
const MAX_NOTIFICATIONS = 20_000;
const MAX_REQUESTS = 20_000;

const parseDocument = <A>(value: unknown): A => JSON.parse(String(value)) as A;
const sortedUnique = (values: ReadonlyArray<string>): string[] => [...new Set(values)].sort();
const isNonEmpty = (value: string): boolean => value.trim().length > 0;

export class SupervisorTeamStore {
  constructor(readonly supervisors: ProjectSupervisorStore) {
    const db = supervisors.store.db;
    db.exec(`CREATE INDEX IF NOT EXISTS supervisor_main_binding_thread ON supervisor_main_bindings(json_extract(document,'$.threadId'));
      CREATE TABLE IF NOT EXISTS supervisor_team_members(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,member_thread_id TEXT NOT NULL,state TEXT NOT NULL,epoch INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,member_thread_id));
      CREATE UNIQUE INDEX IF NOT EXISTS supervisor_team_member_identity ON supervisor_team_members(member_thread_id) WHERE state<>'retired';
      CREATE TABLE IF NOT EXISTS supervisor_team_assignments(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,subtree_root_thread_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,subtree_root_thread_id));
      CREATE TABLE IF NOT EXISTS supervisor_team_notifications(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,id TEXT NOT NULL,recipient_thread_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,id));
      CREATE INDEX IF NOT EXISTS supervisor_team_notifications_recipient ON supervisor_team_notifications(owner_thread_id,owner_generation,recipient_thread_id,state,created_at);
      CREATE TABLE IF NOT EXISTS supervisor_team_events(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,id TEXT NOT NULL,created_at INTEGER NOT NULL,acknowledged_at INTEGER,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,id));
      CREATE INDEX IF NOT EXISTS supervisor_team_events_pending ON supervisor_team_events(owner_thread_id,owner_generation,acknowledged_at,created_at);
      CREATE TABLE IF NOT EXISTS supervisor_team_requests(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,request_id));
      CREATE INDEX IF NOT EXISTS supervisor_team_requests_pending ON supervisor_team_requests(owner_thread_id,owner_generation,state,created_at);`);
    db.prepare("UPDATE supervisor_team_notifications SET state='uncertain',document=json_set(document,'$.state','uncertain') WHERE state='sending'").run();
  }

  private currentBinding(binding: TeamBinding): BindingRecord {
    const row = this.supervisors.store.db.prepare("SELECT document FROM supervisor_main_bindings WHERE json_extract(document,'$.threadId')=?").get(binding.threadId);
    if (!row) throw new Error("supervisor_team_binding_stale");
    const current = parseDocument<BindingRecord>(row.document);
    if (current.projectId !== binding.projectId || current.mainThreadId !== binding.mainThreadId || current.generation !== binding.generation)
      throw new Error("supervisor_team_binding_stale");
    return current;
  }

  private atomic<A>(f: () => A): A {
    return this.supervisors.store.db.isTransaction ? f() : this.supervisors.store.transaction(f);
  }

  private settingsRecord(binding: TeamBinding): TeamSettings {
    this.currentBinding(binding);
    const settings = this.supervisors.settings(binding.projectId);
    return { maxHelpersPerRoot: settings.teamSettings?.maxHelpersPerRoot ?? DEFAULT_MAX_HELPERS, generation: settings.generation };
  }

  settings(binding: TeamBinding): TeamSettings { return this.settingsRecord(binding); }

  setMaxHelpersPerRoot(binding: TeamBinding, expectedGeneration: number, maxHelpersPerRoot: number): TeamSettings {
    this.currentBinding(binding);
    if (!Number.isSafeInteger(maxHelpersPerRoot) || maxHelpersPerRoot < 0 || maxHelpersPerRoot > MAX_CONFIGURED_HELPERS)
      throw new Error("supervisor_team_invalid_helper_limit");
    const current = this.supervisors.settings(binding.projectId);
    if (current.generation !== expectedGeneration) throw new Error("supervisor_team_settings_conflict");
    const next = this.supervisors.saveSettings(binding.projectId, expectedGeneration, current.modelSelection, current.monitoring, { maxHelpersPerRoot });
    return { maxHelpersPerRoot: next.teamSettings?.maxHelpersPerRoot ?? maxHelpersPerRoot, generation: next.generation };
  }

  private member(binding: TeamBinding, threadId: string): TeamMember | null {
    const row = this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_members WHERE owner_thread_id=? AND owner_generation=? AND member_thread_id=?")
      .get(binding.threadId, binding.generation, threadId);
    return row ? parseDocument<TeamMember>(row.document) : null;
  }

  private membersFor(binding: TeamBinding): TeamMember[] {
    return this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_members WHERE owner_thread_id=? AND owner_generation=? ORDER BY rowid")
      .all(binding.threadId, binding.generation).map(row => parseDocument<TeamMember>(row.document));
  }

  private saveMember(binding: TeamBinding, member: TeamMember): void {
    this.supervisors.store.db.prepare("INSERT INTO supervisor_team_members VALUES(?,?,?,?,?,?) ON CONFLICT(owner_thread_id,owner_generation,member_thread_id) DO UPDATE SET state=excluded.state,epoch=excluded.epoch,document=excluded.document")
      .run(binding.threadId, binding.generation, member.threadId, member.state, member.epoch, JSON.stringify(member));
  }

  private assignment(binding: TeamBinding, subtreeRootThreadId: string): TeamAssignment | null {
    const row = this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_assignments WHERE owner_thread_id=? AND owner_generation=? AND subtree_root_thread_id=?")
      .get(binding.threadId, binding.generation, subtreeRootThreadId);
    return row ? parseDocument<TeamAssignment>(row.document) : null;
  }

  private assignmentsFor(binding: TeamBinding): TeamAssignment[] {
    return this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_assignments WHERE owner_thread_id=? AND owner_generation=? ORDER BY subtree_root_thread_id")
      .all(binding.threadId, binding.generation).map(row => parseDocument<TeamAssignment>(row.document));
  }

  private saveAssignment(binding: TeamBinding, assignment: TeamAssignment): void {
    this.supervisors.store.db.prepare("INSERT INTO supervisor_team_assignments VALUES(?,?,?,?) ON CONFLICT(owner_thread_id,owner_generation,subtree_root_thread_id) DO UPDATE SET document=excluded.document")
      .run(binding.threadId, binding.generation, assignment.subtreeRootThreadId, JSON.stringify(assignment));
  }

  bindingForActor(actorThreadId: string, bindingGeneration: number): BindingRecord | null {
    const db = this.supervisors.store.db;
    const rootRow = db.prepare("SELECT document FROM supervisor_main_bindings WHERE json_extract(document,'$.threadId')=?").get(actorThreadId);
    if (rootRow) {
      const binding = parseDocument<BindingRecord>(rootRow.document);
      return binding.generation === bindingGeneration ? binding : null;
    }
    const row = db.prepare("SELECT owner_thread_id,owner_generation,document FROM supervisor_team_members WHERE member_thread_id=? AND state IN ('registering','ready')").get(actorThreadId);
    if (!row) return null;
    const root = db.prepare("SELECT document FROM supervisor_main_bindings WHERE json_extract(document,'$.threadId')=?").get(String(row.owner_thread_id));
    if (!root) return null;
    const binding = parseDocument<BindingRecord>(root.document);
    return binding.generation === bindingGeneration && binding.generation === Number(row.owner_generation) ? binding : null;
  }

  resolveActor(binding: TeamBinding, actorThreadId: string, expectedMemberEpoch?: number): TeamAuthority | null {
    this.currentBinding(binding);
    if (actorThreadId === binding.threadId) return { actorThreadId, role: "root", memberEpoch: null };
    const member = this.member(binding, actorThreadId);
    if (!member || member.state !== "ready" || expectedMemberEpoch === undefined || member.epoch !== expectedMemberEpoch)
      return null;
    return { actorThreadId, role: "helper", memberEpoch: member.epoch };
  }

  private inBindingScope(binding: TeamBinding, targetId: string, parentById: ReadonlyMap<string, string | null>): boolean {
    if (targetId === binding.mainThreadId) return true;
    const seen = new Set<string>([targetId]);
    let current = targetId;
    for (let depth = 0; depth < 256; depth += 1) {
      const parent = parentById.get(current);
      if (parent === binding.mainThreadId) return true;
      if (!parent || seen.has(parent)) return false;
      seen.add(parent);
      current = parent;
    }
    return false;
  }

  private subtreeRelation(binding: TeamBinding, targetId: string, subtreeRootThreadId: string, parentById: ReadonlyMap<string, string | null>): "inside" | "outside" | "unknown" {
    if (targetId === subtreeRootThreadId) return "inside";
    const seen = new Set<string>([targetId]);
    let current = targetId;
    for (let depth = 0; depth < 256; depth += 1) {
      const parent = parentById.get(current);
      if (parent === undefined) return "unknown";
      if (parent === subtreeRootThreadId) return "inside";
      if (parent === binding.mainThreadId || parent === null) return "outside";
      if (seen.has(parent)) return "unknown";
      seen.add(parent);
      current = parent;
    }
    return "unknown";
  }

  coverage(binding: TeamBinding, targetId: string, parentById: ReadonlyMap<string, string | null>): TeamCoverage {
    this.currentBinding(binding);
    if (!this.inBindingScope(binding, targetId, parentById))
      return { actorThreadId: binding.threadId, state: "unavailable", memberEpoch: null, assignmentRootThreadId: null, assignmentEpoch: null };
    if (targetId === binding.mainThreadId)
      return { actorThreadId: binding.threadId, state: "root", memberEpoch: null, assignmentRootThreadId: null, assignmentEpoch: null };
    const byRoot = new Map(this.assignmentsFor(binding).map(assignment => [assignment.subtreeRootThreadId, assignment]));
    let current = targetId;
    for (let depth = 0; depth < 256 && current !== binding.mainThreadId; depth += 1) {
      const assignment = byRoot.get(current);
      if (assignment) {
        if (assignment.state === "transferring")
          return { actorThreadId: binding.threadId, state: "transferring", memberEpoch: null,
            assignmentRootThreadId: assignment.subtreeRootThreadId, assignmentEpoch: assignment.epoch };
        if (!assignment.memberThreadId) {
          if (this.requestsFor(binding).some(request => request.state !== "settled" && request.targets.some(target => {
            const relation = this.subtreeRelation(binding, target.targetThreadId, assignment.subtreeRootThreadId, parentById);
            return relation === "inside" || relation === "unknown";
          })))
            return { actorThreadId: binding.threadId, state: "unavailable", memberEpoch: null,
              assignmentRootThreadId: assignment.subtreeRootThreadId, assignmentEpoch: assignment.epoch };
          return { actorThreadId: binding.threadId, state: "root", memberEpoch: null,
            assignmentRootThreadId: assignment.subtreeRootThreadId, assignmentEpoch: assignment.epoch };
        }
        const member = this.member(binding, assignment.memberThreadId);
        if (!member || member.state !== "ready")
          return { actorThreadId: binding.threadId, state: "unavailable", memberEpoch: null,
            assignmentRootThreadId: assignment.subtreeRootThreadId, assignmentEpoch: assignment.epoch };
        return { actorThreadId: member.threadId, state: "assigned", memberEpoch: member.epoch,
          assignmentRootThreadId: assignment.subtreeRootThreadId, assignmentEpoch: assignment.epoch };
      }
      const parent = parentById.get(current);
      if (!parent) break;
      current = parent;
    }
    return { actorThreadId: binding.threadId, state: "root", memberEpoch: null, assignmentRootThreadId: null, assignmentEpoch: null };
  }

  authorizeWrite(binding: TeamBinding, actorThreadId: string, targetId: string, parentById: ReadonlyMap<string, string | null>, expectedAuthority: TeamExpectedAuthority = {}): boolean {
    const actor = actorThreadId === binding.threadId
      ? this.resolveActor(binding, actorThreadId)
      : this.resolveActor(binding, actorThreadId, expectedAuthority.memberEpoch);
    if (!actor) return false;
    const current = this.coverage(binding, targetId, parentById);
    if (current.state !== (actor.role === "root" ? "root" : "assigned") || current.actorThreadId !== actorThreadId) return false;
    if (actor.role === "root") return true;
    return expectedAuthority.memberEpoch === current.memberEpoch &&
      expectedAuthority.assignmentRootThreadId === current.assignmentRootThreadId &&
      expectedAuthority.assignmentEpoch === current.assignmentEpoch;
  }

  registerMember(binding: TeamBinding, input: { threadId: string; taskId: string; bootstrapRunId: string; title?: string | null; modelSelection?: SupervisorModelSelection | null; now?: number }): TeamMember {
    this.currentBinding(binding);
    if (!isNonEmpty(input.threadId) || input.threadId === binding.threadId || input.threadId === binding.mainThreadId ||
      !isNonEmpty(input.taskId) || !isNonEmpty(input.bootstrapRunId)) throw new Error("supervisor_team_invalid_member");
    const now = input.now ?? Date.now();
    const member = this.atomic(() => {
      const existing = this.member(binding, input.threadId);
      if (existing && existing.state !== "retired") throw new Error("supervisor_team_member_exists");
      const activeCount = this.membersFor(binding).filter(value => value.state !== "retired").length;
      if (activeCount >= this.settingsRecord(binding).maxHelpersPerRoot) throw new Error("supervisor_team_helper_limit");
      const globallyOwned = this.supervisors.store.db.prepare("SELECT 1 FROM supervisor_team_members WHERE member_thread_id=? AND state<>'retired'").get(input.threadId);
      if (globallyOwned && !existing) throw new Error("supervisor_team_member_owned_elsewhere");
      const next: TeamMember = { threadId: input.threadId, taskId: input.taskId, bootstrapRunId: input.bootstrapRunId,
        title: input.title ?? null, modelSelection: input.modelSelection ?? null, state: "registering", epoch: (existing?.epoch ?? 0) + 1,
        registeredAt: now, updatedAt: now, lastAssessment: null };
      this.saveMember(binding, next);
      this.supervisors.store.db.prepare("INSERT OR IGNORE INTO supervisor_owned_threads VALUES(?)").run(input.threadId);
      this.addEvent(binding, { kind: "member_registered", actorThreadId: binding.threadId, memberThreadId: input.threadId,
        targetThreadId: null, assignmentRootThreadId: null, summary: "A helper is registered and awaiting its readiness check.", severity: "info", createdAt: now });
      return next;
    });
    this.supervisors.ownedIds.add(input.threadId);
    return member;
  }

  markReady(binding: TeamBinding, actorThreadId: string, expectedMemberEpoch: number, now = Date.now()): TeamMember {
    this.currentBinding(binding);
    if (actorThreadId === binding.threadId) throw new Error("supervisor_team_helper_actor_required");
    return this.atomic(() => {
      const member = this.member(binding, actorThreadId);
      if (!member || member.state !== "registering" || member.epoch !== expectedMemberEpoch) throw new Error("supervisor_team_member_epoch_conflict");
      const next: TeamMember = { ...member, state: "ready", epoch: member.epoch + 1, updatedAt: now };
      this.saveMember(binding, next);
      this.addEvent(binding, { kind: "member_ready", actorThreadId, memberThreadId: actorThreadId, targetThreadId: null,
        assignmentRootThreadId: null, summary: "The helper completed its readiness check.", severity: "info", createdAt: now });
      return next;
    });
  }

  private validAssignmentRoot(binding: TeamBinding, subtreeRootThreadId: string, parentById: ReadonlyMap<string, string | null>): void {
    if (subtreeRootThreadId === binding.mainThreadId || !this.inBindingScope(binding, subtreeRootThreadId, parentById))
      throw new Error("supervisor_team_assignment_out_of_scope");
  }

  private notificationsFor(binding: TeamBinding): TeamNotification[] {
    return this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_notifications WHERE owner_thread_id=? AND owner_generation=? ORDER BY created_at")
      .all(binding.threadId, binding.generation).map(row => parseDocument<TeamNotification>(row.document));
  }

  private saveNotification(binding: TeamBinding, notification: TeamNotification): void {
    this.supervisors.store.db.prepare("INSERT INTO supervisor_team_notifications VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_thread_id,owner_generation,id) DO UPDATE SET state=excluded.state,document=excluded.document")
      .run(binding.threadId, binding.generation, notification.id, notification.recipientThreadId, notification.state, notification.createdAt, JSON.stringify(notification));
  }

  private addNotification(binding: TeamBinding, input: Omit<TeamNotification, "createdAt" | "updatedAt" | "state">, now: number): TeamNotification {
    const count = Number(this.supervisors.store.db.prepare("SELECT count(*) AS n FROM supervisor_team_notifications WHERE owner_thread_id=? AND owner_generation=?")
      .get(binding.threadId, binding.generation)?.n);
    if (count >= MAX_NOTIFICATIONS) throw new Error("supervisor_team_notification_capacity");
    const notification: TeamNotification = { ...input, state: "pending", createdAt: now, updatedAt: now };
    this.saveNotification(binding, notification);
    return notification;
  }

  private addEvent(binding: TeamBinding, input: Omit<TeamEvent, "id" | "acknowledgedAt"> & { id?: string }): TeamEvent {
    const id = input.id ?? randomUUID();
    const existing = this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_events WHERE owner_thread_id=? AND owner_generation=? AND id=?")
      .get(binding.threadId, binding.generation, id);
    if (existing) {
      const old = parseDocument<TeamEvent>(existing.document);
      if (old.kind !== input.kind || old.actorThreadId !== input.actorThreadId || old.memberThreadId !== input.memberThreadId ||
        old.targetThreadId !== input.targetThreadId || old.assignmentRootThreadId !== input.assignmentRootThreadId ||
        old.summary !== input.summary || old.severity !== input.severity) throw new Error("supervisor_team_event_identity_conflict");
      return old;
    }
    const count = Number(this.supervisors.store.db.prepare("SELECT count(*) AS n FROM supervisor_team_events WHERE owner_thread_id=? AND owner_generation=?")
      .get(binding.threadId, binding.generation)?.n);
    if (count >= MAX_EVENTS) throw new Error("supervisor_team_event_capacity");
    const event: TeamEvent = { ...input, id, acknowledgedAt: null };
    this.supervisors.store.db.prepare("INSERT OR IGNORE INTO supervisor_team_events VALUES(?,?,?,?,?,?)")
      .run(binding.threadId, binding.generation, event.id, event.createdAt, null, JSON.stringify(event));
    return event;
  }

  private remainingAssignments(binding: TeamBinding, memberThreadId: string, exceptRoot: string): string[] {
    return sortedUnique(this.assignmentsFor(binding).filter(value => value.subtreeRootThreadId !== exceptRoot &&
      value.state === "active" && value.memberThreadId === memberThreadId).map(value => value.subtreeRootThreadId));
  }

  assign(binding: TeamBinding, subtreeRootThreadId: string, memberThreadId: string | null, parentById: ReadonlyMap<string, string | null>, now = Date.now()): TeamAssignment {
    return this.beginTransfer(binding, subtreeRootThreadId, memberThreadId, parentById, now);
  }

  release(binding: TeamBinding, subtreeRootThreadId: string, parentById: ReadonlyMap<string, string | null>, now = Date.now()): TeamAssignment {
    return this.beginTransfer(binding, subtreeRootThreadId, null, parentById, now);
  }

  beginTransfer(binding: TeamBinding, subtreeRootThreadId: string, toMemberThreadId: string | null, parentById: ReadonlyMap<string, string | null>, now = Date.now()): TeamAssignment {
    this.currentBinding(binding);
    this.validAssignmentRoot(binding, subtreeRootThreadId, parentById);
    if (toMemberThreadId !== null) {
      const member = this.member(binding, toMemberThreadId);
      if (!member || member.state !== "ready") throw new Error("supervisor_team_member_not_ready");
    }
    return this.atomic(() => {
      const existing = this.assignment(binding, subtreeRootThreadId);
      if (existing?.state === "transferring") {
        if (existing.toMemberThreadId !== toMemberThreadId) throw new Error("supervisor_team_handover_in_progress");
        return existing;
      }
      if (existing?.state === "active" && existing.memberThreadId === toMemberThreadId) return existing;
      const inherited = existing ? null : this.coverage(binding, subtreeRootThreadId, parentById);
      const fromMemberThreadId = existing ? existing.memberThreadId : inherited?.state === "assigned" ? inherited.actorThreadId : null;
      const fromAssignmentRootThreadId = existing ? (existing.memberThreadId ? subtreeRootThreadId : null) : inherited?.assignmentRootThreadId ?? null;
      const epoch = (existing?.epoch ?? 0) + 1;
      const remaining = fromMemberThreadId ? this.remainingAssignments(binding, fromMemberThreadId, subtreeRootThreadId) : [];
      const pendingRequestIds: string[] = [];
      for (const request of this.requestsFor(binding)) {
        if (request.state === "settled") continue;
        let affected = false;
        for (const target of request.targets) {
          const relation = this.subtreeRelation(binding, target.targetThreadId, subtreeRootThreadId, parentById);
          if (relation === "inside") { affected = true;break; }
          if (relation === "unknown") throw new Error("supervisor_team_handover_scope_unavailable");
        }
        if (affected) pendingRequestIds.push(request.requestId);
      }
      const assignment: TeamAssignment = { id: existing?.id ?? randomUUID(), subtreeRootThreadId, memberThreadId: null,
        state: "transferring", epoch, createdAt: existing?.createdAt ?? now, updatedAt: now,
        fromMemberThreadId, toMemberThreadId, fromAssignmentRootThreadId, remainingAssignmentRoots: remaining, pendingRequestIds };
      this.saveAssignment(binding, assignment);
      if (fromMemberThreadId) {
        const oldMember = this.member(binding, fromMemberThreadId);
        this.addNotification(binding, { id: randomUUID(), kind: "handover_release", recipientThreadId: fromMemberThreadId,
          memberEpoch: oldMember?.epoch ?? 0, assignmentRootThreadId: subtreeRootThreadId, assignmentEpoch: epoch,
          message: `Release ${subtreeRootThreadId}; keep ${remaining.join(", ") || "no other groups"}${fromAssignmentRootThreadId && fromAssignmentRootThreadId !== subtreeRootThreadId ? ` except ${subtreeRootThreadId}` : ""}.`, remainingAssignmentRoots: remaining }, now);
      }
      if (toMemberThreadId) {
        const newMember = this.member(binding, toMemberThreadId)!;
        this.addNotification(binding, { id: randomUUID(), kind: "handover_receive", recipientThreadId: toMemberThreadId,
          memberEpoch: newMember.epoch, assignmentRootThreadId: subtreeRootThreadId, assignmentEpoch: epoch,
          message: `Accept responsibility for the subtree rooted at ${subtreeRootThreadId}.`, remainingAssignmentRoots: [] }, now);
      }
      this.addEvent(binding, { kind: "assignment_handover_started", actorThreadId: binding.threadId, memberThreadId: fromMemberThreadId,
        targetThreadId: subtreeRootThreadId, assignmentRootThreadId: subtreeRootThreadId,
        summary: `Assignment handover for ${subtreeRootThreadId} is waiting for notifications and in-flight effects.`, severity: "attention", createdAt: now });
      return assignment;
    });
  }

  completeTransfer(binding: TeamBinding, subtreeRootThreadId: string, expectedAssignmentEpoch: number, now = Date.now()): TeamAssignment {
    this.currentBinding(binding);
    return this.atomic(() => {
      const assignment = this.assignment(binding, subtreeRootThreadId);
      if (!assignment) throw new Error("supervisor_team_assignment_missing");
      if (assignment.epoch !== expectedAssignmentEpoch) throw new Error("supervisor_team_assignment_epoch_conflict");
      if (assignment.state === "active") return assignment;
      if (assignment.toMemberThreadId) {
        const member = this.member(binding, assignment.toMemberThreadId);
        if (!member || member.state !== "ready") throw new Error("supervisor_team_member_not_ready");
      }
      const notifications = this.notificationsFor(binding).filter(value => value.assignmentRootThreadId === subtreeRootThreadId &&
        value.assignmentEpoch === assignment.epoch && ["handover_release", "handover_receive"].includes(value.kind));
      if (notifications.some(value => value.state !== "acknowledged")) throw new Error("supervisor_team_handover_unacknowledged");
      const pending = new Set(this.requestsFor(binding).filter(request => request.state !== "settled").map(request => request.requestId));
      if (assignment.pendingRequestIds?.some(id => pending.has(id)))
        throw new Error("supervisor_team_handover_pending_effects");
      const next: TeamAssignment = { id: assignment.id, subtreeRootThreadId, memberThreadId: assignment.toMemberThreadId ?? null,
        state: "active", epoch: assignment.epoch, createdAt: assignment.createdAt, updatedAt: now };
      this.saveAssignment(binding, next);
      this.addEvent(binding, { kind: "assignment_handover_completed", actorThreadId: binding.threadId, memberThreadId: next.memberThreadId,
        targetThreadId: subtreeRootThreadId, assignmentRootThreadId: subtreeRootThreadId,
        summary: `Assignment handover for ${subtreeRootThreadId} is complete.`, severity: "result", createdAt: now });
      return next;
    });
  }

  markMissing(binding: TeamBinding, memberThreadId: string, now = Date.now()): TeamMember {
    this.currentBinding(binding);
    return this.atomic(() => {
      const member = this.member(binding, memberThreadId);
      if (!member || member.state === "retired") throw new Error("supervisor_team_member_missing");
      const next: TeamMember = { ...member, state: "missing", epoch: member.epoch + 1, updatedAt: now };
      this.saveMember(binding, next);
      for (const assignment of this.assignmentsFor(binding)) {
        if (assignment.memberThreadId !== memberThreadId && assignment.fromMemberThreadId !== memberThreadId && assignment.toMemberThreadId !== memberThreadId) continue;
        if (assignment.state === "transferring" && assignment.toMemberThreadId && assignment.toMemberThreadId !== memberThreadId) {
          for (const notification of this.notificationsFor(binding).filter(value => value.assignmentRootThreadId === assignment.subtreeRootThreadId &&
            value.assignmentEpoch === assignment.epoch && value.recipientThreadId === assignment.toMemberThreadId && value.state === "pending"))
            this.saveNotification(binding, { ...notification, state: "superseded", updatedAt: now });
        }
        this.saveAssignment(binding, { id: assignment.id, subtreeRootThreadId: assignment.subtreeRootThreadId, memberThreadId: null,
          state: "active", epoch: assignment.epoch + 1, createdAt: assignment.createdAt, updatedAt: now });
      }
      this.addEvent(binding, { kind: "member_missing", actorThreadId: binding.threadId, memberThreadId, targetThreadId: null,
        assignmentRootThreadId: null, summary: "A confirmed missing helper released its assignments to the root.", severity: "attention", createdAt: now });
      return next;
    });
  }

  retireMember(binding: TeamBinding, memberThreadId: string, now = Date.now()): TeamMember {
    this.currentBinding(binding);
    return this.atomic(() => {
      const member = this.member(binding, memberThreadId);
      if (!member || member.state === "retired") throw new Error("supervisor_team_member_missing");
      if (this.assignmentsFor(binding).some(value => value.state === "transferring" &&
        (value.fromMemberThreadId === memberThreadId || value.toMemberThreadId === memberThreadId) ||
        value.state === "active" && value.memberThreadId === memberThreadId)) throw new Error("supervisor_team_member_has_assignments");
      const next: TeamMember = { ...member, state: "retired", epoch: member.epoch + 1, updatedAt: now };
      this.saveMember(binding, next);
      this.addEvent(binding, { kind: "member_retired", actorThreadId: binding.threadId, memberThreadId, targetThreadId: null,
        assignmentRootThreadId: null, summary: "A helper was retired; its ownership record remains retained.", severity: "info", createdAt: now });
      return next;
    });
  }

  private requestsFor(binding: TeamBinding): TeamRequest[] {
    return this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_requests WHERE owner_thread_id=? AND owner_generation=? ORDER BY created_at")
      .all(binding.threadId, binding.generation).map(row => parseDocument<TeamRequest>(row.document));
  }

  recordRequest(binding: TeamBinding, input: { requestId: string; memberThreadId: string; memberEpoch: number; targets: TeamRequestTarget[]; parentById: ReadonlyMap<string, string | null>; state?: "pending"; now?: number }): TeamRequest {
    this.currentBinding(binding);
    if (!isNonEmpty(input.requestId) || !input.targets.length || input.targets.length > MAX_REQUEST_TARGETS) throw new Error("supervisor_team_invalid_request");
    if (!this.resolveActor(binding, input.memberThreadId, input.memberEpoch)) throw new Error("supervisor_team_actor_stale");
    const targets = [...input.targets];
    const now = input.now ?? Date.now();
    return this.atomic(() => {
      const old = this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_requests WHERE owner_thread_id=? AND owner_generation=? AND request_id=?")
        .get(binding.threadId, binding.generation, input.requestId);
      if (old) {
        const value = parseDocument<TeamRequest>(old.document);
        if (value.memberThreadId !== input.memberThreadId || value.memberEpoch !== input.memberEpoch || JSON.stringify(value.targets) !== JSON.stringify(targets))
          throw new Error("supervisor_team_request_identity_conflict");
        return value;
      }
      if (Number(this.supervisors.store.db.prepare("SELECT count(*) AS n FROM supervisor_team_requests WHERE owner_thread_id=? AND owner_generation=?").get(binding.threadId, binding.generation)?.n) >= MAX_REQUESTS)
        throw new Error("supervisor_team_request_capacity");
      for (const target of targets) {
        const current = this.coverage(binding, target.targetThreadId, input.parentById);
        if (current.state !== "assigned" || current.actorThreadId !== input.memberThreadId || current.memberEpoch !== input.memberEpoch ||
          current.assignmentRootThreadId !== target.assignmentRootThreadId || current.assignmentEpoch !== target.assignmentEpoch)
          throw new Error("supervisor_team_request_authority_stale");
      }
      const request: TeamRequest = { requestId: input.requestId, memberThreadId: input.memberThreadId, memberEpoch: input.memberEpoch,
        targets, state: "pending", createdAt: now, updatedAt: now };
      this.supervisors.store.db.prepare("INSERT INTO supervisor_team_requests VALUES(?,?,?,?,?,?,?)")
        .run(binding.threadId, binding.generation, request.requestId, request.state, request.createdAt, request.updatedAt, JSON.stringify(request));
      return request;
    });
  }

  setRequestState(binding: TeamBinding, actorThreadId: string, requestId: string, expectedMemberEpoch: number, state: "uncertain" | "settled", now = Date.now()): TeamRequest {
    this.currentBinding(binding);
    return this.atomic(() => {
      const row = this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_requests WHERE owner_thread_id=? AND owner_generation=? AND request_id=?")
        .get(binding.threadId, binding.generation, requestId);
      if (!row) throw new Error("supervisor_team_request_missing");
      const request = parseDocument<TeamRequest>(row.document);
      const isRoot = actorThreadId === binding.threadId;
      if (!isRoot && (actorThreadId !== request.memberThreadId || expectedMemberEpoch !== request.memberEpoch)) throw new Error("supervisor_team_actor_stale");
      if (request.state === "settled") return request;
      const next: TeamRequest = { ...request, state, updatedAt: now };
      this.supervisors.store.db.prepare("UPDATE supervisor_team_requests SET state=?,updated_at=?,document=? WHERE owner_thread_id=? AND owner_generation=? AND request_id=?")
        .run(state, now, JSON.stringify(next), binding.threadId, binding.generation, requestId);
      return next;
    });
  }

  unresolvedRequests(binding: TeamBinding): TeamRequest[] { return this.requestsFor(binding).filter(request => request.state !== "settled"); }

  settleRequest(binding: TeamBinding, requestId: string, now = Date.now()): TeamRequest {
    return this.setRequestState(binding, binding.threadId, requestId, 0, "settled", now);
  }

  note(binding: TeamBinding, input: { eventId: string; notificationId: string; memberThreadId: string; memberEpoch: number; message: string; now?: number }): TeamNotification {
    this.currentBinding(binding);
    if (!isNonEmpty(input.eventId) || !isNonEmpty(input.notificationId) || !isNonEmpty(input.message) || input.message.length > 8000) throw new Error("supervisor_team_invalid_note");
    if (!this.resolveActor(binding, binding.threadId)) throw new Error("supervisor_team_actor_stale");
    return this.atomic(() => {
      const member = this.member(binding, input.memberThreadId);
      if (!member || member.state !== "ready" || member.epoch !== input.memberEpoch) throw new Error("supervisor_team_member_epoch_conflict");
      const old = this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_notifications WHERE owner_thread_id=? AND owner_generation=? AND id=?")
        .get(binding.threadId, binding.generation, input.notificationId);
      if (old) {
        const value = parseDocument<TeamNotification>(old.document);
        if (value.kind !== "note" || value.recipientThreadId !== input.memberThreadId || value.memberEpoch !== input.memberEpoch || value.message !== input.message)
          throw new Error("supervisor_team_notification_identity_conflict");
        return value;
      }
      const count = Number(this.supervisors.store.db.prepare("SELECT count(*) AS n FROM supervisor_team_notifications WHERE owner_thread_id=? AND owner_generation=?").get(binding.threadId, binding.generation)?.n);
      if (count >= MAX_NOTIFICATIONS) throw new Error("supervisor_team_notification_capacity");
      const now = input.now ?? Date.now();
      const notification = this.addNotification(binding, { id: input.notificationId, kind: "note", recipientThreadId: input.memberThreadId,
        memberEpoch: input.memberEpoch, assignmentRootThreadId: null, assignmentEpoch: null, message: input.message, remainingAssignmentRoots: [] }, now);
      this.addEvent(binding, { id: input.eventId, kind: "note", actorThreadId: binding.threadId, memberThreadId: input.memberThreadId,
        targetThreadId: null, assignmentRootThreadId: null, summary: input.message, severity: "info", createdAt: now });
      return notification;
    });
  }

  assessment(binding: TeamBinding, input: { eventId: string; actorThreadId: string; memberEpoch: number; targets: TeamRequestTarget[]; parentById: ReadonlyMap<string, string | null>; summary: string; severity?: "result" | "attention"; now?: number }): TeamEvent {
    return this.recordAssessment(binding, input, false);
  }

  escalate(binding: TeamBinding, input: { eventId: string; actorThreadId: string; memberEpoch: number; targets: TeamRequestTarget[]; parentById: ReadonlyMap<string, string | null>; summary: string; now?: number }): TeamEvent {
    return this.recordAssessment(binding, { ...input, severity: "attention" }, true);
  }

  private recordAssessment(binding: TeamBinding, input: { eventId: string; actorThreadId: string; memberEpoch: number; targets: TeamRequestTarget[]; parentById: ReadonlyMap<string, string | null>; summary: string; severity?: "result" | "attention"; now?: number }, escalation: boolean): TeamEvent {
    this.currentBinding(binding);
    if (!isNonEmpty(input.eventId) || !isNonEmpty(input.summary) || input.summary.length > 8000 || !input.targets.length) throw new Error("supervisor_team_invalid_assessment");
    const actor = this.resolveActor(binding, input.actorThreadId, input.memberEpoch);
    if (!actor || actor.role !== "helper") throw new Error("supervisor_team_helper_actor_required");
    return this.atomic(() => {
      for (const target of input.targets) {
        const current = this.coverage(binding, target.targetThreadId, input.parentById);
        if (current.state !== "assigned" || current.actorThreadId !== input.actorThreadId || current.memberEpoch !== input.memberEpoch ||
          current.assignmentRootThreadId !== target.assignmentRootThreadId || current.assignmentEpoch !== target.assignmentEpoch)
          throw new Error("supervisor_team_assessment_scope_stale");
      }
      const member = this.member(binding, input.actorThreadId)!;
      const now = input.now ?? Date.now();
      this.saveMember(binding, { ...member, lastAssessment: input.summary, updatedAt: now });
      return this.addEvent(binding, { id: input.eventId, kind: escalation ? "escalation" : "assessment", actorThreadId: input.actorThreadId,
        memberThreadId: input.actorThreadId, targetThreadId: input.targets[0]?.targetThreadId ?? null,
        assignmentRootThreadId: input.targets[0]?.assignmentRootThreadId ?? null, summary: input.summary,
        severity: escalation ? "attention" : input.severity ?? "result", createdAt: now });
    });
  }

  updateNotificationDelivery(binding: TeamBinding, actorThreadId: string, notificationId: string, state: "sending" | "delivered" | "uncertain", now = Date.now()): TeamNotification {
    this.currentBinding(binding);
    if (!this.resolveActor(binding, actorThreadId)) throw new Error("supervisor_team_root_actor_required");
    return this.atomic(() => {
      const row = this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_notifications WHERE owner_thread_id=? AND owner_generation=? AND id=?")
        .get(binding.threadId, binding.generation, notificationId);
      if (!row) throw new Error("supervisor_team_notification_missing");
      const value = parseDocument<TeamNotification>(row.document);
      const allowed = value.state === state || value.state === "pending" && state === "sending" || value.state === "sending" && ["delivered", "uncertain"].includes(state) ||
        value.state === "uncertain" && ["sending", "delivered"].includes(state);
      if (!allowed || value.state === "acknowledged" || value.state === "superseded") throw new Error("supervisor_team_notification_state_conflict");
      const next = { ...value, state, updatedAt: now };
      this.saveNotification(binding, next);
      return next;
    });
  }

  acknowledgeNotification(binding: TeamBinding, actorThreadId: string, notificationId: string, expectedMemberEpoch: number, now = Date.now()): TeamNotification {
    this.currentBinding(binding);
    if (!this.resolveActor(binding, actorThreadId, expectedMemberEpoch)) throw new Error("supervisor_team_actor_stale");
    return this.atomic(() => {
      const row = this.supervisors.store.db.prepare("SELECT document FROM supervisor_team_notifications WHERE owner_thread_id=? AND owner_generation=? AND id=?")
        .get(binding.threadId, binding.generation, notificationId);
      if (!row) throw new Error("supervisor_team_notification_missing");
      const notification = parseDocument<TeamNotification>(row.document);
      if (notification.recipientThreadId !== actorThreadId || notification.memberEpoch !== expectedMemberEpoch) throw new Error("supervisor_team_notification_recipient_mismatch");
      if (notification.state === "acknowledged") return notification;
      if (notification.state === "superseded") throw new Error("supervisor_team_notification_superseded");
      if (!["delivered", "uncertain"].includes(notification.state)) throw new Error("supervisor_team_notification_not_delivered");
      const next = { ...notification, state: "acknowledged" as const, updatedAt: now };
      this.saveNotification(binding, next);
      return next;
    });
  }

  acknowledgeEvent(binding: TeamBinding, actorThreadId: string, eventId: string, now = Date.now()): TeamEvent {
    this.currentBinding(binding);
    if (!this.resolveActor(binding, actorThreadId)) throw new Error("supervisor_team_root_actor_required");
    return this.atomic(() => {
      const row = this.supervisors.store.db.prepare("SELECT document,acknowledged_at FROM supervisor_team_events WHERE owner_thread_id=? AND owner_generation=? AND id=?")
        .get(binding.threadId, binding.generation, eventId);
      if (!row) throw new Error("supervisor_team_event_missing");
      if (row.acknowledged_at !== null) return parseDocument<TeamEvent>(row.document);
      const event = { ...parseDocument<TeamEvent>(row.document), acknowledgedAt: now };
      this.supervisors.store.db.prepare("UPDATE supervisor_team_events SET acknowledged_at=?,document=? WHERE owner_thread_id=? AND owner_generation=? AND id=? AND acknowledged_at IS NULL")
        .run(now, JSON.stringify(event), binding.threadId, binding.generation, eventId);
      return event;
    });
  }

  serviceAttention(binding: TeamBinding, input: {eventId: string; memberThreadId: string; targetThreadId?: string; summary: string}, now = Date.now()): TeamEvent {
    this.currentBinding(binding);
    return this.addEvent(binding, {id: input.eventId, kind: "service_attention", actorThreadId: binding.threadId,
      memberThreadId: input.memberThreadId, targetThreadId: input.targetThreadId ?? null, assignmentRootThreadId: null,
      summary: input.summary.slice(0, 4000), severity: "attention", createdAt: now});
  }

  hasBlockingWork(binding: TeamBinding): boolean {
    this.currentBinding(binding);
    return this.assignmentsFor(binding).some(value => value.state === "transferring") || this.requestsFor(binding).some(value => value.state !== "settled") ||
      this.notificationsFor(binding).some(value => value.state !== "acknowledged" && value.state !== "superseded" &&
        this.member(binding, value.recipientThreadId)?.state === "ready" && this.member(binding, value.recipientThreadId)?.epoch === value.memberEpoch) ||
      this.supervisors.store.db.prepare("SELECT 1 FROM supervisor_team_events WHERE owner_thread_id=? AND owner_generation=? AND acknowledged_at IS NULL AND json_extract(document,'$.severity') IN ('attention','result') LIMIT 1")
        .get(binding.threadId, binding.generation) !== undefined;
  }

  snapshot(binding: TeamBinding): SupervisorTeamSnapshot {
    const root = this.currentBinding(binding);
    const settings = this.settingsRecord(binding);
    const db = this.supervisors.store.db;
    const allEvents = db.prepare("SELECT document FROM supervisor_team_events WHERE owner_thread_id=? AND owner_generation=? ORDER BY created_at")
      .all(binding.threadId, binding.generation).map(row => parseDocument<TeamEvent>(row.document));
    const visibleEvents = new Map([...allEvents.slice(-200), ...allEvents.filter(event => event.acknowledgedAt === null)]
      .map(event => [event.id, event]));
    const events = [...visibleEvents.values()].sort((left, right) => left.createdAt - right.createdAt);
    const allNotifications = this.notificationsFor(binding);
    const visibleNotifications = new Map([...allNotifications.slice(-200), ...allNotifications.filter(notification =>
      notification.state !== "acknowledged" && notification.state !== "superseded")].map(notification => [notification.id, notification]));
    const notifications = [...visibleNotifications.values()].sort((left, right) => left.createdAt - right.createdAt);
    return { root: { threadId: root.threadId, title: root.title, modelSelection: this.supervisors.modelState(root).modelSelection }, settings,
      members: this.membersFor(binding), assignments: this.assignmentsFor(binding), notifications, events };
  }
}
