import { createHash } from "node:crypto";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";

// a fixed, self-contained definition snapshot so golden values do not move with shared fixtures
export const goldenSnapshot: ProjectDefinitionSnapshot = {
  projectId: "project-a",
  threadId: "thread-a",
  workspaceRoot: "/work/project",
  globalOnly: false,
  globalRevision: null,
  revision: "revision-ready",
  editingAvailable: true,
  status: "ready",
  steps: [
    {id: "verify", name: "Verify behavior", description: "Check the changed behavior.", summary: "Use verify when the task needs it.", origin: "project", path: ".t3-supervisor/steps/verify.md", sourceId: "project:verify"},
    {id: "publish", name: "Prepare handoff", description: "Write a concise handoff.", summary: "Use publish when the task needs it.", origin: "project", path: ".t3-supervisor/steps/publish.md", sourceId: "project:publish"},
  ],
  workflows: [{
    id: "delivery",
    name: "Delivery",
    description: "Use the reusable delivery guidance.",
    summary: "Use delivery when the task needs it.",
    fixed: false,
    sequence: [
      {step: {id: "subtotal", name: "Review the subtotal", description: "Check the subtotal."}},
      {step: "verify"},
    ],
    origin: "project",
    path: ".t3-supervisor/workflows/delivery.yaml",
    sourceId: "delivery",
  }],
  config: {
    workflows: [{id: "delivery", path: "workflows/delivery.yaml", summary: "Use delivery when the task needs it.", required: false, origin: "project", sourceId: "delivery"}],
    steps: [
      {id: "verify", path: "steps/verify.md", summary: "Use verify when the task needs it.", required: true, origin: "project", sourceId: "verify"},
      {id: "publish", path: "steps/publish.md", summary: "Use publish when the task needs it.", required: false, origin: "project", sourceId: "publish"},
    ],
  },
  projectConfig: {
    workflows: [{path: "workflows/delivery.yaml", summary: "Use delivery when the task needs it.", required: false}],
    steps: [
      {path: "steps/verify.md", summary: "Use verify when the task needs it.", required: true},
      {path: "steps/publish.md", summary: "Use publish when the task needs it.", required: false},
    ],
  },
  definitionFiles: [],
  complete: true,
  sources: [],
  issues: [],
};

// a compact draft with a configured step, a workflow reference, a local step and a parallel group
export const goldenDraft = {
  requirements: [{kind: "step", id: "verify", applies: true, reason: "The task changes behavior."}],
  plan: {kind: "sequence", nodes: [
    {kind: "step", definitionId: "verify", reason: "Check the changed behavior."},
    {kind: "workflow", definitionId: "delivery", reason: "Use the delivery guidance."},
    {kind: "parallel", nodes: [
      {kind: "step", definitionId: null, localId: "notes", name: "Write notes", description: "Record release notes.", reason: "The task needs notes."},
      {kind: "step", definitionId: "publish", reason: "Prepare the requested handoff."},
    ]},
  ]},
};

export const goldenPins = {taskId: "task-a", taskRevision: "source-hash"};
export const goldenProposalId = "proposal-a";
// the seed resolveCompactProposal derives for these pins and proposal ID
export const goldenSeed = `${goldenPins.taskId}\0${goldenPins.taskRevision}\0${goldenProposalId}`;

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
