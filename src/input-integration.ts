import type { InputNativeClient } from "./input-coordinator.js";
import type { InputThread, NativeInputRequest } from "./input-domain.js";
import { makeInputT3Client } from "./input-t3.js";
import type { InputT3ClientOptions, InputT3Request, InputT3Thread } from "./input-t3.js";

const FALLBACK_REFRESH_MS = 60_000;

const normalizeDisplayTitle = (title: string): string => {
  const sanitized = title.replace(/[\p{Cc}\uD800-\uDFFF]/gu, " ").replace(/\s+/gu, " ").trim();
  let bounded = "";
  for (const scalar of sanitized) {
    if (bounded.length + scalar.length > 512) break;
    bounded += scalar;
  }
  return bounded;
};

export const normalizeNativeInput = (request: InputT3Request, title: string): NativeInputRequest => ({
  threadId: request.threadId,
  requestId: request.requestId,
  revisionHash: request.revisionHash,
  capability: request.responseCapability.type,
  terminal: request.terminal || !request.canRespond,
  terminalState: request.terminal ? request.status : request.canRespond ? null : "not_resumable",
  requestKind: "question",
  displayTitle: normalizeDisplayTitle(title),
  questions: request.questions.map((question) => ({
    id: question.id,
    prompt: `${question.header}\n${question.question}`,
    kind: question.options.length === 0 ? "free_text" : question.multiSelect ? "multi_choice" : "single_choice",
    required: true,
    choices: question.options.map((option) => ({
      value: option.value ?? option.label,
      label: option.description ? `${option.label}\n${option.description}` : option.label,
    })),
    allowCustomAnswer: question.allowCustomAnswer,
  })),
});

/** Adapts installed native T3 contracts without changing T3 itself. */
export const makeNativeInputIntegration = (options: InputT3ClientOptions & {isSupervisorThread?: (thread: InputT3Thread) => boolean}): InputNativeClient => {
  const client = makeInputT3Client(options);
  let environmentId: string | null = null;
  const threads = new Map<string, InputT3Thread>();
  const cache = new Map<string, { at: number; shellRevision: string; requests: NativeInputRequest[] }>();
  const shellRevision = (thread: InputT3Thread | undefined): string => JSON.stringify({
    updatedAt: thread?.updatedAt,
    activeRunId: thread?.activeRunId,
    pendingRuntimeRequest: thread?.pendingRuntimeRequest,
  });
  const normalize = (request: InputT3Request): NativeInputRequest => {
    if (environmentId === null || request.environmentId !== environmentId) throw new Error("Input environment changed");
    return normalizeNativeInput(request, threads.get(request.threadId)?.title ?? request.threadId);
  };
  const descriptor = async () => {
    const current = await client.descriptor();
    if (environmentId !== null && current.environmentId !== environmentId) throw new Error("Input environment changed");
    environmentId = current.environmentId;
    return current;
  };
  return {
    descriptor,
    listThreads: async () => {
      const listed = await client.listThreads();
      threads.clear();
      for (const thread of listed) threads.set(thread.id, thread);
      for (const id of cache.keys()) if (!threads.has(id)) cache.delete(id);
      return listed.map((thread): InputThread => ({
        id: thread.id,
        active: options.isSupervisorThread?.(thread) !== true,
        archived: thread.archived === true || thread.archivedAt != null,
        deleted: thread.deletedAt != null,
        delegated: thread.lineage.relationshipToParent === "subagent",
        relationshipToParent: thread.lineage.relationshipToParent,
        kind: thread.lineage.relationshipToParent === "fork" ? "fork" : "main",
      }));
    },
    listRequests: async (threadId) => {
      const previous = cache.get(threadId);
      const revision = shellRevision(threads.get(threadId));
      if (previous && previous.shellRevision === revision && Date.now() - previous.at < FALLBACK_REFRESH_MS &&
        previous.requests.every((request) => request.terminal)) return previous.requests;
      const requests = (await client.listRequests(threadId)).map(normalize);
      cache.set(threadId, { at: Date.now(), shellRevision: revision, requests });
      return requests;
    },
    readRequest: async (threadId, requestId) => {
      const request = await client.readRequest(threadId, requestId);
      return request ? normalize(request) : null;
    },
    respond: async (threadId, requestId, answers) => {
      const thread = threads.get(threadId);
      if (thread && options.isSupervisorThread?.(thread)) throw new Error("Supervisor input is not forwarded or answered.");
      await descriptor();
      const result = await client.respond(threadId, requestId, { ...answers });
      return result.outcome === "accepted" ? { kind: "accepted" } : { kind: result.outcome, reason: result.reason };
    },
  };
};
