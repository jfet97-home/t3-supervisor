import { Cause, Clock, Context, Data, Deferred, Effect, Exit, FiberMap, HashMap, Layer, Option, Ref, Schema } from "effect";
import { resolve } from "node:path";
import { assessmentForTask, workflowAssessment } from "./workflow-assessment.js";
import { buildDashboardOverview, type DashboardOverviewInfo } from "./dashboard-overview.js";
import { readTeamViewData, supervisorTeamView } from "./supervisor-team-view.js";
import { mainConversation, resolveSupervisorScope, supervisorScopeKey } from "./supervisor-scope.js";
import { fingerprint } from "./guidance-store.js";
import { mainRunNodeReader, nativeUserMessageVisible, timestampMs } from "./domain.js";
import { currentThreadPolicy } from "./thread-policy.js";
import { isSupervisorThread, type BindingRecord, type TaskRecord, type SupervisorBaseline, type SupervisionFolderPresence, type SupervisionStartRecord } from "./project-supervisor-store.js";
import { modelSelection, NativeOperateRpc, NativeRpc, NativeShell, sameModel, supervisorModels, validModelSelection, SupervisorRpcError } from "./supervisor-native.js";
import type { ProjectSupervisorChatSupervisionInput, ProjectSupervisorInfo, ProjectSupervisorSaveInput, ProjectSupervisorSaveOutcome, ProjectSupervisorRetryInput, SupervisorModelSelection, WorkflowProposalInfo } from "./project-supervisor-contract.js";
import { interpretationPrompt, parseInterpretation, prepareWorkflowRequest, parseWorkflowInterpretation } from "./supervisor-workflow.js";
import { ProjectDefinitions, type DefinitionCheckoutTarget, type DefinitionCheckoutUnavailable, type DefinitionPresence, type DefinitionSourceFailure, type ProjectDefinitionGlobalSetupOutcome,
  type ProjectDefinitionSetupInput, type ProjectDefinitionSetupOutcome } from "./project-definitions.js";
export { interpretationPrompt, parseInterpretation } from "./supervisor-workflow.js";
import type { ProjectDefinitionSnapshot } from "./project-definitions-contract.js";
import { Store, type StoreError } from "./store.js";
import { T3Client, T3TransportError } from "./t3.js";
import type { MessageInfo, Projection, RunInfo, ThreadInfo } from "./types.js";
import { SupervisorConversation } from "./supervisor-conversation.js";
import { introductionOutcomeUnknown } from "./supervisor-conversation-store.js";
import type { NoProjectControlInput, GlobalDefinitionsControlInput, SupervisionControlInput, SupervisionSetupInput } from "./supervisor-control-contract.js";
import { admitSend, SupervisionGate, SupervisionScopeService, type GateGuard, type SendPreparation } from "./supervision-gate.js";
import { SupervisionStores } from "./supervision-stores.js";
import { genuineUserMessage, SupervisionControl } from "./supervision-control.js";
import { ScopeLocks } from "./scope-locks.js";
import { SupervisorIds } from "./ids.js";
import { SupervisorLifecycle } from "./supervisor-lifecycle.js";
import { HelperTransport } from "./supervisor-helper-transport.js";
import { SupervisorTeamRuntime } from "./supervisor-team-runtime.js";
import { SupervisorTeamController } from "./supervisor-team-controller.js";
import { monitorActivityReference, observeScopeThread, SUPERVISOR_SCOPE_SNAPSHOT_MAX_ACTIVITY_REFS, SUPERVISOR_SCOPE_SNAPSHOT_MAX_THREADS, type ProjectSupervisorScopeSnapshot } from "./supervisor-observation.js";

type SetupCheckoutTarget = DefinitionCheckoutTarget;
type DefinitionsFailure = DefinitionSourceFailure | DefinitionCheckoutUnavailable;

// the definition operations the supervisor uses; the composition root provides every one of them over ProjectDefinitions,
// a unit may omit the optional ones, as the baseline loader could
export interface SupervisorDefinitionsAccess {
  readonly load: (projectId: string, threadId: string | null) => Effect.Effect<ProjectDefinitionSnapshot, DefinitionsFailure>;
  readonly presence?: (projectId: string) => Effect.Effect<DefinitionPresence, DefinitionsFailure>;
  readonly presenceGlobal?: () => Effect.Effect<DefinitionPresence, DefinitionsFailure>;
  readonly globalDefinitionsPath?: () => string;
  readonly globalFingerprint?: () => Effect.Effect<string | null, DefinitionsFailure>;
  readonly initializeGlobal?: () => Effect.Effect<Omit<ProjectDefinitionGlobalSetupOutcome, "path">, DefinitionsFailure>;
  readonly checkoutTargets?: (projectId: string) => Effect.Effect<ReadonlyArray<SetupCheckoutTarget>, DefinitionsFailure>;
  readonly presenceForCheckout?: (projectId: string, threadId: string | null) => Effect.Effect<DefinitionPresence, DefinitionsFailure>;
  readonly initialize?: (projectId: string, threadId: string | null, input: ProjectDefinitionSetupInput) => Effect.Effect<Omit<ProjectDefinitionSetupOutcome, "path">, DefinitionsFailure>;
}

// every definition operation of the service
const definitionsAccess = (definitions: ProjectDefinitions["Service"]): SupervisorDefinitionsAccess => ({
  load: (projectId, threadId) => definitions.load(projectId, threadId),
  presence: (projectId) => definitions.presence(projectId),
  presenceGlobal: () => definitions.presenceGlobal(),
  globalDefinitionsPath: () => definitions.globalDefinitionsPath,
  globalFingerprint: () => definitions.globalFingerprint(),
  initializeGlobal: () => definitions.initializeGlobal(),
  checkoutTargets: (projectId) => definitions.checkoutTargets(projectId),
  presenceForCheckout: (projectId, threadId) => definitions.presenceForCheckout(projectId, threadId),
  initialize: (projectId, threadId, input) => definitions.initialize(projectId, threadId, input),
});

export type ProjectSupervisorWorkflowLocator = {supervisorThreadId: string; bindingGeneration: number};
export type ProjectSupervisorScopeSnapshotOptions = {
  threadIds?: readonly string[];
  lineageOffset?: number;
  limit?: number;
};

// the registered project is not available in the catalog
export class ProjectUnavailable extends Data.TaggedError("ProjectUnavailable") {override readonly message = "project_unavailable";}
// the selected main is not an eligible (or stopped but inspectable) main conversation of the project
export class InvalidMainConversation extends Data.TaggedError("InvalidMainConversation") {override readonly message = "invalid_main_conversation";}
// the bound Supervisor conversation belongs to another project
export class SupervisorUnavailable extends Data.TaggedError("SupervisorUnavailable") {override readonly message = "supervisor_unavailable";}
export class SupervisionDisabled extends Data.TaggedError("SupervisionDisabled") {override readonly message = "supervision_disabled";}
export class SupervisorCredentialMissing extends Data.TaggedError("SupervisorCredentialMissing") {override readonly message = "supervisor_credential_missing";}
export class MainConversationUnavailable extends Data.TaggedError("MainConversationUnavailable") {override readonly message = "main_conversation_unavailable";}
export class SupervisorReadUnavailable extends Data.TaggedError("SupervisorReadUnavailable") {override readonly message = "supervisor_read_unavailable";}
export class InvalidSupervisorBinding extends Data.TaggedError("InvalidSupervisorBinding") {override readonly message = "invalid_supervisor_binding";}
export class SupervisorMissing extends Data.TaggedError("SupervisorMissing") {override readonly message = "supervisor_missing";}
export class SupervisorCreationNeedsRetry extends Data.TaggedError("SupervisorCreationNeedsRetry") {override readonly message = "supervisor_creation_needs_retry";}
export class SupervisorCreationUncertain extends Data.TaggedError("SupervisorCreationUncertain") {override readonly message = "supervisor_creation_uncertain";}
export class SupervisorModelMissing extends Data.TaggedError("SupervisorModelMissing") {override readonly message = "supervisor_model_missing";}
// the model's Start verdict is not exactly a boolean citing the one source message
class InvalidStartVerdict extends Data.TaggedError("InvalidStartVerdict") {override readonly message = "invalid_start_verdict";}
// a shared folder or boundary check that ended without a result for its joined callers
export class SharedCheckEnded extends Data.TaggedError("SharedCheckEnded") {}

export type EnsureBindingError = SupervisionDisabled | SupervisorCredentialMissing | MainConversationUnavailable | SupervisorReadUnavailable | InvalidSupervisorBinding |
  SupervisorMissing | SupervisorCreationNeedsRetry | SupervisorCreationUncertain | ProjectUnavailable | StoreError | T3TransportError | Effect.Error<SupervisorLifecycle["Service"]["readMain"]>;

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

// the model's Start verdict beside its interpretation: the boolean and exactly the cited source message
const startVerdict = (sourceMessageId: string) => Schema.Struct({startRequested: Schema.Boolean, sourceMessageIds: Schema.Tuple([Schema.Literal(sourceMessageId)])});
const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

// a caught failure or defect of an awaited step, as the baseline catch saw it; an interruption is never caught
type Attempt<A> = {readonly ok: true; readonly value: A} | {readonly ok: false; readonly cause: unknown};
const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Attempt<A>, never, R> =>
  Effect.catchCauseIf(Effect.map(effect, (value): Attempt<A> => ({ok: true, value})), (cause) => !Cause.hasInterruptsOnly(cause),
    (cause) => Effect.succeed<Attempt<A>>({ok: false, cause: Cause.squash(cause)})) as Effect.Effect<Attempt<A>, never, R>;
const notFound = (cause: unknown): boolean => cause instanceof T3TransportError && cause.httpStatus === 404;

type ControlInfo = ReturnType<SupervisionStores["Service"]["supervisors"]["control"]>;
// the stored control with its effective state from the scope predicates
const effectiveControl = (stores: SupervisionStores["Service"], scope: SupervisionScopeService["Service"], projectId: string): ControlInfo => {
  const control = stores.supervisors.control(projectId);
  const effectiveEnabled = scope.projectEnabled(projectId);
  return control.effectiveEnabled === effectiveEnabled ? control : {...control, effectiveEnabled};
};

type CatalogValue = Effect.Success<ReturnType<Store["Service"]["catalog"]>>;

/** The dashboard overview from retained bindings, tasks and controls; it makes no native call and writes nothing. */
export const readDashboardOverview = (input: {readonly page: {offset: number; limit: number}; readonly catalog: CatalogValue; readonly available: boolean; readonly observedAt: number}):
  Effect.Effect<DashboardOverviewInfo, never, SupervisionStores | SupervisionScopeService | SupervisorConversation> => Effect.gen(function* () {
  const stores = yield* SupervisionStores;
  const scope = yield* SupervisionScopeService;
  const conversation = yield* SupervisorConversation;
  const {supervisors: store, workflows} = stores;
  return yield* Effect.sync(() => buildDashboardOverview({...input.page, fingerprint, observedAt: input.observedAt,
    available: input.available, globallyEnabled: store.control(null).enabled,
    projects: input.catalog.projects, threads: input.catalog.threads, bindings: store.scopeCompatible ? store.bindings() : [],
    tasks: projectId => store.tasks(projectId),
    control: projectId => effectiveControl(stores, scope, projectId),
    scopeEnabled: (projectId, mainThreadId) => scope.scopeEnabled(projectId, mainThreadId),
    monitoring: binding => conversation.status(binding.projectId, binding.threadId),
    assessment: (binding, task) => {
      const result = workflows?.getState(binding.projectId, binding.mainThreadId);
      return result?.status === "found" ? assessmentForTask(workflowAssessment(result.document), task) : null;
    },
    excluded: new Set(currentThreadPolicy(scope.config).excludedThreadIds)}));
});

type ScopeSnapshotIssue = ProjectSupervisorScopeSnapshot["issues"][number];
type SaveOutcome<S extends string, C> = {status: S; message: string; control: C};

export interface ProjectSupervisorShape {
  // one supervision pass (today's runOnce): activation boundary, Starts, discovery, the binding batches and observation; the root
  // loop bounds it (120 s) and spaces the passes (5 s)
  readonly cycle: Effect.Effect<void, StoreError | SupervisorRpcError>;
  // synchronous b-02 reads
  readonly noProjectControl: () => {generation: number; mode: "off" | "on_request" | "automatic"; globallyEnabled: boolean};
  readonly workflowLocator: (projectId: string, mainThreadId: string) => ProjectSupervisorWorkflowLocator | null;
  // reads
  readonly scopeSnapshot: (projectId: string, mainThreadId: string, options?: ProjectSupervisorScopeSnapshotOptions) => Effect.Effect<ProjectSupervisorScopeSnapshot>;
  readonly control: (projectId: string | null) => Effect.Effect<ControlInfo, StoreError | ProjectUnavailable>;
  readonly globalDefinitionsControl: Effect.Effect<ReturnType<SupervisionStores["Service"]["supervisors"]["globalDefinitionsControl"]>>;
  readonly setupOptions: (projectId: string) => Effect.Effect<SetupOptions, StoreError | ProjectUnavailable>;
  readonly candidates: (query?: string, purpose?: "start" | "exclude") => Effect.Effect<Candidates, StoreError>;
  readonly overview: (page: {offset: number; limit: number}) => Effect.Effect<DashboardOverviewInfo, StoreError>;
  readonly snapshot: (projectId: string, mainThreadId?: string | null) => Effect.Effect<ProjectSupervisorInfo, StoreError | ProjectUnavailable | InvalidMainConversation>;
  // writes, each committing in an admission section after its last read
  readonly saveNoProjectControl: (input: NoProjectControlInput) => Effect.Effect<SaveOutcome<"saved" | "conflict" | "unavailable", ReturnType<ProjectSupervisorShape["noProjectControl"]>>>;
  readonly saveGlobalDefinitionsControl: (input: GlobalDefinitionsControlInput) => Effect.Effect<SaveOutcome<"saved" | "conflict" | "unavailable" | "uncertain",
    ReturnType<SupervisionStores["Service"]["supervisors"]["globalDefinitionsControl"]>>>;
  readonly setup: (input: SupervisionSetupInput) => Effect.Effect<SetupResult, StoreError | ProjectUnavailable | T3TransportError>;
  // a folder check its caller joined and that ended without a result fails the save (SharedCheckEnded)
  readonly saveControl: (input: SupervisionControlInput) => Effect.Effect<SaveOutcome<"saved" | "conflict" | "unavailable" | "setup_required", ControlInfo>, StoreError | ProjectUnavailable | SharedCheckEnded>;
  readonly save: (input: ProjectSupervisorSaveInput) => Effect.Effect<ProjectSupervisorSaveOutcome, StoreError | ProjectUnavailable | InvalidMainConversation | SupervisorRpcError>;
  readonly setChatSupervision: (input: ProjectSupervisorChatSupervisionInput) => Effect.Effect<ProjectSupervisorSaveOutcome, StoreError | ProjectUnavailable | InvalidMainConversation>;
  readonly retry: (input: ProjectSupervisorRetryInput) => Effect.Effect<ProjectSupervisorSaveOutcome, RetryError>;
}

type SetupOptions = {projectId: string; generation: number; available: boolean; message: string;
  checkouts: Array<SetupCheckoutTarget & {folderStatus: "present" | "missing" | "unavailable"}>};
type SetupResult = {status: "saved" | "conflict" | "unavailable" | "uncertain";
  message: string; control: ControlInfo; workspaceRoot: string | null; branch: string | null};
type Candidates = {exceptions: string[]; candidates: Array<{id: string; projectId: string; title: string; updatedAt: string | null; active: boolean; excluded: boolean}>; message: string};
type RetryError = StoreError | ProjectUnavailable | InvalidMainConversation | SupervisorRpcError | T3TransportError | Effect.Error<SupervisorLifecycle["Service"]["readMain"]>;

// the internal steps a unit seam drives on its own: the binding creation and one interpretation dispatch with its final checks
export interface ProjectSupervisorSeams {
  readonly ensureBinding: (projectId: string, mainThreadId: string, title: string) => Effect.Effect<BindingRecord, EnsureBindingError>;
  readonly dispatch: (job: TaskRecord) => Effect.Effect<void>;
}

export type ProjectSupervisorOptions = {
  // the definition operations; without them the definitions service of the context, else none
  readonly definitions?: SupervisorDefinitionsAccess | undefined;
};

/** Coordinates ordinary T3 conversations; provider execution remains entirely in T3. */
const makeProjectSupervisor = (options: ProjectSupervisorOptions = {}) => Effect.gen(function* () {
  const stores = yield* SupervisionStores;
  const scope = yield* SupervisionScopeService;
  const gate = yield* SupervisionGate;
  const locks = yield* ScopeLocks;
  const source = yield* Store;
  const t3 = yield* T3Client;
  const readRpc = yield* NativeRpc;
  const shell = yield* NativeShell;
  const ids = yield* SupervisorIds;
  const conversation = yield* SupervisorConversation;
  const lifecycle = yield* SupervisorLifecycle;
  const control = yield* SupervisionControl;
  const transport = yield* HelperTransport;
  // the synchronous blocks stamp their time from the clock the service was built with
  const clock = yield* Clock.Clock;
  // the operate credential, the team runtime and the team controller are absent where a scope has none of them
  const operate = Option.getOrNull(yield* Effect.serviceOption(NativeOperateRpc));
  const teamRuntime = Option.getOrNull(yield* Effect.serviceOption(SupervisorTeamRuntime));
  const teamEffects = Option.getOrNull(yield* Effect.serviceOption(SupervisorTeamController));
  const definitions = options.definitions ?? Option.getOrNull(Option.map(yield* Effect.serviceOption(ProjectDefinitions), definitionsAccess));
  const {supervisors: store, requests, monitor, team} = stores;
  const config = scope.config;
  const now = () => clock.currentTimeMillisUnsafe();
  // in-memory cursors, classification memory, presence timestamps and the single-flight folder and boundary checks of this process
  const examinedNonTasks = yield* Ref.make(HashMap.empty<string, string>());
  const folderPresenceCheckedAt = yield* Ref.make(HashMap.empty<string, number>());
  const folderPresenceInFlight = yield* Ref.make(HashMap.empty<string, Deferred.Deferred<SupervisionFolderPresence, SharedCheckEnded>>());
  const activationBoundaryInFlight = yield* Ref.make<Deferred.Deferred<SupervisorBaseline, SharedCheckEnded> | null>(null);
  const offset = yield* Ref.make(0);
  const bindingOffset = yield* Ref.make(0);
  // the in-flight native sends of this service (plan 3.11): closing its scope interrupts each one and keeps its receipt
  const dispatches = yield* FiberMap.make<string, void>();
  const launches = yield* FiberMap.make<string, LaunchOutcome>();

  const projection = (threadId: string): Effect.Effect<Projection, T3TransportError> => Effect.map(t3.projection(threadId), (snapshot) => snapshot.projection);
  // the models T3 advertises now, read on each use
  const models = Effect.suspend(() => Effect.map(readRpc.call("server.getConfig", {}), supervisorModels));
  const projectEnabled = (projectId: string, mainThreadId?: string): boolean => scope.projectEnabled(projectId, mainThreadId);
  const project = (projectId: string) => Effect.gen(function* () {
    const catalog = yield* source.catalog();
    scope.rememberScratchProjects(catalog.projects.map(item => item.project));
    const found = catalog.projects.find(p => p.project.id === projectId && p.available)?.project;
    if (!found) return yield* new ProjectUnavailable();
    return {project: found, catalog};
  });
  const noProjectControl = () => {const {generation, mode, globallyEnabled} = store.noProjectControl();return {generation, mode, globallyEnabled};};
  const saveNoProjectControl = (input: NoProjectControlInput) => Effect.gen(function* () {
    const current = noProjectControl();
    if (current.generation !== input.expectedGeneration) return {status: "conflict" as const, message: "No Project mode changed. Reload before saving.", control: current};
    const unconfirmed = () => ({status: "unavailable" as const, message: "Mode was not confirmed. Reload before saving again.", control: noProjectControl()});
    const boundary = yield* attempt(shell.baseline);
    if (!boundary.ok) return unconfirmed();
    // after the boundary read, the mode save runs as one admission section
    return yield* gate.admit(() => Effect.sync(() => {
      try {
        store.saveNoProjectControl(input.expectedGeneration, input.mode, boundary.value);
        return {status: "saved" as const, message: "No Project mode saved. Existing permissions and history are retained; discovery resumes from this boundary.", control: noProjectControl()};
      } catch {return unconfirmed();}
    }));
  });
  const sourceFloor = (threadId: string, main: Projection): number | null => {
    const base = store.baselineOrdinal(threadId, main);
    if (base === null || !scope.isNoProject(main.thread.projectId ?? "")) return base;
    const anchor = store.noProjectControl().baseline?.threads.find(item => item.id === threadId)?.latestRunId;
    if (!anchor) return base;
    const ordinal = main.runs.find(item => item.id === anchor)?.ordinal;
    return ordinal === undefined ? null : Math.max(base, ordinal);
  };
  const pinnedStart = (job: TaskRecord): SupervisionStartRecord | null => {
    const start = store.start(job.threadId);
    return start && (start.status === "active" && !scope.supervisionStopped(job.threadId) && store.chatEnabledAt(job.threadId) === start.intentAt && start.modeGeneration === store.noProjectControl().generation && start.masterGeneration === store.control(null).generation || scope.validPendingStart(start)) && start.taskId === job.id &&
      start.source?.messageId === job.sourceMessageId && start.source.runId === job.sourceRunId && start.source.hash === job.sourceHash ? start : null;
  };
  const workflowLocator = (projectId: string, mainThreadId: string): ProjectSupervisorWorkflowLocator | null => {
    const binding = store.binding(projectId, mainThreadId);
    return binding?.state === "ready" ? {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation} : null;
  };
  const controlOf = (projectId: string) => effectiveControl(stores, scope, projectId);
  const finishMissingHelperRequests = (binding: BindingRecord, memberThreadId: string, reason: string): void => {
    const ownedRequests = requests.requests(binding.projectId, memberThreadId).filter(request => request.kind === "review" &&
      (request.id.startsWith("team-review:") || request.id.startsWith("team-ready:")) &&
      (["prepared", "sending", "waiting", "uncertain"].includes(request.state) || request.state === "failed" && !request.failureAcknowledged));
    for (const request of ownedRequests) {
      const failed = request.state === "failed" ? {...request, error: request.error ?? reason} : {...request, state: "failed" as const, error: reason};
      if (request.state !== "failed" || !request.error) requests.saveRequest(failed);
      const targetThreadId = request.batch?.threads[0]?.threadId;
      try {
        team.serviceAttention(binding, {
          eventId: `helper-checkin-failed:${fingerprint([binding.threadId, binding.generation, memberThreadId, request.id]).slice(0, 32)}`,
          memberThreadId,
          ...(targetThreadId ? {targetThreadId} : {}),
          summary: `Helper check-in failed: ${request.error ?? reason}`,
        });
      } catch { /* request closure remains durable if the event could not be recorded */ }
    }
    for (const request of team.unresolvedRequests(binding).filter(value => value.memberThreadId === memberThreadId &&
      (value.requestId.startsWith("team-review:") || value.requestId.startsWith("team-ready:"))))
      team.settleRequest(binding, request.requestId);
  };
  const prepareMissingRootTeam = (binding: BindingRecord): Effect.Effect<"ready" | "present_helper" | "unavailable" | "disabled"> => Effect.gen(function* () {
    let presentHelper = false;
    const members = team.snapshot(binding).members.filter(member => member.state === "ready" || member.state === "registering" || member.state === "missing");
    for (const member of members) {
      if (!projectEnabled(binding.projectId, binding.mainThreadId)) return "disabled";
      const read = yield* attempt(projection(member.threadId));
      if (!read.ok) {
        if (!notFound(read.cause)) return "unavailable";
        if (!(yield* transport.retire(binding, member.threadId))) return "unavailable";
        try {
          if (member.state !== "missing") team.markMissing(binding, member.threadId);
          finishMissingHelperRequests(binding, member.threadId, "The helper conversation is confirmed missing; its check-in was closed and pending operational effects remain fenced.");
        }
        catch {return "unavailable";}
        continue;
      }
      const helper = read.value;
      if (helper.thread.id !== member.threadId || helper.thread.lineage.parentThreadId !== binding.threadId ||
        helper.thread.lineage.relationshipToParent !== "subagent") return "unavailable";
      if (!unavailable(helper.thread)) {presentHelper = true;continue;}
      if (!(yield* transport.retire(binding, member.threadId))) return "unavailable";
      try {
        if (member.state !== "missing") team.markMissing(binding, member.threadId);
        finishMissingHelperRequests(binding, member.threadId, "The helper conversation is archived or deleted; its check-in was closed and pending operational effects remain fenced.");
      }
      catch {return "unavailable";}
    }
    return presentHelper ? "present_helper" : "ready";
  });
  const scopeSnapshot = (projectId: string, mainThreadId: string, options?: ProjectSupervisorScopeSnapshotOptions) => Effect.gen(function* () {
    const observedAt = now();
    const binding = store.binding(projectId, mainThreadId);
    const issues: Array<ScopeSnapshotIssue> = [];
    let complete = true;
    let catalog: {threads: ThreadInfo[]} | null = null;
    const listed = yield* attempt(source.catalog());
    if (listed.ok) catalog = listed.value;
    else {
      complete = false;
      issues.push({code: "catalog_unavailable", message: "The current T3 thread catalog could not be read."});
    }
    const resolved = catalog ? resolveSupervisorScope(catalog.threads, projectId, mainThreadId, store.ownedIds) : null;
    if (resolved) {
      complete = complete && resolved.complete;
      issues.push(...resolved.issues.slice(0, 20));
    }
    if (binding) {
      const read = yield* attempt(projection(binding.threadId));
      if (!read.ok || read.value.thread.id !== binding.threadId || read.value.thread.projectId !== projectId) {
        complete = false;
        issues.push({code: "supervisor_unavailable", message: "The owning Supervisor conversation could not be observed."});
      }
    }
    const allRows: ThreadInfo[] = resolved?.main && resolved.allowedIds.has(resolved.main.id)
      ? [resolved.main, ...resolved.descendants.filter(thread => resolved.allowedIds.has(thread.id))]
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
          const thread = resolved?.byId.get(id);
          if (!thread || !resolved?.allowedIds.has(id)) {
            complete = false;
            issues.push({code: "scope_thread_unverified", message: "A requested thread is outside the verified main scope."});
          } else rows.push(thread);
        }
      }
    } else if (hasPageSelection) {
      const pageOffset = options?.lineageOffset ?? 0;
      const limit = options?.limit ?? 20;
      if (!Number.isSafeInteger(pageOffset) || pageOffset < 0 || pageOffset > 10_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        complete = false;
        issues.push({code: "scope_snapshot_options_invalid", message: "The requested lineage offset or page size is invalid."});
        rows = [];
      } else {
        lineageOffset = pageOffset;
        rows = allRows.slice(pageOffset, pageOffset + limit);
        lineageHasMore = pageOffset + rows.length < lineageTotal;
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
    const readProjection = (threadId: string): Effect.Effect<Projection | null> => Effect.gen(function* () {
      const existing = projections.get(threadId);
      if (existing) return existing;
      if (!resolved || projectionReads >= SUPERVISOR_SCOPE_SNAPSHOT_MAX_THREADS) return null;
      projectionReads++;
      const read = yield* attempt(projection(threadId));
      if (!read.ok || read.value.thread.id !== threadId) return null;
      projections.set(threadId, read.value);
      return read.value;
    });
    for (const thread of rows.slice(0, SUPERVISOR_SCOPE_SNAPSHOT_MAX_THREADS)) {
      const depth = resolved?.depthById.get(thread.id) ?? 0;
      const isMain = thread.id === mainThreadId;
      let observed = isMain || !thread.archivedAt && !thread.deletedAt ? yield* readProjection(thread.id) : null;
      let lineageVerified = true;
      if (isMain && observed && observed.thread.projectId !== projectId) {
        complete = false;
        issues.push({code: "main_projection_mismatch", message: "The main projection no longer matches the requested project."});
        observed = null;
      }
      if (!isMain && observed && (observed.thread.lineage.relationshipToParent !== "subagent" ||
        observed.thread.lineage.parentThreadId !== thread.lineage.parentThreadId)) {
        complete = false;
        issues.push({code: "projection_lineage_changed", message: "A descendant projection no longer matches its verified catalog lineage."});
        lineageVerified = false;
        observed = null;
      } else if (!isMain && !observed && !thread.archivedAt && !thread.deletedAt) {
        complete = false;
        issues.push({code: "descendant_projection_unavailable", message: "A live descendant projection could not be read."});
      }
      const parentId = typeof thread.lineage.parentThreadId === "string" ? thread.lineage.parentThreadId : null;
      let parentProjection = parentId ? yield* readProjection(parentId) : null;
      if (!isMain && parentId && !parentProjection) {
        complete = false;
        lineageVerified = false;
        issues.push({code: "parent_projection_unavailable", message: "A descendant's direct parent projection could not be read."});
      }
      const parentInfo = parentId ? resolved?.byId.get(parentId) : null;
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
      const activityRefs = lineageVerified ? monitor.state(projectId, thread.id).activities
        .slice(-SUPERVISOR_SCOPE_SNAPSHOT_MAX_ACTIVITY_REFS)
        .map(item => monitorActivityReference(thread.id, observed, item)) : [];
      observedRows.push(observeScopeThread({thread, mainThreadId, depth, projection: observed, parentProjection, lineageVerified, activityRefs}));
    }
    if (issues.length > 100) issues.splice(100);
    if (!resolved) complete = false;
    return {projectId, mainThreadId, supervisorThreadId: binding?.threadId ?? null, bindingGeneration: binding?.generation ?? null,
      observedAt, lineageTotal, lineageOffset, lineageHasMore,
      complete: complete && Boolean(resolved?.complete), issues, threads: observedRows} satisfies ProjectSupervisorScopeSnapshot;
  });
  // the shared activation boundary read of concurrent folder checks: its first caller runs it under the 30 s deadline, and when
  // that caller ends without a result its joined callers see a failed read
  const activationBoundary = Effect.gen(function* () {
    const fresh = yield* Deferred.make<SupervisorBaseline, SharedCheckEnded>();
    const existing = yield* Ref.modify(activationBoundaryInFlight, (current) => current ? [current, current] as const : [null, fresh] as const);
    if (existing) return yield* Deferred.await(existing);
    return yield* shell.baseline.pipe(Effect.timeout("30 seconds"), Effect.onExit((exit) => Effect.andThen(
      Ref.update(activationBoundaryInFlight, (current) => current === fresh ? null : current),
      Exit.isSuccess(exit) ? Deferred.succeed(fresh, exit.value) : Deferred.fail(fresh, new SharedCheckEnded()))));
  });
  // the folder check itself: presence under its 10 s deadline, the activation boundary of a newly present folder, and the record
  const checkFolder = (projectId: string): Effect.Effect<SupervisionFolderPresence> => Effect.gen(function* () {
    if (!definitions?.presence) return {status: "unavailable", message: "Project .t3-supervisor folder detection is not configured."};
    const read = yield* attempt(definitions.presence(projectId).pipe(Effect.timeout("10 seconds")));
    let presence: SupervisionFolderPresence = read.ok && read.value && ["present", "missing", "unavailable"].includes(read.value.status) ? read.value
      : {status: "unavailable", message: "The project .t3-supervisor folder could not be checked."};
    let baseline: SupervisorBaseline | undefined;
    if (presence.status === "present" && !store.isManual(projectId) && !store.autoControlInitialized(projectId) &&
      (store.folderPresenceNeedsBoundary(projectId) || !store.baseline() && !store.projectBoundary(projectId))) {
      const boundary = yield* attempt(activationBoundary);
      if (boundary.ok) baseline = boundary.value;
      else presence = {status: "unavailable", message: "The project folder is present, but a native enable boundary could not be captured. Retry the folder check before enabling supervision."};
    }
    store.recordFolderPresence(projectId, presence, baseline);
    return presence;
  });
  // one folder check per project at a time: a concurrent caller joins the first caller's check, and when that caller ends without
  // a result its joined callers see a failed check
  const detectFolder = (projectId: string) => Effect.gen(function* () {
    const fresh = yield* Deferred.make<SupervisionFolderPresence, SharedCheckEnded>();
    const existing = yield* Ref.modify(folderPresenceInFlight, (map) => Option.match(HashMap.get(map, projectId), {
      onSome: (current) => [current, map] as const,
      onNone: () => [null, HashMap.set(map, projectId, fresh)] as const,
    }));
    if (existing) return yield* Deferred.await(existing);
    const presence = yield* checkFolder(projectId).pipe(Effect.onExit((exit) => Effect.andThen(
      Ref.update(folderPresenceInFlight, (map) => Option.getOrNull(HashMap.get(map, projectId)) === fresh ? HashMap.remove(map, projectId) : map),
      Exit.isSuccess(exit) ? Deferred.succeed(fresh, exit.value) : Deferred.fail(fresh, new SharedCheckEnded()))));
    const checkedAt = now();
    yield* Ref.update(folderPresenceCheckedAt, (map) => HashMap.set(map, projectId, checkedAt));
    return presence;
  });
  const resolveControl = (projectId: string) => Effect.gen(function* () {
    if (store.isManual(projectId) || store.autoControlInitialized(projectId)) return store.control(projectId);
    const checkedAt = Option.getOrElse(HashMap.get(yield* Ref.get(folderPresenceCheckedAt), projectId), () => 0);
    const retryDelay = store.control(projectId).detectionStatus === "unavailable" ? 60_000 : 30_000;
    if (now() - checkedAt < retryDelay) return store.control(projectId);
    const detected = yield* attempt(detectFolder(projectId));
    if (!detected.ok) store.setFolderPresence(projectId, {status: "unavailable", message: "The project .t3-supervisor folder could not be checked."});
    return store.control(projectId);
  });
  const controlFor = (projectId: string | null): Effect.Effect<ControlInfo, StoreError | ProjectUnavailable> => Effect.gen(function* () {
    if (projectId === null) return store.control(null);
    yield* project(projectId);
    if (store.isManual(projectId) || store.autoControlInitialized(projectId)) return controlOf(projectId);
    yield* resolveControl(projectId);
    return controlOf(projectId);
  });
  const globalDefinitionsPath = (): string => definitions?.globalDefinitionsPath?.() ?? "~/.t3-supervisor";
  const globalDefinitionsControl = Effect.gen(function* () {
    let presence: SupervisionFolderPresence = {status: "unavailable", message: "Global definition folder detection is not configured."};
    if (definitions?.presenceGlobal) {
      const read = yield* attempt(definitions.presenceGlobal().pipe(Effect.timeout("10 seconds")));
      presence = read.ok ? read.value : {status: "unavailable", message: "The server-user .t3-supervisor folder could not be checked."};
    }
    store.recordGlobalDefinitionsPresence(presence);
    return store.globalDefinitionsControl(globalDefinitionsPath());
  });
  const fingerprintRead = () => definitions!.globalFingerprint!().pipe(Effect.timeout("10 seconds"), attempt, Effect.map((read) => read.ok ? read.value : null));
  const saveGlobalDefinitionsControl = (input: GlobalDefinitionsControlInput) => Effect.gen(function* () {
    const homePath = globalDefinitionsPath();
    const current = yield* globalDefinitionsControl;
    if (!store.scopeCompatible) return {status: "unavailable" as const, message: "Supervisor state is unavailable; global definition settings were not changed.", control: current};
    if (current.generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Global definitions changed in another window. Reload before saving.", control: current};
    let outcome: Omit<ProjectDefinitionGlobalSetupOutcome, "path"> | null = null;
    let globalFingerprint: string | null = null;
    if (input.enabled) {
      if (!definitions?.initializeGlobal) return {status: "unavailable" as const, message: "Global definition setup is not configured; no setting was changed.", control: current};
      const initialized = yield* attempt(definitions.initializeGlobal().pipe(Effect.timeout("30 seconds")));
      if (!initialized.ok) return {status: "uncertain" as const, message: "Global definition setup could not be confirmed. Inspect ~/.t3-supervisor before retrying.", control: store.globalDefinitionsControl(homePath)};
      outcome = initialized.value;
      if (outcome.status !== "created" && outcome.status !== "unchanged") {
        const status = outcome.status === "uncertain" ? "uncertain" as const : outcome.status === "conflict" ? "conflict" as const : "unavailable" as const;
        return {status, message: outcome.message, control: store.globalDefinitionsControl(homePath)};
      }
      if (!definitions.globalFingerprint) return {status: "unavailable" as const, message: "Global definition input verification is unavailable; the setting was not changed.", control: store.globalDefinitionsControl(homePath)};
      globalFingerprint = yield* fingerprintRead();
      if (!globalFingerprint) return {status: "unavailable" as const, message: "The global definition folder could not be verified; the setting was not changed.", control: store.globalDefinitionsControl(homePath)};
    } else if (definitions?.globalFingerprint) {
      globalFingerprint = yield* fingerprintRead();
    }
    const changedMessage = outcome ? "The global definition folder is ready, but the setting changed before it could be enabled. Refresh before continuing." : "Global definitions changed in another window. Reload before saving.";
    // after the last read, the generation rechecks, the input verification and the save run as one admission section; without a
    // verification read the first generation recheck belongs to the same block
    const commit = (verified: {readonly value: string | null} | null) => gate.admit(() => Effect.sync(() => {
      if (verified === null) {
        if (store.globalDefinitionsControl(homePath).generation !== input.expectedGeneration) return {status: "conflict" as const, message: changedMessage, control: store.globalDefinitionsControl(homePath)};
      } else {
        if (input.enabled && verified.value !== globalFingerprint) return {status: "conflict" as const, message: "The global definition files changed while the switch was being saved. Reload and review the current folder before enabling them.", control: store.globalDefinitionsControl(homePath)};
        if (!input.enabled && verified.value !== globalFingerprint) globalFingerprint = null;
      }
      if (store.globalDefinitionsControl(homePath).generation !== input.expectedGeneration) {
        return {status: "conflict" as const, message: "Global definitions changed before the setting could be enabled. Refresh before continuing.", control: store.globalDefinitionsControl(homePath)};
      }
      try {
        const saved = store.saveGlobalDefinitionsControl(input.expectedGeneration, input.enabled, homePath, globalFingerprint);
        return {status: "saved" as const, message: input.enabled ? "Global definitions are now included in project Supervisor policy. Existing folder contents were preserved." : "Global definitions are no longer included. Project-local definitions remain available; existing plans are retained as stale history.", control: saved};
      } catch {return {status: "conflict" as const, message: "Global definitions changed in another window. Reload before saving.", control: store.globalDefinitionsControl(homePath)};}
    }));
    if (!(definitions?.globalFingerprint && globalFingerprint)) return yield* commit(null);
    if (store.globalDefinitionsControl(homePath).generation !== input.expectedGeneration) return {status: "conflict" as const, message: changedMessage, control: store.globalDefinitionsControl(homePath)};
    const verified = yield* fingerprintRead();
    return yield* commit({value: verified});
  });
  const setupOptions = (projectId: string): Effect.Effect<SetupOptions, StoreError | ProjectUnavailable> => Effect.gen(function* () {
    const {project: registered, catalog} = yield* project(projectId);
    const current = yield* controlFor(projectId);
    if (!definitions?.checkoutTargets || !definitions.presenceForCheckout) {
      return {projectId, generation: current.generation, available: false, message: "Registered checkout setup is unavailable.", checkouts: []};
    }
    const presenceForCheckout = definitions.presenceForCheckout;
    const targets = yield* attempt(definitions.checkoutTargets(projectId));
    if (!targets.ok) return {projectId, generation: current.generation, available: false, message: "Registered checkout targets could not be read.", checkouts: []};
    const valid = targets.value.filter(target => {
      const scratch = scope.scratchProject(projectId, registered.workspaceRoot);
      if (scratch) return false;
      if (target.threadId === null) return resolve(target.workspaceRoot) === resolve(registered.workspaceRoot);
      const thread = catalog.threads.find(item => item.id === target.threadId && item.projectId === projectId);
      return Boolean(thread && scope.eligible(thread, catalog.threads) && mainConversation(thread!, catalog.threads)?.id === thread!.id);
    });
    const checkouts = yield* Effect.forEach(valid, target => Effect.map(attempt(Effect.gen(function* () {
      if (target.threadId !== null) {
        const checkout = yield* projection(target.threadId);
        const workspace = checkout.thread.worktreePath;
        if (!scope.eligible(checkout.thread, catalog.threads) || checkout.thread.projectId !== projectId || typeof workspace !== "string" || resolve(workspace) !== resolve(target.workspaceRoot)) return null;
      }
      const presence = yield* presenceForCheckout(projectId, target.threadId);
      return {...target, folderStatus: presence.status};
    })), (read) => read.ok && read.value ? read.value : {...target, folderStatus: "unavailable" as const}), {concurrency: "unbounded"});
    return {projectId, generation: current.generation, available: checkouts.length > 0,
      message: checkouts.length ? "Choose a registered checkout and confirm its current branch before creating .t3-supervisor files." : "No eligible registered checkout is available.", checkouts};
  });
  const setup = (input: SupervisionSetupInput): Effect.Effect<SetupResult, StoreError | ProjectUnavailable | T3TransportError> => Effect.gen(function* () {
    const current = yield* controlFor(input.projectId);
    if (!store.scopeCompatible) return {status: "unavailable" as const, message: "Supervisor state is unavailable; no setup was made.", control: current, workspaceRoot: null, branch: null};
    if (current.generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed in another window. Reload checkout options before setup.", control: current, workspaceRoot: null, branch: null};
    if (!definitions?.checkoutTargets || !definitions.presenceForCheckout || (input.action !== "enable_existing" && !definitions.initialize)) {
      return {status: "unavailable" as const, message: "Registered checkout setup is unavailable; no files were changed.", control: current, workspaceRoot: null, branch: null};
    }
    const {checkoutTargets, presenceForCheckout} = definitions;
    const options = yield* setupOptions(input.projectId);
    const selected = options.checkouts.find(target => target.origin === input.origin && target.threadId === input.threadId && target.workspaceRoot === input.expectedWorkspaceRoot && target.branch === input.expectedBranch);
    if (!options.available || !selected) return {status: "conflict" as const, message: "The selected checkout or branch changed. Reload the setup options before retrying.", control: store.control(input.projectId), workspaceRoot: null, branch: null};
    if (input.action === "create_and_commit" && !selected.isGitRepository) return {status: "unavailable" as const, message: "This checkout is not a Git repository; choose Create without commit.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
    if (input.action === "enable_existing" && selected.folderStatus === "missing") return {status: "conflict" as const, message: "The selected checkout no longer has .t3-supervisor. Reload checkout options before enabling.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
    if (input.action !== "enable_existing" && selected.folderStatus === "present") return {status: "conflict" as const, message: "This checkout already has .t3-supervisor. Refresh its definitions before choosing another setup action.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
    if (selected.folderStatus === "unavailable") return {status: "unavailable" as const, message: "The selected checkout could not be checked; no files were changed.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
    if (store.control(input.projectId).generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed in another window. Reload checkout options before setup.", control: store.control(input.projectId), workspaceRoot: null, branch: null};
    let baseline: SupervisorBaseline | undefined;
    if (!current.enabled && current.globallyEnabled) {
      const boundary = yield* attempt(shell.baseline);
      if (!boundary.ok) return {status: "unavailable" as const, message: "The enable boundary could not be captured; no files were changed.", control: store.control(input.projectId), workspaceRoot: null, branch: null};
      baseline = boundary.value;
    }
    if (store.control(input.projectId).generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed before checkout setup. No files were changed.", control: store.control(input.projectId), workspaceRoot: null, branch: null};
    const {catalog} = yield* project(input.projectId);
    const registered = catalog.projects.find(item => item.available && item.project.id === input.projectId)?.project;
    if (!registered) return {status: "unavailable" as const, message: "The registered project is no longer available; no files were changed.", control: store.control(input.projectId), workspaceRoot: null, branch: null};
    if (scope.scratchProject(input.projectId, registered.workspaceRoot)) {
      return {status: "conflict" as const, message: "Scratch definitions use the separate server-user .t3-supervisor control.", control: store.control(input.projectId), workspaceRoot: null, branch: null};
    }
    if (input.threadId !== null) {
      const thread = catalog.threads.find(item => item.id === input.threadId && item.projectId === input.projectId);
      if (!thread || !scope.eligible(thread, catalog.threads) || mainConversation(thread, catalog.threads)?.id !== thread.id) return {status: "conflict" as const, message: "The selected operative checkout is no longer available; no files were changed.", control: store.control(input.projectId), workspaceRoot: null, branch: null};
      const checkout = yield* projection(input.threadId);
      if (checkout.thread.id !== input.threadId || !scope.eligible(checkout.thread, catalog.threads) || checkout.thread.projectId !== input.projectId || typeof checkout.thread.worktreePath !== "string" || resolve(checkout.thread.worktreePath) !== resolve(input.expectedWorkspaceRoot)) return {status: "conflict" as const, message: "The selected operative checkout changed; no files were changed.", control: store.control(input.projectId), workspaceRoot: null, branch: null};
    }
    if (store.control(input.projectId).generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed before checkout setup. No files were changed.", control: store.control(input.projectId), workspaceRoot: null, branch: null};
    if (input.action === "enable_existing") {
      const targets = yield* attempt(checkoutTargets(input.projectId));
      if (!targets.ok) return {status: "unavailable" as const, message: "The selected checkout could not be revalidated; no settings were changed.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      const stillSelected = targets.value.some(target => target.origin === input.origin && target.threadId === input.threadId &&
        target.workspaceRoot === input.expectedWorkspaceRoot && target.branch === input.expectedBranch);
      if (!stillSelected) return {status: "conflict" as const, message: "The selected checkout or branch changed. Reload checkout options before enabling.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      const latest = yield* attempt(project(input.projectId));
      if (!latest.ok) return {status: "unavailable" as const, message: "The project changed while checkout enablement was being checked; no settings were changed.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      const latestCatalog = latest.value.catalog;
      const latestProject = latestCatalog.projects.find(item => item.available && item.project.id === input.projectId)?.project;
      if (!latestProject || (input.threadId === null && resolve(latestProject.workspaceRoot) !== resolve(input.expectedWorkspaceRoot))) {
        return {status: "conflict" as const, message: "The selected project checkout changed. Reload checkout options before enabling.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      }
      if (input.threadId !== null) {
        const latestMain = latestCatalog.threads.find(item => item.id === input.threadId && item.projectId === input.projectId);
        if (!latestMain || !scope.eligible(latestMain, latestCatalog.threads) || mainConversation(latestMain, latestCatalog.threads)?.id !== latestMain.id) {
          return {status: "conflict" as const, message: "The selected checkout is no longer an eligible main conversation. Reload checkout options before enabling.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
        }
        const read = yield* attempt(projection(input.threadId));
        if (!read.ok) return {status: "unavailable" as const, message: "The selected checkout projection could not be revalidated; no settings were changed.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
        const checkout = read.value;
        if (checkout.thread.id !== input.threadId || !scope.eligible(checkout.thread, latestCatalog.threads) || checkout.thread.projectId !== input.projectId ||
          typeof checkout.thread.worktreePath !== "string" || resolve(checkout.thread.worktreePath) !== resolve(input.expectedWorkspaceRoot)) {
          return {status: "conflict" as const, message: "The selected operative checkout changed. Reload checkout options before enabling.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
        }
      }
      const checked = yield* attempt(presenceForCheckout(input.projectId, input.threadId));
      if (!checked.ok) return {status: "unavailable" as const, message: "The selected checkout could not be checked; no settings were changed.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      const presence = checked.value;
      // after the presence read, its checks, the generation recheck and the enablement commit run as one admission section
      return yield* gate.admit(() => Effect.sync((): SetupResult => {
        if (presence.status === "missing") return {status: "conflict" as const, message: "The selected checkout no longer has .t3-supervisor. Reload checkout options before enabling.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
        if (presence.status === "unavailable") return {status: "unavailable" as const, message: presence.message ?? "The selected checkout could not be checked; no settings were changed.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
        if (store.control(input.projectId).generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed before checkout enablement. Reload before continuing.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
        try {
          store.saveControl(input.projectId, input.expectedGeneration, true, baseline);
          store.setFolderPresence(input.projectId, {status: "present"});
          const saved = store.control(input.projectId);
          return {status: "saved" as const, message: "Existing .t3-supervisor definitions were adopted and project supervision is enabled. No files were written or committed.", control: saved,
            workspaceRoot: selected.workspaceRoot, branch: selected.branch};
        } catch {
          return {status: "conflict" as const, message: "Supervision changed before enablement. Refresh controls before continuing.",
            control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
        }
      }));
    }
    if (!definitions.initialize) return {status: "unavailable" as const, message: "Project checkout creation is unavailable; no files were changed.", control: store.control(input.projectId), workspaceRoot: selected.workspaceRoot, branch: selected.branch};
    const initialized = yield* attempt(definitions.initialize(input.projectId, input.threadId, {origin: "project", action: input.action,
      expectedWorkspaceRoot: input.expectedWorkspaceRoot, expectedBranch: input.expectedBranch}));
    if (!initialized.ok) return {status: "uncertain" as const, message: "The setup outcome could not be confirmed. Inspect the selected checkout before retrying.", control: store.control(input.projectId), workspaceRoot: input.expectedWorkspaceRoot, branch: input.expectedBranch};
    const outcome = initialized.value;
    // after the initialization, its confirmation checks and the enablement commit run as one admission section
    return yield* gate.admit(() => Effect.sync((): SetupResult => {
      const confirmed = input.action === "create" ? outcome.status === "created" : outcome.status === "committed";
      if (!confirmed || outcome.workspaceRoot !== input.expectedWorkspaceRoot || outcome.branch !== input.expectedBranch) {
        const status = outcome.status === "stale" || outcome.status === "conflict" || outcome.status === "unchanged" || confirmed ? "conflict" as const : outcome.status === "uncertain" ? "uncertain" as const : "unavailable" as const;
        return {status, message: outcome.message || (status === "conflict" ? "The selected checkout changed; reload setup options." : status === "uncertain" ? "The setup result is uncertain. Inspect the checkout before retrying." : "The selected checkout could not be initialized."),
          control: store.control(input.projectId), workspaceRoot: outcome.workspaceRoot, branch: outcome.branch};
      }
      try {
        const saved = store.saveControl(input.projectId, input.expectedGeneration, true, baseline);
        store.setFolderPresence(input.projectId, {status: "present"});
        return {status: "saved" as const, message: "The selected checkout was initialized and project supervision is enabled.", control: saved,
          workspaceRoot: outcome.workspaceRoot, branch: outcome.branch};
      } catch {
        return {status: "conflict" as const, message: "The checkout was initialized, but supervision changed before enablement. Refresh controls before continuing.",
          control: store.control(input.projectId), workspaceRoot: outcome.workspaceRoot, branch: outcome.branch};
      }
    }));
  });
  const saveControl = (input: SupervisionControlInput): Effect.Effect<SaveOutcome<"saved" | "conflict" | "unavailable" | "setup_required", ControlInfo>, StoreError | ProjectUnavailable | SharedCheckEnded> => Effect.gen(function* () {
    const registered = input.projectId !== null ? (yield* project(input.projectId)).project : null;
    const current = input.projectId === null ? store.control(null) : yield* resolveControl(input.projectId);
    const visibleCurrent = input.projectId === null ? current : controlOf(input.projectId);
    if (!store.scopeCompatible) return {status: "unavailable" as const, message: "Supervisor state is unavailable; no change was made.", control: visibleCurrent};
    if (current.generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed in another window. Reload before saving.", control: visibleCurrent};
    if (registered && scope.scratchProject(registered.id, registered.workspaceRoot)) return {status: "unavailable" as const,
      message: "Use the No Project mode in Instance settings. Shared definitions do not activate chats.", control: visibleCurrent};
    if (input.projectId !== null && input.enabled && !(current.manual && current.enabled)) {
      const presence = yield* detectFolder(input.projectId);
      const detected = store.control(input.projectId);
      const visibleDetected = controlOf(input.projectId);
      if (detected.generation !== input.expectedGeneration) return {status: "conflict" as const, message: "Supervision changed in another window. Reload before saving.", control: visibleDetected};
      if (presence.status === "missing") return {status: "setup_required" as const, message: "Choose a registered checkout and create its .t3-supervisor folder before enabling project supervision.", control: visibleDetected};
      if (presence.status === "unavailable") return {status: "unavailable" as const, message: presence.message ?? "The project .t3-supervisor folder could not be checked; no change was made.", control: visibleDetected};
    }
    const visible = () => input.projectId === null ? store.control(null) : controlOf(input.projectId);
    const commit = (baseline: SupervisorBaseline | undefined) => {
      try {
        store.saveControl(input.projectId, input.expectedGeneration, input.enabled, baseline);
        return {status: "saved" as const, message: input.enabled ? "Enabled. Existing scopes are retained; new task discovery starts from this enable boundary." : "Disabled. No new supervisory work will start; an already-running model turn may finish. Chats and history are retained.", control: visible()};
      } catch {return {status: "conflict" as const, message: "Supervision changed in another window. Reload before saving.", control: visible()};}
    };
    // after the last read, the boundary decision and, when no boundary is needed, the save run as one admission section
    const decided = yield* gate.admit(() => Effect.sync(() => {
      const latest = store.control(input.projectId);
      const needsBoundary = input.enabled && !latest.enabled && (input.projectId === null || latest.globallyEnabled);
      return needsBoundary ? null : commit(undefined);
    }));
    if (decided) return decided;
    const boundary = yield* attempt(shell.baseline);
    if (!boundary.ok) return {status: "unavailable" as const, message: "The enable boundary could not be captured; no change was made.", control: visible()};
    // after the boundary read, the save runs as one admission section
    return yield* gate.admit(() => Effect.sync(() => commit(boundary.value)));
  });
  const candidates = (query = "", purpose: "start" | "exclude" = "start"): Effect.Effect<Candidates, StoreError> => Effect.gen(function* () {
    if (query.length > 512) return {exceptions: [], candidates: [], message: "Search is limited to 512 characters."};
    const catalog = yield* source.catalog();
    scope.rememberScratchProjects(catalog.projects.map(item => item.project));
    const search = query.trim().replace(/^t3-thread:\/\/v1\//u, "").toLowerCase();
    const relevant = (projectId: string, threadId: string) => store.control(null).enabled && (scope.isNoProject(projectId)
      ? store.noProjectControl().mode !== "off" && (store.noProjectControl().mode === "automatic" || store.start(threadId)?.status === "active")
      : store.enabled(projectId));
    const exceptions = currentThreadPolicy(config).excludedThreadIds.filter(id => {
      const thread = catalog.threads.find(item => item.id === id);return thread?.projectId && !unavailable(thread) && relevant(thread.projectId, id);
    });
    const rows = catalog.threads.filter(thread => {
      if (!thread.projectId || !scope.mainShape(thread) || mainConversation(thread, catalog.threads)?.id !== thread.id ||
        !catalog.projects.some(item => item.available && item.project.id === thread.projectId)) return false;
      if (purpose === "start" ? !scope.isNoProject(thread.projectId) : !relevant(thread.projectId, thread.id)) return false;
      return !search || thread.id.toLowerCase() === search || thread.title.toLowerCase().includes(search);
    }).sort((a,b) => (timestampMs(b.updatedAt) ?? 0) - (timestampMs(a.updatedAt) ?? 0) || a.id.localeCompare(b.id)).slice(0, 8);
    return {exceptions, candidates: rows.map(thread => ({id: thread.id, projectId: thread.projectId!, title: thread.title,
      updatedAt: typeof thread.updatedAt === "string" ? thread.updatedAt : null, active: store.start(thread.id)?.status === "active" && !scope.supervisionStopped(thread.id),
      excluded: scope.supervisionStopped(thread.id)})), message: rows.length ? "Choose a chat. At most eight matches are shown." : "No matching available chat. Paste its native T3 link or change the search."};
  });
  const ensureBinding = (projectId: string, mainThreadId: string, title: string): Effect.Effect<BindingRecord, EnsureBindingError> => Effect.gen(function* () {
    if (!projectEnabled(projectId, mainThreadId)) return yield* new SupervisionDisabled();
    if (!operate) return yield* new SupervisorCredentialMissing();
    const {catalog} = yield* project(projectId);
    const main = yield* projection(mainThreadId);
    if (!projectEnabled(projectId, mainThreadId) || main.thread.projectId !== projectId || !(scope.eligible(main.thread, catalog.threads) || scope.validPendingStartFor(mainThreadId))) return yield* new MainConversationUnavailable();
    const settings = store.settings(projectId);
    let binding = store.binding(projectId, mainThreadId) ?? store.reserve(projectId, mainThreadId, title, settings.modelSelection, store.activation()!, now());
    const read = yield* attempt(projection(binding.threadId));
    if (!read.ok && !notFound(read.cause)) return yield* new SupervisorReadUnavailable();
    const existing = read.ok ? read.value : null;
    if (existing) {
      if (existing.thread.projectId !== projectId || supervisorUnavailable(existing.thread)) return yield* new InvalidSupervisorBinding();
      const freshMain = yield* lifecycle.readMain(binding);
      if (!projectEnabled(projectId, mainThreadId) || !freshMain || unavailable(freshMain.thread)) return yield* new MainConversationUnavailable();
      const ready = {...binding, state: "ready" as const};store.setBinding(ready);return ready;
    }
    if (binding.state === "ready" || binding.state === "missing") {store.setBinding({...binding, state: "missing"});return yield* new SupervisorMissing();}
    // replay uses the exact durable reservation, never a new thread identity
    if (binding.state === "rejected" || (binding.creationAttempts ?? 0) >= 3) return yield* new SupervisorCreationNeedsRetry();
    const freshMain = yield* lifecycle.readMain(binding);
    const reserved = binding;
    const rpc = operate;
    // the fresh scope recheck, the attempt receipt and the launch command run in one admission section; the reply and the
    // readback of the new conversation are classified outside it
    const launched = yield* admitSend(gate, {
      identity: reserved.threadId,
      inFlight: launches,
      prepare: (guard) => Effect.sync((): SendPreparation<LaunchOutcome> => {
        if (!guard.scopeEnabled(projectId, mainThreadId, "interpretation") || !freshMain || unavailable(freshMain.thread)) return {_tag: "Answer", value: {_tag: "MainUnavailable"}};
        binding = {...reserved, creationAttempts: (reserved.creationAttempts ?? 0) + 1};store.setBinding(binding);
        const attempted = binding;
        const uncertain = (providerDisabled: boolean, definite: boolean) => store.setBinding({...attempted, state: definite ? "rejected" : "uncertain",
          creationMessage: providerDisabled ? "The Supervisor provider is disabled for this project in T3. Save another model or enable the provider, then retry native access." : "Conversation creation could not be confirmed. Retry native access to inspect its retained identity."});
        return {_tag: "Initiate", initiate: Effect.map(rpc.initiate("orchestration.launchThread", {commandId: `supervisor-create:${attempted.threadId}:${attempted.generation}`, threadId: attempted.threadId,
          creationSource: "server", projectId, title: attempted.title, generateTitle: false, modelSelection: attempted.initialModel,
          runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: {type: "root"}}), (flight) => ({
          result: Effect.gen(function* () {
            const outcome = yield* attempt(Effect.gen(function* () {
              yield* flight.result;
              const created = yield* projection(attempted.threadId);
              if (created.thread.projectId !== projectId || supervisorUnavailable(created.thread)) return yield* new InvalidSupervisorBinding();
              const ready = {...attempted, state: "ready" as const};store.setBinding(ready);return ready;
            }));
            if (outcome.ok) return {_tag: "Ready" as const, binding: outcome.value};
            const cause = outcome.cause;
            uncertain(cause instanceof SupervisorRpcError && cause.providerDisabled, cause instanceof SupervisorRpcError && cause.definiteRejection);
            return {_tag: "Uncertain" as const};
          }).pipe(Effect.onInterrupt(() => Effect.sync(() => uncertain(false, false)))),
          release: flight.release,
        }))};
      }),
      reconcile: Effect.succeed<LaunchOutcome>({_tag: "Uncertain"}),
    });
    if (launched._tag === "MainUnavailable") return yield* new MainConversationUnavailable();
    if (launched._tag === "Uncertain") return yield* new SupervisorCreationUncertain();
    return launched.binding;
  });
  const prepareStarts = Effect.gen(function* () {
    const rows = store.store.db.prepare("SELECT value FROM meta WHERE key LIKE 'supervisor_start:%'").all();
    for (const row of rows) {
      const start = JSON.parse(String(row.value)) as SupervisionStartRecord;
      if (start.route === "ui" && start.status === "pending") {
        // the dashboard Start activation (or its rejection) as one admission section, acquired before its transaction opens
        const activated = yield* gate.admit(() => Effect.sync(() => {
          if (store.store.transaction(() => control.activateStart(start))) return true;
          control.rejectStart(start, "Dashboard Start was superseded before activation.");return false;
        }));
        if (!activated) continue;
        start.status = "active";
      }
      // the prepared marks and the control-change rejection as one admission section
      const next = yield* gate.admit((guard) => Effect.sync(() => {
        if (!start.source || !start.taskId || start.status === "rejected" || start.taskPrepared) return false;
        if (store.task(start.threadId)?.id === start.taskId) {store.saveStart({...start, taskPrepared: true});return false;}
        if (start.status === "pending" && !scope.validPendingStart(start)) {control.rejectStart(start, "Start was superseded by a control change.");return false;}
        return guard.scopeEnabled(start.projectId, start.threadId, "interpretation");
      }));
      if (!next) continue;
      const source = start.source!;
      const taskId = start.taskId!;
      yield* attempt(locks.withLock(supervisorScopeKey(start.projectId, start.threadId))(Effect.gen(function* () {
        const main = yield* projection(start.threadId);
        // after the source read, the source recheck and its rejection run as one admission section
        const message = yield* gate.admit(() => Effect.sync(() => {
          const found = genuineUserMessage(main, source.messageId);
          if (!found || found.runId !== source.runId || fingerprint(found.text) !== source.hash) {control.rejectStart(start, "The original human request changed or became unavailable.");return null;}
          return found;
        }));
        if (!message) return;
        const binding = yield* ensureBinding(start.projectId, start.threadId, main.thread.title);
        // after the binding, the scope and operation recheck, the Start's task and its prepared mark run as one admission section
        yield* gate.admit((guard) => Effect.sync(() => {
          if (!guard.scopeEnabled(start.projectId, start.threadId, "interpretation") || store.start(start.threadId)?.operationId !== start.operationId) return;
          store.store.transaction(() => {
            store.saveTask({id: taskId, threadId: start.threadId, projectId: start.projectId, sourceMessageId: message.id, sourceRunId: source.runId,
              sourceOrdinal: source.ordinal, sourceHash: source.hash, status: "queued", objective: null, reason: "Preparing the explicitly requested supervision.",
              updatedAt: now(), requestText: "", supervisorThreadId: binding.threadId, messageId: `supervisor-objective:${taskId}`,
              supervisorRunId: null, dispatchedAt: null, replayCount: 0});
            store.saveStart({...store.start(start.threadId)!, taskPrepared: true});
          });
        }));
      })));
    }
  });
  const overview = (page: {offset: number; limit: number}) => Effect.gen(function* () {
    const catalog = yield* source.catalog();
    scope.rememberScratchProjects(catalog.projects.map(item => item.project));
    return yield* readDashboardOverview({page, catalog, available: store.scopeCompatible && Boolean(operate), observedAt: now()}).pipe(
      Effect.provideService(SupervisionStores, stores), Effect.provideService(SupervisionScopeService, scope), Effect.provideService(SupervisorConversation, conversation));
  });
  const snapshot = (projectId: string, mainThreadId: string | null = null): Effect.Effect<ProjectSupervisorInfo, StoreError | ProjectUnavailable | InvalidMainConversation> => Effect.gen(function* () {
    const {catalog} = yield* project(projectId);
    if (mainThreadId !== null) {
      const selected = catalog.threads.find(thread => thread.id === mainThreadId && thread.projectId === projectId);
      // a chat whose supervision is stopped stays inspectable so its state and the Enable supervision control remain visible
      if (!selected || mainConversation(selected, catalog.threads)?.id !== mainThreadId ||
        !(scope.eligible(selected, catalog.threads) || scope.supervisionStopped(mainThreadId) && scope.mainShape(selected))) return yield* new InvalidMainConversation();
    }
    const binding = store.scopeCompatible && mainThreadId ? store.binding(projectId, mainThreadId) : null;
    let selection: SupervisorModelSelection | null = null;let available = Boolean(operate && store.scopeCompatible);let message = binding ? "Supervisor conversation is being prepared." : "The Supervisor conversation will be created automatically for the first new task.";
    let advertised: ProjectSupervisorInfo["models"] = [];
    const access = yield* attempt(Effect.gen(function* () {
      advertised = yield* models;
      if (binding) {
        const read = yield* attempt(projection(binding.threadId));
        if (!read.ok && !notFound(read.cause)) return yield* Effect.fail(read.cause);
        const supervisor = read.ok ? read.value : null;
        if (!supervisor) {message = binding.state === "ready" || binding.state === "missing" ? "The Supervisor conversation was deleted. Explicit replacement retains its old request identities." : binding.state === "rejected" ? "T3 rejected conversation creation. Save the desired model and retry native access." : "Conversation creation is uncertain. Retry native access to reconcile the original identity.";}
        else {
          if (supervisor.thread.projectId !== projectId) return yield* new SupervisorUnavailable();
          if (supervisorUnavailable(supervisor.thread)) {available = false;message = "The Supervisor conversation is archived or deleted. Restore it in T3; no automatic recreation occurs.";}
          else {
            selection = modelSelection(supervisor.thread.modelSelection);
            available = Boolean(available && selection);
            message = available && selection && validModelSelection(selection, advertised) ? "T3 runs the Supervisor for this main conversation. Valid new workflow drafts can be introduced through active steering, with ongoing check-ins from existing T3 activity." : "The configured Supervisor model is unavailable in T3. Choose an available model; no fallback model will run.";
            if (supervisor.thread.runtimeMode !== "full-access" || supervisor.thread.interactionMode !== "default") message += " This existing conversation retains its native modes; contact with a broader-mode operative chat needs an explicit mode change in T3.";
          }
        }
      }
      if (!operate) message = "Project supervision needs a dedicated T3 read/operate credential through deployment setup.";
    }));
    if (!access.ok) {available = false;message = "T3 Supervisor access is unavailable. Existing settings and conversation identity are retained.";}
    const teamData = binding ? yield* readTeamViewData(binding).pipe(Effect.provideService(SupervisionStores, stores)) : null;
    const current = store.settings(projectId);
    if (store.baseline() === null) message = "Native task discovery is initializing; interpretation is not active yet. " + message;
    const application = binding ? store.modelState(binding) : null;
    if (application?.applicationMessage) message = `${message} ${application.applicationMessage}`;
    if (current.pending && advertised.length && !validModelSelection(current.modelSelection, advertised)) message = "The saved Supervisor model is unavailable. Choose an available T3 model; no fallback will run.";
    if (binding?.settlement?.state === "uncertain") message += " Automatic settlement could not be confirmed. Retry native access reconciles the retained settlement command; supervision can continue in the same chat.";
    if (binding?.stopNotice && ["uncertain", "accepted", "blocked", "unconfirmed", "ready"].includes(binding.stopNotice.state))
      message += ` Operative Stop notice: ${binding.stopNotice.state}${binding.stopNotice.error ? ` (${binding.stopNotice.error})` : "."}`;
    if (binding?.manualKeepActive) message += " Automatic settlement is held by an observed user keep-active choice.";
    if (!store.scopeCompatible) {available = false;message = "Supervisor state has an unsupported scope version. Supervision is disabled without resetting state; other service integrations remain available.";}
    if (binding?.state === "rejected" && binding.creationMessage) message = binding.creationMessage;
    if (!binding && advertised.length && !validModelSelection(current.modelSelection, advertised)) message = "Default Supervisor model unavailable. Choose an available T3 model; no fallback will run.";
    if (!projectEnabled(projectId, mainThreadId ?? undefined)) message = "Supervision is disabled globally or for this project. Existing chats and history are retained. " + message;
    const policy = currentThreadPolicy(config);
    const stop = mainThreadId ? store.chatStop(mainThreadId) : null;
    const chatSupervision = mainThreadId ? {stopped: policy.excludedThreadIds.includes(mainThreadId), policyGeneration: policy.generation,
      stoppedBy: stop?.route ?? null, stoppedAt: stop?.stoppedAt ?? null,
      stoppedCallerThreadId: stop?.callerThreadId ?? null, stoppedUserMessageId: stop?.userMessageId ?? null,
      effectiveEnabled: scope.scopeEnabled(projectId, mainThreadId), activation: scope.isNoProject(projectId) ? store.start(mainThreadId)?.status ?? "not_started" : "automatic"} : null;
    return {projectId, mainThreadId, ...(scope.isNoProject(projectId) ? {noProjectMode: store.noProjectControl().mode} : {}), chatSupervision, team: binding && teamData ? supervisorTeamView(teamData, binding, catalog.threads, now()) : null, modelApplication: application ? {pending: application.pending, attempts: application.applyAttempts ?? 0, message: application.applicationMessage ?? null} : null, settings: {generation: current.generation, modelSelection: current.modelSelection, pending: false, monitoring: current.monitoring, teamSettings: current.teamSettings ?? {maxHelpersPerRoot: 5}}, monitoringStatus: conversation.status(projectId, binding?.threadId ?? null), binding: binding ? {...binding, settlementState: binding.settlement?.state ?? null, keptActive: Boolean(binding.manualKeepActive)} : null, modelSelection: selection, models: advertised, available, message,
      tasks: (binding ? store.tasksFor(binding) : []).slice(-200).reverse().map(({id,sourceHash,threadId,projectId,sourceRunId,sourceMessageId,status,objective,reason,updatedAt,workflow,workflowProposalId,agreement,definitionReview,workflowProtocolDiagnostic}) => ({id,sourceHash,threadId,projectId,sourceRunId,sourceMessageId,status,objective,reason,updatedAt,workflow: workflow ?? null,
        ...(workflowProposalId ? {workflowProposalId} : {}), agreement: agreement ?? null, workflowProtocolDiagnostic: workflowProtocolDiagnostic ?? null,
        ...(definitionReview ? {definitionReview} : {})}))};
  });
  const save = (input: ProjectSupervisorSaveInput): Effect.Effect<ProjectSupervisorSaveOutcome, StoreError | ProjectUnavailable | InvalidMainConversation | SupervisorRpcError> => Effect.gen(function* () {
    if (!store.scopeCompatible) return {status: "unavailable", message: "Supervisor state version is unsupported; no changes were made.", snapshot: null};
    return yield* locks.withLock(input.projectId)<ProjectSupervisorSaveOutcome, StoreError | ProjectUnavailable | InvalidMainConversation | SupervisorRpcError, never>(Effect.gen(function* () {
      yield* project(input.projectId);
      if (input.mainThreadId) yield* snapshot(input.projectId, input.mainThreadId);
      // the settings save; null when it committed
      const commit = (): ProjectSupervisorSaveOutcome | null => {
        try {store.saveSettings(input.projectId, input.expectedGeneration, input.modelSelection, input.monitoring, input.teamSettings);return null;}
        catch (cause) {if (cause instanceof Error && cause.message === "invalid_team_settings") return {status: "invalid", message: "Choose a whole-number helper limit from 0 to 20.", snapshot: null};return cause instanceof Error && cause.message === "invalid_monitoring_settings" ? {status: "invalid", message: "Use an interval of 1–60 minutes and an activity threshold of 3–100, both whole numbers.", snapshot: null} : {status: "conflict", message: "Project Supervisor settings changed. Refresh before saving again.", snapshot: null};}
      };
      // after the last read, the model check and the save run as one admission section; a changed model reads the advertised
      // models first and then checks and saves in its own section
      const unchanged = yield* gate.admit(() => Effect.sync(() => sameModel(input.modelSelection, store.settings(input.projectId).modelSelection) ? {outcome: commit()} : null));
      let outcome: ProjectSupervisorSaveOutcome | null;
      if (unchanged) outcome = unchanged.outcome;
      else {
        const advertised = yield* models;
        outcome = yield* gate.admit(() => Effect.sync(() => !validModelSelection(input.modelSelection, advertised)
          ? {status: "invalid" as const, message: "Choose an available T3 model and its advertised reasoning options.", snapshot: null} : commit()));
      }
      if (outcome) return outcome;
      return {status: "saved", message: "Saved. Monitoring settings apply on the next service check without discarding pending activity; model defaults apply only to new Supervisor conversations. Edit existing models in T3.", snapshot: yield* snapshot(input.projectId, input.mainThreadId ?? null)};
    }));
  });
  /** The dashboard's explicit human Stop supervision / Enable supervision control for one selected chat. */
  const setChatSupervision = (input: ProjectSupervisorChatSupervisionInput): Effect.Effect<ProjectSupervisorSaveOutcome, StoreError | ProjectUnavailable | InvalidMainConversation> => Effect.gen(function* () {
    if (input.enabled) {
      yield* project(input.projectId);
      if (scope.isNoProject(input.projectId)) {
        if (currentThreadPolicy(config).generation !== input.policyGeneration) return {status: "conflict", message: "Chat policy changed. Reload first.", snapshot: null};
        const result = yield* control.dashboardStart(input.mainThreadId, `enable:${yield* ids.uuid}`);
        return {status: result.status === "active" ? "saved" : "unavailable", message: result.reason, snapshot: yield* snapshot(input.projectId, input.mainThreadId)};
      }
    }
    const written = yield* control.setChatPolicy(input.mainThreadId, input.enabled, input.policyGeneration);
    if (written.status === "conflict") {
      const current = yield* attempt(snapshot(input.projectId, input.mainThreadId));
      return {status: "conflict", message: "Chat settings changed in another tab or by the Supervisor. The saved state is shown.", snapshot: current.ok ? current.value : null};
    }
    if (written.status !== "saved") return {status: "unavailable", message: written.status === "full" ? "The excluded chat list is full." : "Chat settings are unavailable.", snapshot: null};
    return {status: "saved", message: input.enabled ? "Supervision is enabled for this chat; its next request is supervised by the same Supervisor."
      : "Supervision is stopped for this chat. Its operative is notified to stop replying to the Supervisor, which settles when idle. The operative task continues.", snapshot: yield* snapshot(input.projectId, input.mainThreadId)};
  });
  const complete = (job: TaskRecord, status: TaskRecord["status"], objective: string | null, reason: string): void => {
    const start = store.start(job.threadId);
    if (start?.status === "pending" && start.taskId === job.id && ["unavailable", "expired"].includes(status)) control.rejectStart(start, reason);
    const workflow = job.workflow?.status === "pending" ? {...job.workflow, status: "unavailable" as const, message: reason} : job.workflow;
    store.saveTask({...job, status, objective, reason, workflow: workflow ?? null, requestText: "", updatedAt: now()});
  };
  /** Whether the request is at or before the project/global activation boundary (unknown counts as before) or the chat's latest Enable. */
  const beforeBoundary = (job: TaskRecord, main: Projection): boolean => {
    if (pinnedStart(job)) return false;
    const floor = sourceFloor(job.threadId, main), enabledAt = store.chatEnabledAt(job.threadId);
    return floor === null || job.sourceOrdinal <= floor ||
      enabledAt !== null && !((timestampMs(main.messages.find(item => item.id === job.sourceMessageId)?.createdAt) ?? 0) > enabledAt);
  };
  const currentSource = (job: TaskRecord, main: Projection): boolean => {
    const run = main.runs.find(item => item.id === job.sourceRunId && item.ordinal === job.sourceOrdinal);
    const message = main.messages.find(item => item.id === job.sourceMessageId && item.runId === job.sourceRunId);
    return main.thread.id === job.threadId && main.thread.projectId === job.projectId && !unavailable(main.thread) &&
      !isSupervisorThread(config, main.thread) && (!scope.supervisionStopped(job.threadId) || scope.validPendingStartFor(job.threadId)) &&
      Boolean(message && run && nativeUserMessageVisible(main, run, message) && message.role === "user" && message.streaming === false && message.createdBy === "user" &&
        (message.creationSource === "web" || message.creationSource === "mobile") && !message.senderThreadId && !message.scheduledTaskId && !message.source &&
        fingerprint(message.text) === job.sourceHash) && store.binding(job.projectId, job.threadId)?.threadId === job.supervisorThreadId;
  };
  /**
   * One interpretation request under the admission contract (plan 3.11). Checked immediately before the native effect, after every
   * awaited read: a stop or disable saved meanwhile sends nothing and a dispatching receipt returns to queued; a fresh request also
   * rechecks its activation boundary, since its receipt now precedes the section. The command starts in the section; its reply is
   * classified outside it under the original identity, an interrupted wait as uncertain.
   */
  const dispatch = (job: TaskRecord, fresh: {readonly source: Projection} | null) => Effect.gen(function* () {
    if (!operate) return;
    const rpc = operate;
    yield* admitSend(gate, {
      identity: job.id,
      inFlight: dispatches,
      prepare: (guard) => Effect.sync((): SendPreparation<void> => {
        const stopped = guard.supervisionStopped(job.threadId) && !scope.validPendingStartFor(job.threadId);
        if (stopped || !guard.scopeEnabled(job.projectId, job.threadId, "interpretation")) {
          if (job.status === "dispatching") store.saveTask({...job, status: "queued", dispatchedAt: null,
            reason: stopped ? "Supervision was stopped for this chat before dispatch; this task identity remains unsent." : "Supervision was disabled before dispatch; this task identity remains queued.", updatedAt: now()});
          return {_tag: "Answer", value: undefined};
        }
        if (fresh && beforeBoundary(job, fresh.source)) {complete(job, "expired", null, enabledAgainReason);return {_tag: "Answer", value: undefined};}
        const uncertain = () => store.saveTask({...job, status: "uncertain", reason: "Interpretation dispatch is uncertain; retry native access to reconcile the original request identity.", updatedAt: now()});
        return {_tag: "Initiate", initiate: Effect.map(rpc.initiate("orchestration.dispatchCommand", {type: "message.dispatch", createdBy: "system", creationSource: "server", commandId: `supervisor-objective:${job.id}`,
          threadId: job.supervisorThreadId, messageId: job.messageId, text: job.requestText, attachments: [], dispatchMode: {type: "queue_after_active"}}), (flight) => ({
          result: Effect.gen(function* () {
            const reply = yield* attempt(flight.result);
            if (reply.ok) {store.saveTask({...job, status: "waiting", reason: "T3 accepted the interpretation request; waiting for its result.", updatedAt: now()});return;}
            const cause = reply.cause;
            if (cause instanceof SupervisorRpcError && cause.definiteRejection) complete(job, "unavailable", null, cause.providerDisabled ? "The Supervisor provider is disabled for this project in T3. Choose another model or enable the provider; other tasks can continue." : "T3 definitively rejected the interpretation request. Other tasks can continue.");
            else uncertain();
          }).pipe(Effect.onInterrupt(() => Effect.sync(uncertain))),
          release: flight.release,
        }))};
      }),
      reconcile: Effect.void,
    });
  });
  /**
   * While a chat is stopped an accepted interpretation is only observed: once its native run has ended the task closes without
   * applying the result. Nothing is resent, and an identity with no native outcome stays unresolved.
   */
  const reconcileStoppedInterpretation = (binding: BindingRecord) => Effect.gen(function* () {
    const jobs = store.tasksFor(binding).filter(job => ["dispatching", "waiting", "uncertain"].includes(job.status));
    if (!jobs.length) return;
    const read = yield* attempt(projection(binding.threadId));
    if (!read.ok) return;
    const supervisor = read.value;
    for (const job of jobs) {
      const message = supervisor.messages.find(m => m.id === job.messageId && m.threadId === job.supervisorThreadId && m.text === job.requestText);
      const run = message ? supervisor.runs.find(r => r.userMessageId === job.messageId && r.threadId === job.supervisorThreadId && r.id === message.runId) : undefined;
      if (run && ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status))
        complete({...job, supervisorRunId: run.id}, "unavailable", null, "Supervision was stopped for this chat; the interpretation result was not applied.");
    }
  });
  const reconcile = (initial: TaskRecord, supervisor: Projection, bound: BindingRecord) => Effect.gen(function* () {
    let job = initial;
    const nativeIdentity = supervisor.messages.find(item => item.id === job.messageId && item.threadId === job.supervisorThreadId);
    if (nativeIdentity && nativeIdentity.text !== job.requestText) {
      const nativeRun = supervisor.runs.find(item => item.id === nativeIdentity.runId && item.userMessageId === job.messageId);
      if (nativeRun && ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(nativeRun.status))
        complete({...job, supervisorRunId: nativeRun.id}, "unavailable", null, "The retained interpretation identity belongs to different native content; its confirmed terminal result was not applied or resent.");
      return;
    }
    const message = supervisor.messages.find(m => m.id === job.messageId && m.threadId === job.supervisorThreadId && m.text === job.requestText);
    const run = message ? supervisor.runs.find(r => r.userMessageId === job.messageId && r.threadId === job.supervisorThreadId && r.id === message.runId) : undefined;
    if (!run) {
      if (!active(supervisor) && job.replayCount < 2) {const replay = {...job, replayCount: job.replayCount + 1};store.saveTask(replay);yield* dispatch(replay, null);}
      if (job.replayCount >= 2 && job.status !== "uncertain") store.saveTask({...job, status: "uncertain", reason: "The accepted request has no matching native run. Retry native access to reconcile its retained identity.", updatedAt: now()});
      return;
    }
    if (job.supervisorRunId !== run.id) {job = {...job, supervisorRunId: run.id};store.saveTask(job);}
    if (run.status === "completed" && job.roleVersion) conversation.roleDelivered(job.supervisorThreadId, job.roleVersion);
    if (run.status !== "completed") {
      if (["failed","interrupted","cancelled","rolled_back"].includes(run.status)) complete(job, "unavailable", null, "The interpretation run did not complete successfully.");
      else if (run.status !== "queued" && run.status !== "preparing" && timestampMs(run.startedAt) !== null && now() - timestampMs(run.startedAt)! > 300_000) complete(job, "unavailable", null, "The interpretation timed out or requires input. The service does not answer or interrupt Supervisor runs.");
      return;
    }
    let source = yield* projection(job.threadId);
    if (!currentSource(job, source)) {complete(job, "unavailable", null, "The task source changed before the interpretation completed.");return;}
    const nodeFor = mainRunNodeReader(supervisor, run);
    const answers = supervisor.messages.filter(m => m.threadId === job.supervisorThreadId && m.runId === run.id && m.role === "assistant" && !m.streaming && m.nodeId && nodeFor(m.nodeId)?.kind === "assistant_message")
      .sort((a,b) => (timestampMs(a.createdAt) ?? 0) - (timestampMs(b.createdAt) ?? 0));
    const interpreted = yield* attempt(Effect.gen(function* () {
      const pendingStart = store.start(job.threadId);
      let answer = answers.at(-1)?.text ?? "";
      let approveStart = false;
      if (pendingStart?.status === "pending" && pendingStart.taskId === job.id) {
        const clean = answer.trim().replace(/^```(?:json)?\s*\n/u, "").replace(/\n```$/u, "");
        // model output: the JSON value, then exactly the boolean verdict and the cited source; the rest of it is the interpretation
        const parsed = decodeJson(clean);
        if (Exit.isFailure(parsed)) return yield* new InvalidStartVerdict();
        const verdict = Schema.decodeUnknownExit(startVerdict(job.sourceMessageId))(parsed.value);
        if (Exit.isFailure(verdict)) return yield* new InvalidStartVerdict();
        if (!verdict.value.startRequested) {control.rejectStart(pendingStart, "The original human message did not request supervision.");complete(job, "not_supervised", null, "Start was not authorized by the user.");return;}
        const value = parsed.value as Record<string, unknown>;
        approveStart = true;delete value.startRequested;answer = JSON.stringify(value);
      }
      const result: {objective: string | null; reason: string; workflow?: WorkflowProposalInfo; supervision?: "needed" | "not_needed"} = job.definitionContext ? parseWorkflowInterpretation(answer, job.sourceMessageId, job.definitionContext) : parseInterpretation(answer, job.sourceMessageId);
      if (result.workflow) {
        let currentDefinitions = false;
        let transientReadFailure = false;
        const loaded = definitions ? yield* attempt(definitions.load(job.projectId, job.threadId)) : {ok: true as const, value: undefined};
        if (loaded.ok) {
          const read = loaded.value;
          transientReadFailure = !read;
          currentDefinitions = Boolean(read && read.projectId === job.projectId && read.threadId === job.threadId &&
            sameDefinitionRead(job.definitionSnapshot, read));
        } else transientReadFailure = true;
        if (transientReadFailure) {
          job = {...job, revalidationAttempts: (job.revalidationAttempts ?? 0) + 1};
          if (job.revalidationAttempts! < 3) {store.saveTask({...job, reason: "The model completed; project definition revalidation will retry with a bounded budget.", updatedAt: now()});return;}
        }
        const staleWorkflow = currentDefinitions ? result.workflow : {...result.workflow, status: "stale" as const,
          message: "The definition source changed or could not be revalidated. This plan is retained as provisional history with its requirements and diagnostics."};
        job = {...job, workflow: staleWorkflow};
        source = yield* projection(job.threadId);
        if (!currentSource(job, source)) {complete(job, "unavailable", null, "The task source changed while the workflow was being revalidated.");return;}
      }
      // from the last await, the result's authority, the boundary recheck, the Start activation and the result commit as one
      // admission section
      const settled = source;
      const finished = job;
      yield* gate.admit((guard) => Effect.sync(() => {
        // the retained task and its binding are still the ones this result answers; otherwise another writer settled or replaced them
        const retained = store.task(finished.threadId);
        const owner = store.binding(finished.projectId, finished.threadId);
        if (retained?.id !== finished.id || !["dispatching", "waiting", "uncertain"].includes(retained.status) ||
          owner?.threadId !== bound.threadId || owner.generation !== bound.generation) return;
        // rechecked after the final await: a result for a request before a boundary saved meanwhile closes unapplied
        if (beforeBoundary(finished, settled)) {complete({...finished, supervisorRunId: run.id}, "expired", null, enabledAgainReason);return;}
        // a Stop admitted after the last read closes the retained task unapplied, as a stopped chat's settled interpretation closes
        if (guard.supervisionStopped(finished.threadId) && !scope.validPendingStartFor(finished.threadId)) {
          complete({...retained, supervisorRunId: run.id}, "unavailable", null, "Supervision was stopped for this chat; the interpretation result was not applied.");return;
        }
        // a disable admitted after the last read leaves the result unapplied; a later cycle settles it under the enablement rules
        if (!guard.scopeEnabled(finished.projectId, finished.threadId, "interpretation")) return;
        store.store.transaction(() => {
          if (approveStart && (!pendingStart || !scope.validPendingStart(pendingStart) || !currentSource(finished, settled) || !control.activateStart(pendingStart))) {
            if (pendingStart) control.rejectStart(pendingStart, "Start was superseded or could not be committed.");
            complete(finished, "expired", null, "Start was not activated.");return;
          }
          complete(finished, result.objective === null ? "needs_context" : result.supervision === "not_needed" ? "not_supervised" : "inferred", result.objective, result.reason);
        });
      }));
    }));
    if (!interpreted.ok) {
      const start = store.start(job.threadId);
      if (start?.status === "pending" && start.taskId === job.id) control.rejectStart(start, "The Supervisor did not return a valid source-linked Start verdict.");
      complete(job, "unavailable", null, "The Supervisor did not return a valid, source-linked interpretation.");
    }
  });
  // the fresh catalog threads a conversation pass reads, read when the pass runs
  const conversationThreads = Effect.suspend(() => Effect.map(source.catalog(), (catalog) => catalog.threads));
  const processProject = (input: BindingRecord) => Effect.gen(function* () {
    const currentBinding = store.binding(input.projectId, input.mainThreadId);
    if (!currentBinding) return;
    let binding = currentBinding;
    if (teamEffects) yield* teamEffects.reconcile(binding);
    if (!projectEnabled(binding.projectId, binding.mainThreadId)) return;
    const main = yield* lifecycle.readMain(binding);
    if (!projectEnabled(binding.projectId, binding.mainThreadId) || !main || unavailable(main.thread)) return;
    yield* project(binding.projectId);
    if (!projectEnabled(binding.projectId, binding.mainThreadId)) return;
    const bound = binding;
    const supervisor = yield* projection(binding.threadId).pipe(Effect.tapError((cause) => Effect.sync(() => {
      if (cause instanceof T3TransportError && cause.httpStatus === 404 && bound.state === "ready") store.setBinding({...bound, state: "missing"});
    })));
    if (supervisor.thread.projectId !== binding.projectId || supervisorUnavailable(supervisor.thread)) return;
    if (!projectEnabled(binding.projectId, binding.mainThreadId)) return;
    if (binding.state !== "ready") {binding = {...binding, state: "ready"};store.setBinding(binding);}
    const observed = modelSelection(supervisor.thread.modelSelection);
    if (!observed) return yield* new SupervisorModelMissing();
    const latest = store.binding(binding.projectId, binding.mainThreadId);
    if (latest && latest.threadId === binding.threadId) {
      if (supervisor.thread.settledOverride === "active" && !scope.supervisionStopped(binding.mainThreadId)) store.setBinding({...latest, manualKeepActive: true});
      store.observeModel(binding, observed);
    }
    const jobs = store.tasksFor(binding);
    const inflight = jobs.find(t => ["dispatching","waiting","uncertain"].includes(t.status));
    if (inflight) {
      if (!projectEnabled(binding.projectId, binding.mainThreadId)) return;
      // an interpretation of a request at or before the activation boundary, or written or sent before the latest explicit Enable,
      // is never applied or resent: only its positively matched native run closes it once ended; an absent or active outcome keeps
      // the identity held unapplied
      const enabledAt = store.chatEnabledAt(inflight.threadId), floor = sourceFloor(inflight.threadId, main);
      const sourceAt = timestampMs(main.messages.find(m => m.id === inflight.sourceMessageId)?.createdAt) ?? 0;
      if (!pinnedStart(inflight) && (floor === null || inflight.sourceOrdinal <= floor ||
        enabledAt !== null && (sourceAt <= enabledAt || inflight.dispatchedAt !== null && inflight.dispatchedAt <= enabledAt))) {
        const message = supervisor.messages.find(m => m.id === inflight.messageId && m.threadId === inflight.supervisorThreadId && m.text === inflight.requestText);
        const run = message ? supervisor.runs.find(r => r.userMessageId === inflight.messageId && r.threadId === inflight.supervisorThreadId && r.id === message.runId) : undefined;
        if (run && ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status))
          complete({...inflight, supervisorRunId: run.id}, "expired", null, enabledAgainReason);
        return;
      }
      yield* reconcile(inflight, supervisor, binding);
      // a proposal is introduced in the same cycle its interpretation completes, through the ordinary conversation path and its fences
      const interpreted = store.task(inflight.threadId);
      if (interpreted?.id === inflight.id && interpreted.status === "inferred" && scope.scopeEnabled(binding.projectId, binding.mainThreadId))
        yield* conversation.run(binding, supervisor, yield* conversationThreads);
      return;
    }
    if (!scope.scopeEnabled(binding.projectId, binding.mainThreadId) && !jobs.some(job => job.status === "queued")) return;
    if (conversation.hasInflight(binding.projectId, binding.threadId)) {if (projectEnabled(binding.projectId, binding.mainThreadId)) yield* conversation.run(binding, supervisor, yield* conversationThreads);return;}
    if (active(supervisor)) {if (projectEnabled(binding.projectId, binding.mainThreadId)) yield* conversation.run(binding, supervisor, yield* conversationThreads);return;}
    let job = jobs.find(t => t.status === "queued");
    if (!job) {yield* conversation.run(binding, supervisor, yield* conversationThreads);return;}
    const source = yield* projection(job.threadId);
    if (!projectEnabled(binding.projectId, binding.mainThreadId)) return;
    if (!currentSource(job, source)) {complete(job, "unavailable", null, "The task source changed or became unavailable.");return;}
    if (beforeBoundary(job, source)) {complete(job, "expired", null, enabledAgainReason);return;}
    if (job.definitionContext == null) {
      let loadedDefinitions: ProjectDefinitionSnapshot;
      const queued = job;
      const loaded = definitions ? yield* attempt(definitions.load(queued.projectId, queued.threadId)) : {ok: true as const, value: unavailableDefinitions(queued)};
      if (loaded.ok && (loaded.value.projectId !== queued.projectId || loaded.value.threadId !== queued.threadId) || !loaded.ok) {
        job = {...job, definitionReadAttempts: (job.definitionReadAttempts ?? 0) + 1};
        if (job.definitionReadAttempts! < 3) {store.saveTask({...job, reason: "Project definitions could not be read; workflow preparation will retry with a bounded budget.", updatedAt: now()});return;}
        loadedDefinitions = unavailableDefinitions(job);
      } else {
        loadedDefinitions = loaded.value;
        if (loadedDefinitions.status === "unavailable") {
          job = {...job, definitionReadAttempts: (job.definitionReadAttempts ?? 0) + 1};
          if (job.definitionReadAttempts! < 3) {store.saveTask({...job, reason: "Project definitions are temporarily unavailable; workflow preparation will retry with a bounded budget.", updatedAt: now()});return;}
        }
      }
      const preparing = job;
      const message = source.messages.find(item => item.id === preparing.sourceMessageId)!;
      // the earlier unresolved requests stay context; only genuine visible user messages of this main are carried
      const earlierMessages = (preparing.contextMessageIds ?? []).flatMap(id => {
        const earlier = source.messages.find(item => item.id === id && item.threadId === preparing.threadId && item.role === "user" && item.createdBy === "user" &&
          !item.streaming && (item.creationSource === "web" || item.creationSource === "mobile") && !item.senderThreadId && !item.scheduledTaskId && !item.source);
        const run = earlier?.runId ? source.runs.find(item => item.id === earlier.runId) : undefined;
        return earlier && run && nativeUserMessageVisible(source, run, earlier) ? [{messageId: earlier.id, text: earlier.text}] : [];
      });
      const reader = scope.workflowEditingEnabled(preparing.projectId, preparing.threadId, "status");
      const prepared = prepareWorkflowRequest(preparing.threadId, preparing.sourceMessageId, message.text, loadedDefinitions, {earlierMessages,
        ...(reader ? {reader: {supervisorThreadId: binding.threadId, bindingGeneration: binding.generation}} : {})});
      // the root's first message carries its concise standing role once, so no separate initialization turn is needed
      const role = reader ? conversation.interpretationRole(binding) : null;
      const startCheck = store.start(preparing.threadId)?.status === "pending" ? `START AUTHORIZATION: In this SAME interpretation, first judge whether the original human message explicitly asks for Supervisor supervision of this chat. Include the additional top-level boolean startRequested in your JSON, independently of task relevance or plan validity. Always cite exactly the supplied messageId. A negative verdict grants no effects; return objective:null, workflow:null and an explanation. Never contact the operative.\n` : "";
      job = {...preparing, requestText: startCheck + (role ? `${role.text}\n${prepared.requestText}` : prepared.requestText), definitionContext: prepared.context, workflow: prepared.workflow,
        definitionSnapshot: prepared.context ? loadedDefinitions : null, ...(role ? {roleVersion: role.roleVersion} : {})};
      store.saveTask(job);
      if (!currentSource(job, yield* projection(job.threadId))) {complete(job, "unavailable", null, "The task source changed while project definitions were being loaded.");return;}
    }
    if (!projectEnabled(binding.projectId, binding.mainThreadId)) return;
    const current = modelSelection((yield* projection(binding.threadId)).thread.modelSelection);
    if (!current || !validModelSelection(current, yield* models) || !projectEnabled(binding.projectId, binding.mainThreadId)) return;
    // rechecked after the final await: an Enable or re-enable saved meanwhile leaves this request uninterpreted
    if (beforeBoundary(job, source)) {complete(job, "expired", null, enabledAgainReason);return;}
    const at = now();
    const sending: TaskRecord = {...job, status: "dispatching", dispatchedAt: at, updatedAt: at};store.saveTask(sending);
    yield* dispatch(sending, {source});
  });
  const checkClosedMainLifecycle = (binding: BindingRecord, threads: readonly ThreadInfo[]) => Effect.gen(function* () {
    if (!operate) return;
    const current = store.binding(binding.projectId, binding.mainThreadId);
    if (!current || current.threadId !== binding.threadId || current.state !== "ready") return;
    const read = yield* attempt(lifecycle.readMain(current));
    if (!read.ok) return;
    if (!read.value || unavailable(read.value.thread)) yield* lifecycle.check(current, threads);
  });
  // one binding of a batch under its 30 s deadline: the stop notice, then the stopped, inactive No Project, closed or supervised path
  const bindingWork = (binding: BindingRecord, threads: readonly ThreadInfo[], masterEnabled: boolean) => Effect.gen(function* () {
    const locked = locks.withLock(supervisorScopeKey(binding.projectId, binding.mainThreadId));
    if (store.scopeCompatible) yield* locked(conversation.reconcileStopNotice(binding));
    // a human stop settles its owned Supervisor even while global or project supervision is disabled
    if (scope.supervisionStopped(binding.mainThreadId) && !scope.validPendingStartFor(binding.mainThreadId)) return yield* locked(Effect.gen(function* () {
      // reconciliation sends nothing; it confirms accepted root, helper and guidance deliveries before the owned Supervisor may settle
      const reconciled = yield* Effect.exit(Effect.gen(function* () {
        if (store.scopeCompatible) {
          yield* reconcileStoppedInterpretation(binding);
          yield* conversation.reconcileStopped(binding, threads);
          if (teamRuntime) yield* teamRuntime.reconcileStopped(binding, threads);
          if (teamEffects) yield* teamEffects.reconcileStopped(binding);
        }
      }));
      yield* lifecycle.check(binding, threads);
      return yield* reconciled;
    }));
    if (scope.isNoProject(binding.projectId) && store.start(binding.mainThreadId)?.status !== "active" && !projectEnabled(binding.projectId, binding.mainThreadId)) return yield* locked(Effect.gen(function* () {
      yield* reconcileStoppedInterpretation(binding);
      conversation.fenceStoppedSupervision(binding);
      yield* conversation.reconcileStopped(binding, threads);
      if (teamRuntime) yield* teamRuntime.reconcileStopped(binding, threads);
      if (teamEffects) yield* teamEffects.reconcileStopped(binding);
      yield* lifecycle.parkInactive(binding, () => !projectEnabled(binding.projectId, binding.mainThreadId));
    }));
    if (!masterEnabled || !projectEnabled(binding.projectId, binding.mainThreadId)) return yield* checkClosedMainLifecycle(binding, threads);
    return yield* locked(Effect.gen(function* () {
      const processed = yield* Effect.exit(processProject(binding));
      if (projectEnabled(binding.projectId, binding.mainThreadId)) yield* lifecycle.check(binding, threads);
      return yield* processed;
    }));
  }).pipe(Effect.timeout("30 seconds"));
  // one discovery step for a candidate main: a new genuine human request becomes a queued interpretation task of its binding
  const discover = (thread: ThreadInfo, registered: {id: string}, previous: TaskRecord | null, catalog: CatalogValue) => Effect.gen(function* () {
    const main = yield* projection(thread.id);
    if (!scope.eligible(main.thread, catalog.threads) || main.thread.projectId !== registered.id) return;
    const baseline = sourceFloor(thread.id, main);if (baseline === null) return;
    // an explicit Enable or a new activation boundary supervises the chat's next request afresh, even after an agreed task
    const enabledSince = store.chatEnabledAt(thread.id);
    const prior = previous ? requests.introduction(previous.id) : null;
    // only an attempted introduction whose outcome is unknown holds the task; a never-attempted draft or a fallback whose
    // earlier attempts were definitely rejected is known unsent and does not strand the next request
    const priorUnresolved = Boolean(prior && introductionOutcomeUnknown(prior));
    const examine = (latestRunId: string) => Ref.update(examinedNonTasks, (map) => HashMap.set(HashMap.size(map) >= 10_000 ? HashMap.empty() : map, thread.id, latestRunId));
    if (previous?.status === "inferred" && (priorUnresolved || !(previous.sourceOrdinal <= baseline || enabledSince !== null && previous.dispatchedAt !== null && previous.dispatchedAt <= enabledSince))) {
      // an unresolved introduction is a mutable hold, so the chat is examined again until its delivery outcome is known
      if (!priorUnresolved) {
        if (typeof thread.latestRunId === "string") yield* examine(thread.latestRunId);
        else yield* Ref.update(examinedNonTasks, (map) => HashMap.size(map) >= 10_000 ? HashMap.empty() : map);
      }
      return;
    }
    // an explicit Enable supervises the chat's next request: a request written while supervision was stopped is not interpreted
    const task = taskSource(main, Math.max(baseline, previous?.sourceOrdinal ?? 0), store.chatEnabledAt(thread.id));
    if (!task) {
      if (!active(main) && typeof thread.latestRunId === "string") yield* examine(thread.latestRunId);
      return;
    }
    const selection = store.settings(registered.id).modelSelection;
    if (!validModelSelection(selection, yield* models) || !projectEnabled(registered.id, thread.id)) return;
    const freshMain = yield* projection(thread.id);
    if (!projectEnabled(registered.id, thread.id) || freshMain.thread.projectId !== registered.id || !scope.eligible(freshMain.thread, catalog.threads)) return;
    const binding = yield* locks.withLock(supervisorScopeKey(registered.id, thread.id))(ensureBinding(registered.id, thread.id, thread.title));
    // the task identity, allocated before the recheck and the write
    const id = yield* ids.uuid;
    if (!projectEnabled(registered.id, thread.id)) return;
    // a task another discovery wrote for this chat since this one read it is never replaced: queued or in-flight work keeps its identity
    if ((store.task(thread.id)?.id ?? null) !== (previous?.id ?? null)) return;
    // an earlier unresolved request carries forward only from the current supervision epoch: above the activation
    // boundary and written after the chat's latest Enable
    const enabledAt = store.chatEnabledAt(thread.id);
    const carried = previous?.status === "needs_context" ? [...(previous.contextMessageIds ?? []), previous.sourceMessageId].filter(messageId => {
      const message = main.messages.find(item => item.id === messageId);
      const run = message?.runId ? main.runs.find(item => item.id === message.runId) : undefined;
      return Boolean(message && run && run.ordinal > baseline && (enabledAt === null || (timestampMs(message.createdAt) ?? 0) > enabledAt));
    }).slice(-5) : [];
    const oversized = task.message.text.length > 24_000;
    store.saveTask({id, threadId: thread.id, projectId: registered.id, sourceRunId: task.run.id, sourceMessageId: task.message.id,
      sourceOrdinal: task.run.ordinal, sourceHash: fingerprint(task.message.text), status: oversized ? "needs_context" : "queued", objective: null,
      reason: oversized ? "The task message exceeds the interpretation limit; provide a shorter task." : "Waiting for the project Supervisor.",
      updatedAt: now(), requestText: oversized ? "" : interpretationPrompt(thread.id, task.message.id, task.message.text), supervisorThreadId: binding.threadId,
      messageId: `supervisor-objective:${id}`, supervisorRunId: null, dispatchedAt: null, replayCount: 0,
      // only an unresolved request carries forward; an answered not-needed request is complete and never merges into the next task
      ...(carried.length ? {contextMessageIds: carried} : {})});
  });
  const cycle = Effect.gen(function* () {
    if (!operate || !store.scopeCompatible) return;
    const masterEnabled = store.control(null).enabled;
    if (masterEnabled && store.baseline() === null) store.baseline(yield* shell.baseline);
    if (masterEnabled) requests.pruneAgreementCandidates(store.prune(now()));
    const catalog = yield* source.catalog();
    scope.rememberScratchProjects(catalog.projects.map(item => item.project));
    if (masterEnabled) yield* prepareStarts;
    const threads = catalog.threads.filter(t => scope.eligible(t, catalog.threads));
    if (masterEnabled) {
      const candidatesNow = yield* Ref.modify(offset, (current) => [[...threads.slice(current), ...threads.slice(0, current)].slice(0, 20), threads.length ? (current + 20) % threads.length : 0] as const);
      const projectsToResolve = catalog.projects.filter(item => item.available && !store.isManual(item.project.id) && !store.autoControlInitialized(item.project.id));
      yield* Effect.forEach(projectsToResolve, item => Effect.exit(resolveControl(item.project.id)), {concurrency: "unbounded", discard: true});
      for (const thread of candidatesNow) {
        const registered = catalog.projects.find(p => p.available && p.project.id === thread.projectId)?.project;if (!registered || !projectEnabled(registered.id, thread.id)) continue;
        if (store.start(thread.id)?.status === "pending") continue;
        const previous = store.task(thread.id);
        // an unresolved request or a temporary not-needed decision is reconsidered when the next genuine human request arrives; an
        // interpreted task is reconsidered only when the latest Enable or activation boundary came after it (checked below); queued
        // or in-flight work is never replaced
        if (previous && !["needs_context", "not_supervised", "unavailable", "expired", "inferred"].includes(previous.status)) continue;
        const examined = Option.getOrUndefined(HashMap.get(yield* Ref.get(examinedNonTasks), thread.id));
        if (typeof thread.latestRunId === "string" && (thread.latestRunId === previous?.sourceRunId ||
          thread.latestRunId === store.baseline()?.threads.find(anchor => anchor.id === thread.id)?.latestRunId ||
          thread.latestRunId === examined)) continue;
        // discovery failures are retried without producing model work
        yield* attempt(discover(thread, registered, previous, catalog));
      }
    }
    const allBindings = store.bindings();
    const bindings = yield* Ref.modify(bindingOffset, (current) => {
      const start = allBindings.length ? current % allBindings.length : 0;
      return [[...allBindings.slice(start), ...allBindings.slice(0, start)], allBindings.length ? (start + 4) % allBindings.length : 0] as const;
    });
    for (let index = 0; index < bindings.length; index += 4) {
      const batch = bindings.slice(index, index + 4);
      if (masterEnabled) yield* Effect.forEach(batch, binding => Effect.exit(resolveControl(binding.projectId)), {concurrency: "unbounded", discard: true});
      // each binding settles on its own: a failed or timed-out binding never affects the others of its batch
      yield* Effect.forEach(batch, binding => Effect.exit(bindingWork(binding, catalog.threads, masterEnabled)), {concurrency: 4, discard: true});
    }
    if (masterEnabled) yield* conversation.observe(catalog.threads);
  });
  const retry = (input: ProjectSupervisorRetryInput): Effect.Effect<ProjectSupervisorSaveOutcome, RetryError> => Effect.gen(function* () {
    if (!store.scopeCompatible) return {status: "unavailable", message: "Supervisor state version is unsupported; no changes were made.", snapshot: null};
    yield* controlFor(input.projectId);
    if (!scope.scopeEnabled(input.projectId, input.mainThreadId, "reconcile")) return {status: "unavailable", message: "Enable global and project supervision before retrying native work.", snapshot: null};
    return yield* locks.withLock(supervisorScopeKey(input.projectId, input.mainThreadId))<ProjectSupervisorSaveOutcome, RetryError, never>(Effect.gen(function* () {
      const {project: registered} = yield* project(input.projectId);
      const settings = store.settings(input.projectId);
      if (!scope.scopeEnabled(input.projectId, input.mainThreadId, "reconcile")) return {status: "unavailable", message: "Enable global and project supervision before retrying native work.", snapshot: null};
      if (settings.generation !== input.expectedGeneration) return {status: "conflict", message: "Settings changed. Refresh before retrying native access.", snapshot: null};
      const binding = store.binding(input.projectId, input.mainThreadId);
      if (!binding || !operate) return {status: "unavailable", message: "No Supervisor conversation is available to reconcile.", snapshot: null};
      if (binding.threadId !== input.threadId || binding.generation !== input.bindingGeneration ||
        (input.action === "replace") !== (binding.state === "missing")) return {status: "conflict", message: "The conversation state changed. Refresh and choose the intended recovery action again.", snapshot: null};
      const main = yield* lifecycle.readMain(binding);
      const unavailableNow = (message: string) => ({status: "unavailable" as const, message, snapshot: null});
      const disabledBeforeReplacement = "Supervision was disabled before replacement; retained work was left unchanged.";
      // the creation reset: the scope recheck and the binding write, inside the section of the caller's preceding block
      const resetCreation = (guard: GateGuard, next: BindingRecord): ProjectSupervisorSaveOutcome | null => {
        if (!guard.scopeEnabled(input.projectId, input.mainThreadId, "interpretation")) return unavailableNow("Supervision was disabled before native creation; retained work was left unchanged.");
        store.setBinding({...next, creationAttempts: 0});
        return null;
      };
      const read = binding;
      // after the main read, the rechecks and the retry bookkeeping of a ready binding, or the creation reset of a creating or
      // uncertain one, run as one admission section
      const decided = yield* gate.admit((guard) => Effect.sync((): {done: ProjectSupervisorSaveOutcome} | {next: "process" | "create" | "missing" | "rejected"} => {
        if (!guard.scopeEnabled(input.projectId, input.mainThreadId, "reconcile")) return {done: unavailableNow("Supervision was disabled before the retry began; retained work was left unchanged.")};
        if (!main || unavailable(main.thread)) return {done: unavailableNow("The main conversation is archived, deleted, or unavailable. Lifecycle handling will park its retained supervision state.")};
        if (read.state === "missing" || read.state === "rejected") return {next: read.state};
        if (read.state !== "ready") {
          const disabled = resetCreation(guard, read);
          return disabled ? {done: disabled} : {next: "create"};
        }
        if (!guard.scopeEnabled(input.projectId, input.mainThreadId, "reconcile")) return {done: unavailableNow("Supervision was disabled before reconciliation; retained work was left unchanged.")};
        conversation.retry(input.projectId, read.threadId);
        store.modelAttempt(read, true);
        if (read.settlement?.state === "uncertain") store.setBinding({...store.binding(read.projectId, read.mainThreadId)!, settlement: {...read.settlement, state: "pending", attempts: 0}});
        const job = store.tasksFor(read).find(task => ["uncertain", "dispatching", "waiting"].includes(task.status));
        if (job) store.saveTask({...job, replayCount: 0, updatedAt: now()});
        return {next: "process"};
      }));
      if ("done" in decided) return decided.done;
      if (decided.next === "process") yield* attempt(processProject(read));
      else {
        if (decided.next === "missing") {
          const existing = yield* attempt(projection(read.threadId));
          if (existing.ok) return unavailableNow("The existing conversation is present; refresh before replacing it.");
          if (!notFound(existing.cause)) return unavailableNow("T3 could not confirm that the conversation is missing.");
          if (!validModelSelection(settings.modelSelection, yield* models)) return {status: "invalid", message: "Choose an available model before replacing a deleted conversation.", snapshot: null};
          if (!projectEnabled(input.projectId, input.mainThreadId)) return unavailableNow(disabledBeforeReplacement);
          const teamRecovery = yield* prepareMissingRootTeam(read);
          // after the team recovery, its checks, the current permission and retained identity, then the replacement with its task
          // closures and the creation reset run as one admission section; every check precedes the first write
          const replaced = yield* gate.admit((guard) => Effect.sync((): ProjectSupervisorSaveOutcome | null => {
            if (teamRecovery === "disabled") return unavailableNow(disabledBeforeReplacement);
            if (teamRecovery === "present_helper") return unavailableNow("A registered helper is still present in T3. The missing root was not replaced; archive or delete the helper, or quarantine and retire it while the root is available, then retry. No helper was treated as missing.");
            if (teamRecovery !== "ready") return unavailableNow("T3 could not verify every registered helper or retire its verified webhook job. The missing root was not replaced; restore native access and retry.");
            const teamSnapshot = team.snapshot(read);
            if (teamSnapshot.assignments.some(assignment => assignment.state === "transferring") || team.unresolvedRequests(read).length)
              return unavailableNow("The Supervisor team still has unresolved handover state or native effects. Their original identities and history remain retained; reconcile them before replacing the root.");
            if (!guard.scopeEnabled(input.projectId, input.mainThreadId, "interpretation")) return unavailableNow(disabledBeforeReplacement);
            const retained = store.binding(input.projectId, input.mainThreadId);
            if (retained?.threadId !== read.threadId || retained.generation !== read.generation || retained.state !== "missing")
              return {status: "conflict", message: "The conversation state changed. Refresh and choose the intended recovery action again.", snapshot: null};
            const replacement = store.replaceMissingBinding(retained, settings.modelSelection);
            for (const job of store.tasksFor(retained)) if (["queued", "dispatching", "waiting", "uncertain"].includes(job.status)) complete(job, "unavailable", null, "The bound Supervisor conversation was deleted; its request identity remains retained.");
            store.setBinding({...replacement, creationAttempts: 0});
            return null;
          }));
          if (replaced) return replaced;
        } else if (decided.next === "rejected") {
          const existing = yield* attempt(projection(read.threadId));
          if (!existing.ok) {
            if (!notFound(existing.cause)) return unavailableNow("T3 could not confirm the rejected creation's state.");
            if (!validModelSelection(settings.modelSelection, yield* models)) return {status: "invalid", message: "Choose an available model before retrying rejected creation.", snapshot: null};
          }
          // after the creation readback (and the model read), the rechecks, the next generation and the creation reset run as one admission section
          const reset = yield* gate.admit((guard) => Effect.sync((): ProjectSupervisorSaveOutcome | null => {
            if (existing.ok) return resetCreation(guard, read);
            if (!guard.scopeEnabled(input.projectId, input.mainThreadId, "interpretation")) return unavailableNow(disabledBeforeReplacement);
            return resetCreation(guard, {...read, generation: read.generation + 1, initialModel: settings.modelSelection, state: "creating"});
          }));
          if (reset) return reset;
        }
        yield* attempt(ensureBinding(input.projectId, input.mainThreadId, registered.title));
      }
      const refreshed = yield* snapshot(input.projectId, input.mainThreadId);
      return {status: refreshed.binding?.state === "ready" && !refreshed.tasks.some(task => task.status === "uncertain") && refreshed.monitoringStatus?.state !== "uncertain" ? "saved" : "uncertain", message: "Native access retried with the retained identity. Inspect the current conversation and task status.", snapshot: refreshed};
    }));
  });
  const service = ProjectSupervisor.of({
    cycle,
    noProjectControl,
    workflowLocator,
    scopeSnapshot,
    control: controlFor,
    globalDefinitionsControl,
    setupOptions,
    candidates,
    overview,
    snapshot,
    saveNoProjectControl,
    saveGlobalDefinitionsControl,
    setup,
    saveControl,
    save,
    setChatSupervision,
    retry,
  });
  return {service, seams: {ensureBinding, dispatch: (job: TaskRecord) => dispatch(job, null)} satisfies ProjectSupervisorSeams};
});

type LaunchOutcome = {readonly _tag: "Ready"; readonly binding: BindingRecord} | {readonly _tag: "MainUnavailable"} | {readonly _tag: "Uncertain"};

// the project supervisor over the interim stores, the scope predicates, the admission section, the per-scope locks, the catalog,
// the native clients, the conversation, lifecycle, Start/Stop control, helper transport, team runtime and team controller
export class ProjectSupervisor extends Context.Service<ProjectSupervisor, ProjectSupervisorShape>()("t3-supervisor/ProjectSupervisor") {
  static readonly make = (options: ProjectSupervisorOptions = {}) => Effect.map(makeProjectSupervisor(options), (unit) => unit.service);
  // the service with its test seams
  static readonly makeUnit = makeProjectSupervisor;
  static readonly layer = (options: ProjectSupervisorOptions = {}) => Layer.effect(ProjectSupervisor, ProjectSupervisor.make(options));
}
