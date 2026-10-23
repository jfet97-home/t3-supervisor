import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer } from "effect";
import { GuidanceDb, guidanceDbLayer } from "../../src/db.js";
import { GitProbe } from "../../src/git-probe.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import { NativeEnvelope } from "../../src/native-envelope.js";
import { startFakeTerminalT3, type ProbeStatus } from "./c3a-fake-terminal-t3.js";

// the git probe's guidance metadata and the production probe over a loopback T3, for the native file and probe suites (g10)

// the root's native transport as the probe uses it: the shared envelope and the platform crypto
const probeTransport = Layer.merge(NativeEnvelope.layer, NodeCrypto.layer);

/**
 * The run's guidance client and store on a fresh temporary data directory, composed as src/guidance-application.ts composes
 * them; the store's layer creates the meta table the probe keeps its pending sessions in. Both close with the caller's scope,
 * before the directory is removed.
 */
export const probeGuidance = (prefix: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix });
  const guidance = yield* Layer.build(GuidanceStore.layer.pipe(Layer.provideMerge(guidanceDbLayer(directory)), Layer.provide(SupervisorIds.layer)));
  const sql = Context.get(guidance, GuidanceDb);
  return {
    guidance,
    /** The production probe over the loopback T3 at `url`, on the root's native transport and this guidance client. */
    gitProbe: (url: string, token = "terminal-operate-test-token") =>
      GitProbe.make({ baseUrl: url, token }).pipe(Effect.provide(probeTransport), Effect.provide(guidance)),
    /** The stored pending probe sessions, parsed as the baseline suites read them from the meta table. */
    pendingSessions: Effect.map(sql<{ value: string }>`SELECT value FROM meta WHERE key='native_git_probe_sessions'`,
      ([row]): unknown => JSON.parse(String(row?.value))).pipe(Effect.orDie),
    /** Stores `value` as the pending probe sessions, as an earlier process left them. */
    insertPending: (value: string) => sql`INSERT INTO meta(key,value) VALUES('native_git_probe_sessions',${value})`.pipe(Effect.asVoid, Effect.orDie),
  };
}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodeCrypto.layer)));

/** The c3a loopback terminal T3 (real sockets) for the caller's scope. */
export const fakeTerminalT3 = (status: ProbeStatus, holdResult?: (index: number) => boolean) =>
  Effect.acquireRelease(Effect.promise(() => startFakeTerminalT3(status, holdResult)), (fake) => Effect.promise(() => fake.close()));
