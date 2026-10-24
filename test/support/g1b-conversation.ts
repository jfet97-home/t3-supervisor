import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, Fiber, FileSystem, Layer, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { SupervisorConfig } from "../../src/config.js";
import { GuidanceDb, guidanceDbLayer, type PolicyDb, policyDbLayer } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ProjectDefinitions } from "../../src/project-definitions.js";
import { ProjectSupervisor } from "../../src/project-supervisor.js";
import { ProjectSupervisorStore, SupervisorOwnership, type SupervisorBaseline } from "../../src/project-supervisor-store.js";
import { ScopeLocks } from "../../src/scope-locks.js";
import { Store, type StoreShape } from "../../src/store.js";
import { SupervisionControl } from "../../src/supervision-control.js";
import { SupervisionGate, SupervisionScope, SupervisionScopeService, type SupervisionScopeStores } from "../../src/supervision-gate.js";
import { SupervisionScopeLive, SupervisionStoresLive, SupervisionTeamLive } from "../../src/supervision-live.js";
import { SupervisorConversation } from "../../src/supervisor-conversation.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { NativeOperateRpc, NativeRpc, NativeShell, SupervisorRpcError, type NativeRpcShape } from "../../src/supervisor-native.js";
import { SupervisorStateReset } from "../../src/supervisor-state-reset.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { T3Client, T3TransportError, type T3ClientShape } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { Projection, SupervisorSettings, ThreadInfo } from "../../src/types.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";

// the g1b conversation suites' processes: the production conversation, admission gate, workflow state and supervision stores of a
// temporary data directory, and the production project supervisor beside them, each built from its production layer
// (src/supervision-live.ts order) over the production database clients; the native side is one effect fake of T3 (its projection
// reads, the operate and read credentials, the definitions source), whose state the suites change as T3 would

/** The wall clock of a suite whose services read the real clock: a fixed instant after every time its fixtures record. */
export const wallClock = Date.parse("2026-10-23T10:00:00.000Z");

/** A temporary data directory, removed with the scope. */
export const temporaryDirectory = (prefix: string): Effect.Effect<string, never, Scope.Scope> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
}).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer));

/**
 * A call's wall time for its own run, as the baseline `now` parameter of a call: `now` is what the call's clock reads; its
 * elapsed time and sleeps stay on the current clock.
 */
export const atWallTime = (now: number) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.clockWith((clock) => Effect.provideService(effect, Clock.Clock, wallTimeClock(clock, () => now)));

// a clock whose wall time is `now` and whose elapsed time and sleeps are `clock`'s
const wallTimeClock = (clock: Clock.Clock, now: () => number): Clock.Clock => ({
  currentTimeMillisUnsafe: now,
  currentTimeMillis: Effect.sync(now),
  currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) => clock.sleep(duration),
});

/**
 * A real-time bound on an awaited event of a test-clock case, as the baseline's deadlines ran on real time: the bound's sleep runs
 * on the live clock and an expired bound fails the case by the event's name; the awaited effect keeps the test clock.
 */
export const within = <A, E, R>(effect: Effect.Effect<A, E, R>, milliseconds: number, label: string): Effect.Effect<A, E, R> =>
  Effect.raceFirst(effect, TestClock.withLive(Effect.sleep(Duration.millis(milliseconds))).pipe(
    Effect.andThen(Effect.die(new Error(`${label}: no outcome within ${milliseconds} ms`)))));

/**
 * Interrupts a forked call, as the baseline aborted the call's signal: the call settles by its own success or by its interruption;
 * any other outcome fails the caller with its cause.
 */
export const abortCall = <A, E>(fiber: Fiber.Fiber<A, E>): Effect.Effect<void, E> => Effect.andThen(Fiber.interrupt(fiber), Effect.flatMap(Fiber.await(fiber),
  (exit) => Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? Effect.void : Effect.failCause(exit.cause)));

/** What an effect fails with (its squashed cause), as a rejected baseline call carried it; a success is a defect of the caller. */
export const rejectionOf = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<unknown, never, R> => Effect.flatMap(Effect.exit(effect),
  (exit) => Exit.isFailure(exit) ? Effect.succeed(Cause.squash(exit.cause)) : Effect.die(new Error("the call was expected to fail")));

/** One statement on a client, as a suite's direct write to the file. */
export const execute = (sql: SqlClient.SqlClient, statement: string, ...params: ReadonlyArray<unknown>): Effect.Effect<void> =>
  sql.unsafe(statement, params).pipe(Effect.asVoid, Effect.orDie);

/** The rows of a query as plain objects. */
export const query = (sql: SqlClient.SqlClient, statement: string, ...params: ReadonlyArray<unknown>): Effect.Effect<Array<Record<string, unknown>>> =>
  sql.unsafe<Record<string, unknown>>(statement, params).pipe(Effect.map((rows) => rows.map((row) => ({ ...row }))), Effect.orDie);

// ---- the fake T3 ----

export type RpcCall = { tag: string; payload: Record<string, unknown> };

/** An interceptor's reply that hands the held call back to the default fake T3 behaviour. */
export const proceed: unique symbol = Symbol("proceed");

/** One request the fake received: `released` completes once the client released it (its socket closed); `releases` counts the release calls. */
export interface Flight {
  readonly released: Deferred.Deferred<void>;
  releases: number;
}

/**
 * Takes over a recorded call: its reply effect runs at once on the fake's own fiber, as T3 processes a request that left whatever
 * the client does next; a reply of `proceed` hands the call back to the default behaviour. Null leaves the call to the default.
 */
export type RpcInterceptor = (call: RpcCall, flight: Flight) => Effect.Effect<unknown, SupervisorRpcError> | null;

/** A send that reached the fake and settles only once the client releases it, classified as the real client does after sending. */
export const abortHonouringSend = (flight: Flight): Effect.Effect<never, SupervisorRpcError> =>
  Effect.andThen(Deferred.await(flight.released), Effect.fail(new SupervisorRpcError("uncertain")));

/** Wraps one projection read of the fake: the read itself is `read`. */
export type ReadHook = (threadId: string, read: Effect.Effect<Projection, T3TransportError>) => Effect.Effect<Projection, T3TransportError>;

export interface FakeT3Options {
  readonly projections: Map<string, Projection>;
  /**
   * T3's own answer to a call, run when the call arrives or when an interceptor hands it back: it changes the native state as T3
   * would on accepting the command and is its reply.
   */
  readonly answer: (call: RpcCall, calls: ReadonlyArray<RpcCall>) => Effect.Effect<unknown, SupervisorRpcError>;
  readonly definitions: (projectId: string, threadId: string | null) => ProjectDefinitionSnapshot;
}

/** Loads one definitions snapshot; `cancel` is the production read's abort signal (the definitions service's native boundary). */
export type DefinitionsLoad = (projectId: string, threadId: string | null, cancel: Deferred.Deferred<void> | undefined) => Effect.Effect<ProjectDefinitionSnapshot>;

export interface FakeT3 {
  readonly projections: Map<string, Projection>;
  // every operate call in arrival order, across every process of the suite
  readonly calls: Array<RpcCall>;
  // the conversation's projection reads, by thread id
  readonly projectionReads: Array<string>;
  intercept(next: RpcInterceptor | null): void;
  // wraps the conversation's projection reads
  holdReads(hook: ReadHook | null): void;
  // wraps the project supervisor's projection reads
  holdSupervisorReads(hook: ReadHook | null): void;
  // replaces the definitions source's loads; null restores the snapshot it serves
  replaceDefinitions(load: DefinitionsLoad | null): void;
  // the snapshot the definitions source serves
  readonly definitionsSnapshot: (projectId: string, threadId: string | null) => ProjectDefinitionSnapshot;
  // the conversation's natives: the T3 client, the operate and read credentials and the definitions service
  readonly t3: T3ClientShape;
  readonly supervisorT3: T3ClientShape;
  readonly operate: NativeRpcShape;
  readonly read: NativeRpcShape;
  readonly definitions: ProjectDefinitions["Service"];
}

const unused = (what: string) => () => Effect.die(new Error(`unused ${what}`));

/** The fake T3 of a suite; the fibers it answers intercepted calls on end with the scope. */
export const makeFakeT3 = (options: FakeT3Options): Effect.Effect<FakeT3, never, Scope.Scope> => Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const {projections} = options;
  const calls: Array<RpcCall> = [];
  const projectionReads: Array<string> = [];
  let interceptor: RpcInterceptor | null = null;
  let readHook: ReadHook | null = null;
  let supervisorReadHook: ReadHook | null = null;
  let load: DefinitionsLoad | null = null;

  // a call arrives: it is recorded, then answered at once (the default) or by its interceptor on the fake's own fiber
  const receive = (tag: string, payload: Readonly<Record<string, unknown>>, flight: Flight) => Effect.gen(function* () {
    const call: RpcCall = { tag, payload: { ...payload } };
    calls.push(call);
    const intercepted = interceptor?.(call, flight) ?? null;
    if (intercepted === null) return yield* Effect.exit(options.answer(call, calls));
    const reply = yield* Effect.forkIn(Effect.flatMap(intercepted, (outcome) => outcome === proceed ? options.answer(call, calls) : Effect.succeed(outcome)),
      scope, { startImmediately: true });
    return Fiber.join(reply);
  });
  const flightOf = Effect.map(Deferred.make<void>(), (released): Flight => ({ released, releases: 0 }));
  const release = (flight: Flight) => Effect.suspend(() => {
    flight.releases++;
    return Deferred.succeed(flight.released, undefined);
  }).pipe(Effect.asVoid);
  const operate: NativeRpcShape = {
    // a completed cancel ends the call as uncertain at the sent boundary; an ended call releases its request
    call: (tag, payload, cancel) => Effect.gen(function* () {
      const flight = yield* flightOf;
      const reply = yield* receive(tag, payload, flight);
      const cancelled = cancel ? Effect.andThen(Deferred.await(cancel), Effect.fail(new SupervisorRpcError("uncertain"))) : Effect.never;
      return yield* Effect.ensuring(Effect.raceFirst(reply, cancelled), release(flight));
    }),
    // the request is committed (recorded and handed to T3) while the initiation runs
    initiate: (tag, payload) => Effect.map(Effect.flatMap(flightOf, (flight) => Effect.map(receive(tag, payload, flight), (reply) => [flight, reply] as const)),
      ([flight, reply]) => ({ sent: Effect.succeed(true), result: reply, release: release(flight) })),
  };
  // the read credential serves a recorded submission's native item detail from the projection that shows it
  const read: NativeRpcShape = {
    call: (tag, payload) => Effect.suspend(() => {
      if (tag !== "orchestration.getTurnItem") return Effect.die(new Error(`unexpected fake read command ${tag}`));
      const item = (projections.get(String(payload.threadId))?.turnItems ?? []).find((candidate) => candidate.id === payload.itemId);
      return item ? Effect.succeed({ item: structuredClone(item) }) : Effect.fail(new SupervisorRpcError("rejected", true));
    }),
    initiate: unused("read initiation"),
  };
  // the conversation's reads are recorded; an unknown thread reads as the transport failure the T3 client reports
  const conversationRead = (threadId: string) => Effect.suspend(() => {
    projectionReads.push(threadId);
    const projection = projections.get(threadId);
    return projection ? Effect.succeed(projection) : Effect.fail(new T3TransportError("T3 thread projection is unavailable"));
  });
  // the project supervisor's reads are not recorded; it reads only threads the suite created
  const supervisorRead = (threadId: string) => Effect.suspend(() => {
    const projection = projections.get(threadId);
    return projection ? Effect.succeed(projection) : Effect.die(new Error(`missing test projection ${threadId}`));
  });
  const client = (read: (threadId: string) => Effect.Effect<Projection, T3TransportError>, hook: () => ReadHook | null, snapshotSequence: number): T3ClientShape => ({
    descriptor: unused("T3 descriptor"),
    watch: unused("T3 watch"),
    projection: (threadId) => Effect.map(Effect.suspend(() => {
      const current = hook();
      return current ? current(threadId, read(threadId)) : read(threadId);
    }), (projection) => ({ snapshotSequence, projection })),
  });
  const definitions = ProjectDefinitions.of({
    globalHomePath: "~",
    globalDefinitionsPath: "~/.t3-supervisor",
    load: (projectId, threadId = null, cancel) => Effect.suspend(() => load ? load(projectId, threadId, cancel) : Effect.succeed(options.definitions(projectId, threadId))),
    globalFingerprint: () => Effect.succeed(null),
    presence: unused("definitions presence"), presenceGlobal: unused("definitions presence"), presenceForCheckout: unused("definitions presence"),
    checkoutTargets: unused("checkout targets"), currentWorkspace: unused("current workspace"), initialize: unused("definitions setup"),
    initializeGlobal: unused("definitions setup"), readProjectConfig: unused("project configuration read"),
  });
  return {
    projections, calls, projectionReads, definitions, operate, read,
    definitionsSnapshot: options.definitions,
    intercept: (next) => {interceptor = next;},
    holdReads: (hook) => {readHook = hook;},
    holdSupervisorReads: (hook) => {supervisorReadHook = hook;},
    replaceDefinitions: (next) => {load = next;},
    t3: client(conversationRead, () => readHook, 0),
    supervisorT3: client(supervisorRead, () => supervisorReadHook, 1),
  };
});

// ---- the conversation process ----

/** The production database clients of a process, ended by its crash. */
const clientsLayer = (directory: string, policyDirectory: string): Layer.Layer<GuidanceDb | PolicyDb> =>
  Layer.mergeAll(guidanceDbLayer(directory), policyDbLayer(policyDirectory)).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie);

const supervisorIds: Layer.Layer<SupervisorIds> = SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));

/** The settings of a run whose native side is the fake: nothing reaches T3 through them. */
export const runSettings = (directory: string, t3Url = "http://unused"): SupervisorSettings =>
  ({ dataDirectory: directory, t3Url, t3TokenFile: "", excludedThreadIds: [], healthPort: 0 });

// the baseline conversation constructor's scope predicates: every scope is enabled, a main is eligible by the suite's predicate,
// and a chat is stopped by the instance thread policy (the production read)
class SuiteScope extends SupervisionScope {
  constructor(config: SupervisorSettings, stores: SupervisionScopeStores, private readonly mainEligible: (thread: ThreadInfo) => boolean) {
    super(config, stores, true);
  }
  override scopeEnabled() {return Effect.succeed(true);}
  override eligible(thread: ThreadInfo) {return Effect.succeed(this.mainEligible(thread));}
}

const suiteScopeLayer = (eligible: (thread: ThreadInfo) => boolean) => Layer.effect(SupervisionScopeService, Effect.gen(function* () {
  return new SuiteScope(yield* SupervisorConfig, { guidance: yield* GuidanceStore, supervisors: yield* ProjectSupervisorStore, policy: yield* ThreadPolicyStore }, eligible);
}));

// the stores in the production order over the process's clients (the guidance store, the thread policy, the supervision stores),
// the workflow state store whose owner check admits every scope (as the baseline suites constructed it), the suite's scope
// predicates with their admission gate, and the conversation over the fake's T3 client, credentials and definitions, with no
// helper team
const conversationLayer = (directory: string, fake: FakeT3, eligible: (thread: ThreadInfo) => boolean) => SupervisorConversation.layer.pipe(
  Layer.provideMerge(SupervisionGate.layer),
  Layer.provideMerge(suiteScopeLayer(eligible)),
  Layer.provideMerge(WorkflowStateStore.layerWith(() => Effect.succeed(true))),
  Layer.provideMerge(SupervisionStoresLive),
  Layer.provideMerge(ThreadPolicyStore.layer),
  Layer.provideMerge(GuidanceStore.layer),
  Layer.provideMerge(Layer.mergeAll(supervisorIds, Layer.sync(SupervisorOwnership, () => new Set<string>()), Layer.succeed(SupervisorConfig, runSettings(directory)),
    Layer.succeed(T3Client, fake.t3), Layer.succeed(NativeOperateRpc, fake.operate), Layer.succeed(NativeRpc, fake.read),
    Layer.succeed(ProjectDefinitions, fake.definitions))),
);

type ConversationServices = Layer.Success<ReturnType<typeof conversationLayer>> | GuidanceDb | PolicyDb;

export interface ConversationProcess {
  readonly sql: GuidanceDb["Service"];
  readonly guidance: GuidanceStore["Service"];
  readonly store: ProjectSupervisorStore["Service"];
  readonly requests: SupervisorConversationStore["Service"];
  readonly monitor: ProjectSupervisorMonitorStore["Service"];
  readonly workflows: WorkflowStateStore["Service"];
  readonly policy: ThreadPolicyStore["Service"];
  readonly gate: SupervisionGate["Service"];
  readonly conversation: SupervisorConversation["Service"];
  readonly context: Context.Context<ConversationServices>;
  // closes the process's database clients under its services, as a crash ends the process's connections without any further
  // write; the services close with the scope
  readonly crash: Effect.Effect<void>;
}

/** Opens one process on the files of `directory` (its thread policy in `policyDirectory`), closed with the scope. */
export const openConversationProcess = (input: {directory: string; policyDirectory: string; fake: FakeT3; eligible: (thread: ThreadInfo) => boolean}):
  Effect.Effect<ConversationProcess, never, Scope.Scope> => Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const clientScope = yield* Scope.fork(scope, "sequential");
    const clients = yield* Layer.buildWithScope(clientsLayer(input.directory, input.policyDirectory), clientScope);
    const context: Context.Context<ConversationServices> = yield* Layer.buildWithScope(
      conversationLayer(input.directory, input.fake, input.eligible).pipe(Layer.provideMerge(Layer.succeedContext(clients))),
      yield* Scope.fork(scope, "sequential")).pipe(Effect.orDie);
    return {
      context, crash: Scope.close(clientScope, Exit.void),
      sql: Context.get(context, GuidanceDb), guidance: Context.get(context, GuidanceStore), store: Context.get(context, ProjectSupervisorStore), requests: Context.get(context, SupervisorConversationStore),
      monitor: Context.get(context, ProjectSupervisorMonitorStore), workflows: Context.get(context, WorkflowStateStore), policy: Context.get(context, ThreadPolicyStore),
      gate: Context.get(context, SupervisionGate), conversation: Context.get(context, SupervisorConversation),
    };
  });

// ---- the project supervisor beside a conversation process ----

/** A read credential on which no native read is expected: every read fails as the real client classifies a failure after sending. */
export const noNativeRead: NativeRpcShape = {
  call: () => Effect.fail(new SupervisorRpcError("uncertain")),
  initiate: () => Effect.succeed({ sent: Effect.succeed(true), result: Effect.fail(new SupervisorRpcError("uncertain")), release: Effect.void }),
};

export interface ProjectSupervisorNatives {
  readonly settings: SupervisorSettings;
  // the read credential of the project supervisor and its control
  readonly read: NativeRpcShape;
  readonly catalog: StoreShape["catalog"];
  readonly baseline: SupervisorBaseline;
  // the wall time the project supervisor and its Start/Stop control stamp their sections with, as the baseline constructor `now`
  readonly now: () => number;
}

export interface ProjectSupervisorProcess {
  readonly supervisor: ProjectSupervisor["Service"];
  readonly conversation: SupervisorConversation["Service"];
  readonly requests: SupervisorConversationStore["Service"];
  readonly monitor: ProjectSupervisorMonitorStore["Service"];
  // the admission section the unit's services share
  readonly gate: SupervisionGate["Service"];
}

/**
 * The production project supervisor over the stores of `process`, with its own scope predicates, workflow state, admission gate,
 * helper transport, team runtime, conversation and lifecycle (SupervisionTeamLive) and its Start/Stop control, over the fake's
 * project supervisor reads, operate credential and definitions; as the baseline unit, it wires no workflow or team controllers,
 * and only the project supervisor and its control hold the read credential.
 */
export const openProjectSupervisor = (process: ConversationProcess, fake: FakeT3, natives: ProjectSupervisorNatives):
  Effect.Effect<ProjectSupervisorProcess, never, Scope.Scope> => Effect.gen(function* () {
    const clock = yield* Effect.clockWith(Effect.succeed);
    const stamped = Layer.mergeAll(Layer.succeed(Clock.Clock, wallTimeClock(clock, natives.now)), Layer.succeed(NativeRpc, natives.read));
    const catalog: StoreShape = { catalog: natives.catalog, activate: unused("catalog activation"), ingest: unused("catalog ingest"), cursor: unused("catalog cursor"),
      thread: unused("catalog thread"), project: unused("catalog project"), stats: unused("catalog stats") };
    const shell = NativeShell.of({ baseline: Effect.succeed(natives.baseline), threads: Effect.die(new Error("unused native lineage read")) });
    const stores = Context.pick(GuidanceDb, SupervisorIds, GuidanceStore, SupervisorOwnership, SupervisorStateReset, ProjectSupervisorStore, SupervisorConversationStore,
      ProjectSupervisorMonitorStore, SupervisorTeamStore, ThreadPolicyStore)(process.context);
    const layer = ProjectSupervisor.layer({ definitions: { load: (projectId, threadId) => fake.definitions.load(projectId, threadId) } }).pipe(
      Layer.provide(stamped),
      Layer.provideMerge(SupervisionControl.layer.pipe(Layer.provide(stamped))),
      Layer.provideMerge(SupervisionTeamLive({ baseUrl: natives.settings.t3Url })),
      Layer.provideMerge(SupervisionScopeLive(true)),
      Layer.provideMerge(Layer.mergeAll(ScopeLocks.layer, Layer.succeed(SupervisorConfig, natives.settings), Layer.succeed(Store, catalog), Layer.succeed(NativeShell, shell),
        Layer.succeed(T3Client, fake.supervisorT3), Layer.succeed(NativeOperateRpc, fake.operate), Layer.succeed(ProjectDefinitions, fake.definitions), FetchHttpClient.layer)),
      Layer.provide(Layer.succeedContext(stores)),
    );
    const context = yield* Layer.build(layer).pipe(Effect.orDie);
    const current = yield* natives.catalog().pipe(Effect.orDie);
    yield* Context.get(context, SupervisionScopeService).rememberCatalog(current.projects.map(item => item.project), current.threads).pipe(Effect.orDie);
    return {
      supervisor: Context.get(context, ProjectSupervisor), conversation: Context.get(context, SupervisorConversation), gate: Context.get(context, SupervisionGate),
      requests: process.requests, monitor: process.monitor,
    };
  });

// ---- the conversation store alone ----

export interface ConversationStoreFile {
  readonly sql: GuidanceDb["Service"];
  readonly store: SupervisorConversationStore["Service"];
}

/** The guidance client of `directory` with its guidance store and the conversation store over it, closed with the scope. */
export const openConversationStore = (directory: string): Effect.Effect<ConversationStoreFile, never, Scope.Scope> => Effect.gen(function* () {
  const context = yield* Layer.build(SupervisorConversationStore.layer.pipe(Layer.provideMerge(GuidanceStore.layer),
    Layer.provideMerge(Layer.mergeAll(guidanceDbLayer(directory).pipe(Layer.provide(NodeFileSystem.layer)), supervisorIds)))).pipe(Effect.orDie);
  return { sql: Context.get(context, GuidanceDb), store: Context.get(context, SupervisorConversationStore) };
});
