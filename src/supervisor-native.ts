import WebSocket from "ws";
import type { SupervisorModelInfo, SupervisorModelSelection } from "./project-supervisor-contract.js";

export class SupervisorRpcError extends Error {
  constructor(readonly outcome: "rejected" | "uncertain", readonly definiteRejection = false, readonly providerDisabled = false) {super("T3 Supervisor access is unavailable.");}
}
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const rejectedByName = (value: unknown, name: string, depth = 0): boolean => {
  if (depth > 20 || !record(value)) return false;
  if (value.name === name || value._tag === name) return true;
  return Object.values(value).some(child => Array.isArray(child) ? child.some(item => rejectedByName(item, name, depth + 1)) : rejectedByName(child, name, depth + 1));
};

/** Keeps native requests bounded and never exposes remote errors or credentials. */
export const makeSupervisorRpc = (baseUrl: string, token: string) =>
  (tag: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SupervisorRpcError("rejected"));
    const url = new URL("/ws?orchestrationProtocol=2", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {headers: {Authorization: `Bearer ${token}`}, handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024});
    let finished = false;
    let sent = false;
    const finish = (error?: SupervisorRpcError, value?: unknown) => {
      if (finished) return;
      finished = true;clearTimeout(timer);signal.removeEventListener("abort", abort);ws.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new SupervisorRpcError(sent ? "uncertain" : "rejected"));
    const timer = setTimeout(abort, 20_000);
    signal.addEventListener("abort", abort, {once: true});
    ws.on("error", abort);ws.on("close", abort);
    ws.on("open", () => {
      if (finished || signal.aborted) return abort();
      sent = true;
      ws.send(JSON.stringify({_tag: "Request", id: "supervisor", tag, payload, headers: []}), error => {if (error) abort();});
    });
    ws.on("message", (data, binary) => {
      if (binary) return abort();
      try {
        const decoded: unknown = JSON.parse(data.toString());
        for (const frame of (Array.isArray(decoded) ? decoded.flat(4) : [decoded])) {
          if (!record(frame)) return abort();
          if (frame._tag === "Ping") {ws.send(JSON.stringify({_tag: "Pong"}));continue;}
          if (frame._tag !== "Exit" || frame.requestId !== "supervisor") continue;
          if (!record(frame.exit)) return abort();
          if (frame.exit._tag === "Success") finish(undefined, frame.exit.value);
          else {
            const providerDisabled = rejectedByName(frame.exit, "ThreadManagementProviderInstanceDisabledError");
            const definite = providerDisabled || rejectedByName(frame.exit, "OrchestratorCommandPreviouslyRejectedError");
            finish(new SupervisorRpcError(definite ? "rejected" : "uncertain", definite, providerDisabled));
          }
        }
      } catch {abort();}
    });
  });
export type SupervisorRpc = ReturnType<typeof makeSupervisorRpc>;

/** Captures active and archived native run identities without relying on limited event replay. */
const readShellBaseline = (baseUrl: string, token: string) =>
  async (signal: AbortSignal): Promise<import("./project-supervisor-store.js").SupervisorBaseline> => {
    const response = await fetch(new URL("/api/orchestration/shell", baseUrl), {
      headers: {Authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2"},
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok || !response.body) throw new SupervisorRpcError("rejected");
    const reader = response.body.getReader();const chunks: Uint8Array[] = [];let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();if (chunk.done) break;
        bytes += chunk.value.length;if (bytes > 8 * 1024 * 1024) throw new SupervisorRpcError("rejected");
        chunks.push(chunk.value);
      }
    } finally {await reader.cancel().catch(() => undefined);}
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(value) || value.schemaVersion !== 2 || !Number.isSafeInteger(value.snapshotSequence) || Number(value.snapshotSequence) < 0 ||
      !Array.isArray(value.threads) || !Array.isArray(value.archivedThreads)) throw new SupervisorRpcError("rejected");
    const threads = [...value.threads, ...value.archivedThreads];
    if (threads.length > 10_000 || !threads.every(thread => record(thread) && text(thread.id) && (thread.latestRunId === null || text(thread.latestRunId))) ||
      new Set(threads.map(thread => record(thread) ? thread.id : null)).size !== threads.length) throw new SupervisorRpcError("rejected");
    return {snapshotSequence: Number(value.snapshotSequence), threads: value.threads.map(thread => ({id: String(thread.id), latestRunId: thread.latestRunId as string | null}))};
  };

/** Combines native active/archive views only at the same global revision. */
export const readSupervisorBaseline = (baseUrl: string, token: string, rpc: SupervisorRpc = makeSupervisorRpc(baseUrl, token)) =>
  async (signal: AbortSignal): Promise<import("./project-supervisor-store.js").SupervisorBaseline> => {
    capture: for (let attempt = 0; attempt < 3; attempt++) {
      const [active, archived] = await Promise.all([readShellBaseline(baseUrl, token)(signal), rpc("orchestration.getArchivedShellSnapshot", {}, signal)]);
      if (!record(archived) || archived.schemaVersion !== 2 || !Number.isSafeInteger(archived.snapshotSequence) || !Array.isArray(archived.threads) ||
        archived.threads.length > 10_000 || !archived.threads.every(thread => record(thread) && text(thread.id) && (thread.latestRunId === null || text(thread.latestRunId)))) throw new SupervisorRpcError("rejected");
      if (archived.snapshotSequence !== active.snapshotSequence) continue;
      const threads = new Map(active.threads.map(thread => [thread.id, thread]));const seen = new Set<string>();
      for (const thread of archived.threads) {
        const id = String(thread.id);if (seen.has(id)) throw new SupervisorRpcError("rejected");seen.add(id);
        const existing = threads.get(id);
        if (existing) continue capture;
        threads.set(id, {id, latestRunId: thread.latestRunId as string | null});
      }
      if (threads.size > 10_000) throw new SupervisorRpcError("rejected");
      return {snapshotSequence: active.snapshotSequence, threads: [...threads.values()]};
    }
    throw new SupervisorRpcError("rejected");
  };

/** Normalizes the same model and option descriptors that T3 exposes to its composer. */
export const supervisorModels = (value: unknown): SupervisorModelInfo[] => {
  if (!record(value) || !Array.isArray(value.providers) || value.providers.length > 200) throw new SupervisorRpcError("rejected");
  const result: SupervisorModelInfo[] = [];
  for (const provider of value.providers) {
    if (!record(provider) || provider.enabled !== true || !text(provider.instanceId) || !text(provider.displayName) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!record(model) || !text(model.slug) || !text(model.name)) continue;
      const rawOptions = record(model.capabilities) && Array.isArray(model.capabilities.optionDescriptors) ? model.capabilities.optionDescriptors : [];
      const options: SupervisorModelInfo["options"][number][] = [];
      for (const descriptor of rawOptions) {
        if (!record(descriptor) || !text(descriptor.id) || !text(descriptor.label)) continue;
        if (descriptor.type === "boolean") options.push({id: descriptor.id, label: descriptor.label, choices: [{value: false, label: "Off"}, {value: true, label: "On"}], defaultValue: descriptor.currentValue === true});
        else if (descriptor.type === "select" && Array.isArray(descriptor.options)) {
          const choices = descriptor.options.filter(o => record(o) && text(o.id) && text(o.label)).map(o => ({value: String(o.id), label: String(o.label)}));
          if (!choices.length || choices.length > 100) continue;
          const fallback = descriptor.options.find(o => record(o) && o.isDefault === true);
          const defaultValue = choices.find(o => o.value === descriptor.currentValue)?.value ?? (record(fallback) ? choices.find(o => o.value === fallback.id)?.value : undefined) ?? choices[0]!.value;
          options.push({id: descriptor.id, label: descriptor.label, choices, defaultValue});
        }
      }
      result.push({instanceId: provider.instanceId, model: model.slug, name: model.name, providerName: provider.displayName,
        available: provider.installed === true && provider.status === "ready" && provider.supportsTextGeneration !== false, options});
      if (result.length > 1000) throw new SupervisorRpcError("rejected");
    }
  }
  return result;
};
export const validModelSelection = (selection: SupervisorModelSelection, models: readonly SupervisorModelInfo[]): boolean => {
  const model = models.find(m => m.instanceId === selection.instanceId && m.model === selection.model && m.available);
  return Boolean(model && selection.options.length <= 30 && new Set(selection.options.map(o => o.id)).size === selection.options.length &&
    selection.options.every(o => model.options.some(d => d.id === o.id && d.choices.some(c => c.value === o.value))));
};
export const modelSelection = (value: unknown): SupervisorModelSelection | null => {
  if (!record(value) || !text(value.instanceId) || !text(value.model) || value.options !== undefined && !Array.isArray(value.options)) return null;
  const options = value.options ?? [];
  if (!Array.isArray(options) || !options.every(o => record(o) && text(o.id) && (typeof o.value === "string" || typeof o.value === "boolean"))) return null;
  return {instanceId: value.instanceId, model: value.model, options: options.map(o => ({id: String(o.id), value: o.value as string | boolean}))};
};
export const sameModel = (a: SupervisorModelSelection, b: SupervisorModelSelection): boolean =>
  a.instanceId === b.instanceId && a.model === b.model && JSON.stringify([...a.options].sort((x,y) => x.id.localeCompare(y.id))) === JSON.stringify([...b.options].sort((x,y) => x.id.localeCompare(y.id)));
