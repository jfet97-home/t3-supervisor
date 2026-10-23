import assert from "node:assert/strict";
import { Deferred, Effect, Exit, Scope } from "effect";
import { fingerprint } from "../../src/guidance-store.js";
import type { InterpretationSubmitResponse } from "../../src/interpretation-submission.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { defaultSupervisorModel, type BindingRecord, type TaskRecord } from "../../src/project-supervisor-store.js";
import type { MessageInfo, Projection, RunInfo, ThreadInfo } from "../../src/types.js";
import { effectiveIndex, projectIndex } from "../project-definitions-fixture.js";
import { execute, intEndpoint, intRun, mcpCall, rows, temporaryDirectory, type IntEndpoint, type IntRun } from "./glinint-wiring.js";
import { installSubmission, setSubmissionStatus, submissionArguments, submissionDetail, type SubmissionItemOptions } from "./interpretation-submit.js";
import { intPeer, nativeReadRoutes, nativeReadState, type IntNativePeer, type NativeReadState, type PeerRoutes } from "./int-native-peer.js";

// one answer of the interpretation tool over the route: the http status, the mcp error flag and the typed response
export type SubmitReply = {httpStatus: number; isError: boolean; value: InterpretationSubmitResponse};

// the typed interpretation over the production boundary, in the caller's scope: the supervision run's project supervisor,
// write controller and mcp endpoint wired as the process wires them, a loopback t3 peer serving the native reads and
// accepting the operate commands, and temp guidance and policy files. a test adds a genuine human request to the main,
// runs the real supervision cycle, makes the root's submission through the authenticated /mcp/workflows route with its
// native tool item in the request run, and completes the run. a restart closes that run's scope and opens another on
// the same files and peer

export const interpretationProjectId = "project-interpretation";
const workspaceRoot = "/workspace/interpretation";
const baseTime = "2026-10-20T10:00:00.000Z";

const modelConfig = {providers: [{enabled: true, instanceId: "codex", displayName: "Codex", installed: true, status: "ready",
  models: ["gpt-6-luna", "gpt-6.1-sol"].map((slug) => ({slug, name: slug, capabilities: {optionDescriptors: [{id: "reasoningEffort", label: "Reasoning effort", type: "select",
    currentValue: "high", options: [{id: "low", label: "Low"}, {id: "high", label: "High"}, {id: "max", label: "Max"}]}]}}))}]};

const thread = (id: string, title: string): ThreadInfo => ({id, title, projectId: interpretationProjectId, archivedAt: null, deletedAt: null,
  lineage: {parentThreadId: null, relationshipToParent: null}});

// the ready definitions of the main's checkout: one reusable step, no required reference
export const interpretationDefinitions = (mainThreadId: string, overrides: Partial<ProjectDefinitionSnapshot> = {}): ProjectDefinitionSnapshot => ({
  projectId: interpretationProjectId, threadId: mainThreadId, workspaceRoot, globalOnly: false, globalRevision: null, revision: "definitions-1",
  editingAvailable: true, status: "ready", steps: [], workflows: [], config: effectiveIndex({steps: [], workflows: []}), projectConfig: projectIndex(),
  definitionFiles: [], complete: true, sources: [], issues: [], ...overrides,
});

// the interpretation fields of a finite one-step plan citing the task's source
export const planFields = (task: TaskRecord, objective = "Implement the export", extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  objective, reason: "The request asks for a concrete repository change.", sourceMessageIds: [task.sourceMessageId], supervision: "needed",
  workflow: {requirements: [], plan: {kind: "sequence", nodes: [{kind: "step", definitionId: null, localId: "implement-export", name: "Implement the export",
    description: "Make the requested change and keep the plan finite.", reason: "The task needs one bounded step."}]}},
  ...extra,
});

export type InterpretationFixture = {
  peer: IntNativePeer;
  native: NativeReadState;
  readonly core: IntRun;
  readonly endpoint: IntEndpoint;
  mainThreadId: string;
  binding: BindingRecord;
  definitions: {current: ProjectDefinitionSnapshot; reads: number};
  // every operate command the peer accepted, in order
  commands: Array<Record<string, unknown>>;
  main(): Projection;
  root(): Projection;
  // the interpretation requests dispatched to the root and the messages sent to the operative main
  interpretationDispatches(): Array<Record<string, unknown>>;
  rootSends(): Array<Record<string, unknown>>;
  operativeSends(): Array<Record<string, unknown>>;
  // a genuine visible human request in the main, as a new completed main run
  addRequest(id: string, text: string): void;
  task(): Effect.Effect<TaskRecord>;
  runOnce(): Effect.Effect<void>;
  // installs the root's native submission item for the arguments and calls the tool through the authenticated route
  submit(task: TaskRecord, args: Record<string, unknown>, options?: SubmissionItemOptions & {install?: boolean}): Effect.Effect<SubmitReply>;
  submitFields(task: TaskRecord, fields: Record<string, unknown>, options?: SubmissionItemOptions): Effect.Effect<SubmitReply>;
  setItemStatus(itemId: string, status: "running" | "completed" | "rolled_back", nodeStatus?: "running" | "completed" | "rolled_back"): void;
  // the request run of the task ends with the given status; its final chat text is the given one
  endRun(task: TaskRecord, status: "completed" | "failed" | "interrupted" | "cancelled" | "rolled_back", finalText?: string): void;
  receipts(): Effect.Effect<Array<Record<string, unknown>>>;
  // registers now and completes with the first operate command from now on that matches
  nextCommand(matches: (command: Record<string, unknown>) => boolean): Effect.Effect<Record<string, unknown>>;
  // a process restart on the same files and peer: the endpoint and the supervision run are closed and opened again
  restart(): Effect.Effect<void>;
};

type Opened = {run: IntRun; endpoint: IntEndpoint; scope: Scope.Closeable};

// `noProject`: the project is a scratch (no project) project, whose chats are supervised only after an explicit start
export const startInterpretationFixture = (options: {mainThreadId?: string; noProject?: boolean} = {}): Effect.Effect<InterpretationFixture, never, Scope.Scope> =>
  Effect.gen(function* () {
    const mainThreadId = options.mainThreadId ?? "main-interpretation";
    const native = nativeReadState();
    const commands: Array<Record<string, unknown>> = [];
    // the waiters for a command to arrive at the peer, each completed once by the first matching command
    const waiters: Array<{matches: (command: Record<string, unknown>) => boolean; deferred: Deferred.Deferred<Record<string, unknown>>}> = [];
    const projections = native.projections;
    const operate: PeerRoutes = {rpc: (entry) => {
      if (entry.tag === "server.getConfig") return {value: modelConfig};
      if (entry.tag === "scheduledTasks.list") return {value: {tasks: []}};
      if (entry.tag !== "orchestration.dispatchCommand") return undefined;
      const payload = entry.payload;
      return Effect.gen(function* () {
        commands.push(payload);
        const pending = waiters.splice(0);
        for (const waiter of pending) {
          if (waiter.matches(payload)) yield* Deferred.succeed(waiter.deferred, payload);
          else waiters.push(waiter);
        }
        if (payload.type === "message.dispatch") {
          const projection = projections.get(String(payload.threadId));
          if (!projection) return yield* Effect.die(new Error("unknown thread"));
          // the accepted message starts its own run, as t3 does
          const ordinal = projection.runs.length + 1;
          const runId = `${projection.thread.id}-run-${ordinal}`;
          const rootNodeId = `${projection.thread.id}-root-${ordinal}`;
          const now = new Date().toISOString();
          projection.runs.push({id: runId, threadId: projection.thread.id, ordinal, status: "running", requestedAt: now, startedAt: now, completedAt: null,
            rootNodeId, userMessageId: String(payload.messageId), providerThreadId: `${projection.thread.id}-provider`});
          projection.messages.push({id: String(payload.messageId), threadId: projection.thread.id, runId, nodeId: rootNodeId, role: "user", text: String(payload.text),
            streaming: false, createdAt: now, updatedAt: now, createdBy: "system", creationSource: "server"});
          (projection.nodes as Array<Record<string, unknown>>).push({id: rootNodeId, threadId: projection.thread.id, runId, parentNodeId: null, rootNodeId,
            kind: "root_turn", status: "running", providerThreadId: `${projection.thread.id}-provider`});
        }
        return {value: {accepted: true, sequence: 20}};
      });
    }};
    const directory = yield* temporaryDirectory("interpretation-integration-");
    const peer = yield* intPeer([nativeReadRoutes(native), operate]);
    const definitions = {current: interpretationDefinitions(mainThreadId), reads: 0};
    const mainThread = thread(mainThreadId, "Operative main");
    const catalogThreads: ThreadInfo[] = [mainThread];
    const open = Effect.gen(function* () {
      const scope = yield* Scope.make();
      return yield* Effect.gen(function* () {
        const run = yield* intRun({directory, peerUrl: peer.baseUrl,
          definitions: () => Effect.sync(() => {definitions.reads++; return definitions.current;}),
          catalog: () => ({projects: [{project: {id: interpretationProjectId, title: "Interpretation", workspaceRoot}, available: true}], threads: catalogThreads})}).pipe(Scope.provide(scope));
        const endpoint = yield* intEndpoint(run).pipe(Scope.provide(scope));
        return {run, endpoint, scope};
      }).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void));
    });
    let current: Opened = yield* open;
    yield* Effect.addFinalizer(() => Scope.close(current.scope, Exit.void));
    const control = (scopeKey: string | null) => execute(current.run.sql, "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      `supervisor_control:${JSON.stringify(scopeKey)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
    yield* control(null);
    yield* control(interpretationProjectId);
    if (options.noProject) yield* execute(current.run.sql, "INSERT INTO classifications VALUES(?,?)", interpretationProjectId, "scratch");
    const reserved = yield* current.run.store.reserve(interpretationProjectId, mainThreadId, mainThread.title, defaultSupervisorModel, 0, 1).pipe(Effect.orDie);
    const binding: BindingRecord = {...reserved, state: "ready"};
    yield* current.run.store.setBinding(binding).pipe(Effect.orDie);
    const rootThread = thread(binding.threadId, "Project Supervisor");
    catalogThreads.push(rootThread);
    native.shellThreads = catalogThreads.map((value) => ({...value, latestRunId: null}));
    // both conversations use native modes that permit supervisor contact, and the operative has no pending owner question
    projections.set(mainThreadId, {thread: {...mainThread, runtimeMode: "full-access", interactionMode: "default"}, runs: [], messages: [], nodes: [], runtimeRequests: []} as Projection);
    projections.set(binding.threadId, {thread: {...rootThread, modelSelection: defaultSupervisorModel, runtimeMode: "full-access", interactionMode: "default"},
      runs: [], messages: [], nodes: [], turnItems: []});
    const main = () => projections.get(mainThreadId)!;
    const root = () => projections.get(binding.threadId)!;
    // the activation boundary is read on the first cycle, before any request exists
    yield* current.run.supervisor.cycle.pipe(Effect.orDie);
    const submit: InterpretationFixture["submit"] = (task, args, submitOptions = {}) => {
      // the native item is installed before this effect runs, so a concurrent pair both see it once the second call is built
      if (submitOptions.install !== false) {
        const itemId = installSubmission(root(), task, args, submitOptions);
        native.details.set(itemId, submissionDetail(root(), itemId)!);
      }
      return Effect.flatMap(Effect.suspend(() => mcpCall(current.endpoint, "supervision_interpretation_submit", args)),
        (reply): Effect.Effect<SubmitReply> => Effect.succeed({httpStatus: reply.httpStatus, isError: reply.isError, value: reply.value as InterpretationSubmitResponse}));
    };
    return {
      peer, native, mainThreadId, binding, definitions, commands, main, root,
      get core() {return current.run;},
      get endpoint() {return current.endpoint;},
      interpretationDispatches: () => commands.filter((command) => command.type === "message.dispatch" && String(command.commandId).startsWith("supervisor-objective:")),
      rootSends: () => commands.filter((command) => command.type === "message.dispatch" && command.threadId === binding.threadId),
      operativeSends: () => commands.filter((command) => command.type === "message.dispatch" && command.threadId === mainThreadId),
      addRequest: (id, text) => {
        const projection = main();
        const ordinal = projection.runs.length + 1;
        const run: RunInfo = {id: `run-${id}`, threadId: mainThreadId, ordinal, status: "completed", requestedAt: baseTime, startedAt: baseTime, completedAt: baseTime,
          rootNodeId: `root-${id}`, userMessageId: id, providerThreadId: "main-provider"};
        const message: MessageInfo = {id, threadId: mainThreadId, runId: run.id, nodeId: run.rootNodeId!, role: "user", text, streaming: false,
          createdAt: new Date().toISOString(), updatedAt: baseTime, createdBy: "user", creationSource: "web"};
        projection.runs.push(run);
        projection.messages.push(message);
        (projection.nodes as Array<Record<string, unknown>>).push({id: run.rootNodeId, threadId: mainThreadId, runId: run.id, parentNodeId: null,
          rootNodeId: run.rootNodeId, kind: "root_turn", status: "completed", providerThreadId: "main-provider"});
        assert.equal(fingerprint(text).length, 64);
      },
      task: () => Effect.gen(function* () {
        const task = yield* current.run.store.task(mainThreadId).pipe(Effect.orDie);
        assert.ok(task, "the main has a task");
        return task;
      }),
      runOnce: () => current.run.supervisor.cycle.pipe(Effect.orDie),
      submit,
      submitFields: (task, fields, submitOptions) => submit(task, submissionArguments(task, fields), submitOptions),
      setItemStatus: (itemId, status, nodeStatus) => setSubmissionStatus(root(), itemId, status, nodeStatus),
      endRun: (task, status, finalText = "I submitted the interpretation through the tool.") => {
        const projection = root();
        const run = projection.runs.find((value) => value.userMessageId === task.messageId);
        assert.ok(run?.rootNodeId, "the request run");
        run.status = status;
        run.completedAt = new Date().toISOString();
        const nodes = projection.nodes as Array<Record<string, unknown>>;
        const rootNode = nodes.find((node) => node.id === run.rootNodeId)!;
        rootNode.status = status === "rolled_back" ? "rolled_back" : "completed";
        if (status !== "completed") return;
        const nodeId = `${run.id}-answer`;
        nodes.push({id: nodeId, threadId: projection.thread.id, runId: run.id, parentNodeId: run.rootNodeId, rootNodeId: run.rootNodeId, kind: "assistant_message",
          status: "completed", providerThreadId: run.providerThreadId});
        projection.messages.push({id: `${run.id}-answer`, threadId: projection.thread.id, runId: run.id, nodeId, role: "assistant", text: finalText, streaming: false,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()});
      },
      receipts: () => rows(current.run.sql, "SELECT * FROM supervisor_workflow_write_receipts WHERE operation_namespace='interpretation'"),
      nextCommand: (matches) => {
        const deferred = Deferred.makeUnsafe<Record<string, unknown>>();
        waiters.push({matches, deferred});
        return Deferred.await(deferred);
      },
      restart: () => Effect.gen(function* () {
        const previous = current.scope;
        yield* Scope.close(previous, Exit.void);
        current = yield* open;
        // the catalog classification the scope predicates need before the first cycle, as the process's first read sets it
        yield* current.run.supervisor.candidates("").pipe(Effect.orDie);
      }),
    };
  });
