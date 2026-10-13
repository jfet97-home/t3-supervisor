import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { fingerprint } from "./guidance-store.js";
import { mainRunNodeReader, timestampMs } from "./domain.js";
import { currentThreadPolicy } from "./thread-policy.js";
import { ProjectSupervisorStore, isSupervisorThread, type BindingRecord, type TaskRecord, type SupervisorBaseline } from "./project-supervisor-store.js";
import { modelSelection, sameModel, supervisorModels, validModelSelection, SupervisorRpcError, type SupervisorRpc } from "./supervisor-native.js";
import type { ProjectSupervisorInfo, ProjectSupervisorSaveInput, ProjectSupervisorSaveOutcome, ProjectSupervisorRetryInput, SupervisorModelSelection, WorkflowProposalInfo } from "./project-supervisor-contract.js";
import { interpretationPrompt, parseInterpretation, prepareWorkflowRequest, parseWorkflowInterpretation } from "./supervisor-workflow.js";
import type { ProjectDefinitionLoader } from "./project-definitions.js";
export { interpretationPrompt, parseInterpretation } from "./supervisor-workflow.js";
import type { StoreShape } from "./store.js";
import { T3TransportError, type T3ClientShape } from "./t3.js";
import type { MessageInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "./types.js";

const active = (projection: Projection) => projection.runs.some(r => ["preparing","queued","starting","running","waiting"].includes(r.status));
const unavailable = (thread: ThreadInfo) => Boolean(thread.archivedAt || thread.deletedAt || thread.settledAt);
const supervisorUnavailable = (thread: ThreadInfo) => Boolean(thread.archivedAt || thread.deletedAt);

export const taskSource = (projection: Projection, afterOrdinal: number): {run: RunInfo; message: MessageInfo} | null => {
  for (const run of [...projection.runs].sort((a,b) => a.ordinal - b.ordinal)) {
    if (run.ordinal <= afterOrdinal || !run.rootNodeId || run.threadId !== projection.thread.id || typeof run.userMessageId !== "string") continue;
    const message = projection.messages.find(m => m.id === run.userMessageId && m.threadId === projection.thread.id && m.runId === run.id &&
      m.role === "user" && m.createdBy === "user" && m.streaming === false && !m.id.startsWith("supervisor-notice:") && (m.creationSource === "web" || m.creationSource === "mobile") &&
      !m.senderThreadId && !m.scheduledTaskId && !m.source);
    if (message && message.text.trim() && message.nodeId && mainRunNodeReader(projection, run)(message.nodeId)) return {run, message};
  }
  return null;
};

/** Coordinates ordinary T3 conversations; provider execution remains entirely in T3. */
export class ProjectSupervisor {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly examinedNonTasks = new Map<string, string>();
  private offset = 0;
  constructor(readonly config: SupervisorConfig, readonly store: ProjectSupervisorStore, readonly source: Pick<StoreShape, "catalog">,
    readonly t3: Pick<T3ClientShape, "projection">, readonly readRpc: SupervisorRpc, readonly operateRpc: SupervisorRpc | null,
    readonly activationSnapshot: (signal: AbortSignal) => Promise<SupervisorBaseline>,
    readonly definitions?: Pick<ProjectDefinitionLoader, "load">) {}
  private async serial<A>(projectId: string, work: () => Promise<A>): Promise<A> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);this.queues.set(projectId, next);
    try {return await next;} finally {if (this.queues.get(projectId) === next) this.queues.delete(projectId);}
  }
  private async project(projectId: string) {
    const catalog = await Effect.runPromise(this.source.catalog());
    const project = catalog.projects.find(p => p.project.id === projectId && p.available)?.project;
    if (!project) throw new Error("project_unavailable");return {project, catalog};
  }
  private async projection(threadId: string, signal: AbortSignal): Promise<Projection> {return (await Effect.runPromise(this.t3.projection(threadId), {signal})).projection;}
  private async models(signal: AbortSignal) {return supervisorModels(await this.readRpc("server.getConfig", {}, signal));}
  async snapshot(projectId: string, signal: AbortSignal): Promise<ProjectSupervisorInfo> {
    await this.project(projectId);
    const binding = this.store.binding(projectId);
    let selection: SupervisorModelSelection | null = null;let available = Boolean(this.operateRpc);let message = binding ? "Supervisor conversation is being prepared." : "The Supervisor conversation will be created automatically for the first new task.";
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
        message = available && selection && validModelSelection(selection, models) ? "T3 runs this project's Supervisor. New tasks can receive draft workflows from project rules and blocks; dialogue with the operational agent is not connected yet." : "The configured Supervisor model is unavailable in T3. Choose an available model; no fallback model will run.";
      }
      }
      }
      if (!this.operateRpc) message = "Project supervision needs a dedicated T3 read/operate credential through deployment setup.";
    } catch {available = false;message = "T3 Supervisor access is unavailable. Existing settings and conversation identity are retained.";}
    const current = this.store.settings(projectId);
    if (this.store.baseline() === null) message = "Native task discovery is initializing; interpretation is not active yet. " + message;
    if (current.applicationMessage) message = `${message} ${current.applicationMessage}`;
    if (current.pending && models.length && !validModelSelection(current.modelSelection, models)) message = "The saved Supervisor model is unavailable. Choose an available T3 model; no fallback will run.";
    if (binding?.state === "rejected" && binding.creationMessage) message = binding.creationMessage;
    if (!binding && models.length && !validModelSelection(current.modelSelection, models)) message = "Default Supervisor model unavailable. Choose an available T3 model; no fallback will run.";
    return {projectId, settings: {generation: current.generation, modelSelection: current.modelSelection, pending: current.pending}, binding: this.store.binding(projectId), modelSelection: selection, models, available, message,
      tasks: this.store.tasks(projectId).slice(-200).reverse().map(({threadId,projectId,sourceRunId,sourceMessageId,status,objective,reason,updatedAt,workflow}) => ({threadId,projectId,sourceRunId,sourceMessageId,status,objective,reason,updatedAt,workflow: workflow ?? null}))};
  }
  async save(input: ProjectSupervisorSaveInput, signal: AbortSignal): Promise<ProjectSupervisorSaveOutcome> {
    return this.serial(input.projectId, async () => {
      await this.project(input.projectId);
      if (!validModelSelection(input.modelSelection, await this.models(signal))) return {status: "invalid", message: "Choose an available T3 model and its advertised reasoning options.", snapshot: null};
      try {this.store.saveSettings(input.projectId, input.expectedGeneration, input.modelSelection);}
      catch {return {status: "conflict", message: "Project Supervisor settings changed. Refresh before saving again.", snapshot: null};}
      return {status: "saved", message: "Saved. The service creates the Supervisor conversation automatically when needed and applies model changes between tasks.", snapshot: await this.snapshot(input.projectId, signal)};
    });
  }
  async retry(input: ProjectSupervisorRetryInput, signal: AbortSignal): Promise<ProjectSupervisorSaveOutcome> {
    return this.serial(input.projectId, async () => {
      const {project} = await this.project(input.projectId);
      const settings = this.store.settings(input.projectId);
      if (settings.generation !== input.expectedGeneration) return {status: "conflict", message: "Settings changed. Refresh before retrying native access.", snapshot: null};
      let binding = this.store.binding(input.projectId);
      if (!binding || !this.operateRpc) return {status: "unavailable", message: "No Supervisor conversation is available to reconcile.", snapshot: null};
      if (binding.threadId !== input.threadId || binding.generation !== input.bindingGeneration ||
        (input.action === "replace") !== (binding.state === "missing")) return {status: "conflict", message: "The conversation state changed. Refresh and choose the intended recovery action again.", snapshot: null};
      if (binding.state !== "ready") {
        if (binding.state === "missing") {
          try {await this.projection(binding.threadId, signal);return {status: "unavailable", message: "The existing conversation is present; refresh before replacing it.", snapshot: null};}
          catch (cause) {if (!(cause instanceof T3TransportError) || cause.httpStatus !== 404) return {status: "unavailable", message: "T3 could not confirm that the conversation is missing.", snapshot: null};}
          if (!validModelSelection(settings.modelSelection, await this.models(signal))) return {status: "invalid", message: "Choose an available model before replacing a deleted conversation.", snapshot: null};
          binding = this.store.replaceMissingBinding(binding, settings.modelSelection);
          for (const job of this.store.tasks(input.projectId)) if (["queued", "dispatching", "waiting", "uncertain"].includes(job.status)) this.complete(job, "unavailable", null, "The bound Supervisor conversation was deleted; its request identity remains retained.");
        }
        if (binding.state === "rejected") {
          try {
            await this.projection(binding.threadId, signal);
          } catch (cause) {
            if (!(cause instanceof T3TransportError) || cause.httpStatus !== 404) return {status: "unavailable", message: "T3 could not confirm the rejected creation's state.", snapshot: null};
            if (!validModelSelection(settings.modelSelection, await this.models(signal))) return {status: "invalid", message: "Choose an available model before retrying rejected creation.", snapshot: null};
            binding = {...binding, generation: binding.generation + 1, initialModel: settings.modelSelection, state: "creating"};
          }
        }
        this.store.setBinding({...binding, creationAttempts: 0});
        await this.ensureBinding(input.projectId, project.title, signal).catch(() => undefined);
      } else {
        this.store.modelAttempt(input.projectId, true);
        const job = this.store.tasks(input.projectId).find(task => ["uncertain", "dispatching", "waiting"].includes(task.status));
        if (job) this.store.saveTask({...job, replayCount: 0, updatedAt: Date.now()});
        await this.processProject(binding, signal).catch(() => undefined);
      }
      const snapshot = await this.snapshot(input.projectId, signal);
      return {status: snapshot.binding?.state === "ready" && !snapshot.tasks.some(task => task.status === "uncertain") ? "saved" : "uncertain", message: "Native access retried with the retained identity. Inspect the current conversation and task status.", snapshot};
    });
  }
  private async ensureBinding(projectId: string, title: string, signal: AbortSignal): Promise<BindingRecord> {
    if (!this.operateRpc) throw new Error("supervisor_credential_missing");
    const settings = this.store.settings(projectId);
    let binding = this.store.binding(projectId) ?? this.store.reserve(projectId, title, settings.modelSelection, this.store.activation()!, Date.now());
    let existing: Projection | null;
    try {existing = await this.projection(binding.threadId, signal);}
    catch (cause) {
      if (!(cause instanceof T3TransportError) || cause.httpStatus !== 404) throw new Error("supervisor_read_unavailable");
      existing = null;
    }
    if (existing) {
      if (existing.thread.projectId !== projectId || supervisorUnavailable(existing.thread)) throw new Error("invalid_supervisor_binding");
      const ready = {...binding, state: "ready" as const};this.store.setBinding(ready);return ready;
    } else {
      if (binding.state === "ready" || binding.state === "missing") {this.store.setBinding({...binding, state: "missing"});throw new Error("supervisor_missing");}
      // replay uses the exact durable reservation, never a new thread identity
      if (binding.state === "rejected" || (binding.creationAttempts ?? 0) >= 3) throw new Error("supervisor_creation_needs_retry");
      binding = {...binding, creationAttempts: (binding.creationAttempts ?? 0) + 1};this.store.setBinding(binding);
      try {
        await this.operateRpc("orchestration.launchThread", {commandId: `supervisor-create:${binding.threadId}:${binding.generation}`, threadId: binding.threadId,
          creationSource: "server", projectId, title: binding.title, generateTitle: false, modelSelection: binding.initialModel,
          runtimeMode: "approval-required", interactionMode: "plan", workspaceStrategy: {type: "root"}}, signal);
        const projection = await this.projection(binding.threadId, signal);
        if (projection.thread.projectId !== projectId || supervisorUnavailable(projection.thread)) throw new Error("invalid_supervisor_binding");
        const ready = {...binding, state: "ready" as const};this.store.setBinding(ready);return ready;
      } catch (cause) {this.store.setBinding({...binding, state: cause instanceof SupervisorRpcError && cause.definiteRejection ? "rejected" : "uncertain",
        creationMessage: cause instanceof SupervisorRpcError && cause.providerDisabled ? "The Supervisor provider is disabled for this project in T3. Save another model or enable the provider, then retry native access." : "Conversation creation could not be confirmed. Retry native access to inspect its retained identity."});throw new Error("supervisor_creation_uncertain");}
    }
  }
  private async applyModel(binding: BindingRecord, projection: Projection, signal: AbortSignal): Promise<void> {
    const settings = this.store.settings(binding.projectId);const current = modelSelection(projection.thread.modelSelection);
    if (!current) throw new Error("supervisor_model_missing");
    if (settings.pending && !active(projection)) {
      if (!validModelSelection(settings.modelSelection, await this.models(signal))) throw new Error("supervisor_model_unavailable");
      if ((settings.applyAttempts ?? 0) >= 3) return;
      this.store.modelAttempt(binding.projectId);
      try {
        await this.operateRpc!("orchestration.dispatchCommand", {type: "thread.model-selection.set", commandId: `supervisor-model:${binding.threadId}:${settings.generation}`, threadId: binding.threadId, modelSelection: settings.modelSelection}, signal);
      } catch (cause) {
        if (!(cause instanceof SupervisorRpcError) || !cause.definiteRejection) throw cause;
        const result = modelSelection((await this.projection(binding.threadId, signal)).thread.modelSelection);
        if (!result) throw new Error("model_change_uncertain");
        this.store.observeModel(binding.projectId, result, settings.generation, "T3 rejected the saved model update. Its current model is authoritative; inspect it before another change.");return;
      }
      const result = modelSelection((await this.projection(binding.threadId, signal)).thread.modelSelection);
      if (!result) throw new Error("model_change_uncertain");
      this.store.observeModel(binding.projectId, result, settings.generation, sameModel(result, settings.modelSelection) ? null : "T3 reports a different model; the saved selection was not applied. Its observed selection is authoritative.");
    } else if (!settings.pending) this.store.observeModel(binding.projectId, current);
  }
  private eligible(thread: ThreadInfo, threads: readonly ThreadInfo[]): boolean {
    if (isSupervisorThread(this.config, thread) || unavailable(thread) || thread.lineage.relationshipToParent === "subagent" || currentThreadPolicy(this.config).excludedThreadIds.includes(thread.id)) return false;
    let parent = thread.lineage.parentThreadId;let depth = 0;
    while (parent) {const ancestor = threads.find(t => t.id === parent);if (!ancestor || ++depth > 64 || isSupervisorThread(this.config, ancestor)) return false;parent = ancestor.lineage.parentThreadId;}
    return true;
  }
  async runOnce(signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<void> {
    if (!this.operateRpc) return;
    if (this.store.baseline() === null) this.store.baseline(await this.activationSnapshot(signal));
    this.store.prune(Date.now());
    const catalog = await Effect.runPromise(this.source.catalog());
    const threads = catalog.threads.filter(t => this.eligible(t, catalog.threads));
    const candidates = [...threads.slice(this.offset), ...threads.slice(0,this.offset)].slice(0,20);this.offset = threads.length ? (this.offset + 20) % threads.length : 0;
    for (const thread of candidates) {
      if (signal.aborted) return;
      const project = catalog.projects.find(p => p.available && p.project.id === thread.projectId)?.project;if (!project) continue;
      const previous = this.store.task(thread.id);
      if (previous && !["needs_context", "unavailable"].includes(previous.status)) continue;
      if (typeof thread.latestRunId === "string" && (thread.latestRunId === previous?.sourceRunId ||
        thread.latestRunId === this.store.baseline()?.threads.find(anchor => anchor.id === thread.id)?.latestRunId ||
        thread.latestRunId === this.examinedNonTasks.get(thread.id))) continue;
      try {
        const projection = await this.projection(thread.id, signal);
        if (!this.eligible(projection.thread, catalog.threads) || projection.thread.projectId !== project.id) continue;
        const baseline = this.store.baselineOrdinal(thread.id, projection);if (baseline === null) continue;
        const task = taskSource(projection, Math.max(baseline, previous?.sourceOrdinal ?? 0));
        if (!task) {
          if (!active(projection) && typeof thread.latestRunId === "string") {
            if (this.examinedNonTasks.size >= 10_000) this.examinedNonTasks.clear();
            this.examinedNonTasks.set(thread.id, thread.latestRunId);
          }
          continue;
        }
        if (!validModelSelection(this.store.settings(project.id).modelSelection, await this.models(signal))) continue;
        const binding = await this.serial(project.id, () => this.ensureBinding(project.id, project.title, signal));
        const id = randomUUID();const oversized = task.message.text.length > 24_000;
        this.store.saveTask({id, threadId: thread.id, projectId: project.id, sourceRunId: task.run.id, sourceMessageId: task.message.id,
          sourceOrdinal: task.run.ordinal, sourceHash: fingerprint(task.message.text), status: oversized ? "needs_context" : "queued", objective: null,
          reason: oversized ? "The task message exceeds the interpretation limit; provide a shorter task." : "Waiting for the project Supervisor.",
          updatedAt: Date.now(), requestText: oversized ? "" : interpretationPrompt(thread.id, task.message.id, task.message.text), supervisorThreadId: binding.threadId,
          messageId: `supervisor-objective:${id}`, supervisorRunId: null, dispatchedAt: null, replayCount: 0});
      } catch { /* Discovery failures are retried without producing model work. */ }
    }
    for (const binding of this.store.bindings()) {
      if (signal.aborted) return;
      await this.serial(binding.projectId, () => this.processProject(binding, signal)).catch(() => undefined);
    }
  }
  private async processProject(binding: BindingRecord, signal: AbortSignal): Promise<void> {
    const currentBinding = this.store.binding(binding.projectId);
    if (!currentBinding) return;
    binding = currentBinding;
    await this.project(binding.projectId);
    let projection: Projection;
    try {projection = await this.projection(binding.threadId, signal);}
    catch (cause) {if (cause instanceof T3TransportError && cause.httpStatus === 404 && binding.state === "ready") this.store.setBinding({...binding, state: "missing"});throw cause;}
    if (projection.thread.projectId !== binding.projectId || supervisorUnavailable(projection.thread)) return;
    if (binding.state !== "ready") this.store.setBinding({...binding, state: "ready"});
    const jobs = this.store.tasks(binding.projectId);
    const inflight = jobs.find(t => ["dispatching","waiting","uncertain"].includes(t.status));
    if (inflight) {await this.reconcile(inflight, projection, signal);return;}
    if (active(projection)) return;
    await this.applyModel(binding, projection, signal);
    if (this.store.settings(binding.projectId).pending) return;
    let job = jobs.find(t => t.status === "queued");if (!job) return;
    const source = await this.projection(job.threadId, signal);
    if (!this.currentSource(job, source)) {this.complete(job, "unavailable", null, "The task source changed or became unavailable.");return;}
    if (this.definitions && job.definitionContext === undefined) {
      try {
        const definitions = await this.definitions.load(job.projectId, job.threadId, signal);
        if (definitions.projectId !== job.projectId || definitions.threadId !== job.threadId) throw new Error("definition_binding_mismatch");
        if (definitions.status === "unavailable") {
          job = {...job, definitionReadAttempts: (job.definitionReadAttempts ?? 0) + 1};
          if (job.definitionReadAttempts! < 3) {this.store.saveTask({...job, reason: "Project definitions are temporarily unavailable; workflow preparation will retry with a bounded budget.", updatedAt: Date.now()});return;}
        }
        const task = taskSource(source, job.sourceOrdinal - 1)!;
        const prepared = prepareWorkflowRequest(job.threadId, job.sourceMessageId, task.message.text, definitions);
        job = {...job, requestText: prepared.requestText, definitionContext: prepared.context, workflow: prepared.workflow};
      } catch {
        job = {...job, definitionReadAttempts: (job.definitionReadAttempts ?? 0) + 1};
        if (job.definitionReadAttempts! < 3) {this.store.saveTask({...job, reason: "Project definitions could not be read; workflow preparation will retry with a bounded budget.", updatedAt: Date.now()});return;}
        job = {...job, definitionContext: null, workflow: {status: "unavailable", message: "Workflow proposal unavailable: project definitions could not be read.", workspaceRoot: null, revision: null, rules: [], steps: []}};
      }
      this.store.saveTask(job);
      if (!this.currentSource(job, await this.projection(job.threadId, signal))) {this.complete(job, "unavailable", null, "The task source changed while project definitions were being loaded.");return;}
    }
    const current = modelSelection((await this.projection(binding.threadId, signal)).thread.modelSelection);
    if (!current || !validModelSelection(current, await this.models(signal))) return;
    const sending: TaskRecord = {...job, status: "dispatching", dispatchedAt: Date.now(), updatedAt: Date.now()};this.store.saveTask(sending);
    await this.dispatch(sending, signal);
  }
  private async dispatch(job: TaskRecord, signal: AbortSignal): Promise<void> {
    try {
      await this.operateRpc!("orchestration.dispatchCommand", {type: "message.dispatch", createdBy: "system", creationSource: "server", commandId: `supervisor-objective:${job.id}`,
        threadId: job.supervisorThreadId, messageId: job.messageId, text: job.requestText, attachments: [], dispatchMode: {type: "start_immediately"}}, signal);
      this.store.saveTask({...job, status: "waiting", reason: "T3 accepted the interpretation request; waiting for its result.", updatedAt: Date.now()});
    } catch (cause) {
      if (cause instanceof SupervisorRpcError && cause.definiteRejection) this.complete(job, "unavailable", null, cause.providerDisabled ? "The Supervisor provider is disabled for this project in T3. Choose another model or enable the provider; other tasks can continue." : "T3 definitively rejected the interpretation request. Other tasks can continue.");
      else this.store.saveTask({...job, status: "uncertain", reason: "Interpretation dispatch is uncertain; retry native access to reconcile the original request identity.", updatedAt: Date.now()});
    }
  }
  private currentSource(job: TaskRecord, projection: Projection): boolean {
    const current = taskSource(projection, job.sourceOrdinal - 1);
    const message = current?.run.id === job.sourceRunId ? current.message : null;
    return projection.thread.id === job.threadId && projection.thread.projectId === job.projectId && !unavailable(projection.thread) &&
      !isSupervisorThread(this.config, projection.thread) && !currentThreadPolicy(this.config).excludedThreadIds.includes(job.threadId) &&
      Boolean(message && fingerprint(message.text) === job.sourceHash) && this.store.binding(job.projectId)?.threadId === job.supervisorThreadId;
  }
  private complete(job: TaskRecord, status: TaskRecord["status"], objective: string | null, reason: string): void {
    const workflow = job.workflow?.status === "pending" ? {...job.workflow, status: "unavailable" as const, message: reason, rules: [], steps: []} : job.workflow;
    this.store.saveTask({...job, status, objective, reason, workflow: workflow ?? null, requestText: "", updatedAt: Date.now()});
  }
  private async reconcile(job: TaskRecord, projection: Projection, signal: AbortSignal): Promise<void> {
    const message = projection.messages.find(m => m.id === job.messageId && m.threadId === job.supervisorThreadId && m.text === job.requestText);
    const run = message ? projection.runs.find(r => r.userMessageId === job.messageId && r.threadId === job.supervisorThreadId && r.id === message.runId) : undefined;
    if (!run) {
      if (!active(projection) && job.replayCount < 2) {const replay = {...job, replayCount: job.replayCount + 1};this.store.saveTask(replay);await this.dispatch(replay, signal);}
      if (job.replayCount >= 2 && job.status !== "uncertain") this.store.saveTask({...job, status: "uncertain", reason: "The accepted request has no matching native run. Retry native access to reconcile its retained identity.", updatedAt: Date.now()});
      return;
    }
    if (job.supervisorRunId !== run.id) {job = {...job, supervisorRunId: run.id};this.store.saveTask(job);}
    if (run.status !== "completed") {
      if (["failed","interrupted","cancelled","rolled_back"].includes(run.status)) this.complete(job, "unavailable", null, "The interpretation run did not complete successfully.");
      else if (Date.now() - (job.dispatchedAt ?? Date.now()) > 300_000) this.complete(job, "unavailable", null, "The interpretation timed out or requires input. The service does not answer or interrupt Supervisor runs.");
      return;
    }
    if (!this.currentSource(job, await this.projection(job.threadId, signal))) {this.complete(job, "unavailable", null, "The task source changed before the interpretation completed.");return;}
    const nodeFor = mainRunNodeReader(projection, run);
    const answers = projection.messages.filter(m => m.threadId === job.supervisorThreadId && m.runId === run.id && m.role === "assistant" && !m.streaming && m.nodeId && nodeFor(m.nodeId)?.kind === "assistant_message")
      .sort((a,b) => (timestampMs(a.createdAt) ?? 0) - (timestampMs(b.createdAt) ?? 0));
    try {
      const result: {objective: string | null; reason: string; workflow?: WorkflowProposalInfo} = job.definitionContext ? parseWorkflowInterpretation(answers.at(-1)?.text ?? "", job.sourceMessageId, job.definitionContext) : parseInterpretation(answers.at(-1)?.text ?? "", job.sourceMessageId);
      if (result.workflow) {
        let currentDefinitions = false;
        let transientReadFailure = false;
        try {
          const definitions = await this.definitions?.load(job.projectId, job.threadId, signal);
          transientReadFailure = !definitions || definitions.status === "unavailable";
          currentDefinitions = definitions?.status === "ready" && definitions.projectId === job.projectId && definitions.threadId === job.threadId &&
            definitions.revision === job.definitionContext!.revision && definitions.workspaceRoot === job.definitionContext!.workspaceRoot;
        } catch {transientReadFailure = true;}
        if (transientReadFailure) {
          job = {...job, revalidationAttempts: (job.revalidationAttempts ?? 0) + 1};
          if (job.revalidationAttempts! < 3) {this.store.saveTask({...job, reason: "The model completed; project definition revalidation will retry with a bounded budget.", updatedAt: Date.now()});return;}
        }
        job = {...job, workflow: currentDefinitions ? result.workflow : {...result.workflow, status: "stale", message: "Project definitions changed or could not be revalidated; this workflow proposal was not accepted.", rules: [], steps: []}};
        if (!this.currentSource(job, await this.projection(job.threadId, signal))) {this.complete({...job, workflow: {...job.workflow!, status: "stale", steps: [], rules: []}}, "unavailable", null, "The task source changed while the workflow was being revalidated.");return;}
      }
      this.complete(job, result.objective === null ? "needs_context" : "inferred", result.objective, result.reason);
    }
    catch {this.complete(job, "unavailable", null, "The Supervisor did not return a valid, source-linked interpretation.");}
  }
}
