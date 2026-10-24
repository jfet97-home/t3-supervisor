import { EntityDetails } from "./disclosure.js";
import React from "react";

const layoutExample = `.t3-supervisor/
  project.yaml
  steps/
    e2e-testing.md
    inspect-change.md
    security-review.md
    report-findings.md
  workflows/
    reviewer.yaml
    delivery.yaml`;

const stepExample = `---
id: e2e-testing
name: End-to-end testing
description: |
  Test the changed behavior in the real application.
  Report what was verified, failures and any limitations.
references:
  - docs/testing.md
skills:
  - skills/use-project/SKILL.md
---`;

const compositionExample = `name: Delivery
description: Implement, review and deliver the agreed change.
references:
  - docs/delivery.md
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
        Users must be able to complete the upgrade using those notes.
      references:
        - docs/upgrade.md
        - src/migration.ts`;

const configurationExample = `workflows:
  - path: workflows/reviewer.yaml
    summary: Review the change and verify affected behavior.
    required: true
  - path: workflows/delivery.yaml
    summary: Implement, review and deliver the agreed change.
steps:
  - path: steps/e2e-testing.md
    summary: Test changed behavior in the real application and report limitations.
    required: true
  - path: steps/inspect-change.md
    summary: Inspect the change for defects and unmet requirements.
  - path: steps/security-review.md
    summary: Check trust boundaries affected by the change.
  - path: steps/report-findings.md
    summary: Report actionable review findings and remaining limitations.
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
    <h3 id={id} tabIndex={-1}>{title}</h3>
    {children}
  </div>;
}

// the operator's path through the dashboard, in the order a person meets it, using the labels the views show
const walkthrough: ReadonlyArray<{id: string; title: string; body: React.ReactNode}> = [
  {id: "home", title: "Find the work", body: <p><strong>Home</strong> puts what <strong>Needs attention</strong> first, then <strong>Supervised work</strong> with each task’s objective, then <strong>Recent changes</strong>. Open a row to reach that conversation’s <strong>Task</strong> view. Every conversation in a project is also listed under <strong>Projects</strong> → the project → <strong>Conversations</strong>.</p>},
  {id: "task", title: "Read the task and its outcome", body: <p><strong>Task</strong> shows the task as the Supervisor understood it, the current outcome with the steps being worked on (<strong>Now:</strong>), and one plan. A step’s status (Planned, In progress, Completed or Needs attention) comes only from the Supervisor’s recorded assessments of this task’s workflow; the dashboard never derives one. <strong>Refresh</strong> reads newer records.</p>},
  {id: "agreement", title: "Proposal, acceptance and refinement", body: <p><strong>Agent and Supervisor</strong> states once what the Supervisor proposed and whether the agent accepted it. Acceptance happens in their conversations and the dashboard only reads it; an accepted plan is not evidence that work was done. When the Supervisor proposes a refinement, <strong>Proposed update awaiting acceptance</strong> lists the changed steps and <strong>Update proposed</strong> marks them, while the earlier plan stays accepted and recorded progress stays as it is.</p>},
  {id: "records", title: "Evidence and history for each step", body: <p>Open a step for its <strong>Plan note</strong>, the <strong>Supervisor assessment</strong> that set its current status and any <strong>Earlier step records</strong>. <strong>Latest Supervisor record</strong> shows the newest one. <strong>Connected work</strong> lists contributing child conversations, and <strong>Evidence and history</strong> shows the retained Supervisor records and available earlier acceptance or workflow records.</p>},
  {id: "supervision", title: "Supervisor health and interventions", body: <p><strong>Supervision</strong> shows <strong>Supervisor health</strong>, <strong>Monitoring</strong> with its check-ins and the <strong>Supervisor team</strong> for this conversation. <strong>Stop supervision</strong> applies only to this chat and stays off until you enable it again; the chat itself is not changed. <strong>Open in T3</strong> opens the conversation.</p>},
  {id: "definitions", title: "Definitions and project settings", body: <p>A project’s reusable steps and workflows are in <strong>Definitions</strong>, read from a checkout you choose: <strong>Project root</strong> or the checkout a conversation works in. <strong>Project settings</strong> holds which conversations are supervised and the defaults for new Supervisors. Instance-wide switches and global definitions are in <strong>Settings</strong>. The reference below describes the files.</p>},
];

const referenceTopics = [
  ["layout", "Definition files"], ["step", "Steps"], ["workflow", "Workflow structure"], ["references", "References and skills"], ["config", "Project configuration"], ["fixed", "Fixed commitments"], ["delegation", "Review and delegation"], ["children", "Child tasks"], ["team", "Supervisor team"], ["errors", "Recovery"], ["evidence", "Plans and evidence"], ["faq", "Common questions"],
] as const;

function GuideLinks({items, ordered = false}: {items: ReadonlyArray<readonly [string, string]>; ordered?: boolean}) {
  const links = items.map(([id, title]) => <li key={id}><button type="button" onClick={() => {const heading = document.getElementById(`guide-${id}-title`);heading?.focus();heading?.scrollIntoView({block: "start"});}}>{title}</button></li>);
  return ordered ? <ol>{links}</ol> : <ul>{links}</ul>;
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
    answer: "No. In a workflow, `workflow:` only references a reusable workflow by ID. Use `sequence:` for ordered contents, including at the workflow root; definitions cannot be nested under a workflow reference. The `steps:` list in project.yaml is an index of reusable files, not workflow contents.",
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
    question: "What does quarantining a helper do?",
    answer: "A root-authorized quarantine revokes the helper's Supervisor service authority and returns coverage to the root. Unresolved requests and notices remain fenced, so affected work is observe-only until they are reconciled. Quarantine does not stop or cancel the native T3 conversation or a turn already running there.",
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
    <h1 id="steps-guide-title">Guide</h1>
    <p className="guide-introduction">Follow supervised work from Home to a task’s outcome, then look up how to write the steps and workflows the Supervisor plans with.</p>
    <nav className="guide-contents" aria-label="Guide contents">
      <div><strong>Follow supervised work</strong><GuideLinks ordered items={walkthrough.map(({id, title}) => [id, title] as const)}/></div>
      <div><strong>Write steps and workflows</strong><GuideLinks items={referenceTopics}/></div>
    </nav>

    <h2 id="guide-follow-title">Follow supervised work</h2>
    <ol className="guide-walkthrough">{walkthrough.map(({id, title, body}) => <li key={id}><h3 id={`guide-${id}-title`} tabIndex={-1}>{title}</h3>{body}</li>)}</ol>

    <h2 id="guide-write-title">Write steps and workflows</h2>
    <p className="muted">Steps and workflows are files in a project’s checkout. These topics cover their format, requirements, review and recovery.</p>

    <Topic id="guide-layout-title" title="Where definitions live">
      <p>Project definitions belong to the operative checkout, so another checkout can have a different configuration. The opt-in global scope uses the same file layout. A project’s <strong>Definitions</strong> shows the active scope, source paths and origin.</p>
      <Example label="Project definition layout" value={layoutExample}/>
      <p><code>project.yaml</code> indexes every reusable definition, including optional ones, by path with a short summary and an optional required flag. Both the Supervisor and the supervised agent start there, then read the full relevant definitions in <code>steps/</code> and <code>workflows/</code> on demand. Summaries guide reading; full definitions remain authoritative policy.</p>
      <p>The project configuration editor changes only the selected checkout's <code>project.yaml</code>. Full definition files stay separate. For a new project, start with <code>workflows: []</code> and <code>steps: []</code>; when adding a reusable file, add its index entry too.</p>
    </Topic>

    <Topic id="guide-step-title" title="A step describes one piece of work">
      <p>A reusable step is a Markdown file with YAML frontmatter. Its required fields are <code>id</code>, <code>name</code> and <code>description</code>, with optional <code>references</code> and <code>skills</code> string lists. The ID matches the filename. The Markdown body after the frontmatter must be empty; put all guidance in <code>description</code>. A step has no structural children.</p>
      <Example label="steps/e2e-testing.md" value={stepExample}/>
      <p>Put applicability, instructions, expected results, delegation details and iteration guidance in <code>description</code>. There are no separate instruction or outcome fields.</p>
      <p>A workflow can refer to a reusable step by ID or define a task-local step object under <code>step:</code>. Give local steps an ID to distinguish them. Promote one to <code>steps/</code> when it should be reusable across workflows.</p>
      <Example label="Reusable reference and task-local step" value={localStepExample}/>
    </Topic>

    <Topic id="guide-workflow-title" title="A workflow composes steps and other workflows">
      <p>A reusable workflow file has a filename ID, <code>name</code>, <code>description</code>, optional <code>references</code> and <code>skills</code> lists, <code>fixed: true</code>, and one root group: <code>sequence:</code> or <code>parallel:</code>. Ordered contents always use <code>sequence:</code>. Groups may contain step references, local step objects, workflow references or nested groups.</p>
      <p><code>workflow:</code> accepts only a reusable workflow ID. Workflow definitions cannot be declared inline. A reference includes its contents in the plan; it does not start an agent or require delegation by itself.</p>
      <Example label="A delivery workflow with a reusable reviewer" value={compositionExample}/>
      <Example label="Nested parallel lanes inside a sequence" value={reviewerExample}/>
      <p>A sequence communicates intended semantic order. Members of a parallel group may overlap and have no declared order; parallel does not require simultaneous execution or create child agents.</p>
    </Topic>

    <Topic id="guide-references-title" title="References and skills">
      <p>Reusable steps, workflows and local steps may carry separate <code>references</code> and <code>skills</code> string lists. References are file paths; skills are local paths or exact catalog names. No scope or object wrapper is needed. Keep their applicability, responsibility and completion in a short description; point to maintained documents or skills for detailed procedures.</p>
      <pre><code>{`references:
  - docs/testing.md
skills:
  - .claude/skills/project-testing/SKILL.md
  - effect-v4-development
  - plugin:review`}</code></pre>
      <p>File strings and local skill paths are relative to the operative checkout root, including for shared definitions. Entries with a slash or an ending of <code>.md</code> are paths and must name <code>SKILL.md</code> exactly, including a root <code>SKILL.md</code>. Skill paths have no empty, dot or parent segments; <code>./SKILL.md</code> is invalid. Global skill names match the consuming agent’s configured catalog exactly, including namespaces; missing or ambiguous names remain explicit gaps. Do not guess installation paths.</p>
      <p>Omit either list or use <code>[]</code> for none. Each list allows at most 100 entries; skills cannot repeat. Paths allow up to 4096 characters and catalog names up to 256. Names use letters, digits, dots, underscores and hyphens with optional colon namespaces; each segment starts with a letter or digit. Absolute paths, home aliases, schemes, parent traversal, backslashes, control characters and credential-like values are rejected. References grant no access or authority; readers must respect filesystem and symlink boundaries.</p>
      <p>Definitions and Task show pointers read-only; introductions carry them without loading their contents. Read applicable guidance progressively within the available tools and context budget. Changing a locator changes definition identity; its content is not frozen or verified by that revision. A listed reference proves neither consultation nor execution. Global skills do not enable shared definitions or supervision.</p>
    </Topic>

    <Topic id="guide-config-title" title="The project index, requirements and default workflow">
      <p><code>project.yaml</code> requires separate <code>workflows</code> and <code>steps</code> lists, even when empty. Every entry has a <code>path</code> and <code>summary</code>; the file name in <code>path</code> is the definition ID. Add <code>required: true</code> to make it a requirement, since an omitted flag means <code>false</code>. These flags are the only authored requirements; there is no separate top-level required list.</p>
      <p>Paths are relative to <code>.t3-supervisor</code> and must be exactly <code>workflows/&lt;id&gt;.yaml</code> or <code>steps/&lt;id&gt;.md</code>. Each summary is trimmed, nonempty text of at most 2 logical lines and 240 characters. Briefly explain purpose or applicability from the full description; line wrapping in the editor is not an extra logical line.</p>
      <Example label="project.yaml" value={configurationExample}/>
      <p>The optional <code>default_workflow</code> names an indexed workflow as a starting suggestion. The index is authoritative for reusable files, not an exhaustive whitelist of possible task plans: negotiate local steps, new combinations and revisions as the task evolves, preserving required and fixed commitments.</p>
      <p>The editor lists workflows and steps separately. Change summaries and required flags, or add an unlisted file explicitly, then Save and reload to verify the index. Invalid or missing rows remain visible. Removing an entry does not delete its file, and leaving a reusable file unlisted is an error. Global entries remain separate and read-only.</p>
      <p>Required items must be accounted for in the plan. Inclusion is recursive: if the required reviewer workflow contains the required E2E step, that step is already accounted for. The plan adds missing requirements where they fit instead of blindly appending them. A manual workflow choice does not waive a requirement.</p>
      <p>Applicability is described in the step or workflow description. A genuinely not-applicable item remains visible with its reason; an applicable requirement cannot be silently waived. Unclear applicability and broken references remain explicit open issues.</p>
    </Topic>

    <Topic id="guide-fixed-title" title="What fixed protects">
      <p><code>fixed: true</code> preserves the workflow's original members, descriptions, references, skills and requirements, their relative order, and its declared parallel relationships, including nested commitments. Supporting work can be added around that fragment or between its original members.</p>
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

    <Topic id="guide-team-title" title="Supervisor team and operational assignments">
      <p>The Supervisor team has one root and up to five helpers by default. Its project setting can be changed from 0 to 20; zero prevents new recruitment while preserving existing members. Each helper may cover several operational subtree roots, including verified descendants added later. The team stays flat even when the operational workflow is nested.</p>
      <p>The root coordinates the main and unassigned work. Helpers assess and guide their assigned children. A conversation’s <strong>Supervision</strong> view displays this team separately from connected operational conversations and marks each row with its effective assignee. An unknown or transferring owner stays explicit. Team membership and assignments do not change step ownership, contributor links or parent completion.</p>
      <p>Use a T3 link to open a helper conversation. A person writing there follows T3's native follow-up behavior. Root context notes and routine helper check-ins go through Supervisor team operations, not raw <code>t3_thread_send</code>. Pending handovers and significant issues remain visible until their state is resolved.</p>
      <p>The team view is a current observation. Read its timestamp and any incomplete, unavailable or stale warning before relying on membership or assignment details. Reading the view does not wake chats or change workflow state.</p>
    </Topic>

    <Topic id="guide-errors-title" title="Cycles, invalid definitions and recovery">
      <p>Direct and indirect workflow cycles are errors and include the exact reference chain. Reusing a workflow in separate branches is allowed; a cycle occurs when expansion returns to a workflow already on the current path. File, size, total expanded-node and depth bounds keep reading finite.</p>
      <p>Missing indexed files, unlisted files, duplicate IDs and mismatched paths are diagnosed. Repair the index or the definition file explicitly; missing or invalid definitions do not silently lose their required flags.</p>
      <p>Definition errors appear in this UI and in the operational Supervisor context. Readable definitions and diagnostics are passed as bounded, untrusted data; a broken reference is not recursively expanded. The Supervisor raises the issue and can continue planning with a finite provisional plan. Incomplete or unreadable files never become a claim that requirements are absent, and unresolved required or fixed commitments stay visible.</p>
      <p>A <code>complete</code> read means the service finished reading the relevant files; it does not mean those definitions are valid. Check the reported issue and source, repair the repository file, then refresh. A global-only view is inspectable but is not editable through a project editor.</p>
      <p>Provisional dialogue can continue with invalid or incomplete definitions so planning remains useful. A formal saved agreement requires a current, complete, valid definition snapshot and resolved commitments. A known revision on an invalid collection identifies the observed files; it does not approve them as policy.</p>
    </Topic>

    <Topic id="guide-evidence-title" title="Templates, plans and evidence are different">
      <p>Saved files are reusable templates. The plan for one main or child task can evolve through dialogue, with the current owning Supervisor maintaining its shape and status. Template revisions, agreement history and source provenance remain visible.</p>
      <p>Planning detail, delegation tasks and observed execution are separate facts. A definition does not prove inclusion, a plan does not prove agreement, and agreement does not prove that review, testing or other steps were executed.</p>
    </Topic>

    <Topic id="guide-faq-title" title="Frequently asked questions">
      <div className="stack guide-faq-list">{questions.map(({question, answer}) => <EntityDetails title={<>{question}</>} className="guide-faq" key={question}>
        
        <p>{answer}</p>
      </EntityDetails>)}</div>
    </Topic>
  </section>;
}
