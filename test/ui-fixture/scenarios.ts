import {definitionGuidanceFields, type DefinitionGuidance} from "../../src/definition-references.js";
import {fixtureJourney, journeyTitle, type JourneyCase} from "./journey.js";
import {assessmentForTask} from "../../src/workflow-assessment.js";
import {workAttention} from "../../src/dashboard-overview.js";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import type { GuidanceActivity, GuidanceSnapshot } from "../../src/guidance-contract.js";
import { overviewPage, overviewWorkPage, type DashboardOverviewInfo, type DashboardWorkInfo } from "../../src/dashboard-overview.js";
import type {
  GlobalDefinitionsControl, GlobalDefinitionsControlInput, GlobalDefinitionsControlResult, NoProjectControl, NoProjectControlInput, NoProjectControlResult,
  NoProjectModeValue, SupervisionCandidates, SupervisionControlInfo, SupervisionControlInput, SupervisionControlResult, SupervisionSetupInput,
  SupervisionSetupOptions, SupervisionSetupResult, SupervisionStartStatus,
} from "../../src/supervisor-control-contract.js";
import type { ThreadPolicySettings } from "../../src/thread-policy-contract.js";
import type {
  ProjectSupervisorChatSupervisionInput, ProjectSupervisorInfo, ProjectSupervisorRetryInput, ProjectSupervisorSaveInput, ProjectSupervisorSaveOutcome,
  SupervisorBinding, SupervisorModelInfo, SupervisorModelSelection, TaskInterpretationInfo,
} from "../../src/project-supervisor-contract.js";
import {
  catalogEntryId, normalizeProjectConfiguration, projectConfigurationError, type DefinitionNode, type ProjectConfigSave, type ProjectConfigSaveOutcome,
  type ProjectConfigurationInfo, type ProjectDefinitionSnapshot,
} from "../../src/project-definitions-contract.js";
import { parseWorkflowProgressPageQuery, type WorkflowProgressPagingQuery, type WorkflowProgressSnapshot } from "../../src/workflow-progress.js";

// every value below is synthetic and visibly labelled; nothing is read from or written to a real supervisor, t3 or filesystem
export const fixtureToken = "fixture-token";
export const fixtureEpoch = Date.UTC(2026, 0, 15, 9, 0, 0);
const minute = 60_000;

export const fixtureIds = {
  projectA: "fixture-project-a",
  projectB: "fixture-project-b",
  noProject: "fixture-no-project",
  threadA1: "fixture-thread-a1",
  threadA2: "fixture-thread-a2",
  threadA3: "fixture-thread-a3",
  threadB1: "fixture-thread-b1",
  threadN1: "fixture-thread-n1",
  threadN2: "fixture-thread-n2",
  // the No Project chats of environment b
  threadBN1: "fixture-thread-bn1",
  threadBN2: "fixture-thread-bn2",
} as const;

// two synthetic T3 environments with their own No Project chats, chat exclusions and project definitions; the fixture-only
// control POST /__fixture/environment/<name> switches the one the fixture answers for, as if Supervisor now served another
// T3 server. each environment keeps its own in-memory state; the project ids are the same in both
export const fixtureEnvironmentNames = ["a", "b"] as const;
export type FixtureEnvironmentName = typeof fixtureEnvironmentNames[number];
export const fixtureEnvironments: Record<FixtureEnvironmentName, string> = {a: "fixture-environment", b: "fixture-environment-b"};
export const isFixtureEnvironmentName = (value: string): value is FixtureEnvironmentName => (fixtureEnvironmentNames as readonly string[]).includes(value);

export class FixtureFailure extends Error {}

type StartStatus = typeof SupervisionStartStatus.Type;
type Checkout = typeof SupervisionSetupOptions.Type["checkouts"][number];
type Stop = {stoppedBy: "direct" | "relay" | "chat" | "ui"; stoppedAt: number};
type Switch = {generation: number; enabled: boolean; manual: boolean};
type FixtureThread = {
  id: string;
  title: string;
  projectId: string;
  binding: SupervisorBinding | null;
  selectedModel: SupervisorModelSelection | null;
  task: TaskInterpretationInfo | null;
};
type FixtureProject = {
  id: string;
  title: string;
  classification: "project" | "scratch";
  workspaceRoot: string;
  control: Switch;
  checkouts: Checkout[];
  settings: ProjectSupervisorInfo["settings"];
  projectConfig: ProjectConfigurationInfo | null;
};
type FixtureData = {
  global: Switch;
  globalDefinitions: Switch;
  noProject: {generation: number; mode: NoProjectModeValue};
  threadPolicy: {generation: number; excludedThreadIds: string[]};
  stops: Record<string, Stop>;
  starts: StartStatus[];
  projects: FixtureProject[];
  threads: FixtureThread[];
};
export type ForcedOutcome = {outcome: "conflict" | "uncertain"; apply: boolean};

const models: SupervisorModelInfo[] = [
  {instanceId: "fixture-provider", model: "fixture-model-steady", name: "Fixture steady model", providerName: "Fixture provider", available: true, options: [
    {id: "reasoningEffort", label: "Reasoning", choices: [{value: "low", label: "Low"}, {value: "high", label: "High"}], defaultValue: "low"},
  ]},
  {instanceId: "fixture-provider", model: "fixture-model-quick", name: "Fixture quick model", providerName: "Fixture provider", available: true, options: [
    {id: "reasoningEffort", label: "Reasoning", choices: [{value: "low", label: "Low"}, {value: "high", label: "High"}], defaultValue: "high"},
  ]},
  {instanceId: "fixture-provider-offline", model: "fixture-model-offline", name: "Fixture offline model", providerName: "Fixture offline provider", available: false, options: []},
];
const steadyModel: SupervisorModelSelection = {instanceId: "fixture-provider", model: "fixture-model-steady", options: [{id: "reasoningEffort", value: "low"}]};

const stepFiles: Record<string, {name: string; description: string} & DefinitionGuidance> = {
  "fixture-tests": {name: "Fixture tests", description: "Fixture step: run the synthetic test suite. Synthetic definition for UI recordings.", references: ["docs/payments/webhook-retries.md"], skills: [".claude/skills/payments/webhook-retry-idempotency-validation/SKILL.md", "plugin:review"]},
  "fixture-review": {name: "Fixture review", description: "Fixture step: review the synthetic change. Synthetic definition for UI recordings."},
  "fixture-unindexed": {name: "Fixture unindexed step", description: "Fixture step present on disk but not indexed in project.yaml."},
};
const workflowFiles: Record<string, {name: string; description: string; sequence: DefinitionNode[]}> = {
  "fixture-delivery": {name: "Fixture delivery", description: "Fixture workflow: synthetic tests, then synthetic review.", sequence: [{step: "fixture-tests"}, {step: "fixture-review"}]},
};

const activity: GuidanceActivity[] = [
  {id: "fixture-activity-1", kind: "guidance", threadId: fixtureIds.threadA1, ruleId: null, runId: "fixture-run-a1", state: "observe_only", reason: "no_match",
    detail: "Fixture: synthetic activity entry.", createdAt: fixtureEpoch + minute},
  {id: "fixture-activity-2", kind: "delivery", threadId: fixtureIds.threadA2, ruleId: null, runId: "fixture-run-a2", state: "rejected", reason: "not_deliverable",
    detail: "Fixture: synthetic rejected delivery.", createdAt: fixtureEpoch + 2 * minute},
];

const binding = (projectId: string, mainThreadId: string, state: SupervisorBinding["state"]): SupervisorBinding =>
  ({projectId, mainThreadId, threadId: `fixture-supervisor-${mainThreadId.slice("fixture-thread-".length)}`, generation: 1, enabledAt: fixtureEpoch, state});
const task = (projectId: string, threadId: string, objective: string): TaskInterpretationInfo => ({
  threadId, projectId, sourceRunId: `fixture-run-${threadId}`, sourceMessageId: `fixture-message-${threadId}`, status: "inferred",
  objective, reason: "Fixture: synthetic interpretation for UI recordings.", updatedAt: fixtureEpoch + 3 * minute,
});
const projectSettings = (): ProjectSupervisorInfo["settings"] =>
  ({generation: 1, modelSelection: steadyModel, pending: false, monitoring: {intervalMinutes: 2, activityThreshold: 10}, teamSettings: {maxHelpersPerRoot: 5}});

const environmentA = (): FixtureData => ({
  global: {generation: 1, enabled: true, manual: false},
  globalDefinitions: {generation: 1, enabled: false, manual: false},
  noProject: {generation: 1, mode: "on_request"},
  threadPolicy: {generation: 1, excludedThreadIds: [fixtureIds.threadA3]},
  stops: {[fixtureIds.threadA3]: {stoppedBy: "ui", stoppedAt: fixtureEpoch + 4 * minute}},
  starts: [],
  projects: [
    {id: fixtureIds.projectA, title: "Fixture project A", classification: "project", workspaceRoot: "/fixture/project-a",
      control: {generation: 1, enabled: true, manual: false},
      checkouts: [{origin: "project", threadId: null, workspaceRoot: "/fixture/project-a", branch: "main", isGitRepository: true, folderStatus: "present"}],
      settings: projectSettings(),
      projectConfig: {
        workflows: [{path: "workflows/fixture-delivery.yaml", summary: "Fixture workflow: synthetic delivery sequence.", required: false}],
        steps: [
          {path: "steps/fixture-tests.md", summary: "Fixture step: run the synthetic tests.", required: true},
          {path: "steps/fixture-review.md", summary: "Fixture step: synthetic review.", required: false},
        ],
        default_workflow: "fixture-delivery",
      }},
    {id: fixtureIds.projectB, title: "Fixture project B (setup)", classification: "project", workspaceRoot: "/fixture/project-b",
      control: {generation: 1, enabled: false, manual: false},
      checkouts: [
        {origin: "project", threadId: null, workspaceRoot: "/fixture/project-b", branch: "main", isGitRepository: true, folderStatus: "missing"},
        {origin: "project", threadId: fixtureIds.threadB1, workspaceRoot: "/fixture/project-b-worktree", branch: "fixture-branch", isGitRepository: false, folderStatus: "missing"},
      ],
      settings: projectSettings(),
      projectConfig: null},
    {id: fixtureIds.noProject, title: "Fixture No Project", classification: "scratch", workspaceRoot: "",
      control: {generation: 1, enabled: false, manual: false}, checkouts: [], settings: projectSettings(), projectConfig: null},
  ],
  threads: [
    {id: fixtureIds.threadA1, title: "Fixture chat A1 (supervised)", projectId: fixtureIds.projectA, binding: binding(fixtureIds.projectA, fixtureIds.threadA1, "ready"),
      selectedModel: steadyModel, task: task(fixtureIds.projectA, fixtureIds.threadA1, "Fixture objective: synthetic task A1 for UI recordings.")},
    {id: fixtureIds.threadA2, title: "Fixture chat A2 (access rejected)", projectId: fixtureIds.projectA, binding: binding(fixtureIds.projectA, fixtureIds.threadA2, "rejected"),
      selectedModel: steadyModel, task: task(fixtureIds.projectA, fixtureIds.threadA2, "Fixture objective: synthetic task A2 with a rejected Supervisor.")},
    {id: fixtureIds.threadA3, title: "Fixture chat A3 (stopped)", projectId: fixtureIds.projectA, binding: binding(fixtureIds.projectA, fixtureIds.threadA3, "ready"),
      selectedModel: steadyModel, task: task(fixtureIds.projectA, fixtureIds.threadA3, "Fixture objective: synthetic task A3, supervision stopped.")},
    {id: fixtureIds.threadB1, title: "Fixture chat B1", projectId: fixtureIds.projectB, binding: null, selectedModel: null, task: null},
    {id: fixtureIds.threadN1, title: "Fixture No Project chat 1", projectId: fixtureIds.noProject, binding: null, selectedModel: null, task: null},
    {id: fixtureIds.threadN2, title: "Fixture No Project chat 2", projectId: fixtureIds.noProject, binding: null, selectedModel: null, task: null},
  ],
});

// environment b: other No Project chats, another explicit exclusion and another project.yaml for the same project ids
const environmentB = (): FixtureData => {
  const data = environmentA();
  const projectA = data.projects.find(project => project.id === fixtureIds.projectA)!;
  return {
    ...data,
    threadPolicy: {generation: 1, excludedThreadIds: [fixtureIds.threadA1]},
    stops: {[fixtureIds.threadA1]: {stoppedBy: "ui", stoppedAt: fixtureEpoch + 5 * minute}},
    projects: data.projects.map(project => project !== projectA ? project : {...project, workspaceRoot: "/fixture-b/project-a",
      checkouts: [{origin: "project", threadId: null, workspaceRoot: "/fixture-b/project-a", branch: "main", isGitRepository: true, folderStatus: "present"}],
      projectConfig: {workflows: [], steps: [{path: "steps/fixture-tests.md", summary: "Fixture B step: run the environment b tests.", required: false}]}}),
    threads: data.threads.filter(thread => thread.id !== fixtureIds.threadN1 && thread.id !== fixtureIds.threadN2).concat([
      {id: fixtureIds.threadBN1, title: "Fixture B No Project chat 1", projectId: fixtureIds.noProject, binding: null, selectedModel: null, task: null},
      {id: fixtureIds.threadBN2, title: "Fixture B No Project chat 2", projectId: fixtureIds.noProject, binding: null, selectedModel: null, task: null},
    ]),
  };
};

export const initialFixtureData = (environment: FixtureEnvironmentName = "a"): FixtureData => environment === "a" ? environmentA() : environmentB();

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const withForced = <R>(forced: ForcedOutcome | null, run: () => R, conflict: () => R, uncertain: () => R): R => {
  if (forced?.outcome === "conflict") return conflict();
  if (forced?.outcome === "uncertain") {
    if (forced.apply) run();
    return uncertain();
  }
  return run();
};

export class FixtureModel {
  private datasets = {a: initialFixtureData("a"), b: initialFixtureData("b")};
  private current: FixtureEnvironmentName = "a";
  private journey: JourneyCase | null = null;
  private largeInterface = false;
  private partialInventory = false;
  setPartialInventory() {this.partialInventory = true;}
  setLargeInterface() {
    if (this.largeInterface) return;
    this.largeInterface = true;
    const project = this.project(fixtureIds.projectA);
    for (let i = 1; i <= 146; i++) {
      const id = `fixture-long-${String(i).padStart(3, "0")}`;
      this.data.threads.push({id, title: `Fixture ${String(i).padStart(3, "0")}: Scanner-like repository analysis and delivery conversation`, projectId: project.id, binding: binding(project.id, id, "ready"), selectedModel: null, task: task(project.id, id, "Synthetic long-list task; no native work or settings are changed.")});
    }
    project.checkouts.push({origin: "project", threadId: fixtureIds.threadA2, workspaceRoot: "/fixture/worktrees/export-reliability", branch: "fix/export-reliability", isGitRepository: true, folderStatus: "present"});
    project.checkouts.push({origin: "project", threadId: fixtureIds.threadA3, workspaceRoot: "/fixture/worktrees/review-without-branch-name", branch: null, isGitRepository: true, folderStatus: "present"});
    project.projectConfig = {...project.projectConfig!, steps: [...project.projectConfig!.steps, ...Array.from({length: 45}, (_, i) => ({path: `steps/fixture-duty-${i + 1}.md`, summary: `Synthetic duty ${i + 1}: preserve scoped verification, evidence and documented remaining obligations.`, required: i % 7 === 0}))]};
  }
  setJourney(phase: JourneyCase | null) {this.journey = phase;}
  // the reconstructed packing journey replaces chat A1 everywhere it appears, so Home, Conversations and the task agree
  private journeyFor(threadId: string) {
    if (this.current !== "a" || !this.journey || threadId !== fixtureIds.threadA1) return null;
    const thread = this.data.threads.find(item => item.id === threadId)!;
    return fixtureJourney(this.journey, thread.projectId, thread.id, thread.binding!.threadId, this.now());
  }
  private titleOf(thread: {id: string; title: string}) {return this.journeyFor(thread.id) ? journeyTitle : thread.title;}
  constructor(private readonly now: () => number = Date.now) {}

  // the data of the environment the fixture answers for
  private get data(): FixtureData {return this.datasets[this.current];}
  get environment() {return {name: this.current, environmentId: fixtureEnvironments[this.current]};}
  switchEnvironment(name: FixtureEnvironmentName) {this.current = name;}
  // one synchronous model call against the given environment's data, whatever the fixture answers for meanwhile
  inEnvironment<A>(name: FixtureEnvironmentName, run: () => A): A {
    const shown = this.current;
    this.current = name;
    try {return run();} finally {this.current = shown;}
  }

  reset() {
    this.journey = null;
    this.largeInterface = false;
    this.partialInventory = false;
    this.datasets = {a: initialFixtureData("a"), b: initialFixtureData("b")};
    this.current = "a";
  }

  private project(projectId: string): FixtureProject {
    const project = this.data.projects.find(item => item.id === projectId);
    if (!project) throw new FixtureFailure("Fixture: unknown project.");
    return project;
  }
  private thread(projectId: string, threadId: string): FixtureThread {
    const thread = this.data.threads.find(item => item.id === threadId && item.projectId === projectId);
    if (!thread) throw new FixtureFailure("Fixture: unknown chat in this project.");
    return thread;
  }
  private effective(project: FixtureProject) {return project.classification === "project" && project.control.enabled && this.data.global.enabled;}
  private folderPresent(project: FixtureProject) {return project.checkouts.some(checkout => checkout.threadId === null && checkout.folderStatus === "present");}
  private started(threadId: string) {return this.data.starts.some(start => start.threadId === threadId && start.status === "active");}

  guidanceSnapshot(now: number): GuidanceSnapshot {
    return {
      environmentId: fixtureEnvironments[this.current], serverVersion: "fixture-baseline", connected: true, lastCycleAt: now,
      sendingReady: true, sendingReason: "Fixture: synthetic data; nothing is sent.",
      settings: {generation: 1, guidancePaused: false, monitoringPaused: false, allowFollowupRace: false, verifiedServerVersion: null,
        model: "fixture-model-steady", reasoning: "low", dailyTokenBudget: 0, evidenceHours: 24, maxAnchorAgeSeconds: 600},
      threadPolicy: this.threadPolicy(),
      threads: this.data.threads.map(thread => ({id: thread.id, title: this.titleOf(thread), projectId: thread.projectId, available: true})),
      projects: this.data.projects.map(project => ({id: project.id, title: project.title, available: true, classification: project.classification})),
      rules: [], mutes: [], activity: this.largeInterface ? [...activity, ...Array.from({length: 80}, (_, i) => ({...activity[0]!, id: `fixture-long-activity-${i}`, createdAt: fixtureEpoch + (i + 3) * minute}))] : activity, coverage: "Fixture coverage: synthetic API data for UI recordings.", tokensUsed: 0,
    };
  }

  threadPolicy(): ThreadPolicySettings {return {generation: this.data.threadPolicy.generation, excludedThreadIds: [...this.data.threadPolicy.excludedThreadIds]};}

  private work(): DashboardWorkInfo[] {
    return this.data.threads.flatMap(thread => {
      const project = this.project(thread.projectId);
      const scratch = project.classification === "scratch";
      if (!thread.binding && !(scratch && this.started(thread.id))) return [];
      const stop = this.data.stops[thread.id];
      const stopped = this.data.threadPolicy.excludedThreadIds.includes(thread.id);
      const enabled = scratch ? this.data.global.enabled && this.data.noProject.mode !== "off" : this.effective(project);
      const supervision = stopped ? "stopped" as const : enabled ? "enabled" as const : "disabled" as const;
      const journey = this.journeyFor(thread.id);
      const task = journey?.task ?? thread.task;
      const live = journey?.progress.workflows.find(workflow => workflow.threadId === thread.id);
      const assessment = journey ? assessmentForTask(live?.assessment, journey.task) : null;
      const attention = journey ? workAttention({enabled: supervision === "enabled", bindingState: thread.binding?.state ?? null, task: journey.task, assessment})
        : supervision === "enabled" && thread.binding?.state === "rejected" ? ["Supervisor access was rejected."] : [];
      return [{
        projectId: thread.projectId, mainThreadId: thread.id, title: this.titleOf(thread),
        supervisorThreadId: thread.binding?.threadId ?? `fixture-supervisor-${thread.id.slice("fixture-thread-".length)}`,
        stop: stopped && stop ? {route: stop.stoppedBy, callerThreadId: null, userMessageId: null, stoppedAt: stop.stoppedAt} : null,
        nativeState: journey && journey.task.status !== "waiting" && assessment?.status !== "completed" ? "active" as const : "quiet" as const, supervision, objective: task?.objective ?? null,
        ...(task?.engagement ? {engagement: task.engagement} : {}),
        reason: task?.reason ?? "Fixture: no task recorded.", taskStatus: task?.status ?? null, planStatus: task?.agreement?.status ?? task?.workflow?.status ?? null,
        assessment: assessment ? {status: assessment.status, summary: assessment.summary, updatedAt: assessment.updatedAt} : null,
        attention, updatedAt: assessment?.updatedAt ?? task?.updatedAt ?? null,
      }];
    });
  }

  dashboardOverview(query: Parameters<typeof overviewPage>[0], now: number): DashboardOverviewInfo {
    let page: ReturnType<typeof overviewPage>;
    try {page = overviewPage(query);} catch {throw new FixtureFailure("Fixture: invalid overview page.");}
    const work = this.work();
    return {
      observedAt: now, revision: sha256(JSON.stringify(work)), available: true, globallyEnabled: this.data.global.enabled,
      ...overviewWorkPage(work, page),
      projects: this.data.projects.filter(project => project.classification === "project").map(project => ({
        id: project.id, title: project.title, available: true, enabled: project.control.enabled, effectiveEnabled: this.effective(project),
        detectionStatus: this.folderPresent(project) ? "present" : "missing", attentionTotal: work.filter(item => item.projectId === project.id && item.attention.length > 0).length,
      })),
    };
  }

  noProjectControl(): typeof NoProjectControl.Type {
    return {generation: this.data.noProject.generation, mode: this.data.noProject.mode, globallyEnabled: this.data.global.enabled};
  }

  saveNoProjectControl(input: NoProjectControlInput, forced: ForcedOutcome | null): typeof NoProjectControlResult.Type {
    const conflict = () => ({status: "conflict" as const, message: "Fixture: No Project mode changed in another window. Reload before saving.", control: this.noProjectControl()});
    return withForced<typeof NoProjectControlResult.Type>(forced, () => {
      if (input.expectedGeneration !== this.data.noProject.generation) return conflict();
      this.data.noProject = {generation: this.data.noProject.generation + 1, mode: input.mode};
      return {status: "saved" as const, message: "Fixture: No Project mode saved in memory.", control: this.noProjectControl()};
    }, conflict, () => ({status: "unavailable" as const, message: "Fixture: the No Project mode outcome is unconfirmed.", control: this.noProjectControl()}));
  }

  candidates(query = "", purpose: "start" | "exclude" = "start"): typeof SupervisionCandidates.Type {
    const search = query.trim().replace(/^t3-thread:\/\/v1\//u, "").toLowerCase();
    const scratch = (thread: FixtureThread) => this.project(thread.projectId).classification === "scratch";
    const relevant = (thread: FixtureThread) => this.data.global.enabled && (scratch(thread)
      ? this.data.noProject.mode === "automatic" || this.data.noProject.mode === "on_request" && this.started(thread.id)
      : this.effective(this.project(thread.projectId)));
    const excluded = (thread: FixtureThread) => this.data.threadPolicy.excludedThreadIds.includes(thread.id);
    const rows = this.data.threads.filter(thread => (purpose === "start" ? scratch(thread) : relevant(thread)) &&
      (!search || thread.id.toLowerCase() === search || thread.title.toLowerCase().includes(search))).slice(0, 8);
    return {
      exceptions: this.data.threadPolicy.excludedThreadIds.filter(id => {const thread = this.data.threads.find(item => item.id === id);return Boolean(thread && relevant(thread));}),
      candidates: rows.map(thread => ({id: thread.id, projectId: thread.projectId, title: this.titleOf(thread), updatedAt: null,
        active: this.started(thread.id) && !excluded(thread), excluded: excluded(thread)})),
      message: rows.length ? "Choose a chat. At most eight matches are shown." : "No matching available chat. Paste its native T3 link or change the search.",
    };
  }

  startSupervision(input: {threadId: string; operationId: string}, forced: ForcedOutcome | null): StartStatus {
    const record = (status: StartStatus["status"], reason: string): StartStatus => {
      const start = {threadId: input.threadId, operationId: input.operationId, status, reason};
      this.data.starts.push(start);
      return start;
    };
    return withForced<StartStatus>(forced, () => {
      const thread = this.data.threads.find(item => item.id === input.threadId);
      if (!thread || this.project(thread.projectId).classification !== "scratch") return record("denied", "Fixture: only No Project chats can be started here.");
      if (!this.data.global.enabled || this.data.noProject.mode === "off") return record("denied", "Fixture: No Project mode or the master switch is off.");
      this.data.threadPolicy = {generation: this.data.threadPolicy.generation + 1, excludedThreadIds: this.data.threadPolicy.excludedThreadIds.filter(id => id !== input.threadId)};
      delete this.data.stops[input.threadId];
      return record("active", "Fixture: supervision is enabled until explicit Stop. Settlement only parks the Supervisor.");
    }, () => ({...input, status: "rejected" as const, reason: "Fixture: the Start was rejected as a conflict."}),
    () => ({...input, status: "unavailable" as const, reason: "Fixture: the Start outcome is unconfirmed."}));
  }

  startStatus(threadId: string, operationId: string): StartStatus {
    const start = this.data.starts.find(item => item.threadId === threadId && item.operationId === operationId);
    return start ? {...start} : {threadId, operationId, status: "denied", reason: "No matching Start operation is recorded. Nothing was replayed."};
  }

  supervisionControl(projectId: string | null): SupervisionControlInfo {
    const global = this.data.global;
    if (projectId === null) return {projectId: null, generation: global.generation, enabled: global.enabled, manual: global.manual,
      globallyEnabled: global.enabled, effectiveEnabled: global.enabled, detectionStatus: "not_checked", detectionError: null};
    const project = this.project(projectId);
    return {projectId, generation: project.control.generation, enabled: project.control.enabled, manual: project.control.manual,
      globallyEnabled: global.enabled, effectiveEnabled: this.effective(project), detectionStatus: this.folderPresent(project) ? "present" : "missing", detectionError: null};
  }

  saveSupervisionControl(input: SupervisionControlInput, forced: ForcedOutcome | null): typeof SupervisionControlResult.Type {
    const conflict = () => ({status: "conflict" as const, message: "Supervision changed in another window. Reload before saving.", control: this.supervisionControl(input.projectId)});
    return withForced<typeof SupervisionControlResult.Type>(forced, () => {
      const target = input.projectId === null ? this.data.global : this.project(input.projectId).control;
      if (target.generation !== input.expectedGeneration) return conflict();
      if (input.projectId !== null) {
        const project = this.project(input.projectId);
        if (project.classification === "scratch") return {status: "unavailable" as const, message: "Use the No Project mode in Instance settings. Shared definitions do not activate chats.", control: this.supervisionControl(input.projectId)};
        if (input.enabled && !(target.manual && target.enabled) && !this.folderPresent(project))
          return {status: "setup_required" as const, message: "Choose a registered checkout and create its .t3-supervisor folder before enabling project supervision.", control: this.supervisionControl(input.projectId)};
      }
      Object.assign(target, {generation: target.generation + 1, enabled: input.enabled, manual: true});
      return {status: "saved" as const, message: input.enabled ? "Fixture: enabled in memory." : "Fixture: disabled in memory. Chats and history are retained.", control: this.supervisionControl(input.projectId)};
    }, conflict, () => ({status: "unavailable" as const, message: "Fixture: the enable/disable outcome is unconfirmed.", control: this.supervisionControl(input.projectId)}));
  }

  setupOptions(projectId: string): typeof SupervisionSetupOptions.Type {
    const project = this.project(projectId);
    return {projectId, generation: project.control.generation, available: project.classification === "project",
      message: "Fixture: synthetic checkouts. Setup changes in-memory fixture state only; no files are written or committed.",
      checkouts: project.checkouts.map(checkout => ({...checkout}))};
  }

  setupSupervision(input: SupervisionSetupInput, forced: ForcedOutcome | null): typeof SupervisionSetupResult.Type {
    const project = this.project(input.projectId);
    const control = () => this.supervisionControl(input.projectId);
    const conflict = () => ({status: "conflict" as const, message: "Supervision changed in another window. Reload checkout options before setup.", control: control(), workspaceRoot: null, branch: null});
    return withForced<typeof SupervisionSetupResult.Type>(forced, () => {
      if (project.control.generation !== input.expectedGeneration) return conflict();
      const selected = project.checkouts.find(checkout => checkout.threadId === input.threadId && checkout.workspaceRoot === input.expectedWorkspaceRoot && checkout.branch === input.expectedBranch);
      if (project.classification !== "project" || !selected) return {...conflict(), message: "The selected checkout or branch changed. Reload the setup options before retrying."};
      const located = {workspaceRoot: selected.workspaceRoot, branch: selected.branch};
      if (input.action === "create_and_commit" && !selected.isGitRepository) return {status: "unavailable" as const, message: "This checkout is not a Git repository; choose Create without commit.", control: control(), ...located};
      if (input.action === "enable_existing" && selected.folderStatus !== "present") return {status: "conflict" as const, message: "The selected checkout no longer has .t3-supervisor. Reload checkout options before enabling.", control: control(), ...located};
      if (input.action !== "enable_existing" && selected.folderStatus === "present") return {status: "conflict" as const, message: "This checkout already has .t3-supervisor. Refresh its definitions before choosing another setup action.", control: control(), ...located};
      project.checkouts = project.checkouts.map(checkout => checkout === selected ? {...checkout, folderStatus: "present"} : checkout);
      if (selected.threadId === null && !project.projectConfig) project.projectConfig = {workflows: [], steps: []};
      project.control = {generation: project.control.generation + 1, enabled: true, manual: true};
      return {status: "saved" as const, message: "Fixture: setup recorded in memory; no files were written or committed.", control: control(), ...located};
    }, conflict, () => ({status: "uncertain" as const, message: "Fixture: the setup outcome is unconfirmed.", control: control(), workspaceRoot: input.expectedWorkspaceRoot, branch: input.expectedBranch}));
  }

  globalDefinitionsControl(): typeof GlobalDefinitionsControl.Type {
    const value = this.data.globalDefinitions;
    return {generation: value.generation, enabled: value.enabled, manual: value.manual, effectiveEnabled: value.enabled && this.data.global.enabled,
      homePath: "/fixture/home/.t3-supervisor", detectionStatus: value.enabled ? "present" : "missing", detectionError: null};
  }

  saveGlobalDefinitionsControl(input: GlobalDefinitionsControlInput, forced: ForcedOutcome | null): typeof GlobalDefinitionsControlResult.Type {
    const conflict = () => ({status: "conflict" as const, message: "Fixture: global rules changed in another window. Reload before saving.", control: this.globalDefinitionsControl()});
    return withForced<typeof GlobalDefinitionsControlResult.Type>(forced, () => {
      if (input.expectedGeneration !== this.data.globalDefinitions.generation) return conflict();
      this.data.globalDefinitions = {generation: this.data.globalDefinitions.generation + 1, enabled: input.enabled, manual: true};
      return {status: "saved" as const, message: "Fixture: global definitions switch saved in memory; no files were written.", control: this.globalDefinitionsControl()};
    }, conflict, () => ({status: "uncertain" as const, message: "Fixture: the global definitions outcome is unconfirmed.", control: this.globalDefinitionsControl()}));
  }

  projectSupervisor(projectId: string, mainThreadId: string | null): ProjectSupervisorInfo {
    const project = this.project(projectId);
    const thread = mainThreadId === null ? null : this.thread(projectId, mainThreadId);
    const scratch = project.classification === "scratch";
    const journeyTask = thread ? this.journeyFor(thread.id)?.task ?? null : null;
    const stop = thread ? this.data.stops[thread.id] : undefined;
    const stopped = thread ? this.data.threadPolicy.excludedThreadIds.includes(thread.id) : false;
    return {
      ...(scratch ? {noProjectMode: this.data.noProject.mode} : {}),
      projectId, mainThreadId, modelApplication: null, settings: project.settings,
      binding: thread?.binding ?? null, modelSelection: thread?.binding ? thread.selectedModel : null, models,
      monitoringStatus: {state: "idle", message: "Fixture: monitoring is idle; synthetic status.", pendingItems: 0, nextReviewAt: null, lastNoticeAt: null},
      available: true, message: "Fixture: synthetic Supervisor status; no T3 connection is used.",
      tasks: this.data.threads.flatMap(item => item.projectId === projectId && item.task ? [journeyTask && item.id === fixtureIds.threadA1 ? journeyTask : item.task] : []),
      ...(thread ? {chatSupervision: {
        stopped, policyGeneration: this.data.threadPolicy.generation, stoppedBy: stopped ? stop?.stoppedBy ?? null : null,
        stoppedCallerThreadId: null, stoppedUserMessageId: null, effectiveEnabled: scratch ? this.data.noProject.mode !== "off" && this.data.global.enabled : this.effective(project),
        activation: scratch && !this.started(thread.id) ? "not_started" : "active", stoppedAt: stopped ? stop?.stoppedAt ?? null : null,
      }} : {}),
    };
  }

  saveProjectSupervisor(input: ProjectSupervisorSaveInput, forced: ForcedOutcome | null): ProjectSupervisorSaveOutcome {
    const project = this.project(input.projectId);
    const snapshot = () => this.projectSupervisor(input.projectId, input.mainThreadId ?? null);
    const conflict = () => ({status: "conflict" as const, message: "Fixture: Supervisor settings changed in another window.", snapshot: snapshot()});
    return withForced<ProjectSupervisorSaveOutcome>(forced, () => {
      if (input.expectedGeneration !== project.settings.generation) return conflict();
      const model = models.find(item => item.instanceId === input.modelSelection.instanceId && item.model === input.modelSelection.model);
      const monitoring = input.monitoring ?? project.settings.monitoring ?? {intervalMinutes: 2, activityThreshold: 10};
      const team = input.teamSettings ?? project.settings.teamSettings ?? {maxHelpersPerRoot: 5};
      const integer = (value: number, minimum: number, maximum: number) => Number.isInteger(value) && value >= minimum && value <= maximum;
      if (!model?.available || !integer(monitoring.intervalMinutes, 1, 2) || !integer(monitoring.activityThreshold, 3, 100) || !integer(team.maxHelpersPerRoot, 0, 20))
        return {status: "invalid" as const, message: "Fixture: the model, monitoring or team settings are invalid.", snapshot: snapshot()};
      project.settings = {generation: project.settings.generation + 1, modelSelection: input.modelSelection, pending: false, monitoring, teamSettings: team};
      return {status: "saved" as const, message: "Fixture: Supervisor settings saved in memory.", snapshot: snapshot()};
    }, conflict, () => ({status: "uncertain" as const, message: "Fixture: Supervisor settings could not be confirmed. Refresh and inspect the current selection.", snapshot: null}));
  }

  retryProjectSupervisor(input: ProjectSupervisorRetryInput, forced: ForcedOutcome | null): ProjectSupervisorSaveOutcome {
    const project = this.project(input.projectId);
    const thread = this.thread(input.projectId, input.mainThreadId);
    const snapshot = () => this.projectSupervisor(input.projectId, input.mainThreadId);
    const conflict = () => ({status: "conflict" as const, message: "Fixture: the Supervisor binding changed.", snapshot: snapshot()});
    return withForced<ProjectSupervisorSaveOutcome>(forced, () => {
      const current = thread.binding;
      if (!current || input.expectedGeneration !== project.settings.generation || current.threadId !== input.threadId || current.generation !== input.bindingGeneration) return conflict();
      thread.binding = input.action === "replace"
        ? {...current, threadId: `${current.threadId}-replacement`, generation: current.generation + 1, state: "ready"}
        : {...current, state: "ready"};
      return {status: "saved" as const, message: "Fixture: native access retried in memory; no T3 call was made.", snapshot: snapshot()};
    }, conflict, () => ({status: "uncertain" as const, message: "Fixture: the native access retry is unconfirmed.", snapshot: null}));
  }

  chatSupervision(input: ProjectSupervisorChatSupervisionInput, forced: ForcedOutcome | null): ProjectSupervisorSaveOutcome {
    this.thread(input.projectId, input.mainThreadId);
    const snapshot = () => this.projectSupervisor(input.projectId, input.mainThreadId);
    const conflict = () => ({status: "conflict" as const, message: "Fixture: chat settings changed in another window.", snapshot: snapshot()});
    return withForced<ProjectSupervisorSaveOutcome>(forced, () => {
      if (input.policyGeneration !== this.data.threadPolicy.generation) return conflict();
      this.applyPolicy(input.enabled
        ? this.data.threadPolicy.excludedThreadIds.filter(id => id !== input.mainThreadId)
        : [...new Set([...this.data.threadPolicy.excludedThreadIds, input.mainThreadId])]);
      return {status: "saved" as const, message: input.enabled ? "Fixture: supervision enabled for this chat in memory." : "Fixture: supervision stopped for this chat in memory.", snapshot: snapshot()};
    }, conflict, () => ({status: "uncertain" as const, message: "Fixture: the chat supervision change is unconfirmed.", snapshot: null}));
  }

  private applyPolicy(excludedThreadIds: readonly string[]) {
    for (const id of excludedThreadIds) if (!this.data.stops[id]) this.data.stops[id] = {stoppedBy: "ui", stoppedAt: this.now()};
    for (const id of Object.keys(this.data.stops)) if (!excludedThreadIds.includes(id)) delete this.data.stops[id];
    this.data.threadPolicy = {generation: this.data.threadPolicy.generation + 1, excludedThreadIds: [...excludedThreadIds]};
  }

  saveThreadPolicy(input: ThreadPolicySettings, forced: ForcedOutcome | null): ThreadPolicySettings {
    return withForced<ThreadPolicySettings>(forced, () => {
      if (input.generation !== this.data.threadPolicy.generation) throw new FixtureFailure("Fixture: chat settings changed in another tab. Reload first.");
      this.applyPolicy(input.excludedThreadIds);
      return this.threadPolicy();
    }, () => {throw new FixtureFailure("Fixture: chat settings changed in another tab. Reload first.");},
    () => {throw new FixtureFailure("Fixture: the chat settings outcome is unconfirmed. Reload first.");});
  }

  workflowProgress(query: WorkflowProgressPagingQuery, now: number): WorkflowProgressSnapshot {
    const page = parseWorkflowProgressPageQuery(query);
    if (!page) throw new FixtureFailure("Fixture: invalid workflow progress page.");
    const thread = this.thread(page.projectId, page.mainThreadId);
    if (this.journeyFor(thread.id)) {
      const progress = fixtureJourney(this.journey!, page.projectId, thread.id, thread.binding!.threadId, now).progress;
      if (this.largeInterface && progress.scope && this.journey?.startsWith("nested")) {
        const childId = "fixture-contributing-child";
        const main = progress.workflows[0]!;
        return {...progress, workflowOffset: page.workflowOffset, lineageOffset: page.lineageOffset,
          scope: {...progress.scope, lineageTotal: progress.scope.lineageTotal + 1, threads: [...progress.scope.threads, {...progress.scope.threads[0]!, threadId: childId, parentThreadId: thread.id, depth: 1, origin: "delegated_child", title: "Fixture contributing correctness review", lifecycle: "completed", lifecycleDetail: "completed"}]},
          coverage: [...(progress.coverage ?? []), {threadId: childId, state: "assigned", assigneeThreadId: "fixture-review-helper", assigneeTitle: "Fixture review helper", assignmentRootThreadId: thread.binding!.threadId}],
          workflows: [...progress.workflows, {...main, workflowId: "fixture-child-workflow", threadId: childId, parentThreadId: thread.id, objective: "Synthetic child review contribution; parent completion remains separate.", plan: {kind: "sequence", templatePath: null, nodes: []}, assessment: null,
            parentNodeReferences: [{parentWorkflowId: main.workflowId, parentThreadId: thread.id, nodeId: "packing-review-correctness", nodeKind: "step", nodeName: "Correctness review"}], observations: [], contributions: []}]};
      }
      return {...progress, workflowOffset: page.workflowOffset, lineageOffset: page.lineageOffset};
    }
    return {status: "ok", message: null, projectId: page.projectId, mainThreadId: page.mainThreadId, observedAt: now, scope: null, coverage: [],
      incompatibleWorkflows: [], workflows: [], workflowOffset: page.workflowOffset, workflowHasMore: false, lineageOffset: page.lineageOffset, lineageHasMore: false};
  }

  projectDefinitions(projectId: string, threadId: string | null): ProjectDefinitionSnapshot {
    const project = this.project(projectId);
    if (threadId !== null) this.thread(projectId, threadId);
    const workspaceRoot = project.checkouts.find(target => target.threadId === threadId && threadId !== null)?.workspaceRoot ?? project.workspaceRoot;
    const scratch = project.classification === "scratch";
    const empty = {steps: [], workflows: [], config: {workflows: [], steps: []}, projectConfig: null, definitionFiles: [], sources: [], issues: []};
    if (scratch) return {projectId, threadId, workspaceRoot: "", globalOnly: true, globalRevision: null, revision: null, editingAvailable: true, status: "missing", complete: true, ...empty};
    const config = project.projectConfig;
    if (!config || !this.folderPresent(project)) return {projectId, threadId, workspaceRoot, globalOnly: false, globalRevision: null,
      revision: null, editingAvailable: true, status: "missing", complete: true, ...empty};
    const entries = (kind: "workflows" | "steps") => config[kind].flatMap(entry => {
      const id = catalogEntryId(kind, entry.path);
      return id ? [{id, path: entry.path, summary: entry.summary, required: entry.required, origin: "project" as const, sourceId: id}] : [];
    });
    const files = project.id === fixtureIds.projectA ? {steps: {...stepFiles, ...(this.largeInterface ? Object.fromEntries(Array.from({length: 45}, (_, i) => [`fixture-duty-${i + 1}`, {name: `Fixture duty ${i + 1}`, description: `Preserve the actual scope, verified evidence and remaining obligations for synthetic duty ${i + 1}.\n\nInspect the changed boundary, retain existing progress, verify relevant behavior and report any unverified claims clearly.`, references: ["docs/synthetic-reference.md"], skills: []}])) : {})}, workflows: this.largeInterface ? {...workflowFiles, "fixture-delivery": {...workflowFiles["fixture-delivery"]!, sequence: [{step: "fixture-tests"}, {parallel: [{step: "fixture-duty-1"}, {step: "fixture-review"}]}, {sequence: [{step: "fixture-duty-2"}, {step: "fixture-duty-3"}]}]}} : workflowFiles} : {steps: {}, workflows: {}};
    const missing = [...entries("workflows").filter(entry => !(entry.id in files.workflows)), ...entries("steps").filter(entry => !(entry.id in files.steps))];
    return {
      projectId, threadId, workspaceRoot, globalOnly: false, globalRevision: null, revision: sha256(JSON.stringify(config)), editingAvailable: true,
      status: missing.length ? "invalid" : "ready", complete: true,
      steps: entries("steps").flatMap(entry => {const file = files.steps[entry.id];return file ? [{id: entry.id, name: file.name, description: file.description, summary: entry.summary, ...definitionGuidanceFields(file),
        origin: "project" as const, path: `.t3-supervisor/${entry.path}`, sourceId: entry.id}] : [];}),
      workflows: entries("workflows").flatMap(entry => {const file = files.workflows[entry.id];return file ? [{id: entry.id, name: file.name, description: file.description,
        summary: entry.summary, fixed: false, sequence: file.sequence, origin: "project" as const, path: `.t3-supervisor/${entry.path}`, sourceId: entry.id}] : [];}),
      config: {workflows: entries("workflows"), steps: entries("steps"), ...(config.default_workflow === undefined ? {} : {default_workflow: config.default_workflow})},
      projectConfig: config,
      definitionFiles: [
        ...Object.keys(files.workflows).map(id => ({origin: "project" as const, kind: "workflows" as const, id, path: `workflows/${id}.yaml`})),
        ...Object.keys(files.steps).map(id => ({origin: "project" as const, kind: "steps" as const, id, path: `steps/${id}.md`})),
      ],
      sources: [{path: ".t3-supervisor/project.yaml", origin: "project", content: `# fixture: synthetic project.yaml\n${stringify(config)}`}],
      issues: missing.map(entry => ({path: `.t3-supervisor/${entry.path}`, code: "missing_definition", message: `Fixture: ${entry.path} is indexed but has no synthetic file.`})),
    };
  }

  checkoutInventory(projectId: string) {
    const project = this.project(projectId);
    const targets = project.checkouts.filter(target => !this.partialInventory || target.threadId !== fixtureIds.threadA3).map(target => ({workspaceRoot: target.workspaceRoot, threadId: target.threadId, branch: target.branch, isGitRepository: target.isGitRepository, vcsAvailable: true,
      members: this.data.threads.filter(thread => thread.projectId === projectId && (target.threadId === null ? !project.checkouts.some(checkout => checkout.threadId === thread.id) : target.threadId === thread.id)).map(thread => ({threadId: thread.id, title: thread.title}))}));
    return {projectId, available: true, complete: !this.partialInventory, reason: null, issues: this.partialInventory ? [{threadId: fixtureIds.threadA3, message: "Working folder unavailable for Fixture chat A3: workspace_binding_unavailable."}] : [], targets};
  }

  saveProjectConfiguration(input: ProjectConfigSave, forced: ForcedOutcome | null): ProjectConfigSaveOutcome {
    const project = this.project(input.projectId);
    const current = () => this.projectDefinitions(input.projectId, input.threadId);
    const conflict = () => ({status: "conflict" as const, message: "Fixture: project.yaml changed since it was read. Refresh definitions before saving again.", definitions: current()});
    return withForced<ProjectConfigSaveOutcome>(forced, () => {
      const before = current();
      if (!before.revision || !project.projectConfig) return {status: "unavailable" as const, message: "Fixture: this checkout has no project.yaml to update.", definitions: null};
      if (before.revision !== input.expectedRevision) return conflict();
      const normalized = normalizeProjectConfiguration(input.config);
      const problem = projectConfigurationError(normalized);
      if (problem) return {status: "invalid" as const, message: problem, definitions: before};
      project.projectConfig = normalized;
      return {status: "saved" as const, message: "Fixture: saved the synthetic project.yaml in memory; no file was written.", definitions: current()};
    }, conflict, () => ({status: "uncertain" as const, message: "Fixture: the save outcome could not be confirmed. Refresh and inspect project.yaml before retrying.", definitions: null}));
  }
}

export const scenarioNames = [
  "journey-request", "journey-following", "journey-catching-up", "journey-paused", "journey-proposal", "journey-agreed", "journey-working", "journey-attention", "journey-revised", "journey-reagreed", "journey-verified",
  "journey-nested", "journey-nested-attention", "journey-completed", "journey-stale", "journey-retained",
  "partial-inventory", "large-interface", "baseline", "session-expiry-next-call", "signout-other-tab", "mutation-never-answered", "mutation-dropped",
  "save-401", "save-403", "save-409", "save-413", "editor-conflict", "editor-uncertain", "slow-reads", "setup-race", "reload",
] as const;
export type ScenarioName = typeof scenarioNames[number];
export const isScenarioName = (value: string): value is ScenarioName => (scenarioNames as readonly string[]).includes(value);

// path null matches every mutation post under /api/guidance/
export type Arm =
  | {kind: "session-expiry"}
  | {kind: "status"; status: 401 | 403 | 409 | 413; path: string | null}
  | {kind: "hold" | "drop"; path: string | null; apply: boolean}
  | {kind: "outcome"; outcome: "conflict" | "uncertain"; path: string; apply: boolean}
  | {kind: "slow-reads"; ms: number}
  | {kind: "delayed-answer"; path: string; ms: number};
export type ScenarioParams = {path: string | null; apply: boolean; ms: number | null};
export type ScenarioPlan = {arms: Arm[]; revokeSessions: boolean};

export const maxDelayMs = 30_000;
const configurationPath = "/api/guidance/project-configuration";
const setupPath = "/api/guidance/supervision-setup";
const plan = (arms: Arm[], revokeSessions = false): ScenarioPlan => ({arms, revokeSessions});

export const scenarioCatalog: Record<ScenarioName, {description: string; plan: (params: ScenarioParams) => ScenarioPlan}> = {
  "partial-inventory": {description: "independently readable project folder with one unavailable conversation binding", plan: () => plan([])},
  "large-interface": {description: "synthetic 149-conversation collection, 45 additional full duties and distinct/shared working folders", plan: () => plan([])},
  "journey-request": {description: "reconstructed packing example: the request is being interpreted", plan: () => plan([])},
  "journey-following": {description: "reconstructed packing example: quiet discussion and draft understanding", plan: () => plan([])},
  "journey-catching-up": {description: "reconstructed packing example: a newer requester message is being considered", plan: () => plan([])},
  "journey-paused": {description: "reconstructed packing example: discussion with prior agreement and progress retained", plan: () => plan([])},
  "journey-proposal": {description: "reconstructed packing example: Change workflow proposed", plan: () => plan([])},
  "journey-agreed": {description: "reconstructed packing example: proposal accepted, no assessment yet", plan: () => plan([])},
  "journey-working": {description: "reconstructed packing example: scope and evidence assessed, design underway", plan: () => plan([])},
  "journey-attention": {description: "reconstructed packing example: overfill behavior not evidenced", plan: () => plan([])},
  "journey-revised": {description: "reconstructed packing example: refined Verify criterion awaiting acceptance; live statuses unchanged", plan: () => plan([])},
  "journey-reagreed": {description: "reconstructed packing example: refined check accepted; verification underway", plan: () => plan([])},
  "journey-verified": {description: "reconstructed packing example: refined criterion verified", plan: () => plan([])},
  "journey-nested": {description: "reconstructed packing example: independent review underway in parallel", plan: () => plan([])},
  "journey-nested-attention": {description: "reconstructed packing example: a review branch needs attention while its workflow stays underway", plan: () => plan([])},
  "journey-completed": {description: "reconstructed packing example: reviewed pull request ready for handoff", plan: () => plan([])},
  "journey-stale": {description: "reconstructed packing example: acceptance out of date", plan: () => plan([])},
  "journey-retained": {description: "reconstructed packing example: accepted plan beside an unlinked earlier workflow", plan: () => plan([])},
  "baseline": {description: "normal synthetic behaviour", plan: () => plan([])},
  "session-expiry-next-call": {description: "the next /api/ call with a valid session revokes that session and answers 401", plan: () => plan([{kind: "session-expiry"}])},
  "signout-other-tab": {description: "revokes every fixture session now, as a sign-out in another tab does server-side", plan: () => plan([], true)},
  "mutation-never-answered": {description: "the next mutation post (or ?path=) is received and held without an answer until /__fixture/held/answer or /drop; ?apply=1 applies it first",
    plan: params => plan([{kind: "hold", path: params.path, apply: params.apply}])},
  "mutation-dropped": {description: "the next mutation post (or ?path=) is received and its connection is destroyed without a response; ?apply=1 applies it first",
    plan: params => plan([{kind: "drop", path: params.path, apply: params.apply}])},
  "save-401": {description: "the next mutation post (or ?path=) answers 401 and revokes the presented session; nothing is applied",
    plan: params => plan([{kind: "status", status: 401, path: params.path}])},
  "save-403": {description: "the next mutation post (or ?path=) answers 403 with the csrf refusal; nothing is applied", plan: params => plan([{kind: "status", status: 403, path: params.path}])},
  "save-409": {description: "the next mutation post (or ?path=) answers http 409, a synthetic non-ok status the baseline server never sends; nothing is applied",
    plan: params => plan([{kind: "status", status: 409, path: params.path}])},
  "save-413": {description: "the next mutation post (or ?path=) answers 413 payload too large; nothing is applied", plan: params => plan([{kind: "status", status: 413, path: params.path}])},
  "editor-conflict": {description: "the next project-configuration save (or ?path=) answers a schema-valid conflict result without applying",
    plan: params => plan([{kind: "outcome", outcome: "conflict", path: params.path ?? configurationPath, apply: false}])},
  "editor-uncertain": {description: "the next project-configuration save (or ?path=) answers a schema-valid uncertain result; ?apply=1 applies it first",
    plan: params => plan([{kind: "outcome", outcome: "uncertain", path: params.path ?? configurationPath, apply: params.apply}])},
  "slow-reads": {description: "every /api/guidance/ read waits ?ms= (default 2000, at most 30000) before answering, until the scenario changes",
    plan: params => plan([{kind: "slow-reads", ms: params.ms ?? 2_000}])},
  "setup-race": {description: "the next supervision-setup post (or ?path=) is applied at receipt and answered after ?ms= (default 5000, at most 30000)",
    plan: params => plan([{kind: "delayed-answer", path: params.path ?? setupPath, ms: params.ms ?? 5_000}])},
  "reload": {description: "label only: baseline behaviour while the browser reloads; in-memory state persists across reloads", plan: () => plan([])},
};

export const parseScenarioParams = (search: URLSearchParams): ScenarioParams | string => {
  const path = search.get("path");
  if (path !== null && !/^\/api\/guidance\/[a-z0-9/-]+$/u.test(path)) return "path must be an exact /api/guidance/ pathname";
  const apply = search.get("apply");
  if (apply !== null && !["0", "1", "true", "false"].includes(apply)) return "apply must be 0 or 1";
  const ms = search.get("ms");
  if (ms !== null && (!/^\d+$/u.test(ms) || Number(ms) > maxDelayMs)) return `ms must be an integer from 0 to ${maxDelayMs}`;
  return {path, apply: apply === "1" || apply === "true", ms: ms === null ? null : Number(ms)};
};
