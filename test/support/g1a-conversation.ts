import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { Clock, Context, Effect, FileSystem, Layer, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { GuidanceDb, guidanceDbLayer, policyDbLayer } from "../../src/db.js";
import { GuidanceStore } from "../../src/guidance-store.js";
import { SupervisorIds } from "../../src/ids.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { DefinitionSourceFailure, ProjectDefinitions } from "../../src/project-definitions.js";
import { ProjectSupervisorStore, SupervisorOwnership, type SupervisorBaseline, type TaskRecord } from "../../src/project-supervisor-store.js";
import { ProjectSupervisor, type SupervisorDefinitionsAccess } from "../../src/project-supervisor.js";
import { ScopeLocks } from "../../src/scope-locks.js";
import { Store, type StoreShape } from "../../src/store.js";
import { SupervisionControl } from "../../src/supervision-control.js";
import { makeSupervisionGate, SupervisionGate, SupervisionScope, SupervisionScopeService, type GateGuard, type SupervisionScopeStores } from "../../src/supervision-gate.js";
import { SupervisionStoresLive, SupervisionTeamLive } from "../../src/supervision-live.js";
import { SupervisorConversation } from "../../src/supervisor-conversation.js";
import { SupervisorConversationStore } from "../../src/supervisor-conversation-store.js";
import { ProjectSupervisorMonitorStore } from "../../src/supervisor-monitor-store.js";
import { NativeOperateRpc, NativeRpc, NativeShell, SupervisorRpcError, type NativeRpcShape } from "../../src/supervisor-native.js";
import { SupervisorStateReset } from "../../src/supervisor-state-reset.js";
import { SupervisorTeamRuntime } from "../../src/supervisor-team-runtime.js";
import { SupervisorTeamStore } from "../../src/supervisor-team-store.js";
import { T3Client, T3TransportError, type T3ClientShape } from "../../src/t3.js";
import { makeThreadPolicyStore, ThreadPolicyStore, type ThreadPolicyStoreError } from "../../src/thread-policy.js";
import type { Projection, SupervisorSettings, ThreadInfo } from "../../src/types.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";
import {
  WorkflowNativeAccess, WorkflowWriteController, type SupervisionStartResult, type SupervisionStopInput, type SupervisionStopResult,
  type WorkflowNativeAccessShape,
} from "../../src/workflow-write-controller.js";
import { installSubmission, submissionDetail, type SubmissionItemOptions } from "./interpretation-submit.js";

// the conversation suite's services, each built from its production layer or constructor in the current scope over the stores
// of a temporary data directory: the supervision stores of one run with its thread-policy store, the conversation with its
// internal steps over callback scope predicates, the project supervisor's own team services, Start/Stop control and supervisor,
// and the write controller of a native stop or a typed interpretation submission. The native side is small effect fakes: the T3
// projection reads, the operate and read clients over a synchronous fake scheduler, the definitions source and the activation
// shell. Wall time is the test clock

/** The instant the baseline's unmocked real clock read: a fixed time after every time the suite's fixtures record. */
export const wallClock = Date.parse("2026-10-23T10:00:00.000Z");

/** The wall time a fixture stamps its records with and its supervisor reads as its clock. */
export interface FixtureClock {
  readonly now: number;
}

/**
 * A fixture clock that a test moves. Unpinned it is a plain value, as the baseline's `{now}` object; pinned it is the test
 * clock itself, as the baseline's `Date.now` mocked to `clock.now`, and it moves only through `advance` and `set`.
 */
export class TestWallClock implements FixtureClock {
  #value: number;
  #pinned: TestClock.TestClock | null = null;
  constructor(at: number) {this.#value = at;}
  get now(): number {return this.#pinned ? this.#pinned.currentTimeMillisUnsafe() : this.#value;}
  set now(value: number) {
    if (this.#pinned) throw new Error("a pinned clock moves through advance or set");
    this.#value = value;
  }
  /** Moves the time by `millis` and answers the new time. */
  advance(millis: number): Effect.Effect<number> {return Effect.as(this.set(this.now + millis), this.now + millis);}
  set(at: number): Effect.Effect<void> {
    const pinned = this.#pinned;
    return pinned ? pinned.setTime(at) : Effect.sync(() => {this.#value = at;});
  }
  /** Every wall-time read answers this clock for the current scope; its close restores the real clock. */
  get pin(): Effect.Effect<void, never, Scope.Scope> {
    return Effect.acquireRelease(TestClock.testClockWith((testClock) => Effect.andThen(testClock.setTime(this.#value), Effect.sync(() => {this.#pinned = testClock;}))),
      () => Effect.suspend(() => {
        const pinned = this.#pinned!;
        this.#value = pinned.currentTimeMillisUnsafe();
        this.#pinned = null;
        return pinned.setTime(wallClock);
      }));
  }
}

/** A clock at `at` that every wall-time read answers until the current scope closes (the baseline's mocked Date.now). */
export const pinnedClock = Effect.fnUntraced(function* (at: number) {
  const clock = new TestWallClock(at);
  yield* clock.pin;
  return clock;
});

/** The test clock at the real wall instant, unless the test already moved it, as every unpinned baseline case read real time. */
export const realTime: Effect.Effect<void> = TestClock.testClockWith((testClock) =>
  testClock.currentTimeMillisUnsafe() === 0 ? testClock.setTime(wallClock) : Effect.void);

// a clock whose wall time is `now()`; sleeps and the monotonic time stay the current clock's
const clockAt = (now: () => number) => Effect.clockWith((current) => Effect.succeed<Clock.Clock>({
  currentTimeMillisUnsafe: now,
  currentTimeMillis: Effect.sync(now),
  currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => current.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: current.monotonicTimeNanos,
  sleep: (duration) => current.sleep(duration),
}));

/** The baseline `now` parameter of one call: its wall clock reads that time; elapsed time and sleeps stay on the current clock. */
export const atWallClock = (now: number | undefined) => <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  now === undefined ? work : Effect.flatMap(clockAt(() => now), (clock) => Effect.provideService(work, Clock.Clock, clock));

/** A fresh temporary data directory, removed when the current scope closes. */
export const dataDirectory = Effect.fnUntraced(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({prefix});
}, Effect.provide(NodeFileSystem.layer), Effect.orDie);

/** The services of one supervision run's stores. */
export type StoreServices = GuidanceDb | SupervisorIds | GuidanceStore | SupervisorOwnership | SupervisorStateReset | ProjectSupervisorStore |
  SupervisorConversationStore | ProjectSupervisorMonitorStore | SupervisorTeamStore | ThreadPolicyStore;

const ids = SupervisorIds.layer.pipe(Layer.provide(NodeCrypto.layer));

// thread-settings.sqlite3 of `directory` and its store, seeded with no excluded chat
const policyLayer = (directory: string) => Layer.effect(ThreadPolicyStore, makeThreadPolicyStore({excludedThreadIds: []})).pipe(
  Layer.provide(policyDbLayer(directory)), Layer.provide(NodeFileSystem.layer));

// guidance.sqlite3 of `directory` with the guidance store, then the supervision stores of one run in their production order
// (src/supervision-live.ts) over the ownership set, beside the run's thread-policy store
const storesLayer = (directory: string, policyDirectory: string) => SupervisionStoresLive.pipe(
  Layer.provideMerge(GuidanceStore.layer),
  Layer.provideMerge(Layer.mergeAll(guidanceDbLayer(directory).pipe(Layer.provide(NodeFileSystem.layer)), ids,
    Layer.sync(SupervisorOwnership, () => new Set<string>()), policyLayer(policyDirectory))));

/** The stores of one supervision run on its guidance client, with the run's thread-policy store. */
export interface ConversationStores {
  readonly directory: string;
  readonly sql: GuidanceDb["Service"];
  readonly guidance: GuidanceStore["Service"];
  readonly supervisors: ProjectSupervisorStore["Service"];
  readonly requests: SupervisorConversationStore["Service"];
  readonly monitor: ProjectSupervisorMonitorStore["Service"];
  readonly team: SupervisorTeamStore["Service"];
  readonly policy: ThreadPolicyStore["Service"];
  readonly context: Context.Context<StoreServices>;
}

/** Opens the stores of `directory` and the thread policy of `policyDirectory` in the current scope. */
export const openStores = Effect.fnUntraced(function* (directory: string, policyDirectory: string): Effect.fn.Return<ConversationStores, never, Scope.Scope> {
  const context = yield* Layer.build(storesLayer(directory, policyDirectory)).pipe(Effect.orDie);
  return {
    directory, context, sql: Context.get(context, GuidanceDb), guidance: Context.get(context, GuidanceStore), supervisors: Context.get(context, ProjectSupervisorStore),
    requests: Context.get(context, SupervisorConversationStore), monitor: Context.get(context, ProjectSupervisorMonitorStore),
    team: Context.get(context, SupervisorTeamStore), policy: Context.get(context, ThreadPolicyStore),
  };
});

/** A second client of the thread policy of `directory` and its store, as a restarted process opens it, in the current scope. */
export const reopenPolicy = (directory: string): Effect.Effect<ThreadPolicyStore["Service"], never, Scope.Scope> =>
  Effect.map(Layer.build(policyLayer(directory)).pipe(Effect.orDie), (context) => Context.get(context, ThreadPolicyStore));

/** The workflow state store over the run's stores with `isEnabled` as its workflow-editing answer, in the current scope. */
export const workflowStore = (stores: ConversationStores, isEnabled: (projectId: string, mainThreadId?: string) => boolean = () => true) =>
  Effect.map(Layer.build(WorkflowStateStore.layerWith((projectId, mainThreadId) => Effect.sync(() => isEnabled(projectId, mainThreadId))).pipe(
    Layer.provide(Layer.succeedContext(stores.context)))).pipe(Effect.orDie), (context) => Context.get(context, WorkflowStateStore));

/** One call to the fake native scheduler, run synchronously when its effect runs. */
export type NativeHandler = (tag: string, payload: Record<string, unknown>) => unknown;

/**
 * The fake scheduler's call as a native client call: a thrown SupervisorRpcError is its outcome, anything else thrown is a call
 * that may have acted, as the client reports an unexpected failure.
 */
export const nativeCall = (handle: NativeHandler) => (tag: string, payload: Readonly<Record<string, unknown>>): Effect.Effect<unknown, SupervisorRpcError> =>
  Effect.try({try: () => handle(tag, {...payload}), catch: (cause) => cause instanceof SupervisorRpcError ? cause : new SupervisorRpcError("uncertain")});

/** A native client over the fake scheduler: a call is the handler's call; an initiation makes it as the request is committed. */
export const nativeClient = (handle: NativeHandler): NativeRpcShape => {
  const call = nativeCall(handle);
  return {
    call: (tag, payload) => call(tag, payload),
    initiate: (tag, payload) => Effect.map(Effect.exit(call(tag, payload)), (exit) => ({sent: Effect.succeed(true), result: exit, release: Effect.void})),
  };
};

/**
 * The read credential's native item detail of a thread's turn item, served from the projection it appears in, as the evidence
 * fixture's turnItemReader serves it: each read records its item ID, and an item the projection no longer shows is a definite
 * rejection.
 */
export const turnItemDetails = (projection: (threadId: string) => Projection | null | undefined, reads: Array<string>): NativeHandler => (tag, payload) => {
  if (tag !== "orchestration.getTurnItem") throw new Error(`unexpected fake read command ${tag}`);
  reads.push(String(payload.itemId));
  const item = (projection(String(payload.threadId))?.turnItems ?? []).find((candidate) => candidate.id === payload.itemId);
  if (!item) throw new SupervisorRpcError("rejected", true);
  return {item: structuredClone(item)};
};

/** A native T3 projection read of the fake. */
export type ProjectionRead = (threadId: string) => Effect.Effect<Projection, T3TransportError>;

/** The T3 client over `read`; projections are returned unchanged and by reference, and nothing else is used. */
export const t3Projections = (read: ProjectionRead): T3ClientShape => ({
  descriptor: () => Effect.die(new Error("unused T3 descriptor")),
  watch: () => Effect.die(new Error("unused T3 watch")),
  projection: (threadId) => Effect.map(Effect.suspend(() => read(threadId)), (projection) => ({snapshotSequence: 1, projection})),
});

/** The definitions source of a suite; its `load` is read on every call, so a test may replace it. */
export interface DefinitionsLoader {
  load: (projectId: string, threadId?: string | null) => Effect.Effect<ProjectDefinitionSnapshot, Error>;
}

/** The loader as the definitions service: a failed read is a defect, as the baseline rejection it stands for; no global fingerprint. */
export const definitionsService = (loader: DefinitionsLoader): ProjectDefinitions["Service"] => {
  const unused = () => Effect.die(new Error("unused definitions operation"));
  return ProjectDefinitions.of({
    globalHomePath: "~",
    globalDefinitionsPath: "~/.t3-supervisor",
    load: (projectId, threadId = null) => Effect.orDie(Effect.suspend(() => loader.load(projectId, threadId))),
    globalFingerprint: () => Effect.succeed(null),
    presence: unused, presenceGlobal: unused, presenceForCheckout: unused, checkoutTargets: unused, currentWorkspace: unused,
    initialize: unused, initializeGlobal: unused, readProjectConfig: unused,
  });
};

/** The loader as the supervisor's definition operations: a failed read is the source failure. */
export const definitionsAccess = (loader: DefinitionsLoader): SupervisorDefinitionsAccess => ({
  load: (projectId, threadId) => Effect.mapError(Effect.suspend(() => loader.load(projectId, threadId)), (error) => new DefinitionSourceFailure({error})),
});

/** The scope callbacks of a conversation unit, read when called, so a suite may replace them. */
export interface ConversationCallbacks {
  projection: ProjectionRead;
  eligible: (thread: ThreadInfo, threads: readonly ThreadInfo[]) => boolean;
  enabled: (projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile") => boolean;
  supervisionStopped: (mainThreadId: string) => Effect.Effect<boolean, ThreadPolicyStoreError>;
}

// the callbacks as the scope predicates of the conversation and its admission gate
class CallbackScope extends SupervisionScope {
  constructor(config: SupervisorSettings, stores: SupervisionScopeStores, private readonly callbacks: ConversationCallbacks) {super(config, stores, true);}
  override scopeEnabled(projectId: string, mainThreadId?: string, purpose?: "effect" | "interpretation" | "reconcile") {
    return Effect.sync(() => this.callbacks.enabled(projectId, mainThreadId, purpose));
  }
  override supervisionStopped(threadId: string) {return Effect.suspend(() => this.callbacks.supervisionStopped(threadId));}
  override eligible(thread: ThreadInfo, threads: readonly ThreadInfo[]) {return Effect.sync(() => this.callbacks.eligible(thread, threads));}
}

const openGuard: GateGuard = {scopeEnabled: () => Effect.succeed(true), supervisionStopped: () => Effect.succeed(false), workflowEditingEnabled: () => Effect.succeed(true)};

export interface ConversationUnitOptions {
  readonly stores: ConversationStores;
  readonly operate: NativeRpcShape | null;
  readonly projection: ProjectionRead;
  readonly definitions?: DefinitionsLoader | undefined;
  readonly eligible: ConversationCallbacks["eligible"];
  readonly enabled?: ConversationCallbacks["enabled"] | undefined;
  // the per-chat stop, never stopped unless given
  readonly supervisionStopped?: ConversationCallbacks["supervisionStopped"] | undefined;
  readonly workflows?: WorkflowStateStore["Service"] | undefined;
  // the helper team: the team runtime over its own open gate reads the conversation's stop and scope callbacks as its stop
  readonly team?: boolean | undefined;
  readonly helperProviderInstanceId?: string | undefined;
  // the read credential's native reads (an interpretation submission's item detail)
  readonly read?: NativeRpcShape | undefined;
}

/**
 * The production conversation over callback scope predicates and their admission gate, with its internal steps; `observe`
 * takes the baseline's optional `now`, the wall clock of that call.
 */
export const conversationUnit = Effect.fnUntraced(function* (options: ConversationUnitOptions) {
  const {stores} = options;
  const callbacks: ConversationCallbacks = {projection: options.projection, eligible: options.eligible, enabled: options.enabled ?? (() => true),
    supervisionStopped: options.supervisionStopped ?? (() => Effect.succeed(false))};
  const config: SupervisorSettings = {dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0,
    ...(options.helperProviderInstanceId ? {helperProviderInstanceId: options.helperProviderInstanceId} : {})};
  const scope = new CallbackScope(config, {guidance: stores.guidance, supervisors: stores.supervisors, policy: stores.policy}, callbacks);
  const context = options.workflows ? Context.add(stores.context, WorkflowStateStore, options.workflows) : stores.context;
  const gate = yield* makeSupervisionGate(scope).pipe(Effect.provide(context));
  const t3 = t3Projections((threadId) => callbacks.projection(threadId));
  const teamRuntime = options.team ? yield* Effect.gen(function* () {
    const runtimeGate = yield* makeSupervisionGate(openGuard).pipe(Effect.provide(stores.context));
    return yield* SupervisorTeamRuntime.make({stopped: Effect.fnUntraced(function* (_guard, mainThreadId) {
      if (yield* callbacks.supervisionStopped(mainThreadId)) return true;
      const projectId = (yield* stores.supervisors.bindings()).find((item) => item.mainThreadId === mainThreadId)?.projectId ?? "";
      return !callbacks.enabled(projectId, mainThreadId);
    })}).pipe(Effect.provideService(SupervisionGate, runtimeGate), Effect.provideService(T3Client, t3), Effect.provide(stores.context));
  }) : null;
  const {service, seams} = yield* SupervisorConversation.makeUnit.pipe(
    Effect.provideService(SupervisionScopeService, scope),
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(T3Client, t3),
    (effect) => options.operate ? Effect.provideService(effect, NativeOperateRpc, options.operate) : effect,
    (effect) => options.read ? Effect.provideService(effect, NativeRpc, options.read) : effect,
    (effect) => options.definitions ? Effect.provideService(effect, ProjectDefinitions, definitionsService(options.definitions)) : effect,
    (effect) => teamRuntime ? Effect.provideService(effect, SupervisorTeamRuntime, teamRuntime) : effect,
    Effect.provide(context),
  );
  return Object.assign(callbacks, service, seams, {
    observe: (threads: readonly ThreadInfo[], now?: number) => atWallClock(now)(service.observe(threads)),
    service, scope, gate, teamRuntime, definitions: options.definitions, requests: stores.requests, monitor: stores.monitor,
  });
});

export type ConversationUnit = Effect.Success<ReturnType<typeof conversationUnit>>;

export interface ProjectSupervisorUnitOptions {
  readonly config: SupervisorSettings;
  readonly stores: ConversationStores;
  readonly catalog: StoreShape["catalog"];
  readonly projection: ProjectionRead;
  readonly read: NativeRpcShape;
  readonly operate: NativeRpcShape | null;
  // the activation boundary of the native shell
  readonly baseline: Effect.Effect<SupervisorBaseline, SupervisorRpcError>;
  readonly definitions: DefinitionsLoader;
  // the wall clock the Start/Stop control and the supervisor stamp their sections with, as the baseline constructor `now`
  readonly clock: FixtureClock;
}

/**
 * The project supervisor of one run as the root builds it: the production scope predicates over the run's stores, the workflow
 * state store over their workflow-editing predicate, the team services (SupervisionTeamLive: gate, helper transport, team
 * runtime, its own conversation and lifecycle), the Start/Stop control and the supervisor over the catalog, the native clients,
 * the per-scope locks and the definitions; no workflow controllers are wired. The unit is the supervisor with its control,
 * its scope predicates and its internal steps.
 */
export const projectSupervisorUnit = Effect.fnUntraced(function* (options: ProjectSupervisorUnitOptions) {
  const {stores} = options;
  const scope = new SupervisionScope(options.config, {guidance: stores.guidance, supervisors: stores.supervisors, policy: stores.policy}, options.operate !== null);
  const workflows = yield* Layer.build(WorkflowStateStore.layerWith((projectId, mainThreadId) => scope.workflowEditingEnabled(projectId, mainThreadId)).pipe(
    Layer.provide(Layer.succeedContext(stores.context)))).pipe(Effect.orDie);
  const base = Context.merge(stores.context, workflows).pipe(Context.add(SupervisionScopeService, scope));
  const t3 = t3Projections(options.projection);
  // the team services get the read credential as the root provides it (an interpretation submission's item detail)
  const team = yield* Layer.build(SupervisionTeamLive({baseUrl: options.config.t3Url}).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeedContext(base), Layer.succeed(T3Client, t3), Layer.succeed(ProjectDefinitions, definitionsService(options.definitions)),
    Layer.succeed(NativeRpc, options.read), options.operate ? Layer.succeed(NativeOperateRpc, options.operate) : Layer.empty, FetchHttpClient.layer)))).pipe(Effect.orDie);
  const locks = yield* Layer.build(ScopeLocks.layer);
  const shell = NativeShell.of({baseline: options.baseline, threads: Effect.die(new Error("unused native lineage read"))});
  const clients = Context.merge(Context.merge(base, team), locks).pipe(Context.add(Store, {catalog: options.catalog} as StoreShape),
    Context.add(T3Client, t3), Context.add(NativeRpc, options.read), Context.add(NativeShell, shell),
    (context) => options.operate ? Context.add(context, NativeOperateRpc, options.operate) : context);
  const clock = yield* clockAt(() => options.clock.now);
  const control = yield* SupervisionControl.make.pipe(Effect.provideService(Clock.Clock, clock), Effect.provide(clients));
  const {service, seams} = yield* ProjectSupervisor.makeUnit({definitions: definitionsAccess(options.definitions)}).pipe(
    Effect.provideService(Clock.Clock, clock), Effect.provideService(SupervisionControl, control), Effect.provide(clients));
  return {
    ...service, control, scope, seams,
    stopSupervision: control.stopSupervision,
    saveThreadPolicy: control.saveThreadPolicy,
    supervisionStopped: (threadId: string) => scope.supervisionStopped(threadId),
    dispatch: seams.dispatch,
  };
});

export type ProjectSupervisorUnit = Effect.Success<ReturnType<typeof projectSupervisorUnit>>;

// the write controller's scope predicates of a unit without options: every scope enabled for its sections, workflow editing by the
// stored control of the project, no chat stopped
class WriteScope extends SupervisionScope {
  constructor(private readonly runStores: ConversationStores) {
    super({dataDirectory: "", t3Url: "http://unused", t3TokenFile: "", excludedThreadIds: [], healthPort: 0},
      {guidance: runStores.guidance, supervisors: runStores.supervisors, policy: runStores.policy}, true);
  }
  override scopeEnabled() {return Effect.succeed(true);}
  override workflowEditingEnabled(projectId: string) {return this.runStores.supervisors.enabled(projectId);}
  override supervisionStopped() {return Effect.succeed(false);}
}

export interface WriteControllerOptions {
  readonly stores: ConversationStores;
  readonly workflows: WorkflowStateStore["Service"];
  readonly native: WorkflowNativeAccessShape;
  // the Stop a verified supervision_stop is handed to; without it the controller has no Start/Stop control
  readonly stop?: ((input: SupervisionStopInput, evidence: unknown) => Effect.Effect<SupervisionStopResult, unknown>) | undefined;
}

/**
 * The production write controller without team authority and without an evidence wait, over its own admission gate and the
 * native reads of `native`; with `stop`, a verified supervision_stop is handed to it and a Start is unavailable.
 */
export const writeController = Effect.fnUntraced(function* (options: WriteControllerOptions) {
  const scope = new WriteScope(options.stores);
  const context = Context.add(options.stores.context, WorkflowStateStore, options.workflows).pipe(Context.add(SupervisionScopeService, scope));
  const gate = yield* makeSupervisionGate(scope).pipe(Effect.provide(context));
  const stop = options.stop;
  const control = stop && {
    startSupervision: () => Effect.succeed<SupervisionStartResult>({status: "unavailable", reason: "supervision_start_unavailable"}),
    stopSupervision: (input: SupervisionStopInput, evidence: unknown) => Effect.orDie(stop(input, evidence)),
  } as unknown as SupervisionControl["Service"];
  return yield* WorkflowWriteController.make({withoutTeam: true, maxEvidenceWaitMs: 0}).pipe(
    (effect) => control ? Effect.provideService(effect, SupervisionControl, control) : effect,
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(WorkflowNativeAccess, options.native),
    Effect.provide(context),
  );
});

export interface InterpretationSubmitterOptions {
  readonly stores: ConversationStores;
  readonly workflows: WorkflowStateStore["Service"];
  // the root's and the main's projections, the native reads of the submission's proof
  readonly projections: ReadonlyMap<string, Projection>;
}

/**
 * A Supervisor root's typed interpretation submission (test/support/interpretation-submit.ts records its native item): `submit`
 * installs the executed tool item for the arguments in the root's request run, unless told not to, and calls the tool through the
 * production write controller and its intake, which records into the run's guidance file.
 */
export const interpretationSubmitter = Effect.fnUntraced(function* (options: InterpretationSubmitterOptions) {
  const controller = yield* writeController({stores: options.stores, workflows: options.workflows, native: {
    listThreads: () => Effect.succeed([]),
    projection: (threadId) => {
      const projection = options.projections.get(threadId);
      return projection ? Effect.succeed(projection) : Effect.fail(new T3TransportError("missing projection", 404));
    },
    getTurnItem: ({threadId, itemId}) => Effect.succeed({item: submissionDetail(options.projections.get(threadId), itemId)}),
  }});
  return {
    submit: (task: TaskRecord, args: Record<string, unknown>, submission: SubmissionItemOptions & {readonly install?: boolean} = {}) => Effect.suspend(() => {
      const root = options.projections.get(task.supervisorThreadId);
      if (!root) return Effect.die(new Error("the bound root's projection is missing"));
      if (submission.install !== false) installSubmission(root, task, args, submission);
      return controller.submitInterpretation(args);
    }),
  };
});

type Method = (...args: never[]) => unknown;

/**
 * Replaces the member `key` of `target` with `replace(original)` until the current scope closes or `restore` runs, recording
 * the arguments of every call; its callers read the member when they call it (a test seam over an object the services hold).
 */
export const replaceMethod = <T extends object, K extends keyof T>(target: T, key: K, replace: (original: T[K]) => T[K]) =>
  Effect.map(Effect.acquireRelease(Effect.sync(() => {
    const own = target[key];
    const calls: Array<ReadonlyArray<unknown>> = [];
    const replacement = replace((own as Method).bind(target) as T[K]) as Method;
    target[key] = ((...args: never[]) => {
      calls.push(args);
      return replacement(...args);
    }) as T[K];
    return {calls, restore: Effect.sync(() => {target[key] = own;})};
  }), (replaced) => replaced.restore), ({calls, restore}) => ({calls, restore}));
