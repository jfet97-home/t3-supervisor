import { Cause, Context, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import type { ProjectionRead } from "./g1a-conversation.js";
import type { ConversationStores } from "./g1a-conversation.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import {
  DefinitionSourceFailure, ProjectDefinitions, type DefinitionCheckoutTarget, type DefinitionPresence, type ProjectDefinitionGlobalSetupOutcome,
  type ProjectDefinitionSetupInput, type ProjectDefinitionSetupOutcome,
} from "../../src/project-definitions.js";
import { ProjectSupervisor, type SupervisorDefinitionsAccess } from "../../src/project-supervisor.js";
import type { SupervisorBaseline } from "../../src/project-supervisor-store.js";
import { ScopeLocks } from "../../src/scope-locks.js";
import { Store, type StoreShape } from "../../src/store.js";
import { SupervisionControl } from "../../src/supervision-control.js";
import { SupervisionScope, SupervisionScopeService } from "../../src/supervision-gate.js";
import { SupervisionTeamLive } from "../../src/supervision-live.js";
import { SupervisorConversation } from "../../src/supervisor-conversation.js";
import { NativeOperateRpc, NativeRpc, NativeShell, SupervisorRpcError, type NativeRpcShape } from "../../src/supervisor-native.js";
import { T3Client, type T3ClientShape } from "../../src/t3.js";
import type { SupervisorSettings } from "../../src/types.js";
import { WorkflowStateStore } from "../../src/workflow-state-store.js";

// a thrown or failed activation read is an uncertain native call, as the baseline shell reported it; an interruption still propagates
export const asRpcBaseline = (read: () => Effect.Effect<SupervisorBaseline, unknown>): Effect.Effect<SupervisorBaseline, SupervisorRpcError> =>
  Effect.suspend(read).pipe(Effect.catchCauseIf((cause) => !Cause.hasInterruptsOnly(cause), (cause) => {
    const squashed = Cause.squash(cause);
    return Effect.fail(squashed instanceof SupervisorRpcError ? squashed : new SupervisorRpcError("uncertain"));
  })) as Effect.Effect<SupervisorBaseline, SupervisorRpcError>;

/** Definition operations a control or workflow unit installs only when the test configures them. */
export interface CtlDefinitionOps {
  load: (projectId: string, threadId?: string | null) => Effect.Effect<ProjectDefinitionSnapshot, unknown>;
  presence?: (projectId: string) => Effect.Effect<DefinitionPresence, unknown>;
  presenceGlobal?: () => Effect.Effect<DefinitionPresence & {readonly path?: string}, unknown>;
  globalDefinitionsPath?: () => string;
  globalFingerprint?: () => Effect.Effect<string | null, unknown>;
  initializeGlobal?: () => Effect.Effect<Omit<ProjectDefinitionGlobalSetupOutcome, "path">, unknown>;
  checkoutTargets?: (projectId: string) => Effect.Effect<ReadonlyArray<DefinitionCheckoutTarget>, unknown>;
  presenceForCheckout?: (projectId: string, threadId: string | null) => Effect.Effect<DefinitionPresence, unknown>;
  initialize?: (projectId: string, threadId: string | null, input: ProjectDefinitionSetupInput) =>
    Effect.Effect<Omit<ProjectDefinitionSetupOutcome, "path">, unknown>;
}

const sourceFailure = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, DefinitionSourceFailure> =>
  Effect.mapError(effect, (error) => error instanceof DefinitionSourceFailure ? error : new DefinitionSourceFailure({error}));

// read through the ops object on every call, so a test can replace load after the supervisor exists
const accessOf = (ops: CtlDefinitionOps): SupervisorDefinitionsAccess => {
  const run = <A>(read: () => Effect.Effect<A, unknown>) => sourceFailure(Effect.suspend(read));
  return {
    load: (projectId, threadId) => run(() => ops.load(projectId, threadId)),
    ...(ops.presence ? {presence: (projectId: string) => run(() => ops.presence!(projectId))} : {}),
    ...(ops.presenceGlobal ? {presenceGlobal: () => run(() => ops.presenceGlobal!())} : {}),
    ...(ops.globalDefinitionsPath ? {globalDefinitionsPath: () => ops.globalDefinitionsPath!()} : {}),
    ...(ops.globalFingerprint ? {globalFingerprint: () => run(() => ops.globalFingerprint!())} : {}),
    ...(ops.initializeGlobal ? {initializeGlobal: () => run(() => ops.initializeGlobal!())} : {}),
    ...(ops.checkoutTargets ? {checkoutTargets: (projectId: string) => run(() => ops.checkoutTargets!(projectId))} : {}),
    ...(ops.presenceForCheckout ? {presenceForCheckout: (projectId: string, threadId: string | null) => run(() => ops.presenceForCheckout!(projectId, threadId))} : {}),
    ...(ops.initialize ? {initialize: (projectId: string, threadId: string | null, input: ProjectDefinitionSetupInput) =>
      run(() => ops.initialize!(projectId, threadId, input))} : {}),
  };
};

// the conversation's definitions service: load and the fingerprint are real, and every other operation is unused
const teamDefinitions = (ops: CtlDefinitionOps): ProjectDefinitions["Service"] => {
  const unused = (): Effect.Effect<never> => Effect.die(new Error("unused definitions operation"));
  return ProjectDefinitions.of({
    globalHomePath: "~",
    globalDefinitionsPath: ops.globalDefinitionsPath?.() ?? "~/.t3-supervisor",
    load: (projectId, threadId = null) => Effect.orDie(Effect.suspend(() => ops.load(projectId, threadId))),
    globalFingerprint: () => ops.globalFingerprint ? Effect.orDie(Effect.suspend(() => ops.globalFingerprint!())) : Effect.succeed(null),
    presence: unused, presenceGlobal: unused, presenceForCheckout: unused, checkoutTargets: unused, currentWorkspace: unused,
    initialize: unused, initializeGlobal: unused, readProjectConfig: unused,
  });
};

const t3Client = (read: ProjectionRead, snapshotSequence: number): T3ClientShape => ({
  descriptor: () => Effect.die(new Error("unused T3 descriptor")),
  watch: () => Effect.die(new Error("unused T3 watch")),
  projection: (threadId) => Effect.map(Effect.suspend(() => read(threadId)), (projection) => ({snapshotSequence, projection})),
});

export interface CtlSupervisorOptions {
  readonly stores: ConversationStores;
  readonly catalog: StoreShape["catalog"];
  readonly projection: ProjectionRead;
  readonly read: NativeRpcShape;
  readonly operate: NativeRpcShape | null;
  readonly baseline: Effect.Effect<SupervisorBaseline, SupervisorRpcError>;
  readonly definitions?: CtlDefinitionOps;
  readonly snapshotSequence?: number;
}

/**
 * The production supervisor over one run's stores: team services, Start/Stop control and the supervisor, with the ambient test
 * clock. Definition operations are only those the test configured. The conversation keeps the run's request store on `requests`.
 */
export const ctlSupervisor = (options: CtlSupervisorOptions) => Effect.gen(function* () {
  const {stores} = options;
  const config: SupervisorSettings = {dataDirectory: stores.directory, t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0};
  const scope = new SupervisionScope(config, {guidance: stores.guidance, supervisors: stores.supervisors, policy: stores.policy}, options.operate !== null);
  const workflowContext = yield* Layer.build(WorkflowStateStore.layerWith((projectId, mainThreadId) => scope.workflowEditingEnabled(projectId, mainThreadId)).pipe(
    Layer.provide(Layer.succeedContext(stores.context)))).pipe(Effect.orDie);
  const workflows = Context.get(workflowContext, WorkflowStateStore);
  const base = Context.merge(stores.context, workflowContext).pipe(Context.add(SupervisionScopeService, scope));
  const t3 = t3Client(options.projection, options.snapshotSequence ?? 20);
  const team = yield* Layer.build(SupervisionTeamLive({baseUrl: config.t3Url}).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeedContext(base), Layer.succeed(T3Client, t3),
    options.definitions ? Layer.succeed(ProjectDefinitions, teamDefinitions(options.definitions)) : Layer.empty,
    Layer.succeed(NativeRpc, options.read), options.operate ? Layer.succeed(NativeOperateRpc, options.operate) : Layer.empty, FetchHttpClient.layer)))).pipe(Effect.orDie);
  const locks = yield* Layer.build(ScopeLocks.layer);
  const shell = NativeShell.of({baseline: options.baseline, threads: Effect.die(new Error("unused native lineage read"))});
  const clients = Context.merge(Context.merge(base, team), locks).pipe(Context.add(Store, {catalog: options.catalog} as StoreShape),
    Context.add(T3Client, t3), Context.add(NativeRpc, options.read), Context.add(NativeShell, shell),
    (context) => options.operate ? Context.add(context, NativeOperateRpc, options.operate) : context);
  const control = yield* SupervisionControl.make.pipe(Effect.provide(clients));
  const {service} = yield* ProjectSupervisor.makeUnit(options.definitions ? {definitions: accessOf(options.definitions)} : {}).pipe(
    Effect.provideService(SupervisionControl, control), Effect.provide(clients));
  const conversation = Context.get(team, SupervisorConversation);
  return {
    ...service,
    conversation: {...conversation, requests: stores.requests},
    requests: stores.requests,
    store: stores.supervisors,
    guidance: stores.guidance,
    workflows,
    sql: stores.sql,
    definitions: options.definitions ?? null,
  };
});

export type CtlSupervisor = Effect.Success<ReturnType<typeof ctlSupervisor>>;
