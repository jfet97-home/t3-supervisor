import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { JsonRecord } from "./types.js";

const ORCHESTRATION_PROTOCOL = 2;
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
const DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_WEBSOCKET_FRAME_BYTES = 32 * 1024 * 1024;
const RPC_REQUEST_ID = "1";

export type InputT3RequestStatus = "pending" | "resolved" | "expired" | "cancelled";

export type InputT3ResponseCapability =
  | { type: "live"; providerSessionId: string }
  | { type: "message" }
  | { type: "not_resumable"; reason: string };

export interface InputT3QuestionOption extends JsonRecord {
  label: string;
  description: string;
  value?: string;
}

export interface InputT3Question extends JsonRecord {
  id: string;
  header: string;
  question: string;
  options: InputT3QuestionOption[];
  multiSelect: boolean;
  allowCustomAnswer: boolean;
  required: boolean;
  native: JsonRecord;
}

export interface InputT3Thread extends JsonRecord {
  id: string;
  title: string;
  projectId: string;
  lineage: JsonRecord & {
    parentThreadId: string | null;
    relationshipToParent: string | null;
  };
}

export interface InputT3EnvironmentDescriptor extends JsonRecord {
  environmentId: string;
  orchestrationProtocolVersion: 2;
  serverVersion: string;
}

export interface InputT3Request extends JsonRecord {
  environmentId: string;
  threadId: string;
  requestId: string;
  nodeId: string;
  providerTurnId: string | null;
  nativeRequestRef: JsonRecord | null;
  status: InputT3RequestStatus;
  responseCapability: InputT3ResponseCapability;
  terminal: boolean;
  canRespond: boolean;
  createdAt: string;
  resolvedAt: string | null;
  decision?: string;
  answers?: JsonRecord;
  questions: InputT3Question[];
  responseMode?: "message";
  owner: {
    threadId: string;
    runId: string | null;
    nodeId: string;
    providerInstanceId: string | null;
    providerThreadId: string | null;
    providerTurnId: string | null;
  };
  revisionHash: string;
  native: {
    request: JsonRecord;
    turnItem: JsonRecord;
  };
}

export type InputT3RespondResult =
  | { outcome: "accepted"; commandId: string; sequence: number }
  | { outcome: "rejected"; commandId: string; reason: string; httpStatus?: number }
  | { outcome: "unknown"; commandId: string; reason: string };

export interface InputT3ClientOptions {
  baseUrl: string;
  readToken: string;
  responseToken: string;
  httpTimeoutMs?: number;
  webSocketHandshakeTimeoutMs?: number;
  responseTimeoutMs?: number;
  maxHttpResponseBytes?: number;
  maxWebSocketFrameBytes?: number;
}

export interface InputT3Client {
  descriptor(): Promise<InputT3EnvironmentDescriptor>;
  listThreads(): Promise<InputT3Thread[]>;
  readRequest(threadId: string, requestId: string): Promise<InputT3Request | undefined>;
  listRequests(threadId: string): Promise<InputT3Request[]>;
  respond(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<InputT3RespondResult>;
}

export class InputT3Error extends Error {
  readonly httpStatus?: number;

  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = "InputT3Error";
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isRequestStatus = (value: unknown): value is InputT3RequestStatus =>
  value === "pending" || value === "resolved" || value === "expired" || value === "cancelled";

const requiredString = (record: JsonRecord, key: string, operation: string): string => {
  const value = record[key];
  if (!isNonEmptyString(value)) throw new InputT3Error(`T3 ${operation} returned an invalid ${key}`);
  return value;
};

const nullableString = (record: JsonRecord, key: string, operation: string): string | null => {
  const value = record[key];
  if (value === null) return null;
  if (!isNonEmptyString(value)) throw new InputT3Error(`T3 ${operation} returned an invalid ${key}`);
  return value;
};

const optionalBoolean = (record: JsonRecord, key: string, fallback: boolean, operation: string): boolean => {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new InputT3Error(`T3 ${operation} returned an invalid ${key}`);
  return value;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as JsonRecord;
  const entries = Object.keys(record).sort().flatMap((key) => {
    const current = record[key];
    return current === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(current)}`];
  });
  return `{${entries.join(",")}}`;
};

const flattenEnvelopes = (input: unknown): JsonRecord[] | undefined => {
  const result: JsonRecord[] = [];
  const pending: unknown[] = [input];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 1024) return undefined;
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }
    if (!isRecord(current)) return undefined;
    result.push(current);
  }
  return result.length === 0 ? undefined : result;
};

const rawDataToText = (data: WebSocket.RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
};

const readJsonBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  operation: string
): Promise<unknown> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new InputT3Error(`T3 ${operation} response exceeded the byte limit`);
  }
  if (response.body === null) throw new InputT3Error(`T3 ${operation} response was empty`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new InputT3Error(`T3 ${operation} request was interrupted`);
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new InputT3Error(`T3 ${operation} response exceeded the byte limit`);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof InputT3Error) throw error;
    throw new InputT3Error(`T3 ${operation} response could not be read`);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new InputT3Error(`T3 ${operation} response was not valid JSON`);
  }
};

const parseDescriptor = (value: unknown): InputT3EnvironmentDescriptor => {
  if (!isRecord(value) ||
    !isNonEmptyString(value.environmentId) ||
    value.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL ||
    !isNonEmptyString(value.serverVersion)) {
    throw new InputT3Error("T3 environment descriptor has an unsupported protocol or shape");
  }
  return value as InputT3EnvironmentDescriptor;
};

const parseShellSnapshot = (value: unknown): JsonRecord => {
  if (!isRecord(value) ||
    value.schemaVersion !== ORCHESTRATION_PROTOCOL ||
    !isSequence(value.snapshotSequence) ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.threads)) {
    throw new InputT3Error("T3 shell snapshot has an unsupported schema or shape");
  }
  return value;
};

interface ThreadSnapshot {
  projection: JsonRecord;
}

const parseThreadSnapshot = (value: unknown, threadId: string): ThreadSnapshot => {
  if (!isRecord(value) ||
    !isSequence(value.snapshotSequence) ||
    (value.schemaVersion !== undefined && value.schemaVersion !== ORCHESTRATION_PROTOCOL) ||
    !isRecord(value.projection)) {
    throw new InputT3Error("T3 thread snapshot has an unsupported schema or shape");
  }
  const projection = value.projection;
  if (!isRecord(projection.thread) || projection.thread.id !== threadId ||
    !Array.isArray(projection.runtimeRequests) ||
    !Array.isArray(projection.turnItems) ||
    !Array.isArray(projection.nodes) ||
    !Array.isArray(projection.runs)) {
    throw new InputT3Error("T3 thread projection has an unsupported schema or shape");
  }
  return { projection };
};

const parseCapability = (value: unknown): InputT3ResponseCapability => {
  if (!isRecord(value)) throw new InputT3Error("T3 user-input request has an invalid response capability");
  switch (value.type) {
    case "live":
      return { type: "live", providerSessionId: requiredString(value, "providerSessionId", "user-input request") };
    case "message":
      return { type: "message" };
    case "not_resumable":
      if (typeof value.reason !== "string") throw new InputT3Error("T3 user-input request has an invalid response capability");
      return { type: "not_resumable", reason: value.reason };
    default:
      throw new InputT3Error("T3 user-input request has an unsupported response capability");
  }
};

const parseQuestion = (value: unknown): InputT3Question => {
  if (!isRecord(value) || !Array.isArray(value.options)) {
    throw new InputT3Error("T3 user-input request has an invalid question definition");
  }
  const options = value.options.map((option) => {
    if (!isRecord(option) || !isNonEmptyString(option.label) || typeof option.description !== "string" ||
      (option.value !== undefined && typeof option.value !== "string")) {
      throw new InputT3Error("T3 user-input request has an invalid option definition");
    }
    return { ...option, label: option.label, description: option.description } as InputT3QuestionOption;
  });
  return {
    ...value,
    id: requiredString(value, "id", "user-input question"),
    header: requiredString(value, "header", "user-input question"),
    question: requiredString(value, "question", "user-input question"),
    options,
    multiSelect: optionalBoolean(value, "multiSelect", false, "user-input question"),
    allowCustomAnswer: optionalBoolean(value, "allowCustomAnswer", true, "user-input question"),
    required: optionalBoolean(value, "required", true, "user-input question"),
    native: { ...value }
  };
};

const getQuestionTurnItem = (projection: JsonRecord, requestId: string): JsonRecord => {
  const items = projection.turnItems as unknown[];
  const matches = items.filter((item): item is JsonRecord =>
    isRecord(item) && item.type === "user_input_request" && item.requestId === requestId);
  const item = matches.at(-1);
  if (item === undefined || !Array.isArray(item.questions) || item.questions.length === 0) {
    throw new InputT3Error("T3 user-input request definition is unavailable");
  }
  return item;
};

const mapRequest = (
  environmentId: string,
  projection: JsonRecord,
  requestValue: unknown
): InputT3Request | undefined => {
  if (!isRecord(requestValue)) throw new InputT3Error("T3 thread projection contains an invalid runtime request");
  if (requestValue.kind !== "user_input") return undefined;

  const requestId = requiredString(requestValue, "id", "runtime request");
  const thread = projection.thread as JsonRecord;
  const threadId = requiredString(thread, "id", "thread projection");
  const nodeId = requiredString(requestValue, "nodeId", "runtime request");
  if (!isRequestStatus(requestValue.status)) throw new InputT3Error("T3 user-input request has an unsupported status");
  const responseCapability = parseCapability(requestValue.responseCapability);
  const item = getQuestionTurnItem(projection, requestId);
  if (item.threadId !== threadId || item.nodeId !== nodeId) {
    throw new InputT3Error("T3 user-input request has inconsistent native ownership");
  }
  const nodes = projection.nodes as unknown[];
  const node = nodes.find((candidate): candidate is JsonRecord => isRecord(candidate) && candidate.id === nodeId);
  if (node === undefined || node.kind !== "user_input_request") {
    throw new InputT3Error("T3 user-input request owner node is unavailable");
  }
  const runId = node.runId === null ? null : requiredString(node, "runId", "request owner node");
  const runs = projection.runs as unknown[];
  const run = runId === null
    ? undefined
    : runs.find((candidate): candidate is JsonRecord => isRecord(candidate) && candidate.id === runId);
  const providerInstanceId = run === undefined || run.providerInstanceId === null
    ? null
    : requiredString(run, "providerInstanceId", "request owner run");
  const providerThreadId = node.providerThreadId === null || node.providerThreadId === undefined
    ? null
    : requiredString(node, "providerThreadId", "request owner node");
  const providerTurnId = requestValue.providerTurnId === null
    ? null
    : requiredString(requestValue, "providerTurnId", "runtime request");
  const nativeRequestRef = requestValue.nativeRequestRef === null
    ? null
    : isRecord(requestValue.nativeRequestRef)
      ? { ...requestValue.nativeRequestRef }
      : (() => { throw new InputT3Error("T3 user-input request has an invalid native request reference"); })();
  const questions = (item.questions as unknown[]).map(parseQuestion);
  const nativeResponseMode = item.responseMode;
  if (nativeResponseMode !== undefined && nativeResponseMode !== "message") {
    throw new InputT3Error("T3 user-input request has an unsupported response mode");
  }
  const resolvedAt = nullableString(requestValue, "resolvedAt", "runtime request");
  const createdAt = requiredString(requestValue, "createdAt", "runtime request");
  const owner = {
    threadId,
    runId,
    nodeId,
    providerInstanceId,
    providerThreadId,
    providerTurnId
  };
  const rawRequest = { ...requestValue };
  const rawItem = { ...item };
  const revisionHash = createHash("sha256")
    .update(canonicalJson({ environmentId, threadId, request: rawRequest, turnItem: rawItem, owner }))
    .digest("hex");
  const responseMode = nativeResponseMode === "message" || responseCapability.type === "message"
    ? "message"
    : undefined;

  return {
    environmentId,
    threadId,
    requestId,
    nodeId,
    providerTurnId,
    nativeRequestRef,
    status: requestValue.status,
    responseCapability,
    terminal: requestValue.status !== "pending",
    canRespond: requestValue.status === "pending" && responseCapability.type !== "not_resumable",
    createdAt,
    resolvedAt,
    ...(typeof requestValue.decision === "string" ? { decision: requestValue.decision } : {}),
    ...(isRecord(requestValue.answers) ? { answers: { ...requestValue.answers } } : {}),
    questions,
    ...(responseMode === undefined ? {} : { responseMode }),
    owner,
    revisionHash,
    native: { request: rawRequest, turnItem: rawItem }
  };
};

const safeHttpFailure = (operation: string, status: number): InputT3Error =>
  new InputT3Error(`T3 ${operation} returned HTTP ${status}`, status);

const responseResult = (
  commandId: string,
  outcome: InputT3RespondResult["outcome"],
  reason?: string,
  sequence?: number,
  httpStatus?: number
): InputT3RespondResult => {
  if (outcome === "accepted" && sequence !== undefined) return { outcome, commandId, sequence };
  if (outcome === "rejected") {
    return { outcome, commandId, reason: reason ?? "T3 rejected the response command", ...(httpStatus === undefined ? {} : { httpStatus }) };
  }
  return { outcome: "unknown", commandId, reason: reason ?? "T3 did not confirm whether the response command was accepted" };
};

export const makeInputT3Client = (options: InputT3ClientOptions): InputT3Client => {
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new InputT3Error("T3 base URL must use HTTP or HTTPS");
  }
  if (!isNonEmptyString(options.readToken) || !isNonEmptyString(options.responseToken)) {
    throw new InputT3Error("T3 read and response tokens must be non-empty");
  }
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const webSocketHandshakeTimeoutMs = options.webSocketHandshakeTimeoutMs ?? DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS;
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const maxHttpResponseBytes = options.maxHttpResponseBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BYTES;
  const maxWebSocketFrameBytes = options.maxWebSocketFrameBytes ?? DEFAULT_MAX_WEBSOCKET_FRAME_BYTES;
  for (const [name, value] of [
    ["HTTP timeout", httpTimeoutMs],
    ["WebSocket handshake timeout", webSocketHandshakeTimeoutMs],
    ["response timeout", responseTimeoutMs],
    ["HTTP response byte limit", maxHttpResponseBytes],
    ["WebSocket frame byte limit", maxWebSocketFrameBytes]
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new InputT3Error(`T3 ${name} must be a positive safe integer`);
  }

  baseUrl.username = "";
  baseUrl.password = "";
  baseUrl.search = "";
  baseUrl.hash = "";

  const getJson = async (path: string, operation: string, protocolHeader: boolean): Promise<unknown> => {
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, httpTimeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${options.readToken}`
      };
      if (protocolHeader) headers["x-t3-orchestration-protocol"] = String(ORCHESTRATION_PROTOCOL);
      const response = await fetch(new URL(path, baseUrl), { headers, signal: controller.signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw safeHttpFailure(operation, response.status);
      }
      return await readJsonBody(response, maxHttpResponseBytes, controller.signal, operation);
    } catch (error) {
      if (error instanceof InputT3Error) throw error;
      throw new InputT3Error(didTimeout ? `T3 ${operation} request timed out` : `T3 ${operation} request failed`);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const getDescriptor = async (): Promise<InputT3EnvironmentDescriptor> =>
    parseDescriptor(await getJson("/.well-known/t3/environment", "environment descriptor", false));

  const getThreadProjection = async (threadId: string): Promise<{ environmentId: string; projection: JsonRecord }> => {
    if (!isNonEmptyString(threadId)) throw new InputT3Error("T3 thread id must not be empty");
    const [descriptor, value] = await Promise.all([
      getDescriptor(),
      getJson(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, "thread snapshot", true)
    ]);
    return { environmentId: descriptor.environmentId, ...parseThreadSnapshot(value, threadId) };
  };

  const mapRequests = (environmentId: string, projection: JsonRecord): InputT3Request[] => {
    const requests = projection.runtimeRequests as unknown[];
    return requests.flatMap((request) => {
      const mapped = mapRequest(environmentId, projection, request);
      return mapped === undefined ? [] : [mapped];
    });
  };

  const respond = (
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>
  ): Promise<InputT3RespondResult> => {
    const commandId = randomUUID();
    if (!isNonEmptyString(threadId) || !isNonEmptyString(requestId) || !isRecord(answers)) {
      return Promise.resolve(responseResult(commandId, "rejected", "T3 response command input is invalid"));
    }
    let serialized: string;
    try {
      serialized = JSON.stringify({
        _tag: "Request",
        id: RPC_REQUEST_ID,
        tag: "orchestration.dispatchCommand",
        payload: {
          type: "runtime-request.respond",
          commandId,
          threadId,
          requestId,
          answers
        },
        headers: []
      });
    } catch {
      return Promise.resolve(responseResult(commandId, "rejected", "T3 response command input is not JSON serializable"));
    }

    const socketUrl = new URL("/ws?orchestrationProtocol=2", baseUrl);
    socketUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";

    return new Promise((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(socketUrl, {
          headers: { Authorization: `Bearer ${options.responseToken}` },
          maxPayload: maxWebSocketFrameBytes,
          handshakeTimeout: webSocketHandshakeTimeoutMs
        });
      } catch {
        resolve(responseResult(commandId, "rejected", "T3 websocket connection failed before the response command was sent"));
        return;
      }

      let settled = false;
      let sent = false;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: InputT3RespondResult) => {
        if (settled) return;
        settled = true;
        if (responseTimer !== undefined) clearTimeout(responseTimer);
        resolve(result);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          try {
            socket.terminate();
          } catch {
            return;
          }
        }
      };
      const finishUnknown = () => finish(responseResult(commandId, "unknown"));
      const onOpen = () => {
        if (settled || sent) return;
        sent = true;
        responseTimer = setTimeout(finishUnknown, responseTimeoutMs);
        try {
          socket.send(serialized, (error) => {
            if (error) finishUnknown();
          });
        } catch {
          finishUnknown();
        }
      };
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        if (settled || !sent) return;
        if (isBinary) {
          finishUnknown();
          return;
        }
        let envelopes: JsonRecord[] | undefined;
        try {
          envelopes = flattenEnvelopes(JSON.parse(rawDataToText(data)) as unknown);
        } catch {
          finishUnknown();
          return;
        }
        if (envelopes === undefined) {
          finishUnknown();
          return;
        }
        for (const envelope of envelopes) {
          if (envelope._tag === "Ping") {
            try {
              socket.send(JSON.stringify({ _tag: "Pong" }), (error) => {
                if (error) finishUnknown();
              });
            } catch {
              finishUnknown();
            }
            continue;
          }
          if (envelope._tag === "Pong") continue;
          if (envelope.requestId !== RPC_REQUEST_ID) continue;
          if (envelope._tag === "Defect") {
            finishUnknown();
            return;
          }
          if (envelope._tag !== "Exit" || !isRecord(envelope.exit)) continue;
          const exit = envelope.exit;
          if (exit._tag === "Failure") {
            finish(responseResult(commandId, "rejected", "T3 rejected the response command"));
            return;
          }
          if (exit._tag !== "Success" || !isRecord(exit.value) || !isSequence(exit.value.sequence)) {
            finishUnknown();
            return;
          }
          finish(responseResult(commandId, "accepted", undefined, exit.value.sequence));
          return;
        }
      };
      const onError = () => {
        if (sent) finishUnknown();
        else finish(responseResult(commandId, "rejected", "T3 websocket connection failed before the response command was sent"));
      };
      const onClose = () => {
        if (sent) finishUnknown();
        else finish(responseResult(commandId, "rejected", "T3 websocket connection closed before the response command was sent"));
      };
      const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) => {
        finish(responseResult(
          commandId,
          "rejected",
          "T3 websocket rejected the response connection",
          undefined,
          response.statusCode
        ));
      };

      socket.on("open", onOpen);
      socket.on("message", onMessage);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("unexpected-response", onUnexpectedResponse);
    });
  };

  return {
    descriptor: getDescriptor,
    listThreads: async () => {
      const value = await getJson("/api/orchestration/shell", "shell snapshot", true);
      const snapshot = parseShellSnapshot(value);
      return (snapshot.threads as unknown[]).map((thread) => {
        if (!isRecord(thread) ||
          !isNonEmptyString(thread.id) ||
          !isNonEmptyString(thread.title) ||
          !isNonEmptyString(thread.projectId) ||
          !isRecord(thread.lineage) ||
          !(thread.lineage.parentThreadId === null || isNonEmptyString(thread.lineage.parentThreadId)) ||
          !(thread.lineage.relationshipToParent === null || isNonEmptyString(thread.lineage.relationshipToParent))) {
          throw new InputT3Error("T3 shell snapshot contains an invalid thread");
        }
        return thread as InputT3Thread;
      });
    },
    readRequest: async (threadId, requestId) => {
      if (!isNonEmptyString(requestId)) throw new InputT3Error("T3 request id must not be empty");
      const { environmentId, projection } = await getThreadProjection(threadId);
      return mapRequests(environmentId, projection).find((request) => request.requestId === requestId);
    },
    listRequests: async (threadId) => {
      const { environmentId, projection } = await getThreadProjection(threadId);
      return mapRequests(environmentId, projection);
    },
    respond
  };
};
