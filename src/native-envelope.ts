import { Context, Deferred, Duration, Effect, Layer, Option, Schema, Scope } from "effect";
import WebSocket from "ws";

// the one native T3 websocket envelope (D-08) for t3.ts, supervisor-native.ts, project-files.ts and git-probe.ts
// a small scoped adapter over ws: effect 4.0.6 RpcClient over Socket writes Interrupt frames, Acks before consumption and ignores server Pings

const MiB = 1024 * 1024;

// per-call ws maxPayload of each native client (plan 3.6)
export const nativeMaxPayload = { t3: 32 * MiB, native: 8 * MiB, files: 2 * MiB, probe: 2 * MiB } as const;

// rejected: the request frame never left; uncertain: it was handed to the socket, so T3 may have acted on it
export const NativeOutcome = Schema.Literals(["rejected", "uncertain"]);
export type NativeOutcome = typeof NativeOutcome.Type;

export const NativeFailure = Schema.Literals([
  "cancelled", "timed_out", "handshake_timed_out", "connect_failed", "closed_before_open", "socket_failed",
  "socket_closed", "not_open", "send_failed", "binary_frame", "malformed_json", "invalid_frame", "buffer_overflow",
]);
export type NativeFailure = typeof NativeFailure.Type;

// sanitized: a reason code and the sent-boundary outcome only, never a url, token, cause or native body
export class NativeEnvelopeError extends Schema.TaggedError<NativeEnvelopeError>()("NativeEnvelopeError", {
  reason: NativeFailure,
  outcome: NativeOutcome,
}) {}

export interface NativeEndpoint {
  // the T3 http(s) base url; the socket dials /ws?orchestrationProtocol=2 on it
  readonly baseUrl: string | URL;
  readonly token: string;
}

export interface NativeRequest {
  readonly id: string;
  readonly tag: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// the frames a client writes, in their exact wire text
export type NativeClientFrame = { readonly _tag: "Ping" } | { readonly _tag: "Pong" } | { readonly _tag: "Ack"; readonly requestId: string };

export const encodeRequest = (request: NativeRequest): string =>
  JSON.stringify({ _tag: "Request", id: request.id, tag: request.tag, payload: request.payload, headers: [] });

export const encodeClientFrame = (frame: NativeClientFrame): string =>
  frame._tag === "Ack" ? JSON.stringify({ _tag: "Ack", requestId: frame.requestId }) : JSON.stringify({ _tag: frame._tag });

// an Exit body: Success, Failure and any other record keep the raw native value; Malformed is not a record
export type NativeExit =
  | { readonly _tag: "Success"; readonly value: unknown }
  | { readonly _tag: "Failure"; readonly exit: Readonly<Record<string, unknown>> }
  | { readonly _tag: "Unknown"; readonly exit: Readonly<Record<string, unknown>> }
  | { readonly _tag: "Malformed" };

// one server envelope; Other is any further record, a Chunk without a string requestId and array values included
export type NativeServerFrame =
  | { readonly _tag: "Ping" }
  | { readonly _tag: "Pong" }
  | { readonly _tag: "Chunk"; readonly requestId: string; readonly values: ReadonlyArray<unknown> }
  | { readonly _tag: "Exit"; readonly requestId: unknown; readonly exit: NativeExit }
  | { readonly _tag: "Defect" }
  | { readonly _tag: "Other"; readonly frame: Readonly<Record<string, unknown>> };

// how one websocket message holding an envelope or a batched array becomes envelopes
export type NativeFraming =
  | { readonly _tag: "Flat"; readonly depth: number }
  | { readonly _tag: "FlatChecked"; readonly depth: number; readonly maxEnvelopes: number }
  | { readonly _tag: "Walk"; readonly maxVisits: number };

export const NativeFraming = {
  // arrays flattened `depth` levels in order; a deeper array or another non-record fails when it is reached
  flat: (depth: number): NativeFraming => ({ _tag: "Flat", depth }),
  // as flat, but the whole message must be records and at most maxEnvelopes before any envelope is handled
  flatChecked: (depth: number, maxEnvelopes: number): NativeFraming => ({ _tag: "FlatChecked", depth, maxEnvelopes }),
  // any nesting walked in order, at most maxVisits arrays and records, non-empty and checked before any envelope is handled
  walk: (maxVisits: number): NativeFraming => ({ _tag: "Walk", maxVisits }),
} as const;

// what a call does after its consumer handled a Chunk or its Exit
export type NativeStep<A, E = never, R = never> =
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Ack"; readonly afterAck: Effect.Effect<void, E, R> }
  | { readonly _tag: "Done"; readonly value: A };
export type NativeExitStep<A> = { readonly _tag: "Continue" } | { readonly _tag: "Done"; readonly value: A };

export const NativeStep = {
  // keep waiting without an Ack
  continue: { _tag: "Continue" } as const,
  // write the Ack, then run afterAck once ws wrote it
  ack: <E = never, R = never>(afterAck: Effect.Effect<void, E, R> = Effect.void): NativeStep<never, E, R> => ({ _tag: "Ack", afterAck }),
  // end the call with this value, without an Ack
  done: <A>(value: A): { readonly _tag: "Done"; readonly value: A } => ({ _tag: "Done", value }),
} as const;

// one request on its own socket: the frame is bound when the socket is created and written when it opens
export interface NativeCall<A, E = never, R = never> {
  readonly endpoint: NativeEndpoint;
  readonly request: NativeRequest;
  readonly maxPayload: number;
  readonly handshakeTimeout: Duration.Input;
  // deadline of the whole call, connection included
  readonly timeout?: Duration.Input | undefined;
  // default NativeFraming.flat(4)
  readonly framing?: NativeFraming | undefined;
  // completing it ends the call as `cancelled`; already completed, no connection is made
  readonly cancel?: Deferred.Deferred<void> | undefined;
  // the values of each Chunk for this request; without it those Chunks are ignored and never acknowledged
  readonly onChunk?: ((values: ReadonlyArray<unknown>) => Effect.Effect<NativeStep<A, E, R>, E, R>) | undefined;
  // the Exit for this request; Exits for other request ids are ignored
  readonly onExit: (exit: NativeExit) => Effect.Effect<NativeExitStep<A>, E, R>;
}

// an initiated call (plan 3.11): the request is committed, result runs it and release terminates the socket
export interface NativeInFlight<A, E = never, R = never> {
  // the request frame was handed to ws; an interrupted or failed call is uncertain from then on
  readonly sent: Effect.Effect<boolean>;
  readonly result: Effect.Effect<A, NativeEnvelopeError | E, R>;
  // terminates the socket without writing any frame; idempotent
  readonly release: Effect.Effect<void>;
}

export interface NativeOpenOptions {
  readonly endpoint: NativeEndpoint;
  // written in order when the socket opens
  readonly requests: ReadonlyArray<NativeRequest>;
  readonly maxPayload: number;
  readonly handshakeTimeout: Duration.Input;
  readonly framing: NativeFraming;
  // received messages held at once, the one being handled included; one more terminates the socket
  readonly maxBufferedFrames?: number | undefined;
  readonly maxBufferedBytes?: number | undefined;
}

// a socket owned by a scope that terminates it on release
export interface NativeConnection {
  readonly sent: Effect.Effect<boolean>;
  // handles the next message: Pings are answered in order and every other envelope goes to handle; reading stays paused until it finished
  readonly receive: <E, R>(handle: (envelope: NativeServerFrame) => Effect.Effect<void, E, R>) => Effect.Effect<void, NativeEnvelopeError | E, R>;
  // writes one client frame and waits until ws wrote it
  readonly send: (frame: NativeClientFrame) => Effect.Effect<void, NativeEnvelopeError>;
}

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const isRecord = Schema.is(JsonRecord);
const KnownEnvelope = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ping") }),
  Schema.Struct({ _tag: Schema.Literal("Pong") }),
  Schema.Struct({ _tag: Schema.Literal("Chunk"), requestId: Schema.String, values: Schema.Array(Schema.Unknown) }),
  Schema.Struct({ _tag: Schema.Literal("Exit"), requestId: Schema.optionalKey(Schema.Unknown), exit: Schema.optionalKey(Schema.Unknown) }),
  Schema.Struct({ _tag: Schema.Literal("Defect") }),
]);
const decodeKnownEnvelope = Schema.decodeUnknownOption(KnownEnvelope);
const decodeExitSuccess = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.optionalKey(Schema.Unknown) }));
const isExitFailure = Schema.is(Schema.Struct({ _tag: Schema.Literal("Failure") }));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const nativeExit = (exit: unknown): NativeExit => {
  if (!isRecord(exit)) return { _tag: "Malformed" };
  const success = decodeExitSuccess(exit);
  if (Option.isSome(success)) return { _tag: "Success", value: success.value.value };
  return isExitFailure(exit) ? { _tag: "Failure", exit } : { _tag: "Unknown", exit };
};

type Item = NativeServerFrame | { readonly _tag: "Invalid" };
const invalid: Item = { _tag: "Invalid" };

const item = (value: unknown): Item => {
  const known = decodeKnownEnvelope(value);
  if (Option.isNone(known)) return isRecord(value) ? { _tag: "Other", frame: value } : invalid;
  const frame = known.value;
  switch (frame._tag) {
    case "Chunk": return { _tag: "Chunk", requestId: frame.requestId, values: frame.values };
    case "Exit": return { _tag: "Exit", requestId: frame.requestId, exit: nativeExit(frame.exit) };
    default: return { _tag: frame._tag };
  }
};

// t3's depth-first walk: arrays and records count as visits, leaves stay in order
const walk = (input: unknown, maxVisits: number): ReadonlyArray<unknown> | undefined => {
  const leaves: unknown[] = [];
  const pending: unknown[] = [input];
  let visits = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visits += 1;
    if (visits > maxVisits) return undefined;
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }
    if (!isRecord(current)) return undefined;
    leaves.push(current);
  }
  return leaves.length === 0 ? undefined : leaves;
};

const rawText = (data: WebSocket.RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
};

const rawBytes = (data: WebSocket.RawData): number =>
  Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;

const decodeMessage = (data: WebSocket.RawData, framing: NativeFraming): ReadonlyArray<Item> | "malformed_json" | "invalid_frame" => {
  const parsed = decodeJson(rawText(data));
  if (Option.isNone(parsed)) return "malformed_json";
  const value = parsed.value;
  switch (framing._tag) {
    case "Flat":
      return (Array.isArray(value) ? value.flat(framing.depth) as ReadonlyArray<unknown> : [value]).map(item);
    case "FlatChecked": {
      const leaves: ReadonlyArray<unknown> = Array.isArray(value) ? value.flat(framing.depth) : [value];
      return leaves.length > framing.maxEnvelopes || !leaves.every(isRecord) ? "invalid_frame" : leaves.map(item);
    }
    case "Walk": {
      const leaves = walk(value, framing.maxVisits);
      return leaves === undefined ? "invalid_frame" : leaves.map(item);
    }
  }
};

interface Message {
  readonly data: WebSocket.RawData;
  readonly binary: boolean;
  readonly bytes: number;
}

interface LinkOptions {
  readonly endpoint: NativeEndpoint;
  readonly requests: ReadonlyArray<NativeRequest>;
  readonly maxPayload: number;
  readonly cancel: Deferred.Deferred<void> | undefined;
  readonly maxBufferedFrames: number;
  readonly maxBufferedBytes: number;
  // a call still handles what arrived before its socket failed; a connection reports the failure first, as t3 does
  readonly drainBeforeFailure: boolean;
}

interface Link {
  readonly sent: () => boolean;
  readonly opened: Effect.Effect<void, NativeEnvelopeError>;
  readonly take: Effect.Effect<Message, NativeEnvelopeError>;
  readonly done: (message: Message) => void;
  readonly error: (reason: NativeFailure) => NativeEnvelopeError;
  // records the failure if it is the first, terminates the socket and returns an error with this reason
  readonly abort: (reason: NativeFailure) => NativeEnvelopeError;
  readonly write: (text: string) => Effect.Effect<void, NativeEnvelopeError>;
  readonly writeNow: (text: string) => Effect.Effect<void, NativeEnvelopeError>;
  readonly close: () => void;
}

const websocketUrl = (baseUrl: string | URL): URL => {
  const url = new URL("/ws?orchestrationProtocol=2", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
};

// a link that failed before any socket existed
const failedLink = (reason: NativeFailure): Link => {
  const error = new NativeEnvelopeError({ reason, outcome: "rejected" });
  return {
    sent: () => false,
    opened: Effect.fail(error),
    take: Effect.fail(error),
    done: () => undefined,
    error: (next) => new NativeEnvelopeError({ reason: next, outcome: "rejected" }),
    abort: (next) => new NativeEnvelopeError({ reason: next, outcome: "rejected" }),
    write: () => Effect.fail(error),
    writeNow: () => Effect.fail(error),
    close: () => undefined,
  };
};

// creates the socket with every listener attached at once; a permanent error listener keeps a late handshake error handled
const makeLink = (options: LinkOptions): Link => {
  if (options.cancel !== undefined && Deferred.isDoneUnsafe(options.cancel)) return failedLink("cancelled");
  let ws: WebSocket;
  try {
    ws = new WebSocket(websocketUrl(options.endpoint.baseUrl), {
      headers: { Authorization: `Bearer ${options.endpoint.token}` },
      maxPayload: options.maxPayload,
    });
  } catch {
    return failedLink("connect_failed");
  }
  ws.on("error", () => undefined);

  let open = false;
  let sent = false;
  let closed = false;
  let failure: NativeEnvelopeError | undefined;
  let frames: Message[] = [];
  let bufferedFrames = 0;
  let bufferedBytes = 0;
  let waiter: ((effect: Effect.Effect<Message, NativeEnvelopeError>) => void) | undefined;
  let openWaiter: ((effect: Effect.Effect<void, NativeEnvelopeError>) => void) | undefined;

  const error = (reason: NativeFailure) => new NativeEnvelopeError({ reason, outcome: sent ? "uncertain" : "rejected" });
  const abort = (reason: NativeFailure): NativeEnvelopeError => {
    const next = error(reason);
    if (failure === undefined) failure = next;
    ws.terminate();
    const pendingOpen = openWaiter;
    openWaiter = undefined;
    pendingOpen?.(Effect.fail(failure));
    if (waiter !== undefined && (!options.drainBeforeFailure || frames.length === 0)) {
      const pending = waiter;
      waiter = undefined;
      pending(Effect.fail(failure));
    }
    return next;
  };
  const fail = (reason: NativeFailure): void => {
    if (!closed && failure === undefined) abort(reason);
  };

  const onOpen = () => {
    if (closed || failure !== undefined) return;
    if (options.cancel !== undefined && Deferred.isDoneUnsafe(options.cancel)) return fail("cancelled");
    if (ws.readyState !== WebSocket.OPEN) return fail("closed_before_open");
    open = true;
    for (const request of options.requests) {
      sent = true;
      try {
        ws.send(encodeRequest(request), (cause) => {if (cause) fail("send_failed");});
      } catch {
        return fail("send_failed");
      }
    }
    const pending = openWaiter;
    openWaiter = undefined;
    pending?.(Effect.void);
  };
  const onMessage = (data: WebSocket.RawData, binary: boolean) => {
    if (closed || failure !== undefined) return;
    ws.pause();
    const bytes = rawBytes(data);
    if (bufferedFrames >= options.maxBufferedFrames || bufferedBytes + bytes > options.maxBufferedBytes) return fail("buffer_overflow");
    bufferedFrames += 1;
    bufferedBytes += bytes;
    const message = { data, binary, bytes };
    const pending = waiter;
    waiter = undefined;
    if (pending !== undefined) pending(Effect.succeed(message));
    else frames.push(message);
  };
  const onError = () => fail(open ? "socket_failed" : "connect_failed");
  const onClose = () => fail(open ? "socket_closed" : "closed_before_open");
  ws.on("open", onOpen);
  ws.on("message", onMessage);
  ws.on("error", onError);
  ws.on("close", onClose);

  return {
    sent: () => sent,
    opened: Effect.callback<void, NativeEnvelopeError>((resume) => {
      if (failure !== undefined) return resume(Effect.fail(failure));
      if (open) return resume(Effect.void);
      openWaiter = resume;
      return Effect.sync(() => {
        if (openWaiter === resume) openWaiter = undefined;
      });
    }),
    take: Effect.callback<Message, NativeEnvelopeError>((resume) => {
      if (failure !== undefined && !options.drainBeforeFailure) return resume(Effect.fail(failure));
      const message = frames.shift();
      if (message !== undefined) return resume(Effect.succeed(message));
      if (failure !== undefined) return resume(Effect.fail(failure));
      waiter = resume;
      return Effect.sync(() => {
        if (waiter === resume) waiter = undefined;
      });
    }),
    done: (message) => {
      bufferedFrames = Math.max(0, bufferedFrames - 1);
      bufferedBytes = Math.max(0, bufferedBytes - message.bytes);
      if (!closed && failure === undefined) ws.resume();
    },
    error,
    abort,
    write: (text) => Effect.callback<void, NativeEnvelopeError>((resume) => {
      if (ws.readyState !== WebSocket.OPEN) return resume(Effect.fail(error("not_open")));
      ws.send(text, (cause) => resume(cause ? Effect.fail(error("send_failed")) : Effect.void));
    }),
    writeNow: (text) => Effect.suspend(() => {
      if (ws.readyState !== WebSocket.OPEN) return Effect.fail(error("not_open"));
      try {
        ws.send(text, (cause) => {if (cause) fail("send_failed");});
      } catch {
        return Effect.fail(error("send_failed"));
      }
      return Effect.void;
    }),
    close: () => {
      if (closed) return;
      closed = true;
      ws.off("open", onOpen);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
      frames = [];
      waiter = undefined;
      openWaiter = undefined;
      ws.terminate();
    },
  };
};

const awaitOpen = (link: Link, handshakeTimeout: Duration.Input) =>
  link.opened.pipe(Effect.timeoutOrElse({
    duration: handshakeTimeout,
    orElse: () => Effect.suspend(() => Effect.fail(link.abort("handshake_timed_out"))),
  }));

// handles one message; a Some from handle ends it early
const receiveMessage = <A, E, R>(link: Link, framing: NativeFraming,
  handle: (envelope: NativeServerFrame) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<Option.Option<A>, NativeEnvelopeError | E, R> =>
  Effect.flatMap(link.take, (message) => Effect.gen(function*() {
    if (message.binary) return yield* Effect.fail(link.error("binary_frame"));
    const items = decodeMessage(message.data, framing);
    if (typeof items === "string") return yield* Effect.fail(link.error(items));
    for (const current of items) {
      if (current._tag === "Invalid") return yield* Effect.fail(link.error("invalid_frame"));
      if (current._tag === "Ping") {
        yield* link.writeNow(encodeClientFrame({ _tag: "Pong" }));
        continue;
      }
      const result = yield* handle(current);
      if (Option.isSome(result)) return result;
    }
    return Option.none<A>();
  }).pipe(Effect.ensuring(Effect.sync(() => link.done(message)))));

const runCall = <A, E, R>(link: Link, call: NativeCall<A, E, R>): Effect.Effect<A, NativeEnvelopeError | E, R> => {
  const framing = call.framing ?? NativeFraming.flat(4);
  const requestId = call.request.id;
  const dispatch = (envelope: NativeServerFrame): Effect.Effect<Option.Option<A>, NativeEnvelopeError | E, R> => {
    if (envelope._tag === "Exit" && envelope.requestId === requestId) {
      return Effect.map(call.onExit(envelope.exit), (step) => step._tag === "Done" ? Option.some(step.value) : Option.none());
    }
    if (envelope._tag !== "Chunk" || envelope.requestId !== requestId || call.onChunk === undefined) return Effect.succeed(Option.none());
    return Effect.flatMap(call.onChunk(envelope.values), (step): Effect.Effect<Option.Option<A>, NativeEnvelopeError | E, R> => {
      if (step._tag === "Done") return Effect.succeed(Option.some(step.value));
      if (step._tag === "Continue") return Effect.succeed(Option.none());
      return link.write(encodeClientFrame({ _tag: "Ack", requestId })).pipe(Effect.andThen(step.afterAck), Effect.as(Option.none()));
    });
  };
  const loop = Effect.gen(function*() {
    yield* awaitOpen(link, call.handshakeTimeout);
    for (;;) {
      const result = yield* receiveMessage(link, framing, dispatch);
      if (Option.isSome(result)) return result.value;
    }
  });
  const cancellable = call.cancel === undefined ? loop : Effect.raceFirst(loop,
    Deferred.await(call.cancel).pipe(Effect.andThen(Effect.suspend(() => Effect.fail(link.abort("cancelled"))))));
  return call.timeout === undefined ? cancellable : cancellable.pipe(Effect.timeoutOrElse({
    duration: call.timeout,
    orElse: () => Effect.suspend(() => Effect.fail(link.abort("timed_out"))),
  }));
};

const initiate = <A, E = never, R = never>(call: NativeCall<A, E, R>): Effect.Effect<NativeInFlight<A, E, R>> => Effect.sync(() => {
  const link = makeLink({
    endpoint: call.endpoint,
    requests: [call.request],
    maxPayload: call.maxPayload,
    cancel: call.cancel,
    maxBufferedFrames: Number.POSITIVE_INFINITY,
    maxBufferedBytes: Number.POSITIVE_INFINITY,
    drainBeforeFailure: true,
  });
  return { sent: Effect.sync(link.sent), result: runCall(link, call), release: Effect.sync(link.close) };
});

const call = <A, E = never, R = never>(spec: NativeCall<A, E, R>): Effect.Effect<A, NativeEnvelopeError | E, R> =>
  Effect.acquireUseRelease(initiate(spec), (flight) => flight.result, (flight) => flight.release);

const open = (options: NativeOpenOptions): Effect.Effect<NativeConnection, NativeEnvelopeError, Scope.Scope> => Effect.gen(function*() {
  const link = yield* Effect.acquireRelease(Effect.sync(() => makeLink({
    endpoint: options.endpoint,
    requests: options.requests,
    maxPayload: options.maxPayload,
    cancel: undefined,
    maxBufferedFrames: options.maxBufferedFrames ?? Number.POSITIVE_INFINITY,
    maxBufferedBytes: options.maxBufferedBytes ?? Number.POSITIVE_INFINITY,
    drainBeforeFailure: false,
  })), (opened) => Effect.sync(opened.close));
  yield* awaitOpen(link, options.handshakeTimeout);
  return {
    sent: Effect.sync(link.sent),
    receive: <E, R>(handle: (envelope: NativeServerFrame) => Effect.Effect<void, E, R>) =>
      Effect.asVoid(receiveMessage(link, options.framing, (envelope) => Effect.as(handle(envelope), Option.none<never>()))),
    send: (frame: NativeClientFrame) => link.write(encodeClientFrame(frame)),
  };
});

// a cancel trigger completed when the signal aborts, for callers that still pass an AbortSignal; the listener lives in the scope
export const cancelOnAbort = (signal: AbortSignal): Effect.Effect<Deferred.Deferred<void>, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(() => {
    const cancel = Deferred.makeUnsafe<void>();
    const onAbort = () => {Deferred.doneUnsafe(cancel, Effect.void);};
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return { cancel, onAbort };
  }), ({ onAbort }) => Effect.sync(() => signal.removeEventListener("abort", onAbort))).pipe(Effect.map(({ cancel }) => cancel));

export class NativeEnvelope extends Context.Service<NativeEnvelope, {
  // commits the request synchronously: the socket exists with the frame bound to its open
  readonly initiate: <A, E = never, R = never>(call: NativeCall<A, E, R>) => Effect.Effect<NativeInFlight<A, E, R>>;
  // initiate, run and release; an interruption terminates the socket and writes nothing
  readonly call: <A, E = never, R = never>(call: NativeCall<A, E, R>) => Effect.Effect<A, NativeEnvelopeError | E, R>;
  // a scoped socket for long-lived subscriptions with their own envelope handling
  readonly open: (options: NativeOpenOptions) => Effect.Effect<NativeConnection, NativeEnvelopeError, Scope.Scope>;
}>()("t3-supervisor/NativeEnvelope") {
  static readonly layer: Layer.Layer<NativeEnvelope> = Layer.succeed(NativeEnvelope, NativeEnvelope.of({ initiate, call, open }));
}
