import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { cancelOnAbort, NativeEnvelope } from "../../src/native-envelope.js";
import { NativeRpc, NativeShell, SupervisorRpcError, type NativeRpcShape, type NativeShellShape, type SupervisorRpc } from "../../src/supervisor-native.js";
import type { SupervisorBaseline } from "../../src/project-supervisor-store.js";
import type { ThreadInfo } from "../../src/types.js";

// the baseline promise shapes over the ported native services, built as the baseline facades are (./root-facades.ts)

const nativeClient = (baseUrl: string, token: string): NativeRpcShape =>
  Effect.runSync(NativeRpc.make({ baseUrl, token }).pipe(Effect.provide(NativeEnvelope.layer)));

const rpcFacade = (rpc: NativeRpcShape): SupervisorRpc => (tag, payload, signal) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(cancelOnAbort(signal), (cancel) => rpc.call(tag, payload, cancel))));

// a promise call handed back as the service, for fixtures that pass one rpc to both shapes
const promiseClient = (rpc: SupervisorRpc): NativeRpcShape => ({
  call: (tag, payload) => Effect.tryPromise({
    try: (signal) => rpc(tag, { ...payload }, signal),
    catch: (cause) => cause instanceof SupervisorRpcError ? cause : new SupervisorRpcError("uncertain"),
  }),
  initiate: () => Effect.die("the shell reads only call"),
});

const shell = (baseUrl: string, token: string, rpc: SupervisorRpc | undefined): NativeShellShape =>
  Effect.runSync(NativeShell.make({ baseUrl, token }).pipe(
    Effect.provideService(NativeRpc, rpc ? promiseClient(rpc) : nativeClient(baseUrl, token)), Effect.provide(FetchHttpClient.layer)));

export const makeSupervisorRpc = (baseUrl: string, token: string): SupervisorRpc => rpcFacade(nativeClient(baseUrl, token));

export const readSupervisorBaseline = (baseUrl: string, token: string, rpc?: SupervisorRpc): (signal: AbortSignal) => Promise<SupervisorBaseline> => {
  const reads = shell(baseUrl, token, rpc);
  return (signal) => Effect.runPromise(reads.baseline, { signal });
};

export const readSupervisorThreads = (baseUrl: string, token: string, rpc?: SupervisorRpc): (signal: AbortSignal) => Promise<readonly ThreadInfo[]> => {
  const reads = shell(baseUrl, token, rpc);
  return (signal) => Effect.runPromise(reads.threads, { signal });
};
