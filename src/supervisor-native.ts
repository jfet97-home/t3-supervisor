import { Context, Data, type Deferred, Effect, Layer, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import {
  NativeEnvelope, nativeMaxPayload, NativeStep, type NativeCall, type NativeEndpoint, type NativeEnvelopeError, type NativeExit, type NativeExitStep,
  type NativeOutcome,
} from "./native-envelope.js";
import type { SupervisorModelInfo, SupervisorModelSelection } from "./project-supervisor-contract.js";
import type { SupervisorBaseline } from "./project-supervisor-store.js";
import type { ThreadInfo } from "./types.js";

// the classification callers reconcile on; the message never carries a credential, url or native body
export class SupervisorRpcError extends Data.TaggedError("SupervisorRpcError")<{
  readonly outcome: NativeOutcome;
  readonly definiteRejection: boolean;
  readonly providerDisabled: boolean;
  readonly dispatchCommandFailure: boolean;
  readonly message: string;
}> {
  // positional, as the unported callers construct it
  constructor(outcome: NativeOutcome, definiteRejection = false, providerDisabled = false, dispatchCommandFailure = false) {
    super({ outcome, definiteRejection, providerDisabled, dispatchCommandFailure, message: "T3 Supervisor access is unavailable." });
  }
}

export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const rejectedByName = (value: unknown, name: string, depth = 0): boolean => {
  if (depth > 20 || !record(value)) return false;
  if (value.name === name || value._tag === name) return true;
  return Object.values(value).some(child => Array.isArray(child) ? child.some(item => rejectedByName(item, name, depth + 1)) : rejectedByName(child, name, depth + 1));
};

// the promise call shape the unported classes still receive; guidance-application.ts builds it over NativeRpc (B-03)
export type SupervisorRpc = (tag: string, payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

// a committed request (plan 3.11): sent turns true when the frame was handed to ws, from then on any failure is uncertain
export interface NativeRpcInFlight {
  readonly sent: Effect.Effect<boolean>;
  readonly result: Effect.Effect<unknown, SupervisorRpcError>;
  // terminates the socket without writing any frame; idempotent
  readonly release: Effect.Effect<void>;
}

export interface NativeRpcShape {
  // one bounded request on its own socket; a completed cancel ends it at the sent boundary, an interruption writes nothing more
  readonly call: (tag: string, payload: Readonly<Record<string, unknown>>, cancel?: Deferred.Deferred<void>) => Effect.Effect<unknown, SupervisorRpcError>;
  // commits the request synchronously, for admission sections that must know whether it left before they yield
  readonly initiate: (tag: string, payload: Readonly<Record<string, unknown>>, cancel?: Deferred.Deferred<void>) => Effect.Effect<NativeRpcInFlight>;
}

// a definite rejection only when T3 says the command was already rejected or its provider is disabled; anything else may have acted
const exitFailure = (tag: string, exit: Readonly<Record<string, unknown>>): SupervisorRpcError => {
  const providerDisabled = rejectedByName(exit, "ThreadManagementProviderInstanceDisabledError");
  const definite = providerDisabled || rejectedByName(exit, "OrchestratorCommandPreviouslyRejectedError");
  const dispatchCommandFailure = tag === "orchestration.dispatchCommand" && rejectedByName(exit, "OrchestrationV2DispatchCommandError");
  return new SupervisorRpcError(definite ? "rejected" : "uncertain", definite, providerDisabled, dispatchCommandFailure);
};

// an Exit arrives only after the request left, so a malformed one is uncertain
const settle = (tag: string) => (exit: NativeExit): Effect.Effect<NativeExitStep<unknown>, SupervisorRpcError> => {
  switch (exit._tag) {
    case "Success": return Effect.succeed(NativeStep.done(exit.value));
    case "Malformed": return Effect.fail(new SupervisorRpcError("uncertain"));
    default: return Effect.fail(exitFailure(tag, exit.exit));
  }
};

const classified = <A>(effect: Effect.Effect<A, NativeEnvelopeError | SupervisorRpcError>): Effect.Effect<A, SupervisorRpcError> =>
  effect.pipe(Effect.catchTag("NativeEnvelopeError", (error) => Effect.fail(new SupervisorRpcError(error.outcome))));

const makeNativeRpc = (endpoint: NativeEndpoint): Effect.Effect<NativeRpcShape, never, NativeEnvelope> => Effect.gen(function* () {
  const envelope = yield* NativeEnvelope;
  // 8 MiB frames, 5 s handshake, 20 s for the whole call, chunks ignored
  const native = (tag: string, payload: Readonly<Record<string, unknown>>, cancel: Deferred.Deferred<void> | undefined): NativeCall<unknown, SupervisorRpcError> => ({
    endpoint,
    request: { id: "supervisor", tag, payload },
    maxPayload: nativeMaxPayload.native,
    handshakeTimeout: "5 seconds",
    timeout: "20 seconds",
    cancel,
    onExit: settle(tag),
  });
  return {
    call: (tag, payload, cancel) => classified(envelope.call(native(tag, payload, cancel))),
    initiate: (tag, payload, cancel) => Effect.map(envelope.initiate(native(tag, payload, cancel)),
      (flight) => ({ sent: flight.sent, result: classified(flight.result), release: flight.release })),
  };
});

// the native client of the read credential
export class NativeRpc extends Context.Service<NativeRpc, NativeRpcShape>()("t3-supervisor/NativeRpc") {
  static readonly make = makeNativeRpc;
  static readonly layer = (endpoint: NativeEndpoint): Layer.Layer<NativeRpc, never, NativeEnvelope> => Layer.effect(NativeRpc, makeNativeRpc(endpoint));
}

// the native client of the guidance credential, which operates T3 beside the read client
export class NativeOperateRpc extends Context.Service<NativeOperateRpc, NativeRpcShape>()("t3-supervisor/NativeOperateRpc") {
  static readonly layer = (endpoint: NativeEndpoint): Layer.Layer<NativeOperateRpc, never, NativeEnvelope> => Layer.effect(NativeOperateRpc, makeNativeRpc(endpoint));
}

const maxShellBytes = 8 * 1024 * 1024;
const maxShellThreads = 10_000;

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ShellAnchor = Schema.Struct({ id: Text, latestRunId: Schema.NullOr(Text) });
// the active shell over http; its archived list is checked for overlap and dropped
const isShellSnapshot = Schema.is(Schema.Struct({
  schemaVersion: Schema.Literal(2),
  snapshotSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  threads: Schema.Array(ShellAnchor),
  archivedThreads: Schema.Array(ShellAnchor),
}));
// the archived shell over NativeRpc; each read checks its threads as it needs them
const isArchivedShellSnapshot = Schema.is(Schema.Struct({
  schemaVersion: Schema.Literal(2),
  snapshotSequence: Schema.Number.check(Schema.isInt()),
  threads: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(maxShellThreads)),
}));
const isShellAnchor = Schema.is(ShellAnchor);
// a guard keeps the native value whole, so a thread keeps every field T3 sent
const isNativeThread: (value: unknown) => value is ThreadInfo = Schema.is(Schema.Struct({
  id: Text,
  title: Schema.String,
  projectId: Schema.NullOr(Text),
  lineage: Schema.Struct({ parentThreadId: Schema.NullOr(Text), relationshipToParent: Schema.NullOr(Schema.Literals(["subagent", "fork"])) }),
}));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

// the two views did not describe one revision; the pair is read again
class ShellIncoherent extends Data.TaggedError("ShellIncoherent") {}

const rejected = () => new SupervisorRpcError("rejected");

// at most 8 MiB of body, decoded as utf-8 like the byte buffer it replaces
const boundedBody = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<string, SupervisorRpcError> =>
  response.stream.pipe(
    Stream.mapError(rejected),
    Stream.runFoldEffect(() => ({ bytes: 0, chunks: [] as Uint8Array[] }), (body, chunk) => {
      body.bytes += chunk.length;
      if (body.bytes > maxShellBytes) return Effect.fail(rejected());
      body.chunks.push(chunk);
      return Effect.succeed(body);
    }),
    Effect.map((body) => Buffer.concat(body.chunks).toString("utf8")),
  );

// a refused read releases its connection: the stream aborts the request once its first chunk was taken
const refusedBody = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<never, SupervisorRpcError> =>
  Stream.runHead(response.stream).pipe(Effect.ignore, Effect.andThen(Effect.fail(rejected())));

const makeNativeShell = (endpoint: NativeEndpoint): Effect.Effect<NativeShellShape, never, NativeRpc | HttpClient.HttpClient> => Effect.gen(function* () {
  const rpc = yield* NativeRpc;
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(new URL("/api/orchestration/shell", endpoint.baseUrl)).pipe(
    HttpClientRequest.setHeaders({ Authorization: `Bearer ${endpoint.token}`, "x-t3-orchestration-protocol": "2" }));
  // the bounded active shell, without relying on limited event replay; no client span and no trace headers to T3
  const active = client.execute(request).pipe(
    Effect.mapError(rejected),
    Effect.flatMap((response) => response.status >= 200 && response.status < 300 ? boundedBody(response) : refusedBody(response)),
    Effect.flatMap((body) => Effect.mapError(decodeJson(body), rejected)),
    Effect.flatMap((value) => {
      if (!isShellSnapshot(value)) return Effect.fail(rejected());
      const threads = [...value.threads, ...value.archivedThreads];
      if (threads.length > maxShellThreads || new Set(threads.map((thread) => thread.id)).size !== threads.length) return Effect.fail(rejected());
      return Effect.succeed({ snapshotSequence: value.snapshotSequence, threads: value.threads });
    }),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(rejected()) }),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  );
  const pair = Effect.all([active, rpc.call("orchestration.getArchivedShellSnapshot", {})], { concurrency: 2 });
  // three pairs at most, then fail closed
  const coherent = <A>(read: Effect.Effect<A, SupervisorRpcError | ShellIncoherent>): Effect.Effect<A, SupervisorRpcError> => read.pipe(
    Effect.retry({ times: 2, while: (error) => error._tag === "ShellIncoherent" }),
    Effect.catchTag("ShellIncoherent", () => Effect.fail(rejected())),
  );
  const baseline = coherent(Effect.gen(function* () {
    const [shell, archived] = yield* pair;
    if (!isArchivedShellSnapshot(archived) || !archived.threads.every(isShellAnchor)) return yield* rejected();
    if (archived.snapshotSequence !== shell.snapshotSequence) return yield* new ShellIncoherent();
    const threads = new Map(shell.threads.map((thread) => [thread.id, { id: thread.id, latestRunId: thread.latestRunId }]));
    const seen = new Set<string>();
    for (const thread of archived.threads) {
      if (seen.has(thread.id)) return yield* rejected();
      seen.add(thread.id);
      if (threads.has(thread.id)) return yield* new ShellIncoherent();
      threads.set(thread.id, { id: thread.id, latestRunId: thread.latestRunId });
    }
    if (threads.size > maxShellThreads) return yield* rejected();
    return { snapshotSequence: shell.snapshotSequence, threads: [...threads.values()] };
  }));
  const threads = coherent(Effect.gen(function* () {
    const [shell, archived] = yield* pair;
    const active: ReadonlyArray<unknown> = shell.threads;
    if (!isArchivedShellSnapshot(archived) || !archived.threads.every(isNativeThread) || !active.every(isNativeThread)) return yield* rejected();
    if (archived.snapshotSequence !== shell.snapshotSequence) return yield* new ShellIncoherent();
    const all = [...active, ...archived.threads];
    if (all.length > maxShellThreads) return yield* rejected();
    if (new Set(all.map((thread) => thread.id)).size !== all.length) return yield* new ShellIncoherent();
    return all;
  }));
  return { baseline, threads };
});

export interface NativeShellShape {
  // active and archived run anchors at one global revision
  readonly baseline: Effect.Effect<SupervisorBaseline, SupervisorRpcError>;
  // fresh native lineage from coherent active and archived views, active first, for workflow scope checks
  readonly threads: Effect.Effect<ReadonlyArray<ThreadInfo>, SupervisorRpcError>;
}

// the shell reads of the read credential: active over http, archived over NativeRpc
export class NativeShell extends Context.Service<NativeShell, NativeShellShape>()("t3-supervisor/NativeShell") {
  static readonly make = makeNativeShell;
  static readonly layer = (endpoint: NativeEndpoint): Layer.Layer<NativeShell, never, NativeRpc | HttpClient.HttpClient> => Layer.effect(NativeShell, makeNativeShell(endpoint));
}

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
