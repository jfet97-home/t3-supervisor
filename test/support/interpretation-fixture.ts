import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../../src/guidance-store.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { defaultSupervisorModel, type BindingRecord, type TaskRecord } from "../../src/project-supervisor-store.js";
import type { MessageInfo, Projection, RunInfo, ThreadInfo } from "../../src/types.js";
import { effectiveIndex, projectIndex } from "../project-definitions-fixture.js";
import { installSubmission, setSubmissionStatus, submissionArguments, submissionDetail, type SubmissionItemOptions } from "./interpretation-submit.js";
import { nativeReadRoutes, nativeReadState, startIntPeer, type IntNativePeer, type NativeReadState, type PeerRoutes } from "./int-native-peer.js";
import { callTool, openIntSupervision, startIntEndpoint, type IntEndpoint, type IntSupervision } from "./int-production-wiring.js";
import type { InterpretationSubmitResponse } from "../../src/interpretation-submission.js";

// one answer of the interpretation tool over the route: the HTTP status, the MCP error flag and the typed response
export type SubmitReply = {httpStatus: number; isError: boolean; value: InterpretationSubmitResponse};

// the typed interpretation over the production boundary: the supervision run's project supervisor, write controller and MCP
// endpoint wired as the process wires them, a loopback T3 peer serving the native reads and accepting the operate commands, and
// temp guidance and policy files. A test adds a genuine human request to the main, runs the real supervision cycle, makes the
// root's submission through the authenticated /mcp/workflows route with its native tool item in the request run, and completes
// the run

export const interpretationProjectId = "project-interpretation";
const workspaceRoot = "/workspace/interpretation";
const baseTime = "2026-10-20T10:00:00.000Z";

const modelConfig = {providers: [{enabled: true, instanceId: "codex", displayName: "Codex", installed: true, status: "ready",
  models: ["gpt-6-luna"].map((slug) => ({slug, name: slug, capabilities: {optionDescriptors: [{id: "reasoningEffort", label: "Reasoning effort", type: "select",
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
  readonly core: IntSupervision;
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
  task(): Promise<TaskRecord>;
  runOnce(): Promise<void>;
  // installs the root's native submission item for the arguments and calls the tool through the authenticated route
  submit(task: TaskRecord, args: Record<string, unknown>, options?: SubmissionItemOptions & {install?: boolean}): Promise<SubmitReply>;
  submitFields(task: TaskRecord, fields: Record<string, unknown>, options?: SubmissionItemOptions): Promise<SubmitReply>;
  setItemStatus(itemId: string, status: "running" | "completed" | "rolled_back", nodeStatus?: "running" | "completed" | "rolled_back"): void;
  // the request run of the task ends with the given status; its final chat text is the given one
  endRun(task: TaskRecord, status: "completed" | "failed" | "interrupted" | "cancelled" | "rolled_back", finalText?: string): void;
  receipts(): Promise<Array<Record<string, unknown>>>;
  // resolves with the first operate command from now on that matches
  nextCommand(matches: (command: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  // a process restart on the same files and peer: the endpoint and the supervision run are closed and opened again
  restart(): Promise<void>;
  close(): Promise<void>;
};

// `noProject`: the project is a scratch (No Project) project, whose chats are supervised only after an explicit Start
export const startInterpretationFixture = async (options: {mainThreadId?: string; noProject?: boolean} = {}): Promise<InterpretationFixture> => {
  const mainThreadId = options.mainThreadId ?? "main-interpretation";
  const native = nativeReadState();
  const commands: Array<Record<string, unknown>> = [];
  // the waiters for a command to arrive at the peer, each resolved once by the first matching command
  const waiters: Array<{matches: (command: Record<string, unknown>) => boolean; resolve: (command: Record<string, unknown>) => void}> = [];
  const projections = native.projections;
  const operate: PeerRoutes = {rpc: (entry) => {
    if (entry.tag === "server.getConfig") return {value: modelConfig};
    if (entry.tag === "scheduledTasks.list") return {value: {tasks: []}};
    if (entry.tag !== "orchestration.dispatchCommand") return undefined;
    const payload = entry.payload;
    commands.push(payload);
    for (const waiter of waiters.splice(0)) {
      if (waiter.matches(payload)) waiter.resolve(payload);
      else waiters.push(waiter);
    }
    if (payload.type === "message.dispatch") {
      const projection = projections.get(String(payload.threadId));
      if (!projection) throw new Error("unknown thread");
      // the accepted message starts its own run, as T3 does
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
  }};
  const peer = await startIntPeer([nativeReadRoutes(native), operate]);
  const directory = await mkdtemp(join(tmpdir(), "interpretation-integration-"));
  const definitions = {current: interpretationDefinitions(mainThreadId), reads: 0};
  const mainThread = thread(mainThreadId, "Operative main");
  const catalogThreads: ThreadInfo[] = [mainThread];
  const open = () => openIntSupervision({directory, peerUrl: peer.baseUrl,
    definitions: {load: async () => {definitions.reads++;return definitions.current;}},
    catalog: () => ({projects: [{project: {id: interpretationProjectId, title: "Interpretation", workspaceRoot}, available: true}], threads: catalogThreads})});
  let core = await open();
  const control = async (scope: string | null) => await core.guidance.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`supervisor_control:${JSON.stringify(scope)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  await control(null);
  await control(interpretationProjectId);
  if (options.noProject) await core.guidance.db.prepare("INSERT INTO classifications VALUES(?,?)").run(interpretationProjectId, "scratch");
  const reserved = await core.store.reserve(interpretationProjectId, mainThreadId, mainThread.title, defaultSupervisorModel, 0, 1);
  const binding: BindingRecord = {...reserved, state: "ready"};
  await core.store.setBinding(binding);
  const rootThread = thread(binding.threadId, "Project Supervisor");
  catalogThreads.push(rootThread);
  native.shellThreads = catalogThreads.map((value) => ({...value, latestRunId: null}));
  // both conversations use native modes that permit Supervisor contact, and the operative has no pending owner question
  projections.set(mainThreadId, {thread: {...mainThread, runtimeMode: "full-access", interactionMode: "default"}, runs: [], messages: [], nodes: [], runtimeRequests: []} as Projection);
  projections.set(binding.threadId, {thread: {...rootThread, modelSelection: defaultSupervisorModel, runtimeMode: "full-access", interactionMode: "default"},
    runs: [], messages: [], nodes: [], turnItems: []});
  let endpoint = await startIntEndpoint(core);
  const main = () => projections.get(mainThreadId)!;
  const root = () => projections.get(binding.threadId)!;
  const runOnce = () => core.supervision.runOnce(AbortSignal.timeout(30_000));
  // the activation boundary is read on the first cycle, before any request exists
  await runOnce();
  const submit: InterpretationFixture["submit"] = async (task, args, submitOptions = {}) => {
    if (submitOptions.install !== false) {
      const itemId = installSubmission(root(), task, args, submitOptions);
      native.details.set(itemId, submissionDetail(root(), itemId)!);
    }
    return await callTool(endpoint, "supervision_interpretation_submit", args) as SubmitReply;
  };
  return {
    peer, native, mainThreadId, binding, definitions, commands, main, root,
    get core() {return core;},
    get endpoint() {return endpoint;},
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
    task: async () => {
      const task = await core.store.task(mainThreadId);
      assert.ok(task, "the main has a task");
      return task;
    },
    runOnce,
    submit,
    submitFields: async (task, fields, submitOptions) => await submit(task, submissionArguments(task, fields), submitOptions),
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
    receipts: async () => await core.guidance.db.prepare("SELECT * FROM supervisor_workflow_write_receipts WHERE operation_namespace='interpretation'").all(),
    nextCommand: (matches) => new Promise((resolve) => {waiters.push({matches, resolve});}),
    restart: async () => {
      await endpoint.close();
      await core.close();
      core = await open();
      endpoint = await startIntEndpoint(core);
      // the catalog classification the scope predicates need before the first cycle, as the process's first read sets it
      await core.supervision.candidates("");
    },
    close: async () => {
      try {await endpoint.close();}
      finally {
        try {await core.close();}
        finally {
          try {await peer.close();}
          finally {await rm(directory, {recursive: true, force: true});}
        }
      }
    },
  };
};
