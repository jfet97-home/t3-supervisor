import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultMonitoringSettings, defaultSupervisorTeamSettings, ProjectSupervisorSave, ProjectSupervisorSnapshot, type DefinitionReviewInfo, type ProjectSupervisorInfo, type ProjectSupervisorRetryInput, type ProjectSupervisorSaveInput, type ProjectSupervisorTeamInfo, type SupervisorModelSelection, type WorkflowAgreementInfo, type WorkflowPlanGroupInfo, type WorkflowProposalInfo } from "../src/project-supervisor-contract.js";
import type { WorkflowProgressSnapshot } from "../src/workflow-progress.js";
import { confirmChatSupervisionChange, ProjectSupervisorView, WorkflowProgressPanel, shouldOfferNativeRetry } from "../ui/src/project-supervisor.js";
import { loadProjectSupervisor, loadWorkflowProgress, ProjectSupervisorRequestError, refreshWorkflowProgressPages, retryProjectSupervisor, saveProjectSupervisor } from "../ui/src/project-supervisor-api.js";

const selection: SupervisorModelSelection = {
  instanceId: "provider-one",
  model: "steady-model",
  options: [{id: "reasoningEffort", value: "steady"}, {id: "temperature", value: "0.6"}],
};

const snapshot: ProjectSupervisorInfo = {
  projectId: "project",
  mainThreadId: "task-thread",
  modelApplication: null,
  settings: {generation: 7, modelSelection: selection, pending: true},
  binding: {projectId: "project", mainThreadId: "task-thread", threadId: "exact-thread-123", generation: 7, enabledAt: 1, state: "ready"},
  modelSelection: {instanceId: "provider-two", model: "quick-model", options: [{id: "thinking", value: true}]},
  models: [
    {instanceId: "provider-one", model: "steady-model", name: "Steady", providerName: "Provider One", available: true, options: [
      {id: "reasoningEffort", label: "Reasoning", choices: [{value: "steady", label: "Steady"}, {value: "quick", label: "Quick"}], defaultValue: "steady"},
      {id: "temperature", label: "Temperature", choices: [{value: "0.2", label: "0.2"}, {value: "0.6", label: "0.6"}], defaultValue: "0.6"},
    ]},
    {instanceId: "provider-two", model: "quick-model", name: "Quick", providerName: "Provider Two", available: false, options: [
      {id: "thinking", label: "Thinking", choices: [{value: true, label: "Enabled"}, {value: false, label: "Disabled"}], defaultValue: true},
    ]},
  ],
  available: true,
  message: "T3 reports the selected model.",
  tasks: [{threadId: "task-thread", projectId: "project", sourceRunId: "run-1", sourceMessageId: "message-1", status: "inferred", objective: "<script>task</script>", reason: "The task text supports this interpretation.", updatedAt: 1}],
};

const input: ProjectSupervisorSaveInput = {projectId: "project", mainThreadId: "task-thread", expectedGeneration: 7, modelSelection: selection};
const monitoring = {intervalMinutes: "5", activityThreshold: "10"};
const teamSettings = {maxHelpersPerRoot: String(defaultSupervisorTeamSettings.maxHelpersPerRoot)};
const viewDefaults = {teamSettings, onTeamSettingsChange: () => {}};
const plan: WorkflowPlanGroupInfo = {
  kind: "sequence", templatePath: "delivery.yaml/sequence", nodes: [
    {kind: "step", nodeId: "step-inspect", definitionId: "inspect-source", localId: null, templatePath: "delivery.yaml/sequence/0", name: "Inspect source", description: "Read the affected code.", source: {origin: "project", path: ".t3-supervisor/steps/inspect-source.md", sourceId: "inspect-source"}, resolution: "resolved", reason: "The task changes project code.", status: "planned", contributorThreadIds: ["child-one"]},
    {kind: "parallel", templatePath: "delivery.yaml/sequence/1", nodes: [
      {kind: "workflow", nodeId: "workflow-reviewer", definitionId: "reviewer", templatePath: "delivery.yaml/sequence/1/0", name: "Reviewer", description: "Review the implementation independently.", fixed: true, source: {origin: "project", path: ".t3-supervisor/workflows/reviewer.yaml", sourceId: "reviewer"}, resolution: "partial", reason: "One original member was assessed as not applicable.", status: "planned", contributorThreadIds: [], omissions: [{templatePath: "reviewer.yaml/sequence/1", kind: "step", id: "security-review", name: "Security review", source: {origin: "global", path: "~/.t3-supervisor/steps/security-review.md", sourceId: "security-review"}, reason: "The task does not change a security boundary."}], plan: {kind: "sequence", templatePath: "reviewer.yaml/sequence", nodes: [
        {kind: "step", nodeId: "step-e2e", definitionId: "e2e-testing", localId: null, templatePath: "reviewer.yaml/sequence/0", name: "End-to-end testing", description: "Test the changed behavior.", source: {origin: "global", path: "~/.t3-supervisor/steps/e2e-testing.md", sourceId: "e2e-testing"}, resolution: "resolved", reason: "The change affects user behavior.", status: "planned", contributorThreadIds: []},
      ]}},
      {kind: "step", nodeId: "step-local", definitionId: null, localId: "check-notes", templatePath: null, name: "Check migration notes", description: "Review task-specific upgrade notes.", source: null, resolution: "resolved", reason: "The change modifies migration behavior.", status: "planned", contributorThreadIds: []},
    ]},
  ],
};
const workflow = (overrides: Partial<WorkflowProposalInfo> = {}): WorkflowProposalInfo => ({
  status: "proposed",
  message: "A plan was prepared from the current project definitions.",
  workspaceRoot: "/workspace/project",
  revision: "definition-revision-12",
  globalRevision: null,
  definitionsStatus: "ready",
  definitionsComplete: true,
  requirementsKnown: true,
  requirements: [
    {kind: "workflow", id: "reviewer", name: "Reviewer", source: {origin: "project", path: ".t3-supervisor/workflows/reviewer.yaml", sourceId: "reviewer"}, state: "included", reason: "The plan includes the referenced workflow."},
    {kind: "step", id: "e2e-testing", name: "End-to-end testing", source: {origin: "global", path: "~/.t3-supervisor/steps/e2e-testing.md", sourceId: "e2e-testing"}, state: "included", reason: "Included recursively within reviewer."},
  ],
  issues: [],
  plan,
  ...overrides,
});
const agreement = (overrides: Partial<WorkflowAgreementInfo> = {}): WorkflowAgreementInfo => ({
  status: "agreed",
  message: "The Supervisor and agent agreed on this plan.",
  proposalId: "proposal-1",
  agreedAt: 1_800_000_000_000,
  supervisorMessageId: "supervisor-message-1",
  agentMessageId: "agent-message-1",
  workflow: workflow(),
  ...overrides,
});
const definitionReview = (overrides: Partial<DefinitionReviewInfo> = {}): DefinitionReviewInfo => ({
  status: "checking",
  message: "The change is being checked against the recorded authorization.",
  expectedRevision: "definition-revision-12",
  observedRevision: null,
  supervisorMessageId: null,
  userMessageIds: [],
  updatedAt: 1_800_000_000_000,
  ...overrides,
});

const progressSnapshot: WorkflowProgressSnapshot = {
  status: "ok",
  message: null,
  projectId: "project",
  mainThreadId: "task-thread",
  observedAt: 1_800_000_000_100,
  scope: {
    projectId: "project",
    mainThreadId: "task-thread",
    supervisorThreadId: "supervisor-thread",
    bindingGeneration: 4,
    observedAt: 1_800_000_000_090,
    complete: true,
    lineageTotal: 6,
    lineageOffset: 0,
    lineageHasMore: false,
    issues: [],
    threads: [
      {threadId: "task-thread", parentThreadId: null, depth: 0, origin: "main", lifecycle: "running", lifecycleDetail: "running", archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "Contact the main through its native T3 chat."},
      {threadId: "child-one", parentThreadId: "task-thread", depth: 1, origin: "native_child", lifecycle: "unknown", lifecycleDetail: null, archivedAt: null, deletedAt: null,
        activityRefs: [{sourceThreadId: "child-one", sourceRunId: "child-run", sourceMessageId: "child-message", sourceItemId: "child-item", kind: "command", observedAt: 1_800_000_000_050, label: "command · completed"}],
        contactLimit: "Guide through the direct parent; keep native child contact mediated."},
      {threadId: "child-two", parentThreadId: "task-thread", depth: 1, origin: "delegated_child", lifecycle: "completed", lifecycleDetail: "completed", archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "Terminal child; route follow-up through the parent."},
      {threadId: "failed-native", parentThreadId: "task-thread", depth: 1, origin: "native_child", lifecycle: "interrupted", lifecycleDetail: "failed", archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "Terminal child; route follow-up through the parent."},
      {threadId: "cancelled-delegated", parentThreadId: "task-thread", depth: 1, origin: "delegated_child", lifecycle: "interrupted", lifecycleDetail: "cancelled", archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "Terminal child; route follow-up through the parent."},
      {threadId: "unreported-child", parentThreadId: "task-thread", depth: 1, origin: "delegated_child", lifecycle: "unknown", lifecycleDetail: null, archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "Unknown; route through the parent."},
    ],
  },
  incompatibleWorkflows: [],
  workflows: [
    {workflowId: "main-workflow", projectId: "project", mainThreadId: "task-thread", threadId: "task-thread", parentThreadId: null,
      revision: 2, status: "underway", objective: "Review the source change", plan, updatedAt: 1_800_000_000_080,
      parentNodeReferences: [], observations: [], contributions: []},
    {workflowId: "child-workflow", projectId: "project", mainThreadId: "task-thread", threadId: "child-one", parentThreadId: "task-thread",
      revision: 1, status: "needs_attention", objective: "Review the integration", plan: null, updatedAt: 1_800_000_000_070,
      parentNodeReferences: [
        {parentWorkflowId: "main-workflow", parentThreadId: "task-thread", nodeId: "step-inspect", nodeKind: "step", nodeName: "Inspect source"},
        {parentWorkflowId: "main-workflow", parentThreadId: "task-thread", nodeId: "step-local", nodeKind: "step", nodeName: "Check migration notes"},
      ],
      observations: [{id: "observation-one", kind: "observation", recordedAt: 1_800_000_000_060,
        targetNodeId: "step-inspect", targetNodeName: "Inspect source", statusFrom: null, statusTo: null,
        sourceThreadId: "child-one", sourceRunId: "child-run", sourceMessageId: "child-message", sourceItemId: "child-item",
        note: "The Supervisor observed the linked test output."}],
      contributions: [],
    },
  ],
  workflowOffset: 0,
  workflowHasMore: false,
  lineageOffset: 0,
  lineageHasMore: false,
};

const renderTaskView = (task: ProjectSupervisorInfo["tasks"][number]) => renderToStaticMarkup(createElement(ProjectSupervisorView, {
  ...viewDefaults,
  snapshot: {...snapshot, tasks: [task]}, selection, monitoring, threadId: task.threadId, connected: true,
  saving: false, fieldsBusy: false, blocked: false, dirty: false, canSave: false, shouldOfferRetry: false, retryButtonLabel: "Retry native access", canRetry: false,
  onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
}));

test("Supervisor settings markup explains automatic conversation reuse and separates saved, current and task state", () => {
  const monitoringSnapshot = {
    ...snapshot,
    monitoringStatus: {state: "busy" as const, message: "A monitoring review is running.", pendingItems: 4, nextReviewAt: 1_800_000_000_000, lastNoticeAt: null},
  };
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
  ...viewDefaults,
    snapshot: {...monitoringSnapshot, message: '<img src=x onerror="alert(1)">'}, selection, monitoring, threadId: "task-thread", connected: true,
    saving: false, fieldsBusy: false, blocked: false, dirty: false, canSave: false, shouldOfferRetry: false, retryButtonLabel: "Retry native access", canRetry: false,
    onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Bound conversation/);
  assert.match(html, /t3-thread:\/\/v1\/exact-thread-123/);
  assert.match(html, /Saving settings does not start a conversation/);
  assert.match(html, /Role instructions limit it to reading and messaging through T3, but those instructions do not enforce tool restrictions/);
  assert.match(html, /creates the Supervisor conversation for the first task that needs it/);
  assert.match(html, /reuses it when that main conversation resumes/);
  assert.match(html, /Project default for new Supervisors/);
  assert.match(html, /Selected Supervisor model in T3/);
  assert.match(html, /Edit this conversation/);
  assert.match(html, /Task interpretation for the selected conversation/);
  assert.match(html, /&lt;script&gt;task&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<label for="supervisor-model">Model/);
  assert.match(html, /<label for="supervisor-reasoning">Reasoning/);
  assert.doesNotMatch(html, /<label>Temperature/);
  assert.doesNotMatch(html, /supervisor-monitoring-enabled|monitoringEnabled|pause monitoring/i);
  assert.match(html, /id="supervisor-monitoring-interval" type="number" min="1" max="60" step="1" required=""/);
  assert.match(html, /name="intervalMinutes"/);
  assert.match(html, /id="supervisor-monitoring-threshold" type="number" min="3" max="100" step="1" required=""/);
  assert.match(html, /name="activityThreshold"/);
  assert.match(html, /aria-describedby="supervisor-monitoring-interval-help supervisor-monitoring-interval-error"/);
  assert.match(html, /Supervisor cooldown:<\/strong> 60 seconds between monitoring sends/);
  assert.match(html, /Current monitoring status/);
  assert.match(html, /Status:<\/strong> busy/);
  assert.match(html, /Pending activities:<\/strong> 4/);
  assert.match(html, /Next review:<\/strong>/);
  assert.match(html, /Last notice:<\/strong> Not scheduled/);
  assert.match(html, /A monitoring review is running/);
  assert.match(html, /existing objective-only tasks are not reprocessed/);
  assert.doesNotMatch(html, /Create conversation/);
});

test("monitoring settings default sensibly and remain optional for legacy snapshots and saves", () => {
  assert.deepEqual(defaultMonitoringSettings, {intervalMinutes: 5, activityThreshold: 10});
  assert.deepEqual(defaultSupervisorTeamSettings, {maxHelpersPerRoot: 5});
  const decodedSnapshot = Schema.decodeUnknownSync(ProjectSupervisorSnapshot)(snapshot);
  const decodedInput = Schema.decodeUnknownSync(ProjectSupervisorSave)(input);
  assert.equal(decodedSnapshot.settings.monitoring, undefined);
  assert.equal(decodedSnapshot.settings.teamSettings, undefined);
  assert.equal(decodedInput.monitoring, undefined);
  assert.equal(decodedInput.teamSettings, undefined);
  assert.equal(decodedSnapshot.tasks[0]?.definitionReview, undefined);
});

test("Supervisor team stays distinct from operational workflows and shows member state, assignments and handovers", () => {
  const team: ProjectSupervisorTeamInfo = {
    status: "incomplete",
    message: "One helper snapshot is delayed.",
    observedAt: 1_800_000_000_200,
    root: {
      threadId: "exact-thread-123",
      title: "Root Supervisor",
      model: "steady-model",
      readiness: "ready",
      lifecycle: "active",
      currentState: "Coordinating the main workflow",
      lastAssessment: {summary: "The main remains on track.", assessedAt: 1_800_000_000_150},
    },
    members: [{
      threadId: "helper-thread-1",
      title: "Testing helper",
      model: "quick-model",
      readiness: "ready",
      lifecycle: "idle",
      assignments: [{threadId: "child-one", title: "Test subtree", state: "active"}],
      currentState: "An operational-child guidance delivery is uncertain; its original target and native command remain pending reconciliation.",
      lastAssessment: {summary: "The child tests found a missing case.", assessedAt: 1_800_000_000_180},
      pendingHandovers: [{targetThreadId: "child-two", targetTitle: "Integration subtree", direction: "outgoing", state: "uncertain", summary: "Delivery outcome is still being reconciled.", updatedAt: 1_800_000_000_190}],
      issues: [{id: "issue-1", severity: "critical", summary: "A required test failed.", observedAt: 1_800_000_000_185}],
    }, {
      threadId: "quarantined-helper",
      title: "Quarantined helper",
      model: null,
      readiness: "unavailable",
      lifecycle: "quarantined",
      assignments: [],
      currentState: "Quarantined: the root owns its former operational coverage; unresolved writes and notices remain fenced, and the native conversation may still exist or run.",
      lastAssessment: null,
      pendingHandovers: [
        {targetThreadId: "child-three", targetTitle: "Release subtree", direction: "incoming", state: "delivered", summary: "Notice delivered, awaiting acknowledgment.", updatedAt: 1_800_000_000_198, runStatus: "interrupted"},
        {targetThreadId: "child-four", targetTitle: "Build subtree", direction: "outgoing", state: "failed", summary: "Native delivery was definitely rejected.", updatedAt: 1_800_000_000_199},
        {targetThreadId: "child-five", targetTitle: "Reviewed subtree", direction: "incoming", state: "delivered", summary: "Accept responsibility for the subtree.",
          updatedAt: 1_800_000_000_200, runStatus: "interrupted", review: "completed"},
        {targetThreadId: "child-six", targetTitle: "Reviewing subtree", direction: "incoming", state: "delivered", summary: "Accept responsibility for the subtree.",
          updatedAt: 1_800_000_000_201, runStatus: "cancelled", review: "in_progress"},
        {targetThreadId: "child-six", targetTitle: "Reviewing subtree", direction: "incoming", state: "sending", summary: "", updatedAt: 1_800_000_000_202, review: "requested"},
      ],
      issues: [],
    }],
    issues: [{id: "team-issue-1", severity: "warning", summary: "The handover has not been acknowledged.", observedAt: 1_800_000_000_195}],
  };
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
    ...viewDefaults,
    snapshot: {...snapshot, team, settings: {...snapshot.settings, teamSettings: {maxHelpersPerRoot: 6}}},
    selection, monitoring, teamSettings: {maxHelpersPerRoot: "6"}, connected: true, saving: false, fieldsBusy: false,
    blocked: false, dirty: false, canSave: false, shouldOfferRetry: false, retryButtonLabel: "Retry native access", canRetry: false,
    onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Supervisor team/);
  assert.match(html, /Saved maximum helpers per root: 6/);
  assert.match(html, /Open root Supervisor in T3/);
  assert.match(html, /t3-thread:\/\/v1\/helper-thread-1/);
  assert.match(html, /Ready/);
  assert.match(html, /Idle/);
  assert.match(html, /Current state:<\/strong> An operational-child guidance delivery is uncertain/);
  assert.doesNotMatch(html, /Available for the next check-in/);
  assert.match(html, /Native run ended interrupted before confirming; nothing was resent/);
  assert.match(html, /Current assignments/);
  assert.match(html, /Test subtree/);
  assert.match(html, /Last assessment: The child tests found a missing case/);
  assert.match(html, /Pending handovers/);
  assert.match(html, /Delivery outcome is still being reconciled/);
  assert.match(html, /Quarantined/);
  assert.match(html, /Delivered; acknowledgment pending/);
  assert.match(html, /Delivery definitely failed; root recovery required/);
  assert.match(html, /the native conversation may still exist or run/);
  assert.match(html, /A required test failed/);
  assert.match(html, /The team snapshot is incomplete/);
  assert.match(html, /Root-to-helper notes and routine check-ins use Supervisor team operations/);
  assert.match(html, /Quarantine revokes a helper’s Supervisor authority/);
  assert.match(html, /Maximum helpers per root/);
  assert.match(html, /0 disables new recruitment/);
  assert.doesNotMatch(html, /memberEpoch|assignmentEpoch/);
  assert.match(html, /Reviewed subtree<\/a> · Root-requested review completed by the helper’s native run; this does not prove its effects were absent, and request fences remain separate · Native run ended interrupted/);
  assert.match(html, /Reviewing subtree<\/a> · Delivered; acknowledgment pending · Native run ended cancelled before confirming; nothing was resent · Root-requested review in progress; the root keeps responsibility/);
  assert.match(html, /Reviewing subtree<\/a> · Root-requested effect review · Delivery in progress<\/li>/);
  assert.doesNotMatch(html, /reviewed by (the )?root/iu);
});

test("invalid team settings expose an associated accessible error", () => {
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
    ...viewDefaults,
    snapshot, selection, monitoring, teamSettings: {maxHelpersPerRoot: "21"}, connected: true,
    saving: false, fieldsBusy: false, blocked: false, dirty: true, canSave: false, shouldOfferRetry: false,
    retryButtonLabel: "Retry native access", canRetry: false, onSelectionChange: () => {}, onMonitoringChange: () => {},
    onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /aria-describedby="supervisor-team-max-helpers-help supervisor-team-max-helpers-error"/);
  assert.match(html, /Enter maximum helpers per root from 0 to 20/);
});

test("invalid monitoring drafts expose associated accessible errors", () => {
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
  ...viewDefaults,
    snapshot, selection, monitoring: {intervalMinutes: "1.5", activityThreshold: "101"}, connected: true,
    saving: false, fieldsBusy: false, blocked: false, dirty: true, canSave: false, shouldOfferRetry: false,
    retryButtonLabel: "Retry native access", canRetry: false, onSelectionChange: () => {}, onMonitoringChange: () => {},
    onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /aria-invalid="true" aria-describedby="supervisor-monitoring-interval-help supervisor-monitoring-interval-error"/);
  assert.match(html, /Enter a whole number for maximum pending activity age in minutes/);
  assert.match(html, /Enter finalized activity threshold from 3 to 100/);
});

test("workflow proposal shows recursive requirements, nested plan groups, fixed omissions and contributors", () => {
  const task: ProjectSupervisorInfo["tasks"][number] = {
    ...snapshot.tasks[0]!,
    workflow: workflow(),
    workflowProposalId: "proposal-draft-12",
  };
  const html = renderTaskView(task);
  assert.match(html, /Workflow proposal/);
  assert.match(html, /Proposal status:<\/strong> Proposed for discussion/);
  assert.match(html, /A plan was prepared from the current project definitions/);
  assert.match(html, /This is a draft for dialogue\. No agreement is recorded for this proposal/);
  assert.match(html, /Proposal ID:<\/strong> <code>proposal-draft-12<\/code>/);
  assert.match(html, /Definition revision:<\/strong> <code>definition-revision-12<\/code>/);
  assert.match(html, /Requirements known:<\/strong> Yes/);
  assert.match(html, /Included recursively within reviewer/);
  assert.match(html, /Parallel group/);
  assert.match(html, /Step: Inspect source/);
  assert.match(html, /Workflow: Reviewer/);
  assert.match(html, /Fixed:<\/strong> Yes/);
  assert.match(html, /Not-applicable original commitments/);
  assert.match(html, /The task does not change a security boundary/);
  assert.match(html, /Step: End-to-end testing/);
  assert.match(html, /Task-local step ID: <code>check-notes<\/code>/);
  assert.match(html, /t3-thread:\/\/v1\/child-one/);
  assert.match(html, /does not prove that work was performed/);
  assert.doesNotMatch(html, /Project rules|Reusable blocks|Rule applicability|Block ID:/);
  assert.doesNotMatch(html, /Accept workflow|Send workflow/i);
});

test("workflow protocol diagnostics explain which complete record needs correction and escape message IDs", () => {
  const supervisorHtml = renderTaskView({...snapshot.tasks[0]!, workflowProtocolDiagnostic: {
    role: "supervisor",
    proposalId: "proposal-current",
    messageId: '<img src=x onerror="alert(1)">',
    code: "record_fields",
    observedAt: 1_800_000_000_200,
  }});
  assert.match(supervisorHtml, /Supervisor’s workflow proposal was not recognized/);
  assert.match(supervisorHtml, /Code:<\/strong> <code>record_fields<\/code>/);
  assert.match(supervisorHtml, /Message ID:<\/strong> <code>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/code>/);
  assert.doesNotMatch(supervisorHtml, /<img src=x onerror/);
  assert.match(supervisorHtml, /does not create or remove a saved agreement or prove execution/);

  const operativeHtml = renderTaskView({...snapshot.tasks[0]!, workflowProtocolDiagnostic: {
    role: "operative",
    proposalId: "proposal-current",
    messageId: "operative-message-9",
    code: "plan_not_formal",
    observedAt: 1_800_000_000_300,
  }});
  assert.match(operativeHtml, /This workflow record is provisional or has unresolved obligations/);
  assert.match(operativeHtml, /continue the dialogue with a complete record/);
  assert.match(operativeHtml, /Message ID:<\/strong> <code>operative-message-9<\/code>/);
});

test("invalid and incomplete definitions keep requirements unknown instead of implying an empty policy", () => {
  const partial = workflow({
    status: "provisional",
    message: "A finite plan can proceed while a workflow cycle is fixed.",
    definitionsStatus: "invalid",
    definitionsComplete: false,
    requirementsKnown: false,
    requirements: [{kind: "workflow", id: "reviewer", name: "Reviewer", source: null, state: "unresolved", reason: "The workflow contains a cycle."}],
    issues: [{path: ".t3-supervisor/workflows/reviewer.yaml", code: "workflow_cycle", message: "Workflow reference cycle: reviewer -> release -> reviewer."}],
    plan: null,
  });
  const html = renderTaskView({...snapshot.tasks[0]!, workflow: partial});
  assert.match(html, /Provisional plan with open issues/);
  assert.match(html, /Read complete:<\/strong> No/);
  assert.match(html, /Requirements known:<\/strong> No/);
  assert.match(html, /Workflow reference cycle: reviewer -&gt; release -&gt; reviewer/);
  assert.match(html, /Unresolved/);
  assert.match(html, /No plan structure is available/);
  assert.doesNotMatch(html, /No required definitions are configured/);
});

test("a pending revised proposal remains separate from its prior agreed plan", () => {
  const prior = workflow({message: "The previous plan was accepted.", workspaceRoot: "/workspace/previous", revision: "definition-revision-11"});
  const task: ProjectSupervisorInfo["tasks"][number] = {
    ...snapshot.tasks[0]!,
    workflow: workflow({status: "pending", message: "The revised workflow is being prepared.", plan: null}),
    workflowProposalId: "proposal-2",
    agreement: agreement({proposalId: "proposal-1", workflow: prior}),
  };
  const html = renderTaskView(task);
  assert.match(html, /Agreed workflow/);
  assert.match(html, /Agreement status:<\/strong> Agreed/);
  assert.match(html, /Inspect source/);
  assert.match(html, /Current workflow draft/);
  assert.match(html, /Proposal status:<\/strong> Being prepared/);
  assert.match(html, /revised workflow is being prepared/);
  assert.match(html, /still being prepared; no agreement is recorded/);
  assert.match(html, /Proposal ID:<\/strong> <code>proposal-2<\/code>/);
  assert.ok(html.indexOf("Agreed workflow") < html.indexOf("Current workflow draft"));
});

test("an active agreement is primary for the matching proposal and escapes all source text", () => {
  const unsafePlan: WorkflowPlanGroupInfo = {kind: "sequence", templatePath: "delivery.yaml/sequence", nodes: [
    {kind: "step", nodeId: "inspect", definitionId: "inspect", localId: null, templatePath: "delivery.yaml/sequence/0", name: "Inspect safely", description: "<img src=x onerror=alert(1)>", source: null, resolution: "resolved", reason: "<script>reason</script>", status: "planned", contributorThreadIds: []},
  ]};
  const unsafeWorkflow = workflow({
    message: "<script>proposal message</script>",
    workspaceRoot: "/workspace/<project>",
    revision: "revision-&-one",
    plan: unsafePlan,
  });
  const task: ProjectSupervisorInfo["tasks"][number] = {
    ...snapshot.tasks[0]!,
    workflow: unsafeWorkflow,
    workflowProposalId: "proposal-<1>",
    agreement: agreement({
      message: "<script>agreement message</script>",
      proposalId: "proposal-<1>",
      supervisorMessageId: "supervisor-<2>",
      agentMessageId: "agent-&-3",
      workflow: unsafeWorkflow,
    }),
  };
  const html = renderTaskView(task);
  assert.match(html, /Agreed workflow/);
  assert.match(html, /Agreement status:<\/strong> Agreed/);
  assert.match(html, /The latest proposal is the agreed workflow shown above/);
  assert.equal((html.match(/Step: Inspect safely/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Current workflow draft/);
  assert.match(html, /Agreement details/);
  assert.match(html, /Proposal ID:<\/strong> <code>proposal-&lt;1&gt;<\/code>/);
  assert.match(html, /dateTime="2027-01-15T08:00:00\.000Z"/);
  assert.match(html, /Workspace root:<\/strong> <code>\/workspace\/&lt;project&gt;<\/code>/);
  assert.match(html, /Definition revision:<\/strong> <code>revision-&amp;-one<\/code>/);
  assert.match(html, /Supervisor message ID:<\/strong> <code>supervisor-&lt;2&gt;<\/code>/);
  assert.match(html, /Agent message ID:<\/strong> <code>agent-&amp;-3<\/code>/);
  assert.match(html, /&lt;script&gt;agreement message&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /does not verify that any steps were completed/);
  assert.doesNotMatch(html, /compliance confirmed|compliant/i);
});

test("a stale agreement remains historical while a newer proposal stays current", () => {
  const task: ProjectSupervisorInfo["tasks"][number] = {
    ...snapshot.tasks[0]!,
    workflow: workflow({message: "A new proposal is ready for discussion."}),
    workflowProposalId: "proposal-2",
    agreement: agreement({status: "stale", message: "The agreed definition revision is out of date."}),
  };
  const html = renderTaskView(task);
  assert.match(html, /Previous agreement \(stale\)/);
  assert.match(html, /Agreement status:<\/strong> Stale/);
  assert.match(html, /retained as history and is not the current agreed workflow/);
  assert.match(html, /Plan in this historical agreement/);
  assert.match(html, /Current workflow draft/);
  assert.match(html, /A new proposal is ready for discussion/);
  assert.doesNotMatch(html, /<h5>Agreed workflow<\/h5>/);
});

test("definition authorization and revert checks stay advisory beside the workflow", () => {
  for (const [status, message, expectedText] of [
    ["checking", "Authorization evidence is being checked.", "Project definitions changed; Supervisor is checking user authorization."],
    ["revert_requested", "The observed change was not authorized.", "Unrequested changes: revert requested."],
  ] as const) {
    const task: ProjectSupervisorInfo["tasks"][number] = {
      ...snapshot.tasks[0]!,
      workflow: workflow({status: "proposed"}),
      definitionReview: definitionReview({status, message}),
    };
    const html = renderTaskView(task);
    const reviewMarkup = html.match(/<section class="stack" aria-labelledby="workflow-definition-review-title">([\s\S]*?)<\/section>/)?.[1];
    assert.ok(reviewMarkup);
    assert.ok(reviewMarkup.includes(expectedText));
    assert.ok(reviewMarkup.includes(message));
    assert.doesNotMatch(reviewMarkup, /<(?:button|input|select|textarea)\b/i);
    assert.match(html, /Current workflow draft/);
  }
});

test("authorized and restored definition reviews expose escaped source details", () => {
  for (const [status, expectedText] of [
    ["authorized", "User-authorized definitions adopted."],
    ["restored", "Approved definitions restored; renegotiation needed."],
  ] as const) {
    const review = definitionReview({
      status,
      message: "<script>review message</script>",
      expectedRevision: "<expected-revision>",
      observedRevision: "observed-&-revision",
      supervisorMessageId: "supervisor-<message>",
      userMessageIds: ["user-<one>", "user-&-two"],
    });
    const html = renderTaskView({...snapshot.tasks[0]!, definitionReview: review});
    assert.ok(html.includes(expectedText));
    assert.match(html, /Definition review details/);
    assert.match(html, /Expected revision:<\/strong> <code>&lt;expected-revision&gt;<\/code>/);
    assert.match(html, /Observed revision:<\/strong> <code>observed-&amp;-revision<\/code>/);
    assert.match(html, /Supervisor message ID:<\/strong> <code>supervisor-&lt;message&gt;<\/code>/);
    assert.match(html, /user-&lt;one&gt;/);
    assert.match(html, /user-&amp;-two/);
    assert.match(html, /dateTime="2027-01-15T08:00:00\.000Z"/);
    assert.match(html, /&lt;script&gt;review message&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>|<code><expected-revision>/);
    assert.doesNotMatch(html, /compliant|compliance confirmed/i);
  }
});

test("unavailable proposals and tasks without a recorded plan preserve uncertainty", () => {
  const unavailable = workflow({status: "unavailable", message: "Definitions were unavailable.", definitionsStatus: "unavailable", definitionsComplete: false, requirementsKnown: false, requirements: [], plan: null});
  const unavailableHtml = renderTaskView({...snapshot.tasks[0]!, workflow: unavailable});
  assert.match(unavailableHtml, /Proposal status:<\/strong> Unavailable/);
  assert.match(unavailableHtml, /No requirement entries are available/);
  assert.match(unavailableHtml, /No plan structure is available/);
  assert.doesNotMatch(unavailableHtml, /No required definitions are configured/);

  const noWorkflowHtml = renderTaskView({...snapshot.tasks[0]!, workflow: null});
  const legacyHtml = renderTaskView(snapshot.tasks[0]!);
  assert.match(noWorkflowHtml, /No workflow proposal was recorded for this task/);
  assert.match(legacyHtml, /No workflow proposal was recorded for this task/);
  assert.doesNotMatch(legacyHtml, /Project definition review/);
});

test("workflow proposal status and message remain visible across every contract state", () => {
  for (const status of ["pending", "proposed", "provisional", "unavailable", "stale", "invalid"] as const) {
    const task: ProjectSupervisorInfo["tasks"][number] = {
      ...snapshot.tasks[0]!,
      workflow: workflow({status, message: `Explanation for ${status}.`}),
    };
    const html = renderTaskView(task);
    assert.match(html, /Proposal status:<\/strong>/);
    assert.match(html, new RegExp(`Explanation for ${status}\\.`));
  }
});

test("unavailable saved models remain visible and disabled while an available model can be selected", () => {
  const unavailable = snapshot.models[1]!;
  const unavailableSelection: SupervisorModelSelection = {instanceId: unavailable.instanceId, model: unavailable.model, options: [{id: "thinking", value: true}]};
  const savedSnapshot = {...snapshot, settings: {...snapshot.settings, modelSelection: unavailableSelection}};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
  ...viewDefaults,
    snapshot: savedSnapshot, selection: unavailableSelection, monitoring, connected: true,
    saving: false, fieldsBusy: false, blocked: false, dirty: false, canSave: false, shouldOfferRetry: false, retryButtonLabel: "Retry native access", canRetry: false,
    onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Project default for new Supervisors:<\/strong> Provider Two · Quick \(quick-model\) — unavailable/);
  assert.match(html, /Quick \(quick-model\) — unavailable/);
  assert.match(html, /disabled=""/);
});

test("an uncertain result from another project thread exposes retry only after the draft is resolved", () => {
  const uncertainTask = {...snapshot.tasks[0]!, threadId: "other-thread", status: "uncertain" as const};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
  ...viewDefaults,
    snapshot: {...snapshot, tasks: [...snapshot.tasks, uncertainTask]}, selection, monitoring, threadId: "task-thread", connected: true,
    saving: false, fieldsBusy: false, blocked: false, dirty: true, canSave: true, shouldOfferRetry: true,
    retryButtonLabel: "Retry native access", canRetry: false, onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {},
    onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Retry native access/);
  assert.match(html, /Save or discard your settings draft before retrying native access/);
  assert.match(html, /<button type="button" disabled="">Retry native access<\/button>/);
  assert.match(html, /Task interpretation for the selected conversation/);
});

test("a deleted binding has a distinct explicit replacement action and no live link to the deleted thread", () => {
  const missingSnapshot = {...snapshot, binding: {...snapshot.binding!, state: "missing" as const}};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
  ...viewDefaults,
    snapshot: missingSnapshot, selection, monitoring, connected: true, saving: false, fieldsBusy: false, blocked: false,
    dirty: false, canSave: false, shouldOfferRetry: true, retryButtonLabel: "Replace deleted Supervisor conversation", canRetry: true,
    onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Deleted Supervisor conversation/);
  assert.match(html, /Replace deleted Supervisor conversation/);
  assert.doesNotMatch(html, /Open in T3/);
});

test("native retries are explicit for pending ready bindings and uncertain project tasks, never for a pre-task pending default", () => {
  assert.equal(shouldOfferNativeRetry(snapshot), false);
  const beforeFirstTask = {...snapshot, binding: null, settings: {...snapshot.settings, pending: true}};
  assert.equal(shouldOfferNativeRetry(beforeFirstTask), false);
  const uncertainTask = {...snapshot.tasks[0]!, threadId: "other-thread", status: "uncertain" as const};
  assert.equal(shouldOfferNativeRetry({...beforeFirstTask, tasks: [uncertainTask]}), true);
});

test("monitoring retry suggestions respect saturation while preserving independent recovery actions", () => {
  const saturationOnly: ProjectSupervisorInfo = {
    ...snapshot,
    settings: {...snapshot.settings, pending: false},
    monitoringStatus: {
      state: "unavailable",
      message: "Monitoring is at capacity.",
      pendingItems: 10,
      nextReviewAt: null,
      lastNoticeAt: null,
      retryable: false,
    },
  };
  const renderRecoveryView = (value: ProjectSupervisorInfo) => renderToStaticMarkup(createElement(ProjectSupervisorView, {
  ...viewDefaults,
    snapshot: value, selection, monitoring, connected: true, saving: false, fieldsBusy: false, blocked: false,
    dirty: false, canSave: false, shouldOfferRetry: shouldOfferNativeRetry(value), retryButtonLabel: "Retry native access", canRetry: false,
    onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));

  assert.equal(shouldOfferNativeRetry(saturationOnly), false);
  const saturationHtml = renderRecoveryView(saturationOnly);
  assert.doesNotMatch(saturationHtml, /Native Supervisor access|Retry native access/);

  const concurrentUncertainTask = {...snapshot.tasks[0]!, threadId: "other-thread", status: "uncertain" as const};
  const taskRecovery = {...saturationOnly, tasks: [...saturationOnly.tasks, concurrentUncertainTask]};
  assert.equal(shouldOfferNativeRetry(taskRecovery), true);
  assert.match(renderRecoveryView(taskRecovery), /Retry native access/);

  const bindingRecovery = {...saturationOnly, binding: {...saturationOnly.binding!, state: "uncertain" as const}};
  assert.equal(shouldOfferNativeRetry(bindingRecovery), true);
  assert.match(renderRecoveryView(bindingRecovery), /Retry native access/);

  const legacyMonitoringFailure = {...saturationOnly, monitoringStatus: {
    state: "uncertain" as const,
    message: "The monitoring review is uncertain.",
    pendingItems: 1,
    nextReviewAt: null,
    lastNoticeAt: null,
  }};
  assert.equal(shouldOfferNativeRetry(legacyMonitoringFailure), true);
});

test("project task recovery remains visible but disabled until a bound conversation exists", () => {
  const unboundSnapshot = {...snapshot, binding: null};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
  ...viewDefaults,
    snapshot: unboundSnapshot, selection, monitoring, connected: true, saving: false, fieldsBusy: false, blocked: false,
    dirty: false, canSave: false, shouldOfferRetry: true, retryButtonLabel: "Retry native access", canRetry: false,
    onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /No bound Supervisor conversation is available to retry yet/);
  assert.match(html, /<button type="button" disabled="">Retry native access<\/button>/);
});

test("Supervisor client encodes project targets, checks response identity and passes GET cancellation", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    let seen = "";
    globalThis.fetch = async (inputValue, init) => {
      seen = String(inputValue);
      assert.equal(init?.signal, controller.signal);
      assert.equal(init?.credentials, "omit");
      return new Response(JSON.stringify({...snapshot, projectId: "project & one"}), {status: 200});
    };
    const loaded = await loadProjectSupervisor("project & one", controller.signal, "task-thread");
    assert.equal(loaded.projectId, "project & one");
    assert.equal(new URL(seen, "http://localhost").searchParams.get("projectId"), "project & one");

    globalThis.fetch = async () => new Response(JSON.stringify({...snapshot, projectId: "another-project"}), {status: 200});
    await assert.rejects(loadProjectSupervisor("project", controller.signal, "task-thread"), /another project/);
  } finally {globalThis.fetch = original;}
});

test("a late GET cannot cross an aborted selection", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let resolveResponse: ((response: Response) => void) | undefined;
  try {
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      return await new Promise<Response>(resolve => {resolveResponse = resolve;});
    };
    const pending = loadProjectSupervisor("project", controller.signal, "task-thread");
    assert.ok(resolveResponse);
    controller.abort();
    resolveResponse!(new Response(JSON.stringify(snapshot), {status: 200}));
    await assert.rejects(pending, /another project/);
  } finally {globalThis.fetch = original;}
});

test("a save response for another project is treated as an unknown outcome", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "omit");
      return new Response(JSON.stringify({status: "saved", message: "Saved", snapshot: {...snapshot, projectId: "another-project"}}), {status: 200});
    };
    await assert.rejects(saveProjectSupervisor(input, "token"), (error: unknown) => error instanceof ProjectSupervisorRequestError && !error.definitelyNotSaved);
  } finally {globalThis.fetch = original;}
});

test("Supervisor settings saves send live monitoring values with the model selection", async () => {
  const original = globalThis.fetch;
  const monitoredInput: ProjectSupervisorSaveInput = {
    ...input,
    monitoring: {intervalMinutes: 12, activityThreshold: 35},
  };
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "/api/guidance/project-supervisor");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), monitoredInput);
      return new Response(JSON.stringify({status: "saved", message: "Settings saved.", snapshot}), {status: 200});
    };
    assert.equal((await saveProjectSupervisor(monitoredInput, "token")).status, "saved");
  } finally {globalThis.fetch = original;}
});

test("native access retry uses its dedicated route and blocks a foreign-project response", async () => {
  const original = globalThis.fetch;
  const retryInput: ProjectSupervisorRetryInput = {projectId: "project", mainThreadId: "task-thread", expectedGeneration: 7, threadId: "bound-thread", bindingGeneration: 3, action: "retry"};
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "/api/guidance/project-supervisor/retry");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), retryInput);
      return new Response(JSON.stringify({status: "uncertain", message: "Retry needs refresh.", snapshot: {...snapshot, projectId: "another-project"}}), {status: 200});
    };
    await assert.rejects(retryProjectSupervisor(retryInput, "token"), (error: unknown) => error instanceof ProjectSupervisorRequestError && !error.definitelyNotSaved);
  } finally {globalThis.fetch = original;}
});

test("deleted-conversation recovery sends an explicit replacement action and binding identity", async () => {
  const original = globalThis.fetch;
  const replaceInput: ProjectSupervisorRetryInput = {projectId: "project", mainThreadId: "task-thread", expectedGeneration: 7, threadId: "deleted-thread", bindingGeneration: 4, action: "replace"};
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "/api/guidance/project-supervisor/retry");
      assert.deepEqual(JSON.parse(String(init?.body)), replaceInput);
      return new Response(JSON.stringify({status: "saved", message: "Replaced explicitly.", snapshot}), {status: 200});
    };
    assert.equal((await retryProjectSupervisor(replaceInput, "token")).status, "saved");
  } finally {globalThis.fetch = original;}
});

test("a retry 403 refreshes the latest CSRF token without automatically repeating the native request", async () => {
  const original = globalThis.fetch;
  const retryInput: ProjectSupervisorRetryInput = {projectId: "project", mainThreadId: "task-thread", expectedGeneration: 7, threadId: "bound-thread", bindingGeneration: 3, action: "retry"};
  let csrfReads = 0;
  let retryWrites = 0;
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url) === "/api/csrf") {
        csrfReads++;
        return new Response(JSON.stringify({csrf: csrfReads === 1 ? "retry-first-token" : "retry-current-token"}), {status: 200});
      }
      retryWrites++;
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-csrf-token"], retryWrites === 1 ? "retry-first-token" : "retry-current-token");
      if (retryWrites === 1) return new Response("{}", {status: 403});
      return new Response(JSON.stringify({status: "saved", message: "Retry accepted.", snapshot}), {status: 200});
    };

    const {loadAccess} = await import("../ui/src/access.js");
    assert.equal(await loadAccess(), true);
    await assert.rejects(retryProjectSupervisor(retryInput, "old-prop-token"), (error: unknown) => error instanceof ProjectSupervisorRequestError && error.definitelyNotSaved);
    assert.equal(retryWrites, 1);
    assert.equal(csrfReads, 2);
    assert.equal((await retryProjectSupervisor(retryInput, "old-prop-token")).status, "saved");
    assert.equal(retryWrites, 2);
    assert.equal(csrfReads, 2);
  } finally {globalThis.fetch = original;}
});

test("a 403 refreshes CSRF without retrying the POST and the next explicit save uses the latest token", async () => {
  const original = globalThis.fetch;
  let csrfReads = 0;
  let writes = 0;
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url) === "/api/csrf") {
        csrfReads++;
        return new Response(JSON.stringify({csrf: csrfReads === 1 ? "first-session" : "rotated-session"}), {status: 200});
      }
      writes++;
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-csrf-token"], writes === 1 ? "first-session" : "rotated-session");
      if (writes === 1) return new Response("{}", {status: 403});
      return new Response(JSON.stringify({status: "saved", message: "Saved", snapshot}), {status: 200});
    };

    const {loadAccess} = await import("../ui/src/access.js");
    assert.equal(await loadAccess(), true);
    await assert.rejects(saveProjectSupervisor(input, "stale-prop-token"), (error: unknown) =>
      error instanceof ProjectSupervisorRequestError && error.definitelyNotSaved && /Session refreshed/.test(error.message));
    assert.equal(writes, 1);
    assert.equal(csrfReads, 2);

    assert.equal((await saveProjectSupervisor(input, "stale-prop-token")).status, "saved");
    assert.equal(writes, 2);
    assert.equal(csrfReads, 2);
  } finally {globalThis.fetch = original;}
});

test("unconfirmed HTTP mutation outcomes are marked unsafe to retry without refresh", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("{}", {status: 500});
    await assert.rejects(saveProjectSupervisor(input, "token"), (error: unknown) => error instanceof ProjectSupervisorRequestError && !error.definitelyNotSaved);
  } finally {globalThis.fetch = original;}
});

test("a response for another main in the same project is rejected by the client", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(snapshot), {status: 200});
    await assert.rejects(loadProjectSupervisor("project", AbortSignal.timeout(1000), "another-main"), /another project/);
    globalThis.fetch = async () => new Response(JSON.stringify({status: "saved", message: "Read back", snapshot}), {status: 200});
    const input: ProjectSupervisorRetryInput = {projectId: "project", mainThreadId: "another-main", expectedGeneration: 7, threadId: snapshot.binding!.threadId, bindingGeneration: 7, action: "retry"};
    await assert.rejects(retryProjectSupervisor(input, "csrf"), /another project/);
  } finally {globalThis.fetch = original;}
});

test("team and coverage APIs reject mismatched roots and off-scope assignments", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      ...snapshot,
      team: {
        status: "ok", message: null, observedAt: 1,
        root: {threadId: "another-root", title: null, model: null, readiness: "unknown", lifecycle: "unknown", currentState: null, lastAssessment: null},
        members: [], issues: [],
      },
    }), {status: 200});
    await assert.rejects(loadProjectSupervisor("project", AbortSignal.timeout(1000), "task-thread"), /another root conversation/);

    globalThis.fetch = async () => new Response(JSON.stringify({...snapshot, settings: {...snapshot.settings, teamSettings: {maxHelpersPerRoot: 21}}}), {status: 200});
    await assert.rejects(loadProjectSupervisor("project", AbortSignal.timeout(1000), "task-thread"), /outside the supported range/);

    globalThis.fetch = async () => new Response(JSON.stringify({...progressSnapshot, coverage: [
      {threadId: "foreign-child", state: "assigned", assigneeThreadId: "helper", assigneeTitle: "Helper", assignmentRootThreadId: "foreign-child"},
    ]}), {status: 200});
    await assert.rejects(loadWorkflowProgress("project", "task-thread", AbortSignal.timeout(1000)), /does not match its native scope page/);
  } finally {globalThis.fetch = original;}
});

test("project defaults without a selection expose no conversation readback or retry", () => {
  const defaults = {...snapshot, mainThreadId: null, binding: null, modelSelection: null, modelApplication: null, tasks: [], settings: {...snapshot.settings, pending: false}};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
  ...viewDefaults,
    snapshot: defaults, selection, monitoring, connected: true, saving: false, fieldsBusy: false, blocked: false,
    dirty: false, canSave: false, shouldOfferRetry: shouldOfferNativeRetry(defaults), retryButtonLabel: "Retry native access", canRetry: false,
    onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Project default for new Supervisors/);assert.doesNotMatch(html, /Selected Supervisor model in T3|Open in T3|Retry native access/);
});


test("an expired dashboard session is a definite rejection and never repeats the mutation", async () => {
  const original = globalThis.fetch;
  let writes = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "POST") writes++;
      return new Response("{}", {status: 401});
    };
    await assert.rejects(saveProjectSupervisor(input, "token"), (error: unknown) => error instanceof ProjectSupervisorRequestError && error.definitelyNotSaved);
    assert.equal(writes, 1);
  } finally {globalThis.fetch = original;}
});

test("live progress separates the current workflow from agreement history and preserves child uncertainty", () => {
  const html = renderToStaticMarkup(createElement(WorkflowProgressPanel, {
    mainThreadId: "task-thread",
    connected: true,
    progress: {key: "progress-key", pages: [progressSnapshot], loading: false, error: null},
    onRefresh: () => {},
    onLoadMore: () => {},
  }));
  assert.match(html, /Live workflow progress/);
  assert.match(html, /Current Supervisor workflow state, kept separate from proposals and saved agreements/);
  assert.match(html, />Underway<\/span>/);
  assert.doesNotMatch(html, /native driver.*verified|workflow updates.*verified/i);
  assert.match(html, /Native child/);
  assert.match(html, /<strong>Native child<\/strong><span class="pill amber">Failed<\/span>/);
  assert.match(html, /<strong>Delegated child<\/strong><span class="pill amber">Cancelled<\/span>/);
  assert.match(html, /<h5>Main workflow<\/h5><span class="pill blue">Underway<\/span>/);
  assert.match(html, /Lifecycle: Unknown/);
  assert.match(html, /idle thread mirror alone does not establish that its work is finished/);
  assert.match(html, /No workflow document is recorded for this conversation/);
  assert.match(html, /Contributes to parent steps/);
  assert.match(html, /Review the integration/);
  assert.match(html, /The Supervisor observed the linked test output/);
  assert.match(html, /t3-thread:\/\/v1\/child-one/);
  assert.match(html, /child-item/);
  assert.match(html, /Parent steps do not complete automatically when a child finishes/);
  assert.doesNotMatch(html, /Agreement status|Agreement context|accepted-key/);
  assert.doesNotMatch(html, /accept workflow|send workflow/i);
});

test("operational rows distinguish root, helper, observe-only, transfer, unknown and missing assignment data", () => {
  const withCoverage: WorkflowProgressSnapshot = {
    ...progressSnapshot,
    coverage: [
      {threadId: "task-thread", state: "root", assigneeThreadId: null, assigneeTitle: null, assignmentRootThreadId: null},
      {threadId: "child-one", state: "assigned", assigneeThreadId: "helper-thread-1", assigneeTitle: "Testing helper", assignmentRootThreadId: "child-one"},
      {threadId: "child-two", state: "transfer", assigneeThreadId: null, assigneeTitle: null, assignmentRootThreadId: "child-two"},
      {threadId: "failed-native", state: "observe_only", assigneeThreadId: "supervisor-thread", assigneeTitle: "Root Supervisor", assignmentRootThreadId: "failed-native"},
      {threadId: "cancelled-delegated", state: "unknown", assigneeThreadId: null, assigneeTitle: null, assignmentRootThreadId: null},
    ],
  };
  const html = renderToStaticMarkup(createElement(WorkflowProgressPanel, {
    mainThreadId: "task-thread", connected: true,
    progress: {key: "progress-key", pages: [withCoverage], loading: false, error: null},
    onRefresh: () => {}, onLoadMore: () => {},
  }));
  assert.match(html, /Assigned to:<\/strong> Supervisor root \(unassigned operational work\)/);
  assert.match(html, /href="t3-thread:\/\/v1\/helper-thread-1">Testing helper<\/a>/);
  assert.match(html, /Assigned to:<\/strong> Handover in progress/);
  assert.match(html, /href="t3-thread:\/\/v1\/supervisor-thread">Root Supervisor<\/a> · observe-only while unresolved effects block writes/);
  assert.match(html, /Assigned to:<\/strong> Unknown; the current owner could not be confirmed/);
  assert.match(html, /Assigned to:<\/strong> Not reported in this snapshot/);
});

test("workflow progress API pages are scoped to the requested project, main, and independent offsets", async () => {
  const original = globalThis.fetch;
  const page = {...progressSnapshot, workflowOffset: 10, lineageOffset: 20};
  let requested = "";
  try {
    globalThis.fetch = async (url, init) => {
      requested = String(url);
      assert.equal(init?.method, undefined);
      assert.equal(init?.credentials, "omit");
      assert.ok(init?.signal);
      return new Response(JSON.stringify(page), {status: 200});
    };
    const loaded = await loadWorkflowProgress("project", "task-thread", AbortSignal.timeout(1000), {
      workflowOffset: 10,
      lineageOffset: 20,
      limit: 50,
      expectedBinding: {threadId: "supervisor-thread", generation: 4},
    });
    const url = new URL(requested, "http://localhost");
    assert.equal(url.pathname, "/api/guidance/workflow-progress");
    assert.equal(url.searchParams.get("projectId"), "project");
    assert.equal(url.searchParams.get("mainThreadId"), "task-thread");
    assert.equal(url.searchParams.get("workflowOffset"), "10");
    assert.equal(url.searchParams.get("lineageOffset"), "20");
    assert.equal(url.searchParams.get("limit"), "50");
    assert.equal(url.searchParams.has("bindingGeneration"), false);
    assert.equal(loaded.workflowOffset, 10);
    assert.equal(loaded.lineageOffset, 20);

    globalThis.fetch = async () => new Response(JSON.stringify({...page, mainThreadId: "another-main"}), {status: 200});
    await assert.rejects(loadWorkflowProgress("project", "task-thread", AbortSignal.timeout(1000), {
      workflowOffset: 10,
      lineageOffset: 20,
      limit: 50,
      expectedBinding: {threadId: "supervisor-thread", generation: 4},
    }), /another selection or page/);
    globalThis.fetch = async () => new Response(JSON.stringify({...page, scope: {...page.scope!, bindingGeneration: 9}}), {status: 200});
    await assert.rejects(loadWorkflowProgress("project", "task-thread", AbortSignal.timeout(1000), {
      workflowOffset: 10,
      lineageOffset: 20,
      limit: 50,
      expectedBinding: {threadId: "supervisor-thread", generation: 4},
    }), /another Supervisor binding/);
  } finally {globalThis.fetch = original;}
});

test("workflow progress refresh keeps every loaded page and fetches them sequentially", async () => {
  const original = globalThis.fetch;
  const requests = [
    {workflowOffset: 0, lineageOffset: 0, limit: 20, expectedBinding: {threadId: "supervisor-thread", generation: 4}},
    {workflowOffset: 20, lineageOffset: 20, limit: 20, expectedBinding: {threadId: "supervisor-thread", generation: 4}},
    {workflowOffset: 40, lineageOffset: 40, limit: 20, expectedBinding: {threadId: "supervisor-thread", generation: 4}},
  ];
  const order: Array<[number, number]> = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  try {
    globalThis.fetch = async url => {
      const parsed = new URL(String(url), "http://localhost");
      const workflowOffset = Number(parsed.searchParams.get("workflowOffset"));
      const lineageOffset = Number(parsed.searchParams.get("lineageOffset"));
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 2));
      order.push([workflowOffset, lineageOffset]);
      inFlight--;
      return new Response(JSON.stringify({...progressSnapshot, workflowOffset, lineageOffset}), {status: 200});
    };
    const pages = await refreshWorkflowProgressPages("project", "task-thread", AbortSignal.timeout(1000), requests);
    assert.equal(pages.length, 3);
    assert.deepEqual(order, [[0, 0], [20, 20], [40, 40]]);
    assert.equal(maximumInFlight, 1);
    assert.deepEqual(pages.map(page => [page.workflowOffset, page.lineageOffset]), [[0, 0], [20, 20], [40, 40]]);
  } finally {globalThis.fetch = original;}
});


test("Plan retains unavailable diagnostics without claiming unreadable records are absent", () => {
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
    ...viewDefaults, section: "plan", snapshot: {...snapshot, available: false, tasks: [], message: "Unsupported retained scope state."}, selection, monitoring,
    threadId: "task-thread", connected: true, saving: false, fieldsBusy: false, blocked: false, dirty: false, canSave: false,
    shouldOfferRetry: false, retryButtonLabel: "Retry native access", canRetry: false,
    onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Supervisor state is unavailable/);
  assert.match(html, /Unsupported retained scope state/);
  assert.match(html, /Their absence has not been established/);
  assert.doesNotMatch(html, /No task interpretation or plan has been recorded/);
});

test("blocked supervision is visible beside Progress and Plan even when the native conversation is ready", () => {
  for (const section of ["progress", "plan"] as const) {
    const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
      ...viewDefaults, section, snapshot: {...snapshot, monitoringStatus: {state: "unavailable", pendingItems: 0, nextReviewAt: null,
        lastNoticeAt: null, retryable: true, message: "Complete supervision context exceeds its limit; <no sources were truncated>."}}, selection, monitoring,
      threadId: "task-thread", connected: true, saving: false, fieldsBusy: false, blocked: false, dirty: false, canSave: false,
      shouldOfferRetry: true, retryButtonLabel: "Retry native access", canRetry: true,
      onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
    }));
    assert.match(html, /<p class="panel" role="alert"><strong>Supervision is blocked\.<\/strong>/u);
    assert.match(html, /exceeds its limit; &lt;no sources were truncated&gt;/u);
    assert.match(html, /<div class="panel stack"><h3>Native Supervisor access/u, "recovery stays visible in both task views");
  }
});

test("external contributions render read-only per node with text labels, escaped text and no unsafe links", () => {
  const contribution = (overrides: Partial<WorkflowProgressSnapshot["workflows"][number]["contributions"][number]>) => ({
    contributionId: "external", nodeId: "step-inspect", nodeName: "Inspect source", inCurrentPlan: true, state: "awaiting_result" as const, revision: 1,
    summary: "", references: [], externalRef: null, sourceThreadId: "task-thread", sourceMessageId: "main-message", recordedAt: 1_800_000_000_100,
    assessment: null, ...overrides});
  const contributions = [
    contribution({contributionId: "awaiting", summary: "<script>alert(1)</script>",
      references: [{kind: "url", value: "javascript:alert(1)"}, {kind: "url", value: "data:text/html,<b>x</b>"}, {kind: "url", value: "https://reports.example/42"}],
      externalRef: "<img src=x onerror=alert(1)>"}),
    contribution({contributionId: "received", nodeId: "step-e2e", nodeName: "End-to-end testing", state: "result", revision: 2, summary: "Tests passed elsewhere."}),
    contribution({contributionId: "accepted", nodeId: "step-local", nodeName: "Check migration notes", state: "result", revision: 2,
      assessment: {decision: "accepted", resultRevision: 2, note: "The notes satisfy the step.", recordedAt: 1_800_000_000_110}}),
    contribution({contributionId: "needs-more", nodeId: "workflow-reviewer", nodeName: "Reviewer", state: "result", revision: 3,
      assessment: {decision: "needs_more", resultRevision: 3, note: "Attach the reviewer findings.", recordedAt: 1_800_000_000_120}}),
    contribution({contributionId: "withdrawn", nodeId: "step-local", nodeName: "Check migration notes", state: "withdrawn", revision: 2}),
    contribution({contributionId: "former", nodeId: "step-gone", nodeName: "Former step", inCurrentPlan: false, state: "result", revision: 1}),
  ];
  const render = (withContributions: boolean) => renderToStaticMarkup(createElement(WorkflowProgressPanel, {
    mainThreadId: "task-thread", connected: true,
    progress: {key: "progress-key", pages: [{...progressSnapshot, workflows: progressSnapshot.workflows.map(item =>
      item.workflowId === "main-workflow" && withContributions ? {...item, contributions} : item)}], loading: false, error: null},
    onRefresh: () => {}, onLoadMore: () => {},
  }));
  const html = render(true);
  const baseline = render(false);
  for (const label of ["Awaiting external result", "External result received – awaiting assessment", "External result accepted", "Further work requested",
    "External contribution withdrawn", "No longer in the current plan", "External contributions for steps no longer in the plan", "Former step"])
    assert.ok(html.includes(label), label);
  assert.match(html, /<strong>External contributions<\/strong><ul class="stack"><li class="workflow-progress-observation">/);
  assert.match(html, /Attach the reviewer findings\./);
  assert.match(html, /The external work itself was not observed/);
  assert.match(html, /an accepted result does not complete the step/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<code>&lt;img src=x onerror=alert\(1\)&gt;<\/code>/);
  assert.doesNotMatch(html, /<script>|<img src=x|<b>x<\/b>/);
  assert.doesNotMatch(html, /href="(?:javascript|data|https?):/i);
  assert.match(html, /URL: <code>https:\/\/reports\.example\/42<\/code>/);
  assert.match(html, /href="t3-thread:\/\/v1\/task-thread">Open conversation task-thread<\/a> · Message <code>main-message<\/code>/);
  for (const control of [/<input/g, /<button/g, /<form/g, /<textarea/g, /<select/g, /role="status"/g, /role="alert"/g, /aria-live/g])
    assert.equal(html.match(control)?.length ?? 0, baseline.match(control)?.length ?? 0, `no new ${control.source}`);
});

test("an external contribution diagnostic explains the record without implying a status change", () => {
  const html = renderTaskView({...snapshot.tasks[0]!, workflowProtocolDiagnostic: {
    role: "operative", proposalId: null, messageId: "<b>main-message</b>", code: "contribution_revision_gap", observedAt: 1_800_000_000_400,
  }});
  assert.match(html, /External contribution record needs follow-up/);
  assert.match(html, /next revision for an existing step of the current main workflow/);
  assert.match(html, /does not change any recorded contribution, assessment or step status/);
  assert.match(html, /Code:<\/strong> <code>contribution_revision_gap<\/code>/);
  assert.match(html, /<code>&lt;b&gt;main-message&lt;\/b&gt;<\/code>/);
  assert.doesNotMatch(html, /workflow acceptance was not recognized/);
});

test("the selected chat shows its saved supervision state with one native Stop supervision or Enable supervision button", () => {
  const render = (stopped: boolean, busy = false, message: string | null = null) => renderToStaticMarkup(createElement(ProjectSupervisorView, {
    ...viewDefaults, section: "progress", snapshot: {...snapshot, chatSupervision: {stopped, policyGeneration: 4, stoppedBy: stopped ? "relay" : null, stoppedAt: stopped ? 1 : null}},
    selection, monitoring, threadId: "task-thread", connected: true, saving: false, fieldsBusy: false, blocked: false, dirty: false, canSave: false,
    shouldOfferRetry: false, retryButtonLabel: "Retry native access", canRetry: false, chatSupervisionBusy: busy, chatSupervisionMessage: message,
    onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  const on = render(false);
  assert.match(on, /Allowed for this chat; project\/global settings still apply\./u, "an allowed chat is not described as supervised while project or global settings may disable it");
  assert.match(on, /<button type="button">Stop supervision<\/button>/u);
  assert.equal(on.match(/role="status"/gu)?.length ?? 0, 1, "one status region reports the saved result or error");
  const stopped = render(true, false, "Supervision is stopped for this chat.");
  assert.match(stopped, /Supervision is stopped for this chat \(asked in this chat\)/u);
  assert.match(stopped, /<button type="button">Enable supervision<\/button>/u);
  assert.match(stopped, /<p role="status">Supervision is stopped for this chat\.<\/p>/u);
  assert.match(render(true, true), /<button type="button" disabled="" aria-busy="true">Saving…<\/button>/u, "a pending change cannot be submitted twice");
  const locked = renderToStaticMarkup(createElement(ProjectSupervisorView, {
    ...viewDefaults, section: "progress", snapshot: {...snapshot, chatSupervision: {stopped: false, policyGeneration: 4, stoppedBy: null, stoppedAt: null}},
    selection, monitoring, threadId: "task-thread", connected: true, saving: false, fieldsBusy: false, blocked: false, dirty: false, canSave: false,
    shouldOfferRetry: false, retryButtonLabel: "Retry native access", canRetry: false, chatSupervisionLocked: true,
    onSelectionChange: () => {}, onMonitoringChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(locked, /<button type="button" disabled="">Stop supervision<\/button>/u, "another chat's pending change keeps this chat's button disabled without claiming it is saving");
});

test("a late chat-supervision response never replaces the view of a chat selected afterwards", async () => {
  const deferred = <T,>() => {let resolve!: (value: T) => void;let reject!: (error: unknown) => void;
    const promise = new Promise<T>((ok, fail) => {resolve = ok;reject = fail;});return {promise, resolve, reject};};
  const saved = {...snapshot, chatSupervision: {stopped: true, policyGeneration: 5, stoppedBy: "ui" as const, stoppedAt: 1}};
  let selected = "A";
  const startedFor = (scope: string) => () => selected === scope;

  const lateSuccess = deferred<{snapshot?: typeof saved | null; message: string}>();let reloads = 0;
  const pendingSuccess = confirmChatSupervisionChange(() => lateSuccess.promise, async () => {reloads++;return saved;}, startedFor("A"));
  selected = "B";lateSuccess.resolve({snapshot: saved, message: "Supervision is stopped for this chat."});
  assert.equal(await pendingSuccess, null, "a response that arrives after switching chats is dropped");

  selected = "A";
  const lateReload = deferred<typeof saved>();
  const pendingReload = confirmChatSupervisionChange(async () => ({message: "Saved."}), () => lateReload.promise, startedFor("A"));
  await Promise.resolve();selected = "B";lateReload.resolve(saved);
  assert.equal(await pendingReload, null, "a confirming reload that completes after switching chats is dropped");

  selected = "A";
  const lateFailure = deferred<{message: string}>();
  const pendingFailure = confirmChatSupervisionChange(() => lateFailure.promise, async () => {reloads++;return saved;}, startedFor("A"));
  selected = "B";lateFailure.reject(new Error("lost response"));
  assert.equal(await pendingFailure, null, "an unknown outcome after switching chats changes nothing");
  assert.equal(reloads, 0, "no stale reload is started for a chat that is no longer selected");

  selected = "A";
  assert.deepEqual(await confirmChatSupervisionChange(async () => ({snapshot: saved, message: "Stopped."}), async () => saved, startedFor("A")),
    {snapshot: saved, message: "Stopped."});
  assert.deepEqual(await confirmChatSupervisionChange(async () => {throw new Error("conflict");}, async () => saved, startedFor("A")),
    {snapshot: saved, message: "The change could not be confirmed. The saved state is shown."}, "an unknown outcome shows the server-confirmed state");
  assert.deepEqual(await confirmChatSupervisionChange(async () => {throw new Error("lost");}, async () => {throw new Error("down");}, startedFor("A")),
    {snapshot: null, message: "The change could not be confirmed and the saved state could not be read. Refresh Supervisor status."});
});
