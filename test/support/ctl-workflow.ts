import assert from "node:assert/strict";
import { Effect } from "effect";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import type { SupervisorModelSelection } from "../../src/project-supervisor-contract.js";
import type { TaskRecord } from "../../src/project-supervisor-store.js";
import { SupervisorRpcError, type NativeRpcShape } from "../../src/supervisor-native.js";
import { T3TransportError } from "../../src/t3.js";
import type { ProjectInfo, Projection } from "../../src/types.js";
import { effectiveIndex, indexSource, projectIndex, stepSource, testSummary } from "../project-definitions-fixture.js";
import { dataDirectory, interpretationSubmitter, nativeClient, openStores, realTime } from "./g1a-conversation.js";
import { execute } from "./g1b-conversation.js";
import { asRpcBaseline, ctlSupervisor, type CtlDefinitionOps, type CtlSupervisor } from "./ctl-supervisor.js";
import { submissionArguments, turnItemAnswer } from "./interpretation-submit.js";

export const projectId = "project-a";
export const sourceThreadId = "source-thread";
export const sourceMessageId = "source-message";
const baseTime = "2026-10-13T10:00:00.000Z";

const project: ProjectInfo = {id: projectId, title: "Project A", workspaceRoot: "/work/project"};
const modelConfig = {
  providers: [{
    enabled: true,
    instanceId: "codex",
    displayName: "Codex",
    installed: true,
    status: "ready",
    models: ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol"].map((slug) => ({
      slug,
      name: slug,
      capabilities: {optionDescriptors: [{
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        currentValue: "high",
        options: [
          {id: "low", label: "Low"},
          {id: "high", label: "High"},
          {id: "max", label: "Max"},
        ],
      }]},
    })),
  }],
};

export const definitionSnapshot = (overrides: Partial<ProjectDefinitionSnapshot> = {}): ProjectDefinitionSnapshot => ({
  projectId,
  threadId: sourceThreadId,
  workspaceRoot: "/work/project/worktrees/feature",
  revision: "revision-1",
  globalOnly: false,
  globalRevision: null,
  editingAvailable: true,
  status: "ready",
  steps: [{id: "test-plan", name: "Test plan", description: "Verify behavior.", summary: testSummary("test-plan"), origin: "project", path: ".t3-supervisor/steps/test-plan.md", sourceId: "test-plan"}],
  workflows: [],
  config: effectiveIndex({steps: [{id: "test-plan"}], workflows: []}, [{step: "test-plan"}]),
  projectConfig: projectIndex({steps: ["test-plan"], required: [{step: "test-plan"}]}),
  definitionFiles: [],
  complete: true,
  sources: [
    {path: ".t3-supervisor/project.yaml", content: indexSource({steps: ["test-plan"], required: [{step: "test-plan"}]}), origin: "project"},
    {path: ".t3-supervisor/steps/test-plan.md", content: stepSource("test-plan", "Verify behavior."), origin: "project"},
  ],
  issues: [],
  ...overrides,
});

export const unavailableDefinitionSnapshot = (): ProjectDefinitionSnapshot => ({...definitionSnapshot(),
  workspaceRoot: "/work/project/worktrees/feature", revision: null, editingAvailable: false, status: "unavailable",
  steps: [], workflows: [], config: {workflows: [], steps: []}, projectConfig: null, definitionFiles: [], complete: false, sources: [],
  issues: [{path: ".t3-supervisor", code: "definition_read_failed",
    message: "Definition sources could not be read. Requirements and policy remain unknown; make a finite provisional plan."}],
});

const sourceProjection = (): Projection => ({
  thread: {
    id: sourceThreadId,
    title: "Task conversation",
    projectId,
    lineage: {parentThreadId: null, relationshipToParent: null},
  },
  runs: [{
    id: "source-run",
    threadId: sourceThreadId,
    ordinal: 1,
    status: "completed",
    requestedAt: baseTime,
    startedAt: baseTime,
    completedAt: baseTime,
    rootNodeId: "source-root",
    userMessageId: sourceMessageId,
    providerThreadId: "source-provider",
  }],
  messages: [{
    id: sourceMessageId,
    threadId: sourceThreadId,
    runId: "source-run",
    nodeId: "source-root",
    role: "user",
    text: "Implement the export workflow",
    streaming: false,
    createdAt: baseTime,
    updatedAt: baseTime,
    createdBy: "user",
    creationSource: "web",
  }],
  nodes: [
    {id: "source-root", threadId: sourceThreadId, runId: "source-run", parentNodeId: null, rootNodeId: "source-root", kind: "root_turn", status: "completed", providerThreadId: "source-provider"},
  ],
});

const emptySupervisorProjection = (threadId: string, selection: SupervisorModelSelection): Projection => ({
  thread: {
    id: threadId,
    title: "Project Supervisor",
    projectId,
    lineage: {parentThreadId: null, relationshipToParent: null},
    modelSelection: selection,
  },
  runs: [],
  messages: [],
  nodes: [],
});

export const addSupervisorRequest = (projection: Projection, payload: Record<string, unknown>): void => {
  const threadId = projection.thread.id;
  const ordinal = projection.runs.length + 1;
  const runId = `supervisor-run-${ordinal}`;
  const rootId = `supervisor-root-${ordinal}`;
  const messageId = String(payload.messageId);
  const now = new Date().toISOString();
  projection.runs.push({
    id: runId,
    threadId,
    ordinal,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    rootNodeId: rootId,
    userMessageId: messageId,
    providerThreadId: "supervisor-provider",
  });
  projection.messages.push({
    id: messageId,
    threadId,
    runId,
    nodeId: rootId,
    role: "user",
    text: String(payload.text),
    streaming: false,
    createdAt: now,
    updatedAt: now,
    creationSource: "server",
    createdBy: "system",
  });
  const nodes = projection.nodes as Array<Record<string, unknown>>;
  nodes.push(
    {id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "running", providerThreadId: "supervisor-provider"},
  );
};

export const completeSupervisorRequest = (projection: Projection, messageId: string, response: string): void => {
  const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
  assert.ok(run?.rootNodeId);
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  const nodes = projection.nodes as Array<Record<string, unknown>>;
  const root = nodes.find((node) => node.id === run.rootNodeId);
  assert.ok(root);
  root.status = "completed";
  const nodeId = `supervisor-assistant-node-${run.id}`;
  nodes.push({
    id: nodeId,
    threadId: projection.thread.id,
    runId: run.id,
    parentNodeId: run.rootNodeId,
    rootNodeId: run.rootNodeId,
    kind: "assistant_message",
    status: "completed",
    providerThreadId: "supervisor-provider",
  });
  const now = new Date().toISOString();
  projection.messages.push({
    id: `assistant-${run.id}`,
    threadId: projection.thread.id,
    runId: run.id,
    nodeId,
    role: "assistant",
    text: response,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  });
};

export const appendSourceMessage = (projection: Projection, id: string, ordinal: number, text: string): void => {
  const runId = `${id}-run`;
  const rootId = `${id}-root`;
  projection.runs.push({id: runId, threadId: sourceThreadId, ordinal, status: "completed", requestedAt: baseTime, startedAt: baseTime, completedAt: baseTime,
    rootNodeId: rootId, userMessageId: id, providerThreadId: `${id}-provider`});
  projection.messages.push({id, threadId: sourceThreadId, runId, nodeId: rootId, role: "user", text, streaming: false, createdAt: baseTime, updatedAt: baseTime,
    createdBy: "user", creationSource: "web"});
  (projection.nodes as Array<Record<string, unknown>>).push({id: rootId, threadId: sourceThreadId, runId, parentNodeId: null, rootNodeId: rootId,
    kind: "root_turn", status: "completed", providerThreadId: `${id}-provider`});
};

const activation = asRpcBaseline(() => Effect.succeed({version: 2 as const, snapshotSequence: 10, threads: []}));

/** One enabled project, its source projection and a production supervisor over the run's guidance file. */
export const makeWorkflowFixture = (initialDefinitions: ProjectDefinitionSnapshot = definitionSnapshot()) => Effect.gen(function* () {
  yield* realTime;
  const directory = yield* dataDirectory("project-supervisor-workflow-test-");
  const stores = yield* openStores(directory, directory);
  const source = sourceProjection();
  const projections = new Map<string, Projection>([[sourceThreadId, source]]);
  const operations: Array<{tag: string; payload: Record<string, unknown>}> = [];
  const definitionReads: Array<{projectId: string; threadId: string | null}> = [];
  let definitionReadOutcomes: Array<ProjectDefinitionSnapshot | Error> = [];
  let currentDefinitions = initialDefinitions;
  let dispatchFailure: "unknown" | "rejected" | null = null;
  // runs when the models read has its answer, before the caller receives it
  let modelsRead: (() => Effect.Effect<void, unknown>) | null = null;
  yield* execute(stores.sql, "INSERT INTO meta VALUES(?,?)", `supervisor_control:${JSON.stringify(source.thread.projectId)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const catalog = () => Effect.succeed({
    projects: [{project, available: true}],
    threads: [...projections.values()].map((projection) => projection.thread),
  });
  const projection = (threadId: string) => {
    const found = projections.get(threadId);
    return found ? Effect.succeed(found) : Effect.fail(new T3TransportError("missing projection", 404));
  };
  const readCall = (tag: string, payload: Readonly<Record<string, unknown>>) => Effect.gen(function* () {
    if (tag === "server.getConfig") {
      if (modelsRead) yield* Effect.orDie(modelsRead());
      return modelConfig;
    }
    const item = turnItemAnswer(projections, tag, {...payload});
    if (item) return item;
    return yield* Effect.fail(new SupervisorRpcError("uncertain"));
  });
  const read: NativeRpcShape = {
    call: (tag, payload) => readCall(tag, payload),
    initiate: (tag, payload) => Effect.map(Effect.exit(readCall(tag, payload)), (exit) => ({sent: Effect.succeed(true), result: exit, release: Effect.void})),
  };
  const operate = nativeClient((tag, payload) => {
    operations.push({tag, payload});
    if (tag === "orchestration.launchThread") {
      const threadId = String(payload.threadId);
      projections.set(threadId, emptySupervisorProjection(threadId, payload.modelSelection as SupervisorModelSelection));
      return {accepted: true};
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "message.dispatch") {
      if (dispatchFailure === "unknown") {
        dispatchFailure = null;
        throw new Error("simulated lost dispatch response");
      }
      if (dispatchFailure === "rejected") {
        dispatchFailure = null;
        throw new SupervisorRpcError("rejected", true);
      }
      const launched = projections.get(String(payload.threadId));
      assert.ok(launched);
      addSupervisorRequest(launched, payload);
      delete launched.thread.settledAt;
      return {accepted: true};
    }
    throw new Error(`unexpected fake operation: ${tag}`);
  });
  const definitions: CtlDefinitionOps = {
    load: (loadedProjectId, threadId) => Effect.gen(function* () {
      definitionReads.push({projectId: loadedProjectId, threadId: threadId ?? null});
      const outcome = definitionReadOutcomes.shift();
      if (outcome instanceof Error) return yield* Effect.fail(outcome);
      return outcome ?? currentDefinitions;
    }),
  };
  const makeSupervisor = (withDefinitions = true) => ctlSupervisor({
    stores, catalog, projection, read, operate, baseline: activation, ...(withDefinitions ? {definitions} : {}),
  });
  return {
    binding: () => stores.supervisors.binding(projectId, sourceThreadId),
    definitionReads,
    definitions,
    dispatches: () => operations.filter((call) => call.tag === "orchestration.dispatchCommand" && call.payload.type === "message.dispatch"),
    makeSupervisor,
    projections,
    setDefinitions: (next: ProjectDefinitionSnapshot) => {currentDefinitions = next;},
    setDefinitionReadOutcomes: (outcomes: Array<ProjectDefinitionSnapshot | Error>) => {definitionReadOutcomes = [...outcomes];},
    setDispatchFailure: (failure: "unknown" | "rejected") => {dispatchFailure = failure;},
    onModelsRead: (hook: (() => Effect.Effect<void, unknown>) | null) => {modelsRead = hook;},
    task: () => stores.supervisors.task(sourceThreadId),
    store: stores.supervisors,
    stores,
  };
});

export type WorkflowFixture = Effect.Success<ReturnType<typeof makeWorkflowFixture>>;

// the root's typed submission through the production write controller, then the run's prose completion
export const submitAndComplete = (fixture: WorkflowFixture, supervisor: CtlSupervisor | null, task: TaskRecord, fields: Record<string, unknown>) => Effect.gen(function* () {
  const unit = supervisor ?? (yield* fixture.makeSupervisor());
  const submitter = yield* interpretationSubmitter({stores: fixture.stores, workflows: unit.workflows, projections: fixture.projections});
  const submitted = yield* submitter.submit(task, submissionArguments(task, fields));
  assert.equal(submitted.status, "submitted", JSON.stringify(submitted));
  completeSupervisorRequest(fixture.projections.get(task.supervisorThreadId)!, task.messageId, "I submitted the interpretation through the tool.");
});
