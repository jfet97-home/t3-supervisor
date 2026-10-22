import type { ProjectSupervisor } from "../../src/project-supervisor.js";
import type { ProjectSupervisorChatSupervisionInput, ProjectSupervisorInfo, ProjectSupervisorRetryInput, ProjectSupervisorSaveInput, ProjectSupervisorSaveOutcome } from "../../src/project-supervisor-contract.js";

// a project supervisor snapshot that exercises every optional and recursive part of the contract

const source = {origin: "project", path: ".t3-supervisor/steps/inspect.md", sourceId: "inspect"} as const;

export const supervisorSnapshot: ProjectSupervisorInfo = {
  noProjectMode: "on_request",
  projectId: "project",
  mainThreadId: "task-thread",
  modelApplication: {pending: true, attempts: 2, message: "Waiting for T3 to apply the model."},
  settings: {
    generation: 7,
    modelSelection: {instanceId: "provider-one", model: "steady-model", options: [{id: "reasoningEffort", value: "steady"}, {id: "thinking", value: true}]},
    pending: false,
    monitoring: {intervalMinutes: 5, activityThreshold: 10},
    teamSettings: {maxHelpersPerRoot: 3},
  },
  binding: {projectId: "project", mainThreadId: "task-thread", threadId: "supervisor-thread", generation: 7, enabledAt: 1_800_000_000_000, state: "ready",
    settlementState: "pending", keptActive: true, settlementBlockedBy: null},
  modelSelection: {instanceId: "provider-one", model: "steady-model", options: []},
  models: [{instanceId: "provider-one", model: "steady-model", name: "Steady", providerName: "Provider One", available: true, options: [
    {id: "reasoningEffort", label: "Reasoning", choices: [{value: "steady", label: "Steady"}, {value: "quick", label: "Quick"}], defaultValue: "steady"},
    {id: "thinking", label: "Thinking", choices: [{value: true, label: "On"}, {value: false, label: "Off"}], defaultValue: false},
  ]}],
  monitoringStatus: {state: "busy", message: "Reviewing recent activity.", pendingItems: 2, nextReviewAt: 1_800_000_060_000, lastNoticeAt: null, retryable: false},
  available: true,
  message: "T3 reports the selected model.",
  tasks: [{
    id: "task-1", sourceHash: "source-hash-1", threadId: "task-thread", projectId: "project", sourceRunId: "run-1", sourceMessageId: "message-1",
    status: "inferred", objective: "Review <the> change", reason: "The request asks for a review.", updatedAt: 1_800_000_000_100,
    workflow: {
      status: "proposed", message: "A plan was prepared.", workspaceRoot: "/workspace/project", revision: "revision-1", globalRevision: null,
      definitionsStatus: "ready", definitionsComplete: true, requirementsKnown: true,
      requirements: [{kind: "step", id: "inspect", name: "Inspect", source, state: "included", reason: "Required by the project."}],
      issues: [{path: ".t3-supervisor/project.yaml", code: "note", message: "Informational."}],
      plan: {kind: "sequence", templatePath: "review.yaml/sequence", nodes: [
        {kind: "step", nodeId: "step-inspect", definitionId: "inspect", localId: null, templatePath: "review.yaml/sequence/0", name: "Inspect",
          description: "Read the change.", references: ["inspect"], source, resolution: "resolved", reason: "The task changes code.", status: "underway",
          contributorThreadIds: ["child-1"]},
        {kind: "workflow", nodeId: "workflow-check", definitionId: "check", templatePath: null, name: "Check", description: "Check it.", fixed: null,
          source: null, resolution: "partial", reason: "One member does not apply.", status: "planned", contributorThreadIds: [],
          omissions: [{templatePath: "check.yaml/sequence/1", kind: "step", id: "security", name: "Security", source: null, reason: "No boundary changes."}],
          plan: {kind: "parallel", templatePath: null, nodes: [
            {kind: "step", nodeId: "step-local", definitionId: null, localId: "notes", templatePath: null, name: "Notes", description: "Check notes.",
              source: null, resolution: "unresolved", reason: "Task-local.", status: "needs_attention", contributorThreadIds: []},
          ]}},
      ]},
    },
    agreement: null,
    workflowProposalId: "proposal-1",
    definitionReview: {status: "checking", message: "Checking the change.", expectedRevision: "revision-1", observedRevision: null, supervisorMessageId: null,
      userMessageIds: ["user-1"], updatedAt: 1_800_000_000_200},
    workflowProtocolDiagnostic: {role: "operative", proposalId: "proposal-1", messageId: "message-2", code: "missing_field", observedAt: 1_800_000_000_300,
      path: "plan.nodes[0]", expected: "a step node", detail: null, attempts: 1},
  }],
  team: {
    status: "ok", message: null, observedAt: 1_800_000_000_400,
    root: {threadId: "supervisor-thread", title: "Supervisor", model: "steady-model", readiness: "ready", lifecycle: "active", currentState: "Reviewing.",
      lastAssessment: {summary: "On track.", assessedAt: 1_800_000_000_350}},
    members: [{threadId: "helper-1", title: null, model: null, readiness: "pending", lifecycle: "idle", assignments: [{threadId: "child-1", title: "Child", state: "active"}],
      currentState: null, lastAssessment: null,
      pendingHandovers: [{targetThreadId: "child-1", targetTitle: null, direction: "outgoing", state: "uncertain", summary: "Handover.", updatedAt: 1_800_000_000_360,
        runStatus: "running", review: "requested"}],
      issues: [{id: "issue-1", severity: "warning", summary: "Slow.", observedAt: 1_800_000_000_370}]}],
    issues: [],
  },
  chatSupervision: {stopped: false, policyGeneration: 4, stoppedBy: null, stoppedCallerThreadId: null, stoppedUserMessageId: null, effectiveEnabled: true,
    activation: "explicit", stoppedAt: null},
};

export const saveOutcome: ProjectSupervisorSaveOutcome = {status: "saved", message: "Saved the Supervisor settings.", snapshot: supervisorSnapshot};
export const retryOutcome: ProjectSupervisorSaveOutcome = {status: "uncertain", message: "The native retry is unconfirmed.", snapshot: null};

export type SupervisionCalls = {saves: unknown[]; retries: unknown[]; chats: unknown[]};

// the four ProjectSupervisor methods the HttpApi handlers call for these endpoints, recording each decoded payload
export const fakeSupervision = (): {supervision: ProjectSupervisor; calls: SupervisionCalls} => {
  const calls: SupervisionCalls = {saves: [], retries: [], chats: []};
  const supervision = {
    snapshot: async (projectId: string, _signal: AbortSignal, mainThreadId: string | null) => ({...supervisorSnapshot, projectId, mainThreadId}),
    save: async (payload: ProjectSupervisorSaveInput) => {calls.saves.push(payload);return saveOutcome;},
    retry: async (payload: ProjectSupervisorRetryInput) => {calls.retries.push(payload);return retryOutcome;},
    setChatSupervision: async (payload: ProjectSupervisorChatSupervisionInput) => {calls.chats.push(payload);return retryOutcome;},
  } as unknown as ProjectSupervisor;
  return {supervision, calls};
};
