import { ConversationEngagement, deriveConversationEngagement } from "./supervision-conversation-contract.js";
import { Data, Effect, Option, Schema } from "effect";
import type { BindingRecord, TaskRecord } from "./project-supervisor-store.js";
import type { TaskInterpretationInfo, SupervisorMonitoringStatus } from "./project-supervisor-contract.js";
import type { SupervisionControlInfo } from "./supervisor-control-contract.js";
import type { ThreadInfo } from "./types.js";

export const DashboardWork = Schema.Struct({
  projectId: Schema.String,
  mainThreadId: Schema.String,
  title: Schema.String,
  supervisorThreadId: Schema.String,
  stop: Schema.optional(Schema.NullOr(Schema.Struct({route: Schema.String, callerThreadId: Schema.NullOr(Schema.String), userMessageId: Schema.NullOr(Schema.String), stoppedAt: Schema.Number}))),
  nativeState: Schema.Literals(["active", "waiting", "quiet", "unknown"]),
  supervision: Schema.Literals(["enabled", "stopped", "disabled"]),
  objective: Schema.NullOr(Schema.String),
  reason: Schema.String,
  engagement: Schema.optionalKey(ConversationEngagement),
  taskStatus: Schema.NullOr(Schema.String),
  planStatus: Schema.NullOr(Schema.String),
  assessment: Schema.NullOr(Schema.Struct({status: Schema.String, summary: Schema.String, updatedAt: Schema.Number})),
  attention: Schema.Array(Schema.String),
  updatedAt: Schema.NullOr(Schema.Number),
});
export type DashboardWorkInfo = typeof DashboardWork.Type;
export const DashboardOverview = Schema.Struct({
  observedAt: Schema.Number,
  revision: Schema.String,
  available: Schema.Boolean,
  globallyEnabled: Schema.Boolean,
  offset: Schema.Number,
  limit: Schema.Number,
  total: Schema.Number,
  attentionTotal: Schema.Number,
  hasMore: Schema.Boolean,
  projects: Schema.Array(Schema.Struct({
    id: Schema.String, title: Schema.String, available: Schema.Boolean,
    enabled: Schema.Boolean, effectiveEnabled: Schema.Boolean,
    detectionStatus: Schema.String,
  })),
  work: Schema.Array(DashboardWork),
});
export type DashboardOverviewInfo = typeof DashboardOverview.Type;

export function overviewPage(query: {offset?: string | undefined; limit?: string | undefined}) {
  const integer = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/u.test(value)) throw new Error("invalid_overview_page");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error("invalid_overview_page");
    return parsed;
  };
  return {offset: integer(query.offset, 0, 0, 100_000), limit: integer(query.limit, 100, 1, 200)};
}

/** The same current-state explanations are used by the overview and the selected conversation. */
/** The attention reason for a rejected workflow record; the task workspace shows the record's details beside it. */
export const protocolDiagnosticAttention = "A plan record could not be accepted. Open the task to inspect the reported field and repair it.";
/** The attention reason for an out-of-date acceptance; the task's agreement panel states it there. */
export const staleAgreementAttention = "The saved agreement needs review against current definitions.";
/** The attention reason for a current plan that cannot be used; the task's agreement panel states its status there. */
export const planStatusAttention = (status: string) => `The current plan is ${status}. Open the task to inspect it.`;

export function workAttention(input: {
  enabled: boolean; bindingState: string | null; settlementState?: string | null;
  monitoring?: SupervisorMonitoringStatus | undefined; task?: TaskInterpretationInfo | undefined;
  assessment?: {status: string; summary: string} | null;
}): string[] {
  if (!input.enabled) return [];
  const {monitoring, assessment} = input;
  const task = input.task && !["expired", "not_supervised"].includes(input.task.status) ? input.task : undefined;
  const attention: string[] = [];
  if (input.bindingState === "rejected") attention.push("Supervisor access was rejected.");
  if (input.bindingState === "missing") attention.push("The Supervisor conversation was deleted.");
  if (input.bindingState === "uncertain" || input.settlementState === "uncertain") attention.push("A Supervisor operation has an unconfirmed outcome.");
  if (monitoring?.state === "unavailable" || monitoring?.state === "uncertain") attention.push(monitoring.message.slice(0, 700));
  if (task && ["needs_context", "unavailable", "uncertain"].includes(task.status)) attention.push(task.reason.slice(0, 700));
  if (assessment?.status === "needs_attention") attention.push(assessment.summary || "The current workflow needs attention.");
  if (task?.workflow && ["invalid", "stale", "unavailable"].includes(task.workflow.status)) attention.push(planStatusAttention(task.workflow.status));
  if (task?.agreement?.status === "stale") attention.push(staleAgreementAttention);
  if (task?.definitionReview?.status === "revert_requested") attention.push(task.definitionReview.message.slice(0, 700));
  if (task?.workflowProtocolDiagnostic) attention.push(protocolDiagnosticAttention);
  return [...new Set(attention)];
}

/** Builds a bounded read model from retained state without native calls or operational effects. */
export function buildDashboardOverview(input: {
  fingerprint: (value: unknown) => string;
  observedAt: number; available: boolean; globallyEnabled: boolean;
  projects: readonly {project: {id: string; title: string}; available: boolean}[];
  threads: readonly ThreadInfo[]; bindings: readonly BindingRecord[];
  tasks: (projectId: string) => readonly TaskRecord[];
  control: (projectId: string) => SupervisionControlInfo;
  monitoring: (binding: BindingRecord) => SupervisorMonitoringStatus;
  assessment?: (binding: BindingRecord, task: TaskRecord | undefined) => DashboardWorkInfo["assessment"];
  scopeEnabled?: (projectId: string, mainThreadId: string) => boolean;
  excluded: ReadonlySet<string>;
  offset: number; limit: number;
}): DashboardOverviewInfo {
  const projects = input.projects.map(({project, available}) => {
    const control = input.control(project.id);
    return {id: project.id, title: project.title, available, enabled: control.enabled,
      effectiveEnabled: control.effectiveEnabled, detectionStatus: control.detectionStatus};
  });
  const projectById = new Map(projects.map(project => [project.id, project]));
  const threadById = new Map(input.threads.map(thread => [thread.id, thread]));
  const tasksByProject = new Map(projects.map(project => [project.id, input.tasks(project.id)]));
  const work: DashboardWorkInfo[] = [];
  for (const binding of input.bindings) {
    const project = projectById.get(binding.projectId);
    const main = threadById.get(binding.mainThreadId);
    if (!project?.available || !main || main.projectId !== project.id || main.deletedAt || main.archivedAt) continue;
    const task = tasksByProject.get(project.id)?.find(task => task.threadId === main.id && task.supervisorThreadId === binding.threadId);
    const supervision = input.excluded.has(main.id) ? "stopped" : (input.scopeEnabled?.(project.id, main.id) ?? project.effectiveEnabled) ? "enabled" : "disabled";
    const monitoring = input.monitoring(binding);
    const assessment = input.assessment?.(binding, task) ?? null;
    const attention = workAttention({enabled: supervision === "enabled", bindingState: binding.state,
      settlementState: binding.settlement?.state ?? null, monitoring, task, assessment});
    const nativeState = main.activityRunStatus === "waiting" ? "waiting" : main.activeRunId ? "active"
      : main.activityRunStatus || main.latestRunCompletedAt ? "quiet" : "unknown";
    work.push({projectId: project.id, mainThreadId: main.id, title: main.title,
      supervisorThreadId: binding.threadId, nativeState, supervision, stop: supervision === "stopped" ? binding.supervisionStop ?? null : null,
      engagement: deriveConversationEngagement({task, enabled: supervision === "enabled", available: input.available && project.available, bindingState: binding.state, monitoringState: monitoring.state}),
      objective: task?.objective?.slice(0, 800) ?? null,
      reason: (task?.reason ?? monitoring.message).slice(0, 800), taskStatus: task?.status ?? null,
      planStatus: task?.agreement?.status ?? task?.workflow?.status ?? null, assessment,
      attention: [...new Set(attention)], updatedAt: task?.updatedAt ?? null});
  }
  work.sort((a, b) => Number(b.attention.length > 0) - Number(a.attention.length > 0) ||
    Number(b.nativeState === "active") - Number(a.nativeState === "active") || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.mainThreadId.localeCompare(b.mainThreadId));
  const revision = input.fingerprint({available: input.available, globallyEnabled: input.globallyEnabled, projects, work});
  return {revision, observedAt: input.observedAt, available: input.available, globallyEnabled: input.globallyEnabled,
    projects, offset: input.offset, limit: input.limit, total: work.length,
    attentionTotal: work.filter(item => item.attention.length > 0).length,
    hasMore: input.offset + input.limit < work.length, work: work.slice(input.offset, input.offset + input.limit)};
}

// a page sequence that cannot form one coherent prefix of the overview; the reason is its message
export class OverviewRangeError extends Data.TaggedError("OverviewRangeError")<{readonly reason: "invalid_overview_page" | "overview_changed_during_read"}> {
  override get message() { return this.reason; }
}

// reads a coherent fresh prefix of at least `count` conversations in pages, retaining the loaded range across polls,
// restarting once when the overview changes between pages and rejecting reordered or duplicate pages
export const readOverviewPages = <E, R>(read: (offset: number) => Effect.Effect<DashboardOverviewInfo, E, R>, count: number) => {
  const attempt = Effect.gen(function* () {
    const first = yield* read(0);
    if (first.offset !== 0) return yield* new OverviewRangeError({reason: "invalid_overview_page"});
    let latest = first;
    const work = [...first.work];
    while (latest.hasMore && work.length < count) {
      const offset = latest.offset + latest.work.length;
      if (!latest.work.length) return yield* new OverviewRangeError({reason: "invalid_overview_page"});
      const next = yield* read(offset);
      if (next.revision !== first.revision) return Option.none<DashboardOverviewInfo>();
      if (next.offset !== offset || next.total !== first.total) return yield* new OverviewRangeError({reason: "invalid_overview_page"});
      work.push(...next.work); latest = next;
    }
    if (new Set(work.map(item => item.mainThreadId)).size !== work.length) return yield* new OverviewRangeError({reason: "invalid_overview_page"});
    return Option.some({...first, work, hasMore: latest.hasMore});
  });
  return Effect.flatMap(attempt, Option.match({
    onSome: Effect.succeed,
    onNone: () => Effect.flatMap(attempt, Option.match({onSome: Effect.succeed, onNone: () => Effect.fail(new OverviewRangeError({reason: "overview_changed_during_read"}))})),
  }));
};
