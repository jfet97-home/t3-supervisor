import { Clock, Context, Data, Deferred, Duration, Effect, Layer, Option, Redacted, Ref, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientError, type HttpClientResponse } from "effect/http";
import {
  NativeEnvelope, NativeEnvelopeError, NativeFraming, nativeMaxPayload, type NativeFailure, type NativeServerFrame,
} from "./native-envelope.js";
import { ProjectionStreamError, readProjectionSnapshot } from "./t3-projection-stream.js";
import type { JsonRecord, Projection, SourceItem } from "./types.js";

const ORCHESTRATION_PROTOCOL = 2;
const MAX_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Accounted bytes of a thread projection the Supervisor keeps: the arrays it reads, a shared text counted once */
const MAX_RETAINED_PROJECTION_BYTES = 32 * 1024 * 1024;
/**
 * Bytes of one full thread snapshot read from T3, including the arrays the Supervisor never keeps. The largest thread
 * measured in production is 36,108,568 bytes; this bound leaves about 3.7 times that, and the unchanged HTTP deadline
 * still bounds the time spent.
 */
const MAX_PROJECTION_TRANSFER_BYTES = 128 * 1024 * 1024;
/** A thread whose snapshot exceeded a byte budget is not read again in full for this long */
const OVERSIZED_PROJECTION_MEMO_NANOS = BigInt(10 * 60_000) * 1_000_000n;
const OVERSIZED_PROJECTION_MEMO_LIMIT = 512;
const MAX_BUFFERED_WEBSOCKET_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_WEBSOCKET_FRAMES = 8;
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
const DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 40_000;

export interface T3EnvironmentDescriptor extends JsonRecord {
  environmentId: string;
  orchestrationProtocolVersion: 2;
  serverVersion: string;
}

export interface T3ProjectionSnapshot extends JsonRecord {
  snapshotSequence: number;
  projection: Projection;
}

export type T3TransportErrorCode = "response_too_large";

// the message never carries a token, url or native body
export class T3TransportError extends Data.TaggedError("T3TransportError")<{
  readonly message: string;
  readonly httpStatus?: number;
  readonly code?: T3TransportErrorCode;
}> {
  // positional, as every caller constructs it
  constructor(message: string, httpStatus?: number, code?: T3TransportErrorCode) {
    super({message, ...(httpStatus === undefined ? {} : {httpStatus}), ...(code === undefined ? {} : {code})});
  }
}

export interface T3ClientShape {
  descriptor(): Effect.Effect<T3EnvironmentDescriptor, T3TransportError>;
  projection(threadId: string): Effect.Effect<T3ProjectionSnapshot, T3TransportError>;
  watch<E = never, R = never>(
    cursor: number | undefined,
    onItem: (item: SourceItem) => Effect.Effect<void, E, R>
  ): Effect.Effect<never, T3TransportError | E, R>;
}

export interface T3ClientOptions {
  baseUrl: string;
  token: string;
  httpTimeoutMs?: number;
  maxResponseBytes?: number;
  maxProjectionTransferBytes?: number;
  webSocketHandshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

// native shapes, checked at the wire boundary; unknown fields are ignored and the raw value is what callers receive
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const NonBlank = Schema.String.check(Schema.makeFilter((value: string) => value.trim().length > 0));
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NullableString = Schema.NullOr(Schema.String);
const Protocol = Schema.Literal(ORCHESTRATION_PROTOCOL);

const isDescriptor = Schema.is(Schema.Struct({environmentId: NonBlank, orchestrationProtocolVersion: Protocol, serverVersion: NonBlank}));

const Run = Schema.Struct({
  id: Schema.String, ordinal: Schema.Int, status: Schema.String, requestedAt: Schema.String,
  startedAt: NullableString, completedAt: NullableString, rootNodeId: NullableString,
});
const Message = Schema.Struct({
  id: Schema.String, runId: NullableString, nodeId: NullableString, role: Schema.String, text: Schema.String,
  streaming: Schema.Boolean, createdAt: Schema.String, updatedAt: Schema.String,
});
const ProjectionShape = Schema.Struct({
  thread: Schema.Struct({
    id: NonBlank, title: Schema.String, projectId: NullableString,
    lineage: Schema.Struct({parentThreadId: NullableString, relationshipToParent: NullableString}),
  }),
  runs: Schema.Array(Run),
  messages: Schema.Array(Message),
  subagents: Schema.optional(Schema.Array(JsonObject)),
  turnItems: Schema.optional(Schema.Array(JsonObject)),
  schemaVersion: Schema.optional(Protocol),
});
// a bounded history window is never a full projection
const isProjectionSnapshot = Schema.is(Schema.Struct({
  snapshotSequence: Sequence,
  schemaVersion: Schema.optional(Protocol),
  projection: ProjectionShape,
  hasMoreHistory: Schema.optional(Schema.Unknown.check(Schema.makeFilter((value: unknown) => value !== true))),
  historyCursor: Schema.optional(Schema.Null),
}));

const Location = Schema.optional(Schema.Literals(["active", "archive"]));
const ThreadUpdated = Schema.Struct({kind: Schema.Literal("thread.updated"), sequence: Sequence, thread: Schema.Struct({id: NonBlank}), location: Location});
const ThreadRemoved = Schema.Struct({kind: Schema.Literal("thread.removed"), sequence: Sequence, threadId: NonBlank, location: Location});
const shellSnapshot = {
  schemaVersion: Protocol, snapshotSequence: Sequence, projects: Schema.Array(Schema.Unknown), threads: Schema.Array(Schema.Unknown),
};
const isShellItem: Record<SourceItem["stream"], (value: unknown) => boolean> = {
  active: Schema.is(Schema.Union([
    Schema.Struct({kind: Schema.Literal("synchronized")}),
    Schema.Struct({
      kind: Schema.Literal("snapshot"),
      snapshot: Schema.Struct({...shellSnapshot, archivedThreads: Schema.Array(Schema.Unknown)}),
      resolvedRepositoryIdentityRoots: Schema.optional(Schema.Array(Schema.String)),
    }),
    ThreadUpdated,
    ThreadRemoved,
    Schema.Struct({kind: Schema.Literal("project.updated"), sequence: Sequence, project: Schema.Struct({id: NonBlank})}),
    Schema.Struct({kind: Schema.Literal("project.removed"), sequence: Sequence, projectId: NonBlank}),
  ])),
  archive: Schema.is(Schema.Union([
    Schema.Struct({kind: Schema.Literal("snapshot"), snapshot: Schema.Struct(shellSnapshot)}),
    ThreadUpdated,
    ThreadRemoved,
  ])),
};
const isSequence = Schema.is(Sequence);
const isNonBlank = Schema.is(NonBlank);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

// the envelope's sanitized reasons, worded as the watch always reported them
const websocketMessages: Record<NativeFailure, string> = {
  cancelled: "T3 websocket connection interrupted",
  timed_out: "T3 websocket failed",
  handshake_timed_out: "T3 websocket handshake timed out",
  connect_failed: "T3 websocket connection failed",
  closed_before_open: "T3 websocket connection closed before opening",
  socket_failed: "T3 websocket failed",
  socket_closed: "T3 websocket closed",
  not_open: "T3 websocket is not open",
  send_failed: "T3 websocket send failed",
  binary_frame: "T3 websocket sent a binary message",
  malformed_json: "T3 websocket message was not valid protocol JSON",
  invalid_frame: "T3 websocket message was not valid protocol JSON",
  buffer_overflow: "T3 websocket message exceeded the byte limit",
};
const websocketError = (error: NativeEnvelopeError): T3TransportError => new T3TransportError(websocketMessages[error.reason]);

const tooLarge = (operation: string): T3TransportError =>
  new T3TransportError(`T3 ${operation} response exceeded the byte limit`, undefined, "response_too_large");

const declaredBytes = (response: HttpClientResponse.HttpClientResponse): number | undefined => {
  const length = response.headers["content-length"];
  return length === undefined ? undefined : Number(length);
};

// a body that never arrived is empty; one the connection stopped delivering could not be read
const bodyError = (operation: string) => (error: HttpClientError.HttpClientError): T3TransportError =>
  new T3TransportError(error.reason._tag === "EmptyBodyError" ? `T3 ${operation} response was empty` : `T3 ${operation} response could not be read`);

const projectionStreamError = (error: ProjectionStreamError): T3TransportError => {
  switch (error.code) {
    case "timed_out": return new T3TransportError("T3 thread projection request timed out");
    case "unreadable": return new T3TransportError("T3 thread projection response could not be read");
    case "invalid": return new T3TransportError("T3 thread projection response was not valid JSON");
    case "retained_too_large":
    case "transfer_too_large": return tooLarge("thread projection");
  }
};

const monotonicNanos = Clock.monotonicTimeNanos;
const monotonicMillis = Effect.map(monotonicNanos, (nanos) => Number(nanos) / 1_000_000);

interface Settings {
  readonly baseUrl: URL;
  readonly token: Redacted.Redacted<string>;
  readonly httpTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRetainedProjectionBytes: number;
  readonly maxProjectionTransferBytes: number;
  readonly webSocketHandshakeTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
}

const within = (value: number, maximum: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= maximum;

const settingsOf = (options: T3ClientOptions): Settings | T3TransportError => {
  const baseUrl = URL.canParse(options.baseUrl) ? new URL(options.baseUrl) : undefined;
  if (baseUrl === undefined || (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")) {
    return new T3TransportError("T3 base URL must use HTTP or HTTPS");
  }
  if (!isNonBlank(options.token)) return new T3TransportError("T3 token must not be empty");
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxResponseBytes = Math.min(options.maxResponseBytes ?? MAX_HTTP_RESPONSE_BYTES, MAX_HTTP_RESPONSE_BYTES);
  const maxRetainedProjectionBytes = Math.min(options.maxResponseBytes ?? MAX_RETAINED_PROJECTION_BYTES, MAX_RETAINED_PROJECTION_BYTES);
  const maxProjectionTransferBytes = Math.min(options.maxProjectionTransferBytes ?? MAX_PROJECTION_TRANSFER_BYTES,
    MAX_PROJECTION_TRANSFER_BYTES);
  const webSocketHandshakeTimeoutMs = options.webSocketHandshakeTimeoutMs ?? DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  if (!within(httpTimeoutMs, DEFAULT_HTTP_TIMEOUT_MS)) {
    return new T3TransportError("T3 HTTP timeout must be between 1 and 20000 milliseconds");
  }
  if (!within(maxResponseBytes, MAX_HTTP_RESPONSE_BYTES) || !within(maxProjectionTransferBytes, MAX_PROJECTION_TRANSFER_BYTES)) {
    return new T3TransportError("T3 HTTP response limit must be positive");
  }
  if (!within(webSocketHandshakeTimeoutMs, DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS)) {
    return new T3TransportError("T3 websocket handshake timeout must be between 1 and 10000 milliseconds");
  }
  if (!within(heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS)) {
    return new T3TransportError("T3 websocket heartbeat interval must be between 1 and 15000 milliseconds");
  }
  if (!within(heartbeatTimeoutMs, DEFAULT_HEARTBEAT_TIMEOUT_MS)) {
    return new T3TransportError("T3 websocket heartbeat timeout must be between 1 and 40000 milliseconds");
  }
  baseUrl.username = "";
  baseUrl.password = "";
  baseUrl.search = "";
  baseUrl.hash = "";
  return {
    baseUrl, token: Redacted.make(options.token.trim()), httpTimeoutMs, maxResponseBytes, maxRetainedProjectionBytes,
    maxProjectionTransferBytes, webSocketHandshakeTimeoutMs, heartbeatIntervalMs, heartbeatTimeoutMs,
  };
};

const make = (options: T3ClientOptions): Effect.Effect<T3ClientShape, never, HttpClient.HttpClient | NativeEnvelope> =>
  Effect.gen(function*() {
    const settings = settingsOf(options);
    // invalid options are a construction defect, as they always were
    if (settings instanceof T3TransportError) return yield* Effect.die(settings);
    // the request's fetch is aborted when its scope closes: on completion, failure, timeout or interruption
    const http = HttpClient.withScope(yield* HttpClient.HttpClient);
    const envelope = yield* NativeEnvelope;
    const oversizedUntil = yield* Ref.make<ReadonlyMap<string, bigint>>(new Map());

    // one read-only GET; the whole exchange, body included, is bounded by the HTTP timeout on the Effect clock
    const getJson = <A>(path: string, operation: string, protocolHeader: boolean,
      consume: (response: HttpClientResponse.HttpClientResponse, deadline: number) => Effect.Effect<A, T3TransportError>) =>
      Effect.scoped(Effect.gen(function*() {
        const deadline = (yield* monotonicMillis) + settings.httpTimeoutMs;
        const request = HttpClientRequest.get(new URL(path, settings.baseUrl)).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(settings.token),
          protocolHeader ? HttpClientRequest.setHeader("x-t3-orchestration-protocol", String(ORCHESTRATION_PROTOCOL)) : (same) => same,
        );
        const response = yield* http.execute(request).pipe(
          Effect.mapError(() => new T3TransportError(`T3 ${operation} request failed`)),
        );
        if (response.status < 200 || response.status > 299) {
          return yield* Effect.fail(new T3TransportError(`T3 ${operation} returned HTTP ${response.status}`, response.status));
        }
        return yield* consume(response, deadline);
      })).pipe(
        // no span and no trace headers: the request carries exactly its own headers
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.timeoutOrElse({
          duration: Duration.millis(settings.httpTimeoutMs),
          orElse: () => Effect.fail(new T3TransportError(`T3 ${operation} request timed out`)),
        }),
      );

    const readJson = (operation: string) => (response: HttpClientResponse.HttpClientResponse): Effect.Effect<unknown, T3TransportError> =>
      Effect.gen(function*() {
        if ((declaredBytes(response) ?? 0) > settings.maxResponseBytes) return yield* Effect.fail(tooLarge(operation));
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        yield* response.stream.pipe(
          Stream.mapError(bodyError(operation)),
          Stream.runForEach((chunk) => {
            totalBytes += chunk.byteLength;
            if (totalBytes > settings.maxResponseBytes) return Effect.fail(tooLarge(operation));
            chunks.push(chunk);
            return Effect.void;
          }),
        );
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const value = decodeJson(new TextDecoder().decode(bytes));
        return Option.isSome(value) ? value.value : yield* Effect.fail(new T3TransportError(`T3 ${operation} response was not valid JSON`));
      });

    // the full snapshot streams: arrays the Supervisor never reads are validated and dropped, and only the kept part counts
    // toward the retained budget, while every byte read counts toward the transfer budget
    const readProjectionBody = (response: HttpClientResponse.HttpClientResponse, deadline: number): Effect.Effect<unknown, T3TransportError> =>
      (declaredBytes(response) ?? 0) > settings.maxProjectionTransferBytes
        ? Effect.fail(tooLarge("thread projection"))
        : readProjectionSnapshot(response.stream, {
          retainedBytes: settings.maxRetainedProjectionBytes, transferBytes: settings.maxProjectionTransferBytes, deadline,
        }).pipe(Effect.mapError((error) => error instanceof ProjectionStreamError ? projectionStreamError(error) : bodyError("thread projection")(error)));

    // oversized threads in insertion order, each until a monotonic instant; the oldest is evicted past the limit
    const knownOversized = (threadId: string): Effect.Effect<boolean> => Effect.flatMap(monotonicNanos, (now) =>
      Ref.modify(oversizedUntil, (memo): [boolean, ReadonlyMap<string, bigint>] => {
        const until = memo.get(threadId);
        if (until === undefined) return [false, memo];
        if (until > now) return [true, memo];
        const next = new Map(memo);
        next.delete(threadId);
        return [false, next];
      }));
    const rememberOversized = (threadId: string): Effect.Effect<void> => Effect.flatMap(monotonicNanos, (now) =>
      Ref.update(oversizedUntil, (memo) => {
        const next = new Map(memo);
        next.delete(threadId);
        next.set(threadId, now + OVERSIZED_PROJECTION_MEMO_NANOS);
        while (next.size > OVERSIZED_PROJECTION_MEMO_LIMIT) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        return next;
      }));

    const watch = <E = never, R = never>(cursor: number | undefined, onItem: (item: SourceItem) => Effect.Effect<void, E, R>):
      Effect.Effect<never, T3TransportError | E, R> => {
      if (cursor !== undefined && !isSequence(cursor)) {
        return Effect.fail(new T3TransportError("T3 orchestration cursor must be a non-negative integer"));
      }
      return Effect.scoped(Effect.gen(function*() {
        // one socket with both subscriptions bound to its open; reading pauses while a message is handled
        const connection = yield* envelope.open({
          endpoint: {baseUrl: settings.baseUrl, token: Redacted.value(settings.token)},
          requests: [
            {id: "1", tag: "orchestration.subscribeShell", payload: cursor === undefined ? {} : {afterSequence: cursor}},
            {id: "2", tag: "orchestration.subscribeArchivedShell", payload: {}},
          ],
          maxPayload: nativeMaxPayload.t3,
          handshakeTimeout: Duration.millis(settings.webSocketHandshakeTimeoutMs),
          framing: NativeFraming.walk(MAX_BUFFERED_WEBSOCKET_FRAMES * 1024),
          maxBufferedFrames: MAX_BUFFERED_WEBSOCKET_FRAMES,
          maxBufferedBytes: MAX_BUFFERED_WEBSOCKET_BYTES,
        }).pipe(Effect.mapError(websocketError));
        const awaitingPong = yield* Ref.make(Option.none<Deferred.Deferred<void>>());

        // a chunk is acknowledged only after every item in it was validated and ingested
        const ingest = (stream: SourceItem["stream"], requestId: string, values: ReadonlyArray<unknown>) =>
          Effect.gen(function*() {
            for (const item of values) {
              if (!isShellItem[stream](item)) {
                return yield* Effect.fail(new T3TransportError("T3 subscription item has an unsupported schema or shape"));
              }
              yield* onItem({stream, item: item as JsonRecord});
            }
            yield* connection.send({_tag: "Ack", requestId}).pipe(Effect.mapError(websocketError));
          });

        // the envelope already answered every Ping in order
        const handle = (frame: NativeServerFrame): Effect.Effect<void, T3TransportError | E, R> => {
          switch (frame._tag) {
            case "Ping": return Effect.void;
            case "Pong": return Effect.flatMap(Ref.getAndSet(awaitingPong, Option.none()), Option.match({
              onNone: () => Effect.void,
              onSome: (answered) => Effect.asVoid(Deferred.succeed(answered, undefined)),
            }));
            case "Exit": return Effect.fail(new T3TransportError("T3 subscription ended"));
            case "Defect": return Effect.fail(new T3TransportError("T3 subscription failed"));
            case "Chunk":
              if (frame.requestId === "1") return ingest("active", frame.requestId, frame.values);
              if (frame.requestId === "2") return ingest("archive", frame.requestId, frame.values);
              return Effect.fail(new T3TransportError("T3 websocket message used an unsupported protocol frame"));
            case "Other": return Effect.fail(new T3TransportError("T3 websocket message used an unsupported protocol frame"));
          }
        };
        const frames = Effect.forever(connection.receive(handle).pipe(
          Effect.mapError((error) => error instanceof NativeEnvelopeError ? websocketError(error) : error),
        ));

        // every interval a Ping, then its Pong within the timeout counted from the Ping
        const beat = Effect.gen(function*() {
          const answered = yield* Deferred.make<void>();
          yield* Ref.set(awaitingPong, Option.some(answered));
          yield* connection.send({_tag: "Ping"}).pipe(
            Effect.mapError((error) => new T3TransportError(error.reason === "not_open"
              ? "T3 websocket heartbeat found a closed connection"
              : "T3 websocket heartbeat send failed")),
            Effect.andThen(Deferred.await(answered)),
            Effect.timeoutOrElse({
              duration: Duration.millis(settings.heartbeatTimeoutMs),
              orElse: () => Effect.fail(new T3TransportError("T3 websocket heartbeat timed out")),
            }),
          );
        });
        const heartbeat = Effect.forever(Effect.delay(beat, Duration.millis(settings.heartbeatIntervalMs)));

        return yield* Effect.raceFirst(frames, heartbeat);
      }));
    };

    return T3Client.of({
      descriptor: () => getJson("/.well-known/t3/environment", "environment descriptor", false, readJson("environment descriptor")).pipe(
        Effect.flatMap((value) => isDescriptor(value)
          ? Effect.succeed(value as T3EnvironmentDescriptor)
          : Effect.fail(new T3TransportError("T3 environment descriptor has an unsupported protocol or shape"))),
      ),
      projection: (threadId) => Effect.gen(function*() {
        if (!isNonBlank(threadId)) return yield* Effect.fail(new T3TransportError("T3 thread id must not be empty"));
        // a snapshot that exceeded a byte budget is deterministic; it is not fetched again within the memo period
        if (yield* knownOversized(threadId)) return yield* Effect.fail(tooLarge("thread projection"));
        const value = yield* getJson(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, "thread projection", true,
          readProjectionBody).pipe(Effect.tapError((error) => error.code === "response_too_large" ? rememberOversized(threadId) : Effect.void));
        if (!isProjectionSnapshot(value) || value.projection.thread.id !== threadId) {
          return yield* Effect.fail(new T3TransportError("T3 thread projection has an unsupported schema or shape"));
        }
        return value as unknown as T3ProjectionSnapshot;
      }),
      watch,
    });
  });

export class T3Client extends Context.Service<T3Client, T3ClientShape>()("T3Client") {
  // the client over an HTTP client (fetch, which decodes content encodings) and the shared native envelope
  static readonly layer = (options: T3ClientOptions): Layer.Layer<T3Client, never, HttpClient.HttpClient | NativeEnvelope> =>
    Layer.effect(T3Client, make(options));
}

export const makeT3Client = (options: T3ClientOptions): Layer.Layer<T3Client> =>
  T3Client.layer(options).pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, NativeEnvelope.layer)));
