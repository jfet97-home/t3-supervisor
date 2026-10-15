import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultMonitoringSettings, ProjectSupervisorSave, ProjectSupervisorSnapshot, type DefinitionReviewInfo, type ProjectSupervisorInfo, type ProjectSupervisorRetryInput, type ProjectSupervisorSaveInput, type SupervisorModelSelection, type WorkflowAgreementInfo, type WorkflowProposalInfo } from "../src/project-supervisor-contract.js";
import { ProjectSupervisorView, shouldOfferNativeRetry } from "../ui/src/project-supervisor.js";
import { loadProjectSupervisor, ProjectSupervisorRequestError, retryProjectSupervisor, saveProjectSupervisor } from "../ui/src/project-supervisor-api.js";

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
const workflow = (overrides: Partial<WorkflowProposalInfo> = {}): WorkflowProposalInfo => ({
  status: "proposed",
  message: "A workflow was drafted from the current project rules.",
  workspaceRoot: "/workspace/project",
  revision: "rules-revision-12",
  rules: [{index: 0, name: "Project setup", applies: true, reason: "This task changes project code."}],
  steps: [{blockId: "inspect-source", name: "Inspect source", reason: "Review the existing implementation."}],
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
  expectedRevision: "rules-revision-12",
  observedRevision: null,
  supervisorMessageId: null,
  userMessageIds: [],
  updatedAt: 1_800_000_000_000,
  ...overrides,
});

const renderTaskView = (task: ProjectSupervisorInfo["tasks"][number]) => renderToStaticMarkup(createElement(ProjectSupervisorView, {
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
  const decodedSnapshot = Schema.decodeUnknownSync(ProjectSupervisorSnapshot)(snapshot);
  const decodedInput = Schema.decodeUnknownSync(ProjectSupervisorSave)(input);
  assert.equal(decodedSnapshot.settings.monitoring, undefined);
  assert.equal(decodedInput.monitoring, undefined);
  assert.equal(decodedSnapshot.tasks[0]?.definitionReview, undefined);
});

test("invalid monitoring drafts expose associated accessible errors", () => {
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
    snapshot, selection, monitoring: {intervalMinutes: "1.5", activityThreshold: "101"}, connected: true,
    saving: false, fieldsBusy: false, blocked: false, dirty: true, canSave: false, shouldOfferRetry: false,
    retryButtonLabel: "Retry native access", canRetry: false, onSelectionChange: () => {}, onMonitoringChange: () => {},
    onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /aria-invalid="true" aria-describedby="supervisor-monitoring-interval-help supervisor-monitoring-interval-error"/);
  assert.match(html, /Enter a whole number for maximum pending activity age in minutes/);
  assert.match(html, /Enter finalized activity threshold from 3 to 100/);
});

test("workflow proposal shows ordered rule decisions, workspace provenance and unapplied draft steps", () => {
  const task: ProjectSupervisorInfo["tasks"][number] = {
    ...snapshot.tasks[0]!,
    workflow: {
      status: "proposed",
      message: "A workflow was drafted from the current project rules.",
      workspaceRoot: "/workspace/project",
      revision: "rules-revision-12",
      rules: [
        {index: 4, name: "Verification", applies: false, reason: "The task does not request a release."},
        {index: 0, name: "Project setup", applies: true, reason: "This task changes project code."},
      ],
      steps: [
        {blockId: "inspect-source", name: "Inspect source", reason: "Review the existing implementation."},
        {blockId: null, name: "Resolve a task-specific issue", reason: "Handle the detail unique to this request."},
        {blockId: "validate-change", name: "Validate the change", reason: "<script>proposal only</script>"},
      ],
    },
    workflowProposalId: "proposal-draft-12",
  };
  const html = renderTaskView(task);
  assert.match(html, /Workflow proposal/);
  assert.match(html, /Draft status:<\/strong> proposed/);
  assert.match(html, /A workflow was drafted from the current project rules/);
  assert.match(html, /This is a draft\. No agreement is recorded for this proposal/);
  assert.match(html, /Proposal ID:<\/strong> <code>proposal-draft-12<\/code>/);
  assert.match(html, /Workspace root:<\/strong> <code>\/workspace\/project<\/code>/);
  assert.match(html, /Rules revision:<\/strong> <code>rules-revision-12<\/code>/);
  assert.ok(html.indexOf("Project setup") < html.indexOf("Verification"));
  assert.match(html, /Decision:<\/strong> Applies/);
  assert.match(html, /Decision:<\/strong> Does not apply/);
  assert.ok(html.indexOf("Inspect source") < html.indexOf("Resolve a task-specific issue"));
  assert.ok(html.indexOf("Resolve a task-specific issue") < html.indexOf("Validate the change"));
  assert.match(html, /Task-specific step/);
  assert.match(html, /Handle the detail unique to this request/);
  assert.match(html, /Block ID:<\/strong> <code>validate-change<\/code>/);
  assert.doesNotMatch(html, /Block ID:<\/strong> <code>null<\/code>/);
  assert.match(html, /&lt;script&gt;proposal only&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>proposal only<\/script>/);
  assert.doesNotMatch(html, /Accept workflow|Send workflow/i);
});

test("all task-specific workflow steps show their names and reasons without project block IDs", () => {
  const task: ProjectSupervisorInfo["tasks"][number] = {
    ...snapshot.tasks[0]!,
    workflow: workflow({steps: [
      {blockId: null, name: "Collect missing context", reason: "Ask for the deployment target."},
      {blockId: null, name: "Summarize the decision", reason: "Record the agreed outcome."},
    ]}),
  };
  const html = renderTaskView(task);
  assert.match(html, /Step 1: Collect missing context/);
  assert.match(html, /Ask for the deployment target/);
  assert.match(html, /Step 2: Summarize the decision/);
  assert.match(html, /Record the agreed outcome/);
  assert.equal((html.match(/Task-specific step/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Block ID:/);
  assert.doesNotMatch(html, /\[null\]/);
});

test("a pending revised draft remains separate from the prior agreed workflow", () => {
  const prior = workflow({
    message: "The previous plan was accepted.",
    workspaceRoot: "/workspace/previous",
    revision: "rules-revision-11",
    steps: [{blockId: "release-check", name: "Check the release", reason: "Use the earlier agreed block."}],
  });
  const task: ProjectSupervisorInfo["tasks"][number] = {
    ...snapshot.tasks[0]!,
    workflow: workflow({status: "pending", message: "The revised workflow is being prepared.", steps: []}),
    workflowProposalId: "proposal-2",
    agreement: agreement({proposalId: "proposal-1", workflow: prior}),
  };
  const html = renderTaskView(task);
  assert.match(html, /Agreed workflow/);
  assert.match(html, /Agreement status:<\/strong> Agreed/);
  assert.match(html, /Check the release/);
  assert.match(html, /Current workflow draft/);
  assert.match(html, /Draft status:<\/strong> pending/);
  assert.match(html, /revised workflow is being prepared/);
  assert.match(html, /This proposal is still being prepared; no agreement is recorded for it/);
  assert.match(html, /Proposal ID:<\/strong> <code>proposal-2<\/code>/);
  assert.ok(html.indexOf("Agreed workflow") < html.indexOf("Current workflow draft"));
});

test("an active agreement is primary when the latest proposal has the same ID and exposes reviewable evidence", () => {
  const unsafeWorkflow = workflow({
    message: "<script>proposal message</script>",
    workspaceRoot: "/workspace/<project>",
    revision: "revision-&-one",
    steps: [{blockId: "inspect", name: "Inspect safely", reason: "<img src=x onerror=alert(1)>", }],
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
  assert.equal((html.match(/Step 1: Inspect safely/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Current workflow draft/);
  assert.match(html, /Agreement details/);
  assert.match(html, /Proposal ID:<\/strong> <code>proposal-&lt;1&gt;<\/code>/);
  assert.match(html, /dateTime="2027-01-15T08:00:00\.000Z"/);
  assert.match(html, /Workspace root:<\/strong> <code>\/workspace\/&lt;project&gt;<\/code>/);
  assert.match(html, /Rules revision:<\/strong> <code>revision-&amp;-one<\/code>/);
  assert.match(html, /Supervisor message ID:<\/strong> <code>supervisor-&lt;2&gt;<\/code>/);
  assert.match(html, /Agent message ID:<\/strong> <code>agent-&amp;-3<\/code>/);
  assert.match(html, /&lt;script&gt;agreement message&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /it does not verify that any steps were completed/);
  assert.doesNotMatch(html, /compliance confirmed|compliant/i);
});

test("a stale agreement is clearly historical while a newer proposal stays a draft", () => {
  const task: ProjectSupervisorInfo["tasks"][number] = {
    ...snapshot.tasks[0]!,
    workflow: workflow({message: "A new proposal is ready for discussion."}),
    workflowProposalId: "proposal-2",
    agreement: agreement({status: "stale", message: "The agreed rules revision is out of date."}),
  };
  const html = renderTaskView(task);
  assert.match(html, /Previous agreement \(stale\)/);
  assert.match(html, /Agreement status:<\/strong> Stale/);
  assert.match(html, /retained as history and is not the current agreed workflow/);
  assert.match(html, /Steps in this historical agreement/);
  assert.match(html, /Current workflow draft/);
  assert.match(html, /A new proposal is ready for discussion/);
  assert.doesNotMatch(html, /<h5>Agreed workflow<\/h5>/);
  assert.doesNotMatch(html, /The agreed workflow is current/i);
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

test("authorized and restored definition review outcomes expose escaped source details", () => {
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

test("empty workflow proposals and legacy tasks state why no steps are shown", () => {
  const emptyProposalTask: ProjectSupervisorInfo["tasks"][number] = {
    ...snapshot.tasks[0]!,
    workflow: {status: "proposed", message: "No rules matched a workflow block.", workspaceRoot: null, revision: null, rules: [], steps: []},
  };
  const emptyHtml = renderTaskView(emptyProposalTask);
  assert.match(emptyHtml, /No workflow steps were proposed/);
  assert.match(emptyHtml, /No rules were evaluated for this proposal/);
  assert.match(emptyHtml, /Workspace root:<\/strong> Not recorded/);
  assert.match(emptyHtml, /Rules revision:<\/strong> Not recorded/);

  const staleProposalTask: ProjectSupervisorInfo["tasks"][number] = {
    ...snapshot.tasks[0]!,
    workflow: {status: "stale", message: "Project rules changed after this proposal was created.", workspaceRoot: "/workspace/project", revision: "old-revision", rules: [], steps: []},
  };
  const staleHtml = renderTaskView(staleProposalTask);
  assert.match(staleHtml, /Draft status:<\/strong> stale/);
  assert.match(staleHtml, /Project rules changed after this proposal was created/);
  assert.match(staleHtml, /No workflow steps are available for this proposal/);

  const nullWorkflowHtml = renderTaskView({...snapshot.tasks[0]!, workflow: null});
  const legacyHtml = renderTaskView(snapshot.tasks[0]!);
  assert.match(nullWorkflowHtml, /No workflow proposal was recorded for this task\. Earlier objective-only records are not automatically reprocessed/);
  assert.match(legacyHtml, /No workflow proposal was recorded for this task\. Earlier objective-only records are not automatically reprocessed/);
  assert.doesNotMatch(legacyHtml, /Project definition review/);
});

test("workflow proposal status and message remain visible across every contract state", () => {
  for (const status of ["pending", "proposed", "unavailable", "stale", "invalid"] as const) {
    const task: ProjectSupervisorInfo["tasks"][number] = {
      ...snapshot.tasks[0]!,
      workflow: {status, message: `Explanation for ${status}.`, workspaceRoot: null, revision: null, rules: [], steps: []},
    };
    const html = renderTaskView(task);
    assert.match(html, new RegExp(`Draft status:<\\/strong> ${status}`));
    assert.match(html, new RegExp(`Explanation for ${status}\\.`));
  }
});

test("unavailable saved models remain visible and disabled while an available model can be selected", () => {
  const unavailable = snapshot.models[1]!;
  const unavailableSelection: SupervisorModelSelection = {instanceId: unavailable.instanceId, model: unavailable.model, options: [{id: "thinking", value: true}]};
  const savedSnapshot = {...snapshot, settings: {...snapshot.settings, modelSelection: unavailableSelection}};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
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

test("project defaults without a selection expose no conversation readback or retry", () => {
  const defaults = {...snapshot, mainThreadId: null, binding: null, modelSelection: null, modelApplication: null, tasks: [], settings: {...snapshot.settings, pending: false}};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
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
