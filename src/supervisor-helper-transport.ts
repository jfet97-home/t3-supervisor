import {workflowRequestHash} from "./workflow-write-evidence.js";
import {record, type SupervisorRpc} from "./supervisor-native.js";
import type {BindingRecord, ProjectSupervisorStore} from "./project-supervisor-store.js";
import type {MessageInfo, Projection} from "./types.js";

export type SupervisorHelperMessage = {threadId: string; commandId: string; messageId: string; text: string};
// "revoked": the caller's authority ended after this method's reads and before any receipt or POST
export type SupervisorHelperSendResult = "waiting" | "busy" | "uncertain" | "rejected" | "revoked";
type Channel = {taskId: string; helperThreadId: string; createdAt: string | null; state: "creating" | "ready" | "retiring" | "retired"};
// renderedText is the prompt T3 rendered for this exact accepted delivery (published builds wrap the body as
// untrusted webhook data); it is bound once from validated native delivery detail and never replaces the sent text
type Delivery = SupervisorHelperMessage & {hash: string; taskId: string; state: "posting" | "posted" | "rejected"; nativeDeliveryId?: string;
  renderedText?: string};
const promptTemplate = "{{body.text}}";
const MAX_WEBHOOK_DELIVERY_DETAILS = 5;
const rejectedWebhookOutcomes = new Set(["dispatch_failed", "rejected_signature", "disabled", "rate_limited", "expired"]);
const preRenderRejectionOutcomes = new Set(["rejected_signature", "disabled", "rate_limited", "expired"]);
const MAX_RENDERED_PROMPT_LENGTH = 400_000;
// the native user message an attempt produces: its proven rendered prompt, or the sent text while none is bound
export const nativeMessageText = (delivery: {text: string; renderedText?: unknown}): string =>
  typeof delivery.renderedText === "string" ? delivery.renderedText : delivery.text;
const renderedPromptOf = (detail: Record<string, unknown>): string | null =>
  typeof detail.renderedPrompt === "string" && detail.renderedPrompt.length > 0 && detail.renderedPrompt.length <= MAX_RENDERED_PROMPT_LENGTH
    ? detail.renderedPrompt : null;

/** Uses a genuine native webhook task, without timers or repeated tasks on the root. */
export class SupervisorHelperTransport {
  constructor(readonly options: {store: ProjectSupervisorStore; rpc: SupervisorRpc | null; baseUrl: string;
    projection(threadId: string, signal: AbortSignal): Promise<Projection>;
    fetch?: typeof fetch}) {
    options.store.store.db.exec(`CREATE TABLE IF NOT EXISTS supervisor_helper_channels(
      owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,helper_thread_id TEXT NOT NULL,document TEXT NOT NULL,
      PRIMARY KEY(owner_thread_id,owner_generation,helper_thread_id));
      CREATE TABLE IF NOT EXISTS supervisor_helper_deliveries(
      owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,message_id TEXT NOT NULL,document TEXT NOT NULL,
      PRIMARY KEY(owner_thread_id,owner_generation,message_id));`);
  }
  private channel(binding: BindingRecord, helperThreadId: string): Channel | null {
    const row = this.options.store.store.db.prepare("SELECT document FROM supervisor_helper_channels WHERE owner_thread_id=? AND owner_generation=? AND helper_thread_id=?")
      .get(binding.threadId, binding.generation, helperThreadId);
    return row ? JSON.parse(String(row.document)) as Channel : null;
  }
  private saveChannel(binding: BindingRecord, channel: Channel): void {
    this.options.store.store.db.prepare("INSERT INTO supervisor_helper_channels VALUES(?,?,?,?) ON CONFLICT(owner_thread_id,owner_generation,helper_thread_id) DO UPDATE SET document=excluded.document")
      .run(binding.threadId, binding.generation, channel.helperThreadId, JSON.stringify(channel));
  }
  private save(binding: BindingRecord, value: Delivery): void {
    this.options.store.store.db.prepare("INSERT INTO supervisor_helper_deliveries VALUES(?,?,?,?) ON CONFLICT(owner_thread_id,owner_generation,message_id) DO UPDATE SET document=excluded.document")
      .run(binding.threadId, binding.generation, value.messageId, JSON.stringify(value));
  }
  hasDelivery(binding: BindingRecord, input: SupervisorHelperMessage): boolean {
    const row = this.options.store.store.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
      .get(binding.threadId, binding.generation, input.messageId);
    if (!row) return false;
    const delivery = JSON.parse(String(row.document)) as Delivery;
    return delivery.hash === workflowRequestHash(input);
  }
  // the exact bytes an existing attempt sent; they, not regenerated text, identify that attempt from then on
  receiptText(binding: BindingRecord, logicalMessageId: string): string | null {
    const row = this.options.store.store.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
      .get(binding.threadId, binding.generation, logicalMessageId);
    return row ? (JSON.parse(String(row.document)) as Delivery).text : null;
  }
  matchesMessage(binding: BindingRecord, logicalMessageId: string, text: string, message: MessageInfo): boolean {
    const row = this.options.store.store.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
      .get(binding.threadId, binding.generation, logicalMessageId);
    if (!row) return false;
    const delivery = JSON.parse(String(row.document)) as Delivery;
    return delivery.state !== "rejected" && delivery.text === text && message.threadId === delivery.threadId &&
      message.scheduledTaskId === delivery.taskId && message.text === nativeMessageText(delivery) && message.creationSource === "server";
  }
  private async tasks(signal: AbortSignal): Promise<Record<string, unknown>[]> {
    const result = await this.options.rpc!("scheduledTasks.list", {}, signal);
    if (!record(result) || !Array.isArray(result.tasks) || !result.tasks.every(record)) throw new Error("native_helper_channels_unavailable");
    return result.tasks;
  }
  // native delivery detail is evidence for this attempt only when it reproduces the exact durable request: same
  // delivery and task, POST JSON, the exact untruncated body and byte count, and no missing template fields.
  private exactDetail(delivery: Delivery, detail: unknown, deliveryId: string, summary: Record<string, unknown>): Record<string, unknown> | null {
    const expectedBody = JSON.stringify({batchId: delivery.messageId, text: delivery.text});
    if (!record(detail) || detail.id !== deliveryId || detail.taskId !== delivery.taskId || detail.receivedAt !== summary.receivedAt ||
      detail.method !== "POST" || summary.method !== "POST" || detail.contentType !== "application/json" || summary.contentType !== "application/json" ||
      detail.bodyBytes !== new TextEncoder().encode(expectedBody).length || detail.bodyBytes !== summary.bodyBytes ||
      detail.outcome !== summary.outcome || typeof detail.outcome !== "string" || detail.bodyTruncated !== false || detail.body !== expectedBody ||
      !Array.isArray(detail.missingFields) || detail.missingFields.length !== 0) return null;
    return detail;
  }
  private async resolveWebhookDelivery(delivery: Delivery, signal: AbortSignal): Promise<{id: string; outcome: string; renderedPrompt?: string} | null> {
    const result = await this.options.rpc!("scheduledTasks.listWebhookDeliveries", {id: delivery.taskId}, signal);
    if (!record(result) || !Array.isArray(result.deliveries) || !result.deliveries.every(record)) return null;
    if (delivery.nativeDeliveryId) {
      const nativeDeliveryId = delivery.nativeDeliveryId;
      const summary = result.deliveries.find(item => item.id === nativeDeliveryId && item.taskId === delivery.taskId);
      if (!summary || typeof summary.outcome !== "string") return null;
      const resolved = {id: nativeDeliveryId, outcome: summary.outcome};
      if (delivery.renderedText !== undefined || rejectedWebhookOutcomes.has(summary.outcome)) return resolved;
      // binding the rendered prompt is best effort: unavailable or mismatched detail leaves the attempt unmatched
      try {
        const value = await this.options.rpc!("scheduledTasks.getWebhookDelivery", {id: delivery.taskId, deliveryId: nativeDeliveryId}, signal);
        const detail = record(value) ? this.exactDetail(delivery, value.delivery, nativeDeliveryId, summary) : null;
        const renderedPrompt = detail && renderedPromptOf(detail);
        return renderedPrompt ? {...resolved, renderedPrompt} : resolved;
      } catch {return resolved;}
    }

    const expectedBody = JSON.stringify({batchId: delivery.messageId, text: delivery.text});
    const expectedBodyBytes = new TextEncoder().encode(expectedBody).length;
    const candidates = result.deliveries.filter(item => item.taskId === delivery.taskId && item.method === "POST" &&
      item.contentType === "application/json" && item.bodyBytes === expectedBodyBytes && typeof item.id === "string");
    if (candidates.length === 0 || candidates.length > MAX_WEBHOOK_DELIVERY_DETAILS) return null;

    const bodyMatches: Array<{detail: Record<string, unknown>; outcome: string}> = [];
    for (const summary of candidates) {
      const value = await this.options.rpc!("scheduledTasks.getWebhookDelivery", {id: delivery.taskId, deliveryId: summary.id}, signal);
      if (!record(value) || !record(value.delivery)) return null;
      const detail = value.delivery;
      if (detail.id !== summary.id || detail.taskId !== delivery.taskId || detail.receivedAt !== summary.receivedAt ||
        detail.method !== summary.method || detail.contentType !== summary.contentType || detail.bodyBytes !== summary.bodyBytes ||
        detail.outcome !== summary.outcome || typeof detail.body !== "string") return null;
      if (detail.bodyTruncated !== false) return null;
      if (detail.body === expectedBody && typeof detail.outcome === "string") bodyMatches.push({detail, outcome: detail.outcome});
    }
    if (bodyMatches.length !== 1) return null;
    const {detail, outcome} = bodyMatches[0]!;
    if (!Array.isArray(detail.missingFields) || detail.missingFields.length !== 0) return null;
    // the exact body identifies the attempt; its rendered prompt is bound as the native message expectation
    const renderedPrompt = renderedPromptOf(detail);
    const preRenderRejection = preRenderRejectionOutcomes.has(outcome) && detail.renderedPrompt === null;
    if (!renderedPrompt && !preRenderRejection) return null;
    return {id: String(detail.id), outcome, ...(renderedPrompt ? {renderedPrompt} : {})};
  }
  private owned(task: Record<string, unknown>, channel: Channel, binding: BindingRecord): boolean {
    return task.id === channel.taskId && task.threadId === channel.helperThreadId && task.projectId === binding.projectId &&
      task.prompt === promptTemplate && record(task.schedule) && task.schedule.type === "webhook" &&
      (channel.createdAt === null || task.createdAt === channel.createdAt);
  }
  private async readyChannel(binding: BindingRecord, helper: Projection, signal: AbortSignal): Promise<{task: Record<string, unknown>; channel: Channel} | null> {
    let channel = this.channel(binding, helper.thread.id);
    if (channel?.state === "retired" || channel?.state === "retiring") return null;
    if (!channel) {
      channel = {taskId: `supervisor-helper:${workflowRequestHash({root: binding.threadId, generation: binding.generation, helper: helper.thread.id})}`,
        helperThreadId: helper.thread.id, createdAt: null, state: "creating"};
      this.saveChannel(binding, channel);
    }
    const taskId = channel.taskId;
    let task = (await this.tasks(signal)).find(item => item.id === taskId);
    if (task && !this.owned(task, channel, binding)) return null;
    if (!task && channel.state !== "creating") return null;
    if (task && task.enabled !== true) return null;
    if (!task || workflowRequestHash(task.modelSelection) !== workflowRequestHash(helper.thread.modelSelection) ||
      task.runtimeMode !== helper.thread.runtimeMode || task.interactionMode !== helper.thread.interactionMode) {
      const result = await this.options.rpc!("scheduledTasks.upsert", {id: channel.taskId,
        ...(task ? {requireExisting: true} : {}), commandId: `supervisor-helper-channel:${workflowRequestHash({taskId: channel.taskId, model: helper.thread.modelSelection,
          runtimeMode: helper.thread.runtimeMode, interactionMode: helper.thread.interactionMode})}`,
        title: `Supervisor helper check-ins · ${helper.thread.title.slice(0, 100)}`, prompt: promptTemplate, enabled: true,
        schedule: {type: "webhook"}, projectId: binding.projectId, threadId: helper.thread.id, workspaceStrategy: {type: "root"},
        modelSelection: helper.thread.modelSelection, runtimeMode: helper.thread.runtimeMode, interactionMode: helper.thread.interactionMode,
        createdBy: "system", creationSource: "server"}, signal);
      if (!record(result) || !record(result.task) || result.task.enabled !== true || !this.owned(result.task, channel, binding)) return null;
      task = result.task;
    }
    if (typeof task.createdAt !== "string" || !record(task.webhook) || typeof task.webhook.path !== "string" || !task.webhook.path.startsWith("/api/hooks/")) return null;
    channel = {...channel, createdAt: task.createdAt, state: "ready"};this.saveChannel(binding, channel);
    return {channel, task};
  }
  private async reconcileReceipt(binding: BindingRecord, delivery: Delivery, signal: AbortSignal): Promise<SupervisorHelperSendResult> {
    const native = await this.resolveWebhookDelivery(delivery, signal);
    if (native && rejectedWebhookOutcomes.has(native.outcome)) {
      this.save(binding, {...delivery, nativeDeliveryId: native.id, state: "rejected"});return "rejected";
    }
    // a bound rendered prompt is never replaced; the sent text, hash and identities are never changed
    if (native) this.save(binding, {...delivery, nativeDeliveryId: native.id, state: "posted",
      ...(delivery.renderedText === undefined && native.renderedPrompt !== undefined ? {renderedText: native.renderedPrompt} : {})});
    return native?.outcome === "accepted" ? "waiting" :
      delivery.state === "posted" && delivery.nativeDeliveryId ? "waiting" : "uncertain";
  }
  // read-only reconciliation of an existing receipt; it never posts. A durable rejected receipt or a native
  // rejected webhook outcome proves non-delivery; anything else leaves the identity unresolved.
  async reconcileDelivery(binding: BindingRecord, input: SupervisorHelperMessage, signal: AbortSignal): Promise<"absent" | SupervisorHelperSendResult> {
    const row = this.options.store.store.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
      .get(binding.threadId, binding.generation, input.messageId);
    if (!row) return "absent";
    const delivery = JSON.parse(String(row.document)) as Delivery;
    if (delivery.hash !== workflowRequestHash(input)) return "uncertain";
    if (delivery.state === "rejected") return "rejected";
    if (!this.options.rpc) return "uncertain";
    try {return await this.reconcileReceipt(binding, delivery, signal);} catch {return "uncertain";}
  }
  // `authorized` is re-checked after this method's own awaits, immediately before the receipt and POST, so
  // authority revoked meanwhile (for example a quarantine) posts nothing.
  async send(binding: BindingRecord, input: SupervisorHelperMessage, signal: AbortSignal, authorized?: () => boolean): Promise<SupervisorHelperSendResult> {
    if (!this.options.rpc || !this.options.store.enabled(binding.projectId)) return "busy";
    const row = this.options.store.store.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
      .get(binding.threadId, binding.generation, input.messageId);
    const hash = workflowRequestHash(input);
    const delivery = row ? JSON.parse(String(row.document)) as Delivery : null;
    // "rejected" promises this identity was never delivered: only native rejection evidence or the absence
    // of any prior POST proves that. A later refusal of an earlier unknown POST keeps it uncertain.
    const refused: SupervisorHelperSendResult = delivery && delivery.state !== "rejected" ? "uncertain" : "rejected";
    const current = this.options.store.binding(binding.projectId, binding.mainThreadId);
    if (current?.threadId !== binding.threadId || current.generation !== binding.generation || current.state !== "ready") return refused;
    if (delivery && delivery.hash !== hash) return refused;
    if (delivery?.state === "rejected") return "rejected";
    try {
      const helper = await this.options.projection(input.threadId, signal);
      if (helper.thread.id !== input.threadId || helper.thread.lineage.parentThreadId !== binding.threadId ||
        helper.thread.lineage.relationshipToParent !== "subagent" || helper.thread.archivedAt != null || helper.thread.deletedAt != null ||
        !this.options.store.ownedIds.has(input.threadId)) return refused;
      if (delivery) {
        if (helper.messages.some(message => this.matchesMessage(binding, input.messageId, input.text, message))) return "waiting";
        return await this.reconcileReceipt(binding, delivery, signal);
      }
      if (!Array.isArray(helper.runtimeRequests) || helper.runtimeRequests.some(item => !record(item) || item.status === "pending")) return "busy";
      const channel = await this.readyChannel(binding, helper, signal);
      if (!channel || !record(channel.task.webhook) || typeof channel.task.webhook.path !== "string") return "busy";
      const endpoint = new URL(channel.task.webhook.path, this.options.baseUrl);
      if (endpoint.origin !== new URL(this.options.baseUrl).origin || endpoint.search || endpoint.hash) return "rejected";
      if (authorized && !authorized()) return "revoked";
      const posting: Delivery = {...input, hash, taskId: channel.channel.taskId, state: "posting"};
      this.save(binding, posting);
      // a webhook has no client idempotency key; never repeat an uncertain post
      const response = await (this.options.fetch ?? fetch)(endpoint, {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({batchId: input.messageId, text: input.text}), signal});
      if (response.status >= 400 && response.status < 500) {this.save(binding, {...posting, state: "rejected"});return "rejected";}
      if (!response.ok) return "uncertain";
      const result: unknown = await response.json();
      const nativeDeliveryId = record(result) && typeof result.deliveryId === "string" ? result.deliveryId : undefined;
      this.save(binding, {...posting, state: "posted", ...(nativeDeliveryId ? {nativeDeliveryId} : {})});
      return nativeDeliveryId ? "waiting" : "uncertain";
    } catch {return "uncertain";}
  }
  async retire(binding: BindingRecord, helperThreadId: string, signal: AbortSignal): Promise<boolean> {
    const channel = this.channel(binding, helperThreadId);
    if (!channel || channel.state === "retired") return true;
    if (!this.options.rpc) return false;
    try {
      const task = (await this.tasks(signal)).find(item => item.id === channel.taskId);
      if (task && !this.owned(task, channel, binding)) return false;
      this.saveChannel(binding, {...channel, state: "retiring"});
      if (task) await this.options.rpc("scheduledTasks.delete", {id: channel.taskId}, signal);
      this.saveChannel(binding, {...channel, state: "retired"});return true;
    } catch {return false;}
  }
}
export type SupervisorHelperDeliveryTransport = Pick<SupervisorHelperTransport, "send" | "hasDelivery" | "reconcileDelivery" | "receiptText" | "matchesMessage" | "retire">;
