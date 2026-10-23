import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { projectSupervisorUnit, type ProjectSupervisorUnitDefinitions } from "./team-units.js";
import { defaultSupervisorModel, type SupervisorBaseline } from "../../src/project-supervisor-store.js";
import type { SupervisorModelSelection } from "../../src/project-supervisor-contract.js";
import { ThreadPolicyStore, ThreadPolicyStoreError } from "../../src/thread-policy.js";
import type { ThreadPolicySettings } from "../../src/thread-policy-contract.js";
import { T3TransportError } from "../../src/t3.js";
import type { MessageInfo, ProjectInfo, Projection, RunInfo, SupervisorConfig, ThreadInfo } from "../../src/types.js";
import { openGuidance, openPolicy, openSupervisors, policyService, type DbFacade, type PolicyHandle, type StorePromise } from "./store-units.js";

// helpers copied from test/project-supervisor.test.ts (baseline suites stay frozen and are not imported)
export const activationSequence = 10;
const baseTime = "2026-10-13T10:00:00.000Z";

export const projects: ProjectInfo[] = [
  {id: "project-a", title: "Project A", workspaceRoot: "/work/a"},
  {id: "project-b", title: "Project B", workspaceRoot: "/work/b"},
];

const modelConfig = {
  providers: [{
    enabled: true, instanceId: "codex", displayName: "Codex", installed: true, status: "ready",
    models: ["gpt-6-luna", "gpt-6-astra"].map(slug => ({
      slug, name: slug,
      capabilities: {optionDescriptors: [{id: "reasoningEffort", label: "Reasoning effort", type: "select", currentValue: "high",
        options: [{id: "low", label: "Low"}, {id: "high", label: "High"}, {id: "max", label: "Max"}]}]},
    })),
  }],
};

export type Turn = {id: string; sequence: number; text: string};

export const makeSourceProjection = (threadId: string, projectId: string, turns: Turn[]): Projection => {
  const thread: ThreadInfo = {id: threadId, title: "Task conversation", projectId, lineage: {parentThreadId: null, relationshipToParent: null}};
  const runs: RunInfo[] = [];
  const messages: MessageInfo[] = [];
  const nodes: Array<Record<string, unknown>> = [];
  for (const [index, turn] of turns.entries()) {
    const runId = "run-" + turn.id;
    const rootId = "root-" + turn.id;
    runs.push({id: runId, threadId, ordinal: index + 1, status: "completed", requestedAt: baseTime, startedAt: baseTime, completedAt: baseTime,
      rootNodeId: rootId, userMessageId: turn.id, providerThreadId: "provider-" + threadId});
    messages.push({id: turn.id, threadId, runId, nodeId: rootId, role: "user", text: turn.text, streaming: false, createdAt: baseTime,
      updatedAt: baseTime, createdBy: "user", creationSource: "web"});
    nodes.push({id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "completed", providerThreadId: "provider-" + threadId});
  }
  return {thread, runs, messages, nodes};
};

const emptySupervisorProjection = (threadId: string, projectId: string, model: SupervisorModelSelection): Projection => ({
  thread: {id: threadId, title: "Project Supervisor", projectId, lineage: {parentThreadId: null, relationshipToParent: null}, modelSelection: model},
  runs: [], messages: [], nodes: [],
});

const addSupervisorRequest = (projection: Projection, payload: Record<string, unknown>): void => {
  const threadId = projection.thread.id;
  const ordinal = projection.runs.length + 1;
  const runId = "supervisor-run-" + ordinal;
  const rootId = "supervisor-root-" + ordinal;
  const now = new Date().toISOString();
  projection.runs.push({id: runId, threadId, ordinal, status: "running", requestedAt: now, startedAt: now, completedAt: null, rootNodeId: rootId,
    userMessageId: String(payload.messageId), providerThreadId: "supervisor-provider"});
  projection.messages.push({id: String(payload.messageId), threadId, runId, nodeId: rootId, role: "user", text: String(payload.text), streaming: false,
    createdAt: now, updatedAt: now, creationSource: "server"});
  const nodes = Array.isArray(projection.nodes) ? projection.nodes as Array<Record<string, unknown>> : [];
  projection.nodes = nodes;
  nodes.push({id: rootId, threadId, runId, parentNodeId: null, rootNodeId: rootId, kind: "root_turn", status: "running", providerThreadId: "supervisor-provider"});
};

export type Definitions = ProjectSupervisorUnitDefinitions;

// a real temp-file guidance database with counting native fakes; `now` is the constructor clock seam
export const makeFixture = async (initial: Array<{threadId: string; projectId: string; turns: Turn[]}>) => {
  const directory = await mkdtemp(join(tmpdir(), "c2-ps-b-"));
  const projections = new Map<string, Projection>();
  const turnsByThread = new Map<string, Turn[]>();
  let registeredProjects = [...projects];
  const operations: Array<{tag: string; payload: Record<string, unknown>}> = [];
  const reads: string[] = [];
  let unknownDispatches = 0;
  let baselineReads = 0;
  for (const source of initial) {
    projections.set(source.threadId, makeSourceProjection(source.threadId, source.projectId, source.turns));
    turnsByThread.set(source.threadId, [...source.turns]);
  }
  const guidance = await openGuidance(directory);
  const ownedIds = new Set<string>();
  const supervisorStore = await openSupervisors(guidance, ownedIds);
  for (const project of projects) await guidance.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`supervisor_control:${JSON.stringify(project.id)}`, JSON.stringify({generation: 1, enabled: true, manual: true}));
  const config: SupervisorConfig = {dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0};
  const source = {catalog: () => Effect.succeed({
    projects: registeredProjects.map(project => ({project, available: true})),
    threads: [...projections.values()].map(projection => projection.thread),
  })};
  const t3 = {projection: (threadId: string) => {
    const projection = projections.get(threadId);
    return projection ? Effect.succeed({projection, snapshotSequence: 20}) : Effect.fail(new T3TransportError("missing projection", 404));
  }};
  const readRpc = async (tag: string): Promise<unknown> => {
    reads.push(tag);
    if (tag === "server.getConfig") return modelConfig;
    throw new Error("unexpected fake read RPC");
  };
  const operateRpc = async (tag: string, payload: Record<string, unknown>): Promise<unknown> => {
    operations.push({tag, payload});
    if (tag === "orchestration.launchThread") {
      const threadId = String(payload.threadId);
      if (!projections.has(threadId)) projections.set(threadId, emptySupervisorProjection(threadId, String(payload.projectId), payload.modelSelection as SupervisorModelSelection));
      return {accepted: true};
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "message.dispatch") {
      if (unknownDispatches > 0) {unknownDispatches -= 1;throw new Error("simulated lost response");}
      const projection = projections.get(String(payload.threadId));
      assert.ok(projection);
      addSupervisorRequest(projection, payload);
      return {accepted: true};
    }
    if (tag === "orchestration.dispatchCommand" && payload.type === "thread.settle") return {sequence: 20};
    throw new Error("unexpected fake operate RPC");
  };
  const activationSnapshot = async (_signal: AbortSignal): Promise<SupervisorBaseline> => {
    baselineReads += 1;
    return {snapshotSequence: activationSequence, threads: [...projections.values()].map(projection => {
      const latest = (turnsByThread.get(projection.thread.id) ?? []).filter(turn => turn.sequence <= activationSequence).at(-1);
      return {id: projection.thread.id, latestRunId: latest ? "run-" + latest.id : null};
    })};
  };
  const missingDefinitions = {load: async (projectId: string, threadId: string | null) => ({projectId, threadId,
    workspaceRoot: registeredProjects.find(project => project.id === projectId)?.workspaceRoot ?? "", globalOnly: false, globalRevision: null, revision: null,
    editingAvailable: false, status: "missing" as const, steps: [], workflows: [], config: {steps: [], workflows: []}, projectConfig: null,
    definitionFiles: [], complete: false, sources: [], issues: []})};
  // `policy`, when given, is the run's policy store in place of the data directory's own, as the baseline config.threadPolicy
  const makeSupervisor = (options: {definitions?: Definitions; now?: () => number; policy?: ThreadPolicyStore["Service"]} = {}) =>
    projectSupervisorUnit(config, supervisorStore, source, t3, readRpc, operateRpc, activationSnapshot, options.definitions ?? missingDefinitions, options.now,
      options.policy ? {policy: options.policy} : {});
  const addTurn = (threadId: string, projectId: string, turn: Turn): void => {
    const turns = [...(turnsByThread.get(threadId) ?? []), turn];
    turnsByThread.set(threadId, turns);
    projections.set(threadId, makeSourceProjection(threadId, projectId, turns));
  };
  return {
    directory, config, guidance, supervisorStore, operations, reads, projections, makeSupervisor, addTurn, missingDefinitions,
    get baselineReads() {return baselineReads;},
    addProject: (project: ProjectInfo) => {registeredProjects = [...registeredProjects, project];},
    setUnknownDispatches: (count: number) => {unknownDispatches = count;},
    reserveReadyBinding: async (mainThreadId: string, projectId = "project-a") => {
      const main = projections.get(mainThreadId);
      assert.ok(main);
      const binding = await supervisorStore.reserve(projectId, mainThreadId, main.thread.title, defaultSupervisorModel, activationSequence, Date.now());
      const ready = {...binding, state: "ready" as const};
      await supervisorStore.setBinding(ready);
      projections.set(ready.threadId, emptySupervisorProjection(ready.threadId, ready.projectId, defaultSupervisorModel));
      return ready;
    },
    cleanup: async () => {await guidance.close();await rm(directory, {recursive: true, force: true});},
  };
};

// the real thread-settings store whose save can be made to fail, as an unwritable or locked settings file would: the failed save
// is the store's typed sql failure
export class FailingThreadPolicyStore {
  failSaves = false;
  failedSaves = 0;
  readonly service: ThreadPolicyStore["Service"];
  constructor(private readonly policy: PolicyHandle) {
    const real = policyService(policy);
    this.service = {get: real.get, save: (input: ThreadPolicySettings) => Effect.suspend(() => {
      if (!this.failSaves) return real.save(input);
      this.failedSaves += 1;
      return Effect.fail(new ThreadPolicyStoreError({reason: "sql_failed", sqlReason: "simulated thread-policy save failure"}));
    })};
  }
  get(): StorePromise<ThreadPolicySettings> {return Effect.runPromise(this.service.get());}
  save(input: ThreadPolicySettings): StorePromise<ThreadPolicySettings> {return Effect.runPromise(this.service.save(input));}
  async close(): Promise<StorePromise<void>> {return await this.policy.close();}
}

// a No Project chat with a human request, as in the baseline No Project fixture, with a failing-capable policy store
export const makeNoProjectFixture = async (now?: () => number) => {
  const fixture = await makeFixture([{threadId: "manual", projectId: "project-a", turns: []}, {threadId: "other", projectId: "project-a", turns: []}]);
  await fixture.guidance.db.prepare("INSERT INTO classifications VALUES(?,?)").run("project-a", "scratch");
  const policy = new FailingThreadPolicyStore(await openPolicy(fixture.directory, {excludedThreadIds: []}));
  const supervisor = fixture.makeSupervisor({...(now ? {now} : {}), policy: policy.service});
  await supervisor.runOnce();
  fixture.addTurn("manual", "project-a", {id: "request-start", sequence: 20, text: "Have Supervisor follow this task: add a CSV export."});
  fixture.projections.get("manual")!.messages[0]!.createdAt = new Date(Date.now() - 1000).toISOString();
  return {fixture, supervisor, policy, cleanup: async () => {await policy.close();await fixture.cleanup();}};
};

// digest of every supervisor_* table and every meta row, independent of physical row order
export const supervisionStateDigest = async (db: DbFacade): Promise<{tables: string[]; digest: string}> => {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'supervisor\\_%' ESCAPE '\\' ORDER BY name").all()).map(row => String(row.name));
  const hash = createHash("sha256");
  for (const table of [...tables, "meta"]) {
    const rows = (await db.prepare(`SELECT * FROM "${table}"`).all()).map(row => JSON.stringify(Object.entries(row))).sort();
    hash.update(JSON.stringify([table, rows]));
  }
  return {tables, digest: hash.digest("hex")};
};
