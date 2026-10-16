import React from "react";

const layoutExample = `.t3-supervisor/
  project.yaml
  steps/
    e2e-testing.md
  workflows/
    reviewer.yaml`;

const stepExample = `---
id: e2e-testing
name: End-to-end testing
description: |
  Test the changed behavior in the real application.
  Report what was verified, failures and any limitations.
---`;

const compositionExample = `name: Delivery
description: Implement, review and deliver the agreed change.
sequence:
  - step:
      id: implementation
      name: Implementation
      description: Implement the agreed behavior and prepare it for validation.
  - workflow: reviewer
  - step:
      id: delivery
      name: Delivery
      description: Deliver the reviewed result and report its active revision.`;

const reviewerExample = `name: Reviewer
description: Review the change and verify the affected behavior.
sequence:
  - step: inspect-change
  - parallel:
      - step: e2e-testing
      - step: security-review
  - step: report-findings`;

const localStepExample = `sequence:
  - step: e2e-testing
  - step:
      id: check-migration-notes
      name: Check migration notes
      description: |
        Compare upgrade notes with the implementation and correct omissions.
        Users must be able to complete the upgrade using those notes.`;

const configurationExample = `required:
  - step: e2e-testing
  - workflow: reviewer
default_workflow: delivery`;

const fixedInsertionExample = `sequence:
  - step: implementation
  - step: e2e-testing
  - step: deployment`;

const delegationExample = `name: Reviewer
description: |
  The main agent must assign this entire workflow to one or more independent
  reviewer agents. Assigned reviewers execute the sequence below and return
  findings. The main agent addresses findings and requests further review after
  relevant fixes until important findings are resolved.
sequence:
  - step: inspect-change
  - step: e2e-testing
  - step: report-findings`;

function Example({label, value}: {label: string; value: string}) {
  return <figure className="guide-example">
    <figcaption>{label}</figcaption>
    <pre><code>{value}</code></pre>
  </figure>;
}

function Topic({id, title, children}: {id: string; title: string; children: React.ReactNode}) {
  return <div className="stack guide-topic">
    <h3 id={id}>{title}</h3>
    {children}
  </div>;
}

const questions = [
  {
    question: "Does a required step or workflow run automatically?",
    answer: "No. A requirement must be accounted for in the negotiated plan. The plan is guidance for the current task; it is not a scheduler or evidence that work happened.",
  },
  {
    question: "Does a workflow reference launch a reviewer agent?",
    answer: "No. `workflow: reviewer` includes that reusable workflow in the plan. Put whole-workflow delegation and follow-up expectations in the workflow description when that is required.",
  },
  {
    question: "Can I define a workflow inline or use `steps:` for an ordered list?",
    answer: "No. `workflow:` only references a reusable workflow by ID. Use `sequence:` for ordered contents, including at the workflow root; definitions cannot be nested under a workflow reference.",
  },
  {
    question: "Do I need a second E2E item when the required reviewer workflow already contains it?",
    answer: "No. Required items are checked recursively. Inclusion inside the referenced reviewer workflow accounts for the same reusable step, so it does not need a duplicate entry.",
  },
  {
    question: "What can be added to a fixed workflow?",
    answer: "Supporting work may be added around the fixed fragment or between its original members. The original members, descriptions, requirements, relative order and parallel relationships stay intact. Fixed does not make a workflow required project-wide.",
  },
  {
    question: "What happens if I edit the original task message?",
    answer: "The Supervisor interprets the edited request and negotiates a fresh plan. The earlier agreement stays in history, and fresh occurrence IDs are fine for the revised task. For an unchanged task, a new proposal must retain fixed commitments from its accepted agreement or current main plan.",
  },
  {
    question: "Do child tasks get their own copy of the main task's requirements?",
    answer: "Requirements belong once to the current main task. Child tasks may contribute to parent steps, but delegation does not remove the parent's obligations or create a fresh requirement set for every child.",
  },
  {
    question: "What does a Supervisor helper own?",
    answer: "A helper monitors the operational subtree roots assigned to it, including verified future descendants. Assignment is monitoring responsibility, not workflow-step ownership or a contributor link. Work without an effective helper assignment stays with the root Supervisor.",
  },
  {
    question: "Can a helper create more helpers?",
    answer: "No. The Supervisor team is flat: one root and its direct helpers. A helper may cover several operational subtrees, but operational descendants do not create another Supervisor level.",
  },
  {
    question: "What happens when I message a helper directly in T3?",
    answer: "T3 applies its native follow-up behavior to that helper conversation. The root sends routine notes and check-ins through Supervisor team operations; it does not use raw `t3_thread_send` for those check-ins.",
  },
  {
    question: "Does setting the helper limit to zero remove existing helpers?",
    answer: "No. Zero disables new recruitment. Existing members and their history remain; lowering the limit also does not silently remove members.",
  },
  {
    question: "Who is responsible during a handover?",
    answer: "The root remains responsible while the old helper stops new guidance and outstanding effects are reconciled. New coverage becomes active only after the handover is confirmed. Pending or uncertain handovers stay visible and are not treated as complete.",
  },
  {
    question: "How is a helper's model selected?",
    answer: "A helper inherits the root's model by default. The root may select another model from T3's current configured catalog when delegating that helper; there is no separate Supervisor model catalog.",
  },
  {
    question: "What happens when a file is broken or workflows contain a cycle?",
    answer: "The UI and the operational Supervisor report definition errors, including the cycle chain. The Supervisor can continue with a finite provisional plan, while unreadable material and unresolved fixed or required items remain visible. A broken or incomplete collection is never reported as having no requirements.",
  },
  {
    question: "Does an agreed workflow prove that its steps were completed?",
    answer: "No. Definitions are templates, negotiation records the current plan, and observed execution is separate evidence. A reference or agreement alone does not prove delegation, review, testing or completion.",
  },
  {
    question: "Is there an automatic migration from the earlier rules, blocks or legacy test formats?",
    answer: "No. This agreed format has no migration or compatibility layer for those earlier formats. Rewrite definitions in the repository using steps, workflows and project.yaml.",
  },
];

export function StepsAndWorkflowsGuide() {
  return <section className="stack steps-guide" aria-labelledby="steps-guide-title">
    <div>
      <h2 id="steps-guide-title">Steps and workflows</h2>
      <p className="muted">A reference for repository definitions, workflow planning and recovery when definitions need attention.</p>
    </div>

    <Topic id="guide-layout-title" title="Where definitions live">
      <p>Project definitions belong to the operative checkout, so another checkout can have a different configuration. The opt-in global scope uses the same file layout. The Projects page shows the active scope, source paths and origin.</p>
      <Example label="Project definition layout" value={layoutExample}/>
      <p><code>project.yaml</code> holds project-wide requirements and an optional starting workflow. Files in <code>steps/</code> and <code>workflows/</code> hold reusable definitions. A project configuration editor writes only the selected checkout's <code>project.yaml</code>; step and workflow files are inspected as repository source.</p>
    </Topic>

    <Topic id="guide-step-title" title="A step describes one piece of work">
      <p>A reusable step is a Markdown file with YAML frontmatter. Its complete definition is <code>id</code>, <code>name</code> and <code>description</code>. The ID matches the filename. The Markdown body after the frontmatter must be empty; put all guidance in <code>description</code>. A step has no structural children.</p>
      <Example label="steps/e2e-testing.md" value={stepExample}/>
      <p>Put applicability, instructions, expected results, delegation details and iteration guidance in <code>description</code>. There are no separate instruction or outcome fields.</p>
      <p>A workflow can refer to a reusable step by ID or define a task-local step object under <code>step:</code>. Give local steps an ID to distinguish them. Promote one to <code>steps/</code> when it should be reusable across workflows.</p>
      <Example label="Reusable reference and task-local step" value={localStepExample}/>
    </Topic>

    <Topic id="guide-workflow-title" title="A workflow composes steps and other workflows">
      <p>A reusable workflow file has a filename ID, <code>name</code>, <code>description</code>, optional <code>fixed: true</code>, and one root group: <code>sequence:</code> or <code>parallel:</code>. Ordered contents always use <code>sequence:</code>. Groups may contain step references, local step objects, workflow references or nested groups.</p>
      <p><code>workflow:</code> accepts only a reusable workflow ID. Workflow definitions cannot be declared inline. A reference includes its contents in the plan; it does not start an agent or require delegation by itself.</p>
      <Example label="A delivery workflow with a reusable reviewer" value={compositionExample}/>
      <Example label="Nested parallel lanes inside a sequence" value={reviewerExample}/>
      <p>A sequence communicates intended semantic order. Members of a parallel group may overlap and have no declared order; parallel does not require simultaneous execution or create child agents.</p>
    </Topic>

    <Topic id="guide-config-title" title="Project requirements and the default workflow">
      <p><code>project.yaml</code> requires a <code>required</code> list; use <code>required: []</code> when this checkout has no local requirements. The optional <code>default_workflow</code> names a starting template; it does not limit negotiation to that one workflow.</p>
      <Example label="project.yaml" value={configurationExample}/>
      <p>Required items must be accounted for in the plan. Inclusion is recursive: if the required reviewer workflow contains the required E2E step, that step is already accounted for. The plan adds missing requirements where they fit instead of blindly appending them. A manual workflow choice does not waive a requirement.</p>
      <p>Applicability is described in the step or workflow description. A genuinely not-applicable item remains visible with its reason; an applicable requirement cannot be silently waived. Unclear applicability and broken references remain explicit open issues.</p>
    </Topic>

    <Topic id="guide-fixed-title" title="What fixed protects">
      <p><code>fixed: true</code> preserves the workflow's original members, descriptions and requirements, their relative order, and its declared parallel relationships, including nested commitments. Supporting work can be added around that fragment or between its original members.</p>
      <p>For example, the original <code>implementation → deployment</code> sequence may become <code>implementation → e2e-testing → deployment</code>.</p>
      <Example label="Required support work can be inserted between fixed members" value={fixedInsertionExample}/>
      <p>A genuinely not-applicable original member remains visible with its reason in the plan. An applicable commitment cannot be silently removed or weakened. Fixed does not make the workflow a project-wide requirement; <code>required</code> controls inclusion.</p>
    </Topic>

    <Topic id="guide-delegation-title" title="Delegating a whole workflow to reviewers">
      <p>Put the entire delegation obligation in the reusable workflow's description. It can tell the main agent to assign the complete workflow to independent reviewers, tell those reviewers to perform its sequence, and tell the main agent to address findings and request further review after fixes.</p>
      <Example label="Reviewer delegation in the workflow description" value={delegationExample}/>
      <p>When the reviewer workflow is required, the plan includes <code>workflow: reviewer</code>. The reference provides the plan contents; the description provides the whole-workflow delegation and iteration requirement. A reference in the plan does not prove that independent review or follow-up occurred.</p>
    </Topic>

    <Topic id="guide-children-title" title="How child tasks contribute">
      <p>Requirements apply once to the current main task, not once for every child and not for the lifetime of the conversation. Children may contribute to parent steps, including overlapping contributions or expanding several parent steps into a child plan. Delegation does not remove the parent's requirements or automatically complete its work.</p>
    </Topic>

    <Topic id="supervisor-team-title" title="Supervisor team and operational assignments">
      <p>The Supervisor team has one root and up to five helpers by default. Its project setting can be changed from 0 to 20; zero prevents new recruitment while preserving existing members. Each helper may cover several operational subtree roots, including verified descendants added later. The team stays flat even when the operational workflow is nested.</p>
      <p>The root coordinates the main and unassigned work. Helpers assess and guide their assigned children. The Projects page displays this team separately from connected operational conversations and marks each row with its effective assignee. An unknown or transferring owner stays explicit. Team membership and assignments do not change step ownership, contributor links or parent completion.</p>
      <p>Use a T3 link to open a helper conversation. A person writing there follows T3's native follow-up behavior. Root context notes and routine helper check-ins go through Supervisor team operations, not raw <code>t3_thread_send</code>. Pending handovers and significant issues remain visible until their state is resolved.</p>
      <p>The team view is a current observation. Read its timestamp and any incomplete, unavailable or stale warning before relying on membership or assignment details. Reading the view does not wake chats or change workflow state.</p>
    </Topic>

    <Topic id="guide-errors-title" title="Cycles, invalid definitions and recovery">
      <p>Direct and indirect workflow cycles are errors and include the exact reference chain. Reusing a workflow in separate branches is allowed; a cycle occurs when expansion returns to a workflow already on the current path. File, size, total expanded-node and depth bounds keep reading finite.</p>
      <p>Definition errors appear in this UI and in the operational Supervisor context. Readable definitions and diagnostics are passed as bounded, untrusted data; a broken reference is not recursively expanded. The Supervisor raises the issue and can continue planning with a finite provisional plan. Incomplete or unreadable files never become a claim that requirements are absent, and unresolved required or fixed commitments stay visible.</p>
      <p>A <code>complete</code> read means the service finished reading the relevant files; it does not mean those definitions are valid. Check the reported issue and source, repair the repository file, then refresh. A global-only view is inspectable but is not editable through a project editor.</p>
      <p>Provisional dialogue can continue with invalid or incomplete definitions so planning remains useful. A formal saved agreement requires a current, complete, valid definition snapshot and resolved commitments. A known revision on an invalid collection identifies the observed files; it does not approve them as policy.</p>
    </Topic>

    <Topic id="guide-evidence-title" title="Templates, plans and evidence are different">
      <p>Saved files are reusable templates. The plan for one main or child task can evolve through dialogue, with the current owning Supervisor maintaining its shape and status. Template revisions, agreement history and source provenance remain visible.</p>
      <p>Planning detail, delegation tasks and observed execution are separate facts. A definition does not prove inclusion, a plan does not prove agreement, and agreement does not prove that review, testing or other steps were executed.</p>
    </Topic>

    <Topic id="guide-faq-title" title="Frequently asked questions">
      <div className="stack guide-faq-list">{questions.map(({question, answer}) => <details className="panel guide-faq" key={question}>
        <summary>{question}</summary>
        <p>{answer}</p>
      </details>)}</div>
    </Topic>
  </section>;
}
