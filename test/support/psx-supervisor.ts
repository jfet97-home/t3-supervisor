import { createHash } from "node:crypto";
import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Context, Effect, Exit, FileSystem, Layer, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { SupervisorConfig as Configuration } from "../../src/config.js";
import { effectiveIndex } from "../project-definitions-fixture.js";
import { ProjectDefinitions, DefinitionSourceFailure, type DefinitionPresence } from "../../src/project-definitions.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { ProjectSupervisor, type SupervisorDefinitionsAccess } from "../../src/project-supervisor.js";
import { defaultSupervisorModel, type BindingRecord, type ProjectSupervisorStoreError, type SupervisorBaseline } from "../../src/project-supervisor-store.js";
import type { SupervisorModelSelection } from "../../src/project-supervisor-contract.js";
import { ScopeLocks, type ScopeLocksShape } from "../../src/scope-locks.js";
import { Store, type StoreShape } from "../../src/store.js";
import { SupervisionControl } from "../../src/supervision-control.js";
import { SupervisionGate, SupervisionScope, SupervisionScopeService } from "../../src/supervision-gate.js";
import { SupervisionTeamLive } from "../../src/supervision-live.js";
import { NativeOperateRpc, NativeRpc, NativeShell, SupervisorRpcError, type NativeRpcShape } from "../../src/supervisor-native.js";
import { T3Client, T3TransportError, type T3ClientShape } from "../../src/t3.js";
import { ThreadPolicyStore, ThreadPolicyStoreError } from "../../src/thread-policy.js";
import type { GuidanceStoreError } from "../../src/guidance-sql.js";
import type { ProjectInfo, Projection, SupervisorConfig } from "../../src/types.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";
import { clockFrom, type DbSeam } from "./psx-sql.js";
import { openGuidance, openSupervisors, openWorkflows, type StoreOpen } from "./psx-stores.js";
import {
  addSupervisorRequest, emptySupervisorProjection, makeSourceProjection, submitInterpretation as submitStored, turnItemAnswer, type Turn,
} from "./psx-submission.js";

export const activationSequence = 10;
export const projects: ProjectInfo[] = [
  {id: "project-a", title: "Project A", workspaceRoot: "/work/a"},
  {id: "project-b", title: "Project B", workspaceRoot: "/work/b"},
];

export const modelConfig = {
  providers: [{
    enabled: true, instanceId: "codex", displayName: "Codex", installed: true, status: "ready",
    models: ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol"].map((slug) => ({
      slug, name: slug,
      capabilities: {optionDescriptors: [{id: "reasoningEffort", label: "Reasoning effort", type: "select", currentValue: "high",
        options: [{id: "low", label: "Low"}, {id: "high", label: "High"}, {id: "max", label: "Max"}]}]},
    })),
  }],
};

export const missingDefinitions = (projectId: string, threadId: string | null, workspaceRoot: string): ProjectDefinitionSnapshot => ({
  projectId, threadId, workspaceRoot, globalOnly: false, globalRevision: null, revision: null,
  editingAvailable: false, status: "missing", steps: [], workflows: [],
  config: effectiveIndex({steps: [], workflows: []}), projectConfig: null, definitionFiles: [], complete: false, sources: [], issues: [],
});

export interface DefinitionsLoader {
  load: (projectId: string, threadId: string | null) => Effect.Effect<ProjectDefinitionSnapshot, unknown>;
  presence?: (projectId: string) => Effect.Effect<DefinitionPresence, unknown>;
}

export type OperateHook = (tag: string, payload: Record<string, unknown>) => Effect.Effect<unknown, unknown> | null | undefined;
export type ProjectionHook = (threadId: string) => Effect.Effect<{readonly projection: Projection; readonly snapshotSequence: number}, unknown> | undefined;
export type ReadHook = (tag: string) => Effect.Effect<void, unknown> | void;

export interface AssembleInput {
  readonly config: SupervisorConfig;
  readonly stores: StoreOpen;
  readonly workflows: WorkflowStateStore["Service"];
  readonly catalog: StoreShape["catalog"];
  readonly projection: T3ClientShape["projection"];
  readonly read: NativeRpcShape;
  readonly operate: NativeRpcShape;
  readonly baseline: Effect.Effect<SupervisorBaseline, SupervisorRpcError>;
  readonly definitions: DefinitionsLoader;
  readonly now?: (() => number) | undefined;
  readonly locks?: ((locks: ScopeLocksShape) => ScopeLocksShape) | undefined;
  readonly policy?: ThreadPolicyStore["Service"] | undefined;
}

const definitionsService = (loader: DefinitionsLoader): ProjectDefinitions["Service"] => {
  const unused = () => Effect.die(new Error("unused definitions operation"));
  const failed = <A>(effect: Effect.Effect<A, unknown>) => Effect.mapError(effect, (error) => new DefinitionSourceFailure({error}));
  return ProjectDefinitions.of({
    globalHomePath: "~",
    globalDefinitionsPath: "~/.t3-supervisor",
    load: (projectId, threadId = null) => Effect.orDie(failed(Effect.suspend(() => loader.load(projectId, threadId)))),
    globalFingerprint: () => Effect.succeed(null),
    presence: loader.presence ? (projectId) => Effect.orDie(failed(Effect.suspend(() => loader.presence!(projectId)))) : unused,
    presenceGlobal: unused, presenceForCheckout: unused, checkoutInventory: (projectId: string) => Effect.succeed({projectId, available: true, complete: true, reason: null, defaultBranch: null, issues: [], targets: []}),
    checkoutTargets: unused, currentWorkspace: unused,
    initialize: unused, initializeGlobal: unused, readProjectConfig: unused,
  });
};

const definitionsAccess = (loader: DefinitionsLoader): SupervisorDefinitionsAccess => {
  const failed = <A>(effect: Effect.Effect<A, unknown>) => Effect.mapError(effect, (error) => new DefinitionSourceFailure({error}));
  return {
    load: (projectId, threadId) => failed(Effect.suspend(() => loader.load(projectId, threadId))),
    ...(loader.presence ? {presence: (projectId: string) => failed(Effect.suspend(() => loader.presence!(projectId)))} : {}),
  };
};

// distinct leased keys, excluding start claims. The count covers a waiter and the holder of one key as one lease.
const countedLocks = (base: ScopeLocksShape) => {
  const held = new Map<string, number>();
  const locks: ScopeLocksShape = {
    leased: base.leased,
    withLock: (key) => (self) => {
      const counted = !key.startsWith("start:");
      if (counted) held.set(key, (held.get(key) ?? 0) + 1);
      return base.withLock(key)(self).pipe(Effect.ensuring(Effect.sync(() => {
        if (!counted) return;
        const next = (held.get(key) ?? 1) - 1;
        if (next <= 0) held.delete(key);
        else held.set(key, next);
      })));
    },
  };
  return {locks, size: () => held.size};
};

const settleRpc = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, SupervisorRpcError> =>
  Effect.mapError(effect, (cause) => cause instanceof SupervisorRpcError ? cause : new SupervisorRpcError("uncertain"));

/** The production supervisor over `input`. The constructor clock, when given, is captured only by the two services that stamp with it. */
export const assembleSupervisor = (input: AssembleInput) => Effect.gen(function* () {
  const policy = input.policy ?? input.stores.policy;
  const stores = input.policy ? {...input.stores, policy, context: Context.add(input.stores.context, ThreadPolicyStore, policy)} : input.stores;
  const scope = new SupervisionScope(input.config, {guidance: stores.guidance, supervisors: stores.supervisors, policy}, true);
  const base = Context.add(stores.context, WorkflowStateStore, input.workflows).pipe(Context.add(SupervisionScopeService, scope));
  const t3 = {descriptor: () => Effect.die(new Error("unused")), watch: () => Effect.die(new Error("unused")), projection: input.projection} satisfies T3ClientShape;
  const definitions = definitionsService(input.definitions);
  const team = yield* Layer.build(SupervisionTeamLive({baseUrl: input.config.t3Url}).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeedContext(base), Layer.succeed(T3Client, t3), Layer.succeed(ProjectDefinitions, definitions), Layer.succeed(NativeRpc, input.read),
    Layer.succeed(NativeOperateRpc, input.operate), FetchHttpClient.layer)))).pipe(Effect.orDie);
  const builtLocks = yield* Layer.build(ScopeLocks.layer);
  const baseLocks = Context.get(builtLocks, ScopeLocks);
  const wrapped = input.locks ? input.locks(baseLocks) : baseLocks;
  const counted = countedLocks(wrapped);
  const shell = NativeShell.of({baseline: input.baseline, threads: Effect.die(new Error("unused native lineage read"))});
  const clients = Context.merge(base, team).pipe(Context.add(ScopeLocks, counted.locks), Context.add(Store, {catalog: input.catalog} as StoreShape),
    Context.add(T3Client, t3), Context.add(NativeRpc, input.read), Context.add(NativeShell, shell), Context.add(NativeOperateRpc, input.operate),
    Context.add(ThreadPolicyStore, policy), Context.add(Configuration, input.config));
  const ambient = yield* Clock.Clock;
  const clock = input.now ? clockFrom(input.now, ambient) : ambient;
  const control = yield* SupervisionControl.make.pipe(Effect.provideService(Clock.Clock, clock), Effect.provide(clients));
  const {service} = yield* ProjectSupervisor.makeUnit({definitions: definitionsAccess(input.definitions)}).pipe(
    Effect.provideService(Clock.Clock, clock), Effect.provideService(SupervisionControl, control), Effect.provide(clients));
  return {
    ...service, supervisionControl: control, admission: {gate: Context.get(team, SupervisionGate)}, workflowStates: input.workflows,
    queues: {get size() {return counted.size();}},
    scopeEnabled: (projectId: string, mainThreadId?: string) => scope.scopeEnabled(projectId, mainThreadId),
    supervisionStopped: (threadId: string) => scope.supervisionStopped(threadId),
    startSupervision: control.startSupervision, dashboardStart: control.dashboardStart, startStatus: control.startStatus,
    saveThreadPolicy: control.saveThreadPolicy,
  };
});

export type PsxSupervisor = Effect.Success<ReturnType<typeof assembleSupervisor>>;

export interface FixtureOptions {
  readonly threadPolicy?: boolean;
  readonly prefix?: string;
}

export interface PsxFixture {
  readonly directory: string;
  readonly projections: Map<string, Projection>;
  readonly operations: Array<{tag: string; payload: Record<string, unknown>}>;
  readonly projectionReads: string[];
  readonly reads: string[];
  readonly db: DbSeam;
  readonly supervisorStore: StoreOpen["supervisors"];
  readonly stores: StoreOpen;
  readonly workflows: WorkflowStateStore["Service"];
  readonly threadPolicy: ThreadPolicyStore["Service"] | undefined;
  readonly baselineReads: number;
  readonly missingDefinitions: DefinitionsLoader;
  makeSupervisor(options?: {definitions?: DefinitionsLoader; now?: () => number; locks?: (locks: ScopeLocksShape) => ScopeLocksShape; policy?: ThreadPolicyStore["Service"]}): Effect.Effect<PsxSupervisor, GuidanceStoreError, Scope.Scope>;
  restart(): Effect.Effect<void>;
  messageDispatches(): Array<{tag: string; payload: Record<string, unknown>}>;
  launches(): Array<{tag: string; payload: Record<string, unknown>}>;
  setAcceptedDispatchesWithoutRun(count: number): void;
  setUnknownDispatches(count: number): void;
  setOperateHook(hook: OperateHook | null): void;
  setProjectionHook(hook: ProjectionHook | null): void;
  setReadHook(hook: ReadHook | null): void;
  addProject(project: ProjectInfo): void;
  addTurn(threadId: string, projectId: string, turn: Turn): void;
  reserveReadyBinding(mainThreadId?: string, projectId?: string): Effect.Effect<BindingRecord, ProjectSupervisorStoreError>;
}

const seedControls = (sql: StoreOpen["sql"]) => Effect.forEach(projects, (project) =>
  sql`INSERT INTO meta VALUES(${`supervisor_control:${JSON.stringify(project.id)}`},${JSON.stringify({generation: 1, enabled: true, manual: true})}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
{discard: true});

/** A temp guidance directory, native fakes and a supervisor factory. Real files, so the suite runs live. */
export const makeFixture = (initial: ReadonlyArray<{threadId: string; projectId: string; turns: readonly Turn[]}>, options: FixtureOptions = {}): Effect.Effect<PsxFixture, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectory({prefix: options.prefix ?? "psx-supervisor-"});
    const projections = new Map<string, Projection>();
    const turnsByThread = new Map<string, Turn[]>();
    let registeredProjects = [...projects];
    const operations: Array<{tag: string; payload: Record<string, unknown>}> = [];
    const projectionReads: string[] = [];
    const reads: string[] = [];
    let acceptedDispatchesWithoutRun = 0;
    let unknownDispatches = 0;
    let operateHook: OperateHook | null = null;
    let projectionHook: ProjectionHook | null = null;
    let readHook: ReadHook | null = null;
    let baselineReads = 0;
    for (const source of initial) {
      projections.set(source.threadId, makeSourceProjection(source.threadId, source.projectId, source.turns));
      turnsByThread.set(source.threadId, [...source.turns]);
    }
    const config: SupervisorConfig = {dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0};
    const latest: {scope: Scope.Scope; stores: StoreOpen; workflows: WorkflowStateStore["Service"]; close: Effect.Effect<void>} = yield* Effect.gen(function* () {
      const scope = yield* Scope.make();
      let closed = false;
      const close = Effect.gen(function* () {
        if (closed) return;
        closed = true;
        yield* Scope.close(scope, Exit.void);
      });
      const guidance = yield* openGuidance(directory, scope).pipe(Effect.onError(() => close));
      yield* seedControls(guidance.sql);
      const stores = yield* openSupervisors(directory, guidance, scope).pipe(Effect.onError(() => close));
      const workflows = yield* openWorkflows(stores, scope, (projectId) => stores.supervisors.enabled(projectId));
      return {scope, stores, workflows, close};
    });
    const current = {run: latest};
    yield* Effect.addFinalizer(() => current.run.close.pipe(Effect.andThen(fs.remove(directory, {recursive: true})), Effect.orDie));
    const catalog: StoreShape["catalog"] = () => Effect.sync(() => ({
      projects: registeredProjects.map((project) => ({project, available: true})),
      threads: [...projections.values()].map((projection) => projection.thread),
    }));
    const projection: T3ClientShape["projection"] = (threadId) => Effect.gen(function* () {
      projectionReads.push(threadId);
      const hooked = projectionHook?.(threadId);
      if (hooked) return yield* Effect.mapError(hooked, (error) => error instanceof T3TransportError ? error : new T3TransportError("projection hook failed", 500));
      const found = projections.get(threadId);
      if (!found) return yield* Effect.fail(new T3TransportError("missing projection", 404));
      return {projection: found, snapshotSequence: 20};
    });
    const read: NativeRpcShape = {
      call: (tag, payload) => Effect.gen(function* () {
        reads.push(tag);
        if (tag === "server.getConfig") {
          const hooked = readHook?.(tag);
          if (hooked && Effect.isEffect(hooked)) yield* Effect.orDie(hooked);
          return modelConfig;
        }
        const item = turnItemAnswer(projections, tag, {...payload});
        if (item) return item;
        return yield* Effect.fail(new SupervisorRpcError("uncertain"));
      }),
      initiate: (tag, payload) => Effect.sync(() => ({sent: Effect.succeed(true), result: settleRpc(read.call(tag, payload)), release: Effect.void})),
    };
    const defaultOperate = (tag: string, payload: Record<string, unknown>): Effect.Effect<unknown, SupervisorRpcError> => {
      if (unknownDispatches > 0) {unknownDispatches -= 1; return Effect.fail(new SupervisorRpcError("uncertain"));}
      if (tag === "scheduledTasks.list") return Effect.succeed({tasks: []});
      if (tag === "orchestration.launchThread") return Effect.sync(() => {
        const threadId = String(payload.threadId);
        if (!projections.has(threadId)) projections.set(threadId, emptySupervisorProjection(threadId, String(payload.projectId), payload.modelSelection as SupervisorModelSelection));
        return {accepted: true};
      });
      if (tag === "orchestration.dispatchCommand" && payload.type === "message.dispatch") {
        const found = projections.get(String(payload.threadId));
        if (!found) return Effect.fail(new SupervisorRpcError("uncertain"));
        return Effect.sync(() => {
          if (acceptedDispatchesWithoutRun > 0) {acceptedDispatchesWithoutRun -= 1; return {accepted: true};}
          addSupervisorRequest(found, payload);
          delete found.thread.settledAt;
          return {accepted: true};
        });
      }
      if (tag === "orchestration.dispatchCommand" && payload.type === "thread.model-selection.set") {
        const found = projections.get(String(payload.threadId));
        if (!found) return Effect.fail(new SupervisorRpcError("uncertain"));
        return Effect.sync(() => {
          found.thread.modelSelection = payload.modelSelection as Projection["thread"]["modelSelection"];
          return {accepted: true};
        });
      }
      if (tag === "orchestration.dispatchCommand" && payload.type === "thread.settle") {
        const found = projections.get(String(payload.threadId));
        if (!found) return Effect.fail(new SupervisorRpcError("uncertain"));
        return Effect.sync(() => {
          found.thread.settledAt = new Date().toISOString();
          return {sequence: 20};
        });
      }
      return Effect.fail(new SupervisorRpcError("uncertain"));
    };
    const operate: NativeRpcShape = {
      call: (tag, payload) => settleRpc(defaultOperate(tag, {...payload})),
      initiate: (tag, payload) => Effect.sync(() => {
        const recorded = {...payload};
        operations.push({tag, payload: recorded});
        const hooked = operateHook?.(tag, recorded);
        const result = hooked ? settleRpc(hooked) : settleRpc(defaultOperate(tag, recorded));
        return {sent: Effect.succeed(true), result, release: Effect.void};
      }),
    };
    const baseline = Effect.sync((): SupervisorBaseline => {
      baselineReads += 1;
      return {snapshotSequence: activationSequence, threads: [...projections.values()].map((item) => {
        const latest = (turnsByThread.get(item.thread.id) ?? []).filter((turn) => turn.sequence <= activationSequence).at(-1);
        return {id: item.thread.id, latestRunId: latest ? "run-" + latest.id : null};
      })};
    });
    const loaderFor = (override?: DefinitionsLoader): DefinitionsLoader => override ?? {load: (projectId, threadId) => Effect.succeed(
      missingDefinitions(projectId, threadId, registeredProjects.find((project) => project.id === projectId)?.workspaceRoot ?? ""))};
    const opened = (): Effect.Effect<typeof latest> => Effect.gen(function* () {
      const scope = yield* Scope.make();
      let closed = false;
      const close = Effect.gen(function* () {
        if (closed) return;
        closed = true;
        yield* Scope.close(scope, Exit.void);
      });
      const guidance = yield* openGuidance(directory, scope).pipe(Effect.onError(() => close));
      const stores = yield* openSupervisors(directory, guidance, scope).pipe(Effect.onError(() => close));
      const workflows = yield* openWorkflows(stores, scope, (projectId) => stores.supervisors.enabled(projectId));
      return {scope, stores, workflows, close};
    });
    const fixture: PsxFixture = {
      directory, projections, operations, projectionReads, reads,
      get db() {return current.run.stores.db;},
      get supervisorStore() {return current.run.stores.supervisors;},
      get stores() {return current.run.stores;},
      get workflows() {return current.run.workflows;},
      get threadPolicy() {return options.threadPolicy ? current.run.stores.policy : undefined;},
      get baselineReads() {return baselineReads;},
      get missingDefinitions() {return loaderFor();},
      makeSupervisor: (overrides = {}) => assembleSupervisor({
        config, stores: current.run.stores, workflows: current.run.workflows, catalog, projection, read, operate, baseline,
        definitions: loaderFor(overrides.definitions), now: overrides.now, locks: overrides.locks, policy: overrides.policy,
      }),
      restart: () => Effect.gen(function* () {
        yield* current.run.close;
        current.run = yield* opened();
      }),
      messageDispatches: () => operations.filter((call) => call.tag === "orchestration.dispatchCommand" && call.payload.type === "message.dispatch"),
      launches: () => operations.filter((call) => call.tag === "orchestration.launchThread"),
      setAcceptedDispatchesWithoutRun: (count) => {acceptedDispatchesWithoutRun = count;},
      setUnknownDispatches: (count) => {unknownDispatches = count;},
      setOperateHook: (hook) => {operateHook = hook;},
      setProjectionHook: (hook) => {projectionHook = hook;},
      setReadHook: (hook) => {readHook = hook;},
      addProject: (project) => {registeredProjects = [...registeredProjects, project];},
      addTurn: (threadId, projectId, turn) => {
        const turns = [...(turnsByThread.get(threadId) ?? []), turn];
        turnsByThread.set(threadId, turns);
        projections.set(threadId, makeSourceProjection(threadId, projectId, turns));
      },
      reserveReadyBinding: (mainThreadId = "source-thread", projectId = "project-a") => Effect.gen(function* () {
        const main = projections.get(mainThreadId);
        if (!main) return yield* Effect.die(new Error(`missing main ${mainThreadId}`));
        const binding = yield* current.run.stores.supervisors.reserve(projectId, mainThreadId, main.thread.title, defaultSupervisorModel, activationSequence, Date.now());
        const ready = {...binding, state: "ready" as const};
        yield* current.run.stores.supervisors.setBinding(ready);
        projections.set(ready.threadId, emptySupervisorProjection(ready.threadId, ready.projectId, defaultSupervisorModel));
        return ready;
      }),
    };
    return fixture;
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie);

export interface FailingPolicy {
  failSaves: boolean;
  failedSaves: number;
  readonly service: ThreadPolicyStore["Service"];
  readonly get: ThreadPolicyStore["Service"]["get"];
}

/** A No Project chat with one human request and a policy store whose save can fail. */
export const makeNoProjectFixture = (now?: () => number) => Effect.gen(function* () {
  const fixture = yield* makeFixture([{threadId: "manual", projectId: "project-a", turns: []}, {threadId: "other", projectId: "project-a", turns: []}], {prefix: "psx-no-project-"});
  yield* fixture.db.prepare("INSERT INTO classifications VALUES(?,?)").run("project-a", "scratch");
  const real = fixture.stores.policy;
  const policy: FailingPolicy = {failSaves: false, failedSaves: 0, get: real.get, service: {get: real.get, save: (input) => Effect.suspend(() => {
    if (!policy.failSaves) return real.save(input);
    policy.failedSaves += 1;
    return Effect.fail(new ThreadPolicyStoreError({reason: "sql_failed", sqlReason: "simulated thread-policy save failure"}));
  })}};
  const supervisor = yield* fixture.makeSupervisor({...(now ? {now} : {}), policy: policy.service});
  yield* supervisor.cycle;
  fixture.addTurn("manual", "project-a", {id: "request-start", sequence: 20, text: "Have Supervisor follow this task: add a CSV export."});
  fixture.projections.get("manual")!.messages[0]!.createdAt = new Date(Date.now() - 1000).toISOString();
  return {fixture, supervisor, policy};
});

/** Digest of every supervisor_* table and every meta row, independent of physical row order. */
export const supervisionStateDigest = (db: DbSeam): Effect.Effect<{tables: string[]; digest: string}> => Effect.gen(function* () {
  const tables = (yield* db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'supervisor\\_%' ESCAPE '\\' ORDER BY name").all()).map((row) => String(row.name));
  const hash = createHash("sha256");
  for (const table of [...tables, "meta"]) {
    const rows = (yield* db.prepare(`SELECT * FROM "${table}"`).all()).map((row) => JSON.stringify(Object.entries(row))).sort();
    hash.update(JSON.stringify([table, rows]));
  }
  return {tables, digest: hash.digest("hex")};
});

export { submitStored as submitInterpretation };
