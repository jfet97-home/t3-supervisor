# Steps and workflows

This is the agreed definition model for the steps/workflows implementation batch.
The implementation replaces the earlier rules/blocks prototype. Old definitions
are disposable test material; there is no migration or compatibility requirement.
Keep instance settings, credentials, thread ownership and unrelated delivery state.

## Project layout

```text
.t3-supervisor/
  project.yaml
  steps/
    e2e-testing.md
  workflows/
    reviewer.yaml
```

Definitions belong to the operative checkout. The existing opt-in global scope
uses the same format. Scope selection, permissions and source paths remain visible.

## A step

A step is a semantic piece of work, not a scheduled task or a command. Its complete
required definition fields are `id`, `name` and `description`, with an optional
`references` list of supporting file paths. All applicability, instructions,
expected results, delegation details and iteration guidance belong in description.
There are no separate instructions or outcome fields.

Reusable steps are Markdown files containing YAML frontmatter:

```markdown
---
id: e2e-testing
name: End-to-end testing
description: |
  Test the changed behavior in the real application.
  Report what was verified, failures and any limitations.
references:
  - docs/testing.md
  - skills/use-project/SKILL.md
---
```

The file is `steps/e2e-testing.md`; its ID agrees with its filename. A step has no
structural children. Its description may instruct an agent to use a named workflow.

Inside a workflow, `step:` accepts either a reusable ID or a local definition:

```yaml
sequence:
  - step: e2e-testing
  - step:
      id: check-migration-notes
      name: Check migration notes
      description: |
        Compare upgrade notes with the implementation and correct omissions.
        Users must be able to complete the upgrade using those notes.
      references:
        - docs/upgrade.md
        - src/migration.ts
```

Local IDs distinguish local steps; promote a local definition to a reusable file
when it needs to be referenced project-wide. There is no `inline:` keyword.

## A workflow

A reusable workflow has a filename ID, name, description, optional `references`
and `fixed: true`,
and a root `sequence:` or `parallel:` group. Ordered contents consistently use
`sequence:`, never `steps:`. Groups may nest to express parallel lanes with ordered
work inside them. A group contains step references, local step definitions,
workflow references or further sequence/parallel groups.

`workflow:` accepts a reusable workflow ID only. Workflow definitions cannot be
declared inline. A reference includes a workflow in the plan; it does not itself
launch an agent or require delegation.

```yaml
name: Delivery
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
      description: Deliver the reviewed result and report its active revision.
```

The reviewer contains its own steps, including E2E testing when appropriate.
Testing is not automatically a sibling of reviewer in every containing workflow.

```yaml
name: Reviewer
description: Review the change and verify the affected behavior.
sequence:
  - step: inspect-change
  - parallel:
      - step: e2e-testing
      - step: security-review
  - step: report-findings
```

Parallel means members may overlap, with no declared order between them. It does
not demand simultaneous wall-clock execution or automatically create subagents.
Sequence expresses the intended semantic order, not an execution scheduler.

## Supporting file references

Reusable step frontmatter, reusable workflow YAML and local step objects can each
include `references`: a list of zero, one or more relative file paths. Omit the field
or write `references: []` when no supporting files are needed. Paths may point to
documentation, project-local skills such as `skills/use-project/SKILL.md`, source
code or any other file type. These are file paths, separate from reusable definition
IDs used by `step:`, `workflow:` or project `required` entries.

Paths are relative to the operative project checkout root, including when their
definition comes from the shared catalog. `../shared/guide.md` is a relative path;
absolute paths, home aliases, URL-like strings, control/formatting characters and
credential-like text are invalid. Use file paths only; `README.md:12` is not a
supported line-number reference. Each list is limited to 100 paths
of up to 4096 characters. A rejected list reports a fixed reason and the entry's
zero-based position, such as `references[1]`, without repeating the rejected text.
The service records paths without opening or checking
referenced files. Missing targets do not make the YAML invalid; a reference never
grants file access or proves that an agent read the file.

Definitions and Plan views display the lists read-only. Edit the original definition
file and refresh to change them. Negotiated plans, stored workflow records and
source-bound comparisons preserve reference lists alongside description snapshots;
fixed commitments preserve their supporting paths as well. A changed reference
list is a definition change and follows the existing source-review procedure.

## Fixed workflows

`fixed: true` protects the original members, their descriptions, file references and requirements,
their relative order and the declared parallel relationships. It permits added
support work between original members and around the fragment. A flexible outer
plan cannot remove or weaken an inner fixed fragment.

For example, a fixed implementation followed by deployment may gain required E2E
testing between them. The original members and their relative order remain.
This protection includes the original commitments of nested workflow references.
A member assessed not applicable stays visible with its reason rather than being
removed. Fixed does not imply mandatory project-wide inclusion.

## Definition index

`.t3-supervisor/project.yaml` is the index of reusable steps and workflows for
that scope. It is not a whitelist of task plans. The file has exactly the keys
`workflows` and `steps`, both required lists that may be `[]`, and an optional
`default_workflow`. Every entry has exactly `id`, `path`, `summary` and
`required`. `required` is `true` or `false`. `id` matches
`^[a-z0-9][a-z0-9_-]{0,63}$` and is unique within its list. `path` is relative
to `.t3-supervisor` and is exactly `workflows/<id>.yaml` or `steps/<id>.md`.
`default_workflow` must name a workflow in `workflows`. The two lists together
hold at most 100 entries. A top-level `required:` key is rejected; there is no
fallback and no second authored requirement list.

```yaml
workflows:
  - id: reviewer
    path: workflows/reviewer.yaml
    summary: Use to review a frozen change before the governed action, and again after material fixes.
    required: true
steps:
  - id: e2e-testing
    path: steps/e2e-testing.md
    summary: Use when changed behavior needs proof in the real application; editorial work explains why it does not.
    required: true
default_workflow: reviewer
```

A new project file is written as `workflows: []` and then `steps: []`.
`default_workflow` is a starting suggestion, not the only plan and not an
implied requirement. `required: true` is the only authored inclusion flag;
current consumers derive inclusion from those flags. Fixed stays on the
workflow file.

The parser trims a summary and requires it to be nonempty, at most two
nonempty lines, and at most 240 characters. When authoring or reviewing, write
what the definition is for and when it applies. A descriptive name can be a
fine summary. The full step or workflow file remains the policy; a summary
only dispatches that read.

Only indexed files are read. A file in `steps/` or `workflows/` that is not
indexed is `definition_unlisted` and is not read. An indexed row whose file is
missing is `catalog_entry_missing`; the row and its `required` flag stay, so a
required one remains an unresolved requirement. Either issue makes the
collection invalid, and plans stay provisional until it is fixed. Negotiated
plans may still add task-local steps. Supervisor and the supervised agent start
at `project.yaml`, then read each listed full definition that applies. The
introduction says so. The manifest shows each indexed definition's id, name,
summary and members; `workflow_read` with `definitionIds` returns the full
definition.

The main agent and Supervisor negotiate the actual plan for the current task.
The plan must account for each required item. Inclusion inside a referenced
workflow counts, so a reviewer already containing E2E testing does not require a
duplicate testing step. Hand-written and negotiated plans follow the same policy.
Missing items are integrated in an appropriate position, not blindly appended.
This can include an insertion between fixed members without changing their order.

Requirements belong once to the current main task, not once per child or once for
the lifetime of a conversation. Children can contribute to parent steps, including
overlapping contributions and expansion of several parent steps into a child plan.
Delegation does not remove the parent's requirements or automatically complete it.

Applicability is expressed in descriptions and assessed semantically. A genuinely
not-applicable item remains visible with the reason; an actually applicable
requirement cannot be silently waived. A manual workflow choice is not a waiver.
Unclear applicability and broken definitions remain explicit outstanding issues.

## Giving an entire workflow to reviewers

The delegation requirement can be entirely in the workflow description:

```yaml
name: Reviewer
description: |
  The main agent must assign this entire workflow to one or more independent
  reviewer agents. Assigned reviewers execute the sequence below and return
  findings. The main agent addresses findings and requests further review after
  relevant fixes until important findings are resolved.
sequence:
  - step: inspect-change
  - step: e2e-testing
  - step: report-findings
```

If reviewer is required, the negotiated main plan includes `workflow: reviewer`.
Its description supplies the obligation to delegate the whole workflow and repeat
review, rather than adding a special wrapper step or another execution-policy field.
The role-specific wording distinguishes main coordination from assigned reviewers'
work. Semantic assessment needs actual independent reviews and follow-up, not merely
a reference in a plan. Inclusion does not prove delegation or successful execution.

## Cycles and invalid definitions

The service detects direct and indirect cycles in named workflow references and
reports their exact chain. Reusing a workflow in separate branches is allowed;
returning to a workflow already on the current expansion chain is a cycle.
File, size and depth bounds prevent unbounded processing.

Definition errors appear both in the UI and in the Supervisor's context. They do
not disable the Supervisor agent. Readable definitions and diagnostics are supplied
as bounded, untrusted data without recursively expanding a broken reference. The
Supervisor raises the problem in conversation and negotiates a finite working plan
while work continues. Unreadable or incomplete material never becomes a claim that
there are no requirements, and unresolved fixed/required commitments stay visible.
Provisional dialogue can use complete-invalid or incomplete material, but formal
saved agreement requires a current, complete, valid collection. A known revision
on an invalid collection identifies the observation; it does not approve policy.

## Templates, working plans and evidence

Saved definitions are reusable templates. The plan for a particular main or child
can evolve through dialogue, with the current owning Supervisor maintaining status
and shape. Planning detail, delegation tasks and observed execution are distinct.
Each live occurrence has its own stable identity, separate from a reusable template
ID; repeated references do not merge contributions or evidence. Template revisions,
agreement history and provenance remain explicit. Changed files
are reviewed rather than silently changing the meaning of an existing agreement.

Work that a step needs may also happen outside any observed conversation, through
an external agent, tool, service or person. The main reports such work and its
returned result with an `external-contribution` record for a step of its own
workflow; children relay external outcomes through the main. The Supervisor
assesses a returned result against the step description as accepted or needing
more work. A reported result, its receipt and that assessment never complete the
step by themselves; the step's status changes only through a separate Supervisor
edit. See [connected workflow editing](workflow-mcp.md#external-contributions).

Supervisor suggests giving a third party the whole workflow, relevant steps or an
adapted plan derived from what the main would use locally. The brief
includes needed instructions and sources, assigned roles, applicable constraints,
expected evidence and completion rules. This does not automatically expose the
external plan or its internal progress to Supervisor.

Editing the original task message triggers fresh interpretation and negotiation.
Earlier accepted plans remain history. A new proposal for unchanged task material
cannot silently discard already accepted or live fixed commitments.

The UI reference must explain the layout, complete step and workflow syntax, local
steps, composition, sequence/parallel groups, fixed additions, required inclusion,
whole-workflow delegation, child contributions, cycle diagnostics and invalid-file
recovery. It must cover concrete examples and FAQ cases, including the difference
between inclusion, agreement and execution, without requiring users to read source.
