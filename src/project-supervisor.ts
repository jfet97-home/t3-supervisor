import {SupervisorHelperTransport} from "./supervisor-helper-transport.js";
import { assessmentForTask, workflowAssessment } from "./workflow-assessment.js";
import { buildDashboardOverview } from "./dashboard-overview.js";
import {supervisorTeamView} from "./supervisor-team-view.js";
import {SupervisorTeamStore} from "./supervisor-team-store.js";
import { SupervisorLifecycle } from "./supervisor-lifecycle.js";
import { mainConversation, resolveSupervisorScope, supervisorScopeKey } from "./supervisor-scope.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Effect } from "effect";
import { fingerprint } from "./guidance-store.js";
import { mainRunNodeReader, nativeUserMessageVisible, timestampMs } from "./domain.js";
import { currentThreadPolicy } from "./thread-policy.js";
import { ProjectSupervisorStore, prepareStopNotice, isSupervisorThread, type BindingRecord, type TaskRecord, type SupervisorBaseline, type SupervisionFolderPresence, type SupervisionStartRecord } from "./project-supervisor-store.js";
import { modelSelection, sameModel, supervisorModels, validModelSelection, SupervisorRpcError, type SupervisorRpc } from "./supervisor-native.js";
import type { ProjectSupervisorChatSupervisionInput, ProjectSupervisorInfo, ProjectSupervisorSaveInput, ProjectSupervisorSaveOutcome, ProjectSupervisorRetryInput, SupervisorModelSelection, WorkflowProposalInfo } from "./project-supervisor-contract.js";
import type { SupervisionStartInput, SupervisionStartResult, SupervisionStopInput, SupervisionStopResult } from "./workflow-write-controller.js";
import type { ThreadPolicySettings } from "./thread-policy-contract.js";
import { interpretationPrompt, parseInterpretation, prepareWorkflowRequest, parseWorkflowInterpretation } from "./supervisor-workflow.js";
import type { ProjectDefinitionLoader } from "./project-definitions.js";
export { interpretationPrompt, parseInterpretation } from "./supervisor-workflow.js";
import type { ProjectDefinitionSnapshot } from "./project-definitions-contract.js";
import type { StoreShape } from "./store.js";
import { T3TransportError, type T3ClientShape } from "./t3.js";
import type { MessageInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "./types.js";
import { SupervisorConversation } from "./supervisor-conversation.js";
import { introductionOutcomeUnknown } from "./supervisor-conversation-store.js";
import type { NoProjectControlInput, GlobalDefinitionsControlInput, SupervisionControlInput, SupervisionSetupInput } from "./supervisor-control-contract.js";
import { WorkflowStateStore } from "./workflow-state-store.js";
import { monitorActivityReference, observeScopeThread, SUPERVISOR_SCOPE_SNAPSHOT_MAX_ACTIVITY_REFS, SUPERVISOR_SCOPE_SNAPSHOT_MAX_THREADS, type ProjectSupervisorScopeSnapshot } from "./supervisor-observation.js";

type SetupCheckoutTarget = {origin: "project"; threadId: string | null; workspaceRoot: string; branch: string | null; isGitRepository: boolean};
type SetupOutcome = {status: "created" | "committed" | "unchanged" | "stale" | "conflict" | "permission_required" | "unavailable" | "uncertain"; workspaceRoot: string | null; branch: string | null; message: string};
type GlobalSetupOutcome = {status: "created" | "unchanged" | "conflict" | "permission_required" | "unavailable" | "uncertain"; workspaceRoot: string; branch: null; message: string};
type ProjectSupervisorDefinitions = Pick<ProjectDefinitionLoader, "load"> & {
  presence?: (projectId: string, signal: AbortSignal) => Promise<SupervisionFolderPresence>;
  presenceGlobal?: (signal: AbortSignal) => Promise<SupervisionFolderPresence>;
  globalDefinitionsPath?: () => string;
  globalFingerprint?: (signal: AbortSignal) => Promise<string | null>;
  initializeGlobal?: (signal: AbortSignal) => Promise<GlobalSetupOutcome>;
  checkoutTargets?: (projectId: string, signal: AbortSignal) => Promise<SetupCheckoutTarget[]>;
  presenceForCheckout?: (projectId: string, threadId: string | null, signal: AbortSignal) => Promise<SupervisionFolderPresence>;
  initialize?: (projectId: string, threadId: string | null, input: {origin: "project"; action: "create" | "create_and_commit"; expectedWorkspaceRoot: string; expectedBranch: string | null}, signal: AbortSignal) => Promise<SetupOutcome>;
};
export type ProjectSupervisorWorkflowLocator = {supervisorThreadId: string; bindingGeneration: number};
export type ProjectSupervisorScopeSnapshotOptions = {
  threadIds?: readonly string[];
  lineageOffset?: number;
  limit?: number;
};

const enabledAgainReason = "Supervision was enabled again after this request; only a request written after the Enable is supervised.";
const active = (projection: Projection) => projection.runs.some(r => ["preparing","queued","starting","running","waiting"].includes(r.status));
const unavailable = (thread: ThreadInfo) => Boolean(thread.archivedAt || thread.deletedAt);
const supervisorUnavailable = (thread: ThreadInfo) => Boolean(thread.archivedAt || thread.deletedAt);

const unavailableDefinitions = (job: TaskRecord): ProjectDefinitionSnapshot => ({projectId: job.projectId, threadId: job.threadId,
  workspaceRoot: "", revision: null, editingAvailable: false, status: "unavailable", steps: [], workflows: [], config: {workflows: [], steps: []},
  projectConfig: null, definitionFiles: [], complete: false, sources: [], issues: [{path: "", code: "definition_read_failed",
    message: "Definition sources could not be read. Requirements and policy remain unknown; make a finite provisional plan."}]});

const sameDefinitionRead = (left: ProjectDefinitionSnapshot | null | undefined, right: ProjectDefinitionSnapshot): boolean =>
  Boolean(left && fingerprint({projectId: left.projectId, threadId: left.threadId, workspaceRoot: left.workspaceRoot, globalOnly: left.globalOnly ?? null,
    globalRevision: left.globalRevision ?? null, revision: left.revision, status: left.status, steps: left.steps, workflows: left.workflows,
    config: left.config, projectConfig: left.projectConfig, definitionFiles: left.definitionFiles, complete: left.complete, sources: left.sources, issues: left.issues}) ===
    fingerprint({projectId: right.projectId, threadId: right.threadId, workspaceRoot: right.workspaceRoot, globalOnly: right.globalOnly ?? null,
      globalRevision: right.globalRevision ?? null, revision: right.revision, status: right.status, steps: right.steps, workflows: right.workflows,
      config: right.config, projectConfig: right.projectConfig, definitionFiles: right.definitionFiles, complete: right.complete, sources: right.sources, issues: right.issues}));

// the first genuine human request after a run ordinal; after an explicit Enable only one written after it (`writtenAfter`) counts
export const taskSource = (projection: Projection, afterOrdinal: number, writtenAfter: number | null = null): {run: RunInfo; message: MessageInfo} | null => {
  for (const run of [...projection.runs].sort((a,b) => a.ordinal - b.ordinal)) {
    if (run.ordinal <= afterOrdinal || !run.rootNodeId || run.threadId !== projection.thread.id || typeof run.userMessageId !== "string") continue;
    const message = projection.messages.find(m => m.id === run.userMessageId && m.threadId === projection.thread.id && m.runId === run.id &&
      m.role === "user" && m.createdBy === "user" && m.streaming === false && !m.id.startsWith("supervisor-notice:") && (m.creationSource === "web" || m.creationSource === "mobile") &&
      !m.senderThreadId && !m.scheduledTaskId && !m.source);
    if (writtenAfter !== null && !((timestampMs(message?.createdAt) ?? 0) > writtenAfter)) continue;
    if (message && message.text.trim() && nativeUserMessageVisible(projection, run, message)) return {run, message};
  }
  return null;
};

// an exact whole-token mention of a chat ID; a prefix of a longer ID never names that chat
const namesThread = (text: string, threadId: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9:_%.-])${threadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9:_%-]|\\.[A-Za-z0-9:_%-])`, "u").test(text);

/** Coordinates ordinary T3 conversations; provider execution remains entirely in T3. */
export class ProjectSupervisor {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly examinedNonTasks = new Map<string, string>();
  private readonly folderPresenceCheckedAt = new Map<string, number>();
  private readonly folderPresenceInFlight = new Map<string, Promise<SupervisionFolderPresence>>();
  private readonly scratchProjectIds = new Set<string>();
  private catalogClassificationsReady = false;
  private activationBoundaryInFlight: Promise<SupervisorBaseline> | null = null;
  private offset = 0;
  private bindingOffset = 0;
  teamEffects: {reconcile(binding: BindingRecord, signal: AbortSignal): Promise<void>; reconcileStopped(binding: BindingRecord, signal: AbortSignal): Promise<void>} | null = null;
  readonly team: SupervisorTeamStore;
  readonly helperTransport: SupervisorHelperTransport;
  readonly conversation: SupervisorConversation;
  readonly lifecycle: SupervisorLifecycle;
  readonly workflowStates: WorkflowStateStore;
  constructor(readonly config: SupervisorConfig, readonly store: ProjectSupervisorStore, readonly source: Pick<StoreShape, "catalog">,
    readonly t3: Pick<T3ClientShape, "projection">, readonly readRpc: SupervisorRpc, readonly operateRpc: SupervisorRpc | null,
    readonly activationSnapshot: (signal: AbortSignal) => Promise<SupervisorBaseline>,
    readonly definitions?: ProjectSupervisorDefinitions, private readonly now: () => number = Date.now) {
      this.team = new SupervisorTeamStore(store);
      this.helperTransport = new SupervisorHelperTransport({store, enabled: (projectId, mainThreadId) => this.scopeEnabled(projectId, mainThreadId), rpc: operateRpc, baseUrl: config.t3Url,
        projection: (threadId, signal) => this.projection(threadId, signal)});
      this.workflowStates = new WorkflowStateStore(store, (projectId, mainThreadId) => this.workflowEditingEnabled(projectId, mainThreadId));
      this.conversation = new SupervisorConversation(store, operateRpc, (threadId, signal) => this.projection(threadId, signal), definitions,
        (thread, threads) => this.eligible(thread, threads), (projectId, mainThreadId, purpose) => this.scopeEnabled(projectId, mainThreadId, purpose), this.workflowStates,
        thread => !isSupervisorThread(config, thread) && !thread.archivedAt && !thread.deletedAt, this.team,
        this.helperTransport, config.helperProviderInstanceId);
      this.conversation.supervisionStopped = threadId => this.supervisionStopped(threadId);
      this.lifecycle = new SupervisorLifecycle(store, this.conversation, (id, signal) => this.projection(id, signal), operateRpc, this.workflowStates);
    }
  private async serial<A>(projectId: string, work: () => Promise<A>): Promise<A> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);this.queues.set(projectId, next);
    try {return await next;} finally {if (this.queues.get(projectId) === next) this.queues.delete(projectId);}
  }
  private async project(projectId: string) {
    const catalog = await Effect.runPromise(this.source.catalog());
    this.rememberScratchProjects(catalog.projects.map(item => item.project));
    const project = catalog.projects.find(p => p.project.id === projectId && p.available)?.project;
    if (!project) throw new Error("project_unavailable");return {project, catalog};
  }
  private rememberScratchProjects(projects: readonly {id: string; workspaceRoot: string}[]): void {
    for (const project of projects) {
      if (this.scratchProject(project.id, project.workspaceRoot)) this.scratchProjectIds.add(project.id);
      else this.scratchProjectIds.delete(project.id);
    }
    this.catalogClassificationsReady = true;
  }
  private scratchProject(projectId: string, workspaceRoot: string): boolean {
    const classification = this.store.store.classification(projectId);
    if (classification !== "unclassified") return classification === "scratch";
    return Boolean(this.config.managedScratchRoot && resolve(workspaceRoot) === resolve(this.config.managedScratchRoot));
  }
  private isNoProject(projectId: string): boolean {
    const classification = this.store.store.classification(projectId);
    return classification === "unclassified" ? this.scratchProjectIds.has(projectId) : classification === "scratch";
  }
  /** One scope predicate protects every effect; only a pending Start's interpretation can run before activation. */
  scopeEnabled(projectId: string, mainThreadId?: string, purpose: "effect" | "interpretation" | "reconcile" = "effect"): boolean {
    if (!this.isNoProject(projectId)) return this.store.enabled(projectId) && (purpose === "reconcile" || !mainThreadId || !this.supervisionStopped(mainThreadId));
    const control = this.store.noProjectControl();
    if (!control.globallyEnabled || control.mode === "off") return false;
    if (!mainThreadId) return control.mode === "automatic";
    const start = this.store.start(mainThreadId);
    if (start?.status === "pending") return purpose !== "effect" && this.validPendingStart(start);
    if (purpose !== "reconcile" && this.supervisionStopped(mainThreadId)) return false;
    return control.mode === "automatic" || start?.status === "active";
  }
  private validPendingStart(start: SupervisionStartRecord): boolean {
    const mode = this.store.noProjectControl();
    return start.status === "pending" && mode.globallyEnabled && mode.mode !== "off" && mode.generation === start.modeGeneration &&
      this.store.control(null).generation === start.masterGeneration && (this.store.chatStop(start.threadId)?.stoppedAt ?? -1) < start.intentAt &&
      (this.store.chatEnabledAt(start.threadId) ?? -1) <= start.intentAt;
  }
  private projectEnabled(projectId: string, mainThreadId?: string): boolean {return this.scopeEnabled(projectId, mainThreadId, "interpretation");}
  workflowEditingEnabled(projectId: string, mainThreadId?: string, purpose: "effect" | "status" | "read" = "effect"): boolean {
    return this.catalogClassificationsReady && Boolean(this.operateRpc) && this.store.scopeCompatible && this.scopeEnabled(projectId, mainThreadId, purpose !== "effect" ? "interpretation" : "effect");
  }
  noProjectControl() {const {generation, mode, globallyEnabled} = this.store.noProjectControl();return {generation, mode, globallyEnabled};}
  async saveNoProjectControl(input: NoProjectControlInput, signal: AbortSignal) {
    const control = this.noProjectControl();
    if (control.generation !== input.expectedGeneration) return {status: "conflict" as const, message: "No Project mode changed. Reload before saving.", control};
    try {
      const baseline = await this.activationSnapshot(signal);
      this.store.saveNoProjectControl(input.expectedGeneration, input.mode, baseline);
      return {status: "saved" as const, message: "No Project mode saved. Existing permissions and history are retained; discovery resumes from this boundary.", control: this.noProjectControl()};
    } catch {return {status: "unavailable" as const, message: "Mode was not confirmed. Reload before saving again.", control: this.noProjectControl()};}
  }
  private sourceFloor(threadId: string, projection: Projection): number | null {
    const base = this.store.baselineOrdinal(threadId, projection);
    if (base === null || !this.isNoProject(projection.thread.projectId ?? "")) return base;
    const anchor = this.store.noProjectControl().baseline?.threads.find(item => item.id === threadId)?.latestRunId;
    if (!anchor) return base;
    const ordinal = projection.runs.find(item => item.id === anchor)?.ordinal;
    return ordinal === undefined ? null : Math.max(base, ordinal);
  }
  private pinnedStart(job: TaskRecord): SupervisionStartRecord | null {
    const start = this.store.start(job.threadId);
    return start && (start.status === "active" && !this.supervisionStopped(job.threadId) && this.store.chatEnabledAt(job.threadId) === start.intentAt && start.modeGeneration === this.store.noProjectControl().generation && start.masterGeneration === this.store.control(null).generation || this.validPendingStart(start)) && start.taskId === job.id &&
      start.source?.messageId === job.sourceMessageId && start.source.runId === job.sourceRunId && start.source.hash === job.sourceHash ? start : null;
  }
  workflowLocator(projectId: string, mainThreadId: string): ProjectSupervisorWorkflowLocator | null {
    const binding = this.store.binding(projectId, mainThreadId);
    return binding?.state === "ready" ? {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation} : null;
  }
  private effectiveControl(projectId: string): ReturnType<ProjectSupervisorStore["control"]> {
    const control = this.store.control(projectId);
    const effectiveEnabled = this.projectEnabled(projectId);
    return control.effectiveEnabled === effectiveEnabled ? control : {...control, effectiveEnabled};
  }
  private async projection(threadId: string, signal: AbortSignal): Promise<Projection> {return (await Effect.runPromise(this.t3.projection(threadId), {signal})).projection;}
  private async models(signal: AbortSignal) {return supervisorModels(await this.readRpc("server.getConfig", {}, signal));}
  private finishMissingHelperRequests(binding: BindingRecord, memberThreadId: string, reason: string): void {
    const ownedRequests = this.conversation.requests.requests(binding.projectId, memberThreadId).filter(request => request.kind === "review" &&
      (request.id.startsWith("team-review:") || request.id.startsWith("team-ready:")) &&
      (["prepared", "sending", "waiting", "uncertain"].includes(request.state) || request.state === "failed" && !request.failureAcknowledged));
    for (const request of ownedRequests) {
      const failed = request.state === "failed" ? {...request, error: request.error ?? reason} : {...request, state: "failed" as const, error: reason};
      if (request.state !== "failed" || !request.error) this.conversation.requests.saveRequest(failed);
      const targetThreadId = request.batch?.threads[0]?.threadId;
      try {
        this.team.serviceAttention(binding, {
          eventId: `helper-checkin-failed:${fingerprint([binding.threadId, binding.generation, memberThreadId, request.id]).slice(0, 32)}`,
          memberThreadId,
          ...(targetThreadId ? {targetThreadId} : {}),
          summary: `Helper check-in failed: ${request.error ?? reason}`,
        });
      } catch { /* request closure remains durable if the event could not be recorded */ }
    }
    for (const request of this.team.unresolvedRequests(binding).filter(value => value.memberThreadId === memberThreadId &&
      (value.requestId.startsWith("team-review:") || value.requestId.startsWith("team-ready:"))))
      this.team.settleRequest(binding, request.requestId);
  }
  private async prepareMissingRootTeam(binding: BindingRecord, signal: AbortSignal): Promise<"ready" | "present_helper" | "unavailable" | "disabled"> {
    let presentHelper = false;
    const members = this.team.snapshot(binding).members.filter(member => member.state === "ready" || member.state === "registering" || member.state === "missing");
    for (const member of members) {
      if (!this.projectEnabled(binding.projectId, binding.mainThreadId)) return "disabled";
      let helper: Projection;
      try {helper = await this.projection(member.threadId, signal);}
      catch (cause) {
        if (!(cause instanceof T3TransportError) || cause.httpStatus !== 404) return "unavailable";
        if (!await this.helperTransport.retire(binding, member.threadId, signal)) return "unavailable";
        try {
          if (member.state !== "missing") this.team.markMissing(binding, member.threadId);
          this.finishMissingHelperRequests(binding, member.threadId, "The helper conversation is confirmed missing; its check-in was closed and pending operational effects remain fenced.");
        }
        catch {return "unavailable";}
        continue;
      }
      if (helper.thread.id !== member.threadId || helper.thread.lineage.parentThreadId !== binding.threadId ||
        helper.thread.lineage.relationshipToParent !== "subagent") return "unavailable";
      if (!unavailable(helper.thread)) {presentHelper = true;continue;}
      if (!await this.helperTransport.retire(binding, member.threadId, signal)) return "unavailable";
      try {
        if (member.state !== "missing") this.team.markMissing(binding, member.threadId);
        this.finishMissingHelperRequests(binding, member.threadId, "The helper conversation is archived or deleted; its check-in was closed and pending operational effects remain fenced.");
      }
      catch {return "unavailable";}
    }
    return presentHelper ? "present_helper" : "ready";
  }
  async scopeSnapshot(projectId: string, mainThreadId: string, signal: AbortSignal,
    options?: ProjectSupervisorScopeSnapshotOptions): Promise<ProjectSupervisorScopeSnapshot> {
    const observedAt = this.now();
    const binding = this.store.binding(projectId, mainThreadId);
    const issues: Array<ProjectSupervisorScopeSnapshot["issues"][number]> = [];
    let complete = true;
    let catalog: {threads: ThreadInfo[]} | null = null;
    try {catalog = await Effect.runPromise(this.source.catalog(), {signal});}
    catch {
      if (signal.aborted) throw new Error("scope_snapshot_aborted");
      complete = false;
      issues.push({code: "catalog_unavailable", message: "The current T3 thread catalog could not be read."});
    }
    const scope = catalog ? resolveSupervisorScope(catalog.threads, projectId, mainThreadId, this.store.ownedIds) : null;
    if (scope) {
      complete = complete && scope.complete;
      issues.push(...scope.issues.slice(0, 20));
    }
    let supervisorProjection: Projection | null = null;
    if (binding) {
      try {
        supervisorProjection = await this.projection(binding.threadId, signal);
        if (supervisorProjection.thread.id !== binding.threadId || supervisorProjection.thread.projectId !== projectId) throw new Error("supervisor_scope_mismatch");
      } catch {
        if (signal.aborted) throw new Error("scope_snapshot_aborted");
        complete = false;
        issues.push({code: "supervisor_unavailable", message: "The owning Supervisor conversation could not be observed."});
      }
    }
    const allRows: ThreadInfo[] = scope?.main && scope.allowedIds.has(scope.main.id)
      ? [scope.main, ...scope.descendants.filter(thread => scope.allowedIds.has(thread.id))]
      : [];
    let rows: ThreadInfo[];
    let lineageOffset = 0;
    let lineageHasMore = false;
    const lineageTotal = allRows.length;
    const hasThreadSelection = options?.threadIds !== undefined;
    const hasPageSelection = options?.lineageOffset !== undefined || options?.limit !== undefined;
    if (hasThreadSelection && hasPageSelection) {
      complete = false;
      issues.push({code: "scope_snapshot_options_invalid", message: "Choose explicit thread IDs or a lineage page, not both."});
      rows = [];
    } else if (hasThreadSelection) {
      const selected = options!.threadIds!;
      if (selected.length > SUPERVISOR_SCOPE_SNAPSHOT_MAX_THREADS || selected.some(id => !id.trim()) || new Set(selected).size !== selected.length) {
        complete = false;
        issues.push({code: "scope_snapshot_options_invalid", message: "The requested thread page is invalid or exceeds the observation limit."});
        rows = [];
      } else {
        rows = [];
        for (const id of selected) {
          const thread = scope?.byId.get(id);
          if (!thread || !scope?.allowedIds.has(id)) {
            complete = false;
            issues.push({code: "scope_thread_unverified", message: "A requested thread is outside the verified main scope."});
          } else rows.push(thread);
        }
      }
    } else if (hasPageSelection) {
      const offset = options?.lineageOffset ?? 0;
      const limit = options?.limit ?? 20;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        complete = false;
        issues.push({code: "scope_snapshot_options_invalid", message: "The requested lineage offset or page size is invalid."});
        rows = [];
      } else {
        lineageOffset = offset;
        rows = allRows.slice(offset, offset + limit);
        lineageHasMore = offset + rows.length < lineageTotal;
      }
    } else {
      rows = allRows.slice(0, SUPERVISOR_SCOPE_SNAPSHOT_MAX_THREADS);
      lineageHasMore = rows.length < lineageTotal;
      if (lineageHasMore) {
        complete = false;
        issues.push({code: "scope_observation_limit", message: `Only the first ${SUPERVISOR_SCOPE_SNAPSHOT_MAX_THREADS} threads are included in this bounded snapshot.`});
      }
    }
    const observedRows: Array<ProjectSupervisorScopeSnapshot["threads"][number]> = [];
    const projections = new Map<string, Projection>();
    let projectionReads = 0;
    const readProjection = async (threadId: string): Promise<Projection | null> => {
      const existing = projections.get(threadId);
      if (existing) return existing;
      if (!scope || projectionReads >= SUPERVISOR_SCOPE_SNAPSHOT_MAX_THREADS) return null;
      projectionReads++;
      try {
        const projection = await this.projection(threadId, signal);
        if (projection.thread.id !== threadId) throw new Error("projection_scope_mismatch");
        projections.set(threadId, projection);
        return projection;
      } catch {
        if (signal.aborted) throw new Error("scope_snapshot_aborted");
        return null;
      }
    };
    for (const thread of rows.slice(0, SUPERVISOR_SCOPE_SNAPSHOT_MAX_THREADS)) {
      if (signal.aborted) throw new Error("scope_snapshot_aborted");
      const depth = scope?.depthById.get(thread.id) ?? 0;
      const isMain = thread.id === mainThreadId;
      let projection = isMain || !thread.archivedAt && !thread.deletedAt ? await readProjection(thread.id) : null;
      let lineageVerified = true;
      if (isMain && projection && projection.thread.projectId !== projectId) {
        complete = false;
        issues.push({code: "main_projection_mismatch", message: "The main projection no longer matches the requested project."});
        projection = null;
      }
      if (!isMain && projection && (projection.thread.lineage.relationshipToParent !== "subagent" ||
        projection.thread.lineage.parentThreadId !== thread.lineage.parentThreadId)) {
        complete = false;
        issues.push({code: "projection_lineage_changed", message: "A descendant projection no longer matches its verified catalog lineage."});
        lineageVerified = false;
        projection = null;
      } else if (!isMain && !projection && !thread.archivedAt && !thread.deletedAt) {
        complete = false;
        issues.push({code: "descendant_projection_unavailable", message: "A live descendant projection could not be read."});
      }
      const parentId = typeof thread.lineage.parentThreadId === "string" ? thread.lineage.parentThreadId : null;
      let parentProjection = parentId ? await readProjection(parentId) : null;
      if (!isMain && parentId && !parentProjection) {
        complete = false;
        lineageVerified = false;
        issues.push({code: "parent_projection_unavailable", message: "A descendant's direct parent projection could not be read."});
      }
      const parentInfo = parentId ? scope?.byId.get(parentId) : null;
      const parentMismatch = !isMain && parentProjection && parentId !== mainThreadId && (!parentInfo ||
        parentProjection.thread.lineage.relationshipToParent !== "subagent" ||
        parentProjection.thread.lineage.parentThreadId !== parentInfo.lineage.parentThreadId);
      const mainParentMismatch = !isMain && parentId === mainThreadId && parentProjection?.thread.projectId !== projectId;
      if (parentMismatch || mainParentMismatch) {
        complete = false;
        lineageVerified = false;
        issues.push({code: "parent_projection_lineage_changed", message: "A descendant's direct parent projection no longer matches the verified lineage."});
        parentProjection = null;
      }
      const activityRefs = lineageVerified ? this.conversation.monitor.state(projectId, thread.id).activities
        .slice(-SUPERVISOR_SCOPE_SNAPSHOT_MAX_ACTIVITY_REFS)
        .map(item => monitorActivityReference(thread.id, projection, item)) : [];
      observedRows.push(observeScopeThread({thread, mainThreadId, depth, projection, parentProjection, lineageVerified, activityRefs}));
    }
    if (issues.length > 100) issues.splice(100);
    if (!scope) complete = false;
    return {projectId, mainThreadId, supervisorThreadId: binding?.threadId ?? null, bindingGeneration: binding?.generation ?? null,
      observedAt, lineageTotal, lineageOffset, lineageHasMore,
      complete: complete && Boolean(scope?.complete), issues, threads: observedRows};
  }
  private async detectFolder(projectId: string, signal: AbortSignal): Promise<SupervisionFolderPresence> {
    const existing = this.folderPresenceInFlight.get(projectId);
    if (existing) return existing;
    const current = (async (): Promise<SupervisionFolderPresence> => {
      if (!this.definitions?.presence) return {status: "unavailable", message: "Project .t3-supervisor folder detection is not configured."};
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      let presence: SupervisionFolderPresence;
      try {
        const result = await this.definitions.presence(projectId, deadline);
        if (!result || !["present", "missing", "unavailable"].includes(result.status)) throw new Error("invalid_folder_presence");
        presence = result;
      } catch (cause) {
        if (signal.aborted) throw cause;
        presence = {status: "unavailable", message: "The project .t3-supervisor folder could not be checked."};
      }
      let baseline: SupervisorBaseline | undefined;
      if (presence.status === "present" && !this.store.isManual(projectId) && !this.store.autoControlInitialized(projectId) &&
        (this.store.folderPresenceNeedsBoundary(projectId) || !this.store.baseline() && !this.store.projectBoundary(projectId))) {
        try {baseline = await this.activationBoundary(signal);}
        catch (cause) {
          if (signal.aborted) throw cause;
          presence = {status: "unavailable", message: "The project folder is present, but a native enable boundary could not be captured. Retry the folder check before enabling supervision."};
        }
      }
      this.store.recordFolderPresence(projectId, presence, baseline);
      return presence;
    })();
    this.folderPresenceInFlight.set(projectId, current);
    try {
      const presence = await current;
      this.folderPresenceCheckedAt.set(projectId, this.now());
      return presence;
    } finally {if (this.folderPresenceInFlight.get(projectId) === current) this.folderPresenceInFlight.delete(projectId);}
  }
  private async activationBoundary(signal: AbortSignal): Promise<SupervisorBaseline> {
    const existing = this.activationBoundaryInFlight;
    if (existing) return existing;
    const current = this.activationSnapshot(AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    this.activationBoundaryInFlight = current;
    try {return await current;}
    finally {if (this.activationBoundaryInFlight === current) this.activationBoundaryInFlight = null;}
  }
  private async resolveControl(projectId: string, signal: AbortSignal) {
    if (this.store.isManual(projectId) || this.store.autoControlInitialized(projectId)) return this.store.control(projectId);
    const checkedAt = this.folderPresenceCheckedAt.get(projectId) ?? 0;
    const retryDelay = this.store.control(projectId).detectionStatus === "unavailable" ? 60_000 : 30_000;
    if (this.now() - checkedAt < retryDelay) return this.store.control(projectId);
    try {await this.detectFolder(projectId, signal);}
    catch {if (!signal.aborted) this.store.setFolderPresence(projectId, {status: "unavailable", message: "The project .t3-supervisor folder could not be checked."});}
    return this.store.control(projectId);
  }
  async control(projectId: string | null, signal: AbortSignal): Promise<ReturnType<ProjectSupervisorStore["control"]>> {
    if (projectId === null) return this.store.control(null);
    await this.project(projectId);
    if (this.store.isManual(projectId) || this.store.autoControlInitialized(projectId)) return this.effectiveControl(projectId);
    await this.resolveControl(projectId, signal);
    return this.effectiveControl(projectId);
  }
  private globalDefinitionsPath(): string {return this.definitions?.globalDefinitionsPath?.() ?? "~/.t3-supervisor";}
  async globalDefinitionsControl(signal: AbortSignal) {
    let presence: SupervisionFolderPresence = {status: "unavailable", message: "Global definition folder detection is not configured."};
    if (this.definitions?.presenceGlobal) {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      try {presence = await this.definitions.presenceGlobal(deadline);}
      catch {if (signal.aborted) throw new Error("global_definitions_read_aborted");presence = {status: "unavailable", message: "The server-user .t3-supervisor folder could not be checked."};}
    }
    this.store.recordGlobalDefinitionsPresence(presence);
    return this.store.globalDefinitionsControl(this.globalDefinitionsPath());
  }
  async saveGlobalDefinitionsControl(input: GlobalDefinitionsControlInput, signal: AbortSignal) {
    const homePath = this.globalDefinitionsPath();
    const current = await this.globalDefinitionsControl(signal);
    if (!this.store.scopeCompatible) return {status: "unavailable" as const, message: "Supervisor state is unavailable; global definition settings were not changed.", control: current};
    if (current.generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Global definitions changed in another window. Reload before saving.", control: current};
    let outcome: GlobalSetupOutcome | null = null;
    let globalFingerprint: string | null = null;
    if (input.enabled) {
      if (!this.definitions?.initializeGlobal) return {status: "unavailable" as const, message: "Global definition setup is not configured; no setting was changed.", control: current};
      try {outcome = await this.definitions.initializeGlobal(AbortSignal.any([signal, AbortSignal.timeout(30_000)]));}
      catch {return {status: "uncertain" as const, message: "Global definition setup could not be confirmed. Inspect ~/.t3-supervisor before retrying.", control: this.store.globalDefinitionsControl(homePath)};}
      if (outcome.status !== "created" && outcome.status !== "unchanged") {
        const status = outcome.status === "uncertain" ? "uncertain" as const : outcome.status === "conflict" ? "conflict" as const : "unavailable" as const;
        return {status, message: outcome.message, control: this.store.globalDefinitionsControl(homePath)};
      }
      if (!this.definitions.globalFingerprint) return {status: "unavailable" as const, message: "Global definition input verification is unavailable; the setting was not changed.", control: this.store.globalDefinitionsControl(homePath)};
      try {globalFingerprint = await this.definitions.globalFingerprint(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));}
      catch (cause) {if (signal.aborted) throw cause;globalFingerprint = null;}
      if (!globalFingerprint) return {status: "unavailable" as const, message: "The global definition folder could not be verified; the setting was not changed.", control: this.store.globalDefinitionsControl(homePath)};
    } else if (this.definitions?.globalFingerprint) {
      try {globalFingerprint = await this.definitions.globalFingerprint(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));}
      catch (cause) {if (signal.aborted) throw cause;globalFingerprint = null;}
    }
    if (this.store.globalDefinitionsControl(homePath).generation !== input.expectedGeneration) {
      const message = outcome ? "The global definition folder is ready, but the setting changed before it could be enabled. Refresh before continuing." : "Global definitions changed in another window. Reload before saving.";
      return {status: "conflict" as const, message, control: this.store.globalDefinitionsControl(homePath)};
    }
    if (this.definitions?.globalFingerprint && globalFingerprint) {
      let verified: string | null = null;
      try {verified = await this.definitions.globalFingerprint(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));}
      catch (cause) {if (signal.aborted) throw cause;verified = null;}
      if (input.enabled && verified !== globalFingerprint) return {status: "conflict" as const, message: "The global definition files changed while the switch was being saved. Reload and review the current folder before enabling them.", control: this.store.globalDefinitionsControl(homePath)};
      if (!input.enabled && verified !== globalFingerprint) globalFingerprint = null;
    }
    if (this.store.globalDefinitionsControl(homePath).generation !== input.expectedGeneration) {
      return {status: "conflict" as const, message: "Global definitions changed before the setting could be enabled. Refresh before continuing.", control: this.store.globalDefinitionsControl(homePath)};
    }
    try {
      const control = this.store.saveGlobalDefinitionsControl(input.expectedGeneration, input.enabled, homePath, globalFingerprint);
      return {status: "saved" as const, message: input.enabled ? "Global definitions are now included in project Supervisor policy. Existing folder contents were preserved." : "Global definitions are no longer included. Project-local definitions remain available; existing plans are retained as stale history.", control};
    } catch {return {status: "conflict" as const, message: "Global definitions changed in another window. Reload before saving.", control: this.store.globalDefinitionsControl(homePath)};}
  }
  async setupOptions(projectId: string, signal: AbortSignal) {
    const {project, catalog} = await this.project(projectId);
    const control = await this.control(projectId, signal);
    if (!this.definitions?.checkoutTargets || !this.definitions.presenceForCheckout) {
      return {projectId, generation: control.generation, available: false, message: "Registered checkout setup is unavailable.", checkouts: []};
    }
    let targets: readonly SetupCheckoutTarget[];
    try {targets = await this.definitions.checkoutTargets(projectId, signal);}
    catch {return {projectId, generation: control.generation, available: false, message: "Registered checkout targets could not be read.", checkouts: []};}
    const valid = targets.filter(target => {
      const scratch = this.scratchProject(projectId, project.workspaceRoot);
      if (scratch) return false;
      if (target.threadId === null) return resolve(target.workspaceRoot) === resolve(project.workspaceRoot);
      const thread = catalog.threads.find(item => item.id === target.threadId && item.projectId === projectId);
      return Boolean(thread && this.eligible(thread, catalog.threads) && mainConversation(thread!, catalog.threads)?.id === thread!.id);
    });
    const checkouts = await Promise.all(valid.map(async target => {
      try {
        if (target.threadId !== null) {
          const projection = await this.projection(target.threadId, signal);
          const workspace = projection.thread.worktreePath;
          if (!this.eligible(projection.thread, catalog.threads) || projection.thread.projectId !== projectId || typeof workspace !== "string" || resolve(workspace) !== resolve(target.workspaceRoot)) throw new Error("checkout_binding_changed");
        }
        const presence = await this.definitions!.presenceForCheckout!(projectId, target.threadId, signal);
        return {...target, folderStatus: presence.status};
      } catch {return {...target, folderStatus: "unavailable" as const};}
    }));
    return {projectId, generation: control.generation, available: checkouts.length > 0,
      message: checkouts.length ? "Choose a registered checkout and confirm its current branch before creating .t3-supervisor files." : "No eligible registered checkout is available.", checkouts};
  }
  async setup(input: SupervisionSetupInput, signal: AbortSignal) {
    const current = await this.control(input.projectId, signal);
    if (!this.store.scopeCompatible) return {status: "unavailable" as const, message: "Supervisor state is unavailable; no setup was made.", control: current, workspaceRoot: null, branch: null};
    if (current.generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed in another window. Reload checkout options before setup.", control: current, workspaceRoot: null, branch: null};
    if (!this.definitions?.checkoutTargets || !this.definitions.presenceForCheckout || (input.action !== "enable_existing" && !this.definitions.initialize)) {
      return {status: "unavailable" as const, message: "Registered checkout setup is unavailable; no files were changed.", control: current, workspaceRoot: null, branch: null};
    }
    const options = await this.setupOptions(input.projectId, signal);
    const selected = options.checkouts.find(target => target.origin === input.origin && target.threadId === input.threadId && target.workspaceRoot === input.expectedWorkspaceRoot && target.branch === input.expectedBranch);
    if (!options.available || !selected) return {status: "conflict" as const, message: "The selected checkout or branch changed. Reload the setup options before retrying.", control: this.store.control(input.projectId), workspaceRoot: null, branch: null};
    if (input.action === "create_and_commit" && !selected.isGitRepository) return {status: "unavailable" as const, message: "This checkout is not a Git repository; choose Create without commit.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
    if (input.action === "enable_existing" && selected.folderStatus === "missing") return {status: "conflict" as const, message: "The selected checkout no longer has .t3-supervisor. Reload checkout options before enabling.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
    if (input.action !== "enable_existing" && selected.folderStatus === "present") return {status: "conflict" as const, message: "This checkout already has .t3-supervisor. Refresh its definitions before choosing another setup action.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
    if (selected.folderStatus === "unavailable") return {status: "unavailable" as const, message: "The selected checkout could not be checked; no files were changed.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
    if (this.store.control(input.projectId).generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed in another window. Reload checkout options before setup.", control: this.store.control(input.projectId), workspaceRoot: null, branch: null};
    let baseline: SupervisorBaseline | undefined;
    if (!current.enabled && current.globallyEnabled) {
      try {baseline = await this.activationSnapshot(signal);}
      catch {return {status: "unavailable" as const, message: "The enable boundary could not be captured; no files were changed.", control: this.store.control(input.projectId), workspaceRoot: null, branch: null};}
    }
    if (this.store.control(input.projectId).generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed before checkout setup. No files were changed.", control: this.store.control(input.projectId), workspaceRoot: null, branch: null};
    const {catalog} = await this.project(input.projectId);
    const project = catalog.projects.find(item => item.available && item.project.id === input.projectId)?.project;
    if (!project) return {status: "unavailable" as const, message: "The registered project is no longer available; no files were changed.", control: this.store.control(input.projectId), workspaceRoot: null, branch: null};
    if (this.scratchProject(input.projectId, project.workspaceRoot)) {
      return {status: "conflict" as const, message: "Scratch definitions use the separate server-user .t3-supervisor control.", control: this.store.control(input.projectId), workspaceRoot: null, branch: null};
    }
    if (input.threadId !== null) {
      const thread = catalog.threads.find(item => item.id === input.threadId && item.projectId === input.projectId);
      if (!thread || !this.eligible(thread, catalog.threads) || mainConversation(thread, catalog.threads)?.id !== thread.id) return {status: "conflict" as const, message: "The selected operative checkout is no longer available; no files were changed.", control: this.store.control(input.projectId), workspaceRoot: null, branch: null};
      const projection = await this.projection(input.threadId, signal);
      if (projection.thread.id !== input.threadId || !this.eligible(projection.thread, catalog.threads) || projection.thread.projectId !== input.projectId || typeof projection.thread.worktreePath !== "string" || resolve(projection.thread.worktreePath) !== resolve(input.expectedWorkspaceRoot)) return {status: "conflict" as const, message: "The selected operative checkout changed; no files were changed.", control: this.store.control(input.projectId), workspaceRoot: null, branch: null};
    }
    if (this.store.control(input.projectId).generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed before checkout setup. No files were changed.", control: this.store.control(input.projectId), workspaceRoot: null, branch: null};
    if (input.action === "enable_existing") {
      let targets: SetupCheckoutTarget[];
      try {targets = await this.definitions.checkoutTargets(input.projectId, signal);}
      catch {return {status: "unavailable" as const, message: "The selected checkout could not be revalidated; no settings were changed.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};}
      const stillSelected = targets.some(target => target.origin === input.origin && target.threadId === input.threadId &&
        target.workspaceRoot === input.expectedWorkspaceRoot && target.branch === input.expectedBranch);
      if (!stillSelected) return {status: "conflict" as const, message: "The selected checkout or branch changed. Reload checkout options before enabling.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      let latestCatalog: Awaited<ReturnType<ProjectSupervisor["project"]>>["catalog"];
      try {latestCatalog = (await this.project(input.projectId)).catalog;}
      catch {return {status: "unavailable" as const, message: "The project changed while checkout enablement was being checked; no settings were changed.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};}
      const latestProject = latestCatalog.projects.find(item => item.available && item.project.id === input.projectId)?.project;
      if (!latestProject || (input.threadId === null && resolve(latestProject.workspaceRoot) !== resolve(input.expectedWorkspaceRoot))) {
        return {status: "conflict" as const, message: "The selected project checkout changed. Reload checkout options before enabling.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      }
      if (input.threadId !== null) {
        const latestMain = latestCatalog.threads.find(item => item.id === input.threadId && item.projectId === input.projectId);
        if (!latestMain || !this.eligible(latestMain, latestCatalog.threads) || mainConversation(latestMain, latestCatalog.threads)?.id !== latestMain.id) {
          return {status: "conflict" as const, message: "The selected checkout is no longer an eligible main conversation. Reload checkout options before enabling.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
        }
        let projection: Projection;
        try {projection = await this.projection(input.threadId, signal);}
        catch {return {status: "unavailable" as const, message: "The selected checkout projection could not be revalidated; no settings were changed.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};}
        if (projection.thread.id !== input.threadId || !this.eligible(projection.thread, latestCatalog.threads) || projection.thread.projectId !== input.projectId ||
          typeof projection.thread.worktreePath !== "string" || resolve(projection.thread.worktreePath) !== resolve(input.expectedWorkspaceRoot)) {
          return {status: "conflict" as const, message: "The selected operative checkout changed. Reload checkout options before enabling.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
        }
      }
      let presence: SupervisionFolderPresence;
      try {presence = await this.definitions.presenceForCheckout(input.projectId, input.threadId, signal);}
      catch {return {status: "unavailable" as const, message: "The selected checkout could not be checked; no settings were changed.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};}
      if (presence.status === "missing") return {status: "conflict" as const, message: "The selected checkout no longer has .t3-supervisor. Reload checkout options before enabling.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      if (presence.status === "unavailable") return {status: "unavailable" as const, message: presence.message ?? "The selected checkout could not be checked; no settings were changed.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      if (this.store.control(input.projectId).generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed before checkout enablement. Reload before continuing.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      try {
        this.store.saveControl(input.projectId, input.expectedGeneration, true, baseline);
        this.store.setFolderPresence(input.projectId, {status: "present"});
        const control = this.store.control(input.projectId);
        return {status: "saved" as const, message: "Existing .t3-supervisor definitions were adopted and project supervision is enabled. No files were written or committed.", control,
          workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      } catch {
        return {status: "conflict" as const, message: "Supervision changed before enablement. Refresh controls before continuing.",
          control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      }
    }
    if (!this.definitions.initialize) return {status: "unavailable" as const, message: "Project checkout creation is unavailable; no files were changed.", control: this.store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
    let outcome: SetupOutcome;
    try {outcome = await this.definitions.initialize(input.projectId, input.threadId, {origin: "project", action: input.action,
      expectedWorkspaceRoot: input.expectedWorkspaceRoot, expectedBranch: input.expectedBranch}, signal);}
    catch {return {status: "uncertain" as const, message: "The setup outcome could not be confirmed. Inspect the selected checkout before retrying.", control: this.store.control(input.projectId), workspaceRoot: input.expectedWorkspaceRoot, branch: input.expectedBranch};}
    const confirmed = input.action === "create" ? outcome.status === "created" : outcome.status === "committed";
    if (!confirmed || outcome.workspaceRoot !== input.expectedWorkspaceRoot || outcome.branch !== input.expectedBranch) {
      const status = outcome.status === "stale" || outcome.status === "conflict" || outcome.status === "unchanged" || confirmed ? "conflict" as const : outcome.status === "uncertain" ? "uncertain" as const : "unavailable" as const;
      return {status, message: outcome.message || (status === "conflict" ? "The selected checkout changed; reload setup options." : status === "uncertain" ? "The setup result is uncertain. Inspect the checkout before retrying." : "The selected checkout could not be initialized."),
        control: this.store.control(input.projectId), workspaceRoot: outcome.workspaceRoot, branch: outcome.branch};
    }
    try {
      const control = this.store.saveControl(input.projectId, input.expectedGeneration, true, baseline);
      this.store.setFolderPresence(input.projectId, {status: "present"});
      return {status: "saved" as const, message: "The selected checkout was initialized and project supervision is enabled.", control,
        workspaceRoot: outcome.workspaceRoot, branch: outcome.branch};
    } catch {
      return {status: "conflict" as const, message: "The checkout was initialized, but supervision changed before enablement. Refresh controls before continuing.",
        control: this.store.control(input.projectId), workspaceRoot: outcome.workspaceRoot, branch: outcome.branch};
    }
  }
  async saveControl(input: SupervisionControlInput, signal: AbortSignal) {
    const registered = input.projectId !== null ? (await this.project(input.projectId)).project : null;
    const current = input.projectId === null ? this.store.control(null) : await this.resolveControl(input.projectId, signal);
    const visibleCurrent = input.projectId === null ? current : this.effectiveControl(input.projectId);
    if (!this.store.scopeCompatible) return {status: "unavailable" as const, message: "Supervisor state is unavailable; no change was made.", control: visibleCurrent};
    if (current.generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed in another window. Reload before saving.", control: visibleCurrent};
    if (registered && this.scratchProject(registered.id, registered.workspaceRoot)) return {status: "unavailable" as const,
      message: "Use the No Project mode in Instance settings. Shared definitions do not activate chats.", control: visibleCurrent};
    if (input.projectId !== null && input.enabled && !(current.manual && current.enabled)) {
      const presence = await this.detectFolder(input.projectId, signal);
      const detected = this.store.control(input.projectId);
      const visibleDetected = this.effectiveControl(input.projectId);
      if (detected.generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed in another window. Reload before saving.", control: visibleDetected};
      if (presence.status === "missing") return {status: "setup_required" as const, message: "Choose a registered checkout and create its .t3-supervisor folder before enabling project supervision.", control: visibleDetected};
      if (presence.status === "unavailable") return {status: "unavailable" as const, message: presence.message ?? "The project .t3-supervisor folder could not be checked; no change was made.", control: visibleDetected};
    }
    const latest = this.store.control(input.projectId);
    const needsBoundary = input.enabled && !latest.enabled && (input.projectId === null || latest.globallyEnabled);
    let baseline: SupervisorBaseline | undefined;
    if (needsBoundary) {
      try {baseline = await this.activationSnapshot(signal);}
      catch {return {status: "unavailable" as const, message: "The enable boundary could not be captured; no change was made.", control: input.projectId === null ? this.store.control(null) : this.effectiveControl(input.projectId)};}
    }
    try {
      this.store.saveControl(input.projectId, input.expectedGeneration, input.enabled, baseline);
      const control = input.projectId === null ? this.store.control(null) : this.effectiveControl(input.projectId);
      return {status: "saved" as const, message: input.enabled ? "Enabled. Existing scopes are retained; new task discovery starts from this enable boundary." : "Disabled. No new supervisory work will start; an already-running model turn may finish. Chats and history are retained.", control};
    } catch {return {status: "conflict" as const, message: "Supervision changed in another window. Reload before saving.", control: input.projectId === null ? this.store.control(null) : this.effectiveControl(input.projectId)};}
  }
  private validPendingStartFor(threadId: string): boolean {const start = this.store.start(threadId);return Boolean(start && this.validPendingStart(start));}
  private rejectStart(start: SupervisionStartRecord, reason: string): void {
    if (this.store.start(start.threadId)?.operationId === start.operationId) this.store.saveStart({...start, status: "rejected", reason});
  }
  private activateStart(start: SupervisionStartRecord): boolean {
    if (!this.validPendingStart(start)) return false;
    // pending is durable before the separate policy write; a crash cannot grant on-request effects without the committed permission
    const written = this.writeChatPolicy(start.threadId, false);
    if (written.status !== "saved") return false;
    this.store.recordChatEnable(start.threadId, start.intentAt);
    this.applyChatStop(start.threadId, null);
    this.store.saveStart({...start, status: "active", reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor."});
    return true;
  }
  startStatus(threadId: string, operationId: string) {
    const operation = this.store.startOperation(threadId, operationId);
    return operation ? {threadId, operationId, status: operation.status, reason: operation.reason}
      : {threadId, operationId, status: "denied" as const, reason: "No matching Start operation is recorded. Nothing was replayed."};
  }
  async candidates(query = "", purpose: "start" | "exclude" = "start") {
    if (query.length > 512) return {exceptions: [], candidates: [], message: "Search is limited to 512 characters."};
    const catalog = await Effect.runPromise(this.source.catalog());
    this.rememberScratchProjects(catalog.projects.map(item => item.project));
    const search = query.trim().replace(/^t3-thread:\/\/v1\//u, "").toLowerCase();
    const relevant = (projectId: string, threadId: string) => this.store.control(null).enabled && (this.isNoProject(projectId)
      ? this.store.noProjectControl().mode !== "off" && (this.store.noProjectControl().mode === "automatic" || this.store.start(threadId)?.status === "active")
      : this.store.enabled(projectId));
    const exceptions = currentThreadPolicy(this.config).excludedThreadIds.filter(id => {
      const thread = catalog.threads.find(item => item.id === id);return thread?.projectId && relevant(thread.projectId, id);
    });
    const rows = catalog.threads.filter(thread => {
      if (!thread.projectId || !this.mainShape(thread) || mainConversation(thread, catalog.threads)?.id !== thread.id ||
        !catalog.projects.some(item => item.available && item.project.id === thread.projectId)) return false;
      if (purpose === "start" ? !this.isNoProject(thread.projectId) : !relevant(thread.projectId, thread.id)) return false;
      return !search || thread.id.toLowerCase() === search || thread.title.toLowerCase().includes(search);
    }).sort((a,b) => (timestampMs(b.updatedAt) ?? 0) - (timestampMs(a.updatedAt) ?? 0) || a.id.localeCompare(b.id)).slice(0, 8);
    return {exceptions, candidates: rows.map(thread => ({id: thread.id, projectId: thread.projectId!, title: thread.title,
      updatedAt: typeof thread.updatedAt === "string" ? thread.updatedAt : null, active: this.store.start(thread.id)?.status === "active" && !this.supervisionStopped(thread.id),
      excluded: this.supervisionStopped(thread.id)})), message: rows.length ? "Choose a chat. At most eight matches are shown." : "No matching available chat. Paste its native T3 link or change the search."};
  }
  private async requestStart(threadId: string, operationId: string, route: "agent" | "ui", userMessageId: string | null,
    runId: string | null, signal: AbortSignal): Promise<SupervisionStartResult> {
    const requestHash = fingerprint({threadId, operationId, route, userMessageId});
    const prior = this.store.startOperation(threadId, operationId);
    if (prior) return prior.requestHash === requestHash ? {status: prior.status, reason: prior.reason} : {status: "denied", reason: "operation_id_conflict"};
    if (!threadId || threadId.length > 512 || !operationId || operationId.length > 512) return {status: "invalid", reason: "invalid_start_arguments"};
    this.store.saveStartOperation({threadId, operationId, requestHash, status: "pending", reason: "Checking the requested chat and original human source.", preparing: true});
    let result: SupervisionStartResult;
    try {result = await this.evaluateStart(threadId, operationId, route, userMessageId, runId, signal);}
    catch {result = {status: "unavailable", reason: "Start preparation failed before activation. Use a new explicit request after inspecting this outcome."};}
    const saved = this.store.startOperation(threadId, operationId);
    if (saved?.preparing) this.store.saveStartOperation({threadId, operationId, requestHash, status: result.status === "invalid" ? "denied" : result.status, reason: result.reason});
    return result;
  }
  private async evaluateStart(threadId: string, operationId: string, route: "agent" | "ui", userMessageId: string | null,
    runId: string | null, signal: AbortSignal): Promise<SupervisionStartResult> {
    if (!threadId || threadId.length > 512 || !operationId || operationId.length > 512 || /[\s\x00-\x1f\x7f]/u.test(operationId)) return {status: "invalid", reason: "invalid_start_arguments"};
    const catalog = await Effect.runPromise(this.source.catalog());
    this.rememberScratchProjects(catalog.projects.map(item => item.project));
    const thread = catalog.threads.find(item => item.id === threadId);
    if (!thread?.projectId || !this.mainShape(thread) || mainConversation(thread, catalog.threads)?.id !== threadId ||
      !catalog.projects.some(item => item.available && item.project.id === thread.projectId) || !this.isNoProject(thread.projectId))
      return {status: "denied", reason: "own_ordinary_no_project_chat_required"};
    const mode = this.store.noProjectControl();const master = this.store.control(null);
    if (!this.operateRpc || !this.store.scopeCompatible || !master.enabled || mode.mode === "off") return {status: "denied", reason: "master_or_no_project_mode_off"};
    const requestHash = fingerprint({threadId, operationId, route, userMessageId});
    const previous = this.store.start(threadId);
    if (previous?.operationId === operationId) return previous.requestHash === requestHash
      ? {status: previous.status, reason: previous.reason} : {status: "denied", reason: "operation_id_conflict"};
    if (previous?.status === "pending") return {status: "denied", reason: "An earlier Start is unresolved. Reconcile its operation ID before another request."};
    const projection = await this.projection(threadId, signal);
    if (projection.thread.projectId !== thread.projectId || !this.mainShape(projection.thread)) return {status: "denied", reason: "scope_changed"};
    let message = userMessageId ? this.genuineUserMessage(projection, userMessageId) : null;
    const latestHuman = [...projection.messages].filter(item => this.genuineUserMessage(projection, item.id)).sort((a,b) => (timestampMs(b.createdAt) ?? 0) - (timestampMs(a.createdAt) ?? 0)).at(0);
    if (route === "agent" && (!message || message.runId !== runId || latestHuman?.id !== message.id)) return {status: "denied", reason: "start_call_not_in_genuine_human_turn"};
    if (route === "ui") message = latestHuman && projection.runs.some(run => run.id === latestHuman.runId && ["preparing", "queued", "starting", "running", "waiting"].includes(run.status)) ? latestHuman : null;
    if (message && message.text.length > 24_000) return {status: "denied", reason: "start_source_too_large"};
    const intentAt = route === "agent" ? timestampMs(message?.createdAt) : this.now();
    if (intentAt === null || (this.store.chatStop(threadId)?.stoppedAt ?? -1) >= intentAt || (this.store.chatEnabledAt(threadId) ?? -1) >= intentAt)
      return {status: "denied", reason: "superseded_by_later_stop_or_enable"};
    const task = this.store.task(threadId);
    const intro = task ? this.conversation.requests.introduction(task.id) : null;
    if (task && ["queued", "dispatching", "waiting", "uncertain"].includes(task.status) || intro && introductionOutcomeUnknown(intro))
      return {status: "denied", reason: "Existing native work has an unresolved outcome; its original identities must be reconciled first."};
    if (previous?.status === "active" && !this.supervisionStopped(threadId)) return {status: "active", reason: previous.reason};
    if (mode.generation !== this.store.noProjectControl().generation || master.generation !== this.store.control(null).generation || !this.store.control(null).enabled)
      return {status: "denied", reason: "scope_mode_changed"};
    const run = message ? projection.runs.find(item => item.id === message!.runId)! : null;
    const record: SupervisionStartRecord = {threadId, projectId: thread.projectId, operationId, requestHash, route, status: "pending",
      reason: "Waiting for the Supervisor's first source-bound Start interpretation.", intentAt, modeGeneration: mode.generation, masterGeneration: master.generation,
      taskId: message ? randomUUID() : null, ...(message && run ? {source: {messageId: message.id, runId: run.id, ordinal: run.ordinal, hash: fingerprint(message.text)}} : {})};
    this.store.saveStart(record);
    if (route === "ui") {
      if (!this.store.store.transaction(() => this.activateStart(record))) {this.rejectStart(record, "Start could not be committed.");return {status: "unavailable", reason: "Start was not activated."};}
      return {status: "active", reason: this.store.start(threadId)!.reason};
    }
    return {status: "pending", reason: record.reason};
  }
  /** The agent can request only its own chat; exact native wire evidence has already been verified. */
  startSupervision(input: SupervisionStartInput, evidence: {runId: string}, signal: AbortSignal): Promise<SupervisionStartResult> {
    return this.serial(`start:${input.callerThreadId}`, () => this.requestStart(input.callerThreadId, input.operationId, "agent", input.userMessageId, evidence.runId, signal));
  }
  dashboardStart(threadId: string, operationId: string, signal: AbortSignal): Promise<SupervisionStartResult> {
    return this.serial(`start:${threadId}`, () => this.requestStart(threadId, operationId, "ui", null, null, signal));
  }
  private async prepareStarts(signal: AbortSignal): Promise<void> {
    const rows = this.store.store.db.prepare("SELECT value FROM meta WHERE key LIKE 'supervisor_start:%'").all();
    for (const row of rows) {
      const start = JSON.parse(String(row.value)) as SupervisionStartRecord;
      if (start.route === "ui" && start.status === "pending") {
        if (!this.store.store.transaction(() => this.activateStart(start))) {this.rejectStart(start, "Dashboard Start was superseded before activation.");continue;}
        start.status = "active";
      }
      if (!start.source || !start.taskId || start.status === "rejected" || start.taskPrepared) continue;
      if (this.store.task(start.threadId)?.id === start.taskId) {this.store.saveStart({...start, taskPrepared: true});continue;}
      if (start.status === "pending" && !this.validPendingStart(start)) {this.rejectStart(start, "Start was superseded by a control change.");continue;}
      if (!this.projectEnabled(start.projectId, start.threadId)) continue;
      await this.serial(supervisorScopeKey(start.projectId, start.threadId), async () => {
        const main = await this.projection(start.threadId, signal);
        const message = this.genuineUserMessage(main, start.source!.messageId);
        if (!message || message.runId !== start.source!.runId || fingerprint(message.text) !== start.source!.hash) {this.rejectStart(start, "The original human request changed or became unavailable.");return;}
        const binding = await this.ensureBinding(start.projectId, start.threadId, main.thread.title, signal);
        if (!this.projectEnabled(start.projectId, start.threadId) || this.store.start(start.threadId)?.operationId !== start.operationId) return;
        this.store.store.transaction(() => {
        this.store.saveTask({id: start.taskId!, threadId: start.threadId, projectId: start.projectId, sourceMessageId: message.id, sourceRunId: start.source!.runId,
          sourceOrdinal: start.source!.ordinal, sourceHash: start.source!.hash, status: "queued", objective: null, reason: "Preparing the explicitly requested supervision.",
          updatedAt: this.now(), requestText: "", supervisorThreadId: binding.threadId, messageId: `supervisor-objective:${start.taskId}`,
          supervisorRunId: null, dispatchedAt: null, replayCount: 0});
        this.store.saveStart({...this.store.start(start.threadId)!, taskPrepared: true});
        });
      }).catch(() => undefined);
    }
  }
  async overview(page: {offset: number; limit: number}) {
    const catalog = await Effect.runPromise(this.source.catalog());
    this.rememberScratchProjects(catalog.projects.map(item => item.project));
    return buildDashboardOverview({...page, fingerprint, observedAt: this.now(),
      available: this.store.scopeCompatible && Boolean(this.operateRpc), globallyEnabled: this.store.control(null).enabled,
      projects: catalog.projects, threads: catalog.threads, bindings: this.store.scopeCompatible ? this.store.bindings() : [],
      tasks: projectId => this.store.tasks(projectId),
      control: projectId => this.effectiveControl(projectId),
      scopeEnabled: (projectId, mainThreadId) => this.scopeEnabled(projectId, mainThreadId),
      monitoring: binding => this.conversation.status(binding.projectId, binding.threadId),
      assessment: (binding, task) => {
        const result = this.workflowStates.getState(binding.projectId, binding.mainThreadId);
        return result.status === "found" ? assessmentForTask(workflowAssessment(result.document), task) : null;
      },
      excluded: new Set(currentThreadPolicy(this.config).excludedThreadIds)});
  }
  async snapshot(projectId: string, signal: AbortSignal, mainThreadId: string | null = null): Promise<ProjectSupervisorInfo> {
    const {catalog} = await this.project(projectId);
    if (mainThreadId !== null) {
      const selected = catalog.threads.find(thread => thread.id === mainThreadId && thread.projectId === projectId);
      // a chat whose supervision is stopped stays inspectable so its state and the Enable supervision control remain visible
      if (!selected || mainConversation(selected, catalog.threads)?.id !== mainThreadId ||
        !(this.eligible(selected, catalog.threads) || this.supervisionStopped(mainThreadId) && this.mainShape(selected))) throw new Error("invalid_main_conversation");
    }
    const binding = this.store.scopeCompatible && mainThreadId ? this.store.binding(projectId, mainThreadId) : null;
    let selection: SupervisorModelSelection | null = null;let available = Boolean(this.operateRpc && this.store.scopeCompatible);let message = binding ? "Supervisor conversation is being prepared." : "The Supervisor conversation will be created automatically for the first new task.";
    let models: ProjectSupervisorInfo["models"] = [];
    try {
      models = await this.models(signal);
      if (binding) {
        let projection: Projection | null;
        try {projection = await this.projection(binding.threadId, signal);}
        catch (cause) {if (cause instanceof T3TransportError && cause.httpStatus === 404) projection = null;else throw cause;}
        if (!projection) {message = binding.state === "ready" || binding.state === "missing" ? "The Supervisor conversation was deleted. Explicit replacement retains its old request identities." : binding.state === "rejected" ? "T3 rejected conversation creation. Save the desired model and retry native access." : "Conversation creation is uncertain. Retry native access to reconcile the original identity.";}
        else {
        if (projection.thread.projectId !== projectId) throw new Error("supervisor_unavailable");
        if (supervisorUnavailable(projection.thread)) {available = false;message = "The Supervisor conversation is archived or deleted. Restore it in T3; no automatic recreation occurs.";}
        else {
        selection = modelSelection(projection.thread.modelSelection);
        available = Boolean(available && selection);
        message = available && selection && validModelSelection(selection, models) ? "T3 runs the Supervisor for this main conversation. Valid new workflow drafts can be introduced through active steering, with ongoing check-ins from existing T3 activity." : "The configured Supervisor model is unavailable in T3. Choose an available model; no fallback model will run.";
        if (projection.thread.runtimeMode !== "full-access" || projection.thread.interactionMode !== "default") message += " This existing conversation retains its native modes; contact with a broader-mode operative chat needs an explicit mode change in T3.";
      }
      }
      }
      if (!this.operateRpc) message = "Project supervision needs a dedicated T3 read/operate credential through deployment setup.";
    } catch {available = false;message = "T3 Supervisor access is unavailable. Existing settings and conversation identity are retained.";}
    const current = this.store.settings(projectId);
    if (this.store.baseline() === null) message = "Native task discovery is initializing; interpretation is not active yet. " + message;
    const application = binding ? this.store.modelState(binding) : null;
    if (application?.applicationMessage) message = `${message} ${application.applicationMessage}`;
    if (current.pending && models.length && !validModelSelection(current.modelSelection, models)) message = "The saved Supervisor model is unavailable. Choose an available T3 model; no fallback will run.";
    if (binding?.settlement?.state === "uncertain") message += " Automatic settlement could not be confirmed. Retry native access reconciles the retained settlement command; supervision can continue in the same chat.";
    if (binding?.stopNotice && ["uncertain", "accepted", "blocked", "unconfirmed", "ready"].includes(binding.stopNotice.state))
      message += ` Operative Stop notice: ${binding.stopNotice.state}${binding.stopNotice.error ? ` (${binding.stopNotice.error})` : "."}`;
    if (binding?.manualKeepActive) message += " Automatic settlement is held by an observed user keep-active choice.";
    if (!this.store.scopeCompatible) {available = false;message = "Supervisor state has an unsupported scope version. Supervision is disabled without resetting state; other service integrations remain available.";}
    if (binding?.state === "rejected" && binding.creationMessage) message = binding.creationMessage;
    if (!binding && models.length && !validModelSelection(current.modelSelection, models)) message = "Default Supervisor model unavailable. Choose an available T3 model; no fallback will run.";
    if (!this.projectEnabled(projectId, mainThreadId ?? undefined)) message = "Supervision is disabled globally or for this project. Existing chats and history are retained. " + message;
    const policy = currentThreadPolicy(this.config);
    const stop = mainThreadId ? this.store.chatStop(mainThreadId) : null;
    const chatSupervision = mainThreadId ? {stopped: policy.excludedThreadIds.includes(mainThreadId), policyGeneration: policy.generation,
      stoppedBy: stop?.route ?? null, stoppedAt: stop?.stoppedAt ?? null,
      stoppedCallerThreadId: stop?.callerThreadId ?? null, stoppedUserMessageId: stop?.userMessageId ?? null,
      effectiveEnabled: this.scopeEnabled(projectId, mainThreadId), activation: this.isNoProject(projectId) ? this.store.start(mainThreadId)?.status ?? "not_started" : "automatic"} : null;
    return {projectId, mainThreadId, ...(this.isNoProject(projectId) ? {noProjectMode: this.store.noProjectControl().mode} : {}), chatSupervision, team: binding ? supervisorTeamView(this.team, binding, catalog.threads, this.conversation.requests, this.now()) : null, modelApplication: application ? {pending: application.pending, attempts: application.applyAttempts ?? 0, message: application.applicationMessage ?? null} : null, settings: {generation: current.generation, modelSelection: current.modelSelection, pending: false, monitoring: current.monitoring, teamSettings: current.teamSettings ?? {maxHelpersPerRoot: 5}}, monitoringStatus: this.conversation.status(projectId, binding?.threadId ?? null), binding: binding ? {...binding, settlementState: binding.settlement?.state ?? null, keptActive: Boolean(binding.manualKeepActive)} : null, modelSelection: selection, models, available, message,
      tasks: (binding ? this.store.tasksFor(binding) : []).slice(-200).reverse().map(({id,sourceHash,threadId,projectId,sourceRunId,sourceMessageId,status,objective,reason,updatedAt,workflow,workflowProposalId,agreement,definitionReview,workflowProtocolDiagnostic}) => ({id,sourceHash,threadId,projectId,sourceRunId,sourceMessageId,status,objective,reason,updatedAt,workflow: workflow ?? null,
        ...(workflowProposalId ? {workflowProposalId} : {}), agreement: agreement ?? null, workflowProtocolDiagnostic: workflowProtocolDiagnostic ?? null,
        ...(definitionReview ? {definitionReview} : {})}))};
  }
  async save(input: ProjectSupervisorSaveInput, signal: AbortSignal): Promise<ProjectSupervisorSaveOutcome> {
    if (!this.store.scopeCompatible) return {status: "unavailable", message: "Supervisor state version is unsupported; no changes were made.", snapshot: null};
    return this.serial(input.projectId, async () => {
      await this.project(input.projectId);
      if (input.mainThreadId) await this.snapshot(input.projectId, signal, input.mainThreadId);
      if (!sameModel(input.modelSelection, this.store.settings(input.projectId).modelSelection) && !validModelSelection(input.modelSelection, await this.models(signal))) return {status: "invalid", message: "Choose an available T3 model and its advertised reasoning options.", snapshot: null};
      try {this.store.saveSettings(input.projectId, input.expectedGeneration, input.modelSelection, input.monitoring, input.teamSettings);}
      catch (cause) {if (cause instanceof Error && cause.message === "invalid_team_settings") return {status: "invalid", message: "Choose a whole-number helper limit from 0 to 20.", snapshot: null};return cause instanceof Error && cause.message === "invalid_monitoring_settings" ? {status: "invalid", message: "Use an interval of 1–60 minutes and an activity threshold of 3–100, both whole numbers.", snapshot: null} : {status: "conflict", message: "Project Supervisor settings changed. Refresh before saving again.", snapshot: null};}
      return {status: "saved", message: "Saved. Monitoring settings apply on the next service check without discarding pending activity; model defaults apply only to new Supervisor conversations. Edit existing models in T3.", snapshot: await this.snapshot(input.projectId, signal, input.mainThreadId ?? null)};
    });
  }
  /** Whether the instance thread policy stops supervision of this chat; the same control backs the dashboard and supervision_stop. */
  supervisionStopped(threadId: string): boolean {return currentThreadPolicy(this.config).excludedThreadIds.includes(threadId);}
  private writeChatPolicy(threadId: string, stopped: boolean, expectedGeneration?: number):
    {status: "saved"; changed: boolean} | {status: "conflict" | "unavailable" | "full"} {
    const policy = this.config.threadPolicy;
    if (!policy) return {status: "unavailable"};
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = policy.get();
      if (expectedGeneration !== undefined && current.generation !== expectedGeneration) return {status: "conflict"};
      if (current.excludedThreadIds.includes(threadId) === stopped) return {status: "saved", changed: false};
      if (stopped && current.excludedThreadIds.length >= 500) return {status: "full"};
      try {
        policy.save({...current, excludedThreadIds: stopped ? [...current.excludedThreadIds, threadId] : current.excludedThreadIds.filter(id => id !== threadId)});
        return {status: "saved", changed: true};
      } catch {if (expectedGeneration !== undefined) return {status: "conflict"};}
    }
    return {status: "conflict"};
  }
  // records the stop and a single operative notice, and fences unsent check-ins without cancelling operative work.
  // a stop supersedes any earlier keep-active choice for the owned Supervisor, so its settlement is not vetoed by an older intent.
  private applyChatStop(threadId: string, stop: NonNullable<BindingRecord["supervisionStop"]> | null): void {
    const start = this.store.start(threadId);
    if (stop && start?.status === "pending" && stop.stoppedAt >= start.intentAt)
      this.store.saveStart({...start, status: "rejected", reason: "Superseded by a later Stop."});
    const bindings = this.store.bindings().filter(item => item.mainThreadId === threadId);
    if (!bindings.length) this.store.saveUnboundStop(threadId, stop);
    for (const binding of bindings) {
      const write = () => {
        this.store.setSupervisionStop(binding, stop);
        const notice = binding.stopNotice;
        const enabledAt = this.store.chatEnabledAt(threadId);
        if (stop && (!notice || notice.enabledAt !== enabledAt && ["sent", "blocked", "superseded"].includes(notice.state)))
          this.store.setStopNotice(binding, notice?.messageId ?? null, prepareStopNotice(binding, stop.stoppedAt, enabledAt));
        else if (stop && notice?.state === "unconfirmed") this.store.setStopNotice(binding, notice.messageId, {...notice, state: "uncertain", visibilityMisses: 0, nextObserveAt: this.now()});
        else if (!stop && notice?.state === "ready") this.store.setStopNotice(binding, notice.messageId, {...notice, state: "superseded"});
      };
      if (this.store.store.db.isTransaction) write(); else this.store.store.transaction(write);
      if (stop) this.conversation.fenceStoppedSupervision(this.store.binding(binding.projectId, binding.mainThreadId)!);
    }
  }
  private genuineUserMessage(projection: Projection, messageId: string): MessageInfo | null {
    const message = projection.messages.find(item => item.id === messageId && item.threadId === projection.thread.id);
    const run = message?.runId ? projection.runs.find(item => item.id === message.runId && item.threadId === projection.thread.id) : undefined;
    return message && run && message.role === "user" && message.createdBy === "user" && !message.streaming &&
      (message.creationSource === "web" || message.creationSource === "mobile") && !message.senderThreadId && !message.scheduledTaskId && !message.source &&
      !message.id.startsWith("supervisor-notice:") && nativeUserMessageVisible(projection, run, message) ? message : null;
  }
  /**
   * Applies a verified supervision_stop. The caller's own native tool call is already verified; this resolves the route from the
   * caller's relation to the exact target and requires the human's original native message: in the bound root or its main (direct,
   * relay), in the main itself (relay), or in another ordinary chat whose message names the exact target ID (chat).
   */
  async stopSupervision(input: SupervisionStopInput, evidence: unknown, signal: AbortSignal): Promise<SupervisionStopResult> {
    const catalog = await Effect.runPromise(this.source.catalog());
    const target = catalog.threads.find(thread => thread.id === input.targetThreadId);
    if (!target || isSupervisorThread(this.config, target) || target.lineage.relationshipToParent === "subagent" ||
      mainConversation(target, catalog.threads)?.id !== target.id) return {status: "denied", reason: "target_not_main_conversation"};
    const binding = this.store.bindingForSupervisor(input.callerThreadId);
    if (binding && (binding.mainThreadId !== target.id || binding.state !== "ready")) return {status: "denied", reason: "target_outside_supervisor_scope"};
    let caller: Projection;
    try {caller = await this.projection(input.callerThreadId, signal);} catch {return {status: "unavailable", reason: "caller_projection_unavailable", retryable: true};}
    let candidates: Array<{threadId: string; route: "direct" | "relay" | "chat"}>;
    if (binding) {
      candidates = [{threadId: input.callerThreadId, route: "direct"}, {threadId: target.id, route: "relay"}];
    } else if (isSupervisorThread(this.config, caller.thread)) return {status: "denied", reason: "supervisor_thread_not_bound_to_target"};
    else if (input.callerThreadId === target.id) candidates = [{threadId: target.id, route: "relay"}];
    else candidates = [{threadId: input.callerThreadId, route: "chat"}];
    let route: "direct" | "relay" | "chat" | null = null;
    let instructedAt = this.now();
    for (const candidate of candidates) {
      let projection: Projection;
      try {projection = candidate.threadId === input.callerThreadId ? caller : await this.projection(candidate.threadId, signal);}
      catch {return {status: "unavailable", reason: "evidence_projection_unavailable", retryable: true};}
      const message = this.genuineUserMessage(projection, input.userMessageId);
      if (!message) continue;
      // the calling assistant judges that the human asked to stop; the service only verifies provenance, target and ordering
      const words = message.text;
      // a human message that names another chat's ID authorizes only that chat, never the agent's choice of a different one, and
      // naming any second chat, the caller's own, a child or another Supervisor included, leaves the choice to the human; only the
      // target's own Supervisor conversation may be named alongside it
      const namesTarget = namesThread(words, target.id);
      const pairedSupervisorId = this.store.bindings().find(item => item.mainThreadId === target.id)?.threadId;
      if (catalog.threads.some(thread => thread.id !== target.id && thread.id !== pairedSupervisorId && namesThread(words, thread.id)))
        return {status: "denied", reason: namesTarget ? "target_ambiguous" : "target_not_named_by_user"};
      // a request from another chat must name the exact target so the human, not the agent, selects the stopped scope
      if (candidate.route === "chat" && !namesTarget) return {status: "denied", reason: "target_not_named_by_user"};
      // a stop instruction older than the latest explicit Enable never reverses it, including a replayed tool call
      const enabledAt = Math.max(this.store.chatEnabledAt(target.id) ?? -1, (this.store.start(target.id)?.status === "rejected" ? -1 : this.store.start(target.id)?.intentAt) ?? -1);
      if (enabledAt !== null && !(Date.parse(message.createdAt) > enabledAt)) return {status: "denied", reason: "superseded_by_later_enable"};
      // when the caller acts in the chat the human wrote in, its verified native call must answer that message, not a later unrelated turn
      const verifiedRunId = typeof evidence === "object" && evidence !== null && typeof (evidence as {runId?: unknown}).runId === "string" ? (evidence as {runId: string}).runId : null;
      if (verifiedRunId !== null && candidate.threadId === input.callerThreadId && verifiedRunId !== message.runId)
        return {status: "denied", reason: "stop_call_not_in_human_turn"};
      route = candidate.route;
      if (Number.isFinite(Date.parse(message.createdAt))) instructedAt = Date.parse(message.createdAt);
      break;
    }
    if (!route) return {status: "denied", reason: "user_message_not_genuine"};
    const recorded = this.store.chatStop(target.id);
    const written = this.writeChatPolicy(target.id, true);
    if (written.status !== "saved") return {status: "unavailable", reason: `thread_policy_${written.status}`, retryable: written.status === "conflict"};
    // the stop dates from the human's instruction; a replay or an older instruction keeps the recorded stop, so a keep-active
    // the human chose after it still holds, while a newer human stop supersedes that choice
    if (written.changed || !recorded || recorded.stoppedAt < instructedAt)
      this.applyChatStop(target.id, {route, callerThreadId: input.callerThreadId, userMessageId: input.userMessageId, stoppedAt: instructedAt});
    return {status: "stopped", targetThreadId: target.id, route, alreadyStopped: !written.changed};
  }
  /**
   * The Settings excluded-chat editor saves the same list as Stop supervision, so each chat it removes or adds gets the same
   * explicit Enable or Stop record as the dashboard control: a replayed stop never reverses that Enable.
   */
  saveThreadPolicy(input: ThreadPolicySettings): ThreadPolicySettings {
    const policy = this.config.threadPolicy;
    if (!policy) throw new Error("Chat settings unavailable.");
    const before = policy.get();
    if (before.generation !== input.generation) throw new Error("Chat settings changed in another tab. Reload first.");
    const saved = policy.save(input);
    const now = this.now();
    for (const id of before.excludedThreadIds.filter(id => !saved.excludedThreadIds.includes(id))) {this.store.recordChatEnable(id, now);this.applyChatStop(id, null);}
    for (const id of saved.excludedThreadIds.filter(id => !before.excludedThreadIds.includes(id)))
      this.applyChatStop(id, {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: now});
    return saved;
  }
  /** The dashboard's explicit human Stop supervision / Enable supervision control for one selected chat. */
  async setChatSupervision(input: ProjectSupervisorChatSupervisionInput, signal: AbortSignal): Promise<ProjectSupervisorSaveOutcome> {
    if (input.enabled) {
      await this.project(input.projectId);
      if (this.isNoProject(input.projectId)) {
        if (currentThreadPolicy(this.config).generation !== input.policyGeneration) return {status: "conflict", message: "Chat policy changed. Reload first.", snapshot: null};
        const result = await this.dashboardStart(input.mainThreadId, `enable:${randomUUID()}`, signal);
        return {status: result.status === "active" ? "saved" : "unavailable", message: result.reason, snapshot: await this.snapshot(input.projectId, signal, input.mainThreadId)};
      }
    }
    const written = this.writeChatPolicy(input.mainThreadId, !input.enabled, input.policyGeneration);
    if (written.status === "conflict") return {status: "conflict", message: "Chat settings changed in another tab or by the Supervisor. The saved state is shown.", snapshot: await this.snapshot(input.projectId, signal, input.mainThreadId).catch(() => null)};
    if (written.status !== "saved") return {status: "unavailable", message: written.status === "full" ? "The excluded chat list is full." : "Chat settings are unavailable.", snapshot: null};
    if (input.enabled) {
      this.store.recordChatEnable(input.mainThreadId, this.now());
    }
    this.applyChatStop(input.mainThreadId, input.enabled ? null : {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: this.now()});
    return {status: "saved", message: input.enabled ? "Supervision is enabled for this chat; its next request is supervised by the same Supervisor."
      : "Supervision is stopped for this chat. Its operative is notified to stop replying to the Supervisor, which settles when idle. The operative task continues.", snapshot: await this.snapshot(input.projectId, signal, input.mainThreadId)};
  }
  async retry(input: ProjectSupervisorRetryInput, signal: AbortSignal): Promise<ProjectSupervisorSaveOutcome> {
    if (!this.store.scopeCompatible) return {status: "unavailable", message: "Supervisor state version is unsupported; no changes were made.", snapshot: null};
    await this.control(input.projectId, signal);
    if (!this.scopeEnabled(input.projectId, input.mainThreadId, "reconcile")) return {status: "unavailable", message: "Enable global and project supervision before retrying native work.", snapshot: null};
    return this.serial(supervisorScopeKey(input.projectId, input.mainThreadId), async () => {
      const {project} = await this.project(input.projectId);
      const settings = this.store.settings(input.projectId);
      if (!this.scopeEnabled(input.projectId, input.mainThreadId, "reconcile")) return {status: "unavailable", message: "Enable global and project supervision before retrying native work.", snapshot: null};
      if (settings.generation !== input.expectedGeneration) return {status: "conflict", message: "Settings changed. Refresh before retrying native access.", snapshot: null};
      let binding = this.store.binding(input.projectId, input.mainThreadId);
      if (!binding || !this.operateRpc) return {status: "unavailable", message: "No Supervisor conversation is available to reconcile.", snapshot: null};
      if (binding.threadId !== input.threadId || binding.generation !== input.bindingGeneration ||
        (input.action === "replace") !== (binding.state === "missing")) return {status: "conflict", message: "The conversation state changed. Refresh and choose the intended recovery action again.", snapshot: null};
      const main = await this.lifecycle.readMain(binding, signal);
      if (!this.scopeEnabled(input.projectId, input.mainThreadId, "reconcile")) return {status: "unavailable", message: "Supervision was disabled before the retry began; retained work was left unchanged.", snapshot: null};
      if (!main || unavailable(main.thread)) return {status: "unavailable", message: "The main conversation is archived, deleted, or unavailable. Lifecycle handling will park its retained supervision state.", snapshot: null};
      if (binding.state !== "ready") {
        if (binding.state === "missing") {
          try {await this.projection(binding.threadId, signal);return {status: "unavailable", message: "The existing conversation is present; refresh before replacing it.", snapshot: null};}
          catch (cause) {if (!(cause instanceof T3TransportError) || cause.httpStatus !== 404) return {status: "unavailable", message: "T3 could not confirm that the conversation is missing.", snapshot: null};}
          if (!validModelSelection(settings.modelSelection, await this.models(signal))) return {status: "invalid", message: "Choose an available model before replacing a deleted conversation.", snapshot: null};
          if (!this.projectEnabled(input.projectId, input.mainThreadId)) return {status: "unavailable", message: "Supervision was disabled before replacement; retained work was left unchanged.", snapshot: null};
          const teamRecovery = await this.prepareMissingRootTeam(binding, signal);
          if (teamRecovery === "disabled") return {status: "unavailable", message: "Supervision was disabled before replacement; retained work was left unchanged.", snapshot: null};
          if (teamRecovery === "present_helper") return {status: "unavailable", message: "A registered helper is still present in T3. The missing root was not replaced; archive or delete the helper, or quarantine and retire it while the root is available, then retry. No helper was treated as missing.", snapshot: null};
          if (teamRecovery !== "ready") return {status: "unavailable", message: "T3 could not verify every registered helper or retire its verified webhook job. The missing root was not replaced; restore native access and retry.", snapshot: null};
          const teamSnapshot = this.team.snapshot(binding);
          if (teamSnapshot.assignments.some(assignment => assignment.state === "transferring") || this.team.unresolvedRequests(binding).length)
            return {status: "unavailable", message: "The Supervisor team still has unresolved handover state or native effects. Their original identities and history remain retained; reconcile them before replacing the root.", snapshot: null};
          const previousBinding = binding;
          binding = this.store.replaceMissingBinding(binding, settings.modelSelection);
          for (const job of this.store.tasksFor(previousBinding)) if (["queued", "dispatching", "waiting", "uncertain"].includes(job.status)) this.complete(job, "unavailable", null, "The bound Supervisor conversation was deleted; its request identity remains retained.");
        }
        if (binding.state === "rejected") {
          try {
            await this.projection(binding.threadId, signal);
          } catch (cause) {
            if (!(cause instanceof T3TransportError) || cause.httpStatus !== 404) return {status: "unavailable", message: "T3 could not confirm the rejected creation's state.", snapshot: null};
            if (!validModelSelection(settings.modelSelection, await this.models(signal))) return {status: "invalid", message: "Choose an available model before retrying rejected creation.", snapshot: null};
            if (!this.projectEnabled(input.projectId, input.mainThreadId)) return {status: "unavailable", message: "Supervision was disabled before replacement; retained work was left unchanged.", snapshot: null};
            binding = {...binding, generation: binding.generation + 1, initialModel: settings.modelSelection, state: "creating"};
          }
        }
        if (!this.projectEnabled(input.projectId, input.mainThreadId)) return {status: "unavailable", message: "Supervision was disabled before native creation; retained work was left unchanged.", snapshot: null};
        this.store.setBinding({...binding, creationAttempts: 0});
        await this.ensureBinding(input.projectId, input.mainThreadId, project.title, signal).catch(() => undefined);
      } else {
        if (!this.scopeEnabled(input.projectId, input.mainThreadId, "reconcile")) return {status: "unavailable", message: "Supervision was disabled before reconciliation; retained work was left unchanged.", snapshot: null};
        this.conversation.retry(input.projectId, binding.threadId);
        this.store.modelAttempt(binding, true);
        if (binding.settlement?.state === "uncertain") this.store.setBinding({...this.store.binding(binding.projectId, binding.mainThreadId)!, settlement: {...binding.settlement, state: "pending", attempts: 0}});
        const job = this.store.tasksFor(binding).find(task => ["uncertain", "dispatching", "waiting"].includes(task.status));
        if (job) this.store.saveTask({...job, replayCount: 0, updatedAt: Date.now()});
        await this.processProject(binding, signal).catch(() => undefined);
      }
      const snapshot = await this.snapshot(input.projectId, signal, input.mainThreadId);
      return {status: snapshot.binding?.state === "ready" && !snapshot.tasks.some(task => task.status === "uncertain") && snapshot.monitoringStatus?.state !== "uncertain" ? "saved" : "uncertain", message: "Native access retried with the retained identity. Inspect the current conversation and task status.", snapshot};
    });
  }
  private async ensureBinding(projectId: string, mainThreadId: string, title: string, signal: AbortSignal): Promise<BindingRecord> {
    if (!this.projectEnabled(projectId, mainThreadId)) throw new Error("supervision_disabled");
    if (!this.operateRpc) throw new Error("supervisor_credential_missing");
    const {catalog} = await this.project(projectId);
    const main = await this.projection(mainThreadId, signal);
    if (!this.projectEnabled(projectId, mainThreadId) || main.thread.projectId !== projectId || !(this.eligible(main.thread, catalog.threads) || this.validPendingStartFor(mainThreadId))) throw new Error("main_conversation_unavailable");
    const settings = this.store.settings(projectId);
    let binding = this.store.binding(projectId, mainThreadId) ?? this.store.reserve(projectId, mainThreadId, title, settings.modelSelection, this.store.activation()!, Date.now());
    let existing: Projection | null;
    try {existing = await this.projection(binding.threadId, signal);}
    catch (cause) {
      if (!(cause instanceof T3TransportError) || cause.httpStatus !== 404) throw new Error("supervisor_read_unavailable");
      existing = null;
    }
    if (existing) {
      if (existing.thread.projectId !== projectId || supervisorUnavailable(existing.thread)) throw new Error("invalid_supervisor_binding");
      const freshMain = await this.lifecycle.readMain(binding, signal);
      if (!this.projectEnabled(projectId, mainThreadId) || !freshMain || unavailable(freshMain.thread)) throw new Error("main_conversation_unavailable");
      const ready = {...binding, state: "ready" as const};this.store.setBinding(ready);return ready;
    } else {
      if (binding.state === "ready" || binding.state === "missing") {this.store.setBinding({...binding, state: "missing"});throw new Error("supervisor_missing");}
      // replay uses the exact durable reservation, never a new thread identity
      if (binding.state === "rejected" || (binding.creationAttempts ?? 0) >= 3) throw new Error("supervisor_creation_needs_retry");
      const freshMain = await this.lifecycle.readMain(binding, signal);
      if (!this.projectEnabled(projectId, mainThreadId) || !freshMain || unavailable(freshMain.thread)) throw new Error("main_conversation_unavailable");
      binding = {...binding, creationAttempts: (binding.creationAttempts ?? 0) + 1};this.store.setBinding(binding);
      try {
        await this.operateRpc("orchestration.launchThread", {commandId: `supervisor-create:${binding.threadId}:${binding.generation}`, threadId: binding.threadId,
          creationSource: "server", projectId, title: binding.title, generateTitle: false, modelSelection: binding.initialModel,
          runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: {type: "root"}}, signal);
        const projection = await this.projection(binding.threadId, signal);
        if (projection.thread.projectId !== projectId || supervisorUnavailable(projection.thread)) throw new Error("invalid_supervisor_binding");
        const ready = {...binding, state: "ready" as const};this.store.setBinding(ready);return ready;
      } catch (cause) {this.store.setBinding({...binding, state: cause instanceof SupervisorRpcError && cause.definiteRejection ? "rejected" : "uncertain",
        creationMessage: cause instanceof SupervisorRpcError && cause.providerDisabled ? "The Supervisor provider is disabled for this project in T3. Save another model or enable the provider, then retry native access." : "Conversation creation could not be confirmed. Retry native access to inspect its retained identity."});throw new Error("supervisor_creation_uncertain");}
    }
  }
  private observeModel(binding: BindingRecord, projection: Projection): void {
    const current = modelSelection(projection.thread.modelSelection);
    if (!current) throw new Error("supervisor_model_missing");
    const latest = this.store.binding(binding.projectId, binding.mainThreadId);
    if (!latest || latest.threadId !== binding.threadId) return;
    if (projection.thread.settledOverride === "active" && !this.supervisionStopped(binding.mainThreadId)) this.store.setBinding({...latest, manualKeepActive: true});
    this.store.observeModel(binding, current);
  }
  private mainShape(thread: ThreadInfo): boolean {
    return !isSupervisorThread(this.config, thread) && !unavailable(thread) && thread.lineage.relationshipToParent !== "subagent";
  }
  private eligible(thread: ThreadInfo, threads: readonly ThreadInfo[]): boolean {
    if (isSupervisorThread(this.config, thread) || unavailable(thread) || thread.lineage.relationshipToParent === "subagent" || currentThreadPolicy(this.config).excludedThreadIds.includes(thread.id) && !this.validPendingStartFor(thread.id)) return false;
    return mainConversation(thread, threads)?.id === thread.id;
  }
  async runOnce(signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<void> {
    if (!this.operateRpc || !this.store.scopeCompatible) return;
    const masterEnabled = this.store.control(null).enabled;
    if (masterEnabled && this.store.baseline() === null) this.store.baseline(await this.activationSnapshot(signal));
    if (masterEnabled) this.conversation.requests.pruneAgreementCandidates(this.store.prune(Date.now()));
    const catalog = await Effect.runPromise(this.source.catalog());
    this.rememberScratchProjects(catalog.projects.map(item => item.project));
    if (masterEnabled) await this.prepareStarts(signal);
    const threads = catalog.threads.filter(t => this.eligible(t, catalog.threads));
    if (masterEnabled) {
      const candidates = [...threads.slice(this.offset), ...threads.slice(0,this.offset)].slice(0,20);this.offset = threads.length ? (this.offset + 20) % threads.length : 0;
      const projectsToResolve = catalog.projects.filter(item => item.available && !this.store.isManual(item.project.id) && !this.store.autoControlInitialized(item.project.id));
      await Promise.allSettled(projectsToResolve.map(item => this.resolveControl(item.project.id, signal)));
      for (const thread of candidates) {
        if (signal.aborted) return;
        const project = catalog.projects.find(p => p.available && p.project.id === thread.projectId)?.project;if (!project || !this.projectEnabled(project.id, thread.id)) continue;
        if (this.store.start(thread.id)?.status === "pending") continue;
        const previous = this.store.task(thread.id);
        // an unresolved request or a temporary not-needed decision is reconsidered when the next genuine human request arrives; an
        // interpreted task is reconsidered only when the latest Enable or activation boundary came after it (checked below); queued
        // or in-flight work is never replaced
        if (previous && !["needs_context", "not_supervised", "unavailable", "expired", "inferred"].includes(previous.status)) continue;
        if (typeof thread.latestRunId === "string" && (thread.latestRunId === previous?.sourceRunId ||
          thread.latestRunId === this.store.baseline()?.threads.find(anchor => anchor.id === thread.id)?.latestRunId ||
          thread.latestRunId === this.examinedNonTasks.get(thread.id))) continue;
        try {
          const projection = await this.projection(thread.id, signal);
          if (!this.eligible(projection.thread, catalog.threads) || projection.thread.projectId !== project.id) continue;
          const baseline = this.sourceFloor(thread.id, projection);if (baseline === null) continue;
          // an explicit Enable or a new activation boundary supervises the chat's next request afresh, even after an agreed task
          const enabledSince = this.store.chatEnabledAt(thread.id);
          const prior = previous ? this.conversation.requests.introduction(previous.id) : null;
          // only an attempted introduction whose outcome is unknown holds the task; a never-attempted draft or a fallback whose
          // earlier attempts were definitely rejected is known unsent and does not strand the next request
          const priorUnresolved = Boolean(prior && introductionOutcomeUnknown(prior));
          if (previous?.status === "inferred" && (priorUnresolved || !(previous.sourceOrdinal <= baseline || enabledSince !== null && previous.dispatchedAt !== null && previous.dispatchedAt <= enabledSince))) {
            // an unresolved introduction is a mutable hold, so the chat is examined again until its delivery outcome is known
            if (!priorUnresolved) {
              if (this.examinedNonTasks.size >= 10_000) this.examinedNonTasks.clear();
              if (typeof thread.latestRunId === "string") this.examinedNonTasks.set(thread.id, thread.latestRunId);
            }
            continue;
          }
          // an explicit Enable supervises the chat's next request: a request written while supervision was stopped is not interpreted
          const task = taskSource(projection, Math.max(baseline, previous?.sourceOrdinal ?? 0), this.store.chatEnabledAt(thread.id));
          if (!task) {
            if (!active(projection) && typeof thread.latestRunId === "string") {
              if (this.examinedNonTasks.size >= 10_000) this.examinedNonTasks.clear();
              this.examinedNonTasks.set(thread.id, thread.latestRunId);
            }
            continue;
          }
          if (!validModelSelection(this.store.settings(project.id).modelSelection, await this.models(signal)) || !this.projectEnabled(project.id, thread.id)) continue;
          const freshMain = await this.projection(thread.id, signal);
          if (!this.projectEnabled(project.id, thread.id) || freshMain.thread.projectId !== project.id || !this.eligible(freshMain.thread, catalog.threads)) continue;
          const binding = await this.serial(supervisorScopeKey(project.id, thread.id), () => this.ensureBinding(project.id, thread.id, thread.title, signal));
          if (!this.projectEnabled(project.id, thread.id)) continue;
          // an earlier unresolved request carries forward only from the current supervision epoch: above the activation
          // boundary and written after the chat's latest Enable
          const enabledAt = this.store.chatEnabledAt(thread.id);
          const carried = previous?.status === "needs_context" ? [...(previous.contextMessageIds ?? []), previous.sourceMessageId].filter(messageId => {
            const message = projection.messages.find(item => item.id === messageId);
            const run = message?.runId ? projection.runs.find(item => item.id === message.runId) : undefined;
            return Boolean(message && run && run.ordinal > baseline && (enabledAt === null || (timestampMs(message.createdAt) ?? 0) > enabledAt));
          }).slice(-5) : [];
          const id = randomUUID();const oversized = task.message.text.length > 24_000;
          this.store.saveTask({id, threadId: thread.id, projectId: project.id, sourceRunId: task.run.id, sourceMessageId: task.message.id,
            sourceOrdinal: task.run.ordinal, sourceHash: fingerprint(task.message.text), status: oversized ? "needs_context" : "queued", objective: null,
            reason: oversized ? "The task message exceeds the interpretation limit; provide a shorter task." : "Waiting for the project Supervisor.",
            updatedAt: Date.now(), requestText: oversized ? "" : interpretationPrompt(thread.id, task.message.id, task.message.text), supervisorThreadId: binding.threadId,
            messageId: `supervisor-objective:${id}`, supervisorRunId: null, dispatchedAt: null, replayCount: 0,
            // only an unresolved request carries forward; an answered not-needed request is complete and never merges into the next task
            ...(carried.length ? {contextMessageIds: carried} : {})});
        } catch { /* Discovery failures are retried without producing model work. */ }
      }
    }
    const allBindings = this.store.bindings();
    const start = allBindings.length ? this.bindingOffset % allBindings.length : 0;
    const bindings = [...allBindings.slice(start), ...allBindings.slice(0, start)];
    this.bindingOffset = allBindings.length ? (start + 4) % allBindings.length : 0;
    for (let index = 0; index < bindings.length; index += 4) {
      if (signal.aborted) return;
      const batch = bindings.slice(index, index + 4);
      if (masterEnabled) await Promise.allSettled(batch.map(binding => this.resolveControl(binding.projectId, signal)));
      await Promise.allSettled(batch.map(async binding => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        if (this.store.scopeCompatible) await this.serial(supervisorScopeKey(binding.projectId, binding.mainThreadId), () => this.conversation.reconcileStopNotice(binding, deadline));
        // a human stop settles its owned Supervisor even while global or project supervision is disabled
        if (this.supervisionStopped(binding.mainThreadId) && !this.validPendingStartFor(binding.mainThreadId)) return this.serial(supervisorScopeKey(binding.projectId, binding.mainThreadId), async () => {
          // reconciliation sends nothing; it confirms accepted root, helper and guidance deliveries before the owned Supervisor may settle
          try {
            if (this.store.scopeCompatible) {
              await this.reconcileStoppedInterpretation(binding, deadline);
              await this.conversation.reconcileStopped(binding, catalog.threads, deadline);
              await this.conversation.teamRuntime?.reconcileStopped(binding, catalog.threads, deadline);
              await this.teamEffects?.reconcileStopped(binding, deadline);
            }
          } finally {if (!deadline.aborted) await this.lifecycle.check(binding, catalog.threads, deadline);}
        });
        if (this.isNoProject(binding.projectId) && !this.projectEnabled(binding.projectId, binding.mainThreadId)) return this.serial(supervisorScopeKey(binding.projectId, binding.mainThreadId), async () => {
          await this.reconcileStoppedInterpretation(binding, deadline);
          this.conversation.fenceStoppedSupervision(binding);
          await this.conversation.reconcileStopped(binding, catalog.threads, deadline);
          await this.conversation.teamRuntime?.reconcileStopped(binding, catalog.threads, deadline);
          await this.teamEffects?.reconcileStopped(binding, deadline);
          await this.lifecycle.parkInactive(binding, deadline, () => !this.projectEnabled(binding.projectId, binding.mainThreadId));
        });
        if (!masterEnabled || !this.projectEnabled(binding.projectId, binding.mainThreadId)) return this.checkClosedMainLifecycle(binding, catalog.threads, deadline);
        return this.serial(supervisorScopeKey(binding.projectId, binding.mainThreadId), async () => {
          try {await this.processProject(binding, deadline);}
          finally {if (!deadline.aborted && this.projectEnabled(binding.projectId, binding.mainThreadId)) await this.lifecycle.check(binding, catalog.threads, deadline);}
        });
      }));
    }
    if (masterEnabled) await this.conversation.observe(catalog.threads, signal);
  }

  private async checkClosedMainLifecycle(binding: BindingRecord, threads: readonly ThreadInfo[], signal: AbortSignal): Promise<void> {
    if (!this.operateRpc) return;
    const current = this.store.binding(binding.projectId, binding.mainThreadId);
    if (!current || current.threadId !== binding.threadId || current.state !== "ready") return;
    let main: Projection | null;
    try {main = await this.lifecycle.readMain(current, signal);}
    catch {return;}
    if (!main || unavailable(main.thread)) await this.lifecycle.check(current, threads, signal);
  }

  private async processProject(binding: BindingRecord, signal: AbortSignal): Promise<void> {
    const currentBinding = this.store.binding(binding.projectId, binding.mainThreadId);
    if (!currentBinding) return;
    binding = currentBinding;
    await this.teamEffects?.reconcile(binding, signal);
    if (!this.projectEnabled(binding.projectId, binding.mainThreadId)) return;
    const main = await this.lifecycle.readMain(binding, signal);
    if (!this.projectEnabled(binding.projectId, binding.mainThreadId) || !main || unavailable(main.thread)) return;
    await this.project(binding.projectId);
    if (!this.projectEnabled(binding.projectId, binding.mainThreadId)) return;
    let projection: Projection;
    try {projection = await this.projection(binding.threadId, signal);}
    catch (cause) {if (cause instanceof T3TransportError && cause.httpStatus === 404 && binding.state === "ready") this.store.setBinding({...binding, state: "missing"});throw cause;}
    if (projection.thread.projectId !== binding.projectId || supervisorUnavailable(projection.thread)) return;
    if (!this.projectEnabled(binding.projectId, binding.mainThreadId)) return;
    if (binding.state !== "ready") {binding = {...binding, state: "ready"};this.store.setBinding(binding);}
    this.observeModel(binding, projection);
    const jobs = this.store.tasksFor(binding);
    const inflight = jobs.find(t => ["dispatching","waiting","uncertain"].includes(t.status));
    if (inflight) {
      if (!this.projectEnabled(binding.projectId, binding.mainThreadId)) return;
      // an interpretation of a request at or before the activation boundary, or written or sent before the latest explicit Enable,
      // is never applied or resent: only its positively matched native run closes it once ended; an absent or active outcome keeps
      // the identity held unapplied
      const enabledAt = this.store.chatEnabledAt(inflight.threadId), floor = this.sourceFloor(inflight.threadId, main);
      const sourceAt = timestampMs(main.messages.find(m => m.id === inflight.sourceMessageId)?.createdAt) ?? 0;
      if (!this.pinnedStart(inflight) && (floor === null || inflight.sourceOrdinal <= floor ||
        enabledAt !== null && (sourceAt <= enabledAt || inflight.dispatchedAt !== null && inflight.dispatchedAt <= enabledAt))) {
        const message = projection.messages.find(m => m.id === inflight.messageId && m.threadId === inflight.supervisorThreadId && m.text === inflight.requestText);
        const run = message ? projection.runs.find(r => r.userMessageId === inflight.messageId && r.threadId === inflight.supervisorThreadId && r.id === message.runId) : undefined;
        if (run && ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status))
          this.complete({...inflight, supervisorRunId: run.id}, "expired", null, enabledAgainReason);
        return;
      }
      await this.reconcile(inflight, projection, signal);
      // a proposal is introduced in the same cycle its interpretation completes, through the ordinary conversation path and its fences
      const interpreted = this.store.task(inflight.threadId);
      if (interpreted?.id === inflight.id && interpreted.status === "inferred" && this.scopeEnabled(binding.projectId, binding.mainThreadId))
        await this.conversation.run(binding, projection, (await Effect.runPromise(this.source.catalog())).threads, signal);
      return;
    }
    if (!this.scopeEnabled(binding.projectId, binding.mainThreadId) && !jobs.some(job => job.status === "queued")) return;
    if (this.conversation.hasInflight(binding.projectId, binding.threadId)) {if (this.projectEnabled(binding.projectId, binding.mainThreadId)) await this.conversation.run(binding, projection, (await Effect.runPromise(this.source.catalog())).threads, signal);return;}
    if (active(projection)) {if (this.projectEnabled(binding.projectId, binding.mainThreadId)) await this.conversation.run(binding, projection, (await Effect.runPromise(this.source.catalog())).threads, signal);return;}
    let job = jobs.find(t => t.status === "queued");
    if (!job) {await this.conversation.run(binding, projection, (await Effect.runPromise(this.source.catalog())).threads, signal);return;}
    const source = await this.projection(job.threadId, signal);
    if (!this.projectEnabled(binding.projectId, binding.mainThreadId)) return;
    if (!this.currentSource(job, source)) {this.complete(job, "unavailable", null, "The task source changed or became unavailable.");return;}
    if (this.beforeBoundary(job, source)) {this.complete(job, "expired", null, enabledAgainReason);return;}
    if (job.definitionContext == null) {
      let definitions: ProjectDefinitionSnapshot;
      try {
        definitions = this.definitions ? await this.definitions.load(job.projectId, job.threadId, signal) : unavailableDefinitions(job);
        if (definitions.projectId !== job.projectId || definitions.threadId !== job.threadId) throw new Error("definition_binding_mismatch");
        if (definitions.status === "unavailable") {
          job = {...job, definitionReadAttempts: (job.definitionReadAttempts ?? 0) + 1};
          if (job.definitionReadAttempts! < 3) {this.store.saveTask({...job, reason: "Project definitions are temporarily unavailable; workflow preparation will retry with a bounded budget.", updatedAt: Date.now()});return;}
        }
      } catch {
        job = {...job, definitionReadAttempts: (job.definitionReadAttempts ?? 0) + 1};
        if (job.definitionReadAttempts! < 3) {this.store.saveTask({...job, reason: "Project definitions could not be read; workflow preparation will retry with a bounded budget.", updatedAt: Date.now()});return;}
        definitions = unavailableDefinitions(job);
      }
      const message = source.messages.find(item => item.id === job!.sourceMessageId)!;
      // the earlier unresolved requests stay context; only genuine visible user messages of this main are carried
      const earlierMessages = (job.contextMessageIds ?? []).flatMap(id => {
        const earlier = source.messages.find(item => item.id === id && item.threadId === job!.threadId && item.role === "user" && item.createdBy === "user" &&
          !item.streaming && (item.creationSource === "web" || item.creationSource === "mobile") && !item.senderThreadId && !item.scheduledTaskId && !item.source);
        const run = earlier?.runId ? source.runs.find(item => item.id === earlier.runId) : undefined;
        return earlier && run && nativeUserMessageVisible(source, run, earlier) ? [{messageId: earlier.id, text: earlier.text}] : [];
      });
      const reader = this.workflowEditingEnabled(job.projectId, job.threadId, "status");
      const prepared = prepareWorkflowRequest(job.threadId, job.sourceMessageId, message.text, definitions, {earlierMessages,
        ...(reader ? {reader: {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation}} : {})});
      // the root's first message carries its concise standing role once, so no separate initialization turn is needed
      const role = reader ? this.conversation.interpretationRole(binding) : null;
      const startCheck = this.store.start(job.threadId)?.status === "pending" ? `START AUTHORIZATION: In this SAME interpretation, first judge whether the original human message explicitly asks for Supervisor supervision of this chat. Include the additional top-level boolean startRequested in your JSON, independently of task relevance or plan validity. Always cite exactly the supplied messageId. A negative verdict grants no effects; return objective:null, workflow:null and an explanation. Never contact the operative.\n` : "";
      job = {...job, requestText: startCheck + (role ? `${role.text}\n${prepared.requestText}` : prepared.requestText), definitionContext: prepared.context, workflow: prepared.workflow,
        definitionSnapshot: prepared.context ? definitions : null, ...(role ? {roleVersion: role.roleVersion} : {})};
      this.store.saveTask(job);
      if (!this.currentSource(job, await this.projection(job.threadId, signal))) {this.complete(job, "unavailable", null, "The task source changed while project definitions were being loaded.");return;}
    }
    if (!this.projectEnabled(binding.projectId, binding.mainThreadId)) return;
    const current = modelSelection((await this.projection(binding.threadId, signal)).thread.modelSelection);
    if (!current || !validModelSelection(current, await this.models(signal)) || !this.projectEnabled(binding.projectId, binding.mainThreadId)) return;
    // rechecked after the final await: an Enable or re-enable saved meanwhile leaves this request uninterpreted
    if (this.beforeBoundary(job, source)) {this.complete(job, "expired", null, enabledAgainReason);return;}
    const sending: TaskRecord = {...job, status: "dispatching", dispatchedAt: Date.now(), updatedAt: Date.now()};this.store.saveTask(sending);
    await this.dispatch(sending, signal);
  }
  private async dispatch(job: TaskRecord, signal: AbortSignal): Promise<void> {
    // checked immediately before the native effect, after every awaited read: a stop or disable saved meanwhile sends nothing
    const stopped = this.supervisionStopped(job.threadId) && !this.validPendingStartFor(job.threadId);
    if (stopped || !this.projectEnabled(job.projectId, job.threadId)) {
      if (job.status === "dispatching") this.store.saveTask({...job, status: "queued", dispatchedAt: null,
        reason: stopped ? "Supervision was stopped for this chat before dispatch; this task identity remains unsent." : "Supervision was disabled before dispatch; this task identity remains queued.", updatedAt: Date.now()});
      return;
    }
    try {
      await this.operateRpc!("orchestration.dispatchCommand", {type: "message.dispatch", createdBy: "system", creationSource: "server", commandId: `supervisor-objective:${job.id}`,
        threadId: job.supervisorThreadId, messageId: job.messageId, text: job.requestText, attachments: [], dispatchMode: {type: "queue_after_active"}}, signal);
      this.store.saveTask({...job, status: "waiting", reason: "T3 accepted the interpretation request; waiting for its result.", updatedAt: Date.now()});
    } catch (cause) {
      if (cause instanceof SupervisorRpcError && cause.definiteRejection) this.complete(job, "unavailable", null, cause.providerDisabled ? "The Supervisor provider is disabled for this project in T3. Choose another model or enable the provider; other tasks can continue." : "T3 definitively rejected the interpretation request. Other tasks can continue.");
      else this.store.saveTask({...job, status: "uncertain", reason: "Interpretation dispatch is uncertain; retry native access to reconcile the original request identity.", updatedAt: Date.now()});
    }
  }
  /**
   * While a chat is stopped an accepted interpretation is only observed: once its native run has ended the task closes without
   * applying the result. Nothing is resent, and an identity with no native outcome stays unresolved.
   */
  private async reconcileStoppedInterpretation(binding: BindingRecord, signal: AbortSignal): Promise<void> {
    const jobs = this.store.tasksFor(binding).filter(job => ["dispatching", "waiting", "uncertain"].includes(job.status));
    if (!jobs.length) return;
    let projection: Projection;
    try {projection = await this.projection(binding.threadId, signal);} catch {return;}
    for (const job of jobs) {
      const message = projection.messages.find(m => m.id === job.messageId && m.threadId === job.supervisorThreadId && m.text === job.requestText);
      const run = message ? projection.runs.find(r => r.userMessageId === job.messageId && r.threadId === job.supervisorThreadId && r.id === message.runId) : undefined;
      if (run && ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status))
        this.complete({...job, supervisorRunId: run.id}, "unavailable", null, "Supervision was stopped for this chat; the interpretation result was not applied.");
    }
  }
  /** Whether the request is at or before the project/global activation boundary (unknown counts as before) or the chat's latest Enable. */
  private beforeBoundary(job: TaskRecord, source: Projection): boolean {
    if (this.pinnedStart(job)) return false;
    const floor = this.sourceFloor(job.threadId, source), enabledAt = this.store.chatEnabledAt(job.threadId);
    return floor === null || job.sourceOrdinal <= floor ||
      enabledAt !== null && !((timestampMs(source.messages.find(item => item.id === job.sourceMessageId)?.createdAt) ?? 0) > enabledAt);
  }
  private currentSource(job: TaskRecord, projection: Projection): boolean {
    const run = projection.runs.find(item => item.id === job.sourceRunId && item.ordinal === job.sourceOrdinal);
    const message = projection.messages.find(item => item.id === job.sourceMessageId && item.runId === job.sourceRunId);
    return projection.thread.id === job.threadId && projection.thread.projectId === job.projectId && !unavailable(projection.thread) &&
      !isSupervisorThread(this.config, projection.thread) && (!this.supervisionStopped(job.threadId) || this.validPendingStartFor(job.threadId)) &&
      Boolean(message && run && nativeUserMessageVisible(projection, run, message) && message.role === "user" && message.streaming === false && message.createdBy === "user" &&
        (message.creationSource === "web" || message.creationSource === "mobile") && !message.senderThreadId && !message.scheduledTaskId && !message.source &&
        fingerprint(message.text) === job.sourceHash) && this.store.binding(job.projectId, job.threadId)?.threadId === job.supervisorThreadId;
  }
  private complete(job: TaskRecord, status: TaskRecord["status"], objective: string | null, reason: string): void {
    const start = this.store.start(job.threadId);
    if (start?.status === "pending" && start.taskId === job.id && ["unavailable", "expired"].includes(status)) this.rejectStart(start, reason);
    const workflow = job.workflow?.status === "pending" ? {...job.workflow, status: "unavailable" as const, message: reason} : job.workflow;
    this.store.saveTask({...job, status, objective, reason, workflow: workflow ?? null, requestText: "", updatedAt: Date.now()});
  }
  private async reconcile(job: TaskRecord, projection: Projection, signal: AbortSignal): Promise<void> {
    const nativeIdentity = projection.messages.find(item => item.id === job.messageId && item.threadId === job.supervisorThreadId);
    if (nativeIdentity && nativeIdentity.text !== job.requestText) {
      const nativeRun = projection.runs.find(item => item.id === nativeIdentity.runId && item.userMessageId === job.messageId);
      if (nativeRun && ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(nativeRun.status))
        this.complete({...job, supervisorRunId: nativeRun.id}, "unavailable", null, "The retained interpretation identity belongs to different native content; its confirmed terminal result was not applied or resent.");
      return;
    }
    const message = projection.messages.find(m => m.id === job.messageId && m.threadId === job.supervisorThreadId && m.text === job.requestText);
    const run = message ? projection.runs.find(r => r.userMessageId === job.messageId && r.threadId === job.supervisorThreadId && r.id === message.runId) : undefined;
    if (!run) {
      if (!active(projection) && job.replayCount < 2) {const replay = {...job, replayCount: job.replayCount + 1};this.store.saveTask(replay);await this.dispatch(replay, signal);}
      if (job.replayCount >= 2 && job.status !== "uncertain") this.store.saveTask({...job, status: "uncertain", reason: "The accepted request has no matching native run. Retry native access to reconcile its retained identity.", updatedAt: Date.now()});
      return;
    }
    if (job.supervisorRunId !== run.id) {job = {...job, supervisorRunId: run.id};this.store.saveTask(job);}
    if (run.status === "completed" && job.roleVersion) this.conversation.roleDelivered(job.supervisorThreadId, job.roleVersion);
    if (run.status !== "completed") {
      if (["failed","interrupted","cancelled","rolled_back"].includes(run.status)) this.complete(job, "unavailable", null, "The interpretation run did not complete successfully.");
      else if (run.status !== "queued" && run.status !== "preparing" && timestampMs(run.startedAt) !== null && Date.now() - timestampMs(run.startedAt)! > 300_000) this.complete(job, "unavailable", null, "The interpretation timed out or requires input. The service does not answer or interrupt Supervisor runs.");
      return;
    }
    let source = await this.projection(job.threadId, signal);
    if (!this.currentSource(job, source)) {this.complete(job, "unavailable", null, "The task source changed before the interpretation completed.");return;}
    const nodeFor = mainRunNodeReader(projection, run);
    const answers = projection.messages.filter(m => m.threadId === job.supervisorThreadId && m.runId === run.id && m.role === "assistant" && !m.streaming && m.nodeId && nodeFor(m.nodeId)?.kind === "assistant_message")
      .sort((a,b) => (timestampMs(a.createdAt) ?? 0) - (timestampMs(b.createdAt) ?? 0));
    try {
      const pendingStart = this.store.start(job.threadId);
      let answer = answers.at(-1)?.text ?? "";
      let approveStart = false;
      if (pendingStart?.status === "pending" && pendingStart.taskId === job.id) {
        const clean = answer.trim().replace(/^```(?:json)?\s*\n/u, "").replace(/\n```$/u, "");
        const value = JSON.parse(clean) as Record<string, unknown>;
        if (typeof value.startRequested !== "boolean" || !Array.isArray(value.sourceMessageIds) || value.sourceMessageIds.length !== 1 || value.sourceMessageIds[0] !== job.sourceMessageId)
          throw new Error("invalid_start_verdict");
        if (!value.startRequested) {this.rejectStart(pendingStart, "The original human message did not request supervision.");this.complete(job, "not_supervised", null, "Start was not authorized by the user.");return;}
        approveStart = true;delete value.startRequested;answer = JSON.stringify(value);
      }
      const result: {objective: string | null; reason: string; workflow?: WorkflowProposalInfo; supervision?: "needed" | "not_needed"} = job.definitionContext ? parseWorkflowInterpretation(answer, job.sourceMessageId, job.definitionContext) : parseInterpretation(answer, job.sourceMessageId);
      if (result.workflow) {
        let currentDefinitions = false;
        let transientReadFailure = false;
        try {
          const definitions = await this.definitions?.load(job.projectId, job.threadId, signal);
          transientReadFailure = !definitions;
          currentDefinitions = Boolean(definitions && definitions.projectId === job.projectId && definitions.threadId === job.threadId &&
            sameDefinitionRead(job.definitionSnapshot, definitions));
        } catch {transientReadFailure = true;}
        if (transientReadFailure) {
          job = {...job, revalidationAttempts: (job.revalidationAttempts ?? 0) + 1};
          if (job.revalidationAttempts! < 3) {this.store.saveTask({...job, reason: "The model completed; project definition revalidation will retry with a bounded budget.", updatedAt: Date.now()});return;}
        }
        const staleWorkflow = currentDefinitions ? result.workflow : {...result.workflow, status: "stale" as const,
          message: "The definition source changed or could not be revalidated. This plan is retained as provisional history with its requirements and diagnostics."};
        job = {...job, workflow: staleWorkflow};
        source = await this.projection(job.threadId, signal);
        if (!this.currentSource(job, source)) {this.complete(job, "unavailable", null, "The task source changed while the workflow was being revalidated.");return;}
      }
      // rechecked after the final await: a result for a request before a boundary saved meanwhile closes unapplied
      if (this.beforeBoundary(job, source)) {this.complete({...job, supervisorRunId: run.id}, "expired", null, enabledAgainReason);return;}
      this.store.store.transaction(() => {
        if (approveStart && (!pendingStart || !this.validPendingStart(pendingStart) || !this.currentSource(job, source) || !this.activateStart(pendingStart))) {
          if (pendingStart) this.rejectStart(pendingStart, "Start was superseded or could not be committed.");
          this.complete(job, "expired", null, "Start was not activated.");return;
        }
        this.complete(job, result.objective === null ? "needs_context" : result.supervision === "not_needed" ? "not_supervised" : "inferred", result.objective, result.reason);
      });
    }
    catch {
      const start = this.store.start(job.threadId);
      if (start?.status === "pending" && start.taskId === job.id) this.rejectStart(start, "The Supervisor did not return a valid source-linked Start verdict.");
      this.complete(job, "unavailable", null, "The Supervisor did not return a valid, source-linked interpretation.");
    }
  }
}
